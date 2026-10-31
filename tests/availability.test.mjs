import test from 'node:test';
import assert from 'node:assert/strict';
import { createAvailabilityManager } from '../src/core/availability.mjs';
import { createActionSession } from '../src/core/action-session.mjs';
import { createRunStateCoordinator } from '../src/core/run-state.mjs';
import { equalJson } from '../src/core/settings-authority.mjs';

const options = { timeout: 1_000 };
const settings = { executable: '/program', args: [], runRequested: true };
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
function sessionHarness(overrides = {}) {
  const runs = [], saves = [], images = [], errors = [];
  let host = structuredClone(settings);
  const state = createRunStateCoordinator({
    async writeSettings(snapshot) { saves.push(snapshot); host = structuredClone(snapshot); },
    async readSettings() { return host; },
  });
  state.observe(settings);
  const session = createActionSession({
    async confirmLaunchSettings(expected) {
      await state.whenIdle();
      return !state.isBlocked() && equalJson(expected, state.getSettings());
    },
    startRun(input, callbacks) {
      const done = deferred(), stopEntered = deferred();
      const run = { input, callbacks, ...done, stopEntered, stops: 0, certain: true };
      runs.push(run);
      return { done: done.promise, async stop() { run.stops++; stopEntered.resolve(); return run.cleanup ? run.cleanup.promise : run.certain; } };
    },
    async setImage(image, current) { if (current()) images.push(image); },
    async setTitle() {}, onError: (message, code) => errors.push([message, code]),
    ...overrides,
  });
  return { session, runs, saves, images, errors };
}

// Session-local intent: a copied legacy flag is data, never availability authority.
for (const legacy of [true, false, 'missing']) {
  test(`fresh Stream legacy ${legacy} stays stopped through connect, wake and appearance`, options, async () => {
    // Arrange
    const e = eventHarness(), h = sessionHarness();
    const input = { executable: '/program', args: [] };
    if (legacy !== 'missing') input.runRequested = legacy;
    const original = structuredClone(input), device = { id: 'device', isConnected: false };
    await e.manager.track('key', { session: h.session, getDevice: () => device });

    // Act
    await h.session.appear(input);
    device.isConnected = true; e.emit('connect', device); e.emit('wake');
    await e.manager.whenIdle(); await h.session.appear(input); await h.session.reconcileAvailability();

    // Assert
    assert.deepEqual(h.runs, []);
    assert.equal(h.session.getState().runRequested, false);
    assert.equal(h.session.getState().phase, 'stopped');
    assert.deepEqual(h.saves, []);
    assert.deepEqual(input, original);
  });
}
function eventHarness() {
  const listeners = new Map(), registrations = [], disposals = [];
  const register = name => callback => {
    registrations.push(name); listeners.set(name, callback);
    return { dispose() { disposals.push(name); listeners.delete(name); } };
  };
  const manager = createAvailabilityManager({
    onDeviceDidConnect: register('connect'), onDeviceDidDisconnect: register('disconnect'), onSystemDidWakeUp: register('wake'),
  });
  return { manager, registrations, disposals, emit(name, device) { listeners.get(name)?.(name === 'wake' ? undefined : { device }); } };
}

test('startup and late key events cannot manufacture connectivity or visibility', options, async () => {
  // Arrange
  const h = sessionHarness();
  // Act
  await h.session.appear(settings);
  await h.session.press();
  const disconnectedState = h.session.getState();
  await h.session.disappear();
  await h.session.setConnected(true);
  await h.session.press();
  // Assert
  assert.equal(disconnectedState.connected, false);
  assert.equal(h.session.getState().visible, false);
  assert.deepEqual(h.runs, []);
  assert.deepEqual(h.saves, []);
});

test('manager registers three public hooks once and performs no background device polling', options, async () => {
  // Arrange
  const e = eventHarness(), h = sessionHarness();
  let reads = 0;
  const device = { id: 'device', isConnected: true };
  // Act
  await e.manager.track('key', { session: h.session, getDevice() { reads++; return device; } });
  await h.session.appear(settings);
  await h.session.press();
  const beforeIdle = reads;
  await e.manager.whenIdle(); await h.session.whenIdle();
  e.emit('connect', device); e.emit('connect', device);
  await e.manager.whenIdle();
  // Assert
  assert.deepEqual([...e.registrations].sort(), ['connect', 'disconnect', 'wake']);
  assert.equal(beforeIdle, 1);
  assert.equal(reads, 1);
  assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0].stops, 0);
});

test('visible disconnect pauses execution and reconnect resumes remembered Started once', options, async () => {
  // Arrange
  const e = eventHarness(), h = sessionHarness();
  const device = { id: 'device', isConnected: true };
  await e.manager.track('key', { session: h.session, getDevice: () => device });
  await h.session.appear(settings);
  await h.session.press();
  // Act
  device.isConnected = false; e.emit('disconnect', device);
  await e.manager.whenIdle();
  const paused = h.session.getState();
  device.isConnected = true; e.emit('connect', device); e.emit('connect', device);
  await e.manager.whenIdle();
  // Assert
  assert.equal(paused.visible, true);
  assert.equal(paused.runRequested, true);
  assert.equal(paused.connected, false);
  assert.equal(h.runs[0].stops, 1);
  assert.equal(h.runs.length, 2);
  assert.deepEqual(h.saves, []);
});

test('reconnect while hidden preserves Started but never launches until appearance', options, async () => {
  // Arrange
  const e = eventHarness(), h = sessionHarness();
  const device = { id: 'device', isConnected: true };
  await e.manager.track('key', { session: h.session, getDevice: () => device });
  await h.session.appear(settings);
  await h.session.press();
  // Act
  await h.session.disappear();
  device.isConnected = false; e.emit('disconnect', device); await e.manager.whenIdle();
  device.isConnected = true; e.emit('connect', device); e.emit('wake'); await e.manager.whenIdle();
  const before = h.runs.length;
  await h.session.appear(settings);
  // Assert
  assert.equal(before, 1);
  assert.equal(h.runs.length, 2);
  assert.equal(h.runs[0].stops, 1);
});

for (const order of ['wake-first', 'appearance-first']) {
  test(`${order} with duplicate wake/appearance does not restart a valid running generation`, options, async () => {
    // Arrange
    const e = eventHarness(), h = sessionHarness();
    const device = { id: 'device', isConnected: true };
    await e.manager.track('key', { session: h.session, getDevice: () => device });
    await h.session.appear(settings);
    await h.session.press();
    // Act
    if (order === 'wake-first') { e.emit('wake'); await e.manager.whenIdle(); await h.session.appear(settings); }
    else { await h.session.appear(settings); e.emit('wake'); await e.manager.whenIdle(); }
    e.emit('wake'); e.emit('wake'); await h.session.appear(settings);
    await e.manager.whenIdle();
    // Assert
    assert.equal(h.runs.length, 1);
    assert.equal(h.runs[0].stops, 0);
    assert.deepEqual(h.saves, []);
  });
}

for (const order of ['wake-first', 'appearance-first']) {
  test(`${order} after temporary hiding resumes only one generation`, options, async () => {
    // Arrange
    const e = eventHarness(), h = sessionHarness();
    const device = { id: 'device', isConnected: true };
    await e.manager.track('key', { session: h.session, getDevice: () => device });
    await h.session.appear(settings); await h.session.press(); await h.session.disappear();
    // Act
    if (order === 'wake-first') { e.emit('wake'); await e.manager.whenIdle(); await h.session.appear(settings); }
    else { await h.session.appear(settings); e.emit('wake'); await e.manager.whenIdle(); }
    e.emit('wake'); await e.manager.whenIdle();
    // Assert
    assert.equal(h.runs.length, 2);
    assert.equal(h.runs[0].stops, 1);
    assert.equal(h.runs[1].stops, 0);
  });
}

for (const terminal of ['manual', 'success', 'nonzero', 'signal', 'launch']) {
  test(`${terminal} Stopped intent never resumes from reconnect or wake`, options, async () => {
    // Arrange
    const e = eventHarness(), h = sessionHarness();
    const device = { id: 'device', isConnected: true };
    await e.manager.track('key', { session: h.session, getDevice: () => device });
    await h.session.appear(settings);
    await h.session.press();
    // Act
    if (terminal === 'manual') await h.session.press();
    else {
      const code = { success: 'PROCESS_EXITED_SUCCESSFULLY', nonzero: 'PROCESS_EXITED_NONZERO', signal: 'PROCESS_TERMINATED_BY_SIGNAL' }[terminal];
      if (code) h.runs[0].callbacks.onDiagnostic(code);
      h.runs[0].resolve(terminal === 'success' ? { status: 'success' } : { status: 'error', error: terminal === 'launch' ? 'Program launch failed.' : 'Program exited unsuccessfully.' });
      await h.session.whenIdle();
    }
    device.isConnected = false; e.emit('disconnect', device); await e.manager.whenIdle();
    device.isConnected = true; e.emit('connect', device); e.emit('wake'); await e.manager.whenIdle();
    await h.session.appear(settings);
    // Assert
    assert.equal(h.runs.length, 1);
    assert.equal(h.session.getState().runRequested, false);
    assert.deepEqual(h.saves, []);
  });
}

test('reconnect waits for outstanding process cleanup without overlapping generations', options, async () => {
  // Arrange
  const e = eventHarness(), h = sessionHarness();
  const device = { id: 'device', isConnected: true };
  await e.manager.track('key', { session: h.session, getDevice: () => device });
  await h.session.appear(settings);
  await h.session.press();
  const cleanup = deferred(); h.runs[0].cleanup = cleanup;
  // Act
  device.isConnected = false; e.emit('disconnect', device);
  await h.runs[0].stopEntered.promise;
  device.isConnected = true; e.emit('connect', device); e.emit('wake');
  const before = h.runs.length;
  cleanup.resolve(true); await e.manager.whenIdle(); await h.session.whenIdle();
  // Assert
  assert.equal(before, 1);
  assert.equal(h.runs.length, 2);
  assert.equal(h.runs[0].stops, 1);
});

for (const block of ['cleanup', 'persistence', 'protocol', 'settings']) {
  test(`${block} unhealthy state cannot be bypassed by availability events`, options, async () => {
    // Arrange
    const e = eventHarness(), h = sessionHarness();
    const device = { id: 'device', isConnected: true };
    await e.manager.track('key', { session: h.session, getDevice: () => device });
    await h.session.appear(block === 'settings' ? { ...settings, executable: 'relative' } : settings);
    if (block !== 'settings') await h.session.press();
    // Act
    if (block === 'cleanup') h.runs[0].certain = false;
    if (block === 'persistence') await h.session.persistenceFailed();
    if (block === 'protocol') {
      h.runs[0].callbacks.onError('Image protocol error.');
      h.runs[0].resolve({ status: 'error', error: 'Image protocol error.' });
      await h.session.whenIdle();
    }
    device.isConnected = false; e.emit('disconnect', device); await e.manager.whenIdle();
    const before = h.runs.length;
    device.isConnected = true; e.emit('connect', device); e.emit('wake'); await e.manager.whenIdle();
    // Assert
    assert.equal(h.runs.length, before);
    if (block !== 'settings') assert.equal(h.session.getState()[`${block}Blocked`], true);
    else assert.equal(before, 0);
  });
}

test('owning device events leave independent keys and devices untouched', options, async () => {
  // Arrange
  const e = eventHarness(), first = sessionHarness(), second = sessionHarness();
  const a = { id: 'a', isConnected: true }, b = { id: 'b', isConnected: true };
  await e.manager.track('first', { session: first.session, getDevice: () => a });
  await e.manager.track('second', { session: second.session, getDevice: () => b });
  await Promise.all([first.session.appear(settings), second.session.appear(settings)]);
  await Promise.all([first.session.press(), second.session.press()]);
  // Act
  a.isConnected = false; e.emit('disconnect', a); await e.manager.whenIdle();
  e.emit('disconnect', { id: 'unknown', isConnected: false }); await e.manager.whenIdle();
  // Assert
  assert.equal(first.runs[0].stops, 1);
  assert.equal(second.runs[0].stops, 0);
  assert.equal(second.session.getState().connected, true);
  assert.deepEqual(second.saves, []);
});

for (const device of [undefined, {}, { id: '', isConnected: true }, { id: 'unknown', isConnected: 'true' }, { id: 'virtual', type: 'virtual', isConnected: false }]) {
  test(`unknown/unavailable device fails closed (${JSON.stringify(device)})`, options, async () => {
    // Arrange
    const e = eventHarness(), h = sessionHarness();
    // Act
    await e.manager.track('key', { session: h.session, getDevice: () => device });
    await h.session.appear(settings); e.emit('wake'); await e.manager.whenIdle();
    // Assert
    assert.deepEqual(h.runs, []);
    assert.equal(h.session.getState().connected, false);
  });
}

test('throwing device reader fails closed and virtual connected devices use ordinary connectivity rule', options, async () => {
  // Arrange
  const e = eventHarness(), unavailable = sessionHarness(), virtual = sessionHarness();
  // Act
  await e.manager.track('bad', { session: unavailable.session, getDevice() { throw new Error('private'); } });
  await e.manager.track('virtual', { session: virtual.session, getDevice: () => ({ id: 'virtual', type: 'virtual', isConnected: true }) });
  await Promise.all([unavailable.session.appear(settings), virtual.session.appear(settings)]);
  await virtual.session.press();
  // Assert
  assert.deepEqual(unavailable.runs, []);
  assert.equal(virtual.runs.length, 1);
});

test('explicit reconciliation refreshes current owning device without changing visibility', options, async () => {
  // Arrange
  const e = eventHarness(), h = sessionHarness();
  let device = { id: 'old', isConnected: true };
  await e.manager.track('key', { session: h.session, getDevice: () => device });
  await h.session.appear(settings);
  await h.session.press();
  // Act
  device = { id: 'new', isConnected: true }; await e.manager.reconcile();
  e.emit('disconnect', { id: 'old', isConnected: false }); await e.manager.whenIdle();
  const before = h.runs[0].stops;
  device.isConnected = false; e.emit('disconnect', device); await e.manager.whenIdle();
  // Assert
  assert.equal(before, 0);
  assert.equal(h.runs[0].stops, 1);
  assert.equal(h.session.getState().visible, true);
});

test('listener-only disposal is idempotent and does not imply OS/process shutdown', options, async () => {
  // Arrange
  const e = eventHarness(), h = sessionHarness();
  const device = { id: 'device', isConnected: true };
  await e.manager.track('key', { session: h.session, getDevice: () => device });
  await h.session.appear(settings);
  await h.session.press();
  // Act
  e.manager.dispose(); e.manager.dispose();
  e.emit('disconnect', { ...device, isConnected: false }); e.emit('wake');
  await e.manager.reconcile(); await e.manager.whenIdle();
  // Assert
  assert.deepEqual([...e.disposals].sort(), ['connect', 'disconnect', 'wake']);
  assert.equal(h.runs[0].stops, 0);
  assert.deepEqual(h.saves, []);
});
