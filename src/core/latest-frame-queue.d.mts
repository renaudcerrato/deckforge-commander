/** Complete already-rendered frame, with session-owned publication guards. No native title. */
export interface PreparedFrame {
	readonly image: string;
	readonly outputVersion: number;
	/** Present only for generated primitives; opaque producer images ignore cosmetics. */
	readonly cosmeticVersion?: number;
	/** Session-internal provenance. Omission means producer; cosmetic replays never terminal-drain. */
	readonly origin?: 'producer' | 'cosmetic';
}

export interface LatestFrameQueue {
	/** False for invalid data or a disposed/failed queue; never replaces a valid pending frame. */
	enqueue(update: PreparedFrame): boolean;
	whenIdle(): Promise<void>;
	dispose(): void;
	/** Drop the single same-record producer alternate without changing active/pending sends. */
	discardProducerFallback(): void;
}

export declare function createLatestFrameQueue(options: {
	/** False means no image handoff was attempted; a displaced same-record producer may then drain. */
	send: (update: PreparedFrame) => void | boolean | Promise<void | boolean>;
	onError: (message: string) => void;
}): LatestFrameQueue;
