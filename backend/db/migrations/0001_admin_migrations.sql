-- 0001_admin_migrations.sql
-- Tracking table for applied migrations. The migrate_pg.sh script bootstraps
-- this same shape before running any migration; this file exists so it's
-- visible in the migration history table itself.

CREATE SCHEMA IF NOT EXISTS admin;

CREATE TABLE IF NOT EXISTS admin.schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
