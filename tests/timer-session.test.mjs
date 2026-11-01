import test from 'node:test';
import assert from 'node:assert/strict';
import { createTimerSession, TIMER_HOLD_MS } from '../src/core/timer-session.mjs';
import { createTimerStateCoordinator } from '../src/core/timer-settings.mjs';
import { parseOutputUpdate } from '../src/core/output-update.mjs';
import { createPrimitiveArtwork } from '../src/core/primitive-artwork.mjs';
import { assertSvgElement } from './helpers/svg-harness.mjs';

const options = { timeout: 3000 };
const base = { executable: '/synthetic/program.sh', argsText: '', intervalSeconds: 5 };
const policySettings = policy => ({ ...base, ...(policy === undefined ? {} : { actionOnPress: policy }) });
const success = { status: 'success' };
const ordinaryError = 'Program exited unsuccessfully.';
const image = label => parseOutputUpdate(`<svg>${label}</svg>`);
const images = h => h.events.filter(event => event[0] === 'image').map(event => event[1]);
const errors = h => h.events.filter(event => event[0] === 'error');
const cards = h => h.events.filter(event => ['ready', 'waiting'].includes(event[0]));
const svg = value => decodeURIComponent(value.slice('data:image/svg+xml,'.length));

for (const diagnosis of ['display', 'protocol', 'cleanup']) {
  test(`P3 Loop pending image rejection preserves ${diagnosis} priority and cancels deadlines`, options, async () => {
    // Arrange: no real process, SDK or wall-clock timer participates.
    const gate = deferred(), entered = deferred();
    const h = harness({ image() { entered.resolve(); return gate.promise; } });
    await h.appear(); await h.tap();
    h.runs[0].callbacks.onUpdate(image('pending')); await entered.promise;
    // Act
    if (diagnosis !== 'display') h.runs[0].callbacks.onError('Image protocol error.');
    if (diagnosis === 'cleanup') h.runs[0].stopResult = false;
    gate.reject(new Error('synthetic image boundary')); await h.session.whenIdle();
    const beforeLate = [...h.events];
    h.runs[0].callbacks.onUpdate(image('late')); await h.advance(100000);
    // Assert: the late rejection still cleans up and suspends, but cannot lower error priority.
    assert.equal(errors(h).at(-1)?.[2], diagnosis === 'protocol' ? 'IMAGE_PROTOCOL_ERROR'
      : diagnosis === 'cleanup' ? 'CLEANUP_BLOCKED' : 'FRAME_SEND_FAILED');
    assert.equal(h.runs[0].stops, 1); assert.equal(h.runs.length, 1);
    assert.equal(h.session.getState().suspended, true); assert.equal(h.session.getState().dueMs, undefined);
    assert.deepEqual(h.events, beforeLate);
  });
}

test('TITLE-1 Loop custom built-ins retain executable badge and exact post-completion deadline', options, async () => {
  // Arrange
  const h = harness(); await h.appear({ ...base, title: 'a/b.txt' }); const ready = h.artwork.at(-1);
  await h.tap(); const loading = h.artwork.at(-1); await h.finish();
  const due = h.session.getState().dueMs;
  // Act
  await h.advance(1000); await h.edit({ title: 'changed' }); const successCard = h.artwork.at(-1);
  await h.advance(3999); const beforeDeadline = h.runs.length; await h.advance(1);
  // Assert
  assert.equal(ready.caption, 'a/b.txt'); assert.equal(ready.extension, '.sh'); assert.equal(loading.caption, 'a/b.txt');
  assert.equal(successCard.caption, 'changed'); assert.equal(successCard.footer, 'success');
  assert.equal(due, 5000); assert.equal(beforeDeadline, 1); assert.equal(h.runs.length, 2);
  assert.equal(h.runs[0].stops, 0); assert.deepEqual(errors(h), []);
});
test('TITLE-1 Loop title-only edits preserve Setup and fatal protocol errors without redraw', options, async () => {
  // Arrange
  const setup = harness(); await setup.appear({}); const setupEvents = [...setup.events];
  const h = harness(); await h.appear(); await h.tap(); h.runs[0].callbacks.onError('Image protocol error.');
  await h.finish({ status: 'error', error: 'Image protocol error.' }); const before = [...h.events], state = h.session.getState();
  // Act
  await setup.edit({ title: 'hidden' }); await h.edit({ title: 'hidden' }); await h.advance(100000);
  // Assert
  assert.deepEqual(setup.events, setupEvents); assert.deepEqual(setup.runs, []); assert.deepEqual(h.events, before);
  assert.equal(h.session.getState().phase, state.phase); assert.equal(h.runs.length, 1);
});
test('TITLE-1 Loop title plus theme redraws primitives and title plus execution cancels automation', options, async () => {
  // Arrange
  const h = harness(); await h.appear(); await h.tap(); h.runs[0].callbacks.onUpdate(parseOutputUpdate('text:retained')); await h.session.whenIdle();
  const count = images(h).length;
  // Act
  await h.edit({ title: 'new', themeColor: '#abcdef' }); const recolored = images(h).at(-1), stops = h.runs[0].stops;
  await h.edit({ title: 'other', executable: '/synthetic/other' }); await h.advance(100000);
  // Assert
  assert.ok(images(h).length > count); assert.match(svg(recolored), /fill="#abcdef"/);
  assert.equal(stops, 0); assert.equal(h.runs[0].stops, 1); assert.equal(h.runs.length, 1);
});
test('TITLE-1 Loop title edit cannot displace queued final producer output', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred(), first = image('title-first');
  const h = harness({ async image(value) { if (value === first.image) { entered.resolve(); await gate.promise; } } });
  await h.appear(); await h.tap(); h.runs[0].callbacks.onUpdate(first); await entered.promise;
  const final = parseOutputUpdate('text:final'); h.runs[0].callbacks.onUpdate(final);
  // Act
  const editing = h.edit({ title: 'edited' }), finishing = h.finish(); gate.resolve(); await Promise.all([editing, finishing]);
  // Assert
  assert.deepEqual(images(h), [first.image, createPrimitiveArtwork(final)]);
  assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 0); assert.equal(h.session.getState().dueMs, 5000);
});
test('TITLE-1 Loop title edit preserves a pending start across the Loading handoff', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred(); let first = true;
  const h = harness({ async presentation(kind) { if (kind === 'waiting' && first) { first = false; entered.resolve(); await gate.promise; } } });
  await h.appear(); const tapping = h.tap(); await entered.promise;
  // Act
  const editing = h.edit({ title: 'new title' }); gate.resolve(); await Promise.all([tapping, editing]);
  // Assert
  assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 0); assert.equal(h.session.getState().phase, 'running');
  assert.equal(h.artwork.at(-1).caption, 'new title'); assert.deepEqual(errors(h), []);
});
for (const wire of ['text:hello', 'progress:17/23', '<svg>opaque</svg>']) {
  test(`TITLE-1 Loop title edits preserve live and retained producer ${wire.split(':')[0]}`, options, async () => {
    // Arrange
    const h = harness(); await h.appear(); await h.tap();
    h.runs[0].callbacks.onUpdate(parseOutputUpdate(wire)); await h.session.whenIdle(); const live = [...h.events];
    // Act
    await h.edit({ title: 'a/b.txt' }); const afterLive = [...h.events]; await h.finish();
    const retained = [...h.events], due = h.session.getState().dueMs;
    await h.edit({ title: '' });
    // Assert
    assert.deepEqual(afterLive, live); assert.deepEqual(h.events, retained); assert.equal(h.session.getState().dueMs, due);
    assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 0); assert.deepEqual(errors(h), []);
  });
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Time and callback delivery are independent: release can cross the hold boundary
// before its timer callback, and a hidden overdue deadline never replays a backlog.
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

// The real coordinator owns complete snapshots, serialization and readback gates.
// Only host storage, process cleanup, SDK handoff and time are doubled. No program
// is executed, and no fixture treats a cached SDK snapshot as a save ACK.
function harness(overrides = {}) {
  const time = clock(), events = [], runs = [], writes = [], confirmations = [], artwork = [];
  let host = {};
  const coordinator = createTimerStateCoordinator({
    platform: overrides.platform ?? 'posix',
    async writeSettings(value) {
      writes.push(structuredClone(value));
      if (overrides.write) await overrides.write(value);
      host = structuredClone(value);
    },
    async readSettings() { return overrides.read ? overrides.read(host) : structuredClone(host); },
    setTimer: time.setTimer, clearTimer: time.clearTimer,
  });
  const session = createTimerSession({
    platform: overrides.platform ?? 'posix',
    initialConnected: overrides.initialConnected ?? true,
    now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer,
    async awaitConfiguration(expected) {
      confirmations.push(structuredClone(expected));
      if (overrides.confirm) {
        const accepted = await overrides.confirm(expected);
        if (accepted !== true) return false;
      }
      await coordinator.whenIdle();
      return !coordinator.isBlocked() && assertSnapshotsEqual(expected, coordinator.getSettings());
    },
    startRun(execution, callbacks) {
      if (overrides.start) overrides.start(execution);
      const done = deferred();
      const run = { execution: structuredClone(execution), callbacks, done, stops: 0, stopResult: true, stopGate: undefined, stopEntered: deferred() };
      runs.push(run);
      return {
        done: done.promise,
        async stop() {
          run.stops++;
          run.stopEntered.resolve();
          const certain = run.stopGate ? await run.stopGate.promise : run.stopResult;
          // Real runner done follows owned cleanup, not the initial exit event.
          done.resolve({ status: 'stopped' });
          return certain;
        },
      };
    },
    async setTitle(title, current) {
      if (overrides.title) await overrides.title(title, current);
      if (current()) events.push(['title', title]);
    },
    async setImage(value, current) {
      if (current()) events.push(['image', value]);
      if (overrides.image) await overrides.image(value, current);
    },
    async onError(message, code, current, theme) {
      if (overrides.error) await overrides.error(message, code, current);
      if (current()) events.push(['error', message, code, theme]);
    },
    async onPresentation(kind, caption, current, theme, footer, extension) {
      if (overrides.presentation) await overrides.presentation(kind, current, caption, theme, footer, extension);
      if (current()) { events.push([kind, caption, footer, theme]); artwork.push({ kind, caption, theme, footer, extension, current }); }
    },
  });
  return {
    session, time, events, runs, writes, confirmations, coordinator, artwork,
    async appear(settings = base) {
      const accepted = coordinator.observe(settings);
      await session.appear(accepted.settings); await session.whenIdle();
    },
    async edit(changes) {
      const save = coordinator.editConfiguration(changes);
      // Capture a rejected save immediately; session authority independently latches it.
      const settled = save.then(value => value, error => error);
      const applied = session.applySettings(coordinator.getSettings());
      await settled; await applied; await session.whenIdle();
    },
    async tap() { await session.keyDown(); await session.keyUp(); await session.whenIdle(); },
    async finish(result = success, run = runs.at(-1)) {
      if (result.status === 'success') run.callbacks.onDiagnostic('PROCESS_EXITED_SUCCESSFULLY');
      run.done.resolve(result);
      await Promise.resolve(); await session.whenIdle();
    },
    async advance(ms, deliver = true) { time.advance(ms, deliver); await session.whenIdle(); },
  };
}

function assertSnapshotsEqual(first, second) {
  try { assert.deepEqual(first, second); return true; } catch { return false; }
}

// S2: Windows paths select validation/caption only, not a new Loop scheduling policy.
test('Windows Loop interval and press-mode edits preserve the active owner and use latest delay after completion', options, async () => {
  // Arrange
  const h = harness({ platform: 'win32' }), input = { executable: String.raw`C:\folder\report.EXE`, argsText: '', intervalSeconds: 5 };
  await h.appear(input); const fresh = h.runs.length; await h.tap();
  h.runs[0].callbacks.onUpdate(parseOutputUpdate('text:retained')); await h.session.whenIdle();
  // Act
  await h.edit({ themeColor: '#abcdef', intervalSeconds: 10, actionOnPress: 'stop' });
  const stops = h.runs[0].stops, retained = images(h).at(-1); await h.finish();
  const due = h.session.getState().dueMs; await h.advance(9999); const beforeDeadline = h.runs.length; await h.advance(1);
  // Assert
  assert.equal(fresh, 0); assert.equal(stops, 0); assert.match(svg(retained), />retained<\/text>/);
  assert.equal(due, 10000); assert.equal(beforeDeadline, 1); assert.equal(h.runs.length, 2);
  assert.deepEqual(h.runs[1].execution, { executable: input.executable, args: [] });
  assert.deepEqual(h.writes, [{ ...input, themeColor: '#abcdef', intervalSeconds: 10, actionOnPress: 'stop' }]);
  await h.session.setConnected(false); await h.session.whenIdle();
});
test('Windows Loop cleanup uncertainty blocks replacement but not a complete configuration save', options, async () => {
  // Arrange
  const h = harness({ platform: 'win32' }), input = { executable: 'C:/first.EXE', argsText: '', intervalSeconds: 5 };
  await h.appear(input); await h.tap(); h.runs[0].stopResult = false;
  // Act
  await h.edit({ executable: 'D:/next.EXE' }); await h.tap(); await h.advance(100000);
  const before = [...images(h)]; h.runs[0].callbacks.onUpdate(image('stale')); await h.session.whenIdle();
  // Assert
  assert.equal(h.runs.length, 1); assert.equal(h.session.getState().cleanupBlocked, true);
  assert.deepEqual(h.writes, [{ ...input, executable: 'D:/next.EXE' }]); assert.deepEqual(images(h), before);
});

// Slice 3: headline/caption cosmetics do not alter Loop's owner or completion-based deadline.
test('Loop retained card redraw keeps its deadline and rejects malformed replacement output', options, async () => {
  // Arrange
  const h = harness(); await h.appear(); await h.tap();
  const record = parseOutputUpdate('card:UP|header:API;footer:HTTP 200;footer-color:ivory');
  h.runs[0].callbacks.onUpdate(record); await h.session.whenIdle(); await h.finish();
  const due = h.session.getState().dueMs;
  // Act
  h.runs[0].callbacks.onUpdate({ ...record, value: 'bad\0' });
  await h.edit({ themeColor: '#abcdef' });
  const rendered = svg(images(h).at(-1));
  // Assert
  assert.match(rendered, /fill="#abcdef"[^>]*>API<\/text>/);
  assert.match(rendered, /fill="#abcdef"[^>]*>UP<\/text>/);
  assert.match(rendered, /fill="#fffff0"[^>]*>HTTP 200<\/text>/);
  assert.equal(h.session.getState().dueMs, due); assert.equal(h.session.getState().enabled, true);
  assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 0); assert.deepEqual(errors(h), []);
});

// Slice 4: immutable LF main content follows Loop cosmetics, not the repeat policy.
for (const stage of ['running', 'completed']) {
  test(`Loop ${stage} hard-line redraw preserves deadline and ignores invalid new schema`, options, async () => {
    // Arrange
    const h = harness(); await h.appear(); await h.tap();
    const record = parseOutputUpdate(String.raw`text:A\n\nB|font-size:16;border:2`);
    const mutable = { ...record, options: { ...record.options }, overrides: { ...record.overrides } };
    h.runs[0].callbacks.onUpdate(mutable); await h.session.whenIdle();
    if (stage === 'completed') await h.finish();
    const due = h.session.getState().dueMs;
    // Act
    mutable.value = 'mutated'; mutable.options['font-size'] = 48;
    h.runs[0].callbacks.onUpdate({ ...record, hardBreaks: true });
    await h.edit({ themeColor: '#abcdef' }); const rendered = svg(images(h).at(-1));
    // Assert
    assert.deepEqual([...rendered.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map(match => match[1]), ['A', '', 'B']);
    assert.deepEqual([...rendered.matchAll(/<text\b[^>]*fill="([^"]*)"/g)].map(match => match[1]), Array(3).fill('#abcdef'));
    assert.equal(record.value, 'A\n\nB'); assert.equal(h.session.getState().dueMs, due);
    assert.equal(h.session.getState().enabled, true); assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 0);
    assert.deepEqual(errors(h), []);
  });
}
test('Loop final hard lines reject forged schema, drain before deadline and reject old-generation callback', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred(), first = image('hard-first');
  const h = harness({ async image(value) { if (value === first.image) { entered.resolve(); await gate.promise; } } });
  await h.appear(); await h.tap(); h.runs[0].callbacks.onUpdate(first); await entered.promise;
  const final = parseOutputUpdate(String.raw`text:A\n\nB|font-size:16`);
  // Act
  h.runs[0].callbacks.onUpdate(final);
  h.runs[0].callbacks.onUpdate({ ...final, hardBreaks: true });
  h.runs[0].callbacks.onUpdate({ ...final, value: 'bad\0' });
  h.runs[0].callbacks.onUpdate({ ...final, options: { ...final.options, 'max-lines': 2 } });
  h.runs[0].done.resolve(success); await Promise.resolve();
  const before = h.session.getState().dueMs; gate.resolve(); await h.session.whenIdle();
  const drained = [...images(h)], due = h.session.getState().dueMs;
  await h.advance(5000); h.runs[0].callbacks.onUpdate(parseOutputUpdate(String.raw`text:stale\ncallback`)); await h.session.whenIdle();
  // Assert
  assert.equal(before, undefined); assert.equal(due, 5000);
  assert.deepEqual(drained, [first.image, createPrimitiveArtwork(final)]); assert.deepEqual(images(h), drained);
  assert.equal(h.runs.length, 2); assert.equal(h.runs[0].stops, 0); assert.deepEqual(errors(h), []);
});
for (const stage of ['running', 'completed']) {
  test(`Loop ${stage} caption redraw preserves deadline and immutable content`, options, async () => {
    // Arrange: renderer tests own the position/font/color combinations.
    const h = harness(); await h.appear(); await h.tap();
    const record = parseOutputUpdate('text:42|font-size:48;label:Items;label-size:14.25;label-position:above;border:2;label-color:ivory');
    const before = JSON.stringify(record);
    const mutable = { ...record, options: { ...record.options }, overrides: { ...record.overrides } };
    h.runs[0].callbacks.onUpdate(mutable); await h.session.whenIdle();
    if (stage === 'completed') await h.finish();
    const due = h.session.getState().dueMs;
    // Act
    mutable.value = 'mutated'; mutable.options['label-position'] = 'center'; mutable.overrides['label-position'] = 'center';
    await h.edit({ themeColor: '#abcdef' }); const rendered = svg(images(h).at(-1));
    // Assert
    assert.deepEqual([...rendered.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map(match => match[1]), ['Items', '42']);
    assert.match(rendered, /stroke="#abcdef"/);
    assert.equal(JSON.stringify(record), before); assert.equal(h.session.getState().dueMs, due);
    assert.equal(h.session.getState().enabled, true); assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 0);
    assert.deepEqual(errors(h), []);
  });
}
test('Loop final caption survives invalid callback admission, drains before scheduling and rejects old generation', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred(), first = image('caption-first');
  const h = harness({ async image(value) { if (value === first.image) { entered.resolve(); await gate.promise; } } });
  await h.appear(); await h.tap(); h.runs[0].callbacks.onUpdate(first); await entered.promise;
  const final = parseOutputUpdate('text:42|label:Items;label-color:ivory;font-size:48;label-position:above');
  // Act
  h.runs[0].callbacks.onUpdate(final);
  const missingPosition = { ...final.options }; delete missingPosition['label-position'];
  h.runs[0].callbacks.onUpdate({ ...final, options: missingPosition });
  h.runs[0].callbacks.onUpdate({ ...final, options: { ...final.options, 'label-position': 'below' } });
  h.runs[0].callbacks.onUpdate({ ...final, options: { ...final.options, get ['label-position']() { throw Error('synthetic'); } } });
  h.runs[0].callbacks.onUpdate({ ...final, options: new Proxy(final.options, { ownKeys() { throw Error('synthetic'); } }) });
  h.runs[0].callbacks.onUpdate({ ...final, options: { ...final.options, label: 'forged' } });
  const missing = { ...final.options }; delete missing['label-color'];
  h.runs[0].callbacks.onUpdate({ ...final, options: missing });
  h.runs[0].callbacks.onUpdate({ ...final, options: { ...final.options, 'label-color': 'accent' } });
  h.runs[0].callbacks.onUpdate({ ...final, overrides: { ...final.overrides, 'label-color': 'blue' } });
  h.runs[0].done.resolve(success); await Promise.resolve();
  const before = h.session.getState().dueMs; gate.resolve(); await h.session.whenIdle();
  const drained = [...images(h)], due = h.session.getState().dueMs;
  await h.advance(5000); h.runs[0].callbacks.onUpdate(parseOutputUpdate('text:late|label:stale')); await h.session.whenIdle();
  // Assert
  assert.equal(before, undefined); assert.equal(due, 5000);
  assert.deepEqual(drained, [first.image, createPrimitiveArtwork(final)]); assert.deepEqual(images(h), drained);
  assert.equal(h.runs.length, 2); assert.equal(h.runs[0].stops, 0); assert.deepEqual(errors(h), []);
});

// Slice 2: presentation-only ratios cannot enable a run or advance the Loop deadline.
for (const stage of ['running', 'completed']) {
  for (const [suffix, caption] of [['', '1.6%'], [';display:17 done', '17 done'], [';display:', undefined], [';display:17 done;value-position:none', undefined]]) {
    test(`Loop ${stage} ratio ${suffix || 'default'} retains literal caption and precise fill on redraw`, options, async () => {
      // Arrange
      const h = harness(); await h.appear(); await h.tap();
      const record = parseOutputUpdate(`progress:17/1034|border:2;value-color:accent${suffix}`);
      h.runs[0].callbacks.onUpdate(record); await h.session.whenIdle();
      if (stage === 'completed') await h.finish();
      const due = h.session.getState().dueMs, original = svg(images(h).at(-1));
      // Act
      await h.edit({ themeColor: '#abcdef' }); const rendered = svg(images(h).at(-1));
      // Assert
      assert.deepEqual([...rendered.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map(match => match[1]), caption ? [caption] : []);
      assert.equal(/stroke-dasharray="([^"]*)"/.exec(rendered)[1], /stroke-dasharray="([^"]*)"/.exec(original)[1]);
      assert.equal(record.value, 1700 / 1034); assert.match(rendered, /stroke="#abcdef"/);
      assert.equal(h.session.getState().dueMs, due); assert.equal(h.session.getState().enabled, true);
      assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 0); assert.deepEqual(errors(h), []);
    });
  }
}
test('Loop final ratio rejects forged/missing display, drains before scheduling, and ignores old callback next run', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred(), first = image('first');
  const h = harness({ async image(value) { if (value === first.image) { entered.resolve(); await gate.promise; } } });
  await h.appear(); await h.tap(); h.runs[0].callbacks.onUpdate(first); await entered.promise;
  const final = parseOutputUpdate('progress:17/1034|display:17 done;label:Build');
  // Act
  h.runs[0].callbacks.onUpdate(final);
  h.runs[0].callbacks.onUpdate({ ...final, options: { ...final.options, display: 'forged' } });
  const missing = { ...final.options }; delete missing.display;
  h.runs[0].callbacks.onUpdate({ ...final, options: missing });
  h.runs[0].callbacks.onUpdate({ ...final, overrides: { ...final.overrides, display: undefined } });
  h.runs[0].done.resolve(success); await Promise.resolve();
  const before = h.session.getState().dueMs; gate.resolve(); await h.session.whenIdle();
  const drained = [...images(h)], due = h.session.getState().dueMs;
  await h.advance(5000); h.runs[0].callbacks.onUpdate(parseOutputUpdate('progress:1/2|display:late')); await h.session.whenIdle();
  // Assert
  assert.equal(before, undefined); assert.equal(due, 5000);
  assert.deepEqual(drained, [first.image, createPrimitiveArtwork(final)]);
  assert.deepEqual(images(h), drained); assert.equal(h.runs.length, 2);
  assert.equal(h.runs[0].stops, 0); assert.deepEqual(errors(h), []);
});

// Slice 3: preserve the existing callback's first five arguments and record its additive suffix.
test('Loop Ready, first Loading and no-output Success use the configured suffix only', options, async () => {
  // Arrange
  const h = harness(); await h.appear({ ...base, executable: '/synthetic/report.PY', argsText: 'other.sh' });
  // Act
  await h.tap(); await h.finish();
  // Assert
  assert.deepEqual(h.artwork.map(item => [item.kind, item.caption, item.footer, item.extension]),
    [['ready', 'report', 'ready', '.py'], ['waiting', 'report', 'ready', '.py'], ['ready', 'report', 'success', '.py']]);
  assert.equal(h.session.getState().dueMs, 5000); assert.deepEqual(h.writes, []);
});

test('Loop suffix-only replacement updates identical caption and stays disabled', options, async () => {
  // Arrange
  const h = harness(); await h.appear({ ...base, executable: '/synthetic/report.py' });
  // Act
  await h.edit({ executable: '/synthetic/report.sh' });
  // Assert
  assert.deepEqual(h.artwork.map(item => [item.caption, item.extension]), [['report', '.py'], ['report', '.sh']]);
  assert.equal(h.session.getState().enabled, false); assert.equal(h.session.getState().dueMs, undefined);
  assert.deepEqual(h.runs, []);
});

for (const executable of ['/synthetic/python3', '']) {
  test('Loop interpreter argv and partial Setup cannot supply suffix metadata', options, async () => {
    // Arrange
    const h = harness();
    // Act
    await h.appear({ ...base, executable, argsText: '/synthetic/report.py' });
    // Assert
    assert.equal(h.artwork.at(-1).extension, undefined);
    assert.equal(h.artwork.at(-1).footer, executable ? 'ready' : 'setup required');
    assert.deepEqual(h.runs, []); assert.deepEqual(h.writes, []);
  });
}

for (const stage of ['ready', 'waiting', 'success']) {
  test(`Loop ${stage} badge theme metadata preserves scheduling and execution`, options, async () => {
    // Arrange
    const h = harness(); await h.appear();
    if (stage !== 'ready') await h.tap();
    if (stage === 'success') await h.finish();
    const before = h.session.getState(), count = h.runs.length;
    // Act
    await h.edit({ themeColor: '#ABCDEF' });
    // Assert
    assert.equal(h.artwork.at(-1).extension, '.sh'); assert.equal(h.artwork.at(-1).theme, '#abcdef');
    assert.equal(h.session.getState().enabled, before.enabled); assert.equal(h.session.getState().dueMs, before.dueMs);
    assert.equal(h.runs.length, count); assert.ok(h.runs.every(run => run.stops === 0));
    assert.deepEqual(h.writes, [{ ...base, themeColor: '#abcdef' }]); assert.deepEqual(errors(h), []);
  });
}

for (const record of ['text:plain', 'progress:45', '<svg>opaque</svg>']) {
  test('Loop producer output has no badge or subsequent Loading flash', options, async () => {
    // Arrange
    const h = harness(); await h.appear(); await h.tap();
    const producer = parseOutputUpdate(record), expected = producer.kind === 'image' ? producer.image : createPrimitiveArtwork(producer);
    // Act
    h.runs[0].callbacks.onUpdate(producer); await h.session.whenIdle(); await h.finish();
    const count = h.artwork.length; await h.advance(5000);
    // Assert
    assert.equal(images(h).at(-1), expected); assert.equal(h.artwork.length, count);
    assert.equal(h.runs.length, 2); assert.equal(svg(expected).includes('>.sh</text>'), false);
  });
}

// Objective: pin the approved one-second contract independently of fixture timing.
// Slice 2: partial setup is disabled, unscheduled, and consumes every setup gesture.
for (const failure of ['display', 'persistence', 'configuration']) {
  test(`Timer Setup gestures cannot recover retained ${failure} Error`, options, async () => {
    // Arrange
    let rejected = false;
    const h = harness(failure === 'display' ? { presentation() { if (!rejected) { rejected = true; throw Error('synthetic display boundary'); } } } : {});
    await h.appear(failure === 'configuration' ? { intervalSeconds: 0 } : {});
    if (failure === 'persistence') await h.session.persistenceFailed();
    if (failure === 'configuration') await h.edit({ intervalSeconds: 1 });
    const before = h.session.getState(), writes = h.writes.length;
    // Act
    await h.tap(); await h.session.keyDown(); await h.advance(1000); await h.session.keyUp(); await h.session.whenIdle();
    // Assert
    assert.equal(before.presentation, 'error'); assert.equal(before.suspended, true);
    assert.deepEqual(h.session.getState(), before); assert.equal(h.writes.length, writes);
    assert.deepEqual(h.runs, []);
    assert.equal(errors(h).at(-1)?.[2], { display: 'FRAME_SEND_FAILED', persistence: 'STATE_SAVE_FAILED', configuration: 'INTERVAL_INVALID' }[failure]);
  });
}
test('unconfirmed Timer setup-to-configured edit cannot publish Ready or launch from consumed gesture', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred();
  const h = harness({ read(host) { entered.resolve(host); return gate.promise; } }); await h.appear({});
  // Act
  await h.session.keyDown(); const editing = h.edit({ executable: base.executable });
  const host = await entered.promise; const before = cards(h).map(card => card[2]);
  const pending = h.session.getState(); const release = h.session.keyUp();
  gate.resolve(host); await Promise.all([editing, release]); await h.session.whenIdle();
  // Assert
  assert.deepEqual(before, ['setup required']); assert.equal(pending.configurationPending, true);
  assert.equal(cards(h).at(-1)?.[2], 'ready'); assert.equal(h.session.getState().enabled, false);
  assert.equal(h.session.getState().dueMs, undefined); assert.deepEqual(h.runs, []);
});
for (const input of [{}, { executable: '' }, { argsText: 'literal', cwd: '/synthetic/work' },
  { args: ['literal'], intervalSeconds: 1, actionOnPress: 'stop', themeColor: 'bad stored theme' }]) {
  for (const at of [0, 999, 1000, 1001]) {
    test(`Timer Setup gesture ${at}ms never enables, launches, schedules, saves or becomes fatal`, options, async () => {
      // Arrange
      const h = harness(); await h.appear(input);
      // Act
      await h.session.keyDown(); await h.session.keyDown(); await h.advance(at);
      await h.session.keyUp(); await h.session.keyUp(); await h.advance(100000000);
      await h.session.appear(input); await h.session.whenIdle();
      // Assert
      assert.ok(cards(h).every(card => card[0] === 'ready' && card[1] === 'DeckForge Commander' && card[2] === 'setup required'));
      assert.ok(cards(h).length > 0); assert.deepEqual(errors(h), []);
      assert.equal(h.session.getState().phase, 'stopped'); assert.equal(h.session.getState().enabled, false);
      assert.equal(h.session.getState().dueMs, undefined); assert.equal(h.session.getState().suspended, false);
      assert.deepEqual(h.runs, []); assert.deepEqual(h.writes, []);
    });
  }
}
for (const at of [0, 999, 1000, 1001]) {
  test(`gesture begun in Setup remains consumed across confirmed configuration at ${at}ms`, options, async () => {
    // Arrange
    const h = harness(); await h.appear({});
    // Act
    await h.session.keyDown(); await h.session.keyDown();
    await h.edit({ executable: base.executable }); await h.advance(at);
    await h.session.keyUp(); await h.session.keyUp(); await h.advance(100000);
    const beforeNextTap = { state: h.session.getState(), count: h.runs.length };
    await h.tap();
    // Assert
    assert.equal(beforeNextTap.count, 0); assert.equal(beforeNextTap.state.enabled, false);
    assert.equal(beforeNextTap.state.dueMs, undefined); assert.equal(beforeNextTap.state.suspended, false);
    assert.ok(cards(h).some(card => card[2] === 'setup required'));
    assert.ok(cards(h).some(card => card[1] === 'program' && card[2] === 'ready'));
    assert.equal(h.runs.length, 1); assert.equal(h.session.getState().enabled, true);
    assert.deepEqual(h.writes, [{ executable: base.executable, argsText: '' }]);
  });
}
test('Timer Setup identical and theme/control-only edits preserve disabled intent and no deadline', options, async () => {
  // Arrange
  const h = harness(); await h.appear({});
  // Act
  await h.session.appear({}); await h.session.applySettings({}); await h.session.whenIdle();
  const hydrationWrites = h.writes.length;
  await h.edit({ themeColor: '#ABCDEF', intervalSeconds: 1, actionOnPress: 'stop' });
  await h.tap(); await h.advance(100000);
  // Assert
  assert.equal(hydrationWrites, 0); assert.deepEqual(h.writes, [{ themeColor: '#abcdef', intervalSeconds: 1, actionOnPress: 'stop' }]);
  assert.deepEqual(cards(h).at(-1), ['ready', 'DeckForge Commander', 'setup required', '#abcdef']);
  assert.equal(h.session.getState().enabled, false); assert.equal(h.session.getState().dueMs, undefined);
  assert.equal(h.session.getState().suspended, false); assert.deepEqual(h.runs, []); assert.deepEqual(errors(h), []);
});
for (const loss of ['hide', 'disconnect']) {
  test(`Timer Setup stays disabled through ${loss}, late gestures and return`, options, async () => {
    // Arrange
    const h = harness(); await h.appear({});
    // Act
    await (loss === 'hide' ? h.session.disappear() : h.session.setConnected(false));
    const drawings = h.events.length; await h.tap(); await h.advance(100000);
    const hiddenDrawings = h.events.length;
    await (loss === 'hide' ? h.session.appear({}) : h.session.setConnected(true)); await h.session.whenIdle();
    // Assert
    assert.equal(hiddenDrawings, drawings); assert.equal(cards(h).at(-1)?.[2], 'setup required');
    assert.equal(h.session.getState().enabled, false); assert.equal(h.session.getState().dueMs, undefined);
    assert.deepEqual(h.runs, []); assert.deepEqual(h.writes, []); assert.deepEqual(errors(h), []);
  });
}
for (const [input, code] of [[{ intervalSeconds: 0 }, 'INTERVAL_INVALID'], [{ actionOnPress: 'Refresh' }, 'ACTION_ON_PRESS_INVALID'],
  [{ argsText: "'unterminated" }, 'ARGS_TEXT_INVALID'], [{ cwd: 'relative' }, 'INVALID_CWD']]) {
  test(`malformed partial Timer configuration remains ${code} Error, not Setup`, options, async () => {
    // Arrange
    const h = harness();
    // Act
    await h.appear(input); await h.tap(); await h.advance(100000);
    // Assert
    assert.equal(errors(h).at(-1)?.[1], 'Invalid settings.'); assert.equal(errors(h).at(-1)?.[2], code);
    assert.equal(h.session.getState().suspended, true); assert.deepEqual(h.runs, []); assert.deepEqual(h.writes, []);
    assert.equal(cards(h).some(card => card[2] === 'setup required'), false);
  });
}
test('Timer hold threshold is exactly 1000ms', options, () => {
  // Arrange
  const expected = 1000;
  // Act
  const actual = TIMER_HOLD_MS;
  // Assert
  assert.equal(actual, expected);
});

// Objective: 999ms remains a policy-specific short press; 1000/1001ms stop
// without a preliminary refresh, even when release precedes timer delivery.
for (const policy of [undefined, 'refresh', 'stop']) {
  for (const stage of ['disabled', 'waiting', 'running']) {
    for (const at of [999, 1000, 1001]) {
      for (const deliver of [false, true]) {
        test(`${policy ?? 'default Refresh'} ${stage} boundary ${at}ms, timer-first=${deliver}`, options, async () => {
          // Arrange
          const h = harness(); await h.appear(policySettings(policy));
          if (stage !== 'disabled') await h.tap();
          if (stage === 'waiting') await h.finish();
          const count = h.runs.length, due = h.session.getState().dueMs;
          // Act
          await h.session.keyDown(); await h.session.keyDown(); await h.advance(at, deliver);
          const beforeRelease = { count: h.runs.length, enabled: h.session.getState().enabled };
          await h.session.keyUp(); await h.session.keyUp(); await h.session.whenIdle();
          const recognized = h.session.getState(); await h.advance(100000);
          // Assert
          const held = at >= 1000;
          const enabled = !held && (stage === 'disabled' || policy !== 'stop');
          const starts = !held && (stage === 'disabled' || (stage === 'waiting' && policy !== 'stop'));
          assert.equal(beforeRelease.count, count);
          assert.equal(beforeRelease.enabled, stage !== 'disabled' && !(held && deliver));
          assert.equal(h.runs.length, count + Number(starts)); assert.equal(recognized.enabled, enabled);
          assert.equal(h.runs[0]?.stops ?? 0, stage === 'running' && !enabled ? 1 : 0);
          assert.equal(recognized.dueMs, !held && stage === 'running' && policy !== 'stop' ? due : undefined);
          assert.deepEqual(h.writes, []);
        });
      }
    }
  }
}

for (const policy of [undefined, 'refresh', 'stop']) {
  for (const at of [999, 1000, 1001]) {
    for (const deliver of [false, true]) {
      test(`${policy ?? 'default Refresh'} starting boundary ${at}ms, timer-first=${deliver}`, options, async () => {
        // Arrange
        const gate = deferred(), entered = deferred();
        const h = harness({ async presentation(kind) { if (kind === 'waiting') { entered.resolve(); await gate.promise; } } });
        await h.appear(policySettings(policy)); void h.session.keyDown(); const launching = h.session.keyUp(); await entered.promise;
        // Act
        const phase = h.session.getState().phase;
        void h.session.keyDown(); h.time.advance(at, deliver);
        const recognized = h.session.keyUp(); gate.resolve();
        await Promise.all([launching, recognized]); await h.session.whenIdle();
        await h.session.keyUp(); await h.advance(100000);
        // Assert
        const enabled = at === 999 && policy !== 'stop';
        assert.equal(phase, 'starting'); assert.equal(h.session.getState().enabled, enabled);
        assert.equal(h.runs.length, Number(enabled)); assert.ok(h.runs.every(run => run.stops === 0));
        assert.equal(h.session.getState().dueMs, undefined); assert.deepEqual(h.writes, []);
      });
    }
  }
}

// Fresh intent and initialization must never write an enabled/runRequested marker.
for (const interval of [undefined, 1, 60, 86400]) {
  test(`fresh Timer is disabled and ready with interval ${String(interval)}`, options, async () => {
    // Arrange
    const h = harness();
    const settings = { executable: base.executable, argsText: '', ...(interval === undefined ? {} : { intervalSeconds: interval }) };
    // Act
    await h.appear(settings); await h.advance(100000000);
    // Assert
    assert.deepEqual(cards(h), [['ready', 'program', 'ready', '#969696']]);
    assert.equal(h.session.getState().enabled, false);
    assert.equal(h.runs.length, 0); assert.deepEqual(h.writes, []);
  });
}

for (const [field, value, code] of [
  ['intervalSeconds', 0, 'INTERVAL_INVALID'], ['intervalSeconds', 86401, 'INTERVAL_INVALID'],
  ['intervalSeconds', 1.5, 'INTERVAL_INVALID'], ['intervalSeconds', '60', 'INTERVAL_INVALID'],
  ['intervalSeconds', null, 'INTERVAL_INVALID'], ['intervalSeconds', true, 'INTERVAL_INVALID'],
  ['executable', 'relative', 'INVALID_EXECUTABLE'], ['cwd', 'relative', 'INVALID_CWD'],
  ['argsText', "'unterminated", 'ARGS_TEXT_INVALID'], ['runRequested', true, 'UNKNOWN_SETTING'],
  ['actionOnPress', 'Refresh', 'ACTION_ON_PRESS_INVALID'], ['actionOnPress', null, 'ACTION_ON_PRESS_INVALID'],
]) {
  test(`invalid configuration ${field}/${String(value)} stays fixed Error and cannot launch`, options, async () => {
    // Arrange
    const h = harness();
    // Act
    await h.appear({ ...base, [field]: value }); await h.tap(); await h.advance(100000);
    // Assert
    assert.equal(h.runs.length, 0); assert.deepEqual(h.writes, []);
    assert.equal(errors(h).at(-1)?.[1], 'Invalid settings.');
    assert.equal(errors(h).at(-1)?.[2], code); assert.equal(h.session.getState().suspended, true);
  });
}

test('initial disconnected state shows nothing and reconnect only restores disabled Ready', options, async () => {
  // Arrange
  const h = harness({ initialConnected: false });
  // Act
  await h.appear(); const before = [...h.events]; await h.tap(); await h.session.setConnected(true); await h.session.whenIdle();
  // Assert
  assert.deepEqual(before, []); assert.equal(h.runs.length, 0);
  assert.deepEqual(cards(h), [['ready', 'program', 'ready', '#969696']]);
  assert.equal(h.session.getState().enabled, false);
});

test('short release enables an immediate launch, not key-down, with literal execution only', options, async () => {
  // Arrange
  const h = harness(); await h.appear({ ...base, argsText: "'two words' '$HOME' '*.png'", cwd: '/synthetic/work' });
  // Act
  await h.session.keyDown(); await h.session.whenIdle(); const before = h.runs.length;
  await h.advance(999, false); await h.session.keyUp(); await h.session.whenIdle();
  // Assert
  assert.equal(before, 0); assert.equal(h.runs.length, 1);
  assert.deepEqual(h.runs[0].execution, { executable: base.executable, args: ['two words', '$HOME', '*.png'], cwd: '/synthetic/work' });
  assert.equal(h.session.getState().enabled, true); assert.equal(h.session.getState().phase, 'running');
  assert.deepEqual(h.writes, []); assert.equal(cards(h).at(-1)?.[0], 'waiting');
});

for (const delivery of ['release-only', 'timer-first']) {
  for (const at of [1000, 1001]) {
    test(`hold ${at}ms (${delivery}) disables once and release cannot start`, options, async () => {
      // Arrange
      const h = harness(); await h.appear(); await h.tap();
      // Act
      await h.session.keyDown(); await h.session.keyDown();
      await h.advance(at, delivery === 'timer-first');
      await h.session.keyUp(); await h.session.keyUp(); await h.session.whenIdle(); await h.advance(100000);
      // Assert
      assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 1);
      assert.equal(h.session.getState().enabled, false); assert.equal(h.session.getState().phase, 'stopped');
      assert.equal(cards(h).at(-1)?.[2], 'ready'); assert.deepEqual(h.writes, []);
    });
  }
}

test('hold while disabled never performs an initial refresh', options, async () => {
  // Arrange
  const h = harness(); await h.appear();
  // Act
  await h.session.keyDown(); await h.advance(TIMER_HOLD_MS); await h.session.keyUp(); await h.session.whenIdle();
  // Assert
  assert.equal(h.runs.length, 0); assert.equal(h.session.getState().enabled, false);
  assert.ok(cards(h).every(card => card[0] === 'ready' && card[2] === 'ready'));
});

test('key-up without down and repeated releases are no-ops', options, async () => {
  // Arrange
  const h = harness(); await h.appear();
  // Act
  await h.session.keyUp(); const before = h.runs.length; await h.tap();
  await h.session.keyUp(); await h.session.keyUp(); await h.session.whenIdle();
  // Assert
  assert.equal(before, 0); assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 0);
});

for (const loss of ['hide', 'disconnect']) {
  test(`${loss} cancels the old gesture; its release/hold callback cannot enable`, options, async () => {
    // Arrange
    const h = harness(); await h.appear(); await h.session.keyDown();
    // Act
    if (loss === 'hide') await h.session.disappear(); else await h.session.setConnected(false);
    await h.advance(TIMER_HOLD_MS); await h.session.setConnected(true); await h.appear(); await h.session.keyUp(); await h.session.whenIdle();
    // Assert
    assert.equal(h.runs.length, 0); assert.equal(h.session.getState().enabled, false);
  });
}

test('running tap disables, safely stops and rejects old output, diagnostics and completion', options, async () => {
  // Arrange
  const h = harness(); await h.appear({ ...base, actionOnPress: 'stop' }); await h.tap(); const old = h.runs[0];
  old.callbacks.onUpdate(image('before')); await h.session.whenIdle();
  // Act
  await h.tap(); const settled = [...h.events];
  old.callbacks.onUpdate(image('stale')); old.callbacks.onDiagnostic('PROCESS_LAUNCH_FAILED');
  old.callbacks.onError('Image protocol error.'); await h.finish(success, old); await h.advance(100000);
  // Assert
  assert.deepEqual(h.events, settled); assert.equal(old.stops, 1); assert.equal(h.runs.length, 1);
  assert.equal(h.session.getState().enabled, false); assert.equal(h.session.getState().protocolBlocked, false);
  assert.equal(cards(h).at(-1)?.[2], 'ready'); assert.ok(cards(h).every(card => card[2] !== 'success'));
});

test('presses during uncertain in-flight cleanup never replace the owned process', options, async () => {
  // Arrange
  const stopped = deferred();
  const h = harness(); await h.appear({ ...base, actionOnPress: 'stop' }); await h.tap();
  h.runs[0].stopGate = stopped;
  // Act
  await h.session.keyDown(); const stopping = h.session.keyUp();
  // S17: exercise busy gestures only after the owned stop boundary has entered.
  await h.runs[0].stopEntered.promise;
  void h.session.keyDown(); void h.session.keyUp();
  const before = h.runs.length; stopped.resolve(true); await stopping; await h.session.whenIdle();
  await h.tap();
  // Assert
  assert.equal(before, 1); assert.equal(h.runs[0].stops, 1); assert.equal(h.runs.length, 2);
  assert.equal(h.session.getState().phase, 'running');
});

for (const failure of ['false', 'reject']) {
  test(`cleanup ${failure} permanently blocks key/settings/wake recovery`, options, async () => {
    // Arrange
    const h = harness(); await h.appear({ ...base, actionOnPress: 'stop' }); await h.tap();
    if (failure === 'false') h.runs[0].stopResult = false;
    else { h.runs[0].stopGate = deferred(); h.runs[0].stopGate.promise.catch(() => {}); }
    // Act
    void h.session.keyDown(); const stopping = h.session.keyUp();
    if (failure === 'reject') h.runs[0].stopGate.reject(new Error('synthetic cleanup boundary'));
    await stopping; await h.session.whenIdle(); await h.tap();
    await h.edit({ executable: '/synthetic/replacement' });
    await h.session.reconcileAvailability(); await h.appear(); await h.advance(100000);
    // Assert
    assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 1);
    assert.equal(h.session.getState().cleanupBlocked, true); assert.equal(h.session.getState().suspended, true);
    assert.equal(errors(h).at(-1)?.[2], 'CLEANUP_BLOCKED');
    assert.ok(cards(h).slice(2).every(card => card[2] !== 'ready'));
  });
}

// Pacing starts after owned done, confirmed configuration and accepted frame drain.
for (const interval of [undefined, 1, 5, 86400]) {
  test(`successful empty run starts a full completion-paced interval ${String(interval)}`, options, async () => {
    // Arrange
    const h = harness(); const settings = { executable: base.executable, argsText: '', ...(interval === undefined ? {} : { intervalSeconds: interval }) };
    await h.appear(settings); await h.tap(); await h.advance(12345);
    // Act
    await h.finish(); const due = h.session.getState().dueMs;
    await h.advance((interval ?? 60) * 1000 - 1); const before = h.runs.length;
    const beforeCards = [...cards(h)]; await h.advance(1);
    // Assert
    assert.equal(due, 12345 + (interval ?? 60) * 1000); assert.equal(before, 1); assert.equal(h.runs.length, 2);
    assert.deepEqual(cards(h), beforeCards); assert.equal(cards(h).at(-1)?.[2], 'success');
    assert.equal(h.runs[0].stops, 0); assert.deepEqual(h.writes, []);
  });
}

test('whenIdle returns for an active process and later for a future deadline', options, async () => {
  // Arrange
  const h = harness(); await h.appear(); await h.tap();
  // Act
  await h.session.whenIdle(); const running = h.session.getState().phase;
  await h.finish(); await h.session.whenIdle();
  // Assert
  assert.equal(running, 'running'); assert.equal(h.session.getState().phase, 'waiting');
  assert.equal(h.runs.length, 1); assert.equal(h.session.getState().dueMs, 5000);
});

test('waiting tap refreshes immediately and the new run gets a full post-completion interval', options, async () => {
  // Arrange
  const h = harness(); await h.appear(); await h.tap(); await h.finish(); await h.advance(2000);
  // Act
  await h.tap(); const before = h.session.getState(); await h.advance(7000); await h.finish();
  const due = h.session.getState().dueMs; await h.advance(4999); const count = h.runs.length; await h.advance(1);
  // Assert
  assert.equal(before.phase, 'running'); assert.equal(due, 14000); assert.equal(count, 2); assert.equal(h.runs.length, 3);
  assert.ok(h.runs.every(run => run.stops === 0));
});

for (const record of ['text:', 'text:hello', 'progress:45|label:Hi', '<svg>producer</svg>', 'data:image/png;base64,aGVsbG8=']) {
  test(`accepted ${record.split(':')[0]} output is retained at completion and throughout next launch`, options, async () => {
    // Arrange
    const h = harness(); await h.appear(); await h.tap(); const update = parseOutputUpdate(record);
    // Act
    h.runs[0].callbacks.onUpdate(update); await h.session.whenIdle(); const displayed = images(h).at(-1);
    const beforeCards = [...cards(h)]; await h.finish(); await h.advance(5000);
    // Assert
    assert.equal(typeof displayed, 'string'); assert.deepEqual(images(h), [displayed]);
    assert.deepEqual(cards(h), beforeCards); assert.equal(h.runs.length, 2);
    assert.equal(h.session.getState().presentation, 'streaming');
  });
}

for (const bad of [undefined, null, { kind: 'text', value: 'bad', options: {}, overrides: {} }, { kind: 'image', image: 'not-image' }]) {
  test(`rejected callback ${String(bad?.kind ?? bad)} cannot count as output or suppress success card`, options, async () => {
    // Arrange
    const h = harness(); await h.appear(); await h.tap();
    // Act
    h.runs[0].callbacks.onUpdate(bad); h.runs[0].callbacks.onUpdate(parseOutputUpdate('   '));
    h.runs[0].callbacks.onUpdate(parseOutputUpdate('progress:nope')); await h.finish();
    // Assert
    assert.deepEqual(images(h), []); assert.equal(cards(h).at(-1)?.[2], 'success');
    assert.equal(h.session.getState().phase, 'waiting'); assert.deepEqual(errors(h), []);
  });
}

test('new run without output shows success instead of counting the previous run frame', options, async () => {
  // Arrange
  const h = harness(); await h.appear(); await h.tap(); h.runs[0].callbacks.onUpdate(image('old'));
  await h.session.whenIdle(); await h.finish(); await h.advance(5000);
  // Act
  await h.finish();
  // Assert
  assert.equal(cards(h).at(-1)?.[2], 'success'); assert.deepEqual(images(h), [image('old').image]);
  assert.equal(h.session.getState().presentation, 'ready'); assert.equal(h.runs.length, 2);
});

test('coalesced final producer drains before scheduling; malformed callbacks and external mutation cannot evict it', options, async () => {
  // Arrange
  const held = deferred(), entered = deferred();
  const h = harness({ async image(value) { if (value === image('A').image) { entered.resolve(); await held.promise; } } });
  await h.appear(); await h.tap(); h.runs[0].callbacks.onUpdate(image('A')); await entered.promise;
  const record = structuredClone(parseOutputUpdate('text:final|color:red')); const expected = createPrimitiveArtwork(record);
  // Act
  for (let index = 0; index < 100; index++) h.runs[0].callbacks.onUpdate(image(`intermediate-${index}`));
  h.runs[0].callbacks.onUpdate(record); record.value = 'mutated'; record.options.color = '#000000';
  h.runs[0].callbacks.onUpdate(parseOutputUpdate('text:bad|background:transparent'));
  h.runs[0].callbacks.onUpdate({ kind: 'text', value: 'bad', options: {}, overrides: {} });
  h.runs[0].done.resolve(success); await Promise.resolve();
  h.time.advance(8000); const before = h.session.getState();
  held.resolve(); await h.session.whenIdle();
  // Assert
  assert.equal(before.dueMs, undefined); assert.equal(before.phase, 'stopping');
  assert.deepEqual(images(h), [image('A').image, expected]); assert.equal(h.session.getState().dueMs, 13000);
  assert.equal(h.runs.length, 1); assert.deepEqual(errors(h), []);
});

test('accessor and proxy output callbacks do not execute user code or replace the latest valid frame', options, async () => {
  // Arrange
  const h = harness(); await h.appear(); await h.tap(); let invoked = 0;
  const accessor = { get kind() { invoked++; throw new Error('synthetic accessor'); } };
  const proxy = new Proxy({}, { ownKeys() { invoked++; throw new Error('synthetic proxy'); } });
  // Act
  h.runs[0].callbacks.onUpdate(image('safe')); h.runs[0].callbacks.onUpdate(accessor); h.runs[0].callbacks.onUpdate(proxy);
  await h.session.whenIdle(); await h.finish();
  // Assert
  assert.equal(invoked, 0); assert.deepEqual(images(h), [image('safe').image]); assert.deepEqual(errors(h), []);
});

for (const terminal of ['success', 'nonzero', 'signal', 'protocol']) {
  test(`${terminal} preserves pending producer beneath declined terminal cosmetic redraw`, options, async () => {
    // Arrange
    const held = deferred(), entered = deferred();
    const h = harness({ async image(value) { if (value === image('A').image) { entered.resolve(); await held.promise; } } });
    await h.appear(); await h.tap(); h.runs[0].callbacks.onUpdate(image('A')); await entered.promise;
    const record = parseOutputUpdate('progress:42|label:B;value-color:accent;label-color:accent'); const expected = createPrimitiveArtwork(record);
    h.runs[0].callbacks.onUpdate(record);
    // Act
    const recolor = h.edit({ themeColor: '#abcdef' });
    // applySettings synchronously adopts the new cosmetic revision before done.
    const run = h.runs[0];
    if (terminal === 'nonzero' || terminal === 'signal') run.callbacks.onDiagnostic(terminal === 'signal' ? 'PROCESS_TERMINATED_BY_SIGNAL' : 'PROCESS_EXITED_NONZERO');
    if (terminal === 'protocol') run.callbacks.onError('Image protocol error.');
    run.done.resolve(terminal === 'success' ? success : { status: 'error', error: terminal === 'protocol' ? 'Image protocol error.' : ordinaryError });
    await Promise.resolve(); const before = [...images(h)]; held.resolve(); await recolor; await h.session.whenIdle();
    // Assert
    assert.deepEqual(before, [image('A').image]); assert.deepEqual(images(h).slice(0, 2), [image('A').image, expected]);
    assert.equal(h.runs.length, 1);
    if (terminal === 'success') {
      assert.equal(h.session.getState().phase, 'waiting'); assert.ok(svg(images(h).at(-1)).includes('#abcdef'));
    } else {
      assert.equal(images(h).length, 2); assert.equal(errors(h).at(-1)?.[1], terminal === 'protocol' ? 'Image protocol error.' : ordinaryError);
      assert.equal(h.session.getState().suspended, terminal === 'protocol');
    }
  });
}

test('cosmetic image already attempted is consumed once and never duplicates its producer on success', options, async () => {
  // Arrange
  const first = deferred(), firstEntered = deferred(), cosmetic = deferred(), cosmeticEntered = deferred();
  const h = harness({ async image(value) {
    if (value === image('A').image) { firstEntered.resolve(); await first.promise; }
    else { cosmeticEntered.resolve(); await cosmetic.promise; }
  } });
  await h.appear(); await h.tap(); h.runs[0].callbacks.onUpdate(image('A')); await firstEntered.promise;
  h.runs[0].callbacks.onUpdate(parseOutputUpdate('text:B'));
  // Act
  const recolor = h.edit({ themeColor: '#abcdef' }); first.resolve(); await cosmeticEntered.promise;
  h.runs[0].done.resolve(success); await Promise.resolve(); cosmetic.resolve(); await recolor; await h.session.whenIdle();
  // Assert
  assert.equal(images(h).length, 2); assert.ok(svg(images(h)[1]).includes('#abcdef'));
  assert.equal(h.session.getState().phase, 'waiting'); assert.equal(h.runs.length, 1);
});

for (const newer of ['primitive', 'opaque']) {
  test(`newer ${newer} evicts cosmetic fallback and is the sole final producer`, options, async () => {
    // Arrange
    const held = deferred(), entered = deferred();
    const h = harness({ async image(value) { if (value === image('A').image) { entered.resolve(); await held.promise; } } });
    await h.appear(); await h.tap(); h.runs[0].callbacks.onUpdate(image('A')); await entered.promise;
    h.runs[0].callbacks.onUpdate(parseOutputUpdate('text:B'));
    // Act
    const recolor = h.edit({ themeColor: '#abcdef' });
    const latest = newer === 'opaque' ? image('C') : parseOutputUpdate('text:C|color:red');
    h.runs[0].callbacks.onUpdate(latest); h.runs[0].done.resolve(success); await Promise.resolve();
    held.resolve(); await recolor; await h.session.whenIdle();
    // Assert
    assert.deepEqual(images(h), [image('A').image, newer === 'opaque' ? latest.image : createPrimitiveArtwork(latest)]);
    assert.equal(h.session.getState().phase, 'waiting');
  });
}

for (const loss of ['manual', 'execution', 'hide', 'disconnect', 'persistence']) {
  test(`${loss} invalidates pending display ownership without an old final overwrite`, options, async () => {
    // Arrange
    const held = deferred(), entered = deferred();
    const h = harness({ async image(value) { if (value === image('A').image) { entered.resolve(); await held.promise; } } });
    await h.appear({ ...base, ...(loss === 'manual' ? { actionOnPress: 'stop' } : {}) }); await h.tap(); h.runs[0].callbacks.onUpdate(image('A')); await entered.promise;
    h.runs[0].callbacks.onUpdate(parseOutputUpdate('text:B'));
    // Act
    const recolor = h.edit({ themeColor: '#abcdef' }); let transition;
    if (loss === 'manual') { void h.session.keyDown(); transition = h.session.keyUp(); }
    if (loss === 'execution') transition = h.edit({ executable: '/synthetic/new' });
    if (loss === 'hide') transition = h.session.disappear();
    if (loss === 'disconnect') transition = h.session.setConnected(false);
    if (loss === 'persistence') transition = h.session.persistenceFailed();
    held.resolve(); await Promise.all([recolor, transition]); await h.session.whenIdle();
    // Assert
    assert.deepEqual(images(h), [image('A').image]); assert.equal(h.runs.length, 1);
    assert.equal(h.runs[0].stops, loss === 'hide' ? 0 : 1);
  });
}

// Classified failures retry; launch/protocol/display/unknown failures are suspended.
test('Loop rejects unresolved accent/obsolete DTOs without evicting eligible pending output', options, async () => {
  // Arrange - Use the real callback snapshot and bounded display queue.
  const gate = deferred(), entered = deferred();
  const first = image('first');
  const h = harness({ async image(value) { if (value === first.image) { entered.resolve(); await gate.promise; } } });
  await h.appear(); await h.tap(); h.runs[0].callbacks.onUpdate(first); await entered.promise;
  const final = parseOutputUpdate('progress:42|label:Hi;value-color:accent;label-color:accent');
  // Act
  h.runs[0].callbacks.onUpdate(final);
  for (const changes of [{ 'value-color': 'accent' }, { annotationColor: '#ffffff' }, { size: 80 }, { foreground: 'theme' }]) {
    h.runs[0].callbacks.onUpdate({ ...final, options: { ...final.options, ...changes } });
  }
  h.runs[0].done.resolve(success); await Promise.resolve(); gate.resolve(); await h.session.whenIdle();
  // Assert
  assert.deepEqual(images(h), [first.image, createPrimitiveArtwork(final)]);
  assert.equal(h.session.getState().dueMs, 5000); assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0].stops, 0); assert.deepEqual(errors(h), []);
});

for (const diagnostic of ['PROCESS_EXITED_NONZERO', 'PROCESS_TERMINATED_BY_SIGNAL']) {
  for (const withOutput of [false, true]) {
    test(`${diagnostic} with output=${withOutput} keeps Error during full-delay retry until new output`, options, async () => {
      // Arrange
      const h = harness(); await h.appear(); await h.tap();
      if (withOutput) { h.runs[0].callbacks.onUpdate(image('before-error')); await h.session.whenIdle(); }
      // Act
      h.runs[0].callbacks.onDiagnostic(diagnostic); h.runs[0].callbacks.onError(ordinaryError);
      await h.finish({ status: 'error', error: ordinaryError }); const shown = [...h.events];
      await h.advance(4999); const before = h.runs.length; await h.advance(1); const retry = [...h.events];
      h.runs[1].callbacks.onUpdate(image('recovered')); await h.session.whenIdle();
      // Assert
      assert.equal(before, 1); assert.equal(h.runs.length, 2); assert.deepEqual(retry, shown);
      assert.equal(errors(h).at(-1)?.[2], diagnostic); assert.equal(h.session.getState().suspended, false);
      assert.equal(images(h).at(-1), image('recovered').image); assert.equal(h.session.getState().presentation, 'streaming');
    });
  }
}

test('ordinary retry without output replaces Error with success only after new terminal success', options, async () => {
  // Arrange
  const h = harness(); await h.appear(); await h.tap(); h.runs[0].callbacks.onDiagnostic('PROCESS_EXITED_NONZERO');
  await h.finish({ status: 'error', error: ordinaryError }); await h.advance(5000);
  // Act
  const before = h.session.getState().presentation; await h.finish();
  // Assert
  assert.equal(before, 'error'); assert.equal(cards(h).at(-1)?.[2], 'success');
  assert.equal(h.session.getState().dueMs, 10000); assert.equal(h.session.getState().suspended, false);
});

for (const kind of ['unclassified', 'unknown-message', 'rejected-done', 'stopped-without-intent']) {
  test(`${kind} terminal failure fails closed without automatic retry`, options, async () => {
    // Arrange
    const h = harness(); await h.appear(); await h.tap();
    // Act
    if (kind === 'rejected-done') { h.runs[0].done.reject(new Error('synthetic done')); await Promise.resolve(); await h.session.whenIdle(); }
    else await h.finish(kind === 'stopped-without-intent' ? { status: 'stopped' }
      : { status: 'error', error: kind === 'unknown-message' ? 'synthetic unknown error' : ordinaryError });
    await h.advance(100000);
    // Assert
    assert.equal(h.runs.length, 1); assert.equal(h.session.getState().suspended, true);
    assert.equal(h.session.getState().dueMs, undefined); assert.equal(errors(h).at(-1)?.[1], ordinaryError);
    assert.equal(JSON.stringify(errors(h)).includes('synthetic unknown'), false);
  });
}

for (const reason of ['ENOENT', 'EACCES', 'ENOTDIR', 'ENOEXEC', 'EAGAIN', 'EINVAL', 'UNKNOWN']) {
  test(`launch ${reason} suspends with fixed diagnostic and deliberate valid press retries`, options, async () => {
    // Arrange
    const h = harness(); await h.appear(); await h.tap();
    // Act
    h.runs[0].callbacks.onDiagnostic(`PROCESS_LAUNCH_REASON_${reason}`);
    h.runs[0].callbacks.onDiagnostic('PROCESS_LAUNCH_FAILED');
    await h.finish({ status: 'error', error: 'Program launch failed.' }); await h.advance(100000);
    const count = h.runs.length, blocked = h.session.getState().suspended, code = errors(h).at(-1)?.[2];
    await h.tap();
    // Assert
    assert.equal(count, 1); assert.equal(blocked, true); assert.equal(code, `PROCESS_LAUNCH_REASON_${reason}`);
    assert.equal(h.runs.length, 2); assert.equal(h.session.getState().suspended, false);
  });
}

test('synchronous runner launch exception is fixed Error, not leaked, and never retries automatically', options, async () => {
  // Arrange
  const h = harness({ start() { throw new Error('synthetic-sensitive-marker'); } }); await h.appear();
  // Act
  await h.tap(); await h.advance(100000);
  // Assert
  assert.equal(errors(h).at(-1)?.[1], 'Program launch failed.'); assert.equal(errors(h).at(-1)?.[2], 'PROCESS_LAUNCH_FAILED');
  assert.equal(h.session.getState().suspended, true); assert.equal(JSON.stringify(h.events).includes('synthetic-sensitive-marker'), false);
});

test('protocol error outranks exit/launch errors and cannot publish before owned cleanup completes', options, async () => {
  // Arrange
  const h = harness(); await h.appear(); await h.tap(); const run = h.runs[0];
  run.callbacks.onUpdate(image('prior')); await h.session.whenIdle();
  // Act
  run.callbacks.onError('Image protocol error.'); run.callbacks.onDiagnostic('PROCESS_EXITED_NONZERO');
  run.callbacks.onError(ordinaryError); run.callbacks.onError('Program launch failed.');
  await h.session.reconcileAvailability(); const before = [...errors(h)];
  await h.finish({ status: 'error', error: ordinaryError }); await h.advance(100000);
  const latched = h.session.getState().protocolBlocked; await h.tap();
  // Assert
  assert.deepEqual(before, []); assert.equal(errors(h).at(-1)?.[2], 'IMAGE_PROTOCOL_ERROR');
  assert.equal(latched, true); assert.equal(h.runs.length, 2); assert.equal(h.session.getState().protocolBlocked, false);
});

for (const boundary of ['image', 'title', 'presentation']) {
  test(`${boundary} failure suspends and safe deliberate retry does not bypass cleanup`, options, async () => {
    // Arrange
    let fail = true;
    const throwing = async () => { if (fail) throw new Error('synthetic SDK failure'); };
    const h = harness({ [boundary]: boundary === 'presentation' ? async kind => { if (kind === 'waiting') await throwing(); } : throwing });
    await h.appear(); await h.tap();
    // Act
    if (boundary !== 'presentation') h.runs[0].callbacks.onUpdate(image('failure'));
    await h.session.whenIdle(); await h.advance(100000);
    const count = h.runs.length, blocked = h.session.getState().suspended;
    fail = false; await h.tap();
    // Assert
    assert.equal(blocked, true); assert.equal(errors(h).at(-1)?.[2], 'FRAME_SEND_FAILED');
    assert.equal(h.runs.length, count + 1); assert.equal(h.session.getState().suspended, false);
    if (boundary !== 'presentation') assert.equal(h.runs[0].stops, 1);
  });
}

for (const mutation of ['interval', 'theme']) {
  test(`fatal protocol Error survives ${mutation} edits without clearing or enabling retries`, options, async () => {
    // Arrange
    const h = harness(); await h.appear(); await h.tap(); h.runs[0].callbacks.onError('Image protocol error.');
    await h.finish({ status: 'error', error: 'Image protocol error.' });
    // Act
    await h.edit(mutation === 'interval' ? { intervalSeconds: 1 } : { themeColor: '#abcdef' });
    await h.session.reconcileAvailability(); await h.advance(100000);
    // Assert
    assert.equal(h.runs.length, 1); assert.equal(h.session.getState().protocolBlocked, true);
    assert.equal(h.session.getState().suspended, true); assert.equal(errors(h).at(-1)?.[2], 'IMAGE_PROTOCOL_ERROR');
  });
}

// Authoritative configuration can be pending or superseded; a latest failure is permanent.
test('pending initial configuration prevents Ready and launch until authoritative match', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred();
  const h = harness({ async confirm() { entered.resolve(); return gate.promise; } });
  h.coordinator.observe(base); const appearing = h.session.appear(base); await entered.promise;
  // Act
  void h.session.keyDown(); void h.session.keyUp();
  const before = { count: h.runs.length, events: [...h.events], state: h.session.getState() };
  gate.resolve(true); await appearing; await h.session.whenIdle();
  // Assert
  assert.equal(before.count, 0); assert.deepEqual(before.events, []); assert.equal(before.state.configurationPending, true);
  assert.equal(h.runs.length, 1); assert.equal(h.session.getState().configurationPending, false); assert.deepEqual(h.writes, []);
});

for (const failure of ['false', 'reject']) {
  test(`latest initial authority ${failure} permanently blocks launch and all recovery`, options, async () => {
    // Arrange
    const h = harness({ async confirm() { if (failure === 'reject') throw new Error('synthetic authority'); return false; } });
    // Act
    await h.appear(); await h.tap(); await h.edit({ executable: '/synthetic/new', intervalSeconds: 1 });
    await h.session.setConnected(false); await h.session.setConnected(true); await h.appear(); await h.advance(100000);
    // Assert
    assert.equal(h.runs.length, 0); assert.equal(h.session.getState().persistenceBlocked, true);
    assert.equal(errors(h).at(-1)?.[2], 'STATE_SAVE_FAILED'); assert.deepEqual(cards(h), []);
  });
}

for (const oldResult of ['false', 'reject']) {
  test(`obsolete configuration ${oldResult} is ignored when the latest complete snapshot is confirmed`, options, async () => {
    // Arrange
    const old = deferred(), entered = deferred();
    const h = harness({ async confirm(expected) {
      if (expected.intervalSeconds === 5) { entered.resolve(); return old.promise; }
      return true;
    } });
    h.coordinator.observe(base); const appearing = h.session.appear(base); await entered.promise;
    // Act
    const edited = h.edit({ intervalSeconds: 10 });
    if (oldResult === 'reject') old.reject(new Error('synthetic stale authority')); else old.resolve(false);
    await appearing; await edited; await h.tap(); await h.finish();
    // Assert
    assert.equal(h.session.getState().persistenceBlocked, false); assert.equal(h.runs.length, 1);
    assert.equal(h.session.getState().dueMs, 10000); assert.deepEqual(errors(h), []);
  });
}

for (const storageFailure of ['write', 'read', 'mismatch', 'timeout']) {
  test(`real configuration authority ${storageFailure} uncertainty blocks Timer permanently`, options, async () => {
    // Arrange
    const never = deferred(), entered = deferred();
    const h = harness({
      ...(storageFailure === 'write' ? { write() { throw new Error('synthetic write'); } } : {}),
      ...(storageFailure === 'read' ? { read() { throw new Error('synthetic read'); } } : {}),
      ...(storageFailure === 'mismatch' ? { read() { return base; } } : {}),
      ...(storageFailure === 'timeout' ? { async write() { entered.resolve(); await never.promise; } } : {}),
    });
    await h.appear(); await h.tap();
    // Act
    const editing = h.edit({ intervalSeconds: 10 });
    if (storageFailure === 'timeout') { await entered.promise; h.time.advance(5000); }
    await editing; await h.tap(); await h.session.reconcileAvailability(); await h.advance(100000);
    // Assert
    assert.equal(h.coordinator.isBlocked(), true); assert.equal(h.session.getState().persistenceBlocked, true);
    assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 1); assert.equal(errors(h).at(-1)?.[2], 'STATE_SAVE_FAILED');
    assert.equal(h.writes.length, 1);
  });
}

test('explicit persistence failure cancels retry and stops even a hidden active owner', options, async () => {
  // Arrange
  const h = harness(); await h.appear(); await h.tap(); await h.session.disappear();
  // Act
  await h.session.persistenceFailed(); await h.session.whenIdle(); const hidden = [...h.events];
  await h.appear(); await h.tap(); await h.advance(100000);
  // Assert
  assert.equal(h.runs[0].stops, 1); assert.equal(h.runs.length, 1);
  assert.equal(errors(h).at(-1)?.[2], 'STATE_SAVE_FAILED'); assert.equal(h.session.getState().persistenceBlocked, true);
  assert.equal(hidden.some(event => event[0] === 'error'), false);
});

for (const edit of [{ executable: '/synthetic/new' }, { argsText: "'new literal'" }, { cwd: '/synthetic/work' }]) {
  test(`meaningful ${Object.keys(edit)[0]} edit disables, safely confirms and shows Ready without automatic launch`, options, async () => {
    // Arrange
    const h = harness(); await h.appear(); await h.tap(); const old = h.runs[0];
    // Act
    await h.edit(edit); old.callbacks.onUpdate(image('stale')); old.callbacks.onError('Image protocol error.');
    old.callbacks.onDiagnostic('PROCESS_LAUNCH_FAILED'); await h.finish(success, old); await h.advance(100000);
    const disabled = h.session.getState().enabled; const count = h.runs.length; await h.tap();
    // Assert
    assert.equal(old.stops, 1); assert.equal(disabled, false); assert.equal(count, 1); assert.equal(h.runs.length, 2);
    assert.equal(h.writes.length, 1); assert.ok(!Object.hasOwn(h.writes[0], 'enabled') && !Object.hasOwn(h.writes[0], 'runRequested'));
    assert.equal(cards(h).at(-2)?.[2], 'ready'); assert.deepEqual(errors(h), []); assert.deepEqual(images(h), []);
  });
}

test('confirmed execution edit clears recoverable protocol latch but never auto-launches', options, async () => {
  // Arrange
  const h = harness(); await h.appear(); await h.tap(); h.runs[0].callbacks.onError('Image protocol error.');
  await h.finish({ status: 'error', error: 'Image protocol error.' });
  // Act
  await h.edit({ executable: '/synthetic/recovered' }); await h.advance(100000);
  // Assert
  assert.equal(h.session.getState().protocolBlocked, false); assert.equal(h.session.getState().suspended, false);
  assert.equal(h.session.getState().enabled, false); assert.equal(h.runs.length, 1); assert.equal(cards(h).at(-1)?.[2], 'ready');
});

test('invalid execution edit stops owner and stays fixed Error, never Ready or replacement', options, async () => {
  // Arrange
  const h = harness(); await h.appear(); await h.tap();
  // Act
  await h.edit({ argsText: "'unterminated" }); await h.tap(); await h.advance(100000);
  // Assert
  assert.equal(h.runs[0].stops, 1); assert.equal(h.runs.length, 1); assert.equal(h.session.getState().enabled, false);
  assert.equal(errors(h).at(-1)?.[2], 'ARGS_TEXT_INVALID'); assert.equal(cards(h).at(-1)?.[0], 'waiting');
});

test('running interval edit never interrupts and the completed run uses the new full interval', options, async () => {
  // Arrange
  const h = harness(); await h.appear(); await h.tap();
  // Act
  await h.edit({ intervalSeconds: 10 }); await h.advance(7000); const running = h.session.getState().phase;
  await h.finish();
  // Assert
  assert.equal(running, 'running'); assert.equal(h.runs[0].stops, 0); assert.equal(h.runs.length, 1);
  assert.equal(h.session.getState().enabled, true); assert.equal(h.session.getState().dueMs, 17000);
});

test('idle interval edit resets a full period only after save confirmation, not the edit time', options, async () => {
  // Arrange
  const saved = deferred(), entered = deferred();
  const h = harness({ async write() { entered.resolve(); await saved.promise; } });
  await h.appear(); await h.tap(); await h.finish(); await h.advance(2000);
  // Act
  const editing = h.edit({ intervalSeconds: 10 }); await entered.promise;
  h.time.advance(3000); const before = { runs: h.runs.length, state: h.session.getState() };
  saved.resolve(); await editing; const due = h.session.getState().dueMs;
  await h.advance(9999); const count = h.runs.length; await h.advance(1);
  // Assert
  assert.equal(before.runs, 1); assert.equal(before.state.configurationPending, true);
  assert.equal(before.state.dueMs, undefined); assert.equal(due, 15000); assert.equal(count, 1); assert.equal(h.runs.length, 2);
});

for (const changes of [{ intervalSeconds: 60 }, { argsText: "'two words' literal" }, { themeColor: '#abcdef' }]) {
  test(`equivalent default/migration or cosmetic edit ${Object.keys(changes)[0]} preserves enabled deadline`, options, async () => {
    // Arrange
    const h = harness(); await h.appear({ executable: base.executable, args: ['two words', 'literal'] });
    await h.tap(); await h.finish(); await h.advance(2000); const due = h.session.getState().dueMs;
    // Act
    await h.edit(changes); await h.session.applySettings(h.coordinator.getSettings()); await h.session.whenIdle();
    // Assert
    assert.equal(h.session.getState().dueMs, due); assert.equal(h.session.getState().enabled, true);
    assert.equal(h.runs[0].stops, 0); assert.equal(h.runs.length, 1);
  });
}

// Slice 1: both running and retained Loop records keep symbolic annotations across cosmetics.
for (const stage of ['running', 'completed']) {
  for (const fill of ['', ';color:red']) {
    for (const [annotation, expected] of [
      ['', ['#ffffff', '#ffffff']],
      [';value-color:accent', [fill ? '#ff0000' : '#abcdef', '#ffffff']],
      [';label-color:accent', ['#ffffff', fill ? '#ff0000' : '#abcdef']],
      [';value-color:accent;label-color:accent', Array(2).fill(fill ? '#ff0000' : '#abcdef')],
      [';value-color:ivory;label-color:blue', ['#fffff0', '#0000ff']],
    ]) {
      test(`Loop ${stage} redraw ${fill || 'implicit'} ${annotation || 'white'} does not move deadline`, options, async () => {
        // Arrange
        const h = harness(); await h.appear(); await h.tap();
        const record = parseOutputUpdate(`progress:42|label:Hi;border:2${fill}${annotation}`);
        h.runs[0].callbacks.onUpdate(record); await h.session.whenIdle();
        if (stage === 'completed') await h.finish();
        const due = h.session.getState().dueMs, before = JSON.stringify(record);
        // Act
        await h.edit({ themeColor: '#abcdef' }); const rendered = svg(images(h).at(-1));
        // Assert
        assert.deepEqual([...rendered.matchAll(/<text\b[^>]*fill="([^"]*)"/g)].map(match => match[1]), expected);
        assertSvgElement(rendered, 'rect', { stroke: '#abcdef' }, { 'stroke-width': 2 });
        assert.equal(h.session.getState().dueMs, due); assert.equal(h.session.getState().enabled, true);
        assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 0);
        assert.equal(JSON.stringify(record), before);
      });
    }
  }
}

for (const explicit of [false, true]) {
  for (const stage of ['running', 'completed', 'next-run']) {
    test(`${stage} primitive theme redraw respects explicit=${explicit} and preserves scheduling/intent`, options, async () => {
      // Arrange
      const h = harness(); await h.appear(); await h.tap();
      const record = parseOutputUpdate(`progress:45|scale:100;label:Hi;${explicit ? 'value-color:red;label-color:blue' : 'value-color:accent;label-color:accent'}`);
      h.runs[0].callbacks.onUpdate(record); await h.session.whenIdle();
      if (stage !== 'running') await h.finish();
      if (stage === 'next-run') await h.advance(5000);
      const due = h.session.getState().dueMs, count = h.runs.length;
      // Act
      await h.edit({ themeColor: '#abcdef' }); const rendered = svg(images(h).at(-1));
      // Assert
      assert.ok(rendered.includes('#abcdef'));
      if (explicit) { assert.ok(rendered.includes('fill="#ff0000"')); assert.ok(rendered.includes('fill="#0000ff"')); }
      else assert.ok(rendered.includes('fill="#abcdef"'));
      assert.equal(h.session.getState().dueMs, due); assert.equal(h.session.getState().enabled, true);
      assert.equal(h.runs.length, count); assert.ok(h.runs.every(run => run.stops === 0));
      assert.equal(record.options.color, '#969696');
    });
  }
}

test('opaque producer images never replay on cosmetic edit or refresh, only on visibility restoration', options, async () => {
  // Arrange
  const h = harness(); await h.appear(); await h.tap(); h.runs[0].callbacks.onUpdate(image('opaque')); await h.session.whenIdle(); await h.finish();
  // Act
  await h.edit({ themeColor: '#abcdef' }); await h.session.refreshAppearance(); await h.session.whenIdle();
  const before = [...images(h)]; await h.session.disappear(); await h.appear();
  // Assert
  assert.deepEqual(before, [image('opaque').image]); assert.deepEqual(images(h), [image('opaque').image, image('opaque').image]);
  assert.equal(h.session.getState().dueMs, 5000); assert.equal(h.runs.length, 1);
});

// Disappearance pauses future work but does not stop an already owned process.
for (const returningAt of [2000, 5000, 30000]) {
  test(`hidden waiting session returning at ${returningAt}ms resumes remainder or exactly one overdue run`, options, async () => {
    // Arrange
    const h = harness(); await h.appear(); await h.tap(); await h.finish(); const due = h.session.getState().dueMs;
    await h.session.disappear(); const hiddenEvents = [...h.events];
    // Act
    await h.advance(returningAt); const before = h.runs.length; await h.appear();
    await h.appear(); await h.session.reconcileAvailability(); await h.session.setConnected(true); await h.session.whenIdle();
    const returned = h.runs.length;
    if (returningAt < 5000) await h.advance(5000 - returningAt);
    // Assert
    assert.equal(before, 1); assert.equal(returned, returningAt < 5000 ? 1 : 2); assert.equal(h.runs.length, 2);
    assert.equal(h.runs[0].stops, 0); assert.equal(due, 5000); assert.equal(h.session.getState().enabled, true);
    assert.equal(hiddenEvents.filter(event => event[0] === 'waiting').length, 1);
  });
}

for (const terminal of ['success', 'ordinary', 'protocol']) {
  test(`active hidden run ${terminal} still validates/retains output and finishes without outgoing display`, options, async () => {
    // Arrange
    const h = harness(); await h.appear(); await h.tap(); await h.session.disappear(); const hidden = [...h.events];
    // Act
    h.runs[0].callbacks.onUpdate(image('hidden-final'));
    h.runs[0].callbacks.onUpdate({ kind: 'image', image: 'bad' });
    if (terminal === 'ordinary') h.runs[0].callbacks.onDiagnostic('PROCESS_EXITED_NONZERO');
    if (terminal === 'protocol') h.runs[0].callbacks.onError('Image protocol error.');
    await h.finish(terminal === 'success' ? success : { status: 'error', error: terminal === 'protocol' ? 'Image protocol error.' : ordinaryError });
    const hiddenDone = [...h.events]; await h.advance(1000); await h.appear();
    // Assert
    assert.deepEqual(hiddenDone, hidden); assert.equal(h.runs[0].stops, 0); assert.equal(h.runs.length, 1);
    if (terminal === 'success') { assert.deepEqual(images(h), [image('hidden-final').image]); assert.equal(h.session.getState().dueMs, 5000); }
    else { assert.deepEqual(images(h), []); assert.equal(errors(h).at(-1)?.[1], terminal === 'protocol' ? 'Image protocol error.' : ordinaryError); }
    assert.equal(h.session.getState().suspended, terminal === 'protocol');
  });
}

test('active hidden return restores latest output without stopping or restarting owner', options, async () => {
  // Arrange
  const h = harness(); await h.appear(); await h.tap(); h.runs[0].callbacks.onUpdate(image('before-hide')); await h.session.whenIdle();
  // Act
  await h.session.disappear(); h.runs[0].callbacks.onUpdate(image('latest-hidden')); await h.session.whenIdle();
  const before = [...images(h)]; await h.appear(); await h.appear(); await h.session.reconcileAvailability(); await h.session.whenIdle();
  // Assert
  assert.deepEqual(before, [image('before-hide').image]); assert.deepEqual(images(h), [image('before-hide').image, image('latest-hidden').image]);
  assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 0); assert.equal(h.session.getState().phase, 'running');
});

test('starting configuration gate invalidated by hide never spawns hidden and returns once', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred();
  const h = harness({ async confirm() { entered.resolve(); return gate.promise; } });
  h.coordinator.observe(base); const appearing = h.session.appear(base); await entered.promise;
  void h.session.keyDown(); void h.session.keyUp();
  // Act
  const hiding = h.session.disappear(); gate.resolve(true); await appearing; await hiding; await h.session.whenIdle();
  const hiddenCount = h.runs.length; await h.appear(); await h.appear(); await h.session.whenIdle();
  // Assert
  assert.equal(hiddenCount, 0); assert.equal(h.runs.length, 1); assert.equal(h.session.getState().enabled, true);
});

for (const invalidate of ['hide', 'disable', 'disconnect']) {
  test(`stalled Loading handoff plus ${invalidate} cannot spawn an obsolete generation`, options, async () => {
    // Arrange
    const held = deferred(), entered = deferred();
    const h = harness({ async presentation(kind) { if (kind === 'waiting') { entered.resolve(); await held.promise; } } });
    await h.appear({ ...base, ...(invalidate === 'disable' ? { actionOnPress: 'stop' } : {}) }); void h.session.keyDown(); const launching = h.session.keyUp(); await entered.promise;
    // Act
    let transition;
    if (invalidate === 'hide') transition = h.session.disappear();
    if (invalidate === 'disconnect') transition = h.session.setConnected(false);
    if (invalidate === 'disable') { void h.session.keyDown(); transition = h.session.keyUp(); }
    held.resolve(); await launching; await transition; await h.session.whenIdle();
    const before = h.runs.length;
    if (invalidate === 'hide') { await h.appear(); await h.session.whenIdle(); }
    // Assert
    assert.equal(before, 0); assert.equal(h.runs.length, invalidate === 'hide' ? 1 : 0);
    assert.equal(h.session.getState().enabled, invalidate === 'hide');
  });
}

for (const hidden of [false, true]) {
  test(`disconnect active owner hidden=${hidden} disables and reconnect/wake never auto-enables`, options, async () => {
    // Arrange
    const h = harness(); await h.appear(); await h.tap(); if (hidden) await h.session.disappear();
    // Act
    await h.session.setConnected(false); await h.session.whenIdle(); await h.advance(100000);
    await h.session.setConnected(true); await h.appear(); await h.session.reconcileAvailability(); await h.session.whenIdle();
    // Assert
    assert.equal(h.runs[0].stops, 1); assert.equal(h.runs.length, 1); assert.equal(h.session.getState().enabled, false);
    assert.equal(h.session.getState().dueMs, undefined); assert.equal(cards(h).at(-1)?.[2], 'ready');
  });
}

test('disconnect while waiting cancels due and never resumes from old intent', options, async () => {
  // Arrange
  const h = harness(); await h.appear(); await h.tap(); await h.finish();
  // Act
  await h.session.setConnected(false); await h.advance(100000); await h.session.setConnected(true);
  await h.session.reconcileAvailability(); await h.session.whenIdle();
  // Assert
  assert.equal(h.runs.length, 1); assert.equal(h.session.getState().enabled, false); assert.equal(h.session.getState().dueMs, undefined);
});

test('independent Timer keys and fresh instances never share enabled intent, output or deadlines', options, async () => {
  // Arrange
  const first = harness(), second = harness(); await first.appear(); await second.appear(); await first.tap();
  first.runs[0].callbacks.onUpdate(image('first')); await first.session.whenIdle(); await first.finish();
  const secondEvents = [...second.events];
  // Act
  await first.edit({ themeColor: '#abcdef' }); await first.advance(5000);
  const fresh = harness(); await fresh.appear(first.coordinator.getSettings());
  // Assert
  assert.deepEqual(second.events, secondEvents); assert.equal(second.runs.length, 0); assert.equal(second.session.getState().enabled, false);
  assert.equal(fresh.runs.length, 0); assert.equal(fresh.session.getState().enabled, false); assert.equal(fresh.session.getState().dueMs, undefined);
  assert.deepEqual(images(fresh), []); assert.deepEqual(fresh.writes, []); assert.equal(first.runs.length, 2);
});

test('delayed old title callback cannot send a stale image after manual stop and next generation', options, async () => {
  // Arrange
  const held = deferred(), entered = deferred(); let hold = true;
  const h = harness({ async title() { if (hold) { entered.resolve(); await held.promise; } } });
  await h.appear({ ...base, actionOnPress: 'stop' }); await h.tap(); h.runs[0].callbacks.onUpdate(image('old')); await entered.promise;
  // Act
  void h.session.keyDown(); const stopping = h.session.keyUp(); hold = false; held.resolve(); await stopping; await h.session.whenIdle();
  await h.tap(); h.runs[0].callbacks.onUpdate(image('old-late')); h.runs[1].callbacks.onUpdate(image('new')); await h.session.whenIdle();
  // Assert
  assert.deepEqual(images(h), [image('new').image]); assert.equal(h.runs.length, 2); assert.equal(h.runs[0].stops, 1);
});

test('natural completion racing manual hold cannot schedule a later replacement or success footer', options, async () => {
  // Arrange
  const h = harness(); await h.appear(); await h.tap(); await h.session.keyDown();
  // Act
  h.runs[0].done.resolve(success); h.time.advance(TIMER_HOLD_MS); await h.session.keyUp(); await h.session.whenIdle();
  await h.advance(100000);
  // Assert
  assert.equal(h.runs.length, 1); assert.equal(h.session.getState().enabled, false);
  assert.equal(h.session.getState().dueMs, undefined); assert.equal(cards(h).at(-1)?.[2], 'ready');
  assert.ok(cards(h).every(card => card[2] !== 'success' && card[2] !== 'exited'));
});

test('completion waits for the latest configuration confirmation before setting its full deadline', options, async () => {
  // Arrange
  const saved = deferred(), entered = deferred();
  const h = harness({ async write() { entered.resolve(); await saved.promise; } });
  await h.appear(); await h.tap();
  // Act
  const editing = h.edit({ intervalSeconds: 10 }); await entered.promise;
  h.runs[0].done.resolve(success); await Promise.resolve(); h.time.advance(3000);
  const before = { state: h.session.getState(), events: [...cards(h)], runs: h.runs.length };
  saved.resolve(); await editing; await h.session.whenIdle();
  // Assert
  assert.equal(before.state.dueMs, undefined); assert.equal(before.state.configurationPending, true);
  assert.equal(before.events.at(-1)?.[2], 'ready'); assert.equal(before.runs, 1);
  assert.equal(h.session.getState().dueMs, 13000); assert.equal(cards(h).at(-1)?.[2], 'success');
});

test('a pending theme save during Loading must reconfirm the latest complete snapshot before spawning', options, async () => {
  // Arrange
  const loading = deferred(), loadingEntered = deferred(), saved = deferred(), saveEntered = deferred();
  const h = harness({
    async presentation(kind) { if (kind === 'waiting') { loadingEntered.resolve(); await loading.promise; } },
    async write() { saveEntered.resolve(); await saved.promise; },
  });
  await h.appear(); void h.session.keyDown(); const launching = h.session.keyUp(); await loadingEntered.promise;
  // Act
  const editing = h.edit({ themeColor: '#abcdef' }); await saveEntered.promise;
  loading.resolve(); const before = h.runs.length;
  saved.resolve(); await launching; await editing; await h.session.whenIdle();
  // Assert
  assert.equal(before, 0); assert.equal(h.runs.length, 1); assert.equal(h.session.getState().configurationPending, false);
  assert.deepEqual(h.writes, [{ ...base, themeColor: '#abcdef' }]); assert.equal(h.runs[0].stops, 0);
});

test('execution recovery cannot show Ready until both owned stop and latest save are confirmed', options, async () => {
  // Arrange
  const saved = deferred(), saveEntered = deferred(), stopped = deferred();
  const h = harness({ async write() { saveEntered.resolve(); await saved.promise; } });
  await h.appear(); await h.tap(); h.runs[0].stopGate = stopped;
  // Act
  const editing = h.edit({ executable: '/synthetic/recovered' }); await saveEntered.promise;
  const before = { cards: [...cards(h)], count: h.runs.length };
  saved.resolve(); stopped.resolve(true); await editing; await h.session.whenIdle(); await h.advance(100000);
  // Assert
  assert.equal(before.cards.at(-1)?.[0], 'waiting'); assert.equal(before.count, 1);
  assert.equal(cards(h).at(-1)?.[1], 'recovered'); assert.equal(cards(h).at(-1)?.[2], 'ready');
  assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 1); assert.equal(h.session.getState().enabled, false);
});

test('cleanup diagnostic remains authoritative even after stop intent invalidates old semantic errors', options, async () => {
  // Arrange
  const stopped = deferred(); const h = harness(); await h.appear({ ...base, actionOnPress: 'stop' }); await h.tap(); h.runs[0].stopGate = stopped;
  // Act
  void h.session.keyDown(); const stopping = h.session.keyUp();
  h.runs[0].callbacks.onError('Process cleanup uncertain.');
  h.runs[0].callbacks.onError('Image protocol error.'); stopped.resolve(true);
  await stopping; await h.session.whenIdle(); await h.tap();
  // Assert
  assert.equal(errors(h).at(-1)?.[2], 'CLEANUP_BLOCKED'); assert.equal(h.session.getState().cleanupBlocked, true);
  assert.equal(h.session.getState().protocolBlocked, false); assert.equal(h.runs.length, 1);
});

test('classified ordinary Error survives a theme edit without resetting the existing retry deadline', options, async () => {
  // Arrange
  const h = harness(); await h.appear(); await h.tap(); h.runs[0].callbacks.onDiagnostic('PROCESS_EXITED_NONZERO');
  await h.finish({ status: 'error', error: ordinaryError }); await h.advance(2000); const due = h.session.getState().dueMs;
  // Act
  await h.edit({ themeColor: '#abcdef' }); await h.advance(3000);
  // Assert
  assert.equal(due, 5000); assert.equal(h.runs.length, 2); assert.equal(errors(h).at(-1)?.[1], ordinaryError);
  assert.equal(errors(h).at(-1)?.[3], '#abcdef'); assert.equal(h.session.getState().presentation, 'error');
});

test('holding a recoverable protocol Error disables intent but preserves its fixed Error priority', options, async () => {
  // Arrange
  const h = harness(); await h.appear(); await h.tap(); h.runs[0].callbacks.onError('Image protocol error.');
  await h.finish({ status: 'error', error: 'Image protocol error.' });
  // Act
  await h.session.keyDown(); await h.advance(TIMER_HOLD_MS); await h.session.keyUp(); await h.session.whenIdle(); await h.advance(100000);
  // Assert
  assert.equal(h.session.getState().enabled, false); assert.equal(h.session.getState().protocolBlocked, true);
  assert.equal(errors(h).at(-1)?.[2], 'IMAGE_PROTOCOL_ERROR'); assert.equal(h.runs.length, 1);
});

test('rejected interval edit leaves the last confirmed running configuration intact', options, async () => {
  // Arrange
  const h = harness(); await h.appear(); await h.tap();
  // Act
  const rejection = await h.coordinator.editConfiguration({ intervalSeconds: 0 }).catch(error => error);
  await h.session.applySettings(h.coordinator.getSettings()); await h.session.whenIdle(); await h.finish();
  // Assert
  assert.equal(rejection.message, 'Invalid settings.'); assert.equal(rejection.diagnosticCode, 'INTERVAL_INVALID');
  assert.equal(h.runs[0].stops, 0); assert.equal(h.session.getState().enabled, true);
  assert.equal(h.session.getState().dueMs, 5000); assert.deepEqual(h.writes, []);
});

test('equivalent legacy argv migration while running neither disables nor replaces the owner', options, async () => {
  // Arrange
  const h = harness(); await h.appear({ executable: base.executable, args: ['two words', 'literal'] }); await h.tap();
  // Act
  await h.edit({ argsText: "'two words' literal", intervalSeconds: 60 }); await h.finish();
  // Assert
  assert.equal(h.runs[0].stops, 0); assert.equal(h.runs.length, 1); assert.equal(h.session.getState().enabled, true);
  assert.equal(h.session.getState().dueMs, 60000); assert.deepEqual(h.runs[0].execution.args, ['two words', 'literal']);
});

test('late completed-run callbacks cannot overwrite the next generation output or its intent', options, async () => {
  // Arrange
  const h = harness(); await h.appear(); await h.tap(); const old = h.runs[0]; await h.finish(); await h.advance(5000);
  h.runs[1].callbacks.onUpdate(image('new')); await h.session.whenIdle(); const before = [...h.events];
  // Act
  old.callbacks.onUpdate(image('stale')); old.callbacks.onDiagnostic('PROCESS_LAUNCH_FAILED');
  old.callbacks.onError('Image protocol error.'); await h.session.whenIdle();
  // Assert
  assert.deepEqual(h.events, before); assert.equal(h.session.getState().phase, 'running');
  assert.equal(h.session.getState().enabled, true); assert.equal(h.session.getState().suspended, false);
});

test('deadline callback and duplicate wake/appear cannot launch overlapping owners', options, async () => {
  // Arrange
  const h = harness(); await h.appear(); await h.tap(); await h.finish();
  // Act
  h.time.advance(5000); const appearing = h.session.appear(h.coordinator.getSettings());
  const waking = h.session.reconcileAvailability(); const reconnecting = h.session.setConnected(true);
  await Promise.all([appearing, waking, reconnecting]); await h.session.whenIdle(); await h.advance(100000);
  // Assert
  assert.equal(h.runs.length, 2); assert.equal(h.runs[1].stops, 0); assert.equal(h.session.getState().phase, 'running');
});

// Review finding 1: rejected done is not a cleanup fact. Ownership is retained
// until the explicit process boundary settles; the rejected promise stays rejected.
test('rejected done explicitly stops once and allows deliberate retry only after certain cleanup', options, async () => {
  // Arrange
  const stopped = deferred(); const h = harness(); await h.appear(); await h.tap();
  const run = h.runs[0]; run.stopGate = stopped;
  run.callbacks.onUpdate(image('before-rejection')); await h.session.whenIdle();
  // Act
  run.done.reject(new Error('synthetic rejected completion')); await run.stopEntered.promise;
  const before = { state: h.session.getState(), events: [...h.events] };
  void h.session.keyDown(); const premature = h.session.keyUp();
  const wake = h.session.reconcileAvailability(); const hiding = h.session.disappear();
  run.callbacks.onUpdate(image('late-after-rejection'));
  const returning = h.session.appear(h.coordinator.getSettings());
  const pendingCount = h.runs.length; stopped.resolve(true);
  await Promise.all([premature, wake, hiding, returning]); await h.session.whenIdle();
  const settled = h.session.getState(); await h.advance(100000); const automaticCount = h.runs.length;
  await h.tap();
  // Assert
  assert.equal(before.state.phase, 'stopping'); assert.equal(before.state.dueMs, undefined);
  assert.equal(before.events.at(-1)?.[1], image('before-rejection').image);
  assert.equal(pendingCount, 1); assert.equal(automaticCount, 1); assert.equal(run.stops, 1);
  assert.equal(settled.cleanupBlocked, false); assert.equal(settled.suspended, true);
  assert.equal(errors(h).at(-1)?.[1], ordinaryError);
  assert.ok(!images(h).includes(image('late-after-rejection').image));
  assert.equal(h.runs.length, 2); assert.equal(h.session.getState().suspended, false);
});

for (const certainty of ['false', 'reject']) {
  test(`rejected done followed by stop ${certainty} permanently blocks replacement and recovery`, options, async () => {
    // Arrange
    const stopped = deferred(); const h = harness(); await h.appear(); await h.tap();
    const run = h.runs[0]; run.stopGate = stopped;
    // Act
    run.done.reject(new Error('synthetic rejected completion')); await run.stopEntered.promise;
    void h.session.keyDown(); const premature = h.session.keyUp();
    run.callbacks.onUpdate(image('late'));
    const pendingCount = h.runs.length;
    if (certainty === 'false') stopped.resolve(false); else stopped.reject(new Error('synthetic stop rejection'));
    await premature; await h.session.whenIdle(); const blocked = h.session.getState();
    await h.tap(); await h.edit({ executable: '/synthetic/recovery-attempt' });
    await h.session.setConnected(false); await h.session.setConnected(true);
    await h.appear(); await h.session.reconcileAvailability(); await h.advance(100000);
    // Assert
    assert.equal(pendingCount, 1); assert.equal(run.stops, 1); assert.equal(h.runs.length, 1);
    assert.equal(blocked.cleanupBlocked, true); assert.equal(h.session.getState().cleanupBlocked, true);
    assert.equal(h.session.getState().dueMs, undefined); assert.equal(errors(h).at(-1)?.[2], 'CLEANUP_BLOCKED');
    assert.deepEqual(images(h), []);
  });
}

for (const interruption of ['hold', 'execution', 'disconnect']) {
  for (const certainty of [true, false]) {
    test(`rejected completion racing ${interruption}, cleanup=${certainty}, never overlaps or double-stops`, options, async () => {
      // Arrange
      const stopped = deferred(); const h = harness(); await h.appear(); await h.tap();
      const run = h.runs[0]; run.stopGate = stopped;
      // Act
      run.done.reject(new Error('synthetic rejected completion')); await run.stopEntered.promise;
      let interrupted;
      if (interruption === 'hold') {
        void h.session.keyDown(); h.time.advance(TIMER_HOLD_MS); interrupted = h.session.keyUp();
      }
      if (interruption === 'execution') interrupted = h.edit({ executable: '/synthetic/replacement' });
      if (interruption === 'disconnect') interrupted = h.session.setConnected(false);
      run.callbacks.onUpdate(image('stale')); run.callbacks.onDiagnostic('PROCESS_LAUNCH_FAILED');
      run.callbacks.onError('Image protocol error.');
      const pending = { count: h.runs.length, stops: run.stops, due: h.session.getState().dueMs };
      stopped.resolve(certainty); await interrupted; await h.session.whenIdle();
      await h.session.setConnected(true); await h.appear(); await h.session.reconcileAvailability(); await h.advance(100000);
      const automaticCount = h.runs.length; await h.tap();
      // Assert
      assert.deepEqual(pending, { count: 1, stops: 1, due: undefined }); assert.equal(run.stops, 1);
      assert.equal(automaticCount, 1); assert.equal(h.runs.length, certainty ? 2 : 1);
      assert.equal(h.session.getState().cleanupBlocked, !certainty);
      assert.deepEqual(images(h), []); assert.equal(h.session.getState().protocolBlocked, false);
      if (!certainty) assert.equal(errors(h).at(-1)?.[2], 'CLEANUP_BLOCKED');
    });
  }
}

// Review finding 2: an actual waiting interval edit owes one reset after the
// latest complete snapshot is confirmed, even if a later edit is cosmetic.
for (const superseding of ['theme', 'argv-migration', 'new-interval']) {
  test(`pending interval reset survives superseding ${superseding} and uses only the latest confirmed duration`, options, async () => {
    // Arrange
    const saved = deferred(), entered = deferred(); let writeCount = 0;
    const h = harness({ async write() { if (++writeCount === 1) { entered.resolve(); await saved.promise; } } });
    await h.appear({ executable: base.executable, args: ['two words', 'literal'], intervalSeconds: 5 });
    await h.tap(); await h.finish(); await h.advance(2000);
    // Act
    const interval = h.edit({ intervalSeconds: 10 }); await entered.promise;
    const latest = h.edit(superseding === 'theme' ? { themeColor: '#abcdef' }
      : superseding === 'argv-migration' ? { argsText: "'two words' literal" } : { intervalSeconds: 20 });
    h.time.advance(3000); const before = { state: h.session.getState(), runs: h.runs.length };
    saved.resolve(); await Promise.all([interval, latest]); await h.session.whenIdle();
    const seconds = superseding === 'new-interval' ? 20 : 10, due = h.session.getState().dueMs;
    await h.session.applySettings(h.coordinator.getSettings()); await h.session.reconcileAvailability(); await h.session.whenIdle();
    const repeatedDue = h.session.getState().dueMs;
    await h.advance(seconds * 1000 - 1); const beforeDeadline = h.runs.length; await h.advance(1);
    // Assert
    assert.equal(before.state.configurationPending, true); assert.equal(before.state.dueMs, undefined); assert.equal(before.runs, 1);
    assert.equal(due, 5000 + seconds * 1000); assert.equal(repeatedDue, due);
    assert.equal(beforeDeadline, 1); assert.equal(h.runs.length, 2); assert.equal(h.runs[0].stops, 0);
    assert.deepEqual(h.runs[1].execution.args, ['two words', 'literal']);
    assert.equal(h.writes.length, 2); assert.equal(h.session.getState().persistenceBlocked, false);
  });
}

// TITLE-1 ROUND1: a title-only latest snapshot must carry an earlier interval
// reset through confirmation, even when retained producer output needs no redraw.
for (const retained of [false, true]) {
  test(`title superseding a pending interval save starts one full confirmed delay with retained output=${retained}`, options, async () => {
    // Arrange
    const saved = deferred(), entered = deferred(); let writeCount = 0;
    const h = harness({ async write() { if (++writeCount === 1) { entered.resolve(); await saved.promise; } } });
    await h.appear(); await h.tap();
    if (retained) { h.runs[0].callbacks.onUpdate(parseOutputUpdate('text:retained')); await h.session.whenIdle(); }
    await h.finish(); await h.advance(2000);
    const displayed = [...images(h)];
    // Act
    const interval = h.edit({ intervalSeconds: 10 }); await entered.promise;
    const title = h.edit({ title: 'new title' });
    h.time.advance(3000);
    const pending = { due: h.session.getState().dueMs, runs: h.runs.length };
    saved.resolve(); await Promise.all([interval, title]);
    const confirmed = { due: h.session.getState().dueMs, images: [...images(h)], runs: h.runs.length };
    await h.advance(9999); const beforeDeadline = h.runs.length;
    await h.advance(1); const atDeadline = h.runs.length;
    await h.session.reconcileAvailability(); await h.session.whenIdle();
    // Assert
    assert.deepEqual(pending, { due: undefined, runs: 1 });
    assert.equal(confirmed.due, 15000); assert.equal(confirmed.runs, 1);
    assert.equal(beforeDeadline, 1); assert.equal(atDeadline, 2); assert.equal(h.runs.length, 2);
    assert.equal(h.runs[0].stops, 0); assert.equal(h.session.getState().enabled, true);
    assert.equal(h.writes.length, 2); assert.equal(h.writes.at(-1).intervalSeconds, 10); assert.equal(h.writes.at(-1).title, 'new title');
    assert.deepEqual(confirmed.images, displayed); assert.deepEqual(images(h), displayed);
    assert.deepEqual(errors(h), []); assert.equal(h.session.getState().persistenceBlocked, false);
  });

  test(`title save without an interval reset preserves the established deadline with retained output=${retained}`, options, async () => {
    // Arrange
    const saved = deferred(), entered = deferred();
    const h = harness({ async write() { entered.resolve(); await saved.promise; } });
    await h.appear(); await h.tap();
    if (retained) { h.runs[0].callbacks.onUpdate(parseOutputUpdate('text:retained')); await h.session.whenIdle(); }
    await h.finish(); await h.advance(2000);
    const originalDue = h.session.getState().dueMs, displayed = [...images(h)];
    // Act
    const title = h.edit({ title: 'new title' }); await entered.promise; h.time.advance(1000);
    const pendingDue = h.session.getState().dueMs;
    saved.resolve(); await title; const confirmedDue = h.session.getState().dueMs;
    await h.advance(1999); const beforeDeadline = h.runs.length; await h.advance(1);
    // Assert
    assert.equal(originalDue, 5000); assert.equal(pendingDue, originalDue); assert.equal(confirmedDue, originalDue);
    assert.equal(beforeDeadline, 1); assert.equal(h.runs.length, 2); assert.equal(h.runs[0].stops, 0);
    assert.deepEqual(images(h), displayed); assert.deepEqual(errors(h), []);
    assert.equal(h.writes.length, 1); assert.equal(h.session.getState().persistenceBlocked, false);
  });
}

for (const cancellation of ['hold', 'disconnect', 'execution']) {
  test(`pending interval obligation cancelled by ${cancellation} cannot resurrect enabled intent or a deadline`, options, async () => {
    // Arrange
    const saved = deferred(), entered = deferred(); let writeCount = 0;
    const h = harness({ async write() { if (++writeCount === 1) { entered.resolve(); await saved.promise; } } });
    await h.appear(); await h.tap(); await h.finish(); await h.advance(2000);
    // Act
    const interval = h.edit({ intervalSeconds: 10 }); await entered.promise;
    const cosmetic = h.edit({ themeColor: '#abcdef' }); let cancelled;
    if (cancellation === 'hold') {
      void h.session.keyDown(); h.time.advance(TIMER_HOLD_MS); cancelled = h.session.keyUp();
    }
    if (cancellation === 'disconnect') cancelled = h.session.setConnected(false);
    if (cancellation === 'execution') cancelled = h.edit({ executable: '/synthetic/new' });
    const before = h.runs.length; saved.resolve(); await Promise.all([interval, cosmetic, cancelled]); await h.session.whenIdle();
    await h.session.setConnected(true); await h.appear(); await h.session.reconcileAvailability(); await h.advance(100000);
    // Assert
    assert.equal(before, 1); assert.equal(h.runs.length, 1); assert.equal(h.session.getState().enabled, false);
    assert.equal(h.session.getState().dueMs, undefined); assert.equal(h.session.getState().persistenceBlocked, false);
    assert.equal(cards(h).at(-1)?.[2], 'ready');
  });
}

for (const hiddenDelay of [4000, 20000]) {
  test(`hidden superseded interval save restores ${hiddenDelay === 4000 ? 'remaining time' : 'one overdue launch'} without a backlog`, options, async () => {
    // Arrange
    const saved = deferred(), entered = deferred(); let writeCount = 0;
    const h = harness({ async write() { if (++writeCount === 1) { entered.resolve(); await saved.promise; } } });
    await h.appear(); await h.tap(); await h.finish(); await h.advance(2000);
    // Act
    const interval = h.edit({ intervalSeconds: 10 }); await entered.promise;
    const cosmetic = h.edit({ themeColor: '#abcdef' }); const hiding = h.session.disappear();
    const hiddenEvents = [...h.events]; h.time.advance(3000); saved.resolve();
    await Promise.all([interval, cosmetic, hiding]); await h.session.whenIdle(); const due = h.session.getState().dueMs;
    await h.advance(hiddenDelay); const beforeReturn = { runs: h.runs.length, events: [...h.events] };
    await h.appear(); await h.appear(); await h.session.reconcileAvailability(); await h.session.whenIdle();
    const returned = h.runs.length;
    if (hiddenDelay === 4000) await h.advance(6000);
    // Assert
    assert.equal(due, 15000); assert.equal(beforeReturn.runs, 1); assert.deepEqual(beforeReturn.events, hiddenEvents);
    assert.equal(returned, hiddenDelay === 4000 ? 1 : 2); assert.equal(h.runs.length, 2);
    assert.equal(h.session.getState().enabled, true); assert.equal(h.runs[0].stops, 0);
  });
}

test('pending explicit default interval and cosmetic supersession preserve the original default deadline', options, async () => {
  // Arrange
  const saved = deferred(), entered = deferred(); let writeCount = 0;
  const h = harness({ async write() { if (++writeCount === 1) { entered.resolve(); await saved.promise; } } });
  await h.appear({ executable: base.executable, argsText: '' }); await h.tap(); await h.finish(); await h.advance(2000);
  // Act
  const explicit = h.edit({ intervalSeconds: 60 }); await entered.promise;
  const cosmetic = h.edit({ themeColor: '#abcdef' }); h.time.advance(3000);
  const before = h.session.getState().dueMs; saved.resolve(); await Promise.all([explicit, cosmetic]); await h.session.whenIdle();
  const after = h.session.getState().dueMs; await h.advance(54999); const count = h.runs.length; await h.advance(1);
  // Assert
  assert.equal(before, 60000); assert.equal(after, 60000); assert.equal(count, 1); assert.equal(h.runs.length, 2);
  assert.equal(h.runs[0].stops, 0); assert.equal(h.session.getState().persistenceBlocked, false);
});

// These scenarios hold a settings boundary closed after observing its entry.
// One event-loop checkpoint drains all runnable promise work after timer delivery
// or display release, without advancing the fake clock or confirming that save.
function eventLoopCheckpoint() {
  return new Promise(resolve => setImmediate(resolve));
}

// S2: persistence injection belongs at the public core boundary, not inside
// an adapter's captured session. A newer Error invalidates each held handoff.
for (const stage of ['setup', 'ready', 'producer']) {
  test(`persistence failure invalidates held ${stage} handoff and permanently blocks replacement`, options, async () => {
    // Arrange
    const gate = deferred(), entered = deferred(); let hold = true;
    const holdOnce = async () => { if (hold) { hold = false; entered.resolve(); await gate.promise; } };
    const h = harness(stage === 'producer' ? { title: holdOnce } : { presentation: holdOnce });
    let appearing;
    if (stage === 'producer') {
      await h.appear(); await h.tap();
      h.runs[0].callbacks.onUpdate(image('obsolete')); await entered.promise;
    } else {
      appearing = h.appear(stage === 'setup' ? {} : base); await entered.promise;
    }
    const before = [...h.events];
    // Act
    const failing = h.session.persistenceFailed();
    await eventLoopCheckpoint(); h.time.advance(100000); await eventLoopCheckpoint();
    // Assert while held: no obsolete frame or replacement escapes the boundary.
    const fixedError = ['error', 'Run state save failed.', 'STATE_SAVE_FAILED', '#969696'];
    if (stage === 'producer') {
      // The independent Error boundary may publish before the title gate opens.
      assert.deepEqual(h.events.filter(event => event[0] !== 'error'), before);
      for (const event of errors(h)) assert.deepEqual(event, fixedError);
    } else assert.deepEqual(h.events, before);
    assert.equal(h.runs.length, stage === 'producer' ? 1 : 0);
    if (stage === 'producer') assert.equal(h.runs[0].stops, 1);
    gate.resolve(); await Promise.all([appearing, failing]); await eventLoopCheckpoint(); await h.session.whenIdle();
    assert.deepEqual(h.events.at(-1), fixedError);
    if (stage === 'producer') {
      h.runs[0].callbacks.onUpdate(image('stale'));
      h.runs[0].callbacks.onError('Image protocol error.');
    }
    await h.tap(); await h.advance(100000);
    // Assert after release: only the fixed Error may replace the held content.
    assert.deepEqual(h.events.at(-1), fixedError);
    assert.deepEqual(h.events.filter(event => event[0] !== 'error'), before);
    for (const event of errors(h)) assert.deepEqual(event, fixedError);
    assert.deepEqual(images(h), []); assert.deepEqual(cards(h), stage === 'producer' ? before.filter(event => ['ready', 'waiting'].includes(event[0])) : []);
    if (stage === 'producer') assert.equal(h.runs[0].stops, 1);
    assert.equal(h.runs.length, stage === 'producer' ? 1 : 0); assert.deepEqual(h.writes, []);
  });
}

// Slice 1: recognize policy and phase at release; an ignored active Refresh
// must not become a queued manual launch when owned completion arrives later.
for (const policy of [undefined, 'refresh', 'stop']) {
  test(`${policy ?? 'default Refresh'} enables disabled Timer without a policy migration write`, options, async () => {
    // Arrange
    const h = harness(); await h.appear(policySettings(policy));
    // Act
    await h.session.keyDown(); const before = h.runs.length;
    await h.session.keyUp(); await h.session.whenIdle();
    // Assert
    assert.equal(before, 0); assert.equal(h.runs.length, 1); assert.equal(h.session.getState().enabled, true);
    assert.deepEqual(h.runs[0].execution, { executable: base.executable, args: [] });
    assert.deepEqual(h.coordinator.getSettings(), policySettings(policy)); assert.deepEqual(h.writes, []);
  });

  test(`${policy ?? 'default Refresh'} waiting tap ${policy === 'stop' ? 'cancels automation' : 'refreshes immediately'}`, options, async () => {
    // Arrange
    const h = harness(); await h.appear(policySettings(policy)); await h.tap(); await h.finish(); await h.advance(2000);
    // Act
    await h.tap(); const recognized = h.session.getState(); await h.advance(100000);
    // Assert
    assert.equal(h.runs.length, policy === 'stop' ? 1 : 2);
    assert.equal(recognized.enabled, policy !== 'stop'); assert.equal(recognized.dueMs, undefined);
    assert.equal(recognized.phase, policy === 'stop' ? 'stopped' : 'running');
    assert.ok(h.runs.every(run => run.stops === 0)); assert.deepEqual(h.writes, []);
  });

  test(`${policy ?? 'default Refresh'} hold during waiting cancels deadline with no preliminary refresh`, options, async () => {
    // Arrange
    const h = harness(); await h.appear(policySettings(policy)); await h.tap(); await h.finish();
    // Act
    await h.session.keyDown(); const before = h.runs.length;
    await h.advance(TIMER_HOLD_MS); await h.session.keyUp(); await h.session.whenIdle(); await h.advance(100000);
    // Assert
    assert.equal(before, 1); assert.equal(h.runs.length, 1); assert.equal(h.session.getState().enabled, false);
    assert.equal(h.session.getState().dueMs, undefined); assert.deepEqual(h.writes, []);
  });

  test(`${policy ?? 'default Refresh'} hold always stops an active owner exactly once`, options, async () => {
    // Arrange
    const h = harness(); await h.appear(policySettings(policy)); await h.tap();
    // Act
    await h.session.keyDown(); const before = h.runs[0].stops;
    await h.advance(TIMER_HOLD_MS, false); await h.session.keyUp(); await h.session.keyUp(); await h.session.whenIdle(); await h.advance(100000);
    // Assert
    assert.equal(before, 0); assert.equal(h.runs[0].stops, 1); assert.equal(h.runs.length, 1);
    assert.equal(h.session.getState().enabled, false); assert.equal(h.session.getState().dueMs, undefined);
  });
}

for (const policy of [undefined, 'refresh']) {
  test(`${policy ?? 'default Refresh'} active taps leave owner and output untouched and cannot queue a post-completion refresh`, options, async () => {
    // Arrange
    const h = harness(); await h.appear(policySettings(policy)); await h.tap();
    h.runs[0].callbacks.onUpdate(image('synthetic-current')); await h.session.whenIdle();
    const display = [...h.events], state = h.session.getState();
    // Act
    await h.tap(); await h.tap(); const ignored = h.session.getState(), untouched = [...h.events];
    await h.advance(7000); await h.finish(); const due = h.session.getState().dueMs, count = h.runs.length;
    await h.advance(4999); const beforeDeadline = h.runs.length; await h.advance(1);
    // Assert
    assert.deepEqual(ignored, state); assert.deepEqual(untouched, display);
    assert.equal(h.runs[0].stops, 0); assert.equal(count, 1); assert.equal(due, 12000);
    assert.equal(beforeDeadline, 1); assert.equal(h.runs.length, 2); assert.deepEqual(h.writes, []);
  });

  test(`${policy ?? 'default Refresh'} tap recognized during stalled startup never stops or queues another launch`, options, async () => {
    // Arrange
    const gate = deferred(), entered = deferred();
    const h = harness({ async presentation(kind) { if (kind === 'waiting') { entered.resolve(); await gate.promise; } } });
    await h.appear(policySettings(policy)); void h.session.keyDown(); const launching = h.session.keyUp(); await entered.promise;
    // Act
    const phase = h.session.getState().phase;
    void h.session.keyDown(); const ignored = h.session.keyUp(); gate.resolve();
    await Promise.all([launching, ignored]); await h.session.whenIdle(); await h.finish();
    const count = h.runs.length; await h.advance(4999); const before = h.runs.length; await h.advance(1);
    // Assert
    assert.equal(phase, 'starting'); assert.equal(count, 1); assert.equal(before, 1); assert.equal(h.runs.length, 2);
    assert.equal(h.runs[0].stops, 0); assert.deepEqual(h.writes, []);
  });

  test(`${policy ?? 'default Refresh'} release after completed run recognizes waiting rather than key-down running state`, options, async () => {
    // Arrange
    const h = harness(); await h.appear(policySettings(policy)); await h.tap(); await h.session.keyDown();
    // Act
    await h.finish(); const phase = h.session.getState().phase;
    await h.session.keyUp(); await h.session.whenIdle();
    // Assert
    assert.equal(phase, 'waiting'); assert.equal(h.runs.length, 2); assert.equal(h.runs[0].stops, 0);
    assert.equal(h.session.getState().phase, 'running'); assert.deepEqual(h.writes, []);
  });
}

test('enabled Stop tap preserves recoverable Error; only the next disabled tap deliberately retries', options, async () => {
  // Arrange
  const h = harness(); await h.appear(policySettings('stop')); await h.tap();
  h.runs[0].callbacks.onError('Image protocol error.'); await h.finish({ status: 'error', error: 'Image protocol error.' });
  const display = [...h.events];
  // Act
  await h.tap(); const stopped = h.session.getState(), retained = [...h.events], count = h.runs.length;
  await h.advance(100000); await h.tap();
  // Assert
  assert.equal(stopped.enabled, false); assert.equal(stopped.protocolBlocked, true); assert.equal(stopped.suspended, true);
  assert.deepEqual(retained.filter(event => event[0] !== 'error'), display.filter(event => event[0] !== 'error'));
  assert.ok(retained.filter(event => event[0] === 'error').every(event => event[2] === 'IMAGE_PROTOCOL_ERROR'));
  assert.equal(errors(h).at(-1)?.[2], 'IMAGE_PROTOCOL_ERROR'); assert.equal(count, 1);
  assert.equal(h.runs.length, 2); assert.equal(h.session.getState().protocolBlocked, false); assert.deepEqual(h.writes, []);
});

for (const stage of ['disabled', 'waiting', 'running', 'hidden', 'suspended']) {
  for (const from of ['refresh', 'stop']) {
    test(`${from} policy-only edit while ${stage} preserves intent, owner, deadline and errors`, options, async () => {
      // Arrange
      const h = harness(); await h.appear(policySettings(from));
      if (stage !== 'disabled') await h.tap();
      if (stage === 'waiting' || stage === 'hidden') { await h.finish(); await h.advance(1000); }
      if (stage === 'hidden') await h.session.disappear();
      if (stage === 'suspended') { h.runs[0].callbacks.onError('Image protocol error.'); await h.finish({ status: 'error', error: 'Image protocol error.' }); }
      const before = h.session.getState(), count = h.runs.length, shown = [...h.events];
      const actionOnPress = from === 'refresh' ? 'stop' : 'refresh';
      // Act
      await h.edit({ actionOnPress }); const after = h.session.getState();
      if (stage === 'hidden') { await h.advance(1000); await h.appear(); }
      // Assert
      assert.deepEqual(after, before); assert.equal(h.runs.length, count); assert.deepEqual(h.events.slice(0, shown.length), shown);
      assert.ok(h.runs.every(run => run.stops === 0)); assert.deepEqual(h.writes, [{ ...policySettings(from), actionOnPress }]);
      if (stage === 'hidden') assert.equal(h.session.getState().dueMs, before.dueMs);
      if (stage === 'suspended') assert.equal(errors(h).at(-1)?.[2], 'IMAGE_PROTOCOL_ERROR');
    });
  }
}

for (const from of ['refresh', 'stop']) {
  test(`policy choice is read at short release, not key-down (${from})`, options, async () => {
    // Arrange
    const h = harness(); await h.appear(policySettings(from)); await h.tap(); await h.session.keyDown();
    const next = from === 'refresh' ? 'stop' : 'refresh';
    // Act
    await h.edit({ actionOnPress: next }); await h.session.keyUp(); await h.session.whenIdle();
    // Assert
    assert.equal(h.runs[0].stops, next === 'stop' ? 1 : 0); assert.equal(h.session.getState().enabled, next !== 'stop');
    assert.equal(h.runs.length, 1); assert.deepEqual(h.writes, [{ ...policySettings(from), actionOnPress: next }]);
  });
}

for (const interruption of ['hold', 'stop-tap']) {
  test(`${interruption} stops an owner during pending policy confirmation but cannot launch or show false Ready`, options, async () => {
    // Arrange
    const gate = deferred(), entered = deferred();
    const h = harness({ async write() { entered.resolve(); await gate.promise; } });
    await h.appear(); await h.tap(); const readyBefore = cards(h).filter(card => card[2] === 'ready').length;
    // Act
    const editing = h.edit({ actionOnPress: 'stop' }); await entered.promise;
    void h.session.keyDown();
    if (interruption === 'hold') h.time.advance(TIMER_HOLD_MS, false);
    const stopping = h.session.keyUp(); await h.runs[0].stopEntered.promise;
    await eventLoopCheckpoint();
    const pending = h.session.getState(), count = h.runs.length;
    const readyPending = cards(h).filter(card => card[2] === 'ready').length;
    gate.resolve(); await Promise.all([editing, stopping]); await h.session.whenIdle(); await h.advance(100000);
    // Assert
    assert.equal(pending.enabled, false); assert.equal(pending.configurationPending, true); assert.equal(count, 1);
    assert.equal(readyPending, readyBefore); assert.equal(h.runs[0].stops, 1); assert.equal(h.runs.length, 1);
    assert.equal(h.session.getState().phase, 'stopped'); assert.equal(h.session.getState().dueMs, undefined);
  });
}

test('overdue deadline during pending policy save cannot launch until latest snapshot confirmation or reset due', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred();
  const h = harness({ async write() { entered.resolve(); await gate.promise; } });
  await h.appear(); await h.tap(); await h.finish(); await h.advance(2000);
  // Act
  const editing = h.edit({ actionOnPress: 'stop' }); await entered.promise;
  h.time.advance(4000); await eventLoopCheckpoint(); const count = h.runs.length, pending = h.session.getState();
  gate.resolve(); await editing; await h.session.whenIdle();
  // Assert
  assert.equal(count, 1); assert.equal(pending.dueMs, 5000); assert.equal(pending.configurationPending, true);
  assert.equal(h.runs.length, 2); assert.equal(h.runs[0].stops, 0); assert.equal(h.session.getState().enabled, true);
});

for (const edit of [
  { actionOnPress: 'stop', intervalSeconds: 10, themeColor: '#abcdef' },
  { actionOnPress: 'stop', argsText: '', intervalSeconds: 5 },
  { actionOnPress: 'stop', executable: '/synthetic/new' },
]) {
  test(`combined policy edit ${Object.keys(edit).join('/')} retains existing execution and interval classifications`, options, async () => {
    // Arrange
    const h = harness(); await h.appear(); await h.tap(); await h.finish(); await h.advance(2000);
    // Act
    await h.edit(edit); const state = h.session.getState(); await h.advance(2999); const before = h.runs.length;
    // Assert
    assert.equal(before, 1); assert.equal(state.enabled, !Object.hasOwn(edit, 'executable'));
    assert.equal(state.dueMs, Object.hasOwn(edit, 'executable') ? undefined : edit.intervalSeconds === 10 ? 12000 : 5000);
    assert.deepEqual(h.writes, [{ ...base, ...edit }]); assert.equal(h.runs[0].stops, 0);
  });
}

for (const oldResult of ['false', 'reject']) {
  test(`superseded policy initialization ${oldResult} cannot poison latest Stop authority or launch stale Refresh`, options, async () => {
    // Arrange
    const old = deferred(), entered = deferred();
    const h = harness({ async confirm(expected) { if (!Object.hasOwn(expected, 'actionOnPress')) { entered.resolve(); return old.promise; } return true; } });
    h.coordinator.observe(base); const appearing = h.session.appear(base); await entered.promise;
    // Act
    const editing = h.edit({ actionOnPress: 'stop' });
    if (oldResult === 'reject') old.reject(new Error('synthetic stale policy')); else old.resolve(false);
    await Promise.all([appearing, editing]); await h.tap(); await h.tap();
    // Assert
    assert.equal(h.session.getState().persistenceBlocked, false); assert.equal(h.session.getState().enabled, false);
    assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 1); assert.deepEqual(errors(h), []);
    assert.deepEqual(h.writes, [{ ...base, actionOnPress: 'stop' }]);
  });
}

test('rejected policy edit preserves confirmed active owner and its full completion interval', options, async () => {
  // Arrange
  const h = harness(); await h.appear(); await h.tap(); const before = h.session.getState();
  // Act
  const failure = await h.coordinator.editConfiguration({ actionOnPress: 'STOP' }).catch(error => error);
  await h.session.applySettings(h.coordinator.getSettings()); await h.session.whenIdle(); const intact = h.session.getState();
  await h.finish();
  // Assert
  assert.equal(failure.diagnosticCode, 'ACTION_ON_PRESS_INVALID'); assert.deepEqual(intact, before);
  assert.equal(h.runs[0].stops, 0); assert.equal(h.session.getState().dueMs, 5000); assert.deepEqual(h.writes, []);
});

for (const policy of ['refresh', 'stop']) {
  for (const result of ['false', 'reject']) {
    test(`pending ${policy} initialization with latest ${result} cannot enable or show false Ready`, options, async () => {
      // Arrange
      const gate = deferred(), entered = deferred(), initial = policySettings(policy);
      const h = harness({ async confirm() { entered.resolve(); return gate.promise; } });
      h.coordinator.observe(initial); const appearing = h.session.appear(initial); await entered.promise;
      // Act
      void h.session.keyDown(); const pressing = h.session.keyUp();
      const pending = { state: h.session.getState(), events: [...h.events], runs: h.runs.length };
      if (result === 'reject') gate.reject(new Error('synthetic policy authority')); else gate.resolve(false);
      await Promise.all([appearing, pressing]); await h.session.whenIdle(); await h.tap(); await h.advance(100000);
      // Assert
      assert.equal(pending.state.configurationPending, true); assert.equal(pending.runs, 0); assert.deepEqual(pending.events, []);
      assert.equal(h.runs.length, 0); assert.deepEqual(cards(h), []); assert.deepEqual(h.writes, []);
      assert.equal(h.session.getState().persistenceBlocked, true); assert.equal(errors(h).at(-1)?.[2], 'STATE_SAVE_FAILED');
    });
  }
}

test('pending policy edit during Loading must confirm latest complete snapshot before spawning', options, async () => {
  // Arrange
  const loading = deferred(), entered = deferred(), saved = deferred(), saveEntered = deferred();
  const h = harness({
    async presentation(kind) { if (kind === 'waiting') { entered.resolve(); await loading.promise; } },
    async write() { saveEntered.resolve(); await saved.promise; },
  });
  await h.appear(); void h.session.keyDown(); const launching = h.session.keyUp(); await entered.promise;
  // Act
  const editing = h.edit({ actionOnPress: 'stop' }); await saveEntered.promise;
  loading.resolve(); await eventLoopCheckpoint(); const count = h.runs.length, pending = h.session.getState();
  saved.resolve(); await Promise.all([launching, editing]); await h.session.whenIdle(); await h.tap();
  // Assert
  assert.equal(count, 0); assert.equal(pending.configurationPending, true); assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0].stops, 1); assert.equal(h.session.getState().enabled, false);
  assert.deepEqual(h.writes, [{ ...base, actionOnPress: 'stop' }]);
});

for (const duration of [1000, 20000]) {
  test(`hidden policy-only save retains original due and returns after ${duration}ms without an early launch or backlog`, options, async () => {
    // Arrange
    const h = harness(); await h.appear(); await h.tap(); await h.finish(); await h.advance(1000);
    await h.session.disappear(); const shown = [...h.events], due = h.session.getState().dueMs;
    // Act
    await h.edit({ actionOnPress: 'stop' }); await h.advance(duration);
    const hidden = { state: h.session.getState(), count: h.runs.length, events: [...h.events] };
    await h.appear(); await h.appear(); const returned = h.runs.length;
    if (duration === 1000) await h.advance(3000);
    // Assert
    assert.equal(hidden.count, 1); assert.deepEqual(hidden.events, shown); assert.equal(hidden.state.dueMs, due);
    assert.equal(returned, duration === 1000 ? 1 : 2); assert.equal(h.runs.length, 2); assert.equal(h.runs[0].stops, 0);
    assert.equal(h.session.getState().enabled, true); assert.deepEqual(h.writes, [{ ...base, actionOnPress: 'stop' }]);
  });
}

// Review finding 3: the terminal display callback may yield while configuration
// changes. Retry pacing is installed only after that latest save is confirmed.
for (const terminal of ['success', 'ordinary-error']) {
  test(`deferred terminal ${terminal} waits for a concurrent theme save before installing a full interval`, options, async () => {
    // Arrange
    const presented = deferred(), presentationEntered = deferred(), saved = deferred(), saveEntered = deferred();
    let terminalStarted = false, held = false;
    const holdTerminal = async () => {
      if (terminalStarted && !held) { held = true; presentationEntered.resolve(); await presented.promise; }
    };
    const h = harness({
      async presentation(kind) { if (terminal === 'success' && kind === 'ready') await holdTerminal(); },
      async error(message) { if (terminal === 'ordinary-error' && message === ordinaryError) await holdTerminal(); },
      async write() { saveEntered.resolve(); await saved.promise; },
    });
    await h.appear(); await h.tap(); terminalStarted = true;
    if (terminal === 'ordinary-error') h.runs[0].callbacks.onDiagnostic('PROCESS_EXITED_NONZERO');
    // Act
    const completing = h.finish(terminal === 'success' ? success : { status: 'error', error: ordinaryError });
    await presentationEntered.promise; const cosmetic = h.edit({ themeColor: '#abcdef' }); await saveEntered.promise;
    h.time.advance(3000); presented.resolve(); await eventLoopCheckpoint();
    const before = { state: h.session.getState(), runs: h.runs.length };
    saved.resolve(); await Promise.all([completing, cosmetic]); await h.session.whenIdle();
    const due = h.session.getState().dueMs;
    await h.session.refreshAppearance(); await h.session.whenIdle(); const refreshedDue = h.session.getState().dueMs;
    await h.advance(4999); const count = h.runs.length; await h.advance(1);
    // Assert
    assert.equal(before.state.configurationPending, true); assert.equal(before.state.dueMs, undefined); assert.equal(before.runs, 1);
    assert.equal(due, 8000); assert.equal(refreshedDue, due); assert.equal(count, 1); assert.equal(h.runs.length, 2);
    assert.equal(h.session.getState().persistenceBlocked, false); assert.equal(h.runs[0].stops, 0);
    if (terminal === 'success') { assert.equal(cards(h).at(-1)?.[2], 'success'); assert.equal(cards(h).at(-1)?.[3], '#abcdef'); }
    else { assert.equal(errors(h).at(-1)?.[2], 'PROCESS_EXITED_NONZERO'); assert.equal(errors(h).at(-1)?.[3], '#abcdef'); }
  });
}

for (const terminal of ['success', 'ordinary-error']) {
  for (const interruption of ['hold', 'execution', 'disconnect', 'new-generation']) {
    test(`deferred ${terminal} plus pending save and ${interruption} cannot install an obsolete completion deadline`, options, async () => {
      // Arrange
      const presented = deferred(), presentationEntered = deferred(), saved = deferred(), saveEntered = deferred();
      let terminalStarted = false, held = false;
      const holdTerminal = async () => {
        if (terminalStarted && !held) { held = true; presentationEntered.resolve(); await presented.promise; }
      };
      const h = harness({
        async presentation(kind) { if (terminal === 'success' && kind === 'ready') await holdTerminal(); },
        async error(message) { if (terminal === 'ordinary-error' && message === ordinaryError) await holdTerminal(); },
        async write() { saveEntered.resolve(); await saved.promise; },
      });
      await h.appear(); await h.tap(); terminalStarted = true;
      if (terminal === 'ordinary-error') h.runs[0].callbacks.onDiagnostic('PROCESS_EXITED_NONZERO');
      // Act
      const completing = h.finish(terminal === 'success' ? success : { status: 'error', error: ordinaryError });
      await presentationEntered.promise; const cosmetic = h.edit({ themeColor: '#abcdef' }); await saveEntered.promise;
      let interrupted;
      if (interruption === 'hold') {
        void h.session.keyDown(); h.time.advance(TIMER_HOLD_MS); interrupted = h.session.keyUp();
      }
      if (interruption === 'execution') interrupted = h.edit({ executable: '/synthetic/new' });
      if (interruption === 'disconnect') interrupted = h.session.setConnected(false);
      if (interruption === 'new-generation') { void h.session.keyDown(); interrupted = h.session.keyUp(); }
      presented.resolve(); await eventLoopCheckpoint();
      const pendingCount = h.runs.length; saved.resolve();
      await Promise.all([completing, cosmetic, interrupted]); await h.session.whenIdle();
      await h.session.setConnected(true); await h.appear(); await h.session.reconcileAvailability(); await h.advance(100000);
      // Assert
      assert.equal(pendingCount, 1); assert.equal(h.runs.length, interruption === 'new-generation' ? 2 : 1);
      assert.equal(h.session.getState().enabled, interruption === 'new-generation'); assert.equal(h.session.getState().dueMs, undefined);
      assert.equal(h.session.getState().persistenceBlocked, false); assert.equal(h.runs[0].stops, 0);
      if (interruption === 'new-generation') assert.equal(h.runs[1].stops, 0);
    });
  }
}

// Availability follow-up 1: a queued wake must fulfill the genuine pending
// interval reset before considering an otherwise missing deadline immediately due.
for (const superseding of ['theme', 'argv-migration', 'new-interval']) {
  test(`wake queued before superseding ${superseding} honors the full pending interval instead of launching now`, options, async () => {
    // Arrange
    const saved = deferred(), entered = deferred(); let writeCount = 0;
    const h = harness({ async write() { if (++writeCount === 1) { entered.resolve(); await saved.promise; } } });
    await h.appear({ executable: base.executable, args: ['two words', 'literal'], intervalSeconds: 5 });
    await h.tap(); await h.finish(); await h.advance(2000);
    // Act
    const interval = h.edit({ intervalSeconds: 10 }); await entered.promise;
    const wake = h.session.reconcileAvailability();
    const latest = h.edit(superseding === 'theme' ? { themeColor: '#abcdef' }
      : superseding === 'argv-migration' ? { argsText: "'two words' literal" } : { intervalSeconds: 20 });
    await eventLoopCheckpoint(); h.time.advance(3000);
    const pending = { runs: h.runs.length, state: h.session.getState() };
    saved.resolve(); await Promise.all([interval, wake, latest]); await h.session.whenIdle();
    const seconds = superseding === 'new-interval' ? 20 : 10, due = h.session.getState().dueMs;
    const settledCount = h.runs.length;
    await h.session.reconcileAvailability(); await h.appear(); await h.session.setConnected(true); await h.session.whenIdle();
    const repeatedDue = h.session.getState().dueMs;
    await h.advance(seconds * 1000 - 1); const beforeDeadline = h.runs.length; await h.advance(1);
    // Assert
    assert.equal(pending.runs, 1); assert.equal(pending.state.dueMs, undefined); assert.equal(pending.state.configurationPending, true);
    assert.equal(settledCount, 1); assert.equal(due, 5000 + seconds * 1000); assert.equal(repeatedDue, due);
    assert.equal(beforeDeadline, 1); assert.equal(h.runs.length, 2); assert.equal(h.runs[0].stops, 0);
    assert.deepEqual(h.runs[1].execution.args, ['two words', 'literal']); assert.equal(h.writes.length, 2);
    assert.equal(h.session.getState().persistenceBlocked, false);
  });
}

for (const cancellation of ['hold', 'execution', 'disconnect']) {
  test(`wake queued ahead of cosmetic save cannot resurrect an interval reset cancelled by ${cancellation}`, options, async () => {
    // Arrange
    const saved = deferred(), entered = deferred(); let writeCount = 0;
    const h = harness({ async write() { if (++writeCount === 1) { entered.resolve(); await saved.promise; } } });
    await h.appear(); await h.tap(); await h.finish(); await h.advance(2000);
    // Act
    const interval = h.edit({ intervalSeconds: 10 }); await entered.promise;
    const wake = h.session.reconcileAvailability(); const cosmetic = h.edit({ themeColor: '#abcdef' });
    let cancelled;
    if (cancellation === 'hold') {
      void h.session.keyDown(); h.time.advance(TIMER_HOLD_MS); cancelled = h.session.keyUp();
    }
    if (cancellation === 'execution') cancelled = h.edit({ executable: '/synthetic/new' });
    if (cancellation === 'disconnect') cancelled = h.session.setConnected(false);
    const pendingCount = h.runs.length; saved.resolve();
    await Promise.all([interval, wake, cosmetic, cancelled]); await h.session.whenIdle();
    await h.session.setConnected(true); await h.appear(); await h.session.reconcileAvailability(); await h.advance(100000);
    // Assert
    assert.equal(pendingCount, 1); assert.equal(h.runs.length, 1); assert.equal(h.session.getState().enabled, false);
    assert.equal(h.session.getState().dueMs, undefined); assert.equal(cards(h).at(-1)?.[2], 'ready');
    assert.equal(h.runs[0].stops, 0); assert.equal(h.session.getState().persistenceBlocked, false);
  });
}

test('queued wake invalidated by hide preserves the confirmed pending reset locally without a hidden launch', options, async () => {
  // Arrange
  const saved = deferred(), entered = deferred(); let writeCount = 0;
  const h = harness({ async write() { if (++writeCount === 1) { entered.resolve(); await saved.promise; } } });
  await h.appear(); await h.tap(); await h.finish(); await h.advance(2000);
  // Act
  const interval = h.edit({ intervalSeconds: 10 }); await entered.promise;
  const wake = h.session.reconcileAvailability(); const cosmetic = h.edit({ themeColor: '#abcdef' });
  const hiding = h.session.disappear(); const hiddenEvents = [...h.events];
  h.time.advance(3000); saved.resolve(); await Promise.all([interval, wake, cosmetic, hiding]); await h.session.whenIdle();
  const hiddenDue = h.session.getState().dueMs; await h.advance(4000);
  const hidden = { runs: h.runs.length, events: [...h.events] };
  await h.appear(); const returnedCount = h.runs.length; await h.advance(5999); const count = h.runs.length; await h.advance(1);
  // Assert
  assert.equal(hiddenDue, 15000); assert.equal(hidden.runs, 1); assert.deepEqual(hidden.events, hiddenEvents);
  assert.equal(returnedCount, 1); assert.equal(count, 1); assert.equal(h.runs.length, 2);
  assert.equal(h.runs[0].stops, 0); assert.equal(h.session.getState().enabled, true);
});

// Availability follow-up 2: returning status artwork can yield while a new
// cosmetic snapshot is unconfirmed. Preserve the old due time and re-arm only
// after the latest authority gate; do not convert cosmetics into a full reset.
for (const terminal of ['success', 'ordinary-error']) {
  for (const overdue of [false, true]) {
    test(`returning ${terminal} with deferred artwork and theme save resumes ${overdue ? 'one overdue run' : 'the original remaining interval'}`, options, async () => {
      // Arrange
      const presented = deferred(), presentationEntered = deferred(), saved = deferred(), saveEntered = deferred();
      let returning = false, held = false;
      const holdReturn = async () => {
        if (returning && !held) { held = true; presentationEntered.resolve(); await presented.promise; }
      };
      const h = harness({
        async presentation(kind) { if (terminal === 'success' && kind === 'ready') await holdReturn(); },
        async error(message) { if (terminal === 'ordinary-error' && message === ordinaryError) await holdReturn(); },
        async write() { saveEntered.resolve(); await saved.promise; },
      });
      const settings = { ...base, intervalSeconds: overdue ? 1 : 5 };
      await h.appear(settings); await h.tap();
      if (terminal === 'ordinary-error') h.runs[0].callbacks.onDiagnostic('PROCESS_EXITED_NONZERO');
      await h.finish(terminal === 'success' ? success : { status: 'error', error: ordinaryError });
      const originalDue = h.session.getState().dueMs;
      await h.advance(overdue ? 200 : 1000); await h.session.disappear();
      if (overdue) await h.advance(1000);
      returning = true;
      // Act
      const appearing = h.session.appear(h.coordinator.getSettings()); await presentationEntered.promise;
      const cosmetic = h.edit({ themeColor: '#abcdef' }); await saveEntered.promise;
      h.time.advance(2000); presented.resolve(); await eventLoopCheckpoint();
      const pending = { runs: h.runs.length, state: h.session.getState() };
      saved.resolve(); await Promise.all([appearing, cosmetic]); await h.session.whenIdle();
      const restored = { runs: h.runs.length, due: h.session.getState().dueMs };
      await h.session.reconcileAvailability(); await h.appear(); await h.session.setConnected(true); await h.session.whenIdle();
      let beforeDeadline = h.runs.length;
      if (!overdue) { await h.advance(1999); beforeDeadline = h.runs.length; await h.advance(1); }
      await h.advance(100000);
      // Assert
      assert.equal(originalDue, overdue ? 1000 : 5000); assert.equal(pending.runs, 1);
      assert.equal(pending.state.dueMs, originalDue); assert.equal(pending.state.configurationPending, true);
      assert.equal(restored.runs, overdue ? 2 : 1); assert.equal(restored.due, overdue ? undefined : originalDue);
      assert.equal(beforeDeadline, overdue ? 2 : 1); assert.equal(h.runs.length, 2); assert.equal(h.runs[0].stops, 0);
      assert.equal(h.session.getState().suspended, false); assert.equal(h.writes.length, 1);
      if (terminal === 'success') { assert.equal(cards(h).at(-1)?.[2], 'success'); assert.equal(cards(h).at(-1)?.[3], '#abcdef'); }
      else { assert.equal(errors(h).at(-1)?.[2], 'PROCESS_EXITED_NONZERO'); assert.equal(errors(h).at(-1)?.[3], '#abcdef'); }
    });
  }
}

for (const terminal of ['success', 'ordinary-error']) {
  for (const interruption of ['hold', 'execution', 'disconnect', 'new-generation']) {
    test(`returning ${terminal} awaiting cosmetic confirmation cannot restore an old deadline after ${interruption}`, options, async () => {
      // Arrange
      const presented = deferred(), presentationEntered = deferred(), saved = deferred(), saveEntered = deferred();
      let returning = false, held = false;
      const holdReturn = async () => {
        if (returning && !held) { held = true; presentationEntered.resolve(); await presented.promise; }
      };
      const h = harness({
        async presentation(kind) { if (terminal === 'success' && kind === 'ready') await holdReturn(); },
        async error(message) { if (terminal === 'ordinary-error' && message === ordinaryError) await holdReturn(); },
        async write() { saveEntered.resolve(); await saved.promise; },
      });
      await h.appear(); await h.tap();
      if (terminal === 'ordinary-error') h.runs[0].callbacks.onDiagnostic('PROCESS_EXITED_NONZERO');
      await h.finish(terminal === 'success' ? success : { status: 'error', error: ordinaryError });
      await h.advance(1000); await h.session.disappear(); returning = true;
      // Act
      const appearing = h.session.appear(h.coordinator.getSettings()); await presentationEntered.promise;
      const cosmetic = h.edit({ themeColor: '#abcdef' }); await saveEntered.promise;
      h.time.advance(2000); presented.resolve(); await eventLoopCheckpoint();
      let interrupted;
      if (interruption === 'hold') {
        void h.session.keyDown(); h.time.advance(TIMER_HOLD_MS); interrupted = h.session.keyUp();
      }
      if (interruption === 'execution') interrupted = h.edit({ executable: '/synthetic/new' });
      if (interruption === 'disconnect') interrupted = h.session.setConnected(false);
      if (interruption === 'new-generation') { void h.session.keyDown(); interrupted = h.session.keyUp(); }
      const pendingCount = h.runs.length; saved.resolve();
      await Promise.all([appearing, cosmetic, interrupted]); await h.session.whenIdle();
      await h.session.setConnected(true); await h.appear(); await h.session.reconcileAvailability(); await h.advance(100000);
      // Assert
      assert.equal(pendingCount, 1); assert.equal(h.runs.length, interruption === 'new-generation' ? 2 : 1);
      assert.equal(h.session.getState().enabled, interruption === 'new-generation'); assert.equal(h.session.getState().dueMs, undefined);
      assert.equal(h.runs[0].stops, 0); assert.equal(h.session.getState().persistenceBlocked, false);
      if (interruption === 'new-generation') assert.equal(h.runs[1].stops, 0);
    });
  }
}

for (const terminal of ['success', 'ordinary-error']) {
  test(`failed latest cosmetic confirmation during returning ${terminal} shows fixed persistence Error and never retries`, options, async () => {
    // Arrange
    const presented = deferred(), presentationEntered = deferred(), saved = deferred(), saveEntered = deferred();
    let returning = false, held = false;
    const holdReturn = async () => {
      if (returning && !held) { held = true; presentationEntered.resolve(); await presented.promise; }
    };
    const h = harness({
      async presentation(kind) { if (terminal === 'success' && kind === 'ready') await holdReturn(); },
      async error(message) { if (terminal === 'ordinary-error' && message === ordinaryError) await holdReturn(); },
      async write() { saveEntered.resolve(); await saved.promise; },
      read() { return base; },
    });
    await h.appear(); await h.tap();
    if (terminal === 'ordinary-error') h.runs[0].callbacks.onDiagnostic('PROCESS_EXITED_NONZERO');
    await h.finish(terminal === 'success' ? success : { status: 'error', error: ordinaryError });
    await h.advance(1000); await h.session.disappear(); returning = true;
    // Act
    const appearing = h.session.appear(h.coordinator.getSettings()); await presentationEntered.promise;
    const cosmetic = h.edit({ themeColor: '#abcdef' }); await saveEntered.promise;
    h.time.advance(2000); presented.resolve(); await eventLoopCheckpoint(); const pendingCount = h.runs.length;
    saved.resolve(); await Promise.all([appearing, cosmetic]); await h.session.whenIdle();
    await h.tap(); await h.session.reconcileAvailability(); await h.advance(100000);
    // Assert
    assert.equal(pendingCount, 1); assert.equal(h.runs.length, 1); assert.equal(h.session.getState().persistenceBlocked, true);
    assert.equal(h.coordinator.isBlocked(), true); assert.equal(h.session.getState().dueMs, undefined);
    assert.equal(errors(h).at(-1)?.[2], 'STATE_SAVE_FAILED'); assert.equal(h.writes.length, 1);
    assert.equal(h.session.getState().presentation, 'error');
  });
}
