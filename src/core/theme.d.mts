export declare const DEFAULT_THEME_COLOR: '#969696';
/** Throws a fixed THEME_COLOR_INVALID error for anything except #RRGGBB. */
export declare function normalizeThemeColor(value: unknown): string;
export declare function resolveThemeColor(value: unknown): string;
/** Does not invoke getters, save settings, or reject an executable because of color metadata. */
export declare function settingsThemeColor(settings: unknown): string;
