#!/bin/bash

set -e -o pipefail
umask 077
HERO_WORK="$(node --input-type=module <<'NODE'
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
console.log(await mkdtemp(join(resolve(process.env.HERO_TMP_ROOT || tmpdir()), 'deckforge-hero-')));
NODE
)"
export HERO_WORK
printf 'Hero intermediates: %s\n' "$HERO_WORK" >&2
python3 -B demos/showcase.py | node assets/generate-preview.mjs --no-bezel --duration 120 --pixels 96 --grid 0.04 --glow 0.08 > "$HERO_WORK/showcase.gif"
/bin/bash demos/video.sh --duration 5 | node assets/generate-preview.mjs --no-bezel --fps 10 --duration 120 --pixels 96 --grid 0.04 --glow 0.08 > "$HERO_WORK/video.gif"
python3 -B demos/fluxcapacitor.py --once | node assets/generate-preview.mjs --no-bezel --fps 12 --duration 10 --pixels 96 --grid 0.04 --glow 0.08 > "$HERO_WORK/fluxcapacitor.gif"
node --input-type=module <<'NODE'
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLaunchArtwork } from './src/core/launch-artwork.mjs';
import { createTimerArtwork } from './src/core/timer-artwork.mjs';
import { createOnceArtwork } from './src/core/once-artwork.mjs';
for (const [title, extension] of [['showcase', '.py'], ['video', '.sh'], ['gif', '.py'], ['fluxcapacitor', '.py']]) {
  const image = createLaunchArtwork('ready', title, '#22d3ee', 'ready', extension);
  const svg = decodeURIComponent(image.slice('data:image/svg+xml,'.length));
  await writeFile(join(process.env.HERO_WORK, `${title}-ready.svg`), svg, { flag: 'wx' });
}
for (const [title, image] of [
  ['status', createTimerArtwork('ready', 'status', '#a78bfa', 'ready', '.py')],
  ['deploy', createOnceArtwork('ready', 'deploy', '#ffb454', 'ready', '.py')],
]) {
  const svg = decodeURIComponent(image.slice('data:image/svg+xml,'.length));
  await writeFile(join(process.env.HERO_WORK, `${title}-ready.svg`), svg, { flag: 'wx' });
}
NODE
node assets/generate-hero.mjs --output assets/hero.gif --width 520 --fps 25 --pixels 96 --grid 0.04 --glow 0.08 \
  --input "$HERO_WORK/showcase.gif" --loops 1 --processed --after "$HERO_WORK/showcase-ready.svg" \
  --input "$HERO_WORK/video.gif" --loops 4 --loop-delay 2000 --processed --after "$HERO_WORK/video-ready.svg" \
  --input demos/sample.gif --loops 9 --loop-delay 2000 --fit cover --after "$HERO_WORK/gif-ready.svg" \
  --input "$HERO_WORK/fluxcapacitor.gif" --loops 10 --processed --after "$HERO_WORK/fluxcapacitor-ready.svg" \
  --input "$HERO_WORK/status-ready.svg" --input "$HERO_WORK/deploy-ready.svg"
node --input-type=module <<'NODE'
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
const metadata = await sharp('assets/hero.gif', { animated: true, limitInputPixels: 1024 * 1024 * 1024 / 4 })
  .timeout({ seconds: 120 }).metadata();
if (metadata.format !== 'gif' || metadata.width !== 520 || metadata.pageHeight !== 376
  || !(metadata.pages > 1) || metadata.delay?.length !== metadata.pages
  || metadata.delay.some(delay => !Number.isSafeInteger(delay) || delay <= 0)) {
  throw new Error('HERO_ASSET_INVALID');
}
const sourceDurations = [];
for (const path of [join(process.env.HERO_WORK, 'showcase.gif'), join(process.env.HERO_WORK, 'video.gif'),
  'demos/sample.gif', join(process.env.HERO_WORK, 'fluxcapacitor.gif')]) {
  const source = await sharp(path, { animated: true }).timeout({ seconds: 60 }).metadata();
  if (source.format !== 'gif' || source.delay?.length !== source.pages
    || source.delay.some(delay => !Number.isSafeInteger(delay) || delay <= 0)) throw new Error('HERO_SOURCE_INVALID');
  sourceDurations.push(source.delay.reduce((total, delay) => total + delay, 0));
}
const plays = [1, 4, 9, 10], pauses = [0, 2000, 2000, 0];
const expected = Math.max(...sourceDurations.map((duration, index) =>
  duration * plays[index] + (plays[index] - 1) * pauses[index]));
const actual = metadata.delay.reduce((total, delay) => total + delay, 0);
const { size } = await stat('assets/hero.gif');
if (actual !== expected || metadata.loop !== 0 || size <= 0 || size > 1024 * 1024 * 1024) {
  throw new Error('HERO_ASSET_INVALID');
}
console.log(`HERO_ASSET_OK sources_ms=${sourceDurations.join(',')} expected_ms=${expected} actual_ms=${actual} loop=${metadata.loop} pages=${metadata.pages} bytes=${size}`);
await rm(process.env.HERO_WORK, { recursive: true });
NODE
