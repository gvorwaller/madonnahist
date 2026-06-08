-- GIN index for efficient month-claim lookups via @> on queue_scope
CREATE INDEX IF NOT EXISTS idx_correction_sessions_scope_active
  ON correction_sessions USING gin (queue_scope)
  WHERE status IN ('active', 'paused');

-- Staleness threshold config (hours of inactivity before a claim is overridable)
INSERT INTO app_state (key, value)
  VALUES ('claim_stale_hours', '4')
  ON CONFLICT (key) DO NOTHING;
