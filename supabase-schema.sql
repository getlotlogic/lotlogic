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
  id SERIAL PRIMARY KEY,
  camera_id UUID REFERENCES cameras(id) ON DELETE CASCADE,
  lot_id UUID REFERENCES lots(id) ON DELETE CASCADE,
  captured_at TIMESTAMPTZ DEFAULT now(),
  storage_key TEXT,
  storage_url TEXT,
  width INTEGER,
  height INTEGER,
  size_bytes INTEGER,
  trigger_type TEXT DEFAULT 'poll',
  inference_ran BOOLEAN DEFAULT false,
  inference_ms INTEGER,
  vehicles_detected INTEGER DEFAULT 0,
  raw_detections JSONB DEFAULT '{"count":0,"detections":[]}'::jsonb,
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

-- ── Permitted Vehicles (whitelist + time-limited permits) ────
-- Lot owners manage which plates are allowed to park.
-- Two modes:
--   1. Whitelist: plate_text + no expires_at = always allowed
--   2. Time-limited permit: plate_text + expires_at = allowed until date
CREATE TABLE IF NOT EXISTS permitted_vehicles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id UUID REFERENCES lots(id) ON DELETE CASCADE NOT NULL,
  plate_text TEXT NOT NULL,
  vehicle_description TEXT,      -- e.g. "Blue Honda Civic"
  permit_type TEXT DEFAULT 'whitelist' CHECK (permit_type IN ('whitelist', 'monthly', 'temporary', 'employee')),
  holder_name TEXT,              -- who owns the vehicle
  holder_contact TEXT,           -- phone or email
  issued_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ,        -- NULL = never expires (permanent whitelist)
  active BOOLEAN DEFAULT true,
  notes TEXT,
  created_by UUID,               -- owner who added this
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_permits_lot ON permitted_vehicles(lot_id);
CREATE INDEX IF NOT EXISTS idx_permits_plate ON permitted_vehicles(plate_text);
CREATE INDEX IF NOT EXISTS idx_permits_active ON permitted_vehicles(lot_id, active) WHERE active = true;
CREATE UNIQUE INDEX IF NOT EXISTS idx_permits_lot_plate ON permitted_vehicles(lot_id, plate_text) WHERE active = true;

ALTER TABLE permitted_vehicles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read permitted_vehicles" ON permitted_vehicles FOR SELECT USING (true);
CREATE POLICY "Public insert permitted_vehicles" ON permitted_vehicles FOR INSERT WITH CHECK (true);
CREATE POLICY "Public update permitted_vehicles" ON permitted_vehicles FOR UPDATE USING (true);
CREATE POLICY "Public delete permitted_vehicles" ON permitted_vehicles FOR DELETE USING (true);

ALTER PUBLICATION supabase_realtime ADD TABLE permitted_vehicles;

CREATE TRIGGER permitted_vehicles_updated_at
  BEFORE UPDATE ON permitted_vehicles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── Hourly Violation Stats (for analytics) ──────────────────
-- Materialized view that aggregates violations by hour-of-day per lot.
-- Refresh periodically via pg_cron or on-demand.
CREATE OR REPLACE VIEW violation_hourly_stats AS
SELECT
  v.lot_id,
  EXTRACT(DOW FROM v.detected_at) AS day_of_week,   -- 0=Sun, 6=Sat
  EXTRACT(HOUR FROM v.detected_at) AS hour_of_day,   -- 0-23
  COUNT(*) AS violation_count,
  COUNT(*) FILTER (WHERE v.action_taken IN ('boot', 'tow')) AS enforced_count,
  SUM(v.gross_revenue) AS gross_revenue
FROM violations v
WHERE v.detected_at > now() - INTERVAL '90 days'
GROUP BY v.lot_id, EXTRACT(DOW FROM v.detected_at), EXTRACT(HOUR FROM v.detected_at);

-- ── Lot Utilization View (vehicles seen per hour) ────────────
-- Counts total vehicles detected per hour per lot from snapshots.
CREATE OR REPLACE VIEW lot_utilization AS
SELECT
  s.lot_id,
  DATE_TRUNC('hour', s.captured_at) AS hour_bucket,
  AVG(s.vehicles_detected) AS avg_vehicles,
  MAX(s.vehicles_detected) AS max_vehicles,
  COUNT(*) AS snapshot_count
FROM snapshots s
WHERE s.captured_at > now() - INTERVAL '30 days'
GROUP BY s.lot_id, DATE_TRUNC('hour', s.captured_at);

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
ALTER PUBLICATION supabase_realtime ADD TABLE snapshots;

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

-- ── Action Logs (every boot/tow is recorded here) ─────────────
-- This is the audit trail for invoicing. Every enforcement action
-- gets a line item so we can roll up daily invoices.
CREATE TABLE IF NOT EXISTS action_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  violation_id UUID REFERENCES violations(id) ON DELETE SET NULL,
  lot_id UUID REFERENCES lots(id) ON DELETE CASCADE,
  owner_id UUID REFERENCES owners(id),
  partner_id UUID REFERENCES partners(id),
  action_type TEXT NOT NULL CHECK (action_type IN ('boot', 'tow')),
  performed_by TEXT NOT NULL CHECK (performed_by IN ('owner', 'partner')),
  performer_email TEXT,
  plate_text TEXT,
  vehicle_description TEXT,    -- e.g. "Red Toyota Camry"
  gross_fee INTEGER NOT NULL,  -- dollars charged to vehicle owner
  our_revenue INTEGER NOT NULL,-- LotLogic's cut in dollars
  partner_payout INTEGER DEFAULT 0, -- partner's cut in dollars
  owner_payout INTEGER DEFAULT 0,   -- lot owner's cut in dollars
  invoiced BOOLEAN DEFAULT false,
  invoice_id UUID,             -- set when included in an invoice
  performed_at TIMESTAMPTZ DEFAULT now(),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_action_logs_lot ON action_logs(lot_id);
CREATE INDEX IF NOT EXISTS idx_action_logs_owner ON action_logs(owner_id);
CREATE INDEX IF NOT EXISTS idx_action_logs_partner ON action_logs(partner_id);
CREATE INDEX IF NOT EXISTS idx_action_logs_performed ON action_logs(performed_at DESC);
CREATE INDEX IF NOT EXISTS idx_action_logs_uninvoiced ON action_logs(invoiced) WHERE invoiced = false;

-- ── Invoices (daily rollup sent to QuickBooks) ────────────────
CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number TEXT UNIQUE NOT NULL,  -- e.g. "INV-2026-03-15-001"
  invoice_date DATE NOT NULL,
  due_date DATE,
  -- Who is this invoice for?
  bill_to_type TEXT NOT NULL CHECK (bill_to_type IN ('owner', 'partner')),
  owner_id UUID REFERENCES owners(id),
  partner_id UUID REFERENCES partners(id),
  -- Totals
  subtotal INTEGER NOT NULL DEFAULT 0,   -- dollars
  tax INTEGER DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,      -- dollars
  -- Status
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'paid', 'overdue', 'void')),
  -- QuickBooks sync
  qb_invoice_id TEXT,           -- QuickBooks invoice ID after sync
  qb_synced_at TIMESTAMPTZ,
  qb_sync_error TEXT,
  -- Payment
  paid_at TIMESTAMPTZ,
  payment_method TEXT,
  -- Metadata
  period_start DATE,
  period_end DATE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invoices_owner ON invoices(owner_id);
CREATE INDEX IF NOT EXISTS idx_invoices_partner ON invoices(partner_id);
CREATE INDEX IF NOT EXISTS idx_invoices_date ON invoices(invoice_date DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);

-- ── Invoice Line Items ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoice_line_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID REFERENCES invoices(id) ON DELETE CASCADE,
  action_log_id UUID REFERENCES action_logs(id),
  description TEXT NOT NULL,  -- e.g. "Boot - ABC1234 at Main St Lot (3/15)"
  quantity INTEGER DEFAULT 1,
  unit_price INTEGER NOT NULL, -- dollars
  amount INTEGER NOT NULL,     -- dollars (quantity * unit_price)
  lot_name TEXT,
  plate_text TEXT,
  action_type TEXT,
  performed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_line_items_invoice ON invoice_line_items(invoice_id);

-- ── QuickBooks Integration Settings ───────────────────────────
CREATE TABLE IF NOT EXISTS qb_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID REFERENCES owners(id) UNIQUE,
  realm_id TEXT,               -- QuickBooks company ID
  access_token TEXT,
  refresh_token TEXT,
  token_expires_at TIMESTAMPTZ,
  income_account_id TEXT,      -- QB account to post revenue to
  bank_account_id TEXT,        -- checking account for deposits
  auto_sync BOOLEAN DEFAULT true,
  last_sync_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- RLS for new tables
ALTER TABLE action_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_line_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE qb_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read action_logs" ON action_logs FOR SELECT USING (true);
CREATE POLICY "Public insert action_logs" ON action_logs FOR INSERT WITH CHECK (true);
CREATE POLICY "Public update action_logs" ON action_logs FOR UPDATE USING (true);
CREATE POLICY "Public read invoices" ON invoices FOR SELECT USING (true);
CREATE POLICY "Public insert invoices" ON invoices FOR INSERT WITH CHECK (true);
CREATE POLICY "Public update invoices" ON invoices FOR UPDATE USING (true);
CREATE POLICY "Public read invoice_line_items" ON invoice_line_items FOR SELECT USING (true);
CREATE POLICY "Public insert invoice_line_items" ON invoice_line_items FOR INSERT WITH CHECK (true);
CREATE POLICY "Public read qb_settings" ON qb_settings FOR SELECT USING (true);
CREATE POLICY "Public insert qb_settings" ON qb_settings FOR INSERT WITH CHECK (true);
CREATE POLICY "Public update qb_settings" ON qb_settings FOR UPDATE USING (true);

-- Realtime for invoices
ALTER PUBLICATION supabase_realtime ADD TABLE invoices;
ALTER PUBLICATION supabase_realtime ADD TABLE action_logs;

-- Invoice updated_at trigger
CREATE TRIGGER invoices_updated_at
  BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER qb_settings_updated_at
  BEFORE UPDATE ON qb_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── Daily Invoice Generation Function ─────────────────────────
-- Call this via Supabase cron (pg_cron) or Edge Function daily
CREATE OR REPLACE FUNCTION generate_daily_invoices(for_date DATE DEFAULT CURRENT_DATE - 1)
RETURNS INTEGER AS $$
DECLARE
  inv_count INTEGER := 0;
  rec RECORD;
  inv_id UUID;
  inv_num TEXT;
  line RECORD;
  inv_total INTEGER;
BEGIN
  -- Generate one invoice per owner for all uninvoiced actions on their lots
  FOR rec IN
    SELECT DISTINCT l.owner_id
    FROM action_logs al
    JOIN lots l ON l.id = al.lot_id
    WHERE al.invoiced = false
      AND al.performed_at::date = for_date
      AND l.owner_id IS NOT NULL
  LOOP
    inv_id := gen_random_uuid();
    inv_num := 'INV-' || to_char(for_date, 'YYYY-MM-DD') || '-' || LPAD((inv_count + 1)::text, 3, '0');
    inv_total := 0;

    -- Create the invoice
    INSERT INTO invoices (id, invoice_number, invoice_date, due_date, bill_to_type, owner_id, subtotal, total, status, period_start, period_end)
    VALUES (inv_id, inv_num, for_date, for_date + 30, 'owner', rec.owner_id, 0, 0, 'draft', for_date, for_date);

    -- Create line items from action logs
    FOR line IN
      SELECT al.*, l.name AS lot_name
      FROM action_logs al
      JOIN lots l ON l.id = al.lot_id
      WHERE al.invoiced = false
        AND al.performed_at::date = for_date
        AND l.owner_id = rec.owner_id
      ORDER BY al.performed_at
    LOOP
      INSERT INTO invoice_line_items (invoice_id, action_log_id, description, unit_price, amount, lot_name, plate_text, action_type, performed_at)
      VALUES (
        inv_id,
        line.id,
        INITCAP(line.action_type) || ' - ' || COALESCE(line.plate_text, 'Unknown') || ' at ' || COALESCE(line.lot_name, 'Lot') || ' (' || to_char(line.performed_at, 'MM/DD') || ')',
        line.gross_fee,
        line.gross_fee,
        line.lot_name,
        line.plate_text,
        line.action_type,
        line.performed_at
      );
      inv_total := inv_total + line.gross_fee;

      -- Mark action as invoiced
      UPDATE action_logs SET invoiced = true, invoice_id = inv_id WHERE id = line.id;
    END LOOP;

    -- Update invoice totals
    UPDATE invoices SET subtotal = inv_total, total = inv_total WHERE id = inv_id;
    inv_count := inv_count + 1;
  END LOOP;

  RETURN inv_count;
END;
$$ LANGUAGE plpgsql;

-- ── Schedule daily invoice generation (requires pg_cron extension) ──
-- Run this once in Supabase SQL editor after enabling pg_cron:
-- SELECT cron.schedule('daily-invoices', '0 6 * * *', $$SELECT generate_daily_invoices()$$);

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
