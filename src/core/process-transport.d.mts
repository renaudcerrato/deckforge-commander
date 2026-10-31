import type { ExecutionSettings } from './settings.mjs';

/** Root outcome is not proof that owned descendants or output readers have finished. */
export interface ProcessTransportExit {
	code: number | null;
	terminated: boolean;
}

export interface ProcessTransportCallbacks {
	onSpawn(): void;
	onStdout(chunk: Uint8Array): void;
	onStdoutEnd(): void;
	onStdoutError(): void;
	onStderr(chunk: Uint8Array): void;
	onStderrEnd(): void;
	onError(error: unknown): void;
	onExit(exit: ProcessTransportExit): void;
	/** After both readers close and all accepted byte callbacks return; no later bytes. */
	onClose(exit: ProcessTransportExit): void;
}

export interface ProcessTransport {
	/** Idempotent owned-tree cleanup, not an intentional-stop result or output-drain acknowledgment. */
	stop(): Promise<boolean>;
}

/**
 * Internal launch seam. Callbacks begin only after the factory returns. Deliver raw bytes
 * synchronously, in stream order, without decoding, dropping, or coalescing records.
 * Callback return acknowledges consumption: bound any backend queue and backpressure its
 * readers rather than accumulating an unbounded JS queue. End follows accepted bytes;
 * close follows reader completion and callback drain, independently of cleanup certainty.
 * A synchronous throw means no owned process remains. env undefined retains inheritance;
 * otherwise env is the complete detached snapshot, never an implicit overlay.
 */
export type StartProcessTransport = (
	execution: ExecutionSettings,
	callbacks: ProcessTransportCallbacks,
	env?: Readonly<Record<string, string>>,
) => ProcessTransport;
