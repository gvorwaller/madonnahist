# Plan: OCR Worker + Review UI (Go/No-Go Validation)

## Context

31 OCR jobs are queued in `job_runs` for January 2022 (the first ingested page). Before building more pipeline (LLM cleanup, correction UI, entity extraction), we need to see actual OCR output against real calendar images to validate the approach. This is a go/no-go checkpoint: if OCR quality is poor on Madonna's handwriting, the project approach may need to change.

**What exists:** Google Vision adapter (`src/lib/ocr/vendors/google-vision.ts`), crop utility (`src/lib/image/crop.ts` — `cropRegion()`), `ocr_runs` table + trigger (`trg_after_ocr_run_insert` auto-updates `calendar_days`), `job_runs` queue, page image in Spaces (`pages/2022/01/page-2022-01-d1c8ce72.jpg`), crop bounds stored as `{ x, y, width, height }` pixel coordinates on each `calendar_days` row.

**What's missing:** A worker script to process the jobs, a Spaces download function, and a way to view results.

## Approach

Two parallel tracks: (A) the OCR worker that processes jobs, and (B) a review UI to inspect results.

### Track A: OCR Worker

#### A1. Migration `0008_worker_credentials_grant.sql`

The `madonnahist_worker` DB role can't read `private_data.api_credentials` (confirmed — gets `permission denied`). The worker needs Spaces creds and Google Vision API key from there. Migration:

```sql
GRANT USAGE ON SCHEMA private_data TO madonnahist_worker;
GRANT SELECT ON private_data.api_credentials TO madonnahist_worker;
```

Also insert the Google Vision API key into `private_data.api_credentials` so the worker reads all credentials from the DB (env as dev fallback only).

#### A2. Worker DB pool — `backend/workers/lib/db.ts`

Standalone pool that reads from `process.env` directly (can't use `src/lib/db.ts` — depends on `$env/dynamic/private`). Uses `WORKER_PGUSER` / `WORKER_PGPASSWORD` from `.env`. Exports `query()` and `withClient()` (needed for `FOR UPDATE SKIP LOCKED` — must hold the lock on the same connection through the transaction). `max: 3` connections, `application_name: 'madonnahist-ocr-worker'`.

#### A3. Worker Spaces client — `backend/workers/lib/spaces.ts`

Standalone S3 client fetching credentials from `private_data.api_credentials` via the worker DB pool (after 0008). Provides `getObject(key): Promise<Buffer>` using `GetObjectCommand`. Memoizes the S3Client.

#### A4. Worker script — `backend/workers/ocr-worker.ts`

**One-shot mode** (process all pending, exit). Run with `npx tsx --env-file=.env backend/workers/ocr-worker.ts`.

Supports CLI flags: `--limit N`, `--page-id N`, `--dry-run`, `--retry-stale-minutes N`.

Flow:
1. Init: DB pool, Spaces client, vendor adapter (read `google_vision` API key from DB, env fallback)
2. **Claim first, group after** (CODEX P1 fix): claim a batch of pending jobs via `SELECT ... FOR UPDATE SKIP LOCKED`, mark `in_progress` with `started_at` and `attempts + 1`, commit. Also claim stale `in_progress` jobs older than `--retry-stale-minutes` (default 10). Then group claimed rows by `payload->>'page_id'`.
3. For each page group: download page image from Spaces once
4. For each day job:
   - Validate payload: join `calendar_days` → `calendar_pages` to confirm `page_id` matches, skip stale jobs from replaced pages
   - Parse `payload.vendor` and select adapter (CODEX P2 fix — fail loudly for unsupported vendors)
   - Query `calendar_days` for `crop_bounds`
   - `cropRegion(pageBuffer, crop_bounds)` → day cell JPEG
   - Google Vision `transcribe()` → `{ text, confidence, vendorMeta, latencyMs }`
   - **Atomic completion** (CODEX P1 fix): single transaction for `INSERT INTO ocr_runs` (with `created_by_job_run_id`) + `UPDATE job_runs SET status='done'`. Add unique index on `ocr_runs(created_by_job_run_id) WHERE created_by_job_run_id IS NOT NULL` to prevent duplicate runs on retry.
   - Rich `vendor_meta`: word count, confidence distribution, block count, crop bounds, page key, request latency, vendor version. For blank text, add `emptyReason: 'no_text_detected'`.
   - `source_image_path`: page Spaces key. Crop bounds and page_id stored in `vendor_meta`.
5. Error handling: transient (429, 500, network) → leave as `in_progress` for stale-claim recovery on next run, up to 3 attempts; permanent (400) → `status='failed'`; empty cells → still insert `ocr_runs` with empty text
6. Log progress: `[OCR] day_id=1 (2022-01-01) … 234ms, conf=0.65, 8 words`

Imports Google Vision adapter and `cropRegion` via relative paths (same pattern as existing `scripts/eval-google-vision-crops.ts`).

### Track B: Review UI

#### B1. Add `getObject()` to `src/lib/ingest/spaces-upload.ts`

The SvelteKit app needs to download page images for the crop endpoint. Add `getObject(key): Promise<Buffer>` using `GetObjectCommand` + stream-to-buffer. Same pattern as the worker's version but using the app's existing `getSpaces()` client.

#### B2. Crop endpoint — `src/routes/admin/ocr-review/[pageId]/crop/[dayId]/+server.ts`

Serves cropped day-cell images on the fly (no pre-generation needed):
1. Query `calendar_days` + `calendar_pages` for `crop_bounds` and `page_image_path`
2. `getObject(page_image_path)` → page buffer
3. `cropRegion(pageBuffer, crop_bounds)` → day cell JPEG
4. Return as `image/jpeg`

**Promise-based cache** (CODEX P3 fix): cache the in-flight download promise by `page_image_path`, not just completed buffers, so concurrent requests for 31 cells don't stampede Spaces with 31 parallel downloads.

#### B3. Data loader — `src/routes/admin/ocr-review/[pageId]/+page.server.ts`

Route parameterized by `pageId` (CODEX P2 fix — not hard-coded to January 2022). Query joining `calendar_days` → `calendar_pages` → `ocr_runs` (via `calendar_days.latest_ocr_run_id` — CODEX P2 fix to avoid duplicate rows from reruns) → `job_runs`. Returns per-day: `entry_date`, `crop_bounds`, `raw_text`, `confidence_score`, `job_status`, `last_error`.

Also returns page-level summary: year, month, total days, OCR complete count, average confidence, flagged count, blank count, failed count.

#### B4. Review page — `src/routes/admin/ocr-review/[pageId]/+page.svelte`

Read-only validation page:
- Header: month/year, page image thumbnail, summary stats (OCR complete, avg confidence, flagged, blank, failed)
- **Calendar grid layout** (CODEX suggestion — use actual month grid, not generic cards, so crop mistakes and date misalignment are visually obvious)
- Each cell shows:
  - Cropped day-cell image (via B2 endpoint)
  - OCR raw text below
  - Confidence badge (green >0.7, yellow 0.4-0.7, red <0.4)
- Filter toggles: all / failed / low confidence / blank
- Pending/failed jobs shown with status and error
- Hand-written CSS, no Tailwind (project convention)

#### B5. Page list — `src/routes/admin/ocr-review/+page.server.ts` + `+page.svelte`

Simple index page listing all ingested pages with OCR progress (X/Y days complete, avg confidence). Links to `/admin/ocr-review/[pageId]`. For now shows just January 2022 (page 1), but ready for more pages.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `backend/db/migrations/0008_worker_credentials_grant.sql` | **Create** | Worker access to `private_data` + unique index on `ocr_runs(created_by_job_run_id)` + Google Vision key in DB |
| `backend/workers/lib/db.ts` | **Create** | Standalone worker DB pool |
| `backend/workers/lib/spaces.ts` | **Create** | Standalone worker Spaces client with `getObject()` |
| `backend/workers/ocr-worker.ts` | **Create** | One-shot OCR worker script |
| `src/lib/ingest/spaces-upload.ts` | **Modify** | Add `getObject()` for app-side use |
| `src/routes/admin/ocr-review/+page.server.ts` | **Create** | Page index loader |
| `src/routes/admin/ocr-review/+page.svelte` | **Create** | Page index UI |
| `src/routes/admin/ocr-review/[pageId]/+page.server.ts` | **Create** | Review page data loader |
| `src/routes/admin/ocr-review/[pageId]/+page.svelte` | **Create** | Review page UI (calendar grid) |
| `src/routes/admin/ocr-review/[pageId]/crop/[dayId]/+server.ts` | **Create** | On-the-fly day-cell crop endpoint |

## Key Design Decisions

- **One-shot mode, not PM2 poll loop**: For this validation step, the worker processes all pending jobs and exits. PM2 daemon mode is a future enhancement.
- **Worker has its own DB pool + Spaces client**: Can't reuse SvelteKit modules that depend on `$env` or `$lib`. Same pattern as the eval scripts.
- **Claim-first, group-after**: Prevents race conditions between concurrent worker invocations (CODEX P1).
- **Atomic OCR insert + job completion**: Single transaction prevents duplicate `ocr_runs` on retry (CODEX P1).
- **Stale-claim recovery**: Jobs stuck `in_progress` longer than timeout are re-claimable (CODEX P1).
- **Unique index on `created_by_job_run_id`**: DB-level guard against duplicate OCR runs (CODEX P1).
- **Vendor from payload**: Parse `payload.vendor`, don't hardcode Google Vision (CODEX P2).
- **All credentials from DB**: Google Vision key stored in `private_data.api_credentials` alongside Spaces creds (CODEX P2).
- **Page downloaded once per group**: All 31 crops come from the same ~15MB page image. Download once, crop 31 times.
- **Promise-based page cache**: Prevents Spaces download stampede on concurrent crop requests (CODEX P3).
- **`cropRegion()` handles EXIF**: Already calls `sharp().rotate()` before extracting. Crop bounds were computed against EXIF-normalized dimensions during ingest, so they'll match.
- **Worker role can't UPDATE `calendar_days`**: By design. INSERT into `ocr_runs` triggers the SECURITY DEFINER function that does the update.
- **Review page uses `latest_ocr_run_id`**: Avoids duplicate rows from OCR reruns (CODEX P2).
- **Calendar grid layout in review**: Makes crop mistakes and date misalignment visually obvious (CODEX suggestion).

## Verification

1. Apply migration 0008: `./backend/db/migrate_pg.sh`
2. Run worker: `npx tsx --env-file=.env backend/workers/ocr-worker.ts`
   - Expect: 31/31 jobs processed, stdout showing per-day confidence + word count
   - Confirm in DB: `SELECT count(*) FROM ocr_runs WHERE day_id BETWEEN 1 AND 31` → 31
   - Confirm no duplicates: `SELECT created_by_job_run_id, count(*) FROM ocr_runs GROUP BY 1 HAVING count(*) > 1` → 0 rows
   - Confirm triggers fired: `SELECT latest_ocr_run_id, latest_confidence_score FROM calendar_days WHERE page_id=1 LIMIT 5` → non-null
3. Start dev server, visit `/admin/ocr-review`
   - Page index shows January 2022 with progress stats
   - Click through to `/admin/ocr-review/1`
   - Expect: calendar grid with cropped images + OCR text for each day
   - Visually compare OCR text against handwriting in the image
4. `npm run check` — 0 errors, 0 warnings

## CODEX Review Log

| # | Severity | Finding | Resolution |
|---|----------|---------|------------|
| 1 | P1 | Duplicate `ocr_runs` on retry — insert + job update not atomic | Single transaction for OCR insert + job completion; unique index on `created_by_job_run_id` |
| 2 | P1 | Stuck `in_progress` jobs after crash — no requeue mechanism | Stale-claim recovery: re-claim `in_progress` jobs older than timeout |
| 3 | P1 | Race in "group then claim" — concurrent workers see same pending jobs | Claim first with `FOR UPDATE SKIP LOCKED`, then group claimed rows by page |
| 4 | P2 | Hardcoded Google Vision — ignores `payload.vendor` | Parse vendor from payload, fail loudly for unsupported vendors |
| 5 | P2 | API key from env only — inconsistent with DB credential pattern | Store Google Vision key in `private_data.api_credentials`, env as dev fallback |
| 6 | P2 | Review loader duplicates rows on OCR reruns | Join via `calendar_days.latest_ocr_run_id` for current run only |
| 7 | P2 | Hard-coded January 2022 in UI | Route as `/admin/ocr-review/[pageId]` with page index |
| 8 | P2 | `source_image_path` semantics unclear for cropped input | Store page key in column, crop bounds + page_id in `vendor_meta` |
| 9 | P3 | Crop endpoint stampedes Spaces on concurrent requests | Cache in-flight download promises, not just completed buffers |
