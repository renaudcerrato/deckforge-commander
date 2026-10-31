import type { TimerSessionDependencies } from './timer-session.mjs';

export declare const ONCE_HOLD_MS: 1000;
export interface OnceSessionState {
	phase: 'stopped' | 'starting' | 'running' | 'stopping';
	suspended: boolean;
	visible: boolean;
	connected: boolean;
	cleanupBlocked: boolean;
	persistenceBlocked: boolean;
	protocolBlocked: boolean;
	presentation: 'none' | 'ready' | 'loading' | 'streaming' | 'error';
	configurationPending: boolean;
}
export interface OnceSession {
	/** Fresh and returning sessions never launch from availability. */
	appear(settings: unknown): Promise<void>;
	keyDown(): Promise<void>;
	/** Short release requests one attempt; busy taps are consumed and holds stop without launching. */
	keyUp(): Promise<void>;
	applySettings(settings: unknown): Promise<void>;
	/** Cancel a pending start; an owned child may finish hidden, retaining its outcome. */
	disappear(): Promise<void>;
	setConnected(connected: boolean): Promise<void>;
	reconcileAvailability(): Promise<void>;
	persistenceFailed(): Promise<void>;
	refreshAppearance(): Promise<void>;
	whenIdle(): Promise<void>;
	getState(): OnceSessionState;
}
/** Same injected process, display, clock and authoritative configuration boundaries as Loop. */
export type OncePresentation = 'ready' | 'loading';
export type OnceReadyFooter = 'ready' | 'success' | 'setup required';
export interface OnceSessionDependencies extends Omit<TimerSessionDependencies, 'onPresentation'> {
	onPresentation?: (kind: OncePresentation, caption: string, isCurrent: () => boolean,
		themeColor: string, readyFooter?: OnceReadyFooter, extension?: string) => void | Promise<void>;
}
export declare function createOnceSession(dependencies: OnceSessionDependencies): OnceSession;
