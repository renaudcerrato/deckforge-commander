import type { ExecutionSettings, InspectorConfiguration } from './settings.mjs';
import type { ExecutionPlatform } from './execution-paths.mjs';
import type { SettingsAuthority, SettingsAuthorityDependencies, StoredSettings, SaveResult } from './settings-authority.mjs';

export declare const DEFAULT_INTERVAL_SECONDS: 60;
export declare const MIN_INTERVAL_SECONDS: 1;
export declare const MAX_INTERVAL_SECONDS: 86400;
export declare const DEFAULT_ACTION_ON_PRESS: 'refresh';

export type TimerActionOnPress = 'refresh' | 'stop';

/** No persistent enabled state or Run intent belongs to Timer settings. */
export interface TimerSettingsInput {
	executable: string;
	args?: string[] | string;
	argsText?: string;
	cwd?: string;
	themeColor?: unknown;
	title?: unknown;
	/** Whole numeric seconds, 1..86400; omission reads as 60 without writing. */
	intervalSeconds?: number;
	/** Omission reads as Refresh without writing; only the two exact enum strings are valid. */
	actionOnPress?: TimerActionOnPress;
}

export interface TimerConfiguration {
	execution: ExecutionSettings;
	intervalSeconds: number;
	actionOnPress: TimerActionOnPress;
}

export interface TimerInspectorConfiguration extends InspectorConfiguration {
	/** Absent for invalid stored intervals; diagnosticCode reports the failure. */
	intervalSeconds?: number;
	/** Absent for an invalid stored policy; diagnosticCode reports the failure. */
	actionOnPress?: TimerActionOnPress;
}

export interface TimerConfigurationEdit {
	executable?: string;
	argsText?: string;
	cwd?: string;
	themeColor?: string;
	title?: string;
	intervalSeconds?: number;
	actionOnPress?: TimerActionOnPress;
}

export interface TimerStateCoordinator {
	/** Shared authority's adopt-once, detached, no-hydration-write contract. */
	observe: SettingsAuthority['observe'];
	getSettings(): StoredSettings;
	/** Only allowlisted control edits; no complete replacement or persisted intent API. */
	editConfiguration(changes: unknown): Promise<SaveResult>;
	whenIdle(): Promise<void>;
	isBlocked(): boolean;
	getRevision(): number;
}

export type TimerStateDependencies = Omit<SettingsAuthorityDependencies, 'createSaveError' | 'onBlockedSettings'> & { platform?: ExecutionPlatform };

export declare function readIntervalSeconds(input: unknown): number;
export declare function readActionOnPress(input: unknown): TimerActionOnPress;
export declare function validateTimerSettings(input: unknown, platform?: ExecutionPlatform): TimerConfiguration;
/** Setup is display-only and never contains launch execution. Defaults are read-only. */
export type TimerSettingsClassification =
	| { kind: 'setup'; intervalSeconds: number; actionOnPress: TimerActionOnPress }
	| ({ kind: 'configured' } & TimerConfiguration);
export declare function classifyTimerSettings(input: unknown, platform?: ExecutionPlatform): TimerSettingsClassification;
/** Compares execution independently of interval/press policy/theme, including equivalent argv migration. */
export declare function sameTimerExecutionSettings(first: unknown, second: unknown, platform?: ExecutionPlatform): boolean;
/** Missing interval and explicit 60 have the same effective timing. Invalid values never compare equal. */
export declare function sameTimerInterval(first: unknown, second: unknown): boolean;
export declare function getTimerInspectorConfiguration(input: unknown, platform?: ExecutionPlatform): TimerInspectorConfiguration;
export declare function applyTimerConfigurationEdit(settings: unknown, changes: unknown, platform?: ExecutionPlatform): StoredSettings;
export declare function timerSettingsDiagnosticCode(error: unknown): string;
/** On persistence failure, blocks without changing configuration or adding session-state fields. */
export declare function createTimerStateCoordinator(dependencies: TimerStateDependencies): TimerStateCoordinator;
