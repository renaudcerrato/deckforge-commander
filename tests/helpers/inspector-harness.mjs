import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const authoredMarkup = readFileSync(new URL('../../src/inspector/run.html', import.meta.url), 'utf8');

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
  // Mask opaque regions without shifting source ranges used by mutation fixtures.
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
  assert.deepEqual(scripts.map(script => script.attributes.get('src')), ['sdpi-components.js', 'run.js']);
  assert.ok(scripts.every(script => script.text.trim() === ''), 'no inline script');
  assert.equal([...nodes, ...scripts, ...styles].some(node => node.attributes.has('setting')), false);
  assert.equal(nodes.some(node => ['button', 'sdpi-button', 'sdpi-color', 'details'].includes(node.tag)
    || /\bApply\b/.test(node.text) || ['env', 'environment', 'connection-status', 'mode', 'enabled', 'runRequested']
      .includes(node.attributes.get('id'))), false);
  for (const [id, tag] of [['executable', 'sdpi-file'], ['cwd', 'sdpi-textfield'], ['argsText', 'sdpi-textfield'],
    ['title', 'sdpi-textfield'], ['intervalSeconds', 'sdpi-textfield']]) assert.equal(byId(id).tag, tag);
  const theme = byId('themeColor'), status = byId('settings-status');
  assert.equal(theme.tag, 'input'); assert.equal(theme.attributes.get('type'), 'color');
  // Authored initial color is distinct from hydration's runtime fallback.
  assert.equal(theme.attributes.get('value'), '#606060');
  assert.equal(theme.attributes.get('aria-label'), 'Artwork theme color');
  assert.equal(theme.parent.tag, 'sdpi-item'); assert.equal(theme.parent.attributes.get('label'), 'Theme color');
  assert.equal(status.tag, 'p'); assert.equal(status.attributes.get('role'), 'status');
  assert.equal(status.attributes.get('aria-live'), 'polite'); assert.equal(status.text, ''); assert.deepEqual(status.children, []);
  assert.deepEqual(nodes.filter(node => node.tag === 'p'), [status]);
  assert.ok(nodes.indexOf(status) > nodes.indexOf(theme));
  const timer = byId('timer-controls'), custom = byId('custom-interval');
  const press = byId('actionOnPress'), interval = byId('intervalPreset');
  assert.equal(timer.tag, 'div'); assert.equal(timer.attributes.has('hidden'), true);
  assert.equal(custom.tag, 'sdpi-item'); assert.equal(custom.attributes.has('hidden'), true);
  assert.equal(custom.parent, timer); assert.equal(custom.attributes.get('label'), 'Interval (seconds)');
  assert.equal(byId('intervalSeconds').parent, custom);
  assert.ok(custom.children.some(node => node.tag === 'small' && node.text === 'Enter whole seconds from 1 to 86400.'));
  for (const [node, label] of [[press, 'Action on press'], [interval, 'Interval']]) {
    assert.equal(node.tag, 'sdpi-select'); assert.equal(node.parent.tag, 'sdpi-item');
    assert.equal(node.parent.attributes.get('label'), label); assert.equal(node.parent.parent, timer);
  }
  assert.equal(press.parent.children.some(node => node.tag === 'small'), false);
  assert.ok(nodes.indexOf(press) < nodes.indexOf(interval));
  const optionsOf = node => node.children.map(option => {
    assert.equal(option.tag, 'option'); assert.deepEqual(option.children, []);
    return [option.attributes.get('value'), option.text];
  });
  assert.deepEqual(optionsOf(press), [['refresh', 'start / refresh (long press to stop)'], ['stop', 'start / stop']]);
  assert.deepEqual(optionsOf(interval), [['1', '1s'], ['10', '10s'], ['30', '30s'], ['60', '1mn'], ['600', '10mn'],
    ['1800', '30mn'], ['3600', '1h'], ['custom', 'Custom']]);
  const css = styles.map(style => style.text).join('\n');
  // Inspect only flat rules and declarations used by this static contract, not general CSS.
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectors, body]) => ({
    selectors: selectors.split(',').map(selector => selector.trim().replace(/\[\s*hidden\s*\]/g, '[hidden]')),
    declarations: new Map(body.split(';').filter(value => value.includes(':')).map(value => {
      const colon = value.indexOf(':');
      return [value.slice(0, colon).trim().toLowerCase(), value.slice(colon + 1).trim().toLowerCase()];
    })),
  }));
  const property = (selector, name) => {
    let value;
    for (const rule of rules) if (rule.selectors.includes(selector) && rule.declarations.has(name)) value = rule.declarations.get(name);
    return value;
  };
  for (const selector of ['#timer-controls[hidden]', '#custom-interval[hidden]']) {
    assert.match(property(selector, 'display') ?? '', /^none\s*!\s*important$/);
  }
  assert.equal(property('#settings-status', 'color'), '#969696');
  assert.equal(rules.some(rule => rule.selectors.some(selector => /\bsdpi[\w-]*/i.test(selector))
    && [...rule.declarations.keys()].some(name => /^background(?:-|$)/.test(name))), false);
}

export function createInspectorFixture(html = authoredMarkup) {
  const elements = new Map(), fields = {};
  for (const { tag, attributes } of extractInspectorMarkup(html).nodes) {
    const id = attributes.get('id');
    if (!id) continue;
    const field = element(tag, attributes);
    elements.set(id, field);
    fields[id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = field;
    if (attributes.get('role') === 'status') fields.status = field;
  }
  return { fields, elements, getElementById: id => elements.get(id) ?? null };
}
