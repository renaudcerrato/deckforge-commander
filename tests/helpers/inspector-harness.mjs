import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const authoredMarkup = readFileSync(new URL('../../src/inspector/run.html', import.meta.url), 'utf8');

// Independent DOM-boundary input. Never derive defect cases by rewriting product markup.
export const inspectorTestMarkup = `<html><head>
  <script src="sdpi-components.js"></script><script src="run.js"></script>
  </head><body>
  <section id="settings-status" role="status" aria-live="polite"></section>
  <input id="themeColor" type="color" value="#abcdef" aria-label="Key artwork" />
  <sdpi-item label="Program"><sdpi-file id="executable"></sdpi-file></sdpi-item>
  <sdpi-item label="Working folder"><sdpi-textfield id="cwd"></sdpi-textfield></sdpi-item>
  <sdpi-item label="Parameters"><sdpi-textfield id="argsText"></sdpi-textfield></sdpi-item>
  <sdpi-item label="Key title"><sdpi-textfield id="title"></sdpi-textfield></sdpi-item>
  <section id="timer-controls" hidden>
    <sdpi-item label="Delay"><sdpi-select id="intervalPreset">
      <option value="custom">Other duration</option><option value="3600">Hour</option>
      <option value="1800">Half hour</option><option value="600">Ten minutes</option>
      <option value="60">Minute</option><option value="30">Half minute</option>
      <option value="10">Ten seconds</option><option value="1">Second</option>
    </sdpi-select></sdpi-item>
    <sdpi-item label="Press behavior"><div><sdpi-select id="actionOnPress">
      <option value="stop">Toggle</option><option value="refresh">Refresh</option>
    </sdpi-select></div></sdpi-item>
    <section id="custom-interval" hidden><sdpi-item label="Seconds">
      <sdpi-textfield id="intervalSeconds"></sdpi-textfield>
    </sdpi-item></section>
  </section>
  <p>Independent helper copy.</p><p>Additional explanation.</p>
  <a id="github-project" href="#">Project</a><a id="ask-chatgpt" href="#">Script help</a>
  </body></html>`;

function element(tag, attributes) {
  const listeners = new Map();
  const color = tag === 'input' && attributes.get('type') === 'color';
  let value = attributes.get('value') ?? '', renderedHint = attributes.get('placeholder') ?? null;
  return {
    hidden: attributes.has('hidden'), textContent: '',
    set innerHTML(_) { throw new Error('Status must remain plaintext'); },
    get value() { return value; },
    // Stress synchronous hydration, as existing SDPI/native boundary doubles do.
    set value(next) {
      value = typeof next === 'string' ? next.replace(/[\r\n]/g, '') : next;
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
  assert.deepEqual(optionsOf(interval).sort(), ['1', '10', '30', '60', '600', '1800', '3600', 'custom'].sort());
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
