import test from 'node:test';
import assert from 'node:assert/strict';
import { parseImageUpdate } from '../src/core/image-update.mjs';

for (const mime of ['png', 'jpeg', 'svg+xml', 'webp']) {
  test(`accepts static ${mime} base64 without fully decoding the image`, () => {
    // Arrange: syntactically valid base64, not a valid image file.
    const image = `data:image/${mime};base64,YQ==`;
    // Act
    const update = parseImageUpdate(image);
    // Assert
    assert.deepEqual(update, { image });
  });
}

for (const image of ['<svg/>', '<svg><broken></svg>', '<svg><foreignObject>é😀 #%</foreignObject></svg>']) {
  test('raw recognizable SVG is encoded, not XML parsed', () => {
    // Arrange
    const expected = `data:image/svg+xml,${encodeURIComponent(image)}`;
    // Act
    const update = parseImageUpdate(image);
    // Assert
    assert.deepEqual(update, { image: expected });
  });
}

for (const title of [undefined, '', 'Ready é😀']) {
  test(`legacy JSON envelope with title ${JSON.stringify(title)} is not a raw image`, () => {
    // Arrange
    const image = 'data:image/png;base64,YQ==';
    const input = { image, ignored: { private: true } };
    if (title !== undefined) input.title = title;
    let failure;
    // Act
    try { parseImageUpdate(JSON.stringify(input)); } catch (error) { failure = error; }
    // Assert
    assert.equal(failure?.message, 'Image protocol error.');
  });
}

test('raw image helper never enters a JSON SVG branch', () => {
  // Arrange
  const image = '<svg>é</svg>';
  let failure;
  // Act
  try { parseImageUpdate(JSON.stringify({ image, title: '' })); } catch (error) { failure = error; }
  // Assert
  assert.equal(failure?.message, 'Image protocol error.');
});

const invalid = [
  'private progress 42%', 'layout: private', '<svg-not-a-root/>', '<html/>',
  'data:image/gif;base64,YQ==', 'data:text/plain;base64,YQ==', 'data:image/png,YQ==',
  'data:image/png;base64,', 'data:image/png;base64,%%%=', 'data:image/png;base64,Y===',
  'data:image/png;base64,YQ=', 'data:image/png;base64,Y Q==',
  '{private malformed', '{}', 'null', '[]', '{"image":42}', '{"image":null}',
  '{"image":"private"}', '{"image":"<svg/>","title":42}', '{"image":"<svg/>","title":null}',
];
for (const [index, line] of invalid.entries()) {
  test(`unsupported image record ${index} fails with a fixed non-sensitive error`, () => {
    // Arrange
    let failure;
    // Act
    try { parseImageUpdate(line); } catch (error) { failure = error; }
    // Assert
    assert.ok(failure instanceof Error);
    assert.equal(failure.message, 'Image protocol error.');
    assert.equal(failure.cause, undefined);
  });
}
