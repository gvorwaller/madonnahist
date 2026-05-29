import type { TranscribeInput, TranscribeOptions, TranscribeResult, VendorAdapter } from '../types.js';

export interface GoogleVisionConfig {
	apiKey: string;
}

const ENDPOINT = 'https://vision.googleapis.com/v1/images:annotate';

interface VisionResponse {
	responses: Array<{
		fullTextAnnotation?: {
			text: string;
			pages: Array<{
				confidence: number;
				blocks: Array<{
					blockType: string;
					confidence: number;
					paragraphs: Array<{
						confidence: number;
						words: Array<{
							confidence: number;
						}>;
					}>;
				}>;
			}>;
		};
		error?: { code: number; message: string };
	}>;
}

export function createGoogleVisionAdapter(config: GoogleVisionConfig): VendorAdapter {
	return {
		vendorName: 'google-vision',

		async transcribe(
			input: TranscribeInput,
			_options?: TranscribeOptions
		): Promise<TranscribeResult> {
			const imageB64 = input.image.toString('base64');
			const start = performance.now();

			const res = await fetch(`${ENDPOINT}?key=${config.apiKey}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					requests: [
						{
							image: { content: imageB64 },
							features: [{ type: 'DOCUMENT_TEXT_DETECTION' }]
						}
					]
				})
			});

			if (!res.ok) {
				const body = await res.text();
				throw new Error(`Google Vision ${res.status}: ${body}`);
			}

			const data: VisionResponse = await res.json();
			const latencyMs = Math.round(performance.now() - start);
			const result = data.responses[0];

			if (result.error) {
				throw new Error(`Google Vision error ${result.error.code}: ${result.error.message}`);
			}

			const annotation = result.fullTextAnnotation;
			const text = (annotation?.text ?? '').trim();

			let confSum = 0;
			let confCount = 0;
			if (annotation) {
				for (const page of annotation.pages) {
					for (const block of page.blocks) {
						for (const para of block.paragraphs) {
							for (const word of para.words) {
								confSum += word.confidence;
								confCount++;
							}
						}
					}
				}
			}

			return {
				text,
				confidence: confCount > 0 ? confSum / confCount : null,
				latencyMs,
				vendorMeta: {
					wordCount: confCount,
					pageCount: annotation?.pages.length ?? 0,
					sourceImagePath: input.sourceImagePath
				}
			};
		}
	};
}
