import { action } from "@elgato/streamdeck";
import type { KeyDownEvent, KeyUpEvent } from "@elgato/streamdeck";

import type { AvailabilityRegistry } from "../core/availability.mjs";
import type { SettingsJson } from "../core/settings-authority.mjs";
import { createTimerArtwork } from "../core/timer-artwork.mjs";
import { createTimerSession } from "../core/timer-session.mjs";
import type { TimerSession, TimerSessionDependencies } from "../core/timer-session.mjs";
import { createTimerStateCoordinator, validateTimerSettings } from "../core/timer-settings.mjs";
import type { TimerActionOnPress, TimerStateCoordinator } from "../core/timer-settings.mjs";
import { ProgramRuntimeAction } from "./program-runtime";
import type { ProgramSessionDependencies, ProgramStateDependencies } from "./program-runtime";

type TimerSettings = {
	executable?: string;
	args?: string[] | string;
	argsText?: string;
	cwd?: string;
	themeColor?: SettingsJson;
	title?: SettingsJson;
	intervalSeconds?: number;
	actionOnPress?: TimerActionOnPress;
};

type TimerTiming = Pick<TimerSessionDependencies, "now" | "setTimer" | "clearTimer">;

@action({ UUID: "git.renaudcerrato.deckforge.loop" })
export class TimerAction extends ProgramRuntimeAction<TimerSettings, TimerStateCoordinator, TimerSession> {
	constructor(registry?: AvailabilityRegistry, private readonly timing: TimerTiming = {}) {
		super(registry);
	}

	protected override createState(dependencies: ProgramStateDependencies): TimerStateCoordinator {
		return createTimerStateCoordinator(dependencies);
	}

	protected override createSession(_state: TimerStateCoordinator, dependencies: ProgramSessionDependencies): TimerSession {
		const { showPresentation, confirmLaunchSettings, ...boundary } = dependencies;
		return createTimerSession({
			...boundary,
			...this.timing,
			awaitConfiguration: confirmLaunchSettings,
			onPresentation: (kind, caption, isCurrent, themeColor, readyFooter = "ready", extension) =>
				showPresentation(() => createTimerArtwork(kind, caption, themeColor, readyFooter, extension), isCurrent),
		});
	}

	protected override validateExecutionSettings(settings: unknown): void {
		validateTimerSettings(settings);
	}

	override onKeyDown(ev: KeyDownEvent<TimerSettings>): Promise<void> {
		const record = this.getSession(ev.action.id, ev.action);
		if (!record?.active || record.hidden) return Promise.resolve();
		if (!record.initialized) this.observe(record, ev.payload.settings);
		this.inspectSettings("ON_KEY_DOWN", record.state.getSettings());
		return record.session.keyDown();
	}

	override onKeyUp(ev: KeyUpEvent<TimerSettings>): Promise<void> {
		const record = this.getSession(ev.action.id, ev.action);
		return record?.active && !record.hidden ? record.session.keyUp() : Promise.resolve();
	}
}
