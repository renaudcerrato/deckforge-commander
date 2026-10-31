import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_THEME_COLOR, normalizeThemeColor, resolveThemeColor, settingsThemeColor } from '../src/core/theme.mjs';

for (const [input, expected] of [['#969696', '#969696'], ['#ABCDEF', '#abcdef'], ['#aB12Cd', '#ab12cd'], ['#000000', '#000000'], ['#FFFFFF', '#ffffff']]) {
  test(`opaque six-digit theme ${input} normalizes without side effects`, () => {
    // Arrange
    const settings = { themeColor: input };
    // Act
    const normalized = normalizeThemeColor(input), rendered = settingsThemeColor(settings);
    // Assert
    assert.equal(normalized, expected);
    assert.equal(rendered, expected);
    assert.deepEqual(settings, { themeColor: input });
  });
}
for (const [index, input] of [undefined, null, 1, {}, [], '#abc', '#11223344', 'red', ' #abcdef', '#abcdef\n', '#gggggg', 'url(private)', '#ffffff" onload="private', '#000000\0'].entries()) {
  test(`invalid edit ${index} fails fixed while malformed stored metadata renders default without repair`, () => {
    // Arrange
    const settings = { themeColor: input };
    let error;
    // Act
    try { normalizeThemeColor(input); } catch (failure) { error = failure; }
    const fallback = resolveThemeColor(input), stored = settingsThemeColor(settings);
    // Assert
    assert.equal(error?.message, 'Invalid theme color.');
    assert.equal(error?.diagnosticCode, 'THEME_COLOR_INVALID');
    assert.equal(error?.cause, undefined);
    assert.equal(fallback, DEFAULT_THEME_COLOR);
    assert.equal(stored, '#969696');
    assert.equal(settings.themeColor, input);
  });
}
test('missing/accessor/inherited/proxy metadata defaults without executing getters', () => {
  // Arrange
  let reads = 0;
  const accessor = { get themeColor() { reads++; throw new Error('private'); } };
  const inherited = Object.create({ themeColor: '#abcdef' });
  const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('private'); } });
  // Act
  const values = [{}, accessor, inherited, proxy, null].map(settingsThemeColor);
  // Assert
  assert.deepEqual(values, Array(5).fill('#969696'));
  assert.equal(reads, 0);
});
