-- 023_plate_events_image_dhash.sql
-- Adds perceptual difference-hash (dHash) column for robust image similarity
-- detection. dHash is 64 bits stored as 16-char hex. Two images with
-- Hamming distance ≤ ~5 bits are visually near-identical (same scene with
-- compression variance, sensor noise, minor lighting shifts).
--
-- Paired with image_sha256 (migration 022) to form a tiered dedup:
--   Tier 1: SHA-256 exact match — catches byte-identical frames
--   Tier 2: dHash Hamming ≤ 5 — catches visually same scene
--
-- Both checks happen BEFORE the Plate Recognizer API call, dramatically
-- reducing cost for stationary vehicles that trigger motion-triggered
-- webhook fires every few seconds (wind, shadow, trailer sway).
--
-- Applied to prod 2026-04-24 via supabase MCP apply_migration.

ALTER TABLE public.plate_events
  ADD COLUMN IF NOT EXISTS image_dhash TEXT;

COMMENT ON COLUMN public.plate_events.image_dhash IS
  'Perceptual difference-hash (dHash) of the captured JPEG, 16 hex chars = '
  '64 bits. Used by camera-snapshot for Hamming-distance similarity check '
  'to skip PR calls on stationary vehicles.';
