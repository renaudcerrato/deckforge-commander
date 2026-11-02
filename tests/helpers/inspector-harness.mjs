import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const authoredMarkup = readFileSync(new URL('../../src/inspector/run.html', import.meta.url), 'utf8');

// Independent DOM-boundary input. Never derive defect cases by rewriting product markup.
export const inspectorTestMarkup = `<html><head>
  <script src="sdpi-components.js"></script><script src="run.js"></script>
  </head><body>
   <section aria-labelledby="program-heading"><div>
     <h2 id="program-heading">Program</h2>
     <sdpi-item label="Executable"><sdpi-file id="executable"></sdpi-file></sdpi-item>
     <sdpi-item><a id="ask-chatgpt" href="#">Ask ChatGPT to create your script</a></sdpi-item>
     <sdpi-item label="Arguments"><div><sdpi-textfield id="argsText"></sdpi-textfield>
       <small>Quote arguments containing spaces, for example --mode "daily report".</small>
     </div></sdpi-item>
     <sdpi-item label="Working directory (optional)"><sdpi-textfield id="cwd"></sdpi-textfield></sdpi-item>
   </div></section>
   <section id="remember-controls" aria-labelledby="behavior-heading" hidden>
     <h2 id="behavior-heading">Behavior</h2>
     <section id="timer-controls" hidden>
       <sdpi-item label="Run every"><sdpi-select id="intervalPreset">
         <option value="custom">Custom</option><option value="3600">1h</option>
         <option value="1800">30mn</option><option value="600">10mn</option>
         <option value="60">1mn</option><option value="30">30s</option>
         <option value="10">10s</option><option value="1">1s</option>
       </sdpi-select></sdpi-item>
       <section id="custom-interval" hidden><sdpi-item label="Interval (seconds)">
         <sdpi-textfield id="intervalSeconds"></sdpi-textfield>
         <small>Enter whole seconds from 1 to 86400.</small>
       </sdpi-item></section>
       <sdpi-item label="On Press"><div><sdpi-select id="actionOnPress">
         <option value="stop">start / stop</option><option value="refresh">start / refresh (long press to stop)</option>
       </sdpi-select></div></sdpi-item>
     </section>
     <sdpi-item><sdpi-checkbox id="rememberRunningState" label="Resume after sleep, reconnect, or restart"></sdpi-checkbox></sdpi-item>
   </section>
   <section aria-labelledby="appearance-heading">
     <h2 id="appearance-heading">Appearance</h2>
     <sdpi-item label="Title (optional)"><sdpi-textfield id="title"></sdpi-textfield></sdpi-item>
     <sdpi-item label="Theme color"><input id="themeColor" type="color" value="#abcdef" aria-label="Artwork theme color" /></sdpi-item>
   </section>
   <section id="settings-status" role="status" aria-live="polite"></section>
   <footer><a id="github-project" href="#">GitHub ↗</a></footer>
  </body></html>`;

function element(tag, attributes) {
  const listeners = new Map();
  const color = tag === 'input' && attributes.get('type') === 'color';
  const checkbox = tag === 'sdpi-checkbox';
  let value = checkbox ? false : attributes.get('value') ?? '', renderedHint = attributes.get('placeholder') ?? null;
  return {
    hidden: attributes.has('hidden'), textContent: '',
    set innerHTML(_) { throw new Error('Status must remain plaintext'); },
    get value() { return value; },
    // Stress synchronous hydration, as existing SDPI/native boundary doubles do.
    set value(next) {
      if (checkbox && Object.is(value, next)) return;
      value = !checkbox && typeof next === 'string' ? next.replace(/[\r\n]/g, '') : next;
      if (!color && tag.startsWith('sdpi-')) this.dispatch('valuechange');
    },
    userEdit(next) { this.value = next; },
    addEventListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(listener);
    },
    removeEventListener(name, listener) { listeners.get(name)?.delete(listener); },
    dispatch(name) {
      const event = { type: name, bubbles: false, preventDefault() {} };
      for (const listener of listeners.get(name) ?? []) listener(event);
    },
    getAttribute(name) { return attributes.get(name) ?? null; },
    setAttribute(name, next) { attributes.set(name, String(next)); },
    requestUpdate() { renderedHint = attributes.get('placeholder') ?? null; },
    set placeholder(next) {
      if (tag === 'sdpi-textfield' && typeof next === 'string') {
        throw new TypeError('SDPI placeholder property does not accept text.');
      }
    },
    get renderedHint() { return renderedHint; },
  };
}

function attributesOf(source) {
  const attributes = new Map();
  for (const [, name, double, single, bare] of source.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const key = name.toLowerCase();
    if (attributes.has(key)) throw new Error('Duplicate static inspector attribute');
    attributes.set(key, double ?? single ?? bare ?? '');
  }
  return attributes;
}

// Narrow static markup metadata, not HTML error recovery or a browser/CSS emulator.
// Opaque scripts/styles and comments cannot supply controls; text whitespace collapses.
export function extractInspectorMarkup(html = authoredMarkup) {
  const nodes = [], scripts = [], styles = [], stack = [];
  // Mask opaque regions without shifting source ranges used by controlled fixtures.
  const markup = html.replace(/<!--[\s\S]*?-->/g, match => ' '.repeat(match.length)).replace(
    /<(script|style)\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/\1\s*>/gi,
    (match, tag, source, text, start) => {
      (tag.toLowerCase() === 'script' ? scripts : styles).push({ tag: tag.toLowerCase(), attributes: attributesOf(source), text,
        start, openEnd: start + tag.length + source.length + 2,
        closeStart: start + match.lastIndexOf('</'), end: start + match.length });
      return ' '.repeat(match.length);
    });
  for (const token of markup.matchAll(/<\/[a-z][\w-]*\s*>|<[a-z][\w-]*\b(?:[^"'<>]|"[^"]*"|'[^']*')*>|[^<]+/gi)) {
    const source = token[0];
    if (source.startsWith('</')) {
      const tag = source.slice(2, -1).trim().toLowerCase();
      if (stack.at(-1)?.tag !== tag) throw new Error('Unbalanced static inspector markup');
      stack.at(-1).closeStart = token.index; stack.at(-1).end = token.index + source.length;
      stack.pop();
    } else if (source.startsWith('<')) {
      const [, tag, attributes] = /^<([\w-]+)\b([\s\S]*?)>$/.exec(source);
      const openEnd = token.index + source.length;
      const node = { tag: tag.toLowerCase(), attributes: attributesOf(attributes), parent: stack.at(-1), children: [], text: '',
        start: token.index, openEnd, closeStart: openEnd, end: openEnd };
      node.parent?.children.push(node); nodes.push(node);
      if (!['input', 'meta', 'link', 'br', 'hr', 'img'].includes(node.tag) && !/\/\s*>$/.test(source)) stack.push(node);
    } else if (stack.length) stack.at(-1).text += source;
  }
  if (stack.length) throw new Error('Unbalanced static inspector markup');
  for (const node of nodes) node.text = node.text.replace(/\s+/g, ' ').trim();
  return { nodes, scripts, styles };
}

// One shared static UI contract: the suites and format/invalid-markup regressions
// run these same assertions. This does not establish browser or CSS rendering.
export function assertInspectorMarkup(html = authoredMarkup) {
  const { nodes, scripts, styles } = extractInspectorMarkup(html);
  const byId = id => {
    const matches = nodes.filter(node => node.attributes.get('id') === id);
    assert.equal(matches.length, 1, `expected one ${id} control`);
    return matches[0];
  };
  assert.deepEqual(scripts.map(script => script.attributes.get('src')).sort(), ['run.js', 'sdpi-components.js']);
  assert.ok(scripts.every(script => script.text.trim() === ''), 'no inline script');
  assert.equal([...nodes, ...scripts, ...styles].some(node => node.attributes.has('setting')), false);
  assert.equal(nodes.some(node => ['button', 'sdpi-button', 'sdpi-color'].includes(node.tag)
    || ['env', 'environment', 'mode', 'enabled', 'runRequested']
       .includes(node.attributes.get('id'))), false);
  const ids = nodes.map(node => node.attributes.get('id')).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length, 'bindings must be unique');
  const named = node => {
    if (node.attributes.get('aria-label')?.trim()) return true;
    if (node.tag === 'input' && node.attributes.get('type') === 'color') {
      // An SDPI item's shadow label does not name a slotted native input.
      const hasText = label => Boolean(label.text || label.children.some(hasText));
      const id = node.attributes.get('id');
      if (id && nodes.some(label => label.tag === 'label' && label.attributes.get('for') === id && hasText(label))) return true;
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (parent.tag === 'label' && hasText(parent)) return true;
      }
      return false;
    }
    if (node.tag === 'sdpi-checkbox' && node.attributes.get('label')?.trim()) return true;
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (parent.tag === 'sdpi-item' && parent.attributes.get('label')?.trim()) return true;
    }
    return false;
  };
  const usable = node => {
    assert.equal(node.attributes.has('disabled'), false);
    assert.equal(node.attributes.has('readonly'), false);
    assert.ok(named(node), 'controls need an accessible name');
  };
  for (const [id, tag] of [['executable', 'sdpi-file'], ['cwd', 'sdpi-textfield'], ['argsText', 'sdpi-textfield'],
    ['title', 'sdpi-textfield'], ['intervalSeconds', 'sdpi-textfield']]) {
    const node = byId(id); assert.equal(node.tag, tag); usable(node);
  }
  const theme = byId('themeColor'), status = byId('settings-status');
  assert.equal(theme.tag, 'input'); assert.equal(theme.attributes.get('type'), 'color');
  usable(theme);
  assert.equal(status.attributes.get('role'), 'status');
  assert.equal(status.attributes.get('aria-live'), 'polite'); assert.deepEqual(status.children, []);
  for (const id of ['github-project', 'ask-chatgpt']) {
    const link = byId(id); assert.equal(link.tag, 'a'); assert.ok(link.text || named(link));
  }
  const timer = byId('timer-controls'), custom = byId('custom-interval');
  const press = byId('actionOnPress'), interval = byId('intervalPreset');
  assert.equal(timer.attributes.has('hidden'), true);
  assert.equal(custom.attributes.has('hidden'), true);
  const within = (node, container) => {
    for (let parent = node.parent; parent; parent = parent.parent) if (parent === container) return true;
    return false;
  };
  // These are visibility boundaries, not immediate-parent or layout requirements.
  for (const node of [press, interval, custom]) {
    assert.ok(within(node, timer), `${node.attributes.get('id')} must be within timer-controls`);
  }
  assert.ok(within(byId('intervalSeconds'), custom), 'intervalSeconds must be within custom-interval');
  for (const node of [press, interval]) { assert.equal(node.tag, 'sdpi-select'); usable(node); }
  const optionsOf = node => node.children.map(option => {
    assert.equal(option.tag, 'option'); assert.ok(option.text, 'choices need meaningful labels');
    assert.equal(option.attributes.has('disabled'), false);
    return option.attributes.get('value');
  });
  assert.deepEqual(optionsOf(press).sort(), ['refresh', 'stop']);
  const remember = byId('rememberRunningState'), rememberControls = byId('remember-controls');
  assert.equal(remember.tag, 'sdpi-checkbox'); usable(remember);
  assert.equal(remember.attributes.get('label'), 'Resume after sleep, reconnect, or restart');
  assert.equal(rememberControls.attributes.has('hidden'), true);
  assert.ok(within(remember, rememberControls), 'rememberRunningState must be within remember-controls');
  assert.deepEqual(optionsOf(interval).sort(), ['1', '10', '30', '60', '600', '1800', '3600', 'custom'].sort());
  const labelledSection = name => {
    const headings = nodes.filter(node => /^h[1-6]$/.test(node.tag) && node.text === name);
    assert.equal(headings.length, 1, `expected one ${name} heading`);
    const heading = headings[0], id = heading.attributes.get('id');
    assert.ok(id, `${name} heading needs an accessible reference`);
    const sections = nodes.filter(node => (node.attributes.get('aria-labelledby') ?? '').split(/\s+/).includes(id));
    assert.equal(sections.length, 1, `expected one labelled ${name} section`);
    assert.ok(within(heading, sections[0]), `${name} heading must be within its section`);
    return { section: sections[0], heading };
  };
  const program = labelledSection('Program'), behavior = labelledSection('Behavior'), appearance = labelledSection('Appearance');
  assert.equal(behavior.section, rememberControls, 'the entire Behavior section must use the managed visibility boundary');
  assert.ok(within(timer, behavior.section), 'timer-controls must be within Behavior');
  const orderedFields = (group, fields) => {
    const controls = fields.map(byId);
    for (const node of controls) assert.ok(within(node, group.section), `${node.attributes.get('id')} must be within its section`);
    assert.ok(group.heading.end <= controls[0].start, 'section heading must precede its fields');
    for (let index = 1; index < controls.length; index++) assert.ok(controls[index - 1].end <= controls[index].start, 'section field order');
  };
  orderedFields(program, ['executable', 'ask-chatgpt', 'argsText', 'cwd']);
  orderedFields(behavior, ['intervalPreset', 'intervalSeconds', 'actionOnPress', 'rememberRunningState']);
  orderedFields(appearance, ['title', 'themeColor']);
  assert.ok(program.section.end <= behavior.section.start && behavior.section.end <= appearance.section.start, 'Program, Behavior, Appearance section order');
  const footers = nodes.filter(node => node.tag === 'footer' && within(byId('github-project'), node));
  assert.equal(footers.length, 1, 'project link belongs to one footer');
  assert.ok(appearance.section.end <= status.start && status.end <= footers[0].start, 'status and footer must follow Appearance');
  const itemFor = node => {
    for (let parent = node.parent; parent; parent = parent.parent) if (parent.tag === 'sdpi-item') return parent;
  };
  for (const [id, label] of [['executable', 'Executable'], ['argsText', 'Arguments'], ['cwd', 'Working directory (optional)'],
    ['intervalPreset', 'Run every'], ['intervalSeconds', 'Interval (seconds)'], ['actionOnPress', 'On Press'],
    ['title', 'Title (optional)'], ['themeColor', 'Theme color']]) assert.equal(itemFor(byId(id))?.attributes.get('label'), label);
  for (const [id, text] of [['argsText', 'Quote arguments containing spaces, for example --mode "daily report".'],
    ['intervalSeconds', 'Enter whole seconds from 1 to 86400.']]) {
    assert.ok(nodes.some(node => node.tag === 'small' && within(node, itemFor(byId(id))) && node.text === text), `${id} helper copy`);
  }
  const chat = byId('ask-chatgpt');
  assert.equal(chat.text, 'Ask ChatGPT to create your script'); assert.equal(chat.attributes.get('href'), '#');
  for (const [control, entries] of [[interval, [['1', '1s'], ['10', '10s'], ['30', '30s'], ['60', '1mn'], ['600', '10mn'], ['1800', '30mn'], ['3600', '1h'], ['custom', 'Custom']]],
    [press, [['refresh', 'start / refresh (long press to stop)'], ['stop', 'start / stop']]]]) {
    for (const [value, label] of entries) assert.equal(control.children.find(node => node.attributes.get('value') === value)?.text, label);
  }
  const css = styles.map(style => style.text).join('\n');
  // Inspect only flat rules and declarations used by this static contract, not general CSS.
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectors, body]) => ({
    selectors: selectors.split(',').map(selector => selector.trim()),
    declarations: new Map(body.split(';').filter(value => value.includes(':')).map(value => {
      const colon = value.indexOf(':');
      return [value.slice(0, colon).trim().toLowerCase(), value.slice(colon + 1).trim().toLowerCase()];
    })),
  }));
  assert.equal(rules.some(rule => rule.selectors.some(selector => /\bsdpi[\w-]*/i.test(selector))
    && [...rule.declarations.keys()].some(name => /^background(?:-|$)/.test(name))), false);
}

export function createInspectorFixture(html = inspectorTestMarkup) {
  const elements = new Map(), fields = {}, boundaries = new Map();
  for (const node of extractInspectorMarkup(html).nodes) {
    const { tag, attributes } = node;
    const field = element(tag, attributes);
    if (/^h[1-6]$/.test(tag)) field.textContent = node.text;
    // Anonymous wrappers participate too: hiding one must hide its descendants.
    field.parentElement = boundaries.get(node.parent) ?? null;
    boundaries.set(node, field);
    const id = attributes.get('id');
    if (!id) continue;
    assert.equal(elements.has(id), false, 'bindings must be unique');
    elements.set(id, field);
    fields[id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = field;
    if (attributes.get('role') === 'status') fields.status = field;
  }
  return { fields, elements, getElementById: id => elements.get(id) ?? null };
}

// Observe only DOM hidden state, including ancestors; never infer computed CSS.
export function isHiddenByAncestry(control) {
  for (let node = control; node; node = node.parentElement) if (node.hidden) return true;
  return false;
}
