import type { ExecutionSettings } from './settings.mjs';
import type { ProcessTransport, ProcessTransportCallbacks } from './process-transport.mjs';

export interface WindowsNativeResult {
	rootExit: boolean;
	rootCode: number;
	launchError: boolean;
	launchCode: number;
	callbackError: boolean;
	nativeError: boolean;
	/** Actual native stdout PeekNamedPipe/ReadFile failure, not setup or cleanup. */
	stdoutError: boolean;
	cleanupCertain: boolean;
}

export interface WindowsNativeBinding {
	start(snapshot: Uint8Array, callback: (kind: number, value: Uint8Array | number | undefined) => void): {
		done: Promise<WindowsNativeResult>;
		stop(): Promise<WindowsNativeResult>;
	};
}

export interface WindowsProcessTransportDependencies {
	/** Internal test/build seam only; never a persisted setting. */
	nativeBinding?: WindowsNativeBinding;
	addonPath?: string;
}

export declare function startWindowsProcessTransport(
	execution: ExecutionSettings,
	callbacks: ProcessTransportCallbacks,
	environment?: Readonly<Record<string, string>>,
	dependencies?: WindowsProcessTransportDependencies,
): ProcessTransport;
