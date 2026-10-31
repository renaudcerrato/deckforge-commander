import { quote, split } from 'shlex';
import { executionPlatform } from './execution-paths.mjs';

function invalidArguments(diagnosticCode) {
  const error = new Error('Invalid arguments.');
  error.diagnosticCode = diagnosticCode;
  return error;
}

function copyArguments(input) {
  if (!Array.isArray(input)) throw invalidArguments('INVALID_ARGUMENT');

  const args = [];
  const length = Object.getOwnPropertyDescriptor(input, 'length').value;
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw invalidArguments('INVALID_ARGUMENT');
    }
    const argument = descriptor.value;
    if (typeof argument !== 'string' || argument.includes('\0')) {
      throw invalidArguments('INVALID_ARGUMENT');
    }
    args.push(argument);
  }
  return args;
}

function readAnsiArgument(text, start) {
  for (let index = start + 2; index < text.length; index++) {
    if (text[index] === '\\') index++;
    else if (text[index] === "'") {
      return { value: split(text.slice(start, index + 1))[0], end: index };
    }
  }
  throw invalidArguments('ARGS_TEXT_INVALID');
}

/** Windows editor grammar: quotes group, but only explicit ANSI-C segments escape. */
function splitWindowsArguments(text) {
  const args = [];
  let value = '', delimiter, started = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (delimiter) {
      if (character === delimiter) delimiter = undefined;
      else value += character;
    } else if (character === '$' && text[index + 1] === "'") {
      const segment = readAnsiArgument(text, index);
      value += segment.value;
      index = segment.end;
      started = true;
    } else if (character === "'" || character === '"') {
      delimiter = character;
      started = true;
    } else if (/\s/.test(character)) {
      if (started) args.push(value);
      value = '';
      started = false;
    } else {
      value += character;
      started = true;
    }
  }
  if (delimiter) throw invalidArguments('ARGS_TEXT_INVALID');
  if (started) args.push(value);
  return args;
}

/** Parse platform argument text without execution or expansion. */
export function parseArguments(text, platform = executionPlatform()) {
  try {
    if (typeof text !== 'string' || text.includes('\0')) {
      throw invalidArguments('ARGS_TEXT_INVALID');
    }
    if (text.trim() === '') return [];
    return copyArguments(platform === 'win32' ? splitWindowsArguments(text) : split(text));
  } catch {
    // Never expose parser exceptions or incomplete input; callers must fix the text.
    throw invalidArguments('ARGS_TEXT_INVALID');
  }
}

function quoteEditorArgument(argument, platform) {
  if (!/[\r\n]/.test(argument)) {
    if (platform !== 'win32') return quote(argument);
    if (argument !== '' && !/[\s'"]/.test(argument)) return argument;
    if (!argument.includes("'")) return `'${argument}'`;
    if (!argument.includes('"')) return `"${argument}"`;
  }
  const escaped = argument.replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
  return `$'${escaped}'`;
}

/** Platform quoting, with ANSI-C escapes where ordinary quotes cannot preserve the value. */
export function serializeArguments(argv, platform = executionPlatform()) {
  try {
    return copyArguments(argv).map(argument => quoteEditorArgument(argument, platform)).join(' ');
  } catch {
    throw invalidArguments('INVALID_ARGUMENT');
  }
}
