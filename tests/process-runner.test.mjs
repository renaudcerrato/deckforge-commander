import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startProcessRun } from '../src/core/process-runner.mjs';
import { createLaunchEnvironment } from '../src/core/launch-environment.mjs';

const producer = fileURLToPath(new URL('./fixtures/image-producer.mjs', import.meta.url));
const processFixture = fileURLToPath(new URL('./fixtures/process-fixture.mjs', import.meta.url));
const environmentProducer = fileURLToPath(new URL('./fixtures/environment-producer.mjs', import.meta.url));
const cwd = fileURLToPath(new URL('./fixtures/', import.meta.url));
const settings = (mode, args = []) => ({ executable: process.execPath, args: [producer, mode, ...args], cwd });
const options = { timeout: 8_000 };

test('card byte-split UTF-8 and CRLF records survive malformed siblings and successful exit', options, async () => {
  // Arrange - Mock only the process boundary; framing and rendering admission remain real.
  const { child, updates, errors, run } = diagnosticRun();
  const bytes = Buffer.from('card:AAAA BBBB|header:é😀;footer:HTTP 200;header-gap:0;footer-gap:12.5;overflow:wrap;font-size:24\r\ncard:bad|header-gap:-1\r\ncard:bad|overflow:wrap;overflow:ellipsis\r\ncard:bad|header:x;header:y\r\ncard:bad|label:x\r\n');
  // Act
  child.emit('spawn');
  for (let index = 0; index < bytes.length; index++) child.stdout.write(bytes.subarray(index, index + 1));
  child.emit('exit', 0, null); child.emit('close', 0, null);
  const result = await run.done;
  // Assert
  assert.deepEqual(updates.map(update => [update.value, update.options.header, update.options.footer]), [['AAAA BBBB', 'é😀', 'HTTP 200']]);
  assert.deepEqual([updates[0].options['header-gap'], updates[0].options['footer-gap'], updates[0].options.overflow], [0, 12.5, 'wrap']);
  assert.deepEqual(result, { status: 'success' });
  assert.deepEqual(errors, []);
});
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
function killOwned(pid) {
  try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
function fakeChild() {
  const child = new EventEmitter();
  child.pid = 12345;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

// WIN-TRANSPORT-01: launch validation remains in the shared facade, before
// either the legacy POSIX spawn boundary or an alternate transport can run.
for (const [label, input, launchOptions, error, expectedDiagnostics] of [
  ['relative executable', { executable: 'relative', args: [] }, undefined, 'Invalid settings.', []],
  ['NUL argv', { executable: '/synthetic/program', args: ['bad\0arg'] }, undefined, 'Invalid settings.', []],
  ['unmatched argsText', { executable: '/synthetic/program', argsText: '"unterminated' }, undefined, 'Invalid settings.', []],
  ['malformed complete env', { executable: '/synthetic/program', args: [] }, { env: { SYNTHETIC: 'bad\0value' } }, 'Program launch failed.', ['PROCESS_LAUNCH_FAILED', 'PROCESS_LAUNCH_REASON_EINVAL']],
]) {
  test(`${label} rejects before an alternate transport factory and returns an inert run`, options, async () => {
    // Arrange: mock only the transport boundary; do not launch any executable.
    const errors = [], diagnostics = [], details = [];
    let submissions = 0;
    // Act
    const run = startProcessRun(input, {
      onUpdate() {}, onError: message => errors.push(message), onDiagnostic: (...args) => diagnostics.push(args),
      onLaunchError: detail => details.push(detail),
    }, { startTransport() { submissions++; throw Error('must not submit'); } }, launchOptions);
    const result = await run.done;
    const certainty = await run.stop();
    // Assert: invalid requests never become value-bearing OS launch failures.
    assert.equal(submissions, 0);
    assert.deepEqual(result, { status: 'error', error });
    assert.equal(certainty, true);
    assert.deepEqual(errors, [error]);
    assert.deepEqual(diagnostics, expectedDiagnostics.map(event => [event]));
    assert.deepEqual(details, []);
  });
}

for (const explicit of [false, true]) test(`${explicit ? 'explicit complete env' : 'legacy default inheritance'} preserves argv cwd shell and process-group options`, options, async () => {
  // Arrange: external spawn boundary only; all environment data is synthetic.
  const child = fakeChild(), calls = [], errors = [];
  const input = { executable: '/synthetic/program', args: ['', '$(literal)'], cwd: '/synthetic/cwd' };
  const env = { PATH: '/synthetic/path', ELGATO_ACTION_CONTEXT: 'synthetic-key' };
  // Act
  const run = startProcessRun(input, { onUpdate() {}, onError: error => errors.push(error) }, {
    spawn(...args) { calls.push(args); return child; }, signalGroup() {}, async waitForGroupExit() { return true; },
  }, explicit ? { env } : undefined);
  env.ELGATO_ACTION_CONTEXT = 'later-mutation';
  child.emit('spawn'); child.emit('exit', 0, null); child.emit('close', 0, null);
  const result = await run.done;
  // Assert
  assert.deepEqual(result, { status: 'success' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], input.executable);
  assert.deepEqual(calls[0][1], input.args);
  const spawnOptions = calls[0][2];
  assert.deepEqual({ ...spawnOptions, ...(explicit ? { env: { ...spawnOptions.env } } : {}) }, {
    cwd: input.cwd, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    ...(explicit ? { env: { PATH: '/synthetic/path', ELGATO_ACTION_CONTEXT: 'synthetic-key' } } : {}),
  });
  assert.equal(Object.hasOwn(spawnOptions, 'env'), explicit);
  assert.deepEqual(errors, []);
});

const invalidEnvironments = [
  ['null options', () => null], ['array options', () => []], ['missing env', () => ({})],
  ['extra option', () => ({ env: {}, secret: 'SYNTHETIC_PRIVATE' })],
  ['symbol option', () => ({ env: {}, [Symbol('synthetic')]: true })],
  ['inherited env', () => Object.create({ env: {} })],
  ['nonplain options', () => Object.assign(Object.create({ other: true }), { env: {} })],
  ['nonenumerable env', () => Object.defineProperty({}, 'env', { value: {} })],
  ['env accessor', state => Object.defineProperty({}, 'env', { enumerable: true, get() { state.reads++; throw Error('SYNTHETIC_PRIVATE'); } })],
  ['value accessor', state => ({ env: Object.defineProperty({}, 'SAFE', { enumerable: true, get() { state.reads++; throw Error('SYNTHETIC_PRIVATE'); } }) })],
  ['option proxy', state => new Proxy({ env: {} }, { ownKeys() { state.reads++; throw Error('SYNTHETIC_PRIVATE'); } })],
  ['env proxy', state => ({ env: new Proxy({}, { ownKeys() { state.reads++; throw Error('SYNTHETIC_PRIVATE'); } }) })],
  ['revoked proxy', () => { const p = Proxy.revocable({}, {}); p.revoke(); return p.proxy; }],
  ['array env', () => ({ env: [] })], ['null env', () => ({ env: null })],
  ['nonplain env', () => ({ env: Object.create({ inherited: 'SYNTHETIC_PRIVATE' }) })],
  ['symbol env', () => ({ env: { [Symbol('synthetic')]: 'SYNTHETIC_PRIVATE' } })],
  ['nonenumerable value', () => ({ env: Object.defineProperty({}, 'SAFE', { value: 'SYNTHETIC_PRIVATE' }) })],
  ...['', 'BAD=KEY', 'BAD\0KEY'].map(key => ['invalid key ' + JSON.stringify(key), () => ({ env: { [key]: 'SYNTHETIC_PRIVATE' } })]),
  ...[undefined, null, false, 0, {}, 'SYNTHETIC_PRIVATE\0'].map((value, index) => [`invalid value ${index}`, () => ({ env: { SAFE: value } })]),
];
for (const [label, make] of invalidEnvironments) test(`malformed ${label} blocks spawn and emits only fixed safe diagnostics`, options, async () => {
  // Arrange
  const state = { reads: 0 }, diagnostics = [], errors = [], details = [], cleanup = [];
  let spawns = 0;
  // Act
  const run = startProcessRun(settings('success'), {
    onUpdate() {}, onError: (...args) => errors.push(args), onDiagnostic: (...args) => diagnostics.push(args),
    onLaunchError: (...args) => details.push(args),
  }, { spawn() { spawns++; throw Error('SYNTHETIC_PRIVATE'); }, signalGroup() { cleanup.push('signal'); }, async waitForGroupExit() { cleanup.push('wait'); return true; } }, make(state));
  const result = await run.done;
  const stopped = await run.stop();
  // Assert: no value-bearing OS-error callback, getter reads or cleanup.
  assert.equal(spawns, 0);
  assert.equal(state.reads, 0);
  assertDiagnostics(diagnostics, ['PROCESS_LAUNCH_FAILED', 'PROCESS_LAUNCH_REASON_EINVAL']);
  assert.deepEqual(errors, [['Program launch failed.']]);
  assert.deepEqual(result, { status: 'error', error: 'Program launch failed.' });
  assert.equal(stopped, true);
  assert.deepEqual(details, []);
  assert.deepEqual(cleanup, []);
});

for (const mode of ['receipt', 'default-inheritance']) test(`native synthetic environment ${mode} reaches only the project-owned fixture`, options, async t => {
  // Arrange: the nested legacy-default case inherits a seeded isolated parent,
  // not a mutation of host process.env. Fixture prints boolean receipts only.
  const env = createLaunchEnvironment({ CANVAS_SYNTHETIC_SENTINEL: 'synthetic-inherited' }, { actionContext: 'synthetic-native-key', keyColumn: 0 });
  const updates = [], errors = [];
  const run = startProcessRun({ executable: process.execPath, args: [environmentProducer, mode], cwd }, {
    onUpdate: update => updates.push(update), onError: error => errors.push(error),
  }, undefined, { env });
  t.after(() => run.stop());
  // Act
  const result = await run.done;
  // Assert
  assert.deepEqual(result, { status: 'success' });
  assert.equal(updates.length, 1);
   assert.equal(updates[0].kind, 'text');
   assert.deepEqual(JSON.parse(updates[0].value), { CANVAS_SYNTHETIC_SENTINEL: true, ELGATO_ACTION_CONTEXT: true, ELGATO_KEY_COLUMN: true });
  assert.deepEqual(errors, []);
});

test('native complete empty env does not silently inherit seeded metadata', options, async t => {
  // Arrange: fixture reports comparisons, never inherited private values.
  const updates = [], errors = [];
  const run = startProcessRun({ executable: process.execPath, args: [environmentProducer, 'receipt'], cwd }, {
    onUpdate: update => updates.push(update), onError: error => errors.push(error),
  }, undefined, { env: {} });
  t.after(() => run.stop());
  // Act
  const result = await run.done;
  // Assert
  assert.deepEqual(result, { status: 'success' });
   assert.equal(updates[0].kind, 'text');
   assert.deepEqual(JSON.parse(updates[0].value), { CANVAS_SYNTHETIC_SENTINEL: false, ELGATO_ACTION_CONTEXT: false, ELGATO_KEY_COLUMN: false });
  assert.deepEqual(errors, []);
});

const allowedDiagnostics = new Set([
  'PROCESS_SPAWN_SUCCEEDED',
  'PROCESS_STDOUT_FIRST_DATA',
  'PROCESS_STDERR_FIRST_DATA',
  'PROCESS_IMAGE_RECORD_PARSED',
  'PROCESS_PROTOCOL_REJECTED',
  'PROCESS_LAUNCH_FAILED',
  'PROCESS_LAUNCH_REASON_ENOENT',
  'PROCESS_LAUNCH_REASON_EACCES',
  'PROCESS_LAUNCH_REASON_ENOTDIR',
  'PROCESS_LAUNCH_REASON_ENOEXEC',
  'PROCESS_LAUNCH_REASON_EAGAIN',
  'PROCESS_LAUNCH_REASON_EINVAL',
  'PROCESS_LAUNCH_REASON_UNKNOWN',
  'PROCESS_EXITED_SUCCESSFULLY',
  'PROCESS_EXITED_NONZERO',
  'PROCESS_TERMINATED_BY_SIGNAL',
  'PROCESS_RUN_COMPLETED_AFTER_STOP_REQUEST',
]);

function diagnosticRun(onDiagnostic, onStderrExcerpt) {
  const child = fakeChild();
  const diagnostics = [], excerpts = [], updates = [], errors = [];
  const run = startProcessRun(settings('success'), {
    onUpdate: update => updates.push(update),
    onError: error => errors.push(error),
    onDiagnostic(...args) {
      diagnostics.push(args);
      onDiagnostic?.(...args);
    },
    onStderrExcerpt(...args) {
      excerpts.push(args);
      onStderrExcerpt?.(...args);
    },
  }, {
    spawn: () => child,
    signalGroup() {},
    async waitForGroupExit() { return true; },
  });
  return { child, diagnostics, excerpts, updates, errors, run };
}

function assertDiagnostics(actual, expected) {
  // The logging contract allows one static event argument, never process details.
  assert.deepEqual(actual, expected.map(event => [event]));
  assert.ok(actual.every(args => args.length === 1 && allowedDiagnostics.has(args[0])));
  assert.equal(new Set(actual.map(args => args[0])).size, actual.length);
}

// S2: controlled byte streams exercise admission, atomic skips and completion drain.
for (const type of ['ring', 'bar']) test(`S2 ${type} progress layout records survive split UTF-8 and reject invalid/infeasible siblings`, options, async () => {
  // Arrange - Only the existing fake process boundary is used; no program is launched.
  const { child, updates, errors, diagnostics, run } = diagnosticRun();
  const valid = `progress:1|type:${type};scale:${type === 'ring' ? 40 : 110};thickness:0.5;display:V;label:é;value-size:12;label-size:10;label-weight:bold;label-gap:0.5`;
  const rejected = ['label-weight:Bold', 'label-gap:-1', 'label-gap:0;label-gap:2', 'padding-x:0', 'label-align:left', 'value-size:0', 'thickness:0', 'scale:1e2', 'scale:100;label:C;label-gap:100', 'scale:1000000'];
  const bytes = Buffer.from([valid, ...rejected.map(suffix => `progress:1|type:${type};${suffix}`), 'progress:101'].join('\r\n') + '\n');
  // Act
  child.emit('spawn');
  for (let offset = 0; offset < bytes.length; offset++) child.stdout.write(bytes.subarray(offset, offset + 1));
  child.emit('exit', 0, null); child.emit('close', 0, null);
  const result = await run.done;
  // Assert
  assert.equal(updates.length, 2);
  assert.deepEqual([updates[0].options.type, updates[0].options.scale, updates[0].options.thickness, updates[0].options['label-weight'], updates[0].options['label-gap'], updates[0].options.label], [type, type === 'ring' ? 40 : 110, 0.5, 'bold', 0.5, 'é']);
  assert.deepEqual([updates[1].value, updates[1].options['label-weight'], updates[1].options['label-gap'], updates[1].options.label], [100, 'normal', 2, '']);
  assert.ok(updates.every(update => Object.isFrozen(update) && Object.isFrozen(update.options) && Object.isFrozen(update.overrides)));
  assert.deepEqual(result, { status: 'success' }); assert.deepEqual(errors, []);
  assertDiagnostics(diagnostics, ['PROCESS_SPAWN_SUCCEEDED', 'PROCESS_STDOUT_FIRST_DATA', 'PROCESS_EXITED_SUCCESSFULLY']);
});

// Slice 4 / README framing: wire hard breaks are content inside one physical record.
for (const splitMode of ['every-byte', 'escape-and-multibyte']) {
  test(`hard-break process record ${splitMode} preserves CRLF framing and one callback per physical line`, options, async () => {
    // Arrange - Existing fake child boundary; no executable or SDK is invoked.
    const { child, updates, errors, run } = diagnosticRun();
    const bytes = Buffer.from(String.raw`text:é\n😀\\n|font-size:16` + '\r\n' + String.raw`raw\n` + '\n' + 'text:A\nB\r\n');
    const cuts = splitMode === 'every-byte' ? Array.from({ length: bytes.length - 1 }, (_, index) => index + 1)
      : [bytes.indexOf(Buffer.from('é')) + 1, bytes.indexOf(92) + 1, bytes.indexOf(Buffer.from('😀')) + 2, bytes.indexOf(13) + 1];
    // Act
    child.emit('spawn');
    let start = 0;
    for (const end of [...cuts, bytes.length]) { child.stdout.write(bytes.subarray(start, end)); start = end; }
    child.emit('exit', 0, null); child.emit('close', 0, null);
    const result = await run.done;
    // Assert - Physical LF separates A/B; decoded LF does not create callbacks.
    assert.deepEqual(updates.map(update => update.value), ['é\n😀\\n', String.raw`raw\n`, 'A', 'B']);
    assert.ok(updates.every(update => Object.isFrozen(update) && Object.keys(update).length === 4));
    assert.deepEqual(result, { status: 'success' });
    assert.deepEqual(errors, []);
  });
}
for (const [label, bytes] of [
  ['nonblank EOF', Buffer.from(String.raw`text:A\nB`)],
  ['oversized payload', Buffer.from('text:' + String.raw`\n`.repeat(131070) + '\n')],
  ['invalid UTF-8', Buffer.concat([Buffer.from(String.raw`text:A\n`), Buffer.from([0xc3, 0x28, 10])])],
]) {
  test(`hard-break wire cannot weaken fatal ${label} framing`, options, async () => {
    // Arrange
    const { child, updates, errors, run } = diagnosticRun();
    // Act
    child.emit('spawn'); child.stdout.write(bytes);
    child.emit('exit', 0, null); child.emit('close', 0, null);
    const result = await run.done;
    // Assert
    assert.deepEqual(updates, []);
    assert.deepEqual(errors, ['Image protocol error.']);
    assert.deepEqual(result, { status: 'error', error: 'Image protocol error.' });
  });
}
test('exact hard-break wire byte limit remains accepted without per-line budget resets', options, async () => {
  // Arrange - 5 prefix bytes + 1 A + 131069 two-byte wire escapes = 262144.
  const { child, updates, errors, run } = diagnosticRun();
  const wire = 'text:A' + String.raw`\n`.repeat(131069);
  // Act
  child.emit('spawn'); child.stdout.write(wire + '\r'); child.stdout.write('\n');
  child.emit('exit', 0, null); child.emit('close', 0, null);
  const result = await run.done;
  // Assert
  assert.equal(Buffer.byteLength(wire), 262144);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].value, 'A' + '\n'.repeat(131069));
  assert.deepEqual(result, { status: 'success' });
  assert.deepEqual(errors, []);
});

test('diagnostics report spawn, first data, first parsed image and drained zero exit once per generation', options, async () => {
  // Arrange: fake process boundaries make chunking and exit/close ordering deterministic.
  const { child, diagnostics, updates, errors, run } = diagnosticRun();
  // Act: the leader exits before its final stdout record drains.
  child.emit('spawn');
  child.stdout.write('<svg>');
  child.stdout.write('first</svg>\n<svg>second</svg>\n');
  child.stderr.write('test-only stderr marker');
  child.emit('exit', 0, null);
  await Promise.resolve();
  const beforeDrain = diagnostics.map(args => [...args]);
  child.stdout.write('<svg>final</svg>\n');
  child.emit('close', 0, null);
  const result = await run.done;
  // Assert: no exit diagnostic before close, and multiple chunks/records do not duplicate events.
  const progress = ['PROCESS_SPAWN_SUCCEEDED', 'PROCESS_STDOUT_FIRST_DATA', 'PROCESS_IMAGE_RECORD_PARSED', 'PROCESS_STDERR_FIRST_DATA'];
  assertDiagnostics(beforeDrain, progress);
  assertDiagnostics(diagnostics, [...progress, 'PROCESS_EXITED_SUCCESSFULLY']);
  assert.deepEqual(result, { status: 'success' });
  assert.equal(updates.length, 3);
  assert.equal(updates.at(-1).image, `data:image/svg+xml,${encodeURIComponent('<svg>final</svg>')}`);
  assert.deepEqual(errors, []);
});

for (const [label, code, signal, event, result, expectedErrors] of [
  ['empty zero exit', 0, null, 'PROCESS_EXITED_SUCCESSFULLY', { status: 'success' }, []],
  ['nonzero exit', 7, null, 'PROCESS_EXITED_NONZERO', { status: 'error', error: 'Program exited unsuccessfully.' }, ['Program exited unsuccessfully.']],
  ['signal exit', null, 'SIGTERM', 'PROCESS_TERMINATED_BY_SIGNAL', { status: 'error', error: 'Program exited unsuccessfully.' }, ['Program exited unsuccessfully.']],
]) {
  test(`diagnostics distinguish ${label} without inventing stdout or image events`, options, async () => {
    // Arrange
    const { child, diagnostics, errors, run } = diagnosticRun();
    // Act
    child.emit('spawn');
    child.emit('exit', code, signal);
    child.emit('close', code, signal);
    const actual = await run.done;
    // Assert: empty output is not evidence of received data or a parsed image.
    assertDiagnostics(diagnostics, ['PROCESS_SPAWN_SUCCEEDED', event]);
    assert.deepEqual(actual, result);
    assert.deepEqual(errors, expectedErrors);
  });
}

test('stderr chunks emit one fixed diagnostic without exposing content or parsing images', options, async () => {
  // Arrange: stderr remains an external byte stream, not image protocol input.
  const { child, diagnostics, updates, errors, run } = diagnosticRun();
  // Act: include image-like text and invalid UTF-8 to ensure neither is interpreted.
  child.emit('spawn');
  child.stderr.write('test-only stderr marker');
  child.stderr.write('<svg>stderr-only</svg>\n');
  child.stderr.write(Buffer.from([0xff, 0xfe]));
  child.emit('exit', 0, null);
  child.emit('close', 0, null);
  const result = await run.done;
  // Assert: exact single-argument events exclude bytes, text, and runtime metadata.
  assertDiagnostics(diagnostics, [
    'PROCESS_SPAWN_SUCCEEDED', 'PROCESS_STDERR_FIRST_DATA', 'PROCESS_EXITED_SUCCESSFULLY',
  ]);
  assert.deepEqual(result, { status: 'success' });
  assert.deepEqual(updates, []);
  assert.deepEqual(errors, []);
});

test('stderr excerpt joins chunks and escapes controls and line separators once on stream close', options, async () => {
  // Arrange: synthetic bytes include split UTF-8, quotes, backslashes, and log-line controls.
  const { child, diagnostics, excerpts, errors, run } = diagnosticRun();
  const text = 'test "quoted" \\ é😀\n\r\t\b\f\u0000\u001b\u007f\u0085\u2028\u2029';
  const bytes = Buffer.from(text);
  const split = bytes.indexOf(Buffer.from('é')) + 1;
  const expected = '"test \\"quoted\\" \\\\ é😀\\n\\r\\t\\b\\f\\u0000\\u001b\\u007f\\u0085\\u2028\\u2029"';
  // Act: no excerpt may be sent until stderr closes; repeated close cannot resend it.
  child.emit('spawn');
  child.stderr.write(bytes.subarray(0, split));
  child.stderr.write(bytes.subarray(split));
  const beforeClose = [...excerpts];
  child.stderr.emit('close');
  child.stderr.emit('close');
  child.emit('exit', 0, null);
  child.emit('close', 0, null);
  const result = await run.done;
  // Assert: encoding round-trips while containing no literal control/line-separator characters.
  assert.deepEqual(beforeClose, []);
  assert.deepEqual(excerpts, [[expected]]);
  assert.equal(JSON.parse(excerpts[0][0]), text);
  assert.doesNotMatch(excerpts[0][0], /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
  assertDiagnostics(diagnostics, ['PROCESS_SPAWN_SUCCEEDED', 'PROCESS_STDERR_FIRST_DATA', 'PROCESS_EXITED_SUCCESSFULLY']);
  assert.deepEqual(result, { status: 'success' });
  assert.deepEqual(errors, []);
});

for (const [label, chunks, expectedText, truncated] of [
  ['exact byte cap', ['x'.repeat(2_048)], 'x'.repeat(2_048), false],
  ['multichunk multibyte overflow', ['é'.repeat(512), 'é'.repeat(512), 'excluded test tail'], 'é'.repeat(1_024), true],
  ['cap splitting a UTF-8 character', ['x'.repeat(2_047), 'é', 'excluded test tail'], `${'x'.repeat(2_047)}�`, true],
]) {
  test(`stderr excerpt enforces the 2048-byte input limit for ${label}`, options, async () => {
    // Arrange: the cap applies to input bytes, not characters or encoded log length.
    const { child, diagnostics, excerpts, errors, run } = diagnosticRun();
    // Act: child close also completes an excerpt if a separate stream close was not observed.
    child.emit('spawn');
    for (const chunk of chunks) child.stderr.write(chunk);
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    child.stderr.emit('close');
    const result = await run.done;
    // Assert: only overflow gets the fixed suffix; excluded bytes never reach the callback.
    assert.deepEqual(excerpts, [[`${JSON.stringify(expectedText)}${truncated ? ' [TRUNCATED]' : ''}`]]);
    assertDiagnostics(diagnostics, ['PROCESS_SPAWN_SUCCEEDED', 'PROCESS_STDERR_FIRST_DATA', 'PROCESS_EXITED_SUCCESSFULLY']);
    assert.deepEqual(result, { status: 'success' });
    assert.deepEqual(errors, []);
  });
}

test('empty stderr produces neither an excerpt nor a first-data marker', options, async () => {
  // Arrange
  const { child, diagnostics, excerpts, errors, run } = diagnosticRun();
  // Act
  child.emit('spawn');
  child.stderr.emit('close');
  child.emit('exit', 0, null);
  child.emit('close', 0, null);
  const result = await run.done;
  // Assert: an empty stream must not create an empty log message.
  assert.deepEqual(excerpts, []);
  assertDiagnostics(diagnostics, ['PROCESS_SPAWN_SUCCEEDED', 'PROCESS_EXITED_SUCCESSFULLY']);
  assert.deepEqual(result, { status: 'success' });
  assert.deepEqual(errors, []);
});

for (const code of [0, 7]) {
  test(`throwing stderr excerpt callback preserves completion for exit case ${code}`, options, async () => {
    // Arrange
    const { child, diagnostics, excerpts, updates, errors, run } = diagnosticRun(undefined, () => {
      throw new Error('test-only excerpt callback exception');
    });
    // Act: failure while logging must not prevent later stdout parsing or completion.
    child.emit('spawn');
    child.stderr.write('test-only excerpt\n');
    child.stderr.emit('close');
    child.stdout.write('<svg>final</svg>\n');
    child.emit('exit', code, null);
    child.emit('close', code, null);
    const result = await run.done;
    // Assert: one callback attempt, no callback-exception disclosure, unchanged exit outcome.
    assert.deepEqual(excerpts, [['"test-only excerpt\\n"']]);
    assertDiagnostics(diagnostics, [
      'PROCESS_SPAWN_SUCCEEDED', 'PROCESS_STDERR_FIRST_DATA', 'PROCESS_STDOUT_FIRST_DATA',
      'PROCESS_IMAGE_RECORD_PARSED', code === 0 ? 'PROCESS_EXITED_SUCCESSFULLY' : 'PROCESS_EXITED_NONZERO',
    ]);
    assert.equal(updates.length, 1);
    assert.deepEqual(result, code === 0 ? { status: 'success' } : { status: 'error', error: 'Program exited unsuccessfully.' });
    assert.deepEqual(errors, code === 0 ? [] : ['Program exited unsuccessfully.']);
  });
}

test('protocol rejection is reported once and never reports an invalid record as parsed', options, async () => {
  // Arrange
  const { child, diagnostics, updates, errors, run } = diagnosticRun();
  // Act: later chunks and stream failures cannot repeat rejection or disclose their contents.
  child.emit('spawn');
  child.stdout.write('data:image/png;base64,%%%\n');
  child.stdout.write('data:image/png;base64,%%%\n');
  child.stdout.emit('error', new Error('test-only stream exception'));
  child.emit('exit', null, 'SIGTERM');
  child.emit('close', null, 'SIGTERM');
  const result = await run.done;
  // Assert
  assertDiagnostics(diagnostics, [
    'PROCESS_SPAWN_SUCCEEDED', 'PROCESS_STDOUT_FIRST_DATA',
    'PROCESS_PROTOCOL_REJECTED', 'PROCESS_RUN_COMPLETED_AFTER_STOP_REQUEST',
  ]);
  assert.deepEqual(result, { status: 'error', error: 'Image protocol error.' });
  assert.deepEqual(updates, []);
  assert.deepEqual(errors, ['Image protocol error.']);
});

test('asynchronous launch failure emits only one fixed launch diagnostic', options, async () => {
  // Arrange
  const { child, diagnostics, errors, run } = diagnosticRun();
  // Act: repeated errors before close remain one launch failure for this generation.
  child.emit('error', new Error('test-only launch exception'));
  child.emit('error', new Error('another test-only launch exception'));
  child.emit('close', -1, null);
  const result = await run.done;
  // Assert: failed launch is not a successful spawn or an unsuccessful program exit.
  assertDiagnostics(diagnostics, ['PROCESS_LAUNCH_FAILED', 'PROCESS_LAUNCH_REASON_UNKNOWN']);
  assert.deepEqual(result, { status: 'error', error: 'Program launch failed.' });
  assert.deepEqual(errors, ['Program launch failed.']);
});

test('synchronous launch failure emits a fixed diagnostic without exception details', options, async () => {
  // Arrange
  const diagnostics = [], errors = [];
  // Act
  const run = startProcessRun(settings('success'), {
    onUpdate() {}, onError: error => errors.push(error),
    onDiagnostic: (...args) => diagnostics.push(args),
  }, { spawn() { throw new Error('test-only synchronous exception'); } });
  const result = await run.done;
  // Assert
  assertDiagnostics(diagnostics, ['PROCESS_LAUNCH_FAILED', 'PROCESS_LAUNCH_REASON_UNKNOWN']);
  assert.deepEqual(result, { status: 'error', error: 'Program launch failed.' });
  assert.deepEqual(errors, ['Program launch failed.']);
});

function privateLaunchError() {
  return Object.assign(new Error('SYNTHETIC_PRIVATE_MESSAGE'), {
    stack: 'SYNTHETIC_PRIVATE_STACK', path: 'SYNTHETIC_PRIVATE_PATH',
    syscall: 'SYNTHETIC_PRIVATE_SYSCALL', spawnargs: ['SYNTHETIC_PRIVATE_ARGV'],
    env: 'SYNTHETIC_PRIVATE_ENV', errno: -987654, pid: 987654,
  });
}

const launchReasonCases = [
  ...['ENOENT', 'EACCES', 'ENOTDIR', 'ENOEXEC', 'EAGAIN', 'EINVAL'].map(code => [
    code, () => Object.assign(privateLaunchError(), { code }), `PROCESS_LAUNCH_REASON_${code}`,
  ]),
  ['missing code', privateLaunchError],
  ['unrecognized code', () => Object.assign(privateLaunchError(), { code: 'SYNTHETIC_PRIVATE_CODE' })],
  ['lowercase code', () => Object.assign(privateLaunchError(), { code: 'enoent' })],
  ['empty code', () => Object.assign(privateLaunchError(), { code: '' })],
  ['prototype method name', () => Object.assign(privateLaunchError(), { code: 'toString' })],
  ['prototype key name', () => Object.assign(privateLaunchError(), { code: '__proto__' })],
  ['numeric code', () => Object.assign(privateLaunchError(), { code: -987654 })],
  ['boxed string code', () => Object.assign(privateLaunchError(), { code: new String('ENOENT') })],
  ['inherited code', () => Object.assign(Object.create({ code: 'ENOENT' }), privateLaunchError())],
  ['own accessor code', state => Object.defineProperty(privateLaunchError(), 'code', {
    get() { state.reads++; throw new Error('SYNTHETIC_PRIVATE_GETTER'); },
  })],
  ['inherited accessor code', state => Object.assign(Object.create(Object.defineProperty({}, 'code', {
    get() { state.reads++; return 'ENOENT'; },
  })), privateLaunchError())],
  ['proxy inspection failure', () => new Proxy(privateLaunchError(), {
    getOwnPropertyDescriptor() { throw new Error('SYNTHETIC_PRIVATE_PROXY'); },
  })],
  ['null error', () => null],
  ['primitive error', () => 'SYNTHETIC_PRIVATE_PRIMITIVE'],
];

function launchDiagnosticHarness(throwCallbacks = false) {
  const child = fakeChild();
  const diagnostics = [], errors = [], updates = [], excerpts = [], cleanup = [];
  const callbacks = {
    onUpdate: update => updates.push(update),
    onStderrExcerpt: excerpt => excerpts.push(excerpt),
    onDiagnostic(...args) {
      diagnostics.push(args);
      if (throwCallbacks) throw new Error('SYNTHETIC_PRIVATE_LOGGER_FAILURE');
    },
    onError(...args) {
      errors.push(args);
      if (throwCallbacks) throw new Error('SYNTHETIC_PRIVATE_ERROR_CALLBACK_FAILURE');
    },
  };
  const dependencies = {
    spawn: () => child,
    signalGroup() { cleanup.push('signal'); },
    async waitForGroupExit() { cleanup.push('wait'); return true; },
  };
  return { child, diagnostics, errors, updates, excerpts, cleanup, callbacks, dependencies };
}

for (const mode of ['synchronous spawn', 'pre-spawn child error']) {
  for (const [label, makeError, reason = 'PROCESS_LAUNCH_REASON_UNKNOWN'] of launchReasonCases) {
    test(`${mode} maps ${label} to one safe launch reason without exposing runtime details`, options, async () => {
      // Arrange: only synthetic boundary errors; no actual path/cwd/interpreter cause is inferred.
      const harness = launchDiagnosticHarness();
      const state = { reads: 0 };
      const error = makeError(state);
      if (mode === 'synchronous spawn') harness.dependencies.spawn = () => { throw error; };
      // Act: the first reason wins even when later pre-spawn errors carry different codes.
      const run = startProcessRun(settings('success'), harness.callbacks, harness.dependencies);
      if (mode === 'pre-spawn child error') {
        harness.child.emit('error', error);
        harness.child.emit('error', Object.assign(privateLaunchError(), { code: 'EACCES' }));
        harness.child.emit('error', Object.assign(privateLaunchError(), { code: 'EINVAL' }));
        harness.child.emit('close', -1, null);
      }
      const result = await run.done;
      const stopped = await run.stop();
      // Assert: exactly two one-argument events, no getter reads, payloads, or process cleanup.
      assertDiagnostics(harness.diagnostics, ['PROCESS_LAUNCH_FAILED', reason]);
      assert.doesNotMatch(JSON.stringify(harness.diagnostics), /SYNTHETIC_PRIVATE|987654/);
      assert.deepEqual(harness.errors, [['Program launch failed.']]);
      assert.deepEqual(result, { status: 'error', error: 'Program launch failed.' });
      assert.equal(state.reads, 0);
      assert.equal(stopped, true);
      assert.deepEqual(harness.updates, []);
      assert.deepEqual(harness.excerpts, []);
      assert.deepEqual(harness.cleanup, []);
    });
  }

  test(`${mode} tolerates throwing diagnostic and error callbacks without repeating launch reasons`, options, async () => {
    // Arrange: logger failure is independent of the process error being classified.
    const harness = launchDiagnosticHarness(true);
    const error = Object.assign(privateLaunchError(), { code: 'ENOENT' });
    if (mode === 'synchronous spawn') harness.dependencies.spawn = () => { throw error; };
    // Act
    const run = startProcessRun(settings('success'), harness.callbacks, harness.dependencies);
    if (mode === 'pre-spawn child error') {
      harness.child.emit('error', error);
      harness.child.emit('error', Object.assign(privateLaunchError(), { code: 'EACCES' }));
      harness.child.emit('close', -1, null);
    }
    const result = await run.done;
    const stopped = await run.stop();
    // Assert: both callback attempts occur despite throws, with unchanged sanitized completion.
    assertDiagnostics(harness.diagnostics, ['PROCESS_LAUNCH_FAILED', 'PROCESS_LAUNCH_REASON_ENOENT']);
    assert.doesNotMatch(JSON.stringify(harness.diagnostics), /SYNTHETIC_PRIVATE|987654/);
    assert.deepEqual(harness.errors, [['Program launch failed.']]);
    assert.deepEqual(result, { status: 'error', error: 'Program launch failed.' });
    assert.equal(stopped, true);
    assert.deepEqual(harness.cleanup, []);
    assert.deepEqual(harness.updates, []);
    assert.deepEqual(harness.excerpts, []);
  });
}

async function completeFakeLaunchFailure(harness, mode, error) {
  if (mode === 'synchronous spawn') harness.dependencies.spawn = () => { throw error; };
  const run = startProcessRun(settings('success'), harness.callbacks, harness.dependencies);
  if (mode === 'pre-spawn child error') {
    harness.child.emit('error', error);
    harness.child.emit('error', { code: 'EACCES', path: 'SECOND_ERROR_PATH', message: 'SECOND_ERROR_MESSAGE' });
    harness.child.emit('close', -1, null);
  }
  return { result: await run.done, stopped: await run.stop() };
}

function captureLaunchDetails(harness, throws = false) {
  const details = [];
  harness.callbacks.onLaunchError = (...args) => {
    details.push(args);
    if (throws) throw new Error('SYNTHETIC_DETAILS_CALLBACK_FAILURE');
  };
  return details;
}

function assertLaunchDetails(harness, details, expected, outcome, reason = 'PROCESS_LAUNCH_REASON_UNKNOWN') {
  assert.equal(details.length, 1);
  assert.equal(details[0].length, 1);
  assert.equal(typeof details[0][0], 'string');
  assert.deepEqual(JSON.parse(details[0][0]), expected);
  assert.doesNotMatch(details[0][0], /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
  assertDiagnostics(harness.diagnostics, ['PROCESS_LAUNCH_FAILED', reason]);
  assert.deepEqual(outcome, { result: { status: 'error', error: 'Program launch failed.' }, stopped: true });
  assert.deepEqual(harness.errors, [['Program launch failed.']]);
  assert.deepEqual(harness.cleanup, []);
  assert.deepEqual(harness.updates, []);
  assert.deepEqual(harness.excerpts, []);
}

for (const mode of ['synchronous spawn', 'pre-spawn child error']) {
  test(`${mode} reports authorized own OS fields once while omitting other error data`, options, async () => {
    // Arrange: paths/messages are authorized here, not in the independent fixed-event callback.
    const harness = launchDiagnosticHarness();
    const details = captureLaunchDetails(harness);
    const error = Object.assign(privateLaunchError(), { code: 'ENOENT', argv: ['OMITTED_ARGV'], wholeObject: { secret: 'OMITTED_OBJECT' } });
    const expected = {
      code: 'ENOENT', errno: -987654, syscall: 'SYNTHETIC_PRIVATE_SYSCALL',
      path: 'SYNTHETIC_PRIVATE_PATH', message: 'SYNTHETIC_PRIVATE_MESSAGE',
    };
    // Act: async repeats use different codes and details but cannot replace the first record.
    const outcome = await completeFakeLaunchFailure(harness, mode, error);
    // Assert: nonenumerable Error.message is included; stack/argv/env/pid/full objects are not.
    assertLaunchDetails(harness, details, expected, outcome, 'PROCESS_LAUNCH_REASON_ENOENT');
    assert.doesNotMatch(details[0][0], /STACK|ARGV|ENV|OMITTED|SECOND_ERROR|"pid"|"spawnargs"|"wholeObject"/);
    assert.doesNotMatch(JSON.stringify(harness.diagnostics), /SYNTHETIC_PRIVATE|987654/);
  });

  test(`${mode} JSON-encodes launch text as one physical line without losing authorized content`, options, async () => {
    // Arrange
    const harness = launchDiagnosticHarness();
    const details = captureLaunchDetails(harness);
    const text = 'synthetic "quote" \\ é😀\n\r\t\b\f\u0000\u001b\u007f\u0085\u2028\u2029';
    const error = { code: 'EACCES', path: text, message: text, syscall: text, errno: -13 };
    // Act
    const outcome = await completeFakeLaunchFailure(harness, mode, error);
    // Assert: round-trip plus explicit escapes prevents forged physical log lines.
    assertLaunchDetails(harness, details, error, outcome, 'PROCESS_LAUNCH_REASON_EACCES');
    for (const escape of ['\\"', '\\\\', '\\n', '\\r', '\\t', '\\u0000', '\\u001b', '\\u007f', '\\u0085', '\\u2028', '\\u2029']) {
      assert.ok(details[0][0].includes(escape));
    }
  });

  for (const [label, input, expected] of [
    ['short fields', 'é😀', 'é😀'],
    ['reserved-suffix boundary', 'x'.repeat(4_085), 'x'.repeat(4_085)],
    ['ASCII overflow', 'x'.repeat(4_097), `${'x'.repeat(4_085)}[TRUNCATED]`],
    ['multibyte overflow', '😀'.repeat(1_025), `${'😀'.repeat(1_021)}[TRUNCATED]`],
  ]) {
    test(`${mode} bounds each launch field in UTF-8 including suffix for ${label}`, options, async () => {
      // Arrange: the bound applies independently to every authorized string field.
      const harness = launchDiagnosticHarness();
      const details = captureLaunchDetails(harness);
      const fields = ['code', 'errno', 'syscall', 'path', 'message'];
      const error = Object.fromEntries(fields.map(field => [field, input]));
      // Act
      const outcome = await completeFakeLaunchFailure(harness, mode, error);
      // Assert: no split Unicode scalar and no field exceeds 4096 decoded UTF-8 bytes.
      assertLaunchDetails(harness, details, Object.fromEntries(fields.map(field => [field, expected])), outcome);
      for (const value of Object.values(JSON.parse(details[0][0]))) {
        assert.ok(Buffer.byteLength(value, 'utf8') <= 4_096);
        assert.doesNotMatch(value, /�/);
      }
    });
  }

  test(`${mode} omits inherited and undefined fields and never invokes unrelated serialization hooks`, options, async () => {
    // Arrange: only own data fields qualify; unrelated getters/toJSON must remain untouched.
    const harness = launchDiagnosticHarness();
    const details = captureLaunchDetails(harness);
    let reads = 0;
    const error = Object.assign(Object.create({ path: 'INHERITED_PATH', message: 'INHERITED_MESSAGE' }), {
      code: undefined, errno: 0, syscall: '',
      toJSON() { reads++; throw new Error('UNAUTHORIZED_SERIALIZATION'); },
    });
    Object.defineProperty(error, 'stack', { get() { reads++; throw new Error('UNAUTHORIZED_STACK'); } });
    // Act
    const outcome = await completeFakeLaunchFailure(harness, mode, error);
    // Assert: zero and empty string are retained, unlike absent/undefined/inherited fields.
    assertLaunchDetails(harness, details, { errno: 0, syscall: '' }, outcome);
    assert.equal(reads, 0);
  });

  for (const [label, makeError] of [
    ...['code', 'errno', 'syscall', 'path', 'message'].map(field => [
      `accessor ${field}`, state => Object.defineProperty({}, field, {
        get() { state.reads++; throw new Error('UNAUTHORIZED_GETTER'); },
      }),
    ]),
    ['proxy', state => new Proxy({ code: 'ENOENT' }, {
      get() { state.reads++; throw new Error('UNAUTHORIZED_PROXY_GET'); },
      getOwnPropertyDescriptor() { state.reads++; throw new Error('UNAUTHORIZED_PROXY_INSPECTION'); },
      ownKeys() { state.reads++; throw new Error('UNAUTHORIZED_PROXY_KEYS'); },
    })],
    ['revoked proxy', () => { const proxy = Proxy.revocable({}, {}); proxy.revoke(); return proxy.proxy; }],
    ['nonfinite number', () => ({ errno: Infinity })],
    ['NaN number', () => ({ errno: NaN })],
    ['object field', () => ({ path: { secret: 'UNAUTHORIZED_NESTED_OBJECT' } })],
    ['boolean field', () => ({ message: false })],
    ['null error', () => null],
    ['primitive error', () => 'UNAUTHORIZED_PRIMITIVE'],
  ]) {
    test(`${mode} reports fixed launch-details fallback for ${label} without running user code`, options, async () => {
      // Arrange
      const harness = launchDiagnosticHarness();
      const details = captureLaunchDetails(harness);
      const state = { reads: 0 };
      const error = makeError(state);
      // Act
      const outcome = await completeFakeLaunchFailure(harness, mode, error);
      // Assert: unsafe inspection is never performed, and fallback is fixed single-line JSON.
      assertLaunchDetails(harness, details, { details: 'UNSAFE_OR_UNAVAILABLE' }, outcome);
      assert.equal(details[0][0], '{"details":"UNSAFE_OR_UNAVAILABLE"}');
      assert.equal(state.reads, 0);
    });
  }

  test(`${mode} ignores an absent launch-details callback`, options, async () => {
    // Arrange: existing callbacks retain their separate fixed-string contract.
    const harness = launchDiagnosticHarness();
    const error = Object.assign(privateLaunchError(), { code: 'EINVAL' });
    // Act
    const outcome = await completeFakeLaunchFailure(harness, mode, error);
    // Assert
    assertDiagnostics(harness.diagnostics, ['PROCESS_LAUNCH_FAILED', 'PROCESS_LAUNCH_REASON_EINVAL']);
    assert.deepEqual(outcome, { result: { status: 'error', error: 'Program launch failed.' }, stopped: true });
    assert.deepEqual(harness.errors, [['Program launch failed.']]);
    assert.deepEqual(harness.cleanup, []);
  });

  test(`${mode} swallows launch-details callback failure independently of other callback failures`, options, async () => {
    // Arrange
    const harness = launchDiagnosticHarness(true);
    const details = captureLaunchDetails(harness, true);
    const error = { code: 'ENOENT', path: 'synthetic-path', message: 'synthetic OS message' };
    // Act
    const outcome = await completeFakeLaunchFailure(harness, mode, error);
    // Assert: first record still attempted exactly once and completion remains unchanged.
    assertLaunchDetails(harness, details, error, outcome, 'PROCESS_LAUNCH_REASON_ENOENT');
    assert.doesNotMatch(details[0][0], /CALLBACK_FAILURE|SECOND_ERROR/);
  });
}

test('intentional stop has its own completion diagnostic rather than an exit failure', options, async () => {
  // Arrange
  const { child, diagnostics, errors, run } = diagnosticRun();
  // Act
  child.emit('spawn');
  const stopped = run.stop();
  const repeated = run.stop();
  child.emit('exit', null, 'SIGTERM');
  child.emit('close', null, 'SIGTERM');
  const certainty = await Promise.all([stopped, repeated]);
  const result = await run.done;
  await run.stop();
  // Assert: repeated stop requests cannot duplicate completion events.
  assertDiagnostics(diagnostics, ['PROCESS_SPAWN_SUCCEEDED', 'PROCESS_RUN_COMPLETED_AFTER_STOP_REQUEST']);
  assert.deepEqual(certainty, [true, true]);
  assert.deepEqual(result, { status: 'stopped' });
  assert.deepEqual(errors, []);
});

test('throwing diagnostic callbacks cannot interrupt parsing or successful completion', options, async () => {
  // Arrange
  const { child, diagnostics, updates, errors, run } = diagnosticRun(() => {
    throw new Error('test-only diagnostic callback exception');
  });
  // Act
  child.emit('spawn');
  child.stdout.write('<svg>first</svg>\n');
  child.stdout.write('<svg>final</svg>\n');
  child.stderr.write('test-only callback stderr marker');
  child.stderr.write('another test-only callback stderr marker');
  child.emit('exit', 0, null);
  child.emit('close', 0, null);
  const result = await run.done;
  // Assert: callback failures are swallowed and attempted events remain deduplicated.
  assertDiagnostics(diagnostics, [
    'PROCESS_SPAWN_SUCCEEDED', 'PROCESS_STDOUT_FIRST_DATA',
    'PROCESS_IMAGE_RECORD_PARSED', 'PROCESS_STDERR_FIRST_DATA', 'PROCESS_EXITED_SUCCESSFULLY',
  ]);
  assert.deepEqual(result, { status: 'success' });
  assert.equal(updates.length, 2);
  assert.deepEqual(errors, []);
});

// Native tests: only process.execPath + checked-in local fixtures, no network/files.
test('runtime admits expanded text controls over byte-split framing and skips invalid siblings before final output', options, async () => {
  // Arrange - Only the process boundary is mocked; real framing/parser/render admission run.
  const { child, diagnostics, updates, errors, run } = diagnosticRun();
  const bytes = Buffer.from('text:é|font-size:12;label:C;label-size:40;padding:0;padding-x:23;padding-y:7;line-height:3;label-align:right;label-weight:bold;label-gap:0.5;border:16\r\ntext:A|font-size:64;label:C;label-size:4;label-gap:0\n');
  // Act
  child.emit('spawn'); for (const byte of bytes) child.stdout.write(Buffer.from([byte]));
  child.stdout.write('text:bad|font-size:0\ntext:bad|padding-x:-1\ntext:bad|line-height:0.99\ntext:bad|label-gap:1;label-gap:2\ntext:bad|label-weight:700\ntext:bad|label-align:start\ntext:bad|border:16.1\n');
  child.stdout.write('text:bad|font-size:1e2\ntext:bad|padding-x:72\ntext:bad|font-size:1000000000000\ntext:bad|label:C;label-gap:1000000000000\n');
  child.stdout.write('text:final|font-size:0.5\n');
  child.emit('exit', 0, null); child.emit('close', 0, null);
  const result = await run.done;
  // Assert
  assert.deepEqual(updates.map(update => update.value), ['é', 'A', 'final']);
  assert.deepEqual([updates[0].options['font-size'], updates[0].options['label-size'], updates[0].options['padding-x'], updates[0].options['padding-y'], updates[0].options['label-align'], updates[0].options['label-weight'], updates[0].options['label-gap'], updates[0].options['line-height'], updates[0].options.border], [12, 40, 23, 7, 'right', 'bold', 0.5, 3, 16]);
  assert.deepEqual([updates[1].options['font-size'], updates[1].options['label-size'], updates[2].options['font-size'], updates[2].options['padding-x'], updates[2].options['label-gap'], updates[2].options.label], [64, 4, 0.5, 16, 8, '']);
  assert.ok(updates.every(update => Object.isFrozen(update) && Object.isFrozen(update.options) && Object.isFrozen(update.overrides)));
  assert.deepEqual([result, errors], [{ status: 'success' }, []]);
  assertDiagnostics(diagnostics, ['PROCESS_SPAWN_SUCCEEDED', 'PROCESS_STDOUT_FIRST_DATA', 'PROCESS_EXITED_SUCCESSFULLY']);
});
test('runtime frames UTF-8 above captions and skips invalid caption order/siblings without poisoning later output', options, async () => {
  // Arrange - Mock process only; framing, parsing and rendering admission remain real.
  const { child, diagnostics, updates, errors, run } = diagnosticRun();
  const bytes = Buffer.from('text:42|font-size:48;label:cafe\u0301😀;label-size:14.25;label-color:ivory;label-position:above\r\n');
  // Act
  child.emit('spawn'); for (const byte of bytes) child.stdout.write(Buffer.from([byte]));
  child.stdout.write('text:bad|label:Items;label-size:0\ntext:bad|label-color:accent\ntext:bad|label:a;label:b\ntext:bad|font-size:0\ntext:bad|label:a\0b\n');
  child.stdout.write('text:bad|color:red;label-position:Above\ntext:bad|label-position:\ntext:bad|label-position:above;label-position:below\ntext:bad|label-position:above;scale:80\n');
  child.stdout.write('text:below|label:C;label-position:below\n');
  child.stdout.write('text:next\n'); child.emit('exit', 0, null); child.emit('close', 0, null);
  const result = await run.done;
  // Assert
  assert.deepEqual(updates.map(update => [update.kind, update.value, update.options.label]), [['text', '42', 'cafe\u0301😀'], ['text', 'below', 'C'], ['text', 'next', '']]);
  assert.deepEqual(updates.map(update => update.options['label-position']), ['above', 'below', 'below']);
  assert.equal(updates[0].overrides['label-position'], 'above'); assert.equal(Object.hasOwn(updates[2].overrides, 'label-position'), false);
  assert.deepEqual([updates[0].options['font-size'], updates[0].options['label-size'], updates[0].options['label-color']], [48, 14.25, '#fffff0']);
  assert.ok(updates.every(update => Object.isFrozen(update) && Object.isFrozen(update.options) && Object.isFrozen(update.overrides)));
  assert.deepEqual([result, errors], [{ status: 'success' }, []]);
  assertDiagnostics(diagnostics, ['PROCESS_SPAWN_SUCCEEDED', 'PROCESS_STDOUT_FIRST_DATA', 'PROCESS_EXITED_SUCCESSFULLY']);
});
test('runtime emits complete text/progress DTOs, skips invalid primitives and preserves later images', options, async () => {
  // Arrange
  const { child, diagnostics, updates, errors, run } = diagnosticRun();
  const json = '{"image":"<svg/>","title":"literal"}';
  // Act
  child.emit('spawn');
  child.stdout.write(`hello\n${json}\nprogress:-5\nprogress:101\ntext:valid|color:red;background:ivory;border:0.5;border-color:blue\n`);
  child.stdout.write('progress:1e2\ntext:bad|unknown:x\nprogress:12.345678901234567|scale:50;thickness:16;value-size:32\ntext:bad|background:transparent\ntext:bad|border:true\n');
  child.stdout.write('<svg>final</svg>\n');
  child.emit('exit', 0, null); child.emit('close', 0, null);
  const result = await run.done;
  // Assert
  assert.deepEqual(updates.map(update => [update.kind, update.value ?? update.image]), [
    ['text', 'hello'], ['text', json], ['progress', 0], ['progress', 100], ['text', 'valid'],
    ['image', `data:image/svg+xml,${encodeURIComponent('<svg>final</svg>')}`],
  ]);
  assert.deepEqual(updates[4].overrides, { color: '#ff0000', background: '#fffff0', border: 0.5, 'border-color': '#0000ff' });
  assert.ok(updates.every(update => Object.isFrozen(update) && !Object.hasOwn(update, 'title')));
  assertDiagnostics(diagnostics, ['PROCESS_SPAWN_SUCCEEDED', 'PROCESS_STDOUT_FIRST_DATA', 'PROCESS_IMAGE_RECORD_PARSED', 'PROCESS_EXITED_SUCCESSFULLY']);
  assert.deepEqual([result, errors], [{ status: 'success' }, []]);
});

test('text-only runtime output does not invent an image diagnostic or expose record values', options, async () => {
  // Arrange
  const { child, diagnostics, updates, errors, run } = diagnosticRun();
  // Act
  child.emit('spawn'); child.stdout.write('text:synthetic content\nprogress:100\n');
  const beforeExit = updates.length;
  child.emit('exit', 0, null); child.emit('close', 0, null);
  const result = await run.done;
  // Assert
  assert.equal(beforeExit, 2);
  assertDiagnostics(diagnostics, ['PROCESS_SPAWN_SUCCEEDED', 'PROCESS_STDOUT_FIRST_DATA', 'PROCESS_EXITED_SUCCESSFULLY']);
  assert.deepEqual([result, errors], [{ status: 'success' }, []]);
});

test('runtime accepts renamed vocabulary and symbolic annotations while obsolete mixed records skip atomically', options, async () => {
  // Arrange - Mock the process boundary; parse and admission are real.
  const { child, diagnostics, updates, errors, run } = diagnosticRun();
  // Act
  child.emit('spawn');
  child.stdout.write('text:Hi|font-size:16;align:left;valign:bottom\nprogress:42|scale:100;label:Hi;value-color:accent;label-color:accent\n');
  child.stdout.write('text:bad|color:red;size:16\ntext:bad|position:center\ntext:bad|align:start\ntext:bad|foreground:white\nprogress:42|size:80\nprogress:42|value-color:accent;label-color:Accent\n');
  child.emit('exit', 0, null); child.emit('close', 0, null);
  const result = await run.done;
  // Assert
  assert.deepEqual(updates.map(update => [update.kind, update.value]), [['text', 'Hi'], ['progress', 42]]);
  assert.deepEqual([updates[0].options['font-size'], updates[0].options.align, updates[0].options.valign], [16, 'left', 'bottom']);
  assert.deepEqual([updates[1].options.scale, updates[1].options['value-color'], updates[1].options['label-color']], [100, '#969696', '#969696']);
  assert.equal(updates[1].overrides['value-color'], 'accent');
  assert.deepEqual([result, errors], [{ status: 'success' }, []]);
  assertDiagnostics(diagnostics, ['PROCESS_SPAWN_SUCCEEDED', 'PROCESS_STDOUT_FIRST_DATA', 'PROCESS_EXITED_SUCCESSFULLY']);
});

// Every held run is registered for stop; escaped/unrelated fixtures have owned-PID cleanup.
test('runtime frames ratio/display records, skips invalid ratios, and never treats a caption as completion', options, async () => {
  // Arrange - Only the process boundary is doubled; UTF-8 framing, parsing and rendering admission are real.
  const { child, diagnostics, updates, errors, run } = diagnosticRun();
  const bytes = Buffer.from('progress:17/1034|display:17 done;label:Build\r\nprogress:99.96\nprogress:1/2|display:100%\nprogress:1/2|display:\n');
  // Act
  child.emit('spawn');
  for (const byte of bytes) child.stdout.write(Buffer.from([byte]));
  child.stdout.write('progress:1/0|display:bad\nprogress:1/2/3\nprogress:1e2/3\nprogress:1/2|display:bad;display:duplicate\nprogress:1/2|scale:50;thickness:16;value-size:32;label:Hi\n');
  const beforeExit = updates.map(update => [update.value, update.options.display]);
  child.stdout.write('progress:17/1034\n');
  child.emit('exit', 0, null); child.emit('close', 0, null);
  const result = await run.done;
  // Assert
  assert.deepEqual(beforeExit, [[1700 / 1034, '17 done'], [99.96, undefined], [50, '100%'], [50, '']]);
  assert.equal(updates.length, 5); assert.equal(updates[4].options.display, undefined);
  assert.equal(updates[4].value, 1700 / 1034);
  assert.ok(updates.every(update => Object.isFrozen(update) && Object.isFrozen(update.overrides)));
  assert.deepEqual([result, errors], [{ status: 'success' }, []]);
  assertDiagnostics(diagnostics, ['PROCESS_SPAWN_SUCCEEDED', 'PROCESS_STDOUT_FIRST_DATA', 'PROCESS_EXITED_SUCCESSFULLY']);
});

// Every held run is registered for stop; escaped/unrelated fixtures have owned-PID cleanup.
test('literal argv and explicit cwd reach the fixture without shell interpretation', options, async t => {
  // Arrange
  const args = ['', '  spaces  ', '$(private); * | >', 'é😀'];
  const updates = [], errors = [];
  const run = startProcessRun(settings('argv', args), { onUpdate: update => updates.push(update), onError: error => errors.push(error) });
  t.after(() => run.stop());
  // Act
  const result = await run.done;
  // Assert
  assert.equal(result.status, 'success');
  assert.equal(updates[0].kind, 'text');
  assert.deepEqual(JSON.parse(updates[0].value), { args, cwd: cwd.replace(/\/$/, '') });
  assert.deepEqual(errors, []);
});

test('stderr drains separately and successful completion retains the final update', options, async t => {
  // Arrange
  const updates = [], errors = [];
  const run = startProcessRun(settings('stderr'), { onUpdate: update => updates.push(update), onError: error => errors.push(error) });
  t.after(() => run.stop());
  // Act
  const result = await run.done;
  // Assert
  assert.equal(result.status, 'success');
  assert.deepEqual(updates, [{ kind: 'image', image: `data:image/svg+xml,${encodeURIComponent('<svg>final</svg>')}` }]);
  assert.deepEqual(errors, []);
});

for (const [mode, message] of [['nonzero', 'Program exited unsuccessfully.'], ['protocol', 'Image protocol error.'], ['unterminated', 'Image protocol error.'], ['invalid-utf8', 'Image protocol error.']]) {
  test(`${mode} produces one fixed error and never retries`, options, async t => {
    // Arrange
    const errors = [], updates = [];
    const run = startProcessRun(settings(mode), { onUpdate: update => updates.push(update), onError: error => errors.push(error) });
    t.after(() => run.stop());
    // Act
    const result = await run.done;
    // Assert
    assert.deepEqual(result, { status: 'error', error: message });
    assert.deepEqual(errors, [message]);
    if (mode !== 'nonzero') assert.deepEqual(updates, []);
  });
}

test('launch errors are sanitized and spawn uses no shell with an owned process group', options, async () => {
  // Arrange
  const child = fakeChild();
  const calls = [], errors = [];
  const input = settings('success');
  const run = startProcessRun(input, { onUpdate() {}, onError: error => errors.push(error) }, {
    spawn(executable, args, spawnOptions) {
      calls.push({ executable, args, options: spawnOptions });
      queueMicrotask(() => {
        child.emit('error', new Error('private executable/env/exception'));
        child.stdout.end(); child.stderr.end(); child.emit('close', -1, null);
      });
      return child;
    },
    signalGroup() {},
    async waitForGroupExit() { return true; },
  });
  // Act
  const result = await run.done;
  // Assert
  assert.deepEqual(result, { status: 'error', error: 'Program launch failed.' });
  assert.deepEqual(errors, ['Program launch failed.']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, process.execPath);
  assert.deepEqual(calls[0].args, input.args);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.cwd, cwd);
});

for (const [label, responses, expectedSignals, certain] of [
  ['TERM success', [true], ['SIGTERM'], true],
  ['KILL escalation', [false, true], ['SIGTERM', 'SIGKILL'], true],
  ['uncertain cleanup', [false, false], ['SIGTERM', 'SIGKILL'], false],
]) {
  test(`${label} uses bounded group cleanup and reports certainty`, options, async () => {
    // Arrange: timers/group boundary mocked, not runner state logic.
    const child = fakeChild();
    const signals = [], waits = [], errors = [];
    const answers = [...responses];
    const run = startProcessRun(settings('success'), { onUpdate() {}, onError: error => errors.push(error) }, {
      spawn: () => child,
      signalGroup(pid, signal) {
        assert.equal(pid, child.pid);
        signals.push(signal);
        if (signal === expectedSignals.at(-1)) {
          child.stdout.end(); child.stderr.end(); child.emit('exit', null, signal); child.emit('close', null, signal);
        }
      },
      async waitForGroupExit(pid, timeoutMs) { waits.push({ pid, timeoutMs }); return answers.shift(); },
    });
    // Act
    const result = await run.stop();
    const repeated = await run.stop();
    // Assert
    assert.equal(result, certain);
    assert.equal(repeated, certain);
    assert.deepEqual(signals, expectedSignals);
    assert.deepEqual(waits, expectedSignals.map(() => ({ pid: child.pid, timeoutMs: 1_000 })));
    assert.deepEqual(errors, certain ? [] : ['Process cleanup uncertain.']);
  });
}

test('leader exit cleans ordinary descendants holding inherited output pipes and retains final update', options, async t => {
  // Arrange: IPC readiness in the fixture precedes leader exit; no sleeps/polling.
  const updates = [], errors = [];
  const image = '<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" fill="#39d98a"/></svg>';
  const run = startProcessRun({ executable: process.execPath, args: [processFixture, 'exiting-leader'], cwd }, {
    onUpdate: update => updates.push(update), onError: error => errors.push(error),
  });
  t.after(() => run.stop());
  // Act: completion requires exit-triggered cleanup before inherited pipes close.
  const result = await run.done;
  // Assert
  assert.deepEqual(result, { status: 'success' });
  assert.equal(updates.length, 2);
  assert.equal(updates[0].kind, 'text');
  assert.equal(updates[1].image, `data:image/svg+xml,${encodeURIComponent(image)}`);
  const info = JSON.parse(updates[0].value);
  assert.ok(Number.isInteger(info.pid) && info.pid > 0);
  assert.ok(Number.isInteger(info.descendant) && info.descendant > 0);
  assert.equal(alive(info.pid), false);
  assert.equal(alive(info.descendant), false);
  assert.deepEqual(errors, []);
});

for (const mode of ['tree', 'stubborn', 'escaped']) {
  test(`native ${mode} cleanup respects process-group ownership and unrelated processes`, options, async t => {
    // Arrange
    const unrelated = spawn(process.execPath, [processFixture, 'hold'], { stdio: ['ignore', 'ignore', 'ignore'] });
    t.after(async () => {
      if (unrelated.exitCode === null && unrelated.signalCode === null) {
        const closed = once(unrelated, 'close'); unrelated.kill('SIGKILL'); await closed;
      }
    });
    await once(unrelated, 'spawn');
    const readiness = deferred();
    const errors = [];
    const run = startProcessRun({ executable: process.execPath, args: [processFixture, mode], cwd }, {
      onUpdate(update) {
        const info = JSON.parse(update.value);
        // Escaped daemon cleanup is test-owned, explicitly NOT a runner guarantee.
        if (mode === 'escaped') t.after(() => killOwned(info.descendant));
        readiness.resolve(info);
      }, onError: error => errors.push(error),
    });
    t.after(() => run.stop());
    const info = await readiness.promise;
    // Act
    const certain = await run.stop();
    // Assert
    assert.equal(certain, true);
    assert.equal(alive(info.pid), false);
    assert.equal(alive(info.descendant), mode === 'escaped');
    assert.equal(alive(unrelated.pid), true);
    assert.deepEqual(errors, []);
  });
}
