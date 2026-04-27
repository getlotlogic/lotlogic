-- 024 — gate_id on alpr_cameras for bidirectional pair detection
--
-- Each physical gate at a property has TWO cameras facing opposite
-- directions. Both catch every transit: one captures the front plate
-- as the vehicle approaches, the other captures the rear as it passes.
-- Direction (entry vs exit) is inferred from TIME ORDER across the pair:
--
--   road-side fires first, then lot-side  → vehicle entering
--   lot-side fires first, then road-side  → vehicle exiting
--
-- Without gate_id, inferDirection's depth-pair query can match a
-- detection at the south gate against a recent prior event at the north
-- gate and falsely trigger an exit signal for a vehicle that just
-- transited the length of the lot. gate_id scopes the pair-detection
-- query to one physical gate.
--
-- Charlotte deployment after this migration applies:
--   gate_id = 'north', position_order = 1 (road)  → "North Gate (E)"   orientation=entry
--   gate_id = 'north', position_order = 2 (lot)   → "North Lot (C)"    orientation=exit
--   gate_id = 'south', position_order = 1 (road)  → "South Gate (A)"   orientation=entry
--   gate_id = 'south', position_order = 2 (lot)   → "South Lot (D)"    orientation=exit

ALTER TABLE alpr_cameras
  ADD COLUMN IF NOT EXISTS gate_id TEXT;

COMMENT ON COLUMN alpr_cameras.gate_id IS
  'Identifier shared by paired cameras at one physical gate (e.g. ''north'', ''south''). NULL on properties with no paired cameras yet — inferDirection falls back to property-wide depth-pair logic.';

CREATE INDEX IF NOT EXISTS alpr_cameras_gate_idx
  ON alpr_cameras (property_id, gate_id);

-- ---------------------------------------------------------------------
-- Charlotte Travel Plaza configuration. Run AFTER applying the column.
-- Repeat the SELECT at the end to confirm.
-- ---------------------------------------------------------------------

UPDATE alpr_cameras
SET name = 'North Gate (E)',
    orientation = 'entry',
    position_order = 1,
    gate_id = 'north'
WHERE id = '6863affc-f992-4524-8e24-8e641fefb8c4';

UPDATE alpr_cameras
SET name = 'North Lot (C)',
    orientation = 'exit',
    position_order = 2,
    gate_id = 'north'
WHERE id = '033bfdf7-2a63-4171-bb08-620702d715c1';

UPDATE alpr_cameras
SET name = 'South Gate (A)',
    orientation = 'entry',
    position_order = 1,
    gate_id = 'south'
WHERE id = '153470bf-d2f0-4bf3-a749-6bb57646c179';

UPDATE alpr_cameras
SET name = 'South Lot (D)',
    orientation = 'exit',
    position_order = 2,
    gate_id = 'south'
WHERE id = '93d96c60-c1d4-403b-91ba-c9d9eb09f56c';

SELECT id, name, orientation, position_order, gate_id
FROM alpr_cameras
WHERE property_id = (SELECT property_id FROM alpr_cameras LIMIT 1)
ORDER BY gate_id, position_order;
