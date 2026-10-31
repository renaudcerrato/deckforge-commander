export type OutputKind = 'text' | 'progress' | 'card';
export interface CommonOutputOptions {
	readonly color: string;
	/** Opaque primitive background, default black. */
	readonly background: string;
	readonly font: 'sans' | 'mono';
	readonly weight: 'normal' | 'bold';
	/** Finite stroke width in canvas units, 0..16; zero disables the primitive frame. */
	readonly border: number;
	/** Independent opaque frame color; defaults to the per-key theme, not record ink/accent. */
	readonly 'border-color': string;
}
export interface TextOptions extends CommonOutputOptions {
	/** Auto (48 down to 16) or any fixed finite positive main font; fixed fonts never shrink. */
	readonly 'font-size': 'auto' | number;
	readonly valign: 'top' | 'center' | 'bottom';
	readonly align: 'left' | 'center' | 'right';
	readonly overflow: 'wrap' | 'ellipsis';
	/** Finite nonnegative shorthand padding; requested values are not changed for border safety. */
	readonly padding: number;
	/** Finite nonnegative horizontal padding; record axis, record shorthand, caller axis, caller shorthand, then 16. */
	readonly 'padding-x': number;
	/** Finite nonnegative vertical padding, with the same precedence as padding-x. */
	readonly 'padding-y': number;
	/** Finite baseline spacing multiplier, at least 1. */
	readonly 'line-height': number;
	/** Record-only caption; normalized nonblank content selects a single-line headline. */
	readonly label: string;
	/** Auto is half the fitted main font clamped to 14..18 (18 alone); fixed sizes are finite and positive. */
	readonly 'label-size': 'auto' | number;
	/** Opaque caption ink, inheriting effective main ink when omitted; no accent token. */
	readonly 'label-color': string;
	/** Caption order within the visible text block; defaults to below. */
	readonly 'label-position': 'above' | 'below';
	/** Independent caption weight; omitted record/default values follow the effective main weight. */
	readonly 'label-weight': 'normal' | 'bold';
	/** Independent caption alignment against the horizontal padded edges; defaults to center. */
	readonly 'label-align': 'left' | 'center' | 'right';
	/** Finite nonnegative gap, default 8; used only when both headline and caption are visible. */
	readonly 'label-gap': number;
}
export interface CardOptions extends CommonOutputOptions {
	readonly 'font-size': 'auto' | number;
	readonly align: 'left' | 'center' | 'right';
	/** Default ellipsis; wrap soft-wraps only the main content with fixed 1.2 line spacing. */
	readonly overflow: 'ellipsis' | 'wrap';
	readonly padding: number;
	readonly 'padding-x': number;
	readonly 'padding-y': number;
	/** Record-only literal single-line content. */
	readonly header: string;
	readonly footer: string;
	/** Auto is half the fitted main size clamped to 14..18, or 18 without main content. */
	readonly 'header-size': 'auto' | number;
	readonly 'footer-size': 'auto' | number;
	readonly 'header-color': string;
	readonly 'footer-color': string;
	readonly 'header-font': 'sans' | 'mono';
	readonly 'footer-font': 'sans' | 'mono';
	readonly 'header-weight': 'normal' | 'bold';
	readonly 'footer-weight': 'normal' | 'bold';
	/** Side alignment defaults to center independently of main alignment. */
	readonly 'header-align': 'left' | 'center' | 'right';
	readonly 'footer-align': 'left' | 'center' | 'right';
	/** Finite nonnegative main-to-side gaps, default 8; blank sides reserve no gap. */
	readonly 'header-gap': number;
	readonly 'footer-gap': number;
}
export interface ProgressOptions extends CommonOutputOptions {
	/** Independent fixed finite positive annotation font sizes; defaults 16. Fonts never shrink. */
	readonly 'value-size': number;
	readonly 'label-size': number;
	/** Opaque annotation colors or lowercase 'accent'; omitted annotations default white. */
	readonly 'value-color': string;
	readonly 'label-color': string;
	/** Independent label weight; omission follows the effective main/value weight. */
	readonly 'label-weight': 'normal' | 'bold';
	/** Finite nonnegative pair gap, default 2; ignored when either annotation is hidden. */
	readonly 'label-gap': number;
	readonly type: 'ring' | 'bar';
	/** Finite positive geometry percentage; accepted only when the requested track fits. */
	readonly scale: number;
	/** Finite positive track thickness; accepted only with drawable, contained geometry. */
	readonly thickness: number;
	readonly 'track-color': string;
	readonly label: string;
	/** Record-only literal value annotation; omission selects rounded percent, empty hides it. */
	readonly display?: string;
	readonly 'value-position': 'center' | 'above' | 'below' | 'none';
	readonly 'label-position': 'above' | 'below';
	readonly rounded: boolean;
}
export interface ResolvedTextOptions extends TextOptions {}
export interface ResolvedCardOptions extends CardOptions {}
/** Symbolic annotation colors are resolved to the effective fill color. */
export interface ResolvedProgressOptions extends ProgressOptions {
	/** Always present in resolved DTOs; undefined means the default percentage annotation. */
	readonly display: string | undefined;
}
/** Flat own-data-property DTO for the current kind; invalid defaults are ignored individually. */
export type OutputDefaults = Readonly<Partial<TextOptions | ProgressOptions | CardOptions>>;
export interface ParsedOutputCommand<T> {
	/** Text main content alone decodes wire backslash-n to LF after grammar splitting. */
	readonly value: string;
	readonly overrides: Readonly<Partial<T>>;
}
/** Strict finite decimal syntax, without exponent notation or coercion. */
export declare function parseOutputNumber(value: unknown): number | undefined;
/** Delimiter/backslash escapes apply throughout; backslash-n decodes only in text main content. */
export declare function parseOutputCommand(kind: 'text', source: unknown): ParsedOutputCommand<TextOptions> | undefined;
export declare function parseOutputCommand(kind: 'progress', source: unknown): ParsedOutputCommand<ProgressOptions> | undefined;
export declare function parseOutputCommand(kind: 'card', source: unknown): ParsedOutputCommand<CardOptions> | undefined;
export declare function resolveOutputOptions(kind: 'text', overrides?: unknown, defaults?: unknown): ResolvedTextOptions | undefined;
export declare function resolveOutputOptions(kind: 'progress', overrides?: unknown, defaults?: unknown): ResolvedProgressOptions | undefined;
export declare function resolveOutputOptions(kind: 'card', overrides?: unknown, defaults?: unknown): ResolvedCardOptions | undefined;
