import { readFileSync } from 'fs';
import { resolve } from 'path';
import { createClaudeVisionAdapter } from '../src/lib/ocr/vendors/claude-vision.js';

const CROP_DIR = resolve('output/gridline-crop');
const GOLD_PATH = resolve('test-data/gold.json');

const gold = JSON.parse(readFileSync(GOLD_PATH, 'utf-8'))['1991-03.jpg'] as Record<string, string>;
const cells = Object.keys(gold); // r0c1..r0c5

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
	throw new Error('Set ANTHROPIC_API_KEY');
}

const adapter = createClaudeVisionAdapter({ apiKey });

console.log(`Testing ${cells.length} cells against gold (Claude Vision, full resolution)\n`);

for (const cell of cells) {
	const imgPath = resolve(CROP_DIR, `${cell}.jpg`);
	const image = readFileSync(imgPath);

	console.log(`--- ${cell} ---`);
	const result = await adapter.transcribe(
		{ image, sourceImagePath: imgPath },
		undefined
	);

	console.log(`  OCR (${result.latencyMs}ms, ${(result.vendorMeta as any)?.inputTokens}+${(result.vendorMeta as any)?.outputTokens} tokens):`);
	console.log(`    ${result.text.replace(/\n/g, '\n    ')}`);
	console.log(`  Gold:`);
	console.log(`    ${gold[cell]}`);
	console.log();
}
