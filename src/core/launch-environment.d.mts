import type { ExecutionPlatform } from './execution-paths.mjs';
/** Scalar launch snapshot projected from public SDK fields and per-action settings. */
export interface LaunchMetadata {
	pluginUuid?: string;
	pluginVersion?: string;
	actionUuid?: string;
	actionContext?: string;
	/** Per-action settings theme, not an SDK field; only six-digit hex is exported. */
	actionThemeColor?: string;
	deviceId?: string;
	deviceName?: string;
	deviceType?: number;
	/** Device grid slots, not pixels. */
	deviceColumns?: number;
	deviceRows?: number;
	/** SDK coordinates, omitted for multi-actions. */
	keyColumn?: number;
	keyRow?: number;
	appVersion?: string;
	appLanguage?: string;
	appPlatform?: string;
	appPlatformVersion?: string;
}

export type LaunchEnvironment = Record<string, string>;

export interface ProcessRunLaunchOptions {
	/** Complete environment, not a patch; detached again before spawn. */
	env: Readonly<LaunchEnvironment>;
}

/** Invalid metadata fields are individually omitted; inherited owned names are always removed. */
export declare function createLaunchEnvironment(
	inheritedEnvironment: Readonly<NodeJS.ProcessEnv>,
	metadata: LaunchMetadata,
	platform?: ExecutionPlatform,
): LaunchEnvironment;

/** Reject malformed options with a fixed error and never invoke data-object getters or coercions. */
export declare function validateLaunchOptions(input: unknown, platform?: ExecutionPlatform): LaunchEnvironment | undefined;
