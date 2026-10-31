import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createInspectorFixture } from './helpers/inspector-harness.mjs';
import { loadAdapterCode, createAdapterLoader } from './helpers/adapter-harness.mjs';

// Objective: markup changes update the boundary fixture without a second ID inventory.
test('inspector fixture follows reordered tags/attributes and newly added controls', () => {
  // Arrange
  const first = `<sdpi-textfield id="draft" placeholder="local hint"></sdpi-textfield>
    <div id="group" hidden></div>`;
  const reordered = `<div hidden id='group'></div>
    <sdpi-textfield placeholder='local hint' id='draft'></sdpi-textfield>
    <a href="https://example.invalid/" id="new-link">Link</a>`;
  // Act
  const before = createInspectorFixture(first), after = createInspectorFixture(reordered);
  let clicks = 0;
  after.getElementById('new-link').addEventListener('click', () => { clicks++; });
  after.getElementById('new-link').dispatch('click');
  // Assert
  assert.equal(after.fields.draft.renderedHint, before.fields.draft.renderedHint);
  assert.equal(after.fields.group.hidden, before.fields.group.hidden);
  assert.equal(after.getElementById('new-link').getAttribute('href'), 'https://example.invalid/');
  assert.equal(before.getElementById('new-link'), null);
  assert.equal(clicks, 1);
});

test('inspector fixture never invents absent IDs from comments, scripts, styles or lookups', () => {
  // Arrange
  const html = `<!-- <a id="comment-only"></a> -->
    <script>const sample = '<a id="script-only"></a>';</script>
    <style>/* <a id="style-only"></a> */</style><a id="present"></a>`;
  // Act
  const fixture = createInspectorFixture(html);
  const absent = ['missing', 'comment-only', 'script-only', 'style-only'].map(fixture.getElementById);
  // Assert
  assert.ok(fixture.getElementById('present'));
  assert.deepEqual(absent, Array(4).fill(null));
  assert.equal(fixture.elements.size, 1);
});

// Objective: an actual missing required link still fails the existing production entry.
for (const id of ['github-project', 'ask-chatgpt']) {
  test(`built inspector detects absent authored ${id} rather than receiving an invented element`, () => {
    // Arrange
    const html = readFileSync(new URL('../src/inspector/run.html', import.meta.url), 'utf8');
    const script = readFileSync(new URL('../git.renaudcerrato.deckforge.sdPlugin/ui/run.js', import.meta.url), 'utf8');
    const fixture = createInspectorFixture(html.replace(`id="${id}"`, ''));
    const context = { window: { addEventListener() {} },
      document: { readyState: 'complete', getElementById: fixture.getElementById },
      setTimeout() { throw new Error('Unexpected timer before connection'); }, clearTimeout() {},
      WebSocket: class { constructor() { throw new Error('Unexpected socket before connection'); } },
    };
    // Act
    let failure;
    try { runInNewContext(script, context, { timeout: 1000 }); } catch (error) { failure = error; }
    // Assert
    assert.equal(fixture.getElementById(id), null);
    assert.equal(failure?.name, 'TypeError');
    assert.match(failure.message, /addEventListener/);
  });
}

test('inspector fixtures isolate values, attributes, visibility, status and listeners', () => {
  // Arrange
  const first = createInspectorFixture(), second = createInspectorFixture();
  let firstEvents = 0, secondEvents = 0;
  first.fields.argsText.addEventListener('valuechange', () => { firstEvents++; });
  second.fields.argsText.addEventListener('valuechange', () => { secondEvents++; });
  const hint = second.fields.cwd.renderedHint;
  // Act
  first.fields.argsText.value = 'first'; first.fields.cwd.setAttribute('placeholder', 'changed');
  first.fields.cwd.requestUpdate(); first.fields.timerControls.hidden = false;
  first.fields.status.textContent = 'first status'; second.fields.argsText.value = 'second';
  // Assert
  assert.equal(first.fields.argsText.value, 'first'); assert.equal(second.fields.argsText.value, 'second');
  assert.equal(first.fields.cwd.renderedHint, 'changed'); assert.equal(second.fields.cwd.renderedHint, hint);
  assert.equal(second.fields.cwd.getAttribute('placeholder'), hint);
  assert.equal(second.fields.timerControls.hidden, true); assert.equal(second.fields.status.textContent, '');
  assert.deepEqual([firstEvents, secondEvents], [1, 1]);
});

test('SDPI edits strip CRLF and dispatch synchronously without detail, then respect listener removal', () => {
  // Arrange
  const field = createInspectorFixture().fields.argsText, observed = [];
  const listener = event => observed.push([field.value, event.type, event.bubbles, event.detail]);
  field.addEventListener('valuechange', listener);
  // Act
  field.value = 'a\r\nb\rc\nd';
  const synchronous = observed.length;
  field.removeEventListener('valuechange', listener); field.userEdit('after\nremoval');
  // Assert
  assert.equal(synchronous, 1);
  assert.deepEqual(observed, [['abcd', 'valuechange', false, undefined]]);
  assert.equal(field.value, 'afterremoval');
});

test('native color boundary emits input/change rather than SDPI events and removes listeners', () => {
  // Arrange
  const field = createInspectorFixture().fields.themeColor, events = [];
  const input = () => events.push('input'), change = () => events.push('change');
  field.addEventListener('input', input); field.addEventListener('change', change);
  field.addEventListener('valuechange', () => events.push('unexpected SDPI event'));
  // Act
  field.userEdit('#abcdef'); field.removeEventListener('input', input); field.removeEventListener('change', change);
  field.userEdit('#123456');
  // Assert
  assert.deepEqual(events, ['input', 'change']); assert.equal(field.value, '#123456');
});

test('placeholder attributes repaint only on requestUpdate and unsupported SDPI property text fails', () => {
  // Arrange
  const field = createInspectorFixture().fields.cwd, original = field.renderedHint;
  // Act
  field.setAttribute('placeholder', 'synthetic hint'); const pending = field.renderedHint;
  field.requestUpdate();
  let failure; try { field.placeholder = 'unsupported'; } catch (error) { failure = error; }
  // Assert
  assert.equal(pending, original); assert.equal(field.renderedHint, 'synthetic hint');
  assert.equal(field.getAttribute('placeholder'), 'synthetic hint'); assert.ok(failure instanceof TypeError);
});

test('status accepts literal plaintext and rejects HTML insertion without changing its text', () => {
  // Arrange
  const status = createInspectorFixture().fields.status;
  // Act
  status.textContent = '<synthetic>literal</synthetic>';
  let failure; try { status.innerHTML = '<synthetic>HTML</synthetic>'; } catch (error) { failure = error; }
  // Assert
  assert.equal(status.textContent, '<synthetic>literal</synthetic>');
  assert.equal(failure?.message, 'Status must remain plaintext');
});

const adapterCodes = await loadAdapterCode(['run', 'once', 'timer']);
const syntheticProcess = platform => ({ platform, env: platform === 'win32'
  ? { LOCALAPPDATA: 'C:/synthetic/local' } : {}, cwd: () => '/synthetic/cwd' });

// Objective: follow extensionless TS and transitive MJS imports, including real
// parsing and validation, under the same synthetic platform as the adapter.
for (const platform of ['darwin', 'win32']) {
  test(`injected path namespace follows synthetic ${platform} rather than the host`, () => {
    // Arrange
    const load = createAdapterLoader(adapterCodes, { process: syntheticProcess(platform) });
    const base = platform === 'win32' ? 'C:/synthetic/home' : '/synthetic/home';
    // Act
    const paths = load('node:path').default;
    const joined = paths.join(base, 'Library', 'Application Support');
    const absolute = paths.isAbsolute(base), relative = paths.isAbsolute('synthetic/home');
    // Assert
    assert.equal(joined, platform === 'win32'
      ? String.raw`C:\synthetic\home\Library\Application Support`
      : '/synthetic/home/Library/Application Support');
    assert.equal(absolute, true); assert.equal(relative, false);
  });

  test(`adapter graph uses real script draft parsing with ${platform} paths and argument grammar`, () => {
    // Arrange
    const load = createAdapterLoader(adapterCodes, { process: syntheticProcess(platform) });
    const interpreter = platform === 'win32' ? 'C:/synthetic/python.exe' : '/synthetic/python';
    const input = { source: 'print("synthetic")', extension: 'py', interpreter,
      args: platform === 'win32' ? String.raw`{{script}} C:\temp\new` : String.raw`{{script}} two\ words` };
    // Act
    const parser = load('../script-import'), draft = parser.parseScriptDraft(input);
    const argv = load('../core/arguments.mjs').parseArguments(draft.args);
    const cached = load('../script-import');
    // Assert
    assert.equal(cached, parser);
    assert.deepEqual(draft, { ...input, cwd: '' });
    assert.deepEqual(argv, ['{{script}}', platform === 'win32' ? String.raw`C:\temp\new` : 'two words']);
    assert.equal(load('../core/execution-paths.mjs').executionPlatform(), platform === 'win32' ? 'win32' : 'posix');
  });

  test(`adapter graph rejects malformed script drafts using real ${platform} validation`, () => {
    // Arrange
    const load = createAdapterLoader(adapterCodes, { process: syntheticProcess(platform) });
    const { parseScriptDraft } = load('../script-import');
    const invalid = [{ source: '', extension: 'py' }, { source: 'synthetic', extension: '../py' },
      { source: 'synthetic', extension: 'py', interpreter: 'relative/python' },
      { source: 'synthetic', extension: 'py', args: '{{script}}' }];
    // Act
    const failures = invalid.map(input => { try { parseScriptDraft(input); } catch (error) { return error; } });
    // Assert
    assert.ok(failures.every(error => error?.diagnosticCode === 'INVALID_SETTINGS'
      && error.message === 'Script import needs correction.'));
  });

  test(`real ${platform} script writer is stopped at the filesystem boundary`, async () => {
    // Arrange
    const load = createAdapterLoader(adapterCodes, { process: syntheticProcess(platform) });
    const { parseScriptDraft, writeImportedScript } = load('../script-import');
    const draft = parseScriptDraft({ source: 'print("synthetic")', extension: 'py',
      interpreter: platform === 'win32' ? 'C:/synthetic/python.exe' : '/synthetic/python' });
    // Act
    const writing = writeImportedScript(draft);
    // Assert: no real homedir, filesystem lookup, directory or file creation.
    await assert.rejects(writing, { message: 'Unexpected filesystem access in adapter harness' });
  });
}

test('adapter loader permits explicit pure dependencies but rejects unknown externals and escaping paths', () => {
  // Arrange
  const load = createAdapterLoader(adapterCodes, { process: syntheticProcess('darwin') });
  // Act
  const buffer = load('node:buffer').Buffer.from('synthetic').toString();
  const failures = ['node:child_process', 'node:fs', 'unexpected-package', '../../outside.mjs'].map(name => {
    try { load(name); } catch (error) { return error; }
  });
  // Assert
  assert.equal(buffer, 'synthetic');
  assert.ok(failures.slice(0, 3).every(error => error?.message.startsWith('Unexpected adapter boundary:')));
  assert.equal(failures[3]?.message, 'Adapter module must be a source .ts or .mjs file');
});

// Objective: shared compiled text must not share module-level runtime owners or
// authority. Same context ID in independent harnesses remains independent.
test('adapter loaders isolate runtime ownership, configuration and process state', async t => {
  // Arrange
  function harness(executable) {
    const launches = [], sessions = [], states = [], managers = [];
    let settings = { executable, argsText: '' };
    const runtime = { id: 'same-synthetic-context', manifestId: 'git.renaudcerrato.deckforge.stream',
      isKey: () => true, coordinates: { row: 0, column: 0 },
      device: { id: 'synthetic-device', isConnected: true },
      async getSettings() { return structuredClone(settings); },
      async setSettings(next) { settings = structuredClone(next); }, async setImage() {}, async setTitle() {},
    };
    const sdk = { logger: { info() {}, warn() {} }, ui: { async sendToPropertyInspector() {} } };
    const load = createAdapterLoader(adapterCodes, { process: syntheticProcess('darwin'), resolve(name) {
      if (name === '@elgato/streamdeck') return { default: sdk, SingletonAction: class {}, action: () => value => value };
      if (name === '../core/process-runner.mjs') return { startProcessRun(input) {
        let finish;
        const done = new Promise(resolve => { finish = resolve; });
        const launch = { input, stopped: false }; launches.push(launch);
        return { done, async stop() { launch.stopped = true; finish({ status: 'stopped' }); return true; } };
      } };
    }, observe(name, actual) {
      const capture = (factory, collection) => ({ ...actual, [factory](dependencies) {
        const instance = actual[factory](dependencies); collection.push(instance); return instance;
      } });
      if (name === '../core/action-session.mjs') return capture('createActionSession', sessions);
      if (name === '../core/run-state.mjs') return capture('createRunStateCoordinator', states);
      if (name === '../core/availability.mjs') return capture('createAvailabilityManager', managers);
      return actual;
    } });
    const registry = Object.fromEntries(['onDeviceDidConnect', 'onDeviceDidDisconnect', 'onSystemDidWakeUp']
      .map(name => [name, () => ({ dispose() {} })]));
    const { RunAction } = load('./run'), action = new RunAction(registry);
    t.after(async () => {
      await action.onWillDisappear({ action: runtime });
      for (const session of sessions) await session.setConnected(false);
      for (const manager of managers) manager.dispose();
    });
    return { load, action, runtime, launches, states,
      appear: () => action.onWillAppear({ action: runtime, payload: { settings } }),
      press: () => action.onKeyDown({ action: runtime, payload: { settings } }),
    };
  }
  const first = harness('/synthetic/first'), second = harness('/synthetic/second');
  // Act
  await first.appear(); await second.appear(); await first.press(); await second.press();
  await first.press();
  await first.states[0].editConfiguration({ title: 'first title' });
  // Assert
  assert.notEqual(first.load('./program-runtime'), second.load('./program-runtime'));
  assert.deepEqual(first.launches.map(launch => launch.input.executable), ['/synthetic/first']);
  assert.deepEqual(second.launches.map(launch => launch.input.executable), ['/synthetic/second']);
  assert.equal(first.launches[0].stopped, true); assert.equal(second.launches[0].stopped, false);
  assert.equal(first.states[0].getSettings().title, 'first title');
  assert.equal(second.states[0].getSettings().title, undefined);
});
