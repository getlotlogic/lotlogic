# Camera Session State Machine (4-camera truck-plaza enforcement)

**Date:** 2026-04-20
**Owner:** Gabe
**Status:** Draft — pending implementation plan
**Builds on:** `docs/superpowers/specs/2026-04-19-milesight-pr-integration-design.md` (the `camera-snapshot` ingest that this spec extends)

## Why this exists

Tomorrow's install puts four Milesight 4G Traffic Sensing Cameras at Charlotte
Travel Plaza: two entrances × (entry camera, exit camera). The existing
`camera-snapshot` function treats every detection as an entry and fires a
tow-dispatch email immediately on any unmatched plate. That's wrong for a
truck plaza, where:

- A driver is expected to park, walk to a sign with a QR code, and register in
  the first 15 minutes.
- A registered driver is given a duration (12 / 24 / 36 / 48 h) and should not
  be penalized if they stay within that window.
- A driver who leaves **before** their registered duration was up should be
  penalized — that's the pattern of abuse the plaza is trying to prevent
  (register, then use the spot for something else, then come back later).
- The tow partner's truck is itself an ANPR-visible plate; its arrival at the
  lot should automatically confirm the tow.

This spec defines the state machine that handles all of that.

## Goals

1. Every plate entering the lot opens a session; every exit closes one.
2. The 15-minute grace timer applies once per session and is strictly
   event-driven (based on exit-camera sightings), not presence-inferred.
3. Drivers can register during the grace window; registering transitions the
   session from grace → registered and suspends the tow.
4. Pass expiry (registered duration elapsed while still in lot) dispatches a
   tow.
5. Early exit (leaving while a registered pass is still valid) cancels the
   pass and places a 24-hour hold on the plate.
6. Held plates cannot register. If a held plate enters, the same 15-minute
   grace fires a tow on expiry, because the driver has no way to escape via
   registration.
7. Tow confirmation happens when the tow truck's own plate is detected
   on-site; a driver who exits after dispatch but before tow confirmation is
   flagged "left before tow" for operator review.

## Non-goals (deferred)

- Per-vehicle-type rules. We capture `vehicle.type` from Plate Recognizer on
  every session but do not branch business logic on it.
- Multi-lot support within one property. Charlotte Travel Plaza is treated as
  a single lot.
- Configurable grace / hold durations at runtime. The 15 min and 24 h values
  are constants in this iteration; we'll promote them to env vars later.
- Self-service pass cancellation from the driver. The only mechanism that
  cancels a pass is the exit-camera-triggered early-exit flow.
- Manual session open/close overrides for operators. Future work.

## Architecture

```
┌──────────────────────────────────┐
│  4 Milesight cameras              │
│  Entrance A / B × entry / exit    │
│  orientation tagged in DB         │
└──────────────┬───────────────────┘
               │ JSON POST (values.image = base64 JPEG, values.devMac)
               ▼
┌──────────────────────────────────┐
│  camera-snapshot (Supabase edge)  │
│  1. parse Milesight JSON          │
│  2. look up alpr_cameras row      │
│  3. call PR /v1/plate-reader      │
│  4. upload snapshot to R2         │
│  5. open or close plate_sessions  │
│  6. write plate_events            │
│  7. fire tow-confirm (fire+forget)│
│  NEVER fires tow-dispatch-email   │
│  directly anymore.                │
└──────────┬──────────────┬────────┘
           ▼              ▼
        plate_sessions   plate_events  (session_id FK)
           ▲
           │ timer-driven reads
┌──────────┴─────────────────────────────┐
│  pg_cron sweepers (every 1 minute)     │
│  - cron-registration-transition        │
│    (grace -> registered on new pass)   │
│  - cron-grace-expiry                   │
│    (grace -> expired + violation)      │
│  - cron-pass-expiry                    │
│    (registered -> expired + violation) │
│  Each dispatches tow-dispatch-email    │
│  on violations they create.            │
└──────────┬─────────────────────────────┘
           ▼
      alpr_violations  (session_id FK, left_before_tow_at column)
           │
           ▼
    partner email -> backend -> action_taken recorded
           │
           ▼
    tow-confirm (existing, receives a hook from camera-snapshot on every
    exit-camera event; matches tow-truck plates to open violations and sets
    tow_confirmed_at)
```

## Decisions (from brainstorm)

| # | Question | Answer |
|---|---|---|
| 1 | Grace start point — every entry event, or first after clean exit? | One timer per session. A session is entry → exit. |
| 2 | Residents exempt or same? | Residents totally exempt. They match `resident_plates`, get `state='resident'`, no timers apply. |
| 3 | Min registration duration? | Discrete choices: 12 h / 24 h / 36 h / 48 h. |
| 4 | Held-plate re-entry rule | Same 15-min rule as any other session. Held plates can't register, so tow always fires at t+15m. |
| 5 | Exit while held | 24 h hold runs from the original penalty time, not restarted. |
| 6 | Multiple entries no exit | Treat subsequent entries as noise; session stays open. |
| 7 | "Left before tow" detection | Exit seen AFTER `dispatched_at` AND BEFORE `tow_confirmed_at`. Exact detection because `tow_confirmed_at` is set by scanning the tow truck's own plate. |
| 8 | "Saved for review" location | New 8th queue in Billing → Confirmation Review, named "Left before tow". Per-row operator actions: Bill Anyway, Mark No-Tow, Pause (consistent with existing queues). |

## Data model

### Migration 011 — camera orientation

```sql
ALTER TABLE alpr_cameras
  ADD COLUMN orientation TEXT NOT NULL DEFAULT 'entry'
  CHECK (orientation IN ('entry', 'exit'));
ALTER TABLE alpr_cameras ALTER COLUMN orientation DROP DEFAULT;
```

Existing row (`Front Gate`) takes `'entry'`. Every future camera registration
must specify explicitly.

### Migration 012 — plate_sessions + plate_events.session_id

```sql
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

CREATE UNIQUE INDEX idx_plate_sessions_one_open
  ON plate_sessions (property_id, normalized_plate)
  WHERE exited_at IS NULL;

CREATE INDEX idx_plate_sessions_state_open
  ON plate_sessions (state, entered_at)
  WHERE exited_at IS NULL;

ALTER TABLE plate_events
  ADD COLUMN session_id uuid REFERENCES plate_sessions(id);

ALTER TABLE alpr_violations
  ADD COLUMN session_id uuid REFERENCES plate_sessions(id),
  ADD COLUMN left_before_tow_at timestamptz;
```

**State semantics:**

- `grace` — session open, <15 min since entry, no pass matched yet.
- `registered` — session open, has a linked active `visitor_pass`.
- `resident` — session open, plate matched `resident_plates` at entry time;
  never subject to any timer.
- `expired` — session open, grace or pass ran out; a violation was dispatched;
  we are waiting for an exit to see if they leave before the tow truck.
- `closed_clean` — session closed, exited with no penalty.
- `closed_early` — session closed because an exit was seen while `state` was
  `registered` and `visitor_pass.valid_until > now()`. The pass was cancelled
  and a 24-h `plate_holds` row was created.
- `closed_post_violation` — session closed after `state` was already
  `expired`. If the violation still had no `tow_confirmed_at`,
  `alpr_violations.left_before_tow_at` is set at closure time.

### Migration 013 — plate_holds + billing_status view update

```sql
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

CREATE INDEX idx_plate_holds_active
  ON plate_holds (property_id, normalized_plate, hold_until DESC);
```

Active-hold check (application-level):

```sql
SELECT 1 FROM plate_holds
 WHERE property_id = :p
   AND normalized_plate = :np
   AND hold_until > now()
 LIMIT 1;
```

Update `v_violation_billing_status` to include the 8th queue:

```sql
-- add as the FIRST case so it wins over the others:
CASE
  WHEN left_before_tow_at IS NOT NULL THEN 'left_before_tow'
  -- ... existing cases ...
END
```

### Migration 014 — pg_cron jobs

```sql
-- Order matters: registration-transition runs first so that grace-expiry
-- doesn't see sessions that just got a pass.
SELECT cron.schedule('plate_sessions_registration_transition', '* * * * *',
  $$ SELECT fn_plate_sessions_registration_transition() $$);
SELECT cron.schedule('plate_sessions_grace_expiry', '* * * * *',
  $$ SELECT fn_plate_sessions_grace_expiry() $$);
SELECT cron.schedule('plate_sessions_pass_expiry', '* * * * *',
  $$ SELECT fn_plate_sessions_pass_expiry() $$);
```

The three functions are Postgres functions (PL/pgSQL) that do the SELECT +
UPDATE + INSERT described below, and issue an HTTP call to
`tow-dispatch-email` via the `http` extension. Using a Postgres function
rather than a separate edge-function cron keeps the logic in the same
database as the data it touches, avoiding the "what if the edge function
dies" worry.

## Business logic

### `camera-snapshot` flow (extended)

On every POST, after the unchanged ingest (parse JSON → PR → R2 upload):

```
for each PR result above PR_MIN_SCORE:
  plate = result.plate
  normalized = normalize(plate)
  is_entry = camera.orientation = 'entry'
  is_exit  = camera.orientation = 'exit'

  if is_entry:
    open_session = SELECT s FROM plate_sessions s
                   WHERE property_id = camera.property_id
                     AND normalized_plate = normalized
                     AND exited_at IS NULL LIMIT 1;
    if open_session:
      # noise — treat as "still in lot"
      INSERT plate_events (event_type='entry', session_id=open_session.id, ...);
      continue;

    resident_row = SELECT r FROM resident_plates r
                   WHERE property_id = camera.property_id
                     AND normalize(plate_text) = normalized
                     AND active = true LIMIT 1;
    active_pass = SELECT vp FROM visitor_passes vp
                  WHERE property_id = camera.property_id
                    AND normalize(plate_text) = normalized
                    AND cancelled_at IS NULL
                    AND (valid_from IS NULL OR valid_from <= now())
                    AND valid_until > now() LIMIT 1;

    state = resident_row      ? 'resident'
          : active_pass       ? 'registered'
          :                     'grace';
    session = INSERT plate_sessions (...) RETURNING id;
    INSERT plate_events (event_type='entry', session_id=session.id, ...);
    fire tow-confirm fire-and-forget;
    continue;

  if is_exit:
    open_session = SELECT s FROM plate_sessions s
                   WHERE property_id = camera.property_id
                     AND normalized_plate = normalized
                     AND exited_at IS NULL LIMIT 1;
    if not open_session:
      INSERT plate_events (event_type='exit', session_id=NULL, ...);
      log warn "stray exit, no matching open session";
      continue;

    INSERT plate_events (event_type='exit', session_id=open_session.id, ...);
    now_ts = now();

    if open_session.state = 'registered' AND
       pass_of(open_session).valid_until > now_ts:
      new_state = 'closed_early';
      UPDATE visitor_passes SET cancelled_at=now_ts,
                                cancelled_by='exited_early'
        WHERE id = open_session.visitor_pass_id;
      INSERT plate_holds (property_id, normalized_plate, source_session_id,
                           held_at=now_ts,
                           hold_until=now_ts + interval '24 hours',
                           reason='early_exit');

    elif open_session.state = 'expired':
      new_state = 'closed_post_violation';
      # violation dispatched earlier; now they've left
      v = SELECT * FROM alpr_violations WHERE id = open_session.violation_id;
      if v.tow_confirmed_at IS NULL:
        UPDATE alpr_violations SET left_before_tow_at = now_ts
          WHERE id = v.id;

    else:
      new_state = 'closed_clean';

    UPDATE plate_sessions
      SET state = new_state,
          exited_at = now_ts,
          exit_camera_id = camera.id,
          exit_plate_event_id = (last inserted plate_event id)
      WHERE id = open_session.id;

    fire tow-confirm fire-and-forget;
    continue;
```

### `fn_plate_sessions_registration_transition()`

```sql
UPDATE plate_sessions s
   SET state = 'registered',
       visitor_pass_id = vp.id,
       updated_at = now()
  FROM visitor_passes vp
 WHERE s.state = 'grace'
   AND s.exited_at IS NULL
   AND vp.property_id = s.property_id
   AND regexp_replace(upper(vp.plate_text), '[^A-Z0-9]', '', 'g') = s.normalized_plate
   AND vp.cancelled_at IS NULL
   AND (vp.valid_from IS NULL OR vp.valid_from <= now())
   AND vp.valid_until > now();
```

### `fn_plate_sessions_grace_expiry()`

```sql
WITH expired AS (
  SELECT id, property_id, plate_text, entry_plate_event_id
    FROM plate_sessions
   WHERE state = 'grace'
     AND exited_at IS NULL
     AND entered_at + interval '15 minutes' < now()
   FOR UPDATE SKIP LOCKED
),
violations AS (
  INSERT INTO alpr_violations (property_id, plate_event_id, plate_text,
                                status, violation_type, session_id)
  SELECT property_id, entry_plate_event_id, plate_text,
         'pending', 'alpr_unmatched', id
    FROM expired
  RETURNING id, session_id
)
UPDATE plate_sessions ps
   SET state = 'expired',
       violation_id = v.id,
       updated_at = now()
  FROM violations v
 WHERE ps.id = v.session_id;

-- Then: for each new violation, fire tow-dispatch-email.
-- Implementation via http extension in the PL/pgSQL function.
```

### `fn_plate_sessions_pass_expiry()`

```sql
-- Same shape as grace_expiry but filters on registered + valid_until past.
WITH expired AS (
  SELECT s.id, s.property_id, s.plate_text, s.entry_plate_event_id
    FROM plate_sessions s
    JOIN visitor_passes vp ON vp.id = s.visitor_pass_id
   WHERE s.state = 'registered'
     AND s.exited_at IS NULL
     AND vp.valid_until < now()
   FOR UPDATE SKIP LOCKED
),
violations AS (
  INSERT INTO alpr_violations (property_id, plate_event_id, plate_text,
                                status, violation_type, session_id)
  SELECT property_id, entry_plate_event_id, plate_text,
         'pending', 'alpr_unmatched', id
    FROM expired
  RETURNING id, session_id
)
UPDATE plate_sessions ps
   SET state = 'expired', violation_id = v.id, updated_at = now()
  FROM violations v
 WHERE ps.id = v.session_id;
```

### Backend registration-endpoint guard (lotlogic-backend repo)

Wherever the visitor_pass POST lands, add:

```python
# pseudocode — actual path is in lotlogic-backend/routers/visitor_passes.py
normalized = re.sub(r"[^A-Z0-9]", "", plate_text.upper())
held = db.execute("""
  SELECT 1 FROM plate_holds
   WHERE property_id = :p AND normalized_plate = :np AND hold_until > now()
""", {"p": property_id, "np": normalized}).first()
if held:
    raise HTTPException(409, detail={"code": "plate_on_hold",
                                     "message": "This plate is on a 24-hour hold..."})
```

## Testing

### Unit

`supabase/functions/camera-snapshot/index.test.ts` gains cases for each
branch above. Fake DB + fake R2 + fake PR response, as in the existing
pr-ingest tests.

### SQL function tests

`migrations/tests/test_session_crons.sql` (new): inserts synthetic rows,
invokes the three PL/pgSQL functions, asserts resulting states.

### Synthetic E2E

Replay canned Milesight JSON through the real `camera-snapshot` endpoint
with `orientation='entry'` and `'exit'` cameras. Assert plate_sessions +
plate_events + alpr_violations state transitions at each step.

### Real-camera smoke (Day 1)

1. Drive past each of the 4 cameras individually → exactly one event per
   camera, correct orientation.
2. Enter → wait 15 min without registering → email arrives.
3. Enter → register 24h → exit at 1h → pass cancelled, plate_holds row
   created.
4. Held plate tries to register via QR → backend 409.
5. Enter with dispatched violation (from a previous test) → leave → violation
   gets `left_before_tow_at` set.

## Rollout

1. Apply migration 011 (camera orientation).
2. Apply migration 012 (plate_sessions + FKs).
3. Apply migration 013 (plate_holds + violation fields + view).
4. Register the 3 new cameras with explicit orientation.
5. Configure each Milesight to POST to the same camera-snapshot URL.
6. Close any dangling test-run sessions/violations manually.
7. Deploy `camera-snapshot` v4 (state-machine rewrite).
8. Apply migration 014 (pg_cron schedules + PL/pgSQL functions).
9. Ship backend PR (visitor_pass hold check).
10. Ship dashboard updates (In Lot Now, Holds, Left before tow queue).
11. Smoke tests (§ "Real-camera smoke").
12. Remove `EMAIL_OVERRIDE_TO` once real partner email is configured.

## Dashboard (frontend/dashboard.html)

Scoped to the property detail page.

1. **"In Lot Now"** panel above Plate Detections.
   Query: `plate_sessions WHERE property_id = :p AND exited_at IS NULL`.
   Columns: plate, vehicle_type, entered_at (with "how long" relative),
   state, visitor_name (via visitor_pass), time until pass expires / grace
   expires, cameras involved.
2. **"Holds"** panel.
   Query: `plate_holds WHERE property_id = :p AND hold_until > now()`.
   Per-row action: **Release hold** (operator override; updates hold_until
   to now()). Audit by retaining original `held_at`.
3. **Plate Detections** — extend with a state badge sourced from
   `plate_sessions.state` via the existing `session_id` FK on plate_events.
4. **Billing → Confirmation Review → 8th queue "Left before tow"** —
   `alpr_violations WHERE left_before_tow_at IS NOT NULL AND status != 'resolved'`.
   Per-row: Bill Anyway, Mark No-Tow, Pause Billing. "View session" deep-links
   to the parent session for context.

## Monitoring

Log lines, not a dashboard. Fine for now.

- `camera-snapshot` emits a JSON-line log per event with
  `{camera_orientation, plate, session_id, new_state}`.
- Each cron function returns how many rows it transitioned; log counts.
- Weekly ops check: `SELECT * FROM plate_sessions WHERE exited_at IS NULL AND
  entered_at < now() - interval '24 hours'` (stuck sessions → missed exit
  events).

## Rollback plan

Each migration is reversible (`DROP COLUMN` / `DROP TABLE` / `DROP VIEW`).
`camera-snapshot` v4 can be rolled back to v3 by redeploying the prior
source; v3 ignores the new columns/tables. Cron jobs: `SELECT
cron.unschedule(job_name)`. Backend visitor_pass guard: single-function
removal.

## Open questions (things that will need a decision before we start
implementation, but don't require another brainstorm)

1. Should `cron-grace-expiry` skip sessions on held plates? No — same rule
   applies. Hold just prevents registration, not the timer.
2. Do we want a "resident session never closes" convention, or do residents
   get `closed_clean` on exit like everyone else? Answer: close normally on
   exit, `closed_clean`. Residents can re-enter and get a new session; we
   don't track cumulative resident stay-time.
3. Should `tow-confirm` also write to `plate_sessions` when it sets
   `tow_confirmed_at`? No — it only touches `alpr_violations`. Session state
   stays at `expired` or `closed_post_violation` depending on whether the
   violator left.
