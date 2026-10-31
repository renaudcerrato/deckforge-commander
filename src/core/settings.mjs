import { parseArguments, serializeArguments } from './arguments.mjs';
import { settingsThemeColor } from './theme.mjs';
import { isAbsoluteExecutionPath } from './execution-paths.mjs';
import { normalizeTitle } from './key-layout.mjs';

const INVALID_SETTINGS = 'Invalid settings.';
const SETTINGS_KEYS = new Set(['executable', 'args', 'argsText', 'cwd', 'runRequested', 'themeColor', 'title']);
const VALIDATION_FAILURE = Symbol('settings validation failure');
const DIAGNOSTIC_CODES = new Set([
  'SETTINGS_NOT_OBJECT',
  'MISSING_EXECUTABLE',
  'INVALID_EXECUTABLE',
  'MISSING_ARGS',
  'ARGS_NOT_ARRAY',
  'ARGS_JSON_INVALID',
  'ARGS_TEXT_INVALID',
  'INVALID_ARGUMENT',
  'INVALID_CWD',
  'INVALID_RUN_STATE',
  'UNKNOWN_SETTING',
  'INVALID_SETTINGS',
  'THEME_COLOR_INVALID',
  'TITLE_INVALID',
]);

function reject(code) {
  throw { [VALIDATION_FAILURE]: code };
}

function readDataProperty(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) reject('INVALID_SETTINGS');
  return descriptor.value;
}

function validate(input, classify = false, platform) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    reject('SETTINGS_NOT_OBJECT');
  }

  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !SETTINGS_KEYS.has(key)) reject('UNKNOWN_SETTING');
    if (classify) readDataProperty(input, key);
  }
  if (classify && ![Object.prototype, null].includes(Object.getPrototypeOf(input))) reject('INVALID_SETTINGS');
  const hasExecutable = Object.hasOwn(input, 'executable');
  const hasArgs = Object.hasOwn(input, 'args') || Object.hasOwn(input, 'argsText');
  // Preserve the strict launch validator's original diagnostic precedence.
  if (!classify && !hasExecutable) reject('MISSING_EXECUTABLE');
  if (!classify && !hasArgs) reject('MISSING_ARGS');
  const executable = hasExecutable ? readDataProperty(input, 'executable') : undefined;
  const setup = classify && (!hasExecutable || executable === '');
  if (!hasExecutable && !setup) reject('MISSING_EXECUTABLE');
  if (!hasArgs && !setup) reject('MISSING_ARGS');

  if (!setup && !isAbsoluteExecutionPath(executable, platform)) reject('INVALID_EXECUTABLE');
  if (Object.hasOwn(input, 'runRequested') && typeof readDataProperty(input, 'runRequested') !== 'boolean') {
    reject('INVALID_RUN_STATE');
  }

  let sourceArgs;
  if (Object.hasOwn(input, 'argsText')) {
    try {
      sourceArgs = parseArguments(readDataProperty(input, 'argsText'), platform);
    } catch {
      reject('ARGS_TEXT_INVALID');
    }
  } else if (hasArgs) {
    sourceArgs = readDataProperty(input, 'args');
    if (typeof sourceArgs === 'string') {
      try {
        sourceArgs = JSON.parse(sourceArgs);
      } catch {
        reject('ARGS_JSON_INVALID');
      }
    }
  } else sourceArgs = [];
  if (!Array.isArray(sourceArgs)) reject('ARGS_NOT_ARRAY');

  const args = [];
  const argumentCount = readDataProperty(sourceArgs, 'length');
  for (let index = 0; index < argumentCount; index++) {
    if (!Object.hasOwn(sourceArgs, index)) reject('INVALID_ARGUMENT');
    const argument = readDataProperty(sourceArgs, String(index));
    if (typeof argument !== 'string' || argument.includes('\0')) reject('INVALID_ARGUMENT');
    args.push(argument);
  }

  const result = { executable, args };
  if (Object.hasOwn(input, 'cwd')) {
    const cwd = readDataProperty(input, 'cwd');
    if (cwd !== '') {
      if (!isAbsoluteExecutionPath(cwd, platform)) reject('INVALID_CWD');
      result.cwd = cwd;
    }
  }
  if (classify) return setup ? { kind: 'setup' } : { kind: 'configured', execution: result };
  return result;
}

function getDiagnosticCode(failure) {
  try {
    if (failure !== null && typeof failure === 'object'
      && Object.hasOwn(failure, VALIDATION_FAILURE)) {
      const code = failure[VALIDATION_FAILURE];
      if (DIAGNOSTIC_CODES.has(code)) return code;
    }
  } catch {
    // Inspection failures always map to the fixed fallback code.
  }
  return 'INVALID_SETTINGS';
}

function invalidSettings(diagnosticCode) {
  const error = new Error(INVALID_SETTINGS);
  error.diagnosticCode = diagnosticCode;
  return error;
}

/** PI field checks only; argument parsing and cwd path validation remain launch concerns. */
export function validateExecutionEdit(key, value, platform) {
  if ((key !== 'executable' && key !== 'argsText' && key !== 'cwd')
    || typeof value !== 'string' || value.includes('\0')) {
    throw invalidSettings(key === 'argsText' ? 'ARGS_TEXT_INVALID'
      : key === 'executable' ? 'INVALID_EXECUTABLE' : key === 'cwd' ? 'INVALID_CWD' : 'INVALID_SETTINGS');
  }
  if (key === 'executable' && !isAbsoluteExecutionPath(value, platform)) throw invalidSettings('INVALID_EXECUTABLE');
}

/** Invalid stored titles are cosmetic fallbacks; only explicit edits reject invalid input. */
export function validateTitleEdit(value) {
  if (typeof value !== 'string' || value.length > 8_192 || value.includes('\0')) {
    throw invalidSettings('TITLE_INVALID');
  }
  return normalizeTitle(value) ? value : undefined;
}

/** Validate platform execution paths without filesystem access; an empty cwd is omitted. */
export function validateSettings(input, platform) {
  try {
    return validate(input, false, platform);
  } catch (failure) {
    throw invalidSettings(getDiagnosticCode(failure));
  }
}

/** Read-only display classification. Setup carries no execution DTO or launch authority. */
export function classifySettings(input, platform) {
  try { return validate(input, true, platform); } catch (failure) {
    throw invalidSettings(getDiagnosticCode(failure));
  }
}

function sameData(first, second, ancestors = new Set()) {
  if (first === null || second === null || typeof first !== 'object' || typeof second !== 'object') return first === second;
  if (Array.isArray(first) !== Array.isArray(second) || ancestors.has(first) || ancestors.has(second)) return false;
  ancestors.add(first);
  ancestors.add(second);
  try {
    const keys = Reflect.ownKeys(first);
    return keys.length === Reflect.ownKeys(second).length && keys.every(key =>
      Object.hasOwn(second, key) && sameData(readDataProperty(first, key), readDataProperty(second, key), ancestors));
  } finally { ancestors.delete(first); ancestors.delete(second); }
}

function sameStoredFields(first, second, ignored) {
  if (first === null || second === null || typeof first !== 'object' || typeof second !== 'object'
    || Array.isArray(first) || Array.isArray(second)) return false;
  const keys = Reflect.ownKeys(first).filter(key => !ignored.has(key));
  const other = Reflect.ownKeys(second).filter(key => !ignored.has(key));
  return keys.length === other.length && keys.every(key => Object.hasOwn(second, key)
    && sameData(readDataProperty(first, key), readDataProperty(second, key)));
}

/** Exact metadata-only classification, including invalid/unconfigured execution snapshots. */
export function sameSettingsExceptTheme(first, second) {
  try { return sameStoredFields(first, second, new Set(['themeColor'])); } catch { return false; }
}

export function sameSettingsExceptTitle(first, second) {
  try { return sameStoredFields(first, second, new Set(['title'])); } catch { return false; }
}

export function isThemeOnlyChange(first, second) {
  try {
    if (!sameSettingsExceptTheme(first, second)) return false;
    const a = Object.hasOwn(first, 'themeColor'), b = Object.hasOwn(second, 'themeColor');
    return a !== b || (a && !sameData(readDataProperty(first, 'themeColor'), readDataProperty(second, 'themeColor')));
  } catch { return false; }
}

/** Compare execution only; cosmetics, text migration, and persisted intent are not execution edits. */
export function sameExecutionSettings(first, second, platform) {
  try {
    if (sameStoredFields(first, second, new Set(['themeColor', 'title', 'runRequested']))) return true;
    const a = validateSettings(first, platform);
    const b = validateSettings(second, platform);
    return a.executable === b.executable && a.cwd === b.cwd
      && a.args.length === b.args.length
      && a.args.every((argument, index) => argument === b.args[index]);
  } catch {
    return false;
  }
}

/** Project settings into controls synchronously, without writing or altering legacy argv. */
export function getInspectorConfiguration(input, platform) {
  const result = { executable: '', cwd: '', themeColor: settingsThemeColor(input), title: '' };
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) reject('SETTINGS_NOT_OBJECT');
    const title = Object.getOwnPropertyDescriptor(input, 'title')?.value;
    result.title = normalizeTitle(title) ? title : '';
    for (const key of ['executable', 'cwd']) {
      if (Object.hasOwn(input, key)) {
        const value = readDataProperty(input, key);
        if (typeof value !== 'string') reject(key === 'cwd' ? 'INVALID_CWD' : 'INVALID_EXECUTABLE');
        result[key] = value;
      }
    }
    if (Object.hasOwn(input, 'argsText')) {
      const text = readDataProperty(input, 'argsText');
      if (typeof text !== 'string' || text.includes('\0')) reject('ARGS_TEXT_INVALID');
      result.argsText = text;
      try {
        const args = parseArguments(text, platform);
        if (/[\r\n]/.test(text)) result.argsText = serializeArguments(args, platform);
      } catch {
        // Invalid multiline text must not become a guessed valid value through native input sanitization.
        if (/[\r\n]/.test(text)) delete result.argsText;
        reject('ARGS_TEXT_INVALID');
      }
    } else if (Object.hasOwn(input, 'args')) {
      let args = readDataProperty(input, 'args');
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { reject('ARGS_JSON_INVALID'); }
      }
      try { result.argsText = serializeArguments(args, platform); } catch { reject('INVALID_ARGUMENT'); }
    } else {
      result.argsText = '';
    }
  } catch (failure) {
    result.diagnosticCode = getDiagnosticCode(failure);
  }
  return result;
}

/** Only an allowlisted, fixed validator reason may cross a diagnostic boundary. */
export function settingsDiagnosticCode(error) {
  try {
    const code = Object.getOwnPropertyDescriptor(error, 'diagnosticCode')?.value;
    if (DIAGNOSTIC_CODES.has(code)) return code;
  } catch {}
  return 'INVALID_SETTINGS';
}
