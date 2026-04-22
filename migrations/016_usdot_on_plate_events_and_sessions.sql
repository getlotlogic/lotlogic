-- 016_usdot_on_plate_events_and_sessions.sql
-- Attach USDOT / MC to plate_events and plate_sessions so every frame
-- carries both identifiers side by side (not one-or-the-other). ParkPow
-- USDOT OCR is now called on every frame in parallel with Plate
-- Recognizer; its result is stored here alongside the plate_text.
--
-- Applied to prod 2026-04-22 via supabase MCP apply_migration.

ALTER TABLE public.plate_events
  ADD COLUMN IF NOT EXISTS usdot_number TEXT,
  ADD COLUMN IF NOT EXISTS mc_number TEXT;

ALTER TABLE public.plate_sessions
  ADD COLUMN IF NOT EXISTS usdot_number TEXT,
  ADD COLUMN IF NOT EXISTS mc_number TEXT;

-- Fuzzy-match support: when a later frame reads a DOT but not the plate,
-- we want to collapse it onto an earlier plate-based session. An index
-- on (property_id, usdot_number) where NOT NULL keeps that cheap.
CREATE INDEX IF NOT EXISTS idx_plate_sessions_usdot_open
  ON public.plate_sessions (property_id, usdot_number)
  WHERE usdot_number IS NOT NULL AND exited_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_plate_sessions_mc_open
  ON public.plate_sessions (property_id, mc_number)
  WHERE mc_number IS NOT NULL AND exited_at IS NULL;
