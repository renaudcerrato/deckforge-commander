import { types } from 'node:util';

const SEND_ERROR = 'Frame send failed.';
const MAX_FRAME_UNITS = 262_144 * 9 + 128;

function copyUpdate(update) {
  try {
    if (update === null || typeof update !== 'object' || types.isProxy(update) || Array.isArray(update)) return undefined;
    const prototype = Object.getPrototypeOf(update);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(update);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > 4 || keys.some(key => !['image', 'outputVersion', 'cosmeticVersion', 'origin'].includes(key)
      || !Object.hasOwn(descriptors[key], 'value'))) return undefined;
    const image = descriptors.image?.value;
    const outputVersion = descriptors.outputVersion?.value;
    const cosmeticVersion = descriptors.cosmeticVersion?.value;
    const origin = descriptors.origin?.value;
    if (typeof image !== 'string' || image.length > MAX_FRAME_UNITS
      || !Number.isSafeInteger(outputVersion) || outputVersion < 0
      || (Object.hasOwn(descriptors, 'cosmeticVersion') && (!Number.isSafeInteger(cosmeticVersion) || cosmeticVersion < 0))
      || (Object.hasOwn(descriptors, 'origin') && origin !== 'producer' && origin !== 'cosmetic')
      || (origin === 'cosmetic' && cosmeticVersion === undefined)) return undefined;
    return Object.freeze({ image, outputVersion, ...(cosmeticVersion === undefined ? {} : { cosmeticVersion }),
      ...(origin === undefined ? {} : { origin }) });
  } catch { return undefined; }
}

/** Keep at most one active local send and the latest coalesced update. */
export function createLatestFrameQueue({ send, onError }) {
  if (typeof send !== 'function' || typeof onError !== 'function') {
    throw new TypeError('send and onError must be functions.');
  }

  let activeUpdate;
  let pendingUpdate;
  let producerFallback;
  let disposed = false;
  let failed = false;
  let errorReported = false;
  const idleWaiters = new Set();

  function settleWhenIdle() {
    if (activeUpdate !== undefined || pendingUpdate !== undefined) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  }

  function reportFailure() {
    failed = true;
    pendingUpdate = undefined;
    producerFallback = undefined;

    if (disposed || errorReported) return;
    errorReported = true;
    try {
      onError(SEND_ERROR);
    } catch {
      // Error reporting must not leak the send failure or strand idle waiters.
    }
  }

  function sendUpdate(update) {
    activeUpdate = update;
    let result;
    try {
      result = send(update);
    } catch {
      activeUpdate = undefined;
      reportFailure();
      settleWhenIdle();
      return;
    }

    Promise.resolve(result).then(
      (handedOff) => {
        activeUpdate = undefined;
        // An attempted active producer must not survive as a cosmetic's alternate.
        if (handedOff !== false && producerFallback === update) producerFallback = undefined;
        // A cosmetic handoff already delivered this record; never replay its producer copy.
        if (handedOff !== false && update.origin === 'cosmetic'
          && producerFallback?.outputVersion === update.outputVersion) producerFallback = undefined;
        if (disposed || failed || pendingUpdate === undefined) {
          if (!disposed && !failed && handedOff === false && update.origin === 'cosmetic'
            && producerFallback?.outputVersion === update.outputVersion) {
            const fallback = producerFallback;
            producerFallback = undefined;
            sendUpdate(fallback);
            return;
          }
          settleWhenIdle();
          return;
        }

        const nextUpdate = pendingUpdate;
        pendingUpdate = undefined;
        sendUpdate(nextUpdate);
      },
      () => {
        activeUpdate = undefined;
        reportFailure();
        settleWhenIdle();
      },
    );
  }

  function enqueue(update) {
    if (disposed || failed) return false;
    const copy = copyUpdate(update);
    if (!copy) return false;
    if (copy.origin !== 'cosmetic') producerFallback = undefined;
    else {
      if (producerFallback?.outputVersion !== copy.outputVersion) producerFallback = undefined;
      if (pendingUpdate !== undefined && pendingUpdate.origin !== 'cosmetic'
        && pendingUpdate.outputVersion === copy.outputVersion) producerFallback = pendingUpdate;
      else if (activeUpdate !== undefined && activeUpdate.origin !== 'cosmetic'
        && activeUpdate.outputVersion === copy.outputVersion) producerFallback = activeUpdate;
    }
    if (activeUpdate === undefined) {
      sendUpdate(copy);
      return true;
    }
    pendingUpdate = copy;
    return true;
  }

  function whenIdle() {
    if (activeUpdate === undefined && pendingUpdate === undefined) return Promise.resolve();
    return new Promise(resolve => idleWaiters.add(resolve));
  }

  function dispose() {
    disposed = true;
    pendingUpdate = undefined;
    producerFallback = undefined;
    settleWhenIdle();
  }

  function discardProducerFallback() { producerFallback = undefined; }

  return { enqueue, whenIdle, dispose, discardProducerFallback };
}
