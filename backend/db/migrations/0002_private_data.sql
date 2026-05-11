-- 0002_private_data.sql
-- Per cs.md § Database & Schema: API keys, vendor secrets, and other
-- credentials live in `private_data.api_credentials`, NEVER in .env files.
-- Workers and the web app read from this table via src/lib/credentials.ts.

CREATE SCHEMA IF NOT EXISTS private_data;

CREATE TABLE IF NOT EXISTS private_data.api_credentials (
  id SERIAL PRIMARY KEY,
  service_name TEXT NOT NULL,
  credential_key TEXT NOT NULL,
  credential_value TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Only one active row per (service, key). Inactive rows accumulate for audit.
CREATE UNIQUE INDEX IF NOT EXISTS api_credentials_active_unique
  ON private_data.api_credentials (service_name, credential_key)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS api_credentials_service_key_idx
  ON private_data.api_credentials (service_name, credential_key);

-- Grant the app role read-only access to credentials. Inserts/updates happen
-- via psql by an admin or via migrations — not via the running app.
GRANT USAGE ON SCHEMA private_data TO madonnahist_app;
GRANT SELECT ON private_data.api_credentials TO madonnahist_app;
