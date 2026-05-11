#!/usr/bin/env bash
# backend/db/migrate_pg.sh
# Apply PostgreSQL migrations (all *.sql files in migrations/) once, in order.
# Connects as MIGRATION_PGUSER (madonnahist_owner), NOT the runtime PGUSER.
#
# Usage:
#   ./migrate_pg.sh             # apply pending migrations
#   ./migrate_pg.sh --dry-run   # show what would be applied

set -euo pipefail

RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
NC=$'\033[0m'

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
  echo "${YELLOW}DRY RUN MODE - No changes will be applied${NC}"
fi

# Resolve repo root and load .env if present (local dev) or /opt/madonnahist/.env (prod).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

ENV_FILE=""
if [[ -f "$REPO_ROOT/.env" ]]; then
  ENV_FILE="$REPO_ROOT/.env"
elif [[ -f "/opt/madonnahist/.env" ]]; then
  ENV_FILE="/opt/madonnahist/.env"
fi
if [[ -n "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
fi

# Find psql binary.
if [[ -x "/opt/homebrew/opt/postgresql@17/bin/psql" ]]; then
  PSQL_BIN="/opt/homebrew/opt/postgresql@17/bin/psql"
elif command -v psql >/dev/null 2>&1; then
  PSQL_BIN="$(command -v psql)"
else
  echo "${RED}ERROR: psql not found${NC}" >&2
  exit 1
fi

# Connection: migration role only.
PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5434}"
PGDATABASE="${PGDATABASE:-madonnahist}"
OWNER_USER="${MIGRATION_PGUSER:-madonnahist_owner}"
OWNER_PW="${MIGRATION_PGPASSWORD:-}"

if [[ -z "$OWNER_PW" ]]; then
  echo "${RED}ERROR: MIGRATION_PGPASSWORD is empty. Set it in .env.${NC}" >&2
  exit 1
fi

run_psql() {
  PGPASSWORD="$OWNER_PW" "$PSQL_BIN" \
    -h "$PGHOST" -p "$PGPORT" -U "$OWNER_USER" -d "$PGDATABASE" "$@"
}

# Smoke test connection.
if ! run_psql -tAc "SELECT 1" >/dev/null 2>&1; then
  echo "${RED}ERROR: Cannot connect as ${OWNER_USER}@${PGHOST}:${PGPORT}/${PGDATABASE}${NC}" >&2
  exit 1
fi

echo "${GREEN}Connected: ${OWNER_USER}@${PGHOST}:${PGPORT}/${PGDATABASE}${NC}"

MIG_DIR="$SCRIPT_DIR/migrations"
PG_MIGRATIONS=$(find "$MIG_DIR" -maxdepth 1 -name "*.sql" -type f | sort || true)

if [[ -z "$PG_MIGRATIONS" ]]; then
  echo "No migrations to apply."
  exit 0
fi

# Bootstrap the tracking table (chicken/egg — runs before 0001 applies).
if [[ "$DRY_RUN" == "false" ]]; then
  run_psql -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
CREATE SCHEMA IF NOT EXISTS admin;
CREATE TABLE IF NOT EXISTS admin.schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
SQL
fi

TOTAL=0
APPLIED=0
SKIPPED=0

for f in $PG_MIGRATIONS; do
  base="$(basename "$f")"
  TOTAL=$((TOTAL + 1))

  already=$(run_psql -tAc "SELECT 1 FROM admin.schema_migrations WHERE filename = '$base'" 2>/dev/null || true)

  if [[ "$already" == "1" ]]; then
    echo "${GREEN}✔${NC} already applied: $base"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "${YELLOW}→${NC} would apply: $base"
    APPLIED=$((APPLIED + 1))
    continue
  fi

  echo "${YELLOW}→${NC} applying: $base"

  if {
    echo "BEGIN;"
    echo "-- Migration: $base"
    cat "$f"
    echo ""
    echo "INSERT INTO admin.schema_migrations (filename) VALUES ('$base');"
    echo "COMMIT;"
  } | run_psql -v ON_ERROR_STOP=1
  then
    echo "${GREEN}✔${NC} applied: $base"
    APPLIED=$((APPLIED + 1))
  else
    echo "${RED}✘ FAILED: $base${NC}" >&2
    exit 1
  fi
done

echo ""
echo "${GREEN}Done.${NC}"
echo "  Total: $TOTAL"
echo "  Applied: $APPLIED"
echo "  Skipped: $SKIPPED"
