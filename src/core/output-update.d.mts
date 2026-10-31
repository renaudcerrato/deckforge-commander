import type { OutputDefaults, TextOptions, ProgressOptions, CardOptions, ResolvedTextOptions, ResolvedProgressOptions, ResolvedCardOptions } from './output-options.mjs';

export interface OutputImageUpdate {
	readonly kind: 'image';
	readonly image: string;
}
export interface OutputTextUpdate {
	readonly kind: 'text';
	/** Main content, including decoded LF hard breaks from explicit text commands only. */
	readonly value: string;
	readonly options: ResolvedTextOptions;
	/** Explicit normalized record overrides, retained for cosmetic re-resolution. */
	readonly overrides: Readonly<Partial<TextOptions>>;
}
export interface OutputProgressUpdate {
	readonly kind: 'progress';
	/** Full finite percentage from a bare percent or a/b ratio, clamped to [0, 100]; not annotation-rounded. */
	readonly value: number;
	readonly options: ResolvedProgressOptions;
	/** Explicit normalized overrides retain symbolic 'accent' for cosmetic re-resolution. */
	readonly overrides: Readonly<Partial<ProgressOptions>>;
}
export interface OutputCardUpdate {
	readonly kind: 'card';
	/** Literal main content, optionally soft-wrapped; wire backslash-n stays literal. */
	readonly value: string;
	readonly options: ResolvedCardOptions;
	readonly overrides: Readonly<Partial<CardOptions>>;
}
export type OutputUpdate = OutputImageUpdate | OutputTextUpdate | OutputProgressUpdate | OutputCardUpdate;
/**
 * Parses one bounded framed record. Undefined means blank/invalid reserved primitive (skip).
 * Non-string, oversized, and malformed recognized image records throw a fixed protocol error.
 * Defaults must be plain readonly data, never host objects, accessors, or proxies.
 */
export declare function parseOutputUpdate(line: unknown, defaults?: OutputDefaults): OutputUpdate | undefined;
