/**
 * Quick test: compare Google Vision vs Claude Vision on a few calendar day cells.
 * Crops cells from the page image using stored crop_bounds, sends to both vendors.
 *
 * Usage: npx tsx --env-file=.env scripts/test-claude-ocr.ts
 */
import sharp from 'sharp';
import { cropRegion } from '../src/lib/image/crop.js';
import { createGoogleVisionAdapter } from '../src/lib/ocr/vendors/google-vision.js';
import { createClaudeVisionAdapter } from '../src/lib/ocr/vendors/claude-vision.js';
import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
	host: process.env.PGHOST ?? '127.0.0.1',
	port: Number(process.env.PGPORT ?? 5435),
	database: process.env.PGDATABASE ?? 'madonnahist',
	user: process.env.PGUSER ?? 'madonnahist_app',
	password: process.env.PGPASSWORD,
	max: 2
});

// Also test sending the FULL PAGE to Claude with a prompt asking it to read a specific cell
const FULL_PAGE_PROMPT = (date: string) =>
	`This is a photo of a handwritten family calendar page. ` +
	`Read the handwritten entry for ${date}. ` +
	`Transcribe it exactly as written, preserving line breaks. ` +
	`Output only the transcribed text for that one day, nothing else.`;

async function main() {
	const visionKey = process.env.GOOGLE_VISION_API_KEY;
	const claudeKey = process.env.ANTHROPIC_API_KEY;
	if (!visionKey) throw new Error('Set GOOGLE_VISION_API_KEY');
	if (!claudeKey) throw new Error('Set ANTHROPIC_API_KEY');

	const vision = createGoogleVisionAdapter({ apiKey: visionKey });
	const claude = createClaudeVisionAdapter({ apiKey: claudeKey, model: 'claude-sonnet-4-6' });

	// Get page image path
	const pageRes = await pool.query<{ page_image_path: string }>(
		`SELECT page_image_path FROM calendar_pages WHERE id = 1`
	);
	const pageKey = pageRes.rows[0].page_image_path;

	// For this test, read the local tether file instead of downloading from Spaces
	const { readFile } = await import('node:fs/promises');
	const raw = await readFile(process.env.HOME + '/Lumix Tether/20260525/P1034702.jpg');
	const pageBuffer = await sharp(raw).rotate().toBuffer();

	// Test days: pick a few with varying content density
	const testDates = ['2022-01-03', '2022-01-05', '2022-01-10', '2022-01-12', '2022-01-17'];

	const dayRes = await pool.query<{
		id: number; entry_date: string;
		crop_bounds: { x: number; y: number; width: number; height: number };
	}>(`SELECT id, entry_date::text AS entry_date, crop_bounds
	      FROM calendar_days
	     WHERE page_id = 1 AND entry_date = ANY($1)
	     ORDER BY entry_date`,
		[testDates]
	);

	for (const day of dayRes.rows) {
		console.log(`\n${'='.repeat(70)}`);
		console.log(`DAY: ${day.entry_date}`);
		console.log('='.repeat(70));

		const cellBuffer = await cropRegion(pageBuffer, day.crop_bounds);

		// Google Vision on the cell crop
		console.log('\n--- Google Vision (cell crop) ---');
		try {
			const vResult = await vision.transcribe(
				{ image: cellBuffer, mimeType: 'image/jpeg', sourceImagePath: 'test' },
				{ mode: 'cell' }
			);
			console.log(`[${vResult.latencyMs}ms, conf=${vResult.confidence?.toFixed(2)}]`);
			console.log(vResult.text);
		} catch (err) {
			console.log('ERROR:', err instanceof Error ? err.message : err);
		}

		// Claude Vision on the cell crop
		console.log('\n--- Claude Vision (cell crop) ---');
		try {
			const cResult = await claude.transcribe(
				{ image: cellBuffer, mimeType: 'image/jpeg', sourceImagePath: 'test' },
				{ mode: 'cell' }
			);
			console.log(`[${cResult.latencyMs}ms]`);
			console.log(cResult.text);
		} catch (err) {
			console.log('ERROR:', err instanceof Error ? err.message : err);
		}

		// Claude Vision on FULL PAGE with targeted prompt
		console.log('\n--- Claude Vision (full page, targeted prompt) ---');
		try {
			const dateStr = new Date(day.entry_date + 'T00:00:00').toLocaleDateString('en-US', {
				weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
			});
			const cFull = await claude.transcribe(
				{ image: pageBuffer, mimeType: 'image/jpeg', sourceImagePath: 'test' },
				{ mode: 'cell', prompt: FULL_PAGE_PROMPT(dateStr) }
			);
			console.log(`[${cFull.latencyMs}ms]`);
			console.log(cFull.text);
		} catch (err) {
			console.log('ERROR:', err instanceof Error ? err.message : err);
		}
	}

	await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
