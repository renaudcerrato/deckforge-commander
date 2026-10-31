import test from 'node:test';
import assert from 'node:assert/strict';
import { createLatestFrameQueue } from '../src/core/latest-frame-queue.mjs';
import { createImageLineFramer } from '../src/core/image-lines.mjs';
import { parseImageUpdate } from '../src/core/image-update.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const options = { timeout: 1_000 };
const image = index => `data:image/svg+xml,${encodeURIComponent(`<svg>${index}</svg>`)}`;
const frame = index => ({ image: image(index), outputVersion: Number.isInteger(index) ? index : 0 });

for (const explicitOrigin of [false, true]) {
  test(`skipped recolor drains one immutable ${explicitOrigin ? 'explicit' : 'default'} producer fallback and idle waits for it`, options, async () => {
    // Arrange
    const active = deferred(), fallback = deferred(), fallbackEntered = deferred(), calls = [], errors = [];
    const producer = { ...frame(1), ...(explicitOrigin ? { origin: 'producer' } : {}) };
    const expected = { ...producer };
    const queue = createLatestFrameQueue({
      send(value) {
        calls.push(value);
        if (calls.length === 1) return active.promise;
        if (value.origin === 'cosmetic') return false;
        fallbackEntered.resolve(); return fallback.promise;
      }, onError: error => errors.push(error),
    });
    // Act
    queue.enqueue(frame(0)); queue.enqueue(producer);
    producer.image = image('mutated'); producer.outputVersion = 99;
    for (let revision = 1; revision <= 1000; revision++) queue.enqueue({ image: image(`style-${revision}`), outputVersion: 1, cosmeticVersion: revision, origin: 'cosmetic' });
    const rejected = queue.enqueue({ ...frame(9), origin: 'cosmetic' });
    let idle = false;
    const settled = queue.whenIdle().then(() => { idle = true; });
    active.resolve(); await fallbackEntered.promise;
    const beforeFallbackDrain = idle;
    fallback.resolve(); await settled;
    // Assert
    assert.equal(rejected, false);
    assert.equal(beforeFallbackDrain, false);
    assert.equal(idle, true);
    assert.deepEqual(calls, [frame(0), { image: image('style-1000'), outputVersion: 1, cosmeticVersion: 1000, origin: 'cosmetic' }, expected]);
    assert.ok(calls.every(Object.isFrozen));
    assert.deepEqual(errors, []);
  });
}

for (const handedOff of [true, undefined]) {
  test(`cosmetic image handoff ${String(handedOff)} consumes the alternate without double replay`, options, async () => {
    // Arrange
    const active = deferred(), calls = [];
    const queue = createLatestFrameQueue({ send(value) { calls.push(value); return calls.length === 1 ? active.promise : handedOff; }, onError() { assert.fail('unexpected failure'); } });
    const cosmetic = { image: image('recolored'), outputVersion: 1, cosmeticVersion: 2, origin: 'cosmetic' };
    // Act
    queue.enqueue(frame(0)); queue.enqueue(frame(1)); queue.enqueue(cosmetic);
    active.resolve(); await queue.whenIdle();
    // Assert
    assert.deepEqual(calls, [frame(0), cosmetic]);
  });
}

for (const change of ['different-version', 'new-producer', 'discard', 'dispose', 'reject', 'throw']) {
  test(`${change} prevents obsolete producer fallback publication`, options, async () => {
    // Arrange
    const active = deferred(), calls = [], errors = [];
    const queue = createLatestFrameQueue({ send(value) {
      calls.push(value);
      if (calls.length === 1) return active.promise;
      if (value.origin === 'cosmetic') {
        if (change === 'reject') return Promise.reject(new Error('synthetic'));
        if (change === 'throw') throw new Error('synthetic');
        return false;
      }
      return true;
    }, onError: error => errors.push(error) });
    const cosmetic = { image: image('style'), outputVersion: 1, cosmeticVersion: 1, origin: 'cosmetic' };
    // Act
    queue.enqueue(frame(0)); queue.enqueue(frame(1)); queue.enqueue(cosmetic);
    if (change === 'different-version') queue.enqueue({ ...cosmetic, outputVersion: 2 });
    if (change === 'new-producer') queue.enqueue(frame(2));
    if (change === 'discard') { queue.discardProducerFallback(); queue.discardProducerFallback(); }
    if (change === 'dispose') queue.dispose();
    active.resolve(); await queue.whenIdle();
    // Assert
    assert.equal(calls.some(value => value.image === image(1)), false);
    assert.deepEqual(calls, change === 'dispose' ? [frame(0)] : change === 'new-producer' ? [frame(0), frame(2)] : [frame(0), change === 'different-version' ? { ...cosmetic, outputVersion: 2 } : cosmetic]);
    assert.deepEqual(errors, ['reject', 'throw'].includes(change) ? ['Frame send failed.'] : []);
  });
}

test('malformed getter/proxy/schema frames cannot evict the valid producer alternate', options, async () => {
  // Arrange
  const active = deferred(), calls = [];
  let reads = 0;
  const queue = createLatestFrameQueue({ send(value) { calls.push(value); return calls.length === 1 ? active.promise : value.origin === 'cosmetic' ? false : true; }, onError() { assert.fail('unexpected failure'); } });
  const hostile = { get image() { reads++; throw new Error('synthetic'); }, outputVersion: 2 };
  const proxy = new Proxy(frame(2), { ownKeys() { reads++; throw new Error('synthetic'); } });
  const cosmetic = { ...frame(1), origin: 'cosmetic', cosmeticVersion: 1 };
  // Act
  queue.enqueue(frame(0)); queue.enqueue(frame(1)); queue.enqueue(cosmetic);
  const rejected = [hostile, proxy, { ...frame(2), extra: true }, { ...frame(2), origin: 'unknown' }].map(value => queue.enqueue(value));
  active.resolve(); await queue.whenIdle();
  // Assert
  assert.deepEqual(rejected, [false, false, false, false]);
  assert.equal(reads, 0);
  assert.deepEqual(calls, [frame(0), cosmetic, frame(1)]);
});

test('prepared frames are copied, frozen and isolated from rejected getter/proxy inputs', options, async () => {
  // Arrange
  const gate = deferred(), calls = [];
  let reads = 0;
  const queue = createLatestFrameQueue({ send(value) { calls.push(value); return calls.length === 1 ? gate.promise : Promise.resolve(); }, onError() { assert.fail('unexpected failure'); } });
  const pending = { ...frame(1), cosmeticVersion: 2 };
  const hostile = { get image() { reads++; throw new Error('synthetic'); }, outputVersion: 2 };
  const proxy = new Proxy(frame(2), { ownKeys() { reads++; throw new Error('synthetic'); } });
  // Act
  queue.enqueue(frame(0));
  const accepted = queue.enqueue(pending);
  pending.image = image('mutated'); pending.cosmeticVersion = 9;
  const rejected = [hostile, proxy, { image: image(3) }, { ...frame(3), outputVersion: NaN }].map(value => queue.enqueue(value));
  gate.resolve(); await queue.whenIdle();
  // Assert
  assert.equal(accepted, true);
  assert.deepEqual(rejected, [false, false, false, false]);
  assert.equal(reads, 0);
  assert.deepEqual(calls, [frame(0), { ...frame(1), cosmeticVersion: 2 }]);
  assert.ok(calls.every(Object.isFrozen));
});

test('producer and cosmetic origins remain complete isolated frames and invalid cosmetics cannot evict them', options, async () => {
  // Arrange
  const gate = deferred(), calls = [];
  const queue = createLatestFrameQueue({ send(value) { calls.push(value); return calls.length === 1 ? gate.promise : Promise.resolve(); }, onError() { assert.fail('unexpected failure'); } });
  const cosmetic = { ...frame(1), origin: 'cosmetic', cosmeticVersion: 3 };
  // Act
  const accepted = [queue.enqueue({ ...frame(0), origin: 'producer' }), queue.enqueue(cosmetic)];
  cosmetic.origin = 'producer'; cosmetic.cosmeticVersion = 9;
  const rejected = [queue.enqueue({ ...frame(2), origin: 'cosmetic' }), queue.enqueue({ ...frame(2), origin: 'unknown' })];
  gate.resolve(); await queue.whenIdle();
  // Assert
  assert.deepEqual(accepted, [true, true]);
  assert.deepEqual(rejected, [false, false]);
  assert.deepEqual(calls, [{ ...frame(0), origin: 'producer' }, { ...frame(1), origin: 'cosmetic', cosmeticVersion: 3 }]);
  assert.ok(calls.every(Object.isFrozen));
});

test('latest complete pending frame replaces all older metadata and bounds active sends', options, async () => {
  // Arrange: local promises only, no renderer-ACK assumption.
  const gate = deferred();
  const calls = [];
  let active = 0, maximum = 0;
  const queue = createLatestFrameQueue({
    send(update) {
      calls.push(update); active++; maximum = Math.max(maximum, active);
      return (calls.length === 1 ? gate.promise : Promise.resolve()).then(() => { active--; });
    }, onError: () => assert.fail('unexpected send failure'),
  });
  // Act
  queue.enqueue(frame('first'));
  queue.enqueue({ ...frame('older'), cosmeticVersion: 9 });
  for (let index = 0; index < 10_000; index++) queue.enqueue(frame(index));
  const before = [...calls];
  gate.resolve();
  await queue.whenIdle();
  // Assert
  assert.deepEqual(before, [frame('first')]);
  assert.deepEqual(calls, [frame('first'), frame(9999)]);
  assert.equal(maximum, 1);
});

test('invalid legacy title frame never evicts the latest valid complete frame', options, async () => {
  // Arrange
  const gate = deferred();
  const calls = [];
  const queue = createLatestFrameQueue({ send(update) { calls.push(update); return calls.length === 1 ? gate.promise : Promise.resolve(); }, onError() {} });
  // Act
  queue.enqueue(frame(0));
  queue.enqueue({ ...frame(1), cosmeticVersion: 1 });
  const accepted = queue.enqueue({ ...frame(2), title: '' });
  gate.resolve();
  await queue.whenIdle();
  // Assert
  assert.equal(accepted, false);
  assert.deepEqual(calls, [frame(0), { ...frame(1), cosmeticVersion: 1 }]);
});

test('success drains the final pending image and accepts subsequent idle updates', options, async () => {
  // Arrange
  const calls = [];
  const queue = createLatestFrameQueue({ send: update => { calls.push(update); return Promise.resolve(); }, onError() {} });
  // Act
  queue.enqueue(frame(0));
  await queue.whenIdle();
  queue.enqueue(frame(1));
  await queue.whenIdle();
  // Assert
  assert.deepEqual(calls, [frame(0), frame(1)]);
});

for (const reject of [false, true]) {
  test(`disposal prevents stale sends after ${reject ? 'rejection' : 'success'}`, options, async () => {
    // Arrange
    const gate = deferred();
    const calls = [], errors = [];
    const queue = createLatestFrameQueue({ send(update) { calls.push(update); return gate.promise; }, onError: error => errors.push(error) });
    queue.enqueue(frame(0));
    queue.enqueue(frame(1));
    // Act
    queue.dispose(); queue.dispose();
    queue.enqueue(frame(2));
    if (reject) gate.reject(new Error('private stale exception')); else gate.resolve();
    await queue.whenIdle();
    // Assert
    assert.deepEqual(calls, [frame(0)]);
    assert.deepEqual(errors, []);
  });
}

for (const synchronous of [false, true]) {
  test(`${synchronous ? 'thrown' : 'rejected'} sends stop without retries and sanitize errors`, options, async () => {
    // Arrange
    const calls = [], errors = [];
    const queue = createLatestFrameQueue({ send(update) {
      calls.push(update);
      if (synchronous) throw new Error('private args/env/exception');
      return Promise.reject(new Error('private args/env/exception'));
    }, onError: error => errors.push(error) });
    // Act
    queue.enqueue(frame('private'));
    queue.enqueue(frame('pending'));
    await queue.whenIdle();
    queue.enqueue(frame('retry'));
    await queue.whenIdle();
    // Assert
    assert.equal(calls.length, 1);
    assert.deepEqual(errors, ['Frame send failed.']);
  });
}

for (const bytes of [Buffer.from('data:image/png;base64,%%%\n'), Buffer.alloc(262_145, 120), Uint8Array.of(0xc3, 0x28, 10)]) {
  test('invalid output is validated before coalescing even with an unresolved send', options, async () => {
    // Arrange
    const gate = deferred();
    const calls = [];
    const queue = createLatestFrameQueue({ send(update) { calls.push(update); return gate.promise; }, onError() {} });
    let outputVersion = 0;
    const framer = createImageLineFramer({ onLine: line => queue.enqueue({ ...parseImageUpdate(line), outputVersion: ++outputVersion }) });
    framer.push(Buffer.from('<svg>first</svg>\n<svg>pending</svg>\n'));
    let failure;
    // Act
    try { framer.push(bytes); } catch (error) { failure = error; }
    queue.dispose(); gate.resolve(); await queue.whenIdle();
    // Assert
    assert.equal(failure?.message, 'Image protocol error.');
    assert.equal(calls.length, 1);
  });
}
