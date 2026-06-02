-- 0010_warped_image.sql
-- Perspective warp support: store the de-skewed page image.

ALTER TABLE calendar_pages ADD COLUMN warped_image_path TEXT;
ALTER TABLE calendar_pages ADD COLUMN warped_width INT;
ALTER TABLE calendar_pages ADD COLUMN warped_height INT;
