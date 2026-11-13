-- 0028_user_invites.sql
-- Family Viewer V3, Slice 1b (td-681a6d) — invite-link onboarding.
-- Plan: docs/2026-11-05-family-viewer-v3-redesign-plan.md §Invite-link onboarding.
--
-- An admin creates a viewer account and gets a one-time link
-- (/invite/<token>). The family member opens it, sets their own password and
-- display name, and is signed in. Nobody, including the admin, ever knows
-- the password.
--
-- The link is a bearer credential, so only a SHA-256 hash of the 32-byte
-- random token is stored. A link is good once, for 30 days (the session
-- window), and only for a viewer account that has never signed in: invites
-- are onboarding, and established accounts use the admin password reset.
--
-- Lifecycle columns:
--   used_at     set once, by the redeem transaction
--   revoked_at  set when the admin revokes or re-issues (re-issuing revokes
--               the outstanding link first)
-- At most one outstanding (unused, unrevoked) invite per user.

CREATE TABLE user_invites (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ,
  created_by  INT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (expires_at > created_at),
  CHECK (used_at IS NULL OR revoked_at IS NULL)
);

CREATE UNIQUE INDEX uq_user_invites_outstanding
  ON user_invites(user_id)
  WHERE used_at IS NULL AND revoked_at IS NULL;

-- ─────────────────────────────────────────────────────────────────
-- Grants
--
-- 0004's default privileges fire on this CREATE TABLE (app: SELECT/INSERT/
-- UPDATE/DELETE; worker: SELECT; both: sequence USAGE/SELECT/UPDATE). That
-- is far wider than intended, so revoke everything first, then grant only:
--   - madonnahist_app: SELECT, INSERT, and UPDATE of used_at/revoked_at.
--     It can never rewrite a token hash, owner, or expiry, and never
--     DELETE (history stays; a user delete cascades as the table owner).
--   - madonnahist_worker: nothing. No worker has any reason to see invites.
-- ─────────────────────────────────────────────────────────────────
REVOKE ALL ON user_invites FROM madonnahist_app, madonnahist_worker;
REVOKE ALL ON SEQUENCE user_invites_id_seq FROM madonnahist_app, madonnahist_worker;

GRANT SELECT, INSERT ON user_invites TO madonnahist_app;
GRANT UPDATE (used_at, revoked_at) ON user_invites TO madonnahist_app;
GRANT USAGE ON SEQUENCE user_invites_id_seq TO madonnahist_app;
