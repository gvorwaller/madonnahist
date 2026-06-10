#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/test-env.sh
source "$SCRIPT_DIR/lib/test-env.sh"

ENV_ARG="$(parse_env_arg "$@")"
load_test_env "$ENV_ARG"
require_test_safety

case "${MADONNAHIST_OBJECT_STORE:-}" in
  local) ;;
  *)
    echo "ERROR: MADONNAHIST_OBJECT_STORE must be 'local' for local tests." >&2
    exit 1
    ;;
esac

echo "Local test environment is safe:"
echo "  env file: $TEST_ENV_FILE"
echo "  database: $PGHOST:$PGPORT/$PGDATABASE"
echo "  app role: $PGUSER"
echo "  worker role: $WORKER_PGUSER"
echo "  data dir: $MADONNAHIST_TEST_PGDATA"
echo "  object store: ${MADONNAHIST_LOCAL_OBJECT_STORE_DIR:-.local/object-store-test}"
