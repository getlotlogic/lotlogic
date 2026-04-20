-- The state machine's core table. One row per entry-exit pair. The 7-state
-- enum encodes both the "why" (grace / registered / resident / expired) and
-- the closure reason (closed_clean / closed_early / closed_post_violation)
-- so a single state column answers "what does the cron need to do about this
-- session right now?".

CREATE TABLE plate_sessions (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id               uuid NOT NULL REFERENCES properties(id),
  normalized_plate          text NOT NULL,
  plate_text                text NOT NULL,
  vehicle_type              text,
  entry_camera_id           uuid NOT NULL REFERENCES alpr_cameras(id),
  entry_plate_event_id      uuid NOT NULL REFERENCES plate_events(id),
  entered_at                timestamptz NOT NULL DEFAULT now(),
  exit_camera_id            uuid REFERENCES alpr_cameras(id),
  exit_plate_event_id       uuid REFERENCES plate_events(id),
  exited_at                 timestamptz,
  visitor_pass_id           uuid REFERENCES visitor_passes(id),
  resident_plate_id         uuid REFERENCES resident_plates(id),
  violation_id              uuid REFERENCES alpr_violations(id),
  state                     text NOT NULL CHECK (state IN (
                              'grace',
                              'registered',
                              'resident',
                              'expired',
                              'closed_clean',
                              'closed_early',
                              'closed_post_violation'
                            )),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

-- At most one open session per plate per property. Partial index so closed
-- sessions don't take unique slots.
CREATE UNIQUE INDEX idx_plate_sessions_one_open
  ON plate_sessions (property_id, normalized_plate)
  WHERE exited_at IS NULL;

-- Supports the cron sweepers, which filter on state + open + entered_at.
CREATE INDEX idx_plate_sessions_state_open
  ON plate_sessions (state, entered_at)
  WHERE exited_at IS NULL;

-- plate_events gains a session_id so we can trace the evidence for a session.
ALTER TABLE plate_events
  ADD COLUMN session_id uuid REFERENCES plate_sessions(id);
CREATE INDEX idx_plate_events_session_id ON plate_events(session_id) WHERE session_id IS NOT NULL;

-- Violations gain the same FK plus the new "left before tow" timestamp for
-- the 8th Confirmation Review queue.
ALTER TABLE alpr_violations
  ADD COLUMN session_id uuid REFERENCES plate_sessions(id),
  ADD COLUMN left_before_tow_at timestamptz;
