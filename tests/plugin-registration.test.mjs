import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAdapterCode, createAdapterLoader } from './helpers/adapter-harness.mjs';

const options = { timeout: 3000 };
const codes = await loadAdapterCode(['../plugin']);

// W2: observe executed startup, not comments, formatting or uninvoked source.
// Only SDK/process boundaries are faked; constructors and availability are real.
function startup(t) {
  const events = [], decorated = new Map(), managers = [];
  const subscribe = () => ({ dispose() {} });
  const sdk = {
    logger: { setLevel() {} },
    actions: { registerAction(action) { events.push({ kind: 'register', action }); } },
    devices: { onDeviceDidConnect: subscribe, onDeviceDidDisconnect: subscribe },
    system: { onSystemDidWakeUp: subscribe, onDidReceiveDeepLink: subscribe },
    connect() { events.push({ kind: 'connect' }); return Promise.resolve(); },
  };
  const sdkModule = { default: sdk, SingletonAction: class {},
    action: metadata => Action => { decorated.set(Action, metadata.UUID); return Action; } };
  const load = createAdapterLoader(codes, {
    process: { env: {}, platform: 'darwin', cwd: () => '/synthetic/cwd' },
    resolve(name) {
      if (name === '@elgato/streamdeck') return sdkModule;
      if (name === '../core/process-runner.mjs') return {
        startProcessRun() { throw new Error('Unexpected process launch during startup'); },
      };
    },
    observe(name, actual) {
      if (name !== '../core/availability.mjs') return actual;
      return { ...actual, createAvailabilityManager(dependencies) {
        const manager = actual.createAvailabilityManager(dependencies);
        managers.push(manager); return manager;
      } };
    },
  });
  // Register teardown before entry evaluation so assertion/startup failures still dispose.
  t.after(() => { for (const manager of managers) manager.dispose(); });
  return { events, decorated, run() {
    load('../plugin');
    return [
      [load('./run').RunAction, 'git.renaudcerrato.deckforge.stream'],
      [load('./timer').TimerAction, 'git.renaudcerrato.deckforge.loop'],
      [load('./once').OnceAction, 'git.renaudcerrato.deckforge.run'],
    ];
  } };
}

function assertRegistrations(events, expected, decorated) {
  const registrations = events.filter(event => event.kind === 'register');
  const connections = events.filter(event => event.kind === 'connect');
  assert.equal(connections.length, 1, 'startup must connect once');
  assert.deepEqual(registrations.map(({ action }) => decorated.get(action.constructor)).sort(),
    expected.map(([, uuid]) => uuid).sort(), 'each expected decorated action must register exactly once');
  for (const [Action, uuid] of expected) {
    assert.ok(registrations.some(({ action }) => action instanceof Action && decorated.get(action.constructor) === uuid),
      'registration must use the real action class');
  }
  assert.ok(registrations.every(event => events.indexOf(event) < events.indexOf(connections[0])),
    'all actions must register before connection');
}

test('real plugin entry registers each decorated action exactly once before inert connection', options, t => {
  // Arrange
  const h = startup(t);
  // Act
  const expected = h.run();
  // Assert
  assertRegistrations(h.events, expected, h.decorated);
});

for (const defect of ['missing', 'duplicate', 'late']) {
  test(`registration assertions reject ${defect} registration events`, options, t => {
    // Arrange: derive invalid observations without mutating or rewriting source.
    const h = startup(t), expected = h.run();
    const first = h.events.find(event => event.kind === 'register');
    const remaining = h.events.filter(event => event !== first);
    // Act
    const invalid = defect === 'missing' ? remaining
      : defect === 'duplicate' ? [first, ...h.events] : [...remaining, first];
    // Assert
    assert.throws(() => assertRegistrations(invalid, expected, h.decorated), assert.AssertionError);
  });
}
