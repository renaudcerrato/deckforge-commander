import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createInspectorFixture } from './helpers/inspector-harness.mjs';
import { createInspectorBridge } from '../src/inspector/bridge.mjs';
import { createInspectorController } from '../src/inspector/run.mjs';
import { parseArguments } from '../src/core/arguments.mjs';
import { getInspectorConfiguration, validateSettings } from '../src/core/settings.mjs';

const initial = { executable: '/program', argsText: 'old', cwd: '', runRequested: false };
function controls() {
  return createInspectorFixture().fields;
}
const normalMessages = socket => socket.sent;
const traceMessages = socket => socket.sent.filter(message => message.payload?.type === 'canvas:trace');
function harness(overrides = {}) {
  const sockets = [], timers = new Map(), errors = [], statuses = [], connections = [];
  const fields = controls();
  let id = 0, controller;
  const bridge = createInspectorBridge({
    inspectorId: 'test-inspector',
    createSocket(url) {
      const socket = { url, readyState: 0, sent: [], closed: false, send(text) { this.sent.push(JSON.parse(text)); }, close() { this.closed = true; this.readyState = 3; } };
      sockets.push(socket);
      return socket;
    },
    setTimer(callback, delay) { const key = ++id; timers.set(key, { callback, delay }); return key; },
    clearTimer(key) { timers.delete(key); },
    onSettings(configuration, protectedFields) { controller.hydrate(configuration, protectedFields); },
    onError(code, stage) { errors.push(code); controller.showError(code, stage); },
    onStatus(value) { statuses.push(value); controller.showStatus(value); },
    onConnectionState(snapshot) {
      connections.push(snapshot);
    },
    ...overrides,
  });
  controller = createInspectorController({ ...fields, bridge });
  const normal = (socket = sockets.at(-1)) => normalMessages(socket);
  const last = () => normal().at(-1).payload;
  function reply(payload, socket = sockets.at(-1)) {
    socket.onmessage({ data: JSON.stringify({ event: 'sendToPropertyInspector', payload }) });
  }
  function connect(settings = initial, context = 'key-context', info = '{}') {
    bridge.connect('12345', 'pi-id', 'registerPropertyInspector', info, JSON.stringify({ context, action: 'git.renaudcerrato.deckforge.stream', payload: { settings } }));
    sockets.at(-1).readyState = 1;
    sockets.at(-1).onopen();
  }
  function ready(settings = initial, info = '{}') {
    connect(settings, 'key-context', info);
    reply({ ...last(), type: 'canvas:reply', status: 'challenge', token: 'test-token', settings });
    reply({ ...last(), type: 'canvas:reply', status: 'saved', settings });
  }
  function tick(delay) {
    for (const [key, timer] of [...timers]) {
      if (timer.delay === delay) { timers.delete(key); timer.callback(); }
    }
  }
  return { bridge, controller, fields, sockets, timers, errors, statuses, connections, normal, connect, ready, reply, last, tick };
}

// S2: the SDK registration platform is connection-local, never a settings field.
test('TITLE-1 Stream inspector hydrates saved title only, repaints dynamic placeholder and debounces literal edits', () => {
  // Arrange
  const h = harness(); h.ready({ ...initial, executable: '/synthetic/report.PY' });
  const hydration = h.normal().filter(message => message.payload?.type === 'canvas:edit');
  const hint = h.fields.title.renderedHint;
  // Act
  h.fields.title.value = 'a/b\\c.txt'; const before = h.normal().length;
  h.tick(200); const request = h.last();
  h.reply({ ...request, type: 'canvas:reply', status: 'saved', settings: { ...initial, executable: '/synthetic/report.PY', title: 'a/b\\c.txt' } });
  h.fields.executable.value = '/synthetic/other.SH'; const changedHint = h.fields.title.renderedHint;
  h.fields.title.value = ''; h.tick(200); const cleared = h.last();
  // Assert
  assert.deepEqual(hydration, []); assert.equal(hint, 'report'); assert.equal(changedHint, 'other');
  assert.deepEqual(request.changes, { title: 'a/b\\c.txt' }); assert.ok(h.normal().length > before);
  assert.equal(h.fields.title.value, ''); assert.equal(cleared.changes.title, '');
  assert.deepEqual(h.errors, []); assert.equal(h.sockets.length, 1);
  h.controller.dispose(); h.bridge.disconnect();
});
test('TITLE-1 Stream inspector rejects invalid titles atomically and ignores old title acknowledgement after rebind', () => {
  // Arrange
  const h = harness(); h.ready({ ...initial, title: 'old' });
  h.fields.title.value = 'pending'; h.tick(200); const old = h.last(), socket = h.sockets[0];
  // Act
  h.ready({ ...initial, executable: '/new.py', title: 'new binding' });
  h.reply({ ...old, type: 'canvas:reply', status: 'saved', settings: { ...initial, title: 'stale' } }, socket);
  const before = h.normal().length;
  const rejected = [null, 42, {}, 'bad\0title', 'x'.repeat(8193)].map(title => h.bridge.edit({ title, themeColor: '#abcdef' }));
  h.tick(200);
  // Assert
  assert.equal(h.fields.title.value, 'new binding'); assert.equal(h.fields.title.renderedHint, 'new');
  assert.deepEqual(rejected, Array(5).fill(false)); assert.equal(h.normal().length, before);
  assert.deepEqual(h.errors, Array(5).fill('TITLE_INVALID'));
  assert.equal(h.fields.status.textContent.includes('bad'), false);
  h.controller.dispose(); h.bridge.disconnect();
});

test('argument projection follows Windows to Mac and back registration, ignoring stale replies without saves', () => {
  // Arrange: multiline stored text forces read-only parsing and one-line projection.
  const h = harness(), argsText = 'two\\ words\n--flag';
  const windows = { executable: 'C:/program', argsText }, mac = { executable: '/program', argsText };
  const windowsInfo = JSON.stringify({ application: { platform: 'windows' } });
  // Act
  h.ready(windows, windowsInfo);
  const first = parseArguments(h.fields.argsText.value, 'win32'), oldSocket = h.sockets[0], oldReply = h.last();
  h.ready(mac, JSON.stringify({ application: { platform: 'mac' } }));
  h.reply({ ...oldReply, type: 'canvas:reply', status: 'saved', settings: windows }, oldSocket);
  const second = parseArguments(h.fields.argsText.value, 'posix');
  h.ready(windows, windowsInfo);
  const third = parseArguments(h.fields.argsText.value, 'win32');
  // Assert
  assert.deepEqual(first, ['two\\', 'words', '--flag']); assert.deepEqual(second, ['two words', '--flag']);
  assert.deepEqual(third, first); assert.equal(oldSocket.closed, true);
  assert.equal(/[\r\n]/.test(h.fields.argsText.value), false); assert.deepEqual(h.errors, []);
  assert.equal(h.sockets.flatMap(socket => socket.sent).some(message => message.event === 'setSettings' || message.payload?.type === 'canvas:edit'), false);
  assert.equal(windows.argsText, argsText); assert.equal(mac.argsText, argsText);
  h.controller.dispose(); h.bridge.disconnect();
});

test('Windows Stream inspector keeps malformed argument text invalid instead of projecting legacy argv', () => {
  // Arrange
  const h = harness(), settings = { executable: 'C:/program', args: ['legacy'], argsText: '"private\nunterminated' };
  // Act
  h.ready(settings, JSON.stringify({ application: { platform: 'windows' } }));
  // Assert
  assert.equal(h.fields.argsText.value, undefined); assert.ok(h.errors.includes('ARGS_TEXT_INVALID'));
  assert.equal(h.normal().some(message => message.payload?.type === 'canvas:edit'), false);
  assert.equal(h.fields.status.textContent.includes('private'), false);
  h.controller.dispose(); h.bridge.disconnect();
});

test('Windows inspector accepts drive picker immediately, keeps text debounce and rejects nonlocal paths', () => {
  // Arrange
  const h = harness(), settings = { executable: 'C:/old.EXE', argsText: '', cwd: '' };
  h.ready(settings, JSON.stringify({ application: { platform: 'windows' } }));
  const hydrationEdits = h.normal().filter(message => message.payload?.type === 'canvas:edit');
  // Act
  h.fields.executable.value = String.raw`C:\folder\é report.EXE`;
  const picker = h.last();
  h.reply({ ...picker, type: 'canvas:reply', status: 'saved', settings: { ...settings, executable: String.raw`C:\folder\é report.EXE` } });
  const beforeText = h.normal().length;
  h.fields.argsText.value = String.raw`'C:\literal\arg' ''`; h.fields.cwd.value = 'D:/work';
  const beforeDebounce = h.normal().length; h.tick(200); const text = h.last();
  const beforeInvalid = h.normal().length;
  for (const path of ['', 'C:relative', '/posix/program', String.raw`\\server\share\program`, String.raw`\\?\C:\program`]) h.fields.executable.value = path;
  // Assert
  assert.deepEqual(hydrationEdits, []); assert.equal(h.bridge.getConnectionState().platform, 'win32');
  assert.deepEqual(picker.changes, { executable: String.raw`C:\folder\é report.EXE` });
  assert.equal(beforeDebounce, beforeText); assert.deepEqual(text.changes, { argsText: String.raw`'C:\literal\arg' ''`, cwd: 'D:/work' });
  assert.equal(h.normal().length, beforeInvalid); assert.equal(h.fields.executable.value, String.raw`C:\folder\é report.EXE`);
  assert.deepEqual(h.errors, Array(5).fill('INVALID_EXECUTABLE'));
  assert.equal(h.sockets.length, 1); assert.equal(h.sockets[0].sent[0].uuid, 'pi-id');
  assert.equal(text.context, 'key-context'); assert.equal(text.inspectorId, 'test-inspector');
  assert.equal(h.sockets[0].sent.some(message => message.event === 'setSettings'), false);
});
for (const info of ['{}', '{bad json', JSON.stringify({ application: { platform: 'mac' } }), JSON.stringify({ application: { platform: 'win32' } })]) {
  test('reconnecting from Windows to missing, malformed or non-Windows registration resets path authority', () => {
    // Arrange
    const h = harness(); h.ready({ executable: 'C:/old', argsText: '' }, JSON.stringify({ application: { platform: 'windows' } }));
    const oldSocket = h.sockets[0]; h.fields.executable.value = 'D:/pending'; const oldReply = h.last();
    // Act
    h.ready(initial, info); const count = h.normal().length;
    h.fields.executable.value = 'C:/must-reject';
    h.reply({ ...oldReply, type: 'canvas:reply', status: 'saved', settings: { executable: 'C:/stale', argsText: '' } }, oldSocket);
    h.fields.executable.value = '/synthetic/new';
    // Assert
    assert.equal(oldSocket.closed, true); assert.equal(h.bridge.getConnectionState().platform, 'posix');
    assert.equal(h.normal().length, count + 1); assert.deepEqual(h.last().changes, { executable: '/synthetic/new' });
    assert.equal(h.fields.executable.value, '/synthetic/new'); assert.deepEqual(h.errors, ['INVALID_EXECUTABLE']);
  });
}

// Real projection/controller/bridge; only DOM, transport and clock are doubles.
for (const [platform, executable, cwd, hint] of [
  ['windows', String.raw`C:\synthetic\report.EXE`, String.raw`D:\synthetic\work`, String.raw`C:\absolute\path\to\working-directory`],
  ['mac', '/synthetic/report', '/synthetic/work', '/absolute/path/to/working-directory'],
]) {
  test(`${platform} source inspector starts with an attribute-only cwd control and hydrates stored fields without writes`, () => {
    // Arrange
    const settings = { executable, argsText: '"two words" ""', cwd, runRequested: true };
    const original = structuredClone(settings);
    let h;
    // Act
    const startup = () => { h = harness(); h.ready(settings, JSON.stringify({ application: { platform } })); };
    // Assert: the former plain-string property assignment aborts this startup.
    assert.doesNotThrow(startup);
    assert.equal(h.fields.executable.value, executable); assert.equal(h.fields.argsText.value, settings.argsText); assert.equal(h.fields.cwd.value, cwd);
    assert.equal(h.fields.cwd.renderedHint, hint); assert.equal(h.sockets.length, 1); assert.deepEqual(h.errors, []);
    assert.equal(h.sockets[0].sent.some(message => message.event === 'setSettings' || message.payload?.type === 'canvas:edit'), false);
    assert.deepEqual(settings, original);
  });
}
test('cwd boundary rejects plain placeholder property text and paints attribute text only after an explicit update', () => {
  // Arrange
  const field = controls().cwd, original = field.renderedHint, hint = String.raw`C:\absolute\path\to\working-directory`;
  // Act
  let rejected; try { field.placeholder = hint; } catch (error) { rejected = error; }
  field.setAttribute('placeholder', hint); const beforeRender = field.renderedHint; field.requestUpdate();
  // Assert: keep the regression double strict without recreating SDPI/Lit internals.
  assert.ok(rejected instanceof TypeError); assert.equal(beforeRender, original); assert.equal(field.renderedHint, hint);
});
test('synchronous preconnection hydration projects legacy argv without edits or writes', () => {
  // Arrange
  const h = harness();
  const args = ['', 'two words', 'é😀', '$(literal); * | >'];
  const settings = { executable: '/program', args, cwd: '', runRequested: true };
  const original = structuredClone(settings);
  // Act
  h.bridge.hydrate(settings);
  // Assert
  assert.deepEqual(parseArguments(h.fields.argsText.value), args);
  assert.deepEqual(settings, original);
  assert.deepEqual(h.sockets, []);
  assert.deepEqual(h.statuses, []);
  assert.equal(h.timers.size, 0);
});

test('new empty arguments hydrate without writing an invented value', () => {
  // Arrange
  const h = harness();
  // Act
  h.bridge.hydrate({});
  // Assert
  assert.equal(h.fields.argsText.value, '');
  assert.deepEqual(h.statuses, []);
  assert.equal(h.timers.size, 0);
});

test('malformed legacy remains intact and gives a fixed diagnosis without guessed arguments', () => {
  // Arrange
  const h = harness();
  const settings = { executable: '/program', args: 'private-invalid-legacy' };
  const original = structuredClone(settings);
  // Act
  h.bridge.hydrate(settings);
  // Assert
  assert.deepEqual(settings, original);
  assert.equal(h.fields.argsText.value, undefined);
  assert.deepEqual(h.errors, ['ARGS_JSON_INVALID']);
  assert.equal(h.fields.status.textContent, 'Replace the invalid legacy arguments.');
  assert.deepEqual(h.sockets, []);
});

test('one socket registers and claims ownership without hydration edits', () => {
  // Arrange
  const h = harness();
  // Act
  h.ready();
  // Assert
  assert.equal(h.sockets.length, 1);
  assert.equal(h.sockets[0].url, 'ws://127.0.0.1:12345');
  assert.deepEqual(h.sockets[0].sent[0], { event: 'registerPropertyInspector', uuid: 'pi-id' });
  assert.deepEqual(h.normal().slice(1).map(message => message.payload.type), ['canvas:hello', 'canvas:claim']);
  assert.deepEqual(traceMessages(h.sockets[0]), []);
  assert.equal(h.sockets[0].sent.some(message => message.event === 'setSettings'), false);
  assert.equal(h.fields.status.textContent, '');
  assert.deepEqual(h.errors, []);
});

test('ordinary text edits coalesce into narrow latest-value autosave', () => {
  // Arrange
  const h = harness(); h.ready();
  const before = h.normal().length;
  // Act
  h.fields.argsText.value = 'first';
  h.fields.argsText.value = '"daily report" ""';
  h.fields.cwd.value = '/work';
  const beforeTick = h.normal().length;
  h.tick(200);
  // Assert
  assert.equal(beforeTick, before);
  assert.equal(h.normal().length, before + 1);
  assert.equal(h.last().type, 'canvas:edit');
  assert.deepEqual(h.last().changes, { argsText: '"daily report" ""', cwd: '/work' });
  assert.equal(h.fields.status.textContent, 'Saving…');
  assert.equal(h.statuses.at(-1), 'saving');
});

test('absolute picker sends immediately while invalid selections retain previous path', () => {
  // Arrange
  const h = harness(); h.ready();
  // Act
  h.fields.executable.value = '/selected folder/program';
  const selectedRequest = h.last();
  const count = h.normal().length;
  for (const invalid of ['program', 'relative/program', '~/program', '', 'private\0']) h.fields.executable.value = invalid;
  // Assert
  assert.deepEqual(selectedRequest.changes, { executable: '/selected folder/program' });
  assert.equal(h.normal().length, count);
  assert.equal(h.fields.executable.value, '/selected folder/program');
  assert.deepEqual(h.errors, Array(5).fill('INVALID_EXECUTABLE'));
  assert.equal(h.fields.status.textContent, 'Choose an absolute executable path.');
});

test('late acknowledgment cannot overwrite newer pending typing or claim it saved', () => {
  // Arrange
  const h = harness(); h.ready();
  h.fields.argsText.value = 'first'; h.tick(200);
  const old = h.last();
  // Act
  h.fields.argsText.value = 'second still typing';
  h.reply({ ...old, type: 'canvas:reply', status: 'saved', settings: { ...initial, argsText: 'first' } });
  const next = h.last();
  const statusBeforeNextAck = h.statuses.at(-1);
  const textBeforeNextAck = h.fields.argsText.value;
  h.reply({ ...next, type: 'canvas:reply', status: 'saved', settings: { ...initial, argsText: 'second still typing' } });
  // Assert
  assert.equal(textBeforeNextAck, 'second still typing');
  assert.equal(statusBeforeNextAck, 'saving');
  assert.deepEqual(next.changes, { argsText: 'second still typing' });
  assert.equal(h.fields.argsText.value, 'second still typing');
  assert.equal(h.statuses.at(-1), 'saved');
});

for (const foreign of ['context', 'inspectorId', 'requestId']) {
  test(`foreign ${foreign} acknowledgment cannot alter current controls/status`, () => {
    // Arrange
    const h = harness(); h.ready();
    h.fields.argsText.value = 'local typing'; h.tick(200);
    const request = h.last();
    const payload = { ...request, type: 'canvas:reply', status: 'saved', settings: { ...initial, argsText: 'foreign' }, [foreign]: foreign === 'requestId' ? request.requestId + 1 : 'foreign-key' };
    // Act
    h.reply(payload);
    // Assert
    assert.equal(h.fields.argsText.value, 'local typing');
    assert.equal(h.statuses.at(-1), 'saving');
    assert.deepEqual(h.errors, []);
  });
}

test('older request reply cannot replace acknowledged newest edit', () => {
  // Arrange
  const h = harness(); h.ready();
  h.fields.argsText.value = 'first'; h.bridge.flush(); const old = h.last();
  h.fields.argsText.value = 'second'; h.bridge.flush(); const latest = h.last();
  // Act
  h.reply({ ...latest, type: 'canvas:reply', status: 'saved', settings: { ...initial, argsText: 'second' } });
  h.reply({ ...old, type: 'canvas:reply', status: 'saved', settings: { ...initial, argsText: 'first' } });
  // Assert
  assert.equal(h.fields.argsText.value, 'second');
  assert.equal(h.statuses.at(-1), 'saved');
  assert.deepEqual(h.errors, []);
});

test('reply timeout reports unconfirmed settings and late saved reply is ignored', () => {
  // Arrange
  const h = harness(); h.ready();
  h.fields.argsText.value = 'local'; h.bridge.flush();
  const request = h.last();
  // Act
  h.tick(15_000);
  h.reply({ ...request, type: 'canvas:reply', status: 'saved', settings: { ...initial, argsText: 'late' } });
  // Assert
  assert.deepEqual(h.errors, ['STATE_SAVE_FAILED']);
  assert.equal(h.statuses.at(-1), 'error');
  assert.equal(h.fields.status.textContent, 'Settings could not be confirmed.');
  assert.equal(h.fields.argsText.value, 'local');
});

test('send failure is redacted and never displayed as saved', () => {
  // Arrange
  const h = harness(); h.ready();
  h.sockets[0].send = () => { throw new Error('private transport details'); };
  // Act
  h.fields.argsText.value = 'private argv'; h.bridge.flush();
  // Assert
  assert.deepEqual(h.errors, ['STATE_SAVE_FAILED']);
  assert.equal(h.statuses.at(-1), 'error');
  assert.equal(h.fields.status.textContent.includes('private'), false);
});

test('untrusted error replies expose only allowlisted inspector diagnosis', () => {
  // Arrange
  const h = harness(); h.ready();
  h.fields.argsText.value = 'local'; h.bridge.flush();
  // Act
  h.reply({ ...h.last(), type: 'canvas:reply', status: 'error', diagnosticCode: '<script>private-stderr</script>' });
  // Assert
  assert.deepEqual(h.errors, ['STATE_SAVE_FAILED']);
  assert.equal(h.fields.status.textContent, 'Settings could not be confirmed.');
});

test('reconnection changes inspector session and ignores old socket callbacks', () => {
  // Arrange
  const h = harness(); h.ready();
  const oldSocket = h.sockets[0], old = h.last();
  // Act
  h.connect({ ...initial, argsText: 'new context' }, 'new-context');
  const current = h.last();
  h.reply({ ...old, type: 'canvas:reply', status: 'saved', settings: { ...initial, argsText: 'old context' } }, oldSocket);
  oldSocket.onerror();
  // Assert
  assert.equal(oldSocket.closed, true);
  assert.notEqual(current.inspectorId, old.inspectorId);
  assert.equal(h.fields.argsText.value, 'new context');
  assert.deepEqual(h.errors, []);
});

test('disconnect and controller disposal prevent queued and subsequent edits', () => {
  // Arrange
  const h = harness(); h.ready();
  h.fields.argsText.value = 'pending';
  const count = h.normal().length;
  // Act
  h.controller.dispose(); h.bridge.disconnect();
  h.fields.argsText.value = 'after disposal'; h.tick(200);
  // Assert
  assert.equal(h.normal().length, count);
  assert.equal(h.sockets[0].closed, true);
  assert.equal(h.timers.size, 0);
});

test('inspector markup has local scripts, executable picker and optional cwd text, without autosave bindings or Apply', () => {
  // Arrange
  const html = readFileSync(new URL('../git.renaudcerrato.deckforge.sdPlugin/ui/run.html', import.meta.url), 'utf8');
  // Act
  const scripts = [...html.matchAll(/<script\b[^>]*src="([^"]+)"/g)].map(match => match[1]);
  const paragraphs = [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map(match => match[1].trim());
  // Assert: structural UI contract, not internal source algorithms.
  assert.deepEqual(scripts, ['sdpi-components.js', 'run.js']);
  assert.match(html, /<sdpi-file\b[^>]*id="executable"/);
  assert.match(html, /<sdpi-textfield\b[^>]*id="cwd"/);
  assert.match(html, /<sdpi-textfield\b[^>]*id="argsText"/);
  assert.equal(/\bsetting\s*=/.test(html), false);
  assert.equal(/<button|<sdpi-button|\bApply\b/.test(html), false);
  assert.equal(/id="(?:env|environment)"/.test(html), false);
  assert.deepEqual(paragraphs, ['']);
});

test('built browser entry replaces vendor connection wrapper and opens only one mocked socket', () => {
  // Arrange
  const script = readFileSync(new URL('../git.renaudcerrato.deckforge.sdPlugin/ui/run.js', import.meta.url), 'utf8');
  const fixture = createInspectorFixture(), fields = fixture.fields, sockets = [], timers = new Map(), events = new Map();
  let chained = 0, timerId = 0;
  const window = { connectElgatoStreamDeckSocket() { chained++; }, addEventListener(type, callback) { events.set(type, callback); } };
  const document = { readyState: 'complete', addEventListener() {}, getElementById: fixture.getElementById };
  class Socket {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(text) { this.sent.push(JSON.parse(text)); }
    close() { this.closed = true; }
  }
  // Act: vendor, actual sockets, SDK, host and profiles are deliberately absent.
  const context = { window, document, WebSocket: Socket, TextEncoder, setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; }, clearTimeout(id) { timers.delete(id); } };
  const html = readFileSync(new URL('../git.renaudcerrato.deckforge.sdPlugin/ui/run.html', import.meta.url), 'utf8');
  // The approved UI has no inline diagnostics bootstrap; run only its built entry.
  assert.equal(/<script>/.test(html), false);
  runInNewContext(script, context, { timeout: 1_000 });
  window.connectElgatoStreamDeckSocket('12345', 'pi-id', 'registerPropertyInspector', '{}', JSON.stringify({ context: 'key', action: 'git.renaudcerrato.deckforge.stream', payload: { settings: initial } }));
  sockets[0].readyState = 1; sockets[0].onopen();
  events.get('unload')();
  // Assert
  assert.equal(chained, 0);
  assert.equal(sockets.length, 1);
  assert.deepEqual(normalMessages(sockets[0]).map(message => message.event), ['registerPropertyInspector', 'sendToPlugin']);
  assert.deepEqual(traceMessages(sockets[0]), []);
  assert.equal(sockets[0].sent[1].payload.type, 'canvas:hello');
  assert.equal(fields.argsText.value, 'old');
  assert.equal(sockets[0].closed, true);
  assert.equal(timers.size, 0);
});

const newlineArgv = ['LF\nvalue', 'CR\rvalue', 'CRLF\r\nvalue', "quote'\\\nUnicodeé😀", '\\n', '\\r', ''];
for (const [label, argumentSettings] of [
  ['array', { args: newlineArgv }],
  ['JSON', { args: JSON.stringify(newlineArgv) }],
  ['raw multiline text', { argsText: "'LF\nvalue' 'CR\rvalue' 'CRLF\r\nvalue' \"quote'\\\\\nUnicodeé😀\" '\\n' '\\r' ''", args: ['retained legacy'] }],
]) {
  test(`${label} newline arguments survive native render and ordinary editing/autosave`, () => {
    // Arrange
    const h = harness();
    const settings = { executable: '/program', cwd: '', runRequested: true, ...argumentSettings };
    const original = structuredClone(settings);
    const projected = getInspectorConfiguration(settings).argsText;
    // Act
    h.ready(settings);
    const rendered = h.fields.argsText.value;
    const editsBefore = h.sockets[0].sent.filter(message => message.payload?.type === 'canvas:edit');
    h.fields.argsText.userEdit(`${rendered} --append\r\n`);
    h.tick(200);
    const edit = h.last();
    // Assert
    assert.equal(/[\r\n]/.test(projected), false);
    assert.equal(rendered, projected);
    assert.deepEqual(parseArguments(rendered), newlineArgv);
    assert.deepEqual(editsBefore, []);
    assert.equal(h.fields.argsText.value, `${rendered} --append`);
    assert.deepEqual(parseArguments(edit.changes.argsText), [...newlineArgv, '--append']);
    assert.deepEqual(settings, original);
  });
}

test('native input strips actual CR/LF on render and edit, making raw projection unsafe', () => {
  // Arrange
  const native = controls().argsText;
  // Act
  native.value = 'a\r\nb\rc\nd';
  const rendered = native.value;
  native.userEdit('next\nvalue\r');
  // Assert
  assert.equal(rendered, 'abcd');
  assert.equal(native.value, 'nextvalue');
});

test('invalid multiline stored text is diagnosed without hydration edits or guessed valid text', () => {
  // Arrange
  const h = harness();
  const settings = { executable: '/program', argsText: "'private\nunterminated", args: ['preserved'] };
  const original = structuredClone(settings);
  // Act
  h.bridge.hydrate(settings);
  // Assert
  assert.equal(h.fields.argsText.value, undefined);
  assert.deepEqual(h.errors, ['ARGS_TEXT_INVALID']);
  assert.deepEqual(h.sockets, []);
  assert.deepEqual(settings, original);
});

// These are authorized synthetic strings only: neither executable is accessed or run.
const newSelection = '/synthetic/new-program.py';
const oldSelection = '/synthetic/old-program.py';
const oldSnapshot = { executable: oldSelection, argsText: '', cwd: '', runRequested: false };

test('picker edit before first SDK callback survives old initial/challenge/claim hydration and saves once', () => {
  // Arrange
  const h = harness();
  const original = structuredClone(oldSnapshot);
  // Act
  h.fields.executable.userEdit(newSelection);
  const beforeConnect = h.fields.executable.value;
  h.connect(oldSnapshot);
  const afterInitial = h.fields.executable.value;
  const hello = h.last();
  h.reply({ ...hello, type: 'canvas:reply', status: 'challenge', token: 'opaque-token', settings: oldSnapshot });
  const afterChallenge = h.fields.executable.value;
  const claim = h.last();
  const editsBeforeReady = h.normal().filter(message => message.payload?.type === 'canvas:edit');
  h.reply({ ...claim, type: 'canvas:reply', status: 'saved', settings: oldSnapshot });
  const afterClaim = h.fields.executable.value;
  const edit = h.last();
  const canonicalHostSettings = { ...oldSnapshot, ...edit.changes };
  h.reply({ ...edit, type: 'canvas:reply', status: 'saved', settings: canonicalHostSettings });
  h.bridge.flush(); h.bridge.flush();
  const launchInput = validateSettings(canonicalHostSettings);
  // Assert: matching fake host readback proves configuration only, not launch/durability.
  assert.deepEqual([beforeConnect, afterInitial, afterChallenge, afterClaim, h.fields.executable.value], Array(5).fill(newSelection));
  assert.deepEqual(editsBeforeReady, []);
  assert.deepEqual(edit.changes, { executable: newSelection });
  assert.deepEqual(h.normal().slice(1).map(message => [message.payload.type, message.payload.requestId]), [['canvas:hello', 1], ['canvas:claim', 2], ['canvas:edit', 3]]);
  assert.equal(launchInput.executable, newSelection);
  assert.equal(h.statuses.at(-1), 'saved');
  assert.deepEqual(oldSnapshot, original);
  assert.deepEqual(traceMessages(h.sockets[0]), []);
  assert.equal(h.sockets.length, 1);
});

test('invalid initial JSON, port and identity do not discard preconnection accepted picker edit', () => {
  // Arrange
  const h = harness();
  h.fields.executable.userEdit(newSelection);
  const validInfo = JSON.stringify({ context: 'key-context', action: 'git.renaudcerrato.deckforge.stream', payload: { settings: oldSnapshot } });
  // Act
  h.bridge.connect('12345', 'pi-id', 'registerPropertyInspector', '{}', '{invalid');
  h.bridge.connect('0', 'pi-id', 'registerPropertyInspector', '{}', validInfo);
  h.bridge.connect('12345', 'pi-id', 'registerPropertyInspector', '{}', JSON.stringify({ payload: { settings: oldSnapshot } }));
  const beforeValid = h.fields.executable.value;
  const socketsBeforeValid = h.sockets.length;
  h.ready(oldSnapshot);
  const edit = h.last();
  // Assert
  assert.equal(beforeValid, newSelection);
  assert.equal(socketsBeforeValid, 0);
  assert.equal(h.fields.executable.value, newSelection);
  assert.deepEqual(edit.changes, { executable: newSelection });
  assert.equal(h.normal().filter(message => message.payload?.type === 'canvas:edit').length, 1);
  assert.equal(h.errors.length, 3);
  assert.deepEqual(traceMessages(h.sockets[0]), []);
});

test('valid binding then different-key reconnect drops pending old selection and acknowledgments without diagnostic traffic', () => {
  // Arrange
  const h = harness();
  h.connect(oldSnapshot, 'old-key');
  h.fields.executable.userEdit(newSelection);
  const oldSocket = h.sockets[0], oldRequest = h.last();
  const oldBinding = h.bridge.getConnectionState();
  const nextSettings = { ...initial, executable: '/new-key/program' };
  // Act
  h.connect(nextSettings, 'new-key');
  h.reply({ ...oldRequest, type: 'canvas:reply', status: 'saved', settings: { ...oldSnapshot, executable: newSelection } }, oldSocket);
  h.reply({ ...h.last(), type: 'canvas:reply', status: 'challenge', token: 'new-token', settings: nextSettings });
  h.reply({ ...h.last(), type: 'canvas:reply', status: 'saved', settings: nextSettings });
  h.bridge.flush(); h.bridge.flush();
  const newSocket = h.sockets[1];
  const newBinding = h.bridge.getConnectionState();
  h.connect(nextSettings, 'new-key');
  h.reply({ ...h.last(), type: 'canvas:reply', status: 'challenge', token: 'third-token', settings: nextSettings });
  h.reply({ ...h.last(), type: 'canvas:reply', status: 'saved', settings: nextSettings });
  // Assert
  assert.equal(oldSocket.closed, true);
  assert.equal(h.fields.executable.value, nextSettings.executable);
  assert.equal(h.sockets.slice(1).some(socket => normalMessages(socket).some(message => message.payload?.type === 'canvas:edit')), false);
  assert.equal(newBinding.context, 'new-key');
  assert.notEqual(newBinding.inspectorId, oldBinding.inspectorId);
  assert.notEqual(newBinding.version, oldBinding.version);
  assert.ok(newSocket.sent.filter(message => message.event === 'sendToPlugin').every(message => message.payload.context === 'new-key'));
  assert.ok(h.sockets.every(socket => traceMessages(socket).length === 0));
  assert.equal(JSON.stringify(h.sockets.slice(1).map(socket => socket.sent)).includes(newSelection), false);
  assert.deepEqual(h.errors, []);
});

test('valid identity with failed initial hydration still binds and cannot carry edits to a later key', () => {
  // Arrange
  const h = harness();
  h.fields.executable.userEdit(newSelection);
  // Act
  h.bridge.connect('12345', 'pi-id', 'registerPropertyInspector', '{}', JSON.stringify({ context: 'first-key', action: 'git.renaudcerrato.deckforge.stream', payload: { settings: [] } }));
  const socketsAfterFailure = h.sockets.length;
  const failedBinding = h.bridge.getConnectionState();
  h.connect({ ...initial, executable: '/later-key/program' }, 'later-key');
  h.reply({ ...h.last(), type: 'canvas:reply', status: 'challenge', token: 'token', settings: { ...initial, executable: '/later-key/program' } });
  h.reply({ ...h.last(), type: 'canvas:reply', status: 'saved', settings: { ...initial, executable: '/later-key/program' } });
  // Assert
  assert.equal(socketsAfterFailure, 0);
  assert.equal(h.fields.executable.value, '/later-key/program');
  assert.equal(h.normal().some(message => message.payload?.type === 'canvas:edit'), false);
  const newBinding = h.bridge.getConnectionState();
  assert.equal(newBinding.context, 'later-key');
  assert.notEqual(newBinding.inspectorId, failedBinding.inspectorId);
  assert.notEqual(newBinding.version, failedBinding.version);
  assert.ok(h.sockets[0].sent.filter(message => message.event === 'sendToPlugin').every(message => message.payload.context === 'later-key'));
  assert.deepEqual(traceMessages(h.sockets[0]), []);
  assert.equal(JSON.stringify(h.sockets[0].sent).includes(newSelection), false);
});

test('preclaim local observations do not send diagnostics, advance request IDs or write settings', () => {
  // Arrange
  const h = harness();
  // Act
  h.connect(initial);
  const hello = h.last();
  const timerKeysBefore = [...h.timers.keys()];
  for (let index = 0; index < 5; index++) h.bridge.getConnectionState();
  const beforeClaim = h.last();
  const timerKeysAfter = [...h.timers.keys()];
  const sentBeforeClaim = traceMessages(h.sockets[0]);
  h.reply({ ...hello, type: 'canvas:reply', status: 'challenge', token: 'secret-token', settings: initial });
  const claim = h.last();
  h.reply({ ...claim, type: 'canvas:reply', status: 'saved', settings: initial });
  // Assert
  assert.deepEqual(beforeClaim, hello);
  assert.deepEqual(timerKeysAfter, timerKeysBefore);
  assert.equal(hello.requestId, 1);
  assert.equal(claim.requestId, 2);
  assert.deepEqual(sentBeforeClaim, []);
  assert.deepEqual(h.normal().slice(1).map(message => message.payload.type), ['canvas:hello', 'canvas:claim']);
  assert.equal(h.sockets[0].sent.some(message => message.event === 'setSettings'), false);
  assert.equal(JSON.stringify(traceMessages(h.sockets[0])).includes('secret-token'), false);
});

test('repeated preconnection hydration does not buffer diagnostic traffic or invent edits', () => {
  // Arrange
  const h = harness();
  // Act
  for (let index = 0; index < 80; index++) h.bridge.hydrate({ ...initial, executable: `/queued/${index}` });
  h.connect(initial);
  h.reply({ ...h.last(), type: 'canvas:reply', status: 'challenge', token: 'token', settings: initial });
  h.reply({ ...h.last(), type: 'canvas:reply', status: 'saved', settings: initial });
  // Assert
  assert.deepEqual(traceMessages(h.sockets[0]), []);
  assert.equal(JSON.stringify(h.sockets[0].sent).includes('/queued/'), false);
  assert.equal(h.fields.executable.value, initial.executable);
  assert.equal(h.normal().some(message => message.payload?.type === 'canvas:edit'), false);
  assert.deepEqual(h.errors, []);
});

test('throwing local connection observer cannot reject picker selection or change save correlation', () => {
  // Arrange
  const h = harness({ onConnectionState() { throw new Error('observer failure'); } });
  // Act
  h.fields.executable.userEdit(newSelection);
  h.ready(oldSnapshot);
  const edit = h.last();
  h.reply({ ...edit, type: 'canvas:reply', status: 'saved', settings: { ...oldSnapshot, executable: newSelection } });
  // Assert
  assert.equal(edit.requestId, 3);
  assert.deepEqual(edit.changes, { executable: newSelection });
  assert.equal(h.fields.executable.value, newSelection);
  assert.equal(h.statuses.at(-1), 'saved');
  assert.deepEqual(h.errors, []);
});

test('transport rejecting diagnostic envelopes still permits correlated configuration saves without extra traffic', () => {
  // Arrange
  const h = harness(); h.connect(initial);
  const socket = h.sockets[0], originalSend = socket.send;
  const hello = h.last(), timerKeys = [...h.timers.keys()];
  socket.send = function(text) { if (JSON.parse(text).payload?.type === 'canvas:trace') throw new Error('trace-only failure'); originalSend.call(this, text); };
  // Act
  h.bridge.getConnectionState();
  const requestAfterFailure = h.last(), timersAfterFailure = [...h.timers.keys()];
  h.reply({ ...hello, type: 'canvas:reply', status: 'challenge', token: 'token', settings: initial });
  h.reply({ ...h.last(), type: 'canvas:reply', status: 'saved', settings: initial });
  h.fields.executable.userEdit(newSelection);
  const edit = h.last();
  h.reply({ ...edit, type: 'canvas:reply', status: 'saved', settings: { ...initial, executable: newSelection } });
  // Assert
  assert.deepEqual(requestAfterFailure, hello);
  assert.deepEqual(timersAfterFailure, timerKeys);
  assert.equal(edit.requestId, 3);
  assert.deepEqual(edit.changes, { executable: newSelection });
  assert.equal(h.statuses.at(-1), 'saved');
  assert.deepEqual(h.errors, []);
  assert.equal(h.normal().filter(message => message.payload?.type === 'canvas:edit').length, 1);
  assert.deepEqual(traceMessages(socket), []);
});

test('configuration envelopes route by PI registration UUID while payload and reply guards use action context', () => {
  // Arrange
  const h = harness(); h.ready();
  // Act
  h.fields.executable.userEdit(newSelection);
  const edit = h.last();
  h.reply({ ...edit, type: 'canvas:reply', context: 'pi-id', status: 'saved', settings: { ...initial, executable: '/wrong-reply/program' } });
  const statusAfterWrongContext = h.statuses.at(-1);
  h.reply({ ...edit, type: 'canvas:reply', status: 'saved', settings: { ...initial, executable: newSelection } });
  // Assert
  const envelopes = h.sockets[0].sent.filter(message => message.event === 'sendToPlugin');
  assert.ok(envelopes.length > 0);
  assert.ok(envelopes.every(message => message.context === 'pi-id' && message.payload.context === 'key-context' && message.action === 'git.renaudcerrato.deckforge.stream'));
  assert.equal(envelopes.some(message => message.payload.type === 'canvas:trace'), false);
  assert.equal(statusAfterWrongContext, 'saving');
  assert.equal(h.fields.executable.value, newSelection);
  assert.equal(h.statuses.at(-1), 'saved');
});

test('local connection observations retain controller identity without sending diagnostic socket traffic', () => {
  // Arrange
  const h = harness();
  const before = h.bridge.getConnectionState();
  // Act
  h.connect(initial);
  const helloState = h.bridge.getConnectionState();
  h.reply({ ...h.last(), type: 'canvas:reply', status: 'challenge', token: 'secret-token', settings: initial });
  const claimState = h.bridge.getConnectionState();
  h.reply({ ...h.last(), type: 'canvas:reply', status: 'saved', settings: initial });
  const readyState = h.bridge.getConnectionState();
  // Assert
  assert.equal(before.bindingValid, false);
  assert.equal(helloState.bindingValid, true);
  assert.equal(helloState.actionUuid, 'git.renaudcerrato.deckforge.stream');
  assert.equal(helloState.context, 'key-context');
  assert.equal(helloState.platform, 'posix');
  assert.equal(claimState.inspectorId, helloState.inspectorId);
  assert.equal(readyState.version, helloState.version);
  assert.equal(h.statuses.at(-1), 'saved');
  assert.equal(JSON.stringify(readyState).includes('secret-token'), false);
  assert.ok(h.connections.some(state => state.bindingValid && state.context === 'key-context'));
  assert.deepEqual(h.sockets[0].sent.slice(1).map(message => message.payload.type), ['canvas:hello', 'canvas:claim']);
  assert.deepEqual(traceMessages(h.sockets[0]), []);
});

test('invalid callback preserves a fixed error without exposing raw metadata or sending traffic', () => {
  // Arrange
  const h = harness();
  // Act
  h.bridge.connect('12345', 'pi-id', 'registerPropertyInspector', 'forbidden-info-body', '{forbidden-action-body');
  const invalid = h.bridge.getConnectionState();
  // Assert
  assert.equal(invalid.bindingValid, false);
  assert.deepEqual(h.sockets, []);
  assert.deepEqual(h.errors, ['STATE_SAVE_FAILED']);
  assert.equal(JSON.stringify(invalid).includes('forbidden'), false);
  assert.equal(JSON.stringify(h.connections).includes('forbidden'), false);
});

test('connection snapshots are detached and observation cannot write settings or corrupt correlation', () => {
  // Arrange
  const h = harness(); h.connect(initial);
  const hello = h.last();
  // Act
  const snapshot = h.bridge.getConnectionState();
  snapshot.context = 'foreign'; snapshot.bindingValid = false; snapshot.inspectorId = 'mutated'; snapshot.platform = 'win32';
  h.tick(15_000);
  const timeout = h.bridge.getConnectionState();
  timeout.actionUuid = 'mutated';
  const current = h.bridge.getConnectionState();
  // Assert
  assert.equal(current.context, 'key-context');
  assert.equal(current.bindingValid, true);
  assert.equal(current.inspectorId, hello.inspectorId);
  assert.equal(current.platform, 'posix');
  assert.equal(current.actionUuid, 'git.renaudcerrato.deckforge.stream');
  assert.deepEqual(h.errors, ['STATE_SAVE_FAILED']);
  assert.deepEqual(h.normal().slice(1).map(message => message.payload.type), ['canvas:hello']);
  assert.deepEqual(traceMessages(h.sockets[0]), []);
});

test('transport error reports a fixed failure and pending typing cannot leak into local observations or socket traffic', () => {
  // Arrange
  const h = harness(); h.ready();
  const before = h.sockets[0].sent.length;
  // Act
  h.sockets[0].onerror({ type: 'error', message: 'forbidden-private-error' });
  h.fields.argsText.userEdit('forbidden-argument-text');
  const errorState = h.bridge.getConnectionState();
  // Assert
  assert.equal(h.fields.status.textContent, 'Saving…');
  assert.deepEqual(h.errors, ['STATE_SAVE_FAILED']);
  assert.equal(JSON.stringify(h.connections).includes('forbidden'), false);
  assert.equal(JSON.stringify(errorState).includes('forbidden'), false);
  assert.equal(h.sockets[0].sent.length, before);
  assert.deepEqual(traceMessages(h.sockets[0]), []);
});

test('socket close never publishes event reason, raw exception or diagnostic traffic', () => {
  // Arrange
  const h = harness(); h.ready();
  // Act
  h.sockets[0].readyState = 3;
  h.sockets[0].onclose({ type: 'close', code: 1006, wasClean: false, reason: 'forbidden-close-body', error: new Error('forbidden-stack') });
  const state = h.bridge.getConnectionState();
  // Assert
  assert.deepEqual(h.errors, ['STATE_SAVE_FAILED']);
  assert.equal(h.fields.status.textContent, 'Settings could not be confirmed.');
  assert.equal(JSON.stringify(state).includes('forbidden'), false);
  assert.equal(JSON.stringify(h.connections).includes('forbidden'), false);
  assert.deepEqual(traceMessages(h.sockets[0]), []);
});

test('socket construction failure gives a fixed diagnosis without exposing details or saving', () => {
  // Arrange
  const h = harness({ createSocket() { throw new Error('forbidden-construction-stack'); } });
  // Act
  h.bridge.connect('12345', 'pi-id', 'registerPropertyInspector', '{}', JSON.stringify({ context: 'key', action: 'git.renaudcerrato.deckforge.stream', payload: { settings: initial } }));
  const state = h.bridge.getConnectionState();
  // Assert
  assert.equal(state.bindingValid, true);
  assert.deepEqual(h.errors, ['STATE_SAVE_FAILED']);
  assert.equal(JSON.stringify(h.connections).includes('forbidden'), false);
  assert.deepEqual(h.sockets, []);
});

test('throwing connection observer cannot alter first picker retention, transport or save', () => {
  // Arrange
  const h = harness({ onConnectionState() { throw new Error('observation-only'); } });
  // Act
  h.fields.executable.userEdit(newSelection); h.ready(oldSnapshot);
  const edit = h.last();
  h.reply({ ...edit, type: 'canvas:reply', status: 'saved', settings: { ...oldSnapshot, executable: newSelection } });
  // Assert
  assert.equal(edit.requestId, 3);
  assert.deepEqual(edit.changes, { executable: newSelection });
  assert.equal(h.fields.executable.value, newSelection);
  assert.equal(h.statuses.at(-1), 'saved');
  assert.deepEqual(h.errors, []);
});

test('removed Diagnostics panel/bootstrap leave accessible save status after the theme control', () => {
  // Arrange
  const html = readFileSync(new URL('../git.renaudcerrato.deckforge.sdPlugin/ui/run.html', import.meta.url), 'utf8');
  // Act
  const disclosure = html.match(/<details\b([^>]*)>([\s\S]*?)<\/details>/);
  const styles = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  // Assert: native disclosure semantics and authored colors, not hardware/browser rendering claims.
  assert.equal(disclosure, null);
  assert.equal(/id="connection-status"|<script>/.test(html), false);
  assert.match(html, /<p id="settings-status" role="status" aria-live="polite"><\/p>/);
  assert.ok(html.indexOf('id="settings-status"') > html.indexOf('id="themeColor"'));
  assert.match(styles, /#settings-status\s*\{[^}]*color:\s*#969696\s*;/);
  assert.equal(/sdpi[^{}]*\{[^}]*background/.test(styles), false);
});

test('native theme input hydrates fallback without edits and coalesces deduplicated input/change events', () => {
  // Arrange
  const h = harness(); h.ready({ ...initial, themeColor: 'malformed stored' });
  const before = h.normal().length;
  // Act
  const hydrated = h.fields.themeColor.value;
  h.fields.themeColor.userEdit('#ABCDEF');
  h.fields.themeColor.dispatch('change');
  h.fields.themeColor.userEdit('#123456');
  const beforeTimer = h.normal().length;
  h.tick(200); const request = h.last();
  h.reply({ ...request, type: 'canvas:reply', status: 'saved', settings: { ...initial, themeColor: '#123456' } });
  h.fields.themeColor.dispatch('input'); h.fields.themeColor.dispatch('change'); h.tick(200);
  // Assert
  assert.equal(hydrated, '#969696');
  assert.equal(beforeTimer, before);
  assert.deepEqual(request.changes, { themeColor: '#123456' });
  assert.equal(h.normal().filter(message => message.payload?.type === 'canvas:edit').length, 1);
  assert.equal(h.fields.themeColor.value, '#123456');
  assert.deepEqual(h.errors, []);
});
test('precallback color remains protected through first challenge/claim and emits one narrow edit', () => {
  // Arrange
  const h = harness();
  // Act
  h.fields.themeColor.userEdit('#ABCDEF'); h.tick(200);
  h.ready(initial);
  const edit = h.last();
  const saved = { ...initial, themeColor: '#abcdef' };
  h.reply({ ...edit, type: 'canvas:reply', status: 'saved', settings: saved });
  // Assert
  assert.deepEqual(edit.changes, { themeColor: '#abcdef' });
  assert.equal(h.fields.themeColor.value, '#abcdef');
  assert.equal(h.normal().filter(message => message.payload?.type === 'canvas:edit').length, 1);
  assert.equal(h.sockets.length, 1);
});
test('late color acknowledgment cannot overwrite newer native selection or falsely claim it saved', () => {
  // Arrange
  const h = harness(); h.ready();
  h.fields.themeColor.userEdit('#abcdef'); h.tick(200); const old = h.last();
  // Act
  h.fields.themeColor.userEdit('#123456');
  h.reply({ ...old, type: 'canvas:reply', status: 'saved', settings: { ...initial, themeColor: '#abcdef' } });
  const current = h.last(), beforeAck = h.fields.themeColor.value, statusBefore = h.statuses.at(-1);
  h.reply({ ...current, type: 'canvas:reply', status: 'saved', settings: { ...initial, themeColor: '#123456' } });
  h.reply({ ...old, type: 'canvas:reply', status: 'saved', settings: { ...initial, themeColor: '#abcdef' } });
  // Assert
  assert.equal(beforeAck, '#123456');
  assert.equal(statusBefore, 'saving');
  assert.deepEqual(current.changes, { themeColor: '#123456' });
  assert.equal(h.fields.themeColor.value, '#123456');
  assert.equal(h.statuses.at(-1), 'saved');
});
test('different-key connection drops pending native color and independent inspector edits remain isolated', () => {
  // Arrange
  const first = harness(), second = harness(); first.ready(); second.ready();
  first.fields.themeColor.userEdit('#abcdef'); const oldSocket = first.sockets[0], oldRequest = first.last();
  // Act
  first.connect({ ...initial, themeColor: '#123456' }, 'other-key');
  first.reply({ ...first.last(), type: 'canvas:reply', status: 'challenge', token: 'token', settings: { ...initial, themeColor: '#123456' } });
  first.reply({ ...first.last(), type: 'canvas:reply', status: 'saved', settings: { ...initial, themeColor: '#123456' } });
  first.reply({ ...oldRequest, type: 'canvas:reply', status: 'saved', settings: { ...initial, themeColor: '#abcdef' } }, oldSocket);
  first.tick(200); second.fields.themeColor.userEdit('#fedcba'); second.tick(200);
  // Assert
  assert.equal(first.fields.themeColor.value, '#123456');
  assert.equal(first.normal().some(message => message.payload?.type === 'canvas:edit'), false);
  assert.deepEqual(second.last().changes, { themeColor: '#fedcba' });
  assert.equal(oldSocket.closed, true);
});
test('malformed native theme edit is fixed-diagnostic rejected without save or diagnostic traffic', () => {
  // Arrange
  const h = harness(); h.ready(); const before = h.normal().length;
  // Act
  h.fields.themeColor.userEdit('private-css-injection'); h.tick(200);
  // Assert
  assert.equal(h.normal().length, before);
  assert.ok(h.errors.length > 0 && h.errors.every(code => code === 'THEME_COLOR_INVALID'));
  assert.equal(h.fields.status.textContent, 'Choose a six-digit hex theme color.');
  assert.deepEqual(traceMessages(h.sockets[0]), []);
  assert.equal(JSON.stringify(h.sockets[0].sent).includes('private-css-injection'), false);
});

// Slice 2 isolation objective: Timer's optional control cannot become a Run setting.
for (const policy of ['refresh', 'stop']) {
  test(`Run rejects programmatic Timer press policy ${policy} while common autosave stays narrow`, () => {
    // Arrange
    const h = harness(); h.ready();
    // Act
    const accepted = h.bridge.edit({ actionOnPress: policy }, { immediate: true });
    h.fields.argsText.value = 'Run-local'; h.tick(200); const request = h.last();
    h.reply({ ...request, type: 'canvas:reply', status: 'saved', settings: { ...initial, argsText: 'Run-local' } });
    // Assert
    assert.equal(accepted, false); assert.deepEqual(h.errors, ['INVALID_SETTINGS']);
    assert.deepEqual(request.changes, { argsText: 'Run-local' }); assert.equal(h.fields.status.textContent, '');
    assert.equal(h.normal().filter(message => message.payload?.type === 'canvas:edit').length, 1);
    assert.equal(h.sockets[0].sent.some(message => message.event === 'setSettings'), false);
  });
}
test('foreign policy rejection keeps its fixed diagnosis without diagnostic traffic or settings dumps', () => {
  // Arrange
  const h = harness(); h.ready(); const before = h.sockets[0].sent.length;
  // Act
  const accepted = h.bridge.edit({ actionOnPress: 'PRIVATE_POLICY' }, { immediate: true });
  // Assert
  assert.equal(accepted, false); assert.deepEqual(h.errors, ['INVALID_SETTINGS']);
  assert.equal(h.sockets[0].sent.length, before); assert.deepEqual(traceMessages(h.sockets[0]), []);
  assert.equal(JSON.stringify(h.connections).includes('PRIVATE'), false);
});
test('theme picker is a native color input in SDPI item without independent autosave/socket bindings', () => {
  // Arrange
  const html = readFileSync(new URL('../git.renaudcerrato.deckforge.sdPlugin/ui/run.html', import.meta.url), 'utf8');
  // Act
  const item = html.match(/<sdpi-item label="Theme color">([\s\S]*?)<\/sdpi-item>/)[1];
  // Assert
  // Static user-authored color is not hydration's safe runtime fallback (#969696).
  assert.match(item, /<input id="themeColor" type="color" value="#606060"/);
  assert.equal(/\bsetting\s*=|<sdpi-color|Apply/.test(item), false);
});

for (const pending of ['debounced edit', 'sent edit', 'challenge']) {
  test(`move-integrity PI same-context reopen drops old ${pending} and edits only the moved snapshot`, () => {
    // Arrange: context stays the host slot while its complete settings change.
    const h = harness(), a = { ...initial, title: 'A', themeColor: '#123456' };
    const b = { ...initial, executable: '/moved/B.py', title: 'B', themeColor: '#654321' };
    if (pending === 'challenge') h.connect(a); else h.ready(a);
    if (pending !== 'challenge') { h.fields.title.userEdit('old typing'); if (pending === 'sent edit') h.tick(200); }
    const oldSocket = h.sockets[0], old = h.last();
    // Act
    h.connect(b, 'key-context');
    h.reply({ ...old, type: 'canvas:reply', status: pending === 'challenge' ? 'challenge' : 'saved', token: 'stale', settings: a }, oldSocket);
    h.reply({ ...h.last(), type: 'canvas:reply', status: 'challenge', token: 'new-token', settings: b });
    h.reply({ ...h.last(), type: 'canvas:reply', status: 'saved', settings: b });
    h.tick(200); const hydration = h.normal().filter(message => message.payload?.type === 'canvas:edit');
    const shown = { title: h.fields.title.value, executable: h.fields.executable.value, themeColor: h.fields.themeColor.value };
    h.fields.title.userEdit('B edited'); h.tick(200); const edit = h.last();
    h.reply({ ...edit, type: 'canvas:reply', status: 'saved', settings: { ...b, title: 'B edited' } });
    // Assert
    assert.deepEqual(shown, { title: 'B', executable: b.executable, themeColor: b.themeColor });
    assert.deepEqual(hydration, []); assert.equal(oldSocket.closed, true);
    assert.notEqual(edit.inspectorId, old.inspectorId); assert.equal(edit.context, old.context);
    assert.deepEqual(edit.changes, { title: 'B edited' }); assert.equal(h.fields.title.value, 'B edited');
    assert.equal(h.statuses.at(-1), 'saved'); assert.deepEqual(h.errors, []);
    assert.equal(h.sockets.flatMap(socket => socket.sent).some(message => message.event === 'setSettings'), false);
    h.controller.dispose(); h.bridge.disconnect();
  });
}
