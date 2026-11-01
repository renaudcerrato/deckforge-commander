import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ONCE_READY_SVG, ONCE_SETUP_SVG, createOnceArtwork } from '../src/core/once-artwork.mjs';
import { createOnceKeyLayout } from '../src/core/key-layout.mjs';
import { createLaunchArtwork } from '../src/core/launch-artwork.mjs';
import { createTimerArtwork } from '../src/core/timer-artwork.mjs';
import { svgElements, assertBadgeAddition, assertKeyFrame, assertSetupWarning, assertPaddedClip } from './helpers/svg-harness.mjs';

const decode = image => decodeURIComponent(image.slice('data:image/svg+xml,'.length));
const caption = svg => svgElements(svg, 'text').find(text => text['clip-path'])?.text;

// Objective: Run changes only its header and fixed footer; shared logical geometry stays intact.
for (const [kind, footer, expected] of [['ready', undefined, 'ready'], ['loading', 'success', 'loading...'],
  ['ready', 'success', 'success'], ['ready', 'setup required', 'setup required']]) {
  test(`Run ${kind}/${expected} preserves shared geometry and independent action headers`, () => {
    // Arrange
    const setupFooter = footer === 'setup required' ? footer : undefined;
    const stream = decode(createLaunchArtwork('ready', 'report', '#ABCDEF', setupFooter));
    const loop = decode(createTimerArtwork('ready', 'report', '#ABCDEF', setupFooter));
    // Act
    const actual = decode(createOnceArtwork(kind, 'report', '#ABCDEF', footer));
    // Assert
    assert.equal(actual, stream.replace('>Stream</text>', '>Run</text>').replace('>ready</text>', `>${expected}</text>`));
    assert.equal(loop, stream.replace('>Stream</text>', '>Loop</text>'));
    assert.equal(actual, createOnceKeyLayout('report', '#ABCDEF', expected));
    assertKeyFrame(actual, '#abcdef');
    assert.equal(caption(actual), expected === 'setup required' ? undefined : 'report');
    if (expected === 'setup required') assertSetupWarning(actual);
  });
}
test('Run static manifest Setup is exact including newline and distinct from configured Ready', () => {
  // Arrange
  const root = '../git.renaudcerrato.deckforge.sdPlugin/';
  const manifest = JSON.parse(readFileSync(new URL(root + 'manifest.json', import.meta.url), 'utf8'));
  const state = manifest.Actions.find(action => action.UUID === 'git.renaudcerrato.deckforge.run').States[0];
  // Act
  const asset = readFileSync(new URL(root + state.Image + '.svg', import.meta.url), 'utf8');
  const configured = decode(createOnceArtwork('ready'));
  // Assert
  assert.equal(asset, ONCE_SETUP_SVG); assert.equal(configured, ONCE_READY_SVG);
  assert.equal(asset, decode(createOnceArtwork('ready', undefined, undefined, 'setup required')));
  assert.notEqual(asset, configured); assertKeyFrame(asset, '#969696');
  assert.equal(caption(asset), undefined);
  assertSetupWarning(asset);
  assert.equal(asset.includes('DeckForge'), false);
});
const hostile = () => new Proxy({}, { get() { throw Error('Synthetic forbidden coercion'); } });
for (const render of [createLaunchArtwork, createTimerArtwork, createOnceArtwork]) {
  test('Setup ignores hostile captions and extensions and shows only its warning', () => {
    // Arrange
    let reads = 0;
    const input = new Proxy({}, { get() { reads++; throw Error('Unexpected access.'); } });
    // Act
    const actual = render('ready', input, '#ABCDEF', 'setup required', input);
    // Assert
    assert.equal(actual, render('ready', undefined, '#ABCDEF', 'setup required'));
    assert.equal(reads, 0);
    assert.equal(caption(decode(actual)), undefined);
    assertSetupWarning(decode(actual));
  });
}
for (const [name, input] of [['null', null], ['boxed', new String('success')], ['proxy', hostile()],
  ['markup', '<script>SYNTHETIC_PRIVATE</script>'], ['Stream exited', 'exited'], ['uppercase', 'SUCCESS'], ['loading literal', 'loading...']]) {
  test(`Run rejects ${name} footer without coercion or disclosure`, () => {
    // Arrange
    const expected = createOnceArtwork('ready', 'report');
    // Act
    const actual = createOnceArtwork('ready', 'report', undefined, input);
    const loading = createOnceArtwork('loading', 'report', undefined, input);
    // Assert
    assert.equal(actual, expected); assert.equal(loading, createOnceArtwork('loading', 'report'));
  });
}
for (const input of ['waiting', 'success', undefined, null, new String('ready'), hostile()]) {
  test('Run rejects unsupported presentation kinds rather than treating Loop waiting as loading', () => {
    // Arrange
    const render = () => createOnceArtwork(input);
    // Act
    let error; try { render(); } catch (value) { error = value; }
    // Assert
    assert.ok(error instanceof TypeError); assert.equal(error.message, 'Invalid Run presentation.');
  });
}
for (const [input, expected] of [['a/cafe\u0301', 'a/café'], ['<x&"\'>', '&lt;x&amp;&quot;&apos;&gt;'],
  ['a\nb\rc\t', 'a b c'], [null, 'DeckForge C…'], [hostile(), 'DeckForge C…'],
  [new String('private'), 'DeckForge C…'], ['x'.repeat(8193), 'DeckForge C…']]) {
  test('Run captions normalize, escape or safely fall back consistently across presentations', () => {
    // Arrange
    const footers = ['ready', 'success', 'setup required'];
    // Act
    const outputs = footers.map(footer => decode(createOnceArtwork('ready', input, undefined, footer)));
    outputs.push(decode(createOnceArtwork('loading', input)));
    // Assert
    assert.equal(caption(outputs[2]), undefined);
    assertSetupWarning(outputs[2]);
    assert.ok(outputs.filter((_, index) => index !== 2).every(svg => caption(svg) === expected));
    assert.ok(outputs.every(svg => !/<script|foreignObject|onload=/.test(svg)));
  });
}
test('Run long grapheme caption ellipsizes without splitting a family cluster', () => {
  // Arrange
  const family = '👨‍👩‍👧‍👦';
  // Act
  const actual = decode(createOnceArtwork('ready', family.repeat(20)));
  // Assert
  const shown = caption(actual); assert.ok(shown.endsWith('…'));
  assert.equal(shown.slice(0, -1).split(family).join(''), '');
  const text = svgElements(actual, 'text').find(element => element['clip-path']);
  assert.equal(Number(text['font-size']), 16);
  assertPaddedClip(actual, text, { x: 16, y: 48, width: 112, height: 48 });
});
for (const [kind, footer] of [['ready', 'ready'], ['loading', 'success'], ['ready', 'success']]) {
  test(`Run ${kind}/${footer} adds only a normalized executable badge`, () => {
    // Arrange
    const expected = decode(createOnceArtwork(kind, 'report', '#ABCDEF', footer));
    // Act
    const actual = decode(createOnceArtwork(kind, 'report', '#ABCDEF', footer, '.PY'));
    // Assert
    assertBadgeAddition(expected, actual, '.py', '#abcdef');
  });
}
for (const input of ['py', '.tar.gz', '/synthetic.py', '.www', '.p\0y', '.'.padEnd(8193, 'x'), hostile(), new String('.py')]) {
  test('Run invalid or nonfitting badge preserves exact no-badge bytes', () => {
    // Arrange
    const expected = createOnceArtwork('ready', 'report');
    // Act
    const actual = createOnceArtwork('ready', 'report', undefined, undefined, input);
    // Assert
    assert.equal(actual, expected);
  });
}
test('Run Setup suppresses valid and hostile badges without access', () => {
  // Arrange
  let reads = 0;
  const input = new Proxy({}, { get() { reads++; throw Error('Synthetic access'); } });
  const expected = createOnceArtwork('ready', 'report', undefined, 'setup required');
  // Act
  const outputs = ['.py', input].map(extension => createOnceArtwork('ready', 'report', undefined, 'setup required', extension));
  // Assert
  assert.deepEqual(outputs, [expected, expected]); assert.equal(reads, 0);
});
for (const theme of ['red', null, hostile(), '#abc', '#abcdef00']) {
  test('Run invalid theme cannot inject styling or alter fallback geometry', () => {
    // Arrange
    const expected = createOnceArtwork('ready', 'report');
    // Act
    const actual = createOnceArtwork('ready', 'report', theme);
    // Assert
    assert.equal(actual, expected);
  });
}
