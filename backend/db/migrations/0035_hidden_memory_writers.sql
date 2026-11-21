-- 0035_hidden_memory_writers.sql
-- A reader's choice to hide another writer's memories (td-76a40f, Gaylon
-- 2026-11-21). One row = "this signed-in person doesn't want to see this
-- writer's memories". Saved per account, so it follows them from phone to
-- laptop. Set from Your account or from the "Hide" button under a memory.
--
-- Rules (the app enforces the self rule; the CHECK enforces Madonna):
--   - Madonna (writer 1) can't be hidden: it's her history.
--   - Your own memories always show to you, even if a row says otherwise.
--   - Only shared memories are affected; drafts are only ever seen by their
--     author anyway.
-- A reading preference, not archive content: no audit_log rows.

CREATE TABLE hidden_memory_writers (
  user_id   INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  writer_id INT NOT NULL REFERENCES writers(id) ON DELETE CASCADE,
  hidden_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, writer_id),
  CHECK (writer_id <> 1)
);

-- 0004's default privileges grant app CRUD and worker SELECT on new tables.
-- The app needs SELECT/INSERT/DELETE (hide = insert, show = delete); workers
-- need nothing.
REVOKE ALL ON hidden_memory_writers FROM madonnahist_app, madonnahist_worker;
GRANT SELECT, INSERT, DELETE ON hidden_memory_writers TO madonnahist_app;
