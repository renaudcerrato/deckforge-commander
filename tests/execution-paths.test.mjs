import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { executionPlatform, isAbsoluteExecutionPath, executionBasename } from '../src/core/execution-paths.mjs';
import { validateSettings, classifySettings, validateExecutionEdit, sameExecutionSettings } from '../src/core/settings.mjs';
import { applyConfigurationEdit } from '../src/core/run-state.mjs';
import { validateTimerSettings, classifyTimerSettings, sameTimerExecutionSettings, applyTimerConfigurationEdit } from '../src/core/timer-settings.mjs';
import { validateOnceSettings, classifyOnceSettings, sameOnceExecutionSettings, applyOnceConfigurationEdit } from '../src/core/once-settings.mjs';
import { serializeArguments } from '../src/core/arguments.mjs';

// WIN-WINDOWS-FEATURE S2: platform is trusted runtime metadata, not stored configuration.
const windowsPaths = [String.raw`C:\Program Files\é\producer.EXE`, 'c:/Program Files/é/producer.EXE', String.raw`D:/mixed\producer.EXE`];
for (const [index, executable] of windowsPaths.entries()) {
  test(`local drive spelling ${index} is accepted only on Windows and is never rewritten`, () => {
    // Arrange
    const input = executable;
    // Act
    const accepted = isAbsoluteExecutionPath(input, 'win32');
    const rejected = isAbsoluteExecutionPath(input, 'posix');
    const basename = executionBasename(input, 'win32');
    // Assert
    assert.equal(accepted, true); assert.equal(rejected, false);
    assert.equal(basename, 'producer.EXE'); assert.equal(input, executable);
  });
}
const rejectedWindowsPaths = [undefined, null, 1, {}, new String('C:/program'), '', 'program', './program', '~/program',
  'C:program', 'C:', '/program', String.raw`\program`, String.raw`\\server\share\program`, '//server/share/program',
  String.raw`\\?\C:\program`, String.raw`\\.\C:\program`, String.raw`\??\C:\program`, '1:/program', 'C:/program\0'];
for (const [index, input] of rejectedWindowsPaths.entries()) {
  test(`Windows rejects nonlocal, relative, namespace or malformed path ${index}`, () => {
    // Arrange
    const value = input;
    // Act
    const accepted = isAbsoluteExecutionPath(value, 'win32');
    const basename = executionBasename(value, 'win32');
    // Assert
    assert.equal(accepted, false); assert.equal(basename, undefined);
  });
}
test('POSIX keeps backslash as literal basename content and rejects relative paths', () => {
  // Arrange
  const absolute = String.raw`/synthetic/folder\producer.py`;
  // Act
  const basename = executionBasename(absolute, 'posix');
  const invalid = executionBasename(String.raw`folder\producer.py`, 'posix');
  // Assert
  assert.equal(basename, String.raw`folder\producer.py`); assert.equal(invalid, undefined);
});
test('browser-safe default has no Node dependency and runtime default follows the actual platform', () => {
  // Arrange: isolate globals, never mutate process.platform.
  const source = readFileSync(new URL('../src/core/execution-paths.mjs', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText;
  // Act
  const browser = runInNewContext(`${code}\nexports.executionPlatform()`, { exports: {} });
  const windows = runInNewContext(`${code}\nexports.executionPlatform()`, { exports: {}, process: { platform: 'win32' } });
  const unknown = runInNewContext(`${code}\nexports.executionPlatform()`, { exports: {}, process: { platform: 'unknown' } });
  // Assert
  assert.equal(browser, 'posix'); assert.equal(windows, 'win32'); assert.equal(unknown, 'posix');
  assert.equal(executionPlatform(), process.platform === 'win32' ? 'win32' : 'posix');
});

const facades = [
  ['Stream', validateSettings, classifySettings, sameExecutionSettings, applyConfigurationEdit],
  ['Loop', (input, platform) => validateTimerSettings(input, platform).execution, classifyTimerSettings, sameTimerExecutionSettings, applyTimerConfigurationEdit],
  ['Run', (input, platform) => validateOnceSettings(input, platform).execution, classifyOnceSettings, sameOnceExecutionSettings, applyOnceConfigurationEdit],
];
for (const [name, validate, classify, same, edit] of facades) {
  test(`${name} Windows natural argument text reaches validation and classification literally`, () => {
    // Arrange
    const args = [String.raw`C:\Scripts\showcase.py`, String.raw`C:\Program Files\input`, 'C:\\Folder\\', String.raw`regex\d+`];
    const input = { executable: 'C:/python.exe', argsText: String.raw`C:\Scripts\showcase.py 'C:\Program Files\input' "C:\Folder\" regex\d+` };
    // Act
    const execution = validate(input, 'win32'), classification = classify(input, 'win32');
    const equivalent = same({ executable: input.executable, args }, input, 'win32');
    let failure; try { validate({ ...input, argsText: '"private' }, 'win32'); } catch (error) { failure = error; }
    // Assert
    assert.deepEqual(execution.args, args); assert.deepEqual(classification.execution.args, args);
    assert.equal(equivalent, true); assert.equal(failure?.diagnosticCode, 'ARGS_TEXT_INVALID');
  });
  for (const [index, executable] of windowsPaths.entries()) {
    test(`${name} Windows configuration ${index} preserves path, cwd, shlex and detached literal argv`, () => {
      // Arrange
      const args = [String.raw`C:\literal\input`, '', 'é😀', '$(literal); * | >', 'two words'];
      const input = { executable, cwd: 'D:/literal cwd', args: 'invalid legacy', argsText: serializeArguments(args) };
      const original = structuredClone(input);
      // Act
      const result = validate(input, 'win32');
      const classification = classify(input, 'win32');
      result.args.push('local mutation');
      // Assert
      assert.deepEqual(classification.execution, { executable, cwd: input.cwd, args });
      assert.equal(classification.kind, 'configured');
      assert.deepEqual(validate(input, 'win32'), { executable, cwd: input.cwd, args });
      assert.deepEqual(input, original);
    });
  }
  for (const [index, executable] of rejectedWindowsPaths.entries()) {
    test(`${name} Windows rejects invalid executable ${index} with a fixed diagnostic`, () => {
      // Arrange
      const input = { executable, argsText: '' };
      // Act
      let failure; try { validate(input, 'win32'); } catch (error) { failure = error; }
      // Assert
      assert.equal(failure?.message, 'Invalid settings.'); assert.equal(failure?.diagnosticCode, 'INVALID_EXECUTABLE');
      assert.equal(failure?.cause, undefined);
    });
  }
  test(`${name} platform classification distinguishes setup from invalid launch/edit paths`, () => {
    // Arrange
    const configured = { executable: 'C:/program', argsText: '', cwd: '' };
    // Act
    const setup = classify({ executable: '', argsText: '' }, 'win32');
    const ready = validate(configured, 'win32');
    // Assert
    assert.equal(setup.kind, 'setup'); assert.equal(Object.hasOwn(setup, 'execution'), false);
    assert.deepEqual(ready, { executable: 'C:/program', args: [] });
    assert.throws(() => classify(configured, 'posix'), { diagnosticCode: 'INVALID_EXECUTABLE' });
    assert.throws(() => edit(configured, { executable: '' }, 'win32'), { diagnosticCode: 'INVALID_EXECUTABLE' });
    assert.throws(() => validate({ ...configured, cwd: '/posix/work' }, 'win32'), { diagnosticCode: 'INVALID_CWD' });
    assert.throws(() => classify({ cwd: 'C:relative' }, 'win32'), { diagnosticCode: 'INVALID_CWD' });
  });
  test(`${name} Windows comparisons retain literal spelling and lossless legacy argv migration`, () => {
    // Arrange
    const first = { executable: String.raw`C:\program`, args: [String.raw`C:\literal\arg`, ''] };
    const text = { ...first, argsText: serializeArguments(first.args), themeColor: '#abcdef', cwd: '' };
    // Act
    const equivalent = same(first, text, 'win32');
    const changedPath = same(first, { ...text, executable: 'C:/program' }, 'win32');
    const changedArgs = same(first, { ...text, argsText: 'other' }, 'win32');
    // Assert
    assert.equal(equivalent, true); assert.equal(changedPath, false); assert.equal(changedArgs, false);
    assert.equal(same(first, text, 'posix'), false);
  });
  test(`${name} Windows narrow edits preserve unknown JSON and never save platform metadata`, () => {
    // Arrange
    const input = { executable: 'C:/old', args: [String.raw`C:\literal`], unknown: { nested: ['keep'] } };
    const original = structuredClone(input);
    // Act
    const result = edit(input, { executable: String.raw`D:\new.EXE`, cwd: 'D:/work' }, 'win32');
    const cosmetic = edit(input, { themeColor: '#ABCDEF' }, 'posix');
    // Assert
    assert.deepEqual(result, { ...original, executable: String.raw`D:\new.EXE`, cwd: 'D:/work' });
    assert.deepEqual(cosmetic, { ...original, themeColor: '#abcdef' }); assert.deepEqual(input, original);
    assert.throws(() => edit(input, { platform: 'win32' }, 'win32'), { message: 'Invalid settings.' });
    assert.throws(() => edit(input, { executable: '/posix/program' }, 'win32'), { diagnosticCode: 'INVALID_EXECUTABLE' });
  });
}
test('Windows executable edit validation does not change argument-text grammar or eagerly validate cwd', () => {
  // Arrange
  const executable = String.raw`C:\program`;
  // Act
  const accepted = validateExecutionEdit('executable', executable, 'win32');
  const deferredArgs = validateExecutionEdit('argsText', "'unterminated", 'win32');
  const deferredCwd = validateExecutionEdit('cwd', 'relative', 'win32');
  // Assert
  assert.equal(accepted, undefined); assert.equal(deferredArgs, undefined); assert.equal(deferredCwd, undefined);
  assert.throws(() => validateSettings({ executable, argsText: "'unterminated" }, 'win32'), { diagnosticCode: 'ARGS_TEXT_INVALID' });
  assert.throws(() => validateExecutionEdit('executable', '', 'win32'), { diagnosticCode: 'INVALID_EXECUTABLE' });
});
for (const [name, validate] of facades.slice(1)) {
  for (const field of ['runRequested', ...(name === 'Run' ? ['intervalSeconds', 'actionOnPress'] : [])]) {
    test(`${name} Windows configuration still rejects foreign action control ${field}`, () => {
      // Arrange
      const input = { executable: 'C:/program', argsText: '', [field]: field === 'runRequested' ? true : field === 'intervalSeconds' ? 5 : 'refresh' };
      // Act
      let failure; try { validate(input, 'win32'); } catch (error) { failure = error; }
      // Assert
      assert.equal(failure?.diagnosticCode, 'UNKNOWN_SETTING');
    });
  }
}
