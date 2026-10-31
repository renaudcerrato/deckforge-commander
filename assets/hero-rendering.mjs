import { Buffer } from 'node:buffer';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  createProcessingBudget, fail, renderDisplayRaw, renderRecord, withFailure,
} from './preview-rendering.mjs';
import {
  APERTURE, DEVICES, apertureMask, blendKey, decodeDeviceTemplate,
} from './compose-device.mjs';

export const MAX_HERO_INPUT_BYTES = 64 * 1024 * 1024;
export const MAX_HERO_SOURCE_BYTES = 512 * 1024 * 1024;
export const MAX_HERO_FRAMES = 4096;
export const MAX_HERO_RGBA_BYTES = 1024 * 1024 * 1024;
const MAX_SOURCE_PAGES = 512;
const MAX_GIF_DELAY = 655_350;
// Sharp's explicit delay option is narrower than GIF's stored centisecond field.
const MAX_ENCODER_DELAY = 65_530;

/** Reserved protocol prefixes never fall back to file lookup. Use ./ for ambiguous names. */
export function heroInput(value) {
  return /^(?:text:|card:|progress:|data:image\/)/.test(value)
    ? { record: value } : { path: resolve(value) };
}

async function inputBytes(input) {
  if (input.record !== undefined) {
    if (Buffer.byteLength(input.record, 'utf8') > 262_144) fail('HERO_PROTOCOL_LIMIT');
    const image = renderRecord(input.record);
    if (!image) fail('HERO_PROTOCOL_INVALID');
    return image;
  }
  const handle = await open(input.path, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > MAX_HERO_INPUT_BYTES) fail('HERO_INPUT_LIMIT');
    const bytes = await handle.readFile();
    if (bytes.length < 1 || bytes.length > MAX_HERO_INPUT_BYTES) fail('HERO_INPUT_LIMIT');
    return bytes;
  } finally { await handle.close(); }
}

// Sharp can read the first APNG frame without exposing its animation as pages.
function isAnimatedPng(bytes) {
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) break;
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (type === 'acTL') return true;
    if (type === 'IEND') break;
    offset += length + 12;
  }
  return false;
}

// Walk GIF89a blocks, not compressed bytes: metadata may invent missing delays.
function storedGifDelays(bytes, pages, budget) {
  let offset = 0;
  function advance(length) {
    budget.check();
    if (length > bytes.length - offset) fail('HERO_TIMING_INVALID');
    const start = offset;
    offset += length;
    return start;
  }
  function byte() { return bytes[advance(1)]; }
  function skipSubBlocks() {
    for (let length = byte(); length !== 0; length = byte()) advance(length);
  }
  function skipColorTable(packed) {
    if (packed & 0x80) advance(3 * 2 ** ((packed & 7) + 1));
  }
  advance(13);
  if (!['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) fail('HERO_TIMING_INVALID');
  skipColorTable(bytes[10]);
  const delays = [];
  let pendingDelay;
  for (;;) {
    const marker = byte();
    if (marker === 0x3b) {
      if (delays.length !== pages) fail('HERO_TIMING_INVALID');
      return delays;
    }
    if (marker === 0x2c) {
      advance(9);
      skipColorTable(bytes[offset - 1]);
      advance(1); // LZW minimum code size; decoding remains Sharp's responsibility.
      skipSubBlocks();
      if (pendingDelay === undefined || pendingDelay <= 0 || delays.length >= pages) fail('HERO_TIMING_INVALID');
      delays.push(pendingDelay);
      pendingDelay = undefined;
    } else if (marker === 0x21) {
      const label = byte();
      if (label === 0xf9) {
        if (pendingDelay !== undefined || byte() !== 4) fail('HERO_TIMING_INVALID');
        const start = advance(4);
        pendingDelay = bytes.readUInt16LE(start + 1) * 10;
        if (byte() !== 0) fail('HERO_TIMING_INVALID');
      } else {
        skipSubBlocks();
        // Plain text is a rendering block and consumes the preceding GCE.
        if (label === 0x01) pendingDelay = undefined;
      }
    } else fail('HERO_TIMING_INVALID');
  }
}

async function inspectSource(sharp, input, budget, accounting) {
  budget.check();
  const bytes = await inputBytes(input);
  const metadata = await sharp(bytes, { animated: true, limitInputPixels: MAX_HERO_SOURCE_BYTES / 4 })
    .timeout({ seconds: budget.timeout(60) }).metadata();
  budget.check();
  const pages = metadata.pages ?? 1;
  if (!['gif', 'png', 'jpeg', 'svg', 'webp'].includes(metadata.format)
    || (metadata.format === 'png' && isAnimatedPng(bytes))
    || !Number.isSafeInteger(pages) || pages < 1 || pages > MAX_SOURCE_PAGES
    || (pages > 1 && metadata.format !== 'gif')) fail('HERO_FORMAT_UNSUPPORTED');
  const width = metadata.width;
  const height = pages > 1 ? metadata.pageHeight : metadata.height;
  const rgbaBytes = width * height * pages * 4;
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1
    || !Number.isSafeInteger(rgbaBytes) || rgbaBytes < 1
    || rgbaBytes > MAX_HERO_SOURCE_BYTES - accounting.bytes) fail('HERO_SOURCE_MEMORY_LIMIT');
  accounting.bytes += rgbaBytes;
  const delays = pages > 1 ? storedGifDelays(bytes, pages, budget) : [];
  if (pages > 1 && (!Array.isArray(metadata.delay) || metadata.delay.length !== pages
    || delays.some((delay, index) => !Number.isSafeInteger(delay) || delay <= 0 || delay % 10 !== 0
      || delay > MAX_GIF_DELAY || delay !== metadata.delay[index]))) {
    fail('HERO_TIMING_INVALID');
  }
  const starts = [];
  let duration = 0;
  for (const delay of delays) { starts.push(duration); duration += delay; }
  return { bytes, width, height, pages, rgbaBytes, starts, duration };
}

/** Inspect every main/after source before decoding any full pixel stack. */
export async function inspectHeroSources(sharp, inputs, budget) {
  const accounting = { bytes: 0 };
  const sources = [];
  for (const input of inputs) {
    const source = await inspectSource(sharp, input.input, budget, accounting);
    if (source.pages === 1 && (input.loops !== undefined || input.after !== undefined || input.loopDelay !== undefined)) {
      fail('HERO_ANIMATION_MODIFIER_INVALID');
    }
    source.plays = input.loops ?? 1;
    source.loopDelay = input.loopDelay ?? 0;
    if (!Number.isSafeInteger(source.loopDelay) || source.loopDelay < 0 || source.loopDelay % 10 !== 0) fail('HERO_TIMING_INVALID');
    if (source.loopDelay > 0 && input.after === undefined) fail('HERO_ANIMATION_MODIFIER_INVALID');
    // With one play the requested pause is unused, including in period arithmetic.
    source.period = source.duration + (source.plays > 1 ? source.loopDelay : 0);
    const playback = source.duration * source.plays;
    const pauses = (source.plays - 1) * source.loopDelay;
    source.end = playback + pauses;
    if (![source.period, playback, pauses, source.end].every(Number.isSafeInteger)) fail('HERO_TIMING_INVALID');
    source.processed = input.processed ?? false;
    source.fit = input.fit ?? 'contain';
    if (input.after !== undefined) {
      source.after = await inspectSource(sharp, input.after, budget, accounting);
      if (source.after.pages !== 1) fail('HERO_AFTER_ANIMATED');
      source.after.fit = source.fit;
    }
    sources.push(source);
  }
  return sources;
}

/** Exact change boundaries, or a shared sampling clock, with the natural end retained. */
export function planHeroTimeline(sources, options) {
  const end = Math.max(100, ...sources.map(source => source.end));
  // Animated sources, even those shorter than 100 ms, define their own natural end.
  const duration = sources.some(source => source.pages > 1) ? Math.max(...sources.map(source => source.end)) : end;
  if (!Number.isSafeInteger(duration) || duration <= 0) fail('HERO_TIMING_INVALID');
  const boundaries = new Set([0, duration]);
  function add(time) {
    if (time > 0 && time < duration) boundaries.add(time);
    if (boundaries.size > MAX_HERO_FRAMES + 1) fail('HERO_FRAME_LIMIT');
  }
  if (options.fps !== undefined) {
    const count = Math.ceil(duration * options.fps / 1000);
    // At most one sample can round onto the excluded natural-end boundary.
    if (!Number.isSafeInteger(count) || count > MAX_HERO_FRAMES + 1) fail('HERO_FRAME_LIMIT');
    for (let index = 1; index < count; index += 1) add(Math.round(index * 1000 / options.fps / 10) * 10);
  } else {
    for (const source of sources) {
      if (source.pages === 1) continue;
      for (let play = 0; play < source.plays; play += 1) {
        const playStart = play * (source.period ?? source.duration);
        for (const start of source.starts) add(playStart + start);
        if (source.loopDelay > 0 && play < source.plays - 1) add(playStart + source.duration);
      }
      add(source.end);
    }
  }
  const times = [...boundaries].sort((a, b) => a - b);
  const holds = times.slice(1).map((time, index) => time - times[index]);
  if (holds.some(delay => !Number.isSafeInteger(delay) || delay <= 0 || delay % 10 !== 0)) {
    fail('HERO_TIMING_INVALID');
  }
  // Long pauses need physical duplicate frames even when an FPS clock subdivides them.
  const preserveHoldChunks = holds.some(hold => hold > MAX_GIF_DELAY)
    || sources.some(source => source.plays > 1 && source.loopDelay > MAX_GIF_DELAY);
  const encodingTimes = [];
  const delays = [];
  for (const [index, hold] of holds.entries()) {
    if (Math.ceil(hold / MAX_ENCODER_DELAY) > MAX_HERO_FRAMES - delays.length) fail('HERO_FRAME_LIMIT');
    for (let remaining = hold; remaining > 0;) {
      const delay = Math.min(remaining, MAX_ENCODER_DELAY);
      encodingTimes.push(times[index]);
      delays.push(delay);
      remaining -= delay;
    }
  }
  const width = options.width;
  const height = Math.round(DEVICES.mini.height * width / DEVICES.mini.width);
  const frameBytes = width * height * 4;
  const rgbaBytes = frameBytes * delays.length;
  if (!Number.isSafeInteger(rgbaBytes) || rgbaBytes > MAX_HERO_RGBA_BYTES) fail('HERO_OUTPUT_MEMORY_LIMIT');
  return { times: encodingTimes, delays, duration, width, height, frameBytes, rgbaBytes, preserveHoldChunks };
}

function verifyPixels(result, width, height) {
  if (result.info.width !== width || result.info.height !== height || result.info.channels !== 4
    || !Buffer.isBuffer(result.data) || result.data.length !== width * height * 4) fail('HERO_RASTER_INVALID');
  return result.data;
}

async function prepareSurface(sharp, pixels, source, processed, options, budget) {
  const raw = { width: source.width, height: source.height, channels: 4 };
  if (processed) {
    const result = await sharp(pixels, { raw }).resize(APERTURE, APERTURE, { fit: source.fit, background: '#000000' })
      .flatten({ background: '#000000' }).ensureAlpha().raw()
      .timeout({ seconds: budget.timeout(60) }).toBuffer({ resolveWithObject: true });
    return verifyPixels(result, APERTURE, APERTURE);
  }
  // Normalize once per distinct source frame at the intended sampling resolution.
  // This keeps the existing display helper's protocol-size contract unchanged.
  const normalized = await sharp(pixels, { raw })
    .resize(options.pixels, options.pixels, { fit: source.fit, background: '#000000' })
    .flatten({ background: '#000000' }).png().timeout({ seconds: budget.timeout(60) }).toBuffer();
  const display = await renderDisplayRaw(sharp, normalized, { ...options, scale: 2 }, budget);
  const result = await sharp(display, { raw: { width: 288, height: 288, channels: 4 } })
    .resize(APERTURE, APERTURE, { kernel: 'nearest' }).raw()
    .timeout({ seconds: budget.timeout(60) }).toBuffer({ resolveWithObject: true });
  return verifyPixels(result, APERTURE, APERTURE);
}

async function prepareSource(sharp, source, processed, options, budget) {
  budget.check();
  const decoded = await sharp(source.bytes, { animated: true, limitInputPixels: MAX_HERO_SOURCE_BYTES / 4 })
    .ensureAlpha().raw().timeout({ seconds: budget.timeout(60) }).toBuffer({ resolveWithObject: true });
  const pixels = verifyPixels(decoded, source.width, source.height * source.pages);
  source.bytes = undefined;
  const frameBytes = source.width * source.height * 4;
  source.surfaces = [];
  for (let index = 0; index < source.pages; index += 1) {
    budget.check();
    source.surfaces.push(await prepareSurface(sharp, pixels.subarray(index * frameBytes, (index + 1) * frameBytes),
      source, processed, options, budget));
  }
}

function surfaceAt(source, time) {
  if (source.pages === 1) return source.surfaces[0];
  if (time >= source.end) return source.after?.surfaces[0] ?? source.surfaces.at(-1);
  const local = time % (source.period ?? source.duration);
  if (local >= source.duration) return source.after.surfaces[0];
  let index = source.starts.length - 1;
  while (index > 0 && source.starts[index] > local) index -= 1;
  return source.surfaces[index];
}

/** Compose trusted sources without launching any producer or user program. */
export async function renderHero(sharp, options, budget = createProcessingBudget()) {
  return withFailure('HERO_RENDER_FAILED', async () => {
    const sources = await inspectHeroSources(sharp, options.inputs, budget);
    const timeline = planHeroTimeline(sources, options);
    for (const source of sources) {
      await prepareSource(sharp, source, source.processed, options, budget);
      if (source.after) await prepareSource(sharp, source.after, false, options, budget);
    }
    const device = DEVICES.mini;
    const template = await decodeDeviceTemplate(sharp, device, budget);
    const mask = await apertureMask(sharp, budget);
    const stack = Buffer.alloc(timeline.rgbaBytes);
    for (const [index, time] of timeline.times.entries()) {
      budget.check();
      if (index > 0 && timeline.times[index - 1] === time) {
        // Encoding-only hold chunks reuse exactly the same composed pixels.
        stack.copy(stack, index * timeline.frameBytes, (index - 1) * timeline.frameBytes, index * timeline.frameBytes);
        continue;
      }
      const frame = Buffer.from(template);
      for (const [key, source] of sources.entries()) blendKey(frame, surfaceAt(source, time), mask, device, key, budget);
      const resized = await sharp(frame, { raw: { width: device.width, height: device.height, channels: 4 } })
        .resize(timeline.width, timeline.height).raw().timeout({ seconds: budget.timeout(60) })
        .toBuffer({ resolveWithObject: true });
      verifyPixels(resized, timeline.width, timeline.height).copy(stack, index * timeline.frameBytes);
    }
    const bytes = await sharp(stack, {
      raw: { width: timeline.width, height: timeline.height * timeline.times.length, channels: 4, pageHeight: timeline.height },
      limitInputPixels: MAX_HERO_RGBA_BYTES / 4,
    }).gif({ delay: timeline.delays, loop: 0, ...(timeline.preserveHoldChunks ? { keepDuplicateFrames: true } : {}) })
      .timeout({ seconds: budget.timeout(120) }).toBuffer();
    budget.check();
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_HERO_RGBA_BYTES) fail('HERO_OUTPUT_INVALID');
    return bytes;
  });
}
