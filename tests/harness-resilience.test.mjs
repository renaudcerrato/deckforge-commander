import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createInspectorFixture, extractInspectorMarkup, assertInspectorMarkup, inspectorTestMarkup, isHiddenByAncestry } from './helpers/inspector-harness.mjs';
import { loadAdapterCode, createAdapterLoader } from './helpers/adapter-harness.mjs';
import { svgElements, assertSvgElement, assertPaddedClip, assertKeyFrame, assertRingContentClip, assertSetupWarning, assertSvgCanvas, assertFixedError } from './helpers/svg-harness.mjs';

// Objective: independent SVG fixtures accept equivalent spelling, reject lost safety/content.
for (const [label, dimensions, valid] of [
  ['equivalent numeric spelling', "height='144.0' viewBox='0,0,144,144' width='1.44e2'", true],
  ['wrong width', "width='143' height='144' viewBox='0 0 144 144'", false],
  ['shifted viewBox', "width='144' height='144' viewBox='1 0 144 144'", false],
]) {
  test(`logical canvas inspection ${valid ? 'accepts' : 'rejects'} ${label}`, () => {
    // Arrange
    const svg = `<svg ${dimensions}></svg>`;
    // Act
    const verify = () => assertSvgCanvas(svg);
    // Assert
    if (valid) assert.doesNotThrow(verify); else assert.throws(verify, assert.AssertionError);
  });
}
for (const [label, role, name, color, valid] of [
  ['equivalent attributes', 'img', 'Setup required', '#ffd43b', true],
  ['missing accessible warning', 'img', '', '#ffd43b', false],
  ['wrong role', 'button', 'Setup required', '#ffd43b', false],
  ['wrong warning color', 'img', 'Setup required', '#ffffff', false],
]) {
  test(`Setup warning inspection ${valid ? 'accepts' : 'rejects'} ${label}`, () => {
    // Arrange: independent icon input, not a copied product SVG.
    const svg = `<g aria-label='${name}' role='${role}'><path stroke-width='2.0' stroke='#ffe066' d='M0 0' fill='${color}'/></g>`;
    // Act
    const verify = () => assertSetupWarning(svg);
    // Assert
    if (valid) assert.doesNotThrow(verify); else assert.throws(verify, assert.AssertionError);
  });
}
for (const input of [
  '<clipPath id="local"><rect x="16" y="48" width="112" height="48"/></clipPath><text font-size="16" clip-path="url(#local)" fill="white">Safe</text>',
  "<clipPath clipPathUnits='userSpaceOnUse' id='renamed'><rect height='48.0' width='1.12e2' y='48' x='16.00000000'></rect></clipPath><text clip-path='url(#renamed)' fill='white' font-size='16.0'>Safe</text>",
]) {
  test('SVG clip checks follow emitted references across equivalent serialization', () => {
    // Arrange
    const svg = input;
    // Act
    const text = svgElements(svg, 'text')[0];
    // Assert
    assert.equal(text.text, 'Safe');
    assert.equal(Number(text['font-size']), 16);
    assertPaddedClip(svg, text, { x: 16, y: 48, width: 112, height: 48 });
  });
}

for (const variant of ['shared reference', 'equivalent separate references', 'wrong secondary bounds']) {
  test(`every text clip inspection ${variant === 'wrong secondary bounds' ? 'rejects' : 'accepts'} ${variant}`, () => {
    // Arrange: a valid first line cannot stand in for the second line's own clipping.
    const secondBounds = variant === 'wrong secondary bounds'
      ? "x='0' y='0' width='1' height='1'" : "height='112.0' width='1.12e2' y='16.000' x='16'";
    const secondId = variant === 'shared reference' ? 'first' : 'second';
    const svg = `<defs><clipPath id='first'><rect x='16' y='16' width='112' height='112'/></clipPath><clipPath id='second'><rect ${secondBounds}/></clipPath></defs><text clip-path='url(#first)'>Main</text><text clip-path='url(#${secondId})'>Caption</text>`;
    // Act
    const verify = () => {
      for (const text of svgElements(svg, 'text')) assertPaddedClip(svg, text, { x: 16, y: 16, width: 112, height: 112 });
    };
    // Assert
    if (variant === 'wrong secondary bounds') assert.throws(verify, assert.AssertionError);
    else assert.doesNotThrow(verify);
  });
}

// Independent fixed Error fixtures exercise the same assertion as the product tests.
const errorAppearanceCases = [
  ['equivalent serialization and neutral metadata', undefined, '', 'normal', true],
  ['nonoverlapping ink and frame reordered', undefined, '', 'frame last', true],
  ['late opaque backdrop', undefined, '', 'backdrop last', false],
  ['backdrop obscures frame', undefined, '', 'frame first', false],
  ...['Error', 'START', 'First reason', 'Second reason'].flatMap(text => [
    ['opacity', "opacity='0'"], ['visibility', "visibility='hidden'"], ['display', "display='none'"],
    ['restyling', "style='fill:#000000'"], ['off-canvas transform', "transform='translate(1000)'"],
  ].map(([label, modifier]) => [`${text} ${label}`, text, modifier, 'normal', false])),
];
for (const [label, target, modifier, order, valid] of errorAppearanceCases) {
  test(`fixed Error appearance ${valid ? 'accepts' : 'rejects'} ${label}`, () => {
    // Arrange: literal public appearance, no production SVG or byte oracle is copied.
    const backdrop = "<rect id='background' height='144.0' fill='#000000' width='1.44e2'/>";
    const frame = "<rect stroke-opacity='.35' stroke-width='3.0' stroke='#969696' fill='none' rx='16' height='128' width='128' y='8' x='8'/>";
    const definitions = "<defs><clipPath id='reasons'><rect height='48.0' width='112' y='48' x='16'/></clipPath></defs>";
    const ink = [['Error', 22, 32, '#ff6b6b', false], ['First reason', 72, 66.6, '#ffffff', true],
      ['Second reason', 72, 88.6, '#ffffff', true], ['START', 72, 124, '#ff6b6b', false]]
      .map(([text, x, y, fill, clipped], index) => `<text id='ink-${index}' role='img' aria-label='Diagnostic' ${text === target ? modifier : ''} ${clipped ? "clip-path='url(#reasons)'" : ''} fill='${fill}' font-size='16.0' font-family='Arial,sans-serif' ${x === 72 ? "text-anchor='middle'" : ''} y='${y}' x='${x}'>${text}</text>`).join('');
    const layers = order === 'backdrop last' ? frame + ink + backdrop
      : order === 'frame first' ? frame + backdrop + ink
        : order === 'frame last' ? backdrop + ink + frame : backdrop + frame + ink;
    const svg = `<svg role='img' aria-label='Error' viewBox='0,0,144,144' height='144.0' width='144'>${definitions}${layers}</svg>`;
    // Act
    const verify = () => assertFixedError(svg, 'START', ['First reason', 'Second reason']);
    // Assert
    if (valid) assert.doesNotThrow(verify); else assert.throws(verify, assert.AssertionError);
  });
}

// Objective: neutral metadata does not turn equivalent artwork into a geometry failure.
for (const location of ['root', 'backdrop', 'frame']) {
  test(`fixed frame inspection accepts neutral metadata on ${location}`, () => {
    // Arrange: no stylesheet, scripts or external references give these IDs visual behavior.
    const metadata = "id='descriptive' role='img' aria-label='Artwork'";
    const svg = `<svg ${location === 'root' ? metadata : ''} width='144' height='144' viewBox='0 0 144 144'><rect ${location === 'backdrop' ? metadata : ''} fill='#000000' width='144' height='144'/><rect ${location === 'frame' ? metadata : ''} x='8' y='8' width='128' height='128' rx='16' fill='none' stroke='#969696' stroke-width='3' stroke-opacity='.35'/></svg>`;
    // Act
    const verify = () => assertKeyFrame(svg, '#969696');
    // Assert
    assert.doesNotThrow(verify);
  });
}
for (const shape of ['rect', 'circle']) for (const location of ['definition', 'shape']) {
  test(`${shape} clip inspection accepts neutral metadata on ${location}`, () => {
    // Arrange: the referenced definition keeps its ID; the shape's extra ID is unreferenced.
    const metadata = "role='img' aria-label='Content area'";
    const body = shape === 'rect' ? "<rect x='16' y='48' width='112' height='48'" : "<circle cx='72' cy='72' r='48'";
    const svg = `<clipPath id='safe' ${location === 'definition' ? metadata : ''}>${body} ${location === 'shape' ? `id='descriptive' ${metadata}` : ''}/></clipPath><text clip-path='url(#safe)'>Safe</text>`;
    const text = svgElements(svg, 'text')[0];
    // Act
    const verify = () => shape === 'rect' ? assertPaddedClip(svg, text, { x: 16, y: 48, width: 112, height: 48 })
      : assertRingContentClip(svg, text, { cx: '72', cy: '72', r: '54', 'stroke-width': '8' });
    // Assert
    assert.doesNotThrow(verify);
  });
}

// Objective: geometry checks reject unsupported modifiers rather than pretending to render them.
for (const shape of ['rect', 'circle']) for (const location of ['definition', 'shape']) {
  for (const modifier of ["transform='translate(1000)'", "style='transform:translateX(1000px)'", "clip-path='url(#elsewhere)'"]) {
    test(`${shape} clip rejects ${location} modifier ${modifier.split('=')[0]}`, () => {
      // Arrange
      const body = shape === 'rect' ? "<rect x='16' y='48' width='112' height='48'" : "<circle cx='72' cy='72' r='48'";
      const svg = `<clipPath id='safe' ${location === 'definition' ? modifier : ''}>${body} ${location === 'shape' ? modifier : ''}/></clipPath><text clip-path='url(#safe)'>Safe</text>`;
      const text = svgElements(svg, 'text')[0];
      // Act
      const verify = () => shape === 'rect' ? assertPaddedClip(svg, text, { x: 16, y: 48, width: 112, height: 48 })
        : assertRingContentClip(svg, text, { cx: '72', cy: '72', r: '54', 'stroke-width': '8' });
      // Assert
      assert.throws(verify, assert.AssertionError);
    });
  }
}
for (const [label, origin, modifier, valid] of [
  ['omitted zero', '', '', true], ['equivalent explicit zero', "x='0.000' y='0e0'", '', true],
  ['shifted horizontally', "x='144'", '', false], ['shifted vertically', "y='144'", '', false],
  ['transformed backdrop', '', "transform='translate(144)'", false],
  ['styled backdrop', '', "style='x:144px'", false],
]) {
  test(`canvas coverage ${valid ? 'accepts' : 'rejects'} ${label}`, () => {
    // Arrange
    const svg = `<svg width='144.0' height='144' viewBox='0 0 144 144'><rect ${origin} ${modifier} fill='#000000' width='144' height='144'/><rect x='8' y='8' width='128' height='128' rx='16' fill='none' stroke='#969696' stroke-width='3' stroke-opacity='.35'/></svg>`;
    // Act
    const verify = () => assertKeyFrame(svg, '#969696');
    // Assert
    if (valid) assert.doesNotThrow(verify); else assert.throws(verify, assert.AssertionError);
  });
}
for (const [label, content, valid] of [['literal escaped content', 'Safe &amp; sound', true],
  ['missing content', '', false], ['wrong content', 'Changed', false]]) {
  test(`SVG text semantics ${valid ? 'accept' : 'reject'} ${label}`, () => {
    // Arrange
    const svg = `<text fill='white' y='32.0' x='22'>${content}</text>`;
    // Act
    const verify = () => assertSvgElement(svg, 'text', { text: 'Safe &amp; sound' }, { x: 22, y: 32, fill: 'white' });
    // Assert
    if (valid) assert.doesNotThrow(verify); else assert.throws(verify, assert.AssertionError);
  });
}
for (const [label, definition] of [
  ['missing', ''], ['wrong reference', '<clipPath id="elsewhere"><rect x="16" y="48" width="112" height="48"/></clipPath>'],
  ['nonfinite', '<clipPath id="local"><rect x="NaN" y="48" width="112" height="48"/></clipPath>'],
  ['outward', '<clipPath id="local"><rect x="16" y="48" width="129" height="48"/></clipPath>'],
  ['wrong bounds', '<clipPath id="local"><rect x="17" y="48" width="111" height="48"/></clipPath>'],
]) {
  test(`SVG clip checks reject ${label} bounds or references`, () => {
    // Arrange
    const svg = `${definition}<text clip-path="url(#local)">Safe</text>`;
    // Act
    const verify = () => assertPaddedClip(svg, svgElements(svg, 'text')[0], { x: 16, y: 48, width: 112, height: 48 });
    // Assert
    assert.throws(verify, assert.AssertionError);
  });
}
for (const [label, fill, width, valid] of [['equivalent', '#000000', '1.44e2', true],
  ['changed color', '#ffffff', '144', false], ['missing extent', '#000000', '', false]]) {
  test(`fixed frame semantics ${valid ? 'accept' : 'reject'} ${label}`, () => {
    // Arrange
    const svg = `<svg viewBox='0,0,144,144' height='144.0' width='144'><rect fill='${fill}' height='144' width='${width}'></rect><rect stroke-opacity='.35' stroke-width='3.0' stroke='#969696' fill='none' rx='16' height='128' width='128' y='8' x='8'/></svg>`;
    // Act
    const verify = () => assertKeyFrame(svg, '#969696');
    // Assert
    if (valid) assert.doesNotThrow(verify); else assert.throws(verify, assert.AssertionError);
  });
}

// Objective: markup changes update the boundary fixture without a second ID inventory.
test('inspector fixture follows reordered tags/attributes and newly added controls', () => {
  // Arrange
  const first = `<sdpi-textfield id="draft" placeholder="local hint"></sdpi-textfield>
    <div id="group" hidden></div>`;
  const reordered = `<div hidden id='group'></div>
    <sdpi-textfield placeholder='local hint' id='draft'></sdpi-textfield>
    <a href="https://example.invalid/" id="new-link">Link</a>`;
  // Act
  const before = createInspectorFixture(first), after = createInspectorFixture(reordered);
  let clicks = 0;
  after.getElementById('new-link').addEventListener('click', () => { clicks++; });
  after.getElementById('new-link').dispatch('click');
  // Assert
  assert.equal(after.fields.draft.renderedHint, before.fields.draft.renderedHint);
  assert.equal(after.fields.group.hidden, before.fields.group.hidden);
  assert.equal(after.getElementById('new-link').getAttribute('href'), 'https://example.invalid/');
  assert.equal(before.getElementById('new-link'), null);
  assert.equal(clicks, 1);
});

test('inspector fixture never invents absent IDs from comments, scripts, styles or lookups', () => {
  // Arrange
  const html = `<!-- <a id="comment-only"></a> -->
    <script>const sample = '<a id="script-only"></a>';</script>
    <style>/* <a id="style-only"></a> */</style><a id="present"></a>`;
  // Act
  const fixture = createInspectorFixture(html);
  const absent = ['missing', 'comment-only', 'script-only', 'style-only'].map(fixture.getElementById);
  // Assert
  assert.ok(fixture.getElementById('present'));
  assert.deepEqual(absent, Array(4).fill(null));
  assert.equal(fixture.elements.size, 1);
});

// Check real markup unchanged; only independent controlled inputs create defect cases.
const staticControls = readFileSync(new URL('../src/inspector/run.html', import.meta.url), 'utf8');
const generatedControls = readFileSync(new URL('../git.renaudcerrato.deckforge.sdPlugin/ui/run.html', import.meta.url), 'utf8');

function reformatMarkup(html) {
  return html.replace(/<([a-z][\w-]*)\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>/gi, (_, tag, source) => {
    // Reformat only opening tags; preserve text, CSS, script bodies and closing tags.
    const attributes = source.match(/[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g) ?? [];
    return `<${tag}\n ${attributes.reverse().map(attribute => attribute
      .replace(/^([^\s=/>]+)\s*=\s*"([^"]*)"$/, (_, name, value) => value.includes("'")
        ? `${name} = "${value}"` : `${name} = '${value}'`)).join('\n ')}${/\/\s*$/.test(source) ? ' /' : ''} >`;
  });
}
const markupVariants = [['controlled', inspectorTestMarkup], ['controlled reformatted', reformatMarkup(inspectorTestMarkup)]];

for (const [variant, html] of [['authored', staticControls], ['generated', generatedControls], ...markupVariants]) {
  test(`central inspector static contract holds for ${variant} markup`, () => {
    // Arrange
    const input = html;
    // Act
    const verify = () => assertInspectorMarkup(input);
    // Assert: usable bindings, accessibility, public values and writer safety.
    assert.doesNotThrow(verify);
  });
}

test('static control semantics tolerate reordered attributes, quotes and whitespace', () => {
  // Arrange: equivalent static controls, not a browser rendering claim.
  const formatted = markupVariants[1][1];
  // Act
  const fixtures = [inspectorTestMarkup, formatted].map(createInspectorFixture);
  // Assert
  assert.notEqual(formatted, inspectorTestMarkup);
  assert.equal(fixtures[1].fields.timerControls.hidden, fixtures[0].fields.timerControls.hidden);
  assert.equal(fixtures[1].fields.status.getAttribute('aria-live'), 'polite');
});

for (const [label, html, placeholder] of [
  ['apostrophes', `<sdpi-textfield id="draft" placeholder="owner's folder" title='say "hello"'></sdpi-textfield>`, "owner's folder"],
  ['embedded equals and quotes', `<sdpi-textfield id="draft" placeholder='--mode="daily report"' title='say "hello"'></sdpi-textfield>`, '--mode="daily report"'],
]) {
  test(`markup reformatting preserves ${label} and quoted attribute values`, () => {
    // Arrange
    const original = createInspectorFixture(html).fields.draft;
    // Act
    const formatted = reformatMarkup(html), field = createInspectorFixture(formatted).fields.draft;
    // Assert: quote changes cannot split a valid attribute or invent extra attributes.
    assert.notEqual(formatted, html);
    assert.equal(field.getAttribute('placeholder'), placeholder);
    assert.equal(field.getAttribute('title'), original.getAttribute('title'));
    assert.equal(extractInspectorMarkup(formatted).nodes[0].attributes.size, 3);
  });
}

// Objective: retain the narrow authored SDPI background guard, not a CSS renderer.
for (const [label, css, valid] of [
  ['no optional styling', '', true],
  ['status styling', '#settings-status {color:rebeccapurple; margin:2em}', true],
  ['SDPI foreground styling', 'sdpi-item {color:inherit}', true],
  ['native picker background', '#themeColor {background:transparent}', true],
  ['SDPI background shorthand', 'sdpi-item {background:black}', false],
  ['SDPI background property and grouped selectors', 'a, SDPI-item > small { BACKGROUND-COLOR: black; }', false],
]) {
  test(`static stylesheet safety ${valid ? 'accepts' : 'rejects'} ${label}`, () => {
    // Arrange: no production CSS is copied, rewritten or required to exist.
    const html = `<style>${css}</style>${inspectorTestMarkup}`;
    // Act
    const verify = () => assertInspectorMarkup(html);
    // Assert: this establishes only static declaration safety, not computed styles.
    if (valid) assert.doesNotThrow(verify); else assert.throws(verify, assert.AssertionError);
  });
}

// Edits below apply only to controlled test input, never product sources/artifacts.
function mutateMarkup(html, select, edit) {
  const { nodes, scripts } = extractInspectorMarkup(html);
  const matches = [...nodes, ...scripts].filter(select);
  assert.equal(matches.length, 1, 'mutation must identify exactly one target');
  const node = matches[0];
  const draft = { tag: node.tag, attributes: new Map(node.attributes),
    content: html.slice(node.openEnd, node.closeStart), remove: false };
  edit(draft);
  const attributes = [...draft.attributes].map(([name, value]) => `${name}="${value.replaceAll('"', '&quot;')}"`).join(' ');
  const opening = `<${draft.tag} ${attributes}>`;
  const replacement = draft.remove ? '' : opening + (node.end === node.openEnd ? '' : `${draft.content}</${draft.tag}>`);
  return html.slice(0, node.start) + replacement + html.slice(node.end);
}
const idIs = id => node => node.attributes.get('id') === id;
const presetIs = value => node => node.tag === 'option' && node.attributes.get('value') === value
  && node.parent.attributes.get('id') === 'intervalPreset';
const entryScript = node => node.tag === 'script' && node.attributes.get('src') === 'run.js';
const body = node => node.tag === 'body';

// Objective: ancestor visibility survives arbitrary anonymous wrappers, not a fixed layout.
test('hidden ancestry follows anonymous wrappers and their current state', () => {
  // Arrange
  const fixture = createInspectorFixture('<section hidden><div><input id="nested" /></div></section>');
  const control = fixture.getElementById('nested');
  // Act
  const initiallyHidden = isHiddenByAncestry(control);
  control.parentElement.parentElement.hidden = false;
  const shown = isHiddenByAncestry(control);
  control.parentElement.hidden = true;
  // Assert
  assert.equal(initiallyHidden, true); assert.equal(shown, false);
  assert.equal(isHiddenByAncestry(control), true); assert.equal(control.hidden, false);
});

for (const [id, container] of [['actionOnPress', 'body'], ['intervalPreset', 'body'],
  ['custom-interval', 'body'], ['intervalSeconds', 'timer-controls']]) {
  test(`static visibility boundaries reject misplaced ${id} despite retained control semantics`, () => {
    // Arrange: relocate only independent test input, keeping accessible labels and values.
    const node = extractInspectorMarkup(inspectorTestMarkup).nodes.find(idIs(id));
    const control = inspectorTestMarkup.slice(node.start, node.end);
    const removed = mutateMarkup(inspectorTestMarkup, idIs(id), draft => { draft.remove = true; });
    const misplaced = mutateMarkup(removed, container === 'body' ? body : idIs(container), draft => {
      draft.content += `<sdpi-item label="Relocated control">${control}</sdpi-item>`;
    });
    // Act
    const verify = () => assertInspectorMarkup(misplaced);
    // Assert: rejection must be about managed visibility, not lost naming or values.
    assert.notEqual(misplaced, inspectorTestMarkup);
    assert.throws(verify, /must be within/);
  });
}

for (const [defect, select, edit] of [
  ['missing hidden attribute', idIs('timer-controls'), node => node.attributes.delete('hidden')],
  ['missing custom hidden attribute', idIs('custom-interval'), node => node.attributes.delete('hidden')],
  ['wrong live region', idIs('settings-status'), node => node.attributes.set('aria-live', 'off')],
  ['missing status role', idIs('settings-status'), node => node.attributes.delete('role')],
  ['wrong preset value', presetIs('60'), node => node.attributes.set('value', '61')],
  ['empty preset label', presetIs('60'), node => { node.content = ''; }],
  ['duplicate preset value', presetIs('60'), node => node.attributes.set('value', '30')],
  ['missing preset', presetIs('custom'), node => { node.remove = true; }],
  ['invalid press choice', node => node.tag === 'option' && node.attributes.get('value') === 'stop', node => node.attributes.set('value', 'invalid')],
  ['remote script', entryScript, node => node.attributes.set('src', 'https://example.invalid/run.js')],
  ['inline script', entryScript, node => { node.content = 'unexpected()'; }],
  ['additional settings writer', idIs('intervalPreset'), node => node.attributes.set('setting', 'intervalSeconds')],
  ['wrong picker element', idIs('executable'), node => { node.tag = 'sdpi-textfield'; }],
  ['wrong native color type', idIs('themeColor'), node => node.attributes.set('type', 'text')],
  ['missing color accessibility name', idIs('themeColor'), node => node.attributes.delete('aria-label')],
  ['missing picker accessibility name', node => node.tag === 'sdpi-item' && node.attributes.get('label') === 'Program', node => node.attributes.delete('label')],
  ['disabled executable', idIs('executable'), node => node.attributes.set('disabled', '')],
  ['readonly arguments', idIs('argsText'), node => node.attributes.set('readonly', '')],
  ['environment field', body, node => { node.content += '<input id="environment" />'; }],
  ['persisted mode control', body, node => { node.content += '<sdpi-select id="mode"></sdpi-select>'; }],
  ['Apply writer', body, node => { node.content += '<button>Apply</button>'; }],
  ['HTML status content', idIs('settings-status'), node => { node.content = '<b>unexpected</b>'; }],
  ['duplicate writer control', body, node => { node.content += '<sdpi-file id="executable"></sdpi-file>'; }],
]) {
  for (const [variant, input] of markupVariants) {
    test(`static control assertions still reject ${defect} in ${variant} markup`, () => {
      // Arrange
      const html = input;
      // Act
      const invalid = mutateMarkup(html, select, edit);
      // Assert: a no-op fixture must never masquerade as a rejected defect.
      assert.notEqual(invalid, html, 'mutation must change its input');
      assert.throws(() => assertInspectorMarkup(invalid), assert.AssertionError);
    });
  }
}

test('static bindings accept an unspecified initial theme and plain initial status text', () => {
  // Arrange: presentation defaults and wording are not persisted configuration.
  const withoutColor = mutateMarkup(inspectorTestMarkup, idIs('themeColor'), node => node.attributes.delete('value'));
  const input = mutateMarkup(withoutColor, idIs('settings-status'), node => { node.content = 'Ready for configuration'; });
  // Act
  const verify = () => assertInspectorMarkup(input);
  // Assert: effective theme fallback and status updates are exercised by controller tests.
  assert.doesNotThrow(verify);
});

for (const id of ['executable', 'argsText', 'cwd', 'title', 'themeColor', 'settings-status',
  'intervalPreset', 'intervalSeconds', 'actionOnPress', 'timer-controls', 'custom-interval', 'github-project', 'ask-chatgpt']) {
  test(`static bindings reject missing ${id}`, () => {
    // Arrange
    const input = inspectorTestMarkup;
    // Act
    const invalid = mutateMarkup(input, idIs(id), node => { node.remove = true; });
    // Assert
    assert.notEqual(invalid, input);
    assert.throws(() => assertInspectorMarkup(invalid), assert.AssertionError);
  });
}

test('boundary fixture rejects ambiguous duplicate control IDs rather than selecting a writer', () => {
  // Arrange
  const html = '<input id="draft" /><input id="draft" />';
  // Act
  const create = () => createInspectorFixture(html);
  // Assert
  assert.throws(create, assert.AssertionError);
});

// Reject ambiguous attributes instead of emulating a browser's recovery rules.
for (const [label, html] of [
  ['role', '<p role="button" role="status"></p>'],
  ['mixed-case role', "<p ROLE='button' role='status'></p>"],
  ['ID', "<input id='wrong' ID='executable' />"],
  ['script source', "<script SRC='remote.js' src='run.js'></script>"],
  ['style attribute', "<style media='print' MEDIA='screen'></style>"],
]) {
  test(`static extraction rejects duplicate ${label} attributes consistently`, () => {
    // Arrange
    const input = html;
    // Act
    const extract = () => extractInspectorMarkup(input), fixture = () => createInspectorFixture(input);
    // Assert
    assert.throws(extract, { message: 'Duplicate static inspector attribute' });
    assert.throws(fixture, { message: 'Duplicate static inspector attribute' });
  });
}

// Objective: an actual missing required link still fails the existing production entry.
for (const id of [undefined, 'github-project', 'ask-chatgpt']) {
  test(`built inspector initialization ${id ? `rejects absent ${id}` : 'accepts complete markup'} without connection side effects`, () => {
    // Arrange
    const html = inspectorTestMarkup;
    const script = readFileSync(new URL('../git.renaudcerrato.deckforge.sdPlugin/ui/run.js', import.meta.url), 'utf8');
    const source = createInspectorFixture(html);
    if (id) assert.ok(source.getElementById(id), 'required link must exist before removal');
    const input = id ? mutateMarkup(html, idIs(id), node => { node.remove = true; }) : html;
    const fixture = createInspectorFixture(input);
    const unrelated = [...fixture.elements].filter(([key]) => key !== id);
    if (id) {
      assert.notEqual(input, html);
      assert.equal(fixture.getElementById(id), null, 'required link must be absent before bundle evaluation');
      assert.deepEqual([...fixture.elements.keys()], [...source.elements.keys()].filter(key => key !== id));
    }
    const effects = { timers: 0, sockets: 0, settings: 0 };
    const context = { window: { addEventListener() {} },
      document: { readyState: 'complete', getElementById: fixture.getElementById },
      setTimeout() { effects.timers++; }, clearTimeout() {},
      WebSocket: class { constructor() { effects.sockets++; } send() { effects.settings++; } },
    };
    // Act
    let failure;
    try { runInNewContext(script, context, { timeout: 1000 }); } catch (error) { failure = error; }
    // Assert
    if (id) assert.equal(fixture.getElementById(id), null);
    for (const [key, field] of unrelated) assert.equal(fixture.getElementById(key), field);
    assert.equal(failure !== undefined, id !== undefined);
    assert.deepEqual(effects, { timers: 0, sockets: 0, settings: 0 });
    if (!id) assert.equal(typeof context.window.connectElgatoStreamDeckSocket, 'function');
  });
}

test('inspector fixtures isolate values, attributes, visibility, status and listeners', () => {
  // Arrange
  const first = createInspectorFixture(), second = createInspectorFixture();
  let firstEvents = 0, secondEvents = 0;
  first.fields.argsText.addEventListener('valuechange', () => { firstEvents++; });
  second.fields.argsText.addEventListener('valuechange', () => { secondEvents++; });
  const hint = second.fields.cwd.renderedHint;
  // Act
  first.fields.argsText.value = 'first'; first.fields.cwd.setAttribute('placeholder', 'changed');
  first.fields.cwd.requestUpdate(); first.fields.timerControls.hidden = false;
  first.fields.status.textContent = 'first status'; second.fields.argsText.value = 'second';
  // Assert
  assert.equal(first.fields.argsText.value, 'first'); assert.equal(second.fields.argsText.value, 'second');
  assert.equal(first.fields.cwd.renderedHint, 'changed'); assert.equal(second.fields.cwd.renderedHint, hint);
  assert.equal(second.fields.cwd.getAttribute('placeholder'), hint);
  assert.equal(second.fields.timerControls.hidden, true); assert.equal(second.fields.status.textContent, '');
  assert.deepEqual([firstEvents, secondEvents], [1, 1]);
});

test('SDPI edits strip CRLF and dispatch synchronously without detail, then respect listener removal', () => {
  // Arrange
  const field = createInspectorFixture().fields.argsText, observed = [];
  const listener = event => observed.push([field.value, event.type, event.bubbles, event.detail]);
  field.addEventListener('valuechange', listener);
  // Act
  field.value = 'a\r\nb\rc\nd';
  const synchronous = observed.length;
  field.removeEventListener('valuechange', listener); field.userEdit('after\nremoval');
  // Assert
  assert.equal(synchronous, 1);
  assert.deepEqual(observed, [['abcd', 'valuechange', false, undefined]]);
  assert.equal(field.value, 'afterremoval');
});

test('native color assignment and event delivery are independent and listener removal is respected', () => {
  // Arrange
  const field = createInspectorFixture().fields.themeColor, events = [];
  const input = () => events.push('input'), change = () => events.push('change');
  field.addEventListener('input', input); field.addEventListener('change', change);
  field.addEventListener('valuechange', () => events.push('unexpected SDPI event'));
  // Act
  field.value = '#abcdef'; const assigned = [...events];
  field.dispatch('input'); field.dispatch('change');
  field.removeEventListener('input', input); field.removeEventListener('change', change);
  field.userEdit('#123456'); field.dispatch('input'); field.dispatch('change');
  // Assert
  assert.deepEqual(assigned, []); assert.deepEqual(events, ['input', 'change']); assert.equal(field.value, '#123456');
});

test('placeholder attributes repaint only on requestUpdate and unsupported SDPI property text fails', () => {
  // Arrange
  const field = createInspectorFixture().fields.cwd, original = field.renderedHint;
  // Act
  field.setAttribute('placeholder', 'synthetic hint'); const pending = field.renderedHint;
  field.requestUpdate();
  let failure; try { field.placeholder = 'unsupported'; } catch (error) { failure = error; }
  // Assert
  assert.equal(pending, original); assert.equal(field.renderedHint, 'synthetic hint');
  assert.equal(field.getAttribute('placeholder'), 'synthetic hint'); assert.ok(failure instanceof TypeError);
});

test('status accepts literal plaintext and rejects HTML insertion without changing its text', () => {
  // Arrange
  const status = createInspectorFixture().fields.status;
  // Act
  status.textContent = '<synthetic>literal</synthetic>';
  let failure; try { status.innerHTML = '<synthetic>HTML</synthetic>'; } catch (error) { failure = error; }
  // Assert
  assert.equal(status.textContent, '<synthetic>literal</synthetic>');
  assert.equal(failure?.message, 'Status must remain plaintext');
});

const adapterCodes = await loadAdapterCode(['run', 'once', 'timer']);
const syntheticProcess = platform => ({ platform, env: platform === 'win32'
  ? { LOCALAPPDATA: 'C:/synthetic/local' } : {}, cwd: () => '/synthetic/cwd' });
// Compile actual import syntax through the same loader; the probe exists only in memory.
const pathProbe = fileURLToPath(new URL('../src/actions/harness-path-probe.ts', import.meta.url));
const pathProbeCodes = new Map(adapterCodes);
pathProbeCodes.set(pathProbe, ts.transpileModule(`
  import paths, { join, isAbsolute, sep } from 'node:path';
  export function inspect(base: string) {
    return { named: join(base, 'Library', 'Application Support'),
      default: paths.join(base, 'Library', 'Application Support'), sep,
      absolute: isAbsolute(base), relative: isAbsolute('synthetic/home'),
      sameImplementation: join === paths.join && isAbsolute === paths.isAbsolute };
  }
`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText);

// Objective: follow extensionless TS and transitive MJS imports, including real
// parsing and validation, under the same synthetic platform as the adapter.
for (const platform of ['darwin', 'win32']) {
  test(`named and default path imports follow the same synthetic ${platform} namespace rather than the host`, () => {
    // Arrange
    const load = createAdapterLoader(pathProbeCodes, { process: syntheticProcess(platform) });
    const base = platform === 'win32' ? 'C:/synthetic/home' : '/synthetic/home';
    // Act
    const result = load('./harness-path-probe').inspect(base);
    // Assert
    const joined = platform === 'win32'
      ? String.raw`C:\synthetic\home\Library\Application Support`
      : '/synthetic/home/Library/Application Support';
    assert.deepEqual(result, { named: joined, default: joined, sep: platform === 'win32' ? '\\' : '/',
      absolute: true, relative: false, sameImplementation: true });
  });

  test(`adapter graph uses real script draft parsing with ${platform} paths and argument grammar`, () => {
    // Arrange
    const load = createAdapterLoader(adapterCodes, { process: syntheticProcess(platform) });
    const interpreter = platform === 'win32' ? 'C:/synthetic/python.exe' : '/synthetic/python';
    const input = { source: 'print("synthetic")', extension: 'py', interpreter,
      args: platform === 'win32' ? String.raw`{{script}} C:\temp\new` : String.raw`{{script}} two\ words` };
    // Act
    const parser = load('../script-import'), draft = parser.parseScriptDraft(input);
    const argv = load('../core/arguments.mjs').parseArguments(draft.args);
    const cached = load('../script-import');
    // Assert
    assert.equal(cached, parser);
    assert.deepEqual(draft, { ...input, cwd: '' });
    assert.deepEqual(argv, ['{{script}}', platform === 'win32' ? String.raw`C:\temp\new` : 'two words']);
    assert.equal(load('../core/execution-paths.mjs').executionPlatform(), platform === 'win32' ? 'win32' : 'posix');
  });

  test(`adapter graph rejects malformed script drafts using real ${platform} validation`, () => {
    // Arrange
    const load = createAdapterLoader(adapterCodes, { process: syntheticProcess(platform) });
    const { parseScriptDraft } = load('../script-import');
    const invalid = [{ source: '', extension: 'py' }, { source: 'synthetic', extension: '../py' },
      { source: 'synthetic', extension: 'py', interpreter: 'relative/python' },
      { source: 'synthetic', extension: 'py', args: '{{script}}' }];
    // Act
    const failures = invalid.map(input => { try { parseScriptDraft(input); } catch (error) { return error; } });
    // Assert
    assert.ok(failures.every(error => error?.diagnosticCode === 'INVALID_SETTINGS'
      && error.message === 'Script import needs correction.'));
  });

  test(`real ${platform} script writer is stopped at the filesystem boundary`, async () => {
    // Arrange
    const load = createAdapterLoader(adapterCodes, { process: syntheticProcess(platform) });
    const { parseScriptDraft, writeImportedScript } = load('../script-import');
    const draft = parseScriptDraft({ source: 'print("synthetic")', extension: 'py',
      interpreter: platform === 'win32' ? 'C:/synthetic/python.exe' : '/synthetic/python' });
    // Act
    const writing = writeImportedScript(draft);
    // Assert: no real homedir, filesystem lookup, directory or file creation.
    await assert.rejects(writing, { message: 'Unexpected filesystem access in adapter harness' });
  });
}

test('adapter loader permits explicit pure dependencies but rejects unknown externals and escaping paths', () => {
  // Arrange
  const load = createAdapterLoader(adapterCodes, { process: syntheticProcess('darwin') });
  // Act
  const buffer = load('node:buffer').Buffer.from('synthetic').toString();
  const failures = ['node:child_process', 'node:fs', 'unexpected-package', '../../outside.mjs'].map(name => {
    try { load(name); } catch (error) { return error; }
  });
  // Assert
  assert.equal(buffer, 'synthetic');
  assert.ok(failures.slice(0, 3).every(error => error?.message.startsWith('Unexpected adapter boundary:')));
  assert.equal(failures[3]?.message, 'Adapter module must be a source .ts or .mjs file');
});

// Objective: shared compiled text must not share module-level runtime owners or
// authority. Same context ID in independent harnesses remains independent.
test('adapter loaders isolate runtime ownership, configuration and process state', async t => {
  // Arrange
  function harness(executable) {
    const launches = [], replies = [];
    let settings = { executable, argsText: '' };
    const runtime = { id: 'same-synthetic-context', manifestId: 'git.renaudcerrato.deckforge.stream',
      isKey: () => true, coordinates: { row: 0, column: 0 },
      device: { id: 'synthetic-device', isConnected: true },
      async getSettings() { return structuredClone(settings); },
      async setSettings(next) { settings = structuredClone(next); }, async setImage() {}, async setTitle() {},
    };
    const sdk = { logger: { info() {}, warn() {} }, ui: { async sendToPropertyInspector(reply) { replies.push(reply); } } };
    const load = createAdapterLoader(adapterCodes, { process: syntheticProcess('darwin'), resolve(name) {
      if (name === '@elgato/streamdeck') return { default: sdk, SingletonAction: class {}, action: () => value => value };
      if (name === '../core/process-runner.mjs') return { startProcessRun(input) {
        let finish;
        const done = new Promise(resolve => { finish = resolve; });
        const launch = { input, stopped: false }; launches.push(launch);
        return { done, async stop() { launch.stopped = true; finish({ status: 'stopped' }); return true; } };
      } };
    } });
    const registry = Object.fromEntries(['onDeviceDidConnect', 'onDeviceDidDisconnect', 'onSystemDidWakeUp']
      .map(name => [name, () => ({ dispose() {} })]));
    const { RunAction } = load('./run'), action = new RunAction(registry);
    t.after(async () => {
      await action.onWillDisappear({ action: runtime });
    });
    const send = (type, requestId, extra = {}) => action.onSendToPlugin({ action: runtime,
      payload: { type, requestId, context: runtime.id, inspectorId: 'isolation-pi', ...extra } });
    return { action, runtime, launches, replies,
      appear: () => action.onWillAppear({ action: runtime, payload: { settings } }),
      press: () => action.onKeyDown({ action: runtime, payload: { settings } }),
      async edit(changes) {
        await send('canvas:hello', 1); await send('canvas:claim', 2, { token: replies.at(-1).token });
        await send('canvas:edit', 3, { changes });
      },
    };
  }
  const first = harness('/synthetic/first'), second = harness('/synthetic/second');
  // Act
  await first.appear(); await second.appear(); await first.press(); await second.press();
  await first.press();
  await first.edit({ title: 'first title' });
  // Assert
  assert.deepEqual(first.launches.map(launch => launch.input.executable), ['/synthetic/first']);
  assert.deepEqual(second.launches.map(launch => launch.input.executable), ['/synthetic/second']);
  assert.equal(first.launches[0].stopped, true); assert.equal(second.launches[0].stopped, false);
  assert.equal(first.replies.at(-1).status, 'saved');
  assert.deepEqual(await first.runtime.getSettings(), { executable: '/synthetic/first', argsText: '', title: 'first title' });
  assert.deepEqual(await second.runtime.getSettings(), { executable: '/synthetic/second', argsText: '' });
});
