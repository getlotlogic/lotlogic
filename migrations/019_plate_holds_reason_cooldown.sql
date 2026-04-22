-- 019_plate_holds_reason_cooldown.sql
-- Allow post_visit_cooldown as a valid reason for plate_holds rows.
-- Created by cron-sessions-sweep::closeRegistered when a registered
-- session closes. Paired with the enforce_plate_hold trigger in the
-- lotlogic-backend repo which blocks new visitor_pass INSERTs during
-- an active hold.
--
-- Applied to prod 2026-04-22 via supabase MCP apply_migration.

ALTER TABLE public.plate_holds
  DROP CONSTRAINT IF EXISTS plate_holds_reason_check;

ALTER TABLE public.plate_holds
  ADD CONSTRAINT plate_holds_reason_check
  CHECK (reason IN ('early_exit', 'post_visit_cooldown'));
