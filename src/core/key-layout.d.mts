import type { ExecutionPlatform } from './execution-paths.mjs';
export interface KeyDiagnosis { code: string; lines: readonly string[] }
export declare const DEFAULT_LAUNCH_CAPTION: string;
export type KeyStatusFooter = 'ready' | 'exited' | 'setup required' | 'loading...';
export type TimerKeyStatusFooter = 'ready' | 'success' | 'setup required' | 'loading...';
export type OnceKeyStatusFooter = 'ready' | 'success' | 'setup required' | 'loading...';
export declare function formatLaunchCaption(value: unknown): string;
export declare function normalizeTitle(value: unknown): string;
export declare function getReadyTitle(executable: unknown, platform?: ExecutionPlatform, title?: unknown): string;
/** Bounded normalized lowercase final suffix, including its dot; no filesystem or argv inspection. */
export declare function getExecutableExtension(executable: unknown, platform?: ExecutionPlatform): string | undefined;
/** Shared black frame, centered name or error hints, header and footer. */
/** Only KeyStatusFooter literals render. Optional extension must fit whole in its fixed slot; diagnosis/setup ignore it. */
export declare function createKeyLayout(caption: unknown, themeColor?: unknown, diagnosis?: KeyDiagnosis, statusFooter?: unknown, extension?: unknown): string;
/** Fixed Loop header and allowlisted footer; optional extension is bounded/escaped, never truncated, and ignored for setup. */
export declare function createTimerKeyLayout(caption: unknown, themeColor?: unknown, statusFooter?: unknown, extension?: unknown): string;
/** Fixed Run header and allowlisted footer; optional extension must fit whole and is ignored for setup. */
export declare function createOnceKeyLayout(caption: unknown, themeColor?: unknown, statusFooter?: unknown, extension?: unknown): string;
