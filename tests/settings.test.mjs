import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySettings, validateSettings, sameExecutionSettings, getInspectorConfiguration, settingsDiagnosticCode, sameSettingsExceptTheme, isThemeOnlyChange } from '../src/core/settings.mjs';
import { parseArguments } from '../src/core/arguments.mjs';

// TITLE-1: stored cosmetic metadata never changes execution or invents saved defaults.
for (const title of ['a/b\\c.txt é', '', ' \t\u202e ', null, 42, {}, ['caption'], 'bad\0title', 'x'.repeat(8193)]) {
  test('stored title is read-only cosmetic metadata, including malformed values', () => {
    // Arrange
    const input = { executable: '/synthetic/report.PY', argsText: '', title };
    const original = structuredClone(input);
    // Act
    const classified = classifySettings(input), projected = getInspectorConfiguration(input);
    const equivalent = sameExecutionSettings(input, { ...input, title: 'new' });
    // Assert
    assert.equal(classified.kind, 'configured');
    assert.deepEqual(classified.execution, { executable: input.executable, args: [] });
    assert.equal(projected.diagnosticCode, undefined);
    assert.equal(projected.title, title === 'a/b\\c.txt é' ? title : '');
    assert.equal(equivalent, true); assert.deepEqual(input, original);
    assert.equal(sameExecutionSettings(input, { ...input, title: 'new', executable: '/other' }), false);
  });
}

// Explicit execution only: no filesystem lookup, path inference, or mutation.
test('absolute execution settings preserve literal ordered argv and detach it', () => {
  // Arrange
  const input = { executable: '/nonexistent folder/program.py', args: ['', '  spaces  ', '$(private); * | >', 'é😀'], cwd: '/nonexistent cwd', runRequested: true };
  const original = structuredClone(input);
  // Act
  const result = validateSettings(input);
  const second = validateSettings(input);
  result.args.push('local');
  // Assert
  assert.deepEqual(second, { executable: input.executable, args: original.args, cwd: input.cwd });
  assert.deepEqual(input, original);
});

for (const cwd of [undefined, '']) {
  test(`optional cwd ${String(cwd)} is omitted`, () => {
    // Arrange
    const input = { executable: '/program', argsText: '', ...(cwd === undefined ? {} : { cwd }) };
    // Act
    const result = validateSettings(input);
    // Assert
    assert.deepEqual(result, { executable: '/program', args: [] });
  });
}

for (const argsText of ['', ' \t\n', '--mode "daily report" ""']) {
  test(`explicit argument text takes precedence over malformed legacy data (${JSON.stringify(argsText)})`, () => {
    // Arrange
    const input = { executable: '/program', argsText, args: 'malformed legacy', runRequested: false };
    const original = structuredClone(input);
    // Act
    const result = validateSettings(input);
    // Assert
    assert.deepEqual(result.args, parseArguments(argsText));
    assert.deepEqual(input, original);
  });
}

for (const argv of [[], ['', '  spaces  ', '$(literal); * | >', 'é😀', '"quoted"', 'back\\slash']]) {
  for (const args of [argv, JSON.stringify(argv)]) {
    test(`legacy ${typeof args} argv projects losslessly without changing stored data (${argv.length})`, () => {
      // Arrange
      const input = { executable: '/program', args, cwd: '', runRequested: true };
      const original = structuredClone(input);
      // Act
      const view = getInspectorConfiguration(input);
      const result = validateSettings(input);
      // Assert
      assert.deepEqual(parseArguments(view.argsText), argv);
      assert.deepEqual(result, { executable: '/program', args: argv });
      assert.deepEqual(input, original);
      assert.equal(view.diagnosticCode, undefined);
    });
  }
}

test('new inspector configuration synchronously displays empty arguments', () => {
  // Arrange
  const input = {};
  // Act
  const result = getInspectorConfiguration(input);
  // Assert
  assert.deepEqual(result, { executable: '', cwd: '', argsText: '', themeColor: '#969696', title: '' });
  assert.deepEqual(input, {});
});

const marker = 'private-settings-marker';
// Slice 2 objective: partial setup is read-only display information, never execution authority.
for (const [index, input] of [{}, { executable: '' }, { argsText: '' }, { args: [] },
  { executable: '', args: '["literal", ""]', cwd: '/synthetic/work', runRequested: false },
  { argsText: '"two words"', runRequested: true }, { cwd: '' },
  { executable: '', argsText: '', args: 'malformed legacy', themeColor: 'malformed stored theme' },
  Object.create(null)].entries()) {
  test(`setup classification ${index} validates supplied fields without synthesizing execution or changing storage`, () => {
    // Arrange
    const descriptors = Object.getOwnPropertyDescriptors(input);
    // Act
    const result = classifySettings(input);
    const view = getInspectorConfiguration(input);
    // Assert
    assert.deepEqual(result, { kind: 'setup' });
    assert.equal(Object.hasOwn(result, 'execution'), false);
    assert.deepEqual(Object.getOwnPropertyDescriptors(input), descriptors);
    assert.equal(view.themeColor, '#969696');
    assert.throws(() => validateSettings(input), { message: 'Invalid settings.' });
  });
}

for (const input of [{ executable: '/synthetic/program', argsText: '', args: 'malformed legacy' },
  { executable: '/synthetic/program', args: ['two words', ''], cwd: '/synthetic/work', runRequested: true },
  { executable: '/synthetic/program', args: '["literal"]', themeColor: null }]) {
  test('configured classification preserves the strict detached execution DTO and argument precedence', () => {
    // Arrange
    const original = structuredClone(input), expected = validateSettings(input);
    // Act
    const result = classifySettings(input);
    result.execution.args.push('local');
    const fresh = classifySettings(input);
    // Assert
    assert.deepEqual(fresh, { kind: 'configured', execution: expected });
    assert.deepEqual(input, original);
  });
}

const classificationFailures = [
  ...[undefined, null, [], 42, marker].map(input => [input, 'SETTINGS_NOT_OBJECT']),
  ...[undefined, null, 42, 'relative', ' ', '\t', '/synthetic\0', new String('/program')]
    .map(executable => [{ executable, argsText: '' }, 'INVALID_EXECUTABLE']),
  [{ executable: '/program' }, 'MISSING_ARGS'],
  ...[null, 42, {}, "'unterminated", 'end\\', marker + '\0'].map(argsText => [{ argsText }, 'ARGS_TEXT_INVALID']),
  ...[null, 42, {}, 'null'].map(args => [{ args }, 'ARGS_NOT_ARRAY']),
  [{ args: 'malformed' }, 'ARGS_JSON_INVALID'],
  ...[[null], [42], [marker + '\0'], Array(1)].map(args => [{ args }, 'INVALID_ARGUMENT']),
  ...[undefined, null, 42, 'relative', ' ', '/synthetic\0'].map(cwd => [{ cwd }, 'INVALID_CWD']),
  ...[undefined, null, 1, 'true'].map(runRequested => [{ runRequested }, 'INVALID_RUN_STATE']),
  ...['unknown', 'intervalSeconds', 'actionOnPress', Symbol('synthetic')].map(key => [{ [key]: marker }, 'UNKNOWN_SETTING']),
  [Object.create({ executable: '/program' }), 'INVALID_SETTINGS'],
];
for (const [index, [input, code]] of classificationFailures.entries()) {
  test(`malformed partial/configured classification ${index} is not setup and returns a fixed diagnostic`, () => {
    // Arrange
    const descriptors = input && typeof input === 'object' ? Object.getOwnPropertyDescriptors(input) : undefined;
    let failure;
    // Act
    try { classifySettings(input); } catch (error) { failure = error; }
    // Assert
    assert.equal(failure?.message, 'Invalid settings.');
    assert.equal(failure?.diagnosticCode, code);
    assert.equal(failure?.cause, undefined);
    assert.equal(JSON.stringify(failure).includes(marker), false);
    if (descriptors) assert.deepEqual(Object.getOwnPropertyDescriptors(input), descriptors);
  });
}
for (const field of ['executable', 'args', 'argsText', 'cwd', 'runRequested', 'themeColor']) {
  test(`setup classification rejects recognized ${field} accessor without running it`, () => {
    // Arrange
    let calls = 0;
    const input = { argsText: '' };
    Object.defineProperty(input, field, { enumerable: true, get() { calls++; throw Error(marker); } });
    let failure;
    // Act
    try { classifySettings(input); } catch (error) { failure = error; }
    // Assert
    assert.equal(failure?.message, 'Invalid settings.');
    assert.equal(failure?.diagnosticCode, 'INVALID_SETTINGS');
    assert.equal(calls, 0);
  });
}

const base = { executable: '/program', args: [] };

// WINDOWS-ARGUMENTS r1: projection and launch validation use the same trusted platform.
test('Windows settings classify natural arguments and preserve empty text precedence without rewriting legacy data', () => {
  // Arrange
  const input = { executable: 'C:/python.exe', args: 'invalid legacy', argsText: String.raw`C:\Scripts\showcase.py "C:\Folder\" --flag="two words"` };
  const original = structuredClone(input);
  const expected = { executable: input.executable, args: [String.raw`C:\Scripts\showcase.py`, 'C:\\Folder\\', '--flag=two words'] };
  // Act
  const execution = validateSettings(input, 'win32'), classification = classifySettings(input, 'win32');
  const view = getInspectorConfiguration(input, 'win32');
  const empty = validateSettings({ ...input, argsText: '' }, 'win32');
  // Assert
  assert.deepEqual(execution, expected); assert.deepEqual(classification, { kind: 'configured', execution: expected });
  assert.equal(view.argsText, input.argsText); assert.equal(view.diagnosticCode, undefined);
  assert.deepEqual(empty.args, []); assert.deepEqual(input, original);
});

for (const args of [[String.raw`C:\temp\new`, 'C:\\Folder\\', `both'"quotes`, 'a\r\nb', ''],
  JSON.stringify([String.raw`C:\temp\new`, 'C:\\Folder\\', `both'"quotes`, 'a\r\nb', ''])]) {
  test(`Windows legacy ${typeof args} projection is lossless and read-only`, () => {
    // Arrange
    const input = { executable: 'C:/python.exe', args }, original = structuredClone(input);
    const expected = typeof args === 'string' ? JSON.parse(args) : args;
    // Act
    const view = getInspectorConfiguration(input, 'win32');
    const migrated = { ...input, argsText: view.argsText };
    const execution = validateSettings(migrated, 'win32');
    // Assert
    assert.deepEqual(execution.args, expected); assert.equal(sameExecutionSettings(input, migrated, 'win32'), true);
    assert.equal(/[\r\n]/.test(view.argsText), false); assert.equal(view.diagnosticCode, undefined);
    assert.deepEqual(input, original);
  });
}

test('Windows settings reject malformed text rather than falling back to valid legacy argv', () => {
  // Arrange
  const input = { executable: 'C:/python.exe', args: ['legacy'], argsText: '"private\r\nunterminated' };
  const original = structuredClone(input);
  // Act
  const view = getInspectorConfiguration(input, 'win32');
  const errors = [validateSettings, classifySettings].map(validate => { try { validate(input, 'win32'); } catch (error) { return error; } });
  // Assert
  assert.deepEqual(errors.map(error => [error?.message, error?.diagnosticCode]),
    [['Invalid settings.', 'ARGS_TEXT_INVALID'], ['Invalid settings.', 'ARGS_TEXT_INVALID']]);
  assert.equal(view.diagnosticCode, 'ARGS_TEXT_INVALID'); assert.equal(Object.hasOwn(view, 'argsText'), false);
  assert.equal(JSON.stringify(errors).includes('private'), false); assert.deepEqual(input, original);
});
test('setup classification contains inspection failures and never coerces executable objects', () => {
  // Arrange
  let conversions = 0;
  const executable = { toString() { conversions++; return '/program'; }, valueOf() { conversions++; throw Error(marker); } };
  const inputs = [new Proxy({}, { ownKeys() { throw Error(marker); } }), { executable, argsText: '' }];
  // Act
  const failures = inputs.map(input => { try { classifySettings(input); } catch (error) { return error; } });
  // Assert
  assert.deepEqual(failures.map(error => [error.message, error.diagnosticCode, error.cause]),
    [['Invalid settings.', 'INVALID_SETTINGS', undefined], ['Invalid settings.', 'INVALID_EXECUTABLE', undefined]]);
  assert.equal(conversions, 0); assert.equal(JSON.stringify(failures).includes(marker), false);
});
const failures = [
  ...[undefined, null, [], 42, marker].map(input => [input, 'SETTINGS_NOT_OBJECT']),
  [{ args: [] }, 'MISSING_EXECUTABLE'],
  [{ executable: '/program' }, 'MISSING_ARGS'],
  ...[undefined, null, 42, '', 'program', './program', '~/program', 'C:\\program', `/${marker}\0`].map(executable => [{ ...base, executable }, 'INVALID_EXECUTABLE']),
  ...[undefined, null, 42, {}, 'null', '{}', '42', '"private"'].map(args => [{ ...base, args }, 'ARGS_NOT_ARRAY']),
  ...['', ' \t', marker, '["unterminated', '["private",]'].map(args => [{ ...base, args }, 'ARGS_JSON_INVALID']),
  ...[[undefined], [null], [42], [marker + '\0'], Array(1), '[null]', '[42]'].map(args => [{ ...base, args }, 'INVALID_ARGUMENT']),
  ...[undefined, null, 42, ' \t', 'relative', `/${marker}\0`].map(cwd => [{ ...base, cwd }, 'INVALID_CWD']),
  ...[null, 42, {}, "'unterminated", 'end\\', marker + '\0'].map(argsText => [{ ...base, argsText }, 'ARGS_TEXT_INVALID']),
  ...[undefined, null, 'true', 1].map(runRequested => [{ ...base, runRequested }, 'INVALID_RUN_STATE']),
  [{ ...base, [marker]: marker }, 'UNKNOWN_SETTING'],
  [{ ...base, [Symbol(marker)]: marker }, 'UNKNOWN_SETTING'],
];
for (const [index, [input, code]] of failures.entries()) {
  test(`invalid settings case ${index} yields a fixed redacted diagnostic`, () => {
    // Arrange
    let failure;
    // Act
    try { validateSettings(input); } catch (error) { failure = error; }
    // Assert
    assert.ok(failure instanceof Error);
    assert.equal(failure.message, 'Invalid settings.');
    assert.equal(failure.cause, undefined);
    assert.equal(failure.diagnosticCode, code);
    assert.equal(settingsDiagnosticCode(failure), code);
    assert.equal(JSON.stringify(failure).includes(marker), false);
  });
}

for (const args of ['malformed-private', '[null]', Array(2), [42], ['private\0']]) {
  test(`malformed legacy ${typeof args} stays intact in inspector projection`, () => {
    // Arrange
    const input = { ...base, args };
    const original = structuredClone(input);
    // Act
    const result = getInspectorConfiguration(input);
    // Assert
    assert.ok(result.diagnosticCode);
    assert.equal(Object.hasOwn(result, 'argsText'), false);
    assert.deepEqual(input, original);
  });
}

test('execution equivalence ignores lossless text migration and run intent', () => {
  // Arrange
  const old = { ...base, args: ['two words', ''], runRequested: true };
  const migrated = { ...old, argsText: '"two words" ""', cwd: '', runRequested: false };
  // Act
  const same = sameExecutionSettings(old, migrated);
  const changed = sameExecutionSettings(old, { ...migrated, argsText: 'different' });
  const invalid = sameExecutionSettings(old, { ...migrated, executable: 'relative' });
  // Assert
  assert.equal(same, true);
  assert.equal(changed, false);
  assert.equal(invalid, false);
});

test('unexpected inspection failures and forged diagnostics are redacted', () => {
  // Arrange
  const original = Object.assign(new Error(marker), { diagnosticCode: 'INVALID_EXECUTABLE' });
  const input = new Proxy(base, { ownKeys() { throw original; } });
  const forged = { diagnosticCode: marker };
  let reads = 0;
  const getter = { get diagnosticCode() { reads++; throw original; } };
  // Act
  let failure;
  try { validateSettings(input); } catch (error) { failure = error; }
  const codes = [settingsDiagnosticCode(forged), settingsDiagnosticCode(getter)];
  // Assert
  assert.notEqual(failure, original);
  assert.equal(failure.message, 'Invalid settings.');
  assert.equal(failure.diagnosticCode, 'INVALID_SETTINGS');
  assert.equal(failure.cause, undefined);
  assert.deepEqual(codes, ['INVALID_SETTINGS', 'INVALID_SETTINGS']);
  assert.equal(reads, 0);
});

for (const args of [["a\nb", "c\rd", "e\r\nf", "'\\é😀", ''], JSON.stringify(["a\nb", "c\rd", "e\r\nf", "'\\é😀", ''])]) {
  test(`legacy ${typeof args} newline argv projects into a lossless one-line editor without changing storage`, () => {
    // Arrange
    const input = { executable: '/program', args, runRequested: true };
    const original = structuredClone(input);
    const expected = typeof args === 'string' ? JSON.parse(args) : args;
    // Act
    const projected = getInspectorConfiguration(input);
    const normalized = validateSettings({ ...input, argsText: projected.argsText });
    // Assert
    assert.equal(/[\r\n]/.test(projected.argsText), false);
    assert.deepEqual(normalized.args, expected);
    assert.equal(sameExecutionSettings(input, { ...input, argsText: projected.argsText }), true);
    assert.deepEqual(input, original);
  });
}

test('valid raw multiline argument text is read-only canonically projected', () => {
  // Arrange
  const input = { executable: '/program', argsText: "'LF\nvalue' 'CR\rvalue' 'CRLF\r\nvalue' ''", args: ['retained'], runRequested: true };
  const original = structuredClone(input);
  // Act
  const projected = getInspectorConfiguration(input);
  // Assert
  assert.equal(/[\r\n]/.test(projected.argsText), false);
  assert.deepEqual(parseArguments(projected.argsText), validateSettings(input).args);
  assert.equal(projected.diagnosticCode, undefined);
  assert.deepEqual(input, original);
});

for (const argsText of ["'private\nunterminated", '"private\r\nunterminated', 'private\nend\\']) {
  test('invalid multiline text cannot become guessed valid input through native stripping', () => {
    // Arrange
    const input = { executable: '/program', argsText, args: ['legacy must not override'] };
    const original = structuredClone(input);
    // Act
    const projected = getInspectorConfiguration(input);
    // Assert
    assert.equal(projected.diagnosticCode, 'ARGS_TEXT_INVALID');
    assert.equal(Object.hasOwn(projected, 'argsText'), false);
    assert.deepEqual(input, original);
  });
}

for (const themeColor of [undefined, null, 'bad stored metadata', '#ABCDEF']) {
  test(`theme metadata does not enter execution or trigger storage repair (${String(themeColor)})`, () => {
    // Arrange
    const input = { executable: '/program', argsText: '', ...(themeColor === undefined ? {} : { themeColor }) };
    const original = structuredClone(input);
    // Act
    const execution = validateSettings(input), view = getInspectorConfiguration(input);
    // Assert
    assert.deepEqual(execution, { executable: '/program', args: [] });
    assert.equal(view.themeColor, themeColor === '#ABCDEF' ? '#abcdef' : '#969696');
    assert.equal(view.diagnosticCode, undefined);
    assert.deepEqual(input, original);
  });
}
for (const input of [{}, { executable: 'relative', args: 'invalid legacy' }, { executable: '/program', args: ['', 'literal'], runRequested: true }]) {
  test('theme-only classification preserves execution equivalence for valid, invalid and unconfigured snapshots', () => {
    // Arrange
    const themed = { ...input, themeColor: '#abcdef' };
    // Act
    const results = [sameSettingsExceptTheme(input, themed), isThemeOnlyChange(input, themed), sameExecutionSettings(input, themed)];
    const mixed = { ...themed, executable: '/changed' };
    // Assert
    assert.deepEqual(results, [true, true, true]);
    assert.equal(isThemeOnlyChange(input, mixed), false);
    assert.equal(sameExecutionSettings(input, mixed), false);
    assert.equal(isThemeOnlyChange(themed, themed), false);
  });
}
