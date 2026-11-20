#!/bin/bash
# Migration 0021 (backend/db/migrations/0021_narrative_worker_grants.sql)
# acceptance criteria — Phase E of
# docs/2026-07-21-next-phases-search-viewer-narrative-plan.md. Follows the
# style of backend/db/tests/enrichment_invariants.sh: connect as each role,
# assert the expected outcome, exit non-zero on any miss.
#
# This is the DB-layer half of the CRITICAL "worker never writes to a
# published row — no force override" invariant: the worker-side guard in
# backend/workers/enrichment-worker.ts (checked before ever calling the LLM)
# is exercised end-to-end by scripts/test-narratives.mjs; this script proves
# the same invariant holds even if that guard had a bug, by asserting the
# grant itself at the Postgres privilege layer.
#
# Usage:
#   backend/db/tests/narrative_invariants.sh
#   backend/db/tests/narrative_invariants.sh --env .env.test
#
# Since 0033 (td-f1f49b) the worker may not write narrative_summaries at all;
# it appends candidates to narrative_drafts and the admin promotes one.
#
# Prereq: scripts/test-db-migrate.sh has applied 0021 and 0033 on the isolated local
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
# Setup: one draft narrative_summaries row for a fixture year. Idempotent via
# TRUNCATE ... RESTART IDENTITY — narrative_summaries has no incoming FKs, so
# CASCADE is a no-op beyond the table itself.
# ─────────────────────────────────────────────────────────────────
psql_owner -v ON_ERROR_STOP=1 -q <<'SQL'
TRUNCATE narrative_summaries, narrative_drafts, narrative_guidance RESTART IDENTITY CASCADE;

INSERT INTO narrative_summaries (scope, scope_key, summary_text, generated_by, is_published)
  VALUES ('year', '1970', 'Initial draft text.', 'test-model-v1', false);
SQL

# ─────────────────────────────────────────────────────────────────
# Test 1: worker UPDATE is_published=true → rejected (column not granted).
# This is the CRITICAL assertion for this migration.
# ─────────────────────────────────────────────────────────────────
out=$(psql_worker -v ON_ERROR_STOP=1 -tAc \
  "UPDATE narrative_summaries SET is_published = true WHERE scope='year' AND scope_key='1970';" 2>&1)
if echo "$out" | grep -qE "permission denied"; then
  green "worker UPDATE is_published=true → rejected (column not granted)"
else
  red "worker UPDATE is_published should be rejected but got: $out"
fi

still_unpublished=$(psql_owner -tAc "SELECT is_published FROM narrative_summaries WHERE scope='year' AND scope_key='1970';")
if [[ "$still_unpublished" == "f" ]]; then
  green "is_published remains false after the rejected worker UPDATE attempt"
else
  red "is_published should remain false but got '$still_unpublished'"
fi

# ─────────────────────────────────────────────────────────────────
# Test 2 (flipped by 0033): worker UPDATE summary_text → now DENIED. Since
# td-f1f49b the worker only writes candidates to narrative_drafts; the
# admin's "Use this" is the only path into narrative_summaries.
# ─────────────────────────────────────────────────────────────────
out=$(psql_worker -v ON_ERROR_STOP=1 -tAc \
  "UPDATE narrative_summaries SET summary_text = 'Worker-updated text.', generated_by = 'test-model-v2', generated_at = NOW()
     WHERE scope='year' AND scope_key='1970';" 2>&1)
if echo "$out" | grep -qE "permission denied"; then
  green "worker UPDATE summary_text → rejected (0033 revoked 0021's column grant)"
else
  red "worker UPDATE summary_text should be rejected but got: $out"
fi

unchanged_text=$(psql_owner -tAc "SELECT summary_text FROM narrative_summaries WHERE scope='year' AND scope_key='1970';")
if [[ "$unchanged_text" == "Initial draft text." ]]; then
  green "summary_text unchanged after the rejected worker UPDATE"
else
  red "expected summary_text='Initial draft text.' but got '$unchanged_text'"
fi

# ─────────────────────────────────────────────────────────────────
# Test 3 (flipped by 0033): worker INSERT into narrative_summaries → DENIED.
# ─────────────────────────────────────────────────────────────────
out=$(psql_worker -v ON_ERROR_STOP=1 -tAc \
  "INSERT INTO narrative_summaries (scope, scope_key, summary_text, generated_by, is_published)
     VALUES ('year', '1971', 'Fresh draft.', 'test-model-v1', false);" 2>&1)
if echo "$out" | grep -qE "permission denied"; then
  green "worker INSERT narrative_summaries → rejected"
else
  red "worker INSERT narrative_summaries should be rejected but got: $out"
fi

# ─────────────────────────────────────────────────────────────────
# Test 4: app role — full UPDATE including is_published is allowed (0004's
# blanket app grant on all tables, no column-level REVOKE for this table).
# This is the only path that can publish/unpublish, per Phase E.
# ─────────────────────────────────────────────────────────────────
out=$(psql_app -v ON_ERROR_STOP=1 -tAc \
  "UPDATE narrative_summaries SET is_published = true WHERE scope='year' AND scope_key='1970';" 2>&1)
if [[ "$out" == "UPDATE 1" ]]; then
  green "app UPDATE is_published=true → allowed"
else
  red "app UPDATE is_published should succeed but got: $out"
fi

now_published=$(psql_owner -tAc "SELECT is_published FROM narrative_summaries WHERE scope='year' AND scope_key='1970';")
if [[ "$now_published" == "t" ]]; then
  green "is_published reflects the app role's UPDATE"
else
  red "expected is_published=true after app UPDATE but got '$now_published'"
fi

# ─────────────────────────────────────────────────────────────────
# Test 5 (belt-and-suspenders): worker UPDATE is_published on the NOW-
# published row is still rejected — the grant is column-scoped, not
# conditional on current row state. This is what makes "no force override"
# true regardless of a row's current publish status.
# ─────────────────────────────────────────────────────────────────
out=$(psql_worker -v ON_ERROR_STOP=1 -tAc \
  "UPDATE narrative_summaries SET is_published = false WHERE scope='year' AND scope_key='1970';" 2>&1)
if echo "$out" | grep -qE "permission denied"; then
  green "worker UPDATE is_published on an already-published row → still rejected"
else
  red "worker UPDATE is_published on a published row should be rejected but got: $out"
fi

still_published=$(psql_owner -tAc "SELECT is_published FROM narrative_summaries WHERE scope='year' AND scope_key='1970';")
if [[ "$still_published" == "t" ]]; then
  green "published row stays published after the rejected worker UPDATE attempt"
else
  red "is_published should remain true but got '$still_published'"
fi

# ─────────────────────────────────────────────────────────────────
# narrative_drafts / narrative_guidance (0033, td-f1f49b)
# ─────────────────────────────────────────────────────────────────
expect_ok() { # label, expected-prefix, output
  if [[ "$3" == "$2"* ]]; then green "$1"; else red "$1 — got: $3"; fi
}
expect_denied() { # label, output
  if echo "$2" | grep -qE "permission denied"; then green "$1"; else red "$1 — got: $2"; fi
}

out=$(psql_worker -v ON_ERROR_STOP=1 -tAc \
  "INSERT INTO narrative_drafts (scope, scope_key, model_name, provider, mode, draft_text, day_count, job_run_id)
     VALUES ('year', '1970', 'test-model', 'anthropic', 'fresh', 'Candidate text.', 3, 990001) RETURNING id;" 2>&1)
draft_id=$(echo "$out" | head -1)
if [[ "$draft_id" =~ ^[0-9]+$ ]]; then
  green "worker INSERT narrative_drafts → allowed"
else
  red "worker INSERT narrative_drafts should succeed but got: $out"
fi

out=$(psql_worker -v ON_ERROR_STOP=1 -tAc "UPDATE narrative_drafts SET draft_text = 'x' WHERE id = ${draft_id:-0};" 2>&1)
expect_denied "worker UPDATE narrative_drafts → rejected (append-only)" "$out"
out=$(psql_worker -v ON_ERROR_STOP=1 -tAc "DELETE FROM narrative_drafts WHERE id = ${draft_id:-0};" 2>&1)
expect_denied "worker DELETE narrative_drafts → rejected (append-only)" "$out"

out=$(psql_app -v ON_ERROR_STOP=1 -tAc "SELECT count(*) FROM narrative_drafts;" 2>&1)
if [[ "$out" =~ ^[0-9]+$ ]]; then green "app SELECT narrative_drafts → allowed"; else red "app SELECT narrative_drafts should succeed but got: $out"; fi
out=$(psql_worker -v ON_ERROR_STOP=1 -tAc \
  "INSERT INTO narrative_drafts (scope, scope_key, model_name, provider, mode, draft_text, job_run_id)
     VALUES ('year', '1970', 'test-model', 'anthropic', 'fresh', 'Second try.', 990001);" 2>&1)
if echo "$out" | grep -qE "duplicate key"; then
  green "a second draft for the same job_run_id → rejected (UNIQUE)"
else
  red "a second draft for the same job should violate UNIQUE but got: $out"
fi
out=$(psql_worker -v ON_ERROR_STOP=1 -tAc \
  "INSERT INTO narrative_drafts (scope, scope_key, model_name, provider, mode, draft_text)
     VALUES ('year', '1970', 'test-model', 'anthropic', 'fresh', 'No job.');" 2>&1)
if echo "$out" | grep -qE "violates check constraint"; then
  green "generated draft without job_run_id → rejected by CHECK"
else
  red "generated draft without job_run_id should violate the CHECK but got: $out"
fi

# The app adds a draft for each hand edit, so replacing an edit never loses it.
out=$(psql_app -v ON_ERROR_STOP=1 -tAc \
  "INSERT INTO narrative_drafts (scope, scope_key, model_name, provider, mode, draft_text)
     VALUES ('year', '1970', 'hand-edit', 'human', 'edit', 'Edited.');" 2>&1)
expect_ok "app INSERT narrative_drafts (hand edit) → allowed" "INSERT 0 1" "$out"
out=$(psql_app -v ON_ERROR_STOP=1 -tAc \
  "INSERT INTO narrative_drafts (scope, scope_key, model_name, provider, mode, draft_text)
     VALUES ('year', '1970', 'hand-edit', 'human', 'fresh', 'x');" 2>&1)
if echo "$out" | grep -qE "violates check constraint"; then
  green "human provider with a non-edit mode → rejected by CHECK"
else
  red "provider 'human' with mode 'fresh' should violate the CHECK but got: $out"
fi
out=$(psql_app -v ON_ERROR_STOP=1 -tAc "UPDATE narrative_drafts SET draft_text = 'x' WHERE id = ${draft_id:-0};" 2>&1)
expect_denied "app UPDATE narrative_drafts → rejected" "$out"
out=$(psql_app -v ON_ERROR_STOP=1 -tAc "DELETE FROM narrative_drafts WHERE id = ${draft_id:-0};" 2>&1)
expect_denied "app DELETE narrative_drafts → rejected" "$out"

out=$(psql_owner -v ON_ERROR_STOP=1 -tAc \
  "INSERT INTO narrative_drafts (scope, scope_key, model_name, provider, mode, draft_text, job_run_id)
     VALUES ('year', '1970', 'm', 'anthropic', 'revise', 'x', 990002);" 2>&1)
if echo "$out" | grep -qE "violates check constraint"; then
  green "revise draft without base_text → rejected by CHECK"
else
  red "revise draft without base_text should violate the CHECK but got: $out"
fi

out=$(psql_app -v ON_ERROR_STOP=1 -tAc \
  "INSERT INTO narrative_guidance (scope, scope_key, guidance_text) VALUES ('year', '1970', 'Notes.');" 2>&1)
expect_ok "app INSERT narrative_guidance → allowed" "INSERT 0 1" "$out"
out=$(psql_app -v ON_ERROR_STOP=1 -tAc \
  "UPDATE narrative_guidance SET guidance_text = 'More notes.' WHERE scope='year' AND scope_key='1970';" 2>&1)
expect_ok "app UPDATE narrative_guidance → allowed" "UPDATE 1" "$out"
out=$(psql_worker -v ON_ERROR_STOP=1 -tAc "SELECT guidance_text FROM narrative_guidance WHERE scope_key='1970';" 2>&1)
expect_ok "worker SELECT narrative_guidance → allowed" "More notes." "$out"
out=$(psql_worker -v ON_ERROR_STOP=1 -tAc \
  "UPDATE narrative_guidance SET guidance_text = 'w' WHERE scope_key='1970';" 2>&1)
expect_denied "worker UPDATE narrative_guidance → rejected" "$out"

out=$(psql_app -v ON_ERROR_STOP=1 -tAc \
  "UPDATE narrative_summaries SET source_draft_id = ${draft_id:-0} WHERE scope='year' AND scope_key='1970';" 2>&1)
expect_ok "app UPDATE narrative_summaries.source_draft_id → allowed" "UPDATE 1" "$out"

# ─────────────────────────────────────────────────────────────────
# story_changed_at (0034): moves on text or publish changes only, and
# can't be set by hand.
# ─────────────────────────────────────────────────────────────────
psql_owner -tAc "UPDATE narrative_summaries SET story_changed_at = '2000-01-01' WHERE scope='year' AND scope_key='1970';" >/dev/null 2>&1
t0=$(psql_owner -tAc "SELECT story_changed_at FROM narrative_summaries WHERE scope='year' AND scope_key='1970';")
if [[ "$t0" != 2000-01-01* ]]; then green "story_changed_at can't be set by hand (trigger keeps it)"; else red "story_changed_at was set by hand to $t0"; fi
psql_app -tAc "UPDATE narrative_summaries SET generated_by = 'other-model' WHERE scope='year' AND scope_key='1970';" >/dev/null
t1=$(psql_owner -tAc "SELECT story_changed_at FROM narrative_summaries WHERE scope='year' AND scope_key='1970';")
if [[ "$t1" == "$t0" ]]; then green "a change that isn't text or publish leaves story_changed_at alone"; else red "story_changed_at moved on a generated_by change ($t0 → $t1)"; fi
psql_app -tAc "UPDATE narrative_summaries SET summary_text = summary_text || ' more' WHERE scope='year' AND scope_key='1970';" >/dev/null
t2=$(psql_owner -tAc "SELECT story_changed_at > '$t1'::timestamptz FROM narrative_summaries WHERE scope='year' AND scope_key='1970';")
if [[ "$t2" == "t" ]]; then green "a text change moves story_changed_at"; else red "story_changed_at didn't move on a text change"; fi
t3=$(psql_owner -tAc "SELECT story_changed_at FROM narrative_summaries WHERE scope='year' AND scope_key='1970';")
psql_app -tAc "UPDATE narrative_summaries SET is_published = NOT is_published WHERE scope='year' AND scope_key='1970';" >/dev/null
t4=$(psql_owner -tAc "SELECT story_changed_at > '$t3'::timestamptz FROM narrative_summaries WHERE scope='year' AND scope_key='1970';")
if [[ "$t4" == "t" ]]; then green "publishing or unpublishing moves story_changed_at"; else red "story_changed_at didn't move on a publish change"; fi

# ─────────────────────────────────────────────────────────────────
echo "----"
echo "PASS: $PASS"
echo "FAIL: $FAIL"
[[ $FAIL -eq 0 ]]
