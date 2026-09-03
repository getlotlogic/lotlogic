# Internal LotLogic Admin Portal (Frame) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the *frame* of a LotLogic-facing internal console — an admin-gated page + backend endpoints to see every client across tenants, onboard a new client end-to-end (property + accounts + linking + password-setup links), and triage client feedback. Working happy-path, built to refine.

**Architecture:** A new `routers/admin.py` holding all `/admin/*` endpoints, each gated by a new `require_platform_admin` dependency that allows service-key OR `is_platform_admin` callers (reusing the existing `Subject.is_unrestricted`). A new internal `frontend/admin.html` (separate from the client dashboard, never linked from it) reuses the dashboard's login + `apiFetch` + localStorage session and talks ONLY to the backend (Supabase RLS would otherwise filter the browser to one tenant). Account creation reuses the field-allowlist pattern; password seeding reuses the existing reset-token flow (no email).

**Tech Stack:** FastAPI (pytest), Supabase Postgres (no schema change — all needed tables exist), single-file `admin.html` (React+Babel), all on branch `feat/apartment-permit-registry`. Pushes GATED.

**Spec:** `~/lotlogic/docs/superpowers/specs/2026-06-29-internal-admin-portal-design.md`

## Key facts (read before starting)
- Branch: backend `~/lotlogic-backend`, frontend `~/lotlogic`, both on `feat/apartment-permit-registry`. COMMIT ONLY — do not push.
- Use `python3.11` for pytest/py_compile. PIL absent → `routers.snapshots` test failure is PRE-EXISTING, ignore it.
- Identity: `services/auth.py` → `Subject` has `.is_platform_admin`, `.is_service`, `.is_unrestricted` (service OR platform admin). `require_subject` is the existing dependency. Login JWT already carries the admin flag.
- `properties` columns: `id, name, address, property_type ('apartment'|'truck_plaza'), owner_id, partner_id, tow_company_id, policy_text, policy_phone, created_at`. Apartments must set `tow_company_id = partner_id` (Phase-1 lesson).
- Accounts: `lot_owners (id, name, email, password_hash, password_reset_token, password_reset_expires_at, is_platform_admin, active, created_at)`; `enforcement_partners (id, name, email, password_hash, password_reset_token, password_reset_expires_at, active, tow_truck_plates, created_at)`. Field-allowlisted creation lives in `routers/lots.py` (`create_owner` uses `_OWNER_CREATABLE_FIELDS`; see `create_partner`).
- Password seeding: `services/auth.generate_reset_token()` + the `/auth/set-password` flow. The setup link = `<DASHBOARD_URL>/set-password?token=<token>` (confirm the exact frontend set-password route in dashboard.html; mirror what `/auth/request-password` callers build). Token TTL: mirror existing reset-token TTL.
- `client_feedback (id, property_id, account_type, submitted_by, kind, body, status open|triaged|closed, created_at)`.
- `routers/visitor_passes.py` + `routers/apartment_passes.py` show the count-query + scoped patterns. `main.py` registers routers — register `admin_router` there.

## File Structure
- `lotlogic-backend/services/auth.py` — ADD `require_platform_admin` dependency (next to `require_subject`).
- `lotlogic-backend/routers/admin.py` — NEW. All `/admin/*` endpoints + SQL builders.
- `lotlogic-backend/main.py` — register `admin_router`.
- `lotlogic-backend/tests/test_admin_portal.py` — NEW. Guard + clients + onboarding + feedback tests.
- `frontend/admin.html` — NEW. Gated shell + Clients / Onboard / Feedback sections.
- `frontend/vercel.json` — ADD an `/admin` rewrite to `admin.html`.

---

## Task 1: `require_platform_admin` guard + `/admin/whoami`

**Files:** Modify `services/auth.py`; Create `routers/admin.py`; Modify `main.py`; Create `tests/test_admin_portal.py`.

**Contract:**
- `require_platform_admin(subject: Subject = Depends(require_subject)) -> Subject` — returns the subject if `subject.is_unrestricted`, else raises `HTTPException(403, "Platform admin required")`.
- `routers/admin.py`: `router = APIRouter(prefix="/admin", tags=["admin"])`; `GET /admin/whoami` → `{is_admin: true, email}` (only reachable by admins, so it always returns true; the frontend uses its 403-vs-200 to gate).
- Register in `main.py`.

- [ ] **Step 1 (test):** `tests/test_admin_portal.py`:
```python
import pytest
from fastapi import HTTPException
from services.auth import Subject, require_platform_admin

def _sub(**kw):
    base = dict(type="owner", id=None, email="x@y.com", is_platform_admin=False)
    base.update(kw); return Subject(**base)

def test_platform_admin_passes():
    s = _sub(is_platform_admin=True)
    assert require_platform_admin(s) is s

def test_service_passes():
    s = _sub(type="service")
    assert require_platform_admin(s) is s

def test_plain_owner_rejected():
    with pytest.raises(HTTPException) as e:
        require_platform_admin(_sub())
    assert e.value.status_code == 403

def test_plain_partner_rejected():
    with pytest.raises(HTTPException) as e:
        require_platform_admin(_sub(type="partner"))
    assert e.value.status_code == 403
```
(Note: `require_platform_admin` takes the already-resolved subject as a default-arg dependency; calling it directly with a Subject works for the unit test because FastAPI only injects when used as a dependency. If signature makes direct calls awkward, expose the inner check as a plain function the dependency wraps and test that.)
- [ ] **Step 2:** `python3.11 -m pytest tests/test_admin_portal.py -v` → FAIL.
- [ ] **Step 3:** implement the guard + `routers/admin.py` skeleton with `/admin/whoami` + register in `main.py`.
- [ ] **Step 4:** tests pass; `ruff check services/auth.py routers/admin.py tests/test_admin_portal.py`; `py_compile`; full suite (note PIL pre-existing).
- [ ] **Step 5:** commit `feat: require_platform_admin guard + /admin router skeleton + whoami`.

---

## Task 2: `GET /admin/clients` cross-tenant overview

**Files:** Modify `routers/admin.py`; Modify `tests/test_admin_portal.py`.

**Contract:** `GET /admin/clients` (gated by `require_platform_admin`). Returns a list, one row per property across ALL tenants:
`{id, name, address, property_type, owner_email, partner_email, tow_company_id, active_pass_count, open_violation_count}`.
- `owner_email`/`partner_email` via LEFT JOIN to `lot_owners`/`enforcement_partners` on `properties.owner_id`/`partner_id`.
- `active_pass_count` = visitor_passes for that property with `status='active'` (correlated subquery or LEFT JOIN + count).
- `open_violation_count` = `alpr_violations` for that property not yet actioned (`action_taken is null`) — confirm the column/property linkage in `alpr_violations`; if the linkage is indirect, count what's cleanly available and note it. Keep it a single SQL builder `build_admin_clients_sql()` (string, pytest-able).

- [ ] **Step 1 (test):** `test_build_admin_clients_sql_joins_accounts_and_counts` — the SQL selects `property_type`, LEFT JOINs `lot_owners` + `enforcement_partners`, and computes `active_pass_count` (references `visitor_passes` + `status = 'active'`). `test_clients_requires_admin` — call the route function with a non-admin subject (stub) → 403 (or rely on the dependency; assert the dependency is `require_platform_admin`).
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** implement `build_admin_clients_sql()` + the route.
- [ ] **Step 4:** tests pass; ruff + py_compile; full suite.
- [ ] **Step 5:** commit `feat: GET /admin/clients cross-tenant overview (accounts + live counts)`.

---

## Task 3: `POST /admin/clients` end-to-end onboarding

**Files:** Modify `routers/admin.py`; Modify `tests/test_admin_portal.py`.

**Contract:** `POST /admin/clients` (gated). Body (Pydantic model `ClientOnboardRequest`):
```
property: { name: str, address: str | None, property_type: Literal['apartment','truck_plaza'] }
owner:   { name: str, email: EmailStr } | None      # create a new leasing/owner account
partner: { name: str, email: EmailStr } | None      # create a new tow partner account
existing_partner_id: uuid | None                    # OR link an existing partner instead of creating one
```
One transaction:
1. If `owner` given: insert `lot_owners` (name,email) with `password_reset_token = generate_reset_token()` + expiry; capture `owner_id`. NEVER accept/set `is_platform_admin` (reject if the body smuggles it — the model simply has no such field).
2. Resolve partner: if `partner` given, insert `enforcement_partners` (name,email) + reset token, capture `partner_id`; elif `existing_partner_id`, use it; else `partner_id=None`.
3. Insert `properties` (name,address,property_type,owner_id,partner_id) and for `property_type='apartment'` set `tow_company_id = partner_id`.
4. Commit. Return `{property_id, owner: {id, setup_link} | None, partner: {id, setup_link} | None}` where `setup_link = f"{DASHBOARD_URL}/set-password?token={token}"`.
On any failure, roll back the whole tx (no partial client).

- [ ] **Step 1 (test):** stub `_StubSession` (mirror `test_recaptcha_register.py`) capturing inserts.
  - `test_onboard_apartment_sets_tow_company_id` — apartment + new owner + new partner → property insert params have `owner_id`, `partner_id`, AND `tow_company_id == partner_id`.
  - `test_onboard_truck_plaza_no_tow_company` — truck_plaza → `tow_company_id` is None/absent.
  - `test_onboard_returns_setup_links` — response includes `owner.setup_link` + `partner.setup_link` containing `set-password?token=`.
  - `test_onboard_existing_partner_links_not_creates` — `existing_partner_id` set, no `partner` → no enforcement_partners insert, property uses that id.
  - `test_onboard_model_rejects_platform_admin` — constructing `ClientOnboardRequest` with `owner={...,'is_platform_admin':true}` ignores/forbids it (extra fields forbidden on the owner sub-model).
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** implement the model (sub-models with `extra='forbid'`) + the transactional handler. Reuse `generate_reset_token`; read `DASHBOARD_URL` from settings/config.
- [ ] **Step 4:** tests pass; ruff + py_compile; full suite.
- [ ] **Step 5:** commit `feat: POST /admin/clients end-to-end onboarding (property + accounts + linking + setup links)`.

---

## Task 4: Feedback inbox — `GET /admin/feedback` + `PATCH /admin/feedback/{id}`

**Files:** Modify `routers/admin.py`; Modify `tests/test_admin_portal.py`.

**Contract:**
- `GET /admin/feedback?status=<optional>` (gated) → all `client_feedback` across tenants, newest first, joined to `properties.name as property_name`: `{id, property_id, property_name, account_type, submitted_by, kind, body, status, created_at}`. Optional `status` filter. `build_admin_feedback_sql()` string helper.
- `PATCH /admin/feedback/{id}` body `{status: Literal['open','triaged','closed']}` (gated) → update status, return the row. Bad status → 422 (Pydantic).

- [ ] **Step 1 (test):** `test_build_admin_feedback_sql_joins_property_and_orders` (selects `kind`,`status`, joins properties, `order by created_at desc`, optional status filter), `test_feedback_patch_rejects_bad_status` (model validation → ValidationError for `status='nope'`), `test_feedback_requires_admin` (dependency is `require_platform_admin`).
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** implement both routes + the SQL builder.
- [ ] **Step 4:** tests pass; ruff + py_compile; full suite.
- [ ] **Step 5:** commit `feat: admin feedback inbox (list across tenants + status triage)`.

---

## Task 5: `frontend/admin.html` — gated shell + three sections

**Files:** Create `frontend/admin.html`; Modify `frontend/vercel.json`. Verify via esbuild.

**Contract:** a single-file React+Babel page (mirror `apt.html`/`dashboard.html` conventions: in-browser Babel, an `apiFetch` that attaches the `localStorage` admin JWT + handles 401). On load:
- If no session or `GET /admin/whoami` returns 403/401 → render an **"Admin sign-in required"** screen with an email/password login that posts to `/auth/login` (reuse the dashboard's login call shape) and a clear "this account is not a platform admin" message on 403.
- If admin → render the shell with three tabs/sections:
  1. **Clients** — table from `GET /admin/clients` (name, type badge, owner/partner email, active passes, open violations).
  2. **Onboard** — a wizard form (property name/address + type select; optional owner name/email; optional partner name/email OR pick existing). Submit → `POST /admin/clients` → render the returned **setup links** with copy buttons (show-once treatment) + a success note.
  3. **Feedback** — list from `GET /admin/feedback` with a per-row status `<select>` → `PATCH /admin/feedback/{id}`.
- Internal-only: do NOT link admin.html from dashboard.html or any client page.
- `vercel.json`: add a rewrite so `/admin` serves `admin.html` (mirror the existing `/apt` + `/lookup` rewrites).

- [ ] **Step 1:** read the login + `apiFetch` shape in `dashboard.html` (or `lookup.html`, which already reuses the session) and the `/apt`+`/lookup` rewrites in `vercel.json`; build `admin.html` + the rewrite following those patterns.
- [ ] **Step 2:** extract the babel block → `npx esbuild admin.scriptblock.jsx --bundle=false > /dev/null` → exit 0. Clean up the temp file.
- [ ] **Step 3:** Playwright smoke if creds exist (load `/admin` unauthenticated → sign-in screen shows); else careful re-read + note live verification awaits deploy.
- [ ] **Step 4:** commit `feat: internal admin.html — gated clients overview + onboarding wizard + feedback inbox`.

---

## Self-Review
- **Spec coverage:** admin guard (T1 ✓), cross-tenant clients overview (T2 ✓), end-to-end onboarding w/ apartment tow_company_id rule + setup links + no-platform-admin-smuggle (T3 ✓), feedback triage (T4 ✓), gated internal UI with all three sections + admin-probe gate + vercel route (T5 ✓). Out-of-scope items (deep per-client dashboards, edit/deactivate, billing, email) intentionally excluded — the frame makes them addable.
- **No placeholders:** each backend task has the contract, test names/code, and exact return shapes; the onboarding tx steps are enumerated; the UI task names the exact endpoints + reuse points + the gate behavior.
- **Type/name consistency:** guard `require_platform_admin`; router prefix `/admin`; endpoints `/admin/whoami|clients|feedback`; SQL builders `build_admin_clients_sql`/`build_admin_feedback_sql`; model `ClientOnboardRequest` with `property`/`owner`/`partner`/`existing_partner_id`; response `setup_link` = `{DASHBOARD_URL}/set-password?token=`; feedback status `open|triaged|closed`. property_type literal `apartment|truck_plaza` consistent with the DB CHECK.
- **Security:** every `/admin/*` route gated; onboarding model forbids extra fields (no `is_platform_admin` smuggling); admin bypass is identity-derived (no client-supplied scope); setup links treated as secrets in the UI. Reads go through the backend, never direct Supabase.
