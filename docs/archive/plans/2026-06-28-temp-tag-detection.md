# Temp-Tag Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recognize a guest's 30-day paper temp tag at registration (by format or self-declare), track its expiry, and surface "temp tag / expiring / expired" on the dashboard + N Style lookup so an expired temp tag feeds the agreement's expired-tag tow path.

**Architecture:** A small, single-source classifier (`services/temp_tag.py`) with a configurable pattern list; the guest-registration path sets `is_temp_tag` + `tag_expiration`; the existing apartment permits-list and lookup endpoints surface the flag; the guest QR form (`apt.html`) gains a checkbox + expiry date, and the dashboard + `lookup.html` render the label/expired state. No camera/Plate Recognizer (apartment plates are typed). Reuses all Phase-1 scope/auth machinery.

**Tech Stack:** FastAPI (pytest), Supabase Postgres (one additive boolean column), single-file `dashboard.html` (React+Babel) + `apt.html`/`lookup.html`, all on branch `feat/apartment-permit-registry`.

**Spec:** `~/lotlogic/docs/superpowers/specs/2026-06-28-temp-tag-detection-design.md`

## Key facts (read before starting)
- Branch: both repos on `feat/apartment-permit-registry`. Backend `~/lotlogic-backend`, frontend `~/lotlogic`. Pushes are GATED — commit only, do not push.
- Local python is 3.9 but the code uses `str | None` — use **`python3.11`** for py_compile/pytest. PIL is not installed → `tests/test_*` for `routers.snapshots` is a **pre-existing** failure, not a regression.
- Migrations: name `YYYYMMDDHHMMSS_snake_name.sql` (`date -u +%Y%m%d%H%M%S`), apply via `mcp__supabase__apply_migration` (records the schema_migrations row), AND commit the file under `~/lotlogic-backend/migrations/`.
- `visitor_passes` already has `tag_expiration date` (nullable, currently unused) — REUSE it. We add only `is_temp_tag boolean`.
- Apartment guest registration lives in `routers/public_registration.py` (`register_visitor_pass` → `_register_apartment_guest`, source `qr_guest`, inserts a `pending` row with NULL validity). Truck-plaza guests go through the same `register_visitor_pass` but a different branch — DO NOT change truck-plaza behavior.
- Apartment permits list + lookup live in `routers/apartment_passes.py` (`build_guest_list_sql`, `build_lookup_sql`). The guest form is `frontend/apt.html`; the N Style page is `frontend/lookup.html`; the dashboard apartment view is the `ApartmentPermits` component in `frontend/dashboard.html`.
- User-facing naming rule: never "guest/visitor/resident/temporary" as a *label*. The user-facing term for this feature is **"Temp tag"** (a tag type, not a pass type — allowed). The form checkbox label is **"Temporary / paper tag"**.

## File Structure
- `lotlogic-backend/services/temp_tag.py` — NEW. The classifier + configurable patterns + expiry helper. Single source of truth.
- `lotlogic-backend/tests/test_temp_tag.py` — NEW. Classifier + expiry unit tests.
- `lotlogic-backend/migrations/<ts>_visitor_passes_is_temp_tag.sql` — NEW. Add the boolean column.
- `lotlogic-backend/routers/public_registration.py` — MODIFY. Apartment guest branch sets `is_temp_tag` + `tag_expiration`.
- `lotlogic-backend/routers/apartment_passes.py` — MODIFY. `build_guest_list_sql` + `build_lookup_sql` select/return temp-tag fields; lookup verdict gains the expired-temp-tag flag.
- `lotlogic-backend/tests/test_apartment_management.py` — MODIFY. List/lookup temp-tag assertions.
- `lotlogic-backend/tests/test_recaptcha_register.py` — MODIFY only if the stub needs the new insert params (keep existing tests green).
- `frontend/apt.html` — MODIFY. Guest branch: "Temporary / paper tag" checkbox + conditional expiry-date input + pass `is_temp_tag`/`tag_expiration` to the register call.
- `frontend/dashboard.html` — MODIFY. `ApartmentPermits` guest rows show "Temp tag" + expires/EXPIRED.
- `frontend/lookup.html` — MODIFY. Verdict shows temp-tag line + expired flag.

---

## Task 1: Temp-tag classifier + expiry helper (the single source of truth)

**Files:** Create `services/temp_tag.py`; Create `tests/test_temp_tag.py`.

**Contract:**
- `TEMP_TAG_PATTERNS: list[str]` — module-level list of regex strings (case-insensitive, matched against the normalized plate). Seed with conservative NC/SC paper-tag shapes and a clear comment that these are **refined later with real examples** (framework now, tuning later). Seed values (documented as provisional):
  - `r"^T\d{6,7}$"` (a "T"-prefixed temporary number)
  - `r"^\d{8,}$"` (8+ pure digits — paper tags are often all-numeric and longer than the 6-7 char standard plate)
- `normalize(plate: str) -> str` — uppercase, strip non-alphanumerics. (Mirror `_normalize_plate` in public_registration so they agree; if importing it is clean, import it instead of duplicating — prefer import.)
- `is_temp_tag_format(plate: str | None, state: str | None = None) -> bool` — returns True iff the normalized plate is non-empty AND matches any pattern. Empty/None/placeholder (`""`, normalized empty) → False. Conservative: no match → False.
- `temp_tag_expiration(registered_on: date, printed_expiry: date | None) -> date` — returns `printed_expiry` if given, else `registered_on + timedelta(days=30)`.

- [ ] **Step 1 (test):** write `tests/test_temp_tag.py`:
```python
from datetime import date, timedelta
from services.temp_tag import is_temp_tag_format, temp_tag_expiration, normalize

def test_normalize_strips_and_uppercases():
    assert normalize(" t-123456 ") == "T123456"

def test_t_prefixed_temp_detected():
    assert is_temp_tag_format("T123456") is True
    assert is_temp_tag_format("t-123456") is True

def test_long_numeric_temp_detected():
    assert is_temp_tag_format("12345678") is True

def test_standard_plate_not_temp():
    assert is_temp_tag_format("ABC1234") is False
    assert is_temp_tag_format("HXR9920") is False

def test_empty_or_none_not_temp():
    assert is_temp_tag_format("") is False
    assert is_temp_tag_format(None) is False

def test_expiry_uses_printed_date_when_given():
    d = date(2026, 6, 1)
    assert temp_tag_expiration(d, date(2026, 6, 20)) == date(2026, 6, 20)

def test_expiry_falls_back_to_30_days():
    d = date(2026, 6, 1)
    assert temp_tag_expiration(d, None) == d + timedelta(days=30)
```
- [ ] **Step 2:** `python3.11 -m pytest tests/test_temp_tag.py -v` → FAIL (module missing).
- [ ] **Step 3:** implement `services/temp_tag.py` per the contract. Compile regexes once at import (`_COMPILED = [re.compile(p, re.I) for p in TEMP_TAG_PATTERNS]`). Document the provisional patterns.
- [ ] **Step 4:** `python3.11 -m pytest tests/test_temp_tag.py -v` → PASS. `ruff check services/temp_tag.py tests/test_temp_tag.py` clean. `python3.11 -m py_compile services/temp_tag.py`.
- [ ] **Step 5:** commit `feat: temp-tag format classifier + expiry helper (configurable patterns, single source)`.

---

## Task 2: Add the `is_temp_tag` column (migration)

**Files:** Create `migrations/<ts>_visitor_passes_is_temp_tag.sql`.

**Contract:** additive, safe for the live truck-plaza rows (defaults false). Apply + commit.

- [ ] **Step 1:** create the migration file (use `date -u +%Y%m%d%H%M%S` for `<ts>`):
```sql
-- Sub-project D: flag a guest pass whose plate is a 30-day paper temp tag.
-- Additive + defaulted, so existing truck-plaza + apartment rows are unaffected.
-- Expiry reuses the existing visitor_passes.tag_expiration column.
alter table public.visitor_passes
  add column if not exists is_temp_tag boolean not null default false;
```
- [ ] **Step 2:** apply via `mcp__supabase__apply_migration` (name = filename minus the timestamp prefix; this records the schema_migrations row).
- [ ] **Step 3:** verify live: `mcp__supabase__execute_sql` →
```sql
select column_name, data_type, column_default
from information_schema.columns
where table_name='visitor_passes' and column_name in ('is_temp_tag','tag_expiration');
```
Expected: `is_temp_tag boolean default false`, `tag_expiration date`.
- [ ] **Step 4:** commit the migration file `feat: visitor_passes.is_temp_tag column (temp-tag detection)`.

---

## Task 3: Set is_temp_tag + tag_expiration at guest registration

**Files:** Modify `routers/public_registration.py`; Modify `tests/test_recaptcha_register.py` (stub) if needed; add a focused test.

**Contract:** in the **apartment guest** branch only (`_register_apartment_guest` / the `qr_guest` path):
- Accept two new optional request fields on the visitor-pass request model: `is_temp_tag: bool = False` and `tag_expiration: date | None = None` (only meaningful for apartment guests; truck-plaza ignores them).
- Compute the effective flag: `temp = bool(body.is_temp_tag) or is_temp_tag_format(plate_text)`.
- If `temp`: set the insert's `is_temp_tag = true` and `tag_expiration = temp_tag_expiration(today_utc, body.tag_expiration)`. Else: `is_temp_tag = false`, `tag_expiration = NULL`.
- Add both columns to the apartment guest INSERT (and to the existing-row idempotency SELECT return is NOT required). Do NOT alter the truck-plaza INSERT path or its columns.
- `today_utc = datetime.now(timezone.utc).date()`.

- [ ] **Step 1 (test):** add to `tests/test_recaptcha_register.py` (the apartment-guest path uses the same handler; extend the stub `_StubSession` to capture `is_temp_tag`/`tag_expiration` params on the apartment insert and to accept the new columns). Add:
  - `test_apartment_guest_temp_by_checkbox_sets_flag_and_expiry` — body with `is_temp_tag=True`, `tag_expiration=date(2026,7,1)`, an apartment property path → inserted row has `is_temp_tag=True` and `tag_expiration=2026-07-01`.
  - `test_apartment_guest_temp_by_format_sets_30day` — `plate_text="T123456"`, no checkbox, no date → `is_temp_tag=True`, `tag_expiration == today+30`.
  - `test_apartment_guest_regular_plate_not_temp` — `plate_text="ABC1234"`, no checkbox → `is_temp_tag=False`, `tag_expiration is None`.
  (Reuse the existing apartment-guest test scaffolding already in this file or in the apartment tests; if the apartment branch is keyed off a property lookup the stub must return an `apartment` property — mirror however the existing apartment-guest tests set that up. If no apartment-guest unit test exists yet, key the branch decision so the test can drive it directly.)
- [ ] **Step 2:** `python3.11 -m pytest tests/test_recaptcha_register.py -v` → new tests FAIL.
- [ ] **Step 3:** implement: add the two model fields; import `from services.temp_tag import is_temp_tag_format, temp_tag_expiration`; compute + thread into the apartment guest insert params + SQL column list.
- [ ] **Step 4:** `python3.11 -m pytest tests/test_recaptcha_register.py -v` → PASS (all existing tests still green). `ruff` + `py_compile`. Full suite (`python3.11 -m pytest -q`) — note the pre-existing `routers.snapshots`/PIL failure is expected.
- [ ] **Step 5:** commit `feat: detect + persist temp tag at apartment guest registration (checkbox or format → is_temp_tag + tag_expiration)`.

---

## Task 4: Surface temp-tag state in the permits list + lookup

**Files:** Modify `routers/apartment_passes.py`; Modify `tests/test_apartment_management.py`.

**Contract:**
- `build_guest_list_sql`: also select `is_temp_tag`, `tag_expiration`, and a computed `tag_expired` boolean (`(is_temp_tag and tag_expiration is not null and tag_expiration < current_date) as tag_expired`). Include them in the returned guest dicts.
- `build_lookup_sql`: also select `is_temp_tag`, `tag_expiration` for the matched guest. In the lookup handler, when the matched record is a temp tag, add to the response `detail`: `is_temp_tag: true`, `tag_expiration`, and `tag_expired` (bool). Keep the existing `verdict` values unchanged (resident/guest/expired_guest/not_registered) — temp-tag is **additional detail on the existing verdict**, not a new verdict. (An expired-temp-tag guest whose 72h window is still open is still `guest`, but with `tag_expired=true` so N Style sees it's tow-eligible via the expired-tag path.)

- [ ] **Step 1 (test):** add to `tests/test_apartment_management.py`:
  - `test_build_guest_list_sql_selects_temp_tag_fields` — assert the SQL string selects `is_temp_tag`, `tag_expiration`, and computes `tag_expired` with `current_date`.
  - `test_build_lookup_sql_selects_temp_tag_fields` — assert the lookup SQL selects `is_temp_tag` + `tag_expiration`.
  - (If the existing tests build expected SQL by substring, match that style.)
- [ ] **Step 2:** `python3.11 -m pytest tests/test_apartment_management.py -v` → new tests FAIL.
- [ ] **Step 3:** implement the SQL + handler changes.
- [ ] **Step 4:** `python3.11 -m pytest tests/test_apartment_management.py -v` → PASS. `ruff` + `py_compile`. Full suite (note the PIL pre-existing failure).
- [ ] **Step 5:** commit `feat: surface temp-tag + expired flag in apartment permits list and N Style lookup`.

---

## Task 5: Guest form fields + dashboard/lookup display

**Files:** Modify `frontend/apt.html`, `frontend/dashboard.html`, `frontend/lookup.html`. Verify via esbuild + (Playwright if creds available).

**Contract:**
- `apt.html` (guest branch only): add a **"Temporary / paper tag"** checkbox. When checked, reveal a **"Tag expiry date"** `<input type="date">` (optional — helper text: "leave blank and we'll assume 30 days"). On submit, include `is_temp_tag` (bool) and `tag_expiration` (the date string or null) in the register POST body. Do NOT add `capture` to any input (per the earlier requirement, uploads come from the phone library). Resident branch unchanged.
- `dashboard.html` `ApartmentPermits` guest rows: if `guest.is_temp_tag`, render a small **"Temp tag"** chip; if `guest.tag_expiration`, show `expires <date>`; if `guest.tag_expired`, show a red **"EXPIRED"** badge. Reuse existing chip/badge styles. Residents + truck-plaza views unchanged.
- `lookup.html`: when the result `detail.is_temp_tag`, add a line under the verdict: active → "Temp tag · expires <date>"; `detail.tag_expired` → an amber/red "Temp tag EXPIRED — eligible for the expired-tag (48-hr-warning) tow path" line. Keep the big green/red verdict as-is.

- [ ] **Step 1:** read the guest branch in `apt.html`, the `ApartmentPermits` guest-row render in `dashboard.html`, and the verdict render in `lookup.html`; implement the three changes following existing patterns.
- [ ] **Step 2:** extract each file's script block and syntax-check: `apt.html`/`lookup.html` via `node --check`; `dashboard.html` babel block via `npx esbuild --loader=jsx --bundle=false` (or the project's existing extract-and-esbuild step) → exit 0. Clean up any extracted temp files (they're gitignored).
- [ ] **Step 3:** Playwright smoke if creds/harness exist: load `apt.html` for the Stevensons property, tick the checkbox → the date field appears; submit → the POST body carries `is_temp_tag=true`. Else careful re-read + note that live verification is pending the user's push/deploy.
- [ ] **Step 4:** commit `feat: temp-tag checkbox + expiry on guest form; temp-tag/EXPIRED display in dashboard + N Style lookup`.

---

## Self-Review
- **Spec coverage:** classifier w/ configurable patterns (T1 ✓), `is_temp_tag` column reusing `tag_expiration` (T2 ✓), detection by checkbox OR format + accurate/fallback expiry at guest registration (T3 ✓), dashboard label + expired + lookup expired-tag flag feeding the tow path (T4 backend + T5 frontend ✓). Out-of-scope items (residents, PR photo path, auto-tow) intentionally excluded.
- **No placeholders:** every backend task has the contract, test code/names, and exact SQL fragments; the migration SQL is complete; the frontend task names the exact components/files and the existing styles to reuse.
- **Type/name consistency:** column `is_temp_tag` (bool) + `tag_expiration` (date) everywhere; computed `tag_expired` (bool) in list/lookup; request fields `is_temp_tag`/`tag_expiration`; classifier `is_temp_tag_format`/`temp_tag_expiration`/`normalize`; verdicts unchanged (`resident`/`guest`/`expired_guest`/`not_registered`) with temp-tag as added detail. UI label "Temp tag" / checkbox "Temporary / paper tag".
- **Truck-plaza safety:** every backend change is gated to the apartment guest branch or is additive-with-default; truck-plaza insert path + triggers untouched.
