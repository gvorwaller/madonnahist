-- 0005_triggers.sql
-- V4 § 6.1 — four SECURITY DEFINER trigger functions that maintain the
-- calendar_days read-cache from inserts on the append-only history tables.
--
-- These are the ONLY code paths that update the canonical correction columns
-- and the latest_* pointer columns. Neither madonnahist_app nor
-- madonnahist_worker has direct UPDATE permission on those columns (V4 § 8 /
-- 0004_grants_rls.sql); the functions run with owner privileges via
-- SECURITY DEFINER so they can perform the privileged UPDATE that the caller
-- could not.
--
-- search_path is pinned on every function. Without that, a role that owns
-- objects in another schema could shadow a function name and hijack the
-- resolution inside a SECURITY DEFINER body. Pinning to (public, pg_temp)
-- forces lookups to the migrated schema.

-- Seed the auto-flag confidence threshold. Overridable via:
--   UPDATE app_state SET value = jsonb_build_object('threshold', 0.5)
--    WHERE key = 'flag_confidence_threshold';
INSERT INTO app_state (key, value)
  VALUES ('flag_confidence_threshold', jsonb_build_object('threshold', 0.4))
  ON CONFLICT (key) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────
-- (a) trg_after_ocr_run_insert
--     Updates latest_ocr_run_id + latest_confidence_score. Additionally,
--     when confidence is below threshold AND the day is still pending,
--     transitions correction_status to 'flagged'. Never overwrites a status
--     the human has set (accepted/flagged/illegible).
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION trg_fn_after_ocr_run_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  threshold      FLOAT;
  current_status TEXT;
BEGIN
  UPDATE calendar_days
     SET latest_ocr_run_id        = NEW.id,
         latest_confidence_score  = NEW.confidence_score,
         updated_at               = NOW()
   WHERE id = NEW.day_id;

  SELECT (value->>'threshold')::FLOAT INTO threshold
    FROM app_state WHERE key = 'flag_confidence_threshold';
  IF threshold IS NULL THEN
    threshold := 0.4;
  END IF;

  SELECT correction_status INTO current_status
    FROM calendar_days WHERE id = NEW.day_id;

  IF NEW.confidence_score IS NOT NULL
     AND NEW.confidence_score < threshold
     AND current_status = 'pending'
  THEN
    UPDATE calendar_days
       SET correction_status = 'flagged',
           review_note       = 'auto-flagged: low OCR confidence',
           updated_at        = NOW()
     WHERE id = NEW.day_id;
  END IF;

  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_after_ocr_run_insert
  AFTER INSERT ON ocr_runs
  FOR EACH ROW
  EXECUTE FUNCTION trg_fn_after_ocr_run_insert();

-- ─────────────────────────────────────────────────────────────────
-- (b) trg_after_llm_draft_insert
--     Updates latest_llm_draft_run_id pointer.
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION trg_fn_after_llm_draft_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE calendar_days
     SET latest_llm_draft_run_id = NEW.id,
         updated_at              = NOW()
   WHERE id = NEW.day_id;
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_after_llm_draft_insert
  AFTER INSERT ON llm_draft_runs
  FOR EACH ROW
  EXECUTE FUNCTION trg_fn_after_llm_draft_insert();

-- ─────────────────────────────────────────────────────────────────
-- (c) trg_after_correction_insert — THE critical trigger
--
--     Splits behavior by NEW.status_after. Only 'accepted' propagates
--     corrected_text / corrected_by / corrected_at to calendar_days. The
--     other 4 valid correction_status values transition status (and
--     review_note) without touching the canonical text. Anything else
--     raises — fail loud rather than silently no-op.
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION trg_fn_after_correction_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status_after = 'accepted' THEN
    UPDATE calendar_days
       SET corrected_text    = NEW.corrected_text,
           corrected_by      = NEW.editor_user_id,
           corrected_at      = NEW.created_at,
           correction_status = NEW.status_after,
           review_note       = NEW.review_note,
           updated_at        = NOW()
     WHERE id = NEW.day_id;

  ELSIF NEW.status_after IN ('pending', 'in_progress', 'flagged', 'illegible') THEN
    UPDATE calendar_days
       SET correction_status = NEW.status_after,
           review_note       = NEW.review_note,
           updated_at        = NOW()
     WHERE id = NEW.day_id;

  ELSE
    RAISE EXCEPTION
      'day_corrections.status_after must be one of (pending, in_progress, accepted, flagged, illegible); got %',
      NEW.status_after;
  END IF;

  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_after_correction_insert
  AFTER INSERT ON day_corrections
  FOR EACH ROW
  EXECUTE FUNCTION trg_fn_after_correction_insert();

-- ─────────────────────────────────────────────────────────────────
-- (d) trg_refresh_search_aux_text
--     Recomputes calendar_days.search_aux_text for the affected day from
--     tag labels + entity display names. Fires on day_tags and day_entities
--     AFTER INSERT/UPDATE/DELETE. Two subqueries (not a join) so a day with
--     both kinds of records doesn't get a cartesian-product duplication.
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION trg_fn_refresh_search_aux_text()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  target_day_id INT;
  aux_text      TEXT;
BEGIN
  target_day_id := COALESCE(NEW.day_id, OLD.day_id);

  SELECT
    COALESCE((
      SELECT string_agg(tag_label, ' ')
        FROM day_tags
       WHERE day_id = target_day_id
    ), '') || ' ' ||
    COALESCE((
      SELECT string_agg(e.display_name, ' ')
        FROM day_entities de
        JOIN entities e ON e.id = de.entity_id
       WHERE de.day_id = target_day_id
    ), '')
  INTO aux_text;

  UPDATE calendar_days
     SET search_aux_text = aux_text,
         updated_at      = NOW()
   WHERE id = target_day_id;

  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_refresh_search_aux_text_day_tags
  AFTER INSERT OR UPDATE OR DELETE ON day_tags
  FOR EACH ROW
  EXECUTE FUNCTION trg_fn_refresh_search_aux_text();

CREATE TRIGGER trg_refresh_search_aux_text_day_entities
  AFTER INSERT OR UPDATE OR DELETE ON day_entities
  FOR EACH ROW
  EXECUTE FUNCTION trg_fn_refresh_search_aux_text();
