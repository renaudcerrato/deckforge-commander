import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { ExecutionSettings } from './settings.mjs';
import type { ProcessTransport, ProcessTransportCallbacks } from './process-transport.mjs';

export interface PosixProcessTransportDependencies {
	spawn?: (executable: string, args: string[], options: SpawnOptions) => ChildProcess;
	signalGroup?: (pid: number, signal: NodeJS.Signals) => void;
	waitForGroupExit?: (pid: number, timeoutMs: number) => boolean | Promise<boolean>;
}

export declare function startPosixProcessTransport(
	execution: ExecutionSettings,
	callbacks: ProcessTransportCallbacks,
	env?: Readonly<Record<string, string>>,
	dependencies?: PosixProcessTransportDependencies,
): ProcessTransport;
