/**
 * OCR evaluation CLI — runs production vendor adapters against local sample images
 * and produces a side-by-side HTML comparison report.
 *
 * Usage:
 *   npx tsx scripts/ocr-eval.ts --input test-data/samples/ --models qwen3-vl:32b
 *   npx tsx scripts/ocr-eval.ts --input test-data/samples/ --models qwen3-vl:32b,claude --gold test-data/gold.json
 */

import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { cropGrid, resizePage, type CropResult } from '../src/lib/image/crop.js';
import type { TranscribeInput, TranscribeResult, VendorAdapter } from '../src/lib/ocr/types.js';
import { createOllamaAdapter, checkOllamaModel } from '../src/lib/ocr/vendors/local-ollama.js';
import { createClaudeVisionAdapter } from '../src/lib/ocr/vendors/claude-vision.js';

// -- Page-mode prompt (eval-only, not in production prompts.ts) --

const PAGE_PROMPT =
	'This is a photograph of a handwritten monthly calendar page. ' +
	'Transcribe each day\'s entry. Return a JSON object where each key is the day number ' +
	'(as a string) and each value is the transcribed text for that day. ' +
	'Preserve line breaks within entries. If a day cell is empty, use an empty string. ' +
	'Output only the JSON object.';

// -- Types --

interface EvalResult {
	page: string;
	condition: 'page@2000' | 'page@4000' | 'grid-cell';
	cellLabel?: string;
	model: string;
	result: TranscribeResult;
}

interface GoldEntry {
	[cellLabel: string]: string;
}
type GoldData = Record<string, GoldEntry>;

// -- CLI --

const { values } = parseArgs({
	options: {
		input: { type: 'string', short: 'i' },
		models: { type: 'string', short: 'm' },
		gold: { type: 'string', short: 'g' },
		grid: { type: 'string', default: '5x7' },
		output: { type: 'string', short: 'o', default: 'output' },
		timeout: { type: 'string', short: 't', default: '1800' }
	},
	strict: true
});

if (!values.input || !values.models) {
	console.error('Usage: npx tsx scripts/ocr-eval.ts --input <dir> --models <model1,model2,...>');
	console.error('  --input   Directory containing sample page images (JPEG/TIFF/PNG)');
	console.error('  --models  Comma-separated model names. Use "claude" for Claude vision.');
	console.error('  --gold    Optional path to gold.json for reference comparison');
	console.error('  --grid    Grid dimensions (default: 5x7)');
	console.error('  --output  Output directory (default: output)');
	console.error('  --timeout Per-call timeout in seconds (default: 1800)');
	process.exit(1);
}

const inputDir = resolve(values.input);
const outputDir = resolve(values.output);
const modelNames = values.models.split(',').map((s) => s.trim());
const [gridRows, gridCols] = values.grid!.split('x').map(Number);
const timeoutSec = Number(values.timeout);

// -- Adapter factory --

async function warmOllamaModel(model: string, baseUrl = 'http://127.0.0.1:11434'): Promise<void> {
	const url = `${baseUrl.replace(/\/$/, '')}/api/generate`;
	console.log(`  Warming up ${model} (loading into memory)...`);
	const start = performance.now();
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ model, prompt: '', keep_alive: '30m' })
	});
	if (!res.ok) {
		console.warn(`  Warmup returned ${res.status} — proceeding anyway`);
	} else {
		await res.text();
	}
	console.log(`  Model ready (${Math.round(performance.now() - start)}ms)`);
}

async function buildAdapters(names: string[]): Promise<VendorAdapter[]> {
	const adapters: VendorAdapter[] = [];

	for (const name of names) {
		if (name === 'claude') {
			const apiKey = process.env.ANTHROPIC_API_KEY;
			if (!apiKey) {
				console.warn('  ANTHROPIC_API_KEY not set — skipping Claude adapter');
				continue;
			}
			adapters.push(createClaudeVisionAdapter({ apiKey }));
		} else {
			const available = await checkOllamaModel(name);
			if (!available) {
				console.error(`  Model "${name}" not found in Ollama. Run: ollama pull ${name}`);
				process.exit(1);
			}
			await warmOllamaModel(name);
			adapters.push(createOllamaAdapter({ model: name, timeoutMs: timeoutSec * 1000 }));
		}
	}

	return adapters;
}

// -- Image discovery --

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.tif', '.tiff', '.png']);

function mimeFor(ext: string): 'image/jpeg' | 'image/tiff' | 'image/png' {
	if (ext === '.tif' || ext === '.tiff') return 'image/tiff';
	if (ext === '.png') return 'image/png';
	return 'image/jpeg';
}

async function discoverImages(dir: string): Promise<string[]> {
	const entries = await readdir(dir);
	return entries
		.filter((f) => IMAGE_EXTS.has(extname(f).toLowerCase()))
		.sort()
		.map((f) => join(dir, f));
}

// -- Gold loading --

async function loadGold(path: string | undefined): Promise<GoldData> {
	if (!path) return {};
	try {
		const raw = await readFile(path, 'utf-8');
		return JSON.parse(raw);
	} catch {
		console.warn(`  Could not load gold file at ${path} — running without gold comparison`);
		return {};
	}
}

// -- Character-level diff (simple LCS-based) --

function charDiff(gold: string, actual: string): { html: string; errors: number } {
	const g = gold.replace(/\r\n/g, '\n');
	const a = actual.replace(/\r\n/g, '\n');

	if (g === a) return { html: `<span class="match">${escHtml(a)}</span>`, errors: 0 };

	const dp: number[][] = Array.from({ length: g.length + 1 }, () =>
		new Array(a.length + 1).fill(0)
	);
	for (let i = 1; i <= g.length; i++) {
		for (let j = 1; j <= a.length; j++) {
			dp[i][j] =
				g[i - 1] === a[j - 1]
					? dp[i - 1][j - 1] + 1
					: Math.max(dp[i - 1][j], dp[i][j - 1]);
		}
	}

	const parts: string[] = [];
	let i = g.length;
	let j = a.length;
	let errors = 0;
	const ops: Array<{ type: 'match' | 'del' | 'ins'; ch: string }> = [];

	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && g[i - 1] === a[j - 1]) {
			ops.push({ type: 'match', ch: g[i - 1] });
			i--;
			j--;
		} else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
			ops.push({ type: 'ins', ch: a[j - 1] });
			errors++;
			j--;
		} else {
			ops.push({ type: 'del', ch: g[i - 1] });
			errors++;
			i--;
		}
	}
	ops.reverse();

	let currentType = '';
	let currentChars = '';
	for (const op of ops) {
		if (op.type !== currentType) {
			if (currentChars) {
				parts.push(wrapDiffSpan(currentType, currentChars));
			}
			currentType = op.type;
			currentChars = '';
		}
		currentChars += op.ch;
	}
	if (currentChars) parts.push(wrapDiffSpan(currentType, currentChars));

	return { html: parts.join(''), errors };
}

function wrapDiffSpan(type: string, text: string): string {
	const escaped = escHtml(text);
	if (type === 'match') return `<span class="match">${escaped}</span>`;
	if (type === 'del') return `<span class="del">${escaped}</span>`;
	return `<span class="ins">${escaped}</span>`;
}

function escHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/\n/g, '<br>');
}

// -- Report generation --

function generateReport(
	results: EvalResult[],
	gold: GoldData,
	pageImages: Map<string, Buffer>
): string {
	const modelSet = [...new Set(results.map((r) => r.model))];
	const pages = [...new Set(results.map((r) => r.page))];

	let goldSummaryHtml = '';
	const goldErrors: Record<string, number> = {};
	for (const m of modelSet) goldErrors[m] = 0;

	if (Object.keys(gold).length > 0) {
		goldSummaryHtml += '<h2>Gold Cell Comparison</h2>';
		for (const page of pages) {
			const pageGold = gold[page] ?? gold[basename(page)] ?? gold[basename(page, extname(page))];
			if (!pageGold) continue;

			for (const [cellLabel, goldText] of Object.entries(pageGold)) {
				goldSummaryHtml += `<h3>${basename(page)} &mdash; ${cellLabel}</h3>`;
				goldSummaryHtml += `<div class="gold-ref"><strong>Gold:</strong> ${escHtml(goldText)}</div>`;

				for (const model of modelSet) {
					const match = results.find(
						(r) =>
							(r.page === page || basename(r.page) === page || basename(r.page, extname(r.page)) === page) &&
							r.cellLabel === cellLabel &&
							r.model === model
					);
					if (!match) continue;

					const diff = charDiff(goldText, match.result.text);
					goldErrors[model] += diff.errors;
					goldSummaryHtml += `<div class="model-result">`;
					goldSummaryHtml += `<strong>${escHtml(model)}</strong> (${match.result.latencyMs}ms, ${diff.errors} errors):<br>`;
					goldSummaryHtml += `<div class="diff-block">${diff.html}</div>`;
					goldSummaryHtml += `</div>`;
				}
			}
		}
	}

	let pageBlocksHtml = '';
	for (const page of pages) {
		const pageName = basename(page);
		pageBlocksHtml += `<h2>${escHtml(pageName)}</h2>`;

		const imgBuf = pageImages.get(page);
		if (imgBuf) {
			const b64 = imgBuf.toString('base64');
			pageBlocksHtml += `<div class="page-img"><img src="data:image/jpeg;base64,${b64}" alt="${escHtml(pageName)}"></div>`;
		}

		// Page-mode results
		const pageResults = results.filter((r) => r.page === page && r.condition.startsWith('page@'));
		if (pageResults.length > 0) {
			pageBlocksHtml += '<h3>Page-mode transcription</h3>';
			pageBlocksHtml += '<div class="page-mode-grid">';
			for (const pr of pageResults) {
				pageBlocksHtml += `<div class="page-mode-result">`;
				pageBlocksHtml += `<strong>${escHtml(pr.model)} (${pr.condition})</strong> &mdash; ${pr.result.latencyMs}ms<br>`;
				pageBlocksHtml += `<pre>${escHtml(pr.result.text)}</pre>`;
				pageBlocksHtml += `</div>`;
			}
			pageBlocksHtml += '</div>';
		}

		// Cell-mode results
		const cellResults = results.filter((r) => r.page === page && r.condition === 'grid-cell');
		const cellLabels = [...new Set(cellResults.map((r) => r.cellLabel!))].sort();

		if (cellLabels.length > 0) {
			pageBlocksHtml += '<h3>Cell-mode transcription</h3>';
			pageBlocksHtml += '<table class="cell-table"><thead><tr><th>Cell</th>';
			for (const m of modelSet) pageBlocksHtml += `<th>${escHtml(m)}</th>`;
			pageBlocksHtml += '</tr></thead><tbody>';

			for (const label of cellLabels) {
				pageBlocksHtml += `<tr><td class="cell-label">${escHtml(label)}</td>`;
				for (const m of modelSet) {
					const r = cellResults.find((x) => x.cellLabel === label && x.model === m);
					if (r) {
						pageBlocksHtml += `<td><div class="cell-text">${escHtml(r.result.text)}</div><div class="cell-meta">${r.result.latencyMs}ms</div></td>`;
					} else {
						pageBlocksHtml += '<td>&mdash;</td>';
					}
				}
				pageBlocksHtml += '</tr>';
			}

			pageBlocksHtml += '</tbody></table>';
		}
	}

	const errorSummary = Object.keys(gold).length > 0
		? `<div class="summary-box"><h3>Gold error totals</h3><ul>${modelSet.map((m) => `<li><strong>${escHtml(m)}</strong>: ${goldErrors[m]} character errors</li>`).join('')}</ul></div>`
		: '';

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>OCR Evaluation Report</title>
<style>
body { font-family: -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif; max-width: 1200px; margin: 0 auto; padding: 1em; color: #1a1a1a; }
h1 { border-bottom: 2px solid #333; padding-bottom: 0.3em; }
h2 { background: #f0f0f0; padding: 0.3em 0.5em; margin-top: 1.5em; }
h3 { margin-top: 1em; }
.summary-box { background: #e8f4e8; border: 1px solid #6a6; padding: 0.8em; margin: 1em 0; border-radius: 4px; }
.summary-box ul { margin: 0.3em 0; }
.gold-ref { background: #f9f9f0; border-left: 3px solid #b8860b; padding: 0.4em 0.6em; margin: 0.5em 0; }
.model-result { margin: 0.5em 0 0.5em 1em; }
.diff-block { font-family: monospace; background: #fafafa; padding: 0.4em; border: 1px solid #ddd; white-space: pre-wrap; word-break: break-word; }
.match { color: #333; }
.del { background: #fdd; color: #a00; text-decoration: line-through; }
.ins { background: #dfd; color: #060; }
.page-img img { max-width: 100%; max-height: 400px; border: 1px solid #ccc; }
.page-mode-grid { display: flex; gap: 1em; flex-wrap: wrap; }
.page-mode-result { flex: 1; min-width: 300px; background: #fafafa; padding: 0.5em; border: 1px solid #ddd; }
.page-mode-result pre { white-space: pre-wrap; word-break: break-word; font-size: 0.85em; max-height: 300px; overflow-y: auto; }
.cell-table { border-collapse: collapse; width: 100%; margin: 0.5em 0; }
.cell-table th, .cell-table td { border: 1px solid #ccc; padding: 0.3em 0.5em; text-align: left; vertical-align: top; }
.cell-table th { background: #e8e8e8; }
.cell-label { font-weight: 600; white-space: nowrap; }
.cell-text { white-space: pre-wrap; word-break: break-word; font-size: 0.9em; }
.cell-meta { color: #888; font-size: 0.8em; margin-top: 0.2em; }
.footer { margin-top: 2em; font-size: 0.8em; color: #666; border-top: 1px solid #ccc; padding-top: 0.5em; }
</style>
</head>
<body>
<h1>OCR Evaluation Report</h1>
<p>Models: ${modelSet.map(escHtml).join(', ')} &mdash; Pages: ${pages.length} &mdash; Grid: ${gridRows}&times;${gridCols}</p>
${errorSummary}
${goldSummaryHtml}
${pageBlocksHtml}
<div class="footer">Generated ${new Date().toISOString().slice(0, 19)} by scripts/ocr-eval.ts</div>
</body>
</html>`;
}

// -- Main --

async function main() {
	console.log('OCR Evaluation');
	console.log(`  Input:  ${inputDir}`);
	console.log(`  Models: ${modelNames.join(', ')}`);
	console.log(`  Grid:   ${gridRows}x${gridCols}`);
	console.log(`  Output: ${outputDir}`);
	console.log(`  Timeout: ${timeoutSec}s per call`);
	if (values.gold) console.log(`  Gold:   ${values.gold}`);
	console.log();

	const images = await discoverImages(inputDir);
	if (images.length === 0) {
		console.error(`No images found in ${inputDir}`);
		process.exit(1);
	}
	console.log(`Found ${images.length} image(s): ${images.map((f) => basename(f)).join(', ')}`);

	console.log('\nBuilding adapters...');
	const adapters = await buildAdapters(modelNames);
	if (adapters.length === 0) {
		console.error('No adapters available.');
		process.exit(1);
	}
	console.log(`  ${adapters.map((a) => a.vendorName).join(', ')}\n`);

	const gold = await loadGold(values.gold);
	const allResults: EvalResult[] = [];
	const pageImages = new Map<string, Buffer>();

	for (const imagePath of images) {
		const pageName = basename(imagePath);
		console.log(`\n=== ${pageName} ===`);

		const rawBuf = await readFile(imagePath);
		const ext = extname(imagePath).toLowerCase();
		const mime = mimeFor(ext);

		// Generate a thumbnail for the report
		const thumbBuf = await resizePage(rawBuf, 1200);
		pageImages.set(imagePath, thumbBuf);

		// Prep: resize for page-mode
		const page2000 = await resizePage(rawBuf, 2000);
		const page4000 = await resizePage(rawBuf, 4000);

		// Prep: grid crop
		console.log(`  Cropping ${gridRows}x${gridCols} grid...`);
		const cells = await cropGrid(rawBuf, { rows: gridRows, cols: gridCols });

		for (const adapter of adapters) {
			const isOllama = adapter.vendorName.startsWith('ollama/');

			// Page-mode: both resolutions for Ollama, only 2000 for Claude (will be resized internally)
			if (isOllama) {
				for (const [cap, buf] of [['page@2000', page2000], ['page@4000', page4000]] as const) {
					console.log(`  [${adapter.vendorName}] ${cap}...`);
					const input: TranscribeInput = { image: buf, mimeType: 'image/jpeg', sourceImagePath: imagePath };
					const result = await adapter.transcribe(input, { mode: 'cell', prompt: PAGE_PROMPT });
					allResults.push({ page: imagePath, condition: cap, model: adapter.vendorName, result });
					console.log(`    ${result.latencyMs}ms, ${result.text.length} chars`);
				}
			} else {
				console.log(`  [${adapter.vendorName}] page@2000...`);
				const input: TranscribeInput = { image: page2000, mimeType: 'image/jpeg', sourceImagePath: imagePath };
				const result = await adapter.transcribe(input, { mode: 'cell', prompt: PAGE_PROMPT });
				allResults.push({ page: imagePath, condition: 'page@2000', model: adapter.vendorName, result });
				console.log(`    ${result.latencyMs}ms, ${result.text.length} chars`);
			}

			// Cell-mode: each grid cell
			for (const cell of cells) {
				const cellLabel = `r${cell.row}c${cell.col}`;
				process.stdout.write(`  [${adapter.vendorName}] ${cellLabel}...`);
				const input: TranscribeInput = { image: cell.buffer, mimeType: 'image/jpeg', sourceImagePath: `${imagePath}#${cellLabel}` };
				const result = await adapter.transcribe(input);
				allResults.push({ page: imagePath, condition: 'grid-cell', cellLabel, model: adapter.vendorName, result });
				console.log(` ${result.latencyMs}ms`);
			}
		}
	}

	// Write outputs
	await mkdir(outputDir, { recursive: true });

	const resultsPath = join(outputDir, 'results.json');
	const serializable = allResults.map((r) => ({
		page: basename(r.page),
		condition: r.condition,
		cellLabel: r.cellLabel ?? null,
		model: r.model,
		text: r.result.text,
		confidence: r.result.confidence,
		latencyMs: r.result.latencyMs,
		vendorMeta: r.result.vendorMeta
	}));
	await writeFile(resultsPath, JSON.stringify(serializable, null, 2));
	console.log(`\nResults: ${resultsPath}`);

	const reportHtml = generateReport(allResults, gold, pageImages);
	const reportPath = join(outputDir, 'report.html');
	await writeFile(reportPath, reportHtml);
	console.log(`Report:  ${reportPath}`);

	// Summary
	const totalCells = allResults.filter((r) => r.condition === 'grid-cell').length;
	const totalPages = allResults.filter((r) => r.condition.startsWith('page@')).length;
	console.log(`\nDone. ${totalCells} cell transcriptions + ${totalPages} page transcriptions across ${adapters.length} model(s).`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
