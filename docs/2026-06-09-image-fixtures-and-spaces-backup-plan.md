# Image Fixtures And Spaces Backup Plan

Date: 2026-06-09

## Goals

- Exercise ingest, un-ingest, grid-line, warp, OCR-reset, and local object-store flows with representative real images.
- Avoid keeping hundreds of large production images on this MacBook solely for tests.
- Avoid creating a nightly CCC backup burden from generated or copied local test assets.
- Add an explicit backup strategy for production DigitalOcean Spaces images.
- Preserve the safety boundary from `docs/local-test-environment.md`: tests must not mutate production database rows or production Spaces objects.

## Current Context

- The app now has an isolated local test database on `127.0.0.1:15434/madonnahist_test`.
- Local tests use `MADONNAHIST_OBJECT_STORE=local`.
- Local object-store writes go to `.local/object-store-test/` by default.
- The 8 images currently in DigitalOcean Spaces are a representative sample across quality levels and months.
- There is not yet a defined backup process for production DigitalOcean Spaces images.

## Test Image Fixture Strategy

Use the 8 existing production Spaces images as the canonical real-image fixture set, but never test against them directly.

### Fixture Copy Workflow

Create a manual refresh script that downloads or copies the 8 representative Spaces objects into local test-only storage:

- Source fixture files: `.local/image-fixtures/source/`
- Local object-store copies: `.local/object-store-test/`
- Manifest: `.local/image-fixtures/manifest.json`

The manifest should record:

- production Spaces object key
- local fixture filename
- byte size
- checksum
- month/year if known
- fixture purpose, such as `normal`, `warped`, `low-contrast`, `replacement`, or `edge-case`

The refresh script should require explicit test safety checks:

- `MADONNAHIST_ENV=test`
- `MADONNAHIST_OBJECT_STORE=local`
- `PGPORT != 5433`
- `PGPORT != 5435`
- `PGDATABASE != madonnahist`

### Automated Test Usage

Automated tests should use only the local fixture copies.

Coverage targets:

- ingest creates `capture_intake`, `calendar_pages`, `calendar_days`, and local object-store rows/files as expected
- un-ingest clears DB links and deletes only the local object-store copy
- replacement ingest leaves old DB state intact on failure and cleans old local object-store files after success
- grid-line save updates `grid_version` and crop geometry predictably
- warp application writes the expected warped image key locally
- OCR reset and requeue flows operate against the local test DB
- image-serving endpoints read from the local object store

### Synthetic Fixture Usage

Keep synthetic images for deterministic geometry tests.

Synthetic fixtures are still useful for:

- exact grid-line assertions
- crop-boundary math
- perspective-warp math
- small failure cases that do not need real handwriting

These can be generated on demand and should not be backed up.

### Full Corpus Testing

Do not make the full production corpus part of routine local tests.

If full-corpus regression is needed later, make it explicit and opt-in:

- read-only source
- no production delete/write credentials
- separate command name, not part of normal `npm test` or local smoke tests
- separate storage location outside the repo

## Local Storage And CCC Backup

`.local/` is ignored by git, but CCC may still back it up unless excluded separately.

Recommended CCC exclusions:

- `/Users/gaylonvorwaller/madonnahist/.local/postgres-test/`
- `/Users/gaylonvorwaller/madonnahist/.local/object-store-test/`
- `/Users/gaylonvorwaller/madonnahist/.local/image-fixtures/`

Alternative: set local test paths under `/tmp` or another non-backed-up scratch location:

```env
MADONNAHIST_TEST_PGDATA=/tmp/madonnahist-postgres-test
MADONNAHIST_LOCAL_OBJECT_STORE_DIR=/tmp/madonnahist-object-store-test
```

The repo-local `.local/` layout is easier for agents and scripts. CCC exclusion is the preferred fix if the backup set includes the repo directory.

## Production Spaces Backup Strategy

DigitalOcean Spaces should have an explicit backup plan independent of application tests.

### Immediate Protection

Enable Spaces versioning on the production bucket if available for the current Space.

Versioning helps recover accidental overwrites and deletes, but it is not a full backup because the data remains in the same provider/account risk domain.

### Scheduled Backup

Preferred approach: the Synology NAS should pull directly from DigitalOcean Spaces.

This avoids routing backup traffic through the Mac, does not require the Mac to
be awake, and writes straight to the NAS backup volume. Use Volume 3 for this
backup because it is already planned for backup workloads and has substantially
more headroom than Volume 1.

Recommended NAS layout:

```text
Volume 3
└── shared folder: madonnahist-spaces-backup
    ├── current/
    ├── manifests/
    ├── logs/
    └── restore-drills/
```

Create a shared-folder quota large enough for future growth. `50 GB` is enough
for the current JPEG-only plan; `100 GB` leaves more room for day-cell crops,
extra warped versions, and logs/manifests.

### NAS Pull Option

First choice: use Synology Cloud Sync if it can connect to DigitalOcean Spaces
as an S3-compatible provider and run cloud-to-NAS/download-only.

Requirements:

- source: DO Spaces bucket `madonnahist`
- destination: Volume 3 shared folder `madonnahist-spaces-backup/current/`
- direction: cloud to NAS only
- schedule: daily or nightly
- deletion protection: NAS snapshots or versioning on the destination shared folder
- logs/manifests written under `madonnahist-spaces-backup/logs/` and `manifests/`

Do not rely on a plain mirror alone as the only backup. A mirror can propagate
production deletes. If Cloud Sync is used, enable NAS-side snapshots/versioning
for the destination shared folder.

Fallback: run `rclone copy` on the NAS via DSM Task Scheduler. This is preferred
over `sync` for archive backup because `copy` does not delete destination files
when production objects disappear.

Recommended command shape for the NAS fallback:

```bash
rclone copy do-spaces:madonnahist /volume3/madonnahist-spaces-backup/current \
  --checksum \
  --fast-list \
  --log-file /volume3/madonnahist-spaces-backup/logs/spaces-backup.log
```

Before the first live run, use:

```bash
rclone copy do-spaces:madonnahist /volume3/madonnahist-spaces-backup/current \
  --checksum \
  --fast-list \
  --dry-run
```

### Other Backup Destinations

After the NAS backup is working, consider adding an off-provider cloud copy for
provider/account isolation.

Preferred destination options:

- Synology NAS, if capacity is acceptable and local restore speed matters
- Backblaze B2, AWS S3 Glacier/IA, or another off-provider object store for provider/account isolation
- A second DO Space in another region as a simpler but weaker interim option

Recommended command shape for a cloud-to-cloud `rclone` copy:

```bash
rclone copy do-spaces:madonnahist backup-target:madonnahist \
  --checksum \
  --fast-list \
  --log-file logs/spaces-backup.log
```

Use `sync` only after validating source and destination remotes and only if the
destination also has versioning/object-lock protection. Before the first live
run, use:

```bash
rclone copy do-spaces:madonnahist backup-target:madonnahist \
  --checksum \
  --fast-list \
  --dry-run
```

### Backup Manifest

Each backup run should produce or update a manifest with:

- timestamp
- object count
- total bytes
- source bucket
- destination target
- changed object count if available
- log file path

The manifest should live outside `.local/`, either in a backup logs directory or on the backup destination.

### Restore Drill

Run a restore drill quarterly:

- select one known production image key
- restore it to a scratch path
- verify byte size and checksum against the manifest
- record the result in a restore-drill log

## Implementation Steps

1. Define the 8-image fixture manifest from current production Spaces keys.
2. Add a fixture refresh script that copies those objects to `.local/image-fixtures/source/`.
3. Add helper code or scripts to seed the local object store from the fixture source files.
4. Add ingest/un-ingest/grid-line smoke tests that run only under `.env.test`.
5. Add CCC exclusions for `.local/postgres-test/`, `.local/object-store-test/`, and `.local/image-fixtures/`.
6. Create the Volume 3 shared folder `madonnahist-spaces-backup`.
7. Enable NAS snapshots/versioning for the backup shared folder.
8. Try Synology Cloud Sync: DO Spaces `madonnahist` to NAS `current/`, cloud-to-NAS only.
9. If Cloud Sync is unsuitable, install/configure `rclone` on the NAS and run it from DSM Task Scheduler.
10. Run the first backup as a dry run and inspect the object count/target path.
11. Run the first live backup.
12. Record a backup manifest.
13. Perform and document a one-object restore drill.

## Open Decisions

- Whether Synology Cloud Sync works cleanly with DigitalOcean Spaces in cloud-to-NAS-only mode.
- Whether NAS snapshots/versioning are enabled for `madonnahist-spaces-backup`.
- Whether to add an off-provider cloud copy after the NAS backup is running.
- Whether to keep the 8 source fixtures under `.local/` or another non-backed-up scratch path.
- Whether fixture refresh should require live production Spaces credentials or use a separately exported fixture bundle.
- Whether backup logs/manifests should live in repo docs, a private ops directory, or the backup destination.
