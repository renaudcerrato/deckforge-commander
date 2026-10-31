import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const literalArguments = ['', 'space value', 'é🙂', '"quoted"', 'a\\"b', 'trailing\\', '$(literal)', '%LITERAL%', 'a\nb'];
export function imageRecord() {
  const prefix = '<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><!--';
  const suffix = '--></svg>';
  return prefix + 'x'.repeat(262144 - Buffer.byteLength(prefix + suffix)) + suffix;
}
export function burstRecord(index) {
  const prefix = `text:${String(index).padStart(6, '0')}:`;
  return prefix + 'x'.repeat(2047 - prefix.length) + '\n';
}
async function write(stream, value) {
  if (!stream.write(value)) await once(stream, 'drain');
}
async function fragmented(stream, value) {
  for (const byte of Buffer.from(value)) {
    await write(stream, Buffer.from([byte]));
    await new Promise(resolve => setImmediate(resolve));
  }
}
function hold() { setInterval(() => {}, 1000); }
async function tree(depth) {
  if (depth < 2) {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'descendant', String(depth + 1)], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env: process.env });
    child.on('error', () => process.exit(98));
    const [message] = await once(child, 'message');
    if (message !== 'ready') throw Error('fixture readiness');
  }
  await write(process.stdout, `text:level-${depth}\n`);
  if (process.send) process.send('ready');
  hold();
}
// Track only this fixture's children; never discover or signal other processes.
const children = [];
async function rootTree(mode) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'descendant', '1'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env: process.env });
  children.push(child); child.on('error', () => process.exit(98));
  const [message] = await once(child, 'message');
  if (message !== 'ready') throw Error('fixture readiness');
  await write(process.stdout, 'text:tree-ready\n');
  if (mode === 'tree-exit') {
    await write(process.stdout, 'text:final-root\n'); child.disconnect();
    // Explicit exit after write callback: a living descendant cannot hold root open.
    await new Promise(resolve => process.stdout.write('', resolve));
    process.exit(17);
  }
  hold();
}
async function main(mode) {
  // Independent expiry is a failure, never a successful cleanup mechanism.
  const expiry = setTimeout(() => process.exit(99), 15000); expiry.unref();
  switch (mode) {
    case 'launch': {
      const actual = process.argv.slice(3);
      if (JSON.stringify(actual) !== JSON.stringify(literalArguments)) throw Error('fixture argv');
      if (process.env.CANVAS_SYNTHETIC !== 'before' || process.env.Path !== 'synthetic-only' || process.env.ELGATO_ACTION_CONTEXT !== 'synthetic-key') throw Error('fixture env');
      if (process.env.CANVAS_PARENT_ONLY !== undefined) throw Error('fixture isolation');
      if (process.cwd().replaceAll('\\', '/').toLowerCase() !== path.dirname(fileURLToPath(import.meta.url)).replaceAll('\\', '/').toLowerCase()) throw Error('fixture cwd');
      await write(process.stdout, 'text:launch-ok\n'); break;
    }
    case 'empty': break;
    case 'nonzero': await write(process.stdout, 'text:final-nonzero\n'); process.exitCode = 37; break;
    case 'streams':
      await fragmented(process.stdout, 'text:é🙂\r\n');
      await fragmented(process.stderr, 'é🙂\r\n');
      await write(process.stderr, 's'.repeat(4096));
      await write(process.stdout, 'text:skip|color:red;color:blue\n');
      await write(process.stdout, imageRecord() + '\r\n');
      await write(process.stdout, 'text:final\n'); break;
    case 'malformed': await write(process.stdout, 'data:image/png;base64,Y===\n'); hold(); break;
    case 'overlong': await write(process.stdout, 'x'.repeat(262145) + '\n'); hold(); break;
    case 'unterminated': await write(process.stdout, 'text:unfinished'); break;
    case 'invalid-utf8': await write(process.stdout, Buffer.from([0xc3, 0x0a])); break;
    case 'burst':
      for (let i = 0; i < 4096; i++) await write(process.stdout, burstRecord(i));
      break;
    case 'flood': {
      const chunk = Buffer.from(burstRecord(0));
      for (;;) await write(process.stdout, chunk);
    }
    case 'hold': await write(process.stdout, 'text:ready\n'); hold(); break;
    case 'tree': case 'tree-exit': await rootTree(mode); break;
    case 'descendant': await tree(Number(process.argv[3])); break;
    default: throw Error('fixture mode');
  }
}
if (path.basename(process.argv[1] ?? '') === 'windows-native-producer.mjs') {
  try { await main(process.argv[2]); }
  catch { process.stderr.write('FIXTURE_FAILURE\n'); process.exit(98); }
}
