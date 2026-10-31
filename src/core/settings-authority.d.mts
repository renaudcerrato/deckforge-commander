export type SettingsJson = null | boolean | number | string | SettingsJson[] | { [key: string]: SettingsJson };
export type StoredSettings = { [key: string]: SettingsJson };
export type SaveResult =
	| { status: 'saved'; settings: StoredSettings; revision: number }
	| { status: 'stale'; revision: number };

export interface SettingsAuthority {
	/**
	 * Safely copies input, then adopts host settings only while uninitialized, unblocked,
	 * and without pending operations. Adoption performs no write. Later observations
	 * cannot change settings, confirmation, or revision; matching readback is not
	 * durability proof. Local saves initialize authority before their writes settle.
	 */
	observe(input: unknown): { accepted: boolean; settings: StoredSettings; revision: number };
	getSettings(): StoredSettings;
	/** Safely copies a complete snapshot before comparing or retaining it. */
	save(settings: unknown): Promise<SaveResult>;
	whenIdle(): Promise<void>;
	isBlocked(): boolean;
	getRevision(): number;
	/** Exact current-snapshot confirmation, not confirmation of an obsolete write. */
	isConfirmed(): boolean;
}

export interface SettingsAuthorityDependencies {
	writeSettings(settings: StoredSettings): void | Promise<void>;
	readSettings(): unknown | Promise<unknown>;
	createSaveError(): Error;
	onFailure?(): void;
	/** Trusted action policy applied locally once on blocking, before onFailure; never written here. */
	onBlockedSettings?(settings: StoredSettings): StoredSettings;
	timeoutMs?: number;
	setTimer?(callback: () => void, delay: number): unknown;
	clearTimer?(timer: unknown): void;
}

export declare function copySettings(input: unknown): StoredSettings;
/** Synchronous comparison of detached, validated JSON; undefined is an unconfirmed sentinel. */
export declare function equalJson(first: SettingsJson | undefined, second: SettingsJson | undefined): boolean;
export declare function createSettingsAuthority(dependencies: SettingsAuthorityDependencies): SettingsAuthority;
