import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { generateKeyPreviews } from '../assets/generate-key-previews.mjs';
import { generatePluginIcon } from '../assets/generate-plugin-icon.mjs';

// Explicit utility-script coverage: production artwork is read-only. Every
// generated image, sentinel and alias belongs to a fresh retained temp fixture.
const options = { timeout: 30000 };
const groups = [
  { name: 'key previews', generate: generateKeyPreviews, outputs: [
    ['key-stream.png', 320], ['key-loop.png', 320], ['key-run.png', 320],
  ] },
  { name: 'plugin icons', generate: generatePluginIcon, outputs: [
    ['marketplace.png', 256], ['marketplace@2x.png', 512],
  ] },
];
async function fixture() { return mkdtemp(path.join(tmpdir(), 'deckforge-asset-generators-')); }
async function decode(bytes) { return sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); }
async function snapshot(directory, outputs) {
  return Promise.all(outputs.map(async ([name]) => {
    const file = path.join(directory, name);
    return { name, bytes: await readFile(file), mtimeMs: (await stat(file)).mtimeMs };
  }));
}

test('plugin icons: SVG regions survive both output sizes and source edits make both icons stale', options, async () => {
  // Arrange: copy the generator unchanged so its normal relative SVG input is
  // fixture-owned. Only dependency resolution links back to read-only packages.
  const root = await fixture(), assets = path.join(root, 'assets'), directory = path.join(root, 'outputs');
  await mkdir(assets); await mkdir(directory);
  await copyFile(new URL('../assets/generate-plugin-icon.mjs', import.meta.url), path.join(assets, 'generate-plugin-icon.mjs'));
  await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), path.join(root, 'node_modules'), 'dir');
  const { generatePluginIcon: generate } = await import(pathToFileURL(path.join(assets, 'generate-plugin-icon.mjs')).href);
  const outputs = groups[1].outputs;
  const source = path.join(assets, 'plugin-icon.svg');
  for (const [color, rgba] of [['#ff0000', [255, 0, 0, 255]], ['#ffff00', [255, 255, 0, 255]]]) {
    await writeFile(source, `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
      <rect width="100" height="100" fill="#0000ff"/>
      <rect width="50" height="100" fill="${color}"/>
      <rect x="50" width="50" height="50" fill="#00ff00"/>
    </svg>`);
    if (color === '#ffff00') {
      const before = await snapshot(directory, outputs);
      // Act / Assert: changed source invalidates existing icons without writing.
      await assert.rejects(generate({ directory, check: true }));
      assert.deepEqual(await snapshot(directory, outputs), before);
    }
    // Act: both initial generation and source-edit regeneration update both sizes.
    assert.deepEqual(await generate({ directory }), { written: 2, skipped: 0 });
    // Assert interior regions, not a second rendering pipeline or real-art golden.
    for (const [name, size] of outputs) {
      const { data, info } = await decode(await readFile(path.join(directory, name)));
      assert.equal(info.width, size); assert.equal(info.height, size);
      for (const [x, y, expected] of [
        [0.25, 0.25, rgba], [0.25, 0.75, rgba],
        [0.75, 0.25, [0, 255, 0, 255]], [0.75, 0.75, [0, 0, 255, 255]],
      ]) {
        const offset = (Math.floor(y * size) * size + Math.floor(x * size)) * 4;
        assert.deepEqual([...data.subarray(offset, offset + 4)], expected, `${name}: region ${x},${y}`);
      }
    }
    assert.deepEqual(await generate({ directory, check: true }), { written: 0, skipped: 2 });
  }
});

for (const group of groups) {
  test(`${group.name}: fresh generation creates decodable PNGs with expected dimensions and alpha`, options, async () => {
    // Arrange
    const directory = await fixture(); await writeFile(path.join(directory, 'unrelated.txt'), 'retained');
    // Act
    const result = await group.generate({ directory });
    // Assert: decode actual PNGs rather than pinning compression-byte snapshots.
    assert.deepEqual(result, { written: group.outputs.length, skipped: 0 });
    for (const [name, size] of group.outputs) {
      const bytes = await readFile(path.join(directory, name)), metadata = await sharp(bytes).metadata();
      assert.equal(metadata.format, 'png'); assert.equal(metadata.width, size); assert.equal(metadata.height, size);
      const actual = await decode(bytes);
      if (group.generate === generateKeyPreviews) {
        const last = size - 1;
        for (const pixel of [0, last, last * size, size * size - 1]) assert.equal(actual.data[pixel * 4 + 3], 0);
        assert.equal(actual.data[((size / 2) * size + size / 2) * 4 + 3], 255);
      } else {
        for (let offset = 3; offset < actual.data.length; offset += 4) assert.equal(actual.data[offset], 255);
      }
    }
    assert.equal(await readFile(path.join(directory, 'unrelated.txt'), 'utf8'), 'retained');
    assert.deepEqual((await readdir(directory)).sort(), [...group.outputs.map(([name]) => name), 'unrelated.txt'].sort());
  });

  test(`${group.name}: check and generation preserve unchanged and recompressed equivalent PNGs`, options, async () => {
    // Arrange: fixed old timestamps make an accidental rewrite observable without sleeps.
    const directory = await fixture(); await group.generate({ directory });
    for (const [name] of group.outputs) await utimes(path.join(directory, name), 1, 1);
    const before = await snapshot(directory, group.outputs);
    // Act
    const checked = await group.generate({ directory, check: true });
    const unchanged = await group.generate({ directory });
    // Assert
    assert.deepEqual(checked, { written: 0, skipped: group.outputs.length });
    assert.deepEqual(unchanged, checked); assert.deepEqual(await snapshot(directory, group.outputs), before);

    // Arrange: byte-different compression must still count as unchanged artwork.
    for (const [name] of group.outputs) {
      const file = path.join(directory, name), original = await readFile(file);
      const recompressed = await sharp(original).png({ compressionLevel: 1 }).toBuffer();
      assert.notDeepEqual(recompressed, original); assert.deepEqual((await decode(recompressed)).data, (await decode(original)).data);
      await writeFile(file, recompressed); await utimes(file, 1, 1);
    }
    const recompressedBefore = await snapshot(directory, group.outputs);
    // Act
    const recompressedChecked = await group.generate({ directory, check: true });
    const recompressedGenerated = await group.generate({ directory });
    // Assert
    assert.deepEqual(recompressedChecked, { written: 0, skipped: group.outputs.length });
    assert.deepEqual(recompressedGenerated, recompressedChecked);
    assert.deepEqual(await snapshot(directory, group.outputs), recompressedBefore);
  });

  for (const scenario of ['missing', 'corrupt', 'empty', 'stale pixels']) {
    test(`${group.name}: check rejects ${scenario} without writes; generation repairs it`, options, async () => {
      // Arrange: missing fixtures omit creation; no generated or source file is deleted.
      const directory = await fixture(), [name] = group.outputs[0], file = path.join(directory, name);
      await writeFile(path.join(directory, 'unrelated.txt'), 'retained');
      let expectedPixels;
      if (scenario !== 'missing') {
        await group.generate({ directory });
        // Observe a valid baseline before damage: repair must restore its pixels,
        // without prescribing the illustration's colors, content or rendering recipe.
        const original = await decode(await readFile(file)); expectedPixels = original.data;
        if (scenario === 'corrupt') await writeFile(file, 'not a PNG');
        if (scenario === 'empty') await writeFile(file, '');
        if (scenario === 'stale pixels') {
          const pixels = Buffer.from(original.data), center = (Math.floor(original.info.height / 2) * original.info.width + Math.floor(original.info.width / 2)) * 4;
          pixels[center] ^= 1; // Preserve dimensions/alpha while changing visible content.
          await writeFile(file, await sharp(pixels, { raw: original.info }).png().toBuffer());
        }
      }
      const namesBefore = (await readdir(directory)).sort();
      const bytesBefore = await Promise.all(namesBefore.map(async entry => [entry, await readFile(path.join(directory, entry))]));
      // Act / Assert: check mode is strictly read-only, including failure.
      await assert.rejects(group.generate({ directory, check: true }));
      assert.deepEqual((await readdir(directory)).sort(), namesBefore);
      for (const [entry, bytes] of bytesBefore) assert.deepEqual(await readFile(path.join(directory, entry)), bytes);
      // Act / Assert: damaged old PNGs do not prevent regeneration.
      assert.deepEqual(await group.generate({ directory }), { written: scenario === 'missing' ? group.outputs.length : 1,
        skipped: scenario === 'missing' ? 0 : group.outputs.length - 1 });
      assert.deepEqual(await group.generate({ directory, check: true }), { written: 0, skipped: group.outputs.length });
      if (expectedPixels) assert.deepEqual((await decode(await readFile(file))).data, expectedPixels);
      assert.equal(await readFile(path.join(directory, 'unrelated.txt'), 'utf8'), 'retained');
      assert.deepEqual((await readdir(directory)).sort(), [...group.outputs.map(([entry]) => entry), 'unrelated.txt'].sort());
    });
  }

  for (const scenario of ['symlink output', 'directory output', 'symlink directory']) {
    test(`${group.name}: rejects ${scenario} and preserves unrelated targets`, options, async () => {
      // Arrange: link targets are owned fixture children, never repository assets.
      const root = await fixture(), directory = path.join(root, 'outputs'), target = path.join(root, 'retained');
      await writeFile(target, 'retained');
      if (scenario === 'symlink directory') {
        const actual = path.join(root, 'actual'); await mkdir(actual); await writeFile(path.join(actual, 'sentinel'), 'retained');
        await symlink(actual, directory, 'dir');
      } else {
        await mkdir(directory); const file = path.join(directory, group.outputs[0][0]);
        if (scenario === 'symlink output') await symlink(target, file);
        else { await mkdir(file); await writeFile(path.join(file, 'sentinel'), 'retained'); }
      }
      const before = await readdir(directory);
      // Act / Assert
      await assert.rejects(group.generate({ directory })); await assert.rejects(group.generate({ directory, check: true }));
      assert.deepEqual(await readdir(directory), before); assert.equal(await readFile(target, 'utf8'), 'retained');
      if (scenario === 'directory output') assert.equal(await readFile(path.join(directory, group.outputs[0][0], 'sentinel'), 'utf8'), 'retained');
      if (scenario === 'symlink directory') assert.equal(await readFile(path.join(root, 'actual/sentinel'), 'utf8'), 'retained');
    });
  }
}
