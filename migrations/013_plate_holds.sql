-- 24-hour hold records created when a driver exits early from a registered
-- session. The backend visitor_passes POST endpoint will reject new passes
-- for a plate while an unexpired hold exists.

CREATE TABLE plate_holds (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id         uuid NOT NULL REFERENCES properties(id),
  normalized_plate    text NOT NULL,
  source_session_id   uuid NOT NULL REFERENCES plate_sessions(id),
  held_at             timestamptz NOT NULL DEFAULT now(),
  hold_until          timestamptz NOT NULL,
  reason              text NOT NULL CHECK (reason IN ('early_exit')),
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- Dashboards query "active holds for a property" by hold_until > now().
CREATE INDEX idx_plate_holds_active
  ON plate_holds (property_id, normalized_plate, hold_until DESC);

-- Rebuild the billing-status view with the new 'left_before_tow' case at the
-- top so it wins over 'confirmed' / 'reported_unconfirmed' etc.
-- DROP + CREATE required because we are adding a new column (left_before_tow_at)
-- before existing columns, which CREATE OR REPLACE cannot do in Postgres.
DROP VIEW IF EXISTS v_violation_billing_status;

CREATE VIEW v_violation_billing_status AS
SELECT id,
       action_taken,
       tow_confirmed_at,
       dispatched_at,
       billing_held_at,
       force_bill_at,
       left_before_tow_at,
       billing_held_at IS NOT NULL AS manually_held,
       force_bill_at   IS NOT NULL AS force_billed,
       CASE
         WHEN left_before_tow_at IS NOT NULL                                        THEN 'left_before_tow'
         WHEN action_taken = 'plate_correction'                                     THEN 'no_tow'
         WHEN action_taken = 'tow'     AND tow_confirmed_at IS NOT NULL             THEN 'confirmed'
         WHEN action_taken IS NULL     AND tow_confirmed_at IS NOT NULL             THEN 'unreported_confirmed'
         WHEN action_taken = 'tow'     AND tow_confirmed_at IS NULL                 THEN 'reported_unconfirmed'
         WHEN action_taken = 'no_tow'  AND tow_confirmed_at IS NOT NULL             THEN 'disputed'
         WHEN action_taken = 'no_tow'  AND tow_confirmed_at IS NULL                 THEN 'no_tow'
         WHEN action_taken IS NULL     AND dispatched_at IS NOT NULL
              AND dispatched_at < (now() - interval '24:00:00')                     THEN 'no_tow_timeout'
         ELSE 'pending'
       END AS billing_status
  FROM alpr_violations v;
