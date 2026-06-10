-- 0004_grants_rls.sql
-- V4 § 8 — role grants, column-level REVOKEs, and RLS policies that enforce
-- the "human truth wins / history is append-only" invariants at the DB layer.
--
-- Roles themselves (madonnahist_owner, madonnahist_app, madonnahist_worker)
-- were created out-of-band during infra setup (td-9c6107) with
-- openssl-generated passwords; we do NOT CREATE/ALTER ROLE here so this
-- migration is safe to re-apply on either box without password clobber.
--
-- Three lines of defense:
--   (a) column-level REVOKE on calendar_days for app
--   (b) table-level REVOKE on calendar_days for worker
--   (c) RLS WITH CHECK (source='ai') on day_tags/day_entities for worker

-- ─────────────────────────────────────────────────────────────────
-- Connect + schema usage
-- ─────────────────────────────────────────────────────────────────
DO $$
BEGIN
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO madonnahist_app, madonnahist_worker',
    current_database()
  );
END $$;
GRANT USAGE  ON SCHEMA public        TO madonnahist_app, madonnahist_worker;

-- Default privileges for future tables created by owner.
ALTER DEFAULT PRIVILEGES FOR ROLE madonnahist_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO madonnahist_app;
ALTER DEFAULT PRIVILEGES FOR ROLE madonnahist_owner IN SCHEMA public
  GRANT SELECT ON TABLES TO madonnahist_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE madonnahist_owner IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO madonnahist_app, madonnahist_worker;

-- ─────────────────────────────────────────────────────────────────
-- App role — broad CRUD, then narrow down
-- ─────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO madonnahist_app;
GRANT USAGE, SELECT, UPDATE          ON ALL SEQUENCES IN SCHEMA public TO madonnahist_app;

-- Cannot UPDATE canonical correction columns or denorm-cache columns.
-- (After this column-level revoke, app's UPDATE on calendar_days remains
-- valid for every OTHER column — e.g., last_opened_*, editing_started_at,
-- current_session_id, crop_bounds, day_image_path.)
REVOKE UPDATE (
  corrected_text, corrected_by, corrected_at,
  correction_status, review_note,
  latest_ocr_run_id, latest_llm_draft_run_id, latest_confidence_score,
  search_aux_text
) ON calendar_days FROM madonnahist_app;

-- Cannot DELETE from history tables. Append-only is structural.
REVOKE DELETE ON ocr_runs, llm_draft_runs, day_corrections FROM madonnahist_app;

-- ─────────────────────────────────────────────────────────────────
-- Worker role — narrow INSERT surface
-- ─────────────────────────────────────────────────────────────────
GRANT SELECT ON ALL TABLES IN SCHEMA public TO madonnahist_worker;
GRANT INSERT ON ocr_runs, llm_draft_runs, narrative_summaries,
                entities, day_entities, day_tags, audit_log
  TO madonnahist_worker;
GRANT INSERT, UPDATE ON job_runs TO madonnahist_worker;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO madonnahist_worker;

-- Defense-in-depth: even though worker was never granted UPDATE on
-- calendar_days, an explicit REVOKE here documents intent and survives any
-- future inadvertent grant.
REVOKE UPDATE ON calendar_days FROM madonnahist_worker;

REVOKE DELETE ON ocr_runs, llm_draft_runs, day_corrections,
                 narrative_summaries, entities, day_entities, day_tags,
                 audit_log
  FROM madonnahist_worker;

-- ─────────────────────────────────────────────────────────────────
-- Row-Level Security: worker can only INSERT AI-sourced rows
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE day_tags     ENABLE ROW LEVEL SECURITY;
ALTER TABLE day_entities ENABLE ROW LEVEL SECURITY;

-- App has full access regardless of source.
CREATE POLICY day_tags_app_full ON day_tags
  FOR ALL TO madonnahist_app
  USING (true) WITH CHECK (true);

CREATE POLICY day_entities_app_full ON day_entities
  FOR ALL TO madonnahist_app
  USING (true) WITH CHECK (true);

-- Worker can read everything but can only INSERT source='ai'.
CREATE POLICY day_tags_worker_select ON day_tags
  FOR SELECT TO madonnahist_worker USING (true);

CREATE POLICY day_tags_worker_insert_ai_only ON day_tags
  FOR INSERT TO madonnahist_worker
  WITH CHECK (source = 'ai');

CREATE POLICY day_entities_worker_select ON day_entities
  FOR SELECT TO madonnahist_worker USING (true);

CREATE POLICY day_entities_worker_insert_ai_only ON day_entities
  FOR INSERT TO madonnahist_worker
  WITH CHECK (source = 'ai');
