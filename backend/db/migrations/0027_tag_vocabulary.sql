-- 0027_tag_vocabulary.sql
-- Family Viewer V3, Slice 1T (td-3418e6) — tag approval by tag NAME.
-- Plan: docs/2026-11-05-family-viewer-v3-redesign-plan.md §Slice 1T.
--
-- The enrichment worker suggests free-form AI tags (day_tags.source='ai');
-- the family viewer shows only human tags (td-06d79a). Confirming tags one
-- day at a time in the correction editor doesn't scale to thousands of rows,
-- so an admin decides once per tag slug here:
--   approved — shown to the family on every day carrying the slug, now and
--              for future AI suggestions with the same slug
--   hidden   — never shown (unless a person added it to a day themselves)
--   merged   — displayed as merged_into_slug, which must be an approved,
--              non-merged slug (one hop, no chains; enforced by the admin
--              actions in src/routes/admin/tags/+page.server.ts)
-- No row = undecided. "Undo" deletes the row.
--
-- day_tags.source is never rewritten by a vocabulary decision, so per-day
-- provenance (person vs AI) stays honest.

CREATE TABLE tag_vocabulary (
  id               BIGSERIAL PRIMARY KEY,
  tag_slug         TEXT NOT NULL UNIQUE
                   CHECK (tag_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(tag_slug) <= 40),
  label            TEXT NOT NULL
                   CHECK (length(btrim(label)) BETWEEN 1 AND 40),
  status           TEXT NOT NULL CHECK (status IN ('approved', 'hidden', 'merged')),
  merged_into_slug TEXT REFERENCES tag_vocabulary(tag_slug),
  decided_by       INT REFERENCES users(id),
  decided_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((status = 'merged') = (merged_into_slug IS NOT NULL)),
  CHECK (merged_into_slug IS DISTINCT FROM tag_slug)
);

CREATE INDEX idx_tag_vocabulary_merged_into ON tag_vocabulary(merged_into_slug)
  WHERE merged_into_slug IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────
-- Grants
--
-- 0004's default privileges fire on this CREATE TABLE (app: SELECT/INSERT/
-- UPDATE/DELETE; worker: SELECT; both: sequence USAGE/SELECT/UPDATE).
-- Intended surface:
--   - madonnahist_app: the /admin/tags actions INSERT/UPDATE decisions and
--     DELETE for Undo; every viewer query SELECTs. The defaults already
--     match, so they are restated explicitly rather than left to accident.
--   - madonnahist_worker: SELECT only — the enrichment worker reads the
--     approved labels as preferred vocabulary for its prompt. It must never
--     write a decision.
-- ─────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON tag_vocabulary TO madonnahist_app;
GRANT USAGE, SELECT ON SEQUENCE tag_vocabulary_id_seq TO madonnahist_app;

GRANT SELECT ON tag_vocabulary TO madonnahist_worker;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON tag_vocabulary FROM madonnahist_worker;
REVOKE USAGE, SELECT, UPDATE ON SEQUENCE tag_vocabulary_id_seq FROM madonnahist_worker;
