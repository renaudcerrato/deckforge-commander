import { getInspectorConfiguration, validateTitleEdit } from '../core/settings.mjs';
import { isAbsoluteExecutionPath } from '../core/execution-paths.mjs';
import { copyRunSettings } from '../core/run-state.mjs';
import { normalizeThemeColor } from '../core/theme.mjs';
import { getTimerInspectorConfiguration, MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS } from '../core/timer-settings.mjs';

const FIELDS = new Set(['executable', 'argsText', 'cwd', 'themeColor', 'title']);
export const RUN_ACTION_UUID = 'git.renaudcerrato.deckforge.stream';
export const TIMER_ACTION_UUID = 'git.renaudcerrato.deckforge.loop';
export const ONCE_ACTION_UUID = 'git.renaudcerrato.deckforge.run';
// Device types: https://docs.elgato.com/streamdeck/sdk/guides/devices#device-types
const DEVICE_MODELS = new Map([
  [0, 'Stream Deck'],
  [1, 'Stream Deck Mini'],
  [2, 'Stream Deck XL'],
  [7, 'Stream Deck +'],
  [9, 'Stream Deck Neo'],
  [10, 'Stream Deck Studio'],
  [11, 'Virtual Stream Deck'],
  [13, 'Stream Deck + XL'],
]);
const KEY_IMAGE_PIXELS = new Map([
  [0, [72, 72]], // Stream Deck / MK.2: https://docs.elgato.com/streamdeck/hid/stream-deck-classic
  [1, [80, 80]], // https://docs.elgato.com/streamdeck/hid/mini
  [2, [96, 96]], // https://docs.elgato.com/streamdeck/hid/stream-deck-xl
  [7, [120, 120]], // https://docs.elgato.com/streamdeck/hid/stream-deck-plus
  [9, [96, 96]], // https://docs.elgato.com/streamdeck/hid/stream-deck-neo
  [10, [144, 112]], // Stream Deck Studio
  [13, [112, 112]], // https://docs.elgato.com/streamdeck/hid/stream-deck-plus-xl
]);
const SAFE_REASONS = new Set([
  'STATE_SAVE_FAILED', 'INVALID_SETTINGS', 'INVALID_EXECUTABLE', 'INVALID_CWD',
  'ARGS_TEXT_INVALID', 'ARGS_JSON_INVALID', 'ARGS_NOT_ARRAY', 'INVALID_ARGUMENT',
  'THEME_COLOR_INVALID', 'INTERVAL_INVALID', 'ACTION_ON_PRESS_INVALID', 'TITLE_INVALID',
  'SCRIPT_IMPORT_FAILED',
]);
// Temporary, value-free diagnostics for the inspector save boundary.
export const DIAGNOSTIC_STAGES = new Set([
  'INSPECTOR_EDIT', 'INSPECTOR_HYDRATION', 'INSPECTOR_TRANSPORT', 'PLUGIN_REPLY',
  'PLUGIN_EDIT_BEGIN', 'PLUGIN_APPLY_BEGIN', 'PLUGIN_SAVE_WAIT', 'PLUGIN_APPLY_WAIT',
  'PLUGIN_STAGE_MISSING', 'PLUGIN_STAGE_UNKNOWN',
]);

function connectionText(value) {
  if (typeof value !== 'string') return null;
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`).slice(0, 256);
}

/** One PI socket; only narrow configuration edits leave this bridge. */
export function createInspectorBridge({
  createSocket = url => new WebSocket(url),
  inspectorId = `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  onSettings = () => {}, onError = () => {}, onStatus = () => {}, onConnectionState = () => {},
  delayMs = 200, timeoutMs = 15_000, setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  let socket;
  const inspectorIdPrefix = inspectorId;
  let connectionCount = 0;
  let connectionVersion = 0;
  let hasBoundContext = false;
  let bindingValid = false;
  let context;
  let action;
  let platform = 'posix';
  let os;
  let deviceModel;
  let coordinates;
  let imageSize;
  let transportContext;
  let open = false;
  let ready = false;
  let transportFailed = false;
  let requestId = 0;
  let latestRequest;
  let debounceTimer;
  let replyTimer;
  let pending = false;
  const versions = new Map();
  const acknowledged = new Map();
  const dirtyValues = new Map();
  let observingConnection = false;
  let observedConnection;

  /** Local identity and platform binding for the controller; never sent to the plugin. */
  function getConnectionState() {
    return {
      bindingValid, platform, version: connectionVersion, inspectorId: connectionText(inspectorId),
      actionUuid: connectionText(action), context: connectionText(context),
      ...(os ? { os } : {}),
      ...(bindingValid && deviceModel ? { deviceModel } : {}),
      ...(bindingValid && coordinates ? { coordinates: { ...coordinates } } : {}),
      ...(bindingValid && imageSize ? { imageSize: { ...imageSize } } : {}),
    };
  }

  function observeConnection() {
    if (observingConnection) return;
    const snapshot = getConnectionState();
    const signature = JSON.stringify(snapshot);
    if (signature === observedConnection) return;
    observedConnection = signature;
    observingConnection = true;
    try { void Promise.resolve(onConnectionState(snapshot)).catch(() => {}); } catch {}
    finally { observingConnection = false; }
  }

  function failure(code = 'STATE_SAVE_FAILED', stage = 'INSPECTOR_TRANSPORT') {
    onError(SAFE_REASONS.has(code) ? code : 'STATE_SAVE_FAILED',
      DIAGNOSTIC_STAGES.has(stage) ? stage : 'INSPECTOR_TRANSPORT');
    onStatus('error');
  }

  function protectedFields() {
    return new Set([...versions.keys()].filter(key => versions.get(key) !== (acknowledged.get(key) ?? 0)));
  }

  function hydrate(settings) {
    try {
      const project = bindingValid && action === TIMER_ACTION_UUID ? getTimerInspectorConfiguration : getInspectorConfiguration;
      const configuration = project(copyRunSettings(settings), platform);
      const protectedKeys = protectedFields();
      const code = configuration.diagnosticCode;
      const field = code?.startsWith('ARGS_') || code === 'INVALID_ARGUMENT' ? 'argsText'
        : code === 'INVALID_EXECUTABLE' ? 'executable' : code === 'INVALID_CWD' ? 'cwd'
          : code === 'INTERVAL_INVALID' ? 'intervalSeconds'
            : code === 'ACTION_ON_PRESS_INVALID' ? 'actionOnPress' : undefined;
      if (field && protectedKeys.has(field)) delete configuration.diagnosticCode;
      onSettings(configuration, protectedKeys);
      if (configuration.diagnosticCode) failure(configuration.diagnosticCode, 'INSPECTOR_HYDRATION');
      return true;
    } catch {
      failure('STATE_SAVE_FAILED', 'INSPECTOR_HYDRATION');
      return false;
    }
  }

  function clearTimers() {
    if (debounceTimer !== undefined) clearTimer(debounceTimer);
    if (replyTimer !== undefined) clearTimer(replyTimer);
    debounceTimer = replyTimer = undefined;
  }

  function sendRequest(type, changes, token) {
    if (!open) return;
    if (replyTimer !== undefined) clearTimer(replyTimer);
    const id = ++requestId;
    latestRequest = { id, type, active: true, versions: new Map(versions),
      fields: type === 'canvas:script' ? [] : Object.keys(changes ?? {}) };
    const version = connectionVersion;
    replyTimer = setTimer(() => {
      replyTimer = undefined;
      if (version === connectionVersion && latestRequest?.id === id) {
        latestRequest.active = false;
        observeConnection();
        failure();
      }
    }, timeoutMs);
    const payload = { type, context, inspectorId, requestId: id };
    if (changes) payload.changes = changes;
    if (token !== undefined) payload.token = token;
    try {
      // The host routes the PI envelope by its registered UUID; payload.context remains the action context.
      socket.send(JSON.stringify({ event: 'sendToPlugin', action, context: transportContext, payload }));
      observeConnection();
    } catch {
      open = false;
      ready = false;
      transportFailed = true;
      clearTimers();
      latestRequest.active = false;
      observeConnection();
      failure();
    }
  }

  function flush() {
    if (debounceTimer !== undefined) clearTimer(debounceTimer);
    debounceTimer = undefined;
    if (!open || !ready || !pending) return;
    const changes = {};
    for (const key of protectedFields()) changes[key] = dirtyValues.get(key);
    pending = false;
    if (Object.keys(changes).length > 0) sendRequest('canvas:edit', changes);
  }

  function edit(changes, { immediate = false } = {}) {
    let edit;
    const failEdit = code => failure(code, 'INSPECTOR_EDIT');
    // Check Timer metadata descriptors before JSON copying, without reading accessors.
    // Timer edits require a recognized current SDK binding, never a remembered UUID.
    try {
      const interval = Object.getOwnPropertyDescriptor(changes, 'intervalSeconds');
      if (interval) {
        if (!bindingValid || action !== TIMER_ACTION_UUID) { failEdit('INVALID_SETTINGS'); return false; }
        if (!Object.hasOwn(interval, 'value') || !Number.isSafeInteger(interval.value)
          || interval.value < MIN_INTERVAL_SECONDS || interval.value > MAX_INTERVAL_SECONDS) {
          failEdit('INTERVAL_INVALID'); return false;
        }
      }
      const policy = Object.getOwnPropertyDescriptor(changes, 'actionOnPress');
      if (policy) {
        if (!bindingValid || action !== TIMER_ACTION_UUID) { failEdit('INVALID_SETTINGS'); return false; }
        if (!Object.hasOwn(policy, 'value') || (policy.value !== 'refresh' && policy.value !== 'stop')) {
          failEdit('ACTION_ON_PRESS_INVALID'); return false;
        }
      }
    } catch { failEdit('INVALID_SETTINGS'); return false; }
    try { edit = copyRunSettings(changes); } catch {
      failEdit('INVALID_SETTINGS'); return false;
    }
    if (Object.keys(edit).length === 0) return false;
    for (const [key, value] of Object.entries(edit)) {
      if (key === 'title') {
        try { validateTitleEdit(value); } catch { failEdit('TITLE_INVALID'); return false; }
        continue;
      }
      if (key === 'actionOnPress' && bindingValid && action === TIMER_ACTION_UUID) {
        if (value !== 'refresh' && value !== 'stop') { failEdit('ACTION_ON_PRESS_INVALID'); return false; }
        continue;
      }
      if (key === 'intervalSeconds' && bindingValid && action === TIMER_ACTION_UUID) {
        if (!Number.isSafeInteger(value) || value < MIN_INTERVAL_SECONDS || value > MAX_INTERVAL_SECONDS) {
          failEdit('INTERVAL_INVALID'); return false;
        }
        continue;
      }
      if (key === 'themeColor') {
        try { edit.themeColor = normalizeThemeColor(value); } catch {
          failEdit('THEME_COLOR_INVALID');
          return false;
        }
        continue;
      }
      if (!FIELDS.has(key) || typeof value !== 'string' || value.includes('\0')) {
        failEdit(key === 'argsText' ? 'ARGS_TEXT_INVALID' : key === 'cwd' ? 'INVALID_CWD'
          : key === 'executable' ? 'INVALID_EXECUTABLE' : 'INVALID_SETTINGS');
        return false;
      }
      if (key === 'executable' && !isAbsoluteExecutionPath(value, platform)) {
        failEdit('INVALID_EXECUTABLE');
        return false;
      }
    }
    // Failed transports keep local control edits visible without promising another save.
    if (transportFailed) return true;
    let changed = false;
    for (const [key, value] of Object.entries(edit)) {
      if ((key === 'themeColor' || key === 'intervalSeconds' || key === 'actionOnPress') && dirtyValues.get(key) === value) continue;
      versions.set(key, (versions.get(key) ?? 0) + 1);
      dirtyValues.set(key, value);
      changed = true;
    }
    if (!changed) return true;
    pending = true;
    observeConnection();
    onStatus('saving');
    if (immediate) flush();
    else {
      if (debounceTimer !== undefined) clearTimer(debounceTimer);
      debounceTimer = setTimer(flush, delayMs);
    }
    return true;
  }

  function receive(message) {
    if (message?.event !== 'sendToPropertyInspector') return;
    const payload = message.payload;
    if (payload?.type === 'canvas:script-result') {
      if (ready && payload.context === context && payload.inspectorId === inspectorId
        && payload.requestId === latestRequest?.id && !latestRequest.active && !pending && protectedFields().size === 0) {
        if (payload.status === 'saved') {
          if (hydrate(payload.settings)) onStatus('imported');
        } else if (payload.status === 'error') failure('SCRIPT_IMPORT_FAILED', 'PLUGIN_REPLY');
      }
      return;
    }
    if (!payload || payload.type !== 'canvas:reply' || payload.context !== context
      || payload.inspectorId !== inspectorId || payload.requestId !== latestRequest?.id || !latestRequest.active) {
      observeConnection();
      return;
    }
    const request = latestRequest;
    const version = connectionVersion;
    request.active = false;
    if (replyTimer !== undefined) clearTimer(replyTimer);
    replyTimer = undefined;
    if (payload.status === 'challenge' && request.type === 'canvas:hello' && typeof payload.token === 'string') {
      observeConnection();
      if (!hydrate(payload.settings)) { observeConnection(); return; }
      if (version !== connectionVersion) return;
      sendRequest('canvas:claim', undefined, payload.token);
      return;
    }
    if (payload.status !== 'saved') {
      observeConnection();
      const stage = payload.status !== 'error' ? 'PLUGIN_REPLY'
        : !Object.hasOwn(payload, 'diagnosticStage') ? 'PLUGIN_STAGE_MISSING'
          : DIAGNOSTIC_STAGES.has(payload.diagnosticStage) ? payload.diagnosticStage : 'PLUGIN_STAGE_UNKNOWN';
      failure(payload.status === 'error' ? payload.diagnosticCode : 'STATE_SAVE_FAILED', stage);
      return;
    }
    if (!['canvas:claim', 'canvas:edit', 'canvas:script'].includes(request.type)) { observeConnection(); failure('STATE_SAVE_FAILED', 'PLUGIN_REPLY'); return; }
    let settings;
    try { settings = copyRunSettings(payload.settings); } catch { observeConnection(); failure('STATE_SAVE_FAILED', 'INSPECTOR_HYDRATION'); return; }
    for (const key of request.fields) {
      const fieldVersion = request.versions.get(key);
      if (versions.get(key) === fieldVersion) {
        acknowledged.set(key, fieldVersion);
        dirtyValues.delete(key);
      }
    }
    if (request.type === 'canvas:claim') {
      ready = true;
      observeConnection();
    }
    onStatus(protectedFields().size === 0 ? 'saved' : 'saving');
    hydrate(settings);
    if (version === connectionVersion && ready && pending && debounceTimer === undefined) flush();
    observeConnection();
  }

  function disconnect() {
    connectionVersion++;
    open = false;
    ready = false;
    transportFailed = true;
    bindingValid = false;
    platform = 'posix';
    os = deviceModel = coordinates = imageSize = undefined;
    clearTimers();
    const previous = socket;
    socket = undefined;
    transportContext = undefined;
    try { previous?.close(); } catch {}
    observeConnection();
  }

  function connect(port, propertyInspectorUUID, registerEvent, _info, actionInfoText) {
    disconnect();
    transportFailed = false;
    // Host registration metadata is not a setting or a remembered inspector binding.
    // Older callbacks and malformed/unknown metadata retain the POSIX default.
    let registration;
    try {
      registration = JSON.parse(_info);
      if (registration?.application?.platform === 'windows') {
        platform = 'win32';
        os = 'Windows';
      } else if (registration?.application?.platform === 'mac') os = 'macOS';
    } catch { /* Registration info was historically optional; do not invalidate identity. */ }
    inspectorId = connectionCount++ === 0 ? inspectorIdPrefix : `${inspectorIdPrefix}.${connectionCount}`;
    if (hasBoundContext) {
      versions.clear();
      acknowledged.clear();
      dirtyValues.clear();
      pending = false;
    }
    // Before the first valid SDK binding, retain accepted edits to protect controls from old settings.
    latestRequest = undefined;
    requestId = 0;
    const version = connectionVersion;
    try {
      const info = JSON.parse(actionInfoText);
      const number = Number(port);
      if (!Number.isInteger(number) || number < 1 || number > 65535
        || typeof propertyInspectorUUID !== 'string' || typeof registerEvent !== 'string'
        || typeof info?.context !== 'string' || typeof info?.action !== 'string') throw new Error();
      // Parsing/parameter failure is not a binding. Once identity is valid, later calls are session resets,
      // even if hydration or socket creation subsequently fails; edits cannot migrate to another key.
      hasBoundContext = true;
      context = info.context;
      action = info.action;
      bindingValid = info.context.length > 0
        && (action === RUN_ACTION_UUID || action === TIMER_ACTION_UUID || action === ONCE_ACTION_UUID);
      if (bindingValid) {
        const position = info.payload?.coordinates;
        if (Number.isSafeInteger(position?.column) && position.column >= 0
          && Number.isSafeInteger(position?.row) && position.row >= 0) {
          coordinates = { column: position.column, row: position.row };
        }
        const device = Array.isArray(registration?.devices)
          ? registration.devices.find(device => typeof info.device === 'string' && device?.id === info.device) : undefined;
        deviceModel = DEVICE_MODELS.get(device?.type);
        const pixels = KEY_IMAGE_PIXELS.get(device?.type);
        if (pixels) imageSize = { width: pixels[0], height: pixels[1] };
      }
      transportContext = propertyInspectorUUID;
      observeConnection();
      if (!hydrate(info.payload?.settings ?? {})) {
        observeConnection();
        return;
      }
      try { socket = createSocket(`ws://127.0.0.1:${number}`); } catch {
        transportFailed = true;
        clearTimers();
        failure();
        return;
      }
      const connectedSocket = socket;
      observeConnection();
      socket.onopen = () => {
        if (version !== connectionVersion || transportFailed) return;
        observeConnection();
        try {
          connectedSocket.send(JSON.stringify({ event: registerEvent, uuid: propertyInspectorUUID }));
          observeConnection();
          open = true;
          sendRequest('canvas:hello');
          flush();
        } catch { transportFailed = true; clearTimers(); observeConnection(); failure(); }
      };
      socket.onmessage = event => {
        if (version !== connectionVersion || !open) return;
        try { receive(JSON.parse(event.data)); } catch { observeConnection(); failure(); }
      };
      socket.onerror = socket.onclose = () => {
        if (version !== connectionVersion) return;
        open = false;
        ready = false;
        transportFailed = true;
        if (latestRequest) latestRequest.active = false;
        clearTimers();
        observeConnection();
        failure();
      };
    } catch {
      observeConnection();
      failure();
    }
  }

  function beginScriptImport(token) {
    if (!open || !ready || pending || protectedFields().size > 0 || latestRequest?.active) return false;
    sendRequest('canvas:script', { token });
    return true;
  }

  function openUrl(url) {
    // Only the fixed project link and ChatGPT prompt integration may open externally.
    if (!open || typeof url !== 'string' || url.length > 16000
      || (url !== 'https://github.com/renaudcerrato/deckforge-commander'
        && !url.startsWith('https://chatgpt.com/?q='))) return false;
    try { socket.send(JSON.stringify({ event: 'openUrl', payload: { url } })); return true; }
    catch { return false; }
  }

  return { connect, edit, flush, disconnect, hydrate, getConnectionState, beginScriptImport, openUrl };
}
