import { fileURLToPath } from 'node:url';
import { startProcessRun } from '../../src/core/process-runner.mjs';

// Read only these explicitly seeded synthetic fields. Never print actual env values.
const expected = { CANVAS_SYNTHETIC_SENTINEL: 'synthetic-inherited', ELGATO_ACTION_CONTEXT: 'synthetic-native-key', ELGATO_KEY_COLUMN: '0' };
if (process.argv[2] === 'default-inheritance') {
  const run = startProcessRun({ executable: process.execPath, args: [fileURLToPath(import.meta.url), 'receipt'] }, {
    onUpdate(update) { if (update.kind === 'text') process.stdout.write(`${update.value}\n`); },
    onError() { process.exitCode = 1; },
  });
  await run.done;
} else {
  const receipt = Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, process.env[key] === value]));
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}
