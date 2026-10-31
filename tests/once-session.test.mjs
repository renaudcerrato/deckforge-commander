import test from 'node:test';
import assert from 'node:assert/strict';
import { createOnceSession, ONCE_HOLD_MS } from '../src/core/once-session.mjs';
import { createOnceStateCoordinator } from '../src/core/once-settings.mjs';
import { parseOutputUpdate } from '../src/core/output-update.mjs';
import { createPrimitiveArtwork } from '../src/core/primitive-artwork.mjs';
import { assertSvgElement } from './helpers/svg-harness.mjs';

const options = { timeout: 3000 };
const base = { executable: '/synthetic/report.PY', argsText: '' };
const success = { status: 'success' };
const ordinary = 'Program exited unsuccessfully.';
const images = h => h.events.filter(event => event[0] === 'image').map(event => event[1]);
const errors = h => h.events.filter(event => event[0] === 'error');
const cards = h => h.events.filter(event => ['ready', 'loading'].includes(event[0]));
const svg = value => decodeURIComponent(value.slice('data:image/svg+xml,'.length));

for (const diagnosis of ['display', 'protocol', 'cleanup']) {
  test(`P3 Once pending image rejection preserves ${diagnosis} priority and stops automation`, options, async () => {
    // Arrange: the real lifecycle owns diagnosis selection; only image handoff is held.
    const gate = deferred(), entered = deferred();
    const h = harness({ image() { entered.resolve(); return gate.promise; } });
    await h.appear(); await h.tap();
    h.runs[0].callbacks.onUpdate(parseOutputUpdate('<svg>pending</svg>')); await entered.promise;
    // Act
    if (diagnosis !== 'display') h.runs[0].callbacks.onError('Image protocol error.');
    if (diagnosis === 'cleanup') h.runs[0].stopResult = false;
    gate.reject(new Error('synthetic image boundary')); await h.session.whenIdle();
    const beforeLate = [...h.events];
    h.runs[0].callbacks.onUpdate(parseOutputUpdate('<svg>late</svg>')); await h.advance(100000);
    // Assert: protocol/cleanup outrank the later display failure without bypassing safe stop.
    assert.equal(errors(h).at(-1)?.[2], diagnosis === 'protocol' ? 'IMAGE_PROTOCOL_ERROR'
      : diagnosis === 'cleanup' ? 'CLEANUP_BLOCKED' : 'FRAME_SEND_FAILED');
    assert.equal(h.runs[0].stops, 1); assert.equal(h.runs.length, 1);
    assert.equal(h.session.getState().suspended, true); assert.deepEqual(h.events, beforeLate);
  });
}

test('TITLE-1 Run custom Ready, Loading and no-output Success clear to dynamic executable fallback', options, async () => {
  // Arrange
  const h = harness(); await h.appear({ ...base, title: 'a/b.txt' }); const ready = cards(h).at(-1);
  // Act
  await h.tap(); const loading = cards(h).at(-1); await h.finish(); const completed = cards(h).at(-1);
  await h.edit({ title: '' }); await h.advance(100000);
  // Assert
  assert.equal(ready[1], 'a/b.txt'); assert.equal(ready[4], '.py'); assert.equal(loading[1], 'a/b.txt');
  assert.equal(completed[1], 'a/b.txt'); assert.equal(completed[2], 'success');
  assert.equal(cards(h).at(-1)[1], 'report'); assert.equal(cards(h).at(-1)[2], 'success');
  assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 0); assert.deepEqual(errors(h), []);
});
test('TITLE-1 Run title-only edits preserve Setup and fatal protocol errors without redraw', options, async () => {
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
test('TITLE-1 Run title plus theme redraws primitives and title plus execution stops without a new attempt', options, async () => {
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
test('TITLE-1 Run title edit cannot displace queued final producer output', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred(), first = parseOutputUpdate('<svg>title-first</svg>');
  const h = harness({ async image(value) { if (value === first.image) { entered.resolve(); await gate.promise; } } });
  await h.appear(); await h.tap(); h.runs[0].callbacks.onUpdate(first); await entered.promise;
  const final = parseOutputUpdate('text:final'); h.runs[0].callbacks.onUpdate(final);
  // Act
  const editing = h.edit({ title: 'edited' }), finishing = h.finish(); gate.resolve(); await Promise.all([editing, finishing]);
  // Assert
  assert.deepEqual(images(h), [first.image, createPrimitiveArtwork(final)]);
  assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 0); assert.deepEqual(errors(h), []);
});
test('TITLE-1 Run title edit preserves a pending start across the Loading handoff', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred(); let first = true;
  const h = harness({ async presentation(kind) { if (kind === 'loading' && first) { first = false; entered.resolve(); await gate.promise; } } });
  await h.appear(); const tapping = h.tap(); await entered.promise;
  // Act
  const editing = h.edit({ title: 'new title' }); gate.resolve(); await Promise.all([tapping, editing]);
  // Assert
  assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 0); assert.equal(h.session.getState().phase, 'running');
  assert.equal(cards(h).at(-1)[1], 'new title'); assert.deepEqual(errors(h), []);
});
for (const wire of ['text:hello', 'progress:17/23', '<svg>opaque</svg>']) {
  test(`TITLE-1 Run title edits preserve live and retained producer ${wire.split(':')[0]}`, options, async () => {
    // Arrange
    const h = harness(); await h.appear(); await h.tap();
    h.runs[0].callbacks.onUpdate(parseOutputUpdate(wire)); await h.session.whenIdle(); const live = [...h.events];
    // Act
    await h.edit({ title: 'a/b.txt' }); const afterLive = [...h.events]; await h.finish();
    const retained = [...h.events]; await h.edit({ title: '' }); await h.advance(100000);
    // Assert
    assert.deepEqual(afterLive, live); assert.deepEqual(h.events, retained);
    assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 0); assert.deepEqual(errors(h), []);
  });
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
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
      for (const [key, timer] of [...timers].sort((a, b) => a[1].due - b[1].due)) {
        if (timer.due > time || !timers.has(key)) continue;
        timers.delete(key); timer.callback();
      }
    },
  };
}
// Objective: real Once policy, authority, parsing, rendering and queue; no actual child or SDK.
function harness(overrides = {}) {
  const time = clock(), events = [], runs = [], writes = [], confirmations = [];
  let host = {};
  const coordinator = createOnceStateCoordinator({
    platform: overrides.platform ?? 'posix',
    async writeSettings(value) {
      writes.push(structuredClone(value));
      if (overrides.write) await overrides.write(value);
      host = structuredClone(value);
    },
    async readSettings() { return overrides.read ? overrides.read(host) : structuredClone(host); },
    setTimer: time.setTimer, clearTimer: time.clearTimer,
  });
  const session = createOnceSession({
    platform: overrides.platform ?? 'posix',
    initialConnected: true, now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer,
    async awaitConfiguration(expected) {
      confirmations.push(structuredClone(expected));
      if (overrides.confirm && (await overrides.confirm(expected)) !== true) return false;
      await coordinator.whenIdle();
      return !coordinator.isBlocked() && snapshotsEqual(expected, coordinator.getSettings());
    },
    startRun(execution, callbacks) {
      if (overrides.start) overrides.start(execution);
      const done = deferred();
      const run = { execution: structuredClone(execution), callbacks, done, stops: 0,
        stopResult: true, stopGate: undefined, stopEntered: deferred() };
      runs.push(run); events.push(['spawn']);
      return { done: done.promise, async stop() {
        run.stops++; run.stopEntered.resolve();
        const certain = run.stopGate ? await run.stopGate.promise : run.stopResult;
        done.resolve({ status: 'stopped' }); return certain;
      } };
    },
    async setTitle(title, current) {
      if (overrides.title) await overrides.title(title, current);
      if (current()) events.push(['title', title]);
    },
    async setImage(image, current) {
      if (current()) events.push(['image', image]);
      if (overrides.image) await overrides.image(image, current);
    },
    async onError(message, code, current, theme) {
      if (current()) events.push(['error', message, code, theme]);
    },
    async onPresentation(kind, caption, current, theme, footer, extension) {
      if (overrides.presentation) await overrides.presentation(kind, current);
      if (current()) events.push([kind, caption, footer, theme, extension]);
    },
  });
  return { session, coordinator, time, events, runs, writes, confirmations,
    async appear(input = base) { await session.appear(coordinator.observe(input).settings); await session.whenIdle(); },
    async edit(changes) {
      const saved = coordinator.editConfiguration(changes).catch(error => error);
      const applied = session.applySettings(coordinator.getSettings());
      await saved; await applied; await session.whenIdle();
    },
    async tap() { await session.keyDown(); await session.keyUp(); await session.whenIdle(); },
    async finish(result = success, run = runs.at(-1)) {
      run.done.resolve(result); await Promise.resolve(); await session.whenIdle();
    },
    async advance(ms, deliver = true) { time.advance(ms, deliver); await session.whenIdle(); },
  };
}
function snapshotsEqual(first, second) { try { assert.deepEqual(first, second); return true; } catch { return false; } }

// S2: Windows configuration keeps Run's explicit-release and retained-success policy.
test('Windows Run retains successful output and does not retry on theme edits or reconnect', options, async () => {
  // Arrange
  const h = harness({ platform: 'win32' }), input = { executable: String.raw`C:\folder\report.PY`, argsText: '' };
  await h.appear(input); const fresh = h.runs.length; await h.tap();
  h.runs[0].callbacks.onUpdate(parseOutputUpdate('text:retained')); await h.session.whenIdle(); await h.finish();
  // Act
  await h.edit({ themeColor: '#abcdef' }); await h.advance(100000);
  const retained = images(h).at(-1); await h.session.setConnected(false); await h.session.setConnected(true); await h.session.whenIdle();
  const before = [...images(h)]; h.runs[0].callbacks.onUpdate(parseOutputUpdate('text:stale')); await h.session.whenIdle();
  // Assert
  assert.equal(fresh, 0); assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 0);
  assert.deepEqual(h.runs[0].execution, { executable: input.executable, args: [] }); assert.match(svg(retained), />retained<\/text>/);
  assert.deepEqual(images(h), before); assert.deepEqual(h.writes, [{ ...input, themeColor: '#abcdef' }]);
  assert.equal(Object.hasOwn(h.session.getState(), 'dueMs'), false);
});
test('Windows Run uncertain cleanup permits saves but consumes busy gestures and prevents replacement', options, async () => {
  // Arrange
  const h = harness({ platform: 'win32' }), input = { executable: 'C:/first.EXE', argsText: '' };
  await h.appear(input); await h.tap(); h.runs[0].stopResult = false;
  // Act
  await h.tap(); const busyCount = h.runs.length;
  await h.edit({ executable: 'D:/next.EXE' }); await h.tap(); await h.advance(100000);
  // Assert
  assert.equal(busyCount, 1); assert.equal(h.runs.length, 1); assert.equal(h.session.getState().cleanupBlocked, true);
  assert.deepEqual(h.writes, [{ ...input, executable: 'D:/next.EXE' }]);
});

test('Run retains a successful card through theme edits without retry or stale replacement', options, async () => {
  // Arrange
  const h = harness(); await h.appear(); await h.tap();
  const record = parseOutputUpdate('card:AAAA BBBB|header:API;footer:HTTP 200;footer-color:ivory;font:mono;font-size:24;header-gap:0;footer-gap:12.5;overflow:wrap');
  h.runs[0].callbacks.onUpdate(record); await h.session.whenIdle(); await h.finish();
  const original = svg(images(h).at(-1));
  // Act
  h.runs[0].callbacks.onUpdate({ ...record, value: 'bad\0' });
  await h.edit({ themeColor: '#abcdef' }); await h.advance(100000000);
  const rendered = svg(images(h).at(-1));
  // Assert
  assert.match(rendered, /fill="#abcdef"[^>]*>API<\/text>/);
  assert.match(rendered, /fill="#abcdef"[^>]*>AAAA<\/text>/);
  assert.match(rendered, /fill="#abcdef"[^>]*>BBBB<\/text>/);
  assert.match(rendered, /fill="#fffff0"[^>]*>HTTP 200<\/text>/);
  assert.deepEqual([...rendered.matchAll(/<text\b[^>]*y="([^"]*)"/g)].map(match => match[1]), [...original.matchAll(/<text\b[^>]*y="([^"]*)"/g)].map(match => match[1]));
  assert.equal(h.session.getState().phase, 'stopped'); assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0].stops, 0); assert.deepEqual(errors(h), []);
});

// Slice 3: successful captions stay visible, with cosmetics but no retry or persisted intent.
// Slice 4: retained hard-line output is presentation data, never retry intent.
for (const stage of ['running', 'completed']) {
  test(`Run ${stage} hard-line redraw retains immutable LF without retry and rejects forged fields`, options, async () => {
    // Arrange
    const h = harness(); await h.appear(); await h.tap();
    const record = parseOutputUpdate(String.raw`text:A\n\nB|font-size:16;border:2`);
    const mutable = { ...record, options: { ...record.options }, overrides: { ...record.overrides } };
    h.runs[0].callbacks.onUpdate(mutable); await h.session.whenIdle();
    if (stage === 'completed') await h.finish();
    // Act
    mutable.value = 'mutated'; mutable.options['font-size'] = 48;
    h.runs[0].callbacks.onUpdate({ ...record, hardBreaks: true });
    await h.edit({ themeColor: '#abcdef' }); await h.advance(100000000);
    const rendered = svg(images(h).at(-1));
    // Assert
    assert.deepEqual([...rendered.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map(match => match[1]), ['A', '', 'B']);
    assert.deepEqual([...rendered.matchAll(/<text\b[^>]*fill="([^"]*)"/g)].map(match => match[1]), Array(3).fill('#abcdef'));
    assert.equal(record.value, 'A\n\nB'); assert.equal(h.session.getState().phase, stage === 'running' ? 'running' : 'stopped');
    assert.equal(Object.hasOwn(h.session.getState(), 'dueMs'), false);
    assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 0); assert.deepEqual(errors(h), []);
    assert.deepEqual(h.writes, [{ ...base, themeColor: '#abcdef' }]);
  });
}
test('Run final hard lines drain despite forged fields and reject stale callbacks without retry', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred(), first = parseOutputUpdate('<svg>hard-first</svg>');
  const h = harness({ async image(value) { if (value === first.image) { entered.resolve(); await gate.promise; } } });
  await h.appear(); await h.tap(); h.runs[0].callbacks.onUpdate(first); await entered.promise;
  const final = parseOutputUpdate(String.raw`text:A\n\nB|font-size:16`);
  // Act
  h.runs[0].callbacks.onUpdate(final);
  h.runs[0].callbacks.onUpdate({ ...final, hardBreaks: true });
  h.runs[0].callbacks.onUpdate({ ...final, value: 'bad\0' });
  h.runs[0].callbacks.onUpdate({ ...final, options: { ...final.options, 'max-lines': 2 } });
  h.runs[0].done.resolve(success); await Promise.resolve();
  const before = [...images(h)]; gate.resolve(); await h.session.whenIdle();
  h.runs[0].callbacks.onUpdate(parseOutputUpdate(String.raw`text:stale\ncallback`)); await h.advance(100000000);
  // Assert
  assert.deepEqual(before, [first.image]); assert.deepEqual(images(h), [first.image, createPrimitiveArtwork(final)]);
  assert.equal(h.session.getState().phase, 'stopped'); assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0].stops, 0); assert.deepEqual(errors(h), []); assert.deepEqual(h.writes, []);
});
for (const stage of ['running', 'completed']) {
  test(`Run ${stage} caption redraw preserves immutable output without retry`, options, async () => {
    // Arrange: renderer tests own the position/font/color combinations.
    const h = harness(); await h.appear(); await h.tap();
    const record = parseOutputUpdate('text:42|font-size:48;label:Items;label-size:14.25;label-position:above;border:2;label-color:ivory');
    const before = JSON.stringify(record);
    const mutable = { ...record, options: { ...record.options }, overrides: { ...record.overrides } };
    h.runs[0].callbacks.onUpdate(mutable); await h.session.whenIdle();
    if (stage === 'completed') await h.finish();
    // Act
    mutable.value = 'mutated'; mutable.options['label-position'] = 'center'; mutable.overrides['label-position'] = 'center';
    await h.edit({ themeColor: '#abcdef' }); await h.advance(100000000);
    const rendered = svg(images(h).at(-1));
    // Assert
    assert.deepEqual([...rendered.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map(match => match[1]), ['Items', '42']);
    assert.match(rendered, /stroke="#abcdef"/);
    assert.equal(JSON.stringify(record), before); assert.equal(h.session.getState().phase, stage === 'running' ? 'running' : 'stopped');
    assert.equal(Object.hasOwn(h.session.getState(), 'dueMs'), false);
    assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 0); assert.deepEqual(errors(h), []);
    assert.deepEqual(h.writes, [{ ...base, themeColor: '#abcdef' }]);
  });
}
test('Run final caption drains once despite invalid caption callbacks and rejects late terminal content', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred(), first = parseOutputUpdate('<svg>caption-first</svg>');
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
  const missing = { ...final.options }; delete missing.label;
  h.runs[0].callbacks.onUpdate({ ...final, options: missing });
  h.runs[0].callbacks.onUpdate({ ...final, options: { ...final.options, 'label-color': 'accent' } });
  h.runs[0].callbacks.onUpdate({ ...final, overrides: { ...final.overrides, 'label-color': 'blue' } });
  h.runs[0].done.resolve(success); await Promise.resolve();
  const before = [...images(h)]; gate.resolve(); await h.session.whenIdle();
  h.runs[0].callbacks.onUpdate(parseOutputUpdate('text:late|label:stale')); await h.advance(100000000);
  // Assert
  assert.deepEqual(before, [first.image]); assert.deepEqual(images(h), [first.image, createPrimitiveArtwork(final)]);
  assert.equal(h.session.getState().phase, 'stopped'); assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0].stops, 0); assert.deepEqual(errors(h), []); assert.deepEqual(h.writes, []);
});

// Slice 2: display-only terminal-looking captions do not stop, retry, or create intent.
for (const stage of ['running', 'completed']) {
  for (const [suffix, caption] of [['', '1.6%'], [';display:100%', '100%'], [';display:', undefined], [';display:success;value-position:none', undefined]]) {
    test(`Run ${stage} ratio ${suffix || 'default'} redraw preserves geometry without retries`, options, async () => {
      // Arrange
      const h = harness(); await h.appear(); await h.tap();
      const record = parseOutputUpdate(`progress:17/1034|border:2;value-color:accent${suffix}`);
      h.runs[0].callbacks.onUpdate(record); await h.session.whenIdle();
      if (stage === 'completed') await h.finish();
      const original = svg(images(h).at(-1));
      // Act
      await h.edit({ themeColor: '#abcdef' }); await h.advance(100000000);
      const rendered = svg(images(h).at(-1));
      // Assert
      assert.deepEqual([...rendered.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map(match => match[1]), caption ? [caption] : []);
      assert.equal(/stroke-dasharray="([^"]*)"/.exec(rendered)[1], /stroke-dasharray="([^"]*)"/.exec(original)[1]);
      assert.equal(record.value, 1700 / 1034); assert.match(rendered, /stroke="#abcdef"/);
      assert.equal(h.session.getState().phase, stage === 'running' ? 'running' : 'stopped');
      assert.equal(Object.hasOwn(h.session.getState(), 'dueMs'), false);
      assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 0); assert.deepEqual(errors(h), []);
      assert.deepEqual(h.writes, [{ ...base, themeColor: '#abcdef' }]);
    });
  }
}
test('Run final ratio drains once despite forged/missing display and late terminal callbacks', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred(), first = parseOutputUpdate('<svg>first</svg>');
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
  const before = [...images(h)]; gate.resolve(); await h.session.whenIdle();
  h.runs[0].callbacks.onUpdate(parseOutputUpdate('progress:1/2|display:late')); await h.advance(100000000);
  // Assert
  assert.deepEqual(before, [first.image]); assert.deepEqual(images(h), [first.image, createPrimitiveArtwork(final)]);
  assert.equal(h.session.getState().phase, 'stopped'); assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0].stops, 0); assert.deepEqual(errors(h), []); assert.deepEqual(h.writes, []);
});

// Slice 1: Run keeps successful output without introducing retries or persisted attempt intent.
for (const stage of ['running', 'completed']) {
  for (const fill of ['', ';color:red']) {
    for (const [annotation, expected] of [
      ['', ['#ffffff', '#ffffff']],
      [';value-color:accent', [fill ? '#ff0000' : '#abcdef', '#ffffff']],
      [';label-color:accent', ['#ffffff', fill ? '#ff0000' : '#abcdef']],
      [';value-color:accent;label-color:accent', Array(2).fill(fill ? '#ff0000' : '#abcdef')],
      [';value-color:ivory;label-color:blue', ['#fffff0', '#0000ff']],
    ]) {
      test(`Run ${stage} theme redraw ${fill || 'implicit'} ${annotation || 'white'} stays one-shot`, options, async () => {
        // Arrange
        const h = harness(); await h.appear(); await h.tap();
        const record = parseOutputUpdate(`progress:42|label:Hi;border:2${fill}${annotation}`);
        h.runs[0].callbacks.onUpdate(record); await h.session.whenIdle();
        if (stage === 'completed') await h.finish();
        const before = JSON.stringify(record);
        // Act
        await h.edit({ themeColor: '#abcdef' }); await h.advance(100000000);
        const rendered = svg(images(h).at(-1));
        // Assert
        assert.deepEqual([...rendered.matchAll(/<text\b[^>]*fill="([^"]*)"/g)].map(match => match[1]), expected);
        assertSvgElement(rendered, 'rect', { stroke: '#abcdef' }, { 'stroke-width': 2 });
        assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 0);
        assert.equal(h.session.getState().phase, stage === 'running' ? 'running' : 'stopped');
        assert.equal(Object.hasOwn(h.session.getState(), 'dueMs'), false);
        assert.deepEqual(h.writes, [{ ...base, themeColor: '#abcdef' }]);
        assert.equal(JSON.stringify(record), before);
      });
    }
  }
}

test('Once starts only on short release, translates Loading and exposes no Loop scheduling state', options, async () => {
  // Arrange
  const h = harness(); await h.appear();
  // Act
  await h.session.keyDown(); await h.session.keyDown(); const downCount = h.runs.length;
  await h.session.keyUp(); await h.session.keyUp(); await h.session.whenIdle();
  // Assert
  assert.equal(ONCE_HOLD_MS, 1000); assert.equal(downCount, 0); assert.equal(h.runs.length, 1);
  assert.deepEqual(cards(h), [['ready', 'report', 'ready', '#969696', '.py'], ['loading', 'report', 'ready', '#969696', '.py']]);
  const state = h.session.getState(); assert.equal(state.phase, 'running'); assert.equal(state.presentation, 'loading');
  assert.equal(Object.hasOwn(state, 'enabled'), false); assert.equal(Object.hasOwn(state, 'dueMs'), false);
  assert.deepEqual(h.writes, []);
});
for (const duration of [999, 1000, 1001]) {
  for (const deliver of [true, false]) {
    test(`Once idle ${duration}ms gesture with timer delivery ${deliver} never preliminarily launches`, options, async () => {
      // Arrange
      const h = harness(); await h.appear();
      // Act
      await h.session.keyDown(); await h.advance(duration, deliver); const before = h.runs.length;
      await h.session.keyUp(); await h.session.keyUp(); await h.session.whenIdle();
      // Assert
      assert.equal(before, 0); assert.equal(h.runs.length, duration < 1000 ? 1 : 0);
      assert.deepEqual(h.writes, []); assert.deepEqual(errors(h), []);
    });
  }
}
for (const input of [{}, { executable: '' }, { args: ['literal'], cwd: '/synthetic/work', themeColor: 'invalid theme' }]) {
  for (const duration of [0, 999, 1000, 1001]) {
    test(`Once setup gesture ${duration}ms is a complete no-op`, options, async () => {
      // Arrange
      const h = harness(); await h.appear(input); const before = h.session.getState();
      // Act
      await h.session.keyDown(); await h.advance(duration); await h.session.keyUp(); await h.session.whenIdle();
      // Assert
      assert.deepEqual(h.session.getState(), before); assert.equal(cards(h).at(-1)[2], 'setup required');
      assert.deepEqual(h.runs, []); assert.deepEqual(h.writes, []); assert.deepEqual(errors(h), []);
    });
  }
}
test('Once setup gesture remains consumed across a configuration edit', options, async () => {
  // Arrange
  const h = harness(); await h.appear({});
  // Act
  await h.session.keyDown(); await h.edit({ executable: base.executable }); await h.session.keyUp(); await h.session.whenIdle();
  // Assert
  assert.equal(cards(h).at(-1)[2], 'ready'); assert.deepEqual(h.runs, []);
  assert.deepEqual(h.writes, [base]);
});
test('Once busy press released after completion is consumed rather than becoming another attempt', options, async () => {
  // Arrange
  const h = harness(); await h.appear(); await h.tap();
  // Act
  await h.session.keyDown(); await h.finish(); await h.session.keyUp(); await h.session.whenIdle();
  await h.advance(100000000);
  // Assert
  assert.equal(h.runs.length, 1); assert.equal(h.session.getState().phase, 'stopped');
  assert.equal(cards(h).at(-1)[2], 'success'); assert.deepEqual(h.writes, []);
});
test('Once busy short taps are ignored but a hold stops the owned child exactly once', options, async () => {
  // Arrange
  const h = harness(); await h.appear(); await h.tap();
  // Act
  await h.tap(); await h.session.keyDown(); await h.advance(1000); await h.session.keyDown();
  await h.session.keyUp(); await h.session.keyUp(); await h.session.whenIdle(); await h.advance(100000000);
  // Assert
  assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 1);
  assert.equal(h.session.getState().phase, 'stopped'); assert.deepEqual(h.writes, []);
});
test('Once cleanup held at stop prevents all replacement attempts', options, async () => {
  // Arrange
  const h = harness(); await h.appear(); await h.tap(); const run = h.runs[0]; run.stopGate = deferred();
  // Act
  await h.session.keyDown(); h.time.advance(1000); await run.stopEntered.promise;
  const release = h.session.keyUp(); const tap = h.tap(); const count = h.runs.length;
  run.stopGate.resolve(true); await Promise.all([release, tap]); await h.session.whenIdle();
  // Assert
  assert.equal(count, 1); assert.equal(h.runs.length, 1); assert.equal(run.stops, 1);
});
for (const record of ['text:cafe\u0301', 'progress:42.5|label:done', '<svg>opaque</svg>']) {
  test('Once accepted final output drains, remains immutable and never schedules another run', options, async () => {
    // Arrange
    const entered = deferred(), gate = deferred();
    const h = harness({ async image() { entered.resolve(); await gate.promise; } });
    await h.appear(); await h.tap(); const update = structuredClone(parseOutputUpdate(record));
    // Act
    h.runs[0].callbacks.onUpdate(update); await entered.promise;
    if (update.kind === 'text') update.value = 'mutated';
    const finishing = h.finish(); const phase = h.session.getState().phase;
    gate.resolve(); await finishing; await h.advance(100000000);
    h.runs[0].callbacks.onUpdate(parseOutputUpdate('text:late')); await h.session.whenIdle();
    // Assert
    assert.notEqual(phase, 'stopped'); assert.equal(h.session.getState().phase, 'stopped');
    assert.equal(h.session.getState().presentation, 'streaming'); assert.equal(h.runs.length, 1);
    assert.equal(images(h).length, 1); assert.equal(svg(images(h)[0]).includes('mutated'), false);
    assert.equal(cards(h).some(card => card[2] === 'success'), false); assert.deepEqual(h.writes, []);
  });
}
for (const output of [undefined, 'text:retained', '<svg>opaque</svg>']) {
  test('Once subsequent manual attempt preserves the prior outcome without a Loading flash', options, async () => {
    // Arrange
    const h = harness(); await h.appear(); await h.tap();
    if (output) { h.runs[0].callbacks.onUpdate(parseOutputUpdate(output)); await h.session.whenIdle(); }
    await h.finish(); const count = cards(h).length;
    // Act
    await h.advance(100000000); await h.tap();
    // Assert
    assert.equal(h.runs.length, 2); assert.equal(cards(h).length, count); assert.deepEqual(h.writes, []);
  });
}
for (const output of [undefined, 'text:retained', '<svg>opaque</svg>']) {
  test('Once completed outcome survives cosmetics, unchanged settings, equivalent migration and availability', options, async () => {
    // Arrange
    const initial = { executable: base.executable, args: [] };
    const h = harness(); await h.appear(initial); await h.tap();
    if (output) { h.runs[0].callbacks.onUpdate(parseOutputUpdate(output)); await h.session.whenIdle(); }
    await h.finish(); const beforeImages = images(h).length;
    // Act
    await h.edit({ themeColor: '#ABCDEF' });
    const afterTheme = images(h).length;
    await h.session.applySettings(h.coordinator.getSettings());
    await h.edit({ argsText: '' });
    await h.session.disappear(); await h.session.appear(h.coordinator.getSettings());
    await h.session.setConnected(false); await h.session.setConnected(true);
    await h.session.reconcileAvailability(); await h.session.whenIdle(); await h.advance(100000000);
    // Assert
    assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 0);
    assert.equal(h.session.getState().presentation, output ? 'streaming' : 'ready');
    if (!output) assert.equal(cards(h).at(-1)[2], 'success');
    else if (output.startsWith('<svg>')) assert.equal(afterTheme, beforeImages);
    else { assert.ok(afterTheme > beforeImages); assert.ok(svg(images(h).at(-1)).includes('#abcdef')); }
    assert.deepEqual(h.writes, [{ ...initial, themeColor: '#abcdef' },
      { ...initial, themeColor: '#abcdef', argsText: '' }]);
  });
}
test('Once meaningful execution edit stops, resets Ready after confirmation and never auto-starts', options, async () => {
  // Arrange
  const h = harness(); await h.appear(); await h.tap(); h.runs[0].callbacks.onUpdate(parseOutputUpdate('text:old'));
  await h.session.whenIdle();
  // Act
  await h.edit({ executable: '/synthetic/new.sh', argsText: 'literal' });
  h.runs[0].callbacks.onUpdate(parseOutputUpdate('text:stale')); await h.advance(100000000);
  // Assert
  assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 1);
  assert.deepEqual(cards(h).at(-1), ['ready', 'new', 'ready', '#969696', '.sh']);
  assert.deepEqual(h.writes, [{ executable: '/synthetic/new.sh', argsText: 'literal' }]);
});
for (const diagnostic of ['PROCESS_EXITED_NONZERO', 'PROCESS_TERMINATED_BY_SIGNAL']) {
  test(`Once ${diagnostic} shows Error without repeating and allows only a later deliberate retry`, options, async () => {
    // Arrange
    const h = harness(); await h.appear(); await h.tap();
    // Act
    h.runs[0].callbacks.onDiagnostic(diagnostic); h.runs[0].callbacks.onError(ordinary);
    await h.finish({ status: 'error', error: ordinary }); await h.advance(100000000);
    const count = h.runs.length, error = errors(h).at(-1); await h.tap();
    // Assert
    assert.equal(count, 1); assert.equal(error[2], diagnostic); assert.equal(h.runs.length, 2);
    assert.deepEqual(h.writes, []);
  });
}
for (const message of ['Image protocol error.', 'Program launch failed.']) {
  test('Once fatal errors cannot auto-retry or be cleared by holds/theme but eligible taps recover', options, async () => {
    // Arrange
    const h = harness(); await h.appear(); await h.tap();
    h.runs[0].callbacks.onError(message); await h.finish({ status: 'error', error: message });
    // Act
    await h.edit({ themeColor: '#abcdef' }); await h.session.keyDown(); await h.advance(1000);
    await h.session.keyUp(); await h.session.whenIdle(); await h.advance(100000000);
    const suspended = h.session.getState().suspended, count = h.runs.length; await h.tap();
    // Assert
    assert.equal(suspended, true); assert.equal(count, 1); assert.equal(h.runs.length, 2);
    assert.equal(h.session.getState().protocolBlocked, false);
  });
}
test('Once uncertain cleanup permanently blocks replacement and execution recovery', options, async () => {
  // Arrange
  const h = harness(); await h.appear(); await h.tap(); h.runs[0].stopResult = false;
  // Act
  await h.session.keyDown(); await h.advance(1000); await h.session.keyUp(); await h.session.whenIdle();
  await h.tap(); await h.session.applySettings({ ...base, argsText: 'new' }); await h.session.whenIdle();
  // Assert
  assert.equal(h.runs.length, 1); assert.equal(h.session.getState().cleanupBlocked, true);
  assert.equal(errors(h).at(-1)[2], 'CLEANUP_BLOCKED'); assert.deepEqual(h.writes, []);
});
for (const failure of ['false', 'reject']) {
  test(`Once latest configuration ${failure} blocks Ready, launch and all later recovery`, options, async () => {
    // Arrange
    const h = harness({ async confirm() { if (failure === 'reject') throw Error('synthetic boundary'); return false; } });
    // Act
    await h.appear(); await h.tap(); await h.session.reconcileAvailability(); await h.session.whenIdle();
    // Assert
    assert.deepEqual(h.runs, []); assert.deepEqual(cards(h), []);
    assert.equal(h.session.getState().persistenceBlocked, true); assert.equal(errors(h).at(-1)[2], 'STATE_SAVE_FAILED');
    assert.deepEqual(h.writes, []);
  });
}
test('Once pending configuration publishes no Ready until authoritative confirmation', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred();
  const h = harness({ async confirm() { entered.resolve(); return gate.promise; } });
  // Act
  const appearing = h.appear(); await entered.promise;
  const pending = h.session.getState(), count = cards(h).length; gate.resolve(true); await appearing;
  // Assert
  assert.equal(pending.configurationPending, true); assert.equal(count, 0);
  assert.equal(cards(h).at(-1)[2], 'ready'); assert.deepEqual(h.runs, []);
});
test('Once superseded failed confirmation cannot latch over the latest valid configuration', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred(); let first = true;
  const h = harness({ async confirm() { if (first) { first = false; entered.resolve(); return gate.promise; } return true; } });
  // Act
  const appearing = h.appear(); await entered.promise;
  const editing = h.edit({ themeColor: '#abcdef' }); gate.resolve(false); await Promise.all([appearing, editing]);
  // Assert
  assert.equal(h.session.getState().persistenceBlocked, false); assert.deepEqual(errors(h), []);
  assert.equal(cards(h).at(-1)[3], '#abcdef'); assert.deepEqual(h.runs, []);
});
test('Once pending Loading hide consumes the request and availability never restarts it', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred();
  const h = harness({ async presentation(kind) { if (kind === 'loading') { entered.resolve(); await gate.promise; } } });
  await h.appear();
  // Act
  const tap = h.tap(); await entered.promise; const hiding = h.session.disappear(); gate.resolve();
  await Promise.all([tap, hiding]); await h.appear(); await h.session.reconcileAvailability(); await h.advance(100000000);
  // Assert
  assert.deepEqual(h.runs, []); assert.equal(h.session.getState().phase, 'stopped');
  assert.equal(cards(h).at(-1)[2], 'ready'); assert.deepEqual(h.writes, []);
});
test('Once hidden child finishes locally without display and returns retained output without launching', options, async () => {
  // Arrange
  const h = harness(); await h.appear(); await h.tap();
  // Act
  await h.session.disappear(); const count = h.events.length;
  h.runs[0].callbacks.onUpdate(parseOutputUpdate('text:hidden')); await h.finish(); const hiddenCount = h.events.length;
  await h.appear(); await h.session.reconcileAvailability(); await h.advance(100000000);
  // Assert
  assert.equal(hiddenCount, count); assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 0);
  assert.equal(h.session.getState().phase, 'stopped'); assert.ok(svg(images(h).at(-1)).includes('hidden'));
});
test('Once disconnect stops an active child and reconnect never enables another attempt', options, async () => {
  // Arrange
  const h = harness(); await h.appear(); await h.tap();
  // Act
  await h.session.setConnected(false); await h.session.setConnected(true); await h.session.reconcileAvailability();
  await h.advance(100000000);
  // Assert
  assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 1);
  assert.equal(h.session.getState().phase, 'stopped'); assert.deepEqual(h.writes, []);
});
test('Once malformed owned dependency fails with a fixed factory error', () => {
  // Arrange
  const dependencies = { startRun: null };
  // Act
  let error; try { createOnceSession(dependencies); } catch (value) { error = value; }
  // Assert
  assert.ok(error instanceof TypeError); assert.equal(error.message, 'Once session dependencies must be functions.');
});

// Objectives: final-drain/fallback guarantees are shared, but Once never grants a deadline or retry.
test('Run rejects unresolved accent and removed derived fields without replacing its final pending producer', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred(), first = parseOutputUpdate('<svg>first</svg>');
  const h = harness({ async image(value) { if (value === first.image) { entered.resolve(); await gate.promise; } } });
  await h.appear(); await h.tap(); h.runs[0].callbacks.onUpdate(first); await entered.promise;
  const final = parseOutputUpdate('progress:42|label:Hi;value-color:accent;label-color:accent');
  // Act
  h.runs[0].callbacks.onUpdate(final);
  for (const changes of [{ 'label-color': 'accent' }, { annotationColor: '#ffffff' }, { ink: '#ffffff' }, { foreground: 'theme' }]) {
    h.runs[0].callbacks.onUpdate({ ...final, options: { ...final.options, ...changes } });
  }
  h.runs[0].done.resolve(success); await Promise.resolve(); gate.resolve(); await h.session.whenIdle();
  await h.advance(100000000);
  // Assert
  assert.deepEqual(images(h), [first.image, createPrimitiveArtwork(final)]);
  assert.equal(h.session.getState().phase, 'stopped'); assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0].stops, 0); assert.deepEqual(errors(h), []); assert.deepEqual(h.writes, []);
});

test('Once coalesces pending producers and rejects malformed callbacks without evicting the final frame', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred(), first = parseOutputUpdate('<svg>first</svg>');
  const h = harness({ async image(value) { if (value === first.image) { entered.resolve(); await gate.promise; } } });
  await h.appear(); await h.tap(); h.runs[0].callbacks.onUpdate(first); await entered.promise;
  const final = structuredClone(parseOutputUpdate('text:final|color:red')), expected = createPrimitiveArtwork(final);
  // Act
  for (let index = 0; index < 20; index++) h.runs[0].callbacks.onUpdate(parseOutputUpdate(`<svg>pending-${index}</svg>`));
  h.runs[0].callbacks.onUpdate(final); final.value = 'mutated'; final.options.color = '#000000';
  h.runs[0].callbacks.onUpdate(parseOutputUpdate('text:bad|background:transparent'));
  h.runs[0].callbacks.onUpdate({ kind: 'text', value: 'bad', options: {}, overrides: {} });
  h.runs[0].done.resolve(success); await Promise.resolve(); const before = h.session.getState();
  gate.resolve(); await h.session.whenIdle(); await h.advance(100000000);
  // Assert
  assert.equal(before.phase, 'stopping'); assert.deepEqual(images(h), [first.image, expected]);
  assert.equal(h.session.getState().phase, 'stopped'); assert.equal(h.runs.length, 1);
  assert.deepEqual(errors(h), []); assert.deepEqual(h.writes, []);
});
for (const terminal of ['success', 'nonzero', 'signal', 'protocol']) {
  test(`Once ${terminal} drains the producer fallback beneath a declined terminal cosmetic`, options, async () => {
    // Arrange
    const gate = deferred(), entered = deferred(), first = parseOutputUpdate('<svg>first</svg>');
    const h = harness({ async image(value) { if (value === first.image) { entered.resolve(); await gate.promise; } } });
    await h.appear(); await h.tap(); h.runs[0].callbacks.onUpdate(first); await entered.promise;
    const final = parseOutputUpdate('progress:42|label:final;value-color:accent;label-color:accent'), expected = createPrimitiveArtwork(final);
    h.runs[0].callbacks.onUpdate(final);
    // Act
    const recolor = h.edit({ themeColor: '#abcdef' }), run = h.runs[0];
    if (terminal === 'nonzero' || terminal === 'signal') run.callbacks.onDiagnostic(
      terminal === 'signal' ? 'PROCESS_TERMINATED_BY_SIGNAL' : 'PROCESS_EXITED_NONZERO');
    if (terminal === 'protocol') run.callbacks.onError('Image protocol error.');
    run.done.resolve(terminal === 'success' ? success : { status: 'error',
      error: terminal === 'protocol' ? 'Image protocol error.' : ordinary });
    await Promise.resolve(); const before = [...images(h)]; gate.resolve(); await recolor; await h.session.whenIdle();
    await h.advance(100000000);
    // Assert
    assert.deepEqual(before, [first.image]); assert.deepEqual(images(h).slice(0, 2), [first.image, expected]);
    assert.equal(h.runs.length, 1); assert.equal(h.session.getState().phase, 'stopped');
    if (terminal === 'success') assert.ok(svg(images(h).at(-1)).includes('#abcdef'));
    else { assert.equal(images(h).length, 2); assert.equal(errors(h).at(-1)[1],
      terminal === 'protocol' ? 'Image protocol error.' : ordinary); }
  });
}
test('Once an attempted cosmetic image consumes its fallback without duplicating the final producer', options, async () => {
  // Arrange
  const first = deferred(), firstEntered = deferred(), cosmetic = deferred(), cosmeticEntered = deferred();
  const initial = parseOutputUpdate('<svg>first</svg>');
  const h = harness({ async image(value) {
    if (value === initial.image) { firstEntered.resolve(); await first.promise; }
    else { cosmeticEntered.resolve(); await cosmetic.promise; }
  } });
  await h.appear(); await h.tap(); h.runs[0].callbacks.onUpdate(initial); await firstEntered.promise;
  h.runs[0].callbacks.onUpdate(parseOutputUpdate('text:final'));
  // Act
  const recolor = h.edit({ themeColor: '#abcdef' }); first.resolve(); await cosmeticEntered.promise;
  h.runs[0].done.resolve(success); await Promise.resolve(); cosmetic.resolve(); await recolor; await h.session.whenIdle();
  // Assert
  assert.equal(images(h).length, 2); assert.ok(svg(images(h)[1]).includes('#abcdef'));
  assert.equal(h.session.getState().phase, 'stopped'); assert.equal(h.runs.length, 1);
});
for (const transition of ['hold', 'execution', 'hide', 'disconnect', 'persistence']) {
  test(`Once ${transition} invalidates stale queued producer/cosmetic work`, options, async () => {
    // Arrange
    const gate = deferred(), entered = deferred(), initial = parseOutputUpdate('<svg>first</svg>');
    const h = harness({ async image(value) { if (value === initial.image) { entered.resolve(); await gate.promise; } } });
    await h.appear(); await h.tap(); h.runs[0].callbacks.onUpdate(initial); await entered.promise;
    h.runs[0].callbacks.onUpdate(parseOutputUpdate('text:pending'));
    // Act
    const recolor = h.edit({ themeColor: '#abcdef' }); let changing;
    if (transition === 'hold') { void h.session.keyDown(); h.time.advance(1000); changing = h.session.keyUp(); }
    if (transition === 'execution') changing = h.edit({ executable: '/synthetic/new' });
    if (transition === 'hide') changing = h.session.disappear();
    if (transition === 'disconnect') changing = h.session.setConnected(false);
    if (transition === 'persistence') changing = h.session.persistenceFailed();
    gate.resolve(); await Promise.all([recolor, changing]); await h.session.whenIdle();
    // Assert
    assert.deepEqual(images(h), [initial.image]); assert.equal(h.runs.length, 1);
    assert.equal(h.runs[0].stops, transition === 'hide' ? 0 : 1);
  });
}
for (const input of [undefined, null, { kind: 'text', value: 'bad', options: {}, overrides: {} },
  { kind: 'image', image: 'invalid' }]) {
  test('Once invalid callback cannot count as accepted output or suppress no-output Success', options, async () => {
    // Arrange
    const h = harness(); await h.appear(); await h.tap();
    // Act
    h.runs[0].callbacks.onUpdate(input); await h.finish();
    // Assert
    assert.deepEqual(images(h), []); assert.equal(cards(h).at(-1)[2], 'success');
    assert.equal(h.session.getState().phase, 'stopped'); assert.deepEqual(errors(h), []);
  });
}
test('Once accessor output never executes user code or evicts valid producer output', options, async () => {
  // Arrange
  let calls = 0;
  const h = harness(); await h.appear(); await h.tap(); const safe = parseOutputUpdate('<svg>safe</svg>');
  const accessor = { get kind() { calls++; throw Error('synthetic private marker'); } };
  // Act
  h.runs[0].callbacks.onUpdate(safe); h.runs[0].callbacks.onUpdate(accessor); await h.finish();
  // Assert
  assert.equal(calls, 0); assert.deepEqual(images(h), [safe.image]); assert.deepEqual(errors(h), []);
});
test('Once stale title completion cannot hand off an old image after stop and a new attempt', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred(); let held = true;
  const h = harness({ async title() { if (held) { entered.resolve(); await gate.promise; } } });
  await h.appear(); await h.tap(); h.runs[0].callbacks.onUpdate(parseOutputUpdate('<svg>old</svg>')); await entered.promise;
  // Act
  void h.session.keyDown(); h.time.advance(1000); const stopping = h.session.keyUp();
  held = false; gate.resolve(); await stopping; await h.session.whenIdle(); await h.tap();
  h.runs[0].callbacks.onUpdate(parseOutputUpdate('<svg>late</svg>'));
  const latest = parseOutputUpdate('<svg>new</svg>'); h.runs[1].callbacks.onUpdate(latest); await h.session.whenIdle();
  // Assert
  assert.deepEqual(images(h), [latest.image]); assert.equal(h.runs.length, 2); assert.equal(h.runs[0].stops, 1);
});
for (const boundary of ['image', 'title', 'presentation']) {
  test(`Once ${boundary} failure safely stops, latches fixed Error and only a later tap retries`, options, async () => {
    // Arrange
    let fail = true;
    const h = harness({ [boundary]() { if (fail) { fail = false; throw Error('synthetic private marker'); } } });
    await h.appear();
    // Act
    if (boundary !== 'presentation') {
      await h.tap(); h.runs[0].callbacks.onUpdate(parseOutputUpdate('<svg>frame</svg>')); await h.session.whenIdle();
    }
    await h.advance(100000000); const count = h.runs.length, error = errors(h).at(-1);
    await h.tap();
    // Assert
    assert.equal(error[1], 'Frame send failed.'); assert.equal(error[2], 'FRAME_SEND_FAILED');
    assert.equal(h.runs.length, count + 1); assert.deepEqual(h.writes, []);
    if (boundary !== 'presentation') assert.equal(h.runs[0].stops, 1);
  });
}
test('Once thrown launch boundary produces fixed Error without exposing exception or retrying', options, async () => {
  // Arrange
  const h = harness({ start() { throw Error('synthetic private marker'); } }); await h.appear();
  // Act
  await h.tap(); await h.advance(100000000);
  // Assert
  assert.equal(errors(h).at(-1)[1], 'Program launch failed.');
  assert.equal(errors(h).at(-1)[2], 'PROCESS_LAUNCH_FAILED'); assert.equal(h.session.getState().suspended, true);
  assert.equal(JSON.stringify(errors(h)).includes('synthetic private marker'), false); assert.deepEqual(h.writes, []);
});
for (const failure of ['write', 'read', 'mismatch', 'timeout']) {
  test(`Once real coordinator ${failure} failure stops ownership and permanently blocks replacement`, options, async () => {
    // Arrange
    const entered = deferred(), gate = deferred();
    const overrides = failure === 'write' ? { write() { throw Error('synthetic boundary'); } }
      : failure === 'read' ? { read() { throw Error('synthetic boundary'); } }
        : failure === 'mismatch' ? { read() { return base; } }
          : { read() { entered.resolve(); return gate.promise; } };
    const h = harness(overrides); await h.appear(); await h.tap();
    // Act
    const editing = h.edit({ themeColor: '#abcdef' });
    if (failure === 'timeout') { await entered.promise; h.time.advance(5000); }
    await editing; await h.tap(); await h.session.reconcileAvailability(); await h.session.whenIdle();
    const before = h.writes.length;
    const rejected = await h.coordinator.editConfiguration({ argsText: 'replacement' }).catch(error => error);
    // Assert
    assert.equal(rejected.diagnosticCode, 'STATE_SAVE_FAILED'); assert.equal(h.writes.length, before);
    assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 1);
    assert.equal(h.session.getState().persistenceBlocked, true); assert.equal(errors(h).at(-1)[2], 'STATE_SAVE_FAILED');
  });
}
test('Once Loading waits for latest theme confirmation and spawns with an immutable literal execution snapshot', options, async () => {
  // Arrange
  const loading = deferred(), loadingEntered = deferred(), saved = deferred(), saveEntered = deferred();
  const themes = [];
  const h = harness({
    async presentation(kind) { if (kind === 'loading') { loadingEntered.resolve(); await loading.promise; } },
    async write() { saveEntered.resolve(); await saved.promise; },
    start() { themes.push(h.coordinator.getSettings().themeColor); },
  });
  const input = { ...base, argsText: '"two words" \'\' $HOME *.png', themeColor: '#112233' };
  await h.appear(input); void h.session.keyDown(); const launching = h.session.keyUp(); await loadingEntered.promise;
  // Act
  const editing = h.edit({ themeColor: '#ABCDEF' }); await saveEntered.promise;
  loading.resolve(); const before = h.runs.length; saved.resolve(); await launching; await editing; await h.session.whenIdle();
  input.argsText = 'mutated'; input.themeColor = '#000000';
  // Assert
  assert.equal(before, 0); assert.equal(h.runs.length, 1); assert.deepEqual(themes, ['#abcdef']);
  assert.deepEqual(h.runs[0].execution, { executable: base.executable, args: ['two words', '', '$HOME', '*.png'] });
  assert.deepEqual(h.writes, [{ ...base, argsText: '"two words" \'\' $HOME *.png', themeColor: '#abcdef' }]);
  assert.equal(h.runs[0].stops, 0);
});
test('Once execution recovery requires both owned cleanup and latest complete save before Ready', options, async () => {
  // Arrange
  const saved = deferred(), entered = deferred(), stopped = deferred();
  const h = harness({ async write() { entered.resolve(); await saved.promise; } });
  await h.appear(); await h.tap(); h.runs[0].stopGate = stopped;
  // Act
  const editing = h.edit({ executable: '/synthetic/recovered' }); await entered.promise;
  const before = [...cards(h)]; saved.resolve(); stopped.resolve(true); await editing; await h.advance(100000000);
  // Assert
  assert.equal(before.at(-1)[0], 'loading'); assert.deepEqual(cards(h).at(-1), ['ready', 'recovered', 'ready', '#969696', undefined]);
  assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 1);
});
test('Once setup-to-configured pending save neither publishes premature Ready nor revives the setup gesture', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred();
  const h = harness({ async read(host) { entered.resolve(host); return gate.promise; } }); await h.appear({});
  // Act
  await h.session.keyDown(); const editing = h.edit({ executable: base.executable });
  const host = await entered.promise, before = [...cards(h)]; const release = h.session.keyUp();
  gate.resolve(host); await Promise.all([editing, release]); await h.session.whenIdle();
  // Assert
  assert.ok(before.every(card => card[2] === 'setup required')); assert.equal(cards(h).at(-1)[2], 'ready');
  assert.deepEqual(h.runs, []); assert.deepEqual(h.writes, [base]);
});
for (const transition of ['hold', 'disconnect', 'execution']) {
  test(`Once ${transition} cancels a pending Loading attempt without later automatic launch`, options, async () => {
    // Arrange
    const gate = deferred(), entered = deferred();
    const h = harness({ async presentation(kind) { if (kind === 'loading') { entered.resolve(); await gate.promise; } } });
    await h.appear(); const launching = h.tap(); await entered.promise;
    // Act
    let changing;
    if (transition === 'hold') { void h.session.keyDown(); h.time.advance(1000); changing = h.session.keyUp(); }
    if (transition === 'disconnect') changing = h.session.setConnected(false);
    if (transition === 'execution') changing = h.edit({ argsText: 'new' });
    gate.resolve(); await Promise.all([launching, changing]); await h.session.setConnected(true);
    await h.session.reconcileAvailability(); await h.advance(100000000);
    // Assert
    assert.deepEqual(h.runs, []); assert.equal(h.session.getState().phase, 'stopped');
    assert.equal(cards(h).at(-1)[2], 'ready');
    assert.equal(h.writes.length, transition === 'execution' ? 1 : 0);
  });
}
test('Once hide during pending authoritative configuration consumes a release without resuming it', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred();
  const h = harness({ async confirm() { entered.resolve(); return gate.promise; } });
  const appearing = h.appear(); await entered.promise;
  // Act
  void h.session.keyDown(); const launching = h.session.keyUp(), hiding = h.session.disappear();
  gate.resolve(true); await Promise.all([appearing, launching, hiding]); await h.appear(); await h.advance(100000000);
  // Assert
  assert.deepEqual(h.runs, []); assert.equal(h.session.getState().phase, 'stopped'); assert.deepEqual(h.writes, []);
});
test('Once initially invalid stored theme falls back without hydration repair or per-attempt writes', options, async () => {
  // Arrange
  const h = harness(); const input = { ...base, themeColor: 'invalid stored theme' };
  // Act
  await h.appear(input); await h.tap(); await h.finish();
  // Assert
  assert.ok(cards(h).every(card => card[3] === '#969696'));
  assert.deepEqual(h.coordinator.getSettings(), input); assert.deepEqual(h.writes, []);
});
test('Once producer explicit color retains precedence on cosmetic redraw', options, async () => {
  // Arrange
  const h = harness(); await h.appear(); await h.tap();
  h.runs[0].callbacks.onUpdate(parseOutputUpdate('text:explicit|color:red')); await h.finish();
  // Act
  await h.edit({ themeColor: '#abcdef' }); await h.session.refreshAppearance(); await h.session.whenIdle();
  // Assert
  assert.ok(images(h).every(value => svg(value).includes('#ff0000')));
  assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 0);
});
for (const failure of ['display', 'persistence', 'configuration']) {
  test(`Once partial Setup never clears retained ${failure} Error or grants a recovery launch`, options, async () => {
    // Arrange
    let failed = false;
    const h = harness(failure === 'display' ? { presentation() {
      if (!failed) { failed = true; throw Error('synthetic display boundary'); }
    } } : {});
    await h.appear(failure === 'configuration' ? { argsText: "'unterminated" } : {});
    if (failure === 'persistence') await h.session.persistenceFailed();
    if (failure === 'configuration') await h.edit({ argsText: '' });
    const before = h.session.getState(), writes = h.writes.length;
    // Act
    await h.tap(); await h.session.keyDown(); await h.advance(1000); await h.session.keyUp(); await h.session.whenIdle();
    // Assert
    assert.deepEqual(h.runs, []); assert.equal(before.suspended, true); assert.equal(before.presentation, 'error');
    assert.deepEqual(h.session.getState(), before); assert.equal(h.writes.length, writes);
    assert.equal(errors(h).at(-1)[2], { display: 'FRAME_SEND_FAILED', persistence: 'STATE_SAVE_FAILED', configuration: 'ARGS_TEXT_INVALID' }[failure]);
  });
}
test('Once confirmed meaningful execution edit clears an eligible protocol latch without starting', options, async () => {
  // Arrange
  const h = harness(); await h.appear(); await h.tap(); h.runs[0].callbacks.onError('Image protocol error.');
  await h.finish({ status: 'error', error: 'Image protocol error.' });
  // Act
  await h.edit({ argsText: 'fixed' }); await h.advance(100000000);
  // Assert
  assert.equal(h.session.getState().protocolBlocked, false); assert.equal(h.session.getState().suspended, false);
  assert.equal(cards(h).at(-1)[2], 'ready'); assert.equal(h.runs.length, 1);
});
test('Once fresh independent sessions cannot inherit completed output or transient request intent', options, async () => {
  // Arrange
  const first = harness(); await first.appear(); await first.tap();
  first.runs[0].callbacks.onUpdate(parseOutputUpdate('text:retained')); await first.finish();
  const fresh = harness();
  // Act
  await fresh.appear(first.coordinator.getSettings()); await fresh.session.reconcileAvailability(); await fresh.advance(100000000);
  // Assert
  assert.deepEqual(fresh.runs, []); assert.deepEqual(images(fresh), []); assert.equal(cards(fresh).at(-1)[2], 'ready');
  assert.equal(first.session.getState().presentation, 'streaming'); assert.deepEqual(fresh.writes, []);
});
for (const input of [{ ...base, runRequested: true }, { ...base, intervalSeconds: 1 },
  { ...base, actionOnPress: 'stop' }, { executable: 'relative', argsText: '' }]) {
  test('Once stored foreign intent/controls or invalid execution never grant a launch', options, async () => {
    // Arrange
    const h = harness();
    // Act
    await h.appear(input); await h.tap(); await h.advance(100000000);
    // Assert
    assert.deepEqual(h.runs, []); assert.deepEqual(h.writes, []); assert.deepEqual(cards(h), []);
    assert.equal(errors(h).at(-1)[1], 'Invalid settings.'); assert.equal(h.session.getState().suspended, true);
  });
}
test('Once a busy startup short press is consumed even if release arrives after completion', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred();
  const h = harness({ async presentation(kind) { if (kind === 'loading') { entered.resolve(); await gate.promise; } } });
  await h.appear(); const launching = h.tap(); await entered.promise;
  // Act
  const pressing = h.session.keyDown(); gate.resolve(); await launching; await pressing; await h.finish();
  await h.session.keyUp(); await h.session.whenIdle();
  // Assert
  assert.equal(h.runs.length, 1); assert.equal(cards(h).at(-1)[2], 'success'); assert.deepEqual(h.writes, []);
});
test('Once a later no-output attempt does not count the previous successful producer frame', options, async () => {
  // Arrange
  const h = harness(); await h.appear(); await h.tap();
  h.runs[0].callbacks.onUpdate(parseOutputUpdate('<svg>previous</svg>')); await h.finish();
  // Act
  await h.tap(); await h.finish();
  // Assert
  assert.equal(h.runs.length, 2); assert.equal(images(h).length, 1);
  assert.equal(cards(h).at(-1)[2], 'success'); assert.equal(h.session.getState().presentation, 'ready');
});
for (const certain of [true, false]) {
  test(`Once rejected done requires explicit cleanup (${certain}) before replacement eligibility`, options, async () => {
    // Arrange
    const h = harness(); await h.appear(); await h.tap(); h.runs[0].stopResult = certain;
    // Act
    h.runs[0].done.reject(Error('synthetic private marker')); await Promise.resolve(); await h.session.whenIdle();
    await h.advance(100000000); const count = h.runs.length; await h.tap();
    // Assert
    assert.equal(count, 1); assert.equal(h.runs[0].stops, 1); assert.equal(h.runs.length, certain ? 2 : 1);
    assert.equal(h.session.getState().cleanupBlocked, !certain);
    assert.equal(JSON.stringify(errors(h)).includes('synthetic private marker'), false); assert.deepEqual(h.writes, []);
  });
}
for (const terminal of ['success', 'ordinary', 'protocol']) {
  test(`Once hidden ${terminal} completion restores its terminal outcome without availability launch`, options, async () => {
    // Arrange
    const h = harness(); await h.appear(); await h.tap(); await h.session.disappear(); const count = h.events.length;
    // Act
    const run = h.runs[0];
    if (terminal === 'ordinary') run.callbacks.onDiagnostic('PROCESS_EXITED_NONZERO');
    if (terminal === 'protocol') run.callbacks.onError('Image protocol error.');
    await h.finish(terminal === 'success' ? success : { status: 'error',
      error: terminal === 'protocol' ? 'Image protocol error.' : ordinary });
    const hiddenCount = h.events.length;
    await h.appear(); await h.session.reconcileAvailability(); await h.advance(100000000);
    // Assert
    assert.equal(hiddenCount, count); assert.equal(h.runs.length, 1); assert.equal(run.stops, 0);
    if (terminal === 'success') assert.equal(cards(h).at(-1)[2], 'success');
    else assert.equal(errors(h).at(-1)[1], terminal === 'protocol' ? 'Image protocol error.' : ordinary);
    assert.deepEqual(h.writes, []);
  });
}
test('Once an unconfigured executable badge never comes from argv or partial Setup', options, async () => {
  // Arrange
  const h = harness();
  // Act
  await h.appear({ argsText: '/synthetic/report.py' });
  // Assert
  assert.deepEqual(cards(h).at(-1), ['ready', 'DeckForge Commander', 'setup required', '#969696', undefined]);
  assert.deepEqual(h.runs, []); assert.deepEqual(h.writes, []);
});
test('Once first producer handoff clears title before its image and does not overlay extension metadata', options, async () => {
  // Arrange
  const h = harness(); await h.appear(); await h.tap(); const producer = parseOutputUpdate('progress:100');
  // Act
  h.runs[0].callbacks.onUpdate(producer); await h.session.whenIdle();
  const running = h.session.getState(); await h.finish();
  // Assert
  assert.equal(running.phase, 'running'); assert.deepEqual(h.events.slice(-2).map(event => event[0]), ['title', 'image']);
  assert.equal(h.events.at(-2)[1], ''); assert.equal(svg(images(h)[0]).includes('>.py</text>'), false);
  assert.equal(h.runs.length, 1); assert.deepEqual(h.writes, []);
});
