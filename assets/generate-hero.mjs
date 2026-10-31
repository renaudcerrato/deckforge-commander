import { randomUUID } from 'node:crypto';
import { open, rename } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEVICES, inspectOutput } from './compose-device.mjs';
import { heroInput, renderHero } from './hero-rendering.mjs';
import { PreviewError, createProcessingBudget, fail } from './preview-rendering.mjs';

const HELP = `Usage: node assets/generate-hero.mjs --output hero.gif [globals] --input source [key options] ...

Compose 1..6 trusted inputs on a Stream Deck Mini, in row-major order. Unfilled
keys stay unlit. This is an illustration, not a hardware capture. No producer is
launched. Requires pinned development-only Sharp; inputs are not sandboxed.

Globals (may appear anywhere, once each):
  --output PATH  Required .gif destination; regular files replaced only on success
  --width N      Output width, integer 1..1112 (default: 520; height: 376)
  --pixels N     Sampling resolution: 72, 96, or 144 (default: 96)
  --grid N       Cell-boundary darkness, 0..1 (default: 0.04)
  --glow N       Original-color bloom, 0..1 (default: 0.08)
  --fps N        Shared sampling rate, integer 1..100 (default: exact source timing)
  --help         Static help without reading inputs or loading Sharp

Each --input starts a key. Following modifiers belong to that key, once each:
  --input SOURCE GIF, PNG, JPEG, SVG, WebP file, or direct DeckForge protocol record
  --loops N      Total plays, positive integer (default: 1; animated GIF only)
  --loop-delay N Pause between plays in milliseconds, multiple of 10 (default: 0)
  --after SOURCE Static file/protocol during pauses and after completion (GIF main)
  --fit MODE     contain (default) or centered cover crop; main and after imagery
  --processed    Bypass pixel/grid/glow effects on the main source only

Reserved text:, card:, progress:, and data:image/ prefixes are protocol, never
file fallbacks. Prefix ambiguous filenames with ./. Commas are literal; quote
each argument as needed. Non-square images are black-padded unless --fit cover
center-crops them without stretching. Only GIF animation
is supported; single-page GIFs are static. Every animated GIF delay must be positive.
Embedded GIF loop counts are ignored. Completed sources hold their final frame
unless --after is supplied. --loop-delay is animated-GIF-only; positive values
require --after. There are N-1 pauses for N plays, with no pause after the last.
The hero ends at the longest requested playback including between-play pauses;
static-only output is one 100-ms frame. The complete hero loops forever. --fps
samples without changing source speed or natural end; timestamps use 10-ms units.

Limits: 64 MiB per encoded file (including --after), 262144-byte protocol records,
512 pages per GIF, 512 MiB planned decoded sources, 4096 planned output frames,
1 GiB planned output RGBA, and a shared 120-second processing deadline. Limits
are not native peak-memory guarantees. Overflow fails rather than shrinking or
autosampling. Browser playback of very short GIF delays may differ.
Inputs and the Mini template cannot be outputs. Encoding completes before an
exclusive staging file is written beside the output and atomically renamed.
Failed staging files are retained for diagnosis. Diagnostics never include input
content or paths. Existing outputs are not modified when rendering fails.
`;

function numeric(text, name) {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) fail('HERO_ARGUMENTS_INVALID', 2);
  const value = Number(text);
  const integer = ['width', 'pixels', 'fps', 'loops', 'loopDelay'].includes(name);
  const minimum = ['grid', 'glow', 'loopDelay'].includes(name) ? 0 : 1;
  const maximum = { width: 1112, pixels: 144, fps: 100, grid: 1, glow: 1, loops: Number.MAX_SAFE_INTEGER,
    loopDelay: Number.MAX_SAFE_INTEGER }[name];
  if (!Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isSafeInteger(value))
    || (name === 'loopDelay' && value % 10 !== 0)
    || (name === 'pixels' && ![72, 96, 144].includes(value))) fail('HERO_ARGUMENTS_INVALID', 2);
  return value;
}

export function parseHeroArguments(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const options = { width: 520, pixels: 96, grid: 0.04, glow: 0.08, inputs: [] };
  const seen = new Set();
  let current;
  let keySeen;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--processed') {
      if (!current || keySeen.has(flag)) fail('HERO_ARGUMENTS_INVALID', 2);
      keySeen.add(flag);
      current.processed = true;
      continue;
    }
    if (!['--input', '--loops', '--loop-delay', '--after', '--fit', '--output', '--width', '--pixels', '--grid', '--glow', '--fps'].includes(flag)) {
      fail('HERO_ARGUMENTS_INVALID', 2);
    }
    const value = args[++index];
    if (!value || value.startsWith('--')) fail('HERO_ARGUMENTS_INVALID', 2);
    if (flag === '--input') {
      if (options.inputs.length === 6) fail('HERO_ARGUMENTS_INVALID', 2);
      current = { input: heroInput(value) };
      keySeen = new Set();
      options.inputs.push(current);
    } else if (flag === '--loops' || flag === '--loop-delay' || flag === '--after' || flag === '--fit') {
      if (!current || keySeen.has(flag)) fail('HERO_ARGUMENTS_INVALID', 2);
      keySeen.add(flag);
      if (flag === '--fit') {
        if (!['contain', 'cover'].includes(value)) fail('HERO_ARGUMENTS_INVALID', 2);
        current.fit = value;
      } else if (flag === '--loop-delay') current.loopDelay = numeric(value, 'loopDelay');
      else current[flag.slice(2)] = flag === '--after' ? heroInput(value) : numeric(value, 'loops');
    } else {
      if (seen.has(flag)) fail('HERO_ARGUMENTS_INVALID', 2);
      seen.add(flag);
      const name = flag.slice(2);
      options[name] = name === 'output' ? resolve(value) : numeric(value, name);
    }
  }
  if (!options.output || extname(options.output).toLowerCase() !== '.gif' || options.inputs.length === 0) {
    fail('HERO_ARGUMENTS_INVALID', 2);
  }
  return options;
}

async function publish(output, bytes, protectedPaths, budget) {
  budget.check();
  const temporary = resolve(dirname(output), `.deckforge-hero-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes); }
  finally { await handle.close(); }
  await inspectOutput(output, protectedPaths);
  budget.check();
  await rename(temporary, output);
}

async function main(args) {
  const options = parseHeroArguments(args);
  if (options.help) { console.log(HELP); return; }
  const protectedPaths = [
    fileURLToPath(new URL(`./${DEVICES.mini.template}`, import.meta.url)),
    ...options.inputs.flatMap(input => [input.input.path, input.after?.path].filter(Boolean)),
  ];
  const budget = createProcessingBudget();
  await inspectOutput(options.output, protectedPaths);
  const sharp = (await import('sharp')).default;
  const bytes = await renderHero(sharp, options, budget);
  await publish(options.output, bytes, protectedPaths, budget);
  console.log('HERO_WRITE_OK');
}

if (import.meta.main) {
  try { await main(process.argv.slice(2)); }
  catch (error) {
    console.error(error instanceof PreviewError ? error.message : 'HERO_OPERATION_FAILED');
    process.exitCode = error instanceof PreviewError ? error.exitCode : 1;
  }
}
