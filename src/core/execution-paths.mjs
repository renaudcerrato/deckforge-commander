/** Browser-safe default; the inspector supplies its SDK registration platform explicitly. */
export function executionPlatform() {
  return typeof process !== 'undefined' && process.platform === 'win32' ? 'win32' : 'posix';
}

export function isAbsoluteExecutionPath(value, platform = executionPlatform()) {
  if (typeof value !== 'string' || value.includes('\0')) return false;
  return platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(value) : value.startsWith('/');
}

/** Never normalize stored paths or argv; only select the platform's basename separators. */
export function executionBasename(value, platform = executionPlatform()) {
  if (!isAbsoluteExecutionPath(value, platform)) return undefined;
  const separator = platform === 'win32'
    ? Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\')) : value.lastIndexOf('/');
  return value.slice(separator + 1);
}
