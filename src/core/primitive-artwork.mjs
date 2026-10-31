import { Buffer } from 'node:buffer';
import { copyOutputData as copyData } from './output-data.mjs';
import { resolveOutputOptions } from './output-options.mjs';

const CANVAS = 144;
const MAX_BYTES = 262_144;
const MAX_CLUSTERS = 512;
const SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' });
const COMMON_KEYS = ['color', 'background', 'font', 'weight', 'border', 'border-color'];
const TEXT_KEYS = [...COMMON_KEYS, 'font-size', 'valign', 'align', 'overflow', 'padding', 'padding-x', 'padding-y', 'line-height', 'label', 'label-size', 'label-color', 'label-position', 'label-weight', 'label-align', 'label-gap'];
const CARD_KEYS = [...COMMON_KEYS, 'font-size', 'align', 'overflow', 'padding', 'padding-x', 'padding-y', 'header', 'footer', 'header-size', 'header-color', 'header-font', 'header-weight', 'header-align', 'header-gap', 'footer-size', 'footer-color', 'footer-font', 'footer-weight', 'footer-align', 'footer-gap'];
const PROGRESS_KEYS = [...COMMON_KEYS, 'type', 'scale', 'thickness', 'track-color', 'label', 'display', 'value-position', 'label-position', 'rounded', 'value-size', 'label-size', 'value-color', 'label-color', 'label-weight', 'label-gap'];

function sameKeys(data, keys) {
  return Object.keys(data).length === keys.length && keys.every(key => Object.hasOwn(data, key));
}

function validatedUpdate(input) {
  const update = copyData(input);
  if (!update || !sameKeys(update, ['kind', 'value', 'options', 'overrides'])) return undefined;
  if (!['text', 'progress', 'card'].includes(update.kind)) return undefined;
  const options = copyData(update.options);
  const overrides = copyData(update.overrides);
  const keys = update.kind === 'text' ? TEXT_KEYS : update.kind === 'card' ? CARD_KEYS : PROGRESS_KEYS;
  if (!options || !overrides || !sameKeys(options, keys)) return undefined;
  const resolved = resolveOutputOptions(update.kind, overrides, options);
  if (!resolved || keys.some(key => resolved[key] !== options[key])) return undefined;
  if (update.kind === 'text' && (!boundedText(update.value) || !boundedText(options.label))) return undefined;
  if (update.kind === 'card' && (!boundedText(update.value) || !boundedText(options.header) || !boundedText(options.footer))) return undefined;
  if (update.kind === 'progress' && (typeof update.value !== 'number' || !Number.isFinite(update.value)
    || update.value < 0 || update.value > 100 || !boundedText(options.label)
    || (options.display !== undefined && !boundedText(options.display)))) return undefined;
  return { kind: update.kind, value: update.value, options };
}

function boundedText(value) {
  return typeof value === 'string' && value.length <= MAX_BYTES && !value.includes('\0')
    && Buffer.byteLength(value, 'utf8') <= MAX_BYTES;
}

function xml(value) {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
}

function number(value) {
  if (!Number.isFinite(value)) throw new RangeError('Invalid artwork geometry.');
  return String(Number(value.toFixed(6)));
}

function drawableSize(size) {
  // Positive dimensions must survive the coordinate serializer's precision.
  return Number.isFinite(size) && size > 0 && Number(number(size)) > 0;
}

function displayText(value, hardBreaks = false) {
  let normalized = value.normalize('NFC')
    .replace(/[\u0001-\u001f\u007f-\u009f\u200b\u200e\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g,
      character => hardBreaks && character === '\n' ? character : ' ')
    .replace(/[\ud800-\udfff]|[\u{fffe}\u{ffff}\u{1fffe}\u{1ffff}\u{2fffe}\u{2ffff}\u{3fffe}\u{3ffff}\u{4fffe}\u{4ffff}\u{5fffe}\u{5ffff}\u{6fffe}\u{6ffff}\u{7fffe}\u{7ffff}\u{8fffe}\u{8ffff}\u{9fffe}\u{9ffff}\u{afffe}\u{affff}\u{bfffe}\u{bffff}\u{cfffe}\u{cffff}\u{dfffe}\u{dffff}\u{efffe}\u{effff}\u{ffffe}\u{fffff}\u{10fffe}\u{10ffff}]/gu, '\ufffd');
  normalized = hardBreaks
    ? normalized.replace(/[^\S\n]+/gu, ' ').replace(/ *\n */g, '\n').replace(/^ +| +$/g, '')
    : normalized.replace(/\s+/gu, ' ').trim();
  // Blank main content still clears, even when it consists entirely of hard breaks.
  if (hardBreaks && /^\n*$/.test(normalized)) return { clusters: [], truncated: false };
  const clusters = [];
  let truncated = false;
  for (const { segment } of SEGMENTER.segment(normalized)) {
    // A single pathological combining cluster must not create unbounded SVG output.
    if (clusters.length === MAX_CLUSTERS || segment.length > 256) { truncated = true; break; }
    clusters.push(segment);
  }
  if (truncated && clusters.length === 0) return { clusters: ['…'], truncated: false };
  return { clusters, truncated };
}

// Deterministic conservative font estimates, not a claim about device pixel geometry.
function clusterWidth(cluster, options) {
  let width = 0.65;
  if (cluster.codePointAt(0) > 0xff || cluster.length > 2) width = 1.2;
  else if (options.font !== 'mono') {
    if (/^\s$/u.test(cluster)) width = 0.35;
    else if (/^[ilI.,'`!:;|]$/.test(cluster)) width = 0.35;
    else if (/^[mwMW@%&]$/.test(cluster)) width = 1;
    else if (/^[A-Z]$/.test(cluster)) width = 0.8;
  }
  return width * (options.weight === 'bold' ? 1.08 : 1.04);
}

function textClusterWidth(cluster, options) {
  if (options.font === 'mono' || cluster.codePointAt(0) > 0xff || cluster.length > 2) {
    return clusterWidth(cluster, options);
  }
  let width = 0.56;
  if (/^\s$/u.test(cluster)) width = 0.28;
  else if (/^[ilI.,'`!:;|]$/.test(cluster)) width = 0.25;
  else if (/^[frt]$/.test(cluster)) width = 0.33;
  else if (/^[mwMW@%&]$/.test(cluster)) width = 1;
  else if (/^[A-Z]$/.test(cluster)) width = 0.7;
  return width * (options.weight === 'bold' ? 1.08 : 1.04);
}

function widthsFor(clusters, options, text = false) {
  const measure = text ? textClusterWidth : clusterWidth;
  return clusters.map(cluster => measure(cluster, options));
}

function ellipsize(clusters, widths, size, width, forced = false) {
  const total = widths.reduce((sum, value) => sum + value, 0) * size;
  if (!forced && total <= width) return clusters.join('');
  // Reserve enough for an ellipsis even with the bold-width safety factor.
  const room = width / size - 1.3;
  if (room < 0) return undefined;
  let used = 0;
  let end = 0;
  while (end < clusters.length && used + widths[end] <= room) used += widths[end++];
  return clusters.slice(0, end).join('').trimEnd() + '…';
}

function wrapLines(text, widths, size, width, limit, options) {
  const lines = [];
  let start = 0;
  while (start < text.clusters.length && lines.length < limit) {
    let end = start, used = 0, space = -1;
    while (end < text.clusters.length && (used + widths[end]) * size <= width) {
      if (text.clusters[end] === ' ') space = end;
      used += widths[end++];
    }
    if (lines.length === limit - 1) {
      const tail = text.clusters.slice(start);
      const line = ellipsize(tail, widths.slice(start), size, width, text.truncated);
      if (line === undefined) return undefined;
      lines.push(line);
      return { lines, complete: !text.truncated && end === text.clusters.length };
    }
    if (end === start) return undefined;
    if (end < text.clusters.length && text.clusters[end] !== ' ' && space > start) end = space;
    lines.push(text.clusters.slice(start, end).join('').trimEnd());
    start = end;
    while (text.clusters[start] === ' ') start += 1;
  }
  if (text.truncated && lines.length > 0) {
    const last = lines.length - 1;
    const clusters = Array.from(SEGMENTER.segment(lines[last]), item => item.segment);
    lines[last] = ellipsize(clusters, widthsFor(clusters, options, true), size, width, true);
  }
  return { lines, complete: !text.truncated && start === text.clusters.length };
}

function hardLines(text, widths) {
  const lines = [];
  let start = 0;
  for (let index = 0; index <= text.clusters.length; index += 1) {
    if (index !== text.clusters.length && text.clusters[index] !== '\n') continue;
    lines.push({ clusters: text.clusters.slice(start, index), widths: widths.slice(start, index),
      truncated: index === text.clusters.length && text.truncated });
    start = index + 1;
  }
  return lines;
}

function wrapHardLines(hardlines, size, width, limit, options) {
  const lines = [];
  for (const [index, text] of hardlines.entries()) {
    const fitted = text.clusters.length === 0
      ? { lines: [text.truncated ? ellipsize([], [], size, width, true) : ''], complete: !text.truncated }
      : wrapLines(text, text.widths, size, width, limit - lines.length, options);
    if (!fitted) return undefined;
    lines.push(...fitted.lines);
    const hiddenLines = index < hardlines.length - 1;
    if (lines.length === limit && hiddenLines && fitted.complete) {
      const last = lines.length - 1;
      const clusters = Array.from(SEGMENTER.segment(lines[last]), item => item.segment);
      lines[last] = ellipsize(clusters, widthsFor(clusters, options, true), size, width, true);
    }
    if (!fitted.complete || (lines.length === limit && hiddenLines)) return { lines, complete: false };
  }
  return { lines, complete: true };
}

function textLineLimit(size, height, lineHeight, workLimit) {
  if (size > height || !drawableSize(size)) return 0;
  // An overflowing step permits only one line; tiny steps never allocate by numeric capacity.
  return Math.min(workLimit, 1 + Math.floor((height - size) / (size * lineHeight)));
}

function fitText(text, options, width, height) {
  const widths = widthsFor(text.clusters, options, true);
  // Split only the globally bounded grapheme sequence, never reset its budget per line.
  const hardlines = hardLines(text, widths);
  const sizes = options['font-size'] === 'auto' ? Array.from({ length: 33 }, (_, index) => 48 - index) : [options['font-size']];
  const minimumSize = sizes.at(-1);
  const workLimit = text.clusters.length + 1;
  const availableLines = textLineLimit(minimumSize, height, options['line-height'], workLimit);
  // Auto wrapping prefers fewer complete lines before choosing the largest size.
  const lineLimits = options['font-size'] === 'auto' && options.overflow === 'wrap'
    ? Array.from({ length: availableLines }, (_, index) => index + 1)
    : [options.overflow === 'ellipsis' ? 1 : availableLines];
  let fallback;
  for (const lineLimit of lineLimits) {
    for (const size of sizes) {
      const limit = Math.min(lineLimit, textLineLimit(size, height, options['line-height'], workLimit));
      if (limit < 1) continue;
      const fitted = options.overflow === 'ellipsis'
        ? { lines: [ellipsize(text.clusters, widths, size, width, text.truncated)], complete: !text.truncated && widths.reduce((sum, value) => sum + value, 0) * size <= width }
        : wrapHardLines(hardlines, size, width, limit, options);
      if (!fitted || fitted.lines.some(line => line === undefined)) continue;
      // The last candidate uses all available height at the minimum size.
      fallback = { lines: fitted.lines, size };
      if (fitted.complete) return fallback;
    }
  }
  return fallback;
}

function textElement(value, x, baseline, size, color, options, anchor = 'middle', clip = 'content-clip') {
  const family = options.font === 'mono' ? 'monospace' : 'Arial,sans-serif';
  return `<text x="${number(x)}" y="${number(baseline)}" text-anchor="${anchor}" font-family="${family}" font-weight="${options.weight}" font-size="${size}" fill="${color}" xml:space="preserve" clip-path="url(#${clip})">${xml(value)}</text>`;
}

function protectedFrame(border) {
  // Inward stroke edge plus a 2-unit gap; corner centers stay at 24 and 120.
  return { inset: 10 + border / 2, radius: 14 - border / 2 };
}

function textLayoutOptions(options) {
  if (options.border === 0) return options;
  const frame = protectedFrame(options.border);
  const minimum = Math.max(frame.inset, 24 - frame.radius / Math.SQRT2);
  // Round inward so six-decimal SVG serialization cannot expose a box corner.
  const padding = Math.ceil(minimum * 1e6) / 1e6;
  return { ...options, 'padding-x': Math.max(options['padding-x'], padding), 'padding-y': Math.max(options['padding-y'], padding) };
}

function captionSize(options, mainSize) {
  return options['label-size'] === 'auto' ? Math.max(14, Math.min(18, mainSize / 2)) : options['label-size'];
}

function fitCaptionedText(text, label, options, width, height) {
  const labelOptions = { ...options, weight: options['label-weight'] };
  const labelWidths = widthsFor(label.clusters, labelOptions, true);
  if (text.clusters.length === 0) {
    const size = captionSize(options, 36);
    if (size > height || !drawableSize(size)) return undefined;
    const value = ellipsize(label.clusters, labelWidths, size, width, label.truncated);
    return value !== undefined ? { slots: [{ value, size, caption: true }], height: size } : undefined;
  }
  const widths = widthsFor(text.clusters, options, true);
  const sizes = options['font-size'] === 'auto'
    ? Array.from({ length: 33 }, (_, index) => 48 - index) : [options['font-size']];
  let fallback;
  for (const size of sizes) {
    if (size > height || !drawableSize(size)) continue;
    const labelSize = captionSize(options, size);
    // Only a fixed main font may retain the headline by dropping an oversized caption.
    const showLabel = size + labelSize + options['label-gap'] <= height;
    if (!showLabel && options['font-size'] === 'auto') continue;
    if (showLabel && !drawableSize(labelSize)) continue;
    const value = ellipsize(text.clusters, widths, size, width, text.truncated);
    const caption = showLabel ? ellipsize(label.clusters, labelWidths, labelSize, width, label.truncated) : undefined;
    if (value === undefined || (showLabel && caption === undefined)) continue;
    const slots = [{ value, size, caption: false }];
    if (showLabel) {
      const slot = { value: caption, size: labelSize, caption: true };
      if (options['label-position'] === 'above') slots.unshift(slot);
      else slots.push(slot);
    }
    fallback = { slots, height: size + (showLabel ? labelSize + options['label-gap'] : 0) };
    if (!text.truncated && widths.reduce((sum, value) => sum + value, 0) * size <= width) return fallback;
  }
  return fallback;
}

function captionedTextContent(fitted, options) {
  const paddingX = options['padding-x'], paddingY = options['padding-y'];
  let top = options.valign === 'top' ? paddingY : options.valign === 'bottom'
    ? CANVAS - paddingY - fitted.height : (CANVAS - fitted.height) / 2;
  const content = [];
  let previousBaseline;
  for (const [index, slot] of fitted.slots.entries()) {
    const align = slot.caption ? options['label-align'] : options.align;
    const x = align === 'left' ? paddingX : align === 'right' ? CANVAS - paddingX : 72;
    const anchor = align === 'left' ? 'start' : align === 'right' ? 'end' : 'middle';
    const color = slot.caption ? options['label-color'] : options.color;
    const baseline = top + slot.size * 0.8;
    const serializedBaseline = Number(number(baseline));
    if (previousBaseline !== undefined && serializedBaseline <= previousBaseline) return undefined;
    previousBaseline = serializedBaseline;
    const font = slot.caption ? { ...options, weight: options['label-weight'] } : options;
    content.push(textElement(slot.value, x, baseline, slot.size, color, font, anchor));
    // A solo line does not use the gap, even if its requested value would overflow arithmetic.
    if (index < fitted.slots.length - 1) top += slot.size + options['label-gap'];
  }
  return content.join('');
}

function textArtwork(update) {
  const options = textLayoutOptions(update.options);
  const paddingX = options['padding-x'], paddingY = options['padding-y'];
  const width = CANVAS - 2 * paddingX, height = CANVAS - 2 * paddingY;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined;
  const clipX = options.border > 0 ? number(paddingX) : paddingX;
  const clipY = options.border > 0 ? number(paddingY) : paddingY;
  const clipWidth = options.border > 0 ? number(width) : width;
  const clipHeight = options.border > 0 ? number(height) : height;
  if (Number(clipWidth) <= 0 || Number(clipHeight) <= 0) return undefined;
  const clip = `<clipPath id="content-clip"><rect x="${clipX}" y="${clipY}" width="${clipWidth}" height="${clipHeight}"/></clipPath>`;
  const label = displayText(options.label);
  const text = displayText(update.value, label.clusters.length === 0 && options.overflow === 'wrap');
  if (label.clusters.length > 0) {
    const fitted = fitCaptionedText(text, label, options, width, height);
    if (!fitted) return undefined;
    const content = captionedTextContent(fitted, options);
    return content === undefined ? undefined : { clip, content };
  }
  if (text.clusters.length === 0 && !text.truncated) return { clip, content: '' };
  const fitted = fitText(text, options, width, height);
  if (!fitted) return undefined;
  const blockHeight = fitted.lines.length === 1 ? fitted.size
    : fitted.size + (fitted.lines.length - 1) * fitted.size * options['line-height'];
  if (!Number.isFinite(blockHeight)) return undefined;
  const top = options.valign === 'top' ? paddingY : options.valign === 'bottom' ? 144 - paddingY - blockHeight : (144 - blockHeight) / 2;
  const x = options.align === 'left' ? paddingX : options.align === 'right' ? 144 - paddingX : 72;
  const anchor = options.align === 'left' ? 'start' : options.align === 'right' ? 'end' : 'middle';
  const baselines = fitted.lines.map((_, index) => top + fitted.size * 0.8 + index * fitted.size * options['line-height']);
  const serializedBaselines = baselines.map(baseline => Number(number(baseline)));
  if (serializedBaselines.some((baseline, index) => index > 0 && baseline <= serializedBaselines[index - 1])) return undefined;
  const content = fitted.lines.map((line, index) => textElement(line, x, baselines[index], fitted.size, options.color, options, anchor)).join('');
  return { clip, content };
}

function cardSideSize(options, side, mainSize) {
  return options[`${side}-size`] === 'auto'
    ? Math.max(14, Math.min(18, mainSize / 2)) : options[`${side}-size`];
}

function fitCardSize(main, header, footer, options, width, height) {
  if (main.clusters.length === 0) return 36;
  if (options['font-size'] !== 'auto') return options['font-size'];
  const mainWidth = widthsFor(main.clusters, options, true).reduce((sum, value) => sum + value, 0);
  for (let size = 48; size >= 16; size -= 1) {
    const headerHeight = header.clusters.length > 0 ? cardSideSize(options, 'header', size) + options['header-gap'] : 0;
    const footerHeight = footer.clusters.length > 0 ? cardSideSize(options, 'footer', size) + options['footer-gap'] : 0;
    if (!main.truncated && mainWidth * size <= width && size + headerHeight + footerHeight <= height) return size;
  }
  // Oversized cards retain every requested line, even when the slots overlap.
  return 16;
}

function cardLine(text, size, baseline, options, width, side) {
  if (text.clusters.length === 0) return '';
  if (!drawableSize(size)) return undefined;
  const font = side ? { font: options[`${side}-font`], weight: options[`${side}-weight`] } : options;
  const align = side ? options[`${side}-align`] : options.align;
  const color = side ? options[`${side}-color`] : options.color;
  const x = align === 'left' ? options['padding-x'] : align === 'right' ? CANVAS - options['padding-x'] : 72;
  const anchor = align === 'left' ? 'start' : align === 'right' ? 'end' : 'middle';
  // If even an ellipsis cannot fit, retain bounded content behind the padded clip.
  const value = ellipsize(text.clusters, widthsFor(text.clusters, font, true), size, width, text.truncated)
    ?? text.clusters.join('');
  return textElement(value, x, baseline, size, color, font, anchor);
}

function cardMiddle(header, footer, options, size) {
  const top = options['padding-y'] + (header.clusters.length > 0 ? cardSideSize(options, 'header', size) + options['header-gap'] : 0);
  const bottom = CANVAS - options['padding-y'] - (footer.clusters.length > 0 ? cardSideSize(options, 'footer', size) + options['footer-gap'] : 0);
  return { top, bottom };
}

function fitWrappedCard(main, header, footer, options, width) {
  const sizes = options['font-size'] === 'auto'
    ? Array.from({ length: 33 }, (_, index) => 48 - index) : [options['font-size']];
  const minimum = sizes.at(-1);
  const middle = cardMiddle(header, footer, options, minimum);
  const capacity = textLineLimit(minimum, middle.bottom - middle.top, 1.2, main.clusters.length + 1);
  const lineLimits = options['font-size'] === 'auto'
    ? Array.from({ length: capacity }, (_, index) => index + 1) : [capacity];
  const widths = widthsFor(main.clusters, options, true);
  let fallback = { size: minimum, lines: [main.clusters.join('')], truncated: main.truncated };
  for (const lineLimit of lineLimits) {
    for (const size of sizes) {
      const { top, bottom } = cardMiddle(header, footer, options, size);
      const limit = Math.min(lineLimit, textLineLimit(size, bottom - top, 1.2, main.clusters.length + 1));
      if (limit < 1) continue;
      const fitted = wrapLines(main, widths, size, width, limit, options);
      if (!fitted || fitted.lines.some(line => line === undefined)) continue;
      fallback = { size, lines: fitted.lines, truncated: false };
      if (fitted.complete) return fallback;
    }
  }
  return fallback;
}

function wrappedCardContent(fitted, top, bottom, options, width) {
  const step = fitted.lines.length > 1 ? fitted.size * 1.2 : 0;
  const firstBaseline = top / 2 + bottom / 2 + fitted.size * 0.3 - (fitted.lines.length - 1) * step / 2;
  let previousBaseline;
  const content = [];
  for (const [index, line] of fitted.lines.entries()) {
    const baseline = firstBaseline + index * step;
    const serialized = Number(number(baseline));
    if (previousBaseline !== undefined && serialized <= previousBaseline) return undefined;
    previousBaseline = serialized;
    const text = displayText(line);
    content.push(cardLine({ ...text, truncated: text.truncated || fitted.truncated }, fitted.size, baseline, options, width));
  }
  return content.some(line => line === undefined) ? undefined : content.join('');
}

function cardArtwork(update) {
  const options = textLayoutOptions(update.options);
  const paddingX = options['padding-x'], paddingY = options['padding-y'];
  const width = CANVAS - 2 * paddingX, height = CANVAS - 2 * paddingY;
  if (!drawableSize(width) || !drawableSize(height)) return undefined;
  const clip = `<clipPath id="content-clip"><rect x="${number(paddingX)}" y="${number(paddingY)}" width="${number(width)}" height="${number(height)}"/></clipPath>`;
  const main = displayText(update.value), header = displayText(options.header), footer = displayText(options.footer);
  const wrapped = options.overflow === 'wrap' && main.clusters.length > 0
    ? fitWrappedCard(main, header, footer, options, width) : undefined;
  const mainSize = wrapped ? wrapped.size : fitCardSize(main, header, footer, options, width, height);
  const headerSize = cardSideSize(options, 'header', mainSize);
  const footerSize = cardSideSize(options, 'footer', mainSize);
  const { top, bottom } = cardMiddle(header, footer, options, mainSize);
  // Halve before adding so large, opposite edge reservations do not overflow.
  const content = [
    cardLine(header, headerSize, paddingY + headerSize * 0.8, options, width, 'header'),
    wrapped ? wrappedCardContent(wrapped, top, bottom, options, width)
      : cardLine(main, mainSize, top / 2 + bottom / 2 + mainSize * 0.3, options, width),
    cardLine(footer, footerSize, CANVAS - paddingY - footerSize * 0.2, options, width, 'footer'),
  ];
  return content.some(line => line === undefined) ? undefined : { clip, content: content.join('') };
}

function annotationSlots(update, geometry) {
  const options = update.options;
  const slots = [];
  const explicitDisplay = options.display !== undefined;
  const value = displayText(explicitDisplay ? options.display : `${Math.round(update.value * 10) / 10}%`);
  if (options['value-position'] !== 'none' && (value.clusters.length > 0 || value.truncated)) slots.push({ position: options['value-position'], value, ellipsis: explicitDisplay,
     size: options['value-size'], color: options['value-color'], weight: options.weight });
  const label = displayText(options.label);
  if (label.clusters.length > 0 || label.truncated) slots.push({ position: options['label-position'], value: label, ellipsis: true,
     size: options['label-size'], color: options['label-color'], weight: options['label-weight'] });
  // Both annotations must fit the existing 16..128 logical-height window.
  if (slots.some(slot => !drawableSize(slot.size) || slot.size > 112)) return undefined;
  const gap = options['label-gap'];
  if (slots.length === 2 && slots[0].size + slots[1].size + gap > 112) return undefined;
  if (geometry.ring && slots.length === 2 && slots[0].position === 'center') {
    // Center the complete visible block, retaining the selected font sizes and gap.
    const ordered = slots[1].position === 'above' ? [slots[1], slots[0]] : slots;
    let top = 72 - (ordered[0].size + ordered[1].size + gap) / 2;
    for (const [index, slot] of ordered.entries()) {
      slot.y = top + slot.size / 2;
      if (index === 0) top += slot.size + gap;
    }
    return ordered;
  }
  const centerSize = slots.find(slot => slot.position === 'center')?.size;
  for (const position of ['above', 'center', 'below']) {
    const group = slots.filter(slot => slot.position === position);
    if (group.length === 0) continue;
    const height = group.reduce((sum, slot) => sum + slot.size, 0) + 2 * (group.length - 1);
    let top;
    if (geometry.ring || position === 'center') {
      const offset = 18 + ((centerSize ?? 16) - 16) / 2 + (Math.max(...group.map(slot => slot.size)) - 16) / 2;
      const center = 72 + (position === 'above' ? -offset : position === 'below' ? offset : 0);
      top = center - height / 2;
    } else if (position === 'above') {
      const bottom = Math.min(72 - geometry.thickness / 2 - 4, centerSize === undefined ? 128 : 72 - centerSize / 2 - 2);
      top = bottom - height;
    } else {
      top = Math.max(72 + geometry.thickness / 2 + 4, centerSize === undefined ? 16 : 72 + centerSize / 2 + 2);
    }
    for (const slot of group) {
      slot.y = top + slot.size / 2;
      top += slot.size + 2;
    }
  }
  if (slots.length === 2) {
    const [valueSlot, labelSlot] = slots;
    if (valueSlot.position === labelSlot.position) {
      // Preserve the original value anchor and stack order, changing only the internal gap.
      if (gap !== 2) labelSlot.y += gap - 2;
    } else if (labelSlot.position === 'above') {
      const separation = valueSlot.y - valueSlot.size / 2 - labelSlot.y - labelSlot.size / 2;
      if (separation < gap - 1e-9) labelSlot.y = valueSlot.y - valueSlot.size / 2 - gap - labelSlot.size / 2;
    } else {
      const separation = labelSlot.y - labelSlot.size / 2 - valueSlot.y - valueSlot.size / 2;
      if (separation < gap - 1e-9) labelSlot.y = valueSlot.y + valueSlot.size / 2 + gap + labelSlot.size / 2;
    }
  }
  slots.sort((first, second) => first.y - second.y);
  if (slots.some((slot, index) => index > 0
    && slot.y - slot.size / 2 < slots[index - 1].y + slots[index - 1].size / 2 + gap - 1e-9)) return undefined;
  return slots;
}

function frameAnnotationWidth(slot, border) {
  const frame = protectedFrame(border);
  const top = slot.y - slot.size / 2;
  const bottom = slot.y + slot.size / 2;
  if (top < frame.inset - 1e-9 || bottom > CANVAS - frame.inset + 1e-9) return undefined;
  const leftEdge = y => {
    const distance = y < 24 ? 24 - y : y > 120 ? y - 120 : 0;
    // The vertical guard bounds the distance; tolerate arithmetic at the edge.
    return 24 - Math.sqrt(Math.max(0, frame.radius ** 2 - distance ** 2));
  };
  return 2 * (72 - Math.max(frame.inset, leftEdge(top), leftEdge(bottom)));
}

function annotations(update, geometry) {
  const slots = annotationSlots(update, geometry);
  if (!slots) return undefined;
  let content = '';
  let previousBaseline;
  for (const slot of slots) {
    const extent = Math.abs(slot.y - 72) + slot.size / 2;
    if (slot.y - slot.size / 2 < 16 || slot.y + slot.size / 2 > 128) return undefined;
    if (!geometry.ring && ((slot.position === 'above' && slot.y + slot.size / 2 > 72 - geometry.thickness / 2 - 4 + 1e-9)
      || (slot.position === 'below' && slot.y - slot.size / 2 < 72 + geometry.thickness / 2 + 4 - 1e-9))) return undefined;
    if (geometry.ring && extent >= geometry.innerRadius) return undefined;
    const allowance = geometry.ring
      ? 2 * Math.sqrt(geometry.innerRadius ** 2 - extent ** 2) - 4
      : slot.position === 'center' ? Math.min(geometry.width - 4, 108) : 108;
    const frameWidth = update.options.border > 0 ? frameAnnotationWidth(slot, update.options.border) : allowance;
    if (frameWidth === undefined) return undefined;
    const width = Math.min(allowance, frameWidth);
    const text = slot.value;
    const font = { ...update.options, weight: slot.weight };
    const widths = widthsFor(text.clusters, font);
    if (!slot.ellipsis && widths.reduce((sum, value) => sum + value, 0) * slot.size > width) return undefined;
    const value = ellipsize(text.clusters, widths, slot.size, width, text.truncated);
    if (value === undefined) return undefined;
    const baseline = slot.y + slot.size * 0.3;
    const serializedBaseline = Number(number(baseline));
    if (previousBaseline !== undefined && serializedBaseline <= previousBaseline) return undefined;
    previousBaseline = serializedBaseline;
    content += textElement(value, 72, baseline, slot.size, slot.color, font);
  }
  return content;
}

function barFitsFrame(width, thickness, border, rounded) {
  if (!drawableSize(width) || !drawableSize(thickness)) return false;
  const inset = border > 0 ? protectedFrame(border).inset : 0;
  const x = (CANVAS - width) / 2, y = (CANVAS - thickness) / 2;
  if (x < inset - 1e-9 || y < inset - 1e-9) return false;
  if (border === 0 || rounded || x >= 24 || y >= 24) return true;
  // A rounded bar is a centered capsule; square corners need the additional frame-arc guard.
  return Math.hypot(24 - x, 24 - y) <= protectedFrame(border).radius + 1e-9;
}

function progressArtwork(update) {
  const options = update.options;
  const thickness = options.thickness;
  // The centered frame stroke consumes its width, with a 2-unit gap on each side.
  const borderedSpan = 128 - options.border - 4;
  let geometry, clip, content;
  if (!drawableSize(thickness)) return undefined;
  if (options.type === 'ring') {
    const diameter = (options.border > 0 ? borderedSpan : 144) * options.scale / 100;
    const radius = (diameter - thickness) / 2;
    geometry = { ring: true, innerRadius: diameter / 2 - thickness - 2 };
    // The centered outer disk fits the protected rounded frame exactly up to this span.
    if (!drawableSize(radius) || !drawableSize(geometry.innerRadius)
      || diameter > (options.border > 0 ? borderedSpan : CANVAS) + 1e-9) return undefined;
    clip = `<clipPath id="content-clip"><circle cx="72" cy="72" r="${number(geometry.innerRadius)}"/></clipPath>`;
    const circle = `<circle cx="72" cy="72" r="${number(radius)}" fill="none" stroke-width="${thickness}"`;
    content = `${circle} stroke="${options['track-color']}"/>`;
    if (update.value > 0) {
      const circumference = 2 * Math.PI * radius;
      const filled = circumference * update.value / 100;
      if (update.value < 100 && circumference - filled < 0) return undefined;
      const dash = update.value === 100 ? '' : ` stroke-dasharray="${number(filled)} ${number(circumference - filled)}" transform="rotate(-90 72 72)"`;
      content += `${circle} stroke="${options.color}" stroke-linecap="${options.rounded ? 'round' : 'butt'}"${dash}/>`;
    }
  } else {
    const width = (options.border > 0 ? borderedSpan : 112) * options.scale / 100;
    if (!barFitsFrame(width, thickness, options.border, options.rounded)) return undefined;
    const x = (144 - width) / 2;
    const y = 72 - thickness / 2;
    const radius = options.rounded ? Math.min(thickness / 2, width / 2) : 0;
    if (options.rounded && !drawableSize(radius)) return undefined;
    geometry = { ring: false, thickness, width };
    const trackShape = `<rect x="${number(x)}" y="${number(y)}" width="${number(width)}" height="${thickness}" rx="${radius}"`;
    clip = '<clipPath id="content-clip"><rect x="16" y="16" width="112" height="112"/></clipPath>';
    clip += `<clipPath id="bar-track-clip">${trackShape}/></clipPath>`;
    content = `${trackShape} fill="${options['track-color']}"/>`;
    if (update.value > 0) {
      const filled = width * update.value / 100;
      const fillRadius = options.rounded ? Math.min(thickness / 2, filled / 2) : 0;
      content += `<rect x="${number(x)}" y="${number(y)}" width="${number(filled)}" height="${thickness}" rx="${number(fillRadius)}" fill="${options.color}" clip-path="url(#bar-track-clip)"/>`;
    }
  }
  const labels = annotations(update, geometry);
  if (labels === undefined) return undefined;
  return { clip, content: content + labels };
}

/** Render a validated self-contained primitive without changing the active protocol. */
export function createPrimitiveArtwork(input) {
  try {
    const update = validatedUpdate(input);
    if (!update) return undefined;
    const artwork = update.kind === 'text' ? textArtwork(update) : update.kind === 'card' ? cardArtwork(update) : progressArtwork(update);
    if (!artwork) return undefined;
    const border = update.options.border > 0 ? `<rect x="8" y="8" width="128" height="128" rx="16" fill="none" stroke="${update.options['border-color']}" stroke-width="${number(update.options.border)}"/>` : '';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" fill="${update.options.background}"/>${border}<defs>${artwork.clip}</defs>${artwork.content}</svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  } catch {
    // Invalid boundary data/geometry is a skip, not a new protocol latch or content log.
    return undefined;
  }
}
