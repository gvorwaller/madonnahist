#!/bin/bash
# Run the V4 § 6.1 / § 8 acceptance criteria as actual SQL tests.
# Connects as each role and asserts the expected outcome (success or
# specific failure mode). Exits non-zero on any assertion miss.
#
# Usage:
#   backend/db/tests/v4_invariants.sh
#   backend/db/tests/v4_invariants.sh --env .env.test
#
# Prereq: scripts/test-db-migrate.sh has prepared the isolated local test DB.

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
# Setup: seed one user, one page, one day. Idempotent.
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
SQL

# ─────────────────────────────────────────────────────────────────
# Test 1: worker UPDATE calendar_days.corrected_text → permission denied
# ─────────────────────────────────────────────────────────────────
out=$(psql_worker -v ON_ERROR_STOP=1 -tAc \
  "UPDATE calendar_days SET corrected_text = 'hacked' WHERE id = 1;" 2>&1)
if echo "$out" | grep -q "permission denied"; then
  green "worker UPDATE corrected_text → permission denied"
else
  red "worker UPDATE corrected_text should fail but got: $out"
fi

# ─────────────────────────────────────────────────────────────────
# Test 2: worker INSERT day_tags (source='human') → RLS WITH CHECK
# ─────────────────────────────────────────────────────────────────
out=$(psql_worker -v ON_ERROR_STOP=1 -tAc \
  "INSERT INTO day_tags (day_id, tag_slug, tag_label, source) VALUES (1, 'birthday', 'Birthday', 'human');" 2>&1)
if echo "$out" | grep -qE "(row-level security|row violates)"; then
  green "worker INSERT day_tags source='human' → RLS blocked"
else
  red "worker INSERT day_tags source='human' should fail RLS but got: $out"
fi

# Sanity: same INSERT with source='ai' should succeed
out=$(psql_worker -v ON_ERROR_STOP=1 -tAc \
  "INSERT INTO day_tags (day_id, tag_slug, tag_label, source) VALUES (1, 'birthday', 'Birthday', 'ai');" 2>&1)
if [[ -z "$out" || "$out" == "INSERT 0 1" ]]; then
  green "worker INSERT day_tags source='ai' → allowed (RLS WITH CHECK passed)"
else
  red "worker INSERT day_tags source='ai' should succeed but got: $out"
fi

# Verify trigger d) refreshed search_aux_text from the new tag
aux=$(psql_owner -tAc "SELECT search_aux_text FROM calendar_days WHERE id=1;")
if [[ "$aux" == *"Birthday"* ]]; then
  green "trg_refresh_search_aux_text picked up new day_tag label"
else
  red "search_aux_text should contain 'Birthday' but got: '$aux'"
fi

# ─────────────────────────────────────────────────────────────────
# Test 3: low-confidence OCR run flips pending day → flagged
# ─────────────────────────────────────────────────────────────────
psql_worker -v ON_ERROR_STOP=1 -q -c \
  "INSERT INTO ocr_runs (day_id, vendor, source_image_path, raw_text, confidence_score)
   VALUES (1, 'test', 'x.tif', 'unclear scribble', 0.2);" > /dev/null
status=$(psql_owner -tAc "SELECT correction_status FROM calendar_days WHERE id=1;")
note=$(psql_owner -tAc "SELECT review_note FROM calendar_days WHERE id=1;")
if [[ "$status" == "flagged" && "$note" == "auto-flagged: low OCR confidence" ]]; then
  green "low-confidence OCR (0.2 < 0.4) → status='flagged' + auto-flag note"
else
  red "expected flagged + auto-flag note, got status='$status' note='$note'"
fi

# Also verify latest_ocr_run_id + latest_confidence_score were set
ocr_id=$(psql_owner -tAc "SELECT latest_ocr_run_id FROM calendar_days WHERE id=1;")
conf=$(psql_owner -tAc "SELECT latest_confidence_score FROM calendar_days WHERE id=1;")
if [[ -n "$ocr_id" && "$conf" == "0.2" ]]; then
  green "trg_after_ocr_run_insert set latest_ocr_run_id=$ocr_id, confidence=$conf"
else
  red "latest_ocr_run_id='$ocr_id' or confidence='$conf' wrong"
fi

# Reset the day to pending before the next test (high-confidence path)
psql_owner -q -c "UPDATE calendar_days SET correction_status='pending', review_note=NULL WHERE id=1;" > /dev/null

# High-confidence OCR should NOT auto-flag a pending day
psql_worker -q -c \
  "INSERT INTO ocr_runs (day_id, vendor, source_image_path, raw_text, confidence_score)
   VALUES (1, 'test', 'x.tif', 'clear text', 0.95);" > /dev/null
status=$(psql_owner -tAc "SELECT correction_status FROM calendar_days WHERE id=1;")
if [[ "$status" == "pending" ]]; then
  green "high-confidence OCR (0.95 ≥ 0.4) → status stays pending"
else
  red "high-confidence OCR should leave status pending, got '$status'"
fi

# ─────────────────────────────────────────────────────────────────
# Test 4: app UPDATE calendar_days.corrected_text → permission denied
# ─────────────────────────────────────────────────────────────────
out=$(psql_app -v ON_ERROR_STOP=1 -tAc \
  "UPDATE calendar_days SET corrected_text = 'app-hacked' WHERE id = 1;" 2>&1)
if echo "$out" | grep -q "permission denied"; then
  green "app UPDATE corrected_text → permission denied"
else
  red "app UPDATE corrected_text should fail but got: $out"
fi

# Sanity: app CAN update a non-protected column (session tracking)
out=$(psql_app -v ON_ERROR_STOP=1 -tAc \
  "UPDATE calendar_days SET last_opened_by = 1, last_opened_at = NOW() WHERE id = 1;" 2>&1)
if [[ "$out" == "UPDATE 1" ]]; then
  green "app UPDATE last_opened_* → allowed (column-level grant intact)"
else
  red "app UPDATE last_opened_* should succeed but got: $out"
fi

# ─────────────────────────────────────────────────────────────────
# Test 5: app INSERT day_corrections status_after='in_progress' → status only,
#         NOT corrected_text
# ─────────────────────────────────────────────────────────────────
psql_app -q -c \
  "INSERT INTO day_corrections (day_id, corrected_text, status_after, editor_user_id)
   VALUES (1, 'half-typed draft', 'in_progress', 1);" > /dev/null
status=$(psql_owner -tAc "SELECT correction_status FROM calendar_days WHERE id=1;")
text=$(psql_owner -tAc "SELECT corrected_text FROM calendar_days WHERE id=1;")
by=$(psql_owner -tAc "SELECT corrected_by FROM calendar_days WHERE id=1;")
if [[ "$status" == "in_progress" && -z "$text" && -z "$by" ]]; then
  green "in_progress correction → status updated, corrected_text/by unchanged"
else
  red "in_progress: status='$status' text='$text' by='$by' (expected status=in_progress, text NULL, by NULL)"
fi

# ─────────────────────────────────────────────────────────────────
# Test 6: app INSERT day_corrections status_after='accepted' → propagates
# ─────────────────────────────────────────────────────────────────
psql_app -q -c \
  "INSERT INTO day_corrections (day_id, corrected_text, status_after, editor_user_id)
   VALUES (1, 'Visited Grandma. Beautiful day.', 'accepted', 1);" > /dev/null
status=$(psql_owner -tAc "SELECT correction_status FROM calendar_days WHERE id=1;")
text=$(psql_owner -tAc "SELECT corrected_text FROM calendar_days WHERE id=1;")
by=$(psql_owner -tAc "SELECT corrected_by FROM calendar_days WHERE id=1;")
at=$(psql_owner -tAc "SELECT corrected_at FROM calendar_days WHERE id=1;")
if [[ "$status" == "accepted" && "$text" == "Visited Grandma. Beautiful day." \
      && "$by" == "1" && -n "$at" ]]; then
  green "accepted correction → corrected_text/by/at propagated, status=accepted"
else
  red "accepted: status='$status' text='$text' by='$by' at='$at'"
fi

# ─────────────────────────────────────────────────────────────────
# Test 7: app DELETE on history table → permission denied
# ─────────────────────────────────────────────────────────────────
out=$(psql_app -v ON_ERROR_STOP=1 -tAc \
  "DELETE FROM day_corrections WHERE id = 1;" 2>&1)
if echo "$out" | grep -q "permission denied"; then
  green "app DELETE day_corrections → permission denied (history append-only)"
else
  red "app DELETE day_corrections should fail but got: $out"
fi

# ─────────────────────────────────────────────────────────────────
# Test 8: bad status_after value → trigger raises
# ─────────────────────────────────────────────────────────────────
out=$(psql_app -v ON_ERROR_STOP=1 -tAc \
  "INSERT INTO day_corrections (day_id, corrected_text, status_after, editor_user_id)
   VALUES (1, 'x', 'bogus_status', 1);" 2>&1)
if echo "$out" | grep -q "status_after must be one of"; then
  green "bad status_after → trigger raises with clear message"
else
  red "bad status_after should raise but got: $out"
fi

# ─────────────────────────────────────────────────────────────────
echo "----"
echo "PASS: $PASS"
echo "FAIL: $FAIL"
[[ $FAIL -eq 0 ]]
