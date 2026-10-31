// Standalone Windows driver. The ordinary macOS test glob imports this file
// without launching anything; these six cases require the reviewed supervisor.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { startWindowsProcessTransport } from '../src/core/windows-process-transport.mjs';
import { startProcessRun } from '../src/core/process-runner.mjs';
import { imageRecord, burstRecord, literalArguments } from './fixtures/windows-native-producer.mjs';

const cases = ['launch', 'streams', 'backpressure', 'ownership', 'concurrency', 'lifecycle'];
const directory = path.dirname(fileURLToPath(import.meta.url));
const bundled = path.basename(fileURLToPath(import.meta.url)) === 'windows-tests.mjs';
const fixture = path.join(directory, bundled ? 'windows-native-producer.mjs' : 'fixtures/windows-native-producer.mjs');
const addonPath = path.join(directory, bundled ? 'native/win32-x64/transport.node' : '../.task/native/win32-x64/transport.node');
let stage = 'preflight';
const active = new Set();
function env(extra = {}) {
  const root = Object.entries(process.env).find(([key]) => key.toLowerCase() === 'systemroot')?.[1];
  assert.equal(typeof root, 'string');
  // Complete, deliberately minimal snapshot; no backend injection/host merge.
  return { SystemRoot: root, ...extra };
}
function execution(mode, extra = {}) {
  return { executable: process.execPath, args: [fixture, mode], ...extra };
}
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('driver deadline')), 12000); })]); }
  finally { clearTimeout(timer); }
}
function spin(milliseconds) { const until = performance.now() + milliseconds; while (performance.now() < until) { /* controlled slow consumer */ } }
function raw(mode, { input = execution(mode), environment = env(), stdout, capture = true } = {}) {
  const spawned = deferred(), closed = deferred(), ready = deferred();
  const state = { events: [], chunks: [], stderr: [], bytes: 0, errors: [], exit: undefined, returned: false, late: false };
  let isClosed = false, transport;
  const callbacks = {
    onSpawn() { state.events.push('spawn'); if (!state.returned) throw Error('synchronous native callback'); spawned.resolve(); },
    onStdout(chunk) {
      if (isClosed) state.late = true;
      state.bytes += chunk.length;
      if (capture) {
        if (state.bytes > 1048576) throw Error('driver capture limit');
        state.chunks.push(Buffer.from(chunk));
        const text = Buffer.concat(state.chunks).toString('utf8');
        if (text.includes('text:ready\n') || text.includes('text:tree-ready\n')) ready.resolve();
      }
      stdout?.(chunk);
    },
    onStderr(chunk) { if (isClosed) state.late = true; if (state.stderr.reduce((sum, bytes) => sum + bytes.length, 0) + chunk.length > 8192) throw Error('driver stderr limit'); state.stderr.push(Buffer.from(chunk)); },
    onExit(value) { state.events.push('exit'); state.exit = value; },
    onStdoutEnd() { state.events.push('stdout-end'); },
    onStderrEnd() { state.events.push('stderr-end'); },
    onStdoutError() { state.errors.push('output'); },
    onError(error) { state.errors.push(error.code); },
    onClose(value) { state.events.push('close'); isClosed = true; state.exit = value; closed.resolve(); },
  };
  transport = startWindowsProcessTransport(input, callbacks, environment, { addonPath });
  state.returned = true; active.add(transport);
  return { transport, state, spawned: spawned.promise, ready: ready.promise, closed: closed.promise };
}
async function finish(run) {
  await bounded(run.closed);
  const certain = await bounded(run.transport.stop()); active.delete(run.transport);
  assert.equal(certain, true);
  assert.deepEqual(run.state.events.slice(-3), ['stdout-end', 'stderr-end', 'close']);
  assert.equal(run.state.late, false);
  return run.state;
}
function facade(mode, onUpdate = () => {}) {
  const errors = [], excerpts = [], diagnostics = [];
  const run = startProcessRun(execution(mode), {
    onUpdate, onError: value => errors.push(value), onStderrExcerpt: value => excerpts.push(value), onDiagnostic: value => diagnostics.push(value),
  }, {
    // S2 validates actual Windows fixture paths at the common runner boundary.
    startTransport(submittedExecution, callbacks, environment) {
      return startWindowsProcessTransport(submittedExecution, callbacks, environment, { addonPath });
    },
  }, { env: env() });
  active.add(run);
  return { run, errors, excerpts, diagnostics };
}
async function facadeDone(value) {
  const outcome = await bounded(value.run.done);
  assert.equal(await bounded(value.run.stop()), true); active.delete(value.run);
  return outcome;
}

async function launch() {
  // Arrange — literal argv, Unicode, slash paths, cwd, aliases and detached input.
  stage = 'launch-positive';
  const snapshot = env({ CANVAS_SYNTHETIC: 'before', Path: 'synthetic-only', PATH: 'synthetic-only', ELGATO_ACTION_CONTEXT: 'synthetic-key' });
  const input = execution('launch', { executable: process.execPath.replaceAll('\\', '/'), args: [fixture, 'launch', ...literalArguments], cwd: path.dirname(fixture).replaceAll('\\', '/') });
  // Act
  const run = raw('launch', { input, environment: snapshot });
  input.args[2] = 'mutated'; snapshot.CANVAS_SYNTHETIC = 'mutated'; input.cwd = 'C:/missing-after-submission';
  const state = await finish(run);
  // Assert
  assert.deepEqual(state.errors, []); assert.equal(state.exit.code, 0);
  assert.equal(Buffer.concat(state.chunks).toString(), 'text:launch-ok\n');

  // HOSTBUGFIX Arrange — explicitly selected Windows PowerShell 5.1, no
  // profiles, output-only command, complete environment and no console mutation.
  // Exit 0 with zero stdout was the observed regression, not a valid success.
  stage = 'launch-powershell-output';
  const powershellEnvironment = env();
  const powershellInput = {
    executable: path.win32.join(powershellEnvironment.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "Write-Output 'text:Hello Windows|color:lime'"],
  };
  const expectedOutput = Buffer.from('text:Hello Windows|color:lime\r\n', 'utf8');
  // Act — use the actual native transport and its existing bounded driver.
  const powershellState = await finish(raw('empty', { input: powershellInput, environment: powershellEnvironment }));
  // Assert — finish also requires certain owned cleanup and final reader drain.
  assert.equal(powershellState.exit.code, 0);
  assert.deepEqual(powershellState.errors, []);
  assert.equal(powershellState.bytes, 31);
  assert.equal(Buffer.concat(powershellState.chunks).equals(expectedOutput), true);
  assert.equal(Buffer.concat(powershellState.stderr).length, 0);
  assert.equal(powershellState.events[0], 'spawn');
  assert.ok(powershellState.events.indexOf('exit') > 0);
  assert.ok(powershellState.events.indexOf('exit') < powershellState.events.indexOf('stdout-end'));

  // Arrange / Act / Assert — native synchronous validation must leave no child.
  stage = 'launch-validation-negative';
  for (const [inputValue, environment] of [
    [execution('empty', { args: [fixture, 'empty', 'x'.repeat(32768)] }), env()],
    [execution('empty'), env({ Path: 'one', PATH: 'two' })],
  ]) assert.throws(() => raw('empty', { input: inputValue, environment }), { code: 'EINVAL' });

  // Arrange / Act / Assert — ordinary OS failure closes readers with certainty.
  stage = 'launch-os-negative';
  for (const [inputValue, expected] of [
    [execution('empty', { executable: path.join(directory, 'definitely-absent.exe') }), 'ENOENT'],
    [execution('empty', { cwd: path.join(directory, 'definitely-absent-cwd') }), 'ENOTDIR'],
  ]) {
    const failure = await finish(raw('empty', { input: inputValue }));
    assert.deepEqual(failure.errors, [expected]); assert.equal(failure.events.includes('spawn'), false);
  }
  stage = 'launch-recovery';
  const recovered = await finish(raw('empty'));
  assert.equal(recovered.exit.code, 0); assert.deepEqual(recovered.errors, []);

  // S2 Arrange / Act / Assert: common runner rejects a conflicting complete env
  // before calling the selected native factory; no OS process is submitted.
  stage = 'launch-common-environment-negative';
  let submissions = 0;
  const errors = [], diagnostics = [];
  const invalid = startProcessRun(execution('empty'), {
    onError: error => errors.push(error), onDiagnostic: diagnostic => diagnostics.push(diagnostic),
  }, { startTransport() { submissions++; throw Error('unexpected submission'); } }, { env: env({ Path: 'one', PATH: 'two' }) });
  assert.deepEqual(await bounded(invalid.done), { status: 'error', error: 'Program launch failed.' });
  assert.equal(submissions, 0); assert.deepEqual(errors, ['Program launch failed.']);
  assert.ok(diagnostics.includes('PROCESS_LAUNCH_REASON_EINVAL')); assert.equal(await bounded(invalid.stop()), true);
}

async function streams() {
  // Arrange — real framer/parser/render admission, not mock protocol updates.
  stage = 'streams-positive';
  const updates = [], run = facade('streams', update => updates.push(update));
  // Act
  const outcome = await facadeDone(run);
  // Assert — valid exact-limit image, skip invalid reserved record, final drain.
  assert.deepEqual(outcome, { status: 'success' }); assert.deepEqual(run.errors, []);
  assert.deepEqual(updates.map(value => value.kind), ['text', 'image', 'text']);
  assert.equal(updates[0].value, 'é🙂'); assert.equal(updates.at(-1).value, 'final');
  const image = imageRecord(); assert.equal(Buffer.byteLength(image), 262144);
  assert.equal(updates[1].image, 'data:image/svg+xml,' + encodeURIComponent(image));
  assert.deepEqual(run.excerpts, [JSON.stringify(Buffer.from('é🙂\r\n' + 's'.repeat(4096)).subarray(0, 2048).toString('utf8')) + ' [TRUNCATED]']);
  for (const mode of ['malformed', 'overlong', 'unterminated', 'invalid-utf8']) {
    // Arrange / Act / Assert — each fatal wire edge retains shared priority.
    stage = 'streams-' + mode;
    const failed = facade(mode);
    assert.deepEqual(await facadeDone(failed), { status: 'error', error: 'Image protocol error.' });
    assert.deepEqual(failed.errors, ['Image protocol error.']);
  }
}

async function backpressure() {
  // Arrange — exactly 8 MiB, streaming digest and explicit slow consumption.
  stage = 'backpressure-ordered-burst';
  const expected = createHash('sha256'), actual = createHash('sha256');
  for (let i = 0; i < 4096; i++) expected.update(burstRecord(i));
  let callbacks = 0, heartbeat = 0;
  const timer = setInterval(() => { heartbeat++; }, 1);
  const run = raw('burst', { capture: false, stdout(chunk) { actual.update(chunk); callbacks++; spin(2); } });
  // Act
  let state;
  try { state = await finish(run); } finally { clearInterval(timer); }
  // Assert — full queue is backpressure, not fatal/drop/reorder.
  assert.equal(state.bytes, 8 * 1024 * 1024); assert.equal(actual.digest('hex'), expected.digest('hex'));
  assert.equal(state.exit.code, 0); assert.deepEqual(state.errors, []); assert.ok(callbacks > 4); assert.ok(heartbeat > 0);

  // Arrange — saturating producer; stop after the JS consumer releases capacity.
  stage = 'backpressure-stop';
  const first = deferred(); let delayed = false;
  const flood = raw('flood', { capture: false, stdout() { if (!delayed) { delayed = true; spin(100); first.resolve(); } } });
  // Act
  await bounded(first.promise);
  const started = performance.now(), stopping = flood.transport.stop();
  assert.equal(stopping, flood.transport.stop());
  assert.equal(await bounded(stopping), true); await finish(flood);
  // Assert — no environment-thread join or queue-full protocol error.
  assert.ok(performance.now() - started < 3000); assert.deepEqual(flood.state.errors, []); assert.ok(flood.state.bytes > 0);
}

async function ownership() {
  // Arrange — descendants inherit pipes and cannot finish normally before expiry.
  stage = 'ownership-tree-stop';
  const tree = raw('tree');
  // Act
  await bounded(tree.ready); const started = performance.now();
  assert.equal(await bounded(tree.transport.stop()), true); const stopped = await finish(tree);
  // Assert — EOF and certain Job cleanup precede the fixture's 15-second expiry.
  assert.ok(performance.now() - started < 3000); assert.deepEqual(stopped.errors, []);
  assert.ok(Buffer.concat(stopped.chunks).toString().includes('text:level-2\n'));

  // Arrange / Act / Assert — root failure must not strand inherited pipe writers.
  stage = 'ownership-root-exit';
  const exiting = await finish(raw('tree-exit'));
  assert.equal(exiting.exit.code, 17); assert.deepEqual(exiting.errors, []);
  assert.ok(Buffer.concat(exiting.chunks).toString().endsWith('text:final-root\n'));
  stage = 'ownership-public-nonzero';
  const failed = facade('nonzero');
  assert.deepEqual(await facadeDone(failed), { status: 'error', error: 'Program exited unsuccessfully.' });
  assert.deepEqual(failed.errors, ['Program exited unsuccessfully.']);
}

async function concurrency() {
  // Arrange — separate owned Jobs represent two independent keys.
  stage = 'concurrency-isolation';
  const first = raw('tree'), control = raw('hold'); let controlClosed = false;
  control.closed.then(() => { controlClosed = true; });
  await bounded(Promise.all([first.ready, control.ready]));
  // Act
  await bounded(first.transport.stop()); await finish(first);
  const replacement = raw('empty'); const replacementState = await finish(replacement);
  assert.equal(await bounded(first.transport.stop()), true); await delay(40);
  // Assert — stale stop cannot touch a different Job/current key.
  assert.equal(controlClosed, false); assert.equal(replacementState.exit.code, 0);
  assert.equal(await bounded(control.transport.stop()), true); await finish(control);
  assert.deepEqual(control.state.errors, []);

  // Arrange / Act / Assert — immediate cancellation still drains and permits reuse.
  stage = 'concurrency-early-stop';
  const early = raw('hold'); assert.equal(await bounded(early.transport.stop()), true); await finish(early);
  const after = await finish(raw('empty')); assert.equal(after.exit.code, 0);
}

async function lifecycle() {
  // Arrange / Act / Assert — repeated normal disposal and retained stale handles.
  stage = 'lifecycle-repeat';
  const retained = [];
  for (let i = 0; i < 12; i++) { const run = raw('empty'); const state = await finish(run); assert.equal(state.exit.code, 0); retained.push(run.transport); }
  const live = raw('hold'); await bounded(live.ready);
  for (const stale of retained) assert.equal(await bounded(stale.stop()), true);
  let beats = 0; const timer = setInterval(() => { beats++; }, 1);
  try { await delay(30); assert.equal(await bounded(live.transport.stop()), true); await finish(live); }
  finally { clearInterval(timer); }
  assert.ok(beats > 0);

  // Arrange / Act / Assert — actual callback exception cleans owned processes.
  stage = 'lifecycle-callback-negative';
  const failed = raw('flood', { capture: false, stdout() { throw Error('synthetic callback failure'); } });
  const state = await finish(failed); assert.deepEqual(state.errors, ['output']);
  const recovered = await finish(raw('empty')); assert.equal(recovered.exit.code, 0);

  // Arrange / Act / Assert — public display failure retains error priority.
  stage = 'lifecycle-display-negative';
  const display = facade('hold', () => { throw Error('synthetic display failure'); });
  assert.deepEqual(await facadeDone(display), { status: 'error', error: 'Frame send failed.' });
  assert.deepEqual(display.errors, ['Frame send failed.']);

  // Arrange — dedicated test environment with a live, enrolled fixture tree.
  // No process-loss claim: this exercises async environment cleanup hooks only.
  stage = 'lifecycle-environment-teardown';
  const worker = new Worker(new URL(import.meta.url), { workerData: { windowsNativeTeardown: true } });
  const readiness = new Promise((resolve, reject) => {
    worker.once('message', message => message === 'TREE_READY' ? resolve() : reject(Error('worker readiness')));
    worker.once('error', () => reject(Error('worker error')));
    worker.once('exit', () => reject(Error('worker exited before readiness')));
  });
  // Act
  try {
    await bounded(readiness);
    const started = performance.now();
    await bounded(worker.terminate());
    // Assert — cleanup bridge completes before fixture expiry, without JS drain.
    assert.ok(performance.now() - started < 3000);
  } finally { await bounded(worker.terminate()); }
}

export async function runCase(name) {
  if (!cases.includes(name) || process.platform !== 'win32' || process.arch !== 'x64' || process.versions.node !== '24.13.1') throw Error('driver preflight');
  try { await ({ launch, streams, backpressure, ownership, concurrency, lifecycle })[name](); }
  finally {
    // Only handles returned by our own known-fixture launches; no PID scans/kills.
    for (const run of active) await bounded(run.stop());
    active.clear();
  }
}
const entry = path.basename(process.argv[1] ?? '');
if (!isMainThread && workerData?.windowsNativeTeardown === true) {
  // Native delivery remains live until terminate disables this environment's JS.
  const tree = raw('tree');
  await bounded(tree.ready);
  parentPort.postMessage('TREE_READY');
} else if (isMainThread && ['windows-tests.mjs', 'windows-integration.test.mjs'].includes(entry) && process.argv.length > 2) {
  const name = process.argv[2];
  try { assert.equal(process.argv.length, 3); await runCase(name); console.log('PASS ' + name); }
  catch { console.error('FAIL ' + stage); process.exitCode = 1; }
}
