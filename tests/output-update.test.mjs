import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOutputUpdate } from '../src/core/output-update.mjs';
import { resolveOutputOptions } from '../src/core/output-options.mjs';

test('card records reset omitted fields and re-resolve inherited side colors against the theme', () => {
  // Arrange
  const defaults = { color: 'blue', header: 'old', footer: 'old' };
  // Act
  const first = parseOutputUpdate('card:UP|header:API;footer:HTTP 200;header-align:left;footer-color:ivory;header-gap:0;footer-gap:12.5;overflow:wrap', defaults);
  const redraw = resolveOutputOptions('card', first.overrides, { color: 'lime' });
  const next = parseOutputUpdate('card:', defaults);
  const invalid = parseOutputUpdate('card:must not become text|header:API;label:bad', defaults);
  // Assert
  assert.deepEqual([first.value, redraw.header, redraw.footer, redraw['header-color'], redraw['footer-color']], ['UP', 'API', 'HTTP 200', '#00ff00', '#fffff0']);
  assert.deepEqual([next.value, next.options.header, next.options.footer, next.options['header-align']], ['', '', '', 'center']);
  assert.deepEqual([redraw['header-gap'], redraw['footer-gap'], redraw.overflow], [0, 12.5, 'wrap']);
  assert.deepEqual([next.options['header-gap'], next.options['footer-gap'], next.options.overflow], [8, 8, 'ellipsis']);
  assert.equal(first.options['header-color'], '#0000ff');
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.options) && Object.isFrozen(first.overrides));
  assert.equal(invalid, undefined);
});

// S2: record-local progress controls and symbolic color provenance survive cosmetics.
for (const type of ['ring', 'bar']) test(`S2 ${type} expanded progress provenance re-resolves and next record resets`, () => {
  // Arrange
  const defaults = Object.freeze({ color: 'blue', weight: 'bold', display: 'old', label: 'old' });
  const wire = `progress:17/1034|type:${type};scale:110;thickness:0.5;value-size:12;label-size:40;label:C;display:17;label-weight:normal;label-gap:0.5;value-color:accent;label-color:accent`;
  // Act
  const first = parseOutputUpdate(wire, defaults);
  const redraw = resolveOutputOptions('progress', first.overrides, { ...defaults, color: 'lime' });
  const next = parseOutputUpdate('progress:101', defaults);
  const rejected = ['label-gap:-1', 'label-weight:Bold', 'padding-x:0', 'padding-y:0', 'label-align:left', 'scale:0', 'thickness:-1', 'value-size:0', 'label-size:1e2', 'label-gap:0;label-gap:2'].map(suffix => parseOutputUpdate(`progress:1|color:red;${suffix}`));
  // Assert
  assert.ok(Math.abs(first.value - 1700 / 1034) <= (1700 / 1034) * 1e-14);
  for (const key of ['type', 'scale', 'thickness', 'value-size', 'label-size', 'label', 'display', 'label-weight', 'label-gap']) assert.equal(redraw[key], first.options[key]);
  assert.deepEqual([redraw['value-color'], redraw['label-color'], first.options['label-color'], first.overrides['label-color']], ['#00ff00', '#00ff00', '#0000ff', 'accent']);
  assert.deepEqual([next.value, next.options.type, next.options.scale, next.options.thickness, next.options['value-size'], next.options['label-size'], next.options['label-weight'], next.options['label-gap'], next.options.label, next.options.display, next.overrides], [100, 'ring', 80, 8, 16, 16, 'bold', 2, '', undefined, {}]);
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.options) && Object.isFrozen(first.overrides));
  assert.deepEqual(rejected, Array(rejected.length).fill(undefined));
});

// S1: expanded text controls remain complete, immutable, record-local presentation.
test('text layout provenance re-resolves against a new theme and resets on the next record', () => {
  // Arrange
  const defaults = Object.freeze({ color: 'blue', padding: 5, 'padding-x': 9, weight: 'bold' });
  const wire = 'text:A\\nB|font-size:12;label:C;label-size:40;padding:0;padding-y:7;line-height:3;label-align:right;label-weight:normal;label-gap:0.5;border:16';
  // Act
  const first = parseOutputUpdate(wire, defaults);
  const redraw = resolveOutputOptions('text', first.overrides, { ...defaults, color: 'lime' });
  const next = parseOutputUpdate('text:next', defaults);
  const invalid = parseOutputUpdate(`${wire};label-gap:1`, defaults);
  // Assert
  assert.equal(first.value, 'A\nB');
  assert.deepEqual([first.options['padding-x'], first.options['padding-y'], redraw['padding-x'], redraw['padding-y']], [0, 7, 0, 7]);
  assert.deepEqual([redraw.color, redraw['label-color'], redraw['label-weight'], redraw['label-align'], redraw['label-gap'], redraw.border], ['#00ff00', '#00ff00', 'normal', 'right', 0.5, 16]);
  assert.deepEqual([next.options['padding-x'], next.options['padding-y'], next.options['font-size'], next.options['label-size'], next.options['line-height'], next.options['label-align'], next.options['label-weight'], next.options['label-gap'], next.options.label, next.overrides], [9, 5, 'auto', 'auto', 1.2, 'center', 'bold', 8, '', {}]);
  assert.equal(first.options.color, '#0000ff');
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.options) && Object.isFrozen(first.overrides));
  assert.equal(invalid, undefined);
});
// S04 / README Text options: expected wire values must not come from the parser's own overrides.
for (const [suffix, expectedOverrides, axes] of [
  ['font-size:15;label-size:13.9', { label: 'C', 'font-size': 15, 'label-size': 13.9 }, [16, 16]],
  ['font-size:48.1;label-size:32.1', { label: 'C', 'font-size': 48.1, 'label-size': 32.1 }, [16, 16]],
  ['padding:0;padding-x:3;padding-y:33;line-height:3', { label: 'C', padding: 0, 'padding-x': 3, 'padding-y': 33, 'line-height': 3 }, [3, 33]],
  ['font-size:0.5;label-size:0.5;label-gap:0;border:16', { label: 'C', 'font-size': 0.5, 'label-size': 0.5, 'label-gap': 0, border: 16 }, [16, 16]],
]) {
  test(`formerly restricted text values parse literally with immutable provenance: ${suffix}`, () => {
    // Arrange
    const wire = `text:A|label:C;${suffix}`;
    // Act
    const result = parseOutputUpdate(wire);
    // Assert
    assert.equal(result.kind, 'text');
    assert.equal(result.value, 'A');
    assert.deepEqual(result.overrides, expectedOverrides);
    for (const [key, value] of Object.entries(expectedOverrides)) assert.equal(result.options[key], value);
    assert.deepEqual([result.options['padding-x'], result.options['padding-y']], axes);
    assert.ok(Object.isFrozen(result.options) && Object.isFrozen(result.overrides));
  });
}
for (const suffix of ['padding-x:-1', 'padding-y:1e2', 'line-height:0.99', 'font-size:0', 'label-size:0', 'label-align:start', 'label-weight:700', 'label-gap:-1', 'border:16.01']) {
  test(`invalid expanded text layout skips all sibling content/styles: ${suffix}`, () => {
    // Arrange
    const wire = `text:A|color:red;label:C;${suffix}`;
    // Act
    const rejected = parseOutputUpdate(wire);
    const later = parseOutputUpdate('text:next');
    // Assert
    assert.equal(rejected, undefined);
    assert.deepEqual([later.options.color, later.options.label, later.options['padding-x'], later.options['label-gap']], ['#969696', '', 16, 8]);
  });
}

// Slice 3: caption content and style provenance remain immutable and record-local.
for (const position of ['above', 'below']) {
  test(`text caption ${position} survives re-resolution while omitted next record resets to below`, () => {
    // Arrange - Do not pass a previous record as caller defaults.
    const defaults = Object.freeze({ color: 'blue' });
    const wire = `text:42|label:Items;label-position:${position};font-size:48;label-size:14.25;label-color:ivory`;
    // Act
    const first = parseOutputUpdate(wire, defaults);
    const redraw = resolveOutputOptions('text', first.overrides, { color: 'lime' });
    const next = parseOutputUpdate('text:next|label:New', defaults);
    // Assert
    assert.deepEqual([first.options['label-position'], first.overrides['label-position'], redraw['label-position']], [position, position, position]);
    assert.deepEqual([redraw.color, redraw['label-color'], redraw['font-size'], redraw['label-size']], ['#00ff00', '#fffff0', 48, 14.25]);
    assert.equal(next.options['label-position'], 'below'); assert.equal(Object.hasOwn(next.overrides, 'label-position'), false);
    assert.ok(Object.isFrozen(first) && Object.isFrozen(first.options) && Object.isFrozen(first.overrides));
  });
}
for (const suffix of ['label-position:center', 'label-position:top', 'label-position:bottom', 'label-position:Above', 'label-position: ', 'label-position:', 'label-position:above;label-position:below', 'labelPosition:above', 'label-position:above;scale:80']) {
  test(`invalid text caption order skips the entire reserved record: ${suffix}`, () => {
    // Arrange
    const wire = `text:42|color:red;label:Items;${suffix}`;
    // Act
    const result = parseOutputUpdate(wire);
    // Assert
    assert.equal(result, undefined);
  });
}
// Slice 4 / README 72: LF is immutable main content, not a new DTO or option.
test('hard-break text snapshots keep decoded main content distinct from raw stdout and annotations', () => {
  // Arrange
  const wire = String.raw`a\n\nb\\n`;
  const defaults = Object.freeze({ color: 'blue' });
  // Act
  const explicit = parseOutputUpdate(`text:${wire}|label:c\\n`, defaults);
  const raw = parseOutputUpdate(wire, defaults);
  const progress = parseOutputUpdate(String.raw`progress:1/2|display:d\n;label:e\n`, defaults);
  const redraw = resolveOutputOptions('text', explicit.overrides, { color: 'lime' });
  // Assert
  assert.equal(explicit.value, 'a\n\nb\\n');
  assert.equal(raw.value, wire);
  assert.deepEqual([explicit.options.label, progress.options.display, progress.options.label], [String.raw`c\n`, String.raw`d\n`, String.raw`e\n`]);
  assert.deepEqual(Object.keys(explicit).sort(), ['kind', 'options', 'overrides', 'value']);
  assert.deepEqual([redraw.color, redraw.label, explicit.options.color], ['#00ff00', String.raw`c\n`, '#0000ff']);
  assert.ok(Object.isFrozen(explicit) && Object.isFrozen(explicit.options) && Object.isFrozen(explicit.overrides));
});
for (const suffix of ['max-lines:2', 'hard-breaks:true', 'label:bad\\', 'font-size:0', 'color:red;color:blue']) {
  test('invalid hard-break record remains an atomic skip with no ordinary fallback', () => {
    // Arrange
    const wire = String.raw`text:a\nb|` + suffix;
    // Act
    const result = parseOutputUpdate(wire);
    // Assert
    assert.equal(result, undefined);
  });
}
test('text caption updates retain literal content through theme re-resolution and clear on omission', () => {
  // Arrange
  const defaults = Object.freeze({ color: 'blue', label: 'old' });
  const line = String.raw`text:42\n|font-size:48;label:a\;b\|c\\d\n;label-size:14.25`;
  // Act
  const first = parseOutputUpdate(line, defaults);
  const redraw = resolveOutputOptions('text', first.overrides, { color: 'lime', label: 'wrong' });
  const next = parseOutputUpdate('text:next', defaults);
  // Assert
  assert.equal(first.value, '42\n');
  assert.equal(first.options.label, String.raw`a;b|c\d\n`);
  assert.deepEqual([first.options['font-size'], first.options['label-size'], first.options['label-color']], [48, 14.25, '#0000ff']);
  assert.deepEqual([redraw.label, redraw['label-color']], [first.options.label, '#00ff00']);
  assert.deepEqual([next.options.label, next.options['label-size'], next.options['label-color'], next.overrides], ['', 'auto', '#0000ff', {}]);
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.options) && Object.isFrozen(first.overrides));
});
for (const suffix of ['label:a;label:b', 'label:unfinished\\', 'label-size:0', 'label-size:-1', 'label-size:1e1', 'label-color:accent', 'label-color:transparent', 'label:a\0b', 'font-size:-1']) {
  test('invalid text caption commands skip atomically without literal fallback', () => {
    // Arrange
    const line = `text:42|color:red;${suffix}`;
    // Act
    const result = parseOutputUpdate(line);
    // Assert
    assert.equal(result, undefined);
  });
}

for (const source of [String.raw`raw\,text\|path\\name\n`, '/synthetic/folder/file.py', 'a:b:c', '"quoted"', 'TEXT:hello', 'unknown:value|color:red', '{"image":"<svg/>","title":"caption"}', '{broken', '[]', 'null']) {
  test('raw and JSON-looking text remains complete literal text', () => {
    // Arrange
    const line = source;
    // Act
    const result = parseOutputUpdate(line);
    // Assert
    assert.equal(result.kind, 'text');
    assert.equal(result.value, line);
    assert.deepEqual(result.overrides, {});
    assert.equal(result.options.color, '#969696');
    assert.equal(Object.hasOwn(result, 'title'), false);
  });
}

for (const source of ['', ' ', '\t', '\u2003']) {
  test('blank records are skipped', () => {
    // Arrange
    const line = source;
    // Act
    const result = parseOutputUpdate(line);
    // Assert
    assert.equal(result, undefined);
  });
}
for (const [source, value] of [['text:', ''], ['text:a:b"c"', 'a:b"c"'], [String.raw`text:a\;b,c\|d\\e\n\,|font:mono`, String.raw`a;b,c|d\e` + '\n' + String.raw`\,`]]) {
  test('explicit text preserves content and supports empty clear', () => {
    // Arrange
    const line = source;
    // Act
    const result = parseOutputUpdate(line);
    // Assert
    assert.equal(result.kind, 'text');
    assert.equal(result.value, value);
    assert.equal(result.options.color, '#969696');
  });
}

for (const [source, expected] of [['0', 0], ['100', 100], ['42.5', 42.5], ['-.5', 0], ['+101.5', 100], ['.25', 0.25]]) {
  test(`progress decimal ${source} clamps to percentage ${expected}`, () => {
    // Arrange
    const line = `progress:${source}`;
    // Act
    const result = parseOutputUpdate(line);
    // Assert
    assert.deepEqual([result.kind, result.value, result.options.type], ['progress', expected, 'ring']);
  });
}

const invalid = ['progress:', 'progress:NaN', 'progress:Infinity', 'progress:1e2', 'progress:0x10', 'progress:1/0', 'progress:50%', 'progress: 50', `progress:${'9'.repeat(400)}`, 'text:x|color:red;color:blue', 'text:x|Color:red', 'text:x|padding:-1', 'text:x|background:transparent', 'text:x|font:serif', 'text:x|type:ring', 'text:x\\', 'progress:1|showvalue:true', 'progress:1|value:1;max:2', 'progress:1|type:bar;thickness:0', 'progress:1|label:unfinished\\'];
for (const [index, line] of invalid.entries()) {
  test(`invalid reserved record ${index} skips rather than becoming text`, () => {
    // Arrange
    const source = line;
    // Act
    const result = parseOutputUpdate(source);
    // Assert
    assert.equal(result, undefined);
  });
}

for (const mime of ['png', 'jpeg', 'svg+xml', 'webp']) {
  test(`raw ${mime} image stays untinted and has no title envelope`, () => {
    // Arrange
    const image = `data:image/${mime};base64,YQ==`;
    const defaults = { color: 'red', foreground: 'theme', background: 'ivory', border: 8, 'border-color': 'blue' };
    // Act
    const result = parseOutputUpdate(image, defaults);
    // Assert
    assert.deepEqual(result, { kind: 'image', image });
    assert.ok(Object.isFrozen(result));
  });
}
for (const image of ['<svg/>', ' <svg><broken></svg>', '<svg>é😀 #%</svg>']) {
  test('raw SVG is encoded without full XML validation', () => {
    // Arrange
    const expected = { kind: 'image', image: `data:image/svg+xml,${encodeURIComponent(image)}` };
    // Act
    const result = parseOutputUpdate(image);
    // Assert
    assert.deepEqual(result, expected);
  });
}

for (const [encoding, body] of [['ASCII', 'x'.repeat(262133)], ['multibyte', 'é'.repeat(131066) + 'x']]) {
  test(`recognized ${encoding} SVG accepts the exact byte limit and rejects one extra byte`, () => {
    // Arrange: image delegation must not bypass the output record's UTF-8 byte bound.
    const image = `<svg>${body}</svg>`, oversized = `<svg>${body}x</svg>`;
    let failure;
    // Act
    const result = parseOutputUpdate(image);
    try { parseOutputUpdate(oversized); } catch (error) { failure = error; }
    // Assert
    assert.deepEqual(result, { kind: 'image', image: `data:image/svg+xml,${encodeURIComponent(image)}` });
    assert.equal(failure?.message, 'Image protocol error.');
    assert.equal(failure?.cause, undefined);
  });
}

const fatal = ['<svg-not-root/>', '<svg', 'data:image/gif;base64,YQ==', 'data:image/png,YQ==', 'data:image/png;base64,', 'data:image/png;base64,Y===', 'data:image/png;base64,YQ=', 'data:image/png;base64,Y Q==', 'data:image/png;base64,%%%=', 'data:image/png;base64,YQ==|color:red', null, 42, {}, new String('text:x'), 'a'.repeat(262145), 'é'.repeat(131073)];
for (const [index, line] of fatal.entries()) {
  test(`fatal image or record boundary ${index} exposes only fixed error`, () => {
    // Arrange
    let failure;
    // Act
    try { parseOutputUpdate(line); } catch (error) { failure = error; }
    // Assert
    assert.ok(failure instanceof Error);
    assert.equal(failure.message, 'Image protocol error.');
    assert.equal(failure.cause, undefined);
  });
}
for (const line of ['a'.repeat(262144), 'é'.repeat(131072)]) {
  test('exact UTF-8 payload limit remains accepted', () => {
    // Arrange
    const source = line;
    // Act
    const result = parseOutputUpdate(source);
    // Assert
    assert.equal(result.value, source);
  });
}

test('records reset label, type and style rather than inheriting prior updates', () => {
  // Arrange
  const defaults = Object.freeze({ type: 'bar', label: 'old', color: 'blue' });
  // Act
  const first = parseOutputUpdate('progress:40|type:bar;label:new;color:red;font:mono', defaults);
  const second = parseOutputUpdate('progress:50', defaults);
  // Assert
  assert.deepEqual([first.options.type, first.options.label, first.options.color, first.options.font], ['bar', 'new', '#ff0000', 'mono']);
  assert.deepEqual([second.options.type, second.options.label, second.options.color, second.options.font, second.options.scale, second.options.thickness], ['ring', '', '#0000ff', 'sans', 80, 8]);
});

test('explicit overrides retain provenance and frozen DTOs survive changed defaults', () => {
  // Arrange
  const defaults = { color: 'blue', font: 'sans' };
  // Act
  const first = parseOutputUpdate('text:hello|color:red;font:mono', defaults);
  defaults.color = 'green';
  defaults.font = 'mono';
  const second = parseOutputUpdate('text:next', defaults);
  let rejected = 0;
  for (const mutate of [() => { first.value = 'changed'; }, () => { first.options.color = '#000000'; }, () => { first.overrides.font = 'sans'; }]) {
    try { mutate(); } catch { rejected += 1; }
  }
  // Assert
  assert.deepEqual(first.overrides, { color: '#ff0000', font: 'mono' });
  assert.deepEqual([first.value, first.options.color, second.options.color, rejected], ['hello', '#ff0000', '#008000', 3]);
  assert.deepEqual(second.overrides, {});
});

test('hostile defaults never invoke getters or leak errors into primitive updates', () => {
  // Arrange
  let calls = 0;
  const defaults = { get color() { calls += 1; throw new Error('synthetic'); }, font: 'mono' };
  // Act
  const result = parseOutputUpdate('text:hello', defaults);
  // Assert
  assert.deepEqual([result.value, result.options.color, result.options.font, calls], ['hello', '#969696', 'mono', 0]);
});

// Omission inherits only this call's theme, never the preceding record's explicit ink.
for (const source of ['Hi', '{broken', 'text:Hi', 'text:1|font:mono;weight:bold;font-size:auto;background:#090D18;border:3']) {
  test('text records inherit custom theme without forging color provenance', () => {
    // Arrange
    const defaults = Object.freeze({ color: 'blue' });
    // Act
    const result = parseOutputUpdate(source, defaults);
    // Assert
    assert.deepEqual([result.kind, result.options.color, result.options['border-color']], ['text', '#0000ff', '#0000ff']);
    assert.equal(Object.hasOwn(result.overrides, 'color'), false);
    assert.equal(Object.hasOwn(result.overrides, 'foreground'), false);
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.options) && Object.isFrozen(result.overrides));
    assert.deepEqual(defaults, { color: 'blue' });
  });
}
test('text complete-record reset restores theme ink after explicit red and white records', () => {
  // Arrange
  const defaults = Object.freeze({ color: 'blue' });
  // Act
  const red = parseOutputUpdate('text:Hi|color:red', defaults);
  const white = parseOutputUpdate('text:Hi|color:white', defaults);
  const next = parseOutputUpdate('text:Hi', defaults);
  // Assert
  assert.deepEqual([red.options.color, white.options.color, next.options.color], ['#ff0000', '#ffffff', '#0000ff']);
  assert.deepEqual(next.overrides, {});
});
for (const suffix of ['color:transparent', 'foreground:bad', 'color:red;color:blue']) {
  test('invalid text color selection skips instead of using the new theme default', () => {
    // Arrange
    const source = `text:Hi|${suffix}`;
    // Act
    const result = parseOutputUpdate(source, { color: 'blue' });
    // Assert
    assert.equal(result, undefined);
  });
}
for (const type of ['ring', 'bar']) {
  test(`${type} still defaults to white annotations with a custom key theme`, () => {
    // Arrange
    const source = `progress:42|type:${type};label:Hi`;
    // Act
    const result = parseOutputUpdate(source, { color: 'blue' });
    // Assert
    assert.deepEqual([result.options.color, result.options['value-color'], result.options['label-color']], ['#0000ff', '#ffffff', '#ffffff']);
    assert.deepEqual(resolveOutputOptions('progress', result.overrides, { color: 'blue' }), result.options);
  });
}

for (const kind of ['text', 'progress']) {
  test(`${kind} background/frame reset on the next complete record with immutable provenance`, () => {
    // Arrange
    const value = kind === 'text' ? 'hello' : '42';
    const firstLine = `${kind}:${value}|background:ivory;border:0.5;border-color:blue;color:black`;
    // Act
    const first = parseOutputUpdate(firstLine);
    const second = parseOutputUpdate(`${kind}:${value}`);
    // Assert
    assert.deepEqual(first.overrides, { background: '#fffff0', border: 0.5, 'border-color': '#0000ff', color: '#000000' });
    assert.deepEqual([second.options.background, second.options.border, second.options['border-color']], ['#000000', 0, '#969696']);
    assert.ok(Object.isFrozen(first.options) && Object.isFrozen(first.overrides));
    assert.deepEqual(second.overrides, {});
  });
  for (const suffix of ['background:transparent', 'border:true', 'border-color:var(--x)', 'background:white;background:black', 'Background:white']) {
    test(`${kind} invalid new style skips the entire reserved record`, () => {
      // Arrange
      const line = `${kind}:${kind === 'text' ? 'hello' : '42'}|${suffix}`;
      // Act
      const result = parseOutputUpdate(line);
      // Assert
      assert.equal(result, undefined);
    });
  }
}

test('complete progress annotation DTO resets omitted styles and retains independent provenance', () => {
  // Arrange
  const line = 'progress:45|value-size:20.5;label-size:24;value-color:red;label-color:blue;label:Hi';
  // Act
  const first = parseOutputUpdate(line);
  const next = parseOutputUpdate('progress:45|color:lime');
  // Assert
  assert.deepEqual(first.overrides, { 'value-size': 20.5, 'label-size': 24, 'value-color': '#ff0000', 'label-color': '#0000ff', label: 'Hi' });
  assert.deepEqual(resolveOutputOptions('progress', first.overrides), first.options);
  assert.deepEqual([next.options['value-size'], next.options['label-size'], next.options['value-color'], next.options['label-color'], next.options.label], [16, 16, '#ffffff', '#ffffff', '']);
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.options) && Object.isFrozen(first.overrides));
});
for (const suffix of ['value-size:0', 'label-size:-1', 'value-size:auto', 'label-color:transparent', 'value-color:var(--x)', 'value-size:20;value-size:24', 'Label-color:red']) {
  test('invalid annotation suffix skips complete reserved progress rather than falling back to text', () => {
    // Arrange
    const line = `progress:45|${suffix}`;
    // Act
    const result = parseOutputUpdate(line);
    // Assert
    assert.equal(result, undefined);
  });
}

test('symbolic accent provenance re-resolves without mutating prior records and resets on omission', () => {
  // Arrange - Cosmetic redraw needs symbols, not a captured annotation hex.
  const defaults = Object.freeze({ color: 'blue' });
  // Act
  const first = parseOutputUpdate('progress:42|value-color:accent;label-color:accent;label:Hi', defaults);
  const nextTheme = resolveOutputOptions('progress', first.overrides, { color: 'lime' });
  const reset = parseOutputUpdate('progress:42', defaults);
  const invalid = parseOutputUpdate('progress:42|value-color:accent;label-color:Accent', defaults);
  // Assert
  assert.deepEqual(first.overrides, { 'value-color': 'accent', 'label-color': 'accent', label: 'Hi' });
  assert.deepEqual([first.options['value-color'], first.options['label-color']], ['#0000ff', '#0000ff']);
  assert.deepEqual([nextTheme['value-color'], nextTheme['label-color']], ['#00ff00', '#00ff00']);
  assert.deepEqual([reset.options['value-color'], reset.options['label-color'], reset.options.label], ['#ffffff', '#ffffff', '']);
  assert.ok(Object.isFrozen(first.overrides));
  assert.equal(invalid, undefined);
});

// Slice 2: ratios retain geometry precision; annotation rounding is not parsing.
const huge = '1' + '0'.repeat(308), tiny = '0.' + '0'.repeat(307) + '1';
for (const [source, expected] of [
  ['0/1', 0], ['17/1034', 1700 / 1034], ['1/2', 50], ['+.5/+2.5', 20],
  ['1./2.', 50], ['001/004', 25], ['-1/2', 0], ['3/2', 100],
  [`${huge}/${tiny}`, 100], [`-${huge}/1`, 0], [`${huge}/${huge}`, 100],
  [`${tiny}/${tiny}`, 100], [`${tiny}/1`, 1e-306], [`${tiny}/${huge}`, 0],
  [`${'5' + '0'.repeat(307)}/${huge}`, 50],
]) {
  test(`ratio case ${source.length}/${expected} preserves full clamped percentage`, () => {
    // Arrange
    const line = `progress:${source}`;
    // Act
    const result = parseOutputUpdate(line);
    // Assert
    assert.equal(result.kind, 'progress');
    // S06: computed ratios allow rounding noise; clamping and extreme underflow stay exact.
    if (expected === 0 || expected === 100) assert.equal(result.value, expected);
    else assert.ok(Math.abs(result.value - expected) <= Math.max(Number.MIN_VALUE, Math.abs(expected) * 1e-14));
    assert.equal(result.options.display, undefined);
    assert.ok(Object.isFrozen(result));
  });
}
for (const [index, source] of ['/1', '1/', '/', '1/2/3', '1//2', '1/0', '1/-0', '1/-1', '1/-.5', 'NaN/2', '1/Infinity', 'Infinity/2', '1e2/3', '1/2e2', '0x1/2', '1/0x2', ' 1/2', '1 /2', '1/ 2', '1/2 ', '1/2\n', `${'9'.repeat(400)}/1`, '1/0.' + '0'.repeat(400)].entries()) {
  test(`invalid ratio ${index} skips the whole reserved record`, () => {
    // Arrange
    const line = `progress:${source}|display:must not fall back;color:red`;
    // Act
    const result = parseOutputUpdate(line);
    // Assert
    assert.equal(result, undefined);
  });
}
test('literal ratio display and accent provenance survive cosmetic re-resolution and omission resets content', () => {
  // Arrange
  const defaults = Object.freeze({ display: 'old', label: 'old', color: 'blue' });
  // Act
  const first = parseOutputUpdate(String.raw`progress:17/1034|display:17\;done\|path\\x:{value},"q";label:Build;value-color:accent`, defaults);
  const redraw = resolveOutputOptions('progress', first.overrides, { color: 'lime', display: 'wrong' });
  const next = parseOutputUpdate('progress:17/1034', defaults);
  // Assert
  assert.equal(first.options.display, String.raw`17;done|path\x:{value},"q"`);
  assert.ok(Math.abs(first.value - 1700 / 1034) <= (1700 / 1034) * 1e-14);
  assert.equal(redraw.display, first.options.display);
  assert.equal(redraw['value-color'], '#00ff00');
  assert.equal(first.overrides['value-color'], 'accent');
  assert.equal(first.options['value-color'], '#0000ff');
  assert.deepEqual([next.options.display, next.options.label, next.overrides], [undefined, '', {}]);
  assert.ok(Object.isFrozen(first.options) && Object.isFrozen(first.overrides));
});
