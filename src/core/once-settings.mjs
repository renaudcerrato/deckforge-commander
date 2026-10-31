import {
  classifySettings, sameExecutionSettings, settingsDiagnosticCode, validateSettings, validateExecutionEdit, validateTitleEdit,
} from './settings.mjs';
import { normalizeThemeColor } from './theme.mjs';
import { copySettings, createSettingsAuthority } from './settings-authority.mjs';

const SETTINGS_KEYS = new Set(['executable', 'args', 'argsText', 'cwd', 'themeColor', 'title']);
const EXECUTION_EDIT_KEYS = new Set(['executable', 'argsText', 'cwd']);

function invalidSettings(code = 'INVALID_SETTINGS') {
  const error = new Error('Invalid settings.');
  error.diagnosticCode = code;
  return error;
}

/** Reject other actions' launch controls before the shared Stream validator can accept them. */
function executionProjection(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw invalidSettings('SETTINGS_NOT_OBJECT');
  }
  const projection = {};
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !SETTINGS_KEYS.has(key)) throw invalidSettings('UNKNOWN_SETTING');
    // Preserve descriptors and argsText precedence without invoking selected getters.
    Object.defineProperty(projection, key, Object.getOwnPropertyDescriptor(input, key));
  }
  return projection;
}

export function validateOnceSettings(input, platform) {
  try { return { execution: validateSettings(executionProjection(input), platform) }; } catch (error) {
    throw invalidSettings(settingsDiagnosticCode(error));
  }
}

/** Partial setup is read-only and never supplies launch authority. */
export function classifyOnceSettings(input, platform) {
  try {
    const projection = executionProjection(input);
    if (![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw invalidSettings();
    return classifySettings(projection, platform);
  } catch (error) { throw invalidSettings(settingsDiagnosticCode(error)); }
}

export function sameOnceExecutionSettings(first, second, platform) {
  try { return sameExecutionSettings(executionProjection(first), executionProjection(second), platform); } catch { return false; }
}

/** Preserve complete JSON and legacy argv, while accepting only the shared execution/theme controls. */
export function applyOnceConfigurationEdit(settings, changes, platform) {
  const next = copySettings(settings);
  const edit = copySettings(changes);
  const keys = Object.keys(edit);
  if (keys.length === 0) throw invalidSettings();
  for (const key of keys) {
    if (key === 'title') {
      const title = validateTitleEdit(edit.title);
      if (title === undefined) delete next.title;
      else next.title = title;
      continue;
    }
    if (key === 'themeColor') {
      next.themeColor = normalizeThemeColor(edit.themeColor);
      continue;
    }
    validateExecutionEdit(key, edit[key], platform);
    next[key] = edit[key];
  }
  if (keys.some(key => EXECUTION_EDIT_KEYS.has(key))
    && !Object.hasOwn(next, 'argsText') && !Object.hasOwn(next, 'args')) next.argsText = '';
  return next;
}

function saveError() {
  const error = new Error('Run state save failed.');
  error.diagnosticCode = 'STATE_SAVE_FAILED';
  return error;
}

/** Configuration authority only; attempt intent and completed output are never persisted. */
export function createOnceStateCoordinator({
  writeSettings, readSettings, onFailure = () => {}, timeoutMs = 5_000,
  setTimer = setTimeout, clearTimer = clearTimeout,
  platform,
}) {
  const authority = createSettingsAuthority({
    writeSettings, readSettings, onFailure, timeoutMs, setTimer, clearTimer, createSaveError: saveError,
  });
  const { observe, getSettings, save, whenIdle, isBlocked, getRevision } = authority;
  function editConfiguration(changes) {
    try { return save(applyOnceConfigurationEdit(getSettings(), changes, platform)); } catch (error) { return Promise.reject(error); }
  }
  return { observe, getSettings, editConfiguration, whenIdle, isBlocked, getRevision };
}
