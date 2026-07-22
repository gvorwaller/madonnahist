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
# Prereq: scripts/test-db-migrate.sh has applied 0021 on the isolated local
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
TRUNCATE narrative_summaries RESTART IDENTITY CASCADE;

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
# Test 2: worker UPDATE summary_text/generated_by/generated_at → succeeds
# (the columns migration 0021 actually grants — the upsert path the
# narrative_summary job type relies on).
# ─────────────────────────────────────────────────────────────────
out=$(psql_worker -v ON_ERROR_STOP=1 -tAc \
  "UPDATE narrative_summaries SET summary_text = 'Worker-updated text.', generated_by = 'test-model-v2', generated_at = NOW()
     WHERE scope='year' AND scope_key='1970';" 2>&1)
if [[ "$out" == "UPDATE 1" ]]; then
  green "worker UPDATE summary_text/generated_by/generated_at → succeeds"
else
  red "worker UPDATE summary_text/generated_by/generated_at should succeed but got: $out"
fi

updated_text=$(psql_owner -tAc "SELECT summary_text FROM narrative_summaries WHERE scope='year' AND scope_key='1970';")
if [[ "$updated_text" == "Worker-updated text." ]]; then
  green "summary_text reflects the worker's UPDATE"
else
  red "expected summary_text='Worker-updated text.' but got '$updated_text'"
fi

# ─────────────────────────────────────────────────────────────────
# Test 3: worker INSERT a fresh (scope, scope_key) row → allowed (table-level
# INSERT grant from 0004_grants_rls.sql, unaffected by this migration).
# ─────────────────────────────────────────────────────────────────
out=$(psql_worker -v ON_ERROR_STOP=1 -tAc \
  "INSERT INTO narrative_summaries (scope, scope_key, summary_text, generated_by, is_published)
     VALUES ('year', '1971', 'Fresh draft.', 'test-model-v1', false);" 2>&1)
if [[ "$out" == "INSERT 0 1" ]]; then
  green "worker INSERT narrative_summaries (fresh scope_key) → allowed"
else
  red "worker INSERT should succeed but got: $out"
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
echo "----"
echo "PASS: $PASS"
echo "FAIL: $FAIL"
[[ $FAIL -eq 0 ]]
