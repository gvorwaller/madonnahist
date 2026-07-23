-- 0024_pdf_exports.sql
-- Phase H of docs/2026-07-21-next-phases-search-viewer-narrative-plan.md —
-- PDF/print export. One row per successfully generated PDF (admin-triggered
-- pdf_export job_runs job, rendered by the enrichment worker via headless
-- Chromium/Playwright and uploaded to Spaces).
--
-- Runs as madonnahist_owner via migrate_pg.sh (owner-owned objects; grants
-- extend the 0004_grants_rls.sql model, same as every migration since).

CREATE TABLE pdf_exports (
  id           BIGSERIAL PRIMARY KEY,
  scope        TEXT NOT NULL,
  scope_key    TEXT NOT NULL,
  object_key   TEXT NOT NULL UNIQUE,
  byte_size    BIGINT NOT NULL,
  day_count    INT NOT NULL,
  requested_by BIGINT REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Supports the admin /admin/exports listing (newest export first, per scope).
CREATE INDEX idx_pdf_exports_scope ON pdf_exports(scope, scope_key, created_at DESC);

-- ─────────────────────────────────────────────────────────────────
-- Grants
--
-- Migrations run as madonnahist_owner, so 0004's default-privilege lines
-- fire automatically the instant this CREATE TABLE runs:
--   ALTER DEFAULT PRIVILEGES ... GRANT SELECT, INSERT, UPDATE, DELETE ON
--     TABLES TO madonnahist_app;
--   ALTER DEFAULT PRIVILEGES ... GRANT SELECT ON TABLES TO madonnahist_worker;
-- Neither matches this feature's intended surface, so both are corrected
-- explicitly below rather than left to accident — the exact lesson
-- 0023_adhoc_narratives.sql documents (that migration's author initially
-- missed the worker's ambient default SELECT and had to add the REVOKE
-- after the fact).
--
-- Intended surface:
--   - madonnahist_worker INSERTs exactly one row per completed render
--     (backend/workers/enrichment-worker.ts's processPdfExport) and SELECTs
--     to read pdf_exports incidentally via its blanket table-level SELECT
--     grant (0004 line 58) — it never UPDATEs or DELETEs a row once written.
--   - madonnahist_app SELECTs to list exports and DELETEs to remove one
--     (src/routes/admin/exports/+page.server.ts's `delete` action) — it
--     never INSERTs (only the worker creates rows, on successful render)
--     and a row is immutable once written (no UPDATE surface at all).
-- ─────────────────────────────────────────────────────────────────
GRANT INSERT ON pdf_exports TO madonnahist_worker;

-- Defense-in-depth, matching 0004 line 68's precedent (an explicit REVOKE
-- documenting intent even though the privilege was never granted): the
-- default-privilege block above only grants worker SELECT, so worker never
-- had UPDATE/DELETE here in the first place — this just makes that
-- structural rather than incidental.
REVOKE UPDATE, DELETE ON pdf_exports FROM madonnahist_worker;

-- The real REVOKE: app's default INSERT/UPDATE (auto-granted by the
-- default-privilege block) is removed, leaving SELECT + DELETE only.
REVOKE INSERT, UPDATE ON pdf_exports FROM madonnahist_app;

-- Redundant with 0004's sequence default-privilege line (also fires
-- automatically for a sequence created by owner) but written explicitly,
-- same "documents intent" reason 0007/0023 give for their own sequence
-- grants — only the worker actually inserts, so only it needs this in
-- practice, but the default-privilege block already gave both roles
-- USAGE/SELECT/UPDATE on every sequence; nothing to revoke from app here
-- since a harmless, unused sequence privilege isn't a real access surface
-- the way a table-level INSERT/UPDATE grant is.
GRANT USAGE, SELECT, UPDATE ON SEQUENCE pdf_exports_id_seq TO madonnahist_worker;
