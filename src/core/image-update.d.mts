export interface ImageUpdate {
	readonly image: string;
}

export declare function parseImageUpdate(line: string): ImageUpdate;
