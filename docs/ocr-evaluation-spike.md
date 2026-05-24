# OCR / HTR Evaluation Spike — "Will handwriting recognition actually work?"

> **Revision (post-CODEX sanity-check review, 2026-05-24).** First draft was a 1–2 page,
> eyeball-only smoke test. CODEX correctly flagged that as too small/biased to confirm or
> overturn the V4 local-vendor choice. This revision broadens the sample to a stratified set,
> adds a hand-typed gold subset and hand-cropped controls, fixes a whole-page resolution bias,
> and updates the local-model lineup to tags confirmed on the Ollama library as of 2026-05-21.

## Context

We're setting up the image-capture workstation, and before committing to a vendor for the
production OCR worker (V4 §9.2, ticket `td-9a30ae`) we want an early, honest read on **how well
handwriting recognition reads this specific archive's handwriting** — 60 years of cursive daily
calendar entries. The V4 spec already *recommends* local VLM via Ollama (olmOCR-2 / Qwen-VL)
as the default vendor with Transkribus as a fallback, but that recommendation has never been
tested against a real page. This spike answers the question with evidence instead of a spec claim.

This is an **evaluation spike, not the production worker.** No DB writes, no `job_runs`, no Spaces.
It runs entirely against local image files and produces a side-by-side comparison report. The
vendor-adapter signatures it uses are deliberately shaped like the production interface so the
findings (and some code) carry forward.

**Environment confirmed this session:** M4 Max, 128 GB unified memory (huge local headroom — far
beyond the V4 doc's "~8 GB" assumption; we can run large VLMs comfortably). Ollama 0.13.5 installed,
**no models pulled yet.** Node v24.3, Python 3.14.2.

### Decisions (from user; updated 2026-05-24 after CODEX review)
1. **Test images:** capture a **stratified set of ~6–8 real pages** on the new rig (G9 II + 60mm),
   chosen to span decades, different writers, ink vs. pencil, and easy→hard legibility. Tests real
   handwriting AND the real capture chain, and guards against overfitting one writer/era/ink.
2. **Engines:** local Ollama VLMs **+** a frontier cloud model (Claude vision) as a quality ceiling.
3. **Eval method:** eyeball side-by-side HTML report (image next to each engine's transcription +
   latency) **anchored by a small hand-typed gold subset** (~10–15 representative cells) so confident
   hallucinations show up as exact diffs rather than passing as "good enough."

## Goal & Non-Goals

**Goal:** Run real handwriting spanning the archive's range through several engines, see the
transcriptions next to the source image (with exact diffs on the gold cells), and answer with enough
confidence to **confirm or overturn the V4 local-vendor default**: *Is local VLM good enough, or do we
need cloud / Transkribus? How much does day-cell cropping matter vs. whole-page transcription, and at
what resolution? Roughly what correction burden is Madonna facing?*

**Non-goals:** production OCR worker, DB integration, Spaces upload, crop-template UI, confidence
calibration, Transkribus (deferred — needs an account and only shines after training; revisit if local
+ cloud both disappoint).

## Approach

All spike code lives under **`experiments/ocr-eval/`** (clearly throwaway-able; not shipped to prod).

### 1. Input — stratified sample
- User captures **~6–8 real pages**, exports JPEG/TIFF from LR Classic, drops them in
  `experiments/ocr-eval/input/`. Filename carries the year/month (e.g. `1972-03.jpg`).
- **Stratify the selection** (don't grab 6 consecutive months of one calendar): aim to cover
  - a spread of **decades** (e.g. one each from the 1960s/70s/80s/90s/2000s/2010s as available),
  - **different writers** if more than one person kept the calendars over 60 years,
  - **ink vs. pencil** and faded vs. crisp,
  - an explicit **easy / medium / hard legibility** spread — include at least one page you find genuinely
    hard to read, since that's where vendor differences show.
  Record the intended strata in `experiments/ocr-eval/input/SAMPLE.md` (one line per page: era, writer,
  medium, expected difficulty) so the verdict is interpretable later.
- Harness accepts TIFF or JPEG.

### 2. Image prep (Sharp — already a dependency)
`experiments/ocr-eval/prep.mjs` produces **three explicitly-separate conditions** per page so we can
attribute a bad result to the right cause (resolution vs. crop vs. model), not confound them:

- **(A) whole-page, multiple caps** — emit the page at **two** long-edge caps (default ~2000px *and*
  ~4000px, configurable), because a 5×7 month grid downscaled to 2000px starves each day of signal and
  would pre-bias page-mode toward failure. Comparing the two caps tells us whether page-mode failures are
  a model limit or just a preprocessing choice.
- **(B) grid-cropped cells** — naive `rows × cols` slice (default 5×7 wall-calendar) with optional margin
  trim → `input/<page>/cells/grid/r{R}c{C}.jpg`. Fast, drift-prone; prototypes the cropping
  `scripts/upload-page.mjs` will eventually need. **Frame this as a rough crop hypothesis, not ground
  truth** — grid drift would otherwise get mis-blamed on the model.
- **(C) hand-cropped control cells** — for a small set of representative days (the same cells used for the
  gold subset, §5), crop drift-free rectangles from hand-picked coordinates in `config.mjs` →
  `input/<page>/cells/hand/<day>.jpg`. Reporting **grid-crop vs. hand-crop delta** on these cells isolates
  how much accuracy the naive grid is costing, separately from model quality. I pick the coordinates by
  eyeballing each captured page — no manual cropping work for the user.

This gives the report three crop/resolution conditions to compare: **downscaled page vs. higher-cap page
vs. cell crop**, and **grid cell vs. hand cell** — the central pipeline questions for the real worker.

### 3. Engine adapters
Each adapter mirrors the V4 §9.2 production signature so it can graduate later:
`transcribe(imagePath) -> { text, confidenceNote, latencyMs, raw }`.

- `engines/ollama.mjs` — POSTs to the local Ollama `/api/generate` (or `/api/chat`) with the image
  base64-encoded, one function parameterized by model tag. Lineup (tags confirmed on the Ollama library
  as of 2026-05-21; verify with `ollama list` after pulling):
  - **Primary local pair: `qwen3-vl:32b` and `qwen2.5vl:32b`** — both exist on the official library; we
    have the RAM for the 32B variants. `qwen3-vl` is no longer speculative.
  - **One contrast model: `llama3.2-vision`** (or `minicpm-v`) — different family, sanity-checks that the
    result isn't a Qwen-specific artifact. A smaller `qwen3-vl:7b`/`qwen2.5vl:7b` pull can be added for a
    speed-vs-quality read if useful.
  - **olmOCR — out of the main spike path** (was the V4-named default in
    `docs/calendar-history-system-V4.md:522`). It is *not* an Ollama-native model; its official toolkit is
    built around the olmOCR stack / OpenAI-compatible serving and is more PDF/document-oriented than this
    cell-image bakeoff. Forcing it in here adds setup friction without a clean apples-to-apples read.
    Captured as a **separate optional experiment** (`experiments/ocr-eval/olmocr-NOTES.md`) to run only if
    local + cloud both disappoint and we need to chase the V4-spec narrative.
- `engines/claude.mjs` — Anthropic vision (cloud reference / quality ceiling). For this self-contained
  spike, reads the key from **`ANTHROPIC_API_KEY` env first**, with `private_data.api_credentials` (the
  cs.md pattern) as an optional fallback — keeps the spike genuinely off the app's DB plumbing. If neither
  is present, the runner skips Claude with a clear message rather than failing.

Two prompt modes:
- **cell mode** — "Transcribe this single handwritten calendar day entry verbatim; preserve line breaks;
  output only the text." Run per cropped cell (grid and hand-cropped).
- **page mode** — "This is a handwritten monthly calendar. Transcribe each day's entry; return JSON keyed
  by day number." Run **once per whole-page cap (both ~2000px and ~4000px)** so a poor page-mode result
  reflects the model, not a starved input. Tests whether a VLM can read the whole page per-day and let us
  skip precise cropping.

### 4. Runner
`experiments/ocr-eval/run.mjs`:
- Reads a small `config.mjs` (models, grid size, whole-page caps, hand-crop coordinates, prompt modes).
- For each engine: cell-mode transcription on every grid cell and every hand-cropped control cell;
  page-mode transcription on each whole-page cap. Collect `{ text, latencyMs, confidenceNote, condition }`
  where `condition ∈ {page@2000, page@4000, grid-cell, hand-cell}`.
- Sequential by default (local VLM inference is the bottleneck; keep it simple and watch memory). Writes
  raw results to `experiments/ocr-eval/output/results.json` so re-rendering the report is free.

### 5. Gold subset (eval anchor)
- `experiments/ocr-eval/gold.json` — user hand-types the **true** text for ~10–15 representative cells
  (mix of easy/medium/hard, spanning the sample pages), keyed by `page + day`. These are the same cells
  used for the hand-cropped control (§2C).
- The runner/report computes a per-engine **exact diff** against gold for these cells (character-level
  highlight + a simple error count), so a confident-but-wrong reading is visible as a diff rather than
  slipping past a casual eyeball. This is a spot-check anchor, **not** full CER/WER over the whole page.
- Everything outside the gold subset stays eyeball-only — gold just keeps the eyeballing honest.

### 6. Report
`experiments/ocr-eval/report.mjs` → `experiments/ocr-eval/output/report.html` (self-contained, matches
the repo's existing `.md`→`.html` convention; open in a browser):
- **Summary header:** models run, sample strata covered (from `SAMPLE.md`), total latency per engine,
  cost note ($0 local vs. cloud token cost), and a gold-subset error tally per engine.
- **Gold cells first:** for each gold cell, the hand crop + each engine's transcription with a
  character-level **diff against gold** and an error count — the trustworthy core of the verdict.
- **Per-page blocks:** whole-page image + each engine's page-mode JSON **at both caps side by side**
  (exposes the resolution effect), then per day cell the crop on the left and each engine's transcription
  stacked on the right with latency.
- **Crop-condition panel:** for the control cells, grid-crop vs. hand-crop transcriptions side by side, so
  the cost of naive grid drift is visible separately from model quality.

### Confidence-score finding (design feedback, not a deliverable)
Local Ollama VLMs don't return a calibrated `confidence_score`, which the V4 schema
(`ocr_runs.confidence_score`) and the auto-flag trigger (`flag_confidence_threshold`, default 0.4) assume
exists. The spike will surface this explicitly so the production design can decide: derive a proxy
(self-rating prompt, token logprobs if exposed), or drop confidence-based auto-flagging for the local
vendor. **Captured as a finding in the report + devlog; not solved here.**

## Files to create (all new, under `experiments/ocr-eval/`)
- `config.mjs` — models, grid size, whole-page caps (2000 & 4000), hand-crop coordinates, prompt modes
- `prep.mjs` — Sharp: convert + emit two whole-page caps + grid cells + hand-cropped control cells
- `engines/ollama.mjs` — local VLM adapter (parameterized by model tag)
- `engines/claude.mjs` — Anthropic vision adapter (`ANTHROPIC_API_KEY` env first; credentials table optional)
- `run.mjs` — orchestrates prep → engines → results.json
- `report.mjs` — results.json + gold.json → report.html (incl. gold diffs + crop-condition panel)
- `gold.json` — user-supplied true text for ~10–15 representative cells (the eval anchor)
- `input/SAMPLE.md` — one line per captured page: era, writer, medium, expected difficulty
- `olmocr-NOTES.md` — how to run olmOCR as a separate optional experiment if local+cloud disappoint
- `README.md` — how to run, how to add an engine, how to extend the gold set
- `input/.gitkeep`, `output/.gitkeep` — folders are gitignored except the keep file (real captures =
  family content, must not be committed)

No production files change. (`src/lib/ocr/`, `workers/`, schema, Spaces — all untouched.)

## Setup steps (run at execution time, not now)
1. `ollama pull qwen3-vl:32b qwen2.5vl:32b` plus one contrast model (`llama3.2-vision` or `minicpm-v`);
   optional `:7b` variants for a speed read. Confirm with `ollama list`. olmOCR is **not** pulled here
   (separate optional experiment).
2. Confirm an Anthropic key is reachable (`ANTHROPIC_API_KEY` preferred). If absent, ask the user for one.
3. User captures + exports the **stratified ~6–8 pages** into `experiments/ocr-eval/input/` and fills in
   `SAMPLE.md`.
4. User hand-types `gold.json` for ~10–15 representative cells (I'll point at which cells once the pages
   are in and I've picked the hand-crop coordinates).

## Verification (how we'll know it worked)
- `node experiments/ocr-eval/run.mjs` completes across all sample pages with no crashes; `results.json`
  has an entry for every (engine × condition × cell/page), with non-empty text on the legible cells.
- `report.html` opens in a browser: gold diffs render, both whole-page caps show side by side, and the
  grid-vs-hand crop panel renders for the control cells.
- Sanity floor: at least one engine reads the clearly-legible **gold** cells correctly (diff ≈ clean). If
  *every* engine fails gold on legible handwriting, that's a capture/prompt finding — investigate before
  drawing any vendor conclusion.
- Verdict (write to a devlog entry): per-engine gold error tally; the resolution effect (page@2000 vs
  page@4000 vs cell); the crop effect (grid vs hand); the local-vs-Claude gap; and whether results hold
  **across strata** or only on the easy pages. Plus the confidence-score finding below.

## What this informs next
- The default OCR vendor choice for `td-9a30ae` (confirm or revise the V4 "local VLM default" call) —
  now with a sample broad enough to actually support that call.
- Whether the pipeline must crop to day cells before OCR (and at what resolution), or a VLM can read whole
  pages per-day.
- How much accuracy the eventual crop-template work buys (grid-vs-hand delta is an early proxy).
- Whether Transkribus (training round) or the olmOCR side experiment is worth standing up, or local/cloud
  already clears the bar.
- The confidence/auto-flag design for the production trigger.
