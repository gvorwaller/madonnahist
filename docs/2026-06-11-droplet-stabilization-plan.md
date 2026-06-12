# Plan: Droplet Stabilization — Tasks #13, #14, #15

## Context

After upgrading the DO droplet from 1GB to 4GB and adding PM2 `max_memory_restart`, three engineering tasks remain to eliminate the root cause of OOM kills and add observability. The primary OOM trigger was concurrent on-demand crop generation during OCR review — each of 30+ day cells requests the full page image (~5-10MB), crops it via Sharp, and returns JPEG. When ad-hoc worker spawns overlap with web-served crop generation, memory spikes past 1GB were routine on the old box.

---

## Task #13: Pre-generate Day-Cell Crops (Biggest Impact)

**Goal**: Generate and upload crop images to DO Spaces when crop_bounds are finalized, so serving endpoints return static files instead of running Sharp on full page images.

**Key discovery**: `calendar_days.day_image_path` already exists in the schema (0003_schema.sql:68) with UPDATE grant for `madonnahist_app` (0006:30). No migration needed — just start populating it.

### Implementation

**1. Add `cropObjectKey()` to `src/lib/ingest/spaces-upload.ts`**
- Pattern: `crops/{year}/{mm}/{YYYY-MM-DD}-v{gridVersion}.jpg` — includes `grid_version` to avoid stale crops after grid changes
- Cannot rely on `uploadIfAbsent()` for overwrites — it skips when byte length matches, which could silently keep a stale crop. Use a force-upload path (`uploadObject()`) for crop generation, or change key on every grid version so the old key is simply orphaned.

**2. Create `src/lib/image/generate-crops.ts`** — shared batch generation logic
- `generateCropsForPage(pageId)` → `{ generated, skipped, errors }`
- Loads page image ONCE (warped if available), normalizes it once via `sharp(buf).rotate().toBuffer()`, then extracts each day's crop via `sharp(normalized).extract(bounds).jpeg().toBuffer()` directly — NOT via `cropRegion()`, which re-decodes the full image on every call (`crop.ts:84` calls `toBuffer()` each time, meaning 30+ full-page decodes per page)
- Uploads each crop, updates `calendar_days.day_image_path`
- Sequential processing — one crop buffer at a time, bounded memory

**3. Wire into ALL geometry-changing actions** (`src/routes/admin/grid-align/[pageId]/+page.server.ts`)
- Call `generateCropsForPage(pageId)` after transaction commits in `applyWarp`, `saveGrid`, AND `resetWarp` (which also changes grid_lines and coordinate space)
- Inside each transaction that changes crop_bounds, also clear `day_image_path = NULL` for all affected days — this ensures the on-demand fallback is used if crop generation fails partway through
- Runs outside transaction — if it fails, on-demand fallback still works because `day_image_path` was cleared

**4. Wire into ingestion and cleanup paths** (`src/lib/ingest/ingest.ts`, `src/routes/admin/capture/+page.server.ts`)
- Call after `ingestPage()` and `replacePage()` transaction commits
- Initial crops use naive grid division; replaced when operator does applyWarp/saveGrid later
- `uningest` action: delete crop objects from Spaces (currently only deletes page/warped images)
- `replacePage`: delete old crops before generating new ones

**5. Update serving endpoints** to prefer pre-generated crops:
- `src/routes/correct/day/[date]/cell-image/+server.ts` — if `day_image_path` is set and no `pad` param, fetch from Spaces directly (no Sharp, no page download). Padded requests fall back to on-demand.
- `src/routes/admin/ocr-review/[pageId]/crop/[dayId]/+server.ts` — same pattern, never uses padding so pre-generated crop always suffices

**6. Update OCR worker** (`backend/workers/ocr-worker.ts`)
- In `runLlmCleanup`, check `day_image_path` before cropping from full page
- If set, fetch pre-generated crop via `getObject()` — skip full page download entirely when all days have crops

**7. Bulk backfill script** — `scripts/generate-crops.ts`
- Standalone script: `npx tsx --env-file=.env scripts/generate-crops.ts [--page-id=N]`
- Iterates pages with finalized grid_lines, generates missing crops
- Run once after deploy for existing 8 pages (~240 crops, ~24 MB total)

### Storage estimate
~100KB/crop × 30 days × pages ingested. Currently ~8 pages = ~24 MB. At full scale (60 years × 12 months) = ~2.1 GB. Negligible on Spaces ($5/250GB).

---

## Task #14: Separate OCR Worker into PM2 Process

**Goal**: Run the OCR worker as a persistent PM2-managed daemon instead of ad-hoc `child_process.spawn()` from the web process.

### Implementation

**1. Add `--daemon` loop mode to `backend/workers/ocr-worker.ts`**
- New flag: `--daemon` makes worker poll `job_runs` continuously
- Loop: claim job → process → repeat; sleep 5s when queue empty
- `runPageOcr()` and `runLlmCleanup()` return job count (currently void)
- Graceful shutdown via SIGINT/SIGTERM handlers (PM2 sends these)
- Periodic memory logging every ~5 minutes (poll count % 60)

**2. Add worker heartbeat**
- After each poll cycle, update `app_state` key `worker_heartbeat` with `{ pid, rss_mb, last_poll }`
- Gives Task #15's monitoring a way to check worker liveness without PM2 API calls
- Requires migration: GRANT INSERT, UPDATE on `app_state` to `madonnahist_worker` role (currently worker only has SELECT on app_state per 0004_grants_rls.sql:58). Alternatively, use a dedicated `worker_heartbeats` table with explicit worker grants to avoid broadening app_state permissions.

**3. Add PM2 entry in `ecosystem.config.cjs`**
```javascript
{
    name: 'madonnahist-worker',
    script: 'backend/workers/ocr-worker.ts',
    interpreter: 'node_modules/.bin/tsx',
    interpreter_args: '--env-file=.env',
    cwd: '/opt/madonnahist',
    args: '--daemon',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    max_memory_restart: '1000M',
    out_file: '/var/log/pm2/madonnahist-worker.out.log',
    error_file: '/var/log/pm2/madonnahist-worker.err.log',
    merge_logs: true, time: true,
    env: { NODE_ENV: 'production' }
}
```
Note: use `node_modules/.bin/tsx` instead of `npx` to avoid npx startup ambiguity and overhead.

**4. Simplify `src/lib/workers/spawn.ts`**
- `spawnOcrWorker()` becomes a no-op — the daemon picks up enqueued jobs automatically
- Jobs are already enqueued by `cancelAndRequeueOcr()` in the grid-align action
- Keep the function signature for API compatibility

**5. Update `scripts/deploy-to-DO.sh`**
- Change `pm2 restart "${PM2_APP}"` to `pm2 startOrReload ecosystem.config.cjs --update-env` (handles both existing and new processes safely — `restart` alone won't start a process that doesn't exist yet)
- Follow with `pm2 save` to persist the new process list

---

## Task #15: Add System Health Monitoring

**Goal**: Admin-only dashboard showing memory, worker status, and job queue — no external monitoring service needed.

### Implementation

**1. Periodic memory logging** — `src/lib/server/monitoring.ts`
- 5-minute interval: `[MEM] rss=XXXmb heap=XXX/XXXmb`
- Import once from `hooks.server.ts`
- `.unref()` so timer doesn't prevent shutdown
- PM2 captures to `/var/log/pm2/madonnahist.out.log` — greppable

**2. New page: `src/routes/admin/system-health/+page.server.ts`**
- Process memory: `process.memoryUsage()` (RSS, heap used/total)
- System memory: `os.totalmem()`, `os.freemem()`, plus parse `/proc/meminfo` for `MemAvailable`, `SwapTotal`, `SwapFree` (the OOM evidence was swap exhaustion — `os.freemem()` alone doesn't show swap pressure)
- Load average: `os.loadavg()`
- Job queue stats: single query with `COUNT(*) FILTER (WHERE status = ...)` on `job_runs`
- Worker heartbeat: read `app_state` key `worker_heartbeat` (shows worker PID, RSS, last poll time)
- Page cache stats: export from `page-cache.ts`

**3. New page: `src/routes/admin/system-health/+page.svelte`**
- Sections: System, Job Queue, Worker, Page Cache
- Auto-refresh every 30s via `setInterval` + `invalidateAll()`
- Follow existing admin page layout conventions

**4. Add link on admin dashboard** (`src/routes/admin/+page.svelte`)

---

## Implementation Order

| Phase | Task | Why this order |
|-------|------|---------------|
| 1 | #13 Pre-generate crops | Eliminates OOM root cause; all other work is safer once this lands |
| 2 | #14 PM2 worker | Reliability improvement; benefits from Task #13 (worker uses pre-generated crops) |
| 3 | #15 Monitoring | Observability; verifies Tasks #13 and #14 are working as expected |

Phases 2 and 3 can overlap since they touch different files.

---

## Files Modified

### Task #13
| File | Change |
|------|--------|
| `src/lib/ingest/spaces-upload.ts` | Add `cropObjectKey()` |
| `src/lib/image/generate-crops.ts` | **New** — shared batch crop generation |
| `src/routes/admin/grid-align/[pageId]/+page.server.ts` | Call `generateCropsForPage()` after applyWarp/saveGrid |
| `src/lib/ingest/ingest.ts` | Call after ingestPage()/replacePage() |
| `src/routes/correct/day/[date]/cell-image/+server.ts` | Prefer pre-generated crop from Spaces |
| `src/routes/admin/ocr-review/[pageId]/crop/[dayId]/+server.ts` | Prefer pre-generated crop from Spaces |
| `backend/workers/ocr-worker.ts` | Use pre-generated crops in runLlmCleanup |
| `scripts/generate-crops.ts` | **New** — bulk backfill script |

### Task #14
| File | Change |
|------|--------|
| `backend/workers/ocr-worker.ts` | Add --daemon loop, signal handlers, heartbeat |
| `src/lib/workers/spawn.ts` | Simplify to no-op |
| `ecosystem.config.cjs` | Add madonnahist-worker entry |
| `scripts/deploy-to-DO.sh` | Handle both PM2 apps |

### Task #15
| File | Change |
|------|--------|
| `src/lib/server/monitoring.ts` | **New** — periodic memory logging |
| `src/hooks.server.ts` | Import monitoring module |
| `src/routes/admin/system-health/+page.server.ts` | **New** — health data loader |
| `src/routes/admin/system-health/+page.svelte` | **New** — admin dashboard UI |
| `src/routes/admin/+page.svelte` | Add System Health link |

---

## Verification

### Task #13
1. `npm run check` + `npm run build` — zero errors
2. Test locally first with `MADONNAHIST_OBJECT_STORE=local` and test DB (per repo test environment conventions)
3. Run grid-align applyWarp on a test page → verify crops appear in local store / Spaces under `crops/` prefix
4. Check `calendar_days.day_image_path` is populated for all days on that page
5. Load OCR review page → verify crop images load (confirm no Sharp/on-demand fallback via server logs, not network tab — Spaces objects are private, so the browser still requests through SvelteKit endpoints)
6. Load correction UI day view → verify cell image loads from pre-generated crop
7. Verify stale crop handling: run applyWarp again → confirm `day_image_path` cleared in transaction, new crops generated with updated grid_version key
8. Verify uningest cleans up crop objects from Spaces
9. Production backfill (post-deploy): `npx tsx --env-file=.env scripts/generate-crops.ts` → all existing pages get crops
10. Monitor RSS during OCR review of a 31-day month — should stay well under 500MB

### Task #14
1. Start worker locally: `npx tsx --env-file=.env backend/workers/ocr-worker.ts --daemon`
2. Enqueue a page_ocr job → verify worker picks it up within 5 seconds
3. Check `app_state` key `worker_heartbeat` updates every poll cycle
4. Kill worker (Ctrl+C) → verify graceful shutdown log message
5. Deploy → verify `pm2 list` shows both `madonnahist` and `madonnahist-worker`
6. Trigger OCR from grid-align → verify worker processes without web process spawning a child

### Task #15
1. Navigate to `/admin/system-health` → verify all sections render
2. Verify auto-refresh updates numbers every 30 seconds
3. Check PM2 logs: `grep '\[MEM\]' /var/log/pm2/madonnahist.out.log` shows periodic entries
4. Verify worker heartbeat section shows "online" with recent timestamp

---

## Codex Review (2026-06-11)

The following issues were identified by Codex review and integrated into the plan above:

| Priority | Finding | Resolution |
|----------|---------|------------|
| P1 | Crop keys must be versioned — `uploadIfAbsent()` skips same-size objects, silently keeping stale crops | Added `grid_version` to crop key pattern; clear `day_image_path` in transaction when crop_bounds change |
| P1 | `cropRegion()` re-decodes the full page image on every call (30+ decodes per page) | Changed to normalize page buffer once, then `sharp(normalized).extract()` per crop |
| P1 | `resetWarp` also changes geometry but wasn't wired for crop regeneration; uningest doesn't clean up crops | Added resetWarp, uningest, and replacePage to the list of paths that invalidate/regenerate crops |
| P1 | Worker heartbeat writes to `app_state` but worker role lacks INSERT/UPDATE grant | Added migration requirement for worker grants on app_state (or dedicated heartbeat table) |
| P2 | Verification assumed direct browser-to-Spaces traffic, but Spaces objects are private | Changed verification to check server logs for fallback path, not network tab |
| P2 | `pm2 restart` won't start a new process that doesn't exist yet | Changed to `pm2 startOrReload ecosystem.config.cjs --update-env` |
| P2 | `npx` has startup ambiguity; prefer direct path | Changed PM2 interpreter to `node_modules/.bin/tsx` |
| P2 | Monitoring must include swap and load average, not just `os.freemem()` | Added `/proc/meminfo` parsing for SwapTotal/SwapFree/MemAvailable + `os.loadavg()` |
| P3 | Context overstated worker state as "persistent" when it's actually ad-hoc spawn | Corrected to "ad-hoc worker spawns overlapping with web crop generation" |
