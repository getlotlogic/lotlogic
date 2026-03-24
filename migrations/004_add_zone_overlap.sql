-- Add zone_overlap column to violations table for IoU-based zone matching
-- Stores the percentage of detection bounding box overlapping the zone polygon (0-1 scale)

ALTER TABLE violations ADD COLUMN IF NOT EXISTS zone_overlap DOUBLE PRECISION;

COMMENT ON COLUMN violations.zone_overlap IS 'Percentage of detection bbox overlapping zone polygon (0-1 scale). Used for IoU-based zone matching.';
