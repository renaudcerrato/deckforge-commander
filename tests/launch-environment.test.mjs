import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAdapterCode, createAdapterLoader } from './helpers/adapter-harness.mjs';
import { createLaunchEnvironment, validateLaunchOptions } from '../src/core/launch-environment.mjs';
import { createErrorArtwork } from '../src/core/error-artwork.mjs';

// Independent contract table: these names belong to DeckForge Commander, not the SDK.
const fields = [
  ['PLUGIN_UUID', 'pluginUuid', 'string'], ['PLUGIN_VERSION', 'pluginVersion', 'string'],
  ['ACTION_UUID', 'actionUuid', 'string'], ['ACTION_CONTEXT', 'actionContext', 'string'],
  ['ACTION_THEME_COLOR', 'actionThemeColor', 'color'],
  ['DEVICE_ID', 'deviceId', 'string'], ['DEVICE_NAME', 'deviceName', 'string'],
  ['DEVICE_TYPE', 'deviceType', 'number'], ['DEVICE_COLUMNS', 'deviceColumns', 'number'],
  ['DEVICE_ROWS', 'deviceRows', 'number'], ['KEY_COLUMN', 'keyColumn', 'number'],
  ['KEY_ROW', 'keyRow', 'number'], ['APP_VERSION', 'appVersion', 'string'],
  ['APP_LANGUAGE', 'appLanguage', 'string'], ['APP_PLATFORM', 'appPlatform', 'string'],
  ['APP_PLATFORM_VERSION', 'appPlatformVersion', 'string'],
].map(([suffix, field, type]) => [`ELGATO_${suffix}`, field, type]);
const synthetic = () => Object.fromEntries(fields.map(([, field, type]) => [field, type === 'color' ? '#abcdef' : type === 'number' ? 0 : ` synthetic ${field} é\n `]));
const stale = () => Object.fromEntries(fields.map(([name]) => [name, 'STALE_SYNTHETIC']));
const plain = value => ({ ...value });

// S2: fresh owned metadata wins over stale Windows aliases, without host env merging.
test('Windows removes every stale owned alias before overlay while POSIX preserves case-distinct names', () => {
  // Arrange
  const aliases = Object.fromEntries(fields.flatMap(([name]) => [[name, 'stale-one'], [name.toLowerCase(), 'stale-two']]));
  const inherited = { ...aliases, SystemRoot: 'C:/synthetic/windows', ELGATO_OTHER: 'keep' };
  const original = structuredClone(inherited), metadata = synthetic();
  // Act
  const windows = createLaunchEnvironment(inherited, metadata, 'win32');
  const posix = createLaunchEnvironment(inherited, {}, 'posix');
  // Assert
  assert.deepEqual(plain(windows), { SystemRoot: inherited.SystemRoot, ELGATO_OTHER: 'keep',
    ...Object.fromEntries(fields.map(([name, field]) => [name, String(metadata[field])])) });
  assert.deepEqual(plain(posix), { SystemRoot: inherited.SystemRoot, ELGATO_OTHER: 'keep',
    ...Object.fromEntries(fields.map(([name]) => [name.toLowerCase(), 'stale-two'])) });
  assert.deepEqual(inherited, original);
});
test('Windows omits invalid fresh metadata after removing stale lowercase aliases', () => {
  // Arrange
  const inherited = { elgato_action_context: 'stale', ELGATO_ACTION_CONTEXT: 'different-stale', elgato_action_theme_color: 'stale', ELGATO_UNRELATED: 'keep' };
  // Act
  const result = createLaunchEnvironment(inherited, { actionContext: 'bad\0value', actionThemeColor: 'red' }, 'win32');
  // Assert
  assert.deepEqual(plain(result), { ELGATO_UNRELATED: 'keep' });
});
for (const operation of ['inherited', 'complete']) {
  const copy = env => operation === 'inherited' ? createLaunchEnvironment(env, {}, 'win32') : validateLaunchOptions({ env }, 'win32');
  test(`Windows ${operation} environment collapses identical ASCII aliases deterministically and preserves Unicode`, () => {
    // Arrange
    const first = { Path: 'synthetic', PATH: 'synthetic', straße: 'one', STRASSE: 'two', é: 'three', É: 'four' };
    const second = Object.fromEntries(Object.entries(first).reverse());
    // Act
    const a = copy(first), b = copy(second); first.Path = 'later';
    // Assert
    assert.deepEqual(plain(a), { PATH: 'synthetic', straße: 'one', STRASSE: 'two', é: 'three', É: 'four' });
    assert.deepEqual(plain(b), plain(a)); assert.equal(a.PATH, 'synthetic'); assert.equal(second.Path, 'synthetic');
  });
  test(`Windows ${operation} environment rejects conflicting aliases with fixed redacted failure`, () => {
    // Arrange
    const input = { Path: 'synthetic-private-one', PATH: 'synthetic-private-two' };
    const original = structuredClone(input);
    // Act
    let failure; try { copy(input); } catch (error) { failure = error; }
    // Assert
    assert.equal(failure?.message, 'Invalid launch environment.'); assert.equal(failure?.cause, undefined);
    assert.equal(JSON.stringify(failure).includes('synthetic-private'), false); assert.deepEqual(input, original);
  });
}
test('POSIX environment preserves conflicting case-distinct names and Windows complete snapshots do not add SystemRoot', () => {
  // Arrange
  const input = { Path: 'one', PATH: 'two', elgato_action_context: 'unrelated-on-posix' };
  // Act
  const posix = validateLaunchOptions({ env: input }, 'posix');
  const empty = validateLaunchOptions({ env: {} }, 'win32');
  const omitted = validateLaunchOptions(undefined, 'win32');
  const explicit = validateLaunchOptions({ env: { SAFE: 'only' } }, 'win32');
  // Assert
  assert.deepEqual(plain(posix), input); assert.deepEqual(plain(empty), {}); assert.equal(omitted, undefined);
  assert.deepEqual(plain(explicit), { SAFE: 'only' }); assert.equal(Object.hasOwn(explicit, 'SystemRoot'), false);
});

test('all sixteen names overlay a copied environment without normalizing raw SDK text', () => {
  // Arrange: only synthetic environment data is ever asserted or printed.
  const inherited = Object.freeze({ ...stale(), PATH: '/synthetic/path', ELGATO_OTHER: 'keep', ABSENT: undefined });
  const metadata = Object.freeze(synthetic());
  // Act
  const result = createLaunchEnvironment(inherited, metadata);
  // Assert
  assert.deepEqual(plain(result), { PATH: '/synthetic/path', ELGATO_OTHER: 'keep', ...Object.fromEntries(fields.map(([name, field]) => [name, String(metadata[field])])) });
  assert.equal(inherited.ELGATO_KEY_ROW, 'STALE_SYNTHETIC');
  assert.notEqual(result, inherited);
});

for (const [name, field, type] of fields) {
  const valid = type === 'color' ? ['#000000', '#FFFFFF', '#Ab12Cd', '#969696']
    : type === 'string' ? ['', 'x'.repeat(4096), '😀'.repeat(1024)] : [0, 999, Number.MAX_SAFE_INTEGER];
  const invalid = type === 'color'
    ? [undefined, null, 3, false, {}, new String('#abcdef'), '', '#abc', '#abcdef00', 'abcdef', 'red', '#gg0000', ' #abcdef', '#abcdef ', '#abcdef\n', '#abcdef\r\n', '#abc\0ef', 'x'.repeat(4096)]
    : type === 'string'
    ? [undefined, null, 3, false, {}, new String('boxed'), 'x\0y', 'x'.repeat(4097), `${'😀'.repeat(1024)}x`]
    : [undefined, null, '0', false, {}, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1];
  valid.forEach((value, index) => test(`${field} retains valid scalar boundary ${index}`, () => {
    // Arrange
    const metadata = { [field]: value };
    // Act
    const result = createLaunchEnvironment(stale(), metadata);
    // Assert: zero, empty text, unknown numeric enum and exact byte cap survive.
    assert.deepEqual(plain(result), { [name]: type === 'color' ? value.toLowerCase() : String(value) });
  }));
  invalid.forEach((value, index) => test(`${field} omits invalid scalar ${index} independently and removes inherited collision`, () => {
    // Arrange
    const other = field === 'pluginUuid' ? 'appVersion' : 'pluginUuid';
    const otherName = fields.find(([, key]) => key === other)[0];
    // Act
    const result = createLaunchEnvironment(stale(), { [field]: value, [other]: 'VALID_SYNTHETIC' });
    // Assert: no truncation, string coercion or stale fallback.
    assert.deepEqual(plain(result), { [otherName]: 'VALID_SYNTHETIC' });
  }));
}

for (const field of fields.map(([, key]) => key)) {
  test(`metadata accessor ${field} is omitted without executing user code`, () => {
    // Arrange
    let reads = 0;
    const metadata = Object.defineProperty({}, field, { get() { reads++; throw new Error('SYNTHETIC_GETTER'); } });
    // Act
    const result = createLaunchEnvironment(stale(), metadata);
    // Assert
    assert.deepEqual(plain(result), {});
    assert.equal(reads, 0);
  });
}

test('metadata never invokes inherited fields, coercion, toJSON or proxy traps', () => {
  // Arrange
  let reads = 0;
  const hostile = { toString() { reads++; throw Error('SYNTHETIC'); }, toJSON() { reads++; throw Error('SYNTHETIC'); } };
  const metadata = Object.assign(Object.create({ actionContext: 'inherited' }), { deviceName: hostile, toJSON: hostile.toJSON });
  const proxy = new Proxy(metadata, { ownKeys() { reads++; throw Error('SYNTHETIC'); }, getOwnPropertyDescriptor() { reads++; throw Error('SYNTHETIC'); } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  // Act
  const results = [metadata, proxy, revoked.proxy, null, [], 'text'].map(value => createLaunchEnvironment(stale(), value));
  // Assert
  assert.deepEqual(results.map(plain), Array(6).fill({}));
  assert.equal(reads, 0);
});

test('theme metadata never coerces hostile objects or inherits color and always removes inherited collisions', () => {
  // Arrange
  let reads = 0;
  const hostile = { toString() { reads++; throw Error('synthetic coercion'); }, toJSON() { reads++; throw Error('synthetic serialization'); } };
  const inherited = Object.freeze({ ELGATO_ACTION_THEME_COLOR: 'synthetic-collision', ELGATO_UNRELATED: 'keep' });
  const metadata = Object.freeze({ actionThemeColor: '#AB12CD', pluginUuid: 'synthetic-plugin' });
  // Act
  const valid = createLaunchEnvironment(inherited, metadata);
  const invalid = createLaunchEnvironment(inherited, { actionThemeColor: hostile });
  const absent = createLaunchEnvironment(inherited, Object.create({ actionThemeColor: '#abcdef' }));
  // Assert
  assert.deepEqual(plain(valid), { ELGATO_UNRELATED: 'keep', ELGATO_ACTION_THEME_COLOR: '#ab12cd', ELGATO_PLUGIN_UUID: 'synthetic-plugin' });
  assert.deepEqual(plain(invalid), { ELGATO_UNRELATED: 'keep' }); assert.deepEqual(plain(absent), { ELGATO_UNRELATED: 'keep' });
  assert.equal(reads, 0); assert.equal(metadata.actionThemeColor, '#AB12CD'); assert.equal(inherited.ELGATO_ACTION_THEME_COLOR, 'synthetic-collision');
});

test('two keys and consecutive launches own independent environment snapshots', () => {
  // Arrange
  const inherited = { PATH: '/synthetic/one', ...stale() };
  const metadata = { actionContext: 'key-one', deviceName: 'before', keyColumn: 0 };
  // Act
  const first = createLaunchEnvironment(inherited, metadata);
  metadata.deviceName = 'after'; delete metadata.keyColumn; inherited.PATH = '/synthetic/two';
  const resumed = createLaunchEnvironment(inherited, metadata);
  const secondKey = createLaunchEnvironment(inherited, { actionContext: 'key-two', keyRow: 0 });
  resumed.ELGATO_DEVICE_NAME = 'changed-copy';
  // Assert
  assert.deepEqual(plain(first), { PATH: '/synthetic/one', ELGATO_ACTION_CONTEXT: 'key-one', ELGATO_DEVICE_NAME: 'before', ELGATO_KEY_COLUMN: '0' });
  assert.deepEqual(plain(secondKey), { PATH: '/synthetic/two', ELGATO_ACTION_CONTEXT: 'key-two', ELGATO_KEY_ROW: '0' });
  assert.equal(Object.hasOwn(resumed, 'ELGATO_KEY_COLUMN'), false);
  assert.equal(metadata.deviceName, 'after');
});

const malformedOptions = [
  ['null', () => null], ['array', () => []], ['primitive', () => 'SYNTHETIC_PRIVATE'],
  ['missing env', () => ({})], ['extra option', () => ({ env: {}, other: 'SYNTHETIC_PRIVATE' })],
  ['symbol option', () => ({ env: {}, [Symbol('synthetic')]: 'SYNTHETIC_PRIVATE' })],
  ['inherited env', () => Object.create({ env: {} })],
  ['option prototype', () => Object.assign(Object.create({ other: true }), { env: {} })],
  ['env null', () => ({ env: null })], ['env array', () => ({ env: [] })],
  ['env prototype', () => ({ env: Object.create({ inherited: 'value' }) })],
  ['empty key', () => ({ env: { '': 'SYNTHETIC_PRIVATE' } })],
  ['equals key', () => ({ env: { 'BAD=KEY': 'SYNTHETIC_PRIVATE' } })],
  ['NUL key', () => ({ env: { 'BAD\0KEY': 'SYNTHETIC_PRIVATE' } })],
  ['NUL value', () => ({ env: { SAFE: 'SYNTHETIC_PRIVATE\0' } })],
  ...[undefined, null, 1, false, {}, new String('boxed')].map((value, index) => [`nonstring ${index}`, () => ({ env: { SAFE: value } })]),
  ['symbol env key', () => ({ env: { [Symbol('synthetic')]: 'SYNTHETIC_PRIVATE' } })],
  ['nonenumerable env', () => Object.defineProperty({}, 'env', { value: {} })],
  ['nonenumerable field', () => ({ env: Object.defineProperty({}, 'SAFE', { value: 'SYNTHETIC_PRIVATE' }) })],
  ['env accessor', state => Object.defineProperty({}, 'env', { enumerable: true, get() { state.reads++; throw Error('SYNTHETIC_PRIVATE'); } })],
  ['value accessor', state => ({ env: Object.defineProperty({}, 'SAFE', { enumerable: true, get() { state.reads++; throw Error('SYNTHETIC_PRIVATE'); } }) })],
  ['option proxy', state => new Proxy({ env: {} }, { getPrototypeOf() { state.reads++; throw Error('SYNTHETIC_PRIVATE'); } })],
  ['env proxy', state => ({ env: new Proxy({}, { ownKeys() { state.reads++; throw Error('SYNTHETIC_PRIVATE'); } }) })],
  ['revoked proxy', () => { const p = Proxy.revocable({}, {}); p.revoke(); return p.proxy; }],
];

for (const [label, make] of malformedOptions) test(`explicit launch options reject ${label} without exposing values or invoking accessors`, () => {
  // Arrange
  const state = { reads: 0 }, input = make(state);
  // Act
  let error; try { validateLaunchOptions(input); } catch (caught) { error = caught; }
  // Assert
  assert.equal(error?.message, 'Invalid launch environment.');
  assert.equal(state.reads, 0);
});

for (const nullPrototype of [false, true]) test(`explicit complete environment copies ${nullPrototype ? 'null-prototype' : 'plain'} data`, () => {
  // Arrange
  const env = Object.assign(nullPrototype ? Object.create(null) : {}, { SAFE: '', __synthetic: 'é\n' });
  const input = Object.assign(nullPrototype ? Object.create(null) : {}, { env });
  // Act
  const result = validateLaunchOptions(input); env.SAFE = 'later';
  // Assert
  assert.deepEqual(plain(result), { SAFE: '', __synthetic: 'é\n' });
  assert.equal(validateLaunchOptions(undefined), undefined);
  assert.deepEqual(plain(validateLaunchOptions({ env: {} })), {});
});

for (const [label, make] of [
  ['null', () => null], ['array', () => []], ['proxy', state => new Proxy({}, { ownKeys() { state.reads++; throw Error('SYNTHETIC'); } })],
  ['accessor', state => Object.defineProperty({}, 'SAFE', { enumerable: true, get() { state.reads++; throw Error('SYNTHETIC'); } })],
  ['symbol', () => ({ [Symbol('synthetic')]: 'value' })], ['invalid key', () => ({ 'BAD=KEY': 'value' })],
  ['NUL value', () => ({ SAFE: 'value\0' })], ['number', () => ({ SAFE: 3 })],
]) test(`inherited environment rejects ${label} safely rather than coercing data`, () => {
  // Arrange
  const state = { reads: 0 }, inherited = make(state);
  // Act
  let error; try { createLaunchEnvironment(inherited, synthetic()); } catch (caught) { error = caught; }
  // Assert
  assert.equal(error?.message, 'Invalid launch environment.');
  assert.equal(state.reads, 0);
});

// Authorized adapter harness: transpile the real action and shared runtime, never the plugin entry.
// SDK, process launch, logger and event registration are boundaries. All lifecycle
// coordinators and metadata transformations below are the real project helpers.
const adapterCodes = await loadAdapterCode(['run']);
const registration = () => ({ plugin: { uuid: 'synthetic-plugin', version: '0.1.0.0' }, application: { version: '7.6', language: 'fr', platform: 'mac', platformVersion: '26' } });
// All fake I/O resolves in microtasks unless explicitly gated. A check-phase turn
// gives that work a progress opportunity without inspecting any core queue.
const progress = () => new Promise(resolve => setImmediate(resolve));

function adapterHarness() {
  const launches = [], listeners = new Map(), replies = [], logs = [], registrations = [];
  const sdk = { info: registration(), logger: { info(value) { logs.push(value); }, warn(value) { logs.push(value); } },
    ui: { async sendToPropertyInspector(payload) { replies.push(structuredClone(payload)); } } };
  const sdkModule = { default: sdk, SingletonAction: class {}, action: () => value => value };
  const runner = { startProcessRun(settings, callbacks, dependencies, { env }) {
    // Discard all actual inherited values; retain only synthetic action metadata.
    const snapshot = Object.fromEntries(fields.filter(([name]) => Object.hasOwn(env, name)).map(([name]) => [name, env[name]]));
    let resolve;
    const done = new Promise(yes => { resolve = yes; });
     const launch = { snapshot, settings: structuredClone(settings), stops: 0, callbacks, resolve }; launches.push(launch);
    callbacks.onDiagnostic('PROCESS_SPAWN_SUCCEEDED');
    return { done, async stop() { launch.stops++; resolve({ status: 'stopped' }); return true; } };
  } };
  const syntheticProcess = { env: Object.freeze({ ...stale(), PATH: '/synthetic/path' }), cwd: () => '/synthetic/cwd', platform: 'darwin' };
  const isolatedRequire = createAdapterLoader(adapterCodes, { process: syntheticProcess, resolve(name) {
    if (name === '@elgato/streamdeck') return sdkModule;
    if (name === '../core/process-runner.mjs') return runner;
   } });
  const exports = isolatedRequire('./run');
  const register = name => listener => { registrations.push(name); listeners.set(name, listener); return { dispose() {} }; };
  const action = new exports.RunAction({ onDeviceDidConnect: register('connect'), onDeviceDidDisconnect: register('disconnect'), onSystemDidWakeUp: register('wake') });
  return { ...exports, action, sdk, launches, replies, logs, registrations,
    async emit(name, device) { listeners.get(name)?.({ device }); await progress(); } };
}

function runtime(id = 'synthetic-key', initialSettings = { executable: '/synthetic/program', args: [], runRequested: true }) {
  let settings = structuredClone(initialSettings);
  const display = [], writes = [];
  return {
    id, manifestId: 'synthetic-action', device: { id: 'synthetic-device', name: 'synthetic-name', type: 999, size: { columns: 0, rows: 3 }, isConnected: true },
    coordinates: { column: 0, row: 2 }, isKey: () => true,
    display, writes,
    async setSettings(next) { settings = next; writes.push(structuredClone(next)); }, async getSettings() { return settings; },
    async setImage(image) { display.push(['image', image]); }, async setTitle(title) { display.push(['title', title]); },
  };
}
const appear = async (h, r) => h.action.onWillAppear({ action: r, payload: { settings: await r.getSettings() } });
async function startAdapter(h, r) {
  await appear(h, r);
  r.display.length = 0; // Running scenarios observe from the explicit press; fresh Ready has separate coverage.
  await h.action.onKeyDown({ action: r, payload: { settings: await r.getSettings() } });
}

function boundaryGate() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const artworkSvg = image => decodeURIComponent(image.slice('data:image/svg+xml,'.length));

// Slice 4: effective key theme is captured only at an authorized actual launch.
for (const [themeColor, expected] of [[undefined, '#969696'], ['#ABCDEF', '#abcdef'], ['red', '#969696'], ['#abcdef\n', '#969696']]) {
  test(`actual Stream launch captures effective theme case ${String(themeColor)}`, { timeout: 3000 }, async t => {
    // Arrange
    const h = adapterHarness(), r = runtime('synthetic-theme', { executable: '/synthetic/report.py', argsText: '', runRequested: true,
      ...(themeColor === undefined ? {} : { themeColor }) });
    t.after(() => h.action.onWillDisappear({ action: r }));
    // Act
    await startAdapter(h, r);
    // Assert: inherited collision is replaced; invalid renderer inputs use the default.
    assert.equal(h.launches.length, 1); assert.equal(h.launches[0].snapshot.ELGATO_ACTION_THEME_COLOR, expected);
    assert.deepEqual(r.writes, []);
    assert.equal(h.logs.some(value => value.includes('ELGATO_ACTION_THEME_COLOR')), false);
  });
}

test('actual Stream theme edits isolate keys, preserve running snapshots and export the new theme on resume', { timeout: 3000 }, async t => {
  // Arrange
  const h = adapterHarness(), first = runtime('synthetic-theme-one', { executable: '/synthetic/report.py', argsText: '', runRequested: true, themeColor: '#123456' });
  const second = runtime('synthetic-theme-two', { executable: '/synthetic/report.sh', argsText: '', runRequested: true, themeColor: '#654321' });
  t.after(async () => { await h.action.onWillDisappear({ action: first }); await h.action.onWillDisappear({ action: second }); });
  await startAdapter(h, first); await startAdapter(h, second); await claimInspector(h, first);
  const original = structuredClone(h.launches[0].snapshot), secondDisplay = [...second.display];
  // Act
  await sendInspector(h, first, 'canvas:edit', 3, { changes: { themeColor: '#ABCDEF' } });
  const runningCount = h.launches.length, runningStops = h.launches.map(launch => launch.stops);
  await h.action.onWillDisappear({ action: first }); await appear(h, first);
  // Assert
  assert.equal(runningCount, 2); assert.deepEqual(runningStops, [0, 0]); assert.deepEqual(h.launches[0].snapshot, original);
  assert.equal(h.launches[1].snapshot.ELGATO_ACTION_THEME_COLOR, '#654321'); assert.deepEqual(second.display, secondDisplay);
  assert.equal(h.launches[2].snapshot.ELGATO_ACTION_THEME_COLOR, '#abcdef'); assert.equal(h.launches.length, 3);
  assert.deepEqual(second.writes, []); assert.deepEqual(first.writes.map(value => value.runRequested), [true]);
  assert.equal(h.replies.some(reply => JSON.stringify(reply).includes('ELGATO_')), false);
  assert.equal(h.logs.some(value => value.includes('#abcdef') || value.includes('STALE_SYNTHETIC')), false);
});

for (const failed of [false, true]) {
  test(`actual Stream waits for pending theme confirmation after Started and Loading; failed=${failed}`, { timeout: 3000 }, async t => {
    // Arrange: hold only SDK display and settings readback, never core/authority logic.
    const initial = { executable: '/synthetic/report.py', argsText: '', runRequested: false, themeColor: '#123456' };
    const h = adapterHarness(), r = runtime('synthetic-final-theme', initial), loading = boundaryGate(), loadingEntered = boundaryGate();
    const read = boundaryGate(), readEntered = boundaryGate();
    t.after(() => h.action.onWillDisappear({ action: r })); await appear(h, r); await claimInspector(h, r);
    const originalImage = r.setImage, originalRead = r.getSettings;
    r.setImage = async image => { await originalImage(image); if (artworkSvg(image).includes('>loading...</text>')) { loadingEntered.resolve(); await loading.promise; } };
    const starting = h.action.onKeyDown({ action: r, payload: { settings: initial } }); await loadingEntered.promise;
    // The explicit Start has local intent only; the theme edit is the first configuration write.
    const started = await originalRead();
    r.getSettings = async () => { const snapshot = await originalRead(); readEntered.resolve(snapshot); return read.promise; };
    const editing = sendInspector(h, r, 'canvas:edit', 3, { changes: { themeColor: '#ABCDEF' } });
    const snapshot = await readEntered.promise;
    // Act
    loading.resolve(); await progress();
    const before = h.launches.length;
    await h.action.onDidReceiveSettings({ action: r, payload: { settings: started } });
    const afterRejectedHost = h.launches.length;
    read.resolve(failed ? started : Object.fromEntries(Object.entries(snapshot).reverse()));
    await Promise.all([starting, editing]); await progress();
    // Assert: order-independent complete equality, not stale reports or legacy intent metadata.
    assert.equal(before, 0); assert.equal(afterRejectedHost, 0);
    assert.equal(started.runRequested, false); assert.equal(snapshot.themeColor, '#abcdef'); assert.equal(snapshot.runRequested, false);
    assert.deepEqual(r.writes.map(value => value.runRequested), [false]);
    assert.equal(h.launches.length, failed ? 0 : 1);
    assert.equal(h.replies.at(-1).status, failed ? 'error' : 'saved');
    if (failed) assert.equal(r.display.at(-1)[1], createErrorArtwork('STATE_SAVE_FAILED', '#abcdef'));
    else assert.equal(h.launches[0].snapshot.ELGATO_ACTION_THEME_COLOR, '#abcdef');
  });
}

// Slice 3: exercise the real Run adapter without SDK startup or real programs.

async function pendingThemeLaunch(t) {
  const initial = { executable: '/synthetic/report.py', argsText: '', runRequested: false, themeColor: '#123456' };
  const h = adapterHarness(), r = runtime('synthetic-pending-theme', initial);
  const loading = boundaryGate(), loadingEntered = boundaryGate(), read = boundaryGate(), readEntered = boundaryGate();
  t.after(() => h.action.onWillDisappear({ action: r })); await appear(h, r); await claimInspector(h, r);
  const originalImage = r.setImage, originalRead = r.getSettings;
  r.setImage = async image => { await originalImage(image); if (artworkSvg(image).includes('>loading...</text>')) { loadingEntered.resolve(); await loading.promise; } };
  const starting = h.action.onKeyDown({ action: r, payload: { settings: initial } });
  await loadingEntered.promise;
  let holdRead = true;
  r.getSettings = async () => {
    const snapshot = await originalRead();
    if (holdRead) { holdRead = false; readEntered.resolve(snapshot); return read.promise; }
    return snapshot;
  };
  const editing = sendInspector(h, r, 'canvas:edit', 3, { changes: { themeColor: '#ABCDEF' } });
  const snapshot = await readEntered.promise; loading.resolve(); await progress();
  return { h, r, read, snapshot, starting, editing };
}

// Direct persistence injection at this boundary remains in action-session.test.mjs.
for (const loss of ['hide', 'disconnect', 'stop', 'execution']) {
  test(`actual Stream ${loss} at the final authority wait prevents stale spawn without extra launch writes`, { timeout: 3000 }, async t => {
    // Arrange: local Started intent exists and Loading has finished; only theme readback remains pending.
    const { h, r, read, snapshot, starting, editing } = await pendingThemeLaunch(t);
    const before = h.launches.length;
    // Act
    const transition = loss === 'hide' ? h.action.onWillDisappear({ action: r }) : loss === 'disconnect' ? h.emit('disconnect', { ...r.device, isConnected: false })
      : loss === 'stop' ? h.action.onKeyDown({ action: r, payload: { settings: {} } })
         : sendInspector(h, r, 'canvas:edit', 4, { changes: { executable: '/synthetic/replacement.sh' } });
    await progress();
    read.resolve(snapshot); await Promise.all([starting, editing, transition]); await progress();
    // Assert
    assert.equal(before, 0); assert.deepEqual(h.launches, []);
    assert.deepEqual(r.writes.map(value => value.runRequested), loss === 'execution' ? [false, false] : [false]);
    assert.equal(h.replies.at(-1).status, 'saved');
  });
}

for (const oldResult of ['match', 'mismatch', 'reject']) {
  test(`actual Stream superseded theme ${oldResult} waits for stable latest authority revision and launches once`, { timeout: 3000 }, async t => {
    // Arrange
    const { h, r, read, snapshot, starting, editing } = await pendingThemeLaunch(t);
    // Act
    const newer = sendInspector(h, r, 'canvas:edit', 4, { changes: { themeColor: '#FEDCBA' } });
    // The real adapter stages configuration before its first save await.
    if (oldResult === 'reject') read.reject(Error('superseded synthetic read'));
    else read.resolve(oldResult === 'match' ? snapshot : { ...snapshot, themeColor: '#000000' });
    await Promise.all([starting, editing, newer]); await progress();
    // Assert
    assert.equal(h.launches.length, 1); assert.equal(h.launches[0].snapshot.ELGATO_ACTION_THEME_COLOR, '#fedcba');
    assert.equal(h.launches[0].stops, 0); assert.deepEqual(r.writes.map(value => value.runRequested), [false, false]);
    assert.deepEqual(r.writes.map(value => value.themeColor), ['#abcdef', '#fedcba']);
    assert.equal(h.replies.at(-1).status, 'saved');
  });
}

test('actual Stream adapter keeps suffix badges independent and redraws a suffix-only replacement', { timeout: 3000 }, async t => {
  // Arrange
  const h = adapterHarness(), first = runtime('synthetic-badge-one', { executable: '/synthetic/report.py', argsText: '', runRequested: false });
  const second = runtime('synthetic-badge-two', { executable: '/synthetic/report.sh', argsText: '', runRequested: false });
  t.after(async () => { await h.action.onWillDisappear({ action: first }); await h.action.onWillDisappear({ action: second }); });
  await appear(h, first); await appear(h, second); await claimInspector(h, first);
  const secondDisplay = [...second.display];
  // Act
  await sendInspector(h, first, 'canvas:edit', 3, { changes: { executable: '/synthetic/report.GZ' } });
  await progress();
  // Assert
  assert.match(artworkSvg(first.display.at(-1)[1]), /text-anchor="end"[^>]*>\.gz<\/text>.*>report<\/text>/);
  assert.match(artworkSvg(second.display.at(-1)[1]), /text-anchor="end"[^>]*>\.sh<\/text>/);
  assert.deepEqual(second.display, secondDisplay); assert.deepEqual(second.writes, []);
  assert.deepEqual(h.launches, []); assert.ok(first.display.filter(([kind]) => kind === 'title').every(([, title]) => title === ''));
});

for (const output of [false, true]) {
  test(`actual Stream adapter forwards Loading/Exited suffix without overlaying producer output=${output}`, { timeout: 3000 }, async t => {
    // Arrange
    const h = adapterHarness(), r = runtime('synthetic-badge-run', { executable: '/synthetic/report.PY', argsText: 'other.sh', runRequested: true });
    t.after(() => h.action.onWillDisappear({ action: r })); await startAdapter(h, r);
    // Act
    if (output) { h.launches[0].callbacks.onUpdate({ kind: 'image', image: 'data:image/png;base64,AAAA' }); await progress(); }
    h.launches[0].callbacks.onDiagnostic('PROCESS_EXITED_SUCCESSFULLY'); h.launches[0].resolve({ status: 'success' }); await progress();
    const frames = r.display.filter(([kind]) => kind === 'image').map(([, value]) => value);
    // Assert
    assert.match(artworkSvg(frames[0]), />\.py<\/text>.*>report<\/text>.*>loading\.\.\.<\/text>/);
    assert.match(artworkSvg(frames.at(-1)), />\.py<\/text>.*>report<\/text>.*>exited<\/text>/);
    if (output) assert.equal(frames[1], 'data:image/png;base64,AAAA');
    assert.equal(frames.length, output ? 3 : 2); assert.equal(h.launches.length, 1);
    assert.deepEqual(r.writes, []);
  });
}

for (const loss of ['hide', 'disconnect']) {
  test(`actual Stream title-clear boundary cannot hand off stale badge after ${loss}`, { timeout: 3000 }, async t => {
    // Arrange
    const h = adapterHarness(), r = runtime('synthetic-held-badge', { executable: '/synthetic/report.py', argsText: '', runRequested: false });
    const gate = boundaryGate(), entered = boundaryGate(); let hold = true;
    t.after(() => h.action.onWillDisappear({ action: r }));
    r.setTitle = async title => { r.display.push(['title', title]); if (hold) { hold = false; entered.resolve(); await gate.promise; } };
    const appearing = appear(h, r); await entered.promise;
    // Act
    const transition = loss === 'hide' ? h.action.onWillDisappear({ action: r })
      : h.emit('disconnect', { ...r.device, isConnected: false });
    await progress(); gate.resolve(); await Promise.all([appearing, transition]); await progress();
    // Assert
    assert.equal(r.display.filter(([kind]) => kind === 'image').some(([, value]) => artworkSvg(value).includes('>.py</text>')), false);
    assert.deepEqual(h.launches, []);
  });
}

// Slice 2: real Run adapter forwards Setup artwork and clears the native title without launch authority.
for (const [index, input] of [{}, { executable: '', argsText: '' }, { args: ['literal'], cwd: '/synthetic/work' }].entries()) {
  test(`actual Run adapter Setup ${index} clears title and ignores repeated presses without hydration writes`, { timeout: 3000 }, async t => {
    // Arrange
    const h = adapterHarness(), r = runtime('synthetic-setup', input);
    t.after(() => h.action.onWillDisappear({ action: r }));
    // Act
    await appear(h, r);
    await h.action.onKeyDown({ action: r, payload: { settings: input } });
    await h.action.onKeyDown({ action: r, payload: { settings: { executable: '/synthetic/stale', argsText: '', runRequested: true } } });
    await progress();
    // Assert
    assert.match(artworkSvg(r.display.at(-1)[1]), /aria-label="Setup required".*>setup required<\/text>/);
    assert.deepEqual(r.display.filter(([kind]) => kind === 'title'), [['title', '']]);
    assert.deepEqual(r.writes, []); assert.deepEqual(h.launches, []);
  });
}
for (const input of [{ runRequested: 'malformed' }, { executable: 'relative', argsText: '' }]) {
  test('actual Run adapter invalid/restored Started settings retain fixed Error rather than Setup', { timeout: 3000 }, async t => {
    // Arrange
    const h = adapterHarness(), r = runtime('synthetic-invalid-setup', input);
    t.after(() => h.action.onWillDisappear({ action: r }));
    // Act
    await appear(h, r); await progress();
    // Assert
    assert.match(artworkSvg(r.display.at(-1)[1]), />Error<\/text>/);
    assert.equal(r.display.some(([kind, image]) => kind === 'image' && artworkSvg(image).includes('setup required')), false);
    assert.ok(r.display.filter(([kind]) => kind === 'title').every(([, title]) => title === ''));
    assert.deepEqual(h.launches, []);
    assert.equal(r.writes.length, 0);
  });
}
test('actual Run adapter delayed Setup cannot overwrite newer confirmed Ready after PI configuration', { timeout: 3000 }, async t => {
  // Arrange
  const h = adapterHarness(), r = runtime('synthetic-stale-setup-ready', {}), entered = boundaryGate(), gate = boundaryGate();
  t.after(() => h.action.onWillDisappear({ action: r }));
  let delay = true;
  r.setTitle = async title => { r.display.push(['title', title]); if (delay) { delay = false; entered.resolve(); await gate.promise; } };
  // Act
  const appearing = appear(h, r); await entered.promise; await claimInspector(h, r);
  const editing = sendInspector(h, r, 'canvas:edit', 3, { changes: { executable: '/synthetic/report.py' } });
  gate.resolve(); await Promise.all([appearing, editing]); await progress();
  // Assert
  assert.equal(r.display.some(([kind, image]) => kind === 'image' && artworkSvg(image).includes('setup required')), false);
  assert.match(artworkSvg(r.display.at(-1)[1]), />report<\/text>.*>ready<\/text>/);
  assert.equal(h.replies.at(-1)?.status, 'saved'); assert.deepEqual(h.launches, []);
  assert.deepEqual(await r.getSettings(), { executable: '/synthetic/report.py', argsText: '' });
});

for (const output of [false, true]) {
  test(`actual adapter clears native titles and forwards exited footer after natural success ${output ? 'with output' : 'without output'}`, { timeout: 3000 }, async t => {
    // Arrange
    const h = adapterHarness(), r = runtime();
    t.after(() => h.action.onWillDisappear({ action: r }));
    await startAdapter(h, r);
    if (output) { h.launches[0].callbacks.onUpdate({ kind: 'image', image: 'data:image/png;base64,AAAA' }); await progress(); }
    // Act
    h.launches[0].callbacks.onDiagnostic('PROCESS_EXITED_SUCCESSFULLY'); h.launches[0].resolve({ status: 'success' });
    await progress();
    const saved = await r.getSettings();
    await appear(h, r);
    // Assert
    const images = r.display.filter(item => item[0] === 'image').map(item => item[1]);
    assert.match(artworkSvg(images[0]), />program<\/text>.*>loading\.\.\.<\/text>/);
    assert.match(artworkSvg(images.at(-1)), />program<\/text>.*>exited<\/text>/);
    assert.equal(images.length, output ? 3 : 2);
    if (output) assert.equal(images[1], 'data:image/png;base64,AAAA');
    assert.deepEqual(r.display.filter(item => item[0] === 'title'), Array(output ? 3 : 2).fill(['title', '']));
    assert.ok(r.display.every((item, index) => item[0] !== 'image' || r.display[index - 1]?.[0] === 'title'));
    assert.deepEqual(r.writes, []);
    assert.deepEqual(saved, { executable: '/synthetic/program', args: [], runRequested: true });
    assert.equal(h.launches.length, 1);
  });
}

test('actual adapter fresh Stopped key uses ready while another key retains session-local exited', { timeout: 3000 }, async t => {
  // Arrange
  const h = adapterHarness(), r = runtime();
  t.after(async () => { await h.action.onWillDisappear({ action: r }); await h.action.onWillDisappear({ action: fresh }); });
  await startAdapter(h, r);
  h.launches[0].callbacks.onDiagnostic('PROCESS_EXITED_SUCCESSFULLY'); h.launches[0].resolve({ status: 'success' }); await progress();
  const fresh = runtime('synthetic-fresh', await r.getSettings());
  // Act
  await appear(h, fresh);
  // Assert
  assert.match(artworkSvg(r.display.at(-1)[1]), />exited<\/text>/);
  assert.match(artworkSvg(fresh.display.at(-1)[1]), />program<\/text>.*>ready<\/text>/);
  assert.deepEqual(fresh.display[0], ['title', '']);
  assert.deepEqual(fresh.writes, []);
  assert.equal(h.launches.length, 1);
});

// Core-only persistence supersession is covered by deferred exited publication tests.
for (const superseding of ['start']) {
  test(`actual adapter rechecks title-clear guard so delayed exited SVG cannot replace newer ${superseding}`, { timeout: 3000 }, async t => {
    // Arrange
    const h = adapterHarness(), r = runtime(), gate = boundaryGate(), entered = boundaryGate();
    t.after(() => h.action.onWillDisappear({ action: r }));
    await startAdapter(h, r);
    let delay = true;
    r.setTitle = async title => { r.display.push(['title', title]); if (delay) { delay = false; entered.resolve(); await gate.promise; } };
    // Act
    h.launches[0].callbacks.onDiagnostic('PROCESS_EXITED_SUCCESSFULLY'); h.launches[0].resolve({ status: 'success' }); await entered.promise;
    const transition = h.action.onKeyDown({ action: r, payload: { settings: await r.getSettings() } });
    gate.resolve(); await transition; await progress();
    // Assert
    const images = r.display.filter(item => item[0] === 'image').map(item => artworkSvg(item[1]));
    assert.equal(images.some(svg => />exited<\/text>/.test(svg)), false);
    assert.ok(r.display.filter(item => item[0] === 'title').every(item => item[1] === ''));
    assert.match(images.at(-1), />program<\/text>.*>loading\.\.\.<\/text>/); assert.equal(h.launches.length, 2);
  });
}

for (const diagnostic of ['PROCESS_EXITED_NONZERO', 'PROCESS_TERMINATED_BY_SIGNAL']) {
  test(`actual adapter preserves fixed ${diagnostic} error instead of success footer`, { timeout: 3000 }, async t => {
    // Arrange
    const h = adapterHarness(), r = runtime('synthetic-error-badge', { executable: '/synthetic/report.py', args: [], runRequested: true });
    t.after(() => h.action.onWillDisappear({ action: r }));
    await startAdapter(h, r);
    // Act
    h.launches[0].callbacks.onDiagnostic(diagnostic);
    h.launches[0].resolve({ status: 'error', error: 'Program exited unsuccessfully.' }); await progress();
    // Assert
    assert.equal(r.display.at(-1)[1], createErrorArtwork(diagnostic));
    assert.deepEqual(r.display.at(-2), ['title', '']);
    assert.equal(r.display.filter(item => item[0] === 'image').some(item => />exited<\/text>/.test(artworkSvg(item[1]))), false);
    assert.equal(h.launches.length, 1);
  });
}

test('public SDK adapter captures all approved public fields without arbitrary serialization', () => {
  // Arrange
  const h = adapterHarness(), r = runtime(), info = registration();
  let reads = 0; r.toJSON = () => { reads++; throw Error('SYNTHETIC'); };
  // Act
  const result = createLaunchEnvironment({}, h.captureLaunchMetadata(r, info));
  // Assert
  assert.deepEqual(plain(result), {
    ELGATO_PLUGIN_UUID: 'synthetic-plugin', ELGATO_PLUGIN_VERSION: '0.1.0.0', ELGATO_ACTION_UUID: 'synthetic-action', ELGATO_ACTION_CONTEXT: 'synthetic-key',
    ELGATO_DEVICE_ID: 'synthetic-device', ELGATO_DEVICE_NAME: 'synthetic-name', ELGATO_DEVICE_TYPE: '999', ELGATO_DEVICE_COLUMNS: '0', ELGATO_DEVICE_ROWS: '3',
    ELGATO_KEY_COLUMN: '0', ELGATO_KEY_ROW: '2', ELGATO_APP_VERSION: '7.6', ELGATO_APP_LANGUAGE: 'fr', ELGATO_APP_PLATFORM: 'mac', ELGATO_APP_PLATFORM_VERSION: '26',
  });
  assert.equal(reads, 0);
});

for (const [group, property, omitted] of [
  ['action', 'id', ['ELGATO_ACTION_CONTEXT']], ['action', 'manifestId', ['ELGATO_ACTION_UUID']],
  ['action', 'device', fields.filter(([name]) => name.startsWith('ELGATO_DEVICE_')).map(([name]) => name)],
  ['action', 'coordinates', ['ELGATO_KEY_COLUMN', 'ELGATO_KEY_ROW']],
  ['device', 'name', ['ELGATO_DEVICE_NAME']], ['device', 'size', ['ELGATO_DEVICE_COLUMNS', 'ELGATO_DEVICE_ROWS']],
  ['device', 'id', ['ELGATO_DEVICE_ID']], ['device', 'type', ['ELGATO_DEVICE_TYPE']],
  ['size', 'columns', ['ELGATO_DEVICE_COLUMNS']], ['coordinates', 'column', ['ELGATO_KEY_COLUMN']],
  ['size', 'rows', ['ELGATO_DEVICE_ROWS']], ['coordinates', 'row', ['ELGATO_KEY_ROW']],
  ['plugin', 'uuid', ['ELGATO_PLUGIN_UUID']], ['application', 'language', ['ELGATO_APP_LANGUAGE']],
  ['plugin', 'version', ['ELGATO_PLUGIN_VERSION']], ['application', 'version', ['ELGATO_APP_VERSION']],
  ['application', 'platform', ['ELGATO_APP_PLATFORM']], ['application', 'platformVersion', ['ELGATO_APP_PLATFORM_VERSION']],
  ['info', 'plugin', ['ELGATO_PLUGIN_UUID', 'ELGATO_PLUGIN_VERSION']],
  ['info', 'application', fields.filter(([name]) => name.startsWith('ELGATO_APP_')).map(([name]) => name)],
]) test(`SDK ${group}.${property} getter failure omits only affected public fields`, () => {
  // Arrange
  const h = adapterHarness(), r = runtime(), info = registration();
  const targets = { action: r, device: r.device, size: r.device.size, coordinates: r.coordinates, plugin: info.plugin, application: info.application, info };
  const expected = plain(createLaunchEnvironment({}, h.captureLaunchMetadata(r, info)));
  for (const name of omitted) delete expected[name];
  Object.defineProperty(targets[group], property, { get() { throw Error('SYNTHETIC_PRIVATE'); } });
  // Act
  const result = createLaunchEnvironment(stale(), h.captureLaunchMetadata(r, info));
  // Assert
  assert.deepEqual(plain(result), expected);
});

for (const coordinates of [undefined, { column: 0 }, { row: 0 }, { column: -1, row: 0 }]) test(`SDK optional coordinates ${JSON.stringify(coordinates)} remain independent without guesses`, () => {
  // Arrange
  const h = adapterHarness(), r = runtime(); r.coordinates = coordinates;
  // Act
  const env = createLaunchEnvironment(stale(), h.captureLaunchMetadata(r, registration()));
  // Assert
  assert.equal(env.ELGATO_KEY_COLUMN, coordinates?.column === 0 ? '0' : undefined);
  assert.equal(env.ELGATO_KEY_ROW, coordinates?.row === 0 ? '0' : undefined);
});

test('SDK info getter failure preserves independent action metadata', () => {
  // Arrange
  const h = adapterHarness(); Object.defineProperty(h.sdk, 'info', { get() { throw Error('SYNTHETIC_PRIVATE'); } });
  // Act
  const env = createLaunchEnvironment(stale(), h.captureLaunchMetadata(runtime()));
  // Assert
  assert.equal(env.ELGATO_ACTION_CONTEXT, 'synthetic-key');
  assert.equal(fields.filter(([name]) => name.startsWith('ELGATO_APP_') || name.startsWith('ELGATO_PLUGIN_')).some(([name]) => Object.hasOwn(env, name)), false);
});

test('actual starts and eligible hide/resume capture fresh runtime and info while running snapshots stay unchanged', { timeout: 3000 }, async t => {
  // Arrange
  const h = adapterHarness(), first = runtime(), other = runtime('synthetic-other');
  t.after(async () => { await h.action.onWillDisappear({ action: first }); await h.action.onWillDisappear({ action: other }); });
  await startAdapter(h, first); await startAdapter(h, other);
  const original = { ...h.launches[0].snapshot };
  // Act: replace current action metadata without changing execution settings.
  const replacement = runtime(); replacement.device.name = 'replacement-name'; replacement.coordinates = undefined;
  h.sdk.info.application.version = 'new-version';
  await appear(h, replacement);
  const runningCount = h.launches.length;
  await h.action.onWillDisappear({ action: replacement });
  await appear(h, replacement);
  // Assert: no polling/relaunch while running; fresh capture only on actual resumption.
  assert.equal(runningCount, 2);
  assert.equal(h.launches.length, 3);
  assert.deepEqual(h.launches[0].snapshot, original);
  assert.equal(h.launches[1].snapshot.ELGATO_ACTION_CONTEXT, 'synthetic-other');
  assert.equal(h.launches[2].snapshot.ELGATO_DEVICE_NAME, 'replacement-name');
  assert.equal(h.launches[2].snapshot.ELGATO_APP_VERSION, 'new-version');
  assert.equal(Object.hasOwn(h.launches[2].snapshot, 'ELGATO_KEY_COLUMN'), false);
  assert.equal(h.launches[0].stops, 1);
});

test('manual Stopped action cannot create metadata launch from a later appearance', { timeout: 3000 }, async t => {
  // Arrange
  const h = adapterHarness(), r = runtime();
  t.after(() => h.action.onWillDisappear({ action: r }));
  await startAdapter(h, r);
  // Act
  await h.action.onKeyDown({ action: r, payload: { settings: await r.getSettings() } });
  r.device.name = 'changed-while-stopped';
  await h.action.onWillDisappear({ action: r }); await appear(h, r);
  // Assert
  assert.equal(h.launches.length, 1);
  assert.equal(h.launches[0].snapshot.ELGATO_DEVICE_NAME, 'synthetic-name');
});

const adapterOptions = { timeout: 3000 };
const sendInspector = (h, r, type, requestId, extra = {}) => h.action.onSendToPlugin({
  action: r, payload: { type, context: r.id, inspectorId: 'synthetic-inspector', requestId, ...extra },
});
async function claimInspector(h, r, inspectorId = 'synthetic-inspector') {
  await sendInspector(h, r, 'canvas:hello', 1, { inspectorId });
  const challenge = h.replies.at(-1);
  await sendInspector(h, r, 'canvas:claim', 2, { inspectorId, token: challenge.token });
}

for (const started of [false, true]) test(`extracted Stream adopts legacy ${started} as data and starts stopped without hydration writes`, adapterOptions, async t => {
  // Arrange: late host reports cannot replace the action's accepted snapshot.
  const initial = { executable: '/synthetic/program', args: ['SYNTHETIC_PRIVATE_ARG'], runRequested: started };
  const h = adapterHarness(), r = runtime('synthetic-key', initial);
  t.after(() => h.action.onWillDisappear({ action: r }));
  // Act
  await appear(h, r);
  await h.action.onDidReceiveSettings({ action: r, payload: { settings: { executable: '/synthetic/foreign', args: [], runRequested: !started } } });
  await appear(h, r);
  // Assert
  assert.deepEqual(r.writes, []);
  assert.deepEqual(await r.getSettings(), initial);
  assert.equal(h.launches.length, 0);
  assert.match(artworkSvg(r.display.at(-1)[1]), />program<\/text>.*>ready<\/text>/);
  assert.equal(h.logs.some(value => value.includes('SYNTHETIC_PRIVATE_ARG')), false);
});

test('extracted Stream toggles local intent without writes and ignores late key payload settings', adapterOptions, async t => {
  // Arrange
  const initial = { executable: '/synthetic/program', args: ['literal'], cwd: '/synthetic/work', runRequested: false };
  const h = adapterHarness(), r = runtime('synthetic-key', initial);
  t.after(() => h.action.onWillDisappear({ action: r }));
  await appear(h, r);
  // Act
  const late = { executable: '/synthetic/foreign', args: [], runRequested: false };
  await h.action.onKeyDown({ action: r, payload: { settings: late } });
  await h.action.onKeyDown({ action: r, payload: { settings: late } });
  await appear(h, r);
  // Assert
  assert.deepEqual(r.writes, []);
  assert.deepEqual(h.launches[0].settings, { executable: initial.executable, args: initial.args, cwd: initial.cwd });
  assert.equal(h.launches.length, 1);
  assert.equal(h.launches[0].stops, 1);
});

test('extracted Stream refuses launch when complete configuration readback does not match its write', adapterOptions, async t => {
  // Arrange: a cached host report is not an acknowledgment of a new write.
  const initial = { executable: '/synthetic/program', args: [], runRequested: false };
  const h = adapterHarness(), r = runtime('synthetic-key', initial);
  t.after(() => h.action.onWillDisappear({ action: r }));
  await appear(h, r);
  await claimInspector(h, r);
  r.getSettings = async () => structuredClone(initial);
  // Act
  await sendInspector(h, r, 'canvas:edit', 3, { changes: { argsText: 'changed' } });
  await h.action.onKeyDown({ action: r, payload: { settings: initial } });
  await progress();
  await h.action.onKeyDown({ action: r, payload: { settings: initial } });
  // Assert
  assert.deepEqual(r.writes, [{ ...initial, argsText: 'changed' }]);
  assert.equal(h.launches.length, 0);
  assert.equal(r.display.at(-1)[1], createErrorArtwork('STATE_SAVE_FAILED'));
});

for (const execution of [false, true]) test(`shared PI claimed ${execution ? 'execution' : 'theme'} edit preserves Run policy and complete settings`, adapterOptions, async t => {
  // Arrange
  const initial = { executable: '/synthetic/program', args: ['legacy'], runRequested: true };
  const h = adapterHarness(), r = runtime('synthetic-key', initial);
  t.after(() => h.action.onWillDisappear({ action: r }));
  await startAdapter(h, r); await claimInspector(h, r);
  const hydrationWrites = r.writes.length;
  const changes = execution ? { argsText: '"SYNTHETIC_PRIVATE_ARG"', cwd: '/synthetic/new-cwd' } : { themeColor: '#123456' };
  // Act
  await sendInspector(h, r, 'canvas:edit', 3, { changes });
  await progress();
  // Assert: claim/hydration never writes or launches; only execution edits stop.
  assert.equal(hydrationWrites, 0);
  assert.deepEqual(r.writes, [{ ...initial, ...changes }]);
  assert.equal(h.launches.length, 1);
  assert.equal(h.launches[0].stops, execution ? 1 : 0);
  assert.deepEqual(h.replies.at(-1), { status: 'saved', settings: r.writes[0], type: 'canvas:reply',
    context: r.id, inspectorId: 'synthetic-inspector', requestId: 3 });
  if (execution) assert.match(artworkSvg(r.display.at(-1)[1]), />program<\/text>.*>ready<\/text>/);
  assert.equal(h.logs.some(value => value.includes('SYNTHETIC_PRIVATE_ARG')), false);
});

for (const rejection of ['foreign context', 'unclaimed edit', 'wrong claim token', 'stale claim', 'foreign inspector', 'stale edit', 'invalid execution']) {
  test(`shared PI refuses ${rejection} without writes or Run replacement`, adapterOptions, async t => {
    // Arrange
    const h = adapterHarness(), r = runtime();
    t.after(() => h.action.onWillDisappear({ action: r }));
    await startAdapter(h, r);
    if (['foreign inspector', 'stale edit', 'invalid execution'].includes(rejection)) await claimInspector(h, r);
    if (['wrong claim token', 'stale claim'].includes(rejection)) await sendInspector(h, r, 'canvas:hello', 1);
    const before = h.replies.length;
    // Act
    if (rejection === 'foreign context') await sendInspector(h, r, 'canvas:hello', 1, { context: 'synthetic-foreign' });
    else if (rejection === 'wrong claim token') await sendInspector(h, r, 'canvas:claim', 2, { token: 'synthetic-wrong' });
    else if (rejection === 'stale claim') await sendInspector(h, r, 'canvas:claim', 1, { token: h.replies.at(-1).token });
    else await sendInspector(h, r, 'canvas:edit', rejection === 'stale edit' ? 2 : 3, {
      ...(rejection === 'foreign inspector' ? { inspectorId: 'synthetic-foreign' } : {}),
      changes: { executable: rejection === 'invalid execution' ? 'relative' : '/synthetic/replacement' },
    });
    // Assert
    assert.deepEqual(r.writes, []);
    assert.equal(h.launches.length, 1);
    assert.equal(h.launches[0].stops, 0);
    if (rejection === 'invalid execution') {
      assert.equal(h.replies.length, before + 1);
      assert.equal(h.replies.at(-1).status, 'error');
      assert.equal(h.replies.at(-1).diagnosticCode, 'INVALID_EXECUTABLE');
    } else assert.equal(h.replies.length, before);
  });
}

test('shared PI retiring an inspector rejects its later claim and edit', adapterOptions, async t => {
  // Arrange
  const h = adapterHarness(), r = runtime();
  t.after(() => h.action.onWillDisappear({ action: r }));
  await startAdapter(h, r); await claimInspector(h, r);
  await claimInspector(h, r, 'synthetic-new-inspector');
  const before = h.replies.length;
  // Act
  await sendInspector(h, r, 'canvas:hello', 4);
  await sendInspector(h, r, 'canvas:claim', 5, { token: '1' });
  await sendInspector(h, r, 'canvas:edit', 6, { changes: { cwd: '/synthetic/retired' } });
  // Assert
  assert.equal(h.replies.length, before);
  assert.deepEqual(r.writes, []);
  assert.equal(h.launches[0].stops, 0);
});

test('shared PI delayed hydration replies only to the newest correlated hello', adapterOptions, async t => {
  // Arrange: both requests share a held SDK read, not a fake authority or session.
  const h = adapterHarness(), r = runtime(), gate = boundaryGate(), entered = boundaryGate();
  const initial = await r.getSettings();
  t.after(() => h.action.onWillDisappear({ action: r }));
  r.getSettings = () => { entered.resolve(); return gate.promise; };
  // Act
  const older = sendInspector(h, r, 'canvas:hello', 1);
  await entered.promise;
  const newer = sendInspector(h, r, 'canvas:hello', 2);
  gate.resolve(initial);
  await Promise.all([older, newer]);
  // Assert
  assert.deepEqual(h.replies.map(({ status, context, inspectorId, requestId }) => ({ status, context, inspectorId, requestId })),
    [{ status: 'challenge', context: r.id, inspectorId: 'synthetic-inspector', requestId: 2 }]);
  assert.deepEqual(r.writes, []);
  assert.deepEqual(h.launches, []);
});

test('shared runtime drops a producer frame held at title clearing when the key hides', adapterOptions, async t => {
  // Arrange
  const h = adapterHarness(), r = runtime(), gate = boundaryGate(), entered = boundaryGate();
  t.after(() => h.action.onWillDisappear({ action: r }));
  await startAdapter(h, r);
  const before = r.display.filter(([kind]) => kind === 'image').length;
  r.setTitle = async title => { r.display.push(['title', title]); entered.resolve(); await gate.promise; };
  // Act
  h.launches[0].callbacks.onUpdate({ kind: 'image', image: 'data:image/png;base64,AAAA' });
  await entered.promise;
  const hiding = h.action.onWillDisappear({ action: r });
  gate.resolve(); await hiding; await progress();
  h.launches[0].callbacks.onUpdate({ kind: 'image', image: 'data:image/png;base64,BBBB' });
  await progress();
  // Assert: existing positive output tests cover handoff; hidden and late frames do not hand off.
  assert.equal(r.display.filter(([kind]) => kind === 'image').length, before);
  assert.equal(h.launches[0].stops, 1);
  assert.deepEqual(r.writes, []);
});

test('extracted Singleton Run registers hooks once and scopes disconnect/resume to the owning device', adapterOptions, async t => {
  // Arrange
  const h = adapterHarness(), first = runtime(), second = runtime('synthetic-second');
  second.device.id = 'synthetic-second-device';
  t.after(async () => { await h.action.onWillDisappear({ action: first }); await h.action.onWillDisappear({ action: second }); });
  await startAdapter(h, first); await startAdapter(h, second); await appear(h, first);
  // Act
  await h.emit('disconnect', { id: 'synthetic-foreign-device', isConnected: false });
  const foreignStops = h.launches.map(launch => launch.stops);
  first.device.isConnected = false; await h.emit('disconnect', first.device);
  first.device.name = 'synthetic-resumed'; delete first.device.size; first.coordinates = null;
  delete h.sdk.info.application.language;
  first.device.isConnected = true; await h.emit('connect', first.device); await h.emit('connect', first.device); await h.emit('wake');
  // Assert: fresh missing metadata has no stale fallback, other keys remain running.
  assert.deepEqual(h.registrations, ['connect', 'disconnect', 'wake']);
  assert.deepEqual(foreignStops, [0, 0]);
  assert.equal(h.launches.length, 3);
  assert.equal(h.launches[0].stops, 1);
  assert.equal(h.launches[1].stops, 0);
  assert.equal(h.launches[2].snapshot.ELGATO_DEVICE_NAME, 'synthetic-resumed');
  for (const name of ['ELGATO_DEVICE_COLUMNS', 'ELGATO_DEVICE_ROWS', 'ELGATO_KEY_COLUMN', 'ELGATO_KEY_ROW', 'ELGATO_APP_LANGUAGE']) {
    assert.equal(Object.hasOwn(h.launches[2].snapshot, name), false);
  }
  assert.deepEqual(first.writes, []);
  assert.deepEqual(second.writes, []);
});
