-- 0009_grid_lines.sql
-- Grid alignment UI: per-page grid definition, stale OCR prevention,
-- explicit row/col on calendar_days.

-- calendar_pages: grid definition + image dimensions + version counter
ALTER TABLE calendar_pages ADD COLUMN grid_lines JSONB;
ALTER TABLE calendar_pages ADD COLUMN grid_version INT NOT NULL DEFAULT 0;
ALTER TABLE calendar_pages ADD COLUMN image_width INT;
ALTER TABLE calendar_pages ADD COLUMN image_height INT;

-- calendar_days: explicit grid position for crop recomputation
ALTER TABLE calendar_days ADD COLUMN grid_row INT;
ALTER TABLE calendar_days ADD COLUMN grid_col INT;

-- job_runs: add 'canceled' to the status CHECK for superseded OCR jobs
ALTER TABLE job_runs DROP CONSTRAINT IF EXISTS job_runs_status_check;
ALTER TABLE job_runs ADD CONSTRAINT job_runs_status_check
  CHECK (status IN ('pending', 'in_progress', 'done', 'failed', 'canceled'));
