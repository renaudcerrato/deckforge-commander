import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rollup } from 'rollup';
import { buildToolchainPaths } from '../scripts/bootstrap-toolchain.mjs';
import { buildWindowsTests } from '../scripts/build-windows-tests.mjs';

// Task owns orchestration. Only Zig, Rollup's CLI and Stream Deck's CLI are
// replaced by controlled fixture processes; Task and its inline staging run real.
const repository = fileURLToPath(new URL('../', import.meta.url));
const parent = path.join(repository, '.task/windows-tests/packaging-fixtures');
const task = path.join(repository, 'node_modules/@go-task/cli/bin', process.platform === 'win32' ? 'task.exe' : 'task');
const run = promisify(execFile), options = { timeout: 20000 };
const plugin = 'git.renaudcerrato.deckforge.sdPlugin', nativeName = 'native/win32-x64/transport.node';
const candidate = `.task/package/${plugin}`, installer = 'dist/git.renaudcerrato.deckforge.streamDeckPlugin';
async function put(root, name, bytes) { const file = path.join(root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes); }
async function newRoot() { await mkdir(parent, { recursive: true }); return mkdtemp(path.join(parent, 'task space-é-')); }
async function nativeFixture() {
  const root = await newRoot(), binary = Buffer.from('synthetic transport bytes; never loaded');
  await put(root, '.task/native/win32-x64/transport.node', binary); return { root, binary };
}
async function packageFixture(outcome = 'success') {
  const root = await newRoot(), paths = buildToolchainPaths(root);
  for (const name of ['Taskfile.yml', 'scripts/bootstrap-toolchain.mjs']) await put(root, name, await readFile(path.join(repository, name)));
  for (const file of [paths.taskExe, paths.input.zig, paths.input.nodeLibrary, paths.input.source, path.join(paths.input.headers, 'node_api.h')]) {
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, 'synthetic tool input');
  }
  const files = new Map([['manifest.json', '{"UUID":"git.renaudcerrato.deckforge","Description":"Script to canvas"}'],
    ['bin/plugin.js', 'export {};'], ['bin/package.json', '{"type":"module"}'], ['bin/' + nativeName, 'synthetic transport'],
    ['ui/run.html', '<html></html>'], ['ui/run.js', 'void 0;'], ['ui/sdpi-components.js', 'void 0;'],
    ['THIRD_PARTY_NOTICES.txt', 'Synthetic notices'], ['imgs/actions/run/icon.svg', '<svg/>']]);
  for (const [name, bytes] of files) await put(root, `${plugin}/${name}`, bytes);
  await put(root, 'LICENSE', 'Synthetic license');
  const zigScript = `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';
if(process.argv[2]==='version') console.log('0.17.0');
else { ${outcome === 'native failure' ? 'process.exit(9);' : "writeFileSync(process.argv[process.argv.indexOf('-o')+1], 'synthetic transport');"} }\n`;
  // Task derives ZIG from its own toolchain paths; install the external test
  // double there rather than supplying an ineffective CLI variable override.
  await writeFile(paths.input.zig, zigScript);
  await chmod(paths.input.zig, 0o755);
  await put(root, 'node_modules/rollup/dist/bin/rollup', `
const fs = require('node:fs');
fs.copyFileSync('.task/native/win32-x64/transport.node', '${plugin}/bin/${nativeName}');
`);
  await put(root, 'node_modules/.bin/package.json', '{"type":"module"}');
  await put(root, 'node_modules/.bin/streamdeck', `#!${process.execPath}
import assert from 'node:assert/strict'; import { readFile, writeFile } from 'node:fs/promises';
assert.deepEqual(process.argv.slice(2), ['pack', '${candidate}', '--output', 'dist', '--no-update-check', '--force']);
assert.equal(await readFile('${candidate}/LICENSE', 'utf8'), 'Synthetic license');
${outcome === 'CLI failure' ? 'process.exitCode=7;' : outcome === 'missing installer' ? '// Intentionally emit no installer.' : `await writeFile('${installer}', ${JSON.stringify(outcome === 'empty installer' ? '' : 'synthetic installer')});`}
`);
  await chmod(path.join(root, 'node_modules/.bin/streamdeck'), 0o755);
  return { root, files };
}
const pack = f => run(task, ['--taskfile', path.join(f.root, 'Taskfile.yml'), 'pack'], { cwd: f.root, timeout: 18000 });
async function tree(root, relative = '') {
  const names = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) names.push(...await tree(root, name)); else names.push(name);
  }
  return names.sort();
}
test('Task pack builds, stages distributable bytes and license, invokes CLI and supports repeat output', options, async () => {
  // Arrange
  const f = await packageFixture(); await put(f.root, 'dist/unrelated.txt', 'retained');
  for (const name of ['bin/plugin.js.map', 'bin/native/win32-x64/transport.provenance.json', 'debug.log']) await put(f.root, `${plugin}/${name}`, 'excluded');
  const authored = await readFile(path.join(f.root, plugin, 'manifest.json'));
  // Act
  await pack(f); await pack(f);
  // Assert: fixture CLI checks argv and stage availability; no real compiler/CLI runs.
  assert.equal(await readFile(path.join(f.root, installer), 'utf8'), 'synthetic installer');
  assert.equal(await readFile(path.join(f.root, 'dist/unrelated.txt'), 'utf8'), 'retained');
  assert.deepEqual(await tree(path.join(f.root, candidate)), [...f.files.keys(), 'LICENSE'].sort());
  for (const [name, bytes] of f.files) assert.deepEqual(await readFile(path.join(f.root, candidate, name)), Buffer.from(bytes));
  assert.equal(await readFile(path.join(f.root, candidate, 'LICENSE'), 'utf8'), 'Synthetic license');
  assert.deepEqual(await readFile(path.join(f.root, plugin, 'manifest.json')), authored);
});
test('repeat packaging removes stale stage assets while preserving neighboring, source and dist files', options, async () => {
  // Arrange: only the dedicated generated plugin stage is eligible for deletion.
  const f = await packageFixture(); await pack(f);
  await put(f.root, `${candidate}/imgs/obsolete.svg`, '<svg>stale</svg>');
  await put(f.root, `${candidate}/obsolete.txt`, 'stale stage file');
  const neighbors = ['.task/package/other-dir/sentinel.txt', 'dist/unrelated.txt', 'root-sentinel.txt'];
  for (const name of neighbors) await put(f.root, name, 'retained');
  const sourceBefore = await readFile(path.join(f.root, plugin, 'imgs/actions/run/icon.svg'));
  // Act
  await pack(f);
  // Assert: refreshed contents, not an accumulated mix of current and old assets.
  await assert.rejects(access(path.join(f.root, candidate, 'imgs/obsolete.svg')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(f.root, candidate, 'obsolete.txt')), { code: 'ENOENT' });
  assert.deepEqual(await tree(path.join(f.root, candidate)), [...f.files.keys(), 'LICENSE'].sort());
  assert.deepEqual(await readFile(path.join(f.root, candidate, 'imgs/actions/run/icon.svg')), sourceBefore);
  assert.deepEqual(await readFile(path.join(f.root, plugin, 'imgs/actions/run/icon.svg')), sourceBefore);
  for (const name of neighbors) assert.equal(await readFile(path.join(f.root, name), 'utf8'), 'retained');
  assert.equal(await readFile(path.join(f.root, installer), 'utf8'), 'synthetic installer');
});
test('missing required input preserves the previous stage before refresh', options, async () => {
  // Arrange: simulate incomplete authored input without deleting a source file.
  const f = await packageFixture();
  await put(f.root, `${candidate}/previous.txt`, 'retained previous stage');
  await put(f.root, `${plugin}/ui/run.html`, '');
  // Act / Assert
  await assert.rejects(pack(f), error => /Missing or empty build input/.test(error.stdout + error.stderr));
  assert.deepEqual(await tree(path.join(f.root, candidate)), ['previous.txt']);
  assert.equal(await readFile(path.join(f.root, candidate, 'previous.txt'), 'utf8'), 'retained previous stage');
  await assert.rejects(access(path.join(f.root, installer)), { code: 'ENOENT' });
});
for (const outcome of ['native failure', 'CLI failure', 'missing installer', 'empty installer']) {
  test(`Task pack stops on ${outcome}`, options, async () => {
    // Arrange
    const f = await packageFixture(outcome);
    // Act / Assert
    await assert.rejects(pack(f), error => {
      assert.ok(error.code !== 0);
      const output = error.stdout + error.stderr;
      assert.match(output, outcome === 'native failure' ? /exit status 9/ : outcome === 'CLI failure' ? /exit status 7/ : /ENOENT|Missing or empty build input/);
      return true;
    });
    if (outcome !== 'empty installer') await assert.rejects(access(path.join(f.root, installer)), { code: 'ENOENT' });
    if (outcome === 'native failure') await assert.rejects(access(path.join(f.root, candidate)), { code: 'ENOENT' });
  });
}
for (const scenario of ['missing required UI', 'linked stage', 'file stage root', 'file stage ancestor', 'invalid image', 'linked installer', 'directory installer']) {
  test(`Task packaging refuses ${scenario} without replacing a sentinel`, options, async () => {
    // Arrange
    const f = await packageFixture(); await put(f.root, 'retained', 'retained');
    if (scenario === 'missing required UI') await put(f.root, `${plugin}/ui/run.html`, '');
    if (scenario === 'invalid image') await put(f.root, `${plugin}/imgs/unexpected.txt`, 'invalid');
    if (scenario === 'file stage ancestor') await put(f.root, '.task/package', 'retained');
    if (scenario === 'file stage root') await put(f.root, candidate, 'retained stage root');
    if (scenario === 'linked stage') {
      await put(f.root, 'owned-stage-target/sentinel.txt', 'retained target');
      await mkdir(path.join(f.root, '.task/package'), { recursive: true });
      await symlink(path.join(f.root, 'owned-stage-target'), path.join(f.root, candidate), 'dir');
    }
    if (scenario === 'linked installer' || scenario === 'directory installer') {
      await mkdir(path.join(f.root, 'dist'));
      if (scenario === 'linked installer') await symlink(path.join(f.root, 'retained'), path.join(f.root, installer));
      else await mkdir(path.join(f.root, installer));
    }
    // Act / Assert
    await assert.rejects(pack(f), error => /Missing or empty build input|Unsafe build destination|Unexpected plugin image file/.test(error.stdout + error.stderr));
    assert.equal(await readFile(path.join(f.root, 'retained'), 'utf8'), 'retained');
    if (scenario === 'linked stage') {
      assert.deepEqual(await readdir(path.join(f.root, 'owned-stage-target')), ['sentinel.txt']);
      assert.equal(await readFile(path.join(f.root, 'owned-stage-target/sentinel.txt'), 'utf8'), 'retained target');
    }
    if (scenario === 'file stage root') assert.equal(await readFile(path.join(f.root, candidate), 'utf8'), 'retained stage root');
  });
}
async function generateAssets(root) {
  await put(root, 'rollup.config.mjs', await readFile(path.join(repository, 'rollup.config.mjs')));
  const { default: configurations } = await import(pathToFileURL(path.join(root, 'rollup.config.mjs')).href);
  const plugins = configurations[0].plugins.filter(item => item && ['emit-windows-native-assets', 'emit-module-package-file'].includes(item.name));
  const bundle = await rollup({ input: 'fixture', plugins: [
    { name: 'fixture-entry', resolveId: id => id === 'fixture' ? id : null, load: id => id === 'fixture' ? 'export const fixture = true;' : null }, ...plugins] });
  try { return (await bundle.generate({ format: 'es' })).output.filter(item => item.type === 'asset'); }
  finally { await bundle.close(); }
}
test('Rollup emits transport bytes and ES module metadata', options, async () => {
  // Arrange
  const f = await nativeFixture();
  // Act
  const assets = new Map((await generateAssets(f.root)).map(asset => [asset.fileName, asset.source]));
  // Assert
  assert.deepEqual([...assets.keys()].sort(), [nativeName, 'package.json'].sort());
  assert.deepEqual(Buffer.from(assets.get(nativeName)), f.binary); assert.equal(JSON.parse(assets.get('package.json')).type, 'module');
});
test('Rollup refuses a missing transport', options, async () => {
  // Arrange
  const root = await newRoot();
  // Act / Assert
  await assert.rejects(generateAssets(root), /ENOENT/);
});
test('test kit contains only driver, producer and transport and supports rebuild', options, async () => {
  // Arrange
  const f = await nativeFixture();
  await put(f.root, 'tests/windows-integration.test.mjs', "export const fixtureIdentity = 'synthetic-driver';");
  await put(f.root, 'tests/fixtures/windows-native-producer.mjs', "export const fixtureIdentity = 'synthetic-producer';");
  // Act
  const first = await buildWindowsTests(f.root); await buildWindowsTests(f.root);
  // Assert: generated test bodies are never executed.
  assert.deepEqual(first.files.sort(), ['windows-tests.mjs', 'windows-native-producer.mjs', nativeName].sort());
  assert.deepEqual(await tree(first.directory), first.files); assert.deepEqual(await readFile(path.join(first.directory, nativeName)), f.binary);
});
for (const scenario of ['missing driver', 'missing producer', 'missing transport', 'linked output', 'relative root']) {
  test(`test kit rejects ${scenario}`, options, async () => {
    // Arrange
    const f = scenario === 'missing transport' ? { root: await newRoot() } : await nativeFixture();
    if (scenario !== 'missing driver') await put(f.root, 'tests/windows-integration.test.mjs', 'export const fixture = true;');
    if (scenario !== 'missing producer') await put(f.root, 'tests/fixtures/windows-native-producer.mjs', 'export const fixture = true;');
    if (scenario === 'linked output') {
      await put(f.root, 'retained', 'retained'); await mkdir(path.join(f.root, '.task/windows-tests'), { recursive: true });
      await symlink(path.join(f.root, 'retained'), path.join(f.root, '.task/windows-tests/windows-tests.mjs'));
    }
    // Act / Assert
    await assert.rejects(buildWindowsTests(scenario === 'relative root' ? 'relative-root' : f.root), /ENOENT|Unsafe build destination|absolute repository root/);
    if (scenario === 'linked output') assert.equal(await readFile(path.join(f.root, 'retained'), 'utf8'), 'retained');
  });
}
