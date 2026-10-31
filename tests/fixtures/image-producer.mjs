// Isolated local test producer. Never accesses user programs, credentials, or files.
const [mode = 'success', ...args] = process.argv.slice(2);
const emit = line => process.stdout.write(line + '\n');
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" fill="#252525"/><circle cx="72" cy="72" r="44" fill="#39d98a"/></svg>';
if (mode === 'argv') {
  emit(JSON.stringify({ args, cwd: process.cwd() }));
} else if (mode === 'nonzero') {
  process.stderr.write('private fixture stderr\n');
  emit('<svg>last</svg>');
  process.exitCode = 7;
} else if (mode === 'protocol') {
  emit('data:image/png;base64,%%%');
} else if (mode === 'unterminated') {
  process.stdout.write('<svg>private incomplete</svg>');
} else if (mode === 'invalid-utf8') {
  process.stdout.write(Buffer.from([0xc3, 0x28, 10]));
} else if (mode === 'stderr') {
  // Enough to exceed typical pipe capacity; runner must drain rather than deadlock.
  process.stderr.write('private fixture stderr\n'.repeat(100_000));
  emit('<svg>final</svg>');
} else {
  process.stdout.write(svg + '\n');
  process.stdout.write(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}\n`);
  emit('text:Ready');
  emit('progress:100');
}
