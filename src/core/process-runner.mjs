import { startPosixProcessTransport } from './posix-process-transport.mjs';
import { startWindowsProcessTransport } from './windows-process-transport.mjs';
import { types as nodeTypes } from 'node:util';
import { validateSettings } from './settings.mjs';
import { createImageLineFramer } from './image-lines.mjs';
import { parseOutputUpdate } from './output-update.mjs';
import { createPrimitiveArtwork } from './primitive-artwork.mjs';
import { validateLaunchOptions } from './launch-environment.mjs';

const ERRORS = {
  invalidSettings: 'Invalid settings.',
  launch: 'Program launch failed.',
  exit: 'Program exited unsuccessfully.',
  protocol: 'Image protocol error.',
  cleanup: 'Process cleanup uncertain.',
  display: 'Frame send failed.',
};
const DIAGNOSTICS = {
  spawnSucceeded: 'PROCESS_SPAWN_SUCCEEDED',
  firstStdoutData: 'PROCESS_STDOUT_FIRST_DATA',
  firstStderrData: 'PROCESS_STDERR_FIRST_DATA',
  firstImageParsed: 'PROCESS_IMAGE_RECORD_PARSED',
  protocolRejected: 'PROCESS_PROTOCOL_REJECTED',
  launchFailed: 'PROCESS_LAUNCH_FAILED',
  launchReasonEnoent: 'PROCESS_LAUNCH_REASON_ENOENT',
  launchReasonEacces: 'PROCESS_LAUNCH_REASON_EACCES',
  launchReasonEnotdir: 'PROCESS_LAUNCH_REASON_ENOTDIR',
  launchReasonEnoexec: 'PROCESS_LAUNCH_REASON_ENOEXEC',
  launchReasonEagain: 'PROCESS_LAUNCH_REASON_EAGAIN',
  launchReasonEinval: 'PROCESS_LAUNCH_REASON_EINVAL',
  launchReasonUnknown: 'PROCESS_LAUNCH_REASON_UNKNOWN',
  exitedSuccessfully: 'PROCESS_EXITED_SUCCESSFULLY',
  exitedNonzero: 'PROCESS_EXITED_NONZERO',
  terminatedBySignal: 'PROCESS_TERMINATED_BY_SIGNAL',
  completedAfterStopRequest: 'PROCESS_RUN_COMPLETED_AFTER_STOP_REQUEST',
};
const LAUNCH_REASON_DIAGNOSTICS = new Map([
  ['ENOENT', DIAGNOSTICS.launchReasonEnoent],
  ['EACCES', DIAGNOSTICS.launchReasonEacces],
  ['ENOTDIR', DIAGNOSTICS.launchReasonEnotdir],
  ['ENOEXEC', DIAGNOSTICS.launchReasonEnoexec],
  ['EAGAIN', DIAGNOSTICS.launchReasonEagain],
  ['EINVAL', DIAGNOSTICS.launchReasonEinval],
]);
// These bounded launch-only OS fields are explicitly user-authorized.
const LAUNCH_ERROR_FIELDS = ['code', 'errno', 'syscall', 'path', 'message'];
const LAUNCH_ERROR_FIELD_MAX_BYTES = 4_096;
const LAUNCH_ERROR_FIELD_TRUNCATION_SUFFIX = '[TRUNCATED]';
const LAUNCH_ERROR_DETAILS_FALLBACK = '{"details":"UNSAFE_OR_UNAVAILABLE"}';
const STDERR_EXCERPT_MAX_BYTES = 2_048;
const STDERR_EXCERPT_TRUNCATION_SUFFIX = ' [TRUNCATED]';

// This bounded stderr excerpt is explicitly user-authorized; keep its cap and escaping fixed.
function encodeStderrExcerpt(bytes, length, truncated) {
  const encoded = JSON.stringify(bytes.subarray(0, length).toString('utf8'))
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, character => (
      `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
    ));
  return truncated ? `${encoded}${STDERR_EXCERPT_TRUNCATION_SUFFIX}` : encoded;
}

function launchReasonDiagnostic(error) {
  try {
    if (error === null || typeof error !== 'object' || nodeTypes.isProxy(error)) {
      return DIAGNOSTICS.launchReasonUnknown;
    }
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') {
      return DIAGNOSTICS.launchReasonUnknown;
    }
    return LAUNCH_REASON_DIAGNOSTICS.get(descriptor.value) ?? DIAGNOSTICS.launchReasonUnknown;
  } catch {
    return DIAGNOSTICS.launchReasonUnknown;
  }
}

function boundLaunchErrorField(value) {
  const suffix = LAUNCH_ERROR_FIELD_TRUNCATION_SUFFIX;
  const contentLimit = LAUNCH_ERROR_FIELD_MAX_BYTES - Buffer.byteLength(suffix, 'utf8');
  let byteLength = 0;
  let end = 0;

  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (byteLength + characterBytes > contentLimit) {
      return `${value.slice(0, end)}${suffix}`;
    }
    byteLength += characterBytes;
    end += character.length;
  }
  return value;
}

function encodeLaunchErrorDetails(error) {
  try {
    if (error === null || typeof error !== 'object' || nodeTypes.isProxy(error)) {
      return LAUNCH_ERROR_DETAILS_FALLBACK;
    }

    const details = {};
    for (const field of LAUNCH_ERROR_FIELDS) {
      const descriptor = Object.getOwnPropertyDescriptor(error, field);
      if (!descriptor) continue;
      if (!Object.hasOwn(descriptor, 'value')) return LAUNCH_ERROR_DETAILS_FALLBACK;

      const value = descriptor.value;
      if (typeof value === 'string') {
        details[field] = boundLaunchErrorField(value);
      } else if (typeof value === 'number' && Number.isFinite(value)) {
        details[field] = value;
      } else if (value !== undefined) {
        return LAUNCH_ERROR_DETAILS_FALLBACK;
      }
    }

    return JSON.stringify(details).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, character => (
      `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
    ));
  } catch {
    return LAUNCH_ERROR_DETAILS_FALLBACK;
  }
}

function notify(onError, message, reported) {
  if (reported.has(message)) return;
  reported.add(message);
  try {
    onError(message);
  } catch {
    // Diagnostics must not surface callback or process details.
  }
}

function failedRun(message, onError) {
  const reported = new Set();
  notify(onError, message, reported);
  return {
    done: Promise.resolve({ status: 'error', error: message }),
    stop: async () => true,
  };
}

/** Run one explicitly configured executable and frame its bounded stdout output updates. */
export function startProcessRun(settings, callbacks, dependencies = {}, launchOptions) {
  let execution;
  try {
    execution = validateSettings(settings);
  } catch {
    return failedRun(ERRORS.invalidSettings, callbacks.onError);
  }

  const reportedErrors = new Set();
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  let transport;
  let completed = false;
  let closeSeen = false;
  let exitSeen = false;
  let closeCode;
  let closeTerminated;
  let spawnSeen = false;
  let stopRequestedBeforeExit = false;
  let stdoutFinished = false;
  let protocolFailed = false;
  let stopRequested = false;
  let launchFailed = false;
  let stopPromise;
  let cleanupPromise;
  let cleanupSettled = false;
  let cleanupCertain = true;
  let terminalError;
  const reportedDiagnostics = new Set();
  let stderrExcerptBytes;
  let stderrExcerptLength = 0;
  let stderrExcerptTruncated = false;
  let stderrExcerptClosed = false;
  let launchReasonReported = false;

  function notifyDiagnostic(event) {
    if (reportedDiagnostics.has(event)) return;
    reportedDiagnostics.add(event);
    try {
      callbacks.onDiagnostic?.(event);
    } catch {
      // Diagnostics must not affect process behavior or expose callback details.
    }
  }

  function notifyLaunchReason(error) {
    if (launchReasonReported) return;
    launchReasonReported = true;
    notifyDiagnostic(launchReasonDiagnostic(error));
    try {
      const callback = callbacks.onLaunchError;
      if (typeof callback === 'function') callback(encodeLaunchErrorDetails(error));
    } catch {
      // Launch-error detail reporting must not affect process behavior.
    }
  }

  function captureStderr(chunk) {
    notifyDiagnostic(DIAGNOSTICS.firstStderrData);
    if (stderrExcerptClosed || typeof callbacks.onStderrExcerpt !== 'function') return;

    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const available = STDERR_EXCERPT_MAX_BYTES - stderrExcerptLength;
    const copied = Math.min(bytes.length, available);
    if (copied > 0) {
      stderrExcerptBytes ??= Buffer.alloc(STDERR_EXCERPT_MAX_BYTES);
      bytes.copy(stderrExcerptBytes, stderrExcerptLength, 0, copied);
      stderrExcerptLength += copied;
    }
    if (copied < bytes.length) stderrExcerptTruncated = true;
  }

  function completeStderrExcerpt() {
    if (stderrExcerptClosed) return;
    stderrExcerptClosed = true;

    const bytes = stderrExcerptBytes;
    const length = stderrExcerptLength;
    const truncated = stderrExcerptTruncated;
    stderrExcerptBytes = undefined;
    stderrExcerptLength = 0;
    stderrExcerptTruncated = false;
    if (!bytes || length === 0) return;

    const excerpt = encodeStderrExcerpt(bytes, length, truncated);
    try {
      callbacks.onStderrExcerpt?.(excerpt);
    } catch {
      // Excerpt logging must not affect process behavior or expose callback details.
    }
  }

  function notifyError(message) {
    notify(callbacks.onError, message, reportedErrors);
  }

  function finish(result) {
    if (completed) return;
    completed = true;
    resolveDone(result);
  }

  function maybeFinish() {
    if (completed || !closeSeen || !cleanupSettled) return;
    finishStdout();

    if (!protocolFailed && !stopRequested && !launchFailed
      && terminalError !== ERRORS.display && !(closeCode === 0 && !closeTerminated)) {
      notifyError(ERRORS.exit);
      terminalError ??= ERRORS.exit;
    }

    if (stopRequestedBeforeExit) {
      if (spawnSeen) notifyDiagnostic(DIAGNOSTICS.completedAfterStopRequest);
    } else if (spawnSeen && !launchFailed) {
      if (closeCode === 0 && !closeTerminated) {
        notifyDiagnostic(DIAGNOSTICS.exitedSuccessfully);
      } else {
        notifyDiagnostic(closeTerminated
          ? DIAGNOSTICS.terminatedBySignal
          : DIAGNOSTICS.exitedNonzero);
      }
    }

    if (protocolFailed) {
      finish({ status: 'error', error: ERRORS.protocol });
    } else if (!cleanupCertain) {
      finish({ status: 'error', error: ERRORS.cleanup });
    } else if (terminalError) {
      finish({ status: 'error', error: terminalError });
    } else if (stopRequested) {
      finish({ status: 'stopped' });
    } else {
      finish({ status: 'success' });
    }
  }

  function ensureCleanup() {
    if (cleanupPromise) return cleanupPromise;

    if (!transport) {
      cleanupSettled = true;
      cleanupCertain = true;
      cleanupPromise = Promise.resolve(true);
      maybeFinish();
      return cleanupPromise;
    }

    let resolveCleanup;
    const cleanupFinished = new Promise(resolve => { resolveCleanup = resolve; });
    cleanupPromise = cleanupFinished.then(exited => {
      cleanupSettled = true;
      cleanupCertain = exited;
      if (!exited) {
        terminalError = ERRORS.cleanup;
        notifyError(ERRORS.cleanup);
      }
      maybeFinish();
      return exited;
    });

    // Publish before calling the backend: stop may synchronously deliver exit/close.
    try {
      Promise.resolve(transport.stop()).then(exited => resolveCleanup(exited === true), () => resolveCleanup(false));
    } catch {
      resolveCleanup(false);
    }
    return cleanupPromise;
  }

  function stop() {
    if (stopPromise) return stopPromise;
    if (completed) return Promise.resolve(cleanupCertain);
    stopRequested = true;
    if (!exitSeen) stopRequestedBeforeExit = true;
    stopPromise = ensureCleanup();
    return stopPromise;
  }

  function failProtocol() {
    if (protocolFailed) return;
    protocolFailed = true;
    terminalError = ERRORS.protocol;
    notifyDiagnostic(DIAGNOSTICS.protocolRejected);
    notifyError(ERRORS.protocol);
    void stop();
  }

  const framer = createImageLineFramer({
    onLine(line) {
      if (protocolFailed) return;
      let update;
      try {
        update = parseOutputUpdate(line);
      } catch {
        failProtocol();
        return;
      }

      if (!update || (update.kind !== 'image' && createPrimitiveArtwork(update) === undefined)) return;
      if (update.kind === 'image') notifyDiagnostic(DIAGNOSTICS.firstImageParsed);
      if (terminalError === ERRORS.display || stopRequested) return;
      try {
        callbacks.onUpdate(update);
      } catch {
        terminalError = ERRORS.display;
        notifyError(ERRORS.display);
        void stop();
      }
    },
  });

  function finishStdout() {
    if (stdoutFinished) return;
    stdoutFinished = true;
    try {
      framer.finish();
    } catch {
      failProtocol();
    }
  }

  let environment;
  try {
    environment = validateLaunchOptions(launchOptions);
  } catch {
    // Internal environment validation must never enter value-bearing OS-error diagnostics.
    notifyDiagnostic(DIAGNOSTICS.launchFailed);
    notifyDiagnostic(DIAGNOSTICS.launchReasonEinval);
    notifyError(ERRORS.launch);
    finish({ status: 'error', error: ERRORS.launch });
    return { done, stop };
  }

  const transportCallbacks = {
    onStdout(chunk) {
      if (completed) return;
      notifyDiagnostic(DIAGNOSTICS.firstStdoutData);
      if (protocolFailed) return;
      try {
        framer.push(chunk);
      } catch {
        failProtocol();
      }
    },
    onStdoutEnd() { if (!completed) finishStdout(); },
    onStdoutError() { if (!completed) failProtocol(); },
    onStderr(chunk) { if (!completed) captureStderr(chunk); },
    onStderrEnd() { if (!completed) completeStderrExcerpt(); },
    onSpawn() {
      if (completed) return;
      spawnSeen = true;
      notifyDiagnostic(DIAGNOSTICS.spawnSucceeded);
    },
    onError(error) {
      if (completed) return;
      if (!spawnSeen) {
        notifyDiagnostic(DIAGNOSTICS.launchFailed);
        notifyLaunchReason(error);
      }
      if (stopRequested) return;
      launchFailed = true;
      terminalError = ERRORS.launch;
      void ensureCleanup();
      notifyError(ERRORS.launch);
      maybeFinish();
    },
    onExit({ code, terminated }) {
      if (completed) return;
      exitSeen = true;
      if (stopRequested) stopRequestedBeforeExit = true;
      closeCode = code;
      closeTerminated = terminated;
      void ensureCleanup();
    },
    onClose({ code, terminated }) {
      if (completed) return;
      completeStderrExcerpt();
      closeSeen = true;
      if (!exitSeen) {
        closeCode = code;
        closeTerminated = terminated;
      }
      finishStdout();
      if (!exitSeen) void ensureCleanup();
      maybeFinish();
    },
  };

  try {
    transport = dependencies.startTransport
      ? dependencies.startTransport(execution, transportCallbacks, environment)
      : process.platform === 'win32'
        ? startWindowsProcessTransport(execution, transportCallbacks, environment)
        : startPosixProcessTransport(execution, transportCallbacks, environment, dependencies);
  } catch (error) {
    terminalError = ERRORS.launch;
    notifyDiagnostic(DIAGNOSTICS.launchFailed);
    notifyLaunchReason(error);
    notifyError(ERRORS.launch);
    finish({ status: 'error', error: ERRORS.launch });
  }

  return { done, stop };
}
