-- Migration 0015: Seed admin user for the /admin auth stub.
--
-- The correction UI migration (0012) seeds Madonna (corrector).
-- The admin vocabulary UI needs a Gaylon admin user to exist.
-- Placeholder password hash — real auth lands with td-510a34.

INSERT INTO users (username, display_name, role, password_hash)
VALUES ('gaylon', 'Gaylon', 'admin', 'placeholder-argon2id')
ON CONFLICT (username) DO NOTHING;
