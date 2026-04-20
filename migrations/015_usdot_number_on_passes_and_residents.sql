-- 015_usdot_number_on_passes_and_residents.sql
-- Add USDOT and MC (Motor Carrier) number columns to visitor_passes and
-- resident_plates so plateless tractors can be allowlisted by FMCSA
-- identifier instead of by license plate text.
--
-- Applied to prod 2026-04-20 via supabase MCP apply_migration; this file
-- exists for repo parity so `supabase db push` from a fresh clone
-- produces the same schema, and so the migration is auditable in-repo.

ALTER TABLE public.visitor_passes
  ADD COLUMN IF NOT EXISTS usdot_number TEXT,
  ADD COLUMN IF NOT EXISTS mc_number TEXT;

ALTER TABLE public.resident_plates
  ADD COLUMN IF NOT EXISTS usdot_number TEXT,
  ADD COLUMN IF NOT EXISTS mc_number TEXT;

-- Partial indexes: match cost stays O(log n) for the common "is this DOT
-- number allowlisted at this property right now" lookup that
-- camera-snapshot::findActiveResident and findActiveVisitorPass run on
-- every synthesized DOT-xxxxxxx / MC-xxxxxxx plate.

CREATE INDEX IF NOT EXISTS idx_visitor_passes_usdot
  ON public.visitor_passes (property_id, usdot_number)
  WHERE usdot_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_visitor_passes_mc
  ON public.visitor_passes (property_id, mc_number)
  WHERE mc_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_resident_plates_usdot
  ON public.resident_plates (property_id, usdot_number)
  WHERE usdot_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_resident_plates_mc
  ON public.resident_plates (property_id, mc_number)
  WHERE mc_number IS NOT NULL;
