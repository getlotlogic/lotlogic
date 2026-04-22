-- 017_alpr_cameras_usdot_burst.sql
-- Per-camera burst-mode state for USDOT OCR. When a no-plate (or short-
-- plate) frame fires OCR, we set usdot_active_until = now() + N seconds
-- (default 10). Subsequent frames on that camera within the window keep
-- firing OCR regardless of whether PR finds a plate, giving the DOT reader
-- multiple angles as the vehicle moves through the frame.
--
-- Applied to prod 2026-04-22 via supabase MCP apply_migration.

ALTER TABLE public.alpr_cameras
  ADD COLUMN IF NOT EXISTS usdot_active_until TIMESTAMPTZ;
