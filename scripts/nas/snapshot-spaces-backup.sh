#!/bin/sh
set -eu

# Create a Synology/Btrfs snapshot of the Spaces backup share and keep only the
# newest snapshots. This is meant as short rollback protection, not archival
# retention and not immutable/WORM storage.

SHARE="${MADONNAHIST_SPACES_SNAPSHOT_SHARE:-madonnahist-spaces-backup}"
BASE="${MADONNAHIST_SPACES_BACKUP_BASE:-/volume3/madonnahist-spaces-backup}"
KEEP="${MADONNAHIST_SPACES_SNAPSHOT_KEEP:-2}"
SNAPSHOT_BIN="${MADONNAHIST_SYNOSHARESNAPSHOT_BIN:-/usr/syno/sbin/synosharesnapshot}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG="$BASE/logs/spaces-snapshot-$STAMP.log"

mkdir -p "$BASE/logs"

{
	echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] creating snapshot for $SHARE"
	"$SNAPSHOT_BIN" create "$SHARE" -r 3 desc="spaces-backup-$STAMP"

	tmp="/tmp/${SHARE}-snapshots-$$.txt"
	"$SNAPSHOT_BIN" list "$SHARE" | tail -n +2 > "$tmp"
	count="$(grep -c . "$tmp" || true)"
	echo "snapshot count after create: $count"

	if [ "$count" -gt "$KEEP" ]; then
		delete_count=$((count - KEEP))
		echo "deleting $delete_count snapshots older than latest $KEEP"
		head -n "$delete_count" "$tmp" | while IFS= read -r snap; do
			[ -n "$snap" ] || continue
			"$SNAPSHOT_BIN" delete "$SHARE" "$snap"
		done
	fi

	rm -f "$tmp"
	"$SNAPSHOT_BIN" list "$SHARE"
} >> "$LOG" 2>&1
