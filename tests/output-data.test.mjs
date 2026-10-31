import test from 'node:test';
import assert from 'node:assert/strict';
import { copyOutputData } from '../src/core/output-data.mjs';
import { parseOutputUpdate } from '../src/core/output-update.mjs';

test('card complete option vocabulary copies all 26 fields and rejects a 27th field', () => {
  // Arrange - This is the public option schema, not a generic numeric-field fixture.
  const record = parseOutputUpdate('card:UP|header:API;footer:HTTP 200;header-gap:0;footer-gap:12.5;overflow:wrap');
  const input = { ...record.options };
  // Act
  const copied = copyOutputData(input);
  const rejected = copyOutputData({ ...input, unknown: 1 });
  input.header = 'changed';
  // Assert
  assert.equal(Object.keys(copied).length, 26);
  assert.deepEqual({ ...copied }, { ...record.options });
  assert.equal(copied.header, 'API');
  assert.equal(rejected, undefined);
});

// Preserve the shared output boundary without imposing renderer/session validation.
for (const prototype of [Object.prototype, null]) {
  for (const count of [0, 1, 23, 25, 26]) {
    test(`copies ${count} own data fields from ${prototype === null ? 'null-prototype' : 'plain'} objects`, () => {
      // Arrange
      const input = Object.create(prototype);
      const expected = Object.create(null);
      for (let index = 0; index < count; index += 1) {
        input[`field${index}`] = index;
        expected[`field${index}`] = index;
      }
      // Act
      const result = copyOutputData(input);
      // Assert
      assert.deepEqual(result, expected);
      assert.equal(Object.getPrototypeOf(result), null);
      assert.notEqual(result, input);
      assert.equal(Object.isFrozen(result), false);
    });
  }
}

for (const enumerable of [true, false]) {
  test(`rejects 27 own data fields including ${enumerable ? 'enumerable' : 'nonenumerable'} fields`, () => {
    // Arrange
    const input = {};
    for (let index = 0; index < 27; index += 1) {
      Object.defineProperty(input, `field${index}`, { value: index, enumerable });
    }
    const before = Object.getOwnPropertyDescriptors(input);
    // Act
    const result = copyOutputData(input);
    // Assert
    assert.equal(result, undefined);
    assert.deepEqual(Object.getOwnPropertyDescriptors(input), before);
  });
}

for (const [name, makeInput] of [
  ['null', () => null],
  ['undefined', () => undefined],
  ['boolean', () => false],
  ['number', () => 42],
  ['NaN', () => NaN],
  ['string', () => 'text'],
  ['bigint', () => 1n],
  ['symbol', () => Symbol('field')],
  ['function', () => function output() {}],
  ['empty array', () => []],
  ['populated array', () => ['text']],
  ['custom prototype', () => Object.create({ inherited: 1 })],
  ['class instance', () => new (class Output {})()],
  ['boxed string', () => new String('text')],
  ['date', () => new Date(0)],
]) {
  test(`rejects ${name} rather than treating it as plain output data`, () => {
    // Arrange
    const input = makeInput();
    // Act
    const result = copyOutputData(input);
    // Assert
    assert.equal(result, undefined);
  });
}

// Accessor rejection must not execute producer-controlled code, even when hidden.
for (const enumerable of [true, false]) {
  for (const kind of ['getter', 'setter', 'getter and setter']) {
    test(`rejects ${enumerable ? 'enumerable' : 'nonenumerable'} ${kind} without invoking it`, () => {
      // Arrange
      let calls = 0;
      const descriptor = { enumerable, configurable: true };
      if (kind.includes('getter')) descriptor.get = () => { calls += 1; throw new Error('unexpected getter'); };
      if (kind.includes('setter')) descriptor.set = () => { calls += 1; throw new Error('unexpected setter'); };
      const input = { valid: 'text' };
      Object.defineProperty(input, 'accessor', descriptor);
      const before = Object.getOwnPropertyDescriptors(input);
      // Act
      const result = copyOutputData(input);
      // Assert
      assert.equal(result, undefined);
      assert.equal(calls, 0);
      assert.deepEqual(Object.getOwnPropertyDescriptors(input), before);
    });
  }
}

for (const enumerable of [true, false]) {
  test(`rejects ${enumerable ? 'enumerable' : 'nonenumerable'} own symbol fields`, () => {
    // Arrange
    const input = { valid: 'text' };
    Object.defineProperty(input, Symbol('field'), { value: 1, enumerable });
    const before = Object.getOwnPropertyDescriptors(input);
    // Act
    const result = copyOutputData(input);
    // Assert
    assert.equal(result, undefined);
    assert.deepEqual(Object.getOwnPropertyDescriptors(input), before);
  });
}

// Proxies are rejected before any reflective operation can trigger their traps.
for (const [name, makeTarget] of [
  ['plain object', () => ({ value: 'text' })],
  ['null-prototype object', () => Object.create(null)],
  ['array', () => []],
  ['function', () => function output() {}],
]) {
  for (const revoked of [false, true]) {
    test(`rejects ${revoked ? 'revoked' : 'live'} ${name} proxy without traps or exceptions`, () => {
      // Arrange
      const calls = [];
      const handler = {};
      for (const trap of ['getPrototypeOf', 'setPrototypeOf', 'isExtensible', 'preventExtensions', 'getOwnPropertyDescriptor', 'defineProperty', 'has', 'get', 'set', 'deleteProperty', 'ownKeys', 'apply', 'construct']) {
        handler[trap] = () => { calls.push(trap); throw new Error('unexpected proxy trap'); };
      }
      const { proxy, revoke } = Proxy.revocable(makeTarget(), handler);
      if (revoked) revoke();
      // Act
      const result = copyOutputData(proxy);
      // Assert
      assert.equal(result, undefined);
      assert.deepEqual(calls, []);
    });
  }
}

test('copies nonenumerable read-only data without modifying input descriptors or freezing the helper result', () => {
  // Arrange
  const input = Object.freeze(Object.defineProperties({}, {
    visible: { value: 'text', enumerable: true },
    hidden: { value: 42, enumerable: false },
  }));
  const before = Object.getOwnPropertyDescriptors(input);
  // Act
  const result = copyOutputData(input);
  // Assert
  assert.deepEqual(result, Object.assign(Object.create(null), { visible: 'text', hidden: 42 }));
  assert.deepEqual(Object.getOwnPropertyDescriptors(input), before);
  assert.equal(Object.isFrozen(input), true);
  assert.equal(Object.isFrozen(result), false);
  assert.deepEqual(Object.getOwnPropertyDescriptor(result, 'hidden'), {
    value: 42, writable: true, enumerable: true, configurable: true,
  });
});

test('detaches top-level fields while preserving opaque values by identity without inspecting them', () => {
  // Arrange
  let calls = 0;
  const nested = Object.defineProperty({}, 'accessor', {
    get() { calls += 1; throw new Error('unexpected nested getter'); },
  });
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  const liveProxy = new Proxy({}, {
    get() { calls += 1; throw new Error('unexpected nested proxy get'); },
    getPrototypeOf() { calls += 1; throw new Error('unexpected nested proxy prototype'); },
    ownKeys() { calls += 1; throw new Error('unexpected nested proxy keys'); },
    getOwnPropertyDescriptor() { calls += 1; throw new Error('unexpected nested proxy descriptor'); },
  });
  const values = {
    nested, proxy, liveProxy, array: [1], callable: () => {}, symbol: Symbol('value'),
    nullValue: null, undefinedValue: undefined, invalidNumber: NaN, bigint: 1n,
  };
  const input = { ...values };
  // Act
  const result = copyOutputData(input);
  const copiedCallable = result.callable;
  input.nested = 'replacement';
  delete input.array;
  input.added = true;
  result.callable = 'local edit';
  result.local = true;
  // Assert
  assert.equal(result.nested, nested);
  assert.equal(result.array, values.array);
  assert.equal(copiedCallable, values.callable);
  for (const key of ['proxy', 'liveProxy', 'symbol', 'nullValue', 'undefinedValue', 'invalidNumber', 'bigint']) {
    assert.equal(result[key], values[key]);
  }
  assert.equal(calls, 0);
  assert.equal(Object.hasOwn(result, 'added'), false);
  assert.equal(input.callable, values.callable);
  assert.equal(Object.hasOwn(input, 'local'), false);
  assert.equal(Object.isFrozen(nested), false);
});

test('copies __proto__ as an ordinary own data field without changing either prototype', () => {
  // Arrange
  const value = { opaque: true };
  const input = Object.defineProperty({}, '__proto__', {
    value, enumerable: false, writable: false, configurable: false,
  });
  const before = Object.getOwnPropertyDescriptors(input);
  // Act
  const result = copyOutputData(input);
  // Assert
  assert.equal(Object.getPrototypeOf(result), null);
  assert.equal(Object.hasOwn(result, '__proto__'), true);
  assert.equal(result.__proto__, value);
  assert.equal(Object.getPrototypeOf(input), Object.prototype);
  assert.deepEqual(Object.getOwnPropertyDescriptors(input), before);
  assert.deepEqual(Object.getOwnPropertyDescriptor(result, '__proto__'), {
    value, writable: true, enumerable: true, configurable: true,
  });
});
