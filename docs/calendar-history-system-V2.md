# Calendar History System — V2

> Authoritative system plan. Supersedes `calendar-history-system.md` (V1, ChatGPT preliminary draft). If other docs conflict, this wins.

## 1. Purpose & Scope

A private, family-access web app that digitizes ~60 years of handwritten family calendar entries into a structured, searchable, and explorable archive of daily life.

**In scope:**
- Capture pipeline: phone-cut single-sheet calendar pages → DAM cataloging → DO Spaces
- OCR/HTR pipeline: image → vendor-OCR → LLM cleanup → human correction → structured `calendar_days` rows
- Madonna's correction UI (iPad-first)
- Family viewer (phone-first): "on this day," day detail, year/decade browse, search, book view
- AI enrichment: per-day entity extraction + per-year/decade narrative summaries

**Out of scope (Phase 4+ if ever):**
- Photo or letter ingestion beyond the calendars
- Public sharing or external authentication
- Multi-tenant — this is one family's archive, period

## 2. Roles & Access

| Role | Surfaces | Capabilities |
|---|---|---|
| **Admin** (Gaylon) | Both | Full read/write; manages users; runs reprocessing jobs; reviews audit log |
| **Corrector** (Madonna) | Correction UI (iPad-first) + Viewer | Read/write `corrected_text`, `tags`, `correction_status`; cannot delete or edit images |
| **Viewer** (other family) | Viewer only | Read-only access to all surfaces; no correction UI; can request entity tags via comment |

Sessions are cookie-based, `httpOnly`, `secure`, `SameSite=Strict`. No public registration — users are added by admin.

Authentication uses argon2id password hashing (matches giftlist's pattern).

## 3. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  CAPTURE                                                         │
│  ┌──────────────┐    ┌────────────┐    ┌──────────────┐         │
│  │ G9 II + 60mm │ ─▶ │ Lumix      │ ─▶ │ LR Classic   │         │
│  │ on tripod    │    │ Tether →   │    │ auto-import  │         │
│  │              │    │ watched    │    │ + keyword    │         │
│  └──────────────┘    │ folder     │    └──────┬───────┘         │
│                      └────────────┘           │                  │
│                                               ▼                  │
│                                       ┌──────────────┐           │
│                                       │ Export TIFF  │           │
│                                       │ + sidecar    │           │
│                                       └──────┬───────┘           │
└──────────────────────────────────────────────┼──────────────────┘
                                               ▼
┌─────────────────────────────────────────────────────────────────┐
│  INGEST                                                          │
│  ┌──────────────┐    ┌────────────┐    ┌──────────────┐         │
│  │ upload-page  │ ─▶ │ DO Spaces  │    │ insert       │         │
│  │ script       │    │ (originals │    │ calendar_    │         │
│  │ (cron)       │    │ + crops)   │    │ pages row    │         │
│  └──────────────┘    └────────────┘    └──────┬───────┘         │
│                                               ▼                  │
│                                       ┌──────────────┐           │
│                                       │ enqueue OCR  │           │
│                                       │ jobs (one    │           │
│                                       │ per day cell)│           │
│                                       └──────┬───────┘           │
└──────────────────────────────────────────────┼──────────────────┘
                                               ▼
┌─────────────────────────────────────────────────────────────────┐
│  AI HARNESS (workers, queue-driven)                              │
│  OCR Worker → LLM Cleanup → Entity Extractor → Summary Generator │
│  (each is a standalone process, pulls from job_runs)             │
└──────────────────────────┬──────────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  POSTGRES (source of truth)                                      │
│  calendar_pages, calendar_days, audit_log, job_runs,             │
│  users, sessions, app_state, entities (jsonb), tags (text[])     │
└──────────────────────────┬──────────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  SVELTEKIT APP                                                   │
│  ┌──────────────────────┐    ┌────────────────────────────┐     │
│  │ /admin/* — admin     │    │ /correct/* — Madonna's     │     │
│  │ surfaces             │    │ correction UI (iPad)       │     │
│  └──────────────────────┘    └────────────────────────────┘     │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ /app/* — family viewer (phone-first; today, browse,      │   │
│  │ detail, search, book view, person, decade)               │   │
│  └──────────────────────────────────────────────────────────┘   │
│  +server.js endpoints + form actions handle all mutations        │
└──────────────────────────┬──────────────────────────────────────┘
                           ▼
                    nginx → Cloudflare
                  madonnahist.gaylon.photos
```

## 4. Tech Stack

| Layer | Choice | Rationale |
|---|---|---|
| Frontend + server | **SvelteKit** (TypeScript, adapter-node, Svelte 5 with runes) | Smaller mobile runtime, single-framework full-stack, operational match with giftlist |
| Database | **PostgreSQL** (native, port 5434) | Already settled; full-text search and JSONB for entities |
| Auth | Cookie sessions + argon2id | Matches giftlist pattern |
| Image storage | **DigitalOcean Spaces** | Settled; object keys in DB |
| Image processing | Sharp (Node) | For thumbnails, day-cell crops if needed |
| OCR vendors | Transkribus (primary, trainable on family handwriting) + Google Vision + Azure Document Intelligence (fallbacks) | Multi-vendor pluggable |
| LLM | Anthropic Claude (or OpenAI — pluggable) | For cleanup, entity extraction, summary generation |
| Reverse proxy | nginx | Same as siblings |
| Edge | Cloudflare | TLS, cache, DDoS |
| Process manager | PM2 | Same as siblings |
| Task queue | PostgreSQL-based (`SELECT FOR UPDATE SKIP LOCKED` on `job_runs`) | No need for Redis/SQS for this scale |

## 5. Data Model

```sql
-- Users: admin + corrector + viewers
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'corrector', 'viewer')),
  password_hash TEXT NOT NULL,             -- argon2id
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                     -- random 32-byte token, base64url
  user_id INT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

-- Pages: one row per scanned monthly page
CREATE TABLE calendar_pages (
  id SERIAL PRIMARY KEY,
  year INT NOT NULL,
  month INT NOT NULL CHECK (month BETWEEN 1 AND 12),
  page_image_path TEXT NOT NULL,           -- DO Spaces object key
  capture_session TEXT,                    -- e.g., "2026-05-10-batch-1"
  notes TEXT,                              -- e.g., "page edge torn; reshot 2026-06-01"
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (year, month)
);

-- Days: one row per calendar day; this is the working unit
CREATE TABLE calendar_days (
  id SERIAL PRIMARY KEY,
  page_id INT NOT NULL REFERENCES calendar_pages(id),
  entry_date DATE UNIQUE NOT NULL,         -- one canonical row per day, even if reshot
  day_image_path TEXT,                     -- DO Spaces object key for the day-cell crop
  ocr_initial_text TEXT,                   -- raw OCR output, never overwritten by humans
  ocr_vendor TEXT,                         -- 'transkribus' | 'google-vision' | 'azure'
  ocr_run_at TIMESTAMPTZ,
  llm_draft_text TEXT,                     -- LLM-cleaned version; suggestion only
  llm_run_at TIMESTAMPTZ,
  corrected_text TEXT,                     -- HUMAN-VALIDATED. SACRED. Never overwritten by automation.
  corrected_by INT REFERENCES users(id),
  corrected_at TIMESTAMPTZ,
  confidence_score FLOAT,                  -- combined OCR + LLM confidence
  correction_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (correction_status IN ('pending', 'in_progress', 'accepted', 'flagged', 'illegible')),
  tags TEXT[] DEFAULT '{}',                -- normalized tags: ['marcus', 'birthday', 'snowstorm']
  entities JSONB DEFAULT '{}',             -- {people: [...], places: [...], events: [...]}
  ai_summary TEXT,                         -- per-day narrative summary (optional, generated)
  fts tsvector GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(corrected_text, '') || ' ' ||
      coalesce(array_to_string(tags, ' '), '') || ' ' ||
      coalesce(ai_summary, '')
    )
  ) STORED,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_calendar_days_fts ON calendar_days USING gin(fts);
CREATE INDEX idx_calendar_days_status ON calendar_days(correction_status) WHERE correction_status = 'pending';
CREATE INDEX idx_calendar_days_tags ON calendar_days USING gin(tags);
CREATE INDEX idx_calendar_days_entities ON calendar_days USING gin(entities);

-- Year/decade summaries (separately authored or generated)
CREATE TABLE narrative_summaries (
  id SERIAL PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('year', 'decade', 'person')),
  scope_key TEXT NOT NULL,                 -- '1968' or '1960s' or 'marcus'
  summary_text TEXT NOT NULL,
  generated_by TEXT NOT NULL,              -- 'claude-opus-4-7' or user_id for human
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  is_published BOOLEAN DEFAULT FALSE,      -- admin gates publication
  UNIQUE (scope, scope_key)
);

-- Audit log (per cs.md SACRED rules)
CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id),
  action TEXT NOT NULL,                    -- 'correct_day' | 'tag_add' | 'flag_illegible' | etc.
  entity_type TEXT NOT NULL,
  entity_id INT NOT NULL,
  before_value JSONB,
  after_value JSONB,
  description TEXT NOT NULL,               -- human-readable
  occurred_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_audit_log_entity ON audit_log(entity_type, entity_id, occurred_at DESC);

-- Job queue for AI harness workers
CREATE TABLE job_runs (
  id BIGSERIAL PRIMARY KEY,
  job_type TEXT NOT NULL,                  -- 'ocr' | 'llm_cleanup' | 'entity_extract' | 'summary_gen'
  payload JSONB NOT NULL,                  -- {day_id: 12345} or {scope: 'year', key: '1968'}
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_progress', 'done', 'failed')),
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  enqueued_at TIMESTAMPTZ DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX idx_job_runs_pending ON job_runs(job_type, enqueued_at) WHERE status = 'pending';

-- App-level state (for things like "current capture session")
CREATE TABLE app_state (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

## 6. Module Specifications

### 6.1 Capture & Ingestion

**What it does:** Moves calendar page images from the photo workflow (Lumix Tether → LR Classic → exports) into DO Spaces, creates `calendar_pages` and `calendar_days` rows, and enqueues OCR jobs.

**Inputs:** TIFF/JPEG files in `~/madonnahist/exports/{year}-{month}/page.tif`, named per the convention in the equipment shortlist.

**Outputs:** Spaces object keys; DB rows; `job_runs` rows of type `ocr` for each day cell.

**Where it lives:** `scripts/upload-page.mjs` — Node script run manually after each LR export (later: cron-watched folder).

**Behavior:**
1. Validate filename matches `YYYY-MM_pageN.tif`
2. Upload original to `s3://madonnahist/originals/{year}/{month}/page.tif`
3. Use Sharp to crop into 31 day cells (sized by month), upload each to `s3://madonnahist/days/{year}/{month}/{day}.jpg`
4. Insert `calendar_pages` row + 28–31 `calendar_days` rows
5. Enqueue one `ocr` job per day cell

**Day-cell cropping:** First-pass uses month-grid templates (5×7 grid for 31-day months, 5×6 for shorter). Second-pass refinement: a small UI for admin to drag corners on the first page of each year, save the template, apply to remaining months. Phase 2 work — Phase 1 uses naive grid.

### 6.2 OCR / HTR Worker

**What it does:** Pulls `ocr` jobs, sends day-cell images to a vendor, writes `ocr_initial_text` and `confidence_score`.

**Where it lives:** `workers/ocr-worker.mjs` — long-running Node process, separate PM2 entry, idempotent.

**Vendor selection:** A small abstraction (`src/lib/ocr/vendors/{transkribus,google,azure}.ts`) with a common interface `transcribe(imageUrl) → {text, confidence, vendorMeta}`. Default vendor configured in `app_state` (key `default_ocr_vendor`); per-job override possible.

**Re-run safety:** Re-running OCR on a day **only** updates `ocr_initial_text`, never `corrected_text`. The DB schema enforces this (workers do not have UPDATE permission on `corrected_text`).

**Failure modes:**
- Vendor 5xx → retry with backoff (1m, 5m, 25m), then mark `failed`
- Image not found in Spaces → mark `failed`, log to audit
- Confidence below threshold (configurable, default 0.4) → mark day's `correction_status = 'flagged'` for human attention

### 6.3 LLM Cleanup Worker

**What it does:** Takes `ocr_initial_text` plus context (year/month, surrounding days, prior corrections), produces a cleaned draft in `llm_draft_text`. Never writes to `corrected_text`.

**Where it lives:** `workers/llm-cleanup-worker.mjs`.

**Prompt context:** The LLM gets the OCR output + the prior 3 days' `corrected_text` (to learn handwriting style and abbreviations) + a project-level prompt explaining what kind of entries to expect.

**Why not write directly to `corrected_text`:** Madonna is the truth source. The LLM is a draft assistant only. The correction UI shows `llm_draft_text` as a suggestion that Madonna can accept (one tap → copies into `corrected_text`) or override.

### 6.4 Entity Extractor

**What it does:** After human correction, extracts people, places, and events from `corrected_text`, normalizes them, and writes to `tags` and `entities`.

**Where it lives:** `workers/entity-extractor.mjs`.

**Triggered by:** `correction_status` transition to `'accepted'` enqueues an `entity_extract` job.

**Normalization:** A `name_aliases` table (deferred to Phase 3) maps "M.", "Marc", "Marcus V." → `marcus`. Until then, the worker emits canonical keys based on a fuzzy match against existing tags.

### 6.5 Summary Generator

**What it does:** Generates per-year, per-decade, and per-person narrative summaries from accepted entries.

**Where it lives:** `workers/summary-gen.mjs`.

**Triggered by:** Manual admin trigger (button in `/admin/summaries`), or by reaching a milestone (e.g., 95% of a year accepted).

**Output:** `narrative_summaries` rows with `is_published = false`. Admin reviews and toggles `is_published`.

### 6.6 Correction UI (Madonna's iPad)

**What it does:** Three-pane editor for human correction of OCR drafts. iPad-first design, large touch targets, queue-based session workflow.

**Where it lives:** SvelteKit routes under `/correct/*`:
- `/correct` — session home (queue, progress, resume)
- `/correct/day/[date]` — the three-pane editor
- `/correct/calendar` — month-grid navigator to jump to a specific day
- `/correct/done` — session summary

**See `ui-mockups-V1.md` § A.**

**Key behaviors:**
- Auto-save: any keystroke in the corrected-text field debounces (1s) and saves
- Keyboard shortcuts (for when an external keyboard is paired): `⌘S` save, `⌘→` next day, `⌘↑` accept LLM draft, `⌘F` flag illegible
- Touch shortcuts: large buttons at the bottom of the screen mirror the keyboard shortcuts
- Image zoom: pinch-to-zoom, double-tap to fit
- "Looks like 1968-03-12, day before mine" — surrounding-day context shown as a sidebar, dismissible

### 6.7 Viewer UI (family phones)

**What it does:** Read-only access to the archive. Phone-first (vertical scroll, single column), works on tablet/desktop.

**Where it lives:** SvelteKit routes under `/app/*`:
- `/app` (or `/`) — "On this day in family history"
- `/app/day/[date]` — single-day detail
- `/app/year/[year]` — year browse / timeline
- `/app/decade/[decade]` — decade summary view
- `/app/search` — full-text search
- `/app/book/[scope]/[key]` — immersive book-style reading mode
- `/app/person/[slug]` — everyone tagged X
- `/app/place/[slug]` — everywhere tagged X (Phase 3)

**See `ui-mockups-V1.md` § B.**

**Performance:**
- Day-detail images served from Spaces with Cloudflare caching (long TTL, immutable)
- Day-cell thumbnails generated at upload time, served at 400px width
- Lazy-load images below the fold
- SvelteKit SSR for the first paint; client-side hydration for navigation

### 6.8 API Layer

SvelteKit `+server.js` endpoints + form actions. No separate Express service.

**Form actions (correction):**
- `POST /correct/day/[date]?/save` — save `corrected_text`, `tags`, `correction_status`
- `POST /correct/day/[date]?/accept-llm` — copy `llm_draft_text` → `corrected_text`
- `POST /correct/day/[date]?/flag-illegible` — set status, prompt for note

**+server.js endpoints (read-heavy):**
- `GET /api/days?from=YYYY-MM-DD&to=YYYY-MM-DD&status=pending` — list days for queue UI
- `GET /api/search?q=...&from=...&to=...&tags=...` — paginated full-text search
- `GET /api/timeline/[year]` — month-grouped day listings
- `GET /api/person/[slug]` — all days tagged with this person

**Admin-only endpoints:**
- `POST /admin/jobs/enqueue` — enqueue worker jobs by type and scope
- `POST /admin/users/create`
- `GET /admin/audit?entity=...&from=...`

### 6.9 Auth & Sessions

- Login: `POST /login` → form action validates with argon2id, sets session cookie
- Cookie: `httpOnly`, `secure`, `SameSite=Strict`, 30-day expiry, refreshed on activity
- `hooks.server.ts` resolves session on every request, populates `event.locals.user`
- Route guards: `/correct/*` requires `corrector` or `admin`; `/admin/*` requires `admin`; `/app/*` requires any authenticated user

### 6.10 Search & Indexing

PostgreSQL `tsvector` column on `calendar_days.fts` (generated from `corrected_text + tags + ai_summary`). GIN index. Sub-100ms full-text search on the full archive.

For tag search: GIN index on `tags` array → `WHERE tags && ARRAY['marcus', 'birthday']`.

For entity search: GIN index on `entities` JSONB → `WHERE entities @> '{"people": ["marcus"]}'`.

Phase 4 may add semantic search via pgvector + embeddings, but full-text + tags handles the 90% case.

### 6.11 Backup & Disaster Recovery

- **Database:** Nightly `pg_dump --format=custom` → DO Spaces, 30-day retention
- **Images:** Already in Spaces (durable, replicated). No additional backup needed for images.
- **Catalog (`.lrcat`):** Backed up by Adobe Cloud sync of the photography plan's preview cache; the user keeps a local Time Machine of the Mac (recommended).
- **Restore drill:** Once per year, restore the previous night's dump to a scratch DB and run a smoke-test query. Documented in `ops/restore-drill.md`.

### 6.12 Observability

- **PM2 logs** for all processes (web app, OCR worker, LLM worker, etc.) — rotated weekly
- **Audit log** for all human mutations — queryable from `/admin/audit`
- **Job runs table** is the source of truth for AI-harness state — `/admin/jobs` UI shows pending/in-flight/failed counts per worker
- **Health endpoint:** `GET /health` returns `{ db: 'ok', spaces: 'ok', workers: { ocr: 'idle|busy|stalled', ... } }`

## 7. Key User Workflows

### 7.1 Capture session (Gaylon)
1. Cut a stack of pages from binding
2. Set up tripod + lights, calibrate cross-polarization, shoot ColorChecker
3. Photograph one month per session, ~12 pages, ~20 minutes
4. Lumix Tether saves to watched folder; LR Classic auto-imports with develop preset
5. After session: in LR Classic, export TIFFs to `~/madonnahist/exports/`
6. Run `scripts/upload-page.mjs ~/madonnahist/exports/2026-05-batch-1/` — uploads to Spaces, inserts DB rows, enqueues OCR jobs
7. OCR worker picks up jobs in background; LLM cleanup follows automatically

### 7.2 Correction session (Madonna)
1. Open `madonnahist.gaylon.photos/correct` on iPad
2. See "23 days from March 1968 ready for review"
3. Tap to enter the queue → first day shown in three-pane editor
4. Image on left, OCR draft in middle, "what I think it says" field on right with LLM suggestion
5. Edit, tap Save (or auto-save fires after 1s of inactivity), tap Next
6. After 30 minutes: tap Done → session summary "27 corrected, 3 flagged, 0 skipped"

### 7.3 "On this day" browse (family viewer)
1. Open `madonnahist.gaylon.photos` on phone
2. Top of page: "On May 3 in family history" — entries from May 3, 2010, 1995, 1972, etc.
3. Tap an entry → day detail (image, corrected text, tags, AI summary)
4. Swipe left/right → adjacent days in the same year
5. Tap a tag (e.g., `marcus`) → all days tagged with Marcus, paginated

### 7.4 Book view (family viewer)
1. From any day, tap "Read 1968 as a book" → immersive paginated view
2. Each page shows ~3–5 days with images small in margin, text body
3. Swipe to advance; chapter breaks at month boundaries
4. End of year: "Continue to 1969" or "Back to library"

## 8. Phases

| Phase | Scope | Definition of Done |
|---|---|---|
| **Phase 1 — Foundation** | DB, auth, page upload script, naive day-cell cropping, OCR worker (one vendor), basic correction UI (the three-pane editor and queue), basic day-detail viewer | Madonna can correct a day and a family member can view it |
| **Phase 2 — UX & Search** | Refined day-cell cropping (template UI), search, tag UI, calendar nav, surrounding-day context, mobile viewer polish | Full archive can be navigated and searched on phone |
| **Phase 3 — AI Enrichment** | LLM cleanup worker, entity extractor, name aliases, person/place pages | Tags are auto-suggested; entity pages exist |
| **Phase 4 — Narrative & Polish** | Summary generator, book view, decade summaries, training Transkribus on family handwriting, semantic search (pgvector), backup automation | A grandchild can sit down and read 1968 as a book |

## 9. Open Questions

- **Cropping accuracy:** how much per-month customization will be needed? Phase 1 uses naive grid; if accuracy is poor we accelerate Phase 2's template UI.
- **Handwriting variability:** are there multiple writers across 60 years? If yes, Transkribus training in Phase 4 should produce per-writer models.
- **Madonna's iPad:** which generation? Affects whether we can rely on Apple Pencil for handwriting input (faster than tap-typing for some corrections) and which Safari/PWA features we can use.
- **Family viewer accounts:** are we creating individual accounts per family member, or a shared "family" account? Affects audit log granularity.
- **Photo/letter ingestion:** if the calendar archive succeeds, does scope expand to other family materials? Out of scope for V2 but worth scaffolding the data model to allow it (the `calendar_*` table prefix anticipates this).
