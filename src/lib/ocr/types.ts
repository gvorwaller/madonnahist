export interface TranscribeInput {
	image: Buffer;
	mimeType: 'image/jpeg' | 'image/tiff' | 'image/png';
	sourceImagePath: string;
}

export interface TranscribeResult {
	text: string;
	confidence: number | null;
	vendorMeta: Record<string, unknown>;
	latencyMs: number;
}

export interface TranscribeOptions {
	mode: 'cell';
	prompt?: string;
}

export interface VendorAdapter {
	readonly vendorName: string;
	transcribe(input: TranscribeInput, options?: TranscribeOptions): Promise<TranscribeResult>;
}
