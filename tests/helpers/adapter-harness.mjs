import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { types } from 'node:util';
import { Buffer } from 'node:buffer';
import * as shlex from 'shlex';
import ts from 'typescript';

const sourceRoot = fileURLToPath(new URL('../../src/', import.meta.url));
const adapterRoot = path.join(sourceRoot, 'actions');
const runnerPath = path.join(sourceRoot, 'core/process-runner.mjs');
const blocked = boundary => () => { throw new Error(`Unexpected ${boundary} in adapter harness`); };

function internalPath(name, importer) {
  let filename = path.resolve(path.dirname(importer), name);
  if (!path.extname(filename)) filename += '.ts';
  if (!filename.startsWith(sourceRoot) || !['.ts', '.mjs'].includes(path.extname(filename))) {
    throw new Error('Adapter module must be a source .ts or .mjs file');
  }
  return filename;
}

// Discover real relative imports from each importer; only process launching is
// replaced at the project boundary. Never evaluate plugin startup or native code.
export async function loadAdapterCode(names) {
  const codes = new Map();
  async function visit(filename) {
    if (filename === runnerPath || codes.has(filename)) return;
    const source = await readFile(filename, 'utf8');
    codes.set(filename, ts.transpileModule(source, { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true,
    } }).outputText);
    for (const { fileName } of ts.preProcessFile(source, true, true).importedFiles) {
      if (fileName.startsWith('.')) await visit(internalPath(fileName, filename));
    }
  }
  for (const name of names) await visit(internalPath(`./${name}`, path.join(adapterRoot, 'entry.ts')));
  return codes;
}

// Each harness evaluates its own graph with one synthetic process throughout.
// resolve supplies external fakes; observe may wrap real exports to capture real
// instances. Neither is an internal-module inventory or a real-require fallback.
export function createAdapterLoader(codes, { process: syntheticProcess, resolve = () => undefined,
  observe = (_, actual) => actual }) {
  if (!syntheticProcess) throw new Error('Synthetic process is required');
  const modules = new Map();
  const platformPath = syntheticProcess.platform === 'win32' ? path.win32 : path.posix;
  const boundaries = new Map([
    ['shlex', shlex], ['node:util', { types }], ['node:buffer', { Buffer }],
    ['node:path', { ...platformPath, default: platformPath }],
    ['node:os', { homedir: () => '/synthetic/home' }],
    ['node:crypto', { randomUUID: blocked('random UUID request') }],
    ['node:fs/promises', Object.fromEntries(['lstat', 'mkdir', 'open', 'realpath']
      .map(name => [name, blocked('filesystem access')]))],
  ]);
  function isolatedRequire(name, importer = path.join(adapterRoot, 'entry.ts')) {
    const filename = name.startsWith('.') ? internalPath(name, importer) : undefined;
    if (!filename || filename === runnerPath) {
      const supplied = resolve(name);
      if (supplied !== undefined) return supplied;
      if (boundaries.has(name)) return boundaries.get(name);
      throw new Error(`Unexpected adapter boundary: ${name}`);
    }
    if (!codes.has(filename)) throw new Error('Adapter source module was not loaded');
    if (!modules.has(filename)) {
      const exports = {};
      modules.set(filename, exports);
      new Function('require', 'exports', 'process', 'Buffer', codes.get(filename))(
        dependency => isolatedRequire(dependency, filename), exports, syntheticProcess, Buffer);
      const relative = path.relative(adapterRoot, filename).split(path.sep).join('/');
      modules.set(filename, observe(relative.startsWith('.') ? relative : `./${relative}`, exports));
    }
    return modules.get(filename);
  }
  return isolatedRequire;
}
