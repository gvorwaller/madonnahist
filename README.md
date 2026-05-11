# madonnahist

Private family-access web app: ~60 years of handwritten family calendars → OCR + LLM cleanup → human-corrected transcripts → searchable archive.

Authoritative docs: [`docs/calendar-history-system-V4.md`](docs/calendar-history-system-V4.md) (system spec), [`docs/ui-mockups-V2.md`](docs/ui-mockups-V2.md) (UI), [`docs/equipment-shortlist.md`](docs/equipment-shortlist.md) (capture rig), [`docs/infrastructure-setup-plan.md`](docs/infrastructure-setup-plan.md) (this infra build).
Agent rules: [`CLAUDE.md`](CLAUDE.md), [`cs.md`](cs.md).

---

## Stack

SvelteKit (TS, adapter-node, Svelte 5 runes) → PM2 → nginx → Cloudflare. PostgreSQL 17 source of truth. DigitalOcean Spaces for images. No Tailwind.

## Infrastructure reference

| Item | Local (Mac) | Production (droplet) |
|---|---|---|
| Host | this machine | `134.199.211.199` (Ubuntu 24.04, shared with `gaylonphotos`, `giftlist`) |
| App port | `5176` (dev) | `3002` |
| App entry | `npm run dev` | PM2 `madonnahist` → `node --env-file=.env build/index.js` |
| App dir | this repo | `/opt/madonnahist` (root:root) |
| `.env` | repo root (gitignored, 600) | `/opt/madonnahist/.env` (root:root, 600) |
| Public URL | http://localhost:5176 | https://madonnahist.gaylon.photos |
| Nginx | n/a | `/etc/nginx/sites-enabled/madonnahist.gaylon.photos` → `127.0.0.1:3002`, HTTP-only on `:80` |
| Cloudflare | n/a | A record `madonnahist` → droplet, **Proxied**, zone TLS mode = Flexible |

### PostgreSQL

| | Local | Production |
|---|---|---|
| Binary | Homebrew `postgresql@17` | PGDG `postgresql-17` |
| Port | `5434` | `5434` |
| Cluster name | (LaunchAgent `homebrew.mxcl.postgresql@17-madonnahist`) | `madonnahist` (`pg_lsclusters` shows it) |
| Data dir | `/opt/homebrew/var/postgresql@17-madonnahist` | `/var/lib/postgresql/17/madonnahist` |
| Config | same data dir, `postgresql.conf` + `pg_hba.conf` | `/etc/postgresql/17/madonnahist/` |
| Listen | `127.0.0.1` only | `127.0.0.1` only |
| Timezone | UTC | UTC (`Etc/UTC`) |
| Database | `madonnahist` | `madonnahist` |
| Autostart | LaunchAgent at login | `systemctl enable postgresql` |

**Roles** (V4 § 8 — there is no `madonnahist_user`):
- `madonnahist_owner` — owns tables/triggers; used only by `migrate_pg.sh` and ad-hoc admin psql.
- `madonnahist_app` — runtime role for the SvelteKit web app. No UPDATE on canonical correction columns of `calendar_days`, no DELETE on history tables (V4 § 8).
- `madonnahist_worker` — reserved for OCR/LLM/entity/summary workers. RLS-scoped insert on `day_tags` / `day_entities` (`source='ai'` only).

Local: bare `psql -p 5434 -U <role> -d madonnahist` (passwords in `~/.pgpass`).
Prod: `sudo -u postgres psql -p 5434 -d madonnahist` or `psql -h 127.0.0.1 -p 5434 -U <role> -d madonnahist` (passwords in `/opt/madonnahist/.env`).

### DigitalOcean Spaces

- Bucket: `madonnahist` (region `sfo3`, matches droplet)
- Endpoint: `https://sfo3.digitaloceanspaces.com` (region); virtual-host form `https://madonnahist.sfo3.digitaloceanspaces.com`
- Access key: `madonnahist-app` — **Limited Access** to the bucket only, RWD permissions
- File listing: Restricted
- CORS: GET from `https://madonnahist.gaylon.photos` only, max age 3600

Credentials live in Postgres (`private_data.api_credentials` table, `service_name='do_spaces'`) — **never** `.env`. Loaded via `src/lib/credentials.ts` → `credentialService.getCredential('do_spaces', 'SPACES_KEY')`.

### Environment variables (.env)

Both local and prod use the same keys (different passwords):

```
# Runtime (loaded by SvelteKit web app)
PGHOST=127.0.0.1
PGPORT=5434
PGDATABASE=madonnahist
PGUSER=madonnahist_app
PGPASSWORD=...

# Migration-only (loaded by backend/db/migrate_pg.sh, NOT by the app)
MIGRATION_PGUSER=madonnahist_owner
MIGRATION_PGPASSWORD=...

# Worker (reserved)
WORKER_PGUSER=madonnahist_worker
WORKER_PGPASSWORD=...

AUTH_SECRET=...
PORT=5176   # 3002 in prod
NODE_ENV=development   # production in prod
```

See `.env.example` for the template. Spaces and any other vendor secrets do NOT go here.

---

## Commands

```bash
# Dev server (port 5176)
npm run dev

# Type/diagnostics — 0 warnings baseline
npm run check

# Production build
npm run build

# Apply pending DB migrations (idempotent; connects as owner role)
./backend/db/migrate_pg.sh

# Deploy local → main → droplet (push, build, migrate, pm2 restart, health-check)
./scripts/deploy-to-DO.sh
```

Migrations live in `backend/db/migrations/`. Tracking table: `admin.schema_migrations`. Per-box state — never run raw `psql -f` on a migration file; always use the script.

## Health endpoint

`GET /api/health` → `{ "db": "ok"|"error", "spaces": "ok"|"not_configured"|"error", "version": "<git sha>" }`

- `db == "ok"` is the deploy gate.
- `spaces == "not_configured"` is non-fatal (bootstrap state, before credentials seeded).
- `spaces == "error"` is a real failure (credentials present but request failing).

## Deploy

Always use `./scripts/deploy-to-DO.sh`. Never manual SSH + build. SSH to droplet uses **IP** `134.199.211.199`, never the domain (Cloudflare resolves to its own IPs).

## Phases

Per V4 § 11:
1. **Foundation** (in progress) — DB, auth, page upload, OCR worker, correction UI, basic viewer. Infra (`td-9c6107`) ✅ done.
2. **UX & Search** — refined cropping, FTS, calendar nav, mobile viewer polish.
3. **AI enrichment** — LLM cleanup, entity extractor, name aliases, person pages.
4. **Narrative & Polish** — summary generator, book view, Transkribus training, pgvector, backup automation.
