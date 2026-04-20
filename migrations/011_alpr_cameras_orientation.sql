-- Tag every camera with an orientation so camera-snapshot can branch on it.
-- The existing Charlotte Travel Plaza 'Front Gate' camera is set to 'entry'
-- since it was positioned to catch incoming vehicles.

ALTER TABLE alpr_cameras
  ADD COLUMN orientation TEXT NOT NULL DEFAULT 'entry'
  CHECK (orientation IN ('entry', 'exit'));

-- Drop the default so every future INSERT must specify orientation explicitly.
ALTER TABLE alpr_cameras ALTER COLUMN orientation DROP DEFAULT;
