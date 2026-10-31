import type { OutputUpdate } from './output-update.mjs';

/** Validates and freezes a readonly output DTO without invoking accessors or proxy traps. */
/** Invalid images, primitive data, or infeasible artwork return undefined without replacing a frame. */
export declare function snapshotOutput(input: unknown): OutputUpdate | undefined;
