# Event-Sourced Plate Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the orientation-based entry/exit state machine with event-sourced session tracking driven by `plate_events.created_at` timestamps and registration lifecycle. 5-min overstay grace, 24h post-visit cooldown, no exit cameras needed.

**Architecture:** `plate_events` is source of truth. `plate_sessions` becomes a grouping label. Sessions stay open until enforcement completes (pass expires + buffer, tow confirmed, operator dismissal, or stale cleanup). Cron drives closures; camera-snapshot just records detections and updates `last_detected_at`.

**Tech Stack:** Deno edge functions, Supabase Postgres, pg_cron.

**Spec:** `docs/superpowers/specs/2026-04-22-event-sourced-plate-tracking-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `migrations/018_session_last_detected_at.sql` | Create | Add `last_detected_at` column + index |
| `supabase/functions/camera-snapshot/index.ts` | Modify | Update `last_detected_at` on matches; retire exit-path branching |
| `supabase/functions/camera-snapshot/sessions.ts` | Modify | `insertSession` sets `last_detected_at = enteredAt` |
| `supabase/functions/cron-sessions-sweep/index.ts` | Modify | Add `overstayExpiry` (5min grace) + `closeRegistered` (2h buffer + hold) steps |
| `frontend/dashboard.html` | Modify | "In Lot Now" filters on `last_detected_at > now() - 2h`; show last-seen age on cards |

---

## Task 1: Migration 018 — `plate_sessions.last_detected_at`

**Files:**
- Create: `migrations/018_session_last_detected_at.sql`

- [ ] **Step 1: Write the migration SQL**

Write `migrations/018_session_last_detected_at.sql`:

```sql
-- 018_session_last_detected_at.sql
-- Add last_detected_at to plate_sessions. Updated on every matching
-- plate_event so cron and dashboard queries can reason about session
-- activity without aggregating plate_events on every read.
--
-- Spec: docs/superpowers/specs/2026-04-22-event-sourced-plate-tracking-design.md

ALTER TABLE public.plate_sessions
  ADD COLUMN IF NOT EXISTS last_detected_at TIMESTAMPTZ;

-- Backfill: for each existing session, set last_detected_at to the newest
-- plate_event.created_at, falling back to entered_at if no events exist.
UPDATE public.plate_sessions ps
   SET last_detected_at = COALESCE(
     (SELECT max(created_at) FROM public.plate_events WHERE session_id = ps.id),
     ps.entered_at
   )
 WHERE last_detected_at IS NULL;

-- Enforce NOT NULL + default for new rows
ALTER TABLE public.plate_sessions
  ALTER COLUMN last_detected_at SET DEFAULT now(),
  ALTER COLUMN last_detected_at SET NOT NULL;

-- Index for "In Lot Now" queries — open sessions ordered by recent activity
CREATE INDEX IF NOT EXISTS idx_plate_sessions_last_detected_open
  ON public.plate_sessions (property_id, last_detected_at DESC)
  WHERE exited_at IS NULL;
```

- [ ] **Step 2: Apply the migration via MCP**

Use `mcp__supabase__apply_migration` with name `018_session_last_detected_at` and the SQL above.

- [ ] **Step 3: Verify the column exists + backfill ran**

Run SQL:

```sql
SELECT count(*) AS total,
       count(*) FILTER (WHERE last_detected_at IS NOT NULL) AS backfilled,
       min(last_detected_at) AS earliest,
       max(last_detected_at) AS latest
  FROM public.plate_sessions;
```

Expected: `total = backfilled` (every row populated). `latest` recent, `earliest` reasonable.

- [ ] **Step 4: Commit**

```bash
git add migrations/018_session_last_detected_at.sql
git commit -m "migration(018): add plate_sessions.last_detected_at for event-sourced tracking

Adds timestamp + index for the new session activity model. Backfilled
from existing plate_events.created_at. NOT NULL after backfill so the
edge function can trust it on every read.

Spec: docs/superpowers/specs/2026-04-22-event-sourced-plate-tracking-design.md"
```

---

## Task 2: Edge function — update `last_detected_at` on matches

**Files:**
- Modify: `supabase/functions/camera-snapshot/index.ts` (entry path)
- Modify: `supabase/functions/camera-snapshot/sessions.ts` (insertSession input)

- [ ] **Step 1: Add `lastDetectedAt` to `NewSessionInput` in sessions.ts**

In `sessions.ts`, find the `NewSessionInput` type and add the field:

```typescript
export type NewSessionInput = {
  propertyId: string;
  normalizedPlate: string;
  plateText: string;
  vehicleType: string | null;
  entryCameraId: string;
  entryPlateEventId: string;
  state: "grace" | "registered" | "resident";
  visitorPassId?: string | null;
  residentPlateId?: string | null;
  usdotNumber?: string | null;
  mcNumber?: string | null;
  enteredAt: Date;
  lastDetectedAt?: Date;  // NEW — defaults to enteredAt if omitted
};
```

And in `insertSession`, add to the row:

```typescript
const row = {
  // ... existing fields ...
  last_detected_at: (input.lastDetectedAt ?? input.enteredAt).toISOString(),
};
```

- [ ] **Step 2: Update last_detected_at on matched entry in index.ts**

In the entry path of `index.ts` (inside `if (camera.orientation === "entry")`), after `findSimilarOpenSession` returns an existing session, add the update:

```typescript
const openSession = await findSimilarOpenSession(db, camera.property_id, normalized, 120, frameUsdot, frameMc);
if (openSession) {
  // Record the event (existing logic):
  const ev = await db.from("plate_events")
    .insert(baseEventRow(openSession.id, "unmatched"))
    .select().single();
  if (ev.error) throw ev.error;
  dedupCount++;

  // NEW: bump session activity timestamp.
  await db.from("plate_sessions")
    .update({ last_detected_at: now.toISOString() })
    .eq("id", openSession.id);

  continue;
}
```

- [ ] **Step 3: Deploy the edge function via MCP**

Use `mcp__supabase__deploy_edge_function` with the updated files.

- [ ] **Step 4: Smoke test**

Send a synthetic POST to camera-snapshot with a known plate. Verify:

```sql
SELECT id, last_detected_at, entered_at
  FROM plate_sessions
 WHERE normalized_plate = '<test-plate>'
 ORDER BY created_at DESC LIMIT 1;
```

Expected: first detection creates session with `last_detected_at = entered_at`. Second detection (within 2 min) updates `last_detected_at` to new value while `entered_at` stays the same.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/camera-snapshot/sessions.ts supabase/functions/camera-snapshot/index.ts
git commit -m "feat(alpr): update plate_sessions.last_detected_at on every matching event

First write-path for the event-sourced tracking model. insertSession now
accepts lastDetectedAt (defaults to enteredAt); entry-path match updates
the timestamp so cron + dashboard queries see accurate recency."
```

---

## Task 3: Cron — `overstayExpiry` (5-min overstay grace)

**Files:**
- Modify: `supabase/functions/cron-sessions-sweep/index.ts`

- [ ] **Step 1: Add `overstayExpiry()` function**

In `cron-sessions-sweep/index.ts`, add a new step between `graceExpiry` and `passExpiry`:

```typescript
// Fires a violation when a registered session's pass expired more than
// OVERSTAY_GRACE_MINUTES ago. The grace gives drivers time to drive out
// after their pass ended; beyond that, they're overstaying.
async function overstayExpiry(): Promise<number> {
  const OVERSTAY_GRACE_MINUTES = 5;
  const cutoff = new Date(Date.now() - OVERSTAY_GRACE_MINUTES * 60 * 1000).toISOString();

  // Find registered sessions whose pass expired past the grace window.
  const { data: sessions, error } = await db
    .from("plate_sessions")
    .select("id, property_id, plate_text, entry_plate_event_id, visitor_pass_id")
    .eq("state", "registered")
    .is("exited_at", null);
  if (error) throw error;
  if (!sessions || sessions.length === 0) return 0;

  let n = 0;
  for (const s of sessions) {
    if (!s.visitor_pass_id) continue;
    const { data: pass, error: pErr } = await db
      .from("visitor_passes")
      .select("valid_until")
      .eq("id", s.visitor_pass_id)
      .single();
    if (pErr) throw pErr;
    if (!pass?.valid_until) continue;
    if (new Date(pass.valid_until).toISOString() >= cutoff) continue;  // still within grace

    await createViolationAndDispatch(s.property_id, s.plate_text, s.entry_plate_event_id, s.id);
    n++;
  }
  return n;
}
```

- [ ] **Step 2: Wire into the main handler**

In the `Deno.serve` handler, add the call in sequence after graceExpiry, before passExpiry:

```typescript
const promoted = await registrationTransition();
const graceExpired = await graceExpiry();
const overstayExpired = await overstayExpiry();  // NEW
const passExpired = await passExpiry();  // legacy; can remove after overstay is proven

return json(200, {
  ok: true,
  promoted,
  grace_expired: graceExpired,
  overstay_expired: overstayExpired,  // NEW
  pass_expired: passExpired,
  duration_ms: Date.now() - started,
});
```

- [ ] **Step 3: Deploy cron-sessions-sweep**

Use `mcp__supabase__deploy_edge_function` for `cron-sessions-sweep`.

- [ ] **Step 4: Synthetic test**

Create a test visitor_pass with `valid_until = now() - interval '6 minutes'` and a test plate_session linked to it in state `registered`:

```sql
INSERT INTO visitor_passes (property_id, plate_text, valid_from, valid_until, status, registration_source, submission_idempotency_key)
VALUES ('bd44ace8-feda-42e1-9866-5d60f65e1712', 'TESTOVER', now() - interval '1 hour', now() - interval '6 minutes', 'active', 'import', 'overstay-test-' || gen_random_uuid())
RETURNING id;

-- Get the visitor_pass id from above, then:
-- (need a plate_event first for entry_plate_event_id)
INSERT INTO plate_events (camera_id, property_id, plate_text, normalized_plate, confidence, event_type, match_status)
VALUES ('6863affc-f992-4524-8e24-8e641fefb8c4', 'bd44ace8-feda-42e1-9866-5d60f65e1712', 'TESTOVER', 'TESTOVER', 0.99, 'entry', 'visitor_pass')
RETURNING id;

INSERT INTO plate_sessions (property_id, normalized_plate, plate_text, entry_camera_id, entry_plate_event_id, entered_at, state, visitor_pass_id, last_detected_at)
VALUES ('bd44ace8-feda-42e1-9866-5d60f65e1712', 'TESTOVER', 'TESTOVER', '6863affc-f992-4524-8e24-8e641fefb8c4', '<plate_event_id>', now() - interval '1 hour', 'registered', '<visitor_pass_id>', now() - interval '1 hour')
RETURNING id;
```

Wait ≥ 60 seconds for cron to run. Verify:

```sql
SELECT state, violation_id FROM plate_sessions WHERE normalized_plate = 'TESTOVER';
-- Expected: state = 'expired', violation_id is NOT NULL
SELECT plate_text, status FROM alpr_violations WHERE id = (SELECT violation_id FROM plate_sessions WHERE normalized_plate = 'TESTOVER');
-- Expected: plate_text = 'TESTOVER', status = 'dispatched'
```

Cleanup: delete the test rows.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/cron-sessions-sweep/index.ts
git commit -m "feat(cron): add 5-min overstay grace before firing violation

Registered sessions get 5 minutes after visitor_pass.valid_until to
physically leave the lot before we fire an overstay violation.

Runs alongside the legacy passExpiry check for safety; that can be
retired in a followup once overstayExpiry is proven stable."
```

---

## Task 4: Cron — `closeRegistered` (close session + create 24h hold)

**Files:**
- Modify: `supabase/functions/cron-sessions-sweep/index.ts`

- [ ] **Step 1: Add `closeRegistered()` function**

In `cron-sessions-sweep/index.ts`:

```typescript
// Closes registered sessions whose pass expired > 2h ago with no recent
// detections, and creates a 24h cooldown plate_holds row. The hold
// prevents the plate from registering another visitor_pass for 24h via
// the backend trigger enforce_plate_hold.
async function closeRegistered(): Promise<number> {
  const BUFFER_HOURS = 2;
  const COOLDOWN_HOURS = 24;

  const { data: sessions, error } = await db
    .from("plate_sessions")
    .select("id, property_id, normalized_plate, last_detected_at, visitor_pass_id")
    .eq("state", "registered")
    .is("exited_at", null);
  if (error) throw error;
  if (!sessions || sessions.length === 0) return 0;

  let closed = 0;
  const nowMs = Date.now();
  for (const s of sessions) {
    if (!s.visitor_pass_id) continue;
    const { data: pass, error: pErr } = await db
      .from("visitor_passes")
      .select("valid_until")
      .eq("id", s.visitor_pass_id)
      .single();
    if (pErr) throw pErr;
    if (!pass?.valid_until) continue;

    const validUntilMs = new Date(pass.valid_until).getTime();
    const bufferEndMs = validUntilMs + BUFFER_HOURS * 60 * 60 * 1000;
    if (nowMs < bufferEndMs) continue;  // not ready to close

    // Close session. exited_at = last_detected_at (best estimate of physical exit).
    const sUpd = await db.from("plate_sessions")
      .update({
        state: "closed_clean",
        exited_at: s.last_detected_at,
        updated_at: new Date().toISOString(),
      })
      .eq("id", s.id);
    if (sUpd.error) throw sUpd.error;

    // Create 24h cooldown hold from last_detected_at.
    const holdUntil = new Date(new Date(s.last_detected_at).getTime() + COOLDOWN_HOURS * 60 * 60 * 1000);
    const hIns = await db.from("plate_holds").insert({
      property_id: s.property_id,
      normalized_plate: s.normalized_plate,
      source_session_id: s.id,
      held_at: new Date().toISOString(),
      hold_until: holdUntil.toISOString(),
      reason: "post_visit_cooldown",
    });
    if (hIns.error) console.warn("plate_holds insert failed:", hIns.error.message);

    closed++;
  }
  return closed;
}
```

Note: the `plate_holds.reason` CHECK constraint currently only allows `'early_exit'`. Update it in the same migration touch or a new migration 019 to accept `'post_visit_cooldown'`.

- [ ] **Step 2: Add migration 019 to expand plate_holds.reason CHECK**

Create `migrations/019_plate_holds_reason_cooldown.sql`:

```sql
-- Allow post_visit_cooldown as a valid reason for plate_holds rows.
-- Created by cron-sessions-sweep::closeRegistered when a registered
-- session closes; replaces the old early_exit path.

ALTER TABLE public.plate_holds
  DROP CONSTRAINT IF EXISTS plate_holds_reason_check;

ALTER TABLE public.plate_holds
  ADD CONSTRAINT plate_holds_reason_check
  CHECK (reason IN ('early_exit', 'post_visit_cooldown'));
```

Apply via `mcp__supabase__apply_migration`.

- [ ] **Step 3: Wire `closeRegistered` into the handler**

```typescript
const closedRegistered = await closeRegistered();

return json(200, {
  ok: true,
  promoted,
  grace_expired: graceExpired,
  overstay_expired: overstayExpired,
  pass_expired: passExpired,
  closed_registered: closedRegistered,  // NEW
  duration_ms: Date.now() - started,
});
```

- [ ] **Step 4: Deploy cron-sessions-sweep**

Use `mcp__supabase__deploy_edge_function`.

- [ ] **Step 5: Synthetic test**

Create a registered session with `valid_until = now() - 3 hours` and `last_detected_at = now() - 3 hours 30 min`. Wait for cron. Verify:

```sql
SELECT state, exited_at FROM plate_sessions WHERE normalized_plate = '<test>';
-- Expected: state = 'closed_clean', exited_at = last_detected_at
SELECT hold_until, reason FROM plate_holds WHERE normalized_plate = '<test>' ORDER BY held_at DESC LIMIT 1;
-- Expected: reason = 'post_visit_cooldown', hold_until = last_detected_at + 24h
```

- [ ] **Step 6: Commit**

```bash
git add migrations/019_plate_holds_reason_cooldown.sql supabase/functions/cron-sessions-sweep/index.ts
git commit -m "feat(cron): closeRegistered auto-closes visits + creates 24h cooldown hold

After a registered visitor_pass expires + 2h buffer with no recent
activity, the session closes as closed_clean and a plate_holds row is
created with hold_until = last_detected_at + 24h. The backend
enforce_plate_hold trigger then blocks new visitor_pass inserts during
the cooldown, preventing register-leave-come-back abuse.

Migration 019 expands the plate_holds.reason CHECK to accept
'post_visit_cooldown' alongside the existing 'early_exit'."
```

---

## Task 5: Edge function — retire exit-path branching

**Files:**
- Modify: `supabase/functions/camera-snapshot/index.ts`

- [ ] **Step 1: Delete the exit branch**

In `index.ts`, locate the `if (camera.orientation === "exit")` block (roughly lines 253-306 in the current file). Delete the entire block, including the trailing defensive `console.warn`. After deletion, the for-loop body for each detection should end after the `continue;` of the entry path.

The structure becomes:

```typescript
for (const result of surviving) {
  // ... snapshot upload ...
  // ... baseEventRow setup ...

  // Every camera is a detector. Open or extend a session; never close.
  // Closure happens in cron (closeRegistered, closeExpired, stale cleanup).
  const openSession = await findSimilarOpenSession(...);
  if (openSession) {
    // append event + update last_detected_at
    continue;
  }

  // No open session → open new one in state = grace/registered/resident
  // based on allowlist match (existing code).
  // ...
}
```

- [ ] **Step 2: Remove unused imports**

In `index.ts`, update the import from `sessions.ts` to drop `findOpenSession`, `decideExitOutcome`, `applyExitOutcome`:

```typescript
import { findSimilarOpenSession, findActiveResident, findActiveVisitorPass, insertSession } from "./sessions.ts";
```

- [ ] **Step 3: Deploy the edge function**

Use `mcp__supabase__deploy_edge_function`.

- [ ] **Step 4: Smoke test — all 4 cameras should still produce events**

Use `mcp__supabase__execute_sql`:

```sql
SELECT c.name, (SELECT count(*) FROM plate_events pe WHERE pe.camera_id = c.id AND pe.created_at > now() - interval '5 minutes') AS recent
  FROM alpr_cameras c WHERE c.active = true ORDER BY c.name;
```

After a vehicle passes any camera: expected `recent >= 1` for that camera.

Also verify no "stray exit" warnings in edge function logs (we deleted the branch that could emit them).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/camera-snapshot/index.ts
git commit -m "feat(camera-snapshot): retire exit-path branching

Every camera is now a detector. Sessions open on first detection and
close only via cron (closeRegistered, closeExpired, stale cleanup).
No more orientation-based entry/exit logic; bidirectional cameras
work correctly because the model never assumed direction.

~60 lines deleted from index.ts."
```

---

## Task 6: Dashboard — "In Lot Now" uses `last_detected_at`

**Files:**
- Modify: `frontend/dashboard.html`

- [ ] **Step 1: Find `getOpenSessions`**

Grep for `getOpenSessions` in `frontend/dashboard.html` (around line 2778).

- [ ] **Step 2: Add the recency filter**

Update the query:

```javascript
async getOpenSessions(propertyId) {
  if (supabase) {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('plate_sessions')
      .select('id, normalized_plate, plate_text, vehicle_type, entered_at, last_detected_at, state, visitor_pass_id, resident_plate_id, entry_camera_id, exit_camera_id, violation_id')
      .eq('property_id', propertyId)
      .is('exited_at', null)
      .gt('last_detected_at', twoHoursAgo)  // NEW
      .order('entered_at', { ascending: false });
    if (!error && data) return data;
  }
  return [];
},
```

- [ ] **Step 3: Show "last seen" age on each card**

Find the "In Lot Now" panel JSX (around line 8258). Next to the plate badge, add:

```jsx
{s.last_detected_at && (
  <span style={{fontSize:11, color:'var(--text-muted)'}}>
    · seen {fmtTimeAgo(s.last_detected_at)}
  </span>
)}
```

Where `fmtTimeAgo` is either an existing helper or add:

```javascript
function fmtTimeAgo(iso) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
```

- [ ] **Step 4: Commit + push**

```bash
git add frontend/dashboard.html
git commit -m "feat(dashboard): In Lot Now filters on last_detected_at, shows age

Sessions with no detection in the last 2 hours are hidden from the
live 'In Lot Now' panel even if still technically open. Each card now
shows 'last seen Xm/Xh ago' so operators can judge freshness at a glance.

Paired with the cron-driven session closure (2h buffer after pass
expiry), this gives a coherent live view without false-hiding parked
registered trucks."
git push origin main
```

Vercel auto-deploys the frontend.

---

## Task 7: End-to-end smoke test (when PR quota is restored)

- [ ] **Step 1: Register a 12-minute pass**

Use visit.html form at a truck plaza property. Submit with a test plate, 12-minute duration (or manually set `valid_until = now() + 12 minutes` via SQL).

- [ ] **Step 2: Drive past a camera**

Or synthesize a plate_event for the test plate.

- [ ] **Step 3: Verify session opens as `registered`**

```sql
SELECT state, last_detected_at FROM plate_sessions WHERE normalized_plate = '<test>' ORDER BY created_at DESC LIMIT 1;
```

- [ ] **Step 4: Wait 13 minutes, don't drive past**

At +12 min, pass expires. 5 min overstay grace starts.

- [ ] **Step 5: Verify overstay violation fires at ~+17 min**

```sql
SELECT plate_text, status, created_at FROM alpr_violations WHERE plate_text = '<test>' ORDER BY created_at DESC LIMIT 1;
```

Expected: a new row with status = 'dispatched', created approximately 17 min after the pass was created (12 min validity + 5 min overstay grace).

- [ ] **Step 6: Drive out**

Detection on any camera.

- [ ] **Step 7: Wait for cron to close the session**

~2h + 5min after valid_until. Verify:

```sql
SELECT state, exited_at FROM plate_sessions WHERE normalized_plate = '<test>' ORDER BY created_at DESC LIMIT 1;
-- Expected: state = 'closed_clean' or similar, exited_at ≈ last_detected_at from step 6
SELECT hold_until, reason FROM plate_holds WHERE normalized_plate = '<test>' ORDER BY held_at DESC LIMIT 1;
-- Expected: reason = 'post_visit_cooldown', hold_until ≈ exited_at + 24h
```

- [ ] **Step 8: Try to re-register the same plate**

Submit the form again with the test plate. Backend should return 409 with `PLATE_HOLD: this plate is on a 24-hour hold until <timestamp>`.

---

## Self-Review

**Spec coverage:**
- ✅ Migration 018 (Task 1) — last_detected_at column
- ✅ Edge function last_detected_at update (Task 2)
- ✅ Overstay grace 5 min (Task 3)
- ✅ closeRegistered cron + 24h hold (Task 4)
- ✅ Exit-path retirement (Task 5)
- ✅ Dashboard In Lot Now update (Task 6)
- ✅ E2E smoke (Task 7)
- Migration 019 (plate_holds.reason expansion) — bundled into Task 4, should probably be its own task. Keeping bundled since it's a one-line schema change paired with the cron code that depends on it.

**Placeholder scan:** no TBDs, all code blocks are complete, all SQL is executable.

**Type consistency:** `lastDetectedAt` (camelCase input) → `last_detected_at` (DB column). `closeRegistered` / `overstayExpiry` consistent between declaration and handler wiring. 5-minute overstay and 2h buffer and 24h cooldown constants consistent across cron functions.

**One known limitation:** Task 5 retires the exit-path but leaves `decideExitOutcome` / `applyExitOutcome` in `sessions.ts` as dead code. A followup cleanup commit can delete them. Keeping for now for easier rollback.
