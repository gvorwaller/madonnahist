#!/bin/sh
set -eu

# Pull the production DigitalOcean Spaces bucket to the Synology NAS.
#
# This intentionally uses `rclone copy`, not `rclone sync`, so objects deleted
# from production are not automatically deleted from the NAS backup.

PATH="${MADONNAHIST_NAS_PATH:-/var/services/homes/NASADMIN/bin:/usr/bin:/bin:/usr/sbin:/sbin}"
export PATH

RCLONE_CONFIG="${RCLONE_CONFIG:-/var/services/homes/NASADMIN/.config/rclone/rclone.conf}"
export RCLONE_CONFIG

BASE="${MADONNAHIST_SPACES_BACKUP_BASE:-/volume3/madonnahist-spaces-backup}"
SOURCE="${MADONNAHIST_SPACES_SOURCE:-do-spaces:madonnahist}"
DEST="$BASE/current"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG="$BASE/logs/spaces-rclone-$STAMP.log"
SOURCE_SIZE="$BASE/manifests/spaces-source-size-$STAMP.json"
MANIFEST="$BASE/manifests/spaces-rclone-manifest-$STAMP.json"
DRY_RUN=0
EXTRA_ARGS=""

for arg in "$@"; do
	case "$arg" in
		--dry-run)
			DRY_RUN=1
			EXTRA_ARGS="$EXTRA_ARGS --dry-run"
			;;
		*)
			echo "Unknown argument: $arg" >&2
			exit 2
			;;
	esac
done

mkdir -p "$DEST" "$BASE/logs" "$BASE/manifests" "$BASE/restore-drills"

rclone size "$SOURCE" --json > "$SOURCE_SIZE"
# shellcheck disable=SC2086
rclone copy "$SOURCE" "$DEST" \
	--checksum \
	--fast-list \
	--transfers 4 \
	--checkers 8 \
	--log-level INFO \
	--log-file "$LOG" \
	$EXTRA_ARGS

object_count="$(find "$DEST/crops" "$DEST/pages" -type f 2>/dev/null | wc -l | tr -d ' ')"
total_bytes="$(find "$DEST/crops" "$DEST/pages" -type f -printf '%s\n' 2>/dev/null | awk '{s+=$1} END {print s+0}')"
mode="live"
if [ "$DRY_RUN" -eq 1 ]; then mode="dry-run"; fi

cat > "$MANIFEST" <<JSON
{
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "mode": "$mode",
  "source": "$SOURCE",
  "destination": "$DEST",
  "objectCountOnNas": $object_count,
  "totalBytesOnNas": $total_bytes,
  "sourceSizeJson": "$SOURCE_SIZE",
  "log": "$LOG"
}
JSON

echo "[nas-backup-spaces] $mode complete: objects=$object_count bytes=$total_bytes log=$LOG manifest=$MANIFEST"
