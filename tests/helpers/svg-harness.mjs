import assert from 'node:assert/strict';

// Generated SVG only: flat element attributes, literal text and rectangle clip references.
// This is not XML recovery, CSS inheritance, path interpretation or browser rendering.
function attributes(source) {
  const result = {};
  for (const [, name, double, single] of source.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    assert.equal(Object.hasOwn(result, name), false, `duplicate SVG attribute ${name}`);
    result[name] = double ?? single;
  }
  return result;
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

export function assertPaddedClip(svg, element, bounds) {
  const reference = /^url\(#([^)]*)\)$/.exec(element['clip-path'] ?? '');
  assert.ok(reference, 'target element must reference its clip');
  const clips = [...svg.matchAll(/<clipPath\b([^>]*)>([\s\S]*?)<\/clipPath\s*>/g)]
    .filter(match => attributes(match[1]).id === reference[1]);
  assert.equal(clips.length, 1, 'target clip must have one definition');
  assert.ok([undefined, 'userSpaceOnUse'].includes(attributes(clips[0][1]).clipPathUnits));
  const rectangles = svgElements(clips[0][2], 'rect');
  assert.equal(rectangles.length, 1, 'target clip must contain one rectangle');
  for (const [key, value] of Object.entries(bounds)) {
    assert.ok(Math.abs(Number(rectangles[0][key]) - value) <= 1e-6, `clip ${key} must match padded bounds`);
  }
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
