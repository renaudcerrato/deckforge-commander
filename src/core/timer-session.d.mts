import type { ExecutionSettings } from './settings.mjs';
import type { ExecutionPlatform } from './execution-paths.mjs';
import type { StoredSettings } from './settings-authority.mjs';
import type { OutputUpdate } from './output-update.mjs';
import type { ProcessRun, ProcessRunDiagnostic } from './process-runner.mjs';
import type { TimerPresentation, TimerReadyFooter } from './timer-artwork.mjs';

export declare const TIMER_HOLD_MS: 1000;

export interface TimerSessionState {
	enabled: boolean;
	phase: 'stopped' | 'starting' | 'running' | 'stopping' | 'waiting';
	suspended: boolean;
	visible: boolean;
	connected: boolean;
	cleanupBlocked: boolean;
	persistenceBlocked: boolean;
	protocolBlocked: boolean;
	presentation: 'none' | 'ready' | 'waiting' | 'streaming' | 'error';
	/** Memory-only completion-paced deadline, preserved across disappearance. */
	dueMs: number | undefined;
	configurationPending: boolean;
}

export interface TimerSession {
	/** Fresh sessions start disabled. Same-session returns restore their retained outcome. */
	appear(settings: unknown): Promise<void>;
	/** Duplicate/stale events are ignored. Idle setup consumes the gesture, even across configuration edits. */
	keyDown(): Promise<void>;
	/** Short release uses the latest press policy; setup taps/holds and active Refresh taps enqueue no launch or stop. */
	keyUp(): Promise<void>;
	/** Caller owns complete configuration writes; this module never persists session intent. */
	applySettings(settings: unknown): Promise<void>;
	/** Pause future launches, retain due time, and allow an owned process to finish hidden. */
	disappear(): Promise<void>;
	/** Disconnect disables and safely stops, including while hidden. Reconnect never enables. */
	setConnected(connected: boolean): Promise<void>;
	reconcileAvailability(): Promise<void>;
	/** Irrecoverable for this session, like cleanup uncertainty; reload is outside this module. */
	persistenceFailed(): Promise<void>;
	/** Preserve explicit primitive overrides. Never redraw opaque producer images. */
	refreshAppearance(): Promise<void>;
	/** Drain current operations/images, not future deadlines or a running process's done promise. */
	whenIdle(): Promise<void>;
	getState(): TimerSessionState;
}

export interface TimerSessionDependencies {
	platform?: ExecutionPlatform;
	initialConnected?: boolean;
	now?: () => number;
	setTimer?: (callback: () => void, delayMs: number) => unknown;
	clearTimer?: (timer: unknown) => void;
	startRun: (settings: ExecutionSettings, callbacks: {
		onUpdate: (update: OutputUpdate) => void;
		onError: (message: string) => void;
		onDiagnostic: (event: ProcessRunDiagnostic) => void;
	}) => ProcessRun;
	/** Required authoritative gate. Await coordinator.whenIdle(), reject blocked authority,
	 * and compare its latest complete snapshot/revision with this detached expected snapshot.
	 * First adopted host settings may confirm without a write. A cached SDK read is not an ACK.
	 * False/rejection for the still-current snapshot permanently blocks this session.
	 */
	awaitConfiguration: (expected: StoredSettings) => Promise<boolean>;
	/** All display callbacks must recheck isCurrent inside their async SDK boundary. */
	setImage: (image: string, isCurrent: () => boolean) => void | Promise<void>;
	setTitle: (title: string, isCurrent: () => boolean) => void | Promise<void>;
	onError: (message: string, diagnosticCode: string | undefined, isCurrent: () => boolean, themeColor: string) => void | Promise<void>;
	/** Setup uses the existing Ready kind with a guarded setup required footer, never launch authority. */
	/** Optional extension comes only from current validated execution, not arguments or producer output. */
	onPresentation?: (kind: TimerPresentation, caption: string, isCurrent: () => boolean,
		themeColor: string, readyFooter?: TimerReadyFooter, extension?: string) => void | Promise<void>;
}

export declare function createTimerSession(dependencies: TimerSessionDependencies): TimerSession;
