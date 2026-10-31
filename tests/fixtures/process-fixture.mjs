import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Own-group and deliberately escaped children exist only during isolated tests.
const mode = process.argv[2] ?? 'hold';
const keepAlive = setInterval(() => {}, 60_000);
function ready(descendant) {
  process.stdout.write(JSON.stringify({ pid: process.pid, descendant }) + '\n');
}
if (['child', 'stubborn-child', 'escaped-child'].includes(mode)) {
  if (mode === 'stubborn-child') process.on('SIGTERM', () => {});
  // Independent safety net: no learned PID or successful readiness is required.
  // Shorter than the native test's 8s timeout; normal test-owned teardown is earlier.
  if (mode === 'escaped-child') setTimeout(() => process.exit(0), 6_000);
  process.send?.({ ready: true, pid: process.pid });
} else if (mode === 'exiting-leader') {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'child'], {
    detached: false, stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  child.once('message', message => {
    if (!message.ready) return;
    const image = '<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" fill="#39d98a"/></svg>';
    const receipt = JSON.stringify({ pid: process.pid, descendant: message.pid });
    // Readiness confirms a live descendant has inherited BOTH output descriptors.
    // Exit after flushing the final record, without waiting for inherited-pipe close.
    process.stdout.write(receipt + '\n' + image + '\n', () => process.exit(0));
  });
  child.once('error', () => { clearInterval(keepAlive); process.exitCode = 1; });
} else if (['tree', 'escaped', 'stubborn'].includes(mode)) {
  if (mode === 'stubborn') process.on('SIGTERM', () => {});
  const childMode = mode === 'stubborn' ? 'stubborn-child' : mode === 'escaped' ? 'escaped-child' : 'child';
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), childMode], {
    detached: mode === 'escaped', stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  child.once('message', message => { if (message.ready) ready(message.pid); });
  child.once('error', () => { clearInterval(keepAlive); process.exitCode = 1; });
} else {
  ready();
}
