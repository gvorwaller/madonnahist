/**
 * Detect grid lines in a calendar page via edge COVERAGE — the fraction of
 * pixels along each row/column that show edge activity. Grid lines run the
 * full width or height; handwriting strokes are short. This distinguishes
 * them even when both produce similar edge intensities.
 *
 * Usage: npx tsx scripts/detect-grid.ts <image-path> [rows]
 */
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';

const imagePath = process.argv[2];
const expectedRows = Number(process.argv[3] ?? 5);
if (!imagePath) {
	console.error('Usage: npx tsx scripts/detect-grid.ts <image-path> [rows]');
	process.exit(1);
}

async function main() {
	const raw = await readFile(imagePath);
	const normalized = await sharp(raw).rotate().toBuffer();
	const meta = await sharp(normalized).metadata();
	const W = meta.width!;
	const H = meta.height!;
	console.log(`Image: ${W} x ${H}`);

	const scale = 0.25;
	const sw = Math.round(W * scale);
	const sh = Math.round(H * scale);

	const { data } = await sharp(normalized)
		.resize(sw, sh)
		.grayscale()
		.raw()
		.toBuffer({ resolveWithObject: true });

	console.log(`Working at ${sw} x ${sh}`);

	// Edge threshold — pixels with gradient above this are "edge pixels"
	const edgeThreshold = 15;

	// --- Horizontal line detection ---
	// For each ROW y, compute: what fraction of the row's columns have a
	// VERTICAL gradient (|pixel_above - pixel_below|) above threshold?
	// A horizontal grid line creates a band of vertical gradients across
	// most of the row width.
	const hCoverage = new Float64Array(sh);
	for (let y = 1; y < sh - 1; y++) {
		let edgeCount = 0;
		for (let x = 0; x < sw; x++) {
			const above = data[(y - 1) * sw + x];
			const below = data[(y + 1) * sw + x];
			if (Math.abs(below - above) > edgeThreshold) edgeCount++;
		}
		hCoverage[y] = edgeCount / sw;
	}

	// --- Vertical line detection ---
	// For each COLUMN x, compute: what fraction of the column's rows have a
	// HORIZONTAL gradient (|pixel_left - pixel_right|) above threshold?
	const vCoverage = new Float64Array(sw);
	for (let x = 1; x < sw - 1; x++) {
		let edgeCount = 0;
		for (let y = 0; y < sh; y++) {
			const left = data[y * sw + (x - 1)];
			const right = data[y * sw + (x + 1)];
			if (Math.abs(right - left) > edgeThreshold) edgeCount++;
		}
		vCoverage[x] = edgeCount / sh;
	}

	// Smooth to reduce noise
	const hSmooth = smooth(hCoverage, 2);
	const vSmooth = smooth(vCoverage, 2);

	// Find peaks — these are rows/cols with highest edge coverage
	const hPeaks = findPeaks(hSmooth, sh, expectedRows + 4, 0.15);
	const vPeaks = findPeaks(vSmooth, sw, 10, 0.15);

	console.log(`\nHorizontal grid lines (${hPeaks.length}):`);
	for (const p of hPeaks) {
		const realY = Math.round(p.pos / scale);
		console.log(`  y=${realY}  coverage=${(p.value * 100).toFixed(1)}%`);
	}

	console.log(`\nVertical grid lines (${vPeaks.length}):`);
	for (const p of vPeaks) {
		const realX = Math.round(p.pos / scale);
		console.log(`  x=${realX}  coverage=${(p.value * 100).toFixed(1)}%`);
	}

	// Naive grid for reference
	const headerPx = Math.floor(H * 0.12);
	const gridH = H - headerPx;
	const cellH = Math.floor(gridH / expectedRows);
	const cellW = Math.floor(W / 7);
	console.log(`\nNaive uniform grid:`);
	for (let r = 0; r <= expectedRows; r++) console.log(`  h: y=${headerPx + r * cellH}`);
	for (let c = 0; c <= 7; c++) console.log(`  v: x=${c * cellW}`);

	// Profile dumps
	console.log('\nH-coverage profile:');
	const hMax = Math.max(...hSmooth);
	for (let y = 0; y < sh; y += Math.max(1, Math.floor(sh / 50))) {
		const bar = '#'.repeat(Math.floor((hSmooth[y] / Math.max(hMax, 0.001)) * 50));
		console.log(`  y=${String(Math.round(y / scale)).padStart(4)} ${(hSmooth[y] * 100).toFixed(1).padStart(5)}%: ${bar}`);
	}
	console.log('\nV-coverage profile:');
	const vMax = Math.max(...vSmooth);
	for (let x = 0; x < sw; x += Math.max(1, Math.floor(sw / 40))) {
		const bar = '#'.repeat(Math.floor((vSmooth[x] / Math.max(vMax, 0.001)) * 40));
		console.log(`  x=${String(Math.round(x / scale)).padStart(4)} ${(vSmooth[x] * 100).toFixed(1).padStart(5)}%: ${bar}`);
	}
}

function smooth(arr: Float64Array, radius: number): Float64Array {
	const out = new Float64Array(arr.length);
	for (let i = 0; i < arr.length; i++) {
		let sum = 0, count = 0;
		for (let k = -radius; k <= radius; k++) {
			const idx = i + k;
			if (idx >= 0 && idx < arr.length) { sum += arr[idx]; count++; }
		}
		out[i] = sum / count;
	}
	return out;
}

interface Peak { pos: number; value: number; }

function findPeaks(profile: Float64Array, length: number, maxPeaks: number, minCoverage: number): Peak[] {
	const minSpacing = Math.floor(length / (maxPeaks * 2.5));
	const peaks: Peak[] = [];

	for (let i = 2; i < length - 2; i++) {
		if (profile[i] < minCoverage) continue;
		if (profile[i] < profile[i - 1] || profile[i] < profile[i + 1]) continue;

		if (peaks.length === 0 || i - peaks[peaks.length - 1].pos >= minSpacing) {
			peaks.push({ pos: i, value: profile[i] });
		} else if (profile[i] > peaks[peaks.length - 1].value) {
			peaks[peaks.length - 1] = { pos: i, value: profile[i] };
		}
	}

	if (peaks.length > maxPeaks) {
		peaks.sort((a, b) => b.value - a.value);
		peaks.length = maxPeaks;
		peaks.sort((a, b) => a.pos - b.pos);
	}

	return peaks;
}

main().catch(err => { console.error(err); process.exit(1); });
