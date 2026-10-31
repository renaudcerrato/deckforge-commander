import streamDeck, { SingletonAction } from "@elgato/streamdeck";
import type {
	DidReceiveSettingsEvent,
	KeyAction,
	RegistrationInfo,
	SendToPluginEvent,
	WillAppearEvent,
	WillDisappearEvent,
} from "@elgato/streamdeck";

import { createAvailabilityManager } from "../core/availability.mjs";
import type { AvailabilityManager, AvailabilityRegistry } from "../core/availability.mjs";
import { createErrorArtwork } from "../core/error-artwork.mjs";
import { createLaunchEnvironment } from "../core/launch-environment.mjs";
import { executionPlatform } from "../core/execution-paths.mjs";
import type { ExecutionPlatform } from "../core/execution-paths.mjs";
import type { LaunchMetadata } from "../core/launch-environment.mjs";
import { startProcessRun } from "../core/process-runner.mjs";
import type { ProcessRun, ProcessRunCallbacks, ProcessRunDiagnostic } from "../core/process-runner.mjs";
import type { SaveResult, SettingsJson as JsonValue, StoredSettings } from "../core/settings-authority.mjs";
import { copySettings, equalJson as sameSettingsJson } from "../core/settings-authority.mjs";
import { settingsDiagnosticCode } from "../core/settings.mjs";
import type { ExecutionSettings } from "../core/settings.mjs";
import { DEFAULT_THEME_COLOR, settingsThemeColor } from "../core/theme.mjs";

/** Complete-settings authority operations, without any action-specific saved intent. */
export interface ProgramState {
	observe(input: unknown): { accepted: boolean };
	getSettings(): StoredSettings;
	editConfiguration(changes: unknown): Promise<SaveResult>;
	whenIdle(): Promise<void>;
	isBlocked(): boolean;
	getRevision(): number;
}

/** Lifecycle is delegated to the core; hiding does not impose a shared stop policy. */
export interface ProgramSession {
	appear(settings: unknown): Promise<void>;
	disappear(): Promise<void>;
	applySettings(settings: unknown): Promise<void>;
	setConnected(connected: boolean): Promise<void>;
	persistenceFailed(): Promise<void>;
	getState(): { visible: boolean; cleanupBlocked?: boolean };
	whenIdle(): Promise<void>;
}

export interface ProgramStateDependencies {
	platform?: ExecutionPlatform;
	writeSettings(settings: StoredSettings): Promise<void>;
	readSettings(): Promise<unknown>;
	onFailure(): void;
}

/** The process/display boundary shared by cores; presentation artwork remains action policy. */
export interface ProgramSessionDependencies {
	platform?: ExecutionPlatform;
	/** Wait only on settings authority, never the session queue; matching reports are not durability proof. */
	confirmLaunchSettings(expected: StoredSettings): Promise<boolean>;
	startRun(settings: ExecutionSettings, callbacks: ProcessRunCallbacks & {
		onDiagnostic(event: ProcessRunDiagnostic): void;
	}): ProcessRun;
	setImage(image: string, isCurrent: () => boolean): Promise<void>;
	setTitle(title: string, isCurrent: () => boolean): Promise<void>;
	onError(message: string, diagnosticCode: string | undefined, isCurrent: () => boolean, themeColor: string): Promise<void>;
	/** Invalidate older images before synchronous rendering, then serialize title clearing and image handoff. */
	showPresentation(renderImage: () => string, isCurrent: () => boolean): Promise<void>;
}

type LaunchMetadataAction = Pick<KeyAction<StoredSettings>, "id" | "manifestId" | "device" | "coordinates">;

export type RuntimeAction = LaunchMetadataAction & {
	setImage(image?: string): Promise<void>;
	setTitle(title?: string): Promise<void>;
	setSettings(settings: StoredSettings): Promise<void>;
	getSettings(): Promise<unknown>;
};

export type SessionRecord<State extends ProgramState = ProgramState, Session extends ProgramSession = ProgramSession> = {
	session: Session;
	state: State;
	initialized: boolean;
	runtime: { current: RuntimeAction };
	display: { current?: RuntimeAction; tail: Promise<void>; imageVersion: number };
	inspector?: { id: string; requestId: number };
	handshakes: Map<string, { requestId: number; token: string }>;
	retiredInspectors: Set<string>;
	handshakeVersion: number;
	active: boolean;
	hidden: boolean;
	pendingWrite: boolean;
	persistenceUncertain: boolean;
	cleanupBlocked: boolean;
	ready: Promise<void>;
	ownedRun?: ProcessRun;
	retire(): Promise<void>;
};

// Contexts are reusable host slots, including across the three action facades.
// Keep only their current generation; SDK wrapper identity is not an incarnation.
const owners = new Map<string, SessionRecord>();

function saveFailed(): Error {
	return Object.assign(new Error("Settings save failed."), { diagnosticCode: "STATE_SAVE_FAILED" });
}

type InspectorRequest = {
	type: "canvas:hello" | "canvas:claim" | "canvas:edit";
	context: string;
	inspectorId: string;
	requestId: number;
	changes?: unknown;
	token?: string;
};

type SettingsEventSource = "ON_APPEAR" | "ON_RECEIVE" | "ON_KEY_DOWN";
const ALLOWED_PROCESS_DIAGNOSTICS = new Set<ProcessRunDiagnostic>([
	"PROCESS_SPAWN_SUCCEEDED",
	"PROCESS_STDOUT_FIRST_DATA",
	"PROCESS_STDERR_FIRST_DATA",
	"PROCESS_IMAGE_RECORD_PARSED",
	"PROCESS_PROTOCOL_REJECTED",
	"PROCESS_LAUNCH_FAILED",
	"PROCESS_LAUNCH_REASON_ENOENT",
	"PROCESS_LAUNCH_REASON_EACCES",
	"PROCESS_LAUNCH_REASON_ENOTDIR",
	"PROCESS_LAUNCH_REASON_ENOEXEC",
	"PROCESS_LAUNCH_REASON_EAGAIN",
	"PROCESS_LAUNCH_REASON_EINVAL",
	"PROCESS_LAUNCH_REASON_UNKNOWN",
	"PROCESS_EXITED_SUCCESSFULLY",
	"PROCESS_EXITED_NONZERO",
	"PROCESS_TERMINATED_BY_SIGNAL",
	"PROCESS_RUN_COMPLETED_AFTER_STOP_REQUEST",
]);

function logProcessDiagnostic(event: ProcessRunDiagnostic): void {
	if (!ALLOWED_PROCESS_DIAGNOSTICS.has(event)) return;
	try {
		streamDeck.logger.info(event);
	} catch {
		// Logging must not affect process behavior.
	}
}

function logSettingsInspection(source: SettingsEventSource, settings: unknown, validate: (settings: unknown) => void): void {
	let diagnostic: string | undefined;
	try {
		validate(settings);
	} catch (error) {
		diagnostic = settingsDiagnosticCode(error);
	}
	try {
		if (diagnostic) streamDeck.logger.warn(`SETTINGS_REJECTED_${source}: ${diagnostic}`);
		else streamDeck.logger.info(`SETTINGS_ACCEPTED_${source}`);
	} catch { /* Fixed diagnostic logging must not affect execution. */ }
}

function inspectorRequest(payload: unknown, context: string): InspectorRequest | undefined {
	if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
	const value = payload as InspectorRequest;
	if (value.context !== context || typeof value.inspectorId !== "string" || value.inspectorId.length > 128
		|| value.inspectorId.length === 0 || !Number.isSafeInteger(value.requestId) || value.requestId < 1) return undefined;
	if (value.type !== "canvas:hello" && value.type !== "canvas:claim" && value.type !== "canvas:edit") return undefined;
	const keys = value.type === "canvas:hello"
		? ["type", "context", "inspectorId", "requestId"]
		: value.type === "canvas:claim"
			? ["type", "context", "inspectorId", "requestId", "token"]
			: ["type", "context", "inspectorId", "requestId", "changes"];
	if (value.type === "canvas:claim" && typeof value.token !== "string") return undefined;
	if (Object.keys(value).some(key => !keys.includes(key))) return undefined;
	return value;
}

function currentRequest(record: SessionRecord, request: InspectorRequest): boolean {
	if (!record.active) return false;
	if (request.type === "canvas:hello") {
		return record.handshakes.get(request.inspectorId)?.requestId === request.requestId;
	}
	return record.inspector?.id === request.inspectorId && record.inspector.requestId === request.requestId;
}

function enqueueDisplay(display: SessionRecord["display"], operation: () => void | Promise<void>): Promise<void> {
	const result = display.tail.then(operation);
	display.tail = result.then(() => {}, () => {});
	return result;
}

function readSdkMetadata<T>(read: () => T): T | undefined {
	try { return read(); } catch { return undefined; }
}

/** Public SDK getters are intentional here; the pure helper only admits own scalar data. */
export function captureLaunchMetadata(
	runtimeAction: LaunchMetadataAction,
	info: Pick<RegistrationInfo, "plugin" | "application"> | undefined = readSdkMetadata(() => streamDeck.info),
): LaunchMetadata {
	return {
		pluginUuid: readSdkMetadata(() => info?.plugin.uuid),
		pluginVersion: readSdkMetadata(() => info?.plugin.version),
		actionUuid: readSdkMetadata(() => runtimeAction.manifestId),
		actionContext: readSdkMetadata(() => runtimeAction.id),
		deviceId: readSdkMetadata(() => runtimeAction.device.id),
		deviceName: readSdkMetadata(() => runtimeAction.device.name),
		deviceType: readSdkMetadata(() => runtimeAction.device.type),
		deviceColumns: readSdkMetadata(() => runtimeAction.device.size.columns),
		deviceRows: readSdkMetadata(() => runtimeAction.device.size.rows),
		keyColumn: readSdkMetadata(() => runtimeAction.coordinates?.column),
		keyRow: readSdkMetadata(() => runtimeAction.coordinates?.row),
		appVersion: readSdkMetadata(() => info?.application.version),
		appLanguage: readSdkMetadata(() => info?.application.language),
		appPlatform: readSdkMetadata(() => info?.application.platform),
		appPlatformVersion: readSdkMetadata(() => info?.application.platformVersion),
	};
}

export abstract class ProgramRuntimeAction<Settings extends StoredSettings, State extends ProgramState, Session extends ProgramSession>
	extends SingletonAction<Settings> {
	private readonly sessions = new Map<string, SessionRecord<State, Session>>();
	private readonly availability: AvailabilityManager;

	constructor(registry: AvailabilityRegistry = {
		onDeviceDidConnect: listener => streamDeck.devices.onDeviceDidConnect(listener),
		onDeviceDidDisconnect: listener => streamDeck.devices.onDeviceDidDisconnect(listener),
		onSystemDidWakeUp: listener => streamDeck.system.onSystemDidWakeUp(listener),
	}) {
		super();
		// One registry per SingletonAction, never one subscription set per key or appearance.
		this.availability = createAvailabilityManager(registry);
	}

	protected abstract createState(dependencies: ProgramStateDependencies): State;
	protected abstract createSession(state: State, dependencies: ProgramSessionDependencies): Session;
	protected abstract validateExecutionSettings(settings: unknown): void;

	protected inspectSettings(source: SettingsEventSource, settings: unknown): void {
		logSettingsInspection(source, settings, input => this.validateExecutionSettings(input));
	}

	override onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
		this.inspectSettings("ON_APPEAR", ev.payload.settings);
		if (!ev.action.isKey()) return Promise.resolve();
		const id = ev.action.id;
		const previous = owners.get(id);
		let snapshot: StoredSettings | undefined;
		try { snapshot = copySettings(ev.payload.settings); } catch { /* Invalid JSON cannot establish a new owner. */ }
		const local = this.sessions.get(id);
		const replace = previous && snapshot !== undefined && previous.hidden && (previous !== local
			|| !sameSettingsJson(snapshot, previous.state.getSettings()));
		if (previous && previous !== local && !replace) return Promise.resolve();
		if (replace) void previous.retire();
		const record = replace ? this.createRecord(id, ev.action, previous) : this.getSession(id, ev.action);
		if (!record) return Promise.resolve();
		// Only an appearance may promote the SDK runtime/display target.
		record.runtime.current = ev.action;
		record.display.current = ev.action;
		record.hidden = false;
		this.observe(record, ev.payload.settings);
		return record.ready.then(async () => {
			if (!record.active || record.hidden) return;
			await this.track(id, record);
			if (!record.active || record.hidden) return;
			if (record.persistenceUncertain) await record.session.persistenceFailed();
			await record.session.appear(record.state.getSettings());
			await this.showSafetyError(record);
		});
	}

	override async onWillDisappear(ev: WillDisappearEvent<Settings>): Promise<void> {
		const record = this.sessions.get(ev.action.id);
		if (!record?.active) return;
		// Observe disappearance before yielding: a same-turn appearance can reuse this slot.
		record.hidden = true;
		await record.session.disappear();
		if (record.hidden) record.display.current = undefined;
	}

	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): Promise<void> {
		this.inspectSettings("ON_RECEIVE", ev.payload.settings);
		if (!ev.action.isKey()) return Promise.resolve();
		const record = this.getSession(ev.action.id, ev.action);
		if (!record?.active) return Promise.resolve();
		if (!this.observe(record, ev.payload.settings)) return Promise.resolve();
		return record.session.applySettings(record.state.getSettings());
	}

	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, Settings>): Promise<void> {
		if (!ev.action.isKey()) return;
		const request = inspectorRequest(ev.payload, ev.action.id);
		if (!request) return;
		const record = this.getSession(ev.action.id, ev.action);
		// A claimed current owner may save while hidden; hiding grants no new PI claim.
		// Edits still pass the generation's inspector/request checks below.
		if (!record?.active || (record.hidden && request.type !== "canvas:edit")) return;
		if (request.type === "canvas:hello") {
			if (record.retiredInspectors.has(request.inspectorId)) return;
			if (record.inspector?.id === request.inspectorId && request.requestId <= record.inspector.requestId) return;
			const previous = record.handshakes.get(request.inspectorId);
			if (previous && request.requestId <= previous.requestId) return;
			if (!previous && record.handshakes.size >= 16) {
				const oldest = record.handshakes.keys().next().value;
				if (oldest !== undefined) record.handshakes.delete(oldest);
			}
			const token = String(++record.handshakeVersion);
			record.handshakes.set(request.inspectorId, { requestId: request.requestId, token });
			try {
				if (!record.initialized) {
					const settings = await record.runtime.current.getSettings();
					if (!record.active) return;
					this.observe(record, settings);
				}
				await record.state.whenIdle();
				await this.reply(record, request, record.state.isBlocked() || record.persistenceUncertain
					? { status: "error", diagnosticCode: "STATE_SAVE_FAILED" }
					: { status: "challenge", token, settings: record.state.getSettings() });
			} catch {
				await this.reply(record, request, { status: "error", diagnosticCode: "STATE_SAVE_FAILED" });
			}
			return;
		}
		if (request.type === "canvas:claim") {
			const handshake = record.handshakes.get(request.inspectorId);
			if (!handshake || record.retiredInspectors.has(request.inspectorId)
				|| handshake.token !== request.token || request.requestId <= handshake.requestId) {
				return;
			}
			if (record.inspector && record.inspector.id !== request.inspectorId) {
				record.retiredInspectors.add(record.inspector.id);
			}
			record.inspector = { id: request.inspectorId, requestId: request.requestId };
			record.handshakes.clear();
			await record.state.whenIdle();
			await this.reply(record, request, record.state.isBlocked() || record.persistenceUncertain
				? { status: "error", diagnosticCode: "STATE_SAVE_FAILED" }
				: { status: "saved", settings: record.state.getSettings() });
			return;
		}
		const inspector = record.inspector;
		if (!inspector || inspector.id !== request.inspectorId || request.requestId <= inspector.requestId) {
			return;
		}
		inspector.requestId = request.requestId;
		// Temporary fixed stage only; never include exception text or settings values.
		let diagnosticStage = "PLUGIN_EDIT_BEGIN";
		try {
			if (record.persistenceUncertain) throw saveFailed();
			const saving = record.state.editConfiguration(request.changes);
			diagnosticStage = "PLUGIN_APPLY_BEGIN";
			const applying = record.session.applySettings(record.state.getSettings());
			diagnosticStage = "PLUGIN_SAVE_WAIT";
			const result = await saving;
			diagnosticStage = "PLUGIN_APPLY_WAIT";
			await applying;
			await this.showSafetyError(record);
			diagnosticStage = "PLUGIN_REPLY";
			if (result.status === "saved" && result.revision === record.state.getRevision()) {
				await this.reply(record, request, { status: "saved", settings: result.settings });
			} else {
				await this.reply(record, request, { status: "stale" });
			}
		} catch (error) {
			let code = settingsDiagnosticCode(error);
			try {
				if (Object.getOwnPropertyDescriptor(error, "diagnosticCode")?.value === "STATE_SAVE_FAILED") code = "STATE_SAVE_FAILED";
			} catch { /* Inspect only a fixed reason, never an exception message. */ }
			await this.reply(record, request, {
				status: "error",
				diagnosticCode: code,
				diagnosticStage,
			});
		}
	}

	private async reply(record: SessionRecord, request: InspectorRequest, payload: Record<string, JsonValue>): Promise<void> {
		if (!currentRequest(record, request)) return;
		try {
			// This API targets the currently visible PI; receiving context/session/request guards are mandatory.
			await streamDeck.ui.sendToPropertyInspector({
				...payload, type: "canvas:reply", context: request.context,
				inspectorId: request.inspectorId, requestId: request.requestId,
			});
		} catch {
			// The PI's bounded request timer reports a fixed failure; no raw transport errors are logged.
		}
	}

	private showSafetyError(record: SessionRecord): Promise<void> {
		if (!record.active || record.hidden || (!record.cleanupBlocked && !record.persistenceUncertain)) return Promise.resolve();
		const display = record.display;
		const version = ++display.imageVersion;
		const current = () => record.active && !record.hidden && version === display.imageVersion;
		const code = record.persistenceUncertain ? "STATE_SAVE_FAILED" : "CLEANUP_BLOCKED";
		const image = createErrorArtwork(code, settingsThemeColor(record.state.getSettings()));
		return enqueueDisplay(display, async () => {
			if (!current()) return;
			await display.current?.setTitle("");
			if (current()) await display.current?.setImage(image);
		});
	}

	protected observe(record: SessionRecord<State, Session>, settings: unknown): boolean {
		if (!record.active) return false;
		try {
			const result = record.state.observe(settings);
			record.initialized = true;
			return result.accepted;
		} catch {
			void record.session.persistenceFailed();
			return false;
		}
	}

	protected getSession(id: string, runtimeAction: RuntimeAction): SessionRecord<State, Session> | undefined {
		const existing = this.sessions.get(id);
		if (existing?.active) return existing;
		if (owners.has(id)) return undefined;
		return this.createRecord(id, runtimeAction);
	}

	private track(id: string, record: SessionRecord): Promise<void> {
		return this.availability.track(id, {
			session: { setConnected: connected => record.active
				? record.ready.then(() => record.active
					? record.session.setConnected(connected && !record.cleanupBlocked && !record.persistenceUncertain)
					: undefined) : Promise.resolve() },
			getDevice: () => record.runtime.current.device,
		});
	}

	private createRecord(id: string, runtimeAction: RuntimeAction, previous?: SessionRecord): SessionRecord<State, Session> {
		const runtime = { current: runtimeAction };
		const display: SessionRecord["display"] = { current: runtimeAction, tail: previous?.display.tail ?? Promise.resolve(), imageVersion: 0 };
		const sessionRef: { current?: Session } = {};
		let record: SessionRecord<State, Session>;
		const currentOwner = () => record.active;
		const state = this.createState({
			platform: executionPlatform(),
			writeSettings: async settings => {
				if (!currentOwner() || record.persistenceUncertain) throw saveFailed();
				record.pendingWrite = true;
				// Keep the dispatched-write fence through complete authority confirmation.
				void state.whenIdle().then(() => {
					if (record.active && !state.isBlocked()) record.pendingWrite = false;
				});
				await runtime.current.setSettings(settings);
			},
			readSettings: async () => {
				if (!currentOwner()) throw saveFailed();
				const settings = await runtime.current.getSettings();
				if (!currentOwner()) throw saveFailed();
				return settings;
			},
			onFailure: () => {
				if (!record?.active) return;
				record.persistenceUncertain = true;
				void sessionRef.current?.persistenceFailed();
			},
		});
		const session = this.createSession(state, {
			platform: executionPlatform(),
			confirmLaunchSettings: async expected => {
				if (!currentOwner()) return false;
				await record.ready;
				if (!currentOwner() || record.cleanupBlocked || record.persistenceUncertain) return false;
				const snapshot = copySettings(expected);
				while (true) {
					const revision = state.getRevision();
					await state.whenIdle();
					if (!currentOwner() || state.isBlocked() || record.persistenceUncertain) return false;
					if (revision !== state.getRevision()) continue;
					return sameSettingsJson(snapshot, copySettings(state.getSettings()));
				}
			},
			startRun: (settings, callbacks) => {
				if (!currentOwner() || record.cleanupBlocked || record.persistenceUncertain) throw saveFailed();
				// Capture afresh for each actual start, including eligible availability resumption.
				const actionThemeColor = settingsThemeColor(state.getSettings());
				// Require the exact hex length even if the renderer's regex accepts a final line ending.
				const env = createLaunchEnvironment(process.env, {
					...captureLaunchMetadata(runtime.current),
					actionThemeColor: actionThemeColor.length === 7 ? actionThemeColor : DEFAULT_THEME_COLOR,
				}, executionPlatform());
				const run = startProcessRun(settings, {
					...callbacks,
					onUpdate: update => { if (currentOwner()) callbacks.onUpdate(update); },
					onError: message => { if (currentOwner()) callbacks.onError(message); },
					onDiagnostic: event => {
						logProcessDiagnostic(event);
						if (currentOwner()) callbacks.onDiagnostic(event);
					},
				}, undefined, { env });
				let stopping: Promise<boolean> | undefined;
				const owned: ProcessRun = {
					done: run.done,
					stop: () => stopping ??= Promise.resolve().then(() => run.stop()).then(certain => {
						if (!certain) record.cleanupBlocked = true;
						return certain;
					}, () => { record.cleanupBlocked = true; return false; }),
				};
				record.ownedRun = owned;
				void run.done.then(() => {
					if (!stopping && record.ownedRun === owned) record.ownedRun = undefined;
				}, () => { record.cleanupBlocked = true; });
				return owned;
			},
			showPresentation: (renderImage, isCurrent) => {
				const imageVersion = ++display.imageVersion;
				const safetyCode = record.persistenceUncertain ? "STATE_SAVE_FAILED" : record.cleanupBlocked ? "CLEANUP_BLOCKED" : undefined;
				const image = safetyCode ? createErrorArtwork(safetyCode, settingsThemeColor(state.getSettings())) : renderImage();
				const current = () => currentOwner() && isCurrent() && imageVersion === display.imageVersion;
				return enqueueDisplay(display, async () => {
					if (!current()) return;
					// Built-in basename is inside its SVG. Native custom titles still win and cannot be hidden.
					await display.current?.setTitle("");
					if (!current()) return;
					await display.current?.setImage(image);
				});
			},
			setImage: (image, isCurrent) => {
				const imageVersion = ++display.imageVersion;
				// Generated primitives and opaque images use the same guarded serialized handoff.
				return enqueueDisplay(display, () => currentOwner() && isCurrent() && imageVersion === display.imageVersion
					? display.current?.setImage(image) : undefined);
			},
			setTitle: (title, isCurrent) => enqueueDisplay(display,
				() => currentOwner() && isCurrent() ? display.current?.setTitle(title) : undefined),
			onError: (_message, diagnosticCode, isCurrent, themeColor) => {
				const imageVersion = ++display.imageVersion;
				return enqueueDisplay(display, async () => {
					if (!currentOwner() || !isCurrent() || imageVersion !== display.imageVersion) return;
					await display.current?.setTitle("");
					if (!currentOwner() || !isCurrent() || imageVersion !== display.imageVersion) return;
					const code = record.persistenceUncertain ? "STATE_SAVE_FAILED" : record.cleanupBlocked ? "CLEANUP_BLOCKED" : diagnosticCode;
					await display.current?.setImage(createErrorArtwork(code, themeColor));
				});
			},
		});
		sessionRef.current = session;
		record = {
			session, state, runtime, display, initialized: false,
			handshakes: new Map(), retiredInspectors: new Set(previous?.retiredInspectors),
			handshakeVersion: previous?.handshakeVersion ?? 0,
			active: true, hidden: false, pendingWrite: false,
			persistenceUncertain: previous?.persistenceUncertain === true,
			cleanupBlocked: previous?.cleanupBlocked === true,
			ready: Promise.resolve(),
			retire: () => {
				if (!record.active) return record.ready;
				record.active = false;
				record.persistenceUncertain ||= record.pendingWrite || state.isBlocked();
				if (record.inspector) record.retiredInspectors.add(record.inspector.id);
				for (const inspector of record.handshakes.keys()) record.retiredInspectors.add(inspector);
				record.inspector = undefined;
				record.handshakes.clear();
				display.current = undefined;
				++display.imageVersion;
				if (this.sessions.get(id) === record) this.sessions.delete(id);
				const stopping = record.ownedRun?.stop();
				const disconnecting = session.setConnected(false);
				record.ready = record.ready.then(async () => {
					if (stopping && !(await stopping)) record.cleanupBlocked = true;
					await disconnecting;
					await session.whenIdle();
					record.cleanupBlocked ||= session.getState().cleanupBlocked === true;
				});
				return record.ready;
			},
		};
		if (previous) {
			let retiring: SessionRecord | undefined = previous;
			record.ready = previous.ready.then(() => {
				record.cleanupBlocked ||= retiring?.cleanupBlocked === true;
				retiring = undefined;
			});
		}
		this.sessions.set(id, record);
		owners.set(id, record);
		return record;
	}
}
