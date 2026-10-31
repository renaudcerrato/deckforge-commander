import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ASSETS_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(ASSETS_DIRECTORY, '..');
const PLUGIN_DIRECTORY = resolve(PROJECT_ROOT, 'git.renaudcerrato.deckforge.sdPlugin/imgs/plugin');
const OUTPUTS = [
  { filename: 'marketplace.png', size: 256 },
  { filename: 'marketplace@2x.png', size: 512 },
];
const MAX_PNG_BYTES = 1024 * 1024;
const INPUT_OPTIONS = { limitInputPixels: 512 * 512 };

class IconError extends Error {
  constructor(identifier, exitCode = 1) {
    super(`PLUGIN_ICON_${identifier}`);
    this.exitCode = exitCode;
  }
}

function fail(identifier, exitCode = 1) {
  throw new IconError(identifier, exitCode);
}

function parseArguments(args) {
  const check = args[0] === '--check';
  const remaining = check ? args.slice(1) : args;
  if (remaining.length !== 2 || remaining[0] !== '--output-dir'
    || !remaining[1] || remaining[1].startsWith('-') || remaining[1].includes('\0')) {
    fail('ARGUMENTS_INVALID', 2);
  }
  return { check, directory: resolve(remaining[1]) };
}

async function inspectOutput(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) fail('FILE_INVALID');
    return info;
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function decodePng(sharp, bytes, size) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_PNG_BYTES) fail('PNG_INVALID');
  const metadata = await sharp(bytes, INPUT_OPTIONS).timeout({ seconds: 30 }).metadata();
  if (metadata.format !== 'png' || metadata.width !== size || metadata.height !== size
    || (metadata.pages ?? 1) !== 1) fail('PNG_INVALID');
  const { data, info } = await sharp(bytes, INPUT_OPTIONS).ensureAlpha().raw()
    .timeout({ seconds: 30 }).toBuffer({ resolveWithObject: true });
  if (info.width !== size || info.height !== size || info.channels !== 4
    || data.length !== size * size * 4) fail('PNG_INVALID');
  for (let offset = 3; offset < data.length; offset += 4) {
    if (data[offset] !== 255) fail('PNG_NOT_OPAQUE');
  }
  return data;
}

async function renderOutputs(sharp, source) {
  const outputs = [];
  for (const output of OUTPUTS) {
    const { data, info } = await sharp(source, INPUT_OPTIONS).resize(output.size, output.size)
      .png().timeout({ seconds: 30 }).toBuffer({ resolveWithObject: true });
    if (info.format !== 'png' || info.width !== output.size || info.height !== output.size) fail('RENDER_INVALID');
    outputs.push({ ...output, bytes: data, pixels: await decodePng(sharp, data, output.size) });
  }
  return outputs;
}

async function writeOutput(directory, output) {
  const destination = resolve(directory, output.filename);
  const temporary = resolve(directory, `.plugin-icon-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o644);
  try {
    try { await handle.writeFile(output.bytes); }
    finally { await handle.close(); }
    // Atomic per file, not a transaction across the pair.
    await rename(temporary, destination);
  } finally {
    try { await unlink(temporary); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export async function generatePluginIcon({ check = false, directory = PLUGIN_DIRECTORY } = {}) {
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) fail('DIRECTORY_INVALID');
  const sourcePath = resolve(ASSETS_DIRECTORY, 'plugin-icon.svg');
  const sourceInfo = await stat(sourcePath);
  if (!sourceInfo.isFile() || sourceInfo.size < 1 || sourceInfo.size > 262_144) fail('FILE_INVALID');
  const source = await readFile(sourcePath);
  if (source.length < 1 || source.length > 262_144) fail('FILE_INVALID');
  const existing = await Promise.all(OUTPUTS.map(output => inspectOutput(resolve(directory, output.filename))));
  const sharp = (await import('sharp')).default;
  const outputs = await renderOutputs(sharp, source);
  let written = 0;
  for (const [index, output] of outputs.entries()) {
    const current = existing[index];
    let pixels;
    if (current?.size > 0 && current.size <= MAX_PNG_BYTES) {
      const bytes = await readFile(resolve(directory, output.filename));
      try { pixels = await decodePng(sharp, bytes, output.size); }
      catch (error) { if (check) throw error; }
    }
    // Compression differences are harmless; missing/corrupt pixels need regeneration.
    if (pixels?.equals(output.pixels)) continue;
    if (check) fail(current ? 'OUTPUT_STALE' : 'OUTPUT_MISSING');
    await writeOutput(directory, output);
    written += 1;
  }
  return { written, skipped: outputs.length - written };
}

async function main(args) {
  const options = parseArguments(args);
  await generatePluginIcon(options);
  console.log(options.check ? 'PLUGIN_ICON_CHECK_OK 2' : 'PLUGIN_ICON_WRITE_OK 2');
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof IconError ? error.message : 'PLUGIN_ICON_OPERATION_FAILED');
    process.exitCode = error instanceof IconError ? error.exitCode : 1;
  }
}
