# ALPR Pipeline — Post-Gut Consolidated Design

**Date:** 2026-04-20
**Owner:** Gabe
**Status:** Current as-built reference + remaining-work scope
**Supersedes / consolidates:** none — points at the three authoritative sub-specs below.

This document is a single entry-point for the ALPR camera pipeline that was
rebuilt after the 2026-04-19 gut. It captures what is live in production
today and enumerates the remaining work to finish first-class USDOT/MC
tracking throughout the system. Implementation details for each sub-system
stay in their own specs; this doc is the index.

## Authoritative sub-specs

| Sub-system | Spec | Status |
|---|---|---|
| Camera ingest (ANPR cameras, webhooked from Plate Recognizer) | `docs/superpowers/specs/2026-04-19-milesight-pr-integration-design.md` | Live (PRs #82, #83) |
| Camera ingest (ANPR-less cameras, raw JPEG push) + session state machine | `docs/superpowers/specs/2026-04-20-camera-session-state-machine-design.md` | Live (PRs #83, #84, #85) |
| USDOT / MC OCR fallback (ParkPow) for plateless tractors | `docs/superpowers/specs/2026-04-20-usdot-ocr-fallback-design.md` | Live behind `ENABLE_USDOT_FALLBACK=true` (PRs #86, #87) |

Read those for sub-system depth. This doc does not duplicate them.

## As-built architecture

```
┌──────────────────────────────────────────────────────────┐
│  Cameras                                                  │
│  - Milesight ANPR (LPR onboard) → webhook to PR Snapshot  │
│  - Milesight 4G Traffic Sensing (raw JPEG)                │
│  - each row in alpr_cameras carries orientation=entry|exit│
└──────────────┬───────────────────────────────────────────┘
               │                               │
         (PR webhook)                     (raw JPEG POST)
               ▼                               ▼
┌─────────────────────┐              ┌──────────────────────┐
│  pr-ingest edge fn  │              │  camera-snapshot     │
│  (currently idle —  │              │  edge fn             │
│   no live cameras   │              │                      │
│   webhook here)     │              │  1. parse multipart  │
│                     │              │     or Milesight     │
│                     │              │     JSON             │
│                     │              │  2. look up camera   │
│                     │              │  3. call PR sync     │
│                     │              │  4. USDOT OCR if     │
│                     │              │     PR returned 0    │
│                     │              │     plates (feature  │
│                     │              │     flag gated)      │
│                     │              │  5. upload snapshot  │
│                     │              │     to R2            │
│                     │              │  6. state-machine    │
│                     │              │     open/close       │
│                     │              │     plate_sessions   │
│                     │              │  7. insert           │
│                     │              │     plate_events     │
│                     │              │  8. fire-and-forget  │
│                     │              │     tow-confirm      │
└──────────┬──────────┘              └──────────┬───────────┘
           │                                    │
           └─────────────┬──────────────────────┘
                         ▼
        ┌───────────────────────────────────────┐
        │  Supabase (Postgres)                   │
        │  - plate_sessions (open/closed)        │
        │  - plate_events   (session_id FK)      │
        │  - plate_holds    (24h post early-exit)│
        │  - alpr_violations (session_id FK,     │
        │                     left_before_tow_at)│
        │  - resident_plates, visitor_passes     │
        │    (+ usdot_number, mc_number cols —   │
        │     migration 015, see "Pending" below)│
        └─────────────────┬─────────────────────┘
                          ▼
        ┌───────────────────────────────────────┐
        │  pg_cron (every 1 min) →               │
        │  cron-sessions-sweep edge fn           │
        │  - registration_transition             │
        │    (grace → registered on new pass)    │
        │  - grace_expiry                        │
        │    (grace → expired + alpr_violations) │
        │  - pass_expiry                         │
        │    (registered → expired + violation)  │
        │  Each fires tow-dispatch-email for     │
        │  new violations.                       │
        └─────────────────┬─────────────────────┘
                          ▼
        ┌───────────────────────────────────────┐
        │  tow-dispatch-email (SendGrid primary,│
        │  Resend fallback, signed action links) │
        │  Partner clicks Tow / No Tow →         │
        │  backend /violations/action resolves    │
        └───────────────────────────────────────┘

        (exit-camera events also hit tow-confirm to correlate tow-truck
         plate sightings against open violations and set tow_confirmed_at)
```

Key contract: **camera-snapshot never dispatches tow emails directly.**
It only opens/closes sessions and fires `tow-confirm`. All tow dispatch
originates from the cron sweepers when they create an `alpr_violations`
row.

## Session state transitions (reference)

| From → To | Trigger |
|---|---|
| *(none)* → `grace` | entry camera sees unknown plate |
| *(none)* → `registered` | entry camera sees plate matching active `visitor_pass` |
| *(none)* → `resident` | entry camera sees plate matching active `resident_plate` |
| `grace` → `registered` | cron sees new matching `visitor_pass` for open session |
| `grace` → `expired` | cron: 15 min elapsed since `entered_at`, no pass; inserts `alpr_violations` |
| `registered` → `expired` | cron: `visitor_pass.valid_until < now()` while session open; inserts violation |
| `grace`/`registered`/`resident` → `closed_clean` | exit camera, no penalty condition |
| `registered` → `closed_early` | exit camera while `valid_until > now()`; cancels pass, inserts `plate_holds` (24h) |
| `expired` → `closed_post_violation` | exit camera; if `tow_confirmed_at` still null, sets `left_before_tow_at` |

USDOT/MC plates participate in the state machine identically — the
allowlist match happens via `resident_plates.usdot_number` /
`visitor_passes.usdot_number` (or `mc_number`) instead of `plate_text`.

## What is already live

All of the following are in prod as of 2026-04-20:

- Both ingest edge functions deployed (camera-snapshot is the active one)
- Migrations 010–014 applied (pr-ingest enums, orientation, plate_sessions,
  plate_holds, session cron schedule)
- Cron sweepers running every minute
- USDOT OCR fallback deployed, feature-flagged on via
  `ENABLE_USDOT_FALLBACK=true` + `PARKPOW_USDOT_TOKEN`
- Dashboard panels: In Lot Now, Holds, Plate Detections (with session-state
  badge), Billing → Confirmation Review → "Left before tow" queue
- tow-confirm wired on both entry and exit events
- tow-dispatch-email with action links (SendGrid primary), click tracking
  disabled so `url{N}.lotlogicparking.com` SSL doesn't intercept resolve
- Domain live on `lotlogicparking.com` (apex + www + api subdomain)

## What is pending (scope of the accompanying plan)

1. **Repo parity with deployed DB.** Migration 015 (`usdot_number` +
   `mc_number` columns on `visitor_passes` and `resident_plates`, with
   partial indexes) was applied via MCP but has no file in `migrations/`.
   Commit it as `migrations/015_usdot_number_on_passes_and_residents.sql`.
2. **Commit the already-modified-but-uncommitted code.**
   - `supabase/functions/camera-snapshot/sessions.ts` has
     `extractFmcsaNumber()` and DOT/MC branches in `findActiveResident` /
     `findActiveVisitorPass`.
   - `frontend/dashboard.html` has USDOT / MC# badges on In Lot Now and
     Plate Detections rows.
   Both need to land on main as a single commit with the migration.
3. **QR registration forms accept USDOT + MC.** Add optional
   `usdot_number` / `mc_number` fields to the truck-plaza branch of
   `frontend/visit.html` and `frontend/resident.html`. Validation: 5-8
   digits, optional, but the combined "at least one of plate / USDOT / MC"
   rule enforced before submit.
4. **Backend public-registration endpoint stores them.** In
   `lotlogic-backend/routers/public_registration.py` (separate repo),
   accept `usdot_number` and `mc_number` in the request body and include
   them in the `visitor_passes` and `resident_plates` INSERTs. Null-safe.
5. **Dashboard list views show USDOT / MC.** Already done for In Lot Now
   and Plate Detections; still missing on the Truck Parking Log (visitor
   pass list) and the Permanent Plates list. Add a column / badge so
   operators can tell at a glance which registrations were by
   USDOT/MC vs. license plate.
6. **Deploy.** `supabase functions deploy camera-snapshot` once sessions.ts
   lands on main (the Vercel deploy of dashboard.html is automatic).
7. **Smoke test.** Register a fake `DOT-1234567` pass via visit.html
   → confirm a test image with a DOT-1234567 synthesis matches it → session
   opens as `registered`, not `grace`.

## Out of scope

- Rewriting any of the three sub-specs. They stay authoritative.
- Removing `pr-ingest` (idle but still deployed). Keep as a bypass for
  future LPR-capable cameras.
- Operator manual session override (deferred).
- Per-vehicle-type enforcement rules (deferred, captured in the state-
  machine spec's non-goals).
- Tow-dispatch email templating that distinguishes USDOT vs. plate
  violations (deferred; the raw plate text `DOT-xxxxxxx` is legible enough
  for v1).

## Risk / rollback

All six work items are additive:

- Migration 015 is already in prod; committing the file is purely for repo
  parity, zero runtime risk.
- sessions.ts USDOT branches only activate on plates starting `DOT` / `MC`;
  standard plates take the unchanged code path.
- Form fields are optional; existing submissions unaffected.
- Backend endpoint change is a pure addition to the body schema.
- Dashboard changes are presentational.

Rollback: revert the commit. Migration 015 columns can remain; they have
no triggers and are nullable.

## Testing plan

- **Unit:** extend `supabase/functions/camera-snapshot/sessions.test.ts`
  (if missing, create it) with DOT/MC match cases against fake Supabase.
- **Integration:** no new integration; the existing
  `camera-snapshot/index.test.ts` already covers the USDOT fallback path.
- **Manual smoke:** step 7 above.

## References

- Live camera runbook: `supabase/functions/camera-snapshot/` and ops docs
  committed alongside PR #84.
- CLAUDE.md section "Architecture" and "Camera-based ALPR pipeline" for
  the summary written after each gut-and-rebuild cycle.
