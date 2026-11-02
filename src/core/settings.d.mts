import type { ExecutionPlatform } from './execution-paths.mjs';
export interface ExecutionSettings {
	executable: string;
	args: string[];
	cwd?: string;
}

export interface ExecutionSettingsInput {
	executable: string;
	args?: string[] | string;
	argsText?: string;
	cwd?: string;
	runRequested?: boolean;
	rememberRunningState?: boolean;
	/** Plugin-owned saved resume intent; not an inspector-editable field. */
	resumeRequested?: boolean;
	/** Cosmetic metadata; execution validation ignores malformed stored colors. */
	themeColor?: unknown;
	title?: unknown;
}

export interface InspectorConfiguration {
	executable: string;
	cwd: string;
	argsText?: string;
	themeColor: string;
	title: string;
	rememberRunningState?: boolean;
	diagnosticCode?: string;
}

export declare function validateSettings(input: unknown, platform?: ExecutionPlatform): ExecutionSettings;
/** Validates one execution-field edit without parsing argv or validating cwd as a launch path. */
export declare function validateExecutionEdit(key: string, value: unknown, platform?: ExecutionPlatform): void;
/** Empty/normalized blank clears the optional title; other valid strings stay literal. */
export declare function validateTitleEdit(value: unknown): string | undefined;
/** Missing defaults to true; present non-booleans reject without coercion. */
export declare function readRememberRunningState(input: unknown): boolean;
export declare function readResumeRequested(input: unknown): boolean;
/** Partial setup accepts missing/empty executable and omitted argv, validating supplied fields. Throws fixed diagnostics. */
export type SettingsClassification = { kind: 'setup' } | { kind: 'configured'; execution: ExecutionSettings };
export declare function classifySettings(input: unknown, platform?: ExecutionPlatform): SettingsClassification;
export declare function sameExecutionSettings(first: unknown, second: unknown, platform?: ExecutionPlatform): boolean;
export declare function sameSettingsExceptTheme(first: unknown, second: unknown): boolean;
export declare function sameSettingsExceptTitle(first: unknown, second: unknown): boolean;
export declare function isThemeOnlyChange(first: unknown, second: unknown): boolean;
/** Read-only one-line editor projection; valid multiline text is parsed then safely serialized. */
export declare function getInspectorConfiguration(input: unknown, platform?: ExecutionPlatform): InspectorConfiguration;
export declare function settingsDiagnosticCode(error: unknown): string;
