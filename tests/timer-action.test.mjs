import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadAdapterCode, createAdapterLoader } from './helpers/adapter-harness.mjs';
import { parseOutputUpdate } from '../src/core/output-update.mjs';
import { createPrimitiveArtwork } from '../src/core/primitive-artwork.mjs';
import { createErrorArtwork } from '../src/core/error-artwork.mjs';
import { TIMER_HOLD_MS } from '../src/core/timer-session.mjs';

const options = { timeout: 3000 };
const TIMER_UUID = 'git.renaudcerrato.deckforge.loop';
const RUN_UUID = 'git.renaudcerrato.deckforge.stream';
const base = { executable: '/synthetic/program.sh', argsText: '', intervalSeconds: 5 };
const ordinaryError = 'Program exited unsuccessfully.';
const svg = image => decodeURIComponent(image.slice('data:image/svg+xml,'.length));
const images = runtime => runtime.display.filter(([kind]) => kind === 'image').map(([, image]) => image);

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Core time advances independently of callback delivery. The real storage
// authority retains its own bounded wall-clock timeout; these tests never wait it out.
function clock() {
  let time = 0, id = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimer(callback, delay) { const key = ++id; timers.set(key, { callback, due: time + delay }); return key; },
    clearTimer(key) { timers.delete(key); },
    advance(ms, deliver = true) {
      time += ms;
      if (!deliver) return;
      const ready = [...timers].filter(([, timer]) => timer.due <= time).sort((a, b) => a[1].due - b[1].due);
      for (const [key, timer] of ready) {
        if (!timers.has(key)) continue;
        timers.delete(key); timer.callback();
      }
    },
  };
}

// Reuse the existing launch-environment harness technique, not its fixture model.
// Transpile only actual adapter modules in memory, never execute plugin.ts or SDK startup.
const adapterCodes = await loadAdapterCode(['timer', 'run']);

function runtime(id = 'synthetic-timer-key', initial = base, manifestId = TIMER_UUID) {
  let stored = structuredClone(initial);
  const display = [], writes = [];
  return {
    id, manifestId, display, writes,
    device: { id: 'synthetic-device', name: 'Fictional Deck', type: 999, size: { columns: 0, rows: 3 }, isConnected: true },
    coordinates: { column: 0, row: 2 }, isKey: () => true,
    async setSettings(next) { writes.push(structuredClone(next)); stored = structuredClone(next); },
    async getSettings() { return structuredClone(stored); },
    async setImage(image) { display.push(['image', image]); },
    async setTitle(title) { display.push(['title', title]); },
  };
}

// Old/new SDK wrappers route to this same context-keyed synthetic host storage.
function slotWrapper(r, settings) {
  const next = { ...r };
  const read = async () => structuredClone(settings);
  r.getSettings = next.getSettings = read;
  return next;
}

function harness(t) {
  const time = clock(), launches = [], sessions = [], states = [], managers = [], logs = [], replies = [];
  const registrations = [], listeners = new Map(), decorated = new Map(), tracked = [];
  const sdk = {
    info: { plugin: { uuid: 'git.renaudcerrato.deckforge', version: '0.1.0.0' },
      application: { version: '7.6', language: 'fr', platform: 'mac', platformVersion: '26' } },
    logger: { info(value) { logs.push(value); }, warn(value) { logs.push(value); } },
    ui: { async sendToPropertyInspector(payload) { replies.push(structuredClone(payload)); } },
  };
  const sdkModule = { default: sdk, SingletonAction: class {},
    action: metadata => value => { decorated.set(value, metadata.UUID); return value; } };
  const register = name => listener => {
    registrations.push(name);
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(listener);
    return { dispose() { listeners.get(name).delete(listener); } };
  };
  const registry = { onDeviceDidConnect: register('connect'), onDeviceDidDisconnect: register('disconnect'), onSystemDidWakeUp: register('wake') };
  const runner = { startProcessRun(settings, callbacks, dependencies, { env }) {
    const done = deferred(), stopEntered = deferred();
    const launch = { settings: structuredClone(settings), env: { ...env }, callbacks, done, stopEntered,
      stops: 0, certain: true, stopGate: undefined };
    launches.push(launch);
    callbacks.onDiagnostic('PROCESS_SPAWN_SUCCEEDED');
    return { done: done.promise, async stop() {
      launch.stops++; stopEntered.resolve();
      const certain = launch.stopGate ? await launch.stopGate.promise : launch.certain;
      done.resolve({ status: 'stopped' });
      return certain;
    } };
  } };
  // Never inherit, log or print the user's process environment.
  const syntheticProcess = { env: { PATH: '/synthetic/path', ELGATO_KEY_COLUMN: 'STALE_SYNTHETIC',
    ELGATO_DEVICE_NAME: 'STALE_SYNTHETIC', ELGATO_ACTION_THEME_COLOR: 'STALE_SYNTHETIC', PRIVATE_ENV: 'SYNTHETIC_PRIVATE_ENV' }, cwd: () => '/synthetic/cwd', platform: 'darwin' };
  const capture = (module, factory, collection) => ({ ...module, [factory](dependencies) {
    const actual = module[factory](dependencies); collection.push(actual); return actual;
  } });
  const isolatedRequire = createAdapterLoader(adapterCodes, { process: syntheticProcess, resolve(name) {
    if (name === '@elgato/streamdeck') return sdkModule;
    if (name === '../core/process-runner.mjs') return runner;
  }, observe(name, actual) {
    if (name === '../core/timer-session.mjs') return capture(actual, 'createTimerSession', sessions);
    if (name === '../core/action-session.mjs') return capture(actual, 'createActionSession', sessions);
    if (name === '../core/timer-settings.mjs') return capture(actual, 'createTimerStateCoordinator', states);
    if (name === '../core/run-state.mjs') return capture(actual, 'createRunStateCoordinator', states);
    if (name === '../core/availability.mjs') return capture(actual, 'createAvailabilityManager', managers);
    return actual;
  } });
  const { TimerAction } = isolatedRequire('./timer'), { RunAction } = isolatedRequire('./run');
  const action = new TimerAction(registry, time);
  const idle = async () => {
    await Promise.all(managers.map(manager => manager.whenIdle()));
    await Promise.all(states.map(state => state.whenIdle()));
    await Promise.all(sessions.map(session => session.whenIdle()));
  };
  const remember = (adapter, r) => {
    if (!tracked.some(item => item.adapter === adapter && item.r === r)) tracked.push({ adapter, r });
  };
  const appear = async (r, adapter = action, settings) => {
    remember(adapter, r);
    await adapter.onWillAppear({ action: r, payload: { settings: settings ?? await r.getSettings() } });
    await idle();
  };
  t.after(async () => {
    // Only synthetic process ownership and listener cleanup, no real services or files.
    for (const launch of launches) launch.stopGate?.resolve(true);
    for (const { adapter, r } of tracked) await adapter.onWillDisappear({ action: r });
    for (const session of sessions) await session.setConnected(false);
    await idle();
    for (const manager of managers) manager.dispose();
  });
  return { action, TimerAction, RunAction, registry, time, launches, sessions, states, replies, logs, sdk, decorated,
    registrations, appear, idle,
    newRun: () => new RunAction(registry),
    emit(name, device) { for (const listener of listeners.get(name) ?? []) listener(name === 'wake' ? undefined : { device }); },
    down: (r, settings = base) => action.onKeyDown({ action: r, payload: { settings } }),
    up: r => action.onKeyUp({ action: r, payload: { settings: { executable: '/synthetic/stale' } } }),
    async tap(r) { await this.down(r); await this.up(r); await idle(); },
    async advance(ms, deliver = true) { time.advance(ms, deliver); await idle(); },
    async finish(result = { status: 'success' }, launch = launches.at(-1)) {
      if (result.status === 'success') launch.callbacks.onDiagnostic('PROCESS_EXITED_SUCCESSFULLY');
      launch.done.resolve(result); await Promise.resolve(); await idle();
    },
    send(r, type, requestId, extra = {}, adapter = action) {
      return adapter.onSendToPlugin({ action: r,
        payload: { type, context: r.id, inspectorId: 'synthetic-inspector', requestId, ...extra } });
    },
    async claim(r, inspectorId = 'synthetic-inspector') {
      await this.send(r, 'canvas:hello', 1, { inspectorId });
      await this.send(r, 'canvas:claim', 2, { inspectorId, token: replies.at(-1).token });
    },
  };
}

// Slice 3: real Loop display adapters forward badges only for built-in non-error cards.
// Slice 4: actual Loop adapter keeps hard-line content independent of configuration and deadlines.
test('actual Loop hard lines survive rejected schema and confirmed key-local cosmetics without deadline change', options, async t => {
  // Arrange
  const h = harness(t), r = runtime(), other = runtime('synthetic-hard-other');
  await h.appear(r); await h.appear(other); await h.claim(r); await h.tap(r);
  const record = parseOutputUpdate(String.raw`text:A\n\nB|font-size:16;border:2`);
  const mutable = { ...record, options: { ...record.options }, overrides: { ...record.overrides } };
  h.launches[0].callbacks.onUpdate(mutable); await h.idle();
  const accepted = images(r).at(-1), untouched = [...other.display];
  // Act
  mutable.value = 'mutated';
  h.launches[0].callbacks.onUpdate({ ...record, hardBreaks: true });
  h.launches[0].callbacks.onUpdate({ ...record, options: { ...record.options, 'max-lines': 2 } }); await h.idle();
  const rejectedDisplay = images(r).at(-1); await h.finish();
  const due = h.sessions[0].getState().dueMs;
  await h.send(r, 'canvas:edit', 3, { changes: { themeColor: '#abcdef' } }); await h.idle();
  const rendered = svg(images(r).at(-1));
  // Assert
  assert.equal(rejectedDisplay, accepted);
  assert.deepEqual([...rendered.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map(match => match[1]), ['A', '', 'B']);
  assert.deepEqual([...rendered.matchAll(/<text\b[^>]*fill="([^"]*)"/g)].map(match => match[1]), Array(3).fill('#abcdef'));
  assert.equal(record.value, 'A\n\nB'); assert.deepEqual(other.display, untouched); assert.deepEqual(other.writes, []);
  assert.equal(h.sessions[0].getState().dueMs, due); assert.equal(h.sessions[0].getState().enabled, true);
  assert.equal(h.launches.length, 1); assert.equal(h.launches[0].stops, 0);
  assert.deepEqual(r.writes, [{ ...base, themeColor: '#abcdef' }]);
});
test('actual Loop final hard-line SDK handoff drains before deadline and rejects old-generation callbacks', options, async t => {
  // Arrange
  const h = harness(t), r = runtime(); await h.appear(r); await h.tap(r);
  const entered = deferred(), gate = deferred(), original = r.setImage;
  const final = parseOutputUpdate(String.raw`text:A\n\nB|font-size:16`), artwork = createPrimitiveArtwork(final);
  r.setImage = async image => { await original(image); if (image === artwork) { entered.resolve(); await gate.promise; } };
  // Act
  h.launches[0].callbacks.onUpdate(final); await entered.promise;
  h.launches[0].callbacks.onUpdate({ ...final, hardBreaks: true });
  const beforeCompletion = [...r.display];
  const finishing = h.finish();
  try {
    // T7: give the queued terminal operation an event-loop turn with the final image still held.
    await h.launches[0].done.promise;
    await new Promise(resolve => setImmediate(resolve));
    // Assert before release: neither completion nor a repeat deadline may precede final handoff.
    const pending = h.sessions[0].getState();
    assert.equal(pending.phase, 'stopping');
    assert.equal(pending.dueMs, undefined);
    assert.deepEqual(r.display, beforeCompletion);
    assert.equal(h.launches.length, 1);
  } finally {
    gate.resolve(); await finishing;
  }
  const retained = [...images(r)], due = h.sessions[0].getState().dueMs;
  await h.advance(5000); h.launches[0].callbacks.onUpdate(parseOutputUpdate(String.raw`text:stale\ncallback`)); await h.idle();
  // Assert
  assert.equal(due, 5000);
  assert.equal(retained.at(-1), artwork); assert.deepEqual(images(r), retained); assert.deepEqual(r.writes, []);
  assert.equal(h.launches.length, 2); assert.equal(h.launches[0].stops, 0);
});

// Slice 4: recurring attempts capture confirmed configuration, not producer colors or inherited collisions.
for (const [themeColor, expected] of [[undefined, '#969696'], ['#ABCDEF', '#abcdef'], ['red', '#969696'], ['#abcdef\n', '#969696']]) {
  test(`actual Loop initial theme snapshot case ${String(themeColor)} never enables on configuration alone`, options, async t => {
    // Arrange
    const h = harness(t), r = runtime('synthetic-loop-theme', { ...base, ...(themeColor === undefined ? {} : { themeColor }) });
    // Act
    await h.appear(r); const beforePress = h.launches.length; await h.tap(r);
    // Assert
    assert.equal(beforePress, 0); assert.equal(h.launches.length, 1);
    assert.equal(h.launches[0].env.ELGATO_ACTION_THEME_COLOR, expected); assert.deepEqual(r.writes, []);
    assert.equal(h.logs.some(value => value.includes('ELGATO_ACTION_THEME_COLOR') || value.includes('STALE_SYNTHETIC')), false);
  });
}

for (const terminal of ['success', 'nonzero', 'signal']) {
  test(`actual Loop ${terminal} next interval uses latest confirmed theme without changing the running environment`, options, async t => {
    // Arrange
    const h = harness(t), r = runtime('synthetic-loop-recurring-theme', { ...base, themeColor: '#123456' });
    const other = runtime('synthetic-loop-other-theme', { ...base, themeColor: '#654321' });
    await h.appear(r); await h.appear(other); await h.tap(r); await h.tap(other); await h.claim(r);
    const original = structuredClone(h.launches[0].env), otherDisplay = [...other.display], runningDue = h.sessions[0].getState().dueMs;
    // Act: inline primitive ink never becomes configuration or a launch environment value.
    h.launches[0].callbacks.onUpdate(parseOutputUpdate('text:synthetic|color:red')); await h.idle();
    await h.send(r, 'canvas:edit', 3, { changes: { themeColor: '#ABCDEF' } }); await h.idle();
    const afterEdit = { count: h.launches.length, stops: h.launches[0].stops, due: h.sessions[0].getState().dueMs };
    if (terminal !== 'success') h.launches[0].callbacks.onDiagnostic(terminal === 'signal' ? 'PROCESS_TERMINATED_BY_SIGNAL' : 'PROCESS_EXITED_NONZERO');
    await h.finish(terminal === 'success' ? { status: 'success' } : { status: 'error', error: ordinaryError }, h.launches[0]);
    const due = h.sessions[0].getState().dueMs;
    await h.send(r, 'canvas:edit', 4, { changes: { themeColor: '#FEDCBA' } }); await h.idle();
    const afterWaitingEdit = { due: h.sessions[0].getState().dueMs, count: h.launches.length };
    await h.advance(5000);
    // Assert
    assert.deepEqual(afterEdit, { count: 2, stops: 0, due: runningDue }); assert.deepEqual(h.launches[0].env, original);
    assert.deepEqual(afterWaitingEdit, { due, count: 2 }); assert.equal(due, 5000);
    assert.equal(h.launches.length, 3); assert.equal(h.launches[2].env.ELGATO_ACTION_THEME_COLOR, '#fedcba');
    assert.equal(h.launches[1].env.ELGATO_ACTION_THEME_COLOR, '#654321'); assert.deepEqual(other.display, otherDisplay); assert.deepEqual(other.writes, []);
    assert.deepEqual(r.writes.map(value => value.themeColor), ['#abcdef', '#fedcba']);
    assert.equal(h.replies.some(reply => JSON.stringify(reply).includes('ELGATO_') || JSON.stringify(reply).includes('SYNTHETIC_PRIVATE_ENV')), false);
    assert.equal(h.logs.some(value => value.includes('#fedcba') || value.includes('SYNTHETIC_PRIVATE_ENV')), false);
  });
}

test('actual Loop fatal failure cannot acquire a new theme launch through cosmetic edits or elapsed time', options, async t => {
  // Arrange
  const h = harness(t), r = runtime('synthetic-loop-fatal-theme', { ...base, themeColor: '#123456' });
  await h.appear(r); await h.tap(r); await h.claim(r);
  h.launches[0].callbacks.onError('Image protocol error.'); await h.finish({ status: 'error', error: 'Image protocol error.' });
  const before = h.sessions[0].getState();
  // Act
  await h.send(r, 'canvas:edit', 3, { changes: { themeColor: '#ABCDEF' } }); await h.advance(10000);
  // Assert
  assert.equal(h.launches.length, 1); assert.equal(h.launches[0].env.ELGATO_ACTION_THEME_COLOR, '#123456');
  assert.equal(h.sessions[0].getState().enabled, before.enabled); assert.equal(h.sessions[0].getState().dueMs, before.dueMs);
  assert.equal(images(r).at(-1), createErrorArtwork('IMAGE_PROTOCOL_ERROR', '#abcdef'));
});
test('actual Loop badges are per-key and suffix-only replacement does not enable scheduling', options, async t => {
  // Arrange
  const h = harness(t), first = runtime('synthetic-loop-badge-one', { ...base, executable: '/synthetic/report.py' });
  const second = runtime('synthetic-loop-badge-two', { ...base, executable: '/synthetic/report.sh' });
  await h.appear(first); await h.appear(second); await h.claim(first); const beforeSecond = [...second.display];
  // Act
  await h.send(first, 'canvas:edit', 3, { changes: { executable: '/synthetic/report.GZ' } }); await h.idle();
  // Assert
  assert.match(svg(images(first).at(-1)), />Loop<\/text>.*>\.gz<\/text>.*>report<\/text>.*>ready<\/text>/);
  assert.match(svg(images(second).at(-1)), />\.sh<\/text>/); assert.deepEqual(second.display, beforeSecond);
  assert.equal(h.sessions[0].getState().enabled, false); assert.equal(h.sessions[0].getState().dueMs, undefined);
  assert.deepEqual(h.launches, []); assert.deepEqual(second.writes, []);
});

test('actual Loop Loading and Success badges track theme without changing deadline or execution', options, async t => {
  // Arrange
  const h = harness(t), r = runtime('synthetic-loop-badge', { ...base, executable: '/synthetic/report.PY' });
  await h.appear(r); await h.tap(r); await h.finish(); await h.claim(r);
  const due = h.sessions[0].getState().dueMs;
  // Act
  await h.send(r, 'canvas:edit', 3, { changes: { themeColor: '#ABCDEF' } }); await h.idle();
  // Assert
  assert.ok(images(r).some(image => />\.py<\/text>.*>loading\.\.\.<\/text>/.test(svg(image))));
  assert.match(svg(images(r).at(-1)), /text-anchor="end"[^>]*fill="#abcdef">\.py<\/text>.*>success<\/text>/);
  assert.equal(h.sessions[0].getState().dueMs, due); assert.equal(h.sessions[0].getState().enabled, true);
  assert.equal(h.launches.length, 1); assert.equal(h.launches[0].stops, 0);
  assert.deepEqual(r.writes, [{ ...base, executable: '/synthetic/report.PY', themeColor: '#abcdef' }]);
});

for (const record of ['text:plain', 'progress:45', '<svg>opaque</svg>']) {
  test('actual Loop producer bytes survive recurring attempts without badges or Loading flash', options, async t => {
    // Arrange
    const h = harness(t), r = runtime(); await h.appear(r); await h.tap(r);
    const producer = parseOutputUpdate(record), expected = producer.kind === 'image' ? producer.image : createPrimitiveArtwork(producer);
    // Act
    h.launches[0].callbacks.onUpdate(producer); await h.idle(); await h.finish();
    const count = images(r).length; await h.advance(5000);
    // Assert
    assert.equal(images(r).at(-1), expected); assert.equal(images(r).length, count);
    assert.equal(h.launches.length, 2); assert.equal(svg(expected).includes('>.sh</text>'), false);
  });
}

for (const loss of ['hide', 'disconnect', 'persistence']) {
  test(`actual Loop held title cannot hand off obsolete suffix artwork after ${loss}`, options, async t => {
    // Arrange
    const h = harness(t), r = runtime(), entered = deferred(), gate = deferred(); let hold = true;
    r.setTitle = async title => { r.display.push(['title', title]); if (hold) { hold = false; entered.resolve(); await gate.promise; } };
    const appearing = h.appear(r); await entered.promise;
    // Act
    const transition = loss === 'hide' ? h.action.onWillDisappear({ action: r })
      : loss === 'disconnect' ? h.sessions[0].setConnected(false) : h.sessions[0].persistenceFailed();
    gate.resolve(); await Promise.all([appearing, transition]); await h.idle();
    // Assert
    assert.equal(images(r).some(image => svg(image).includes('>.sh</text>')), false); assert.deepEqual(h.launches, []);
    if (loss === 'persistence') assert.equal(images(r).at(-1), createErrorArtwork('STATE_SAVE_FAILED'));
  });
}

// Objective: actual adapter routing preserves short policy at 999ms and recognizes
// Slice 2: real Loop adapter keeps Setup disabled and consumes setup-started gestures.
for (const at of [0, 999, 1000, 1001]) {
  test(`actual Loop Setup ${at}ms gestures clear title but never launch, schedule or write intent`, options, async t => {
    // Arrange
    const h = harness(t), r = runtime('synthetic-loop-setup', {}); await h.appear(r);
    // Act
    await h.down(r, {}); await h.down(r, {}); await h.advance(at);
    await h.up(r); await h.up(r); await h.advance(100000);
    // Assert
    assert.match(svg(images(r).at(-1)), /aria-label="Setup required".*>setup required<\/text>/);
    assert.deepEqual(r.display.filter(([kind]) => kind === 'title'), [['title', '']]);
    assert.deepEqual(r.writes, []); assert.deepEqual(h.launches, []);
    assert.equal(h.sessions[0].getState().enabled, false); assert.equal(h.sessions[0].getState().dueMs, undefined);
    assert.equal(h.sessions[0].getState().suspended, false);
  });
}
test('actual Loop Setup gesture remains consumed through confirmed PI executable selection; next tap launches', options, async t => {
  // Arrange
  const h = harness(t), r = runtime('synthetic-loop-setup-edit', {}); await h.appear(r); await h.claim(r);
  // Act
  await h.down(r, {}); await h.send(r, 'canvas:edit', 3, { changes: { executable: base.executable } });
  await h.advance(1000); await h.up(r); await h.up(r); await h.idle();
  const before = h.launches.length, state = h.sessions[0].getState();
  const ready = svg(images(r).at(-1)); await h.tap(r);
  // Assert
  assert.equal(before, 0); assert.equal(state.enabled, false); assert.equal(state.dueMs, undefined);
  assert.match(ready, />program<\/text>.*>ready<\/text>/);
  assert.equal(h.launches.length, 1); assert.equal(h.sessions[0].getState().enabled, true);
  assert.deepEqual(r.writes, [{ executable: base.executable, argsText: '' }]);
});
test('actual Loop empty executable PI edit leaves Setup unchanged without writes or recovery', options, async t => {
  // Arrange
  const h = harness(t), r = runtime('synthetic-loop-empty-edit', {}); await h.appear(r); await h.claim(r);
  // Act
  await h.send(r, 'canvas:edit', 3, { changes: { executable: '' } }); await h.idle(); await h.tap(r);
  // Assert
  assert.equal(h.replies.at(-1)?.status, 'error'); assert.equal(h.replies.at(-1)?.diagnosticCode, 'INVALID_EXECUTABLE');
  assert.match(svg(images(r).at(-1)), />setup required<\/text>/);
  assert.deepEqual(r.writes, []); assert.deepEqual(h.launches, []); assert.equal(h.sessions[0].getState().suspended, false);
});
test('actual Loop delayed Setup title clear cannot hand off artwork after newer persistence Error', options, async t => {
  // Arrange
  const h = harness(t), r = runtime('synthetic-loop-stale-setup', {}), entered = deferred(), gate = deferred();
  let delay = true;
  r.setTitle = async title => { r.display.push(['title', title]); if (delay) { delay = false; entered.resolve(); await gate.promise; } };
  // Act
  const appearing = h.appear(r); await entered.promise;
  const failing = h.sessions[0].persistenceFailed(); gate.resolve();
  await Promise.all([appearing, failing]); await h.idle();
  // Assert
  assert.equal(h.sessions[0].getState().presentation, 'error');
  assert.equal(images(r).some(image => svg(image).includes('setup required')), false);
  assert.ok(r.display.filter(([kind]) => kind === 'title').every(([, title]) => title === ''));
  assert.deepEqual(r.writes, []); assert.deepEqual(h.launches, []);
});
test('actual Loop delayed Setup cannot overwrite newer confirmed Ready after PI configuration', options, async t => {
  // Arrange
  const h = harness(t), r = runtime('synthetic-loop-stale-setup-ready', {}), entered = deferred(), gate = deferred();
  let delay = true;
  r.setTitle = async title => { r.display.push(['title', title]); if (delay) { delay = false; entered.resolve(); await gate.promise; } };
  // Act
  const appearing = h.appear(r); await entered.promise; await h.claim(r);
  const editing = h.send(r, 'canvas:edit', 3, { changes: { executable: base.executable } });
  gate.resolve(); await Promise.all([appearing, editing]); await h.idle();
  // Assert
  assert.equal(images(r).some(image => svg(image).includes('setup required')), false);
  assert.match(svg(images(r).at(-1)), />program<\/text>.*>ready<\/text>/);
  assert.equal(h.sessions[0].getState().enabled, false); assert.equal(h.sessions[0].getState().dueMs, undefined);
  assert.deepEqual(h.launches, []); assert.deepEqual(r.writes, [{ executable: base.executable, argsText: '' }]);
});

// Objective: actual adapter routing preserves short policy at 999ms and recognizes
// the literal 1000/1001ms hold with or without delivery of its timer callback.
for (const policy of [undefined, 'refresh', 'stop']) {
  for (const stage of ['disabled', 'waiting', 'running']) {
    for (const at of [999, 1000, 1001]) {
      for (const deliver of [false, true]) {
        test(`adapter ${policy ?? 'default Refresh'} ${stage} boundary ${at}ms, timer-first=${deliver}`, options, async t => {
          // Arrange
          const h = harness(t), r = runtime('synthetic-boundary', { ...base, ...(policy === undefined ? {} : { actionOnPress: policy }) });
          await h.appear(r);
          if (stage !== 'disabled') await h.tap(r);
          if (stage === 'waiting') await h.finish();
          const count = h.launches.length, due = h.sessions[0].getState().dueMs;
          // Act
          await h.down(r); await h.down(r); await h.advance(at, deliver);
          const beforeRelease = { count: h.launches.length, enabled: h.sessions[0].getState().enabled };
          await h.up(r); await h.up(r); await h.idle();
          const recognized = h.sessions[0].getState(); await h.advance(100000);
          // Assert
          const held = at >= 1000;
          const enabled = !held && (stage === 'disabled' || policy !== 'stop');
          const starts = !held && (stage === 'disabled' || (stage === 'waiting' && policy !== 'stop'));
          assert.equal(beforeRelease.count, count);
          assert.equal(beforeRelease.enabled, stage !== 'disabled' && !(held && deliver));
          assert.equal(h.launches.length, count + Number(starts)); assert.equal(recognized.enabled, enabled);
          assert.equal(h.launches[0]?.stops ?? 0, stage === 'running' && !enabled ? 1 : 0);
          assert.equal(recognized.dueMs, !held && stage === 'running' && policy !== 'stop' ? due : undefined);
          assert.deepEqual(r.writes, []);
        });
      }
    }
  }
}

for (const policy of [undefined, 'refresh', 'stop']) {
  for (const at of [999, 1000, 1001]) {
    for (const deliver of [false, true]) {
      test(`adapter ${policy ?? 'default Refresh'} starting boundary ${at}ms, timer-first=${deliver}`, options, async t => {
        // Arrange
        const h = harness(t), r = runtime('synthetic-start-boundary', { ...base, ...(policy === undefined ? {} : { actionOnPress: policy }) });
        await h.appear(r); const gate = deferred(), entered = deferred(); let heldTitle = false;
        r.setTitle = async title => { r.display.push(['title', title]); if (!heldTitle) { heldTitle = true; entered.resolve(); await gate.promise; } };
        void h.down(r); const launching = h.up(r); await entered.promise;
        // Act
        const phase = h.sessions[0].getState().phase;
        void h.down(r); h.time.advance(at, deliver);
        const recognized = h.up(r); gate.resolve();
        await Promise.all([launching, recognized]); await h.idle(); await h.up(r); await h.advance(100000);
        // Assert
        const enabled = at === 999 && policy !== 'stop';
        assert.equal(phase, 'starting'); assert.equal(h.sessions[0].getState().enabled, enabled);
        assert.equal(h.launches.length, Number(enabled)); assert.ok(h.launches.every(launch => launch.stops === 0));
        assert.equal(h.sessions[0].getState().dueMs, undefined); assert.deepEqual(r.writes, []);
      });
    }
  }
}

// Objective: breaking action mapping has no legacy aliases or plugin identity change.
test('manifest and actual decorators identify Stream/Loop/Run actions', options, async t => {
  // Arrange
  const h = harness(t);
  const manifest = JSON.parse(await readFile(new URL('../git.renaudcerrato.deckforge.sdPlugin/manifest.json', import.meta.url), 'utf8'));
  // Act
  const run = manifest.Actions.find(action => action.UUID === RUN_UUID);
  const timer = manifest.Actions.find(action => action.UUID === TIMER_UUID);
  // Assert
  assert.equal(manifest.Actions.length, 3);
  assert.deepEqual(manifest.Actions.map(action => [action.Name, action.UUID]), [
    ['Stream', 'git.renaudcerrato.deckforge.stream'],
    ['Loop', 'git.renaudcerrato.deckforge.loop'],
    ['Run', 'git.renaudcerrato.deckforge.run'],
  ]);
  assert.equal(manifest.Actions.some(action => ['git.renaudcerrato.deckforge.timer', 'git.renaudcerrato.deckforge.once'].includes(action.UUID)), false);
  const once = manifest.Actions.find(action => action.UUID === 'git.renaudcerrato.deckforge.run');
  assert.equal(once.Name, 'Run'); assert.equal(once.Icon, 'imgs/actions/once/icon');
  assert.equal(once.PropertyInspectorPath, run.PropertyInspectorPath);
  assert.deepEqual(once.Controllers, ['Keypad']);
  assert.deepEqual(once.States, [{ Image: 'imgs/actions/once/key', TitleAlignment: 'bottom' }]);
  assert.equal(run.Name, 'Stream'); assert.equal(run.UUID, RUN_UUID); assert.equal(run.Icon, 'imgs/actions/run/icon');
  assert.equal(run.PropertyInspectorPath, 'ui/run.html');
  assert.deepEqual(run.Controllers, ['Keypad']);
  assert.deepEqual(run.States, [{ Image: 'imgs/actions/run/key', TitleAlignment: 'bottom' }]);
  assert.equal(timer.Name, 'Loop'); assert.equal(timer.Icon, 'imgs/actions/timer/icon');
  assert.equal(timer.PropertyInspectorPath, run.PropertyInspectorPath);
  assert.deepEqual(timer.Controllers, ['Keypad']);
  assert.deepEqual(timer.States, [{ Image: 'imgs/actions/timer/key', TitleAlignment: 'bottom' }]);
  assert.equal(manifest.UUID, 'git.renaudcerrato.deckforge');
  assert.equal(manifest.Description, 'Script to canvas');
  assert.equal(manifest.Name, 'DeckForge Commander'); assert.equal(manifest.Author, 'Renaud Cerrato');
  assert.equal(h.decorated.get(h.TimerAction), TIMER_UUID); assert.equal(h.decorated.get(h.RunAction), RUN_UUID);
  assert.equal(h.launches.length, 0); assert.equal(h.sessions.length, 0);
});

test('fresh configured Timer defaults to disabled 60 seconds with Loop/name/ready artwork and no writes', options, async t => {
  // Arrange
  const h = harness(t), r = runtime('synthetic-default', { executable: base.executable, argsText: '' });
  // Act
  await h.appear(r); await h.advance(100000);
  // Assert
  assert.match(svg(images(r).at(-1)), />Loop<\/text>.*>program<\/text>.*>ready<\/text>/);
  assert.deepEqual(r.display[0], ['title', '']); assert.deepEqual(r.writes, []);
  assert.equal(h.sessions[0].getState().enabled, false); assert.equal(h.launches.length, 0);
  assert.equal(Object.hasOwn(await r.getSettings(), 'intervalSeconds'), false);
});

for (const [field, value] of [['runRequested', true], ['executable', 'relative'], ['intervalSeconds', 0], ['actionOnPress', 'Refresh'], ['actionOnPress', null]]) {
  test(`fresh invalid ${field} cannot enable Timer or write hydration settings`, options, async t => {
    // Arrange
    const h = harness(t), r = runtime('synthetic-invalid', { ...base, [field]: value });
    // Act
    await h.appear(r); await h.tap(r); await h.advance(100000);
    // Assert
    assert.match(svg(images(r).at(-1)), />Error<\/text>/);
    assert.equal(h.sessions[0].getState().suspended, true);
    assert.equal(h.launches.length, 0); assert.deepEqual(r.writes, []);
  });
}

test('key-down cannot launch; short key-up launches once with literal execution and all fresh metadata', options, async t => {
  // Arrange
  const h = harness(t), initial = { ...base, argsText: "'two words' '$HOME' '*.png'", cwd: '/synthetic/work', themeColor: '#123456' };
  const r = runtime('synthetic-key', initial);
  await h.appear(r);
  // Act
  await h.down(r, { executable: '/synthetic/foreign' }); await h.idle(); const before = h.launches.length;
  await h.advance(999, false); await h.up(r); await h.up(r); await h.idle();
  // Assert
  assert.equal(before, 0); assert.equal(h.launches.length, 1);
  assert.deepEqual(h.launches[0].settings, { executable: base.executable, args: ['two words', '$HOME', '*.png'], cwd: initial.cwd });
  const env = h.launches[0].env;
  assert.deepEqual(env, { PATH: '/synthetic/path', PRIVATE_ENV: 'SYNTHETIC_PRIVATE_ENV',
    ELGATO_PLUGIN_UUID: 'git.renaudcerrato.deckforge', ELGATO_PLUGIN_VERSION: '0.1.0.0',
    ELGATO_ACTION_UUID: TIMER_UUID, ELGATO_ACTION_CONTEXT: 'synthetic-key', ELGATO_ACTION_THEME_COLOR: '#123456', ELGATO_DEVICE_ID: 'synthetic-device',
    ELGATO_DEVICE_NAME: 'Fictional Deck', ELGATO_DEVICE_TYPE: '999', ELGATO_DEVICE_COLUMNS: '0', ELGATO_DEVICE_ROWS: '3',
    ELGATO_KEY_COLUMN: '0', ELGATO_KEY_ROW: '2', ELGATO_APP_VERSION: '7.6', ELGATO_APP_LANGUAGE: 'fr',
    ELGATO_APP_PLATFORM: 'mac', ELGATO_APP_PLATFORM_VERSION: '26' });
  assert.match(svg(images(r).at(-1)), />Loop<\/text>.*>program<\/text>.*>loading\.\.\.<\/text>/);
  assert.deepEqual(r.display.at(-2), ['title', '']); assert.deepEqual(r.writes, []);
  assert.equal(h.logs.some(value => value.includes('two words') || value.includes('SYNTHETIC_PRIVATE_ENV')), false);
});

test('accepted host settings remain authoritative through late host, appearance and key payloads', options, async t => {
  // Arrange
  const h = harness(t), r = runtime(); await h.appear(r);
  const foreign = { executable: '/synthetic/foreign', argsText: 'foreign', intervalSeconds: 1 };
  // Act
  await h.action.onDidReceiveSettings({ action: r, payload: { settings: foreign } });
  await h.appear(r, h.action, foreign); await h.down(r, foreign); await h.up(r); await h.idle();
  // Assert
  assert.deepEqual(h.states[0].getSettings(), base); assert.deepEqual(r.writes, []);
  assert.deepEqual(h.launches[0].settings, { executable: base.executable, args: [] });
  assert.equal(h.launches.length, 1);
});

test('keys and new Singleton instances share neither enabled intent nor display/deadlines', options, async t => {
  // Arrange
  const h = harness(t), first = runtime(), second = runtime('synthetic-second');
  await h.appear(first); await h.appear(second); await h.tap(first);
  h.launches[0].callbacks.onUpdate(parseOutputUpdate('text:first')); await h.idle(); await h.finish();
  const untouched = [...second.display];
  const freshAdapter = new h.TimerAction(h.registry, h.time), fresh = runtime('synthetic-fresh');
  // Act
  await h.appear(fresh, freshAdapter); await h.advance(5000);
  // Assert
  assert.deepEqual(second.display, untouched); assert.equal(h.launches.length, 2);
  assert.equal(h.sessions[1].getState().enabled, false); assert.equal(h.sessions[2].getState().enabled, false);
  assert.equal(h.sessions[2].getState().dueMs, undefined);
  assert.match(svg(images(fresh).at(-1)), />ready<\/text>/);
  assert.deepEqual(first.writes, []); assert.deepEqual(second.writes, []); assert.deepEqual(fresh.writes, []);
});

// Objective: completion pacing is based on the cleanup-completed runner contract, not launch time.
for (const interval of [undefined, 5]) {
  test(`empty success retains success card and waits a full ${interval ?? 60}s after owned done`, options, async t => {
    // Arrange
    const h = harness(t), r = runtime('synthetic-paced', { executable: base.executable, argsText: '',
      ...(interval === undefined ? {} : { intervalSeconds: interval }) });
    await h.appear(r); await h.tap(r); await h.advance(12345);
    // Act
    const during = h.launches.length; await h.finish(); const due = h.sessions[0].getState().dueMs;
    const retained = [...r.display]; await h.advance((interval ?? 60) * 1000 - 1); const before = h.launches.length;
    await h.advance(1);
    // Assert
    assert.equal(during, 1); assert.equal(due, 12345 + (interval ?? 60) * 1000);
    assert.equal(before, 1); assert.equal(h.launches.length, 2); assert.deepEqual(r.display, retained);
    assert.match(svg(images(r).at(-1)), />Loop<\/text>.*>program<\/text>.*>success<\/text>/);
    assert.deepEqual(r.writes, []);
  });
}

for (const record of ['text:accepted', 'progress:45|label:Accepted', 'data:image/png;base64,aGVsbG8=']) {
  test(`actual SDK handoff retains accepted ${record.split(':')[0]} through success and next launch`, options, async t => {
    // Arrange
    const h = harness(t), r = runtime(); await h.appear(r); await h.tap(r);
    const update = parseOutputUpdate(record);
    // Act
    h.launches[0].callbacks.onUpdate(update); await h.idle();
    const shown = images(r).at(-1), display = [...r.display]; await h.finish(); await h.advance(5000);
    // Assert
    assert.equal(shown, update.kind === 'image' ? update.image : createPrimitiveArtwork(update));
    assert.deepEqual(r.display, display); assert.deepEqual(r.display.at(-2), ['title', '']);
    assert.equal(h.launches.length, 2); assert.equal(h.sessions[0].getState().presentation, 'streaming');
    assert.deepEqual(r.writes, []);
  });
}

test('malformed producer callback cannot suppress success or replace accepted SDK output', options, async t => {
  // Arrange
  const h = harness(t), r = runtime(); await h.appear(r); await h.tap(r);
  // Act
  h.launches[0].callbacks.onUpdate({ kind: 'image', image: 'invalid' });
  h.launches[0].callbacks.onUpdate(parseOutputUpdate('progress:nope')); await h.finish();
  // Assert
  assert.equal(images(r).length, 3); assert.match(svg(images(r).at(-1)), />success<\/text>/);
  assert.equal(h.sessions[0].getState().phase, 'waiting'); assert.equal(h.sessions[0].getState().suspended, false);
});

for (const diagnostic of ['PROCESS_EXITED_NONZERO', 'PROCESS_TERMINATED_BY_SIGNAL']) {
  test(`${diagnostic} uses unchanged Error artwork then retries without Loading flash`, options, async t => {
    // Arrange
    const h = harness(t), r = runtime(); await h.appear(r); await h.tap(r);
    // Act
    h.launches[0].callbacks.onDiagnostic(diagnostic);
    await h.finish({ status: 'error', error: ordinaryError }); const retained = [...r.display];
    await h.advance(4999); const before = h.launches.length; await h.advance(1);
    // Assert
    assert.equal(before, 1); assert.equal(h.launches.length, 2); assert.deepEqual(r.display, retained);
    assert.equal(images(r).at(-1), createErrorArtwork(diagnostic));
    assert.deepEqual(r.display.at(-2), ['title', '']); assert.equal(h.sessions[0].getState().suspended, false);
    assert.deepEqual(r.writes, []);
  });
}

for (const fatal of ['launch', 'protocol', 'display']) {
  test(`${fatal} failure suspends automatic work until a deliberate safe tap`, options, async t => {
    // Arrange
    const h = harness(t), r = runtime(); await h.appear(r); await h.tap(r);
    const originalImage = r.setImage;
    // Act
    if (fatal === 'display') {
      r.setImage = async () => { throw new Error('SYNTHETIC_PRIVATE_EXCEPTION'); };
      h.launches[0].callbacks.onUpdate(parseOutputUpdate('text:SYNTHETIC_PRIVATE_OUTPUT'));
      await h.idle(); r.setImage = originalImage;
    } else {
      if (fatal === 'launch') {
        h.launches[0].callbacks.onDiagnostic('PROCESS_LAUNCH_REASON_ENOENT');
        h.launches[0].callbacks.onDiagnostic('PROCESS_LAUNCH_FAILED');
      } else h.launches[0].callbacks.onError('Image protocol error.');
      await h.finish({ status: 'error', error: fatal === 'launch' ? 'Program launch failed.' : 'Image protocol error.' });
    }
    await h.advance(100000); const blocked = h.sessions[0].getState(), count = h.launches.length;
    await h.tap(r);
    // Assert
    assert.equal(count, 1); assert.equal(blocked.suspended, true); assert.equal(h.launches.length, 2);
    assert.equal(h.sessions[0].getState().suspended, false);
    assert.equal(h.launches[0].stops, fatal === 'display' ? 1 : 0);
    assert.equal(h.logs.some(value => value.includes('SYNTHETIC_PRIVATE_EXCEPTION') || value.includes('SYNTHETIC_PRIVATE_OUTPUT')), false);
    assert.deepEqual(r.writes, []);
  });
}

for (const delivery of [false, true]) {
  test(`actual key routing recognizes hold at 1000ms with callback delivery=${delivery}`, options, async t => {
    // Arrange
    const h = harness(t), r = runtime(); await h.appear(r); await h.tap(r);
    // Act
    await h.down(r); await h.down(r); await h.advance(1000, delivery);
    await h.up(r); await h.up(r); await h.idle(); await h.advance(100000);
    // Assert
    assert.equal(h.launches.length, 1); assert.equal(h.launches[0].stops, 1);
    assert.equal(h.sessions[0].getState().enabled, false); assert.match(svg(images(r).at(-1)), />ready<\/text>/);
    assert.deepEqual(r.writes, []);
  });
}

test('disabled hold and key-up-only cannot manufacture an initial refresh', options, async t => {
  // Arrange
  const h = harness(t), r = runtime(); await h.appear(r);
  // Act
  await h.up(r); await h.down(r); await h.advance(TIMER_HOLD_MS); await h.up(r); await h.idle();
  // Assert
  assert.equal(h.launches.length, 0); assert.equal(h.sessions[0].getState().enabled, false);
  assert.ok(images(r).every(image => />ready<\/text>/.test(svg(image)))); assert.deepEqual(r.writes, []);
});

for (const loss of ['hide', 'disconnect']) {
  test(`inherited availability after ${loss} cannot revive a cancelled SDK gesture`, options, async t => {
    // Arrange
    const h = harness(t), r = runtime(); await h.appear(r); await h.down(r);
    // Act
    if (loss === 'hide') await h.action.onWillDisappear({ action: r });
    else { r.device.isConnected = false; h.emit('disconnect', r.device); await h.idle(); }
    await h.advance(TIMER_HOLD_MS); await h.up(r); await h.idle(); const before = h.sessions[0].getState();
    r.device.isConnected = true; h.emit('connect', r.device); h.emit('wake'); await h.appear(r); await h.up(r); await h.idle();
    // Assert
    assert.equal(before.visible, loss !== 'hide'); assert.equal(before.connected, loss !== 'disconnect');
    assert.equal(h.launches.length, 0); assert.equal(h.sessions[0].getState().enabled, false);
    assert.deepEqual(r.writes, []);
  });
}

test('running tap stops once, rejects stale callbacks and cannot overlap a held cleanup boundary', options, async t => {
  // Arrange
  const h = harness(t), r = runtime('synthetic-stop', { ...base, actionOnPress: 'stop' }); await h.appear(r); await h.tap(r);
  const old = h.launches[0], gate = deferred(); old.stopGate = gate;
  // Act
  await h.down(r); const stopping = h.up(r); await old.stopEntered.promise;
  const extraDown = h.down(r), extraUp = h.up(r), before = h.launches.length;
  gate.resolve(true); await Promise.all([stopping, extraDown, extraUp]); await h.idle();
  const settled = [...r.display]; old.callbacks.onUpdate(parseOutputUpdate('text:stale'));
  old.callbacks.onError('Image protocol error.'); old.callbacks.onDiagnostic('PROCESS_LAUNCH_FAILED'); await h.idle();
  const unchanged = [...r.display]; await h.tap(r);
  // Assert
  assert.equal(before, 1); assert.equal(old.stops, 1); assert.deepEqual(unchanged, settled);
  assert.equal(h.launches.length, 2); assert.equal(h.sessions[0].getState().protocolBlocked, false);
  assert.deepEqual(r.writes, []);
});

test('cleanup uncertainty remains permanent across taps, edits, appearance and reconnect', options, async t => {
  // Arrange
  const h = harness(t), r = runtime('synthetic-stop', { ...base, actionOnPress: 'stop' }); await h.appear(r); await h.claim(r); await h.tap(r);
  h.launches[0].certain = false;
  // Act
  await h.tap(r); await h.tap(r); await h.send(r, 'canvas:edit', 3, { changes: { executable: '/synthetic/new' } });
  r.device.isConnected = false; h.emit('disconnect', r.device); await h.idle();
  r.device.isConnected = true; h.emit('connect', r.device); h.emit('wake'); await h.appear(r); await h.advance(100000);
  // Assert
  assert.equal(h.launches.length, 1); assert.equal(h.launches[0].stops, 1);
  assert.equal(h.sessions[0].getState().cleanupBlocked, true);
  assert.equal(images(r).at(-1), createErrorArtwork('CLEANUP_BLOCKED'));
});

// Objective: real shared PI/backend authority gates complete settings, never Timer intent.
test('PI challenge/claim correlates action instance rather than registration and never writes hydration', options, async t => {
  // Arrange
  const h = harness(t), r = runtime('synthetic-action-instance'); await h.appear(r);
  // Act
  await h.send(r, 'canvas:hello', 1); const challenge = h.replies.at(-1);
  await h.send(r, 'canvas:claim', 2, { token: challenge.token });
  // Assert
  assert.deepEqual(challenge, { type: 'canvas:reply', status: 'challenge', token: '1', settings: base,
    context: r.id, inspectorId: 'synthetic-inspector', requestId: 1 });
  assert.deepEqual(h.replies.at(-1), { type: 'canvas:reply', status: 'saved', settings: base,
    context: r.id, inspectorId: 'synthetic-inspector', requestId: 2 });
  assert.notEqual(challenge.context, TIMER_UUID); assert.deepEqual(r.writes, []); assert.equal(h.launches.length, 0);
});

for (const rejection of ['foreign context', 'unclaimed edit', 'wrong token', 'stale claim', 'foreign inspector', 'stale edit',
  'invalid interval', 'unknown setting', 'persisted intent', 'source args', 'invalid executable', 'invalid policy']) {
  test(`Timer PI rejects ${rejection} without writing or replacing owner`, options, async t => {
    // Arrange
    const h = harness(t), r = runtime(); await h.appear(r); await h.tap(r);
    const invalid = { 'invalid interval': { intervalSeconds: 0 }, 'unknown setting': { unknown: 'SYNTHETIC_PRIVATE_SETTING' },
      'persisted intent': { runRequested: true }, 'source args': { args: [] }, 'invalid executable': { executable: 'relative' }, 'invalid policy': { actionOnPress: 'toggle' } };
    if (['foreign inspector', 'stale edit', ...Object.keys(invalid)].includes(rejection)) await h.claim(r);
    if (['wrong token', 'stale claim'].includes(rejection)) await h.send(r, 'canvas:hello', 1);
    const before = h.replies.length;
    // Act
    if (rejection === 'foreign context') await h.send(r, 'canvas:hello', 1, { context: 'synthetic-registration-not-action' });
    else if (rejection === 'wrong token') await h.send(r, 'canvas:claim', 2, { token: 'wrong' });
    else if (rejection === 'stale claim') await h.send(r, 'canvas:claim', 1, { token: h.replies.at(-1).token });
    else await h.send(r, 'canvas:edit', rejection === 'stale edit' ? 2 : 3, {
      ...(rejection === 'foreign inspector' ? { inspectorId: 'foreign' } : {}),
      changes: invalid[rejection] ?? { intervalSeconds: 10 },
    });
    await h.idle();
    // Assert
    assert.deepEqual(r.writes, []); assert.equal(h.launches.length, 1); assert.equal(h.launches[0].stops, 0);
    if (invalid[rejection]) {
      assert.equal(h.replies.length, before + 1); assert.equal(h.replies.at(-1).status, 'error');
      assert.equal(JSON.stringify(h.replies.at(-1)).includes('SYNTHETIC_PRIVATE_SETTING'), false);
    } else assert.equal(h.replies.length, before);
    assert.equal(h.logs.some(value => value.includes('SYNTHETIC_PRIVATE_SETTING')), false);
  });
}

test('waiting interval edit resets full period only after matching host readback', options, async t => {
  // Arrange
  const h = harness(t), r = runtime(); await h.appear(r); await h.claim(r); await h.tap(r); await h.finish(); await h.advance(2000);
  const gate = deferred(), entered = deferred(), read = r.getSettings;
  r.getSettings = async () => { entered.resolve(); await gate.promise; return read(); };
  // Act
  const editing = h.send(r, 'canvas:edit', 3, { changes: { intervalSeconds: 10 } }); await entered.promise;
  h.time.advance(3000); const pending = h.sessions[0].getState(), count = h.launches.length;
  gate.resolve(); await editing; await h.idle(); const due = h.sessions[0].getState().dueMs;
  await h.advance(9999); const before = h.launches.length; await h.advance(1);
  // Assert
  assert.equal(count, 1); assert.equal(pending.configurationPending, true); assert.equal(pending.dueMs, undefined);
  assert.equal(due, 15000); assert.equal(before, 1); assert.equal(h.launches.length, 2);
  assert.deepEqual(r.writes, [{ ...base, intervalSeconds: 10 }]);
  assert.equal(h.replies.at(-1).status, 'saved'); assert.equal(h.sessions[0].getState().enabled, true);
});

test('running interval edit does not interrupt owner and uses new interval at completion', options, async t => {
  // Arrange
  const h = harness(t), r = runtime(); await h.appear(r); await h.claim(r); await h.tap(r);
  // Act
  await h.send(r, 'canvas:edit', 3, { changes: { intervalSeconds: 10 } }); await h.advance(7000); await h.finish();
  // Assert
  assert.equal(h.launches[0].stops, 0); assert.equal(h.launches.length, 1);
  assert.equal(h.sessions[0].getState().dueMs, 17000); assert.equal(h.sessions[0].getState().enabled, true);
  assert.deepEqual(r.writes, [{ ...base, intervalSeconds: 10 }]);
});

test('newest interval/theme snapshot gates launch while older read rejection is superseded', options, async t => {
  // Arrange
  const h = harness(t), r = runtime(); await h.appear(r); await h.claim(r); await h.tap(r); await h.finish();
  const oldRead = deferred(), oldEntered = deferred(), latestRead = deferred(), latestEntered = deferred();
  const read = r.getSettings; let reads = 0;
  r.getSettings = async () => {
    if (++reads === 1) { oldEntered.resolve(); return oldRead.promise; }
    latestEntered.resolve(); await latestRead.promise; return read();
  };
  // Act
  const older = h.send(r, 'canvas:edit', 3, { changes: { intervalSeconds: 10 } }); await oldEntered.promise;
  const newer = h.send(r, 'canvas:edit', 4, { changes: { themeColor: '#abcdef' } });
  oldRead.reject(new Error('SYNTHETIC_PRIVATE_OLD_READ')); await latestEntered.promise;
  h.time.advance(7000); const pending = h.sessions[0].getState(), count = h.launches.length;
  latestRead.resolve(); await Promise.all([older, newer]); await h.idle();
  const confirmed = h.sessions[0].getState(); await h.advance(10000);
  // Assert
  assert.equal(count, 1); assert.equal(pending.configurationPending, true);
  assert.equal(confirmed.persistenceBlocked, false); assert.equal(confirmed.dueMs, 17000);
  assert.equal(h.launches.length, 2); assert.equal(h.states[0].isBlocked(), false);
  assert.deepEqual(r.writes, [{ ...base, intervalSeconds: 10 }, { ...base, intervalSeconds: 10, themeColor: '#abcdef' }]);
  assert.equal(h.replies.at(-1).requestId, 4); assert.equal(h.replies.at(-1).status, 'saved');
  assert.equal(h.logs.some(value => value.includes('SYNTHETIC_PRIVATE_OLD_READ')), false);
});

test('pending execution edit stops owner but cannot show Ready or launch before complete confirmation', options, async t => {
  // Arrange
  const initial = { ...base, args: ['legacy'], argsText: 'old' };
  const h = harness(t), r = runtime('synthetic-edit', initial); await h.appear(r); await h.claim(r); await h.tap(r);
  const gate = deferred(), entered = deferred(), read = r.getSettings;
  r.getSettings = async () => { entered.resolve(); await gate.promise; return read(); };
  const readyCount = images(r).filter(image => />ready<\/text>/.test(svg(image))).length;
  // Act
  const editing = h.send(r, 'canvas:edit', 3, { changes: { argsText: 'SYNTHETIC_PRIVATE_ARG', cwd: '/synthetic/new-cwd' } });
  await entered.promise; await h.launches[0].stopEntered.promise;
  const pending = { state: h.sessions[0].getState(), count: h.launches.length,
    ready: images(r).filter(image => />ready<\/text>/.test(svg(image))).length };
  gate.resolve(); await editing; await h.idle(); await h.advance(100000);
  // Assert
  assert.equal(pending.state.configurationPending, true); assert.equal(pending.count, 1); assert.equal(pending.ready, readyCount);
  assert.equal(h.launches[0].stops, 1); assert.equal(h.launches.length, 1); assert.equal(h.sessions[0].getState().enabled, false);
  assert.match(svg(images(r).at(-1)), />ready<\/text>/);
  assert.deepEqual(r.writes, [{ ...initial, argsText: 'SYNTHETIC_PRIVATE_ARG', cwd: '/synthetic/new-cwd' }]);
  assert.ok(r.writes.every(value => !Object.hasOwn(value, 'enabled') && !Object.hasOwn(value, 'runRequested')));
  assert.equal(h.logs.some(value => value.includes('SYNTHETIC_PRIVATE_ARG')), false);
});

for (const explicit of [false, true]) {
  test(`theme edit preserves deadline and real primitive overrides explicit=${explicit}`, options, async t => {
    // Arrange
    const h = harness(t), r = runtime(); await h.appear(r); await h.claim(r); await h.tap(r);
    const update = parseOutputUpdate(`progress:45|label:Hi;${explicit ? 'value-color:red;label-color:blue' : 'value-color:accent;label-color:accent'}`);
    h.launches[0].callbacks.onUpdate(update); await h.idle(); await h.finish(); const due = h.sessions[0].getState().dueMs;
    // Act
    await h.send(r, 'canvas:edit', 3, { changes: { themeColor: '#abcdef' } }); await h.idle();
    // Assert
    const rendered = svg(images(r).at(-1)); assert.ok(rendered.includes('#abcdef'));
    if (explicit) { assert.ok(rendered.includes('fill="#ff0000"')); assert.ok(rendered.includes('fill="#0000ff"')); }
    else assert.deepEqual([...rendered.matchAll(/<text\b[^>]*fill="([^"]*)"/g)].map(match => match[1]), ['#abcdef', '#abcdef']);
    assert.equal(h.sessions[0].getState().dueMs, due); assert.equal(h.sessions[0].getState().enabled, true);
    assert.equal(h.launches[0].stops, 0); assert.equal(h.launches.length, 1);
    assert.deepEqual(r.writes, [{ ...base, themeColor: '#abcdef' }]);
  });
}

test('cosmetic and interval edits preserve a fatal protocol error instead of enabling retry', options, async t => {
  // Arrange
  const h = harness(t), r = runtime(); await h.appear(r); await h.claim(r); await h.tap(r);
  h.launches[0].callbacks.onError('Image protocol error.'); await h.finish({ status: 'error', error: 'Image protocol error.' });
  // Act
  await h.send(r, 'canvas:edit', 3, { changes: { themeColor: '#abcdef', intervalSeconds: 10 } }); await h.advance(100000);
  // Assert
  assert.equal(h.launches.length, 1); assert.equal(h.sessions[0].getState().protocolBlocked, true);
  assert.equal(h.sessions[0].getState().suspended, true);
  assert.equal(images(r).at(-1), createErrorArtwork('IMAGE_PROTOCOL_ERROR', '#abcdef'));
});

test('complete matching storage tolerates property order without an authority or Timer gate failure', options, async t => {
  // Arrange
  const initial = { executable: base.executable, args: ['legacy'], intervalSeconds: 5 };
  const h = harness(t), r = runtime('synthetic-order', initial); await h.appear(r); await h.claim(r);
  const read = r.getSettings;
  r.getSettings = async () => Object.fromEntries(Object.entries(await read()).reverse());
  // Act
  await h.send(r, 'canvas:edit', 3, { changes: { intervalSeconds: 10, themeColor: '#abcdef' } }); await h.tap(r); await h.finish();
  // Assert
  assert.equal(h.states[0].isBlocked(), false); assert.equal(h.sessions[0].getState().persistenceBlocked, false);
  assert.equal(h.sessions[0].getState().dueMs, 10000); assert.equal(h.launches.length, 1);
  assert.deepEqual(r.writes, [{ ...initial, intervalSeconds: 10, themeColor: '#abcdef' }]);
});

for (const failure of ['write', 'read', 'mismatch']) {
  test(`actual authority ${failure} latches STATE and refuses replacement or later writes`, options, async t => {
    // Arrange
    const h = harness(t), r = runtime(); await h.appear(r); await h.claim(r); await h.tap(r);
    if (failure === 'write') r.setSettings = async next => { r.writes.push(structuredClone(next)); throw new Error('SYNTHETIC_PRIVATE_STORAGE'); };
    if (failure === 'read') r.getSettings = async () => { throw new Error('SYNTHETIC_PRIVATE_STORAGE'); };
    if (failure === 'mismatch') r.getSettings = async () => structuredClone(base);
    // Act
    await h.send(r, 'canvas:edit', 3, { changes: { intervalSeconds: 10 } }); await h.idle(); await h.tap(r);
    await h.send(r, 'canvas:edit', 4, { changes: { executable: '/synthetic/replacement' } });
    r.device.isConnected = false; h.emit('disconnect', r.device); await h.idle();
    r.device.isConnected = true; h.emit('connect', r.device); h.emit('wake'); await h.appear(r, h.action, base); await h.advance(100000);
    // Assert
    assert.equal(h.states[0].isBlocked(), true); assert.equal(h.sessions[0].getState().persistenceBlocked, true);
    assert.equal(h.launches.length, 1); assert.equal(h.launches[0].stops, 1); assert.equal(r.writes.length, 1);
    assert.equal(images(r).at(-1), createErrorArtwork('STATE_SAVE_FAILED'));
    assert.equal(h.replies.at(-1).status, 'error'); assert.equal(h.replies.at(-1).diagnosticCode, 'STATE_SAVE_FAILED');
    assert.equal(h.logs.some(value => value.includes('SYNTHETIC_PRIVATE_STORAGE')), false);
  });
}

// Objective: Timer hide policy differs from Run; availability never invents visibility or enabled intent.
for (const returningAt of [2000, 30000]) {
  test(`hidden waiting Timer returns at ${returningAt}ms with remainder or one overdue launch and fresh metadata`, options, async t => {
    // Arrange
    const h = harness(t), r = runtime(); await h.appear(r); await h.tap(r); await h.finish();
    const original = { ...h.launches[0].env }; await h.action.onWillDisappear({ action: r }); const hiddenDisplay = [...r.display];
    // Act
    await h.advance(returningAt); const hiddenCount = h.launches.length;
    const replacement = runtime(r.id); delete replacement.device.name; delete replacement.device.size; replacement.coordinates = undefined;
    delete h.sdk.info.application.language;
    await h.appear(replacement); h.emit('wake'); h.emit('connect', replacement.device); await h.appear(replacement); await h.idle();
    const returnedCount = h.launches.length; if (returningAt < 5000) await h.advance(5000 - returningAt);
    // Assert
    assert.equal(hiddenCount, 1); assert.equal(returnedCount, returningAt < 5000 ? 1 : 2);
    assert.equal(h.launches.length, 2); assert.equal(h.launches[0].stops, 0); assert.deepEqual(r.display, hiddenDisplay);
    assert.deepEqual(h.launches[0].env, original);
    for (const key of ['ELGATO_DEVICE_NAME', 'ELGATO_DEVICE_COLUMNS', 'ELGATO_DEVICE_ROWS', 'ELGATO_KEY_COLUMN', 'ELGATO_KEY_ROW', 'ELGATO_APP_LANGUAGE']) {
      assert.equal(Object.hasOwn(h.launches[1].env, key), false);
    }
    assert.match(svg(images(replacement).at(-1)), />success<\/text>/);
    assert.deepEqual(r.writes, []); assert.deepEqual(replacement.writes, []);
  });
}

for (const terminal of ['success', 'ordinary', 'protocol']) {
  test(`hidden owned ${terminal} completion retains validated result without SDK display or next launch`, options, async t => {
    // Arrange
    const h = harness(t), r = runtime(); await h.appear(r); await h.tap(r); await h.action.onWillDisappear({ action: r });
    const hiddenDisplay = [...r.display], update = parseOutputUpdate('text:hidden-final');
    // Act
    h.launches[0].callbacks.onUpdate(update); h.launches[0].callbacks.onUpdate({ kind: 'image', image: 'invalid' });
    if (terminal === 'ordinary') h.launches[0].callbacks.onDiagnostic('PROCESS_EXITED_NONZERO');
    if (terminal === 'protocol') h.launches[0].callbacks.onError('Image protocol error.');
    await h.finish(terminal === 'success' ? { status: 'success' }
      : { status: 'error', error: terminal === 'protocol' ? 'Image protocol error.' : ordinaryError });
    await h.advance(1000); const hiddenDone = [...r.display]; await h.appear(r);
    // Assert
    assert.deepEqual(hiddenDone, hiddenDisplay); assert.equal(h.launches[0].stops, 0); assert.equal(h.launches.length, 1);
    assert.equal(images(r).at(-1), terminal === 'success' ? createPrimitiveArtwork(update)
      : createErrorArtwork(terminal === 'protocol' ? 'IMAGE_PROTOCOL_ERROR' : 'PROCESS_EXITED_NONZERO'));
    assert.equal(h.sessions[0].getState().suspended, terminal === 'protocol'); assert.deepEqual(r.writes, []);
  });
}

test('hidden running output restores latest frame without stopping or restarting owner', options, async t => {
  // Arrange
  const h = harness(t), r = runtime(); await h.appear(r); await h.tap(r);
  h.launches[0].callbacks.onUpdate(parseOutputUpdate('text:before')); await h.idle();
  await h.action.onWillDisappear({ action: r }); const hidden = [...r.display];
  // Act
  const update = parseOutputUpdate('text:latest'); h.launches[0].callbacks.onUpdate(update); await h.idle();
  const before = [...r.display]; await h.appear(r); await h.appear(r); h.emit('wake'); await h.idle();
  // Assert
  assert.deepEqual(before, hidden); assert.equal(images(r).at(-1), createPrimitiveArtwork(update));
  assert.equal(h.launches.length, 1); assert.equal(h.launches[0].stops, 0);
  assert.equal(h.sessions[0].getState().phase, 'running');
});

for (const hidden of [false, true]) {
  test(`disconnect hidden=${hidden} disables/stops Timer; foreign events and reconnect never enable`, options, async t => {
    // Arrange
    const h = harness(t), r = runtime(); await h.appear(r); await h.tap(r);
    if (hidden) await h.action.onWillDisappear({ action: r });
    // Act
    h.emit('disconnect', { id: 'synthetic-foreign-device', isConnected: false }); await h.idle(); const foreignStops = h.launches[0].stops;
    r.device.isConnected = false; h.emit('disconnect', r.device); await h.idle();
    r.device.isConnected = true; h.emit('connect', r.device); h.emit('connect', r.device); h.emit('wake'); await h.idle();
    const before = h.sessions[0].getState(); await h.appear(r); await h.advance(100000);
    // Assert
    assert.equal(foreignStops, 0); assert.equal(h.launches[0].stops, 1); assert.equal(h.launches.length, 1);
    assert.equal(before.visible, !hidden); assert.equal(before.enabled, false);
    assert.equal(h.sessions[0].getState().enabled, false); assert.equal(h.sessions[0].getState().dueMs, undefined);
    assert.match(svg(images(r).at(-1)), />ready<\/text>/); assert.deepEqual(r.writes, []);
    assert.deepEqual(h.registrations, ['connect', 'disconnect', 'wake']);
  });
}

test('real Run and Timer adapters retain separate intent/hide policies and all event subscriptions', options, async t => {
  // Arrange
  const h = harness(t), runAction = h.newRun(), timer = runtime();
  const run = runtime('synthetic-run-key', { executable: base.executable, args: [], runRequested: false }, RUN_UUID);
  await h.appear(timer); await h.appear(run, runAction); await h.tap(timer);
  // Act
  await runAction.onKeyDown({ action: run, payload: { settings: await run.getSettings() } }); await h.idle();
  await h.action.onWillDisappear({ action: timer }); await runAction.onWillDisappear({ action: run }); await h.idle();
  const hiddenStops = h.launches.map(launch => launch.stops);
  await h.appear(timer); await h.appear(run, runAction); await h.idle();
  timer.device.isConnected = false; run.device.isConnected = false; h.emit('disconnect', timer.device); await h.idle();
  timer.device.isConnected = true; run.device.isConnected = true; h.emit('connect', timer.device); h.emit('wake'); await h.idle();
  // Assert
  assert.deepEqual(hiddenStops, [0, 1]); assert.equal(h.launches.length, 4);
  assert.equal(h.launches[0].env.ELGATO_ACTION_UUID, TIMER_UUID); assert.equal(h.launches[1].env.ELGATO_ACTION_UUID, RUN_UUID);
  assert.equal(h.sessions[0].getState().enabled, false); assert.equal(h.sessions[1].getState().runRequested, true);
  assert.deepEqual(timer.writes, []); assert.deepEqual(run.writes, []);
  assert.deepEqual(h.registrations, ['connect', 'disconnect', 'wake', 'connect', 'disconnect', 'wake']);
});

// Objective: serialized native-title/image handoff must recheck current ownership after every await.
for (const invalidate of ['hide', 'stop', 'disconnect']) {
  test(`delayed Waiting title followed by ${invalidate} cannot publish stale SVG or start a generation`, options, async t => {
    // Arrange
    const h = harness(t), r = runtime('synthetic-title', { ...base, ...(invalidate === 'stop' ? { actionOnPress: 'stop' } : {}) }); await h.appear(r);
    const gate = deferred(), entered = deferred(); let delay = true;
    r.setTitle = async title => { r.display.push(['title', title]); if (delay) { delay = false; entered.resolve(); await gate.promise; } };
    const before = images(r).length;
    // Act
    await h.down(r); const launching = h.up(r); await entered.promise;
    let transition;
    if (invalidate === 'hide') transition = h.action.onWillDisappear({ action: r });
    if (invalidate === 'stop') { void h.down(r); transition = h.up(r); }
    if (invalidate === 'disconnect') { r.device.isConnected = false; h.emit('disconnect', r.device); }
    gate.resolve(); await launching; await transition; await h.idle();
    // Assert
    assert.equal(h.launches.length, 0);
    assert.ok(images(r).slice(before).every(image => !/>loading\.\.\.<\/text>/.test(svg(image))));
    assert.ok(r.display.filter(([kind]) => kind === 'title').every(([, title]) => title === ''));
    assert.equal(h.sessions[0].getState().enabled, invalidate === 'hide'); assert.deepEqual(r.writes, []);
  });
}

for (const invalidate of ['hide', 'stop', 'persistence']) {
  test(`producer held at native-title clear cannot hand off after ${invalidate}`, options, async t => {
    // Arrange
    const h = harness(t), r = runtime('synthetic-title', { ...base, ...(invalidate === 'stop' ? { actionOnPress: 'stop' } : {}) }); await h.appear(r); await h.tap(r);
    const gate = deferred(), entered = deferred(); let delay = true;
    r.setTitle = async title => { r.display.push(['title', title]); if (delay) { delay = false; entered.resolve(); await gate.promise; } };
    const before = images(r).length, stale = parseOutputUpdate('text:stale-pending');
    // Act
    h.launches[0].callbacks.onUpdate(stale); await entered.promise;
    let transition;
    if (invalidate === 'hide') transition = h.action.onWillDisappear({ action: r });
    if (invalidate === 'stop') { void h.down(r); transition = h.up(r); }
    if (invalidate === 'persistence') transition = h.sessions[0].persistenceFailed();
    gate.resolve(); await transition; await h.idle();
    // Assert
    assert.equal(images(r).includes(createPrimitiveArtwork(stale)), false);
    if (invalidate === 'hide') { assert.equal(images(r).length, before); assert.equal(h.launches[0].stops, 0); }
    else assert.equal(h.launches[0].stops, 1);
    if (invalidate === 'persistence') {
      assert.equal(images(r).at(-1), createErrorArtwork('STATE_SAVE_FAILED'));
      assert.equal(h.sessions[0].getState().persistenceBlocked, true);
    }
    assert.equal(h.launches.length, 1);
  });
}

test('invalidated in-flight image failure after hiding cannot clear an existing protocol latch', options, async t => {
  // Arrange
  const h = harness(t), r = runtime(); await h.appear(r); await h.tap(r);
  const gate = deferred(), entered = deferred(), original = r.setImage;
  r.setImage = async image => { r.display.push(['image', image]); entered.resolve(); await gate.promise; };
  // Act
  h.launches[0].callbacks.onUpdate(parseOutputUpdate('text:in-flight')); await entered.promise;
  const hiding = h.action.onWillDisappear({ action: r });
  h.launches[0].callbacks.onError('Image protocol error.');
  gate.reject(new Error('SYNTHETIC_PRIVATE_LATE_DISPLAY')); await hiding; await h.idle(); r.setImage = original;
  await h.finish({ status: 'error', error: 'Image protocol error.' }); await h.appear(r); await h.advance(100000);
  // Assert
  assert.equal(h.sessions[0].getState().protocolBlocked, true); assert.equal(h.sessions[0].getState().suspended, true);
  assert.equal(images(r).at(-1), createErrorArtwork('IMAGE_PROTOCOL_ERROR')); assert.equal(h.launches.length, 1);
  assert.equal(h.logs.some(value => value.includes('SYNTHETIC_PRIVATE_LATE_DISPLAY')), false);
});

// Slice 1 exercises the real adapters, session and authority; SDK/process/time
// Slice 2: actual adapters retain ratio DTO content through confirmed cosmetics, not settings.
for (const position of ['above', 'below']) for (const [suffix, colors] of [['', ['#abcdef', '#abcdef']], [';color:red', ['#ff0000', '#ff0000']], [';label-color:ivory', ['#abcdef', '#fffff0']], [';color:red;label-color:ivory', ['#ff0000', '#fffff0']]]) {
  test(`actual Loop text caption ${position} ${suffix || 'inherited'} survives rejected callbacks and confirmed key-local cosmetics`, options, async t => {
    // Arrange
    const h = harness(t), r = runtime(), other = runtime('synthetic-caption-other');
    await h.appear(r); await h.appear(other); await h.claim(r); await h.tap(r);
    const record = parseOutputUpdate(`text:42|font-size:48;label:Items;label-size:14.25;label-position:${position};border:2${suffix}`);
    const before = JSON.stringify(record);
    h.launches[0].callbacks.onUpdate(record); await h.idle();
    const accepted = images(r).at(-1), otherDisplay = [...other.display];
    // Act
    const missingPosition = { ...record.options }; delete missingPosition['label-position'];
    h.launches[0].callbacks.onUpdate({ ...record, options: missingPosition });
    h.launches[0].callbacks.onUpdate({ ...record, options: { ...record.options, 'label-position': position === 'above' ? 'below' : 'above' } });
    h.launches[0].callbacks.onUpdate({ ...record, options: { ...record.options, label: 'forged' } });
    const missing = { ...record.options }; delete missing['label-color'];
    h.launches[0].callbacks.onUpdate({ ...record, options: missing }); await h.idle();
    const afterRejected = images(r).at(-1); await h.finish();
    const due = h.sessions[0].getState().dueMs;
    await h.send(r, 'canvas:edit', 3, { changes: { themeColor: '#abcdef' } }); await h.idle();
    const rendered = svg(images(r).at(-1));
    // Assert
    assert.equal(afterRejected, accepted);
    assert.deepEqual([...rendered.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map(match => match[1]), position === 'above' ? ['Items', '42'] : ['42', 'Items']);
    assert.deepEqual([...rendered.matchAll(/<text\b[^>]*fill="([^"]*)"/g)].map(match => match[1]), position === 'above' ? [...colors].reverse() : colors);
    assert.match(rendered, /font-size="48"/); assert.match(rendered, /font-size="14.25"/); assert.match(rendered, /stroke="#abcdef"/);
    assert.equal(JSON.stringify(record), before); assert.equal(h.sessions[0].getState().dueMs, due);
    assert.equal(h.sessions[0].getState().enabled, true); assert.deepEqual(other.display, otherDisplay); assert.deepEqual(other.writes, []);
    assert.equal(h.launches.length, 1); assert.equal(h.launches[0].stops, 0);
    assert.deepEqual(r.writes, [{ ...base, themeColor: '#abcdef' }]);
  });
}
for (const [suffix, caption] of [['', '1.6%'], [';display:17 done', '17 done']]) {
  test(`actual Loop ratio ${suffix || 'rounded default'} redraw is key-local and deadline-neutral`, options, async t => {
    // Arrange
    const h = harness(t), r = runtime(), other = runtime('synthetic-ratio-other');
    await h.appear(r); await h.appear(other); await h.claim(r); await h.tap(r);
    const record = parseOutputUpdate(`progress:17/1034|border:2;value-color:accent${suffix}`);
    h.launches[0].callbacks.onUpdate(record); await h.idle();
    const accepted = images(r).at(-1), otherDisplay = [...other.display];
    // Act
    h.launches[0].callbacks.onUpdate({ ...record, options: { ...record.options, display: 'forged' } });
    const missing = { ...record.options }; delete missing.display;
    h.launches[0].callbacks.onUpdate({ ...record, options: missing }); await h.idle();
    const afterRejected = images(r).at(-1); await h.finish();
    const due = h.sessions[0].getState().dueMs;
    await h.send(r, 'canvas:edit', 3, { changes: { themeColor: '#abcdef' } }); await h.idle();
    const rendered = svg(images(r).at(-1));
    // Assert
    assert.equal(afterRejected, accepted);
    assert.deepEqual([...rendered.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map(match => match[1]), [caption]);
    assert.equal(/stroke-dasharray="([^"]*)"/.exec(rendered)[1], /stroke-dasharray="([^"]*)"/.exec(svg(accepted))[1]);
    assert.equal(h.sessions[0].getState().dueMs, due); assert.equal(h.sessions[0].getState().enabled, true);
    assert.deepEqual(other.display, otherDisplay); assert.deepEqual(other.writes, []);
    assert.equal(h.launches.length, 1); assert.equal(h.launches[0].stops, 0);
    assert.deepEqual(r.writes, [{ ...base, themeColor: '#abcdef' }]);
  });
}

// Slice 1 exercises the real adapters, session and authority; SDK/process/time
// are boundaries only. No UI control or live Stream Deck is exercised here.
for (const policy of [undefined, 'refresh', 'stop']) {
  test(`adapter ${policy ?? 'default Refresh'} starts disabled and routes active tap without policy persistence`, options, async t => {
    // Arrange
    const initial = { ...base, ...(policy === undefined ? {} : { actionOnPress: policy }) };
    const h = harness(t), r = runtime('synthetic-policy', initial); await h.appear(r);
    // Act
    await h.tap(r); const display = [...r.display]; await h.tap(r); const state = h.sessions[0].getState();
    // Assert
    assert.equal(h.launches.length, 1); assert.equal(h.launches[0].stops, policy === 'stop' ? 1 : 0);
    assert.equal(state.enabled, policy !== 'stop');
    if (policy !== 'stop') assert.deepEqual(r.display, display);
    assert.deepEqual(h.launches[0].settings, { executable: base.executable, args: [] });
    assert.deepEqual(await r.getSettings(), initial); assert.deepEqual(r.writes, []);
  });

  test(`adapter ${policy ?? 'default Refresh'} waiting tap ${policy === 'stop' ? 'disables' : 'refreshes'} without per-tick writes`, options, async t => {
    // Arrange
    const h = harness(t), r = runtime('synthetic-waiting', { ...base, ...(policy === undefined ? {} : { actionOnPress: policy }) });
    await h.appear(r); await h.tap(r); await h.finish(); await h.advance(2000);
    // Act
    await h.tap(r); await h.advance(100000);
    // Assert
    assert.equal(h.launches.length, policy === 'stop' ? 1 : 2); assert.equal(h.sessions[0].getState().enabled, policy !== 'stop');
    assert.equal(h.sessions[0].getState().dueMs, undefined); assert.ok(h.launches.every(launch => launch.stops === 0));
    assert.deepEqual(r.writes, []);
  });

  test(`adapter ${policy ?? 'default Refresh'} hold stops active owner regardless of short-tap policy`, options, async t => {
    // Arrange
    const h = harness(t), r = runtime('synthetic-hold-policy', { ...base, ...(policy === undefined ? {} : { actionOnPress: policy }) });
    await h.appear(r); await h.tap(r);
    // Act
    await h.down(r); const before = h.launches[0].stops;
    await h.advance(TIMER_HOLD_MS); await h.up(r); await h.up(r); await h.idle(); await h.advance(100000);
    // Assert
    assert.equal(before, 0); assert.equal(h.launches[0].stops, 1); assert.equal(h.launches.length, 1);
    assert.equal(h.sessions[0].getState().enabled, false); assert.deepEqual(r.writes, []);
  });
}

for (const policy of [undefined, 'refresh']) {
  test(`adapter ${policy ?? 'default Refresh'} active release does not defer refresh past completion`, options, async t => {
    // Arrange
    const h = harness(t), r = runtime('synthetic-ignore', { ...base, ...(policy === undefined ? {} : { actionOnPress: policy }) });
    await h.appear(r); await h.tap(r);
    // Act
    await h.tap(r); await h.advance(7000); await h.finish(); const count = h.launches.length;
    const due = h.sessions[0].getState().dueMs; await h.advance(4999); const before = h.launches.length; await h.advance(1);
    // Assert
    assert.equal(count, 1); assert.equal(due, 12000); assert.equal(before, 1); assert.equal(h.launches.length, 2);
    assert.equal(h.launches[0].stops, 0); assert.deepEqual(r.writes, []);
  });
}

for (const stage of ['disabled', 'waiting', 'running', 'hidden', 'suspended']) {
  test(`claimed backend policy-only edit while ${stage} preserves Timer state and complete configuration`, options, async t => {
    // Arrange
    const initial = { executable: base.executable, args: ['legacy literal'], intervalSeconds: 5 };
    const h = harness(t), r = runtime('synthetic-backend-policy', initial); await h.appear(r); await h.claim(r);
    if (stage !== 'disabled') await h.tap(r);
    if (stage === 'waiting' || stage === 'hidden') { await h.finish(); await h.advance(1000); }
    if (stage === 'hidden') await h.action.onWillDisappear({ action: r });
    if (stage === 'suspended') { h.launches[0].callbacks.onError('Image protocol error.'); await h.finish({ status: 'error', error: 'Image protocol error.' }); }
    const before = h.sessions[0].getState(), count = h.launches.length;
    // Act
    await h.send(r, 'canvas:edit', 3, { changes: { actionOnPress: 'stop' } }); await h.idle();
    const after = h.sessions[0].getState();
    await h.send(r, 'canvas:edit', 4, { changes: { actionOnPress: 'stop' } }); await h.idle();
    // Assert
    assert.deepEqual(after, before); assert.equal(h.launches.length, count); assert.ok(h.launches.every(launch => launch.stops === 0));
    assert.deepEqual(r.writes, [{ ...initial, actionOnPress: 'stop' }]);
    assert.deepEqual(h.states[0].getSettings(), r.writes[0]); assert.equal(h.replies.at(-1).status, 'saved');
    if (stage === 'suspended') assert.equal(images(r).at(-1), createErrorArtwork('IMAGE_PROTOCOL_ERROR'));
  });
}

test('backend accepts policy with unknown complete JSON but does not erase it or synthesize intent', options, async t => {
  // Arrange
  const initial = { executable: base.executable, args: ['legacy'], extra: { nested: [null, true, 42] } };
  const h = harness(t), r = runtime('synthetic-complete-policy', initial); await h.appear(r); await h.claim(r);
  // Act
  await h.send(r, 'canvas:edit', 3, { changes: { actionOnPress: 'stop' } }); await h.idle();
  // Assert
  assert.deepEqual(r.writes, [{ ...initial, actionOnPress: 'stop' }]); assert.equal(h.replies.at(-1).status, 'saved');
  assert.equal(h.launches.length, 0); assert.equal(h.sessions[0].getState().enabled, false);
});

test('actual Run backend rejects Timer policy while its ordinary key toggle remains unchanged', options, async t => {
  // Arrange
  const h = harness(t), runAction = h.newRun();
  const initial = { executable: base.executable, args: [], runRequested: false };
  const r = runtime('synthetic-run-policy-reject', initial, RUN_UUID); await h.appear(r, runAction);
  await h.send(r, 'canvas:hello', 1, {}, runAction); const token = h.replies.at(-1).token;
  await h.send(r, 'canvas:claim', 2, { token }, runAction);
  // Act
  await h.send(r, 'canvas:edit', 3, { changes: { actionOnPress: 'stop' } }, runAction); const rejection = h.replies.at(-1);
  const before = [...r.writes];
  await runAction.onKeyDown({ action: r, payload: { settings: initial } }); await h.idle();
  await runAction.onKeyDown({ action: r, payload: { settings: initial } }); await h.idle();
  // Assert
  assert.equal(rejection.status, 'error'); assert.deepEqual(before, []);
  assert.equal(h.launches.length, 1); assert.equal(h.launches[0].stops, 1);
  assert.equal(h.launches[0].env.ELGATO_ACTION_UUID, RUN_UUID);
  assert.deepEqual(r.writes, []);
});

test('backend policy received between key-down and key-up controls recognized active release', options, async t => {
  // Arrange
  const h = harness(t), r = runtime(); await h.appear(r); await h.claim(r); await h.tap(r); await h.down(r);
  // Act
  await h.send(r, 'canvas:edit', 3, { changes: { actionOnPress: 'stop' } }); await h.up(r); await h.idle();
  // Assert
  assert.equal(h.launches.length, 1); assert.equal(h.launches[0].stops, 1); assert.equal(h.sessions[0].getState().enabled, false);
  assert.deepEqual(r.writes, [{ ...base, actionOnPress: 'stop' }]);
});

for (const failure of ['write', 'read', 'mismatch']) {
  test(`backend policy ${failure} uncertainty never enables replacement or clears safety Error`, options, async t => {
    // Arrange
    const h = harness(t), r = runtime(); await h.appear(r); await h.claim(r); await h.tap(r);
    if (failure === 'write') r.setSettings = async next => { r.writes.push(structuredClone(next)); throw new Error('SYNTHETIC_POLICY_PRIVATE'); };
    if (failure === 'read') r.getSettings = async () => { throw new Error('SYNTHETIC_POLICY_PRIVATE'); };
    if (failure === 'mismatch') r.getSettings = async () => structuredClone(base);
    // Act
    await h.send(r, 'canvas:edit', 3, { changes: { actionOnPress: 'stop' } }); await h.idle(); await h.tap(r); await h.advance(100000);
    // Assert
    assert.equal(h.launches.length, 1); assert.equal(h.launches[0].stops, 1); assert.equal(h.states[0].isBlocked(), true);
    assert.equal(h.sessions[0].getState().persistenceBlocked, true); assert.equal(images(r).at(-1), createErrorArtwork('STATE_SAVE_FAILED'));
    assert.deepEqual(r.writes, [{ ...base, actionOnPress: 'stop' }]);
    assert.equal(h.logs.some(value => value.includes('SYNTHETIC_POLICY_PRIVATE')), false);
  });
}

test('backend pending policy confirmation preserves due time and blocks overdue launch until full match', options, async t => {
  // Arrange
  const h = harness(t), r = runtime(); await h.appear(r); await h.claim(r); await h.tap(r); await h.finish(); await h.advance(2000);
  const gate = deferred(), entered = deferred(), read = r.getSettings;
  r.getSettings = async () => { entered.resolve(); await gate.promise; return read(); };
  // Act
  const editing = h.send(r, 'canvas:edit', 3, { changes: { actionOnPress: 'stop' } }); await entered.promise;
  h.time.advance(4000); const count = h.launches.length, pending = h.sessions[0].getState();
  gate.resolve(); await editing; await h.idle();
  // Assert
  assert.equal(count, 1); assert.equal(pending.configurationPending, true); assert.equal(pending.dueMs, 5000);
  assert.equal(h.launches.length, 2); assert.equal(h.launches[0].stops, 0);
  assert.deepEqual(r.writes, [{ ...base, actionOnPress: 'stop' }]);
});

for (const policy of [undefined, 'refresh', 'stop']) {
  test(`adapter ${policy ?? 'default Refresh'} recognizes tap during stalled startup without deferred intent`, options, async t => {
    // Arrange
    const h = harness(t), r = runtime('synthetic-starting-policy', { ...base, ...(policy === undefined ? {} : { actionOnPress: policy }) });
    await h.appear(r); const gate = deferred(), entered = deferred(); let held = false;
    r.setTitle = async title => { r.display.push(['title', title]); if (!held) { held = true; entered.resolve(); await gate.promise; } };
    void h.down(r); const launching = h.up(r); await entered.promise;
    // Act
    const phase = h.sessions[0].getState().phase;
    void h.down(r); const recognized = h.up(r); gate.resolve();
    await Promise.all([launching, recognized]); await h.idle(); const count = h.launches.length;
    if (policy !== 'stop') await h.finish();
    const afterCompletion = h.launches.length; await h.advance(4999); const before = h.launches.length;
    // Assert
    assert.equal(phase, 'starting'); assert.equal(count, policy === 'stop' ? 0 : 1);
    assert.equal(afterCompletion, count); assert.equal(before, count); assert.equal(h.sessions[0].getState().enabled, policy !== 'stop');
    assert.deepEqual(r.writes, []);
  });
}

test('adapter release after owned completion uses waiting state rather than the earlier running key-down', options, async t => {
  // Arrange
  const h = harness(t), r = runtime(); await h.appear(r); await h.tap(r); await h.down(r);
  // Act
  await h.finish(); const phase = h.sessions[0].getState().phase; await h.up(r); await h.idle();
  // Assert
  assert.equal(phase, 'waiting'); assert.equal(h.launches.length, 2); assert.equal(h.launches[0].stops, 0);
  assert.deepEqual(r.writes, []);
});

for (const oldResult of ['mismatch', 'reject']) {
  test(`backend superseded policy ${oldResult} cannot poison or confirm the latest full policy/interval/theme snapshot`, options, async t => {
    // Arrange
    const h = harness(t), r = runtime(); await h.appear(r); await h.claim(r); await h.tap(r); await h.finish(); await h.advance(2000);
    const old = deferred(), entered = deferred(), read = r.getSettings; let reads = 0;
    r.getSettings = async () => { if (++reads === 1) { entered.resolve(); return old.promise; } return read(); };
    // Act
    const older = h.send(r, 'canvas:edit', 3, { changes: { actionOnPress: 'stop' } }); await entered.promise;
    const newer = h.send(r, 'canvas:edit', 4, { changes: { actionOnPress: 'refresh', intervalSeconds: 10, themeColor: '#abcdef' } });
    if (oldResult === 'reject') old.reject(new Error('SYNTHETIC_PRIVATE_POLICY_READ')); else old.resolve(base);
    await Promise.all([older, newer]); await h.idle(); const state = h.sessions[0].getState();
    // Assert
    assert.equal(h.states[0].isBlocked(), false); assert.equal(state.persistenceBlocked, false);
    assert.equal(state.enabled, true); assert.equal(state.dueMs, 12000); assert.equal(h.launches.length, 1);
    assert.deepEqual(r.writes, [{ ...base, actionOnPress: 'stop' }, { ...base, actionOnPress: 'refresh', intervalSeconds: 10, themeColor: '#abcdef' }]);
    assert.equal(h.replies.at(-1).requestId, 4); assert.equal(h.replies.at(-1).status, 'saved');
    assert.equal(h.logs.some(value => value.includes('SYNTHETIC_PRIVATE_POLICY_READ')), false);
  });
}

test('adapter hold during pending policy save safely stops but waits for confirmation before Ready', options, async t => {
  // Arrange
  const h = harness(t), r = runtime(); await h.appear(r); await h.claim(r); await h.tap(r);
  const gate = deferred(), entered = deferred(), read = r.getSettings;
  r.getSettings = async () => { entered.resolve(); await gate.promise; return read(); };
  const ready = images(r).filter(image => />ready<\/text>/.test(svg(image))).length;
  // Act
  const editing = h.send(r, 'canvas:edit', 3, { changes: { actionOnPress: 'stop' } }); await entered.promise;
  void h.down(r); h.time.advance(TIMER_HOLD_MS, false); const stopping = h.up(r); await h.launches[0].stopEntered.promise;
  const pending = h.sessions[0].getState(), count = h.launches.length;
  const readyPending = images(r).filter(image => />ready<\/text>/.test(svg(image))).length;
  gate.resolve(); await Promise.all([editing, stopping]); await h.idle(); await h.advance(100000);
  // Assert
  assert.equal(pending.configurationPending, true); assert.equal(pending.enabled, false); assert.equal(count, 1);
  assert.equal(readyPending, ready); assert.equal(h.launches[0].stops, 1); assert.equal(h.launches.length, 1);
  assert.deepEqual(r.writes, [{ ...base, actionOnPress: 'stop' }]); assert.equal(h.sessions[0].getState().dueMs, undefined);
});

test('move-integrity Loop theme-only swapped owner loses old deadline output and protocol error without saves', options, async t => {
  // Arrange
  const h = harness(t), a = { ...base, themeColor: '#123456' }, b = { ...base, themeColor: '#abcdef' };
  const c1 = runtime('loop-move-C1', a), c2 = runtime('loop-move-C2', b);
  await h.appear(c1); await h.appear(c2); await h.tap(c1);
  h.launches[0].callbacks.onUpdate(parseOutputUpdate('text:old owner')); await h.finish();
  await h.tap(c2); h.launches[1].callbacks.onError('Image protocol error.');
  await h.finish({ status: 'error', error: 'Image protocol error.' }, h.launches[1]);
  // Act
  await h.action.onWillDisappear({ action: { ...c2 } }); await h.action.onWillDisappear({ action: { ...c1 } });
  const next2 = slotWrapper(c2, a), next1 = slotWrapper(c1, b);
  await h.appear(next2); await h.appear(next1); await h.advance(100000);
  await h.claim(next1); const shown1 = h.replies.at(-1).settings;
  await h.claim(next2, 'other-move-pi'); const shown2 = h.replies.at(-1).settings;
  // Assert
  assert.equal(h.launches.length, 2);
  assert.deepEqual({ shown1, shown2 }, { shown1: b, shown2: a });
  assert.match(svg(images(next1).at(-1)), />ready<\/text>/); assert.match(svg(images(next2).at(-1)), />ready<\/text>/);
  assert.deepEqual(c1.writes, []); assert.deepEqual(c2.writes, []);
});
