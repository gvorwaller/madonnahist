## MANDATORY: Use td for Task Management

Run td usage --new-session at conversation start (or after /clear). This tells you what to work on next.

Sessions are automatic (based on terminal/agent context). Optional:
- td session "name" to label the current session
- td session --new to force a new session in the same context

Use td usage -q after first read.

## Immediate Local Test Setup

For any local test, use the isolated repo-local test stack immediately:

- Config: `.env.test` from `.env.test.example`
- Database: `madonnahist_test` on `127.0.0.1:15434`
- Environment: `MADONNAHIST_ENV=test`
- Object store: `MADONNAHIST_OBJECT_STORE=local`
- Local image/object files: `.local/object-store-test/`

Quick start:

```bash
cp .env.test.example .env.test
npm run test:env
npm run test:db:start
npm run test:db:reset
npm run test:db:migrate
npm run test:db:invariants
```

Run the app against the test stack with:

```bash
npx vite dev --host 127.0.0.1 --port 5177 --strictPort --mode test
```

## Local Test Environment Safety

Follow `docs/local-test-environment.md` for all local tests.

- Never use port `5433` for madonnahist tests; it belongs to BTC-dashboard.
- Never use port `5435` for madonnahist tests; it is the production DB tunnel.
- Never run local tests against `PGDATABASE=madonnahist`.
- Use the dedicated local test database `madonnahist_test` on port `15434`.
- Use `MADONNAHIST_ENV=test` and `MADONNAHIST_OBJECT_STORE=local`.
- Do not seed production DigitalOcean Spaces credentials into the test DB.
- Do not restore production dumps into shared local Postgres clusters.

Use these commands for the isolated local test DB:

```bash
npm run test:env
npm run test:db:start
npm run test:db:reset
npm run test:db:migrate
npm run test:db:invariants
```
