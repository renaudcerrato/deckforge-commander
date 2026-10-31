import type { ExecutionSettings } from './settings.mjs';
import type { ExecutionPlatform } from './execution-paths.mjs';
import type { OutputUpdate } from './output-update.mjs';
import type { ProcessRun, ProcessRunDiagnostic } from './process-runner.mjs';
import type { StoredSettings } from './settings-authority.mjs';
import type { LaunchPresentation, LaunchReadyFooter } from './launch-artwork.mjs';

export interface ActionSession {
	appear(settings: unknown): Promise<void>;
	/** Idle partial setup presses do not change intent, persistence, or error/recovery state. */
	press(settings?: unknown): Promise<void>;
	/** Meaningful execution edits recover only after certain cleanup and latest matching configuration confirmation. */
	applySettings(settings: unknown): Promise<void>;
	disappear(): Promise<void>;
	/** Update owning-device connectivity without changing visibility or session-local intent. */
	setConnected(connected: boolean): Promise<void>;
	/** Event-driven/idempotent reconciliation, not an execution retry after completion or failure. */
	reconcileAvailability(): Promise<void>;
	persistenceFailed(): Promise<void>;
	/** Redraw owned latest primitives/built-ins only; opaque images and execution intent are untouched. */
	refreshAppearance(): Promise<void>;
	whenIdle(): Promise<void>;
	getState(): {
		phase: 'stopped' | 'starting' | 'running' | 'stopping';
		runRequested: boolean;
		visible: boolean;
		connected: boolean;
		protocolBlocked: boolean;
		cleanupBlocked: boolean;
		persistenceBlocked: boolean;
		presentation: 'none' | 'ready' | 'waiting' | 'streaming' | 'error';
		recoveryPending: boolean;
	};
}

export interface ActionSessionDependencies {
	platform?: ExecutionPlatform;
	/** Host-reported initial availability; missing/false is unavailable. */
	initialConnected?: boolean;
	startRun: (
		settings: ExecutionSettings,
		callbacks: {
			onUpdate: (update: OutputUpdate) => void;
			onError: (message: string) => void;
			onDiagnostic: (event: ProcessRunDiagnostic) => void;
		},
	) => ProcessRun;
	setImage: (image: string, isCurrent: () => boolean) => void | Promise<void>;
	/** Clears only the plugin native caption; the producer protocol has no title command. */
	setTitle: (title: string, isCurrent: () => boolean) => void | Promise<void>;
	onError: (message: string, diagnosticCode: string | undefined, isCurrent: () => boolean, themeColor: string) => void | Promise<void>;
	/** Built-in SVG caption/theme and guarded idle footer (including setup required); native plugin title must be cleared. Recheck the guard inside async work. */
	/** Optional extension is derived only from current classified execution; it grants no execution authority. */
	onPresentation?: (kind: LaunchPresentation, caption: string, isCurrent: () => boolean, themeColor: string, readyFooter?: LaunchReadyFooter, extension?: string) => void | Promise<void>;
	/** Confirm the latest complete configuration for launch or edit recovery; production supplies the authority gate. */
	confirmLaunchSettings?: (expected: StoredSettings) => Promise<boolean>;
}

export declare function createActionSession(dependencies: ActionSessionDependencies): ActionSession;
