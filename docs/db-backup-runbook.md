# madonnahist DB backup runbook (td-ff8a42)

## What runs

`scripts/droplet/db-backup-to-spaces.sh`, nightly at **02:30 UTC** via root cron
on the droplet (134.199.211.199). Pipeline per run:

1. `pg_dump -Fc` of `madonnahist` (port 5434) as `postgres`
2. Verified with `pg_restore -l` **before** anything is uploaded
3. GPG-encrypted (AES256, symmetric) with the passphrase in
   `/root/.madonnahist-backup-passphrase` (0600)
4. Uploaded via rclone (env-configured per run from
   `private_data.api_credentials` — no credentials on disk) to the
   `madonnahist` Spaces bucket:
   - `backups/db/nightly/madonnahist-YYYY-MM-DD.dump.gpg` — 30-day retention
   - `backups/db/weekly/…` — Sundays only, 366-day retention
5. Health: `backups/db/LAST_RUN_STATUS.json` in Spaces,
   `/var/log/madonnahist-db-backup.log` on the droplet, and `app_state`
   keys `db_backup_last_status` / `db_backup_last_success`
   (surfaced on **/admin/system-health → DB Backup**).

Because the NAS pulls the **entire** bucket nightly at 03:15
(`scripts/nas/backup-spaces.sh`), every dump automatically gains a third
copy on the NAS ~45 minutes after upload. Copies of any given night's
dump: droplet-transient (deleted after upload) → Spaces → NAS.

## The passphrase — read this first

Dumps are unrecoverable without the GPG passphrase. It exists in exactly
two places: `/root/.madonnahist-backup-passphrase` on the droplet, and
**Gaylon's password manager** (entry: "madonnahist DB backup GPG"). If the
droplet is lost, the password-manager copy is the only path to the data.
Never commit it, never put it in Spaces.

## Restore procedure

```bash
# 1. Fetch a dump (from Spaces, or from the NAS mirror)
rclone copyto spaces:madonnahist/backups/db/nightly/madonnahist-YYYY-MM-DD.dump.gpg /tmp/restore.dump.gpg

# 2. Decrypt (will prompt; use the password-manager passphrase off-droplet)
gpg --batch --passphrase-file /root/.madonnahist-backup-passphrase \
    -o /tmp/restore.dump -d /tmp/restore.dump.gpg

# 3. Restore into a FRESH database (never over the live one without a plan)
sudo -u postgres createdb -p 5434 madonnahist_restore
sudo -u postgres pg_restore -p 5434 -d madonnahist_restore --no-owner /tmp/restore.dump

# 4. Verify before promoting: row counts, latest entry_date, a spot-read
sudo -u postgres psql -p 5434 -d madonnahist_restore -c \
  "SELECT (SELECT count(*) FROM calendar_days) AS days,
          (SELECT count(*) FROM day_corrections) AS corrections,
          (SELECT max(entry_date) FROM calendar_days) AS latest"

# 5. Clean up drill artifacts
sudo -u postgres dropdb -p 5434 madonnahist_restore
rm -f /tmp/restore.dump /tmp/restore.dump.gpg
```

Full-box recovery: install Postgres 17 + the roles (migrations
0001–0002 create them), restore as above into `madonnahist`, run
`./backend/db/migrate_pg.sh` (no-ops on an up-to-date dump), redeploy.

## Drill log

| Date | Dump | Result |
|---|---|---|
| 2026-07-24 | first nightly (manual run) | restored to scratch db on droplet; counts + latest entry_date matched live; dropped |

Annual drill: repeat the procedure above each January (and after any
Postgres major upgrade), append here.

## Failure response

- `/admin/system-health` DB Backup card shows FAILED + the error.
- Log: `ssh root@134.199.211.199 tail -50 /var/log/madonnahist-db-backup.log`
- Manual run: `ssh root@134.199.211.199 /opt/madonnahist/scripts/droplet/db-backup-to-spaces.sh`
