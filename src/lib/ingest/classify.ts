/**
 * Calendar page classification: full-page Google Vision OCR + token geometry
 * → proposed month/year + confidence.
 *
 * The shared google-vision adapter (src/lib/ocr/vendors) returns only flat text
 * and an averaged confidence; classification needs word geometry to tell the
 * big printed header apart from small adjacent-month thumbnails and stray body
 * text, so this module makes its own DOCUMENT_TEXT_DETECTION call and reads
 * `textAnnotations` (flat words + bounding polys).
 *
 * Strategy (calibrated against real samples 2026-05-30):
 *   1. Pick the most prominent (tallest) YEAR token in a page-edge header band.
 *   2. Accept a MONTH only if a month token sits ADJACENT to that year (real
 *      headers put month+year together). This rejects thumbnail months
 *      ("DECEMBER 2021" on a January page) and stray body words ("may").
 *   3. Year-but-no-month is reported as `medium`, never a confidently-wrong
 *      month. Full-text regex is a last-resort fallback only when geometry
 *      finds no year at all.
 * See docs/2026-05-29-capture-intake-pipeline.md § Classification Algorithm.
 */
import sharp from 'sharp';

const VISION_ENDPOINT = 'https://vision.googleapis.com/v1/images:annotate';

// Classification only needs the printed header legible; downscale to bound the
// request payload and latency. Quality assessment runs on the full-res original.
const CLASSIFY_LONG_EDGE = 2800;

// A token is "in the header band" if its vertical centroid is in the top or
// bottom fraction of the page.
const HEADER_BAND_PCT = 0.2;

// A month token counts as part of the header only if it is at least this tall
// relative to the chosen year token (rejects small thumbnail months)...
const MONTH_MIN_HEIGHT_RATIO = 0.4;
// ...and within this many year-token-heights of it vertically (same header).
const MONTH_MAX_CY_GAP_RATIO = 3;

export type Confidence = 'high' | 'medium' | 'low';

export interface ClassificationResult {
	year: number | null;
	month: number | null;
	confidence: Confidence;
	/** Full plain-text OCR (stored for audit / future re-parsing). */
	fullText: string;
	/** Mean per-word OCR confidence from Vision, 0-1, or null if unavailable. */
	wordConfidence: number | null;
	notes: string | null;
}

interface Vertex {
	x?: number;
	y?: number;
}

interface VisionWord {
	description: string;
	boundingPoly?: { vertices?: Vertex[] };
}

interface VisionAnnotateResponse {
	responses: Array<{
		fullTextAnnotation?: {
			text?: string;
			pages?: Array<{
				blocks?: Array<{
					paragraphs?: Array<{ words?: Array<{ confidence?: number }> }>;
				}>;
			}>;
		};
		textAnnotations?: VisionWord[];
		error?: { code: number; message: string };
	}>;
}

const MONTH_MAP: Record<string, number> = {
	january: 1, jan: 1,
	february: 2, feb: 2,
	march: 3, mar: 3,
	april: 4, apr: 4,
	may: 5,
	june: 6, jun: 6,
	july: 7, jul: 7,
	august: 8, aug: 8,
	september: 9, sep: 9, sept: 9,
	october: 10, oct: 10,
	november: 11, nov: 11,
	december: 12, dec: 12
};

const MONTH_NAME_RE = Object.keys(MONTH_MAP).sort((a, b) => b.length - a.length).join('|');

/** Two-digit year disambiguation: 60-99 → 19xx, 00-30 → 20xx, else null. */
function expandTwoDigitYear(yy: number): number | null {
	if (yy >= 60 && yy <= 99) return 1900 + yy;
	if (yy >= 0 && yy <= 30) return 2000 + yy;
	return null;
}

function normalizeYear(raw: string): number | null {
	const clean = raw.replace(/'/g, '');
	const n = parseInt(clean, 10);
	if (Number.isNaN(n)) return null;
	if (clean.length === 4) return n >= 1960 && n <= 2030 ? n : null;
	if (clean.length <= 2) return expandTwoDigitYear(n);
	return null;
}

interface Token {
	text: string;
	cx: number;
	cy: number;
	height: number;
}

function toToken(word: VisionWord): Token | null {
	const vs = word.boundingPoly?.vertices;
	if (!vs || vs.length === 0) return null;
	const xs = vs.map((v) => v.x ?? 0);
	const ys = vs.map((v) => v.y ?? 0);
	const minY = Math.min(...ys);
	const maxY = Math.max(...ys);
	return {
		text: word.description,
		cx: (Math.min(...xs) + Math.max(...xs)) / 2,
		cy: (minY + maxY) / 2,
		height: maxY - minY
	};
}

const alpha = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');

interface ParseHit {
	year: number;
	month: number | null;
}

/** Last-resort regex cascade over plain text (only when geometry finds no year). */
function parseMonthYearText(text: string): ParseHit | null {
	const lower = text.toLowerCase();

	const named = lower.match(new RegExp(`\\b(${MONTH_NAME_RE})\\.?\\s+('?\\d{2}(?:\\d{2})?)\\b`));
	if (named) {
		const month = MONTH_MAP[named[1]];
		const year = normalizeYear(named[2]);
		if (year && month) return { year, month };
	}

	const numeric = lower.match(/\b(0?[1-9]|1[0-2])[/\-.](\d{4}|\d{2})\b/);
	if (numeric) {
		const month = parseInt(numeric[1], 10);
		const year = normalizeYear(numeric[2]);
		if (year && month >= 1 && month <= 12) return { year, month };
	}

	const bareYear = lower.match(/\b(19[6-9]\d|20[0-2]\d|2030)\b/);
	if (bareYear) {
		const year = normalizeYear(bareYear[1]);
		if (year) return { year, month: null };
	}
	return null;
}

/** Mean per-word OCR confidence from the structured annotation, 0-1 or null. */
function meanWordConfidence(resp: VisionAnnotateResponse['responses'][0]): number | null {
	let sum = 0;
	let count = 0;
	for (const page of resp.fullTextAnnotation?.pages ?? []) {
		for (const block of page.blocks ?? []) {
			for (const para of block.paragraphs ?? []) {
				for (const w of para.words ?? []) {
					if (typeof w.confidence === 'number') {
						sum += w.confidence;
						count++;
					}
				}
			}
		}
	}
	return count > 0 ? sum / count : null;
}

interface GeometryHit extends ParseHit {
	yearInBand: boolean;
}

/**
 * Geometry-based header detection: most prominent in-band year, plus an
 * adjacent month if one is present and prominent. Returns null if no usable
 * year token exists at all.
 */
function classifyByGeometry(tokens: Token[], imgHeight: number): GeometryHit | null {
	const topCut = imgHeight * HEADER_BAND_PCT;
	const bottomCut = imgHeight * (1 - HEADER_BAND_PCT);
	const inBand = (cy: number) => cy <= topCut || cy >= bottomCut;

	// Candidate year tokens (bare 4/2-digit) and numeric MM/YYYY tokens.
	interface YearTok extends Token {
		year: number;
		month: number | null; // set for MM/YYYY numeric tokens
	}
	const yearToks: YearTok[] = [];
	for (const t of tokens) {
		const numeric = t.text.match(/^(0?[1-9]|1[0-2])[/\-.](\d{4}|\d{2})$/);
		if (numeric) {
			const y = normalizeYear(numeric[2]);
			if (y) {
				yearToks.push({ ...t, year: y, month: parseInt(numeric[1], 10) });
				continue;
			}
		}
		// Only 4-digit ("1991") or apostrophe-prefixed 2-digit ("'91") count as a
		// bare year. A lone 2-digit number on a calendar is almost always a day.
		if (/^\d{4}$/.test(t.text) || /^'\d{2}$/.test(t.text)) {
			const y = normalizeYear(t.text);
			if (y) yearToks.push({ ...t, year: y, month: null });
		}
	}
	if (yearToks.length === 0) return null;

	// Prefer the tallest year token inside a header band; else the tallest anywhere.
	const banded = yearToks.filter((t) => inBand(t.cy));
	const pool = banded.length > 0 ? banded : yearToks;
	const yearTok = pool.reduce((a, b) => (b.height > a.height ? b : a));

	// Numeric token already carries its own month.
	if (yearTok.month !== null) {
		return { year: yearTok.year, month: yearTok.month, yearInBand: inBand(yearTok.cy) };
	}

	// Find a month token adjacent to the chosen year (same header), prominent enough.
	const monthToks = tokens
		.map((t) => ({ t, m: MONTH_MAP[alpha(t.text)] }))
		.filter((x) => x.m !== undefined)
		.filter((x) => x.t.height >= yearTok.height * MONTH_MIN_HEIGHT_RATIO)
		.filter((x) => Math.abs(x.t.cy - yearTok.cy) <= yearTok.height * MONTH_MAX_CY_GAP_RATIO);

	if (monthToks.length === 0) {
		return { year: yearTok.year, month: null, yearInBand: inBand(yearTok.cy) };
	}
	// Closest such month to the year wins.
	const best = monthToks.reduce((a, b) =>
		Math.abs(b.t.cy - yearTok.cy) < Math.abs(a.t.cy - yearTok.cy) ? b : a
	);
	return { year: yearTok.year, month: best.m, yearInBand: inBand(yearTok.cy) };
}

/**
 * Classify a calendar page image. `image` is the original file bytes; this
 * function EXIF-normalizes and downscales internally before the Vision call.
 */
export async function classifyImage(
	image: Buffer,
	opts: { apiKey: string }
): Promise<ClassificationResult> {
	const normalized = await sharp(image)
		.rotate()
		.resize({ width: CLASSIFY_LONG_EDGE, height: CLASSIFY_LONG_EDGE, fit: 'inside', withoutEnlargement: true })
		.jpeg({ quality: 90 })
		.toBuffer();
	const meta = await sharp(normalized).metadata();
	const height = meta.height ?? 0;

	const res = await fetch(`${VISION_ENDPOINT}?key=${opts.apiKey}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			requests: [
				{
					image: { content: normalized.toString('base64') },
					features: [{ type: 'DOCUMENT_TEXT_DETECTION' }]
				}
			]
		})
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Google Vision ${res.status}: ${body}`);
	}

	const data: VisionAnnotateResponse = await res.json();
	const resp = data.responses?.[0];
	if (!resp) {
		return { year: null, month: null, confidence: 'low', fullText: '', wordConfidence: null, notes: 'Empty Vision response' };
	}
	if (resp.error) {
		throw new Error(`Google Vision error ${resp.error.code}: ${resp.error.message}`);
	}

	const fullText = (resp.fullTextAnnotation?.text ?? '').trim();
	const wordConfidence = meanWordConfidence(resp);
	const conf = wordConfidence ?? 0;

	// textAnnotations[0] is the whole-image text; words start at index 1.
	const tokens = (resp.textAnnotations ?? [])
		.slice(1)
		.map(toToken)
		.filter((t): t is Token => t !== null);

	const geo = height > 0 ? classifyByGeometry(tokens, height) : null;

	if (geo) {
		const hasMonth = geo.month !== null;
		let confidence: Confidence;
		let notes: string | null = null;
		if (hasMonth && geo.yearInBand && conf > 0.5) {
			confidence = 'high';
		} else if (hasMonth) {
			confidence = 'medium';
			notes = geo.yearInBand ? `Low OCR confidence (${conf.toFixed(2)})` : 'Header found outside page edge';
		} else {
			confidence = 'medium';
			notes = 'Month not detected near header year — confirm manually';
		}
		return { year: geo.year, month: geo.month, confidence, fullText, wordConfidence, notes };
	}

	// Fallback: no year token at all — try a plain-text regex pass, low confidence.
	const textHit = parseMonthYearText(fullText);
	if (textHit) {
		return {
			year: textHit.year,
			month: textHit.month,
			confidence: 'low',
			fullText,
			wordConfidence,
			notes: 'No header year located by geometry; parsed from text'
		};
	}

	return { year: null, month: null, confidence: 'low', fullText, wordConfidence, notes: 'No month/year found in OCR text' };
}
