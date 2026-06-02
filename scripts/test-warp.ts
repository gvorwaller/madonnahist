/**
 * Test the perspective warp on the actual calendar image.
 * Usage: npx tsx scripts/test-warp.ts
 */
import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';
import { perspectiveWarp, validateCorners, type Point } from '../src/lib/image/perspective.js';

async function main() {
	const raw = await readFile(process.env.HOME + '/Lumix Tether/20260525/P1034702.jpg');
	const normalized = await sharp(raw).rotate().toBuffer();
	const meta = await sharp(normalized).metadata();
	console.log(`Source image: ${meta.width} x ${meta.height}`);

	// Approximate corners of the calendar grid (from manual measurement)
	const corners: [Point, Point, Point, Point] = [
		{ x: 350, y: 870 },    // topLeft
		{ x: 5450, y: 870 },   // topRight
		{ x: 5450, y: 3820 },  // bottomRight
		{ x: 350, y: 3820 }    // bottomLeft
	];

	const valError = validateCorners(corners, meta.width!, meta.height!);
	if (valError) {
		console.error('Validation error:', valError);
		return;
	}
	console.log('Corners validated OK');

	console.log('Starting warp...');
	const start = performance.now();
	const result = await perspectiveWarp(normalized, corners);
	const elapsed = Math.round(performance.now() - start);
	console.log(`Warp complete: ${result.width} x ${result.height}, ${elapsed}ms`);
	console.log(`Output buffer: ${result.buffer.length} bytes`);

	await writeFile('/tmp/warped-test.jpg', result.buffer);
	console.log('Saved to /tmp/warped-test.jpg');

	// Also test with slightly skewed corners (simulate real perspective)
	const skewedCorners: [Point, Point, Point, Point] = [
		{ x: 380, y: 880 },    // topLeft - slightly inward
		{ x: 5420, y: 860 },   // topRight - slightly higher
		{ x: 5460, y: 3830 },  // bottomRight - slightly outward
		{ x: 340, y: 3810 }    // bottomLeft - slightly outward
	];

	console.log('\nStarting skewed warp...');
	const start2 = performance.now();
	const result2 = await perspectiveWarp(normalized, skewedCorners);
	const elapsed2 = Math.round(performance.now() - start2);
	console.log(`Skewed warp complete: ${result2.width} x ${result2.height}, ${elapsed2}ms`);

	await writeFile('/tmp/warped-skewed-test.jpg', result2.buffer);
	console.log('Saved to /tmp/warped-skewed-test.jpg');
}

main().catch(err => { console.error(err); process.exit(1); });
