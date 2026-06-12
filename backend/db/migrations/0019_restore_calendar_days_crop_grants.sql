-- Reassert the app role's legitimate calendar_days update surface.
--
-- Production had migration 0006 recorded, but the current grants were missing
-- day_image_path, which prevented the crop backfill script from recording
-- pre-generated crop objects. Keep this narrow: these are operational/editor
-- columns only, not human-truth correction columns.

GRANT UPDATE (
  day_image_path,
  crop_template_id,
  crop_bounds,
  last_opened_by,
  last_opened_at,
  editing_started_at,
  current_session_id,
  ai_summary,
  updated_at
) ON calendar_days TO madonnahist_app;
