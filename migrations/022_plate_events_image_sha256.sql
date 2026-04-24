-- 022_plate_events_image_sha256.sql
-- Adds SHA-256 hash of the captured JPEG to plate_events so camera-snapshot
-- can detect byte-identical frames from stationary vehicles and skip the
-- Plate Recognizer API call entirely. Significantly cuts PR costs and
-- cellular data usage at multi-tenant properties where trucks/cars idle
-- in front of cameras for minutes at a time.
--
-- Applied to prod 2026-04-24 via supabase MCP apply_migration.

ALTER TABLE public.plate_events
  ADD COLUMN IF NOT EXISTS image_sha256 TEXT;

-- Partial index optimized for the lookup pattern: per camera, within a
-- recent window, match by exact hash. Keeps index small by excluding rows
-- without a hash (legacy rows + future edge cases).
CREATE INDEX IF NOT EXISTS idx_plate_events_camera_hash_recent
  ON public.plate_events (camera_id, image_sha256, created_at DESC)
  WHERE image_sha256 IS NOT NULL;

COMMENT ON COLUMN public.plate_events.image_sha256 IS
  'SHA-256 hex of the captured JPEG bytes. Used by camera-snapshot to '
  'short-circuit PR calls when a stationary vehicle produces byte-identical '
  'frames. See IMAGE_HASH_WINDOW_SECONDS env knob.';
