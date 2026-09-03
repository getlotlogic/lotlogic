# Orientation-removal deliberation — pause point 2026-04-20

**Status:** Paused mid-audit. No code changes proposed or written. Everything
from the prior USDOT work shipped and is live.

## What we were discussing

Gabe proposed simplifying the ALPR pipeline by removing the entry/exit
orientation concept. His framing: "the only thing that changes is orientation."
Every camera becomes a detector; we keep sessions, holds, crons, and the
allowlist-match flow intact.

I proposed a larger rewrite first (kill sessions entirely, stateless grace).
Gabe pushed back — correctly — that the minimal change is just strip the
orientation branch in `camera-snapshot/index.ts`.

Then Gabe said: be super critical, don't mess something up by accident. I
started the audit and surfaced a real risk before he called pause.

## Findings from the audit (what I completed)

### Things that DON'T care about orientation — safe to leave alone

- `cron-sessions-sweep` (reads state + time only; never touches orientation)
- Backend `trg_visitor_passes_plate_hold` trigger (harmless if plate_holds
  stays empty — trigger just never fires)
- USDOT/MC matching in `sessions.ts` (branches on plate prefix, not camera)
- `tow-dispatch-email` (keyed off violations, not camera orientation)

### Things that DO branch on orientation / event_type

1. `supabase/functions/camera-snapshot/index.ts` lines 136, 151, 221, 277, 286
   — the entry/exit branching, plus `event_type` on every plate_event it
   inserts.
2. `supabase/functions/tow-confirm/index.ts` — **this is a load-bearing
   dependency I hadn't flagged earlier**. Lines 59 (entry branch: records
   partner_truck_sightings) and 95-97 (exit branch: correlates sightings to
   violations and sets tow_confirmed_at). If we make everything "entry",
   **tow-confirm never fires the exit correlation, and `tow_confirmed_at`
   never gets set automatically.** Partner replies via email still work, but
   the camera-driven tow confirmation silently stops working.
3. `frontend/dashboard.html`:
   - line 2782: `db.getInLotNow` selects `exit_camera_id` + filters
     `exited_at IS NULL`
   - line 2790-2805: `db.getActiveHolds`
   - line 5592-5608, 5626: Confirmation Review "Left before tow" queue
   - line 7682-7838: Holds panel + plate_holds realtime subscription
   - line 8258-8309: "In Lot Now" + "24-Hour Holds" panels

### The zombie-session problem — the real risk

This is what I wanted to surface before we commit to the plan.

Current flow: entry opens session, exit closes it (sets `exited_at`). Dedup
in camera-snapshot uses `findOpenSession` filtered by `exited_at IS NULL` —
if an open session exists for a plate, subsequent detections skip session
creation and just append plate_events.

Under "all cameras are entry-style, no exits":
- Sessions never get `exited_at` set (cron only sets state='expired', not
  exited_at).
- Every session ever opened stays "open" forever.
- If a driver returns days later after a prior violation: camera detects
  plate → `findOpenSession` finds the week-old zombie session in
  state='expired' → skips session creation → no new grace timer → no new
  violation even though they're overstaying.
- Also: `cron-sessions-sweep` keeps iterating over them because they match
  `exited_at IS NULL`. Not expensive at 1/property but grows unbounded.

**This breaks repeat-visitor handling.** Not a UI issue — an actual
enforcement gap.

### Options to close the gap (not decided)

- **A.** Age out sessions in a new cron: `UPDATE plate_sessions SET
  exited_at = now() WHERE exited_at IS NULL AND updated_at < now() -
  interval '6 hours'`. Simple, arbitrary threshold.
- **B.** Change `findOpenSession` to treat a session as "open" only if last
  activity was within N minutes (use latest `plate_events.created_at` for
  the session).
- **C.** Accept the gap — resident/employee plates get zombie sessions
  (fine, they re-match forever anyway); for temp passes, the pass's
  `valid_until` naturally bounds risk (once expired, a new detection of the
  same plate with an OPEN session in state='expired' would just stay
  silent — this is the real gap).
- **D.** My earlier proposal: stateless grace, drop sessions from the
  live-decision path, keep as audit only. Gabe pushed back on this.

None of A-C match "only orientation changes" cleanly. Each adds one piece
of logic. That's the real tension we need to resolve.

### Production state snapshot (query result 2026-04-20 18:xx UTC)

- active_cameras: 1 (the original Front Gate)
- entry_cameras: 1, exit_cameras: 0
- open_sessions_total: 0
- active_holds: 0
- left_before_tow_ever: 0

**Blast radius is tiny right now** — nothing in prod has hit the exit path
or produced a hold. If we're going to change anything, now is the lowest-
risk moment. But Charlotte Travel Plaza install was supposed to bring 4
cameras online today (2 entry + 2 exit).

## Where we paused

Gabe said "lets hold on this for now" while I was mid-audit, right after I
showed him the tow-confirm exit-branch code. He asked me to save context
and close his laptop.

## Resume instructions for future-me

1. Re-read this file (`docs/superpowers/notes/2026-04-20-orientation-removal-deliberation.md`).
2. The decision Gabe needs to make is **how to handle the zombie-session
   problem.** Options A-D above. Show him the tradeoffs and let him pick.
3. Once decided, write a consolidated plan that covers:
   - Dashboard panel cleanup (or time-filter the In Lot Now query)
   - camera-snapshot orientation-branch removal
   - The chosen zombie-handling mechanism
   - Whether to drop the `orientation` column or just ignore it
4. If Charlotte Travel Plaza is already installed with 4 cameras, check
   what orientation they were registered with. If any are 'exit', we need
   to migrate those to 'entry' (or drop the CHECK constraint) before
   changing code.
5. Migration file to consider writing: `016_drop_alpr_cameras_orientation.sql`
   — but ONLY after all code stops referencing the column.
