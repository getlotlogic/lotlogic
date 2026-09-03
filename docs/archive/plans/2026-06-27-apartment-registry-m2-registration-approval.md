# Apartment Permit Registry — Milestone 2 (Registration + Approval + Notifications) Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The end-to-end register→approve loop for Stevensons: a public QR form (resident + guest) that uploads ID/lease/plate-photo to R2 and creates a **pending** pass; leasing/N Style approve or reject (guest 72h starts at approval); documents are served only through an authenticated, scope-checked proxy; email notifications fire to whoever has an email configured (skipping any that don't — N Style's is pending).

**Architecture:** Extend the existing FastAPI backend + the QR-form pattern. Reuse `routers/public_registration.py`, `services/email.py` (SendGrid), the R2 client used by the snapshot/violation pipeline, the `_assert_property_scope` helper, and reСAPTCHA. M1's columns/RLS/accounts are the substrate. No truck-plaza behavior changes (`property_type='apartment'` gates new logic).

**Tech Stack:** FastAPI (pytest), Supabase Postgres (RLS from M1), Cloudflare R2, SendGrid, single-file QR HTML form.

**Repos:** backend in `~/lotlogic-backend` (branch `feat/apartment-permit-registry`); form HTML + plan in `~/lotlogic` (same branch). Migrations via Supabase MCP + committed. Pushes gated.

**Spec:** `~/lotlogic/docs/superpowers/specs/2026-06-27-apartment-permit-registry-design.md`

## Key facts for implementers
- Resident active state = status `'approved'`; guest active state = status `'active'` (different tables, intentional — verified M1).
- Guest `valid_from`/`valid_until` set at **approval** (72h window), not submit.
- Document columns hold **R2 keys**, served via the proxy (T5): `resident_plates.id_doc_url`/`lease_doc_url`/`plate_photo_url`; `visitor_passes.id_photo_url`/`plate_photo_url`.
- Recipient emails: leasing owner `jackerez@friedlam.com` (real); N Style email is NULL (pending) → notifications MUST skip null/empty recipients.
- Find the existing R2 client (grep `R2_` / `boto3` / `put_object` in `routers/`/`services/`) and reuse it; do not hand-roll S3 auth.

## File Structure
- `lotlogic-backend/services/apartment_notify.py` — notification builders + send (skip-missing-email) (T6)
- `lotlogic-backend/routers/public_registration.py` — apartment resident + guest register branches (T2, T3)
- `lotlogic-backend/routers/apartment_docs.py` — upload endpoint (T1) + authenticated doc proxy (T5)
- `lotlogic-backend/routers/apartment_passes.py` — approve / reject endpoints (T4)
- `lotlogic-backend/tests/test_apartment_registration.py`, `test_apartment_approval.py`, `test_apartment_docs.py`
- `lotlogic/frontend/apt.html` — the apartment QR registration form (T7)

---

## Task 1: R2 document upload endpoint (public, reСAPTCHA-gated)

**Files:** Create `routers/apartment_docs.py`; Test `tests/test_apartment_docs.py`. Register the router in `main.py`.

**Contract:** `POST /apartment/uploads` (auth-exempt + reСAPTCHA token field) — multipart file (`image/*` or `application/pdf`, max ~10MB) + `property_id` + `kind` (`id`|`lease`|`plate`) + `recaptcha_token`. Streams to R2 under a non-guessable key `apt/<property_id>/<uuid4>.<ext>`; returns `{ "key": "<key>" }`. Does NOT create a pass — the form holds keys and submits them in T2/T3.

- [ ] **Step 1 (test first):** write `test_upload_returns_key_and_uses_nonguessable_path` — assert a helper `build_doc_key(property_id, kind, filename) -> str` returns `apt/<property_id>/...` with a uuid segment and the original extension, and never contains the raw filename. (Pure function test, no R2.)
- [ ] **Step 2:** run it → fails (import error).
- [ ] **Step 3:** implement `build_doc_key` + the route. Reuse the existing R2 client (grep first). reСAPTCHA via `services.recaptcha.verify_token` (action e.g. `apartment_upload`). Enforce content-type + size. Add `/apartment/uploads` to the auth-exempt list in `main.py` (it's public, like `/visitor_passes/check-active`).
- [ ] **Step 4:** test passes; `ruff check` + `py_compile` clean.
- [ ] **Step 5:** commit `feat: apartment R2 document upload endpoint (reCAPTCHA-gated, non-guessable keys)`.

---

## Task 2: Apartment resident registration

**Files:** Modify `routers/public_registration.py`; Test `tests/test_apartment_registration.py`.

**Contract:** the resident register path, when the property is `apartment`, inserts a `resident_plates` row with `status='pending'`, `registration_source='qr_resident'`, `unit_number`, `holder_name`, `plate_text`, `phone`, `email`, and the three doc keys (`id_doc_url`,`lease_doc_url`,`plate_photo_url`) passed from T1. reСAPTCHA-gated; idempotent. Multiple vehicles = multiple calls/rows.

- [ ] **Step 1 (test):** `test_apartment_resident_creates_pending` — a stub-session insert path produces a row with `status='pending'`, the unit, and the doc keys; reСAPTCHA enforced (missing token → 400). Mirror `tests/test_recaptcha_register.py` harness.
- [ ] **Step 2:** run → fail.
- [ ] **Step 3:** implement the apartment branch (reuse the existing resident register endpoint; branch on `property.property_type`). Do NOT touch the truck-plaza/apartment-guest paths.
- [ ] **Step 4:** test passes; lint/compile clean.
- [ ] **Step 5:** commit `feat: apartment resident registration (pending, with documents)`.

---

## Task 3: Apartment guest registration

**Files:** Modify `routers/public_registration.py`; Test same file.

**Contract:** guest register path for `apartment` inserts a `visitor_passes` row with `status='pending'`, `registration_source='qr_guest'`, `host_unit`, `visitor_name`, `plate_text`, `phone`, `email`, `id_photo_url`, `plate_photo_url`, and the requested duration captured (`stay_days` or a stay-hours field, capped ≤72h). `valid_from`/`valid_until` are left NULL until approval. reСAPTCHA-gated; idempotent.

- [ ] **Step 1 (test):** `test_apartment_guest_creates_pending_no_validity` — row has `status='pending'`, `host_unit`, doc keys, and `valid_from`/`valid_until` NULL (set at approval, not now); duration >72h is rejected/capped.
- [ ] **Step 2:** run → fail.
- [ ] **Step 3:** implement the apartment guest branch.
- [ ] **Step 4:** test passes; lint/compile.
- [ ] **Step 5:** commit `feat: apartment guest registration (pending, 72h capped, validity at approval)`.

---

## Task 4: Approval / rejection endpoints

**Files:** Create `routers/apartment_passes.py`; Test `tests/test_apartment_approval.py`. Register router in `main.py`.

**Contract (owner OR partner scoped via `_assert_property_scope`, allow_partner=True):**
- `POST /apartment/passes/{kind}/{id}/approve` (`kind`=`resident`|`guest`): resident → `status='approved'`; guest → `status='active'`, `valid_from=now()`, `valid_until=now()+interval '72 hours'`. Stamp `reviewed_by`/`reviewed_at`.
- `POST /apartment/passes/{kind}/{id}/reject` (body `{reason}`): `status='rejected'`, `reject_reason`, `reviewed_by`/`reviewed_at`.
- Approval race: only act if currently `pending` (else 409).
- On success, fire notifications (T6) best-effort, deferred (BackgroundTasks) — never block the response.

- [ ] **Step 1 (test):** `test_approve_guest_sets_active_72h` (valid_until == valid_from+72h), `test_approve_resident_sets_approved`, `test_reject_records_reason`, `test_double_approve_409`, `test_cross_tenant_approve_404` (mirror `_assert_property_scope`).
- [ ] **Step 2:** run → fail.
- [ ] **Step 3:** implement both routes with `require_subject` + `_assert_property_scope`; the `pending`-guard 409; BackgroundTasks notify hook (call into T6, which may be a no-op stub until T6 lands — wire the call, T6 fills it).
- [ ] **Step 4:** tests pass; lint/compile.
- [ ] **Step 5:** commit `feat: apartment pass approve/reject (scoped, guest 72h at approval, 409 on non-pending)`.

---

## Task 5: Authenticated document proxy (PII)

**Files:** Modify `routers/apartment_docs.py`; Test `tests/test_apartment_docs.py`.

**Contract:** `GET /apartment/docs/{pass_kind}/{pass_id}/{which}` (`which`=`id`|`lease`|`plate`) — `require_subject` + `_assert_property_scope` (owner/partner of the pass's property); resolves the stored R2 key for that pass+doc, streams the object back with the right content-type. **Never returns a public URL.** Cross-tenant or unknown → 404 (mirror cancel route). This is the ONLY way leasing/N Style view the ID/lease/plate docs.

- [ ] **Step 1 (test):** `test_doc_proxy_requires_scope` (cross-tenant subject → 404), `test_doc_proxy_unknown_pass_404`, `test_doc_proxy_streams_key_for_owner` (stub R2 get → returns bytes for the owner of the property).
- [ ] **Step 2:** run → fail.
- [ ] **Step 3:** implement; reuse the R2 client (get_object); resolve key from the pass row column matching `which`.
- [ ] **Step 4:** tests pass; lint/compile.
- [ ] **Step 5:** commit `feat: authenticated scope-checked apartment document proxy (no public PII URLs)`.

---

## Task 6: Notification framework (skip-missing-email)

**Files:** Create `services/apartment_notify.py`; wire into T2/T3 (on submit) + T4 (on decision); Test `tests/test_apartment_approval.py` / a notify test.

**Contract:**
- `recipients_for_property(db, property_id) -> list[str]` → the leasing owner email + N Style partner email, **dropping any that are null/empty** (N Style's is null now → just leasing today).
- On **submit** (T2/T3): email staff recipients "New apartment registration pending — review in the portal" (NO PII/docs in the body; link to the portal). Best-effort, deferred.
- On **approve/reject** (T4): email the **registrant** (the pass's own `email`, if present) the outcome + reference.
- All sends via `services.email.send_email`; from `dispatch@lotlogicparking.com`; each wrapped so a failure never breaks the request; skip when no recipient.

- [ ] **Step 1 (test):** `test_recipients_skip_null_email` (a property whose partner email is null returns only the owner email), `test_no_pii_in_staff_body` (body contains the reference + portal link but not the plate/name/doc keys).
- [ ] **Step 2:** run → fail.
- [ ] **Step 3:** implement `apartment_notify.py`; replace the T4/T2/T3 notify hooks with real deferred calls.
- [ ] **Step 4:** tests pass; lint/compile.
- [ ] **Step 5:** commit `feat: apartment notifications (staff on submit, registrant on decision; skip missing emails)`.

---

## Task 7: Public QR registration form

**Files:** Create `lotlogic/frontend/apt.html`; Test (esbuild syntax + Playwright smoke if harness available).

**Contract:** mobile-first single-file form reached at `apt.html?qr=<qr_code_id>` (resolve property like `visit.html` does). Landing → **"Resident or Guest?"**. Resident: name, unit, plate + plate photo, ID, lease (file pickers — `accept="image/*,application/pdf"`, NOT forced camera), contact (phone+email), "add another vehicle." Guest: name, unit visiting, plate + plate photo, ID, duration (≤72h), contact. Each file → `POST /apartment/uploads` → hold the returned key; submit → resident/guest register endpoint with the keys. reСAPTCHA. Confirmation screen with reference + "pending approval."

- [ ] **Step 1:** build the form (reuse `visit.html` structure + the reСAPTCHA + pgRest property lookup). Uploads are standard file inputs (gallery/files), one upload call per file, store keys in form state.
- [ ] **Step 2:** extract the script block and run `npx esbuild --loader=jsx` (or plain JS check) → no syntax errors.
- [ ] **Step 3:** Playwright smoke if the harness/secrets exist (form renders, resident/guest toggle, file inputs present, submit blocked without required fields); otherwise careful manual re-read + note.
- [ ] **Step 4:** commit `feat: apartment QR registration form (resident + guest, file uploads, pending submit)`.

---

## Self-Review
- **Spec coverage:** registration form (T7 ✓), uploads (T1 ✓), resident/guest pending (T2/T3 ✓), approval+72h-at-approval (T4 ✓), doc proxy/PII (T5 ✓), notifications skip-missing (T6 ✓). Dashboards + driver lookup → M3.
- **No placeholders:** each task gives the contract, the test names/assertions, and exact endpoints/columns; implementers write code against the existing R2/email/scope patterns (precise contracts, not vague). The notify hook in T4 is explicitly a wire-now/fill-in-T6 to keep tasks independent.
- **Type/name consistency:** statuses (`pending`/`approved`/`active`/`rejected`), columns (`id_doc_url`/`lease_doc_url`/`plate_photo_url`/`id_photo_url`/`host_unit`/`unit_number`/`reviewed_by`/`reviewed_at`/`reject_reason`), endpoints (`/apartment/uploads`, `/apartment/passes/{kind}/{id}/{approve|reject}`, `/apartment/docs/...`) are consistent across tasks and match M1's schema.
