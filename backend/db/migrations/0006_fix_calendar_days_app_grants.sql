-- 0006_fix_calendar_days_app_grants.sql
-- Fix a PostgreSQL grant-semantics bug present in V4 § 8 / migration 0004.
--
-- V4 § 8 prescribed:
--   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES … TO madonnahist_app;
--   REVOKE UPDATE (corrected_text, …) ON calendar_days FROM madonnahist_app;
--
-- That pattern does NOT do what the spec claims. Column-level REVOKE only
-- removes column-level grants. When a table-level UPDATE grant exists (as
-- the first line creates), it covers every column implicitly and the
-- column-level REVOKE silently no-ops. Verified directly: after 0004, the
-- app role could still `UPDATE calendar_days SET corrected_text = …`, in
-- direct violation of the V4 "human truth wins" invariant.
--
-- Correct pattern: REVOKE the table-level UPDATE on calendar_days, then
-- GRANT UPDATE per-column for the columns the app legitimately needs to
-- write (day-cell geometry, session-tracking, editor convenience). Every
-- canonical correction column and every trigger-maintained denorm column
-- stays unwritable by the app, so the only path to corrected_text is
-- INSERT INTO day_corrections → trg_after_correction_insert.
--
-- This affects only calendar_days. Other tables keep the broad app grant.
-- Worker role is unaffected — it never had table-level UPDATE on
-- calendar_days; the 0004 REVOKE statement against it was already a no-op
-- and remains correct as defense-in-depth.

REVOKE UPDATE ON calendar_days FROM madonnahist_app;

GRANT UPDATE (
  day_image_path,
  crop_template_id,
  crop_bounds,
  last_opened_by,
  last_opened_at,
  editing_started_at,
  current_session_id,
  ai_summary,
  updated_at
) ON calendar_days TO madonnahist_app;
