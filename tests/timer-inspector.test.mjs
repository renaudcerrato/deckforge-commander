import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createInspectorBridge, RUN_ACTION_UUID, TIMER_ACTION_UUID, ONCE_ACTION_UUID } from '../src/inspector/bridge.mjs';
import { createInspectorController } from '../src/inspector/run.mjs';
import { getTimerInspectorConfiguration, validateTimerSettings, classifyTimerSettings } from '../src/core/timer-settings.mjs';
import { parseArguments } from '../src/core/arguments.mjs';

const initial = { executable: '/synthetic/program', argsText: '', cwd: '', intervalSeconds: 60 };
const intervalError = 'Enter whole seconds from 1 to 86400.';
const pressError = 'Choose start / refresh or start / stop.';
const presets = [['1', '1s'], ['10', '10s'], ['30', '30s'], ['60', '1mn'], ['600', '10mn'], ['1800', '30mn'], ['3600', '1h']];
const asset = name => readFileSync(new URL(`../git.renaudcerrato.deckforge.sdPlugin/ui/${name}`, import.meta.url), 'utf8');

// SDPI's value setter synchronously dispatches a direct, non-bubbling valuechange
// with no detail. Only DOM, transport, clocks and SDK/storage/process boundaries are doubled.
function control(value = '') {
  const listeners = new Map();
  return {
    get value() { return value; },
    set value(next) { value = typeof next === 'string' ? next.replace(/[\r\n]/g, '') : next; this.dispatch('valuechange'); },
    addEventListener(name, listener) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(listener); },
    removeEventListener(name, listener) { listeners.get(name)?.delete(listener); },
    dispatch(name) { for (const listener of listeners.get(name) ?? []) listener({ type: name, bubbles: false }); },
  };
}
// Attribute text and visible hint are separate public component boundaries.
// Do not emulate LocalizedMessage or Lit's private change-detection machinery.
function cwdControl() {
  const field = control(), attributes = new Map([['placeholder', '/absolute/path/to/working-directory']]);
  let renderedHint = attributes.get('placeholder');
  Object.assign(field, {
    getAttribute(name) { return attributes.get(name) ?? null; },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    requestUpdate() { renderedHint = attributes.get('placeholder'); },
  });
  Object.defineProperties(field, {
    placeholder: { set(value) { if (typeof value === 'string') throw new TypeError('SDPI placeholder property does not accept text.'); } },
    renderedHint: { get() { return renderedHint; } },
  });
  return field;
}
function fields() {
  return { executable: control(), argsText: control(), cwd: cwdControl(), title: cwdControl(), themeColor: control('#606060'),
    intervalPreset: control(), intervalSeconds: control(), actionOnPress: control(), timerControls: { hidden: true }, customInterval: { hidden: true },
    status: { textContent: '', set innerHTML(_) { throw new Error('Status must be plaintext'); } } };
}
function clock() {
  let time = 0, id = 0;
  const timers = new Map();
  return {
    timers, now: () => time,
    setTimer(callback, delay) { const key = ++id; timers.set(key, { callback, delay, due: time + delay }); return key; },
    clearTimer(key) { timers.delete(key); },
    tick(delay) { for (const [key, timer] of [...timers]) if (timer.delay === delay && timers.delete(key)) timer.callback(); },
    advance(ms) { time += ms; for (const [key, timer] of [...timers]) if (timer.due <= time && timers.delete(key)) timer.callback(); },
  };
}
const edits = socket => socket.sent.filter(message => message.payload?.type === 'canvas:edit');
const normal = socket => socket.sent;
function harness({ built = false, loading = false } = {}) {
  const f = fields(), time = clock(), sockets = [], errors = [], states = [], events = new Map();
  let controller, bridge, chained = 0;
  class Socket {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(text) { this.sent.push(JSON.parse(text)); }
    close() { this.closed = true; this.readyState = 3; }
  }
  let connect, dispose;
  if (built) {
    const window = { connectElgatoStreamDeckSocket() { chained++; }, addEventListener(name, fn) { events.set(name, fn); } };
    const ids = { ...f, 'timer-controls': f.timerControls, 'custom-interval': f.customInterval, 'settings-status': f.status };
    const document = { readyState: loading ? 'loading' : 'complete', getElementById: id => ids[id],
      addEventListener(name, fn) { events.set(name, fn); } };
    runInNewContext(asset('run.js'), { window, document, WebSocket: Socket, TextEncoder,
      Date: class extends Date { static now() { return 123; } }, Math: Object.assign(Object.create(Math), { random: () => 0.25 }),
      setTimeout: time.setTimer, clearTimeout: time.clearTimer }, { timeout: 1000 });
    connect = (...args) => window.connectElgatoStreamDeckSocket(...args);
    dispose = () => events.get('unload')();
  } else {
    bridge = createInspectorBridge({ inspectorId: 'synthetic-pi', createSocket: url => new Socket(url),
      setTimer: time.setTimer, clearTimer: time.clearTimer,
      onSettings: (config, protectedFields) => controller.hydrate(config, protectedFields),
      onError(code, stage) { errors.push(code); controller.showError(code, stage); },
      onStatus: value => controller.showStatus(value),
      onConnectionState(snapshot) { states.push(snapshot); controller?.setActionBinding(snapshot); },
    });
    controller = createInspectorController({ ...f, bridge });
    connect = bridge.connect;
    dispose = () => { controller.dispose(); bridge.disconnect(); };
  }
  const last = () => normal(sockets.at(-1)).at(-1).payload;
  const reply = (payload, socket = sockets.at(-1)) => socket.onmessage({ data: JSON.stringify({ event: 'sendToPropertyInspector', payload }) });
  const bind = (settings = initial, action = TIMER_ACTION_UUID, context = 'synthetic-key', info = '{}') => {
    connect('12345', 'transport-pi', 'registerPropertyInspector', info, JSON.stringify({ context, action, payload: { settings } }));
  };
  const open = () => { sockets.at(-1).readyState = 1; sockets.at(-1).onopen(); };
  const claim = (settings = initial) => {
    reply({ ...last(), type: 'canvas:reply', status: 'challenge', token: 'synthetic-token', settings });
    reply({ ...last(), type: 'canvas:reply', status: 'saved', settings });
  };
  const ready = (settings = initial, action = TIMER_ACTION_UUID, context = 'synthetic-key', info = '{}') => { bind(settings, action, context, info); open(); claim(settings); };
  return { f, time, sockets, errors, states, events, bridge, controller, connect, bind, open, claim, ready, last, reply, dispose,
    chained: () => chained, edits: () => edits(sockets.at(-1)) };
}

// Plain errors: transport diagnostics never become visible suffixes or raw reply text.
for (const built of [false, true]) for (const [name, action] of [
  ['Stream', RUN_ACTION_UUID], ['Loop', TIMER_ACTION_UUID], ['Run', ONCE_ACTION_UUID],
]) for (const [label, diagnostics, expected] of [
  ['recognized code and stage', { diagnosticCode: 'INVALID_SETTINGS', diagnosticStage: 'PLUGIN_REPLY' }, 'Settings need correction.'],
  ['missing stage', { diagnosticCode: 'INVALID_SETTINGS' }, 'Settings need correction.'],
  ['unknown stage', { diagnosticCode: 'INVALID_SETTINGS', diagnosticStage: 'unknown-stage' }, 'Settings need correction.'],
  ['untrusted stage', { diagnosticCode: 'INVALID_SETTINGS', diagnosticStage: '<script>PRIVATE_STAGE</script>' }, 'Settings need correction.'],
  ['missing code', { diagnosticStage: 'PLUGIN_REPLY' }, 'Settings could not be confirmed.'],
  ['missing diagnostics', {}, 'Settings could not be confirmed.'],
  ['unknown code', { diagnosticCode: 'UNKNOWN_CODE', diagnosticStage: 'PLUGIN_REPLY' }, 'Settings could not be confirmed.'],
  ['untrusted diagnostics', { diagnosticCode: '<script>PRIVATE_CODE</script>', diagnosticStage: { private: 'PRIVATE_STAGE' } }, 'Settings could not be confirmed.'],
]) {
  test(`${built ? 'built' : 'source'} ${name} shows fixed plain error for ${label}`, () => {
    // Arrange
    const h = harness({ built }); h.ready(initial, action);
    h.f.argsText.value = 'local-edit'; h.time.tick(200);
    const request = h.last();
    // Act
    h.reply({ ...request, type: 'canvas:reply', status: 'error', ...diagnostics });
    // Assert
    assert.equal(h.f.status.textContent, expected);
    assert.equal(h.f.argsText.value, 'local-edit');
    assert.equal(h.edits().length, 1);
    h.dispose();
  });
}

// UUID-1: public identities select Loop-only controls; historical names are not aliases.
for (const built of [false, true]) {
  for (const [action, loop, valid] of [
    ['git.renaudcerrato.deckforge.stream', false, true],
    ['git.renaudcerrato.deckforge.loop', true, true],
    ['git.renaudcerrato.deckforge.run', false, true],
    ['git.renaudcerrato.deckforge.timer', false, false],
    ['git.renaudcerrato.deckforge.once', false, false],
  ]) {
    test(`UUID-1 ${built ? 'built' : 'source'} ${action} permits scheduling controls only for Loop`, () => {
      // Arrange
      const h = harness({ built });
      // Act
      h.ready(initial, action);
      h.f.intervalPreset.value = '10';
      if (loop) h.reply({ ...h.last(), type: 'canvas:reply', status: 'saved', settings: { ...initial, intervalSeconds: 10 } });
      h.f.actionOnPress.value = 'stop'; h.time.tick(200);
      const changes = h.edits().map(message => message.payload.changes);
      // Assert
      assert.equal(h.f.timerControls.hidden, !loop);
      assert.deepEqual(changes, loop ? [{ intervalSeconds: 10 }, { actionOnPress: 'stop' }] : []);
      if (!built) assert.equal(h.bridge.getConnectionState().bindingValid, valid);
      assert.ok(h.sockets[0].sent.filter(message => message.event === 'sendToPlugin').every(message => message.action === action));
      h.dispose();
    });
  }
}
test('UUID-1 inspector exports the breaking mapping without reassigning Stream to one-shot Run', () => {
  // Arrange
  const expected = ['git.renaudcerrato.deckforge.stream', 'git.renaudcerrato.deckforge.loop', 'git.renaudcerrato.deckforge.run'];
  // Act
  const actual = [RUN_ACTION_UUID, TIMER_ACTION_UUID, ONCE_ACTION_UUID];
  // Assert
  assert.deepEqual(actual, expected);
  assert.notEqual(RUN_ACTION_UUID, ONCE_ACTION_UUID);
  assert.equal(actual.some(uuid => uuid.endsWith('.timer') || uuid.endsWith('.once')), false);
});

for (const built of [false, true]) {
  test(`TITLE-1 Loop inspector title uses shared saved-only control and debounce (built=${built})`, () => {
    // Arrange
    const h = harness({ built }); h.ready({ ...initial, executable: '/report.PY', title: 'saved' });
    const hydration = [...h.edits()];
    // Act
    h.f.title.value = 'a/b.txt'; const before = h.edits().length; h.time.tick(200); const request = h.last();
    h.reply({ ...request, type: 'canvas:reply', status: 'saved', settings: { ...initial, executable: '/report.PY', title: 'a/b.txt' } });
    h.f.title.value = ''; h.time.tick(200); const clear = h.last();
    // Assert
    assert.deepEqual(hydration, []); assert.equal(before, 0); assert.equal(h.f.title.renderedHint, 'report');
    assert.deepEqual(JSON.parse(JSON.stringify(request.changes)), { title: 'a/b.txt' });
    assert.deepEqual(JSON.parse(JSON.stringify(clear.changes)), { title: '' });
    assert.equal(h.f.timerControls.hidden, false); assert.deepEqual(h.errors, []); h.dispose();
  });
}
test('TITLE-1 Loop invalid title stays local and stale title ACK cannot overwrite a newer edit', () => {
  // Arrange
  const h = harness(); h.ready({ ...initial, title: 'saved' }); h.f.title.value = 'first'; h.time.tick(200);
  const first = h.last();
  // Act
  h.f.title.value = 'newer';
  h.reply({ ...first, type: 'canvas:reply', status: 'saved', settings: { ...initial, title: 'first' } });
  const protectedTitle = h.f.title.value; h.time.tick(200); const next = h.last();
  const before = h.edits().length; const accepted = h.bridge.edit({ title: 'bad\0title', intervalSeconds: 10 }); h.time.tick(200);
  // Assert
  assert.equal(protectedTitle, 'newer'); assert.equal(next.changes.title, 'newer');
  assert.equal(accepted, false); assert.equal(h.edits().length, before); assert.deepEqual(h.errors, ['TITLE_INVALID']); h.dispose();
});

test('Windows Loop legacy projection and settings classification share lossless platform grammar without saves', () => {
  // Arrange
  const h = harness(), args = [String.raw`C:\temp\new`, 'C:\\Folder\\', `both'"quotes`, 'a\r\nb', ''];
  const settings = { executable: 'C:/python.exe', args, intervalSeconds: 10 }, original = structuredClone(settings);
  // Act
  const view = getTimerInspectorConfiguration(settings, 'win32');
  h.ready(settings, TIMER_ACTION_UUID, 'windows-args', JSON.stringify({ application: { platform: 'windows' } }));
  const migrated = { ...settings, argsText: h.f.argsText.value };
  const execution = validateTimerSettings(migrated, 'win32'), classification = classifyTimerSettings(migrated, 'win32');
  // Assert
  assert.deepEqual(parseArguments(view.argsText, 'win32'), args); assert.equal(view.argsText, h.f.argsText.value);
  assert.deepEqual(execution.execution.args, args); assert.deepEqual(classification.execution.args, args);
  assert.equal(execution.intervalSeconds, 10); assert.equal(/[\r\n]/.test(h.f.argsText.value), false);
  assert.deepEqual(h.edits(), []); assert.deepEqual(h.errors, []); assert.deepEqual(settings, original); h.dispose();
});

test('Windows Loop malformed text overrides valid legacy arguments and cannot become a guessed projection', () => {
  // Arrange
  const h = harness(), settings = { executable: 'C:/python.exe', args: ['legacy'], argsText: '"private\nunterminated', intervalSeconds: 10 };
  // Act
  h.ready(settings, TIMER_ACTION_UUID, 'windows-invalid-args', JSON.stringify({ application: { platform: 'windows' } }));
  const view = getTimerInspectorConfiguration(settings, 'win32');
  const errors = [validateTimerSettings, classifyTimerSettings].map(validate => { try { validate(settings, 'win32'); } catch (error) { return error; } });
  // Assert
  assert.equal(view.diagnosticCode, 'ARGS_TEXT_INVALID'); assert.equal(h.f.argsText.value, undefined);
  assert.deepEqual(errors.map(error => error?.diagnosticCode), ['ARGS_TEXT_INVALID', 'ARGS_TEXT_INVALID']);
  assert.ok(h.errors.includes('ARGS_TEXT_INVALID')); assert.deepEqual(h.edits(), []);
  assert.equal(h.f.status.textContent.includes('private'), false); h.dispose();
});

test('Windows Loop inspector exposes only Loop controls, switches cwd hint and preserves immediate picker saves', () => {
  // Arrange
  const h = harness(), settings = { ...initial, executable: 'C:/program.EXE' };
  h.ready(settings, TIMER_ACTION_UUID, 'windows-loop', JSON.stringify({ application: { platform: 'windows' } }));
  const hydration = [...h.edits()];
  // Act
  h.f.executable.value = String.raw`D:\folder\program.EXE`; const selected = h.last();
  h.reply({ ...selected, type: 'canvas:reply', status: 'saved', settings: { ...settings, executable: String.raw`D:\folder\program.EXE` } });
  h.f.executable.value = '/invalid-posix'; h.f.actionOnPress.value = 'stop'; const policy = h.last();
  const windowsHint = h.f.cwd.renderedHint;
  h.ready(initial, RUN_ACTION_UUID, 'mac-stream', JSON.stringify({ application: { platform: 'mac' } }));
  // Assert
  assert.deepEqual(hydration, []); assert.deepEqual(selected.changes, { executable: String.raw`D:\folder\program.EXE` });
  assert.deepEqual(policy.changes, { actionOnPress: 'stop' }); assert.deepEqual(h.errors, ['INVALID_EXECUTABLE']);
  assert.equal(windowsHint, String.raw`C:\absolute\path\to\working-directory`);
  assert.equal(h.f.cwd.renderedHint, '/absolute/path/to/working-directory'); assert.equal(h.f.timerControls.hidden, true);
  assert.equal(h.bridge.getConnectionState().platform, 'posix'); h.dispose();
});

// Objective: one authored inspector, conditional Timer rows, unchanged common controls/save placement.
test('Timer markup declares exact presets, hidden rows and no additional settings writer', () => {
  // Arrange
  const html = asset('run.html');
  // Act
  const interval = html.match(/<sdpi-select id="intervalPreset">([\s\S]*?)<\/sdpi-select>/)[1];
  const pressRow = html.match(/<sdpi-item label="Action on press">([\s\S]*?)<\/sdpi-item>/)[1];
  const options = [...interval.matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)].map(match => [match[1], match[2]]);
  // Assert
  assert.deepEqual(options, [...presets, ['custom', 'Custom']]);
  assert.match(pressRow, /<sdpi-select id="actionOnPress">/);
  assert.deepEqual([...pressRow.matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)].map(match => [match[1], match[2]]),
    [['refresh', 'start / refresh (long press to stop)'], ['stop', 'start / stop']]);
  assert.equal(/<small\b/.test(pressRow), false);
  assert.ok(html.indexOf('id="actionOnPress"') < html.indexOf('id="intervalPreset"'));
  assert.match(html, /<small>Enter whole seconds from 1 to 86400\.<\/small>/);
  assert.match(html, /<div id="timer-controls" hidden>/);
  assert.match(html, /<sdpi-item id="custom-interval"[^>]* hidden>/);
  assert.match(html, /#timer-controls\[hidden\], #custom-interval\[hidden\]\s*\{\s*display: none !important;/);
  assert.match(html, /<sdpi-textfield id="intervalSeconds">/);
  assert.deepEqual([...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(match => match[1]), ['sdpi-components.js', 'run.js']);
  assert.equal(/\bsetting\s*=|<script>|\bApply\b|<sdpi-button|<button/.test(html), false);
  assert.ok(html.indexOf('id="settings-status"') > html.indexOf('id="themeColor"'));
});

for (const [value] of presets) {
  test(`stored ${value} seconds selects its preset without synchronous hydration writes`, () => {
    // Arrange
    const h = harness(), settings = { ...initial, intervalSeconds: Number(value) }, original = structuredClone(settings);
    // Act
    h.ready(settings);
    // Assert
    assert.equal(h.f.timerControls.hidden, false);
    assert.equal(h.f.intervalPreset.value, value);
    assert.equal(h.f.customInterval.hidden, true);
    assert.deepEqual(h.edits(), []);
    assert.deepEqual(settings, original);
    assert.equal(h.time.timers.size, 0);
    assert.equal(h.f.themeColor.value, '#969696');
  });
  test(`preset ${value} sends only canonical numeric seconds immediately and deduplicates repeated selection`, () => {
    // Arrange
    const h = harness(); h.ready({ ...initial, intervalSeconds: 7 });
    // Act
    h.f.intervalPreset.value = value;
    const request = h.last();
    h.reply({ ...request, type: 'canvas:reply', status: 'saved', settings: { ...initial, intervalSeconds: Number(value) } });
    h.f.intervalPreset.value = value; h.time.tick(200);
    // Assert
    assert.deepEqual(request.changes, { intervalSeconds: Number(value) });
    assert.equal(h.edits().length, 1);
    assert.equal(h.f.status.textContent, '');
    assert.equal(h.time.timers.size, 0);
    assert.ok(h.sockets[0].sent.filter(message => message.event === 'sendToPlugin').every(message =>
      message.action === TIMER_ACTION_UUID && message.context === 'transport-pi' && message.payload.context === 'synthetic-key'));
    assert.equal(h.sockets[0].sent.some(message => message.event === 'setSettings'), false);
  });
}

for (const settings of [{ executable: initial.executable, argsText: '' }, { ...initial, intervalSeconds: 7 }]) {
  test(`read-only ${Object.hasOwn(settings, 'intervalSeconds') ? 'nonpreset' : 'missing interval default'} hydration never invents persisted settings`, () => {
    // Arrange
    const h = harness(), original = structuredClone(settings);
    // Act
    h.ready(settings); const before = h.edits().length;
    h.f.intervalPreset.value = 'custom'; h.time.tick(200);
    // Assert
    assert.equal(h.f.intervalPreset.value, 'custom');
    assert.equal(h.f.intervalSeconds.value, String(settings.intervalSeconds ?? 60));
    assert.equal(h.f.customInterval.hidden, false);
    assert.equal(h.edits().length, before);
    assert.equal(h.time.timers.size, 0);
    assert.deepEqual(settings, original);
  });
}

for (const value of [0, -1, 86401, 1.5, '60', null]) {
  test(`present invalid stored interval ${JSON.stringify(value)} has fixed plaintext error and no guessed 60`, () => {
    // Arrange
    const h = harness(), settings = { ...initial, intervalSeconds: value };
    // Act
    h.ready(settings); h.f.intervalPreset.value = 'custom';
    // Assert
    assert.equal(h.f.intervalSeconds.value, '');
    assert.equal(h.f.status.textContent, intervalError);
    assert.deepEqual(h.edits(), []);
    assert.equal(getTimerInspectorConfiguration(settings).intervalSeconds, undefined);
  });
}

for (const [text, number] of [['1', 1], ['86400', 86400], ['00030', 30], ['77', 77]]) {
  test(`custom ASCII ${text} coalesces at 200ms into canonical number and retains local Custom on saved reply`, () => {
    // Arrange
    const h = harness(); h.ready(); h.f.intervalPreset.value = 'custom';
    // Act
    h.f.intervalSeconds.value = '2'; h.f.intervalSeconds.value = text;
    const before = h.edits().length; h.time.tick(200); const request = h.last();
    h.reply({ ...request, type: 'canvas:reply', status: 'saved', settings: { ...initial, intervalSeconds: number } });
    // Assert
    assert.equal(before, 0); assert.equal(h.edits().length, 1);
    assert.deepEqual(request.changes, { intervalSeconds: number });
    assert.equal(h.f.intervalPreset.value, 'custom'); assert.equal(h.f.customInterval.hidden, false);
    assert.equal(h.f.intervalSeconds.value, String(number)); assert.equal(h.f.status.textContent, '');
  });
}

const invalidText = ['', '0', '-1', '86401', '1.5', 'NaN', '1e2', ' 60', '60 ', '\t60', '60\0', '60n', '６０', '9'.repeat(100), 60, 60n, null];
for (const [index, value] of invalidText.entries()) {
  test(`invalid custom input case ${index} never coerces or sends a backend edit`, () => {
    // Arrange
    const h = harness(); h.ready(); h.f.intervalPreset.value = 'custom';
    // Act
    h.f.intervalSeconds.value = value; h.time.tick(200);
    // Assert
    assert.deepEqual(h.edits(), []);
    assert.equal(h.f.status.textContent, intervalError);
    assert.equal(h.time.timers.size, 0);
  });
}

for (const [index, value] of ['60', 0, -1, 86401, 0.5, NaN, Infinity, -Infinity, 60n, null].entries()) {
  test(`direct bridge invalid numeric edit case ${index} is rejected with fixed interval diagnosis`, () => {
    // Arrange
    const h = harness(); h.ready();
    // Act
    const accepted = h.bridge.edit({ intervalSeconds: value }, { immediate: true });
    // Assert
    assert.equal(accepted, false); assert.deepEqual(h.edits(), []);
    assert.equal(h.errors.at(-1), 'INTERVAL_INVALID'); assert.equal(h.f.status.textContent, intervalError);
  });
}

test('accessor and cyclic edit payloads reject without getter execution or raw exception disclosure', () => {
  // Arrange
  const h = harness(); h.ready(); let reads = 0;
  const accessor = {}; Object.defineProperty(accessor, 'intervalSeconds', { enumerable: true, get() { reads++; throw new Error('SYNTHETIC_PRIVATE'); } });
  const cyclic = { intervalSeconds: 30 }; cyclic.extra = cyclic;
  // Act
  const accepted = [h.bridge.edit(accessor), h.bridge.edit(cyclic)]; h.time.tick(200);
  // Assert
  assert.deepEqual(accepted, [false, false]); assert.equal(reads, 0); assert.deepEqual(h.edits(), []);
  assert.deepEqual(h.errors, ['INTERVAL_INVALID', 'INVALID_SETTINGS']);
  assert.equal(h.f.status.textContent.includes('SYNTHETIC_PRIVATE'), false);
});

for (const [name, changes] of [['intent', { runRequested: true }], ['enabled', { enabled: true }], ['mode', { mode: 'custom' }],
  ['settings envelope', { settings: initial }], ['unknown', { private: 'SYNTHETIC_PRIVATE' }]]) {
  test(`Timer bridge rejects ${name} writes instead of becoming a complete-settings writer`, () => {
    // Arrange
    const h = harness(); h.ready();
    // Act
    const accepted = h.bridge.edit(changes, { immediate: true });
    // Assert
    assert.equal(accepted, false); assert.deepEqual(h.edits(), []); assert.equal(h.errors.at(-1), 'INVALID_SETTINGS');
  });
}

for (const action of [RUN_ACTION_UUID, ONCE_ACTION_UUID, 'synthetic.unknown']) {
  test(`${action} hides Loop controls and rejects programmatic interval edits`, () => {
    // Arrange
    const h = harness(); h.ready(initial, action);
    // Act
    h.f.intervalPreset.value = 'custom'; h.f.intervalSeconds.value = '30';
    const accepted = h.bridge.edit({ intervalSeconds: 30 }, { immediate: true });
    h.f.argsText.value = 'common-edit'; h.time.tick(200);
    // Assert
    assert.equal(h.f.timerControls.hidden, true); assert.equal(accepted, false);
    assert.deepEqual(h.edits().map(message => message.payload.changes), [{ argsText: 'common-edit' }]);
  });
}

test('before valid SDK binding Timer controls cannot edit while the common prebinding picker stays protected', () => {
  // Arrange
  const h = harness();
  // Act
  h.f.intervalPreset.value = 'custom'; h.f.intervalSeconds.value = '30';
  const accepted = h.bridge.edit({ intervalSeconds: 30 });
  h.f.executable.value = '/synthetic/selected';
  for (const [port, info] of [['0', JSON.stringify({ context: 'key', action: TIMER_ACTION_UUID })], ['12345', '{invalid']])
    h.connect(port, 'transport-pi', 'registerPropertyInspector', '{}', info);
  h.ready();
  // Assert
  assert.equal(accepted, false); assert.equal(h.f.executable.value, '/synthetic/selected');
  assert.deepEqual(h.edits().map(message => message.payload.changes), [{ executable: '/synthetic/selected' }]);
  assert.equal(h.f.intervalPreset.value, '60'); assert.equal(h.sockets.length, 1);
});

for (const invalid of ['json', 'port', 'context', 'unknown']) {
  test(`new ${invalid} callback immediately hides prior Timer binding and discards local Custom state`, () => {
    // Arrange
    const h = harness(); h.ready(); h.f.intervalPreset.value = 'custom'; h.f.intervalSeconds.value = '17';
    const oldSocket = h.sockets[0], old = h.last();
    // Act
    h.connect(invalid === 'port' ? '0' : '12345', 'new-pi', 'registerPropertyInspector', '{}', invalid === 'json' ? '{invalid'
      : JSON.stringify({ context: invalid === 'context' ? '' : 'other-key', action: invalid === 'unknown' ? 'unknown' : TIMER_ACTION_UUID, payload: { settings: initial } }));
    const hidden = h.f.timerControls.hidden, seconds = h.f.intervalSeconds.value;
    h.reply({ ...old, type: 'canvas:reply', status: 'saved', settings: { ...initial, intervalSeconds: 17 } }, oldSocket);
    const accepted = h.bridge.edit({ intervalSeconds: 30 });
    // Assert
    assert.equal(hidden, true); assert.equal(seconds, ''); assert.equal(accepted, false); assert.equal(oldSocket.closed, true);
    assert.ok(h.states.some(state => state.actionUuid === TIMER_ACTION_UUID && !state.bindingValid));
    assert.equal(h.f.timerControls.hidden, true); assert.equal(h.f.intervalSeconds.value, '');
  });
}

for (const action of [RUN_ACTION_UUID, TIMER_ACTION_UUID]) {
  test(`Timer to ${action === RUN_ACTION_UUID ? 'Run' : 'different Timer key'} resets pending text, mode, request maps and stale socket replies`, () => {
    // Arrange
    const h = harness(); h.ready(); h.f.intervalPreset.value = 'custom'; h.f.intervalSeconds.value = '17'; h.time.tick(200);
    const old = h.last(), oldSocket = h.sockets[0]; h.f.intervalSeconds.value = '18';
    // Act
    h.ready({ ...initial, intervalSeconds: 30, argsText: 'new-key' }, action, 'other-key');
    h.reply({ ...old, type: 'canvas:reply', status: 'saved', settings: { ...initial, intervalSeconds: 17, argsText: 'old-key' } }, oldSocket);
    h.time.tick(200);
    // Assert
    assert.equal(oldSocket.closed, true); assert.notEqual(h.last().inspectorId, old.inspectorId);
    assert.equal(h.f.argsText.value, 'new-key'); assert.deepEqual(h.edits(), []);
    assert.equal(h.f.timerControls.hidden, action === RUN_ACTION_UUID);
    assert.equal(h.f.intervalPreset.value, action === RUN_ACTION_UUID ? '' : '30');
    assert.equal(h.f.customInterval.hidden, true); assert.equal(h.f.status.textContent, '');
  });
}

test('early valid Timer edits survive stale initial/challenge/claim projection, including invalid stored interval', () => {
  // Arrange
  const h = harness(); h.bind({ ...initial, intervalSeconds: 0 });
  // Act
  h.f.intervalPreset.value = 'custom'; h.f.intervalSeconds.value = '00017'; h.open();
  h.claim({ ...initial, intervalSeconds: 0 }); const request = h.last();
  const protectedText = h.f.intervalSeconds.value, before = h.f.status.textContent;
  h.reply({ ...request, type: 'canvas:reply', status: 'saved', settings: { ...initial, intervalSeconds: 17 } });
  // Assert
  assert.equal(protectedText, '00017'); assert.equal(before, 'Saving…');
  assert.deepEqual(request.changes, { intervalSeconds: 17 }); assert.equal(h.edits().length, 1);
  assert.equal(h.f.intervalSeconds.value, '17'); assert.equal(h.f.status.textContent, '');
});

test('late interval acknowledgment cannot replace newer typing or falsely mark it Saved', () => {
  // Arrange
  const h = harness(); h.ready(); h.f.intervalPreset.value = 'custom'; h.f.intervalSeconds.value = '17'; h.time.tick(200);
  const old = h.last();
  // Act
  h.f.intervalSeconds.value = '19';
  h.reply({ ...old, type: 'canvas:reply', status: 'saved', settings: { ...initial, intervalSeconds: 17 } });
  const newest = h.last(), text = h.f.intervalSeconds.value, status = h.f.status.textContent;
  h.reply({ ...newest, type: 'canvas:reply', status: 'saved', settings: { ...initial, intervalSeconds: 19 } });
  h.reply({ ...old, type: 'canvas:reply', status: 'saved', settings: { ...initial, intervalSeconds: 17 } });
  // Assert
  assert.equal(text, '19'); assert.equal(status, 'Saving…'); assert.deepEqual(newest.changes, { intervalSeconds: 19 });
  assert.equal(h.f.intervalSeconds.value, '19'); assert.equal(h.f.status.textContent, '');
});

for (const recovery of ['preset', 'same custom']) {
  test(`invalid local typing stays diagnosed after older ack; ${recovery} clears it without redundant write`, () => {
    // Arrange
    const h = harness(); h.ready(); h.f.intervalPreset.value = 'custom'; h.f.intervalSeconds.value = '30'; h.time.tick(200);
    const old = h.last();
    // Act
    h.f.intervalSeconds.value = '<synthetic-invalid>';
    h.reply({ ...old, type: 'canvas:reply', status: 'saved', settings: { ...initial, intervalSeconds: 30 } });
    const error = h.f.status.textContent, text = h.f.intervalSeconds.value, count = h.edits().length;
    if (recovery === 'preset') h.f.intervalPreset.value = '30'; else h.f.intervalSeconds.value = '30';
    h.time.tick(200);
    // Assert
    assert.equal(error, intervalError); assert.equal(text, '<synthetic-invalid>');
    assert.equal(h.f.status.textContent, ''); assert.equal(h.edits().length, count);
  });
}

for (const foreign of ['context', 'inspectorId', 'requestId']) {
  test(`foreign ${foreign} Timer saved reply cannot change local controls or save status`, () => {
    // Arrange
    const h = harness(); h.ready(); h.f.intervalPreset.value = 'custom'; h.f.intervalSeconds.value = '17'; h.time.tick(200);
    const request = h.last();
    // Act
    h.reply({ ...request, type: 'canvas:reply', status: 'saved', settings: { ...initial, intervalSeconds: 30 },
      [foreign]: foreign === 'requestId' ? request.requestId + 1 : 'foreign' });
    // Assert
    assert.equal(h.f.intervalSeconds.value, '17'); assert.equal(h.f.intervalPreset.value, 'custom'); assert.equal(h.f.status.textContent, 'Saving…');
  });
}

test('Timer timeout ignores late reply and disposal cancels interval debounce and direct listeners', () => {
  // Arrange
  const h = harness(); h.ready(); h.f.intervalPreset.value = 'custom'; h.f.intervalSeconds.value = '17'; h.time.tick(200);
  const request = h.last();
  // Act
  h.time.tick(15000); h.reply({ ...request, type: 'canvas:reply', status: 'saved', settings: { ...initial, intervalSeconds: 30 } });
  const status = h.f.status.textContent; h.f.intervalSeconds.value = '19'; const count = h.edits().length;
  h.dispose(); h.f.intervalSeconds.value = '20'; h.time.tick(200);
  // Assert
  assert.equal(status, 'Settings could not be confirmed.'); assert.equal(h.edits().length, count);
  assert.equal(h.time.timers.size, 0); assert.equal(h.sockets[0].closed, true);
});

for (const [name, legacy] of [['array', { args: ['line\nnext', '', 'two words'] }], ['JSON', { args: '["line\\nnext","","two words"]' }],
  ['blank text precedence', { argsText: '', args: ['retained'] }]]) {
  test(`Timer ${name} legacy hydration retains data and single-line argv without edits`, () => {
    // Arrange
    const h = harness(), settings = { executable: initial.executable, ...legacy }, original = structuredClone(settings);
    // Act
    h.ready(settings); const projected = parseArguments(h.f.argsText.value);
    // Assert
    assert.deepEqual(projected, name === 'blank text precedence' ? [] : ['line\nnext', '', 'two words']);
    assert.equal(/[\r\n]/.test(h.f.argsText.value), false); assert.deepEqual(h.edits(), []); assert.deepEqual(settings, original);
  });
}

test('malformed Timer legacy args remain intact with fixed diagnosis and no guessed text or hydration edit', () => {
  // Arrange
  const h = harness(), settings = { executable: initial.executable, args: 'SYNTHETIC_PRIVATE_INVALID', intervalSeconds: 7 };
  // Act
  h.ready(settings);
  // Assert
  assert.equal(h.f.argsText.value, undefined); assert.equal(h.f.status.textContent, 'Replace the invalid legacy arguments.');
  assert.equal(settings.args, 'SYNTHETIC_PRIVATE_INVALID'); assert.deepEqual(h.edits(), []);
});

// PRE-MERGE-WINDOWS-01: success and rejected input must have no trace side channel.
for (const built of [false, true]) {
test(`Loop ${built ? 'built entry' : 'source bridge'} edits and validation send only configuration traffic, never diagnostic values or settings dumps`, () => {
  // Arrange
  const h = harness({ built }); h.ready({ ...initial, argsText: 'PRIVATE_ARGS', unknown: 'PRIVATE_SETTINGS' });
  // Act
  h.f.intervalPreset.value = 'custom'; h.f.intervalSeconds.value = '12345'; h.time.tick(200);
  const edit = h.last(), count = h.sockets[0].sent.length;
  h.f.intervalSeconds.value = 'PRIVATE_INTERVAL'; h.time.tick(200);
  // Assert
  assert.equal(edit.requestId, 3); assert.deepEqual(edit.changes, { intervalSeconds: 12345 });
  assert.equal(h.sockets[0].sent.length, count); assert.equal(h.f.status.textContent, intervalError);
  assert.deepEqual(h.sockets[0].sent.filter(message => message.payload?.type === 'canvas:trace'), []);
  assert.deepEqual(h.sockets[0].sent.filter(message => message.event === 'sendToPlugin').map(message => message.payload.type), ['canvas:hello', 'canvas:claim', 'canvas:edit']);
  assert.equal(JSON.stringify(h.sockets[0].sent).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(h.states).includes('PRIVATE'), false); h.dispose();
});
}

// Objective: exercise the actual generated production entry, not a recreated installer.
for (const loading of [false, true]) for (const action of [RUN_ACTION_UUID, TIMER_ACTION_UUID]) {
  for (const [platform, executable, cwd, hint] of [
    ['windows', String.raw`C:\synthetic\report.EXE`, String.raw`D:\synthetic\work`, String.raw`C:\absolute\path\to\working-directory`],
    ['mac', '/synthetic/report', '/synthetic/work', '/absolute/path/to/working-directory'],
  ]) {
    test(`built ${action === RUN_ACTION_UUID ? 'Stream' : 'Loop'} ${platform} startup callback ${loading ? 'before' : 'after'} DOM readiness hydrates all fields without placeholder exceptions`, () => {
      // Arrange
      const settings = { executable, argsText: '"two words" ""', cwd, ...(action === TIMER_ACTION_UUID ? { intervalSeconds: 60 } : { runRequested: true }) };
      const original = structuredClone(settings);
      let h;
      // Act: evaluate the real minified entry, with only DOM/socket/clock doubled.
      const startup = () => {
        h = harness({ built: true, loading });
        h.bind(settings, action, 'startup-key', JSON.stringify({ application: { platform } })); h.open();
        if (loading) h.events.get('DOMContentLoaded')();
        h.claim(settings); h.time.advance(200);
      };
      // Assert: old direct .placeholder text assignment fails at controller startup.
      assert.doesNotThrow(startup);
      assert.equal(h.f.executable.value, executable); assert.equal(h.f.argsText.value, settings.argsText); assert.equal(h.f.cwd.value, cwd);
      assert.equal(h.f.cwd.renderedHint, hint); assert.equal(h.f.timerControls.hidden, action !== TIMER_ACTION_UUID);
      assert.equal(h.sockets.length, 1); assert.equal(h.chained(), 0); assert.deepEqual(h.edits(), []);
      assert.equal(h.sockets[0].sent.some(message => message.event === 'setSettings'), false); assert.deepEqual(settings, original);
      h.dispose(); assert.equal(h.time.timers.size, 0);
    });
  }
}
for (const built of [false, true]) {
  test(`${built ? 'built' : 'source'} inspector repaints Windows-to-macOS cwd hint when stored cwd is unchanged`, () => {
    // Arrange: empty cwd is valid on both platforms; no value edit should trigger the repaint.
    const h = harness({ built }), windows = { ...initial, executable: 'C:/report.EXE', cwd: '' }, mac = { ...initial, cwd: '' };
    h.ready(windows, TIMER_ACTION_UUID, 'windows-key', JSON.stringify({ application: { platform: 'windows' } }));
    const windowsHint = h.f.cwd.renderedHint, previous = h.sockets[0], oldValue = h.f.cwd.value;
    // Act
    h.ready(mac, TIMER_ACTION_UUID, 'mac-key', JSON.stringify({ application: { platform: 'mac' } }));
    // Assert: attribute-only mutation without a render update leaves the Windows hint stale.
    assert.equal(windowsHint, String.raw`C:\absolute\path\to\working-directory`);
    assert.equal(h.f.cwd.renderedHint, '/absolute/path/to/working-directory'); assert.equal(h.f.cwd.value, oldValue);
    assert.equal(previous.closed, true); assert.deepEqual(h.edits(), []);
    assert.ok(h.sockets.every(socket => !socket.sent.some(message => message.event === 'setSettings' || message.payload?.type === 'canvas:edit')));
    h.dispose();
  });
}
for (const loading of [false, true]) for (const action of [RUN_ACTION_UUID, TIMER_ACTION_UUID]) {
  test(`built ${action === RUN_ACTION_UUID ? 'Run' : 'Timer'} entry with callback ${loading ? 'before' : 'after'} DOM readiness uses one replaced wrapper/socket`, () => {
    // Arrange
    const h = harness({ built: true, loading });
    // Act
    h.bind(initial, action); h.open(); if (loading) h.events.get('DOMContentLoaded')(); h.claim();
    const visible = !h.f.timerControls.hidden;
    h.f.intervalPreset.value = '10'; const count = h.edits().length;
    if (action === TIMER_ACTION_UUID) h.reply({ ...h.last(), type: 'canvas:reply', status: 'saved', settings: { ...initial, intervalSeconds: 10 } });
    h.dispose();
    // Assert
    assert.equal(h.chained(), 0); assert.equal(h.sockets.length, 1); assert.equal(visible, action === TIMER_ACTION_UUID);
    assert.equal(count, action === TIMER_ACTION_UUID ? 1 : 0);
    assert.deepEqual(h.edits().map(message => message.payload.changes), action === TIMER_ACTION_UUID ? [{ intervalSeconds: 10 }] : []);
    assert.equal(h.f.argsText.value, ''); assert.equal(h.f.themeColor.value, '#969696');
    assert.equal(h.sockets[0].sent.some(message => message.event === 'setSettings'), false);
    assert.equal(h.sockets[0].closed, true); assert.equal(h.time.timers.size, 0);
  });
}

test('built Timer entry routes custom edits, suppresses synchronous hydration and hides stale identity on invalid callback', () => {
  // Arrange
  const h = harness({ built: true }); h.ready();
  // Act
  h.f.intervalPreset.value = 'custom'; const before = h.edits().length;
  h.f.intervalSeconds.value = '17'; h.f.intervalSeconds.value = '00019'; h.time.tick(200); const request = h.last();
  h.reply({ ...request, type: 'canvas:reply', status: 'saved', settings: { ...initial, intervalSeconds: 19 } });
  const mode = h.f.intervalPreset.value, status = h.f.status.textContent;
  h.connect('12345', 'transport-pi', 'registerPropertyInspector', '{}', '{invalid');
  const hidden = h.f.timerControls.hidden; h.f.intervalPreset.value = '10'; h.time.tick(200); h.dispose();
  // Assert
  assert.equal(before, 0); assert.deepEqual(request.changes, { intervalSeconds: 19 });
  assert.equal(mode, 'custom'); assert.equal(status, ''); assert.equal(hidden, true);
  assert.equal(h.edits().length, 1); assert.equal(h.sockets.length, 1);
});

// Compile actual adapters in memory as the existing Timer adapter suite does;
// never load plugin.ts, connect an SDK, start a process, or create another helper file.
const adapterCodes = new Map(['timer', 'program-runtime'].map(name => [
  `./${name}`, ts.transpileModule(readFileSync(new URL(`../src/actions/${name}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true },
  }).outputText,
]));
const helperNames = ['availability', 'error-artwork', 'execution-paths', 'launch-environment', 'settings', 'settings-authority', 'theme',
  'timer-artwork', 'timer-session', 'timer-settings'];
const helpers = new Map(await Promise.all(helperNames.map(async name => [
  `../core/${name}.mjs`, await import(`../src/core/${name}.mjs`),
])));

function backend(t, client, settings = initial) {
  const time = clock(), launches = [], logs = [], sessions = [], states = [], managers = [], modules = new Map();
  let stored = structuredClone(settings), resolveRun;
  const writes = [], replies = [];
  const runtime = {
    id: 'synthetic-key', manifestId: TIMER_ACTION_UUID, isKey: () => true,
    device: { id: 'synthetic-device', name: 'Synthetic Deck', type: 999, isConnected: true },
    coordinates: { row: 0, column: 0 },
    async setSettings(value) { writes.push(structuredClone(value)); stored = structuredClone(value); },
    async getSettings() { return structuredClone(stored); }, async setImage() {}, async setTitle() {},
  };
  const sdk = { logger: { info: value => logs.push(value), warn: value => logs.push(value) },
    ui: { async sendToPropertyInspector(payload) { replies.push(structuredClone(payload)); client.reply(payload); } } };
  const sdkModule = { default: sdk, SingletonAction: class {}, action: () => value => value };
  const registry = Object.fromEntries(['onDeviceDidConnect', 'onDeviceDidDisconnect', 'onSystemDidWakeUp']
    .map(name => [name, () => ({ dispose() {} })]));
  // Captures return the real instances unchanged, for their public idle/state APIs.
  function capture(name, factory, collection) {
    return { ...helpers.get(name), [factory](dependencies) {
      const actual = helpers.get(name)[factory](dependencies); collection.push(actual); return actual;
    } };
  }
  function requireIsolated(name) {
    if (adapterCodes.has(name)) {
      if (!modules.has(name)) {
        const exports = {}; modules.set(name, exports);
        new Function('require', 'exports', 'process', adapterCodes.get(name))(requireIsolated, exports,
          { env: {}, cwd: () => '/synthetic/cwd' });
      }
      return modules.get(name);
    }
    if (name === '@elgato/streamdeck') return sdkModule;
    if (name === '../core/process-runner.mjs') return { startProcessRun(execution) {
      launches.push(structuredClone(execution));
      const done = new Promise(resolve => { resolveRun = resolve; });
      return { done, async stop() { resolveRun({ status: 'stopped' }); return true; } };
    } };
    if (name === '../core/timer-session.mjs') return capture(name, 'createTimerSession', sessions);
    if (name === '../core/timer-settings.mjs') return capture(name, 'createTimerStateCoordinator', states);
    if (name === '../core/availability.mjs') return capture(name, 'createAvailabilityManager', managers);
    if (helpers.has(name)) return helpers.get(name);
    throw new Error(`Unexpected isolated dependency: ${name}`);
  }
  const { TimerAction } = requireIsolated('./timer'), action = new TimerAction(registry, time);
  const idle = async () => {
    await Promise.all(managers.map(manager => manager.whenIdle()));
    await Promise.all(states.map(state => state.whenIdle()));
    await Promise.all(sessions.map(session => session.whenIdle()));
  };
  const delivered = new WeakMap();
  async function deliver() {
    // Each socket gets its own bounded cursor. SDK replies can enqueue claim/edit;
    // consume these causally rather than waiting on real timers or public services.
    const socket = client.sockets.at(-1);
    let cursor = delivered.get(socket) ?? 0, budget = 200;
    while (cursor < socket.sent.length) {
      if (--budget === 0) throw new Error('Synthetic delivery budget exhausted');
      const message = socket.sent[cursor++]; delivered.set(socket, cursor);
      if (message.event === 'sendToPlugin') await action.onSendToPlugin({ action: runtime, payload: message.payload });
    }
    await idle();
  }
  t.after(async () => {
    await action.onWillDisappear({ action: runtime }); await idle();
    for (const manager of managers) manager.dispose();
    client.dispose();
  });
  return { runtime, action, time, launches, logs, writes, replies, sessions, idle, deliver,
    appear: () => action.onWillAppear({ action: runtime, payload: { settings } }),
    async tap() { await action.onKeyDown({ action: runtime, payload: { settings } }); await action.onKeyUp({ action: runtime }); await idle(); },
    async finish(result = { status: 'success' }) { resolveRun(result); await idle(); },
  };
}

for (const input of ['preset', 'custom']) {
  test(`real client ${input} numeric edit reaches Timer authority, complete host confirmation and resets deadline without Run intent`, { timeout: 3000 }, async t => {
    // Arrange
    const h = harness(), b = backend(t, h, { ...initial, args: ['retained legacy'] });
    await b.appear(); h.bind(); h.open(); await b.deliver();
    await b.tap(); await b.finish(); b.time.advance(1000); await b.idle();
    const before = b.sessions[0].getState().dueMs;
    // Act
    if (input === 'preset') h.f.intervalPreset.value = '10';
    else { h.f.intervalPreset.value = 'custom'; h.f.intervalSeconds.value = '00010'; h.time.tick(200); }
    const request = h.last(); await b.deliver();
    const after = b.sessions[0].getState();
    // Assert: fake matched host reporting is not a durability or hardware claim.
    assert.deepEqual(request.changes, { intervalSeconds: 10 });
    assert.equal(before, 60000); assert.equal(after.dueMs, 11000); assert.equal(after.enabled, true);
    assert.deepEqual(b.writes, [{ ...initial, args: ['retained legacy'], intervalSeconds: 10 }]);
    assert.equal(Object.hasOwn(b.writes[0], 'runRequested'), false); assert.equal(Object.hasOwn(b.writes[0], 'enabled'), false);
    assert.equal(b.replies.at(-1).status, 'saved'); assert.equal(h.f.status.textContent, '');
    assert.equal(b.launches.length, 1); assert.equal(Object.hasOwn(b.launches[0], 'intervalSeconds'), false);
    assert.equal(b.logs.some(value => value.includes('retained legacy')), false);
  });
}

test('real Timer adapter receives no invalid client edits; stale key claim cannot write or schedule a replacement', { timeout: 3000 }, async t => {
  // Arrange
  const h = harness(), b = backend(t, h); await b.appear(); h.bind(); h.open(); await b.deliver();
  const old = h.last();
  // Act
  h.f.intervalPreset.value = 'custom'; h.f.intervalSeconds.value = '1e2'; h.time.tick(200);
  h.bridge.edit({ enabled: true }); await b.deliver();
  const invalidStatus = h.f.status.textContent;
  h.ready({ ...initial, intervalSeconds: 30 }, TIMER_ACTION_UUID, 'other-key');
  h.reply({ ...old, type: 'canvas:reply', status: 'saved', settings: { ...initial, intervalSeconds: 17 } });
  await b.action.onSendToPlugin({ action: b.runtime, payload: { ...old, context: 'other-key', changes: { intervalSeconds: 17 }, type: 'canvas:edit' } });
  await b.idle();
  // Assert
  assert.deepEqual(b.writes, []); assert.deepEqual(b.launches, []); assert.equal(b.sessions[0].getState().enabled, false);
  assert.equal(b.sessions[0].getState().dueMs, undefined); assert.equal(invalidStatus, intervalError);
  assert.equal(h.f.intervalPreset.value, '30'); assert.equal(h.f.intervalSeconds.value, '30'); assert.equal(h.f.status.textContent, '');
});

// Repair regression objective: local validity may remove its overlay, but only
// a correlated bridge acknowledgment can confirm a previously unconfirmed save.
const saveFailures = [
  ['timeout', 'Settings could not be confirmed.'],
  ['STATE_SAVE_FAILED', 'Settings could not be confirmed.'],
  ['INVALID_SETTINGS', 'Settings need correction.'],
];
function failSave(h, failure, request = h.last()) {
  if (failure === 'timeout') h.time.tick(15000);
  else h.reply({ ...request, type: 'canvas:reply', status: 'error', diagnosticCode: failure });
}
function recoverLocalInterval(h, recovery, seconds) {
  if (recovery === 'same preset') h.f.intervalPreset.value = String(seconds);
  else if (recovery === 'Custom selection') h.f.intervalPreset.value = 'custom';
  else h.f.intervalSeconds.value = String(seconds);
}

// Slice 2 objective: policy is narrow Timer metadata, never a gesture or saved intent.
for (const built of [false, true]) {
  for (const policy of [undefined, 'refresh', 'stop']) {
    test(`${built ? 'built' : 'source'} ${policy ?? 'missing'} press policy hydrates read-only and same selection writes nothing`, () => {
      // Arrange
      const h = harness({ built }), settings = { ...initial, args: ['retained'] };
      if (policy !== undefined) settings.actionOnPress = policy;
      const original = structuredClone(settings);
      // Act
      h.ready(settings); const hydrated = h.f.actionOnPress.value;
      h.f.actionOnPress.value = policy ?? 'refresh'; h.time.tick(200);
      // Assert
      assert.equal(hydrated, policy ?? 'refresh'); assert.equal(h.f.timerControls.hidden, false);
      assert.deepEqual(h.edits(), []); assert.deepEqual(settings, original);
      assert.equal(h.f.status.textContent, ''); assert.equal(h.time.timers.size, 0);
      h.dispose();
    });
  }
  for (const policy of ['refresh', 'stop']) {
    test(`${built ? 'built' : 'source'} selecting ${policy} immediately saves only canonical policy and confirmed repeat deduplicates`, () => {
      // Arrange
      const h = harness({ built }); h.ready({ ...initial, actionOnPress: policy === 'stop' ? 'refresh' : 'stop' });
      // Act
      h.f.actionOnPress.value = policy; const request = h.last(), pending = h.f.status.textContent;
      h.reply({ ...request, type: 'canvas:reply', status: 'saved', settings: { ...initial, actionOnPress: policy } });
      h.f.actionOnPress.value = policy; h.time.tick(200);
      // Assert
      assert.deepEqual(request.changes, { actionOnPress: policy }); assert.equal(pending, 'Saving…');
      assert.equal(h.edits().length, 1); assert.equal(h.f.actionOnPress.value, policy); assert.equal(h.f.status.textContent, '');
      assert.equal(h.sockets.length, 1); assert.equal(h.sockets[0].sent.some(message => message.event === 'setSettings'), false);
      assert.ok(h.edits().every(message => message.action === TIMER_ACTION_UUID && message.context === 'transport-pi'
        && message.payload.context === 'synthetic-key'));
      h.dispose();
    });
  }
  for (const [index, policy] of ['', 'Refresh', 'STOP', ' refresh', 'stop ', 0, false, null, {}, ['stop']].entries()) {
    test(`${built ? 'built' : 'source'} invalid stored press policy ${index} never guesses Refresh or writes migration`, () => {
      // Arrange
      const h = harness({ built }), settings = { ...initial, actionOnPress: policy }, original = structuredClone(settings);
      // Act
      h.ready(settings);
      // Assert
      assert.equal(h.f.actionOnPress.value, ''); assert.equal(h.f.status.textContent, pressError);
      assert.deepEqual(h.edits(), []); assert.deepEqual(settings, original);
      assert.equal(getTimerInspectorConfiguration(settings).actionOnPress, undefined);
      h.dispose();
    });
  }
  for (const [index, policy] of ['', 'Refresh', 'STOP', ' refresh', 'stop ', 0, false, null, new String('stop')].entries()) {
    test(`${built ? 'built' : 'source'} invalid local press choice ${index} is plaintext rejected without transport`, () => {
      // Arrange
      const h = harness({ built }); h.ready();
      // Act
      h.f.actionOnPress.value = policy; h.time.tick(200);
      // Assert
      assert.equal(h.f.status.textContent, pressError); assert.deepEqual(h.edits(), []);
      assert.equal(h.time.timers.size, 0); h.dispose();
    });
  }
  for (const [failure, expected] of saveFailures) {
    test(`${built ? 'built' : 'source'} press ${failure}: same valid reselection restores save error, not false Saved`, () => {
      // Arrange
      const h = harness({ built }); h.ready(); h.f.actionOnPress.value = 'stop'; const request = h.last();
      // Act
      failSave(h, failure, request); const failed = h.f.status.textContent;
      h.f.actionOnPress.value = 'invalid'; const overlay = h.f.status.textContent;
      h.f.actionOnPress.value = 'stop'; h.time.tick(200);
      // Assert
      assert.equal(failed, expected); assert.equal(overlay, pressError); assert.equal(h.f.status.textContent, expected);
      assert.deepEqual(request.changes, { actionOnPress: 'stop' }); assert.equal(h.edits().length, 1);
      assert.equal(h.time.timers.size, 0); h.dispose();
    });
  }
  test(`${built ? 'built' : 'source'} rapid stop then refresh protects policy and Saving from stale and foreign ACKs`, () => {
    // Arrange
    const h = harness({ built }); h.ready(); h.f.actionOnPress.value = 'stop'; const old = h.last();
    // Act
    h.f.actionOnPress.value = 'refresh'; const current = h.last();
    const unconfirmed = [], saved = { ...current, type: 'canvas:reply', status: 'saved', settings: { ...initial, actionOnPress: 'refresh' } };
    h.reply({ ...old, type: 'canvas:reply', status: 'saved', settings: { ...initial, actionOnPress: 'stop' } });
    unconfirmed.push([h.f.actionOnPress.value, h.f.status.textContent]);
    for (const foreign of ['context', 'inspectorId', 'requestId']) {
      h.reply({ ...saved, [foreign]: foreign === 'requestId' ? current.requestId + 1 : 'foreign' });
      unconfirmed.push([h.f.actionOnPress.value, h.f.status.textContent]);
    }
    h.reply(saved); h.reply({ ...old, type: 'canvas:reply', status: 'error', diagnosticCode: 'INVALID_SETTINGS' });
    // Assert
    assert.deepEqual(h.edits().map(message => message.payload.changes), [{ actionOnPress: 'stop' }, { actionOnPress: 'refresh' }]);
    assert.deepEqual(unconfirmed, Array.from({ length: 4 }, () => ['refresh', 'Saving…']));
    assert.equal(h.f.actionOnPress.value, 'refresh'); assert.equal(h.f.status.textContent, ''); h.dispose();
  });
  test(`${built ? 'built' : 'source'} pending policy correction stays Saving; ACK cannot erase invalid local policy`, () => {
    // Arrange
    const h = harness({ built }); h.ready(); h.f.actionOnPress.value = 'stop'; const request = h.last();
    // Act
    h.f.actionOnPress.value = 'invalid'; const firstOverlay = h.f.status.textContent;
    h.f.actionOnPress.value = 'stop'; const pending = h.f.status.textContent;
    h.f.actionOnPress.value = 'invalid';
    h.reply({ ...request, type: 'canvas:reply', status: 'saved', settings: { ...initial, actionOnPress: 'stop' } });
    const afterAck = [h.f.actionOnPress.value, h.f.status.textContent]; h.f.actionOnPress.value = 'stop';
    // Assert
    assert.equal(firstOverlay, pressError); assert.equal(pending, 'Saving…'); assert.deepEqual(afterAck, ['invalid', pressError]);
    assert.equal(h.f.status.textContent, ''); assert.equal(h.edits().length, 1); h.dispose();
  });
  test(`${built ? 'built' : 'source'} interval overlay outranks policy overlay without discarding failed-save diagnosis`, () => {
    // Arrange
    const h = harness({ built }); h.ready(); h.f.actionOnPress.value = 'stop'; failSave(h, 'STATE_SAVE_FAILED');
    // Act
    h.f.actionOnPress.value = 'invalid'; h.f.intervalPreset.value = 'custom'; h.f.intervalSeconds.value = 'invalid';
    const both = h.f.status.textContent; h.f.intervalSeconds.value = '60'; const policyOnly = h.f.status.textContent;
    h.f.actionOnPress.value = 'stop';
    // Assert
    assert.equal(both, intervalError); assert.equal(policyOnly, pressError);
    assert.equal(h.f.status.textContent, 'Settings could not be confirmed.'); assert.equal(h.edits().length, 1); h.dispose();
  });
  for (const action of [RUN_ACTION_UUID, 'unknown']) {
    test(`${built ? 'built' : 'source'} ${action} hides and ignores programmatic press selection`, () => {
      // Arrange
      const h = harness({ built }); h.ready(initial, action);
      // Act
      h.f.actionOnPress.value = 'stop'; h.f.argsText.value = 'common-edit'; h.time.tick(200);
      // Assert
      assert.equal(h.f.timerControls.hidden, true);
      assert.deepEqual(h.edits().map(message => message.payload.changes), [{ argsText: 'common-edit' }]); h.dispose();
    });
  }
  for (const [action, context, label] of [[RUN_ACTION_UUID, 'other-key', 'Run'], [TIMER_ACTION_UUID, 'other-key', 'Timer key'],
    [TIMER_ACTION_UUID, 'synthetic-key', 'same-key new session']]) {
    test(`${built ? 'built' : 'source'} ${label} reset does not leak previous policy/error or accept old ACK`, () => {
      // Arrange
      const h = harness({ built }); h.ready(); h.f.actionOnPress.value = 'stop'; const old = h.last(), socket = h.sockets[0];
      failSave(h, 'STATE_SAVE_FAILED'); h.f.actionOnPress.value = 'invalid';
      // Act
      h.ready(initial, action, context);
      h.reply({ ...old, type: 'canvas:reply', status: 'saved', settings: { ...initial, actionOnPress: 'stop' } }, socket);
      // Assert
      assert.equal(h.f.actionOnPress.value, action === TIMER_ACTION_UUID ? 'refresh' : '');
      assert.equal(h.f.status.textContent, ''); assert.deepEqual(h.edits(), []); assert.equal(socket.closed, true); h.dispose();
    });
  }
  for (const invalid of ['json', 'port', 'context', 'unknown']) {
    test(`${built ? 'built' : 'source'} invalid ${invalid} callback clears press binding immediately and ignores late ACK`, () => {
      // Arrange
      const h = harness({ built }); h.ready(); h.f.actionOnPress.value = 'stop'; const old = h.last(), socket = h.sockets[0];
      // Act
      h.connect(invalid === 'port' ? '0' : '12345', 'new-pi', 'registerPropertyInspector', '{}', invalid === 'json' ? '{invalid'
        : JSON.stringify({ context: invalid === 'context' ? '' : 'other-key', action: invalid === 'unknown' ? 'unknown' : TIMER_ACTION_UUID }));
      const reset = h.f.actionOnPress.value;
      h.reply({ ...old, type: 'canvas:reply', status: 'saved', settings: { ...initial, actionOnPress: 'stop' } }, socket);
      h.f.actionOnPress.value = 'refresh'; h.time.tick(200);
      // Assert
      assert.equal(reset, ''); assert.equal(h.f.timerControls.hidden, true); assert.equal(socket.closed, true);
      assert.equal(edits(socket).length, 1);
      if (invalid === 'context' || invalid === 'unknown') assert.equal(h.edits().length, 0);
      else assert.equal(h.edits().length, 1);
      h.dispose();
    });
  }
  test(`${built ? 'built' : 'source'} prebinding policy is ignored while early common file/args remain protected`, () => {
    // Arrange
    const h = harness({ built });
    // Act
    h.f.actionOnPress.value = 'stop'; h.f.executable.value = '/synthetic/selected'; h.f.argsText.value = 'local-edit';
    h.connect('0', 'pi', 'registerPropertyInspector', '{}', JSON.stringify({ context: 'key', action: TIMER_ACTION_UUID }));
    h.connect('12345', 'pi', 'registerPropertyInspector', '{}', '{invalid'); h.ready();
    // Assert
    assert.equal(h.f.actionOnPress.value, 'refresh'); assert.equal(h.f.executable.value, '/synthetic/selected');
    assert.equal(h.f.argsText.value, 'local-edit');
    assert.deepEqual(h.edits().map(message => message.payload.changes), [{ executable: '/synthetic/selected', argsText: 'local-edit' }]);
    h.dispose();
  });
  test(`${built ? 'built' : 'source'} early valid press selection protects against invalid stored handshake projection`, () => {
    // Arrange
    const h = harness({ built }), settings = { ...initial, actionOnPress: 'INVALID' }; h.bind(settings);
    // Act
    h.f.actionOnPress.value = 'stop'; h.open(); h.claim(settings); const request = h.last();
    const protectedView = [h.f.actionOnPress.value, h.f.status.textContent];
    h.reply({ ...request, type: 'canvas:reply', status: 'saved', settings: { ...initial, actionOnPress: 'stop' } });
    // Assert
    assert.deepEqual(protectedView, ['stop', 'Saving…']); assert.deepEqual(request.changes, { actionOnPress: 'stop' });
    assert.equal(h.edits().length, 1); assert.equal(h.f.status.textContent, ''); h.dispose();
  });
}

for (const [index, value] of ['', 'Refresh', 'STOP', ' stop', 1, true, null, new String('stop')].entries()) {
  test(`direct press edit ${index} rejects strict invalid enum without coercion`, () => {
    // Arrange
    const h = harness(); h.ready();
    // Act
    const accepted = h.bridge.edit({ actionOnPress: value }, { immediate: true });
    // Assert
    assert.equal(accepted, false); assert.deepEqual(h.edits(), []); assert.equal(h.errors.at(-1), 'ACTION_ON_PRESS_INVALID');
    assert.equal(h.f.status.textContent, pressError); h.dispose();
  });
}
test('press edit descriptors reject accessors and hostile proxy without getter execution or raw disclosure', () => {
  // Arrange
  const h = harness(); h.ready(); let reads = 0;
  const accessor = {}; Object.defineProperty(accessor, 'actionOnPress', { enumerable: true, get() { reads++; throw new Error('PRIVATE'); } });
  const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('PRIVATE'); } });
  // Act
  const accepted = [h.bridge.edit(accessor), h.bridge.edit(proxy), h.bridge.edit({ actionOnPress: 'stop', enabled: true })];
  // Assert
  assert.deepEqual(accepted, [false, false, false]); assert.equal(reads, 0); assert.deepEqual(h.edits(), []);
  assert.deepEqual(h.errors, ['ACTION_ON_PRESS_INVALID', 'INVALID_SETTINGS', 'INVALID_SETTINGS']);
  assert.equal(h.f.status.textContent.includes('PRIVATE'), false); h.dispose();
});

for (const binding of ['prebind', RUN_ACTION_UUID, ONCE_ACTION_UUID, 'unknown']) {
  test(`${binding} bridge cannot write a crafted valid press field`, () => {
    // Arrange
    const h = harness(); if (binding !== 'prebind') h.ready(initial, binding);
    // Act
    const accepted = h.bridge.edit({ actionOnPress: 'stop' }, { immediate: true });
    // Assert
    assert.equal(accepted, false); assert.equal(h.errors.at(-1), 'INVALID_SETTINGS');
    assert.equal(h.sockets.some(socket => edits(socket).length > 0), false); h.dispose();
  });
}
for (const policy of [undefined, 'stop']) {
  test(`built deferred DOM hydrates ${policy ?? 'missing Refresh'} press control without synchronous edits`, () => {
    // Arrange
    const h = harness({ built: true, loading: true }), settings = { ...initial };
    if (policy !== undefined) settings.actionOnPress = policy;
    // Act
    h.bind(settings); h.open(); h.claim(settings); h.events.get('DOMContentLoaded')();
    // Assert
    assert.equal(h.f.actionOnPress.value, policy ?? 'refresh'); assert.deepEqual(h.edits(), []);
    assert.equal(h.f.timerControls.hidden, false); assert.equal(h.f.status.textContent, ''); h.dispose();
  });
}

for (const built of [false, true]) for (const phase of ['disabled', 'running', 'waiting']) {
  test(`${built ? 'built' : 'source'} real Timer ${phase} policy saves preserve lifecycle; next tap follows confirmed Stop`, { timeout: 3000 }, async t => {
    // Arrange
    const h = harness({ built }), b = backend(t, h, { ...initial, args: ['retained legacy'] });
    await b.appear(); h.bind(); h.open(); await b.deliver();
    if (phase !== 'disabled') await b.tap();
    if (phase === 'waiting') { await b.finish(); b.time.advance(1000); await b.idle(); }
    const before = b.sessions[0].getState(), launches = b.launches.length;
    // Act
    h.f.actionOnPress.value = 'stop'; const request = h.last(); await b.deliver();
    const after = b.sessions[0].getState(); await b.tap(); const tapped = b.sessions[0].getState();
    // Assert
    assert.deepEqual(request.changes, { actionOnPress: 'stop' });
    assert.equal(after.enabled, before.enabled); assert.equal(after.phase, before.phase); assert.equal(after.dueMs, before.dueMs);
    assert.equal(b.writes.length, 1); assert.deepEqual(b.writes[0], { ...initial, args: ['retained legacy'], actionOnPress: 'stop' });
    assert.equal(b.replies.at(-1).status, 'saved'); assert.equal(h.f.status.textContent, '');
    assert.equal(tapped.enabled, phase === 'disabled');
    assert.equal(b.launches.length, launches + (phase === 'disabled' ? 1 : 0));
    assert.ok(b.launches.every(value => !Object.hasOwn(value, 'actionOnPress')));
    assert.equal(b.logs.some(value => value.includes('retained legacy')), false);
    if (phase === 'disabled') await b.finish();
  });
}
for (const built of [false, true]) {
  test(`${built ? 'built' : 'source'} real Timer policy save preserves ordinary error and existing retry deadline`, { timeout: 3000 }, async t => {
    // Arrange
    const h = harness({ built }), b = backend(t, h); await b.appear(); h.bind(); h.open(); await b.deliver(); await b.tap();
    await b.finish({ status: 'error', error: 'Program exited unsuccessfully.' }); const before = b.sessions[0].getState();
    // Act
    h.f.actionOnPress.value = 'stop'; await b.deliver(); const after = b.sessions[0].getState();
    // Assert
    assert.equal(before.presentation, 'error'); assert.equal(before.enabled, true);
    assert.equal(after.presentation, 'error'); assert.equal(after.enabled, true); assert.equal(after.dueMs, before.dueMs);
    assert.equal(after.suspended, before.suspended); assert.equal(b.launches.length, 1);
    assert.deepEqual(b.writes, [{ ...initial, actionOnPress: 'stop' }]); assert.equal(h.f.status.textContent, '');
  });
  test(`${built ? 'built' : 'source'} real Timer Refresh selection neither stops active child nor queues an active tap`, { timeout: 3000 }, async t => {
    // Arrange
    const settings = { ...initial, actionOnPress: 'stop' }, h = harness({ built }), b = backend(t, h, settings);
    await b.appear(); h.bind(settings); h.open(); await b.deliver(); await b.tap();
    // Act
    h.f.actionOnPress.value = 'refresh'; await b.deliver(); await b.tap();
    const active = b.sessions[0].getState(); await b.finish(); const complete = b.sessions[0].getState();
    // Assert
    assert.equal(active.enabled, true); assert.equal(active.phase, 'running'); assert.equal(b.launches.length, 1);
    assert.equal(complete.enabled, true); assert.equal(complete.dueMs, 60000);
    assert.deepEqual(b.writes, [{ ...initial, actionOnPress: 'refresh' }]); assert.equal(h.f.status.textContent, '');
  });
  test(`${built ? 'built' : 'source'} real Timer rejects invalid local press metadata without saving, enabling or launching`, { timeout: 3000 }, async t => {
    // Arrange
    const h = harness({ built }), b = backend(t, h); await b.appear(); h.bind(); h.open(); await b.deliver();
    // Act
    h.f.actionOnPress.value = 'STOP'; h.time.tick(200); await b.deliver();
    // Assert
    assert.deepEqual(b.writes, []); assert.deepEqual(b.launches, []); assert.equal(b.sessions[0].getState().enabled, false);
    assert.equal(h.f.status.textContent, pressError); assert.equal(b.sessions[0].getState().dueMs, undefined);
  });
}

for (const built of [false, true]) for (const [failure, expected] of saveFailures) {
  for (const recovery of ['same custom', 'same preset', 'Custom selection']) {
    test(`${built ? 'built' : 'source'} ${failure}: ${recovery} restores original save error without a redundant edit or false Saved`, () => {
      // Arrange
      const h = harness({ built }); h.ready(); h.f.intervalPreset.value = 'custom';
      const seconds = recovery === 'same preset' ? 30 : 17;
      h.f.intervalSeconds.value = String(seconds); h.time.tick(200); const request = h.last();
      // Act
      failSave(h, failure, request); const originalError = h.f.status.textContent;
      h.f.intervalSeconds.value = 'invalid-local'; const overlay = h.f.status.textContent;
      const before = h.edits().length; recoverLocalInterval(h, recovery, seconds); h.time.tick(200);
      // Assert
      assert.equal(originalError, expected); assert.equal(overlay, intervalError);
      assert.equal(h.f.status.textContent, expected); assert.equal(h.edits().length, before);
      assert.deepEqual(request.changes, { intervalSeconds: seconds });
      if (recovery === 'same preset') assert.equal(h.f.intervalPreset.value, String(seconds));
      else assert.equal(h.f.intervalSeconds.value, String(seconds));
      assert.equal(h.f.customInterval.hidden, recovery === 'same preset');
      assert.equal(h.time.timers.size, 0);
      h.dispose();
    });
  }
}

for (const built of [false, true]) for (const recovery of ['same custom', 'same preset', 'Custom selection']) {
  test(`${built ? 'built' : 'source'} pending save: ${recovery} restores Saving, not confirmation, and only matching ack clears it`, () => {
    // Arrange
    const h = harness({ built }); h.ready(); h.f.intervalPreset.value = 'custom';
    const seconds = recovery === 'same preset' ? 30 : 17;
    h.f.intervalSeconds.value = String(seconds); h.time.tick(200); const request = h.last();
    // Act
    h.f.intervalSeconds.value = 'invalid-local'; const overlay = h.f.status.textContent;
    recoverLocalInterval(h, recovery, seconds); const pending = h.f.status.textContent;
    h.time.tick(200); const count = h.edits().length;
    h.reply({ ...request, type: 'canvas:reply', status: 'saved', settings: { ...initial, intervalSeconds: seconds } });
    // Assert
    assert.equal(overlay, intervalError); assert.equal(pending, 'Saving…');
    assert.equal(count, 1); assert.equal(h.edits().length, count); assert.equal(h.f.status.textContent, '');
    assert.equal(h.time.timers.size, 0);
    h.dispose();
  });
}

for (const built of [false, true]) for (const recovery of ['same custom', 'same preset', 'Custom selection']) {
  test(`${built ? 'built' : 'source'} confirmed interval: ${recovery} clears only local invalid overlay without another write`, () => {
    // Arrange
    const h = harness({ built }); h.ready({ ...initial, intervalSeconds: 30 }); h.f.intervalPreset.value = 'custom';
    // Act
    h.f.intervalSeconds.value = 'invalid-local'; const overlay = h.f.status.textContent;
    recoverLocalInterval(h, recovery, 30); h.time.tick(200);
    // Assert
    assert.equal(overlay, intervalError); assert.equal(h.f.status.textContent, '');
    assert.deepEqual(h.edits(), []);
    if (recovery === 'same preset') {
      assert.equal(h.f.intervalPreset.value, '30'); assert.equal(h.f.customInterval.hidden, true);
    } else assert.equal(h.f.intervalSeconds.value, '30');
    assert.equal(h.time.timers.size, 0);
    h.dispose();
  });
}

for (const built of [false, true]) for (const [failure, expected] of saveFailures) {
  test(`${built ? 'built' : 'source'} ${failure}: new valid edit stays unconfirmed through foreign/stale replies until current matching acknowledgment`, () => {
    // Arrange
    const h = harness({ built }); h.ready(); h.f.intervalPreset.value = 'custom';
    h.f.intervalSeconds.value = '17'; h.time.tick(200); const old = h.last(); failSave(h, failure, old);
    const previousError = h.f.status.textContent;
    // Act
    h.f.intervalSeconds.value = 'invalid-local'; h.f.intervalSeconds.value = '19';
    const beforeSend = h.f.status.textContent; h.time.tick(200); const current = h.last();
    const saved = { ...current, type: 'canvas:reply', status: 'saved', settings: { ...initial, intervalSeconds: 19 } };
    const unconfirmed = [];
    h.reply({ ...old, type: 'canvas:reply', status: 'saved', settings: { ...initial, intervalSeconds: 17 } });
    unconfirmed.push([h.f.status.textContent, h.f.intervalSeconds.value]);
    for (const foreign of ['context', 'inspectorId', 'requestId']) {
      h.reply({ ...saved, [foreign]: foreign === 'requestId' ? current.requestId + 1 : 'foreign' });
      unconfirmed.push([h.f.status.textContent, h.f.intervalSeconds.value]);
    }
    h.reply(saved); const confirmed = h.f.status.textContent;
    h.reply({ ...old, type: 'canvas:reply', status: 'error', diagnosticCode: 'INVALID_SETTINGS' });
    // Assert
    assert.equal(previousError, expected); assert.equal(beforeSend, 'Saving…');
    assert.deepEqual(current.changes, { intervalSeconds: 19 }); assert.equal(h.edits().length, 2);
    assert.deepEqual(unconfirmed, Array.from({ length: 4 }, () => ['Saving…', '19']));
    assert.equal(confirmed, ''); assert.equal(h.f.status.textContent, ''); assert.equal(h.f.intervalSeconds.value, '19');
    assert.equal(h.time.timers.size, 0);
    h.dispose();
  });
}

for (const built of [false, true]) {
  test(`${built ? 'built' : 'source'} matching acknowledgment cannot hide still-invalid local interval text`, () => {
    // Arrange
    const h = harness({ built }); h.ready(); h.f.intervalPreset.value = 'custom';
    h.f.intervalSeconds.value = '17'; h.time.tick(200); const request = h.last();
    // Act
    h.f.intervalSeconds.value = 'invalid-local';
    h.reply({ ...request, type: 'canvas:reply', status: 'saved', settings: { ...initial, intervalSeconds: 17 } });
    const overlay = h.f.status.textContent, invalidText = h.f.intervalSeconds.value;
    h.f.intervalSeconds.value = '17'; h.time.tick(200);
    // Assert
    assert.equal(overlay, intervalError); assert.equal(invalidText, 'invalid-local');
    assert.equal(h.f.status.textContent, ''); assert.equal(h.edits().length, 1); assert.equal(h.time.timers.size, 0);
    h.dispose();
  });
}

for (const built of [false, true]) for (const [field, text, code, expected] of [
  ['executable', '/synthetic/new-program', 'INVALID_EXECUTABLE', 'Choose an absolute executable path.'],
  ['argsText', '"unterminated', 'ARGS_TEXT_INVALID', 'Check argument quotes and escapes.'],
]) {
  test(`${built ? 'built' : 'source'} common ${field} save diagnosis survives local interval correction and Custom selection`, () => {
    // Arrange
    const h = harness({ built }); h.ready(); h.f.intervalPreset.value = 'custom';
    h.f[field].value = text; h.time.tick(200); const request = h.last();
    // Act
    h.reply({ ...request, type: 'canvas:reply', status: 'error', diagnosticCode: code });
    h.f.intervalSeconds.value = 'invalid-local'; const overlay = h.f.status.textContent;
    h.f.intervalSeconds.value = '60'; const corrected = h.f.status.textContent;
    h.f.intervalPreset.value = 'custom'; h.time.tick(200);
    // Assert
    assert.deepEqual(request.changes, { [field]: text }); assert.equal(overlay, intervalError);
    assert.equal(corrected, expected); assert.equal(h.f.status.textContent, expected);
    assert.equal(h.edits().length, 1); assert.equal(h.f[field].value, text); assert.equal(h.time.timers.size, 0);
    h.dispose();
  });
}

for (const built of [false, true]) for (const [action, context, label] of [
  [RUN_ACTION_UUID, 'other-key', 'Run'], [TIMER_ACTION_UUID, 'other-key', 'different Timer'],
  [TIMER_ACTION_UUID, 'synthetic-key', 'same-key new session'],
]) {
  test(`${built ? 'built' : 'source'} ${label} binding reset discards previous error/local mode and rejects late old reply`, () => {
    // Arrange
    const h = harness({ built }); h.ready(); h.f.intervalPreset.value = 'custom';
    h.f.intervalSeconds.value = '17'; h.time.tick(200); const old = h.last(), oldSocket = h.sockets[0];
    failSave(h, 'STATE_SAVE_FAILED', old); h.f.intervalSeconds.value = 'invalid-local';
    // Act
    h.bind({ ...initial, intervalSeconds: 30 }, action, context);
    const resetStatus = h.f.status.textContent, resetMode = h.f.intervalPreset.value;
    h.open(); h.claim({ ...initial, intervalSeconds: 30 });
    h.reply({ ...old, type: 'canvas:reply', status: 'error', diagnosticCode: 'INVALID_SETTINGS' }, oldSocket);
    h.reply({ ...old, type: 'canvas:reply', status: 'saved', settings: { ...initial, intervalSeconds: 17 } });
    h.time.tick(200);
    // Assert
    assert.equal(resetStatus, ''); assert.equal(resetMode, action === RUN_ACTION_UUID ? '' : '30');
    assert.equal(h.f.status.textContent, ''); assert.equal(h.f.customInterval.hidden, true);
    assert.equal(h.f.timerControls.hidden, action === RUN_ACTION_UUID);
    assert.equal(h.f.intervalSeconds.value, action === RUN_ACTION_UUID ? '' : '30');
    assert.deepEqual(h.edits(), []); assert.equal(oldSocket.closed, true); assert.notEqual(h.last().inspectorId, old.inspectorId);
    assert.equal(h.time.timers.size, 0);
    h.dispose();
  });
}

for (const [failure] of saveFailures) for (const action of [RUN_ACTION_UUID, TIMER_ACTION_UUID]) {
  test(`built deferred DOM: old ${failure} status cannot replay after new ${action === RUN_ACTION_UUID ? 'Run' : 'Timer'} binding`, () => {
    // Arrange
    const h = harness({ built: true, loading: true }); h.bind(); h.open();
    const old = h.last(), oldSocket = h.sockets[0]; failSave(h, failure, old);
    // Act
    h.bind({ ...initial, intervalSeconds: 30 }, action, 'other-key'); h.open();
    h.events.get('DOMContentLoaded')(); const beforeAck = h.f.status.textContent;
    h.claim({ ...initial, intervalSeconds: 30 });
    h.reply({ ...old, type: 'canvas:reply', status: 'error', diagnosticCode: 'INVALID_SETTINGS' }, oldSocket);
    // Assert
    assert.equal(beforeAck, ''); assert.equal(h.f.status.textContent, ''); assert.equal(h.chained(), 0);
    assert.equal(h.f.timerControls.hidden, action === RUN_ACTION_UUID);
    assert.equal(h.f.intervalPreset.value, action === RUN_ACTION_UUID ? '' : '30');
    assert.deepEqual(h.edits(), []); assert.equal(oldSocket.closed, true); assert.equal(h.sockets.length, 2);
    assert.equal(h.time.timers.size, 0);
    h.dispose();
  });
}
