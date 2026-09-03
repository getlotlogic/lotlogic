# N Style Partner Registration + Apartment-SaaS Earnings Removal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the N Style partner login register parking passes for its apartment properties from the dashboard, and remove all per-tow earnings/invoice surfaces from apartment-SaaS accounts.

**Architecture:** Backend gets one additive column + one authenticated endpoint that funnels into the existing `_register_apartment_guest` path with auto-approve forced (reusing the live supersede/idempotency/notify machinery). Frontend gets a modal on the partner's apartment property cards and derives "SaaS account" as *has zero legacy `lots` rows* — no new flags anywhere. The QuickBooks weekly drafting SQL excludes apartments so the Railway Monday cron can never invoice SaaS partners.

**Tech Stack:** FastAPI + SQLAlchemy (async, raw SQL via `text()`), pytest with stub sessions, single-file React/Babel SPA (`frontend/dashboard.html`), Supabase Postgres.

**Spec:** `docs/superpowers/specs/2026-08-12-nstyle-partner-registration-design.md`

## Global Constraints

- User-facing copy: the ONLY noun is **"parking pass"** — never Guest/Visitor/Temporary/Resident (`ui-naming-rule`; DB columns keep legacy names).
- Public QR flow behavior must be byte-identical after the refactor (reCAPTCHA, pending default, `guest_auto_approve` branch, idempotency absorb, doc-key guard, notifications).
- Tenant scoping per `auth-scoping-pattern`: `require_subject` + derive scope from JWT; never accept owner/partner ids from the client; cross-tenant probes get **404**, not 403.
- Migrations: `date -u +%Y%m%d%H%M%S`_snake_case.sql, applied via Supabase MCP `apply_migration` (records in `schema_migrations`).
- Frontend repo working tree has pre-existing edits to `frontend/index.html` + `frontend/services.html` — never stage or revert them.
- Deploy order: migration → backend (push `main`, Railway auto-deploys) → frontend. Frontend prod branch must be confirmed via Vercel before pushing (repo currently lives on `feat/apartment-permit-registry`; prod URL is `lotlogicparking.com/app`).

---

### Task 1: Migration — `visitor_passes.registered_by_partner_id`

**Files:**
- Create: `lotlogic-backend/migrations/<UTC-timestamp>_visitor_passes_registered_by_partner.sql`
- Modify: `lotlogic-backend/CLAUDE.md` (append to migration history list)

**Interfaces:**
- Produces: nullable column `visitor_passes.registered_by_partner_id UUID REFERENCES enforcement_partners(id)`, consumed by Tasks 2–3.

- [ ] **Step 1: Generate timestamp + write migration**

```sql
-- Attribution for passes registered from the partner dashboard (N Style).
-- Nullable + additive: every existing reader uses explicit column lists or
-- SELECT * (frontend), so this column is inert to all of them
-- (blast-radius trace, spec 2026-08-12).
ALTER TABLE public.visitor_passes
  ADD COLUMN IF NOT EXISTS registered_by_partner_id uuid
    REFERENCES public.enforcement_partners(id);

COMMENT ON COLUMN public.visitor_passes.registered_by_partner_id IS
  'enforcement_partners.id of the partner whose dashboard login registered this pass; NULL for public QR / app registrations.';
```

- [ ] **Step 2: Append filename to the migration-history list in CLAUDE.md**
- [ ] **Step 3: Commit** — `git commit -m "migration: visitor_passes.registered_by_partner_id for partner-dashboard registrations"` (do NOT apply to prod yet; that happens in Task 7 in order).

---

### Task 2: Refactor `_register_apartment_guest` for authenticated callers (no behavior change)

**Files:**
- Modify: `lotlogic-backend/routers/public_registration.py:170-319`
- Test: existing suite must stay green — `tests/test_apartment_registration.py`, `tests/test_recaptcha_register.py`, `tests/test_apartment_approval.py`, `tests/test_temp_tag.py`

**Interfaces:**
- Produces: `_register_apartment_guest(body, plate, db, background_tasks, *, force_auto: bool = False, registration_source: str = "qr_guest", registered_by_partner_id: uuid.UUID | None = None) -> VisitorPassRegisterResponse`. `body` needs attrs: `property_id, stay_hours, id_photo_url, plate_photo_url, is_temp_tag, tag_expiration, visitor_name, host_unit, host_name, phone, email, submission_idempotency_key`.

- [ ] **Step 1: Add keyword-only params with defaults preserving today's behavior**

```python
async def _register_apartment_guest(
    body,
    plate: str,
    db: AsyncSession,
    background_tasks: BackgroundTasks,
    *,
    force_auto: bool = False,
    registration_source: str = "qr_guest",
    registered_by_partner_id: Optional[uuid.UUID] = None,
) -> VisitorPassRegisterResponse:
```

- [ ] **Step 2: Auto resolution honors the override** (replace the `guest_auto_approve` lookup block)

```python
    if force_auto:
        auto = True
    else:
        auto_row = (await db.execute(text(
            "SELECT guest_auto_approve FROM public.properties WHERE id = :pid"
        ), {"pid": str(body.property_id)})).mappings().first()
        auto = bool(auto_row and auto_row.get("guest_auto_approve"))
```

- [ ] **Step 3: Thread the two new values into `insert_params` + the INSERT column list**

```python
        "registration_source": registration_source,
        "registered_by_partner_id": str(registered_by_partner_id) if registered_by_partner_id else None,
```

and add `registered_by_partner_id` to both the column list and VALUES list of the INSERT.

- [ ] **Step 4: Run the existing suites**

Run: `cd /Users/gabe/lotlogic-backend && python -m pytest tests/test_apartment_registration.py tests/test_recaptcha_register.py tests/test_apartment_approval.py tests/test_temp_tag.py -q`
Expected: all PASS (stub sessions ignore the extra INSERT param; if a stub asserts exact SQL, update the stub's expected column list — that is the only permissible test edit).

- [ ] **Step 5: Commit** — `refactor: parametrize apartment guest insert for authenticated callers (no behavior change)`

---

### Task 3: `POST /visitor_passes/partner-register`

**Files:**
- Modify: `lotlogic-backend/routers/public_registration.py` (new model + handler beside `register_visitor_pass`)
- Verify: `lotlogic-backend/main.py` PUBLIC_PATHS matching is **exact-path**, so the new route stays behind auth middleware (if prefix-matched, add an explicit exclusion).
- Test: Create `lotlogic-backend/tests/test_partner_register.py`

**Interfaces:**
- Consumes: Task 2's `_register_apartment_guest` signature.
- Produces: `POST /visitor_passes/partner-register` (Bearer partner JWT) → `VisitorPassRegisterResponse {id, plate_text, valid_until, reference_id}`. Body: `PartnerPassRegisterRequest` below. Consumed by Task 5's modal.

- [ ] **Step 1: Write failing tests** (stub-session style copied from `test_apartment_registration.py`; direct handler invocation)

```python
"""Partner-dashboard pass registration: partner-only, apartment-only,
tow_company scope, auto-approve forced, attribution stamped."""
import uuid, asyncio
import pytest
from fastapi import BackgroundTasks, HTTPException
from routers import public_registration
from routers.public_registration import PartnerPassRegisterRequest, partner_register_visitor_pass
from services.auth import Subject

PID = uuid.uuid4()
NSTYLE = uuid.uuid4()

def _body(**kw):
    return PartnerPassRegisterRequest(
        property_id=PID, plate_text="ABC1234", visitor_name="Jane",
        host_unit="4B", stay_hours=24,
        submission_idempotency_key=str(uuid.uuid4()), **kw)

def _subject(type_="partner", id_=NSTYLE):
    return Subject(type=type_, id=id_, email="x@y.z", is_platform_admin=False)

# StubSession answering: property lookup -> {'property_type': 'apartment',
# 'tow_company_id': NSTYLE}; INSERT RETURNING -> row; records executed SQL+params.
# (Copy _StubRow/_StubSession from test_apartment_registration.py, extend the
# property answer with tow_company_id.)

def test_owner_token_rejected_404(stub_db):
    with pytest.raises(HTTPException) as e:
        asyncio.run(partner_register_visitor_pass(_body(), BackgroundTasks(), stub_db, _subject(type_="owner")))
    assert e.value.status_code == 404

def test_wrong_partner_404(stub_db):
    with pytest.raises(HTTPException) as e:
        asyncio.run(partner_register_visitor_pass(_body(), BackgroundTasks(), stub_db, _subject(id_=uuid.uuid4())))
    assert e.value.status_code == 404

def test_truck_plaza_property_404(stub_db_truck):
    with pytest.raises(HTTPException) as e:
        asyncio.run(partner_register_visitor_pass(_body(), BackgroundTasks(), stub_db_truck, _subject()))
    assert e.value.status_code == 404

def test_happy_path_active_and_attributed(stub_db):
    resp = asyncio.run(partner_register_visitor_pass(_body(), BackgroundTasks(), stub_db, _subject()))
    ins = stub_db.last_insert_params
    assert ins["status"] == "active" and ins["valid_until"] is not None
    assert ins["registration_source"] == "partner"
    assert ins["registered_by_partner_id"] == str(NSTYLE)
    assert resp.valid_until is not None
```

- [ ] **Step 2: Run to verify failure** — `python -m pytest tests/test_partner_register.py -q` → FAIL (ImportError: `PartnerPassRegisterRequest`).

- [ ] **Step 3: Implement model + handler**

```python
class PartnerPassRegisterRequest(BaseModel):
    """Authenticated partner-dashboard registration. Mirrors the apartment
    fields of VisitorPassRegisterRequest; no recaptcha (JWT-gated), no
    truck-plaza fields."""
    model_config = ConfigDict(extra="forbid")
    property_id: uuid.UUID
    plate_text: str = Field(..., min_length=2, max_length=20)
    visitor_name: Optional[str] = Field(None, max_length=120)
    host_unit: Optional[str] = Field(None, max_length=60)
    host_name: Optional[str] = Field(None, max_length=120)
    id_photo_url: Optional[str] = Field(None, max_length=512)
    plate_photo_url: Optional[str] = Field(None, max_length=512)
    is_temp_tag: bool = False
    tag_expiration: Optional[date] = None
    phone: Optional[str] = None
    email: Optional[EmailStr] = None
    stay_hours: int = Field(..., ge=1, le=72)
    submission_idempotency_key: str = Field(..., min_length=1, max_length=128)


@visitor_router.post("/partner-register", response_model=VisitorPassRegisterResponse, status_code=200)
async def partner_register_visitor_pass(
    body: PartnerPassRegisterRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    subject: Subject = Depends(require_subject),
) -> VisitorPassRegisterResponse:
    """Partner dashboard: register a parking pass at an apartment property this
    partner tows for. Auto-approved (the partner registering IS the approval);
    stamps registration_source='partner' + registered_by_partner_id."""
    if subject.type != "partner":
        raise HTTPException(status_code=404, detail="not found")
    prop = (await db.execute(text(
        "SELECT property_type, tow_company_id FROM public.properties WHERE id = :pid"
    ), {"pid": str(body.property_id)})).mappings().first()
    if (not prop or prop["property_type"] != "apartment"
            or prop["tow_company_id"] is None
            or str(prop["tow_company_id"]) != str(subject.id)):
        raise HTTPException(status_code=404, detail="not found")
    plate = _normalize_plate(body.plate_text)
    if len(plate) < 2:
        raise HTTPException(status_code=400, detail="plate_text too short")
    return await _register_apartment_guest(
        body, plate, db, background_tasks,
        force_auto=True,
        registration_source="partner",
        registered_by_partner_id=subject.id,
    )
```

Imports to add at top: `from services.auth import Subject, require_subject`.

- [ ] **Step 4: Verify PUBLIC_PATHS in `main.py` is exact-match** for `/visitor_passes/register`; add a test or assertion note that `partner-register` without a token → 401 (middleware). If matching is `startswith`, add explicit carve-out so partner-register requires auth.
- [ ] **Step 5: Run tests** — `python -m pytest tests/test_partner_register.py -q` → PASS; full suite `python -m pytest -q` → green.
- [ ] **Step 6: Commit** — `feat: partner-dashboard pass registration (/visitor_passes/partner-register)`

---

### Task 4: Exclude apartments from QuickBooks weekly drafting

**Files:**
- Modify: `lotlogic-backend/routers/quickbooks.py:222-252` (drafting SQL WHERE clause)

**Interfaces:** none new; the Railway Monday cron + owner-triggered path both flow through this SQL.

- [ ] **Step 1: Add the guard to the WHERE clause** (after `WHERE p.tow_company_id = :partner_id`)

```sql
               -- Apartment properties run on SaaS subscription: never invoice
               -- per-tow (Gabe, 2026-08-12 — spec nstyle-partner-registration).
               AND p.property_type != 'apartment'
```

- [ ] **Step 2: Run QB tests** — `python -m pytest tests/test_quickbooks_invoice_builder.py -q` → PASS (builder untouched; drafting SQL has no unit test — the guard is verified in Task 7 against prod by dry-running the endpoint and expecting `no_tows`/empty).
- [ ] **Step 3: Commit** — `fix: apartment (SaaS) properties excluded from weekly per-tow invoicing`

---

### Task 5: Frontend — "Register a parking pass" modal on partner apartment cards

**Files:**
- Modify: `lotlogic/frontend/dashboard.html` — ALPRPropertiesPage (~:12350-12630) + a new `RegisterPassModal` component defined near the page component.

**Interfaces:**
- Consumes: Task 3's endpoint via the existing `apiFetch(path, opts)` helper (:2452, attaches Bearer token) and card data `p` (has `id`, `name`, `property_type`).

- [ ] **Step 1: Add modal state + button.** In `ALPRPropertiesPage`, add `const [registerProp, setRegisterProp] = React.useState(null);`. On the property card (footer area ~:12623), render for partners on apartment cards only:

```jsx
{user._role === 'partner' && p.property_type === 'apartment' && (
  <button className="btn btn-primary btn-sm" onClick={() => setRegisterProp(p)}>
    Register a parking pass
  </button>
)}
```

And after the card grid: `{registerProp && <RegisterPassModal prop={registerProp} onClose={() => setRegisterProp(null)} />}`

- [ ] **Step 2: Implement `RegisterPassModal`** (match the file's existing modal markup/classes — reuse the same overlay/card classes as the cancel-pass or add-plate modals; copy exact classNames during implementation):

```jsx
function RegisterPassModal({ prop, onClose }) {
  const [f, setF] = React.useState({ plate: '', name: '', unit: '', phone: '', email: '', stayHours: 24, paperTag: false, tagExp: '' });
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');
  const [done, setDone] = React.useState(null);
  const idemKey = React.useMemo(() => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()), []);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setErr(''); setBusy(true);
    try {
      const res = await apiFetch('/visitor_passes/partner-register', {
        method: 'POST',
        body: JSON.stringify({
          property_id: prop.id,
          plate_text: f.plate.trim(),
          visitor_name: f.name.trim() || null,
          host_unit: f.unit.trim() || null,
          phone: f.phone.trim() || null,
          email: f.email.trim() || null,
          stay_hours: parseInt(f.stayHours, 10),
          is_temp_tag: !!f.paperTag,
          tag_expiration: f.paperTag && f.tagExp ? f.tagExp : null,
          submission_idempotency_key: idemKey,
        }),
      });
      setDone(res);
    } catch (ex) {
      setErr(ex && ex.message ? ex.message : 'Registration failed — try again.');
    } finally { setBusy(false); }
  };
  // done-state: confirmation with reference id + "valid until" and a Close button.
  // form fields: Plate (required), Name, Unit, Phone, Email,
  // "How long?" select [4,8,12,24,48,72] hours, "Paper tag" checkbox
  // revealing an optional expiration date input.
  // ... markup mirrors the file's existing modal pattern ...
}
```

Copy notes: title **"Register a parking pass"**, submit button **"Register pass"**, success line **"Parking pass active until …"** — no Guest/Visitor/Temporary anywhere. No photo fields in v1.

- [ ] **Step 3: Sanity-check gating** — owner logins and truck-plaza cards must not render the button (`user._role === 'partner' && p.property_type === 'apartment'`). Roster/realtime updates need no wiring (subscriptions are full-row `*`).
- [ ] **Step 4: Syntax check** — load the file, e.g. `npx babel --presets react --no-babelrc < extracted script` is impractical for this repo; instead open the dashboard locally or rely on Task 7's Playwright pass. Minimum: `node -e` JSX-free syntax review + careful diff read.
- [ ] **Step 5: Commit** — `feat: partner dashboard can register parking passes at apartment properties`

---

### Task 6: Frontend — hide earnings/fee UI for SaaS (zero-legacy-lots) accounts

**Files:**
- Modify: `lotlogic/frontend/dashboard.html` — navTabs owner branch (:14213-14227), valid-tabs allowlist (:13857-13862), tab renders (:14379, :14381), AccountPage partner editors (:8705).

**Interfaces:** consumes App-level `lots` state (already loaded for both roles) + `isPlatformAdmin` (:13837).

- [ ] **Step 1: Derive the gate once** near the tab construction: `const hasLegacyLots = (lots || []).length > 0; const showMoney = isPlatformAdmin || hasLegacyLots;`
- [ ] **Step 2: Owner navTabs** — include the `earnings` and `invoices` entries only when `showMoney`. Apply the same condition in the valid-tabs coercion list (so a persisted `tab==='earnings'` coerces away) and wrap the two renders (`{tab === 'earnings' && isOwner && showMoney && …}`, same for invoices).
- [ ] **Step 3: Partner Account tab** — gate `<PartnerFeeEditor/>` (:8705) with the same derivation (N Style: zero lots → hidden; NMLD: one lot → keeps it). **`TowTruckPlatesEditor` stays for all partners** — plate matching is live enforcement, not money. Note: AccountPage receives props; pass `showMoney` (or `lots`) down from App rather than recomputing from scope it doesn't have.
- [ ] **Step 4: Verify platform admin unaffected** — Gabe's login: `isPlatformAdmin` → `showMoney` true regardless of lots.
- [ ] **Step 5: Commit** — `feat: hide per-tow earnings/fee surfaces for SaaS (no-legacy-lots) accounts`

---

### Task 7: Apply migration, deploy both repos, verify live end-to-end

**Files:** none (operational).

- [ ] **Step 1: Apply Task 1 migration to prod** via Supabase MCP `apply_migration` (name matching the file, minus timestamp). Verify: `SELECT column_name FROM information_schema.columns WHERE table_name='visitor_passes' AND column_name='registered_by_partner_id';`
- [ ] **Step 2: Push backend `main`** → Railway auto-deploys. Watch deploy status via Railway MCP; hit `/health`.
- [ ] **Step 3: Confirm the Vercel production branch** for the frontend project (Vercel MCP `get_project`) — repo is on `feat/apartment-permit-registry`; push to whichever branch production tracks (do not merge unrelated branches).
- [ ] **Step 4: Backend live verification (API level):**
  - `POST /auth/login` with N Style creds (Desktop instructions file) → partner JWT.
  - `POST /visitor_passes/partner-register` for Stevensons with a test plate (e.g. `TESTNS01`, stay 1h) → expect 200, `valid_until` non-null.
  - `SELECT status, registration_source, registered_by_partner_id FROM visitor_passes WHERE plate_text='TESTNS01'` → `active / partner / <N Style id>`.
  - Negative probes: same call with the owner JWT → 404; property_id of Charlotte Travel Plaza → 404; no token → 401.
  - `POST /quickbooks/run-weekly-invoicing` with `X-API-Key` → every partner returns `no_tows`/`skipped_exists`, nothing drafted (guard live).
  - Clean up: cancel the test pass via `POST /visitor_passes/{id}/cancel` (owner JWT) or SQL status update.
- [ ] **Step 5: UI verification (Playwright against `lotlogicparking.com/app`):**
  - N Style login → Lots tab: every apartment card shows **Register a parking pass**; open modal, cancel; Account tab: fee editor gone, tow-truck plates editor present.
  - Stevensons manager login → no Earnings/Billing tabs; Overview/Lots normal.
  - Gabe's platform-admin login → Earnings/Billing still present; NMLD app-tab unaffected.
- [ ] **Step 6: Memory + report** — update auto-memory (N Style registration live; leasing login parked pending email; QB apartment guard) and report to Gabe with UX-impact framing.

## Self-Review

- Spec coverage: Feature A → Tasks 1-3, 5; Feature B → Tasks 4, 6; verification/deploy → Task 7; parked leasing login → explicitly no task (spec: do not build). ✓
- Placeholders: modal markup says "mirrors the file's existing modal pattern" — intentional: exact classNames must be copied from the live file at edit time, all logic/copy is specified. ✓
- Type consistency: `_register_apartment_guest` keyword signature identical in Tasks 2 and 3; `PartnerPassRegisterRequest` field set matches the modal payload (modal omits `host_name`, `id_photo_url`, `plate_photo_url`, `back_plate` — all Optional). ✓
