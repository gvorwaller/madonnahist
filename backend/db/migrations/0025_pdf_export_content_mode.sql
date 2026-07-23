-- 0025_pdf_export_content_mode.sql
-- PDF export content modes (Gaylon, 2026-07-23): a generated PDF can be the
-- full book (days + narrative, the only thing Phase H v1 produced), the
-- published narrative only, or the day chapters only. This column records
-- which one a given pdf_exports row actually is, so /admin/exports and the
-- new viewer-facing download endpoint (src/routes/app/year/[year]/pdf/+server.ts)
-- can tell them apart and pick the right one.
--
-- Runs as madonnahist_owner via migrate_pg.sh (owner-owned objects; grants
-- extend the 0004_grants_rls.sql model, same as every migration since).

ALTER TABLE pdf_exports
  ADD COLUMN content_mode TEXT NOT NULL DEFAULT 'full'
    CHECK (content_mode IN ('full', 'narrative', 'days'));

-- ─────────────────────────────────────────────────────────────────
-- Grants
--
-- No grant changes needed: this is a new COLUMN on an existing table, not a
-- new relation, so no default-privilege block fires and no REVOKE/GRANT is
-- required. 0024_pdf_exports.sql's table-level grants already cover it —
-- madonnahist_worker has INSERT (writes the column once, on job completion,
-- via backend/workers/enrichment-worker.ts's processPdfExport) and
-- madonnahist_app has SELECT + DELETE (reads it for the /admin/exports
-- listing and the new viewer download endpoint; never UPDATEs a row, same
-- immutable-once-written rule 0024 already established for the rest of the
-- table). Verified: neither role has any column-level grant on pdf_exports
-- that would need extending — table-level GRANT/REVOKE applies uniformly to
-- every column, including one added after the fact.
-- ─────────────────────────────────────────────────────────────────
