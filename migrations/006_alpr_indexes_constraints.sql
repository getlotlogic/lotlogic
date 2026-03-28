-- ============================================================
-- Migration 006: Add composite indexes and constraints for ALPR
-- Optimizes webhook query performance and data integrity
-- ============================================================

-- Composite index for plate dedup check (property + plate + time)
CREATE INDEX IF NOT EXISTS idx_plate_events_property_plate_created
ON plate_events(property_id, plate_text, created_at DESC);

-- Partial composite index for resident plate lookups (active only)
CREATE INDEX IF NOT EXISTS idx_resident_plates_property_plate_active
ON resident_plates(property_id, plate_text) WHERE active = true;

-- Partial composite index for active visitor pass lookups
CREATE INDEX IF NOT EXISTS idx_visitor_passes_property_plate_active
ON visitor_passes(property_id, plate_text, status) WHERE status = 'active';

-- Prevent duplicate resident plates per property
CREATE UNIQUE INDEX IF NOT EXISTS uq_resident_plates_property_plate
ON resident_plates(property_id, plate_text) WHERE active = true;

-- Ensure commission rate is valid (0-100%)
ALTER TABLE tow_jobs ADD CONSTRAINT chk_tow_jobs_commission_rate
CHECK (commission_rate >= 0 AND commission_rate <= 1);
