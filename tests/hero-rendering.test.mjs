import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, open, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { parseHeroArguments } from '../assets/generate-hero.mjs';
import { heroInput, inspectHeroSources, planHeroTimeline, renderHero } from '../assets/hero-rendering.mjs';
import { PreviewError, createProcessingBudget } from '../assets/preview-rendering.mjs';

// Approved offline integration boundary: real Sharp, synthetic media, read-only
// Mini template, and owned CLI children. No producer or configured program runs.
const testOptions = { timeout: 30000 };
const temporaryRoot = process.env.HERO_TEST_TMP_ROOT ?? tmpdir();
const style = { width: 278, pixels: 96, grid: 0, glow: 0 };
const colors = { red: [255, 0, 0, 255], green: [0, 255, 0, 255], blue: [0, 0, 255, 255],
  yellow: [255, 255, 0, 255], cyan: [0, 255, 255, 255], white: [255, 255, 255, 255], gray: [128, 128, 128, 255] };
const total = values => values.reduce((a, b) => a + b, 0);

async function withFixture(operation) {
  const directory = await mkdtemp(join(temporaryRoot, 'deckforge-hero-'));
  try { await operation(directory); }
  catch (error) { console.error(`Retained failed hero fixture: ${directory}`); throw error; }
  await rm(directory, { recursive: true });
  await assert.rejects(stat(directory), { code: 'ENOENT' });
  console.log(`Verified removed hero fixture: ${directory}`);
}

async function save(directory, name, bytes) {
  const path = join(directory, name);
  await writeFile(path, bytes);
  return path;
}

async function animation(names = ['red', 'blue'], delay = [80, 80], format = 'gif') {
  const image = sharp(Buffer.from(names.flatMap(name => colors[name])), {
    raw: { width: 1, height: names.length, channels: 4, pageHeight: 1 },
  });
  return format === 'gif'
    ? image.gif({ delay, loop: 7, keepDuplicateFrames: true }).toBuffer()
    : image.webp({ delay, loop: 7, lossless: true }).toBuffer();
}

async function png(name) {
  return sharp(Buffer.from(colors[name]), { raw: { width: 1, height: 1, channels: 4 } }).png().toBuffer();
}

async function decode(bytes) {
  const metadata = await sharp(bytes, { animated: true }).metadata();
  const raw = await sharp(bytes, { animated: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { metadata, ...raw };
}

function frameAt(decoded, milliseconds) {
  let end = 0;
  for (const [index, delay] of decoded.metadata.delay.entries()) {
    end += delay;
    if (milliseconds < end) return index;
  }
  assert.fail(`No frame at ${milliseconds} ms; animation ends at ${end} ms`);
}

function pixel(decoded, frame, nativeX, nativeY) {
  const width = decoded.metadata.width;
  const height = decoded.metadata.pageHeight ?? decoded.metadata.height;
  const x = Math.round(nativeX * width / 1112);
  const y = Math.round(nativeY * height / 804);
  const offset = (frame * width * height + y * width + x) * 4;
  return [...decoded.data.subarray(offset, offset + 4)];
}

function keyColor(decoded, time, key, name) {
  const actual = pixel(decoded, frameAt(decoded, time), 300 + (key % 3) * 256, 266 + Math.floor(key / 3) * 256);
  const expected = colors[name];
  for (let channel = 0; channel < 3; channel++) {
    assert.ok(expected[channel] ? actual[channel] > 180 : actual[channel] < 120,
      `key ${key}, ${time} ms: expected ${name}, got ${actual}`);
  }
  assert.equal(actual[3], 255);
}

function cli(args, cwd) {
  return spawnSync(process.execPath, [resolve('assets/generate-hero.mjs'), ...args], {
    cwd, timeout: 20000, maxBuffer: 1024 * 1024,
  });
}

test('hero arguments retain defaults, per-key ownership and literal commas', () => {
  // Arrange
  const args = ['--input', 'text:Hello, world', '--processed', '--input', './frames,one.gif', '--loops', '2',
    '--after', 'card:Done, thanks', '--output', 'result.gif'];
  // Act
  const options = parseHeroArguments(args);
  const plan = planHeroTimeline([{ pages: 1, end: 0 }], options);
  // Assert: defaults produce the documented Mini aspect, not a preview scale.
  assert.equal(plan.width, 520);
  assert.equal(plan.height, 376);
  assert.equal(options.pixels, 96);
  assert.equal(options.grid, 0.04);
  assert.equal(options.glow, 0.08);
  assert.equal(options.inputs.length, 2);
  assert.equal(options.inputs[0].input.record, 'text:Hello, world');
  assert.equal(options.inputs[0].processed, true);
  assert.equal(options.inputs[1].input.path, resolve('./frames,one.gif'));
  assert.equal(options.inputs[1].loops, 2);
  assert.equal(options.inputs[1].after.record, 'card:Done, thanks');
  assert.deepEqual(heroInput('./text:literal.svg'), { path: resolve('./text:literal.svg') });
  assert.equal(parseHeroArguments(['--help']).help, true);
});

test('hero arguments reject absent inputs, unknown/duplicate flags and invalid bounds', () => {
  // Arrange
  const base = ['--output', 'hero.gif', '--input', 'text:hello'];
  const cases = [[], ['--output', 'hero.gif'], ['--input', 'text:hello'],
    [...base, '--scale', '2'], [...base, '--width', '0'], [...base, '--width', '1113'],
    [...base, '--width', '1.5'], [...base, '--pixels', '100'], [...base, '--fps', '101'],
    [...base, '--grid', '-0.1'], [...base, '--glow', '1.1'], [...base, '--loops', '0'],
    [...base, '--loops', '1.5'], [...base, '--processed', '--processed'],
    [...base, '--width', '100', '--width', '200'],
    ['--processed', ...base], [...base, ...Array(6).fill(['--input', 'text:extra']).flat()],
    ...['0.5', '15', '-10', '9007199254741000'].map(value => [...base, '--loop-delay', value]),
    [...base, '--loop-delay'], [...base, '--loop-delay', '0', '--loop-delay', '0'],
    ['--loop-delay', '0', ...base]];
  // Act / Assert
  for (const args of cases) assert.throws(() => parseHeroArguments(args), { message: 'HERO_ARGUMENTS_INVALID', exitCode: 2 });
});

test('source inspection accepts static formats, single-page GIFs and production protocol records', testOptions, async () => {
  await withFixture(async directory => {
    // Arrange: tiny encoded inputs, including a static GIF with no animation timing.
    const source = Buffer.from(colors.red);
    const paths = [];
    for (const format of ['png', 'jpeg', 'webp', 'gif']) {
      paths.push(await save(directory, `still.${format}`, await sharp(source, { raw: { width: 1, height: 1, channels: 4 } }).toFormat(format).toBuffer()));
    }
    paths.push(await save(directory, 'still.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="1"><rect width="2" height="1" fill="red"/></svg>'));
    const values = [...paths, 'text:Hello, world', 'card:Ready|header:Status', 'progress:50',
      `data:image/png;base64,${(await png('cyan')).toString('base64')}`];
    // Act
    const sources = await inspectHeroSources(sharp, values.map(value => ({ input: heroInput(value) })), createProcessingBudget());
    // Assert: no static source acquires a synthetic animation or needs a GCE delay.
    for (const source of sources) {
      assert.equal(source.pages, 1);
      const plan = planHeroTimeline([source], style);
      assert.deepEqual(plan.delays, [100]);
    }
  });
});

test('hero interleaves exact source events, repeats, final after switches and held frames', testOptions, async () => {
  await withFixture(async directory => {
    // Arrange: 80-ms and 90-ms frames have a deliberately nonuniform event union.
    const a = await save(directory, 'a.gif', await animation());
    const b = await save(directory, 'b.gif', await animation(['green', 'blue'], [90, 90]));
    const after = await save(directory, 'after.png', await png('yellow'));
    const still = await save(directory, 'still.png', await png('green'));
    const options = { ...style, inputs: [
      { input: heroInput(a), loops: 2, after: heroInput(after) },
      { input: heroInput(b), loops: 3 }, { input: heroInput(b) },
      { input: heroInput(still) }, { input: heroInput(`data:image/png;base64,${(await png('cyan')).toString('base64')}`) },
    ] };
    // Act
    const exact = await decode(await renderHero(sharp, options));
    const sampled = await decode(await renderHero(sharp, { ...options, fps: 5 }));
    // Assert: embedded loop=7 is ignored; common natural end is 3 * 180 = 540 ms.
    assert.equal(exact.metadata.width, 278);
    assert.equal(exact.metadata.pageHeight, 201);
    assert.equal(exact.metadata.loop, 0);
    assert.equal(total(exact.metadata.delay), 540);
    assert.deepEqual(exact.metadata.delay, [80, 10, 70, 20, 60, 30, 50, 40, 90, 90]);
    for (const [time, aColor, bColor, heldColor] of [
      [0, 'red', 'green', 'green'], [80, 'blue', 'green', 'green'], [90, 'blue', 'blue', 'blue'],
      [160, 'red', 'blue', 'blue'], [180, 'red', 'green', 'blue'], [240, 'blue', 'green', 'blue'],
      [270, 'blue', 'blue', 'blue'], [320, 'yellow', 'blue', 'blue'],
      [360, 'yellow', 'green', 'blue'], [450, 'yellow', 'blue', 'blue'], [539, 'yellow', 'blue', 'blue'],
    ]) {
      keyColor(exact, time, 0, aColor); keyColor(exact, time, 1, bColor); keyColor(exact, time, 2, heldColor);
      keyColor(exact, time, 3, 'green'); keyColor(exact, time, 4, 'cyan');
      const unused = pixel(exact, frameAt(exact, time), 812, 522);
      assert.ok(unused.slice(0, 3).every(channel => channel < 100), `unused key remains unlit at ${time}`);
    }
    assert.equal(total(sampled.metadata.delay), 540);
    assert.deepEqual(sampled.metadata.delay, [200, 200, 140]);
    keyColor(sampled, 0, 0, 'red'); keyColor(sampled, 200, 0, 'red'); keyColor(sampled, 400, 0, 'yellow');
    keyColor(sampled, 200, 1, 'green'); keyColor(sampled, 400, 1, 'green');
  });
});

test('loop delays show after imagery between plays without freezing other keys or adding a final pause', testOptions, async () => {
  await withFixture(async directory => {
    // Arrange: two 200-ms plays separated by one 200-ms Ready pause end at
    // 600 ms. An independent 800-ms clock keeps the final Ready state visible.
    const main = await save(directory, 'main.gif', await animation(['red', 'blue'], [80, 120]));
    const ready = await save(directory, 'ready.png', await png('green'));
    const clock = await save(directory, 'clock.gif', await animation(['yellow', 'cyan'], [50, 50]));
    const options = parseHeroArguments(['--output', join(directory, 'unused.gif'), '--width', '278', '--grid', '0', '--glow', '0',
      '--input', main, '--loops', '2', '--loop-delay', '200', '--after', ready,
      '--input', clock, '--loops', '8']);
    // Act
    const sources = await inspectHeroSources(sharp, options.inputs, createProcessingBudget());
    const mainPlan = planHeroTimeline([sources[0]], options);
    const exact = await decode(await renderHero(sharp, options));
    const sampled = await decode(await renderHero(sharp, { ...options, fps: 25 }));
    // Assert: N plays have N-1 pauses; each transition uses its exact source
    // boundary, while explicit FPS samples the same state at its own ticks.
    assert.equal(mainPlan.duration, 600);
    assert.equal(total(mainPlan.delays), 600);
    assert.equal(total(exact.metadata.delay), 800);
    assert.equal(total(sampled.metadata.delay), 800);
    for (const [time, color] of [[0, 'red'], [79, 'red'], [80, 'blue'], [199, 'blue'],
      [200, 'green'], [399, 'green'], [400, 'red'], [479, 'red'], [480, 'blue'],
      [599, 'blue'], [600, 'green'], [799, 'green']]) {
      keyColor(exact, time, 0, color);
      keyColor(sampled, time, 0, color);
    }
    for (const [time, color] of [[210, 'yellow'], [260, 'cyan'], [310, 'yellow'], [360, 'cyan']]) keyColor(exact, time, 1, color);
    for (const [time, color] of [[200, 'yellow'], [280, 'cyan'], [320, 'yellow'], [360, 'cyan']]) keyColor(sampled, time, 1, color);
  });
});

test('omitted and explicit zero loop delays retain uninterrupted playback and the same final after state', testOptions, async () => {
  await withFixture(async directory => {
    // Arrange: sibling keys differ only by the presence of --loop-delay 0.
    const main = await save(directory, 'main.gif', await animation(['red', 'blue'], [80, 120]));
    const ready = await save(directory, 'ready.png', await png('green'));
    const clock = await save(directory, 'clock.gif', await animation(['yellow', 'cyan'], [50, 50]));
    const options = parseHeroArguments(['--output', join(directory, 'unused.gif'), '--width', '278', '--grid', '0', '--glow', '0',
      '--input', main, '--loops', '2', '--after', ready,
      '--input', main, '--loops', '2', '--after', ready, '--loop-delay', '0',
      '--input', clock, '--loops', '8']);
    // Act
    const decoded = await decode(await renderHero(sharp, options));
    // Assert: no intermediate Ready dwell is introduced by the explicit zero.
    assert.equal(total(decoded.metadata.delay), 800);
    for (const [time, color] of [[0, 'red'], [80, 'blue'], [199, 'blue'], [200, 'red'],
      [279, 'red'], [280, 'blue'], [399, 'blue'], [400, 'green'], [799, 'green']]) {
      for (const key of [0, 1]) keyColor(decoded, time, key, color);
    }
  });
});

test('one play has no pause even with a large requested delay; repeated-play arithmetic rejects overflow', testOptions, async () => {
  await withFixture(async directory => {
    // Arrange: metadata inspection only, never a huge-duration output allocation.
    const main = await save(directory, 'main.gif', await animation(['red', 'blue'], [80, 120]));
    const ready = await save(directory, 'ready.png', await png('green'));
    const input = { input: heroInput(main), loops: 1, loopDelay: 9007199254740990, after: heroInput(ready) };
    // Act
    const sources = await inspectHeroSources(sharp, [input], createProcessingBudget());
    const plan = planHeroTimeline(sources, style);
    // Assert: the unused N-1 pause cannot extend playback or overflow a period.
    assert.equal(plan.duration, 200);
    assert.deepEqual(plan.delays, [80, 120]);
    await assert.rejects(inspectHeroSources(sharp, [{ ...input, loops: 2 }], createProcessingBudget()), { message: 'HERO_TIMING_INVALID' });
  });
});

test('between-play pause boundaries count against the shared output-frame limit', () => {
  // Arrange: metadata only; visual changes alone fit, but pause transitions add
  // a third state per play except the final play, which has no trailing pause.
  const source = plays => ({ pages: 2, starts: [0, 80], duration: 200, period: 400,
    loopDelay: 200, plays, end: plays * 200 + (plays - 1) * 200 });
  // Act
  const plan = planHeroTimeline([source(1365)], { ...style, width: 1 });
  // Assert
  assert.equal(plan.delays.length, 4094);
  assert.equal(total(plan.delays), 1365 * 200 + 1364 * 200);
  assert.throws(() => planHeroTimeline([source(1366)], { ...style, width: 1 }), { message: 'HERO_FRAME_LIMIT' });
});

test('a 700000-ms Ready pause preserves encoded duration and resumes the second play at its exact boundary', { timeout: 45000 }, async () => {
  await withFixture(async directory => {
    // Arrange: valid input delays stay small; only the requested logical pause
    // exceeds GIF's stored-delay field. Tiny output bounds all decoded storage.
    const main = await save(directory, 'main.gif', await animation(['red', 'blue'], [80, 80]));
    const ready = await save(directory, 'ready.png', await png('green'));
    const options = parseHeroArguments(['--output', join(directory, 'unused.gif'), '--width', '112', '--grid', '0', '--glow', '0',
      '--input', main, '--loops', '2', '--loop-delay', '700000', '--after', ready]);
    // Act: offline encoding must not wait for playback or truncate the long hold.
    const decoded = await decode(await renderHero(sharp, options, createProcessingBudget({ milliseconds: 45000 })));
    // Assert: physical chunk count is not a presentation contract. Actual stored
    // delays and visible colors establish the pause/restart behavior instead.
    assert.equal(total(decoded.metadata.delay), 700320);
    assert.equal(decoded.metadata.loop, 0);
    assert.ok(decoded.metadata.delay.every(delay => delay > 0 && delay % 10 === 0 && delay <= 655350));
    for (const [time, color] of [[0, 'red'], [79, 'red'], [80, 'blue'], [159, 'blue'],
      [160, 'green'], [350000, 'green'], [700159, 'green'], [700160, 'red'],
      [700239, 'red'], [700240, 'blue'], [700319, 'blue']]) keyColor(decoded, time, 0, color);
  });
});

test('long logical pauses reject encoding-chunk frame overflow without allocating raster frames', () => {
  // Arrange: metadata only. Four visible main frames leave room for the pause's
  // physical encoding chunks; logical intervals are not capped to a GCE field.
  const source = loopDelay => ({ pages: 2, starts: [0, 80], duration: 160,
    plays: 2, loopDelay, period: 160 + loopDelay, end: 320 + loopDelay });
  // Act
  const plan = planHeroTimeline([source(65530 * 4092)], { ...style, width: 1 });
  // Assert: valid long holds preserve time while the shared 4096-frame cap holds.
  assert.equal(plan.delays.length, 4096);
  assert.equal(total(plan.delays), 320 + 65530 * 4092);
  assert.throws(() => planHeroTimeline([source(65530 * 4096)], { ...style, width: 1 }), { message: 'HERO_FRAME_LIMIT' });
});

test('processed main bypasses display effects but retains padding and masks; after still receives effects', testOptions, async () => {
  await withFixture(async directory => {
    // Arrange: a non-square white main has visible padding, while the white after
    // shares its center color so a dark grid can only come from after processing.
    const main = await sharp(Buffer.from([...colors.white, ...colors.white, ...colors.gray, ...colors.gray]), {
      raw: { width: 2, height: 2, channels: 4, pageHeight: 1 },
    }).gif({ delay: [80, 80], keepDuplicateFrames: true }).toBuffer();
    const input = await save(directory, 'main.gif', main);
    const after = await save(directory, 'after.png', await png('white'));
    const clock = await save(directory, 'clock.gif', await animation(['red', 'blue'], [90, 90]));
    // Act
    const decoded = await decode(await renderHero(sharp, { ...style, width: 556, pixels: 72, grid: 1, glow: 0,
      inputs: [{ input: heroInput(input), processed: true, after: heroInput(after) }, { input: heroInput(clock), loops: 2 }] }));
    // Assert: main is bright without the configured grid, and padding stays dark.
    const first = frameAt(decoded, 0), completed = frameAt(decoded, 170);
    assert.ok(pixel(decoded, first, 300, 266)[0] > 220);
    assert.ok(pixel(decoded, first, 300, 185)[0] < 100, 'non-square main is black-padded');
    assert.ok(pixel(decoded, first, 204, 170)[0] < 150, 'rounded aperture corner is not painted white');
    const average = frame => {
      const samples = [];
      for (let y = 240; y < 290; y += 2) for (let x = 250; x < 350; x += 2) samples.push(pixel(decoded, frame, x, y)[0]);
      return total(samples) / samples.length;
    };
    assert.ok(average(first) > 220);
    assert.ok(average(completed) < average(first) - 30, 'after applies the requested dark grid despite processed main');
  });
});

const asymmetricArtwork = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100">'
  + '<rect width="100" height="100" fill="red"/><rect x="100" width="60" height="100" fill="#00ff00"/>'
  + '<rect x="160" width="80" height="100" fill="blue"/><rect x="240" width="160" height="100" fill="yellow"/></svg>';

for (const processed of [false, true]) {
  test(`${processed ? 'processed' : 'simulated'} static imagery defaults to contain; cover center-crops without stretching`, testOptions, async () => {
    await withFixture(async directory => {
      // Arrange: asymmetric bands reveal crop origin and stretching, not merely
      // a shared center pixel. Three keys compare omitted, contain and cover fit.
      const input = await save(directory, 'wide.svg', asymmetricArtwork);
      const args = ['--output', join(directory, 'unused.gif'), '--width', '556', '--grid', '0', '--glow', '0'];
      for (const fit of [undefined, 'contain', 'cover']) {
        args.push('--input', input);
        if (fit) args.push('--fit', fit);
        if (processed) args.push('--processed');
      }
      // Act: use parsed CLI options so the key-local flag reaches the renderer.
      const decoded = await decode(await renderHero(sharp, parseHeroArguments(args)));
      // Assert: default/contain retain both extremes and pad above/below content.
      for (const key of [0, 1, 2]) {
        const left = 202 + key * 256;
        const points = key < 2
          ? [[30, 98, 'red'], [65, 98, 'green'], [98, 98, 'blue'], [160, 98, 'yellow']]
          : [[12, 98, 'green'], [50, 98, 'blue'], [148, 98, 'blue'], [184, 98, 'yellow'],
            [98, 40, 'blue'], [98, 156, 'blue']];
        for (const [x, y, name] of points) {
          const actual = pixel(decoded, 0, left + x, 168 + y);
          for (let channel = 0; channel < 3; channel++) {
            assert.ok(colors[name][channel] ? actual[channel] > 180 : actual[channel] < 120,
              `key ${key}, local (${x},${y}): expected ${name}, got ${actual}`);
          }
          assert.equal(actual[3], 255);
        }
        if (key < 2) for (const y of [40, 156]) {
          const padding = pixel(decoded, 0, left + 98, 168 + y);
          assert.ok(padding.slice(0, 3).every(channel => channel < 100), `key ${key} retains black padding`);
          assert.equal(padding[3], 255);
        }
      }
    });
  });
}

test('after imagery inherits key fit while processed bypass remains exclusive to the main', testOptions, async () => {
  await withFixture(async directory => {
    // Arrange: two processed white mains finish before the clock; their identical
    // wide after image must be fitted differently and still receive the dark grid.
    const main = await save(directory, 'main.gif', await animation(['white', 'gray'], [80, 80]));
    const after = await save(directory, 'wide-after.svg', asymmetricArtwork);
    const clock = await save(directory, 'clock.gif', await animation(['red', 'blue'], [90, 90]));
    const args = ['--output', join(directory, 'unused.gif'), '--width', '556', '--pixels', '72', '--grid', '1', '--glow', '0'];
    for (const fit of ['contain', 'cover']) args.push('--input', main, '--processed', '--fit', fit, '--after', after);
    args.push('--input', clock, '--loops', '2');
    // Act
    const decoded = await decode(await renderHero(sharp, parseHeroArguments(args)));
    // Assert: average small interior patches so grid phase is not mistaken for
    // fit. Main is bright; after is gridded, with inherited crop/padding geometry.
    const average = (time, key, x, y) => {
      const channels = [0, 0, 0];
      let count = 0;
      for (let dy = -8; dy <= 8; dy += 2) for (let dx = -8; dx <= 8; dx += 2) {
        const sample = pixel(decoded, frameAt(decoded, time), 202 + key * 256 + x + dx, 168 + y + dy);
        for (let channel = 0; channel < 3; channel++) channels[channel] += sample[channel];
        count++;
      }
      return channels.map(value => value / count);
    };
    for (const key of [0, 1]) {
      const before = average(0, key, 98, 98);
      const afterCenter = average(170, key, 98, 98);
      assert.ok(before.every(channel => channel > 220), 'processed main bypasses the configured grid');
      assert.ok(afterCenter[2] > afterCenter[0] + 50, 'after center retains its blue band');
      assert.ok(afterCenter[2] < before[2] - 30, 'after still receives the configured grid');
    }
    const containSide = average(170, 0, 30, 98);
    assert.ok(containSide[0] > containSide[2] + 50, 'contain after preserves the left red band');
    assert.ok(average(170, 0, 98, 40).every(channel => channel < 100), 'contain after is black-padded');
    for (const [x, y] of [[50, 98], [148, 98], [98, 40], [98, 156]]) {
      const cover = average(170, 1, x, y);
      assert.ok(cover[2] > cover[0] + 50, `cover after fills (${x},${y}) with the centered blue band`);
    }
  });
});

test('hero CLI replaces regular output only after a complete static composition and treats commas literally', testOptions, async () => {
  await withFixture(async directory => {
    // Arrange: relative prefix disambiguates a reserved-looking literal filename.
    await save(directory, 'text:one,two.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="red"/></svg>');
    const output = await save(directory, 'hero.gif', 'previous output');
    // Act
    const result = cli(['--output', output, '--input', './text:one,two.svg', '--input', 'text:Hello, world', '--grid', '0', '--glow', '0'], directory);
    const decoded = await decode(await readFile(output));
    // Assert: all-static convention, default aspect, and row-major first key.
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr.toString());
    assert.equal(result.stdout.toString(), 'HERO_WRITE_OK\n');
    assert.equal(decoded.metadata.width, 520);
    assert.equal(decoded.metadata.height, 376);
    assert.equal(decoded.metadata.pages ?? 1, 1);
    assert.deepEqual(decoded.metadata.delay, [100]);
    assert.equal(decoded.metadata.loop, 0);
    keyColor(decoded, 0, 0, 'red');
  });
});

test('hero CLI preserves a stored 70000-ms hold and its exact visible transition', testOptions, async () => {
  await withFixture(async directory => {
    // Arrange: store the valid GIF delay directly; Sharp's encoder option cannot
    // accept 70000 ms, although the GIF centisecond field can represent it.
    const bytes = Buffer.from(await animation(['red', 'blue'], [80, 100]));
    const gce = bytes.indexOf(Buffer.from([0x21, 0xf9, 4]));
    assert.ok(gce >= 0);
    bytes.writeUInt16LE(7000, gce + 4);
    assert.deepEqual((await sharp(bytes, { animated: true }).metadata()).delay, [70000, 100]);
    const input = await save(directory, 'long-hold.gif', bytes);
    const output = join(directory, 'hero.gif');
    // Act: rendering is offline; playback duration does not require waiting.
    const result = cli(['--input', input, '--output', output, '--width', '278', '--grid', '0', '--glow', '0']);
    // Assert: encoding-only chunks must neither shorten the hold nor advance color.
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr.toString());
    assert.equal(result.stdout.toString(), 'HERO_WRITE_OK\n');
    const decoded = await decode(await readFile(output));
    assert.equal(total(decoded.metadata.delay), 70100);
    assert.equal(decoded.metadata.loop, 0);
    for (const time of [0, 65529, 65530, 69999]) keyColor(decoded, time, 0, 'red');
    for (const time of [70000, 70099]) keyColor(decoded, time, 0, 'blue');
  });
});

function changeGifTiming(bytes, remove) {
  // Mutate only GCEs in a real two-frame Sharp fixture, not a second GIF codec.
  const positions = [];
  for (let offset = bytes.indexOf(Buffer.from([0x21, 0xf9, 4])); offset !== -1;
    offset = bytes.indexOf(Buffer.from([0x21, 0xf9, 4]), offset + 8)) positions.push(offset);
  assert.equal(positions.length, 2);
  const result = Buffer.from(bytes);
  if (!remove) {
    for (const offset of positions) result.writeUInt16LE(0, offset + 4);
    return result;
  }
  return Buffer.concat([result.subarray(0, positions[0]), result.subarray(positions[0] + 8, positions[1]), result.subarray(positions[1] + 8)]);
}

const invalidInputs = [
  ['loops on static', 'HERO_ANIMATION_MODIFIER_INVALID'],
  ['after on static', 'HERO_ANIMATION_MODIFIER_INVALID'],
  ['zero GIF delay', 'HERO_TIMING_INVALID'],
  ['missing GIF timing', 'HERO_TIMING_INVALID'],
  ['animated after', 'HERO_AFTER_ANIMATED'],
  ['animated WebP', 'HERO_FORMAT_UNSUPPORTED'],
  ['malformed protocol', 'HERO_PROTOCOL_INVALID'],
  ['unknown flag', 'HERO_ARGUMENTS_INVALID'],
  ['invalid fit', 'HERO_ARGUMENTS_INVALID'],
  ['missing fit', 'HERO_ARGUMENTS_INVALID'],
  ['duplicate fit', 'HERO_ARGUMENTS_INVALID'],
  ['fit before input', 'HERO_ARGUMENTS_INVALID'],
  ['zero loop delay on static', 'HERO_ANIMATION_MODIFIER_INVALID'],
  ['loop delay without after', 'HERO_ANIMATION_MODIFIER_INVALID'],
  ['single-play delay without after', 'HERO_ANIMATION_MODIFIER_INVALID'],
  ['non-centisecond loop delay', 'HERO_ARGUMENTS_INVALID'],
];
for (const [scenario, diagnostic] of invalidInputs) {
  test(`hero CLI rejects ${scenario} and preserves previous output`, testOptions, async () => {
    await withFixture(async directory => {
      // Arrange: all paths and prior output are owned by this fixture.
      const gifBytes = await animation();
      const gif = await save(directory, 'animation.gif', gifBytes);
      const still = await save(directory, 'still.png', await png('red'));
      const output = await save(directory, 'hero.gif', 'previous output');
      let args;
      if (scenario === 'loops on static') args = ['--input', still, '--loops', '2'];
      if (scenario === 'after on static') args = ['--input', still, '--after', still];
      if (scenario === 'zero GIF delay' || scenario === 'missing GIF timing') {
        const bad = await save(directory, 'bad.gif', changeGifTiming(gifBytes, scenario === 'missing GIF timing'));
        args = ['--input', bad];
      }
      if (scenario === 'animated after') args = ['--input', gif, '--after', gif];
      if (scenario === 'animated WebP') args = ['--input', await save(directory, 'animated.webp', await animation(['red', 'blue'], [80, 90], 'webp'))];
      if (scenario === 'malformed protocol') args = ['--input', 'progress:not-a-number'];
      if (scenario === 'unknown flag') args = ['--input', still, '--scale', '2'];
      if (scenario === 'invalid fit') args = ['--input', still, '--fit', 'stretch'];
      if (scenario === 'missing fit') args = ['--input', still, '--fit'];
      if (scenario === 'duplicate fit') args = ['--input', still, '--fit', 'cover', '--fit', 'contain'];
      if (scenario === 'fit before input') args = ['--fit', 'cover', '--input', still];
      if (scenario === 'zero loop delay on static') args = ['--input', still, '--loop-delay', '0'];
      if (scenario === 'loop delay without after') args = ['--input', gif, '--loops', '2', '--loop-delay', '200'];
      if (scenario === 'single-play delay without after') args = ['--input', gif, '--loop-delay', '200'];
      if (scenario === 'non-centisecond loop delay') args = ['--input', gif, '--loop-delay', '15'];
      // Act
      const result = cli(['--output', output, ...args]);
      // Assert: failure never publishes an incomplete or fallback render.
      assert.ifError(result.error);
      assert.equal(result.status, diagnostic === 'HERO_ARGUMENTS_INVALID' ? 2 : 1, result.stderr.toString());
      assert.equal(result.stdout.length, 0);
      assert.equal(result.stderr.toString(), `${diagnostic}\n`);
      assert.equal(await readFile(output, 'utf8'), 'previous output');
    });
  });
}

for (const alias of ['same path', 'symlink']) {
  test(`hero CLI protects source files from ${alias} output`, testOptions, async () => {
    await withFixture(async directory => {
      // Arrange
      const original = await animation();
      const input = await save(directory, 'input.gif', original);
      const output = alias === 'same path' ? input : join(directory, 'alias.gif');
      if (alias === 'symlink') await symlink(input, output);
      // Act
      const result = cli(['--input', input, '--output', output]);
      // Assert
      assert.ifError(result.error);
      assert.equal(result.status, 1);
      assert.equal(result.stdout.length, 0);
      assert.equal(result.stderr.toString(), alias === 'same path'
        ? 'DEVICE_COMPOSITOR_OUTPUT_ALIASES_INPUT\n' : 'DEVICE_COMPOSITOR_OUTPUT_INVALID\n');
      assert.deepEqual(await readFile(input), original);
    });
  });
}

test('source budgets reject oversized main and after files before reading their pixels', testOptions, async () => {
  await withFixture(async directory => {
    // Arrange: a sparse file exercises the byte bound without allocating 64 MiB.
    const oversized = join(directory, 'oversized.png');
    const handle = await open(oversized, 'wx');
    try { await handle.truncate(64 * 1024 * 1024 + 1); } finally { await handle.close(); }
    const main = await save(directory, 'main.gif', await animation());
    const cases = [[{ input: heroInput(oversized) }], [{ input: heroInput(main), after: heroInput(oversized) }]];
    // Act / Assert
    for (const inputs of cases) await assert.rejects(inspectHeroSources(sharp, inputs, createProcessingBudget()), { message: 'HERO_INPUT_LIMIT' });
  });
});

test('source planning rejects excessive GIF pages and aggregate decoded RGBA without decoding large stacks', testOptions, async () => {
  await withFixture(async directory => {
    // Arrange: page fixture stores only 513 pixels; SVG dimensions cost no raster.
    const many = await save(directory, 'many.gif', await animation(Array.from({ length: 513 }, (_, i) => i % 2 ? 'blue' : 'red'), Array(513).fill(10)));
    const large = await save(directory, 'large.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="8192" height="8192"/>');
    const tiny = await save(directory, 'tiny.png', await png('red'));
    // Act / Assert: two large sources exactly fit; a third tiny source exceeds 512 MiB.
    await assert.rejects(inspectHeroSources(sharp, [{ input: heroInput(many) }], createProcessingBudget()), { message: 'HERO_FORMAT_UNSUPPORTED' });
    const exact = await inspectHeroSources(sharp, [{ input: heroInput(large) }, { input: heroInput(large) }], createProcessingBudget());
    assert.equal(total(exact.map(source => source.rgbaBytes)), 512 * 1024 * 1024);
    await assert.rejects(inspectHeroSources(sharp, [large, large, tiny].map(path => ({ input: heroInput(path) })), createProcessingBudget()), { message: 'HERO_SOURCE_MEMORY_LIMIT' });
  });
});

test('reserved protocol records reject over-limit and malformed payloads instead of file fallback', testOptions, async () => {
  // Arrange: these reserved inputs are never interpreted as filesystem paths.
  const cases = [
    ['text:' + 'x'.repeat(262144), 'HERO_PROTOCOL_LIMIT'],
    ['text:hello|unknown:option', 'HERO_PROTOCOL_INVALID'],
    ['data:image/png;base64,!', 'DEMO_PREVIEW_PROTOCOL_FAILED'],
  ];
  // Act / Assert
  for (const [record, message] of cases) {
    await assert.rejects(inspectHeroSources(sharp, [{ input: heroInput(record) }], createProcessingBudget()), { message });
  }
});

test('timeline keeps short natural ends and FPS quantization without zero-duration frames', () => {
  // Arrange: a 30-ms source ends before the next 25-fps tick.
  const sources = [{ pages: 2, starts: [0, 10], duration: 30, plays: 1, end: 30 }];
  // Act
  const exact = planHeroTimeline(sources, style);
  const sampled = planHeroTimeline(sources, { ...style, fps: 25 });
  const staticPlan = planHeroTimeline([{ pages: 1, end: 0 }], { ...style, width: 1 });
  // Assert
  assert.deepEqual(exact.delays, [10, 20]);
  assert.deepEqual(sampled.delays, [30]);
  assert.equal(sampled.duration, 30);
  assert.deepEqual(staticPlan.delays, [100]);
  assert.equal(staticPlan.width, 1);
  assert.equal(staticPlan.height, 1);
});

test('timeline rejects output-frame and RGBA overflow without shrinking or allocating', () => {
  // Arrange: synthetic metadata only; no media pixels or output stack allocated.
  const source = plays => ({ pages: 2, starts: [0, 10], duration: 20, plays, end: plays * 20 });
  // Act
  const frameBoundary = planHeroTimeline([source(2048)], { ...style, width: 1 });
  const memoryBoundary = planHeroTimeline([source(150)], { ...style, width: 1112 });
  // Assert
  assert.equal(frameBoundary.delays.length, 4096);
  assert.ok(memoryBoundary.rgbaBytes <= 1024 * 1024 * 1024);
  assert.equal(memoryBoundary.width, 1112);
  assert.throws(() => planHeroTimeline([source(2049)], { ...style, width: 1 }), { message: 'HERO_FRAME_LIMIT' });
  assert.throws(() => planHeroTimeline([source(151)], { ...style, width: 1112 }), { message: 'HERO_OUTPUT_MEMORY_LIMIT' });
  assert.throws(() => planHeroTimeline([source(2500)], { ...style, width: 1, fps: 100 }), { message: 'HERO_FRAME_LIMIT' });
});

test('FPS planning accepts 4096 rounded samples when the last candidate lands on the natural end', () => {
  // Arrange: the unrounded candidate count is 4097, but its last tick rounds to
  // the excluded 67150-ms end rather than contributing another output frame.
  const sources = [{ pages: 2, starts: [0, 80], duration: 67150, plays: 1, end: 67150 }];
  // Act
  const plan = planHeroTimeline(sources, { ...style, width: 1, fps: 61 });
  // Assert: no natural-end drift, zero-length frame, or unnecessary cap rejection.
  assert.equal(plan.delays.length, 4096);
  assert.equal(plan.duration, 67150);
  assert.equal(total(plan.delays), 67150);
  assert.ok(plan.delays.every(delay => delay > 0 && delay % 10 === 0));
});

test('output-frame planning counts encoding-only long-hold chunks against the shared cap', () => {
  // Arrange: each two-frame play needs additional storage for a long hold.
  // Metadata only: no large source or output pixel buffers are allocated.
  const source = plays => ({ pages: 2, starts: [0, 70000], duration: 70100, plays, end: 70100 * plays });
  // Act
  const plan = planHeroTimeline([source(1365)], { ...style, width: 1 });
  // Assert: the valid plan preserves duration; one extra play exceeds the cap
  // even though the number of source visual changes alone is below 4096.
  assert.equal(plan.delays.length, 4095);
  assert.equal(total(plan.delays), 70100 * 1365);
  assert.equal(plan.rgbaBytes, plan.frameBytes * plan.delays.length);
  assert.throws(() => planHeroTimeline([source(1366)], { ...style, width: 1 }), { message: 'HERO_FRAME_LIMIT' });
});

test('hero obeys an already-cancelled shared processing deadline before reading inputs', testOptions, async () => {
  // Arrange: no sleeps or timing races; a missing path must never be opened.
  const controller = new AbortController();
  const reason = new PreviewError('DEMO_PREVIEW_PROCESSING_TIMEOUT');
  controller.abort(reason);
  const budget = createProcessingBudget({ signal: controller.signal });
  // Act / Assert
  await assert.rejects(renderHero(sharp, { ...style, inputs: [{ input: heroInput('never-opened.gif') }] }, budget), error => error === reason);
});
