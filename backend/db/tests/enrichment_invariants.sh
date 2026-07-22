#!/bin/bash
# Migration 0020 (backend/db/migrations/0020_entity_enrichment.sql) acceptance
# criteria — Phase D of
# docs/2026-07-21-next-phases-search-viewer-narrative-plan.md. Follows the
# style of backend/db/tests/v4_invariants.sh: connect as each role, assert the
# expected outcome, exit non-zero on any miss.
#
# Usage:
#   backend/db/tests/enrichment_invariants.sh
#   backend/db/tests/enrichment_invariants.sh --env .env.test
#
# Prereq: scripts/test-db-migrate.sh has applied 0020 on the isolated local
# test DB.

set -uo pipefail
unset PGPASSWORD  # don't let an env-set PGPASSWORD override .pgpass

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=scripts/lib/test-env.sh
source "$REPO_ROOT/scripts/lib/test-env.sh"

ENV_ARG="$(parse_env_arg "$@")"
load_test_env "$ENV_ARG"
require_test_safety

PSQL_BIN="$(find_pg_bin psql)"
DB=(-h "$PGHOST" -p "$PGPORT" -d "$PGDATABASE")
OWNER=("${DB[@]}" -U "$MIGRATION_PGUSER")
APP=("${DB[@]}" -U "$PGUSER")
WORKER=("${DB[@]}" -U "$WORKER_PGUSER")

psql_owner() {
  PGPASSWORD="$MIGRATION_PGPASSWORD" "$PSQL_BIN" "${OWNER[@]}" "$@"
}

psql_app() {
  PGPASSWORD="$PGPASSWORD" "$PSQL_BIN" "${APP[@]}" "$@"
}

psql_worker() {
  PGPASSWORD="$WORKER_PGPASSWORD" "$PSQL_BIN" "${WORKER[@]}" "$@"
}

PASS=0
FAIL=0
green() { printf '\033[32m✔\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
red()   { printf '\033[31m✖\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }

# ─────────────────────────────────────────────────────────────────
# Setup: one user, one page, one day, one human day_tags row, one
# human day_entities row (needs an entities row first). Idempotent via
# TRUNCATE ... RESTART IDENTITY.
# ─────────────────────────────────────────────────────────────────
psql_owner -v ON_ERROR_STOP=1 -q <<'SQL'
TRUNCATE day_corrections, ocr_runs, llm_draft_runs, day_tags, day_entities,
         entities, correction_sessions, calendar_days, calendar_pages,
         narrative_summaries, audit_log, job_runs, sessions, users
  RESTART IDENTITY CASCADE;

INSERT INTO users (username, display_name, role, password_hash)
  VALUES ('test_corrector', 'Test', 'corrector', 'x');

INSERT INTO calendar_pages (year, month, page_image_path)
  VALUES (1968, 1, 'test/1968-01.tif');

INSERT INTO calendar_days (page_id, entry_date)
  VALUES (1, '1968-01-15');

INSERT INTO entities (slug, display_name, entity_type) VALUES
  ('grandma', 'Grandma', 'person'),
  ('marcus', 'Marcus', 'person');

INSERT INTO day_tags (day_id, tag_slug, tag_label, source)
  VALUES (1, 'human-tag', 'Human Tag', 'human');

-- entity_id=1 (Grandma) is human-sourced; entity_id=2 (Marcus) is left free
-- for the ai-sourced INSERT in test 1 below — day_entities' PK is
-- (day_id, entity_id), so an ai row can't coexist with a human row on the
-- SAME entity_id for the same day; they need distinct entity_ids.
INSERT INTO day_entities (day_id, entity_id, source)
  VALUES (1, 1, 'human');
SQL

# ─────────────────────────────────────────────────────────────────
# Test 1: worker INSERT day_entities source='human' → RLS blocked
# ─────────────────────────────────────────────────────────────────
out=$(psql_worker -v ON_ERROR_STOP=1 -tAc \
  "INSERT INTO day_entities (day_id, entity_id, source) VALUES (1, 2, 'human');" 2>&1)
if echo "$out" | grep -qE "(row-level security|row violates)"; then
  green "worker INSERT day_entities source='human' → RLS blocked"
else
  red "worker INSERT day_entities source='human' should fail RLS but got: $out"
fi

# Sanity: source='ai' still allowed (0004's original policy, unaffected by
# 0020). Uses entity_id=2 (Marcus) — distinct from the human row's
# entity_id=1 (Grandma), since day_entities' PK is (day_id, entity_id) and
# an ai row can't occupy the same slot as an existing human row.
out=$(psql_worker -v ON_ERROR_STOP=1 -tAc \
  "INSERT INTO day_entities (day_id, entity_id, source) VALUES (1, 2, 'ai');" 2>&1)
if [[ "$out" == "INSERT 0 1" ]]; then
  green "worker INSERT day_entities source='ai' → still allowed (0004 policy intact)"
else
  red "worker INSERT day_entities source='ai' should succeed but got: $out"
fi

# ─────────────────────────────────────────────────────────────────
# Test 2: worker DELETE of a source='human' day_tags row → 0 rows deleted
# ─────────────────────────────────────────────────────────────────
out=$(psql_worker -v ON_ERROR_STOP=1 -tAc \
  "DELETE FROM day_tags WHERE day_id = 1 AND tag_slug = 'human-tag';" 2>&1)
if [[ "$out" == "DELETE 0" ]]; then
  green "worker DELETE source='human' day_tags row → 0 rows deleted (RLS USING source='ai')"
else
  red "worker DELETE on human day_tags row should delete 0 rows but got: $out"
fi
still_there=$(psql_owner -tAc "SELECT COUNT(*) FROM day_tags WHERE day_id=1 AND tag_slug='human-tag';")
if [[ "$still_there" == "1" ]]; then
  green "human day_tags row still present after worker-issued DELETE"
else
  red "human day_tags row should survive but count='$still_there'"
fi

# ─────────────────────────────────────────────────────────────────
# Test 3: worker DELETE of a source='human' day_entities row → 0 rows deleted
# ─────────────────────────────────────────────────────────────────
out=$(psql_worker -v ON_ERROR_STOP=1 -tAc \
  "DELETE FROM day_entities WHERE day_id = 1 AND entity_id = 1 AND source = 'human';" 2>&1)
if [[ "$out" == "DELETE 0" ]]; then
  green "worker DELETE source='human' day_entities row → 0 rows deleted (RLS USING source='ai')"
else
  red "worker DELETE on human day_entities row should delete 0 rows but got: $out"
fi
still_there=$(psql_owner -tAc "SELECT COUNT(*) FROM day_entities WHERE day_id=1 AND entity_id=1 AND source='human';")
if [[ "$still_there" == "1" ]]; then
  green "human day_entities row still present after worker-issued DELETE"
else
  red "human day_entities row should survive but count='$still_there'"
fi

# Sanity: worker CAN delete its own AI-sourced day_entities row (entity_id=2,
# inserted by test 1)
out=$(psql_worker -v ON_ERROR_STOP=1 -tAc \
  "DELETE FROM day_entities WHERE day_id = 1 AND entity_id = 2 AND source = 'ai';" 2>&1)
if [[ "$out" == "DELETE 1" ]]; then
  green "worker DELETE source='ai' day_entities row → 1 row deleted (RLS allows it)"
else
  red "worker DELETE on its own ai day_entities row should delete 1 row but got: $out"
fi

# ─────────────────────────────────────────────────────────────────
# Test 4: entities UNIQUE(entity_type, slug) allows same slug across types
# ─────────────────────────────────────────────────────────────────
out=$(psql_owner -v ON_ERROR_STOP=1 -tAc \
  "INSERT INTO entities (slug, display_name, entity_type) VALUES ('jordan', 'Jordan', 'person');
   INSERT INTO entities (slug, display_name, entity_type) VALUES ('jordan', 'Jordan', 'place');" 2>&1)
if [[ -z "$out" || "$out" == "INSERT 0 1"*"INSERT 0 1"* || "$out" == *"INSERT 0 1"* ]]; then
  count=$(psql_owner -tAc "SELECT COUNT(*) FROM entities WHERE slug='jordan';")
  if [[ "$count" == "2" ]]; then
    green "UNIQUE(entity_type, slug) allows same slug 'jordan' as both person and place"
  else
    red "expected 2 entities rows with slug='jordan', got $count"
  fi
else
  red "same-slug-different-type insert should succeed but got: $out"
fi

# Same (entity_type, slug) pair a second time must still collide
out=$(psql_owner -v ON_ERROR_STOP=1 -tAc \
  "INSERT INTO entities (slug, display_name, entity_type) VALUES ('jordan', 'Jordan Again', 'person');" 2>&1)
if echo "$out" | grep -qE "duplicate key|unique constraint"; then
  green "UNIQUE(entity_type, slug) still rejects a duplicate (person, 'jordan') pair"
else
  red "duplicate (person, 'jordan') should violate the unique constraint but got: $out"
fi

# ─────────────────────────────────────────────────────────────────
# Test 5: accepted day_corrections insert auto-enqueues entity_extract,
#         deduped against an existing pending job for the same day
# ─────────────────────────────────────────────────────────────────
psql_app -v ON_ERROR_STOP=1 -q -c \
  "INSERT INTO day_corrections (day_id, corrected_text, status_after, editor_user_id) VALUES (1, 'Accepted text one.', 'accepted', 1);" > /dev/null
job_count=$(psql_owner -tAc "SELECT COUNT(*) FROM job_runs WHERE job_type='entity_extract' AND (payload->>'day_id')::int = 1;")
if [[ "$job_count" == "1" ]]; then
  green "accepted correction → exactly 1 entity_extract job enqueued"
else
  red "expected exactly 1 entity_extract job after first accept, got $job_count"
fi

# A second accept while the first job is still pending must NOT enqueue a
# second job (dedupe on an existing 'pending' entity_extract job).
psql_app -v ON_ERROR_STOP=1 -q -c \
  "INSERT INTO day_corrections (day_id, corrected_text, status_after, editor_user_id) VALUES (1, 'Accepted text two.', 'accepted', 1);" > /dev/null
job_count=$(psql_owner -tAc "SELECT COUNT(*) FROM job_runs WHERE job_type='entity_extract' AND (payload->>'day_id')::int = 1;")
if [[ "$job_count" == "1" ]]; then
  green "second accept with a pending job already queued → still exactly 1 job (deduped)"
else
  red "expected dedupe to keep exactly 1 job, got $job_count"
fi

# Once that job is done, a further accept enqueues a new one.
psql_owner -q -c "UPDATE job_runs SET status='done', completed_at=NOW() WHERE job_type='entity_extract' AND (payload->>'day_id')::int = 1;" > /dev/null
psql_app -v ON_ERROR_STOP=1 -q -c \
  "INSERT INTO day_corrections (day_id, corrected_text, status_after, editor_user_id) VALUES (1, 'Accepted text three.', 'accepted', 1);" > /dev/null
job_count=$(psql_owner -tAc "SELECT COUNT(*) FROM job_runs WHERE job_type='entity_extract' AND (payload->>'day_id')::int = 1;")
if [[ "$job_count" == "2" ]]; then
  green "accept after prior job completed → a new job is enqueued (2 total)"
else
  red "expected 2 total jobs after the prior one completed, got $job_count"
fi

# ─────────────────────────────────────────────────────────────────
echo "----"
echo "PASS: $PASS"
echo "FAIL: $FAIL"
[[ $FAIL -eq 0 ]]
