import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageLineFramer } from '../src/core/image-lines.mjs';

const LIMIT = 262_144;
function collect(chunks) {
  const lines = [];
  const framer = createImageLineFramer({ onLine: line => lines.push(line) });
  for (const chunk of chunks) framer.push(chunk);
  framer.finish();
  return lines;
}

// MVP: framing preserves text; image-update owns content validation.
test('every two-chunk split preserves UTF-8, blank filtering, CRLF, and multiple records', () => {
  // Arrange
  const bytes = Buffer.from('\n \t\r\n <svg>é😀</svg> \r\n{"image":"<svg/>"}\n');
  const expected = [' <svg>é😀</svg> ', '{"image":"<svg/>"}'];
  // Act
  const results = Array.from({ length: bytes.length + 1 }, (_, split) => collect([bytes.subarray(0, split), bytes.subarray(split)]));
  // Assert
  for (const result of results) assert.deepEqual(result, expected);
});

test('byte-at-a-time input handles multibyte characters and CR/LF boundaries', () => {
  // Arrange
  const bytes = Buffer.from('<svg>é中😀</svg>\r\n\n<svg/>\n');
  // Act
  const result = collect(Array.from(bytes, byte => Uint8Array.of(byte)));
  // Assert
  assert.deepEqual(result, ['<svg>é中😀</svg>', '<svg/>']);
});

test('blank records and blank unterminated EOF are ignored', () => {
  // Arrange
  const input = Buffer.from('\n\r\n \t\n \t');
  // Act
  const result = collect([input]);
  // Assert
  assert.deepEqual(result, []);
});

test('framing removes only delimiter bytes and does not parse content', () => {
  // Arrange
  const lines = ['  <svg malformed  ', '<svg>\rinside</svg>', '\ufeff<svg/>', 'private plain text'];
  // Act
  const result = collect([Buffer.from(lines.join('\n') + '\n')]);
  // Assert
  assert.deepEqual(result, lines);
});

test('many records in one read are emitted synchronously without a returned frame array', () => {
  // Arrange
  let count = 0;
  let last;
  const framer = createImageLineFramer({ onLine(line) { count++; last = line; } });
  const lines = Array.from({ length: 10_000 }, (_, index) => `<svg>${index}</svg>`);
  // Act
  const result = framer.push(Buffer.from(lines.join('\n') + '\n'));
  framer.finish();
  // Assert
  assert.equal(result, undefined);
  assert.equal(count, lines.length);
  assert.equal(last, lines.at(-1));
});

for (const delimiter of ['\n', '\r\n']) {
  test(`exact byte limit excludes ${JSON.stringify(delimiter)}, including split CR/LF`, () => {
    // Arrange
    const line = '😀'.repeat(LIMIT / 4);
    const bytes = Buffer.from(line + delimiter);
    // Act
    const result = collect([bytes.subarray(0, LIMIT), bytes.subarray(LIMIT, bytes.length - 1), bytes.subarray(bytes.length - 1)]);
    // Assert
    assert.deepEqual(result, [line]);
  });
}

const invalid = [
  ['oversized LF', [Buffer.from('x'.repeat(LIMIT + 1) + '\n')]],
  ['oversized CRLF', [Buffer.from('x'.repeat(LIMIT + 1) + '\r\n')]],
  ['oversized unfinished', [Buffer.alloc(LIMIT, 120), Uint8Array.of(120)]],
  ['byte-not-character limit', [Buffer.from('😀'.repeat(LIMIT / 4) + 'é\n')]],
  ['oversized blank', [Buffer.from(' '.repeat(LIMIT + 1) + '\n')]],
  ['invalid continuation', [Uint8Array.of(0xc3, 0x28, 10)]],
  ['overlong encoding', [Uint8Array.of(0xc0, 0xaf, 10)]],
  ['surrogate encoding', [Uint8Array.of(0xed, 0xa0, 0x80, 10)]],
  ['truncated at newline', [Uint8Array.of(0xf0, 0x9f, 10)]],
  ['truncated at EOF', [Uint8Array.of(0xf0, 0x9f)]],
  ['nonblank EOF', [Buffer.from('<svg>private</svg>')]],
  ['CR without LF', [Buffer.from('<svg/>\r')]],
];
for (const [label, chunks] of invalid) {
  test(`${label} fails with no output or diagnostic leakage`, () => {
    // Arrange
    const lines = [];
    const framer = createImageLineFramer({ onLine: line => lines.push(line) });
    let failure;
    // Act
    try { for (const chunk of chunks) framer.push(chunk); framer.finish(); } catch (error) { failure = error; }
    // Assert
    assert.ok(failure instanceof Error);
    assert.equal(failure.message, 'Image protocol error.');
    assert.equal(failure.cause, undefined);
    assert.deepEqual(lines, []);
  });
}

test('unfinished oversized input fails on the first excess byte without waiting for EOF', () => {
  // Arrange
  const framer = createImageLineFramer({ onLine() {} });
  framer.push(Buffer.alloc(LIMIT, 120));
  let failure;
  // Act
  try { framer.push(Uint8Array.of(120)); } catch (error) { failure = error; }
  // Assert
  assert.equal(failure?.message, 'Image protocol error.');
});
