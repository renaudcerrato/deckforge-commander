import { createInspectorBridge, RUN_ACTION_UUID, TIMER_ACTION_UUID, ONCE_ACTION_UUID } from './bridge.mjs';
import { DEFAULT_THEME_COLOR, normalizeThemeColor, resolveThemeColor } from '../core/theme.mjs';
import { MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS } from '../core/timer-settings.mjs';
import { getReadyTitle } from '../core/key-layout.mjs';

const REASONS = new Map([
  ['INVALID_EXECUTABLE', 'Choose an absolute executable path.'],
  ['INVALID_CWD', 'Use an absolute working directory.'],
  ['ARGS_TEXT_INVALID', 'Check argument quotes and escapes.'],
  ['ARGS_JSON_INVALID', 'Replace the invalid legacy arguments.'],
  ['ARGS_NOT_ARRAY', 'Replace the invalid legacy arguments.'],
  ['INVALID_ARGUMENT', 'Replace the invalid legacy arguments.'],
  ['INVALID_SETTINGS', 'Settings need correction.'],
  ['STATE_SAVE_FAILED', 'Settings could not be confirmed.'],
  ['THEME_COLOR_INVALID', 'Choose a six-digit hex theme color.'],
  ['INTERVAL_INVALID', 'Enter whole seconds from 1 to 86400.'],
  ['ACTION_ON_PRESS_INVALID', 'Choose start / refresh or start / stop.'],
  ['TITLE_INVALID', 'Use a title of at most 8192 characters without NUL.'],
  ['SCRIPT_IMPORT_FAILED', 'Script import could not be confirmed. Ask ChatGPT again or save the script locally.'],
]);

const INTERVAL_PRESETS = new Set(['1', '10', '30', '60', '600', '1800', '3600']);
const ACTION_DESCRIPTIONS = new Map([
  [RUN_ACTION_UUID, 'Stream — toggle a live program; stops when it exits.'],
  [TIMER_ACTION_UUID, 'Loop — repeat after completion and the configured delay.'],
  [ONCE_ACTION_UUID, 'Run — execute once and retain successful output.'],
]);

function scriptPrompt(token, binding) {
  const action = binding.bindingValid ? ACTION_DESCRIPTIONS.get(binding.actionUuid) : undefined;
  const setup = [];
  if (binding.os) setup.push(`- OS: ${binding.os}`);
  if (binding.deviceModel) setup.push(`- Device: ${binding.deviceModel}`);
  if (action) setup.push(`- Action: ${action}`);
  if (binding.coordinates) setup.push(`- Key position: column ${binding.coordinates.column}, row ${binding.coordinates.row} (zero-based).`);
  const size = binding.imageSize;
  const returnUrl = token ? `streamdeck://plugins/message/git.renaudcerrato.deckforge/import?token=${encodeURIComponent(token)}` : undefined;
  return `Help me create a script for a Stream Deck key using DeckForge Commander.
I’m not a developer: keep questions simple and setup instructions practical.
${setup.length ? `
## My setup
${setup.join('\n')}
` : ''}
## Display
- Supports text, cards, progress indicators, and images.
- Text, cards, and progress use a 144 × 144 logical canvas.
${size ? `- Physical key image: ${size.width} × ${size.height} pixels.\n` : ''}- Keep content readable on a small key.

## Start here
Ask what I want the key to display or do.
Choose a suitable scripting language and confirm its runtime is available.

## Protocol
Read:
https://github.com/renaudcerrato/deckforge-commander/blob/main/README.md#protocol
If web retrieval fails, try another available download method (such as curl), using the environment’s supported approval mechanism if network access is blocked, before asking me to paste the protocol. Do not guess the protocol.

## Deliver
${returnUrl ? `Provide the complete script and import URL.
Return URL: ${returnUrl}
Append individually URL-encoded parameters:
- source: complete script
- extension: file extension without the dot
- interpreter: absolute interpreter path, if required
- args: argument text, including {{script}} for the saved script path
- cwd: optional absolute working directory
- title: optional short, readable key title; omit to keep the current title, or leave empty to use the default
Provide the complete import URL on a single line inside a code block, with instructions to paste it into my browser’s address bar. This automatically saves a unique script file and configures the original key, even if its inspector is closed; it never runs the script. Ask me to review the source before using the URL, since scripts run with my permissions and are not sandboxed. Keep the complete URL under 2,000 characters. If it is too long, omit the URL and explain how to save the complete script to a local file and configure the key’s normal Executable, Arguments, and optional Working directory and Title fields.` : 'A return link is not available. Provide the complete script and explain how to save it to a local file and configure the key’s normal Executable, Arguments, and optional Working directory and Title fields; do not invent a return link.'}`;
}

function installChatGptLink(document, bridge) {
  document.getElementById('ask-chatgpt').addEventListener('click', event => {
    event.preventDefault();
    let token;
    try {
      token = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
    } catch { token = undefined; }
    const registered = token && bridge.beginScriptImport(token);
    const prompt = scriptPrompt(registered ? token : undefined, bridge.getConnectionState());
    // Never wait for the plugin reply before opening ChatGPT.
    const opening = bridge.openUrl(`https://chatgpt.com/?q=${encodeURIComponent(prompt)}`);
    if (!opening) document.getElementById('settings-status').textContent = 'The browser request could not be sent. Try the ChatGPT link again.';
    else if (!registered) document.getElementById('settings-status').textContent = 'ChatGPT requested. Automatic import is unavailable; use the local-file setup instructions.';
  });
}

function parseIntervalText(value) {
  if (typeof value !== 'string' || value.length === 0 || /[^0-9]/.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds >= MIN_INTERVAL_SECONDS && seconds <= MAX_INTERVAL_SECONDS
    ? seconds : undefined;
}

/** Direct non-bubbling listeners and synchronous hydration suppression are DOM-boundary seams. */
export function createInspectorController({
  executable, argsText, cwd, title, themeColor, status, bridge,
  intervalPreset, intervalSeconds, actionOnPress, timerControls, customInterval,
}) {
  let hydrating = false;
  let selectedExecutable = '';
  let selectedTheme = DEFAULT_THEME_COLOR;
  let timerBinding;
  let lastValidSeconds;
  let lastValidPolicy;
  let customSelected = false;
  let invalidIntervalText = false;
  let invalidPressPolicy = false;
  let bridgeStatus;
  let bridgeError;
  let statusBinding;
  const listeners = [];

  function assign(control, value) {
    if (!control) return;
    const previous = hydrating;
    hydrating = true;
    try { control.value = value; } finally { hydrating = previous; }
  }

  function updateTitlePlaceholder(platform = bridge.getConnectionState?.().platform) {
    if (!title) return;
    const placeholder = getReadyTitle(selectedExecutable, platform);
    if (title.getAttribute('placeholder') !== placeholder) {
      title.setAttribute('placeholder', placeholder);
      title.requestUpdate?.();
    }
  }

  /** A connection reset hides Timer immediately; stale snapshot UUIDs are not a binding. */
  function setActionBinding(snapshot) {
    updateTitlePlaceholder(snapshot?.platform);
    const placeholder = snapshot?.platform === 'win32'
      ? 'C:\\absolute\\path\\to\\working-directory' : '/absolute/path/to/working-directory';
    if (cwd && cwd.getAttribute('placeholder') !== placeholder) {
      // SDPI4 converts this attribute to LocalizedMessage; its property rejects strings.
      cwd.setAttribute('placeholder', placeholder);
      // Its pinned localized-message comparator may not schedule changed text.
      cwd.requestUpdate?.();
    }
    const enabled = snapshot?.bindingValid === true && snapshot.actionUuid === TIMER_ACTION_UUID;
    const same = enabled && timerBinding && timerBinding.version === snapshot.version
      && timerBinding.context === snapshot.context && timerBinding.inspectorId === snapshot.inspectorId;
    const sameStatusBinding = statusBinding && statusBinding.version === snapshot?.version
      && statusBinding.context === snapshot?.context && statusBinding.inspectorId === snapshot?.inspectorId
      && statusBinding.actionUuid === snapshot?.actionUuid;
    const resetStatus = (timerBinding && !same) || (snapshot?.bindingValid && statusBinding && !sameStatusBinding);
    if (snapshot?.bindingValid) {
      statusBinding = { version: snapshot.version, context: snapshot.context, inspectorId: snapshot.inspectorId, actionUuid: snapshot.actionUuid };
    }
    if (!same) {
      timerBinding = enabled ? { version: snapshot.version, context: snapshot.context, inspectorId: snapshot.inspectorId } : undefined;
      lastValidSeconds = undefined;
      lastValidPolicy = undefined;
      customSelected = false;
      invalidIntervalText = false;
      invalidPressPolicy = false;
      assign(actionOnPress, '');
      assign(intervalPreset, '');
      assign(intervalSeconds, '');
      if (customInterval) customInterval.hidden = true;
    }
    if (resetStatus) {
      bridgeStatus = bridgeError = undefined;
      renderStatus();
    }
    if (timerControls) timerControls.hidden = !enabled;
  }

  function syncActionBinding() {
    if (bridge.getConnectionState) setActionBinding(bridge.getConnectionState());
    return Boolean(timerBinding);
  }

  function showError(code) {
    bridgeError = REASONS.has(code) ? code : 'STATE_SAVE_FAILED';
    bridgeStatus = 'error';
    renderStatus();
  }

  function showStatus(value) {
    if (value === 'saved' || value === 'imported') bridgeError = undefined;
    if (value === 'saving' || value === 'saved' || value === 'error' || value === 'imported') bridgeStatus = value;
    renderStatus();
  }

  /** Local validity is an overlay, not an acknowledgment of a previously failed save. */
  function renderStatus() {
    status.textContent = invalidIntervalText ? REASONS.get('INTERVAL_INVALID')
      : invalidPressPolicy ? REASONS.get('ACTION_ON_PRESS_INVALID')
        : bridgeStatus === 'error' ? REASONS.get(bridgeError) ?? REASONS.get('STATE_SAVE_FAILED')
          : bridgeStatus === 'saving' ? 'Saving…' : bridgeStatus === 'imported' ? 'Script imported. Press the key to run.' : '';
  }

  function hydrateInterval(configuration, protectedFields) {
    if (!timerBinding || protectedFields.has('intervalSeconds')) return;
    lastValidSeconds = configuration.intervalSeconds;
    if (invalidIntervalText) { renderStatus(); return; }
    const value = lastValidSeconds === undefined ? '' : String(lastValidSeconds);
    const preset = !customSelected && INTERVAL_PRESETS.has(value) ? value : 'custom';
    assign(intervalPreset, preset);
    assign(intervalSeconds, value);
    if (customInterval) customInterval.hidden = preset !== 'custom';
  }

  function hydrate(configuration, protectedFields = new Set()) {
    syncActionBinding();
    if (!protectedFields.has('executable')) {
      selectedExecutable = configuration.executable;
      assign(executable, configuration.executable);
    }
    if (!protectedFields.has('argsText')) assign(argsText, configuration.argsText);
    if (!protectedFields.has('title')) assign(title, configuration.title);
    updateTitlePlaceholder();
    if (!protectedFields.has('cwd')) assign(cwd, configuration.cwd);
    if (themeColor && !protectedFields.has('themeColor')) {
      selectedTheme = resolveThemeColor(configuration.themeColor);
      assign(themeColor, selectedTheme);
    }
    hydrateInterval(configuration, protectedFields);
    if (timerBinding && !protectedFields.has('actionOnPress')) {
      const policy = configuration.actionOnPress;
      lastValidPolicy = policy === 'refresh' || policy === 'stop' ? policy : undefined;
      if (!invalidPressPolicy) assign(actionOnPress, lastValidPolicy ?? '');
    }
    if (configuration.diagnosticCode && !(configuration.diagnosticCode === 'ACTION_ON_PRESS_INVALID'
      && protectedFields.has('actionOnPress'))) showError(configuration.diagnosticCode);
  }

  function listen(control, callback, event = 'valuechange') {
    if (!control) return;
    const listener = () => { if (!hydrating) callback(); };
    control.addEventListener(event, listener);
    listeners.push(() => control.removeEventListener(event, listener));
  }

  listen(executable, () => {
    if (bridge.edit({ executable: executable.value }, { immediate: true })) {
      selectedExecutable = executable.value;
      updateTitlePlaceholder();
    } else {
      assign(executable, selectedExecutable);
    }
  });
  listen(argsText, () => bridge.edit({ argsText: argsText.value }));
  listen(cwd, () => bridge.edit({ cwd: cwd.value }));
  listen(title, () => bridge.edit({ title: title.value }));
  if (themeColor) {
    const changeTheme = () => {
      let color;
      try { color = normalizeThemeColor(themeColor.value); } catch { bridge.edit({ themeColor: themeColor.value }); return; }
      if (color === selectedTheme) return;
      if (bridge.edit({ themeColor: color })) selectedTheme = color;
    };
    listen(themeColor, changeTheme, 'input');
    listen(themeColor, changeTheme, 'change');
  }

  listen(actionOnPress, () => {
    if (!syncActionBinding()) return;
    const policy = actionOnPress.value;
    invalidPressPolicy = policy !== 'refresh' && policy !== 'stop';
    if (invalidPressPolicy) { renderStatus(); return; }
    if (policy !== lastValidPolicy && bridge.edit({ actionOnPress: policy }, { immediate: true })) {
      lastValidPolicy = policy;
    } else if (policy === lastValidPolicy) renderStatus();
  });

  listen(intervalPreset, () => {
    if (!syncActionBinding()) return;
    const value = intervalPreset.value;
    if (value === 'custom') {
      customSelected = true;
      invalidIntervalText = false;
      assign(intervalSeconds, lastValidSeconds === undefined ? '' : String(lastValidSeconds));
      if (customInterval) customInterval.hidden = false;
      renderStatus();
      return; // Local presentation choice only: never save a mode or a duration here.
    }
    if (!INTERVAL_PRESETS.has(value)) { invalidIntervalText = true; renderStatus(); return; }
    const seconds = parseIntervalText(value);
    customSelected = false;
    invalidIntervalText = false;
    if (customInterval) customInterval.hidden = true;
    if (seconds !== lastValidSeconds && bridge.edit({ intervalSeconds: seconds }, { immediate: true })) {
      lastValidSeconds = seconds;
    } else if (seconds === lastValidSeconds) renderStatus();
  });

  listen(intervalSeconds, () => {
    if (!syncActionBinding() || intervalPreset?.value !== 'custom') return;
    const seconds = parseIntervalText(intervalSeconds.value);
    customSelected = true;
    invalidIntervalText = seconds === undefined;
    if (invalidIntervalText) { renderStatus(); return; }
    if (seconds !== lastValidSeconds && bridge.edit({ intervalSeconds: seconds })) lastValidSeconds = seconds;
    else if (seconds === lastValidSeconds) renderStatus();
  });

  setActionBinding(bridge.getConnectionState?.());

  return { hydrate, showError, showStatus, setActionBinding, dispose: () => listeners.forEach(remove => remove()) };
}

function install(window, document) {
  let controller;
  let initial;
  let pendingError;
  let pendingStatus;
  let latestConnection;
  const bridge = createInspectorBridge({
    onConnectionState(snapshot) {
      // Deferred DOM hydration must not replay a previous bound session's error.
      if (latestConnection?.bindingValid && (!snapshot.bindingValid
        || latestConnection.version !== snapshot.version || latestConnection.context !== snapshot.context
        || latestConnection.inspectorId !== snapshot.inspectorId || latestConnection.actionUuid !== snapshot.actionUuid)) {
        pendingError = pendingStatus = undefined;
      }
      latestConnection = snapshot;
      controller?.setActionBinding(snapshot);
    },
    onSettings(configuration, protectedFields) {
      initial = { configuration, protectedFields };
      controller?.hydrate(configuration, protectedFields);
    },
    onError(code) { pendingError = code; controller?.showError(code); },
    onStatus(value) {
      pendingStatus = value;
      if (value === 'saved' || value === 'imported') pendingError = undefined;
      controller?.showStatus(value);
    },
  });
  latestConnection = bridge.getConnectionState();

  // Pinned SDPI4 controls have no setting bindings. Replace, rather than chain, its socket wrapper.
  window.connectElgatoStreamDeckSocket = bridge.connect;
  const ready = () => {
    document.getElementById('github-project').addEventListener('click', event => {
      event.preventDefault();
      bridge.openUrl('https://github.com/renaudcerrato/deckforge-commander');
    });
    installChatGptLink(document, bridge);
    controller = createInspectorController({
      executable: document.getElementById('executable'),
      argsText: document.getElementById('argsText'),
      cwd: document.getElementById('cwd'),
      title: document.getElementById('title'),
      themeColor: document.getElementById('themeColor'),
      intervalPreset: document.getElementById('intervalPreset'),
      intervalSeconds: document.getElementById('intervalSeconds'),
      actionOnPress: document.getElementById('actionOnPress'),
      timerControls: document.getElementById('timer-controls'),
      customInterval: document.getElementById('custom-interval'),
      status: document.getElementById('settings-status'),
      bridge,
    });
    controller.setActionBinding(latestConnection);
    if (initial) controller.hydrate(initial.configuration, initial.protectedFields);
    if (pendingError) controller.showError(pendingError);
    if (pendingStatus) controller.showStatus(pendingStatus);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true });
  else ready();
  window.addEventListener('unload', () => {
    controller?.dispose(); bridge.disconnect();
  }, { once: true });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') install(window, document);
