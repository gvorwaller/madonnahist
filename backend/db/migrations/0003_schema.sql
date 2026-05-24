-- 0003_schema.sql
-- V4 § 6 — all tables and indexes for the calendar-history system.
--
-- Runs as madonnahist_owner via migrate_pg.sh, so every object is
-- owner-owned automatically. Grants/RLS live in 0004; triggers in 0005.
--
-- Forward-reference handling: calendar_days carries pointer columns to
-- ocr_runs / llm_draft_runs / correction_sessions, but those tables also
-- reference calendar_days(id). We create calendar_days without those FKs
-- first, then ALTER TABLE … ADD CONSTRAINT after target tables exist.

-- ─────────────────────────────────────────────────────────────────
-- Identity
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'corrector', 'viewer')),
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- ─────────────────────────────────────────────────────────────────
-- Captured pages + crop templates
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE calendar_pages (
  id SERIAL PRIMARY KEY,
  year INT NOT NULL,
  month INT NOT NULL CHECK (month BETWEEN 1 AND 12),
  page_image_path TEXT NOT NULL,
  capture_session TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (year, month)
);

CREATE TABLE crop_templates (
  id SERIAL PRIMARY KEY,
  template_key TEXT UNIQUE NOT NULL,
  year_start INT,
  year_end INT,
  month INT CHECK (month BETWEEN 1 AND 12),
  grid_definition JSONB NOT NULL,
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────
-- Canonical per-day record (denormalized read-cache, populated by
-- triggers on history-table inserts)
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE calendar_days (
  id SERIAL PRIMARY KEY,
  page_id INT NOT NULL REFERENCES calendar_pages(id),
  entry_date DATE UNIQUE NOT NULL,

  day_image_path TEXT,
  crop_template_id INT REFERENCES crop_templates(id),
  crop_bounds JSONB,

  corrected_text TEXT,
  corrected_by INT REFERENCES users(id),
  corrected_at TIMESTAMPTZ,
  correction_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (correction_status IN ('pending', 'in_progress', 'accepted', 'flagged', 'illegible')),
  review_note TEXT,

  -- Forward-reference columns (FKs added after target tables exist).
  latest_ocr_run_id BIGINT,
  latest_llm_draft_run_id BIGINT,
  latest_confidence_score FLOAT,

  last_opened_by INT REFERENCES users(id),
  last_opened_at TIMESTAMPTZ,
  editing_started_at TIMESTAMPTZ,
  current_session_id BIGINT,

  ai_summary TEXT,

  search_aux_text TEXT NOT NULL DEFAULT '',

  fts tsvector GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(corrected_text, '') || ' ' ||
      coalesce(ai_summary, '') || ' ' ||
      coalesce(search_aux_text, '')
    )
  ) STORED,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_calendar_days_fts ON calendar_days USING gin(fts);
CREATE INDEX idx_calendar_days_status ON calendar_days(correction_status);
CREATE INDEX idx_calendar_days_pending ON calendar_days(entry_date)
  WHERE correction_status IN ('pending', 'flagged');
CREATE INDEX idx_calendar_days_last_opened
  ON calendar_days(last_opened_by, last_opened_at DESC);
CREATE INDEX idx_calendar_days_low_confidence
  ON calendar_days(latest_confidence_score)
  WHERE correction_status = 'pending';

-- ─────────────────────────────────────────────────────────────────
-- Append-only machine output history
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE ocr_runs (
  id BIGSERIAL PRIMARY KEY,
  day_id INT NOT NULL REFERENCES calendar_days(id) ON DELETE CASCADE,
  vendor TEXT NOT NULL,
  source_image_path TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  confidence_score FLOAT,
  vendor_meta JSONB NOT NULL DEFAULT '{}',
  created_by_job_run_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_ocr_runs_day_created ON ocr_runs(day_id, created_at DESC);

CREATE TABLE llm_draft_runs (
  id BIGSERIAL PRIMARY KEY,
  day_id INT NOT NULL REFERENCES calendar_days(id) ON DELETE CASCADE,
  based_on_ocr_run_id BIGINT REFERENCES ocr_runs(id),
  model_name TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  draft_text TEXT NOT NULL,
  confidence_note TEXT,
  created_by_job_run_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_llm_draft_runs_day_created ON llm_draft_runs(day_id, created_at DESC);

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
  status_after TEXT NOT NULL,
  editor_user_id INT NOT NULL REFERENCES users(id),
  source_llm_draft_run_id BIGINT REFERENCES llm_draft_runs(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_day_corrections_day_created ON day_corrections(day_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────
-- Correction-session state
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE correction_sessions (
  id BIGSERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  current_day_id INT REFERENCES calendar_days(id),
  queue_scope JSONB NOT NULL DEFAULT '{}',
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
  tag_label TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'human' CHECK (source IN ('human', 'ai')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (day_id, tag_slug)
);
CREATE INDEX idx_day_tags_slug ON day_tags(tag_slug);

-- ─────────────────────────────────────────────────────────────────
-- Structured entities (people, places, events) with alias resolution
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE entities (
  id BIGSERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('person', 'place', 'event')),
  alias_of_entity_id BIGINT REFERENCES entities(id),
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE day_entities (
  day_id INT NOT NULL REFERENCES calendar_days(id) ON DELETE CASCADE,
  entity_id BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'ai' CHECK (source IN ('human', 'ai')),
  confidence_score FLOAT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (day_id, entity_id)
);
CREATE INDEX idx_day_entities_entity ON day_entities(entity_id, day_id);

-- ─────────────────────────────────────────────────────────────────
-- Narrative summaries (Phase 4 but the table is here so worker code can
-- target a stable schema)
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE narrative_summaries (
  id SERIAL PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('year', 'decade', 'person')),
  scope_key TEXT NOT NULL,
  summary_text TEXT NOT NULL,
  generated_by TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_published BOOLEAN NOT NULL DEFAULT FALSE,
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
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_audit_log_entity ON audit_log(entity_type, entity_id, occurred_at DESC);
CREATE INDEX idx_audit_log_user ON audit_log(user_id, occurred_at DESC);

-- ─────────────────────────────────────────────────────────────────
-- Worker job queue (SELECT FOR UPDATE SKIP LOCKED)
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE job_runs (
  id BIGSERIAL PRIMARY KEY,
  job_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_progress', 'done', 'failed')),
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);
CREATE INDEX idx_job_runs_pending ON job_runs(job_type, enqueued_at) WHERE status = 'pending';

-- ─────────────────────────────────────────────────────────────────
-- App state (config knobs read by triggers and workers)
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE app_state (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
