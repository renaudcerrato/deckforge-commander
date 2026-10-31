import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOutputNumber, parseOutputCommand, resolveOutputOptions } from '../src/core/output-options.mjs';

// Card v1: literal fields share delimiter escaping, never text-main hard breaks.
test('card fields preserve literal backslash-n and escaped delimiters', () => {
  // Arrange
  const source = String.raw`UP\n\|ok|header:API\;v2\n;footer:HTTP\\200;header-align:left;footer-align:right`;
  // Act
  const result = parseOutputCommand('card', source);
  // Assert
  assert.equal(result.value, String.raw`UP\n|ok`);
  assert.deepEqual(result.overrides, { header: String.raw`API;v2\n`, footer: String.raw`HTTP\200`, 'header-align': 'left', 'footer-align': 'right' });
});

test('card sides inherit main typography and color but not its alignment or record content', () => {
  // Arrange
  const defaults = { color: 'blue', font: 'mono', weight: 'bold', align: 'right', header: 'old', footer: 'old' };
  // Act
  const inherited = resolveOutputOptions('card', {}, defaults);
  const explicit = resolveOutputOptions('card', { color: 'red', 'header-font': 'sans', 'header-weight': 'normal', 'footer-color': 'ivory', 'footer-align': 'left' }, defaults);
  // Assert
  assert.deepEqual([inherited.header, inherited.footer, inherited['header-color'], inherited['footer-font'], inherited['header-weight'], inherited['header-align'], inherited['footer-align']], ['', '', '#0000ff', 'mono', 'bold', 'center', 'center']);
  assert.deepEqual([explicit['header-color'], explicit['header-font'], explicit['header-weight'], explicit['footer-color'], explicit['footer-font'], explicit['footer-align']], ['#ff0000', 'sans', 'normal', '#fffff0', 'mono', 'left']);
});

for (const suffix of ['label:x', 'valign:top', 'overflow:clip', 'line-height:1.2', 'scale:80', 'header:x;header:y', 'unknown:1', 'header-align:start', 'footer-font:serif', 'header-color:accent', 'footer-weight:700', 'header-size:0', 'footer-size:1e2', 'header:bad\\']) {
  test(`card invalid suffix rejects the entire command: ${suffix}`, () => {
    // Arrange
    const source = `UP|color:red;${suffix}`;
    // Act
    const result = parseOutputCommand('card', source);
    // Assert
    assert.equal(result, undefined);
  });
}

test('card gaps accept zero and fractional values independently, with ellipsis as the default', () => {
  // Arrange
  const defaults = { 'header-gap': 12, 'footer-gap': 4, overflow: 'wrap' };
  // Act
  const baseline = resolveOutputOptions('card');
  const command = parseOutputCommand('card', 'UP|header-gap:0;footer-gap:0.5;overflow:wrap');
  const resolved = resolveOutputOptions('card', command.overrides, defaults);
  const inherited = resolveOutputOptions('card', {}, defaults);
  // Assert
  assert.deepEqual([baseline['header-gap'], baseline['footer-gap'], baseline.overflow], [8, 8, 'ellipsis']);
  assert.deepEqual([resolved['header-gap'], resolved['footer-gap'], resolved.overflow], [0, 0.5, 'wrap']);
  assert.deepEqual([inherited['header-gap'], inherited['footer-gap'], inherited.overflow], [12, 4, 'wrap']);
});

test('card gap validation is atomic for records and forgiving for invalid caller defaults', () => {
  // Arrange
  const invalid = [-1, Infinity, NaN, '1e2', true];
  // Act
  const rejected = invalid.flatMap(value => ['header-gap', 'footer-gap'].map(key => resolveOutputOptions('card', { header: 'H', [key]: value })));
  const inherited = resolveOutputOptions('card', {}, { 'header-gap': -1, 'footer-gap': 0.5 });
  const duplicate = parseOutputCommand('card', 'UP|header-gap:0;header-gap:8');
  // Assert
  assert.deepEqual(rejected, Array(invalid.length * 2).fill(undefined));
  assert.deepEqual([inherited['header-gap'], inherited['footer-gap']], [8, 0.5]);
  assert.equal(duplicate, undefined);
});
for (const key of ['font-size', 'header-size', 'footer-size']) {
  test(`card ${key} accepts auto and finite positive sizes without policy clamping`, () => {
    // Arrange
    const values = ['auto', Number.MIN_VALUE, 0.5, 128, Number.MAX_VALUE];
    // Act
    const results = values.map(value => resolveOutputOptions('card', { [key]: value }));
    const invalid = [0, -1, NaN, Infinity].map(value => resolveOutputOptions('card', { [key]: value }));
    // Assert
    assert.deepEqual(results.map(result => result[key]), values);
    assert.deepEqual(invalid, Array(4).fill(undefined));
  });
}

// S2: numeric validity is separate from actual drawable-track/annotation fit.
for (const key of ['scale', 'thickness', 'value-size', 'label-size', 'label-gap']) {
  for (const type of ['ring', 'bar']) {
    for (const value of [Number.MIN_VALUE, 0.5, 3, 25, 49, 110, Number.MAX_VALUE, ...(key === 'label-gap' ? [0] : [])]) {
      test(`S2 ${type} retains finite ${key}:${value} without policy clamping`, () => {
        // Arrange
        const overrides = Object.freeze({ type, [key]: value });
        // Act
        const result = resolveOutputOptions('progress', overrides);
        // Assert
        assert.equal(result[key], value);
        assert.ok(Object.isFrozen(result));
      });
    }
    for (const value of [-1, NaN, Infinity, -Infinity, '1e2', '0x10', ' 2', '2 ', true, null, {}, ...(key === 'label-gap' ? [] : [0])]) {
      test(`S2 ${type} invalid ${key}:${String(value)} is atomic, defaults forgive only that field`, () => {
        // Arrange
        const input = { type, color: 'blue', [key]: value };
        const baseline = resolveOutputOptions('progress', { type });
        // Act
        const explicit = resolveOutputOptions('progress', input);
        const inherited = resolveOutputOptions('progress', { type }, input);
        // Assert
        assert.equal(explicit, undefined);
        assert.equal(inherited[key], baseline[key]);
        assert.equal(inherited.color, '#0000ff');
      });
    }
  }
  for (const value of ['0.5', '110', '1000000']) test(`S2 progress decimal wire ${key}:${value} survives literally`, () => {
    // Arrange
    const source = `1|${key}:${value}`;
    // Act
    const result = parseOutputCommand('progress', source);
    // Assert
    assert.equal(result.overrides[key], Number(value));
  });
}
for (const [explicit, defaults, weight] of [
  [{}, {}, 'normal'], [{ weight: 'bold' }, {}, 'bold'],
  [{ weight: 'bold' }, { 'label-weight': 'normal' }, 'normal'],
  [{ 'label-weight': 'bold' }, { 'label-weight': 'normal' }, 'bold'],
  [{}, { weight: 'bold', 'label-weight': 'invalid' }, 'bold'],
]) test(`S2 progress independent label-weight precedence ${JSON.stringify(explicit)}/${JSON.stringify(defaults)}`, () => {
  // Arrange
  const input = Object.freeze(explicit), inherited = Object.freeze(defaults);
  // Act
  const result = resolveOutputOptions('progress', input, inherited);
  // Assert
  assert.equal(result['label-weight'], weight);
  assert.equal(result.weight, explicit.weight ?? defaults.weight ?? 'normal');
  assert.equal(result['label-gap'], 2);
});
for (const key of ['label-weight', 'label-gap']) {
  for (const suffix of [`${key}:bad`, `${key}:${key === 'label-weight' ? 'bold' : '0'};${key}:${key === 'label-weight' ? 'normal' : '2'}`, `${key}:${key === 'label-weight' ? 'bold' : '0'};unknown:1`]) {
    test(`S2 progress rejects invalid or duplicate pair control: ${suffix}`, () => {
      // Arrange
      const source = `1|color:red;${suffix}`;
      // Act
      const result = parseOutputCommand('progress', source);
      // Assert
      assert.equal(result, undefined);
    });
  }
  test(`S2 progress ${key} accessor never runs at explicit/default boundary`, () => {
    // Arrange
    let calls = 0;
    const input = { weight: 'bold', get [key]() { calls++; throw Error('unexpected getter'); } };
    // Act
    const explicit = resolveOutputOptions('progress', input), inherited = resolveOutputOptions('progress', {}, input);
    // Assert
    assert.equal(explicit, undefined);
    assert.equal(inherited[key], key === 'label-weight' ? 'bold' : 2);
    assert.equal(calls, 0);
  });
}

for (const [source, expected] of [['0', 0], ['-12.5', -12.5], ['+5', 5], ['.5', 0.5], ['1.', 1], ['001', 1]]) {
  test(`finite decimal ${source} parses literally`, () => {
    // Arrange
    const input = source;
    // Act
    const result = parseOutputNumber(input);
    // Assert
    assert.equal(result, expected);
  });
}
for (const [index, input] of ['', ' 1', '1 ', '1\n', '0x10', '1e2', 'NaN', 'Infinity', '-Infinity', '1/2', '5%', '1,2', '--1', '9'.repeat(400), 1, null, undefined, {}, new String('1')].entries()) {
  test(`rejects nondecimal or nonfinite number case ${index}`, () => {
    // Arrange
    const source = input;
    // Act
    const result = parseOutputNumber(source);
    // Assert
    assert.equal(result, undefined);
  });
}

const common = { color: '#969696', background: '#000000', font: 'sans', weight: 'normal', border: 0, 'border-color': '#969696' };
// Slice 4 / README protocol grammar: only text main decodes hard breaks, after splitting.
for (const count of [1, 2, 3, 4, 5, 6]) {
  test(`text hard-break escape respects backslash parity ${count}`, () => {
    // Arrange
    const source = 'a' + '\\'.repeat(count) + 'nb|label:c\\n';
    const expected = 'a' + '\\'.repeat(Math.floor(count / 2)) + (count % 2 ? '\n' : 'n') + 'b';
    // Act
    const result = parseOutputCommand('text', source);
    // Assert
    assert.equal(result.value, expected);
    assert.equal(result.overrides.label, String.raw`c\n`);
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.overrides));
  });
}
for (const kind of ['text', 'progress']) {
  test(`${kind} mixed hard-break and delimiter escapes cannot move grammar boundaries`, () => {
    // Arrange
    const source = String.raw`a\n\;b\|c\\n\q,"x":y|label:L\n\;M\|N\\n;${kind === 'text' ? 'font-size:16' : 'display:D\\n'}`;
    const value = 'a' + (kind === 'text' ? '\n' : String.raw`\n`) + String.raw`;b|c\n\q,"x":y`;
    // Act
    const result = parseOutputCommand(kind, source);
    // Assert
    assert.equal(result.value, value);
    assert.equal(result.overrides.label, String.raw`L\n;M|N\n`);
    if (kind === 'progress') assert.equal(result.overrides.display, String.raw`D\n`);
  });
}
const textBase = { ...common, 'font-size': 'auto', valign: 'center', align: 'center', overflow: 'wrap', padding: 16, 'padding-x': 16, 'padding-y': 16, 'line-height': 1.2, label: '', 'label-size': 'auto', 'label-color': common.color, 'label-position': 'below', 'label-weight': 'normal', 'label-align': 'center', 'label-gap': 8 };
const ringBase = { ...common, type: 'ring', scale: 80, thickness: 8, 'track-color': '#333333', label: '', display: undefined, 'value-position': 'center', 'label-position': 'below', rounded: true, 'value-size': 16, 'label-size': 16, 'value-color': '#ffffff', 'label-color': '#ffffff', 'label-weight': 'normal', 'label-gap': 2 };

// S1: axis precedence is semantic, never suffix/property enumeration order.
for (const [overrides, defaults, expected] of [
  [{}, {}, [16, 16]],
  [{}, { padding: 0 }, [0, 0]],
  [{}, { padding: 5, 'padding-x': 7, 'padding-y': 9 }, [7, 9]],
  [{ padding: 11 }, { padding: 5, 'padding-x': 7, 'padding-y': 9 }, [11, 11]],
  [{ padding: 11, 'padding-x': 0 }, { 'padding-y': 9 }, [0, 11]],
  [{ 'padding-y': 4 }, { padding: 5, 'padding-x': 7 }, [7, 4]],
  [{}, { padding: 5, 'padding-x': -1, 'padding-y': Infinity }, [5, 5]],
  [{}, { padding: -1, 'padding-x': 0, 'padding-y': NaN }, [0, 16]],
]) test(`text axes resolve independently ${JSON.stringify(overrides)}/${JSON.stringify(defaults)}`, () => {
  // Arrange
  const explicit = Object.freeze(overrides), inherited = Object.freeze(defaults);
  const reversed = Object.fromEntries(Object.entries(explicit).reverse());
  // Act
  const first = resolveOutputOptions('text', explicit, inherited);
  const second = resolveOutputOptions('text', reversed, inherited);
  // Assert
  assert.deepEqual([first['padding-x'], first['padding-y']], expected);
  assert.deepEqual(second, first);
  assert.ok(Object.isFrozen(first));
});
for (const suffix of ['padding:3;padding-x:7;padding-y:9', 'padding-y:9;padding-x:7;padding:3']) {
  test(`wire padding axes override shorthand independently of order: ${suffix}`, () => {
    // Arrange
    const source = `A|${suffix}`;
    // Act
    const parsed = parseOutputCommand('text', source);
    const resolved = resolveOutputOptions('text', parsed.overrides);
    // Assert
    assert.deepEqual([resolved.padding, resolved['padding-x'], resolved['padding-y']], [3, 7, 9]);
  });
}
for (const [key, values, invalid] of [
  ['padding', [0, 0.5, 11, 33, Number.MAX_VALUE], [-1]],
  ['padding-x', [0, 0.5, 80, Number.MAX_VALUE], [-1]],
  ['padding-y', [0, 0.5, 80, Number.MAX_VALUE], [-1]],
  ['font-size', [Number.MIN_VALUE, 0.5, 15, 48.1, 128, Number.MAX_VALUE], [0, -1]],
  ['label-size', [Number.MIN_VALUE, 0.5, 13.9, 32.1, 128, Number.MAX_VALUE], [0, -1]],
  ['line-height', [1, 2.5, 100, Number.MAX_VALUE], [0, 0.999]],
  ['label-gap', [0, 0.5, 100, Number.MAX_VALUE], [-1]],
]) {
  for (const value of values) test(`S1 finite text ${key} ${value} is retained without clamping`, () => {
    // Arrange
    const explicit = Object.freeze({ [key]: value });
    // Act
    const result = resolveOutputOptions('text', explicit);
    // Assert
    assert.equal(result[key], value);
    assert.equal(explicit[key], value);
  });
  for (const value of [...invalid, NaN, Infinity, -Infinity, true, null, {}, '1e2', ' 1', '1 ']) {
    test(`S1 invalid text ${key} ${String(value)} rejects atomically but defaults are forgiving`, () => {
      // Arrange
      const input = { color: 'blue', [key]: value };
      // Act
      const rejected = resolveOutputOptions('text', input);
      const inherited = resolveOutputOptions('text', {}, input);
      // Assert
      assert.equal(rejected, undefined);
      assert.equal(inherited.color, '#0000ff');
      assert.equal(inherited[key], textBase[key]);
    });
  }
  for (const value of ['0.5', '2.5', '1000000']) {
    if ((key === 'line-height' && value === '0.5')) continue;
    test(`S1 strict decimal wire supports expanded text ${key}:${value}`, () => {
      // Arrange
      const source = `A|${key}:${value}`;
      // Act
      const result = parseOutputCommand('text', source);
      // Assert
      assert.equal(result.overrides[key], Number(value));
    });
  }
}
for (const [overrides, defaults, expected] of [
  [{ weight: 'bold' }, {}, 'bold'],
  [{ weight: 'bold' }, { 'label-weight': 'normal' }, 'normal'],
  [{ weight: 'normal', 'label-weight': 'bold' }, { 'label-weight': 'normal' }, 'bold'],
  [{}, { weight: 'bold', 'label-weight': 'bad' }, 'bold'],
]) test(`caption weight has independent valid precedence: ${JSON.stringify(overrides)}`, () => {
  // Arrange
  const explicit = Object.freeze(overrides);
  // Act
  const result = resolveOutputOptions('text', explicit, Object.freeze(defaults));
  // Assert
  assert.equal(result['label-weight'], expected);
});
for (const [key, values] of [['label-align', ['left', 'center', 'right']], ['label-weight', ['normal', 'bold']]]) {
  for (const value of values) test(`text accepts independent ${key}:${value}`, () => {
    // Arrange
    const source = `A|${key}:${value}`;
    // Act
    const result = parseOutputCommand('text', source);
    // Assert
    assert.equal(result.overrides[key], value);
  });
  for (const value of ['Left', 'Bold', ' start', '', null, 1]) test(`text rejects invalid ${key} ${String(value)} without applying siblings`, () => {
    // Arrange
    const explicit = { color: 'red', [key]: value };
    // Act
    const rejected = resolveOutputOptions('text', explicit);
    const inherited = resolveOutputOptions('text', {}, explicit);
    // Assert
    assert.equal(rejected, undefined);
    assert.equal(inherited[key], textBase[key]);
    assert.equal(inherited.color, '#ff0000');
  });
}
for (const key of ['padding-x', 'padding-y', 'label-align', 'label-weight', 'label-gap']) {
    test(`new text ${key} keeps kind allowlists and rejects duplicates and unknown sibling atomically`, () => {
    // Arrange
    const value = key === 'label-align' ? 'left' : key === 'label-weight' ? 'bold' : '2';
    // Act
    const results = [parseOutputCommand('progress', `1|${key}:${value}`),
      parseOutputCommand('text', `A|${key}:${value};${key}:${value}`),
      parseOutputCommand('text', `A|${key}:${value};unknown:1`)];
    // Assert
    if (key === 'label-weight' || key === 'label-gap') assert.equal(results[0].overrides[key], key === 'label-weight' ? 'bold' : 2);
    else assert.equal(results[0], undefined);
    assert.deepEqual(results.slice(1), [undefined, undefined]);
  });
  test(`new text ${key} accessor is rejected or ignored without invocation`, () => {
    // Arrange
    let calls = 0;
    const input = { color: 'blue', get [key]() { calls++; throw Error('unexpected accessor'); } };
    // Act
    const rejected = resolveOutputOptions('text', input);
    const inherited = resolveOutputOptions('text', {}, input);
    // Assert
    assert.equal(rejected, undefined);
    assert.equal(inherited[key], textBase[key]);
    assert.equal(calls, 0);
  });
}

// Combined showcase slice / README Text: caption order is strict on records, forgiving in caller styles.
for (const kind of ['text', 'progress']) {
  for (const [index, value] of ['center', 'top', 'bottom', 'Above', 'BELOW', ' above', 'below ', ' ', '', 1, true, null, undefined, {}, new String('above')].entries()) {
    test(`${kind} invalid caption position ${index} rejects all explicit styles but ignores only the invalid default`, () => {
      // Arrange
      const explicit = { color: 'red', 'label-position': value };
      const defaults = { color: 'blue', 'label-position': value };
      // Act
      const rejected = resolveOutputOptions(kind, explicit);
      const inherited = resolveOutputOptions(kind, {}, defaults);
      const parsed = typeof value === 'string' ? parseOutputCommand(kind, `42|color:red;label-position:${value}`) : undefined;
      // Assert
      assert.equal(rejected, undefined); assert.equal(parsed, undefined);
      assert.deepEqual([inherited.color, inherited['label-position']], ['#0000ff', 'below']);
    });
  }
  for (const position of ['above', 'below']) {
    test(`${kind} valid caller caption order applies on omission and explicit opposite order wins immutably`, () => {
      // Arrange
      const defaults = Object.freeze({ color: 'blue', 'label-position': position, label: 'old' });
      const opposite = position === 'above' ? 'below' : 'above';
      const overrides = Object.freeze({ label: 'Items', 'label-position': opposite });
      // Act
      const inherited = resolveOutputOptions(kind, {}, defaults);
      const explicit = resolveOutputOptions(kind, overrides, defaults);
      // Assert
      assert.deepEqual([inherited['label-position'], inherited.label, explicit['label-position'], explicit.label], [position, '', opposite, 'Items']);
      assert.ok(Object.isFrozen(explicit)); assert.equal(overrides['label-position'], opposite);
    });
  }
  test(`${kind} caption position symbol sibling rejects the entire record`, () => {
    // Arrange
    const overrides = { 'label-position': 'above', [Symbol('synthetic')]: 'below' };
    // Act
    const result = resolveOutputOptions(kind, overrides);
    // Assert
    assert.equal(result, undefined);
  });
}

// Text captions are strict record content; progress uses fixed positive fonts (never auto).
for (const [key, values] of [['font-size', ['auto', 16, 16.25, 36, 48]], ['label-size', ['auto', 14, 14.25, 18, 32]]]) {
  for (const value of values) test(`text accepts ${key} ${value} without rounding`, () => {
    // Arrange
    const source = `42|label:Items;${key}:${value}`;
    // Act
    const result = parseOutputCommand('text', source);
    // Assert
    assert.deepEqual(result.overrides, { label: 'Items', [key]: value });
  });
  for (const value of [NaN, Infinity, -Infinity, true, null, {}, new String('16'), '1e1', '0x10', ' 16', '16 ', 'AUTO']) {
    test(`text rejects invalid ${key} ${String(value)} atomically`, () => {
      // Arrange
      const overrides = { label: 'Items', color: 'red', [key]: value };
      // Act
      const result = resolveOutputOptions('text', overrides);
      // Assert
      assert.equal(result, undefined);
    });
  }
}
for (const key of ['value-size', 'label-size']) {
  for (const value of ['auto']) test(`progress does not adopt text ${key} ${value}`, () => {
    // Arrange
    const source = `42|${key}:${value}`;
    // Act
    const result = parseOutputCommand('progress', source);
    // Assert
    assert.equal(result, undefined);
  });
}
for (const [overrides, defaults, expected] of [
  [{ label: 'Items' }, { color: 'blue', label: 'old' }, ['Items', '#0000ff', '#0000ff']],
  [{ color: 'red', label: 'Items' }, { color: 'blue' }, ['Items', '#ff0000', '#0000ff']],
  [{ color: 'red', 'label-color': 'IvOrY' }, { color: 'blue' }, ['', '#fffff0', '#0000ff']],
  [{}, { color: 'blue', label: 'old', 'label-color': 'transparent', 'label-size': 'bad' }, ['', '#0000ff', '#0000ff']],
]) test('text caption color inherits ink, explicit opaque caption wins, and content never inherits', () => {
  // Arrange
  const explicit = Object.freeze(overrides), inherited = Object.freeze(defaults);
  // Act
  const result = resolveOutputOptions('text', explicit, inherited);
  // Assert
  assert.deepEqual([result.label, result['label-color'], result['border-color']], expected);
  assert.equal(result['label-size'], 'auto');
  assert.ok(Object.isFrozen(result));
});
for (const value of ['accent', 'transparent', '#fff', '#11223344', 'currentColor', 'rgb(1,2,3)', 'url(test)', null, 1]) {
  test('text rejects unsafe or symbolic caption ink rather than partially applying styles', () => {
    // Arrange
    const overrides = { color: 'red', label: 'Items', 'label-color': value };
    // Act
    const result = resolveOutputOptions('text', overrides);
    // Assert
    assert.equal(result, undefined);
  });
}
for (const key of ['display', 'scale', 'value-color']) {
  test(`text still rejects progress-only ${key}`, () => {
    // Arrange
    const source = `42|label:Items;${key}:${key === 'scale' ? '80' : 'below'}`;
    // Act
    const result = parseOutputCommand('text', source);
    // Assert
    assert.equal(result, undefined);
  });
}
for (const [index, label] of [undefined, null, 1, false, {}, new String('Items'), 'a\0b', 'x'.repeat(262145), 'é'.repeat(131073)].entries()) {
  test(`text caption content boundary rejects case ${index} atomically`, () => {
    // Arrange
    const overrides = { color: 'red', label };
    // Act
    const result = resolveOutputOptions('text', overrides);
    // Assert
    assert.equal(result, undefined);
  });
}
for (const label of ['', ' ', 'x'.repeat(262144), 'é'.repeat(131072)]) {
  test('direct text caption accepts bounded literal content including exact UTF-8 limits', () => {
    // Arrange
    const overrides = { label };
    // Act
    const result = resolveOutputOptions('text', overrides);
    // Assert
    assert.equal(result.label, label);
  });
}
test('text caption grammar decodes only supported escapes and preserves literal backslash-n', () => {
  // Arrange
  const source = String.raw`a\n|label:a\;b\|c\\d\n,"q":e`;
  // Act
  const result = parseOutputCommand('text', source);
  // Assert
  assert.deepEqual(result, { value: 'a\n', overrides: { label: String.raw`a;b|c\d\n,"q":e` } });
});
for (const key of ['label', 'label-size', 'label-color', 'label-position']) {
  test(`text ${key} getters cannot execute at explicit or default boundaries`, () => {
    // Arrange
    let reads = 0;
    const hostile = { color: 'blue', get [key]() { reads++; throw Error('synthetic'); } };
    // Act
    const explicit = resolveOutputOptions('text', hostile);
    const inherited = resolveOutputOptions('text', {}, hostile);
    // Assert
    assert.equal(explicit, undefined);
    assert.equal(inherited[key], key === 'label' ? '' : key === 'label-size' ? 'auto' : key === 'label-position' ? 'below' : '#0000ff');
    assert.equal(reads, 0);
  });
}

for (const key of ['value-size', 'label-size']) {
  for (const value of [0.5, 15.9, 16, 20.5, 32, 32.1, 48]) {
    test(`progress accepts fixed ${key} ${value}`, () => {
      // Arrange
      const source = `42|${key}:${value}`;
      // Act
      const result = parseOutputCommand('progress', source);
      // Assert
      assert.deepEqual(result.overrides, { [key]: value });
    });
  }
  for (const value of [0, -1, Infinity, NaN, true, null, {}, new String('20'), 'auto', '1e1', '0x10', ' 20']) {
    test(`invalid explicit ${key} rejects the whole progress record`, () => {
      // Arrange
      const overrides = { color: 'red', [key]: value };
      // Act
      const result = resolveOutputOptions('progress', overrides);
      // Assert
      assert.equal(result, undefined);
    });
  }
}
for (const key of ['value-color', 'label-color']) {
  for (const [color, hex] of [['IvOrY', '#fffff0'], ['grey', '#808080'], ['#aB12Cd', '#ab12cd']]) {
    test(`progress canonicalizes independent ${key}`, () => {
      // Arrange
      const source = `42|${key}:${color}`;
      // Act
      const result = parseOutputCommand('progress', source);
      // Assert
      assert.deepEqual(result.overrides, { [key]: hex });
    });
  }
  for (const color of [undefined, null, 1, {}, 'unknown', 'transparent', '#fff', '#11223344', 'currentColor', 'rgb(0,0,0)', 'url(test)', 'var(--x)']) {
    test(`invalid explicit ${key} rejects the whole progress record`, () => {
      // Arrange
      const overrides = { font: 'mono', [key]: color };
      // Act
      const result = resolveOutputOptions('progress', overrides);
      // Assert
      assert.equal(result, undefined);
    });
  }
}
for (const key of ['value-size', 'label-size', 'value-color', 'label-color']) {
  if (key.startsWith('value-')) test(`text rejects inapplicable annotation option ${key}`, () => {
    // Arrange
    const source = `hello|${key}:${key.endsWith('size') ? '20' : 'red'}`;
    // Act
    const result = parseOutputCommand('text', source);
    // Assert
    assert.equal(result, undefined);
  });
  test(`annotation ${key} getters are rejected/ignored without invoking user code`, () => {
    // Arrange
    let reads = 0;
    const hostile = Object.defineProperty({}, key, { enumerable: true, get() { reads++; throw new Error('synthetic'); } });
    // Act
    const explicit = resolveOutputOptions('progress', hostile);
    const defaults = resolveOutputOptions('progress', {}, hostile);
    // Assert
    assert.deepEqual([explicit, defaults[key], reads], [undefined, key.endsWith('size') ? 16 : '#ffffff', 0]);
  });
}
for (const annotation of ['white', 'accent']) {
  test(`annotation colors independently inherit ${annotation} after record/default precedence`, () => {
    // Arrange
    const defaults = { color: 'blue', 'value-color': 'yellow', 'label-color': annotation, 'value-size': 20.5, 'label-size': 'bad' };
    // Act
    const inherited = resolveOutputOptions('progress', { color: 'red' }, defaults);
    const explicit = resolveOutputOptions('progress', { color: 'red', 'value-color': 'lime', 'label-color': 'ivory', 'label-size': 32 }, defaults);
    // Assert
    assert.deepEqual([inherited['value-color'], inherited['label-color'], inherited['value-size'], inherited['label-size']], ['#ffff00', annotation === 'accent' ? '#ff0000' : '#ffffff', 20.5, 16]);
    assert.deepEqual([explicit['value-color'], explicit['label-color'], explicit['value-size'], explicit['label-size']], ['#00ff00', '#fffff0', 20.5, 32]);
    assert.deepEqual([explicit.color, explicit['track-color'], explicit['border-color'], explicit.background], ['#ff0000', '#333333', '#0000ff', '#000000']);
  });
}
test('invalid annotation defaults fall back individually without corrupting valid sibling fields', () => {
  // Arrange
  const defaults = { color: 'red', foreground: 'theme', 'value-color': 'transparent', 'label-color': 'blue', 'value-size': 'auto', 'label-size': 24 };
  // Act
  const result = resolveOutputOptions('progress', {}, Object.freeze(defaults));
  // Assert
  assert.deepEqual([result['value-color'], result['label-color'], result['value-size'], result['label-size']], ['#ffffff', '#0000ff', 16, 24]);
  assert.ok(Object.isFrozen(result));
});

// Numeric frame and opaque background are per-record styles, not persistent commands.
for (const kind of ['text', 'progress']) {
  for (const value of [0, 0.5, 1, 8, 12.25, 16]) {
    test(`${kind} accepts finite numeric border width ${value}`, () => {
      // Arrange
      const source = `payload|border:${value}`;
      // Act
      const result = parseOutputCommand(kind, source);
      // Assert
      assert.deepEqual(result.overrides, { border: value });
    });
  }
  for (const value of [true, false, 'true', 'false', -0.1, 16.1, NaN, Infinity, '1e0', '0x1', ' 1']) {
    test(`${kind} rejects invalid explicit border without partial application`, () => {
      // Arrange
      const overrides = { color: 'red', border: value };
      // Act
      const result = resolveOutputOptions(kind, overrides);
      // Assert
      assert.equal(result, undefined);
    });
  }
  for (const key of ['background', 'border-color']) {
    for (const [value, expected] of [['IvOrY', '#fffff0'], ['#aB12Cd', '#ab12cd'], ['grey', '#808080']]) {
      test(`${kind} normalizes opaque ${key} ${value}`, () => {
        // Arrange
        const source = `payload|${key}:${value}`;
        // Act
        const result = parseOutputCommand(kind, source);
        // Assert
        assert.deepEqual(result.overrides, { [key]: expected });
      });
    }
    for (const value of ['transparent', '#fff', '#12345678', 'currentColor', 'url(test)', 'var(--x)', 'white;fill:red', 1, null]) {
      test(`${kind} rejects unsafe explicit ${key}`, () => {
        // Arrange
        const overrides = { [key]: value };
        // Act
        const result = resolveOutputOptions(kind, overrides);
        // Assert
        assert.equal(result, undefined);
      });
    }
  }
  test(`${kind} invalid defaults fall back independently and obsolete foreground defaults are ignored`, () => {
    // Arrange
    const defaults = Object.freeze({ background: 'transparent', border: true, 'border-color': 'url(test)', color: 'blue', foreground: 'theme' });
    // Act
    const result = resolveOutputOptions(kind, {}, defaults);
    // Assert
    assert.deepEqual([result.background, result.border, result['border-color'], result.color], ['#000000', 0, '#0000ff', '#0000ff']);
    assert.equal(Object.hasOwn(result, 'foreground'), false);
  });
  for (const [defaults, overrides, expected] of [
    [{ color: 'blue' }, { color: 'lime', border: 2 }, '#0000ff'],
    [{ color: 'blue', 'border-color': 'red' }, { color: 'lime', border: 2 }, '#ff0000'],
    [{ color: 'blue' }, { color: 'lime', border: 2, 'border-color': 'yellow' }, '#ffff00'],
  ]) {
    test(`${kind} frame color stays independent of record accent`, () => {
      // Arrange
      const base = Object.freeze(defaults), explicit = Object.freeze(overrides);
      // Act
      const result = resolveOutputOptions(kind, explicit, base);
      // Assert
      assert.deepEqual([result.color, result['border-color']], ['#00ff00', expected]);
    });
  }
  test(`${kind} style getters are never invoked`, () => {
    // Arrange
    let reads = 0;
    const hostile = {};
    for (const key of ['background', 'border', 'border-color']) Object.defineProperty(hostile, key, { enumerable: true, get() { reads++; throw new Error('synthetic'); } });
    // Act
    const explicit = resolveOutputOptions(kind, hostile);
    const defaults = resolveOutputOptions(kind, {}, hostile);
    // Assert
    assert.deepEqual([explicit, defaults.background, defaults.border, defaults['border-color'], reads], [undefined, '#000000', 0, '#969696', 0]);
  });
}

test('commas and quotes remain literal label data while semicolons delimit options', () => {
  // Arrange
  const source = '42|label:"one,two:three";font:mono';
  // Act
  const result = parseOutputCommand('progress', source);
  // Assert
  assert.deepEqual(result, { value: '42', overrides: { label: '"one,two:three"', font: 'mono' } });
});
test('legacy comma-separated option lists do not execute multiple style options', () => {
  // Arrange
  const source = 'payload|color:red,font:mono';
  // Act
  const result = parseOutputCommand('text', source);
  // Assert
  assert.equal(result, undefined);
});
for (const [kind, expected] of [['text', textBase], ['progress', ringBase]]) {
  test(`${kind} resolves complete self-contained defaults`, () => {
    // Arrange
    const overrides = Object.freeze({});
    // Act
    const result = resolveOutputOptions(kind, overrides);
    // Assert
    assert.deepEqual(result, expected);
    assert.ok(Object.isFrozen(result));
  });
}

const choices = {
  font: ['sans', 'mono'], weight: ['normal', 'bold'],
  valign: ['top', 'center', 'bottom'], align: ['left', 'center', 'right'], overflow: ['wrap', 'ellipsis'],
  type: ['ring', 'bar'], 'value-position': ['center', 'above', 'below', 'none'], 'label-position': ['above', 'below'], rounded: ['true', 'false'],
};
for (const [key, values] of Object.entries(choices)) {
  const kinds = ['valign', 'align', 'overflow'].includes(key) ? ['text'] : ['type', 'value-position', 'rounded'].includes(key) ? ['progress'] : ['text', 'progress'];
  for (const kind of kinds) {
    for (const value of values) {
      test(`${kind} accepts ${key}:${value}`, () => {
        // Arrange
        const source = `payload|${key}:${value}`;
        const expected = value === 'true' ? true : value === 'false' ? false : value;
        // Act
        const result = parseOutputCommand(kind, source);
        // Assert
        assert.deepEqual(result, { value: 'payload', overrides: { [key]: expected } });
      });
    }
    test(`${kind} rejects unsupported ${key}`, () => {
      // Arrange
      const source = `payload|${key}:unsupported`;
      // Act
      const result = parseOutputCommand(kind, source);
      // Assert
      assert.equal(result, undefined);
    });
  }
}

for (const [kind, key, low, high, type] of [
  ['text', 'border', 0, 16], ['progress', 'border', 0, 16],
]) {
  for (const value of [low, high, low - 0.1, high + 0.1]) {
    test(`${kind} ${type ?? ''} ${key} boundary ${value}`, () => {
      // Arrange
      const source = `payload|${type ? `type:${type};` : ''}${key}:${value}`;
      const accepted = value >= low && value <= high;
      // Act
      const result = parseOutputCommand(kind, source);
      // Assert
      if (accepted) assert.equal(result.overrides[key], value);
      else assert.equal(result, undefined);
    });
  }
}

for (const [kind, source, expected] of [
  ['text', 'a:b"c"', { value: 'a:b"c"', overrides: {} }],
  ['text', String.raw`a\;b\|c\\d\n\,`, { value: String.raw`a;b|c\d` + '\n' + String.raw`\,`, overrides: {} }],
  ['progress', String.raw`42|label:a\;b,c\|d\\e:x"y"`, { value: '42', overrides: { label: String.raw`a;b,c|d\e:x"y"` } }],
  ['progress', '42|label:', { value: '42', overrides: { label: '' } }],
  ['text', '|font-size:auto', { value: '', overrides: { 'font-size': 'auto' } }],
]) {
  test(`command grammar preserves literal content case ${source.length} ${kind}`, () => {
    // Arrange
    const input = source;
    // Act
    const result = parseOutputCommand(kind, input);
    // Assert
    assert.deepEqual(result, expected);
    assert.ok(Object.isFrozen(result.overrides));
  });
}

const badCommands = [
  ['text', 'x|label-position:above;label-position:below'], ['text', 'x|labelPosition:above'],
  ['text', 'x|Label-position:above'], ['text', 'x|label-position:above;value-position:below'],
  ['text', String.raw`a\n|label:unfinished` + '\\'],
  ['text', String.raw`a\n|font-size:16;max-lines:2`],
  ['text', 'x|size:16'], ['text', 'x|position:center'], ['text', 'x|foreground:white'],
  ['text', 'x|align:start'], ['text', 'x|align:end'], ['text', 'x|align:Left'], ['text', 'x|valign:Top'],
  ['text', 'x|font-size:AUTO'], ['text', 'x|font-size:0'], ['text', 'x|scale:80'], ['text', 'x|fontSize:16'],
  ['text', 'x|font-size:1.6e1'], ['text', 'x|font-size:0x10'], ['text', 'x|font-size: 16'],
  ['progress', '1|scale:1e2'], ['progress', '1|scale:0x64'], ['progress', '1|scale:100 '],
  ['progress', '1|size:80'], ['progress', '1|foreground:theme'], ['progress', '1|font-size:16'],
  ['progress', '1|align:left'], ['progress', '1|valign:top'], ['progress', '1|Scale:80'],
  ['text', 'x|color:red;font-size:16;font-size:32'], ['progress', '1|scale:50;scale:100'],
  ['progress', '1|value-color:accent;label-color:Accent'], ['text', 'x|color:accent'],
  ['text', 'x\\'], ['text', 'x|color:red\\'], ['text', 'x|'], ['text', 'x|color'], ['text', 'x|:red'],
  ['text', 'x|color:red;color:blue'], ['text', 'x|Color:red'], ['text', 'x|color:red;unsupported:black'],
  ['text', 'x|font:serif'], ['text', 'x|weight:700'], ['text', 'x|border:true'],
  ['text', 'x|max-lines:1'], ['text', 'x|max-lines:3'], ['text', 'x|max-lines:1.5'],
  ['text', 'x|type:ring'], ['text', 'x|track-color:red'], ['text', 'x|size:AUTO'], ['text', 'x|color:transparent'],
  ['progress', '1|padding:16'], ['progress', '1|position:center'], ['progress', '1|showvalue:true'],
  ['progress', '1|value:1;max:2'], ['progress', '1|rounded:TRUE'], ['progress', '1|type:bar;type:ring'],
  ['progress', '1|track-color:var(--x)'], ['image', 'x'], ['text', null],
];
for (const [index, [kind, source]] of badCommands.entries()) {
  test(`invalid command case ${index} rejects the whole record`, () => {
    // Arrange
    const input = source;
    // Act
    const result = parseOutputCommand(kind, input);
    // Assert
    assert.equal(result, undefined);
  });
}

test('bar has its own defaults but omitted type and label always reset', () => {
  // Arrange
  const defaults = Object.freeze({ type: 'bar', label: 'old' });
  // Act
  const bar = resolveOutputOptions('progress', { type: 'bar' }, defaults);
  const ring = resolveOutputOptions('progress', {}, defaults);
  // Assert
  assert.deepEqual(bar, { ...ringBase, type: 'bar', scale: 85, thickness: 12 });
  assert.deepEqual(ring, ringBase);
});

// Slice 1: symbolic annotations survive provenance, while resolved options stay opaque.
for (const [overrides, defaults, expected] of [
  [{}, { color: 'blue' }, ['#ffffff', '#ffffff']],
  [{ 'value-color': 'accent' }, { color: 'blue' }, ['#0000ff', '#ffffff']],
  [{ 'label-color': 'accent' }, { color: 'blue' }, ['#ffffff', '#0000ff']],
  [{ 'value-color': 'accent', 'label-color': 'accent' }, { color: 'blue' }, ['#0000ff', '#0000ff']],
  [{ color: 'red', 'value-color': 'accent', 'label-color': 'accent' }, { color: 'blue' }, ['#ff0000', '#ff0000']],
  [{ color: 'red' }, { color: 'blue', 'value-color': 'accent', 'label-color': 'accent' }, ['#ff0000', '#ff0000']],
  [{ 'value-color': 'ivory' }, { color: 'blue', 'value-color': 'accent', 'label-color': 'accent' }, ['#fffff0', '#0000ff']],
  [{ 'value-color': 'accent' }, { color: 'blue', 'value-color': 'red', 'label-color': 'yellow' }, ['#0000ff', '#ffff00']],
]) {
  test(`accent annotation resolution ${JSON.stringify(overrides)} with independent defaults`, () => {
    // Arrange
    const explicit = Object.freeze(overrides), inherited = Object.freeze(defaults);
    // Act
    const result = resolveOutputOptions('progress', explicit, inherited);
    // Assert
    assert.deepEqual([result['value-color'], result['label-color']], expected);
    assert.equal(result['border-color'], '#0000ff');
    assert.ok(Object.isFrozen(result));
  });
}
for (const [kind, key] of [['text', 'color'], ['text', 'background'], ['text', 'border-color'], ['progress', 'color'], ['progress', 'background'], ['progress', 'track-color'], ['progress', 'border-color']]) {
  test(`${kind} ${key} does not accept annotation-only accent`, () => {
    // Arrange
    const source = `payload|${key}:accent`;
    // Act
    const result = parseOutputCommand(kind, source);
    // Assert
    assert.equal(result, undefined);
  });
}
for (const key of ['value-color', 'label-color']) {
  test(`${key} accepts only lowercase symbolic accent and retains it immutably`, () => {
    // Arrange
    const source = `42|${key}:accent`;
    // Act
    const accepted = parseOutputCommand('progress', source);
    const rejected = ['Accent', 'ACCENT', 'theme', ' accent', 'accent '].map(value => parseOutputCommand('progress', `42|${key}:${value}`));
    // Assert
    assert.deepEqual(accepted.overrides, { [key]: 'accent' });
    assert.ok(Object.isFrozen(accepted.overrides));
    assert.deepEqual(rejected, Array(5).fill(undefined));
  });
}

for (const [overrides, defaults, ink] of [
  [{ color: 'red' }, { color: 'blue' }, '#ff0000'],
  [{}, { color: 'blue' }, '#0000ff'],
  [{ color: 'white' }, { color: 'blue' }, '#ffffff'],
  [{}, { color: 'blue', foreground: 'white' }, '#0000ff'],
  [{ color: 'red' }, { color: 'blue', foreground: 'white' }, '#ff0000'],
  [{ color: 'red' }, { foreground: 'theme' }, '#ff0000'],
]) {
  test(`text ink precedence resolves to ${ink}`, () => {
    // Arrange
    const input = Object.freeze(overrides);
    // Act
    const result = resolveOutputOptions('text', input, Object.freeze(defaults));
    // Assert
    assert.equal(result.color, ink);
  });
}
for (const annotation of ['white', 'accent']) {
  test(`progress ${annotation} annotation stays independent of track`, () => {
    // Arrange
    const overrides = { color: 'red', 'track-color': 'blue', 'value-color': annotation, 'label-color': annotation };
    // Act
    const result = resolveOutputOptions('progress', overrides);
    // Assert
    assert.deepEqual([result.color, result['track-color'], result['value-color'], result['label-color']], ['#ff0000', '#0000ff', annotation === 'white' ? '#ffffff' : '#ff0000', annotation === 'white' ? '#ffffff' : '#ff0000']);
  });
}

test('invalid defaults are ignored individually and inherited defaults do not apply', () => {
  // Arrange
  const defaults = Object.assign(Object.create({ weight: 'bold' }), { color: 'blue', font: 'mono', padding: -1, 'font-size': 'bad', foreground: 'bad' });
  // Act
  const result = resolveOutputOptions('text', {}, defaults);
  // Assert
  assert.deepEqual(result, { ...textBase, color: '#0000ff', 'label-color': '#0000ff', 'border-color': '#0000ff', font: 'mono' });
});

// Text inherits the key theme; invalid caller defaults stay forgiving, unlike records.
for (const color of ['transparent', '#fff', 'var(--x)', null, 1]) {
  test('invalid text theme default falls back but explicit invalid color rejects', () => {
    // Arrange
    const defaults = Object.freeze({ color });
    const overrides = Object.freeze({ color });
    // Act
    const inherited = resolveOutputOptions('text', {}, defaults);
    const explicit = resolveOutputOptions('text', overrides);
    // Assert
    assert.deepEqual(inherited, textBase);
    assert.equal(explicit, undefined);
  });
}
test('inherited theme/foreground defaults cannot replace the safe text base', () => {
  // Arrange
  const defaults = Object.create({ color: 'blue', foreground: 'white' });
  // Act
  const result = resolveOutputOptions('text', {}, defaults);
  // Assert
  assert.deepEqual(result, textBase);
});
test('theme and foreground accessors are ignored without execution or mutation', () => {
  // Arrange
  let reads = 0;
  const defaults = Object.freeze({
    get color() { reads++; throw new Error('synthetic'); },
    get foreground() { reads++; throw new Error('synthetic'); },
  });
  const overrides = Object.freeze({});
  // Act
  const result = resolveOutputOptions('text', overrides, defaults);
  // Assert
  assert.deepEqual(result, textBase);
  assert.deepEqual(overrides, {});
  assert.equal(reads, 0);
  assert.ok(Object.isFrozen(result));
});

test('default getters are not called and explicit getters reject safely', () => {
  // Arrange
  let calls = 0;
  const hostile = { get color() { calls += 1; throw new Error('synthetic'); } };
  // Act
  const defaultsResult = resolveOutputOptions('text', {}, hostile);
  const explicitResult = resolveOutputOptions('text', hostile);
  // Assert
  assert.deepEqual([defaultsResult, explicitResult, calls], [textBase, undefined, 0]);
});

test('throwing proxy boundaries produce safe outcomes', () => {
  // Arrange
  const hostile = new Proxy({}, { ownKeys() { throw new Error('synthetic'); }, getOwnPropertyDescriptor() { throw new Error('synthetic'); } });
  // Act
  const explicit = resolveOutputOptions('text', hostile);
  const defaults = resolveOutputOptions('text', {}, hostile);
  // Assert
  assert.deepEqual([explicit, defaults], [undefined, textBase]);
});

for (const overrides of [null, [], { color: 'red', unknown: 'x' }, { [Symbol('synthetic')]: 'x' }]) {
  test('invalid explicit option objects reject without partial application', () => {
    // Arrange
    const input = overrides;
    // Act
    const result = resolveOutputOptions('text', input);
    // Assert
    assert.equal(result, undefined);
  });
}
test('unknown option kind is skipped', () => {
  // Arrange
  const kind = 'image';
  // Act
  const result = resolveOutputOptions(kind);
  // Assert
  assert.equal(result, undefined);
});

test('resolved options are frozen copies isolated from caller mutation', () => {
  // Arrange
  const overrides = { color: 'red' };
  const defaults = { font: 'mono' };
  // Act
  const first = resolveOutputOptions('text', overrides, defaults);
  overrides.color = 'blue';
  defaults.font = 'sans';
  const second = resolveOutputOptions('text', overrides, defaults);
  let rejected = false;
  try { first.color = '#000000'; } catch { rejected = true; }
  // Assert
  assert.deepEqual([first.color, first.font, second.color, second.font, rejected], ['#ff0000', 'mono', '#0000ff', 'sans', true]);
});

// Slice 2: display is bounded literal record content, never a caller preference.
for (const display of ['', '17 done', '{value}:"a,b"', String.raw`a\;b\|c\\d`]) {
  test(`progress literal display grammar ${JSON.stringify(display)}`, () => {
    // Arrange
    const source = `17/1034|display:${display}`;
    const expected = display === String.raw`a\;b\|c\\d` ? String.raw`a;b|c\d` : display;
    // Act
    const parsed = parseOutputCommand('progress', source);
    const resolved = resolveOutputOptions('progress', parsed.overrides, { display: 'old' });
    // Assert
    assert.equal(parsed.overrides.display, expected);
    assert.equal(resolved.display, expected);
    assert.ok(Object.isFrozen(parsed.overrides) && Object.isFrozen(resolved));
  });
}
for (const [index, display] of [undefined, null, 1, false, {}, new String('literal'), 'a\0b', 'x'.repeat(262145), 'é'.repeat(131073)].entries()) {
  test(`invalid explicit display ${index} rejects all sibling styles`, () => {
    // Arrange
    const overrides = { color: 'red', display };
    // Act
    const result = resolveOutputOptions('progress', overrides);
    // Assert
    assert.equal(result, undefined);
  });
}
for (const display of ['x'.repeat(262144), 'é'.repeat(131072)]) {
  test('direct display accepts the exact UTF-8 content limit', () => {
    // Arrange
    const overrides = Object.freeze({ display });
    // Act
    const result = resolveOutputOptions('progress', overrides);
    // Assert
    assert.equal(result.display, display);
  });
}
test('omitted display ignores caller content and its getter without losing valid styles', () => {
  // Arrange
  let reads = 0;
  const defaults = { color: 'blue', get display() { reads++; throw Error('synthetic'); } };
  // Act
  const result = resolveOutputOptions('progress', {}, defaults);
  const explicit = resolveOutputOptions('progress', { get display() { reads++; return 'bad'; } });
  // Assert
  assert.deepEqual([result.display, result.color, explicit, reads], [undefined, '#0000ff', undefined, 0]);
  assert.ok(Object.hasOwn(result, 'display'));
});
for (const [kind, source] of [['text', 'Hi|display:literal'], ['progress', '1/2|display:a;display:b'], ['progress', '1/2|display:unfinished\\']]) {
  test('inapplicable duplicate or dangling display rejects atomically', () => {
    // Arrange
    const input = source;
    // Act
    const result = parseOutputCommand(kind, input);
    // Assert
    assert.equal(result, undefined);
  });
}
