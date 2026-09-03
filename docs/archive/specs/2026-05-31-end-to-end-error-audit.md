I'll analyze the confirmed findings, deduplicate the overlapping ones, and produce the ranked report.

Let me identify the dedup groups first:
- **Three findings on the GET /violations/action prefetch bug** (two `high` + one `critical` with confusing severity fields) → merge into one CRITICAL.
- **Two findings on v_violation_billing_status SECURITY DEFINER view** (one `high` read-only, one `critical` read+write) → merge into one CRITICAL (write capability is the worse one).
- **Three findings on overstay dispatch rate-limit / dispatch_failed** (two near-identical CRITICAL/HIGH on the 120 dropped tows) → merge into one CRITICAL.
- **Three findings on the backend overstay_tick dead endpoint** → merge into one MEDIUM.

Here is the report.

# LotLogic End-to-End Error Report — 2026-05-30

_All findings below were verified against LIVE state (SQL, deployed edge functions, live HTTP probes), not repo/migration files. Overlapping findings have been deduplicated: the 3 GET-action findings, the 2 billing-view findings, the 3 overstay-dispatch findings, and the 3 overstay_tick findings have each been merged._

---

## 1. EXECUTIVE SUMMARY

**Counts by severity (post-dedup):**

| Severity | Count |
|---|---|
| CRITICAL | 3 |
| HIGH | 9 |
| MEDIUM | 4 |
| LOW | 11 |
| **Total** | **27** |

**Top 5 things hurting drivers / operators / revenue RIGHT NOW:**

1. **120 real overstay tows at Charlotte were silently dropped** and are still being dropped today (newest 2026-05-31 20:08). The partner is never paged, the owner sees no tow roll, the row is invisible to the operator, and nothing retries. _Actively recurring, real revenue + enforcement loss._
2. **The anon key can READ and WRITE every tenant's violations** via the `v_violation_billing_status` SECURITY DEFINER view — RLS-bypassed. An attacker can suppress all tow billing or fabricate confirmed tows to bill innocent drivers. _Exploit reproduced live (rolled back)._
3. **Tow-action email links auto-fire on GET.** A mail scanner / link-prefetcher confirming a tow with zero human click → a driver gets billed/towed nobody approved. Currently masked only by `DISPATCH_EMAILS_DISABLED`; goes live the instant dispatch resumes.
4. **Camera health is invisible.** `alpr_cameras.last_seen_at` is never written (NULL for all cameras, including the 2 live ones), and 2 retired north cameras still show solid-green "Active." This is the exact blind spot behind the unnoticed Charlotte north-gate outage.
5. **Camera tow-arrival evidence never auto-confirms a tow** at Charlotte (the only live property): 47 sightings recorded, 0 ever correlated to a violation. Confirmed tows + revenue-share must be reconciled entirely by hand.

---

## 2. CRITICAL + HIGH FINDINGS

### CRITICAL

---

#### C1. Overstay tows silently dropped — 120 stuck in `dispatch_failed`, no page, no retry, still recurring
**Subsystem:** cron-sessions-sweep edge function / tow-dispatch / Charlotte enforcement
**Who it hurts:** A truck overstays, the system correctly creates the violation — but the tow partner (Frank) and the owner CC are **never paged**, `dispatched_at` stays NULL, and the row is stamped `dispatch_failed` forever. The operator sees a permanently stuck row (dashboard has **zero** UI for this status); the owner sees no tow roll. Newest failure 2026-05-31 20:08, 4 in the last 24h — **actively recurring.**
**Evidence:** Live SQL: 120 rows `status='dispatch_failed'`, ALL `violation_type='overstay'`, ALL at Charlotte Travel Plaza, ALL `dispatch_attempts>=3`, ALL `last_dispatch_error ILIKE '%RateLimit%'`, ALL `sms_sent_at` set, ALL `dispatched_at` NULL, 0 resolved. Cron `plate_sessions_sweep` runs every minute → deployed `cron-sessions-sweep` fans out `dispatchPendingViolations()` (`.limit(50)` sequential `fetch()` loop) + `sweepPendingStandDowns()` (another `.limit(50)` loop) = ~100 nested invocations per tick, no throttle/delay/backoff (grep: setTimeout/sleep/429/RateLimit/Retry-After = 0). This trips the Supabase Edge **per-trace platform rate limiter** ("Rate limit exceeded for trace … Retry after …ms"). `failDispatch()` at `newCount>=3` sets `status='dispatch_failed'` AND `sms_sent_at=now()` as a sentinel — but the re-query filters on `sms_sent_at IS NULL AND dispatch_attempts<3`, so a capped row matches **neither** condition and is excluded forever. No retry/requeue job exists.
**Fix (NEEDS CARE — touches dispatch/enforcement):**
1. _Deploy first (stop new losses):_ throttle the fan-out to ~5-10 per tick across BOTH loops combined and/or add an inter-call delay; treat a `/rate limit/i` error distinctly — do **not** count it toward `MAX_DISPATCH_ATTEMPTS`; leave the row pending so the next tick retries. Switch the "not yet sent" signal from the overloaded `sms_sent_at` to the clean `dispatched_at IS NULL` column (verified NULL on all 120).
2. Surface `status='dispatch_failed'` as an operator "needs review" queue.
3. _Only after throttle lands:_ requeue in small batches — `UPDATE alpr_violations SET status='pending', dispatch_attempts=0, sms_sent_at=NULL, last_dispatch_error=NULL WHERE status='dispatch_failed' AND violation_type='overstay'`. Sanity-check these are genuine truck_plaza overstays (per Charlotte-outage memory, some Charlotte violations are phantom/suppressed) and confirm `DISPATCH_EMAILS_DISABLED` state before letting them page Frank.

---

#### C2. anon key can READ and WRITE all tenants' violations via `v_violation_billing_status` (RLS bypass)
**Subsystem:** Supabase DB / Data API / billing
**Who it hurts:** Anyone with the public anon key (shipped in the static SPA, effectively public) can read **every** violation across **all** tenants AND **write** billing-critical columns (`action_taken`, `tow_confirmed_at`, `billing_held_at`, `force_bill_at`, `left_before_tow_at`) on ANY violation. This corrupts the QuickBooks weekly invoicing run (which reads exactly this view at `routers/quickbooks.py:223`): an attacker can suppress all tow billing or fabricate a confirmed tow to invoice an innocent driver.
**Evidence (exploit reproduced live, in a rolled-back tx — no prod data changed):** `pg_class.reloptions` NULL (no `security_invoker`), owner=postgres → runs as definer, bypasses RLS. View def: `… FROM alpr_violations v;` — no owner/property filter. `anon` + `authenticated` hold SELECT/INSERT/UPDATE/DELETE on the view. READ: `SET LOCAL role anon; SELECT count(*) FROM v_violation_billing_status` = 241, while same role on base table = 0 (RLS). WRITE: anon `UPDATE … SET action_taken=…` → `ROW_COUNT=1`, propagated to `alpr_violations`. Base table RLS is enabled with 5 policies but all scoped to `{authenticated}` only — no anon policy, so the definer view is the bypass. Advisor lint 0010 ERROR (EXTERNAL).
**Fix (NEEDS CARE — security migration; verify QB cron + SPA after):** Ship as a recorded migration: (1) `ALTER VIEW public.v_violation_billing_status SET (security_invoker = true);` (closes reads — anon has no base-table policy); (2) `REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.v_violation_billing_status FROM anon, authenticated;` (the essential write-surface close — keep SELECT only where legitimately needed). The QB cron uses `service_role` (RLS-exempt, grants untouched); the dashboard only mirrors the CASE logic in JS and never queries the view — so this is **non-breaking for the frontend**. Re-run the anon read/write probes to confirm 0 rows / permission denied. _Related lints to sweep separately: `lot_stats` matview in API (L9), `current_owner_id`/`current_partner_id`/`is_platform_admin` anon-executable SECURITY DEFINER RPCs._

---

#### C3. GET `/violations/action` mutates on first fetch — email prefetchers/scanners silently auto-confirm tows
**Subsystem:** FastAPI backend (`routers/violations.py`) / tow-dispatch-email edge function / billing
**Who it hurts:** When a tow-dispatch email is delivered, the partner's mail client, link-preview bot, or corporate URL-security scanner fetches the one-click link(s) **before any human clicks**. That GET immediately stamps `action_taken`, `status='resolved'`, `resolved_at` with zero human interaction. Downstream this is billable: `v_violation_billing_status` maps `action_taken='tow'` (+ sighting) → `confirmed`, and the weekly QB cron bills confirmed rows — so a driver can be billed for a tow nobody confirmed. The email renders BOTH links as bare anchors, so a prefetcher hits both and whichever GET lands first wins (the other no-ops via the `if v.action_taken` guard) — outcome is effectively non-deterministic.
**Evidence (LIVE on 3 surfaces):** `routers/violations.py:180-193` — both `violation_action_get` and `violation_action_post` call the identical `_apply_action_token`, which at :169-175 unconditionally sets `action_taken/action_channel/action_at/status='resolved'/resolved_at` + `db.commit()`. No confirm-form branch; `_state_page` has only `<h1>` + "close this window", no `<form>`. This contradicts the file's own :41 header comment AND CLAUDE.md ("GET renders confirm form, defeats prefetchers"). Git shows a deliberate regression: commit `f0cfe4d` "collapse email-action into single GET, drop confirm form (#46)", present on `main` (Railway auto-deploys main, clean tree). Live probe: unauthenticated `GET /violations/action?token=bogus` → HTTP 200 LotView shell; `POST` with same token → byte-identical response (same handler). `/violations/action` is in `PUBLIC_PATHS` (:202). Deployed tow-dispatch-email v103 emits `towLink`/`noTowLink` as plain `<a href>` GET anchors. Currently latent ONLY because `DISPATCH_EMAILS_DISABLED` suppresses the Resend send (links still minted) — activates the instant dispatch resumes.
**Fix (NEEDS CARE — touches enforcement; backend-only, no edge redeploy):** Move ALL mutation (`action_taken/action_channel/action_at/status/resolved_at` + commit) into `violation_action_post` exclusively. On GET, decode+validate the token + already-resolved check, then render a branded confirm page using the existing `_html_page` shell with a `<form method="post" action="/violations/action">` carrying the token as a hidden field + submit button (the `_ACTION_VERB` labels already exist). The v103 email anchor can stay — it will now land on the confirm page. Add a regression test asserting a valid-token GET does NOT mutate and only the subsequent POST does. Restores the prefetcher defense the comment + spec already describe.

---

### HIGH

---

#### H1. Camera tow-arrival exit-correlation never runs for truck_plaza — 47 sightings recorded, 0 auto-confirmed
**Subsystem:** camera-snapshot / tow-confirm edge functions (Charlotte)
**Who it hurts:** When a partner tow truck actually tows a vehicle at Charlotte (the only live property, `truck_plaza`), the camera records a `partner_truck_sightings` row but the matching violation is **never** auto-stamped `tow_confirmed_at`. The confirmation/billing queue never auto-populates from camera evidence — confirmed tows + revenue-share are reconciled entirely by hand and genuinely-towed vehicles look unconfirmed. Live: 47 sightings since 2026-04-22 (still flowing), 89 dispatched violations, **0** ever auto-confirmed.
**Evidence:** Deployed `camera-snapshot/index.ts:251` `if (propertyType === "truck_plaza")` runs `handleTruckPlazaExit` and returns at :352 — **before** the legacy path. The only two `dispatchTowConfirm()` calls (:1273 entry, :1358 exit) are in the post-352 legacy path truck_plaza never reaches. Deployed `truck_plaza_exit.ts` tow branch (:649-664) only INSERTs the sighting and returns; its own comment claims "tow-confirm's correlator picks up the sighting" but no such correlator runs for this path. Deployed `tow-confirm`'s exit branch is the ONLY code that writes `tow_confirmed_at` + `matched_via='live'` + `consumed_by_violation_id`, and it's only invoked via the legacy `dispatchTowConfirm`. pg_cron has no job calling tow-confirm. Live SQL: sightings=47, `consumed_by_violation_id NOT NULL`=0, `tow_confirmed_at NOT NULL`=0, `matched_via='live'`=0.
**Fix (NEEDS CARE):** Fire tow-confirm **exit** correlation for the truck_plaza path. Do NOT fire `event_type='entry'` (the sighting is already inserted directly — entry would double-insert). Options: (a) on every truck_plaza plate read, fire `dispatchTowConfirm` fire-and-forget with `event_type='exit'` (Charlotte treats every read as exit), passing the plate_event_id — tow-confirm safely no-ops for non-matching plates and is INTERNAL_TOKEN-gated; the helper lives in `index.ts` so must be passed into / fired around `handleTruckPlazaExit`; or (b) add a cron POSTing recent unconsumed sightings to tow-confirm. Either clears the 47-sighting / 89-violation backlog. (A small fraction may still not auto-confirm: tow-confirm requires read confidence ≥ 0.65 + exact plate match in window — but today it's structurally 0%.)

---

#### H2. cron-no-reg-sweep is not scheduled — 304 no_registration violations stranded in `pending`
**Subsystem:** cron-no-reg-sweep edge function / pg_cron
**Who it hurts:** Unregistered-vehicle violations are created but never advance to operator-visible `flagged`, so the operator never sees them as actionable; and a driver who registers late is never auto-cleared. 304 rows (May 14-19), all past the 15-min grace, newest now 12 days old, sit invisible in `pending` limbo.
**Evidence:** `cron.job` has exactly two jobs (`plate_sessions_sweep`, `plate_pair_learn`); none POSTs to `cron-no-reg-sweep`; `cron.job_run_details` = 0 runs ever. Status dist: `pending`=304 (all past grace), `flagged`=0, `resolved_late`=0, `resolved_pre_flag`=6 (all stamped in one batch 2026-05-20 20:51 — a one-off manual backfill, not a schedule). Deployed `sweepViolations()` is the sole transition code and runs only under HTTP invocation. cron-sessions-sweep bundles the no-reg insert/update helpers but never calls `sweepViolations` (grep=0).
**Fix (SAFE-TO-FIX, but confirm pipeline intent first):** Add a 60s pg_cron job POSTing to `…/functions/v1/cron-no-reg-sweep` (mirroring the two existing jobs), or fold `sweepViolations()` into cron-sessions-sweep's per-tick handler (real code change — it bundles but never calls it). Then triage the 304: run `sweepViolations` once to flag/resolve, or bulk-dismiss. **Caveat:** rows stopped being created 2026-05-19 and this pipeline is SC211-camera-driven; per the SC211-apartment-move memory C4/OCR-gate go live at the new building — confirm with the team whether this stays live before standing the cron back up vs. cleaning up.

---

#### H3. QuickBooks weekly invoicing is not owner-scoped — an owner can draft invoices over other owners' properties
**Subsystem:** FastAPI backend (`routers/quickbooks.py`)
**Who it hurts:** An owner running invoicing can produce invoices covering properties they don't own — a tenant-isolation break in the billing path that violates the codebase's own owner-scoping contract.
**Evidence:** `run_weekly_invoicing` owner branch (:170-174) computes `owner_partner_ids` as `select(distinct(Property.tow_company_id)).where(tow_company_id IS NOT NULL)` with NO `owner_id == subject.id` filter — every partner. The per-partner row query (:210-242) filters only `WHERE p.tow_company_id = :partner_id`, never `p.owner_id`. Contrast `routers/violations.py:728-730` where billing overrides DO scope `WHERE id=:pid AND owner_id=:oid`. Live DB: 3 lot_owners, `properties.owner_id` exists. Only thing stopping it firing TODAY: the sole partner (NMLD) has `quickbooks_customer_id IS NULL`.
**Fix (NEEDS CARE — billing path + model change):** Scope the owner branch with `Property.owner_id == subject.id` and add `AND p.owner_id = :owner_id` to the raw row query; keep the service/cron path unrestricted. **Fix-detail correction:** the SQLAlchemy `Property` model (`models.py:295-304`) does NOT map `owner_id` even though the DB column exists — `Property.owner_id` will raise AttributeError as written. First add `owner_id = Column(UUID(as_uuid=True), ForeignKey("lot_owners.id"))` to the model, or scope via raw SQL.

---

#### H4. Exit-event retro-match trigger writes `status='completed'`, which the visitor_passes CHECK forbids — registration-killing landmine
**Subsystem:** Supabase DB triggers / registration
**Who it hurts:** A driver registers a pass and gets a silent 500 / failed registration — they believe they're registered but the INSERT rolled back, so they have no pass and **will be towed.** Trigger: a camera makes an `exit`-typed read of their plate, then within 30 min the same (or OCR-confusable) plate registers at that property. The AFTER-INSERT retro-match flips the prior exit read to `match_status='matched'`, firing the entry/exit trigger, which tries `status='completed'` — rejected by the CHECK — aborting the whole registration tx.
**Evidence:** Live `visitor_passes_status_check` = `CHECK (status IN ('active','expired','revoked','cancelled','towed'))` — no `completed`. Live `alpr_update_pass_entry_exit()` exit branch sets `status='completed'`. The retro UPDATE promotes plate_events to `matched` with WHERE `created_at > now()-'30 min'` + `plate_confusable_match()` and **no `event_type` filter** — so it can promote an `exit` row. Live: 70 `event_type='exit'` rows (69 unmatched, real cameras, latest 2026-05-01); `alpr_cameras` has `orientation='exit'` rows and the deployed camera-snapshot has reachable `event_type='exit'` inserts. Not firing yet only because the 69 exit rows are all weeks old (outside the 30-min window); fires on a fresh exit-read-then-register coincidence.
**Fix (NEEDS CARE — trigger logic; migration + deploy to live, files drift):** Lowest-risk: change the `'completed'` literal in `alpr_update_pass_entry_exit()` to a constraint-allowed value (e.g. `'expired'`) or set `exit_seen_at` only and leave status untouched (no row is `completed` today). Add `AND event_type='exit'` discipline to the retro-match exclusion so it can't promote an exit read into the completed path. If `completed` is genuinely wanted, instead add it to the CHECK and audit all consumers (dashboard filters, sweep crons). Apply as a timestamped migration AND deploy to live DB. (The retro trigger is also attached to parking_passes but no-ops via TG_TABLE_NAME guard.)

---

#### H5. Two retired north-gate cameras still `active=true` — operator sees 4 "Active" when only 2 are real; retired api_key resolves a live row
**Subsystem:** alpr_cameras DB / camera-snapshot / dashboard
**Who it hurts:** The operator's ALPR list shows four green "Active" cards (North Gate (E), North Lot (C), C4467 PTZ, TS4467) when only two are physically live — no way to tell the dead rows apart. Worse: if the decommissioned north device (or a re-imaged camera) POSTs with a retired api_key, camera-snapshot accepts it (`active=true` is the sole gate) and processes against the wrong row. Because retired "North Gate (E)" shares `gate_id='north'` with the live C4467 PTZ, its reads land in the same burst-dedup group, potentially corrupting which frame wins.
**Evidence:** Live `alpr_cameras`: "North Gate (E)" (`6863affc-…`, key `1cc31660025e`, `gate_id='north'`, active=TRUE, last event 2026-05-18 00:37) and "North Lot (C)" (`033bfdf7-…`, key `1cc31660025c`, active=TRUE, last event 2026-05-17 19:31) both went silent exactly when C4467 PTZ started 2026-05-19 (cutover). Deployed camera-snapshot resolves via `.eq("api_key",…).eq("active",true)` — active is the only gate. `truck_plaza_exit.ts` `groupKeyFor` returns `gate_id ?? id`. Dashboard badge is green for any `active=true`. (Minor: there is no `mac_address` column — self-ID is via Milesight devMac→api_key; the mechanism is a stale **api_key**, not a stored MAC. Verdict unchanged.)
**Fix (SAFE-TO-FIX-IMMEDIATELY):** `UPDATE alpr_cameras SET active=false WHERE id IN ('6863affc-f992-4524-8e24-8e641fefb8c4','033bfdf7-2a63-4171-bb08-620702d715c1');` Leaves exactly the 2 real cameras active, matching the camera-access reference.

---

#### H6. camera-snapshot never writes `alpr_cameras.last_seen_at` — no camera-health/staleness signal anywhere
**Subsystem:** camera-snapshot edge function / dashboard
**Who it hurts:** The operator's "Last seen: …" line (`dashboard.html:10238`) renders only when `last_seen_at` is truthy — so it **never appears for ANY camera**, including the 2 live ones. The only signal is the static `active` flag, which stays solid green on dead rows. A camera going dark (solar brownout, RUT down, re-aim) is invisible in dashboard and DB — exactly the blind spot behind the unnoticed Charlotte north outage.
**Evidence:** Live SQL: all 6 rows `last_seen_at`=NULL, including C4467 PTZ (64 events/24h) and TS4467 (153 events/24h). Deployed camera-snapshot's 13 `last_seen_at` references all target `no_registration_violations`/weak-read objects; the only `.from("alpr_cameras").update(...)` writes `usdot_active_until`, never `last_seen_at`.
**Fix (SAFE-TO-FIX, then a dashboard follow-up):** After a camera resolves, fire-and-forget `db.from('alpr_cameras').update({ last_seen_at: new Date().toISOString() }).eq('id', camera.id)` on every accepted POST (both branches). Then add a staleness badge in `dashboard.html` (>15min warning, >1h stale) and a "Never seen / no heartbeat" fallback so dead cameras stop showing green.

---

#### H7. `enforcement_partners_self_update` lets a logged-in partner overwrite their own payout fees + tow_truck_plates — LIVE, exploitable today
**Subsystem:** Supabase RLS / column grants
**Who it hurts:** A logged-in tow partner can inflate their own `tow_fee`/`boot_fee` (raising what LotLogic/owners owe them) and inject arbitrary `tow_truck_plates` (causing bogus auto-stand-downs of real violations). **Exploitable today**, not latent.
**Evidence (role-simulated UPDATE, rolled back — no prod data changed):** Policy `enforcement_partners_self_update`: UPDATE, `{authenticated}`, qual+with_check `(id = current_partner_id())`, NO column restriction. The prior "blocked because no table-wide UPDATE grant" premise is **false** — `column_privileges` shows `authenticated` holds column-level UPDATE on exactly `boot_fee, tow_fee, tow_truck_plates`, which is sufficient in Postgres. Proof: `SET role authenticated` + partner_id claim → `UPDATE … SET tow_fee=999999, tow_truck_plates=append('EVIL999')` succeeded (rows=1, readback confirmed); `SET revenue_share=0.99` BLOCKED (no grant). Anon UPDATE returned 0 rows (no anon policy — inert).
**Fix (SAFE-TO-FIX-IMMEDIATELY):** `REVOKE UPDATE (tow_fee, boot_fee, tow_truck_plates) ON public.enforcement_partners FROM authenticated;` then `GRANT UPDATE (contact_name, phone, email) ON public.enforcement_partners TO authenticated;` (policy can stay — it'll only bite safe columns). Or route partner profile edits through a service_role backend endpoint that whitelists columns. `tow_fee/boot_fee/revenue_share/lotlogic_tow_fee_cents/tow_truck_plates` must never be partner-settable. (`revenue_share`/`lotlogic_tow_fee_cents` are already safe.) Defense-in-depth: also revoke the inert anon write grants.

---

#### H8. `properties` cross-tenant read — `properties_anon_select` qual = `true`
**Subsystem:** Supabase RLS
**Who it hurts:** Anyone with the anon key can enumerate every property of every customer and read owner/partner/tow-company linkage, address, coordinates (and `monthly_fee`/`policy_phone` once populated). Single-tenant today; cross-tenant the moment a second owner onboards.
**Evidence (live anon-role read reproduced):** `properties_anon_select` on `public.properties`, roles `{anon}`, SELECT, qual=`true`. `SET LOCAL role anon` read returned the Charlotte row's `owner_id`, `partner_id`, `tow_company_id`, address, lat/lng. anon holds column-level SELECT on all 23 columns. Other policies are correctly scoped; this blanket policy is the open path. (anon INSERT/UPDATE grants exist but are blocked by scoped policies — not a write hole.)
**Fix (SAFE-TO-FIX, verify both QR forms after):** Drop the blanket `properties_anon_select`. Public consumers are only the QR forms, which fetch a tiny scoped projection by `qr_code_id` (resident.html: `id,name,address,property_type`; visit.html: + `policy_text,policy_phone`). Preferred: serve those via a restricted `properties_public` view granting anon SELECT only, revoke anon SELECT on the base table. Minimum: revoke anon column-level SELECT on `owner_id, partner_id, tow_company_id, monthly_fee, rules, lat, lng`. Re-test both forms with `SET LOCAL role anon`.

---

## 3. MEDIUM + LOW

### MEDIUM
- **M1 — Backend `/alpr/cron/overstay-tick` is a stale parallel overstay engine** _(merge of 3 findings)_. Keys on dead `entry_seen_at`/`exit_seen_at` columns (0/35 populated; live pipeline uses `exited_at`/`overstay_violation_id`), still has the pre-fix C2 `status='active'`-only bug, texts the DRIVER a `Reply TOW/BOOT/DISMISS` link (self-dismiss path; SMS channel retired), and writes `status='alerted'` which the CHECK rejects (23514). **Correction to original framing:** it IS scheduled — `.github/workflows/alpr-overstay-tick.yml` (cron `*/5`, last success 2026-05-31 19:56) POSTs to it every ~5 min. Harmless today only because the `entry_seen_at` gate + two faster soft-expire jobs (`pass_expiry.py` loop + cron-sessions-sweep) leave it nothing to match (`expired_active_total=0`). Fix: delete the endpoint + Twilio block (`routers/alpr.py:359-471`) AND delete the GH Actions workflow (else it 404s every 5 min); canonical engine is cron-sessions-sweep.
- **M2 — All `/quickbooks/pending-invoices` endpoints are cross-tenant.** Every owner-type JWT gets full read/edit/void/send/credit on EVERY partner's pending invoices (`routers/quickbooks.py` list/remove_line/discard/email/send/void/void_and_credit gate only on `subject.type=='owner'`, no ownership scope; `services/scope.py` never imported). Blast radius zero today (1 non-admin owner, 0 invoices) → rises to HIGH the instant a 2nd non-admin owner is onboarded. Fix: add `assert_pending_invoice_access` (EXISTS over `properties WHERE tow_company_id=pi.partner_id AND owner_id=subject.id`, or `is_unrestricted`) on every handler + the partner→owner filter on list.
- **M3 — Stand-down ("vehicle left") email fires for tows that were never dispatched.** Both stand-down gates key on the `sms_sent_at` sentinel instead of `dispatched_at` (a true send). `failDispatch()` stamps `sms_sent_at` without sending → a partner gets a phantom "STAND DOWN" for a tow never dispatched. **Already manifested once** (violation `37fb98f3-…`: dispatch_attempts=3, RateLimitError, `dispatched_at=NULL`, but `left_before_tow_email_sent_at` set). Fix: gate stand-down on `dispatched_at IS NOT NULL` in `truck_plaza_exit.ts` (both claim sites) and `cron-sessions-sweep sweepPendingStandDowns`; redeploy both.
- **M4 — `lot_stats` materialized view readable by anon/authenticated over Data API.** Leaks per-lot violation/boot/tow counts, LotLogic's own `our_revenue_30d_cents`, camera count + last heartbeat — matviews can't carry RLS. Latent (0 rows, 1 tenant). Fix: `REVOKE ALL ON public.lot_stats FROM anon, authenticated;` (they hold full `arwdDxtm`); serve stats via service_role or an owner-scoped security_invoker view.

### LOW
- **L1 — `overstayExpiry()` mislabels session overstays as `violation_type='alpr_unmatched'`** → dispatch email renders "Unregistered vehicle · no pass on file" instead of "Active overstay", and the body shows the real expired pass — internally contradictory. Dormant (session path 100% closed_clean). Fix: thread a `violationType` param through `createViolationAndDispatch`.
- **L2 — `notifyOwnerOfTruckArrival` in tow-confirm falls back to unauthenticated `noreply@lotlogic.com`** (DKIM/SPF-failing) when `FROM_EMAIL` unset, while tow-dispatch-email uses `dispatch@lotlogicparking.com`. Path is live (camera-snapshot v210 fires entry). Fix: one-line fallback change + redeploy tow-confirm.
- **L3 — Backend `/alpr/ingest` matcher is front-plate-only** — ignores `normalized_back_plate` + verified-pair synonyms, diverging from camera-snapshot v210 and registration. Zero prod traffic (0/5182 events in 30d). Fix: expand `_find_candidates` via `synonym_set` + back-plate + align normalizer.
- **L4 — reCAPTCHA fails OPEN when `RECAPTCHA_SECRET_KEY` unset**, no prod guard — both public QR register endpoints bypass bot protection. Secret is set today (verified live). Fix: fail closed in prod + boot-time assertion.
- **L5 — SMS overstay resolution matches `alpr_violations` by UUID-prefix LIKE + LIMIT 1, no ORDER BY** (`routers/violations.py:528-537`) — nondeterministic on short/colliding prefixes; bounded by phone-on-pass auth (no cross-tenant). 0 collisions live. Fix: require full 12-char prefix, exact equality, fetch ≤2 + error on ambiguity (mirror the legacy path right below).
- **L6 — Dead cooldown-rejection branch in `visit.html` truck-plaza submit** — backend no longer returns the 409 (trigger is no-op per 2026-05-31 allow+flag policy). Fix: remove `cooldownMatch` block (`visit.html:~679-692`), fall through to `friendlyErrorMessage`.
- **L7 — Truck-plaza property detail renders a dead "Long-term pass" (/perm) QR tile** — resident.html short-circuits to a dead-end for truck_plaza. Reachable (Charlotte). Fix: gate the second tile behind `!isTruckPlaza` (`dashboard.html:10049-10057`; `isTruckPlaza` already in scope at :9598).
- **L8 — `computeBillingStatus` JS adds a `cooldown_breach` branch the live view lacks**, contradicting its "byte-for-byte mirror" comment. Doc-only. Fix: correct the comment (`dashboard.html:6479-6482`).
- **L9 — parking_passes cutover is stalled split-brain** — live writes go only to visitor_passes; parking_passes frozen (58 stale rows since 2026-05-14) with a deliberate no-op retro trigger that would FK-misbehave if used. Latent. Fix: finish cutover against `plate_events.parking_pass_id`, or formally park (disable triggers + table COMMENT). _Related:_ 20 parking_passes stuck `active` past expiry with no sweep/consumer — clean up + extend sweep before any cutover.
- **L10 — Tow-truck plate match at truck-plaza is exact-normalized only** — OCR drift on a moving truck drops the sighting. Deliberate safety tradeoff (fuzzy must not auto-cancel a real violation). Fix: keep exact for auto-action; additionally record edit-distance-1 near-misses as low-confidence flagged sightings for operator review.
- **L11 — Redundant duplicate index `idx_alpr_cameras_api_key`** duplicates the unique-constraint index. Pure write-amplification (6 rows). Fix: `DROP INDEX public.idx_alpr_cameras_api_key;` (planner falls back to the equivalent unique index).

---

## 4. CROSS-CUTTING THEMES

1. **`sms_sent_at` overloaded as a dispatch sentinel** — the single worst structural root cause. It conflates "real email sent" with "cron gave up," driving BOTH C1 (capped rows excluded from requeue forever) AND M3 (phantom stand-downs). The clean `dispatched_at` column already exists (NULL on all 120 failures, set on 89 real sends). **Migrate all dispatch-state logic to `dispatch_failed`/`dispatched_at` and stop using `sms_sent_at` as a queue flag.**

2. **anon/authenticated Data-API over-exposure (SECURITY DEFINER + qual=true + stray column grants)** — C2, H7, H8, M2, M4 are all the same disease: RLS is enabled and policies are written, but it's bypassed via definer views (`v_violation_billing_status`, `lot_stats`), an unscoped `qual=true` policy (`properties`), missing column-grant audits (`enforcement_partners`), or app-layer scoping that was simply never added (`quickbooks.py`). **Run one consolidated security sweep:** `security_invoker` on all public views, REVOKE stray DML grants, audit `column_privileges` (not just `role_table_grants` — that's the audit gap that hid H7), and adopt `services/scope.py` everywhere in `quickbooks.py`. Note the related anon-executable RPCs (`current_owner_id`, `is_platform_admin`).

3. **GET endpoints that mutate / prefetch-unsafe links** — C3: the split-GET/POST defense the comments + CLAUDE.md describe was deliberately removed (commit f0cfe4d). Spec drift from code.

4. **Two-matchers / two-engines diverging** — the live engine vs. a dead backend twin: camera-snapshot v210 (back-plate + verified pairs) vs. `plate_matcher.py` (front-only, L3); cron-sessions-sweep overstay (keys on `exited_at`) vs. backend `overstay_tick` (keys on dead `entry/exit_seen_at`, M1). The dead twins carry stale bugs (C2 status='active', retired Twilio, invalid `status='alerted'`) that would re-fire if reactivated.

5. **Exits-not-recorded / camera-health cascade** — H1 (sightings recorded but never correlated → 0 auto-confirmed tows), H6 (last_seen_at never written → no health signal), H5 (dead cameras show green) all stem from the camera-ingest path recording data without closing the loop. The Charlotte north outage went unnoticed precisely because of H5+H6.

6. **Code/comment/migration ↔ live DB & deployed-function drift** — recurring: CHECK constraints in migration files vs. live (H4 `completed`, M1 `alerted`), comments claiming behavior the code lacks (C3, H1's "correlator picks up the sighting", L8 "byte-for-byte"), and the SQLAlchemy model missing a live column (H3 `owner_id`). **Always verify against live, as this audit did.**

7. **truck_plaza is a special-cased early-return path that legacy logic silently skips** — H1 (tow-confirm), and the latent L1/L9 split-brain all trace to truck_plaza returning at `index.ts:352` before the legacy/session path. New cross-cutting features must be wired into the truck_plaza branch explicitly.

---

## 5. RECOMMENDED FIX ORDER

**Phase 0 — One-line / zero-risk, ship immediately (no enforcement/dispatch path touched):**
1. **H5** — `UPDATE alpr_cameras SET active=false` for the 2 retired north rows. _(SQL, instant operator clarity.)_
2. **H7** — `REVOKE UPDATE (tow_fee, boot_fee, tow_truck_plates) … FROM authenticated` + grant safe columns. _(Live-exploitable; SQL.)_
3. **L11** — `DROP INDEX idx_alpr_cameras_api_key`. _(Trivial.)_
4. **L6 / L7 / L8** — frontend dead-code / dead-tile / comment fixes. _(Static, auto-deploy from main.)_

**Phase 1 — Security sweep (DB migration, low app-risk; verify QB cron + QR forms after):**
5. **C2** — `security_invoker=true` + REVOKE DML on `v_violation_billing_status`. _(Verified non-breaking for SPA; QB uses service_role.)_
6. **M4** — REVOKE ALL on `lot_stats`.
7. **H8** — drop `properties_anon_select`, serve QR fields via scoped view (re-test both forms).
8. **L4** — reCAPTCHA fail-closed-in-prod guard.

**Phase 2 — Camera-health + exit-correlation loop (edge-function deploys, moderate risk):**
9. **H6** — write `last_seen_at` on every accepted POST (+ dashboard staleness badge follow-up).
10. **H1** — fire tow-confirm exit-correlation for truck_plaza; clear the 47/89 backlog. _(NEEDS CARE — touches dispatch evidence; verify confidence/match gating.)_

**Phase 3 — Dispatch reliability (NEEDS CARE — enforcement/dispatch + driver billing; review before each):**
11. **C1** — throttle the fan-out + rate-limit-aware retry + `dispatched_at`-based queue + operator `dispatch_failed` surface. _Deploy throttle first._
12. **M3** — gate stand-down on `dispatched_at IS NOT NULL` (rides on the same `dispatched_at` migration as C1; redeploy camera-snapshot + cron-sessions-sweep). _(Do C1+M3 together — same root cause.)_
13. **C1 step 3** — requeue the 120 dropped overstays in small batches, **only after** the throttle + suppression checks land.
14. **C3** — split GET/POST so GET renders a confirm form, mutation POST-only. _(Backend-only; do before re-enabling dispatch, since C3 + C1/M3 all converge the instant `DISPATCH_EMAILS_DISABLED` is cleared.)_

**Phase 4 — Tenant-scoping (NEEDS CARE — billing; before any 2nd non-admin owner / QB-linked partner):**
15. **H3** — owner-scope `run_weekly_invoicing` (add `owner_id` to the `Property` model first).
16. **M2** — scope all `/quickbooks/pending-invoices` handlers via `services/scope.py`.

**Phase 5 — Trigger landmine + dead-code cleanup (NEEDS CARE for H4 trigger; rest low):**
17. **H4** — fix `completed` literal + add `event_type='exit'` discipline to the retro-match. _(Migration + deploy to live; the registration-killer — do not defer indefinitely since exit-oriented cameras are live.)_
18. **H2** — schedule cron-no-reg-sweep (or fold into sessions-sweep) + triage 304 rows — _after_ confirming the SC211 pipeline stays live.
19. **M1** — delete `overstay_tick` endpoint + the `alpr-overstay-tick.yml` GH Actions workflow.
20. **L1, L2, L3, L5, L9, L10** — remaining latent/dormant cleanups, batched as convenient.

_Rationale for ordering: Phase 0-1 are pure-SQL/static wins that immediately close live security holes (H7, C2) and operator confusion (H5) with no enforcement risk. Phases 3-4 are deferred to when the owner can review because they directly touch dispatch, billing, and driver-facing money. C3 is sequenced just before dispatch re-enablement because it (and C1/M3) all activate together the moment `DISPATCH_EMAILS_DISABLED` is cleared._