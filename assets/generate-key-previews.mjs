import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLaunchArtwork } from '../src/core/launch-artwork.mjs';
import { createTimerArtwork } from '../src/core/timer-artwork.mjs';
import { createOnceArtwork } from '../src/core/once-artwork.mjs';
import { PreviewError, createProcessingBudget, fail, renderPreviewPng, withFailure } from './preview-rendering.mjs';

const ASSETS_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const SVG_PREFIX = 'data:image/svg+xml,';
const MAX_SVG_BYTES = 262_144;
const MAX_PNG_BYTES = 1024 * 1024;
const PREVIEW_SIZE = 320;
const STYLE = Object.freeze({ scale: 2, pixels: 96, grid: 0.04, glow: 0.08 });
// Configured Ready illustrations, not the actions' default themes.
const RECIPES = Object.freeze([
  { id: 'stream', filename: 'key-stream.png', render: () => createLaunchArtwork('ready', 'demo', '#22d3ee', 'ready', '.py') },
  { id: 'loop', filename: 'key-loop.png', render: () => createTimerArtwork('ready', 'demo', '#a78bfa', 'ready', '.py') },
  { id: 'run', filename: 'key-run.png', render: () => createOnceArtwork('ready', 'demo', '#ffb454', 'ready', '.py') },
].map(recipe => Object.freeze(recipe)));

async function renderPreviews(sharp, budget) {
  const previews = [];
  for (const recipe of RECIPES) {
    budget.check();
    const image = recipe.render();
    if (typeof image !== 'string' || !image.startsWith(SVG_PREFIX)) fail('KEY_PREVIEW_RENDER_INVALID');
    // Decode the intact production SVG; styling belongs only to the offline PNG.
    const svg = decodeURIComponent(image.slice(SVG_PREFIX.length));
    const source = Buffer.from(svg, 'utf8');
    if (!svg.isWellFormed() || source.length < 1 || source.length > MAX_SVG_BYTES) fail('KEY_PREVIEW_RENDER_INVALID');
    const bytes = await renderPreviewPng(sharp, source, STYLE, budget);
    const pixels = await decodePreview(sharp, bytes, budget);
    previews.push({ id: recipe.id, filename: recipe.filename, bytes, pixels });
  }
  return previews;
}

async function decodePreview(sharp, bytes, budget) {
  return withFailure('KEY_PREVIEW_OUTPUT_INVALID', async () => {
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_PNG_BYTES) fail('KEY_PREVIEW_OUTPUT_INVALID');
    const options = { limitInputPixels: PREVIEW_SIZE * PREVIEW_SIZE };
    const metadata = await sharp(bytes, options).timeout({ seconds: budget.timeout(60) }).metadata();
    budget.check();
    if (metadata.format !== 'png' || metadata.width !== PREVIEW_SIZE || metadata.height !== PREVIEW_SIZE
      || (metadata.pages ?? 1) !== 1) fail('KEY_PREVIEW_OUTPUT_INVALID');
    const result = await sharp(bytes, options).ensureAlpha().raw().timeout({ seconds: budget.timeout(60) })
      .toBuffer({ resolveWithObject: true });
    budget.check();
    if (result.info.width !== PREVIEW_SIZE || result.info.height !== PREVIEW_SIZE || result.info.channels !== 4
      || !Buffer.isBuffer(result.data) || result.data.length !== PREVIEW_SIZE * PREVIEW_SIZE * 4) fail('KEY_PREVIEW_OUTPUT_INVALID');
    const last = PREVIEW_SIZE - 1;
    const corners = [0, last, last * PREVIEW_SIZE, PREVIEW_SIZE * PREVIEW_SIZE - 1];
    const center = Math.floor(PREVIEW_SIZE / 2) * PREVIEW_SIZE + Math.floor(PREVIEW_SIZE / 2);
    if (corners.some(pixel => result.data[pixel * 4 + 3] !== 0)
      || result.data[center * 4 + 3] !== 255) fail('KEY_PREVIEW_OUTPUT_INVALID');
    return result.data;
  });
}

async function inspectOutput(path) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) fail('KEY_PREVIEW_OUTPUT_INVALID');
    return info;
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writePreview(directory, preview) {
  const temporary = resolve(directory, `.key-preview-${preview.id}-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try { await handle.writeFile(preview.bytes); }
    finally { await handle.close(); }
    // Publish only a successfully rendered PNG; atomic per file, not across the set.
    await rename(temporary, resolve(directory, preview.filename));
  } finally {
    try { await unlink(temporary); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export async function generateKeyPreviews({ check = false, directory = ASSETS_DIRECTORY } = {}) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) fail('KEY_PREVIEW_ASSETS_DIRECTORY_INVALID');
  const existing = await Promise.all(RECIPES.map(recipe => inspectOutput(resolve(directory, recipe.filename))));
  const sharp = await withFailure('KEY_PREVIEW_DEPENDENCY_FAILED', async () => (await import('sharp')).default);
  const budget = createProcessingBudget();
  const previews = await renderPreviews(sharp, budget);
  let written = 0;
  for (const [index, preview] of previews.entries()) {
    const file = resolve(directory, preview.filename), current = existing[index];
    let pixels;
    if (current?.size > 0 && current.size <= MAX_PNG_BYTES) {
      const bytes = await readFile(file);
      try { pixels = await decodePreview(sharp, bytes, budget); }
      catch (error) { if (check) throw error; }
    }
    budget.check();
    // Compare pixels rather than PNG compression bytes. Corrupt files are stale.
    if (pixels?.equals(preview.pixels)) continue;
    if (check) fail(current ? 'KEY_PREVIEW_OUTPUT_STALE' : 'KEY_PREVIEW_OUTPUT_MISSING');
    await writePreview(directory, preview);
    written += 1;
  }
  return { written, skipped: previews.length - written };
}

async function main(args) {
  if (args.length !== 1 || !['--write', '--check'].includes(args[0])) fail('KEY_PREVIEW_ARGUMENTS_INVALID', 2);
  const check = args[0] === '--check';
  const result = await generateKeyPreviews({ check });
  console.log(check ? `KEY_PREVIEW_CHECK_OK ${RECIPES.length}` : `KEY_PREVIEW_WRITE_OK ${RECIPES.length} ${result.written}`);
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof PreviewError ? error.message.replace(/^DEMO_PREVIEW_/, 'KEY_PREVIEW_') : 'KEY_PREVIEW_OPERATION_FAILED');
    process.exitCode = error instanceof PreviewError ? error.exitCode : 1;
  }
}
