/**
 * Test: preprocess calendar cells (contrast enhance + binarize) before OCR.
 * Traditional HTR systems always work on high-contrast binary images.
 * The raw photo is pencil on beige — terrible contrast. Let's fix that.
 *
 * Usage: npx tsx --env-file=.env scripts/test-preprocessed-ocr.ts
 */
import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';
import { cropRegion } from '../src/lib/image/crop.js';
import { createClaudeVisionAdapter } from '../src/lib/ocr/vendors/claude-vision.js';
import { createGoogleVisionAdapter } from '../src/lib/ocr/vendors/google-vision.js';
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

async function preprocessCell(cellBuffer: Buffer): Promise<Buffer> {
	// 1. Grayscale
	// 2. Normalize (stretch contrast to full 0-255 range)
	// 3. Sharpen
	// 4. High contrast via gamma + linear stretch
	return sharp(cellBuffer)
		.grayscale()
		.normalize()
		.sharpen({ sigma: 1.5 })
		.linear(1.8, -80)  // increase contrast, darken midtones
		.toBuffer();
}

async function binarizeCell(cellBuffer: Buffer): Promise<Buffer> {
	// Adaptive-style binarization: grayscale → normalize → threshold
	return sharp(cellBuffer)
		.grayscale()
		.normalize()
		.sharpen({ sigma: 1.5 })
		.threshold(140)  // everything below 140 → black, above → white
		.toBuffer();
}

const CELL_PROMPT =
	'Transcribe this handwritten calendar day entry exactly as written. ' +
	'This is from a family calendar. Common names include Rebekah, Gaylon, Dagny, Sophia, Benjamin, Caleb, Sather, Carmen. ' +
	'Common activities include Nordac Track, Seminary, CFM, Study, Walk. ' +
	'Preserve line breaks. Output only the transcribed text.';

const FULL_PAGE_PROMPT = (date: string) =>
	`This is a photo of a handwritten family calendar page (January 2022). ` +
	`Common names: Rebekah, Gaylon, Dagny, Sophia, Benjamin, Caleb, Sather, Carmen, Rob, Lisa, Bruce, Clark. ` +
	`Common activities: Nordac Track, Seminary, CFM, Study, Walk, Weights. ` +
	`Read the handwritten entry for ${date}. ` +
	`Transcribe it exactly as written, preserving line breaks. Output only the text for that one day.`;

async function main() {
	const claudeKey = process.env.ANTHROPIC_API_KEY;
	const visionKey = process.env.GOOGLE_VISION_API_KEY;
	if (!claudeKey || !visionKey) throw new Error('Need ANTHROPIC_API_KEY and GOOGLE_VISION_API_KEY');

	const claude = createClaudeVisionAdapter({ apiKey: claudeKey, model: 'claude-sonnet-4-6' });
	const vision = createGoogleVisionAdapter({ apiKey: visionKey });

	const raw = await readFile(process.env.HOME + '/Lumix Tether/20260525/P1034702.jpg');
	const pageBuffer = await sharp(raw).rotate().toBuffer();

	const testDates = ['2022-01-05', '2022-01-12', '2022-01-17'];

	const dayRes = await pool.query<{
		id: number; entry_date: string;
		crop_bounds: { x: number; y: number; width: number; height: number };
	}>(`SELECT id, entry_date::text AS entry_date, crop_bounds
	      FROM calendar_days WHERE page_id = 1 AND entry_date = ANY($1)
	     ORDER BY entry_date`, [testDates]);

	for (const day of dayRes.rows) {
		console.log(`\n${'='.repeat(70)}`);
		console.log(`DAY: ${day.entry_date}`);
		console.log('='.repeat(70));

		const cellBuffer = await cropRegion(pageBuffer, day.crop_bounds);
		const preprocessed = await preprocessCell(cellBuffer);
		const binarized = await binarizeCell(cellBuffer);

		// Save preprocessed images for visual inspection
		const dateStr = day.entry_date.replace(/-/g, '');
		await writeFile(`/tmp/cell-raw-${dateStr}.jpg`, cellBuffer);
		await writeFile(`/tmp/cell-enhanced-${dateStr}.jpg`, preprocessed);
		await writeFile(`/tmp/cell-binary-${dateStr}.jpg`, binarized);

		// Claude on raw cell
		console.log('\n--- Claude: raw cell ---');
		try {
			const r = await claude.transcribe(
				{ image: cellBuffer, mimeType: 'image/jpeg', sourceImagePath: 'test' },
				{ mode: 'cell', prompt: CELL_PROMPT }
			);
			console.log(`[${r.latencyMs}ms] ${r.text}`);
		} catch (e) { console.log('ERROR:', e instanceof Error ? e.message : e); }

		// Claude on enhanced cell
		console.log('\n--- Claude: contrast-enhanced cell ---');
		try {
			const r = await claude.transcribe(
				{ image: preprocessed, mimeType: 'image/jpeg', sourceImagePath: 'test' },
				{ mode: 'cell', prompt: CELL_PROMPT }
			);
			console.log(`[${r.latencyMs}ms] ${r.text}`);
		} catch (e) { console.log('ERROR:', e instanceof Error ? e.message : e); }

		// Claude on binarized cell
		console.log('\n--- Claude: binarized cell ---');
		try {
			const r = await claude.transcribe(
				{ image: binarized, mimeType: 'image/jpeg', sourceImagePath: 'test' },
				{ mode: 'cell', prompt: CELL_PROMPT }
			);
			console.log(`[${r.latencyMs}ms] ${r.text}`);
		} catch (e) { console.log('ERROR:', e instanceof Error ? e.message : e); }

		// Claude on full page with family-context prompt
		console.log('\n--- Claude: full page + family context prompt ---');
		try {
			const dateLabel = new Date(day.entry_date + 'T00:00:00').toLocaleDateString('en-US', {
				weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
			});
			const r = await claude.transcribe(
				{ image: pageBuffer, mimeType: 'image/jpeg', sourceImagePath: 'test' },
				{ mode: 'cell', prompt: FULL_PAGE_PROMPT(dateLabel) }
			);
			console.log(`[${r.latencyMs}ms] ${r.text}`);
		} catch (e) { console.log('ERROR:', e instanceof Error ? e.message : e); }

		// Google Vision on binarized cell
		console.log('\n--- Google Vision: binarized cell ---');
		try {
			const r = await vision.transcribe(
				{ image: binarized, mimeType: 'image/jpeg', sourceImagePath: 'test' },
				{ mode: 'cell' }
			);
			console.log(`[${r.latencyMs}ms, conf=${r.confidence?.toFixed(2)}] ${r.text}`);
		} catch (e) { console.log('ERROR:', e instanceof Error ? e.message : e); }
	}

	console.log('\nPreprocessed images saved to /tmp/cell-{raw,enhanced,binary}-*.jpg');
	await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
