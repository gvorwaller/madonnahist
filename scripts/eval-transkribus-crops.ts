import { readFileSync } from 'fs';
import { resolve } from 'path';
import { createTranskribusAdapter } from '../src/lib/ocr/vendors/transkribus.js';

const CROP_DIR = resolve('output/gridline-crop');
const GOLD_PATH = resolve('test-data/gold.json');

const gold = JSON.parse(readFileSync(GOLD_PATH, 'utf-8'))['1991-03.jpg'] as Record<string, string>;
const cells = Object.keys(gold); // r0c1..r0c5

const email = process.env.TRANSKRIBUS_EMAIL;
const password = process.env.TRANSKRIBUS_PASSWORD;
if (!email || !password) {
	throw new Error('Set TRANSKRIBUS_EMAIL and TRANSKRIBUS_PASSWORD in .env');
}

const adapter = createTranskribusAdapter({ email, password });

console.log(`Testing ${cells.length} cells against gold (Transkribus Text Titan I ter)\n`);

for (const cell of cells) {
	const imgPath = resolve(CROP_DIR, `${cell}.jpg`);
	const image = readFileSync(imgPath);

	console.log(`--- ${cell} ---`);
	const result = await adapter.transcribe(
		{ image, mimeType: 'image/jpeg', sourceImagePath: imgPath },
		undefined
	);

	const meta = result.vendorMeta as { processId: number; lineCount: number };
	console.log(`  Transkribus (${result.latencyMs}ms, ${meta.lineCount} lines, pid:${meta.processId}):`);
	console.log(`    ${result.text.replace(/\n/g, '\n    ')}`);
	console.log(`  Gold:`);
	console.log(`    ${gold[cell]}`);
	console.log();
}
