export type LaunchPresentation = 'ready' | 'waiting';
export type LaunchReadyFooter = 'ready' | 'exited' | 'setup required';
/** Default configured Ready artwork. */
export declare const READY_SVG: string;
/** Matches the bundled default key.svg, including its trailing newline. */
export declare const SETUP_SVG: string;
/** Theme applies only to built-in geometry/caption; output always has opaque black background. */
/** Ready accepts LaunchReadyFooter literals, otherwise ready; waiting always uses loading... and retains the caption. */
/** Optional final extension is rendered only when it fits whole; setup never inspects it. */
export declare function createLaunchArtwork(presentation: LaunchPresentation, caption?: unknown, themeColor?: unknown, readyFooter?: unknown, extension?: unknown): string;
export declare function formatLaunchCaption(value: unknown): string;
/** Normalized SVG basename without its final extension; dotfiles stay intact. Never a native title. */
export declare function getReadyTitle(executable: unknown, platform?: import('./execution-paths.mjs').ExecutionPlatform, title?: unknown): string;
/** Final executable suffix only, lowercase with its dot; invalid inputs and suffixless names return undefined. */
export declare function getExecutableExtension(executable: unknown): string | undefined;
