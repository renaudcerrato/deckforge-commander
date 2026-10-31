export interface ImageLineFramer {
	push(chunk: Uint8Array): void;
	finish(): void;
}

export declare function createImageLineFramer(options: {
	onLine: (line: string) => void;
}): ImageLineFramer;
