import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { createActionSession } from '../src/core/action-session.mjs';
import { createRunStateCoordinator } from '../src/core/run-state.mjs';

const options = { timeout: 1_000 };
const initial = { executable: '/synthetic/program', args: ['legacy', ''], cwd: '/synthetic/cwd', runRequested: false, themeColor: '#969696' };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Business integration: only host storage/readback, process handles, display and clock are doubles.
function fixture(input = initial, dependencies = {}) {
  const host = { settings: structuredClone(input), writes: [] };
  const runs = [], rendered = [], errors = [], readQueue = [], confirmationQueue = [], timers = new Map(), confirmations = [], artwork = [];
  let session, timerId = 0, rejectImage = false, transformReply, loadingControl;
  const coordinator = createRunStateCoordinator({
    async writeSettings(settings) { host.settings = structuredClone(settings); host.writes.push(structuredClone(settings)); },
    async readSettings() {
      const snapshot = structuredClone(host.settings), controlled = readQueue.shift();
      if (!controlled) return snapshot;
      controlled.entered.resolve(snapshot);
      return controlled.gate.promise;
    },
    onFailure() { void session?.persistenceFailed(); },
    setTimer(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimer(id) { timers.delete(id); },
  });
  coordinator.observe(input);
  session = createActionSession({
    initialConnected: true,
    async confirmLaunchSettings(expected) {
      await coordinator.whenIdle();
      const controlled = confirmationQueue.shift();
      if (controlled) { controlled.entered.resolve(expected); await controlled.gate.promise; }
      const snapshot = coordinator.getSettings();
      const result = { status: coordinator.isBlocked() ? 'stale' : 'saved', settings: snapshot };
      confirmations.push({ value: false, result });
      const reported = transformReply ? transformReply(result, false) : result;
      return reported?.status === 'saved' && isDeepStrictEqual(expected, reported.settings);
    },
    startRun(execution, callbacks) {
      const done = deferred(), stopEntered = deferred();
      const run = { execution, callbacks, done, stopEntered, stops: 0, certain: true, cleanup: undefined };
      runs.push(run);
      return { done: done.promise, async stop() { run.stops++; stopEntered.resolve(); return run.cleanup ? run.cleanup.promise : run.certain; } };
    },
    async setImage(image, current) {
      if (rejectImage) { rejectImage = false; throw new Error('private display boundary'); }
      if (current()) rendered.push(['image', image]);
    },
    async setTitle(title, current) { if (current()) rendered.push(['title', title]); },
    async onPresentation(kind, caption, current, color, footer, extension) {
      if (current()) { rendered.push([kind]); artwork.push({ kind, caption, color, footer, extension, current }); }
      if (kind === 'waiting' && loadingControl) {
        const control = loadingControl; loadingControl = undefined; control.entered.resolve(); await control.gate.promise;
      }
    },
    onError(message, code, current) { if (current()) { errors.push([message, code]); rendered.push(['error', message, code]); } },
    ...dependencies,
  });
  return {
    session, coordinator, host, runs, rendered, errors, confirmations, timers, artwork,
    rejectNextImage() { rejectImage = true; },
    transformReplies(callback) { transformReply = callback; },
    controlRead() { const control = { entered: deferred(), gate: deferred() }; readQueue.push(control); return control; },
    controlConfirmation() { const control = { entered: deferred(), gate: deferred() }; confirmationQueue.push(control); return control; },
    controlLoading() { loadingControl = { entered: deferred(), gate: deferred() }; return loadingControl; },
    expireReads() { for (const [id, timer] of [...timers]) { timers.delete(id); timer.callback(); } },
    edit(changes) {
      // Actual PI ordering: queue complete-settings save; apply the current snapshot BEFORE awaiting it.
      const saving = coordinator.editConfiguration(changes);
      const next = coordinator.getSettings();
      const applying = session.applySettings(next);
      return { saving, applying, next, async finish() { await Promise.all([saving, applying]); await session.whenIdle(); } };
    },
    incoming(snapshot, useAppearance = false) {
      // Host-reported external snapshot, not an invented persistence acknowledgment.
      host.settings = structuredClone(snapshot);
      const result = coordinator.observe(snapshot);
      // Actual adapter: appearance reconciles availability with local authority;
      // settings events apply only an accepted initialization, never raw host data.
      if (useAppearance) return session.appear(coordinator.getSettings());
      return result.accepted ? session.applySettings(result.settings) : Promise.resolve();
    },
  };
}

// Slice 4: real settings authority settles writes independently of the core launch queue.
for (const superseded of [false, true]) {
  test(`confirmed Started cannot bypass a pending complete theme snapshot; superseded=${superseded}`, options, async () => {
    // Arrange
    const expected = [], gateEntered = deferred();
    const h = fixture(initial, { async confirmLaunchSettings(snapshot) {
      expected.push(snapshot); gateEntered.resolve(); await h.coordinator.whenIdle();
      return !h.coordinator.isBlocked() && isDeepStrictEqual(snapshot, h.coordinator.getSettings());
    } });
    await h.session.appear(initial); const loading = h.controlLoading();
    const starting = h.session.press(); await loading.entered.promise; await h.coordinator.whenIdle();
    const read = h.controlRead(); const editing = h.edit({ themeColor: '#abcdef' }); const snapshot = await read.entered.promise;
    // Act
    loading.gate.resolve(); await gateEntered.promise; const before = h.runs.length;
    const newer = superseded ? h.edit({ themeColor: '#fedcba' }) : undefined;
    if (superseded) read.gate.reject(Error('superseded synthetic read')); else read.gate.resolve(snapshot);
    await Promise.all([starting, editing.finish(), newer?.finish()]); await h.session.whenIdle();
    // Assert
    assert.equal(before, 0); assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 0);
    assert.equal(expected.at(-1).themeColor, superseded ? '#fedcba' : '#abcdef');
    assert.ok(expected.every(value => value.runRequested === false));
    assert.deepEqual(h.host.writes.map(value => value.themeColor), superseded ? ['#abcdef', '#fedcba'] : ['#abcdef']);
    assert.deepEqual(h.errors, []); assert.equal(h.coordinator.isBlocked(), false); assert.equal(h.session.getState().persistenceBlocked, false);
  });
}

for (const failure of ['reject', 'mismatch']) {
  test(`current theme ${failure} while final launch confirmation waits retains fixed STATE error without spawn`, options, async () => {
    // Arrange
    const gateEntered = deferred();
    const h = fixture(initial, { async confirmLaunchSettings(snapshot) {
      gateEntered.resolve(); await h.coordinator.whenIdle();
      return !h.coordinator.isBlocked() && isDeepStrictEqual(snapshot, h.coordinator.getSettings());
    } });
    await h.session.appear(initial); const loading = h.controlLoading(); const starting = h.session.press();
    await loading.entered.promise; await h.coordinator.whenIdle(); const read = h.controlRead();
    const editing = h.edit({ themeColor: '#abcdef' }), settled = editing.saving.then(() => undefined, error => error);
    const snapshot = await read.entered.promise;
    // Act
    loading.gate.resolve(); await gateEntered.promise;
    if (failure === 'reject') read.gate.reject(Error('synthetic storage boundary')); else read.gate.resolve({ ...snapshot, themeColor: '#123456' });
    await Promise.all([starting, settled, editing.applying]); await h.session.whenIdle();
    // Assert
    assert.deepEqual(h.runs, []); assert.equal(h.coordinator.isBlocked(), true); assert.equal(h.session.getState().persistenceBlocked, true);
    assert.deepEqual(h.errors.at(-1), ['Run state save failed.', 'STATE_SAVE_FAILED']);
    assert.deepEqual(h.host.writes.map(value => value.runRequested), [false]);
  });
}

test('suffix-only replacement waits for complete confirmed settings before publishing the new badge', options, async () => {
  // Arrange
  const configured = { ...initial, executable: '/synthetic/report.py' };
  const h = fixture(configured); await h.session.appear(configured);
  const read = h.controlRead();
  // Act
  const editing = h.edit({ executable: '/synthetic/report.sh' }); const snapshot = await read.entered.promise;
  const before = h.artwork.map(item => [item.caption, item.extension]);
  read.gate.resolve(snapshot); await editing.finish();
  // Assert
  assert.deepEqual(before, [['report', '.py']]);
  assert.deepEqual(h.artwork.map(item => [item.caption, item.extension]), [['report', '.py'], ['report', '.sh']]);
  assert.deepEqual(h.host.writes, [{ ...configured, executable: '/synthetic/report.sh' }]);
  assert.deepEqual(h.runs, []); assert.equal(h.session.getState().runRequested, false);
});

test('failed suffix replacement confirmation retains Error and cannot publish the newer badge', options, async () => {
  // Arrange
  const configured = { ...initial, executable: '/synthetic/report.py' };
  const h = fixture(configured); await h.session.appear(configured); const read = h.controlRead();
  // Act
  const editing = h.edit({ executable: '/synthetic/report.sh' });
  const settled = editing.saving.then(() => undefined, error => error);
  await read.entered.promise; read.gate.reject(Error('synthetic storage boundary'));
  await settled; await editing.applying; await h.session.whenIdle();
  // Assert
  assert.deepEqual(h.artwork.map(item => item.extension), ['.py']);
  assert.equal(h.session.getState().presentation, 'error');
  assert.deepEqual(h.errors.at(-1), ['Run state save failed.', 'STATE_SAVE_FAILED']); assert.deepEqual(h.runs, []);
});

// Success footer requires final-frame settlement, never a settings intent write or readback.
async function exitedFixture() {
  const h = fixture();
  await h.session.appear(initial); await h.session.press();
  h.runs[0].callbacks.onDiagnostic('PROCESS_EXITED_SUCCESSFULLY');
  h.runs[0].done.resolve({ status: 'success' }); await h.session.whenIdle();
  return h;
}

for (const output of [false, true]) {
  test(`natural zero exit ${output ? 'with final output' : 'without output'} publishes exited without settings writes or readback`, options, async () => {
    // Arrange
    const h = fixture(); await h.session.appear(initial); await h.session.press();
    const beforeConfirmations = h.confirmations.length;
    if (output) { h.runs[0].callbacks.onUpdate({ kind: 'image', image: 'data:image/png;base64,AAAA' }); await h.session.whenIdle(); }
    // Act
    h.runs[0].callbacks.onDiagnostic('PROCESS_EXITED_SUCCESSFULLY');
    h.runs[0].done.resolve({ status: 'success' });
    await h.session.whenIdle();
    const fresh = fixture(h.host.settings); await fresh.session.appear(h.host.settings);
    // Assert
    assert.equal(h.artwork.at(-1).footer, 'exited');
    assert.equal(h.artwork.at(-1).caption, 'program');
    assert.equal(h.confirmations.length, beforeConfirmations);
    assert.deepEqual(h.host.settings, initial);
    assert.deepEqual(h.host.writes, []);
    assert.equal(Object.hasOwn(h.host.settings, 'idleFooter'), false);
    assert.equal(fresh.artwork.at(-1).footer, 'ready');
    assert.deepEqual(fresh.runs, []);
    assert.equal(h.session.getState().presentation, 'ready');
  });
}

for (const failure of ['reject', 'mismatch', 'timeout', 'stale']) {
  test(`unused ${failure} host readback cannot block local exited or manufacture persistence failure`, options, async () => {
    // Arrange
    const h = fixture(); await h.session.appear(initial); await h.session.press();
    const read = h.controlRead(), confirmations = h.confirmations.length;
    if (failure === 'stale') h.transformReplies((result, value) => value ? result : { ...result, status: 'stale' });
    // Act
    h.runs[0].callbacks.onDiagnostic('PROCESS_EXITED_SUCCESSFULLY'); h.runs[0].done.resolve({ status: 'success' });
    await h.session.whenIdle();
    read.gate.resolve(initial); // Release an unused boundary without an unhandled rejection.
    // Assert
    assert.equal(h.artwork.at(-1).footer, 'exited');
    assert.equal(h.runs.length, 1);
    assert.equal(h.session.getState().runRequested, false);
    assert.equal(h.coordinator.isBlocked(), false);
    assert.equal(h.session.getState().persistenceBlocked, false);
    assert.equal(h.confirmations.length, confirmations);
    assert.deepEqual(h.host.writes, []);
    assert.deepEqual(h.errors, []);
  });
}

for (const [field, changes] of [['executable', { executable: '/synthetic/report.py' }], ['argsText', { argsText: '--changed' }], ['cwd', { cwd: '/synthetic/new-cwd' }]]) {
  test(`meaningful ${field} edit resets exited to ready after safe confirmed recovery without launching`, options, async () => {
    // Arrange
    const h = await exitedFixture(); const writes = h.host.writes.length;
    // Act
    await h.edit(changes).finish();
    // Assert
    assert.equal(h.artwork.at(-1).footer, 'ready');
    assert.equal(h.artwork.at(-1).caption, field === 'executable' ? 'report' : 'program');
    assert.equal(h.runs.length, 1);
    assert.equal(h.runs[0].stops, 1);
    assert.equal(h.session.getState().recoveryPending, false);
    assert.equal(h.host.settings.runRequested, false);
    assert.ok(h.host.writes.length > writes);
    assert.equal(h.confirmations.at(-1).result.status, 'saved');
    assert.deepEqual(h.errors, []);
  });
}

for (const [label, changes] of [['theme', { themeColor: '#ABCDEF' }], ['equivalent migration', { argsText: 'legacy ""' }], ['identical execution', { executable: initial.executable }]]) {
  test(`${label} preserves exited without extra intent write, stop or launch`, options, async () => {
    // Arrange
    const h = await exitedFixture(); const confirmations = h.confirmations.length;
    // Act
    await h.edit(changes).finish(); await h.session.refreshAppearance();
    // Assert
    assert.equal(h.artwork.at(-1).footer, 'exited');
    assert.equal(h.artwork.at(-1).caption, 'program');
    assert.equal(h.artwork.at(-1).color, label === 'theme' ? '#abcdef' : '#969696');
    assert.equal(h.confirmations.length, confirmations);
    assert.equal(h.runs.length, 1);
    assert.equal(h.runs[0].stops, 0);
    assert.equal(h.session.getState().runRequested, false);
    assert.deepEqual(h.errors, []);
  });
}

for (const certain of [true, false]) {
  test(`paused owned natural zero exit waits for ${certain ? 'safe' : 'uncertain'} cleanup without Stopped readback`, options, async () => {
    // Arrange
    const h = fixture(); await h.session.appear(initial); await h.session.press();
    const run = h.runs[0]; run.cleanup = deferred();
    // Act
    const hide = h.session.disappear(); await run.stopEntered.promise;
    run.callbacks.onDiagnostic('PROCESS_EXITED_SUCCESSFULLY'); run.done.resolve({ status: 'stopped' });
    await h.coordinator.whenIdle();
    const beforeCleanup = h.artwork.map(item => item.footer);
    run.cleanup.resolve(certain); await hide; await h.session.whenIdle();
    const beforeAppearance = h.artwork.length;
    await h.session.appear(h.coordinator.getSettings()); await h.session.whenIdle();
    // Assert
    assert.deepEqual(beforeCleanup, ['ready', 'ready']);
    assert.equal(beforeAppearance, 2);
    assert.equal(h.runs.length, 1);
    assert.equal(h.host.settings.runRequested, false);
    if (certain) assert.equal(h.artwork.at(-1).footer, 'exited');
    else {
      assert.equal(h.artwork.some(item => item.footer === 'exited'), false);
      assert.equal(h.session.getState().cleanupBlocked, true);
      assert.deepEqual(h.errors.at(-1), ['Process cleanup uncertain.', 'CLEANUP_BLOCKED']);
    }
  });
}

for (const failure of ['display', 'protocol', 'nonzero', 'signal']) {
  test(`${failure} terminal fact never becomes exited even with later success result`, options, async () => {
    // Arrange
    const h = fixture(); await h.session.appear(initial); await h.session.press();
    const run = h.runs[0];
    // Act
    if (failure === 'display') { h.rejectNextImage(); run.callbacks.onUpdate({ kind: 'image', image: 'data:image/png;base64,AAAA' }); await h.session.whenIdle(); }
    else if (failure === 'protocol') run.callbacks.onError('Image protocol error.');
    else run.callbacks.onDiagnostic(failure === 'signal' ? 'PROCESS_TERMINATED_BY_SIGNAL' : 'PROCESS_EXITED_NONZERO');
    run.callbacks.onDiagnostic('PROCESS_EXITED_SUCCESSFULLY'); run.done.resolve({ status: 'success' }); await h.session.whenIdle();
    // Assert
    assert.equal(h.artwork.some(item => item.footer === 'exited'), false);
    assert.equal(h.session.getState().presentation, 'error');
    assert.equal(h.runs.length, 1);
    assert.equal(h.host.settings.runRequested, false);
    assert.equal(h.errors.at(-1)[1], { display: 'FRAME_SEND_FAILED', protocol: 'IMAGE_PROTOCOL_ERROR', nonzero: 'PROCESS_EXITED_NONZERO', signal: 'PROCESS_TERMINATED_BY_SIGNAL' }[failure]);
  });
}

async function failed(kind = 'protocol') {
  const input = kind === 'config' ? { ...initial, executable: 'private-invalid-executable' } : initial;
  const h = fixture(input);
  await h.session.appear(input); await h.session.press();
  if (kind !== 'config') {
    const run = h.runs[0];
    if (kind === 'display') {
      h.rejectNextImage(); run.callbacks.onUpdate({ kind: 'image', image: 'data:image/png;base64,AAAA' });
    } else {
      if (kind === 'launch-specific') { run.callbacks.onDiagnostic('PROCESS_LAUNCH_FAILED'); run.callbacks.onDiagnostic('PROCESS_LAUNCH_REASON_ENOENT'); }
      if (kind === 'exit') run.callbacks.onDiagnostic('PROCESS_EXITED_NONZERO');
      const message = kind === 'protocol' ? 'Image protocol error.' : kind.startsWith('launch') ? 'Program launch failed.' : 'Program exited unsuccessfully.';
      run.callbacks.onError(message); run.done.resolve({ status: 'error', error: message });
    }
  }
  await h.session.whenIdle();
  return h;
}

const edits = [
  ['executable', { executable: '/synthetic/replacement' }],
  ['args', { argsText: '--changed "literal value"' }],
  ['cwd', { cwd: '/synthetic/replacement-cwd' }],
];
for (const failure of ['launch', 'launch-specific', 'protocol', 'config', 'exit', 'display']) {
  for (const [field, changes] of edits) {
    // Config failure needs an executable correction to become valid; args/cwd still exercise that edit policy.
    const validChanges = failure === 'config' ? { executable: '/synthetic/corrected', ...changes } : changes;
    test(`${failure} error clears only after confirmed valid ${field} execution edit, without launching`, options, async () => {
      // Arrange
      const h = await failed(failure);
      assert.equal(h.session.getState().presentation, 'error');
      const starts = h.runs.length, before = h.rendered.length;
      // Act
      const operation = h.edit(validChanges);
      const immediateIntent = h.session.getState().runRequested;
      await operation.finish();
      const fresh = fixture(h.host.settings); await fresh.session.appear(h.host.settings);
      // Assert
      assert.equal(immediateIntent, false);
      assert.equal(h.session.getState().phase, 'stopped');
      assert.equal(h.session.getState().presentation, 'ready');
      assert.equal(h.session.getState().protocolBlocked, false);
      assert.equal(h.session.getState().recoveryPending, false);
      assert.equal(h.host.settings.runRequested, false);
      assert.equal(h.runs.length, starts);
      assert.deepEqual(fresh.runs, []);
      assert.ok(h.rendered.slice(before).some(event => event[0] === 'ready'));
      assert.equal(h.rendered.slice(before).some(event => event[0] === 'error'), false);
      assert.deepEqual(h.host.settings.args, initial.args); // Legacy data is retained, even when argsText takes precedence.
      assert.ok(h.confirmations.some(entry => entry.value === false && entry.result.status === 'saved' && entry.result.settings.executable === operation.next.executable));
    });
  }
}

for (const [changes, code] of [[{ argsText: "'private-unclosed" }, 'ARGS_TEXT_INVALID'], [{ cwd: 'private-relative-cwd' }, 'INVALID_CWD']]) {
  test(`confirmed invalid edit replaces old protocol diagnosis with current ${code}`, options, async () => {
    // Arrange
    const h = await failed(); const starts = h.runs.length;
    // Act
    await h.edit(changes).finish();
    // Assert
    assert.deepEqual(h.errors.at(-1), ['Invalid settings.', code]);
    assert.equal(h.session.getState().presentation, 'error');
    assert.equal(h.session.getState().protocolBlocked, false);
    assert.equal(h.session.getState().recoveryPending, false);
    assert.equal(h.runs.length, starts);
    assert.equal(h.host.settings.runRequested, false);
    assert.equal(JSON.stringify(h.errors).includes('private'), false);
  });
}
test('plugin execution edit with malformed arguments reports fresh fixed reason after matching snapshot confirmation', options, async () => {
  // Arrange
  const h = await failed();
  // Relative executables are rejected before PI writes; malformed quote text is
  // a permitted narrow edit that becomes invalid only during execution validation.
  const changes = { argsText: "'private-unterminated" };
  // Act
  await h.edit(changes).finish();
  // Assert
  assert.deepEqual(h.errors.at(-1), ['Invalid settings.', 'ARGS_TEXT_INVALID']);
  assert.equal(h.session.getState().protocolBlocked, false);
  assert.equal(h.session.getState().presentation, 'error');
  assert.equal(h.runs.length, 1);
  assert.equal(JSON.stringify(h.errors).includes('private'), false);
});

for (const [label, changes] of [['theme', { themeColor: '#abcdef' }], ['lossless migration', { argsText: 'legacy ""' }], ['identical executable', { executable: initial.executable }]]) {
  test(`${label} does not clear protocol latch or recoverable diagnosis`, options, async () => {
    // Arrange
    const h = await failed(), error = h.errors.at(-1);
    // Act
    await h.edit(changes).finish();
    // Assert
    assert.equal(h.session.getState().protocolBlocked, true);
    assert.equal(h.session.getState().presentation, 'error');
    assert.equal(h.session.getState().recoveryPending, false);
    assert.deepEqual(h.errors.at(-1), error);
    assert.equal(h.runs.length, 1);
    assert.equal(h.host.settings.runRequested, false);
  });
}
test('identical unconfigured snapshots and cosmetic-only edits do not invent execution settings or intent', options, async () => {
  // Arrange
  const h = fixture({});
  // Act
  await h.session.appear({}); await h.session.appear({});
  const writesBeforeTheme = h.host.writes.length;
  await h.edit({ themeColor: '#abcdef' }).finish();
  // Assert
  assert.equal(writesBeforeTheme, 0);
  assert.deepEqual(h.host.settings, { themeColor: '#abcdef' });
  assert.equal(h.session.getState().recoveryPending, false);
  assert.deepEqual(h.runs, []);
});
// Slice 2: configuration alone never starts; an explicit press requires confirmed Started intent.
test('Setup becomes Ready only after matching execution-edit readback and never auto-launches', options, async () => {
  // Arrange
  const h = fixture({}); await h.session.appear({}); const read = h.controlRead();
  // Act
  const operation = h.edit({ executable: '/synthetic/report.py' });
  const reported = await read.entered.promise;
  const before = h.artwork.map(item => item.footer), pending = h.session.getState();
  read.gate.resolve(reported); await operation.finish();
  // Assert
  assert.deepEqual(before, ['setup required']); assert.equal(pending.recoveryPending, true);
  assert.equal(h.artwork.at(-1).footer, 'ready'); assert.equal(h.artwork.at(-1).caption, 'report');
  assert.equal(h.session.getState().recoveryPending, false); assert.equal(h.session.getState().runRequested, false);
  assert.deepEqual(h.runs, []); assert.deepEqual(h.errors, []);
  assert.deepEqual(h.host.settings, { executable: '/synthetic/report.py', argsText: '' });
});
test('explicit press during Setup execution-edit confirmation starts once only after matching configuration readback', options, async () => {
  // Arrange
  const h = fixture({}); await h.session.appear({});
  const editRead = h.controlRead();
  // Act
  const operation = h.edit({ executable: '/synthetic/report.py' });
  const editedSnapshot = await editRead.entered.promise;
  const beforePress = { state: h.session.getState(), launches: h.runs.length };
  const startedRead = h.controlConfirmation(), pressing = h.session.press();
  const beforeEditConfirmation = h.runs.length;
  editRead.gate.resolve(editedSnapshot);
  const startedSnapshot = await startedRead.entered.promise;
  const beforeStartedConfirmation = { state: h.session.getState(), launches: h.runs.length };
  // A matching host event is not an invented ACK and cannot settle the controlled readback.
  await h.incoming(startedSnapshot);
  const afterHostEvent = h.runs.length;
  startedRead.gate.resolve(startedSnapshot);
  await operation.finish(); await pressing; await h.session.whenIdle();
  // Assert
  assert.equal(beforePress.state.recoveryPending, true); assert.equal(beforePress.state.runRequested, false);
  assert.equal(beforePress.launches, 0); assert.equal(beforeEditConfirmation, 0);
  assert.equal(beforeStartedConfirmation.launches, 0); assert.equal(afterHostEvent, 0);
  assert.equal(beforeStartedConfirmation.state.runRequested, true);
  assert.equal(beforeStartedConfirmation.state.phase, 'starting');
  assert.equal(beforeStartedConfirmation.state.cleanupBlocked, false);
  assert.equal(beforeStartedConfirmation.state.persistenceBlocked, false);
  assert.equal(beforeStartedConfirmation.state.protocolBlocked, false);
  assert.deepEqual(editedSnapshot, { executable: '/synthetic/report.py', argsText: '' });
  assert.deepEqual(startedSnapshot, editedSnapshot);
  assert.deepEqual(h.host.writes, [editedSnapshot]);
  const startedConfirmation = h.confirmations.at(-1);
  assert.equal(startedConfirmation?.result.status, 'saved');
  assert.deepEqual(startedConfirmation.result.settings, startedSnapshot);
  assert.equal(h.runs.length, 1); assert.deepEqual(h.runs[0].execution, { executable: '/synthetic/report.py', args: [] });
  assert.equal(h.session.getState().phase, 'running'); assert.equal(h.session.getState().runRequested, true);
  assert.equal(h.session.getState().recoveryPending, false); assert.deepEqual(h.errors, []);
});
test('failed Setup execution-edit confirmation retains save Error across presses and appearance', options, async () => {
  // Arrange
  const h = fixture({}); await h.session.appear({}); const read = h.controlRead();
  // Act
  const operation = h.edit({ executable: '/synthetic/report.py' });
  const saving = operation.saving.catch(error => error);
  await read.entered.promise; read.gate.reject(new Error('synthetic storage boundary'));
  const failure = await saving; await operation.applying; await h.session.whenIdle();
  await h.session.press(); await h.session.appear(h.coordinator.getSettings()); await h.session.whenIdle();
  // Assert
  assert.equal(failure?.diagnosticCode, 'STATE_SAVE_FAILED');
  assert.equal(h.session.getState().persistenceBlocked, true);
  assert.equal(h.session.getState().presentation, 'error');
  assert.deepEqual(h.errors.at(-1), ['Run state save failed.', 'STATE_SAVE_FAILED']);
  assert.equal(h.artwork.some(item => item.footer === 'ready'), false); assert.deepEqual(h.runs, []);
});
test('empty executable PI edit cannot replace Setup or initiate recovery', options, async () => {
  // Arrange
  const h = fixture({}); await h.session.appear({});
  // Act
  const failure = await h.coordinator.editConfiguration({ executable: '' }).catch(error => error);
  await h.session.applySettings(h.coordinator.getSettings()); await h.session.press(); await h.session.whenIdle();
  // Assert
  assert.equal(failure?.diagnosticCode, 'INVALID_EXECUTABLE');
  assert.equal(h.artwork.at(-1).footer, 'setup required');
  assert.equal(h.session.getState().recoveryPending, false);
  assert.deepEqual(h.host.writes, []); assert.deepEqual(h.runs, []); assert.deepEqual(h.errors, []);
});
test('manual Stop after retained launch error does not perform execution-edit recovery', options, async () => {
  // Arrange
  const h = fixture(); await h.session.appear(initial); await h.session.press();
  const run = h.runs[0]; run.callbacks.onError('Program launch failed.');
  // Act
  await h.session.press(); run.done.resolve({ status: 'stopped' }); await h.session.whenIdle();
  // Assert
  assert.equal(h.session.getState().presentation, 'error');
  assert.equal(h.host.settings.runRequested, false);
  assert.equal(h.session.getState().recoveryPending, false);
  assert.equal(h.runs.length, 1);
});

for (const releaseFirst of ['cleanup', 'readback']) {
  test(`${releaseFirst} alone cannot clear protocol error or publish early Ready`, options, async () => {
    // Arrange
    const h = await failed(); const run = h.runs[0];
    run.cleanup = deferred(); const read = h.controlRead(); const before = h.rendered.length;
    // Act
    const operation = h.edit({ executable: '/synthetic/changed' });
    const reported = await read.entered.promise; await run.stopEntered.promise;
    if (releaseFirst === 'cleanup') run.cleanup.resolve(true); else read.gate.resolve(reported);
    if (releaseFirst === 'readback') await h.coordinator.whenIdle();
    // Assert/continuation is gated rather than clock-based.
    assert.equal(h.session.getState().protocolBlocked, true);
    assert.equal(h.session.getState().recoveryPending, true);
    assert.equal(h.rendered.slice(before).some(event => event[0] === 'ready'), false);
    if (releaseFirst === 'cleanup') read.gate.resolve(reported); else run.cleanup.resolve(true);
    await operation.finish();
    assert.equal(h.session.getState().presentation, 'ready');
    assert.equal(h.session.getState().protocolBlocked, false);
    assert.equal(h.runs.length, 1);
  });
}

for (const form of ['status-only', 'stale', 'unmatched', 'true-intent']) {
  test(`${form} session save reply cannot unlock recovery despite real coordinator confirmation`, options, async () => {
    // Arrange
    const h = await failed();
    // Explicitly malformed storage-adapter replies: real coordinator still runs, business logic is not mocked.
    h.transformReplies((result, value) => {
      if (value) return result;
      if (form === 'status-only') return { status: 'saved' };
      if (form === 'stale') return { ...result, status: 'stale' };
      return { ...result, settings: { ...result.settings, ...(form === 'unmatched' ? { executable: '/synthetic/wrong-readback' } : { runRequested: true }) } };
    });
    const before = h.rendered.length;
    // Act
    await h.edit({ executable: '/synthetic/changed' }).finish();
    await h.session.disappear(); await h.session.appear(h.coordinator.getSettings()); await h.session.reconcileAvailability();
    // Assert
    assert.equal(h.session.getState().recoveryPending, true);
    assert.equal(h.session.getState().protocolBlocked, true);
    assert.equal(h.session.getState().presentation, 'error');
    assert.equal(h.rendered.slice(before).some(event => event[0] === 'ready'), false);
    assert.equal(h.runs.length, 1);
    assert.equal(h.host.settings.runRequested, false);
  });
}
test('uncertain cleanup outranks both old protocol error and new invalid settings', options, async () => {
  // Arrange
  const h = await failed(); h.runs[0].certain = false;
  // Act
  await h.edit({ argsText: "'private-invalid" }).finish();
  await h.session.appear(h.coordinator.getSettings());
  // Execution-edit recovery must not clear the latch while cleanup is uncertain.
  assert.equal(h.session.getState().protocolBlocked, true);
  await h.session.press();
  // Assert
  assert.equal(h.session.getState().cleanupBlocked, true);
  assert.equal(h.session.getState().presentation, 'error');
  assert.equal(h.errors.at(-1)[1], 'CLEANUP_BLOCKED');
  assert.equal(h.errors.some(error => error[1] === 'ARGS_TEXT_INVALID'), false);
  assert.equal(h.runs.length, 1);
});
for (const failure of ['reject', 'mismatch', 'timeout']) {
  test(`${failure} execution save preserves authoritative persistence block, never Ready or new validation diagnosis`, options, async () => {
    // Arrange
    const h = await failed(), read = h.controlRead();
    const before = h.rendered.length;
    // Act
    const operation = h.edit({ argsText: "'private-invalid" });
    const snapshot = await read.entered.promise;
    if (failure === 'reject') read.gate.reject(new Error('private read details'));
    else if (failure === 'mismatch') read.gate.resolve({ ...snapshot, executable: '/synthetic/incorrect' });
    else h.expireReads();
    await Promise.allSettled([operation.saving, operation.applying]); await h.session.whenIdle();
    if (failure === 'timeout') read.gate.resolve(snapshot);
    await h.session.press();
    // Assert
    assert.equal(h.coordinator.isBlocked(), true);
    assert.equal(h.session.getState().persistenceBlocked, true);
    assert.equal(h.session.getState().presentation, 'error');
    assert.equal(h.errors.at(-1)[1], 'STATE_SAVE_FAILED');
    assert.equal(h.errors.some(error => error[1] === 'ARGS_TEXT_INVALID'), false);
    assert.equal(h.rendered.slice(before).some(event => event[0] === 'ready'), false);
    assert.equal(h.runs.length, 1);
    assert.equal(JSON.stringify(h.errors).includes('private'), false);
  });
}

for (const loss of ['hide', 'disconnect']) {
  test(`confirmed recovery during ${loss} clears intent/latch semantically but publishes Ready only after restoration`, options, async () => {
    // Arrange
    const h = await failed(), read = h.controlRead(); h.runs[0].cleanup = deferred();
    const before = h.rendered.length;
    // Act
    const operation = h.edit({ executable: '/synthetic/changed' });
    const reported = await read.entered.promise; await h.runs[0].stopEntered.promise;
    const unavailable = loss === 'hide' ? h.session.disappear() : h.session.setConnected(false);
    h.runs[0].cleanup.resolve(true); read.gate.resolve(reported);
    await operation.finish(); await unavailable; await h.session.whenIdle();
    const stateWhileUnavailable = h.session.getState(), trafficWhileUnavailable = h.rendered.slice(before);
    if (loss === 'hide') await h.session.appear(h.coordinator.getSettings()); else await h.session.setConnected(true);
    await h.session.reconcileAvailability();
    // Assert
    assert.equal(stateWhileUnavailable.protocolBlocked, false);
    assert.equal(stateWhileUnavailable.recoveryPending, false);
    assert.equal(stateWhileUnavailable.runRequested, false);
    assert.deepEqual(trafficWhileUnavailable, []);
    assert.equal(h.rendered.at(-1)[0], 'ready');
    assert.equal(h.session.getState().presentation, 'ready');
    assert.equal(h.runs.length, 1);
    assert.equal(h.host.settings.runRequested, false);
  });
}
test('reappearance during pending edit readback cannot clear latch or bypass cleanup', options, async () => {
  // Arrange
  const h = await failed(), read = h.controlRead(); h.runs[0].cleanup = deferred();
  const before = h.rendered.length;
  // Act
  const operation = h.edit({ executable: '/synthetic/changed' });
  const snapshot = await read.entered.promise;
  const hide = h.session.disappear(), appear = h.session.appear(h.coordinator.getSettings());
  const pending = h.session.getState();
  h.runs[0].cleanup.resolve(true); read.gate.resolve(snapshot);
  await Promise.all([operation.finish(), hide, appear]); await h.session.whenIdle();
  // Assert
  assert.equal(pending.recoveryPending, true);
  assert.equal(pending.protocolBlocked, true);
  assert.equal(h.session.getState().protocolBlocked, false);
  assert.equal(h.session.getState().presentation, 'ready');
  assert.equal(h.rendered.slice(before).filter(event => event[0] === 'ready').length, 1);
  assert.equal(h.runs.length, 1);
});
test('confirmed plugin execution edit while hidden publishes its recovered result only on appearance', options, async () => {
  // Arrange
  const h = await failed(); await h.session.disappear();
  const changes = { executable: '/synthetic/changed-on-appear' };
  // Act
  await h.edit(changes).finish();
  const hidden = h.session.getState();
  await h.session.appear(h.coordinator.getSettings()); await h.session.whenIdle();
  // Assert
  assert.equal(h.session.getState().protocolBlocked, false);
  assert.equal(hidden.visible, false);
  assert.equal(h.session.getState().recoveryPending, false);
  assert.equal(h.session.getState().presentation, 'ready');
  assert.equal(h.host.settings.runRequested, false);
  assert.equal(h.runs.length, 1);
});

for (const appearance of [false, true]) {
  test(`initialized host restore ${appearance ? 'on appearance' : 'on settings event'} cannot clear protocol diagnosis or replace local execution`, options, async () => {
    // Arrange
    const h = await failed();
    const before = h.coordinator.getSettings(), revision = h.coordinator.getRevision(), writes = h.host.writes.length;
    if (appearance) await h.session.disappear();
    const incoming = { ...before, executable: '/synthetic/external-restore', runRequested: true };
    // Act
    await h.incoming(incoming, appearance); await h.session.whenIdle();
    // Assert
    assert.deepEqual(h.coordinator.getSettings(), before);
    assert.equal(h.coordinator.getRevision(), revision);
    assert.equal(h.host.writes.length, writes);
    assert.equal(h.session.getState().protocolBlocked, true);
    assert.equal(h.session.getState().presentation, 'error');
    assert.equal(h.session.getState().runRequested, false);
    assert.equal(h.runs.length, 1);
  });
}

test('execution edit cancels pending launch confirmation and confirms only the latest configuration without spawning', options, async () => {
  // Arrange
  const h = fixture(); await h.session.appear(initial); const read = h.controlConfirmation();
  // Act
  const start = h.session.press(); const oldTrue = await read.entered.promise;
  const operation = h.edit({ executable: '/synthetic/changed' });
  const pending = h.session.getState();
  read.gate.resolve(oldTrue); await Promise.all([start, operation.finish()]);
  // Assert
  assert.equal(pending.runRequested, false);
  assert.equal(pending.recoveryPending, true);
  assert.deepEqual(h.runs, []);
  assert.equal(h.host.settings.runRequested, false);
  assert.equal(h.host.settings.executable, '/synthetic/changed');
  assert.equal(h.session.getState().presentation, 'ready');
  assert.equal(h.session.getState().recoveryPending, false);
});
test('new execution edit supersedes old readback; only the latest complete configuration recovers', options, async () => {
  // Arrange
  const h = await failed(), oldRead = h.controlRead(), newestRead = h.controlRead();
  const before = h.rendered.length;
  // Act
  const old = h.edit({ executable: '/synthetic/old-edit' });
  const oldSnapshot = await oldRead.entered.promise;
  const newest = h.edit({ executable: '/synthetic/latest-edit' });
  oldRead.gate.resolve(oldSnapshot);
  const latestSnapshot = await newestRead.entered.promise;
  const pending = h.session.getState(), trafficBeforeLatestAck = h.rendered.slice(before);
  newestRead.gate.resolve(latestSnapshot);
  await Promise.all([old.finish(), newest.finish()]);
  // Assert
  assert.equal(pending.recoveryPending, true);
  assert.equal(pending.protocolBlocked, true);
  assert.equal(trafficBeforeLatestAck.some(event => event[0] === 'ready'), false);
  assert.equal(h.host.settings.executable, '/synthetic/latest-edit');
  assert.equal(h.session.getState().presentation, 'ready');
  assert.equal(h.runs.length, 1);
});
test('new persistence diagnosis during execution confirmation cannot be cleared by an older matching configuration', options, async () => {
  // Arrange
  const h = await failed(), read = h.controlRead();
  const before = h.artwork.length;
  const operation = h.edit({ executable: '/synthetic/changed' });
  const snapshot = await read.entered.promise;

  // Act
  const diagnosing = h.session.persistenceFailed();
  read.gate.resolve(snapshot);
  await Promise.all([operation.finish(), diagnosing]);
  await h.session.appear(h.coordinator.getSettings()); await h.session.press();

  // Assert
  assert.equal(h.session.getState().persistenceBlocked, true);
  assert.equal(h.session.getState().presentation, 'error');
  assert.equal(h.session.getState().runRequested, false);
  assert.equal(h.artwork.slice(before).some(item => item.kind === 'ready'), false);
  assert.equal(h.errors.at(-1)[1], 'STATE_SAVE_FAILED');
  assert.equal(h.runs.length, 1);
  assert.deepEqual(h.host.writes, [snapshot]);
});
test('new genuine Start and its current error cannot be cleared by a stale execution-edit confirmation or late host echo', options, async () => {
  // Arrange
  const h = await failed('launch');
  h.transformReplies((result, value) => value ? result : { ...result, status: 'stale' });
  // Act
  const operation = h.edit({ executable: '/synthetic/changed' });
  await operation.finish();
  const olderStopped = structuredClone(h.host.settings);
  const waitingForConfirmedRecovery = h.session.getState();
  h.transformReplies(undefined);
  await h.session.press();
  const replacement = h.runs.at(-1);
  replacement.callbacks.onError('Image protocol error.'); replacement.done.resolve({ status: 'error', error: 'Image protocol error.' });
  await h.session.whenIdle();
  const lateEcho = h.coordinator.observe(olderStopped);
  h.runs[0].callbacks.onDiagnostic('PROCESS_EXITED_SUCCESSFULLY');
  h.runs[0].callbacks.onError('Program launch failed.');
  // Assert
  assert.equal(waitingForConfirmedRecovery.recoveryPending, true);
  assert.equal(waitingForConfirmedRecovery.presentation, 'error');
  assert.equal(lateEcho.accepted, false);
  assert.equal(h.runs.length, 2);
  assert.equal(h.session.getState().protocolBlocked, true);
  assert.equal(h.session.getState().presentation, 'error');
  assert.deepEqual(h.errors.at(-1), ['Image protocol error.', 'IMAGE_PROTOCOL_ERROR']);
  assert.equal(h.host.settings.runRequested, false);
});
