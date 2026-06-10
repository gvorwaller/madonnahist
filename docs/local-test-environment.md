# Local Test Environment

The local test environment must be isolated from BTC-dashboard, the production
SSH tunnel, and production DigitalOcean Spaces objects.

## Non-Negotiable Safety Rules

- Never use port `5433` for madonnahist tests. That port belongs to BTC-dashboard.
- Never use port `5435` for madonnahist tests. That port is the production DB tunnel.
- Never run local tests against `PGDATABASE=madonnahist`.
- Use the dedicated local test port `15434` and database `madonnahist_test`.
- Use `MADONNAHIST_ENV=test` for every local test command.
- Use `MADONNAHIST_OBJECT_STORE=local` for every local test command.
- Do not seed production DO Spaces credentials into the local test database.
- Do not restore production dumps into shared local Postgres clusters.

The migrations currently grant privileges to the canonical role names
`madonnahist_owner`, `madonnahist_app`, and `madonnahist_worker`. Local tests
therefore reuse those role names inside a dedicated repo-local Postgres cluster.
Isolation comes from the private data directory, port, database name, and env
guards, not from alternate role names.

## Files And Directories

- `.env.test` - ignored, machine-local test config.
- `.env.test.example` - committed template for `.env.test`.
- `.local/postgres-test/` - ignored repo-local Postgres data directory.
- `.local/postgres-test.log` - ignored Postgres log.
- `.local/object-store-test/` - ignored filesystem object store for image tests.

## Setup

```bash
cp .env.test.example .env.test
npm run test:env
npm run test:db:start
npm run test:db:reset
npm run test:db:migrate
npm run test:db:invariants
```

`npm run test:db:reset` drops and recreates only `madonnahist_test` on the
isolated local cluster. It also clears `.local/object-store-test/`.

## Running The App Against Test

Use the explicit test env file. Do not let the app infer `.env`.

```bash
npx vite dev --host 127.0.0.1 --port 5177 --strictPort --mode test
```

For scripts that support `tsx --env-file`, use:

```bash
npx tsx --env-file=.env.test <script>
```

## Object Store Behavior

When `MADONNAHIST_OBJECT_STORE=local`, the app and worker use the same object
keys as production but write files under `.local/object-store-test/` instead of
DigitalOcean Spaces. This makes destructive flows such as un-ingest, replace,
and reset safe to exercise locally.

Production still uses `private_data.api_credentials` for DO Spaces credentials.
The test DB should either have no `do_spaces` credentials or local-only fake
credentials. Production Spaces credentials do not belong in the test DB.

## Guardrails

The test scripts and migration runner refuse test-mode commands that target:

- `PGPORT=5433`
- `PGPORT=5435`
- `PGDATABASE=madonnahist`
- missing `MADONNAHIST_ENV=test`

If a test needs real captured images, copy samples into `.local/object-store-test/`
or ingest through the local object-store mode. Do not point tests at production
Spaces objects.
