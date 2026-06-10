# GEMINI.md

This file provides guidance to the Gemini / Antigravity AI assistant (`agy`) when working with code in this repository.

> [!IMPORTANT]
> **DO NOT modify this file without explicitly asking the user first.**

## Immediate Local Test Setup

For any local test work, start with the isolated repo-local stack. Do not infer
test settings from production `.env`.

- Config: `.env.test` from `.env.test.example`
- Database: `madonnahist_test` on `127.0.0.1:15434`
- Environment: `MADONNAHIST_ENV=test`
- Object store: `MADONNAHIST_OBJECT_STORE=local`
- Local image/object files: `.local/object-store-test/`
- Reference: [docs/local-test-environment.md](file:///Users/gaylonvorwaller/madonnahist/docs/local-test-environment.md)

Quick start:

```bash
cp .env.test.example .env.test
npm run test:env
npm run test:db:start
npm run test:db:reset
npm run test:db:migrate
npm run test:db:invariants
```

Run the app against the test stack with:

```bash
npx vite dev --host 127.0.0.1 --port 5177 --strictPort --mode test
```

Never use port `5433`, port `5435`, `PGDATABASE=madonnahist`, production
DigitalOcean Spaces credentials, or production dumps for local tests.

## Session Startup (Do These First, In Order)

1. **Read `cs.md`** — Read the [cs.md](file:///Users/gaylonvorwaller/madonnahist/cs.md) coding standards on each new `agy` invocation. This contains non-negotiable guidelines for data integrity, database connections, adversarial code reviews, and historical failures.
2. **Read Authoritative Spec** — Refer to [calendar-history-system-V5.md](file:///Users/gaylonvorwaller/madonnahist/docs/calendar-history-system-V5.md) before implementing changes to the pipeline or backend. If schema details are needed, consult [calendar-history-system-V4.md](file:///Users/gaylonvorwaller/madonnahist/docs/calendar-history-system-V4.md).
3. **Check Recent Devlogs** — Review the latest logs in [docs/devlog/](file:///Users/gaylonvorwaller/madonnahist/docs/devlog/) to understand the current work state.
4. **Task Management** — Run `td usage --new-session` to check current active issues and run `td next` to find what to work on.

---

## Project Overview

A private family-access web app that digitizes ~60 years of handwritten family calendar entries into a structured, searchable, and explorable personal history.

**Pipeline**:
```
G9 II + 60mm macro captures
    ↓
LR Classic (catalog/keyword/export)
    ↓
Capture Intake UI (/admin/capture)
    ↓
DigitalOcean Spaces (Originals + Crops) + Postgres metadata
    ↓
OCR Worker (Gemini Handwriting Recognition)
    ↓
LLM Cleanup Worker (Claude/Gemini)
    ↓
Substitution Pass (Deterministic rules)
    ↓
Correction UI (Madonna on iPad-first)
    ↓
PostgreSQL 17 Database (Canonical calendar_days via day_corrections trigger)
```

### Note on Handwriting Recognition
We use **Gemini** as our primary vision language model (VLM) for handwriting recognition / OCR (HTR) on cropped daily calendar cells. Gemini's visual understanding and contextual reasoning are critical for deciphering the cursive, faded pencil-on-beige family calendar entries.
- Machine outputs are stored in `ocr_runs` and `llm_draft_runs` as append-only history.
- The human-corrected text is sacred and stored in `day_corrections`. Automated processes must **never** directly overwrite `corrected_text` (enforced at the database role permission level).

---

## Codebase Structure

- [backend/](file:///Users/gaylonvorwaller/madonnahist/backend/)
  - [db/](file:///Users/gaylonvorwaller/madonnahist/backend/db/) — Schema migrations, PostgreSQL connection scripts, schema tracking, and [migrate_pg.sh](file:///Users/gaylonvorwaller/madonnahist/backend/db/migrate_pg.sh).
  - [workers/](file:///Users/gaylonvorwaller/madonnahist/backend/workers/) — PM2 background workers; specifically [ocr-worker.ts](file:///Users/gaylonvorwaller/madonnahist/backend/workers/ocr-worker.ts) which polls PostgreSQL-backed job queues to run OCR/cleanup.
- [docs/](file:///Users/gaylonvorwaller/madonnahist/docs/) — Authoritative system specifications, mockups, capture guides, and developer logs.
  - [devlog/](file:///Users/gaylonvorwaller/madonnahist/docs/devlog/) — Developer daily updates.
- [scripts/](file:///Users/gaylonvorwaller/madonnahist/scripts/) — Command-line utilities for backup, perspective warp verification, local OCR testing, and vendor evaluations.
- [src/](file:///Users/gaylonvorwaller/madonnahist/src/) — SvelteKit application codebase.
  - [lib/](file:///Users/gaylonvorwaller/madonnahist/src/lib/) — Shared libraries and services:
    - [image/](file:///Users/gaylonvorwaller/madonnahist/src/lib/image/) — Cropping, image enhancement, and perspective warp algorithms.
    - [ingest/](file:///Users/gaylonvorwaller/madonnahist/src/lib/ingest/) — Ingestion mapping logic for uploaded calendar files.
    - [ocr/](file:///Users/gaylonvorwaller/madonnahist/src/lib/ocr/) — Vision/LLM adapters, prompts, and substitution lookup tables.
      - [vendors/](file:///Users/gaylonvorwaller/madonnahist/src/lib/ocr/vendors/) — Specific vendor adapters (Google Vision, Claude Vision, local Ollama, Transkribus).
  - [routes/](file:///Users/gaylonvorwaller/madonnahist/src/routes/) — Web endpoints and layouts:
    - `/correct` — iPad-first correction queue and editor views.
    - `/admin` — Captures intake, vocabularies/lexicon, substitutions, and OCR reviews.
    - `/api/health` — Deploy gate endpoint.

---

## Styling & UI Conventions

- **No Tailwind CSS or Utility Frameworks** — Use standard vanilla, component-scoped CSS within Svelte templates.
- **No Toast Notifications** — Destructive or feedback alerts must use modal confirmation dialogs. See [cs.md:L80](file:///Users/gaylonvorwaller/madonnahist/cs.md#L80) for the modal pattern.
- **Contrast Ratios** — Maintain WCAG AAA contrast ratio (7:1) for all text, including muted or secondary text.
- **Status Badges** — Always use both color AND text labels (never color alone) to signify statuses.
- **iPad Touch Targets** — Minimum height of 58px for clickable areas in the correction queue and editor views.

---

## Commands & Shortcuts

### Main Commands
```bash
# Start development server on port 5176
npm run dev

# Run Svelte Kit sync and TypeScript checking (0 warnings baseline)
npm run check

# Build the production bundle
npm run build

# Run schema migrations (idempotent, connects as owner role)
./backend/db/migrate_pg.sh

# Local isolated test DB (never use 5433, 5435, or PGDATABASE=madonnahist)
npm run test:env
npm run test:db:start
npm run test:db:reset
npm run test:db:migrate
npm run test:db:invariants

# Deploy to droplet (git push, pull, build, run migrations, restart PM2, health check)
./scripts/deploy-to-DO.sh
```

### Test Command Shortcuts
All evaluation and test scripts are executed using `npx tsx` from the repository root:

- **Perspective Warp Verification**:
  ```bash
  npx tsx scripts/test-warp.ts
  ```
  Tests perspective-warp mathematical transforms on target calendar page images.

- **OCR Vendor Comparison**:
  ```bash
  npx tsx --env-file=.env scripts/test-claude-ocr.ts
  ```
  Runs a side-by-side transcription test of Google Vision vs Claude Vision on cell crops and full-page targets.

- **Contrast Enhancement & Preprocessing Test**:
  ```bash
  npx tsx --env-file=.env scripts/test-preprocessed-ocr.ts
  ```
  Evaluates contrast adjustment, sharpening, and binarization on cell crops before passing them to the OCR vendors.

- **OCR Evaluation CLI**:
  ```bash
  npx tsx scripts/ocr-eval.ts --input test-data/samples/ --models qwen3-vl:32b,claude --gold test-data/gold.json
  ```
  Batch evaluates crop transcription accuracy against ground-truth files and produces comparison reports.

- **Gridline Edge Coverage Test**:
  ```bash
  npx tsx scripts/detect-grid.ts <image-path> [rows]
  ```
  Runs the edge activity checking script to locate row and column boundary lines on calendar pages.

- **Admin/User Password Utility**:
  ```bash
  npx tsx scripts/set-passwords.ts
  ```
  Helper script for hashing and writing user credentials.

---

## Environment & Infrastructure

- **Local Host App Port**: `5176` (dev/preview)
- **Production Host App Port**: `3002` (reverse proxied via Nginx + Cloudflare at https://madonnahist.gaylon.photos)
- **PostgreSQL Port**: `5434` (local & production), DB: `madonnahist`
- **Spaces Credentials**: DO Spaces credentials live in the `private_data.api_credentials` table (never `.env`). Load using the `credentialService` helper.

## Local Test Environment Safety

Follow [docs/local-test-environment.md](file:///Users/gaylonvorwaller/madonnahist/docs/local-test-environment.md) for local tests.

- Never use port `5433` for madonnahist tests; it belongs to BTC-dashboard.
- Never use port `5435` for madonnahist tests; it is the production DB tunnel.
- Never run local tests against `PGDATABASE=madonnahist`.
- Use the dedicated local test database `madonnahist_test` on port `15434`.
- Use `MADONNAHIST_ENV=test` and `MADONNAHIST_OBJECT_STORE=local`.
- Do not seed production DigitalOcean Spaces credentials into the test DB.
- Do not restore production dumps into shared local Postgres clusters.

The migrations grant privileges to canonical role names
`madonnahist_owner`, `madonnahist_app`, and `madonnahist_worker`; local tests
reuse those role names only inside the isolated repo-local Postgres cluster.
Destructive image flows must use the local filesystem object store under
`.local/object-store-test/`, never production DigitalOcean Spaces.
