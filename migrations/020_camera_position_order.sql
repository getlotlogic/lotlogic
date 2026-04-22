-- 020_camera_position_order.sql
-- Per-camera position along the property's primary entry→interior axis.
-- Lower = closer to street/entrance, higher = deeper into lot. Used for
-- multi-camera direction inference (plate detected at order=1 then order=2
-- = entering; reverse = exiting). Configured once per camera by operator.
-- Nullable so properties with a single camera or undecided layout skip
-- direction inference (fallback to event-sourced timing).
--
-- Spec: docs/superpowers/specs/2026-04-22-event-sourced-plate-tracking-design.md
-- Applied to prod 2026-04-22 via supabase MCP apply_migration.

ALTER TABLE public.alpr_cameras
  ADD COLUMN IF NOT EXISTS position_order INTEGER;

COMMENT ON COLUMN public.alpr_cameras.position_order IS
  'Physical order along the property axis from entrance(1) to interior. '
  'Used by camera-snapshot direction inference. NULL means unconfigured.';
