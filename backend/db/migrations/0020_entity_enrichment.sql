-- 0020_entity_enrichment.sql
-- Phase D of docs/2026-07-21-next-phases-search-viewer-narrative-plan.md —
-- entity extraction worker plumbing: auto-enqueue on acceptance, a
-- worker-scoped DELETE surface for AI-sourced day_entities/day_tags rows,
-- and a per-entity-type slug uniqueness fix.
--
-- Runs as madonnahist_owner via migrate_pg.sh (owner-owned objects; grants
--/RLS extend the 0004_grants_rls.sql model). `entities` is empty in both
-- boxes at the time this is written, so the constraint swap below is safe.

-- ─────────────────────────────────────────────────────────────────
-- 1. entities.slug: global UNIQUE → UNIQUE (entity_type, slug)
--
--    A global slug would collapse "Jordan" the person and "Jordan" the
--    place into a single row once the enrichment worker's
--    ON CONFLICT (entity_type, slug) DO NOTHING + re-select upsert runs —
--    the two entity_types need independent slug namespaces.
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE entities DROP CONSTRAINT IF EXISTS entities_slug_key;
ALTER TABLE entities ADD CONSTRAINT entities_entity_type_slug_key UNIQUE (entity_type, slug);

-- ─────────────────────────────────────────────────────────────────
-- 2. Auto-enqueue entity_extract on acceptance
--
--    A second AFTER INSERT trigger on day_corrections, alongside (not
--    replacing) 0005's trg_after_correction_insert — that trigger still
--    owns the calendar_days.corrected_text propagation; this one only
--    enqueues a job_runs row. WHEN (NEW.status_after = 'accepted') means
--    the function body never runs for the other four status_after values,
--    so no in-body branching is needed.
--
--    The payload carries correction_id = NEW.id — the enrichment worker's
--    staleness guard (Phase D item 4) re-reads day_corrections at
--    execution time and no-ops if a newer correction has since landed.
--
--    Dedupe: skip the INSERT if an unstarted ('pending') entity_extract job
--    for the same day already exists — an in_progress job is NOT a
--    dedupe hit (a stale in_progress job is expected to be reclaimed and
--    reprocessed by the worker's own retry-window logic, not silently
--    absorbed here).
--
--    SECURITY DEFINER + pinned search_path, matching every function in
--    0005_triggers.sql — madonnahist_app holds a broad table-level INSERT
--    on job_runs today (0004's initial "GRANT ... ON ALL TABLES" line), but
--    this function must not depend on that surviving; running as owner
--    keeps the enqueue path correct even if a future migration tightens
--    app's job_runs grant the way 0006 tightened calendar_days.
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION trg_fn_after_correction_enqueue_entity_extract()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM job_runs
     WHERE job_type = 'entity_extract'
       AND status = 'pending'
       AND (payload->>'day_id')::int = NEW.day_id
  ) THEN
    INSERT INTO job_runs (job_type, payload)
    VALUES ('entity_extract', jsonb_build_object('day_id', NEW.day_id, 'correction_id', NEW.id));
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_after_correction_enqueue_entity_extract ON day_corrections;
CREATE TRIGGER trg_after_correction_enqueue_entity_extract
  AFTER INSERT ON day_corrections
  FOR EACH ROW
  WHEN (NEW.status_after = 'accepted')
  EXECUTE FUNCTION trg_fn_after_correction_enqueue_entity_extract();

-- ─────────────────────────────────────────────────────────────────
-- 3. Worker-scoped DELETE on day_entities / day_tags
--
--    The enrichment worker replaces a day's AI-sourced rows wholesale on
--    every re-extraction (DELETE source='ai' then re-INSERT). 0004 granted
--    the worker INSERT-only (WITH CHECK source='ai') and explicitly
--    REVOKEd DELETE as defense-in-depth. This migration grants DELETE back
--    but scopes it with a matching RLS policy — the worker can only ever
--    delete AI-sourced rows; a human correction/tag row is invisible to a
--    worker-issued DELETE regardless of WHERE clause, same "three lines of
--    defense" model 0004 documents for INSERT.
-- ─────────────────────────────────────────────────────────────────
GRANT DELETE ON day_entities, day_tags TO madonnahist_worker;

CREATE POLICY day_tags_worker_delete_ai_only ON day_tags
  FOR DELETE TO madonnahist_worker
  USING (source = 'ai');

CREATE POLICY day_entities_worker_delete_ai_only ON day_entities
  FOR DELETE TO madonnahist_worker
  USING (source = 'ai');
