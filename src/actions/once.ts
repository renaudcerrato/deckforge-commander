import { action } from "@elgato/streamdeck";
import type { KeyDownEvent, KeyUpEvent } from "@elgato/streamdeck";

import type { AvailabilityRegistry } from "../core/availability.mjs";
import { createOnceArtwork } from "../core/once-artwork.mjs";
import { createOnceSession } from "../core/once-session.mjs";
import type { OnceSession, OnceSessionDependencies } from "../core/once-session.mjs";
import { createOnceStateCoordinator, validateOnceSettings } from "../core/once-settings.mjs";
import type { OnceStateCoordinator } from "../core/once-settings.mjs";
import type { SettingsJson } from "../core/settings-authority.mjs";
import { ProgramRuntimeAction } from "./program-runtime";
import type { ProgramSessionDependencies, ProgramStateDependencies } from "./program-runtime";

type OnceSettings = {
	executable?: string;
	args?: string[] | string;
	argsText?: string;
	cwd?: string;
	themeColor?: SettingsJson;
	title?: SettingsJson;
};

type OnceTiming = Pick<OnceSessionDependencies, "now" | "setTimer" | "clearTimer">;

@action({ UUID: "git.renaudcerrato.deckforge.run" })
export class OnceAction extends ProgramRuntimeAction<OnceSettings, OnceStateCoordinator, OnceSession> {
	constructor(registry?: AvailabilityRegistry, private readonly timing: OnceTiming = {}) {
		super(registry);
	}

	protected override createState(dependencies: ProgramStateDependencies): OnceStateCoordinator {
		return createOnceStateCoordinator(dependencies);
	}

	protected override createSession(_state: OnceStateCoordinator, dependencies: ProgramSessionDependencies): OnceSession {
		const { showPresentation, confirmLaunchSettings, ...boundary } = dependencies;
		return createOnceSession({
			...boundary,
			...this.timing,
			awaitConfiguration: confirmLaunchSettings,
			onPresentation: (kind, caption, isCurrent, themeColor, readyFooter = "ready", extension) =>
				showPresentation(() => createOnceArtwork(kind, caption, themeColor, readyFooter, extension), isCurrent),
		});
	}

	protected override validateExecutionSettings(settings: unknown): void {
		validateOnceSettings(settings);
	}

	override onKeyDown(ev: KeyDownEvent<OnceSettings>): Promise<void> {
		const record = this.getSession(ev.action.id, ev.action);
		if (!record?.active || record.hidden) return Promise.resolve();
		if (!record.initialized) this.observe(record, ev.payload.settings);
		this.inspectSettings("ON_KEY_DOWN", record.state.getSettings());
		return record.session.keyDown();
	}

	override onKeyUp(ev: KeyUpEvent<OnceSettings>): Promise<void> {
		const record = this.getSession(ev.action.id, ev.action);
		return record?.active && !record.hidden ? record.session.keyUp() : Promise.resolve();
	}
}
