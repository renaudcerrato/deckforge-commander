import { action } from "@elgato/streamdeck";
import type { KeyDownEvent } from "@elgato/streamdeck";

import { createActionSession } from "../core/action-session.mjs";
import type { ActionSession } from "../core/action-session.mjs";
import { createLaunchArtwork } from "../core/launch-artwork.mjs";
import { createRunStateCoordinator } from "../core/run-state.mjs";
import type { RunStateCoordinator, SettingsJson as JsonValue } from "../core/run-state.mjs";
import { validateSettings } from "../core/settings.mjs";
import { ProgramRuntimeAction } from "./program-runtime";
import type { ProgramSessionDependencies, ProgramStateDependencies } from "./program-runtime";

export { captureLaunchMetadata } from "./program-runtime";

type RunSettings = {
	executable?: string;
	args?: string[] | string;
	argsText?: string;
	cwd?: string;
	runRequested?: boolean;
	themeColor?: JsonValue;
	title?: JsonValue;
};

@action({ UUID: "git.renaudcerrato.deckforge.stream" })
export class RunAction extends ProgramRuntimeAction<RunSettings, RunStateCoordinator, ActionSession> {
	protected override createState(dependencies: ProgramStateDependencies): RunStateCoordinator {
		return createRunStateCoordinator(dependencies);
	}

	protected override createSession(_state: RunStateCoordinator, dependencies: ProgramSessionDependencies): ActionSession {
		const { showPresentation, ...boundary } = dependencies;
		return createActionSession({
			...boundary,
			onPresentation: (kind, caption, isCurrent, themeColor, readyFooter = "ready", extension) =>
				showPresentation(() => createLaunchArtwork(kind, caption, themeColor, readyFooter, extension), isCurrent),
		});
	}

	protected override validateExecutionSettings(settings: unknown): void {
		validateSettings(settings);
	}

	override async onKeyDown(ev: KeyDownEvent<RunSettings>): Promise<void> {
		const record = this.getSession(ev.action.id, ev.action);
		if (!record?.active || record.hidden) return Promise.resolve();
		if (!record.initialized) this.observe(record, ev.payload.settings);
		const settings = record.state.getSettings();
		this.inspectSettings("ON_KEY_DOWN", settings);
		await record.session.press(settings);
		// A blocked press may publish its fixed error outside the session queue.
		// Join that existing display drain before another press supersedes its image.
		if (record.persistenceUncertain || record.cleanupBlocked) await record.session.whenIdle();
	}
}
