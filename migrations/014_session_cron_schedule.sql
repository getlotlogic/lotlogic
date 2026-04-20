-- Schedule a once-per-minute sweep of plate_sessions state transitions.
-- The PL/pgSQL approach was abandoned because Supabase's managed Postgres
-- denies ALTER DATABASE SET for custom GUCs, which made it impossible to
-- persist the service-role key needed for pg_net auth. Instead, we call a
-- dedicated edge function (cron-sessions-sweep) that already has access to
-- SUPABASE_SERVICE_ROLE_KEY via its env, and pg_cron just HTTP-pokes it.
--
-- The edge function runs the three transitions in order per call:
--   1. registration-transition (grace -> registered when a pass arrives)
--   2. grace-expiry            (grace -> expired after 15 min + violation + email)
--   3. pass-expiry             (registered -> expired after pass.valid_until)
--
-- Timeout considerations: the sweep typically processes a few rows per minute;
-- if it ever runs long the worst case is a stacked invocation. The function
-- is idempotent (each transition filters by current state), so concurrent
-- runs are safe.

SELECT cron.schedule(
  'plate_sessions_sweep',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := 'https://nzdkoouoaedbbccraoti.supabase.co/functions/v1/cron-sessions-sweep',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb
  ) AS request_id;
  $$
);
