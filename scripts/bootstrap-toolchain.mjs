import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, stat, mkdir, mkdtemp, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ZIG = {
  'darwin-arm64': { name: 'zig-aarch64-macos-0.17.0', extension: 'tar.xz', bytes: 53985220,
    sha256: 'b607e9b9234790a008116ae5bdb71c6243b84b9fb42a53a9e70fde41c06c536a' },
  'darwin-x64': { name: 'zig-x86_64-macos-0.17.0', extension: 'tar.xz', bytes: 59317572,
    sha256: '4f9a1c5269aa17ebda5e6d3c2b89d6cbf36f7d2b22a0306e9ab98f25f95529c6' },
  'linux-x64': { name: 'zig-x86_64-linux-0.17.0', extension: 'tar.xz', bytes: 57332648,
    sha256: '1cbe9df9f27e6b78d14ccbca43b6703a404ef79ef1c463de901d7f088d4e2026' },
  'win32-x64': { name: 'zig-x86_64-windows-0.17.0', extension: 'zip', bytes: 100268137,
    sha256: 'b5663f69581dcf391293fbf16c06cb80d81d806545ce618b4d0bab7f0eb8c428' },
};

export function toolchainDownloads(platform = process.platform, architecture = process.arch) {
  const zig = ZIG[`${platform}-${architecture}`];
  if (!zig) throw new Error('Source builds support macOS arm64/x64, Linux x64 and Windows x64 only.');
  return [
    { name: `zig.${zig.extension}`, top: zig.name, bytes: zig.bytes, sha256: zig.sha256,
      url: `https://ziglang.org/download/0.17.0/${zig.name}.${zig.extension}` },
    { name: 'headers.tar.gz', top: 'node-v24.13.1', bytes: 9993589,
      sha256: '0e0073cb62a38c0d41c08df0311a60b755c68edcd4e4dbb04b0a3bbe0083e186',
      url: 'https://nodejs.org/dist/v24.13.1/node-v24.13.1-headers.tar.gz' },
    { name: 'node.lib', bytes: 2970634,
      sha256: '437cc33eb3f9ad8b90737dd930b7344dd88481ab803ffe9818dbe3973e49341f',
      url: 'https://nodejs.org/dist/v24.13.1/win-x64/node.lib' },
  ];
}

export async function requireBuildFile(file) {
  const info = await stat(file);
  if (!info.isFile() || !info.size) throw new Error(`Missing or empty build input: ${file}`);
  return info;
}

// Check generated destinations, not the developer's home or linked tool install.
export async function assertSafeBuildPath(file, { directory = false, createParents = false } = {}) {
  if (!path.isAbsolute(file) || file.includes('\0') || file.split(/[\\/]/).includes('..')) {
    throw new Error('Expected an absolute build output path.');
  }
  const parts = file.slice(path.parse(file).root.length).split(path.sep).filter(Boolean);
  const start = parts.findIndex(part => part === '.task' || part === 'dist' || part.endsWith('.sdPlugin'));
  if (start < 0) throw new Error('Expected a generated build destination.');
  let current = path.join(path.parse(file).root, ...parts.slice(0, start)), info;
  for (let index = start; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    const folder = index < parts.length - 1 || directory;
    try { info = await lstat(current); }
    catch (error) { if (error.code !== 'ENOENT') throw error; info = undefined; }
    if (!info && folder && createParents) { await mkdir(current); info = await lstat(current); }
    if (info && (info.isSymbolicLink() || (folder ? !info.isDirectory() : !info.isFile()))) {
      throw new Error(`Unsafe build destination: ${current}`);
    }
  }
  return info;
}

export function buildToolchainPaths(root = ROOT) {
  const downloads = toolchainDownloads();
  const cache = path.join(root, `.task/toolchains/zig-0.17.0-node-24.13.1-${process.platform}-${process.arch}`);
  return { taskExe: path.join(root, 'node_modules/@go-task/cli/bin', process.platform === 'win32' ? 'task.exe' : 'task'),
    cache, input: { node: process.execPath,
      zig: path.join(cache, downloads[0].top, process.platform === 'win32' ? 'zig.exe' : 'zig'),
      headers: path.join(cache, 'node-v24.13.1/include/node'), nodeLibrary: path.join(cache, 'node.lib'),
      source: path.join(root, 'src/native/windows-process-transport.c'),
      output: path.join(root, '.task/native/win32-x64/transport.node') } };
}

export async function downloadPinnedArtifact(artifact, destination, request = fetch) {
  if (!artifact.url.startsWith('https://')) throw new Error('Tool downloads require HTTPS.');
  if (await assertSafeBuildPath(destination)) throw new Error('Download destination already exists.');
  const response = await request(artifact.url, { redirect: 'error', signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Tool download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== artifact.bytes || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) {
    throw new Error(`Tool download integrity check failed: ${artifact.name}`);
  }
  await writeFile(destination, bytes, { flag: 'wx' });
}

export async function extractPinnedArchive(artifact, archive, destination) {
  // Only authenticated official archives reach this call; tar handles their format.
  if (await assertSafeBuildPath(destination, { directory: true })) throw new Error('Extraction destination already exists.');
  await mkdir(destination);
  await new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xf', archive, '-C', destination], { shell: false, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 && !signal ? resolve() : reject(new Error(`Could not extract ${artifact.name}.`)));
  });
}

export async function prepareNativeBuild(root = ROOT) {
  const paths = buildToolchainPaths(root);
  const input = paths.input;
  for (const file of [paths.taskExe, input.node, input.zig, input.nodeLibrary, input.source,
    path.join(input.headers, 'node_api.h')]) await requireBuildFile(file);
  await assertSafeBuildPath(input.output, { createParents: true });
  for (const name of ['temp', 'local', 'global']) {
    await assertSafeBuildPath(path.join(`${input.output}.build-cache`, name), { directory: true, createParents: true });
  }
  return paths;
}

export async function ensureBuildToolchain(root = ROOT) {
  if (process.versions.node.split('.')[0] !== '24') throw new Error('Node 24 is required.');
  const paths = buildToolchainPaths(root);
  await requireBuildFile(paths.taskExe);
  const expected = [paths.input.zig, paths.input.nodeLibrary, path.join(paths.input.headers, 'node_api.h')];
  const present = await Promise.all(expected.map(file => stat(file).then(info => info.isFile() && info.size > 0,
    error => { if (error.code === 'ENOENT') return false; throw error; })));
  if (present.every(Boolean)) return prepareNativeBuild(root);
  if (await assertSafeBuildPath(paths.cache, { directory: true })) throw new Error(`Incomplete toolchain cache: ${paths.cache}`);
  const parent = path.dirname(paths.cache);
  await assertSafeBuildPath(parent, { directory: true, createParents: true });
  // Failed attempts are left intact; only a fully downloaded cache is promoted.
  const stage = await mkdtemp(path.join(parent, '.download-'));
  const ready = path.join(stage, 'ready');
  await mkdir(ready);
  for (const artifact of toolchainDownloads()) {
    const archive = path.join(stage, artifact.name);
    await downloadPinnedArtifact(artifact, archive);
    if (artifact.top) await extractPinnedArchive(artifact, archive, path.join(stage, `${artifact.name}.extracted`));
    await rename(artifact.top ? path.join(stage, `${artifact.name}.extracted`, artifact.top) : archive,
      path.join(ready, artifact.top || artifact.name));
  }
  if (await assertSafeBuildPath(paths.cache, { directory: true })) throw new Error('Toolchain cache appeared during download.');
  await rename(ready, paths.cache);
  return prepareNativeBuild(root);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Use paths, bootstrap or prepare-native.');
    if (process.argv[2] === 'paths') console.log(JSON.stringify(buildToolchainPaths()));
    else if (process.argv[2] === 'bootstrap') await ensureBuildToolchain();
    else if (process.argv[2] === 'prepare-native') await prepareNativeBuild();
    else throw new Error('Use paths, bootstrap or prepare-native.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
