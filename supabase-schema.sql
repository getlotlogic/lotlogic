-- ============================================================
-- LotLogic Supabase Schema
-- Run this in Supabase SQL Editor to create all tables
-- ============================================================

-- ── Owners (lot owners) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS owners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  contact_name TEXT,
  business_name TEXT,
  phone TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ── Partners (enforcement operators) ─────────────────────────
CREATE TABLE IF NOT EXISTS partners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  contact_name TEXT,
  company_name TEXT,
  phone TEXT,
  market_id TEXT,
  boot_fee INTEGER DEFAULT 75,          -- dollars charged to vehicle owner for boot
  tow_fee INTEGER DEFAULT 250,          -- dollars charged to vehicle owner for tow
  revenue_share DOUBLE PRECISION DEFAULT 0.30, -- LotLogic's cut (0.30 = 30%)
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ── Lots (parking lots) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS lots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID REFERENCES owners(id),
  partner_id UUID REFERENCES partners(id),
  market_id TEXT,
  name TEXT NOT NULL,
  address TEXT,
  total_spaces INTEGER DEFAULT 0,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lots_owner ON lots(owner_id);
CREATE INDEX IF NOT EXISTS idx_lots_partner ON lots(partner_id);
CREATE INDEX IF NOT EXISTS idx_lots_market ON lots(market_id);

-- ── Cameras ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cameras (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id UUID REFERENCES lots(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  rtsp_url TEXT,
  channel INTEGER DEFAULT 0,
  online BOOLEAN DEFAULT false,
  deployment_profile TEXT DEFAULT 'wired', -- 'wired' | 'lte_solar'
  snapshot_width INTEGER DEFAULT 640,
  snapshot_height INTEGER DEFAULT 360,
  poll_interval_sec INTEGER DEFAULT 30,
  bandwidth_budget_mb INTEGER,
  bandwidth_used_mb INTEGER DEFAULT 0,
  zones JSONB DEFAULT '[]'::jsonb,
  last_heartbeat TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cameras_lot ON cameras(lot_id);

-- ── Snapshots (camera captures) ──────────────────────────────
CREATE TABLE IF NOT EXISTS snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  camera_id UUID REFERENCES cameras(id) ON DELETE CASCADE,
  url TEXT,
  captured_at TIMESTAMPTZ DEFAULT now(),
  vehicles_detected INTEGER DEFAULT 0,
  people_detected INTEGER DEFAULT 0,
  plates_read INTEGER DEFAULT 0,
  detections JSONB DEFAULT '[]'::jsonb,
  plate_readings JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_snapshots_camera ON snapshots(camera_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_captured ON snapshots(captured_at DESC);

-- ── Violations ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS violations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id UUID REFERENCES lots(id) ON DELETE CASCADE,
  partner_id UUID REFERENCES partners(id),
  camera_id UUID REFERENCES cameras(id),
  snapshot_id UUID REFERENCES snapshots(id),
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'resolved')),
  detected_at TIMESTAMPTZ DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  action_taken TEXT,
  plate_text TEXT,
  plate_confidence DOUBLE PRECISION,
  vehicle_color TEXT,
  vehicle_type TEXT DEFAULT 'car',
  vehicle_make TEXT,
  vehicle_model TEXT,
  violation_type TEXT DEFAULT 'unauthorized',
  zone_id TEXT,
  space_number TEXT,
  confidence DOUBLE PRECISION,
  our_revenue INTEGER DEFAULT 0, -- dollars (app multiplies by 100 for cents display)
  gross_revenue INTEGER DEFAULT 0, -- dollars (app multiplies by 100 for cents display)
  sms_sent_at TIMESTAMPTZ,
  sms_delivered BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_violations_lot ON violations(lot_id);
CREATE INDEX IF NOT EXISTS idx_violations_partner ON violations(partner_id);
CREATE INDEX IF NOT EXISTS idx_violations_status ON violations(status);
CREATE INDEX IF NOT EXISTS idx_violations_detected ON violations(detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_violations_plate ON violations(plate_text);

-- ── Revenue summary view ─────────────────────────────────────
-- Revenue is computed from partner fee schedule: gross = boot_fee or tow_fee,
-- our_revenue = gross * partner.revenue_share (LotLogic's cut)
CREATE OR REPLACE VIEW revenue_summary AS
SELECT
  v.lot_id,
  COUNT(*) AS total_violations,
  COUNT(*) FILTER (WHERE v.action_taken IS NOT NULL AND v.action_taken != 'pending') AS actions_executed,
  SUM(v.our_revenue) AS our_revenue_cents,
  SUM(v.gross_revenue) AS gross_revenue_cents,
  COUNT(*) FILTER (WHERE v.action_taken = 'boot') AS boots,
  COUNT(*) FILTER (WHERE v.action_taken = 'tow') AS tows,
  COUNT(*) FILTER (WHERE v.action_taken = 'dismissed') AS dismissed,
  COUNT(*) FILTER (WHERE v.action_taken = 'already_gone') AS already_gone,
  COUNT(*) FILTER (WHERE v.action_taken = 'no_action') AS no_action
FROM violations v
WHERE v.status = 'resolved'
GROUP BY v.lot_id;

-- ── Lot state view (live status) ─────────────────────────────
CREATE OR REPLACE VIEW lot_state AS
SELECT
  l.id AS lot_id,
  l.name,
  COUNT(v.id) FILTER (WHERE v.status = 'pending') AS total_active_violations,
  COUNT(DISTINCT c.id) FILTER (WHERE c.online = true) AS cameras_online,
  COUNT(DISTINCT c.id) AS cameras_total
FROM lots l
LEFT JOIN violations v ON v.lot_id = l.id AND v.status = 'pending'
LEFT JOIN cameras c ON c.lot_id = l.id
GROUP BY l.id, l.name;

-- ── Enable Realtime on key tables ────────────────────────────
ALTER PUBLICATION supabase_realtime ADD TABLE violations;
ALTER PUBLICATION supabase_realtime ADD TABLE cameras;
ALTER PUBLICATION supabase_realtime ADD TABLE lots;

-- ── Row Level Security (RLS) ─────────────────────────────────
-- Enable RLS on all tables
ALTER TABLE owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE partners ENABLE ROW LEVEL SECURITY;
ALTER TABLE lots ENABLE ROW LEVEL SECURITY;
ALTER TABLE cameras ENABLE ROW LEVEL SECURITY;
ALTER TABLE snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE violations ENABLE ROW LEVEL SECURITY;

-- !! SECURITY WARNING !!
-- These policies allow ANY anonymous user to read/write ALL data.
-- This means any user with the Supabase anon key (exposed in client JS)
-- can read every owner's violations, revenue, camera snapshots, etc.
--
-- TO FIX: Implement Supabase Auth, then replace these with scoped policies:
--   - Owners see only lots WHERE owner_id = auth.uid()
--   - Partners see only lots WHERE partner_id = auth.uid()
--   - Violations/cameras/snapshots scoped through lot ownership chain
--   - UPDATE on violations only allowed for lots the user owns/partners
--
-- Until then, the backend API (Rails) must enforce authorization on every
-- request. The frontend also validates ownership before mutations.

-- Allow public read for now (tighten later with Supabase Auth)
CREATE POLICY "Public read owners" ON owners FOR SELECT USING (true);
CREATE POLICY "Public read partners" ON partners FOR SELECT USING (true);
CREATE POLICY "Public read lots" ON lots FOR SELECT USING (true);
CREATE POLICY "Public read cameras" ON cameras FOR SELECT USING (true);
CREATE POLICY "Public read snapshots" ON snapshots FOR SELECT USING (true);
CREATE POLICY "Public read violations" ON violations FOR SELECT USING (true);

-- Allow public insert/update for now (operators need to record actions)
CREATE POLICY "Public insert violations" ON violations FOR INSERT WITH CHECK (true);
CREATE POLICY "Public update violations" ON violations FOR UPDATE USING (true);
CREATE POLICY "Public insert cameras" ON cameras FOR INSERT WITH CHECK (true);
CREATE POLICY "Public update cameras" ON cameras FOR UPDATE USING (true);

-- ── Updated_at trigger ───────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER violations_updated_at
  BEFORE UPDATE ON violations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER lots_updated_at
  BEFORE UPDATE ON lots
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
