-- Migration: Violation Dedup System
-- Adds state machine columns and dedup index to violations table.
-- Safe to run multiple times (all operations are idempotent).

-- 1. Expand status CHECK constraint to include new states
--    Drop old constraint, add new one that includes all states.
ALTER TABLE violations DROP CONSTRAINT IF EXISTS violations_status_check;
ALTER TABLE violations ADD CONSTRAINT violations_status_check
  CHECK (status IN ('alerted', 'acknowledged', 'cleared', 'pending', 'resolved'));

-- 2. Add new columns (IF NOT EXISTS is not supported for ADD COLUMN in all PG versions,
--    so we use DO blocks to handle gracefully)
DO $$ BEGIN
  ALTER TABLE violations ADD COLUMN cleared_at TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE violations ADD COLUMN acknowledged_at TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE violations ADD COLUMN acknowledged_by TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE violations ADD COLUMN reminder_sent_at TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE violations ADD COLUMN snapshot_url TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE violations ADD COLUMN operator_id UUID;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE violations ADD COLUMN duration_seconds INTEGER;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- 3. Dedup safety net: only ONE active violation per zone
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_violation_per_zone
  ON violations (zone_id) WHERE status IN ('alerted', 'acknowledged');

-- 4. Violations table is already in supabase_realtime (from schema),
--    but ensure it's there if migration runs on a fresh setup.
-- (This is a no-op if already added; will error if already present — safe to ignore)
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE violations;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
