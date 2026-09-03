# Camera Session State Machine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing `camera-snapshot` edge function and database schema to enforce a 15-minute grace timer, session lifecycle (entry → exit), early-exit 24-h plate holds, pass-expiry tows, and "left before tow" detection across four cameras at Charlotte Travel Plaza.

**Architecture:** `camera-snapshot` branches on `alpr_cameras.orientation` (`entry` | `exit`) and opens/closes `plate_sessions` rows instead of firing a tow email on every unmatched plate. Three `pg_cron` jobs run every minute against `plate_sessions` to transition state (`grace` → `registered` / `expired`) and dispatch `tow-dispatch-email` only on timer-driven violations. Early exit during a registered session cancels the `visitor_pass` and inserts a `plate_holds` row that blocks re-registration for 24 h. Spec at `docs/superpowers/specs/2026-04-20-camera-session-state-machine-design.md`.

**Tech Stack:** PostgreSQL (Supabase), Deno edge functions, `pg_cron` + `pg_net` extensions for scheduled HTTP calls, TypeScript for edge function, vanilla JS + Supabase client for the dashboard.

---

## File Structure

| Path | Purpose |
|---|---|
| `migrations/011_alpr_cameras_orientation.sql` | Add `orientation` column to `alpr_cameras`, NOT NULL with deferred default |
| `migrations/012_plate_sessions.sql` | Create `plate_sessions` table + partial unique index + state CHECK; add `session_id` FK on `plate_events` and `alpr_violations`; add `left_before_tow_at` on `alpr_violations` |
| `migrations/013_plate_holds.sql` | Create `plate_holds` table; update `v_violation_billing_status` view for the 8th queue |
| `migrations/014_session_cron_jobs.sql` | PL/pgSQL functions `fn_plate_sessions_*` + `cron.schedule(...)` for the three sweepers; uses `pg_net` for fire-and-forget HTTP to `tow-dispatch-email` |
| `supabase/functions/camera-snapshot/sessions.ts` | Pure session-logic helpers: `findOpenSession`, `openEntrySession`, `closeExitSession`, state transitions |
| `supabase/functions/camera-snapshot/holds.ts` | `isPlateHeld(db, propertyId, normalizedPlate)` helper |
| `supabase/functions/camera-snapshot/index.ts` | Modified: branch on `camera.orientation`; call session helpers; no longer fire tow-dispatch-email directly |
| `supabase/functions/camera-snapshot/extract.ts` | Modified: expose `vehicle_type` from PR response on every result |
| `supabase/functions/camera-snapshot/index.test.ts` | New cases for entry branches (resident / registered / grace / held) and exit branches (clean / early / post-violation) |
| `frontend/dashboard.html` | Modified: four panel additions (In Lot Now, Holds, state badge on Plate Detections, Left Before Tow queue) |

**Why this split:** `sessions.ts` and `holds.ts` are pure, DB-only helpers — trivially testable with fake clients and easy to reason about in isolation. `index.ts` stays a thin orchestrator that picks a branch based on orientation and delegates. `extract.ts` gains one field. The migrations are sequenced so each is reversible on its own.

**Out of repo (coordinating tasks, not implementation steps):**
- `lotlogic-backend/routers/visitor_passes.py` — add a pre-insert check against `plate_holds`. Documented in Task 19 below as a hand-off; the PR happens in the backend repo.

---

## Task 0: Pre-flight

**Files:** none

- [ ] **Step 1: Confirm `pg_net` + `pg_cron` extensions are available**

Supabase ships both enabled but dormant. Verify:

```sql
SELECT extname FROM pg_extension WHERE extname IN ('pg_cron', 'pg_net');
```

Expected: two rows. If either is missing, enable via the Supabase dashboard (Database → Extensions) before starting Task 10.

- [ ] **Step 2: Capture current state**

```sql
SELECT COUNT(*) FROM alpr_cameras;          -- expect: 1
SELECT id, api_key, name FROM alpr_cameras;
SELECT COUNT(*) FROM plate_events WHERE created_at > now() - interval '1 day';
```

Record the existing camera's UUID; Task 1's seeding targets it explicitly.

---

## Task 1: Migration 011 — `alpr_cameras.orientation`

**Files:**
- Create: `migrations/011_alpr_cameras_orientation.sql`

- [ ] **Step 1: Write the migration**

Create `migrations/011_alpr_cameras_orientation.sql`:

```sql
-- Tag every camera with an orientation so camera-snapshot can branch on it.
-- The existing Charlotte Travel Plaza 'Front Gate' camera is set to 'entry'
-- since it was positioned to catch incoming vehicles.

ALTER TABLE alpr_cameras
  ADD COLUMN orientation TEXT NOT NULL DEFAULT 'entry'
  CHECK (orientation IN ('entry', 'exit'));

-- Drop the default so every future INSERT must specify orientation explicitly.
ALTER TABLE alpr_cameras ALTER COLUMN orientation DROP DEFAULT;
```

- [ ] **Step 2: Apply to Supabase via MCP**

Call `mcp__claude_ai_SupaBase__apply_migration` with name `011_alpr_cameras_orientation` and the SQL above.

Expected: `{"success": true}`.

- [ ] **Step 3: Verify**

```sql
SELECT column_name, data_type, column_default, is_nullable
  FROM information_schema.columns
 WHERE table_name='alpr_cameras' AND column_name='orientation';
```

Expected: one row, `orientation`, `text`, default NULL, NOT NULL.

```sql
SELECT id, api_key, name, orientation FROM alpr_cameras;
```

Expected: existing row has `orientation='entry'`.

- [ ] **Step 4: Commit**

```bash
git add migrations/011_alpr_cameras_orientation.sql
git commit -m "migration(011): add alpr_cameras.orientation (entry|exit)"
```

---

## Task 2: Migration 012 — `plate_sessions` + FKs

**Files:**
- Create: `migrations/012_plate_sessions.sql`

- [ ] **Step 1: Write the migration**

Create `migrations/012_plate_sessions.sql`:

```sql
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
```

- [ ] **Step 2: Apply to Supabase**

Call `mcp__claude_ai_SupaBase__apply_migration` with name `012_plate_sessions` and the SQL above.

- [ ] **Step 3: Verify**

```sql
SELECT table_name FROM information_schema.tables
 WHERE table_name IN ('plate_sessions');
-- Expected: 1 row

SELECT column_name FROM information_schema.columns
 WHERE table_name='plate_events' AND column_name='session_id';
-- Expected: 1 row

SELECT column_name FROM information_schema.columns
 WHERE table_name='alpr_violations'
   AND column_name IN ('session_id','left_before_tow_at')
 ORDER BY column_name;
-- Expected: 2 rows
```

- [ ] **Step 4: Commit**

```bash
git add migrations/012_plate_sessions.sql
git commit -m "migration(012): plate_sessions table + session_id FKs + left_before_tow_at"
```

---

## Task 3: Migration 013 — `plate_holds` + billing view update

**Files:**
- Create: `migrations/013_plate_holds.sql`

- [ ] **Step 1: Write the migration**

Create `migrations/013_plate_holds.sql`:

```sql
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
CREATE OR REPLACE VIEW v_violation_billing_status AS
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
```

- [ ] **Step 2: Apply**

Call `mcp__claude_ai_SupaBase__apply_migration` with name `013_plate_holds`.

- [ ] **Step 3: Verify**

```sql
SELECT table_name FROM information_schema.tables WHERE table_name='plate_holds';
-- Expected: 1 row

SELECT billing_status FROM v_violation_billing_status LIMIT 1;
-- Expected: runs without error (result may be empty)

-- Smoke-check that the new case fires:
-- (skip; will be covered in synthetic E2E after edge function is updated)
```

- [ ] **Step 4: Commit**

```bash
git add migrations/013_plate_holds.sql
git commit -m "migration(013): plate_holds + v_violation_billing_status 'left_before_tow' queue"
```

---

## Task 4: Edge function helper — `holds.ts`

**Files:**
- Create: `supabase/functions/camera-snapshot/holds.ts`

- [ ] **Step 1: Write the helper**

Create `supabase/functions/camera-snapshot/holds.ts`:

```typescript
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Returns true if the plate currently has an unexpired hold at the property.
 * Used by:
 *  - camera-snapshot on entry: does not change behaviour (held plate still
 *    opens a grace session; cron will tow them at t+15m because the backend
 *    will block any registration attempt in the meantime), but we record the
 *    hold context on the session for operator visibility.
 *  - (future) backend visitor_pass POST: rejects new registrations.
 */
export async function isPlateHeld(
  db: SupabaseClient,
  propertyId: string,
  normalizedPlate: string,
  now: Date,
): Promise<boolean> {
  const { data, error } = await db
    .from("plate_holds")
    .select("id")
    .eq("property_id", propertyId)
    .eq("normalized_plate", normalizedPlate)
    .gt("hold_until", now.toISOString())
    .limit(1);
  if (error) throw error;
  return (data ?? []).length > 0;
}
```

- [ ] **Step 2: Add tests for it in `index.test.ts`**

Append to `supabase/functions/camera-snapshot/index.test.ts`:

```typescript
import { isPlateHeld } from "./holds.ts";

Deno.test("isPlateHeld: returns true when hold_until is in the future", async () => {
  const now = new Date("2026-04-20T12:00:00Z");
  const db = {
    from(table: string) {
      if (table !== "plate_holds") throw new Error(`unexpected table: ${table}`);
      const rows = [
        { id: "h1", property_id: "p1", normalized_plate: "ABC123", hold_until: "2026-04-21T00:00:00Z" },
      ];
      const builder: any = {
        _rows: rows,
        select() { return builder; },
        eq(c: string, v: any) { builder._rows = builder._rows.filter((r: any) => r[c] === v); return builder; },
        gt(c: string, v: any) { builder._rows = builder._rows.filter((r: any) => new Date(r[c]) > new Date(v)); return builder; },
        limit(n: number) {
          return Promise.resolve({ data: builder._rows.slice(0, n), error: null });
        },
      };
      return builder;
    },
  } as any;
  const r = await isPlateHeld(db, "p1", "ABC123", now);
  assertEquals(r, true);
});

Deno.test("isPlateHeld: returns false when hold_until has passed", async () => {
  const now = new Date("2026-04-22T00:00:00Z");
  const db = {
    from(_table: string) {
      const rows = [
        { id: "h1", property_id: "p1", normalized_plate: "ABC123", hold_until: "2026-04-21T00:00:00Z" },
      ];
      const builder: any = {
        _rows: rows,
        select() { return builder; },
        eq(c: string, v: any) { builder._rows = builder._rows.filter((r: any) => r[c] === v); return builder; },
        gt(c: string, v: any) { builder._rows = builder._rows.filter((r: any) => new Date(r[c]) > new Date(v)); return builder; },
        limit(n: number) { return Promise.resolve({ data: builder._rows.slice(0, n), error: null }); },
      };
      return builder;
    },
  } as any;
  const r = await isPlateHeld(db, "p1", "ABC123", now);
  assertEquals(r, false);
});

Deno.test("isPlateHeld: returns false when no rows match", async () => {
  const now = new Date("2026-04-20T12:00:00Z");
  const db = {
    from(_table: string) {
      const builder: any = {
        _rows: [],
        select() { return builder; },
        eq() { return builder; },
        gt() { return builder; },
        limit() { return Promise.resolve({ data: [], error: null }); },
      };
      return builder;
    },
  } as any;
  const r = await isPlateHeld(db, "p1", "ABC123", now);
  assertEquals(r, false);
});
```

- [ ] **Step 3: Run tests**

```bash
cd supabase/functions/camera-snapshot && deno test --allow-read --allow-net --allow-env
```

Expected: all new tests pass along with existing ones.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/camera-snapshot/holds.ts supabase/functions/camera-snapshot/index.test.ts
git commit -m "feat(camera-snapshot): isPlateHeld helper + tests"
```

---

## Task 5: Edge function helper — `sessions.ts` (entry path)

**Files:**
- Create: `supabase/functions/camera-snapshot/sessions.ts`

- [ ] **Step 1: Write the entry-path helpers**

Create `supabase/functions/camera-snapshot/sessions.ts`:

```typescript
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizePlate } from "../pr-ingest/normalize.ts";

export type OpenSessionRow = {
  id: string;
  property_id: string;
  normalized_plate: string;
  plate_text: string;
  state: "grace" | "registered" | "resident" | "expired";
  entered_at: string;
  visitor_pass_id: string | null;
  resident_plate_id: string | null;
  violation_id: string | null;
};

export async function findOpenSession(
  db: SupabaseClient,
  propertyId: string,
  normalizedPlate: string,
): Promise<OpenSessionRow | null> {
  const { data, error } = await db
    .from("plate_sessions")
    .select("id,property_id,normalized_plate,plate_text,state,entered_at,visitor_pass_id,resident_plate_id,violation_id")
    .eq("property_id", propertyId)
    .eq("normalized_plate", normalizedPlate)
    .is("exited_at", null)
    .limit(1);
  if (error) throw error;
  return (data ?? [])[0] ?? null;
}

export type ResidentRow = { id: string };
export async function findActiveResident(
  db: SupabaseClient,
  propertyId: string,
  normalizedPlate: string,
): Promise<ResidentRow | null> {
  // resident_plates.plate_text is stored raw; normalize both sides.
  const { data, error } = await db
    .from("resident_plates")
    .select("id,plate_text,active,property_id")
    .eq("property_id", propertyId)
    .eq("active", true)
    .limit(200);
  if (error) throw error;
  for (const r of data ?? []) {
    if (normalizePlate(r.plate_text ?? "") === normalizedPlate) return { id: r.id };
  }
  return null;
}

export type PassRow = { id: string; valid_until: string };
export async function findActiveVisitorPass(
  db: SupabaseClient,
  propertyId: string,
  normalizedPlate: string,
  now: Date,
): Promise<PassRow | null> {
  const { data, error } = await db
    .from("visitor_passes")
    .select("id,plate_text,valid_from,valid_until,cancelled_at,property_id")
    .eq("property_id", propertyId)
    .limit(500);
  if (error) throw error;
  for (const r of data ?? []) {
    if (r.cancelled_at) continue;
    if (r.valid_from && new Date(r.valid_from) > now) continue;
    if (!r.valid_until || new Date(r.valid_until) <= now) continue;
    if (normalizePlate(r.plate_text ?? "") === normalizedPlate) {
      return { id: r.id, valid_until: r.valid_until };
    }
  }
  return null;
}

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
  enteredAt: Date;
};

export async function insertSession(
  db: SupabaseClient,
  input: NewSessionInput,
): Promise<{ id: string }> {
  const row = {
    property_id: input.propertyId,
    normalized_plate: input.normalizedPlate,
    plate_text: input.plateText,
    vehicle_type: input.vehicleType,
    entry_camera_id: input.entryCameraId,
    entry_plate_event_id: input.entryPlateEventId,
    entered_at: input.enteredAt.toISOString(),
    state: input.state,
    visitor_pass_id: input.visitorPassId ?? null,
    resident_plate_id: input.residentPlateId ?? null,
  };
  const { data, error } = await db
    .from("plate_sessions")
    .insert(row)
    .select("id")
    .single();
  if (error) throw error;
  return { id: data.id };
}
```

- [ ] **Step 2: Unit tests for entry-path helpers**

Append to `index.test.ts`:

```typescript
import { findOpenSession, findActiveResident, findActiveVisitorPass, insertSession } from "./sessions.ts";

Deno.test("findOpenSession returns the row when exited_at IS NULL", async () => {
  const db = {
    from(table: string) {
      const rows = table === "plate_sessions" ? [
        { id: "s1", property_id: "p1", normalized_plate: "ABC123", plate_text: "ABC123", state: "grace", entered_at: "2026-04-20T12:00:00Z", exited_at: null, visitor_pass_id: null, resident_plate_id: null, violation_id: null },
      ] : [];
      const builder: any = {
        _rows: rows,
        select() { return builder; },
        eq(c: string, v: any) { builder._rows = builder._rows.filter((r: any) => r[c] === v); return builder; },
        is(c: string, _v: any) { builder._rows = builder._rows.filter((r: any) => r[c] === null); return builder; },
        limit(n: number) { return Promise.resolve({ data: builder._rows.slice(0, n), error: null }); },
      };
      return builder;
    },
  } as any;
  const s = await findOpenSession(db, "p1", "ABC123");
  assertEquals(s?.id, "s1");
});

Deno.test("findOpenSession returns null when no open session", async () => {
  const db = {
    from(_table: string) {
      const builder: any = {
        _rows: [],
        select() { return builder; },
        eq() { return builder; },
        is() { return builder; },
        limit() { return Promise.resolve({ data: [], error: null }); },
      };
      return builder;
    },
  } as any;
  const s = await findOpenSession(db, "p1", "ABC123");
  assertEquals(s, null);
});

Deno.test("findActiveResident matches with normalization", async () => {
  const db = {
    from(_t: string) {
      const builder: any = {
        _rows: [{ id: "r1", plate_text: "abc-123", active: true, property_id: "p1" }],
        select() { return builder; },
        eq(c: string, v: any) { builder._rows = builder._rows.filter((r: any) => r[c] === v); return builder; },
        limit() { return Promise.resolve({ data: builder._rows, error: null }); },
      };
      return builder;
    },
  } as any;
  const r = await findActiveResident(db, "p1", "ABC123");
  assertEquals(r?.id, "r1");
});

Deno.test("findActiveVisitorPass respects cancelled_at, valid_from, valid_until", async () => {
  const now = new Date("2026-04-20T12:00:00Z");
  const db = {
    from(_t: string) {
      const builder: any = {
        _rows: [
          { id: "v-cancelled", plate_text: "ABC123", valid_from: null, valid_until: "2026-04-21T00:00:00Z", cancelled_at: "2026-04-20T10:00:00Z", property_id: "p1" },
          { id: "v-future",    plate_text: "ABC123", valid_from: "2026-04-21T00:00:00Z", valid_until: "2026-04-22T00:00:00Z", cancelled_at: null, property_id: "p1" },
          { id: "v-expired",   plate_text: "ABC123", valid_from: null, valid_until: "2026-04-20T11:00:00Z", cancelled_at: null, property_id: "p1" },
          { id: "v-good",      plate_text: "abc123", valid_from: "2026-04-20T10:00:00Z", valid_until: "2026-04-21T00:00:00Z", cancelled_at: null, property_id: "p1" },
        ],
        select() { return builder; },
        eq() { return builder; },
        limit() { return Promise.resolve({ data: builder._rows, error: null }); },
      };
      return builder;
    },
  } as any;
  const r = await findActiveVisitorPass(db, "p1", "ABC123", now);
  assertEquals(r?.id, "v-good");
});
```

- [ ] **Step 3: Run tests**

```bash
cd supabase/functions/camera-snapshot && deno test --allow-read --allow-net --allow-env
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/camera-snapshot/sessions.ts supabase/functions/camera-snapshot/index.test.ts
git commit -m "feat(camera-snapshot): session entry-path helpers + tests"
```

---

## Task 6: Edge function helper — `sessions.ts` (exit path)

**Files:**
- Modify: `supabase/functions/camera-snapshot/sessions.ts`

- [ ] **Step 1: Add exit-path helpers**

Append to `supabase/functions/camera-snapshot/sessions.ts`:

```typescript
export type ExitOutcome =
  | { kind: "closed_clean" }
  | { kind: "closed_early"; visitorPassId: string; holdUntil: Date }
  | { kind: "closed_post_violation"; violationId: string; leftBeforeTow: boolean };

export type ExitCloseInput = {
  session: OpenSessionRow;
  exitCameraId: string;
  exitPlateEventId: string;
  exitedAt: Date;
  holdDurationHours: number; // 24 for now; kept configurable for tests
};

/**
 * Decide the new state + side effects based on the open session's current
 * state. Pure: returns what should happen. The caller performs the writes.
 */
export function decideExitOutcome(
  session: OpenSessionRow,
  passValidUntil: Date | null,
  exitedAt: Date,
  holdDurationHours: number,
): ExitOutcome {
  if (session.state === "registered" && passValidUntil && passValidUntil > exitedAt && session.visitor_pass_id) {
    const holdUntil = new Date(exitedAt.getTime() + holdDurationHours * 3600 * 1000);
    return { kind: "closed_early", visitorPassId: session.visitor_pass_id, holdUntil };
  }
  if (session.state === "expired" && session.violation_id) {
    return { kind: "closed_post_violation", violationId: session.violation_id, leftBeforeTow: true };
  }
  return { kind: "closed_clean" };
}

export async function applyExitOutcome(
  db: SupabaseClient,
  input: ExitCloseInput,
  outcome: ExitOutcome,
): Promise<void> {
  const nowIso = input.exitedAt.toISOString();

  let newState: "closed_clean" | "closed_early" | "closed_post_violation";
  switch (outcome.kind) {
    case "closed_early":
      newState = "closed_early";
      break;
    case "closed_post_violation":
      newState = "closed_post_violation";
      break;
    default:
      newState = "closed_clean";
  }

  const sessionUpdate = await db
    .from("plate_sessions")
    .update({
      state: newState,
      exited_at: nowIso,
      exit_camera_id: input.exitCameraId,
      exit_plate_event_id: input.exitPlateEventId,
      updated_at: nowIso,
    })
    .eq("id", input.session.id);
  if (sessionUpdate.error) throw sessionUpdate.error;

  if (outcome.kind === "closed_early") {
    const cancelPass = await db
      .from("visitor_passes")
      .update({ cancelled_at: nowIso, cancelled_by: "exited_early" })
      .eq("id", outcome.visitorPassId);
    if (cancelPass.error) throw cancelPass.error;

    const holdInsert = await db
      .from("plate_holds")
      .insert({
        property_id: input.session.property_id,
        normalized_plate: input.session.normalized_plate,
        source_session_id: input.session.id,
        held_at: nowIso,
        hold_until: outcome.holdUntil.toISOString(),
        reason: "early_exit",
      });
    if (holdInsert.error) throw holdInsert.error;
  }

  if (outcome.kind === "closed_post_violation" && outcome.leftBeforeTow) {
    // Only flag if tow_confirmed_at is still null. Check & set atomically.
    const update = await db
      .from("alpr_violations")
      .update({ left_before_tow_at: nowIso })
      .eq("id", outcome.violationId)
      .is("tow_confirmed_at", null);
    if (update.error) throw update.error;
  }
}
```

- [ ] **Step 2: Tests for exit-path helpers**

Append to `index.test.ts`:

```typescript
import { decideExitOutcome } from "./sessions.ts";

Deno.test("decideExitOutcome: registered + still-valid pass -> closed_early", () => {
  const session = {
    id: "s1", property_id: "p1", normalized_plate: "ABC123", plate_text: "ABC123",
    state: "registered" as const, entered_at: "2026-04-20T12:00:00Z",
    visitor_pass_id: "v1", resident_plate_id: null, violation_id: null,
  };
  const exited = new Date("2026-04-20T13:00:00Z");
  const validUntil = new Date("2026-04-21T12:00:00Z");
  const outcome = decideExitOutcome(session, validUntil, exited, 24);
  assertEquals(outcome.kind, "closed_early");
  if (outcome.kind === "closed_early") {
    assertEquals(outcome.visitorPassId, "v1");
    assertEquals(outcome.holdUntil.toISOString(), "2026-04-21T13:00:00.000Z");
  }
});

Deno.test("decideExitOutcome: expired -> closed_post_violation", () => {
  const session = {
    id: "s1", property_id: "p1", normalized_plate: "ABC123", plate_text: "ABC123",
    state: "expired" as const, entered_at: "2026-04-20T12:00:00Z",
    visitor_pass_id: null, resident_plate_id: null, violation_id: "viol1",
  };
  const outcome = decideExitOutcome(session, null, new Date("2026-04-20T12:20:00Z"), 24);
  assertEquals(outcome.kind, "closed_post_violation");
  if (outcome.kind === "closed_post_violation") {
    assertEquals(outcome.violationId, "viol1");
    assertEquals(outcome.leftBeforeTow, true);
  }
});

Deno.test("decideExitOutcome: grace -> closed_clean", () => {
  const session = {
    id: "s1", property_id: "p1", normalized_plate: "ABC123", plate_text: "ABC123",
    state: "grace" as const, entered_at: "2026-04-20T12:00:00Z",
    visitor_pass_id: null, resident_plate_id: null, violation_id: null,
  };
  const outcome = decideExitOutcome(session, null, new Date("2026-04-20T12:05:00Z"), 24);
  assertEquals(outcome.kind, "closed_clean");
});

Deno.test("decideExitOutcome: resident -> closed_clean", () => {
  const session = {
    id: "s1", property_id: "p1", normalized_plate: "ABC123", plate_text: "ABC123",
    state: "resident" as const, entered_at: "2026-04-20T12:00:00Z",
    visitor_pass_id: null, resident_plate_id: "r1", violation_id: null,
  };
  const outcome = decideExitOutcome(session, null, new Date("2026-04-20T18:00:00Z"), 24);
  assertEquals(outcome.kind, "closed_clean");
});

Deno.test("decideExitOutcome: registered but pass already expired -> closed_clean (no hold)", () => {
  const session = {
    id: "s1", property_id: "p1", normalized_plate: "ABC123", plate_text: "ABC123",
    state: "registered" as const, entered_at: "2026-04-20T12:00:00Z",
    visitor_pass_id: "v1", resident_plate_id: null, violation_id: null,
  };
  const exited = new Date("2026-04-21T01:00:00Z");
  const validUntil = new Date("2026-04-21T00:00:00Z"); // passed
  const outcome = decideExitOutcome(session, validUntil, exited, 24);
  assertEquals(outcome.kind, "closed_clean");
});
```

- [ ] **Step 3: Run tests**

```bash
cd supabase/functions/camera-snapshot && deno test --allow-read --allow-net --allow-env
```

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/camera-snapshot/sessions.ts supabase/functions/camera-snapshot/index.test.ts
git commit -m "feat(camera-snapshot): exit-path session helpers + decideExitOutcome tests"
```

---

## Task 7: Promote `vehicle_type` in extract.ts

**Files:**
- Modify: `supabase/functions/camera-snapshot/extract.ts`

- [ ] **Step 1: Add `vehicleType` to the Extracted output**

Open `supabase/functions/camera-snapshot/extract.ts`. The existing `Extracted` type has `bytes`, `cameraHint`, `source`, `rawMeta`. The vehicle type is a PER-RESULT field in PR's response, not per-image, so the extraction step doesn't know it yet. Leave `extract.ts` alone for vehicle_type — the index.ts call site already has `result.vehicle?.type` from PR's response. Instead, add a small utility here for clarity:

Prepend a docstring at the top of `extract.ts` (no code change):

```typescript
// Image extraction from whatever a camera posted (Milesight JSON, multipart,
// raw bytes). Returns the JPEG + a camera hint + source + any rawMeta we want
// to preserve. Note: per-detection fields like `vehicle.type` come back from
// Plate Recognizer, NOT from the camera, so they're extracted later in
// index.ts from the PR response per result.
```

This is purely documentation.

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/camera-snapshot/extract.ts
git commit -m "docs(camera-snapshot): clarify extract.ts scope vs. PR-derived fields"
```

---

## Task 8: Rewire `camera-snapshot/index.ts` — entry branch

**Files:**
- Modify: `supabase/functions/camera-snapshot/index.ts`

- [ ] **Step 1: Load camera.orientation in the lookup**

In `index.ts`, locate the camera lookup (around line 44). Change the `select` to include `orientation`:

```typescript
    const cameraQ = await db
      .from("alpr_cameras")
      .select("id,property_id,api_key,active,orientation")
      .eq("api_key", cameraApiKey)
      .eq("active", true)
      .limit(1);
```

- [ ] **Step 2: Replace the "for each result" loop with orientation-aware logic**

This is the main rewrite. Replace the entire `for (const result of surviving) { ... }` block with:

```typescript
    let eventCount = 0;
    let violationCount = 0;
    let dedupCount = 0;
    const now = new Date();

    for (const result of surviving) {
      const plateUpper = (result.plate as string).toUpperCase();
      const normalized = normalizePlate(result.plate as string);
      const vehicleType = result.vehicle?.type ?? null;

      // Upload the snapshot to R2 once per surviving result. Key is
      // property / day / camera / epoch / plate so evidence is easy to find.
      const epochMs = now.getTime();
      const dateStr = now.toISOString().slice(0, 10);
      const key = `${camera.property_id}/${dateStr}/${camera.api_key}-${epochMs}-${plateUpper}.jpg`;
      let imageUrl: string | null = null;
      let imageError: string | null = null;
      const upRes = await r2(key, extracted.bytes);
      if (upRes.ok) imageUrl = upRes.url;
      else imageError = upRes.error;

      const baseEventRow = (sessionId: string | null, matchStatus: string) => ({
        camera_id: camera.id,
        property_id: camera.property_id,
        plate_text: plateUpper,
        normalized_plate: normalized,
        confidence: result.score,
        image_url: imageUrl,
        event_type: camera.orientation === "exit" ? "exit" : "entry",
        raw_data: {
          ...result,
          _pr_response: prResp.data,
          _source: `camera-snapshot:${extracted.source}`,
          _orientation: camera.orientation,
          ...(extracted.rawMeta ?? {}),
          ...(imageError ? { image_upload_error: imageError } : {}),
        },
        match_status: matchStatus,
        match_reason: null,
        matched_at: null,
        session_id: sessionId,
      });

      if (camera.orientation === "entry") {
        // --- ENTRY ---
        const openSession = await findOpenSession(db, camera.property_id, normalized);
        if (openSession) {
          // Noise: second entry with no exit. Append an event for visibility;
          // do not open a new session; do not modify existing session.
          const ev = await db.from("plate_events")
            .insert(baseEventRow(openSession.id, "unmatched"))
            .select().single();
          if (ev.error) throw ev.error;
          dedupCount++;
          continue;
        }

        const resident = await findActiveResident(db, camera.property_id, normalized);
        const pass     = resident ? null : await findActiveVisitorPass(db, camera.property_id, normalized, now);
        const held     = resident || pass ? false : await isPlateHeld(db, camera.property_id, normalized, now);
        const state = resident ? "resident" : pass ? "registered" : "grace";
        const matchStatus = resident ? "resident" : pass ? "visitor_pass" : "unmatched";

        // Insert plate_events first so session can reference it.
        const ev = await db.from("plate_events")
          .insert(baseEventRow(null, matchStatus))
          .select("id").single();
        if (ev.error) throw ev.error;
        eventCount++;

        const sess = await insertSession(db, {
          propertyId: camera.property_id,
          normalizedPlate: normalized,
          plateText: plateUpper,
          vehicleType,
          entryCameraId: camera.id,
          entryPlateEventId: ev.data.id,
          state,
          visitorPassId: pass?.id ?? null,
          residentPlateId: resident?.id ?? null,
          enteredAt: now,
        });

        // Backfill the event with the session_id so evidence queries work.
        const backfill = await db.from("plate_events")
          .update({ session_id: sess.id })
          .eq("id", ev.data.id);
        if (backfill.error) throw backfill.error;

        // Note: held plates open state='grace'. The cron will issue a tow at
        // t+15m because the backend blocks registration during the hold.
        // We log the hold context in raw_data for operator visibility.
        if (held) {
          await db.from("plate_events")
            .update({ raw_data: { ...(baseEventRow(sess.id, matchStatus).raw_data as any), _on_hold: true } })
            .eq("id", ev.data.id);
        }

        continue;
      }

      if (camera.orientation === "exit") {
        // --- EXIT ---
        const openSession = await findOpenSession(db, camera.property_id, normalized);
        if (!openSession) {
          // Stray exit. Log an event with no session; alert via raw_data.
          const ev = await db.from("plate_events")
            .insert(baseEventRow(null, "unmatched"))
            .select().single();
          if (ev.error) throw ev.error;
          console.warn(`stray exit: no open session for plate=${normalized} property=${camera.property_id}`);
          continue;
        }

        // Record the exit event first, then close the session.
        const ev = await db.from("plate_events")
          .insert(baseEventRow(openSession.id, "unmatched"))
          .select("id").single();
        if (ev.error) throw ev.error;
        eventCount++;

        // Need pass.valid_until if the session is registered to decide early-exit.
        let passValidUntil: Date | null = null;
        if (openSession.state === "registered" && openSession.visitor_pass_id) {
          const p = await db.from("visitor_passes")
            .select("valid_until")
            .eq("id", openSession.visitor_pass_id)
            .single();
          if (p.error) throw p.error;
          passValidUntil = p.data.valid_until ? new Date(p.data.valid_until) : null;
        }

        const outcome = decideExitOutcome(openSession, passValidUntil, now, 24);
        await applyExitOutcome(db, {
          session: openSession,
          exitCameraId: camera.id,
          exitPlateEventId: ev.data.id,
          exitedAt: now,
          holdDurationHours: 24,
        }, outcome);

        continue;
      }

      // Defensive: shouldn't happen because CHECK constraint allows only two values.
      console.warn(`unexpected camera.orientation=${camera.orientation}; skipping`);
    }
```

- [ ] **Step 3: Add imports at top of file**

Near the existing imports in `index.ts`:

```typescript
import { findOpenSession, findActiveResident, findActiveVisitorPass, insertSession, decideExitOutcome, applyExitOutcome } from "./sessions.ts";
import { isPlateHeld } from "./holds.ts";
```

- [ ] **Step 4: Remove the now-dead `dispatchTowEmail` call**

Search for `dispatchTowEmail(vIns.data.id)` in `index.ts`; remove it and the `dispatchTowEmail` function definition (tow-dispatch-email is now fired from the cron, not inline). Also remove the fallback dedup-check block since dedup is now implicit in "open session = noise."

- [ ] **Step 5: Update the response body**

The response summary should now report `events` + `sessions_opened` + `sessions_closed` + `dedup`. Replace the existing `return json(200, {...})` at end of try block with:

```typescript
    return json(200, {
      ok: true,
      events: eventCount,
      violations: violationCount,  // always 0 in the new model; violations fire from cron
      dedup_suppressed: dedupCount,
      source: extracted.source,
      orientation: camera.orientation,
    });
```

- [ ] **Step 6: Run the existing tests**

```bash
cd supabase/functions/camera-snapshot && deno test --allow-read --allow-net --allow-env
```

Some existing tests may fail because the code path changed. Fix broken tests: the old "happy path unknown plate creates plate_events + alpr_violations" test no longer creates a violation inline — violations come from the cron now. Update the assertion accordingly, or mark that test obsolete by renaming it to "opens a grace session on new-plate entry, does not create a violation inline."

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/camera-snapshot/index.ts supabase/functions/camera-snapshot/index.test.ts
git commit -m "feat(camera-snapshot): orientation-aware entry/exit branches using session helpers"
```

---

## Task 9: Deploy camera-snapshot

**Files:** none

- [ ] **Step 1: Deploy**

```bash
cd /Users/gabe/lotlogic
supabase functions deploy camera-snapshot --project-ref nzdkoouoaedbbccraoti --no-verify-jwt
```

Expected: "Deployed Functions on project nzdkoouoaedbbccraoti: camera-snapshot".

- [ ] **Step 2: Smoke test (synthetic entry)**

```bash
set -a && source .env.local && set +a
curl -s -X POST -H "Content-Type: application/json" \
  --data-binary @/tmp/milesight-latest.json \
  "$SUPABASE_URL/functions/v1/camera-snapshot/$CAMERA_SNAPSHOT_URL_SECRET" | jq
```

Expected (assuming the existing camera is still oriented `entry` and the plate isn't a resident or held):
```json
{ "ok": true, "events": 1, "violations": 0, "dedup_suppressed": 0, "source": "milesight_json", "orientation": "entry" }
```

Verify DB:

```sql
SELECT id, state, entered_at, normalized_plate, vehicle_type
  FROM plate_sessions
  ORDER BY created_at DESC LIMIT 1;
-- Expected: one row, state='grace', vehicle_type populated if PR returned it.
```

---

## Task 10: Migration 014 — PL/pgSQL cron functions

**Files:**
- Create: `migrations/014_session_cron_jobs.sql`

- [ ] **Step 1: Write the migration**

Create `migrations/014_session_cron_jobs.sql`:

```sql
-- Three PL/pgSQL functions implement the state-machine transitions. Run
-- them every minute via pg_cron. Each function:
--   1. Selects open sessions matching its transition criteria (FOR UPDATE SKIP LOCKED).
--   2. Updates state + side-effects (insert violation + set violation_id).
--   3. Fires tow-dispatch-email via pg_net for each new violation.
-- Returning count so we can see activity in pg_cron logs.

CREATE OR REPLACE FUNCTION fn_plate_sessions_registration_transition()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  n integer;
BEGIN
  WITH promoted AS (
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
       AND vp.valid_until > now()
     RETURNING s.id
  )
  SELECT count(*) INTO n FROM promoted;
  RETURN COALESCE(n, 0);
END; $$;

CREATE OR REPLACE FUNCTION fn_plate_sessions_grace_expiry()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  n integer := 0;
  rec RECORD;
  v_id uuid;
  edge_url text;
BEGIN
  edge_url := current_setting('app.supabase_url', true) || '/functions/v1/tow-dispatch-email';

  FOR rec IN
    SELECT s.id AS session_id, s.property_id, s.plate_text, s.entry_plate_event_id
      FROM plate_sessions s
     WHERE s.state = 'grace'
       AND s.exited_at IS NULL
       AND s.entered_at + interval '15 minutes' < now()
     FOR UPDATE OF s SKIP LOCKED
  LOOP
    INSERT INTO alpr_violations
      (property_id, plate_event_id, plate_text, status, violation_type, session_id)
    VALUES
      (rec.property_id, rec.entry_plate_event_id, rec.plate_text,
       'pending', 'alpr_unmatched', rec.session_id)
    RETURNING id INTO v_id;

    UPDATE plate_sessions
       SET state = 'expired', violation_id = v_id, updated_at = now()
     WHERE id = rec.session_id;

    PERFORM net.http_post(
      url := edge_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || current_setting('app.supabase_service_role_key', true)
      ),
      body := jsonb_build_object('violation_id', v_id)
    );

    n := n + 1;
  END LOOP;
  RETURN n;
END; $$;

CREATE OR REPLACE FUNCTION fn_plate_sessions_pass_expiry()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  n integer := 0;
  rec RECORD;
  v_id uuid;
  edge_url text;
BEGIN
  edge_url := current_setting('app.supabase_url', true) || '/functions/v1/tow-dispatch-email';

  FOR rec IN
    SELECT s.id AS session_id, s.property_id, s.plate_text, s.entry_plate_event_id
      FROM plate_sessions s
      JOIN visitor_passes vp ON vp.id = s.visitor_pass_id
     WHERE s.state = 'registered'
       AND s.exited_at IS NULL
       AND vp.valid_until < now()
     FOR UPDATE OF s SKIP LOCKED
  LOOP
    INSERT INTO alpr_violations
      (property_id, plate_event_id, plate_text, status, violation_type, session_id)
    VALUES
      (rec.property_id, rec.entry_plate_event_id, rec.plate_text,
       'pending', 'alpr_unmatched', rec.session_id)
    RETURNING id INTO v_id;

    UPDATE plate_sessions
       SET state = 'expired', violation_id = v_id, updated_at = now()
     WHERE id = rec.session_id;

    PERFORM net.http_post(
      url := edge_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || current_setting('app.supabase_service_role_key', true)
      ),
      body := jsonb_build_object('violation_id', v_id)
    );

    n := n + 1;
  END LOOP;
  RETURN n;
END; $$;

-- Set config values used by the functions (supabase_url + service_role_key).
-- These are project-level settings; set via Supabase dashboard
-- (Database -> Settings -> Custom PostgreSQL Config) and are persisted.
-- For safety the functions use the `true` missing_ok flag on current_setting.
```

- [ ] **Step 2: Apply migration**

Call `mcp__claude_ai_SupaBase__apply_migration` with name `014_session_cron_functions`.

- [ ] **Step 3: Set the two custom config values**

Via Supabase dashboard → Project Settings → Custom Postgres Config, add:

- `app.supabase_url` = `https://nzdkoouoaedbbccraoti.supabase.co`
- `app.supabase_service_role_key` = the service role JWT (already in `.env.local`)

Alternative for urgency: run `ALTER DATABASE postgres SET app.supabase_url = '...'` but this requires superuser and may not work on Supabase's managed pg.

- [ ] **Step 4: Test the functions by hand**

Insert a stub session that should grace-expire:

```sql
-- Replace :cam with the existing camera id; :prop with Charlotte Travel Plaza id.
WITH ev AS (
  INSERT INTO plate_events (camera_id, property_id, plate_text, normalized_plate, event_type, match_status, created_at)
  VALUES (:cam, :prop, 'TEST111', 'TEST111', 'entry', 'unmatched', now() - interval '20 minutes')
  RETURNING id
)
INSERT INTO plate_sessions
  (property_id, normalized_plate, plate_text, entry_camera_id, entry_plate_event_id,
   entered_at, state)
SELECT :prop, 'TEST111', 'TEST111', :cam, ev.id, now() - interval '20 minutes', 'grace'
  FROM ev;

SELECT fn_plate_sessions_grace_expiry();
-- Expected: 1
SELECT state, violation_id FROM plate_sessions WHERE normalized_plate='TEST111';
-- Expected: state='expired', violation_id SET.
SELECT id, status, violation_type, session_id FROM alpr_violations
 WHERE plate_text='TEST111';
-- Expected: 1 row, status='pending'.
```

Clean up the test rows:

```sql
DELETE FROM alpr_violations WHERE plate_text='TEST111';
DELETE FROM plate_sessions WHERE normalized_plate='TEST111';
DELETE FROM plate_events   WHERE normalized_plate='TEST111';
```

- [ ] **Step 5: Commit**

```bash
git add migrations/014_session_cron_jobs.sql
git commit -m "migration(014): session state-machine cron functions (grace/pass/registration)"
```

---

## Task 11: Schedule the pg_cron jobs

**Files:**
- Create: `migrations/015_session_cron_schedule.sql`

- [ ] **Step 1: Write schedule migration**

Create `migrations/015_session_cron_schedule.sql`:

```sql
-- Order matters on the same minute: registration-transition runs first so
-- grace-expiry doesn't see sessions that just got a pass. pg_cron orders by
-- schedule definition time for equal cron specs.

SELECT cron.schedule(
  'plate_sessions_registration_transition',
  '* * * * *',
  $$ SELECT fn_plate_sessions_registration_transition() $$
);

SELECT cron.schedule(
  'plate_sessions_grace_expiry',
  '* * * * *',
  $$ SELECT fn_plate_sessions_grace_expiry() $$
);

SELECT cron.schedule(
  'plate_sessions_pass_expiry',
  '* * * * *',
  $$ SELECT fn_plate_sessions_pass_expiry() $$
);
```

- [ ] **Step 2: Apply**

Call `mcp__claude_ai_SupaBase__apply_migration` with name `015_session_cron_schedule`.

- [ ] **Step 3: Verify schedule**

```sql
SELECT jobid, schedule, command FROM cron.job
 WHERE jobname LIKE 'plate_sessions_%' ORDER BY jobname;
-- Expected: 3 rows.
```

- [ ] **Step 4: Commit**

```bash
git add migrations/015_session_cron_schedule.sql
git commit -m "migration(015): schedule three plate_sessions cron jobs (every minute)"
```

---

## Task 12: Dashboard — "In Lot Now" panel

**Files:**
- Modify: `frontend/dashboard.html`

- [ ] **Step 1: Add DB helper**

In `frontend/dashboard.html`, find the existing `getRecentPlateEvents` (~line 2766). Add right after it:

```javascript
  async getOpenSessions(propertyId) {
    if (supabase) {
      const { data, error } = await supabase
        .from('plate_sessions')
        .select('id, normalized_plate, plate_text, vehicle_type, entered_at, state, visitor_pass_id, resident_plate_id, entry_camera_id, exit_camera_id, violation_id')
        .eq('property_id', propertyId)
        .is('exited_at', null)
        .order('entered_at', { ascending: false });
      if (!error && data) return data;
    }
    return [];
  },
  async getActiveHolds(propertyId) {
    if (supabase) {
      const { data, error } = await supabase
        .from('plate_holds')
        .select('id, normalized_plate, held_at, hold_until, reason, source_session_id')
        .eq('property_id', propertyId)
        .gt('hold_until', new Date().toISOString())
        .order('held_at', { ascending: false });
      if (!error && data) return data;
    }
    return [];
  },
  async releasePlateHold(holdId) {
    if (supabase) {
      const { error } = await supabase
        .from('plate_holds')
        .update({ hold_until: new Date().toISOString() })
        .eq('id', holdId);
      if (error) throw new Error(error.message);
      return { success: true };
    }
    return { success: true };
  },
```

- [ ] **Step 2: Add panel state + refresh**

In the `PropertyDetail` component state block (~line 7620), add:

```javascript
  const [openSessions, setOpenSessions] = useState([]);
  const [activeHolds, setActiveHolds] = useState([]);
```

In the `loadAll` Promise.all, add `db.getOpenSessions(propertyId)` and `db.getActiveHolds(propertyId)` and destructure them. Then `setOpenSessions(...)` and `setActiveHolds(...)`.

Add refresh hooks, patterned after the existing `refreshEvents` + realtime pattern:

```javascript
  const refreshSessions = useCallback(async () => {
    if (!propertyId) return;
    const [s, h] = await Promise.all([
      db.getOpenSessions(propertyId),
      db.getActiveHolds(propertyId),
    ]);
    setOpenSessions(s);
    setActiveHolds(h);
  }, [propertyId]);
  useIntervalFetch(refreshSessions, 20000, [refreshSessions]);
  useEffect(() => {
    if (!supabase || !propertyId) return;
    const debouncedRefresh = makeDebounced(refreshSessions, 200);
    const ch1 = supabase.channel('plate-sessions-' + propertyId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'plate_sessions', filter: 'property_id=eq.' + propertyId }, debouncedRefresh)
      .subscribe();
    const ch2 = supabase.channel('plate-holds-' + propertyId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'plate_holds', filter: 'property_id=eq.' + propertyId }, debouncedRefresh)
      .subscribe();
    return () => { supabase.removeChannel(ch1); supabase.removeChannel(ch2); };
  }, [propertyId, refreshSessions]);
```

- [ ] **Step 3: Render the "In Lot Now" panel**

Above the existing Plate Detections section (~line 8175), add:

```jsx
      {/* In Lot Now */}
      <div className="pd-section-head">
        <div style={{display:'flex',alignItems:'baseline',gap:8}}>
          <span className="pd-section-title">In Lot Now</span>
          <span className="pd-section-count">{openSessions.length}</span>
        </div>
      </div>
      <div style={{display:'flex',flexDirection:'column',gap:6}}>
        {openSessions.length === 0 ? (
          <div className="pd-empty">Lot is empty</div>
        ) : openSessions.map(s => {
          const enteredMs = new Date(s.entered_at).getTime();
          const mins = Math.floor((nowTick - enteredMs) / 60000);
          const stateColor = s.state === 'registered' ? '#4ade80'
            : s.state === 'resident' ? '#60a5fa'
            : s.state === 'grace'    ? '#fbbf24'
            : s.state === 'expired'  ? '#f87171'
            : 'var(--text-faint)';
          return (
            <div key={s.id} style={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8,padding:'10px 12px',display:'flex',alignItems:'center',gap:12}}>
              <div style={{minWidth:0,flex:1}}>
                <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
                  <span style={{fontFamily:"'Courier New',monospace",background:'#fef3c7',color:'#1c1009',border:'1.5px solid #fbbf24',fontWeight:800,letterSpacing:'.08em',fontSize:13,padding:'3px 9px',borderRadius:4}}>{s.plate_text}</span>
                  <span style={{fontSize:10,fontWeight:700,textTransform:'uppercase',letterSpacing:'.06em',padding:'3px 8px',borderRadius:20,background:`${stateColor}20`,color:stateColor,border:`1px solid ${stateColor}40`}}>{s.state.replace('_',' ')}</span>
                  {s.vehicle_type && <span style={{fontSize:11,color:'var(--text-muted)'}}>{s.vehicle_type}</span>}
                </div>
                <div style={{fontSize:11,color:'var(--text-muted)',marginTop:3}}>
                  Here {mins}m · entered {new Date(s.entered_at).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})}
                </div>
              </div>
            </div>
          );
        })}
      </div>
```

- [ ] **Step 4: Commit**

```bash
git add frontend/dashboard.html
git commit -m "feat(dashboard): In Lot Now panel driven by open plate_sessions"
```

---

## Task 13: Dashboard — "Holds" panel with release

**Files:**
- Modify: `frontend/dashboard.html`

- [ ] **Step 1: Render the panel below In Lot Now**

Below the In Lot Now render block, add:

```jsx
      {/* Plate Holds */}
      <div className="pd-section-head">
        <div style={{display:'flex',alignItems:'baseline',gap:8}}>
          <span className="pd-section-title">24-Hour Holds</span>
          <span className="pd-section-count">{activeHolds.length}</span>
        </div>
      </div>
      <div style={{display:'flex',flexDirection:'column',gap:6}}>
        {activeHolds.length === 0 ? (
          <div className="pd-empty">No active holds</div>
        ) : activeHolds.map(h => {
          const heldMs = new Date(h.held_at).getTime();
          const untilMs = new Date(h.hold_until).getTime();
          const remaining = Math.max(0, Math.floor((untilMs - nowTick) / 60000));
          return (
            <div key={h.id} style={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8,padding:'10px 12px',display:'flex',alignItems:'center',gap:12}}>
              <div style={{minWidth:0,flex:1}}>
                <span style={{fontFamily:"'Courier New',monospace",background:'#fee2e2',color:'#7f1d1d',border:'1.5px solid #f87171',fontWeight:800,letterSpacing:'.08em',fontSize:13,padding:'3px 9px',borderRadius:4}}>{h.normalized_plate}</span>
                <span style={{fontSize:11,color:'var(--text-muted)',marginLeft:8}}>
                  held {new Date(h.held_at).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})} · {remaining}m left · reason: {h.reason}
                </span>
              </div>
              <button
                onClick={async () => {
                  if (!confirm(`Release the 24h hold on ${h.normalized_plate}?`)) return;
                  try {
                    await db.releasePlateHold(h.id);
                    addToast({ kind:'success', text:`Hold released for ${h.normalized_plate}` });
                    refreshSessions();
                  } catch (err) {
                    addToast({ kind:'error', text:`Release failed: ${err.message}` });
                  }
                }}
                style={{background:'#1f2937',color:'#f9fafb',border:'1px solid #374151',borderRadius:6,padding:'5px 10px',fontSize:11,cursor:'pointer'}}
              >Release</button>
            </div>
          );
        })}
      </div>
```

- [ ] **Step 2: Commit**

```bash
git add frontend/dashboard.html
git commit -m "feat(dashboard): active plate_holds panel with operator Release action"
```

---

## Task 14: Dashboard — Left Before Tow queue

**Files:**
- Modify: `frontend/dashboard.html`

- [ ] **Step 1: Extend the Confirmation Review queue definitions**

Find where the 7 queues are defined in the Billing → Confirmation Review code path. The queue filter is computed from `billing_status` returned by the view we already updated. Locate the array of queue descriptors (search for `'reported_unconfirmed'` or `'Confirmed'` in `dashboard.html`). Prepend a new entry:

```javascript
  { key: 'left_before_tow', label: 'Left before tow', description: 'Driver exited after dispatch but before the tow truck arrived' },
```

The queue rendering code already filters by `row.billing_status === queue.key`, so the new queue will populate automatically. The existing per-row Bill Anyway / Mark No-Tow / Pause buttons apply to this queue without changes.

- [ ] **Step 2: Smoke check**

Build the UI locally or on Vercel preview and open Billing → Confirmation Review. The "Left before tow" tab should render (empty is fine).

- [ ] **Step 3: Commit**

```bash
git add frontend/dashboard.html
git commit -m "feat(dashboard): add Left before tow queue to Confirmation Review"
```

---

## Task 15: Dashboard — state badge on Plate Detections

**Files:**
- Modify: `frontend/dashboard.html`

- [ ] **Step 1: Fetch session state alongside events**

The existing `getRecentPlateEvents` already returns plate_events with a `session_id` FK (after migration 012). To show the session's current state, join:

```javascript
  async getRecentPlateEvents(propertyId, limit = 50) {
    if (supabase) {
      const { data, error } = await supabase
        .from('plate_events')
        .select('id, plate_text, normalized_plate, confidence, image_url, event_type, camera_id, created_at, visitor_pass_id, resident_plate_id, match_status, match_reason, matched_at, session_id, plate_sessions(state)')
        .eq('property_id', propertyId)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (!error && data) return data;
    }
    return [];
  },
```

- [ ] **Step 2: Render the session state badge**

In the Plate Detections render block (around line 8199), after the existing match_status badge, add:

```jsx
                  {ev.plate_sessions?.state && (
                    <span style={{fontSize:10,fontWeight:700,textTransform:'uppercase',letterSpacing:'.06em',padding:'3px 8px',borderRadius:20,background:'#1f293720',color:'#9ca3af',border:'1px solid #37415140'}}>session: {ev.plate_sessions.state.replace('_',' ')}</span>
                  )}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/dashboard.html
git commit -m "feat(dashboard): show session state badge on Plate Detections rows"
```

---

## Task 16: Register the 3 new cameras

**Files:** none (SQL via MCP)

- [ ] **Step 1: Collect device MACs**

Each of the 3 remaining cameras has a unique devMac; get it from the Milesight local AP for each. Write them down. Example values used below are placeholders — replace with the actual MACs.

- [ ] **Step 2: Insert the rows**

```sql
INSERT INTO alpr_cameras (id, property_id, name, api_key, active, orientation) VALUES
  (gen_random_uuid(), 'bd44ace8-feda-42e1-9866-5d60f65e1712',
   'Entrance A - Exit',  'PLACEHOLDER_MAC_1', true, 'exit'),
  (gen_random_uuid(), 'bd44ace8-feda-42e1-9866-5d60f65e1712',
   'Entrance B - Entry', 'PLACEHOLDER_MAC_2', true, 'entry'),
  (gen_random_uuid(), 'bd44ace8-feda-42e1-9866-5d60f65e1712',
   'Entrance B - Exit',  'PLACEHOLDER_MAC_3', true, 'exit');
```

Also rename the existing camera for clarity:

```sql
UPDATE alpr_cameras
   SET name = 'Entrance A - Entry'
 WHERE api_key = '1CC31660025E';
```

- [ ] **Step 3: Point each camera at `camera-snapshot`**

In each Milesight's local AP, set the HTTP POST target URL to:

```
https://nzdkoouoaedbbccraoti.supabase.co/functions/v1/camera-snapshot/<CAMERA_SNAPSHOT_URL_SECRET>
```

Value of the secret is in `.env.local` as `CAMERA_SNAPSHOT_URL_SECRET`.

- [ ] **Step 4: Verify each camera posts successfully**

Wave a test plate past each camera in turn. In Supabase:

```sql
SELECT c.name, c.orientation, c.api_key, COUNT(e.id) AS events_in_last_10m
  FROM alpr_cameras c
  LEFT JOIN plate_events e ON e.camera_id = c.id AND e.created_at > now() - interval '10 minutes'
 WHERE c.property_id = 'bd44ace8-feda-42e1-9866-5d60f65e1712'
 GROUP BY c.id
 ORDER BY c.name;
```

Expected: each camera has ≥1 event.

- [ ] **Step 5: Commit the SQL (documentation)**

Not code, but create a record file so the install is reproducible:

```bash
cat > migrations/ops/2026-04-20-register-charlotte-cameras.sql <<'EOF'
-- RUN-ONCE: seeded cameras for Charlotte Travel Plaza (2026-04-20).
-- Replace the api_key PLACEHOLDER_MAC_* values with the actual device MACs
-- before running. Then apply manually via supabase MCP apply_migration or
-- psql.
...
EOF
git add migrations/ops/2026-04-20-register-charlotte-cameras.sql
git commit -m "ops: seed SQL for Charlotte Travel Plaza 4-camera install"
```

---

## Task 17: Clean up pre-launch test rows

**Files:** none (SQL via MCP)

- [ ] **Step 1: Inventory**

```sql
SELECT COUNT(*) FROM plate_events     WHERE property_id='bd44ace8-feda-42e1-9866-5d60f65e1712';
SELECT COUNT(*) FROM alpr_violations  WHERE property_id='bd44ace8-feda-42e1-9866-5d60f65e1712';
SELECT COUNT(*) FROM plate_sessions   WHERE property_id='bd44ace8-feda-42e1-9866-5d60f65e1712';
```

- [ ] **Step 2: Decide with Gabe before deletion**

**This step requires explicit Gabe sign-off.** Each of the above counts is test data from Apr 19 shakedown. Recommended plan: keep `alpr_violations` (they have `action_taken='no_tow'` which is an audit record), DELETE `plate_events` older than 2026-04-20 00:00 UTC, and DELETE any test `plate_sessions` / `plate_holds`. Do not auto-run.

Actual SQL if approved:

```sql
-- ONLY RUN WITH GABE'S APPROVAL.
DELETE FROM plate_events
 WHERE property_id='bd44ace8-feda-42e1-9866-5d60f65e1712'
   AND created_at < '2026-04-20T00:00:00Z';
DELETE FROM plate_sessions
 WHERE property_id='bd44ace8-feda-42e1-9866-5d60f65e1712'
   AND created_at < '2026-04-20T00:00:00Z';
```

---

## Task 18: Smoke test the full state machine

**Files:** none

- [ ] **Step 1: Grace → Tow scenario**

Drive a vehicle past Entrance A - Entry. Don't register. Wait 16 minutes. Expected:

```sql
SELECT state, violation_id FROM plate_sessions
 ORDER BY created_at DESC LIMIT 1;
-- Expected: state='expired', violation_id SET.

SELECT id, status, left_before_tow_at FROM alpr_violations
 ORDER BY created_at DESC LIMIT 1;
-- Expected: status='dispatched' (email fired from cron).
```

Check `standardvendingcompany@gmail.com` for the email.

- [ ] **Step 2: Grace → Register → Clean exit**

Drive past Entrance A - Entry. Within 15 min, scan the property's visitor QR and complete the visit form (pick 12h duration). Drive out of Entrance A - Exit within the 12h. Expected:

```sql
SELECT state, visitor_pass_id FROM plate_sessions
 ORDER BY created_at DESC LIMIT 1;
-- Expected: state='closed_clean', visitor_pass_id SET.
```

No violation inserted.

- [ ] **Step 3: Early exit → Hold**

Enter, register 24h, exit after 10 min. Expected:

```sql
SELECT state FROM plate_sessions ORDER BY created_at DESC LIMIT 1;
-- Expected: state='closed_early'.
SELECT * FROM plate_holds WHERE normalized_plate = '<your plate>';
-- Expected: 1 row, hold_until = exit + 24h.
```

- [ ] **Step 4: Held plate → tow**

Immediately re-enter (within 24h). Try to register via QR → backend should return 409 (Task 19 dependency). Wait 16 min. Expected: cron fires a tow dispatch.

- [ ] **Step 5: Left before tow**

With an `expired` session still open (car is in lot, tow dispatched, not yet confirmed), drive out via Entrance A - Exit before the tow truck's plate is scanned. Expected:

```sql
SELECT state, left_before_tow_at
  FROM plate_sessions s JOIN alpr_violations v ON v.session_id = s.id
 ORDER BY s.created_at DESC LIMIT 1;
-- Expected: s.state='closed_post_violation', v.left_before_tow_at SET.
```

Open the dashboard → Billing → Confirmation Review. The "Left before tow" queue should show this violation.

---

## Task 19: Backend hand-off — visitor_pass hold guard

**Files (in a SEPARATE repo, `getlotlogic/lotlogic-backend`):**
- Modify: `routers/visitor_passes.py` (the POST endpoint)

- [ ] **Step 1: Open a PR in `lotlogic-backend`**

This is not implementation in this repo. Coordinate a PR that adds, at the top of the visitor_pass POST handler (before any INSERT):

```python
from fastapi import HTTPException

normalized = re.sub(r"[^A-Z0-9]", "", plate_text.upper())
held_rows = await db.fetch(
    """
    SELECT 1 FROM plate_holds
     WHERE property_id = $1 AND normalized_plate = $2 AND hold_until > now()
     LIMIT 1
    """,
    property_id, normalized,
)
if held_rows:
    raise HTTPException(
        status_code=409,
        detail={"code": "plate_on_hold",
                "message": "This plate is on a 24-hour hold. Try again later."}
    )
```

The frontend (`visit.html`) must handle the 409: show a friendly modal explaining "this plate recently left early; please try again after <hold_until>".

- [ ] **Step 2: Track in this repo**

Create `docs/superpowers/plans/tracked-handoffs.md` (or append if exists):

```markdown
# Tracked Cross-Repo Hand-offs

- [ ] `lotlogic-backend` visitor_pass POST hold guard — blocker for held plates to complete the state machine. See
  `docs/superpowers/plans/2026-04-20-camera-session-state-machine.md` Task 19.
```

Commit:

```bash
git add docs/superpowers/plans/tracked-handoffs.md
git commit -m "docs: track cross-repo hand-off (visitor_pass hold guard) for backend PR"
```

---

## Self-Review

### Spec coverage check

Each spec section → task that implements it:

- Architecture diagram — Tasks 1–15 (migrations + edge + cron + dashboard).
- Data model 011 (orientation) — Task 1.
- Data model 012 (plate_sessions + FKs) — Task 2.
- Data model 013 (plate_holds + view update) — Task 3.
- Business logic: camera-snapshot entry/exit branches — Tasks 4–9.
- Business logic: cron grace-expiry, pass-expiry, registration-transition — Tasks 10–11.
- Backend registration guard — Task 19 (cross-repo).
- Dashboard In Lot Now, Holds, Plate Detections badge, Left-before-tow queue — Tasks 12–15.
- Rollout — Tasks 16, 18.
- Testing — Unit tests in Tasks 4–6; smoke in Task 18.
- Monitoring — log lines emitted by cron functions and edge function (no separate task; falls out naturally).
- Rollback — each migration reversible (`DROP COLUMN/TABLE/VIEW`), edge function redeployable to prior version. No separate task; documented here.

### Placeholder scan

- Task 16's `PLACEHOLDER_MAC_*` values are placeholders by design; Step 1 tells the installer to replace before running, and the ops file is committed with a comment explaining.
- Task 17 explicitly requires human sign-off before running — no automation.
- All code blocks contain complete, runnable code.

### Type / name consistency

- `OpenSessionRow` defined in Task 5, used in Task 6 and Task 8. Matches.
- `decideExitOutcome` / `applyExitOutcome` defined in Task 6, imported in Task 8. Matches.
- `isPlateHeld` defined in Task 4, imported in Task 8. Matches.
- `plate_sessions.state` values used in DB, SQL, and TypeScript match the CHECK constraint in migration 012.
- `fn_plate_sessions_grace_expiry` referenced in migration 015 matches definition in migration 014.

No gaps.
