-- Migration 007: Landing Pages & Leasing Office Portal
-- Adds fields for enhanced visitor/resident registration and leasing office management

-- ── Visitor Passes: new fields ──
ALTER TABLE visitor_passes ADD COLUMN IF NOT EXISTS parking_spot TEXT;
ALTER TABLE visitor_passes ADD COLUMN IF NOT EXISTS tag_expiration DATE;
ALTER TABLE visitor_passes ADD COLUMN IF NOT EXISTS id_photo_url TEXT;
ALTER TABLE visitor_passes ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE visitor_passes ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE visitor_passes ADD COLUMN IF NOT EXISTS stay_days INTEGER DEFAULT 1;

-- ── Resident Plates: new fields ──
ALTER TABLE resident_plates ADD COLUMN IF NOT EXISTS plate_expiration DATE;
ALTER TABLE resident_plates ADD COLUMN IF NOT EXISTS plate_photo_url TEXT;
ALTER TABLE resident_plates ADD COLUMN IF NOT EXISTS lease_doc_url TEXT;
ALTER TABLE resident_plates ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE resident_plates ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE resident_plates ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE resident_plates ADD COLUMN IF NOT EXISTS expiry_notified_at TIMESTAMPTZ;

-- Backfill existing rows: treat pre-existing plates as approved
UPDATE resident_plates SET status = 'approved' WHERE status IS NULL;

-- Constraint: status must be pending, approved, or rejected (idempotent)
DO $$ BEGIN
  ALTER TABLE resident_plates ADD CONSTRAINT chk_resident_plates_status
    CHECK (status IN ('pending', 'approved', 'rejected'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Constraint: stay_days between 1 and 3 (idempotent)
DO $$ BEGIN
  ALTER TABLE visitor_passes ADD CONSTRAINT chk_visitor_passes_stay_days
    CHECK (stay_days >= 1 AND stay_days <= 3);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Leasing Offices ──
CREATE TABLE IF NOT EXISTS leasing_offices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  email TEXT UNIQUE NOT NULL,
  contact_name TEXT,
  phone TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_leasing_offices_property ON leasing_offices(property_id);
CREATE INDEX IF NOT EXISTS idx_leasing_offices_email ON leasing_offices(email);

-- Index for expiry notification queries
CREATE INDEX IF NOT EXISTS idx_resident_plates_expiration
  ON resident_plates(plate_expiration) WHERE active = true;

-- Index for status-based queries
CREATE INDEX IF NOT EXISTS idx_resident_plates_status
  ON resident_plates(status) WHERE active = true;

-- ── RLS (permissive for now) ──
ALTER TABLE leasing_offices ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Allow all on leasing_offices" ON leasing_offices FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Supabase Storage buckets ──
-- NOTE: Storage buckets must be created via Supabase dashboard or API:
--   1. visitor-ids     (public read, authenticated write)
--   2. resident-plates (public read, authenticated write)
--   3. resident-leases (public read, authenticated write)
-- The anon key has insert access; files are referenced by URL in the tables above.
