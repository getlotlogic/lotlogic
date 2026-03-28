-- ============================================================
-- Migration 005: ALPR Digital Parking Pass System
-- Adds tables for property management, resident plates,
-- visitor passes, ALPR cameras, plate events, violations, and tow jobs
-- ============================================================

-- ── Properties (residential/commercial properties managed by tow companies) ──
CREATE TABLE IF NOT EXISTS properties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tow_company_id UUID REFERENCES partners(id) ON DELETE CASCADE,
  owner_id UUID REFERENCES lot_owners(id),
  name TEXT NOT NULL,
  address TEXT,
  qr_code_id TEXT UNIQUE NOT NULL,
  total_spaces INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_properties_tow_company ON properties(tow_company_id);
CREATE INDEX IF NOT EXISTS idx_properties_qr_code ON properties(qr_code_id);

-- ── Resident Plates (registered vehicles for a property) ──
CREATE TABLE IF NOT EXISTS resident_plates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  plate_text TEXT NOT NULL,
  unit_number TEXT,
  holder_name TEXT,
  vehicle_description TEXT,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_resident_plates_property ON resident_plates(property_id);
CREATE INDEX IF NOT EXISTS idx_resident_plates_plate ON resident_plates(plate_text);

-- ── Visitor Passes (temporary access via QR code registration) ──
CREATE TABLE IF NOT EXISTS visitor_passes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  plate_text TEXT NOT NULL,
  visitor_name TEXT,
  host_unit TEXT,
  host_name TEXT,
  valid_from TIMESTAMPTZ DEFAULT now(),
  valid_until TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked')),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_visitor_passes_property ON visitor_passes(property_id);
CREATE INDEX IF NOT EXISTS idx_visitor_passes_plate ON visitor_passes(plate_text);
CREATE INDEX IF NOT EXISTS idx_visitor_passes_status ON visitor_passes(status);

-- ── ALPR Cameras (plate-reading cameras at properties) ──
CREATE TABLE IF NOT EXISTS alpr_cameras (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  location_description TEXT,
  api_key TEXT UNIQUE NOT NULL,
  active BOOLEAN DEFAULT true,
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alpr_cameras_property ON alpr_cameras(property_id);
CREATE INDEX IF NOT EXISTS idx_alpr_cameras_api_key ON alpr_cameras(api_key);

-- ── Plate Events (individual plate reads from cameras) ──
CREATE TABLE IF NOT EXISTS plate_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  camera_id UUID NOT NULL REFERENCES alpr_cameras(id) ON DELETE CASCADE,
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  plate_text TEXT NOT NULL,
  confidence DOUBLE PRECISION,
  image_url TEXT,
  event_type TEXT NOT NULL DEFAULT 'entry' CHECK (event_type IN ('entry', 'exit', 'patrol')),
  raw_data JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_plate_events_camera ON plate_events(camera_id);
CREATE INDEX IF NOT EXISTS idx_plate_events_property ON plate_events(property_id);
CREATE INDEX IF NOT EXISTS idx_plate_events_plate ON plate_events(plate_text);
CREATE INDEX IF NOT EXISTS idx_plate_events_created ON plate_events(created_at DESC);

-- ── ALPR Violations (unrecognized plates flagged for enforcement) ──
CREATE TABLE IF NOT EXISTS alpr_violations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  plate_event_id UUID REFERENCES plate_events(id),
  plate_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dispatched', 'resolved', 'dismissed')),
  dispatched_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alpr_violations_property ON alpr_violations(property_id);
CREATE INDEX IF NOT EXISTS idx_alpr_violations_status ON alpr_violations(status);
CREATE INDEX IF NOT EXISTS idx_alpr_violations_plate ON alpr_violations(plate_text);
CREATE INDEX IF NOT EXISTS idx_alpr_violations_created ON alpr_violations(created_at DESC);

-- ── Tow Jobs (tow dispatch and commission tracking) ──
CREATE TABLE IF NOT EXISTS tow_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  violation_id UUID REFERENCES alpr_violations(id),
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  tow_company_id UUID NOT NULL REFERENCES partners(id),
  plate_text TEXT NOT NULL,
  tow_fee NUMERIC(10,2) NOT NULL,
  commission_rate NUMERIC(5,4) NOT NULL DEFAULT 0.25,
  commission_amount NUMERIC(10,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'dispatched' CHECK (status IN ('dispatched', 'completed', 'cancelled')),
  dispatched_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tow_jobs_property ON tow_jobs(property_id);
CREATE INDEX IF NOT EXISTS idx_tow_jobs_tow_company ON tow_jobs(tow_company_id);
CREATE INDEX IF NOT EXISTS idx_tow_jobs_violation ON tow_jobs(violation_id);
CREATE INDEX IF NOT EXISTS idx_tow_jobs_status ON tow_jobs(status);

-- ── RLS Policies (permissive for now — tighten with auth later) ──
ALTER TABLE properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE resident_plates ENABLE ROW LEVEL SECURITY;
ALTER TABLE visitor_passes ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpr_cameras ENABLE ROW LEVEL SECURITY;
ALTER TABLE plate_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpr_violations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tow_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all on properties" ON properties FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on resident_plates" ON resident_plates FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on visitor_passes" ON visitor_passes FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on alpr_cameras" ON alpr_cameras FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on plate_events" ON plate_events FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on alpr_violations" ON alpr_violations FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on tow_jobs" ON tow_jobs FOR ALL USING (true) WITH CHECK (true);

-- ── Enable Realtime ──
ALTER PUBLICATION supabase_realtime ADD TABLE alpr_violations;
ALTER PUBLICATION supabase_realtime ADD TABLE plate_events;
ALTER PUBLICATION supabase_realtime ADD TABLE visitor_passes;
