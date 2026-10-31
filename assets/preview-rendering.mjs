import { Buffer } from 'node:buffer';
import { performance } from 'node:perf_hooks';
import { parseOutputUpdate } from '../src/core/output-update.mjs';
import { createPrimitiveArtwork } from '../src/core/primitive-artwork.mjs';

export const CANVAS_SIZE = 144;
export const MAX_RGBA_BYTES = 512 * 1024 * 1024;
export const MAX_FRAMES = 512;
export const VISUAL_OPTION_RULES = Object.freeze({
  '--scale': Object.freeze({ name: 'scale', default: 2, min: 1, max: 3, integer: true }),
  '--grid': Object.freeze({ name: 'grid', default: 0.12, min: 0, max: 1 }),
  '--glow': Object.freeze({ name: 'glow', default: 0.18, min: 0, max: 1 }),
  '--pixels': Object.freeze({ name: 'pixels', default: 96, min: 72, max: 144, values: Object.freeze([72, 96, 144]) }),
});

const DEFAULTS = Object.freeze({ color: '#969696' });
const MARGIN = 8;
const MAX_IMAGE_PIXELS = 16_777_216;
const RENDER_TIMEOUT_SECONDS = 60;
const ANIMATION_TIMEOUT_SECONDS = 120;
const MAX_PNG_BYTES = 1024 * 1024;
const SVG_PREFIX = 'data:image/svg+xml,';
const BASE64_IMAGE = /^data:image\/(?:png|jpeg|svg\+xml|webp);base64,([A-Za-z0-9+/=]+)$/;

export class PreviewError extends Error {
  constructor(identifier, exitCode = 1) {
    super(identifier);
    this.exitCode = exitCode;
  }
}

export function fail(identifier, exitCode = 1) {
  throw new PreviewError(identifier, exitCode);
}

export async function withFailure(identifier, operation) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof PreviewError) throw error;
    fail(identifier);
  }
}

/** One aggregate processing deadline; native operations share the remaining time. */
export function createProcessingBudget({ milliseconds = 120_000, signal } = {}) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0 || milliseconds > 120_000) fail('DEMO_PREVIEW_PROCESSING_TIMEOUT');
  const deadline = performance.now() + milliseconds;
  function check() {
    if (signal?.aborted) throw signal.reason;
    const remaining = deadline - performance.now();
    if (remaining <= 0) fail('DEMO_PREVIEW_PROCESSING_TIMEOUT');
    return remaining;
  }
  return Object.freeze({
    check,
    timeout(maximum) {
      const seconds = Math.floor(check() / 1000);
      if (seconds < 1) fail('DEMO_PREVIEW_PROCESSING_TIMEOUT');
      return Math.min(maximum, seconds);
    },
  });
}

function timeout(budget, maximum) {
  return { seconds: budget ? budget.timeout(maximum) : maximum };
}

function imageBytes(image) {
  if (image.startsWith(SVG_PREFIX)) return Buffer.from(decodeURIComponent(image.slice(SVG_PREFIX.length)), 'utf8');
  const encoded = BASE64_IMAGE.exec(image);
  if (!encoded) fail('DEMO_PREVIEW_IMAGE_INVALID');
  return Buffer.from(encoded[1], 'base64');
}

/** Production defaults and skip/fatal semantics, without native image decoding. */
export function renderRecord(record) {
  try {
    const update = parseOutputUpdate(record, DEFAULTS);
    if (!update) return undefined;
    const image = update.kind === 'image' ? update.image : createPrimitiveArtwork(update);
    return image === undefined ? undefined : imageBytes(image);
  } catch {
    fail('DEMO_PREVIEW_PROTOCOL_FAILED');
  }
}

export function gifDelay(milliseconds) {
  const delay = Math.max(10, Math.round(milliseconds / 10) * 10);
  if (!Number.isSafeInteger(delay) || delay > 655_350) fail('DEMO_PREVIEW_TIMING_INVALID');
  return delay;
}

export function sizeTimeline(frames, delays, scale, bezel = true) {
  if (!Number.isInteger(scale) || scale < 1 || scale > 3 || typeof bezel !== 'boolean') fail('DEMO_PREVIEW_OPTIONS_INVALID');
  if (frames.length < 1 || frames.length > MAX_FRAMES || delays.length !== frames.length) fail('DEMO_PREVIEW_FRAME_LIMIT');
  const displaySize = CANVAS_SIZE * scale;
  const size = (CANVAS_SIZE + (bezel ? 2 * MARGIN : 0)) * scale;
  const frameBytes = size * size * 4;
  const rgbaBytes = frameBytes * frames.length;
  if (!Number.isSafeInteger(rgbaBytes) || rgbaBytes > MAX_RGBA_BYTES) fail('DEMO_PREVIEW_MEMORY_LIMIT');
  return { frames, delays, size, displaySize, frameBytes, rgbaBytes };
}

function svgDocument(size, content) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${content}</svg>`, 'utf8');
}

function bezelSvg(size, scale) {
  // Only the exterior is transparent; the rounded bezel and display remain solid.
  return svgDocument(size,
    `<rect x="${scale}" y="${scale}" width="${size - 2 * scale}" height="${size - 2 * scale}" rx="${20 * scale}" fill="#151922"/>`
    + `<rect x="${4 * scale}" y="${4 * scale}" width="${size - 8 * scale}" height="${size - 8 * scale}" rx="${17 * scale}" fill="#050609" stroke="#242a35" stroke-width="${scale}"/>`);
}

function maskSvg(size, scale) {
  return svgDocument(size, `<rect width="${size}" height="${size}" rx="${12 * scale}" fill="white"/>`);
}

function verifyRaw(result, width, height) {
  if (result.info.width !== width || result.info.height !== height || result.info.channels !== 4
    || !Buffer.isBuffer(result.data) || result.data.length !== width * height * 4) fail('DEMO_PREVIEW_RASTER_INVALID');
  return result.data;
}

async function rasterize(sharp, image, size, flatten, budget, fit = 'fill') {
  return withFailure('DEMO_PREVIEW_RASTER_FAILED', async () => {
    let pipeline = sharp(image, { limitInputPixels: MAX_IMAGE_PIXELS }).resize(size, size, { fit, background: '#000000' });
    if (flatten) pipeline = pipeline.flatten({ background: '#000000' });
    const result = await pipeline.ensureAlpha().raw().timeout(timeout(budget, RENDER_TIMEOUT_SECONDS))
      .toBuffer({ resolveWithObject: true });
    budget?.check();
    return verifyRaw(result, size, size);
  });
}

async function sampleFrame(sharp, frame, pixels, budget) {
  if (frame.samples) {
    const result = await sharp(frame.samples, { raw: { width: CANVAS_SIZE, height: CANVAS_SIZE, channels: 4 } })
      .resize(pixels, pixels).raw().timeout(timeout(budget, RENDER_TIMEOUT_SECONDS))
      .toBuffer({ resolveWithObject: true });
    budget?.check();
    return verifyRaw(result, pixels, pixels);
  }
  if (frame.image !== undefined) return rasterize(sharp, frame.image, pixels, true, budget);
  const black = Buffer.alloc(pixels * pixels * 4);
  for (let index = 3; index < black.length; index += 4) black[index] = 255;
  return black;
}

async function enlargeSamples(sharp, samples, pixels, size, budget) {
  // Materialize sampling first: Sharp allows only one resize in each pipeline.
  const result = await sharp(samples, { raw: { width: pixels, height: pixels, channels: 4 } })
    .resize(size, size, { kernel: 'nearest' }).raw().timeout(timeout(budget, RENDER_TIMEOUT_SECONDS))
    .toBuffer({ resolveWithObject: true });
  budget?.check();
  return verifyRaw(result, size, size);
}

async function bloomSamples(sharp, display, size, options, budget) {
  if (options.glow === 0) return undefined;
  const result = await sharp(display, { raw: { width: size, height: size, channels: 4 } })
    .blur(options.scale * 0.8).raw().timeout(timeout(budget, RENDER_TIMEOUT_SECONDS))
    .toBuffer({ resolveWithObject: true });
  budget?.check();
  return verifyRaw(result, size, size);
}

function simulateDisplay(display, bloom, size, options, budget) {
  const simulated = Buffer.from(display);
  const cellWidth = size / options.pixels;
  for (let y = 0; y < size; y += 1) {
    budget?.check();
    for (let x = 0; x < size; x += 1) {
      const boundary = cellWidth > 1 && (x % cellWidth === 0 || y % cellWidth === 0);
      const transmission = boundary ? 1 - options.grid : 1;
      const offset = (y * size + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        const light = display[offset + channel] + (bloom?.[offset + channel] ?? 0) * options.glow;
        simulated[offset + channel] = Math.round(Math.min(255, light) * transmission);
      }
    }
  }
  return simulated;
}

function mountDisplay(display, decorations, timeline, scale, budget) {
  const frame = Buffer.from(decorations.bezel);
  const margin = MARGIN * scale;
  for (let y = 0; y < timeline.displaySize; y += 1) {
    budget?.check();
    for (let x = 0; x < timeline.displaySize; x += 1) {
      const source = (y * timeline.displaySize + x) * 4;
      const target = ((y + margin) * timeline.size + x + margin) * 4;
      const coverage = decorations.mask[source + 3] / 255;
      const background = frame[target + 3] / 255 * (1 - coverage);
      const alpha = coverage + background;
      for (let channel = 0; channel < 3; channel += 1) {
        frame[target + channel] = alpha === 0 ? 0
          : Math.round((display[source + channel] * coverage + frame[target + channel] * background) / alpha);
      }
      frame[target + 3] = Math.round(alpha * 255);
    }
  }
  return frame;
}

async function renderSampledDisplay(sharp, samples, options, budget) {
  const size = CANVAS_SIZE * options.scale;
  const display = await enlargeSamples(sharp, samples, options.pixels, size, budget);
  const bloom = await bloomSamples(sharp, display, size, options, budget);
  return simulateDisplay(display, bloom, size, options, budget);
}

async function renderFrame(sharp, frame, decorations, timeline, options, budget) {
  return withFailure('DEMO_PREVIEW_RASTER_FAILED', async () => {
    budget?.check();
    const samples = await sampleFrame(sharp, frame, options.pixels, budget);
    const simulated = await renderSampledDisplay(sharp, samples, options, budget);
    if (!decorations) return simulated;
    return mountDisplay(simulated, decorations, timeline, options.scale, budget);
  });
}

async function createDecorations(sharp, timeline, options, budget) {
  return {
    bezel: await rasterize(sharp, bezelSvg(timeline.size, options.scale), timeline.size, false, budget),
    mask: await rasterize(sharp, maskSvg(timeline.displaySize, options.scale), timeline.displaySize, false, budget),
  };
}

function validatePngInput(image, options) {
    if (!Buffer.isBuffer(image) || image.length < 1 || image.length > 262_144) fail('DEMO_PREVIEW_PNG_INPUT_INVALID');
    if (!options || typeof options !== 'object' || Array.isArray(options)) fail('DEMO_PREVIEW_PNG_OPTIONS_INVALID');
    for (const rule of Object.values(VISUAL_OPTION_RULES)) {
      const value = options[rule.name];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < rule.min || value > rule.max
        || (rule.integer && !Number.isInteger(value)) || (rule.values && !rule.values.includes(value))) {
        fail('DEMO_PREVIEW_PNG_OPTIONS_INVALID');
      }
    }
}

/** Display only, black-padded to a square; no synthetic bezel or rounded mask. */
export async function renderDisplayRaw(sharp, image, options, budget = createProcessingBudget()) {
  return withFailure('DEMO_PREVIEW_PNG_RENDER_FAILED', async () => {
    validatePngInput(image, options);
    budget.check();
    const samples = await rasterize(sharp, image, options.pixels, true, budget, 'contain');
    return renderSampledDisplay(sharp, samples, options, budget);
  });
}

/** PNG encoding of the square simulated display. */
export async function renderDisplayPng(sharp, image, options, budget = createProcessingBudget()) {
  return withFailure('DEMO_PREVIEW_PNG_RENDER_FAILED', async () => {
    const simulated = await renderDisplayRaw(sharp, image, options, budget);
    const size = CANVAS_SIZE * options.scale;
    const bytes = await sharp(simulated, { raw: { width: size, height: size, channels: 4 } })
      .png().timeout(timeout(budget, RENDER_TIMEOUT_SECONDS)).toBuffer();
    budget.check();
    if (bytes.length < 1 || bytes.length > MAX_PNG_BYTES) fail('DEMO_PREVIEW_PNG_OUTPUT_INVALID');
    return bytes;
  });
}

/** Offline PNG illustration; callers validate decoded candidates before publication. */
export async function renderPreviewPng(sharp, image, options, budget = createProcessingBudget()) {
  return withFailure('DEMO_PREVIEW_PNG_RENDER_FAILED', async () => {
    validatePngInput(image, options);
    budget.check();
    const frame = { image };
    const timeline = sizeTimeline([frame], [100], options.scale);
    const decorations = await createDecorations(sharp, timeline, options, budget);
    const pixels = await renderFrame(sharp, frame, decorations, timeline, options, budget);
    if (pixels.length !== timeline.frameBytes) fail('DEMO_PREVIEW_RASTER_INVALID');
    verifyTransparency(pixels, timeline, budget);
    const bytes = await sharp(pixels, {
      raw: { width: timeline.size, height: timeline.size, channels: 4 },
      limitInputPixels: MAX_IMAGE_PIXELS,
    }).png().timeout(timeout(budget, RENDER_TIMEOUT_SECONDS)).toBuffer();
    budget.check();
    if (bytes.length < 1 || bytes.length > MAX_PNG_BYTES) fail('DEMO_PREVIEW_PNG_OUTPUT_INVALID');
    return bytes;
  });
}

export async function encodeAnimation(sharp, timeline, options, budget) {
  const decorations = options.bezel === false ? undefined : await createDecorations(sharp, timeline, options, budget);
  let stack = Buffer.alloc(timeline.rgbaBytes);
  try {
    for (const [index, frame] of timeline.frames.entries()) {
      budget?.check();
      const pixels = await renderFrame(sharp, frame, decorations, timeline, options, budget);
      pixels.copy(stack, index * timeline.frameBytes);
    }
    const bytes = await withFailure('DEMO_PREVIEW_ENCODE_FAILED', () => sharp(stack, {
      raw: { width: timeline.size, height: timeline.size * timeline.frames.length, channels: 4, pageHeight: timeline.size },
      limitInputPixels: MAX_RGBA_BYTES / 4,
    }).gif({ delay: timeline.delays, loop: 0, keepDuplicateFrames: true })
      .timeout(timeout(budget, ANIMATION_TIMEOUT_SECONDS)).toBuffer());
    budget?.check();
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_RGBA_BYTES) fail('DEMO_PREVIEW_OUTPUT_INVALID');
    return bytes;
  } finally {
    stack = undefined;
  }
}

function verifyTransparency(data, timeline, budget) {
  const last = timeline.size - 1;
  const corners = [0, last, last * timeline.size, timeline.size * timeline.size - 1];
  const center = Math.floor(timeline.size / 2) * timeline.size + Math.floor(timeline.size / 2);
  for (let index = 0; index < timeline.frames.length; index += 1) {
    budget?.check();
    const start = index * timeline.frameBytes;
    if (corners.some(pixel => data[start + pixel * 4 + 3] !== 0)
      || data[start + center * 4 + 3] !== 255) fail('DEMO_PREVIEW_TRANSPARENCY_MISMATCH');
  }
}
