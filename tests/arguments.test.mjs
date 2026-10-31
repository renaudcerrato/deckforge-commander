import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArguments, serializeArguments } from '../src/core/arguments.mjs';

// WINDOWS-ARGUMENTS r1: ordinary Windows input is literal, never a shell command.
for (const [label, text, expected] of [
  ['natural paths', String.raw`C:\Scripts\showcase.py C:\temp\new C:\Folder\ --flag`, [String.raw`C:\Scripts\showcase.py`, String.raw`C:\temp\new`, 'C:\\Folder\\', '--flag']],
  ['quoted paths', String.raw`"C:\Program Files\showcase.py" 'D:\Other Files\input' "C:\Folder\"`, [String.raw`C:\Program Files\showcase.py`, String.raw`D:\Other Files\input`, 'C:\\Folder\\']],
  ['grouping and concatenation', String.raw`--flag="two words" pre'fix'" tail" '' "" 'a"b' "a'b"`, ['--flag=two words', 'prefix tail', '', '', 'a"b', "a'b"]],
  ['no path guessing or POSIX escaping', String.raw`C:\Program Files\input two\ words regex\d+`, ['C:\\Program', String.raw`Files\input`, 'two\\', 'words', String.raw`regex\d+`]],
  ['literal shell syntax and Unicode', 'é😀 font++ %TEMP% $HOME $(command) `command` * | ; > &&', ['é😀', 'font++', '%TEMP%', '$HOME', '$(command)', '`command`', '*', '|', ';', '>', '&&']],
  ['explicit ANSI segments', String.raw`pre$'\n'post $'a\'b' '\n' "\r"`, ['pre\npost', "a'b", '\\n', '\\r']],
]) {
  test(`Windows ${label} preserves ordered argv`, () => {
    // Arrange
    const input = text;
    // Act
    const actual = parseArguments(input, 'win32');
    // Assert
    assert.deepEqual(actual, expected);
  });
}

for (const platform of ['win32', 'posix']) {
  test(`${platform} one-line editor serialization preserves difficult literal argv and appended flags`, () => {
    // Arrange: include both quote characters, control lines, empty values and non-path backslashes.
    const argv = ['', 'two words', 'é😀', 'C:\\Folder\\', String.raw`C:\temp\new`, String.raw`regex\d+`,
      `both'"quotes\\`, 'first\r\nsecond\nthird\rfourth', '\t', '$HOME %TEMP% $(cmd);|*', '\ud800'];
    const original = structuredClone(argv);
    // Act
    const text = serializeArguments(argv, platform);
    const actual = parseArguments(`${text.replace(/[\r\n]/g, '')} --append`, platform);
    // Assert
    assert.equal(/[\r\n]/.test(text), false);
    assert.deepEqual(actual, [...original, '--append']);
    assert.deepEqual(argv, original);
  });

  test(`${platform} malformed quoting and invalid input remain fixed private failures`, () => {
    // Arrange: an escaped closing quote cannot terminate an explicit ANSI segment.
    const inputs = [undefined, null, 42, {}, [], "'private", '"private', "$'private\\'", 'private\0'];
    // Act
    const errors = inputs.map(input => { try { parseArguments(input, platform); } catch (error) { return error; } });
    // Assert
    assert.deepEqual(errors.map(error => [error?.message, error?.diagnosticCode, error?.cause]),
      inputs.map(() => ['Invalid arguments.', 'ARGS_TEXT_INVALID', undefined]));
    assert.equal(JSON.stringify(errors).includes('private'), false);
  });

  test(`${platform} serialization rejects invalid argv and accessors without reading them`, () => {
    // Arrange
    let reads = 0;
    const accessor = [];
    Object.defineProperty(accessor, '0', { get() { reads++; return 'private'; } });
    const inputs = [null, 'private', Array(1), [42], ['private\0'], accessor];
    // Act
    const errors = inputs.map(input => { try { serializeArguments(input, platform); } catch (error) { return error; } });
    // Assert
    assert.deepEqual(errors.map(error => [error?.message, error?.diagnosticCode]),
      inputs.map(() => ['Invalid arguments.', 'INVALID_ARGUMENT']));
    assert.equal(reads, 0);
  });
}

test('POSIX keeps escaped spaces and rejects trailing escapes while Windows keeps literal backslashes', () => {
  // Arrange
  const escaped = String.raw`two\ words`, trailing = 'C:\\Folder\\';
  // Act
  const posix = parseArguments(escaped, 'posix'), windows = parseArguments(escaped, 'win32');
  let failure; try { parseArguments(trailing, 'posix'); } catch (error) { failure = error; }
  const literal = parseArguments(trailing, 'win32');
  // Assert
  assert.deepEqual(posix, ['two words']); assert.deepEqual(windows, ['two\\', 'words']);
  assert.equal(failure?.diagnosticCode, 'ARGS_TEXT_INVALID'); assert.deepEqual(literal, [trailing]);
});

test('omitted argument platform follows the host grammar and round-trips literal argv', () => {
  // Arrange
  const platform = process.platform === 'win32' ? 'win32' : 'posix';
  const input = String.raw`two\ words`, argv = [String.raw`C:\My Scripts\input`, `both'"quotes`, ''];
  // Act
  const actual = parseArguments(input), explicit = parseArguments(input, platform);
  const roundtrip = parseArguments(serializeArguments(argv));
  // Assert
  assert.deepEqual(actual, explicit);
  assert.deepEqual(actual, platform === 'win32' ? ['two\\', 'words'] : ['two words']);
  assert.deepEqual(roundtrip, argv);
});

// Test our POSIX argument adapter's execution contract, not shlex internals.
const cases = [
  ['', []], [' \t\n', []],
  ['--mode "daily report" --limit 5', ['--mode', 'daily report', '--limit', '5']],
  ["'' \"\" ' spaced ' é😀", ['', '', ' spaced ', 'é😀']],
  ['two\\ words "a\\\"b"', ['two words', 'a"b']],
  ["$'two words' $\"three words\"", ['two words', 'three words']],
  ["'$HOME' '$(command)' '`command`' '*' '|' ';' '>' '&&'", ['$HOME', '$(command)', '`command`', '*', '|', ';', '>', '&&']],
];
for (const [index, [text, expected]] of cases.entries()) {
  test(`POSIX quoted arguments preserve ordered literal tokens ${index}`, () => {
    // Arrange
    const input = text;
    // Act
    const result = parseArguments(input, 'posix');
    // Assert
    assert.deepEqual(result, expected);
  });
}

for (const argv of [[], [''], ['', '  spaces  ', 'é😀', '\n', '\t', "a'b", '"quoted"', 'back\\slash', '$HOME', '$() ; | * `cmd`']]) {
  test(`POSIX serialization round-trips all literal argv values (${argv.length})`, () => {
    // Arrange
    const original = structuredClone(argv);
    // Act
    const text = serializeArguments(argv, 'posix');
    const result = parseArguments(text, 'posix');
    // Assert
    assert.deepEqual(result, original);
    assert.deepEqual(argv, original);
  });
}

for (const [index, input] of [undefined, null, 42, [], {}, "'private", '"private', 'private\\', "$'private", '$"private', 'private\0'].entries()) {
  test(`invalid POSIX text ${index} has no parser/input leak`, () => {
    // Arrange
    let failure;
    // Act
    try { parseArguments(input, 'posix'); } catch (error) { failure = error; }
    // Assert
    assert.ok(failure instanceof Error);
    assert.equal(failure.message, 'Invalid arguments.');
    assert.equal(failure.diagnosticCode, 'ARGS_TEXT_INVALID');
    assert.equal(failure.cause, undefined);
    assert.equal(JSON.stringify(failure).includes('private'), false);
  });
}

for (const [index, input] of [undefined, null, 'private', {}, Array(1), [undefined], [null], [42], ['private\0']].entries()) {
  test(`invalid argv ${index} fails lossless serialization safely`, () => {
    // Arrange
    let failure;
    // Act
    try { serializeArguments(input); } catch (error) { failure = error; }
    // Assert
    assert.ok(failure instanceof Error);
    assert.equal(failure.message, 'Invalid arguments.');
    assert.equal(failure.diagnosticCode, 'INVALID_ARGUMENT');
    assert.equal(failure.cause, undefined);
  });
}

test('serialization rejects accessors without invoking user code', () => {
  // Arrange
  let reads = 0;
  const input = [];
  Object.defineProperty(input, '0', { get() { reads++; return 'private'; } });
  // Act
  let failure;
  try { serializeArguments(input); } catch (error) { failure = error; }
  // Assert
  assert.equal(failure?.diagnosticCode, 'INVALID_ARGUMENT');
  assert.equal(reads, 0);
});

for (const [label, argv] of [
  ['LF', ['first\nsecond']], ['CR', ['first\rsecond']], ['CRLF', ['first\r\nsecond']],
  ['mixed', ['', 'é😀', "apostrophe'\\\nline\r\n", '\\n', '\\r', 'ordinary flag']],
]) {
  test(`POSIX single-line serializer preserves ${label} argv after native stripping and flag append`, () => {
    // Arrange
    const original = structuredClone(argv);
    // Act
    const text = serializeArguments(argv, 'posix');
    const nativeValue = text.replace(/[\r\n]/g, '');
    const edited = parseArguments(`${nativeValue} --append`, 'posix');
    // Assert
    assert.equal(/[\r\n]/.test(text), false);
    assert.equal(nativeValue, text);
    assert.deepEqual(parseArguments(text, 'posix'), original);
    assert.deepEqual(edited, [...original, '--append']);
    assert.deepEqual(argv, original);
  });
}

test('POSIX literal backslash-n/r stay literal unless explicitly ANSI-C quoted', () => {
  // Arrange
  const literal = ['\\n', '\\r', 'prefix\\n\\r', "'\\n\"", '\\n\n\\r\r'];
  // Act
  const roundtrip = parseArguments(serializeArguments(literal, 'posix'), 'posix');
  const explicit = parseArguments("$'\\n' $'\\r' $'\\r\\n' '\\n' $\"\\r\"", 'posix');
  // Assert
  assert.deepEqual(roundtrip, literal);
  assert.deepEqual(explicit, ['\n', '\r', '\r\n', '\\n', '\\r']);
});
