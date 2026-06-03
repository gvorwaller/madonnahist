-- Migration 0013: Revoke DELETE on correction_lexicon from app role.
--
-- Migration 0004 default privileges grant DELETE on all future tables to
-- madonnahist_app. The correction_lexicon is auto-populated from accepted
-- corrections and should only grow — the app role must not delete learned
-- substitution pairs. (Codex review finding P2.)

REVOKE DELETE ON correction_lexicon FROM madonnahist_app;
