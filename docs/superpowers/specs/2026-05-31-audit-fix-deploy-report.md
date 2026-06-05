I'll consolidate this into a deploy-ready report. The verdicts contain some duplicate coverage (multiple agents verified the same fixes), so I'll deduplicate and present a single authoritative line per fix, grouped by the audit's fix-order.

---

# LotLogic Audit Fixes — Deploy-Ready Report

**Date:** 2026-05-30 · **Dispatch stays PAUSED** (`DISPATCH_EMAILS_DISABLED`) throughout — nothing here un-pauses it.

There are **5 deliverable artifacts**:
1. DB migrations (4 files) — branch `audit-fix/db-migrations` @ `6a7b6c5`
2. Edge functions (3) — branch `audit-fix/edge-functions` @ `4f102ac`
3. Backend code — branch `audit-fix/backend` (worktree) @ `de55b1a` (also referred to as `audit-fix/backend-code` @ `632de82`)
4. Frontend — branch `audit-fix/frontend` (worktree `/Users/gabe/lotlogic-wt-frontend`) @ `1054220`
5. Frontend workflow deletion — branch `audit-fix/m1-overstay-workflow` (worktree `/Users/gabe/lotlogic-wt-m1`) @ `0e38bb8`

---

## TL;DR — what's SAFE to ship vs needs your eyes

**SAFE to ship now (no owner decision, no behavior risk):**
- M4 (revoke lot_stats), enforcement_partners anon-DML revoke — pure revokes, zero app references
- L5, L6, L7, L8 — deterministic SMS match + dead-code/UI cleanups
- H6, C1-ui — read-only dashboard surfaces

**Ship now but RE-TEST after (load-bearing public path):**
- H8 (properties anon scoping) — **re-test both QR forms** (`visit.html`, `resident.html`) as anon after applying
- H4 (visitor_passes landmine) — fixes a registration-killer; apply in correct migration order (below)
- C3 (GET no longer mutates) — touches the tow-confirm/billing email path; run the prefetch regression test in CI first

**Needs OWNER eyes / decision:**
- **H3, M2** (QuickBooks owner-scoping) — billing scope; blast radius zero today but **verify against a 2nd owner** before relying on it
- **M1** — coordinated cross-repo deletion (backend endpoint + frontend workflow must land together)
- **L4 (reCAPTCHA fail-open)** — **DECISION REQUIRED**, see below. One agent left it unimplemented; another implemented it on `audit-fix/backend`. Reconcile before deploy.
- **H7** — intentionally deferred; **do not touch** until owner product decision
- **L3** — deferred dead-code; no action

---

## GROUP 1 — DB migrations (branch `audit-fix/db-migrations` @ `6a7b6c5`)

Apply all via **Supabase MCP `apply_migration`** (records `schema_migrations`). Branch contains exactly these 4 files (355 insertions, nothing else); not pushed to origin.

| Fix | Status | Risk | Apply |
|---|---|---|---|
| **M4** revoke `lot_stats` from anon/authenticated | ✅ ready | none | `migrations/20260531210500_m4_revoke_lot_stats_from_anon_authenticated.sql` — `REVOKE ALL ON public.lot_stats FROM anon, authenticated;` |
| **enforcement_partners** revoke inert anon DML (defense-in-depth) | ✅ ready | none | `migrations/20260531210800_enforcement_partners_revoke_inert_anon_dml.sql` — `REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES ON public.enforcement_partners FROM anon;` |
| **H8** properties anon cross-tenant read scoped | ✅ ready | **low/medium** | `migrations/20260531210600_h8_properties_public_view_scope_anon.sql` |
| **H4** visitor_passes `completed` registration-killer + retro exit-discipline | ✅ ready | **low/medium** | `migrations/20260531210700_h4_visitor_pass_completed_landmine_and_exit_discipline.sql` |

**M4** — Decision: none. Idempotent. Note: one agent saw live grants as `arwdDxtm` (full), another read NULL — either way the REVOKE is harmless (no-op if already revoked). Zero app references to `lot_stats`. `service_role` retained. **SAFE now.**

**enforcement_partners** — Decision: none. Anon writes already inert (no anon write policy); this is belt-and-suspenders on payout-critical fee columns. **Correctly leaves H7 (`enforcement_partners_self_update`, authenticated fee grants) untouched** per deferral. anon SELECT retained (governed by closed scoped_select). **SAFE now.**

**H8** — **Re-test required.** Builds a scoped `security_invoker` view `properties_public` (7 cols: id, name, address, property_type, policy_text, policy_phone, qr_code_id), then REVOKEs anon SELECT on the base table and re-GRANTs anon column-SELECT on only those 7. Verified the 7 cover both live QR forms exactly (`resident.html` reads id/name/address/property_type; `visit.html` adds policy_text/policy_phone; both filter by qr_code_id). **After applying, load a real QR link for both `visit.html` AND `resident.html` as anon and confirm name/address/policy render.**
- **Residual (documented, accepted):** anon can still enumerate the 7 non-sensitive public columns cross-tenant until a follow-up frontend PR repoints `/properties` fetches to `properties_public`, then `DROP POLICY properties_anon_select` + full `REVOKE`. That's the H8 *correction* (scoped view preserves QR forms) chosen over the naive drop that would 403 the forms.
- Minor cleanup: in-file part-(1) header comment says "security_invoker-free" but SQL correctly uses `security_invoker=true` — harmless comment typo.

**H4** — Fixes a **silent registration 500** (an exit-camera read of a driver's plate within 30 min would write `status='completed'`, which the live CHECK forbids, aborting the registration tx → driver left pass-less and tow-able). Fix A: exit branch writes `exit_seen_at` only, no status. Fix B: retro-match adds `AND event_type <> 'exit'`. The migration's retro-match body was diffed byte-for-byte against the live drift-tolerant function — identical except that one clause + comments (does NOT clobber deployed OCR-drift logic). No reader of a `'completed'` pass status exists (grep=0). `exit_seen_at` is preserved (consumed by dashboard "Exited" + `routers/alpr.py`).
- **APPLY ORDER (verified):** H4 (`20260531210700`) must be the **final** state of the retro-match function. If the pending/uncommitted `20260530221756_retroactive_match_ocr_drift_tolerant.sql` is ever (re)applied, apply it **first**, then H4. If `20260530221756` is only-ever-live (already deployed, never re-applied), H4 can go standalone. H4 relies only on `plate_confusable_match` (already live), so it's safe either way.

---

## GROUP 2 — Edge functions (branch `audit-fix/edge-functions` @ `4f102ac`)

Baselines confirmed **byte-identical to deployed prod** (re-baselined off prod, not main, because main had drifted behind prod — a naive branch off main would have reverted live C2/C4 fixes). `deno check` clean for all three.

**Status: ✅ ready · Risk: low · Covers C1 (queue/throttle), M3 (stand-down gate), H1 (tow-confirm wiring), H6 (last_seen_at writer), L1, L2.**

**Deploy (human step, dispatch stays paused):**
```
supabase functions deploy cron-sessions-sweep camera-snapshot tow-confirm
```

Key verified facts:
- `dispatched_at` is a sound real-send signal (deployed `tow-dispatch-email` v103 sets it only on atomic Resend claim, reverts on failure). C1's queue switch (`dispatched_at IS NULL` + status) and M3's stand-down gate (`dispatched_at IS NOT NULL`) are strictly more correct than the old `sms_sent_at` sentinel.
- H1: `tow-confirm` exit branch correlates plate→violation→in-window sighting and **no-ops on non-match** (cannot mis-confirm); entry intentionally not fired (avoids double-insert).
- Dispatch-while-paused safe: throttle/queue/heartbeat changes don't touch `DISPATCH_EMAILS_DISABLED`; sends still suppress in `sendViaResend`.

**Residual / human follow-up — C1 step-3 requeue (do AFTER throttle is live + suppression confirmed):** 120 stranded `dispatch_failed` rows. Sanity-check they are genuine truck_plaza overstays, then in small batches:
```sql
UPDATE alpr_violations
SET status='pending', dispatch_attempts=0, sms_sent_at=NULL, last_dispatch_error=NULL
WHERE status='dispatch_failed' AND violation_type='overstay';
```
- Smaller residual: weak-buffer flushGroup exit path still doesn't fire tow-confirm (only matters if SC211 buffering returns).
- **H6 pairing:** the edge-function H6 fix begins WRITING `last_seen_at`. Deploy it in tandem with the frontend H6 badge (Group 4) or every active camera shows "No heartbeat".

---

## GROUP 3 — Backend code (branch `audit-fix/backend` @ `de55b1a`, worktree `/Users/gabe/lotlogic-backend-audit-backend`)

Backend-only — **Railway auto-deploys on merge to main.** No migration, no edge redeploy. (Note: `632de82` / `audit-fix/backend-code` is a parallel reference to the same change set; both agents verified identical fixes. Use `de55b1a` / `audit-fix/backend` — it carries the regression test and the reconciled L4.)

| Fix | Status | Risk | Notes |
|---|---|---|---|
| **C3** GET `/violations/action` no longer mutates | ✅ ready | low | Mutation now ONLY in POST handler; GET renders branded `<form method=post>` confirm page (defeats mail-scanner/prefetch auto-confirm of a tow). v103 email anchor lands on confirm page — no email redeploy. **3/3 regression tests pass** (`tests/test_violation_action_prefetch.py`). py_compile clean. Safe while paused and when un-paused. → **Run the prefetch test in CI first.** |
| **H3** QB `run_weekly_invoicing` owner-scoped | ✅ ready | **medium** | `models.py` now maps `Property.owner_id` (column existed in live DB, was unmapped → prior AttributeError was real). Owner branch filters `Property.owner_id==subject.id`; cron/service passes `owner_id=None` → `CAST(NULL AS uuid) IS NULL` → unrestricted, so Monday QB cron is NOT broken. Blast radius zero today (sole partner NMLD has no QB customer id). → **Verify against a 2nd owner before relying on it.** |
| **M2** `/quickbooks/pending-invoices` endpoints owner-scoped | ✅ ready | **medium** | All 7 handlers route through `_load_scoped_pending_invoice` (404 on cross-tenant; `is_unrestricted` = service OR platform-admin bypass). `list` filters to owner's partner ids. Blast radius zero today (1 owner, 0 invoices), rises with a 2nd owner. |
| **M1** delete dead `/alpr/cron/overstay-tick` endpoint | ⚠️ **needs-decision** | low | Backend deletion correct (~111 lines, no dangling refs). **Cross-repo coordination required** — see below. |
| **L5** SMS overstay match → full 12-char exact prefix | ✅ ready | none | Now requires `len==12`, exact `substring(...for 12)=` equality, refuses on ambiguity. Nondeterminism removed. (Harmless pre-existing dead `'alerted'/'acknowledged'` values in the IN clause — never match the live CHECK; optional later cleanup.) |
| **L4** reCAPTCHA fail-closed in prod | ⚠️ **DECISION — see below** | low/medium | Conflicting verdicts across agents. |

### M1 — coordinated cross-repo deletion (decision)
The dead endpoint keys on dead `entry_seen_at`/`exit_seen_at`, texts the DRIVER a retired SMS reply, and writes `status='alerted'` which the live CHECK rejects (every tick would 23514). Canonical engine is `cron-sessions-sweep`. The `*/5` GitHub Actions workflow that POSTs to it lives in the **FRONTEND repo** and will 404 every 5 min once the endpoint is gone.
- **Backend deletion:** `audit-fix/backend` @ `de55b1a`.
- **Workflow deletion:** frontend branch `audit-fix/m1-overstay-workflow` @ `0e38bb8` (worktree `/Users/gabe/lotlogic-wt-m1`), file `.github/workflows/alpr-overstay-tick.yml`.
- **Action: MERGE BOTH TOGETHER** (workflow deletion at/before backend deploy) so the cron stops before its target disappears, or accept transient 404s. Cleanup worktree after: `git worktree remove /Users/gabe/lotlogic-wt-m1`.
  *(Note: an earlier verdict references this same workflow deletion as branch `audit-fix/drop-overstay-tick-workflow` @ `82f6672`. There are two candidate frontend branches for the same one-line deletion — pick ONE; `audit-fix/m1-overstay-workflow` @ `0e38bb8` is the most recently confirmed.)*

### L4 — reCAPTCHA fail-open ⚠️ DECISION REQUIRED
**The two agents disagree — reconcile before deploy:**
- One agent left L4 **unimplemented** (`needs-decision`), citing the audit mandate "stay out of the reCAPTCHA/auth/RLS layer" and the risk that a wrong prod-detection signal hard-blocks all public QR registration.
- The other agent verified L4 **as implemented on `audit-fix/backend`**: `services/recaptcha.py` fails CLOSED (returns False) when `RECAPTCHA_SECRET_KEY` unset and `settings.debug` is False; fails open only under `DEBUG=true`; `assert_recaptcha_configured()` raises at startup in prod. Secret is set in prod today → behavior unchanged now; this is forward defense.

**Your call:**
- If you accept the implemented version: merging `audit-fix/backend` ships it. **Guard condition: `RECAPTCHA_SECRET_KEY` must stay set on Railway prod** (it is today) or the app refuses to boot — that is the intended guard. The prod-detection signal chosen is `settings.debug == False`; confirm that's reliable in your Railway env before merge.
- If you want to defer (honor the "stay out of auth layer" mandate): pull the L4 commit out of `audit-fix/backend` before merging the rest.

**L3** (backend `/alpr/ingest` front-plate-only matcher) — **incomplete, deliberately deferred.** Dead path (0/5182 events in 30d; live pipeline is camera-snapshot). No action. Recorded so it isn't lost.

---

## GROUP 4 — Frontend (branch `audit-fix/frontend` @ `1054220`, worktree `/Users/gabe/lotlogic-wt-frontend`)

**Vercel auto-deploys on merge to main.** All JSX/node-check clean. All **SAFE now** (read-only / cleanup), but H6 must pair with the edge-function H6 writer.

| Fix | Status | Risk | Notes |
|---|---|---|---|
| **H6** camera heartbeat-age badge | ✅ ready | low | dashboard.html shows Active/Delayed/Stale/No-heartbeat from `alpr_cameras.last_seen_at`. **Deploy edge-function H6 writer in tandem** or every active camera reads "No heartbeat" (last_seen_at is NULL on all 6 cameras today). |
| **C1-ui** owner-only read-only "Stuck Tows" section | ✅ ready | low | Surfaces the 120 `dispatch_failed` rows. Read-only, no auto-action, no un-pause. This is the operator SURFACE only — C1-core (throttle/requeue) is the edge-function group. |
| **L6** remove dead 409 cooldown parse in `visit.html` | ✅ ready | none | Backend cooldown is a no-op `RETURN NEW` (allow+flag policy); 409 never returns. Legit pre-flight `data.held` advisory preserved. |
| **L7** hide `/perm` QR tile on truck plaza | ✅ ready | none | `/perm` form dead-ends on truck plaza; apartment behavior unchanged. |
| **L8** doc-only comment fix in `computeBillingStatus` | ✅ ready | none | Comment now matches live view (no cooldown branch). No behavior change. |

---

## Recommended deploy sequence

1. **DB migrations** (Group 1) via `apply_migration`, in order: M4 → enforcement_partners → H8 → H4 (H4 last; respect the `20260530221756`-then-H4 ordering if that pending migration is ever applied). **Re-test both QR forms after H8.**
2. **Edge functions** (Group 2): `supabase functions deploy cron-sessions-sweep camera-snapshot tow-confirm`. Dispatch stays paused.
3. **Frontend** (Group 4): merge `audit-fix/frontend` → Vercel. H6 badge now reads correctly (edge writer is live from step 2).
4. **Backend** (Group 3): resolve L4 decision, run prefetch test in CI, merge `audit-fix/backend` → Railway. **Merge the M1 frontend workflow-deletion branch in the same window.**
5. **C1 step-3 requeue** of the 120 stranded rows — only AFTER throttle is live and suppression confirmed; small batches.
6. **Owner follow-ups:** verify H3/M2 against a 2nd owner; H8 frontend repoint to `properties_public` for full lockdown; H7 awaits product decision.

**Untouched throughout:** `DISPATCH_EMAILS_DISABLED` (dispatch stays paused), H7 (`enforcement_partners_self_update`), and the WIP in the other group's working tree (`routers/visitor_passes.py`, untracked `20260530221756_*.sql`).