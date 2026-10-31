import { classifySettings, settingsDiagnosticCode, sameExecutionSettings, validateSettings } from './settings.mjs';
import { copyRunSettings } from './run-state.mjs';
import { createLatestFrameQueue } from './latest-frame-queue.mjs';
import { getReadyTitle, getExecutableExtension } from './key-layout.mjs';
import { settingsThemeColor } from './theme.mjs';
import { snapshotOutput } from './output-frame.mjs';
import { resolveOutputOptions } from './output-options.mjs';
import { createPrimitiveArtwork } from './primitive-artwork.mjs';

const SAFE_ERRORS = new Set([
  'Invalid settings.', 'Program launch failed.', 'Program exited unsuccessfully.',
  'Image protocol error.', 'Process cleanup uncertain.', 'Frame send failed.',
]);
const EXIT_DIAGNOSTICS = new Set(['PROCESS_EXITED_NONZERO', 'PROCESS_TERMINATED_BY_SIGNAL']);
const DRAINABLE_ERRORS = new Set(['Program exited unsuccessfully.', 'Image protocol error.']);
const TERMINAL_DIAGNOSTICS = new Set([...EXIT_DIAGNOSTICS, 'PROCESS_EXITED_SUCCESSFULLY', 'PROCESS_LAUNCH_FAILED']);
const LAUNCH_REASON_DIAGNOSTICS = new Set([
  'PROCESS_LAUNCH_REASON_ENOENT', 'PROCESS_LAUNCH_REASON_EACCES',
  'PROCESS_LAUNCH_REASON_ENOTDIR', 'PROCESS_LAUNCH_REASON_ENOEXEC',
  'PROCESS_LAUNCH_REASON_EAGAIN', 'PROCESS_LAUNCH_REASON_EINVAL', 'PROCESS_LAUNCH_REASON_UNKNOWN',
]);

/** Session-local intent, availability, and final-frame display have independent lifetimes. */
export function createActionSession({
  startRun, setImage, setTitle, onError, initialConnected = false, onPresentation = () => {},
  confirmLaunchSettings = async () => true,
  platform,
}) {
  if ([startRun, setImage, setTitle, onError, onPresentation, confirmLaunchSettings]
    .some(callback => typeof callback !== 'function')) {
    throw new TypeError('Action session dependencies must be functions.');
  }

  let visible = false;
  let connected = initialConnected === true;
  let requested = false;
  let phase = 'stopped';
  let protocolBlocked = false;
  let cleanupBlocked = false;
  let persistenceBlocked = false;
  let cleanupReported = false;
  let desiredSettings;
  let classification, configurationDiagnostic;
  let hasSettings = false;
  let generation;
  let startAttempt;
  let startProvenance;
  let intentVersion = 0;
  let displayVersion = 0;
  let presentationVersion = 0;
  let diagnosisVersion = 0;
  let editRecovery;
  let cosmeticVersion = 0;
  let cosmeticChanged = false;
  let captionChanged = false;
  let presentation = 'none';
  let presentationEpoch = -1;
  let readyCaption;
  let renderedExtension;
  let renderedTheme;
  let idleFooter = 'ready';
  let idleFooterRevision = 0;
  let renderedReadyFooter;
  let renderedReadyFooterRevision;
  let visualError;
  let stoppedPresentation;
  let tail = Promise.resolve();
  const queues = new Set();
  const errorDisplays = new Set();
  const presentations = new Set();

  function schedule(operation) {
    const result = tail.then(operation, operation);
    tail = result.catch(() => {});
    return result;
  }

  function available() { return visible && connected; }
  function ownsRun(run) { return generation === run && run.intentVersion === intentVersion; }
  function isSilentResume() {
    return requested && startProvenance?.intent === intentVersion && startProvenance.resuming;
  }
  function currentDisplay(run) {
    return available() && generation === run && run.displayValid && run.displayVersion === displayVersion;
  }

  function retainError(message, code, newFact = true, preserveProducer = false) {
    if (generation) {
      generation.latestPrimitive = undefined;
      generation.drainDiagnosis = undefined;
      if (!preserveProducer) generation.queue?.discardProducerFallback();
    }
    if (newFact) ++diagnosisVersion;
    visualError = { message, code };
    presentation = 'error';
    presentationEpoch = -1;
    ++presentationVersion;
  }

  function retainRunError(run, message, code) {
    // Retention is not publication. Only this owned terminal fact permits accepted output to drain.
    const drainable = DRAINABLE_ERRORS.has(message) && ownsRun(run) && currentDisplay(run) && !run.errorPublished
      && !run.displayFailed && !cleanupBlocked && !persistenceBlocked
      && [...run.errors].every(error => DRAINABLE_ERRORS.has(error));
    retainError(message, code, true, drainable);
    if (drainable) {
      run.drainDiagnosis = { error: visualError, version: diagnosisVersion };
    }
  }

  function mayDrain(run) {
    if (!ownsRun(run) || !currentDisplay(run) || run.displayFailed || cleanupBlocked || persistenceBlocked
      || run.errorPublished) return false;
    if (!visualError) return run.errors.size === 0;
    return run.drainDiagnosis?.error === visualError && run.drainDiagnosis.version === diagnosisVersion
      && [...run.errors].every(error => DRAINABLE_ERRORS.has(error));
  }

  function caption() {
    try { return getReadyTitle(Object.getOwnPropertyDescriptor(desiredSettings, 'executable')?.value,
      platform, Object.getOwnPropertyDescriptor(desiredSettings, 'title')?.value); } catch { return getReadyTitle(undefined, platform); }
  }

  function executableExtension() { return getExecutableExtension(classification?.execution?.executable, platform); }

  function resetIdleFooter() {
    idleFooter = 'ready';
    ++idleFooterRevision;
  }

  function readyFooter() { return classification?.kind === 'setup' ? 'setup required' : idleFooter; }

  async function publishPresentation(kind, version = displayVersion) {
    const footer = readyFooter();
    const footerRevision = idleFooterRevision;
    const eligible = () => available() && version === displayVersion && !visualError
      && footerRevision === idleFooterRevision
      && !protocolBlocked && !cleanupBlocked && !persistenceBlocked
      && (kind === 'ready' ? classification && footer === readyFooter()
        && !editRecovery && !requested && phase === 'stopped'
        : requested && phase === 'starting' && !isSilentResume());
    if (!eligible()) return false;
    const sequence = ++presentationVersion;
    const cosmetics = cosmeticVersion;
    const themeColor = settingsThemeColor(desiredSettings);
    const title = caption();
    const extension = executableExtension();
    const lifecycleCurrent = () => sequence === presentationVersion && eligible();
    const current = () => cosmetics === cosmeticVersion && (footer === 'setup required' || title === caption())
      && extension === executableExtension() && lifecycleCurrent();
    presentation = kind;
    let pending;
    try {
      pending = Promise.resolve(onPresentation(kind, title, current, themeColor, footer, extension));
      presentations.add(pending);
      await pending;
      if (!lifecycleCurrent()) return false;
      if (current()) {
        presentationEpoch = version;
        readyCaption = kind === 'ready' ? title : undefined;
        renderedExtension = extension;
        renderedTheme = themeColor;
        if (kind === 'ready') {
          renderedReadyFooter = footer;
          renderedReadyFooterRevision = footerRevision;
        }
      }
      // A cosmetic revision may supersede this drawing, not its pending Started authorization.
      return true;
    } catch {
      if (current()) {
        notify('Frame send failed.', 'FRAME_SEND_FAILED', version);
        return false;
      }
      return lifecycleCurrent();
    } finally { if (pending) presentations.delete(pending); }
  }

  async function showStopped(version = displayVersion) {
    if (!available() || version !== displayVersion || phase !== 'stopped') return;
    if (visualError) {
      if (presentation !== 'error' || presentationEpoch !== version) notify(visualError.message, visualError.code, version, undefined, false);
      return;
    }
    if (editRecovery || requested || protocolBlocked || cleanupBlocked || persistenceBlocked) return;
    if (!classification) {
      notify('Invalid settings.', configurationDiagnostic ?? 'INVALID_SETTINGS', version);
      return;
    }
    if (presentation === 'ready' && presentationEpoch === version && (readyFooter() === 'setup required' || readyCaption === caption())
      && renderedExtension === executableExtension()
      && renderedTheme === settingsThemeColor(desiredSettings) && renderedReadyFooter === readyFooter()
      && renderedReadyFooterRevision === idleFooterRevision) return;
    await publishPresentation('ready', version);
  }

  function reconcileStoppedPresentation() {
    if (!available() || (requested && !visualError) || phase !== 'stopped') return tail;
    const version = displayVersion;
    const title = caption();
    const extension = executableExtension();
    const footer = readyFooter(), footerRevision = idleFooterRevision;
    if (stoppedPresentation?.version === version && stoppedPresentation.title === title
      && stoppedPresentation.extension === extension
      && stoppedPresentation.footer === footer && stoppedPresentation.footerRevision === footerRevision) return tail;
    const job = { version, title, extension, footer, footerRevision };
    stoppedPresentation = job;
    return schedule(async () => {
      try {
        await generation?.queue.whenIdle();
        await showStopped(version);
      } finally { if (stoppedPresentation === job) stoppedPresentation = undefined; }
    });
  }

  function notify(message, code, version = displayVersion, run, newFact = true) {
    const active = () => available() && version === displayVersion && (!run || currentDisplay(run));
    if (!active()) return;
    retainError(message, code, newFact);
    if (generation && currentDisplay(generation)) generation.errorPublished = true;
    const sequence = presentationVersion;
    const cosmetics = cosmeticVersion;
    const themeColor = settingsThemeColor(desiredSettings);
    const current = () => cosmetics === cosmeticVersion && sequence === presentationVersion && active();
    presentationEpoch = version;
    try {
      renderedTheme = themeColor;
      const pending = Promise.resolve(onError(message, code, current, themeColor)).catch(() => {});
      errorDisplays.add(pending);
      void pending.then(() => errorDisplays.delete(pending));
    } catch {}
  }

  function primitiveImage(update) {
    const options = resolveOutputOptions(update.kind, update.overrides, { color: settingsThemeColor(desiredSettings) });
    if (!options) return undefined;
    return createPrimitiveArtwork(Object.freeze({ ...update, options }));
  }

  function redrawPrimitive() {
    const run = generation;
    const update = run?.latestPrimitive;
    const outputVersion = run?.outputVersion;
    const cosmetics = cosmeticVersion;
    const eligible = () => run && currentDisplay(run) && run.executionActive && phase === 'running'
      && requested && !visualError && !protocolBlocked && !cleanupBlocked && !persistenceBlocked
      && run.latestPrimitive === update && run.outputVersion === outputVersion && cosmeticVersion === cosmetics;
    if (!update || !eligible()) return;
    const image = primitiveImage(update);
    if (image === undefined || !eligible()) return;
    run.queue.enqueue({ image, outputVersion, cosmeticVersion: cosmetics, origin: 'cosmetic' });
  }

  /** Cosmetics redraw built-ins or the owned latest primitive, never opaque producer imagery. */
  async function redrawAppearance(captionOnly = false) {
    if (!captionOnly) redrawPrimitive();
    const kind = presentation;
    if (captionOnly && (kind === 'error' || readyFooter() === 'setup required')) return;
    if (!available() || !['ready', 'waiting', 'error'].includes(kind)
      || (kind !== 'error' && isSilentResume())) return;
    const display = displayVersion, sequence = presentationVersion, cosmetics = cosmeticVersion;
    const diagnosis = visualError;
    const themeColor = settingsThemeColor(desiredSettings);
    const title = caption();
    const extension = kind === 'error' ? undefined : executableExtension();
    const footer = readyFooter(), footerRevision = idleFooterRevision;
    const current = () => available() && display === displayVersion && sequence === presentationVersion
      && cosmetics === cosmeticVersion && presentation === kind
      && (kind === 'error' ? visualError === diagnosis
        : !isSilentResume() && footerRevision === idleFooterRevision && footer === readyFooter()
          && (footer === 'setup required' || title === caption())
          && extension === executableExtension()
          && !visualError && !protocolBlocked && !cleanupBlocked && !persistenceBlocked
           && (kind === 'ready' ? classification && !editRecovery && !requested && phase === 'stopped'
            : requested && ['starting', 'running'].includes(phase)
              && !(generation?.streaming && currentDisplay(generation))));
    let pending;
    try {
      await generation?.queue.whenIdle();
      if (!current()) return;
      if (kind === 'error' && generation && currentDisplay(generation)) generation.errorPublished = true;
      pending = Promise.resolve(kind === 'error'
        ? onError(diagnosis.message, diagnosis.code, current, themeColor)
        : onPresentation(kind, title, current, themeColor, footer, extension));
      presentations.add(pending);
      await pending;
      if (!current()) return;
      renderedTheme = themeColor;
      presentationEpoch = display;
      if (kind === 'ready') {
        readyCaption = title;
        renderedExtension = extension;
        renderedReadyFooter = footer;
        renderedReadyFooterRevision = footerRevision;
      }
    } catch {
      if (!current()) return;
      const run = generation;
      if (run?.executionActive && ownsRun(run) && currentDisplay(run)) displayFailed(run);
      else notify('Frame send failed.', 'FRAME_SEND_FAILED', display);
    } finally { if (pending) presentations.delete(pending); }
  }

  function refreshAppearance(captionOnly = false) {
    const pending = redrawAppearance(captionOnly);
    presentations.add(pending);
    void pending.then(() => presentations.delete(pending), () => presentations.delete(pending));
    return pending;
  }

  function updateSettings(input) {
    classification = undefined;
    configurationDiagnostic = undefined;
    try { classification = classifySettings(input, platform); } catch (error) { configurationDiagnostic = settingsDiagnosticCode(error); }
    let next;
    try { next = copyRunSettings(input); } catch { next = input; }
    const previousTheme = settingsThemeColor(desiredSettings);
    const previousCaption = caption();
    cosmeticChanged = previousTheme !== settingsThemeColor(next);
    if (cosmeticChanged) ++cosmeticVersion;
    let unchangedSnapshot = false;
    if (hasSettings) {
      try {
        // Identical unconfigured/invalid JSON snapshots are not execution edits.
        // Copy first so comparison cannot invoke accessors on external input.
        unchangedSnapshot = JSON.stringify(copyRunSettings(desiredSettings)) === JSON.stringify(copyRunSettings(next));
      } catch {}
    }
    const changed = hasSettings && !unchangedSnapshot && !sameExecutionSettings(desiredSettings, next, platform);
    desiredSettings = next;
    captionChanged = previousCaption !== caption();
    hasSettings = true;
    return changed;
  }

  function invalidateDisplay() {
    if (!generation) return;
    generation.displayValid = false;
    generation.executionActive = false;
    generation.latestPrimitive = undefined;
    generation.queue.dispose();
  }

  function latchCleanup() {
    cleanupBlocked = true;
    retainError('Process cleanup uncertain.', 'CLEANUP_BLOCKED');
    if (cleanupReported) return;
    cleanupReported = true;
    notify('Process cleanup uncertain.', 'CLEANUP_BLOCKED');
  }

  function requestRunStop(run, reason) {
    run.stopRequested = true;
    if (!run.stopReason || reason === 'intent') run.stopReason = reason;
    run.executionActive = false;
    run.latestPrimitive = undefined;
    run.stopping ??= Promise.resolve().then(() => run.run.stop()).then(value => value === true, () => false);
    return run.stopping;
  }

  async function stopGeneration(reason) {
    const run = generation;
    if (!run) return !cleanupBlocked;
    run.displayValid = false;
    run.queue.dispose();
    const certain = await requestRunStop(run, reason);
    if (!certain) latchCleanup();
    await run.queue.whenIdle();
    queues.delete(run.queue);
    // Retain identity until replacement: an already-completed natural result can still arrive while paused.
    return certain;
  }

  function rememberStopped(run) {
    if (run.intentStopped) return;
    run.intentStopped = true;
    requested = false;
    startProvenance = undefined;
    run.executionActive = false;
    run.intentVersion = ++intentVersion;
  }

  function errorCode(run) {
    if (run.errors.has('Process cleanup uncertain.')) return 'CLEANUP_BLOCKED';
    if (run.errors.has('Image protocol error.')) return 'IMAGE_PROTOCOL_ERROR';
    if (run.errors.has('Frame send failed.')) return 'FRAME_SEND_FAILED';
    if (run.errors.has('Program launch failed.')) return run.launchReason ?? 'PROCESS_LAUNCH_FAILED';
    return run.exitDiagnostic;
  }

  function addError(run, value) {
    const message = SAFE_ERRORS.has(value) ? value : 'Program exited unsuccessfully.';
    run.errors.add(message);
    if (message === 'Image protocol error.') protocolBlocked = true;
    if (message === 'Process cleanup uncertain.') cleanupBlocked = true;
    retainRunError(run, message, errorCode(run));
  }

  function collectError(run, value) {
    if (!ownsRun(run) || !currentDisplay(run)) return;
    addError(run, value);
    run.failureRemembered = true;
    if (!run.completed) phase = 'stopping';
    rememberStopped(run);
  }

  function reconcileOwnedPausedError(run) {
    if (!ownsRun(run) || run.stopReason !== 'availability'
      || (run.errors.size === 0 && !EXIT_DIAGNOSTICS.has(run.exitDiagnostic)) || currentDisplay(run)) return;
    // An availability resume uses the same semantic intent until a replacement starts.
    // A terminal fact from that still-owned runner cancels its pending availability resume.
    // Preserve actual Stopping until cleanup settles; Starting means that cleanup already returned.
    if (phase === 'starting') {
      startAttempt = undefined;
      phase = 'stopped';
    }
    const intent = intentVersion;
    const display = displayVersion;
    void schedule(async () => {
      await run.stopping;
      if (!ownsRun(run) || intent !== intentVersion || display !== displayVersion) return;
      if (phase === 'starting' || phase === 'stopping') {
        startAttempt = undefined;
        phase = 'stopped';
      }
      await run.queue.whenIdle();
      if (!ownsRun(run) || intent !== intentVersion || display !== displayVersion) return;
      if (cleanupBlocked && visualError?.code !== 'CLEANUP_BLOCKED') retainError('Process cleanup uncertain.', 'CLEANUP_BLOCKED');
      await showStopped(display);
    });
  }

  function completed(run, result) {
    if (!ownsRun(run) || run.completed) return;
    run.completed = true;
    run.executionActive = false;
    run.latestPrimitive = undefined;
    if (run.stopReason === 'intent' || run.displayFailed) return;
    // Pause-induced stop/protocol callbacks are stale; a verified natural terminal result is not a retry intent.
    const knownLaunchFailure = result?.status === 'error' && result.error === 'Program launch failed.';
    if (run.stopReason === 'availability' && result?.status !== 'success'
      && !run.terminalObserved && !run.failureRemembered && !knownLaunchFailure) return;
    if (result?.status === 'error') addError(run, result.error);
    rememberStopped(run);
    const intent = intentVersion;
    const footerRevision = idleFooterRevision;
    const naturalSuccess = result?.status === 'success'
      || (result?.status === 'stopped' && run.stopReason === 'availability' && run.naturalSuccessObserved);
    if (!run.stopRequested) phase = 'stopped';
    reconcileOwnedPausedError(run);
    const version = run.displayVersion;
    void schedule(async () => {
      const certain = naturalSuccess && run.stopping ? await run.stopping : true;
      await run.queue.whenIdle();
      queues.delete(run.queue);
      // Retain a still-owned natural success even while hidden, but never publish through a stale display.
      if (naturalSuccess && certain && ownsRun(run) && intent === intentVersion
        && footerRevision === idleFooterRevision && run.stopReason !== 'intent'
        && !requested && !editRecovery && !visualError && !protocolBlocked && !cleanupBlocked
        && !persistenceBlocked && !run.displayFailed && run.errors.size === 0) {
        if (run.stopReason === 'availability' && ['starting', 'stopping'].includes(phase)) {
          startAttempt = undefined;
          phase = 'stopped';
        }
        if (phase === 'stopped') {
          idleFooter = 'exited';
          ++idleFooterRevision;
          await showStopped(displayVersion);
          return;
        }
      }
      if (!currentDisplay(run) || persistenceBlocked || run.displayFailed) return;
      if (run.errors.size > 0) notify([...run.errors].at(-1), errorCode(run), version, run);
      else if (result?.status === 'success') await showStopped(version);
    });
  }

  function displayFailed(run) {
    if (!ownsRun(run) || !currentDisplay(run) || run.displayFailed) return;
    run.displayFailed = true;
    collectError(run, 'Frame send failed.');
    const stopping = requestRunStop(run, 'error');
    phase = 'stopping';
    const version = run.displayVersion;
    void schedule(async () => {
      const certain = await stopping;
      if (!certain) {
        cleanupBlocked = true;
        run.errors.add('Process cleanup uncertain.');
        retainError('Process cleanup uncertain.', 'CLEANUP_BLOCKED');
      }
      await run.queue.whenIdle();
      if (!currentDisplay(run) || persistenceBlocked) return;
      phase = 'stopped';
      notify(certain ? 'Frame send failed.' : 'Process cleanup uncertain.', errorCode(run), version, run);
    });
  }

  function diagnostic(run, event) {
    if (!ownsRun(run) || run.stopReason === 'intent') return;
    if (LAUNCH_REASON_DIAGNOSTICS.has(event)) {
      // Display-only enrichment: never change intent, phase, configuration, or retry eligibility.
      run.launchReason ??= event;
      if (run.errors.has('Program launch failed.') && errorCode(run) === run.launchReason) {
        retainError('Program launch failed.', run.launchReason);
      }
      return;
    }
    if (!TERMINAL_DIAGNOSTICS.has(event)) return;
    if (event === 'PROCESS_EXITED_SUCCESSFULLY') run.naturalSuccessObserved = true;
    if (EXIT_DIAGNOSTICS.has(event)) run.exitDiagnostic = event;
    // A pre-spawn error may complete as "stopped" after an availability pause.
    // Its owned launch-failure diagnostic still proves that it must not retry.
    if (event === 'PROCESS_LAUNCH_FAILED') run.errors.add('Program launch failed.');
    if (event === 'PROCESS_LAUNCH_FAILED') retainError('Program launch failed.', errorCode(run));
    else if (EXIT_DIAGNOSTICS.has(event)) retainRunError(run, 'Program exited unsuccessfully.', event);
    run.terminalObserved = true;
    run.latestPrimitive = undefined;
    rememberStopped(run);
    if (!run.stopRequested && !run.failureRemembered) phase = 'stopped';
    reconcileOwnedPausedError(run);
  }

  function startGeneration(execution, intent, display) {
    const run = {
      intentVersion: intent, displayVersion: display, displayValid: true, executionActive: true,
      completed: false, stopRequested: false, errors: new Set(), run: undefined, queue: undefined,
      outputVersion: 0, latestPrimitive: undefined,
      drainDiagnosis: undefined, errorPublished: false,
    };
    generation = run;
    run.queue = createLatestFrameQueue({
      async send(update) {
        // Only producer frames terminal-drain; cosmetic replays require an actively running primitive.
        const current = () => mayDrain(run)
          && update.outputVersion === run.outputVersion
          && (update.origin !== 'cosmetic' || (run.executionActive && phase === 'running' && requested
            && !visualError && !protocolBlocked && run.latestPrimitive !== undefined))
          && (update.cosmeticVersion === undefined || update.cosmeticVersion === cosmeticVersion
            || (!run.executionActive && update.origin !== 'cosmetic'));
        if (!current()) return false;
        if (!run.streaming) {
          run.streaming = true;
          if (!visualError) {
            presentation = 'streaming';
            presentationEpoch = displayVersion;
            ++presentationVersion;
          }
        }
        await setTitle('', current);
        if (!current()) return false;
        await setImage(update.image, current);
        // This is a local handoff, not a renderer acknowledgement. Do not replay an attempted frame.
        return true;
      },
      onError: () => displayFailed(run),
    });
    queues.add(run.queue);
    try {
      run.run = startRun(execution, {
        onUpdate(update) {
          const eligible = () => currentDisplay(run) && run.executionActive && !visualError
            && !protocolBlocked && !cleanupBlocked && !persistenceBlocked;
          if (!eligible()) return;
          const snapshot = snapshotOutput(update);
          if (!snapshot) return;
          const image = snapshot.kind === 'image' ? snapshot.image : primitiveImage(snapshot);
          if (image === undefined || !eligible()) return;
          run.latestPrimitive = snapshot.kind === 'image' ? undefined : snapshot;
          const outputVersion = ++run.outputVersion;
          run.queue.enqueue({ image, outputVersion, origin: 'producer',
            ...(snapshot.kind === 'image' ? {} : { cosmeticVersion }) });
        },
        onError: message => collectError(run, message),
        onDiagnostic: event => diagnostic(run, event),
      });
      if (currentDisplay(run) && run.executionActive && !run.failureRemembered) phase = 'running';
      Promise.resolve(run.run.done).then(
        result => completed(run, result),
        () => completed(run, { status: 'error', error: 'Program exited unsuccessfully.' }),
      );
    } catch {
      run.run = { stop: async () => true };
      collectError(run, 'Program launch failed.');
      completed(run, { status: 'error', error: 'Program launch failed.' });
    }
  }

  function completeExecutionRecovery(recovery) {
    if (editRecovery !== recovery || recovery.intent !== intentVersion || requested) return;
    if (cleanupBlocked || persistenceBlocked || recovery.diagnosis !== diagnosisVersion
      || !sameExecutionSettings(recovery.settings, desiredSettings, platform)) {
      editRecovery = undefined;
      return;
    }
    editRecovery = undefined;
    // Partial setup cannot establish executable recovery or displace a retained error/latch.
    if (classification?.kind === 'setup' && (visualError || protocolBlocked)) return;
    protocolBlocked = false;
    visualError = undefined;
    presentation = 'none';
    presentationEpoch = -1;
    readyCaption = undefined;
    ++presentationVersion;
    if (!classification) retainError('Invalid settings.', configurationDiagnostic ?? 'INVALID_SETTINGS');
  }

  async function confirmExecutionRecovery(recovery) {
    const current = () => editRecovery === recovery && recovery.intent === intentVersion && !requested;
    const eligible = () => !cleanupBlocked && !persistenceBlocked && recovery.diagnosis === diagnosisVersion
      && sameExecutionSettings(recovery.settings, desiredSettings, platform);
    while (current()) {
      if (!eligible()) { completeExecutionRecovery(recovery); return; }
      const settings = desiredSettings;
      let confirmed = false;
      try { confirmed = await confirmLaunchSettings(copyRunSettings(settings)); } catch {
        if (current()) void persistenceFailed();
        return;
      }
      if (!current()) return;
      if (!eligible()) { completeExecutionRecovery(recovery); return; }
      // Cosmetic edits may supersede the complete snapshot without superseding execution recovery.
      if (settings !== desiredSettings) continue;
      if (confirmed) completeExecutionRecovery(recovery);
      return;
    }
  }

  function stopForIntent(diagnosticCode, recoverExecution = false) {
    resetIdleFooter();
    requested = false;
    startAttempt = undefined;
    startProvenance = undefined;
    const intent = ++intentVersion;
    const display = ++displayVersion;
    invalidateDisplay();
    phase = 'stopping';
    const recovery = recoverExecution
      ? { intent, settings: desiredSettings, diagnosis: diagnosisVersion }
      : undefined;
    editRecovery = recovery;
    return schedule(async () => {
      const certain = await stopGeneration('intent');
      if (display === displayVersion || (recovery && editRecovery === recovery && intent === intentVersion)) phase = 'stopped';
      if (recovery && editRecovery === recovery && intent === intentVersion) {
        if (certain && !cleanupBlocked && !persistenceBlocked) await confirmExecutionRecovery(recovery);
        else editRecovery = undefined;
        // Unconfirmed/stale execution readback remains pending; availability cannot unlock Ready.
        if (editRecovery === recovery) return;
        await showStopped(displayVersion);
        return;
      }
      if (diagnosticCode && !persistenceBlocked) notify('Invalid settings.', diagnosticCode, display);
      else await showStopped(display);
    });
  }

  function prepareStart() {
    if (!classification) return stopForIntent(configurationDiagnostic ?? 'INVALID_SETTINGS');
    let execution;
    try { execution = validateSettings(desiredSettings, platform); } catch (error) {
      return stopForIntent(settingsDiagnosticCode(error));
    }
    const intent = intentVersion;
    // An entered Start belongs to this intent even before configuration confirmation or spawn completes.
    // Initial unavailability alone never establishes resume provenance.
    const showWaiting = startProvenance?.intent !== intent;
    startProvenance = { intent, resuming: !showWaiting };
    const display = ++displayVersion;
    const wasStopping = phase === 'stopping';
    invalidateDisplay();
    startAttempt = { intent, display };
    if (!wasStopping) phase = 'starting';
    if (!wasStopping && showWaiting) visualError = undefined;
    // Only first starts show Loading. Resumes leave the host untouched until fresh output or a terminal fact.
    const earlyWaiting = showWaiting && !wasStopping ? publishPresentation('waiting', display) : undefined;
    return schedule(async () => {
      await stopGeneration('availability');
      if (intent !== intentVersion || display !== displayVersion || !available() || !requested) return;
      if (protocolBlocked || cleanupBlocked || persistenceBlocked) { phase = 'stopped'; return; }
      phase = 'starting';
      if (wasStopping && showWaiting) visualError = undefined;
      if (showWaiting) {
        const waiting = await (earlyWaiting ?? publishPresentation('waiting', display));
        if (!available() || intent !== intentVersion || display !== displayVersion || !requested) return;
        if (!waiting) {
          if (visualError) void stopForIntent();
          return;
        }
      }
      if (protocolBlocked || cleanupBlocked || persistenceBlocked) { phase = 'stopped'; return; }
      await startConfirmedGeneration(execution, intent, display);
    });
  }

  async function startConfirmedGeneration(execution, intent, display) {
    const current = () => available() && intent === intentVersion && display === displayVersion && requested;
    while (current()) {
      const settings = desiredSettings;
      let confirmed = false;
      try {
        confirmed = await confirmLaunchSettings(copyRunSettings(settings));
      } catch { /* Confirmation failures use the existing fixed persistence error. */ }
      if (!current()) return false;
      if (protocolBlocked || cleanupBlocked || persistenceBlocked || visualError) {
        if (visualError && !persistenceBlocked) void stopForIntent();
        return false;
      }
      // A newer local configuration supersedes this wait, not the pending Start.
      if (settings !== desiredSettings) continue;
      if (!confirmed) {
        void persistenceFailed();
        return false;
      }
      // Launch synchronously with the final checks: no additional await can admit a stale Start.
      startGeneration(execution, intent, display);
      return true;
    }
    return false;
  }

  function pause() {
    // Arm suppression before appear can refresh cosmetics from a retained built-in.
    if (requested && startProvenance?.intent === intentVersion) {
      startProvenance = { intent: intentVersion, resuming: true };
    }
    startAttempt = undefined;
    const display = ++displayVersion;
    invalidateDisplay();
    if (generation && !generation.stopReason) generation.stopReason = 'availability';
    phase = 'stopping';
    return schedule(async () => {
      await stopGeneration('availability');
      if (display === displayVersion) phase = 'stopped';
    });
  }

  function reconcileAvailability() {
    if (!available()) {
      if (phase === 'starting' || generation?.executionActive) return pause();
      return tail;
    }
    if (!requested || protocolBlocked || cleanupBlocked || persistenceBlocked) return reconcileStoppedPresentation();
    if (startAttempt?.intent === intentVersion && startAttempt.display === displayVersion) return tail;
    if (phase === 'starting' || (phase === 'running' && generation && currentDisplay(generation))) return tail;
    return prepareStart();
  }

  function setConnected(value) {
    const next = value === true;
    if (next === connected) return reconcileAvailability();
    connected = next;
    if (!connected) return pause();
    return reconcileAvailability();
  }

  function appear(settings) {
    const changed = updateSettings(settings);
    visible = true;
    if (changed) return stopForIntent(undefined, true);
    if (cosmeticChanged || captionChanged) void refreshAppearance(!cosmeticChanged);
    return reconcileAvailability();
  }

  function press(settings) {
    // Late key events must not manufacture visibility or bypass a disconnected owning device.
    if (!available() || phase === 'stopping') return tail;
    if (arguments.length > 0) updateSettings(settings);
    // Partial setup is display-only, including when an existing error/recovery outranks it.
    if (!requested && phase === 'stopped' && classification?.kind === 'setup') return reconcileStoppedPresentation();
    protocolBlocked = false;
    if (requested || phase === 'starting' || phase === 'running') return stopForIntent();
    if (persistenceBlocked || cleanupBlocked) {
      notify(persistenceBlocked ? 'Run state save failed.' : 'Process cleanup uncertain.',
        persistenceBlocked ? 'STATE_SAVE_FAILED' : 'CLEANUP_BLOCKED');
      return tail;
    }
    editRecovery = undefined;
    resetIdleFooter();
    requested = true;
    startProvenance = undefined;
    ++intentVersion;
    return prepareStart();
  }

  function applySettings(settings) {
    const changed = updateSettings(settings);
    if (!changed) return cosmeticChanged || captionChanged ? refreshAppearance(!cosmeticChanged) : tail;
    return stopForIntent(undefined, true);
  }

  function disappear() {
    if (!visible) return tail;
    visible = false;
    return pause();
  }

  function persistenceFailed() {
    if (persistenceBlocked) return tail;
    persistenceBlocked = true;
    editRecovery = undefined;
    retainError('Run state save failed.', 'STATE_SAVE_FAILED');
    requested = false;
    startAttempt = undefined;
    startProvenance = undefined;
    ++intentVersion;
    const display = ++displayVersion;
    invalidateDisplay();
    phase = 'stopping';
    return schedule(async () => {
      await stopGeneration('intent');
      if (display !== displayVersion) return;
      phase = 'stopped';
      notify('Run state save failed.', 'STATE_SAVE_FAILED', display);
    });
  }

  async function whenIdle() {
    while (true) {
      const current = tail;
      await current;
      await Promise.all([...queues].map(queue => queue.whenIdle()));
      await Promise.all([...errorDisplays, ...presentations]);
      if (current === tail && errorDisplays.size === 0 && presentations.size === 0) return;
    }
  }

  function getState() {
    return { phase, runRequested: requested, visible, connected, protocolBlocked, cleanupBlocked, persistenceBlocked, presentation,
      recoveryPending: Boolean(editRecovery) };
  }

  return {
    appear, press, applySettings, disappear, setConnected, reconcileAvailability,
    persistenceFailed, refreshAppearance, whenIdle, getState,
  };
}
