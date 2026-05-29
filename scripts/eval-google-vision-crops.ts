import { readFileSync } from 'fs';
import { resolve } from 'path';
import { createGoogleVisionAdapter } from '../src/lib/ocr/vendors/google-vision.js';

const CROP_DIR = resolve('output/gridline-crop');
const GOLD_PATH = resolve('test-data/gold.json');

const gold = JSON.parse(readFileSync(GOLD_PATH, 'utf-8'))['1991-03.jpg'] as Record<string, string>;
const cells = Object.keys(gold); // r0c1..r0c5

const apiKey = process.env.GOOGLE_VISION_API_KEY;
if (!apiKey) {
	throw new Error('Set GOOGLE_VISION_API_KEY in .env');
}

const adapter = createGoogleVisionAdapter({ apiKey });

console.log(`Testing ${cells.length} cells against gold (Google Vision DOCUMENT_TEXT_DETECTION)\n`);

for (const cell of cells) {
	const imgPath = resolve(CROP_DIR, `${cell}.jpg`);
	const image = readFileSync(imgPath);

	console.log(`--- ${cell} ---`);
	const result = await adapter.transcribe(
		{ image, mimeType: 'image/jpeg', sourceImagePath: imgPath },
		undefined
	);

	const meta = result.vendorMeta as { wordCount: number };
	const conf = result.confidence !== null ? `${(result.confidence * 100).toFixed(1)}%` : 'n/a';
	console.log(`  Google Vision (${result.latencyMs}ms, ${meta.wordCount} words, conf: ${conf}):`);
	console.log(`    ${result.text.replace(/\n/g, '\n    ')}`);
	console.log(`  Gold:`);
	console.log(`    ${gold[cell]}`);
	console.log();
}
