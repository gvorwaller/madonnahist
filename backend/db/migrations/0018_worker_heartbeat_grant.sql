-- Grant worker role INSERT/UPDATE on app_state for heartbeat writes.
-- The worker writes a single key ('worker_heartbeat') with pid/rss/timestamp.
GRANT INSERT, UPDATE ON app_state TO madonnahist_worker;
