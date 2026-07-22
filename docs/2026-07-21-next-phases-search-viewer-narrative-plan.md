# madonnahist — Next Phases: Search, Family Viewer, Enrichment, Narrative, Book

*Plan drafted 2026-07-21. Revised same day after adversarial review by CODEX1 (11 findings, all verified against code; the material ones are folded into the phases below).*

## Context

Phase 1 (capture → OCR → LLM cleanup → correction) is complete and Madonna is making good progress (272 accepted / 1,581 ingested days at last measure, ~17%). Gaylon is ready to begin the next phases: Madonna should be able to find what happened across any timeframe (by date, person, activity, and more), see interesting narrative summaries, and family members should get login access. Document production starts with an on-screen book view; PDF export is a later hard requirement.

The schema was designed up-front for all of this, so no large migrations are needed: `calendar_days.fts` (stored tsvector + GIN index) is live and trigger-maintained; `entities`/`day_entities`/`day_tags`/`narrative_summaries` exist but are empty; the `viewer` role is already in the `users` CHECK constraint and all TS types; `/app` is a stub route and login already lands viewers there. The work is mostly new UI + two worker job types on existing patterns.

**Decisions made by Gaylon:** admin-created family accounts (no email infra); search ships on FTS first, entity-powered person filters after the extractor exists; AI narratives are unpublished drafts until admin review (`is_published` flag); book view on-screen now, PDF export later.

**Note vs. spec:** V5 gated Phase 2 on "enough corrected text" — Gaylon has explicitly said to begin now. Every viewer surface should state coverage so partial data reads as "in progress," not broken. td bookkeeping: old Phase 2/3 epics were closed prematurely; hang new tasks off umbrella epic **td-e25bd4**.

**Invariant honored throughout:** nothing writes `calendar_days.corrected_text` (DB role layer enforces this anyway). Workers insert only with `source='ai'` per existing RLS. Migrations numbered after production's 0019, applied via `./backend/db/migrate_pg.sh`. Deploy only via `./scripts/deploy-to-DO.sh`. `npm run check` stays at 0 warnings. No Tailwind; component-scoped CSS; WCAG AAA; modal confirms for destructive actions.

---

## Phase A — Access enablers: family accounts + route gating (small, first)

**Outcome:** Gaylon creates family accounts from `/admin/users`; viewers land on `/app` and provably cannot reach `/correct`, `/admin`, or unclassified routes.

1. **Tighten `roleAllowed()` in `src/hooks.server.ts:21-26`** — replace the `return true` default-allow with an explicit map: `/admin`→admin; `/correct`→admin|corrector; `/app` and `/` (landing)→any authenticated; anything else→403. Two review-driven requirements: **(a) public paths bypass the role check** — the hook currently runs `roleAllowed()` for every authenticated request, and logout is a POST to `/login?/logout` (`src/routes/+layout.svelte:25`), so a default-deny map without a public-path bypass breaks logout and `/api/health`; **(b) segment-boundary matching** (`path === prefix || path.startsWith(prefix + '/')`), so `/application` doesn't inherit `/app` rules. Add route tests covering the full matrix: GET+POST × {`/login`, `/api/health`, `/`, `/app`, `/correct`, `/admin`, unknown path} × {unauthenticated, viewer, corrector, admin}.
2. **New `/admin/users`** — `src/routes/admin/users/+page.server.ts` + `+page.svelte`: list users; `create` and `resetPassword` actions using `hashPassword()` from `src/lib/server/auth.ts`; write `audit_log` rows (never log plaintext or hash); modal confirm on reset. **`resetPassword` must also DELETE that user's rows from `sessions` in the same transaction** — otherwise a compromised session survives the reset. Normalize usernames exactly as login does. No delete/deactivate in v1 (no `is_active` column; user ids are FK targets). Link from the `/admin` hub. Copy admin page scaffolding from `src/routes/admin/vocabulary/`.
3. Login redirect already works (`landingFor()` in `src/routes/login/+page.server.ts` sends viewer→`/app`) — no change.

**Migrations:** none. **Verify (test stack):** create viewer via UI → login lands on `/app`; `/correct`, `/admin`, `/made-up-path` → 403; `/api/health` still public; audit rows written.

## Phase B — Family viewer core: shell, "On this day", day detail, FTS search

**Outcome:** Madonna and family can log in, see "what happened on this day" across years, open any accepted day (image + corrected text), and full-text search everything accepted so far, with a visible coverage indicator.

1. **App shell** — `src/routes/app/+layout.svelte` (+ `+layout.server.ts`): phone-first bottom nav per `docs/ui-mockups-V2.md` §B (🏠 On this day / 📅 Browse / 🔍 Search), serif body, warm palette.
2. **Shared helper** — new `src/lib/server/viewer.ts`: "publishable day" predicate (`correction_status='accepted'`), prev/next-accepted-day query, coverage counts (reuse SQL patterns from `src/routes/correct/+page.server.ts:11-34`).
3. **"On this day"** — rewrite stub `src/routes/app/+page.svelte` + new `+page.server.ts`: accepted days matching today's month/day across years; graceful empty state; coverage line.
4. **Day detail** — `src/routes/app/day/[date]/` (mockup B2): day image with zoom, corrected text, `day_narrative` if present, tag chips (empty until Phase C), prev/next accepted-day buttons. Non-accepted date → friendly "not yet transcribed" page.
5. **Viewer image endpoint** — `src/routes/app/day/[date]/image/+server.ts`, copying `src/routes/correct/day/[date]/cell-image/+server.ts` (Spaces `getObject`) — **but note the source endpoint has no status predicate** (`cell-image/+server.ts:22-29` selects by `entry_date` alone). The acceptance check must live **inside this endpoint's SQL** (`WHERE entry_date = $1 AND correction_status = 'accepted'` for viewer role), returning an indistinguishable 404 for non-accepted days — a page-level check does not protect a direct GET. Same rule generalizes: **every `/app` query independently applies the publishability predicate** (all web traffic runs as `madonnahist_app`; the DB role can't distinguish viewer from admin). Integration-test direct image GETs for pending/in-progress/accepted days × viewer/corrector/unauthenticated.
6. **Search** — `src/routes/app/search/` (mockup B4): `websearch_to_tsquery('english', $q)` against `calendar_days.fts` (first consumer of the existing GIN index `idx_calendar_days_fts`), accepted days only, parse the query once in a CTE, deterministic ordering (`ts_rank DESC, entry_date`), ~25/page, year filter, cap query length. **Coverage banner**: "Searching N of M transcribed days (P%) — more added as correction continues." Two review-driven cautions: **(a) snippet safety** — never render `ts_headline` output via `{@html}` over unescaped text (stored-XSS risk if an entry contains HTML); escape the text first, then convert the highlight sentinels to markup, or render highlight segments as normal Svelte text nodes. **(b) headline source mismatch** — the `fts` vector spans `corrected_text || expanded_text || day_narrative || ai_summary || search_aux_text` (migration 0012), so a hit may match only machine text; run `ts_headline` over `corrected_text || ' ' || coalesce(day_narrative,'')` and fall back to a plain leading snippet when no highlight is produced. `EXPLAIN ANALYZE` both a rare term and a broad term.
7. Flip the landing-page "Family Viewer — Coming Soon" card in `src/routes/+page.svelte` to a live link.

**Migrations:** none. **Verify:** seed accepted days with distinctive text in `madonnahist_test`; phrase/boolean searches hit; non-accepted days never appear; `EXPLAIN` confirms GIN use; phone-width walkthrough.

## Phase C — Browse, tag UI in correction editor, search filters

**Outcome:** Family browses any year via month grids; Madonna tags days while correcting (tags immediately improve search via the existing `search_aux_text` trigger); search gains tag filtering.

1. **New `src/lib/components/MonthGrid.svelte`** (no reusable calendar component exists — `correct/month` is a vertical list).
2. **Year browse** — `src/routes/app/year/[year]/` (mockup B3): 12 micro-grids, accepted days tappable; plus a Browse index listing decades/years with coverage %.
3. **Tag UI in correction editor** — extend `src/routes/correct/day/[date]/+page.server.ts` (`addTag`/`removeTag` actions, `source='human'`) + chip input in `+page.svelte`; suggestions from distinct existing tags; audit rows. No FTS work needed — trigger `trg_fn_refresh_search_aux_text` (migration 0005) already folds tags into `fts`.
4. **Search filters** — tag chips + year dropdown on `/app/search`; tag chips render for real on day detail.
5. Mobile polish pass across `/app`.

**Migrations:** none. **Verify:** add tag → day findable by tag text and filter; viewer cannot reach tag actions (under `/correct`).

## Phase D — Entity extraction worker + person/place pages + alias admin

**Outcome:** Accepted days automatically get AI-extracted people/places/events; `/app/person/[slug]` pages ("every day mentioning X"); person/place search filter; alias-curation admin page.

1. **Text LLM helper** — new `backend/workers/lib/llm.ts`: Anthropic client via `getApiKey('anthropic','API_KEY','ANTHROPIC_API_KEY')` (pattern in `backend/workers/lib/spaces.ts`); text-only wrapper with strict-JSON output handling. Check `@anthropic-ai/sdk` v0.98.0 supports the chosen model id; bump if needed. (OCR worker's pinned `claude-sonnet-4-6` stays as-is.)
2. **Enrichment worker** — new `backend/workers/enrichment-worker.ts`, cloned from the `ocr-worker.ts` skeleton (`claimJobs` SKIP LOCKED, `--daemon`, heartbeat, MAX_ATTEMPTS, `--limit --dry-run` flags) with review-driven hardening: **hard-coded small claim batch** independent of CLI flags (the current `claimJobs` has no SQL LIMIT without `--limit` — a backfill would claim everything at once and cross the stale-retry window); **fair per-type scheduling** and separate timeouts for cheap `entity_extract` vs long `narrative_summary` jobs; **a distinct heartbeat key** (`enrichment_worker_heartbeat` — the OCR worker owns `app_state.worker_heartbeat` and `system-health/+page.server.ts:47` reads only that; update the health page to show both workers). One binary handles both job types → one new PM2 entry in `ecosystem.config.cjs`. Also writes **proposed AI tags** (`day_tags` with `source='ai'`), which V5 requires of the extractor — surfaced later as suggestions in the correction UI.
3. **Migration 0020** (`0020_entity_enrichment.sql`): AFTER INSERT trigger on `day_corrections` WHEN `status_after='accepted'` → enqueue `entity_extract` job **with the `correction_id` in the payload**; `GRANT DELETE ON day_entities, day_tags TO madonnahist_worker` with RLS DELETE policies scoped `USING (source='ai')`; and **replace the global `entities.slug UNIQUE` with `UNIQUE (entity_type, slug)`** (table is empty; a global slug would collapse "Jordan" the person and "Jordan" the place into one row via `ON CONFLICT DO NOTHING` + re-select).
4. **Job idempotency** — at execution the worker re-reads the day: skip unless `correction_status='accepted'` AND the payload's `correction_id` is still the latest correction (re-accepts and backfill overlap otherwise let a stale job overwrite fresh AI rows). Delete-old + insert-new AI rows + job completion happen in one transaction. Dedupe: skip enqueueing when an unstarted `entity_extract` job for the same day is already pending.
5. **Backfill** — script/flag to enqueue all currently-accepted days once (safe to re-run given #4).
6. **Alias admin** — `src/routes/admin/entities/`: entities by mention count, rename, set `alias_of_entity_id`, delete bogus entities. **Alias rules enforced in the actions**: same `entity_type` only, no self-reference, no chains/cycles (target must itself be canonical — keeps `COALESCE(alias_of_entity_id, id)` resolution correct at one hop). **Merging is a transaction that rewrites `day_entities` to the canonical entity (with `ON CONFLICT` handling for days linked to both) before any delete** — a bare delete cascades `day_entities` and silently loses mentions.
7. **Viewer pages** — `src/routes/app/person/[slug]/` (and places): mention timeline + accepted-day list, alias-resolved via `COALESCE(alias_of_entity_id, id)`; person filter on search.

**Verify:** accept a day → job enqueued → worker `--limit 1` writes entities; RLS rejects `source='human'` as worker; re-accept replaces AI rows exactly once; a stale job (older `correction_id`) is a no-op; alias merge preserves every mention (row counts before/after); same slug as person and place stays two entities. Deploy order: migration → code → PM2 reload.

## Phase E — Narrative summaries: generate, review, publish

**Outcome:** Year narratives generated as unpublished drafts; Gaylon reviews/edits/publishes from admin; published narratives appear on `/app/year/[year]`, labeled AI-generated.

1. **Migration 0021**: `GRANT UPDATE (summary_text, generated_by, generated_at) ON narrative_summaries TO madonnahist_worker` (needed for `ON CONFLICT (scope, scope_key) DO UPDATE`; excludes `is_published` so the worker can never publish).
2. **`narrative_summary` job type** in the enrichment worker: gather a year's accepted days (chunk by month), generate faithful-to-source narrative via `lib/llm.ts`, upsert draft `is_published=false`. **The worker never writes to a published row — no force override.** (Review finding, critical: `narrative_summaries` has one row per `(scope, scope_key)`, and the worker can UPDATE `summary_text` but not `is_published` — a "force regenerate" on a published row would replace family-visible text with unreviewed AI output while it stays published.) Regenerating a published year requires the admin to unpublish first; the admin UI offers that as one guarded "unpublish + regenerate" action with a modal confirm.
3. **Admin review UI** — `src/routes/admin/narratives/`: per-year coverage %, Generate/Regenerate button (app role enqueues `job_runs` directly), draft preview, inline edit, publish/unpublish with modal confirm, audit rows.
4. **Viewer surfacing**: published narrative atop `/app/year/[year]` with explicit AI-generated label.
5. **Deferred, tracked under td**: decade summaries (`scope_key='1970s'`, same worker path — worth doing once several years are published) and person summaries (V5 lists year/decade/person; person summaries depend on Phase D entity volume). Each gets a td task with acceptance criteria when deferred, not silence.

**Verify:** draft invisible in `/app` until published; a `narrative_summary` job targeting a published scope is a guaranteed no-op (DB test, not just worker logic); worker cannot flip `is_published` (grant test).

## Phase F — On-screen book reader (v0 of Book View)

**Outcome:** Immersive "read 1972 as a book" per year — serif, month chapter breaks, published narrative as introduction, progress indicator, no bottom nav. Honestly scoped: this v0 is a **continuous reading flow**, not the mockup B5 paginated book (3–5 days per page, horizontal swipe, page indicator) — those land in a follow-up pass, tracked in td, once the reading surface proves itself.

1. `src/routes/app/book/[scope]/[key]/` (start `scope='year'`): continuous reading flow, month chapter headings, generous typography, scroll progress, exit affordance, **lazy-loaded images**. Layout flag in `src/routes/app/+layout.svelte` suppresses bottom nav.
2. Entry points from `/app/year/[year]` (and day detail).
3. **Build with print in mind**: semantic markup + `@media print` stylesheet with page-break rules at chapters — cheap now, sets up Phase H.

**Verify:** full accepted year measured, not eyeballed — response bytes, query time, first paint, DOM node count on a 300+-day year; AAA contrast; browser Print Preview produces something plausible.

## Phase G — "Ask the archive": ad hoc narrative queries (td-84c7fa)

**Outcome:** Gaylon (admin-only at first) can select a subset of the archive — date range, person/place entity, tag, and/or a full-text term — type a freeform question or angle ("what were the summers like when Rebekah visited?"), and get a faithful narrative generated *only from that subset*.

Design principle (the reason this lives in the app rather than raw chat): the app owns all three boundaries. **Retrieval** — the subset resolves via the existing search/filter SQL with the accepted-only predicate before any AI involvement. **Framing** — the user's text is the angle, never the rules; it's wrapped in the Phase E faithfulness contract (only these entries, no invented facts, cite dates). **Output** — labeled AI-generated, ephemeral by default, saveable with provenance (the question + exact subset definition stored with the result; saving needs an `adhoc` scope or a small sibling table to `narrative_summaries` — minor migration).

Build shape: one admin page (subset pickers reusing the search filters + question box + result view) and one synchronous endpoint reusing `backend/workers/lib/llm.ts` with a hard cap on days fed per query. Later, optionally, a tightly bounded cost-capped family version ("Ask the archive") — separate decision when the admin version has proven itself.

## Phase H (later — eventual hard requirement) — PDF/print export

Direction only, not scheduled: headless Chromium (Playwright) renders the book route with the print stylesheet → PDF, as an admin-triggered `job_runs` job (`pdf_export`); output to Spaces, linked from admin. `job_type` is unconstrained TEXT — no migration. Decisions deferred: with-images vs text-only, per-year vs full-book, front matter.

---

## Dependency order

A → B → C sequential. D and E depend on B (share the worker + `lib/llm.ts` — do D before E). F needs E only for the narrative intro (could ship earlier with that slot empty). G (Ask the archive) after F, reusing D/E rails. H after F. Each phase independently deployable via `./scripts/deploy-to-DO.sh`.

## Timezone convention (all phases)

Storage is UTC (`timestamptz`), matching the BTC-dashboard precedent; `entry_date` is a civil `DATE` and is never converted. Local time is applied only at the edges via `src/lib/server/time.ts`: `todayInAppTz()` anchors "On this day" to the family's home timezone (`MADONNAHIST_TIMEZONE`, default `America/New_York`), and `formatTimestampInAppTz()` formats system timestamps (audit rows, `corrected_at`, job times) for display in later admin/viewer surfaces. Never trust Postgres `CURRENT_DATE`/session timezone for user-facing "today".

## Verification baseline (every phase)

- Local isolated test stack only: `.env.test`, `madonnahist_test` on `127.0.0.1:15434`, `MADONNAHIST_ENV=test`, `MADONNAHIST_OBJECT_STORE=local`. Never 5433/5435/production DB.
- `npm run check` at 0 warnings; `npm run test:db:invariants` after any migration.
- Manual phone-width walkthrough of new viewer surfaces with a viewer-role account.
- **Automated security/grant tests, not manual checks** (review finding): route-level auth matrix (Phase A); non-accepted content excluded from every viewer surface — day pages, images, search results (Phase B); worker RLS — can only INSERT/DELETE `source='ai'` rows, cannot touch `corrected_text` or `is_published`, published-narrative regeneration is a no-op (Phases D/E). Extend `backend/db/tests/` alongside `v4_invariants.sh`.

## Explicitly deferred (tracked in td, not silently dropped)

- Phase 1 correction-UX gaps from V5 quick-ref: auto-save, session lifecycle, "Accept LLM" button, History button.
- AI tag *suggestions in the correction UI* (the extractor writes `source='ai'` tags in Phase D; the UI surfacing comes later).
- Decade + person narrative summaries; mockup B5 book pagination/swipe (Phase F v0 is a continuous reader).
- Narrative style selector (td-09102a): tone/style/person presets at generate time, stored with the draft; first-person "as Madonna" needs her sign-off if offered; consider book-view style consistency across years.
- Nightly `pg_dump`-to-Spaces backup automation (NAS image pull + CCC preflight exist; the Postgres-dump leg of V5 Phase 4 remains open).
- PDF/print export (Phase H direction only).

## Key reference files

- `src/hooks.server.ts` — route gating (Phase A prerequisite for everything)
- `src/routes/correct/+page.server.ts` — progress/coverage SQL patterns to reuse
- `src/routes/correct/day/[date]/+page.server.ts` + `cell-image/+server.ts` — action/audit and image-endpoint patterns to copy
- `backend/workers/ocr-worker.ts` + `backend/workers/lib/{db,spaces}.ts` — worker skeleton, queue claiming, credential access
- `backend/db/migrations/0004_grants_rls.sql` — grant/RLS model that 0020/0021 extend
- `docs/ui-mockups-V2.md` §B — viewer screen specs; `docs/calendar-history-system-V5.md` — authoritative spec
