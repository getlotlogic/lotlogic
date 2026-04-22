-- 021_session_exit_hinted_at.sql
-- Marks a session as "probably exiting" based on multi-camera timing.
-- Set by camera-snapshot when a plate is detected moving from a higher
-- position_order camera to a lower one (toward the entrance/street).
-- Cron uses this as a fast-path signal to close the session with a
-- 5-minute buffer instead of the default 2-hour post-pass buffer.
--
-- Applied to prod 2026-04-22 via supabase MCP apply_migration.

ALTER TABLE public.plate_sessions
  ADD COLUMN IF NOT EXISTS exit_hinted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_plate_sessions_exit_hinted_open
  ON public.plate_sessions (property_id, exit_hinted_at)
  WHERE exit_hinted_at IS NOT NULL AND exited_at IS NULL;
