-- Migration 0011: Fix ocr_runs unique index for page-level OCR jobs.
--
-- A page_ocr job produces one ocr_runs row per day (up to 31 rows per job).
-- The old index on (created_by_job_run_id) alone would reject the second row.
-- New index: (created_by_job_run_id, day_id) — one OCR result per job per day.

DROP INDEX IF EXISTS idx_ocr_runs_job_run_unique;

CREATE UNIQUE INDEX idx_ocr_runs_job_run_unique
    ON ocr_runs (created_by_job_run_id, day_id)
    WHERE created_by_job_run_id IS NOT NULL;
