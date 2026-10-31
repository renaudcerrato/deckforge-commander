export type OncePresentation = 'ready' | 'loading';
export type OnceReadyFooter = 'ready' | 'success' | 'setup required';
/** Default configured Ready artwork. */
export declare const ONCE_READY_SVG: string;
/** Matches the bundled default Run key.svg, including its trailing newline. */
export declare const ONCE_SETUP_SVG: string;
/** Strict/fallback theme and opaque black background; never a producer-image overlay. */
/** Ready accepts OnceReadyFooter literals, otherwise ready; loading always uses the loading... footer. */
/** Optional final extension renders only when it fits whole; setup never inspects it. */
export declare function createOnceArtwork(presentation: OncePresentation, caption?: unknown, themeColor?: unknown, readyFooter?: unknown, extension?: unknown): string;
