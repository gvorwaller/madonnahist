# 2026-06-04 Devlog

## 09:42 EST - Production 500 Error Investigation

### Summary
User reported a 500 error while using the app (correction UI) within the past hour. SSH'd into the production droplet (`root@134.199.211.199`) and swept PM2 status, PM2 stdout/stderr logs, nginx access/error logs, Postgres logs, `dmesg`, `journalctl`, and memory state. **No origin-side error was found** — the Node process never crashed, never restarted in the window, and returned no 5xx. The most likely explanation is a Cloudflare-generated error caused by transient origin unreachability under memory/swap pressure. The standout finding is that madonnahist's Node process holds **409 MB RSS on a 1 GB droplet**, which warrants follow-up.

### What Was Found

**Process is healthy — no crash, no recent restart**
- `madonnahist` (PM2 id 3) up continuously since the 2026-06-03 16:27 UTC deploy (~21h). Both of its 2 lifetime restarts were at that deploy; `unstable_restarts: 0`. No restart in the last hour.
- Host `uptime`: 98 days, load average `0.03` — no CPU stress.
- No runtime OOM-kill. The only `dmesg` OOM events are from **Apr 27–28** and were `npm ci` *deploy* processes being killed during build, not the running app.

**No 5xx reached the origin**
- Dedicated `madonnahist.access.log` (current + all rotated/gzipped back to May 11): **zero 5xx**, every request `200`. Today's traffic: a correction session 12:08–12:23 UTC (all `POST .../save` returned 200), then one `GET /correct` → 200 at 13:34. Access-log gap from 12:23 → 13:34.
- `madonnahist.error.log` (nginx): empty (0 bytes since May 11).
- App stderr (`/var/log/pm2/madonnahist.err.log`) logs every non-2xx; today it has **nothing** — no unhandled exceptions. Last entries are favicon 404s from yesterday.

**Postgres clean in the window**
- No errors 12:00–13:40 UTC; just a normal checkpoint at 12:25 (correlates with the 12:23 save). The permission-denied errors at 00:23–00:32 UTC are unrelated leftovers from an overnight manual migration run as the wrong role (`madonnahist_owner` attempting CREATE DATABASE / ALTER on tables it doesn't own).

**Memory pressure (the real concern)**
```
Mem:  961 total / 865 used / 77 free / 95 available    Swap: 216 used (807 free)
madonnahist node RSS: 409 MB = 41.6% of RAM
giftlist:     87 MB
gaylonphotos: 80 MB
```
- 1 GB droplet shared by three Node apps + Postgres + nginx, running with only **~95 MB available and swap actively engaged**.
- madonnahist's process is **~5× the footprint of its two sibling apps** despite a similar SvelteKit/adapter-node stack — an anomaly. The heavy routes exercised today were image endpoints (`cell-image`, `page-image`, and a 1.4 MB `grid-align/page-image`), which run Sharp.

### Theory
Because nothing errored at nginx, the app, or Postgres, the 500 the user saw almost certainly **originated at Cloudflare's edge, not the origin** — a transient origin timeout/unreachable blip (Cloudflare 502/520/522/524, which a user would reasonably round to "500"). Under the observed memory pressure, a heavy Sharp/image request causing a brief swap-thrash stall is the likeliest trigger: the Node process stalls long enough that Cloudflare's connection to the origin times out and CF serves its own error page. Cloudflare-generated 5xx never reach nginx, which is consistent with the absence of any origin log line and the access-log gap at 12:23–13:34.

### Follow-Up Needed
1. **Confirm error source in the Cloudflare dashboard** — Analytics → Security/Errors, or origin error events for `madonnahist.gaylon.photos` around the timeframe. That is the only place a CF-generated 5xx would be recorded.
2. **Investigate madonnahist's outsized memory footprint (409 MB RSS).** It is disproportionate vs. siblings (~80 MB). Suspect a **Sharp buffer leak** — watch whether RSS grows after image-heavy requests (`cell-image`, `page-image`, `grid-align`, OCR cropping) and is not released. Consider a `max_memory_restart` guardrail in the PM2 ecosystem config given how tight the box is.
3. **A DigitalOcean plan upgrade for more memory may be needed.** The droplet runs three Node apps + Postgres on 1 GB with swap already in use; headroom is minimal and deploy-time `npm ci` has previously been OOM-killed (Apr 27–28). More RAM would relieve both the swap-thrash stalls and the deploy fragility, independent of fixing the per-process leak.

### Files Modified
- None. Investigation only; no code changed.

## 14:30 EST - Table-Driven OCR Prompt, Admin Vocabulary UI, Memory Leak Fix, Landing Page

### Summary
Major session: replaced the hardcoded OCR cleanup prompt with a DB-driven one, built an admin UI for vocabulary/lexicon management, fixed a production memory leak (409 MB → 34 MB), added a landing page with route hub, and survived an accidental production database drop-and-restore.

### What Was Done

**Table-driven OCR prompt** (`backend/workers/ocr-worker.ts`):
- Replaced hardcoded `CLEANUP_PROMPT` (14 names, 8 activities, 2 places, 6 terms) with `buildCleanupPrompt()` that queries `ocr_vocabulary` (active terms by category) and `correction_lexicon` (top 50 active pairs as "KNOWN OCR ERRORS" hints)
- Prompt cached per worker run, refreshed every 50 jobs
- SHA-256 hash of assembled prompt stored in `llm_draft_runs.prompt_version` as `dynamic-v1-{hash}` for provenance
- Added `--show-prompt` flag to print the assembled prompt and exit

**Admin vocabulary/lexicon UI** (`/admin/vocabulary`):
- Two-section page: OCR Vocabulary (grouped by category with add/edit/toggle/delete) and Correction Lexicon (suppress/restore/promote to vocabulary)
- All 7 form actions wrapped in `withTransaction` with `audit_log` rows (CODEX review finding)
- `requireAdmin(locals)` guard on load and all actions
- Migration 0014: soft-delete columns (`is_active`, `suppressed_at`) on `correction_lexicon` — preserves the 0013 DELETE revoke instead of re-granting DELETE (CODEX review finding)
- Migration 0015: seed gaylon admin user (CODEX review finding)

**Admin auth hardening** (5 rounds of CODEX review):
- Initial: CF header check → CODEX flagged as spoofable
- Revised: `event.getClientAddress()` localhost-only → CODEX flagged nginx proxies all requests as localhost
- Final: nginx `location /admin { return 403; }` blocks public access + localhost IP check in hooks + `requireAdmin()` in route actions
- Moved `/correct/day/[date]` full-page lightbox from `/admin/grid-align/{pageId}/page-image` to `/correct/day/{date}/page-image` to avoid nginx block (CODEX review finding)

**Image buffer memory leak fix** (`src/lib/image/page-cache.ts`):
- Root cause: three identical `pageCache` Maps at module scope (one per image endpoint), each storing `Promise<Buffer>` with 5-minute TTL and lazy-only eviction. If no new requests arrived, buffers persisted indefinitely.
- Fix: single shared LRU cache with max 2 entries, 60-second active eviction via `setTimeout().unref()`, inflight dedup to prevent stampede
- Cache key includes `:rotated` suffix to prevent cross-contamination between rotated and non-rotated buffers (CODEX review finding)
- Production RSS: 409 MB → 34 MB at startup, 16.4 MB after redeploy

**Landing page and navigation**:
- Root page (`/`): three-card hub routing to Corrections (active), Admin (active), Family Viewer (coming soon stub)
- Admin index (`/admin`): dashboard with links to all 4 admin tools
- Family viewer stub (`/app`): placeholder with planned feature list
- Shared layout header with "madonnahist" home link and section indicator

**Production database incident**:
- SSH tunnel on port 5435 connects to the production DB on the DO droplet — there is no local PostgreSQL instance for madonnahist
- Accidentally dropped the production database while trying to "load prod data locally"
- Restored immediately from the pg_dump taken moments before the drop (2702 lines, all data intact)
- Had to fix ownership on all tables/sequences/schemas (pg_dump --no-owner strips ownership) and re-apply all GRANT/REVOKE statements from migrations
- All data verified: 1 page, 31 days, 27 corrections, 30 vocab, 23 lexicon entries

### Files Modified
- `backend/workers/ocr-worker.ts` (dynamic prompt builder, --show-prompt, prompt_version hash)
- `backend/db/migrations/0014_lexicon_soft_delete.sql` (new)
- `backend/db/migrations/0015_seed_admin_user.sql` (new)
- `deploy/nginx.conf` (block /admin from public)
- `src/hooks.server.ts` (admin auth stub with localhost guard)
- `src/lib/image/page-cache.ts` (new — shared LRU image cache)
- `src/routes/admin/vocabulary/+page.server.ts` (new — load + 7 form actions with transactions)
- `src/routes/admin/vocabulary/+page.svelte` (new — two-section admin UI)
- `src/routes/admin/+page.svelte` (new — admin dashboard)
- `src/routes/+page.svelte` (rewrite — landing page hub)
- `src/routes/+layout.svelte` (shared header bar)
- `src/routes/app/+page.svelte` (new — family viewer stub)
- `src/routes/correct/day/[date]/page-image/+server.ts` (new — moved from admin)
- `src/routes/correct/day/[date]/+page.svelte` (page-image URL fix)
- `src/routes/correct/day/[date]/cell-image/+server.ts` (use shared cache)
- `src/routes/admin/grid-align/[pageId]/page-image/+server.ts` (use shared cache)
- `src/routes/admin/ocr-review/[pageId]/crop/[dayId]/+server.ts` (use shared cache)
- `docs/2026-06-03-table-driven-ocr-vocab-plan.md` (new — plan doc with CODEX review integration)

### Key Technical Insight
The 409 MB RSS on a 1 GB droplet was caused by three identical module-scope `Map<string, { promise: Promise<Buffer> }>` caches with lazy-only TTL eviction. Each cache stored full-resolution page images (~4 MB compressed, larger when Sharp decodes to pixels). The TTL cleanup only ran when a *new* request arrived — if traffic stopped, buffers persisted indefinitely. Three separate caches meant the same image could be cached three times. Replacing with a single 2-entry LRU cache with active `setTimeout` eviction dropped RSS from 409 MB to 16-34 MB. The sibling apps (gaylonphotos, giftlist) run at 28-62 MB — madonnahist is now in the same range.

Also learned: port 5435 in `.env` is an SSH tunnel to the production database, not a local instance. There is no local PostgreSQL for this project. Always verify what a port actually connects to before running destructive operations.

### Next Steps
- Monitor production RSS over the next week (td-b10bd3)
- Photograph more calendar pages with the capture rig
- OCR worker integration with `ocr_vocabulary` table (table-driven prompt is deployed, needs to be tested on new pages)
- Build the family viewer (`/app`) — "On this day in family history," day detail, search
- Real auth with argon2id + cookie sessions (td-510a34)
