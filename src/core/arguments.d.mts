import type { ExecutionPlatform } from './execution-paths.mjs';

/**
 * Parse platform argument text (not legacy JSON); blank text returns [].
 * POSIX uses shlex; Windows keeps backslashes literal outside explicit ANSI-C quotes.
 * Throws Error('Invalid arguments.') with diagnosticCode 'ARGS_TEXT_INVALID'.
 */
export declare function parseArguments(text: unknown, platform?: ExecutionPlatform): string[];

/**
 * Serialize dense NUL-free string arrays, preserving empty arguments and order.
 * Contains no literal CR/LF and round-trips with the same platform grammar.
 * POSIX uses stock shlex quoting except for ANSI-C-encoded line breaks;
 * Windows uses literal ordinary quotes or explicit ANSI-C quoting as needed.
 * Throws Error('Invalid arguments.') with diagnosticCode 'INVALID_ARGUMENT'.
 */
export declare function serializeArguments(argv: unknown, platform?: ExecutionPlatform): string;
