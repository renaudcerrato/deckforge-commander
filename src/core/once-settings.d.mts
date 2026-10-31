import type { ExecutionSettings, SettingsClassification } from './settings.mjs';
import type { ExecutionPlatform } from './execution-paths.mjs';
import type { SettingsAuthority, SettingsAuthorityDependencies, StoredSettings, SaveResult } from './settings-authority.mjs';

/** Run has execution/theme configuration only, without persistent attempt or Loop controls. */
export interface OnceSettingsInput {
	executable: string;
	args?: string[] | string;
	argsText?: string;
	cwd?: string;
	themeColor?: unknown;
	title?: unknown;
}

export interface OnceConfiguration { execution: ExecutionSettings; }
export type OnceSettingsClassification = SettingsClassification;
export interface OnceConfigurationEdit {
	executable?: string;
	argsText?: string;
	cwd?: string;
	themeColor?: string;
	title?: string;
}

export interface OnceStateCoordinator {
	observe: SettingsAuthority['observe'];
	getSettings(): StoredSettings;
	editConfiguration(changes: unknown): Promise<SaveResult>;
	whenIdle(): Promise<void>;
	isBlocked(): boolean;
	getRevision(): number;
}
export type OnceStateDependencies = Omit<SettingsAuthorityDependencies, 'createSaveError' | 'onBlockedSettings'> & { platform?: ExecutionPlatform };

export declare function validateOnceSettings(input: unknown, platform?: ExecutionPlatform): OnceConfiguration;
export declare function classifyOnceSettings(input: unknown, platform?: ExecutionPlatform): OnceSettingsClassification;
export declare function sameOnceExecutionSettings(first: unknown, second: unknown, platform?: ExecutionPlatform): boolean;
export declare function applyOnceConfigurationEdit(settings: unknown, changes: unknown, platform?: ExecutionPlatform): StoredSettings;
export declare function createOnceStateCoordinator(dependencies: OnceStateDependencies): OnceStateCoordinator;
