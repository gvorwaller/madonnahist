/**
 * Image quality assessment for calendar page captures — sharpness (global +
 * corners), exposure (mean + clipping), contrast. No external dependencies;
 * Sharp only. See docs/2026-05-29-capture-intake-pipeline.md § Image Quality.
 *
 * All metrics are measured on an EXIF-normalized image downscaled to a fixed
 * ANALYSIS_LONG_EDGE so that scale-dependent scores (notably Laplacian
 * sharpness) are comparable across captures regardless of source resolution.
 * THRESHOLDS below are initial estimates — calibrate against real rig captures
 * (implementation sequence step 6) and adjust here, not at call sites.
 */
import sharp from 'sharp';

const ANALYSIS_LONG_EDGE = 1500;

// Laplacian kernel — convolution stdev is a blur proxy (higher = sharper).
const LAPLACIAN = { width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0] };

// Each corner crop is this fraction of width/height; min corner score catches
// edge softness that a global average would hide.
const CORNER_FRAC = 0.12;

export interface QualityThresholds {
	sharpnessAdvised: number; // below → reshoot_advised
	sharpnessRequired: number; // below → reshoot_required
	cornerRequired: number; // worst-corner below → reshoot_required
	exposureMeanLow: number; // below → advised (too dark)
	exposureMeanHigh: number; // above → advised (too bright)
	exposureMeanCriticalLow: number; // below → required
	exposureMeanCriticalHigh: number; // above → required
	clippedPctRequired: number; // above → required
	contrastAdvised: number; // below → advised (washed out)
	expectedDims: Array<{ w: number; h: number; label: string }>;
	dimTolerancePct: number;
}

// Calibrated against 4 real sample captures 2026-05-30 (1991-2022); refine
// further once true rig captures exist. Key learnings baked in below:
//  - clippedPctRequired raised to 20%: calendar pages are mostly white paper,
//    so a large fraction of pixels legitimately sits near 255.
//  - cornerRequired is RECORDED but no longer drives the verdict (see
//    assessQuality): blank white cells give near-zero Laplacian variance,
//    indistinguishable from blur, so an absolute corner threshold false-flags
//    sharp pages. Content-aware corner focus is deferred to Phase 2.
export const DEFAULT_THRESHOLDS: QualityThresholds = {
	sharpnessAdvised: 25,
	sharpnessRequired: 12,
	cornerRequired: 8,
	exposureMeanLow: 60,
	exposureMeanHigh: 205,
	exposureMeanCriticalLow: 30,
	exposureMeanCriticalHigh: 235,
	clippedPctRequired: 20,
	contrastAdvised: 20,
	// G9 II standard JPG ~5776x4336; High Res Mode ~8192x6144. Either orientation.
	expectedDims: [
		{ w: 5776, h: 4336, label: 'standard' },
		{ w: 8192, h: 6144, label: 'high-res' }
	],
	dimTolerancePct: 5
};

export type QualityVerdict = 'good' | 'reshoot_advised' | 'reshoot_required';

export interface QualityResult {
	sharpnessScore: number;
	sharpnessCornerMin: number;
	exposureMean: number;
	exposureClippedPct: number;
	contrastScore: number;
	width: number;
	height: number;
	verdict: QualityVerdict;
	notes: string | null;
}

/** Laplacian-convolution stdev of a (sub)image buffer. Higher = sharper. */
async function sharpnessOf(buf: Buffer): Promise<number> {
	const { channels } = await sharp(buf).grayscale().convolve(LAPLACIAN).stats();
	return channels[0]?.stdev ?? 0;
}

interface ExposureStats {
	mean: number;
	stdev: number;
	clippedPct: number;
}

/** Mean brightness, luminance stdev (contrast), and clipped-pixel % in one pass. */
async function exposureOf(buf: Buffer): Promise<ExposureStats> {
	const { data, info } = await sharp(buf).grayscale().raw().toBuffer({ resolveWithObject: true });
	const total = info.width * info.height;
	if (total === 0) return { mean: 0, stdev: 0, clippedPct: 0 };

	let sum = 0;
	let clipped = 0;
	for (let i = 0; i < total; i++) {
		const v = data[i];
		sum += v;
		if (v < 5 || v > 250) clipped++;
	}
	const mean = sum / total;

	let sqSum = 0;
	for (let i = 0; i < total; i++) {
		const d = data[i] - mean;
		sqSum += d * d;
	}
	const stdev = Math.sqrt(sqSum / total);
	const clippedPct = (clipped / total) * 100;

	return { mean, stdev, clippedPct };
}

function dimsLookRight(w: number, h: number, t: QualityThresholds): boolean {
	const tol = t.dimTolerancePct / 100;
	const within = (a: number, b: number) => Math.abs(a - b) / b <= tol;
	return t.expectedDims.some(
		(d) =>
			(within(w, d.w) && within(h, d.h)) || // landscape
			(within(w, d.h) && within(h, d.w)) // portrait
	);
}

/**
 * Assess capture quality. `image` is the original file bytes (full resolution);
 * this function EXIF-normalizes and downscales to the analysis resolution.
 * Dimensions reported are the ORIGINAL (pre-downscale) pixel dimensions, so the
 * resolution check reflects what the camera actually produced.
 */
export async function assessQuality(
	image: Buffer,
	thresholds: QualityThresholds = DEFAULT_THRESHOLDS
): Promise<QualityResult> {
	const origMeta = await sharp(image).rotate().metadata();
	const width = origMeta.width ?? 0;
	const height = origMeta.height ?? 0;

	const analysis = await sharp(image)
		.rotate()
		.resize({ width: ANALYSIS_LONG_EDGE, height: ANALYSIS_LONG_EDGE, fit: 'inside', withoutEnlargement: true })
		.toBuffer();
	const aMeta = await sharp(analysis).metadata();
	const aw = aMeta.width ?? 0;
	const ah = aMeta.height ?? 0;

	const sharpnessScore = await sharpnessOf(analysis);

	// Four corner crops; the worst one is the reported corner score.
	const cw = Math.max(1, Math.floor(aw * CORNER_FRAC));
	const ch = Math.max(1, Math.floor(ah * CORNER_FRAC));
	const corners = [
		{ left: 0, top: 0 },
		{ left: aw - cw, top: 0 },
		{ left: 0, top: ah - ch },
		{ left: aw - cw, top: ah - ch }
	];
	const cornerScores = await Promise.all(
		corners.map(async (c) => {
			const crop = await sharp(analysis).extract({ left: c.left, top: c.top, width: cw, height: ch }).toBuffer();
			return sharpnessOf(crop);
		})
	);
	const sharpnessCornerMin = cornerScores.length ? Math.min(...cornerScores) : 0;

	const { mean: exposureMean, stdev: contrastScore, clippedPct: exposureClippedPct } =
		await exposureOf(analysis);

	// Verdict + human-readable notes (with values, per plan).
	const t = thresholds;
	const reasons: string[] = [];
	let verdict: QualityVerdict = 'good';

	const fail = (msg: string) => {
		reasons.push(msg);
		verdict = 'reshoot_required';
	};
	const warn = (msg: string) => {
		reasons.push(msg);
		if (verdict === 'good') verdict = 'reshoot_advised';
	};

	if (sharpnessScore < t.sharpnessRequired) fail(`Blurry (sharpness ${sharpnessScore.toFixed(1)}, threshold ${t.sharpnessRequired})`);
	else if (sharpnessScore < t.sharpnessAdvised) warn(`Soft (sharpness ${sharpnessScore.toFixed(1)}, threshold ${t.sharpnessAdvised})`);

	// Corner sharpness is recorded (sharpnessCornerMin) but intentionally does
	// NOT drive the verdict: blank white cells score near zero under the
	// Laplacian, indistinguishable from blur. Content-aware corner focus is a
	// Phase 2 refinement. cornerRequired is kept in config for that future use.
	void t.cornerRequired;

	if (exposureMean < t.exposureMeanCriticalLow) fail(`Severely underexposed (mean ${exposureMean.toFixed(0)})`);
	else if (exposureMean > t.exposureMeanCriticalHigh) fail(`Severely overexposed (mean ${exposureMean.toFixed(0)})`);
	else if (exposureMean < t.exposureMeanLow) warn(`Dark (mean ${exposureMean.toFixed(0)}, threshold ${t.exposureMeanLow})`);
	else if (exposureMean > t.exposureMeanHigh) warn(`Bright (mean ${exposureMean.toFixed(0)}, threshold ${t.exposureMeanHigh})`);

	if (exposureClippedPct > t.clippedPctRequired) fail(`Clipped pixels (${exposureClippedPct.toFixed(1)}% clipped, threshold ${t.clippedPctRequired}%)`);

	if (contrastScore < t.contrastAdvised) warn(`Low contrast (stdev ${contrastScore.toFixed(1)}, threshold ${t.contrastAdvised})`);

	// Resolution: warning only, never changes the verdict.
	if (width > 0 && height > 0 && !dimsLookRight(width, height, t)) {
		reasons.push(`Unexpected dimensions (${width}×${height})`);
	}

	return {
		sharpnessScore,
		sharpnessCornerMin,
		exposureMean,
		exposureClippedPct,
		contrastScore,
		width,
		height,
		verdict,
		notes: reasons.length ? reasons.join('; ') : null
	};
}
