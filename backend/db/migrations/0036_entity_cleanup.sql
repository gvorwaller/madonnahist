-- 0036_entity_cleanup.sql
-- Entities cleanup helper (td-c6e871, docs/2026-11-23-entity-cleanup-plan.md).
-- Three tables behind /admin/entities/cleanup:
--
--   entity_not_same        "these two are different", decided by the admin.
--                          Never suggested as duplicates again, and a merge
--                          that would join them is refused. Stored low id
--                          first. Carried to the survivor when one side is
--                          merged.
--   entity_cleanup_checks  Claude's answer to "is this the same as that?",
--                          one row per (main name, candidate). 'pending'
--                          while a paid call is in flight (so two tabs don't
--                          both pay), with a claim_token naming the request
--                          that holds it: only that request may store the
--                          answer or release the claim, so a request whose
--                          claim expired and was re-taken can't touch its
--                          successor's row. The fingerprint ties an answer
--                          to the exact names and days it saw, so a later
--                          rename, move or re-extraction can't revive it.
--   day_entity_blocks      "this day is not about this entity", left by
--                          moving a day's link elsewhere. The extractor
--                          rebuilds a day's AI links whenever the day is
--                          accepted again; it skips blocked entities (by
--                          canonical id), so a move stays moved. Always a
--                          canonical id; moved to the survivor on merge.
--                          RESTRICT: an entity with blocks can't be deleted
--                          (deleting it and re-extracting the same spelling
--                          would make a new id the block doesn't name).
--
-- Every admin decision here also writes an audit_log row (app code).

CREATE TABLE entity_not_same (
  entity_a    BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  entity_b    BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  decided_by  INT REFERENCES users(id) ON DELETE SET NULL,
  decided_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (entity_a, entity_b),
  CHECK (entity_a < entity_b)
);
CREATE INDEX idx_entity_not_same_b ON entity_not_same(entity_b);

CREATE TABLE entity_cleanup_checks (
  main_id       BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  candidate_id  BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  status        TEXT NOT NULL CHECK (status IN ('pending', 'done')),
  fingerprint   TEXT NOT NULL,
  verdict       TEXT CHECK (verdict IN ('same', 'different', 'unsure')),
  reason        TEXT CHECK (length(reason) <= 200),
  model         TEXT,
  checked_by    INT REFERENCES users(id) ON DELETE SET NULL,
  claim_token   TEXT,
  claimed_at    TIMESTAMPTZ,
  checked_at    TIMESTAMPTZ,
  PRIMARY KEY (main_id, candidate_id),
  CHECK (main_id <> candidate_id),
  -- A finished check always has its answer; a pending one never does.
  CHECK ((status = 'done') = (verdict IS NOT NULL AND checked_at IS NOT NULL)),
  CHECK (status <> 'pending' OR claim_token IS NOT NULL)
);
CREATE INDEX idx_entity_cleanup_checks_candidate ON entity_cleanup_checks(candidate_id);

CREATE TABLE day_entity_blocks (
  day_id      INT NOT NULL REFERENCES calendar_days(id) ON DELETE CASCADE,
  entity_id   BIGINT NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  blocked_by  INT REFERENCES users(id) ON DELETE SET NULL,
  blocked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (day_id, entity_id)
);
CREATE INDEX idx_day_entity_blocks_entity ON day_entity_blocks(entity_id);

-- ─────────────────────────────────────────────────────────────────
-- Grants. 0004's default privileges fire on these CREATE TABLEs (app:
-- SELECT/INSERT/UPDATE/DELETE; worker: SELECT). Revoke everything, then:
--   entity_not_same        app SELECT, INSERT, DELETE (decide, undo, carry
--                          on merge = delete + insert); worker nothing.
--   entity_cleanup_checks  app SELECT, INSERT, UPDATE, DELETE (claims and
--                          answers are upserts); worker nothing.
--   day_entity_blocks      app SELECT, INSERT, DELETE (move, move back,
--                          carry on merge = delete + insert); worker SELECT
--                          (the extractor reads a day's blocks).
-- ─────────────────────────────────────────────────────────────────
REVOKE ALL ON entity_not_same, entity_cleanup_checks, day_entity_blocks
  FROM madonnahist_app, madonnahist_worker;
GRANT SELECT, INSERT, DELETE ON entity_not_same TO madonnahist_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON entity_cleanup_checks TO madonnahist_app;
GRANT SELECT, INSERT, DELETE ON day_entity_blocks TO madonnahist_app;
GRANT SELECT ON day_entity_blocks TO madonnahist_worker;
