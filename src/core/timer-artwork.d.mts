export type TimerPresentation = 'ready' | 'waiting';
export type TimerReadyFooter = 'ready' | 'success' | 'setup required';
/** Default configured Ready artwork. */
export declare const TIMER_READY_SVG: string;
/** Matches the bundled default Loop key.svg, including its trailing newline. */
export declare const TIMER_SETUP_SVG: string;
/** Theme applies only to built-in geometry/caption; output always has opaque black background. */
/** Ready accepts TimerReadyFooter literals, otherwise ready; waiting always uses loading... and retains the caption. */
/** Optional final extension is rendered only when it fits whole; setup never inspects it. */
export declare function createTimerArtwork(presentation: TimerPresentation, caption?: unknown, themeColor?: unknown, readyFooter?: unknown, extension?: unknown): string;
