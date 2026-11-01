import test from 'node:test';
import assert from 'node:assert/strict';
import { createErrorArtwork } from '../src/core/error-artwork.mjs';
import { createKeyLayout } from '../src/core/key-layout.mjs';
import { assertFixedError } from './helpers/svg-harness.mjs';

// Fixed Error appearance is a contract; XML attribute order and numeric spelling are not.
const fixedDiagnoses = [
  ...['MISSING_EXECUTABLE', 'INVALID_EXECUTABLE'].map(code => [code, 'EXEC', ['Executable', 'path invalid']]),
  ...['MISSING_ARGS', 'ARGS_NOT_ARRAY', 'ARGS_JSON_INVALID', 'ARGS_TEXT_INVALID', 'INVALID_ARGUMENT'].map(code => [code, 'ARGS', ['Check argument', 'quotes']]),
  ['INVALID_CWD', 'CWD', ['Check working', 'folder']],
  ...['PROCESS_LAUNCH_FAILED', 'PROCESS_LAUNCH_REASON_UNKNOWN'].map(code => [code, 'START', ["Can't start", 'Check setup']]),
  ['PROCESS_LAUNCH_REASON_ENOENT', 'ENOENT', ["Can't start", 'Path missing']],
  ['PROCESS_LAUNCH_REASON_EACCES', 'EACCES', ['Permission', 'denied']],
  ['PROCESS_LAUNCH_REASON_ENOTDIR', 'ENOTDIR', ['Path is not', 'a folder']],
  ['PROCESS_LAUNCH_REASON_ENOEXEC', 'ENOEXEC', ["Can't start", 'Bad executable']],
  ['PROCESS_LAUNCH_REASON_EAGAIN', 'EAGAIN', ["Can't start", 'System busy']],
  ['PROCESS_LAUNCH_REASON_EINVAL', 'EINVAL', ["Can't start", 'Invalid launch']],
  ['PROCESS_EXITED_NONZERO', 'EXIT', ['Script exited', 'with an error']],
  ['PROCESS_TERMINATED_BY_SIGNAL', 'SIGNAL', ['Script stopped', 'by a signal']],
  ...['PROCESS_PROTOCOL_REJECTED', 'IMAGE_PROTOCOL_ERROR'].map(code => [code, 'IMAGE', ['Invalid image', 'output']]),
  ['CLEANUP_BLOCKED', 'CLEANUP', ['Stop uncertain', "Can't restart"]],
  ['FRAME_SEND_FAILED', 'DISPLAY', ["Can't display", 'image']],
  ['STATE_SAVE_FAILED', 'STATE', ["Can't confirm", 'settings save']],
  [undefined, 'ERROR', ['Run failed', 'Check setup']],
];

for (const [diagnostic, code, lines] of fixedDiagnoses) {
  test(`${diagnostic ?? 'fallback'} retains its exact fixed diagnostic artwork`, () => {
    // Arrange: every mapping independently pins its approved colors, reasons and geometry.
    // Act
    const uri = createErrorArtwork(diagnostic);
    const error = decodeURIComponent(uri.slice('data:image/svg+xml,'.length));
    const layout = createKeyLayout('private script caption', undefined, { code, lines });
    // Assert
    assert.ok(uri.startsWith('data:image/svg+xml,'));
    assertFixedError(error, code, lines); assertFixedError(layout, code, lines);
  });
}

test('fixed error layout ignores every hostile footer/extension category without disclosure or coercion', () => {
    // Arrange: metadata handling is shared; it need not multiply every diagnostic mapping.
    const diagnosis = { code: 'START', lines: ["Can't start", 'Check setup'] };
    const expected = createKeyLayout(undefined, undefined, diagnosis);
    const cyclic = {}; cyclic.self = cyclic;
    const accessors = Object.defineProperties({}, {
      toString: { get() { throw new Error('Unexpected accessor.'); } },
      [Symbol.toPrimitive]: { get() { throw new Error('Unexpected accessor.'); } },
    });
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    const metadata = [undefined, 'ready', 'exited', 'success', 'loading...', 'setup required', null, 42, true, '',
      'SETUP REQUIRED', ' setup required', 'setup required ', 'setup required\n',
      ['setup required'], new String('setup required'), Symbol('setup required'),
      'EXITED', '<script>private</script>', 'private-path/env/argv/stderr', ['exited'],
      new String('exited'), Symbol('exited'), cyclic, accessors, revoked.proxy,
      new Proxy({}, { get() { throw new Error('Unexpected proxy access.'); } }),
      () => { throw new Error('Unexpected invocation.'); }];
    // Act
    const layouts = metadata.flatMap(footer => [undefined, '.py', '<script>private</script>', accessors, revoked.proxy].map(extension =>
      createKeyLayout('private script caption', undefined, diagnosis, footer, extension)));
    // Assert: exact bytes protect the preexisting diagnosis, colors and geometry.
    for (const actual of layouts) {
      assert.equal(actual, expected);
      assert.equal(/>ready<|>exited<|>success<|>setup required<|>Stream<|>Loop<|>loading\.\.\.<|private|<script/.test(actual), false);
    }
});

for (const [index, input] of [undefined, null, 42, {}, ['INVALID_EXECUTABLE'], 'private-path/env/argv/stderr', '<script onload="private">', 'PROCESS_EXITED_42', 'toString', '__proto__'].entries()) {
  test(`unknown diagnostic ${index} cannot inject or disclose input`, () => {
    // Arrange
    const expected = createErrorArtwork(undefined);
    // Act
    const result = createErrorArtwork(input);
    // Assert
    assert.equal(result, expected);
    const svg = decodeURIComponent(result.slice('data:image/svg+xml,'.length));
    assertFixedError(svg, 'ERROR', ['Run failed', 'Check setup']);
    assert.equal(svg.includes('private'), false);
  });
}

for (const themeColor of ['#ABCDEF', 'private" onload="secret', '#abc', undefined]) {
  test(`error theme affects border only, keeping red diagnostic and white reason (${String(themeColor)})`, () => {
    // Arrange
    const expected = themeColor === '#ABCDEF' ? '#abcdef' : '#969696';
    // Act
    const svg = decodeURIComponent(createErrorArtwork('PROCESS_LAUNCH_FAILED', themeColor).slice('data:image/svg+xml,'.length));
    // Assert
    assertFixedError(svg, 'START', ["Can't start", 'Check setup'], expected);
    assert.equal(/onload=|secret|private/.test(svg), false);
  });
}
