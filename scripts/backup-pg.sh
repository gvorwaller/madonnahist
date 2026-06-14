#!/bin/bash
# Produces a consistent snapshot of the local madonnahist PostgreSQL database
# and pulls a parallel snapshot from the production droplet, plus the artifacts
# that only exist on the droplet (prod .env, nginx server block, cluster
# configs, PM2 state, Spaces bucket inventory + CORS). Safe to run while the
# app is serving requests — pg_dump uses a single MVCC snapshot.
#
# Intended use: Carbon Copy Cloner pre-flight script, before CCC copies the
# data/backup/ directory to the Synology NAS. Run independently any time you
# want a clean on-disk snapshot.
#
# Outputs (under <project>/data/backup/):
#   local/madonnahist.pgdump          — local dev DB, pg_dump -Fc (custom format), when running
#   local/PULL_OK_AT                  — ISO-8601 timestamp on local success
#   local/SKIPPED_AT                  — ISO-8601 timestamp when local PG is unavailable
#   local/FAILED_AT                   — ISO-8601 timestamp when local dump/verify fails
#   prod/madonnahist.pgdump           — prod DB, pulled via SSH
#   prod/.env                         — /opt/madonnahist/.env (600)
#   prod/nginx.conf                   — /etc/nginx/sites-available/madonnahist.gaylon.photos
#   prod/postgresql.conf              — /etc/postgresql/17/madonnahist/postgresql.conf
#   prod/pg_hba.conf                  — /etc/postgresql/17/madonnahist/pg_hba.conf
#   prod/pm2-madonnahist.json         — pm2 jlist filtered to the madonnahist app
#   prod/spaces-objects.json          — DO Spaces bucket listing (best-effort)
#   prod/spaces-cors.json             — DO Spaces bucket CORS config (best-effort)
#   prod/PULL_OK_AT                   — ISO-8601 timestamp on success
#   preflight.log                     — tee of every run (uid, args, stdout, stderr)
#
# Use --local-only to skip the prod pull (offline / dev-only scenarios).
# The production snapshot is the mandatory backup. Local dev PostgreSQL may be
# stopped, so local snapshot failures are logged but are only fatal in
# --local-only mode.

set -euo pipefail

# CCC may invoke us with a stripped PATH. Add Homebrew PostgreSQL client
# locations explicitly so pg_restore/psql resolve when this runs as root. libpq
# is keg-only, and this machine currently has libpq/Postgres 16 clients rather
# than a populated postgresql@17 opt path.
export PATH="/opt/homebrew/opt/libpq/bin:/opt/homebrew/opt/postgresql@17/bin:/opt/homebrew/opt/postgresql@16/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# Resolve the project root relative to this script so CCC can invoke it via
# any working directory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

BACKUP_DIR="${PROJECT_ROOT}/data/backup"
LOCAL_BACKUP_DIR="${BACKUP_DIR}/local"
LOCAL_DUMP="${LOCAL_BACKUP_DIR}/madonnahist.pgdump"
LOCAL_PULL_MARKER="${LOCAL_BACKUP_DIR}/PULL_OK_AT"
LOCAL_SKIP_MARKER="${LOCAL_BACKUP_DIR}/SKIPPED_AT"
LOCAL_SKIP_REASON="${LOCAL_BACKUP_DIR}/SKIPPED_REASON"
LOCAL_FAIL_MARKER="${LOCAL_BACKUP_DIR}/FAILED_AT"
LOCAL_FAIL_REASON="${LOCAL_BACKUP_DIR}/FAILED_REASON"

PROD_BACKUP_DIR="${BACKUP_DIR}/prod"
PROD_DUMP="${PROD_BACKUP_DIR}/madonnahist.pgdump"
PROD_DUMP_TMP="${PROD_DUMP}.tmp"
PROD_ENV_DEST="${PROD_BACKUP_DIR}/.env"
PROD_NGINX_DEST="${PROD_BACKUP_DIR}/nginx.conf"
PROD_PGCONF_DEST="${PROD_BACKUP_DIR}/postgresql.conf"
PROD_PGHBA_DEST="${PROD_BACKUP_DIR}/pg_hba.conf"
PROD_PM2_DEST="${PROD_BACKUP_DIR}/pm2-madonnahist.json"
PROD_SPACES_LIST_DEST="${PROD_BACKUP_DIR}/spaces-objects.json"
PROD_SPACES_CORS_DEST="${PROD_BACKUP_DIR}/spaces-cors.json"
PROD_PULL_MARKER="${PROD_BACKUP_DIR}/PULL_OK_AT"

# Tee everything to a log file so CCC failures can be diagnosed after the
# fact — CCC's "Errors" tab only surfaces the wrapper message, not actual
# script stderr.
LOG_FILE="${BACKUP_DIR}/preflight.log"
mkdir -p "${BACKUP_DIR}" "${LOCAL_BACKUP_DIR}" "${PROD_BACKUP_DIR}"
{
  echo "===== $(/bin/date -u +%Y-%m-%dT%H:%M:%SZ) preflight start ====="
  echo "uid=$EUID user=$(/usr/bin/id -un 2>/dev/null || echo ?) home=${HOME:-?} pwd=$(pwd)"
  echo "path=${PATH:-?}"
  echo "args=$*"
} >> "${LOG_FILE}"
exec > >(/usr/bin/tee -a "${LOG_FILE}") 2> >(/usr/bin/tee -a "${LOG_FILE}" >&2)

PG_DUMP_BIN="$(command -v pg_dump || true)"
PG_RESTORE_BIN="$(command -v pg_restore || true)"
echo "[backup-pg] pg_dump=${PG_DUMP_BIN:-missing}"
echo "[backup-pg] pg_restore=${PG_RESTORE_BIN:-missing}"
if [[ -z "${PG_RESTORE_BIN}" ]]; then
  echo "[backup-pg] required PostgreSQL client not found: pg_restore" >&2
  exit 10
fi

DROPLET="root@134.199.211.199"
PROD_APP_DIR="/opt/madonnahist"
PROD_PG_CLUSTER_DIR="/etc/postgresql/17/madonnahist"
PROD_NGINX_CONF="/etc/nginx/sites-available/madonnahist.gaylon.photos"

# Local PG (Homebrew, listens on 127.0.0.1:5434). Connect as the owner role —
# it's the only role with full read on every schema (admin, private_data,
# public, future app data). Password comes from ~/.pgpass.
# Use the literal "localhost" so ~/.pgpass entries (which are matched by
# literal hostname, not after DNS resolution) resolve correctly.
LOCAL_PGHOST="localhost"
LOCAL_PGPORT="5434"
LOCAL_PGDATABASE="madonnahist"
LOCAL_PGUSER="madonnahist_owner"
USER_PGPASSFILE="/Users/gaylonvorwaller/.pgpass"

# CCC runs preflight as root; outputs would end up root-owned and block the
# next interactive run by the user. Reassert ownership on every exit path so
# the backup dir stays writable to gaylonvorwaller regardless of caller.
OWNER_USER="gaylonvorwaller"
OWNER_GROUP="staff"
restore_ownership() {
  if [[ $EUID -eq 0 ]]; then
    /usr/sbin/chown -R "${OWNER_USER}:${OWNER_GROUP}" "${BACKUP_DIR}" 2>/dev/null || true
  fi
}
trap restore_ownership EXIT

LOCAL_ONLY=0
# CCC invokes preflight scripts with positional args ($1 source, $2 dest, $3
# exit code from prior task). We only care about our own flags; everything
# else is ignored so CCC's calling convention doesn't trip us up.
for arg in "$@"; do
  case "$arg" in
    --local-only) LOCAL_ONLY=1 ;;
    -h|--help)
      echo "Usage: $0 [--local-only]"
      exit 0
      ;;
    --*|-?)
      echo "Unknown flag: $arg" >&2
      exit 2
      ;;
    *) ;; # ignore positional args (CCC passes source/dest paths)
  esac
done

# --- local snapshot ---------------------------------------------------------
# pg_dump -Fc produces a compressed, restore-with-pg_restore-friendly archive.
# Single MVCC snapshot — consistent without blocking writers. We connect via
# TCP so ~/.pgpass is consulted (peer auth on the unix socket would bypass
# password and fail when running as root via CCC).
export PGPASSFILE="${USER_PGPASSFILE}"

mark_local_skipped() {
  local reason=$1
  rm -f "${LOCAL_PULL_MARKER}" "${LOCAL_FAIL_MARKER}" "${LOCAL_FAIL_REASON}" "${LOCAL_DUMP}.tmp"
  /bin/date -u +%Y-%m-%dT%H:%M:%SZ > "${LOCAL_SKIP_MARKER}"
  printf '%s\n' "${reason}" > "${LOCAL_SKIP_REASON}"
  echo "[backup-pg] WARN: local snapshot skipped: ${reason}"
  if [[ ${LOCAL_ONLY} -eq 1 ]]; then
    exit 1
  fi
}

mark_local_failed() {
  local reason=$1
  rm -f "${LOCAL_PULL_MARKER}" "${LOCAL_SKIP_MARKER}" "${LOCAL_SKIP_REASON}" "${LOCAL_DUMP}.tmp"
  /bin/date -u +%Y-%m-%dT%H:%M:%SZ > "${LOCAL_FAIL_MARKER}"
  printf '%s\n' "${reason}" > "${LOCAL_FAIL_REASON}"
  echo "[backup-pg] WARN: local snapshot failed: ${reason}" >&2
  if [[ ${LOCAL_ONLY} -eq 1 ]]; then
    exit 2
  fi
}

if [[ ! -f "${PGPASSFILE}" ]]; then
  mark_local_skipped "${PGPASSFILE} not found"
elif ! /usr/bin/nc -z "${LOCAL_PGHOST}" "${LOCAL_PGPORT}" 2>/dev/null; then
  mark_local_skipped "local PG not listening on ${LOCAL_PGHOST}:${LOCAL_PGPORT}"
elif [[ -z "${PG_DUMP_BIN}" ]]; then
  mark_local_failed "required PostgreSQL client not found: pg_dump"
elif ! "${PG_DUMP_BIN}" \
    -h "${LOCAL_PGHOST}" -p "${LOCAL_PGPORT}" \
    -U "${LOCAL_PGUSER}" -d "${LOCAL_PGDATABASE}" \
    -Fc --no-owner --no-privileges \
    -f "${LOCAL_DUMP}.tmp"; then
  mark_local_failed "pg_dump failed for ${LOCAL_PGDATABASE} on ${LOCAL_PGHOST}:${LOCAL_PGPORT}"
else
  # Verify the dump by listing its table of contents (cheap structural check).
  if ! LOCAL_VERIFY_OUTPUT="$("${PG_RESTORE_BIN}" -l "${LOCAL_DUMP}.tmp" 2>&1 >/dev/null)"; then
    echo "${LOCAL_VERIFY_OUTPUT}" >&2
    mark_local_failed "pg_restore -l verification failed for ${LOCAL_DUMP}.tmp"
  else
    mv -f "${LOCAL_DUMP}.tmp" "${LOCAL_DUMP}"
    LOCAL_SIZE="$(/usr/bin/stat -f%z "${LOCAL_DUMP}" 2>/dev/null || /usr/bin/wc -c < "${LOCAL_DUMP}")"
    /bin/date -u +%Y-%m-%dT%H:%M:%SZ > "${LOCAL_PULL_MARKER}"
    rm -f "${LOCAL_SKIP_MARKER}" "${LOCAL_SKIP_REASON}" "${LOCAL_FAIL_MARKER}" "${LOCAL_FAIL_REASON}"
    echo "[backup-pg] local snapshot ok: ${LOCAL_DUMP} (${LOCAL_SIZE} bytes)"
  fi
fi

# --- prod pull --------------------------------------------------------------
if [[ ${LOCAL_ONLY} -eq 1 ]]; then
  echo "[backup-pg] --local-only: skipping prod pull"
  exit 0
fi

# CCC runs preflight scripts as root, whose HOME is /var/root and has no
# SSH key authorized on the droplet. Point SSH at gaylonvorwaller's key and
# known_hosts explicitly so the same SSH_OPTS work whether the script is
# launched interactively as the user or by CCC as root.
USER_SSH_DIR="/Users/gaylonvorwaller/.ssh"
SSH_OPTS="-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o IdentitiesOnly=yes -i ${USER_SSH_DIR}/id_ed25519 -o UserKnownHostsFile=${USER_SSH_DIR}/known_hosts"

PROD_TMP_DUMP="/tmp/madonnahist-ccc-pull.pgdump"
PROD_TMP_PM2="/tmp/madonnahist-ccc-pm2.json"
PROD_TMP_SPACES_LIST="/tmp/madonnahist-ccc-spaces-list.json"
PROD_TMP_SPACES_CORS="/tmp/madonnahist-ccc-spaces-cors.json"

# Disable strict error-out for the network section so we can clean up before
# exiting on partial failure.
set +e

# 1. pg_dump on the droplet. Run as the postgres unix user — it owns the
#    cluster and uses peer auth on the local socket, no password needed.
ssh ${SSH_OPTS} "${DROPLET}" \
  "sudo -u postgres pg_dump -p 5434 -d madonnahist -Fc --no-owner --no-privileges -f '${PROD_TMP_DUMP}' && chmod 644 '${PROD_TMP_DUMP}'"
if [[ $? -ne 0 ]]; then
  echo "[backup-pg] prod pg_dump via SSH failed (droplet unreachable or pg_dump errored)" >&2
  rm -f "${PROD_PULL_MARKER}"
  exit 3
fi

rm -f "${PROD_DUMP_TMP}"
scp ${SSH_OPTS} "${DROPLET}:${PROD_TMP_DUMP}" "${PROD_DUMP_TMP}"
SCP_DUMP_RC=$?

# 2. Droplet-unique config files. Errors here aren't fatal individually — we
#    aggregate at the end. .env is the most sensitive; tighten its mode immediately.
scp ${SSH_OPTS} "${DROPLET}:${PROD_APP_DIR}/.env" "${PROD_ENV_DEST}"
SCP_ENV_RC=$?
[[ ${SCP_ENV_RC} -eq 0 ]] && chmod 600 "${PROD_ENV_DEST}"

scp ${SSH_OPTS} "${DROPLET}:${PROD_NGINX_CONF}" "${PROD_NGINX_DEST}"
SCP_NGINX_RC=$?

ssh ${SSH_OPTS} "${DROPLET}" "cat '${PROD_PG_CLUSTER_DIR}/postgresql.conf'" > "${PROD_PGCONF_DEST}"
SSH_PGCONF_RC=$?

ssh ${SSH_OPTS} "${DROPLET}" "cat '${PROD_PG_CLUSTER_DIR}/pg_hba.conf'" > "${PROD_PGHBA_DEST}"
SSH_PGHBA_RC=$?

# 3. PM2 process state — filter to the madonnahist entry, recursively redact
#    any key matching PASS/SECRET/TOKEN at every nesting level. pm2_env has
#    multiple env-shaped sub-objects (env, env_*, env_diff, etc.), so a single
#    top-level pass is not enough. jq isn't guaranteed on the droplet but Node
#    is — the SvelteKit build needs it.
ssh ${SSH_OPTS} "${DROPLET}" \
  "pm2 jlist | node -e 'let d=\"\";process.stdin.on(\"data\",c=>d+=c).on(\"end\",()=>{const SENS=/PASSWORD|SECRET|TOKEN|API.?KEY/i;const scrub=v=>{if(v&&typeof v===\"object\"){if(Array.isArray(v))return v.map(scrub);const o={};for(const k of Object.keys(v))o[k]=SENS.test(k)?\"<redacted>\":scrub(v[k]);return o;}return v;};const out=JSON.parse(d).filter(x=>x.name===\"madonnahist\").map(scrub);console.log(JSON.stringify(out,null,2));})' > '${PROD_TMP_PM2}' && chmod 644 '${PROD_TMP_PM2}'"
SSH_PM2_RC=$?
if [[ ${SSH_PM2_RC} -eq 0 ]]; then
  scp ${SSH_OPTS} "${DROPLET}:${PROD_TMP_PM2}" "${PROD_PM2_DEST}"
  SCP_PM2_RC=$?
else
  SCP_PM2_RC=1
fi

# 4. DO Spaces — bucket inventory + CORS. Best-effort: the droplet has the
#    credentials in private_data.api_credentials. We read them with a tiny
#    psql call (TCP + .env's PGPASSWORD), then prefer aws-cli and fall back to
#    the app's installed @aws-sdk/client-s3 dependency.
ssh ${SSH_OPTS} "${DROPLET}" "bash -s" <<REMOTE_SPACES > /dev/null 2>&1
set -e
cd "${PROD_APP_DIR}"
set -a; . ./.env; set +a
PGPASSWORD="\${PGPASSWORD}" psql -h 127.0.0.1 -p 5434 -U "\${PGUSER}" -d madonnahist -tAF $'\t' -c \
  "SELECT credential_key, credential_value FROM private_data.api_credentials WHERE service_name='do_spaces' AND is_active=true" \
  > /tmp/madonnahist-ccc-spaces-creds.tsv
declare -A C
while IFS=\$'\t' read -r k v; do C[\$k]=\$v; done < /tmp/madonnahist-ccc-spaces-creds.tsv
rm -f /tmp/madonnahist-ccc-spaces-creds.tsv

if [[ -z "\${C[SPACES_KEY]:-}" || -z "\${C[SPACES_BUCKET]:-}" ]]; then
  echo '{"skipped":"credentials not seeded"}' > "${PROD_TMP_SPACES_LIST}"
  echo '{"skipped":"credentials not seeded"}' > "${PROD_TMP_SPACES_CORS}"
  exit 0
fi

ENDPOINT="\${C[SPACES_ENDPOINT]}"
REGION="\${C[SPACES_REGION]}"
BUCKET="\${C[SPACES_BUCKET]}"

if command -v aws >/dev/null 2>&1; then
  AWS_ACCESS_KEY_ID="\${C[SPACES_KEY]}" \
  AWS_SECRET_ACCESS_KEY="\${C[SPACES_SECRET]}" \
  aws --endpoint-url "\${ENDPOINT}" --region "\${REGION}" \
    s3api list-objects-v2 --bucket "\${BUCKET}" --output json \
    > "${PROD_TMP_SPACES_LIST}" 2>/dev/null || echo '{"error":"list-objects-v2 failed"}' > "${PROD_TMP_SPACES_LIST}"
  AWS_ACCESS_KEY_ID="\${C[SPACES_KEY]}" \
  AWS_SECRET_ACCESS_KEY="\${C[SPACES_SECRET]}" \
  aws --endpoint-url "\${ENDPOINT}" --region "\${REGION}" \
    s3api get-bucket-cors --bucket "\${BUCKET}" --output json \
    > "${PROD_TMP_SPACES_CORS}" 2>/dev/null || echo '{"error":"get-bucket-cors failed or unset"}' > "${PROD_TMP_SPACES_CORS}"
else
  export SPACES_KEY="\${C[SPACES_KEY]}"
  export SPACES_SECRET="\${C[SPACES_SECRET]}"
  export SPACES_BUCKET="\${BUCKET}"
  export SPACES_REGION="\${REGION}"
  export SPACES_ENDPOINT="\${ENDPOINT}"
  export SPACES_LIST_PATH="${PROD_TMP_SPACES_LIST}"
  export SPACES_CORS_PATH="${PROD_TMP_SPACES_CORS}"
  if ! node --input-type=module <<'NODE_SPACES'
import { writeFile } from 'node:fs/promises';
import {
  S3Client,
  ListObjectsV2Command,
  GetBucketCorsCommand
} from '@aws-sdk/client-s3';

const bucket = process.env.SPACES_BUCKET;
const client = new S3Client({
  region: process.env.SPACES_REGION,
  endpoint: process.env.SPACES_ENDPOINT,
  credentials: {
    accessKeyId: process.env.SPACES_KEY,
    secretAccessKey: process.env.SPACES_SECRET
  },
  forcePathStyle: false
});

const writeJson = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');

try {
  const contents = [];
  let ContinuationToken;
  do {
    const page = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      ContinuationToken
    }));
    for (const obj of page.Contents ?? []) {
      contents.push({
        Key: obj.Key,
        LastModified: obj.LastModified?.toISOString?.() ?? obj.LastModified,
        ETag: obj.ETag,
        Size: obj.Size,
        StorageClass: obj.StorageClass
      });
    }
    ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (ContinuationToken);
  await writeJson(process.env.SPACES_LIST_PATH, {
    Name: bucket,
    KeyCount: contents.length,
    Contents: contents
  });
} catch (err) {
  await writeJson(process.env.SPACES_LIST_PATH, {
    error: err instanceof Error ? err.message : String(err)
  });
}

try {
  const cors = await client.send(new GetBucketCorsCommand({ Bucket: bucket }));
  await writeJson(process.env.SPACES_CORS_PATH, cors);
} catch (err) {
  await writeJson(process.env.SPACES_CORS_PATH, {
    error: err instanceof Error ? err.message : String(err)
  });
}
NODE_SPACES
  then
    echo '{"skipped":"aws CLI and @aws-sdk/client-s3 unavailable on droplet"}' > "${PROD_TMP_SPACES_LIST}"
    echo '{"skipped":"aws CLI and @aws-sdk/client-s3 unavailable on droplet"}' > "${PROD_TMP_SPACES_CORS}"
  fi
fi
chmod 644 "${PROD_TMP_SPACES_LIST}" "${PROD_TMP_SPACES_CORS}"
REMOTE_SPACES
SSH_SPACES_RC=$?
if [[ ${SSH_SPACES_RC} -eq 0 ]]; then
  scp ${SSH_OPTS} "${DROPLET}:${PROD_TMP_SPACES_LIST}" "${PROD_SPACES_LIST_DEST}" >/dev/null 2>&1
  SCP_SPACES_LIST_RC=$?
  scp ${SSH_OPTS} "${DROPLET}:${PROD_TMP_SPACES_CORS}" "${PROD_SPACES_CORS_DEST}" >/dev/null 2>&1
  SCP_SPACES_CORS_RC=$?
else
  SCP_SPACES_LIST_RC=1
  SCP_SPACES_CORS_RC=1
fi

# 5. Clean up droplet-side temps regardless of outcome.
ssh ${SSH_OPTS} "${DROPLET}" \
  "rm -f '${PROD_TMP_DUMP}' '${PROD_TMP_PM2}' '${PROD_TMP_SPACES_LIST}' '${PROD_TMP_SPACES_CORS}'" >/dev/null 2>&1

set -e

# --- Aggregate prod outcomes ------------------------------------------------
if [[ ${SCP_DUMP_RC} -ne 0 ]]; then
  echo "[backup-pg] scp of prod pg_dump failed" >&2
  rm -f "${PROD_DUMP_TMP}"
  rm -f "${PROD_PULL_MARKER}"
  exit 3
fi

# Verify the prod dump is structurally sound before declaring success.
if ! PROD_VERIFY_OUTPUT="$("${PG_RESTORE_BIN}" -l "${PROD_DUMP_TMP}" 2>&1 >/dev/null)"; then
  echo "[backup-pg] prod dump failed pg_restore -l verification for ${PROD_DUMP_TMP}" >&2
  echo "${PROD_VERIFY_OUTPUT}" >&2
  rm -f "${PROD_DUMP_TMP}"
  rm -f "${PROD_PULL_MARKER}"
  exit 4
fi
mv -f "${PROD_DUMP_TMP}" "${PROD_DUMP}"

# .env, nginx, PG configs, PM2 state — log per-item but do NOT fail the run.
# Missing nginx is suspicious; missing pm2/spaces is acceptable during early
# Phase 1 (e.g. before workers are registered or Spaces is seeded).
warn_if_fail() {
  local rc=$1 label=$2 path=$3
  if [[ ${rc} -ne 0 ]]; then
    echo "[backup-pg] WARN: ${label} pull failed (rc=${rc}) — ${path}"
  else
    local sz
    sz="$(/usr/bin/stat -f%z "${path}" 2>/dev/null || /usr/bin/wc -c < "${path}")"
    echo "[backup-pg] ${label} ok: ${path} (${sz} bytes)"
  fi
}
warn_json_if_fail() {
  local rc=$1 label=$2 path=$3
  if [[ ${rc} -ne 0 ]]; then
    echo "[backup-pg] WARN: ${label} pull failed (rc=${rc}) — ${path}"
  elif /usr/bin/grep -Eq '"(skipped|error)"' "${path}"; then
    local msg
    msg="$(/usr/bin/tr -d '\n' < "${path}")"
    echo "[backup-pg] WARN: ${label} unavailable — ${msg}"
  else
    local sz
    sz="$(/usr/bin/stat -f%z "${path}" 2>/dev/null || /usr/bin/wc -c < "${path}")"
    echo "[backup-pg] ${label} ok: ${path} (${sz} bytes)"
  fi
}
warn_if_fail ${SCP_ENV_RC}         "prod .env"          "${PROD_ENV_DEST}"
warn_if_fail ${SCP_NGINX_RC}       "prod nginx.conf"    "${PROD_NGINX_DEST}"
warn_if_fail ${SSH_PGCONF_RC}      "prod postgresql.conf" "${PROD_PGCONF_DEST}"
warn_if_fail ${SSH_PGHBA_RC}       "prod pg_hba.conf"   "${PROD_PGHBA_DEST}"
warn_if_fail ${SCP_PM2_RC}         "prod pm2 jlist"     "${PROD_PM2_DEST}"
warn_json_if_fail ${SCP_SPACES_LIST_RC} "Spaces inventory" "${PROD_SPACES_LIST_DEST}"
warn_json_if_fail ${SCP_SPACES_CORS_RC} "Spaces CORS"      "${PROD_SPACES_CORS_DEST}"

PROD_DUMP_SIZE="$(/usr/bin/stat -f%z "${PROD_DUMP}" 2>/dev/null || /usr/bin/wc -c < "${PROD_DUMP}")"
/bin/date -u +%Y-%m-%dT%H:%M:%SZ > "${PROD_PULL_MARKER}"
echo "[backup-pg] prod snapshot ok: ${PROD_DUMP} (${PROD_DUMP_SIZE} bytes)"
