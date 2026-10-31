import {
  classifyTimerSettings, sameTimerExecutionSettings, sameTimerInterval, timerSettingsDiagnosticCode, readActionOnPress,
} from './timer-settings.mjs';
import { classifyOnceSettings, sameOnceExecutionSettings } from './once-settings.mjs';
import { settingsDiagnosticCode, sameSettingsExceptTitle } from './settings.mjs';
import { copySettings } from './settings-authority.mjs';
import { settingsThemeColor } from './theme.mjs';
import { getReadyTitle, getExecutableExtension } from './key-layout.mjs';
import { snapshotOutput } from './output-frame.mjs';
import { resolveOutputOptions } from './output-options.mjs';
import { createPrimitiveArtwork } from './primitive-artwork.mjs';
import { createLatestFrameQueue } from './latest-frame-queue.mjs';

export const CYCLE_HOLD_MS = 1_000;

/** Trusted factory policies, not persisted modes or user-supplied lifecycle callbacks. */
export const LOOP_CYCLE_POLICY = Object.freeze({
  repeat: true,
  dependencyError: 'Timer session dependencies must be functions.',
  classify: classifyTimerSettings,
  sameExecution: sameTimerExecutionSettings,
  sameInterval: sameTimerInterval,
  readPress: readActionOnPress,
  diagnosticCode: timerSettingsDiagnosticCode,
  preserveStoppedOutcome: false,
});
export const ONCE_CYCLE_POLICY = Object.freeze({
  repeat: false,
  dependencyError: 'Once session dependencies must be functions.',
  classify: classifyOnceSettings,
  sameExecution: sameOnceExecutionSettings,
  diagnosticCode: settingsDiagnosticCode,
  preserveStoppedOutcome: true,
});

const EXIT_DIAGNOSTICS = new Set(['PROCESS_EXITED_NONZERO', 'PROCESS_TERMINATED_BY_SIGNAL']);
const LAUNCH_REASONS = new Set([
  'PROCESS_LAUNCH_REASON_ENOENT', 'PROCESS_LAUNCH_REASON_EACCES', 'PROCESS_LAUNCH_REASON_ENOTDIR',
  'PROCESS_LAUNCH_REASON_ENOEXEC', 'PROCESS_LAUNCH_REASON_EAGAIN', 'PROCESS_LAUNCH_REASON_EINVAL',
  'PROCESS_LAUNCH_REASON_UNKNOWN',
]);
const ERROR_CODES = new Map([
  ['Invalid settings.', 'INVALID_SETTINGS'], ['Program launch failed.', 'PROCESS_LAUNCH_FAILED'],
  ['Program exited unsuccessfully.', undefined], ['Image protocol error.', 'IMAGE_PROTOCOL_ERROR'],
  ['Process cleanup uncertain.', 'CLEANUP_BLOCKED'], ['Frame send failed.', 'FRAME_SEND_FAILED'],
]);
const ERROR_PRIORITY = new Map([
  ['Program exited unsuccessfully.', 0], ['Invalid settings.', 1], ['Program launch failed.', 2],
  ['Frame send failed.', 3], ['Image protocol error.', 4], ['Process cleanup uncertain.', 5],
]);

/** Session-only intent. Configuration authority, process ownership and image handoff are injected. */
export function createCycleSession({
  startRun, setImage, setTitle, onError, awaitConfiguration, onPresentation = () => {},
  initialConnected = false, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  platform,
}, policy) {
  if (policy !== LOOP_CYCLE_POLICY && policy !== ONCE_CYCLE_POLICY) {
    throw new TypeError('Cycle session requires a trusted policy.');
  }
  if ([startRun, setImage, setTitle, onError, awaitConfiguration, onPresentation, now, setTimer, clearTimer]
    .some(callback => typeof callback !== 'function')) {
    throw new TypeError(policy.dependencyError);
  }

  let visible = false, connected = initialConnected === true, enabled = false;
  let phase = 'stopped';
  let cleanupBlocked = false, persistenceBlocked = false, protocolBlocked = false;
  let fatalError;
  let displayFailurePending = false;
  let configuration;
  let configurationRevision = 0, intentVersion = 0, launchVersion = 0;
  let displayVersion = 0, cosmeticVersion = 0, outcomeVersion = 0, outputVersion = 0;
  let generation, outcome, queue, gesture;
  let gestureVersion = 0, deadlineVersion = 0, deadlineTimer, dueMs;
  let intervalResetIntent;
  let presentation = 'none';
  let producerEnqueuedDisplay = -1, producerEnqueuedVersion = -1;
  let cosmeticEnqueuedDisplay = -1, cosmeticEnqueuedVersion = -1, cosmeticEnqueuedTheme = -1;
  let renderedDisplay = -1, renderedOutcome = -1, renderedCosmetics = -1;
  let renderedCaption, renderedExtension;
  let tail = Promise.resolve();

  function schedule(operation) {
    const pending = tail.then(operation, operation);
    tail = pending.catch(() => {});
    return pending;
  }

  function available() { return visible && connected; }
  function suspended() { return Boolean(fatalError || cleanupBlocked || persistenceBlocked || protocolBlocked); }
  function owns(run) { return generation === run && !run.finished; }
  function caption() { return getReadyTitle(configuration?.snapshot?.executable, platform, configuration?.snapshot?.title); }
  function executableExtension() { return getExecutableExtension(configuration?.validation?.execution.executable, platform); }
  function readyFooter() { return configuration?.setup ? 'setup required' : 'ready'; }
  function idleSetup() { return configuration?.setup && !enabled && !generation && phase === 'stopped'; }

  function cancelDeadline(preserveDue = false) {
    ++deadlineVersion;
    if (deadlineTimer !== undefined) clearTimer(deadlineTimer);
    deadlineTimer = undefined;
    if (!preserveDue) {
      dueMs = undefined;
      intervalResetIntent = undefined;
    }
  }

  function cancelGesture() {
    ++gestureVersion;
    if (gesture?.timer !== undefined) clearTimer(gesture.timer);
    gesture = undefined;
  }

  function retain(next) {
    outcome = next;
    ++outcomeVersion;
    presentation = next?.kind === 'output' ? 'streaming' : next?.kind ?? 'none';
  }

  function retainError(message, code, fatal = true) {
    const error = Object.freeze({ kind: 'error', message, code, fatal });
    if (fatal) {
      fatalError = error;
      intervalResetIntent = undefined;
    }
    retain(error);
  }

  function primitiveImage(update) {
    const options = resolveOutputOptions(update.kind, update.overrides, { color: settingsThemeColor(configuration?.snapshot) });
    return options ? createPrimitiveArtwork(Object.freeze({ ...update, options })) : undefined;
  }

  function imageFor(update) { return update.kind === 'image' ? update.image : primitiveImage(update); }

  function displayAllowed() {
    return available() && !cleanupBlocked && !persistenceBlocked;
  }

  function createDisplayQueue() {
    const display = displayVersion;
    return createLatestFrameQueue({
      async send(frame) {
        const decline = () => {
          if (frame.origin === 'cosmetic' && cosmeticEnqueuedDisplay === display
            && cosmeticEnqueuedVersion === frame.outputVersion
            && cosmeticEnqueuedTheme === frame.cosmeticVersion) {
            cosmeticEnqueuedDisplay = -1;
            cosmeticEnqueuedVersion = -1;
            cosmeticEnqueuedTheme = -1;
          }
          return false;
        };
        const current = () => display === displayVersion && displayAllowed()
          && frame.outputVersion === outputVersion && outcome?.kind === 'output'
          && (frame.origin !== 'cosmetic' || (frame.cosmeticVersion === cosmeticVersion
            && !suspended() && !generation?.terminal && !generation?.stopReason));
        if (!current()) return decline();
        await setTitle('', current);
        if (!current()) return decline();
        renderedDisplay = display;
        renderedOutcome = outcomeVersion;
        renderedCosmetics = cosmeticVersion;
        await setImage(frame.image, current);
        // Once attempted, this image is consumed, not an acknowledged renderer delivery.
        return true;
      },
      onError: () => {
        if (display === displayVersion && available()) void failDisplay();
      },
    });
  }

  function enqueueOutput(origin = 'producer') {
    if (!available() || outcome?.kind !== 'output' || !queue) return;
    if (origin === 'producer' && producerEnqueuedDisplay === displayVersion && producerEnqueuedVersion === outputVersion) return;
    if (origin === 'cosmetic' && cosmeticEnqueuedDisplay === displayVersion
      && cosmeticEnqueuedVersion === outputVersion && cosmeticEnqueuedTheme === cosmeticVersion) return;
    const image = imageFor(outcome.update);
    if (image === undefined) return;
    const accepted = queue.enqueue({ image, outputVersion, origin,
      ...(origin === 'cosmetic' ? { cosmeticVersion } : {}) });
    if (!accepted) return;
    if (origin === 'producer') {
      producerEnqueuedDisplay = displayVersion;
      producerEnqueuedVersion = outputVersion;
    } else {
      cosmeticEnqueuedDisplay = displayVersion;
      cosmeticEnqueuedVersion = outputVersion;
      cosmeticEnqueuedTheme = cosmeticVersion;
    }
  }

  async function publishOutcome() {
    const expected = outcome, version = outcomeVersion, display = displayVersion, cosmetics = cosmeticVersion;
    if (!available() || !expected) return;
    if (expected.kind === 'output') { enqueueOutput(); return; }
    const theme = settingsThemeColor(configuration?.snapshot), title = caption();
    const extension = expected.kind === 'error' ? undefined : executableExtension();
    if (renderedDisplay === display && renderedOutcome === version && renderedCosmetics === cosmetics
      && (expected.kind === 'error' || ((expected.footer === 'setup required' || renderedCaption === title)
        && renderedExtension === extension))) return;
    const current = () => available() && display === displayVersion && version === outcomeVersion
      && cosmetics === cosmeticVersion && outcome === expected
      && (expected.kind === 'error' || (configuration?.confirmed && !suspended()
        && (expected.footer === 'setup required' || title === caption()) && extension === executableExtension()
        && (expected.kind !== 'ready' || (expected.footer === 'setup required'
          ? idleSetup() : !configuration.setup && Boolean(configuration.validation)))));
    if (!current()) return;
    try {
      if (expected.kind === 'error') await onError(expected.message, expected.code, current, theme);
      else await onPresentation(expected.kind, title, current, theme, expected.footer ?? 'ready', extension);
      if (current()) {
        renderedDisplay = display;
        renderedOutcome = version;
        renderedCosmetics = cosmetics;
        if (expected.kind !== 'error') {
          renderedCaption = title;
          renderedExtension = extension;
        }
      }
    } catch {
      // Error-art failure also blocks retries; it must not silently restore Ready.
      if (current()) void failDisplay();
    }
  }

  function invalidateDisplay() {
    ++displayVersion;
    const old = queue;
    old?.dispose();
    queue = available() ? createDisplayQueue() : undefined;
    return old;
  }

  function latchCleanup() {
    cleanupBlocked = true;
    cancelDeadline();
    retainError('Process cleanup uncertain.', 'CLEANUP_BLOCKED');
  }

  function requestStop(run, reason) {
    if (!owns(run)) return Promise.resolve(!cleanupBlocked);
    run.stopReason ??= reason;
    run.active = false;
    run.stopping ??= Promise.resolve().then(() => run.runner.stop()).then(value => value === true, () => false);
    return run.stopping;
  }

  async function stopOwned(reason, drain = false) {
    const run = generation;
    if (!run || run.finished) return !cleanupBlocked;
    const frames = queue;
    if (!drain) frames?.dispose();
    const certain = await requestStop(run, reason);
    if (!certain) latchCleanup();
    await frames?.whenIdle();
    if (generation === run) {
      run.finished = true;
      generation = undefined;
    }
    return certain && !cleanupBlocked;
  }

  /** False/error on the latest snapshot is a safety failure; superseded results are simply stale. */
  function adoptSettings(input) {
    const previous = configuration;
    const previousCaption = caption();
    let snapshot, validation, diagnostic, setup = false;
    try {
      const classification = policy.classify(input, platform);
      snapshot = copySettings(input);
      setup = classification.kind === 'setup';
      if (!setup) validation = { execution: classification.execution,
        ...(policy.repeat ? { intervalSeconds: classification.intervalSeconds, actionOnPress: classification.actionOnPress } : {}) };
    } catch (error) {
      diagnostic = policy.diagnosticCode(error);
      try { snapshot = copySettings(input); } catch {}
    }
    const identical = previous && snapshot && setup === previous.setup && diagnostic === previous.diagnostic
      && JSON.stringify(snapshot) === JSON.stringify(previous.snapshot);
    if (identical) return { executionChanged: false, intervalChanged: false, themeChanged: false, titleOnly: false, captionChanged: false };
    const titleOnly = Boolean(previous && sameSettingsExceptTitle(previous.snapshot, snapshot));
    const executionChanged = Boolean(previous && (!snapshot || !previous.snapshot
      || !policy.sameExecution(previous.snapshot, snapshot, platform)));
    const intervalChanged = Boolean(policy.repeat && previous && (!snapshot || !previous.snapshot
      || !policy.sameInterval(previous.snapshot, snapshot)));
    const themeChanged = settingsThemeColor(previous?.snapshot) !== settingsThemeColor(snapshot);
    if (themeChanged) ++cosmeticVersion;
    const record = { snapshot, validation, setup, diagnostic, revision: ++configurationRevision, confirmed: false };
    configuration = record;
    record.confirmation = Promise.resolve().then(async () => {
      if (!snapshot || persistenceBlocked) return false;
      let confirmed = false;
      try { confirmed = (await awaitConfiguration(copySettings(snapshot))) === true; } catch {}
      if (configuration !== record) return false;
      if (!confirmed) {
        void persistenceFailed();
        return false;
      }
      record.confirmed = true;
      return true;
    });
    return { executionChanged, intervalChanged, themeChanged, titleOnly, captionChanged: previousCaption !== caption() };
  }

  async function confirmedCurrent() {
    // Await only the current authority operation, never a future deadline or runner completion.
    while (configuration) {
      const record = configuration;
      const confirmed = await record.confirmation;
      if (record !== configuration) continue;
      return confirmed && !persistenceBlocked;
    }
    return false;
  }

  function validConfiguration(allowSetup = false) {
    if (configuration?.validation) return true;
    if (allowSetup && idleSetup()) return true;
    cancelDeadline();
    retainError('Invalid settings.', configuration?.diagnostic ?? 'INVALID_SETTINGS');
    return false;
  }

  function fulfillIntervalReset(intent) {
    if (!policy.repeat || intervalResetIntent !== intent || intent !== intentVersion || !enabled || suspended() || generation
      || phase === 'starting' || phase === 'stopping' || !configuration?.confirmed || !configuration.validation) return false;
    intervalResetIntent = undefined;
    phase = 'waiting';
    dueMs = now() + configuration.validation.intervalSeconds * 1_000;
    return true;
  }

  function armDeadline() {
    if (!policy.repeat) return;
    cancelDeadline(true);
    if (!available() || !enabled || suspended() || generation || phase === 'starting'
      || !configuration?.confirmed || dueMs === undefined) return;
    const deadline = deadlineVersion, intent = intentVersion;
    const remaining = Math.max(0, dueMs - now());
    if (remaining === 0) { void beginLaunch(); return; }
    deadlineTimer = setTimer(() => {
      if (deadline !== deadlineVersion || intent !== intentVersion || !available() || !enabled || suspended()) return;
      deadlineTimer = undefined;
      void beginLaunch();
    }, remaining);
  }

  function codeFor(run, message) {
    if (message === 'Program launch failed.') return run.launchReason ?? 'PROCESS_LAUNCH_FAILED';
    if (message === 'Program exited unsuccessfully.') return run.exitDiagnostic;
    return ERROR_CODES.get(message);
  }

  function collectError(run, value) {
    if (!owns(run)) return;
    // Cleanup facts remain authoritative even after a manual stop/edit invalidated semantic intent.
    if (value === 'Process cleanup uncertain.') { latchCleanup(); return; }
    if (run.stopReason || run.intent !== intentVersion) return;
    const known = ERROR_CODES.has(value);
    const incoming = known ? value : 'Program exited unsuccessfully.';
    const message = (ERROR_PRIORITY.get(run.error) ?? -1) > ERROR_PRIORITY.get(incoming) ? run.error : incoming;
    run.error = message;
    run.unknownError ||= !known;
    run.active = false;
    phase = 'stopping';
    if (message === 'Image protocol error.') protocolBlocked = true;
    if (message !== 'Program exited unsuccessfully.' || !known) {
      fatalError = Object.freeze({ kind: 'error', message, code: codeFor(run, message), fatal: true });
      cancelDeadline();
    }
    // The owned terminal path publishes only after cleanup and accepted producer drain.
    if (message === 'Frame send failed.') void failDisplay();
  }

  function diagnostic(run, event) {
    if (!owns(run) || run.stopReason || run.intent !== intentVersion) return;
    if (LAUNCH_REASONS.has(event)) { run.launchReason ??= event; return; }
    if (EXIT_DIAGNOSTICS.has(event)) run.exitDiagnostic = event;
    if (event === 'PROCESS_LAUNCH_FAILED') collectError(run, 'Program launch failed.');
  }

  function acceptOutput(run, input) {
    const eligible = () => owns(run) && run.intent === intentVersion && run.active && !run.stopReason
      && !run.terminal && !cleanupBlocked && !persistenceBlocked && !protocolBlocked;
    if (!eligible()) return;
    const update = snapshotOutput(input);
    if (!update || imageFor(update) === undefined || !eligible()) return;
    run.acceptedOutput = true;
    ++run.outputVersion;
    ++outputVersion;
    // One latest bounded DTO, shared with the outcome; no per-completion history.
    retain(Object.freeze({ kind: 'output', update, cosmeticVersion }));
    enqueueOutput();
  }

  function complete(run, result) {
    if (!owns(run) || run.terminal) return;
    run.terminal = true;
    run.active = false;
    if (result?.status === 'error') collectError(run, result.error);
    if (run.stopReason || run.intent !== intentVersion) return;
    phase = 'stopping';
    void schedule(async () => {
      if (!owns(run) || run.stopReason || run.intent !== intentVersion) return;
      // done is the runner's cleanup-completed contract, not merely an OS exit callback.
      if (run.stopping && !(await run.stopping)) latchCleanup();
      await queue?.whenIdle();
      const confirmed = await confirmedCurrent();
      if (!owns(run) || run.stopReason || run.intent !== intentVersion) return;
      const success = result?.status === 'success' && !run.error;
      const ordinary = result?.status === 'error' && result.error === 'Program exited unsuccessfully.'
        && run.error === 'Program exited unsuccessfully.' && !run.unknownError && !fatalError && !protocolBlocked
        && EXIT_DIAGNOSTICS.has(run.exitDiagnostic);
      run.finished = true;
      generation = undefined;
      phase = 'stopped';
      // A one-shot consumes its transient request, not its successfully retained terminal outcome.
      if (!policy.repeat) enabled = false;
      if (cleanupBlocked) retainError('Process cleanup uncertain.', 'CLEANUP_BLOCKED');
      else if (persistenceBlocked || !confirmed) return;
      else if (!validConfiguration()) { /* Fixed configuration error has priority. */ }
      else if (!success) {
        const message = run.error ?? 'Program exited unsuccessfully.';
        retainError(message, codeFor(run, message), !ordinary);
      } else if (!run.acceptedOutput) retain({ kind: 'ready', footer: 'success' });
      if (success && run.acceptedOutput && !suspended()) {
        // Keep the producer already handed off. Do not replay its final frame on completion.
        if (outcome?.kind === 'output' && outcome.update.kind !== 'image'
          && outcome.cosmeticVersion !== cosmeticVersion) enqueueOutput('cosmetic');
      } else await publishOutcome();
      await queue?.whenIdle();
      if (!policy.repeat) return;
      const latestConfirmed = await confirmedCurrent();
      if (!latestConfirmed || !enabled || suspended() || run.intent !== intentVersion || generation
        || phase === 'starting' || phase === 'stopping' || !configuration?.validation) return;
      intervalResetIntent = undefined;
      phase = 'waiting';
      dueMs = now() + configuration.validation.intervalSeconds * 1_000;
      armDeadline();
    });
  }

  function rejectedCompletion(run) {
    if (!owns(run)) return;
    run.unknownError = true;
    run.active = false;
    phase = 'stopping';
    cancelDeadline();
    // Rejection proves no cleanup result. Stop without granting a natural completion fact.
    const stopping = requestStop(run);
    void schedule(async () => {
      const certain = await stopping;
      if (!certain) latchCleanup();
      if (!owns(run) || run.stopReason || run.intent !== intentVersion) return;
      if (!certain) {
        run.terminal = true;
        phase = 'stopped';
        await queue?.whenIdle();
        await publishOutcome();
        return;
      }
      // complete appends its terminal operation; do not await the same serial tail here.
      complete(run, { status: 'error', error: 'Program exited unsuccessfully.' });
    });
  }

  function startGeneration(execution, intent) {
    const run = { intent, active: true, terminal: false, finished: false, acceptedOutput: false, outputVersion: 0 };
    generation = run;
    // An ordinary prior Error remains displayed until valid output or this run's terminal result.
    phase = 'running';
    try {
      run.runner = startRun(execution, {
        onUpdate: update => acceptOutput(run, update),
        onError: message => collectError(run, message),
        onDiagnostic: event => diagnostic(run, event),
      });
      Promise.resolve(run.runner.done).then(
        result => complete(run, result),
        () => rejectedCompletion(run),
      );
    } catch {
      run.runner = { stop: async () => true };
      collectError(run, 'Program launch failed.');
      complete(run, { status: 'error', error: 'Program launch failed.' });
    }
  }

  function beginLaunch() {
    if (!available() || !enabled || suspended() || generation || phase === 'starting' || phase === 'stopping') return tail;
    intervalResetIntent = undefined;
    cancelDeadline(true);
    const attempt = ++launchVersion, intent = intentVersion;
    phase = 'starting';
    return schedule(async () => {
      const current = () => attempt === launchVersion && intent === intentVersion && available()
        && enabled && !suspended() && !generation;
      if (!(await confirmedCurrent()) || !current()) return;
      if (!validConfiguration()) { phase = 'stopped'; await publishOutcome(); return; }
      await queue?.whenIdle();
      if (!current()) return;
      if (!outcome || (outcome.kind === 'ready' && outcome.footer === 'ready')) {
        retain({ kind: 'waiting' });
        await publishOutcome();
      }
      if (!current()) return;
      // A theme/configuration edit can arrive during async presentation. Reconfirm before spawn.
      if (!(await confirmedCurrent()) || !current() || !validConfiguration()) return;
      dueMs = undefined;
      startGeneration(configuration.validation.execution, intent);
    });
  }

  function disable({ recover = false, drain = false } = {}) {
    enabled = false;
    ++intentVersion;
    ++launchVersion;
    cancelDeadline();
    cancelGesture();
    const intent = intentVersion;
    if (generation) generation.stopReason ??= 'intent';
    if (generation) void requestStop(generation, 'intent');
    phase = 'stopping';
    const oldFrames = !drain ? invalidateDisplay() : undefined;
    return schedule(async () => {
      await oldFrames?.whenIdle();
      const certain = await stopOwned('intent', drain);
      const confirmed = await confirmedCurrent();
      if (intent !== intentVersion) return;
      phase = 'stopped';
      if (recover && certain && confirmed && configuration?.validation && !cleanupBlocked && !persistenceBlocked) {
        fatalError = undefined;
        protocolBlocked = false;
        displayFailurePending = false;
      }
      if (cleanupBlocked) retainError('Process cleanup uncertain.', 'CLEANUP_BLOCKED');
      else if (persistenceBlocked) retainError('Run state save failed.', 'STATE_SAVE_FAILED');
      else if (fatalError) retain(fatalError);
      else if (!configuration?.snapshot) validConfiguration();
      else if (confirmed && validConfiguration(true)) retain({ kind: 'ready', footer: readyFooter() });
      if (available()) invalidateDisplay();
      await publishOutcome();
    });
  }

  function failDisplay() {
    if (displayFailurePending || cleanupBlocked || persistenceBlocked) return tail;
    displayFailurePending = true;
    fatalError = Object.freeze({ kind: 'error', message: 'Frame send failed.', code: 'FRAME_SEND_FAILED', fatal: true });
    cancelDeadline();
    ++launchVersion;
    const intent = intentVersion;
    queue?.dispose();
    if (generation) generation.stopReason ??= 'display';
    if (generation) void requestStop(generation, 'display');
    phase = 'stopping';
    return schedule(async () => {
      await stopOwned('display');
      if (intent !== intentVersion) return;
      phase = 'stopped';
      retain(fatalError);
      await publishOutcome();
    });
  }

  function persistenceFailed() {
    if (persistenceBlocked) return tail;
    persistenceBlocked = true;
    fatalError = Object.freeze({ kind: 'error', message: 'Run state save failed.', code: 'STATE_SAVE_FAILED', fatal: true });
    cancelDeadline();
    ++launchVersion;
    cancelGesture();
    if (generation) generation.stopReason ??= 'persistence';
    if (generation) void requestStop(generation, 'persistence');
    phase = 'stopping';
    invalidateDisplay();
    return schedule(async () => {
      await stopOwned('persistence');
      phase = 'stopped';
      if (cleanupBlocked) retainError('Process cleanup uncertain.', 'CLEANUP_BLOCKED');
      else retainError('Run state save failed.', 'STATE_SAVE_FAILED');
      await publishOutcome();
    });
  }

  function shortPress() {
    if (!available() || phase === 'stopping' || cleanupBlocked || persistenceBlocked) return tail;
    if (!policy.repeat && (generation || phase === 'starting')) return tail;
    if (idleSetup()) return tail;
    let actionOnPress;
    try { actionOnPress = policy.repeat ? policy.readPress(configuration?.snapshot) : 'refresh'; } catch { return tail; }
    if (enabled) {
      // Safety stops do not wait for a pending configuration confirmation or clear fatal errors.
      if (actionOnPress === 'stop') return disable();
      // Decide at recognition, before appending any operation: never defer an active Refresh tap.
      if (['starting', 'running'].includes(phase)) return tail;
    }
    if (suspended()) {
      const intent = ++intentVersion;
      ++launchVersion;
      cancelDeadline();
      if (!policy.repeat) phase = 'starting';
      return schedule(async () => {
        if (!(await confirmedCurrent()) || intent !== intentVersion || !available() || generation
          || cleanupBlocked || persistenceBlocked) return;
        if (!configuration?.validation) {
          if (!policy.repeat) phase = 'stopped';
          validConfiguration();
          await publishOutcome();
          return;
        }
        fatalError = undefined;
        protocolBlocked = false;
        displayFailurePending = false;
        enabled = true;
        phase = 'stopped';
        invalidateDisplay();
        retain(undefined);
        if (policy.repeat) dueMs = now();
        // Queue a launch without awaiting an operation appended to this same serial tail.
        void beginLaunch();
      });
    }
    enabled = true;
    ++intentVersion;
    if (policy.repeat) dueMs = now();
    return beginLaunch();
  }

  function keyDown() {
    if (!available() || gesture) return tail;
    const token = ++gestureVersion;
    const started = now();
    // Consume the entire setup gesture, even if configuration becomes valid before release.
    if (idleSetup()) { gesture = { token, started, held: false, suppressed: true }; return tail; }
    gesture = { token, started, held: false,
      shortIgnored: !policy.repeat && (Boolean(generation) || ['starting', 'running', 'stopping'].includes(phase)) };
    gesture.timer = setTimer(() => {
      if (!gesture || token !== gestureVersion || gesture.token !== token || !available()) return;
      gesture.held = true;
      // Preserve the held marker so duplicate downs/releases cannot turn a hold into a short press.
      const held = gesture;
      void disable();
      gesture = held;
      gesture.token = gestureVersion;
    }, CYCLE_HOLD_MS);
    return tail;
  }

  function keyUp() {
    if (!available() || !gesture) return tail;
    if (gesture.suppressed) { cancelGesture(); return tail; }
    const held = gesture.held || now() - gesture.started >= CYCLE_HOLD_MS;
    const alreadyHandled = gesture.held;
    const shortIgnored = gesture.shortIgnored;
    cancelGesture();
    if (held) return alreadyHandled ? tail : disable();
    if (shortIgnored) return tail;
    return shortPress();
  }

  function refreshAppearance() {
    if (!available()) return tail;
    if (outcome?.kind === 'output') {
      // Opaque images are restored only on availability return, never cosmetically replayed.
      if (outcome.update.kind !== 'image' && !suspended() && !generation?.terminal && !generation?.stopReason) {
        enqueueOutput('cosmetic');
      }
      return tail;
    }
    return schedule(async () => { await queue?.whenIdle(); await publishOutcome(); });
  }

  function applySettings(input) {
    const changes = adoptSettings(input);
    const record = configuration;
    const intent = intentVersion;
    if (changes.titleOnly) {
      // Do not reinterpret errors, output, pending starts, or deadlines for a caption edit.
      return schedule(async () => {
        if (!(await confirmedCurrent()) || record !== configuration) return;
        // Carry an earlier interval edit's pending reset through this newer snapshot.
        if (fulfillIntervalReset(intent)) armDeadline();
        if (!['ready', 'waiting'].includes(outcome?.kind)) return;
        await queue?.whenIdle();
        if (record === configuration) await publishOutcome();
      });
    }
    if (changes.executionChanged) {
      const suppressed = gesture?.suppressed ? gesture : undefined;
      const pending = disable({ recover: true });
      if (suppressed) gesture = { ...suppressed, token: gestureVersion };
      return pending;
    }
    if (changes.intervalChanged && !generation && phase !== 'starting') {
      cancelDeadline();
      if (enabled && !suspended() && phase !== 'stopping') intervalResetIntent = intentVersion;
    }
    if (changes.themeChanged) void refreshAppearance();
    return schedule(async () => {
      if (!(await confirmedCurrent())) {
        if (record === configuration && !record.snapshot) {
          validConfiguration();
          phase = 'stopped';
          await publishOutcome();
        }
        return;
      }
      if (record !== configuration) return;
      if (!configuration.validation && !idleSetup()) {
        if (generation || phase === 'starting') { void disable(); return; }
        validConfiguration();
        phase = 'stopped';
        await publishOutcome();
        return;
      }
      if (suspended()) return;
      if ((changes.themeChanged || changes.captionChanged) && outcome?.kind !== 'output') await publishOutcome();
      if (record !== configuration || !configuration.confirmed) return;
      if (fulfillIntervalReset(intent)) armDeadline();
      if (!enabled && !generation && phase === 'stopped') {
        if ((!policy.preserveStoppedOutcome || !outcome)
          && (outcome?.kind !== 'ready' || outcome.footer !== readyFooter())) retain({ kind: 'ready', footer: readyFooter() });
        await publishOutcome();
      }
    });
  }

  function reconcileAvailability() {
    if (!available()) { cancelDeadline(true); return tail; }
    const intent = intentVersion, display = displayVersion;
    return schedule(async () => {
      const confirmed = await confirmedCurrent();
      if (!available() || intent !== intentVersion || display !== displayVersion) return;
      if (!confirmed) {
        const safetyCode = cleanupBlocked ? 'CLEANUP_BLOCKED'
          : persistenceBlocked ? 'STATE_SAVE_FAILED' : undefined;
        if (safetyCode && !generation && phase !== 'stopping'
          && outcome?.kind === 'error' && outcome.code === safetyCode) {
          await publishOutcome();
        }
        return;
      }
      if (generation) {
        // A pre-done error is not a cleanup-completed terminal outcome. Do not publish it early.
        if (outcome?.kind === 'output') enqueueOutput();
        else await publishOutcome();
        return;
      }
      if (suspended()) { if (fatalError && outcome !== fatalError) retain(fatalError); await publishOutcome(); return; }
      if (!validConfiguration(true)) { await publishOutcome(); return; }
      if (!outcome && !enabled && !generation) retain({ kind: 'ready', footer: readyFooter() });
      if (outcome?.kind === 'output') enqueueOutput();
      else await publishOutcome();
      if (!policy.repeat) return;
      const latestConfirmed = await confirmedCurrent();
      if (!latestConfirmed || !available() || intent !== intentVersion || display !== displayVersion
        || !enabled || suspended() || generation || phase === 'starting' || phase === 'stopping'
        || !configuration?.validation) return;
      if (intervalResetIntent !== undefined && !fulfillIntervalReset(intent)) return;
      phase = 'waiting';
      dueMs ??= now();
      armDeadline();
    });
  }

  function appear(input) {
    const returning = !visible;
    visible = true;
    if (returning) invalidateDisplay();
    void applySettings(input);
    return reconcileAvailability();
  }

  function disappear() {
    if (!visible) return tail;
    visible = false;
    cancelGesture();
    cancelDeadline(true);
    ++launchVersion;
    const old = invalidateDisplay();
    if (!policy.repeat && !generation && (enabled || phase === 'starting')) {
      // Hiding a pending one-shot consumes it. Availability return is display-only.
      enabled = false;
      ++intentVersion;
      phase = 'stopped';
      if (outcome?.kind === 'waiting') retain({ kind: 'ready', footer: readyFooter() });
    } else if (phase === 'starting' && !generation) phase = enabled ? 'waiting' : 'stopped';
    // Owned processes may finish hidden. Only display work and future launches are paused.
    return schedule(async () => { await old?.whenIdle(); });
  }

  function setConnected(value) {
    const next = value === true;
    if (next === connected) return reconcileAvailability();
    connected = next;
    if (!connected) {
      cancelGesture();
      if (policy.preserveStoppedOutcome && !generation && !enabled && phase === 'stopped') {
        // A completed one-shot has no process or pending request to stop. Keep its local outcome.
        ++intentVersion;
        ++launchVersion;
        invalidateDisplay();
        return tail;
      }
      return disable();
    }
    invalidateDisplay();
    return reconcileAvailability();
  }

  async function whenIdle() {
    while (true) {
      const pending = tail, record = configuration, frames = queue;
      await pending;
      await record?.confirmation;
      await frames?.whenIdle();
      if (pending === tail && record === configuration && frames === queue) return;
    }
  }

  function getState() {
    return { enabled, phase, suspended: suspended(), visible, connected, cleanupBlocked, persistenceBlocked,
      protocolBlocked, presentation, dueMs, configurationPending: Boolean(configuration && !configuration.confirmed) };
  }

  return { appear, keyDown, keyUp, applySettings, disappear, setConnected, reconcileAvailability,
    persistenceFailed, refreshAppearance, whenIdle, getState };
}
