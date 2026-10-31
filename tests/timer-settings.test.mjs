import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyTimerSettings, readIntervalSeconds, readActionOnPress, validateTimerSettings, getTimerInspectorConfiguration,
  sameTimerExecutionSettings, sameTimerInterval, applyTimerConfigurationEdit,
  timerSettingsDiagnosticCode, createTimerStateCoordinator,
} from '../src/core/timer-settings.mjs';
import { validateSettings } from '../src/core/settings.mjs';
import { parseArguments } from '../src/core/arguments.mjs';

const options = { timeout: 3000 };
const base = { executable: '/synthetic/program', argsText: '' };
const stored = { executable: '/synthetic/program', args: ['two words', ''], extra: { nested: [null, true, 42, 'retained'] } };
const marker = 'synthetic-sensitive-marker';

for (const title of ['a/b\\c.txt', '', null, 42, 'bad\0title', 'x'.repeat(8193)]) {
  test('TITLE-1 Loop title never changes execution or scheduling configuration', () => {
    // Arrange
    const input = { ...base, intervalSeconds: 17, actionOnPress: 'stop', title };
    const original = structuredClone(input);
    // Act
    const result = classifyTimerSettings(input, 'posix');
    const same = sameTimerExecutionSettings(input, { ...input, title: 'other' }, 'posix');
    // Assert
    assert.equal(result.kind, 'configured'); assert.equal(result.intervalSeconds, 17); assert.equal(result.actionOnPress, 'stop');
    assert.equal(same, true); assert.deepEqual(input, original);
    assert.equal(sameTimerExecutionSettings(input, { ...input, argsText: 'changed' }, 'posix'), false);
  });
}

// Slice 2: read-only setup accepts only validated supplied controls; no execution DTO.
for (const input of [{}, { executable: '' }, { argsText: '', args: 'malformed legacy' },
  { args: '["literal", ""]', cwd: '/synthetic/work' }, { themeColor: 'bad stored metadata' }]) {
  for (const actionOnPress of ['refresh', 'stop']) {
    for (const intervalSeconds of [1, 60, 86400]) {
      test(`Timer setup validates ${actionOnPress}/${intervalSeconds} controls without granting launch authority`, () => {
        // Arrange
        const snapshot = { ...input, actionOnPress, intervalSeconds }, original = structuredClone(snapshot);
        // Act
        const result = classifyTimerSettings(snapshot, 'posix');
        // Assert
        assert.deepEqual(result, { kind: 'setup', intervalSeconds, actionOnPress });
        assert.equal(Object.hasOwn(result, 'execution'), false);
        assert.deepEqual(snapshot, original);
        assert.throws(() => validateTimerSettings(snapshot, 'posix'), { message: 'Invalid settings.' });
      });
    }
  }
}
test('Timer missing controls default read-only while configured execution remains strict and detached', () => {
  // Arrange
  const input = { ...base, args: 'malformed legacy', themeColor: null }, original = structuredClone(input);
  // Act
  const setup = classifyTimerSettings({}, 'posix'), configured = classifyTimerSettings(input, 'posix');
  configured.execution.args.push('local');
  // Assert
  assert.deepEqual(setup, { kind: 'setup', intervalSeconds: 60, actionOnPress: 'refresh' });
  assert.deepEqual(classifyTimerSettings(input, 'posix'), { kind: 'configured', ...validateTimerSettings(input, 'posix') });
  assert.deepEqual(input, original);
});
for (const [index, [input, code]] of [
  [null, 'SETTINGS_NOT_OBJECT'], [[], 'SETTINGS_NOT_OBJECT'],
  [{ executable: 'relative', argsText: '' }, 'INVALID_EXECUTABLE'],
  [{ executable: ' ', argsText: '' }, 'INVALID_EXECUTABLE'],
  [{ executable: '/synthetic\0', argsText: '' }, 'INVALID_EXECUTABLE'],
  [{ executable: null, argsText: '' }, 'INVALID_EXECUTABLE'],
  [{ executable: '/synthetic/program' }, 'MISSING_ARGS'],
  [{ argsText: "'unterminated" }, 'ARGS_TEXT_INVALID'], [{ args: '[null]' }, 'INVALID_ARGUMENT'],
  [{ cwd: 'relative' }, 'INVALID_CWD'], [{ runRequested: false }, 'UNKNOWN_SETTING'],
  [{ unknown: marker }, 'UNKNOWN_SETTING'],
  ...[undefined, null, 0, 86401, 1.5, '60', false].map(intervalSeconds => [{ intervalSeconds }, 'INTERVAL_INVALID']),
  ...[undefined, null, 'Refresh', 'toggle', 1, false].map(actionOnPress => [{ actionOnPress }, 'ACTION_ON_PRESS_INVALID']),
].entries()) {
  test(`Timer malformed setup ${index} remains a fixed error, not defaulted setup`, () => {
    // Arrange
    const operation = () => classifyTimerSettings(input, 'posix');
    // Act
    const error = capture(operation);
    // Assert
    assertInvalid(error, code);
  });
}
for (const [field, code] of [['executable', 'INVALID_SETTINGS'], ['args', 'INVALID_SETTINGS'],
  ['argsText', 'INVALID_SETTINGS'], ['cwd', 'INVALID_SETTINGS'], ['themeColor', 'INVALID_SETTINGS'],
  ['intervalSeconds', 'INVALID_SETTINGS'], ['actionOnPress', 'ACTION_ON_PRESS_INVALID']]) {
  test(`Timer setup rejects ${field} accessor without invoking it`, () => {
    // Arrange
    let calls = 0;
    const input = { argsText: '' };
    Object.defineProperty(input, field, { enumerable: true, get() { calls++; throw Error(marker); } });
    // Act
    const error = capture(() => classifyTimerSettings(input, 'posix'));
    // Assert
    assertInvalid(error, code); assert.equal(calls, 0);
  });
}

function capture(operation) {
  try { operation(); } catch (error) { return error; }
}
function assertInvalid(error, code) {
  assert.ok(error instanceof Error);
  assert.equal(error.message, 'Invalid settings.');
  assert.equal(error.diagnosticCode, code);
  assert.equal(error.cause, undefined);
  assert.equal(JSON.stringify(error).includes(marker), false);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
// Only host storage and timeout delivery are doubled; configuration/authority are real.
function storage(overrides = {}) {
  const writes = [], timers = new Map();
  const host = { value: undefined, reads: 0, failures: 0 };
  let id = 0;
  const state = createTimerStateCoordinator({
    platform: 'posix',
    async writeSettings(value) { writes.push(structuredClone(value)); host.value = structuredClone(value); },
    async readSettings() { host.reads++; return structuredClone(host.value); },
    onFailure() { host.failures++; },
    setTimer(callback, delay) { const key = ++id; timers.set(key, { callback, delay }); return key; },
    clearTimer(key) { timers.delete(key); },
    ...overrides,
  });
  return { state, writes, host, timers, expire() {
    const pending = [...timers.values()]; timers.clear();
    pending.forEach(timer => timer.callback());
  } };
}

// Whole-second boundaries/defaults are configuration, not evidence of scheduling.
for (const interval of [undefined, 1, 5, 10, 30, 60, 300, 3600, 12345, 86400]) {
  test(`Timer accepts whole-second interval case ${String(interval)} without changing runner settings`, () => {
    // Arrange
    const input = { ...base, cwd: '/synthetic/cwd', themeColor: '#ABCDEF', ...(interval === undefined ? {} : { intervalSeconds: interval }) };
    const original = structuredClone(input);
    // Act
    const result = validateTimerSettings(input, 'posix');
    const effective = readIntervalSeconds(input);
    const runner = validateSettings(result.execution, 'posix');
    // Assert
    assert.equal(effective, interval ?? 60);
    assert.deepEqual(result, { execution: { executable: base.executable, args: [], cwd: input.cwd }, intervalSeconds: interval ?? 60, actionOnPress: 'refresh' });
    assert.deepEqual(runner, result.execution);
    assert.deepEqual(input, original);
  });
}

const invalidIntervals = [undefined, null, false, true, 0, -1, 86401, 1.5, 59.999, NaN, Infinity, -Infinity, '60', '', '60\0', [], {}, new Number(60), 60n];
for (const [index, intervalSeconds] of invalidIntervals.entries()) {
  test(`present invalid interval ${index} is rejected without coercion, clamping, or a guessed inspector default`, () => {
    // Arrange
    const input = { ...base, intervalSeconds };
    // Act
    const readError = capture(() => readIntervalSeconds(input));
    const validationError = capture(() => validateTimerSettings(input, 'posix'));
    const view = getTimerInspectorConfiguration(input, 'posix');
    const editError = capture(() => applyTimerConfigurationEdit(base, { intervalSeconds }, 'posix'));
    // Assert
    for (const error of [readError, validationError, editError]) assertInvalid(error, 'INTERVAL_INVALID');
    assert.equal(view.intervalSeconds, undefined);
    assert.equal(view.diagnosticCode, 'INTERVAL_INVALID');
    assert.equal(sameTimerInterval(input, input), false);
  });
}

for (const [index, input] of [null, [], 42, 'synthetic', undefined].entries()) {
  test(`Timer rejects non-object configuration ${index}`, () => {
    // Arrange
    const operation = () => validateTimerSettings(input, 'posix');
    // Act
    const error = capture(operation);
    const intervalError = capture(() => readIntervalSeconds(input));
    const policyError = capture(() => readActionOnPress(input));
    // Assert
    assertInvalid(error, 'SETTINGS_NOT_OBJECT');
    assertInvalid(intervalError, 'SETTINGS_NOT_OBJECT');
    assertInvalid(policyError, 'SETTINGS_NOT_OBJECT');
  });
}

for (const key of ['runRequested', 'enabled', 'deadline', 'settings', 'unknown', Symbol('unknown')]) {
  test(`Timer validation rejects non-Timer field ${String(key)}`, () => {
    // Arrange
    const input = { ...base, [key]: marker };
    // Act
    const error = capture(() => validateTimerSettings(input, 'posix'));
    // Assert
    assertInvalid(error, 'UNKNOWN_SETTING');
  });
}

for (const [field, value, code] of [
  ['executable', 'relative', 'INVALID_EXECUTABLE'], ['executable', '~/program', 'INVALID_EXECUTABLE'],
  ['executable', '/synthetic\0', 'INVALID_EXECUTABLE'], ['cwd', 'relative', 'INVALID_CWD'],
  ['cwd', '/synthetic\0', 'INVALID_CWD'], ['argsText', "'unterminated", 'ARGS_TEXT_INVALID'],
  ['argsText', 'end\\', 'ARGS_TEXT_INVALID'], ['argsText', 'synthetic\0', 'ARGS_TEXT_INVALID'],
  ['argsText', 42, 'ARGS_TEXT_INVALID'], ['args', '[null]', 'INVALID_ARGUMENT'],
]) {
  test(`Timer retains execution validation for ${field} invalid case ${code}/${String(value).length}`, () => {
    // Arrange
    const input = field === 'args' ? { executable: base.executable, args: value } : { ...base, [field]: value };
    // Act
    const error = capture(() => validateTimerSettings(input, 'posix'));
    // Assert
    assertInvalid(error, code);
  });
}

for (const field of ['executable', 'argsText', 'cwd', 'intervalSeconds']) {
  test(`Timer rejects selected ${field} accessors without invoking user code`, () => {
    // Arrange
    let reads = 0;
    const input = { ...base };
    Object.defineProperty(input, field, { enumerable: true, get() { reads++; throw new Error(marker); } });
    // Act
    const error = capture(() => validateTimerSettings(input, 'posix'));
    // Assert
    assertInvalid(error, field === 'argsText' ? 'ARGS_TEXT_INVALID' : 'INVALID_SETTINGS');
    assert.equal(reads, 0);
  });
}

test('interval object conversion and diagnostic accessors never execute user code', () => {
  // Arrange
  let calls = 0;
  const value = { valueOf() { calls++; throw new Error(marker); }, toString() { calls++; return '60'; } };
  const diagnostic = { get diagnosticCode() { calls++; throw new Error(marker); } };
  // Act
  const error = capture(() => readIntervalSeconds({ intervalSeconds: value }));
  const codes = [timerSettingsDiagnosticCode(error), timerSettingsDiagnosticCode(diagnostic), timerSettingsDiagnosticCode({ diagnosticCode: marker }), timerSettingsDiagnosticCode({ diagnosticCode: 'INVALID_CWD' })];
  // Assert
  assertInvalid(error, 'INTERVAL_INVALID');
  assert.deepEqual(codes, ['INTERVAL_INVALID', 'INVALID_SETTINGS', 'INVALID_SETTINGS', 'INVALID_CWD']);
  assert.equal(calls, 0);
});

for (const args of [['two words', '', 'a\nb', 'c\rd', 'e\r\nf', 'é😀', '$HOME', '*.png'], JSON.stringify(['two words', '', 'a\nb', 'c\rd', 'e\r\nf', 'é😀', '$HOME', '*.png'])]) {
  test(`Timer legacy ${typeof args} argv projection is lossless, read-only, and single-line`, () => {
    // Arrange
    const input = { executable: base.executable, args };
    const original = structuredClone(input);
    const expected = typeof args === 'string' ? JSON.parse(args) : args;
    // Act
    const view = getTimerInspectorConfiguration(input, 'posix');
    const result = validateTimerSettings(input, 'posix');
    // Assert
    assert.equal(view.intervalSeconds, 60);
    assert.equal(view.actionOnPress, 'refresh');
    assert.equal(view.diagnosticCode, undefined);
    assert.equal(/[\r\n]/.test(view.argsText), false);
    assert.deepEqual(parseArguments(view.argsText, 'posix'), expected);
    assert.deepEqual(result.execution.args, expected);
    assert.deepEqual(input, original);
  });
}

test('explicit empty Timer argsText wins without evaluating or deleting legacy argv', () => {
  // Arrange
  let reads = 0;
  const input = { ...base, get args() { reads++; throw new Error(marker); } };
  // Act
  const result = validateTimerSettings(input, 'posix'), view = getTimerInspectorConfiguration(input, 'posix');
  // Assert
  assert.deepEqual(result.execution.args, []);
  assert.equal(view.argsText, '');
  assert.equal(reads, 0);
  assert.equal(typeof Object.getOwnPropertyDescriptor(input, 'args').get, 'function');
});

test('Timer arguments remain literal rather than expanding shell syntax or PATH', () => {
  // Arrange
  const input = { ...base, argsText: "'$HOME' '*.png' '$(synthetic)' ';' '|' '>' ''" };
  // Act
  const result = validateTimerSettings(input, 'posix');
  // Assert
  assert.deepEqual(result.execution.args, ['$HOME', '*.png', '$(synthetic)', ';', '|', '>', '']);
});

for (const args of ['malformed', '[null]', ['synthetic\0']]) {
  test(`invalid Timer legacy ${typeof args} is not repaired by inspector projection`, () => {
    // Arrange
    const input = { executable: base.executable, args, intervalSeconds: 30 };
    const original = structuredClone(input);
    // Act
    const view = getTimerInspectorConfiguration(input, 'posix');
    // Assert
    assert.ok(view.diagnosticCode);
    assert.equal(view.argsText, undefined);
    assert.equal(view.intervalSeconds, 30);
    assert.deepEqual(input, original);
  });
}

test('Timer execution equivalence separates metadata and lossless argv migration from meaningful edits', () => {
  // Arrange
  const input = { executable: base.executable, args: ['two words', ''] };
  const migrated = { ...input, argsText: '"two words" ""', cwd: '', intervalSeconds: 30, themeColor: '#abcdef' };
  // Act
  const same = sameTimerExecutionSettings(input, migrated, 'posix');
  const different = [{ executable: '/synthetic/other' }, { argsText: 'changed' }, { cwd: '/synthetic/cwd' }, { enabled: true }]
    .map(edit => sameTimerExecutionSettings(input, { ...migrated, ...edit }, 'posix'));
  const intervals = [sameTimerInterval({}, { intervalSeconds: 60 }), sameTimerInterval({ intervalSeconds: 1 }, { intervalSeconds: 1 }), sameTimerInterval({}, { intervalSeconds: 30 })];
  // Assert
  assert.equal(same, true);
  assert.deepEqual(different, [false, false, false, false]);
  assert.deepEqual(intervals, [true, true, false]);
});

for (const input of [{}, { executable: 'relative', args: 'malformed' }, stored]) {
  test('Timer interval/theme edits preserve complete JSON and do not invent argv or persistent intent', () => {
    // Arrange
    const original = structuredClone(input);
    // Act
    const result = applyTimerConfigurationEdit(input, { intervalSeconds: 123, themeColor: '#ABCDEF' }, 'posix');
    result.extra?.nested.push('local mutation');
    const fresh = applyTimerConfigurationEdit(input, { intervalSeconds: 123, themeColor: '#ABCDEF' }, 'posix');
    // Assert
    assert.deepEqual(fresh, { ...original, intervalSeconds: 123, themeColor: '#abcdef' });
    assert.deepEqual(input, original);
    assert.equal(Object.hasOwn(fresh, 'enabled'), false);
    assert.equal(Object.hasOwn(fresh, 'runRequested'), false);
  });
}

test('Timer execution edits preserve legacy/unknown fields without Run-style intent rewrites', () => {
  // Arrange
  const input = { ...structuredClone(stored), runRequested: true, enabled: true };
  const original = structuredClone(input);
  // Act
  const result = applyTimerConfigurationEdit(input, { executable: '/synthetic/other', argsText: '', cwd: '/synthetic/cwd' }, 'posix');
  const newKey = applyTimerConfigurationEdit({}, { executable: base.executable }, 'posix');
  // Assert
  assert.deepEqual(result, { ...original, executable: '/synthetic/other', argsText: '', cwd: '/synthetic/cwd' });
  assert.deepEqual(newKey, base);
  assert.deepEqual(input, original);
});

const invalidEdits = [
  {}, { args: [] }, { runRequested: false }, { enabled: false }, { deadline: 1 }, { settings: base },
  { unknown: marker }, { [Symbol('unknown')]: true }, { executable: '' }, { executable: 'relative' }, { argsText: 42 },
  { argsText: 'synthetic\0' }, { cwd: 'synthetic\0' }, { themeColor: 'red' },
  { intervalSeconds: 30, enabled: true },
];
for (const [index, edit] of invalidEdits.entries()) {
  test(`Timer narrow edit rejects unauthorized/invalid edit ${index} atomically`, () => {
    // Arrange
    const input = structuredClone(stored), original = structuredClone(input);
    // Act
    const error = capture(() => applyTimerConfigurationEdit(input, edit, 'posix'));
    // Assert
    assert.equal(error?.message, Object.hasOwn(edit, 'themeColor') ? 'Invalid theme color.' : 'Invalid settings.');
    assert.deepEqual(input, original);
  });
}

for (const unsafe of ['getter', 'cycle', 'proxy']) {
  test(`Timer complete snapshot rejects unsafe ${unsafe} without metadata leakage`, () => {
    // Arrange
    let reads = 0;
    const input = unsafe === 'getter' ? { get extra() { reads++; throw new Error(marker); } }
      : unsafe === 'proxy' ? new Proxy({}, { ownKeys() { throw new Error(marker); } }) : {};
    if (unsafe === 'cycle') input.self = input;
    // Act
    const error = capture(() => applyTimerConfigurationEdit(input, { intervalSeconds: 30 }, 'posix'));
    // Assert
    assertInvalid(error, 'INVALID_SETTINGS');
    assert.equal(reads, 0);
  });
}

test('Timer hydration adopts only once, detaches complete JSON, and never writes the default interval', options, async () => {
  // Arrange
  const h = storage(), input = structuredClone(stored), expected = structuredClone(input);
  // Act
  const first = h.state.observe(input);
  input.extra.nested.push('caller mutation'); first.settings.args.push('result mutation');
  const revision = h.state.getRevision();
  const rejected = [stored, { ...stored, intervalSeconds: 30 }].map(value => h.state.observe(value));
  const view = getTimerInspectorConfiguration(h.state.getSettings(), 'posix');
  await h.state.whenIdle();
  // Assert
  assert.equal(first.accepted, true);
  assert.ok(rejected.every(value => value.accepted === false && value.revision === revision));
  assert.deepEqual(h.state.getSettings(), expected);
  assert.equal(view.intervalSeconds, 60);
  assert.equal(view.actionOnPress, 'refresh');
  assert.deepEqual(h.writes, []);
  assert.equal(h.host.reads, 0);
});

test('Timer complete saves are independent per key and identical confirmed edits do not write again', options, async () => {
  // Arrange
  const first = storage(), second = storage();
  first.state.observe(stored); second.state.observe({ ...stored, intervalSeconds: 300 });
  const expected = { ...structuredClone(stored), intervalSeconds: 30 };
  // Act
  const saved = await first.state.editConfiguration({ intervalSeconds: 30 });
  const repeated = await first.state.editConfiguration({ intervalSeconds: 30 });
  const revision = first.state.getRevision();
  const ignored = first.state.observe({ ...stored, intervalSeconds: 300 });
  const copy = first.state.getSettings(); copy.extra.nested.push('local mutation');
  // Assert
  assert.equal(saved.status, 'saved'); assert.equal(repeated.status, 'saved');
  assert.deepEqual(first.writes, [expected]);
  assert.deepEqual(first.state.getSettings(), expected);
  assert.equal(first.state.getRevision(), revision);
  assert.equal(ignored.accepted, false);
  assert.deepEqual(second.state.getSettings(), { ...stored, intervalSeconds: 300 });
  assert.deepEqual(second.writes, []);
  assert.equal(first.timers.size, 0);
});

test('Timer local edit before host delivery stays authoritative until and after matching readback', options, async () => {
  // Arrange
  const entered = deferred(), gate = deferred();
  const h = storage({ async readSettings() { entered.resolve(); return gate.promise; } });
  let settled = false;
  // Act
  const saving = h.state.editConfiguration({ intervalSeconds: 30 }).then(result => { settled = true; return result; });
  const early = h.state.observe(stored);
  await entered.promise;
  const pending = h.state.observe({ ...stored, intervalSeconds: 30 });
  const beforeReadback = settled;
  gate.resolve({ intervalSeconds: 30 });
  const saved = await saving;
  const late = h.state.observe(stored);
  // Assert
  assert.equal(beforeReadback, false);
  assert.equal(saved.status, 'saved');
  assert.ok([early, pending, late].every(value => value.accepted === false));
  assert.deepEqual(h.state.getSettings(), { intervalSeconds: 30 });
  assert.deepEqual(h.writes, [{ intervalSeconds: 30 }]);
  assert.equal(h.timers.size, 0);
});

for (const oldReadFails of [false, true]) {
  test(`Timer serialized edits require latest readback; superseded read ${oldReadFails ? 'failure' : 'success'} is stale`, options, async () => {
    // Arrange
    const entered = deferred(), gate = deferred();
    const h = storage({ async readSettings() { if (h.writes.length === 1) { entered.resolve(); return gate.promise; } return structuredClone(h.host.value); } });
    h.state.observe(stored);
    // Act
    const old = h.state.editConfiguration({ intervalSeconds: 30 });
    await entered.promise;
    const latest = h.state.editConfiguration({ intervalSeconds: 120, themeColor: '#ABCDEF' });
    const before = h.writes.length;
    const rejected = h.state.observe(h.state.getSettings());
    if (oldReadFails) gate.reject(new Error(marker)); else gate.resolve(h.writes[0]);
    const results = await Promise.all([old, latest]);
    await h.state.whenIdle();
    // Assert
    assert.equal(before, 1);
    assert.equal(rejected.accepted, false);
    assert.deepEqual(results.map(result => result.status), ['stale', 'saved']);
    assert.deepEqual(h.writes, [{ ...stored, intervalSeconds: 30 }, { ...stored, intervalSeconds: 120, themeColor: '#abcdef' }]);
    assert.deepEqual(h.state.getSettings(), h.writes[1]);
    assert.equal(h.state.isBlocked(), false);
    assert.equal(h.host.failures, 0);
    assert.equal(h.timers.size, 0);
  });
}

for (const stage of ['write', 'read', 'mismatch', 'timeout']) {
  test(`Timer current ${stage} failure blocks without rewriting configuration or adding intent`, options, async () => {
    // Arrange
    const entered = deferred(), gate = deferred();
    const h = storage({
      ...(stage === 'write' ? { async writeSettings() { throw new Error(marker); } } : {}),
      ...(stage === 'read' ? { async readSettings() { throw new Error(marker); } } : {}),
      ...(stage === 'mismatch' ? { async readSettings() { return stored; } } : {}),
      ...(stage === 'timeout' ? { async readSettings() { entered.resolve(); return gate.promise; } } : {}),
    });
    h.state.observe(stored);
    const expected = { ...structuredClone(stored), intervalSeconds: 30 };
    // Act
    const saving = h.state.editConfiguration({ intervalSeconds: 30 }).catch(error => error);
    if (stage === 'timeout') { await entered.promise; h.expire(); }
    const failure = await saving;
    const count = h.writes.length, revision = h.state.getRevision();
    const ignored = h.state.observe(expected);
    const again = await h.state.editConfiguration({ intervalSeconds: 60 }).catch(error => error);
    if (stage === 'timeout') gate.resolve(expected);
    await h.state.whenIdle();
    // Assert
    assert.equal(failure.message, 'Run state save failed.');
    assert.equal(failure.diagnosticCode, 'STATE_SAVE_FAILED');
    assert.equal(JSON.stringify(failure).includes(marker), false);
    assert.equal(again.diagnosticCode, 'STATE_SAVE_FAILED');
    assert.equal(h.state.isBlocked(), true);
    assert.equal(ignored.accepted, false);
    assert.deepEqual(h.state.getSettings(), expected);
    assert.equal(h.state.getRevision(), revision);
    assert.equal(h.writes.length, count);
    assert.equal(h.host.failures, 1);
    assert.equal(h.timers.size, 0);
  });
}

test('Timer invalid control edit rejects without writes, blocking, revision change, or loss of complete data', options, async () => {
  // Arrange
  const h = storage(); h.state.observe(stored);
  const revision = h.state.getRevision();
  // Act
  const failure = await h.state.editConfiguration({ intervalSeconds: '60' }).catch(error => error);
  const forbidden = await h.state.editConfiguration({ enabled: true }).catch(error => error);
  // Assert
  assertInvalid(failure, 'INTERVAL_INVALID');
  assertInvalid(forbidden, 'INVALID_SETTINGS');
  assert.deepEqual(h.state.getSettings(), stored);
  assert.equal(h.state.getRevision(), revision);
  assert.deepEqual(h.writes, []);
  assert.equal(h.state.isBlocked(), false);
});

// Slice 1: press policy is read-only metadata until an explicit complete save.
for (const actionOnPress of [undefined, 'refresh', 'stop']) {
  test(`Timer resolves ${actionOnPress ?? 'missing'} policy without persisting defaults or extending runner DTO`, () => {
    // Arrange
    const input = { ...base, ...(actionOnPress === undefined ? {} : { actionOnPress }) };
    const original = structuredClone(input);
    // Act
    const policy = readActionOnPress(input), resolved = validateTimerSettings(input, 'posix');
    const view = getTimerInspectorConfiguration(input, 'posix');
    // Assert
    assert.equal(policy, actionOnPress ?? 'refresh');
    assert.deepEqual(resolved, { execution: { executable: base.executable, args: [] }, intervalSeconds: 60, actionOnPress: policy });
    assert.equal(view.actionOnPress, policy); assert.equal(view.diagnosticCode, undefined);
    assert.deepEqual(input, original);
    assert.deepEqual(validateSettings(resolved.execution, 'posix'), resolved.execution);
  });
}

const cyclicPolicy = {}; cyclicPolicy.self = cyclicPolicy;
const invalidPolicies = [undefined, null, false, true, 0, 1, NaN, Infinity, '', 'Refresh', 'STOP', ' stop', 'refresh ',
  'toggle', 'refresh\0', [], {}, new String('refresh'), Symbol('synthetic'), 1n, cyclicPolicy];
for (const [index, actionOnPress] of invalidPolicies.entries()) {
  test(`present invalid Timer policy ${index} rejects atomically with a fixed diagnostic and no guessed view`, () => {
    // Arrange
    const input = { ...base, actionOnPress };
    // Act
    const failures = [capture(() => readActionOnPress(input)), capture(() => validateTimerSettings(input, 'posix')),
      capture(() => applyTimerConfigurationEdit(stored, { intervalSeconds: 10, actionOnPress }, 'posix'))];
    const view = getTimerInspectorConfiguration(input, 'posix');
    // Assert
    failures.forEach(error => assertInvalid(error, 'ACTION_ON_PRESS_INVALID'));
    assert.equal(view.actionOnPress, undefined); assert.equal(view.diagnosticCode, 'ACTION_ON_PRESS_INVALID');
    assert.equal(timerSettingsDiagnosticCode(failures[0]), 'ACTION_ON_PRESS_INVALID');
    assert.equal(input.actionOnPress, actionOnPress);
  });
}

test('Timer policy accessors and conversion hooks are never invoked', () => {
  // Arrange
  let calls = 0;
  const accessor = { ...base, get actionOnPress() { calls++; throw new Error(marker); } };
  const conversion = { ...base, actionOnPress: { toString() { calls++; throw new Error(marker); }, valueOf() { calls++; return 'refresh'; } } };
  // Act
  const failures = [accessor, conversion].flatMap(input => [capture(() => readActionOnPress(input)),
    capture(() => validateTimerSettings(input, 'posix')), capture(() => applyTimerConfigurationEdit(stored, input, 'posix'))]);
  const views = [accessor, conversion].map(input => getTimerInspectorConfiguration(input, 'posix'));
  // Assert
  failures.forEach(error => assertInvalid(error, 'ACTION_ON_PRESS_INVALID'));
  assert.ok(views.every(view => view.actionOnPress === undefined && view.diagnosticCode === 'ACTION_ON_PRESS_INVALID'));
  assert.equal(calls, 0);
});

for (const target of [{}, { actionOnPress: 'stop' }]) test('Timer public policy reader contains unconditional proxy descriptor errors in a fixed diagnostic', () => {
  // Arrange
  const input = new Proxy(target, { getOwnPropertyDescriptor() { throw new Error(marker); } });
  // Act
  const failure = capture(() => readActionOnPress(input));
  // Assert
  assertInvalid(failure, 'ACTION_ON_PRESS_INVALID');
});

// Reader recovery: revoked roots remain inside the same fixed diagnostic boundary.
for (const shape of ['object', 'array']) {
  test(`Timer policy reader contains revoked ${shape} proxy shape failures`, () => {
    // Arrange
    const { proxy, revoke } = Proxy.revocable(shape === 'array' ? [] : {}, {});
    revoke();
    // Act
    const failure = capture(() => readActionOnPress(proxy));
    // Assert
    assertInvalid(failure, 'ACTION_ON_PRESS_INVALID');
  });
}

test('Timer policy reader rejects hostile array roots without inspecting their fields', () => {
  // Arrange
  let calls = 0;
  const rejectInspection = () => { calls++; throw new Error(marker); };
  const input = new Proxy([], { get: rejectInspection, ownKeys: rejectInspection, getOwnPropertyDescriptor: rejectInspection });
  // Act
  const failure = capture(() => readActionOnPress(input));
  // Assert
  assertInvalid(failure, 'SETTINGS_NOT_OBJECT');
  assert.equal(calls, 0);
});

for (const actionOnPress of ['refresh', 'stop']) {
  test(`Timer ${actionOnPress} policy edits preserve detached legacy and unknown JSON without inventing intent`, () => {
    // Arrange
    const input = { ...structuredClone(stored), runRequested: true, unknown: [false, { value: 'synthetic' }] };
    const original = structuredClone(input);
    // Act
    const edited = applyTimerConfigurationEdit(input, { actionOnPress }, 'posix');
    edited.extra.nested.push('local');
    const fresh = applyTimerConfigurationEdit(input, { actionOnPress }, 'posix');
    const newKey = applyTimerConfigurationEdit({}, { actionOnPress }, 'posix');
    // Assert
    assert.deepEqual(fresh, { ...original, actionOnPress }); assert.deepEqual(input, original);
    assert.deepEqual(newKey, { actionOnPress });
    assert.equal(Object.hasOwn(fresh, 'enabled'), false); assert.equal(Object.hasOwn(fresh, 'deadline'), false);
  });

  test(`Timer ${actionOnPress} metadata does not classify as execution or interval changes while Run stays strict`, () => {
    // Arrange
    const input = { executable: base.executable, args: ['two words', ''] };
    const edited = { ...input, argsText: "'two words' ''", intervalSeconds: 60, themeColor: '#abcdef', actionOnPress };
    // Act
    const equivalent = sameTimerExecutionSettings(input, edited, 'posix'), interval = sameTimerInterval(input, edited);
    const changed = sameTimerExecutionSettings(input, { ...edited, executable: '/synthetic/other' }, 'posix');
    const runFailure = capture(() => validateSettings({ ...base, actionOnPress }, 'posix'));
    // Assert
    assert.equal(equivalent, true); assert.equal(interval, true); assert.equal(changed, false);
    assertInvalid(runFailure, 'UNKNOWN_SETTING');
  });

  test(`confirmed ${actionOnPress} saves remain complete and repeated policy values do not write again`, options, async () => {
    // Arrange
    const h = storage(); h.state.observe(stored);
    // Act
    const saved = await h.state.editConfiguration({ actionOnPress });
    const revision = h.state.getRevision();
    const repeated = await h.state.editConfiguration({ actionOnPress });
    const ignored = h.state.observe({ ...stored, actionOnPress: actionOnPress === 'stop' ? 'refresh' : 'stop' });
    // Assert
    assert.deepEqual([saved.status, repeated.status], ['saved', 'saved']);
    assert.deepEqual(h.writes, [{ ...stored, actionOnPress }]);
    assert.deepEqual(h.state.getSettings(), h.writes[0]); assert.equal(h.state.getRevision(), revision);
    assert.equal(ignored.accepted, false); assert.equal(h.state.isBlocked(), false);
  });
}

test('rejected policy save does not write, poison authority or erase complete settings', options, async () => {
  // Arrange
  const h = storage(); h.state.observe(stored); const revision = h.state.getRevision();
  // Act
  const failure = await h.state.editConfiguration({ actionOnPress: 'toggle' }).catch(error => error);
  // Assert
  assertInvalid(failure, 'ACTION_ON_PRESS_INVALID'); assert.deepEqual(h.writes, []);
  assert.deepEqual(h.state.getSettings(), stored); assert.equal(h.state.getRevision(), revision); assert.equal(h.state.isBlocked(), false);
});

for (const oldReadFails of [false, true]) {
  test(`superseded policy read ${oldReadFails ? 'rejection' : 'match'} cannot confirm or poison the latest complete snapshot`, options, async () => {
    // Arrange
    const entered = deferred(), gate = deferred();
    const h = storage({ async readSettings() { if (h.writes.length === 1) { entered.resolve(); return gate.promise; } return structuredClone(h.host.value); } });
    h.state.observe(stored);
    // Act
    const old = h.state.editConfiguration({ actionOnPress: 'stop' }); await entered.promise;
    const latest = h.state.editConfiguration({ actionOnPress: 'refresh', intervalSeconds: 10, themeColor: '#ABCDEF' });
    const ignored = h.state.observe(h.state.getSettings());
    if (oldReadFails) gate.reject(new Error(marker)); else gate.resolve(h.writes[0]);
    const results = await Promise.all([old, latest]);
    // Assert
    assert.deepEqual(results.map(result => result.status), ['stale', 'saved']); assert.equal(ignored.accepted, false);
    assert.deepEqual(h.writes, [{ ...stored, actionOnPress: 'stop' }, { ...stored, actionOnPress: 'refresh', intervalSeconds: 10, themeColor: '#abcdef' }]);
    assert.deepEqual(h.state.getSettings(), h.writes[1]); assert.equal(h.state.isBlocked(), false); assert.equal(h.host.failures, 0);
  });
}
