import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { READY_SVG, SETUP_SVG, createLaunchArtwork, getReadyTitle, getExecutableExtension, formatLaunchCaption } from '../src/core/launch-artwork.mjs';
import { createKeyLayout } from '../src/core/key-layout.mjs';
import { svgElements, assertSvgElement, assertPaddedClip, assertKeyFrame, assertSetupWarning } from './helpers/svg-harness.mjs';
const decode = uri => decodeURIComponent(uri.slice('data:image/svg+xml,'.length));
const captionOf = svg => svgElements(svg, 'text').find(text => text['clip-path'])?.text;

// TITLE-1: custom text is literal; only the fallback interprets executable paths.
for (const [title, expected] of [['a/b\\c.d', 'a/b\\c.d'], [' cafe\u0301\n& ', 'café &'],
  ['\u202ea\ud800\uffff', 'a��'], ['', 'report'], [' \t\u202e ', 'report'], [null, 'report'],
  [42, 'report'], ['bad\0title', 'report'], ['x'.repeat(8193), 'report']]) {
  test('TITLE-1 resolves a safe literal title or the current executable fallback', () => {
    // Arrange
    const executable = '/synthetic/report.PY';
    // Act
    const resolved = getReadyTitle(executable, 'posix', title);
    const changed = getReadyTitle('/synthetic/other.SH', 'posix', title);
    const rendered = decode(createLaunchArtwork('ready', resolved, undefined, undefined, getExecutableExtension(executable)));
    // Assert
    assert.equal(resolved, expected); assert.equal(changed, expected === 'report' ? 'other' : expected);
    assert.equal(captionOf(rendered), expected.replace(/&/g, '&amp;'));
    assertSvgElement(rendered, 'text', { text: '.py' }, {}); assert.equal(rendered.includes('/synthetic'), false);
  });
}
test('TITLE-1 8192-unit title remains accepted and grapheme-fitted; larger text falls back', () => {
  // Arrange
  const title = 'é'.repeat(8192);
  // Act
  const resolved = getReadyTitle('/report.py', 'posix', title);
  const rendered = decode(createLaunchArtwork('ready', resolved));
  const oversized = getReadyTitle('/report.py', 'posix', title + 'é');
  // Assert
  assert.equal(resolved, title); assert.equal(oversized, 'report');
  assert.match(captionOf(rendered), /^é+…$/);
  assert.equal(Number(svgElements(rendered, 'text').find(text => text['clip-path'])['font-size']), 16);
});

// S2: only runtime-platform separators select the built-in executable caption.
for (const executable of [String.raw`C:\folder\é & report.EXE`, 'C:/folder/é & report.EXE']) {
  test('Windows executable captions and extension badges use the final basename with XML escaping', () => {
    // Arrange
    const input = executable;
    // Act
    const caption = getReadyTitle(input, 'win32'), extension = getExecutableExtension(input, 'win32');
    const rendered = decode(createLaunchArtwork('ready', caption, undefined, undefined, extension));
    // Assert
    assert.equal(caption, 'é & report'); assert.equal(extension, '.exe');
    assert.equal(captionOf(rendered), 'é &amp; report'); assertSvgElement(rendered, 'text', { text: '.exe' }, {});
    assert.equal(getReadyTitle(input, 'posix'), 'DeckForge Commander'); assert.equal(getExecutableExtension(input, 'posix'), undefined);
  });
}
test('POSIX backslash remains part of the caption while Windows namespace paths have no caption or badge', () => {
  // Arrange
  const literal = String.raw`/folder/name\report.PY`, namespace = String.raw`\\?\C:\report.EXE`;
  // Act
  const caption = getReadyTitle(literal, 'posix'), extension = getExecutableExtension(literal, 'posix');
  const invalid = getReadyTitle(namespace, 'win32'), invalidExtension = getExecutableExtension(namespace, 'win32');
  // Assert
  assert.equal(caption, String.raw`name\report`); assert.equal(extension, '.py');
  assert.equal(invalid, 'DeckForge Commander'); assert.equal(invalidExtension, undefined);
});

for (const [executable, extension, title] of [
  ['/synthetic/report.PY', '.py', 'report'], ['/synthetic/archive.tar.GZ', '.gz', 'archive.tar'],
  ['/synthetic/.ENV', undefined, '.ENV'], ['/synthetic/.env.SH', '.sh', '.env'],
  ['/synthetic/python3', undefined, 'python3'], ['/synthetic/report.', undefined, 'report'],
  ['/synthetic/report', undefined, 'report'], ['/synthetic/report.cafe\u0301', '.café', 'report'],
  ['/synthetic/report.\u202eSH', '. sh', 'report'],
  [`/${'a'.repeat(8188)}.PY`, '.py', undefined],
]) {
  test(`configured executable suffix case ${extension ?? 'absent'} retains extensionless caption`, () => {
    // Arrange: neither argv nor an interpreter's script argument is an input.
    const input = executable;
    // Act
    const actual = getExecutableExtension(input), caption = getReadyTitle(input);
    // Assert
    assert.equal(actual, extension);
    if (title !== undefined) assert.equal(caption, title);
  });
}

for (const [index, input] of [undefined, null, 42, true, 1n, Symbol('suffix'), {}, ['file.py'],
  new String('/synthetic/report.py'), 'report.py', '~/report.py', '/report.py\0', '/folder/',
  `/${'a'.repeat(8189)}.py`].entries()) {
  test(`invalid executable suffix ${index} is absent without inference or coercion`, () => {
    // Arrange
    const executable = input;
    // Act
    const actual = getExecutableExtension(executable);
    // Assert
    assert.equal(actual, undefined);
  });
}

for (const [kind, footer] of [['ready', 'ready'], ['waiting', 'ready'], ['ready', 'exited']]) {
  test(`Stream ${kind}/${footer} adds only a complete themed suffix badge`, () => {
    // Arrange
    const expectedFooter = kind === 'waiting' ? 'loading...' : footer;
    // Act
    const plain = decode(createLaunchArtwork(kind, 'report', undefined, footer));
    const actual = decode(createLaunchArtwork(kind, 'report', undefined, footer, '.PY'));
    // Assert
    const plainText = svgElements(plain, 'text'), badgedText = svgElements(actual, 'text');
    assert.deepEqual(plainText.map(text => text.text), ['Stream', 'report', expectedFooter]);
    assert.deepEqual(badgedText.filter(text => text.text !== '.py'), plainText);
    assert.deepEqual(svgElements(actual, 'rect'), svgElements(plain, 'rect'));
    assertSvgElement(actual, 'text', { text: '.py' }, { 'text-anchor': 'end', 'font-size': 16, fill: '#969696' });
    const caption = assertSvgElement(actual, 'text', { text: 'report' }, { 'text-anchor': 'middle', fill: '#969696' });
    assertPaddedClip(actual, caption, { x: 16, y: 48, width: 112, height: 48 });
    assert.equal(captionOf(actual), 'report');
  });
}

for (const [extension, visible] of [['.lllllli', true], ['.llllllli', false], ['.iiiirr', true], ['.iiiirrx', true], ['.iiiirrxx', false], ['.ww', true], ['.www', false], ['.' + 'x'.repeat(100), false]]) {
  test(`suffix ${extension.length} units is ${visible ? 'whole' : 'wholly hidden'} in the fixed logical badge slot`, () => {
    // Arrange: narrow/wide public examples straddle the 42-unit slot without reproducing its estimator.
    const expected = decode(createLaunchArtwork('ready', 'report'));
    // Act
    const actual = decode(createLaunchArtwork('ready', 'report', undefined, undefined, extension));
    // Assert
    if (visible) assertSvgElement(actual, 'text', { text: extension }, { 'text-anchor': 'end', 'font-size': 16 });
    else assert.equal(actual, expected);
    assert.equal(actual.includes('…'), false);
  });
}

for (const [extension, escaped] of [['.C<', '.c&lt;'], ['.&', '.&amp;'], ['.\"', '.&quot;'], [".'", '.&apos;'], ['.e\u0301', '.é'], ['.\u202eSH', '. sh']]) {
  test('suffix badge normalizes and escapes direct metadata without injecting markup', () => {
    // Arrange
    const input = extension;
    // Act
    const actual = decode(createLaunchArtwork('ready', 'report', '#ABCDEF', undefined, input));
    // Assert
    assertSvgElement(actual, 'text', { text: escaped }, { 'font-size': 16, fill: '#abcdef' });
    assert.equal(/<c\b|\u202e|onload=/.test(actual), false);
    assert.equal(captionOf(actual), 'report');
  });
}

test('hostile suffix objects never execute accessors, coercion or proxy hooks', () => {
  // Arrange
  let reads = 0;
  const hostile = new Proxy({}, { get() { reads++; throw Error('Unexpected access.'); } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const inputs = [hostile, revoked.proxy, { get toString() { reads++; throw Error('Unexpected getter.'); } }];
  const plain = decode(createLaunchArtwork('ready', 'report'));
  // Act
  const results = inputs.map(input => [getExecutableExtension(input), decode(createLaunchArtwork('ready', 'report', undefined, undefined, input))]);
  // Assert
  assert.deepEqual(results, inputs.map(() => [undefined, plain]));
  assert.equal(reads, 0);
});

for (const input of ['.', 'py', '.tar.gz', '/private.py', '.p\0y', '.x'.repeat(5000), Symbol('private'), ['.py']]) {
  test('invalid direct Stream suffix leaves the current plain artwork unchanged', () => {
    // Arrange
    const expected = decode(createLaunchArtwork('ready', 'report'));
    // Act
    const actual = decode(createLaunchArtwork('ready', 'report', undefined, undefined, input));
    // Assert
    assert.equal(actual, expected);
  });
}

for (const input of ['.py', '.', 'py', '.tar.gz', '/private.py', '.p\0y', '.x'.repeat(5000), Symbol('private'), ['.py']]) {
  test('Setup suppresses suffix metadata while malformed direct badges retain pre-badge bytes', () => {
    // Arrange
    const expected = decode(createLaunchArtwork('ready', undefined, undefined, 'setup required'));
    // Act
    const actual = decode(createLaunchArtwork('ready', 'report', undefined, 'setup required', input));
    // Assert
    assert.equal(actual, expected);
  });
}

// Status metadata is allowlisted, not coerced or copied into artwork.
const footerInputs = [
  ['omitted', () => undefined], ['null', () => null], ['number', () => 42],
  ['boolean', () => true], ['empty', () => ''], ['uppercase', () => 'EXITED'],
  ['Timer success', () => 'success'], ['setup uppercase', () => 'SETUP REQUIRED'],
  ['setup leading whitespace', () => ' setup required'], ['setup trailing whitespace', () => 'setup required '],
  ['setup newline', () => 'setup required\n'], ['setup shorthand', () => 'setup'],
  ['setup markup', () => '<script>setup required</script>'],
  ['setup array', () => ['setup required']], ['setup boxed string', () => new String('setup required')],
  ['setup symbol', () => Symbol('setup required')],
  ['setup coercion hook', () => ({ [Symbol.toPrimitive]() { throw new Error('Unexpected coercion.'); } })],
  ['loading', () => 'loading...'], ['markup', () => '<script>private</script>'],
  ['sensitive text', () => 'private-path/env/argv/stderr'], ['array', () => ['exited']],
  ['boxed string', () => new String('exited')], ['symbol', () => Symbol('exited')],
  ['function', () => () => { throw new Error('Unexpected invocation.'); }],
  ['accessors', () => Object.defineProperties({}, {
    toString: { get() { throw new Error('Unexpected accessor.'); } },
    [Symbol.toPrimitive]: { get() { throw new Error('Unexpected accessor.'); } },
  })],
  ['proxy', () => new Proxy({}, { get() { throw new Error('Unexpected proxy access.'); } })],
  ['revoked proxy', () => { const value = Proxy.revocable({}, {}); value.revoke(); return value.proxy; }],
  ['cyclic', () => { const value = {}; value.self = value; return value; }],
];

for (const footer of ['ready', 'exited', 'setup required']) {
  test(`Ready accepts ${footer} without changing caption, styling or geometry`, () => {
    // Arrange
    const expected = decode(createLaunchArtwork('ready', 'report', '#ABCDEF'));
    // Act
    const svg = decode(createLaunchArtwork('ready', 'report', '#ABCDEF', footer));
    // Assert
    if (footer === 'setup required') {
      assert.equal(captionOf(svg), undefined);
      assertSetupWarning(svg);
      assertKeyFrame(svg, '#abcdef');
      assert.equal(svg.includes('report'), false);
    } else {
      assert.equal(svg, expected.replace('>ready</text>', `>${footer}</text>`));
      assert.equal(captionOf(svg), 'report');
    }
  });
}

for (const [label, makeInput] of footerInputs) {
  test(`Ready rejects ${label} footer safely without coercion or disclosure`, () => {
    // Arrange
    const input = makeInput();
    const expected = createLaunchArtwork('ready', 'report');
    const expectedLayout = createKeyLayout('report');
    // Act
    const actual = createLaunchArtwork('ready', 'report', undefined, input);
    const layout = createKeyLayout('report', undefined, undefined, input);
    // Assert
    assert.equal(actual, expected);
    assert.equal(layout, label === 'loading' ? expectedLayout.replace('>ready</text>', '>loading...</text>') : expectedLayout);
  });
}

for (const [label, makeInput] of [...footerInputs, ['ready', () => 'ready'], ['exited', () => 'exited'], ['setup required', () => 'setup required']]) {
  test(`waiting ignores ${label} ready-footer metadata and always uses loading...`, () => {
    // Arrange
    const input = makeInput();
    const expected = createLaunchArtwork('waiting', 'report');
    // Act
    const actual = createLaunchArtwork('waiting', 'report', undefined, input);
    // Assert
    assert.equal(actual, expected);
  });
}

for (const footer of ['ready', 'exited', 'loading...', 'setup required']) {
  test(`undiagnosed shared layout accepts the fixed ${footer} footer`, () => {
    // Arrange
    const expected = createKeyLayout('report', '#ABCDEF');
    // Act
    const actual = createKeyLayout('report', '#ABCDEF', undefined, footer);
    // Assert
    if (footer === 'setup required') {
      assert.equal(captionOf(actual), undefined);
      assertSetupWarning(actual);
    } else {
      assert.equal(actual, expected.replace('>ready</text>', `>${footer}</text>`));
    }
  });
}

for (const caption of ['<x&"\'>', 'cafe\u0301', 'a\nb\rc\t', '\u202ea\ud800\uffff', '😀'.repeat(60), '👨‍👩‍👧‍👦'.repeat(20)]) {
  test('waiting preserves the same escaped, normalized and fitted caption as Ready', () => {
    // Arrange
    const expected = decode(createLaunchArtwork('ready', caption, '#ABCDEF'));
    // Act
    const actual = decode(createLaunchArtwork('waiting', caption, '#ABCDEF', 'exited'));
    // Assert
    assert.equal(actual, expected.replace('>ready</text>', '>loading...</text>'));
    assert.equal(/<x|\u202e|\ud800|\uffff|[\r\t]/.test(actual), false);
    const text = svgElements(actual, 'text').find(element => element['clip-path']);
    const size = Number(text['font-size']);
    assert.ok(size >= 16 && size <= 32);
    assertPaddedClip(actual, text, { x: 16, y: 48, width: 112, height: 48 });
  });
}

for (const kind of ['ready', 'waiting']) {
  test(`${kind} shares the black inset frame and Stream header with its fixed status footer`, () => {
    // Arrange
    const color = '#ABCDEF';
    // Act
    const svg = decode(createLaunchArtwork(kind, 'report', color));
    // Assert
    assertKeyFrame(svg, '#abcdef');
    assertSvgElement(svg, 'text', { text: 'Stream' }, { x: 22, y: 32, 'font-size': 16, fill: '#abcdef' });
    assert.equal(/>Run<|>Loop<|>Error</.test(svg), false);
    assertSvgElement(svg, 'text', { text: kind === 'waiting' ? 'loading...' : 'ready' }, { x: 72, y: 124, 'font-size': 16, fill: '#abcdef', 'text-anchor': 'middle' });
    assert.equal(/<path|<circle|<script|foreignObject|href=|onload=/.test(svg), false);
    assert.equal(captionOf(svg), 'report');
  });
}
test('waiting preserves the script caption and changes only the Ready footer', () => {
  // Arrange
  const caption = 'report';
  // Act
  const a = decode(createLaunchArtwork('waiting', caption));
  const b = decode(createLaunchArtwork('ready', caption));
  // Assert
  assert.equal(a, b.replace('>ready</text>', '>loading...</text>'));
  assert.equal(captionOf(a), caption);
  assertPaddedClip(a, svgElements(a, 'text').find(text => text['clip-path']), { x: 16, y: 48, width: 112, height: 48 });
});
test('static default matches Setup exactly without changing identity or description', () => {
  // Arrange
  const plugin = '../git.renaudcerrato.deckforge.sdPlugin/';
  const manifest = JSON.parse(readFileSync(new URL(`${plugin}manifest.json`, import.meta.url), 'utf8'));
  // Act
  const state = manifest.Actions.find(action => action.UUID === 'git.renaudcerrato.deckforge.stream').States[0];
  const svg = readFileSync(new URL(`${plugin}${state.Image}.svg`, import.meta.url), 'utf8');
  // Assert
  assert.equal(svg, SETUP_SVG);
  assert.equal(svg, decode(createLaunchArtwork('ready', undefined, undefined, 'setup required')));
  assert.notEqual(svg, READY_SVG);
  assert.equal(captionOf(svg), undefined);
  assertSetupWarning(svg);
  assert.equal(svg.includes('DeckForge'), false);
  assert.equal(manifest.Description, 'Script to canvas');
  assert.equal(manifest.UUID, 'git.renaudcerrato.deckforge');
  assert.equal(manifest.Name, 'DeckForge Commander');
  assert.equal(manifest.Author, 'Renaud Cerrato');
  assertSvgElement(svg, 'text', { text: 'setup required' }, { y: 124 });
});
test('configured Ready keeps its caption while Setup uses the warning icon', () => {
  // Arrange: static setup is not a new presentation kind or a configured default.
  // Act
  const ready = decode(createLaunchArtwork('ready'));
  const setup = decode(createLaunchArtwork('ready', undefined, undefined, 'setup required'));
  // Assert
  assert.equal(ready, READY_SVG);
  assertSvgElement(ready, 'text', { text: 'ready' }, { y: 124 });
  assert.equal(setup, SETUP_SVG);
  assert.equal(captionOf(setup), undefined);
  assertSetupWarning(setup);
  assert.notEqual(setup, ready);
});
for (const [input, expected] of [['/program.py', 'program'], ['/private/report é😀.sh', 'report é😀'], ['/private/a\nb\rc\t.py', 'a b c'], ['/private/cafe\u0301.py', 'café'], ['/private/.config', '.config'], ['/private/report.tar.py', 'report.tar']]) {
  test(`Ready basename removes only its last extension: ${expected}`, () => {
    // Arrange
    const executable = input;
    // Act
    const caption = getReadyTitle(executable);
    const svg = decode(createLaunchArtwork('ready', caption));
    // Assert
    assert.equal(caption, expected);
    assert.equal(captionOf(svg), expected);
    assert.equal(svg.includes('/private/'), false);
    assert.equal(/[\r\n\t]/.test(caption), false);
  });
}
for (const name of ['A'.repeat(300), '😀'.repeat(60), 'e\u0301'.repeat(100), '👨‍👩‍👧‍👦'.repeat(20)]) {
  test('artwork fits and grapheme-ellipsizes long captions without changing basename data', () => {
    // Arrange
    const label = formatLaunchCaption(name);
    // Act
    const svg = decode(createLaunchArtwork('ready', label));
    const shown = captionOf(svg);
    const text = svgElements(svg, 'text').find(element => element['clip-path']);
    const size = Number(text['font-size']);
    // Assert
    assert.equal(label, name.normalize('NFC'));
    assert.ok(shown.endsWith('…') && shown.length <= 128);
    assert.ok(size >= 16 && size <= 32);
    assert.equal(/\ud83d$/.test(shown.slice(0, -1)), false);
    if (name.startsWith('👨')) assert.equal(shown.slice(0, -1).split('👨‍👩‍👧‍👦').join(''), '');
    assertPaddedClip(svg, text, { x: 16, y: 48, width: 112, height: 48 });
  });
}
test('caption escapes markup and normalizes directional controls and malformed Unicode', () => {
  // Arrange
  const value = '<x&"\'>\u202ea\ud800\uffff';
  // Act
  const svg = decode(createLaunchArtwork('ready', value));
  // Assert
  assert.ok(svg.includes('&lt;x&amp;&quot;&apos;&gt; a��'));
  assert.equal(/<x|\u202e|\ud800|\uffff/.test(svg), false);
});
for (const [index, value] of [undefined, null, 42, {}, '', 'relative', '~/program', '/program\0', '/', '/folder/', '/' + 'x'.repeat(9000)].entries()) {
  test(`invalid executable ${index} uses a bounded fallback`, () => {
    // Arrange
    const input = value;
    // Act
    const result = getReadyTitle(input);
    // Assert
    assert.equal(result, 'DeckForge Commander');
  });
}
for (const input of ['url(private)', '#abc', '#ffffff" onload="private', null]) {
  test('malformed theme cannot inject artwork', () => {
    // Arrange
    const color = input;
    // Act
    const svg = decode(createLaunchArtwork('ready', 'program', color));
    // Assert
    assertKeyFrame(svg, '#969696');
    assert.equal(/private|onload=/.test(svg), false);
  });
}
for (const input of [undefined, null, {}, 'streaming', 'setup', 'setup required', '<script>private</script>']) {
  test('unknown presentation fails with a fixed error', () => {
    // Arrange
    let failure;
    // Act
    try { createLaunchArtwork(input); } catch (error) { failure = error; }
    // Assert
    assert.equal(failure?.message, 'Invalid launch presentation.');
  });
}
