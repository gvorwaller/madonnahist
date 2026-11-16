-- 0031_user_removal.sql
-- Removing and deleting accounts (/admin/users, 2026-11-15).
--
-- "Remove access" keeps the account row (so everything the person added
-- keeps its author) but blocks sign-in: removed_at / removed_by.
--
-- "Delete permanently" is for throwaway accounts only, and the database
-- decides what counts as throwaway: every table of real content references
-- users with the default NO ACTION, so deleting an author fails with a
-- foreign-key error and the app refuses. New content tables (comments,
-- memories, ...) get that protection by declaring a plain FK to users.
--
-- Two FK changes make that rule exact:
--   audit_log.user_id         NO ACTION -> SET NULL. The activity log is a
--                             record, not content: a deleted account's sign-in
--                             lines stay, with the person blanked out.
--   place_locations.decided_by SET NULL -> NO ACTION. An admin's place-map
--                             decision is content; blanking it would let the
--                             automatic re-check overwrite it.
-- No grant changes: madonnahist_app already has table-level UPDATE and
-- DELETE on users.

ALTER TABLE users
  ADD COLUMN removed_at TIMESTAMPTZ,
  ADD COLUMN removed_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE audit_log
  DROP CONSTRAINT audit_log_user_id_fkey,
  ADD CONSTRAINT audit_log_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE place_locations
  DROP CONSTRAINT place_locations_decided_by_fkey,
  ADD CONSTRAINT place_locations_decided_by_fkey
    FOREIGN KEY (decided_by) REFERENCES users(id);
