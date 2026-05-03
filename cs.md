# AI Assistant Session Guide

## Session Startup (Required)
1. Read `cs.md` (this file) — hard rules that override defaults
2. Read `CLAUDE.md` — project architecture and patterns
3. Read `docs/calendar-history-system.md` — authoritative system spec (architecture, data model, pipeline, phases)
4. Read `docs/Calendar_Digitization_Plan.md` — capture-side guide (hardware, OCR vendors, scanning best practices)
5. Check recent devlog entries in `docs/devlog/`
6. Run `td usage --new-session` to see current tasks

---

## Core Principles

### No Assumptions
- **Never guess** when you can verify — read source code, check config files, test directly
- **Never assume the user's environment** — don't guess what device, browser, or OS they're using
- **Never assume infrastructure details** — read deploy scripts, config files, and connection strings instead of guessing
- **State uncertainty explicitly** — if you must hypothesize, say so and ask for confirmation
- **Ask when uncertain** — one question is cheaper than one wrong assumption

### No Quick Fixes
- Find root causes, not band-aids
- Implement maintainable solutions
- If a fix requires multiple rounds, slow down and trace the data flow

### Evidence-Based Debugging (MANDATORY)
When diagnosing errors, follow this methodology instead of guessing:

1. **Read the relevant source code** before forming any hypothesis
2. **Trace the data flow** — client -> API route -> server module -> database -> response
3. **Test each layer independently** — use curl, direct DB queries, or browser devtools
4. **Compare expected vs actual** at each boundary
5. **Never assume a cause** — verify with evidence first, then propose a fix

> "No guesses, only solid evidence, tracing the code carefully."

---

## Production Infrastructure

### DigitalOcean Droplet (Shared with gaylonphotos and giftlist)
- **SSH**: `ssh root@134.199.211.199`
- **App directory**: `/opt/madonnahist`
- **App port**: `3002` (gaylonphotos=3000, giftlist=3001, madonnahist=3002)
- **Process manager**: PM2 (NOT systemd)
  - Restart: `pm2 restart ecosystem.config.cjs --update-env`
  - Logs: `pm2 logs madonnahist --lines 30`
- **Domain**: `madonnahist.gaylon.photos` — proxied through Cloudflare (HTTP only, NOT SSH)
- **Image storage**: **DigitalOcean Spaces** — original page scans and per-day crops live in Spaces, not on the droplet. The droplet stays small; image accumulation does not threaten disk. Spaces credentials live in `private_data.api_credentials` (never `.env`).
- **Deploy script**: `./scripts/deploy-to-DO.sh` (when created) — must push, pull on droplet, install, build, run `migrate_pg.sh`, restart PM2, health-check, reload nginx

### Deploying
**Always use `./scripts/deploy-to-DO.sh` to deploy** once it exists. Never manually SSH and run build commands. The script handles push, pull, install, build, migration, PM2 restart, and health check end-to-end.

### Critical: SSH Is NOT the Domain
`madonnahist.gaylon.photos` resolves to Cloudflare IPs, not the droplet. **Always use the IP `134.199.211.199` for SSH.** The deploy script already does this correctly — follow its example.

### Sessions
Session cookies must be httpOnly, secure, SameSite=Strict. Authenticated access only — admin (correction UI, full read/write) and family viewers (read-only). No public registration.

### Shared Droplet Awareness
This app co-locates with **gaylonphotos (port 3000)** and **giftlist (port 3001)** on the same droplet. Be mindful of:
- **Memory** — three apps share RAM. Image-processing workers (Sharp, OCR pipeline) can spike memory; cap concurrency.
- **Disk** — page images live in DO Spaces, not on the droplet, so disk growth is bounded. Still monitor `/opt/madonnahist` for logs and any local caches.
- **Ports**: app=`3002` (gaylonphotos=3000, giftlist=3001); PostgreSQL=`5434` (BTC Dashboard=5433)
- **PM2 process name** — `madonnahist` (avoid generic names)
- **Nginx config** — separate server block for `madonnahist.gaylon.photos`

---

## Project-Specific Rules

### CSS & UI
- **No Tailwind. No utility frameworks.** Component-scoped `<style>` blocks only.
- **No toast notifications.** Use modal confirmation dialogs for destructive actions and feedback.
- WCAG AAA contrast ratios (7:1) for all text — including muted text
- Status badges always use color + text label — never color alone

**Modal pattern (instead of toasts):**
```jsx
<div className="modal-overlay">
  <div className="modal-content">
    <h3>Delete Item</h3>
    <p>Are you sure? This action cannot be undone.</p>
    <div className="modal-actions">
      <button className="btn-cancel" onClick={onCancel}>Cancel</button>
      <button className="btn-danger" onClick={onConfirm}>Delete</button>
    </div>
  </div>
</div>
```

**Rationale**: Toast notifications are interruptive, easily missed, and add visual noise. Modal confirmations are explicit, contextual, and cannot be ignored.

### Data Integrity (SACRED RULES)
This is a **historical archive of irreplaceable family records**. Data integrity rules are stricter here than in a typical app — a corrupted entry from 1972 cannot be re-derived.

**NEVER:**
- Create synthetic or placeholder data (IDs, timestamps, dummy entries)
- Use fallback data to mask broken code
- Add schema columns/fields that don't exist
- Use hidden default values for DB/env parameters
- Modify production data without explicit user confirmation
- Permanently delete `calendar_pages`, `calendar_days`, or original images — soft-delete only
- **Overwrite `corrected_text` with automated output** — human-validated text is sacred. OCR re-runs touch `ocr_initial_text` only.

**ALWAYS:**
- Use actual unique constraints from the schema (e.g., `calendar_days.entry_date`)
- Fix root causes when data is missing — never paper over with defaults
- Handle missing parameters as explicit errors with user notification
- Write human-readable audit log entries for all mutations to `corrected_text`, `correction_status`, and `tags`
- Keep database transactions short to avoid lock contention
- Validate at system boundaries (API routes), trust internal code
- Preserve original page images on disk forever — never auto-delete after OCR

---

## Database & Schema (PostgreSQL)

### Connection
- **Engine**: Native PostgreSQL (Homebrew on dev, package install on prod) — no Docker
- **Port**: `5434` (BTC Dashboard uses 5433 — keep them separate)
- **Database**: `madonnahist`
- **User**: `madonnahist_user`
- **PATH**: PostgreSQL bin should be on PATH via `~/.zshrc` — use `psql` directly
- **Query command**:
  ```bash
  psql -p 5434 -U madonnahist_user -d madonnahist -c "YOUR SQL HERE;"
  ```
- **Interactive shell**:
  ```bash
  psql -p 5434 -U madonnahist_user -d madonnahist
  ```
- **Critical**: Timezone must be set to `UTC` in `postgresql.conf`. All app code stores/queries timestamps in UTC; format for display only at the edge.

### Migrations
- **Migrations only**: DDL changes go in `./backend/db/migrations/`, never inline in app code
- **Migration tool**: Always use `./backend/db/migrate_pg.sh` (logs each filename to a tracking table so it runs exactly once per box)
- **Never use raw `psql -f` for migrations** — it skips tracking and the deploy will re-run them on the other box
- **Production migrations**: If you make a DB change, CREATE A MIGRATION FILE — deploy script runs migrations on prod automatically
- **Per-box state**: Migration tracking is per-box, not synced. If you change DB state on one box via raw psql, the other box won't know and will re-run any matching migration on next deploy.
- **Unique constraints**: Respect schema-defined constraints (e.g., `ON CONFLICT (...)`)

### API Keys & Secrets
- Stored in a dedicated credentials table (e.g., `private_data.api_credentials`), NEVER in `.env` files
- Schema: `service_name`, `credential_key`, `credential_value`, `description`, `is_active`, `created_at`, `updated_at`
- Query pattern:
  ```sql
  SELECT credential_value FROM private_data.api_credentials
  WHERE service_name = 'xxx' AND credential_key = 'api_key' AND is_active = true
  ORDER BY created_at DESC LIMIT 1
  ```
- Use a `credentialService.getCredential('service_name', 'api_key')` helper for all credential access

### Type Safety Across the SQL Boundary
PostgreSQL has type quirks that bite if ignored:
- **NUMERIC returns as strings** — use `Number()` or cast to `::float8` in SQL, or you'll get string concatenation instead of arithmetic
- **JSONB returns as objects** (unlike SQLite, which returns JSON as strings) — never `JSON.parse()` JSONB results without checking type first: `typeof x === 'string' ? JSON.parse(x) : x`
- **Timestamps** — always store as `TIMESTAMPTZ`, always work in UTC, format for display at the edge

---

## Development Workflow
- **Dev server port**: `5176` (5173 BTC Dashboard, 5175 giftlist, 5176 madonnahist)
- **Always `cd` back** to project root after operations
- **Use absolute paths** when possible to avoid directory confusion
- **Commits**: Only commit when explicitly asked
- **Server restarts**: Ask the user to restart the dev server after config changes

### Verification Commands
- `npm run build` — production build (always run after code changes)
- `npm run check` — type checking + framework diagnostics, 0 warnings baseline
- Run both before committing. If `npm run check` reports new warnings, fix them before commit.

---

## State Tracking Tools
- `td` — task management CLI (run `td usage --new-session` at session start)
- `nn` — append timestamped entry to today's devlog (`docs/devlog/YYYY-MM-DD.md`)
- `ctx` — export full context for session continuity

---

## Adversarial Code Review (MANDATORY)

After making ANY code changes, conduct a hostile review as if you're trying to break the code:

### Return Value Verification
- **Check every function's actual return type** — don't assume, read the source
- **Trace return values end-to-end** — from function call through all consumers
- **Verify wrapper functions** — `queryPg()` vs raw `pg` have different return shapes

### Type Safety Across Boundaries
- **Before `JSON.parse()`** — always check: `typeof x === 'string' ? JSON.parse(x) : x`
- **API responses** — verify the actual shape, don't assume
- **NUMERIC arithmetic** — verify the value isn't a string before adding

### Side Effect Analysis
- **Follow the data flow** — what consumes this value downstream?
- **Check all callers** — use grep/search to find every call site
- **Verify error handling** — does null/undefined propagate safely?
- **Check `await`** — async functions without `await` return Promises, which spread to nothing

### The Codex Test
Before marking any task complete, ask yourself:
1. "If a hostile code reviewer looked at this, what would they find?"
2. "What assumptions am I making that I haven't verified?"
3. "Did I read the source of every function I'm calling?"

---

## Quality Doctrine
- Assume production load and recovery requirements
- No silent failures or implicit defaults
- Logging, metrics, and persistence are mandatory for long-running operations
- Isolation of state (workers, queues, DB) is required
- Testing must validate resilience, not just functionality

---

## Historical Failures (Learn From These)
*(Inherited from sibling projects — same infrastructure pattern, same mistakes to avoid)*

- **SSH by domain**: Used `ssh root@<domain>` — timed out because domain resolves to Cloudflare, not the droplet. Always SSH by IP.
- **Wrong process manager**: Used `systemctl restart <app>` — failed because apps use PM2, not systemd. Always use `pm2 restart`.
- **Manual deploy**: Tried manual `ssh` + `npm run build` to deploy — timed out, host key failures. Deploy scripts handle everything correctly. Never deploy manually.
- **Synthetic data**: Synthetic IDs/timestamps added to mask broken inserts — broke uniqueness invariants. Never fabricate data to make code "work."
- **Missing `await`**: Async function returned a Promise that got spread/consumed as a value, yielding empty/undefined results. Always `await` async calls.
- **NUMERIC string concatenation**: PostgreSQL NUMERIC returned as string caused `"1" + "2" === "12"` instead of `3`. Cast or coerce at the boundary.
- **JSONB type drift**: SQLite returned JSON as strings; PostgreSQL JSONB returns objects. Code ported between them must handle both.
- **Missing import causing CPU spike**: A missing import threw `ReferenceError` in a hot loop, pegging CPU at 100%. Always run a smoke test after refactors.

### Key Principle
> Assumptions are the enemy. Read the code. Read the config. Test the layer. Only then diagnose.
