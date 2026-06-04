-- Migration 0014: Add soft-delete columns to correction_lexicon.
--
-- Admin curation needs to suppress junk lexicon pairs without granting DELETE
-- (which was revoked in 0013 for good reason). Soft-delete via is_active +
-- suppressed_at preserves the privilege boundary while letting the admin UI
-- hide bad entries and the OCR worker skip them.

ALTER TABLE correction_lexicon ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE correction_lexicon ADD COLUMN suppressed_at TIMESTAMPTZ;
