-- Migration: Violation Departure / Zone Unlocking
-- Adds 'departed' status and empty_streak counter so zones re-arm
-- after 3 consecutive empty snapshots without dismissing the violation.
-- Safe to run multiple times (all operations are idempotent).

-- 1. Expand status CHECK constraint to include 'departed'
ALTER TABLE violations DROP CONSTRAINT IF EXISTS violations_status_check;
ALTER TABLE violations ADD CONSTRAINT violations_status_check
  CHECK (status IN ('alerted', 'acknowledged', 'cleared', 'departed', 'pending', 'resolved'));

-- 2. Add empty_streak counter — tracks consecutive empty snapshots
DO $$ BEGIN
  ALTER TABLE violations ADD COLUMN empty_streak INTEGER NOT NULL DEFAULT 0;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- 3. Add departed_at timestamp
DO $$ BEGIN
  ALTER TABLE violations ADD COLUMN departed_at TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- 4. Update the unique dedup index — 'departed' is terminal, so only
--    'alerted' and 'acknowledged' block new violations (unchanged).
--    This is a no-op if the index already exists with the same definition.
--    Included for completeness.
