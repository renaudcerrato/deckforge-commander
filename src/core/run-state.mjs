import { validateExecutionEdit, validateTitleEdit } from './settings.mjs';
import { normalizeThemeColor } from './theme.mjs';
import { copySettings, createSettingsAuthority } from './settings-authority.mjs';

const SAVE_ERROR = 'Run state save failed.';

function invalidSettings(code = 'INVALID_SETTINGS') {
  const error = new Error('Invalid settings.');
  error.diagnosticCode = code;
  return error;
}

function saveError() {
  const error = new Error(SAVE_ERROR);
  error.diagnosticCode = 'STATE_SAVE_FAILED';
  return error;
}

/** Detached complete settings, including legacy and unknown JSON fields, without invoking getters. */
export function copyRunSettings(input) {
  return copySettings(input);
}

/** PI edits cannot write intent or replace a complete settings snapshot. */
export function applyConfigurationEdit(settings, changes, platform) {
  const next = copyRunSettings(settings);
  const edit = copyRunSettings(changes);
  if (Object.keys(edit).length === 0) throw invalidSettings();
  for (const key of Object.keys(edit)) {
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
  // Cosmetic-only edits preserve the complete snapshot, even when execution is invalid/unconfigured.
  if (Object.keys(edit).some(key => key !== 'themeColor' && key !== 'title')) {
    if (!Object.hasOwn(next, 'argsText') && !Object.hasOwn(next, 'args')) next.argsText = '';
  }
  return next;
}

/** Serialize complete per-action writes and confirm only matching host-reported readback. */
export function createRunStateCoordinator({
  writeSettings, readSettings, onFailure = () => {}, timeoutMs = 5_000,
  setTimer = setTimeout, clearTimer = clearTimeout,
  platform,
}) {
  if ([writeSettings, readSettings, onFailure, setTimer, clearTimer].some(value => typeof value !== 'function')) {
    throw new TypeError('Run state dependencies must be functions.');
  }
  const authority = createSettingsAuthority({
    writeSettings, readSettings, onFailure, timeoutMs, setTimer, clearTimer,
    createSaveError: saveError,
  });
  const { observe, getSettings, save, whenIdle, isBlocked, getRevision } = authority;

  function editConfiguration(changes) {
    try { return save(applyConfigurationEdit(getSettings(), changes, platform)); } catch (error) { return Promise.reject(error); }
  }

  return {
    observe, getSettings, editConfiguration, whenIdle,
    isBlocked, getRevision,
  };
}
