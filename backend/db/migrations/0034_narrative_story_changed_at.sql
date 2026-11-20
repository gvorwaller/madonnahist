-- 0034_narrative_story_changed_at.sql
-- When did the family-visible story for a year last change? (Gaylon,
-- 2026-11-20: /admin/exports flags a PDF whose story has changed since it
-- was made.)
--
-- story_changed_at moves whenever the text changes OR the story is
-- published/unpublished: the book (and so every PDF with a narrative)
-- prints only a published story, so either one changes what a new PDF
-- would contain. Changing only source_draft_id, generated_by or
-- generated_at does not move it.
--
-- A trigger maintains it, so every writer (Use this, Edit by hand,
-- Publish, Unpublish, and anything added later) is covered, and nobody can
-- set it by hand: the trigger always overwrites the supplied value.

ALTER TABLE narrative_summaries ADD COLUMN story_changed_at TIMESTAMPTZ;

-- Backfill: the later of when the text was generated and the last audited
-- change to the row (use draft, hand edit, publish, unpublish; older rows
-- also logged their regenerate/unpublish actions against the same entity).
UPDATE narrative_summaries s
   SET story_changed_at = GREATEST(
         s.generated_at,
         COALESCE((SELECT MAX(a.occurred_at) FROM audit_log a
                    WHERE a.entity_type = 'narrative_summaries'
                      AND a.entity_id = s.id
                      AND a.action IN ('narrative_use_draft', 'narrative_edit', 'narrative_publish',
                                       'narrative_unpublish', 'narrative_unpublish_and_regenerate')),
                  s.generated_at));

ALTER TABLE narrative_summaries
  ALTER COLUMN story_changed_at SET DEFAULT NOW(),
  ALTER COLUMN story_changed_at SET NOT NULL;

CREATE FUNCTION narrative_summaries_story_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT'
     OR NEW.summary_text IS DISTINCT FROM OLD.summary_text
     OR NEW.is_published IS DISTINCT FROM OLD.is_published THEN
    NEW.story_changed_at := NOW();
  ELSE
    NEW.story_changed_at := OLD.story_changed_at;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_narrative_summaries_story_changed
  BEFORE INSERT OR UPDATE ON narrative_summaries
  FOR EACH ROW EXECUTE FUNCTION narrative_summaries_story_changed();
