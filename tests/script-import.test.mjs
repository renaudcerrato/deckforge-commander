import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadAdapterCode, createAdapterLoader } from './helpers/adapter-harness.mjs';
import { parseArguments } from '../src/core/arguments.mjs';

const options = { timeout: 3000 };
const codes = await loadAdapterCode(['../plugin']);
const uuids = { Stream: 'git.renaudcerrato.deckforge.stream', Loop: 'git.renaudcerrato.deckforge.loop', Run: 'git.renaudcerrato.deckforge.run' };
const tokenA = 'a'.repeat(32), tokenB = 'b'.repeat(32);
const source = '#!/usr/bin/env python3\nprint("PRIVATE_SOURCE")\n';
const draft = { source, extension: 'py' };
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

// Only OS boundaries are doubled. No directory lookup, file creation, SDK connection
// or program execution can fall through this loader to the real machine.
function harness(t, platform = 'darwin') {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const local = platform === 'win32' ? 'C:/synthetic/Local' : undefined;
  const syntheticProcess = { platform, env: local ? { LOCALAPPDATA: local } : {}, cwd: () => '/synthetic/cwd' };
  const files = [], opens = [], directories = [], inspected = [], logs = [], replies = [], registrations = [], launches = [];
  const sessions = [], states = [], managers = [], tracked = [], imports = new Set(), gates = [], timers = new Map();
  const decorated = new Map(), resultWaiters = [];
  let sequence = 0, timerId = 0, link;
  const timing = { now: () => 0, setTimer(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimer(id) { timers.delete(id); } };
  const io = { existing: false, badSegment: undefined, writeFailure: false, closeFailure: false,
    uuid: undefined, writeGate: undefined, writeEntered: deferred() };
  const filesystem = {
    async mkdir(filename, settings) {
      directories.push({ filename, settings });
      if (io.existing && !settings?.recursive) throw Object.assign(Error('PRIVATE_EEXIST'), { code: 'EEXIST' });
    },
    async realpath(filename) { return p.resolve(filename); },
    async lstat(filename) {
      inspected.push(filename);
      const bad = io.badSegment && p.basename(filename) === io.badSegment.name;
      return { isDirectory: () => !bad || io.badSegment.kind !== 'file', isSymbolicLink: () => Boolean(bad && io.badSegment.kind === 'symlink') };
    },
    async open(filename, flags, mode) {
      opens.push({ filename, flags, mode });
      assert.equal(flags, 'wx', 'imports must never overwrite an existing file');
      if (files.some(file => file.filename === filename)) throw Object.assign(Error('PRIVATE_COLLISION'), { code: 'EEXIST' });
      const file = { filename, mode, writes: [], closed: false, closeCalls: 0 };
      files.push(file);
      return {
        async writeFile(value, encoding) {
          file.writes.push({ value, encoding }); io.writeEntered.resolve();
          if (io.writeGate) await io.writeGate.promise;
          if (io.writeFailure) throw Error('PRIVATE_WRITE_FAILURE');
        },
        async close() { file.closeCalls++; if (io.closeFailure) throw Error('PRIVATE_CLOSE_FAILURE'); file.closed = true; },
      };
    },
  };
  const subscribe = () => ({ dispose() {} });
  const sdk = {
    info: { plugin: { uuid: 'git.renaudcerrato.deckforge', version: '0.1.0.0' },
      application: { platform: platform === 'win32' ? 'windows' : 'mac', version: '7.6', language: 'en', platformVersion: '26' } },
    logger: { setLevel() {}, info: value => logs.push(value), warn: value => logs.push(value) },
    actions: { registerAction(action) { registrations.push(action); } },
    devices: { onDeviceDidConnect: subscribe, onDeviceDidDisconnect: subscribe },
    system: { onSystemDidWakeUp: subscribe, onDidReceiveDeepLink(listener) { link = listener; return { dispose() {} }; } },
    ui: { async sendToPropertyInspector(value) {
      replies.push(structuredClone(value));
      if (value.type === 'canvas:script-result') for (const waiter of resultWaiters.splice(0)) waiter.resolve(value);
    } },
    connect: async () => {},
  };
  const factories = new Map([
    ['action-session', 'createActionSession', sessions], ['once-session', 'createOnceSession', sessions],
    ['timer-session', 'createTimerSession', sessions], ['run-state', 'createRunStateCoordinator', states],
    ['once-settings', 'createOnceStateCoordinator', states], ['timer-settings', 'createTimerStateCoordinator', states],
    ['availability', 'createAvailabilityManager', managers],
  ].map(([name, factory, values]) => [`../core/${name}.mjs`, { factory, values }]));
  const load = createAdapterLoader(codes, { process: syntheticProcess, resolve(name) {
    if (name === '@elgato/streamdeck') return { default: sdk, SingletonAction: class {},
      action: metadata => Action => { decorated.set(Action, metadata.UUID); return Action; } };
    if (name === 'node:fs/promises') return filesystem;
    if (name === 'node:os') return { homedir: () => '/synthetic/home' };
    if (name === 'node:crypto') return { randomUUID: () => io.uuid ?? `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}` };
    if (name === '../core/process-runner.mjs') return { startProcessRun() {
      launches.push('unexpected launch'); throw Error('Unexpected process launch');
    } };
  }, observe(name, actual) {
    const capture = factories.get(name);
    return capture ? { ...actual, [capture.factory](dependencies) {
      const boundary = capture.values === managers ? dependencies : { ...dependencies, ...timing };
      const value = actual[capture.factory](boundary); capture.values.push(value); return value;
    } } : actual;
  } });
  async function idle() {
    await Promise.all(managers.map(manager => manager.whenIdle()));
    await Promise.all(states.map(state => state.whenIdle()));
    await Promise.all(sessions.map(session => session.whenIdle()));
  }
  t.after(async () => {
    for (const gate of gates) gate.resolve();
    await Promise.all([...imports]);
    for (const { action, runtime } of tracked) await action.onWillDisappear({ action: runtime });
    for (const session of sessions) await session.setConnected(false);
    await idle(); for (const manager of managers) manager.dispose();
  });
  load('../plugin');
  const actions = Object.fromEntries(Object.entries(uuids).map(([name, uuid]) => [name,
    registrations.find(action => decorated.get(action.constructor) === uuid)]));
  const runtimeModule = load('./program-runtime'), writer = load('../script-import');
  function runtime(id, kind = 'Stream', input, slot) {
    slot ??= { value: structuredClone(input ?? { executable: platform === 'win32' ? 'C:/synthetic/old.exe' : '/synthetic/old', args: ['legacy'], extra: { keep: [true, 42] } }), writes: [] };
    return { id, manifestId: uuids[kind], slot, writes: slot.writes,
      isKey: () => true, coordinates: { row: 0, column: 0 }, device: { id: 'synthetic-device', isConnected: true },
      async getSettings() { return structuredClone(slot.value); },
      async setSettings(next) { slot.writes.push(structuredClone(next)); slot.value = structuredClone(next); },
      async setTitle() {}, async setImage() {},
    };
  }
  async function appear(r, kind = 'Stream') {
    const action = actions[kind]; tracked.push({ action, runtime: r });
    await action.onWillAppear({ action: r, payload: { settings: structuredClone(r.slot.value) } }); await idle();
  }
  async function send(r, type, requestId, extra = {}, inspectorId = 'synthetic-pi', kind = 'Stream') {
    await actions[kind].onSendToPlugin({ action: r, payload: { type, context: r.id, inspectorId, requestId, ...extra } });
  }
  async function claim(r, kind = 'Stream', inspectorId = 'synthetic-pi') {
    await send(r, 'canvas:hello', 1, {}, inspectorId, kind);
    await send(r, 'canvas:claim', 2, { token: replies.at(-1).token }, inspectorId, kind);
  }
  async function arm(r, token = tokenA, kind = 'Stream', inspectorId = 'synthetic-pi') {
    await claim(r, kind, inspectorId);
    await send(r, 'canvas:script', 3, { changes: { token } }, inspectorId, kind);
  }
  const parameters = (token = tokenA, changes = {}) => new URLSearchParams({ token, ...draft, ...changes });
  function receive(query, route = '/import') {
    const operation = runtimeModule.receiveScriptImport(route, query, `${route}?${query}`.length);
    imports.add(operation); void operation.finally(() => imports.delete(operation)); return operation;
  }
  return { load, writer, actions, runtime, appear, send, claim, arm, parameters, receive, idle,
    files, opens, directories, inspected, logs, replies, launches, io, syntheticProcess, states, sessions,
    hold() { const gate = deferred(); gates.push(gate); return gate; },
    dispatch(query) {
      const result = deferred(); resultWaiters.push(result);
      link({ url: { path: '/import', queryParameters: query, href: `/import?${query}` } }); return result.promise;
    },
  };
}

for (const kind of ['Stream', 'Loop', 'Run']) {
  test(`token callback configures only its ${kind} key with confirmed complete settings and no launch`, options, async t => {
    // Arrange: execute real plugin deep-link registration and the real adapter/authority graph.
    const h = harness(t), target = h.runtime('PRIVATE_TARGET', kind), other = h.runtime('other-key');
    await h.appear(target, kind); await h.appear(other); await h.arm(target, tokenA, kind);
    const original = structuredClone(target.slot.value), untouched = structuredClone(other.slot.value), registration = h.replies.at(-1);
    // Act
    const result = await h.dispatch(h.parameters(tokenA, { title: 'Imported title' })); await h.idle();
    const afterFirst = h.files.length;
    await h.receive(h.parameters(tokenA));
    // Assert: callback has no implicit Start; replay cannot create another file or settings write.
    assert.equal(result.status, 'saved'); assert.equal(result.context, target.id);
    assert.equal(result.inspectorId, registration.inspectorId); assert.equal(result.requestId, registration.requestId);
    assert.deepEqual(target.writes, [{ ...original, executable: h.files[0].filename, argsText: '', cwd: '', title: 'Imported title' }]);
    assert.deepEqual(result.settings, target.slot.value); assert.deepEqual(other.slot.value, untouched); assert.deepEqual(other.writes, []);
    assert.equal(afterFirst, 1); assert.equal(h.files.length, 1); assert.equal(h.files[0].closed, true);
    assert.deepEqual(h.launches, []);
    const state = h.sessions[0].getState();
    assert.equal(state.phase, 'stopped');
    if (kind === 'Stream') assert.equal(state.runRequested, false);
    if (kind === 'Loop') { assert.equal(state.enabled, false); assert.equal(state.dueMs, undefined); }
    assert.ok(h.logs.every(value => /^(?:SETTINGS_ACCEPTED_|SETTINGS_REJECTED_)/.test(value)));
    assert.equal(JSON.stringify(h.logs).includes('PRIVATE'), false);
  });
}

test('callback grammar, token targeting and invalid drafts reject before file I/O without consuming an unattempted token', options, async t => {
  // Arrange
  const h = harness(t), r = h.runtime('key'); await h.appear(r); await h.arm(r);
  const duplicate = h.parameters(); duplicate.append('source', 'other');
  const duplicateToken = h.parameters(); duplicateToken.append('token', tokenA);
  const missing = h.parameters(); missing.delete('extension');
  const cases = [h.parameters(tokenB), duplicate, duplicateToken, missing,
    h.parameters(tokenA, { source: '' }), h.parameters(tokenA, { extension: '../py' }),
    h.parameters(tokenA, { interpreter: 'relative' }), h.parameters(tokenA, { title: 'bad\0title' }),
    h.parameters(tokenA, { unknown: 'PRIVATE_UNKNOWN' }), h.parameters(tokenA, { source: 'x'.repeat(2000) })];
  // Act
  for (const query of cases) await h.receive(query);
  await h.receive(h.parameters(), '/wrong');
  const rejected = { files: h.files.length, writes: r.writes.length, replies: h.replies.length };
  await h.receive(h.parameters()); await h.idle();
  // Assert
  assert.deepEqual(rejected, { files: 0, writes: 0, replies: 3 });
  assert.equal(h.files.length, 1); assert.equal(r.writes.length, 1); assert.equal(h.replies.at(-1).status, 'saved');
  assert.deepEqual(h.launches, []); assert.equal(JSON.stringify(h.logs).includes('PRIVATE'), false);
});

for (const defect of ['foreign context', 'foreign inspector', 'stale request', 'invalid token', 'wrong action']) {
  test(`import prompt registration rejects ${defect} without authorizing a callback`, options, async t => {
    // Arrange
    const h = harness(t), r = h.runtime('key'); await h.appear(r); await h.claim(r);
    // Act
    const changes = { token: defect === 'invalid token' ? 'PRIVATE_BAD_TOKEN' : tokenA };
    await h.send(r, 'canvas:script', defect === 'stale request' ? 2 : 3,
      { changes, ...(defect === 'foreign context' ? { context: 'wrong-key' } : {}) },
      defect === 'foreign inspector' ? 'wrong-pi' : 'synthetic-pi', defect === 'wrong action' ? 'Run' : 'Stream');
    await h.receive(h.parameters()); await h.idle();
    // Assert
    assert.deepEqual(h.files, []); assert.deepEqual(r.writes, []); assert.deepEqual(h.launches, []);
    if (defect === 'invalid token') {
      assert.equal(h.replies.at(-1).status, 'error'); assert.equal(h.replies.at(-1).diagnosticCode, 'STATE_SAVE_FAILED');
      assert.equal(JSON.stringify(h.replies).includes('PRIVATE_BAD_TOKEN'), false);
    }
  });
}

test('one token cannot target two keys and concurrent callbacks consume one admitted import', options, async t => {
  // Arrange
  const h = harness(t), first = h.runtime('first'), other = h.runtime('other');
  await h.appear(first); await h.appear(other); await h.arm(first); await h.arm(other);
  const duplicateRegistration = h.replies.at(-1);
  h.io.writeGate = h.hold();
  // Act
  const importing = h.receive(h.parameters()); await h.io.writeEntered.promise;
  await h.receive(h.parameters()); const whileHeld = { files: h.files.length, writes: first.writes.length };
  h.io.writeGate.resolve(); await importing; await h.receive(h.parameters()); await h.idle();
  // Assert
  assert.equal(duplicateRegistration.status, 'error'); assert.deepEqual(whileHeld, { files: 1, writes: 0 }); assert.equal(h.files.length, 1);
  assert.equal(first.writes.length, 1); assert.deepEqual(other.writes, []); assert.deepEqual(h.launches, []);
});

for (const matching of [true, false]) {
  test(`import completion waits for complete host confirmation and rejects mismatching readback=${!matching}`, options, async t => {
    // Arrange: file creation is not a settings acknowledgment or a launch authorization.
    const h = harness(t), r = h.runtime('key'); await h.appear(r); await h.arm(r);
    const old = structuredClone(r.slot.value), read = h.hold(), entered = deferred();
    r.getSettings = async () => { entered.resolve(structuredClone(r.slot.value)); return read.promise; };
    // Act
    const importing = h.receive(h.parameters()), expected = await entered.promise;
    const beforeReadback = h.replies.filter(reply => reply.type === 'canvas:script-result').length;
    read.resolve(matching ? expected : old); await importing; await h.receive(h.parameters()); await h.idle();
    // Assert
    assert.equal(beforeReadback, 0); assert.equal(h.files.length, 1); assert.equal(r.writes.length, 1);
    assert.equal(h.replies.at(-1).status, matching ? 'saved' : 'error');
    assert.equal(Object.hasOwn(h.replies.at(-1), 'settings'), matching);
    if (matching) assert.deepEqual(h.replies.at(-1).settings, expected);
    assert.deepEqual(h.launches, []); assert.equal(JSON.stringify(h.logs).includes('PRIVATE'), false);
  });
}

for (const change of ['revision', 'same-facade owner', 'different-facade owner']) {
  test(`held import write cannot apply stale settings after ${change} changes`, options, async t => {
    // Arrange
    const h = harness(t), r = h.runtime('slot'); await h.appear(r); await h.arm(r);
    h.io.writeGate = h.hold(); const importing = h.receive(h.parameters()); await h.io.writeEntered.promise;
    // Act
    let current = r;
    if (change === 'revision') await h.send(r, 'canvas:edit', 4, { changes: { title: 'new local title' } });
    else {
      await h.actions.Stream.onWillDisappear({ action: r });
      r.slot.value = { ...r.slot.value, title: 'new owner' };
      const kind = change === 'same-facade owner' ? 'Stream' : 'Run';
      current = h.runtime(r.id, kind, undefined, r.slot); await h.appear(current, kind);
    }
    const latest = structuredClone(current.slot.value), writes = structuredClone(current.writes);
    h.io.writeGate.resolve(); await importing; await h.receive(h.parameters()); await h.idle();
    // Assert: an already-created orphan is allowed; stale configuration application is not.
    assert.deepEqual(current.slot.value, latest); assert.deepEqual(current.writes, writes);
    assert.equal(h.files.length, 1); assert.equal(h.files[0].closed, true); assert.deepEqual(h.launches, []);
    assert.equal(h.replies.some(reply => reply.type === 'canvas:script-result' && reply.status === 'saved'), false);
    assert.deepEqual(current.slot.value.extra, { keep: [true, 42] }); assert.deepEqual(current.slot.value.args, ['legacy']);
  });
}

test('held import cannot bypass dispatched-write quarantine when the runtime owner is replaced', options, async t => {
  // Arrange
  const h = harness(t), r = h.runtime('slot'); await h.appear(r); await h.arm(r);
  h.io.writeGate = h.hold(); const importing = h.receive(h.parameters()); await h.io.writeEntered.promise;
  const read = h.hold(), entered = deferred();
  r.getSettings = async () => { entered.resolve(); return read.promise; };
  const editing = h.send(r, 'canvas:edit', 4, { changes: { title: 'dispatched edit' } }); await entered.promise;
  // Act
  const hiding = h.actions.Stream.onWillDisappear({ action: r });
  const written = structuredClone(r.slot.value);
  r.slot.value = { ...r.slot.value, title: 'moved owner' };
  const moved = h.runtime(r.id, 'Stream', undefined, r.slot), appearing = h.appear(moved);
  read.resolve(written); await Promise.all([editing, hiding, appearing]);
  await h.arm(moved, tokenB, 'Stream', 'new-pi');
  h.io.writeGate.resolve(); await importing; await h.receive(h.parameters(tokenB)); await h.idle();
  // Assert
  assert.equal(moved.writes.length, 1); assert.equal(moved.slot.value.title, 'moved owner');
  assert.equal(h.files.length, 1); assert.equal(h.replies.at(-1).status, 'error');
  assert.equal(h.replies.at(-1).diagnosticCode, 'STATE_SAVE_FAILED'); assert.deepEqual(h.launches, []);
});

for (const platform of ['darwin', 'win32']) {
  test(`real ${platform} writer uses unique exclusive files and literal interpreter argv`, options, async t => {
    // Arrange
    const h = harness(t, platform), interpreter = platform === 'win32' ? 'C:/synthetic/python.exe' : '/synthetic/python';
    const input = { ...draft, interpreter, args: `'{{script}}' 'two words' '$HOME'`, cwd: platform === 'win32' ? 'D:/work' : '/synthetic/work' };
    // Act
    const parsed = h.writer.parseScriptDraft(input);
    const first = await h.writer.writeImportedScript(parsed), second = await h.writer.writeImportedScript(parsed);
    // Assert
    assert.notEqual(h.files[0].filename, h.files[1].filename);
    assert.ok(h.opens.every(open => open.flags === 'wx' && open.mode === 0o700));
    assert.ok(h.files.every(file => file.closed && file.writes.length === 1 && file.writes[0].value === source && file.writes[0].encoding === 'utf8'));
    assert.equal(first.executable, interpreter); assert.equal(second.executable, interpreter); assert.equal(first.cwd, input.cwd);
    assert.deepEqual(parseArguments(first.argsText, platform === 'win32' ? 'win32' : 'posix'), [h.files[0].filename, 'two words', '$HOME']);
    const p = platform === 'win32' ? path.win32 : path.posix;
    const base = platform === 'win32' ? p.resolve('C:/synthetic/Local') : '/synthetic/home/Library/Application Support';
    assert.ok(h.files.every(file => p.dirname(file.filename) === p.join(base, 'git.renaudcerrato.deckforge', 'scripts')));
    assert.ok(h.files.every(file => file.filename.endsWith('.py'))); assert.deepEqual(h.launches, []);
  });
}

test('POSIX shebang import is directly executable, but Windows requires an explicit interpreter', options, async t => {
  // Arrange
  const mac = harness(t), windows = harness(t, 'win32');
  // Act
  const result = await mac.writer.writeImportedScript(mac.writer.parseScriptDraft(draft));
  const failure = await windows.writer.writeImportedScript(windows.writer.parseScriptDraft(draft)).catch(error => error);
  // Assert
  assert.equal(result.executable, mac.files[0].filename); assert.equal(result.argsText, '');
  assert.equal(mac.files[0].writes[0].value, source);
  assert.equal(failure.message, 'Script import needs correction.'); assert.deepEqual(windows.opens, []);
});

test('exclusive collision refuses overwrite and does not retry with an unapproved filename', options, async t => {
  // Arrange
  const h = harness(t); h.io.uuid = '00000000-0000-4000-8000-000000000001';
  const parsed = h.writer.parseScriptDraft(draft); await h.writer.writeImportedScript(parsed);
  // Act
  const error = await h.writer.writeImportedScript(parsed).catch(value => value);
  // Assert
  assert.equal(error.code, 'EEXIST'); assert.equal(h.files.length, 1);
  assert.equal(h.files[0].writes.length, 1); assert.equal(h.files[0].closed, true);
});

for (const name of ['git.renaudcerrato.deckforge', 'scripts']) for (const kind of ['symlink', 'file']) {
  test(`writer rejects ${kind} at owned ${name} directory before opening a script`, options, async t => {
    // Arrange
    const h = harness(t); h.io.existing = true; h.io.badSegment = { name, kind };
    // Act
    const error = await h.writer.writeImportedScript(h.writer.parseScriptDraft(draft)).catch(value => value);
    // Assert
    assert.equal(error.message, 'Script import needs correction.'); assert.deepEqual(h.opens, []);
  });
}
test('writer accepts existing real owned directories after their boundary checks', options, async t => {
  // Arrange
  const h = harness(t); h.io.existing = true;
  // Act
  await h.writer.writeImportedScript(h.writer.parseScriptDraft(draft));
  // Assert
  assert.equal(h.inspected.length, 2); assert.equal(h.files.length, 1); assert.equal(h.files[0].closed, true);
});
for (const base of [undefined, 'relative', String.raw`\\server\share`, String.raw`\\?\C:\local`]) {
  test('Windows import rejects missing or nonlocal storage bases without filesystem effects', options, async t => {
    // Arrange
    const h = harness(t, 'win32'); h.syntheticProcess.env = base === undefined ? {} : { LOCALAPPDATA: base };
    const parsed = h.writer.parseScriptDraft({ ...draft, interpreter: 'C:/python.exe' });
    // Act
    const error = await h.writer.writeImportedScript(parsed).catch(value => value);
    // Assert
    assert.equal(error.message, 'Script import needs correction.'); assert.deepEqual(h.directories, []); assert.deepEqual(h.opens, []);
  });
}
for (const failure of ['write', 'close']) {
  test(`failed file ${failure} awaits handle close, emits only a fixed outcome and consumes the attempted token`, options, async t => {
    // Arrange
    const h = harness(t), r = h.runtime('key'); await h.appear(r); await h.arm(r);
    const registration = h.replies.at(-1);
    h.io.writeFailure = failure === 'write'; h.io.closeFailure = failure === 'close';
    // Act
    await h.receive(h.parameters()); await h.receive(h.parameters()); await h.idle();
    // Assert
    assert.equal(h.files.length, 1); assert.equal(h.files[0].closeCalls, 1);
    assert.equal(h.files[0].closed, failure === 'write'); assert.deepEqual(r.writes, []);
    const result = h.replies.at(-1);
    assert.deepEqual(result, { type: 'canvas:script-result', context: r.id, inspectorId: registration.inspectorId, requestId: registration.requestId, status: 'error' });
    assert.equal(JSON.stringify([result, h.logs]).includes('PRIVATE'), false); assert.deepEqual(h.launches, []);
  });
}

for (const [label, changes] of [
  ['empty source', { source: '' }], ['blank source', { source: ' \n' }], ['NUL source', { source: 'x\0' }],
  ['oversize UTF8 source', { source: 'é'.repeat(65537) }], ['extension traversal', { extension: '../py' }],
  ['uppercase extension', { extension: 'PY' }], ['relative interpreter', { interpreter: 'python' }],
  ['relative cwd', { cwd: 'work' }], ['unmatched quote', { args: "'unfinished" }],
  ['missing script argument', { interpreter: '/python', args: '' }],
  ['duplicate script argument', { interpreter: '/python', args: '{{script}} {{script}}' }],
  ['embedded script placeholder', { interpreter: '/python', args: 'prefix{{script}}' }],
  ['too many argv', { args: Array(257).fill('x').join(' ') }], ['oversize arg', { args: 'x'.repeat(8193) }],
  ['unknown field', { runRequested: true }],
]) {
  test(`real draft parser rejects ${label} before any writer boundary`, options, t => {
    // Arrange
    const h = harness(t), input = { ...draft, ...changes };
    // Act
    const parse = () => h.writer.parseScriptDraft(input);
    // Assert
    assert.throws(parse); assert.deepEqual(h.opens, []); assert.deepEqual(h.launches, []);
  });
}
test('draft source accepts the exact UTF8 bound and detaches accepted plaintext configuration', options, t => {
  // Arrange
  const h = harness(t), input = { source: 'é'.repeat(65536), extension: 'py', title: 'literal/a.txt' };
  // Act
  const parsed = h.writer.parseScriptDraft(input); input.source = 'changed';
  // Assert
  assert.equal(Buffer.byteLength(parsed.source, 'utf8'), 131072); assert.equal(parsed.title, 'literal/a.txt');
  assert.deepEqual(h.opens, []);
});
