-- Grant DELETE on ocr_runs and llm_draft_runs to madonnahist_app
-- so the resetOcr admin action can clear OCR results for a page.
GRANT DELETE ON ocr_runs TO madonnahist_app;
GRANT DELETE ON llm_draft_runs TO madonnahist_app;
