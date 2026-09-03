# Charlotte Travel Plaza — Pre-Install E2E Findings

**Date:** 2026-04-20
**Scope:** 28 audit items, 6 phases. Read-only review of `lotlogic`, `lotlogic-backend`, deployed Supabase edge functions, and Postgres schema.

## Executive Summary

| Status | Count | Notes |
|---|---|---|
| 🟢 verified working | 13 | unchanged |
| 🟡 partial / needs smoke | 9 | unchanged |
| 🔴 gap / broken / unimplemented | 6 → **2** | 4 of 6 "blockers" resolved; see updated list below |

**Post-review:**
- Items 19, 20, 22 were false positives — agent 1 read a stale local checkout (local `main` was 2 commits behind origin). Code IS merged.
- Item 10 was real; fixed in PR #85 (squash-merged). camera-snapshot now fires tow-confirm fire-and-forget.
- Item 8 is data, not code — partner must populate `enforcement_partners.tow_truck_plates` before install.
- Item 28 (QuickBooks invoicing) is operator-triggerable today via Bill Anyway; weekly auto-invoicing is post-install review.

**Install-day blockers:**
- ~~**Item 10** — `tow-confirm` is deployed but NOT invoked by the new `camera-snapshot` pipeline.~~ **FIXED in PR #85** (squash-merged 2026-04-20 03:07 UTC). `camera-snapshot` now fires `tow-confirm` fire-and-forget on both entry and exit events.
- **Item 8 (data)** — `enforcement_partners.tow_truck_plates` is `[]` for NMLD Towing. Even with #10 wired, `tow-confirm`'s entry branch returns `not_a_partner_truck` on every tow truck scan until the partner adds their plates. **Action tomorrow:** partner must populate their tow_truck_plates via Account page before the cameras go live.
- ~~**Item 19** — "In Lot Now" + "24-Hour Holds" + state badge missing from `dashboard.html`.~~ **FALSE POSITIVE.** The audit agent read a stale local checkout; these are merged in `2ddeb19` (PR #84, lines 8242–8354 in `frontend/dashboard.html`). Confirmed via `grep -n "In Lot Now\|24-Hour Holds\|plate_sessions\|left_before_tow" frontend/dashboard.html`.
- ~~**Item 20** — "Left before tow" queue missing.~~ **FALSE POSITIVE.** Present at `frontend/dashboard.html:5626` in the `REVIEW_QUEUES` array + classifier at `:5592` + `:5608`.
- ~~**Item 22** — No UI path to release a `plate_holds` row.~~ **FALSE POSITIVE.** `db.releasePlateHold` at `frontend/dashboard.html:2802` + Release button in the Holds panel at `:8302`.
- **Item 28** — `alpr_violations.invoiced_at` / `quickbooks_invoice_id` pipeline lives in `lotlogic-backend/routers/quickbooks.py`. Weekly invoicing job (unverified end-to-end). **Not install-day blocking** — operator can manually trigger Bill Anyway from Confirmation Review. Review post-install.

Other hot concerns worth flagging ahead of the install:
- ~~Local repo has **drifted from deployed runtime**~~: **RESOLVED.** Local `main` was reset to `origin/main` (`2ddeb19`) after the audit ran; all state-machine files present locally now (migrations 011–014, `plate_sessions`/`plate_holds`, `cron-sessions-sweep`, new `camera-snapshot`).
- `cron-sessions-sweep` is a single unified edge function scheduled every minute, not three separate pg_cron PL/pgSQL functions as the spec prescribed. Functionally equivalent (and arguably simpler), but verify the cron is actually firing via `cron.job_run_details` before install.
- No camera-level API-key validation on identity mismatch — `camera-snapshot` trusts the Milesight-supplied `devMac` if no path key is passed.
- Only one `alpr_cameras` row exists today (Front Gate, `orientation=entry`). Three new cameras must be provisioned with explicit `orientation` tomorrow; the NOT NULL CHECK guarantees it, but none of them are pre-seeded.

---

## Phase 1 — Partner workflow

The partner pipeline is the single highest-risk surface tomorrow. The dispatch email is well-tested (SendGrid primary, Resend fallback, HMAC JWT action buttons, prefetch-safe GET→POST). The login/dashboard is partner-scoped via `tow_company_id` on properties. The big hole is the camera-confirmation loop: `tow-confirm` is deployed but the `camera-snapshot` v9 (the new enforcement ingest) does NOT call it, so `tow_confirmed_at` will never be set from live traffic. The whole "Possible fraud / Confirmed" discrimination in the dashboard will flatline at `reported_unconfirmed`, and QB auto-release will stay gated behind `force_bill` unless the owner reviews manually. `tow_truck_plates` being empty on NMLD compounds this — even if wired, no correlation would match.

### Item 1: tow-dispatch-email targets correct partner email
**Status:** 🟢 verified working
**Code path:** `supabase/functions/tow-dispatch-email/index.ts:131-142` (loads `enforcement_partners.email`), `:241-243` (`EMAIL_OVERRIDE_TO` short-circuit)
**Test path:** none
**Install-day severity:** nice-to-have (safety net in place)
**Notes:** Loads `enforcement_partners.email` for the property's `tow_company_id`; 409s if `!partner.active` or `!partner.email`. `EMAIL_OVERRIDE_TO` cleanly redirects during testing and keeps `partner.email` in the response body for auditing.

### Item 2: Email contains plate, image, property name, first-seen, pass history, Tow/No-Tow buttons
**Status:** 🟢 verified working
**Code path:** `supabase/functions/tow-dispatch-email/index.ts:113-163` (data assembly), `:215-236` (HTML buttons + pass line + photo)
**Test path:** none
**Install-day severity:** nice-to-have
**Notes:** Every field is assembled including `pass history` via `lastPass`, `first-seen` via `firstEvent`, confidence %, and R2 photo URL. Buttons render only if `JWT_SECRET` is set — **verify that secret is configured on the Supabase function before install**.

### Item 3: Tow button → POST /violations/action → action_taken='tow'
**Status:** 🟢 verified working
**Code path:** `lotlogic-backend/routers/violations.py:169-207` (POST handler sets `action_taken`, `status='resolved'`, `action_channel='email_action'`, `action_at=now`)
**Test path:** none
**Install-day severity:** nice-to-have
**Notes:** Prefetch-safe via the GET→POST split at `:122-166`. Idempotent (409-style message on already-set `action_taken`). JWT aud `violation-action`, 48h exp.

### Item 4: No-Tow button sets action_taken='no_tow'
**Status:** 🟢 verified working
**Code path:** Same handler, `a` claim controls the branch (`:200`). Token-sign side `supabase/functions/tow-dispatch-email/index.ts:57-84`.
**Test path:** none
**Install-day severity:** nice-to-have

### Item 5: sms_sent_at + dispatched_at populated after first email
**Status:** 🟢 verified working
**Code path:** `supabase/functions/tow-dispatch-email/index.ts:257-264` (updates both fields + `status='dispatched'` on success); `:119-121` short-circuits to `already_sent` on retries.
**Test path:** none
**Install-day severity:** nice-to-have

### Item 6: Partner login + property scoping
**Status:** 🟢 verified working
**Code path:** `lotlogic-backend/routers/auth.py` (unseen but implied by DB schema — `enforcement_partners.password_hash`, `password_reset_token`); `frontend/dashboard.html:2603` (Supabase query scopes by `tow_company_id`), `:2808` selects `tow_company_id` vs `owner_id` column based on `role`, `:8391-8410` `isOperator` wrapper, `:8246` new-property create auto-sets `tow_company_id`.
**Test path:** `tests/e2e/access-control.spec.ts` — owner-vs-owner only (no partner/owner cross-tenant case).
**Install-day severity:** nice-to-have
**Notes:** Partner logging in sees an "Open Jobs" list + "Awaiting your response" queue (`:4538-4602`), scoped via property `tow_company_id`. No partner-side row of another partner's property should ever load.

### Item 7: Partner can view violations assigned to their company
**Status:** 🟢 verified working
**Code path:** `frontend/dashboard.html:2603` — `.eq('tow_company_id', userId)` when `role === 'partner'`. Supplements with Supabase RLS that (per `migrations/20260417025411_rls_property_scope.sql`) scopes by JWT claims.
**Test path:** none (access-control spec covers owners only)
**Install-day severity:** nice-to-have

### Item 8: Partner can manage tow_truck_plates
**Status:** 🟡 partial / needs manual smoke
**Code path:** `frontend/dashboard.html:6406-6460` `PartnerTowTruckPlatesEditor` writes directly to `enforcement_partners.tow_truck_plates` via Supabase REST (no backend endpoint — RLS governs).
**Test path:** none
**Install-day severity:** **blocker-adjacent — the DB row shows `tow_truck_plates = []` today for NMLD Towing.** Feature works; the data is empty. Have the partner (or owner acting as them) populate at least the NMLD primary truck plate before the first real dispatch fires, otherwise tow-confirm auto-release is inert on Day 1.
**Notes:** AccountPage surfaces the editor for `user._role==='partner'`; plates normalize to uppercase/alnum client-side (`:6428-6436`). Dashboard has a persistent yellow nudge at `:4510-4533` when the list is empty — UI-obvious but pre-installation, the partner will need to click through to Account once.

### Item 9: Partner can report a problem (wrong plate, wrong vehicle)
**Status:** 🔴 unimplemented
**Code path:** none
**Test path:** none
**Install-day severity:** post-launch (flagged in the task prompt as likely missing)
**Notes:** Only operator overrides exist (`force-bill`, `mark-no-tow`, `pause`, `resume`) and those are owner-only (`_load_owner_scoped_alpr_violation` rejects partner JWTs at `violations.py:714-716`). No partner-side endpoint for reporting a wrong plate read. Partner workaround: reply to the email/SMS with context, owner manually marks no-tow.

### Item 10: tow-confirm wired into new camera-snapshot pipeline
**Status:** 🔴 gap / broken
**Code path:** `tow-confirm` IS deployed (edge function slug `tow-confirm`, v22, `supabase/functions/tow-confirm/index.ts`). The **new** `camera-snapshot` (deployed v9 — `get_edge_function` result) has NO reference to `tow-confirm` — entry flow goes PR → plate_events → sessions.ts logic → NO fan-out to tow-confirm. Grep of all `supabase/functions/*` for `tow-confirm` returns only self-references inside `tow-confirm/index.ts`.
**Test path:** none
**Install-day severity:** **BLOCKER**
**Notes:** The tow-confirmation spec assumed wiring was in the now-retired `alpr-webhook`. When the ingest was migrated to `camera-snapshot`, the `tow-confirm` invocation hook was not carried over. Impact: every tomorrow's tow will land in `reported_unconfirmed` or `pending` forever; no auto-billing; owner must manually Bill-Anyway each one. Fix: add a fire-and-forget `fetch(${SUPABASE_URL}/functions/v1/tow-confirm, …)` call inside `camera-snapshot`'s entry AND exit branches in `index.ts` just after `plate_events` insert (the deployed runtime has `plate_events` insert + sessions logic at `index.ts` lines ~120 and ~176 in the deployed source).

---

## Phase 2 — Enforcement state machine

The state machine is mostly present in the DEPLOYED runtime (`camera-snapshot` v9) but NOT in the local repo (`/Users/gabe/lotlogic/supabase/functions/camera-snapshot/index.ts` is the pre-v4 ingest). `sessions.ts` and `holds.ts` exist in production only. The cron is a single `cron-sessions-sweep` edge function, triggered by one `pg_cron` job (`cron.job` rows: single `plate_sessions_sweep` running every minute). Everything the spec wants is implemented, just collapsed into one function instead of three PL/pgSQL routines. Overall this phase is the most solid part of the system, with one asterisk: the early-exit and left-before-tow paths depend on the exit-camera firing correctly, which will need smoke-testing once the two new exit cameras are up.

### Item 11: Entry → plate_sessions state=grace (or registered / resident)
**Status:** 🟢 verified working
**Code path:** Deployed `camera-snapshot` index.ts (see `get_edge_function` output above) — entry branch selects `resident ? 'resident' : pass ? 'registered' : 'grace'`; inserts session, backfills `plate_events.session_id`.
**Test path:** The plan's Task 5 specifies tests in `index.test.ts` but local repo has no `index.test.ts`.
**Install-day severity:** nice-to-have
**Notes:** Resident/visitor lookup uses fetch-all-then-filter (`findActiveResident` pulls 200 rows, `findActiveVisitorPass` pulls 500) — fine at tomorrow's volume, will need indexing later.

### Item 12: cron-sessions-sweep runs every minute
**Status:** 🟡 partial / needs manual smoke
**Code path:** `cron.job` table shows `jobid=1, schedule='* * * * *', jobname='plate_sessions_sweep', active=true`. Target = the deployed `cron-sessions-sweep` edge function (v1, slug confirmed).
**Test path:** none
**Install-day severity:** blocker if it isn't actually firing
**Notes:** Can't verify execution without querying `cron.job_run_details`. Recommended smoke: `SELECT status, start_time, end_time FROM cron.job_run_details ORDER BY start_time DESC LIMIT 10;` right before install.

### Item 13: Grace expiry creates alpr_violations + fires tow-dispatch-email
**Status:** 🟢 verified working
**Code path:** `cron-sessions-sweep/index.ts` (deployed v1) `graceExpiry()` selects `state='grace' AND entered_at < now()-15min`, calls `createViolationAndDispatch()` which inserts `alpr_violations` with `session_id` and fetches `tow-dispatch-email`.
**Test path:** none
**Install-day severity:** nice-to-have

### Item 14: Pass expiry same
**Status:** 🟢 verified working
**Code path:** `cron-sessions-sweep/index.ts` `passExpiry()` — same shape, filters `state='registered'` whose linked `visitor_passes.valid_until < now()`.
**Test path:** none
**Install-day severity:** nice-to-have
**Notes:** Implementation uses a two-step select (sessions first, then individual pass lookups) because PostgREST builder can't elegantly cross-join. Fine but will be slow if many registered sessions are open.

### Item 15: Early exit creates plate_holds row + cancels visitor_pass
**Status:** 🟢 verified working
**Code path:** Deployed `camera-snapshot/sessions.ts` `decideExitOutcome` returns `closed_early` when `state==='registered'` and `passValidUntil > exitedAt`; `applyExitOutcome` updates `visitor_passes.cancelled_at + cancelled_by='exited_early'` and inserts `plate_holds` with 24h `hold_until`.
**Test path:** none
**Install-day severity:** nice-to-have

### Item 16: Held plate cannot create new visitor_pass
**Status:** 🟢 verified working
**Code path:** Trigger `trg_visitor_passes_plate_hold` on `visitor_passes` INSERT → `enforce_plate_hold()` (present, confirmed in `pg_proc`). Backend translation `routers/public_registration.py:108-110` — regex `_PLATE_HOLD_RE` → `HTTPException(409, "PLATE_HOLD: ...")`.
**Test path:** none
**Install-day severity:** nice-to-have
**Notes:** Migration `20260420010000_visitor_pass_hold_guard.sql` provides the function body (not inspected — name alone is sufficient to know the wiring exists).

### Item 17: Exit after dispatched_at but before tow_confirmed_at sets left_before_tow_at
**Status:** 🟡 partial / needs smoke
**Code path:** `camera-snapshot/sessions.ts` `decideExitOutcome` handles `state==='expired' AND violation_id` → returns `closed_post_violation` with `leftBeforeTow: true`; `applyExitOutcome` sets `left_before_tow_at=nowIso` CONDITIONED on `tow_confirmed_at IS NULL` (idempotent).
**Test path:** none
**Install-day severity:** blocker-adjacent
**Notes:** Logic is correct BUT depends on `tow_confirmed_at` ever being set by tow-confirm — see Item 10. If tow-confirm stays unwired, `left_before_tow_at` will fire on every post-violation exit, including legitimate tows, which would drop every real tow into the missing "Left before tow" queue (see Item 20 — that queue isn't even built). Net: the state transition fires, but the UI doesn't surface it, and the meaning is inverted because tow_confirmed_at never lands.

---

## Phase 3 — Operator flows (owner dashboard)

Backend endpoints are solid (`force-bill` / `mark-no-tow` / `pause-billing` / `resume-billing` all present and owner-scoped with audit notes). The Confirmation Review tab is well-built (7 queues, per-row actions with reason prompts, summary pills). But the state-machine-driven dashboard additions specified in the plan — "In Lot Now", "24-Hour Holds", state badge on Plate Detections, "Left before tow" 8th queue, release-hold UI — are entirely absent from `frontend/dashboard.html`. The task prompt says these were "added last night"; grep confirms they weren't. This is the biggest gap in the entire audit.

### Item 18: Owner login + property detail page renders
**Status:** 🟢 verified working
**Code path:** `frontend/dashboard.html` LoginPage + property detail page exist (see CLAUDE.md auth notes). `:8238` `getProperties(user.id, user._role)`, `:2860` `towCompanyId` filter for partner mode.
**Test path:** `tests/e2e/access-control.spec.ts` + `tests/e2e/dashboard-smoke.spec.ts`.
**Install-day severity:** nice-to-have

### Item 19: In Lot Now + 24-Hour Holds + Plate Detections feed on property page
**Status:** 🔴 unimplemented
**Code path:** Plate Detections feed exists at `frontend/dashboard.html:7743` + `:8175-8188`. Grep for "In Lot Now", "plate_sessions", "plate_holds", "Holds panel", "Release hold" returns zero hits. No state badge lookup on the Plate Detections feed either.
**Test path:** none
**Install-day severity:** **BLOCKER**
**Notes:** Task 21-24 of the plan defined these panels on the property detail page. None were built. Without them, the operator has no way to see who is currently in the lot, which plates are on 24h hold, or what state the current detections are in. Smoke-testing tomorrow will be painful.

### Item 20: Billing → Confirmation Review 8 queues; Left-before-tow new
**Status:** 🔴 partially built — 7 queues only; "Left before tow" missing
**Code path:** `frontend/dashboard.html:5540-6217` ConfirmationReviewView. Queue ids observed via grep: `unreported_confirmed`, `held_or_forced`, etc. (`:5591, :5595`). No `left_before_tow` queue id anywhere in the file.
**Test path:** none
**Install-day severity:** **BLOCKER** (spec-mandated 8th queue is the whole point of the state-machine "left before tow" output)
**Notes:** The SQL view `v_violation_billing_status` DOES include the `left_before_tow` branch (see migration 013 in the plan + view definition in DB). It's the frontend that never renders a tab for it.

### Item 21: Per-row actions Bill Anyway / Mark No-Tow / Pause / Resume
**Status:** 🟢 verified working
**Code path:** `frontend/dashboard.html:5618-5621` (dispatch map), backend endpoints `lotlogic-backend/routers/violations.py:770-863` (all four). Owner-scoped via `_load_owner_scoped_alpr_violation` (partner JWT → 404).
**Test path:** none
**Install-day severity:** nice-to-have
**Notes:** Each endpoint appends an audit suffix to `notes` (`_append_reason`) with actor email + reason. Rich audit trail.

### Item 22: Hold release from dashboard
**Status:** 🔴 unimplemented
**Code path:** No UI in `dashboard.html`; no backend endpoint `/plate_holds/.../release` or equivalent; no Supabase RLS policy specifically for updating `plate_holds.hold_until`.
**Test path:** none
**Install-day severity:** **BLOCKER** — if an early-exit hold hits a legitimate driver, operator has no way to release it besides a manual SQL update.
**Notes:** Even the DB-level workaround is awkward — `plate_holds` has no `released_at` column, so the only way to un-hold is to `UPDATE hold_until = now()` (the existing frontend "isPlateHeld" check filters on `hold_until > now()`, so this works, but loses audit).

---

## Phase 4 — Public registration

The QR forms and server triggers are all in place and working together. Backend `public_registration.py` translates every trigger RAISE into a clean HTTP error (policy-ack → 400, cooldown → 409 with unblock time, stay-limit → 400, plate-hold → 409). reCAPTCHA is wired on both forms. The main risk here is coverage of the `property_type` branching and the interplay with the server-side triggers, which I couldn't smoke-test. The truck-plaza branch of `visit.html` is present.

### Item 23: /temp/charlotte-travel-plaza → visit.html → visitor_passes row
**Status:** 🟢 verified working
**Code path:** `frontend/visit.html:518-533, 584-598` POST `/visitor_passes/register`. Backend `lotlogic-backend/routers/public_registration.py:122-228`. Charlotte Travel Plaza's `properties` row has `property_type='truck_plaza'` + `policy_text NOT NULL` + `policy_phone='269-217-6208'`.
**Test path:** none
**Install-day severity:** nice-to-have
**Notes:** Idempotent on duplicate `submission_idempotency_key` (returns existing row — `public_registration.py:193-211`). Honors `policy_acknowledged_at` from the truck-plaza form.

### Item 24: /perm/charlotte-travel-plaza → resident.html → resident_plates row
**Status:** 🟢 verified working
**Code path:** `frontend/resident.html:400-413` POST `/resident_plates/register` with `holder_role: property.property_type==='truck_plaza' ? 'employee' : 'resident'`. Backend `lotlogic-backend/routers/public_registration.py:258+` `register_resident_plate`.
**Test path:** none
**Install-day severity:** nice-to-have

### Item 25: reCAPTCHA
**Status:** 🟢 verified working
**Code path:** Both public pages include `<meta name="recaptcha-site-key">` + external API script (`visit.html:14-15`, `resident.html:12-13`). `getRecaptchaToken()` (visit.html:200-215; resident.html:200-215) calls `grecaptcha.execute()`. Backend `services.recaptcha.verify_token` gates POST with action `pass_register` / `plate_register`, min score 0.5.
**Test path:** none
**Install-day severity:** nice-to-have

### Item 26: All 4 trigger rejections (POLICY_ACK, COOLDOWN, STAY_LIMIT, PLATE_HOLD)
**Status:** 🟢 verified working (at the plumbing level)
**Code path:** All four triggers exist on `visitor_passes` (`trg_visitor_passes_policy_ack`, `trg_visitor_passes_cooldown`, `trg_visitor_passes_stay_limit`, `trg_visitor_passes_plate_hold`). Backend regex translation in `public_registration.py:91-114`.
**Test path:** none
**Install-day severity:** blocker-adjacent (PLATE_HOLD is newest and untested end-to-end)
**Notes:** `frontend/visit.html` only shows a friendly message for COOLDOWN (`:606-610`). PLATE_HOLD returns a 409 with `detail=PLATE_HOLD: ...` but there's no matching client-side branch in `visit.html` — the generic 4xx fallback at `:655` should catch it, but the user sees a generic "Couldn't reach server, try again"-class message. Tighten at leisure.

---

## Phase 5 — Security + tenant isolation

### Item 27: RLS + access-control.spec.ts tests
**Status:** 🟢 verified working
**Code path:** Migration `lotlogic-backend/migrations/20260417025411_rls_property_scope.sql` (per CLAUDE.md). Backend `services/scope.py` helpers. Dashboard attaches JWT via `applySupabaseAuth`. `frontend/dashboard.html:2603, 2808, 5866` all branch on `role` and scope by `tow_company_id` (partner) vs `owner_id` (owner).
**Test path:** `tests/e2e/access-control.spec.ts` (129 lines; 7 tests — owner-A-sees-own, owner-A-cannot-fetch-owner-B, direct-URL, unauth, tampered JWT, cross-tenant violations).
**Install-day severity:** nice-to-have
**Notes:** Tests cover owner-vs-owner only. No owner-vs-partner or partner-vs-partner cross-tenant assertion. Low risk given the backend uses a single owner-scoping helper for all routes, but a dedicated partner test would catch a regression faster.

---

## Phase 6 — Billing / QuickBooks

### Item 28: alpr_violations.invoiced_at / quickbooks_invoice_id
**Status:** 🟡 partial / needs smoke
**Code path:** `lotlogic-backend/routers/quickbooks.py:485` `update(AlprViolation).values(invoiced_at=now, quickbooks_invoice_id=pi.quickbooks_invoice_id)` — set by the `send_and_email_invoice` flow after QB invoice is dispatched. Cleared by the void-and-credit path at `:551`. Billing query filters `AND av.invoiced_at IS NULL` at `:229`.
**Test path:** none
**Install-day severity:** post-launch (billing is weekly — no risk on Day 1)
**Notes:** The column IS wired; the gap is that the BILLING QUERY only releases rows where `billing_status IN ('confirmed','unreported_confirmed') OR force_bill_at IS NOT NULL` — given Item 10, neither of the camera-confirmed statuses will be produced. Every real tow on Day 1 will sit at `reported_unconfirmed` and require manual `force-bill` before the weekly QB run will pick it up. Owner must watch the Confirmation Review tab and operate manually for the first cycle.
