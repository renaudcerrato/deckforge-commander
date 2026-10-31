import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createInspectorFixture, extractInspectorMarkup, assertInspectorMarkup } from './helpers/inspector-harness.mjs';
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

// S24: one static contract covers authored/generated markup and equivalent formatting.
const staticControls = readFileSync(new URL('../src/inspector/run.html', import.meta.url), 'utf8');
const generatedControls = readFileSync(new URL('../git.renaudcerrato.deckforge.sdPlugin/ui/run.html', import.meta.url), 'utf8');

function reformatMarkup(html) {
  return html.replace(/<([a-z][\w-]*)\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>/gi, (_, tag, source) => {
    // Reformat only opening tags; preserve text, CSS, script bodies and closing tags.
    const attributes = source.match(/[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g) ?? [];
    return `<${tag}\n ${attributes.reverse().map(attribute => attribute
      .replace(/^([^\s=/>]+)\s*=\s*"([^"]*)"$/, (_, name, value) => value.includes("'")
        ? `${name} = "${value}"` : `${name} = '${value}'`)).join('\n ')}${/\/\s*$/.test(source) ? ' /' : ''} >`;
  });
}
const markupVariants = [['authored', staticControls], ['authored reformatted', reformatMarkup(staticControls)],
  ['generated', generatedControls], ['generated reformatted', reformatMarkup(generatedControls)]];

for (const [variant, html] of markupVariants) {
  test(`central inspector static contract holds for ${variant} markup`, () => {
    // Arrange
    const input = html;
    // Act
    const verify = () => assertInspectorMarkup(input);
    // Assert: bindings, accessibility, presets, writers and CSS share one contract.
    assert.doesNotThrow(verify);
  });
}

test('static control semantics tolerate reordered attributes, quotes and whitespace', () => {
  // Arrange: equivalent static controls, not a browser rendering claim.
  const formatted = markupVariants[1][1];
  // Act
  const fixtures = [staticControls, formatted].map(createInspectorFixture);
  // Assert
  assert.notEqual(formatted, staticControls);
  assert.equal(fixtures[1].fields.timerControls.hidden, fixtures[0].fields.timerControls.hidden);
  assert.equal(fixtures[1].fields.status.getAttribute('aria-live'), 'polite');
});

for (const [label, html, placeholder] of [
  ['apostrophes', `<sdpi-textfield id="draft" placeholder="owner's folder" title='say "hello"'></sdpi-textfield>`, "owner's folder"],
  ['embedded equals and quotes', `<sdpi-textfield id="draft" placeholder='--mode="daily report"' title='say "hello"'></sdpi-textfield>`, '--mode="daily report"'],
]) {
  test(`markup reformatting preserves ${label} and quoted attribute values`, () => {
    // Arrange
    const original = createInspectorFixture(html).fields.draft;
    // Act
    const formatted = reformatMarkup(html), field = createInspectorFixture(formatted).fields.draft;
    // Assert: quote changes cannot split a valid attribute or invent extra attributes.
    assert.notEqual(formatted, html);
    assert.equal(field.getAttribute('placeholder'), placeholder);
    assert.equal(field.getAttribute('title'), original.getAttribute('title'));
    assert.equal(extractInspectorMarkup(formatted).nodes[0].attributes.size, 3);
  });
}

for (const css of [
  '#custom-interval[hidden],#timer-controls[hidden]{display:none!important}',
  '#timer-controls[ hidden ] { display : none ! important ; } #custom-interval[hidden]{display:none !important;}',
]) {
  test('static CSS contract accepts equivalent whitespace and selector order', () => {
    // Arrange
    const html = staticControls.replace(/#timer-controls\[hidden\][^}]*}/, css)
      .replace('#settings-status { color: #969696; }', '#settings-status{color : #969696}');
    // Act
    const verify = () => assertInspectorMarkup(html);
    // Assert
    assert.doesNotThrow(verify);
  });
}
for (const [defect, css] of [
  ['missing hidden rule', ''],
  ['missing custom selector', '#timer-controls[hidden]{display:none!important}'],
  ['visible hidden rows', '#timer-controls[hidden],#custom-interval[hidden]{display:block!important}'],
  ['nonimportant hidden rule', '#timer-controls[hidden],#custom-interval[hidden]{display:none}'],
  ['descendant instead of hidden control', '#timer-controls [hidden],#custom-interval[hidden]{display:none!important}'],
]) {
  test(`static CSS contract rejects ${defect}`, () => {
    // Arrange
    const html = staticControls.replace(/#timer-controls\[hidden\][^}]*}/, css);
    // Act
    const verify = () => assertInspectorMarkup(html);
    // Assert
    assert.throws(verify, assert.AssertionError);
  });
}
for (const css of ['#settings-status{color:red}', '#settings-status{opacity:1}']) {
  test('static CSS contract still rejects incorrect or missing status color', () => {
    // Arrange
    const html = staticControls.replace('#settings-status { color: #969696; }', css);
    // Act
    const verify = () => assertInspectorMarkup(html);
    // Assert
    assert.throws(verify, assert.AssertionError);
  });
}
test('static CSS contract rejects SDPI backgrounds while status color remains valid', () => {
  // Arrange: change only the forbidden background, not the independent status rule.
  const html = staticControls.replace('#settings-status { color: #969696; }',
    '$&\n SDPI-item { BACKGROUND-COLOR: black; }');
  // Act
  const verify = () => assertInspectorMarkup(html);
  // Assert: without the background guard, this otherwise-valid fixture would pass.
  assert.notEqual(html, staticControls);
  assert.throws(verify, assert.AssertionError);
});

// Use the existing extractor's ranges, not a second parser or authored spelling.
function mutateMarkup(html, select, edit) {
  const { nodes, scripts } = extractInspectorMarkup(html);
  const matches = [...nodes, ...scripts].filter(select);
  assert.equal(matches.length, 1, 'mutation must identify exactly one target');
  const node = matches[0];
  const draft = { tag: node.tag, attributes: new Map(node.attributes),
    content: html.slice(node.openEnd, node.closeStart), remove: false, wrap: false };
  edit(draft);
  const attributes = [...draft.attributes].map(([name, value]) => `${name}="${value.replaceAll('"', '&quot;')}"`).join(' ');
  const opening = `<${draft.tag} ${attributes}>`;
  let replacement = draft.remove ? '' : opening + (node.end === node.openEnd ? '' : `${draft.content}</${draft.tag}>`);
  if (draft.wrap) replacement = `<div>${replacement}</div>`;
  return html.slice(0, node.start) + replacement + html.slice(node.end);
}
const idIs = id => node => node.attributes.get('id') === id;
const presetIs = value => node => node.tag === 'option' && node.attributes.get('value') === value
  && node.parent.attributes.get('id') === 'intervalPreset';
const entryScript = node => node.tag === 'script' && node.attributes.get('src') === 'run.js';
const body = node => node.tag === 'body';

for (const [defect, select, edit] of [
  ['missing hidden attribute', idIs('timer-controls'), node => node.attributes.delete('hidden')],
  ['wrong live region', idIs('settings-status'), node => node.attributes.set('aria-live', 'off')],
  ['missing status role', idIs('settings-status'), node => node.attributes.delete('role')],
  ['wrong preset value', presetIs('60'), node => node.attributes.set('value', '61')],
  ['wrong preset label', presetIs('60'), node => { node.content = 'Other'; }],
  ['nested preset content', presetIs('60'), node => { node.content = '1mn<b>Other</b>'; }],
  ['missing preset', presetIs('custom'), node => { node.remove = true; }],
  ['wrong control ancestry', idIs('actionOnPress'), node => { node.wrap = true; }],
  ['remote script', entryScript, node => node.attributes.set('src', 'https://example.invalid/run.js')],
  ['inline script', entryScript, node => { node.content = 'unexpected()'; }],
  ['additional settings writer', idIs('intervalPreset'), node => node.attributes.set('setting', 'intervalSeconds')],
  ['wrong picker element', idIs('executable'), node => { node.tag = 'sdpi-textfield'; }],
  ['wrong native color type', idIs('themeColor'), node => node.attributes.set('type', 'text')],
  ['wrong initial color', idIs('themeColor'), node => node.attributes.set('value', '#969696')],
  ['wrong native color label', node => node.tag === 'sdpi-item' && node.attributes.get('label') === 'Theme color', node => node.attributes.set('label', 'Other')],
  ['wrong color accessibility label', idIs('themeColor'), node => node.attributes.set('aria-label', 'Other')],
  ['environment field', body, node => { node.content += '<input id="environment" />'; }],
  ['persisted mode control', body, node => { node.content += '<sdpi-select id="mode"></sdpi-select>'; }],
  ['Apply writer', body, node => { node.content += '<button>Apply</button>'; }],
  ['nonempty status', idIs('settings-status'), node => { node.content = 'unexpected'; }],
  ['duplicate writer control', body, node => { node.content += '<sdpi-file id="executable"></sdpi-file>'; }],
]) {
  for (const [variant, input] of markupVariants) {
    test(`static control assertions still reject ${defect} in ${variant} markup`, () => {
      // Arrange
      const html = input;
      // Act
      const invalid = mutateMarkup(html, select, edit);
      // Assert: a no-op fixture must never masquerade as a rejected defect.
      assert.notEqual(invalid, html, 'mutation must change its input');
      assert.throws(() => assertInspectorMarkup(invalid), assert.AssertionError);
    });
  }
}

// Reject ambiguous attributes instead of emulating a browser's recovery rules.
for (const [label, html] of [
  ['role', '<p role="button" role="status"></p>'],
  ['mixed-case role', "<p ROLE='button' role='status'></p>"],
  ['ID', "<input id='wrong' ID='executable' />"],
  ['script source', "<script SRC='remote.js' src='run.js'></script>"],
  ['style attribute', "<style media='print' MEDIA='screen'></style>"],
]) {
  test(`static extraction rejects duplicate ${label} attributes consistently`, () => {
    // Arrange
    const input = html;
    // Act
    const extract = () => extractInspectorMarkup(input), fixture = () => createInspectorFixture(input);
    // Assert
    assert.throws(extract, { message: 'Duplicate static inspector attribute' });
    assert.throws(fixture, { message: 'Duplicate static inspector attribute' });
  });
}

// Objective: an actual missing required link still fails the existing production entry.
for (const id of [undefined, 'github-project', 'ask-chatgpt']) {
  test(`built inspector initialization ${id ? `rejects absent ${id}` : 'accepts complete markup'} without connection side effects`, () => {
    // Arrange
    const html = readFileSync(new URL('../src/inspector/run.html', import.meta.url), 'utf8');
    const script = readFileSync(new URL('../git.renaudcerrato.deckforge.sdPlugin/ui/run.js', import.meta.url), 'utf8');
    const source = createInspectorFixture(html);
    if (id) assert.ok(source.getElementById(id), 'required link must exist before removal');
    const input = id ? mutateMarkup(html, idIs(id), node => { node.remove = true; }) : html;
    const fixture = createInspectorFixture(input);
    const unrelated = [...fixture.elements].filter(([key]) => key !== id);
    if (id) {
      assert.notEqual(input, html);
      assert.equal(fixture.getElementById(id), null, 'required link must be absent before bundle evaluation');
      assert.deepEqual([...fixture.elements.keys()], [...source.elements.keys()].filter(key => key !== id));
    }
    const effects = { timers: 0, sockets: 0, settings: 0 };
    const context = { window: { addEventListener() {} },
      document: { readyState: 'complete', getElementById: fixture.getElementById },
      setTimeout() { effects.timers++; }, clearTimeout() {},
      WebSocket: class { constructor() { effects.sockets++; } send() { effects.settings++; } },
    };
    // Act
    let failure;
    try { runInNewContext(script, context, { timeout: 1000 }); } catch (error) { failure = error; }
    // Assert
    if (id) assert.equal(fixture.getElementById(id), null);
    for (const [key, field] of unrelated) assert.equal(fixture.getElementById(key), field);
    assert.equal(failure !== undefined, id !== undefined);
    assert.deepEqual(effects, { timers: 0, sockets: 0, settings: 0 });
    if (!id) assert.equal(typeof context.window.connectElgatoStreamDeckSocket, 'function');
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

test('native color assignment and event delivery are independent and listener removal is respected', () => {
  // Arrange
  const field = createInspectorFixture().fields.themeColor, events = [];
  const input = () => events.push('input'), change = () => events.push('change');
  field.addEventListener('input', input); field.addEventListener('change', change);
  field.addEventListener('valuechange', () => events.push('unexpected SDPI event'));
  // Act
  field.value = '#abcdef'; const assigned = [...events];
  field.dispatch('input'); field.dispatch('change');
  field.removeEventListener('input', input); field.removeEventListener('change', change);
  field.userEdit('#123456'); field.dispatch('input'); field.dispatch('change');
  // Assert
  assert.deepEqual(assigned, []); assert.deepEqual(events, ['input', 'change']); assert.equal(field.value, '#123456');
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
// Compile actual import syntax through the same loader; the probe exists only in memory.
const pathProbe = fileURLToPath(new URL('../src/actions/harness-path-probe.ts', import.meta.url));
const pathProbeCodes = new Map(adapterCodes);
pathProbeCodes.set(pathProbe, ts.transpileModule(`
  import paths, { join, isAbsolute, sep } from 'node:path';
  export function inspect(base: string) {
    return { named: join(base, 'Library', 'Application Support'),
      default: paths.join(base, 'Library', 'Application Support'), sep,
      absolute: isAbsolute(base), relative: isAbsolute('synthetic/home'),
      sameImplementation: join === paths.join && isAbsolute === paths.isAbsolute };
  }
`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText);

// Objective: follow extensionless TS and transitive MJS imports, including real
// parsing and validation, under the same synthetic platform as the adapter.
for (const platform of ['darwin', 'win32']) {
  test(`named and default path imports follow the same synthetic ${platform} namespace rather than the host`, () => {
    // Arrange
    const load = createAdapterLoader(pathProbeCodes, { process: syntheticProcess(platform) });
    const base = platform === 'win32' ? 'C:/synthetic/home' : '/synthetic/home';
    // Act
    const result = load('./harness-path-probe').inspect(base);
    // Assert
    const joined = platform === 'win32'
      ? String.raw`C:\synthetic\home\Library\Application Support`
      : '/synthetic/home/Library/Application Support';
    assert.deepEqual(result, { named: joined, default: joined, sep: platform === 'win32' ? '\\' : '/',
      absolute: true, relative: false, sameImplementation: true });
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
