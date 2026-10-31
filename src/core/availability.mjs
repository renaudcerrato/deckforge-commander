function deviceSnapshot(getDevice) {
  try {
    const device = getDevice();
    if (typeof device?.id !== 'string' || device.id.length === 0) return { connected: false };
    return { id: device.id, connected: device.isConnected === true };
  } catch {
    return { connected: false };
  }
}

/** Event-driven SDK boundary adapter; it never creates visibility or writes persisted intent. */
export function createAvailabilityManager({
  onDeviceDidConnect, onDeviceDidDisconnect, onSystemDidWakeUp,
}) {
  const registrars = [onDeviceDidConnect, onDeviceDidDisconnect, onSystemDidWakeUp];
  if (registrars.some(register => typeof register !== 'function')) {
    throw new TypeError('Availability registrars must be functions.');
  }
  const entries = new Map();
  const pending = new Set();
  const subscriptions = [];
  let disposed = false;

  function apply(entry, connected) {
    let operation;
    try { operation = entry.session.setConnected(connected); } catch { operation = Promise.resolve(); }
    const settled = Promise.resolve(operation).catch(() => {});
    pending.add(settled);
    void settled.then(() => pending.delete(settled));
    return settled;
  }

  function reconcileEntry(entry) {
    const device = deviceSnapshot(entry.getDevice);
    entry.deviceId = device.id;
    return apply(entry, device.connected);
  }

  function track(id, { session, getDevice }) {
    if (disposed) return Promise.resolve();
    if (typeof id !== 'string' || typeof getDevice !== 'function' || typeof session?.setConnected !== 'function') {
      throw new TypeError('Availability tracking requires an action session and a device reader.');
    }
    const entry = { session, getDevice };
    entries.set(id, entry);
    return reconcileEntry(entry);
  }

  function deviceChanged(device) {
    if (disposed || typeof device?.id !== 'string') return Promise.resolve();
    const operations = [];
    for (const entry of entries.values()) {
      if (entry.deviceId === device.id) operations.push(apply(entry, device.isConnected === true));
    }
    return Promise.all(operations).then(() => {});
  }

  function reconcile() {
    if (disposed) return Promise.resolve();
    return Promise.all([...entries.values()].map(reconcileEntry)).then(() => {});
  }

  async function whenIdle() {
    while (pending.size > 0) await Promise.all([...pending]);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    entries.clear();
    for (const subscription of subscriptions) {
      try { subscription.dispose(); } catch {}
    }
    subscriptions.length = 0;
  }

  try {
    subscriptions.push(onDeviceDidConnect(event => { void deviceChanged(event.device); }));
    subscriptions.push(onDeviceDidDisconnect(event => { void deviceChanged(event.device); }));
    subscriptions.push(onSystemDidWakeUp(() => { void reconcile(); }));
    if (subscriptions.some(subscription => typeof subscription?.dispose !== 'function')) throw new Error();
  } catch {
    dispose();
    throw new TypeError('Availability subscriptions failed.');
  }

  return { track, reconcile, whenIdle, dispose };
}
