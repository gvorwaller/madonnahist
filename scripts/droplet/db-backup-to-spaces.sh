#!/usr/bin/env bash
# Nightly madonnahist Postgres backup → DigitalOcean Spaces (td-ff8a42).
#
# Runs on the droplet as root via cron (see docs/db-backup-runbook.md).
# Pipeline: pg_dump (custom format) → verify via pg_restore -l →
# gpg symmetric encrypt (AES256, passphrase file) → rclone upload to the
# SAME bucket the NAS mirrors nightly (backups/db/ prefix), so every dump
# automatically gains a third copy on the NAS at its next 03:15 pull.
#
# Layout in Spaces:
#   backups/db/nightly/madonnahist-YYYY-MM-DD.dump.gpg   (30-day retention)
#   backups/db/weekly/madonnahist-YYYY-MM-DD.dump.gpg    (Sundays; 366-day retention)
#   backups/db/LAST_RUN_STATUS.json                      (health artifact)
#
# Credentials: Spaces creds are read per-run from private_data.api_credentials
# (never stored on disk); rclone is configured entirely via environment
# variables (no rclone.conf). The GPG passphrase lives ONLY in
# /root/.madonnahist-backup-passphrase (0600) — Gaylon holds the recovery
# copy in his password manager; without it the dumps are unrecoverable.
#
# Health signals: LAST_RUN_STATUS.json in Spaces, /var/log/madonnahist-db-backup.log,
# and app_state keys db_backup_last_success / db_backup_last_status (shown on
# /admin/system-health).
set -euo pipefail

PGPORT=5434
DB=madonnahist
WORKDIR=/var/backups/madonnahist
PASSFILE=/root/.madonnahist-backup-passphrase
LOG=/var/log/madonnahist-db-backup.log
STAMP="$(date -u +%F)"
DOW="$(date -u +%u)"   # 1=Mon … 7=Sun
DUMP="$WORKDIR/madonnahist-$STAMP.dump"
ENC="$DUMP.gpg"

log() { echo "$(date -u +'%FT%TZ') $*" | tee -a "$LOG"; }

psql_get() {
  sudo -u postgres psql -p "$PGPORT" -d "$DB" -tAc \
    "SELECT credential_value FROM private_data.api_credentials
      WHERE service_name='do_spaces' AND credential_key='$1' AND is_active"
}

set_app_state() { # key, json-value
  sudo -u postgres psql -p "$PGPORT" -d "$DB" -qc \
    "INSERT INTO app_state (key, value, updated_at) VALUES ('$1', '$2'::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()" || true
}

fail() {
  local msg="$1"
  log "FAILED: $msg"
  set_app_state db_backup_last_status "{\"status\":\"failed\",\"at\":\"$(date -u +'%FT%TZ')\",\"error\":\"${msg//\"/}\"}"
  # Best-effort failure artifact in Spaces (creds may be the thing that failed)
  if [[ -n "${RCLONE_CONFIG_SPACES_ACCESS_KEY_ID:-}" ]]; then
    echo "{\"status\":\"failed\",\"at\":\"$(date -u +'%FT%TZ')\",\"error\":\"${msg//\"/}\"}" \
      | rclone rcat "spaces:$BUCKET/backups/db/LAST_RUN_STATUS.json" || true
  fi
  exit 1
}

mkdir -p "$WORKDIR"
chmod 700 "$WORKDIR"
[[ -f "$PASSFILE" ]] || { log "FATAL: passphrase file $PASSFILE missing"; exit 1; }

# ── Credentials → rclone env config (no on-disk rclone.conf) ─────────────
BUCKET="$(psql_get SPACES_BUCKET)"
ENDPOINT="$(psql_get SPACES_ENDPOINT)"
REGION="$(psql_get SPACES_REGION)"
export RCLONE_CONFIG_SPACES_TYPE=s3
export RCLONE_CONFIG_SPACES_PROVIDER=DigitalOcean
export RCLONE_CONFIG_SPACES_ACCESS_KEY_ID="$(psql_get SPACES_KEY)"
export RCLONE_CONFIG_SPACES_SECRET_ACCESS_KEY="$(psql_get SPACES_SECRET)"
export RCLONE_CONFIG_SPACES_ENDPOINT="$ENDPOINT"
export RCLONE_CONFIG_SPACES_REGION="$REGION"
# DO Spaces denies rclone's bucket-existence/create probe for this key and
# reports it as the copy failing (403 AccessDenied on every write; found
# 2026-07-24 during first-run debugging). The bucket always exists — skip
# the check for all rclone calls in this script.
export RCLONE_S3_NO_CHECK_BUCKET=true
[[ -n "$BUCKET" && -n "$RCLONE_CONFIG_SPACES_ACCESS_KEY_ID" ]] || fail "missing Spaces credentials"

log "starting backup of $DB (stamp $STAMP)"

# ── Dump + verify before anything else touches it ────────────────────────
sudo -u postgres pg_dump -p "$PGPORT" -Fc -f "$DUMP.tmp" "$DB" || fail "pg_dump failed"
sudo -u postgres pg_restore -l "$DUMP.tmp" > /dev/null || fail "dump verification (pg_restore -l) failed"
mv "$DUMP.tmp" "$DUMP"
SIZE=$(stat -c%s "$DUMP")
log "dump ok ($SIZE bytes), verified via pg_restore -l"

# ── Encrypt ──────────────────────────────────────────────────────────────
gpg --batch --yes --symmetric --cipher-algo AES256 \
    --passphrase-file "$PASSFILE" -o "$ENC" "$DUMP" || fail "gpg encryption failed"
rm -f "$DUMP"

# ── Upload (nightly always; weekly copy on Sundays) ──────────────────────
rclone copyto "$ENC" "spaces:$BUCKET/backups/db/nightly/$(basename "$ENC")" || fail "nightly upload failed"
if [[ "$DOW" == "7" ]]; then
  rclone copyto "$ENC" "spaces:$BUCKET/backups/db/weekly/$(basename "$ENC")" || fail "weekly upload failed"
fi
rm -f "$ENC"

# ── Retention ────────────────────────────────────────────────────────────
rclone delete --min-age 30d  "spaces:$BUCKET/backups/db/nightly/" || log "WARN: nightly retention sweep failed"
rclone delete --min-age 366d "spaces:$BUCKET/backups/db/weekly/"  || log "WARN: weekly retention sweep failed"

# ── Health artifacts ─────────────────────────────────────────────────────
NIGHTLY_COUNT=$(rclone lsf "spaces:$BUCKET/backups/db/nightly/" | wc -l)
STATUS="{\"status\":\"ok\",\"at\":\"$(date -u +'%FT%TZ')\",\"dump_bytes\":$SIZE,\"nightly_count\":$NIGHTLY_COUNT,\"weekly\":$([[ "$DOW" == "7" ]] && echo true || echo false)}"
echo "$STATUS" | rclone rcat "spaces:$BUCKET/backups/db/LAST_RUN_STATUS.json" || log "WARN: status upload failed"
set_app_state db_backup_last_status "$STATUS"
set_app_state db_backup_last_success "{\"at\":\"$(date -u +'%FT%TZ')\",\"dump_bytes\":$SIZE}"

log "backup complete: nightly/$(basename "$ENC") ($SIZE bytes pre-encryption, $NIGHTLY_COUNT nightlies retained)"
