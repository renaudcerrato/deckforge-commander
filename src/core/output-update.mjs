import { Buffer } from 'node:buffer';
import { parseImageUpdate } from './image-update.mjs';
import { parseOutputCommand, parseOutputNumber, resolveOutputOptions } from './output-options.mjs';

const MAX_LINE_BYTES = 262_144;
const IMAGE_PREFIX = /^(?:\s*<svg|data:image)/;
const RAW_IMAGE = /^(?:data:image\/(?:png|jpeg|svg\+xml|webp);base64,[A-Za-z0-9+/=]+$|\s*<svg(?:\s|\/?>))/;

function validateRecord(line) {
  if (typeof line !== 'string' || line.length > MAX_LINE_BYTES || Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
    throw new Error('Image protocol error.');
  }
}

function progressPercentage(value) {
  const operands = value.split('/');
  if (operands.length === 1) {
    const percentage = parseOutputNumber(value);
    return percentage === undefined ? undefined : Math.min(100, Math.max(0, percentage));
  }
  if (operands.length !== 2) return undefined;
  const numerator = parseOutputNumber(operands[0]);
  const denominator = parseOutputNumber(operands[1]);
  if (numerator === undefined || denominator === undefined || denominator <= 0) return undefined;
  // Clamp before division, so finite operands cannot overflow an intermediate ratio.
  if (numerator <= 0) return 0;
  if (numerator >= denominator) return 100;
  // Multiply first when safe to retain tiny percentages that division could underflow.
  const percentage = numerator <= Number.MAX_VALUE / 100
    ? numerator * 100 / denominator : numerator / denominator * 100;
  return Math.min(100, percentage);
}

function primitiveUpdate(kind, value, overrides, defaults) {
  const options = resolveOutputOptions(kind, overrides, defaults);
  if (!options) return undefined;
  if (kind === 'text' || kind === 'card') return Object.freeze({ kind, value, options, overrides });
  const percentage = progressPercentage(value);
  if (percentage === undefined) return undefined;
  return Object.freeze({ kind, value: percentage, options, overrides });
}

/** Additive parser only: framing and the currently wired image protocol remain unchanged. */
export function parseOutputUpdate(line, defaults = {}) {
  validateRecord(line);
  if (/^\p{White_Space}*$/u.test(line)) return undefined;
  if (IMAGE_PREFIX.test(line)) {
    // Never enter the legacy parser's JSON branch, even for malformed image prefixes.
    if (!RAW_IMAGE.test(line)) throw new Error('Image protocol error.');
    const { image } = parseImageUpdate(line);
    return Object.freeze({ kind: 'image', image });
  }
  const colon = line.indexOf(':');
  const kind = colon < 0 ? undefined : line.slice(0, colon);
  if (kind === 'text' || kind === 'progress' || kind === 'card') {
    const command = parseOutputCommand(kind, line.slice(colon + 1));
    if (!command) return undefined;
    return primitiveUpdate(kind, command.value, command.overrides, defaults);
  }
  return primitiveUpdate('text', line, Object.freeze({}), defaults);
}
