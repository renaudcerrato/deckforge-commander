import assert from 'node:assert/strict';

// Generated SVG only: flat element attributes, literal text and simple clip references.
// This is not XML recovery, CSS inheritance, path interpretation or browser rendering.
function attributes(source) {
  const result = {};
  for (const [, name, double, single] of source.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    assert.equal(Object.hasOwn(result, name), false, `duplicate SVG attribute ${name}`);
    result[name] = double ?? single;
  }
  return result;
}

function onlyAttributes(element, allowed) {
  // These metadata attributes do not alter geometry in the controlled, CSS-free SVG fixtures.
  const metadata = ['id', 'role', 'aria-label'];
  for (const name of Object.keys(element)) assert.ok(allowed.includes(name) || metadata.includes(name), `unsupported SVG geometry attribute ${name}`);
}

export function svgElements(svg, name) {
  assert.match(name, /^[A-Za-z][\w-]*$/);
  return [...svg.matchAll(new RegExp(`<${name}\\b([^>]*)(?:>([^<]*)<\\/${name}\\s*>|\\s*\\/>)`, 'g'))]
    .map(match => ({ ...attributes(match[1]), text: match[2] ?? '' }));
}

export function assertSvgElement(svg, name, match, expected) {
  const matches = svgElements(svg, name).filter(element => Object.entries(match).every(([key, value]) => element[key] === value));
  assert.equal(matches.length, 1, `expected one matching ${name}`);
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(typeof value === 'number' ? Number(matches[0][key]) : matches[0][key], value, `${name} ${key}`);
  }
  return matches[0];
}

export function referencedClip(svg, element) {
  const reference = /^url\(#([^)]*)\)$/.exec(element['clip-path'] ?? '');
  assert.ok(reference, 'target element must reference its clip');
  const clips = [...svg.matchAll(/<clipPath\b([^>]*)>([\s\S]*?)<\/clipPath\s*>/g)]
    .filter(match => attributes(match[1]).id === reference[1]);
  assert.equal(clips.length, 1, 'target clip must have one definition');
  const definition = attributes(clips[0][1]);
  onlyAttributes(definition, ['id', 'clipPathUnits']);
  assert.ok([undefined, 'userSpaceOnUse'].includes(definition.clipPathUnits));
  return clips[0][2];
}

export function referencedClipRect(svg, element) {
  const content = referencedClip(svg, element);
  assert.match(content, /^\s*<rect\b[^>]*(?:\/>|>\s*<\/rect\s*>)\s*$/, 'padded clip must contain only a rectangle');
  const rectangles = svgElements(content, 'rect');
  assert.equal(rectangles.length, 1, 'target clip must contain one rectangle');
  const rectangle = rectangles[0];
  onlyAttributes(rectangle, ['text', 'x', 'y', 'width', 'height']);
  const values = ['x', 'y', 'width', 'height'].map(key => Number(rectangle[key]));
  assert.ok(values.every(Number.isFinite), 'clip bounds must be finite');
  assert.ok(values[0] >= 0 && values[1] >= 0 && values[2] > 0 && values[3] > 0
    && values[0] + values[2] <= 144 && values[1] + values[3] <= 144, 'clip must remain inside canvas');
  return rectangle;
}

export function assertRingContentClip(svg, element, track) {
  const content = referencedClip(svg, element);
  assert.match(content, /^\s*<circle\b[^>]*(?:\/>|>\s*<\/circle\s*>)\s*$/, 'ring clip must contain only a circle');
  const circles = svgElements(content, 'circle');
  assert.equal(circles.length, 1, 'ring clip must contain one circle');
  const circle = circles[0];
  onlyAttributes(circle, ['text', 'cx', 'cy', 'r']);
  const [cx, cy, radius] = ['cx', 'cy', 'r'].map(key => Number(circle[key]));
  const trackRadius = Number(track.r), thickness = Number(track['stroke-width']);
  assert.ok([cx, cy, radius, trackRadius, thickness].every(Number.isFinite), 'ring clip geometry must be finite');
  assert.ok(radius > 0 && trackRadius > 0 && thickness > 0, 'ring radii and thickness must be positive');
  assert.deepEqual([cx, cy, Number(track.cx), Number(track.cy)], [72, 72, 72, 72]);
  assert.equal(circle.transform, undefined, 'ring clip must retain its canvas coordinates');
  assert.ok(Math.abs(radius - (trackRadius - thickness / 2 - 2)) <= 1e-6, 'ring clip must retain the two-unit inner-track gap');
}

export function assertPaddedClip(svg, element, bounds) {
  const rectangle = referencedClipRect(svg, element);
  for (const [key, value] of Object.entries(bounds)) {
    assert.ok(Math.abs(Number(rectangle[key]) - value) <= 1e-6, `clip ${key} must match padded bounds`);
  }
}

// Only the fixed built-in frame contract, not an SVG renderer.
export function assertSvgCanvas(svg) {
  const root = /<svg\b([^>]*)>/.exec(svg);
  assert.ok(root, 'SVG root required');
  const canvas = attributes(root[1]);
  onlyAttributes(canvas, ['xmlns', 'width', 'height', 'viewBox']);
  assert.deepEqual([Number(canvas.width), Number(canvas.height)], [144, 144]);
  assert.deepEqual(canvas.viewBox.trim().split(/[\s,]+/).map(Number), [0, 0, 144, 144]);
}

export function assertKeyFrame(svg, color) {
  assertSvgCanvas(svg);
  const backdrop = assertSvgElement(svg, 'rect', { fill: '#000000' }, { width: 144, height: 144 });
  onlyAttributes(backdrop, ['text', 'x', 'y', 'width', 'height', 'fill']);
  assert.ok([Number(backdrop.x ?? 0), Number(backdrop.y ?? 0)].every(value => value === 0), 'backdrop must cover the canvas from its origin');
  const frame = assertSvgElement(svg, 'rect', { fill: 'none' }, {
    x: 8, y: 8, width: 128, height: 128, rx: 16, stroke: color, 'stroke-width': 3, 'stroke-opacity': 0.35,
  });
  onlyAttributes(frame, ['text', 'x', 'y', 'width', 'height', 'rx', 'fill', 'stroke', 'stroke-width', 'stroke-opacity']);
}

export function assertFixedError(svg, code, lines, border = '#969696') {
  assertKeyFrame(svg, border);
  assert.equal(svgElements(svg, 'text').length, 4);
  assert.equal(svgElements(svg, 'rect').length, 3);
  // Fixed Error artwork is flat and CSS-free; do not silently ignore inherited effects.
  assert.doesNotMatch(svg, /<path\b|<circle\b|<image\b|<script\b|<style\b|<g\b|<use\b|foreignObject|onload=|href=/);
  const font = { 'font-family': 'Arial,sans-serif', 'font-size': 16 };
  const expected = [
    ['Error', { ...font, x: 22, y: 32, fill: '#ff6b6b' }],
    [code, { ...font, x: 72, y: 124, 'text-anchor': 'middle', fill: '#ff6b6b' }],
    ...lines.map((line, index) => [line.replaceAll("'", '&apos;'), {
      ...font, x: 72, y: index === 0 ? 66.6 : 88.6, 'text-anchor': 'middle', fill: '#ffffff',
    }]),
  ];
  for (const [index, [text, geometry]] of expected.entries()) {
    const element = assertSvgElement(svg, 'text', { text }, geometry);
    onlyAttributes(element, ['text', ...Object.keys(geometry), ...(index >= 2 ? ['clip-path'] : ['text-anchor'])]);
    if (index === 0) assert.equal(element['text-anchor'] ?? 'start', 'start');
    if (index >= 2) assertPaddedClip(svg, element, { x: 16, y: 48, width: 112, height: 48 });
  }
  // Only meaningful paint order: the opaque backdrop must precede the frame and ink.
  // The clip rectangle is a definition, not a painted layer; nonoverlapping text may reorder.
  const layers = [...svg.matchAll(/<(rect|text)\b([^>]*)>/g)]
    .map(match => ({ name: match[1], attributes: attributes(match[2]), index: match.index }));
  const backdrop = layers.find(layer => layer.name === 'rect' && layer.attributes.fill === '#000000');
  const frame = layers.find(layer => layer.name === 'rect' && layer.attributes.fill === 'none');
  assert.ok(backdrop.index < frame.index, 'backdrop must not obscure the frame');
  for (const layer of layers.filter(layer => layer.name === 'text')) {
    assert.ok(backdrop.index < layer.index, 'backdrop must not obscure diagnostic text');
  }
}

export function assertSetupWarning(svg) {
  const groups = [...svg.matchAll(/<g\b([^>]*)>/g)].map(match => attributes(match[1]));
  assert.equal(groups.filter(group => group['aria-label'] === 'Setup required' && group.role === 'img').length, 1);
  assertSvgElement(svg, 'path', { fill: '#ffd43b' }, { stroke: '#ffe066', 'stroke-width': 2 });
}

export function assertBadgeAddition(plain, badged, badge, color) {
  const before = svgElements(plain, 'text'), after = svgElements(badged, 'text');
  assert.deepEqual(after.filter(text => text.text !== badge), before);
  assert.deepEqual(svgElements(badged, 'rect'), svgElements(plain, 'rect'));
  const added = assertSvgElement(badged, 'text', { text: badge }, {
    'text-anchor': 'end', 'font-size': 16, fill: color,
  });
  assert.ok(Number.isFinite(Number(added.x)) && Number(added.x) > 72 && Number(added.x) <= 128);
  assert.ok(Number.isFinite(Number(added.y)) && Number(added.y) >= 16 && Number(added.y) < 48);
}

export function assertRingSweep(circle, percentage, rounded) {
  // Native circles advance clockwise. Accept physical or pathLength-calibrated dashes,
  // and equivalent top-origin rotations/dash offsets; reject unsupported transforms.
  assert.ok(Number.isFinite(Number(circle.r)) && Number(circle.r) > 0);
  assert.ok(Number.isFinite(Number(circle.cx)) && Number.isFinite(Number(circle.cy)));
  const length = circle.pathLength === undefined ? 2 * Math.PI * Number(circle.r) : Number(circle.pathLength);
  assert.ok(Number.isFinite(length) && length > 0);
  assert.equal(circle['stroke-linecap'], rounded ? 'round' : 'butt');
  let rotation = 0;
  if (circle.transform !== undefined) {
    const rotate = /^rotate\(\s*([-+\d.eE]+)[\s,]+([-+\d.eE]+)[\s,]+([-+\d.eE]+)\s*\)$/.exec(circle.transform);
    assert.ok(rotate, 'supported circle rotation');
    assert.equal(Number(rotate[2]), Number(circle.cx)); assert.equal(Number(rotate[3]), Number(circle.cy));
    rotation = Number(rotate[1]);
    assert.ok(Number.isFinite(rotation));
  }
  if (circle['stroke-dasharray'] === undefined) { assert.equal(percentage, 100); return; }
  const dashes = circle['stroke-dasharray'].trim().split(/[\s,]+/).map(Number);
  assert.equal(dashes.length, 2);
  assert.ok(dashes.every(value => Number.isFinite(value) && value >= 0));
  assert.ok(Math.abs(dashes[0] + dashes[1] - length) <= 1e-6, 'one calibrated circumference');
  assert.ok(Math.abs(dashes[0] / length * 100 - percentage) <= 1e-6, 'full-precision fill fraction');
  if (percentage === 100) return;
  const angle = rotation - Number(circle['stroke-dashoffset'] ?? 0) / length * 360;
  assert.ok(Math.abs(((angle % 360) + 360) % 360 - 270) <= 1e-6, 'fill starts at the top');
}
