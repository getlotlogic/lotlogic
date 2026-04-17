-- Migration: Add zone_overlap column to violations table
-- Supports IoU-based zone matching: stores what percentage of the detection
-- bounding box overlaps the zone polygon (0-1 scale).
--
-- The backend now uses bounding-box-to-zone-polygon overlap instead of
-- center-point-in-polygon matching. This column records the overlap
-- percentage for each violation, which feeds into departure scoring
-- (higher overlap = stronger presence signal).

ALTER TABLE violations ADD COLUMN IF NOT EXISTS zone_overlap DOUBLE PRECISION;

COMMENT ON COLUMN violations.zone_overlap IS 'Fraction of detection bbox overlapping zone polygon (0-1). Used for IoU-based zone matching and presence scoring.';
