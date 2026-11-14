-- 0029_place_locations.sql
-- Places: map and directions links (td-085e19).
-- Plan: ~/.claude/plans (2026-11-14), summarized in
-- docs/2026-11-05-family-viewer-v3-redesign-plan.md §Places maps.
--
-- One row per canonical place entity that has been looked up. A Google
-- Places text search, biased toward Salt Lake City or Jacksonville by the
-- dates the place is mentioned, proposes a location; confident matches show
-- on the place page as Map / Apple Maps / Directions links, and the rest
-- wait on /admin/places. `entities` itself is untouched.
--
-- status:
--   auto          confident automatic match, shown to the family
--   confirmed     chosen or approved by an admin, shown
--   needs_review  weaker match, hidden until an admin decides
--   no_location   no map (reason says why), hidden
-- reason (no_location only):
--   general    a generic word or possessive name, never sent to Google
--   several    several strong matches far apart (a chain or common name)
--   not_found  the search found nothing close
--   admin      an admin chose "no map"

CREATE TABLE place_locations (
  entity_id        BIGINT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  status           TEXT NOT NULL CHECK (status IN ('auto', 'confirmed', 'needs_review', 'no_location')),
  reason           TEXT CHECK (reason IN ('general', 'several', 'not_found', 'admin')),
  lat              DOUBLE PRECISION CHECK (lat BETWEEN -90 AND 90),
  lon              DOUBLE PRECISION CHECK (lon BETWEEN -180 AND 180),
  google_place_id  TEXT,
  matched_name     TEXT,
  address          TEXT,
  region           TEXT CHECK (region IN ('utah', 'florida')),
  query            TEXT,
  looked_up_name   TEXT NOT NULL,
  score            REAL,
  candidates       JSONB NOT NULL DEFAULT '[]',
  looked_up_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_by       INT REFERENCES users(id) ON DELETE SET NULL,
  decided_at       TIMESTAMPTZ,
  CHECK ((lat IS NULL) = (lon IS NULL)),
  -- A shown place always has a point; a hidden "no map" never does.
  CHECK (status NOT IN ('auto', 'confirmed') OR lat IS NOT NULL),
  CHECK (status <> 'no_location' OR (lat IS NULL AND reason IS NOT NULL)),
  CHECK (status = 'no_location' OR reason IS NULL)
);

CREATE INDEX idx_place_locations_status ON place_locations(status);

-- ─────────────────────────────────────────────────────────────────
-- Grants
--
-- 0004's default privileges fire on this CREATE TABLE (app: SELECT/INSERT/
-- UPDATE/DELETE; worker: SELECT). Revoke everything first, then grant:
--   - madonnahist_app: SELECT, INSERT, UPDATE, DELETE. The web app runs the
--     lookups and the admin decisions ("Undo" deletes a row so the place is
--     looked up again).
--   - madonnahist_worker: nothing. No worker reads or writes locations.
-- ─────────────────────────────────────────────────────────────────
REVOKE ALL ON place_locations FROM madonnahist_app, madonnahist_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON place_locations TO madonnahist_app;
