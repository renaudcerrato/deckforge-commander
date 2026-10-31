import { Buffer } from 'node:buffer';
import { normalizeOutputColor } from './colors.mjs';
import { DEFAULT_THEME_COLOR } from './theme.mjs';

const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const COMMON = Object.freeze({ color: DEFAULT_THEME_COLOR, background: '#000000', font: 'sans', weight: 'normal', border: 0, 'border-color': DEFAULT_THEME_COLOR });
const TEXT = Object.freeze({ ...COMMON, 'font-size': 'auto', valign: 'center', align: 'center', overflow: 'wrap', padding: 16, 'padding-x': 16, 'padding-y': 16, 'line-height': 1.2, label: '', 'label-size': 'auto', 'label-color': COMMON.color, 'label-position': 'below', 'label-weight': 'normal', 'label-align': 'center', 'label-gap': 8 });
const CARD = Object.freeze({ ...COMMON, 'font-size': 'auto', align: 'center', overflow: 'ellipsis', padding: 16, 'padding-x': 16, 'padding-y': 16, header: '', footer: '', 'header-size': 'auto', 'header-color': COMMON.color, 'header-font': 'sans', 'header-weight': 'normal', 'header-align': 'center', 'header-gap': 8, 'footer-size': 'auto', 'footer-color': COMMON.color, 'footer-font': 'sans', 'footer-weight': 'normal', 'footer-align': 'center', 'footer-gap': 8 });
const PROGRESS = Object.freeze({ ...COMMON, type: 'ring', scale: 80, thickness: 8, 'track-color': '#333333', label: '', display: undefined, 'value-position': 'center', 'label-position': 'below', rounded: true, 'value-size': 16, 'label-size': 16, 'value-color': '#ffffff', 'label-color': '#ffffff', 'label-weight': 'normal', 'label-gap': 2 });
const ENUMS = Object.freeze({ font: ['sans', 'mono'], weight: ['normal', 'bold'], 'label-weight': ['normal', 'bold'], valign: ['top', 'center', 'bottom'], align: ['left', 'center', 'right'], 'label-align': ['left', 'center', 'right'], overflow: ['wrap', 'ellipsis'], type: ['ring', 'bar'], 'value-position': ['center', 'above', 'below', 'none'], 'label-position': ['above', 'below'] });

export function parseOutputNumber(value) {
  if (typeof value !== 'string' || !DECIMAL.test(value)) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function readData(object, key) {
  if (object === null || typeof object !== 'object') return undefined;
  try { return Object.getOwnPropertyDescriptor(object, key)?.value; }
  catch { return undefined; }
}

function normalizeOption(kind, key, value) {
  const base = kind === 'text' ? TEXT : kind === 'card' ? CARD : PROGRESS;
  if (!Object.hasOwn(base, key)) return undefined;
  if (kind === 'card' && /^(header|footer)-(color|font|weight|align)$/.test(key)) {
    return normalizeOption(kind, key.slice(key.indexOf('-') + 1), value);
  }
  if (key === 'value-color' || key === 'label-color') {
    return kind === 'progress' && value === 'accent' ? value : normalizeOutputColor(value);
  }
  if (key === 'color' || key === 'background' || key === 'track-color' || key === 'border-color') return normalizeOutputColor(value);
  if (Object.hasOwn(ENUMS, key)) return typeof value === 'string' && ENUMS[key].includes(value) ? value : undefined;
  if (key === 'rounded') {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return undefined;
  }
  if (key === 'label' || key === 'header' || key === 'footer') return typeof value === 'string' && (kind === 'progress'
    || (value.length <= 262_144 && !value.includes('\0') && Buffer.byteLength(value, 'utf8') <= 262_144)) ? value : undefined;
  if (key === 'display') return typeof value === 'string' && value.length <= 262_144
    && !value.includes('\0') && Buffer.byteLength(value, 'utf8') <= 262_144 ? value : undefined;
  if ((kind === 'text' || kind === 'card') && ['font-size', 'label-size', 'header-size', 'footer-size'].includes(key) && value === 'auto') return value;
  const number = typeof value === 'number' ? value : parseOutputNumber(value);
  if (!Number.isFinite(number)) return undefined;
  if (key === 'font-size' || key === 'label-size' || key === 'header-size' || key === 'footer-size' || key === 'value-size' || key === 'scale' || key === 'thickness') return number > 0 ? number : undefined;
  const range = optionRange(key);
  if (!range || number < range[0] || number > range[1]) return undefined;
  return number;
}

function optionRange(key) {
  if (key === 'border') return [0, 16];
  if (key === 'padding' || key === 'padding-x' || key === 'padding-y' || key === 'label-gap' || key === 'header-gap' || key === 'footer-gap') return [0, Infinity];
  if (key === 'line-height') return [1, Infinity];
  return undefined;
}

// Preserve escapes while finding delimiters; decode only after the grammar is split.
function splitEscaped(source, delimiter, firstOnly = false) {
  const parts = [];
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\\') {
      if (++index === source.length) return undefined;
    } else if (source[index] === delimiter && (!firstOnly || parts.length === 0)) {
      parts.push(source.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(source.slice(start));
  return parts;
}

function decodeEscapes(source, hardBreaks = false) {
  return source.replace(/\\([;|\\n])/g, (escape, character) =>
    character === 'n' ? (hardBreaks ? '\n' : escape) : character);
}

/** Decode an explicit command's value and strictly validate its entire option suffix. */
export function parseOutputCommand(kind, source) {
  if (!['text', 'progress', 'card'].includes(kind) || typeof source !== 'string') return undefined;
  const parts = splitEscaped(source, '|', true);
  if (!parts) return undefined;
  const raw = Object.create(null);
  if (parts.length === 2) {
    const entries = splitEscaped(parts[1], ';');
    if (!entries) return undefined;
    for (const entry of entries) {
      const colon = entry.indexOf(':');
      if (colon < 1) return undefined;
      const key = entry.slice(0, colon);
      if (Object.hasOwn(raw, key)) return undefined;
      raw[key] = decodeEscapes(entry.slice(colon + 1));
    }
  }
  const overrides = normalizeOverrides(kind, raw);
  if (!overrides) return undefined;
  return Object.freeze({ value: decodeEscapes(parts[0], kind === 'text'), overrides });
}

function normalizeOverrides(kind, input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  let keys;
  try { keys = Reflect.ownKeys(input); } catch { return undefined; }
  const result = {};
  for (const key of keys) {
    if (typeof key !== 'string') return undefined;
    const value = normalizeOption(kind, key, readData(input, key));
    if (value === undefined) return undefined;
    result[key] = value;
  }
  return Object.freeze(result);
}

/** Flat per-kind defaults are forgiving; record overrides are all-or-nothing. */
export function resolveOutputOptions(kind, overrides = {}, defaults = {}) {
  if (!['text', 'progress', 'card'].includes(kind)) return undefined;
  const explicit = normalizeOverrides(kind, overrides);
  if (!explicit) return undefined;
  const type = explicit.type ?? 'ring';
  const base = kind === 'text' ? TEXT : kind === 'card' ? CARD : { ...PROGRESS, type, scale: type === 'bar' ? 85 : 80, thickness: type === 'bar' ? 12 : 8 };
  const options = { ...base };
  for (const key of Object.keys(base)) {
    // These describe this record, never a prior record or a per-key preference.
    if (key === 'label' || key === 'header' || key === 'footer' || (kind === 'progress' && (key === 'type' || key === 'display'))) continue;
    const value = normalizeOption(kind, key, readData(defaults, key));
    if (value !== undefined) options[key] = value;
  }
  // A record accent never recolors an implicit frame: derive it from per-key defaults first.
  options['border-color'] = normalizeOutputColor(readData(defaults, 'border-color')) ?? options.color;
  Object.assign(options, explicit);
  if (kind !== 'card') options['label-weight'] = explicit['label-weight']
    ?? normalizeOption(kind, 'label-weight', readData(defaults, 'label-weight')) ?? options.weight;
  if (kind === 'text' || kind === 'card') {
    for (const key of ['padding-x', 'padding-y']) {
      options[key] = explicit[key] ?? explicit.padding
        ?? normalizeOption(kind, key, readData(defaults, key))
        ?? normalizeOption(kind, 'padding', readData(defaults, 'padding')) ?? TEXT.padding;
    }
    if (kind === 'text') options['label-color'] = explicit['label-color']
      ?? normalizeOutputColor(readData(defaults, 'label-color')) ?? options.color;
  }
  if (kind === 'card') {
    for (const side of ['header', 'footer']) {
      for (const attribute of ['color', 'font', 'weight']) {
        const key = `${side}-${attribute}`;
        options[key] = explicit[key] ?? normalizeOption(kind, key, readData(defaults, key)) ?? options[attribute];
      }
    }
  }
  if (kind === 'progress') {
    // Keep symbolic provenance in overrides, but only opaque colors in resolved DTOs.
    for (const key of ['value-color', 'label-color']) {
      if (options[key] === 'accent') options[key] = options.color;
    }
  }
  return Object.freeze(options);
}
