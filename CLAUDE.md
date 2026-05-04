# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **DO NOT modify this file without explicitly asking the user first.**

## Session Startup (Do These First, In Order)

1. **Read `cs.md`** — hard rules on debugging methodology, infrastructure details, and historical failures. Non-negotiable.
2. **Read `docs/calendar-history-system-V2.md`** — the authoritative system spec (architecture, data model, module specs, phases). If other docs conflict, this wins.
3. **Read `docs/ui-mockups-V1.md`** — first-cut UI mockups for Madonna's correction UI (iPad) and the family viewer (phone).
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

Implementation follows the 4-phase plan in `docs/calendar-history-system-V2.md` § 8.

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
- `docs/calendar-history-system-V2.md` — **authoritative system spec (V2)**. Architecture, data model, full module specs, phases. If other docs conflict, this wins.
- `docs/calendar-history-system.md` — V1 (preliminary ChatGPT draft). Historical reference only — superseded by V2.
- `docs/ui-mockups-V1.md` — first-cut UI mockups for Madonna's correction UI (iPad) and the family viewer (phone). Information architecture, not pixel-perfect designs.
- `docs/equipment-shortlist.md` — capture-side workflow: G9 II + Olympus 60mm macro on tripod (horizontal, conservation-lab geometry), Lumix Tether → LR Classic → exported TIFFs feed the ingestion module.
- `docs/Calendar_Digitization_Plan.md` — original capture-side guide (hardware vendor research, OCR vendor options). Largely superseded by `equipment-shortlist.md`; retained for historical context.

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

Core tables (full DDL in `docs/calendar-history-system-V2.md` Section 5):

**`calendar_pages`** — one row per scanned page (typically a month).
- `id`, `year`, `month`, `page_image_path`, `created_at`

**`calendar_days`** — one row per calendar day, with full OCR + correction lifecycle.
- `id`, `page_id` (FK), `entry_date` (UNIQUE), `day_image_path`
- `ocr_initial_text` — raw OCR output
- `corrected_text` — human-validated version
- `confidence_score` — float, from OCR vendor or post-LLM scoring
- `correction_status` — workflow state (e.g., `pending`, `in_progress`, `accepted`)
- `tags TEXT[]`, `entities JSONB` — extracted people/places/events
- `ai_summary` — per-day or aggregated narrative
- `created_at`, `updated_at`

`entry_date` is unique — one canonical row per calendar day, even if multiple page scans cover it.

### OCR Pipeline

```
image → OCR → LLM cleanup → structured text → DB
```

Stages are independent and idempotent — a day can be re-OCR'd, re-cleaned, or re-summarized without losing prior corrected text. Human `corrected_text` is sacred and never overwritten by automation.

### Human Correction UI

Three-pane layout: `[ Image ] | [ OCR ] | [ Corrected ]`

Controls: **Save**, **Accept** (corrected = ocr), **Next**, **Tag**. Optimized for keyboard-driven, high-throughput correction sessions.

### AI Harness

Independent components, each runnable as a worker:
- **OCR Worker** — submits images to vendor, stores raw text + confidence
- **LLM Cleanup** — fixes obvious OCR errors, normalizes punctuation/dates
- **Entity Extractor** — pulls people, places, events into `entities JSONB`
- **Summary Generator** — per-day, per-month, per-year, per-decade narratives

### API & Routing

SvelteKit `+server.js` endpoints + form actions; no separate Express service. Full route map in `docs/calendar-history-system-V2.md` § 6.6–6.8. Summary:

- `/correct/*` — Madonna's correction UI (corrector or admin role)
  - `/correct` — session home / queue
  - `/correct/day/[date]` — three-pane editor
  - `/correct/calendar` — month-grid navigator
- `/admin/*` — admin surfaces (admin role only)
- `/app/*` (or `/`) — family viewer (any authenticated user, read-only)
  - `/app` — "On this day in family history"
  - `/app/day/[date]`, `/app/year/[year]`, `/app/decade/[decade]`
  - `/app/search`, `/app/book/[scope]/[key]`, `/app/person/[slug]`

## Phases (per `docs/calendar-history-system-V2.md` § 8)

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
