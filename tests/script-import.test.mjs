import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { loadAdapterCode, createAdapterLoader } from './helpers/adapter-harness.mjs';
import { createInspectorFixture } from './helpers/inspector-harness.mjs';
import { parseArguments } from '../src/core/arguments.mjs';

const options = { timeout: 3000 };
const codes = await loadAdapterCode(['../plugin']);
const uuids = { Stream: 'git.renaudcerrato.deckforge.stream', Loop: 'git.renaudcerrato.deckforge.loop', Run: 'git.renaudcerrato.deckforge.run' };
const tokenA = 'a'.repeat(32), tokenB = 'b'.repeat(32);
const source = '#!/usr/bin/env python3\nprint("PRIVATE_SOURCE")\n';
const draft = { source, extension: 'py' };
// Fake OS/SDK operations resolve in microtasks unless a test explicitly holds
// them. Drain a check-phase turn, not an internal coordinator/session queue.
const progress = () => new Promise(resolve => setImmediate(resolve));
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
  const tracked = [], gates = [], availability = new Map();
  const decorated = new Map(), resultWaiters = [];
  let sequence = 0, link;
  const io = { existing: false, badSegment: undefined, writeFailure: false, closeFailure: false,
    uuid: undefined, writeGate: undefined, writeEntered: deferred(), closeGate: undefined, closeEntered: deferred() };
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
        async close() {
          file.closeCalls++; io.closeEntered.resolve();
          if (io.closeGate) await io.closeGate.promise;
          if (io.closeFailure) throw Error('PRIVATE_CLOSE_FAILURE'); file.closed = true;
        },
      };
    },
  };
  const subscribe = event => listener => {
    const listeners = availability.get(event) ?? [];
    listeners.push(listener); availability.set(event, listeners);
    return { dispose() {} };
  };
  const sdk = {
    info: { plugin: { uuid: 'git.renaudcerrato.deckforge', version: '0.1.0.0' },
      application: { platform: platform === 'win32' ? 'windows' : 'mac', version: '7.6', language: 'en', platformVersion: '26' } },
    logger: { setLevel() {}, info: value => logs.push(value), warn: value => logs.push(value) },
    actions: { registerAction(action) { registrations.push(action); } },
    devices: { onDeviceDidConnect: subscribe('connect'), onDeviceDidDisconnect: subscribe('disconnect') },
    system: { onSystemDidWakeUp: subscribe('wake'), onDidReceiveDeepLink(listener) { link = listener; return { dispose() {} }; } },
    ui: { async sendToPropertyInspector(value) {
      replies.push(structuredClone(value));
      io.onReply?.(structuredClone(value));
      if (value.type === 'canvas:script-result') for (const waiter of resultWaiters.splice(0)) waiter.resolve(value);
    } },
    connect: async () => {},
  };
  const load = createAdapterLoader(codes, { process: syntheticProcess, resolve(name) {
    if (name === '@elgato/streamdeck') return { default: sdk, SingletonAction: class {},
      action: metadata => Action => { decorated.set(Action, metadata.UUID); return Action; } };
    if (name === 'node:fs/promises') return filesystem;
    if (name === 'node:os') return { homedir: () => '/synthetic/home' };
    if (name === 'node:crypto') return { randomUUID: () => io.uuid ?? `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}` };
    if (name === '../core/process-runner.mjs') return { startProcessRun() {
      launches.push('unexpected launch'); throw Error('Unexpected process launch');
    } };
  } });
  const idle = progress;
  t.after(async () => {
    for (const gate of gates) gate.resolve();
    await idle();
    for (const { action, runtime } of tracked) await action.onWillDisappear({ action: runtime });
    for (const listener of availability.get('disconnect') ?? []) listener({ device: { id: 'synthetic-device', isConnected: false } });
    await idle();
  });
  load('../plugin');
  const actions = Object.fromEntries(Object.entries(uuids).map(([name, uuid]) => [name,
    registrations.find(action => decorated.get(action.constructor) === uuid)]));
  const writer = load('../script-import');
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
  async function receive(query, route = '/import') {
    link({ url: { path: route, queryParameters: query, href: `${route}?${query}` } });
    await progress();
  }
  return { load, writer, actions, runtime, appear, send, claim, arm, parameters, receive, idle,
    files, opens, directories, inspected, logs, replies, launches, io, syntheticProcess,
    hold() { const gate = deferred(); gates.push(gate); return gate; },
    dispatch(query) {
      const result = deferred(); resultWaiters.push(result);
      link({ url: { path: '/import', queryParameters: query, href: `/import?${query}` } }); return result.promise;
    },
  };
}

for (const kind of ['Stream', 'Loop', 'Run']) {
  test(`${kind} conversation imports distinct, identical and older revisions using the latest complete settings`, options, async t => {
    // Arrange: no source/version deduplication; the retained capability belongs to the owner.
    const h = harness(t), r = h.runtime('key', kind); await h.appear(r, kind); await h.arm(r, tokenA, kind);
    const original = structuredClone(r.slot.value), sources = [source, '#!/usr/bin/env python3\nprint("revision two")\n', source, source];
    // Act
    for (const [index, text] of sources.entries()) {
      if (index === 1) await h.send(r, 'canvas:edit', 4, { changes: { title: 'local title', themeColor: '#abcdef' } }, 'synthetic-pi', kind);
      await h.receive(h.parameters(tokenA, { source: text }));
    }
    await h.idle();
    const results = h.replies.filter(reply => reply.type === 'canvas:script-result');
    // Assert: each callback saves a fresh file and never starts any action mode.
    assert.equal(new Set(h.files.map(file => file.filename)).size, 4);
    assert.deepEqual(h.files.map(file => file.writes[0].value), sources);
    assert.deepEqual(results.map(result => [result.status, result.importSequence]), [['saved', 1], ['saved', 2], ['saved', 3], ['saved', 4]]);
    assert.deepEqual(r.slot.value, { ...original, executable: h.files[3].filename, argsText: '', cwd: '', title: 'local title', themeColor: '#abcdef' });
    assert.deepEqual(h.launches, []);
  });
}

test('owner keeps the canonical token through Ask registration, edits, hide/show and a new inspector claim', options, async t => {
  // Arrange
  const h = harness(t), r = h.runtime('key'); await h.appear(r); await h.arm(r);
  // Act
  await h.send(r, 'canvas:edit', 4, { changes: { title: 'keep me' } });
  await h.send(r, 'canvas:script', 5, { changes: { token: tokenB } }); const subsequent = h.replies.at(-1);
  await h.actions.Stream.onWillDisappear({ action: r });
  await h.receive(h.parameters()); await h.appear(r);
  await h.claim(r, 'Stream', 'reopened-pi'); const reopened = h.replies.at(-1);
  await h.receive(h.parameters()); await h.receive(h.parameters(tokenB)); await h.idle();
  // Assert: the old conversation survives; the unused proposal authorizes nothing.
  assert.equal(subsequent.scriptToken, tokenA); assert.equal(reopened.scriptToken, tokenA);
  assert.equal(reopened.importSequence, 1); assert.equal(h.files.length, 2);
  assert.equal(r.slot.value.title, 'keep me'); assert.deepEqual(h.launches, []);
  assert.equal(h.replies.at(-1).inspectorId, 'reopened-pi');
});

test('pre-write storage rejection leaves the owner link usable after the boundary recovers', options, async t => {
  // Arrange: a rejected owned-directory boundary must never create a script.
  const h = harness(t), r = h.runtime('key'); await h.appear(r); await h.arm(r);
  h.io.existing = true; h.io.badSegment = { name: 'scripts', kind: 'symlink' };
  // Act
  await h.receive(h.parameters()); const rejected = { files: h.files.length, writes: r.writes.length, status: h.replies.at(-1).status };
  h.io.badSegment = undefined; await h.receive(h.parameters()); await h.idle();
  // Assert
  assert.deepEqual(rejected, { files: 0, writes: 0, status: 'error' });
  assert.equal(h.files.length, 1); assert.equal(r.writes.length, 1); assert.equal(h.replies.at(-1).status, 'saved');
  assert.equal(h.replies.at(-1).importSequence, 2); assert.deepEqual(h.launches, []);
});

test('built Ask prompt callback configures the real settings graph twice and updates inspector controls without execution', options, async t => {
  // Arrange: built browser code and actual import/authority/session logic, only external boundaries doubled.
  const h = harness(t), r = h.runtime('integration-key'); await h.appear(r);
  const fixture = createInspectorFixture(), queue = [], opened = [], events = new Map(), timers = new Map();
  let socket, timerId = 0, randomByte = 1;
  class Socket {
    constructor() { socket = this; this.readyState = 0; }
    send(text) { const message = JSON.parse(text); if (message.event === 'sendToPlugin') queue.push(message); else if (message.event === 'openUrl') opened.push(message.payload.url); }
    close() { this.readyState = 3; }
  }
  const window = { addEventListener(name, callback) { events.set(name, callback); } };
  runInNewContext(readFileSync(new URL('../git.renaudcerrato.deckforge.sdPlugin/ui/run.js', import.meta.url), 'utf8'), {
    window, document: { readyState: 'complete', getElementById: fixture.getElementById }, WebSocket: Socket, TextEncoder,
    crypto: { getRandomValues(bytes) { return bytes.fill(randomByte++); } },
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; }, clearTimeout(id) { timers.delete(id); },
  }, { timeout: 1000 });
  h.io.onReply = payload => socket.onmessage({ data: JSON.stringify({ event: 'sendToPropertyInspector', payload }) });
  async function pump() {
    while (queue.length) await h.actions.Stream.onSendToPlugin({ action: r, payload: queue.shift().payload });
    await h.idle();
  }
  t.after(() => events.get('unload')());
  window.connectElgatoStreamDeckSocket('12345', 'synthetic-pi', 'registerPropertyInspector', '{}', JSON.stringify({ context: r.id, action: uuids.Stream, payload: { settings: r.slot.value } }));
  socket.readyState = 1; socket.onopen(); await pump();
  // Act: one conversation's actual prompt supplies the capability for both revisions.
  fixture.fields.askChatgpt.dispatch('click'); await pump();
  const prompt = new URL(opened[0]).searchParams.get('q');
  const callback = new URL(prompt.match(/Return URL: (\S+)/)[1]);
  const query = new URLSearchParams(callback.search); for (const [key, value] of Object.entries(draft)) query.set(key, value);
  const malformed = new URLSearchParams(query); malformed.set('source', '');
  await h.receive(malformed); const rejectedFiles = h.files.length;
  await h.dispatch(query); await h.idle();
  const first = { path: fixture.fields.executable.value, status: fixture.fields.status.textContent };
  query.set('source', '#!/usr/bin/env python3\nprint("second")\n');
  await h.dispatch(query); await h.idle();
  const secondStatus = fixture.fields.status.textContent;
  socket.onmessage({ data: JSON.stringify({ event: 'sendToPropertyInspector', payload: {
    ...h.replies.at(-1), context: 'foreign-key', importSequence: 99, settings: { executable: '/foreign.py' },
  } }) });
  const afterForeign = fixture.fields.executable.value;
  fixture.fields.askChatgpt.dispatch('click'); await pump();
  const nextPrompt = new URL(opened[1]).searchParams.get('q');
  // Assert: no mocked business logic, host durability or hardware claim.
  assert.equal(first.path, h.files[0].filename); assert.equal(first.status, 'Script imported. Press the key to run.');
  assert.equal(rejectedFiles, 0); assert.equal(secondStatus, first.status); assert.equal(afterForeign, h.files[1].filename);
  assert.equal(fixture.fields.executable.value, h.files[1].filename);
  assert.equal(fixture.fields.status.textContent, ''); // subsequent registration acknowledges current settings
  assert.equal(new URL(nextPrompt.match(/Return URL: (\S+)/)[1]).searchParams.get('token'), query.get('token'));
  assert.match(prompt, /Reuse this same Return URL/); assert.notEqual(h.files[0].filename, h.files[1].filename);
  assert.deepEqual(r.slot.value.extra, { keep: [true, 42] }); assert.deepEqual(r.slot.value.args, ['legacy']);
  assert.deepEqual(h.launches, []); assert.equal(JSON.stringify(h.logs).includes('PRIVATE'), false);
});

for (const kind of ['Stream', 'Loop', 'Run']) {
  test(`token callback configures only its ${kind} key with confirmed complete settings and no launch`, options, async t => {
    // Arrange: execute real plugin deep-link registration and the real adapter/authority graph.
    const h = harness(t), target = h.runtime('PRIVATE_TARGET', kind), other = h.runtime('other-key');
    await h.appear(target, kind); await h.appear(other); await h.arm(target, tokenA, kind);
    const original = structuredClone(target.slot.value), untouched = structuredClone(other.slot.value), registration = h.replies.at(-1);
    // Act
    const result = await h.dispatch(h.parameters(tokenA, { title: 'Imported title' })); await h.idle();
    // A visibility cycle must not turn an import into an implicit Start.
    await h.actions[kind].onWillDisappear({ action: target }); await h.appear(target, kind);
    // Assert: callback has no implicit Start and preserves the complete baseline.
    assert.equal(result.status, 'saved'); assert.equal(result.context, target.id);
    assert.equal(result.inspectorId, registration.inspectorId); assert.equal(result.requestId, registration.requestId);
    assert.deepEqual(target.writes, [{ ...original, executable: h.files[0].filename, argsText: '', cwd: '', title: 'Imported title' }]);
    assert.deepEqual(result.settings, target.slot.value); assert.deepEqual(other.slot.value, untouched); assert.deepEqual(other.writes, []);
    assert.equal(h.files.length, 1); assert.equal(h.files[0].closed, true);
    assert.deepEqual(h.launches, []);
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

test('one token cannot target two keys; busy callbacks drop but a later callback is admitted', options, async t => {
  // Arrange
  const h = harness(t), first = h.runtime('first'), other = h.runtime('other');
  await h.appear(first); await h.appear(other); await h.arm(first); await h.arm(other);
  const duplicateRegistration = h.replies.at(-1);
  h.io.writeGate = h.hold();
  // Act
  const importing = h.receive(h.parameters()); await h.io.writeEntered.promise;
  await h.receive(h.parameters()); const whileHeld = { files: h.files.length, writes: first.writes.length };
  h.io.writeGate.resolve(); await importing; await h.idle(); await h.receive(h.parameters()); await h.idle();
  // Assert
  assert.equal(duplicateRegistration.status, 'error'); assert.deepEqual(whileHeld, { files: 1, writes: 0 }); assert.equal(h.files.length, 2);
  assert.equal(first.writes.length, 2); assert.deepEqual(other.writes, []); assert.deepEqual(h.launches, []);
  assert.notEqual(h.files[0].filename, h.files[1].filename);
});

for (const stage of ['write', 'close']) {
  test(`registered import waits for file ${stage} completion before settings or a correlated result`, options, async t => {
    // Arrange: only the external file operation is held, not import or settings logic.
    const h = harness(t), r = h.runtime('completion-key'); await h.appear(r); await h.arm(r);
    const registration = h.replies.at(-1), original = structuredClone(r.slot.value), gate = h.hold();
    h.io[`${stage}Gate`] = gate;
    // Act: allow all runnable work to progress while the file boundary is held.
    const importing = h.dispatch(h.parameters()); await h.io[`${stage}Entered`].promise; await h.idle();
    const before = { writes: structuredClone(r.writes), settings: structuredClone(r.slot.value),
      results: h.replies.filter(reply => reply.type === 'canvas:script-result'), closed: h.files[0].closed };
    gate.resolve(); const result = await importing; await h.idle();
    // Assert: file completion is necessary, and releasing it really permits the same callback to save.
    assert.deepEqual(before, { writes: [], settings: original, results: [], closed: false });
    assert.equal(h.files[0].closed, true);
    assert.deepEqual(r.writes, [{ ...original, executable: h.files[0].filename, argsText: '', cwd: '' }]);
    assert.deepEqual(result, { type: 'canvas:script-result', context: r.id, inspectorId: registration.inspectorId,
      requestId: registration.requestId, importSequence: 1, status: 'saved', settings: r.slot.value });
    assert.deepEqual(h.launches, []);
  });
}

for (const matching of [true, false]) {
  test(`import completion waits for complete host confirmation and rejects mismatching readback=${!matching}`, options, async t => {
    // Arrange: file creation is not a settings acknowledgment or a launch authorization.
    const h = harness(t), r = h.runtime('key'); await h.appear(r); await h.arm(r);
    const old = structuredClone(r.slot.value), read = h.hold(), entered = deferred();
    r.getSettings = async () => { entered.resolve(structuredClone(r.slot.value)); return read.promise; };
    // Act
    const importing = h.receive(h.parameters()), expected = await entered.promise; await h.idle();
    const beforeReadback = h.replies.filter(reply => reply.type === 'canvas:script-result').length;
    read.resolve(matching ? expected : old); await importing;
    if (!matching) await h.receive(h.parameters());
    await h.idle();
    // Assert
    assert.equal(beforeReadback, 0); assert.equal(h.files.length, 1); assert.equal(r.writes.length, 1);
    assert.equal(h.replies.at(-1).status, matching ? 'saved' : 'error');
    assert.equal(Object.hasOwn(h.replies.at(-1), 'settings'), matching);
    if (matching) assert.deepEqual(h.replies.at(-1).settings, expected);
    else assert.equal(h.replies.some(reply => reply.type === 'canvas:script-result' && reply.status === 'saved'), false);
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
    h.io.writeGate.resolve(); await importing;
    if (change !== 'revision') await h.receive(h.parameters());
    await h.idle();
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
  test(`failed file ${failure} awaits handle close, redacts failure and permits an explicit retry`, options, async t => {
    // Arrange
    const h = harness(t), r = h.runtime('key'); await h.appear(r); await h.arm(r);
    const registration = h.replies.at(-1);
    h.io.writeFailure = failure === 'write'; h.io.closeFailure = failure === 'close';
    // Act
    await h.receive(h.parameters()); await h.idle();
    const result = h.replies.at(-1), failedFiles = h.files.length;
    h.io.writeFailure = h.io.closeFailure = false;
    await h.receive(h.parameters()); await h.idle();
    // Assert
    assert.equal(failedFiles, 1); assert.equal(h.files.length, 2); assert.equal(h.files[0].closeCalls, 1);
    assert.equal(h.files[0].closed, failure === 'write'); assert.equal(r.writes.length, 1);
    assert.deepEqual(result, { type: 'canvas:script-result', context: r.id, inspectorId: registration.inspectorId, requestId: registration.requestId, importSequence: 1, status: 'error' });
    assert.equal(h.replies.at(-1).status, 'saved'); assert.equal(h.replies.at(-1).importSequence, 2);
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
