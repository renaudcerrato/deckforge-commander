import test from 'node:test';
import assert from 'node:assert/strict';
import { startWindowsProcessTransport } from '../src/core/windows-process-transport.mjs';
import { startProcessRun } from '../src/core/process-runner.mjs';
import { executionPlatform } from '../src/core/execution-paths.mjs';
import { validateSettings } from '../src/core/settings.mjs';

const execution = () => ({ executable: 'C:/synthetic/node.exe', args: ['', 'é🙂', 'a"b', 'trailing\\'], cwd: 'C:/synthetic' });
const runnerExecution = (platform = executionPlatform()) => ({
  executable: platform === 'win32' ? 'C:/synthetic/known-fixture' : '/synthetic/known-fixture', args: [],
});
const result = overrides => ({ rootExit: true, rootCode: 0, launchError: false, launchCode: 0, callbackError: false, nativeError: false, stdoutError: false, cleanupCertain: true, ...overrides });

// W3 rev2: only the shared facade input follows the host; native inputs stay Windows-specific.
for (const platform of ['posix', 'win32']) {
  test(`${platform} shared-runner fixture passes real validation and rejects mismatched paths`, () => {
    // Arrange
    const input = runnerExecution(platform), otherPlatform = platform === 'win32' ? 'posix' : 'win32';
    // Act
    const validated = validateSettings(input, platform);
    // Assert
    assert.deepEqual(validated, input);
    assert.throws(() => validateSettings(input, otherPlatform), { diagnosticCode: 'INVALID_EXECUTABLE' });
  });
}
function boundary() {
  let deliver, resolve, reject, bytes, stops = 0;
  const done = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {
    binding: { start(snapshot, callback) { bytes = snapshot; deliver = callback; return { done, stop() { stops++; return done; } }; } },
    emit: (...args) => deliver(...args), resolve, reject,
    get bytes() { return bytes; }, get stops() { return stops; },
  };
}
function callbacks(events) {
  return Object.fromEntries(['onSpawn', 'onStdout', 'onStderr', 'onExit', 'onStdoutEnd', 'onStderrEnd', 'onClose', 'onStdoutError', 'onError'].map(name => [name, value => events.push([name, value])]));
}
// Decode only the mocked external boundary to verify detached launch contents.
function decode(bytes) {
  const count = bytes.readUInt32LE(4), envCount = bytes.readUInt32LE(8), hasCwd = bytes.readUInt32LE(12);
  let offset = 16;
  function string() { const length = bytes.readUInt32LE(offset); offset += 4; const value = bytes.toString('utf16le', offset, offset + length * 2); offset += length * 2; return value; }
  const executable = string(), cwd = hasCwd ? string() : undefined;
  const args = Array.from({ length: count }, string), env = {};
  for (let i = 0; i < envCount; i++) env[string()] = string();
  assert.equal(offset, bytes.length);
  return { executable, args, cwd, env };
}

test('Windows launch detaches literal argv, cwd and complete environment before caller mutation', async () => {
  // Arrange — WIN-WINDOWS-FEATURE: mock the native boundary, not validation.
  const fake = boundary(), input = execution(), env = { SYNTHETIC: 'before' }, events = [];
  // Act
  const transport = startWindowsProcessTransport(input, callbacks(events), env, { nativeBinding: fake.binding });
  input.args[1] = 'after'; input.cwd = 'C:/later'; env.SYNTHETIC = 'after';
  const observed = decode(fake.bytes);
  fake.resolve(result());
  const certain = await transport.stop();
  // Assert
  assert.deepEqual(observed, { ...execution(), env: { SYNTHETIC: 'before' } });
  assert.equal(certain, true);
});

for (const cwd of [undefined, 'C:\\synthetic']) test(`complete empty environment and ${cwd === undefined ? 'omitted' : 'explicit'} cwd remain distinct`, async () => {
  // Arrange
  const fake = boundary(), input = { executable: 'C:\\synthetic\\node.exe', args: [], ...(cwd === undefined ? {} : { cwd }) };
  // Act
  const transport = startWindowsProcessTransport(input, callbacks([]), {}, { nativeBinding: fake.binding });
  const observed = decode(fake.bytes); fake.resolve(result()); await transport.stop();
  // Assert — no implicit overlay of the host's environment.
  assert.deepEqual(observed, { executable: input.executable, args: [], cwd, env: {} });
});

const invalidInputs = [
  ['relative executable', () => ({ executable: 'node.exe', args: [] }), {}],
  ['drive relative', () => ({ executable: 'C:node.exe', args: [] }), {}],
  ['UNC executable', () => ({ executable: '\\\\server\\share\\node.exe', args: [] }), {}],
  ['device executable', () => ({ executable: '\\\\?\\C:\\node.exe', args: [] }), {}],
  ['relative cwd', () => ({ ...execution(), cwd: 'relative' }), {}],
  ['holey argv', () => ({ ...execution(), args: Array(1) }), {}],
  ['NUL argv', () => ({ ...execution(), args: ['x\0y'] }), {}],
  ['nonstring argv', () => ({ ...execution(), args: [1] }), {}],
  ['oversize snapshot', () => ({ ...execution(), args: ['x'.repeat(524288)] }), {}],
  ['invalid env key', execution, { 'BAD=KEY': 'value' }],
  ['invalid env value', execution, { SAFE: null }],
];
for (const [label, make, env] of invalidInputs) test(`${label} rejects without native submission`, () => {
  // Arrange
  let submissions = 0;
  const nativeBinding = { start() { submissions++; throw Error('unexpected submission'); } };
  const input = make();
  // Act / Assert
  assert.throws(() => startWindowsProcessTransport(input, callbacks([]), env, { nativeBinding }), { code: 'EINVAL', message: 'Program launch failed.' });
  assert.equal(submissions, 0);
});

for (const site of ['execution', 'argv', 'environment', 'proxy']) test(`${site} hostile access does not evaluate getters or proxy traps`, () => {
  // Arrange
  let reads = 0, submissions = 0;
  const getter = () => { reads++; throw Error('synthetic private exception'); };
  let input = execution(), env = {};
  if (site === 'execution') Object.defineProperty(input, 'executable', { get: getter });
  if (site === 'argv') Object.defineProperty(input.args, '0', { get: getter });
  if (site === 'environment') Object.defineProperty(env, 'SAFE', { get: getter });
  if (site === 'proxy') input = new Proxy(input, { ownKeys: getter });
  // Act / Assert
  assert.throws(() => startWindowsProcessTransport(input, callbacks([]), env, { nativeBinding: { start() { submissions++; } } }), { code: 'EINVAL' });
  assert.equal(reads, 0); assert.equal(submissions, 0);
});

test('ordered raw bytes precede reader end and close; late callbacks are rejected', async () => {
  // Arrange
  const fake = boundary(), events = [], stdout = Buffer.from([0xc3]), stderr = Buffer.from([0xa9]);
  const transport = startWindowsProcessTransport(execution(), callbacks(events), {}, { nativeBinding: fake.binding });
  // Act
  fake.emit(0); fake.emit(1, stdout); fake.emit(2, stderr); fake.emit(3, 17);
  fake.resolve(result({ rootCode: 17 })); await transport.stop(); fake.emit(1, Buffer.from('late'));
  // Assert — do not decode or coalesce transport bytes.
  assert.deepEqual(events.map(([name]) => name), ['onSpawn', 'onStdout', 'onStderr', 'onExit', 'onStdoutEnd', 'onStderrEnd', 'onClose']);
  assert.equal(events[1][1], stdout); assert.equal(events[2][1], stderr);
  assert.deepEqual(events.at(-1)[1], { code: 17, terminated: false });
});

for (const [label, overrides, certainty, expected] of [
  ['ordinary completion', {}, true, []],
  ['uncertain cleanup', { cleanupCertain: false }, false, []],
  ['native failure with uncertain cleanup', { nativeError: true, cleanupCertain: false }, false, []],
  ['callback failure', { callbackError: true }, true, ['onStdoutError']],
  ['stdout read failure', { nativeError: true, stdoutError: true }, true, ['onStdoutError']],
  ['non-stdout native failure', { nativeError: true }, true, ['onError']],
  ['missing executable', { rootExit: false, launchError: true, launchCode: 2 }, true, ['onError']],
]) test(`${label} preserves cleanup certainty independently from output and launch errors`, async () => {
  // Arrange
  const fake = boundary(), events = [];
  const transport = startWindowsProcessTransport(execution(), callbacks(events), {}, { nativeBinding: fake.binding });
  // Act
  const first = transport.stop(), second = transport.stop(); fake.resolve(result(overrides));
  const certain = await first;
  // Assert
  assert.equal(first, second); assert.equal(fake.stops, 1); assert.equal(certain, certainty);
  assert.deepEqual(events.slice(0, -3).map(([name]) => name), expected);
  assert.deepEqual(events.slice(-3).map(([name]) => name), ['onStdoutEnd', 'onStderrEnd', 'onClose']);
  if (overrides.launchError) assert.equal(events[0][1].code, 'ENOENT');
  if (overrides.nativeError && certainty && !overrides.stdoutError) {
    assert.equal(events[0][1].code, 'UNKNOWN');
    assert.equal(events[0][1].message, 'Program launch failed.');
  }
});

test('native promise rejection cannot certify cleanup', async () => {
  // Arrange
  const fake = boundary(), transport = startWindowsProcessTransport(execution(), callbacks([]), {}, { nativeBinding: fake.binding });
  // Act
  const stopping = transport.stop(); fake.reject(Error('synthetic native failure'));
  const certain = await stopping;
  // Assert
  assert.equal(certain, false);
});

// Recovery round 1: exercise public result priority through the actual Windows
// adapter and shared runner/framer. Only the external native binding is mocked.
const publicScenarios = [
  {
    label: 'ordinary completion', overrides: {},
    outcome: { status: 'success' }, errors: [], certainty: true, protocol: false,
  },
  {
    label: 'prelaunch Job or stdio setup failure', spawn: false,
    overrides: { rootExit: false, launchError: true, launchCode: 5, nativeError: true },
    outcome: { status: 'error', error: 'Program launch failed.' },
    errors: ['Program launch failed.'], certainty: true, protocol: false, launchReason: 'PROCESS_LAUNCH_REASON_EACCES',
  },
  {
    label: 'missing executable', spawn: false,
    overrides: { rootExit: false, launchError: true, launchCode: 2 },
    outcome: { status: 'error', error: 'Program launch failed.' },
    errors: ['Program launch failed.'], certainty: true, protocol: false, launchReason: 'PROCESS_LAUNCH_REASON_ENOENT',
  },
  {
    label: 'native cleanup uncertainty after accepted text',
    overrides: { nativeError: true, cleanupCertain: false },
    outcome: { status: 'error', error: 'Process cleanup uncertain.' },
    errors: ['Process cleanup uncertain.'], certainty: false, protocol: false,
  },
  {
    label: 'genuine stdout read failure after accepted text',
    overrides: { nativeError: true, stdoutError: true },
    outcome: { status: 'error', error: 'Image protocol error.' },
    errors: ['Image protocol error.'], certainty: true, protocol: true,
  },
  {
    label: 'non-stdout native failure with certain cleanup',
    overrides: { nativeError: true },
    outcome: { status: 'error', error: 'Program launch failed.' },
    errors: ['Program launch failed.'], certainty: true, protocol: false,
  },
  {
    label: 'invalid UTF-8 without a native error',
    bytes: Buffer.from([0xc3, 0x0a]), overrides: {},
    outcome: { status: 'error', error: 'Image protocol error.' },
    errors: ['Image protocol error.'], certainty: true, protocol: true,
  },
  {
    label: 'invalid UTF-8 retains protocol priority over uncertain cleanup',
    bytes: Buffer.from([0xc3, 0x0a]), overrides: { nativeError: true, cleanupCertain: false },
    outcome: { status: 'error', error: 'Image protocol error.' },
    errors: ['Image protocol error.', 'Process cleanup uncertain.'], certainty: false, protocol: true,
  },
  {
    label: 'native callback failure retains the existing output error route',
    overrides: { callbackError: true },
    outcome: { status: 'error', error: 'Image protocol error.' },
    errors: ['Image protocol error.'], certainty: true, protocol: true,
  },
];
for (const scenario of publicScenarios) test(`${scenario.label} preserves the public Windows runner result and stop certainty`, { timeout: 1000 }, async () => {
  // Arrange — valid shared settings; the test-only factory maps to synthetic
  // Windows execution without invoking POSIX spawn or a real executable.
  const fake = boundary(), updates = [], errors = [], diagnostics = [];
  let submissions = 0;
  const run = startProcessRun(runnerExecution(), {
    onUpdate: update => updates.push(update),
    onError: message => errors.push(message),
    onDiagnostic: event => diagnostics.push(event),
  }, {
    startTransport(_execution, transportCallbacks, environment) {
      submissions++;
      return startWindowsProcessTransport(execution(), transportCallbacks, environment, { nativeBinding: fake.binding });
    },
  }, { env: {} });

  // Act — deliveries occur strictly after both factories have returned.
  if (scenario.spawn !== false) {
    fake.emit(0);
    fake.emit(1, scenario.bytes ?? Buffer.from('text:accepted\n'));
    fake.emit(3, 0);
  }
  fake.resolve(result(scenario.overrides));
  const outcome = await run.done;
  const certainty = await run.stop();

  // Assert — status/error/boolean are public behavior, not native implementation.
  assert.equal(submissions, 1);
  assert.deepEqual(outcome, scenario.outcome);
  assert.equal(certainty, scenario.certainty);
  assert.deepEqual(errors, scenario.errors);
  assert.equal(diagnostics.includes('PROCESS_PROTOCOL_REJECTED'), scenario.protocol);
  assert.equal(diagnostics.includes('PROCESS_SPAWN_SUCCEEDED'), scenario.spawn !== false);
  assert.deepEqual(updates.map(update => ({ kind: update.kind, value: update.value })),
    scenario.spawn === false || scenario.bytes ? [] : [{ kind: 'text', value: 'accepted' }]);
  if (scenario.launchReason) {
    assert.equal(diagnostics.includes('PROCESS_LAUNCH_FAILED'), true);
    assert.equal(diagnostics.includes(scenario.launchReason), true);
  }
});
