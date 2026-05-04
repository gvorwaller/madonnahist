# Calendar History System — V4

> Authoritative system plan. Supersedes all prior versions (V1 ChatGPT preliminary draft; V2 SvelteKit pivot; V3 schema refactor by Codex). If other docs conflict, this wins.

> **Capture-side**: see `docs/equipment-shortlist.md` for the photographic workflow (G9 II + 60mm + LR Classic export → DO Spaces). `docs/Calendar_Digitization_Plan.md` is historical background.

> **UI**: see `docs/ui-mockups-V2.md` for the iPad correction surface and the family viewer mockups (information architecture, accessibility floor, palette/typography baseline).

## 1. Purpose & Scope

A private, family-access web app that digitizes ~60 years of handwritten family calendar entries into a structured, searchable, and explorable archive of daily life.

This version locks in: machine output is disposable, human-reviewed text is authoritative, and every meaningful machine and human revision is reconstructible later. The schema and DB roles enforce these invariants; application code does not get to weaken them.

**In scope:**
- Capture pipeline: cut single-sheet calendar pages → DAM cataloging → DO Spaces
- OCR/HTR pipeline: image → vendor OCR → LLM cleanup draft → human correction → structured day records
- Madonna's correction UI (iPad-first)
- Family viewer (phone-first): "on this day," day detail, year/decade browse, search, book view
- AI enrichment: per-day entity extraction + per-year/decade narrative summaries

**Out of scope (Phase 4+ if ever):**
- Photo or letter ingestion beyond the calendars
- Public sharing or external authentication
- Multi-tenant support

## 2. Design Principles

- **Human truth wins.** `corrected_text` is the authoritative transcript and is never overwritten by automation. The schema and DB roles enforce this at write-time, not at policy-time.
- **History is replayable.** OCR reruns, LLM reruns, and human revisions are append-only. The current state on `calendar_days` is a denormalized read-cache of the latest authoritative event.
- **Workflow state is explicit.** "Resume where you left off" rests on real `correction_sessions` data with a defined lifecycle, not on guessing.
- **Entities and tags are different things.** People/places/events power profile pages; freeform tags remain editorially flexible. Both contribute to search.
- **Read paths are fast; write paths can be careful.** Denormalize aggressively for the viewer surface; carry trigger-maintained columns to avoid multi-table joins on every page load.
- **Phase 1 should not paint Phase 2 into a corner.** Crop geometry, review notes, and queue state get first-class homes now.

## 3. Roles & Access (Application Roles)

| Role | Surfaces | Capabilities |
|---|---|---|
| **Admin** (Gaylon) | Both | Full read/write; manages users; runs reprocessing jobs; reviews audit log |
| **Corrector** (Madonna) | Correction UI + Viewer | Read/write `corrected_text`, review notes, statuses, tags; cannot delete or replace source images |
| **Viewer** (other family) | Viewer only | Read-only access |

Sessions are cookie-based, `httpOnly`, `secure`, `SameSite=Strict`. No public registration; users are added by admin. Authentication uses argon2id password hashing.

(Database-level roles — separate from application roles — are defined in §8.)

## 4. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  CAPTURE                                                         │
│  G9 II + 60mm → Lumix Tether → LR Classic export                │
└──────────────────────────────────────────────┬──────────────────┘
                                               ▼
┌─────────────────────────────────────────────────────────────────┐
│  INGEST                                                          │
│  upload-page script → DO Spaces → page/day rows                 │
│  + stores crop geometry → enqueues OCR jobs                     │
└──────────────────────────────────────────────┬──────────────────┘
                                               ▼
┌─────────────────────────────────────────────────────────────────┐
│  AI HARNESS (workers, queue-driven via job_runs)                 │
│  OCR Worker → LLM Cleanup → Entity Extractor → Summary Generator │
│  Workers connect as madonnahist_worker DB role — cannot touch    │
│  corrected_text, corrected_by, corrected_at, correction_status   │
└──────────────────────────────────────────────┬──────────────────┘
                                               ▼
┌─────────────────────────────────────────────────────────────────┐
│  POSTGRES (source of truth)                                      │
│  calendar_pages, calendar_days, ocr_runs, llm_draft_runs,       │
│  day_corrections, correction_sessions, crop_templates,          │
│  day_tags, entities, day_entities, narrative_summaries,         │
│  audit_log, job_runs, app_state                                 │
│  + triggers maintain denormalized read-cache columns             │
└──────────────────────────────────────────────┬──────────────────┘
                                               ▼
┌─────────────────────────────────────────────────────────────────┐
│  SVELTEKIT APP (madonnahist_app DB role)                         │
│  /admin/*   /correct/*   /app/*                                  │
│  +server.ts endpoints + form actions handle all mutations        │
└──────────────────────────────────────────────┬──────────────────┘
                                               ▼
                                       nginx → Cloudflare
                                  madonnahist.gaylon.photos
```

## 5. Tech Stack

| Layer | Choice | Rationale |
|---|---|---|
| Frontend + server | **SvelteKit** (TypeScript, adapter-node, Svelte 5 with runes) | Small runtime, full-stack, operational match with sibling apps |
| Database | **PostgreSQL** | Source of truth; strong indexing; JSONB where useful (crop bounds, entity metadata), relational where queries demand it (tags, entities) |
| Auth | Cookie sessions + argon2id | Existing pattern (matches giftlist) |
| Image storage | **DigitalOcean Spaces** | Settled |
| Image processing | Sharp (Node) | Thumbnails, day-cell crops |
| OCR vendors | Transkribus primary; Google Vision/Azure fallback | Pluggable via vendor adapter interface |
| LLM | Anthropic Claude (or OpenAI) | Cleanup, entity extraction, summaries — pluggable |
| Reverse proxy | nginx | Settled |
| Edge | Cloudflare | TLS, cache, DDoS |
| Process manager | PM2 | Settled — separate entries for web app and each worker |
| Task queue | PostgreSQL `SELECT FOR UPDATE SKIP LOCKED` on `job_runs` | Sufficient at this scale; no Redis needed |

## 6. Data Model

The model has four character-defining choices:

- **`calendar_days` is the canonical read surface.** It carries the authoritative current state plus denormalized read-cache columns; triggers keep them consistent with the append-only history tables.
- **OCR and LLM outputs are append-only.** Every vendor attempt and every prompt revision becomes a new row in `ocr_runs` / `llm_draft_runs`. `calendar_days.latest_ocr_run_id` and `latest_llm_draft_run_id` point at the current displayed entries; older runs remain available for audit, comparison, and reprocessing.
- **Human corrections are append-only.** Every save to a day's text writes a new `day_corrections` row. `calendar_days.corrected_text` is a denormalized cache of the most recent accepted correction, maintained by trigger.
- **Entities and tags are separate.** `entities` + `day_entities` provide canonical, deduplicated person/place/event references with alias resolution. `day_tags` provides editorially flexible tagging (freeform, can be human or AI sourced).

```sql
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'corrector', 'viewer')),
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE calendar_pages (
  id SERIAL PRIMARY KEY,
  year INT NOT NULL,
  month INT NOT NULL CHECK (month BETWEEN 1 AND 12),
  page_image_path TEXT NOT NULL,           -- DO Spaces object key
  capture_session TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (year, month)
);

CREATE TABLE crop_templates (
  id SERIAL PRIMARY KEY,
  template_key TEXT UNIQUE NOT NULL,        -- e.g., "1968-q1-monthly"
  year_start INT,
  year_end INT,
  month INT CHECK (month BETWEEN 1 AND 12),
  grid_definition JSONB NOT NULL,           -- corner coords + per-day cell offsets
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE calendar_days (
  id SERIAL PRIMARY KEY,
  page_id INT NOT NULL REFERENCES calendar_pages(id),
  entry_date DATE UNIQUE NOT NULL,

  -- Source image
  day_image_path TEXT,                      -- DO Spaces object key
  crop_template_id INT REFERENCES crop_templates(id),
  crop_bounds JSONB,                        -- actual crop rectangle used

  -- Canonical human-validated transcript (denormalized read-cache of latest day_corrections row)
  corrected_text TEXT,
  corrected_by INT REFERENCES users(id),
  corrected_at TIMESTAMPTZ,
  correction_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (correction_status IN ('pending', 'in_progress', 'accepted', 'flagged', 'illegible')),
  review_note TEXT,                         -- structured note from corrector (e.g., "ambiguous - looks like Bill or Bob")

  -- Denormalized read-cache pointers to latest machine outputs (maintained by triggers)
  latest_ocr_run_id BIGINT,                 -- FK to ocr_runs(id), nullable; nullable to avoid forward-reference
  latest_llm_draft_run_id BIGINT,           -- FK to llm_draft_runs(id), nullable
  latest_confidence_score FLOAT,            -- copied from latest_ocr_run for fast queue queries

  -- Session tracking (helps "resume where you left off")
  last_opened_by INT REFERENCES users(id),
  last_opened_at TIMESTAMPTZ,
  editing_started_at TIMESTAMPTZ,
  current_session_id BIGINT,                -- FK to correction_sessions(id), nullable

  -- AI-generated per-day narrative (Phase 4)
  ai_summary TEXT,

  -- Denormalized text from related tables for full-text search
  -- Maintained by triggers on day_tags and day_entities
  -- Holds: tag_labels concatenated + entity display_names concatenated
  search_aux_text TEXT NOT NULL DEFAULT '',

  -- Single composite full-text search column
  fts tsvector GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(corrected_text, '') || ' ' ||
      coalesce(ai_summary, '') || ' ' ||
      coalesce(search_aux_text, '')
    )
  ) STORED,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_calendar_days_fts ON calendar_days USING gin(fts);
CREATE INDEX idx_calendar_days_status ON calendar_days(correction_status);
CREATE INDEX idx_calendar_days_pending ON calendar_days(entry_date)
  WHERE correction_status IN ('pending', 'flagged');
CREATE INDEX idx_calendar_days_last_opened ON calendar_days(last_opened_by, last_opened_at DESC);
CREATE INDEX idx_calendar_days_low_confidence
  ON calendar_days(latest_confidence_score)
  WHERE correction_status = 'pending';

-- ─────────────────────────────────────────────────────────────────
-- Append-only machine output history
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE ocr_runs (
  id BIGSERIAL PRIMARY KEY,
  day_id INT NOT NULL REFERENCES calendar_days(id) ON DELETE CASCADE,
  vendor TEXT NOT NULL,                     -- 'transkribus' | 'google-vision' | 'azure'
  source_image_path TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  confidence_score FLOAT,
  vendor_meta JSONB DEFAULT '{}',
  created_by_job_run_id BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_ocr_runs_day_created ON ocr_runs(day_id, created_at DESC);

CREATE TABLE llm_draft_runs (
  id BIGSERIAL PRIMARY KEY,
  day_id INT NOT NULL REFERENCES calendar_days(id) ON DELETE CASCADE,
  based_on_ocr_run_id BIGINT REFERENCES ocr_runs(id),
  model_name TEXT NOT NULL,                 -- e.g., 'claude-opus-4-7'
  prompt_version TEXT NOT NULL,             -- e.g., 'cleanup-v3'
  draft_text TEXT NOT NULL,
  confidence_note TEXT,
  created_by_job_run_id BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_llm_draft_runs_day_created ON llm_draft_runs(day_id, created_at DESC);

-- Now backfill the FK constraints on calendar_days now that target tables exist:
ALTER TABLE calendar_days
  ADD CONSTRAINT fk_calendar_days_latest_ocr
    FOREIGN KEY (latest_ocr_run_id) REFERENCES ocr_runs(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_calendar_days_latest_llm
    FOREIGN KEY (latest_llm_draft_run_id) REFERENCES llm_draft_runs(id) ON DELETE SET NULL;

-- ─────────────────────────────────────────────────────────────────
-- Append-only human correction history
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE day_corrections (
  id BIGSERIAL PRIMARY KEY,
  day_id INT NOT NULL REFERENCES calendar_days(id) ON DELETE CASCADE,
  corrected_text TEXT NOT NULL,
  review_note TEXT,
  status_after TEXT NOT NULL,               -- the correction_status value applied with this save
  editor_user_id INT NOT NULL REFERENCES users(id),
  source_llm_draft_run_id BIGINT REFERENCES llm_draft_runs(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_day_corrections_day_created ON day_corrections(day_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────
-- Correction-session state (powers "resume where you left off")
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE correction_sessions (
  id BIGSERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  started_at TIMESTAMPTZ DEFAULT NOW(),
  last_activity_at TIMESTAMPTZ DEFAULT NOW(),
  current_day_id INT REFERENCES calendar_days(id),
  queue_scope JSONB NOT NULL DEFAULT '{}',  -- e.g., {year: 1968, status: 'pending'}
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'completed', 'abandoned'))
);

ALTER TABLE calendar_days
  ADD CONSTRAINT fk_calendar_days_current_session
    FOREIGN KEY (current_session_id) REFERENCES correction_sessions(id) ON DELETE SET NULL;

-- ─────────────────────────────────────────────────────────────────
-- Lightweight tags
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE day_tags (
  day_id INT NOT NULL REFERENCES calendar_days(id) ON DELETE CASCADE,
  tag_slug TEXT NOT NULL,
  tag_label TEXT NOT NULL,                  -- display form, used in fts
  source TEXT NOT NULL DEFAULT 'human' CHECK (source IN ('human', 'ai')),
  PRIMARY KEY (day_id, tag_slug)
);
CREATE INDEX idx_day_tags_slug ON day_tags(tag_slug);

-- ─────────────────────────────────────────────────────────────────
-- Structured entities (people, places, events) with alias resolution
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE entities (
  id BIGSERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,                -- used in fts via day_entities → search_aux_text
  entity_type TEXT NOT NULL CHECK (entity_type IN ('person', 'place', 'event')),
  alias_of_entity_id BIGINT REFERENCES entities(id),  -- "Marc" → canonical "marcus"
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE day_entities (
  day_id INT NOT NULL REFERENCES calendar_days(id) ON DELETE CASCADE,
  entity_id BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'ai' CHECK (source IN ('human', 'ai')),
  confidence_score FLOAT,
  PRIMARY KEY (day_id, entity_id)
);
CREATE INDEX idx_day_entities_entity ON day_entities(entity_id, day_id);

-- ─────────────────────────────────────────────────────────────────
-- Narrative summaries
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE narrative_summaries (
  id SERIAL PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('year', 'decade', 'person')),
  scope_key TEXT NOT NULL,                   -- '1968' | '1960s' | 'marcus'
  summary_text TEXT NOT NULL,
  generated_by TEXT NOT NULL,                -- model name or user_id
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  is_published BOOLEAN DEFAULT FALSE,
  UNIQUE (scope, scope_key)
);

-- ─────────────────────────────────────────────────────────────────
-- Audit log (per cs.md SACRED rules) — every human mutation
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INT NOT NULL,
  before_value JSONB,
  after_value JSONB,
  description TEXT NOT NULL,
  occurred_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_audit_log_entity ON audit_log(entity_type, entity_id, occurred_at DESC);

-- ─────────────────────────────────────────────────────────────────
-- Worker job queue
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE job_runs (
  id BIGSERIAL PRIMARY KEY,
  job_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_progress', 'done', 'failed')),
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  enqueued_at TIMESTAMPTZ DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);
CREATE INDEX idx_job_runs_pending ON job_runs(job_type, enqueued_at) WHERE status = 'pending';

CREATE TABLE app_state (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 6.1 Trigger-Maintained Denormalizations

Three triggers keep `calendar_days` read-fast without violating the append-only invariant on the history tables:

**a) `trg_after_ocr_run_insert`** — on `ocr_runs` AFTER INSERT, updates `calendar_days.latest_ocr_run_id` and `latest_confidence_score` for the affected day.

**b) `trg_after_llm_draft_insert`** — on `llm_draft_runs` AFTER INSERT, updates `calendar_days.latest_llm_draft_run_id`.

**c) `trg_after_correction_insert`** — on `day_corrections` AFTER INSERT, updates `calendar_days.corrected_text`, `corrected_by`, `corrected_at`, `correction_status` (from `status_after`), `review_note`. **This is the only mechanism by which `corrected_text` gets written.** Application code inserts into `day_corrections`; the trigger propagates.

**d) `trg_refresh_search_aux_text`** — on `day_tags` and `day_entities` AFTER INSERT/UPDATE/DELETE, recomputes `calendar_days.search_aux_text` for the affected day from `string_agg(tag_label) || string_agg(entities.display_name)`. Keeps the FTS index covering tags and entity names with one stored column.

Trigger SQL is implementation detail — kept out of this doc but lives in `backend/db/migrations/`.

## 7. (reserved — was schema continuation)

## 8. Database Roles & Grants

The "human truth wins" invariant is enforced at the DB layer, not just by application policy. Two database roles:

| Role | Used by | Permissions |
|---|---|---|
| `madonnahist_app` | SvelteKit web app, admin scripts | Full SELECT/INSERT/UPDATE/DELETE on all tables |
| `madonnahist_worker` | OCR / LLM cleanup / entity extractor / summary generator workers | INSERT on `ocr_runs`, `llm_draft_runs`, `narrative_summaries`, `entities`, `day_entities`, `audit_log`; INSERT/UPDATE on `job_runs`; INSERT on `day_tags WHERE source='ai'`; **NO** UPDATE on any of `calendar_days.corrected_text`, `corrected_by`, `corrected_at`, `correction_status`, `review_note`, `current_session_id` |

Concrete grants (lives in `backend/db/migrations/0002_roles.sql`):

```sql
CREATE ROLE madonnahist_app LOGIN PASSWORD :'app_password';
CREATE ROLE madonnahist_worker LOGIN PASSWORD :'worker_password';

GRANT CONNECT ON DATABASE madonnahist TO madonnahist_app, madonnahist_worker;
GRANT USAGE ON SCHEMA public TO madonnahist_app, madonnahist_worker;

-- App role: full access
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO madonnahist_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO madonnahist_app;

-- Worker role: scoped access
GRANT SELECT ON ALL TABLES IN SCHEMA public TO madonnahist_worker;
GRANT INSERT ON ocr_runs, llm_draft_runs, narrative_summaries, entities,
                day_entities, day_tags, audit_log TO madonnahist_worker;
GRANT INSERT, UPDATE ON job_runs TO madonnahist_worker;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO madonnahist_worker;

-- Workers may NOT update calendar_days at all (the trigger-maintained columns are
-- updated by triggers running with the table owner's privileges, not the worker's).
-- Workers may not even update calendar_days.search_aux_text directly; they go through
-- day_tags / day_entities and let the trigger refresh it.
REVOKE UPDATE ON calendar_days FROM madonnahist_worker;
REVOKE DELETE ON ALL TABLES IN SCHEMA public FROM madonnahist_worker;
```

The triggers in §6.1 run as the table owner (typically `postgres` or a dedicated `madonnahist_owner` role), bypassing the worker's `UPDATE` revocation — that's the standard PostgreSQL `SECURITY DEFINER` pattern. Workers can INSERT into the history tables; the triggers do the cache update.

A worker that develops a bug and tries to UPDATE `calendar_days.corrected_text` directly will get a permission error, not silent corruption.

## 9. Module Specifications

### 9.1 Capture & Ingestion

**What it does:** Moves exported page images into DO Spaces, creates `calendar_pages` and `calendar_days`, stores the crop geometry actually used, and enqueues OCR jobs.

**Where it lives:** `scripts/upload-page.mjs` (Node script run after each LR Classic export; later cron-watched).

**Behavior:**
1. Validate filename matches `YYYY-MM_pageN.tif`
2. Upload original to `s3://madonnahist/originals/{year}/{month}/page.tif`
3. Apply the most recent matching `crop_templates` row (by year range + month) to slice the page into day cells; upload each to `s3://madonnahist/days/{year}/{month}/{day}.jpg`
4. Insert `calendar_pages` and 28–31 `calendar_days` rows with initial `crop_template_id` and `crop_bounds`
5. Enqueue one `ocr` job per day cell into `job_runs`

Phase 1 ships with one default crop template (5×7 grid for standard wall calendars). Phase 2 adds an admin UI to refine templates per year.

### 9.2 OCR / HTR Worker

**What it does:** Pulls `ocr` jobs, sends day-cell images to a vendor, appends an `ocr_runs` row. The trigger then refreshes `calendar_days.latest_ocr_run_id` and `latest_confidence_score`.

**Where it lives:** `workers/ocr-worker.mjs` — long-running PM2 process, idempotent.

**Vendor selection:** `src/lib/ocr/vendors/{transkribus,google,azure}.ts` implements `transcribe(imageUrl) -> { text, confidence, vendorMeta }`. Default vendor in `app_state.default_ocr_vendor`; per-job override via `payload.vendor`.

**Re-run safety:** OCR reruns create new `ocr_runs` rows. The trigger updates `latest_ocr_run_id` to the new row. Older runs are preserved for audit; `corrected_text` is untouchable.

**Failure modes:**
- Vendor 5xx → exponential backoff (1m, 5m, 25m), then mark `failed`
- Image not in Spaces → mark `failed`, write to `audit_log`
- Confidence below `app_state.flag_confidence_threshold` (default 0.4) → set `correction_status = 'flagged'` and write `review_note = 'auto-flagged: low OCR confidence'`

### 9.3 LLM Cleanup Worker

**What it does:** Takes the latest OCR run plus context (surrounding-day already-corrected entries from the same year, project-level prompt) and appends a cleaned draft to `llm_draft_runs`.

**Where it lives:** `workers/llm-cleanup-worker.mjs`.

**Why this structure:** The UI shows the newest draft by default (via `latest_llm_draft_run_id`), but older drafts remain in `llm_draft_runs` for audit, prompt-version A/B comparison, and reprocessing if the prompt improves.

**Cannot write `corrected_text`.** The DB role enforces this.

### 9.4 Entity Extractor

**What it does:** After human correction lands (status transitions to `accepted`), extracts people/places/events from `corrected_text`, normalizes to canonical entities (resolving aliases via `entities.alias_of_entity_id`), writes to `day_entities`, and proposes AI-sourced `day_tags`.

**Where it lives:** `workers/entity-extractor.mjs`.

**Triggered by:** A `day_corrections` insert with `status_after = 'accepted'` enqueues an `entity_extract` job.

### 9.5 Summary Generator

**What it does:** Generates year, decade, and person summaries into `narrative_summaries` with `is_published = false`.

**Where it lives:** `workers/summary-gen.mjs`.

**Triggered by:** Manual admin trigger from `/admin/summaries`, or milestone reached (e.g., 95% of a year accepted) — the milestone watcher is a small additional process, or a periodic cron.

**Publication model:** Admin reviews each summary and toggles `is_published`. Viewers only see published summaries.

### 9.6 Correction UI (Madonna's iPad)

**What it does:** Three-pane editor for human correction of OCR drafts. iPad-first, large touch targets, queue-based session workflow. See `docs/ui-mockups-V2.md` § A.

**Where it lives:** SvelteKit routes under `/correct/*`:
- `/correct` — session home (queue + resume)
- `/correct/day/[date]` — three-pane editor
- `/correct/calendar` — month-grid navigator
- `/correct/done` — session summary

**Key behaviors:**
- Opening a day attaches it to the user's active `correction_sessions` row, sets `current_day_id`, and updates `last_opened_*` on `calendar_days`
- Auto-save fires on debounce (1s of inactivity) — inserts a new `day_corrections` row with current text and `status_after = 'in_progress'`. The trigger updates `calendar_days.corrected_text` and status.
- "Save & Next" inserts with `status_after = 'accepted'` and advances the queue
- "Flag illegible" prompts for a `review_note` and inserts with `status_after = 'flagged'`
- The editor surfaces the latest OCR run and LLM draft via the `latest_*_run_id` pointers; a "history" button opens older runs side-by-side

**Correction session lifecycle:**
- `active` — the user has interacted in the last 60 minutes
- `paused` — the user navigated away, OR explicit "Stop for now" → updates status; queue scope preserved for resume
- `completed` — queue exhausted, or user clicked "Done" on the session-summary screen
- `abandoned` — automatic state set by a daily cleanup job: any `active` or `paused` session with `last_activity_at` more than 30 days ago becomes `abandoned`. Resume creates a new session rather than reviving an abandoned one.

### 9.7 Viewer UI (family phones)

**What it does:** Read-only browse of the archive. Phone-first, SSR. See `docs/ui-mockups-V2.md` § B.

**Where it lives:** SvelteKit routes under `/app/*`:
- `/app` — "On this day in family history"
- `/app/day/[date]` — single-day detail
- `/app/year/[year]` — year browse / timeline
- `/app/decade/[decade]` — decade summary view
- `/app/search` — full-text + tag + entity search
- `/app/book/[scope]/[key]` — immersive book-style reading
- `/app/person/[slug]` — all days for a canonical person entity
- `/app/place/[slug]` — all days for a place (Phase 3+)

**Performance:**
- Day-detail images served from Spaces with Cloudflare long-TTL caching
- Day-cell thumbnails pre-generated at upload time (400px width)
- Lazy-load below the fold; SvelteKit SSR for first paint

### 9.8 API Layer

SvelteKit `+server.ts` endpoints + form actions; no separate API service.

**Form actions (correction):**
- `POST /correct/day/[date]?/save`
- `POST /correct/day/[date]?/accept-llm` — copies the latest `llm_draft_runs.draft_text` into a new `day_corrections` row
- `POST /correct/day/[date]?/flag-illegible`
- `POST /correct/session/resume`
- `POST /correct/session/end`

**+server.ts endpoints (read-heavy):**
- `GET /api/days?from=&to=&status=` — for queue UI
- `GET /api/search?q=&from=&to=&tags=&person=` — full-text + entity + tag combined
- `GET /api/timeline/[year]` — month-grouped day listings
- `GET /api/person/[slug]` — all days for a canonical entity
- `GET /api/health` — DB, Spaces, worker liveness

### 9.9 Search & Indexing

**Full-text search** runs against `calendar_days.fts`, which is a generated `tsvector` over `corrected_text + ai_summary + search_aux_text`. The `search_aux_text` column is maintained by triggers on `day_tags` and `day_entities` (see §6.1.d) and contains tag labels and entity display names. **Result:** a single GIN index serves text, tag, and entity queries.

**Tag-only search** can additionally hit `day_tags` directly via the slug index for exact-match queries.

**Person/place/event navigation** uses `day_entities.entity_id` joined to `entities` for the alias-resolved canonical entity.

**Phase 4** may add semantic search via pgvector + embeddings; full-text + tags + entities should cover 90% of queries before then.

### 9.10 Backup & Disaster Recovery

- **Database:** Nightly `pg_dump --format=custom` to DO Spaces with 30-day retention; weekly archives kept for one year
- **Images:** Already durably stored in Spaces (replicated by DO)
- **Lightroom catalog:** Backed up by Time Machine on the Mac and by Adobe Cloud's catalog sync (separate from this app)
- **Restore drill:** Annually, restore the previous night's dump to a scratch DB and run a smoke-test query. Documented in `ops/restore-drill.md`.

### 9.11 Observability

- **PM2 logs** for web app and each worker, rotated weekly
- **`audit_log`** for every human mutation, queryable from `/admin/audit`
- **`job_runs`** as the source of truth for AI-harness pipeline state; `/admin/jobs` shows pending/in-flight/failed counts per worker
- **`/api/health`** returns `{ db, spaces, workers: { ocr, llm, entities, summary } }` with `idle | busy | stalled` per worker
- **Stalled detection:** a worker with no progress for 30 minutes despite pending jobs is `stalled`; admin alert via the same modal pattern as giftlist

## 10. Key User Workflows

### 10.1 Capture session (Gaylon)
1. Cut a stack of pages from binding (one calendar's worth)
2. Set up tripod + lights, calibrate cross-polarization, shoot the ColorChecker reference frame
3. Photograph one month per session, ~12 pages, ~20 minutes
4. Lumix Tether → watched folder → LR Classic auto-imports with develop preset and session keywords
5. After the shoot: in LR Classic, export TIFFs to `~/madonnahist/exports/{year}-{month}-batch-N/`
6. Run `scripts/upload-page.mjs ~/madonnahist/exports/2026-05-batch-1/` — Spaces upload + DB rows + OCR jobs enqueued
7. OCR worker picks up jobs in background; LLM cleanup follows automatically

### 10.2 Correction session (Madonna)
1. Open `madonnahist.gaylon.photos/correct` on iPad
2. Sees "47 days waiting for review" + "Resume where you left off"
3. Tap Resume → opens last `current_day_id` from her active session, or starts a new session if the prior one was abandoned
4. Three-pane editor: image left, OCR + LLM suggestion middle, corrected text right
5. Edits text, taps Save (or auto-save fires after 1s) — inserts a new `day_corrections` row; trigger updates `calendar_days.corrected_text`
6. Taps Save & Next → marks `accepted`, advances queue, enqueues an `entity_extract` job
7. After 30 minutes: taps Done → session summary "27 corrected, 3 flagged, 0 skipped"

### 10.3 "On this day" browse (family viewer)
1. Open `madonnahist.gaylon.photos` on phone
2. Top of page: "On May 3 in our history" — entries from May 3 across all years
3. Tap an entry → day detail (image, corrected text, tags, entities, AI summary if present)
4. Swipe left/right → adjacent days in the same year
5. Tap a tag chip (e.g., `marcus`) → person profile (all days mentioning Marcus, paginated, alias-resolved)

### 10.4 Book view (family viewer)
1. From a year browse or person profile, tap "Read 1968 as a book"
2. Immersive view: ~3–5 days per page, image thumbs in margin, text body in serif
3. Swipe to advance; chapter breaks at month boundaries
4. End of year: "Continue to 1969" or "Back to library"

## 11. Phases

| Phase | Scope | Definition of Done |
|---|---|---|
| **Phase 1 — Foundation** | DB (with all V4 tables, triggers, role grants), auth, page upload script, naive day-cell cropping (one default template), OCR worker (one vendor), basic correction UI three-pane editor + queue, basic day-detail viewer | Madonna can correct a day and a family member can view it |
| **Phase 2 — UX & Search** | Crop-template admin UI (drag corners, save per year/month), full-text + tag + entity search, calendar nav, surrounding-day context sidebar, mobile viewer polish | Full archive is navigable and searchable on phone |
| **Phase 3 — AI Enrichment** | LLM cleanup worker, entity extractor, alias resolution, person/place pages, AI tag suggestions in correction UI | Tags auto-suggested; entity pages exist |
| **Phase 4 — Narrative & Polish** | Summary generator (year/decade/person), book view, Transkribus family-handwriting training, semantic search (pgvector), backup automation, restore drill | A grandchild can sit down and read 1968 as a book |

## 12. Open Questions

- **Crop-template accuracy** — how many distinct templates will be needed in practice? Phase 1 ships one; Phase 2 builds the UI to add more.
- **Multiple writers** — are there multiple long-term writers across 60 years? If yes, OCR/LLM prompts may benefit from writer-specific training in Phase 4 (Transkribus has a per-writer model concept).
- **iPad generation** — affects whether Apple Pencil handwriting input is reliable in the corrected-text field (faster than tap-typing for some corrections).
- **Family viewer accounts** — individual accounts per family member, or a shared "family" account? Affects audit log granularity and whether "last viewed by" features make sense.
- **`Calendar_Digitization_Plan.md`** — keep as historical artifact or delete? Currently referenced as background only.
- **Photo / letter ingestion** — out of scope for V4 but the `calendar_*` table prefix anticipates future scope expansion. If we want photos in the archive too, the model should be revisited at Phase 4.
