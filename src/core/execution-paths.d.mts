export type ExecutionPlatform = 'win32' | 'posix';
export declare function executionPlatform(): ExecutionPlatform;
export declare function isAbsoluteExecutionPath(value: unknown, platform?: ExecutionPlatform): boolean;
export declare function executionBasename(value: unknown, platform?: ExecutionPlatform): string | undefined;
