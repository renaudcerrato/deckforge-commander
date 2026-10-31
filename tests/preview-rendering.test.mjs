import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import {
  MAX_FRAMES, MAX_RGBA_BYTES, PreviewError, createProcessingBudget, encodeAnimation,
  renderDisplayPng, renderDisplayRaw, sizeTimeline,
} from '../assets/preview-rendering.mjs';

// Explicitly approved asset-renderer coverage: tiny synthetic frames only, no
// demo producers, repository asset writes, or production post-encode validator.
const testOptions = { timeout: 20000 };
const visualOptions = { scale: 1, pixels: 72, grid: 0, glow: 0 };
function solidFrame(color) {
  return { image: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><rect width="144" height="144" fill="${color}"/></svg>`) };
}

for (const duplicate of [false, true]) {
  test(`GIF preserves timing, alpha and ${duplicate ? 'duplicate' : 'distinct'} frames`, testOptions, async () => {
    // Arrange: nonuniform delays expose lost or merged frames.
    const timeline = sizeTimeline([solidFrame('red'), solidFrame(duplicate ? 'red' : 'blue')], [70, 130], 1);
    // Act: the real encoder is the subject; decoding belongs only in this test.
    const bytes = await encodeAnimation(sharp, timeline, visualOptions, createProcessingBudget());
    const metadata = await sharp(bytes, { animated: true }).metadata();
    const decoded = await sharp(bytes, { animated: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    // Assert: GIF quantization need not preserve exact RGB values.
    assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0);
    assert.equal(metadata.format, 'gif');
    assert.equal(metadata.width, 160);
    assert.equal(metadata.pageHeight, 160);
    assert.equal(metadata.pages, 2);
    assert.deepEqual(metadata.delay, [70, 130]);
    assert.equal(metadata.loop, 0);
    assert.equal(decoded.info.channels, 4);
    assert.equal(decoded.data.length, 160 * 160 * 4 * 2);
    const centers = [];
    for (const frame of [0, 1]) {
      const start = frame * 160 * 160 * 4;
      for (const [x, y] of [[0, 0], [159, 0], [0, 159], [159, 159]]) {
        assert.equal(decoded.data[start + (y * 160 + x) * 4 + 3], 0);
      }
      const center = start + (80 * 160 + 80) * 4;
      assert.equal(decoded.data[center + 3], 255);
      centers.push([...decoded.data.subarray(center, center + 3)]);
    }
    assert.ok(centers[0][0] > centers[0][2]);
    if (duplicate) assert.deepEqual(centers[1], centers[0]);
    else assert.ok(centers[1][2] > centers[1][0]);
  });
}

test('GIF rejects malformed source images with the fixed raster diagnostic', testOptions, async () => {
  // Arrange
  const frames = [{ image: Buffer.from('not an image') }];
  // Act / Assert: native decoder details must not escape the renderer boundary.
  for (const bezel of [true, false]) {
    const timeline = sizeTimeline(frames, [100], 1, bezel);
    await assert.rejects(encodeAnimation(sharp, timeline, { ...visualOptions, bezel }, createProcessingBudget()), {
      name: 'Error', message: 'DEMO_PREVIEW_RASTER_FAILED',
    });
  }
});

test('display-only GIF fills its square without bezel, margin or rounded corners', testOptions, async () => {
  // Arrange: duplicate frames and unequal delays must survive this rendering mode.
  const options = { ...visualOptions, scale: 2, bezel: false };
  const delays = [30, 70, 130];
  const timeline = sizeTimeline([solidFrame('red'), solidFrame('red'), solidFrame('blue')], delays, 2, false);
  // Act
  const bytes = await encodeAnimation(sharp, timeline, options, createProcessingBudget());
  const metadata = await sharp(bytes, { animated: true }).metadata();
  const decoded = await sharp(bytes, { animated: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  // Assert: even edge and corner pixels are producer color, not synthetic glass.
  assert.equal(metadata.width, 288);
  assert.equal(metadata.pageHeight, 288);
  assert.equal(metadata.pages, 3);
  assert.equal(metadata.loop, 0);
  assert.deepEqual(metadata.delay, delays);
  assert.equal(decoded.data.length, 288 * 288 * 4 * 3);
  for (let index = 3; index < decoded.data.length; index += 4) assert.equal(decoded.data[index], 255);
  for (const frame of [0, 1, 2]) {
    for (const [x, y] of [[0, 0], [287, 0], [0, 287], [287, 287], [0, 144], [144, 144]]) {
      const offset = (frame * 288 * 288 + y * 288 + x) * 4;
      const [red, green, blue] = decoded.data.subarray(offset, offset + 3);
      assert.ok(frame === 2 ? blue > 240 && red < 15 && green < 15 : red > 240 && green < 15 && blue < 15);
    }
  }
});

test('raw and PNG display rendering share opaque black padding, grid and glow', testOptions, async () => {
  // Arrange: a non-square source exposes padding; a midtone exposes bloom/clipping.
  const image = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="144" height="72"><rect width="144" height="72" fill="#804020"/></svg>');
  const options = { ...visualOptions, grid: 0.25, glow: 0.1 };
  // Act
  const raw = await renderDisplayRaw(sharp, image, options);
  const png = await renderDisplayPng(sharp, image, options);
  const decoded = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  // Assert: the raw entry point is the same display, not a bezel or PNG artifact.
  assert.equal(decoded.info.width, 144);
  assert.equal(decoded.info.height, 144);
  assert.equal(decoded.info.channels, 4);
  assert.deepEqual(raw, decoded.data);
  assert.deepEqual([...raw.subarray(0, 4)], [0, 0, 0, 255]);
  assert.deepEqual([...raw.subarray(raw.length - 4)], [0, 0, 0, 255]);
  for (let index = 3; index < raw.length; index += 4) assert.equal(raw[index], 255);
  const boundary = (72 * 144 + 72) * 4;
  const interior = (73 * 144 + 73) * 4;
  assert.ok(raw[interior] > 128, 'glow increases the midtone brightness');
  assert.ok(raw[boundary] < raw[interior], 'grid darkens cell boundaries');
});

test('raw display rendering rejects invalid input, options and undecodable artwork', testOptions, async () => {
  // Arrange
  const cases = [
    [Buffer.alloc(0), visualOptions, 'DEMO_PREVIEW_PNG_INPUT_INVALID'],
    [solidFrame('red').image, { ...visualOptions, grid: 2 }, 'DEMO_PREVIEW_PNG_OPTIONS_INVALID'],
    [Buffer.from('not an image'), visualOptions, 'DEMO_PREVIEW_RASTER_FAILED'],
  ];
  // Act / Assert: validation and decoder failures retain their fixed diagnostics.
  for (const [image, options, message] of cases) {
    await assert.rejects(renderDisplayRaw(sharp, image, options), { message });
  }
});

test('timeline plans bounded RGBA storage and accepts the frame-count boundary', () => {
  // Arrange: planning uses references, not hundreds of allocated raster frames.
  const frames = Array.from({ length: MAX_FRAMES }, () => ({}));
  const delays = Array(MAX_FRAMES).fill(100);
  // Act
  const timeline = sizeTimeline(frames, delays, 3);
  // Assert
  assert.equal(timeline.size, 480);
  assert.equal(timeline.displaySize, 432);
  assert.equal(timeline.frameBytes, 480 * 480 * 4);
  assert.equal(timeline.rgbaBytes, 480 * 480 * 4 * MAX_FRAMES);
});

test('timeline rejects empty, excessive, mismatched and invalid-scale plans before allocation', () => {
  // Arrange
  const excessive = Array(MAX_FRAMES + 1).fill({});
  const cases = [
    [[], [], 1, 'DEMO_PREVIEW_FRAME_LIMIT'],
    [excessive, Array(excessive.length).fill(100), 1, 'DEMO_PREVIEW_FRAME_LIMIT'],
    [[{}], [], 1, 'DEMO_PREVIEW_FRAME_LIMIT'],
    [[{}], [100], 4, 'DEMO_PREVIEW_OPTIONS_INVALID'],
  ];
  // Act / Assert
  for (const [frames, delays, scale, message] of cases) {
    assert.throws(() => sizeTimeline(frames, delays, scale), { message });
  }
});

test('display-only sizing saves storage without increasing the 512-frame or 512-MiB limits', () => {
  // Arrange: no raster allocation is needed to exercise the maximum valid plan.
  const frames = Array(512).fill({});
  const delays = Array(512).fill(100);
  // Act
  const timeline = sizeTimeline(frames, delays, 3, false);
  // Assert: only geometry changes, not the shared safety limits.
  assert.equal(timeline.size, 432);
  assert.equal(timeline.displaySize, 432);
  assert.equal(timeline.frameBytes, 432 * 432 * 4);
  assert.equal(timeline.rgbaBytes, 432 * 432 * 4 * 512);
  assert.equal(MAX_RGBA_BYTES, 512 * 1024 * 1024);
  assert.ok(timeline.rgbaBytes <= MAX_RGBA_BYTES);
  assert.throws(() => sizeTimeline([...frames, {}], [...delays, 100], 3, false), { message: 'DEMO_PREVIEW_FRAME_LIMIT' });
  assert.throws(() => sizeTimeline([{}], [100], 1, 'false'), { message: 'DEMO_PREVIEW_OPTIONS_INVALID' });
});

test('GIF respects an already-cancelled processing budget', testOptions, async () => {
  // Arrange: pre-abort avoids sleeps and deadline races.
  const controller = new AbortController();
  const reason = new PreviewError('DEMO_PREVIEW_PROCESSING_TIMEOUT');
  controller.abort(reason);
  const budget = createProcessingBudget({ signal: controller.signal });
  const timeline = sizeTimeline([solidFrame('red')], [100], 1);
  // Act / Assert
  await assert.rejects(encodeAnimation(sharp, timeline, visualOptions, budget), error => error === reason);
});

test('preview CLI delivers a complete two-frame GIF from synthetic stdin', testOptions, async () => {
  // Arrange: only this owned Node child runs; output stays in bounded memory.
  const args = ['assets/generate-preview.mjs', '--fps', '10', '--scale', '1', '--grid', '0', '--glow', '0'];
  // Act
  const result = spawnSync(process.execPath, args, {
    input: 'first synthetic frame\nsecond synthetic frame\n', timeout: 15000, maxBuffer: 1024 * 1024,
  });
  // Assert
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(result.signal, null);
  assert.match(result.stderr.toString(), /^PREVIEW_WRITE_OK 2 2 0 0 \d+\n$/);
  const metadata = await sharp(result.stdout, { animated: true }).metadata();
  assert.equal(metadata.format, 'gif');
  assert.equal(metadata.width, 160);
  assert.equal(metadata.pages, 2);
  assert.deepEqual(metadata.delay, [100, 100]);
});

test('preview CLI emits no GIF bytes when synthetic input fails framing', testOptions, () => {
  // Arrange: invalid UTF-8 is a fatal input error, not a skipped protocol record.
  const input = Buffer.from([0xff, 0x0a]);
  // Act
  const result = spawnSync(process.execPath, ['assets/generate-preview.mjs', '--fps', '10'], {
    input, timeout: 15000, maxBuffer: 1024 * 1024,
  });
  // Assert
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stdout.length, 0);
  assert.equal(result.stderr.toString(), 'PREVIEW_PROTOCOL_FAILED\n');
});

for (const fixedRate of [false, true]) {
  test(`display-only CLI preserves ${fixedRate ? 'explicit FPS' : 'live same-read coalescing'} timing`, testOptions, async () => {
    // Arrange: one small stdin write contains two accepted protocol records.
    const args = ['assets/generate-preview.mjs', '--no-bezel', '--scale', '1', '--grid', '0', '--glow', '0'];
    if (fixedRate) args.push('--fps', '25');
    // Act
    const result = spawnSync(process.execPath, args, {
      input: 'first synthetic frame\nsecond synthetic frame\n', timeout: 15000, maxBuffer: 1024 * 1024,
    });
    // Assert: absence of --fps must not silently turn capture into fixed-rate playback.
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr.toString());
    assert.equal(result.signal, null);
    const metadata = await sharp(result.stdout, { animated: true }).metadata();
    assert.equal(metadata.format, 'gif');
    assert.equal(metadata.width, 144);
    assert.equal(metadata.height, 144 * (fixedRate ? 2 : 1));
    assert.equal(metadata.pages ?? 1, fixedRate ? 2 : 1);
    assert.deepEqual(metadata.delay, fixedRate ? [40, 40] : [100]);
  });
}

test('preview CLI rejects duplicate, valued and unsupported display flags before emitting GIF bytes', testOptions, () => {
  // Arrange: --no-bezel is argument-free, singular, and not an alias for other flags.
  const cases = [['--no-bezel', '--no-bezel'], ['--no-bezel', 'false'], ['--bezel']];
  // Act / Assert
  for (const args of cases) {
    const result = spawnSync(process.execPath, ['assets/generate-preview.mjs', ...args], {
      input: 'synthetic frame\n', timeout: 15000, maxBuffer: 1024 * 1024,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 2);
    assert.equal(result.signal, null);
    assert.equal(result.stdout.length, 0);
    assert.equal(result.stderr.toString(), 'PREVIEW_ARGUMENTS_INVALID\n');
  }
});
