import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { lstat, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createSlideKeyArtwork } from './slide-key-artwork.mjs';

const ASSETS = dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);
const OUTPUTS = ['slide-01-phosphor.png', 'slide-02-output-canvas.png', 'slide-03-command-desk.png'];
const HELP = `Usage: node assets/generate-slides.mjs --write

Generate three 1920x960 advertising illustrations using the supplied device
templates and slide-camera.png. Replace only the three fixed slide PNGs after
all three decode successfully. Symlink/nonregular outputs are rejected.
Invocation-owned intermediates and half-size review images are retained in
assets/.slide-preview-*. No monitoring programs are run.
`;
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const text = (x, y, value, size, color, extra = '') => `<text x="${x}" y="${y}" font-family="Arial, sans-serif" font-size="${size}" fill="${color}" ${extra}>${escape(value)}</text>`;
const headline = (x, y, lines, size, color, leading) => lines.map((line, index) => text(x, y + index * leading, line, size, color, 'font-weight="700" letter-spacing="-5"')).join('');
const brand = (x, color) => text(x, 76, 'DECKFORGE COMMANDER', 20, color, 'font-weight="700" letter-spacing="3"');

function deviceImage(bytes, x, y, width, height, angle) {
  const image = `<image x="${x}" y="${y}" width="${width}" height="${height}" href="data:image/png;base64,${bytes.toString('base64')}"/>`;
  const rotation = `rotate(${angle} ${x + width / 2} ${y + height / 2})`;
  return `<g transform="translate(0 28)" opacity=".55" filter="url(#shadow)"><g transform="${rotation}">${image}</g></g><g transform="${rotation}">${image}</g>`;
}

function slideSvg(index, device) {
  const shadow = '<filter id="shadow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="24"/><feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"/></filter>';
  const wash = '<radialGradient id="wash" cx=".82" cy=".48" r=".65"><stop stop-color="' + (index === 0 ? '#17432e' : '#30234d') + '" stop-opacity=".55"/><stop offset="1" stop-opacity="0"/></radialGradient>';
  let content;
  if (index === 0) {
    content = brand(115, '#a4bbab')
      + headline(115, 272, ['Your scripts.', 'Your keys.', 'Live.'], 124, '#edf5ec', 135)
      + text(119, 654, 'Turn program output into text,', 30, '#a9b9ae')
      + text(119, 698, 'progress, and images.', 30, '#a9b9ae')
      + deviceImage(device, 930, 102, 1094, 791, -7);
  } else if (index === 1) {
    content = brand(108, '#b2acc7')
      + headline(108, 270, ['Small output.', 'Big possibilities.'], 102, '#f0edf8', 122)
      + '<rect x="112" y="456" width="422" height="58" rx="29" fill="#252032"/>'
      + text(138, 493, 'stdout → your Stream Deck', 24, '#d5c8ed', 'style="font-family:monospace"')
      + text(112, 592, 'Text. Progress. Images.', 30, '#b6adc7')
      + text(112, 636, 'Make every key your own.', 30, '#b6adc7')
      + deviceImage(device, 1020, 209, 998, 722, 5);
  } else {
    content = brand(96, '#56665e')
      + headline(96, 250, ['Run it.', 'See it.', 'Control it.'], 115, '#192925', 122)
      + text(100, 586, 'Your programs, one key away.', 30, '#56665e')
      + [['Stream', '#16798a', '#cfe5e6', 100, 142], ['Loop', '#73569a', '#e1d9ed', 258, 120], ['Run', '#9a6529', '#eadbc6', 394, 108]].map(([name, color, fill, x, width]) => `<rect x="${x}" y="682" width="${width}" height="52" rx="26" fill="${fill}"/>` + text(x + 24, 716, name, 24, color, 'font-weight="600"')).join('')
      + deviceImage(device, 825, 70, 1171, 832, -4);
  }
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="960" viewBox="0 0 1920 960"><defs>${shadow}${wash}</defs><rect width="1920" height="960" fill="${['#080e0c', '#0d0d16', '#ede9df'][index]}"/>${index < 2 ? '<rect width="1920" height="960" fill="url(#wash)"/>' : ''}${content}</svg>`);
}

async function inspectOutput(output) {
  try {
    const info = await lstat(output);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('SLIDE_OUTPUT_INVALID');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export async function writeSlides(sharp) {
  const info = await lstat(ASSETS);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('SLIDE_ASSETS_DIRECTORY_INVALID');
  const outputs = OUTPUTS.map(name => resolve(ASSETS, name));
  for (const output of outputs) await inspectOutput(output);
  const directory = await mkdtemp(resolve(ASSETS, '.slide-preview-'));
  const artwork = {};
  for (const [name, bytes] of Object.entries(createSlideKeyArtwork())) {
    artwork[name] = resolve(directory, `${name}.svg`);
    await writeFile(artwork[name], bytes, { flag: 'wx' });
  }
  const devices = [
    ['mini', [artwork.cpu, artwork.ssd, artwork.memory, artwork.gpu, artwork.network, artwork.battery]],
    ['mini', [resolve(ASSETS, 'slide-camera.png'), artwork.api, artwork.latency, artwork.tls, artwork.build, artwork.http]],
    ['mk2', [artwork.backup, artwork.stream, artwork.loop, artwork.run, artwork.queue, artwork.tests, artwork.coverage, artwork.duration, artwork.lint, artwork.scan, artwork.commit, artwork.artifacts, artwork.deploy, artwork.sync, artwork.exit]],
  ];
  const candidates = [];
  for (const [index, [device, keys]] of devices.entries()) {
    const composed = resolve(directory, `device-${index + 1}.png`);
    await run(process.execPath, [resolve(ASSETS, 'compose-device.mjs'), '--device', device, '--output', composed, ...keys], { timeout: 120_000 });
    const bytes = await sharp(slideSvg(index, await readFile(composed))).png().toBuffer();
    const decoded = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
    if (decoded.info.width !== 1920 || decoded.info.height !== 960) throw new Error('SLIDE_DIMENSIONS_INVALID');
    const candidate = resolve(directory, OUTPUTS[index]);
    await writeFile(candidate, bytes, { flag: 'wx' });
    await sharp(bytes).resize(960, 480).png().toFile(resolve(directory, `review-${index + 1}.png`));
    candidates.push(candidate);
  }
  // All three have decoded before any fixed output is replaced.
  for (const output of outputs) await inspectOutput(output);
  for (const [index, output] of outputs.entries()) {
    await inspectOutput(output);
    await rename(candidates[index], output);
  }
  return { outputs, directory };
}

async function main(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { console.log(HELP); return; }
  if (args.length !== 1 || args[0] !== '--write') throw new Error('SLIDE_ARGUMENTS_INVALID: use --write or --help');
  const sharp = (await import('sharp')).default;
  const result = await writeSlides(sharp);
  for (const output of result.outputs) console.log(output);
  console.log(`SLIDE_REVIEW_DIRECTORY ${result.directory}`);
}

if (import.meta.main) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
