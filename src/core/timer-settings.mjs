import {
  classifySettings, getInspectorConfiguration, sameExecutionSettings, settingsDiagnosticCode, validateSettings, validateExecutionEdit, validateTitleEdit,
} from './settings.mjs';
import { normalizeThemeColor } from './theme.mjs';
import { copySettings, createSettingsAuthority } from './settings-authority.mjs';

export const DEFAULT_INTERVAL_SECONDS = 60;
export const MIN_INTERVAL_SECONDS = 1;
export const MAX_INTERVAL_SECONDS = 86_400;
export const DEFAULT_ACTION_ON_PRESS = 'refresh';

const SETTINGS_KEYS = new Set(['executable', 'args', 'argsText', 'cwd', 'themeColor', 'title', 'intervalSeconds', 'actionOnPress']);
const EXECUTION_EDIT_KEYS = new Set(['executable', 'argsText', 'cwd']);

function invalidSettings(code = 'INVALID_SETTINGS') {
  const error = new Error('Invalid settings.');
  error.diagnosticCode = code;
  return error;
}

function dataValue(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw invalidSettings();
  return descriptor.value;
}

function requireSettingsObject(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw invalidSettings('SETTINGS_NOT_OBJECT');
  }
}

function validateInterval(value) {
  if (!Number.isInteger(value) || value < MIN_INTERVAL_SECONDS || value > MAX_INTERVAL_SECONDS) {
    throw invalidSettings('INTERVAL_INVALID');
  }
  return value;
}

function validateActionOnPress(value) {
  if (value !== 'refresh' && value !== 'stop') throw invalidSettings('ACTION_ON_PRESS_INVALID');
  return value;
}

/** Missing means Refresh without a write; present invalid values never guess a policy. */
export function readActionOnPress(input) {
  try {
    requireSettingsObject(input);
    if (!Object.hasOwn(input, 'actionOnPress')) return DEFAULT_ACTION_ON_PRESS;
    return validateActionOnPress(dataValue(input, 'actionOnPress'));
  } catch (error) {
    const code = timerSettingsDiagnosticCode(error);
    throw invalidSettings(code === 'SETTINGS_NOT_OBJECT' ? code : 'ACTION_ON_PRESS_INVALID');
  }
}

/** Missing means the read-only default; a present value is never coerced or clamped. */
export function readIntervalSeconds(input) {
  try {
    requireSettingsObject(input);
    if (!Object.hasOwn(input, 'intervalSeconds')) return DEFAULT_INTERVAL_SECONDS;
    return validateInterval(dataValue(input, 'intervalSeconds'));
  } catch (error) {
    throw invalidSettings(timerSettingsDiagnosticCode(error));
  }
}

function executionProjection(input) {
  requireSettingsObject(input);
  const projection = {};
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !SETTINGS_KEYS.has(key)) throw invalidSettings('UNKNOWN_SETTING');
    if (key !== 'intervalSeconds' && key !== 'actionOnPress') {
      // Preserve descriptors so the existing validator rejects selected accessors
      // without invoking them, and keeps argsText precedence over legacy args.
      Object.defineProperty(projection, key, Object.getOwnPropertyDescriptor(input, key));
    }
  }
  return projection;
}

/** Timer metadata never reaches the unchanged execution runner DTO. */
export function validateTimerSettings(input, platform) {
  try {
    const execution = validateSettings(executionProjection(input), platform);
    return { execution, intervalSeconds: readIntervalSeconds(input), actionOnPress: readActionOnPress(input) };
  } catch (error) {
    throw invalidSettings(timerSettingsDiagnosticCode(error));
  }
}

/** Read-only partial setup, with validated Timer controls but no synthetic execution DTO. */
export function classifyTimerSettings(input, platform) {
  try {
    requireSettingsObject(input);
    if (![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw invalidSettings();
    const classification = classifySettings(executionProjection(input), platform);
    return { ...classification, intervalSeconds: readIntervalSeconds(input), actionOnPress: readActionOnPress(input) };
  } catch (error) { throw invalidSettings(timerSettingsDiagnosticCode(error)); }
}

/** Timer control edits are not execution edits; equivalent legacy argv migration is also unchanged. */
export function sameTimerExecutionSettings(first, second, platform) {
  try {
    return sameExecutionSettings(executionProjection(first), executionProjection(second), platform);
  } catch {
    return false;
  }
}

export function sameTimerInterval(first, second) {
  try { return readIntervalSeconds(first) === readIntervalSeconds(second); } catch { return false; }
}

/** Read-only controls; invalid stored metadata never displays a guessed default. */
export function getTimerInspectorConfiguration(input, platform) {
  const configuration = getInspectorConfiguration(input, platform);
  try {
    configuration.intervalSeconds = readIntervalSeconds(input);
  } catch (error) {
    configuration.diagnosticCode ??= timerSettingsDiagnosticCode(error);
  }
  try {
    configuration.actionOnPress = readActionOnPress(input);
  } catch (error) {
    configuration.diagnosticCode ??= timerSettingsDiagnosticCode(error);
  }
  return configuration;
}

/** Narrow PI edits preserve complete JSON/legacy data and never synthesize persistent intent. */
export function applyTimerConfigurationEdit(settings, changes, platform) {
  const next = copySettings(settings);
  // Validate before the JSON copy so non-finite numeric intervals have the same
  // fixed interval diagnostic as other invalid numbers, without reading getters.
  try {
    requireSettingsObject(changes);
    if (Object.hasOwn(changes, 'intervalSeconds')) validateInterval(dataValue(changes, 'intervalSeconds'));
    if (Object.hasOwn(changes, 'actionOnPress')) readActionOnPress(changes);
  } catch (error) {
    throw invalidSettings(timerSettingsDiagnosticCode(error));
  }
  const edit = copySettings(changes);
  const keys = Object.keys(edit);
  if (keys.length === 0) throw invalidSettings();
  for (const key of keys) {
    if (key === 'title') {
      const title = validateTitleEdit(edit.title);
      if (title === undefined) delete next.title;
      else next.title = title;
    } else if (key === 'themeColor') {
      next.themeColor = normalizeThemeColor(edit.themeColor);
    } else if (key === 'intervalSeconds') {
      next.intervalSeconds = validateInterval(edit.intervalSeconds);
    } else if (key === 'actionOnPress') {
      next.actionOnPress = validateActionOnPress(edit.actionOnPress);
    } else {
      validateExecutionEdit(key, edit[key], platform);
      next[key] = edit[key];
    }
  }
  if (keys.some(key => EXECUTION_EDIT_KEYS.has(key))
    && !Object.hasOwn(next, 'argsText') && !Object.hasOwn(next, 'args')) next.argsText = '';
  return next;
}

/** Fixed allowlisted diagnostics only, including Timer's control metadata reasons. */
export function timerSettingsDiagnosticCode(error) {
  try {
    const code = Object.getOwnPropertyDescriptor(error, 'diagnosticCode')?.value;
    if (code === 'INTERVAL_INVALID' || code === 'ACTION_ON_PRESS_INVALID') return code;
  } catch {}
  return settingsDiagnosticCode(error);
}

function saveError() {
  const error = new Error('Run state save failed.');
  error.diagnosticCode = 'STATE_SAVE_FAILED';
  return error;
}

/** Configuration persistence only: no enabled state, scheduling, process cleanup, or intent writes. */
export function createTimerStateCoordinator({
  writeSettings, readSettings, onFailure = () => {}, timeoutMs = 5_000,
  setTimer = setTimeout, clearTimer = clearTimeout,
  platform,
}) {
  const authority = createSettingsAuthority({
    writeSettings, readSettings, onFailure, timeoutMs, setTimer, clearTimer,
    createSaveError: saveError,
  });
  const { observe, getSettings, save, whenIdle, isBlocked, getRevision } = authority;

  function editConfiguration(changes) {
    try { return save(applyTimerConfigurationEdit(getSettings(), changes, platform)); } catch (error) { return Promise.reject(error); }
  }

  return { observe, getSettings, editConfiguration, whenIdle, isBlocked, getRevision };
}
