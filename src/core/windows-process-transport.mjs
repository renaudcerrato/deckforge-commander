import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { types } from 'node:util';

const require = createRequire(import.meta.url);
const MAGIC = 0x44574654;
const MAX_SNAPSHOT_BYTES = 1_048_576;
const OS_CODES = new Map([
  [2, 'ENOENT'], [3, 'ENOENT'], [5, 'EACCES'], [32, 'EACCES'],
  [267, 'ENOTDIR'], [193, 'ENOEXEC'], [216, 'ENOEXEC'],
  [8, 'EAGAIN'], [14, 'EAGAIN'], [87, 'EINVAL'], [206, 'EINVAL'],
]);

function invalid() {
  return Object.assign(new Error('Program launch failed.'), { code: 'EINVAL' });
}

function descriptors(value) {
  if (value === null || typeof value !== 'object' || types.isProxy(value)) throw invalid();
  const properties = Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(properties)) {
    if (!Object.hasOwn(descriptor, 'value')) throw invalid();
  }
  return properties;
}

function text(value) {
  if (typeof value !== 'string' || value.includes('\0')) throw invalid();
  return value;
}

function drivePath(value) {
  const result = text(value);
  if (!/^[a-z]:[\\/]/i.test(result)) throw invalid();
  return result;
}

/** Private binary boundary: no getters, coercion, proxy traps or mutable input survives. */
function snapshot(execution, environment) {
  const settings = descriptors(execution);
  const executable = drivePath(settings.executable?.value);
  const args = settings.args?.value;
  if (!Array.isArray(args) || types.isProxy(args)) throw invalid();
  const argumentProperties = descriptors(args);
  const count = argumentProperties.length.value;
  if (count > MAX_SNAPSHOT_BYTES / 4) throw invalid();
  const argumentsCopy = [];
  for (let i = 0; i < count; i++) argumentsCopy.push(text(argumentProperties[i]?.value));
  const cwd = settings.cwd?.value;
  if (cwd !== undefined) drivePath(cwd);
  // Inheritance is captured now, not later on the native launch thread.
  const environmentProperties = descriptors(environment === undefined ? process.env : environment);
  const pairs = Object.entries(environmentProperties).map(([key, descriptor]) => {
    if (!key || key.includes('=') || key.includes('\0')) throw invalid();
    return [key, text(descriptor.value)];
  });
  const strings = [executable, ...(cwd === undefined ? [] : [cwd]), ...argumentsCopy, ...pairs.flat()];
  const size = strings.reduce((total, value) => total + 4 + value.length * 2, 16);
  if (size > MAX_SNAPSHOT_BYTES) throw invalid();
  const bytes = Buffer.alloc(size);
  bytes.writeUInt32LE(MAGIC, 0);
  bytes.writeUInt32LE(count, 4);
  bytes.writeUInt32LE(pairs.length, 8);
  bytes.writeUInt32LE(cwd === undefined ? 0 : 1, 12);
  let offset = 16;
  for (const value of strings) {
    bytes.writeUInt32LE(value.length, offset);
    offset += 4;
    // Explicit UTF-16 units preserve literal argv, including unpaired surrogates.
    for (let i = 0; i < value.length; i++, offset += 2) bytes.writeUInt16LE(value.charCodeAt(i), offset);
  }
  return bytes;
}

function launchError(code) {
  return Object.assign(new Error('Program launch failed.'), {
    code: OS_CODES.get(code) ?? 'UNKNOWN', errno: code, syscall: 'CreateProcessW',
  });
}

/** Windows x64 only. The binary is loaded at start, never at module import on macOS. */
export function startWindowsProcessTransport(execution, callbacks, environment, dependencies = {}) {
  if (!dependencies.nativeBinding && (process.platform !== 'win32' || process.arch !== 'x64')) {
    throw Object.assign(new Error('Program launch failed.'), { code: 'ENOEXEC' });
  }
  const bytes = snapshot(execution, environment);
  let binding = dependencies.nativeBinding;
  if (!binding) {
    const relative = import.meta.url.endsWith('/src/core/windows-process-transport.mjs')
      ? '../../.task/native/win32-x64/transport.node'
      : './native/win32-x64/transport.node';
    try { binding = require(dependencies.addonPath ?? fileURLToPath(new URL(relative, import.meta.url))); }
    catch { throw Object.assign(new Error('Program launch failed.'), { code: 'ENOEXEC' }); }
  }
  let closed = false;
  let exit = { code: null, terminated: false };
  const run = binding.start(bytes, (kind, value) => {
    if (closed) return;
    switch (kind) {
      case 0: callbacks.onSpawn(); break;
      case 1: callbacks.onStdout(value); break;
      case 2: callbacks.onStderr(value); break;
      case 3:
        exit = { code: value, terminated: false };
        callbacks.onExit(exit);
        break;
    }
  });
  // Native delivery is asynchronous; no JS buffering sits between the bounded
  // native queue and synchronous consumption by the common runner.
  const finished = run.done.then(result => {
    if (result.launchError) callbacks.onError(launchError(result.launchCode));
    if (result.callbackError || result.stdoutError) callbacks.onStdoutError();
    else if (result.nativeError && result.cleanupCertain && !result.launchError) {
      // Non-stdout runtime failures use the existing generic error boundary.
      // Uncertain owned cleanup is reported solely by the boolean stop result;
      // neither class may manufacture the shared runner's protocol priority.
      callbacks.onError(Object.assign(new Error('Program launch failed.'), { code: 'UNKNOWN' }));
    }
    if (!closed) {
      if (result.rootExit) exit = { code: result.rootCode, terminated: false };
      callbacks.onStdoutEnd();
      callbacks.onStderrEnd();
      closed = true;
      callbacks.onClose(exit);
    }
    return result.cleanupCertain === true;
  }).catch(() => false);
  let stopping;
  return {
    stop() {
      if (stopping) return stopping;
      // Publish before invoking native cancellation; stale handles own only their run.
      stopping = Promise.resolve().then(() => run.stop()).then(() => finished).catch(() => false);
      return stopping;
    },
  };
}
