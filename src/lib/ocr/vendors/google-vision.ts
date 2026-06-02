import type { TranscribeInput, TranscribeOptions, TranscribeResult, VendorAdapter } from '../types.js';

export interface GoogleVisionConfig {
	apiKey: string;
}

const ENDPOINT = 'https://vision.googleapis.com/v1/images:annotate';

export interface WordBox {
	text: string;
	confidence: number;
	vertices: Array<{ x: number; y: number }>;
	cx: number;
	cy: number;
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
}

export interface FullPageResult {
	fullText: string;
	words: WordBox[];
	latencyMs: number;
	pageConfidence: number | null;
}

interface VisionResponse {
	responses: Array<{
		fullTextAnnotation?: {
			text: string;
			pages: Array<{
				confidence: number;
				blocks: Array<{
					blockType: string;
					confidence: number;
					boundingBox?: { vertices: Array<{ x?: number; y?: number }> };
					paragraphs: Array<{
						confidence: number;
						boundingBox?: { vertices: Array<{ x?: number; y?: number }> };
						words: Array<{
							confidence: number;
							boundingBox?: { vertices: Array<{ x?: number; y?: number }> };
							symbols: Array<{
								text: string;
								confidence: number;
								property?: {
									detectedBreak?: { type: string };
								};
							}>;
						}>;
					}>;
				}>;
			}>;
		};
		error?: { code: number; message: string };
	}>;
}

function extractWords(response: VisionResponse): WordBox[] {
	const words: WordBox[] = [];
	const annotation = response.responses[0]?.fullTextAnnotation;
	if (!annotation) return words;

	for (const page of annotation.pages) {
		for (const block of page.blocks) {
			for (const para of block.paragraphs) {
				for (const word of para.words) {
					const text = word.symbols.map(s => s.text).join('');
					const verts = word.boundingBox?.vertices ?? [];
					if (verts.length < 4) continue;

					const xs = verts.map(v => v.x ?? 0);
					const ys = verts.map(v => v.y ?? 0);
					const minX = Math.min(...xs);
					const maxX = Math.max(...xs);
					const minY = Math.min(...ys);
					const maxY = Math.max(...ys);

					words.push({
						text,
						confidence: word.confidence,
						vertices: verts.map(v => ({ x: v.x ?? 0, y: v.y ?? 0 })),
						cx: (minX + maxX) / 2,
						cy: (minY + maxY) / 2,
						minX, maxX, minY, maxY
					});
				}
			}
		}
	}
	return words;
}

async function callVisionApi(apiKey: string, imageB64: string): Promise<VisionResponse> {
	const res = await fetch(`${ENDPOINT}?key=${apiKey}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			requests: [{
				image: { content: imageB64 },
				features: [{ type: 'DOCUMENT_TEXT_DETECTION' }]
			}]
		})
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Google Vision ${res.status}: ${body}`);
	}

	return res.json();
}

/**
 * Full-page OCR: send the entire page image and get back per-word bounding boxes.
 */
export async function transcribeFullPage(
	config: GoogleVisionConfig,
	imageBuffer: Buffer
): Promise<FullPageResult> {
	const imageB64 = imageBuffer.toString('base64');
	const start = performance.now();
	const data = await callVisionApi(config.apiKey, imageB64);
	const latencyMs = Math.round(performance.now() - start);

	const result = data.responses[0];
	if (result?.error) {
		throw new Error(`Google Vision error ${result.error.code}: ${result.error.message}`);
	}

	const annotation = result?.fullTextAnnotation;
	const fullText = (annotation?.text ?? '').trim();
	const words = extractWords(data);

	let confSum = 0;
	let confCount = 0;
	for (const w of words) {
		confSum += w.confidence;
		confCount++;
	}

	return {
		fullText,
		words,
		latencyMs,
		pageConfidence: confCount > 0 ? confSum / confCount : null
	};
}

/**
 * Map words to grid cells using bounding box overlap.
 * Returns a Map from "row,col" to an array of words in reading order.
 */
export function mapWordsToCells(
	words: WordBox[],
	xLines: number[],
	yLines: number[]
): Map<string, WordBox[]> {
	const cellWords = new Map<string, WordBox[]>();
	const rows = yLines.length - 1;
	const cols = xLines.length - 1;

	for (const word of words) {
		let bestCell: string | null = null;
		let bestOverlap = 0;

		for (let r = 0; r < rows; r++) {
			for (let c = 0; c < cols; c++) {
				const cellLeft = xLines[c];
				const cellRight = xLines[c + 1];
				const cellTop = yLines[r];
				const cellBottom = yLines[r + 1];

				const overlapX = Math.max(0, Math.min(word.maxX, cellRight) - Math.max(word.minX, cellLeft));
				const overlapY = Math.max(0, Math.min(word.maxY, cellBottom) - Math.max(word.minY, cellTop));
				const overlap = overlapX * overlapY;

				if (overlap > bestOverlap) {
					bestOverlap = overlap;
					bestCell = `${r},${c}`;
				}
			}
		}

		if (bestCell && bestOverlap > 0) {
			const arr = cellWords.get(bestCell) ?? [];
			arr.push(word);
			cellWords.set(bestCell, arr);
		}
	}

	// Sort words within each cell into reading order: cluster by y-baseline into rows, then x within each row
	for (const [key, ws] of cellWords) {
		cellWords.set(key, sortReadingOrder(ws));
	}

	return cellWords;
}

/**
 * Sort words into reading order: group into lines by y-overlap, then sort x within each line.
 */
function sortReadingOrder(words: WordBox[]): WordBox[] {
	if (words.length <= 1) return words;

	// Sort by cy first for initial line clustering
	const sorted = [...words].sort((a, b) => a.cy - b.cy);

	// Cluster into lines: words with overlapping y-ranges belong to the same line
	const lines: WordBox[][] = [];
	let currentLine: WordBox[] = [sorted[0]];

	for (let i = 1; i < sorted.length; i++) {
		const word = sorted[i];
		const lineMinY = Math.min(...currentLine.map(w => w.minY));
		const lineMaxY = Math.max(...currentLine.map(w => w.maxY));
		const lineHeight = lineMaxY - lineMinY;

		// Word belongs to this line if its vertical center falls within the line's y-range
		// (with some tolerance based on line height)
		const tolerance = lineHeight * 0.3;
		if (word.cy >= lineMinY - tolerance && word.cy <= lineMaxY + tolerance) {
			currentLine.push(word);
		} else {
			lines.push(currentLine);
			currentLine = [word];
		}
	}
	lines.push(currentLine);

	// Sort each line by x, then flatten
	const result: WordBox[] = [];
	for (const line of lines) {
		line.sort((a, b) => a.cx - b.cx);
		result.push(...line);
	}
	return result;
}

/**
 * Reconstruct cell text from sorted words.
 * Inserts newlines between lines (detected by y-gap) and spaces between words on the same line.
 */
export function wordsToText(words: WordBox[]): string {
	if (words.length === 0) return '';

	const lines: string[][] = [];
	let currentLine: string[] = [words[0].text];
	let lastMaxY = words[0].maxY;
	let lastMinY = words[0].minY;

	for (let i = 1; i < words.length; i++) {
		const word = words[i];
		const prevLineHeight = lastMaxY - lastMinY;
		const yGap = word.minY - lastMaxY;

		// New line if significant y-gap relative to line height
		if (yGap > prevLineHeight * 0.3) {
			lines.push(currentLine);
			currentLine = [word.text];
		} else {
			currentLine.push(word.text);
		}

		lastMinY = Math.min(lastMinY, word.minY);
		lastMaxY = Math.max(lastMaxY, word.maxY);
	}
	lines.push(currentLine);

	return lines.map(line => line.join(' ')).join('\n');
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

			const data = await callVisionApi(config.apiKey, imageB64);
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
