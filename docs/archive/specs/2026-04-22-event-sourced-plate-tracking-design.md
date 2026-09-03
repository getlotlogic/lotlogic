# Event-Sourced Plate Tracking

**Date:** 2026-04-22
**Status:** Approved (design aligned with Gabe, ready for implementation plan)
**Supersedes:** Exit-camera logic in `2026-04-20-camera-session-state-machine-design.md`
**Applies to:** Truck plazas; generalizes to all property types

## Why this exists

The previous design required cameras to be tagged `orientation='entry'` or
`'exit'`, and the session lifecycle depended on explicit exit events. Reality
at truck plazas breaks both assumptions:

1. **Cameras are bidirectional.** Physical geometry and 6mm lens zoom mean an
   "exit" camera will sometimes catch an incoming vehicle its paired "entry"
   camera missed, and vice versa. Labels are noise.
2. **Silence is ambiguous.** A truck parked for 40 hours produces zero camera
   events. We can't distinguish "in lot, silent" from "gone" using detection
   gaps alone.
3. **Parked trucks have no exit burst.** Milesight cameras are motion-
   triggered. A truck that arrives, parks for 47 of 48 hours, and drives out
   produces exactly one entry burst and one exit burst — we can't schedule
   closure by silence without false-closing parked trucks.

This design reframes the problem around what we actually have (timestamped
detection events + registration data) and what questions we actually need to
answer.

## Core insight

**`plate_events` is the source of truth. `plate_sessions` is a materialized
view over it.** Every question the system needs to answer — "is this truck in
the lot?", "did they leave before tow?", "how long were they here?" — is a
query on `plate_events.created_at`, not a state-machine transition.

Exit is a retrospective inference from "last detection age," never a real-
time event we try to catch.

## Timing policy

| Phase | Grace | Rationale |
|---|---|---|
| **Entry grace** (no pass yet) | 15 minutes | Driver walks to QR sign, scans, fills form |
| **Overstay grace** (pass expired) | 5 minutes | Just drive out |
| **Post-visit cooldown** | 24 hours | Prevent register-leave-come-back abuse |

## Session state machine (simplified)

```
(no session) ──first detection──> grace
grace        ──15 min, no pass──> expired (+ violation)
grace        ──QR register────> registered
registered   ──valid_until + 5m, still here──> expired (+ overstay violation)
registered   ──valid_until + 2h, no recent detection──> closed_clean (+ 24h hold)
expired      ──tow confirmed / dismissed / 30d cleanup──> closed (+ 24h hold)
resident     (never closes)
```

**Key properties:**
- Sessions never close on detection-silence alone.
- A detection on an existing open session always extends it (no gap check).
- Session close triggers cooldown hold creation (except for `resident`).
- Close time = `last_detected_at` (best estimate of physical exit), not cron
  wall-clock time.

## Detection matching (simplified)

For every incoming `plate_event`:

1. Fuzzy-match plate against open sessions at the property (existing logic —
   anchor-based, OCR-confusion-aware, activity-window scan of plate_events).
2. **If matched: update session's `last_detected_at = now()`. Done.** No gap
   check, no orientation check, no exit-path branching.
3. If not matched: open new session in `grace` state.

**Removed concepts:**
- `camera.orientation` — ignored at runtime (column kept for schema
  compatibility but no code reads it).
- Exit-path code in `camera-snapshot/index.ts` (decideExitOutcome,
  applyExitOutcome invocations).
- Exit-driven hold creation (holds now created on session close, not on
  detection).

## Data model changes

### Migration 018: `last_detected_at` on `plate_sessions`

```sql
ALTER TABLE public.plate_sessions
  ADD COLUMN IF NOT EXISTS last_detected_at TIMESTAMPTZ;

-- Backfill from existing plate_events
UPDATE public.plate_sessions ps
   SET last_detected_at = COALESCE(
     (SELECT max(created_at) FROM plate_events WHERE session_id = ps.id),
     ps.entered_at
   )
 WHERE last_detected_at IS NULL;

ALTER TABLE public.plate_sessions
  ALTER COLUMN last_detected_at SET NOT NULL,
  ALTER COLUMN last_detected_at SET DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_plate_sessions_last_detected_open
  ON public.plate_sessions (property_id, last_detected_at DESC)
  WHERE exited_at IS NULL;
```

### No new columns on `plate_events`

Events are already timestamped. Existing `created_at` is the entire signal.

## Cron changes

All changes apply to the existing `supabase/functions/cron-sessions-sweep/`
function. pg_cron continues to hit it every minute.

### New step: `overstayExpiry()`

Fires a violation when a registered session's pass expired more than 5
minutes ago and the session hasn't transitioned to `expired` yet.

```typescript
async function overstayExpiry() {
  const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data: sessions } = await db
    .from("plate_sessions")
    .select("id, property_id, plate_text, entry_plate_event_id, visitor_pass_id, visitor_passes(valid_until)")
    .eq("state", "registered")
    .is("exited_at", null);
  for (const s of sessions ?? []) {
    const vu = s.visitor_passes?.valid_until;
    if (!vu) continue;
    if (new Date(vu) < new Date(cutoff)) {
      await createViolationAndDispatch(
        s.property_id, s.plate_text, s.entry_plate_event_id, s.id, "overstay"
      );
    }
  }
}
```

Runs in sequence: registrationTransition → graceExpiry → **overstayExpiry**
→ passExpiry (kept as legacy safety net for now) → closeRegistered (below).

### New step: `closeRegistered()`

Closes registered sessions whose pass expired > 2 hours ago with no recent
detections, and creates a 24h `plate_holds` row.

```typescript
async function closeRegistered() {
  const bufferCutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const { data: sessions } = await db
    .from("plate_sessions")
    .select("id, property_id, normalized_plate, last_detected_at, visitor_passes(valid_until)")
    .eq("state", "registered")
    .is("exited_at", null);
  for (const s of sessions ?? []) {
    const vu = s.visitor_passes?.valid_until;
    if (!vu) continue;
    if (new Date(vu) > new Date(bufferCutoff)) continue;  // not ready yet

    // Close session
    await db.from("plate_sessions")
      .update({
        state: "closed_clean",
        exited_at: s.last_detected_at,
      })
      .eq("id", s.id);

    // Create 24h cooldown hold
    const holdUntil = new Date(new Date(s.last_detected_at).getTime() + 24 * 60 * 60 * 1000);
    await db.from("plate_holds").insert({
      property_id: s.property_id,
      normalized_plate: s.normalized_plate,
      hold_until: holdUntil.toISOString(),
      reason: "post_visit_cooldown",
      source_session_id: s.id,
    });
  }
}
```

### New step: `closeExpired()` (optional, run hourly)

Closes `expired` sessions whose associated violation has been fully resolved
(tow confirmed, dismissed, or marked no-tow). Creates a 24h hold.

```typescript
async function closeExpired() {
  const { data: sessions } = await db
    .from("plate_sessions")
    .select("id, property_id, normalized_plate, last_detected_at, violation_id, alpr_violations(status, tow_confirmed_at)")
    .eq("state", "expired")
    .is("exited_at", null);
  for (const s of sessions ?? []) {
    const v = s.alpr_violations;
    if (!v) continue;
    const resolved = v.status === "resolved" || v.tow_confirmed_at !== null;
    if (!resolved) continue;
    // close + hold (same as closeRegistered)
  }
}
```

### Stale cleanup (daily)

Any session open > 30 days → close as `closed_stale`, no hold created.

## Edge function changes (`camera-snapshot/index.ts`)

### On every matching detection: update `last_detected_at`

```typescript
// In the entry path, after confirming openSession exists:
await db.from("plate_sessions")
  .update({ last_detected_at: now.toISOString() })
  .eq("id", openSession.id);
```

And on `insertSession`: include `last_detected_at: enteredAt` in the row.

### Remove exit-path branching

Delete the entire `if (camera.orientation === "exit") { ... }` block
(~60 lines). The matching-path handles both directions implicitly — every
detection updates `last_detected_at`; sessions close via cron.

### Keep

- Anchor-based fuzzy match (already deployed)
- Three-layer plate plausibility filter (already deployed)
- USDOT/MC OCR fallback + burst mode
- `dispatchTowConfirm()` fan-out (useful for partner tow-truck plate sightings)

## Dashboard changes (`frontend/dashboard.html`)

### "In Lot Now" query

Replace `exited_at IS NULL` filter with recency check:

```javascript
// Old:
.from('plate_sessions').select(...)
  .eq('property_id', propertyId)
  .is('exited_at', null)

// New:
.from('plate_sessions').select(...)
  .eq('property_id', propertyId)
  .is('exited_at', null)
  .gt('last_detected_at', new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString())
  // 2h activity window — hide sessions that have been silent longer,
  // even if not yet closed by cron
```

### Display last-seen age on cards

```jsx
<span>Last seen {formatAgo(session.last_detected_at)}</span>
```

## Derived signals (queries, not state)

```sql
-- Is a given plate currently "in lot"?
SELECT 1 FROM plate_sessions
 WHERE property_id = :p AND normalized_plate = :plate
   AND exited_at IS NULL AND last_detected_at > now() - interval '2 hours';

-- Left before tow? (retrospective)
-- A violation has tow_confirmed_at set. Did we detect the violator's plate
-- within the N minutes before tow confirmation? If YES, they were still
-- around. If NO, they'd already left — flag left_before_tow.
UPDATE alpr_violations v
   SET left_before_tow_at = (
     SELECT max(pe.created_at) FROM plate_events pe
      WHERE pe.normalized_plate = regexp_replace(upper(v.plate_text), '[^A-Z0-9]', '', 'g')
        AND pe.property_id = v.property_id
        AND pe.created_at BETWEEN v.dispatched_at AND v.tow_confirmed_at
   )
 WHERE v.tow_confirmed_at IS NOT NULL
   AND v.left_before_tow_at IS NULL
   AND NOT EXISTS (...);
```

## What gets retired

- `camera.orientation` runtime branching (column stays for schema compat)
- Exit-path in `index.ts`: ~60 lines of code
- `decideExitOutcome` / `applyExitOutcome` kept in `sessions.ts` for reference
  but no longer called (can delete in a followup cleanup commit)
- `findOpenSession` still used by `findSimilarOpenSession` (fast-path exact
  match) — keep

## What stays

- Anchor-based fuzzy match + OCR confusion pairs
- Three-layer plate plausibility filter
- USDOT/MC fallback + burst mode
- Backend `enforce_plate_hold` trigger (already exists, just needs holds to
  start flowing again)

## Testing plan

### Unit (edge function tests)

- New detection matches open session → session's `last_detected_at` updated,
  no new session created
- New detection has no matching open session → new session opens in `grace`
- Detection does NOT check orientation in any branch

### Migration dry-run

Apply migration 018 to a copy of prod, verify `last_detected_at` backfilled
correctly for all existing sessions (value = max plate_events.created_at or
entered_at).

### Cron simulation

Synthetic data: create a registered session with `valid_until = now() - 1 min`
and no plate_events after `valid_until - 15 min`. Run cron. Assert:
- After ≥ 5 min past valid_until: violation fires, state = `expired`
- After ≥ 2 h past valid_until: session closes with state = `closed_clean`,
  plate_holds row exists with hold_until = last_detected_at + 24h

### E2E (once PR quota restored)

1. Drive past camera, scan QR, register 12h pass
2. Wait 11h59m → detection shouldn't affect anything (still registered)
3. Wait another 2 min → violation fires (5 min overstay grace elapsed, pass
   expired >5m ago)
4. Drive out → session stays expired, detection updates last_detected_at
5. Cron eventually closes session + creates 24h hold
6. Try registering same plate immediately → backend trigger rejects
   (PLATE_HOLD)
7. Wait 24h → hold expires → plate can register again

## Implementation order

1. Migration 018 (schema additive, safe to apply immediately)
2. Edge function: update `last_detected_at` on match (single insert path
   change, no behavior change yet)
3. Cron: add overstayExpiry step (5 min grace)
4. Cron: add closeRegistered step (2h buffer after pass)
5. Edge function: retire exit-path branching
6. Dashboard: "In Lot Now" recency filter
7. Smoke test end-to-end when PR quota restored

Each step deploys independently. Step 5 is the visible behavior change for
operators (no more bogus "exit" processing); steps 1-4 are invisible until
triggered by real pass expiries.

## Rollback

Each migration is additive. The edge function can be redeployed from main
at any point. Cron additions are idempotent (guarded by state checks). If
the full design is wrong, we can disable the new cron steps and leave the
existing behavior in place.

## Open question (deferred)

**Per-property configurability** of grace minutes, overstay grace, cooldown
hours. Currently hardcoded as 15 / 5 / 24. Apartments may want different
values. Parameterize later if needed; for now, one truck plaza property so
hardcoded is fine.
