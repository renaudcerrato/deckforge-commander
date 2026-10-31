import test from 'node:test';
import assert from 'node:assert/strict';
import { startProcessRun } from '../src/core/process-runner.mjs';
import { executionPlatform } from '../src/core/execution-paths.mjs';
import { validateSettings } from '../src/core/settings.mjs';

const options = { timeout: 2_000 };
const execution = (platform = executionPlatform()) => ({
  executable: platform === 'win32' ? 'C:/synthetic/program' : '/synthetic/program',
  args: ['', 'literal $(arg)', 'é😀'],
  cwd: platform === 'win32' ? 'C:/synthetic/cwd' : '/synthetic/cwd',
});
const success = { code: 0, terminated: false };
const terminated = { code: null, terminated: true };

// W3 rev2: shared-runner validation precedes the injected transport on every host.
for (const platform of ['posix', 'win32']) {
  test(`${platform} alternate-transport fixture passes real validation only with matching paths`, options, () => {
    // Arrange
    const input = execution(platform), otherPlatform = platform === 'win32' ? 'posix' : 'win32';
    // Act
    const validated = validateSettings(input, platform);
    // Assert
    assert.deepEqual(validated, input);
    assert.throws(() => validateSettings(input, otherPlatform), { diagnosticCode: 'INVALID_EXECUTABLE' });
    assert.throws(() => validateSettings({ ...input, cwd: execution(otherPlatform).cwd }, platform),
      { diagnosticCode: 'INVALID_CWD' });
  });
}

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

// WIN-TRANSPORT-01: a PID-free boundary, not a ChildProcess or a parser mock.
// Delivery starts only after startProcessRun returns. stop acknowledges cleanup,
// while close separately acknowledges reader/accepted-callback drain.
function harness({ input = execution(), launchOptions, onUpdate, stop } = {}) {
  const cleanup = deferred();
  const updates = [], errors = [], diagnostics = [], excerpts = [], details = [], submissions = [];
  let callbacks;
  let stopCalls = 0;
  const run = startProcessRun(input, {
    onUpdate(update) { updates.push(update); onUpdate?.(update); },
    onError: (...args) => errors.push(args),
    onDiagnostic: (...args) => diagnostics.push(args),
    onStderrExcerpt: excerpt => excerpts.push(excerpt),
    onLaunchError: detail => details.push(detail),
  }, {
    startTransport(settings, deliveredCallbacks, env) {
      submissions.push({ execution: settings, env });
      callbacks = deliveredCallbacks;
      return { stop() { stopCalls++; return stop ? stop(callbacks) : cleanup.promise; } };
    },
  }, launchOptions);
  return { run, callbacks, cleanup, updates, errors, diagnostics, excerpts, details, submissions,
    get stopCalls() { return stopCalls; } };
}

function bytes(h, value) {
  // Plain Uint8Array exercises the backend contract rather than Buffer methods.
  h.callbacks.onStdout(new Uint8Array(Buffer.from(value)));
}

function close(h, exit = success) {
  h.callbacks.onStdoutEnd();
  h.callbacks.onStderrEnd();
  h.callbacks.onClose(exit);
}

async function microtaskCheckpoint() {
  // Bounded deterministic promise checkpoint; no timers or real process probes.
  for (let turn = 0; turn < 8; turn++) await Promise.resolve();
}

test('PID-free transport delivers split UTF-8, CRLF and wire escapes through the shared parser', options, async () => {
  // Arrange: text/progress/image admission is real, only transport is doubled.
  const h = harness();
  const wire = Buffer.from(String.raw`text:é\n😀\\n|font-size:16` + '\r\nprogress:1/2|display:half\r\n<svg>opaque</svg>\r\n');
  // Act: split inside every Unicode scalar, escape, and CRLF boundary.
  h.callbacks.onSpawn();
  for (const byte of wire) h.callbacks.onStdout(Uint8Array.of(byte));
  h.callbacks.onExit(success);
  close(h);
  h.cleanup.resolve(true);
  const result = await h.run.done;
  // Assert: one complete ordered update per physical record, no image rewriting.
  assert.deepEqual(h.updates.map(update => [update.kind, update.value ?? update.image]), [
    ['text', 'é\n😀\\n'], ['progress', 50], ['image', `data:image/svg+xml,${encodeURIComponent('<svg>opaque</svg>')}`],
  ]);
  assert.equal(h.updates[1].options.display, 'half');
  assert.ok(h.updates.every(Object.isFrozen));
  assert.deepEqual([result, h.errors, h.stopCalls], [{ status: 'success' }, [], 1]);
});

test('transport preserves an exact-limit opaque SVG and ordered multi-record bursts without coalescing', options, async () => {
  // Arrange: a well-formed ASCII SVG has exactly the public record byte limit.
  const h = harness();
  const prefix = '<svg xmlns="http://www.w3.org/2000/svg"><!--';
  const suffix = '--></svg>';
  const image = prefix + 'x'.repeat(262_144 - prefix.length - suffix.length) + suffix;
  const records = Array.from({ length: 64 }, (_, index) => `text:record-${index}\nprogress:${index}\n`);
  // Act: one large record spans chunks; a burst contains many complete records.
  h.callbacks.onSpawn();
  bytes(h, image.slice(0, 131_071));
  bytes(h, image.slice(131_071) + '\r');
  bytes(h, '\n' + records.join(''));
  h.callbacks.onExit(success); close(h); h.cleanup.resolve(true);
  const result = await h.run.done;
  // Assert: this proves the seam's consumption, not native queue throughput.
  assert.equal(Buffer.byteLength(image), 262_144);
  assert.equal(h.updates.length, 129);
  assert.equal(h.updates[0].image, `data:image/svg+xml,${encodeURIComponent(image)}`);
  assert.deepEqual(h.updates.slice(1).map(update => [update.kind, update.value]),
    records.flatMap((_, index) => [['text', `record-${index}`], ['progress', index]]));
  assert.deepEqual([result, h.errors], [{ status: 'success' }, []]);
});

for (const cleanupFirst of [false, true]) {
  test(`root exit retains final bytes and waits for ${cleanupFirst ? 'reader close after cleanup' : 'cleanup after reader close'}`, options, async () => {
    // Arrange: both public completion gates are independently controlled.
    const h = harness();
    let settled = false;
    h.run.done.then(() => { settled = true; });
    // Act: natural cleanup must not turn into intentional stop or discard output.
    h.callbacks.onSpawn(); bytes(h, 'text:first\n');
    h.callbacks.onExit(success);
    await microtaskCheckpoint();
    const afterRoot = settled;
    bytes(h, 'text:final\n');
    if (cleanupFirst) h.cleanup.resolve(true); else close(h);
    await microtaskCheckpoint();
    const afterOneGate = settled;
    if (cleanupFirst) close(h); else h.cleanup.resolve(true);
    const result = await h.run.done;
    // Assert: successful drain and cleanup, never leader-exit-only settlement.
    assert.deepEqual([afterRoot, afterOneGate], [false, false]);
    assert.deepEqual(h.updates.map(update => update.value), ['first', 'final']);
    assert.deepEqual([result, h.errors, h.stopCalls], [{ status: 'success' }, [], 1]);
    assert.equal(h.diagnostics.at(-1)[0], 'PROCESS_EXITED_SUCCESSFULLY');
  });
}

for (const [label, wire] of [
  ['nonblank EOF', Buffer.from('text:unterminated')],
  ['invalid UTF-8', Uint8Array.of(0xc3, 0x28, 10)],
  ['oversized image', Buffer.from('<svg>' + 'x'.repeat(262_144) + '</svg>\n')],
  ['malformed image prefix', Buffer.from('data:image/png;base64,%%%\n')],
]) {
  test(`alternate transport keeps ${label} fatal even when cleanup is uncertain`, options, async () => {
    // Arrange: protocol failure has priority over cleanup and exit errors.
    const h = harness();
    // Act
    h.callbacks.onSpawn(); h.callbacks.onStdout(wire);
    h.callbacks.onStdoutEnd(); h.callbacks.onStdoutError();
    h.callbacks.onExit(terminated); close(h, terminated); h.cleanup.resolve(false);
    const result = await h.run.done;
    const certainty = await h.run.stop();
    // Assert: malformed records never enter the display callback or diagnostics.
    assert.deepEqual(result, { status: 'error', error: 'Image protocol error.' });
    assert.deepEqual(h.errors, [['Image protocol error.'], ['Process cleanup uncertain.']]);
    assert.deepEqual(h.updates, []);
    assert.equal(certainty, false);
    assert.equal(h.stopCalls, 1);
    assert.equal(h.diagnostics.filter(([event]) => event === 'PROCESS_PROTOCOL_REJECTED').length, 1);
    assert.ok(h.diagnostics.every(args => args.length === 1));
  });
}

test('invalid reserved primitive records skip atomically without poisoning subsequent valid output', options, async () => {
  // Arrange
  const h = harness();
  // Act: unknown/duplicate/inapplicable options must not become ordinary text.
  h.callbacks.onSpawn();
  bytes(h, 'text:bad|unknown:x\ntext:bad|color:red;color:blue\nprogress:1/0\ntext:bad|scale:80\n');
  bytes(h, 'text:valid\nprogress:25\n');
  h.callbacks.onExit(success); close(h); h.cleanup.resolve(true);
  const result = await h.run.done;
  // Assert
  assert.deepEqual(h.updates.map(update => [update.kind, update.value]), [['text', 'valid'], ['progress', 25]]);
  assert.deepEqual([result, h.errors], [{ status: 'success' }, []]);
});

for (const [label, exit, result, diagnostic] of [
  ['zero', success, { status: 'success' }, 'PROCESS_EXITED_SUCCESSFULLY'],
  ['nonzero', { code: 7, terminated: false }, { status: 'error', error: 'Program exited unsuccessfully.' }, 'PROCESS_EXITED_NONZERO'],
  ['signal', terminated, { status: 'error', error: 'Program exited unsuccessfully.' }, 'PROCESS_TERMINATED_BY_SIGNAL'],
]) {
  test(`PID-free ${label} root outcome retains public result and fixed diagnostics`, options, async () => {
    // Arrange
    const h = harness();
    // Act
    h.callbacks.onSpawn(); h.callbacks.onExit(exit); close(h, exit); h.cleanup.resolve(true);
    const actual = await h.run.done;
    // Assert: no synthetic PID or Node signal object is required.
    assert.deepEqual(actual, result);
    assert.deepEqual(h.errors, result.status === 'error' ? [[result.error]] : []);
    assert.deepEqual(h.diagnostics, [['PROCESS_SPAWN_SUCCEEDED'], [diagnostic]]);
  });
}

for (const [label, stop] of [
  ['certain', () => Promise.resolve(true)],
  ['false', () => Promise.resolve(false)],
  ['rejected', () => Promise.reject(Error('synthetic private rejection'))],
  ['throwing', () => { throw Error('synthetic private throw'); }],
]) {
  test(`intentional stop is idempotent and maps ${label} cleanup to a public boolean`, options, async () => {
    // Arrange
    const h = harness({ stop });
    const certain = label === 'certain';
    // Act
    h.callbacks.onSpawn();
    const first = h.run.stop(), repeated = h.run.stop();
    h.callbacks.onExit(terminated); close(h, terminated);
    const certainties = await Promise.all([first, repeated]);
    const result = await h.run.done;
    const afterCompletion = await h.run.stop();
    // Assert: cleanup exceptions are fixed diagnostics, never raw exceptions.
    assert.deepEqual(certainties, [certain, certain]);
    assert.equal(afterCompletion, certain);
    assert.equal(h.stopCalls, 1);
    assert.deepEqual(result, certain ? { status: 'stopped' } : { status: 'error', error: 'Process cleanup uncertain.' });
    assert.deepEqual(h.errors, certain ? [] : [['Process cleanup uncertain.']]);
    assert.equal(h.diagnostics.at(-1)[0], 'PROCESS_RUN_COMPLETED_AFTER_STOP_REQUEST');
  });
}

for (const intentional of [false, true]) {
  test(`reentrant backend exit/close during ${intentional ? 'intentional' : 'natural'} cleanup settles once`, options, async () => {
    // Arrange: cleanup synchronously delivers callbacks before returning its promise.
    const h = harness({ stop(callbacks) {
      callbacks.onStdoutEnd(); callbacks.onStderrEnd();
      callbacks.onExit(success); callbacks.onClose(success);
      return Promise.resolve(true);
    } });
    // Act
    h.callbacks.onSpawn();
    if (intentional) await h.run.stop(); else h.callbacks.onExit(success);
    const result = await h.run.done;
    // Assert: published cleanup promise prevents recursive cleanup or a hang.
    assert.equal(h.stopCalls, 1);
    assert.deepEqual([result, h.errors], [{ status: intentional ? 'stopped' : 'success' }, []]);
  });
}

test('throwing display callback requests cleanup and suppresses later updates without exposing exception text', options, async () => {
  // Arrange
  const h = harness({ onUpdate() { throw Error('synthetic private display exception'); } });
  // Act
  h.callbacks.onSpawn(); bytes(h, 'text:first\ntext:must-not-deliver\n');
  h.callbacks.onExit(terminated); close(h, terminated); h.cleanup.resolve(true);
  const result = await h.run.done;
  // Assert: callback failure is not an exit failure or protocol failure.
  assert.deepEqual(result, { status: 'error', error: 'Frame send failed.' });
  assert.deepEqual(h.errors, [['Frame send failed.']]);
  assert.deepEqual(h.updates.map(update => update.value), ['first']);
  assert.equal(h.stopCalls, 1);
});

for (const spawned of [false, true]) {
  test(`asynchronous ${spawned ? 'post-spawn' : 'launch'} error waits for cleanup and reader close`, options, async () => {
    // Arrange
    const h = harness();
    let settled = false;
    h.run.done.then(() => { settled = true; });
    // Act
    if (spawned) h.callbacks.onSpawn();
    h.callbacks.onError({ code: 'ENOENT', message: 'synthetic OS error', argv: ['excluded'], pid: 123 });
    close(h, { code: -1, terminated: false });
    await microtaskCheckpoint();
    const beforeCleanup = settled;
    h.cleanup.resolve(true);
    const result = await h.run.done;
    // Assert: the shared runner retains the existing fixed public error mapping.
    assert.equal(beforeCleanup, false);
    assert.equal(h.stopCalls, 1);
    assert.deepEqual(result, { status: 'error', error: 'Program launch failed.' });
    assert.deepEqual(h.errors, [['Program launch failed.']]);
    assert.deepEqual(h.details.map(JSON.parse), spawned ? [] : [{ code: 'ENOENT', message: 'synthetic OS error' }]);
    assert.deepEqual(h.diagnostics, spawned ? [['PROCESS_SPAWN_SUCCEEDED']] : [['PROCESS_LAUNCH_FAILED'], ['PROCESS_LAUNCH_REASON_ENOENT']]);
  });
}

test('synchronous factory failure leaves an inert stoppable failed run and bounds authorized OS fields', options, async () => {
  // Arrange: a throwing factory contract means no owned process remains.
  const diagnostics = [], errors = [], details = [];
  const osError = { code: 'EACCES', message: '😀'.repeat(1_025), argv: ['excluded'], env: { excluded: true }, pid: 123 };
  // Act
  const run = startProcessRun(execution(), {
    onUpdate() {}, onError: error => errors.push(error), onDiagnostic: (...args) => diagnostics.push(args),
    onLaunchError: detail => details.push(detail),
  }, { startTransport() { throw osError; } });
  const result = await run.done;
  const certainty = await run.stop();
  // Assert
  assert.deepEqual(result, { status: 'error', error: 'Program launch failed.' });
  assert.equal(certainty, true);
  assert.deepEqual(errors, ['Program launch failed.']);
  assert.deepEqual(diagnostics, [['PROCESS_LAUNCH_FAILED'], ['PROCESS_LAUNCH_REASON_EACCES']]);
  assert.deepEqual(details.map(JSON.parse), [{ code: 'EACCES', message: '😀'.repeat(1_021) + '[TRUNCATED]' }]);
  assert.ok(Buffer.byteLength(JSON.parse(details[0]).message) <= 4_096);
});

test('unsafe launch-error accessors are never invoked across the alternate boundary', options, async () => {
  // Arrange
  const h = harness();
  let reads = 0;
  const error = Object.defineProperty({}, 'code', { get() { reads++; throw Error('private getter'); } });
  // Act
  h.callbacks.onError(error); close(h, { code: -1, terminated: false }); h.cleanup.resolve(true);
  const result = await h.run.done;
  // Assert
  assert.equal(reads, 0);
  assert.deepEqual(h.details, ['{"details":"UNSAFE_OR_UNAVAILABLE"}']);
  assert.deepEqual(h.diagnostics, [['PROCESS_LAUNCH_FAILED'], ['PROCESS_LAUNCH_REASON_UNKNOWN']]);
  assert.deepEqual(result, { status: 'error', error: 'Program launch failed.' });
});

for (const overflow of [false, true]) {
  test(`alternate stderr is escaped and ${overflow ? 'capped' : 'drained'} independently of stdout`, options, async () => {
    // Arrange: synthetic controls and split multibyte data, no host environment.
    const h = harness();
    const text = overflow ? 'x'.repeat(2_048) : 'é😀\n\u0000\u0085\u2028';
    const wire = Buffer.from(text + (overflow ? 'excluded tail' : ''));
    // Act
    h.callbacks.onSpawn();
    h.callbacks.onStderr(new Uint8Array(wire.subarray(0, 1)));
    h.callbacks.onStderr(new Uint8Array(wire.subarray(1)));
    const beforeEnd = [...h.excerpts];
    h.callbacks.onStderrEnd(); h.callbacks.onStderrEnd();
    bytes(h, 'text:final\n'); h.callbacks.onExit(success); close(h); h.cleanup.resolve(true);
    const result = await h.run.done;
    // Assert: one bounded excerpt; stderr never becomes a display update.
    assert.deepEqual(beforeEnd, []);
    assert.equal(h.excerpts.length, 1);
    const encoded = overflow ? h.excerpts[0].replace(/ \[TRUNCATED\]$/, '') : h.excerpts[0];
    assert.equal(JSON.parse(encoded), text);
    assert.doesNotMatch(h.excerpts[0], /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
    assert.equal(h.excerpts[0].endsWith(' [TRUNCATED]'), overflow);
    assert.deepEqual(h.updates.map(update => update.value), ['final']);
    assert.deepEqual([result, h.errors], [{ status: 'success' }, []]);
    assert.equal(h.diagnostics.filter(([event]) => event === 'PROCESS_STDERR_FIRST_DATA').length, 1);
  });
}

test('complete launch snapshots detach caller settings and environment without implicit inherited variables', options, async () => {
  // Arrange: compare synthetic snapshots only, never print process.env.
  const input = execution(), original = execution();
  const env = { SYNTHETIC: 'original' };
  const h = harness({ input, launchOptions: { env } });
  // Act
  input.args[0] = 'changed'; input.executable = '/changed'; input.cwd = '/changed'; env.SYNTHETIC = 'changed'; env.LATER = 'changed';
  h.callbacks.onSpawn(); h.callbacks.onExit(success); close(h); h.cleanup.resolve(true);
  const result = await h.run.done;
  // Assert: the factory receives the complete original request, not saved settings.
  assert.equal(h.submissions.length, 1);
  assert.deepEqual(h.submissions[0].execution, original);
  assert.deepEqual({ ...h.submissions[0].env }, { SYNTHETIC: 'original' });
  assert.notStrictEqual(h.submissions[0].env, env);
  assert.deepEqual(result, { status: 'success' });
});

for (const explicit of [false, true]) {
  test(`${explicit ? 'empty complete snapshot' : 'omitted snapshot'} keeps alternate environment semantics`, options, async () => {
    // Arrange
    const h = harness({ launchOptions: explicit ? { env: {} } : undefined });
    // Act
    h.callbacks.onSpawn(); h.callbacks.onExit(success); close(h); h.cleanup.resolve(true);
    const result = await h.run.done;
    // Assert: empty is complete, undefined is inheritance; neither is an overlay.
    if (explicit) assert.ok(h.submissions[0].env !== undefined && h.submissions[0].env !== null);
    assert.deepEqual(explicit ? { ...h.submissions[0].env } : h.submissions[0].env, explicit ? {} : undefined);
    assert.deepEqual(result, { status: 'success' });
  });
}

test('callbacks from a completed generation cannot mutate it or a newer run', options, async () => {
  // Arrange: each launch owns its own captured callbacks and deferred cleanup.
  const old = harness();
  old.callbacks.onSpawn(); bytes(old, 'text:old\n'); old.callbacks.onExit(success); close(old); old.cleanup.resolve(true);
  const first = await old.run.done;
  const newer = harness();
  const previous = { errors: [...old.errors], diagnostics: [...old.diagnostics], details: [...old.details], excerpts: [...old.excerpts] };
  // Act: deliberately adversarial late delivery must be harmless to the facade.
  old.callbacks.onSpawn(); bytes(old, 'text:late\n'); old.callbacks.onStdoutError();
  old.callbacks.onStderr(Uint8Array.of(65)); old.callbacks.onStderrEnd();
  old.callbacks.onError({ code: 'ENOENT' }); old.callbacks.onExit(terminated); old.callbacks.onClose(terminated);
  newer.callbacks.onSpawn(); bytes(newer, 'text:new\n'); newer.callbacks.onExit(success); close(newer); newer.cleanup.resolve(true);
  const second = await newer.run.done;
  // Assert: no cross-generation output, diagnostics, errors or replacement stop.
  assert.deepEqual([first, second], [{ status: 'success' }, { status: 'success' }]);
  assert.deepEqual(old.updates.map(update => update.value), ['old']);
  assert.deepEqual(newer.updates.map(update => update.value), ['new']);
  assert.deepEqual({ errors: old.errors, diagnostics: old.diagnostics, details: old.details, excerpts: old.excerpts }, previous);
  assert.deepEqual(newer.errors, []);
  assert.deepEqual([old.stopCalls, newer.stopCalls], [1, 1]);
});
