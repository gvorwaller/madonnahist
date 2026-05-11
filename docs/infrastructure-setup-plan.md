# Infrastructure Setup (td-9c6107)

## Context

The madonnahist repo currently contains only documentation — no SvelteKit scaffold, no `backend/`, no `scripts/`, no PG cluster locally or on the production droplet. `td-9c6107` ("Set up infrastructure") gates every other Phase 1 task in the V4 plan (`docs/calendar-history-system-V4.md` § 11): scaffold (`td-2e0416`), schema/roles/triggers (`td-8a7e64`), auth (`td-510a34`), upload script (`td-ccb503`), OCR worker (`td-9a30ae`), correction UI (`td-3adb8a`), viewer (`td-bb8def`), and the end-to-end smoke (`td-7229cc`) all need this to land first.

The intended outcome of this task: a working local dev environment, a provisioned production droplet slot (PG cluster, app dir, PM2 entry, nginx server block, TLS, Spaces bucket), and a deploy script that gets code from local → prod with a green `/api/health` check. After this completes, the schema migration task (`td-8a7e64`) can apply V4 § 6 / § 8 DDL against both boxes.

Authoritative references:
- `docs/calendar-history-system-V4.md` § 5 (stack), § 6 (schema), § 8 (DB roles)
- `cs.md` § Production Infrastructure (droplet IP `134.199.211.199`, app port 3002, PG port 5434, app dir `/opt/madonnahist`, PM2 process name `madonnahist`, no domain-based SSH)
- `CLAUDE.md` (dev port 5176, no Tailwind, no Docker)

## Decisions (from interview)

1. **PG topology on droplet**: separate cluster on port 5434 via `pg_createcluster`. Matches BTC=5433 / siblings pattern; full isolation.
2. **Cloudflare TLS**: Full (Strict) with a Cloudflare origin cert installed in nginx; listen on 443.
3. **Spaces**: new bucket `madonnahist` in the same DO account, region `nyc3` (verify against droplet region), with one new access key/secret stored in `private_data.api_credentials`.
4. **DNS**: hold the `madonnahist` A record in Cloudflare until first successful deploy + green health check; verify pre-DNS via Host header / curl-resolve.

## Decisions (clarifying — locked before implementation)

5. **PostgreSQL major version**: **PG 17** on both local and droplet. Reuses the Homebrew `postgresql@17` binaries already installed on the Mac (BTC Dashboard runs on PG17 :5433). No PG 16 install. On the droplet, install `postgresql-17` if not already present; create a second cluster from those same binaries.
6. **DB roles are the only roles**. There is no `madonnahist_user`. The three V4 § 8 roles are the entire set:
   - `madonnahist_owner` — owns tables and triggers; used **only** by `migrate_pg.sh` and admin escape-hatch psql sessions.
   - `madonnahist_app` — used by the SvelteKit web app process. Connection string env vars below reference this role.
   - `madonnahist_worker` — used by every PM2 worker process (none in this task, but reserved).
   Any prior reference to `madonnahist_user` in this doc, `CLAUDE.md`, or `cs.md` is wrong and should be replaced with the correct V4 role. Local and prod use the same role names; only passwords differ.
7. **`/api/health` shape**: returns `{ db: "ok" | "error", spaces: "ok" | "not_configured" | "error", version: "<git sha>" }`. **Only `db` gates the deploy script.** `spaces: "not_configured"` is non-fatal and is the expected value between droplet provisioning (step D) and Spaces credential seeding (step E). Once Spaces creds are present, `spaces` must be `ok` or the deploy fails — but during initial bootstrap the deploy can complete green with Spaces not yet configured.
8. **Deploy / ownership model on droplet** (no ambiguity):
   - Deploy user: **`root`** (matches sibling apps on this droplet per `cs.md`).
   - App dir owner: `root:root` for `/opt/madonnahist/` and everything under it.
   - PM2 daemon: runs as `root`; `pm2 startup` registers the root daemon.
   - Production `.env`: `/opt/madonnahist/.env`, mode `600`, owned `root:root`. Loaded by PM2 via `ecosystem.config.cjs` (`env_file` or explicit `dotenv` import in the entrypoint).
   - Origin cert + key: `/etc/ssl/cloudflare/madonnahist.{crt,key}`, mode `600`, owned `root:root`.

## Approach

Sequenced so each step is independently verifiable. Don't move on until the previous step's check passes.

### A. Local dev infrastructure (Mac)

The Mac already has Homebrew `postgresql@17` installed and serving BTC Dashboard on port 5433. We reuse those binaries to stand up a **second cluster** on port 5434 — same Postgres major version, separate data dir, separate service.

1. Stand up a second PG 17 cluster for madonnahist on port `5434`:
   - Create a new data directory: `/opt/homebrew/var/postgresql@17-madonnahist`.
   - `/opt/homebrew/opt/postgresql@17/bin/initdb -D /opt/homebrew/var/postgresql@17-madonnahist --encoding=UTF8 --locale=en_US.UTF-8`.
   - Edit `<data_dir>/postgresql.conf`: `port = 5434`, `timezone = 'UTC'`, `listen_addresses = '127.0.0.1'`.
   - Edit `<data_dir>/pg_hba.conf`: local + 127.0.0.1 only; `scram-sha-256` for all roles.
   - Register a second Homebrew service that runs the same `postgres` binary against this data dir — either a hand-written LaunchAgent at `~/Library/LaunchAgents/homebrew.mxcl.postgresql@17-madonnahist.plist` (copy the canonical one, swap `-D` and label) or a wrapper script invoked via `brew services` (`brew services run`/`start` does not natively support two clusters on the same formula; LaunchAgent is the cleaner path). Confirm autostart at login.
2. As the bootstrap superuser, create the three V4 § 8 roles **and** the database. No `madonnahist_user`:
   ```sql
   CREATE ROLE madonnahist_owner  LOGIN PASSWORD :'owner_password';
   CREATE ROLE madonnahist_app    LOGIN PASSWORD :'app_password';
   CREATE ROLE madonnahist_worker LOGIN PASSWORD :'worker_password';
   CREATE DATABASE madonnahist OWNER madonnahist_owner;
   ```
   Passwords live in `.env` (gitignored) locally; not committed.
3. Add `~/.pgpass` entries (mode 600) for all three roles on `localhost:5434:madonnahist:…` so `psql -U madonnahist_app -d madonnahist` works without prompting.
4. Write `.env` (committed `.env.example` with placeholders, ignored `.env` with real values):
   - `PGHOST=127.0.0.1`, `PGPORT=5434`, `PGUSER=madonnahist_app`, `PGDATABASE=madonnahist`, `PGPASSWORD=…` — **app role only**; the SvelteKit dev server uses this connection.
   - `MIGRATION_PGUSER=madonnahist_owner`, `MIGRATION_PGPASSWORD=…` — read only by `backend/db/migrate_pg.sh`. Owner credentials never reach the web app process.
   - `AUTH_SECRET=…` (long random)
   - `PORT=5176`
   - No Spaces / vendor secrets here — those go in `private_data.api_credentials` per `cs.md`.

**Verify**:
- `psql -p 5434 -U madonnahist_app -d madonnahist -c "SELECT current_user, current_database();"` returns `madonnahist_app | madonnahist`.
- `psql -p 5434 -U madonnahist_owner -d madonnahist -c "SELECT current_user;"` returns `madonnahist_owner`.
- The existing BTC Dashboard cluster on 5433 still responds to `psql -p 5433 -U btc_user -d btc_dashboard -c "SELECT 1;"` (we did not disturb it).

### B. Repo scaffold

Files to create (paths are authoritative):

- `package.json`, `svelte.config.js`, `vite.config.ts`, `tsconfig.json` — SvelteKit init w/ TypeScript, `@sveltejs/adapter-node`, Svelte 5 runes. Mirror giftlist's setup; pin Node to match the droplet's version.
- `.gitignore`, `.npmrc`, `.nvmrc`.
- `src/app.html`, `src/routes/+layout.svelte`, `src/routes/+page.svelte` (placeholder homepage).
- `src/routes/api/health/+server.ts` — returns `{ db: "ok"|"error", spaces: "ok"|"not_configured"|"error", version: <git sha> }` per Decision 7. `db` is the deploy gate; `spaces: "not_configured"` is non-fatal during bootstrap. Connects as `madonnahist_app` (the app's normal pool).
- `src/lib/db.ts` — `pg` Pool singleton, reads `PG*` env vars (`PGUSER=madonnahist_app`), exports `query()` helper. No ORM. Does NOT have access to owner credentials.
- `src/lib/credentials.ts` — `credentialService.getCredential(service_name, credential_key)` per `cs.md` § Database & Schema. Caches per-process.
- `backend/db/migrate_pg.sh` — wraps `psql`, applies any `backend/db/migrations/*.sql` not yet recorded in `admin.schema_migrations(filename TEXT PK, applied_at TIMESTAMPTZ)`. Idempotent. Exits non-zero on any failure. **Connects as `madonnahist_owner` (via `MIGRATION_PGUSER` / `MIGRATION_PGPASSWORD`), not `madonnahist_app`** — DDL and grants need owner privileges that the runtime role lacks by design (V4 § 8).
- `backend/db/migrations/0001_admin_migrations.sql` — creates the `admin` schema and `schema_migrations` tracking table itself (chicken/egg: the script bootstraps this if missing).
- `backend/db/migrations/0002_private_data.sql` — creates `private_data` schema + `api_credentials` table per `cs.md` (`service_name`, `credential_key`, `credential_value`, `description`, `is_active`, `created_at`, `updated_at`; uniqueness on `(service_name, credential_key, is_active)` where `is_active = true`).
- `scripts/upload-page.mjs` — stub only (real impl is `td-ccb503`); exits with a "not implemented" notice so the file path is reserved.
- `scripts/deploy-to-DO.sh` — see step F.
- `ecosystem.config.cjs` — PM2 entry for the web app (`madonnahist`, port `3002`). Worker entries added later.
- `deploy/nginx.conf` — committed nginx server block (template); deploy script copies it into `/etc/nginx/sites-available/` only when its checksum changes.

V4 schema DDL (§ 6) and role grants (§ 8) — those land in `td-8a7e64`, not here. This task only creates the migration *infrastructure* and the two bootstrap migrations above.

**Verify**: `npm install && npm run check && npm run build` all clean (0 warnings baseline per `CLAUDE.md`). `npm run dev` serves the placeholder homepage on `:5176`. `backend/db/migrate_pg.sh` applies the two bootstrap migrations and is no-op on re-run.

### C. Droplet PG cluster

SSH as `root@134.199.211.199` (IP, never domain — per `cs.md`).

1. Verify Postgres 17 is installed (`dpkg -l postgresql-17`); if not, follow the PGDG repo path: add `apt.postgresql.org` to sources, then `apt install postgresql-17`.
2. `pg_createcluster 17 madonnahist --port=5434` (Debian/Ubuntu helper). If the helper isn't available, fall back to a manual `initdb` into `/var/lib/postgresql/17/madonnahist` + a dedicated systemd unit `postgresql@17-madonnahist.service` cloned from the default.
3. Edit `/etc/postgresql/17/madonnahist/postgresql.conf`:
   - `port = 5434`
   - `timezone = 'UTC'`
   - `listen_addresses = '127.0.0.1'` (no public exposure)
   - `shared_buffers`, `effective_cache_size`: conservative — droplet hosts three apps.
4. `/etc/postgresql/17/madonnahist/pg_hba.conf`: local + 127.0.0.1 only; `scram-sha-256`.
5. `pg_ctlcluster 17 madonnahist start`; `systemctl enable postgresql@17-madonnahist`; confirm autostart on boot.
6. As the bootstrap superuser (`sudo -u postgres psql -p 5434`), create the V4 § 8 roles + database (fresh passwords, distinct from local). No `madonnahist_user`:
   ```sql
   CREATE ROLE madonnahist_owner  LOGIN PASSWORD '…';
   CREATE ROLE madonnahist_app    LOGIN PASSWORD '…';
   CREATE ROLE madonnahist_worker LOGIN PASSWORD '…';
   CREATE DATABASE madonnahist OWNER madonnahist_owner;
   ```

**Verify**: `sudo -u postgres psql -p 5434 -d madonnahist -c "SELECT 1;"` returns 1; `psql -h 127.0.0.1 -p 5434 -U madonnahist_app -d madonnahist -c "SELECT current_user;"` returns `madonnahist_app`. From outside, `nc -zv 134.199.211.199 5434` is refused (PG not public).

### D. Droplet app slot

All paths owned by `root:root` per Decision 8.

1. `mkdir -p /opt/madonnahist`, owner `root:root`, mode `755`.
2. `git clone` the repo into `/opt/madonnahist` (deploy script does this on first run; manual the first time).
3. `npm ci && npm run build` (will fail until the scaffold from step B is committed and pulled).
4. Write `/opt/madonnahist/.env`, mode `600`, owner `root:root`:
   - **Runtime (loaded by the web app process)**: `PGHOST=127.0.0.1`, `PGPORT=5434`, `PGUSER=madonnahist_app`, `PGDATABASE=madonnahist`, `PGPASSWORD=<app password>`, `AUTH_SECRET=<long random>`, `PORT=3002`, `NODE_ENV=production`.
   - **Migration-only (read by `migrate_pg.sh`, not by the app process)**: `MIGRATION_PGUSER=madonnahist_owner`, `MIGRATION_PGPASSWORD=<owner password>`.
   - No Spaces or vendor secrets — those live in `private_data.api_credentials` (loaded into the DB during step E).
5. Apply bootstrap migrations: `backend/db/migrate_pg.sh` (connects as `madonnahist_owner`).
6. Seed `private_data.api_credentials` with Spaces creds (step E) — until done, `/api/health` returns `spaces: "not_configured"`, which is acceptable for an initial deploy.
7. PM2 register as root: `pm2 start ecosystem.config.cjs`; `pm2 save`; `pm2 startup systemd -u root --hp /root` so the daemon survives reboot.

**Verify**:
- `pm2 status` shows `madonnahist` online running as `root`.
- `curl -s http://127.0.0.1:3002/api/health | jq` returns 200 with `db: "ok"`. `spaces` is either `"ok"` (if Spaces creds already seeded) or `"not_configured"` (if not yet) — both are acceptable for this step. `version` reflects the deployed git sha.
- `stat -c '%U:%G %a' /opt/madonnahist/.env` → `root:root 600`.

### E. DigitalOcean Spaces

1. Create bucket `madonnahist` in `nyc3` (verify droplet region first; if droplet is elsewhere, match it).
2. Default ACL: **private**. Phase 1 viewer fetches via signed URLs from the SvelteKit server — defer the public-prefix decision until image paths are actually wired (`td-ccb503` / viewer).
3. CORS rule: allow GET from `https://madonnahist.gaylon.photos` only.
4. Generate a Spaces access key dedicated to madonnahist (don't reuse sibling keys).
5. Insert one row per credential into `private_data.api_credentials` on **both** local and prod PG:
   - `SPACES_KEY`, `SPACES_SECRET`, `SPACES_BUCKET`, `SPACES_REGION`, `SPACES_ENDPOINT` under `service_name = 'do_spaces'`.

**Verify**: A throwaway `aws s3 ls s3://madonnahist --endpoint-url=https://nyc3.digitaloceanspaces.com` (with the new key) succeeds. After credential seeding, `/api/health` flips `spaces` from `"not_configured"` to `"ok"`. From this point forward, `spaces: "ok"` is the expected steady-state and `spaces: "error"` (credentials present but request failing) is a deploy failure.

### F. Nginx + Cloudflare TLS

1. Generate a Cloudflare origin certificate (`gaylon.photos`, includes `*.gaylon.photos` and `madonnahist.gaylon.photos`); install at `/etc/ssl/cloudflare/madonnahist.crt` + `.key`, mode 600.
2. Create `/etc/nginx/sites-available/madonnahist.gaylon.photos`:
   - `listen 443 ssl http2;` with the origin cert.
   - `listen 80;` → `return 301 https://...;`
   - `server_name madonnahist.gaylon.photos;`
   - `proxy_pass http://127.0.0.1:3002;` with standard `X-Forwarded-*`, `X-Real-IP`, `Host`.
   - `client_max_body_size` modest (1m); upload-page.mjs is a Node script, not browser-driven.
3. Symlink to `sites-enabled/`, `nginx -t`, `systemctl reload nginx`.
4. Cloudflare zone: confirm SSL/TLS mode is **Full (Strict)** for `gaylon.photos`. If siblings are on something looser, this is the moment to upgrade — coordinate.

**Verify pre-DNS**: `curl -k --resolve madonnahist.gaylon.photos:443:134.199.211.199 https://madonnahist.gaylon.photos/api/health` returns 200.

### G. Deploy script + DNS

1. Write `scripts/deploy-to-DO.sh` (modeled on `giftlist`'s — borrow patterns rather than reinvent):
   - Push current branch.
   - SSH by IP (`root@134.199.211.199`), never domain.
   - Remote: `cd /opt/madonnahist && git pull --ff-only && npm ci && npm run build && backend/db/migrate_pg.sh`. `migrate_pg.sh` sources `/opt/madonnahist/.env` and uses `MIGRATION_PGUSER` / `MIGRATION_PGPASSWORD` (owner role) — not the runtime `PGUSER`.
   - If `deploy/nginx.conf` checksum changed, copy to `/etc/nginx/sites-available/`, `nginx -t`, reload nginx.
   - `pm2 restart ecosystem.config.cjs --update-env`.
   - Health-check loop: poll `https://madonnahist.gaylon.photos/api/health` (once DNS is up) **or** `--resolve`-pinned to droplet IP pre-DNS; up to 30s. **Gate: `db == "ok"`.** Tolerate `spaces == "not_configured"` (bootstrap). Fail on `db == "error"` or `spaces == "error"`.
2. Run the deploy script. Confirm green.
3. **Now** create the Cloudflare DNS record: `madonnahist` A record → `134.199.211.199`, proxy on (orange cloud). TTL auto.
4. After Cloudflare DNS propagates (≤ 1 min with proxy), re-hit `https://madonnahist.gaylon.photos/api/health` *without* `--resolve` and confirm green.

**Verify (end-to-end smoke for this task)**:
- Local: `psql -U madonnahist_app -p 5434 -d madonnahist` works; `npm run dev` boots on :5176; `/api/health` returns 200 with `db: "ok"`, `spaces` either `"ok"` or `"not_configured"`.
- Prod: `curl https://madonnahist.gaylon.photos/api/health` returns 200 with `{ db: "ok", spaces: "ok", version: "<sha>" }` after Spaces creds are seeded. Deploy gate is `db: "ok"` alone — `spaces: "not_configured"` does not block the deploy during bootstrap.
- Role separation visible at runtime: `SELECT current_user FROM pg_stat_activity WHERE application_name LIKE '%madonnahist%'` shows `madonnahist_app` for the SvelteKit process and `madonnahist_owner` only briefly when migrations run.
- Migrations: `admin.schema_migrations` on prod lists `0001_admin_migrations.sql` and `0002_private_data.sql`.
- Idempotency: re-running `backend/db/migrate_pg.sh` is a no-op (no migrations re-applied).
- Re-running `./scripts/deploy-to-DO.sh` is a no-op (no nginx reload, PM2 restart only) and health stays green.

## Existing patterns to reuse (sibling apps)

- **giftlist's `scripts/deploy-to-DO.sh`** — same droplet, same Cloudflare setup, same nginx pattern. Copy structure; change app name, port (3002), PM2 process name (`madonnahist`), and app dir (`/opt/madonnahist`).
- **giftlist's `backend/db/migrate_pg.sh`** if it exists in the same shape — same tracking-table approach. Worth a one-shot read before writing ours from scratch.
- **giftlist's nginx server block** — same TLS pattern (origin cert + Full Strict). Copy as a template.
- **giftlist's PM2 ecosystem config** — same shape, different process name + port + env file path.

These live in a separate repo on the local machine; read them before writing equivalent files here, but don't symlink/share — each app owns its own copy.

## Out of scope for this task (deferred to other Phase 1 tickets)

- V4 § 6 schema (`calendar_pages`, `calendar_days`, `ocr_runs`, etc.), § 6.1 triggers, § 8 grants/RLS → **td-8a7e64**.
- argon2id auth, sessions, route guards, user seeding → **td-510a34**.
- `scripts/upload-page.mjs` real implementation → **td-ccb503**.
- OCR worker + vendor adapter → **td-9a30ae**.
- Correction UI, viewer routes → **td-3adb8a**, **td-bb8def**.
- Backup automation (V4 § 9.10) → Phase 4.
- Worker PM2 entries → added when workers themselves land.

## Files this task creates / modifies

**Local repo (new files):**
- `package.json`, `svelte.config.js`, `vite.config.ts`, `tsconfig.json`, `.gitignore`, `.npmrc`, `.nvmrc`, `.env.example`
- `src/app.html`
- `src/routes/+layout.svelte`, `src/routes/+page.svelte`
- `src/routes/api/health/+server.ts`
- `src/lib/db.ts`, `src/lib/credentials.ts`
- `backend/db/migrate_pg.sh`
- `backend/db/migrations/0001_admin_migrations.sql`
- `backend/db/migrations/0002_private_data.sql`
- `scripts/upload-page.mjs` (stub)
- `scripts/deploy-to-DO.sh`
- `ecosystem.config.cjs`
- `deploy/nginx.conf`

**Droplet (one-time provisioning, no repo file):**
- New PG 17 cluster `madonnahist` on `:5434` (`/etc/postgresql/17/madonnahist/`, owned `postgres:postgres`)
- `/opt/madonnahist/` git checkout + production `.env` (mode 600, owned `root:root`)
- PM2 daemon registration of `madonnahist` process as `root`, `pm2 save`, `pm2 startup systemd -u root --hp /root`
- `/etc/nginx/sites-available/madonnahist.gaylon.photos` symlinked into `sites-enabled/`
- `/etc/ssl/cloudflare/madonnahist.{crt,key}` (origin cert, mode 600, owned `root:root`)

**External (provisioning, no repo file):**
- DO Spaces bucket `madonnahist` in `nyc3` (or droplet region) — private ACL, CORS allow `madonnahist.gaylon.photos`
- DO Spaces access key dedicated to madonnahist
- Cloudflare DNS A record `madonnahist.gaylon.photos` → `134.199.211.199`, proxy on (last step only)

## Risks and watch-outs

- **`pg_createcluster` may not exist** on the droplet's exact distro. If so, fall back to manual `initdb` + systemd unit; allot extra time.
- **Cloudflare SSL mode mismatch**: if `gaylon.photos` is currently on Flexible rather than Full Strict, flipping it affects siblings too. Check first; if siblings aren't ready for Strict, install the origin cert and switch to Strict in one coordinated push.
- **Domain-based SSH** is a documented historical failure in `cs.md` — every SSH call in the deploy script must use the IP literal.
- **Re-running migrations across boxes**: per `cs.md`, migration tracking is per-box. Never run raw `psql -f` on either box during this setup; only `migrate_pg.sh`.
- **Origin cert expiration**: Cloudflare origin certs default to 15 years, but record the expiration in a calendar entry or `app_state` row anyway.
- **Role-name drift in existing docs**: `CLAUDE.md` and `cs.md` currently reference `madonnahist_user`. Those references are inherited from a pre-V4 draft and are wrong. Decision 6 supersedes them. Updating `CLAUDE.md` / `cs.md` to the three-role model is out of scope for this infrastructure task — fold into `td-8a7e64` (schema/roles) since that ticket already touches the role topic.
- **Two PG clusters on one Mac**: `brew services` does not natively support a second cluster on the same formula. Either hand-roll the LaunchAgent (Decision 5 / step A.1) or accept a manual `pg_ctl start` per session. Document the chosen approach in `docs/devlog/` so future maintainers don't fight it.
