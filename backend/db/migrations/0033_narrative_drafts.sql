-- 0033_narrative_drafts.sql
-- Year narratives: several models, saved guidance, every draft kept
-- (td-f1f49b). Plan: docs/2026-11-20-narrative-models-guidance-plan.md
-- (reviewed by AGY2).
--
-- narrative_drafts    append-only history of every version of a year's text,
--                     like ocr_runs / llm_draft_runs. The worker INSERTs one
--                     row per job (job_run_id, unique, so a retried job can
--                     never add a second); the admin page INSERTs one for
--                     each hand edit (provider 'human', mode 'edit'), so the
--                     current text is always a draft that can be switched
--                     back to. Nothing ever updates or deletes one. The
--                     style/year guidance and the base text a revision
--                     started from are copied onto the row, so each draft
--                     records exactly what produced it.
-- narrative_guidance  the admin's saved notes for one year (one row per
--                     scope/scope_key). The global "house style" lives in
--                     app_state (key narrative_style_guidance), same as the
--                     viewer About text.
-- narrative_summaries gains source_draft_id: which candidate the current text
--                     came from (a hand edit is a draft too).
--
-- The worker no longer writes narrative_summaries at all: "Use this" is an
-- admin (app-role) action that copies a candidate across. This revokes the
-- worker's INSERT and 0021's column-scoped UPDATE, so family-visible text
-- can only ever change through the admin page.

CREATE TABLE narrative_drafts (
  id              BIGSERIAL PRIMARY KEY,
  scope           TEXT NOT NULL CHECK (scope IN ('year', 'decade', 'person')),
  scope_key       TEXT NOT NULL,
  model_name      TEXT NOT NULL,
  provider        TEXT NOT NULL CHECK (provider IN ('anthropic', 'google', 'legacy', 'human')),
  mode            TEXT NOT NULL CHECK (mode IN ('fresh', 'revise', 'imported', 'edit')),
  base_text       TEXT,
  style_guidance  TEXT,
  year_guidance   TEXT,
  draft_text      TEXT NOT NULL,
  day_count       INT NOT NULL DEFAULT 0,
  input_tokens    INT,
  output_tokens   INT,
  requested_by    INT REFERENCES users(id),
  -- The job that produced it. No FK: job_runs rows may be pruned, a draft
  -- outlives them. UNIQUE is the guarantee: one draft per job, however many
  -- times the job is attempted.
  job_run_id      BIGINT UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (mode <> 'revise' OR base_text IS NOT NULL),
  CHECK ((provider = 'human') = (mode = 'edit')),
  CHECK (mode NOT IN ('fresh', 'revise') OR job_run_id IS NOT NULL)
);
CREATE INDEX idx_narrative_drafts_scope ON narrative_drafts (scope, scope_key, created_at DESC);

CREATE TABLE narrative_guidance (
  scope          TEXT NOT NULL CHECK (scope IN ('year', 'decade', 'person')),
  scope_key      TEXT NOT NULL,
  guidance_text  TEXT NOT NULL,
  updated_by     INT REFERENCES users(id),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (scope, scope_key)
);

ALTER TABLE narrative_summaries
  ADD COLUMN source_draft_id BIGINT REFERENCES narrative_drafts(id);

-- Backfill: every existing narrative becomes an 'imported' candidate, so it
-- can be compared against new drafts and promoted back if a new one is worse.
INSERT INTO narrative_drafts (scope, scope_key, model_name, provider, mode, draft_text, created_at)
SELECT scope, scope_key, generated_by, 'legacy', 'imported', summary_text, generated_at
  FROM narrative_summaries
 ORDER BY generated_at;

UPDATE narrative_summaries s
   SET source_draft_id = d.id
  FROM narrative_drafts d
 WHERE d.mode = 'imported'
   AND d.scope = s.scope
   AND d.scope_key = s.scope_key;

-- ─────────────────────────────────────────────────────────────────
-- Grants. 0004's default privileges hand every new table CRUD to the app
-- and SELECT to the worker, so start from nothing (same as 0032) and grant
-- exactly the intended surface.
-- ─────────────────────────────────────────────────────────────────
REVOKE ALL ON narrative_drafts, narrative_guidance FROM madonnahist_app, madonnahist_worker;
REVOKE ALL ON SEQUENCE narrative_drafts_id_seq FROM madonnahist_app, madonnahist_worker;

-- Drafts: the worker adds generated ones, the admin page adds hand edits.
-- Neither can change or delete one.
GRANT SELECT, INSERT ON narrative_drafts TO madonnahist_worker, madonnahist_app;
GRANT USAGE ON SEQUENCE narrative_drafts_id_seq TO madonnahist_worker, madonnahist_app;

-- Year notes: the admin page owns them, the worker reads them (only for
-- jobs queued before this migration, which carry no copied guidance).
GRANT SELECT, INSERT, UPDATE, DELETE ON narrative_guidance TO madonnahist_app;
GRANT SELECT ON narrative_guidance TO madonnahist_worker;

-- The worker never writes family-visible narrative text again. A table-level
-- REVOKE UPDATE also removes 0021's column-level UPDATE grant.
REVOKE INSERT, UPDATE ON narrative_summaries FROM madonnahist_worker;
