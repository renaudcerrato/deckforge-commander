import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { lstat, open, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOutputUpdate } from '../src/core/output-update.mjs';
import { createPrimitiveArtwork } from '../src/core/primitive-artwork.mjs';

const ASSETS_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULTS = Object.freeze({ color: '#969696' });
const SVG_PREFIX = 'data:image/svg+xml,';
const BASE64_SVG_PREFIX = 'data:image/svg+xml;base64,';

export const IMAGE_RECIPES = Object.freeze([
  'svg = read_utf8("assets/protocol-image.svg"); emit(svg)',
  'svg = read_bytes("assets/protocol-image.svg"); emit("data:image/svg+xml;base64," + base64(svg))',
]);

export const PROTOCOL_EXAMPLES = Object.freeze([
  { id: 'text-plain', filename: 'protocol-text-plain.svg', record: 'Hello, world' },
  { id: 'text-styled', filename: 'protocol-text-styled.svg', record: 'text:42|font-size:48;label:Items;weight:bold;color:cyan;background:#101820;border:2;border-color:cyan' },
  { id: 'text-wrap', filename: 'protocol-text-wrap.svg', record: 'text:Build complete|font-size:auto;overflow:wrap;color:lime' },
  { id: 'text-multiline', filename: 'protocol-text-multiline.svg', record: 'text:Big ideas\\n\\nsmall steps|font-size:16;overflow:wrap;color:cyan' },
  { id: 'text-ellipsis', filename: 'protocol-text-ellipsis.svg', record: 'text:This is a deliberately long label|font-size:24;overflow:ellipsis;color:violet' },
  { id: 'progress-ring', filename: 'protocol-progress-ring.svg', record: 'progress:17/1034|label:Build;color:cyan' },
  { id: 'progress-bar', filename: 'protocol-progress-bar.svg', record: 'progress:670/1000|type:bar;display:670 MB;label:Download;color:lime;value-size:20;label-size:16;value-color:white;label-color:accent' },
  { id: 'text-mono', filename: 'protocol-text-mono.svg', record: 'text:128|font:mono;font-size:40;color:orange' },
  { id: 'text-aligned', filename: 'protocol-text-aligned.svg', record: 'text:ON|font-size:36;label:Connected;label-size:14;label-color:white;align:left;valign:bottom;color:lime;border:2' },
  { id: 'progress-ring-thin', filename: 'protocol-progress-ring-thin.svg', record: 'progress:25|color:orange;thickness:4;value-position:none' },
  { id: 'progress-ring-bordered', filename: 'protocol-progress-ring-bordered.svg', record: 'progress:75/100|scale:100;color:violet;border:2;border-color:violet;display:3/4;value-size:20;label:Sync;label-position:above' },
  { id: 'progress-bar-square', filename: 'protocol-progress-bar-square.svg', record: 'progress:35|type:bar;color:orange;thickness:20;rounded:false;value-position:above' },
  { id: 'progress-bar-track', filename: 'protocol-progress-bar-track.svg', record: 'progress:90|type:bar;color:cyan;track-color:#263746;label:Upload;label-position:above;value-position:below' },
  { id: 'image', kind: 'image', filename: 'protocol-image.svg', sourceRecord: '<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#071122"/><stop offset="1" stop-color="#21103c"/></linearGradient><radialGradient id="halo"><stop stop-color="#8b5cf6" stop-opacity=".65"/><stop offset="1" stop-color="#8b5cf6" stop-opacity="0"/></radialGradient><radialGradient id="planet" cx=".3" cy=".2" r=".9"><stop stop-color="#ffd29d"/><stop offset=".4" stop-color="#fb7185"/><stop offset="1" stop-color="#7c3aed"/></radialGradient><linearGradient id="orbit"><stop stop-color="#22d3ee"/><stop offset="1" stop-color="#a78bfa"/></linearGradient></defs><rect width="144" height="144" rx="22" fill="url(#bg)"/><circle cx="72" cy="72" r="62" fill="url(#halo)"/><g fill="#c4b5fd"><circle cx="24" cy="30" r="1.5"/><circle cx="112" cy="25" r="1"/><circle cx="121" cy="111" r="1.5"/><circle cx="28" cy="117" r="1"/></g><path d="M108 42v8m-4-4h8M36 91v6m-3-3h6" stroke="#67e8f9" stroke-linecap="round"/><ellipse cx="72" cy="76" rx="59" ry="22" transform="rotate(-28 72 76)" fill="none" stroke="url(#orbit)" stroke-width="1.5" stroke-opacity=".4"/><circle cx="72" cy="70" r="30" fill="url(#planet)"/><path d="M54 57c5-9 15-13 25-10" fill="none" stroke="#fff1d6" stroke-width="3" stroke-linecap="round" stroke-opacity=".65"/><path d="M20 101c22 8 67-9 98-39" fill="none" stroke="url(#orbit)" stroke-width="3" stroke-linecap="round"/><circle cx="118" cy="62" r="8" fill="#22d3ee" fill-opacity=".15"/><circle cx="118" cy="62" r="3.5" fill="#a5f3fc"/></svg>', recipes: IMAGE_RECIPES },
  { id: 'text-layout', filename: 'protocol-text-layout.svg', record: 'text:42|font-size:56;label:Items;label-size:12;padding-x:10;padding-y:22;align:left;label-align:right;weight:bold;label-weight:normal;label-gap:12;color:cyan' },
  { id: 'progress-ring-labels', filename: 'protocol-progress-ring-labels.svg', record: 'progress:75|scale:48;thickness:2;value-size:14;label:Sync;label-size:10;label-position:above;label-weight:bold;label-gap:6;color:violet' },
  { id: 'progress-bar-labels', filename: 'protocol-progress-bar-labels.svg', record: 'progress:65|type:bar;scale:110;thickness:28;label:CPU;label-size:34;label-position:above;label-weight:bold;label-gap:12;color:lime' },
  { id: 'card-basic', filename: 'protocol-card-basic.svg', record: 'card:UP|header:API;footer:HTTP 200' },
  { id: 'card-styled', filename: 'protocol-card-styled.svg', record: 'card:64°C|header:GPU;footer:Fan 1200 rpm;font:mono;font-size:36;color:cyan;header-color:white;footer-color:lime;header-size:16;footer-size:12' },
  { id: 'card-aligned', filename: 'protocol-card-aligned.svg', record: 'card:142/144|header:Tests;footer:2 failed;font-size:24;header-align:left;footer-align:right;header-weight:bold;footer-color:orange;background:#101820;border:2;border-color:orange' },
  { id: 'card-wrap', filename: 'protocol-card-wrap.svg', record: 'card:Build finished|header:Status;footer:All checks OK;font-size:28;overflow:wrap;header-gap:2;footer-gap:12' },
].map(example => Object.freeze(example)));

class PreviewError extends Error {}

function fail(identifier) {
  throw new PreviewError(identifier);
}

function renderRecord(record) {
  const update = parseOutputUpdate(record, DEFAULTS);
  if (update?.kind === 'image' && update.image.startsWith(SVG_PREFIX)) {
    return decodeURIComponent(update.image.slice(SVG_PREFIX.length));
  }
  if (!update || (update.kind !== 'text' && update.kind !== 'progress' && update.kind !== 'card')) fail('PREVIEW_PARSE_FAILED');
  const image = createPrimitiveArtwork(update);
  if (typeof image !== 'string' || !image.startsWith(SVG_PREFIX)) fail('PREVIEW_RENDER_FAILED');
  return decodeURIComponent(image.slice(SVG_PREFIX.length));
}

function verifyImageRecords(svg) {
  const raw = parseOutputUpdate(svg);
  if (raw?.kind !== 'image' || !raw.image.startsWith(SVG_PREFIX)
    || decodeURIComponent(raw.image.slice(SVG_PREFIX.length)) !== svg) fail('PREVIEW_RAW_IMAGE_FAILED');
  const bytes = Buffer.from(svg, 'utf8');
  const record = BASE64_SVG_PREFIX + bytes.toString('base64');
  const encoded = parseOutputUpdate(record);
  if (encoded?.kind !== 'image' || encoded.image !== record
    || !Buffer.from(encoded.image.slice(BASE64_SVG_PREFIX.length), 'base64').equals(bytes)) {
    fail('PREVIEW_BASE64_IMAGE_FAILED');
  }
}

/** Pure renderer output: decoded SVG bytes are never reformatted or given a trailing newline. */
export function generateProtocolExamples() {
  return Object.freeze(PROTOCOL_EXAMPLES.map(example => {
    const svg = renderRecord(example.kind === 'image' ? example.sourceRecord : example.record);
    if (example.kind === 'image') verifyImageRecords(svg);
    return Object.freeze({ ...example, svg });
  }));
}

async function inspectAssetsDirectory() {
  const info = await lstat(ASSETS_DIRECTORY);
  if (info.isSymbolicLink() || !info.isDirectory()) fail('PREVIEW_ASSETS_DIRECTORY_INVALID');
}

async function inspectOutput(filename) {
  try {
    const info = await lstat(resolve(ASSETS_DIRECTORY, filename));
    if (info.isSymbolicLink() || !info.isFile()) fail('PREVIEW_OUTPUT_INVALID');
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function writeExample(example, exists) {
  const path = resolve(ASSETS_DIRECTORY, example.filename);
  const bytes = Buffer.from(example.svg, 'utf8');
  if (exists && bytes.equals(await readFile(path))) return false;
  // Best-effort symlink protection in a trusted checkout, not race-proof containment.
  const flags = exists ? constants.O_WRONLY | constants.O_NOFOLLOW : 'wx';
  const handle = await open(path, flags);
  try {
    if (!(await handle.stat()).isFile()) fail('PREVIEW_OUTPUT_INVALID');
    if (exists) await handle.truncate(0);
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
  return true;
}

/** Write only the fixed recipe filenames, leaving byte-identical files untouched. */
export async function writeProtocolExamples() {
  const examples = generateProtocolExamples();
  await inspectAssetsDirectory();
  const existing = await Promise.all(examples.map(example => inspectOutput(example.filename)));
  const results = [];
  for (const [index, example] of examples.entries()) {
    const written = await writeExample(example, existing[index]);
    results.push(Object.freeze({ id: example.id, bytes: Buffer.byteLength(example.svg), written }));
  }
  return Object.freeze(results);
}

/** Read-only checks of generated preview bytes and image records. */
export async function checkProtocolExamples() {
  const examples = generateProtocolExamples();
  await inspectAssetsDirectory();
  for (const example of examples) {
    if (!await inspectOutput(example.filename)) fail('PREVIEW_OUTPUT_MISSING');
    const actual = await readFile(resolve(ASSETS_DIRECTORY, example.filename));
    if (!actual.equals(Buffer.from(example.svg, 'utf8'))) fail('PREVIEW_OUTPUT_STALE');
  }
  const imageRecords = await Promise.all(['webp', 'png', 'jpeg'].map(async format => {
    const bytes = await readFile(resolve(ASSETS_DIRECTORY, `protocol-image.${format}`));
    return { format, record: `data:image/${format};base64,${bytes.toString('base64')}` };
  }));
  const svg = examples.find(example => example.kind === 'image').svg;
  for (const { format, record } of [{ format: 'svg', record: svg }, ...imageRecords]) {
    const documented = await readFile(resolve(ASSETS_DIRECTORY, `protocol-image-${format}.txt`), 'utf8');
    if (documented !== record + '\n') fail('PREVIEW_IMAGE_RECORD_STALE');
  }
  return Object.freeze({ examples: examples.length });
}

async function main(args) {
  if (args.length !== 1 || !['--write', '--check'].includes(args[0])) fail('PREVIEW_ARGUMENTS_INVALID');
  if (args[0] === '--write') {
    for (const result of await writeProtocolExamples()) {
      console.log(`PREVIEW_WRITE_OK ${result.id} ${result.bytes} ${result.written ? 'written' : 'unchanged'}`);
    }
  } else {
    const result = await checkProtocolExamples();
    console.log(`PREVIEW_CHECK_OK ${result.examples}`);
  }
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof PreviewError ? error.message : 'PREVIEW_OPERATION_FAILED');
    process.exitCode = 1;
  }
}
