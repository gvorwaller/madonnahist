-- 0023_adhoc_narratives.sql
-- Phase G of docs/2026-07-21-next-phases-search-viewer-narrative-plan.md —
-- "Ask the archive": ad hoc narrative queries over an admin-chosen subset
-- of the archive (td-84c7fa).
--
-- Runs as madonnahist_owner via migrate_pg.sh (owner-owned objects; grants
-- extend the 0004_grants_rls.sql model, same as every migration since).
--
-- Unlike narrative_summaries (Phase E), this is a SYNCHRONOUS, app-only
-- feature: /admin/ask's `ask` action resolves the subset, calls the LLM
-- directly (via src/lib/server/llm.ts), and shows the result inline — no
-- job_runs row, no enrichment worker involvement at all. madonnahist_worker
-- ends up with NO privilege at all on this table (see the Grants section
-- below for how — 0004's default privileges auto-grant it a harmless SELECT
-- the instant this table is created, same as every table since
-- 0007_capture_intake.sql; this migration explicitly REVOKEs it because
-- Phase G's spec asks for zero worker access, not just "nothing worker code
-- happens to use").
CREATE TABLE adhoc_narratives (
  id                BIGSERIAL PRIMARY KEY,
  question          TEXT NOT NULL,
  subset_definition JSONB NOT NULL,
  narrative_text    TEXT NOT NULL,
  day_count         INT NOT NULL,
  model_name        TEXT NOT NULL,
  created_by        BIGINT NOT NULL REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Supports the admin list ordering (newest saved narrative first).
CREATE INDEX idx_adhoc_narratives_created_at ON adhoc_narratives(created_at DESC);

-- ─────────────────────────────────────────────────────────────────
-- Grants
--
-- Migrations run as madonnahist_owner, so 0004's
-- `ALTER DEFAULT PRIVILEGES ... GRANT SELECT, INSERT, UPDATE, DELETE ON
-- TABLES TO madonnahist_app` already applies to this brand-new table the
-- instant CREATE TABLE runs — including UPDATE, which this feature does
-- NOT want (a saved ad hoc narrative is create/list/delete only; unlike
-- admin/narratives' saveEdit, there is no "edit in place" action here).
-- The explicit GRANT documents the intended surface; the REVOKE removes
-- the auto-granted UPDATE rather than relying on nobody ever adding an
-- edit action against undocumented ambient privilege.
-- ─────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, DELETE ON adhoc_narratives TO madonnahist_app;
REVOKE UPDATE ON adhoc_narratives FROM madonnahist_app;

-- Redundant with 0004's sequence default-privilege line (also fires
-- automatically for a sequence created by owner) but written explicitly for
-- the same "documents intent" reason 0007_capture_intake.sql gives for its
-- own sequence grant.
GRANT USAGE, SELECT, UPDATE ON SEQUENCE adhoc_narratives_id_seq TO madonnahist_app;

-- madonnahist_worker: NO privilege at all on this table, verified after the
-- fact (not assumed — see below).
--
-- CORRECTION vs. this migration's first draft: 0004_grants_rls.sql's
-- default-privilege block actually reads
--   ALTER DEFAULT PRIVILEGES FOR ROLE madonnahist_owner IN SCHEMA public
--     GRANT SELECT ON TABLES TO madonnahist_worker;
-- (line 30-31 of 0004) — a line this migration's author initially missed.
-- That means EVERY table madonnahist_owner creates afterward, including
-- this one, gets madonnahist_worker SELECT automatically the instant
-- CREATE TABLE runs — confirmed with `\dp adhoc_narratives` showing
-- `madonnahist_worker=r` before the REVOKE below was added, and the same is
-- true today of 0007_capture_intake.sql's capture_intake table (`\dp
-- capture_intake` also shows `madonnahist_worker=r`) despite that
-- migration's comment saying "the worker role never touches intake" — that
-- precedent tolerates the harmless ambient SELECT rather than revoking it,
-- because nothing there depended on truly zero access.
--
-- Phase G's spec is more literal: "the worker gets NOTHING". Since this
-- table has no legitimate worker use case at all (no job type ever reads or
-- writes it), the explicit REVOKE below actually achieves that, rather than
-- just relying on no worker code happening to query it.
REVOKE SELECT ON adhoc_narratives FROM madonnahist_worker;

-- ─────────────────────────────────────────────────────────────────
-- private_data.api_credentials read access for the Anthropic key
--
-- Checked before writing this migration: madonnahist_app already has
-- unconditional SELECT on private_data.api_credentials from
-- 0002_private_data.sql ("GRANT SELECT ON private_data.api_credentials TO
-- madonnahist_app;") — the same grant src/lib/ingest/spaces-upload.ts
-- already relies on for DO Spaces credentials via src/lib/credentials.ts's
-- credentialService. src/lib/server/llm.ts (Phase G's app-side Anthropic
-- helper) reads the 'anthropic'/'API_KEY' row through that same
-- credentialService, so no new grant is required here.
-- ─────────────────────────────────────────────────────────────────
