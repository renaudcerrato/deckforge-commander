export const DEFAULT_THEME_COLOR = '#969696';
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Strict edit boundary: only opaque six-digit hex colors, never arbitrary CSS. */
export function normalizeThemeColor(value) {
  if (typeof value !== 'string' || !HEX_COLOR.test(value)) {
    const error = new Error('Invalid theme color.');
    error.diagnosticCode = 'THEME_COLOR_INVALID';
    throw error;
  }
  return value.toLowerCase();
}

/** Read-only rendering fallback; malformed stored metadata is not an execution error or repair request. */
export function resolveThemeColor(value) {
  try { return normalizeThemeColor(value); } catch { return DEFAULT_THEME_COLOR; }
}

export function settingsThemeColor(settings) {
  try { return resolveThemeColor(Object.getOwnPropertyDescriptor(settings, 'themeColor')?.value); }
  catch { return DEFAULT_THEME_COLOR; }
}
