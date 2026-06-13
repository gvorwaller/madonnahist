# Calendar History System — V5

> Supersedes V4 as the authoritative system plan. V4 remains for historical reference. If other docs conflict with V5, V5 wins.
>
> **Companion docs** (still current):
> - `docs/ui-mockups-V2.md` — UI mockups for correction UI (iPad) and family viewer (phone)
> - `docs/equipment-shortlist.md` — capture-side workflow (G9 II + 60mm + LR Classic)
> - `docs/capture-intake-reference.html` — visual pipeline walkthrough (open in browser)
> - `docs/V4-addendum-A-ocr-pipeline.md` — OCR pipeline detail (three-stage pipeline, correction lexicon, five-field editor spec)

---

## What Remains — Quick Reference (2026-06-13)

**Current priority**: Get more months through the pipeline — ingest, align, OCR, substitute, correct, repeat. Development resumes when the pipeline hits friction or when enough text is corrected to make the viewer worth building.

### Phase 1 Gaps (correction workflow polish — not blocking Madonna)

- Auto-save (1s debounce on inactivity; preserve half-typed drafts on crash/close)
- Correction session lifecycle (`correction_sessions` with active/paused/completed/abandoned states, session summary screen)
- "Accept LLM" one-click button (accept Claude draft as-is without editing)
- History button (side-by-side comparison of prior OCR/draft runs for a day)

### Phase 2 — UX & Search (family viewer; needs meaningful corrected text volume)

- Day detail viewer (`/app/day/[date]`) — read-only view with image, corrected text, tags, entities, AI summary; swipe navigation
- "On this day" landing (`/app`) — entries from today's date across all 60 years
- Full-text search (`/app/search`) — FTS index exists in DB; needs UI with highlighting and filters
- Year browse (`/app/year/[year]`) — month-grouped timeline of daily entries
- Calendar navigation — month-grid navigator for the viewer
- Tag UI in correction editor — add/remove `day_tags` during correction (table exists, no UI)
- Mobile viewer polish — phone-first CSS, touch, SSR optimization

### Phase 3 — AI Enrichment (needs accepted corrections to extract from)

- Entity extractor worker — extract people/places/events from corrected text, write to `entities`/`day_entities`, propose AI-sourced tags
- Person pages (`/app/person/[slug]`) — all days mentioning a person, alias-resolved
- Place pages (`/app/place/[slug]`) — same for places
- AI tag suggestions in correction UI
- Alias resolution admin UI — manage entity aliases ("Marc" → "Marcus")

### Phase 4 — Narrative & Polish (the "read 1968 as a book" goal)

- Summary generator worker — year/decade/person summaries into `narrative_summaries`
- Book view (`/app/book/[scope]/[key]`) — immersive reading, 3-5 days per page, serif text, image thumbnails in margins
- Decade summaries (`/app/decade/[decade]`)
- Transkribus handwriting training — may not be needed if Google Vision + Claude keeps working well
- Semantic search (pgvector) — conceptual queries; full-text + tags + entities should cover 90% first
- Backup automation — nightly `pg_dump` to Spaces, 30-day retention

### Parked

- Squiggly line detection (td-73260e) — curved grid line detection; manual entry mode is the current workaround

---

## 1. Purpose

A private, family-access web app that digitizes ~60 years of handwritten family calendar entries into a structured, searchable, and explorable archive of daily life. The end goal: a grandchild can sit down and read 1968 as a book.

## 2. Design Principles (unchanged from V4)

- **Human truth wins.** `corrected_text` is the authoritative transcript, never overwritten by automation. Enforced at the DB role layer.
- **History is replayable.** OCR, LLM, and human outputs are append-only.
- **Entities and tags are separate.** People/places/events are canonical entities with alias resolution; freeform tags are editorially flexible.
- **Read paths are fast; write paths can be careful.** Trigger-maintained denormalizations on `calendar_days`.

## 3. What's Built (Phase 1 — Complete)

Everything below is deployed and working in production at `madonnahist.gaylon.photos`.

### Infrastructure
- PostgreSQL (port 5434, role `madonnahist_app`), DO Spaces for images, SvelteKit + adapter-node on DO droplet (port 3002), nginx + Cloudflare
- PM2 for web app process management
- Cookie sessions + argon2id auth (gaylon = admin, madonna = corrector)
- Migrations through 0016, deploy script (`scripts/deploy-to-DO.sh`)

### Capture & Ingest (`/admin/capture`)
- Lumix Tether → rsync to droplet → auto-discovery on page load
- Classify All (Google Vision for month/year detection + quality assessment)
- Manual year/month/layout override per card
- Ingest Selected → uploads to Spaces, creates `calendar_pages` + `calendar_days`
- Duplicate detection with replace-existing (guarded against accepted corrections)
- **Un-ingest** button on completed items — reverts page to classified state with modal confirmation

### Grid Alignment (`/admin/grid-align`)
- Four-corner perspective warp (Apply Warp → de-skewed rectangular image)
- Draggable grid lines for cell boundary refinement
- Live crop preview strip
- Copy grid from previous page
- "Re-run OCR after save" checkbox — OCR auto-triggers on save (spawns worker as background process)
- **Clear OCR Results** button — wipes all OCR/draft data for re-run
- Reset Warp (Re-place Corners) — returns to corner placement

### OCR Pipeline (auto-triggered, no SSH)
- **Stage 1**: Google Vision full-page `DOCUMENT_TEXT_DETECTION` → word-to-cell mapping via grid lines → `ocr_runs` rows
- **Stage 2**: Claude Sonnet per-cell cleanup with dynamic prompt (vocabulary + lexicon + notation context) → `llm_draft_runs` rows
- Worker spawned as detached background process from grid-align save
- Concurrency guard prevents duplicate workers; spawn failures surface to UI
- **Live progress** on OCR review page: sticky strip with stage 1 checklist + stage 2 progress bar, auto-refresh on completion
- Both API keys stored in `private_data.api_credentials` (not .env)

### OCR Review (`/admin/ocr-review`)
- Calendar grid view of cell images + Claude draft text
- Confidence percentages, lightbox zoom, filter by low confidence / blank
- Live progress strip during OCR processing

### Vocabulary & Notation (`/admin/vocabulary`)
- OCR Vocabulary (names, places, activities fed to Claude prompt)
- Notation Key (shorthand expansions like "(R)" → "Rebekah")
- Correction Lexicon (auto-learned OCR error patterns from human corrections)
- Audit logging on all mutations

### Substitution Engine (`/admin/substitutions`)
- Deterministic find-and-replace from notation_key + high-frequency lexicon entries
- Word-boundary-aware regex (prevents substring over-matching)
- Preserves history (new `llm_draft_runs` row, never overwrites)
- Skips accepted corrections

### Correction UI (`/correct`)
- **Queue home**: month list with progress bars, "Resume Correcting" to first pending day
- **Month view** (`/correct/month/[monthKey]`): day list with status badges, text previews, narrative indicators
- **Day editor** (`/correct/day/[date]`): 
  - OCR'd days: cell image (click to zoom) + machine draft (read-only) + corrected text textarea
  - Manual entry days: padded cell crop (20% context) + full page image with cell highlight (clickable lightbox) + corrected text textarea
  - Day narrative textarea (warm-toned, for memories/stories)
  - Breadcrumbs (Queue / Month), dual navigation (Prev/Next all days + Prev/Next uncorrected)
  - Save & Next (pending days) / Save (re-editing corrected days)
  - Skip, Flag Illegible (with modal + note)
- Accepted corrections auto-populate `correction_lexicon` (skipped for manual-entry days)

### Data Model (key tables, all in production)
- `calendar_pages` — one per monthly page, with warped image + grid lines
- `calendar_days` — canonical per-day record with denormalized read-cache
- `ocr_runs` / `llm_draft_runs` — append-only machine output history
- `day_corrections` — append-only human correction history; trigger writes `corrected_text`
- `crop_templates` — grid layout provenance
- `ocr_vocabulary` / `correction_lexicon` / `notation_key` — OCR context tables
- `entities` / `day_entities` — canonical person/place/event (tables exist, not yet populated)
- `day_tags` — freeform tags (table exists, not yet populated)
- `narrative_summaries` — year/decade/person summaries (table exists, not yet populated)
- `job_runs` — PostgreSQL-backed job queue (`SELECT FOR UPDATE SKIP LOCKED`)
- `audit_log` — every human mutation

---

## 4. What's Not Built Yet

Organized by priority and dependency. Items within each phase are roughly ordered by value.

### Phase 1 gaps (minor — correction workflow polish)

These were in the V4 Phase 1 spec but aren't blocking Madonna's correction work:

| Item | Notes |
|---|---|
| Auto-save (1s debounce, in_progress drafts) | V4 spec calls for auto-save on inactivity. Currently Madonna must click Save explicitly. Half-typed drafts aren't preserved on crash/close. |
| Correction session lifecycle | V4 spec defines `correction_sessions` with active/paused/completed/abandoned states and session summary screen. Currently no session tracking. |
| "Accept LLM" one-click button | Copy latest `llm_draft_runs.draft_text` as accepted correction without editing. Useful when Claude got it right. |
| History button (older OCR/draft runs) | Side-by-side comparison of prior machine attempts. Low priority until re-runs become common. |

### Phase 2 — UX & Search

The family viewer and search features. Depends on having a meaningful volume of corrected text.

| Item | Description |
|---|---|
| **Day detail viewer** (`/app/day/[date]`) | Read-only view: calendar image, corrected text, tags, entities, AI summary. Swipe left/right for adjacent days. |
| **"On this day"** (`/app`) | Landing page: entries from today's date across all years. "On May 3 in our family history." |
| **Full-text search** (`/app/search`) | FTS index already exists in DB (`calendar_days.fts` GIN index). Needs UI: search bar, results with date + text preview + highlighting. Combine with tag and entity filters. |
| **Year browse** (`/app/year/[year]`) | Timeline of a year, month-grouped day listings. Entry point to book view. |
| **Calendar navigation** | Month-grid navigator for the viewer (distinct from the admin OCR review grid). |
| **Tag UI in correction editor** | Add/remove `day_tags` while correcting. Currently tags table exists but no UI to populate. |
| **Mobile viewer polish** | Phone-first CSS, touch interactions, SSR optimization for first paint. |

### Phase 3 — AI Enrichment

Depends on having accepted corrections to extract from.

| Item | Description |
|---|---|
| **Entity extractor worker** | After accepted correction: extract people/places/events from `corrected_text`, normalize to canonical `entities` (resolving aliases via `alias_of_entity_id`), write to `day_entities`, propose AI-sourced `day_tags`. Triggered by `day_corrections` insert with `status_after = 'accepted'`. |
| **Person pages** (`/app/person/[slug]`) | All days mentioning a canonical person entity, paginated, alias-resolved. |
| **Place pages** (`/app/place/[slug]`) | Same for places. |
| **AI tag suggestions in correction UI** | While Madonna corrects, suggest tags based on content. |
| **Alias resolution admin UI** | Manage entity aliases ("Marc" → canonical "Marcus"). |

### Phase 4 — Narrative & Polish

The "read 1968 as a book" goal.

| Item | Description |
|---|---|
| **Summary generator worker** | Generates year, decade, and person summaries into `narrative_summaries` with `is_published = false`. Admin reviews and publishes. Triggered manually or by milestone (e.g., 95% of a year accepted). |
| **Book view** (`/app/book/[scope]/[key]`) | Immersive reading: 3-5 days per page, image thumbnails in margins, serif text, swipe to advance, chapter breaks at month boundaries. |
| **Decade summaries** (`/app/decade/[decade]`) | AI-generated narrative overview of a decade. |
| **Transkribus handwriting training** | Family-handwriting-specific HTR model. May not be needed if Google Vision + Claude cleanup continues to work well. |
| **Semantic search** (pgvector) | Embedding-based search for conceptual queries ("when did we go to the beach"). Full-text + tags + entities should cover 90% before this. |
| **Backup automation** | Nightly `pg_dump` to Spaces, 30-day retention, weekly long-term archives. Restore drill annually. |

### Parked (P3 in td)

| Item | td | Notes |
|---|---|---|
| Squiggly line detection | td-73260e | Curved/hand-drawn grid line detection algorithm. Manual entry mode handles the immediate need; this would eliminate the workaround. |

---

## 5. End-User Experience Vision

The family viewer (`/app/*`) is the payoff for all the correction work. Here's what it looks like when built:

### Daily use — "On this day"
Family members open the app on their phone. The landing page shows "On [today's date] in our family history" — entries from this date across all 60 years. Tap an entry to see the day detail: the original handwritten image, the corrected transcript, tags, people mentioned, and an AI-generated context note.

### Browsing — years and decades
Navigate by year (`/app/year/1968`) to see a month-grouped timeline of daily entries. Each entry shows a text preview; tap for full detail. Decade view (`/app/decade/1960s`) shows an AI-generated narrative summary of the era.

### Search — find anything
Full-text search across all corrected text, tags, and entity names. "When did Marcus break his arm?" "Thanksgiving 1992." "Seminary." Results show matching days with highlighted snippets.

### Reading — book view
The signature feature. Select a year or a person and read it as a continuous narrative. 3-5 days per page, image thumbnails in the margin, chapter breaks at months. Designed for a tablet or phone in portrait mode. "A grandchild can sit down and read 1968 as a book."

### People — person profiles
Tap a person's name anywhere → person page showing every day they're mentioned, across all years. Built from the entity extractor's canonical entities with alias resolution ("Marc", "Marcus", and "Marky" all resolve to the same profile).

---

## 6. Current Priority

**Get more months through the pipeline.** The family viewer features (Phases 2-4) depend on having a meaningful volume of corrected text. Madonna is actively correcting; Gaylon is actively ingesting and aligning. The immediate work is operational:

1. Ingest remaining months from the capture queue
2. Grid-align each page (warp + refine lines)
3. OCR auto-runs on grid save
4. Run substitutions after OCR completes
5. Madonna corrects on iPad
6. Repeat

Development work resumes when the pipeline encounters friction or when enough months are corrected to make the viewer worth building.

---

## 7. Technical Reference

### Routes
| Route | Role | Purpose |
|---|---|---|
| `/admin/capture` | admin | Capture intake: classify, ingest, un-ingest |
| `/admin/grid-align` | admin | Perspective warp + grid line alignment |
| `/admin/grid-align/[pageId]` | admin | Per-page alignment editor |
| `/admin/ocr-review` | admin | OCR results overview |
| `/admin/ocr-review/[pageId]` | admin | Per-page OCR review with live progress |
| `/admin/vocabulary` | admin | OCR vocabulary, notation key, correction lexicon |
| `/admin/substitutions` | admin | Deterministic substitution pass on drafts |
| `/correct` | corrector, admin | Correction queue home |
| `/correct/month/[monthKey]` | corrector, admin | Month day-list view |
| `/correct/day/[date]` | corrector, admin | Day editor (OCR'd or manual entry) |
| `/app` | viewer, corrector, admin | Family viewer (placeholder) |

### DB Roles
| Role | Used by | Key permissions |
|---|---|---|
| `madonnahist_owner` | Migrations only | Full DDL |
| `madonnahist_app` | Web app (SvelteKit) | CRUD on most tables; **cannot** UPDATE `corrected_text` directly (trigger path only) |
| `madonnahist_worker` | OCR/LLM workers | INSERT on history tables; **cannot** touch `corrected_text` or DELETE history |

### Environment
| Variable | Location | Notes |
|---|---|---|
| `PGHOST` / `PGPORT=5434` / `PGUSER` / `PGPASSWORD` | `.env` | App DB connection |
| `WORKER_PGUSER` / `WORKER_PGPASSWORD` | `.env` | Worker DB connection |
| `MIGRATION_PGUSER` / `MIGRATION_PGPASSWORD` | `.env` | Migration script only |
| `AUTH_SECRET` | `.env` | Cookie signing |
| `PORT=3002` | `.env` | App listen port |
| Google Vision key | `private_data.api_credentials` | Service: `google_vision` |
| Anthropic API key | `private_data.api_credentials` | Service: `anthropic` |
| DO Spaces credentials | `private_data.api_credentials` | Service: `do_spaces` |

### Commands
```bash
npm run dev          # Dev server (port 5176)
npm run build        # Production build
npm run check        # Type check (0 warnings baseline)
./backend/db/migrate_pg.sh    # Apply DB migrations
./scripts/deploy-to-DO.sh     # Deploy to production
```
