# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **DO NOT modify this file without explicitly asking the user first.**

## Session Startup (Do These First, In Order)

1. **Read `cs.md`** — hard rules on debugging methodology, infrastructure details, and historical failures. Non-negotiable.
2. **Read `docs/calendar-history-system.md`** — the authoritative system architecture and data model.
3. **Read `docs/Calendar_Digitization_Plan.md`** — the capture-side guide (hardware, lighting, OCR vendor options).
4. **Check recent devlog** — review the last few entries in `docs/devlog/` for recent decisions and work.
5. **Task management** — run `td usage --new-session` to see current work (after reading docs).

## Project Overview

A private family-access web app that digitizes ~60 years of handwritten family calendar entries into a structured, searchable, and explorable personal history.

**Pipeline**: phone-captured calendar page images → OCR/HTR → human correction UI → structured `calendar_days` rows → search, timeline, AI summaries.

The system has two primary surfaces:
- **Admin/correction UI** — image alongside OCR draft alongside corrected text, with Save/Accept/Next/Tag controls. This is where the bulk of the work happens.
- **Family view** — read-only timeline, search, and AI-generated yearly/decade summaries.

Built with Node.js (Express) + React (Zustand for state), PostgreSQL as source of truth, hosted on a shared DigitalOcean droplet behind Nginx + Cloudflare at `madonnahist.gaylon.photos`.

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
- `docs/calendar-history-system.md` — **authoritative system spec** (architecture, data model, pipeline, phases). If other docs conflict, this wins.
- `docs/Calendar_Digitization_Plan.md` — capture-side guide: hardware (overhead phone stands, ring lights), software (Pen to Print, Transkribus, Photo2Calendar), and best practices for scanning.

### High-Level Data Flow

```
Local Capture (iPhone 15 Pro Max + overhead stand)
    ↓
Image Upload → DigitalOcean Spaces (originals + per-day crops, organized by year/month)
    ↓
OCR / HTR Pipeline (Transkribus / Google Vision / Azure Document Intelligence)
    ↓
LLM Cleanup (correct OCR errors, normalize entities)
    ↓
PostgreSQL (source of truth — calendar_pages, calendar_days; image paths reference Spaces objects)
    ↓
Node/Express API
    ↓
React UI (Admin correction view + Family read-only view)
    ↓
nginx → Cloudflare (TLS, edge caching)
```

### Tech Stack
- **Backend**: Node.js (Express), `pg` (node-postgres)
- **Frontend**: React, Zustand
- **Image processing**: Sharp; optional OpenCV for deskew/perspective correction
- **OCR / HTR**: multi-vendor — Transkribus (trainable on family handwriting), Google Vision API, Azure Document Intelligence. Pipeline should treat OCR as pluggable.
- **Database**: PostgreSQL (native install, no Docker) — `madonnahist` on port `5434`, user `madonnahist_user`
- **Image storage**: DigitalOcean Spaces (S3-compatible) — originals and per-day crops; `calendar_pages.page_image_path` / `calendar_days.day_image_path` store Spaces object keys, not local paths
- **Hosting**: DigitalOcean droplet (shared with gaylonphotos + giftlist) on port `3002`, nginx reverse proxy, Cloudflare in front at `madonnahist.gaylon.photos`

### Data Model

Core tables (full DDL in `docs/calendar-history-system.md` Section 4):

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

### API

```
GET  /days                    — list days (filterable by date range, status)
POST /days/:id/correct        — save corrected_text + status transition
GET  /timeline                — chronological browse
GET  /summary/year/:year      — AI-generated year summary
```

### Routing & Access

- **Admin/correction routes** — authenticated, full read/write
- **Family routes** — authenticated read-only, no correction UI

(Route layout TBD — define in CLAUDE.md when implementation begins.)

## Phases (per `docs/calendar-history-system.md` §10)

1. **Phase 1 — MVP**: capture pipeline, basic OCR, correction UI, DB writes
2. **Phase 2 — Search + UI**: full-text search, timeline browse, family read-only view
3. **Phase 3 — AI enrichment**: entity extraction, AI summaries
4. **Phase 4 — Advanced automation**: training Transkribus on family handwriting, batch reprocessing, narrative generation

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
