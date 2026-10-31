import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOutputUpdate } from '../src/core/output-update.mjs';
import { createPrimitiveArtwork } from '../src/core/primitive-artwork.mjs';
import { snapshotOutput } from '../src/core/output-frame.mjs';
import { svgElements as elements, assertSvgElement, assertPaddedClip, assertRingSweep } from './helpers/svg-harness.mjs';

// S2: completed progress schema crosses both immutable callback and render boundaries.
const completeProgressStyle = 'color:cyan;background:navy;font:mono;weight:bold;border:16;border-color:lime;type:ring;scale:100;thickness:1;track-color:blue;label:C;display:V;value-position:center;label-position:above;rounded:false;value-size:12;label-size:10;value-color:ivory;label-color:accent;label-weight:normal;label-gap:0.5';

// S2: actual whole-track containment replaces arbitrary scale/thickness policy caps.
for (const [type, scale, thickness, border, rounded, fits] of [
  ['ring', 40, 0.5, 0, true, true], ['ring', 100, 25, 0, false, true],
  ['ring', 100, 69, 0, true, true], ['ring', 100, 70, 0, true, false],
  ['ring', 100.01, 8, 0, true, false], ['ring', 100, 20, 16, true, true],
  ['ring', 100.01, 8, 16, true, false], ['ring', 1, 1, 0, true, false],
  ['bar', 110, 0.5, 0, true, true], ['bar', 125, 25, 0, false, true],
  ['bar', 129, 1, 0, true, false], ['bar', 100, 144, 0, true, true],
  ['bar', 100, 144.01, 0, false, false], ['bar', 5, 100, 0, true, true],
  ['bar', 100, 96, 8, false, true], ['bar', 100, 100, 8, false, false],
  ['bar', 100, 100, 8, true, true], ['bar', 100, 108, 16, true, true],
  ['bar', 100, 108, 16, false, false], ['bar', 100.01, 12, 8, true, false],
  ['bar', 100, 108.01, 16, true, false],
]) test(`S2 whole ${type} track fit ${scale}/${thickness}/${border}/${rounded} => ${fits}`, () => {
  // Arrange - Hide annotations so track-fit failures cannot be mistaken for font fit.
  const record = parseOutputUpdate(`progress:25|type:${type};scale:${scale};thickness:${thickness};border:${border};rounded:${rounded};value-position:none`);
  const before = JSON.stringify(record);
  // Act
  const artwork = createPrimitiveArtwork(record), admitted = snapshotOutput(record);
  // Assert
  assert.ok(record);
  assert.equal(JSON.stringify(record), before);
  if (!fits) { assert.deepEqual([artwork, admitted], [undefined, undefined]); return; }
  assertSnapshotMatches(admitted, record);
  const svg = decode(artwork);
  assert.doesNotMatch(svg, /NaN|Infinity/);
  if (type === 'ring') {
    const track = elements(svg, 'circle').find(circle => circle.stroke === '#333333');
    const diameter = (border ? 124 - border : 144) * scale / 100;
    close(Number(track.r) * 2 + Number(track['stroke-width']), diameter);
    close(elements(svg, 'circle').find(circle => !circle.stroke).r, diameter / 2 - thickness - 2);
    assert.ok(diameter <= (border ? 124 - border : 144));
  } else {
    const track = elements(svg, 'rect').find(rect => rect.fill === '#333333');
    const width = (border ? 124 - border : 112) * scale / 100;
    close(track.width, width); close(track.height, thickness);
    close(track.rx, rounded ? Math.min(width / 2, thickness / 2) : 0);
    const left = Number(track.x), top = Number(track.y), radius = Number(track.rx);
    const right = left + Number(track.width), bottom = top + Number(track.height);
    assert.ok(left >= 0 && top >= 0 && right <= 144 && bottom <= 144);
    // Sample each emitted rounded corner, independently checking the protected-frame equation.
    if (border) for (const [cx, cy, start] of [[right - radius, bottom - radius, 0], [left + radius, bottom - radius, 90], [left + radius, top + radius, 180], [right - radius, top + radius, 270]]) {
      for (let degrees = start; degrees <= start + 90; degrees += 5) {
        const x = cx + radius * Math.cos(degrees * Math.PI / 180), y = cy + radius * Math.sin(degrees * Math.PI / 180);
        assert.ok(x >= 10 + border / 2 - 1e-6 && x <= 134 - border / 2 + 1e-6);
        assert.ok(y >= 10 + border / 2 - 1e-6 && y <= 134 - border / 2 + 1e-6);
        const dx = Math.max(24 - x, x - 120, 0), dy = Math.max(24 - y, y - 120, 0);
        assert.ok(dx * dx + dy * dy <= (14 - border / 2) ** 2 + 1e-6);
      }
    }
  }
});
for (const type of ['ring', 'bar']) for (const key of ['scale', 'thickness', 'value-size', 'label-size', 'label-gap']) for (const extreme of [Number.MIN_VALUE, Number.MAX_VALUE]) {
  test(`S2 bounded extreme ${type}/${key}/${extreme} produces finite SVG or atomic skip`, { timeout: 1000 }, () => {
    // Arrange - Long literal annotations exercise bounded measurement/ellipsis too.
    const record = parseOutputUpdate(`progress:17/1034|type:${type};display:${'M'.repeat(10000)};label:${'W'.repeat(10000)}`, { [key]: extreme });
    // Act
    const artwork = createPrimitiveArtwork(record), admitted = snapshotOutput(record);
    // Assert
    assert.ok(record);
    if (key !== 'label-gap' || extreme === Number.MAX_VALUE) assert.deepEqual([artwork, admitted], [undefined, undefined]);
    else {
      const svg = decode(artwork);
      assert.ok(admitted);
      assert.doesNotMatch(svg, /NaN|Infinity/);
      assert.ok(svg.length < 10000);
      assert.equal(elements(svg, 'text').length, 2);
    }
  });
}
for (const type of ['ring', 'bar']) for (const size of [0.5, 12, 40]) test(`S2 ${type} fixed expanded annotation size ${size} never shrinks`, () => {
  // Arrange - One narrow literal glyph avoids percentage-width constraints.
  const record = parseOutputUpdate(`progress:1|type:${type};scale:100;display:I;value-size:${size}`);
  const label = parseOutputUpdate(`progress:1|type:${type};scale:100;display:;label:I;label-size:${size}`);
  // Act
  const rendered = [record, label].map(item => elements(decode(createPrimitiveArtwork(item)), 'text'));
  // Assert
  assert.deepEqual(rendered.map(texts => texts.map(text => [text.text, Number(text['font-size'])])), [[['I', size]], [['I', size]]]);
});
for (const type of ['ring', 'bar']) for (const position of ['above', 'below']) for (const gap of [100, Number.MAX_VALUE]) {
  test(`S2 impossible ${type} pair ${position} gap ${gap} skips without dropping annotations/resizing`, () => {
    // Arrange
    const record = parseOutputUpdate(`progress:1|type:${type};scale:100;display:V;label:C;label-position:${position}`, { 'label-gap': gap });
    const before = JSON.stringify(record);
    // Act
    const artwork = createPrimitiveArtwork(record), admitted = snapshotOutput(record);
    // Assert
    assert.ok(record);
    assert.deepEqual([artwork, admitted], [undefined, undefined]);
    assert.equal(JSON.stringify(record), before);
  });
}
for (const type of ['ring', 'bar']) test(`S2 ${type} oversized default percentage skips while literal can ellipsize without shrinking`, () => {
  // Arrange
  const wire = `progress:100|type:${type};scale:100;value-size:40`;
  const percentage = parseOutputUpdate(wire), literal = parseOutputUpdate(`${wire};display:100%`);
  // Act
  const rejected = createPrimitiveArtwork(percentage), accepted = createPrimitiveArtwork(literal);
  // Assert
  assert.equal(rejected, undefined);
  const texts = elements(decode(accepted), 'text');
  assert.equal(texts[0]['font-size'], '40');
  assert.ok(texts[0].text.endsWith('…'));
});
for (const type of ['ring', 'bar']) for (const rounded of [true, false]) {
  test(`S2 legacy ${type} tiny positive fill remains accepted even when serialized partial fill is zero/${rounded}`, () => {
    // Arrange - Full track is drawable; only its fractional fill underflows SVG precision.
    const tiny = '0.' + '0'.repeat(306) + '1';
    const record = parseOutputUpdate(`progress:${tiny}|type:${type};rounded:${rounded}`);
    // Act
    const svg = decode(createPrimitiveArtwork(snapshotOutput(record)));
    // Assert
    assert.ok(record.value > 0);
    assert.deepEqual(elements(svg, 'text').map(text => [text.text, text['font-size']]), [['0%', '16']]);
    if (type === 'ring') {
      const fill = elements(svg, 'circle').find(circle => circle.stroke === '#969696');
      assert.equal(fill.r, '53.6');
      assertRingSweep(fill, record.value, rounded);
    } else {
      const track = elements(svg, 'rect').find(rect => rect.fill === '#333333');
      const fill = elements(svg, 'rect').find(rect => rect.fill === '#969696');
      assert.deepEqual([track.width, track.height, fill.width, fill.rx], ['95.2', '12', '0', '0']);
      assert.equal(fill['clip-path'], 'url(#bar-track-clip)');
    }
  });
}
for (const full of [false, true]) test(`S2 complete 21-field progress options with ${full ? 'complete' : 'caller-default'} overrides admit and detach`, () => {
  // Arrange
  const styled = parseOutputUpdate(`progress:17/1034|${completeProgressStyle}`);
  const record = full ? styled : parseOutputUpdate('progress:17/1034|label:C;display:V;label-position:above', styled.options);
  const mutable = { ...record, options: { ...record.options }, overrides: { ...record.overrides } };
  // Act
  const admitted = snapshotOutput(mutable), svg = decode(createPrimitiveArtwork(admitted));
  mutable.options['label-gap'] = 99; mutable.overrides['label-weight'] = 'bold';
  // Assert
  assertSnapshotMatches(admitted, record);
  assert.equal(Object.keys(admitted.options).length, 21);
  if (full) assert.equal(Object.keys(admitted.overrides).length, 21);
  assert.deepEqual(elements(svg, 'text').map(text => [text.text, text['font-size'], text['font-weight'], text.fill]), [['C', '10', 'normal', '#00ffff'], ['V', '12', 'bold', '#fffff0']]);
  assert.equal(elements(svg, 'rect').find(rect => rect.stroke)['stroke-width'], '16');
  close(2 * Number(elements(svg, 'circle').find(circle => circle.stroke).r) + 1, 108);
});
for (const boundary of ['options', 'overrides']) for (const attack of ['substitute', 'extra', 'getter', 'symbol', 'proxy']) {
  test(`S2 complete progress ${boundary} rejects ${attack} without hostile execution`, () => {
    // Arrange
    const record = parseOutputUpdate(`progress:50|${completeProgressStyle}`);
    let calls = 0, data = { ...record[boundary] };
    if (attack === 'substitute') { delete data['label-gap']; data.unknown = 0.5; }
    if (attack === 'extra') data.unknown = 1;
    if (attack === 'symbol') data[Symbol('unknown')] = 1;
    if (attack === 'getter') Object.defineProperty(data, 'label-gap', { enumerable: true, get() { calls++; throw Error('unexpected getter'); } });
    if (attack === 'proxy') data = new Proxy(data, { ownKeys() { calls++; throw Error('unexpected proxy'); } });
    const input = { ...record, [boundary]: data };
    // Act
    const admitted = snapshotOutput(record), rejected = snapshotOutput(input), artwork = createPrimitiveArtwork(input);
    // Assert
    assert.ok(admitted);
    assert.deepEqual([rejected, artwork, calls], [undefined, undefined, 0]);
  });
}
for (const position of ['above', 'below']) for (const [valueSize, labelSize] of [[12, 20], [24, 10], [0.5, 0.75], [36, 12]]) for (const gap of [0, 0.5, 20]) {
  test(`S2 centered ring pair ${position}/${valueSize}/${labelSize}/${gap} centers whole block without shrinking`, () => {
    // Arrange
    const record = parseOutputUpdate(`progress:50|scale:100;label:C;value-size:${valueSize};label-size:${labelSize};label-position:${position};label-gap:${gap};weight:bold;label-weight:normal`);
    // Act
    const texts = elements(decode(createPrimitiveArtwork(record)), 'text');
    // Assert
    assert.deepEqual(texts.map(text => text.text), position === 'above' ? ['C', '50%'] : ['50%', 'C']);
    const value = texts.find(text => text.text === '50%'), label = texts.find(text => text.text === 'C');
    assert.deepEqual([Number(value['font-size']), Number(label['font-size']), value['font-weight'], label['font-weight']], [valueSize, labelSize, 'bold', 'normal']);
    const top = Number(texts[0].y) - Number(texts[0]['font-size']) * 0.8;
    const bottom = Number(texts[1].y) + Number(texts[1]['font-size']) * 0.2;
    close((top + bottom) / 2, 72);
    close(bottom - top, valueSize + labelSize + gap);
    close(Number(texts[1].y) - Number(texts[1]['font-size']) * 0.8 - (Number(texts[0].y) + Number(texts[0]['font-size']) * 0.2), gap);
  });
}
for (const type of ['ring', 'bar']) for (const position of ['above', 'below']) for (const gap of [0, 0.5, 10]) {
  test(`S2 ${type} same-side ${position} stack keeps reference value anchor and exact gap ${gap}`, () => {
    // Arrange
    const wire = `progress:1|type:${type};scale:100;thickness:4;label:C;value-size:12;label-size:10;value-position:${position};label-position:${position}`;
    const reference = parseOutputUpdate(wire), selected = parseOutputUpdate(`${wire};label-gap:${gap}`);
    // Act
    const before = elements(decode(createPrimitiveArtwork(reference)), 'text');
    const artwork = createPrimitiveArtwork(selected);
    // Assert
    // Above-bar stacks already end at the protected track gap: the fixed value
    // anchor cannot accommodate a larger internal gap without crossing the track.
    if (type === 'bar' && position === 'above' && gap > 2) {
      assert.equal(artwork, undefined);
      assert.equal(snapshotOutput(selected), undefined);
      return;
    }
    const after = elements(decode(artwork), 'text');
    assert.deepEqual(after.map(text => text.text), ['1%', 'C']);
    assert.equal(after[0].y, before[0].y);
    close(Number(after[1].y) - Number(before[1].y), gap - 2);
    close(Number(after[1].y) - 8 - (Number(after[0].y) + 2.4), gap);
  });
}
for (const type of ['ring', 'bar']) for (const [valuePosition, labelPosition] of [['above', 'below'], ['below', 'above'], ...(type === 'bar' ? [['center', 'above'], ['center', 'below']] : [])]) for (const gap of [0, 0.5, 30]) {
  test(`S2 ${type} separate ${valuePosition}/${labelPosition} moves only label outward for gap ${gap}`, () => {
    // Arrange
    const wire = `progress:1|type:${type};scale:100;thickness:4;label:C;value-size:12;label-size:10;value-position:${valuePosition};label-position:${labelPosition}`;
    // Act
    const normalSvg = decode(createPrimitiveArtwork(parseOutputUpdate(wire)));
    const selectedSvg = decode(createPrimitiveArtwork(parseOutputUpdate(`${wire};label-gap:${gap}`)));
    const normal = elements(normalSvg, 'text'), selected = elements(selectedSvg, 'text');
    // Assert
    const value = selected.find(text => text.text === '1%'), label = selected.find(text => text.text === 'C');
    const oldValue = normal.find(text => text.text === '1%'), oldLabel = normal.find(text => text.text === 'C');
    assert.equal(value.y, oldValue.y);
    const oldGap = Math.abs((Number(oldValue.y) - 3.6) - (Number(oldLabel.y) - 3)) - 11;
    const movement = Math.max(0, gap - oldGap);
    close(Number(label.y), Number(oldLabel.y) + (labelPosition === 'above' ? -movement : movement));
    assert.deepEqual(elements(selectedSvg, type === 'ring' ? 'circle' : 'rect'), elements(normalSvg, type === 'ring' ? 'circle' : 'rect'));
    if (type === 'bar') {
      if (labelPosition === 'above') assert.ok(Number(label.y) + 2 <= 66 + 1e-6);
      else assert.ok(Number(label.y) - 8 >= 78 - 1e-6);
    }
  });
}
for (const type of ['ring', 'bar']) for (const suffix of ['', ';display:', ';value-position:none;label:C', ';display:;label:C', ';label:   ']) {
  test(`S2 ${type} solo/hidden annotations ignore even overflowing unused gap ${suffix}`, () => {
    // Arrange
    const source = `progress:1|type:${type};scale:100${suffix}`;
    const ordinary = parseOutputUpdate(source), huge = parseOutputUpdate(source, { 'label-gap': Number.MAX_VALUE });
    // Act
    const first = createPrimitiveArtwork(ordinary), second = createPrimitiveArtwork(huge);
    // Assert
    assert.equal(typeof first, 'string');
    assert.equal(second, first);
  });
}
for (const type of ['ring', 'bar']) test(`S2 ${type} label weight changes measurement but never value or track`, () => {
  // Arrange - Five M at size16 fit the default ring allowance only in normal;
  // six at size17 fit the bar's 108-unit allowance only in normal.
  const label = 'M'.repeat(type === 'ring' ? 5 : 6);
  const wire = `progress:1|type:${type};scale:${type === 'ring' ? 80 : 100};label:${label};label-size:${type === 'ring' ? 16 : 17};value-size:16;weight:bold`;
  // Act
  const svgs = ['normal', 'bold'].map(weight => decode(createPrimitiveArtwork(parseOutputUpdate(`${wire};label-weight:${weight}`))));
  const blocks = svgs.map(svg => elements(svg, 'text'));
  // Assert
  assert.equal(blocks[0][1].text, label);
  assert.ok(blocks[1][1].text.endsWith('…'));
  assert.deepEqual(blocks[0][0], blocks[1][0]);
  assert.deepEqual(blocks.map(block => block[1]['font-weight']), ['normal', 'bold']);
  assert.deepEqual(elements(svgs[0], type === 'ring' ? 'circle' : 'rect'), elements(svgs[1], type === 'ring' ? 'circle' : 'rect'));
});

function decode(uri) {
  assert.equal(typeof uri, 'string');
  assert.ok(uri.startsWith('data:image/svg+xml,'));
  return decodeURIComponent(uri.slice('data:image/svg+xml,'.length));
}

test('SVG target inspection accepts reordered attributes but cannot combine attributes from different elements', () => {
  // Arrange
  const valid = `<svg><rect stroke-width='2' fill='none' stroke='#abcdef'/></svg>`;
  const split = `<svg><rect stroke='#abcdef' stroke-width='3'/><rect stroke='#000000' stroke-width='2'/></svg>`;
  // Act
  const inspect = svg => assertSvgElement(svg, 'rect', { stroke: '#abcdef' }, { 'stroke-width': 2 });
  // Assert
  assert.doesNotThrow(() => inspect(valid)); assert.throws(() => inspect(split), assert.AssertionError);
});

for (const defect of ['none', 'missing main reference', 'undefined main clip', 'wrong padded bounds']) {
  test(`main clipping inspection ${defect === 'none' ? 'accepts equivalent IDs/attribute order' : `rejects ${defect} despite clipped side lines`}`, () => {
    // Arrange: header/footer clipping must never stand in for the main element's own reference.
    const reference = defect === 'missing main reference' ? '' : `clip-path='url(#${defect === 'undefined main clip' ? 'missing' : 'padded'})'`;
    const svg = `<svg><defs><clipPath id='padded'><rect height='112' width='${defect === 'wrong padded bounds' ? 111 : 112}' y='16' x='16'/></clipPath></defs><text clip-path='url(#padded)'>H</text><text ${reference}>M</text><text clip-path='url(#padded)'>F</text></svg>`;
    const main = elements(svg, 'text').find(element => element.text === 'M');
    // Act
    const inspect = () => assertPaddedClip(svg, main, { x: 16, y: 16, width: 112, height: 112 });
    // Assert
    if (defect === 'none') assert.doesNotThrow(inspect); else assert.throws(inspect, assert.AssertionError);
  });
}

for (const circle of [
  { r: '10', cx: '72', cy: '72', 'stroke-linecap': 'round', 'stroke-dasharray': '15.707963,47.12389', transform: 'rotate(-90 72 72)' },
  { r: '10', cx: '72', cy: '72', pathLength: '100', 'stroke-linecap': 'round', 'stroke-dasharray': '25 75', transform: 'rotate(270,72,72)' },
  { r: '10', cx: '72', cy: '72', pathLength: '100', 'stroke-linecap': 'round', 'stroke-dasharray': '25 75', 'stroke-dashoffset': '25' },
]) {
  test('ring inspection accepts equivalent calibrated dashes and top-origin forms', () => {
    // Arrange
    const input = circle;
    // Act
    const inspect = () => assertRingSweep(input, 25, true);
    // Assert
    assert.doesNotThrow(inspect);
  });
}
for (const changes of [
  { 'stroke-dasharray': '24.9 75.1' }, { transform: 'rotate(0 72 72)' },
  { transform: 'scale(-1 1)' }, { 'stroke-linecap': 'butt' }, { pathLength: '0' },
]) {
  test('ring inspection rejects wrong fraction, direction/origin, caps or calibration', () => {
    // Arrange
    const circle = { r: '10', cx: '72', cy: '72', pathLength: '100', 'stroke-linecap': 'round',
      'stroke-dasharray': '25 75', transform: 'rotate(-90 72 72)', ...changes };
    // Act
    const inspect = () => assertRingSweep(circle, 25, true);
    // Assert
    assert.throws(inspect, assert.AssertionError);
  });
}

test('ring inspection accepts a full calibrated endpoint but rejects rounded annotation geometry', () => {
  // Arrange
  const full = { r: '10', cx: '72', cy: '72', pathLength: '1', 'stroke-linecap': 'round', 'stroke-dasharray': '1 0' };
  const rounded = { ...full, pathLength: '100', 'stroke-dasharray': '1.6 98.4', transform: 'rotate(270 72 72)' };
  // Act
  const inspectFull = () => assertRingSweep(full, 100, true);
  const inspectRounded = () => assertRingSweep(rounded, 1700 / 1034, true);
  // Assert
  assert.doesNotThrow(inspectFull); assert.throws(inspectRounded, assert.AssertionError);
});

for (const [encoding, dashes] of [
  ['undashed', {}], ['calibrated', { pathLength: '100', 'stroke-dasharray': '100 0' }],
]) {
  for (const transform of [undefined, 'rotate(0 72 72)', 'rotate(45,72,72)', 'rotate(270 72 72)']) {
    test(`full ${encoding} ring accepts center rotation ${transform ?? 'absent'} without requiring a top origin`, () => {
      // Arrange
      const circle = { r: '10', cx: '72', cy: '72', 'stroke-linecap': 'round', ...dashes,
        ...(transform === undefined ? {} : { transform }) };
      // Act
      const inspect = () => assertRingSweep(circle, 100, true);
      // Assert
      assert.doesNotThrow(inspect);
    });
  }
  for (const transform of ['scale(0)', 'translate(1000 1000)']) {
    test(`full ${encoding} ring rejects invisible or displaced geometry from ${transform}`, () => {
      // Arrange: a complete fill must not bypass transform validation.
      const circle = { r: '10', cx: '72', cy: '72', 'stroke-linecap': 'round', ...dashes, transform };
      // Act
      const inspect = () => assertRingSweep(circle, 100, true);
      // Assert
      assert.throws(inspect, assert.AssertionError);
    });
  }
}

// Card v1: observe rendered lines, not private layout helpers or complete SVG snapshots.
test('card header and footer occupy opposite padded edges with independent alignment', () => {
  // Arrange
  const record = parseOutputUpdate('card:UP|header:API;footer:HTTP 200;header-align:left;footer-align:right');
  // Act
  const admitted = snapshotOutput(record);
  const lines = elements(decode(createPrimitiveArtwork(admitted)), 'text');
  // Assert
  assert.deepEqual(lines.map(line => line.text), ['API', 'UP', 'HTTP 200']);
  assert.deepEqual(lines.map(line => line['text-anchor']), ['start', 'middle', 'end']);
  assert.ok(Number(lines[0].x) < Number(lines[1].x) && Number(lines[1].x) < Number(lines[2].x));
  assert.ok(Number(lines[0].y) < Number(lines[1].y) && Number(lines[1].y) < Number(lines[2].y));
  assert.equal(lines[1]['font-size'], '48');
  assert.deepEqual([lines[0]['font-size'], lines[2]['font-size']], ['18', '18']);
});

test('card absent sides reserve no space and all-blank card clears every line', () => {
  // Arrange
  const wires = ['card:UP', 'card:|header:API;footer:HTTP 200', 'card:  |header: ;footer: '];
  // Act
  const lines = wires.map(wire => elements(decode(createPrimitiveArtwork(snapshotOutput(parseOutputUpdate(wire)))), 'text'));
  // Assert
  assert.deepEqual(lines.map(group => group.map(line => line.text)), [['UP'], ['API', 'HTTP 200'], []]);
  close(Number(lines[0][0].y) - Number(lines[0][0]['font-size']) * 0.3, 72);
  assert.deepEqual(lines[1].map(line => line['font-size']), ['18', '18']);
});

// Card layout v2: gaps move the main block, not the edge-anchored side lines.
test('card asymmetric gaps shift the main block while explicit default gaps preserve existing artwork', () => {
  // Arrange
  const wire = 'card:UP|header:API;footer:HTTP 200;font-size:24';
  // Act
  const baseline = createPrimitiveArtwork(snapshotOutput(parseOutputUpdate(wire)));
  const explicit = createPrimitiveArtwork(snapshotOutput(parseOutputUpdate(`${wire};header-gap:8;footer-gap:8;overflow:ellipsis`)));
  const ordinary = elements(decode(baseline), 'text');
  const shifted = elements(decode(createPrimitiveArtwork(snapshotOutput(parseOutputUpdate(`${wire};header-gap:24;footer-gap:4`)))), 'text');
  // Assert
  assert.equal(explicit, baseline);
  assert.deepEqual(shifted.map(line => line.text), ordinary.map(line => line.text));
  assert.deepEqual([shifted[0], shifted[2]], [ordinary[0], ordinary[2]]);
  close(Number(shifted[1].y) - Number(ordinary[1].y), 10);
});

test('card normalized blank sides reserve neither their size nor their configured gap', () => {
  // Arrange
  const wires = ['card:UP|header: ;footer:F', 'card:UP|header:H;footer: '];
  // Act
  const pairs = wires.map((wire, index) => [wire, `${wire};${index === 0 ? 'header' : 'footer'}-gap:1000`]
    .map(source => createPrimitiveArtwork(snapshotOutput(parseOutputUpdate(source)))));
  // Assert
  for (const [ordinary, hugeBlankGap] of pairs) {
    assert.equal(typeof ordinary, 'string');
    assert.equal(hugeBlankGap, ordinary);
  }
});

test('card wrap centers the complete main block between independently spaced single-line sides', () => {
  // Arrange
  const record = parseOutputUpdate(String.raw`card:AAAA BBBB|font:mono;font-size:24;overflow:wrap;header:H\n;footer:F\n;header-gap:12;footer-gap:4`);
  // Act
  const lines = elements(decode(createPrimitiveArtwork(snapshotOutput(record))), 'text');
  const main = lines.slice(1, -1);
  const size = Number(main[0]['font-size']);
  // Assert
  assert.deepEqual(lines.map(line => line.text), [String.raw`H\n`, 'AAAA', 'BBBB', String.raw`F\n`]);
  assert.deepEqual(main.map(line => line['font-size']), ['24', '24']);
  close(Number(main[1].y) - Number(main[0].y), 24 * 1.2);
  const top = 16 + Number(lines[0]['font-size']) + 12;
  const bottom = 144 - 16 - Number(lines.at(-1)['font-size']) - 4;
  close((Number(main[0].y) + Number(main[1].y)) / 2 - size * 0.3, (top + bottom) / 2);
});

test('card wrap keeps wire backslash-n literal in main as well as side content', () => {
  // Arrange
  const record = parseOutputUpdate(String.raw`card:A\nB|overflow:wrap;font-size:16;header:H\n;footer:F\n`);
  // Act
  const lines = elements(decode(createPrimitiveArtwork(snapshotOutput(record))), 'text');
  // Assert
  assert.deepEqual(lines.map(line => line.text), [String.raw`H\n`, String.raw`A\nB`, String.raw`F\n`]);
});

test('card auto wrap prefers a complete single line over a larger wrapped headline', () => {
  // Arrange
  const wire = 'card:Canvas';
  // Act
  const wrapped = elements(decode(createPrimitiveArtwork(snapshotOutput(parseOutputUpdate(`${wire}|overflow:wrap`)))), 'text');
  const single = elements(decode(createPrimitiveArtwork(snapshotOutput(parseOutputUpdate(wire)))), 'text');
  const large = elements(decode(createPrimitiveArtwork(snapshotOutput(parseOutputUpdate(`${wire}|overflow:wrap;font-size:48`)))), 'text');
  // Assert
  assert.deepEqual(wrapped, single);
  assert.equal(wrapped[0].text, 'Canvas');
  assert.ok(Number(wrapped[0]['font-size']) < 48);
  assert.ok(large.length > 1);
});

test('card auto wrap uses multiple complete lines when one cannot fit at minimum font', () => {
  // Arrange
  const wire = 'card:AAAA BBBB CCCC|header:H;footer:F';
  // Act
  const wrapped = elements(decode(createPrimitiveArtwork(snapshotOutput(parseOutputUpdate(`${wire};overflow:wrap`)))), 'text');
  const single = elements(decode(createPrimitiveArtwork(snapshotOutput(parseOutputUpdate(wire)))), 'text');
  const main = wrapped.slice(1, -1);
  const larger = elements(decode(createPrimitiveArtwork(snapshotOutput(parseOutputUpdate(`${wire};overflow:wrap;font-size:${Number(main[0]['font-size']) + 1}`)))), 'text').slice(1, -1);
  // Assert
  assert.ok(main.length > 1);
  assert.equal(main.map(line => line.text).join(' '), 'AAAA BBBB CCCC');
  assert.ok(main.every(line => Number(line['font-size']) >= 16 && Number(line['font-size']) <= 48));
  assert.ok(larger.length > main.length, 'a larger font needs more lines than the selected complete layout');
  assert.ok(single[1].text.endsWith('…'));
  assert.deepEqual([wrapped[0].text, wrapped.at(-1).text], ['H', 'F']);
});

test('card auto and fixed wrap ellipsize only their last available line without dropping sides', () => {
  // Arrange
  const records = ['auto', 24].map(size => parseOutputUpdate(`card:${'AAAA '.repeat(30)}|header:H;footer:F;font-size:${size};overflow:wrap`));
  // Act
  const groups = records.map(record => elements(decode(createPrimitiveArtwork(snapshotOutput(record))), 'text'));
  // Assert
  for (const [index, lines] of groups.entries()) {
    const main = lines.slice(1, -1);
    assert.deepEqual([lines[0].text, lines.at(-1).text], ['H', 'F']);
    assert.equal(main.length, index === 0 ? 3 : 2);
    assert.ok(main.every(line => line['font-size'] === (index === 0 ? '16' : '24')));
    assert.ok(main.slice(0, -1).every(line => !line.text.includes('…')));
    assert.ok(main.at(-1).text.endsWith('…'));
  }
});

test('card wrap retains one clipped main line when the middle cannot fit any line', () => {
  // Arrange
  const record = parseOutputUpdate('card:M|header:H;footer:F;font-size:24;header-size:70;footer-size:70;header-gap:0;footer-gap:0;overflow:wrap');
  // Act
  const rendered = decode(createPrimitiveArtwork(snapshotOutput(record)));
  const lines = elements(rendered, 'text');
  // Assert
  assert.deepEqual(lines.map(line => line.text), ['H', 'M', 'F']);
  assert.equal(lines[1]['font-size'], '24');
  assertPaddedClip(rendered, lines[1], { x: 16, y: 16, width: 112, height: 112 });
});

test('card oversized auto headline falls back to 16 and ellipsizes without losing side lines', () => {
  // Arrange
  const record = parseOutputUpdate(`card:${'W'.repeat(600)}|header:H;footer:F`);
  // Act
  const lines = elements(decode(createPrimitiveArtwork(snapshotOutput(record))), 'text');
  // Assert
  assert.deepEqual([lines[0].text, lines[2].text], ['H', 'F']);
  assert.equal(lines[1]['font-size'], '16');
  assert.ok(lines[1].text.endsWith('…'));
  assert.deepEqual([lines[0]['font-size'], lines[2]['font-size']], ['14', '14']);
});

test('card fixed oversized lines keep requested sizes and content behind the padded clip', () => {
  // Arrange - Intentional overlap is allowed; even an ellipsis cannot fit at these sizes.
  const record = parseOutputUpdate('card:M|font-size:1000;header:H;header-size:1000;footer:F;footer-size:1000');
  // Act
  const rendered = decode(createPrimitiveArtwork(snapshotOutput(record)));
  const lines = elements(rendered, 'text');
  // Assert
  assert.deepEqual(lines.map(line => line.text), ['H', 'M', 'F']);
  assert.deepEqual(lines.map(line => line['font-size']), ['1000', '1000', '1000']);
  for (const line of lines) assertPaddedClip(rendered, line, { x: 16, y: 16, width: 112, height: 112 });
  assert.doesNotMatch(rendered, /NaN|Infinity/);
});

test('card normalizes and escapes literal single-line content without decoding wire hard breaks', () => {
  // Arrange
  const record = parseOutputUpdate(String.raw`card:<&|header:é\n;footer:A` + '\tB');
  // Act
  const lines = elements(decode(createPrimitiveArtwork(snapshotOutput(record))), 'text');
  // Assert
  assert.deepEqual(lines.map(line => line.text), [String.raw`é\n`, '&lt;&amp;', 'A B']);
});

for (const suffix of ['padding-x:72', 'padding-y:72', 'padding-x:71.99999999', 'font-size:0.00000001', 'header:H;header-size:0.00000001']) {
  test(`card nonpositive or unrepresentable geometry is skipped: ${suffix}`, () => {
    // Arrange
    const record = parseOutputUpdate(`card:M|${suffix}`);
    // Act
    const artwork = createPrimitiveArtwork(record), admitted = snapshotOutput(record);
    // Assert
    assert.equal(artwork, undefined);
    assert.equal(admitted, undefined);
  });
}

test('card strict admission rejects unknown fields even below the shared copy ceiling', () => {
  // Arrange
  const record = parseOutputUpdate('card:UP|header:API;footer:HTTP 200;header-gap:0;footer-gap:12.5;overflow:wrap');
  const substituted = { ...record.options }; delete substituted['header-align']; substituted.unknown = 'left';
  // Act
  const valid = snapshotOutput(record);
  const invalid = [{ ...record, options: substituted }, { ...record, overrides: { unknown: 1 } }, { ...record, value: 'bad\0' }].map(snapshotOutput);
  // Assert
  assert.ok(valid);
  assert.deepEqual(invalid, Array(3).fill(undefined));
  assert.match(decode(createPrimitiveArtwork(valid)), />API<\/text>/);
});
function close(actual, expected) {
  assert.ok(Math.abs(Number(actual) - expected) < 0.00001, `expected ${expected}, received ${actual}`);
}
function forge(update, changes = {}, optionChanges = {}) {
  return { ...update, ...changes, options: { ...update.options, ...optionChanges }, overrides: { ...update.overrides } };
}
function assertSnapshotMatches(actual, expected) {
  assert.ok(actual);
  // Compare every field, including undefined values, without prescribing object prototypes.
  assert.deepEqual(
    { ...actual, options: { ...actual.options }, overrides: { ...actual.overrides } },
    { ...expected, options: { ...expected.options }, overrides: { ...expected.overrides } },
  );
  assert.notEqual(actual, expected);
  assert.notEqual(actual.options, expected.options);
  assert.notEqual(actual.overrides, expected.overrides);
  assert.ok(Object.isFrozen(actual) && Object.isFrozen(actual.options) && Object.isFrozen(actual.overrides));
}

// S1: full public text vocabulary must survive both callback and rendering boundaries.
const completeTextStyle = 'color:cyan;background:navy;font:mono;weight:bold;border:16;border-color:lime;font-size:24;valign:bottom;align:left;overflow:ellipsis;padding:0;padding-x:28;padding-y:30;line-height:3;label:C;label-size:12;label-color:ivory;label-position:above;label-weight:normal;label-align:right;label-gap:0.5';
for (const fullOverrides of [false, true]) test(`21-field text styles render with ${fullOverrides ? 'full' : 'default'} provenance`, () => {
  // Arrange
  const styled = parseOutputUpdate(`text:A|${completeTextStyle}`);
  const record = fullOverrides ? styled : parseOutputUpdate('text:A|label:C', styled.options);
  const before = JSON.stringify(record);
  // Act
  const admitted = snapshotOutput(record);
  const svg = decode(createPrimitiveArtwork(admitted));
  const texts = elements(svg, 'text');
  // Assert
  assert.deepEqual(texts.map(text => [text.text, text.x, text['text-anchor'], text['font-weight'], text['font-size'], text.fill]),
    [['C', '116', 'end', 'normal', '12', '#fffff0'], ['A', '28', 'start', 'bold', '24', '#00ffff']]);
  close(Number(texts[1].y) + 24 * 0.2, 114);
  close(Number(texts[1].y) - 24 * 0.8 - (Number(texts[0].y) + 12 * 0.2), 0.5);
  assert.equal(elements(svg, 'rect').find(rect => rect.stroke)['stroke-width'], '16');
  assert.equal(JSON.stringify(record), before);
  assertSnapshotMatches(admitted, record);
  assert.ok(Object.isFrozen(admitted.options) && Object.isFrozen(admitted.overrides));
});
for (const boundary of ['options', 'overrides']) for (const attack of ['substitute', 'extra', 'getter', 'symbol', 'proxy']) {
  test(`complete text ${boundary} rejects ${attack} without evicting valid data`, () => {
    // Arrange
    const record = parseOutputUpdate(`text:A|${completeTextStyle}`);
    let calls = 0;
    let data = { ...record[boundary] };
    if (attack === 'substitute') { delete data['label-gap']; data.unknown = 0.5; }
    if (attack === 'extra') data.unknown = 1;
    if (attack === 'symbol') data[Symbol('unknown')] = 1;
    if (attack === 'getter') Object.defineProperty(data, 'label-gap', { enumerable: true, get() { calls++; throw Error('unexpected getter'); } });
    if (attack === 'proxy') data = new Proxy(data, { ownKeys() { calls++; throw Error('unexpected proxy'); } });
    const input = { ...record, [boundary]: data };
    // Act
    const admitted = snapshotOutput(record), rejected = snapshotOutput(input), artwork = createPrimitiveArtwork(input);
    // Assert
    assert.ok(admitted);
    assert.deepEqual([rejected, artwork, calls], [undefined, undefined, 0]);
  });
}
for (const border of [0, 8, 12.25, 16]) for (const [paddingX, paddingY] of [[0, 30], [30, 0]]) {
  test(`independent axes retain requested provenance and rounded-frame safety ${border}/${paddingX}/${paddingY}`, () => {
    // Arrange
    const record = parseOutputUpdate(`text:A|font-size:12;align:left;valign:top;border:${border};padding:0;padding-x:${paddingX};padding-y:${paddingY}`);
    const before = JSON.stringify(record);
    // Act
    const svg = decode(createPrimitiveArtwork(snapshotOutput(record)));
    const clip = contentRect(svg), text = elements(svg, 'text')[0];
    // Assert
    assert.equal(JSON.stringify(record), before);
    assert.deepEqual([record.options['padding-x'], record.options['padding-y']], [paddingX, paddingY]);
    assert.ok(Number(clip.x) >= paddingX && Number(clip.y) >= paddingY);
    close(Number(clip.x) + Number(clip.width), 144 - Number(clip.x));
    close(Number(clip.y) + Number(clip.height), 144 - Number(clip.y));
    close(text.x, Number(clip.x)); close(Number(text.y) - 9.6, Number(clip.y));
    if (border) assertProtectedBox(Number(clip.x), Number(clip.y), Number(clip.x) + Number(clip.width), Number(clip.y) + Number(clip.height), border);
    else assert.deepEqual([Number(clip.x), Number(clip.y)], [paddingX, paddingY]);
  });
}
test('horizontal padding controls wrapping while vertical padding alone controls hard-line capacity', () => {
  // Arrange
  const widths = [8, 24].map(x => parseOutputUpdate(`text:MMMMMMMMMMMM|font-size:16;padding-x:${x};padding-y:8;line-height:1;valign:top`));
  const heights = [8, 24].map(y => parseOutputUpdate(`text:${Array(10).fill('A').join('\\n')}|font-size:16;padding-x:8;padding-y:${y};line-height:1;valign:top`));
  // Act
  const wrapped = widths.map(record => elements(decode(createPrimitiveArtwork(record)), 'text'));
  const hard = heights.map(record => elements(decode(createPrimitiveArtwork(record)), 'text'));
  // Assert
  assert.deepEqual(wrapped.map(texts => texts[0].text), ['MMMMMMM', 'MMMMM']);
  assert.deepEqual(wrapped.map(texts => texts[0].y), ['20.8', '20.8']);
  assert.deepEqual(hard.map(texts => texts.length), [8, 6]);
  assert.ok(hard.every(texts => texts.at(-1).text.endsWith('…')));
  assert.deepEqual(hard.map(texts => texts[0].x), ['72', '72']);
});
for (const axis of ['padding-x', 'padding-y']) for (const padding of [72, 72.5, Number.MAX_VALUE]) for (const value of ['', 'A']) {
  test(`nonpositive drawable ${axis}:${padding} skips even ${value ? 'visible text' : 'clear'}`, () => {
    // Arrange
    const record = parseOutputUpdate(`text:${value}`, { [axis]: padding });
    // Act
    const artwork = createPrimitiveArtwork(record), admitted = snapshotOutput(record);
    // Assert
    assert.ok(record);
    assert.deepEqual([artwork, admitted], [undefined, undefined]);
  });
}
for (const align of ['left', 'center', 'right']) for (const position of ['above', 'below']) for (const solo of [false, true]) {
  test(`caption ${align}/${position}/${solo ? 'solo' : 'paired'} uses horizontal padded edges, not main alignment`, () => {
    // Arrange
    const record = parseOutputUpdate(`text:${solo ? '' : 'A'}|label:C;font-size:24;label-size:10;align:right;label-align:${align};label-weight:bold;padding-x:25;padding-y:10;label-position:${position};label-gap:0;valign:top`);
    // Act
    const texts = elements(decode(createPrimitiveArtwork(record)), 'text');
    const caption = texts.find(text => text.text === 'C'), headline = texts.find(text => text.text === 'A');
    // Assert
    assert.deepEqual([Number(caption.x), caption['text-anchor'], caption['font-weight']], [align === 'left' ? 25 : align === 'right' ? 119 : 72, align === 'left' ? 'start' : align === 'right' ? 'end' : 'middle', 'bold']);
    if (solo) { assert.equal(texts.length, 1); close(Number(caption.y) - 8, 10); }
    else {
      assert.deepEqual([headline.x, headline['text-anchor'], headline['font-weight']], ['119', 'end', 'normal']);
      assert.deepEqual(texts.map(text => text.text), position === 'above' ? ['C', 'A'] : ['A', 'C']);
      close(Number(texts[1].y) - Number(texts[1]['font-size']) * 0.8 - (Number(texts[0].y) + Number(texts[0]['font-size']) * 0.2), 0);
    }
  });
}
test('independent caption weight affects width fitting as well as emitted SVG weight', () => {
  // Arrange - Seven M glyphs at size16 fit 118 units in normal, but not bold.
  const records = ['normal', 'bold'].map(weight => parseOutputUpdate(`text:A|weight:bold;label:MMMMMMM;label-weight:${weight};font-size:16;label-size:16;padding-x:13`));
  // Act
  const texts = records.map(record => elements(decode(createPrimitiveArtwork(record)), 'text'));
  // Assert
  assert.deepEqual(texts.map(block => block[0]['font-weight']), ['bold', 'bold']);
  assert.deepEqual(texts.map(block => block[1]['font-weight']), ['normal', 'bold']);
  assert.equal(texts[0][1].text, 'MMMMMMM');
  assert.ok(texts[1][1].text.endsWith('…'));
  assert.equal(texts[0][0].text, texts[1][0].text);
});
for (const position of ['above', 'below']) for (const gap of [0, 0.5, 8]) {
  test(`caption ${position} gap ${gap} exact fit preserves both; just-over fit drops only fixed caption`, () => {
    // Arrange - 40 + 20 + gap exactly fills selected vertical span.
    const paddingY = (144 - 60 - gap) / 2;
    const source = `text:A|font-size:40;label:C;label-size:20;label-position:${position};label-gap:${gap};padding-y:${paddingY}`;
    const fixed = parseOutputUpdate(source), overflow = parseOutputUpdate(`${source.replace(`label-gap:${gap}`, `label-gap:${gap + 0.001}`)}`);
    // Act
    const pair = elements(decode(createPrimitiveArtwork(fixed)), 'text');
    const single = elements(decode(createPrimitiveArtwork(overflow)), 'text');
    // Assert
    assert.deepEqual(pair.map(text => text.text), position === 'above' ? ['C', 'A'] : ['A', 'C']);
    close(Number(pair[1].y) - Number(pair[1]['font-size']) * 0.8 - (Number(pair[0].y) + Number(pair[0]['font-size']) * 0.2), gap);
    assert.deepEqual(single.map(text => [text.text, text['font-size']]), [['A', '40']]);
  });
}
for (const suffix of ['', ';label:   ', ';label:C', ';label:C;font-size:24']) {
  test(`huge unused gap is harmless or atomically infeasible in auto pair: ${suffix}`, () => {
    // Arrange
    const record = parseOutputUpdate(`text:A${suffix ? '|' + suffix.slice(1) : ''}`, { 'label-gap': Number.MAX_VALUE });
    // Act
    const artwork = createPrimitiveArtwork(record);
    // Assert
    if (suffix === ';label:C') assert.equal(artwork, undefined);
    else {
      const texts = elements(decode(artwork), 'text');
      assert.deepEqual(texts.map(text => text.text), ['A']);
      assert.equal(texts[0]['font-size'], suffix.endsWith('24') ? '24' : '48');
    }
  });
}
test('caption-only auto18 ignores huge gap and impossible unused headline size', () => {
  // Arrange
  const record = parseOutputUpdate('text:|label:C;label-align:left', { 'label-gap': Number.MAX_VALUE, 'font-size': Number.MAX_VALUE });
  // Act
  const texts = elements(decode(createPrimitiveArtwork(record)), 'text');
  // Assert
  assert.deepEqual(texts.map(text => [text.text, text['font-size'], text.x]), [['C', '18', '16']]);
});
for (const size of [0.000001, 0.5, 12, 64, 128]) {
  test(`fixed main and solo caption size ${size} render without old-range clamping`, () => {
    // Arrange
    const main = parseOutputUpdate('text:A', { 'font-size': size, padding: 0 });
    const caption = parseOutputUpdate('text:|label:C', { 'label-size': size, padding: 0 });
    // Act
    const texts = [main, caption].map(record => elements(decode(createPrimitiveArtwork(record)), 'text'));
    // Assert
    assert.deepEqual(texts.map(block => block.map(text => Number(text['font-size']))), [[size], [size]]);
    assert.ok(texts.every(block => block.length === 1));
  });
}
for (const size of [Number.MIN_VALUE, Number.MAX_VALUE]) for (const caption of [false, true]) {
  test(`unrepresentable ${caption ? 'solo caption' : 'main'} font ${size} skips instead of emitting degenerate geometry`, () => {
    // Arrange
    const record = parseOutputUpdate(caption ? 'text:|label:C' : 'text:A', { [caption ? 'label-size' : 'font-size']: size });
    // Act
    const artwork = createPrimitiveArtwork(record);
    // Assert
    assert.ok(record);
    assert.equal(artwork, undefined);
  });
}
for (const lineHeight of [1, 3, Number.MAX_VALUE]) {
  test(`line-height ${lineHeight} retains fixed size and bounds visible hard lines`, () => {
    // Arrange
    const record = parseOutputUpdate(String.raw`text:A\nB\nC|font-size:16;valign:top`, { 'line-height': lineHeight });
    // Act
    const svg = decode(createPrimitiveArtwork(record)), texts = elements(svg, 'text');
    // Assert
    assert.ok(texts.every(text => text['font-size'] === '16'));
    assert.deepEqual(texts.map(text => text.text), lineHeight === Number.MAX_VALUE ? ['A…'] : ['A', 'B', 'C']);
    assert.doesNotMatch(svg, /NaN|Infinity/);
    if (texts.length > 1) close(Number(texts[1].y) - Number(texts[0].y), 16 * lineHeight);
  });
}
test('tiny representable fonts with large bounded hard-line content never allocate by numeric capacity', { timeout: 1000 }, () => {
  // Arrange
  const record = parseOutputUpdate(`text:${('A\\n').repeat(10000)}late`, { 'font-size': 0.000001 });
  // Act
  const svg = decode(createPrimitiveArtwork(record)), texts = elements(svg, 'text');
  // Assert
  assert.ok(texts.length <= 513);
  assert.ok(svg.length < 200000);
  assert.ok(texts.at(-1).text.endsWith('…'));
  assert.equal(svg.includes('late'), false);
  assert.doesNotMatch(svg, /NaN|Infinity/);
});
for (const type of ['ring', 'bar']) for (const border of [0, 8, 12.25, 16]) {
  test(`shared border ${border} preserves ${type} geometry and full ratio precision`, () => {
    // Arrange
    const record = parseOutputUpdate(`progress:25|type:${type};scale:100;border:${border};value-position:none`);
    // Act
    const svg = decode(createPrimitiveArtwork(snapshotOutput(record)));
    // Assert
    const frame = elements(svg, 'rect').find(rect => rect.stroke);
    assert.equal(frame === undefined, border === 0);
    if (frame) close(frame['stroke-width'], border);
    if (type === 'ring') {
      const circles = elements(svg, 'circle').filter(circle => circle.stroke);
      const span = border ? 124 - border : 144;
      close(2 * Number(circles[0].r) + Number(circles[0]['stroke-width']), span);
      assertRingSweep(circles[1], 25, true);
    } else {
      const rects = elements(svg, 'rect').filter(rect => rect.fill === '#333333' || rect.fill === '#969696');
      close(rects[0].width, border ? 124 - border : 112);
      close(Number(rects[1].width) / Number(rects[0].width), 0.25);
    }
    assert.doesNotMatch(svg, /NaN|Infinity/);
  });
}

// Slice 3: inspect visible logical slots, not private layout helpers or device glyph metrics.
// README Text caption-position: order changes visible slots, never block fitting or main alignment.
for (const position of ['above', 'below']) test(`complete text style vocabulary admits caption ${position} without losing any public style`, () => {
  // Arrange - Exercise complete schema admission, not an incidental field-count assertion.
  const record = parseOutputUpdate(`text:A|color:cyan;background:navy;font:mono;weight:bold;border:2;border-color:lime;font-size:24;valign:bottom;align:left;overflow:ellipsis;padding:24;line-height:1.5;label:C;label-size:14.25;label-color:ivory;label-position:${position}`);
  // Act
  const admitted = snapshotOutput(record), rendered = decode(createPrimitiveArtwork(admitted));
  const texts = elements(rendered, 'text'), headline = texts.find(text => text.text === 'A'), caption = texts.find(text => text.text === 'C');
  // Assert
  assert.deepEqual(texts.map(text => text.text), position === 'above' ? ['C', 'A'] : ['A', 'C']);
  assert.deepEqual([headline.x, headline['text-anchor'], headline['font-size'], headline.fill], ['24', 'start', '24', '#00ffff']);
  assert.deepEqual([caption.x, caption['text-anchor'], caption['font-size'], caption.fill], ['72', 'middle', '14.25', '#fffff0']);
  assert.ok(texts.every(text => text['font-family'] === 'monospace' && text['font-weight'] === 'bold'));
  assert.equal(elements(rendered, 'rect').find(rect => rect.width === '144').fill, '#000080');
  assert.equal(elements(rendered, 'rect').find(rect => rect.stroke).stroke, '#00ff00');
  close(Number(texts.at(-1).y) + Number(texts.at(-1)['font-size']) * 0.2, 120);
  assert.equal(admitted.options['line-height'], 1.5); assert.equal(admitted.options.overflow, 'ellipsis');
  assert.ok(Object.isFrozen(admitted) && Object.isFrozen(admitted.options) && Object.isFrozen(admitted.overrides));
});
for (const boundary of ['options', 'overrides']) for (const kind of ['getter', 'proxy']) test(`caption-position ${boundary} ${kind} is rejected without executing hostile code`, () => {
  // Arrange
  let reads = 0;
  const record = parseOutputUpdate('text:A|label:C;label-position:above');
  const data = { ...record[boundary] };
  const hostile = kind === 'getter' ? Object.defineProperty(data, 'label-position', { enumerable: true, get() { reads++; throw Error('synthetic'); } })
    : new Proxy(data, { ownKeys() { reads++; throw Error('synthetic'); }, getOwnPropertyDescriptor() { reads++; throw Error('synthetic'); } });
  const input = { ...record, [boundary]: hostile };
  // Act
  const admitted = snapshotOutput(input), artwork = createPrimitiveArtwork(input);
  // Assert
  assert.deepEqual([admitted, artwork, reads], [undefined, undefined, 0]);
});
for (const border of [0, 8]) for (const padding of [12, 32]) {
  for (const [mainSize, labelSize] of [[16, 14], [16, 32], [32, 32], [48, 14], [48, 32], [36.25, 14.25], ['auto', 'auto'], ['auto', 32]]) {
    for (const align of ['left', 'center', 'right']) for (const valign of ['top', 'center', 'bottom']) {
      test(`text caption order preserves complete slot bounds ${border}/${padding}/${mainSize}/${labelSize}/${align}/${valign}`, () => {
        // Arrange - Tiny content avoids width constraints; fixed height overflow drops only caption.
        const effective = border ? Math.max(padding, 16.928933) : padding;
        const span = 144 - 2 * effective;
        const main = mainSize === 'auto' ? (labelSize === 32 ? Math.min(48, Math.floor(span - 40)) : 48) : mainSize;
        const caption = labelSize === 'auto' ? Math.max(14, Math.min(18, main / 2)) : labelSize;
        const visibleCaption = main + caption + 8 <= span;
        const height = main + (visibleCaption ? caption + 8 : 0);
        const top = valign === 'top' ? effective : valign === 'bottom' ? 144 - effective - height : (144 - height) / 2;
        const source = `text:A|label:C;font-size:${mainSize};label-size:${labelSize};border:${border};padding:${padding};align:${align};valign:${valign}`;
        const updates = ['above', 'below'].map(position => parseOutputUpdate(`${source};label-position:${position}`));
        const before = updates.map(update => JSON.stringify(update));
        // Act
        const artwork = updates.map(update => createPrimitiveArtwork(snapshotOutput(update)));
        const rendered = artwork.map(decode);
        const blocks = rendered.map(value => elements(value, 'text'));
        // Assert
        for (const [index, texts] of blocks.entries()) {
          const ordered = visibleCaption ? (index === 0 ? [['C', caption], ['A', main]] : [['A', main], ['C', caption]]) : [['A', main]];
          assert.deepEqual(texts.map(text => [text.text, Number(text['font-size'])]), ordered);
          close(Number(texts[0].y) - ordered[0][1] * 0.8, top);
          close(Number(texts.at(-1).y) + ordered.at(-1)[1] * 0.2, top + height);
          if (visibleCaption) close(Number(texts[1].y) - ordered[1][1] * 0.8 - (Number(texts[0].y) + ordered[0][1] * 0.2), 8);
          const headline = texts.find(text => text.text === 'A');
          close(headline.x, align === 'left' ? effective : align === 'right' ? 144 - effective : 72);
          assert.equal(headline['text-anchor'], align === 'left' ? 'start' : align === 'right' ? 'end' : 'middle');
          if (visibleCaption) assert.deepEqual([texts.find(text => text.text === 'C').x, texts.find(text => text.text === 'C')['text-anchor']], ['72', 'middle']);
          assert.ok(texts.every(text => text['clip-path'] === 'url(#content-clip)'));
          const clip = contentRect(rendered[index]); close(clip.x, effective); close(clip.height, span);
          if (border) assertProtectedBox(Number(clip.x), Number(clip.y), Number(clip.x) + Number(clip.width), Number(clip.y) + Number(clip.height), border);
          assert.equal(JSON.stringify(updates[index]), before[index]); assert.equal(createPrimitiveArtwork(updates[index]), artwork[index]);
        }
        if (!visibleCaption) assert.equal(artwork[0], artwork[1]);
      });
    }
  }
}
for (const main of ['', '\t \u200b', String.raw`\n \n\n`]) {
  for (const valign of ['top', 'center', 'bottom']) test(`caption-only order cannot create phantom headline/gap ${JSON.stringify(main)}/${valign}`, () => {
    // Arrange
    const source = `text:${main}|label:C;align:right;valign:${valign};font-size:48;padding:32`;
    const updates = ['above', 'below'].map(position => parseOutputUpdate(`${source};label-position:${position}`));
    // Act
    const artwork = updates.map(createPrimitiveArtwork);
    const texts = elements(decode(artwork[0]), 'text');
    // Assert
    assert.equal(artwork[0], artwork[1]);
    assert.deepEqual(texts.map(text => [text.text, text.x, text['text-anchor'], text['font-size']]), [['C', '72', 'middle', '18']]);
    close(Number(texts[0].y) - 14.4, valign === 'top' ? 32 : valign === 'bottom' ? 94 : 63);
  });
}
for (const label of [undefined, '', '   ', '\t\u200b\u202e']) test(`blank caption order restores ordinary hard-line wrapping ${JSON.stringify(label)}`, () => {
  // Arrange
  const source = String.raw`text:A\nB|font-size:16` + (label === undefined ? '' : `;label:${label}`);
  const clear = String.raw`text:\n \n|background:ivory` + (label === undefined ? '' : `;label:${label}`);
  // Act
  const artwork = ['above', 'below'].map(position => createPrimitiveArtwork(parseOutputUpdate(`${source};label-position:${position}`)));
  const clears = ['above', 'below'].map(position => createPrimitiveArtwork(parseOutputUpdate(`${clear};label-position:${position}`)));
  // Assert
  assert.equal(artwork[0], artwork[1]); assert.deepEqual(elements(decode(artwork[0]), 'text').map(text => text.text), ['A', 'B']);
  assert.equal(clears[0], clears[1]); assert.deepEqual(elements(decode(clears[0]), 'text'), []);
  assert.equal(elements(decode(clears[0]), 'rect').find(rect => rect.width === '144').fill, '#fffff0');
});
for (const position of ['above', 'below']) {
  test(`caption ${position} keeps auto coupled height and long fixed/auto ellipsis bounds`, () => {
    // Arrange
    const source = `text:${'M'.repeat(100)}|label:${'W'.repeat(100)};label-position:${position}`;
    const fixed = parseOutputUpdate(`${source};font-size:48;label-size:32`);
    const auto = parseOutputUpdate(source);
    const coupled = parseOutputUpdate(`text:A|label:C;label-position:${position};label-size:32;padding:32`);
    // Act
    const fixedTexts = elements(decode(createPrimitiveArtwork(fixed)), 'text');
    const autoTexts = elements(decode(createPrimitiveArtwork(auto)), 'text');
    const coupledTexts = elements(decode(createPrimitiveArtwork(coupled)), 'text');
    // Assert
    assert.deepEqual(fixedTexts.map(text => Number(text['font-size'])), position === 'above' ? [32, 48] : [48, 32]);
    assert.deepEqual(autoTexts.map(text => Number(text['font-size'])), position === 'above' ? [14, 16] : [16, 14]);
    assert.ok([...fixedTexts, ...autoTexts].every(text => text.text.endsWith('…')));
    assert.deepEqual(coupledTexts.map(text => [text.text, text['font-size']]), position === 'above' ? [['C', '32'], ['A', '40']] : [['A', '40'], ['C', '32']]);
    close(Number(coupledTexts[0].y) - Number(coupledTexts[0]['font-size']) * 0.8, 32);
    close(Number(coupledTexts[1].y) + Number(coupledTexts[1]['font-size']) * 0.2, 112);
  });
  test(`complete caller-style caption ${position} DTO is admitted without forging explicit provenance`, () => {
    // Arrange - Valid independently supplied low-level defaults remain legal API input.
    const record = parseOutputUpdate('text:A|label:C', { 'label-position': position, 'font-size': 32, 'label-size': 20.5, color: 'blue' });
    // Act
    const admitted = snapshotOutput(record), artwork = createPrimitiveArtwork(admitted);
    // Assert
    assert.equal(admitted.options['label-position'], position); assert.equal(Object.hasOwn(admitted.overrides, 'label-position'), false);
    assert.deepEqual(elements(decode(artwork), 'text').map(text => text.text), position === 'above' ? ['C', 'A'] : ['A', 'C']);
    assert.ok(Object.isFrozen(admitted.options));
  });
}
for (const [index, mutate] of [
  record => { const options = { ...record.options }; delete options['label-position']; return { ...record, options }; },
  record => forge(record, {}, { 'label-position': 'below' }),
  record => forge(record, {}, { 'label-position': 'center' }),
  record => forge(record, {}, { labelPosition: 'above' }),
  record => ({ ...record, overrides: { ...record.overrides, 'label-position': 1 } }),
  record => ({ ...record, options: { ...record.options, get ['label-position']() { throw Error('synthetic'); } } }),
  record => ({ ...record, options: new Proxy(record.options, { ownKeys() { throw Error('synthetic'); } }) }),
  record => forge(record, {}, { 'label-color': 'ivory' }),
  record => ({ ...record, options: { ...record.options, [Symbol('synthetic')]: 'above' } }),
].entries()) test(`caption-position malformed or inconsistent DTO ${index} rejects renderer and callback admission`, () => {
  // Arrange
  const record = parseOutputUpdate('text:A|label:C;label-position:above');
  const input = mutate(record);
  // Act
  const accepted = snapshotOutput(record), rejected = snapshotOutput(input), artwork = createPrimitiveArtwork(input);
  // Assert
  assert.deepEqual([rejected, artwork], [undefined, undefined]); assert.equal(accepted.options['label-position'], 'above');
});
// Slice 4 / README 139–143: hard lines consume slots, including invisible empty lines.
for (const [wire, expected] of [
  [String.raw`A\nB`, ['A', 'B']], [String.raw`\nA`, ['', 'A']],
  [String.raw`A\n`, ['A', '']], [String.raw`A\n\nB`, ['A', '', 'B']],
  [String.raw`\nA\n`, ['', 'A', '']],
  [String.raw`  é  \n <>&"' \n你好😀 `, ['é', '&lt;&gt;&amp;&quot;&apos;', '你好😀']],
]) {
  test('hard lines preserve normalized Unicode and leading trailing consecutive blank slots', () => {
    // Arrange
    const update = parseOutputUpdate(`text:${wire}|font-size:16;valign:top;line-height:1.5`);
    // Act
    const texts = elements(decode(createPrimitiveArtwork(update)), 'text');
    // Assert
    assert.deepEqual(texts.map(text => text.text), expected);
    assert.ok(texts.every(text => text['font-size'] === '16'));
    for (const [index, text] of texts.entries()) close(text.y, 16 + 12.8 + index * 24);
  });
}
test('soft wrapping cannot borrow space across a hard break', () => {
  // Arrange - Two M characters fit each 48-unit row, but the next hard line starts afresh.
  const update = parseOutputUpdate(String.raw`text:MMM\nA|font-size:48;padding:12;line-height:1`);
  const smaller = parseOutputUpdate(String.raw`text:MMM\nA|font-size:16;padding:12;line-height:1`);
  // Act
  const largeTexts = elements(decode(createPrimitiveArtwork(update)), 'text');
  const smallTexts = elements(decode(createPrimitiveArtwork(smaller)), 'text');
  // Assert
  assert.deepEqual(largeTexts.map(text => text.text), ['MM', 'M…']);
  assert.deepEqual(smallTexts.map(text => text.text), ['MMM', 'A']);
});
for (const border of [0, 8]) {
  for (const padding of [12, 32]) {
    for (const lineHeight of [1, 1.2, 2]) {
      for (const size of ['auto', 16, 16.25, 48]) {
        for (const align of ['left', 'center', 'right']) {
          for (const valign of ['top', 'center', 'bottom']) {
            test(`hard-line slot fit ${border}/${padding}/${lineHeight}/${size}/${align}/${valign}`, () => {
              // Arrange - Three required visual rows; A and B cannot set a width constraint.
              const effective = border ? Math.max(padding, 16.928933) : padding;
              const span = 144 - 2 * effective;
              const fittedSize = size === 'auto' ? Math.min(48, Math.floor(span / (1 + 2 * lineHeight))) : size;
              const count = Math.min(3, 1 + Math.floor((span - fittedSize) / (fittedSize * lineHeight)));
              const complete = count === 3;
              const height = fittedSize * (1 + (count - 1) * lineHeight);
              const top = valign === 'top' ? effective : valign === 'bottom' ? 144 - effective - height : (144 - height) / 2;
              const update = parseOutputUpdate(`text:A\\n\\nB|font-size:${size};border:${border};padding:${padding};line-height:${lineHeight};align:${align};valign:${valign}`);
              const before = JSON.stringify(update);
              // Act
              const artwork = createPrimitiveArtwork(update), rendered = decode(artwork);
              const texts = elements(rendered, 'text'), clip = contentRect(rendered);
              // Assert
              if (complete) assert.deepEqual(texts.map(text => text.text), ['A', '', 'B']);
              else {
                assert.equal(texts.length, count);
                assert.deepEqual(texts.slice(0, -1).map(text => text.text), ['A', '', 'B'].slice(0, count - 1));
                assert.ok(texts.at(-1).text.endsWith('…'));
                assert.ok(['A', '', 'B'][count - 1].startsWith(texts.at(-1).text.slice(0, -1)));
              }
              assert.ok(texts.every(text => Number(text['font-size']) === fittedSize));
              for (const [index, text] of texts.entries()) {
                close(text.y, top + fittedSize * 0.8 + index * fittedSize * lineHeight);
                close(text.x, align === 'left' ? effective : align === 'right' ? 144 - effective : 72);
                assert.equal(text['text-anchor'], align === 'left' ? 'start' : align === 'right' ? 'end' : 'middle');
                assert.equal(text['clip-path'], 'url(#content-clip)');
              }
              close(clip.x, effective); close(clip.height, span);
              if (border) assertProtectedBox(Number(clip.x), Number(clip.y), Number(clip.x) + Number(clip.width), Number(clip.y) + Number(clip.height), border);
              assert.equal(JSON.stringify(update), before);
              assert.equal(createPrimitiveArtwork(update), artwork);
            });
          }
        }
      }
    }
  }
}
for (const size of ['auto', 16, 48]) {
  for (const padding of [12, 32]) {
    for (const lineHeight of [1, 2]) {
      test(`hidden blank hard lines force last-visible ellipsis at ${size}/${padding}/${lineHeight}`, () => {
        // Arrange
        const actualSize = size === 'auto' ? 16 : size;
        const count = 1 + Math.floor((144 - padding * 2 - actualSize) / (actualSize * lineHeight));
        const update = parseOutputUpdate(`text:A${String.raw`\n`.repeat(20)}|font-size:${size};padding:${padding};line-height:${lineHeight}`);
        // Act
        const texts = elements(decode(createPrimitiveArtwork(update)), 'text');
        // Assert
        assert.equal(texts.length, count);
        assert.ok(texts.every(text => Number(text['font-size']) === actualSize));
        assert.equal(texts.at(-1).text, count === 1 && (144 - padding * 2) / actualSize - 1.3 >= 0.7 * 1.04 ? 'A…' : '…');
        assert.ok(texts.slice(1, -1).every(text => text.text === ''));
      });
    }
  }
}
for (const suffix of ['overflow:ellipsis', 'label:C;label-size:14', 'label:   ']) {
  test(`hard-break flattening is restricted to caption or ellipsis mode ${suffix}`, () => {
    // Arrange
    const update = parseOutputUpdate(`text:A\\nB|font-size:16;${suffix}`);
    // Act
    const texts = elements(decode(createPrimitiveArtwork(update)), 'text');
    // Assert
    assert.deepEqual(texts.map(text => text.text), suffix === 'label:   ' ? ['A', 'B'] : suffix.startsWith('label:') ? ['A B', 'C'] : ['A B']);
    assert.equal(update.value, 'A\nB');
  });
}
test('ordinary backslash-n stays visibly literal instead of becoming explicit hard lines', () => {
  // Arrange
  const raw = parseOutputUpdate(String.raw`A\nB`);
  const escaped = parseOutputUpdate(String.raw`text:A\\nB|font-size:16`);
  const explicit = parseOutputUpdate(String.raw`text:A\nB|font-size:16`);
  // Act
  const rawTexts = elements(decode(createPrimitiveArtwork(raw)), 'text');
  const escapedTexts = elements(decode(createPrimitiveArtwork(escaped)), 'text');
  const explicitTexts = elements(decode(createPrimitiveArtwork(explicit)), 'text');
  // Assert
  assert.deepEqual(rawTexts.map(text => text.text), [String.raw`A\nB`]);
  assert.deepEqual(escapedTexts.map(text => text.text), [String.raw`A\nB`]);
  assert.deepEqual(explicitTexts.map(text => text.text), ['A', 'B']);
});
for (const type of ['ring', 'bar']) {
  test(`${type} display and label backslash-n remain literal single-line annotations`, () => {
    // Arrange
    const update = parseOutputUpdate(`progress:1/2|type:${type};scale:100;display:A\\n;label:B\\n`);
    // Act
    const texts = elements(decode(createPrimitiveArtwork(update)), 'text');
    // Assert
    assert.deepEqual(texts.map(text => text.text), [String.raw`A\n`, String.raw`B\n`]);
    assert.ok(texts.every(text => text['font-size'] === '16'));
    assert.equal(update.value, 50);
  });
}
test('flattened hard-break headline retains fixed caption-drop policy and never shrinks', () => {
  // Arrange - 48 + 32 + 8 exceeds the 80-unit height, while auto 40 fits both.
  const fixed = parseOutputUpdate(String.raw`text:A\nB|font-size:48;label:C;label-size:32;padding:32`);
  const auto = parseOutputUpdate(String.raw`text:A\nB|label:C;label-size:32;padding:32`);
  // Act
  const fixedTexts = elements(decode(createPrimitiveArtwork(fixed)), 'text');
  const autoTexts = elements(decode(createPrimitiveArtwork(auto)), 'text');
  // Assert
  assert.deepEqual(fixedTexts.map(text => [text.text, text['font-size']]), [['…', '48']]);
  assert.deepEqual(autoTexts.map(text => [text.text, text['font-size']]), [['A B', '40'], ['C', '32']]);
});
for (const size of ['auto', 14.25, 32]) {
  test(`all-blank hard-break content clears or shows only caption ${size} without phantom gap`, () => {
    // Arrange
    const clear = parseOutputUpdate(String.raw`text:\n \n\n|background:ivory`);
    const caption = parseOutputUpdate(`text:\\n \\n\\n|label:C;label-size:${size};valign:bottom`);
    // Act
    const clearSvg = decode(createPrimitiveArtwork(clear));
    const texts = elements(decode(createPrimitiveArtwork(caption)), 'text');
    // Assert
    assert.deepEqual(elements(clearSvg, 'text'), []);
    assert.equal(elements(clearSvg, 'rect').find(rect => rect.width === '144').fill, '#fffff0');
    assert.deepEqual(texts.map(text => [text.text, Number(text['font-size'])]), [['C', size === 'auto' ? 18 : size]]);
    close(Number(texts[0].y) + Number(texts[0]['font-size']) * 0.2, 128);
  });
}
for (const wire of [String.raw`\n`.repeat(512) + 'late', 'A' + String.raw`\n`.repeat(10000) + 'late', ('👩‍💻' + String.raw`\n`).repeat(300), 'A' + String.raw`\n` + 'a' + '\u0301'.repeat(1000)]) {
  test('one global hard-line grapheme budget bounds pathological and repeated-line output and signals loss', () => {
    // Arrange
    const update = parseOutputUpdate(`text:${wire}|font-size:16`);
    // Act
    const rendered = decode(createPrimitiveArtwork(update)), texts = elements(rendered, 'text');
    // Assert
    assert.ok(rendered.length < 10000);
    assert.ok(texts.length <= 6);
    assert.ok(texts.at(-1).text.endsWith('…'));
    assert.equal(texts.some(text => text.text.includes('late')), false);
    assert.ok(texts.every(text => !text.text.includes('\u0301')));
  });
}
for (const changes of [{ hardBreaks: true }, { 'max-lines': 2 }]) {
  test('hard-break rendering cannot admit a new DTO field or bypass its bounded schema', () => {
    // Arrange
    const update = parseOutputUpdate(String.raw`text:A\nB`);
    const input = { ...update, ...changes };
    // Act
    const accepted = snapshotOutput(update), rejected = snapshotOutput(input);
    // Assert
    assert.equal(accepted.value, 'A\nB');
    assert.ok(Object.isFrozen(accepted));
    assert.equal(rejected, undefined);
  });
}
test('caption auto fits the largest complete single-line headline instead of wrapping it', () => {
  // Arrange - Canvas has estimated width 3.63 * size; size 30 fits 112, size 31 does not.
  const record = parseOutputUpdate('text:Canvas|label:Items');
  const fixed = parseOutputUpdate('text:Canvas|label:Items;font-size:48');
  // Act
  const texts = elements(decode(createPrimitiveArtwork(record)), 'text');
  const fixedTexts = elements(decode(createPrimitiveArtwork(fixed)), 'text');
  // Assert
  assert.deepEqual(texts.map(text => [text.text, text['font-size']]), [['Canvas', '30'], ['Items', '15']]);
  assert.equal(fixedTexts.length, 2); assert.equal(fixedTexts[0]['font-size'], '48');
  assert.ok(fixedTexts[0].text.endsWith('…'));
});
test('decoded captioned headline break flattens while caption backslash-n remains literal', () => {
  // Arrange
  const record = parseOutputUpdate(String.raw`text:a\n|font-size:16;label:b\n;label-size:14`);
  // Act
  const texts = elements(decode(createPrimitiveArtwork(record)), 'text');
  // Assert
  assert.deepEqual(texts.map(text => text.text), ['a', String.raw`b\n`]);
});
for (const position of ['above', 'below']) for (const [mainSize, labelSize] of [[16, 14], [16.25, 14], [32, 16], [35, 17.5], [37, 18], [48, 18], ['auto', 18]]) {
  test(`caption ${position} auto size follows fitted headline ${mainSize} with bounded half-size`, () => {
    // Arrange
    const update = parseOutputUpdate(`text:42|font-size:${mainSize};label:Items;label-position:${position}`);
    // Act
    const texts = elements(decode(createPrimitiveArtwork(update)), 'text');
    // Assert
    const ordered = [['42', mainSize === 'auto' ? 48 : mainSize], ['Items', labelSize]];
    assert.deepEqual(texts.map(text => [text.text, Number(text['font-size'])]), position === 'above' ? ordered.reverse() : ordered);
    close(Number(texts[1].y) - Number(texts[1]['font-size']) * 0.8 - (Number(texts[0].y) + Number(texts[0]['font-size']) * 0.2), 8);
  });
}
for (const border of [0, 0.5, 8]) {
  for (const padding of [12, 16.25, 32]) {
    for (const align of ['left', 'center', 'right']) {
      for (const valign of ['top', 'center', 'bottom']) {
        test(`caption block ${border}/${padding}/${align}/${valign} places full fixed slots in corner-safe clip`, () => {
          // Arrange
          const effective = border === 0 ? padding : Math.max(padding, Math.ceil(Math.max(10 + border / 2, 24 - (14 - border / 2) / Math.SQRT2) * 1e6) / 1e6);
          const main = 36.25, caption = 14.25, height = main + caption + 8;
          const top = valign === 'top' ? effective : valign === 'bottom' ? 144 - effective - height : (144 - height) / 2;
          const update = parseOutputUpdate(`text:ON|font-size:${main};label:Yes;label-size:${caption};font:mono;weight:bold;border:${border};padding:${padding};align:${align};valign:${valign}`);
          const before = JSON.stringify(update);
          // Act
          const artwork = createPrimitiveArtwork(update), svg = decode(artwork);
          const texts = elements(svg, 'text'), clip = contentRect(svg);
          // Assert
          assert.equal(createPrimitiveArtwork(update), artwork);
          assert.equal(JSON.stringify(update), before);
          assert.equal(texts.length, 2);
          close(texts[0].x, align === 'left' ? effective : align === 'right' ? 144 - effective : 72);
          assert.equal(texts[0]['text-anchor'], align === 'left' ? 'start' : align === 'right' ? 'end' : 'middle');
          assert.deepEqual([texts[1].x, texts[1]['text-anchor']], ['72', 'middle']);
          close(Number(texts[0].y) - main * 0.8, top);
          close(Number(texts[1].y) + caption * 0.2, top + height);
          close(Number(texts[1].y) - caption * 0.8 - (Number(texts[0].y) + main * 0.2), 8);
          close(clip.x, effective); close(clip.width, 144 - effective * 2);
          for (const text of texts) {
            assert.deepEqual([text['font-family'], text['font-weight'], text['clip-path']], ['monospace', 'bold', 'url(#content-clip)']);
            assert.ok(Number(text.y) - Number(text['font-size']) * 0.8 >= effective - 1e-6);
            assert.ok(Number(text.y) + Number(text['font-size']) * 0.2 <= 144 - effective + 1e-6);
          }
          if (border > 0) assertProtectedBox(Number(clip.x), Number(clip.y), Number(clip.x) + Number(clip.width), Number(clip.y) + Number(clip.height), border);
        });
      }
    }
  }
}
for (const valign of ['top', 'center', 'bottom']) {
  for (const size of ['auto', 14, 20.5, 32]) {
    test(`caption-only ${size}/${valign} has no phantom headline or gap`, () => {
      // Arrange
      const actualSize = size === 'auto' ? 18 : size;
      const top = valign === 'top' ? 32 : valign === 'bottom' ? 112 - actualSize : (144 - actualSize) / 2;
      const update = parseOutputUpdate(`text:\t \u200b|font-size:48;label:Yes;label-size:${size};align:left;valign:${valign};padding:32`);
      // Act
      const texts = elements(decode(createPrimitiveArtwork(update)), 'text');
      // Assert
      assert.deepEqual(texts.map(text => [text.text, text.x, text['text-anchor'], Number(text['font-size'])]), [['Yes', '72', 'middle', actualSize]]);
      close(Number(texts[0].y) - actualSize * 0.8, top);
    });
  }
}
for (const label of ['', '   ', '\t\u200b\u202e']) {
  test('normalized blank captions restore ordinary wrapping and all-blank text clears the background', () => {
    // Arrange
    const ordinary = parseOutputUpdate('text:Canvas|font-size:32');
    const captioned = parseOutputUpdate(`text:Canvas|font-size:32;label:${label}`);
    const blank = parseOutputUpdate(`text: \t|label:${label};background:ivory`);
    // Act
    const normalArtwork = createPrimitiveArtwork(ordinary), captionArtwork = createPrimitiveArtwork(captioned);
    const clear = decode(createPrimitiveArtwork(blank));
    // Assert
    assert.equal(captionArtwork, normalArtwork);
    assert.deepEqual(elements(decode(captionArtwork), 'text').map(text => text.text), ['Canva', 's']);
    assert.deepEqual(elements(clear, 'text'), []);
    assert.equal(elements(clear, 'rect').find(rect => rect.width === '144').fill, '#fffff0');
  });
}
for (const valign of ['top', 'center', 'bottom']) {
  test(`fixed oversized caption block drops only caption and gap at ${valign}, auto fits both`, () => {
    // Arrange - Available span 80; 48 + 32 + 8 exceeds it, 40 + 32 + 8 fits exactly.
    const fixed = parseOutputUpdate(`text:ON|font-size:48;label:Yes;label-size:32;padding:32;valign:${valign};align:right`);
    const auto = parseOutputUpdate(`text:ON|font-size:auto;label:Yes;label-size:32;padding:32;valign:${valign};align:right`);
    const before = JSON.stringify(fixed);
    // Act
    const fixedTexts = elements(decode(createPrimitiveArtwork(fixed)), 'text');
    const autoTexts = elements(decode(createPrimitiveArtwork(auto)), 'text');
    // Assert
    assert.deepEqual(fixedTexts.map(text => [text.text, text['font-size'], text.x]), [['ON', '48', '112']]);
    const top = valign === 'top' ? 32 : valign === 'bottom' ? 64 : 48;
    close(Number(fixedTexts[0].y) - 48 * 0.8, top);
    assert.deepEqual(autoTexts.map(text => [text.text, text['font-size']]), [['ON', '40'], ['Yes', '32']]);
    close(Number(autoTexts[0].y) - 40 * 0.8, 32);
    close(Number(autoTexts[1].y) + 32 * 0.2, 112);
    assert.equal(JSON.stringify(fixed), before);
  });
}
test('caption mode never auto-wraps an oversized fixed headline, but both lines may ellipsize', () => {
  // Arrange
  const update = parseOutputUpdate(`text:${'M'.repeat(100)}|font-size:48;label:${'W'.repeat(100)};label-size:32`);
  const auto = parseOutputUpdate(`text:${'M'.repeat(100)}|label:${'W'.repeat(100)}`);
  // Act
  const fixedTexts = elements(decode(createPrimitiveArtwork(update)), 'text');
  const autoTexts = elements(decode(createPrimitiveArtwork(auto)), 'text');
  // Assert
  assert.deepEqual(fixedTexts.map(text => text['font-size']), ['48', '32']);
  assert.deepEqual(autoTexts.map(text => text['font-size']), ['16', '14']);
  assert.ok([...fixedTexts, ...autoTexts].every(text => text.text.endsWith('…')));
});
for (const [label, expected] of [['<>&"\'', '&lt;&gt;&amp;&quot;&apos;'], ['e\u0301', 'é'], ['你好😀', '你好😀'], ['a\t\u200bb\u202ec', 'a b c'], [String.raw`a\n`, String.raw`a\n`], ['a' + '\u0301'.repeat(1000), '…']]) {
  test('caption normalizes and bounds Unicode while escaping XML and retaining literal backslash-n', () => {
    // Arrange
    const update = parseOutputUpdate(`text:A|font-size:16;label:${label};label-size:14`);
    // Act
    const svg = decode(createPrimitiveArtwork(update)), texts = elements(svg, 'text');
    // Assert
    assert.deepEqual(texts.map(text => text.text), ['A', expected]);
    assert.ok(svg.length < 10000);
  });
}
for (const count of [512, 513]) {
  test(`caption ${count} emoji graphemes remain bounded and unsplit`, () => {
    // Arrange
    const cluster = '👩‍💻';
    const update = parseOutputUpdate(`text:A|label:${cluster.repeat(count)};label-size:32`);
    // Act
    const svg = decode(createPrimitiveArtwork(update)), caption = elements(svg, 'text')[1];
    // Assert
    assert.equal(caption['font-size'], '32');
    assert.ok(caption.text.endsWith('…'));
    assert.equal(caption.text.slice(0, -1).split(cluster).join(''), '');
    assert.ok(svg.length < 10000);
  });
}
for (const [suffix, colors] of [['', ['#0000ff', '#0000ff']], [';color:red', ['#ff0000', '#ff0000']], [';label-color:ivory', ['#0000ff', '#fffff0']], [';color:red;label-color:ivory', ['#ff0000', '#fffff0']]]) {
  test(`caption ink precedence ${suffix || 'implicit'} keeps border independent`, () => {
    // Arrange
    const record = parseOutputUpdate(`text:42|label:Items;border:2${suffix}`, { color: 'blue' });
    // Act
    const svg = decode(createPrimitiveArtwork(snapshotOutput(record)));
    // Assert
    assert.deepEqual(elements(svg, 'text').map(text => text.fill), colors);
    assert.equal(elements(svg, 'rect').find(rect => rect.stroke).stroke, '#0000ff');
  });
}
for (const [index, mutate] of [
  record => ({ ...record, options: { ...record.options, label: 'forged' } }),
  record => { const options = { ...record.options }; delete options.label; return { ...record, options }; },
  record => { const options = { ...record.options }; delete options['label-size']; return { ...record, options }; },
  record => { const options = { ...record.options }; delete options['label-color']; return { ...record, options }; },
  record => forge(record, {}, { 'label-color': 'accent' }),
  record => forge(record, {}, { 'label-size': 0 }),
  record => ({ ...record, overrides: { ...record.overrides, 'label-color': 'blue' } }),
  record => forge(record, {}, { label: 'a\0b' }),
  record => ({ ...record, options: { ...record.options, get label() { throw Error('synthetic'); } } }),
].entries()) {
  test(`caption DTO forgery ${index} cannot replace an admitted frame`, () => {
    // Arrange
    const record = parseOutputUpdate('text:42|label:Items;label-color:ivory');
    const input = mutate(record);
    // Act
    const admitted = snapshotOutput(record), rejected = snapshotOutput(input), artwork = createPrimitiveArtwork(input);
    // Assert
    assert.deepEqual([rejected, artwork], [undefined, undefined]);
    assert.equal(admitted.options.label, 'Items');
    assert.ok(Object.isFrozen(admitted.options));
  });
}

// Slice 1: parser, renderer and callback admission agree on opaque colors and symbolic provenance.
for (const type of ['ring', 'bar']) {
  for (const [suffix, defaults, colors] of [
    ['', { color: 'blue' }, ['#ffffff', '#ffffff']],
    [';value-color:accent', { color: 'blue' }, ['#0000ff', '#ffffff']],
    [';label-color:accent', { color: 'blue' }, ['#ffffff', '#0000ff']],
    [';value-color:accent;label-color:accent', { color: 'blue' }, ['#0000ff', '#0000ff']],
    [';color:red;value-color:accent;label-color:accent', { color: 'blue' }, ['#ff0000', '#ff0000']],
    [';color:red', { color: 'blue', 'value-color': 'accent', 'label-color': 'accent' }, ['#ff0000', '#ff0000']],
    [';value-color:ivory;label-color:accent', { color: 'blue', 'value-color': 'accent', 'label-color': 'yellow' }, ['#fffff0', '#0000ff']],
  ]) {
    test(`${type} SVG renders independent annotations ${suffix || 'omitted'} with theme-owned border`, () => {
      // Arrange
      const update = parseOutputUpdate(`progress:42|type:${type};label:Hi;border:2${suffix}`, defaults);
      const before = JSON.stringify(update);
      // Act
      const admitted = snapshotOutput(update);
      const rendered = decode(createPrimitiveArtwork(admitted));
      const reset = decode(createPrimitiveArtwork(parseOutputUpdate(`progress:42|type:${type};label:Hi`, { color: 'blue' })));
      // Assert
      assert.deepEqual(elements(rendered, 'text').map(text => text.fill), colors);
      assert.equal(elements(rendered, 'rect').find(rect => rect.stroke).stroke, '#0000ff');
      assert.deepEqual(elements(reset, 'text').map(text => text.fill), ['#ffffff', '#ffffff']);
      assert.equal(JSON.stringify(update), before);
      assert.ok(Object.isFrozen(admitted) && Object.isFrozen(admitted.options) && Object.isFrozen(admitted.overrides));
    });
  }
}
for (const changes of [{ 'value-color': 'accent' }, { 'label-color': 'accent' }, { annotationColor: '#ffffff' }, { foreground: 'theme' }, { size: 80 }, { ink: '#ffffff' }]) {
  test(`renderer and snapshot both reject forged obsolete/unresolved progress ${Object.keys(changes)[0]}`, () => {
    // Arrange
    const input = forge(parseOutputUpdate('progress:42|value-color:accent;label-color:accent'), {}, changes);
    // Act
    const artwork = createPrimitiveArtwork(input);
    const admitted = snapshotOutput(input);
    // Assert
    assert.deepEqual([artwork, admitted], [undefined, undefined]);
  });
}

// Independent analytic oracle: the inward stroke edge plus two logical units
// is a rounded rectangle with corner centers (24/120, 24/120).
function assertProtectedBox(left, top, right, bottom, border) {
  const inset = 10 + border / 2;
  const radius = 14 - border / 2;
  assert.ok(left >= inset - 1e-9 && right <= 144 - inset + 1e-9);
  assert.ok(top >= inset - 1e-9 && bottom <= 144 - inset + 1e-9);
  for (const x of [left, right]) {
    for (const y of [top, bottom]) {
      const dx = Math.max(24 - x, x - 120, 0);
      const dy = Math.max(24 - y, y - 120, 0);
      assert.ok(dx * dx + dy * dy <= radius * radius + 1e-9, 'logical box corner must retain the two-unit frame gap');
    }
  }
}

function contentRect(svg) {
  const clip = /<clipPath id="content-clip">([\s\S]*?)<\/clipPath>/.exec(svg);
  assert.ok(clip, 'content must reference a defined clip');
  return elements(clip[1], 'rect')[0];
}

// Corner-safe padding is a rendering policy, not a new protocol/settings field.
for (const [border, minimum] of [[0.5, 14.277282], [3, 15.161166], [8, 16.928933]]) {
  for (const padding of [12, 16, 32]) {
    for (const align of ['left', 'center', 'right']) {
      for (const position of ['top', 'center', 'bottom']) {
        for (const size of ['auto', 16, 32]) {
          for (const overflow of ['wrap', 'ellipsis']) {
            test(`corner-safe text ${border}/${padding}/${align}/${position}/${size}/${overflow} shares fitting and clip bounds`, () => {
              // Arrange - Small requested padding is raised, generous padding is retained.
              const effective = Math.max(padding, minimum);
              const fontSize = size === 'auto' ? 48 : size;
              const update = parseOutputUpdate(`text:Hi|border:${border};padding:${padding};align:${align};valign:${position};font-size:${size};overflow:${overflow}`);
              const before = JSON.stringify(update);
              // Act
              const first = createPrimitiveArtwork(update);
              const second = createPrimitiveArtwork(update);
              const svg = decode(first);
              const clip = contentRect(svg);
              const texts = elements(svg, 'text');
              // Assert
              assert.equal(first, second);
              assert.equal(JSON.stringify(update), before);
              assert.equal(update.options.padding, padding);
              assert.ok(Object.isFrozen(update) && Object.isFrozen(update.options) && Object.isFrozen(update.overrides));
              close(clip.x, effective);
              close(clip.y, effective);
              close(clip.width, 144 - 2 * effective);
              close(clip.height, 144 - 2 * effective);
              assertProtectedBox(Number(clip.x), Number(clip.y), Number(clip.x) + Number(clip.width), Number(clip.y) + Number(clip.height), border);
              assert.equal(texts.length, 1);
              const text = texts[0];
              assert.deepEqual([text.text, Number(text['font-size']), text['text-anchor']], ['Hi', fontSize, align === 'center' ? 'middle' : align === 'left' ? 'start' : 'end']);
              close(text.x, align === 'left' ? effective : align === 'right' ? 144 - effective : 72);
              const top = position === 'top' ? effective : position === 'bottom' ? 144 - effective - fontSize : (144 - fontSize) / 2;
              close(text.y, top + fontSize * 0.8);
              assert.equal(text['clip-path'], 'url(#content-clip)');
            });
          }
        }
      }
    }
  }
}

for (const border of [0.000001, 0.333333, 2.718281, 7.999999]) {
  for (const padding of [12, 16.1234567, 24.1234567, 32]) {
    test(`fractional border ${border} and padding ${padding} serialize inward-safe clip corners`, () => {
      // Arrange - Rounding is checked on emitted coordinates, not private helpers.
      const minimum = Math.ceil(Math.max(10 + border / 2, 24 - (14 - border / 2) / Math.sqrt(2)) * 1e6) / 1e6;
      const expected = Math.max(padding, minimum);
      const update = parseOutputUpdate(`text:Hi|border:${border};padding:${padding};valign:bottom;align:right;font-size:16`);
      // Act
      const svg = decode(createPrimitiveArtwork(update));
      const clip = contentRect(svg);
      const text = elements(svg, 'text')[0];
      // Assert
      close(clip.x, expected);
      close(clip.y, expected);
      close(Number(clip.x) + Number(clip.width), 144 - expected);
      close(Number(clip.y) + Number(clip.height), 144 - expected);
      assertProtectedBox(Number(clip.x), Number(clip.y), Number(clip.x) + Number(clip.width), Number(clip.y) + Number(clip.height), border);
      close(text.x, 144 - expected);
      close(Number(text.y) + 3.2, 144 - expected);
      assert.equal(update.options.padding, padding);
      for (const attribute of ['x', 'y', 'width', 'height']) assert.match(clip[attribute], /^\d+(?:\.\d{1,6})?$/);
    });
  }
}

for (const size of ['auto', 16, 32]) {
  for (const overflow of ['wrap', 'ellipsis']) {
    for (const align of ['left', 'center', 'right']) {
      for (const position of ['top', 'center', 'bottom']) {
        test(`text omitted/zero border remains byte-identical ${size}/${overflow}/${align}/${position}`, () => {
          // Arrange - The corner policy must not leak into unbordered output.
          const source = `text:${'M'.repeat(12)}|padding:12;font-size:${size};overflow:${overflow};align:${align};valign:${position}`;
          const omitted = parseOutputUpdate(source);
          const zero = parseOutputUpdate(`${source};border:0`);
          // Act
          const first = createPrimitiveArtwork(omitted);
          const second = createPrimitiveArtwork(zero);
          const clip = contentRect(decode(first));
          // Assert
          assert.equal(second, first);
          assert.deepEqual([clip.x, clip.y, clip.width, clip.height], ['12', '12', '120', '120']);
        });
      }
    }
  }
}

for (const border of [0.5, 3, 8]) {
  for (const lineHeight of [1, 2]) {
      test(`border ${border} auto fitting uses corner-safe width/height at ${lineHeight}`, () => {
        // Arrange - The border's protected rectangle is geometry, not a font-width estimate.
        const padding = Math.ceil((24 - (14 - border / 2) / Math.sqrt(2)) * 1e6) / 1e6;
        const update = parseOutputUpdate(`text:${'M'.repeat(12)}|font:mono;border:${border};padding:12;line-height:${lineHeight};valign:bottom;align:left`);
        // Act
        const svg = decode(createPrimitiveArtwork(update));
        const texts = elements(svg, 'text');
        const size = Number(texts[0]['font-size']);
        const larger = parseOutputUpdate(`text:${'M'.repeat(12)}|font:mono;font-size:${size + 1};border:${border};padding:12;line-height:${lineHeight}`);
        const largerTexts = elements(decode(createPrimitiveArtwork(larger)), 'text');
        // Assert
        assert.equal(texts.length, 2);
        assert.ok(Number.isInteger(size) && size >= 16 && size <= 48);
        assert.ok(texts.every(text => Number(text['font-size']) === size));
        assert.equal(texts.at(-1).text.endsWith('…'), false);
        assert.equal(texts.map(text => text.text).join(''), 'M'.repeat(12));
        assert.ok(largerTexts.length > texts.length || largerTexts.some(text => text.text.endsWith('…')),
          'the next fixed size cannot keep the same complete fewest-line layout');
        for (const [index, text] of texts.entries()) {
          close(text.x, padding);
          assert.ok(Number(text.y) - size * 0.8 >= padding - 0.000001);
          assert.ok(Number(text.y) + size * 0.2 <= 144 - padding + 0.000001);
          if (index > 0) close(Number(text.y) - Number(texts[index - 1].y), size * lineHeight);
        }
        close(Number(texts.at(-1).y) + size * 0.2, 144 - padding);
      });
  }
}

for (const size of [16, 32]) {
  for (const overflow of ['wrap', 'ellipsis']) {
    test(`corner-safe long fixed text retains ${size}/${overflow} and bounded final ellipsis`, () => {
      // Arrange - Height 110.142134 allows three 16-unit lines, but only two 32-unit lines.
      const update = parseOutputUpdate(`text:${'M'.repeat(100)}|border:8;padding:12;font-size:${size};overflow:${overflow};line-height:2;valign:top`);
      // Act
      const texts = elements(decode(createPrimitiveArtwork(update)), 'text');
      // Assert
      assert.equal(texts.length, overflow === 'ellipsis' ? 1 : size === 16 ? 3 : 2);
      assert.ok(texts.every(text => Number(text['font-size']) === size));
      assert.ok(texts.at(-1).text.endsWith('…'));
      assert.ok(texts.slice(0, -1).every(text => !text.text.includes('…')));
      close(Number(texts[0].y) - size * 0.8, 16.928933);
    });
  }
}

for (const [value, expected] of [['', ''], ['<>&"\'', '&lt;&gt;&amp;&quot;&apos;'], ['e\u0301', 'é'], ['a\t\u200bb\u202ec', 'a b c']]) {
  test(`corner-safe text preserves background and normalization case ${expected.length}`, () => {
    // Arrange
    const update = parseOutputUpdate(`text:${value}|border:8;padding:12;background:ivory;font-size:16`);
    // Act
    const svg = decode(createPrimitiveArtwork(update));
    const clip = contentRect(svg);
    const texts = elements(svg, 'text');
    // Assert
    assert.equal(texts.map(text => text.text).join(''), expected);
    assert.equal(texts.length, expected === '' ? 0 : 1);
    assert.equal(elements(svg, 'rect').find(rect => rect.width === '144').fill, '#fffff0');
    assertProtectedBox(Number(clip.x), Number(clip.y), Number(clip.x) + Number(clip.width), Number(clip.y) + Number(clip.height), 8);
  });
}

for (const count of [512, 513]) {
  test(`corner-safe rendering keeps ${count} grapheme input bounded and unsplit`, () => {
    // Arrange
    const cluster = '👩‍💻';
    const update = parseOutputUpdate(`text:${cluster.repeat(count)}|border:8;padding:12`);
    // Act
    const svg = decode(createPrimitiveArtwork(update));
    const texts = elements(svg, 'text');
    // Assert
    assert.equal(texts.length, 5);
    assert.ok(texts.every(text => text['font-size'] === '16'));
    assert.ok(texts.at(-1).text.endsWith('…'));
    assert.equal(texts.map(text => text.text).join('').replace(/…$/, '').split(cluster).join(''), '');
    assert.ok(svg.length < 10000);
  });
}

for (const changes of [{ padding: -1 }, { padding: Infinity }, { effectivePadding: 17 }, { border: -0.5 }]) {
  test(`corner policy does not admit a forged text option ${Object.keys(changes)[0]}/${Object.values(changes)[0]}`, () => {
    // Arrange - The local layout policy must not expand the public DTO schema/ranges.
    const input = forge(parseOutputUpdate('text:Hi|border:8;padding:12'), {}, changes);
    // Act
    const result = createPrimitiveArtwork(input);
    // Assert
    assert.equal(result, undefined);
  });
}

for (const type of ['bar', 'ring']) {
  for (const border of [0.5, 3, 8]) {
    for (const position of ['above', 'below']) {
      for (const label of ['Hi', 'abcdefghijklmnopqrstuvwxyz']) {
        test(`bordered ${type} ${border}/${position}/${label.length} annotations protect their entire logical slots`, () => {
          // Arrange - Bar paired slots reach y=16/128, including rounded-corner extrema.
          const update = parseOutputUpdate(`progress:1|type:${type};border:${border};scale:100;thickness:${type === 'bar' ? 24 : 4};font:mono;value-size:16;label-size:22;value-position:${position};label-position:${position};label:${label};value-color:yellow;label-color:blue`);
          const before = JSON.stringify(update);
          // Act
          const svg = decode(createPrimitiveArtwork(update));
          const texts = elements(svg, 'text');
          // Assert
          assert.equal(JSON.stringify(update), before);
          assertSnapshotMatches(snapshotOutput(update), update);
          assert.equal(texts.length, 2);
          assert.deepEqual([texts[0].text, texts[0]['font-size'], texts[0].fill], ['1%', '16', '#ffff00']);
          assert.deepEqual([texts[1]['font-size'], texts[1].fill], ['22', '#0000ff']);
          const innerRadius = (124 - border) / 2 - 6;
          for (const [index, text] of texts.entries()) {
            const size = Number(text['font-size']);
            const center = Number(text.y) - 0.3 * size;
            const top = center - size / 2, bottom = center + size / 2;
            const extent = Math.abs(center - 72) + size / 2;
            const allowance = type === 'bar' ? 108 : 2 * Math.sqrt(innerRadius ** 2 - extent ** 2) - 4;
            assertProtectedBox(72 - allowance / 2, top, 72 + allowance / 2, bottom, border);
            if (type === 'ring') assert.ok(extent < innerRadius);
            if (index === 1) {
              if (label === 'Hi') assert.equal(text.text, label);
              else {
                assert.ok(text.text.endsWith('…'));
                assert.ok(label.startsWith(text.text.slice(0, -1)));
                assert.ok(text.text.length < label.length);
              }
            }
            assert.equal(text['clip-path'], 'url(#content-clip)');
          }
          const firstBottom = Number(texts[0].y) + 16 * 0.2;
          const secondTop = Number(texts[1].y) - 22 * 0.8;
          close(secondTop - firstBottom, 2);
          if (type === 'bar') {
            close(position === 'above' ? Number(texts[0].y) - 12.8 : Number(texts[1].y) + 4.4, position === 'above' ? 16 : 128);
            close(elements(svg, 'rect').find(rect => rect.fill === '#333333').width, 124 - border);
          }
        });
      }
    }
  }
}

for (const position of ['above', 'below']) {
  for (const [value, fits] of [['12.34567', true], ['12.345678', true]]) {
    test(`corner-extreme bar ${position} rounds ${value.length} digits without changing fixed slots`, () => {
      // Arrange - Slice 2 rounds the caption; the full percentage still owns fill.
      const update = parseOutputUpdate(`progress:${value}|type:bar;border:8;scale:100;thickness:24;font:mono;value-size:16;label-size:22;value-position:${position};label-position:${position};label:Hi`);
      const before = JSON.stringify(update);
      // Act
      const result = createPrimitiveArtwork(update);
      // Assert
      assert.equal(JSON.stringify(update), before);
      if (!fits) assert.equal(result, undefined);
      else {
        const text = elements(decode(result), 'text')[0];
        assert.deepEqual([text.text, text['font-size']], ['12.3%', '16']);
      }
    });
  }
  test(`corner-extreme bar ${position} rejects vertically infeasible paired annotations`, () => {
    // Arrange - Increasing the label from 22 to 24 pushes the slot beyond y=16/128.
    const update = parseOutputUpdate(`progress:1|type:bar;border:8;scale:100;thickness:24;value-size:16;label-size:24;value-position:${position};label-position:${position};label:Hi`);
    const before = JSON.stringify(update);
    // Act
    const result = createPrimitiveArtwork(update);
    // Assert
    assert.equal(result, undefined);
    assert.equal(JSON.stringify(update), before);
  });
}

// Border geometry is a logical-canvas contract, not measured hardware fit.
for (const type of ['ring', 'bar']) {
  for (const size of [50, undefined, 100]) {
    for (const thickness of type === 'ring' ? [4, 16] : [6, 24]) {
      for (const rounded of [true, false]) {
        for (const value of [0, 25, 100]) {
          test(`${type} omitted and zero border are byte-identical at ${size ?? 'default'}/${thickness}/${rounded}/${value}`, () => {
            // Arrange - Explicit zero must preserve every unbordered SVG byte.
            const source = `progress:${value}|type:${type};thickness:${thickness};rounded:${rounded};value-position:none${size === undefined ? '' : `;scale:${size}`}`;
            const omitted = parseOutputUpdate(source);
            const zero = parseOutputUpdate(`${source};border:0`);
            // Act
            const first = createPrimitiveArtwork(omitted);
            const second = createPrimitiveArtwork(zero);
            // Assert
            assert.equal(second, first);
            const svg = decode(first);
            assert.equal(elements(svg, 'rect').filter(rect => rect.stroke).length, 0);
            const effectiveSize = size ?? (type === 'ring' ? 80 : 85);
            if (type === 'ring') {
              for (const circle of elements(svg, 'circle').filter(circle => circle.stroke)) {
                close(2 * Number(circle.r) + Number(circle['stroke-width']), 144 * effectiveSize / 100);
              }
            } else {
              close(elements(svg, 'rect').find(rect => rect.fill === '#333333').width, 112 * effectiveSize / 100);
            }
          });
        }
      }
    }
  }
}

for (const type of ['ring', 'bar']) {
  for (const border of [0.5, 3, 8]) {
    for (const size of [50, undefined, 100]) {
      for (const rounded of [true, false]) {
        for (const value of [0, 0.01, 25, 100]) {
          test(`${type} bordered ${border}/${size ?? 'default'}/${rounded}/${value} stays inside frame with proportional fill`, () => {
            // Arrange - Check both track and fill, including thick leading caps and endpoints.
            const thickness = type === 'ring' ? 16 : 24;
            const effectiveSize = size ?? (type === 'ring' ? 80 : 85);
            const span = 124 - border;
            const extent = span * effectiveSize / 100;
            const left = (144 - extent) / 2;
            const innerEdge = 8 + border / 2;
            const update = parseOutputUpdate(`progress:${value}|type:${type};border:${border};thickness:${thickness};rounded:${rounded};value-position:none;color:red;track-color:blue;border-color:green;background:ivory${size === undefined ? '' : `;scale:${size}`}`);
            const before = JSON.stringify(update);
            // Act
            const first = createPrimitiveArtwork(update);
            const svg = decode(first);
            const second = createPrimitiveArtwork(update);
            // Assert
            assert.equal(first, second);
            assert.equal(JSON.stringify(update), before);
            assertSnapshotMatches(snapshotOutput(update), update);
            assert.ok(Object.isFrozen(update) && Object.isFrozen(update.options) && Object.isFrozen(update.overrides));
            const frame = elements(svg, 'rect').find(rect => rect.stroke);
            assert.deepEqual([frame.x, frame.y, frame.width, frame.height, frame.rx, frame.fill, frame.stroke], ['8', '8', '128', '128', '16', 'none', '#008000']);
            close(frame['stroke-width'], border);
            assert.equal(elements(svg, 'rect').find(rect => rect.width === '144').fill, '#fffff0');
            close(left - innerEdge, 2 + (span - extent) / 2);
            close(136 - border / 2 - (left + extent), 2 + (span - extent) / 2);
            assert.ok(left >= innerEdge + 2);
            if (type === 'ring') {
              const circles = elements(svg, 'circle').filter(circle => circle.stroke);
              assert.equal(circles.length, value === 0 ? 1 : 2);
              assert.ok(circles.some(circle => circle.stroke === '#0000ff'));
              for (const circle of circles) {
                close(circle.r, (extent - thickness) / 2);
                close(circle['stroke-width'], thickness);
                assert.deepEqual([circle.cx, circle.cy, circle.fill], ['72', '72', 'none']);
                close(72 - Number(circle.r) - thickness / 2, left);
                close(72 + Number(circle.r) + thickness / 2, left + extent);
              }
              close(elements(svg, 'circle').find(circle => !circle.stroke).r, extent / 2 - thickness - 2);
              const fill = circles.find(circle => circle.stroke === '#ff0000');
              if (value === 0) assert.equal(fill, undefined);
              else {
                assertRingSweep(fill, value, rounded);
              }
            } else {
              const rects = elements(svg, 'rect');
              const track = rects.find(rect => rect.fill === '#0000ff');
              close(track.x, left);
              close(track.width, extent);
              close(track.y, 72 - thickness / 2);
              close(track.height, thickness);
              close(track.rx, rounded ? thickness / 2 : 0);
              assert.ok(Number(track.y) >= innerEdge + 2);
              assert.ok(Number(track.y) + thickness <= 136 - border / 2 - 2);
              const fill = rects.find(rect => rect.fill === '#ff0000');
              if (value === 0) assert.equal(fill, undefined);
              else {
                close(fill.x, left);
                close(fill.y, Number(track.y));
                close(fill.height, thickness);
                close(fill.width, extent * value / 100);
                close(fill.rx, rounded ? Math.min(thickness / 2, extent * value / 200) : 0);
                const reference = /^url\(#([^)]*)\)$/.exec(fill['clip-path']);
                const clip = [...svg.matchAll(/<clipPath\b([^>]*)>([\s\S]*?)<\/clipPath>/g)].find(match => /\bid="([^"]*)"/.exec(match[1])?.[1] === reference?.[1]);
                assert.ok(reference && clip, 'fill clips to its own track, never the frame');
                const clipRects = elements(clip[2], 'rect');
                assert.equal(clipRects.length, 1);
                for (const attribute of ['x', 'y', 'width', 'height', 'rx']) close(clipRects[0][attribute], Number(track[attribute]));
                if (rounded && value === 0.01) assert.ok(Number(fill.rx) < Number(clipRects[0].rx));
              }
            }
          });
        }
      }
    }
  }
}

for (const position of ['center', 'above', 'below']) {
  for (const [value, fits] of [['12.34567', true], ['12.345678', true]]) {
    test(`bordered bar ${position} rounded percentage ${value} respects 108-unit annotation limit`, () => {
      // Arrange - Rounded caption fits; this migration does not widen the allowance.
      const update = parseOutputUpdate(`progress:${value}|type:bar;border:3;scale:100;font:mono;value-size:16;value-position:${position}`);
      const before = JSON.stringify(update);
      // Act
      const result = createPrimitiveArtwork(update);
      // Assert
      assert.equal(JSON.stringify(update), before);
      if (!fits) assert.equal(result, undefined);
      else {
        const svg = decode(result);
        const text = elements(svg, 'text')[0];
        assert.deepEqual([text.text, text['font-size']], ['12.3%', '16']);
        close(elements(svg, 'rect').find(rect => rect.fill === '#333333').width, 121);
        assert.ok(elements(svg, 'rect').some(rect => rect.x === '16' && rect.y === '16' && rect.width === '112' && rect.height === '112'));
      }
    });
  }
}

for (const position of ['above', 'below']) {
  for (const [label, expected] of [['Hi', 'Hi'], ['abcdefghijklmnopqrstuvwxyz', 'abcdefgh…']]) {
    test(`bordered bar ${position} label retains fixed size and 108-unit ellipsis for ${label}`, () => {
      // Arrange - The wider bordered track must not widen the existing label allowance.
      const update = parseOutputUpdate(`progress:50|type:bar;border:3;scale:100;font:mono;value-position:none;label-position:${position};label-size:16;label:${label}`);
      // Act
      const text = elements(decode(createPrimitiveArtwork(update)), 'text')[0];
      // Assert
      assert.deepEqual([text.text, text['font-size']], [expected, '16']);
      assert.match(text['clip-path'], /^url\(#[^)]+\)$/);
    });
  }
}

for (const source of [
  'progress:1|scale:50;thickness:16;value-size:16',
  'progress:1|scale:60;thickness:4;value-size:32',
  'progress:1|scale:80;thickness:4;value-position:none;label:Hi;label-size:32',
]) {
  test(`bordered ring rejects newly infeasible annotations without shrinking or mutating ${source}`, () => {
    // Arrange - These annotations fit the old unbordered ring, but not its bordered interior.
    const unbordered = parseOutputUpdate(source);
    const bordered = parseOutputUpdate(`${source};border:8`);
    const before = JSON.stringify(bordered);
    // Act
    const valid = createPrimitiveArtwork(unbordered);
    const rejected = createPrimitiveArtwork(bordered);
    // Assert
    assert.equal(typeof valid, 'string');
    assert.equal(rejected, undefined);
    assert.equal(JSON.stringify(bordered), before);
    assert.equal(snapshotOutput(bordered), undefined);
  });
}

test('removing infeasible bordered-ring annotations renders the requested small geometry unchanged', () => {
  // Arrange
  const update = parseOutputUpdate('progress:1|scale:50;thickness:16;border:8;value-position:none');
  // Act
  const svg = decode(createPrimitiveArtwork(update));
  // Assert
  assert.deepEqual(elements(svg, 'text'), []);
  for (const circle of elements(svg, 'circle').filter(circle => circle.stroke)) {
    close(2 * Number(circle.r) + Number(circle['stroke-width']), 58);
  }
  close(elements(svg, 'circle').find(circle => !circle.stroke).r, 11);
});

for (const [type, valueSize, labelSize] of [['ring', 24, 20.5], ['ring', 32, 32], ['bar', 32, 20.5], ['bar', 16, 32]]) {
  test(`${type} mixed annotation sizes ${valueSize}/${labelSize} retain requested colors and nonoverlapping clipped bounds`, () => {
    // Arrange
    const update = parseOutputUpdate(`progress:45|type:${type};scale:100;label:Hi;value-size:${valueSize};label-size:${labelSize};value-color:yellow;label-color:blue;color:red;track-color:green;font:mono;weight:bold`);
    // Act
    const svg = decode(createPrimitiveArtwork(update));
    const texts = elements(svg, 'text');
    // Assert
    assertSnapshotMatches(snapshotOutput(update), update);
    assert.deepEqual(texts.map(text => [text.text, Number(text['font-size']), text.fill]), [['45%', valueSize, '#ffff00'], ['Hi', labelSize, '#0000ff']]);
    for (const text of texts) {
      assert.deepEqual([text['font-family'], text['font-weight']], ['monospace', 'bold']);
      const size = Number(text['font-size']), center = Number(text.y) - size * 0.3;
      assert.ok(center - size / 2 >= 16 && center + size / 2 <= 128);
      assert.match(text['clip-path'], /^url\(#[^)]+\)$/);
      if (type === 'ring') {
        const clip = elements(svg, 'circle').find(circle => !circle.stroke);
        assert.ok(Math.abs(center - 72) + size / 2 < Number(clip.r));
      }
    }
    const a = Number(texts[0].y) - valueSize * 0.3, b = Number(texts[1].y) - labelSize * 0.3;
    assert.ok(b - labelSize / 2 >= a + valueSize / 2 + 2 - 0.00001);
    if (type === 'ring') {
      const arc = elements(svg, 'circle').find(circle => circle.stroke === '#ff0000');
      close(2 * Number(arc.r) + Number(arc['stroke-width']), 144);
      assert.ok(elements(svg, 'circle').some(circle => circle.stroke === '#008000'));
    }
  });
}
for (const type of ['ring', 'bar']) {
  for (const position of ['above', 'below']) {
    test(`${type} ${position} label-only keeps 32-unit grapheme ellipsis without a hidden percentage`, () => {
      // Arrange
      const cluster = '👩‍💻';
      const update = parseOutputUpdate(`progress:45|type:${type};scale:100;value-position:none;label-position:${position};label:${cluster.repeat(100)};label-size:32;label-color:ivory`);
      // Act
      const texts = elements(decode(createPrimitiveArtwork(update)), 'text');
      // Assert
      assert.equal(texts.length, 1);
      assert.equal(texts[0]['font-size'], '32');
      assert.equal(texts[0].fill, '#fffff0');
      assert.ok(texts[0].text.endsWith('…'));
      assert.equal(texts[0].text.slice(0, -1).split(cluster).join(''), '');
    });
  }
}
test('fractional fixed percentage size rounds its caption without truncation or font shrink', () => {
  // Arrange
  const update = parseOutputUpdate('progress:12.345|type:bar;scale:100;value-size:20.5;value-color:red');
  // Act
  const text = elements(decode(createPrimitiveArtwork(update)), 'text')[0];
  // Assert
  assert.deepEqual([text.text, text['font-size'], text.fill], ['12.3%', '20.5', '#ff0000']);
});
for (const line of ['progress:45|scale:50;thickness:16;value-size:32', 'progress:12.345678901234567|type:bar;value-size:32;font:mono', 'progress:45|scale:50;thickness:16;value-position:none;label:Hi;label-size:32']) {
  test('infeasible fixed annotation skips whole artwork without shrinking glyphs or ring geometry', () => {
    // Arrange
    const update = parseOutputUpdate(line);
    const before = JSON.stringify(update);
    // Act
    const result = createPrimitiveArtwork(update);
    // Assert
    assert.equal(result, undefined);
    assert.equal(JSON.stringify(update), before);
  });
}
for (const changes of [{ 'value-size': 0 }, { 'label-size': 'auto' }, { 'value-color': 'red' }, { 'label-color': 'transparent' }]) {
  test('forged annotation options cannot bypass strict complete DTO validation', () => {
    // Arrange
    const input = forge(parseOutputUpdate('progress:45'), {}, changes);
    // Act
    const result = createPrimitiveArtwork(input);
    // Assert
    assert.equal(result, undefined);
  });
}

test('empty text clears to an opaque logical black canvas without a default border', () => {
  // Arrange
  const update = parseOutputUpdate('text:');
  // Act
  const svg = decode(createPrimitiveArtwork(update));
  // Assert
  assert.match(svg, /viewBox="0 0 144 144"/);
  assert.deepEqual(elements(svg, 'text'), []);
  assert.ok(elements(svg, 'rect').some(rect => rect.width === '144' && rect.height === '144' && rect.fill === '#000000'));
  assert.equal(elements(svg, 'rect').filter(rect => rect.stroke).length, 0);
});

test('optional border uses the approved inset, stroke, radius and accent', () => {
  // Arrange
  const update = parseOutputUpdate('text:|border:3;color:red;border-color:blue');
  // Act
  const svg = decode(createPrimitiveArtwork(update));
  // Assert
  const border = elements(svg, 'rect').find(rect => rect.stroke);
  assert.deepEqual([border.x, border.y, border.width, border.height, border.rx, border['stroke-width'], border.stroke, border.fill], ['8', '8', '128', '128', '16', '3', '#0000ff', 'none']);
});

for (const [source, background, ink] of [
  ['text:Hi|background:ivory;color:black', '#fffff0', '#000000'],
  ['text:Hi|background:white;color:white', '#ffffff', '#ffffff'],
  ['progress:42|background:navy;color:lime;value-color:accent;label-color:accent', '#000080', '#00ff00'],
]) {
  test('primitive background is opaque and never invents automatic contrast', () => {
    // Arrange
    const update = parseOutputUpdate(source);
    // Act
    const svg = decode(createPrimitiveArtwork(update));
    // Assert
    const canvas = elements(svg, 'rect').find(rect => rect.width === '144' && rect.height === '144');
    assert.equal(canvas.fill, background);
    assert.ok(elements(svg, 'text').every(text => text.fill === ink));
  });
}
test('empty text clears to its selected background and optional independent frame', () => {
  // Arrange
  const update = parseOutputUpdate('text:|background:ivory;border:0.5;color:red', { color: 'blue' });
  // Act
  const svg = decode(createPrimitiveArtwork(update));
  // Assert
  assert.equal(elements(svg, 'text').length, 0);
  assert.ok(elements(svg, 'rect').some(rect => rect.width === '144' && rect.fill === '#fffff0'));
  const border = elements(svg, 'rect').find(rect => rect.stroke);
  assert.equal(border.stroke, '#0000ff');
  close(border['stroke-width'], 0.5);
});
for (const width of [0, 0.5, 8]) {
  test(`numeric primitive frame ${width} retains independent color and approved geometry`, () => {
    // Arrange
    const update = parseOutputUpdate(`progress:42|border:${width};border-color:blue;color:red`);
    // Act
    const borders = elements(decode(createPrimitiveArtwork(update)), 'rect').filter(rect => rect.stroke);
    // Assert
    assert.equal(borders.length, width === 0 ? 0 : 1);
    if (width > 0) {
      close(borders[0]['stroke-width'], width);
      assert.deepEqual([borders[0].x, borders[0].y, borders[0].rx, borders[0].stroke], ['8', '8', '16', '#0000ff']);
    }
  });
}
for (const changes of [{ background: 'transparent' }, { background: 'white' }, { 'border-color': 'url(test)' }, { border: true }, { border: 17 }]) {
  test('forged unresolved or unsafe new style DTO cannot reach SVG', () => {
    // Arrange
    const input = forge(parseOutputUpdate('text:Hi'), {}, changes);
    // Act
    const result = createPrimitiveArtwork(input);
    // Assert
    assert.equal(result, undefined);
  });
}

for (const [source, expected] of [
  ['text:<>&"\'|font-size:16', '&lt;&gt;&amp;&quot;&apos;'],
  ['text:e\u0301|font-size:16', 'é'],
  ['text:你好😀|font-size:16', '你好😀'],
  ['text:a\t\u200bb\u202ec|font-size:16', 'a b c'],
  ['text:a\ud800\ufffeb|font-size:16', 'a� �b'.replace(' ', '')],
]) {
  test('text normalizes Unicode and escapes XML without interpreting markup', () => {
    // Arrange
    const update = parseOutputUpdate(source);
    // Act
    const svg = decode(createPrimitiveArtwork(update));
    // Assert
    assert.equal(elements(svg, 'text').map(element => element.text).join(''), expected);
    assert.equal(elements(svg, 'text').length, 1);
  });
}

test('general path text is retained rather than converted to a basename', () => {
  // Arrange
  const update = parseOutputUpdate('text:/a/b.py|font-size:16');
  // Act
  const texts = elements(decode(createPrimitiveArtwork(update)), 'text');
  // Assert
  assert.equal(texts[0].text, '/a/b.py');
});

for (const [suffix, expected] of [
  ['font:mono', '#0000ff'],
  ['color:red', '#ff0000'],
  ['color:white', '#ffffff'],
  ['weight:normal', '#0000ff'],
]) {
  test(`text ink follows explicit/default precedence for ${suffix}`, () => {
    // Arrange
    const update = parseOutputUpdate(`text:Hi|${suffix}`, { color: 'blue' });
    // Act
    const text = elements(decode(createPrimitiveArtwork(update)), 'text')[0];
    // Assert
    assert.equal(text.fill, expected);
  });
}

// Assert emitted glyph fill, not merely resolved options, for omitted text colors.
for (const source of ['Hi', 'text:Hi', 'text:1|font:mono;weight:bold;font-size:auto;background:#090D18;border:3']) {
  for (const [defaults, ink] of [[{}, '#969696'], [{ color: 'blue' }, '#0000ff'], [{ color: 'transparent' }, '#969696'], [{ color: 'blue', foreground: 'white' }, '#0000ff']]) {
    test(`omitted text ink renders ${ink} for ${source}`, () => {
      // Arrange
      const update = parseOutputUpdate(source, Object.freeze(defaults));
      const before = JSON.stringify(update);
      // Act
      const first = createPrimitiveArtwork(update);
      const second = createPrimitiveArtwork(update);
      const svg = decode(first);
      const texts = elements(svg, 'text');
      // Assert
      assert.equal(first, second);
      assert.equal(JSON.stringify(update), before);
      assert.equal(texts.length, 1);
      assert.equal(texts[0].fill, ink);
      assert.equal(Object.hasOwn(update.overrides, 'color'), false);
      assert.equal(Object.hasOwn(update.overrides, 'foreground'), false);
      const canvas = elements(svg, 'rect').find(rect => rect.width === '144');
      assert.equal(canvas.fill, source.includes('background:') ? '#090d18' : '#000000');
      if (source.includes('border:')) {
        const frame = elements(svg, 'rect').find(rect => rect.stroke);
        assert.deepEqual([frame.stroke, frame['stroke-width']], [update.options.color, '3']);
        assert.deepEqual([texts[0].text, texts[0]['font-family'], texts[0]['font-weight'], texts[0]['font-size']], ['1', 'monospace', 'bold', '48']);
      }
    });
  }
}
test('black theme on black background is not automatically contrasted', () => {
  // Arrange
  const update = parseOutputUpdate('Hi', { color: 'black' });
  // Act
  const svg = decode(createPrimitiveArtwork(update));
  // Assert
  assert.equal(elements(svg, 'text')[0].fill, '#000000');
  assert.equal(elements(svg, 'rect').find(rect => rect.width === '144').fill, '#000000');
});
for (const ink of ['#ffffff', '#ff0000']) {
  test('forged ink cannot replace implicit theme provenance at the rendering boundary', () => {
    // Arrange
    const input = forge(parseOutputUpdate('Hi', { color: 'blue' }), {}, { ink });
    // Act
    const result = createPrimitiveArtwork(input);
    // Assert
    assert.equal(result, undefined);
  });
}
for (const type of ['ring', 'bar']) {
  test(`${type} custom-theme fill retains white default percentage and label glyphs`, () => {
    // Arrange
    const update = parseOutputUpdate(`progress:42|type:${type};label:Hi`, { color: 'blue' });
    // Act
    const svg = decode(createPrimitiveArtwork(update));
    const texts = elements(svg, 'text');
    // Assert
    assert.deepEqual(texts.map(text => [text.text, text.fill, text['font-size']]), [['42%', '#ffffff', '16'], ['Hi', '#ffffff', '16']]);
    if (type === 'ring') assert.ok(elements(svg, 'circle').some(circle => circle.stroke === '#0000ff'));
    else assert.ok(elements(svg, 'rect').some(rect => rect.fill === '#0000ff'));
  });
}

for (const [font, family] of [['sans', 'Arial,sans-serif'], ['mono', 'monospace']]) {
  for (const weight of ['normal', 'bold']) {
    test(`text maps ${font}/${weight} to allowlisted font attributes`, () => {
      // Arrange
      const update = parseOutputUpdate(`text:Hi|font:${font};weight:${weight};font-size:20`);
      // Act
      const text = elements(decode(createPrimitiveArtwork(update)), 'text')[0];
      // Assert
      assert.deepEqual([text['font-family'], text['font-weight'], text['font-size']], [family, weight, '20']);
    });
  }
}

for (const [align, x, anchor] of [['left', 24, 'start'], ['center', 72, 'middle'], ['right', 120, 'end']]) {
  for (const position of ['top', 'center', 'bottom']) {
    test(`padded ${position}/${align} placement keeps text within its clip`, () => {
      // Arrange
      const update = parseOutputUpdate(`text:Hi|font-size:20;padding:24;valign:${position};align:${align}`);
      // Act
      const svg = decode(createPrimitiveArtwork(update));
      const text = elements(svg, 'text')[0];
      // Assert
      close(text.x, x);
      assert.equal(text['text-anchor'], anchor);
      const baseline = Number(text.y);
      assert.ok(baseline - 16 >= 24 && baseline + 4 <= 120);
      if (position === 'top') close(baseline - 16, 24);
      if (position === 'center') close(baseline - 6, 72);
      if (position === 'bottom') close(baseline + 4, 120);
      assert.ok(elements(svg, 'rect').some(rect => rect.x === '24' && rect.y === '24' && rect.width === '96' && rect.height === '96'));
      assert.match(text['clip-path'], /^url\(#[^)]+\)$/);
    });
  }
}

test('auto uses the largest allowed size for short complete text', () => {
  // Arrange
  const update = parseOutputUpdate('text:Hi');
  // Act
  const texts = elements(decode(createPrimitiveArtwork(update)), 'text');
  // Assert
  assert.deepEqual(texts.map(text => [text.text, text['font-size']]), [['Hi', '48']]);
});

// Wrapping policy uses the existing estimated widths, not hardware font metrics.
test('default Canvas prefers a complete 26-unit single line over larger wrapped text', () => {
  // Arrange
  const update = parseOutputUpdate('text:Canvas');
  // Act
  const svg = decode(createPrimitiveArtwork(update));
  const texts = elements(svg, 'text');
  // Assert
  assert.deepEqual(texts.map(text => [text.text, text['font-size']]), [['Canvas', '30']]);
  assert.ok(elements(svg, 'rect').some(rect => rect.x === '16' && rect.y === '16' && rect.width === '112' && rect.height === '112'));
});

test('fixed 32-unit Canvas still wraps rather than adopting the auto single-line size', () => {
  // Arrange
  const update = parseOutputUpdate('text:Canvas|font-size:32');
  // Act
  const texts = elements(decode(createPrimitiveArtwork(update)), 'text');
  // Assert
  assert.deepEqual(texts.map(text => [text.text, text['font-size']]), [['Canva', '32'], ['s', '32']]);
});

test('auto chooses the largest complete two-line size when one line cannot fit at minimum size', () => {
  // Arrange
  const content = 'M'.repeat(12);
  const update = parseOutputUpdate(`text:${content}`);
  const larger = parseOutputUpdate(`text:${content}|font-size:22`);
  // Act
  const texts = elements(decode(createPrimitiveArtwork(update)), 'text');
  const largerTexts = elements(decode(createPrimitiveArtwork(larger)), 'text');
  // Assert
  assert.deepEqual(texts.map(text => [text.text, text['font-size']]), [['MMMMMM', '17'], ['MMMMMM', '17']]);
  assert.deepEqual(largerTexts.map(text => [text.text, text['font-size']]), [['MMMM', '22'], ['MMMM', '22'], ['MMMM', '22']]);
  assert.equal(texts.map(text => text.text).join(''), content);
});

for (const padding of [12, 16, 32]) {
  for (const lineHeight of [1, 2]) {
      test(`auto wrapping respects available height, padding ${padding}, and line-height ${lineHeight}`, () => {
        // Arrange - Exercise both complete layouts and minimum-size ellipsis fallback.
        const content = 'M'.repeat(12);
        const size = padding === 12 ? 19 : padding === 16 ? 17 : lineHeight === 1 ? 19 : 16;
        const lineCount = padding === 32 ? 3 : 2;
        const update = parseOutputUpdate(`text:${content}|padding:${padding};line-height:${lineHeight};valign:bottom`);
        // Act
        const svg = decode(createPrimitiveArtwork(update));
        const texts = elements(svg, 'text');
        // Assert
        assert.equal(texts.length, lineCount);
        assert.ok(texts.every(text => Number(text['font-size']) === size));
        assert.equal(texts.at(-1).text.endsWith('…'), false);
        assert.equal(texts.map(text => text.text).join(''), content);
        assert.ok(elements(svg, 'rect').some(rect => Number(rect.x) === padding && Number(rect.y) === padding && Number(rect.width) === 144 - 2 * padding && Number(rect.height) === 144 - 2 * padding));
        for (const [index, text] of texts.entries()) {
          const baseline = Number(text.y);
          assert.ok(baseline - size * 0.8 >= padding - 0.00001);
          assert.ok(baseline + size * 0.2 <= 144 - padding + 0.00001);
          assert.match(text['clip-path'], /^url\(#[^)]+\)$/);
          if (index > 0) close(baseline - Number(texts[index - 1].y), size * lineHeight);
        }
        close(Number(texts.at(-1).y) + size * 0.2, 144 - padding);
      });
  }
}

for (const lineHeight of [1, 1.2, 2]) {
  test(`incomplete auto wrapping fills available height at line-height ${lineHeight}`, () => {
    // Arrange - No complete layout exists even at the minimum font size.
    const update = parseOutputUpdate(`text:${'M'.repeat(100)}|line-height:${lineHeight}`);
    // Act
    const texts = elements(decode(createPrimitiveArtwork(update)), 'text');
    // Assert
    assert.equal(texts.length, 1 + Math.floor((112 - 16) / (16 * lineHeight)));
    assert.ok(texts.every(text => text['font-size'] === '16'));
    assert.ok(texts.at(-1).text.endsWith('…'));
    assert.ok(texts.slice(0, -1).every(text => !text.text.includes('…')));
  });
}

for (const size of ['auto', 32]) {
    test(`ellipsis at size ${size} stays one line`, () => {
      // Arrange - Auto may fit a complete line; fixed size must not shrink.
      const update = parseOutputUpdate(`text:Canvas|overflow:ellipsis;font-size:${size}`);
      // Act
      const texts = elements(decode(createPrimitiveArtwork(update)), 'text');
      // Assert
      assert.deepEqual(texts.map(text => [text.text, text['font-size']]), size === 'auto' ? [['Canvas', '30']] : [['Can…', '32']]);
    });
}

test('incomplete auto ellipsis remains one line at minimum size despite available wrapping space', () => {
  // Arrange
  const update = parseOutputUpdate(`text:${'M'.repeat(100)}|overflow:ellipsis`);
  // Act
  const texts = elements(decode(createPrimitiveArtwork(update)), 'text');
  // Assert
  assert.deepEqual(texts.map(text => [text.text, text['font-size']]), [['MMMMM…', '16']]);
});

for (const size of ['auto', 16]) {
  test(`wrapping at size ${size} can display five complete lines without a line-count option`, () => {
    // Arrange
    const content = 'M'.repeat(50);
    const update = parseOutputUpdate(`text:${content}|font:mono;font-size:${size}`);
    // Act
    const texts = elements(decode(createPrimitiveArtwork(update)), 'text');
    // Assert
    assert.equal(texts.length, 5);
    assert.equal(texts.map(text => text.text).join(''), content);
    assert.ok(texts.every(text => text['font-size'] === '16'));
  });
}

for (const [source, expected] of [
  ['text:<>&"\'', '&lt;&gt;&amp;&quot;&apos;'],
  ['text:e\u0301', 'é'],
  ['text:你好😀', '你好😀'],
  ['text:a\t\u200bb\u202ec', 'a b c'],
  ['text:a\ud800\ufffeb', 'a��b'],
]) {
  test('auto fewer-line fitting preserves normalization and literal XML-safe Unicode', () => {
    // Arrange
    const update = parseOutputUpdate(source);
    // Act
    const texts = elements(decode(createPrimitiveArtwork(update)), 'text');
    // Assert
    assert.equal(texts.length, 1);
    assert.equal(texts[0].text, expected);
    assert.ok(Number(texts[0]['font-size']) >= 16 && Number(texts[0]['font-size']) <= 48);
  });
}

for (const count of [512, 513]) {
  test(`auto wrapping remains grapheme-safe and bounded at ${count} input clusters`, () => {
    // Arrange
    const cluster = '👩‍💻';
    const update = parseOutputUpdate(`text:${cluster.repeat(count)}`);
    // Act
    const svg = decode(createPrimitiveArtwork(update));
    const texts = elements(svg, 'text');
    // Assert
    assert.equal(texts.length, 6);
    assert.ok(texts.every(text => text['font-size'] === '16'));
    assert.ok(texts.at(-1).text.endsWith('…'));
    assert.equal(texts.map(text => text.text).join('').replace(/…$/, '').split(cluster).join(''), '');
    assert.ok(svg.length < 10000);
  });
}

test('auto reduces font to fit complete text but remains in the approved range', () => {
  // Arrange
  const update = parseOutputUpdate('text:MMMMM|overflow:ellipsis');
  // Act
  const texts = elements(decode(createPrimitiveArtwork(update)), 'text');
  // Assert
  assert.equal(texts[0].text, 'MMMMM');
  assert.ok(Number(texts[0]['font-size']) >= 16 && Number(texts[0]['font-size']) < 32);
});

for (const size of [16, 32]) {
  test(`long fixed text preserves size ${size} and clips its final line`, () => {
    // Arrange
    const update = parseOutputUpdate(`text:${'longword'.repeat(100)}|font-size:${size}`);
    // Act
    const texts = elements(decode(createPrimitiveArtwork(update)), 'text');
    // Assert
    assert.equal(texts.length, size === 16 ? 6 : 3);
    assert.ok(texts.every(text => Number(text['font-size']) === size));
    assert.ok(texts.at(-1).text.endsWith('…'));
  });
}

test('ordinary text uses longer lines while preserving words', () => {
  // Arrange
  const update = parseOutputUpdate('text:Big ideas start again|font-size:16;valign:top;align:left');
  // Act
  const texts = elements(decode(createPrimitiveArtwork(update)), 'text');
  // Assert
  assert.deepEqual(texts.map(text => text.text), ['Big ideas start', 'again']);
  assert.ok(texts.every(text => text['font-size'] === '16'));
});

test('word wrapping preserves complete words and line-height spacing', () => {
  // Arrange
  const update = parseOutputUpdate('text:one two three four five|font-size:16;line-height:1.5');
  // Act
  const texts = elements(decode(createPrimitiveArtwork(update)), 'text');
  // Assert
  assert.deepEqual(texts.map(text => text.text), ['one two three', 'four five']);
  close(Number(texts[1].y) - Number(texts[0].y), 24);
});

test('long words wrap without losing content when the complete word fits the line budget', () => {
  // Arrange
  const content = 'abcdefghijk';
  const update = parseOutputUpdate(`text:${content}|font-size:16;font:mono`);
  // Act
  const texts = elements(decode(createPrimitiveArtwork(update)), 'text');
  // Assert
  assert.ok(texts.length > 1);
  assert.equal(texts.map(text => text.text).join(''), content);
});

test('single-line ellipsis never splits emoji graphemes', () => {
  // Arrange
  const cluster = '👨‍👩‍👧‍👦';
  const update = parseOutputUpdate(`text:${cluster.repeat(50)}|font-size:16;overflow:ellipsis`);
  // Act
  const texts = elements(decode(createPrimitiveArtwork(update)), 'text');
  // Assert
  assert.equal(texts.length, 1);
  assert.ok(texts[0].text.endsWith('…'));
  assert.equal(texts[0].text.slice(0, -1).split(cluster).join(''), '');
});

test('extreme valid padding and line height reduce lines without shrinking fixed font', () => {
  // Arrange
  const update = parseOutputUpdate(`text:${'word '.repeat(100)}|font-size:32;padding:32;line-height:2;valign:bottom`);
  // Act
  const texts = elements(decode(createPrimitiveArtwork(update)), 'text');
  // Assert
  assert.equal(texts.length, 1);
  assert.equal(texts[0]['font-size'], '32');
  assert.ok(texts[0].text.endsWith('…'));
  close(Number(texts[0].y) + 6.4, 112);
});

test('long auto content reaches minimum size with a bounded ellipsis result', () => {
  // Arrange
  const update = parseOutputUpdate(`text:${'😀'.repeat(1000)}`);
  // Act
  const svg = decode(createPrimitiveArtwork(update));
  const texts = elements(svg, 'text');
  // Assert
  assert.ok(texts.every(text => text['font-size'] === '16'));
  assert.equal(texts.length, 6);
  assert.ok(texts.at(-1).text.endsWith('…'));
  assert.ok([...texts.map(text => text.text).join('')].length <= 512);
  assert.ok(svg.length < 10000);
});

test('pathological combining cluster yields bounded visible ellipsis', () => {
  // Arrange
  const update = parseOutputUpdate(`text:a${'\u0301'.repeat(1000)}`);
  // Act
  const texts = elements(decode(createPrimitiveArtwork(update)), 'text');
  // Assert
  assert.deepEqual(texts.map(text => text.text), ['…']);
});

for (const [size, thickness] of [[80, 8], [50, 16], [100, 4]]) {
  test(`ring outer diameter includes stroke at size ${size} thickness ${thickness}`, () => {
    // Arrange
    const update = parseOutputUpdate(`progress:25|scale:${size};thickness:${thickness};value-position:none`);
    // Act
    const circles = elements(decode(createPrimitiveArtwork(update)), 'circle').filter(circle => circle.stroke);
    // Assert
    assert.equal(circles.length, 2);
    for (const circle of circles) {
      close(Number(circle.r) * 2 + Number(circle['stroke-width']), 144 * size / 100);
      assert.deepEqual([circle.cx, circle.cy, circle.fill], ['72', '72', 'none']);
    }
    const fill = circles.find(circle => circle.stroke === '#969696');
    assertRingSweep(fill, 25, true);
  });
}

for (const [value, size, thickness, rounded] of [[1, 50, 16, true], [45, 80, 8, false], [99, 100, 4, true]]) {
  test(`partial ring ${value}% preserves its top-origin clockwise fraction and caps`, () => {
    // Arrange
    const update = parseOutputUpdate(`progress:${value}|scale:${size};thickness:${thickness};rounded:${rounded};value-position:none`);
    // Act
    const fill = elements(decode(createPrimitiveArtwork(update)), 'circle').find(circle => circle.stroke === '#969696');
    // Assert
    assertRingSweep(fill, value, rounded);
  });
}

for (const rounded of [true, false]) {
  test(`ring cap style respects rounded:${rounded}`, () => {
    // Arrange
    const update = parseOutputUpdate(`progress:50|rounded:${rounded}`);
    // Act
    const fill = elements(decode(createPrimitiveArtwork(update)), 'circle').find(circle => circle.stroke === '#969696');
    // Assert
    assert.equal(fill['stroke-linecap'], rounded ? 'round' : 'butt');
  });
}

for (const value of [0, 100]) {
  test(`ring endpoint ${value} avoids a dot or partial-circle seam`, () => {
    // Arrange
    const update = parseOutputUpdate(`progress:${value}`);
    // Act
    const circles = elements(decode(createPrimitiveArtwork(update)), 'circle').filter(circle => circle.stroke);
    // Assert
    assert.equal(circles.length, value === 0 ? 1 : 2);
    if (value === 100) {
      const fill = circles.find(circle => circle.stroke === '#969696');
      assertRingSweep(fill, 100, true);
    }
  });
}

for (const [size, thickness, rounded] of [[85, 12, true], [50, 6, false], [100, 24, true]]) {
  test(`bar geometry uses the margin span at size ${size}`, () => {
    // Arrange
    const update = parseOutputUpdate(`progress:25|type:bar;scale:${size};thickness:${thickness};rounded:${rounded};value-position:none;color:red;track-color:blue`);
    // Act
    const rects = elements(decode(createPrimitiveArtwork(update)), 'rect');
    const track = rects.find(rect => rect.fill === '#0000ff');
    const fill = rects.find(rect => rect.fill === '#ff0000');
    // Assert
    const width = 112 * size / 100;
    close(track.width, width);
    close(track.x, (144 - width) / 2);
    close(track.y, 72 - thickness / 2);
    close(track.height, thickness);
    close(fill.width, width / 4);
    close(fill.x, Number(track.x));
    close(track.rx, rounded ? thickness / 2 : 0);
    close(fill.rx, rounded ? Math.min(thickness / 2, width / 8) : 0);
  });
}

// Regression: narrow fills must remain inside the rounded leading track corners.
for (const [value, rounded] of [[0.01, true], [1, true], [5, true], [100, true], [1, false]]) {
  test(`thick bar ${value}% rounded:${rounded} clips accent to the visible track shape`, () => {
    // Arrange
    const update = parseOutputUpdate(`progress:${value}|type:bar;scale:50;thickness:24;value-position:none;rounded:${rounded};color:red;track-color:blue`);
    // Act
    const svg = decode(createPrimitiveArtwork(update));
    const rects = elements(svg, 'rect');
    const track = rects.find(rect => rect.fill === '#0000ff');
    const fill = rects.find(rect => rect.fill === '#ff0000');
    const reference = /^url\(#([^)]*)\)$/.exec(fill['clip-path']);
    const clips = [...svg.matchAll(/<clipPath\b([^>]*)>([\s\S]*?)<\/clipPath>/g)];
    const referencedClip = reference && clips.find(clip => /\bid="([^"]*)"/.exec(clip[1])?.[1] === reference[1]);
    const clipRects = referencedClip ? elements(referencedClip[2], 'rect') : [];
    // Assert
    assert.ok(reference && referencedClip, 'accent must reference a defined SVG clip');
    assert.equal(clipRects.length, 1);
    const clip = clipRects[0];
    for (const attribute of ['x', 'y', 'width', 'height', 'rx']) close(clip[attribute], Number(track[attribute]));
    close(track.width, 56);
    close(track.height, 24);
    close(track.rx, rounded ? 12 : 0);
    close(fill.x, Number(track.x));
    close(fill.y, Number(track.y));
    close(fill.height, 24);
    close(fill.width, 56 * value / 100);
    close(fill.rx, rounded ? Math.min(12, 56 * value / 200) : 0);
    // Matching rounded clipping contains the leading corners; the fill keeps its
    // own partial trailing radius rather than borrowing the full track radius.
    if (rounded && value < 5) assert.ok(Number(fill.rx) < Number(clip.rx));
    if (!rounded) close(clip.rx, 0);
  });
}

for (const value of [0, 100]) {
  test(`bar endpoint ${value} has the expected fill extent`, () => {
    // Arrange
    const update = parseOutputUpdate(`progress:${value}|type:bar;color:red`);
    // Act
    const rects = elements(decode(createPrimitiveArtwork(update)), 'rect');
    const fill = rects.find(rect => rect.fill === '#ff0000');
    // Assert
    if (value === 0) assert.equal(fill, undefined);
    else close(fill.width, 112 * 0.85);
  });
}

for (const type of ['ring', 'bar']) {
  for (const annotation of ['white', 'accent']) {
    test(`${type} annotations use shared font and independent ${annotation} color`, () => {
      // Arrange
      const update = parseOutputUpdate(`progress:12.345|type:${type};label:Hi;color:red;track-color:blue;value-color:${annotation};label-color:${annotation};font:mono;weight:bold`);
      // Act
      const svg = decode(createPrimitiveArtwork(update));
      const texts = elements(svg, 'text');
      // Assert
       assert.deepEqual(texts.map(text => text.text), ['12.3%', 'Hi']);
      for (const text of texts) {
        assert.deepEqual([text['font-size'], text['font-family'], text['font-weight'], text.fill], ['16', 'monospace', 'bold', annotation === 'white' ? '#ffffff' : '#ff0000']);
        assert.ok(Number(text.y) >= 24 && Number(text.y) <= 132.8);
      }
      assert.ok(svg.includes('#0000ff'));
    });
  }
}

for (const type of ['ring', 'bar']) {
  for (const position of ['above', 'center', 'below', 'none']) {
    test(`${type} supports value-position:${position} without label overlap`, () => {
      // Arrange
      const update = parseOutputUpdate(`progress:50|type:${type};value-position:${position};label:Hi;label-position:below`);
      // Act
      const svg = decode(createPrimitiveArtwork(update));
      const texts = elements(svg, 'text');
      // Assert
      assert.equal(texts.length, position === 'none' ? 1 : 2);
      const percent = texts.find(text => text.text === '50%');
      if (position === 'none') assert.equal(percent, undefined);
      else {
        const baseline = Number(percent.y);
        if (position === 'above') assert.ok(baseline < 72);
        if (position === 'center') close(baseline, type === 'ring' ? 67.8 : 76.8);
        if (position === 'below') assert.ok(baseline > 72);
        assert.ok(Math.abs(baseline - Number(texts.find(text => text.text === 'Hi').y)) >= 18);
      }
    });
  }
}

for (const type of ['ring', 'bar']) {
  for (const position of ['above', 'below']) {
    test(`${type} labels fit their annotation clip at ${position}`, () => {
      // Arrange
      const update = parseOutputUpdate(`progress:20|type:${type};value-position:none;label-position:${position};label:${'👩‍💻'.repeat(100)}`);
      // Act
      const svg = decode(createPrimitiveArtwork(update));
      const label = elements(svg, 'text')[0];
      // Assert
      assert.equal(elements(svg, 'text').length, 1);
      assert.ok(label.text.endsWith('…'));
      assert.equal(label.text.slice(0, -1).split('👩‍💻').join(''), '');
      assert.match(label['clip-path'], /^url\(#[^)]+\)$/);
      if (type === 'ring') {
        const clipCircle = elements(svg, 'circle').find(circle => !circle.stroke);
        const centerY = Number(label.y) - 4.8;
        assert.ok(Math.abs(centerY - 72) + 8 < Number(clipCircle.r));
      }
    });
  }
}

for (const source of [
  'progress:100|scale:50;thickness:16;value-position:below;label:Hi;label-position:below',
  'progress:12.345678901234567|scale:50;thickness:16;value-size:32',
  'progress:12.345678901234567|type:bar;scale:50;value-size:32',
]) {
  test('impossible annotation geometry skips whole artwork without changing the accepted record', () => {
    // Arrange
    const update = parseOutputUpdate(source);
    const before = JSON.stringify(update);
    // Act
    const result = createPrimitiveArtwork(update);
    // Assert
    assert.equal(result, undefined);
    assert.equal(JSON.stringify(update), before);
  });
}

test('removing annotations permits a small ring without resizing it', () => {
  // Arrange
  const update = parseOutputUpdate('progress:100|scale:50;thickness:16;value-position:none');
  // Act
  const circles = elements(decode(createPrimitiveArtwork(update)), 'circle').filter(circle => circle.stroke);
  // Assert
  assert.equal(circles.length, 2);
  close(Number(circles[0].r) * 2 + Number(circles[0]['stroke-width']), 72);
});

test('frozen parser DTOs render deterministically without mutation', () => {
  // Arrange
  const update = parseOutputUpdate('text:hello|font:mono;color:red');
  const before = JSON.stringify(update);
  // Act
  const first = createPrimitiveArtwork(update);
  const second = createPrimitiveArtwork(update);
  // Assert
  assert.equal(first, second);
  assert.equal(JSON.stringify(update), before);
  assert.ok(Object.isFrozen(update) && Object.isFrozen(update.options) && Object.isFrozen(update.overrides));
});

const invalidFactories = [
  () => undefined, () => null, () => [], () => 'text:hello',
  () => parseOutputUpdate('data:image/png;base64,YQ=='),
  () => ({ kind: 'text', value: 'hello' }),
  update => forge(update, { extra: true }),
  update => forge(update, { kind: 'unknown' }),
  update => forge(update, { value: 1 }),
  update => forge(update, { value: 'a\0b' }),
  update => forge(update, { value: 'é'.repeat(131073) }),
  update => forge(update, {}, { ink: '#ff0000' }),
  update => forge(update, {}, { 'font-size': 0 }),
  update => forge(update, {}, { size: 16 }),
  update => forge(update, {}, { position: 'center' }),
  update => forge(update, {}, { foreground: 'white' }),
  update => forge(update, {}, { font: 'serif' }),
  update => forge(update, {}, { extra: true }),
  update => ({ ...update, overrides: { color: 'blue' } }),
  update => ({ ...update, options: Object.create(update.options) }),
  update => ({ ...update, overrides: [] }),
  update => ({ ...update, overrides: { [Symbol('synthetic')]: 'x' } }),
];
for (const [index, factory] of invalidFactories.entries()) {
  test(`malformed or inconsistent primitive DTO ${index} safely skips`, () => {
    // Arrange
    const input = factory(parseOutputUpdate('text:hello'));
    // Act
    const result = createPrimitiveArtwork(input);
    // Assert
    assert.equal(result, undefined);
  });
}

for (const value of [-1, 101, NaN, Infinity, '50']) {
  test('forged nonpercentage progress value safely skips', () => {
    // Arrange
    const input = forge(parseOutputUpdate('progress:50'), { value });
    // Act
    const result = createPrimitiveArtwork(input);
    // Assert
    assert.equal(result, undefined);
  });
}

for (const layer of ['update', 'options', 'overrides']) {
  test(`hostile ${layer} accessor is rejected without evaluation`, () => {
    // Arrange
    let calls = 0;
    const input = forge(parseOutputUpdate('text:hello'));
    const target = layer === 'update' ? input : input[layer];
    Object.defineProperty(target, 'synthetic', { get() { calls += 1; throw new Error('synthetic'); } });
    // Act
    const result = createPrimitiveArtwork(input);
    // Assert
    assert.deepEqual([result, calls], [undefined, 0]);
  });
  test(`hostile ${layer} proxy safely skips without calling traps`, () => {
    // Arrange
    let calls = 0;
    const update = forge(parseOutputUpdate('text:hello'));
    const hostile = new Proxy(layer === 'update' ? update : update[layer], {
      get() { calls += 1; throw new Error('synthetic'); },
      ownKeys() { calls += 1; throw new Error('synthetic'); },
      getPrototypeOf() { calls += 1; throw new Error('synthetic'); },
    });
    const input = layer === 'update' ? hostile : { ...update, [layer]: hostile };
    // Act
    const result = createPrimitiveArtwork(input);
    // Assert
    assert.deepEqual([result, calls], [undefined, 0]);
  });
}

test('hostile text value is rejected without coercion', () => {
  // Arrange
  let calls = 0;
  const value = { toString() { calls += 1; throw new Error('synthetic'); } };
  const input = forge(parseOutputUpdate('text:hello'), { value });
  // Act
  const result = createPrimitiveArtwork(input);
  // Assert
  assert.deepEqual([result, calls], [undefined, 0]);
});

// Slice 2: captions never quantize fill, and literal display is not a template.
for (const type of ['ring', 'bar']) {
  for (const [source, percentage, caption] of [
    ['17/1034', 1700 / 1034, '1.6%'], ['1/2', 50, '50%'],
    ['12.3456789', 12.3456789, '12.3%'], ['0.04', 0.04, '0%'],
    ['99.96', 99.96, '100%'], ['1.25', 1.25, '1.3%'], ['0/1', 0, '0%'],
    ['-1/2', 0, '0%'], ['3/2', 100, '100%'],
  ]) {
    test(`${type} full ${source} geometry and rounded ${caption} stay independent`, () => {
      // Arrange
      const update = parseOutputUpdate(`progress:${source}|type:${type};color:red`);
      // Act
      const svg = decode(createPrimitiveArtwork(update));
      // Assert
      assert.deepEqual(elements(svg, 'text').map(text => [text.text, text['font-size']]), [[caption, '16']]);
      if (type === 'ring') {
        const fill = elements(svg, 'circle').find(circle => circle.stroke === '#ff0000');
        if (percentage === 0) assert.equal(fill, undefined);
        else assertRingSweep(fill, percentage, true);
      } else {
        const track = elements(svg, 'rect').find(rect => rect.fill === '#333333');
        const fill = elements(svg, 'rect').find(rect => rect.fill === '#ff0000');
        if (percentage === 0) assert.equal(fill, undefined);
        else {
          close(fill.width, Number(track.width) * percentage / 100);
          if (percentage < 100) assert.ok(Number(fill.width) < Number(track.width));
        }
      }
      assert.equal(update.value, percentage);
    });
  }
  for (const [literal, expected] of [['{value}', '{value}'], ['<>&"\'', '&lt;&gt;&amp;&quot;&apos;'], ['e\u0301', 'é']]) {
    test(`${type} explicit display normalizes and XML-escapes literal ${expected}`, () => {
      // Arrange
      const update = parseOutputUpdate(`progress:17/1034|type:${type};display:${literal}`);
      // Act
      const texts = elements(decode(createPrimitiveArtwork(update)), 'text');
      // Assert
      assert.deepEqual(texts.map(text => text.text), [expected]);
      assert.equal(update.value, 1700 / 1034);
    });
  }
  for (const count of [512, 513]) {
    test(`${type} explicit display ${count} graphemes ellipsizes at fixed size without splitting`, () => {
      // Arrange
      const cluster = '👩‍💻';
      const update = parseOutputUpdate(`progress:1/2|type:${type};scale:100;display:${cluster.repeat(count)};value-size:32`);
      // Act
      const svg = decode(createPrimitiveArtwork(update));
      const texts = elements(svg, 'text');
      // Assert
      assert.equal(texts.length, 1);
      assert.equal(texts[0]['font-size'], '32');
      assert.ok(texts[0].text.endsWith('…'));
      assert.equal(texts[0].text.slice(0, -1).split(cluster).join(''), '');
      assert.ok(svg.length < 10000);
    });
  }
  for (const suffix of ['display:', 'display:   ', 'display:visible;value-position:none']) {
    test(`${type} ${suffix} hides only the value without losing fill or label`, () => {
      // Arrange
      const update = parseOutputUpdate(`progress:1/2|type:${type};label:Hi;${suffix}`);
      // Act
      const svg = decode(createPrimitiveArtwork(update));
      // Assert
      assert.deepEqual(elements(svg, 'text').map(text => text.text), ['Hi']);
      assert.ok(type === 'ring' ? elements(svg, 'circle').some(circle => circle['stroke-dasharray'])
        : elements(svg, 'rect').some(rect => rect.fill === '#969696'));
    });
  }
}

for (const [valueSize, labelSize] of [[16, 16], [32, 16], [16, 32], [32, 32], [20.5, 25.5]]) {
  for (const position of ['above', 'below']) {
    test(`ring whole block ${valueSize}/${labelSize} label ${position} is centered at 72`, () => {
      // Arrange - Derive slot edges from the documented logical font heights, not glyph metrics.
      const update = parseOutputUpdate(`progress:1/2|scale:100;display:V;label:L;value-size:${valueSize};label-size:${labelSize};label-position:${position}`);
      const ordered = position === 'above' ? [['L', labelSize], ['V', valueSize]] : [['V', valueSize], ['L', labelSize]];
      const top = 72 - (valueSize + labelSize + 2) / 2;
      // Act
      const svg = decode(createPrimitiveArtwork(update));
      const texts = elements(svg, 'text');
      // Assert
      assert.deepEqual(texts.map(text => [text.text, Number(text['font-size'])]), ordered);
      close(Number(texts[0].y) - ordered[0][1] * 0.8, top);
      close(Number(texts[1].y) + ordered[1][1] * 0.2, 144 - top);
      close((Number(texts[1].y) - ordered[1][1] * 0.8) - (Number(texts[0].y) + ordered[0][1] * 0.2), 2);
      close(elements(svg, 'circle').find(circle => circle.stroke).r, 68);
    });
  }
}
for (const label of ['', ' ', '\t']) {
  test('empty or blank ring label leaves the solo value centered', () => {
    // Arrange
    const update = parseOutputUpdate(`progress:1/2|label:${label};value-size:32;scale:100`);
    // Act
    const texts = elements(decode(createPrimitiveArtwork(update)), 'text');
    // Assert
    assert.equal(texts.length, 1);
    close(Number(texts[0].y) - 32 * 0.3, 72);
  });
}
for (const position of ['above', 'below']) {
  test(`hidden ring value retains label-only ${position} placement`, () => {
    // Arrange
    const update = parseOutputUpdate(`progress:1/2|display:;label:Hi;label-size:32;label-position:${position};scale:100`);
    // Act
    const texts = elements(decode(createPrimitiveArtwork(update)), 'text');
    // Assert
    assert.equal(texts.length, 1);
    close(Number(texts[0].y) - 32 * 0.3, position === 'above' ? 46 : 98);
  });
}
for (const border of [0, 8]) {
  test(`ring block just-fitting versus too-small inner circle with border ${border} skips atomically`, () => {
    // Arrange - Half-height 17, mono V width 10.816: required inner radius sqrt(17²+7.408²).
    // Inner radius 21 fits both complete captions; 18 leaves no room even for an ellipsis.
    const span = border === 0 ? 144 : 124 - border;
    const source = `progress:1/2|border:${border};thickness:16;display:V;label:L;font:mono`;
    const fitting = parseOutputUpdate(`${source};scale:${78 / span * 100}`);
    const small = parseOutputUpdate(`${source};scale:${72 / span * 100}`);
    const before = JSON.stringify(small);
    // Act
    const artwork = createPrimitiveArtwork(fitting);
    const rejected = createPrimitiveArtwork(small);
    // Assert
    assert.deepEqual(elements(decode(artwork), 'text').map(text => [text.text, text['font-size']]), [['V', '16'], ['L', '16']]);
    assert.equal(rejected, undefined);
    assert.equal(JSON.stringify(small), before);
    close(elements(decode(artwork), 'circle').find(circle => circle.stroke).r, 31);
  });
}
test('default percent never truncates at a narrow bar while explicit display may ellipsize', () => {
  // Arrange
  const source = 'progress:12.3456789|type:bar;scale:50;value-size:32;font:mono';
  const standard = parseOutputUpdate(source), explicit = parseOutputUpdate(`${source};display:12.3%`);
  // Act
  const rejected = createPrimitiveArtwork(standard);
  const artwork = createPrimitiveArtwork(explicit);
  // Assert
  assert.equal(rejected, undefined);
  assert.deepEqual(elements(decode(artwork), 'text').map(text => [text.text, text['font-size']]), [['…', '32']]);
});
for (const [index, change] of [
  record => ({ ...record, options: { ...record.options, display: 1 } }),
  record => ({ ...record, options: { ...record.options, display: 'forged' } }),
  record => { const options = { ...record.options }; delete options.display; return { ...record, options }; },
  record => ({ ...record, overrides: { ...record.overrides, display: undefined } }),
  record => ({ ...record, options: { ...record.options, display: 'a\0b' }, overrides: { ...record.overrides, display: 'a\0b' } }),
].entries()) {
  test(`display DTO forgery ${index} cannot pass renderer or callback admission`, () => {
    // Arrange
    const record = parseOutputUpdate('progress:17/1034|display:17 done');
    const input = change(record);
    // Act
    const artwork = createPrimitiveArtwork(input), snapshot = snapshotOutput(input);
    const accepted = snapshotOutput(record);
    // Assert
    assert.deepEqual([artwork, snapshot], [undefined, undefined]);
    assert.equal(accepted.options.display, '17 done');
    assert.equal(accepted.value, 1700 / 1034);
    assert.ok(Object.isFrozen(accepted.options));
  });
}
