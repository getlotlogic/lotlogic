# Finish USDOT First-Class Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Commit the in-flight USDOT/MC matching code, land migration 015 in-repo, make QR forms + backend accept USDOT/MC identifiers for plateless tractors, surface those identifiers in the dashboard list views, and deploy.

**Architecture:** All seven work items are additive to an already-live state machine. USDOT/MC plates participate in the session state machine identically to license plates — `findActiveResident` / `findActiveVisitorPass` (already modified but uncommitted in `sessions.ts`) branch on plate prefix `DOT` / `MC` and query `resident_plates.usdot_number` / `visitor_passes.usdot_number` (or `mc_number`) instead of `plate_text`. The QR forms become the write side of that same split: plate-only, USDOT-only, MC-only, or any combination are all valid registrations for truck-plaza properties.

**Tech Stack:** Deno edge functions, FastAPI + Pydantic + SQLAlchemy, vanilla JS QR forms, React-in-Babel dashboard, Supabase Postgres.

**Repos:** This plan spans two repositories checked out as siblings:
- `/Users/gabe/lotlogic/` — frontend, edge functions, migrations, docs (current working directory)
- `/Users/gabe/lotlogic-backend/` — FastAPI backend (sibling checkout)

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `migrations/015_usdot_number_on_passes_and_residents.sql` | Create | Source-of-truth migration file for columns already applied to prod via MCP |
| `supabase/functions/camera-snapshot/sessions.ts` | Commit existing mods | USDOT/MC matching branches |
| `frontend/dashboard.html` | Commit existing mods + extend | USDOT/MC badges (already added on In Lot Now + Plate Detections); extend to Truck Parking Log + Permanent Plates tables |
| `frontend/visit.html` | Modify | Add USDOT + MC fields to truck-plaza variant; make plate optional when either is present; include both in POST body |
| `frontend/resident.html` | Modify | Add USDOT + MC fields to truck-plaza branch; same plate-optional rule; include in POST body |
| `../lotlogic-backend/routers/public_registration.py` | Modify | Accept `usdot_number` / `mc_number` in both Pydantic request models and include in INSERT; relax `plate_text` to allow synthesized values (`DOT-xxxxxxx`) |
| `../lotlogic-backend/tests/test_public_registration.py` | Modify | Add tests for USDOT-only and MC-only registration paths |

---

## Task 1: Commit migration 015 to the repo

The column additions were applied to prod via `mcp__supabase__apply_migration` but never committed to `migrations/`. Reconstructing from prod schema.

**Files:**
- Create: `migrations/015_usdot_number_on_passes_and_residents.sql`

- [ ] **Step 1: Create the migration file**

Write `migrations/015_usdot_number_on_passes_and_residents.sql`:

```sql
-- 015_usdot_number_on_passes_and_residents.sql
-- Add USDOT and MC (Motor Carrier) number columns to visitor_passes and
-- resident_plates so plateless tractors can be allowlisted by FMCSA
-- identifier instead of by license plate text.
--
-- Applied to prod 2026-04-20 via supabase MCP apply_migration; this file
-- exists for repo parity so `supabase db push` from a fresh clone
-- produces the same schema.

ALTER TABLE public.visitor_passes
  ADD COLUMN IF NOT EXISTS usdot_number TEXT,
  ADD COLUMN IF NOT EXISTS mc_number TEXT;

ALTER TABLE public.resident_plates
  ADD COLUMN IF NOT EXISTS usdot_number TEXT,
  ADD COLUMN IF NOT EXISTS mc_number TEXT;

-- Partial indexes: match cost is O(log n) for the common "is this DOT
-- number allowlisted here right now" lookup.

CREATE INDEX IF NOT EXISTS idx_visitor_passes_usdot
  ON public.visitor_passes (property_id, usdot_number)
  WHERE usdot_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_visitor_passes_mc
  ON public.visitor_passes (property_id, mc_number)
  WHERE mc_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_resident_plates_usdot
  ON public.resident_plates (property_id, usdot_number)
  WHERE usdot_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_resident_plates_mc
  ON public.resident_plates (property_id, mc_number)
  WHERE mc_number IS NOT NULL;
```

- [ ] **Step 2: Verify no drift with deployed DB**

Run: use `mcp__supabase__list_tables` for schemas `["public"]` and confirm `visitor_passes.usdot_number`, `visitor_passes.mc_number`, `resident_plates.usdot_number`, `resident_plates.mc_number` all exist and are `text NULL`.

Expected: all four columns present, all four partial indexes present.

- [ ] **Step 3: Commit just the migration**

```bash
git add migrations/015_usdot_number_on_passes_and_residents.sql
git commit -m "$(cat <<'EOF'
migration(015): usdot_number + mc_number on passes + residents

Columns were applied to prod via Supabase MCP on 2026-04-20 but the
migration file never landed in-repo. Adding the file so a fresh clone
`supabase db push`s to the same schema, and so the history is auditable.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Commit the in-flight USDOT matching code

`sessions.ts` and `dashboard.html` have uncommitted changes from the overnight session that are already running in prod (for sessions.ts: once deployed; for dashboard.html: auto-deployed to Vercel on merge). Commit them before any new work touches the same files.

**Files:**
- Modify (commit existing): `supabase/functions/camera-snapshot/sessions.ts`
- Modify (commit existing): `frontend/dashboard.html` (only the In Lot Now + Plate Detections badges; other edits in this task later)

- [ ] **Step 1: Confirm the diff**

Run: `git diff supabase/functions/camera-snapshot/sessions.ts frontend/dashboard.html`

Expected: diff shows (a) new `extractFmcsaNumber` helper + DOT/MC branches in `findActiveResident` + `findActiveVisitorPass`, and (b) four JSX `{...startsWith('DOT-') ...}` / `startsWith('MC-')` badge blocks in dashboard.html. No other changes.

- [ ] **Step 2: Commit both files**

```bash
git add supabase/functions/camera-snapshot/sessions.ts frontend/dashboard.html
git commit -m "$(cat <<'EOF'
feat(alpr): USDOT/MC first-class in allowlist match + dashboard badges

sessions.ts: findActiveResident / findActiveVisitorPass now branch on
plate prefix (DOT / MC), matching against resident_plates.usdot_number /
mc_number (or visitor_passes.*) instead of plate_text. Real plates take
the unchanged code path.

dashboard.html: USDOT and MC# badges on In Lot Now and Plate Detections
rows so operators can see which matches came from ParkPow USDOT OCR vs
a real license plate.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Backend — accept USDOT/MC on visitor_pass register

Open the backend repo at `/Users/gabe/lotlogic-backend/`. The `register_visitor_pass` endpoint currently rejects any field not declared on `VisitorPassRegisterRequest` (`extra="forbid"`), so we must add the fields before the frontend can POST them.

**Files:**
- Modify: `../lotlogic-backend/routers/public_registration.py:54-75,154-191`
- Modify: `../lotlogic-backend/tests/test_public_registration.py` (add one test)

- [ ] **Step 1: Write the failing test**

Open `/Users/gabe/lotlogic-backend/tests/test_public_registration.py` (create if missing; follow pytest patterns of other tests in that dir). Add:

```python
import uuid
from httpx import AsyncClient
import pytest

@pytest.mark.asyncio
async def test_visitor_pass_register_accepts_usdot_and_mc(
    async_client: AsyncClient,
    seed_truck_plaza_property,
    recaptcha_bypass,
):
    """Truck-plaza plateless tractor: driver gives us the DOT, no plate."""
    property_id = seed_truck_plaza_property["id"]
    body = {
        "property_id": str(property_id),
        "plate_text": "DOT-1234567",
        "visitor_name": "John Driver",
        "company_name": "ACME Trucking",
        "vehicle_type": "semi",
        "host_unit": "",
        "host_name": "",
        "phone": "5555551234",
        "parking_spot": "12",
        "usdot_number": "1234567",
        "mc_number": None,
        "stay_hours": 24,
        "policy_acknowledged_at": "2026-04-20T10:00:00Z",
        "submission_idempotency_key": f"test-{uuid.uuid4()}",
        "recaptcha_token": "bypass",
    }
    r = await async_client.post("/visitor_passes/register", json=body)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["plate_text"] == "DOT-1234567"
    # And confirm usdot_number got stored by reading back via a private query:
    row = await fetch_one("SELECT usdot_number, mc_number FROM visitor_passes WHERE id = :id",
                          {"id": data["id"]})
    assert row["usdot_number"] == "1234567"
    assert row["mc_number"] is None
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/gabe/lotlogic-backend && pytest tests/test_public_registration.py::test_visitor_pass_register_accepts_usdot_and_mc -v
```

Expected: FAIL with a Pydantic validation error — `usdot_number` is an extra field rejected by `extra="forbid"`.

- [ ] **Step 3: Add the fields to the Pydantic model**

Edit `routers/public_registration.py`. In `VisitorPassRegisterRequest` (around line 54-75), insert after the existing truck-plaza fields (`parking_spot`, `placard_color`):

```python
    # FMCSA identifiers for plateless tractors (optional, 5-8 digit).
    usdot_number: Optional[str] = Field(None, pattern=r"^\d{5,8}$")
    mc_number: Optional[str] = Field(None, pattern=r"^\d{5,8}$")
```

- [ ] **Step 4: Include them in insert_params and the INSERT statement**

In `register_visitor_pass` around line 154 (`insert_params`), add:

```python
        "usdot_number": body.usdot_number,
        "mc_number": body.mc_number,
```

In the INSERT around line 175-191, extend the column list and VALUES:

```python
            INSERT INTO public.visitor_passes
                (property_id, plate_text, visitor_name, host_unit, host_name,
                 company_name, parking_spot, placard_color,
                 phone, email, vehicle_type,
                 usdot_number, mc_number,
                 valid_from, valid_until, status,
                 stay_days, policy_acknowledged_at,
                 registration_source, submission_idempotency_key)
            VALUES
                (:property_id, :plate_text, :visitor_name, :host_unit, :host_name,
                 :company_name, :parking_spot, :placard_color,
                 :phone, :email, :vehicle_type,
                 :usdot_number, :mc_number,
                 :valid_from, :valid_until, 'active',
                 :stay_days, :policy_acknowledged_at,
                 :registration_source, :submission_idempotency_key)
            RETURNING id, plate_text, valid_until
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd /Users/gabe/lotlogic-backend && pytest tests/test_public_registration.py::test_visitor_pass_register_accepts_usdot_and_mc -v
```

Expected: PASS.

- [ ] **Step 6: Commit (in the backend repo)**

```bash
cd /Users/gabe/lotlogic-backend
git add routers/public_registration.py tests/test_public_registration.py
git commit -m "$(cat <<'EOF'
feat(public-registration): accept usdot_number + mc_number on visitor_pass

Frontend visit.html (truck-plaza variant) will POST these for plateless
tractors; sessions.ts already matches on resident_plates.usdot_number /
visitor_passes.usdot_number when the camera synthesizes a DOT-xxx plate
via the ParkPow fallback.

Optional fields, 5-8 digit regex. Stored alongside the existing plate_text
(which becomes `DOT-1234567` for plateless submissions).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Backend — accept USDOT/MC on resident_plate register

Same pattern as Task 3 but on the `ResidentPlateRegisterRequest` model.

**Files:**
- Modify: `../lotlogic-backend/routers/public_registration.py:234-304`
- Modify: `../lotlogic-backend/tests/test_public_registration.py` (add one test)

- [ ] **Step 1: Write the failing test**

Append to `tests/test_public_registration.py`:

```python
@pytest.mark.asyncio
async def test_resident_plate_register_accepts_usdot_and_mc(
    async_client: AsyncClient,
    seed_truck_plaza_property,
    recaptcha_bypass,
):
    """Truck-plaza employee driving a plateless tractor — USDOT only."""
    body = {
        "property_id": str(seed_truck_plaza_property["id"]),
        "plate_text": "DOT-2345678",
        "holder_name": "Jane Employee",
        "phone": "5555555678",
        "vehicle_type": "semi",
        "holder_role": "employee",
        "usdot_number": "2345678",
        "mc_number": None,
        "recaptcha_token": "bypass",
    }
    r = await async_client.post("/resident_plates/register", json=body)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["plate_text"] == "DOT-2345678"
    row = await fetch_one("SELECT usdot_number, mc_number FROM resident_plates WHERE id = :id",
                          {"id": data["id"]})
    assert row["usdot_number"] == "2345678"
    assert row["mc_number"] is None
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/gabe/lotlogic-backend && pytest tests/test_public_registration.py::test_resident_plate_register_accepts_usdot_and_mc -v
```

Expected: FAIL with Pydantic `extra_forbidden` on `usdot_number`.

- [ ] **Step 3: Add the fields to the Pydantic model**

In `ResidentPlateRegisterRequest` (around line 234-243), after `holder_role`:

```python
    # FMCSA identifiers (optional, 5-8 digit).
    usdot_number: Optional[str] = Field(None, pattern=r"^\d{5,8}$")
    mc_number: Optional[str] = Field(None, pattern=r"^\d{5,8}$")
```

- [ ] **Step 4: Include them in insert_params and the INSERT statement**

In `register_resident_plate` around line 284, extend `insert_params`:

```python
        "usdot_number": body.usdot_number,
        "mc_number": body.mc_number,
```

And the INSERT around line 294-303:

```python
            INSERT INTO public.resident_plates
                (property_id, plate_text, holder_name, phone,
                 vehicle_type, holder_role, vehicle_description,
                 usdot_number, mc_number,
                 active, status)
            VALUES
                (:property_id, :plate_text, :holder_name, :phone,
                 :vehicle_type, :holder_role, '',
                 :usdot_number, :mc_number,
                 true, 'pending')
            RETURNING id, plate_text, status
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd /Users/gabe/lotlogic-backend && pytest tests/test_public_registration.py::test_resident_plate_register_accepts_usdot_and_mc -v
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/gabe/lotlogic-backend
git add routers/public_registration.py tests/test_public_registration.py
git commit -m "$(cat <<'EOF'
feat(public-registration): accept usdot_number + mc_number on resident_plate

Mirror of the visitor_passes change. Truck-plaza employees registering a
plateless tractor supply their USDOT (or MC) and the frontend synthesizes
plate_text=`DOT-xxxxxxx` so the (property_id, plate_text) uniqueness
constraint still holds.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 7: Push and deploy the backend**

```bash
cd /Users/gabe/lotlogic-backend && git push origin main
```

Railway auto-deploys on push to main. Watch the deploy: `railway logs` or the Railway dashboard. Wait until the new revision is live (30-60 s) before proceeding to Task 5 — the frontend changes in the next tasks POST to these new fields.

---

## Task 5: visit.html — USDOT + MC fields on truck-plaza form

**Files:**
- Modify: `/Users/gabe/lotlogic/frontend/visit.html:390-458` (the `showTruckPlazaForm` template)
- Modify: `/Users/gabe/lotlogic/frontend/visit.html:558-599` (the submit handler)

- [ ] **Step 1: Add the fields to the form HTML**

In `showTruckPlazaForm()`, insert between the Placard Color field and the policy block (around line 439 — right before the policy display div):

```html
          <label for="usdot" style="margin-top:14px;">USDOT Number <span style="color:#6b7280;font-size:12px;">(optional, 5-8 digits)</span></label>
          <input type="text" id="usdot" inputmode="numeric" pattern="\d{5,8}" placeholder="1234567" maxlength="8" autocomplete="off">

          <label for="mc" style="margin-top:8px;">MC Number <span style="color:#6b7280;font-size:12px;">(optional, 5-8 digits)</span></label>
          <input type="text" id="mc" inputmode="numeric" pattern="\d{5,8}" placeholder="567890" maxlength="8" autocomplete="off">

          <div style="font-size:12px;color:#9ca3af;margin-top:6px;">If your tractor has no license plate visible, enter your USDOT or MC number so our cameras can identify it.</div>
```

- [ ] **Step 2: Relax plate required-ness in the truck-plaza template**

In the same template, change the plate input from `required` to optional. Replace the line at line 410:

```html
          <input type="text" id="plate" class="plate-input" placeholder="ABC 1234" maxlength="10" autocomplete="off">
```

(Removed `required`.) Also update the label (line 409) to reflect that plate is optional when USDOT/MC is present:

```html
          <label for="plate">Truck License Plate <span style="color:#6b7280;font-size:12px;">(required unless you enter USDOT or MC)</span></label>
```

- [ ] **Step 3: Update the submit handler — read + validate USDOT/MC**

In `handleTruckPlazaSubmit` around line 560, after the existing `const ... = document.getElementById(...)` reads, add:

```javascript
        const usdotRaw = (document.getElementById('usdot').value || '').trim();
        const mcRaw    = (document.getElementById('mc').value    || '').trim();
        const usdot = /^\d{5,8}$/.test(usdotRaw) ? usdotRaw : null;
        const mc    = /^\d{5,8}$/.test(mcRaw)    ? mcRaw    : null;
        if (usdotRaw && !usdot) throw new Error('USDOT must be 5-8 digits.');
        if (mcRaw    && !mc)    throw new Error('MC number must be 5-8 digits.');
```

Then replace the existing plate-validation block (around line 572):

```javascript
        // At least one of plate / USDOT / MC is required. Synthesize the
        // plate when the driver leaves it blank so the backend's min_length=2
        // constraint on plate_text still holds and so the normalized_plate
        // (stripped of the dash) matches what sessions.ts synthesizes from
        // the camera's USDOT OCR fallback.
        let effectivePlate = plateText;
        if (!effectivePlate) {
          if (usdot)    effectivePlate = `DOT-${usdot}`;
          else if (mc)  effectivePlate = `MC-${mc}`;
          else          throw new Error('Enter a license plate or a USDOT / MC number.');
        } else if (effectivePlate.length < 2) {
          throw new Error('Please enter a valid plate number.');
        }
```

- [ ] **Step 4: Send USDOT/MC in the POST body**

Find the `backendRegister('/visitor_passes/register', {...})` call around line 584 and update the payload:

```javascript
        const result = await backendRegister('/visitor_passes/register', {
          property_id: property.id,
          plate_text: effectivePlate,
          visitor_name: driverName,
          company_name: companyName,
          vehicle_type: vehicleType,
          host_unit: '',
          host_name: '',
          phone: phone,
          parking_spot: parkingSpot,
          placard_color: placardColor || null,
          usdot_number: usdot,
          mc_number: mc,
          stay_hours: stayHours,
          policy_acknowledged_at: now.toISOString(),
          submission_idempotency_key: idempotencyKey,
          recaptcha_token: recaptchaToken,
        });
```

Update the `showSuccess` call on the next line to display `effectivePlate` instead of `plateText`:

```javascript
        showSuccess({plate: result.plate_text || effectivePlate, validUntil, stayHours, refId: refId || null, parkingSpot, placardColor, companyName});
```

- [ ] **Step 5: Manual browser smoke test**

Run: `cd /Users/gabe/lotlogic/frontend && python3 -m http.server 8799` (or use the live preview URL).

Open `http://localhost:8799/visit.html?qr=<a truck-plaza qr code>` and verify:
1. USDOT and MC fields render below Placard Color.
2. Submitting with plate only → works.
3. Submitting with USDOT only (no plate) → works; success card shows `DOT-1234567`.
4. Submitting with MC only → works; success card shows `MC-1234567`.
5. Submitting with NOTHING (no plate, no USDOT, no MC) → friendly error "Enter a license plate or a USDOT / MC number".
6. Submitting with `usdot=123` → error "USDOT must be 5-8 digits".

Expected: all six outcomes as described.

- [ ] **Step 6: Commit**

```bash
git add frontend/visit.html
git commit -m "$(cat <<'EOF'
feat(visit.html): USDOT + MC fields on truck-plaza temp pass form

Plate becomes optional when a 5-8 digit USDOT or MC is supplied. The
frontend synthesizes plate_text as DOT-xxxxxxx or MC-xxxxxxx so the
backend plate_text min_length constraint holds and the normalized
plate matches what ParkPow USDOT OCR synthesizes on the camera side.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: resident.html — USDOT + MC fields on truck-plaza branch

**Files:**
- Modify: `/Users/gabe/lotlogic/frontend/resident.html:337-376` (the `showForm` template)
- Modify: `/Users/gabe/lotlogic/frontend/resident.html:379-433` (the `handleSubmit` function)

`resident.html` has a single form with a branch on `isPlaza`. USDOT/MC fields only render when `property.property_type === 'truck_plaza'`.

- [ ] **Step 1: Render USDOT/MC fields conditionally in the template**

In `showForm`, change the template-builder block so it conditionally includes the fields:

Replace the template block (around line 341-372) with:

```javascript
      const extraFields = isPlaza ? `
          <label for="usdot" style="margin-top:14px;">USDOT Number <span style="color:#6b7280;font-size:12px;">(optional, 5-8 digits)</span></label>
          <input type="text" id="usdot" inputmode="numeric" pattern="\\d{5,8}" placeholder="1234567" maxlength="8" autocomplete="off">

          <label for="mc" style="margin-top:8px;">MC Number <span style="color:#6b7280;font-size:12px;">(optional, 5-8 digits)</span></label>
          <input type="text" id="mc" inputmode="numeric" pattern="\\d{5,8}" placeholder="567890" maxlength="8" autocomplete="off">

          <div style="font-size:12px;color:#9ca3af;margin-top:6px;margin-bottom:6px;">If your tractor has no license plate visible, enter your USDOT or MC number so our cameras can identify it.</div>
      ` : '';

      const plateLabel = isPlaza
        ? `License Plate <span style="color:#6b7280;font-size:12px;">(required unless you enter USDOT or MC)</span>`
        : `License Plate <span class="required">*</span>`;
      const plateAttr = isPlaza ? '' : 'required';

      app.innerHTML = `
        <div class="logo">
          <div class="shield">LL</div>
          <h1>Lot<span>Logic</span></h1>
        </div>
        <div class="property-name">
          ${escapeHtml(headline)} at
          <strong>${escapeHtml(property.name)}</strong>
        </div>
        <form id="regForm">
          <label for="holderName">Full Name <span class="required">*</span></label>
          <input type="text" id="holderName" placeholder="John Doe" required>

          <label for="phone">Phone Number <span class="required">*</span></label>
          <input type="tel" id="phone" placeholder="(555) 123-4567" required>

          <label for="plate">${plateLabel}</label>
          <input type="text" id="plate" class="plate-input" placeholder="ABC 1234" ${plateAttr} maxlength="10" autocomplete="off">

          ${extraFields}

          <label for="vehicleType">Vehicle Type <span class="required">*</span></label>
          <select id="vehicleType" required>
            <option value="" disabled selected>Select vehicle type</option>
            <option value="car">Car</option>
            <option value="pickup">Pickup</option>
            <option value="semi">Semi / Truck</option>
            <option value="other">Other</option>
          </select>

          <button type="submit" class="submit-btn" id="submitBtn">${escapeHtml(submitLabel)}</button>
          <div class="hint">Pending owner approval</div>
          <div id="errorMsg"></div>
        </form>
      `;

      document.getElementById('regForm').addEventListener('submit', handleSubmit);
```

- [ ] **Step 2: Update the submit handler to read + validate USDOT/MC**

In `handleSubmit` around line 390, after `const vehicleType = ...`:

```javascript
        const isPlaza = property.property_type === 'truck_plaza';
        const usdotRaw = isPlaza ? ((document.getElementById('usdot') || {}).value || '').trim() : '';
        const mcRaw    = isPlaza ? ((document.getElementById('mc')    || {}).value || '').trim() : '';
        const usdot = /^\d{5,8}$/.test(usdotRaw) ? usdotRaw : null;
        const mc    = /^\d{5,8}$/.test(mcRaw)    ? mcRaw    : null;
        if (usdotRaw && !usdot) throw new Error('USDOT must be 5-8 digits.');
        if (mcRaw    && !mc)    throw new Error('MC number must be 5-8 digits.');

        let effectivePlate = plateText;
        if (!effectivePlate) {
          if (isPlaza && usdot)    effectivePlate = `DOT-${usdot}`;
          else if (isPlaza && mc)  effectivePlate = `MC-${mc}`;
          else                     throw new Error(isPlaza
            ? 'Enter a license plate or a USDOT / MC number.'
            : 'Please enter a valid license plate number.');
        } else if (effectivePlate.length < 2) {
          throw new Error('Please enter a valid license plate number.');
        }
```

Remove the old block at line 396-398 (`if (!plateText || plateText.length < 2) ...`) — the new block above handles it.

- [ ] **Step 3: Send USDOT/MC in the POST body**

Find `backendRegister('/resident_plates/register', {...})` around line 405 and update:

```javascript
          await backendRegister('/resident_plates/register', {
            property_id: property.id,
            plate_text: effectivePlate,
            holder_name: holderName,
            holder_role: property.property_type === 'truck_plaza' ? 'employee' : 'resident',
            vehicle_type: vehicleType || 'car',
            phone: phone,
            usdot_number: usdot,
            mc_number: mc,
            recaptcha_token: recaptchaToken,
          });
```

- [ ] **Step 4: Update the success card**

`showSuccess(plateText)` at line 424 shows the original plate. Change to:

```javascript
        showSuccess(effectivePlate);
```

- [ ] **Step 5: Manual browser smoke test**

Open `http://localhost:8799/resident.html?qr=<truck-plaza qr code>` and verify:
1. USDOT and MC fields render.
2. USDOT-only submission → success card shows `DOT-xxxxxxx`.
3. Plate-only submission (on apartment property) still works (no USDOT fields rendered).
4. Truck-plaza with no plate AND no USDOT AND no MC → "Enter a license plate or a USDOT / MC number".

Expected: all four outcomes as described.

- [ ] **Step 6: Commit**

```bash
git add frontend/resident.html
git commit -m "$(cat <<'EOF'
feat(resident.html): USDOT + MC fields on truck-plaza employee plate form

Truck-plaza branch only. Apartment forms unchanged. Same plate-optional
rule as visit.html: at least one of plate / USDOT / MC required.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: dashboard.html — USDOT/MC in Truck Parking Log + Permanent Plates tables

Dashboard already renders the badges on In Lot Now and Plate Detections (from Task 2). Extend to the two list views where an operator might see a plateless-tractor pass or employee plate: the Truck Parking Log sub-tab and the Permanent Plates tab.

**Files:**
- Modify: `/Users/gabe/lotlogic/frontend/dashboard.html` (grep for `TruckParkingLog` and `PermanentPlates` components to locate)

- [ ] **Step 1: Find the two table components**

Run:
```bash
grep -n "Truck Parking Log\|ParkingLog\|Permanent Plates" frontend/dashboard.html | head -20
```

Identify the JSX rows that render each row of each table. For each, locate the `<td>` (or equivalent) that currently shows `{pass.plate_text}` / `{plate.plate_text}`.

- [ ] **Step 2: Add USDOT/MC badges to the Truck Parking Log rows**

Next to the `plate_text` cell in the Truck Parking Log rendering, insert:

```jsx
{pass.plate_text && pass.plate_text.startsWith('DOT-') && (
  <span title="Matched by USDOT number" style={{marginLeft:6,fontSize:10,fontWeight:700,textTransform:'uppercase',letterSpacing:'.06em',padding:'2px 6px',borderRadius:14,background:'#1d4ed820',color:'#60a5fa',border:'1px solid #3b82f640'}}>USDOT</span>
)}
{pass.plate_text && pass.plate_text.startsWith('MC-') && (
  <span title="Matched by Motor Carrier number" style={{marginLeft:6,fontSize:10,fontWeight:700,textTransform:'uppercase',letterSpacing:'.06em',padding:'2px 6px',borderRadius:14,background:'#1d4ed820',color:'#60a5fa',border:'1px solid #3b82f640'}}>MC#</span>
)}
```

- [ ] **Step 3: Also render raw number if stored separately**

If the Truck Parking Log query selects `pass.usdot_number` / `pass.mc_number`, append below the plate cell:

```jsx
{pass.usdot_number && <div style={{fontSize:11,color:'var(--text-muted)',marginTop:2}}>USDOT {pass.usdot_number}</div>}
{pass.mc_number    && <div style={{fontSize:11,color:'var(--text-muted)',marginTop:2}}>MC {pass.mc_number}</div>}
```

If the query does NOT currently select these columns, extend the `.select(...)` call to include `,usdot_number,mc_number`. Grep for the query near the Truck Parking Log component and add.

- [ ] **Step 4: Add the same badges + detail lines to the Permanent Plates tab rows**

Same pattern. Check whether the Supabase query for `resident_plates` selects `usdot_number,mc_number` — if not, extend the select.

- [ ] **Step 5: Manual smoke test**

Load the dashboard on a truck-plaza property that has at least one USDOT-only pass (create one via visit.html from Task 5 if none exist). Confirm:
1. Truck Parking Log row renders the `USDOT` badge and a `USDOT 1234567` detail line.
2. Permanent Plates row renders the same for an employee-plate USDOT registration.
3. Regular plate rows render without badges (unchanged).

- [ ] **Step 6: Commit**

```bash
git add frontend/dashboard.html
git commit -m "$(cat <<'EOF'
feat(dashboard): USDOT/MC badges + raw-number lines in list views

Adds the same USDOT / MC# badges (already on In Lot Now and Plate
Detections) to Truck Parking Log and Permanent Plates table rows, plus
a small raw-number detail line so operators can read the FMCSA identifier
at a glance.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Push frontend + deploy camera-snapshot edge function

Vercel auto-deploys the frontend on push to main. The edge function needs an explicit CLI deploy.

- [ ] **Step 1: Push frontend**

```bash
cd /Users/gabe/lotlogic && git push origin main
```

Watch the Vercel deploy: `mcp__vercel__list_deployments` or the Vercel dashboard. Wait ~2 min until the new revision is live.

- [ ] **Step 2: Diff the deployed edge function before overwriting**

```bash
mkdir -p .camera-snapshot-live
supabase functions download camera-snapshot --project-ref nzdkoouoaedbbccraoti
```

(or use `mcp__supabase__get_edge_function`.) Confirm the only differences are the new USDOT branches we shipped in Task 2 — not some out-of-band edit made in the Supabase dashboard.

Expected: diff matches Task 2's committed changes.

- [ ] **Step 3: Deploy camera-snapshot**

```bash
supabase functions deploy camera-snapshot --project-ref nzdkoouoaedbbccraoti
```

Expected: `Deployed Function: camera-snapshot`.

- [ ] **Step 4: Tail the logs for 60 seconds**

```bash
supabase functions logs camera-snapshot --project-ref nzdkoouoaedbbccraoti --follow
```

(Or `mcp__supabase__get_logs` with service=edge-function.) Confirm no error spam from the new code on real traffic. Specifically watch for:
- `usdot-ocr matched DOT from label=` lines if ENABLE_USDOT_FALLBACK=true and a plateless tractor has entered
- No `TypeError` in `findActiveResident` / `findActiveVisitorPass`

Ctrl+C after 60 s.

---

## Task 9: End-to-end smoke test

The decisive proof. Register a synthetic DOT-only pass via the QR form, then simulate a camera event that synthesizes `DOT-1234567`, and confirm the state machine opens a `registered` session instead of `grace`.

- [ ] **Step 1: Create a test USDOT pass via the live visit.html**

Open `https://www.lotlogicparking.com/visit.html?qr=<charlotte-travel-plaza-test-qr>` in a browser. Fill:
- Company: "Test Trucking"
- Driver: "Smoke Test"
- Plate: (leave blank)
- USDOT: `9999991`
- MC: (leave blank)
- Stay: 24 hours
- Policy: checked

Submit. Expected: success card shows `DOT-9999991`.

- [ ] **Step 2: Confirm the DB row**

```sql
SELECT plate_text, usdot_number, valid_until FROM visitor_passes
 WHERE usdot_number = '9999991' ORDER BY created_at DESC LIMIT 1;
```

Expected: `plate_text='DOT-9999991'`, `usdot_number='9999991'`, `valid_until` ≈ 24 h from now.

- [ ] **Step 3: Post a synthetic camera event with a DOT plate**

```bash
curl -X POST "https://nzdkoouoaedbbccraoti.supabase.co/functions/v1/camera-snapshot/<camera-api-key>/<url-secret>" \
  -H "Content-Type: application/json" \
  -d '{"device": "test", "plate_synthesized": "DOT-9999991"}'
```

(Note: the real ingest pulls plates from the PR API. For the smoke, patch `camera-snapshot` to honor a `plate_synthesized` debug field in staging, OR set `ENABLE_USDOT_FALLBACK=true` and POST a JPEG of a truck with "USDOT 9999991" painted on the side.)

The cleaner path: skip this step, wait for a real truck-plaza entry event in prod after install day, and verify in the plate_events log.

- [ ] **Step 4: Confirm the session opened as `registered`**

```sql
SELECT state, visitor_pass_id, normalized_plate
  FROM plate_sessions
 WHERE normalized_plate = 'DOT9999991'
 ORDER BY created_at DESC LIMIT 1;
```

Expected: `state='registered'`, `visitor_pass_id` matches the pass ID from Step 2.

- [ ] **Step 5: Clean up the test pass**

```sql
UPDATE visitor_passes SET cancelled_at = now(), cancelled_by = 'smoke_test'
 WHERE usdot_number = '9999991' AND plate_text = 'DOT-9999991';
```

---

## Post-merge: CLAUDE.md housekeeping

- [ ] **Step 1: Update CLAUDE.md pipeline section**

Edit `CLAUDE.md` (the "Camera-based ALPR pipeline" paragraph) to note:
- USDOT / MC are first-class on `visitor_passes` and `resident_plates` (columns + indexes).
- QR forms accept USDOT / MC in addition to license plate.
- Session allowlist match branches on plate prefix (`DOT` / `MC`) to query FMCSA columns.

Keep it to 2-3 sentences — the details live in the specs.

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude.md): USDOT + MC first-class in pipeline (cross-ref specs)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- ✅ Item 1 (migration 015 in repo) → Task 1
- ✅ Item 2 (commit uncommitted code) → Task 2
- ✅ Item 3 (QR forms USDOT/MC) → Tasks 5, 6
- ✅ Item 4 (backend accepts USDOT/MC) → Tasks 3, 4
- ✅ Item 5 (dashboard list views) → Task 7
- ✅ Item 6 (deploy camera-snapshot) → Task 8
- ✅ Item 7 (smoke test) → Task 9
- Bonus: CLAUDE.md update keeps memory honest.

**Placeholder scan:** No TBDs, no "add appropriate error handling", every step has concrete code or a concrete command.

**Type consistency:** `usdot_number` + `mc_number` used consistently across Python Pydantic models, SQL INSERT parameter names, JS payload fields, JSX cell names, and column names. `effectivePlate` defined in both form handlers with the same semantics. `DOT-xxxxxxx` / `MC-xxxxxxx` synthesis rule identical in both frontend files and mirrors what `sessions.ts::extractFmcsaNumber` already expects.
