# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **DO NOT modify this file without explicitly asking the user first.**

## Session Startup (Do These First, In Order)

1. **Read `cs.md`** — hard rules on debugging methodology, infrastructure details, and historical failures. Non-negotiable.
2. **Read `docs/calendar-history-system-V4.md`** — the authoritative system spec (architecture, data model with append-only history tables, DB role grants, module specs, phases). If other docs conflict, this wins.
3. **Read `docs/ui-mockups-V2.md`** — UI mockups for Madonna's correction UI (iPad) and the family viewer (phone).
4. **Read `docs/equipment-shortlist.md`** — capture-side workflow (G9 II + 60mm + LR Classic → DO Spaces handoff to ingestion).
5. **Check recent devlog** — review the last few entries in `docs/devlog/` for recent decisions and work.
6. **Task management** — run `td usage --new-session` to see current work (after reading docs).

## Project Overview

A private family-access web app that digitizes ~60 years of handwritten family calendar entries into a structured, searchable, and explorable personal history.

**Pipeline**: G9 II + 60mm macro captures → LR Classic (catalog/keyword/export) → DO Spaces uploads + DB rows → vendor OCR/HTR → LLM cleanup draft → human correction (Madonna on iPad) → structured `calendar_days` rows → entity extraction → search/timeline/book views (family on phones).

The system has three surfaces:
- **Admin (Gaylon)** — full read/write, manages users, runs reprocessing jobs, reviews audit log
- **Correction UI (Madonna, iPad-first)** — three-pane editor (image | OCR draft | corrected text), queue-based session workflow, large touch targets, keyboard shortcuts when paired
- **Family viewer (phone-first)** — "On this day in family history," day detail, year/decade browse, full-text search, immersive book view, person profiles

Built with **SvelteKit** (TypeScript, adapter-node, Svelte 5 with runes), **PostgreSQL** as source of truth (port 5434, db `madonnahist`, user `madonnahist_user`), hosted on a shared DigitalOcean droplet (with gaylonphotos and giftlist) behind Nginx + Cloudflare at `madonnahist.gaylon.photos`. Image storage in DigitalOcean Spaces. AI harness workers (OCR, LLM cleanup, entity extractor, summary generator) are queue-driven (Postgres-based) PM2 processes separate from the web app.

Implementation follows the 4-phase plan in `docs/calendar-history-system-V4.md` § 11.

## Commands

```bash
# Dev server — runs on port 5176 (5173 BTC Dashboard, 5175 giftlist, 5176 madonnahist)
npm run dev

# Production build
npm run build

# Type checking + diagnostics (0 warnings baseline — fix any new warnings)
npm run check

# Apply DB migrations (logs each filename to admin.schema_migrations — runs once per box)
./backend/db/migrate_pg.sh

# Deploy to production (ALWAYS use this — never manual SSH + build)
./scripts/deploy-to-DO.sh
```

## Architecture

### Document Hierarchy
- `docs/calendar-history-system-V4.md` — **authoritative system spec**. Architecture, data model (with append-only `ocr_runs` / `llm_draft_runs` / `day_corrections`), DB roles & grants, trigger-maintained denormalizations, module specs, phases. If other docs conflict, this wins.
- `docs/ui-mockups-V2.md` — UI mockups for Madonna's correction UI (iPad) and the family viewer (phone). Information architecture, not pixel-perfect designs; visual polish (palette, fonts) deferred.
- `docs/equipment-shortlist.md` — capture-side workflow: G9 II + Olympus 60mm macro on tripod (horizontal, conservation-lab geometry), Lumix Tether → LR Classic → exported TIFFs feed the ingestion module.
- `docs/Calendar_Digitization_Plan.md` — original capture-side guide (preliminary research). Superseded by `equipment-shortlist.md`; retained for historical context.

### High-Level Data Flow

```
G9 II + Olympus 60mm macro (tripod, horizontal capture, page on cradle)
    ↓
Lumix Tether → watched folder → LR Classic auto-import (catalog, keyword, develop)
    ↓
LR Classic export (TIFF + sidecar) → upload-page.mjs script
    ↓
DigitalOcean Spaces (originals + per-day crops) + Postgres (calendar_pages, calendar_days)
    ↓
OCR Worker (Transkribus / Google Vision / Azure — pluggable)
    ↓
LLM Cleanup Worker (writes llm_draft_text, NEVER corrected_text)
    ↓
Madonna's correction UI (iPad) — three-pane editor writes corrected_text
    ↓
Entity Extractor Worker (tags, entities) → Summary Generator Worker (year/decade narratives)
    ↓
SvelteKit family viewer (phone-first) — today, day detail, year/decade, search, book view
    ↓
nginx → Cloudflare (TLS, edge caching) at madonnahist.gaylon.photos
```

### Tech Stack
- **Frontend + server**: **SvelteKit** (TypeScript, adapter-node, Svelte 5 with runes) — chosen over React for smaller mobile runtime, full-stack-in-one-framework simplicity, and operational match with giftlist on the same droplet
- **Database**: PostgreSQL (native install, no Docker) — `madonnahist` on port `5434`, user `madonnahist_user`. `pg` driver.
- **Auth**: cookie sessions + argon2id (matches giftlist pattern)
- **Image processing**: Sharp (Node) for thumbnails and day-cell crops
- **OCR / HTR**: multi-vendor pluggable — Transkribus (trainable on family handwriting, primary), Google Vision API, Azure Document Intelligence (fallbacks)
- **LLM**: Anthropic Claude (or pluggable) for cleanup, entity extraction, summary generation
- **Image storage**: DigitalOcean Spaces (S3-compatible) — originals and per-day crops; `calendar_pages.page_image_path` / `calendar_days.day_image_path` store Spaces object keys
- **Workers**: PostgreSQL-backed job queue (`SELECT FOR UPDATE SKIP LOCKED` on `job_runs`); each worker is a separate PM2 entry
- **Hosting**: DigitalOcean droplet (shared with gaylonphotos + giftlist) on port `3002`, nginx reverse proxy, Cloudflare in front at `madonnahist.gaylon.photos`

### Data Model

Full DDL is in `docs/calendar-history-system-V4.md` § 6. Quick orientation:

- **`calendar_pages`** — one row per scanned monthly page
- **`calendar_days`** — canonical per-day record (`entry_date` UNIQUE). Carries the *current* `corrected_text` as a denormalized read-cache plus FK pointers to the latest machine outputs (`latest_ocr_run_id`, `latest_llm_draft_run_id`, `latest_confidence_score`).
- **`ocr_runs` / `llm_draft_runs`** — append-only history of every OCR vendor attempt and every LLM cleanup pass. Multiple runs per day coexist; `calendar_days` points at the latest.
- **`day_corrections`** — append-only history of every human save. The trigger `trg_after_correction_insert` is the *only* writer of `calendar_days.corrected_text`.
- **`day_tags`** (relational, replaces a `TEXT[]`) — freeform tags with source human/AI
- **`entities` + `day_entities`** — canonical people/places/events with `alias_of_entity_id` resolution
- **`crop_templates`** + `calendar_days.crop_bounds` — first-class crop geometry, per year/month
- **`correction_sessions`** — explicit session state for "resume where you left off"
- **`narrative_summaries`**, **`audit_log`**, **`job_runs`**, **`app_state`** — supporting tables

Triggers maintain `calendar_days` denormalizations from inserts on `day_corrections`, `ocr_runs`, `llm_draft_runs`, `day_tags`, and `day_entities` (see V4 § 6.1). The `search_aux_text` column is trigger-maintained and folds tag labels + entity names into the FTS index.

### OCR Pipeline & Human-Truth Invariant

```
image → OCR worker → ocr_runs row → LLM cleanup worker → llm_draft_runs row
                                  ↓
                  Madonna's correction UI → day_corrections row
                                  ↓
                  trigger updates calendar_days.corrected_text (the only writer)
```

**Human `corrected_text` is sacred.** Machine outputs are append-only history that the UI surfaces as suggestions only. The invariant is enforced **at the DB role layer**, not just policy: workers connect as `madonnahist_worker`, which has no UPDATE permission on `calendar_days.corrected_text`/`corrected_by`/`corrected_at`/`correction_status` (see V4 § 8). A buggy worker gets a permission error, not silent corruption.

### Human Correction UI

Three-pane layout: `[ Image ] | [ OCR + LLM draft ] | [ Corrected ]`. iPad-first, large touch targets, queue-based session workflow. Full mockups in `docs/ui-mockups-V2.md` § A.

### AI Harness

Independent workers, each as a separate PM2 entry, all reading `job_runs` via `SELECT FOR UPDATE SKIP LOCKED`:
- **OCR Worker** — submits images to vendor; appends `ocr_runs` row; trigger updates `calendar_days.latest_ocr_run_id`
- **LLM Cleanup Worker** — appends `llm_draft_runs` row based on the latest OCR run + context
- **Entity Extractor** — on `accepted` correction, writes to `entities` and `day_entities`, resolves aliases, optionally proposes AI-sourced `day_tags`
- **Summary Generator** — per-year/decade/person narratives into `narrative_summaries` (unpublished by default; admin gates publication)

### API & Routing

SvelteKit `+server.ts` endpoints + form actions; no separate Express service. Full route map in `docs/calendar-history-system-V4.md` § 9.6–9.8. Summary:

- `/correct/*` — Madonna's correction UI (corrector or admin role)
  - `/correct` — session home / queue
  - `/correct/day/[date]` — three-pane editor
  - `/correct/calendar` — month-grid navigator
- `/admin/*` — admin surfaces (admin role only)
- `/app/*` (or `/`) — family viewer (any authenticated user, read-only)
  - `/app` — "On this day in family history"
  - `/app/day/[date]`, `/app/year/[year]`, `/app/decade/[decade]`
  - `/app/search`, `/app/book/[scope]/[key]`, `/app/person/[slug]`

## Phases (per `docs/calendar-history-system-V4.md` § 11)

1. **Phase 1 — Foundation**: DB, auth, page upload script, naive day-cell cropping, OCR worker (one vendor), correction UI three-pane editor + queue, basic day-detail viewer
2. **Phase 2 — UX & Search**: refined day-cell cropping (template UI), search, tag UI, calendar nav, mobile viewer polish
3. **Phase 3 — AI enrichment**: LLM cleanup, entity extractor, name aliases, person/place pages
4. **Phase 4 — Narrative & Polish**: summary generator, book view, decade summaries, Transkribus family-handwriting training, semantic search (pgvector), backup automation

## Environment Variables

Required in `.env` (final list firms up as the app is built):
- `DATABASE_URL` or discrete `PGHOST` / `PGPORT=5434` / `PGUSER=madonnahist_user` / `PGDATABASE=madonnahist` / `PGPASSWORD`
- `AUTH_SECRET` — session cookie signing
- `PORT=3002` — app listen port (production)

Stored in `private_data.api_credentials` (NOT `.env` — see `cs.md` § Database & Schema):
- DO Spaces — `SPACES_KEY`, `SPACES_SECRET`, `SPACES_BUCKET`, `SPACES_REGION`, `SPACES_ENDPOINT`
- OCR vendor credentials — Transkribus, Google Vision, Azure Document Intelligence keys

## CSS Rules

**No Tailwind. No utility frameworks.** Hand-written component-scoped CSS.

The correction UI prioritizes density and keyboard ergonomics; the family view prioritizes warmth and legibility. Visual direction will firm up as mockups land — until then, keep it neutral and readable.

- Destructive actions: modal confirmation dialogs, never toast notifications (see `cs.md`)
- WCAG AAA contrast (7:1) for all text — including muted text
- Color + text label for all status indicators — never color alone

## Goal

A searchable life archive plus AI-generated narrative — sixty years of handwritten daily entries, made navigable.
