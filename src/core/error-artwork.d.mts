export type ErrorArtworkDiagnostic =
	| 'MISSING_EXECUTABLE'
	| 'INVALID_EXECUTABLE'
	| 'MISSING_ARGS'
	| 'ARGS_NOT_ARRAY'
	| 'ARGS_JSON_INVALID'
	| 'ARGS_TEXT_INVALID'
	| 'INVALID_ARGUMENT'
	| 'INVALID_CWD'
	| 'PROCESS_LAUNCH_FAILED'
	| 'PROCESS_LAUNCH_REASON_ENOENT'
	| 'PROCESS_LAUNCH_REASON_EACCES'
	| 'PROCESS_LAUNCH_REASON_ENOTDIR'
	| 'PROCESS_LAUNCH_REASON_ENOEXEC'
	| 'PROCESS_LAUNCH_REASON_EAGAIN'
	| 'PROCESS_LAUNCH_REASON_EINVAL'
	| 'PROCESS_LAUNCH_REASON_UNKNOWN'
	| 'PROCESS_EXITED_NONZERO'
	| 'PROCESS_TERMINATED_BY_SIGNAL'
	| 'PROCESS_PROTOCOL_REJECTED'
	| 'IMAGE_PROTOCOL_ERROR'
	| 'CLEANUP_BLOCKED'
	| 'FRAME_SEND_FAILED'
	| 'STATE_SAVE_FAILED';

/** Pure-black SVG with 16-unit labels/reasons and fixed allowlisted diagnoses. */
/** Only the rounded border is themed; warning/code stay red and reasons stay white. */
export declare function createErrorArtwork(diagnosticCode: unknown, themeColor?: unknown): string;
