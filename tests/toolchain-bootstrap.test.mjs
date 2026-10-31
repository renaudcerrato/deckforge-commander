import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, link, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { toolchainDownloads, downloadPinnedArtifact, extractPinnedArchive, buildToolchainPaths,
  requireBuildFile, assertSafeBuildPath, ensureBuildToolchain, prepareNativeBuild } from '../scripts/bootstrap-toolchain.mjs';

// R12: download integrity and ordinary cached tools, not source inventories.
const parent = fileURLToPath(new URL('../.task/windows-tests/toolchain-bootstrap-fixtures/', import.meta.url));
const options = { timeout: 10000 };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture() { await mkdir(parent, { recursive: true }); return mkdtemp(path.join(parent, 'case-')); }
async function put(file, bytes) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes); }
async function cached(root) {
  const paths = buildToolchainPaths(root);
  for (const file of [paths.taskExe, paths.input.zig, paths.input.nodeLibrary, paths.input.source,
    path.join(paths.input.headers, 'node_api.h')]) await put(file, 'synthetic input; never executed');
  return paths;
}
for (const [platform, arch, bytes, checksum] of [
  ['darwin', 'arm64', 53985220, 'b607e9b9234790a008116ae5bdb71c6243b84b9fb42a53a9e70fde41c06c536a'],
  ['darwin', 'x64', 59317572, '4f9a1c5269aa17ebda5e6d3c2b89d6cbf36f7d2b22a0306e9ab98f25f95529c6'],
  ['linux', 'x64', 57332648, '1cbe9df9f27e6b78d14ccbca43b6703a404ef79ef1c463de901d7f088d4e2026'],
  ['win32', 'x64', 100268137, 'b5663f69581dcf391293fbf16c06cb80d81d806545ce618b4d0bab7f0eb8c428'],
]) {
  test(`downloads pin ${platform}/${arch} Zig and Windows SDK inputs`, () => {
    // Arrange / Act
    const artifacts = toolchainDownloads(platform, arch);
    // Assert
    assert.equal(artifacts.length, 3); assert.equal(artifacts[0].bytes, bytes); assert.equal(artifacts[0].sha256, checksum);
    assert.match(artifacts[0].url, /^https:\/\/ziglang\.org\/download\/0\.17\.0\//);
    assert.deepEqual(artifacts.slice(1).map(a => [a.name, a.bytes, a.sha256]), [
      ['headers.tar.gz', 9993589, '0e0073cb62a38c0d41c08df0311a60b755c68edcd4e4dbb04b0a3bbe0083e186'],
      ['node.lib', 2970634, '437cc33eb3f9ad8b90737dd930b7344dd88481ab803ffe9818dbe3973e49341f'],
    ]);
    for (const artifact of artifacts.slice(1)) assert.match(artifact.url, /^https:\/\/nodejs\.org\/dist\/v24\.13\.1\//);
  });
}
test('Linux x64 selects the pinned Linux tar.xz archive', () => {
  // Arrange: Linux CI uses a host-native Zig to cross-compile the Windows transport.
  const platform = 'linux', architecture = 'x64';
  // Act
  const [artifact] = toolchainDownloads(platform, architecture);
  // Assert
  assert.deepEqual(artifact, {
    name: 'zig.tar.xz', top: 'zig-x86_64-linux-0.17.0', bytes: 57332648,
    sha256: '1cbe9df9f27e6b78d14ccbca43b6703a404ef79ef1c463de901d7f088d4e2026',
    url: 'https://ziglang.org/download/0.17.0/zig-x86_64-linux-0.17.0.tar.xz',
  });
});
for (const host of [['linux', 'arm64'], ['win32', 'arm64']]) {
  test(`unsupported host ${host.join('/')} fails clearly`, () => {
    // Arrange / Act / Assert
    assert.throws(() => toolchainDownloads(...host), /macOS arm64\/x64.*Linux x64.*Windows x64 only/);
  });
}
for (const scenario of ['success', 'HTTP failure', 'truncated body', 'wrong hash', 'request failure', 'plain HTTP', 'existing output']) {
  test(`pinned download: ${scenario}`, options, async () => {
    // Arrange: injected fetch boundary never contacts the public network.
    const root = await fixture(), destination = path.join(root, '.task/artifact'); await mkdir(path.dirname(destination));
    const body = Buffer.from('synthetic pinned download'), calls = [];
    const artifact = { name: 'fixture', url: scenario === 'plain HTTP' ? 'http://fixture.invalid/file' : 'https://fixture.invalid/file',
      bytes: body.length, sha256: scenario === 'wrong hash' ? '0'.repeat(64) : sha(body) };
    if (scenario === 'existing output') await put(destination, 'retained');
    const request = async (url, settings) => {
      calls.push({ url, settings });
      if (scenario === 'request failure') throw new Error('synthetic request failure');
      return { ok: scenario !== 'HTTP failure', status: 503,
        arrayBuffer: async () => scenario === 'truncated body' ? body.subarray(0, 2) : body };
    };
    // Act
    const result = downloadPinnedArtifact(artifact, destination, request);
    // Assert
    if (scenario === 'success') {
      await result; assert.deepEqual(await readFile(destination), body);
      assert.equal(calls[0].settings.redirect, 'error'); assert.ok(calls[0].settings.signal instanceof AbortSignal);
    } else {
      await assert.rejects(result, /HTTP 503|integrity check failed|synthetic request failure|require HTTPS|already exists/);
      if (scenario === 'existing output') assert.equal(await readFile(destination, 'utf8'), 'retained');
      else await assert.rejects(access(destination), { code: 'ENOENT' });
    }
    assert.equal(calls.length, ['plain HTTP', 'existing output'].includes(scenario) ? 0 : 1);
  });
}
for (const alias of ['symlink', 'hardlink']) {
  test(`ordinary ${alias} read inputs are accepted`, options, async () => {
    // Arrange
    const root = await fixture(), source = path.join(root, 'tool'), selected = path.join(root, 'selected'); await put(source, 'tool bytes');
    if (alias === 'symlink') await symlink(source, selected); else await link(source, selected);
    // Act
    const info = await requireBuildFile(selected);
    // Assert
    assert.equal(info.size, 10); assert.equal(await readFile(selected, 'utf8'), 'tool bytes');
  });
}
for (const scenario of ['empty input', 'directory input', 'missing input']) {
  test(`required file rejects ${scenario}`, options, async () => {
    // Arrange
    const root = await fixture(), file = path.join(root, 'input');
    if (scenario === 'empty input') await put(file, ''); if (scenario === 'directory input') await mkdir(file);
    // Act / Assert
    await assert.rejects(requireBuildFile(file), /Missing or empty build input|ENOENT/);
  });
}
test('cached tools are reused and prepare only native output/cache directories', options, async () => {
  // Arrange
  const root = await fixture(), expected = await cached(root);
  // Act
  const first = await ensureBuildToolchain(root), second = await prepareNativeBuild(root);
  // Assert
  assert.deepEqual(first, expected); assert.deepEqual(second, expected);
  assert.match(first.cache, /zig-0\.17\.0-node-24\.13\.1-/);
  for (const name of ['temp', 'local', 'global']) assert.deepEqual(await readdir(path.join(`${first.input.output}.build-cache`, name)), []);
  await assert.rejects(access(first.input.output), { code: 'ENOENT' });
  assert.deepEqual(await readdir(path.dirname(first.cache)), [path.basename(first.cache)]);
});
test('incomplete existing cache fails without redownload or replacement', options, async () => {
  // Arrange
  const root = await fixture(), paths = buildToolchainPaths(root); await put(paths.taskExe, 'task'); await put(paths.input.zig, 'retained');
  // Act / Assert
  await assert.rejects(ensureBuildToolchain(root), /Incomplete toolchain cache/);
  assert.equal(await readFile(paths.input.zig, 'utf8'), 'retained');
  assert.deepEqual(await readdir(path.dirname(paths.cache)), [path.basename(paths.cache)]);
});
for (const scenario of ['linked output', 'file ancestor']) {
  test(`native preparation rejects ${scenario} without touching input`, options, async () => {
    // Arrange
    const root = await fixture(), paths = await cached(root), target = path.join(root, 'retained'); await put(target, 'retained');
    if (scenario === 'linked output') { await mkdir(path.dirname(paths.input.output), { recursive: true }); await symlink(target, paths.input.output); }
    else await put(path.join(root, '.task/native'), 'retained');
    // Act / Assert
    await assert.rejects(prepareNativeBuild(root), /Unsafe build destination/);
    assert.equal(await readFile(target, 'utf8'), 'retained');
  });
}
test('output guard creates ordinary destinations and rejects relative paths', options, async () => {
  // Arrange
  const root = await fixture(), file = path.join(root, 'dist/installer');
  // Act
  await assertSafeBuildPath(file, { createParents: true });
  // Assert
  assert.deepEqual(await readdir(path.join(root, 'dist')), []);
  await assert.rejects(assertSafeBuildPath('dist/installer'), /absolute build output/);
});
function tarFixture() {
  const body = Buffer.from('synthetic archive'), header = Buffer.alloc(512);
  header.write('tool/file.txt'); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
  header.write(body.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136);
  header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263);
  header.write([...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
  return Buffer.concat([header, body, Buffer.alloc(512 - body.length), Buffer.alloc(1024)]);
}
test('ordinary tar on PATH extracts a synthetic archive; existing destination is preserved', options, async () => {
  // Arrange: production authenticates downloads before this extraction boundary.
  const root = await fixture(), archive = path.join(root, '.task/fixture.tar'), destination = path.join(root, '.task/extracted');
  await put(archive, tarFixture());
  // Act
  await extractPinnedArchive({ name: 'fixture.tar' }, archive, destination);
  // Assert
  assert.equal(await readFile(path.join(destination, 'tool/file.txt'), 'utf8'), 'synthetic archive');
  await assert.rejects(extractPinnedArchive({ name: 'fixture.tar' }, archive, destination), /already exists/);
  assert.equal(await readFile(path.join(destination, 'tool/file.txt'), 'utf8'), 'synthetic archive');
});
test('CLI paths query returns transient paths without requiring tools or writing files', options, async () => {
  // Arrange
  const root = await fixture(); await mkdir(path.join(root, 'scripts'));
  const script = path.join(root, 'scripts/bootstrap-toolchain.mjs');
  await writeFile(script, await readFile(new URL('../scripts/bootstrap-toolchain.mjs', import.meta.url)));
  // Act
  const result = await promisify(execFile)(process.execPath, [script, 'paths'], { cwd: root, timeout: 5000 });
  // Assert
  const paths = JSON.parse(result.stdout);
  assert.deepEqual(paths, buildToolchainPaths(root)); assert.deepEqual(await readdir(root), ['scripts']);
});
