import { spawn as nodeSpawn } from 'node:child_process';

const CLEANUP_TIMEOUT_MS = 1_000;

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

async function waitForProcessGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(pid)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise(resolve => setTimeout(resolve, Math.min(25, remaining)));
  }
  return true;
}

/** Keep POSIX ownership and ChildProcess details out of the shared output runner. */
export function startPosixProcessTransport(execution, callbacks, environment, dependencies = {}) {
  const spawnProcess = dependencies.spawn ?? nodeSpawn;
  const sendSignal = dependencies.signalGroup ?? signalProcessGroup;
  const waitForExit = dependencies.waitForGroupExit ?? waitForProcessGroupExit;
  const child = spawnProcess(execution.executable, [...execution.args], {
    cwd: execution.cwd,
    detached: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(environment === undefined ? {} : { env: environment }),
  });
  let launchFailed = false;
  let cleanupPromise;
  let closed = false;

  function stop() {
    if (cleanupPromise) return cleanupPromise;
    if (launchFailed || !Number.isInteger(child.pid) || child.pid <= 0) {
      cleanupPromise = Promise.resolve(true);
      return cleanupPromise;
    }

    const pid = child.pid;
    let resolveCleanup;
    cleanupPromise = new Promise(resolve => { resolveCleanup = resolve; });
    // Publish the promise before signaling: injected signals can synchronously emit exit/close.
    void (async () => {
      if (!dependencies.signalGroup && !processGroupExists(pid)) return true;
      try { sendSignal(pid, 'SIGTERM'); } catch {}
      let exited = false;
      try { exited = (await waitForExit(pid, CLEANUP_TIMEOUT_MS)) === true; } catch {}
      if (!exited) {
        try { sendSignal(pid, 'SIGKILL'); } catch {}
        try { exited = (await waitForExit(pid, CLEANUP_TIMEOUT_MS)) === true; } catch {}
      }
      return exited;
    })().then(resolveCleanup, () => resolveCleanup(false));
    return cleanupPromise;
  }

  child.stdout.on('data', chunk => { if (!closed) callbacks.onStdout(chunk); });
  child.stdout.on('end', () => { if (!closed) callbacks.onStdoutEnd(); });
  child.stdout.on('error', () => { if (!closed) callbacks.onStdoutError(); });
  child.stderr.on('data', chunk => { if (!closed) callbacks.onStderr(chunk); });
  child.stderr.on('close', () => { if (!closed) callbacks.onStderrEnd(); });
  child.stderr.on('error', () => {});
  child.on('spawn', () => { if (!closed) callbacks.onSpawn(); });
  child.on('error', error => {
    if (!cleanupPromise) launchFailed = true;
    callbacks.onError(error);
  });
  child.on('exit', (code, signal) => {
    if (!closed) callbacks.onExit({ code, terminated: signal !== null });
  });
  child.on('close', (code, signal) => {
    if (closed) return;
    closed = true;
    callbacks.onClose({ code, terminated: signal !== null });
  });
  return { stop };
}
