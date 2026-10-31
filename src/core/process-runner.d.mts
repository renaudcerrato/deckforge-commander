import type { PosixProcessTransportDependencies } from './posix-process-transport.mjs';
import type { StartProcessTransport } from './process-transport.mjs';
import type { ExecutionSettings } from './settings.mjs';
import type { OutputUpdate } from './output-update.mjs';
import type { ProcessRunLaunchOptions } from './launch-environment.mjs';
export type { ProcessRunLaunchOptions } from './launch-environment.mjs';

export type ProcessRunResult =
	| { status: 'success' | 'stopped' }
	| { status: 'error'; error: string };

export type ProcessRunDiagnostic =
	| 'PROCESS_SPAWN_SUCCEEDED'
	| 'PROCESS_STDOUT_FIRST_DATA'
	| 'PROCESS_STDERR_FIRST_DATA'
	| 'PROCESS_IMAGE_RECORD_PARSED'
	| 'PROCESS_PROTOCOL_REJECTED'
	| 'PROCESS_LAUNCH_FAILED'
	| 'PROCESS_LAUNCH_REASON_ENOENT'
	| 'PROCESS_LAUNCH_REASON_EACCES'
	| 'PROCESS_LAUNCH_REASON_ENOTDIR'
	| 'PROCESS_LAUNCH_REASON_ENOEXEC'
	| 'PROCESS_LAUNCH_REASON_EAGAIN'
	| 'PROCESS_LAUNCH_REASON_EINVAL'
	| 'PROCESS_LAUNCH_REASON_UNKNOWN'
	| 'PROCESS_EXITED_SUCCESSFULLY'
	| 'PROCESS_EXITED_NONZERO'
	| 'PROCESS_TERMINATED_BY_SIGNAL'
	| 'PROCESS_RUN_COMPLETED_AFTER_STOP_REQUEST';

export interface ProcessRun {
	done: Promise<ProcessRunResult>;
	stop(): Promise<boolean>;
}

export interface ProcessRunCallbacks {
	/** Complete drawable record; invalid primitives skip, malformed images/framing fail. */
	onUpdate: (update: OutputUpdate) => void;
	onError: (message: string) => void;
	onDiagnostic?: (event: ProcessRunDiagnostic) => void;
	/** Receives a bounded, single-line JSON-encoded stderr excerpt. */
	onStderrExcerpt?: (escapedExcerpt: string) => void;
	/** Receives one bounded, single-line JSON record of owned OS launch-error fields. */
	onLaunchError?: (encodedDetails: string) => void;
}

export interface ProcessRunDependencies extends PosixProcessTransportDependencies {
	/** Internal alternate backend; otherwise Windows x64 uses native ownership, macOS stays POSIX. */
	startTransport?: StartProcessTransport;
}

export declare function startProcessRun(
	settings: ExecutionSettings,
	callbacks: ProcessRunCallbacks,
	dependencies?: ProcessRunDependencies,
	launchOptions?: ProcessRunLaunchOptions,
): ProcessRun;
