export interface DeviceAvailability {
	id: string;
	isConnected: boolean;
}

export interface AvailabilitySubscription { dispose(): void }

/** Availability owns connectivity only, not an action's key or persistence policy. */
export interface ConnectivitySession { setConnected(connected: boolean): Promise<void> }

/** Exactly the three supported SDK registrations; injectable without SDK/host initialization. */
export interface AvailabilityRegistry {
	onDeviceDidConnect(listener: (event: { device: DeviceAvailability }) => void): AvailabilitySubscription;
	onDeviceDidDisconnect(listener: (event: { device: DeviceAvailability }) => void): AvailabilitySubscription;
	onSystemDidWakeUp(listener: () => void): AvailabilitySubscription;
}

export interface AvailabilityManager {
	/** Bind a transient live action to its own current Device; never persist the action id. */
	track(id: string, entry: { session: ConnectivitySession; getDevice(): DeviceAvailability }): Promise<void>;
	/** Query current availability in response to wake/appearance, not on a polling interval. */
	reconcile(): Promise<void>;
	whenIdle(): Promise<void>;
	/** Unregister listeners only; this is not a host-shutdown or pre-sleep cleanup hook. */
	dispose(): void;
}

export declare function createAvailabilityManager(registry: AvailabilityRegistry): AvailabilityManager;
