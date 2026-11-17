-- 0032_writers_and_memories.sql
-- Writers groundwork (td-ef00c8, cheap part) and first-person memories
-- (td-bc2c29 / td-76a40f, first slice). Plan:
-- docs/2026-11-16-writers-and-memories-plan.md (peer-reviewed by CODEX, AGY2).
--
-- writers           one row per voice in the archive. user_id links a writer
--                   to a sign-in account (null for someone who isn't a user,
--                   e.g. a late relative whose journals get scanned).
--                   adds_memories says whether that account may add memories
--                   in the viewer (Madonna's come from /correct instead).
-- calendar_pages    gains writer_id; every existing page is Madonna's (id 1).
--                   UNIQUE (year, month) deliberately stays: a second
--                   handwritten calendar changes it to (writer_id, year,
--                   month) when that source actually arrives, along with the
--                   one-per-date rule on calendar_days and writer-aware OCR.
-- memories          first-person memories, for a day, a month or a year.
--                   writer_id = whose memory; created_by = who typed it (so a
--                   memory dictated by Madonna can be typed by Gaylon).
--                   shared_at NULL = a draft only its author can see.
--                   created_by is a plain FK (NO ACTION): anyone who wrote a
--                   memory can't be hard-deleted (see 0031).
-- memory_revisions  private, append-only copy of the text at every save,
--                   share, unshare and delete. The generic audit_log row is
--                   metadata only: workers can read audit_log (0004) and
--                   /admin/audit shows before/after values, so draft text
--                   must never go there (CODEX #1). No FK on memory_id, so
--                   the history survives a delete.

CREATE TABLE writers (
  id            SERIAL PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]+$'),
  display_name  TEXT NOT NULL CHECK (btrim(display_name) <> ''),
  user_id       INT UNIQUE REFERENCES users(id),
  adds_memories BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO writers (id, slug, display_name, user_id, adds_memories)
VALUES (1, 'madonna', 'Madonna', (SELECT id FROM users WHERE username = 'madonna'), FALSE);

-- The explicit id 1 doesn't advance the sequence; move it past 1 first.
SELECT setval('writers_id_seq', 1);

INSERT INTO writers (slug, display_name, user_id, adds_memories)
SELECT 'gaylon', 'Gaylon', (SELECT id FROM users WHERE username = 'gaylon'), TRUE;

ALTER TABLE calendar_pages
  ADD COLUMN writer_id INT NOT NULL DEFAULT 1 REFERENCES writers(id);

CREATE TABLE memories (
  id             SERIAL PRIMARY KEY,
  writer_id      INT NOT NULL REFERENCES writers(id),
  created_by     INT NOT NULL REFERENCES users(id),
  memory_date    DATE NOT NULL,
  date_precision TEXT NOT NULL CHECK (date_precision IN ('day', 'month', 'year')),
  body           TEXT NOT NULL CHECK (btrim(body) <> '' AND char_length(body) <= 10000),
  shared_at      TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fts tsvector GENERATED ALWAYS AS (to_tsvector('english', body)) STORED,
  -- A month memory is dated the 1st; a year memory January 1.
  CHECK (date_precision = 'day' OR EXTRACT(DAY FROM memory_date) = 1),
  CHECK (date_precision <> 'year' OR EXTRACT(MONTH FROM memory_date) = 1)
);

CREATE INDEX idx_memories_shared_date ON memories (memory_date) WHERE shared_at IS NOT NULL;
CREATE INDEX idx_memories_created_by ON memories (created_by, memory_date);
CREATE INDEX idx_memories_fts ON memories USING gin (fts);

CREATE TABLE memory_revisions (
  id             SERIAL PRIMARY KEY,
  memory_id      INT NOT NULL,
  action         TEXT NOT NULL CHECK (action IN ('create', 'edit', 'share', 'unshare', 'delete')),
  writer_id      INT NOT NULL,
  memory_date    DATE NOT NULL,
  date_precision TEXT NOT NULL,
  body           TEXT NOT NULL,
  shared         BOOLEAN NOT NULL,
  revised_by     INT NOT NULL REFERENCES users(id),
  revised_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_memory_revisions_memory ON memory_revisions (memory_id, revised_at);

-- ─────────────────────────────────────────────────────────────────
-- Grants
--
-- 0004's default privileges fire on these CREATE TABLEs (app: SELECT/
-- INSERT/UPDATE/DELETE; worker: SELECT) and on their sequences (both roles:
-- USAGE/SELECT/UPDATE). Revoke tables AND sequences first (CODEX #7), then:
--   - madonnahist_app: SELECT on writers (no admin page yet); full CRUD on
--     memories; SELECT/INSERT only on memory_revisions (append-only);
--     USAGE (nextval) on the two sequences it inserts with.
--   - madonnahist_worker: nothing. Workers get a narrow, shared-only grant
--     when enrichment or narratives start reading memories.
-- calendar_pages keeps its existing grants; the new column is covered by
-- the table-level privileges both roles already hold.
-- ─────────────────────────────────────────────────────────────────
REVOKE ALL ON writers, memories, memory_revisions FROM madonnahist_app, madonnahist_worker;
REVOKE ALL ON SEQUENCE writers_id_seq, memories_id_seq, memory_revisions_id_seq
  FROM madonnahist_app, madonnahist_worker;

GRANT SELECT ON writers TO madonnahist_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON memories TO madonnahist_app;
GRANT SELECT, INSERT ON memory_revisions TO madonnahist_app;
GRANT USAGE ON SEQUENCE memories_id_seq, memory_revisions_id_seq TO madonnahist_app;
