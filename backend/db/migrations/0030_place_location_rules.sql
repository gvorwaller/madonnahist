-- 0030_place_location_rules.sql
-- Places (td-085e19), after the first production run (2026-11-14).
--
-- rule_version: which version of the automatic matching rule
-- (src/lib/server/place-rules.ts RULE_VERSION) decided this row. When the
-- rule changes, rows decided automatically under an older version are
-- re-decided from their stored candidates, with no new Google call. Rows an
-- admin decided (decided_by set) are never re-decided.
--
-- Every row that exists today was decided by version 1, the first rule.
-- No grant changes: madonnahist_app already has UPDATE on the table.

ALTER TABLE place_locations
  ADD COLUMN rule_version SMALLINT NOT NULL DEFAULT 1;
