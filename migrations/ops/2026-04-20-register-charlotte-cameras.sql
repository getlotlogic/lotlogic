-- ============================================================================
-- RUN-ONCE: Charlotte Travel Plaza 4-camera install seed
-- ============================================================================
--
-- Apply on 2026-04-20 AFTER migration 011_alpr_cameras_orientation has landed
-- in production (already applied as of 2026-04-19).
--
-- BEFORE RUNNING:
--   Replace the three MAC_TO_FILL placeholders with the actual `devMac` you
--   see on each Milesight camera's local AP (Settings page, somewhere near
--   the hostname / device info panel). Capitalized hex, no colons or dashes.
--   Example from the first camera, already in the DB: '1CC31660025E'.
--
-- BEFORE RUNNING:
--   Decide which physical camera corresponds to each role. Two entrances × two
--   orientations = four cameras. Name them so an operator can tell them
--   apart in the dashboard without squinting:
--     Entrance A - Entry  (existing, already seeded — the 1CC31660025E row)
--     Entrance A - Exit   (new)
--     Entrance B - Entry  (new)
--     Entrance B - Exit   (new)
--
-- APPLY BY:
--   Call `mcp__claude_ai_SupaBase__apply_migration` with this SQL, naming the
--   migration `016_register_charlotte_cameras`. Or paste into Supabase SQL
--   editor. Either way: it's a one-shot seed, not a reversible migration.
--
-- ============================================================================

-- 1. Rename the existing camera so its purpose is obvious.
UPDATE alpr_cameras
   SET name = 'Entrance A - Entry'
 WHERE api_key = '1CC31660025E';

-- 2. Insert the three new cameras. Replace each MAC_TO_FILL with the devMac.

INSERT INTO alpr_cameras (id, property_id, name, api_key, active, orientation) VALUES
  (gen_random_uuid(),
   'bd44ace8-feda-42e1-9866-5d60f65e1712',
   'Entrance A - Exit',
   'MAC_TO_FILL_A_EXIT',
   true,
   'exit'),

  (gen_random_uuid(),
   'bd44ace8-feda-42e1-9866-5d60f65e1712',
   'Entrance B - Entry',
   'MAC_TO_FILL_B_ENTRY',
   true,
   'entry'),

  (gen_random_uuid(),
   'bd44ace8-feda-42e1-9866-5d60f65e1712',
   'Entrance B - Exit',
   'MAC_TO_FILL_B_EXIT',
   true,
   'exit');

-- 3. Sanity check after insert:
-- SELECT name, api_key, orientation, active, created_at
--   FROM alpr_cameras
--  WHERE property_id = 'bd44ace8-feda-42e1-9866-5d60f65e1712'
--  ORDER BY name;
-- Expected: 4 rows, every row active=true, exactly 2 with orientation='entry'
-- and 2 with orientation='exit'.
