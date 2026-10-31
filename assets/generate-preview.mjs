import { Buffer } from 'node:buffer';
import { fstatSync } from 'node:fs';
import { Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import { isatty } from 'node:tty';
import { createImageLineFramer } from '../src/core/image-lines.mjs';
import {
  MAX_FRAMES, PreviewError, VISUAL_OPTION_RULES, createProcessingBudget,
  encodeAnimation, fail, renderRecord, sizeTimeline, withFailure,
} from './preview-rendering.mjs';

const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_RECORDS = 4096;
const OUTPUT_TIMEOUT_MS = 30_000;
const CAP_REACHED = Symbol('capture limit');
const OPTION_RULES = Object.freeze({
  ...VISUAL_OPTION_RULES,
  '--duration': Object.freeze({ name: 'duration', default: 60, min: 0.1, max: 120 }),
  '--fps': Object.freeze({ name: 'fps', default: undefined, min: 1, max: 100, integer: true }),
});
const HELP = `Usage: node assets/generate-preview.mjs [options] < records > preview.gif

Capture newline-delimited UTF-8 DeckForge records from stdin and emit a GIF to stdout.
This tool never launches, kills, or monitors a producer. Input and GIF output must
not be terminals. Images must be trusted; this renderer is not a sandbox.

  --scale N     Integer illustration scale, 1..3 (default: 2; 320 x 320)
  --pixels N    Sampling resolution, 72, 96, or 144 (default: 96; 3 x 3 cells at 2x)
  --grid N      Cell-boundary darkness, 0..1 (default: 0.12; 0 disables)
  --glow N      Original-color bloom, 0..1 (default: 0.18; 0 disables)
  --no-bezel    Square display only, without margin or rounded mask (144 x scale)
  --duration N  Capture limit, 0.1..120 seconds (default: 60)
  --fps N       Fixed playback rate, integer 1..100 (omit for live timing)
  --help        Static help without reading input or loading Sharp

LF and CRLF records use the production parser and strict UTF-8 framing.
Observed cumulative timestamps are rounded to 10 ms boundaries; equal boundaries
or records completed in one read are coalesced to the last accepted update.
Playback starts at the first accepted image. Final observed dwell is at least
100 ms, not an added pause. A single frame is a valid static GIF; animations loop.
With --fps, retain every accepted record, even in one read. Cumulative fixed-rate
boundaries rounded to 10 ms replace live intervals and the final hold; no frames
are synthesized. The duration limit still controls wall-clock capture.
The 144-unit canvas is logical, not a hardware pixel promise. By default, only the
exterior is transparent; --no-bezel emits an opaque square. GIF transparency is
binary, not a guarantee of soft alpha edges.

Capture ends at natural EOF or the duration cap. At the cap, an unfinished
fragment is discarded and local stdin is closed; upstream may see SIGPIPE/EPIPE.
No upstream cleanup or exit status is guaranteed. Limits: 16 MiB input, 4096
nonblank records, 512 retained frames, 512 MiB planned RGBA; overflow is an error.
Processing has a separate 120-second budget; output stalls fail after 30 seconds.
Complete encoding precedes all GIF bytes. Diagnostics go to stderr.
A transport failure after delivery starts cannot retract bytes. Shell redirection
can truncate an existing file before validation; write to a temporary destination
and publish only after success. Requires pinned development-only Sharp.
`;

function parseArguments(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const options = Object.fromEntries(Object.values(OPTION_RULES).map(rule => [rule.name, rule.default]));
  options.bezel = true;
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--no-bezel') {
      if (seen.has(argument)) fail('PREVIEW_ARGUMENTS_INVALID', 2);
      seen.add(argument);
      options.bezel = false;
      continue;
    }
    const rule = Object.hasOwn(OPTION_RULES, argument) ? OPTION_RULES[argument] : undefined;
    const text = args[++index];
    if (!rule || seen.has(argument) || typeof text !== 'string'
      || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) fail('PREVIEW_ARGUMENTS_INVALID', 2);
    seen.add(argument);
    const value = Number(text);
    if (!Number.isFinite(value) || value < rule.min || value > rule.max
      || (rule.integer && !Number.isInteger(value)) || (rule.values && !rule.values.includes(value))) {
      fail('PREVIEW_ARGUMENTS_INVALID', 2);
    }
    options[rule.name] = value;
  }
  return Object.freeze(options);
}

function ignoreErrorsUntilClose(stream) {
  if (stream.closed) return;
  const ignore = () => {};
  stream.on('error', ignore);
  stream.once('close', () => stream.off('error', ignore));
}

function stopInput(input) {
  input.pause();
  ignoreErrorsUntilClose(input);
  input.destroy();
}

function createOutput() {
  const info = fstatSync(1);
  if (info.isFIFO() || info.isSocket()) {
    // Unlike process.stdout's non-closing destroy, this CLI-owned pipe can abort I/O.
    return { stream: new Socket({ fd: 1, readable: false, writable: true }), owned: true };
  }
  return { stream: process.stdout, owned: false };
}

function captureInput(input, duration, signal) {
  return new Promise((accept, reject) => {
    const startedAt = performance.now();
    const deadline = startedAt + duration * 1000;
    const records = [];
    let inputBytes = 0;
    let chunkId = 0;
    let settled = false;
    let timer;
    let framer = createImageLineFramer({ onLine(record) {
      const arrival = performance.now();
      if (arrival >= deadline) throw CAP_REACHED;
      if (records.length >= MAX_RECORDS) fail('PREVIEW_RECORD_LIMIT');
      records.push({ record, arrival, chunkId });
    } });

    function settle(endedAt, capped, error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.off('data', onData).off('end', onEnd).off('error', onError).off('close', onClose);
      signal.removeEventListener('abort', onAbort);
      framer = undefined;
      stopInput(input);
      if (error) {
        records.length = 0;
        reject(error);
      } else accept({ records, startedAt, endedAt, capped, inputBytes });
    }

    function onData(chunk) {
      if (performance.now() >= deadline) return settle(deadline, true);
      try {
        if (!Buffer.isBuffer(chunk)) fail('PREVIEW_INPUT_INVALID');
        inputBytes += chunk.length;
        if (inputBytes > MAX_INPUT_BYTES) fail('PREVIEW_INPUT_LIMIT');
        chunkId += 1;
        framer.push(chunk);
      } catch (error) {
        if (error === CAP_REACHED) settle(deadline, true);
        else settle(performance.now(), false, error instanceof PreviewError ? error : new PreviewError('PREVIEW_PROTOCOL_FAILED'));
      }
    }

    function onEnd() {
      const endedAt = performance.now();
      if (endedAt >= deadline) return settle(deadline, true);
      try {
        framer.finish();
        settle(endedAt, false);
      } catch {
        settle(endedAt, false, new PreviewError('PREVIEW_PROTOCOL_FAILED'));
      }
    }

    function onError() { settle(performance.now(), false, new PreviewError('PREVIEW_INPUT_FAILED')); }
    function onClose() { settle(performance.now(), false, new PreviewError('PREVIEW_INPUT_FAILED')); }
    function onAbort() { settle(performance.now(), false, signal.reason); }

    timer = setTimeout(() => settle(deadline, true), duration * 1000);
    input.on('data', onData).once('end', onEnd).once('error', onError).once('close', onClose);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    else if (input.readableEnded) onEnd();
    else if (input.destroyed) onClose();
    else input.resume();
  });
}

function createTimeline(capture, options, budget) {
  const frames = [];
  const fixedRate = options.fps !== undefined;
  let firstArrival;
  let skipped = 0;
  let coalesced = 0;
  for (const { record, arrival, chunkId } of capture.records) {
    budget.check();
    const image = renderRecord(record);
    if (image === undefined) {
      skipped += 1;
      continue;
    }
    firstArrival ??= arrival;
    const boundary = fixedRate ? Math.round(frames.length * 1000 / options.fps / 10) * 10
      : Math.round((arrival - firstArrival) / 10) * 10;
    const previous = frames.at(-1);
    // Same-read updates arrive together: retain their original display boundary.
    if (!fixedRate && previous && (previous.boundary === boundary || previous.chunkId === chunkId)) {
      frames[frames.length - 1] = { ...previous, image };
      coalesced += 1;
    } else {
      if (frames.length >= MAX_FRAMES) fail('PREVIEW_FRAME_LIMIT');
      frames.push({ image, boundary, chunkId });
    }
  }
  if (frames.length === 0) fail('PREVIEW_NO_ACCEPTED_RECORDS');
  const observedEnd = Math.round((capture.endedAt - firstArrival) / 10) * 10;
  const endBoundary = fixedRate ? Math.round(frames.length * 1000 / options.fps / 10) * 10
    : Math.max(observedEnd, frames.at(-1).boundary + 100);
  const delays = frames.map((frame, index) =>
    (frames[index + 1]?.boundary ?? endBoundary) - frame.boundary);
  budget.check();
  return { ...sizeTimeline(frames, delays, options.scale, options.bezel), recordCount: capture.records.length, skipped, coalesced };
}

function outputFailure(error) {
  return new PreviewError(error?.code === 'EPIPE' ? 'PREVIEW_OUTPUT_CANCELLED' : 'PREVIEW_OUTPUT_FAILED', error?.code === 'EPIPE' ? 0 : 1);
}

function deliverOutput(output, bytes, signal) {
  return new Promise((accept, reject) => {
    let settled = false;
    let returned = false;
    let callbackDone = false;
    let drained = false;
    const timer = setTimeout(() => finish(new PreviewError('PREVIEW_OUTPUT_TIMEOUT')), OUTPUT_TIMEOUT_MS);

    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      output.off('drain', onDrain).off('error', onError).off('close', onClose);
      signal.removeEventListener('abort', onAbort);
      if (error) {
        ignoreErrorsUntilClose(output);
        output.destroy();
        reject(error);
      } else accept();
    }

    function complete() { if (returned && callbackDone && drained) finish(); }
    function onDrain() { drained = true; complete(); }
    function onError(error) { finish(outputFailure(error)); }
    function onClose() { finish(signal.aborted ? signal.reason : new PreviewError('PREVIEW_OUTPUT_FAILED')); }
    function onAbort() { finish(signal.reason); }

    output.once('drain', onDrain).once('error', onError).once('close', onClose);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) return onAbort();
    try {
      const writable = output.write(bytes, error => {
        if (error) return finish(outputFailure(error));
        callbackDone = true;
        complete();
      });
      drained = writable || drained;
      returned = true;
      complete();
    } catch (error) {
      finish(outputFailure(error));
    }
  });
}

async function main(args) {
  const options = parseArguments(args);
  if (!options.help && (process.stdin.isTTY || isatty(1))) fail('PREVIEW_TERMINAL_INVALID', 2);
  const output = createOutput();
  const controller = new AbortController();
  const onOutputError = error => controller.abort(outputFailure(error));
  output.stream.on('error', onOutputError);
  let capture;
  let timeline;
  try {
    if (options.help) return await deliverOutput(output.stream, HELP, controller.signal);
    capture = await captureInput(process.stdin, options.duration, controller.signal);
    const budget = createProcessingBudget({ signal: controller.signal });
    timeline = createTimeline(capture, options, budget);
    capture.records.length = 0;
    const sharp = await withFailure('PREVIEW_DEPENDENCY_FAILED', async () => (await import('sharp')).default);
    budget.check();
    const bytes = await encodeAnimation(sharp, timeline, options, budget);
    budget.check();
    await deliverOutput(output.stream, bytes, controller.signal);
    console.error(`PREVIEW_WRITE_OK ${timeline.recordCount} ${timeline.frames.length} ${timeline.skipped} ${timeline.coalesced} ${bytes.length}`);
  } finally {
    if (output.owned) {
      ignoreErrorsUntilClose(output.stream);
      output.stream.destroy();
    }
    output.stream.off('error', onOutputError);
    if (capture) capture.records.length = 0;
    if (timeline) timeline.frames.length = 0;
  }
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof PreviewError && error.message === 'PREVIEW_OUTPUT_CANCELLED')) {
      console.error(error instanceof PreviewError ? error.message.replace(/^DEMO_PREVIEW_/, 'PREVIEW_') : 'PREVIEW_OPERATION_FAILED');
    }
    process.exitCode = error instanceof PreviewError ? error.exitCode : 1;
  }
}
