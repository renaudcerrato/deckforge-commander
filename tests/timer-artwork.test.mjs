import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TIMER_READY_SVG, TIMER_SETUP_SVG, createTimerArtwork } from '../src/core/timer-artwork.mjs';
import { createKeyLayout, createTimerKeyLayout } from '../src/core/key-layout.mjs';
import { SETUP_SVG, createLaunchArtwork } from '../src/core/launch-artwork.mjs';
import { createErrorArtwork } from '../src/core/error-artwork.mjs';
import { svgElements, assertSvgElement, assertPaddedClip, assertBadgeAddition, assertKeyFrame, assertSetupWarning } from './helpers/svg-harness.mjs';

const decode = uri => decodeURIComponent(uri.slice('data:image/svg+xml,'.length));
const captionOf = svg => svgElements(svg, 'text').find(text => text['clip-path'])?.text;
const fontSizeOf = svg => Number(svgElements(svg, 'text').find(text => text['clip-path'])?.['font-size']);

for (const [kind, footer, expectedFooter] of [['ready', 'ready', 'ready'], ['waiting', 'success', 'loading...'], ['ready', 'success', 'success']]) {
  test(`Loop ${expectedFooter} retains header and caption while adding a full suffix badge`, () => {
    // Arrange
    const expected = decode(createTimerArtwork(kind, 'report', '#ABCDEF', footer));
    // Act
    const actual = decode(createTimerArtwork(kind, 'report', '#ABCDEF', footer, '.SH'));
    const layout = createTimerKeyLayout('report', '#ABCDEF', expectedFooter, '.SH');
    // Assert
    assertBadgeAddition(expected, actual, '.sh', '#abcdef');
    assert.equal(layout, actual);
    assert.equal(captionOf(actual), 'report');
    assert.equal(/>Stream<|>Timer<|>Run</.test(actual), false);
  });
}

test('Loop Setup suppresses valid and hostile badge metadata without accessing it', () => {
  // Arrange
  let reads = 0;
  const hostile = new Proxy({}, { get() { reads++; throw Error('Unexpected access.'); } });
  const expected = createTimerArtwork('ready', 'report', undefined, 'setup required');
  // Act
  const actual = ['.py', hostile].map(input => createTimerArtwork('ready', 'report', undefined, 'setup required', input));
  // Assert
  assert.deepEqual(actual, [expected, expected]); assert.equal(reads, 0);
});

// Fixed footer metadata is data, never markup or a coercion opportunity.
const rejectedFooters = [
  ['omitted', () => undefined], ['null', () => null], ['number', () => 42],
  ['boolean', () => true], ['bigint', () => 1n], ['empty', () => ''],
  ['uppercase', () => 'SUCCESS'], ['Run footer', () => 'exited'],
  ['loading footer', () => 'loading...'], ['whitespace', () => ' success'],
  ['markup', () => '<script>private</script>'],
  ['sensitive text', () => 'private-path/env/argv/stderr'],
  ['object', () => ({ footer: 'success' })], ['array', () => ['success']],
  ['boxed string', () => new String('success')], ['symbol', () => Symbol('success')],
  ['function', () => () => { throw new Error('Unexpected invocation.'); }],
  ['accessors', () => Object.defineProperties({}, {
    toString: { get() { throw new Error('Unexpected accessor.'); } },
    [Symbol.toPrimitive]: { get() { throw new Error('Unexpected accessor.'); } },
  })],
  ['coercion hook', () => ({ [Symbol.toPrimitive]() { throw new Error('Unexpected coercion.'); } })],
  ['proxy', () => new Proxy({}, { get() { throw new Error('Unexpected proxy access.'); } })],
  ['revoked proxy', () => { const value = Proxy.revocable({}, {}); value.revoke(); return value.proxy; }],
  ['cyclic', () => { const value = {}; value.self = value; return value; }],
];

for (const [label, make] of [...rejectedFooters.filter(([label]) => !['empty', 'uppercase', 'Run footer', 'loading footer', 'whitespace', 'markup', 'sensitive text'].includes(label)),
  ['no dot', () => 'py'], ['multiple suffixes', () => '.tar.gz'], ['path', () => '/private.py'],
  ['NUL', () => '.p\0y'], ['oversized', () => '.' + 'x'.repeat(8192)], ['does not fit', () => '.www']]) {
  test(`Loop ${label} suffix cannot alter no-badge bytes or leak metadata`, () => {
    // Arrange
    const input = make(), expected = createTimerArtwork('ready', 'report');
    // Act
    const actual = createTimerArtwork('ready', 'report', undefined, undefined, input);
    // Assert
    assert.equal(actual, expected);
  });
}

// Setup is one exact literal, not normalized or coerced into a valid footer.
const rejectedSetupFooters = [
  ['setup uppercase', () => 'SETUP REQUIRED'], ['setup leading whitespace', () => ' setup required'],
  ['setup trailing whitespace', () => 'setup required '], ['setup newline', () => 'setup required\n'],
  ['setup shorthand', () => 'setup'], ['setup markup', () => '<script>setup required</script>'],
  ['setup array', () => ['setup required']], ['setup boxed string', () => new String('setup required')],
  ['setup symbol', () => Symbol('setup required')],
  ['setup coercion hook', () => ({ [Symbol.toPrimitive]() { throw new Error('Unexpected coercion.'); } })],
];

for (const [kind, footer, expectedFooter] of [
  ['ready', undefined, 'ready'], ['ready', 'ready', 'ready'],
  ['ready', 'success', 'success'], ['waiting', undefined, 'loading...'],
  ['ready', 'setup required', 'setup required'],
]) {
  test(`Timer ${kind}/${expectedFooter} retains its caption and black logical canvas`, () => {
    // Arrange: geometry is in logical units, not a hardware-pixel claim.
    const caption = 'report';
    // Act
    const uri = createTimerArtwork(kind, caption, '#ABCDEF', footer);
    const svg = decode(uri);
    // Assert
    assert.ok(uri.startsWith('data:image/svg+xml,'));
    assertKeyFrame(svg, '#abcdef');
    assertSvgElement(svg, 'text', { text: 'Loop' }, { x: 22, y: 32, 'font-size': 16, fill: '#abcdef' });
    assertSvgElement(svg, 'text', { text: expectedFooter }, { x: 72, y: 124, 'text-anchor': 'middle', 'font-family': 'Arial,sans-serif', 'font-size': 16, fill: '#abcdef' });
    assert.equal(captionOf(svg), expectedFooter === 'setup required' ? undefined : caption);
    if (expectedFooter === 'setup required') assertSetupWarning(svg);
    else assert.equal(/<path|<circle/.test(svg), false);
    assert.equal(/<script|foreignObject|href=|onload=|>Run<|>Timer<|>Stream<|>Error</.test(svg), false);
  });
}

for (const [label, makeInput] of [...rejectedFooters, ...rejectedSetupFooters]) {
  test(`Timer ready rejects ${label} footer without coercion or disclosure`, () => {
    // Arrange
    const input = makeInput();
    const expected = createTimerArtwork('ready', 'report', '#ABCDEF');
    const expectedLayout = createTimerKeyLayout('report', '#ABCDEF');
    // Act
    const actual = createTimerArtwork('ready', 'report', '#ABCDEF', input);
    const layout = createTimerKeyLayout('report', '#ABCDEF', input);
    // Assert: the lower-level layout alone also accepts its fixed loading literal.
    assert.equal(actual, expected);
    assert.equal(layout, label === 'loading footer'
      ? expectedLayout.replace('>ready</text>', '>loading...</text>') : expectedLayout);
  });
}

for (const [label, makeInput] of [...rejectedFooters, ...rejectedSetupFooters, ['ready', () => 'ready'], ['success', () => 'success'], ['setup required', () => 'setup required']]) {
  test(`Timer waiting ignores ${label} metadata and uses exactly loading...`, () => {
    // Arrange
    const input = makeInput();
    const expected = createTimerArtwork('waiting', 'report');
    // Act
    const actual = createTimerArtwork('waiting', 'report', undefined, input);
    // Assert
    assert.equal(actual, expected);
    assertSvgElement(decode(actual), 'text', { text: 'loading...' }, { y: 124 });
    assert.equal(captionOf(decode(actual)), 'report');
  });
}

for (const footer of ['ready', 'success', 'loading...', 'setup required']) {
  test(`Timer layout accepts only its fixed ${footer} footer without changing the center`, () => {
    // Arrange
    const expected = createTimerKeyLayout('report', '#ABCDEF');
    // Act
    const actual = createTimerKeyLayout('report', '#ABCDEF', footer);
    // Assert
    if (footer === 'setup required') {
      assert.equal(captionOf(actual), undefined);
      assertSetupWarning(actual);
    } else {
      assert.equal(actual, expected.replace('>ready</text>', `>${footer}</text>`));
    }
  });
}

test('Timer static default matches Setup including its trailing newline, not configured Ready', () => {
  // Arrange: static setup must remain separate from configured ready artwork.
  const asset = new URL('../git.renaudcerrato.deckforge.sdPlugin/imgs/actions/timer/key.svg', import.meta.url);
  // Act
  const svg = readFileSync(asset, 'utf8');
  const rendered = decode(createTimerArtwork('ready', undefined, undefined, 'setup required'));
  // Assert
  assert.equal(svg, TIMER_SETUP_SVG);
  assert.equal(rendered, svg);
  assert.notEqual(svg, TIMER_READY_SVG);
  assert.equal(captionOf(svg), undefined);
  assertSetupWarning(svg);
  assert.equal(svg.includes('DeckForge'), false);
  assertSvgElement(svg, 'text', { text: 'setup required' }, { y: 124 });
});

test('Timer configured Ready keeps its caption while Setup uses the warning icon', () => {
  // Arrange
  // Act
  const ready = decode(createTimerArtwork('ready'));
  const setup = decode(createTimerArtwork('ready', undefined, undefined, 'setup required'));
  // Assert
  assert.equal(ready, TIMER_READY_SVG);
  assertSvgElement(ready, 'text', { text: 'ready' }, { y: 124 });
  assert.equal(setup, TIMER_SETUP_SVG);
  assert.equal(captionOf(setup), undefined);
  assertSetupWarning(setup);
  assert.notEqual(setup, ready);
});

// Caption fitting/escaping is shared, while each presentation changes only a fixed footer.
const captions = [
  ['short name', 'report', 'report'], ['literal slash', 'a/b', 'a/b'],
  ['Unicode NFC', 'cafe\u0301', 'café'], ['XML', '<x&"\'>', '&lt;x&amp;&quot;&apos;&gt;'],
  ['controls', 'a\nb\rc\t', 'a b c'],
  ['invalid Unicode', '\u202ea\ud800\uffff', 'a��'],
  ['long ASCII', 'A'.repeat(300)], ['long emoji', '😀'.repeat(60)],
  ['long combining', 'e\u0301'.repeat(100)], ['long graphemes', '👨‍👩‍👧‍👦'.repeat(20)],
];
for (const [label, input, expectedCaption] of captions) {
  test(`Timer ${label} caption is identical in ready, waiting, success and setup`, () => {
    // Arrange
    const color = '#ABCDEF';
    // Act
    const ready = decode(createTimerArtwork('ready', input, color));
    const waiting = decode(createTimerArtwork('waiting', input, color, 'success'));
    const success = decode(createTimerArtwork('ready', input, color, 'success'));
    const setup = decode(createTimerArtwork('ready', input, color, 'setup required'));
    const run = decode(createLaunchArtwork('ready', input, color));
    const shown = captionOf(ready);
    // Assert
    assert.equal(waiting, ready.replace('>ready</text>', '>loading...</text>'));
    assert.equal(success, ready.replace('>ready</text>', '>success</text>'));
    assert.equal(captionOf(setup), undefined);
    assertSetupWarning(setup);
    assert.equal(ready, run.replace('>Stream</text>', '>Loop</text>'));
    assert.ok(fontSizeOf(ready) >= 16 && fontSizeOf(ready) <= 32);
    assert.equal(/<x|\u202e|\ud800|\uffff|[\r\t]/.test(ready), false);
    if (expectedCaption !== undefined) assert.equal(shown, expectedCaption);
    else {
      assert.ok(shown.endsWith('…') && shown.length <= 128);
      assert.equal(fontSizeOf(ready), 16);
      if (label === 'long emoji') assert.equal(shown.slice(0, -1).split('😀').join(''), '');
      if (label === 'long graphemes') assert.equal(shown.slice(0, -1).split('👨‍👩‍👧‍👦').join(''), '');
      if (label === 'long combining') assert.equal(shown.slice(0, -1).split('é').join(''), '');
    }
    assertPaddedClip(ready, svgElements(ready, 'text').find(text => text['clip-path']), { x: 16, y: 48, width: 112, height: 48 });
  });
}

for (const [label, makeInput] of [
  ...rejectedFooters.filter(([label]) => !['empty', 'uppercase', 'Run footer', 'loading footer', 'whitespace', 'markup', 'sensitive text'].includes(label)),
  ['empty caption', () => ''], ['blank caption', () => ' \n\t\u202e'],
  ['oversized caption', () => 'x'.repeat(8_193)],
]) {
  test(`Timer ${label} caption falls back safely in all presentations`, () => {
    // Arrange
    const input = makeInput();
    const cases = [['ready', undefined], ['ready', 'success'], ['ready', 'setup required'], ['waiting', 'success']];
    const expected = cases.map(([kind, footer]) => createTimerArtwork(kind, 'DeckForge Commander', undefined, footer));
    // Act
    const actual = cases.map(([kind, footer]) => createTimerArtwork(kind, input, undefined, footer));
    // Assert
    assert.deepEqual(actual, expected);
  });
}

for (const [input, expected] of [['#ABCDEF', '#abcdef'], ['#000000', '#000000'], ['#FFFFFF', '#ffffff']]) {
  test(`Timer uses opaque normalized theme ${input} without recoloring the black background`, () => {
    // Arrange
    const kinds = [['ready', 'ready'], ['ready', 'success'], ['ready', 'setup required'], ['waiting', 'loading...']];
    // Act
    const artworks = kinds.map(([kind, footer]) => decode(createTimerArtwork(kind, 'report', input, footer)));
    // Assert
    for (const [index, svg] of artworks.entries()) {
      assertKeyFrame(svg, expected);
      assertSvgElement(svg, 'text', { text: 'Loop' }, { fill: expected });
      if (kinds[index][1] === 'setup required') {
        assertSetupWarning(svg);
        assert.equal(captionOf(svg), undefined);
      } else {
        const caption = assertSvgElement(svg, 'text', { text: 'report' }, { fill: expected });
        assertPaddedClip(svg, caption, { x: 16, y: 48, width: 112, height: 48 });
      }
      assertSvgElement(svg, 'text', { text: kinds[index][1] }, { y: 124, fill: expected });
    }
  });
}

for (const [label, makeInput] of [
  ...rejectedFooters, ['CSS URL', () => 'url(private)'], ['short hex', () => '#abc'],
  ['alpha hex', () => '#abcdef80'], ['named color', () => 'red'],
  ['attribute injection', () => '#ffffff" onload="private'],
]) {
  test(`Timer ${label} theme uses the exact safe default`, () => {
    // Arrange
    const input = makeInput();
    const cases = [['ready', 'ready'], ['ready', 'success'], ['ready', 'setup required'], ['waiting', 'success']];
    const expected = cases.map(([kind, footer]) => createTimerArtwork(kind, 'report', '#969696', footer));
    // Act
    const actual = cases.map(([kind, footer]) => createTimerArtwork(kind, 'report', input, footer));
    // Assert
    assert.deepEqual(actual, expected);
  });
}

test('Timer never touches hostile caption, theme or footer coercion hooks', () => {
  // Arrange: counters also detect a coercion error swallowed by a fallback.
  let accesses = 0;
  const input = new Proxy({}, { get() { accesses++; throw new Error('Unexpected access.'); } });
  const expected = [createTimerArtwork('ready'), createTimerArtwork('waiting')];
  // Act
  const actual = ['ready', 'waiting'].map(kind => createTimerArtwork(kind, input, input, input));
  // Assert
  assert.deepEqual(actual, expected);
  assert.equal(accesses, 0);
});

for (const [label, makeInput] of [...rejectedFooters, ...rejectedSetupFooters, ['setup required kind', () => 'setup required'], ['success kind', () => 'success'], ['error kind', () => 'error']]) {
  test(`Timer ${label} presentation rejects with a fixed TypeError`, () => {
    // Arrange
    const input = makeInput();
    let failure;
    // Act
    try { createTimerArtwork(input); } catch (error) { failure = error; }
    // Assert
    assert.ok(failure instanceof TypeError);
    assert.equal(failure.message, 'Invalid timer presentation.');
  });
}

test('Run continues to reject the Timer success footer and preserve its static default', () => {
  // Arrange
  const asset = new URL('../git.renaudcerrato.deckforge.sdPlugin/imgs/actions/run/key.svg', import.meta.url);
  const expected = createLaunchArtwork('ready', 'report');
  const expectedLayout = createKeyLayout('report');
  // Act
  const run = createLaunchArtwork('ready', 'report', undefined, 'success');
  const layout = createKeyLayout('report', undefined, undefined, 'success');
  const staticSvg = readFileSync(asset, 'utf8');
  // Assert
  assert.equal(run, expected);
  assert.equal(layout, expectedLayout);
  assert.equal(staticSvg, SETUP_SVG);
  assert.equal(staticSvg, decode(createLaunchArtwork('ready', undefined, undefined, 'setup required')));
  assert.equal(/>Timer<|>Loop</.test(staticSvg), false);
});

test('Error diagnosis ignores the additive Timer success footer byte-for-byte', () => {
  // Arrange: Error tests separately retain exhaustive fixed diagnostic appearance checks.
  const diagnosis = { code: 'EXEC', lines: ['Executable', 'path invalid'] };
  const expected = decode(createErrorArtwork('INVALID_EXECUTABLE'));
  // Act
  const actual = createKeyLayout('private script caption', undefined, diagnosis, 'success');
  // Assert
  assert.equal(actual, expected);
  assert.equal(/>success<|>ready<|>Timer<|private/.test(actual), false);
});
