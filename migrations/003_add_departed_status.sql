-- Add 'departed' to violations status CHECK constraint.
-- The backend violation_dedup.py sets status='departed' when a car leaves,
-- but the original constraint only allowed: alerted, acknowledged, cleared, pending, resolved.
-- This caused ALL departure transitions to silently fail, meaning violations
-- could never be auto-cleared when vehicles left.

ALTER TABLE violations DROP CONSTRAINT violations_status_check;
ALTER TABLE violations ADD CONSTRAINT violations_status_check
  CHECK (status = ANY (ARRAY['alerted', 'acknowledged', 'cleared', 'departed', 'pending', 'resolved']));
