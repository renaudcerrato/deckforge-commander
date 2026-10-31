import type { StoredSettings as StoredRunSettings, SaveResult } from './settings-authority.mjs';
import type { ExecutionPlatform } from './execution-paths.mjs';
export type { SettingsJson, StoredSettings as StoredRunSettings, SaveResult } from './settings-authority.mjs';
export interface ConfigurationEdit { executable?: string; argsText?: string; cwd?: string; themeColor?: string; title?: string }

export interface RunStateCoordinator {
	/**
	 * Safely copies input, then adopts host settings only while uninitialized, unblocked,
	 * and without pending operations. Adoption performs no write. Once initialized by
	 * observation or a local save/edit, all later observations return accepted:false
	 * without changing settings, confirmation, or revision. External restorations
	 * apply only to a fresh coordinator; readback matching is not durability proof.
	 */
	observe(input: unknown): { accepted: boolean; settings: StoredRunSettings; revision: number };
	getSettings(): StoredRunSettings;
	editConfiguration(changes: unknown): Promise<SaveResult>;
	whenIdle(): Promise<void>;
	isBlocked(): boolean;
	getRevision(): number;
}

export interface RunStateDependencies {
	platform?: ExecutionPlatform;
	writeSettings(settings: StoredRunSettings): void | Promise<void>;
	readSettings(): unknown | Promise<unknown>;
	onFailure?(): void;
	timeoutMs?: number;
	setTimer?(callback: () => void, delay: number): unknown;
	clearTimer?(timer: unknown): void;
}

export declare function copyRunSettings(input: unknown): StoredRunSettings;
/** Edits preserve legacy intent unchanged; cosmetic-only edits never synthesize argv. */
export declare function applyConfigurationEdit(settings: unknown, changes: unknown, platform?: ExecutionPlatform): StoredRunSettings;
export declare function createRunStateCoordinator(dependencies: RunStateDependencies): RunStateCoordinator;
