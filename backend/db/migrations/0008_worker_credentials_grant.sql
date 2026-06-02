-- Migration 0008: Grant worker role access to API credentials + OCR idempotency guard
--
-- The madonnahist_worker role needs to read Spaces and Google Vision credentials
-- from private_data.api_credentials. Also adds a unique index on
-- ocr_runs.created_by_job_run_id to prevent duplicate OCR runs on job retry.

-- Worker needs Spaces creds + API keys from the credentials table
GRANT USAGE ON SCHEMA private_data TO madonnahist_worker;
GRANT SELECT ON private_data.api_credentials TO madonnahist_worker;

-- Prevent duplicate OCR runs when a job is retried after partial success
CREATE UNIQUE INDEX IF NOT EXISTS idx_ocr_runs_job_run_unique
    ON ocr_runs (created_by_job_run_id)
    WHERE created_by_job_run_id IS NOT NULL;

-- Google Vision API key must be inserted manually after migration:
--   INSERT INTO private_data.api_credentials (service_name, credential_key, credential_value, description)
--   VALUES ('google_vision', 'API_KEY', '<key>', 'Google Cloud Vision API key');
