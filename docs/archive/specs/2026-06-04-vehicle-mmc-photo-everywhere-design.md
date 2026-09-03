# Vehicle MMC + Photo, End-to-End — Design

**Date:** 2026-06-04
**Status:** Proposed (awaiting review)
**Scope:** One-shot, comprehensive. Make every car's **photo + make / model / color / type** captured by our cameras flow all the way to where operators and partners see it — on **violations**, on **dispatch cards**, and on **parking passes** — including cars we photographed **before** the driver registered.

---

## 1. Problem

We already detect make/model/color/type (MMC) and capture a snapshot on **every** camera read. The data lands in `plate_events`. But it dies there:

- **Violations** — `alpr_violations` / `no_registration_violations` have MMC columns, but only the *cooldown* insert fills them. Overstay (truck-plaza), cron-sweep expiry, and every future path leave them null. The dashboard reads MMC off the violation row → blank chips.
- **The dashboard discards what it does get** — the partner view selects `alpr_violations.*` (which *includes* MMC) but the row-mapper hardcodes `vehicle_make/model/color/type: null` (`dashboard.html:4952`). The partner "awaiting dispatch" cards show plate + lot only — no car photo, no MMC.
- **Passes carry no vehicle identity** — `visitor_passes` has `vehicle_type` + `id_photo_url` (the driver's ID upload) only. No make/model/color, no camera photo of the actual car.

What the user wants: when we snap a car **before** it registers, match that photo + MMC to the pass when the driver registers, and surface make/model/color in the dashboard so it can be **seen and used**.

## 2. Key insight — most of the plumbing already exists

- **`plate_events` is the single source of truth.** Every read writes `image_url` + `vehicle_make/model/color/type` there, registered or not, before or after registration.
- **The pre-registration photo match is already built.** On registration the backend (`public_registration.py:323-406`) looks back 2h for matching `plate_events`, picks the best frame (exact/Levenshtein plate match, confidence-ranked), and stamps `visitor_passes.first_seen_event_id` + `first_seen_at`. The dashboard already joins it (`getVisitorPasses` → `first_seen_event(image_url,…)`) and renders it (`FirstSeenEvidence`).

So we are **not** building photo-matching from scratch. We are extending three existing join points to also carry MMC, and fixing the dashboard to stop throwing it away.

**Design principle:** propagate MMC at the join point that *already links the records*, and only ever **fill-when-null** (never clobber a driver-declared or already-set value). `plate_events` stays the source; everything else is a denormalized copy for display/search/email.

## 3. Architecture — three layers

```
                       ┌─────────────────────────────┐
   every camera read → │  plate_events                │  ← SOURCE OF TRUTH
                       │  image_url + MMC (always)    │     (no change)
                       └──────────────┬──────────────┘
                                      │
        ┌─────────────────────────────┼──────────────────────────────┐
        │ LAYER 1 (DB trigger)        │ LAYER 2 (backfill on link)    │
        ▼                             ▼                               ▼
  alpr_violations               visitor_passes (registration         visitor_passes (camera
  MMC ← plate_event              backfill, pre-reg sighting)           match, post-reg sighting)
  via plate_event_id             MMC+photo ← first_seen plate_event    MMC+photo ← matched read
        │                             │                               │
        └─────────────────────────────┴───────────────┬──────────────┘
                                                       │ LAYER 3
                                                       ▼
                              dashboard: stop discarding MMC; render
                              MMC + photo on violation cards, awaiting
                              dispatch cards, and pass rows
```

### Layer 1 — Violations get MMC from their linked `plate_event` (DB trigger)

Every `alpr_violations` insert already carries `plate_event_id` (cooldown, truck-plaza overstay `truck_plaza_exit.ts:720-761`, cron-sweep expiry `cron-sessions-sweep:840-858`). MMC is **not** in scope at 3 of those 4 call sites, and threading it through the weak-read buffer / truck-plaza payload / cron signature is fragile and multi-file.

**Decision: a `BEFORE INSERT` trigger on `alpr_violations`** that, when `plate_event_id IS NOT NULL` and the row's `vehicle_*` are null, copies `vehicle_make/model/color/type` (+ existing `vehicle_make_confidence/color_confidence`) from the referenced `plate_events` row.

- Centralized, unbypassable, covers all current **and future** insert paths with zero edge-function redeploys.
- Fill-when-null → the cooldown path (which already sets MMC explicitly) is untouched.
- Triggers are an established pattern here (`truck_plaza_passes` migration already ships `BEFORE INSERT` triggers).

`no_registration_violations` is **out of scope** — it is the legacy table (`dashboard.html:9909` "replacing the legacy no_registration_violations table flow"); the live no-reg path runs through `plate_events` + grace sessions. Noted, not wired.

### Layer 2 — Passes get photo + MMC, from both directions

`visitor_passes` becomes the denormalized home for the car's identity so **all** pass consumers (owner direct-Supabase load, partner backend `parking-log` endpoint, dispatch emails, search) get it uniformly.

**2a. Schema (backend repo migration):** add `vehicle_make`, `vehicle_model`, `vehicle_color` to `visitor_passes` (`vehicle_type` already exists).

**2b. Registration-time backfill (pre-registration sighting)** — extend the existing `first_seen` block in `public_registration.py`. It already selects the best pre-reg `plate_event`; at that point also copy that event's `vehicle_make/model/color/type` onto the pass, **only where the pass column is null** (so a driver-declared `vehicle_type` wins). One migration + a few lines in the block that already runs.

**2c. Camera-match backfill (post-registration sighting)** — in `camera-snapshot` index, the registered-exit/match branch (`index.ts:1447-1463`) has `openSession.visitor_pass_id`, `imageUrl`, `mmcData`, `vehicleType`, `ev.data.id` all in hand. Add an `UPDATE visitor_passes SET …` that fills photo + MMC **where null** for the matched pass. This covers cars first seen *after* registration (drove in → registered at the gate → camera reads on the way to the spot), which the 2h-lookback misses.

Together: pre-reg sightings handled by the backend, post-reg sightings handled by the edge function, both idempotent and fill-when-null.

### Layer 3 — Dashboard surfacing

1. **Stop discarding MMC** — map `av.vehicle_make/model/color/type` through (`dashboard.html:4952`) instead of hardcoding null; add MMC to the `plate_events(...)` join as a fallback for rows predating the trigger.
2. **Awaiting dispatch cards** (the partner's primary surface, `dashboard.html:5415-5461`) — add a color swatch + `color type make model` line and a lazy photo thumbnail (reuse the existing `VehicleImage` / `getLatestPlateEventForPlate` pattern).
3. **Pass rows** (`TruckParkingLog`, `dashboard.html:9554-9773`) — render MMC chips + the camera photo on every pass row. Owner path gets the new columns free via `getVisitorPasses('*')`; partner path needs the columns added to the backend `parking-log` SELECT + response shape.
4. **Search** already matches color/type/make/model (the `matchesSearch` helper added today) — it lights up automatically once the data flows.

## 4. Files to touch

**lotlogic (camera pipeline + dashboard)**
- `supabase/migrations/<ts>_alpr_violation_mmc_from_plate_event.sql` — new trigger + function (Layer 1).
- `supabase/functions/camera-snapshot/index.ts` — pass photo+MMC backfill UPDATE in the matched-exit branch (Layer 2c). *(Apply to the deployed/wired source; also reconcile the repo copy — see §7.)*
- `frontend/dashboard.html` — mapping fix, awaiting-card MMC+photo, pass-row MMC+photo (Layer 3).

**lotlogic-backend**
- `migrations/<ts>_visitor_passes_vehicle_mmc.sql` — add `vehicle_make/model/color` (Layer 2a).
- `routers/public_registration.py` — copy MMC in the existing first_seen backfill (Layer 2b).
- `routers/visitor_passes.py` — add the new columns to the `parking-log` SELECT + response (Layer 3, partner path).

## 5. Data flow examples

- **Pull in → park → walk to QR → register:** camera read writes photo+MMC to `plate_events`; registration backfill (2b) stamps `first_seen_event_id` + copies MMC onto the pass; dashboard pass row shows photo + "white SUV GMC".
- **Register at gate → camera reads on the way in:** no pre-reg frame; camera-match branch (2c) fills the pass photo+MMC on the matching read.
- **Unregistered overstay → tow dispatch:** grace session expires → cron-sweep inserts `alpr_violations` with `plate_event_id`; trigger (1) fills MMC from the entry event; dispatch card + email show the car.

## 6. Idempotency, safety, ordering

- **Every write is fill-when-null** → re-runs and double-reads can't corrupt or flip values. The source of truth (`plate_events`) is never mutated.
- **Additive schema only** (new nullable columns, one trigger) → fully reversible; no backfill required for correctness.
- **Optional one-time historical backfill** (so recent history isn't blank): `UPDATE alpr_violations … FROM plate_events` by `plate_event_id`; `UPDATE visitor_passes … FROM plate_events` via `first_seen_event_id`. Run once after the trigger ships.
- **Recommended ship order:** (1) trigger migration → (2) `visitor_passes` columns migration → (3) backend registration + parking-log changes → (4) camera-snapshot edge-fn backfill → (5) dashboard render → (6) optional historical backfill. Each step is independently safe and adds value on its own.

## 7. Risks / notes

- **Repo drift:** the deployed `camera-snapshot` is the wired 1988-line version, not the 1884-line repo `index.ts`. The 2c edit must go to the deployed source, and the MMC sprint (mmc.ts, migrations 026-028, wiring) should be committed to the repo in the same pass to stop the drift (long-standing pending item).
- **`vehicle_type` precedence:** `visitor_passes.vehicle_type` may be driver-declared — fill-when-null protects it. Confirm whether the QR form actually sets it; if it never does, camera value always wins (fine).
- **Confidence display:** violations keep `*_confidence` (already columns); passes get make/model/color/type only (no confidence in pass UI — YAGNI).
- **Partner photo lookups:** awaiting-card thumbnails use the existing lazy `getLatestPlateEventForPlate` (on-intersection) so we don't add N queries to first paint.
- **Onboard MMC noise:** onboard make is sometimes `"-"`; treat `"-"`/empty as null on copy so we don't display a dash.

## 8. Testing

- **Unit:** extend `camera-snapshot/index.test.ts` for the matched-exit pass backfill; a SQL test for the trigger (insert violation with a plate_event that has MMC → row gets MMC; insert with MMC already set → untouched).
- **Manual (staging→prod):** register a plate after a camera sighting → pass row shows photo + make/model/color; force a cooldown + an overstay → both show MMC; partner awaiting card shows photo + MMC; search by "GMC"/"white" returns the right rows.
- **Build gate:** `dashboard.html` JSX must pass the esbuild parse (`sed -n '<script>' | esbuild --loader=jsx`) before push — a syntax error blanks the SPA.

## 9. Out of scope

- `no_registration_violations` (legacy table).
- New MMC *detection* work — detection already happens; this is purely propagation + display.
- Backfilling MMC onto `plate_sessions` consumers beyond what exists (sessions already store MMC at creation).
