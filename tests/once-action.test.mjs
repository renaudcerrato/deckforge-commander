import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadAdapterCode, createAdapterLoader } from './helpers/adapter-harness.mjs';
import { parseOutputUpdate } from '../src/core/output-update.mjs';
import { createPrimitiveArtwork } from '../src/core/primitive-artwork.mjs';
import { createErrorArtwork } from '../src/core/error-artwork.mjs';

const options = { timeout: 3000 };
const ONCE_UUID = 'git.renaudcerrato.deckforge.run';
const base = { executable: '/synthetic/report.PY', argsText: '' };
const svg = image => decodeURIComponent(image.slice('data:image/svg+xml,'.length));
const images = r => r.display.filter(([kind]) => kind === 'image').map(([, image]) => image);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function clock() {
  let time = 0, id = 0;
  const timers = new Map();
  return { now: () => time,
    setTimer(callback, delay) { const key = ++id; timers.set(key, { callback, due: time + delay }); return key; },
    clearTimer(key) { timers.delete(key); },
    advance(ms, deliver = true) {
      time += ms;
      if (!deliver) return;
      for (const [key, timer] of [...timers].sort((a, b) => a[1].due - b[1].due)) {
        if (timer.due <= time && timers.delete(key)) timer.callback();
      }
    },
  };
}
// Objective: exercise actual adapters/authority/policy/render queue; isolate only external boundaries.
// Never evaluate plugin.ts, connect the SDK, inherit user environment or create a child.
const codes = await loadAdapterCode(['once', 'run', 'timer']);
function runtime(id = 'synthetic-once-key', initial = base, manifestId = ONCE_UUID, slot) {
  // SDK wrappers are ephemeral; old and new wrappers address the same host context.
  slot ??= { value: structuredClone(initial), display: [], writes: [] };
  const { display, writes } = slot;
  return { id, manifestId, display, writes,
    slot,
    device: { id: 'synthetic-device', name: 'Fictional Deck', type: 999, size: { columns: 0, rows: 3 }, isConnected: true },
    coordinates: { column: 0, row: 2 }, isKey: () => true,
    async getSettings() { return structuredClone(slot.value); },
    async setSettings(next) { writes.push(structuredClone(next)); slot.value = structuredClone(next); },
    async setTitle(title) { display.push(['title', title]); },
    async setImage(image) { display.push(['image', image]); },
  };
}
function harness(t, platform = 'posix') {
  const time = clock(), launches = [], sessions = [], states = [], managers = [], logs = [], replies = [];
  const decorated = new Map(), listeners = new Map(), tracked = [];
  const sdk = { info: { plugin: { uuid: 'git.renaudcerrato.deckforge', version: '0.1.0.0' },
    application: { version: '7.6', language: 'fr', platform: platform === 'win32' ? 'windows' : 'mac', platformVersion: '26' } },
    logger: Object.fromEntries(['info', 'warn', 'error', 'debug', 'trace'].map(level => [level, (...values) => logs.push(...values)])),
    ui: { async sendToPropertyInspector(value) { replies.push(structuredClone(value)); } } };
  const sdkModule = { default: sdk, SingletonAction: class {},
    action: metadata => value => { decorated.set(value, metadata.UUID); return value; } };
  const register = name => listener => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(listener); return { dispose() { listeners.get(name).delete(listener); } };
  };
  const registry = { onDeviceDidConnect: register('connect'), onDeviceDidDisconnect: register('disconnect'), onSystemDidWakeUp: register('wake') };
  const syntheticProcess = { env: { PATH: '/synthetic/path', PRIVATE_ENV: 'SYNTHETIC_PRIVATE_ENV',
    ELGATO_KEY_COLUMN: 'STALE_SYNTHETIC', ELGATO_DEVICE_NAME: 'STALE_SYNTHETIC', ELGATO_ACTION_THEME_COLOR: 'STALE_SYNTHETIC' },
    cwd: () => '/synthetic/cwd', platform: platform === 'win32' ? 'win32' : 'darwin' };
  const runner = { startProcessRun(settings, callbacks, dependencies, { env }) {
    const done = deferred(), stopEntered = deferred();
    const launch = { settings: structuredClone(settings), env: { ...env }, callbacks, done, stopEntered, stops: 0, certain: true };
    launches.push(launch); callbacks.onDiagnostic('PROCESS_SPAWN_SUCCEEDED');
    return { done: done.promise, async stop() {
      launch.stops++; stopEntered.resolve();
      const certain = launch.stopGate ? await launch.stopGate.promise : launch.certain;
      done.resolve({ status: 'stopped' }); return certain;
    } };
  } };
  const capture = (module, factory, collection) => ({ ...module, [factory](dependencies) {
    const actual = module[factory](dependencies); collection.push(actual); return actual;
  } });
  const factories = new Map([
    ['once-session', ['createOnceSession', sessions]], ['timer-session', ['createTimerSession', sessions]],
    ['action-session', ['createActionSession', sessions]], ['once-settings', ['createOnceStateCoordinator', states]],
    ['timer-settings', ['createTimerStateCoordinator', states]], ['run-state', ['createRunStateCoordinator', states]],
    ['availability', ['createAvailabilityManager', managers]],
  ].map(([name, value]) => [`../core/${name}.mjs`, value]));
  const isolatedRequire = createAdapterLoader(codes, { process: syntheticProcess, resolve(name) {
    if (name === '@elgato/streamdeck') return sdkModule;
    if (name === '../core/process-runner.mjs') return runner;
  }, observe(name, actual) {
    return factories.has(name) ? capture(actual, ...factories.get(name)) : actual;
  } });
  const { OnceAction } = isolatedRequire('./once'), { RunAction } = isolatedRequire('./run'), { TimerAction } = isolatedRequire('./timer');
  const action = new OnceAction(registry, time);
  const idle = async () => {
    await Promise.all(managers.map(manager => manager.whenIdle()));
    await Promise.all(states.map(state => state.whenIdle()));
    await Promise.all(sessions.map(session => session.whenIdle()));
  };
  t.after(async () => {
    for (const launch of launches) launch.stopGate?.resolve(true);
    for (const [adapter, r] of tracked) await adapter.onWillDisappear({ action: r });
    for (const session of sessions) await session.setConnected(false);
    await idle(); for (const manager of managers) manager.dispose();
  });
  return { action, OnceAction, RunAction, TimerAction, decorated, registry, time, launches, sessions, states, logs, replies, idle, syntheticProcess,
    async appear(r, adapter = action, settings) {
      if (!tracked.some(([a, b]) => a === adapter && b === r)) tracked.push([adapter, r]);
      await adapter.onWillAppear({ action: r, payload: { settings: settings ?? await r.getSettings() } }); await idle();
    },
    down: (r, settings = base) => action.onKeyDown({ action: r, payload: { settings } }),
    up: r => action.onKeyUp({ action: r, payload: { settings: { executable: '/synthetic/stale' } } }),
    async tap(r) { await this.down(r); await this.up(r); await idle(); },
    async advance(ms, deliver = true) { time.advance(ms, deliver); await idle(); },
    async finish(result = { status: 'success' }, launch = launches.at(-1)) {
      if (result.status === 'success') launch.callbacks.onDiagnostic('PROCESS_EXITED_SUCCESSFULLY');
      launch.done.resolve(result); await Promise.resolve(); await idle();
    },
    emit(name, device) { for (const listener of listeners.get(name) ?? []) listener(name === 'wake' ? undefined : { device }); },
    send(r, type, requestId, extra = {}) { return action.onSendToPlugin({ action: r,
      payload: { type, context: r.id, inspectorId: 'synthetic-pi', requestId, ...extra } }); },
    async claim(r) { await this.send(r, 'canvas:hello', 1); await this.send(r, 'canvas:claim', 2, { token: replies.at(-1).token }); },
  };
}

// PRE-MERGE-WINDOWS-01: exercise real production logger wiring, not a trace DTO.
// WINDOWS-ARGUMENTS r1: real action/settings flow; only SDK/process boundaries are synthetic.
for (const kind of ['Stream', 'Loop', 'Run']) {
  for (const [label, argsText] of [
    ['natural', String.raw`C:\Scripts\showcase.py "C:\Program Files\input" "C:\Folder\" --flag="two words"`],
    ['existing quoted', String.raw`'C:\Scripts\showcase.py' 'C:\Program Files\input' 'C:\Folder\' '--flag=two words'`],
    ['malformed', '"private'],
  ]) {
    test(`${kind} Windows ${label} arguments reach the runner literally or reject before launch`, options, async t => {
      // Arrange
      const h = harness(t, 'win32'), adapter = kind === 'Stream' ? new h.RunAction(h.registry)
        : kind === 'Loop' ? new h.TimerAction(h.registry, h.time) : h.action;
      const uuid = kind === 'Stream' ? 'git.renaudcerrato.deckforge.stream' : kind === 'Loop' ? 'git.renaudcerrato.deckforge.loop' : ONCE_UUID;
      const settings = { executable: 'C:/python.exe', argsText, ...(kind === 'Loop' ? { intervalSeconds: 60 } : {}) };
      const r = runtime(`synthetic-${kind}-${label}`, settings, uuid);
      // Act
      await h.appear(r, adapter);
      await adapter.onKeyDown({ action: r, payload: { settings } });
      if (kind !== 'Stream') await adapter.onKeyUp({ action: r, payload: { settings } });
      await h.idle();
      // Assert
      assert.deepEqual(r.writes, []);
      if (label === 'malformed') {
        assert.deepEqual(h.launches, []);
        assert.ok(h.logs.includes('SETTINGS_REJECTED_ON_APPEAR: ARGS_TEXT_INVALID'), JSON.stringify(h.logs));
        assert.equal(JSON.stringify(h.logs).includes('private'), false);
      } else {
        assert.equal(h.launches.length, 1);
        assert.deepEqual(h.launches[0].settings, { executable: settings.executable,
          args: [String.raw`C:\Scripts\showcase.py`, String.raw`C:\Program Files\input`, 'C:\\Folder\\', '--flag=two words'] });
      }
    });
  }
}

// The process/SDK/environment are synthetic; no executable is accessed or run.
for (const kind of ['Stream', 'Loop', 'Run']) {
  for (const outcome of ['success', 'launch failure']) {
    test(`${kind} production logs retain fixed diagnostics but exclude private launch and producer data on ${outcome}`, options, async t => {
      // Arrange
      const h = harness(t), uuid = kind === 'Stream' ? 'git.renaudcerrato.deckforge.stream'
        : kind === 'Loop' ? 'git.renaudcerrato.deckforge.loop' : ONCE_UUID;
      const adapter = kind === 'Stream' ? new h.RunAction(h.registry) : kind === 'Loop' ? new h.TimerAction(h.registry, h.time) : h.action;
      const settings = { executable: '/synthetic/PRIVATE_EXECUTABLE.py', cwd: '/synthetic/PRIVATE_CWD',
        argsText: 'PRIVATE_ARG', ...(kind === 'Loop' ? { intervalSeconds: 60 } : {}) };
      const r = runtime('PRIVATE_ACTION_CONTEXT', settings, uuid);
      r.device.id = 'PRIVATE_DEVICE_ID'; r.device.name = 'PRIVATE_DEVICE_NAME';
      h.syntheticProcess.env.PRIVATE_ENV = 'PRIVATE_ENV_VALUE';
      await h.appear(r, adapter);
      const send = (type, requestId, extra = {}) => adapter.onSendToPlugin({ action: r,
        payload: { type, context: r.id, inspectorId: 'PRIVATE_INSPECTOR_ID', requestId, ...extra } });
      await send('canvas:hello', 1); await send('canvas:claim', 2, { token: h.replies.at(-1).token });
      // Act
      await adapter.onKeyDown({ action: r, payload: { settings } });
      if (kind !== 'Stream') await adapter.onKeyUp({ action: r, payload: { settings } });
      await h.idle(); const launch = h.launches[0];
      launch.callbacks.onStderrExcerpt?.('PRIVATE_STDERR');
      launch.callbacks.onLaunchError?.(JSON.stringify({ code: 'ENOENT', syscall: 'PRIVATE_SYSCALL', path: settings.executable,
        message: 'PRIVATE_RAW_EXCEPTION', stack: 'PRIVATE_STACK' }));
      const producerUpdate = parseOutputUpdate('text:PRIVATE_STDOUT|label:PRIVATE_LABEL');
      if (outcome === 'success') {
        launch.callbacks.onDiagnostic('PROCESS_STDOUT_FIRST_DATA');
        launch.callbacks.onDiagnostic('PROCESS_STDERR_FIRST_DATA');
        launch.callbacks.onUpdate(producerUpdate);
        await h.finish({ status: 'success' }, launch);
      } else {
        launch.callbacks.onDiagnostic('PROCESS_LAUNCH_FAILED');
        launch.callbacks.onDiagnostic('PROCESS_LAUNCH_REASON_ENOENT');
        await h.finish({ status: 'error', error: 'Program launch failed.' }, launch);
      }
      const beforeUntrustedTrace = [...h.logs], repliesBefore = h.replies.length;
      await send('canvas:trace', 99, { details: 'PRIVATE_TRACE', executable: settings.executable }); await h.idle();
      // Assert: fixed codes remain useful; paths/identities/settings never reach any log level.
      assert.equal(h.launches.length, 1); assert.equal(launch.settings.executable, settings.executable);
      assert.deepEqual(launch.settings.args, ['PRIVATE_ARG']); assert.equal(launch.settings.cwd, settings.cwd);
      assert.equal(launch.env.PRIVATE_ENV, 'PRIVATE_ENV_VALUE'); assert.equal(launch.env.ELGATO_ACTION_CONTEXT, r.id);
      assert.equal(launch.env.ELGATO_DEVICE_ID, r.device.id);
      assert.equal(launch.env.ELGATO_ACTION_UUID, uuid);
      assert.equal(launch.env.ELGATO_PLUGIN_UUID, 'git.renaudcerrato.deckforge');
      assert.ok(h.logs.includes('SETTINGS_ACCEPTED_ON_APPEAR')); assert.ok(h.logs.includes('SETTINGS_ACCEPTED_ON_KEY_DOWN'));
      assert.ok(h.logs.includes('PROCESS_SPAWN_SUCCEEDED'));
      for (const code of outcome === 'success' ? ['PROCESS_STDOUT_FIRST_DATA', 'PROCESS_STDERR_FIRST_DATA', 'PROCESS_EXITED_SUCCESSFULLY']
        : ['PROCESS_LAUNCH_FAILED', 'PROCESS_LAUNCH_REASON_ENOENT']) assert.ok(h.logs.includes(code));
      assert.equal(JSON.stringify(h.logs).includes('PRIVATE'), false);
      assert.deepEqual(h.logs, beforeUntrustedTrace); assert.equal(h.replies.length, repliesBefore); assert.deepEqual(r.writes, []);
      if (outcome === 'success') {
        // Privacy does not require a long captioned headline to avoid ellipsis.
        const artwork = createPrimitiveArtwork(producerUpdate);
        assert.equal(typeof artwork, 'string');
        assert.ok(images(r).includes(artwork));
      }
      else assert.match(svg(images(r).at(-1)), />Error<\/text>/);
    });
  }
  test(`${kind} invalid private configuration logs only fixed validation codes without hydration repair or launch`, options, async t => {
    // Arrange
    const h = harness(t), adapter = kind === 'Stream' ? new h.RunAction(h.registry)
      : kind === 'Loop' ? new h.TimerAction(h.registry, h.time) : h.action;
    const uuid = kind === 'Stream' ? 'git.renaudcerrato.deckforge.stream' : kind === 'Loop' ? 'git.renaudcerrato.deckforge.loop' : ONCE_UUID;
    const settings = { executable: 'PRIVATE_RELATIVE_EXECUTABLE', argsText: 'PRIVATE_ARG', cwd: '/PRIVATE_CWD',
      ...(kind === 'Loop' ? { intervalSeconds: 60 } : {}) };
    const r = runtime('PRIVATE_INVALID_CONTEXT', settings, uuid);
    // Act
    await h.appear(r, adapter);
    await adapter.onDidReceiveSettings({ action: r, payload: { settings } });
    await adapter.onKeyDown({ action: r, payload: { settings } });
    if (kind !== 'Stream') await adapter.onKeyUp({ action: r, payload: { settings } });
    await h.idle();
    // Assert
    for (const source of ['ON_APPEAR', 'ON_RECEIVE', 'ON_KEY_DOWN']) assert.ok(h.logs.includes(`SETTINGS_REJECTED_${source}: INVALID_EXECUTABLE`));
    assert.equal(JSON.stringify(h.logs).includes('PRIVATE'), false);
    assert.deepEqual(h.launches, []); assert.deepEqual(r.writes, []); assert.match(svg(images(r).at(-1)), />Error<\/text>/);
  });
}

// S2: actual shared runtime passes platform through all three adapters, authority,
// metadata and presentation; only Node/SDK/storage/process boundaries are synthetic.
for (const kind of ['Stream', 'Loop', 'Run']) {
  test(`${kind} Windows adapter launches literal drive settings only on explicit gesture and preserves complete saves`, options, async t => {
    // Arrange
    const h = harness(t, 'win32');
    const uuid = kind === 'Stream' ? 'git.renaudcerrato.deckforge.stream' : kind === 'Loop' ? 'git.renaudcerrato.deckforge.loop' : ONCE_UUID;
    const adapter = kind === 'Stream' ? new h.RunAction(h.registry) : kind === 'Loop' ? new h.TimerAction(h.registry, h.time) : h.action;
    const settings = { executable: String.raw`C:\synthetic\é report.EXE`, cwd: 'D:/synthetic work', argsText: String.raw`'C:\literal\arg' ''`,
      ...(kind === 'Stream' ? { runRequested: true } : kind === 'Loop' ? { intervalSeconds: 5 } : {}) };
    const r = runtime(`windows-${kind}`, settings, uuid);
    h.syntheticProcess.env.elgato_action_context = 'stale-alias';
    await h.appear(r, adapter);
    const freshLaunches = h.launches.length, freshWrites = [...r.writes];
    const send = (type, requestId, extra = {}) => adapter.onSendToPlugin({ action: r, payload: { type, context: r.id, inspectorId: 'windows-pi', requestId, ...extra } });
    await send('canvas:hello', 1); await send('canvas:claim', 2, { token: h.replies.at(-1).token });
    // Act
    await adapter.onKeyDown({ action: r, payload: { settings } });
    if (kind !== 'Stream') await adapter.onKeyUp({ action: r, payload: { settings } });
    await h.idle();
    const launched = h.launches[0];
    await send('canvas:edit', 3, { changes: { themeColor: '#ABCDEF' } }); await h.idle();
    const cosmeticStops = launched.stops;
    await send('canvas:edit', 4, { changes: { executable: 'D:/synthetic/new.EXE' } }); await h.idle();
    // Assert
    assert.equal(freshLaunches, 0); assert.deepEqual(freshWrites, []);
    assert.deepEqual(launched.settings, { executable: settings.executable, cwd: settings.cwd, args: [String.raw`C:\literal\arg`, ''] });
    assert.equal(launched.env.ELGATO_ACTION_CONTEXT, r.id); assert.equal(launched.env.ELGATO_APP_PLATFORM, 'windows');
    assert.equal(launched.env.ELGATO_ACTION_THEME_COLOR, '#969696');
    assert.equal(Object.hasOwn(launched.env, 'elgato_action_context'), false);
    assert.equal(cosmeticStops, 0); assert.equal(launched.stops, 1); assert.equal(h.launches.length, 1);
    assert.deepEqual(r.writes.at(-1), { ...settings, executable: 'D:/synthetic/new.EXE', themeColor: '#abcdef' });
    assert.equal(Object.hasOwn(r.writes.at(-1), 'platform'), false);
    assert.match(svg(images(r)[0]), />é report<\/text>/); assert.match(svg(images(r)[0]), />\.exe<\/text>/);
  });
  test(`${kind} Windows adapter rejects POSIX configuration without launch or hydration saves`, options, async t => {
    // Arrange
    const h = harness(t, 'win32');
    const adapter = kind === 'Stream' ? new h.RunAction(h.registry) : kind === 'Loop' ? new h.TimerAction(h.registry, h.time) : h.action;
    const r = runtime(`invalid-windows-${kind}`, { executable: '/synthetic/program', argsText: '' },
      kind === 'Stream' ? 'git.renaudcerrato.deckforge.stream' : kind === 'Loop' ? 'git.renaudcerrato.deckforge.loop' : ONCE_UUID);
    // Act
    await h.appear(r, adapter);
    await adapter.onKeyDown({ action: r, payload: { settings: await r.getSettings() } });
    if (kind !== 'Stream') await adapter.onKeyUp({ action: r, payload: { settings: await r.getSettings() } });
    await h.idle();
    // Assert
    assert.deepEqual(h.launches, []); assert.deepEqual(r.writes, []);
    assert.ok(images(r).some(image => svg(image).includes('path invalid')));
  });
}

// Slice 3: real Run adapter retains caption DTOs, rejects forgery, and never creates retry intent.
// Slice 4: actual Run adapter passes immutable LF through admission, retention and cosmetics.
test('actual Run hard lines survive rejected schema and key-local confirmed redraw without retry', options, async t => {
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
  await h.send(r, 'canvas:edit', 3, { changes: { themeColor: '#abcdef' } }); await h.idle(); await h.advance(100000000);
  const rendered = svg(images(r).at(-1));
  // Assert
  assert.equal(rejectedDisplay, accepted);
  assert.deepEqual([...rendered.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map(match => match[1]), ['A', '', 'B']);
  assert.deepEqual([...rendered.matchAll(/<text\b[^>]*fill="([^"]*)"/g)].map(match => match[1]), Array(3).fill('#abcdef'));
  assert.equal(record.value, 'A\n\nB'); assert.deepEqual(other.display, untouched); assert.deepEqual(other.writes, []);
  assert.equal(h.sessions[0].getState().phase, 'stopped'); assert.equal(Object.hasOwn(h.sessions[0].getState(), 'dueMs'), false);
  assert.equal(h.launches.length, 1); assert.equal(h.launches[0].stops, 0);
  assert.deepEqual(r.writes, [{ ...base, themeColor: '#abcdef' }]);
});
test('actual Run final hard-line SDK handoff drains before stopped and ignores malformed or stale callbacks', options, async t => {
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
    // T7: let the queued terminal operation reach its drain, not just complete()'s first callback.
    await h.launches[0].done.promise;
    await new Promise(resolve => setImmediate(resolve));
    // Assert while the image gate is closed: no premature terminal publication or replacement.
    assert.equal(h.sessions[0].getState().phase, 'stopping');
    assert.deepEqual(r.display, beforeCompletion);
    assert.equal(h.launches.length, 1);
  } finally {
    gate.resolve(); await finishing;
  }
  const retained = [...r.display];
  h.launches[0].callbacks.onUpdate(parseOutputUpdate(String.raw`text:stale\ncallback`)); await h.advance(100000000);
  // Assert
  assert.equal(h.sessions[0].getState().phase, 'stopped');
  assert.equal(images(r).at(-1), artwork); assert.deepEqual(r.display, retained); assert.deepEqual(r.writes, []);
  assert.equal(h.launches.length, 1); assert.equal(h.launches[0].stops, 0);
});
test('actual Run caption redraw is key-local without restart or retry', options, async t => {
  // Arrange: renderer tests own the position/font/color combinations.
  const h = harness(t), r = runtime(), other = runtime('synthetic-caption-other');
  await h.appear(r); await h.appear(other); await h.claim(r); await h.tap(r);
  const record = parseOutputUpdate('text:42|font-size:48;label:Items;label-size:14.25;label-position:above;border:2;label-color:ivory');
  const before = JSON.stringify(record);
  h.launches[0].callbacks.onUpdate(record); await h.idle();
  const accepted = images(r).at(-1), otherDisplay = [...other.display];
  // Act
  const missingPosition = { ...record.options }; delete missingPosition['label-position'];
  h.launches[0].callbacks.onUpdate({ ...record, options: missingPosition });
  h.launches[0].callbacks.onUpdate({ ...record, options: { ...record.options, 'label-position': 'below' } });
  h.launches[0].callbacks.onUpdate({ ...record, options: { ...record.options, label: 'forged' } });
  const missing = { ...record.options }; delete missing['label-size'];
  h.launches[0].callbacks.onUpdate({ ...record, options: missing }); await h.idle();
  const afterRejected = images(r).at(-1); await h.finish();
  await h.send(r, 'canvas:edit', 3, { changes: { themeColor: '#abcdef' } }); await h.idle(); await h.advance(100000000);
  const rendered = svg(images(r).at(-1));
  // Assert
  assert.equal(afterRejected, accepted);
  assert.deepEqual([...rendered.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map(match => match[1]), ['Items', '42']);
  assert.match(rendered, /stroke="#abcdef"/);
  assert.equal(JSON.stringify(record), before); assert.deepEqual(other.display, otherDisplay); assert.deepEqual(other.writes, []);
  assert.equal(h.sessions[0].getState().phase, 'stopped'); assert.equal(Object.hasOwn(h.sessions[0].getState(), 'dueMs'), false);
  assert.equal(h.launches.length, 1); assert.equal(h.launches[0].stops, 0);
  assert.deepEqual(r.writes, [{ ...base, themeColor: '#abcdef' }]);
});

test('actual Once decorator and manifest identify the third independent action without startup', options, async t => {
  // Arrange
  const h = harness(t);
  const manifest = JSON.parse(await readFile(new URL('../git.renaudcerrato.deckforge.sdPlugin/manifest.json', import.meta.url), 'utf8'));
  // Act
  const once = manifest.Actions.find(action => action.UUID === ONCE_UUID);
  // Assert
  assert.equal(h.decorated.get(h.OnceAction), ONCE_UUID); assert.equal(manifest.Actions.length, 3);
  assert.equal(once.Name, 'Run'); assert.equal(once.Icon, 'imgs/actions/once/icon'); assert.equal(once.PropertyInspectorPath, 'ui/run.html');
  assert.deepEqual(once.Controllers, ['Keypad']); assert.deepEqual(once.States, [{ Image: 'imgs/actions/once/key', TitleAlignment: 'bottom' }]);
  assert.deepEqual(h.launches, []); assert.deepEqual(h.sessions, []);
});
test('actual Run short release launches exactly once with literal argv and all 16 immutable metadata fields', options, async t => {
  // Arrange
  const h = harness(t), initial = { ...base, argsText: "'two words' '$HOME' '*.png'", cwd: '/synthetic/work', themeColor: '#ABCDEF' };
  const r = runtime('synthetic-key', initial), inherited = { ...h.syntheticProcess.env }; await h.appear(r);
  // Act
  await h.down(r, { executable: '/synthetic/foreign' }); const before = h.launches.length;
  await h.advance(999, false); await h.up(r); await h.up(r); await h.idle();
  // Assert
  assert.equal(before, 0); assert.equal(h.launches.length, 1);
  assert.deepEqual(h.launches[0].settings, { executable: base.executable, args: ['two words', '$HOME', '*.png'], cwd: initial.cwd });
  assert.deepEqual(h.launches[0].env, { PATH: '/synthetic/path', PRIVATE_ENV: 'SYNTHETIC_PRIVATE_ENV',
    ELGATO_PLUGIN_UUID: 'git.renaudcerrato.deckforge', ELGATO_PLUGIN_VERSION: '0.1.0.0',
    ELGATO_ACTION_UUID: ONCE_UUID, ELGATO_ACTION_CONTEXT: 'synthetic-key', ELGATO_ACTION_THEME_COLOR: '#abcdef',
    ELGATO_DEVICE_ID: 'synthetic-device', ELGATO_DEVICE_NAME: 'Fictional Deck', ELGATO_DEVICE_TYPE: '999',
    ELGATO_DEVICE_COLUMNS: '0', ELGATO_DEVICE_ROWS: '3', ELGATO_KEY_COLUMN: '0', ELGATO_KEY_ROW: '2',
    ELGATO_APP_VERSION: '7.6', ELGATO_APP_LANGUAGE: 'fr', ELGATO_APP_PLATFORM: 'mac', ELGATO_APP_PLATFORM_VERSION: '26' });
  assert.deepEqual(h.syntheticProcess.env, inherited); assert.deepEqual(r.writes, []);
  assert.match(svg(images(r).at(-1)), />Run<\/text>.*>\.py<\/text>.*>report<\/text>.*>loading\.\.\.<\/text>/);
  assert.ok(r.display.filter(([kind]) => kind === 'title').every(([, value]) => value === ''));
  assert.equal(h.logs.some(value => /two words|SYNTHETIC_PRIVATE_ENV|STALE_SYNTHETIC/.test(value)), false);
});
for (const at of [999, 1000]) for (const deliver of [false, true]) for (const busy of [false, true]) {
  test(`actual Run ${busy ? 'busy' : 'idle'} ${at}ms release timer-delivery=${deliver} never overlaps or writes intent`, options, async t => {
    // Arrange
    const h = harness(t), r = runtime(); await h.appear(r); if (busy) await h.tap(r);
    // Act
    await h.down(r); await h.down(r); await h.advance(at, deliver);
    const before = h.launches.length; await h.up(r); await h.up(r); await h.advance(100000);
    // Assert
    assert.equal(before, Number(busy)); assert.equal(h.launches.length, busy || at === 999 ? 1 : 0);
    assert.equal(h.launches[0]?.stops ?? 0, busy && at === 1000 ? 1 : 0); assert.deepEqual(r.writes, []);
    assert.equal(Object.hasOwn(h.sessions[0].getState(), 'enabled'), false); assert.equal(Object.hasOwn(h.sessions[0].getState(), 'dueMs'), false);
  });
}
for (const settings of [{}, { executable: '' }, { argsText: '/synthetic/report.py' }]) {
  test('actual Run Setup clears only plugin title and consumes all gestures without launch or hydration save', options, async t => {
    // Arrange
    const h = harness(t), r = runtime('synthetic-setup', settings); await h.appear(r);
    // Act
    await h.tap(r); await h.down(r); await h.advance(1000); await h.up(r); await h.advance(100000);
    // Assert
    assert.match(svg(images(r).at(-1)), />Run<\/text>.*aria-label="Setup required".*>setup required<\/text>/);
    assert.equal(svg(images(r).at(-1)).includes('>.py</text>'), false);
    assert.deepEqual(h.launches, []); assert.deepEqual(r.writes, []);
  });
}
test('actual Run Setup gesture stays consumed through PI selection; next deliberate tap starts', options, async t => {
  // Arrange
  const h = harness(t), r = runtime('synthetic-setup-edit', {}); await h.appear(r); await h.claim(r);
  // Act
  await h.down(r, {}); await h.send(r, 'canvas:edit', 3, { changes: { executable: base.executable } });
  await h.up(r); await h.idle(); const before = h.launches.length; await h.tap(r);
  // Assert
  assert.equal(before, 0); assert.equal(h.launches.length, 1); assert.deepEqual(r.writes, [base]);
  assert.equal(h.replies.at(-1).status, 'saved');
});
for (const input of [{ ...base, runRequested: true }, { ...base, intervalSeconds: 1 }, { ...base, actionOnPress: 'stop' },
  { ...base, executable: 'relative' }, { ...base, argsText: "'unterminated" }]) {
  test('actual Run invalid execution or foreign controls show Error without launch, hydration repair or retry', options, async t => {
    // Arrange
    const h = harness(t), r = runtime('synthetic-invalid', input);
    // Act
    await h.appear(r); await h.tap(r); await h.advance(100000);
    // Assert
    assert.match(svg(images(r).at(-1)), />Error<\/text>/); assert.deepEqual(h.launches, []); assert.deepEqual(r.writes, []);
  });
}
for (const record of [undefined, 'text:accepted', 'progress:100|label:Accepted', '<svg>opaque</svg>']) {
  test('actual Run completion retains final outcome, never auto-repeats and avoids next-manual Loading flash', options, async t => {
    // Arrange
    const h = harness(t), r = runtime(); await h.appear(r); await h.tap(r);
    const update = record ? parseOutputUpdate(record) : undefined;
    // Act
    if (update) { h.launches[0].callbacks.onUpdate(update); await h.idle(); }
    await h.finish(); const retained = [...r.display]; await h.advance(100000000); const count = h.launches.length;
    await h.tap(r);
    // Assert
    assert.equal(count, 1); assert.equal(h.launches.length, 2); assert.deepEqual(r.display, retained); assert.deepEqual(r.writes, []);
    if (update) assert.equal(images(r).at(-1), update.kind === 'image' ? update.image : createPrimitiveArtwork(update));
    else assert.match(svg(images(r).at(-1)), />Run<\/text>.*>success<\/text>/);
  });
}
test('actual Run final SDK image drain completes before stopped outcome and ignores malformed/late updates', options, async t => {
  // Arrange
  const h = harness(t), r = runtime(); await h.appear(r); await h.tap(r);
  const entered = deferred(), gate = deferred(), original = r.setImage;
  const final = parseOutputUpdate('<svg>final</svg>');
  r.setImage = async image => { await original(image); if (image === final.image) { entered.resolve(); await gate.promise; } };
  // Act
  h.launches[0].callbacks.onUpdate(final); await entered.promise;
  h.launches[0].callbacks.onUpdate({ kind: 'image', image: 'invalid' });
  const beforeCompletion = [...r.display];
  const finishing = h.finish();
  try {
    // T7: keep the image unresolved across a full event-loop boundary after completion delivery.
    await h.launches[0].done.promise;
    await new Promise(resolve => setImmediate(resolve));
    // Assert before release so bypassing terminal drain cannot pass on an early stopping snapshot.
    assert.equal(h.sessions[0].getState().phase, 'stopping');
    assert.deepEqual(r.display, beforeCompletion);
    assert.equal(h.launches.length, 1);
  } finally {
    gate.resolve(); await finishing;
  }
  const retained = [...r.display];
  h.launches[0].callbacks.onUpdate(parseOutputUpdate('<svg>late</svg>')); await h.idle();
  // Assert
  assert.equal(h.sessions[0].getState().phase, 'stopped');
  assert.equal(images(r).at(-1), final.image); assert.deepEqual(r.display, retained); assert.deepEqual(r.writes, []);
});
for (const diagnostic of ['PROCESS_EXITED_NONZERO', 'PROCESS_TERMINATED_BY_SIGNAL']) {
  test(`actual Run ${diagnostic} uses unchanged Error bytes and retries only on manual tap`, options, async t => {
    // Arrange
    const h = harness(t), r = runtime(); await h.appear(r); await h.tap(r);
    // Act
    h.launches[0].callbacks.onDiagnostic(diagnostic); await h.finish({ status: 'error', error: 'Program exited unsuccessfully.' });
    await h.advance(100000000); const image = images(r).at(-1), count = h.launches.length; await h.tap(r);
    // Assert
    assert.equal(image, createErrorArtwork(diagnostic)); assert.equal(count, 1); assert.equal(h.launches.length, 2); assert.deepEqual(r.writes, []);
  });
}
for (const loss of ['hide', 'disconnect']) {
  test(`actual Run ${loss}/wake/reappear cannot authorize another launch`, options, async t => {
    // Arrange
    const h = harness(t), r = runtime(); await h.appear(r); await h.tap(r);
    // Act
    if (loss === 'hide') {
      await h.action.onWillDisappear({ action: r }); const count = r.display.length;
      h.launches[0].callbacks.onUpdate(parseOutputUpdate('text:hidden')); await h.finish();
      assert.equal(r.display.length, count);
    } else { r.device.isConnected = false; h.emit('disconnect', r.device); await h.idle(); }
    r.device.isConnected = true; h.emit('connect', r.device); h.emit('wake'); await h.appear(r); await h.advance(100000000);
    // Assert
    assert.equal(h.launches.length, 1); assert.equal(h.launches[0].stops, loss === 'hide' ? 0 : 1);
    if (loss === 'hide') assert.match(svg(images(r).at(-1)), />hidden<\/text>/);
    assert.deepEqual(r.writes, []);
  });
}
for (const transition of ['hide', 'hold', 'disconnect', 'execution']) {
  test(`actual Run held Loading title cannot publish stale image or launch after ${transition}`, options, async t => {
    // Arrange
    const h = harness(t), r = runtime(); await h.appear(r); await h.claim(r);
    const entered = deferred(), gate = deferred(); let held = true;
    r.setTitle = async title => { r.display.push(['title', title]); if (held) { held = false; entered.resolve(); await gate.promise; } };
    const starting = h.tap(r); await entered.promise;
    // Act
    let changing;
    if (transition === 'hide') changing = h.action.onWillDisappear({ action: r });
    if (transition === 'hold') { void h.down(r); h.time.advance(1000); changing = h.up(r); }
    if (transition === 'disconnect') { r.device.isConnected = false; h.emit('disconnect', r.device); }
    if (transition === 'execution') changing = h.send(r, 'canvas:edit', 3, { changes: { argsText: 'new' } });
    gate.resolve(); await Promise.all([starting, changing]); await h.idle();
    r.device.isConnected = true; h.emit('connect', r.device); h.emit('wake'); await h.appear(r); await h.advance(100000000);
    // Assert
    assert.deepEqual(h.launches, []); assert.equal(images(r).some(image => svg(image).includes('loading...')), false);
    assert.equal(r.writes.length, transition === 'execution' ? 1 : 0);
  });
}
test('actual Run confirmed theme edit preserves busy child snapshot and affects only later manual launch', options, async t => {
  // Arrange
  const h = harness(t), r = runtime('synthetic-theme', { ...base, themeColor: '#123456' });
  const other = runtime('synthetic-other', { ...base, themeColor: '#654321' });
  await h.appear(r); await h.appear(other); await h.tap(r); await h.tap(other); await h.claim(r);
  const original = { ...h.launches[0].env }, otherDisplay = [...other.display];
  // Act
  h.launches[0].callbacks.onUpdate(parseOutputUpdate('<svg>opaque</svg>')); await h.idle();
  await h.send(r, 'canvas:edit', 3, { changes: { themeColor: '#ABCDEF' } }); await h.idle();
  await h.finish(undefined, h.launches[0]); await h.advance(100000); await h.tap(r);
  // Assert
  assert.deepEqual(h.launches[0].env, original); assert.equal(h.launches[0].stops, 0);
  assert.equal(h.launches[2].env.ELGATO_ACTION_THEME_COLOR, '#abcdef'); assert.equal(h.launches[1].env.ELGATO_ACTION_THEME_COLOR, '#654321');
  assert.equal(images(r).at(-1), parseOutputUpdate('<svg>opaque</svg>').image); assert.deepEqual(other.display, otherDisplay);
  assert.deepEqual(r.writes, [{ ...base, themeColor: '#abcdef' }]); assert.deepEqual(other.writes, []);
  assert.equal(h.logs.some(value => /#abcdef|SYNTHETIC_PRIVATE_ENV/.test(value)), false);
  assert.equal(JSON.stringify(h.replies).includes('ELGATO_'), false);
});
test('actual Run final launch gate waits for latest complete theme confirmation without an intent write', options, async t => {
  // Arrange
  const h = harness(t), r = runtime('synthetic-gate', { ...base, themeColor: '#123456' }); await h.appear(r); await h.claim(r);
  const title = deferred(), titleEntered = deferred(), saved = deferred(), saveEntered = deferred();
  const read = r.getSettings; let hold = true;
  r.setTitle = async value => { r.display.push(['title', value]); if (hold) { hold = false; titleEntered.resolve(); await title.promise; } };
  const starting = h.tap(r); await titleEntered.promise;
  r.getSettings = async () => { saveEntered.resolve(); await saved.promise; return read(); };
  // Act
  const editing = h.send(r, 'canvas:edit', 3, { changes: { themeColor: '#ABCDEF' } }); await saveEntered.promise;
  title.resolve(); const before = h.launches.length; saved.resolve(); await Promise.all([starting, editing]); await h.idle();
  // Assert
  assert.equal(before, 0); assert.equal(h.launches.length, 1); assert.equal(h.launches[0].env.ELGATO_ACTION_THEME_COLOR, '#abcdef');
  assert.deepEqual(r.writes, [{ ...base, themeColor: '#abcdef' }]);
});

// Slice 1: real adapter/authority path redraws only this key and does not launch again.
// Slice 2: a literal terminal-looking caption cannot grant completion or persisted intent.
for (const [suffix, caption] of [['', '1.6%'], [';display:100%', '100%']]) {
  test(`actual Run ratio ${suffix || 'rounded default'} retains full fill and rejects forged display`, options, async t => {
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
    const afterRejected = images(r).at(-1), active = h.sessions[0].getState().phase;
    await h.finish(); await h.send(r, 'canvas:edit', 3, { changes: { themeColor: '#abcdef' } }); await h.advance(100000000);
    const rendered = svg(images(r).at(-1));
    // Assert
    assert.equal(afterRejected, accepted); assert.equal(active, 'running');
    assert.deepEqual([...rendered.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map(match => match[1]), [caption]);
    assert.equal(/stroke-dasharray="([^"]*)"/.exec(rendered)[1], /stroke-dasharray="([^"]*)"/.exec(svg(accepted))[1]);
    assert.equal(h.sessions[0].getState().phase, 'stopped'); assert.equal(Object.hasOwn(h.sessions[0].getState(), 'dueMs'), false);
    assert.deepEqual(other.display, otherDisplay); assert.deepEqual(other.writes, []);
    assert.equal(h.launches.length, 1); assert.equal(h.launches[0].stops, 0);
    assert.deepEqual(r.writes, [{ ...base, themeColor: '#abcdef' }]);
  });
}

// Slice 1: real adapter/authority path redraws only this key and does not launch again.
for (const [suffix, expected] of [
  ['', ['#ffffff', '#ffffff']],
  [';value-color:accent;label-color:accent', ['#abcdef', '#abcdef']],
  [';color:red;value-color:accent;label-color:accent', ['#ff0000', '#ff0000']],
  [';value-color:ivory;label-color:blue', ['#fffff0', '#0000ff']],
]) {
  test(`actual Run retained annotations ${suffix || 'omitted'} survive confirmed theme edit`, options, async t => {
    // Arrange
    const h = harness(t), r = runtime(), other = runtime('synthetic-other');
    await h.appear(r); await h.appear(other); await h.claim(r); await h.tap(r);
    const record = parseOutputUpdate(`progress:42|label:Hi;border:2${suffix}`);
    h.launches[0].callbacks.onUpdate(record); await h.idle(); await h.finish();
    const otherDisplay = [...other.display];
    // Act
    h.launches[0].callbacks.onUpdate({ ...record, options: { ...record.options, 'value-color': 'accent' } });
    await h.send(r, 'canvas:edit', 3, { changes: { themeColor: '#abcdef' } }); await h.advance(100000000);
    const rendered = svg(images(r).at(-1));
    // Assert
    assert.deepEqual([...rendered.matchAll(/<text\b[^>]*fill="([^"]*)"/g)].map(match => match[1]), expected);
    assert.match(rendered, /stroke="#abcdef" stroke-width="2"/);
    assert.deepEqual(other.display, otherDisplay); assert.deepEqual(other.writes, []);
    assert.equal(h.launches.length, 1); assert.equal(h.launches[0].stops, 0);
    assert.equal(h.sessions[0].getState().phase, 'stopped');
    assert.deepEqual(r.writes, [{ ...base, themeColor: '#abcdef' }]);
  });
}
for (const changes of [{ intervalSeconds: 10 }, { actionOnPress: 'stop' }, { runRequested: true }, { executable: '' }]) {
  test('actual Run PI rejects foreign controls and empty executable without replacing busy owner', options, async t => {
    // Arrange
    const h = harness(t), r = runtime(); await h.appear(r); await h.claim(r); await h.tap(r);
    // Act
    await h.send(r, 'canvas:edit', 3, { changes }); await h.idle();
    // Assert
    assert.equal(h.replies.at(-1).status, 'error'); assert.deepEqual(r.writes, []);
    assert.equal(h.launches.length, 1); assert.equal(h.launches[0].stops, 0);
  });
}
test('actual Run complete execution edit stops safely and confirmed Ready never auto-starts', options, async t => {
  // Arrange
  const h = harness(t), r = runtime('synthetic-edit', { executable: base.executable, args: ['legacy'], argsText: '' });
  await h.appear(r); await h.claim(r); await h.tap(r);
  // Act
  await h.send(r, 'canvas:edit', 3, { changes: { executable: '/synthetic/new.sh', argsText: 'literal', cwd: '/synthetic/work' } });
  await h.advance(100000); const retained = [...r.display];
  h.launches[0].callbacks.onError('Image protocol error.'); h.launches[0].callbacks.onUpdate(parseOutputUpdate('text:late')); await h.idle();
  // Assert
  assert.equal(h.launches.length, 1); assert.equal(h.launches[0].stops, 1); assert.deepEqual(r.display, retained);
  assert.match(svg(images(r).at(-1)), />Run<\/text>.*>\.sh<\/text>.*>new<\/text>.*>ready<\/text>/);
  assert.deepEqual(r.writes, [{ executable: '/synthetic/new.sh', args: ['legacy'], argsText: 'literal', cwd: '/synthetic/work' }]);
});
for (const failure of ['cleanup', 'persistence']) {
  test(`actual Run ${failure} uncertainty cannot recover through tap, edit or reconnect`, options, async t => {
    // Arrange
    const h = harness(t), r = runtime(); await h.appear(r); await h.claim(r); await h.tap(r);
    // Act
    if (failure === 'cleanup') {
      h.launches[0].certain = false; await h.down(r); await h.advance(1000); await h.up(r); await h.idle();
    } else {
      r.getSettings = async () => { throw Error('SYNTHETIC_PRIVATE_EXCEPTION'); };
      await h.send(r, 'canvas:edit', 3, { changes: { themeColor: '#abcdef' } }); await h.idle();
    }
    await h.tap(r); await h.send(r, 'canvas:edit', 4, { changes: { argsText: 'replacement' } });
    r.device.isConnected = false; h.emit('disconnect', r.device); await h.idle();
    r.device.isConnected = true; h.emit('connect', r.device); h.emit('wake');
    await h.appear(r, h.action, h.states[0].getSettings()); await h.advance(100000);
    // Assert
    assert.equal(h.launches.length, 1); assert.equal(images(r).at(-1), createErrorArtwork(
      failure === 'cleanup' ? 'CLEANUP_BLOCKED' : 'STATE_SAVE_FAILED', failure === 'cleanup' ? undefined : '#abcdef'));
    assert.equal(h.logs.some(value => /SYNTHETIC_PRIVATE_EXCEPTION|replacement/.test(value)), false);
    assert.deepEqual(r.writes, [failure === 'cleanup' ? { ...base, argsText: 'replacement' } : { ...base, themeColor: '#abcdef' }]);
  });
}
test('actual three action adapters and fresh Run instance never share transient output or launch intent', options, async t => {
  // Arrange
  const h = harness(t), once = runtime('synthetic-once-context');
  const stream = runtime('synthetic-stream-context', base, 'git.renaudcerrato.deckforge.stream');
  const loop = runtime('synthetic-loop-context', { ...base, intervalSeconds: 1 }, 'git.renaudcerrato.deckforge.loop');
  const streamAdapter = new h.RunAction(h.registry), loopAdapter = new h.TimerAction(h.registry, h.time);
  await h.appear(once); await h.appear(stream, streamAdapter); await h.appear(loop, loopAdapter);
  const streamDisplay = [...stream.display], loopDisplay = [...loop.display];
  // Act
  await h.tap(once); h.launches[0].callbacks.onUpdate(parseOutputUpdate('text:once-only')); await h.finish();
  const fresh = runtime('synthetic-fresh'); await h.appear(fresh, new h.OnceAction(h.registry, h.time)); await h.advance(100000);
  // Assert
  assert.equal(h.launches.length, 1); assert.deepEqual(stream.display, streamDisplay); assert.deepEqual(loop.display, loopDisplay);
  assert.match(svg(images(fresh).at(-1)), />ready<\/text>/); assert.equal(svg(images(fresh).at(-1)).includes('once-only'), false);
  assert.deepEqual(once.writes, []); assert.deepEqual(stream.writes, []); assert.deepEqual(loop.writes, []); assert.deepEqual(fresh.writes, []);
});

// settings-move-integrity rev2: contexts are host slots, not durable action identities.
function moveFacade(h, kind) {
  const adapter = kind === 'Stream' ? new h.RunAction(h.registry)
    : kind === 'Loop' ? new h.TimerAction(h.registry, h.time) : h.action;
  const uuid = kind === 'Stream' ? 'git.renaudcerrato.deckforge.stream'
    : kind === 'Loop' ? 'git.renaudcerrato.deckforge.loop' : ONCE_UUID;
  return { adapter, uuid,
    async tap(r) {
      const event = { action: r, payload: { settings: await r.getSettings() } };
      await adapter.onKeyDown(event);
      if (kind !== 'Stream') await adapter.onKeyUp(event);
      await h.idle();
    },
    send(r, type, requestId, extra = {}, inspectorId = 'move-pi') {
      return adapter.onSendToPlugin({ action: r, payload: { type, context: r.id, inspectorId, requestId, ...extra } });
    },
    async claim(r, inspectorId = 'move-pi') {
      await this.send(r, 'canvas:hello', 1, {}, inspectorId);
      await this.send(r, 'canvas:claim', 2, { token: h.replies.at(-1).token }, inspectorId);
    },
  };
}
function movedWrapper(r, settings, manifestId = r.manifestId) {
  r.slot.value = structuredClone(settings);
  return runtime(r.id, settings, manifestId, r.slot);
}

for (const kind of ['Stream', 'Loop', 'Run']) {
  test(`move-integrity ${kind} exact A/B swap reopens PI on moved snapshots without hydration writes`, options, async t => {
    // Arrange: match the observed C2-disappear, C1-disappear, C2-A, C1-B trace.
    const h = harness(t), f = moveFacade(h, kind);
    const a = { ...base, title: 'A', themeColor: '#123456' };
    const b = { ...base, executable: '/synthetic/B.sh', title: 'B', themeColor: '#654321' };
    const c1 = runtime('move-C1', a, f.uuid), c2 = runtime('move-C2', b, f.uuid);
    await h.appear(c1, f.adapter); await h.appear(c2, f.adapter);
    await f.claim(c1, 'old-pi');
    // Act
    await f.adapter.onWillDisappear({ action: runtime(c2.id, b, f.uuid, c2.slot) });
    await f.adapter.onWillDisappear({ action: runtime(c1.id, a, f.uuid, c1.slot) });
    const next2 = movedWrapper(c2, a), next1 = movedWrapper(c1, b);
    await h.appear(next2, f.adapter); await h.appear(next1, f.adapter);
    await f.claim(next2, 'new-A-pi'); const shownA = h.replies.at(-1).settings;
    await f.claim(next1, 'new-B-pi'); const shownB = h.replies.at(-1).settings;
    const hydrationWrites = [c1.writes.length, c2.writes.length];
    await f.send(next1, 'canvas:edit', 3, { changes: { title: 'B edited', themeColor: '#ABCDEF' } }, 'new-B-pi');
    await h.idle();
    // Assert: the moved key owns the complete snapshot; its neighbor is untouched.
    assert.deepEqual({ shownA, shownB }, { shownA: a, shownB: b });
    assert.deepEqual(hydrationWrites, [0, 0]); assert.deepEqual(h.launches, []);
    assert.deepEqual(c1.writes, [{ ...b, title: 'B edited', themeColor: '#abcdef' }]);
    assert.deepEqual(c2.writes, []); assert.deepEqual(await c2.getSettings(), a);
  });

  for (const destination of ['empty', 'previously occupied']) {
    test(`move-integrity ${kind} moves into ${destination} context stopped with no inherited output or error`, options, async t => {
      // Arrange
      const h = harness(t), f = moveFacade(h, kind), a = { ...base, title: 'moved A' };
      const source = runtime('move-source', a, f.uuid), target = runtime('move-target', { ...base, title: 'old B' }, f.uuid);
      await h.appear(source, f.adapter);
      if (destination === 'previously occupied') {
        await h.appear(target, f.adapter); await f.tap(target);
        h.launches[0].callbacks.onError('Image protocol error.');
        await h.finish({ status: 'error', error: 'Image protocol error.' });
        await f.adapter.onWillDisappear({ action: runtime(target.id, target.slot.value, f.uuid, target.slot) });
      }
      // Act
      await f.adapter.onWillDisappear({ action: runtime(source.id, a, f.uuid, source.slot) });
      const moved = movedWrapper(target, a); await h.appear(moved, f.adapter);
      await f.claim(moved); const snapshot = h.replies.at(-1).settings;
      const before = h.launches.length, artwork = svg(images(moved).at(-1));
      await f.tap(moved);
      // Assert
      assert.deepEqual(snapshot, a); assert.match(artwork, />moved A<\/text>.*>ready<\/text>/);
      assert.equal(h.launches.length, before + 1);
      assert.deepEqual(target.writes, []); assert.deepEqual(source.writes, []);
    });
  }

  test(`move-integrity ${kind} unchanged fresh wrappers preserve local edits while visible restores stay ignored`, options, async t => {
    // Arrange
    const h = harness(t), f = moveFacade(h, kind), r = runtime('move-unchanged', base, f.uuid);
    await h.appear(r, f.adapter); await f.claim(r);
    await f.send(r, 'canvas:edit', 3, { changes: { title: 'local' } }); await h.idle();
    const local = await r.getSettings(), foreign = { ...base, title: 'restore' };
    // Act: different visible payloads and DidReceiveSettings are not move evidence.
    await f.adapter.onDidReceiveSettings({ action: runtime(r.id, local, f.uuid, r.slot), payload: { settings: foreign } });
    await h.appear(runtime(r.id, local, f.uuid, r.slot), f.adapter, foreign);
    await f.adapter.onWillDisappear({ action: runtime(r.id, local, f.uuid, r.slot) });
    await h.appear(runtime(r.id, local, f.uuid, r.slot), f.adapter, local);
    await f.claim(r, 'reopened');
    // Assert
    assert.deepEqual(h.replies.at(-1).settings, local); assert.deepEqual(r.writes, [{ ...base, title: 'local' }]);
    assert.deepEqual(h.launches, []);
  });

  test(`move-integrity ${kind} title-only new owner fences old claims and preserves unknown legacy JSON on save`, options, async t => {
    // Arrange: unknown fields deliberately need not be executable to retain authority.
    const h = harness(t), f = moveFacade(h, kind);
    const a = { ...base, args: ['legacy', ''], extra: { nested: [null, true, 42] }, title: 'A' };
    const b = { ...a, title: 'B' }, r = runtime('move-cosmetic', a, f.uuid);
    await h.appear(r, f.adapter); await f.claim(r, 'old-owner');
    await f.send(r, 'canvas:hello', 1, {}, 'pending-claim'); const token = h.replies.at(-1).token;
    // Act
    await f.adapter.onWillDisappear({ action: runtime(r.id, a, f.uuid, r.slot) });
    const next = movedWrapper(r, b); await h.appear(next, f.adapter);
    const repliesBefore = h.replies.length;
    await f.send(r, 'canvas:claim', 2, { token }, 'pending-claim');
    await f.send(r, 'canvas:edit', 3, { changes: { title: 'stale edit' } }, 'old-owner');
    const staleTraffic = [h.replies.length - repliesBefore, r.writes.length];
    await f.claim(next, 'new-owner');
    await f.send(next, 'canvas:edit', 3, { changes: { themeColor: '#ABCDEF' } }, 'new-owner'); await h.idle();
    // Assert
    assert.deepEqual(staleTraffic, [0, 0]);
    assert.deepEqual(r.writes, [{ ...b, themeColor: '#abcdef' }]); assert.deepEqual(h.launches, []);
  });
}

for (const [from, to] of [['Stream', 'Loop'], ['Loop', 'Run'], ['Run', 'Stream']]) {
  test(`move-integrity mixed ${from} to ${to} context reuse waits for old ownership cleanup`, options, async t => {
    // Arrange
    const h = harness(t), old = moveFacade(h, from), next = moveFacade(h, to);
    const r = runtime('mixed-slot', { ...base, title: from }, old.uuid);
    await h.appear(r, old.adapter); await old.tap(r);
    const launch = h.launches[0], gate = deferred(); launch.stopGate = gate;
    t.after(() => gate.resolve(true));
    // Act: Loop/Run may finish hidden, but replacement must retire their owned child.
    const hiding = old.adapter.onWillDisappear({ action: runtime(r.id, r.slot.value, old.uuid, r.slot) });
    const moved = movedWrapper(r, { ...base, title: to }, next.uuid);
    const appearing = next.adapter.onWillAppear({ action: moved, payload: { settings: moved.slot.value } });
    const pressing = next.tap(moved);
    // A launch boundary is synchronous once reached; drain microtasks without real time.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    const pending = { launches: h.launches.length, stops: launch.stops };
    gate.resolve(true); await Promise.all([hiding, appearing, pressing]); await h.idle();
    // Assert
    assert.deepEqual(pending, { launches: 1, stops: 1 });
    assert.ok(h.launches.length <= 2); assert.deepEqual(r.writes, []);
  });
}

for (const kind of ['Stream', 'Loop', 'Run']) {
  test(`move-integrity ${kind} queued unsent old-owner edit cannot write the reused host slot`, options, async t => {
    // Arrange
    const h = harness(t), f = moveFacade(h, kind), a = { ...base, title: 'A' }, b = { ...base, title: 'B' };
    const r = runtime('move-unsent', a, f.uuid); await h.appear(r, f.adapter); await f.claim(r, 'old');
    // Act: all three calls occur in one turn, before the authority's queued write dispatch.
    const editing = f.send(r, 'canvas:edit', 3, { changes: { title: 'obsolete' } }, 'old');
    const hiding = f.adapter.onWillDisappear({ action: runtime(r.id, a, f.uuid, r.slot) });
    const moved = movedWrapper(r, b);
    const appearing = f.adapter.onWillAppear({ action: moved, payload: { settings: b } });
    await Promise.all([editing, hiding, appearing]); await h.idle();
    await f.claim(moved, 'new'); const shown = h.replies.at(-1).settings;
    // Assert
    assert.deepEqual(r.writes, []); assert.deepEqual(await r.getSettings(), b); assert.deepEqual(shown, b);
    assert.equal(h.replies.some(reply => reply.inspectorId === 'old' && reply.requestId === 3 && reply.status === 'saved'), false);
    assert.deepEqual(h.launches, []);
  });

  test(`move-integrity ${kind} dispatched unconfirmed write quarantines reused context and fences late readback`, options, async t => {
    // Arrange: an already dispatched host write cannot be revoked by replacing its wrapper.
    const h = harness(t), f = moveFacade(h, kind), a = { ...base, title: 'A' }, b = { ...base, title: 'B' };
    const r = runtime('move-dispatched', a, f.uuid); await h.appear(r, f.adapter); await f.claim(r, 'old');
    const entered = deferred(), read = deferred();
    r.getSettings = async () => { entered.resolve(); return read.promise; };
    const editing = f.send(r, 'canvas:edit', 3, { changes: { title: 'old dispatched' } }, 'old');
    await entered.promise;
    // Act
    const hiding = f.adapter.onWillDisappear({ action: runtime(r.id, r.slot.value, f.uuid, r.slot) });
    const moved = movedWrapper(r, b);
    const appearing = f.adapter.onWillAppear({ action: moved, payload: { settings: b } });
    read.resolve({ ...a, title: 'old dispatched' });
    await Promise.all([editing, hiding, appearing]); await h.idle();
    await f.claim(moved, 'new');
    await f.send(moved, 'canvas:edit', 3, { changes: { title: 'must not save' } }, 'new');
    await f.tap(moved);
    // Assert: no stale success, no second write, no execution even after a matching old readback.
    assert.deepEqual(r.writes, [{ ...a, title: 'old dispatched' }]); assert.deepEqual(h.launches, []);
    assert.equal(h.replies.some(reply => reply.inspectorId === 'old' && reply.requestId === 3 && reply.status === 'saved'), false);
    assert.match(svg(images(moved).at(-1)), />Error<\/text>/);
    assert.deepEqual(moved.slot.value, b);
  });
}

for (const kind of ['Loop', 'Run']) {
  test(`move-integrity ${kind} cleanup-only uncertainty blocks moved execution but permits complete configuration save`, options, async t => {
    // Arrange
    const h = harness(t), f = moveFacade(h, kind), a = { ...base, title: 'A' }, b = { ...base, title: 'B' };
    const r = runtime('move-uncertain-cleanup', a, f.uuid); await h.appear(r, f.adapter); await f.tap(r);
    h.launches[0].certain = false;
    // Act
    await f.adapter.onWillDisappear({ action: runtime(r.id, a, f.uuid, r.slot) });
    const moved = movedWrapper(r, b); await h.appear(moved, f.adapter);
    await f.claim(moved, 'new');
    await f.send(moved, 'canvas:edit', 3, { changes: { argsText: 'B-local' } }, 'new'); await h.idle();
    await f.tap(moved);
    // Assert: cleanup and persistence uncertainty are separate safety gates.
    assert.equal(h.launches.length, 1); assert.equal(h.launches[0].stops, 1);
    assert.deepEqual(r.writes, [{ ...b, argsText: 'B-local' }]); assert.equal(h.replies.at(-1).status, 'saved');
    assert.equal(images(moved).at(-1), createErrorArtwork('CLEANUP_BLOCKED'));
  });
}

test('move-integrity Run superseded A to B to C transitions fence held display and old producer callbacks', options, async t => {
  // Arrange
  const h = harness(t), f = moveFacade(h, 'Run'), a = { ...base, title: 'A' };
  const r = runtime('move-superseded', a); await h.appear(r); await f.tap(r);
  const entered = deferred(), gate = deferred(), title = r.setTitle;
  r.setTitle = async value => { await title(value); entered.resolve(); await gate.promise; };
  const stale = parseOutputUpdate('text:obsolete A'); h.launches[0].callbacks.onUpdate(stale); await entered.promise;
  // Act
  const hidingA = f.adapter.onWillDisappear({ action: { ...r } });
  const b = movedWrapper(r, { ...base, title: 'B' });
  const showingB = f.adapter.onWillAppear({ action: b, payload: { settings: b.slot.value } });
  const hidingB = f.adapter.onWillDisappear({ action: { ...b } });
  const c = movedWrapper(r, { ...base, title: 'C' });
  const showingC = f.adapter.onWillAppear({ action: c, payload: { settings: c.slot.value } });
  gate.resolve(); await Promise.all([hidingA, showingB, hidingB, showingC]); await h.idle();
  const settled = [...r.display];
  h.launches[0].callbacks.onUpdate(parseOutputUpdate('text:late A'));
  h.launches[0].callbacks.onError('Image protocol error.'); await h.idle();
  await f.claim(c, 'C');
  // Assert
  assert.equal(images(c).includes(createPrimitiveArtwork(stale)), false);
  assert.match(svg(images(c).at(-1)), />C<\/text>.*>ready<\/text>/);
  assert.deepEqual(r.display, settled); assert.deepEqual(h.replies.at(-1).settings, { ...base, title: 'C' });
  assert.equal(h.launches.length, 1); assert.equal(h.launches[0].stops, 1); assert.deepEqual(r.writes, []);
});
