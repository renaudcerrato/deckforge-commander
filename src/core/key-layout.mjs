import { resolveThemeColor } from './theme.mjs';
import { executionBasename } from './execution-paths.mjs';

export const DEFAULT_LAUNCH_CAPTION = 'DeckForge Commander';
const MAX_INPUT_UNITS = 8_192;
const CAPTION_WIDTH = 112;
const MIN_FONT_SIZE = 16;
const MAX_FONT_SIZE = 32;
const EXTENSION_WIDTH = 42;
const EXTENSION_FONT_SIZE = 16;

function captionClusters(value) {
  if (typeof Intl.Segmenter === 'function') return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].map(item => item.segment);
  return Array.from(value);
}

function estimatedClusterWidth(cluster) {
  if (cluster === '…' || cluster.codePointAt(0) > 0xff) return 1;
  if (/^\s$/u.test(cluster)) return 0.25;
  if (/^[ilI1.,'`!:;|]$/.test(cluster)) return 0.28;
  if (/^[frt()]$/.test(cluster)) return 0.3;
  if (/^[mwMW@%&]$/.test(cluster)) return 0.8;
  if (/^[A-Z]$/.test(cluster)) return 0.65;
  return 0.5;
}

/** Bounded literal one-line title; empty means use the dynamic executable default. */
export function normalizeTitle(value) {
  if (typeof value !== 'string' || value.length > MAX_INPUT_UNITS || value.includes('\0')) return '';
  return Array.from(value.normalize('NFC')).map(character => {
    const code = character.codePointAt(0);
    return (code >= 0xd800 && code <= 0xdfff) || code === 0xfffe || code === 0xffff ? '\ufffd' : character;
  }).join('').replace(/[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ' ')
    .replace(/\s+/gu, ' ').trim();
}

/** Legacy path-aware caption formatter, also used for fixed diagnostics. */
export function formatLaunchCaption(value) {
  if (typeof value !== 'string' || value.length > MAX_INPUT_UNITS) return DEFAULT_LAUNCH_CAPTION;
  return normalizeTitle(value.slice(value.lastIndexOf('/') + 1).replace(/\0/g, ' '))
    || DEFAULT_LAUNCH_CAPTION;
}

function fitCaption(value) {
  const clusters = captionClusters(normalizeTitle(value) || DEFAULT_LAUNCH_CAPTION);
  const widths = clusters.map(cluster => estimatedClusterWidth(cluster) * 1.05);
  const width = widths.reduce((total, size) => total + size, 0);
  const fontSize = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.floor(CAPTION_WIDTH / width * 10) / 10));
  if (width * fontSize <= CAPTION_WIDTH && clusters.join('').length <= 128) return { text: clusters.join(''), fontSize };
  let text = '', used = 0;
  const limit = CAPTION_WIDTH / MIN_FONT_SIZE - 1.05;
  for (let index = 0; index < clusters.length; index++) {
    if (used + widths[index] > limit || text.length + clusters[index].length > 127) break;
    text += clusters[index];
    used += widths[index];
  }
  return { text: text.trimEnd() + '…', fontSize: MIN_FONT_SIZE };
}

/** Extensionless script basename, not a native title. */
export function getReadyTitle(executable, platform, title) {
  const custom = normalizeTitle(title);
  if (custom) return custom;
  if (typeof executable !== 'string' || executable.length > MAX_INPUT_UNITS
    || executable.includes('\0')) return DEFAULT_LAUNCH_CAPTION;
  const basename = executionBasename(executable, platform);
  if (basename === undefined) return DEFAULT_LAUNCH_CAPTION;
  const dot = basename.lastIndexOf('.');
  return formatLaunchCaption(dot > 0 ? basename.slice(0, dot) : basename);
}

function normalizeExtension(value) {
  if (typeof value !== 'string' || value.length > MAX_INPUT_UNITS || !value.startsWith('.')
    || value.includes('/') || value.includes('\0')) return undefined;
  const normalized = formatLaunchCaption(value).toLowerCase().normalize('NFC');
  return normalized.length > 1 && normalized.length <= MAX_INPUT_UNITS
    && normalized.lastIndexOf('.') === 0 ? normalized : undefined;
}

/** Final suffix of the configured absolute executable only; dotfiles alone have no suffix. */
export function getExecutableExtension(executable, platform) {
  if (typeof executable !== 'string' || executable.length > MAX_INPUT_UNITS
    || executable.includes('\0')) return undefined;
  const basename = executionBasename(executable, platform);
  if (basename === undefined) return undefined;
  const dot = basename.lastIndexOf('.');
  return dot > 0 ? normalizeExtension(basename.slice(dot)) : undefined;
}

function extensionBadge(value, color) {
  const extension = normalizeExtension(value);
  if (!extension) return '';
  const width = captionClusters(extension).reduce((total, cluster) => total + estimatedClusterWidth(cluster) * 1.05, 0);
  if (width * EXTENSION_FONT_SIZE > EXTENSION_WIDTH) return '';
  return `<text x="124" y="32" text-anchor="end" font-family="Arial,sans-serif" font-size="${EXTENSION_FONT_SIZE}" fill="${color}">${xmlText(extension)}</text>`;
}

function xmlText(value) {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
}

function setupWarning() {
  return '<g role="img" aria-label="Setup required" stroke-linecap="round" stroke-linejoin="round"><path d="M72 50 96 92H48Z" fill="#ffd43b" stroke="#ffe066" stroke-width="2"/><path d="M72 65v12" fill="none" stroke="#211a07" stroke-width="4"/><circle cx="72" cy="84" r="2" fill="#211a07"/></g>';
}

/** Internal renderer receives only fixed headers and allowlisted non-error footers. */
function renderKeyLayout(caption, themeColor, diagnosis, header, statusFooter, extension) {
  const color = resolveThemeColor(themeColor);
  const setup = !diagnosis && statusFooter === 'setup required';
  const fitted = diagnosis || setup ? undefined : fitCaption(caption);
  const headerColor = diagnosis ? '#ff6b6b' : color;
  const lines = diagnosis ? diagnosis.lines.slice(0, 2).map(formatLaunchCaption) : setup ? [] : [fitted.text];
  const fontSize = diagnosis || setup ? 16 : fitted.fontSize;
  const center = setup ? setupWarning() : lines.map((line, index) => `<text x="72" y="${(72 + fontSize * 0.35 + (index - (lines.length - 1) / 2) * 22).toFixed(2)}" text-anchor="middle" font-family="Arial,sans-serif" font-size="${fontSize}" fill="${diagnosis ? '#ffffff' : color}" clip-path="url(#caption-clip)">${xmlText(line)}</text>`).join('');
  const footer = diagnosis
    ? `<text x="72" y="124" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" fill="${headerColor}">${xmlText(formatLaunchCaption(diagnosis.code))}</text>`
    : `<text x="72" y="124" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" fill="${color}">${statusFooter}</text>`;
  const badge = diagnosis || statusFooter === 'setup required' ? '' : extensionBadge(extension, color);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" fill="#000000"/><rect x="8" y="8" width="128" height="128" rx="16" fill="none" stroke="${color}" stroke-width="3" stroke-opacity="0.35"/><defs><clipPath id="caption-clip"><rect x="16" y="48" width="112" height="48"/></clipPath></defs><text x="22" y="32" font-family="Arial,sans-serif" font-size="16" fill="${headerColor}">${diagnosis ? 'Error' : header}</text>${badge}${center}${footer}</svg>\n`;
}

/** One frame and center renderer; errors supply fixed hints instead of a script name. */
export function createKeyLayout(caption, themeColor, diagnosis, statusFooter, extension) {
  const footer = statusFooter === 'exited' || statusFooter === 'loading...' || statusFooter === 'setup required'
    ? statusFooter : 'ready';
  return renderKeyLayout(caption, themeColor, diagnosis, 'Stream', footer, extension);
}

/** Timer has its own fixed header and footer allowlist; Run's contract stays separate. */
export function createTimerKeyLayout(caption, themeColor, statusFooter, extension) {
  const footer = statusFooter === 'success' || statusFooter === 'loading...' || statusFooter === 'setup required'
    ? statusFooter : 'ready';
  return renderKeyLayout(caption, themeColor, undefined, 'Loop', footer, extension);
}

/** One-shot Run has a fixed header and no Stream exited footer. */
export function createOnceKeyLayout(caption, themeColor, statusFooter, extension) {
  const footer = statusFooter === 'success' || statusFooter === 'loading...' || statusFooter === 'setup required'
    ? statusFooter : 'ready';
  return renderKeyLayout(caption, themeColor, undefined, 'Run', footer, extension);
}
