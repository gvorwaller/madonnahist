# Plan: Production-Path OCR Evaluation (No Throwaway Code)

> Revised 2026-05-25 after CODEX architectural review.

## Context

The capture studio is set up (G9 II + 60mm + Godox SL100Bi lights). Before committing to a vendor for the production OCR worker (td-9a30ae), we need an honest read on how well handwriting recognition works on this archive's cursive. The existing `docs/ocr-evaluation-spike.md` designs this as throwaway code under `experiments/`. Instead, we'll build the vendor adapters and cropping modules in their production locations and wire a permanent eval CLI that reuses them.

**Scope clarification:** The adapters and crop primitives are production-path code. The eval CLI and page-mode prompting are permanent evaluation tooling (like a test suite), not production OCR worker code. The confidence/fallback story (low-confidence → Transkribus rerun) is explicitly deferred until eval results inform the design.

## What Gets Built

| File | Purpose | Maps to task | Ships in prod? |
|---|---|---|---|
| `src/lib/ocr/types.ts` | Shared interfaces (`VendorAdapter`, `TranscribeInput`, `TranscribeResult`) | td-9a30ae | Yes |
| `src/lib/ocr/prompts.ts` | Cell-mode prompt only (production) | td-9a30ae | Yes |
| `src/lib/ocr/vendors/local-ollama.ts` | Ollama adapter (parameterized by model tag) | td-9a30ae | Yes |
| `src/lib/ocr/vendors/claude-vision.ts` | Anthropic vision adapter (quality ceiling) | td-9a30ae | Yes |
| `src/lib/image/crop.ts` | Sharp cropping primitives (grid, resize, region) | td-ccb503 | Yes |
| `scripts/ocr-eval.ts` | CLI evaluation harness (HTML report + page-mode prompts) | Permanent eval tool | No (tooling) |
| `test-data/` | Sample images, gold references, strata docs | Permanent test data | No (tooling) |

## Implementation Steps

### Step 1: Dependencies + config

- `npm install sharp @anthropic-ai/sdk`
- Do NOT add `sharp` to `ssr.external` in `vite.config.ts` — it's only used by scripts/workers, not SvelteKit SSR code
- Add to `.gitignore`: `test-data/samples/`, `output/`
- Create `test-data/samples/.gitkeep`, `test-data/SAMPLE.md` (template), `test-data/gold.json` (`{}`)

### Step 2: `src/lib/ocr/types.ts` — shared interfaces

```typescript
export interface TranscribeInput {
  image: Buffer;               // raw bytes (caller handles file read / download)
  mimeType: 'image/jpeg' | 'image/tiff' | 'image/png';
  sourceImagePath: string;     // provenance: Spaces key or local path
}

export interface TranscribeResult {
  text: string;
  confidence: number | null;   // null when vendor can't provide (local VLM)
  vendorMeta: Record<string, unknown>;
  latencyMs: number;
}

export interface TranscribeOptions {
  mode: 'cell';               // production is always cell-mode
  prompt?: string;            // override default cell prompt
}

export interface VendorAdapter {
  readonly vendorName: string;
  transcribe(input: TranscribeInput, options?: TranscribeOptions): Promise<TranscribeResult>;
}
```

Key design decisions:
- **`TranscribeInput` object** (not bare `Buffer | string`) — carries mime type and source path for `ocr_runs.vendor_meta` storage. Caller resolves file/URL to buffer before calling.
- **`confidence: number | null`** — local VLMs can't provide calibrated confidence. DB trigger handles NULL correctly (`IF NEW.confidence_score IS NOT NULL` guard skips auto-flagging).
- **`mode: 'cell'` only in production interface** — page-mode (whole-page JSON extraction) is eval-only research tooling, not the production OCR worker path (V4 §9.2 is day-cell based).

**Deferred:** Confidence proxy strategy (self-rating prompt, token logprobs, or dropping confidence-based auto-flagging for local vendor). Decision blocked on eval results.

### Step 3: `src/lib/ocr/prompts.ts` — production cell prompt

One constant: `CELL_PROMPT` — "Transcribe this single handwritten calendar day entry exactly as written. Preserve line breaks. Output only the transcribed text, nothing else."

Page-mode prompting lives in the eval script (Step 7), not here — it's research tooling for testing whether VLMs can read whole pages without cropping.

### Step 4: `src/lib/image/crop.ts` — Sharp cropping primitives

Three exported functions:

- `cropGrid(image, { rows, cols, marginPct })` → `CropResult[]` with both buffer and bounds
- `resizePage(image, maxLongEdge)` → `Buffer`
- `cropRegion(image, bounds)` → `Buffer`

```typescript
export interface CropResult {
  row: number;
  col: number;
  buffer: Buffer;
  bounds: { x: number; y: number; width: number; height: number };
}
```

**Framing:** These are cropping primitives. The naive 5×7 grid is one strategy; production `upload-page.mjs` will apply `crop_templates` (stored geometry per year/month) via these same primitives. The bounds metadata in `CropResult` maps directly to `calendar_days.crop_bounds` JSONB.

### Step 5: `src/lib/ocr/vendors/local-ollama.ts` — Ollama adapter

- Uses Node 24 built-in `fetch()` to POST to Ollama `/api/chat` endpoint
- Takes `OllamaConfig { baseUrl, model, timeoutMs }` via factory function
- Accepts `TranscribeInput` (uses `image` buffer → base64, stores `sourceImagePath` in vendorMeta)
- Returns `{ text, confidence: null, vendorMeta: { model, totalDuration, evalCount, sourceImagePath } }`
- No SvelteKit-specific imports (no `$lib/`, no `$env/`)

### Step 6: `src/lib/ocr/vendors/claude-vision.ts` — Claude adapter

- Uses `@anthropic-ai/sdk`
- Takes `ClaudeVisionConfig { apiKey, model?, maxTokens? }` via factory function
- API key passed as constructor arg (eval reads from env, production worker reads from `private_data.api_credentials`)
- Resizes input to ≤1568px long edge before sending (Anthropic guidance — larger images get downscaled server-side anyway, wasting upload time and tokens)
- Returns `{ text, confidence: null, vendorMeta: { model, inputTokens, outputTokens } }`

### Step 7: `scripts/ocr-eval.ts` — evaluation CLI

Run via `npx tsx scripts/ocr-eval.ts --input test-data/samples/ --models qwen3-vl:32b`

This script owns eval-only concerns:
- **Page-mode prompting** (whole-page JSON extraction — research, not production)
- **Multi-resolution comparison** (2000px and 4000px caps for Ollama; ≤1568px for Claude)
- **Gold-cell diffing** (character-level comparison against hand-typed references)
- **HTML report generation**

Behavior:
1. Read images from `--input` directory
2. Per image: `resizePage()` at multiple caps (vendor-specific sizing), `cropGrid()` with 5×7 grid
3. Per model: cell-mode transcription on each grid cell, page-mode on each whole-page cap
4. If `--gold` provided: character-level diff against reference transcriptions
5. Write `output/results.json` (structured results, re-renderable)
6. Write `output/report.html` (self-contained HTML: side-by-side image + transcriptions, gold diffs, latency, crop-condition comparison)

No DB writes for now; `--db` mode can be added later.

### Step 8: Scaffold `test-data/` and document

- `test-data/SAMPLE.md` — template with columns: filename, decade, writer, medium, difficulty
- `test-data/gold.json` — starts as `{}`; user fills in after first run
- Brief usage comment at top of `ocr-eval.ts`

## Important Constraints

- **No SvelteKit imports** in vendor adapters or crop module — they must work from standalone scripts (workers run as PM2 processes, not inside SvelteKit). Config passed via factory args, not `$env/` or `$lib/credentials`.
- **Sharp outputs JPEG** for day cells (quality 95) — lossy is fine for OCR input, matches V4 Spaces storage format.
- Eval script is `.ts` (not `.mjs`) — cleaner imports of the TypeScript production modules via `tsx`.
- Ollama model must be pulled before running (`ollama pull qwen3-vl:32b`). Script should check and fail with a clear message if model isn't available.
- **Vendor-specific image sizing:** Ollama gets full-res (2000/4000px caps for comparison). Claude gets ≤1568px (Anthropic's recommended ceiling — larger wastes tokens and latency).

## Deferred Decisions (informed by eval results)

- **Confidence proxy:** How to populate `ocr_runs.confidence_score` for local VLMs (self-rating prompt? edit-distance heuristic? drop auto-flagging?). Blocked on seeing actual OCR quality.
- **Fallback policy:** When/whether low-confidence local runs trigger a Transkribus rerun. Depends on local VLM quality gap.
- **Crop template strategy:** Whether naive grid is good enough or template-based geometry is needed for accuracy. Eval's grid-vs-hand-crop comparison will inform this.

## Verification

1. `npx tsx scripts/ocr-eval.ts --input test-data/samples/ --models qwen3-vl:32b` completes without errors
2. `output/report.html` opens in browser with: page images, per-cell transcriptions, latency data
3. With `--gold`, report shows character-level diffs on gold cells
4. `npm run check` passes (TypeScript clean)
5. Cropping module produces reasonable day-cell images from a calendar page (verify visually)

## User Steps (before/after implementation)

**Before:** `ollama pull qwen3-vl:32b` (and optionally `qwen2.5vl:32b`, `llama3.2-vision`)

**After code is built:**
1. Capture 6-8 stratified sample pages, export from LR Classic, drop in `test-data/samples/`
2. Fill in `test-data/SAMPLE.md` with strata metadata
3. Run eval: `npx tsx scripts/ocr-eval.ts --input test-data/samples/ --models qwen3-vl:32b`
4. Review `output/report.html`
5. Hand-type gold references for 10-15 cells into `test-data/gold.json`
6. Re-run with gold + Claude: `npx tsx scripts/ocr-eval.ts --input test-data/samples/ --gold test-data/gold.json --models qwen3-vl:32b,claude`
7. Write verdict to devlog
