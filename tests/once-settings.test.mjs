import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateOnceSettings, classifyOnceSettings, sameOnceExecutionSettings,
  applyOnceConfigurationEdit, createOnceStateCoordinator,
} from '../src/core/once-settings.mjs';

const options = { timeout: 3000 };
const base = { executable: '/synthetic/program', argsText: '' };
const marker = 'synthetic-private-marker';

for (const title of ['a/b\\c.txt', '', null, 42, 'bad\0title', 'x'.repeat(8193)]) {
  test('TITLE-1 Run title never grants attempt intent or changes execution', () => {
    // Arrange
    const input = { ...base, title }, original = structuredClone(input);
    // Act
    const result = classifyOnceSettings(input);
    const same = sameOnceExecutionSettings(input, { ...input, title: 'other' });
    // Assert
    assert.deepEqual(result, { kind: 'configured', execution: { executable: base.executable, args: [] } });
    assert.equal(same, true); assert.deepEqual(input, original);
    assert.equal(sameOnceExecutionSettings(input, { ...input, argsText: 'changed' }), false);
  });
}
function capture(operation) { try { operation(); } catch (error) { return error; } }
function invalid(error, code) {
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
// Objective: configuration authority is real; only host I/O and bounded timeouts are doubled.
function storage(overrides = {}) {
  const writes = [], timers = new Map();
  let host, id = 0, failures = 0;
  const state = createOnceStateCoordinator({
    async writeSettings(value) { writes.push(structuredClone(value)); host = structuredClone(value); },
    async readSettings() { return structuredClone(host); },
    onFailure() { failures++; },
    setTimer(callback) { const key = ++id; timers.set(key, callback); return key; },
    clearTimer(key) { timers.delete(key); },
    ...overrides,
  });
  return { state, writes, timers, failures: () => failures,
    expire() { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()); } };
}

for (const input of [{}, { executable: '' }, { argsText: '', args: 'ignored invalid legacy' },
  { args: '["literal", ""]', cwd: '/synthetic/work' }, { themeColor: 'invalid stored theme' }]) {
  test('Once partial setup is read-only and grants no execution DTO', () => {
    // Arrange
    const original = structuredClone(input);
    // Act
    const result = classifyOnceSettings(input);
    // Assert
    assert.deepEqual(result, { kind: 'setup' });
    assert.deepEqual(input, original);
    assert.throws(() => validateOnceSettings(input), { message: 'Invalid settings.' });
  });
}
for (const args of [['two words', '', '$HOME', '*.png', 'é😀', 'a\nb'], '["two words", "", "$HOME", "*.png"]']) {
  test(`Once legacy ${typeof args} argv is ordered, literal, detached and read-only`, () => {
    // Arrange
    const input = { executable: base.executable, args, cwd: '/synthetic/work', themeColor: '#ABCDEF' };
    const original = structuredClone(input), expected = typeof args === 'string' ? JSON.parse(args) : args;
    // Act
    const result = validateOnceSettings(input), classified = classifyOnceSettings(input);
    // Assert
    assert.deepEqual(result, { execution: { executable: base.executable, args: expected, cwd: input.cwd } });
    assert.deepEqual(classified, { kind: 'configured', ...result });
    result.execution.args.push('local');
    assert.deepEqual(input, original);
  });
}
for (const argsText of ['', '"two words" \'\' $HOME *.png']) {
  test('Once argsText presence wins over invalid legacy argv', () => {
    // Arrange
    const input = { ...base, argsText, args: '[null]', cwd: '' };
    // Act
    const result = validateOnceSettings(input);
    // Assert
    assert.deepEqual(result.execution, { executable: base.executable,
      args: argsText === '' ? [] : ['two words', '', '$HOME', '*.png'] });
  });
}
for (const [index, [input, code]] of [
  [null, 'SETTINGS_NOT_OBJECT'], [[], 'SETTINGS_NOT_OBJECT'], [42, 'SETTINGS_NOT_OBJECT'],
  [{ executable: 'relative', argsText: '' }, 'INVALID_EXECUTABLE'],
  [{ executable: null, argsText: '' }, 'INVALID_EXECUTABLE'],
  [{ executable: '/synthetic\0', argsText: '' }, 'INVALID_EXECUTABLE'],
  [{ executable: base.executable }, 'MISSING_ARGS'],
  [{ argsText: "'unterminated" }, 'ARGS_TEXT_INVALID'], [{ argsText: 'end\\' }, 'ARGS_TEXT_INVALID'],
  [{ argsText: 42 }, 'ARGS_TEXT_INVALID'], [{ argsText: 'a\0' }, 'ARGS_TEXT_INVALID'],
  [{ args: '[null]' }, 'INVALID_ARGUMENT'], [{ args: '[1.5]' }, 'INVALID_ARGUMENT'],
  [{ args: 'not JSON' }, 'ARGS_JSON_INVALID'], [{ args: '{}' }, 'ARGS_NOT_ARRAY'],
  [{ args: ['a\0'] }, 'INVALID_ARGUMENT'], [{ cwd: 'relative' }, 'INVALID_CWD'],
  [{ cwd: '/synthetic\0' }, 'INVALID_CWD'],
  ...['runRequested', 'intervalSeconds', 'actionOnPress', 'enabled', 'deadline', 'unknown'].map(key => [{ [key]: marker }, 'UNKNOWN_SETTING']),
].entries()) {
  test(`Once malformed configuration ${index} has only a fixed diagnostic`, () => {
    // Arrange
    const operation = () => classifyOnceSettings(input);
    // Act
    const error = capture(operation);
    // Assert
    invalid(error, code);
  });
}
for (const field of ['executable', 'argsText', 'args', 'cwd', 'themeColor']) {
  test(`Once classification rejects ${field} accessor without executing it`, () => {
    // Arrange
    let calls = 0;
    const input = { ...base };
    Object.defineProperty(input, field, { enumerable: true, get() { calls++; throw Error(marker); } });
    // Act
    const error = capture(() => classifyOnceSettings(input));
    // Assert
    invalid(error, 'INVALID_SETTINGS'); assert.equal(calls, 0);
  });
}
test('Once unsupported prototype and throwing proxy cannot escape fixed errors', () => {
  // Arrange
  const inputs = [Object.assign(Object.create({ inherited: true }), base),
    new Proxy({}, { ownKeys() { throw Error(marker); } })];
  // Act
  const results = inputs.map(input => capture(() => classifyOnceSettings(input)));
  // Assert
  results.forEach(error => invalid(error, 'INVALID_SETTINGS'));
});
for (const [second, expected] of [
  [{ ...base, themeColor: '#abcdef' }, true],
  [{ executable: base.executable, args: [] }, true],
  [{ ...base, cwd: '' }, true], [{ ...base, argsText: 'changed' }, false],
  [{ ...base, executable: '/synthetic/other' }, false], [{ ...base, cwd: '/synthetic/work' }, false],
  [{ ...base, runRequested: false }, false],
]) {
  test(`Once execution comparison distinguishes migration/cosmetics from changes (${expected})`, () => {
    // Arrange
    const first = structuredClone(base);
    // Act
    const equal = sameOnceExecutionSettings(first, second);
    // Assert
    assert.equal(equal, expected);
  });
}
test('Once edits preserve complete unknown JSON and legacy argv without adding attempt intent', () => {
  // Arrange
  const input = { executable: base.executable, args: ['legacy'], extra: { nested: [null, true, 42] } };
  const original = structuredClone(input);
  // Act
  const result = applyOnceConfigurationEdit(input, { argsText: 'new', cwd: '', themeColor: '#ABCDEF' });
  result.extra.nested.push('local');
  // Assert
  assert.deepEqual(result, { ...original, argsText: 'new', cwd: '', themeColor: '#abcdef', extra: { nested: [null, true, 42, 'local'] } });
  assert.deepEqual(input, original); assert.equal(Object.hasOwn(result, 'runRequested'), false);
  assert.deepEqual(applyOnceConfigurationEdit({}, { executable: base.executable }), base);
});
for (const [changes, code] of [[{}, 'INVALID_SETTINGS'], [{ executable: '' }, 'INVALID_EXECUTABLE'],
  [{ executable: 'relative' }, 'INVALID_EXECUTABLE'], [{ cwd: null }, 'INVALID_CWD'],
  [{ argsText: 'a\0' }, 'ARGS_TEXT_INVALID'], [{ args: [] }, 'INVALID_SETTINGS'],
  ...['runRequested', 'intervalSeconds', 'actionOnPress', 'unknown'].map(key => [{ [key]: marker }, 'INVALID_SETTINGS'])]) {
  test('Once PI edit rejects unsupported controls and empty executable', () => {
    // Arrange
    const input = structuredClone(base);
    // Act
    const error = capture(() => applyOnceConfigurationEdit(input, changes));
    // Assert
    invalid(error, code); assert.deepEqual(input, base);
  });
}
test('Once authority adopts host once, rejects later snapshots and never writes during hydration', options, async () => {
  // Arrange
  const h = storage();
  // Act
  const first = h.state.observe(base), later = h.state.observe({ ...base, argsText: 'stale' });
  await h.state.whenIdle(); first.settings.argsText = 'local';
  // Assert
  assert.equal(first.accepted, true); assert.equal(later.accepted, false);
  assert.deepEqual(h.state.getSettings(), base); assert.deepEqual(h.writes, []);
});
test('Once pre-host edit remains authoritative and confirmation tolerates JSON property order', options, async () => {
  // Arrange
  const h = storage({ async readSettings() { return { argsText: '', executable: base.executable }; } });
  // Act
  const result = await h.state.editConfiguration({ executable: base.executable });
  const stale = h.state.observe({ executable: '/synthetic/stale', argsText: '' });
  // Assert
  assert.equal(result.status, 'saved'); assert.equal(stale.accepted, false);
  assert.deepEqual(h.state.getSettings(), base); assert.deepEqual(h.writes, [base]);
  assert.equal(h.state.isBlocked(), false); assert.equal(h.timers.size, 0);
});
test('Once superseded edits save only the latest complete snapshot', options, async () => {
  // Arrange
  const h = storage(); h.state.observe(base);
  // Act
  const first = h.state.editConfiguration({ argsText: 'old' });
  const second = h.state.editConfiguration({ argsText: 'new' });
  const results = await Promise.all([first, second]);
  // Assert
  assert.deepEqual(results.map(result => result.status), ['stale', 'saved']);
  assert.deepEqual(h.writes, [{ ...base, argsText: 'new' }]); assert.equal(h.state.isBlocked(), false);
});
for (const failure of ['write', 'read', 'mismatch', 'timeout']) {
  test(`Once ${failure} failure blocks future configuration writes permanently`, options, async () => {
    // Arrange
    const entered = deferred(), pending = deferred();
    const overrides = failure === 'write' ? { async writeSettings() { throw Error(marker); } }
      : failure === 'read' ? { async readSettings() { throw Error(marker); } }
        : failure === 'mismatch' ? { async readSettings() { return base; } }
          : { async readSettings() { entered.resolve(); return pending.promise; } };
    const h = storage(overrides); h.state.observe(base);
    // Act
    const saving = h.state.editConfiguration({ argsText: 'changed' }).catch(error => error);
    if (failure === 'timeout') { await entered.promise; h.expire(); }
    const error = await saving;
    const again = await h.state.editConfiguration({ argsText: 'replacement' }).catch(value => value);
    // Assert
    assert.equal(error.message, 'Run state save failed.'); assert.equal(error.diagnosticCode, 'STATE_SAVE_FAILED');
    assert.equal(again.diagnosticCode, 'STATE_SAVE_FAILED'); assert.equal(h.state.isBlocked(), true);
    assert.equal(h.failures(), 1); assert.ok(h.writes.length <= 1);
    assert.equal(JSON.stringify(error).includes(marker), false);
  });
}
