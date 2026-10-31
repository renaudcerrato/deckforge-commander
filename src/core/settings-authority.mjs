function invalidSettings() {
  const error = new Error('Invalid settings.');
  error.diagnosticCode = 'INVALID_SETTINGS';
  return error;
}

function dataValue(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw invalidSettings();
  return descriptor.value;
}

function copyJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || ancestors.has(value)) throw invalidSettings();
  ancestors.add(value);
  let copy;
  if (Array.isArray(value)) {
    copy = [];
    for (let index = 0; index < dataValue(value, 'length'); index++) {
      copy.push(copyJson(dataValue(value, String(index)), ancestors));
    }
  } else {
    copy = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw invalidSettings();
      Object.defineProperty(copy, key, {
        value: copyJson(dataValue(value, key), ancestors), enumerable: true, writable: true, configurable: true,
      });
    }
  }
  ancestors.delete(value);
  return copy;
}

/** Detached complete settings, including legacy and unknown JSON fields, without invoking getters. */
export function copySettings(input) {
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) throw invalidSettings();
    return copyJson(input);
  } catch {
    throw invalidSettings();
  }
}

/** Compare detached, validated JSON or an undefined confirmation sentinel; never raw external objects. */
export function equalJson(first, second) {
  if (first === second) return true;
  if (first === null || second === null || typeof first !== 'object' || typeof second !== 'object') return false;
  if (Array.isArray(first) !== Array.isArray(second)) return false;
  const keys = Object.keys(first);
  return keys.length === Object.keys(second).length
    && keys.every(key => Object.hasOwn(second, key) && equalJson(first[key], second[key]));
}

/** Serialize complete per-action writes and confirm only matching host-reported readback. */
export function createSettingsAuthority({
  writeSettings, readSettings, createSaveError, onFailure = () => {},
  onBlockedSettings = settings => settings, timeoutMs = 5_000,
  setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  if ([writeSettings, readSettings, createSaveError, onFailure, onBlockedSettings, setTimer, clearTimer]
    .some(value => typeof value !== 'function')) {
    throw new TypeError('Settings authority dependencies must be functions.');
  }
  let settings = {};
  let confirmed;
  let initialized = false;
  let revision = 0;
  let blocked = false;
  let tail = Promise.resolve();
  let pending = 0;

  function getSettings() { return copySettings(settings); }

  function observe(input) {
    const incoming = copySettings(input);
    if (blocked || pending > 0 || initialized) {
      return { accepted: false, settings: getSettings(), revision };
    }
    // Host settings initialize once; plugin controls own this authority thereafter.
    settings = incoming;
    confirmed = copySettings(incoming);
    initialized = true;
    revision++;
    return { accepted: true, settings: getSettings(), revision };
  }

  function fail() {
    if (!blocked) {
      blocked = true;
      settings = onBlockedSettings(settings);
      revision++;
      try { onFailure(); } catch {}
    }
    return createSaveError();
  }

  function writeAndRead(snapshot) {
    return new Promise((resolve, reject) => {
      let active = true;
      let writeCompleted = false;
      const failure = () => {
        const error = createSaveError();
        error.stage = writeCompleted ? 'read' : 'write';
        return error;
      };
      const timer = setTimer(() => {
        active = false;
        reject(failure());
      }, timeoutMs);
      const finish = (callback, value) => {
        if (!active) return;
        active = false;
        clearTimer(timer);
        callback(value);
      };
      void (async () => {
        await writeSettings(copySettings(snapshot));
        writeCompleted = true;
        if (!active) return;
        const reported = copySettings(await readSettings());
        finish(resolve, reported);
      })().catch(() => finish(reject, failure()));
    });
  }

  function save(next) {
    if (blocked) return Promise.reject(createSaveError());
    const incoming = copySettings(next);
    if (!equalJson(settings, incoming)) {
      settings = incoming;
      revision++;
    }
    initialized = true;
    const version = revision;
    const snapshot = getSettings();
    pending++;
    const operation = tail.then(async () => {
      if (blocked) throw createSaveError();
      if (version !== revision) return { status: 'stale', revision: version };
      if (!confirmed || !equalJson(confirmed, snapshot)) {
        // A write may reach the host even if its readback is superseded. The older
        // confirmation must not let a newer different snapshot skip its own write.
        confirmed = undefined;
        let reported;
        try { reported = await writeAndRead(snapshot); } catch (error) {
          if (version !== revision && error.stage === 'read') return { status: 'stale', revision: version };
          throw fail();
        }
        if (version !== revision) return { status: 'stale', revision: version };
        if (!equalJson(snapshot, reported)) throw fail();
        confirmed = reported;
      }
      return { status: 'saved', settings: getSettings(), revision: version };
    });
    const result = operation.finally(() => { pending--; });
    tail = result.catch(() => {});
    return result;
  }

  async function whenIdle() {
    while (true) {
      const current = tail;
      await current;
      if (current === tail) return;
    }
  }

  return {
    observe, getSettings, save, whenIdle,
    isBlocked: () => blocked, getRevision: () => revision,
    isConfirmed: () => equalJson(settings, confirmed),
  };
}
