import test from 'node:test';
import assert from 'node:assert/strict';
import { copyRunSettings, applyConfigurationEdit, createRunStateCoordinator } from '../src/core/run-state.mjs';
import { validateSettings } from '../src/core/settings.mjs';
import { equalJson } from '../src/core/settings-authority.mjs';
import { createActionSession } from '../src/core/action-session.mjs';
import { startProcessRun } from '../src/core/process-runner.mjs';
import { createLaunchArtwork } from '../src/core/launch-artwork.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createTimerStateCoordinator } from '../src/core/timer-settings.mjs';
import { createOnceStateCoordinator } from '../src/core/once-settings.mjs';

const options = { timeout: 1_000 };
const initial = { executable: '/program', args: ['two words', ''], runRequested: true };

// TITLE-1: all actions save literal metadata in complete snapshots, never derived captions.
for (const [name, create] of [['Stream', createRunStateCoordinator], ['Loop', createTimerStateCoordinator], ['Run', createOnceStateCoordinator]]) {
  test(`${name} title saves preserve unknown JSON, clear removes the field and hydration never repairs`, options, async () => {
    // Arrange
    const writes = []; let host;
    const state = create({ async writeSettings(value) { host = structuredClone(value); writes.push(host); },
      async readSettings() { return structuredClone(host); } });
    const input = { executable: '/synthetic/report.PY', args: ['legacy'], title: null, extra: { keep: [true, 42] } };
    const literal = ' cafe\u0301/a\\b.txt ';
    state.observe(input); await state.whenIdle(); const hydration = [...writes];
    // Act
    await state.editConfiguration({ title: literal });
    await state.editConfiguration({ title: ' \t\u202e ' });
    const beforeInvalid = structuredClone(state.getSettings());
    const failures = [];
    for (const title of [null, false, 42, {}, [], 'bad\0title', 'x'.repeat(8193)]) {
      try { await state.editConfiguration({ themeColor: '#abcdef', title }); } catch (error) { failures.push(error); }
    }
    // Assert
    assert.deepEqual(hydration, []);
    assert.deepEqual(writes, [{ ...input, title: literal }, { executable: input.executable, args: ['legacy'], extra: input.extra }]);
    assert.equal(Object.hasOwn(state.getSettings(), 'title'), false);
    assert.deepEqual(state.getSettings(), beforeInvalid);
    assert.equal(failures.length, 7);
    failures.forEach(error => { assert.equal(error.message, 'Invalid settings.'); assert.equal(error.diagnosticCode, 'TITLE_INVALID'); });
    assert.deepEqual(input.title, null); assert.equal(state.isBlocked(), false);
  });
}

// S2: all actions keep complete-snapshot authority under explicit Windows validation.
for (const [name, create] of [['Stream', createRunStateCoordinator], ['Loop', createTimerStateCoordinator], ['Run', createOnceStateCoordinator]]) {
  test(`${name} Windows authority hydrates read-only, rejects wrong-platform edits and confirms only matching complete saves`, options, async () => {
    // Arrange
    const writes = [], readEntered = deferred(), readback = deferred(), timers = new Map();
    let timerId = 0;
    const input = { executable: String.raw`C:\old.EXE`, args: [String.raw`C:\literal\arg`, ''], extra: { nested: ['keep'] },
      ...(name === 'Stream' ? { runRequested: true } : name === 'Loop' ? { intervalSeconds: 5 } : {}) };
    const original = structuredClone(input);
    const state = create({ platform: 'win32',
      setTimer(callback) { const id = ++timerId; timers.set(id, callback); return id; }, clearTimer(id) { timers.delete(id); },
      async writeSettings(next) { writes.push(structuredClone(next)); },
      async readSettings() { readEntered.resolve(); return readback.promise; } });
    state.observe(input); await state.whenIdle(); const hydration = [...writes];
    // Act
    let invalid; try { await state.editConfiguration({ executable: '/wrong-platform' }); } catch (error) { invalid = error; }
    const save = state.editConfiguration({ executable: 'D:/new.EXE' }); await readEntered.promise;
    const stale = state.observe({ ...original, executable: 'C:/foreign.EXE' });
    const pending = state.getSettings(); readback.resolve(writes[0]); const result = await save; await state.whenIdle();
    // Assert
    assert.deepEqual(hydration, []); assert.equal(invalid?.diagnosticCode, 'INVALID_EXECUTABLE');
    assert.equal(stale.accepted, false); assert.deepEqual(pending, { ...original, executable: 'D:/new.EXE' });
    assert.deepEqual(writes, [{ ...original, executable: 'D:/new.EXE' }]); assert.equal(result.status, 'saved');
    assert.deepEqual(state.getSettings(), writes[0]); assert.deepEqual(input, original);
    assert.equal(state.isBlocked(), false); assert.equal(Object.hasOwn(writes[0], 'platform'), false); assert.equal(timers.size, 0);
  });
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(overrides = {}) {
  const writes = [], failures = [], timers = new Map();
  let host, id = 0;
  const state = createRunStateCoordinator({
    async writeSettings(settings) { writes.push(settings); host = structuredClone(settings); },
    async readSettings() { return host; },
    onFailure: () => failures.push('STATE_SAVE_FAILED'),
    setTimer(callback, delay) { const key = ++id; timers.set(key, { callback, delay }); return key; },
    clearTimer(key) { timers.delete(key); },
    ...overrides,
  });
  return { state, writes, failures, timers, expire() { const current = [...timers.values()]; timers.clear(); current.forEach(timer => timer.callback()); } };
}

test('complete settings copy is detached and preserves legacy/unknown JSON data', () => {
  // Arrange
  const input = { ...initial, extra: { nested: ['preserved'] } };
  const original = structuredClone(input);
  // Act
  const copy = copyRunSettings(input);
  copy.args.push('local');
  copy.extra.nested.push('local');
  // Assert
  assert.deepEqual(input, original);
  assert.deepEqual(copyRunSettings(input), original);
});

for (const [index, input] of [null, [], 'private', { value: undefined }, { value: NaN }, { args: Array(1) }].entries()) {
  test(`non-JSON complete settings ${index} fail safely`, () => {
    // Arrange
    let failure;
    // Act
    try { copyRunSettings(input); } catch (error) { failure = error; }
    // Assert
    assert.equal(failure?.message, 'Invalid settings.');
    assert.equal(failure?.diagnosticCode, 'INVALID_SETTINGS');
  });
}

test('cyclic data and accessors are rejected without running getter code', () => {
  // Arrange
  const cyclic = {}; cyclic.self = cyclic;
  let reads = 0;
  const accessor = { get executable() { reads++; return '/private'; } };
  // Act
  const results = [cyclic, accessor].map(input => { try { copyRunSettings(input); } catch (error) { return error.diagnosticCode; } });
  // Assert
  assert.deepEqual(results, ['INVALID_SETTINGS', 'INVALID_SETTINGS']);
  assert.equal(reads, 0);
});

test('fresh coordinators preserve legacy intent as unchanged data without synthesizing missing flags', () => {
  // Arrange
  const first = harness(), fresh = harness();
  // Act
  first.state.observe(initial);
  fresh.state.observe(structuredClone(first.state.getSettings()));
  const restored = fresh.state.getSettings();
  const missing = applyConfigurationEdit({ executable: '/new', args: [] }, { cwd: '/work' });
  // Assert
  assert.deepEqual(restored, initial);
  assert.equal(Object.hasOwn(missing, 'runRequested'), false);
  assert.deepEqual(first.writes, []);
  assert.deepEqual(fresh.writes, []);
});

test('only first observation initializes authority; identical/unseen/restored host snapshots do not change revision or confirmation', options, async () => {
  // Arrange
  const h = harness();
  const input = structuredClone(initial);
  // Act
  const first = h.state.observe(input);
  input.args.push('caller-mutation');
  const revision = h.state.getRevision();
  const ignored = [initial, { ...initial, executable: '/unseen' }, { ...initial, runRequested: false }].map(snapshot => h.state.observe(snapshot));
  const same = await h.state.editConfiguration({ executable: initial.executable });
  // Assert
  assert.equal(first.accepted, true);
  assert.ok(ignored.every(result => result.accepted === false && result.revision === revision));
  assert.deepEqual(h.state.getSettings(), initial);
  assert.equal(h.state.getRevision(), revision);
  assert.equal(same.status, 'saved');
  assert.deepEqual(h.writes, []);
});

for (const value of [undefined, null, 1, 'true']) {
  test(`invalid persisted intent ${String(value)} is not coerced`, () => {
    // Arrange
    const input = { ...initial, runRequested: value };
    // Act
    let failure;
    try { validateSettings(input); } catch (error) { failure = error; }
    // Assert
    assert.equal(failure?.diagnosticCode, 'INVALID_RUN_STATE');
  });
}

test('equivalent and changed execution edits preserve legacy data without synthesizing intent', () => {
  // Arrange
  const input = structuredClone(initial);
  // Act
  const migrated = applyConfigurationEdit(input, { argsText: '"two words" ""' });
  const changed = applyConfigurationEdit(input, { argsText: '' });
  const newKey = applyConfigurationEdit({}, { executable: '/new-program' });
  // Assert
  assert.deepEqual(migrated, { ...initial, argsText: '"two words" ""' });
  assert.deepEqual(changed, { ...initial, argsText: '' });
  assert.deepEqual(newKey, { executable: '/new-program', argsText: '' });
  assert.deepEqual(input, initial);
});

for (const changes of [{}, { runRequested: true }, { args: [] }, { executable: '' }, { executable: 'relative' }, { argsText: 42 }, { cwd: 'private\0' }]) {
  test(`narrow configuration edit rejects unauthorized/invalid fields ${JSON.stringify(changes)}`, () => {
    // Arrange
    const input = structuredClone(initial);
    // Act
    let failure;
    try { applyConfigurationEdit(input, changes); } catch (error) { failure = error; }
    // Assert
    assert.equal(failure?.message, 'Invalid settings.');
    assert.deepEqual(input, initial);
  });
}

// Slice 2 objective: setup hydration and cosmetics do not manufacture execution or intent.
for (const input of [{}, { executable: '', argsText: '' }, { args: ['literal'], cwd: '/synthetic/work' }]) {
  test('partial Run setup hydrates without writes and saves only explicit cosmetics before strict configuration', options, async () => {
    // Arrange
    const h = harness(), original = structuredClone(input);
    // Act
    h.state.observe(input); await h.state.whenIdle(); const hydrationWrites = h.writes.length;
    await h.state.editConfiguration({ themeColor: '#ABCDEF' });
    const themed = h.state.getSettings(), writes = structuredClone(h.writes);
    await h.state.editConfiguration({ executable: '/synthetic/program', argsText: '' });
    // Assert
    assert.equal(hydrationWrites, 0);
    assert.deepEqual(themed, { ...input, themeColor: '#abcdef' });
    assert.deepEqual(writes, [{ ...input, themeColor: '#abcdef' }]);
    assert.deepEqual(h.state.getSettings(), { ...input, themeColor: '#abcdef', executable: '/synthetic/program', argsText: '' });
    assert.deepEqual(input, original); assert.equal(h.state.isBlocked(), false);
  });
}
test('empty executable PI edit is rejected atomically in setup without save or authority mutation', options, async () => {
  // Arrange
  const h = harness(); h.state.observe({}); const revision = h.state.getRevision();
  // Act
  const failure = await h.state.editConfiguration({ executable: '' }).catch(error => error);
  // Assert
  assert.equal(failure?.message, 'Invalid settings.'); assert.equal(failure?.diagnosticCode, 'INVALID_EXECUTABLE');
  assert.deepEqual(h.writes, []); assert.deepEqual(h.state.getSettings(), {});
  assert.equal(h.state.getRevision(), revision); assert.equal(h.state.isBlocked(), false);
});

test('configuration save writes complete detached settings and confirms matching host readback', options, async () => {
  // Arrange
  const h = harness();
  h.state.observe(initial);
  // Act
  const result = await h.state.editConfiguration({ argsText: 'changed' });
  const copy = h.state.getSettings(); copy.args.push('local');
  // Assert
  assert.equal(result.status, 'saved');
  assert.deepEqual(h.writes, [{ ...initial, argsText: 'changed' }]);
  assert.deepEqual(h.state.getSettings(), { ...initial, argsText: 'changed' });
  assert.equal(h.timers.size, 0);
  assert.equal(h.state.isBlocked(), false);
});

test('save does not report saved until matching readback arrives', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred();
  const h = harness({ async readSettings() { entered.resolve(); return gate.promise; } });
  h.state.observe(initial);
  let settled = false;
  // Act
  const saving = h.state.editConfiguration({ argsText: 'changed' }).then(result => { settled = true; return result; });
  await entered.promise;
  const beforeReadback = settled;
  gate.resolve({ ...initial, argsText: 'changed' });
  const result = await saving;
  // Assert
  assert.equal(beforeReadback, false);
  assert.equal(result.status, 'saved');
});

test('rapid edits serialize writes and obsolete confirmation cannot roll back newer intent', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred();
  const h = harness({ async readSettings() { if (h.writes.length === 1) { entered.resolve(); return gate.promise; } return h.writes.at(-1); } });
  h.state.observe(initial);
  // Act
  const old = h.state.editConfiguration({ argsText: '"two words" ""' });
  await entered.promise;
  const newer = h.state.editConfiguration({ argsText: 'new argument' });
  const before = h.writes.length;
  const echo = h.state.observe(initial);
  gate.resolve(h.writes[0]);
  const [oldResult, newResult] = await Promise.all([old, newer]);
  // Assert
  assert.equal(before, 1);
  assert.equal(echo.accepted, false);
  assert.equal(oldResult.status, 'stale');
  assert.equal(newResult.status, 'saved');
  assert.equal(h.writes.length, 2);
  assert.deepEqual(h.state.getSettings(), { ...initial, argsText: 'new argument' });
});

test('superseded read failure is stale rather than blocking newer confirmed edit', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred();
  const h = harness({ async readSettings() { if (h.writes.length === 1) { entered.resolve(); return gate.promise; } return h.writes.at(-1); } });
  h.state.observe(initial);
  // Act
  const old = h.state.editConfiguration({ argsText: '"two words" ""' });
  await entered.promise;
  const newer = h.state.editConfiguration({ argsText: 'new' });
  gate.reject(new Error('private old read failure'));
  const results = await Promise.all([old, newer]);
  // Assert
  assert.deepEqual(results.map(result => result.status), ['stale', 'saved']);
  assert.deepEqual(h.failures, []);
  assert.equal(h.state.isBlocked(), false);
});

for (const stage of ['write', 'read', 'mismatch']) {
  test(`current ${stage} failure blocks further writes with fixed safe failure`, options, async () => {
    // Arrange
    const h = harness({
      ...(stage === 'write' ? { async writeSettings() { throw new Error('private write failure'); } } : {}),
      ...(stage === 'read' ? { async readSettings() { throw new Error('private read failure'); } } : {}),
      ...(stage === 'mismatch' ? { async readSettings() { return initial; } } : {}),
    });
    h.state.observe(initial);
    // Act
    let failure;
    try { await h.state.editConfiguration({ argsText: 'changed' }); } catch (error) { failure = error; }
    const writesBefore = h.writes.length;
    let nextFailure;
    try { await h.state.editConfiguration({ argsText: 'newer' }); } catch (error) { nextFailure = error; }
    // Assert
    assert.equal(failure?.message, 'Run state save failed.');
    assert.equal(failure?.diagnosticCode, 'STATE_SAVE_FAILED');
    assert.equal(nextFailure?.diagnosticCode, 'STATE_SAVE_FAILED');
    assert.equal(h.state.isBlocked(), true);
    assert.equal(h.state.getSettings().runRequested, true);
    assert.equal(h.state.getSettings().argsText, 'changed');
    assert.equal(h.writes.length, writesBefore);
    assert.deepEqual(h.failures, ['STATE_SAVE_FAILED']);
  });
}

test('bounded save timeout blocks intent and late readback cannot unblock it', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred();
  const h = harness({ async readSettings() { entered.resolve(); return gate.promise; } });
  h.state.observe(initial);
  // Act
  const saving = h.state.editConfiguration({ argsText: 'changed' }).catch(error => error);
  await entered.promise;
  const delays = [...h.timers.values()].map(timer => timer.delay);
  h.expire();
  const failure = await saving;
  gate.resolve({ ...initial, argsText: 'changed' });
  await h.state.whenIdle();
  const late = h.state.observe(initial);
  // Assert
  assert.deepEqual(delays, [5_000]);
  assert.equal(failure.diagnosticCode, 'STATE_SAVE_FAILED');
  assert.equal(late.accepted, false);
  assert.equal(h.state.isBlocked(), true);
  assert.deepEqual(h.failures, ['STATE_SAVE_FAILED']);
});

test('obsolete write failure remains uncertain and blocks newer writes', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred();
  const h = harness({ async writeSettings() { entered.resolve(); return gate.promise; } });
  h.state.observe(initial);
  // Act
  const first = h.state.editConfiguration({ argsText: 'first' }).catch(error => error);
  await entered.promise;
  const second = h.state.editConfiguration({ argsText: 'second' }).catch(error => error);
  gate.reject(new Error('private uncertain write'));
  const results = await Promise.all([first, second]);
  // Assert
  assert.deepEqual(results.map(error => error.diagnosticCode), ['STATE_SAVE_FAILED', 'STATE_SAVE_FAILED']);
  assert.equal(h.state.isBlocked(), true);
  assert.deepEqual(h.failures, ['STATE_SAVE_FAILED']);
});

// Legacy intent and unknown JSON survive both successful and failed configuration saves.
for (const legacy of [true, false, 'missing']) {
  for (const failureStage of [undefined, 'write', 'read', 'mismatch']) {
    test(`configuration save preserves legacy ${legacy} and unknown JSON through ${failureStage ?? 'success'}`, options, async () => {
      // Arrange
      const input = { executable: '/program', args: ['legacy'], extra: { nested: [null, true, 42] } };
      if (legacy !== 'missing') input.runRequested = legacy;
      const original = structuredClone(input);
      const h = harness({
        ...(failureStage === 'write' ? { async writeSettings() { throw Error('synthetic storage boundary'); } } : {}),
        ...(failureStage === 'read' ? { async readSettings() { throw Error('synthetic storage boundary'); } } : {}),
        ...(failureStage === 'mismatch' ? { async readSettings() { return input; } } : {}),
      });
      h.state.observe(input);

      // Act
      const result = await h.state.editConfiguration({ argsText: 'changed' }).catch(error => error);
      const stored = h.state.getSettings();
      const ignored = h.state.observe(original);

      // Assert
      assert.deepEqual(stored, { ...original, argsText: 'changed' });
      assert.deepEqual(input, original);
      assert.equal(Object.hasOwn(stored, 'runRequested'), legacy !== 'missing');
      assert.equal(ignored.accepted, false);
      assert.equal(h.state.isBlocked(), failureStage !== undefined);
      if (failureStage) assert.equal(result.diagnosticCode, 'STATE_SAVE_FAILED');
      else { assert.equal(result.status, 'saved'); assert.deepEqual(h.writes, [stored]); }
    });
  }
}

test('copied settings have no subsequent cross-action writes', options, async () => {
  // Arrange
  const first = harness(), second = harness();
  first.state.observe(initial);
  second.state.observe(first.state.getSettings());
  // Act
  await first.state.editConfiguration({ argsText: 'first' });
  await second.state.editConfiguration({ cwd: '/second' });
  // Assert
  assert.deepEqual(first.writes, [{ ...initial, argsText: 'first' }]);
  assert.deepEqual(second.writes, [{ ...initial, cwd: '/second' }]);
  assert.equal(Object.hasOwn(first.state.getSettings(), 'cwd'), false);
});

test('equivalent argv edit superseding configuration save confirms only the latest complete snapshot', options, async () => {
  // Arrange
  const entered = deferred(), gate = deferred();
  const h = harness({ async readSettings() { if (h.writes.length === 1) { entered.resolve(); return gate.promise; } return h.writes.at(-1); } });
  h.state.observe({ ...initial, runRequested: false });
  // Act
  const starting = h.state.editConfiguration({ themeColor: '#123456' });
  await entered.promise;
  const migration = h.state.editConfiguration({ argsText: '"two words" ""' });
  gate.resolve(h.writes[0]);
  const results = await Promise.all([starting, migration]);
  // Assert
  assert.deepEqual(results.map(result => result.status), ['stale', 'saved']);
  assert.deepEqual(h.writes, [{ ...initial, runRequested: false, themeColor: '#123456' },
    { ...initial, runRequested: false, themeColor: '#123456', argsText: '"two words" ""' }]);
  assert.equal(h.state.getSettings().runRequested, false);
  assert.equal(h.state.isBlocked(), false);
});

// Integration of our two business modules; only process and host storage are mocked.
function integrated(input, readback, onPresentation = () => {}) {
  const host = { value: structuredClone(input), writes: [] };
  let session;
  const h = harness({
    async writeSettings(value) {
      host.value = structuredClone(value); host.writes.push(structuredClone(value));
    },
    async readSettings() { const snapshot = structuredClone(host.value); return readback ? readback(snapshot) : snapshot; },
    onFailure() { void session?.persistenceFailed(); },
  });
  h.state.observe(input);
  const runs = [], errors = [];
  session = createActionSession({
    initialConnected: true,
    onPresentation,
    async confirmLaunchSettings(expected) {
      await h.state.whenIdle();
      if (h.state.isBlocked()) return false;
      const snapshot = h.state.getSettings();
      const reported = readback ? await readback(snapshot) : snapshot;
      return equalJson(expected, reported) && equalJson(expected, h.state.getSettings());
    },
    startRun(input, callbacks) {
      const done = deferred(), stopEntered = deferred();
      const run = { input, callbacks, ...done, stopEntered, stops: 0 };
      runs.push(run);
      return { done: done.promise, async stop() { run.stops++; stopEntered.resolve(); return run.cleanup ? run.cleanup.promise : true; } };
    },
    async setImage() {}, async setTitle() {}, onError: (message, code) => errors.push([message, code]),
  });
  return { ...h, host, runs, errors, session };
}

for (const loss of ['hide', 'disconnect']) {
  test(`manual Stopped is local before cleanup despite ${loss}; fresh session stays stopped without writes`, options, async () => {
    // Arrange
    const h = integrated(initial);
    await h.session.appear(initial);
    await h.session.press();
    const cleanup = deferred(); h.runs[0].cleanup = cleanup;
    // Act
    const stop = h.session.press();
    const unavailable = loss === 'hide' ? h.session.disappear() : h.session.setConnected(false);
    await h.runs[0].stopEntered.promise;
    await h.state.whenIdle();
    const savedWhileCleanupPending = structuredClone(h.host.value);
    const fresh = integrated(savedWhileCleanupPending);
    await fresh.session.appear(savedWhileCleanupPending);
    cleanup.resolve(true);
    await Promise.all([stop, unavailable]);
    await h.session.whenIdle();
    // Assert
    assert.deepEqual(savedWhileCleanupPending, initial);
    assert.deepEqual(fresh.runs, []);
    assert.equal(h.runs[0].stops, 1);
    assert.equal(h.session.getState().runRequested, false);
    assert.deepEqual(h.host.writes, []);
  });
}

for (const loss of ['hide', 'disconnect']) {
  test(`cancel Starting then ${loss} rejects late configuration confirmation as local intent authority`, options, async () => {
    // Arrange
    const entered = deferred(), oldRead = deferred();
    const stopped = { ...initial, runRequested: false };
    const h = integrated(stopped, snapshot => {
      entered.resolve(snapshot); return oldRead.promise;
    });
    await h.session.appear(stopped);
    // Act
    const start = h.session.press();
    const oldTrue = await entered.promise;
    const cancel = h.session.press();
    const unavailable = loss === 'hide' ? h.session.disappear() : h.session.setConnected(false);
    oldRead.resolve(oldTrue);
    await Promise.all([start, cancel, unavailable]);
    await h.session.whenIdle();
    const fresh = integrated(h.host.value);
    await fresh.session.appear(h.host.value);
    // Assert
    assert.deepEqual(h.host.writes, []);
    assert.deepEqual(h.host.value, stopped);
    assert.deepEqual(h.runs, []);
    assert.deepEqual(fresh.runs, []);
    assert.equal(h.state.isBlocked(), false);
  });
}

for (const loss of ['hide', 'disconnect']) {
  for (const kind of ['success', 'nonzero', 'signal', 'launch']) {
    test(`${kind} terminal intent survives ${loss} and late result delivery using real coordinator`, options, async () => {
      // Arrange
      const h = integrated(initial);
      await h.session.appear(initial);
      await h.session.press();
      const cleanup = deferred(); h.runs[0].cleanup = cleanup;
      const diagnostic = { success: 'PROCESS_EXITED_SUCCESSFULLY', nonzero: 'PROCESS_EXITED_NONZERO', signal: 'PROCESS_TERMINATED_BY_SIGNAL' }[kind];
      // Act: a known launch failure is observed before loss; verified exit facts may arrive after loss.
      if (kind === 'launch') h.runs[0].callbacks.onError('Program launch failed.');
      const unavailable = loss === 'hide' ? h.session.disappear() : h.session.setConnected(false);
      if (diagnostic) h.runs[0].callbacks.onDiagnostic(diagnostic);
      h.runs[0].resolve(kind === 'success' ? { status: 'success' } : { status: 'error', error: kind === 'launch' ? 'Program launch failed.' : 'Program exited unsuccessfully.' });
      await h.state.whenIdle();
      const saved = structuredClone(h.host.value);
      cleanup.resolve(true);
      await unavailable;
      await h.session.whenIdle();
      const errorsWhileUnavailable = [...h.errors];
      const writesBeforeRestore = structuredClone(h.host.writes);
      if (loss === 'hide') await h.session.appear(saved); else await h.session.setConnected(true);
      await h.session.appear(saved);
      await h.session.reconcileAvailability();
      await h.session.reconcileAvailability();
      const fresh = integrated(saved); await fresh.session.appear(saved);
      // Assert
      assert.deepEqual(saved, initial);
      assert.equal(h.runs.length, 1);
      assert.deepEqual(fresh.runs, []);
      assert.equal(h.session.getState().runRequested, false);
      assert.deepEqual(errorsWhileUnavailable, []);
      const expectedError = kind === 'success' ? [] : [[
        kind === 'launch' ? 'Program launch failed.' : 'Program exited unsuccessfully.',
        kind === 'launch' ? 'PROCESS_LAUNCH_FAILED' : diagnostic,
      ]];
      assert.deepEqual(h.errors, expectedError);
      assert.equal(h.session.getState().presentation, kind === 'success' ? 'ready' : 'error');
      assert.deepEqual(h.host.writes, writesBeforeRestore);
    });
  }
}

for (const loss of ['hide', 'disconnect']) {
  test(`real coordinator interrupted launch configuration confirmation resumes silently before any generation after ${loss}`, options, async () => {
    // Arrange: only the host confirmation boundary is pending; the business coordinator remains real.
    const read = deferred(), entered = deferred(), handoffs = [];
    const stopped = { ...initial, runRequested: false };
    let reads = 0;
    const h = integrated(stopped, snapshot => {
      if (++reads === 1) { entered.resolve(snapshot); return read.promise; }
      return snapshot;
    }, (kind, caption, current, color, footer, extension) => {
      if (current()) handoffs.push(['title', ''], ['image', createLaunchArtwork(kind, caption, color, footer, extension)]);
    });
    await h.session.appear(stopped);
    const starting = h.session.press(), started = await entered.promise;
    const before = [...handoffs];
    // Act
    const pause = loss === 'hide' ? h.session.disappear() : h.session.setConnected(false);
    const resume = loss === 'hide' ? h.session.appear(h.state.getSettings()) : h.session.setConnected(true);
    const pendingChildren = h.runs.length;
    read.resolve(started); await Promise.all([starting, pause, resume]); await h.session.whenIdle();
    await h.session.reconcileAvailability();
    // Assert: resume retains the same local intent and confirms configuration without any semantic save.
    assert.equal(pendingChildren, 0);
    assert.equal(h.runs.length, 1);
    assert.equal(h.runs[0].stops, 0);
    assert.deepEqual(handoffs, before);
    assert.equal(before.length, 4); // Legitimate idle Ready followed by first-attempt Loading.
    assert.match(decodeURIComponent(before.at(-1)[1]), />loading\.\.\.<\/text>/);
    assert.deepEqual(h.host.writes, []);
    assert.deepEqual(h.host.value, stopped);
    assert.equal(h.session.getState().runRequested, true);
    assert.equal(h.state.isBlocked(), false);
    assert.deepEqual(h.errors, []);
  });
}

test('pause-induced stopped result preserves Started rather than masquerading as natural completion', options, async () => {
  // Arrange
  const h = integrated(initial);
  await h.session.appear(initial);
  await h.session.press();
  const cleanup = deferred(); h.runs[0].cleanup = cleanup;
  // Act
  const disconnect = h.session.setConnected(false);
  h.runs[0].resolve({ status: 'stopped' });
  cleanup.resolve(true);
  await disconnect;
  await h.session.whenIdle();
  await h.session.setConnected(true);
  // Assert
  assert.equal(h.host.value.runRequested, true);
  assert.equal(h.runs.length, 2);
  assert.equal(h.host.writes.some(value => value.runRequested === false), false);
});

test('genuine new Start rejects an older terminal result without any intent readback or write', options, async () => {
  // Arrange
  const h = integrated(initial);
  await h.session.appear(initial);
  await h.session.press();
  // Act
  h.runs[0].callbacks.onDiagnostic('PROCESS_EXITED_SUCCESSFULLY');
  const start = h.session.press();
  h.runs[0].resolve({ status: 'success' });
  await start;
  await h.session.whenIdle();
  // Assert
  assert.deepEqual(h.host.writes, []);
  assert.deepEqual(h.host.value, initial);
  assert.equal(h.runs.length, 2);
  assert.equal(h.session.getState().runRequested, true);
  assert.equal(h.state.isBlocked(), false);
  assert.deepEqual(h.errors, []);
});

for (const loss of ['hide', 'disconnect']) {
  test(`known launch failure result delivered after ${loss} still remembers Stopped`, options, async () => {
    // Arrange
    const h = integrated(initial);
    await h.session.appear(initial);
    await h.session.press();
    const cleanup = deferred(); h.runs[0].cleanup = cleanup;
    // Act
    const unavailable = loss === 'hide' ? h.session.disappear() : h.session.setConnected(false);
    h.runs[0].resolve({ status: 'error', error: 'Program launch failed.' });
    cleanup.resolve(true);
    await unavailable;
    await h.session.whenIdle();
    // Assert
    assert.equal(h.host.value.runRequested, true);
    assert.deepEqual(h.host.writes, []);
    assert.equal(h.session.getState().runRequested, false);
    assert.deepEqual(h.host.value.args, initial.args);
  });
}

// Real runner/session/coordinator: no native spawn, signal, filesystem or host API is exercised.
function nativeIntegrated(input, readback) {
  const host = { value: structuredClone(input), writes: [] };
  const h = harness({
    async writeSettings(value) { host.value = structuredClone(value); host.writes.push(structuredClone(value)); },
    async readSettings() { const snapshot = structuredClone(host.value); return readback ? readback(snapshot) : snapshot; },
  });
  h.state.observe(input);
  const runs = [], errors = [], displayed = [], handoffs = [];
  const session = createActionSession({
    initialConnected: true,
    async onPresentation(kind, caption, current, color, footer, extension) {
      if (current()) handoffs.push(['title', ''], ['image', createLaunchArtwork(kind, caption, color, footer, extension)]);
    },
    async confirmLaunchSettings(expected) {
      await h.state.whenIdle();
      if (h.state.isBlocked()) return false;
      const snapshot = h.state.getSettings();
      const reported = readback ? await readback(snapshot) : snapshot;
      return equalJson(expected, reported) && equalJson(expected, h.state.getSettings());
    },
    startRun(execution, callbacks) {
      const child = new EventEmitter();
      child.pid = 900_000 + runs.length; // Synthetic identifiers; both OS boundaries below are injected.
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      const cleanup = deferred(), signalEntered = deferred();
      const record = { child, cleanup, signalEntered, diagnostics: [], signals: [] };
      runs.push(record);
      record.runner = startProcessRun(execution, {
        ...callbacks,
        onDiagnostic(code) { record.diagnostics.push(code); callbacks.onDiagnostic(code); },
      }, {
        spawn: () => child,
        signalGroup(pid, signal) { record.signals.push([pid, signal]); signalEntered.resolve(); },
        waitForGroupExit: () => cleanup.promise,
      });
      return record.runner;
    },
    async setImage(image, current) { if (current()) { displayed.push(image); handoffs.push(['image', image]); } },
    async setTitle(title, current) { if (current()) { displayed.push(title); handoffs.push(['title', title]); } },
    onError(message, code, current) { if (current()) errors.push([message, code]); },
  });
  return { ...h, host, session, runs, errors, displayed, handoffs };
}

function launchError() { return Object.assign(new Error('synthetic launch failure'), { code: 'ENOENT' }); }
function closeNative(record, code = -2) {
  record.child.emit('close', code, null);
  record.cleanup.resolve(true);
}
function disposeNative(h) {
  for (const record of h.runs) { record.child.stdout.destroy(); record.child.stderr.destroy(); }
}

for (const loss of ['hide', 'disconnect']) {
  test(`real pre-spawn ENOENT after ${loss} stops local intent despite runner stopped result and cannot auto-retry`, options, async () => {
    // Arrange
    const h = nativeIntegrated(initial);
    await h.session.appear(initial);
    // Native boundary returns a child on explicit press but intentionally emits no spawn event.
    await h.session.press();
    const run = h.runs[0];
    // Act
    const unavailable = loss === 'hide' ? h.session.disappear() : h.session.setConnected(false);
    await run.signalEntered.promise; // Establish that the real runner has received the stop request.
    run.child.emit('error', launchError());
    run.child.emit('error', launchError()); // Duplicate native error must not create another semantic terminal fact.
    await h.state.whenIdle();
    const savedBeforeCleanup = structuredClone(h.host.value);
    closeNative(run);
    const result = await run.runner.done;
    await unavailable; await h.session.whenIdle();
    const errorsWhileUnavailable = [...h.errors];
    if (loss === 'hide') await h.session.appear(savedBeforeCleanup); else await h.session.setConnected(true);
    await h.session.appear(savedBeforeCleanup);
    await h.session.reconcileAvailability();
    await h.session.reconcileAvailability();
    const fresh = nativeIntegrated(savedBeforeCleanup);
    await fresh.session.appear(savedBeforeCleanup);
    // Assert: actual runner classification is deliberately stopped, not a preclassified mock error.
    assert.deepEqual(result, { status: 'stopped' });
    assert.deepEqual(savedBeforeCleanup, initial);
    assert.deepEqual(h.host.writes, []);
    assert.equal(run.diagnostics.filter(code => code === 'PROCESS_LAUNCH_FAILED').length, 1);
    assert.equal(run.diagnostics.includes('PROCESS_LAUNCH_REASON_ENOENT'), true);
    assert.equal(h.session.getState().runRequested, false);
    assert.equal(h.runs.length, 1);
    assert.deepEqual(fresh.runs, []);
    assert.deepEqual(errorsWhileUnavailable, []);
    assert.deepEqual(h.errors, [['Program launch failed.', 'PROCESS_LAUNCH_REASON_ENOENT']]);
    assert.equal(h.session.getState().presentation, 'error');
    assert.deepEqual(h.displayed, []);
    disposeNative(h); disposeNative(fresh);
  });
}

test('real pre-spawn failure while visible uses fixed launch diagnosis and local Stopped', options, async () => {
  // Arrange
  const h = nativeIntegrated(initial);
  await h.session.appear(initial);
  await h.session.press();
  const run = h.runs[0];
  // Act
  run.child.emit('error', launchError());
  closeNative(run);
  const result = await run.runner.done;
  await h.session.whenIdle();
  // Assert
  assert.deepEqual(result, { status: 'error', error: 'Program launch failed.' });
  assert.deepEqual(h.errors, [['Program launch failed.', 'PROCESS_LAUNCH_REASON_ENOENT']]);
  assert.equal(h.host.value.runRequested, true);
  assert.deepEqual(h.host.writes, []);
  assert.equal(h.session.getState().runRequested, false);
  assert.equal(h.runs.length, 1);
  disposeNative(h);
});

test('manual Stop followed by native pre-spawn error retains False without new session errors', options, async () => {
  // Arrange
  const h = nativeIntegrated(initial);
  await h.session.appear(initial);
  await h.session.press();
  const run = h.runs[0];
  // Act
  const stop = h.session.press();
  await run.signalEntered.promise;
  await h.state.whenIdle();
  const savedBeforeFailure = structuredClone(h.host.value);
  run.child.emit('error', launchError());
  closeNative(run);
  await stop; await h.session.whenIdle();
  // Assert
  assert.equal(savedBeforeFailure.runRequested, true);
  assert.deepEqual(h.host.value, savedBeforeFailure);
  assert.deepEqual(h.host.writes, []);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(await run.runner.done, { status: 'stopped' });
  assert.equal(h.runs.length, 1);
  disposeNative(h);
});

for (const loss of ['hide', 'disconnect']) {
  test(`real availability stop without launch failure preserves Started and resumes after ${loss}`, options, async () => {
    // Arrange
    const h = nativeIntegrated(initial);
    await h.session.appear(initial);
    await h.session.press();
    const old = h.runs[0];
    // Act
    const unavailable = loss === 'hide' ? h.session.disappear() : h.session.setConnected(false);
    await old.signalEntered.promise;
    closeNative(old, 0);
    const pausedResult = await old.runner.done;
    await unavailable; await h.session.whenIdle();
    const pausedSettings = structuredClone(h.host.value);
    const beforeResumeDisplay = [...h.handoffs];
    if (loss === 'hide') await h.session.appear(pausedSettings); else await h.session.setConnected(true);
    await h.session.reconcileAvailability();
    const resumedDisplay = [...h.handoffs];
    const resumedCount = h.runs.length;
    const resumedIntent = h.session.getState().runRequested;
    const writesBeforeManualCleanup = structuredClone(h.host.writes);
    // Teardown the second fake child through the real stop path, not native signals.
    const stopping = h.session.press(); await h.runs[1].signalEntered.promise;
    closeNative(h.runs[1], 0); await stopping; await h.session.whenIdle();
    // Assert
    assert.deepEqual(pausedResult, { status: 'stopped' });
    assert.equal(pausedSettings.runRequested, true);
    assert.equal(resumedIntent, true);
    assert.equal(resumedCount, 2);
    assert.deepEqual(writesBeforeManualCleanup, []);
    assert.equal(beforeResumeDisplay.length, 4);
    assert.deepEqual(resumedDisplay, beforeResumeDisplay);
    assert.match(decodeURIComponent(resumedDisplay[3][1]), />loading\.\.\.<\/text>/);
    assert.equal(old.diagnostics.includes('PROCESS_LAUNCH_FAILED'), false);
    assert.deepEqual(h.errors, []);
    disposeNative(h);
  });
}

test('late native launch diagnostic from paused old generation cannot stop a new generation', options, async () => {
  // Arrange
  const h = nativeIntegrated(initial);
  await h.session.appear(initial);
  await h.session.press();
  const old = h.runs[0];
  // Act
  const hide = h.session.disappear();
  await old.signalEntered.promise;
  old.cleanup.resolve(true); // Cleanup can settle before the old child's error/close callbacks arrive.
  await hide;
  await h.session.appear(initial);
  old.child.emit('error', launchError());
  old.child.emit('close', -2, null);
  await old.runner.done; await h.session.whenIdle();
  const currentIntent = h.session.getState().runRequested;
  const currentSettings = structuredClone(h.host.value);
  const writesBeforeTeardown = structuredClone(h.host.writes);
  const stop = h.session.press(); await h.runs[1].signalEntered.promise;
  closeNative(h.runs[1]); await stop; await h.session.whenIdle();
  // Assert
  assert.equal(old.diagnostics.includes('PROCESS_LAUNCH_FAILED'), true);
  assert.equal(h.runs.length, 2);
  assert.equal(currentIntent, true);
  assert.deepEqual(currentSettings, initial);
  assert.deepEqual(writesBeforeTeardown, []);
  assert.deepEqual(h.errors, []);
  disposeNative(h);
});

test('cancel Starting with late old native error and configuration readback retains manual Stopped', options, async () => {
  // Arrange
  const entered = deferred(), oldRead = deferred();
  let reads = 0;
  const h = nativeIntegrated(initial, snapshot => {
    if (++reads === 2) { entered.resolve(snapshot); return oldRead.promise; }
    return snapshot;
  });
  await h.session.appear(initial);
  await h.session.press();
  const old = h.runs[0];
  const firstStop = h.session.press(); await old.signalEntered.promise;
  old.cleanup.resolve(true); await firstStop;
  // Act
  const start = h.session.press();
  const reportedTrue = await entered.promise;
  const cancel = h.session.press();
  old.child.emit('error', launchError());
  old.child.emit('close', -2, null);
  oldRead.resolve(reportedTrue);
  await Promise.all([start, cancel]);
  await old.runner.done; await h.session.whenIdle();
  // Assert
  assert.deepEqual(h.host.writes, []);
  assert.equal(h.host.value.runRequested, true);
  assert.equal(h.session.getState().runRequested, false);
  assert.equal(h.runs.length, 1);
  assert.deepEqual(h.errors, []);
  disposeNative(h);
});

for (const snapshot of [{}, { executable: 'relative', args: 'invalid JSON', legacy: { preserved: ['value'] } }, { ...initial, extra: { kept: true } }]) {
  test('theme-only edits preserve complete JSON and do not invent arguments or run intent', () => {
    // Arrange
    const original = structuredClone(snapshot);
    // Act
    const result = applyConfigurationEdit(snapshot, { themeColor: '#ABCDEF' });
    // Assert
    assert.deepEqual(result, { ...original, themeColor: '#abcdef' });
    assert.deepEqual(snapshot, original);
    assert.equal(Object.hasOwn(result, 'argsText'), Object.hasOwn(original, 'argsText'));
    assert.equal(Object.hasOwn(result, 'runRequested'), Object.hasOwn(original, 'runRequested'));
  });
}
test('mixed executable/theme edit retains legacy intent and JSON without migration', () => {
  // Arrange
  const snapshot = structuredClone(initial);
  // Act
  const next = applyConfigurationEdit(snapshot, { executable: '/replacement', themeColor: '#AABBCC' });
  // Assert
  assert.deepEqual(next, { ...initial, executable: '/replacement', themeColor: '#aabbcc' });
  assert.deepEqual(snapshot, initial);
});
test('invalid theme edit is rejected before coordinator writes without blocking healthy intent', options, async () => {
  // Arrange
  const h = harness(); h.state.observe(initial);
  // Act
  let error;
  try { await h.state.editConfiguration({ themeColor: 'private invalid css' }); } catch (failure) { error = failure; }
  // Assert
  assert.equal(error?.diagnosticCode, 'THEME_COLOR_INVALID');
  assert.deepEqual(h.state.getSettings(), initial);
  assert.deepEqual(h.writes, []);
  assert.equal(h.state.isBlocked(), false);
});
test('real coordinator theme edit during pending True readback preserves Started and launches exactly once', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred();
  let reads = 0;
  const stopped = { ...initial, runRequested: false };
  const h = integrated(stopped, snapshot => { if (++reads === 1) { entered.resolve(snapshot); return gate.promise; } return snapshot; });
  await h.session.appear(stopped);
  // Act
  const starting = h.session.press();
  const obsoleteSnapshot = await entered.promise;
  const edit = h.state.editConfiguration({ themeColor: '#ABCDEF' });
  const appearance = h.session.applySettings(h.state.getSettings());
  gate.resolve(obsoleteSnapshot);
  await Promise.all([starting, edit, appearance]); await h.session.whenIdle();
  // Assert
  assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0].stops, 0);
  assert.deepEqual(h.host.value, { ...stopped, themeColor: '#abcdef' });
  assert.equal(h.session.getState().runRequested, true);
  assert.equal(h.state.isBlocked(), false);
  assert.deepEqual(h.host.writes, [{ ...stopped, themeColor: '#abcdef' }]);
  assert.deepEqual(h.errors, []);
});
test('real coordinator theme edit supersedes deferred Waiting drawing but not its single launch authorization', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred(), rendered = [];
  let first = true, oldGuard;
  const h = integrated(initial, undefined, async (kind, caption, current, color) => {
    if (kind === 'waiting' && first) { first = false; oldGuard = current; entered.resolve(); await gate.promise; }
    if (current()) rendered.push([kind, color]);
  });
  // Act
  await h.session.appear(initial);
  rendered.length = 0; // Observe the Loading boundary, not idle setup.
  const starting = h.session.press(); await entered.promise;
  await h.state.editConfiguration({ themeColor: '#123456' });
  await h.session.applySettings(h.state.getSettings());
  const staleDrawing = oldGuard(), startsBeforeGate = h.runs.length;
  gate.resolve(); await starting; await h.session.whenIdle();
  // Assert
  assert.equal(staleDrawing, false);
  assert.equal(startsBeforeGate, 0);
  assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0].stops, 0);
  assert.deepEqual(rendered, [['waiting', '#123456']]);
  assert.deepEqual(h.host.writes, [{ ...initial, themeColor: '#123456' }]);
  assert.equal(h.session.getState().runRequested, true);
});
test('uncertain theme save retains coordinator block and cannot permit session launch', options, async () => {
  // Arrange
  const h = harness({ async readSettings() { return initial; } });
  h.state.observe(initial);
  // Act
  let error;
  try { await h.state.editConfiguration({ themeColor: '#abcdef' }); } catch (failure) { error = failure; }
  let nextError;
  try { await h.state.editConfiguration({ argsText: 'newer' }); } catch (failure) { nextError = failure; }
  // Assert
  assert.equal(error?.diagnosticCode, 'STATE_SAVE_FAILED');
  assert.equal(nextError?.diagnosticCode, 'STATE_SAVE_FAILED');
  assert.equal(h.state.isBlocked(), true);
  assert.equal(h.state.getSettings().runRequested, true);
  assert.equal(h.writes.length, 1);
});

test('real session cannot launch through coordinator uncertainty following a theme write', options, async () => {
  // Arrange
  const h = integrated(initial, () => initial);
  let failure;
  // Act
  try { await h.state.editConfiguration({ themeColor: '#abcdef' }); } catch (error) { failure = error; }
  await h.session.appear(h.state.getSettings());
  await h.session.whenIdle();
  const appearanceErrors = [...h.errors];
  await h.session.press(); await h.session.whenIdle();
  // Assert
  assert.equal(failure?.diagnosticCode, 'STATE_SAVE_FAILED');
  assert.deepEqual(h.runs, []);
  assert.equal(h.session.getState().persistenceBlocked, true);
  assert.equal(h.session.getState().runRequested, false);
  assert.equal(h.session.getState().phase, 'stopped');
  assert.deepEqual(appearanceErrors, [['Run state save failed.', 'STATE_SAVE_FAILED']]);
  assert.deepEqual(h.errors.slice(appearanceErrors.length), [['Run state save failed.', 'STATE_SAVE_FAILED']]);
  assert.equal(h.host.writes.length, 1);
});
