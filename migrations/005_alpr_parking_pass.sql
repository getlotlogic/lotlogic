-- ============================================================
-- ALPR Digital Parking Pass System
-- Creates tables for property management, visitor passes,
-- ALPR camera integration, and tow job commission tracking
-- ============================================================

-- ── Properties (apartment complexes managed by tow companies) ──
CREATE TABLE IF NOT EXISTS properties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tow_company_id UUID REFERENCES partners(id),
  name TEXT NOT NULL,
  address TEXT,
  qr_code_id TEXT UNIQUE NOT NULL,
  default_pass_duration_minutes INTEGER DEFAULT 60,
  grace_period_minutes INTEGER DEFAULT 15,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_properties_tow_company ON properties(tow_company_id);

-- ── Resident Plates (permanently whitelisted) ──────────────────
CREATE TABLE IF NOT EXISTS resident_plates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID REFERENCES properties(id) ON DELETE CASCADE,
  plate_number TEXT NOT NULL,
  unit_number TEXT,
  resident_name TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_resident_plates_unique
  ON resident_plates(property_id, plate_number);
CREATE INDEX IF NOT EXISTS idx_resident_plates_property
  ON resident_plates(property_id) WHERE is_active = true;

-- ── Visitor Passes (time-limited, created via QR scan) ─────────
CREATE TABLE IF NOT EXISTS visitor_passes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID REFERENCES properties(id),
  plate_number TEXT NOT NULL,
  visitor_name TEXT NOT NULL,
  visitor_phone TEXT NOT NULL,
  unit_visiting TEXT NOT NULL,
  status TEXT DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'expired', 'violated')),
  started_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_visitor_passes_active
  ON visitor_passes(property_id, status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_visitor_passes_plate
  ON visitor_passes(property_id, plate_number);

-- ── ALPR Cameras (entry/exit cameras at properties) ────────────
CREATE TABLE IF NOT EXISTS alpr_cameras (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID REFERENCES properties(id) ON DELETE CASCADE,
  camera_name TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('entry', 'exit')),
  api_key TEXT UNIQUE NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alpr_cameras_property
  ON alpr_cameras(property_id);
CREATE INDEX IF NOT EXISTS idx_alpr_cameras_api_key
  ON alpr_cameras(api_key);

-- ── Plate Events (every plate read from every camera) ──────────
CREATE TABLE IF NOT EXISTS plate_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  camera_id UUID REFERENCES alpr_cameras(id),
  property_id UUID REFERENCES properties(id),
  plate_number TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('entry', 'exit')),
  confidence_score DOUBLE PRECISION,
  image_url TEXT,
  timestamp TIMESTAMPTZ DEFAULT now(),
  plate_type TEXT DEFAULT 'unknown'
    CHECK (plate_type IN ('resident', 'visitor_active', 'visitor_expired', 'unknown')),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_plate_events_lookup
  ON plate_events(property_id, plate_number, timestamp);
CREATE INDEX IF NOT EXISTS idx_plate_events_camera
  ON plate_events(camera_id, timestamp);

-- ── ALPR Violations (flagged expired passes / unknown plates) ──
CREATE TABLE IF NOT EXISTS alpr_violations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID REFERENCES properties(id),
  visitor_pass_id UUID REFERENCES visitor_passes(id),
  plate_number TEXT NOT NULL,
  plate_event_entry_id UUID REFERENCES plate_events(id),
  violation_type TEXT NOT NULL
    CHECK (violation_type IN ('expired_pass', 'no_pass')),
  status TEXT DEFAULT 'pending'
    CHECK (status IN ('pending', 'dispatched', 'towed', 'dismissed')),
  flagged_at TIMESTAMPTZ DEFAULT now(),
  dispatched_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  image_url TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alpr_violations_property_status
  ON alpr_violations(property_id, status);
CREATE INDEX IF NOT EXISTS idx_alpr_violations_plate
  ON alpr_violations(plate_number);

-- ── Tow Jobs (completed tows for commission tracking) ──────────
CREATE TABLE IF NOT EXISTS tow_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  violation_id UUID REFERENCES alpr_violations(id),
  property_id UUID REFERENCES properties(id),
  tow_company_id UUID REFERENCES partners(id),
  plate_number TEXT NOT NULL,
  tow_fee DECIMAL NOT NULL,
  commission_rate DECIMAL DEFAULT 0.25,
  commission_amount DECIMAL NOT NULL,
  status TEXT DEFAULT 'completed'
    CHECK (status IN ('completed', 'cancelled')),
  completed_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tow_jobs_property
  ON tow_jobs(property_id);
CREATE INDEX IF NOT EXISTS idx_tow_jobs_company
  ON tow_jobs(tow_company_id);
CREATE INDEX IF NOT EXISTS idx_tow_jobs_completed
  ON tow_jobs(completed_at);

-- ── Updated_at trigger for properties ──────────────────────────
CREATE OR REPLACE FUNCTION update_properties_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_properties_updated_at ON properties;
CREATE TRIGGER trg_properties_updated_at
  BEFORE UPDATE ON properties
  FOR EACH ROW EXECUTE FUNCTION update_properties_updated_at();

-- ── RLS Policies (permissive, matching existing pattern) ───────
ALTER TABLE properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE resident_plates ENABLE ROW LEVEL SECURITY;
ALTER TABLE visitor_passes ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpr_cameras ENABLE ROW LEVEL SECURITY;
ALTER TABLE plate_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpr_violations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tow_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read properties" ON properties FOR SELECT USING (true);
CREATE POLICY "Public write properties" ON properties FOR INSERT WITH CHECK (true);
CREATE POLICY "Public update properties" ON properties FOR UPDATE USING (true);
CREATE POLICY "Public delete properties" ON properties FOR DELETE USING (true);

CREATE POLICY "Public read resident_plates" ON resident_plates FOR SELECT USING (true);
CREATE POLICY "Public write resident_plates" ON resident_plates FOR INSERT WITH CHECK (true);
CREATE POLICY "Public update resident_plates" ON resident_plates FOR UPDATE USING (true);
CREATE POLICY "Public delete resident_plates" ON resident_plates FOR DELETE USING (true);

CREATE POLICY "Public read visitor_passes" ON visitor_passes FOR SELECT USING (true);
CREATE POLICY "Public write visitor_passes" ON visitor_passes FOR INSERT WITH CHECK (true);
CREATE POLICY "Public update visitor_passes" ON visitor_passes FOR UPDATE USING (true);

CREATE POLICY "Public read alpr_cameras" ON alpr_cameras FOR SELECT USING (true);
CREATE POLICY "Public write alpr_cameras" ON alpr_cameras FOR INSERT WITH CHECK (true);
CREATE POLICY "Public update alpr_cameras" ON alpr_cameras FOR UPDATE USING (true);
CREATE POLICY "Public delete alpr_cameras" ON alpr_cameras FOR DELETE USING (true);

CREATE POLICY "Public read plate_events" ON plate_events FOR SELECT USING (true);
CREATE POLICY "Public write plate_events" ON plate_events FOR INSERT WITH CHECK (true);

CREATE POLICY "Public read alpr_violations" ON alpr_violations FOR SELECT USING (true);
CREATE POLICY "Public write alpr_violations" ON alpr_violations FOR INSERT WITH CHECK (true);
CREATE POLICY "Public update alpr_violations" ON alpr_violations FOR UPDATE USING (true);

CREATE POLICY "Public read tow_jobs" ON tow_jobs FOR SELECT USING (true);
CREATE POLICY "Public write tow_jobs" ON tow_jobs FOR INSERT WITH CHECK (true);
CREATE POLICY "Public update tow_jobs" ON tow_jobs FOR UPDATE USING (true);

-- ── Enable Realtime for key tables ─────────────────────────────
ALTER PUBLICATION supabase_realtime ADD TABLE alpr_violations;
ALTER PUBLICATION supabase_realtime ADD TABLE plate_events;
ALTER PUBLICATION supabase_realtime ADD TABLE visitor_passes;
