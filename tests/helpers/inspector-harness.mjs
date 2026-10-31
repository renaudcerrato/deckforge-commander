import { readFileSync } from 'node:fs';

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
      if (color) { this.dispatch('input'); this.dispatch('change'); }
      else if (tag.startsWith('sdpi-')) this.dispatch('valuechange');
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

// Narrow extractor for static authored opening tags/attributes, not an HTML parser
// or browser emulator. Scripts, styles and comments never supply fixture elements.
export function createInspectorFixture(html = authoredMarkup) {
  const elements = new Map(), fields = {};
  const markup = html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  for (const [, tag, source] of markup.matchAll(/<([a-z][\w-]*)\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>/gi)) {
    const attributes = new Map([...source.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)]
      .map(([, name, double, single, bare]) => [name.toLowerCase(), double ?? single ?? bare ?? '']));
    const id = attributes.get('id');
    if (!id) continue;
    const field = element(tag.toLowerCase(), attributes);
    elements.set(id, field);
    fields[id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = field;
    if (attributes.get('role') === 'status') fields.status = field;
  }
  return { fields, elements, getElementById: id => elements.get(id) ?? null };
}
