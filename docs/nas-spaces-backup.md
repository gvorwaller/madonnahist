# NAS Spaces Backup

Date: 2026-06-13

## Purpose

The Synology NAS pulls the production DigitalOcean Spaces bucket directly to
Volume 3. This keeps a local object backup of production page images and
pre-generated crop images without routing scheduled backup traffic through a
Mac.

## Current NAS Layout

```text
/volume3/madonnahist-spaces-backup
├── current/
│   ├── crops/
│   └── pages/
├── logs/
├── manifests/
└── restore-drills/
```

The deployed share is `madonnahist-spaces-backup` on Volume 3 with
`@administrators` read/write access.

## Scripts

Repo copies:

```text
scripts/nas/backup-spaces.sh
scripts/nas/snapshot-spaces-backup.sh
```

Deployed NAS copies:

```text
/volume3/madonnahist-spaces-backup/backup-spaces.sh
/volume3/madonnahist-spaces-backup/snapshot-spaces-backup.sh
```

The rclone config is intentionally not in git:

```text
/var/services/homes/NASADMIN/.config/rclone/rclone.conf
```

That file contains the DigitalOcean Spaces access key and secret.

## Schedule

The NAS cron schedule is:

```cron
# Madonna History Spaces backup: NAS pulls DO Spaces to Volume 3 daily.
15 3 * * * NASADMIN /volume3/madonnahist-spaces-backup/backup-spaces.sh >> /volume3/madonnahist-spaces-backup/logs/spaces-cron.log 2>&1
15 4 * * * root /volume3/madonnahist-spaces-backup/snapshot-spaces-backup.sh
```

The first job pulls Spaces to the NAS daily at 03:15 local NAS time. The second
job creates a short-retention Btrfs snapshot daily at 04:15.

## Backup Semantics

The pull script uses:

```sh
rclone copy do-spaces:madonnahist /volume3/madonnahist-spaces-backup/current
```

It deliberately uses `copy`, not `sync`. Production deletes in DigitalOcean
Spaces do not propagate as deletes to the NAS backup.

The script writes:

- `logs/spaces-rclone-*.log`
- `manifests/spaces-source-size-*.json`
- `manifests/spaces-rclone-manifest-*.json`

## Snapshot Policy

Snapshots are ordinary Synology/Btrfs snapshots, not immutable/WORM snapshots.
The snapshot script keeps only the latest `2` snapshots by default:

```sh
MADONNAHIST_SPACES_SNAPSHOT_KEEP=2
```

This is intended as recent rollback protection, not long-term archive
retention.

## Verification On Setup

The initial Volume 3 verification showed:

```text
objects: 3737
bytes:   940281140
```

A restore drill was recorded at:

```text
/volume3/madonnahist-spaces-backup/restore-drills/20260613T164012Z/restore-drill.json
```

The restored object was:

```text
crops/1991/01/1991-01-01-v2.jpg
```

Expected and actual SHA-256 matched:

```text
b39c89e27ff1c5fe3418816b3290968d183c0cd5c089a2297580214373c73826
```

## Manual Commands

Dry-run the pull:

```sh
/volume3/madonnahist-spaces-backup/backup-spaces.sh --dry-run
```

Run the pull:

```sh
/volume3/madonnahist-spaces-backup/backup-spaces.sh
```

Create a snapshot:

```sh
sudo /volume3/madonnahist-spaces-backup/snapshot-spaces-backup.sh
```

List snapshots:

```sh
sudo /usr/syno/sbin/synosharesnapshot list madonnahist-spaces-backup
```

Check NAS object totals:

```sh
find /volume3/madonnahist-spaces-backup/current/crops \
     /volume3/madonnahist-spaces-backup/current/pages \
     -type f -printf '%s\n' |
awk '{s+=$1; c++} END {printf "objects=%d bytes=%d\n", c, s}'
```
