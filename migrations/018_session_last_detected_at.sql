-- 018_session_last_detected_at.sql
-- Add last_detected_at to plate_sessions for event-sourced tracking.
-- Updated on every matching plate_event so cron and dashboard queries
-- can reason about session activity without aggregating plate_events.
-- Spec: docs/superpowers/specs/2026-04-22-event-sourced-plate-tracking-design.md
--
-- Applied to prod 2026-04-22 via supabase MCP apply_migration.

ALTER TABLE public.plate_sessions
  ADD COLUMN IF NOT EXISTS last_detected_at TIMESTAMPTZ;

-- Backfill from existing plate_events
UPDATE public.plate_sessions ps
   SET last_detected_at = COALESCE(
     (SELECT max(created_at) FROM public.plate_events WHERE session_id = ps.id),
     ps.entered_at
   )
 WHERE last_detected_at IS NULL;

ALTER TABLE public.plate_sessions
  ALTER COLUMN last_detected_at SET DEFAULT now(),
  ALTER COLUMN last_detected_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_plate_sessions_last_detected_open
  ON public.plate_sessions (property_id, last_detected_at DESC)
  WHERE exited_at IS NULL;
