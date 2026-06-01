-- 0007_capture_intake.sql
-- Capture intake pipeline (docs/2026-05-29-capture-intake-pipeline.md).
--
-- Tracks every image discovered in the tether folder through its lifecycle:
--   unclassified -> classified -> ingested  (with reshoot / rejected branches)
-- The table is the single source of truth for what the /admin/capture UI shows
-- and the basis for crash-recoverable, idempotent ingestion.
--
-- Identity:        content_hash (SHA-256) dedups the same image under renamed paths.
-- Crash recovery:  ingest_phase / ingest_attempts / ingest_error track progress;
--                  spaces_object_key is computed before upload so retries are idempotent.
-- Reshoot:         supersedes_id links a re-capture to the original it replaces.

CREATE TABLE capture_intake (
  id              SERIAL PRIMARY KEY,
  tether_session  TEXT NOT NULL,           -- subfolder name, e.g. "20260525"
  camera_filename TEXT NOT NULL,           -- e.g. "P1034702.jpg"
  raw_filename    TEXT,                    -- paired RAW: "P1034702.RW2" or null
  source_path     TEXT NOT NULL,           -- full resolved path at discovery time

  -- Identity & dedup
  content_hash    TEXT NOT NULL,           -- SHA-256 of the JPG file contents
  file_size_bytes BIGINT NOT NULL,
  file_mtime      TIMESTAMPTZ NOT NULL,    -- filesystem mtime at discovery

  -- Classification
  proposed_year   INT,
  proposed_month  INT CHECK (proposed_month BETWEEN 1 AND 12),
  ocr_full_text   TEXT,                    -- raw OCR text from full-page Vision pass
  classification_confidence TEXT
    CHECK (classification_confidence IN ('high', 'medium', 'low')),

  -- Quality assessment
  sharpness_score       FLOAT,             -- Laplacian variance (higher = sharper)
  sharpness_corner_min  FLOAT,             -- worst corner sharpness score
  exposure_mean         FLOAT,             -- mean brightness 0-255
  exposure_clipped_pct  FLOAT,             -- % pixels clipped (<5 or >250)
  contrast_score        FLOAT,             -- luminance std dev
  quality_verdict TEXT NOT NULL DEFAULT 'pending'
    CHECK (quality_verdict IN ('pending', 'good', 'reshoot_advised', 'reshoot_required')),
  quality_notes   TEXT,                    -- human-readable quality issues

  -- Lifecycle
  status          TEXT NOT NULL DEFAULT 'unclassified'
    CHECK (status IN ('unclassified', 'classified', 'ingested', 'rejected', 'reshoot')),
  approved_year   INT,                     -- operator-confirmed year (may differ from proposed)
  approved_month  INT CHECK (approved_month BETWEEN 1 AND 12),
  grid_template_key TEXT,                  -- selected layout, e.g. "5-row-standard"
  page_id         INT REFERENCES calendar_pages(id),  -- set after ingestion

  -- Ingestion tracking (crash recovery)
  ingest_phase    TEXT
    CHECK (ingest_phase IN ('uploading', 'db_insert', 'enqueue_ocr')),
  ingest_attempts INT NOT NULL DEFAULT 0,
  ingest_error    TEXT,                    -- last error message if ingestion failed
  spaces_object_key TEXT,                  -- deterministic key, set before upload begins

  -- Reshoot tracking
  supersedes_id   INT REFERENCES capture_intake(id),  -- links reshoot to original

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  classified_at   TIMESTAMPTZ,
  approved_at     TIMESTAMPTZ,
  ingested_at     TIMESTAMPTZ,

  UNIQUE (tether_session, camera_filename),
  UNIQUE (content_hash)                    -- same image under different paths is rejected
);

CREATE INDEX idx_capture_intake_status ON capture_intake(status);
CREATE INDEX idx_capture_intake_hash   ON capture_intake(content_hash);

-- Grants. Migrations run as madonnahist_owner, so ALTER DEFAULT PRIVILEGES
-- (0004) already grants the app role CRUD here; this explicit grant documents
-- intent and is harmless if redundant. The worker role never touches intake.
GRANT SELECT, INSERT, UPDATE, DELETE ON capture_intake TO madonnahist_app;
GRANT USAGE, SELECT, UPDATE ON SEQUENCE capture_intake_id_seq TO madonnahist_app;
