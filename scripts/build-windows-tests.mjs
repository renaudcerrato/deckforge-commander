import { builtinModules } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { rollup } from 'rollup';
import nodeResolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import { assertSafeBuildPath, requireBuildFile } from './bootstrap-toolchain.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** Bundle the six-case driver and copy its producer and native transport. */
export async function buildWindowsTests(root = ROOT) {
  if (!path.isAbsolute(root)) throw new Error('Expected an absolute repository root.');
  const directory = path.join(root, '.task/windows-tests');
  const input = path.join(root, 'tests/windows-integration.test.mjs');
  const fixture = path.join(root, 'tests/fixtures/windows-native-producer.mjs');
  await requireBuildFile(input);
  await requireBuildFile(fixture);
  const native = await readFile(path.join(root, '.task/native/win32-x64/transport.node'));
  const builtins = new Set(builtinModules);
  const bundle = await rollup({ input,
    external: id => id.startsWith('node:') || builtins.has(id),
    plugins: [nodeResolve({ preferBuiltins: true, exportConditions: ['node'] }), commonjs()],
  });
  let generated;
  try { generated = await bundle.generate({ format: 'es', inlineDynamicImports: true }); }
  finally { await bundle.close(); }
  if (generated.output.length !== 1 || generated.output[0].type !== 'chunk') {
    throw new Error('Unexpected Windows test bundle outputs.');
  }
  const files = new Map([
    ['windows-tests.mjs', Buffer.from(generated.output[0].code)],
    ['windows-native-producer.mjs', await readFile(fixture)],
    ['native/win32-x64/transport.node', native],
  ]);
  for (const name of files.keys()) await assertSafeBuildPath(path.join(directory, name));
  for (const [name, bytes] of files) {
    const file = path.join(directory, name);
    await assertSafeBuildPath(file, { createParents: true });
    await writeFile(file, bytes);
  }
  return { directory, files: [...files.keys()] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2 || process.versions.node.split('.')[0] !== '24') throw new Error('Use Node 24 without arguments.');
    await buildWindowsTests();
    console.log('WINDOWS_TEST_BUNDLE_OK');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
