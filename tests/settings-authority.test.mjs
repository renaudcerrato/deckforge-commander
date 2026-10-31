import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAdapterCode, createAdapterLoader } from './helpers/adapter-harness.mjs';
import { createRunStateCoordinator } from '../src/core/run-state.mjs';
import { createActionSession } from '../src/core/action-session.mjs';

const options = { timeout: 3000 };
const initial = { executable: '/synthetic/program', args: ['legacy', ''], runRequested: false, extra: { nested: ['retained'] } };
// Coordinator copy/preservation fixtures intentionally retain unknown JSON;
// launch fixtures must instead satisfy the execution settings allowlist.
const executionInitial = { executable: '/synthetic/program', args: ['legacy', ''], runRequested: false };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
// Count host traffic, retaining only the latest snapshot and live timer handles.
function storage(overrides = {}) {
  const host = { value: undefined, writes: 0, reads: 0, failures: 0 }, timers = new Map();
  let timerId = 0;
  const state = createRunStateCoordinator({
    async writeSettings(value) { host.writes++; host.value = structuredClone(value); },
    async readSettings() { host.reads++; return structuredClone(host.value); },
    onFailure() { host.failures++; },
    setTimer(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimer(id) { timers.delete(id); }, ...overrides,
  });
  return { state, host, timers, expire() { for (const [id, timer] of [...timers]) { timers.delete(id); timer.callback(); } } };
}

test('first safe initialization is detached and confirmed without writing even invalid execution metadata', options, async () => {
  // Arrange
  const h = storage(), input = { ...structuredClone(initial), executable: 'synthetic-relative', themeColor: '#abcdef', unknown: { restored: true } };
  const expected = structuredClone(input);
  // Act
  const result = h.state.observe(input);
  input.extra.nested.push('caller mutation'); result.settings.unknown.restored = false;
  const confirm = await h.state.editConfiguration({ themeColor: '#abcdef' });
  // Assert
  assert.equal(result.accepted, true);
  assert.equal(result.revision, 1);
  assert.deepEqual(h.state.getSettings(), expected);
  assert.equal(confirm.status, 'saved');
  assert.deepEqual([h.host.writes, h.host.reads], [0, 0]);
});

test('initialized live authority ignores restores while fresh coordinator accepts them without writes', () => {
  // Arrange
  const live = storage(), fresh = storage();
  live.state.observe(initial);
  const restored = { ...initial, executable: '/synthetic/restored', runRequested: true };
  // Act
  const rejected = live.state.observe(restored), adopted = fresh.state.observe(restored);
  // Assert
  assert.equal(rejected.accepted, false);
  assert.equal(adopted.accepted, true);
  assert.deepEqual(live.state.getSettings(), initial);
  assert.deepEqual(fresh.state.getSettings(), restored);
  assert.deepEqual([live.host.writes, fresh.host.writes], [0, 0]);
});

for (const local of ['theme', 'configuration']) {
  test(`first local ${local} initializes immediately and cannot be overwritten before write/readback settles`, options, async () => {
    // Arrange
    const entered = deferred(), read = deferred();
    const h = storage({ async readSettings() { entered.resolve(); return read.promise; } });
    // Act
    const saving = h.state.editConfiguration(local === 'theme' ? { themeColor: '#abcdef' } : { executable: '/synthetic/local' });
    const expected = h.state.getSettings(), revision = h.state.getRevision();
    const beforeWrite = h.state.observe(initial);
    await entered.promise;
    const pending = h.state.observe({ ...initial, executable: '/synthetic/restored' });
    read.resolve(h.host.value); const result = await saving;
    const after = h.state.observe(initial);
    // Assert
    assert.ok([beforeWrite, pending, after].every(observation => observation.accepted === false && observation.revision === revision));
    assert.deepEqual(h.state.getSettings(), expected);
    assert.equal(result.status, 'saved');
    assert.equal(h.host.writes, 1);
    assert.equal(h.timers.size, 0);
  });
}

test('1000 Start/Stop pairs plus 1000 unique edits retain local authority against ancient and unseen host observations', options, async () => {
  // Arrange
  const h = storage(); h.state.observe(executionInitial);
  const live = createActionSession({ initialConnected: true,
    async confirmLaunchSettings() { await h.state.whenIdle(); return !h.state.isBlocked(); },
    startRun() { return { done: new Promise(() => {}), async stop() { return true; } }; },
    async setImage() {}, async setTitle() {}, onError() {},
  });
  await live.appear(executionInitial);
  let oldStarted, oldConfiguration;
  // Act
  for (let index = 0; index < 1000; index++) {
    await live.press();
    if (index === 0) oldStarted = { ...h.state.getSettings(), runRequested: true };
    await live.press();
  }
  for (let index = 0; index < 1000; index++) {
    const edit = await h.state.editConfiguration({ argsText: `unique-${index}` });
    if (index === 0) oldConfiguration = structuredClone(edit.settings);
  }
  const expected = h.state.getSettings(), revision = h.state.getRevision(), writes = h.host.writes;
  const rejected = [initial, oldStarted, oldConfiguration, expected, { ...initial, executable: '/synthetic/unseen' }].map(snapshot => h.state.observe(snapshot));
  const alreadyConfirmed = await h.state.editConfiguration({ argsText: expected.argsText });
  let launches = 0;
  const session = createActionSession({ initialConnected: true,
    startRun() { launches++; return { done: new Promise(() => {}), async stop() { return true; } }; }, async setImage() {}, async setTitle() {}, onError() {},
  });
  await session.appear(h.state.getSettings());
  for (const snapshot of [oldStarted, oldConfiguration]) {
    const observation = h.state.observe(snapshot);
    if (observation.accepted) await session.applySettings(observation.settings);
  }
  await session.whenIdle();
  // Assert: behavioral stress only, not a heap/GC or private-history proof.
  assert.equal(writes, 1000);
  assert.equal(live.getState().runRequested, false);
  assert.equal(h.host.writes, writes);
  assert.equal(h.host.reads, writes);
  assert.ok(rejected.every(result => result.accepted === false && result.revision === revision));
  assert.deepEqual(h.state.getSettings(), expected);
  assert.equal(expected.argsText, 'unique-999');
  assert.equal(expected.runRequested, false);
  assert.equal(alreadyConfirmed.status, 'saved');
  assert.equal(h.state.getRevision(), revision);
  assert.deepEqual([h.host.failures, h.timers.size], [0, 0]);
  assert.equal(launches, 0);
  assert.equal(session.getState().runRequested, false);
});

for (const input of [{}, { executable: 'synthetic-relative', args: 'malformed' }, initial]) {
  test('plugin theme edits remain authoritative without inventing arguments/intent or repairing stored execution', options, async () => {
    // Arrange
    const h = storage(); h.state.observe(input);
    const expected = { ...structuredClone(input), themeColor: '#abcdef' };
    // Act
    const result = await h.state.editConfiguration({ themeColor: '#ABCDEF' });
    const revision = h.state.getRevision(), writes = h.host.writes;
    const ignored = h.state.observe({ executable: '/synthetic/restore', argsText: '', runRequested: true });
    const invalid = await h.state.editConfiguration({ themeColor: 'synthetic-invalid' }).catch(error => error);
    // Assert
    assert.equal(result.status, 'saved');
    assert.equal(ignored.accepted, false);
    assert.equal(invalid.diagnosticCode, 'THEME_COLOR_INVALID');
    assert.deepEqual(h.state.getSettings(), expected);
    assert.equal(h.state.getRevision(), revision);
    assert.equal(h.host.writes, writes);
    assert.equal(h.state.isBlocked(), false);
  });
}

for (const label of ['getter', 'proxy', 'cycle']) {
  test(`unsafe ${label} host data is safely rejected even after authority initializes`, () => {
    // Arrange
    const h = storage(); h.state.observe(initial);
    let reads = 0, failure;
    const input = label === 'getter' ? { get executable() { reads++; throw new Error('synthetic-sensitive'); } }
      : label === 'proxy' ? new Proxy({}, { ownKeys() { throw new Error('synthetic-sensitive'); } }) : {};
    if (label === 'cycle') input.self = input;
    // Act
    try { h.state.observe(input); } catch (error) { failure = error; }
    // Assert
    assert.equal(failure?.message, 'Invalid settings.');
    assert.equal(failure?.diagnosticCode, 'INVALID_SETTINGS');
    assert.equal(JSON.stringify(failure).includes('synthetic-sensitive'), false);
    assert.equal(reads, 0);
    assert.deepEqual(h.state.getSettings(), initial);
    assert.equal(h.host.writes, 0);
  });
}

test('ignored host cache changes cannot masquerade as matching readback and unblock a failed save', options, async () => {
  // Arrange
  const read = deferred(), entered = deferred();
  const h = storage({ async readSettings() { entered.resolve(); return read.promise; } });
  h.state.observe(initial);
  // Act
  const saving = h.state.editConfiguration({ argsText: 'changed' }).catch(error => error);
  await entered.promise;
  const observation = h.state.observe({ ...initial, executable: '/synthetic/host-change' });
  read.resolve(initial);
  const failure = await saving;
  const revision = h.state.getRevision(), snapshot = h.state.getSettings();
  const late = h.state.observe({ ...initial, runRequested: true });
  const again = await h.state.editConfiguration({ argsText: 'newer' }).catch(error => error);
  // Assert
  assert.equal(observation.accepted, false);
  assert.equal(late.accepted, false);
  assert.equal(failure.diagnosticCode, 'STATE_SAVE_FAILED');
  assert.equal(again.diagnosticCode, 'STATE_SAVE_FAILED');
  assert.equal(h.state.isBlocked(), true);
  assert.deepEqual(h.state.getSettings(), snapshot);
  assert.equal(h.state.getRevision(), revision);
  assert.equal(h.host.writes, 1);
});

for (const loss of ['hide', 'disconnect', 'execution-edit']) {
  test(`pending Started then ${loss} keeps local intent and cannot be revived by old host True`, options, async () => {
    // Arrange
    const entered = deferred(), read = deferred(), runs = [];
    let confirmations = 0;
    const h = storage();
    h.state.observe(executionInitial);
    const session = createActionSession({ initialConnected: true,
      async confirmLaunchSettings(snapshot) {
        await h.state.whenIdle();
        if (++confirmations === 1) { entered.resolve(); await read.promise; }
        return !h.state.isBlocked();
      },
      startRun(input) { runs.push(input); return { done: new Promise(() => {}), async stop() { return true; } }; },
      async setImage() {}, async setTitle() {}, onError() {},
    });
    await session.appear(h.state.getSettings());
    // Act
    const start = session.press(); await entered.promise;
    let edit, transition;
    if (loss === 'execution-edit') { edit = h.state.editConfiguration({ argsText: 'replacement' }); transition = session.applySettings(h.state.getSettings()); }
    else { transition = session.press(); if (loss === 'hide') void session.disappear(); else void session.setConnected(false); }
    const expected = h.state.getSettings(), revision = h.state.getRevision();
    const stale = h.state.observe({ ...executionInitial, runRequested: true });
    read.resolve({ ...executionInitial, runRequested: true });
    await Promise.all([start, transition, edit]); await session.whenIdle();
    const late = h.state.observe({ ...executionInitial, runRequested: true });
    // Assert
    assert.equal(stale.accepted, false); assert.equal(late.accepted, false);
    assert.deepEqual(h.state.getSettings(), expected);
    assert.equal(h.state.getRevision(), revision);
    assert.equal(h.state.getSettings().runRequested, false);
    assert.equal(session.getState().runRequested, false);
    assert.deepEqual(runs, []);
  });
}

// Authorized in-memory adapter seam: SDK/process/storage are doubles; project
// coordinators, availability and lifecycle modules remain real. No plugin startup.
const adapterCodes = await loadAdapterCode(['run', 'program-runtime']);
const helperNames = ['action-session', 'availability', 'error-artwork', 'execution-paths', 'launch-artwork', 'launch-environment', 'run-state', 'settings', 'settings-authority', 'theme'];
const helpers = new Map(await Promise.all(helperNames.map(async name => [`../core/${name}.mjs`, await import(`../src/core/${name}.mjs`)])));
function adapter({ firstStopGate } = {}) {
  const launches = [], replies = [], listeners = new Map();
  const sdk = { info: { plugin: { uuid: 'synthetic', version: '0.1' }, application: { version: '7.6', language: 'en', platform: 'mac', platformVersion: '26' } }, logger: { info() {}, warn() {} }, ui: { async sendToPropertyInspector(value) { replies.push(value); } } };
  const sdkModule = { default: sdk, SingletonAction: class {}, action: () => value => value };
  const syntheticProcess = { env: {}, cwd: () => '/synthetic/cwd' };
  const isolatedRequire = createAdapterLoader(adapterCodes, { process: syntheticProcess, resolve(name) {
    if (name === '@elgato/streamdeck') return sdkModule;
    if (name === '../core/process-runner.mjs') return { startProcessRun(input) {
      const done = deferred(), stopEntered = deferred();
      const stopGate = launches.length === 0 ? firstStopGate : undefined;
      const launch = { input, stops: 0, stopEntered: stopEntered.promise };
      launches.push(launch);
      return { done: done.promise, async stop() {
        launch.stops++; stopEntered.resolve();
        if (stopGate) await stopGate.promise;
        done.resolve({ status: 'stopped' }); return true;
      } };
    } };
    if (helpers.has(name)) return helpers.get(name);
    throw new Error('Unexpected synthetic dependency');
  } });
  const exports = isolatedRequire('./run');
  const register = name => listener => { listeners.set(name, listener); return { dispose() {} }; };
  const action = new exports.RunAction({ onDeviceDidConnect: register('connect'), onDeviceDidDisconnect: register('disconnect'), onSystemDidWakeUp: register('wake') });
  return { action, launches, replies, emit(name, device) { listeners.get(name)({ device }); } };
}
function runtime(id = 'synthetic-key', input = executionInitial, host = { value: structuredClone(input), writes: 0, reads: 0, images: [], footers: [], titles: [] }) {
  const action = { id, manifestId: 'synthetic-action', isKey: () => true, coordinates: { column: 0, row: 0 }, device: { id: 'synthetic-device', name: 'synthetic', type: 0, size: { columns: 1, rows: 1 }, isConnected: true },
    async getSettings() { host.reads++; return structuredClone(host.value); }, async setSettings(value) { host.writes++; host.value = structuredClone(value); },
    async setImage(image) {
      host.images.push(image);
      const svg = decodeURIComponent(image.slice('data:image/svg+xml,'.length));
      host.footers.push(svg.match(/<text\b[^>]*\by="124"[^>]*>([^<]*)<\/text>/)?.[1]);
    }, async setTitle(title) { host.titles.push(title); },
  };
  return { action, host };
}

// Copy/restart regression: exercise actual per-key adapter ownership, not a mocked intent store.
for (const legacy of [true, false, 'missing']) {
  test(`actual Stream copy with legacy ${legacy} starts independently and never disturbs the original`, options, async () => {
    // Arrange
    const input = { executable: '/synthetic/program', args: ['legacy', ''] };
    if (legacy !== 'missing') input.runRequested = legacy;
    const h = adapter(), original = runtime('original', input);
    const event = r => ({ action: r.action, payload: { settings: structuredClone(r.host.value) } });
    await h.action.onWillAppear(event(original));
    await h.action.onKeyDown(event(original));
    const originalImages = [...original.host.images], saved = structuredClone(original.host.value);
    const copy = runtime('copy', saved);

    // Act
    await h.action.onWillAppear(event(copy));
    const beforeCopyPress = { launches: h.launches.length, stops: h.launches[0].stops };
    await h.action.onKeyDown(event(copy));
    await h.action.onKeyDown(event(copy));
    await h.action.onWillAppear(event(copy));

    // Assert
    assert.deepEqual(beforeCopyPress, { launches: 1, stops: 0 });
    assert.deepEqual(h.launches.map(launch => launch.stops), [0, 1]);
    assert.deepEqual(original.host.images, originalImages);
    assert.deepEqual(original.host.value, saved);
    assert.deepEqual(copy.host.value, saved);
    assert.deepEqual([original.host.writes, copy.host.writes], [0, 0]);
    assert.equal(Object.hasOwn(copy.host.value, 'runRequested'), legacy !== 'missing');
    await h.action.onWillDisappear(event(original));
    await h.action.onWillDisappear(event(copy));
  });

  test(`actual fresh Stream adapter reusing the same action ID ignores legacy ${legacy} and prior live intent`, options, async () => {
    // Arrange
    const input = { executable: '/synthetic/program', args: ['legacy', ''] };
    if (legacy !== 'missing') input.runRequested = legacy;
    const live = adapter(), original = runtime('same-context', input);
    const event = r => ({ action: r.action, payload: { settings: structuredClone(r.host.value) } });
    await live.action.onWillAppear(event(original));
    await live.action.onKeyDown(event(original));
    const fresh = adapter(), restored = runtime('same-context', original.host.value);

    // Act
    await fresh.action.onWillAppear(event(restored));
    fresh.emit('connect', restored.action.device); fresh.emit('wake', restored.action.device);
    await fresh.action.onWillAppear(event(restored));
    const beforePress = fresh.launches.length;
    await fresh.action.onKeyDown(event(restored));

    // Assert
    assert.equal(beforePress, 0);
    assert.equal(fresh.launches.length, 1);
    assert.equal(live.launches[0].stops, 0);
    assert.deepEqual(restored.host.value, input);
    assert.deepEqual([original.host.writes, restored.host.writes], [0, 0]);
    await live.action.onWillDisappear(event(original));
    await fresh.action.onWillDisappear(event(restored));
  });
}

test('actual adapter ignores initialized settings events and appearance restores; key launch uses local authority', options, async () => {
  // Arrange
  const h = adapter(), r = runtime();
  await h.action.onWillAppear({ action: r.action, payload: { settings: executionInitial } });
  const restore = { ...executionInitial, executable: '/synthetic/external', runRequested: true };
  // Act
  await h.action.onDidReceiveSettings({ action: r.action, payload: { settings: restore } });
  await h.action.onWillAppear({ action: r.action, payload: { settings: restore } });
  const beforePress = [h.launches.length, r.host.writes];
  await h.action.onKeyDown({ action: r.action, payload: { settings: restore } });
  await h.action.onKeyDown({ action: r.action, payload: { settings: restore } });
  // Assert
  assert.deepEqual(beforePress, [0, 0]);
  assert.equal(h.launches.length, 1);
  assert.equal(h.launches[0].input.executable, executionInitial.executable);
  assert.equal(h.launches[0].stops, 1);
  assert.equal(r.host.value.runRequested, false);
  assert.equal(r.host.value.executable, executionInitial.executable);
});

test('actual adapter adopts external restore only in a fresh instance and keeps independent keys isolated', options, async () => {
  // Arrange
  const live = adapter(), fresh = adapter(), original = runtime('first'), other = runtime('second');
  await live.action.onWillAppear({ action: original.action, payload: { settings: executionInitial } });
  await live.action.onWillAppear({ action: other.action, payload: { settings: executionInitial } });
  const restore = { ...executionInitial, executable: '/synthetic/restored', runRequested: true };
  const restored = runtime('restored', restore);
  // Act
  await live.action.onDidReceiveSettings({ action: original.action, payload: { settings: restore } });
  await fresh.action.onWillAppear({ action: restored.action, payload: { settings: restore } });
  await fresh.action.onKeyDown({ action: restored.action, payload: { settings: restore } });
  // Assert
  assert.deepEqual(live.launches, []);
  assert.equal(original.host.writes, 0); assert.equal(other.host.writes, 0);
  assert.equal(fresh.launches.length, 1);
  assert.equal(fresh.launches[0].input.executable, restore.executable);
  assert.equal(fresh.launches[0].stops, 0);
});

for (const started of ['legacy-true', 'legacy-false']) {
  test(`actual Stream adapter resumes ${started} Started once after settled hide without image or title handoffs`, options, async t => {
    // Arrange: inspect actual SVG handoffs, not waiting's internal ready-footer metadata.
    const input = { ...executionInitial, runRequested: started === 'legacy-true' };
    const h = adapter(), r = runtime('synthetic-key', input);
    const event = () => ({ action: r.action, payload: { settings: structuredClone(r.host.value) } });
    t.after(() => h.action.onWillDisappear(event()));
    await h.action.onWillAppear(event());
    await h.action.onKeyDown(event());
    assert.equal(h.launches.length, 1);
    const saved = structuredClone(r.host.value), traffic = [r.host.writes, r.host.reads];
    const beforeHide = r.host.images.length;
    const titleIndex = r.host.titles.length;

    // Act: allow cleanup to settle before returning to the same page.
    await h.action.onWillDisappear(event());
    const hidden = { stops: h.launches[0].stops, children: h.launches.length,
      images: r.host.images.length, settings: structuredClone(r.host.value) };
    const resumeIndex = r.host.footers.length;
    await h.action.onWillAppear(event());
    await h.action.onWillAppear(event());

    // Assert: hide preserves Started; repeated appearance never duplicates the replacement.
    assert.deepEqual(hidden, { stops: 1, children: 1, images: beforeHide, settings: saved });
    assert.equal(saved.runRequested, started === 'legacy-true');
    assert.deepEqual(h.launches.map(launch => launch.stops), [1, 0]);
    assert.deepEqual(r.host.images.slice(resumeIndex), []);
    assert.deepEqual(r.host.footers.slice(resumeIndex), []);
    assert.deepEqual(r.host.titles.slice(titleIndex), []);
    assert.deepEqual(r.host.value, saved);
    assert.deepEqual([r.host.writes, r.host.reads], traffic);
    assert.equal(traffic[0], 0);
  });

  test(`actual Stream adapter fast return with ${started} Started waits for old cleanup without image or title handoffs`, options, async t => {
    // Arrange: only the first fake child's cleanup is held at a deterministic boundary.
    const firstStopGate = deferred(), h = adapter({ firstStopGate });
    const input = { ...executionInitial, runRequested: started === 'legacy-true' };
    const r = runtime('synthetic-key', input);
    const event = () => ({ action: r.action, payload: { settings: structuredClone(r.host.value) } });
    let hiding, returning;
    t.after(async () => {
      firstStopGate.resolve();
      await Promise.all([hiding, returning]);
      await h.action.onWillDisappear(event());
    });
    await h.action.onWillAppear(event());
    await h.action.onKeyDown(event());
    assert.equal(h.launches.length, 1);
    const saved = structuredClone(r.host.value), traffic = [r.host.writes, r.host.reads];
    const titleIndex = r.host.titles.length;

    // Act: return while ownership cleanup is still pending; then release certain cleanup.
    hiding = h.action.onWillDisappear(event());
    await h.launches[0].stopEntered;
    const resumeIndex = r.host.footers.length;
    returning = h.action.onWillAppear(event());
    const pending = { children: h.launches.length, stops: h.launches[0].stops,
      footers: r.host.footers.slice(resumeIndex), settings: structuredClone(r.host.value),
      traffic: [r.host.writes, r.host.reads] };
    firstStopGate.resolve();
    await Promise.all([hiding, returning]);
    await h.action.onWillAppear(event());

    // Assert: no replacement before cleanup, no interim host handoffs, no saves on page changes.
    assert.deepEqual(pending, { children: 1, stops: 1, footers: [], settings: saved, traffic });
    assert.equal(saved.runRequested, started === 'legacy-true');
    assert.deepEqual(h.launches.map(launch => launch.stops), [1, 0]);
    assert.deepEqual(r.host.images.slice(resumeIndex), []);
    assert.deepEqual(r.host.footers.slice(resumeIndex), []);
    assert.deepEqual(r.host.titles.slice(titleIndex), []);
    assert.deepEqual(r.host.value, saved);
    assert.deepEqual([r.host.writes, r.host.reads], traffic);
    assert.equal(traffic[0], 0);
  });
}

test('actual Stream adapter idle page return legitimately sends Ready without launching or saving', options, async () => {
  // Arrange: Stopped is the negative control for the Started-only no-Ready contract.
  const h = adapter(), r = runtime();
  const event = { action: r.action, payload: { settings: executionInitial } };
  await h.action.onWillAppear(event);
  const resumeIndex = r.host.footers.length;

  // Act
  await h.action.onWillDisappear(event);
  await h.action.onWillAppear(event);

  // Assert
  assert.deepEqual(r.host.footers.slice(0, resumeIndex), ['ready']);
  assert.deepEqual(r.host.footers.slice(resumeIndex), ['ready']);
  assert.deepEqual(h.launches, []);
  assert.deepEqual([r.host.writes, r.host.reads], [0, 0]);
  assert.deepEqual(r.host.value, executionInitial);
});

for (const availabilityEvent of ['connect', 'wake']) {
  test(`actual Stream adapter ${availabilityEvent} resumes silently after disconnect only when cleanup is certain`, options, async t => {
    // Arrange: drive the real availability manager through mocked SDK registrations.
    const firstStopGate = deferred(), h = adapter({ firstStopGate });
    const input = { ...executionInitial, runRequested: true }, r = runtime('synthetic-key', input);
    const event = { action: r.action, payload: { settings: input } };
    let returning;
    t.after(async () => {
      firstStopGate.resolve(); await returning;
      await h.action.onWillDisappear(event);
    });
    await h.action.onWillAppear(event);
    await h.action.onKeyDown(event);
    const before = { images: [...r.host.images], titles: [...r.host.titles] };

    // Act: the registry callback can finish asynchronously; join it through the public appearance event.
    r.action.device.isConnected = false;
    h.emit('disconnect', r.action.device); await h.launches[0].stopEntered;
    r.action.device.isConnected = true;
    h.emit(availabilityEvent, r.action.device);
    h.emit(availabilityEvent, r.action.device);
    returning = h.action.onWillAppear(event);
    const pending = h.launches.length;
    firstStopGate.resolve(); await returning;
    await h.action.onWillAppear(event);

    // Assert: wake and repeated reconnect reconciliation add no interim title/image or settings traffic.
    assert.equal(pending, 1);
    assert.deepEqual(h.launches.map(launch => launch.stops), [1, 0]);
    assert.deepEqual({ images: r.host.images, titles: r.host.titles }, before);
    assert.deepEqual(r.host.footers, ['ready', 'loading...']);
    assert.deepEqual(r.host.value, input);
    assert.deepEqual([r.host.writes, r.host.reads], [0, 0]);
  });
}

test('move-integrity Stream fast unchanged wrapper return preserves intent but changed owner starts stopped', options, async t => {
  // Arrange: distinct wrappers still target one synthetic host slot.
  const firstStopGate = deferred(), h = adapter({ firstStopGate });
  const a = { ...executionInitial, title: 'A' }, b = { ...executionInitial, title: 'B' };
  const r = runtime('move-fast-stream', a), event = (wrapper, settings = wrapper.host.value) => ({ action: wrapper.action, payload: { settings } });
  let hiding, returning;
  t.after(async () => { firstStopGate.resolve(); await Promise.all([hiding, returning]); await h.action.onWillDisappear(event(r)); });
  await h.action.onWillAppear(event(r)); await h.action.onKeyDown(event(r));
  // Act: unchanged hide/show while cleanup is held remains the same session.
  hiding = h.action.onWillDisappear(event(runtime(r.action.id, a, r.host)));
  await h.launches[0].stopEntered;
  returning = h.action.onWillAppear(event(runtime(r.action.id, a, r.host)));
  const pending = h.launches.length;
  firstStopGate.resolve(); await Promise.all([hiding, returning]);
  const unchanged = h.launches.length;
  await h.action.onWillDisappear(event(runtime(r.action.id, a, r.host)));
  r.host.value = structuredClone(b);
  await h.action.onWillAppear(event(runtime(r.action.id, b, r.host)));
  // Assert: a title-only complete-JSON difference is sufficient; no inherited Started.
  assert.equal(pending, 1); assert.equal(unchanged, 2);
  assert.equal(h.launches.length, 2);
  assert.deepEqual(r.host.footers.slice(-1), ['ready']);
  assert.deepEqual([r.host.writes, r.host.reads], [0, 0]); assert.deepEqual(r.host.value, b);
});
