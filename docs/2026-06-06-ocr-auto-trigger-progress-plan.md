# Plan: Auto-Run OCR Worker + Live Progress After Grid-Align Save

## Context

Two problems with the OCR pipeline:

1. **OCR doesn't run.** The grid-align "trigger OCR on save" checkbox enqueues a job row, but nothing spawns the worker process. Jobs sit in `pending` forever.

2. **No feedback.** Even once OCR runs, there's no way to see progress or know when it's done without checking the DB manually.

Also: capture intake enqueues dead `'ocr'` jobs that the worker doesn't process. Cleanup.

Related but deferred: manual entry mode for squiggly-line pages (td-510071, P1) and curved line detection (td-73260e, P3).

---

## Codex Review Findings (2026-06-06)

### P1 — Must fix before implementation

1. **Unmanaged detached workers are unsafe.** Raw `spawn().unref()` gives no process supervision, no restart, no stalled detection, and no way to prevent duplicate workers from repeated saves. Need a DB-backed worker lock: record the spawned worker's run in `job_runs` or a lock row so the progress endpoint can distinguish "running" from "worker died," and so a second save doesn't launch a competing worker for the same page.

2. **Silent spawn failures violate "no silent failures."** If `spawnOcrWorker` fails silently, the user lands on progress and watches jobs stay pending forever. The spawner must persist a visible failure signal (e.g., mark the `page_ocr` job as failed with the spawn error), and the progress endpoint must report "worker failed to start."

3. **Progress queries must filter by current grid_version.** `job_runs` contains old, canceled, and stale jobs for the same page. The progress endpoint must join against `calendar_pages.grid_version` or scope to the latest `page_ocr` job ID. Otherwise the banner can count stale `llm_cleanup` jobs and show wrong totals or phantom failures after a re-grid.

### P2 — Should fix

4. **Dead `'ocr'` cleanup is incomplete.** Removing the two INSERT statements isn't enough. `ingest.ts` comments and `setPhase()` still reference `enqueue_ocr`, migration `0007_capture_intake.sql` allows that phase, and `/admin/ocr-review/+page.server.ts` still joins on `job_type = 'ocr'`. Clean up stale references.

5. **Log path not production-aligned.** `ocr-worker.log` in project root can grow unbounded on the 1 GB shared droplet. Either use PM2's log directory (`/var/log/pm2/`) with rotation, or cap the log size.

6. **"Auto-refresh the grid" is undefined.** After completion, the OCR review page's load data is stale. Must call `invalidateAll()` or push incremental day updates from the progress endpoint. Otherwise the banner says "complete" but cells still show "Pending" until manual reload.

### UX improvements (from review)

- Add immediate "OCR queued" state after redirect; distinguish `queued → scanning → cleaning up → complete / failed / stalled`
- Use a compact sticky progress strip above the calendar grid, not a large banner that pushes the grid around during polling
- Include a "Refresh results now" button and "Back to grid alignment" link in the strip
- For failures: show the failed stage + `last_error`, plus a "Retry OCR" button
- Show stage 1 as a checklist item ("Google Vision scan — done ✓") and stage 2 as a progress bar — makes the two-stage pipeline scannable
- Show latest completed day as a small chip with date + preview text
- Preserve filters (All / Low Conf / Blank) during auto-refresh so the view doesn't reset

### Needs better definition (from review)

- Concurrency limit: what prevents repeated saves from launching multiple workers for the same page?
- Stale detection: how the UI treats `in_progress` jobs older than the worker reclaim threshold (default 10 min)
- Current-run identity: use `grid_version`, latest `page_ocr` job ID, or a new run ID?
- Verification should include `npm run build`, not just `npm run check`

---

## A. Auto-trigger the OCR worker

### 1. Worker spawner utility

**New file:** `src/lib/workers/spawn.ts`

A function that fires off the OCR worker as a background process:
- Uses `child_process.spawn` with `detached: true` + `unref()` — web app doesn't wait
- Scopes to `--page-id=N` so it only processes that page's jobs
- Logs to `/var/log/pm2/madonnahist-ocr-worker.log` in production, falls back to `ocr-worker.log` in dev
- **Concurrency guard**: before spawning, check the latest `page_ocr` job for this page — if it's already `in_progress` with `started_at` within the stale threshold, skip the spawn and return. This prevents duplicate workers from rapid re-saves.
- **Spawn failure handling**: if `spawn()` throws or the child emits `'error'`, mark the `page_ocr` job as `failed` with `last_error = 'worker spawn failed: <message>'`. The progress endpoint surfaces this to the UI.

### 2. Call spawner from grid-align

**File:** `src/routes/admin/grid-align/[pageId]/+page.server.ts`

- `applyWarp` action: spawn after transaction commits (always re-runs OCR on warp)
- `saveGrid` action: spawn after transaction commits, **only when `rerunOcr` is true** (respects the checkbox)
- Both calls go before `redirect()` (which throws)

### 3. Remove dead job enqueuing from capture intake

**File:** `src/lib/ingest/ingest.ts`

- Remove the `INSERT INTO job_runs` blocks (lines 132-136 and 253-255) that enqueue per-day `'ocr'` jobs
- Update `setPhase()` and comments that reference `enqueue_ocr`

**File:** `src/routes/admin/ocr-review/+page.server.ts`

- Remove or update any joins/queries that reference `job_type = 'ocr'` (stale job type)

---

## B. Live OCR progress on the OCR review page

### 4. Progress polling API endpoint

**New file:** `src/routes/admin/ocr-review/[pageId]/progress/+server.ts`

A GET endpoint that returns the current OCR processing state for a page, **scoped to the current grid_version**:

```json
{
  "gridVersion": 17,
  "stage1": {
    "status": "done",
    "wordCount": 693,
    "durationMs": 8355
  },
  "stage2": {
    "status": "running",
    "total": 30,
    "done": 12,
    "failed": 0,
    "latestDay": { "date": "2007-04-12", "preview": "Clark 7:30 to 5:15 Walk..." }
  }
}
```

Query logic:
- Find the latest `page_ocr` job for this page where `payload->>'grid_version'` matches `calendar_pages.grid_version`
- For stage 2, count `llm_cleanup` jobs whose `payload->>'page_id'` matches AND were enqueued by the same `page_ocr` job (or after it)
- Status values: `queued`, `scanning`, `cleaning`, `complete`, `failed`, `stalled` (in_progress > 10 min)

### 5. Progress UI on OCR review page

**File:** `src/routes/admin/ocr-review/[pageId]/+page.svelte`

Compact sticky progress strip above the calendar grid:

- **Stage 1 (Google Vision)**: checklist item — "Google Vision scan — queued..." / "done ✓ (693 words, 8.4s)" / "failed: [reason]"
- **Stage 2 (Claude cleanup)**: progress bar — "Cleaning up 12 of 30 days..." with latest day chip showing date + text preview
- **Complete**: "OCR complete — 30/30 days processed" then call `invalidateAll()` to refresh the grid with results
- **Failed**: show stage + `last_error` + "Retry OCR" button
- **Controls**: "Refresh now" button, "Back to grid alignment" link
- Polls the progress endpoint every 3 seconds while active; stops when complete or failed
- Preserves current filter state (All / Low Conf / Blank) across refreshes
- If user arrives at OCR review and no OCR is active for the current grid_version, no strip shown

### 6. Redirect to OCR review after grid save (when OCR triggered)

**File:** `src/routes/admin/grid-align/[pageId]/+page.server.ts`

When `rerunOcr` is true, redirect to `/admin/ocr-review/[pageId]` instead of back to grid-align. User lands directly on the progress page. When OCR is not triggered, redirect stays as-is back to grid-align.

---

## Files to modify

| File | Change |
|------|--------|
| `src/lib/workers/spawn.ts` | **New** — `spawnOcrWorker()` with concurrency guard + failure handling |
| `src/routes/admin/grid-align/[pageId]/+page.server.ts` | Import + call `spawnOcrWorker`; redirect to OCR review when OCR triggered |
| `src/lib/ingest/ingest.ts` | Remove dead `'ocr'` job inserts; update comments/phases |
| `src/routes/admin/ocr-review/+page.server.ts` | Clean up stale `job_type = 'ocr'` references |
| `src/routes/admin/ocr-review/[pageId]/progress/+server.ts` | **New** — progress polling endpoint, grid_version-scoped |
| `src/routes/admin/ocr-review/[pageId]/+page.svelte` | Add sticky progress strip with polling, invalidateAll on complete |

## Verification

1. `npm run check` — zero errors, zero warnings
2. `npm run build` — clean production build
3. Grid-align: save with OCR checkbox checked → redirected to OCR review → progress strip appears → stage 1 completes → stage 2 ticks through days → strip says "complete" → grid auto-refreshes with results
4. Grid-align: save with OCR checkbox **unchecked** → stays on grid-align, no OCR spawned
5. Grid-align: change lines and re-save with OCR checked → old jobs canceled, new OCR starts fresh, progress shows only current-version jobs
6. Rapid double-save → second spawn is skipped (concurrency guard), no duplicate workers
7. Kill worker mid-run → progress shows "stalled" after 10 min threshold
8. Spawn failure → progress strip shows error with retry button
9. Deploy and verify on production
