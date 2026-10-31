import test from 'node:test';
import assert from 'node:assert/strict';
import { createActionSession } from '../src/core/action-session.mjs';
import { parseOutputUpdate } from '../src/core/output-update.mjs';
import { createPrimitiveArtwork } from '../src/core/primitive-artwork.mjs';
import { createLaunchArtwork } from '../src/core/launch-artwork.mjs';

const options = { timeout: 1_000 };
const settings = { executable: '/explicit/program', args: ['literal'], runRequested: true };
const execution = { executable: settings.executable, args: settings.args };
// Callback records are self-contained OutputUpdate DTOs, never title envelopes.
const update = name => parseOutputUpdate(`<svg>${name}</svg>`);
const displayed = name => [['title', ''], ['image', update(name).image]];

test('Stream card theme redraw preserves fields and explicit side ink without restarting', options, async () => {
  // Arrange
  const h = harness(); await h.start(settings);
  const record = parseOutputUpdate('card:UP|header:API;footer:HTTP 200;footer-color:ivory');
  h.runs[0].callbacks.onUpdate(record); await h.session.whenIdle();
  // Act
  h.runs[0].callbacks.onUpdate({ ...record, overrides: { ...record.overrides, label: 'invalid' } });
  await h.session.applySettings({ ...settings, themeColor: '#abcdef' }); await h.session.whenIdle();
  const rendered = decodeURIComponent(h.display.at(-1)[1]);
  // Assert
  assert.match(rendered, /fill="#abcdef"[^>]*>API<\/text>/);
  assert.match(rendered, /fill="#abcdef"[^>]*>UP<\/text>/);
  assert.match(rendered, /fill="#fffff0"[^>]*>HTTP 200<\/text>/);
  assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 0);
  assert.equal(h.session.getState().phase, 'running'); assert.deepEqual(h.errors, []);
});

test('Stream final card drains after a blocked send and malformed callbacks cannot evict it', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred(), images = [], first = update('card-first');
  const h = harness({ async setImage(image, current) { if (current()) images.push(image); if (image === first.image) { entered.resolve(); await gate.promise; } } });
  await h.start(settings); h.runs[0].callbacks.onUpdate(first); await entered.promise;
  const final = parseOutputUpdate('card:UP|header:API;footer:HTTP 200');
  // Act
  h.runs[0].callbacks.onUpdate(final);
  h.runs[0].callbacks.onUpdate({ ...final, options: { ...final.options, label: 'invalid' } });
  h.runs[0].callbacks.onDiagnostic('PROCESS_EXITED_SUCCESSFULLY'); h.runs[0].resolve({ status: 'success' });
  const before = [...images]; gate.resolve(); await h.session.whenIdle();
  h.runs[0].callbacks.onUpdate(parseOutputUpdate('card:stale')); await h.session.whenIdle();
  // Assert
  assert.deepEqual(before, [first.image]);
  assert.deepEqual(images, [first.image, createPrimitiveArtwork(final)]);
  assert.equal(h.session.getState().phase, 'stopped'); assert.equal(h.runs.length, 1);
  assert.deepEqual(h.errors, []);
});

// S2: layout options remain presentation only; callback rejection preserves owned output.
for (const type of ['ring', 'bar']) for (const position of ['above', 'below']) {
  test(`S2 Stream ${type}/${position} expanded layout survives theme redraw without restart`, options, async () => {
    // Arrange
    const h = harness(), other = harness();
    await h.start(settings); await other.start(settings);
    const record = parseOutputUpdate(`progress:1|type:${type};scale:${type === 'ring' ? 40 : 110};thickness:0.5;display:V;label:C;value-size:12;label-size:10;weight:bold;label-weight:normal;label-gap:0.5;label-position:${position};value-color:accent;label-color:accent`);
    const mutable = { ...record, options: { ...record.options }, overrides: { ...record.overrides } };
    h.runs[0].callbacks.onUpdate(mutable); await h.session.whenIdle();
    const original = decodeURIComponent(h.display.at(-1)[1]), untouched = [...other.display];
    // Act
    mutable.options['label-gap'] = 100; mutable.overrides['label-weight'] = 'bold';
    h.runs[0].callbacks.onUpdate(parseOutputUpdate(`progress:1|type:${type};scale:100;label:C;label-gap:100`));
    h.runs[0].callbacks.onUpdate({ ...record, options: { ...record.options, 'label-weight': 'bold' } });
    await h.session.applySettings({ ...settings, themeColor: '#abcdef' }); await h.session.whenIdle();
    const redrawn = decodeURIComponent(h.display.at(-1)[1]);
    // Assert - Byte equality after only theme substitution also preserves every layout coordinate.
    assert.equal(redrawn, original.replaceAll('#969696', '#abcdef'));
    assert.match(redrawn, /font-weight="normal" font-size="10" fill="#abcdef"[^>]*>C<\/text>/);
    assert.match(redrawn, /font-weight="bold" font-size="12" fill="#abcdef"[^>]*>V<\/text>/);
    assert.deepEqual(other.display, untouched);
    assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 0);
    assert.equal(h.session.getState().phase, 'running'); assert.deepEqual(h.errors, []); assert.deepEqual(h.saves, []);
  });
}
test('S2 Stream complete progress overrides retain final frame through hostile and infeasible callbacks', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred(), images = [], first = update('progress-layout-first');
  const h = harness({ async setImage(image, current) { if (current()) images.push(image); if (image === first.image) { entered.resolve(); await gate.promise; } } });
  await h.start(settings); h.runs[0].callbacks.onUpdate(first); await entered.promise;
  const final = parseOutputUpdate('progress:17/1034|color:cyan;background:navy;font:mono;weight:bold;border:16;border-color:lime;type:ring;scale:100;thickness:1;track-color:blue;label:C;display:V;value-position:center;label-position:above;rounded:false;value-size:12;label-size:10;value-color:ivory;label-color:accent;label-weight:normal;label-gap:0.5');
  let calls = 0;
  // Act
  h.runs[0].callbacks.onUpdate(final);
  const substituted = { ...final.options }; delete substituted['label-gap']; substituted.unknown = 0.5;
  h.runs[0].callbacks.onUpdate({ ...final, options: substituted });
  h.runs[0].callbacks.onUpdate({ ...final, overrides: { ...final.overrides, unknown: 1 } });
  h.runs[0].callbacks.onUpdate({ ...final, options: { ...final.options, get ['label-weight']() { calls++; throw Error('unexpected getter'); } } });
  h.runs[0].callbacks.onUpdate({ ...final, overrides: new Proxy(final.overrides, { ownKeys() { calls++; throw Error('unexpected proxy'); } }) });
  h.runs[0].callbacks.onUpdate(parseOutputUpdate('progress:1|label:C;label-gap:100'));
  h.runs[0].callbacks.onUpdate(parseOutputUpdate('progress:1|type:bar;scale:129;display:'));
  h.runs[0].callbacks.onDiagnostic('PROCESS_EXITED_SUCCESSFULLY'); h.runs[0].resolve({ status: 'success' });
  const before = [...images]; gate.resolve(); await h.session.whenIdle();
  h.runs[0].callbacks.onUpdate(parseOutputUpdate('progress:1|label:stale')); await h.session.whenIdle();
  // Assert
  assert.equal(Object.keys(final.overrides).length, 21);
  assert.equal(typeof createPrimitiveArtwork(final), 'string');
  assert.deepEqual(before, [first.image]); assert.deepEqual(images, [first.image, createPrimitiveArtwork(final)]);
  assert.equal(calls, 0); assert.equal(h.session.getState().phase, 'stopped'); assert.equal(h.session.getState().runRequested, false);
  assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 0); assert.deepEqual(h.errors, []);
});

// S1: exercise the complete 21-field text schema through real session admission.
test('Stream expanded text layout theme redraw keeps selected axes/caption styles and execution', options, async () => {
  // Arrange
  const h = harness(), other = harness();
  await h.start(settings); await other.start(settings);
  const record = parseOutputUpdate('text:A|font-size:12;label:C;label-size:40;padding-x:23;padding-y:7;label-align:right;label-weight:bold;label-gap:0.5;line-height:3;border:16');
  const mutable = { ...record, options: { ...record.options }, overrides: { ...record.overrides } };
  h.runs[0].callbacks.onUpdate(mutable); await h.session.whenIdle();
  const untouched = [...other.display];
  // Act
  mutable.options['padding-x'] = 60; mutable.overrides['label-align'] = 'left';
  h.runs[0].callbacks.onUpdate({ ...record, options: { ...record.options, 'label-gap': -1 } });
  await h.session.applySettings({ ...settings, themeColor: '#abcdef' }); await h.session.whenIdle();
  const rendered = decodeURIComponent(h.display.at(-1)[1]);
  // Assert
  assert.match(rendered, /<text x="72"[^>]*font-size="12"[^>]*fill="#abcdef"[^>]*>A<\/text>/);
  assert.match(rendered, /<text x="121"[^>]*text-anchor="end"[^>]*font-weight="bold"[^>]*font-size="40"[^>]*fill="#abcdef"[^>]*>C<\/text>/);
  assert.match(rendered, /stroke="#abcdef" stroke-width="16"/);
  assert.equal(record.options['padding-x'], 23);
  assert.deepEqual(other.display, untouched);
  assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 0);
  assert.equal(h.session.getState().phase, 'running'); assert.deepEqual(h.errors, []);
});
test('Stream full text overrides survive invalid pending callbacks and final-frame drain', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred(), images = [], first = update('layout-first');
  const h = harness({ async setImage(image, current) { if (current()) images.push(image); if (image === first.image) { entered.resolve(); await gate.promise; } } });
  await h.start(settings); h.runs[0].callbacks.onUpdate(first); await entered.promise;
  const final = parseOutputUpdate('text:A|color:cyan;background:navy;font:mono;weight:bold;border:16;border-color:lime;font-size:24;valign:bottom;align:left;overflow:ellipsis;padding:0;padding-x:28;padding-y:30;line-height:3;label:C;label-size:12;label-color:ivory;label-position:above;label-weight:normal;label-align:right;label-gap:0.5');
  let calls = 0;
  // Act
  h.runs[0].callbacks.onUpdate(final);
  const substituted = { ...final.options }; delete substituted['label-gap']; substituted.unknown = 0.5;
  h.runs[0].callbacks.onUpdate({ ...final, options: substituted });
  h.runs[0].callbacks.onUpdate({ ...final, overrides: { ...final.overrides, unknown: 1 } });
  h.runs[0].callbacks.onUpdate({ ...final, options: { ...final.options, get ['padding-x']() { calls++; throw Error('unexpected getter'); } } });
  h.runs[0].callbacks.onUpdate({ ...final, overrides: new Proxy(final.overrides, { ownKeys() { calls++; throw Error('unexpected proxy'); } }) });
  h.runs[0].callbacks.onDiagnostic('PROCESS_EXITED_SUCCESSFULLY'); h.runs[0].resolve({ status: 'success' });
  const before = [...images]; gate.resolve(); await h.session.whenIdle();
  h.runs[0].callbacks.onUpdate(parseOutputUpdate('text:stale|font-size:12')); await h.session.whenIdle();
  // Assert
  assert.equal(typeof createPrimitiveArtwork(final), 'string');
  assert.deepEqual(before, [first.image]); assert.deepEqual(images, [first.image, createPrimitiveArtwork(final)]);
  assert.equal(calls, 0); assert.equal(h.session.getState().phase, 'stopped');
  assert.equal(h.session.getState().runRequested, false);
  assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 0); assert.deepEqual(h.errors, []);
});

// TITLE-1: built-in captions change without changing process intent or producer output.
test('TITLE-1 Stream title-only changes preserve Setup and fixed protocol errors without redraw', options, async () => {
  // Arrange
  const setup = harness(); await setup.session.appear({}); const setupCards = [...setup.presentations];
  const h = harness(); await h.start(settings); h.runs[0].callbacks.onError('Image protocol error.'); await h.session.whenIdle();
  const before = [...h.errors], diagnostics = [...h.diagnostics], presentations = [...h.presentations];
  const stops = h.runs[0].stops;
  // Act
  await setup.session.applySettings({ title: 'not setup text' });
  await h.session.applySettings({ ...settings, title: 'not error text' }); await h.session.whenIdle();
  // Assert
  assert.deepEqual(setup.presentations, setupCards); assert.deepEqual(setup.runs, []);
  assert.deepEqual(h.errors, before); assert.deepEqual(h.diagnostics, diagnostics); assert.deepEqual(h.presentations, presentations);
  assert.equal(h.runs[0].stops, stops); assert.equal(h.runs.length, 1);
});
test('TITLE-1 Stream title plus theme retains theme redraw, while title plus execution stops safely', options, async () => {
  // Arrange
  const h = harness(); await h.start(settings); h.runs[0].callbacks.onUpdate(parseOutputUpdate('text:retained')); await h.session.whenIdle();
  const before = h.display.length;
  // Act
  await h.session.applySettings({ ...settings, title: 'new', themeColor: '#abcdef' }); await h.session.whenIdle();
  const recolored = h.display.at(-1)[1], stops = h.runs[0].stops;
  await h.session.applySettings({ ...settings, title: 'other', executable: '/synthetic/other' }); await h.session.whenIdle();
  // Assert
  assert.ok(h.display.length > before); assert.match(decodeURIComponent(recolored), /fill="#abcdef"/);
  assert.equal(stops, 0); assert.equal(h.runs[0].stops, 1); assert.equal(h.runs.length, 1);
});
test('TITLE-1 Stream Ready, Loading and Exited use custom titles and executable-only badges', options, async () => {
  // Arrange
  const h = harness(), input = { ...settings, executable: '/synthetic/report.PY', title: 'a/b.txt' };
  await h.session.appear(input); const ready = h.artwork.at(-1);
  // Act
  await h.session.press(); await h.session.whenIdle(); const loading = h.artwork.at(-1);
  h.runs[0].callbacks.onDiagnostic('PROCESS_EXITED_SUCCESSFULLY'); h.runs[0].resolve({ status: 'success' });
  await h.session.whenIdle(); await h.session.applySettings({ ...input, title: '' }); await h.session.whenIdle();
  // Assert
  assert.equal(ready.caption, 'a/b.txt'); assert.equal(ready.footer, 'ready'); assert.equal(ready.extension, '.py');
  assert.equal(loading.caption, 'a/b.txt'); assert.equal(loading.kind, 'waiting');
  assert.equal(h.artwork.at(-1).caption, 'report'); assert.equal(h.artwork.at(-1).footer, 'exited');
  assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 0); assert.deepEqual(h.errors, []);
});
for (const wire of ['text:hello', 'progress:17/23', '<svg>opaque</svg>']) {
  test(`TITLE-1 Stream title edit never redraws producer ${wire.split(':')[0]}`, options, async () => {
    // Arrange
    const h = harness(); await h.start(settings);
    h.runs[0].callbacks.onUpdate(parseOutputUpdate(wire)); await h.session.whenIdle();
    const before = [...h.display], cards = [...h.presentations];
    // Act
    await h.session.applySettings({ ...settings, title: 'a/b.txt' }); await h.session.whenIdle();
    // Assert
    assert.deepEqual(h.display, before); assert.deepEqual(h.presentations, cards);
    assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 0); assert.equal(h.session.getState().runRequested, true);
  });
}
test('TITLE-1 Stream caption edit cannot displace the queued final producer frame', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred(), images = [], first = update('first-title');
  const h = harness({ async setImage(value, current) { if (current()) images.push(value); if (value === first.image) { entered.resolve(); await gate.promise; } } });
  await h.start(settings); h.runs[0].callbacks.onUpdate(first); await entered.promise;
  const final = parseOutputUpdate('text:final'); h.runs[0].callbacks.onUpdate(final);
  // Act
  const editing = h.session.applySettings({ ...settings, title: 'edited' });
  h.runs[0].callbacks.onDiagnostic('PROCESS_EXITED_SUCCESSFULLY'); h.runs[0].resolve({ status: 'success' });
  gate.resolve(); await editing; await h.session.whenIdle();
  // Assert
  assert.deepEqual(images, [first.image, createPrimitiveArtwork(final)]);
  assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 0); assert.deepEqual(h.errors, []);
});
test('TITLE-1 Stream title edit preserves a pending start across the Loading handoff', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred(), cards = []; let first = true;
  const h = harness({ async onPresentation(kind, caption, current) {
    if (kind === 'waiting' && first) { first = false; entered.resolve(); await gate.promise; }
    if (current()) cards.push([kind, caption]);
  } });
  await h.session.appear(settings); const pressing = h.session.press(); await entered.promise;
  // Act
  const editing = h.session.applySettings({ ...settings, title: 'new title' }); gate.resolve();
  await Promise.all([pressing, editing]); await h.session.whenIdle();
  // Assert
  assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 0); assert.equal(h.session.getState().phase, 'running');
  assert.equal(cards.at(-1)[1], 'new title'); assert.deepEqual(h.errors, []);
});

// Slice 3: caption cosmetics preserve immutable record content and process ownership.
// Slice 4 / AGENTS hard-break contract: content survives cosmetics and final drain unchanged.
for (const suffix of ['', ';color:red']) {
  test(`Stream hard-line redraw ${suffix || 'implicit'} preserves key isolation and immutable main LF`, options, async () => {
    // Arrange
    const h = harness(), other = harness();
    await h.start(settings); await other.start(settings);
    const record = parseOutputUpdate(`text:A\\n\\nB|font-size:16;border:2${suffix}`);
    const mutable = { ...record, options: { ...record.options }, overrides: { ...record.overrides } };
    h.runs[0].callbacks.onUpdate(mutable); await h.session.whenIdle();
    const untouched = [...other.display];
    // Act
    mutable.value = 'mutated'; mutable.options['font-size'] = 48;
    h.runs[0].callbacks.onUpdate({ ...record, hardBreaks: true });
    await h.session.applySettings({ ...settings, themeColor: '#abcdef' }); await h.session.whenIdle();
    const rendered = decodeURIComponent(h.display.at(-1)[1]);
    // Assert
    assert.deepEqual([...rendered.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map(match => match[1]), ['A', '', 'B']);
    assert.deepEqual([...rendered.matchAll(/<text\b[^>]*fill="([^"]*)"/g)].map(match => match[1]), Array(3).fill(suffix ? '#ff0000' : '#abcdef'));
    assert.equal(record.value, 'A\n\nB'); assert.deepEqual(other.display, untouched);
    assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 0);
    assert.equal(h.session.getState().phase, 'running'); assert.deepEqual(h.errors, []);
  });
}
test('Stream hard-line final producer survives rejected fields and drains before stopped, never accepting stale output', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred(), images = [], first = update('hard-first');
  const h = harness({ async setImage(image, current) { if (current()) images.push(image); if (image === first.image) { entered.resolve(); await gate.promise; } } });
  await h.start(settings); h.runs[0].callbacks.onUpdate(first); await entered.promise;
  const final = parseOutputUpdate(String.raw`text:A\n\nB|font-size:16`);
  // Act
  h.runs[0].callbacks.onUpdate(final);
  h.runs[0].callbacks.onUpdate({ ...final, hardBreaks: true });
  h.runs[0].callbacks.onUpdate({ ...final, value: 'bad\0' });
  h.runs[0].callbacks.onUpdate({ ...final, options: { ...final.options, 'max-lines': 2 } });
  h.runs[0].callbacks.onDiagnostic('PROCESS_EXITED_SUCCESSFULLY'); h.runs[0].resolve({ status: 'success' });
  const before = [...images]; gate.resolve(); await h.session.whenIdle();
  h.runs[0].callbacks.onUpdate(parseOutputUpdate(String.raw`text:stale\ncallback`)); await h.session.whenIdle();
  // Assert
  assert.deepEqual(before, [first.image]); assert.deepEqual(images, [first.image, createPrimitiveArtwork(final)]);
  assert.equal(h.session.getState().phase, 'stopped'); assert.equal(h.session.getState().runRequested, false);
  assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 0); assert.deepEqual(h.errors, []);
});
for (const position of ['above', 'below']) for (const [suffix, colors] of [['', ['#abcdef', '#abcdef']], [';color:red', ['#ff0000', '#ff0000']], [';label-color:ivory', ['#abcdef', '#fffff0']], [';color:red;label-color:ivory', ['#ff0000', '#fffff0']]]) {
  test(`Stream caption ${position} redraw ${suffix || 'inherited'} is key-local and never restarts`, options, async () => {
    // Arrange
    const h = harness(), other = harness();
    await h.start(settings); await other.start(settings);
    const record = parseOutputUpdate(`text:42|font-size:48;label:Items;label-size:14.25;label-position:${position};border:2${suffix}`);
    const before = JSON.stringify(record);
    const mutable = { ...record, options: { ...record.options }, overrides: { ...record.overrides } };
    h.runs[0].callbacks.onUpdate(mutable); await h.session.whenIdle();
    const untouched = [...other.display];
    // Act
    mutable.value = 'mutated'; mutable.options['label-position'] = 'center'; mutable.overrides['label-position'] = 'center';
    await h.session.applySettings({ ...settings, themeColor: '#abcdef' }); await h.session.whenIdle();
    const rendered = decodeURIComponent(h.display.at(-1)[1]);
    // Assert
    assert.deepEqual([...rendered.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map(match => match[1]), position === 'above' ? ['Items', '42'] : ['42', 'Items']);
    assert.deepEqual([...rendered.matchAll(/<text\b[^>]*fill="([^"]*)"/g)].map(match => match[1]), position === 'above' ? [...colors].reverse() : colors);
    assert.match(rendered, /font-size="48"/); assert.match(rendered, /font-size="14.25"/);
    assert.match(rendered, /stroke="#abcdef"/);
    assert.equal(JSON.stringify(record), before); assert.deepEqual(other.display, untouched);
    assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 0);
    assert.equal(h.session.getState().phase, 'running'); assert.equal(h.session.getState().runRequested, true);
    assert.deepEqual(h.errors, []);
  });
}
test('Stream final caption survives hostile/missing/provenance callbacks and drains before stopped', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred(), images = [], first = update('caption-first');
  const h = harness({ async setImage(image, current) { if (current()) images.push(image); if (image === first.image) { entered.resolve(); await gate.promise; } } });
  await h.start(settings); h.runs[0].callbacks.onUpdate(first); await entered.promise;
  const final = parseOutputUpdate('text:42|font-size:48;label:Items;label-color:ivory;label-position:above');
  // Act
  h.runs[0].callbacks.onUpdate(final);
  const missingPosition = { ...final.options }; delete missingPosition['label-position'];
  h.runs[0].callbacks.onUpdate({ ...final, options: missingPosition });
  h.runs[0].callbacks.onUpdate({ ...final, options: { ...final.options, 'label-position': 'below' } });
  h.runs[0].callbacks.onUpdate({ ...final, options: { ...final.options, get ['label-position']() { throw Error('synthetic'); } } });
  h.runs[0].callbacks.onUpdate({ ...final, options: new Proxy(final.options, { ownKeys() { throw Error('synthetic'); } }) });
  h.runs[0].callbacks.onUpdate({ ...final, options: { ...final.options, label: 'forged' } });
  const missing = { ...final.options }; delete missing['label-size'];
  h.runs[0].callbacks.onUpdate({ ...final, options: missing });
  h.runs[0].callbacks.onUpdate({ ...final, options: { ...final.options, 'label-color': 'accent' } });
  h.runs[0].callbacks.onUpdate({ ...final, overrides: { ...final.overrides, 'label-color': 'blue' } });
  h.runs[0].callbacks.onUpdate({ ...final, options: { ...final.options, get label() { throw Error('synthetic'); } } });
  h.runs[0].callbacks.onDiagnostic('PROCESS_EXITED_SUCCESSFULLY'); h.runs[0].resolve({ status: 'success' });
  const before = [...images]; gate.resolve(); await h.session.whenIdle();
  h.runs[0].callbacks.onUpdate(parseOutputUpdate('text:late|label:stale')); await h.session.whenIdle();
  // Assert
  assert.deepEqual(before, [first.image]); assert.deepEqual(images, [first.image, createPrimitiveArtwork(final)]);
  assert.equal(h.session.getState().phase, 'stopped'); assert.equal(h.session.getState().runRequested, false);
  assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 0); assert.deepEqual(h.errors, []);
});

// Slice 2: ratio/display are presentation only; callbacks still need complete provenance.
for (const [suffix, caption] of [['', '1.6%'], [';display:17 done', '17 done'], [';display:', undefined], [';display:17 done;value-position:none', undefined]]) {
  test(`Stream ratio ${suffix || 'default caption'} redraw preserves full geometry and ownership`, options, async () => {
    // Arrange
    const h = harness(), other = harness();
    await h.start(settings); await other.start(settings);
    const record = parseOutputUpdate(`progress:17/1034|value-color:accent;border:2${suffix}`);
    h.runs[0].callbacks.onUpdate(record); await h.session.whenIdle();
    const original = h.display.at(-1)[1], untouched = [...other.display];
    // Act
    await h.session.applySettings({ ...settings, themeColor: '#abcdef' }); await h.session.whenIdle();
    const rendered = decodeURIComponent(h.display.at(-1)[1]);
    // Assert
    assert.deepEqual([...rendered.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map(match => match[1]), caption ? [caption] : []);
    assert.equal(/stroke-dasharray="([^"]*)"/.exec(rendered)[1], /stroke-dasharray="([^"]*)"/.exec(decodeURIComponent(original))[1]);
    assert.match(rendered, /stroke="#abcdef"/);
    assert.equal(record.value, 1700 / 1034);
    assert.deepEqual(other.display, untouched);
    assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 0);
    assert.equal(h.session.getState().phase, 'running'); assert.equal(h.session.getState().runRequested, true);
    assert.deepEqual(h.errors, []);
  });
}
test('Stream final pending ratio survives forged display and missing DTO fields before success drains', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred(), images = [];
  const first = update('first');
  const h = harness({ async setImage(image, current) { if (current()) images.push(image); if (image === first.image) { entered.resolve(); await gate.promise; } } });
  await h.start(settings); h.runs[0].callbacks.onUpdate(first); await entered.promise;
  const final = parseOutputUpdate('progress:17/1034|display:17 done;label:Build');
  // Act
  h.runs[0].callbacks.onUpdate(final);
  h.runs[0].callbacks.onUpdate({ ...final, options: { ...final.options, display: 'forged' } });
  const missing = { ...final.options }; delete missing.display;
  h.runs[0].callbacks.onUpdate({ ...final, options: missing });
  h.runs[0].callbacks.onUpdate({ ...final, overrides: { ...final.overrides, display: undefined } });
  h.runs[0].callbacks.onDiagnostic('PROCESS_EXITED_SUCCESSFULLY'); h.runs[0].resolve({ status: 'success' });
  const before = [...images]; gate.resolve(); await h.session.whenIdle();
  h.runs[0].callbacks.onUpdate(parseOutputUpdate('progress:1/2|display:late')); await h.session.whenIdle();
  // Assert
  assert.deepEqual(before, [first.image]);
  assert.deepEqual(images, [first.image, createPrimitiveArtwork(final)]);
  assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 0);
  assert.equal(h.session.getState().runRequested, false); assert.equal(h.session.getState().phase, 'stopped');
  assert.deepEqual(h.errors, []);
});

// Slice 1: theme redraw changes only implicit fill/accent, never omitted white or explicit opaque ink.
for (const fill of ['', ';color:red']) {
  for (const [annotation, expected] of [
    ['', ['#ffffff', '#ffffff']],
    [';value-color:accent', [fill ? '#ff0000' : '#abcdef', '#ffffff']],
    [';label-color:accent', ['#ffffff', fill ? '#ff0000' : '#abcdef']],
    [';value-color:accent;label-color:accent', Array(2).fill(fill ? '#ff0000' : '#abcdef')],
    [';value-color:ivory;label-color:blue', ['#fffff0', '#0000ff']],
  ]) {
    test(`Stream redraw fill=${fill || 'implicit'} annotations=${annotation || 'omitted'} preserves owner`, options, async () => {
      // Arrange
      const h = harness(); await h.start(settings);
      const record = parseOutputUpdate(`progress:42|label:Hi;border:2${fill}${annotation}`);
      h.runs[0].callbacks.onUpdate(record); await h.session.whenIdle();
      const before = JSON.stringify(record);
      // Act
      await h.session.applySettings({ ...settings, themeColor: '#abcdef' }); await h.session.whenIdle();
      const svg = decodeURIComponent(h.display.at(-1)[1].slice('data:image/svg+xml,'.length));
      // Assert
      assert.deepEqual([...svg.matchAll(/<text\b[^>]*fill="([^"]*)"/g)].map(match => match[1]), expected);
      assert.match(svg, /stroke="#abcdef" stroke-width="2"/);
      assert.equal(JSON.stringify(record), before);
      assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 0);
      assert.equal(h.session.getState().phase, 'running'); assert.deepEqual(h.saves, []);
    });
  }
}

for (const explicit of ['value', 'label', 'both']) {
  test(`live primitive redraw preserves ${explicit} annotation color overrides and fixed sizes while implicit siblings follow theme`, options, async () => {
    // Arrange
    const h = harness(); await h.start({ ...settings, themeColor: '#123456' });
    const suffix = explicit === 'value' ? 'value-color:red;label-color:accent' : explicit === 'label' ? 'value-color:accent;label-color:blue' : 'value-color:red;label-color:blue';
    const record = parseOutputUpdate(`progress:45|scale:100;label:Hi;value-size:24;label-size:20.5;${suffix}`);
    const before = JSON.stringify(record);
    // Act
    h.runs[0].callbacks.onUpdate(record); await h.session.whenIdle();
    const accepted = h.display.at(-1)?.[1];
    await h.session.applySettings({ ...settings, themeColor: '#abcdef' }); await h.session.whenIdle();
    const svg = decodeURIComponent(h.display.at(-1)[1].slice('data:image/svg+xml,'.length));
    const texts = [...svg.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)].map(match => ({ attrs: Object.fromEntries([...match[1].matchAll(/([\w:-]+)="([^"]*)"/g)].map(attr => [attr[1], attr[2]])), text: match[2] }));
    // Assert
    assert.equal(typeof createPrimitiveArtwork(record), 'string');
    assert.equal(typeof accepted, 'string');
    assert.deepEqual(texts.map(text => [text.text, text.attrs['font-size'], text.attrs.fill]), [['45%', '24', explicit === 'label' ? '#abcdef' : '#ff0000'], ['Hi', '20.5', explicit === 'value' ? '#abcdef' : '#0000ff']]);
    assert.equal(JSON.stringify(record), before);
    assert.deepEqual(h.saves, []);
    assert.equal(h.runs.length, 1);
    assert.equal(h.runs[0].stops, 0);
    assert.equal(h.session.getState().phase, 'running');
  });
}

test('invalid/infeasible annotation callbacks cannot replace an accepted pending producer or its live cache', options, async () => {
  // Arrange
  const active = deferred(), entered = deferred(), images = [];
  const h = harness({ async setImage(image, current) { if (current()) images.push(image); if (image === update('A').image) { entered.resolve(); await active.promise; } } });
  await h.start(settings);
  h.runs[0].callbacks.onUpdate(update('A')); await entered.promise;
  const record = parseOutputUpdate('progress:45|scale:100;label:Hi;value-size:24;label-size:20;value-color:red;label-color:blue');
  // Act
  h.runs[0].callbacks.onUpdate(record);
  h.runs[0].callbacks.onUpdate(parseOutputUpdate('progress:45|value-size:auto'));
  h.runs[0].callbacks.onUpdate(parseOutputUpdate('progress:45|scale:50;thickness:16;value-size:32'));
  h.runs[0].callbacks.onUpdate({ ...record, options: { ...record.options, 'label-color': 'url(test)' } });
  h.runs[0].callbacks.onUpdate({ ...record, options: { ...record.options, 'value-color': 'accent' } });
  h.runs[0].callbacks.onUpdate({ ...record, options: { ...record.options, annotationColor: '#ffffff' } });
  h.runs[0].callbacks.onUpdate({ ...record, overrides: { ...record.overrides, foreground: 'theme' } });
  active.resolve(); await h.session.whenIdle();
  const afterProducer = [...images];
  await h.session.applySettings({ ...settings, themeColor: '#abcdef' }); await h.session.whenIdle();
  // Assert
  assert.deepEqual(afterProducer, [update('A').image, createPrimitiveArtwork(record)]);
  assert.ok(decodeURIComponent(images.at(-1)).includes('>Hi</text>'));
  assert.ok(decodeURIComponent(images.at(-1)).includes('font-size="24" fill="#ff0000"'));
  assert.deepEqual(h.errors, []);
  assert.equal(h.session.getState().protocolBlocked, false);
  assert.equal(h.runs[0].stops, 0);
});

test('annotation theme replay on one action cannot change the independent action annotation styles', options, async () => {
  // Arrange
  const first = harness(), second = harness();
  await Promise.all([first.start(settings), second.start(settings)]);
  const record = parseOutputUpdate('progress:45|scale:100;label:Hi;value-color:accent;label-color:accent;value-size:24;label-size:20');
  first.runs[0].callbacks.onUpdate(record); second.runs[0].callbacks.onUpdate(record);
  await Promise.all([first.session.whenIdle(), second.session.whenIdle()]);
  const originalSecond = [...second.display];
  // Act
  await first.session.applySettings({ ...settings, themeColor: '#abcdef' }); await first.session.whenIdle();
  // Assert
  assert.deepEqual(second.display, originalSecond);
  assert.ok(decodeURIComponent(first.display.at(-1)[1]).includes('#abcdef'));
  assert.ok(decodeURIComponent(second.display.at(-1)[1]).includes('#969696'));
  assert.deepEqual(first.saves, []); assert.deepEqual(second.saves, []);
});

// Review regression: an accepted pending producer survives optional same-record recolors.
for (const terminal of ['success', 'nonzero', 'signal', 'protocol']) {
  for (const revisions of [1, 3]) {
    test(`${terminal} drains pending producer beneath ${revisions} stale recolor(s) before terminal artwork`, options, async () => {
      // Arrange
      const active = deferred(), entered = deferred(), timeline = [];
      const primitive = parseOutputUpdate('progress:42|label:B;value-color:accent;label-color:accent');
      const expectedImage = createPrimitiveArtwork(primitive);
      const h = harness({
        async setImage(image, current) { if (current()) timeline.push(['image', image]); if (image === update('A').image) { entered.resolve(); await active.promise; } },
        onPresentation(kind, caption, current) { if (current()) timeline.push([kind, caption]); },
        onError(message, code, current) { if (current()) timeline.push(['error', message, code]); },
      });
      await h.start(settings);
      h.runs[0].callbacks.onUpdate(update('A')); await entered.promise;
      h.runs[0].callbacks.onUpdate(primitive);
      // Act
      const recolors = [];
      for (const color of ['#abcdef', '#123456', '#654321'].slice(0, revisions)) recolors.push(h.session.applySettings({ ...settings, themeColor: color }));
      // Neither a skip nor a malformed callback may evict the accepted record/alternate.
      h.runs[0].callbacks.onUpdate(parseOutputUpdate('text:bad|background:transparent'));
      h.runs[0].callbacks.onUpdate({ kind: 'text', value: 'bad', options: {}, overrides: {} });
      const message = terminal === 'protocol' ? 'Image protocol error.' : 'Program exited unsuccessfully.';
      const code = terminal === 'signal' ? 'PROCESS_TERMINATED_BY_SIGNAL' : 'PROCESS_EXITED_NONZERO';
      // Match the real runner: observe success before resolving done and injecting late output.
      if (terminal === 'success') h.runs[0].callbacks.onDiagnostic('PROCESS_EXITED_SUCCESSFULLY');
      if (terminal === 'nonzero' || terminal === 'signal') h.runs[0].callbacks.onDiagnostic(code);
      if (terminal === 'protocol') h.runs[0].callbacks.onError(message);
      h.runs[0].resolve(terminal === 'success' ? { status: 'success' } : { status: 'error', error: message });
      h.runs[0].callbacks.onUpdate(update('after-terminal'));
      const before = [...timeline];
      active.resolve(); await Promise.all(recolors); await h.session.whenIdle();
      // Assert
       assert.deepEqual(before, [['waiting', 'program'], ['image', update('A').image]]);
       assert.deepEqual(timeline, [['waiting', 'program'], ['image', update('A').image], ['image', expectedImage],
        terminal === 'success' ? ['ready', 'program'] : ['error', message, terminal === 'protocol' ? 'IMAGE_PROTOCOL_ERROR' : code]]);
      assert.equal(h.runs.length, 1);
      assert.equal(h.session.getState().runRequested, false);
      assert.deepEqual(h.saves, []);
      assert.equal(primitive.options.color, '#969696');
    });
  }
}

for (const newer of ['primitive', 'opaque']) {
  test(`newer ${newer} evicts the same-record producer alternate and is the sole final frame`, options, async () => {
    // Arrange
    const active = deferred(), entered = deferred(), images = [];
    const h = harness({ async setImage(image, current) { if (current()) images.push(image); if (image === update('A').image) { entered.resolve(); await active.promise; } } });
    await h.start(settings);
    h.runs[0].callbacks.onUpdate(update('A')); await entered.promise;
    h.runs[0].callbacks.onUpdate(parseOutputUpdate('text:B'));
    // Act
    const recolor = h.session.applySettings({ ...settings, themeColor: '#abcdef' });
    const latest = newer === 'opaque' ? update('C') : parseOutputUpdate('text:C|color:red');
    h.runs[0].callbacks.onUpdate(latest);
    h.runs[0].resolve({ status: 'success' });
    active.resolve(); await recolor; await h.session.whenIdle();
    // Assert
    assert.deepEqual(images, [update('A').image, newer === 'opaque' ? latest.image : createPrimitiveArtwork(latest)]);
    assert.equal(h.session.getState().presentation, 'ready');
    assert.equal(h.runs.length, 1);
  });
}

for (const loss of ['manual', 'config', 'hide', 'disconnect', 'persistence', 'cleanup', 'launch-error', 'display-error']) {
  test(`${loss} prevents pending producer fallback from bypassing its ownership guard`, options, async () => {
    // Arrange
    const active = deferred(), entered = deferred(), images = [];
    const h = harness({ async setImage(image, current) {
      if (image === update('A').image) { if (current()) images.push(image); entered.resolve(); await active.promise; }
      else if (current()) images.push(image);
    } });
    await h.start(settings);
    h.runs[0].callbacks.onUpdate(update('A')); await entered.promise;
    h.runs[0].callbacks.onUpdate(parseOutputUpdate('text:B'));
    // Act
    const recolor = h.session.applySettings({ ...settings, themeColor: '#abcdef' });
    let transition;
    if (loss === 'manual') transition = h.session.press();
    if (loss === 'config') transition = h.session.applySettings({ executable: '/replacement', args: [] });
    if (loss === 'hide') transition = h.session.disappear();
    if (loss === 'disconnect') transition = h.session.setConnected(false);
    if (loss === 'persistence') transition = h.session.persistenceFailed();
    if (loss === 'cleanup') { h.runs[0].stopResult = false; transition = h.session.press(); }
    if (loss === 'launch-error') { h.runs[0].callbacks.onError('Program launch failed.'); h.runs[0].resolve({ status: 'error', error: 'Program launch failed.' }); }
    if (loss === 'display-error') active.reject(new Error('synthetic display boundary'));
    else active.resolve();
    await Promise.all([recolor, transition]); await h.session.whenIdle();
    // Assert
    assert.deepEqual(images, [update('A').image]);
    assert.equal(h.runs.length, 1);
    if (loss === 'persistence') assert.equal(h.session.getState().persistenceBlocked, true);
    if (loss === 'cleanup') assert.equal(h.session.getState().cleanupBlocked, true);
    if (loss === 'display-error') assert.ok(h.errors.includes('Frame send failed.'));
    if (loss === 'manual' || loss === 'config') assert.equal(h.session.getState().runRequested, false);
  });
}

test('cosmetic already handed to image boundary never replays producer on terminal settlement', options, async () => {
  // Arrange
  const active = deferred(), firstEntered = deferred(), cosmetic = deferred(), cosmeticEntered = deferred(), images = [];
  const h = harness({ async setImage(image, current) {
    if (current()) images.push(image);
    if (image === update('A').image) { firstEntered.resolve(); await active.promise; }
    else { cosmeticEntered.resolve(); await cosmetic.promise; }
  } });
  await h.start(settings);
  h.runs[0].callbacks.onUpdate(update('A')); await firstEntered.promise;
  h.runs[0].callbacks.onUpdate(parseOutputUpdate('text:B'));
  // Act
  const recolor = h.session.applySettings({ ...settings, themeColor: '#abcdef' });
  active.resolve(); await cosmeticEntered.promise;
  h.runs[0].resolve({ status: 'success' });
  cosmetic.resolve(); await recolor; await h.session.whenIdle();
  // Assert
  assert.equal(images.length, 2);
  assert.ok(decodeURIComponent(images[1]).includes('#abcdef'));
  assert.equal(h.session.getState().presentation, 'ready');
  assert.equal(h.runs.length, 1);
});

for (const newerError of ['launch', 'persistence']) {
  test(`newer ${newerError} diagnosis supersedes owned drain eligibility and its producer alternate`, options, async () => {
    // Arrange
    const active = deferred(), entered = deferred(), images = [];
    const h = harness({ async setImage(image, current) { if (current()) images.push(image); if (image === update('A').image) { entered.resolve(); await active.promise; } } });
    await h.start(settings);
    h.runs[0].callbacks.onUpdate(update('A')); await entered.promise;
    h.runs[0].callbacks.onUpdate(parseOutputUpdate('text:B'));
    // Act
    const recolor = h.session.applySettings({ ...settings, themeColor: '#abcdef' });
    h.runs[0].callbacks.onError('Image protocol error.');
    let transition;
    if (newerError === 'launch') h.runs[0].callbacks.onError('Program launch failed.');
    else transition = h.session.persistenceFailed();
    h.runs[0].resolve({ status: 'error', error: 'Image protocol error.' });
    active.resolve(); await Promise.all([recolor, transition]); await h.session.whenIdle();
    const beforeLateCallback = images.length;
    h.runs[0].callbacks.onUpdate(parseOutputUpdate('text:after-published-error'));
    await h.session.whenIdle();
    // Assert
    assert.deepEqual(images, [update('A').image]);
    assert.equal(images.length, beforeLateCallback);
    assert.equal(h.session.getState().presentation, 'error');
    assert.equal(h.session.getState().runRequested, false);
  });
}

test('replacement generation cannot replay a disposed old producer alternate or its callbacks', options, async () => {
  // Arrange
  const active = deferred(), entered = deferred(), images = [];
  const h = harness({ async setImage(image, current) { if (current()) images.push(image); if (image === update('A').image) { entered.resolve(); await active.promise; } } });
  await h.start(settings);
  h.runs[0].callbacks.onUpdate(update('A')); await entered.promise;
  h.runs[0].callbacks.onUpdate(parseOutputUpdate('text:B'));
  // Act
  const recolor = h.session.applySettings({ ...settings, themeColor: '#abcdef' });
  const stopped = h.session.press();
  active.resolve(); await Promise.all([recolor, stopped]);
  await h.session.press();
  h.runs[0].callbacks.onUpdate(parseOutputUpdate('text:old-late'));
  h.runs[0].resolve({ status: 'success' });
  h.runs[1].callbacks.onUpdate(update('new-generation')); await h.session.whenIdle();
  // Assert
  assert.deepEqual(images, [update('A').image, update('new-generation').image]);
  assert.equal(h.runs.length, 2);
  assert.equal(h.session.getState().runRequested, true);
  assert.equal(h.session.getState().presentation, 'streaming');
});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(overrides = {}) {
  const runs = [], display = [], errors = [], diagnostics = [], guards = [], lifecycle = [], saves = [], presentations = [], artwork = [];
  let arranging = false;
  const { onPresentation: presentationBoundary, ...otherOverrides } = overrides;
  const session = createActionSession({
    initialConnected: true,
    startRun(input, callbacks) {
      const done = deferred();
      const run = { input, callbacks, ...done, stops: 0, stopResult: true, stopGate: undefined, stopStarted: deferred() };
      lifecycle.push(['start', input.executable]);
      runs.push(run);
      return {
        done: done.promise,
        async stop() {
          run.stops++;
          lifecycle.push(['stop', input.executable]);
          run.stopStarted.resolve();
          return run.stopGate ? run.stopGate.promise : run.stopResult;
        },
      };
    },
    async setImage(image, current) { if (current()) display.push(['image', image]); },
    async setTitle(title, current) { if (current()) display.push(['title', title]); },
    onError(message, code, current) { errors.push(message); diagnostics.push(code); guards.push(current); },
    async onPresentation(kind, caption, current, color, footer, extension) {
      // Running fixtures begin observation after idle setup; idle behavior has dedicated tests below.
      if (arranging) return;
      if (presentationBoundary) return presentationBoundary(kind, caption, current, color, footer, extension);
      if (current()) {
        presentations.push([kind, caption]);
        artwork.push({ kind, caption, color, footer, extension, current, image: createLaunchArtwork(kind, caption, color, footer, extension) });
      }
    },
    ...otherOverrides,
  });
  async function start(input) {
    arranging = true;
    try { await session.appear(input); } finally { arranging = false; }
    return session.press();
  }
  return { session, start, runs, display, errors, diagnostics, guards, lifecycle, saves, presentations, artwork };
}

// Capture both host display boundaries; lifecycle, rendering and theme resolution stay real.
function displayHarness(overrides = {}) {
  const handoffs = [];
  const boundaries = {
    async onPresentation(kind, caption, current, color, footer, extension) {
      if (current()) handoffs.push(['title', ''], ['image', createLaunchArtwork(kind, caption, color, footer, extension)]);
    },
    async setImage(image, current) { if (current()) handoffs.push(['image', image]); },
    async setTitle(title, current) { if (current()) handoffs.push(['title', title]); },
  };
  return { ...harness({ ...boundaries, ...overrides }), handoffs };
}

// S2: Windows validation shares Stream's session-local intent and no-overlap gates.
test('Windows Stream starts stopped despite legacy intent and preserves output on theme-only edits', options, async () => {
  // Arrange
  const h = harness({ platform: 'win32' }), input = { executable: String.raw`C:\folder\report.EXE`, argsText: '', runRequested: true };
  await h.session.appear(input); await h.session.whenIdle(); const fresh = h.runs.length;
  // Act
  await h.session.press(); h.runs[0].callbacks.onUpdate(parseOutputUpdate('text:retained')); await h.session.whenIdle();
  await h.session.applySettings({ ...input, themeColor: '#abcdef' }); await h.session.whenIdle();
  const retained = h.display.at(-1)[1];
  h.runs[0].resolve({ status: 'success' }); await h.session.whenIdle();
  h.runs[0].callbacks.onUpdate(parseOutputUpdate('text:stale')); await h.session.whenIdle();
  // Assert
  assert.equal(fresh, 0); assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 0);
  assert.equal(h.runs[0].input.executable, input.executable); assert.match(decodeURIComponent(retained), />retained<\/text>/);
  assert.equal(h.session.getState().runRequested, false); assert.equal(h.session.getState().phase, 'stopped');
  assert.deepEqual(input, { executable: String.raw`C:\folder\report.EXE`, argsText: '', runRequested: true }); assert.deepEqual(h.errors, []);
});
test('Windows Stream execution edit waits for owned cleanup and never auto-launches or accepts stale bytes', options, async () => {
  // Arrange
  const h = harness({ platform: 'win32' }), input = { executable: 'C:/first.EXE', argsText: '' };
  await h.start(input); const gate = deferred(); h.runs[0].stopGate = gate;
  // Act
  const edit = h.session.applySettings({ ...input, executable: 'D:/next.EXE' });
  await h.runs[0].stopStarted.promise; const during = h.runs.length;
  gate.resolve(true); await edit; await h.session.whenIdle();
  const beforeStale = [...h.display]; h.runs[0].callbacks.onUpdate(update('stale')); await h.session.whenIdle();
  const afterEdit = h.runs.length; await h.session.press();
  // Assert
  assert.equal(during, 1); assert.equal(afterEdit, 1); assert.deepEqual(h.display, beforeStale);
  assert.equal(h.runs[0].stops, 1); assert.equal(h.runs.length, 2); assert.equal(h.runs[1].input.executable, 'D:/next.EXE');
});

for (const loss of ['hide', 'disconnect']) {
  for (const fast of [false, true]) {
    test(`silent ${loss} resume ${fast ? 'during' : 'after'} cleanup waits for latest complete authorization without display leakage`, options, async () => {
      // Arrange: cleanup and complete-settings reads are independent external boundaries.
      const cleanup = deferred(), oldRead = deferred(), readEntered = deferred(), latestRead = deferred(), latestEntered = deferred();
      const expected = [];
      const h = displayHarness({ confirmLaunchSettings(snapshot) {
        expected.push(snapshot);
        if (expected.length === 2) { readEntered.resolve(); return oldRead.promise; }
        if (expected.length === 3) { latestEntered.resolve(); return latestRead.promise; }
        return Promise.resolve(true);
      } });
      await h.start(settings);
      const old = h.runs[0]; old.stopGate = cleanup;
      const before = [...h.handoffs];

      // Act: neither cleanup nor an older matched configuration is sufficient to replace ownership.
      const pause = loss === 'hide' ? h.session.disappear() : h.session.setConnected(false);
      await old.stopStarted.promise;
      if (!fast) { cleanup.resolve(true); await pause; }
      const resume = loss === 'hide' ? h.session.appear(settings) : h.session.setConnected(true);
      const repeated = h.session.reconcileAvailability();
      const beforeCleanup = h.runs.length;
      cleanup.resolve(true); await readEntered.promise;
      const themed = { ...settings, themeColor: '#abcdef' };
      const edit = h.session.applySettings(themed);
      oldRead.resolve(true); await latestEntered.promise;
      const beforeLatest = { runs: h.runs.length, handoffs: [...h.handoffs] };
      latestRead.resolve(true); await Promise.all([pause, resume, repeated, edit]); await h.session.whenIdle();
      await h.session.reconcileAvailability();

      // Assert: automatic resumes keep intent, suppress title/image traffic and start once.
      assert.equal(beforeCleanup, 1);
      assert.deepEqual(beforeLatest, { runs: 1, handoffs: before });
      assert.deepEqual(h.handoffs, before);
      assert.deepEqual(expected, [settings, settings, themed]);
      assert.deepEqual(h.runs.map(run => run.stops), [1, 0]);
      assert.deepEqual(h.saves, []);
      assert.equal(h.session.getState().runRequested, true);
      assert.deepEqual(h.errors, []);
    });
  }
}

for (const initiallyUnavailable of [false, true]) {
  test(`fresh legacy Started ${initiallyUnavailable ? 'initially disconnected' : 'available'} stays idle until explicit first-start Loading`, options, async () => {
    // Arrange
    const h = displayHarness({ initialConnected: !initiallyUnavailable });
    // Act
    await h.session.appear(settings);
    const beforeConnection = { runs: h.runs.length, handoffs: [...h.handoffs] };
    await h.session.setConnected(true); await h.session.reconcileAvailability();
    const beforePress = h.runs.length;
    await h.session.press();
    // Assert: being unavailable before any attempted Start is not resume provenance.
    if (initiallyUnavailable) assert.deepEqual(beforeConnection, { runs: 0, handoffs: [] });
    assert.equal(beforePress, 0);
    assert.deepEqual(h.handoffs, [['title', ''], ['image', createLaunchArtwork('ready', 'program')],
      ['title', ''], ['image', createLaunchArtwork('waiting', 'program')]]);
    assert.equal(h.runs.length, 1);
    assert.deepEqual(h.saves, []);
  });
}

for (const loss of ['hide', 'disconnect']) {
  for (const stage of ['Loading', 'configuration-confirmation', 'complete-confirmation']) {
    test(`interrupted ${stage} before any spawn resumes silently after ${loss}; cancellation resets explicit Start`, options, async () => {
      // Arrange: gate only the existing first-attempt boundary, never a new resume presentation.
      const gate = deferred(), entered = deferred(), handoffs = [], saved = [];
      let held = false, waitingGuard;
      const h = harness({
        async onPresentation(kind, caption, current, color, footer, extension) {
          if (current()) handoffs.push(['title', ''], ['image', createLaunchArtwork(kind, caption, color, footer, extension)]);
          if (stage === 'Loading' && kind === 'waiting' && !held) {
            held = true; waitingGuard = current; entered.resolve(); await gate.promise;
          }
        },
        async confirmLaunchSettings() {
          if (stage !== 'Loading' && !held) { held = true; entered.resolve(); await gate.promise; }
          return true;
        },
      });
      const first = h.start(settings); await entered.promise;
      assert.equal(h.runs.length, 0);
      const before = [...handoffs];

      // Act: interrupt the begun attempt, return quickly, then settle its obsolete wait.
      const pause = loss === 'hide' ? h.session.disappear() : h.session.setConnected(false);
      const resumedSettings = { ...settings, themeColor: '#abcdef' };
      const editing = loss === 'disconnect' ? h.session.applySettings(resumedSettings) : undefined;
      const resume = loss === 'hide' ? h.session.appear(resumedSettings) : h.session.setConnected(true);
      const staleLoading = waitingGuard?.();
      gate.resolve(); await Promise.all([first, pause, resume, editing]); await h.session.whenIdle();
      const afterResume = { handoffs: [...handoffs], runs: h.runs.length, intent: h.session.getState().runRequested };
      await h.session.press(); // Cancel the resumed intent, then issue a genuine new Start.
      await h.session.press(); await h.session.whenIdle();

      // Assert: same-intent resume adds nothing, while explicit new intent shows themed Loading again.
      assert.deepEqual(before, [['title', ''], ['image', createLaunchArtwork('waiting', 'program')]]);
      assert.deepEqual(afterResume, { handoffs: before, runs: 1, intent: true });
      if (stage === 'Loading') assert.equal(staleLoading, false);
      assert.equal(h.runs.length, 2);
      assert.equal(h.runs[0].stops, 1);
      assert.deepEqual(handoffs.slice(-2), [['title', ''], ['image', createLaunchArtwork('waiting', 'program', '#abcdef')]]);
      assert.deepEqual(saved, []);
      assert.deepEqual(h.errors, []);
    });
  }
}

for (const output of ['primitive', 'opaque']) {
  test(`slow silent resume defers built-in theme redraws; fresh ${output} follows normal output policy`, options, async () => {
    // Arrange: intentionally no output from either generation before the theme changes.
    const h = displayHarness(); await h.start(settings);
    await h.session.disappear();
    const before = [...h.handoffs];
    // Act
    await h.session.appear({ ...settings, themeColor: '#123456' });
    await h.session.applySettings({ ...settings, themeColor: '#abcdef' });
    await h.session.refreshAppearance(); await h.session.whenIdle();
    const slow = [...h.handoffs];
    const record = output === 'primitive' ? parseOutputUpdate('text:fresh') : update('opaque');
    h.runs[1].callbacks.onUpdate(record); await h.session.whenIdle();
    const fresh = [...h.handoffs];
    await h.session.applySettings({ ...settings, themeColor: '#654321' }); await h.session.whenIdle();
    // Assert: fresh primitive uses latest theme and recolors; opaque is neither recolored nor replayed.
    assert.deepEqual(slow, before);
    assert.equal(h.runs.length, 2);
    assert.deepEqual(h.runs.map(run => run.stops), [1, 0]);
    assert.equal(fresh.length, before.length + 2);
    if (output === 'primitive') {
      assert.match(decodeURIComponent(fresh.at(-1)[1]), /#abcdef/);
      assert.equal(h.handoffs.length, fresh.length + 2);
      assert.match(decodeURIComponent(h.handoffs.at(-1)[1]), /#654321/);
    } else {
      assert.equal(fresh.at(-1)[1], record.image);
      assert.deepEqual(h.handoffs, fresh);
    }
    assert.equal(h.session.getState().presentation, 'streaming');
    assert.deepEqual(h.errors, []);
  });
}

for (const outcome of ['false', 'reject']) {
  test(`silent resume complete confirmation ${outcome} blocks spawn and retains persistence error priority`, options, async () => {
    // Arrange
    let confirmations = 0;
    const h = displayHarness({ async confirmLaunchSettings() {
      if (++confirmations === 1) return true;
      if (outcome === 'reject') throw Error('synthetic confirmation failure');
      return false;
    } });
    await h.start(settings); await h.session.disappear();
    const before = [...h.handoffs];
    // Act
    await h.session.appear(settings); await h.session.whenIdle();
    await h.session.refreshAppearance(); await h.session.reconcileAvailability();
    // Assert: silence suppresses interim cards, not the fixed terminal error path.
    assert.deepEqual(h.handoffs, before);
    assert.equal(h.runs.length, 1);
    assert.equal(h.session.getState().persistenceBlocked, true);
    assert.equal(h.session.getState().runRequested, false);
    assert.equal(h.session.getState().presentation, 'error');
    assert.ok(h.diagnostics.length > 0 && h.diagnostics.every(code => code === 'STATE_SAVE_FAILED'));
  });
}

test('fast silent return cannot replace uncertain cleanup or draw Loading beneath its error', options, async () => {
  // Arrange
  const cleanup = deferred(), h = displayHarness(); await h.start(settings);
  h.runs[0].stopGate = cleanup; const before = [...h.handoffs];
  // Act
  const hide = h.session.disappear(); await h.runs[0].stopStarted.promise;
  const resume = h.session.appear(settings);
  cleanup.resolve(false); await Promise.all([hide, resume]); await h.session.whenIdle();
  await h.session.reconcileAvailability();
  // Assert
  assert.deepEqual(h.handoffs, before);
  assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0].stops, 1);
  assert.equal(h.session.getState().cleanupBlocked, true);
  assert.equal(h.session.getState().presentation, 'error');
  assert.ok(h.diagnostics.length > 0 && h.diagnostics.every(code => code === 'CLEANUP_BLOCKED'));
});

for (const terminal of ['success-empty', 'success-output', 'nonzero', 'protocol', 'launch']) {
  test(`silent resumed ${terminal} publishes only fresh output or confirmed terminal artwork and never retries`, options, async () => {
    // Arrange: producer output is optional; terminal drain is still independent of resume silence.
    const active = deferred(), entered = deferred(), handoffs = [];
    const h = harness({
      async onPresentation(kind, caption, current, color, footer, extension) {
        if (current()) handoffs.push(['title', ''], ['image', createLaunchArtwork(kind, caption, color, footer, extension)]);
      },
      async setTitle(title, current) { if (current()) handoffs.push(['title', title]); },
      async setImage(image, current) {
        if (current()) handoffs.push(['image', image]);
        if (image === update('active').image) { entered.resolve(); await active.promise; }
      },
    });
    await h.start(settings); await h.session.disappear();
    const beforeResume = [...handoffs];
    await h.session.appear(settings);
    assert.deepEqual(handoffs, beforeResume);
    const resumed = h.runs[1], success = terminal.startsWith('success');
    if (terminal === 'success-output') {
      resumed.callbacks.onUpdate(update('active')); await entered.promise;
      resumed.callbacks.onUpdate(update('final'));
    }

    // Act: observe the terminal fact, but don't paint Exited until completion and final-frame drain.
    if (success) resumed.callbacks.onDiagnostic('PROCESS_EXITED_SUCCESSFULLY');
    if (terminal === 'nonzero') resumed.callbacks.onDiagnostic('PROCESS_EXITED_NONZERO');
    const message = terminal === 'protocol' ? 'Image protocol error.' : terminal === 'launch' ? 'Program launch failed.' : 'Program exited unsuccessfully.';
    if (!success) resumed.callbacks.onError(message);
    const beforeDone = [...handoffs];
    resumed.resolve(success ? { status: 'success' } : { status: 'error', error: message });
    active.resolve(); await h.session.whenIdle();
    await h.session.reconcileAvailability(); await h.session.appear(settings);
    const beforePress = { runs: h.runs.length, intent: h.session.getState().runRequested, phase: h.session.getState().phase };

    // Assert: no interim Loading/Ready, final producer drains, errors outrank the retained card.
    assert.deepEqual(beforeDone, terminal === 'success-output' ? [...beforeResume, ...displayed('active')] : beforeResume);
    assert.equal(beforePress.runs, 2);
    assert.equal(beforePress.intent, false);
    assert.equal(beforePress.phase, 'stopped');
    assert.deepEqual(h.saves, []);
    if (success) {
      assert.deepEqual(handoffs.slice(beforeResume.length), [
        ...(terminal === 'success-output' ? [...displayed('active'), ...displayed('final')] : []),
        ['title', ''], ['image', createLaunchArtwork('ready', 'program', undefined, 'exited')],
      ]);
      assert.deepEqual(h.errors, []);
    } else {
      assert.deepEqual(handoffs, beforeResume);
      assert.deepEqual(h.errors, [message]);
      assert.deepEqual(h.diagnostics, [terminal === 'protocol' ? 'IMAGE_PROTOCOL_ERROR' : terminal === 'launch' ? 'PROCESS_LAUNCH_FAILED' : 'PROCESS_EXITED_NONZERO']);
      assert.equal(h.session.getState().presentation, 'error');
      assert.equal(h.session.getState().protocolBlocked, terminal === 'protocol');
    }
  });
}

test('cancel silent resume during final confirmation prevents spawn; a genuine new Start shows Loading', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred(); let confirmations = 0;
  const h = displayHarness({ async confirmLaunchSettings() {
    if (++confirmations === 2) { entered.resolve(); await gate.promise; }
    return true;
  } });
  await h.start(settings); await h.session.disappear();
  const before = [...h.handoffs];
  const resume = h.session.appear(settings); await entered.promise;
  // Act
  const cancel = h.session.press();
  gate.resolve(); await Promise.all([resume, cancel]); await h.session.whenIdle();
  const canceled = { runs: h.runs.length, intent: h.session.getState().runRequested };
  await h.session.press();
  // Assert
  assert.deepEqual(canceled, { runs: 1, intent: false });
  assert.equal(h.runs.length, 2);
  assert.deepEqual(h.handoffs, [...before,
    ['title', ''], ['image', createLaunchArtwork('ready', 'program')],
    ['title', ''], ['image', createLaunchArtwork('waiting', 'program')],
  ]);
  assert.deepEqual(h.saves, []);
  assert.deepEqual(h.errors, []);
});

for (const outcome of ['false', 'reject']) {
  test(`silent resume configuration confirmation ${outcome} cannot authorize replacement`, options, async () => {
    // Arrange
    let saves = 0;
    const h = displayHarness({ async confirmLaunchSettings() {
      if (++saves === 1) return true;
      if (outcome === 'reject') throw Error('synthetic persistence failure');
      return false;
    } });
    await h.start(settings); await h.session.disappear();
    const before = [...h.handoffs];
    // Act
    await h.session.appear(settings); await h.session.whenIdle();
    // Assert
    assert.equal(h.runs.length, 1);
    assert.deepEqual(h.handoffs, before);
    assert.equal(h.session.getState().persistenceBlocked, true);
    assert.equal(h.session.getState().runRequested, false);
    assert.deepEqual(h.diagnostics, ['STATE_SAVE_FAILED']);
  });
}

// Slice 4: the optional storage boundary confirms complete Started settings after Loading.
for (const outcome of ['confirmed', 'false', 'reject']) {
  test(`final launch confirmation ${outcome} controls spawn without additional intent writes`, options, async () => {
    // Arrange
    const gate = deferred(), entered = deferred(), expected = [];
    const h = harness({ confirmLaunchSettings(snapshot) { expected.push(snapshot); entered.resolve(); return gate.promise; } });
    const configured = { ...settings, runRequested: false, themeColor: '#123456' }; await h.session.appear(configured);
    // Act
    const starting = h.session.press(); await entered.promise;
    const before = { launches: h.runs.length, presentation: h.artwork.at(-1).kind };
    if (outcome === 'reject') gate.reject(Error('synthetic storage boundary')); else gate.resolve(outcome === 'confirmed');
    await starting; await h.session.whenIdle();
    // Assert
    assert.deepEqual(before, { launches: 0, presentation: 'waiting' });
    assert.deepEqual(expected, [configured]); assert.deepEqual(h.saves, []);
    assert.equal(h.runs.length, outcome === 'confirmed' ? 1 : 0);
    assert.equal(h.session.getState().persistenceBlocked, outcome !== 'confirmed');
    if (outcome !== 'confirmed') assert.deepEqual(h.diagnostics, ['STATE_SAVE_FAILED']);
  });
}

for (const older of ['false', 'reject', 'true']) {
  test(`superseded theme confirmation ${older} retries latest complete snapshot without latching an error`, options, async () => {
    // Arrange
    const first = deferred(), firstEntered = deferred(), second = deferred(), secondEntered = deferred(), expected = [];
    const h = harness({ confirmLaunchSettings(snapshot) {
      expected.push(snapshot); (expected.length === 1 ? firstEntered : secondEntered).resolve();
      return expected.length === 1 ? first.promise : second.promise;
    } });
    const configured = { ...settings, runRequested: false, themeColor: '#123456' }; await h.session.appear(configured);
    const starting = h.session.press(); await firstEntered.promise;
    // Act
    const editing = h.session.applySettings({ ...configured, themeColor: '#abcdef' });
    if (older === 'reject') first.reject(Error('superseded synthetic read')); else first.resolve(older === 'true');
    await secondEntered.promise; const before = h.runs.length;
    second.resolve(true); await Promise.all([starting, editing]); await h.session.whenIdle();
    // Assert: a cosmetic supersession retains explicit Start, even if desired configuration says Stopped.
    assert.equal(before, 0); assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 0);
    assert.deepEqual(expected, [configured, { ...configured, themeColor: '#abcdef' }]);
    assert.deepEqual(h.saves, []); assert.deepEqual(h.errors, []); assert.equal(h.session.getState().persistenceBlocked, false);
  });
}

for (const loss of ['hide', 'disconnect', 'stop', 'execution', 'persistence']) {
  test(`${loss} during final settings confirmation cannot spawn a stale Stream generation`, options, async () => {
    // Arrange
    const gate = deferred(), entered = deferred();
    const h = harness({ confirmLaunchSettings() { entered.resolve(); return gate.promise; } });
    await h.session.appear({ ...settings, runRequested: false }); const starting = h.session.press(); await entered.promise;
    // Act
    const transition = loss === 'hide' ? h.session.disappear() : loss === 'disconnect' ? h.session.setConnected(false)
      : loss === 'stop' ? h.session.press() : loss === 'execution' ? h.session.applySettings({ ...settings, executable: '/synthetic/replacement' })
        : h.session.persistenceFailed();
    gate.resolve(true); await Promise.all([starting, transition]); await h.session.whenIdle();
    // Assert
    assert.deepEqual(h.runs, []); assert.deepEqual(h.lifecycle, []);
    assert.deepEqual(h.saves, []);
    if (loss === 'persistence') assert.equal(h.session.getState().persistenceBlocked, true);
  });
}

// Slice 3: suffix is current configured-executable presentation metadata only.
test('Stream Ready, Loading and confirmed Exited forward the same configured suffix', options, async () => {
  // Arrange
  const configured = { executable: '/synthetic/report.PY', argsText: 'other.sh', runRequested: false };
  const h = harness(); await h.session.appear(configured);
  // Act
  await h.session.press(); h.runs[0].callbacks.onDiagnostic('PROCESS_EXITED_SUCCESSFULLY');
  h.runs[0].resolve({ status: 'success' }); await h.session.whenIdle();
  // Assert
  assert.deepEqual(h.artwork.map(item => [item.kind, item.caption, item.footer, item.extension]),
    [['ready', 'report', 'ready', '.py'], ['waiting', 'report', 'ready', '.py'], ['ready', 'report', 'exited', '.py']]);
  assert.ok(h.artwork.every(item => decodeURIComponent(item.image).includes('>.py</text>')));
  assert.deepEqual(h.saves, []); assert.equal(h.runs.length, 1);
});

for (const executable of ['/synthetic/python3', '']) {
  test('Stream never infers badge metadata from argv or partial Setup', options, async () => {
    // Arrange
    const h = harness();
    // Act
    await h.session.appear({ executable, argsText: '/synthetic/report.py', runRequested: false });
    // Assert
    assert.equal(h.artwork.at(-1).extension, undefined);
    assert.equal(h.artwork.at(-1).footer, executable ? 'ready' : 'setup required');
    assert.deepEqual(h.runs, []); assert.deepEqual(h.saves, []);
  });
}

test('Stream suffix-only execution replacement redraws identical caption without auto-launch', options, async () => {
  // Arrange
  const configured = { executable: '/synthetic/report.py', argsText: '', runRequested: false };
  const h = harness(); await h.session.appear(configured);
  // Act
  await h.session.applySettings({ ...configured, executable: '/synthetic/report.sh' }); await h.session.whenIdle();
  // Assert
  assert.equal(h.artwork[0].caption, 'report'); assert.equal(h.artwork[0].extension, '.py');
  assert.equal(h.artwork.at(-1).caption, 'report'); assert.equal(h.artwork.at(-1).extension, '.sh');
  assert.deepEqual(h.runs, []); assert.equal(h.session.getState().runRequested, false);
});

for (const stage of ['ready', 'waiting', 'exited']) {
  test(`Stream ${stage} badge follows cosmetic theme without new intent, stop or save`, options, async () => {
    // Arrange
    const configured = { executable: '/synthetic/report.py', argsText: '', runRequested: false };
    const h = harness(); await h.session.appear(configured);
    if (stage !== 'ready') await h.session.press();
    if (stage === 'exited') { h.runs[0].callbacks.onDiagnostic('PROCESS_EXITED_SUCCESSFULLY'); h.runs[0].resolve({ status: 'success' }); await h.session.whenIdle(); }
    const before = h.session.getState(), saves = [...h.saves], runs = h.runs.length;
    // Act
    await h.session.applySettings({ ...configured, runRequested: before.runRequested, themeColor: '#ABCDEF' }); await h.session.whenIdle();
    // Assert
    assert.match(decodeURIComponent(h.artwork.at(-1).image), /text-anchor="end"[^>]*fill="#abcdef">\.py<\/text>/);
    assert.equal(h.artwork.at(-1).footer, stage === 'exited' ? 'exited' : 'ready');
    assert.equal(h.session.getState().runRequested, before.runRequested);
    assert.deepEqual(h.saves, saves); assert.equal(h.runs.length, runs);
    assert.ok(h.runs.every(run => run.stops === 0)); assert.deepEqual(h.errors, []);
  });
}

for (const loss of ['hide', 'disconnect', 'replacement', 'theme', 'persistence']) {
  test(`held Stream badge guard rejects older ${loss} presentation`, options, async () => {
    // Arrange
    const gate = deferred(), entered = deferred(), accepted = [];
    let guard, hold = true;
    const configured = { executable: '/synthetic/report.py', argsText: '', runRequested: false };
    const h = harness({ async onPresentation(kind, caption, current, color, footer, extension) {
      if (hold) { hold = false; guard = current; entered.resolve(); await gate.promise; }
      if (current()) accepted.push([caption, color, extension]);
    } });
    const appearing = h.session.appear(configured); await entered.promise;
    // Act
    const transition = loss === 'hide' ? h.session.disappear() : loss === 'disconnect' ? h.session.setConnected(false)
      : loss === 'persistence' ? h.session.persistenceFailed()
        : h.session.applySettings(loss === 'theme' ? { ...configured, themeColor: '#abcdef' } : { ...configured, executable: '/synthetic/report.sh' });
    const stale = guard(); gate.resolve(); await Promise.all([appearing, transition]); await h.session.whenIdle();
    // Assert
    assert.equal(stale, false); assert.equal(guard(), false);
    assert.equal(accepted.some(([, color, extension]) => color === '#969696' && extension === '.py'), false);
    if (loss === 'replacement') assert.equal(accepted.at(-1)?.[2], '.sh');
    if (loss === 'theme') assert.deepEqual(accepted.at(-1), ['report', '#abcdef', '.py']);
    assert.deepEqual(h.runs, []);
  });
}

for (const record of ['text:plain', 'progress:45', '<svg>opaque</svg>']) {
  test('Stream producer frames remain byte-identical and never receive executable badges', options, async () => {
    // Arrange
    const h = harness(); await h.start({ executable: '/synthetic/report.py', argsText: '', runRequested: true });
    const producer = parseOutputUpdate(record), expected = producer.kind === 'image' ? producer.image : createPrimitiveArtwork(producer);
    // Act
    h.runs[0].callbacks.onUpdate(producer); await h.session.whenIdle();
    // Assert
    assert.equal(h.display.at(-1)?.[1], expected);
    assert.equal(decodeURIComponent(expected).includes('>.py</text>'), false);
  });
}

// Footer state is session-local display metadata, never a new persisted execution mode.
for (const output of [false, true]) {
  test(`owned natural success ${output ? 'with output' : 'without output'} shows exited only after settlement`, options, async () => {
    // Arrange
    const h = harness(); await h.start(settings);
    if (output) { h.runs[0].callbacks.onUpdate(update('final')); await h.session.whenIdle(); }
    // Act
    h.runs[0].callbacks.onDiagnostic('PROCESS_EXITED_SUCCESSFULLY');
    const beforeDone = h.artwork.map(item => item.footer);
    h.runs[0].resolve({ status: 'success' }); await h.session.whenIdle();
    await h.session.reconcileAvailability(); await h.session.appear(settings);
    // Assert
    assert.deepEqual(beforeDone, ['ready']);
    assert.deepEqual(h.artwork.map(item => [item.kind, item.caption, item.footer]), [['waiting', 'program', 'ready'], ['ready', 'program', 'exited']]);
    assert.match(decodeURIComponent(h.artwork.at(-1).image), />exited<\/text>/);
    assert.deepEqual(h.saves, []);
    assert.equal(h.runs.length, 1);
    assert.equal(h.session.getState().phase, 'stopped');
    assert.equal(h.session.getState().presentation, 'ready');
    assert.equal(h.session.getState().runRequested, false);
    assert.deepEqual(h.display, output ? displayed('final') : []);
  });
}

test('fresh idle and pending configuration confirmation use the basename and fixed loading footer; cancellation restores ready', options, async () => {
  // Arrange
  const entered = deferred(), gate = deferred();
  const h = harness({ async confirmLaunchSettings() { entered.resolve(); return gate.promise; } });
  await h.session.appear(execution);
  // Act
  const start = h.session.press(); await entered.promise;
  const pending = h.artwork.at(-1);
  const stop = h.session.press(); gate.resolve(true);
  await Promise.all([start, stop]); await h.session.whenIdle();
  // Assert
  assert.equal(pending.caption, 'program');
  assert.match(decodeURIComponent(pending.image), />program<\/text>.*>loading\.\.\.<\/text>/);
  assert.equal(pending.current(), false);
  assert.deepEqual(h.artwork.map(item => item.footer), ['ready', 'ready', 'ready']);
  assert.deepEqual(h.runs, []);
  assert.equal(h.artwork.at(-1).kind, 'ready');
});

// stream-redraw-failure rev1: cosmetics may fail, but must never leave an owned child running silently.
for (const edit of ['title', 'theme']) {
  for (const reject of [false, true]) {
    test(`Stream ${edit}-only Waiting redraw ${reject ? 'rejection stops ownership and clears intent' : 'success preserves ownership and accepts output'}`, options, async () => {
      // Arrange
      const gate = deferred(), entered = deferred(); let calls = 0;
      const h = harness({ async onPresentation() { if (++calls === 2) { entered.resolve(); await gate.promise; } } });
      await h.start(settings);
      const edited = { ...settings, ...(edit === 'title' ? { title: 'edited' } : { themeColor: '#abcdef' }) };
      // Act
      const editing = h.session.applySettings(edited); await entered.promise;
      if (reject) gate.reject(new Error('private redraw exception/env/argv')); else gate.resolve();
      await editing; await h.session.whenIdle();
      const afterRedraw = h.session.getState();
      h.runs[0].callbacks.onUpdate(update('after-redraw')); await h.session.whenIdle();
      await h.session.reconcileAvailability(); await h.session.appear(edited); await h.session.whenIdle();
      // Assert
      assert.equal(h.runs[0].stops, reject ? 1 : 0);
      assert.equal(afterRedraw.runRequested, !reject);
      assert.equal(afterRedraw.phase, reject ? 'stopped' : 'running');
      assert.deepEqual(h.errors, reject ? ['Frame send failed.'] : []);
      assert.deepEqual(h.diagnostics, reject ? ['FRAME_SEND_FAILED'] : []);
      assert.deepEqual(h.display, reject ? [] : displayed('after-redraw'));
      assert.equal(h.runs.length, 1); assert.deepEqual(h.saves, []);
    });
  }
}

for (const certain of [true, false]) {
  test(`Stream Waiting redraw rejection drains held ${certain ? 'certain' : 'uncertain'} cleanup without overlap or serial-tail deadlock`, options, async () => {
    // Arrange
    const redraw = deferred(), entered = deferred(), cleanup = deferred(); let calls = 0;
    const h = harness({ async onPresentation() { if (++calls === 2) { entered.resolve(); await redraw.promise; } } });
    await h.start(settings); const owned = h.runs[0]; owned.stopGate = cleanup;
    const edited = { ...settings, title: 'edited' };
    // Act: settle every gate even on the known regression (where no stop is requested).
    const editing = h.session.applySettings(edited); await entered.promise;
    redraw.reject(new Error('private redraw exception'));
    await Promise.race([owned.stopStarted.promise, editing]);
    const during = { runs: h.runs.length, stops: owned.stops, state: h.session.getState() };
    const busyPress = h.session.press();
    const beforeCleanup = h.runs.length;
    cleanup.resolve(certain); await Promise.all([editing, busyPress]); await h.session.whenIdle();
    const settled = h.session.getState();
    await h.session.reconcileAvailability(); await h.session.appear(edited); await h.session.whenIdle();
    if (!certain) { await h.session.press(); await h.session.whenIdle(); }
    owned.callbacks.onUpdate(update('late-after-cleanup')); await h.session.whenIdle();
    // Assert
    assert.equal(during.stops, 1); assert.equal(during.state.phase, 'stopping');
    assert.equal(during.state.runRequested, false);
    assert.equal(during.runs, 1); assert.equal(beforeCleanup, 1); assert.equal(h.runs.length, 1);
    assert.equal(owned.stops, 1); assert.equal(settled.phase, 'stopped');
    assert.equal(settled.runRequested, false); assert.equal(settled.cleanupBlocked, !certain);
    assert.equal(h.errors.at(-1), certain ? 'Frame send failed.' : 'Process cleanup uncertain.');
    assert.equal(h.diagnostics.at(-1), certain ? 'FRAME_SEND_FAILED' : 'CLEANUP_BLOCKED');
    assert.deepEqual(h.display, []);
  });
}

for (const newer of ['run', 'presentation']) {
  test(`Stream stale Waiting redraw rejection after newer ${newer} cannot stop current ownership or suppress output`, options, async () => {
    // Arrange
    const gate = deferred(), entered = deferred(), imageEntered = deferred(); let calls = 0, guard;
    const h = harness({
      async onPresentation(kind, caption, current) {
        if (++calls === 2) { guard = current; entered.resolve(); await gate.promise; }
      },
      async setImage(image, current) {
        if (current()) h.display.push(['image', image]);
        imageEntered.resolve();
      },
    });
    await h.start(settings);
    const edited = { ...settings, title: 'edited' };
    // Act
    const editing = h.session.applySettings(edited); await entered.promise;
    if (newer === 'run') { await h.session.press(); await h.session.press(); }
    const current = h.runs.at(-1);
    current.callbacks.onUpdate(update('newer')); // Producer publication supersedes the retained Waiting presentation.
    await imageEntered.promise;
    const stale = guard();
    gate.reject(new Error('private obsolete redraw')); await editing; await h.session.whenIdle();
    current.callbacks.onUpdate(update('still-current')); await h.session.whenIdle();
    // Assert
    assert.equal(stale, false); assert.equal(current.stops, 0);
    assert.deepEqual(h.runs.map(run => run.stops), newer === 'run' ? [1, 0] : [0]);
    assert.deepEqual(h.errors, []); assert.deepEqual(h.diagnostics, []);
    assert.deepEqual(h.display.slice(-2), displayed('still-current'));
    assert.equal(h.session.getState().runRequested, true); assert.equal(h.session.getState().phase, 'running');
  });
}

test('Stream current pending Waiting redraw rejection stops the child launched while that redraw was awaiting', options, async () => {
  // Arrange
  const initial = deferred(), initialEntered = deferred(), redraw = deferred(), redrawEntered = deferred(); let calls = 0;
  const h = harness({ async onPresentation() {
    if (++calls === 1) { initialEntered.resolve(); await initial.promise; }
    else if (calls === 2) { redrawEntered.resolve(); await redraw.promise; }
  } });
  const starting = h.start(settings); await initialEntered.promise;
  // Act
  const editing = h.session.applySettings({ ...settings, themeColor: '#abcdef' }); await redrawEntered.promise;
  const beforeLaunch = h.runs.length;
  initial.resolve(); await starting;
  const beforeRejection = { runs: h.runs.length, stops: h.runs[0].stops };
  redraw.reject(new Error('private pending redraw')); await editing; await h.session.whenIdle();
  await h.session.reconcileAvailability(); await h.session.whenIdle();
  // Assert
  assert.equal(beforeLaunch, 0); assert.deepEqual(beforeRejection, { runs: 1, stops: 0 });
  assert.equal(h.runs.length, 1); assert.equal(h.runs[0].stops, 1);
  assert.equal(h.session.getState().runRequested, false); assert.equal(h.session.getState().phase, 'stopped');
  assert.deepEqual(h.errors, ['Frame send failed.']); assert.deepEqual(h.diagnostics, ['FRAME_SEND_FAILED']);
});

for (const completed of [false, true]) {
  test(`Stream ${completed ? 'completed retained generation' : 'idle without generation'} redraw rejection reports fixed error without spurious stop`, options, async () => {
    // Arrange
    let reject = false;
    const h = harness({ async onPresentation() { if (reject) throw Error('private idle redraw'); } });
    if (completed) {
      await h.start(settings); h.runs[0].resolve({ status: 'success' }); await h.session.whenIdle();
    } else await h.session.appear(settings);
    reject = true;
    // Act
    await h.session.applySettings({ ...settings, themeColor: '#abcdef' }); await h.session.whenIdle();
    await h.session.reconcileAvailability(); await h.session.whenIdle();
    // Assert
    assert.equal(h.runs.length, completed ? 1 : 0);
    assert.deepEqual(h.runs.map(run => run.stops), completed ? [0] : []);
    assert.equal(h.session.getState().runRequested, false); assert.equal(h.session.getState().phase, 'stopped');
    assert.deepEqual(h.errors, ['Frame send failed.']); assert.deepEqual(h.diagnostics, ['FRAME_SEND_FAILED']);
  });
}

test('running before first output recolors Loading without changing its script caption or intent', options, async () => {
  // Arrange
  const h = harness(); await h.start(settings);
  // Act
  await h.session.applySettings({ ...settings, themeColor: '#ABCDEF' }); await h.session.whenIdle();
  // Assert
  assert.deepEqual(h.artwork.map(item => [item.kind, item.caption, item.footer]), [['waiting', 'program', 'ready'], ['waiting', 'program', 'ready']]);
  assert.match(decodeURIComponent(h.artwork.at(-1).image), /#abcdef.*>program<\/text>.*>loading\.\.\.<\/text>/);
  assert.deepEqual(h.saves, []);
  assert.equal(h.runs[0].stops, 0);
  assert.equal(h.session.getState().phase, 'running');
});

for (const pause of ['hide', 'disconnect']) {
  for (const natural of [false, true]) {
    test(`${pause} ${natural ? 'verified natural zero exit retains exited' : 'forced stop preserves Started without false exited'}`, options, async () => {
      // Arrange
      const h = harness(); await h.start(settings);
      const old = h.runs[0];
      await (pause === 'hide' ? h.session.disappear() : h.session.setConnected(false));
      const before = h.artwork.length;
      // Act
      if (natural) old.callbacks.onDiagnostic('PROCESS_EXITED_SUCCESSFULLY');
      old.resolve({ status: 'stopped' }); await h.session.whenIdle();
      const hiddenIntent = h.session.getState().runRequested;
      const whileUnavailable = h.artwork.length;
      await (pause === 'hide' ? h.session.appear(settings) : h.session.setConnected(true));
      await h.session.whenIdle();
      // Assert
      assert.equal(whileUnavailable, before);
      assert.equal(hiddenIntent, !natural);
      assert.equal(h.runs.length, natural ? 1 : 2);
      assert.equal(h.artwork.at(-1).footer, natural ? 'exited' : 'ready');
      assert.equal(h.artwork.at(-1).kind, natural ? 'ready' : 'waiting');
      assert.equal(h.artwork.length, before + (natural ? 1 : 0));
      assert.deepEqual(h.saves, []);
      assert.equal(old.stops, 1);
    });
  }
}

test('manual stop rejects a late natural-success diagnostic and resets the footer for the next launch', options, async () => {
  // Arrange
  const h = harness(); await h.start(settings);
  // Act
  await h.session.press();
  h.runs[0].callbacks.onDiagnostic('PROCESS_EXITED_SUCCESSFULLY'); h.runs[0].resolve({ status: 'success' });
  await h.session.whenIdle(); const stopped = h.artwork.at(-1);
  await h.session.press(); await h.session.whenIdle();
  // Assert
  assert.equal(stopped.footer, 'ready');
  assert.equal(h.artwork.at(-1).footer, 'ready');
  assert.equal(h.artwork.at(-1).kind, 'waiting');
  assert.equal(h.artwork.some(item => item.footer === 'exited'), false);
  assert.equal(h.runs.length, 2);
  assert.deepEqual(h.saves, []);
});

test('exited is isolated between keys and never inherited by a fresh session', options, async () => {
  // Arrange
  const first = harness(), other = harness(), fresh = harness();
  await first.start(settings); await other.session.appear(execution);
  // Act
  first.runs[0].callbacks.onDiagnostic('PROCESS_EXITED_SUCCESSFULLY'); first.runs[0].resolve({ status: 'success' });
  await first.session.whenIdle(); await fresh.session.appear({ ...settings, runRequested: false });
  // Assert
  assert.equal(first.artwork.at(-1).footer, 'exited');
  assert.equal(other.artwork.at(-1).footer, 'ready');
  assert.equal(fresh.artwork.at(-1).footer, 'ready');
  assert.deepEqual(other.saves, []); assert.deepEqual(fresh.saves, []);
  assert.deepEqual(other.runs, []); assert.deepEqual(fresh.runs, []);
});

for (const superseding of ['start', 'execution edit', 'persistence error']) {
  test(`deferred exited publication cannot overwrite a newer ${superseding}`, options, async () => {
    // Arrange
    const gate = deferred(), entered = deferred(), rendered = [];
    let guard;
    const h = harness({ async onPresentation(kind, caption, current, color, footer) {
      if (footer === 'exited') { guard = current; entered.resolve(); await gate.promise; }
      if (current()) rendered.push([kind, caption, footer]);
    } });
    await h.start(settings);
    // Act
    h.runs[0].callbacks.onDiagnostic('PROCESS_EXITED_SUCCESSFULLY'); h.runs[0].resolve({ status: 'success' }); await entered.promise;
    const transition = superseding === 'start' ? h.session.press() : superseding === 'execution edit'
      ? h.session.applySettings({ executable: '/replacement', args: [] }) : h.session.persistenceFailed();
    const stale = guard(); gate.resolve(); await transition; await h.session.whenIdle();
    if (superseding === 'start') { h.runs[1].callbacks.onUpdate(update('new')); await h.session.whenIdle(); }
    // Assert
    assert.equal(stale, false);
    assert.equal(rendered.some(item => item[2] === 'exited'), false);
    if (superseding === 'start') { assert.deepEqual(h.display, displayed('new')); assert.equal(h.runs.length, 2); }
    if (superseding === 'execution edit') assert.deepEqual(rendered.at(-1), ['ready', 'replacement', 'ready']);
    if (superseding === 'persistence error') { assert.equal(h.session.getState().presentation, 'error'); assert.deepEqual(h.diagnostics, ['STATE_SAVE_FAILED']); }
  });
}

test('deferred Loading recolor loses its guard when success changes the idle footer', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred(), successEntered = deferred(), painted = []; let guard;
  const h = harness({ async onPresentation(kind, caption, current, color, footer) {
    if (kind === 'waiting' && color === '#abcdef') { guard = current; entered.resolve(); await gate.promise; }
    if (footer === 'exited') successEntered.resolve();
    if (current()) painted.push([kind, caption, footer]);
  } });
  await h.start(settings);
  // Act
  const recolor = h.session.applySettings({ ...settings, themeColor: '#abcdef' }); await entered.promise;
  h.runs[0].callbacks.onDiagnostic('PROCESS_EXITED_SUCCESSFULLY'); h.runs[0].resolve({ status: 'success' });
  await successEntered.promise;
  const stale = guard(); gate.resolve(); await recolor; await h.session.whenIdle();
  // Assert
  assert.equal(stale, false);
  assert.deepEqual(painted, [['waiting', 'program', 'ready'], ['ready', 'program', 'exited']]);
  assert.deepEqual(h.saves, []);
});

// Explicit per-session intent, not persisted metadata or visibility, controls execution.
test('new action defaults Stopped and idle press starts literal execution', options, async () => {
  // Arrange
  const h = harness();
  // Act
  await h.session.appear(execution);
  const before = h.runs.length;
  await h.session.press();
  // Assert
  assert.equal(before, 0);
  assert.deepEqual(h.runs.map(run => run.input), [execution]);
  assert.deepEqual(h.saves, []);
  assert.equal(h.session.getState().phase, 'running');
});

test('explicit Started and success drain caption-cleared producer frames before Ready', options, async () => {
  // Arrange
  const h = harness();
  // Act
  await h.start(settings);
  h.runs[0].callbacks.onUpdate(update('first', 'Ready'));
  await h.session.whenIdle();
  h.runs[0].callbacks.onUpdate(update('second'));
  await h.session.whenIdle();
  h.runs[0].callbacks.onUpdate(update('final', ''));
  h.runs[0].resolve({ status: 'success' });
  await h.session.whenIdle();
  // Assert
  assert.equal(h.runs.length, 1);
  assert.deepEqual(h.display, [...displayed('first'), ...displayed('second'), ...displayed('final')]);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.saves, []);
  assert.equal(h.session.getState().runRequested, false);
  assert.deepEqual(h.presentations, [['waiting', 'program'], ['ready', 'program']]);
});

test('caption clears before image, pending frames coalesce and final frame drains after completion', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred(), sends = [];
  const h = harness({
    setImage(image) { sends.push(['image', image]); if (image === update('first').image) { entered.resolve(); return gate.promise; } return Promise.resolve(); },
    async setTitle(title) { sends.push(['title', title]); },
  });
  await h.start(settings);
  // Act
  h.runs[0].callbacks.onUpdate(update('first', 'First'));
  await entered.promise;
  h.runs[0].callbacks.onUpdate(update('pending-old', 'Pending'));
  h.runs[0].callbacks.onUpdate(update('pending-final'));
  const before = [...sends];
  h.runs[0].resolve({ status: 'success' });
  gate.resolve();
  await h.session.whenIdle();
  // Assert
  assert.deepEqual(before, displayed('first'));
  assert.deepEqual(sends, [...displayed('first'), ...displayed('pending-final')]);
  assert.equal(h.session.getState().phase, 'stopped');
});

test('running press stops once and repeated stopping presses never restart', options, async () => {
  // Arrange
  const h = harness();
  await h.start(settings);
  const gate = deferred(); h.runs[0].stopGate = gate;
  // Act
  const stopping = h.session.press();
  await h.runs[0].stopStarted.promise;
  const repeat = h.session.press();
  const before = h.runs.length;
  gate.resolve(true);
  await Promise.all([stopping, repeat]);
  // Assert
  assert.equal(before, 1);
  assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0].stops, 1);
  assert.deepEqual(h.saves, []);
  assert.equal(h.session.getState().phase, 'stopped');
});

test('press during Starting cancels launch even if configuration confirmation arrives late', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred(), saves = [];
  const h = harness({ async confirmLaunchSettings() { entered.resolve(); return gate.promise; } });
  await h.session.appear(execution);
  // Act
  const start = h.session.press();
  await entered.promise;
  const stop = h.session.press();
  gate.resolve(true);
  await Promise.all([start, stop]);
  // Assert
  assert.deepEqual(h.runs, []);
  assert.deepEqual(saves, []);
  assert.equal(h.session.getState().phase, 'stopped');
});

test('unconfirmed configuration cannot authorize launch', options, async () => {
  // Arrange
  const h = harness({ async confirmLaunchSettings() { return false; } });
  // Act
  await h.start(settings);
  // Assert
  assert.deepEqual(h.runs, []);
});

test('settings edit stops and remembers Stopped without replacement; next press uses current settings', options, async () => {
  // Arrange
  const h = harness();
  await h.start(settings);
  const next = { executable: '/replacement', argsText: '"literal argument" ""', cwd: '/cwd' };
  // Act
  await h.session.applySettings(next);
  const before = h.runs.length;
  await h.session.press();
  // Assert
  assert.equal(before, 1);
  assert.deepEqual(h.lifecycle, [['start', settings.executable], ['stop', settings.executable], ['start', next.executable]]);
  assert.deepEqual(h.runs[1].input, { executable: next.executable, args: ['literal argument', ''], cwd: next.cwd });
  assert.deepEqual(h.saves, []);
});

test('equivalent legacy migration preserves live execution', options, async () => {
  // Arrange
  const h = harness();
  await h.start(settings);
  // Act
  await h.session.applySettings({ ...settings, argsText: 'literal', cwd: '' });
  h.runs[0].callbacks.onUpdate(update('still-current'));
  await h.session.whenIdle();
  // Assert
  assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0].stops, 0);
  assert.deepEqual(h.saves, []);
  assert.deepEqual(h.display, displayed('still-current'));
});

test('hide stops actual execution but remembers Started for reappearance', options, async () => {
  // Arrange
  const h = harness();
  await h.start(settings);
  // Act
  await h.session.disappear();
  h.runs[0].callbacks.onUpdate(update('hidden'));
  h.runs[0].callbacks.onError('Image protocol error.');
  h.runs[0].resolve({ status: 'error', error: 'Image protocol error.' });
  await h.session.whenIdle();
  const hiddenState = h.session.getState();
  await h.session.appear(settings);
  h.runs[1].callbacks.onUpdate(update('current'));
  await h.session.whenIdle();
  // Assert
  assert.equal(hiddenState.runRequested, true);
  assert.deepEqual(h.saves, []);
  assert.equal(h.runs[0].stops, 1);
  assert.deepEqual(h.display, displayed('current'));
  assert.deepEqual(h.errors, []);
});

test('overlapping start, settings edit and hiding cannot launch hidden replacement', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred();
  const h = harness({ async confirmLaunchSettings() { entered.resolve(); return gate.promise; } });
  await h.session.appear(execution);
  // Act
  const start = h.session.press();
  await entered.promise;
  const edit = h.session.applySettings({ executable: '/replacement', args: [] });
  const hide = h.session.disappear();
  gate.resolve(true);
  await Promise.all([start, edit, hide]);
  // Assert
  assert.deepEqual(h.runs, []);
  assert.equal(h.session.getState().visible, false);
  assert.equal(h.session.getState().runRequested, false);
});

test('protocol latch survives visibility then matching execution edit recovers without launching', options, async () => {
  // Arrange
  const h = harness();
  await h.start(settings);
  // Act
  h.runs[0].callbacks.onError('Image protocol error.');
  h.runs[0].resolve({ status: 'error', error: 'Image protocol error.' });
  await h.session.whenIdle();
  await h.session.disappear();
  await h.session.appear(settings);
  await h.session.applySettings({ executable: '/replacement', args: [] });
  const before = h.runs.length;
  const recovered = h.session.getState();
  await h.session.press();
  // Assert
  assert.equal(before, 1);
  assert.equal(h.runs.length, 2);
  assert.equal(h.runs[1].input.executable, '/replacement');
  assert.equal(recovered.protocolBlocked, false);
  assert.equal(recovered.presentation, 'ready');
  assert.equal(recovered.runRequested, false);
  assert.deepEqual(h.errors, Array(2).fill('Image protocol error.'));
  assert.deepEqual(h.diagnostics, Array(2).fill('IMAGE_PROTOCOL_ERROR'));
});

test('fresh plugin session ignores legacy Started without inheriting old protocol latch', options, async () => {
  // Arrange
  const old = harness(), fresh = harness();
  await old.start(settings);
  old.runs[0].callbacks.onError('Image protocol error.');
  old.runs[0].resolve({ status: 'error', error: 'Image protocol error.' });
  await old.session.whenIdle();
  // Act
  await fresh.session.appear(structuredClone(settings));
  // Assert
  assert.equal(fresh.runs.length, 0);
  assert.equal(fresh.session.getState().runRequested, false);
  assert.equal(fresh.session.getState().protocolBlocked, false);
  assert.deepEqual(fresh.errors, []);
});

test('copied settings and independent sessions never cross-write or cross-render', options, async () => {
  // Arrange
  const first = harness(), second = harness();
  const copy = structuredClone(settings);
  // Act
  await Promise.all([first.start(settings), second.start(copy)]);
  await first.session.press();
  first.runs[0].callbacks.onUpdate(update('stale-first'));
  second.runs[0].callbacks.onUpdate(update('second'));
  await Promise.all([first.session.whenIdle(), second.session.whenIdle()]);
  // Assert
  assert.deepEqual(first.saves, []);
  assert.deepEqual(second.saves, []);
  assert.deepEqual(first.display, []);
  assert.deepEqual(second.display, displayed('second'));
  assert.equal(second.runs[0].stops, 0);
  assert.deepEqual(copy, settings);
});

test('uncertain cleanup blocks later start with fixed diagnosis', options, async () => {
  // Arrange
  const h = harness();
  await h.start(settings);
  h.runs[0].stopResult = false;
  // Act
  await h.session.press();
  await h.session.applySettings({ executable: '/replacement', args: [] });
  await h.session.press();
  // Assert
  assert.equal(h.runs.length, 1);
  assert.equal(h.session.getState().cleanupBlocked, true);
  assert.ok(h.errors.every(message => message === 'Process cleanup uncertain.'));
  assert.ok(h.diagnostics.every(code => code === 'CLEANUP_BLOCKED'));
});

for (const [message, diagnostic] of [
  ['Program launch failed.', 'PROCESS_LAUNCH_FAILED'],
  ['Program exited unsuccessfully.', undefined],
  ['Program exited unsuccessfully.', 'PROCESS_EXITED_NONZERO'],
  ['Program exited unsuccessfully.', 'PROCESS_TERMINATED_BY_SIGNAL'],
]) {
  test(`completion ${String(diagnostic)} stops without retry and uses only verified diagnosis`, options, async () => {
    // Arrange
    const h = harness();
    await h.start(settings);
    // Act
    h.runs[0].callbacks.onDiagnostic(diagnostic ?? 'private-unverified-diagnostic');
    h.runs[0].callbacks.onError(message);
    h.runs[0].resolve({ status: 'error', error: message });
    await h.session.whenIdle();
    const before = h.runs.length;
    await h.session.press();
    // Assert
    assert.equal(before, 1);
    assert.equal(h.runs.length, 2);
    assert.deepEqual(h.errors, [message]);
    assert.deepEqual(h.diagnostics, [diagnostic]);
    assert.deepEqual(h.saves, []);
  });
}

test('hiding after known failure cannot retain Started', options, async () => {
  // Arrange
  const h = harness();
  await h.start(settings);
  // Act
  h.runs[0].callbacks.onError('Program launch failed.');
  await h.session.disappear();
  await h.session.appear(settings);
  // Assert
  assert.equal(h.runs.length, 1);
  assert.equal(h.session.getState().runRequested, false);
  assert.deepEqual(h.saves, []);
});

test('disposal during image send prevents stale title and pending image', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred(), sends = [];
  const h = harness({
    setImage(image) { sends.push(['image', image]); entered.resolve(); return gate.promise; },
    async setTitle(title) { sends.push(['title', title]); },
  });
  await h.start(settings);
  h.runs[0].callbacks.onUpdate(update('old', 'stale-title'));
  await entered.promise;
  h.runs[0].callbacks.onUpdate(update('old-pending'));
  // Act
  const hide = h.session.disappear();
  gate.resolve();
  await hide;
  await h.session.whenIdle();
  // Assert
  assert.deepEqual(sends, displayed('old'));
});

for (const boundary of ['image', 'title']) {
  test(`${boundary} rejection is redacted and blocks pending frames`, options, async () => {
    // Arrange
    const gate = deferred(), entered = deferred(), sends = [];
    const h = harness({
      setImage(image) { sends.push(['image', image]); if (boundary === 'image') { entered.resolve(); return gate.promise; } return Promise.resolve(); },
      setTitle(title) { sends.push(['title', title]); if (boundary === 'title') { entered.resolve(); return gate.promise; } return Promise.resolve(); },
    });
    await h.start(settings);
    // Act
    h.runs[0].callbacks.onUpdate(update('first', 'Ready'));
    await entered.promise;
    h.runs[0].callbacks.onUpdate(update('pending'));
    gate.reject(new Error('private exception/env/args/stderr'));
    await h.session.whenIdle();
    // Assert
    assert.deepEqual(sends, boundary === 'image' ? displayed('first') : [['title', '']]);
    assert.deepEqual(h.errors, ['Frame send failed.']);
    assert.deepEqual(h.diagnostics, ['FRAME_SEND_FAILED']);
    assert.equal(h.runs[0].stops, 1);
  });
}

test('invalid Started settings never launch or leak private values', options, async () => {
  // Arrange
  const h = harness();
  // Act
  await h.session.appear({ executable: 'private-relative', argsText: 'private-argument', runRequested: true });
  await h.session.whenIdle();
  // Assert
  assert.deepEqual(h.runs, []);
  assert.deepEqual(h.errors, ['Invalid settings.']);
  assert.deepEqual(h.diagnostics, ['INVALID_EXECUTABLE']);
  assert.deepEqual(h.saves, []);
});

test('persistence failure stops execution, blocks restart and invalidates old error guards', options, async () => {
  // Arrange
  const h = harness();
  await h.start(settings);
  h.runs[0].callbacks.onError('Program launch failed.');
  h.runs[0].resolve({ status: 'error', error: 'Program launch failed.' });
  await h.session.whenIdle();
  const oldGuard = h.guards[0];
  // Act
  await h.session.persistenceFailed();
  await h.session.press();
  h.runs[0].callbacks.onError('private-stale-error');
  h.runs[0].callbacks.onUpdate(update('private-stale'));
  await h.session.whenIdle();
  // Assert
  assert.equal(oldGuard(), false);
  assert.equal(h.runs.length, 1);
  assert.equal(h.session.getState().persistenceBlocked, true);
  assert.equal(h.errors.at(-1), 'Run state save failed.');
  assert.equal(h.diagnostics.at(-1), 'STATE_SAVE_FAILED');
  assert.deepEqual(h.display, []);
});

test('configuration confirmation rejection cannot launch and exposes only fixed persistence failure', options, async () => {
  // Arrange
  const h = harness({ async confirmLaunchSettings() { throw new Error('private-state-secret'); } });
  // Act
  await h.start(settings);
  await h.session.whenIdle();
  // Assert
  assert.deepEqual(h.runs, []);
  assert.deepEqual(h.errors, ['Run state save failed.']);
  assert.deepEqual(h.diagnostics, ['STATE_SAVE_FAILED']);
});

test('old generation callbacks after a new start cannot render, diagnose or relaunch', options, async () => {
  // Arrange
  const h = harness();
  await h.start(settings);
  await h.session.press();
  await h.session.press();
  // Act
  h.runs[0].callbacks.onUpdate(update('stale', 'private-stale-title'));
  h.runs[0].callbacks.onDiagnostic('PROCESS_TERMINATED_BY_SIGNAL');
  h.runs[0].callbacks.onError('Image protocol error.');
  h.runs[0].resolve({ status: 'error', error: 'Image protocol error.' });
  h.runs[1].callbacks.onUpdate(update('current', 'Current'));
  await h.session.whenIdle();
  // Assert
  assert.equal(h.runs.length, 2);
  assert.deepEqual(h.display, displayed('current'));
  assert.deepEqual(h.errors, []);
  assert.equal(h.session.getState().protocolBlocked, false);
  assert.equal(h.session.getState().runRequested, true);
  assert.deepEqual(h.saves, []);
});

test('unsuccessful natural exit drains accepted pending final frame before diagnosis', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred(), order = [];
  const h = harness({
    setImage(image) { order.push(['image', image]); if (image === update('first').image) { entered.resolve(); return gate.promise; } return Promise.resolve(); },
    async setTitle(title) { order.push(['title', title]); },
    onError(message, code) { order.push(['error', message, code]); },
  });
  await h.start(settings);
  // Act
  h.runs[0].callbacks.onUpdate(update('first'));
  await entered.promise;
  h.runs[0].callbacks.onUpdate(update('final', 'Final'));
  h.runs[0].callbacks.onDiagnostic('PROCESS_EXITED_NONZERO');
  h.runs[0].resolve({ status: 'error', error: 'Program exited unsuccessfully.' });
  gate.resolve();
  await h.session.whenIdle();
  // Assert
  assert.deepEqual(order, [...displayed('first'), ...displayed('final'), ['error', 'Program exited unsuccessfully.', 'PROCESS_EXITED_NONZERO']]);
  assert.equal(h.runs.length, 1);
  assert.equal(h.session.getState().runRequested, false);
  assert.deepEqual(h.saves, []);
});

for (const [input, caption] of [[{}, 'DeckForge Commander'], [{ executable: '/folder/report.py', argsText: '' }, 'report']]) {
  test(`Stopped appearance shows Play caption ${caption} without launching or saving`, options, async () => {
    // Arrange
    const h = harness();
    // Act
    await h.session.appear(input); await h.session.appear(input); await h.session.reconcileAvailability();
    // Assert
    assert.deepEqual(h.presentations, [['ready', caption]]);
    assert.equal(h.artwork.at(-1).footer, caption === 'DeckForge Commander' ? 'setup required' : 'ready');
    assert.equal(h.session.getState().presentation, 'ready');
    assert.equal(h.session.getState().phase, 'stopped');
    assert.deepEqual(h.display, []);
    assert.deepEqual(h.runs, []);
    assert.deepEqual(h.saves, []);
    assert.deepEqual(h.errors, []);
  });
}

// Slice 2: Setup is an idle presentation only; a press cannot authorize execution.
for (const failure of ['protocol', 'cleanup', 'persistence']) {
  test(`partial setup and presses cannot clear retained ${failure} safety state`, options, async () => {
    // Arrange
    const h = harness(); await h.start(settings);
    if (failure === 'protocol') {
      h.runs[0].callbacks.onError('Image protocol error.');
      h.runs[0].resolve({ status: 'error', error: 'Image protocol error.' }); await h.session.whenIdle();
    } else if (failure === 'cleanup') {
      h.runs[0].stopResult = false; await h.session.press();
    } else await h.session.persistenceFailed();
    // Act
    await h.session.applySettings({ argsText: '' }); await h.session.whenIdle();
    const before = h.session.getState(), saves = h.saves.length;
    await h.session.press(); await h.session.press(); await h.session.whenIdle();
    // Assert
    assert.equal(before.presentation, 'error');
    assert.deepEqual(h.session.getState(), before); assert.equal(h.saves.length, saves);
    assert.equal(h.runs.length, 1);
    assert.equal(h.artwork.some(item => item.footer === 'setup required'), false);
    assert.equal(h.session.getState()[{ protocol: 'protocolBlocked', cleanup: 'cleanupBlocked', persistence: 'persistenceBlocked' }[failure]], true);
  });
}
for (const [index, input] of [{}, { executable: '' }, { argsText: 'literal', cwd: '/synthetic/work' },
  { executable: '', args: ['literal'], runRequested: false, themeColor: 'bad stored metadata' }].entries()) {
  test(`fresh Stopped setup ${index} survives presses, identical snapshots and theme-only updates without intent writes`, options, async () => {
    // Arrange
    const h = harness(), original = structuredClone(input);
    // Act
    await h.session.appear(input); await h.session.press(); await h.session.press();
    await h.session.appear(input); await h.session.applySettings(input);
    await h.session.applySettings({ ...input, themeColor: '#abcdef' }); await h.session.whenIdle();
    // Assert
    assert.equal(h.artwork.at(-1).caption, 'DeckForge Commander');
    assert.ok(h.artwork.every(item => item.kind === 'ready' && item.footer === 'setup required'));
    assert.match(decodeURIComponent(h.artwork.at(-1).image), />setup required<\/text>/);
    assert.equal(h.session.getState().phase, 'stopped');
    assert.equal(h.session.getState().runRequested, false);
    assert.equal(h.session.getState().protocolBlocked, false);
    assert.equal(h.session.getState().recoveryPending, false);
    assert.deepEqual(h.runs, []); assert.deepEqual(h.saves, []); assert.deepEqual(h.errors, []);
    assert.deepEqual(input, original);
  });
}
for (const input of [{ runRequested: true }, { executable: '', argsText: '', runRequested: true }]) {
  test('legacy Started with missing executable stays Setup without launch or writes', options, async () => {
    // Arrange
    const h = harness();
    // Act
    await h.session.appear(input); await h.session.whenIdle();
    // Assert
    assert.deepEqual(h.runs, []); assert.deepEqual(h.saves, []);
    assert.deepEqual(h.errors, []);
    assert.equal(h.session.getState().presentation, 'ready');
    assert.equal(h.session.getState().runRequested, false);
    assert.equal(h.artwork.some(item => item.footer === 'setup required'), true);
  });
}
for (const [input, code] of [[{ executable: 'relative', argsText: '' }, 'INVALID_EXECUTABLE'],
  [{ argsText: "'unterminated" }, 'ARGS_TEXT_INVALID'], [{ cwd: 'relative' }, 'INVALID_CWD'],
  [{ executable: '/synthetic/program' }, 'MISSING_ARGS']]) {
  test(`fresh malformed Stopped configuration shows ${code} Error instead of Ready/Setup`, options, async () => {
    // Arrange
    const h = harness();
    // Act
    await h.session.appear(input); await h.session.whenIdle();
    // Assert
    assert.deepEqual(h.errors, ['Invalid settings.']); assert.deepEqual(h.diagnostics, [code]);
    assert.deepEqual(h.artwork, []); assert.deepEqual(h.runs, []); assert.deepEqual(h.saves, []);
  });
}
for (const loss of ['hide', 'disconnect']) {
  test(`Setup cannot gain launch authority while ${loss} or on availability return`, options, async () => {
    // Arrange
    const h = harness(); await h.session.appear({});
    // Act
    await (loss === 'hide' ? h.session.disappear() : h.session.setConnected(false));
    const drawings = h.artwork.length; await h.session.press();
    const unavailableDrawings = h.artwork.length;
    await (loss === 'hide' ? h.session.appear({}) : h.session.setConnected(true));
    await h.session.whenIdle();
    // Assert
    assert.equal(unavailableDrawings, drawings);
    assert.equal(h.artwork.at(-1).footer, 'setup required');
    assert.deepEqual(h.runs, []); assert.deepEqual(h.saves, []);
    assert.equal(h.session.getState().runRequested, false);
  });
}

test('Starting confirmation pending and running before first frame show Waiting, not Play', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred();
  const h = harness({ async confirmLaunchSettings() { entered.resolve(); return gate.promise; } });
  // Act
  const appear = h.start(settings);
  await entered.promise;
  const pendingPresentations = [...h.presentations], pendingStarts = h.runs.length;
  gate.resolve(true); await appear;
  const beforeFrame = h.session.getState().presentation;
  h.runs[0].callbacks.onUpdate(update('producer'));
  await h.session.whenIdle();
  // Assert
  assert.deepEqual(pendingPresentations, [['waiting', 'program']]);
  assert.equal(pendingStarts, 0);
  assert.equal(beforeFrame, 'waiting');
  assert.equal(h.session.getState().presentation, 'streaming');
  assert.deepEqual(h.presentations, [['waiting', 'program']]);
  assert.deepEqual(h.display, displayed('producer'));
});

test('manual Stop waits for certain cleanup before Play; configuration Stop refreshes basename', options, async () => {
  // Arrange
  const h = harness(); await h.start(settings);
  const gate = deferred(); h.runs[0].stopGate = gate;
  // Act
  const stop = h.session.press(); await h.runs[0].stopStarted.promise;
  const beforeCleanup = [...h.presentations];
  gate.resolve(true); await stop;
  await h.session.applySettings({ executable: '/different/report.sh', argsText: '' });
  // Assert
  assert.deepEqual(beforeCleanup, [['waiting', 'program']]);
  assert.deepEqual(h.presentations, [['waiting', 'program'], ['ready', 'program'], ['ready', 'report']]);
  assert.equal(h.runs.length, 1);
  assert.equal(h.session.getState().presentation, 'ready');
});

test('success drains final caption-clear and image before restoring Ready and basename', options, async () => {
  // Arrange
  const imageGate = deferred(), firstEntered = deferred(), titleGate = deferred(), finalTitleEntered = deferred(), timeline = [];
  let titleCount = 0;
  const h = harness({
    onPresentation(kind, caption, current, color, footer) { if (current()) timeline.push([kind, caption, footer]); },
    setImage(image) { timeline.push(['image', image]); if (image === update('first').image) { firstEntered.resolve(); return imageGate.promise; } return Promise.resolve(); },
    setTitle(title) { timeline.push(['title', title]); if (++titleCount === 2) { finalTitleEntered.resolve(); return titleGate.promise; } return Promise.resolve(); },
  });
  await h.start(settings);
  // Act
  h.runs[0].callbacks.onUpdate(update('first', 'First'));
  await firstEntered.promise;
  h.runs[0].callbacks.onUpdate(update('final', 'Final'));
  h.runs[0].callbacks.onDiagnostic('PROCESS_EXITED_SUCCESSFULLY');
  h.runs[0].resolve({ status: 'success' });
  imageGate.resolve(); await finalTitleEntered.promise;
  const beforeTitleDrain = [...timeline];
  titleGate.resolve(); await h.session.whenIdle();
  // Assert
  assert.equal(beforeTitleDrain.some(item => item[0] === 'ready'), false);
  assert.deepEqual(timeline, [['waiting', 'program', 'ready'], ...displayed('first'), ...displayed('final'), ['ready', 'program', 'exited']]);
  assert.equal(h.session.getState().presentation, 'ready');
  assert.equal(h.runs.length, 1);
});

test('zero-output success returns from Waiting to Play without automatic retry', options, async () => {
  // Arrange
  const h = harness(); await h.start(settings);
  // Act
  h.runs[0].resolve({ status: 'success' }); await h.session.whenIdle();
  await h.session.reconcileAvailability(); await h.session.appear(settings);
  // Assert
  assert.deepEqual(h.presentations, [['waiting', 'program'], ['ready', 'program']]);
  assert.deepEqual(h.display, []);
  assert.equal(h.runs.length, 1);
  assert.deepEqual(h.saves, []);
});

for (const [failure, code] of [['launch', 'PROCESS_LAUNCH_FAILED'], ['nonzero', 'PROCESS_EXITED_NONZERO'], ['protocol', 'IMAGE_PROTOCOL_ERROR'], ['cleanup', 'CLEANUP_BLOCKED'], ['persistence', 'STATE_SAVE_FAILED'], ['display', 'FRAME_SEND_FAILED']]) {
  test(`${failure} diagnosis outranks Play through extra appearance and reconciliation`, options, async () => {
    // Arrange
    const h = harness(failure === 'display' ? { async setImage() { throw new Error('private display details'); } } : {});
    await h.start(settings);
    // Act
    if (failure === 'cleanup') { h.runs[0].stopResult = false; await h.session.press(); }
    else if (failure === 'persistence') await h.session.persistenceFailed();
    else if (failure === 'display') h.runs[0].callbacks.onUpdate(update('frame'));
    else {
      const message = failure === 'protocol' ? 'Image protocol error.' : failure === 'launch' ? 'Program launch failed.' : 'Program exited unsuccessfully.';
      if (failure === 'nonzero') h.runs[0].callbacks.onDiagnostic(code);
      h.runs[0].callbacks.onError(message); h.runs[0].resolve({ status: 'error', error: message });
    }
    await h.session.whenIdle(); await h.session.appear(settings); await h.session.reconcileAvailability();
    // Assert
    assert.equal(h.session.getState().presentation, 'error');
    assert.equal(h.presentations.some(item => item[0] === 'ready'), false);
    assert.ok(h.diagnostics.length > 0 && h.diagnostics.every(item => item === code));
    assert.equal(h.runs.length, 1);
    assert.equal(h.session.getState().runRequested, false);
  });
}

for (const loss of ['hide', 'disconnect']) {
  test(`pending Ready image/title boundary is invalidated by ${loss}`, options, async () => {
    // Arrange
    const gate = deferred(), entered = deferred(), rendered = [];
    let guard;
    const h = harness({ async onPresentation(kind, caption, current) { guard = current; entered.resolve(); await gate.promise; if (current()) rendered.push([kind, caption]); } });
    // Act
    const appearance = h.session.appear(execution); await entered.promise;
    const unavailable = loss === 'hide' ? h.session.disappear() : h.session.setConnected(false);
    const stale = guard(); gate.resolve(); await Promise.all([appearance, unavailable]); await h.session.whenIdle();
    // Assert
    assert.equal(stale, false);
    assert.deepEqual(rendered, []);
    assert.deepEqual(h.runs, []);
  });
}

test('late success Ready publication cannot paint after a newer semantic Start', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred(), rendered = [];
  let readyGuard;
  const h = harness({ async onPresentation(kind, caption, current) {
    if (kind === 'ready') { readyGuard = current; entered.resolve(); await gate.promise; }
    if (current()) rendered.push([kind, caption]);
  } });
  await h.start(settings);
  // Act
  h.runs[0].resolve({ status: 'success' }); await entered.promise;
  const start = h.session.press();
  const stale = readyGuard(); gate.resolve(); await start;
  h.runs[1].callbacks.onUpdate(update('current', 'Current')); await h.session.whenIdle();
  // Assert
  assert.equal(stale, false);
  assert.equal(rendered.some(item => item[0] === 'ready'), false);
  assert.deepEqual(h.display, displayed('current'));
  assert.equal(h.session.getState().presentation, 'streaming');
  assert.equal(h.runs.length, 2);
});

test('persistence error invalidates pending Waiting caption/image publication and prevents launch', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred(), rendered = [];
  let waitingGuard;
  const h = harness({ async onPresentation(kind, caption, current) { waitingGuard = current; entered.resolve(); await gate.promise; if (current()) rendered.push([kind, caption]); } });
  // Act
  const start = h.start(settings); await entered.promise;
  const failure = h.session.persistenceFailed();
  const stale = waitingGuard(); gate.resolve(); await Promise.all([start, failure]); await h.session.whenIdle();
  // Assert
  assert.equal(stale, false);
  assert.deepEqual(rendered, []);
  assert.deepEqual(h.runs, []);
  assert.deepEqual(h.diagnostics, ['STATE_SAVE_FAILED']);
  assert.equal(h.session.getState().presentation, 'error');
});

test('built-in presentation rejection reports fixed frame-send diagnosis instead of false Ready', options, async () => {
  // Arrange
  const h = harness({ async onPresentation() { throw new Error('private artwork exception'); } });
  // Act
  await h.session.appear(execution); await h.session.whenIdle();
  // Assert
  assert.deepEqual(h.errors, ['Frame send failed.']);
  assert.deepEqual(h.diagnostics, ['FRAME_SEND_FAILED']);
  assert.equal(h.session.getState().presentation, 'error');
  assert.deepEqual(h.runs, []);
});

// A paused runner still owns its semantic intent until replacement starts, even after cleanup.
for (const pauseKind of ['hide', 'disconnect']) {
  test(`owned paused launch failure cancels final resume confirmation after ${pauseKind}, retains error and allows only a genuine new press`, options, async () => {
    // Arrange
    const confirmation = deferred(), confirmationEntered = deferred(), rendered = [], saved = [], expected = [];
    const h = harness({
      confirmLaunchSettings(snapshot) {
        expected.push(snapshot);
        if (expected.length === 2) { confirmationEntered.resolve(); return confirmation.promise; }
        return Promise.resolve(true);
      },
      async onPresentation(kind, caption, current) {
        if (current()) rendered.push([kind, caption]);
      },
    });
    await h.start(settings);
    const old = h.runs[0], cleanup = deferred(); old.stopGate = cleanup;
    const pause = pauseKind === 'hide' ? h.session.disappear() : h.session.setConnected(false);
    await old.stopStarted.promise; cleanup.resolve(true); await pause;
    // Act: old.done still owns the intent while the existing final settings check waits.
    const resume = pauseKind === 'hide' ? h.session.appear(settings) : h.session.setConnected(true);
    await confirmationEntered.promise;
    const countBeforeFailure = h.runs.length;
    old.callbacks.onDiagnostic('PROCESS_LAUNCH_FAILED');
    const immediatelyFailed = h.session.getState();
    old.resolve({ status: 'stopped' });
    confirmation.resolve(true); await resume; await h.session.whenIdle();
    await h.session.reconcileAvailability(); await h.session.appear(settings);
    const beforeGenuinePress = { runs: h.runs.length, state: h.session.getState(), saved: saved.at(-1), rendered: [...rendered], errors: [...h.errors], diagnostics: [...h.diagnostics] };
    await h.session.press();
    old.callbacks.onDiagnostic('PROCESS_LAUNCH_FAILED');
    old.callbacks.onError('Program launch failed.');
    old.callbacks.onUpdate(update('stale', 'stale-caption'));
    h.runs[1].callbacks.onUpdate(update('new', 'New'));
    await h.session.whenIdle();
    // Assert
    assert.equal(countBeforeFailure, 1);
    assert.equal(immediatelyFailed.phase, 'stopped');
    assert.equal(immediatelyFailed.runRequested, false);
    assert.equal(immediatelyFailed.presentation, 'error');
    assert.deepEqual(expected.slice(0, 2), [settings, settings]);
    assert.equal(beforeGenuinePress.runs, 1);
    assert.equal(beforeGenuinePress.state.phase, 'stopped');
    assert.equal(beforeGenuinePress.state.presentation, 'error');
    assert.equal(beforeGenuinePress.saved, undefined);
    assert.deepEqual(beforeGenuinePress.rendered, [['waiting', 'program']]);
    assert.deepEqual(beforeGenuinePress.errors, ['Program launch failed.']);
    assert.deepEqual(beforeGenuinePress.diagnostics, ['PROCESS_LAUNCH_FAILED']);
    assert.equal(h.runs.length, 2);
    assert.equal(h.session.getState().runRequested, true);
    assert.equal(h.session.getState().presentation, 'streaming');
    assert.deepEqual(h.display, displayed('new'));
    assert.deepEqual(h.errors, ['Program launch failed.']);
    assert.deepEqual(saved, []);
  });
}

for (const pauseKind of ['hide', 'disconnect']) {
  test(`owned paused failure during deferred resume suppresses unavailable rendering after second ${pauseKind}`, options, async () => {
    // Arrange
    const confirmation = deferred(), confirmationEntered = deferred(), rendered = [];
    let confirmations = 0;
    const h = harness({ confirmLaunchSettings() {
      if (++confirmations === 2) { confirmationEntered.resolve(); return confirmation.promise; }
      return Promise.resolve(true);
    }, async onPresentation(kind, caption, current) {
      if (current()) rendered.push([kind, caption]);
    } });
    await h.start(settings);
    const old = h.runs[0], cleanup = deferred(); old.stopGate = cleanup;
    const pause = pauseKind === 'hide' ? h.session.disappear() : h.session.setConnected(false);
    await old.stopStarted.promise; cleanup.resolve(true); await pause;
    // Act
    const resume = pauseKind === 'hide' ? h.session.appear(settings) : h.session.setConnected(true);
    await confirmationEntered.promise;
    const unavailable = pauseKind === 'hide' ? h.session.disappear() : h.session.setConnected(false);
    old.callbacks.onDiagnostic('PROCESS_LAUNCH_FAILED'); old.resolve({ status: 'stopped' });
    confirmation.resolve(true); await Promise.all([resume, unavailable]); await h.session.whenIdle();
    const errorsWhileUnavailable = [...h.errors], unavailableState = h.session.getState();
    if (pauseKind === 'hide') await h.session.appear(settings); else await h.session.setConnected(true);
    await h.session.reconcileAvailability(); await h.session.whenIdle();
    // Assert
    assert.deepEqual(errorsWhileUnavailable, []);
    assert.equal(unavailableState.phase, 'stopped');
    assert.equal(unavailableState.runRequested, false);
    assert.equal(unavailableState.presentation, 'error');
    assert.deepEqual(h.saves, []);
    assert.equal(h.runs.length, 1);
    assert.deepEqual(rendered, [['waiting', 'program']]);
    assert.deepEqual(h.errors, ['Program launch failed.']);
    assert.deepEqual(h.diagnostics, ['PROCESS_LAUNCH_FAILED']);
  });
}

test('ordinary deferred availability resume without terminal failure starts once and ignores old-generation failure afterward', options, async () => {
  // Arrange
  const confirmation = deferred(), confirmationEntered = deferred(), rendered = [];
  let confirmations = 0;
  const h = harness({ confirmLaunchSettings() {
    if (++confirmations === 2) { confirmationEntered.resolve(); return confirmation.promise; }
    return Promise.resolve(true);
  }, async onPresentation(kind, caption, current) {
    if (current()) rendered.push([kind, caption]);
  } });
  await h.start(settings);
  const old = h.runs[0], cleanup = deferred(); old.stopGate = cleanup;
  const disconnect = h.session.setConnected(false);
  await old.stopStarted.promise; cleanup.resolve(true); await disconnect;
  // Act
  const reconnect = h.session.setConnected(true); await confirmationEntered.promise;
  const beforeConfirmationSettled = h.runs.length;
  confirmation.resolve(true); await reconnect;
  old.callbacks.onDiagnostic('PROCESS_LAUNCH_FAILED'); old.resolve({ status: 'stopped' });
  h.runs[1].callbacks.onUpdate(update('replacement'));
  await h.session.whenIdle();
  // Assert
  assert.equal(beforeConfirmationSettled, 1);
  assert.equal(h.runs.length, 2);
  assert.deepEqual(rendered, [['waiting', 'program']]);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.saves, []);
  assert.equal(h.session.getState().runRequested, true);
  assert.equal(h.session.getState().presentation, 'streaming');
  assert.deepEqual(h.display, displayed('replacement'));
});

// Invalid configured snapshots now show Error immediately (approved Slice 2 change).
test('theme-only edit recolors fresh invalid configured Error without manufacturing Ready or intent', options, async () => {
  // Arrange
  const rendered = [], snapshot = { executable: 'relative', args: 'malformed' };
  const h = harness({ onError(message, code, current, color) { if (current()) rendered.push([message, code, color]); } });
  await h.session.appear(snapshot);
  // Act
  await h.session.applySettings({ ...snapshot, themeColor: '#ABCDEF' }); await h.session.whenIdle();
  // Assert
  assert.deepEqual(rendered, [['Invalid settings.', 'INVALID_EXECUTABLE', '#969696'], ['Invalid settings.', 'INVALID_EXECUTABLE', '#abcdef']]);
  assert.deepEqual(h.artwork, []); assert.deepEqual(h.runs, []); assert.deepEqual(h.saves, []);
  assert.equal(h.session.getState().presentation, 'error'); assert.equal(h.session.getState().runRequested, false);
});
for (const snapshot of [{}, { ...execution, runRequested: false }]) {
  test('theme-only edit refreshes Stopped built-in without inventing intent or execution actions', options, async () => {
    // Arrange
    const colors = [];
    const h = harness({ onPresentation(kind, caption, current, color) { if (current()) colors.push([kind, caption, color]); } });
    await h.session.appear(snapshot);
    // Act
    await h.session.applySettings({ ...snapshot, themeColor: '#ABCDEF' }); await h.session.whenIdle();
    // Assert
    assert.equal(colors.at(-1)[0], 'ready');
    assert.equal(colors.at(-1)[2], '#abcdef');
    assert.deepEqual(h.runs, []);
    assert.deepEqual(h.saves, []);
    assert.deepEqual(h.errors, []);
    assert.equal(h.session.getState().runRequested, false);
  });
}
test('theme-only false metadata echo during pending Started confirmation cannot cancel or duplicate launch', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred(), rendered = [], saved = [];
  const stopped = { ...settings, runRequested: false };
  const h = harness({
    async confirmLaunchSettings() { entered.resolve(); return gate.promise; },
    onPresentation(kind, caption, current, color) { if (current()) rendered.push([kind, color]); },
  });
  await h.session.appear(stopped);
  // Act
  const start = h.session.press(); await entered.promise;
  await h.session.applySettings({ ...stopped, themeColor: '#abcdef' });
  const before = h.session.getState(), count = h.runs.length;
  gate.resolve(true); await start; await h.session.whenIdle();
  // Assert
  assert.equal(before.runRequested, true);
  assert.equal(before.phase, 'starting');
  assert.equal(count, 0);
  assert.equal(h.runs.length, 1);
  assert.deepEqual(saved, []);
  assert.ok(rendered.some(item => item[0] === 'waiting' && item[1] === '#abcdef'));
});
test('opaque producer images outrank theme refresh; mixed execution edit still stops', options, async () => {
  // Arrange
  const stopped = { ...settings, runRequested: false };
  const h = harness(); await h.session.appear(stopped); await h.session.press();
  h.runs[0].callbacks.onUpdate(update('producer', 'Producer')); await h.session.whenIdle();
  const builtinsBefore = [...h.presentations];
  // Act
  await h.session.applySettings({ ...stopped, themeColor: '#abcdef' });
  await h.session.refreshAppearance();
  h.runs[0].callbacks.onUpdate(update('next')); h.runs[0].callbacks.onUpdate(update('clear', ''));
  await h.session.whenIdle();
  const beforeMixed = { stops: h.runs[0].stops, intent: h.session.getState().runRequested, builtins: [...h.presentations] };
  await h.session.applySettings({ executable: '/changed', args: [], themeColor: '#123456' });
  // Assert
  assert.equal(beforeMixed.stops, 0);
  assert.equal(beforeMixed.intent, true);
  assert.deepEqual(beforeMixed.builtins, builtinsBefore);
  assert.ok(h.display.some(item => item[0] === 'image' && item[1] === update('producer').image));
  assert.ok(h.display.filter(item => item[0] === 'title').every(item => item[1] === ''));
  assert.deepEqual(h.display.at(-1), ['image', update('clear').image]);
  assert.equal(h.runs[0].stops, 1);
  assert.equal(h.runs.length, 1);
  assert.equal(h.session.getState().runRequested, false);
});
test('stale Waiting theme redraw cannot overwrite a first producer image', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred(), painted = [];
  let guard;
  const h = harness({ async onPresentation(kind, caption, current, color) {
    if (color === '#abcdef') { guard = current; entered.resolve(); await gate.promise; }
    if (current()) painted.push([kind, color]);
  } });
  await h.start(settings);
  // Act
  const recolor = h.session.applySettings({ ...settings, themeColor: '#abcdef' }); await entered.promise;
  h.runs[0].callbacks.onUpdate(update('current'));
  const stale = guard(); gate.resolve(); await recolor; await h.session.whenIdle();
  // Assert
  assert.equal(stale, false);
  assert.deepEqual(painted, [['waiting', '#969696']]);
  assert.deepEqual(h.display, displayed('current'));
  assert.equal(h.session.getState().presentation, 'streaming');
  assert.equal(h.runs[0].stops, 0);
});
test('theme redraw on protocol error retains fixed diagnosis and latch without retry or Play', options, async () => {
  // Arrange
  const renderedErrors = [], builtins = [];
  const h = harness({
    onError(message, code, current, color) { if (current()) renderedErrors.push([message, code, color]); },
    onPresentation(kind, caption, current, color) { if (current()) builtins.push([kind, color]); },
  });
  await h.start(settings);
  h.runs[0].callbacks.onError('Image protocol error.'); h.runs[0].resolve({ status: 'error', error: 'Image protocol error.' });
  await h.session.whenIdle();
  // Act
  await h.session.applySettings({ ...settings, themeColor: '#123456' }); await h.session.whenIdle();
  // Assert
  assert.deepEqual(renderedErrors.at(-1), ['Image protocol error.', 'IMAGE_PROTOCOL_ERROR', '#123456']);
  assert.equal(h.session.getState().protocolBlocked, true);
  assert.equal(h.session.getState().runRequested, false);
  assert.equal(h.session.getState().presentation, 'error');
  assert.equal(h.runs.length, 1);
  assert.equal(builtins.some(item => item[0] === 'ready'), false);
});
test('independent action theme refresh cannot repaint another key', options, async () => {
  // Arrange
  const first = [], second = [];
  const a = harness({ onPresentation(kind, caption, current, color) { if (current()) first.push(color); } });
  const b = harness({ onPresentation(kind, caption, current, color) { if (current()) second.push(color); } });
  await Promise.all([a.session.appear(execution), b.session.appear(execution)]);
  // Act
  await a.session.applySettings({ ...execution, themeColor: '#abcdef' });
  // Assert
  assert.deepEqual(first, ['#969696', '#abcdef']);
  assert.deepEqual(second, ['#969696']);
  assert.deepEqual(a.saves, []); assert.deepEqual(b.saves, []);
});

for (const explicit of [false, true]) {
  test(`running primitive theme redraw respects ${explicit ? 'explicit record color' : 'live action theme'} without lifecycle changes`, options, async () => {
    // Arrange
    const h = harness();
    await h.start({ ...settings, themeColor: '#123456' });
    const record = parseOutputUpdate(`progress:100|value-color:accent;label-color:accent${explicit ? ';color:red' : ''}`);
    h.runs[0].callbacks.onUpdate(record); await h.session.whenIdle();
    const first = h.display.at(-1)[1];
    // Act
    await h.session.applySettings({ ...settings, themeColor: '#abcdef' }); await h.session.whenIdle();
    const second = h.display.at(-1)[1];
    // Assert
    const svg = decodeURIComponent(second.slice('data:image/svg+xml,'.length));
    assert.ok(svg.includes(explicit ? '#ff0000' : '#abcdef'));
    if (explicit) assert.equal(first, second);
    else assert.notEqual(first, second);
    assert.equal(record.options.color, explicit ? '#ff0000' : '#969696');
    assert.deepEqual(h.saves, []);
    assert.equal(h.runs.length, 1);
    assert.equal(h.runs[0].stops, 0);
    assert.equal(h.session.getState().phase, 'running');
    assert.equal(h.session.getState().runRequested, true);
    assert.ok(h.display.filter(item => item[0] === 'title').every(item => item[1] === ''));
  });
}

test('invalid primitive callback preserves live primitive cache, opaque image clears it', options, async () => {
  // Arrange
  const h = harness(); await h.start(settings);
  h.runs[0].callbacks.onUpdate(parseOutputUpdate('text:good')); await h.session.whenIdle();
  // Act
  h.runs[0].callbacks.onUpdate(parseOutputUpdate('progress:12.345678901234567|scale:50;thickness:16;value-size:32'));
  h.runs[0].callbacks.onUpdate({ kind: 'text', value: 'bad', options: {}, overrides: {} });
  await h.session.applySettings({ ...settings, themeColor: '#abcdef' }); await h.session.whenIdle();
  const recolored = decodeURIComponent(h.display.at(-1)[1].slice('data:image/svg+xml,'.length));
  h.runs[0].callbacks.onUpdate(update('opaque')); await h.session.whenIdle();
  const before = h.display.length;
  await h.session.applySettings({ ...settings, themeColor: '#123456' }); await h.session.whenIdle();
  // Assert
  assert.ok(recolored.includes('>good</text>') && recolored.includes('#abcdef'));
  assert.equal(h.display.length, before);
  assert.deepEqual(h.display.at(-1), ['image', update('opaque').image]);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.saves, []);
  assert.equal(h.runs[0].stops, 0);
});

for (const explicitFrame of [false, true]) {
  test(`live theme changes preserve primitive background/ink and ${explicitFrame ? 'explicit' : 'default'} frame color ownership`, options, async () => {
    // Arrange
    const h = harness(); await h.start({ ...settings, themeColor: '#123456' });
    const record = parseOutputUpdate(`text:Hi|background:ivory;color:black;border:0.5${explicitFrame ? ';border-color:blue' : ''}`);
    h.runs[0].callbacks.onUpdate(record); await h.session.whenIdle();
    // Act
    await h.session.applySettings({ ...settings, themeColor: '#abcdef' }); await h.session.whenIdle();
    const svg = decodeURIComponent(h.display.at(-1)[1].slice('data:image/svg+xml,'.length));
    // Assert
    assert.ok(svg.includes('<rect width="144" height="144" fill="#fffff0"/>'));
    assert.ok(svg.includes(`stroke="${explicitFrame ? '#0000ff' : '#abcdef'}" stroke-width="0.5"`));
    assert.match(svg, /<text[^>]*fill="#000000"[^>]*>Hi<\/text>/);
    assert.deepEqual(record.overrides, { background: '#fffff0', color: '#000000', border: 0.5, ...(explicitFrame ? { 'border-color': '#0000ff' } : {}) });
    assert.deepEqual(h.saves, []);
    assert.equal(h.runs[0].stops, 0);
    assert.equal(h.runs.length, 1);
  });
}

test('skipped unsafe style preserves pending primitive and cannot alter its background', options, async () => {
  // Arrange
  const gate = deferred(), entered = deferred(), painted = [];
  const h = harness({ async setImage(image, current) { if (current()) painted.push(image); if (image === update('first').image) { entered.resolve(); await gate.promise; } } });
  await h.start(settings);
  h.runs[0].callbacks.onUpdate(update('first')); await entered.promise;
  const good = parseOutputUpdate('text:good|background:ivory;color:black');
  // Act
  h.runs[0].callbacks.onUpdate(good);
  h.runs[0].callbacks.onUpdate(parseOutputUpdate('text:bad|background:transparent'));
  h.runs[0].callbacks.onUpdate({ ...good, options: { ...good.options, background: 'url(test)' } });
  gate.resolve(); await h.session.whenIdle();
  // Assert
  assert.equal(painted.length, 2);
  assert.equal(painted[1], createPrimitiveArtwork(good));
  assert.deepEqual(h.errors, []);
  assert.equal(h.session.getState().protocolBlocked, false);
  assert.equal(h.runs[0].stops, 0);
});

for (const superseding of ['opaque', 'hide', 'error', 'new-generation']) {
  test(`late primitive recolor cannot overwrite newer ${superseding}`, options, async () => {
    // Arrange
    const gate = deferred(), entered = deferred(), painted = [];
    let block = false, guard;
    const h = harness({ async setImage(image, current) {
      if (block) { block = false; guard = current; entered.resolve(); await gate.promise; }
      if (current()) painted.push(image);
    } });
    await h.start(settings);
    h.runs[0].callbacks.onUpdate(parseOutputUpdate('text:primitive')); await h.session.whenIdle();
    block = true;
    // Act
    const recolor = h.session.applySettings({ ...settings, themeColor: '#abcdef' }); await entered.promise;
    let transition;
    if (superseding === 'opaque') h.runs[0].callbacks.onUpdate(update('opaque'));
    if (superseding === 'hide') transition = h.session.disappear();
    if (superseding === 'error') { h.runs[0].callbacks.onError('Image protocol error.'); h.runs[0].resolve({ status: 'error', error: 'Image protocol error.' }); }
    if (superseding === 'new-generation') transition = h.session.press();
    const stale = guard();
    gate.resolve(); await recolor; if (transition) await transition; await h.session.whenIdle();
    if (superseding === 'new-generation') { await h.session.press(); h.runs[1].callbacks.onUpdate(update('new')); await h.session.whenIdle(); }
    // Assert
    assert.equal(stale, false);
    assert.equal(painted.some(image => decodeURIComponent(image).includes('#abcdef')), false);
    if (superseding === 'opaque') assert.equal(painted.at(-1), update('opaque').image);
    if (superseding === 'new-generation') assert.equal(painted.at(-1), update('new').image);
    if (superseding === 'hide') assert.equal(h.session.getState().visible, false);
    if (superseding === 'error') assert.equal(h.session.getState().presentation, 'error');
  });
}

for (const terminal of ['exit', 'protocol']) {
  test(`accepted final output drains before owned ${terminal} diagnosis, post-failure output is rejected`, options, async () => {
    // Arrange
    const gate = deferred(), entered = deferred(), order = [];
    const h = harness({
      async setImage(image, current) { if (current()) order.push(['image', image]); if (image === update('first').image) { entered.resolve(); await gate.promise; } },
      async setTitle(title, current) { if (current()) order.push(['title', title]); },
      onError(message, code, current) { if (current()) order.push(['error', message, code]); },
    });
    await h.start(settings);
    h.runs[0].callbacks.onUpdate(update('first')); await entered.promise;
    h.runs[0].callbacks.onUpdate(update('accepted-final'));
    // Act
    const message = terminal === 'exit' ? 'Program exited unsuccessfully.' : 'Image protocol error.';
    if (terminal === 'exit') h.runs[0].callbacks.onDiagnostic('PROCESS_EXITED_NONZERO');
    else h.runs[0].callbacks.onError(message);
    h.runs[0].callbacks.onUpdate(update('after-failure'));
    h.runs[0].resolve({ status: 'error', error: message });
    const before = [...order]; gate.resolve(); await h.session.whenIdle();
    // Assert
    assert.deepEqual(before, displayed('first'));
    assert.deepEqual(order, [...displayed('first'), ...displayed('accepted-final'), ['error', message, terminal === 'exit' ? 'PROCESS_EXITED_NONZERO' : 'IMAGE_PROTOCOL_ERROR']]);
    assert.equal(h.session.getState().runRequested, false);
    assert.equal(h.runs.length, 1);
  });
}

for (const superseding of ['hide', 'persistence', 'cleanup', 'edit']) {
  test(`owned terminal drain cannot paint pending output after newer ${superseding}`, options, async () => {
    // Arrange
    const gate = deferred(), entered = deferred(), painted = [];
    const h = harness({ async setImage(image, current) { if (current()) painted.push(image); if (image === update('first').image) { entered.resolve(); await gate.promise; } } });
    await h.start(settings);
    h.runs[0].callbacks.onUpdate(update('first')); await entered.promise;
    h.runs[0].callbacks.onUpdate(update('pending'));
    h.runs[0].callbacks.onDiagnostic('PROCESS_EXITED_NONZERO');
    h.runs[0].resolve({ status: 'error', error: 'Program exited unsuccessfully.' });
    // Act
    let transition;
    if (superseding === 'hide') transition = h.session.disappear();
    if (superseding === 'persistence') transition = h.session.persistenceFailed();
    if (superseding === 'cleanup') { h.runs[0].stopResult = false; transition = h.session.applySettings({ executable: '/replacement', args: [] }); }
    if (superseding === 'edit') transition = h.session.applySettings({ executable: '/replacement', args: [] });
    gate.resolve(); await transition; await h.session.whenIdle();
    // Assert
    assert.deepEqual(painted, [update('first').image]);
    assert.equal(h.runs.length, 1);
    assert.equal(h.session.getState().runRequested, false);
    if (superseding === 'persistence') assert.equal(h.session.getState().persistenceBlocked, true);
    if (superseding === 'cleanup') assert.equal(h.session.getState().cleanupBlocked, true);
  });
}

for (const superseding of ['hide', 'error']) {
  test(`deferred theme redraw cannot override newer ${superseding} state`, options, async () => {
    // Arrange
    const gate = deferred(), entered = deferred(), painted = [];
    let guard;
    const h = harness({ async onPresentation(kind, caption, current, color) {
      if (color === '#abcdef') { guard = current; entered.resolve(); await gate.promise; }
      if (current()) painted.push([kind, color]);
    } });
    await h.start(settings);
    // Act
    const recolor = h.session.applySettings({ ...settings, themeColor: '#abcdef' }); await entered.promise;
    let hide;
    if (superseding === 'hide') hide = h.session.disappear();
    else { h.runs[0].callbacks.onError('Image protocol error.'); h.runs[0].resolve({ status: 'error', error: 'Image protocol error.' }); }
    const stale = guard(); gate.resolve(); await recolor; if (hide) await hide; await h.session.whenIdle();
    // Assert
    assert.equal(stale, false);
    assert.deepEqual(painted, [['waiting', '#969696']]);
    assert.equal(h.runs.length, 1);
    if (superseding === 'hide') { assert.equal(h.session.getState().visible, false); assert.deepEqual(h.errors, []); }
    else { assert.equal(h.session.getState().presentation, 'error'); assert.deepEqual(h.diagnostics, ['IMAGE_PROTOCOL_ERROR']); }
  });
}
