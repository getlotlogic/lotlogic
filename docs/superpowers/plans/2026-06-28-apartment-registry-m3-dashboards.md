# Apartment Permit Registry — Milestone 3 (Dashboards + Driver Lookup + Feedback) Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the apartment registry operator-usable: the leasing office and N Style log in and see a **pending approval queue** + **resident/guest lists** with approve/reject/extend/void and document viewing; N Style gets a fast **in-lot plate-lookup**; both portals get a **bug/feature feedback** control. Closes the register→approve→manage→patrol loop.

**Architecture:** Backend list + lookup + control + feedback endpoints (owner/partner scoped, reusing `_assert_property_scope`); the leasing/N Style management UI lives in the existing `frontend/dashboard.html` SPA as an **apartment property-detail view** (reusing the truck-plaza property-detail + parking-log patterns); the N Style driver lookup is a separate **lightweight mobile page** `frontend/lookup.html`. M2's approve/reject endpoints + the doc proxy are reused as-is.

**Tech Stack:** FastAPI (pytest), Supabase RLS (M1), single-file `dashboard.html` (React+Babel) + a small `lookup.html`, R2 doc proxy (M2).

**Repos:** backend `~/lotlogic-backend`; frontend `~/lotlogic`; both on branch `feat/apartment-permit-registry`. Migrations via Supabase MCP + committed. Pushes gated. Emails: NOT in scope for M3 (the M2 framework stays dormant; do not add email work).

**Spec:** `~/lotlogic/docs/superpowers/specs/2026-06-27-apartment-permit-registry-design.md`

## Key facts
- Resident active = `resident_plates.status='approved'`; guest active = `visitor_passes.status='active'` (72h window). Statuses also: `pending`, `rejected`, `void`.
- Scope: leasing owner via `owner_id`, N Style via `partner_id`(=`tow_company_id`). Reuse `routers/visitor_passes.py::_assert_property_scope(..., allow_partner=True)`.
- Approve/reject already exist: `POST /apartment/passes/{kind}/{id}/{approve|reject}` (M2-T4). Doc proxy: `GET /apartment/docs/{kind}/{id}/{which}` (M2-T5).
- Dashboard auth + property-detail + parking-log render patterns already exist for truck_plaza in `frontend/dashboard.html` — branch on `property_type==='apartment'`.

## File Structure
- `lotlogic-backend/routers/apartment_passes.py` — add list, extend, void endpoints (T1, T2) + lookup (T3)
- `lotlogic-backend/tests/test_apartment_management.py` — list/extend/void/lookup tests (T1–T3)
- `lotlogic/frontend/dashboard.html` — apartment property-detail view (T4) + feedback control (T5)
- `lotlogic/frontend/lookup.html` — N Style in-lot plate lookup page (T3)
- `lotlogic-backend/routers/apartment_docs.py` or a small `apartment_feedback` route — feedback POST (T5)

---

## Task 1: Apartment permits list endpoint

**Files:** Modify `routers/apartment_passes.py`; Test `tests/test_apartment_management.py`.

**Contract:** `GET /apartment/permits?property_id=<uuid>&status=<optional>` — `require_subject` + `_assert_property_scope(..., allow_partner=True)`. Returns `{ residents: [...], guests: [...] }` for the property. Each resident: id, plate_text, unit_number, holder_name, status, phone, email, has_id/has_lease/has_plate (booleans = key columns non-null), created_at, reviewed_at. Each guest: id, plate_text, host_unit, visitor_name, status, valid_from, valid_until, phone, email, has_id/has_plate, created_at, reviewed_at. Optional `status` filter (e.g. `pending`). Two `build_*_list_sql()` helpers (pytest-able as strings, like the cooldown helpers).

- [ ] **Step 1 (test):** `test_build_resident_list_sql_selects_status_and_doc_flags` + `test_build_guest_list_sql` — assert the SQL selects status, unit/host_unit, and computes the has_* booleans (`(id_doc_url is not null) as has_id`), filters by property_id + optional status. `test_permits_requires_scope` — cross-tenant subject → 404 (stub `_assert_property_scope`).
- [ ] **Step 2:** run → fail.
- [ ] **Step 3:** implement the two SQL builders + the `GET /apartment/permits` route (scoped). Register if needed (router already in main.py).
- [ ] **Step 4:** tests pass; ruff+py_compile clean; full suite (note pre-existing `routers.snapshots`/PIL).
- [ ] **Step 5:** commit `feat: apartment permits list endpoint (residents+guests, status, doc flags, scoped)`.

---

## Task 2: Extend + void endpoints

**Files:** Modify `routers/apartment_passes.py`; Test `tests/test_apartment_management.py`.

**Contract (scoped like approve):**
- `POST /apartment/passes/guest/{id}/extend` body `{hours:int 1..72}` — only for a guest currently `active`; set `valid_until = valid_until + (hours)` (or `now()+hours` if already expired — choose extend-from-now; document it). 404/409 rules like approve. Stamp `reviewed_by/at`.
- `POST /apartment/passes/{kind}/{id}/void` (`kind`=resident|guest) — set `status='void'`, stamp reviewer. Allowed from any non-void state (it's an operator override — "complete control"). 
- Both deferred-notify via the existing hook is NOT required (emails out of scope M3) — skip notifications here.

- [ ] **Step 1 (test):** `test_extend_guest_adds_hours` (active guest valid_until grows by N hours), `test_extend_caps_or_rejects_over_72` (decide + assert), `test_extend_non_active_409`, `test_void_resident_sets_void`, `test_void_guest_sets_void`, `test_void_cross_tenant_404`.
- [ ] **Step 2:** run → fail.
- [ ] **Step 3:** implement both routes (reuse the M2-T4 resolve+scope+pending-guard scaffolding; for void the guard is "not already void").
- [ ] **Step 4:** tests pass; ruff+py_compile; full suite.
- [ ] **Step 5:** commit `feat: apartment guest extend + pass void (owner/partner scoped)`.

---

## Task 3: N Style in-lot plate lookup (endpoint + page)

**Files:** Modify `routers/apartment_passes.py` (lookup endpoint); Create `lotlogic/frontend/lookup.html`; Test `tests/test_apartment_management.py`.

**Backend contract:** `GET /apartment/lookup?property_id=<uuid>&plate=<raw>` — `require_subject` + `_assert_property_scope(..., allow_partner=True)`. Normalizes the plate (reuse `_normalize_plate`), looks across resident_plates (status='approved') + visitor_passes (status='active', valid_until>now) for the property. Returns `{ verdict: 'resident'|'guest'|'expired_guest'|'not_registered', detail: {...unit/time_left/plate...} }`. A guest whose window passed → `expired_guest` (so the driver knows it WAS registered but lapsed). Plate match is exact on normalized; also check `back_plate`/normalized variants if present.

**Frontend:** `lookup.html` — minimal mobile page behind the partner login (reuse dashboard's auth/token in localStorage, or a simple token gate). One big plate input + property selector (N Style's patrolled properties), a "Check" button → calls the endpoint → shows a large green ✓ Permitted (resident · unit / guest · Xh left) or red ✗ Not registered / amber Expired guest. Built for speed/glanceability in the lot.

- [ ] **Step 1 (test):** `test_build_lookup_sql_matches_active_only` (resident approved + guest active+unexpired), `test_lookup_verdict_not_registered`, `test_lookup_verdict_expired_guest` (a guest past valid_until → expired_guest), `test_lookup_requires_scope` (cross-tenant 404). Stub session.
- [ ] **Step 2:** run → fail.
- [ ] **Step 3:** implement the lookup endpoint + `lookup.html`. JS syntax check the page (`node --check` on extracted script).
- [ ] **Step 4:** tests pass; ruff+py_compile; page syntax clean.
- [ ] **Step 5:** commit `feat: N Style in-lot plate lookup (endpoint + mobile page)`.

---

## Task 4: Apartment dashboard view (leasing + N Style admin)

**Files:** Modify `frontend/dashboard.html`; verify via esbuild (+ Playwright if harness/creds available).

**Contract:** when the logged-in account opens an `apartment` property, render an apartment view (branch on `property.property_type==='apartment'`, mirroring the truck_plaza branch). Sections:
- **Pending queue:** rows from `/apartment/permits?status=pending` (residents + guests) showing plate, unit/host_unit, name, submitted time, and **document thumbnails/links via the proxy** (`/apartment/docs/{kind}/{id}/{which}` — rendered as authenticated `<img>`/links; the proxy needs the JWT, so fetch as blob with the auth header and objectURL, OR open via a tokened fetch — implement the authed-fetch-to-blob pattern). Buttons: **Approve** / **Reject (reason prompt)** → POST the M2 endpoints → refresh.
- **Residents** list (approved) and **Guests** list (active, with time-left) — each with **Extend** (guests) and **Void** actions (T2 endpoints).
- Reuse the existing dashboard fetch/auth (`apiFetch`), table/card styling, and the property-detail tab pattern. Do NOT alter the truck_plaza views.

- [ ] **Step 1:** read the dashboard's property-detail render + how it branches on property_type + `apiFetch`; implement the apartment branch + an `ApartmentPermits` component (queue + lists + actions + authed doc rendering).
- [ ] **Step 2:** extract the babel block, `npx esbuild --loader=jsx` → exit 0.
- [ ] **Step 3:** Playwright smoke if creds/harness exist (apartment property shows the queue; approve button calls the endpoint); else careful re-read + note.
- [ ] **Step 4:** commit `feat: apartment dashboard view — pending queue + resident/guest management + doc viewing`.

---

## Task 5: Feedback (bug/feature) control

**Files:** Backend feedback route (`routers/apartment_passes.py` or a small module); `frontend/dashboard.html` widget; Test `tests/test_apartment_management.py`.

**Backend contract:** `POST /apartment/feedback` body `{property_id, kind:'bug'|'feature', body}` — `require_subject` + `_assert_property_scope(..., allow_partner=True)`; insert a `client_feedback` row with `account_type` (owner|partner from subject) + `submitted_by` (subject email/id) + kind + body. Returns the new id. (No email — stored only; you/LotLogic triage later in sub-project E.)

**Frontend:** a small "Report a bug / Request a feature" control in the dashboard (visible to owner + partner) → opens a modal (kind toggle + textarea) → POSTs → toast confirmation.

- [ ] **Step 1 (test):** `test_feedback_insert_scoped` (creates a client_feedback row with account_type from subject + kind), `test_feedback_cross_tenant_404`, `test_feedback_rejects_bad_kind` (kind not in bug/feature → 400/422).
- [ ] **Step 2:** run → fail.
- [ ] **Step 3:** implement the route + the dashboard widget.
- [ ] **Step 4:** tests pass; ruff+py_compile; esbuild on dashboard; full suite.
- [ ] **Step 5:** commit `feat: client feedback (bug/feature) intake from portals`.

---

## Self-Review
- **Spec coverage:** leasing full control (queue+approve/reject+extend+void+docs → T1/T2/T4 ✓), N Style admin (same, scoped to patrolled → T1/T2/T4 ✓) + driver lookup (T3 ✓), feedback both portals (T5 ✓). Approve/reject + doc proxy reused from M2.
- **No placeholders:** each task has the endpoint contract, test names, and reuse points; UI tasks specify the authed-doc-fetch pattern + the property_type branch explicitly.
- **Type/name consistency:** endpoints `/apartment/permits`, `/apartment/passes/guest/{id}/extend`, `/apartment/passes/{kind}/{id}/void`, `/apartment/lookup`, `/apartment/feedback`; statuses `approved`/`active`/`pending`/`rejected`/`void`; verdicts `resident`/`guest`/`expired_guest`/`not_registered`. Consistent with M1/M2.
