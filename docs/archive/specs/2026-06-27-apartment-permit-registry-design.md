# Apartment Permit Registry (N Style / Friedlam) — Phase 1 Design

**Date:** 2026-06-27
**Status:** Draft — pending user review
**Pilot property:** Stevensons Apartments, 1445 Samuel St, Charlotte NC
**Patrol partner:** N Style Towing LLC · **Property group:** Friedlam (Jack Erez)

## Purpose & context

A new vertical, **separate from the NMLD / truck-plaza system**: a resident + visitor
**parking-permit registry** for apartment/townhome communities patrolled by **N Style
Towing**. Every vehicle on the property must be permitted; visitors register for a
limited window; enforcement is **N Style physically patrolling + looking up plates**
(no cameras / no ALPR here — this is the key difference from the plaza).

Pilot is Stevensons; the same system is intended to scale to the ~10 N Style/Friedlam
communities (Fort Mill & Rock Hill SC) listed in the N Style service agreement. The
design must therefore make **onboarding a new community easy and repeatable**.

Rules taken from the N Style service agreement:
- Every vehicle must display a valid **permit (resident or visitor)**; no permit = tow.
- **Visitor permits last 72 consecutive hours.**
- Tow/booting is at owner expense ($275 impound, $35/day storage, $75 dollies — billed
  to the vehicle owner, never the community).
- Behavioral/condition violations (double-/T-parked, blocking, fire lane, handicap,
  expired/fake tags, abandoned, etc.) are handled by the patrol; the registry's job is
  to answer "is this plate permitted, and who is it?" Behavioral-violation *capture* is
  not automated in Phase 1.

## Scope

**In scope (Phase 1):**
1. Public **registration form** (resident + guest) with document uploads.
2. **Data model** for apartment permits (extends the existing tables).
3. **Approval workflow** + notifications (shared queue; either party approves).
4. **Leasing-office dashboard** (full pass control for their property).
5. **N Style portal** — admin (pass control) + driver (in-lot plate lookup).
6. **Accounts / sign-in** for leasing office + N Style, and a clean **onboarding path**.
7. **Feedback / bug-report** channel in both portals.

**Out of scope (later, separate specs):**
- **D — 30-day temp-tag vs regular-plate auto-detection** (format/Plate-Recognizer based).
- **E — Internal LotLogic client-management portal** (self-serve onboarding UI across
  client types: apartments + commercial trucking). Phase 1 lays the data rails for it.

**Explicitly NOT building:** cameras/ALPR, automated tow dispatch, the plaza's 24h
cooldown, payment processing.

## Approach

Extend the existing LotLogic platform rather than build greenfield. Reuse:
`properties.property_type='apartment'`, the QR-form pattern (`visit.html`/`resident.html`),
R2 object storage, the owner/partner JWT auth + RLS scoping, the dashboard SPA, SendGrid
email, and the soft-expire cron. New work is additive (new columns, new endpoints, new
form + portal views), keeping the truck-plaza system untouched (`property_type` gates it).

## Accounts, auth & onboarding

- **Leasing office → `lot_owners` ("owner") account**, scoped to its property via
  `properties.owner_id`. Full control of that property's passes.
- **N Style → `enforcement_partners` ("partner") account**, scoped to patrolled
  properties via `properties.tow_company_id` (same mechanism NMLD uses on the plaza).
- **Residents / guests → no account**; public reСAPTCHA-gated QR form.
- **Sign-in:** existing `POST /auth/login` → JWT; first-time password via the existing
  `/auth/request-password` → set-password link. Dashboards live behind this, auto-scoped.
- **Onboarding a community (repeatable provisioning path):** create (1) the `properties`
  row (`property_type='apartment'`, address, `qr_code_id`, N Style `policy_text`),
  (2) the leasing-office owner account, (3) set **both `partner_id` AND `tow_company_id`
  = the N Style partner** (the RLS chain scopes the tow partner via `partner_id`; setting
  only `tow_company_id` leaves the partner unable to see any of the property's data —
  verified during M1), (4) generate the QR sign. Phase 1 does this via an admin provisioning step (script or
  the existing dashboard); sub-project E later wraps it in an "Add Client" UI. The data
  model is shaped so E supports both apartments and commercial trucking with no rework.

## Data model

Reuse the existing split, extended with apartment fields (the planned `parking_passes`
unification is **not** a blocker — keep current tables):

- **Residents → `resident_plates`** (permanent permit). New columns:
  `status` (`pending`/`active`/`rejected`/`void`), `unit`, `id_doc_key`,
  `lease_doc_key`, `plate_photo_key`, `contact_phone`, `contact_email`,
  `reviewed_by`, `reviewed_at`, `reject_reason`, `registration_source`.
- **Guests → `visitor_passes`** (temporary 72h permit) on an apartment property. New/used
  columns: `status` (same set), `host_unit`, `id_doc_key`, `plate_photo_key`,
  `contact_phone`, `contact_email`, `valid_from`/`valid_until` (72h from **approval**),
  `reviewed_by`, `reviewed_at`, `reject_reason`. (No lease for guests.)
- **Documents** live in R2 under **non-guessable keys** (`apt/<property>/<passid>/<type>`);
  only the key is stored, never a public URL.
- **Multiple vehicles per unit** = multiple `resident_plates` rows sharing a `unit`.
- **No cooldown** for apartments (truck-plaza cooldown triggers stay gated to
  `property_type='truck_plaza'`).

## Registration form (public QR)

One QR per property → mobile-first landing → **"Resident or Guest?"** → branched form.

- **Resident:** name, **unit**, plate (tag) + **plate photo**, **ID**, **lease (photo/PDF)**,
  contact (phone + email), "add another vehicle." → Submit → **Pending**.
- **Guest:** name, **unit visiting**, plate + **plate photo**, **ID**, **duration (≤72h)**,
  contact (phone + email). → Submit → **Pending**.
- **Uploads are standard file pickers** (`accept="image/*,application/pdf"`) — the user
  picks an existing photo/PDF from their phone; **camera capture is not forced**.
- reСAPTCHA-gated; idempotent submission key (dupe-tap safe); uploads POST to a backend
  endpoint that streams to R2 (no anonymous direct writes).
- Confirmation screen: **reference number** + "Pending approval — you'll be notified" +
  the property's contact.

## Approval workflow & notifications

- Submit → **Pending**, in **one shared queue** visible to the leasing office **and**
  N Style. **Either** can **Approve** or **Reject (reason required).**
- On approve: resident → ongoing `active`; guest → `active` with **72h starting now**.
- On reject: `rejected` + reason recorded; registrant notified.
- Approval **race**: first writer wins; the second gets a 409 and sees the resolved state.
- **Notifications:** on submit → email to leasing office + N Style ("new request," link
  into the portal — **no PII/docs in the email body**). On approve/reject → notify the
  registrant (email; SMS optional later) with outcome + reference.
- Residents practically approved by the leasing office (lease verification); guests by
  either. Both parties *can* act on either type.

## Leasing-office dashboard

Owner account, scoped to its property. Reuses the existing dashboard SPA patterns.
- **Approval queue** with the uploaded ID/lease/plate photo (via the secure proxy).
- **Full pass control:** add a pass directly (no conditions), edit, **extend guest
  passes**, **void/revoke**, manage residents + guests.
- Search by plate / unit / name; filters by status.

## N Style portal

Partner account, scoped to patrolled properties.
- **Admin page:** same approval queue + pass control across patrolled properties.
- **Driver page (in-lot, mobile-first):** enter/scan a plate → instant verdict —
  **✓ Permitted** (resident · unit, or guest · time-left) or **❌ Not registered.**
  Lookup-only in Phase 1 (plus the feedback button); no extra driver write-actions yet.

## Feedback / bug-report

A "Report a bug / Request a feature" control in **both** portals → short form → stores a
`client_feedback` record + emails LotLogic. Seeds sub-project E's triage view.

## Security (PII — must not get wrong)

- **ID and lease documents are sensitive PII.** Stored in R2 under non-guessable keys,
  served **only** through an **authenticated, scope-checked backend proxy** (leasing +
  N Style for that property). **No public URLs. No PII in emails.**
- Every tenant-scoped endpoint uses `require_subject` + the `services.scope` helpers, and
  RLS enforces the same scope at the DB. New apartment tables/columns extend the RLS
  policies so a leasing office sees only its property and N Style only patrolled lots.
- Public form endpoints are reСAPTCHA-gated and accept no caller-supplied owner/partner id.

## Error handling

- Idempotent submissions (`submission_idempotency_key`).
- Upload failure never loses the registration (best-effort; the pass row persists).
- Guest 72h auto-expiry via the existing soft-expire cron (`active` → `expired` past
  `valid_until`); apartments included by `property_type`.
- Approval race → first-wins / 409.
- Document proxy returns 404 (not 403) on cross-tenant access, mirroring the cancel route.

## Testing

- **Backend pytest:** registration endpoints (resident + guest), approval transitions,
  guest 72h window math, and **cross-tenant scoping** (leasing A can't see property B;
  N Style sees only patrolled lots) — the canonical access-control proof.
- **Document-proxy auth test:** unauthenticated / cross-tenant fetch is denied.
- **Playwright e2e:** the QR form (both paths, file upload), the approval queue, the
  leasing dashboard pass actions, and the N Style driver lookup verdict.

## Open assumptions (correct if wrong)

1. Phase 1 includes the **N Style portal** (admin + driver), not just leasing — i.e. the
   full register→approve→manage→lookup loop, so Stevensons is fully operational at launch.
2. Residents register **per vehicle**; one unit can have several. Resident permits are
   **ongoing** (no expiry) until voided; renewal/expiry is a later refinement.
3. Notifications are **email** in Phase 1 (SendGrid); registrant SMS is optional later.
4. No payment in Phase 1 (permits are free to register; towing fees are N Style's, billed
   to the vehicle owner per their agreement).

## Future sub-projects (rails laid, built later)

- **D —** 30-day temp-tag vs regular-plate auto-detection (format + Plate Recognizer).
- **E —** Internal LotLogic client-management portal: self-serve onboarding + oversight
  across client types (apartments + commercial trucking), and feedback triage.
