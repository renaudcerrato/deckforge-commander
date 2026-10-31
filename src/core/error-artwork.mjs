import { createKeyLayout } from './key-layout.mjs';

const EXECUTABLE = { code: 'EXEC', lines: ['Executable', 'path invalid'] };
const ARGUMENTS = { code: 'ARGS', lines: ['Check argument', 'quotes'] };
const PROTOCOL = { code: 'IMAGE', lines: ['Invalid image', 'output'] };
const FALLBACK = { code: 'ERROR', lines: ['Run failed', 'Check setup'] };

const DIAGNOSTICS = new Map([
  ['MISSING_EXECUTABLE', EXECUTABLE],
  ['INVALID_EXECUTABLE', EXECUTABLE],
  ['MISSING_ARGS', ARGUMENTS],
  ['ARGS_NOT_ARRAY', ARGUMENTS],
  ['ARGS_JSON_INVALID', ARGUMENTS],
  ['ARGS_TEXT_INVALID', ARGUMENTS],
  ['INVALID_ARGUMENT', ARGUMENTS],
  ['INVALID_CWD', { code: 'CWD', lines: ['Check working', 'folder'] }],
  ['PROCESS_LAUNCH_FAILED', { code: 'START', lines: ["Can't start", 'Check setup'] }],
  ['PROCESS_LAUNCH_REASON_ENOENT', { code: 'ENOENT', lines: ["Can't start", 'Path missing'] }],
  ['PROCESS_LAUNCH_REASON_EACCES', { code: 'EACCES', lines: ['Permission', 'denied'] }],
  ['PROCESS_LAUNCH_REASON_ENOTDIR', { code: 'ENOTDIR', lines: ['Path is not', 'a folder'] }],
  ['PROCESS_LAUNCH_REASON_ENOEXEC', { code: 'ENOEXEC', lines: ["Can't start", 'Bad executable'] }],
  ['PROCESS_LAUNCH_REASON_EAGAIN', { code: 'EAGAIN', lines: ["Can't start", 'System busy'] }],
  ['PROCESS_LAUNCH_REASON_EINVAL', { code: 'EINVAL', lines: ["Can't start", 'Invalid launch'] }],
  ['PROCESS_LAUNCH_REASON_UNKNOWN', { code: 'START', lines: ["Can't start", 'Check setup'] }],
  ['PROCESS_EXITED_NONZERO', { code: 'EXIT', lines: ['Script exited', 'with an error'] }],
  ['PROCESS_TERMINATED_BY_SIGNAL', { code: 'SIGNAL', lines: ['Script stopped', 'by a signal'] }],
  ['PROCESS_PROTOCOL_REJECTED', PROTOCOL],
  ['IMAGE_PROTOCOL_ERROR', PROTOCOL],
  ['CLEANUP_BLOCKED', { code: 'CLEANUP', lines: ['Stop uncertain', "Can't restart"] }],
  ['FRAME_SEND_FAILED', { code: 'DISPLAY', lines: ["Can't display", 'image'] }],
  ['STATE_SAVE_FAILED', { code: 'STATE', lines: ["Can't confirm", 'settings save'] }],
]);

/** Return a 144px encoded SVG using only allowlisted diagnostics and fixed text. */
export function createErrorArtwork(diagnosticCode, themeColor) {
  const artwork = typeof diagnosticCode === 'string'
    ? DIAGNOSTICS.get(diagnosticCode) ?? FALLBACK
    : FALLBACK;
  const svg = createKeyLayout(undefined, themeColor, artwork);
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
