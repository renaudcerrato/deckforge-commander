import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PreviewError, createProcessingBudget, fail, renderDisplayPng } from './preview-rendering.mjs';

const ASSETS = dirname(fileURLToPath(import.meta.url));
export const DEVICES = Object.freeze({
  mini: { template: 'Stream Deck Mini.png', width: 1112, height: 804, columns: 3, rows: 2, x: 202, y: 168 },
  mk2: { template: 'Stream Deck MK.2.png', width: 1560, height: 1108, columns: 5, rows: 3, x: 170, y: 232 },
});
export const APERTURE = 196;
export const PITCH = 256;
const MAX_ARTWORK_BYTES = 262_144;
const MAX_IMAGE_PIXELS = 16_777_216;
export const STYLE = Object.freeze({ scale: 2, pixels: 96, grid: 0.04, glow: 0.08 });
const HELP = `Usage: node assets/compose-device.mjs --device mini|mk2 --output file.png [artwork.png|artwork.svg|- ...]

Place trusted static PNG/SVG artwork in row-major order (left to right, top to bottom).
Use - to skip a key; omitted keys stay unchanged. Mini has 6 keys; MK.2 has 15.
Non-square artwork is black-padded, not cropped. Maximum input size: 262144 bytes.
The PNG retains the template's native dimensions. An existing regular output is
replaced only after rendering succeeds; inputs and templates cannot be outputs.
These are illustrations, not hardware captures.
`;

function parseArguments(args) {
  const result = { artwork: [] };
  let positional = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!positional && value === '--') { positional = true; continue; }
    if (!positional && ['--device', '--output'].includes(value)) {
      const name = value.slice(2), next = args[++index];
      if (result[name] !== undefined || !next || next.startsWith('--')) fail('DEVICE_COMPOSITOR_ARGUMENTS_INVALID', 2);
      result[name] = next;
    } else if (!positional && value.startsWith('-') && value !== '-') {
      fail('DEVICE_COMPOSITOR_ARGUMENTS_INVALID', 2);
    } else result.artwork.push(value);
  }
  if (!Object.hasOwn(DEVICES, result.device) || !result.output || extname(result.output).toLowerCase() !== '.png') {
    fail('DEVICE_COMPOSITOR_ARGUMENTS_INVALID', 2);
  }
  const device = DEVICES[result.device];
  if (result.artwork.length > device.columns * device.rows) fail('DEVICE_COMPOSITOR_TOO_MANY_KEYS', 2);
  return { ...result, output: resolve(result.output), device };
}

export async function inspectOutput(output, protectedPaths) {
  const canonical = resolve(await realpath(dirname(output)), basename(output));
  const protectedFiles = await Promise.all(protectedPaths.map(async path => ({
    path: await realpath(path), info: await stat(path),
  })));
  if (protectedFiles.some(file => file.path === canonical)) fail('DEVICE_COMPOSITOR_OUTPUT_ALIASES_INPUT');
  try {
    const info = await lstat(output);
    if (!info.isFile() || info.isSymbolicLink()) fail('DEVICE_COMPOSITOR_OUTPUT_INVALID');
    if (protectedFiles.some(file => file.info.dev === info.dev && file.info.ino === info.ino)) {
      fail('DEVICE_COMPOSITOR_OUTPUT_ALIASES_INPUT');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function readArtwork(sharp, path, budget) {
  if (!['.png', '.svg'].includes(extname(path).toLowerCase())) fail('DEVICE_COMPOSITOR_ARTWORK_UNSUPPORTED');
  const handle = await open(path, 'r');
  let bytes;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > MAX_ARTWORK_BYTES) fail('DEVICE_COMPOSITOR_ARTWORK_INVALID');
    bytes = await handle.readFile();
  } finally { await handle.close(); }
  if (bytes.length < 1 || bytes.length > MAX_ARTWORK_BYTES) fail('DEVICE_COMPOSITOR_ARTWORK_INVALID');
  const metadata = await sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS })
    .timeout({ seconds: budget.timeout(60) }).metadata();
  budget.check();
  if (!['png', 'svg'].includes(metadata.format) || (metadata.pages ?? 1) !== 1) fail('DEVICE_COMPOSITOR_ARTWORK_UNSUPPORTED');
  return bytes;
}

export async function apertureMask(sharp, budget) {
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${APERTURE}" height="${APERTURE}"><rect width="${APERTURE}" height="${APERTURE}" rx="29" fill="white"/></svg>`);
  return sharp(svg).ensureAlpha().raw().timeout({ seconds: budget.timeout(60) }).toBuffer();
}

/** Mount aperture-sized RGBA in place, retaining the template glass and alpha. */
export function blendKey(target, display, mask, device, index, budget) {
  const left = device.x + index % device.columns * PITCH;
  const top = device.y + Math.floor(index / device.columns) * PITCH;
  for (let y = 0; y < APERTURE; y += 1) {
    budget.check();
    for (let x = 0; x < APERTURE; x += 1) {
      // The MK.2 centre key's physical oval is part of the original glass.
      if (device.columns === 5 && index === 7 && ((x - 98) / 42) ** 2 + ((y - 168) / 9) ** 2 <= 1) continue;
      const source = (y * APERTURE + x) * 4;
      const coverage = mask[source + 3] / 255;
      if (coverage === 0) continue;
      const destination = ((top + y) * device.width + left + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        const glass = target[destination + channel];
        const screen = 255 - (255 - glass) * (255 - display[source + channel]) / 255;
        target[destination + channel] = Math.round(glass + (screen - glass) * coverage);
      }
      // Preserve template alpha, including every pixel outside the aperture.
    }
  }
}

/** Decode the native template once so callers can copy it for successive frames. */
export async function decodeDeviceTemplate(sharp, device, budget) {
  const template = await readFile(resolve(ASSETS, device.template));
  const decoded = await sharp(template, { limitInputPixels: MAX_IMAGE_PIXELS }).ensureAlpha().raw()
    .timeout({ seconds: budget.timeout(60) }).toBuffer({ resolveWithObject: true });
  if (decoded.info.width !== device.width || decoded.info.height !== device.height || decoded.info.channels !== 4) {
    fail('DEVICE_COMPOSITOR_TEMPLATE_INVALID');
  }
  return decoded.data;
}

async function compose(sharp, options, budget) {
  const { device, artwork } = options;
  const template = await decodeDeviceTemplate(sharp, device, budget);
  const mask = await apertureMask(sharp, budget);
  for (const [index, path] of artwork.entries()) {
    if (path === '-') continue;
    const source = await readArtwork(sharp, path, budget);
    const display = await renderDisplayPng(sharp, source, STYLE, budget);
    // A separate, materialized resize retains the simulated display's pixel texture.
    const enlarged = await sharp(display).resize(APERTURE, APERTURE, { kernel: 'nearest' }).ensureAlpha().raw()
      .timeout({ seconds: budget.timeout(60) }).toBuffer();
    blendKey(template, enlarged, mask, device, index, budget);
  }
  const bytes = await sharp(template, { raw: { width: device.width, height: device.height, channels: 4 } })
    .png().timeout({ seconds: budget.timeout(60) }).toBuffer();
  budget.check();
  return bytes;
}

async function publish(output, bytes, protectedPaths) {
  const temporary = resolve(dirname(output), `.device-compositor-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try { await handle.writeFile(bytes); }
    finally { await handle.close(); }
    await inspectOutput(output, protectedPaths);
    await rename(temporary, output);
  } finally {
    try { await unlink(temporary); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

async function main(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { console.log(HELP); return; }
  const options = parseArguments(args);
  const protectedPaths = [
    ...Object.values(DEVICES).map(device => resolve(ASSETS, device.template)),
    ...options.artwork.filter(path => path !== '-').map(path => resolve(path)),
  ];
  await inspectOutput(options.output, protectedPaths);
  const sharp = (await import('sharp')).default;
  const bytes = await compose(sharp, options, createProcessingBudget());
  await publish(options.output, bytes, protectedPaths);
  console.log('DEVICE_COMPOSITOR_WRITE_OK');
}

if (import.meta.main) {
  try { await main(process.argv.slice(2)); }
  catch (error) {
    console.error(error instanceof PreviewError ? error.message : 'DEVICE_COMPOSITOR_OPERATION_FAILED');
    process.exitCode = error instanceof PreviewError ? error.exitCode : 1;
  }
}
