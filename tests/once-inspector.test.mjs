import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createInspectorBridge, ONCE_ACTION_UUID, RUN_ACTION_UUID, TIMER_ACTION_UUID } from '../src/inspector/bridge.mjs';
import { createInspectorController } from '../src/inspector/run.mjs';
import { parseArguments } from '../src/core/arguments.mjs';

const initial = { executable: '/synthetic/report.py', argsText: '', cwd: '', themeColor: '#123456' };
const asset = name => readFileSync(new URL(`../git.renaudcerrato.deckforge.sdPlugin/ui/${name}`, import.meta.url), 'utf8');
function control(value = '') {
  const listeners = new Map();
  return { get value() { return value; },
    set value(next) { value = typeof next === 'string' ? next.replace(/[\r\n]/g, '') : next; this.dispatch('valuechange'); },
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
    dispatch(name) { for (const fn of listeners.get(name) ?? []) fn({ type: name, bubbles: false }); },
  };
}
// Fail the real unsupported SDPI property assignment without simulating its internals.
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
function clock() {
  let time = 0, id = 0;
  const timers = new Map();
  return { timers,
    setTimer(callback, delay) { const key = ++id; timers.set(key, { callback, due: time + delay }); return key; },
    clearTimer(key) { timers.delete(key); },
    advance(ms) { time += ms; for (const [key, timer] of [...timers]) if (timer.due <= time && timers.delete(key)) timer.callback(); },
  };
}
// Objective: real bridge/controller and generated entry, with only DOM, transport and time faked.
function harness({ built = false, loading = false } = {}) {
  const f = { executable: control(), argsText: control(), cwd: cwdControl(), title: cwdControl(), themeColor: control(),
    intervalPreset: control(), intervalSeconds: control(), actionOnPress: control(),
    timerControls: { hidden: true }, customInterval: { hidden: true },
    status: { textContent: '', set innerHTML(_) { throw Error('Status must remain plaintext'); } } };
  const time = clock(), sockets = [], errors = [], events = new Map();
  let bridge, controller, connect, dispose, chained = 0;
  class Socket {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(text) { this.sent.push(JSON.parse(text)); }
    close() { this.closed = true; this.readyState = 3; }
  }
  if (built) {
    const window = { connectElgatoStreamDeckSocket() { chained++; }, addEventListener(name, fn) { events.set(name, fn); } };
    const ids = { ...f, 'timer-controls': f.timerControls, 'custom-interval': f.customInterval, 'settings-status': f.status };
    const document = { readyState: loading ? 'loading' : 'complete', getElementById: id => ids[id], addEventListener(name, fn) { events.set(name, fn); } };
    runInNewContext(asset('run.js'), { window, document, WebSocket: Socket, TextEncoder,
      Date: class extends Date { static now() { return 123; } }, Math: Object.assign(Object.create(Math), { random: () => 0.25 }),
      setTimeout: time.setTimer, clearTimeout: time.clearTimer }, { timeout: 1000 });
    connect = (...args) => window.connectElgatoStreamDeckSocket(...args); dispose = () => events.get('unload')();
  } else {
    bridge = createInspectorBridge({ inspectorId: 'synthetic-pi', createSocket: url => new Socket(url),
      setTimer: time.setTimer, clearTimer: time.clearTimer,
      onSettings: (config, protectedFields) => controller.hydrate(config, protectedFields),
      onError(code, stage) { errors.push(code); controller.showError(code, stage); }, onStatus: value => controller.showStatus(value),
      onConnectionState: state => controller?.setActionBinding(state),
    });
    controller = createInspectorController({ ...f, bridge }); connect = bridge.connect;
    dispose = () => { controller.dispose(); bridge.disconnect(); };
  }
  const normal = socket => socket.sent;
  const last = () => normal(sockets.at(-1)).at(-1).payload;
  const reply = (payload, socket = sockets.at(-1)) => socket.onmessage({ data: JSON.stringify({ event: 'sendToPropertyInspector', payload }) });
  const bind = (settings = initial, action = ONCE_ACTION_UUID, context = 'synthetic-once-key', info = '{}') =>
    connect('12345', 'transport-pi', 'registerPropertyInspector', info, JSON.stringify({ context, action, payload: { settings } }));
  const open = () => { sockets.at(-1).readyState = 1; sockets.at(-1).onopen(); };
  const claim = (settings = initial) => {
    reply({ ...last(), type: 'canvas:reply', status: 'challenge', token: 'synthetic-token', settings });
    reply({ ...last(), type: 'canvas:reply', status: 'saved', settings });
  };
  const ready = (settings = initial, action = ONCE_ACTION_UUID, context, info = '{}') => { bind(settings, action, context, info); open(); claim(settings); };
  return { f, time, sockets, errors, events, bridge, connect, bind, open, claim, ready, last, reply, dispose,
    chained: () => chained, edits: () => sockets.at(-1).sent.filter(message => message.payload?.type === 'canvas:edit') };
}
for (const built of [false, true]) {
  test(`TITLE-1 Run inspector title uses shared saved-only control and debounce (built=${built})`, () => {
    // Arrange
    const h = harness({ built }); h.ready({ ...initial, title: 'saved' }); const hydration = [...h.edits()];
    // Act
    h.f.title.value = 'a/b.txt'; const before = h.edits().length; h.time.advance(199); const beforeDeadline = h.edits().length;
    h.time.advance(1); const request = h.last();
    h.reply({ ...request, type: 'canvas:reply', status: 'saved', settings: { ...initial, title: 'a/b.txt' } });
    h.f.title.value = ''; h.time.advance(200); const clear = h.last();
    // Assert
    assert.deepEqual(hydration, []); assert.equal(before, 0); assert.equal(beforeDeadline, 0);
    assert.equal(h.f.title.renderedHint, 'report');
    assert.deepEqual(JSON.parse(JSON.stringify(request.changes)), { title: 'a/b.txt' });
    assert.deepEqual(JSON.parse(JSON.stringify(clear.changes)), { title: '' }); assert.equal(h.f.timerControls.hidden, true);
    assert.deepEqual(h.errors, []); h.dispose();
  });
}
test('TITLE-1 Run inspector invalid title has fixed diagnostics and old binding replies are ignored', () => {
  // Arrange
  const h = harness(); h.ready({ ...initial, title: 'old' }); h.f.title.value = 'pending'; h.time.advance(200);
  const old = h.last(), socket = h.sockets[0];
  // Act
  h.ready({ ...initial, executable: '/other.EXE', title: 'new' });
  h.reply({ ...old, type: 'canvas:reply', status: 'saved', settings: { ...initial, title: 'stale' } }, socket);
  const before = h.edits().length; const accepted = h.bridge.edit({ title: 'x'.repeat(8193), themeColor: '#abcdef' }); h.time.advance(200);
  // Assert
  assert.equal(h.f.title.value, 'new'); assert.equal(h.f.title.renderedHint, 'other');
  assert.equal(accepted, false); assert.equal(h.edits().length, before); assert.deepEqual(h.errors, ['TITLE_INVALID']); h.dispose();
});

test('Windows Run legacy projection preserves literal paths, quotes and CRLF without hydration writes', () => {
  // Arrange
  const h = harness(), args = [String.raw`C:\temp\new`, 'C:\\Folder\\', `both'"quotes`, 'a\r\nb', ''];
  const settings = { executable: 'C:/python.exe', args: JSON.stringify(args) }, original = structuredClone(settings);
  // Act
  h.ready(settings, ONCE_ACTION_UUID, 'windows-args', JSON.stringify({ application: { platform: 'windows' } }));
  const actual = parseArguments(h.f.argsText.value, 'win32');
  // Assert
  assert.deepEqual(actual, args); assert.equal(/[\r\n]/.test(h.f.argsText.value), false);
  assert.deepEqual(h.edits(), []); assert.deepEqual(h.errors, []); assert.deepEqual(settings, original); h.dispose();
});

test('Windows Run malformed multiline text cannot fall back to legacy arguments or leak input', () => {
  // Arrange
  const h = harness(), settings = { executable: 'C:/python.exe', args: ['legacy'], argsText: '"private\nunterminated' };
  // Act
  h.ready(settings, ONCE_ACTION_UUID, 'windows-invalid-args', JSON.stringify({ application: { platform: 'windows' } }));
  // Assert
  assert.equal(h.f.argsText.value, undefined); assert.ok(h.errors.includes('ARGS_TEXT_INVALID'));
  assert.equal(h.f.status.textContent.includes('private'), false); assert.deepEqual(h.edits(), []); h.dispose();
});

test('Windows Run inspector accepts local drive picker but hides and rejects every foreign launch control', () => {
  // Arrange
  const h = harness(), settings = { ...initial, executable: 'C:/report.PY' };
  h.ready(settings, ONCE_ACTION_UUID, 'windows-once', JSON.stringify({ application: { platform: 'windows' } }));
  const hydration = [...h.edits()];
  // Act
  h.f.executable.value = String.raw`D:\folder\report.PY`; const picker = h.last(), count = h.edits().length;
  h.f.executable.value = String.raw`\\server\share\report.PY`;
  const foreign = [{ runRequested: true }, { intervalSeconds: 5 }, { actionOnPress: 'stop' }].map(changes => h.bridge.edit(changes));
  // Assert
  assert.deepEqual(hydration, []); assert.deepEqual(picker.changes, { executable: String.raw`D:\folder\report.PY` });
  assert.equal(h.edits().length, count); assert.deepEqual(foreign, [false, false, false]);
  assert.equal(h.f.executable.value, String.raw`D:\folder\report.PY`);
  assert.equal(h.f.timerControls.hidden, true); assert.equal(h.f.customInterval.hidden, true);
  assert.equal(h.f.cwd.renderedHint, String.raw`C:\absolute\path\to\working-directory`); h.dispose();
});
for (const loading of [false, true]) {
  for (const [platform, executable, cwd, hint] of [
    ['windows', String.raw`C:\synthetic\report.PY`, String.raw`D:\synthetic\work`, String.raw`C:\absolute\path\to\working-directory`],
    ['mac', '/synthetic/report.py', '/synthetic/work', '/absolute/path/to/working-directory'],
  ]) {
    test(`built Run ${platform} startup callback ${loading ? 'before' : 'after'} DOM readiness hydrates stored fields without placeholder exceptions`, () => {
      // Arrange
      const settings = { ...initial, executable, argsText: '"two words" ""', cwd }, original = structuredClone(settings);
      let h;
      // Act: minified production entry, not a reconstruction of its installer.
      const startup = () => {
        h = harness({ built: true, loading }); h.bind(settings, ONCE_ACTION_UUID, 'startup-once', JSON.stringify({ application: { platform } }));
        h.open(); if (loading) h.events.get('DOMContentLoaded')(); h.claim(settings); h.time.advance(200);
      };
      // Assert: old direct string property assignment aborts controller creation.
      assert.doesNotThrow(startup);
      assert.equal(h.f.executable.value, executable); assert.equal(h.f.argsText.value, settings.argsText); assert.equal(h.f.cwd.value, cwd);
      assert.equal(h.f.cwd.renderedHint, hint); assert.equal(h.f.timerControls.hidden, true); assert.equal(h.f.customInterval.hidden, true);
      assert.equal(h.sockets.length, 1); assert.equal(h.chained(), 0); assert.deepEqual(h.edits(), []);
      assert.equal(h.sockets[0].sent.some(message => message.event === 'setSettings'), false); assert.deepEqual(settings, original);
      h.dispose(); assert.equal(h.time.timers.size, 0);
    });
  }
}
for (const built of [false, true]) {
  test(`Run ${built ? 'built entry' : 'source bridge'} binds third UUID, hydrates read-only and hides all Loop controls`, () => {
    // Arrange
    const h = harness({ built }), settings = structuredClone(initial);
    // Act
    h.ready(settings); h.time.advance(200); const socket = h.sockets[0]; h.dispose();
    // Assert
    assert.equal(h.f.timerControls.hidden, true); assert.equal(h.f.customInterval.hidden, true);
    assert.equal(h.f.actionOnPress.value, ''); assert.equal(h.f.intervalPreset.value, '');
    assert.equal(h.f.executable.value, initial.executable); assert.equal(h.f.themeColor.value, '#123456');
    assert.deepEqual(h.edits(), []); assert.deepEqual(settings, initial); assert.equal(h.sockets.length, 1);
    assert.ok(socket.sent.filter(message => message.event === 'sendToPlugin').every(message =>
      message.action === ONCE_ACTION_UUID && message.context === 'transport-pi' && message.payload.context === 'synthetic-once-key'));
    assert.equal(socket.sent.some(message => message.event === 'setSettings'), false);
    assert.equal(socket.closed, true); assert.equal(h.time.timers.size, 0); assert.equal(h.chained(), 0);
  });
}
for (const field of ['argsText', 'cwd', 'themeColor', 'executable']) {
  test(`Run ${field} autosave uses narrow common edit with exact debounce/picker policy`, () => {
    // Arrange
    const h = harness(); h.ready(); const values = { argsText: "'two words' '$HOME'", cwd: '/synthetic/work', themeColor: '#ABCDEF', executable: '/synthetic/new.sh' };
    // Act
    h.f[field].value = values[field]; if (field === 'themeColor') h.f[field].dispatch('input');
    const before = h.edits().length; h.time.advance(199); const almost = h.edits().length; h.time.advance(1);
    const request = h.last(); h.reply({ ...request, type: 'canvas:reply', status: 'saved', settings: { ...initial, [field]: field === 'themeColor' ? '#abcdef' : values[field] } });
    // Assert
    assert.equal(before, field === 'executable' ? 1 : 0); assert.equal(almost, before); assert.equal(h.edits().length, 1);
    assert.deepEqual(request.changes, { [field]: field === 'themeColor' ? '#abcdef' : values[field] });
    assert.equal(h.f.status.textContent, ''); assert.equal(h.f.timerControls.hidden, true); h.dispose();
  });
}
for (const changes of [{ intervalSeconds: 30 }, { actionOnPress: 'stop' }, { runRequested: true }, { enabled: true }, { settings: initial }]) {
  test('Run rejects programmatic scheduling/intent/full-settings edits while hidden controls cannot send', () => {
    // Arrange
    const h = harness(); h.ready();
    // Act
    h.f.intervalPreset.value = '10'; h.f.intervalSeconds.value = '30'; h.f.actionOnPress.value = 'stop';
    const accepted = h.bridge.edit(changes, { immediate: true }); h.time.advance(200);
    // Assert
    assert.equal(accepted, false); assert.deepEqual(h.edits(), []); assert.equal(h.errors.at(-1), 'INVALID_SETTINGS');
    assert.equal(h.f.timerControls.hidden, true); h.dispose();
  });
}
for (const [name, legacy, expected] of [['array', { args: ['a\rb', 'c\nd', 'e\r\nf', '', '$HOME'] }, ['a\rb', 'c\nd', 'e\r\nf', '', '$HOME']],
  ['JSON', { args: '["a\\nb","", "two words"]' }, ['a\nb', '', 'two words']],
  ['empty text precedence', { argsText: '', args: ['retained'] }, []]]) {
  test(`Run ${name} projects single-line literal argv without erasing legacy data or saving defaults`, () => {
    // Arrange
    const h = harness(), settings = { executable: initial.executable, ...legacy }, original = structuredClone(settings);
    // Act
    h.ready(settings); const parsed = parseArguments(h.f.argsText.value);
    // Assert
    assert.deepEqual(parsed, expected); assert.equal(/[\r\n]/.test(h.f.argsText.value), false);
    assert.deepEqual(settings, original); assert.deepEqual(h.edits(), []); h.dispose();
  });
}
test('Run malformed legacy argv yields only fixed plaintext diagnosis with no hydration write', () => {
  // Arrange
  const h = harness(), settings = { executable: initial.executable, args: 'SYNTHETIC_PRIVATE_INVALID' };
  // Act
  h.ready(settings);
  // Assert
  assert.equal(h.f.argsText.value, undefined); assert.equal(h.f.status.textContent, 'Replace the invalid legacy arguments.');
  assert.deepEqual(h.edits(), []); assert.equal(settings.args, 'SYNTHETIC_PRIVATE_INVALID'); h.dispose();
});
test('Run early picker/text edits remain protected through initial host/challenge/claim hydration', () => {
  // Arrange
  const h = harness();
  // Act
  h.f.executable.value = '/synthetic/selected'; h.f.argsText.value = 'local'; h.bind(); h.open(); h.claim(); h.time.advance(200);
  // Assert
  assert.equal(h.f.executable.value, '/synthetic/selected'); assert.equal(h.f.argsText.value, 'local');
  assert.deepEqual(h.edits().map(message => message.payload.changes), [{ executable: '/synthetic/selected', argsText: 'local' }]); h.dispose();
});
for (const foreign of ['context', 'inspectorId', 'requestId']) {
  test(`Run foreign ${foreign} reply cannot confirm save or overwrite typing`, () => {
    // Arrange
    const h = harness(); h.ready(); h.f.argsText.value = 'local'; h.time.advance(200); const request = h.last();
    // Act
    h.reply({ ...request, type: 'canvas:reply', status: 'saved', settings: { ...initial, argsText: 'foreign' },
      [foreign]: foreign === 'requestId' ? request.requestId + 1 : 'foreign' });
    // Assert
    assert.equal(h.f.argsText.value, 'local'); assert.equal(h.f.status.textContent, 'Saving…'); h.dispose();
  });
}
test('Run old saved reply cannot replace newer pending text or falsely report confirmation', () => {
  // Arrange
  const h = harness(); h.ready(); h.f.argsText.value = 'old'; h.time.advance(200); const old = h.last();
  // Act
  h.f.argsText.value = 'new'; h.reply({ ...old, type: 'canvas:reply', status: 'saved', settings: { ...initial, argsText: 'old' } });
  const newest = h.last(), pending = h.f.status.textContent;
  h.reply({ ...newest, type: 'canvas:reply', status: 'saved', settings: { ...initial, argsText: 'new' } });
  // Assert
  assert.deepEqual(newest.changes, { argsText: 'new' }); assert.equal(pending, 'Saving…');
  assert.equal(h.f.argsText.value, 'new'); assert.equal(h.f.status.textContent, ''); h.dispose();
});
for (const action of [ONCE_ACTION_UUID, RUN_ACTION_UUID, TIMER_ACTION_UUID]) {
  test('Run rebind isolates per-key state and stale replies across all three action identities', () => {
    // Arrange
    const h = harness(); h.ready(); h.f.argsText.value = 'old'; h.time.advance(200);
    const old = h.last(), oldSocket = h.sockets[0]; h.f.argsText.value = 'pending-old';
    // Act
    h.ready({ ...initial, argsText: 'new-key', intervalSeconds: 30 }, action, 'synthetic-other-key');
    h.reply({ ...old, type: 'canvas:reply', status: 'saved', settings: { ...initial, argsText: 'old' } }, oldSocket); h.time.advance(200);
    // Assert
    assert.equal(oldSocket.closed, true); assert.equal(h.f.argsText.value, 'new-key'); assert.deepEqual(h.edits(), []);
    assert.equal(h.f.timerControls.hidden, action !== TIMER_ACTION_UUID); assert.notEqual(h.last().inspectorId, old.inspectorId); h.dispose();
  });
}
for (const action of ['synthetic.unknown', 'git.renaudcerrato.deckforge.timer', 'git.renaudcerrato.deckforge.once']) {
test(`${action} invalidates former Run binding without a legacy alias`, () => {
  // Arrange
  const h = harness(); h.ready(); const old = h.sockets[0];
  // Act
  h.bind(initial, action);
  // Assert
  assert.equal(old.closed, true); assert.equal(h.sockets.length, 2);
  assert.equal(h.bridge.getConnectionState().bindingValid, false);
  assert.equal(h.f.timerControls.hidden, true); h.dispose();
});
}
// PRE-MERGE-WINDOWS-01: no trace side channel on success or rejected user input.
for (const built of [false, true]) {
  test(`Run ${built ? 'built entry' : 'source bridge'} sends only correlated configuration, never diagnostic snapshots`, () => {
    // Arrange
    const h = harness({ built }), settings = { ...initial, argsText: 'PRIVATE_STORED_ARG', unknown: 'PRIVATE_SETTINGS' };
    h.ready(settings); const hydrationEdits = [...h.edits()];
    // Act
    h.f.executable.value = '/synthetic/PRIVATE_PICKER'; const picker = h.last();
    h.reply({ ...picker, type: 'canvas:reply', status: 'saved', settings: { ...settings, executable: '/synthetic/PRIVATE_PICKER' } });
    const before = h.sockets[0].sent.length;
    h.f.executable.value = 'PRIVATE_INVALID_PATH';
    h.f.argsText.value = 'PRIVATE_USER_ARG'; h.f.cwd.value = '/synthetic/PRIVATE_CWD';
    const beforeDebounce = h.sockets[0].sent.length; h.time.advance(200); const edit = h.last();
    // Assert: selected fields are authorized edits, not additional log/trace payloads.
    assert.deepEqual(hydrationEdits, []); assert.equal(beforeDebounce, before);
    assert.deepEqual(picker.changes, { executable: '/synthetic/PRIVATE_PICKER' });
    assert.deepEqual(edit.changes, { argsText: 'PRIVATE_USER_ARG', cwd: '/synthetic/PRIVATE_CWD' });
    assert.equal(h.f.executable.value, '/synthetic/PRIVATE_PICKER');
    assert.deepEqual(h.sockets[0].sent.filter(message => message.payload?.type === 'canvas:trace'), []);
    assert.deepEqual(h.sockets[0].sent.filter(message => message.event === 'sendToPlugin').map(message => message.payload.type), ['canvas:hello', 'canvas:claim', 'canvas:edit', 'canvas:edit']);
    assert.equal(JSON.stringify(h.sockets[0].sent).includes('PRIVATE_SETTINGS'), false);
    assert.equal(JSON.stringify(h.sockets[0].sent).includes('PRIVATE_STORED_ARG'), false);
    assert.equal(JSON.stringify(h.sockets[0].sent).includes('PRIVATE_INVALID_PATH'), false); h.dispose();
  });
}
test('Run save timeout remains unconfirmed despite a late reply and dispose cancels listeners/debounce', () => {
  // Arrange
  const h = harness(); h.ready(); h.f.argsText.value = 'local'; h.time.advance(200); const request = h.last();
  // Act
  h.time.advance(15000); h.reply({ ...request, type: 'canvas:reply', status: 'saved', settings: { ...initial, argsText: 'local' } });
  const status = h.f.status.textContent; h.f.argsText.value = 'pending'; h.dispose(); h.f.argsText.value = 'disposed'; h.time.advance(200);
  // Assert
  assert.equal(status, 'Settings could not be confirmed.'); assert.equal(h.edits().length, 1);
  assert.equal(h.time.timers.size, 0); assert.equal(h.sockets[0].closed, true);
});
test('built Run callback before DOM readiness still uses one replaced socket and common autosave only', () => {
  // Arrange
  const h = harness({ built: true, loading: true });
  // Act
  h.bind(); h.open(); h.events.get('DOMContentLoaded')(); h.claim();
  h.f.intervalPreset.value = '10'; h.f.actionOnPress.value = 'stop'; h.f.argsText.value = 'literal'; h.time.advance(200); h.dispose();
  // Assert
  assert.equal(h.chained(), 0); assert.equal(h.sockets.length, 1); assert.equal(h.f.timerControls.hidden, true);
  assert.deepEqual(h.edits().map(message => message.payload.changes), [{ argsText: 'literal' }]); assert.equal(h.time.timers.size, 0);
});
test('shared Run inspector keeps authored status placement and has no additional complete-settings writer', () => {
  // Arrange
  const html = asset('run.html');
  // Act
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(match => match[1]);
  // Assert
  assert.deepEqual(scripts, ['sdpi-components.js', 'run.js']); assert.equal(/\bsetting\s*=|\bApply\b|<button/.test(html), false);
  assert.ok(html.indexOf('id="settings-status"') > html.indexOf('id="themeColor"'));
  assert.match(html, /<div id="timer-controls" hidden>/);
});
