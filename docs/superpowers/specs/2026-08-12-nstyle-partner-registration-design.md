# N Style partner registration + apartment-SaaS earnings removal

**Date:** 2026-08-12 · **Status:** approved (Gabe) · **Repos:** `lotlogic-backend` (API), `lotlogic` (frontend)

## Scope

1. The N Style partner login can register parking passes from its dashboard, for every apartment property it enforces.
2. All earnings/invoice surfaces tied to the apartment-SaaS model are removed: N Style pays a SaaS subscription, so no per-tow fees, no revenue share, no QuickBooks invoices.
3. **PARKED:** a second Stevensons leasing-office login. Waiting on email confirmation from Gabe. Design preserved in "Parked" section below — do not implement yet.

## Verified live-DB facts (2026-08-12)

- `jackerez@friedlam.com` (`e4d1b518…`) is the **active owner account of the 9 non-Stevensons Friedlam complexes**, password never set. NOT a Stevensons leftover. Left untouched and dormant per Gabe.
- Stevensons is owned by `stevensonmgr@slnusbaum.net` (`f290ae64…`).
- N Style (`278111f8…`, office@nstyletowing.com) is `tow_company_id` for all 10 apartment properties. NMLD (`1826b6b4…`) is the truck-plaza partner.
- Legacy `lots` has exactly **one row** (Charlotte Travel Plaza [TEST], partner NMLD). N Style and all apartment owners have **zero** `lots` rows → "has no legacy lots" is the derivable SaaS gate; no new flag needed.
- `pending_invoices` is empty; zero apartment `alpr_violations`; no pg_cron job calls weekly invoicing → the QB pipeline is dormant, disabling it for apartments changes nothing retroactively.

## Feature A — Partner pass registration

### Backend (`lotlogic-backend`)

- **Migration:** `visitor_passes.registered_by_partner_id UUID NULL REFERENCES enforcement_partners(id)`. Nullable, additive.
- **Refactor:** extract the apartment-guest insert path (`routers/public_registration.py::_register_apartment_guest`, :170-319) into a shared function both callers use. Must preserve, in order: plate normalization + min length, property-type routing, temp-tag detection/expiration, stay cap (≤3 days, CHECK-coupled), supersede UPDATE, INSERT column set, idempotency-key absorption (`uq_visitor_passes_idempotency`), trigger-error translation, notification hooks (`notify_submitted`/`notify_decision`).
- **New endpoint** (partner-authenticated, per `auth-scoping-pattern`):
  - `require_subject`; reject unless `subject.type == 'partner'`.
  - Property must exist, `property_type == 'apartment'`, and `tow_company_id == subject.id` — else 404 (scope-shaped, not 403).
  - No reCAPTCHA. Body mirrors the public form minus photos: `property_id, plate_text, visitor_name, host_unit, phone?, email?, stay_hours (1–72), is_temp_tag, tag_expiration?, submission_idempotency_key`.
  - Inserts with `status='active'` immediately (the partner registering **is** the approval), `registration_source='partner'`, `registered_by_partner_id = subject.id`.
  - Doc-key validation skipped (no photo keys accepted in v1 — avoids opening the unauthenticated `/apartment/uploads` surface to a new caller).
- **Tests:** partner of another property → 404; owner token → rejected; truck-plaza property → rejected; idempotent replay → 200 same row; attribution + source stamped; resulting row satisfies `plate_matcher._find_candidates` predicates (`status='active'`, `valid_from<=now<valid_until`).

### Frontend (`lotlogic/frontend/dashboard.html`)

- ALPRPropertiesPage property card (~:12546): **"Register a parking pass"** button, shown only when `user._role === 'partner' && p.property_type === 'apartment'` (NMLD's truck-plaza card must not get it; `p.property_type` already on the card, :12536).
- Modal: plate (normalized), name, unit, phone, email (optional), length of stay, paper-tag checkbox + optional expiration date. Idempotency key minted when the modal opens (mirrors apt.html:679). Submits via `apiFetch` to the new endpoint. On success, close + toast; the realtime roster subscription picks the pass up with no extra wiring.
- Copy obeys the naming rule: "parking pass" only — never guest/visitor/temporary.

### Why nothing else breaks (traced 2026-08-12)

- **Backend readers of `visitor_passes`:** zero `SELECT *` anywhere; every response model is explicit-columns. New nullable column is invisible to all of them.
- **Frontend readers:** `getVisitorPasses`/`getActiveRoster` select `*` (column rides along inertly); realtime subscriptions are full-row, no projection. The one explicit column list (fraud/confirmation query, dashboard.html:7363) simply won't show attribution — fine.
- **Edge functions/crons** (camera-snapshot, sessions, no-reg sweep, plate-pair, dispatch): all explicit-column selects keyed on plate/status/dates; none assume phone/email/photos exist. The only `registration_source` branch is `truck_plaza_exit.ts:223` (`=== 'app'`), truck-plaza-only — an apartment pass with `'partner'` never reaches it.
- **Enforcement pipeline:** `plate_matcher` selects on `status/valid_from/valid_until/plate` only; a partner-registered active pass matches exactly like an approved public one.
- **Public form unchanged:** reCAPTCHA, doc-key validation, pending flow, and all three BEFORE INSERT triggers stay exactly as-is; the refactor only relocates code.

## Feature B — Apartment-SaaS earnings/invoices removal

### Frontend

- Owner **Earnings** + **Billing** tabs hidden when `!isPlatformAdmin && lots.length === 0` — in navTabs (:14219-14220), the valid-tabs coercion list (:13858), and the tab renders (:14379, :14381). Apartment owners see neither (today they'd see $0/empty). Gabe (platform admin) and any legacy lot owner are exempt by the gate itself.
- Partner Account tab: **PartnerFeeEditor** (:8705) hidden by the same zero-legacy-lots gate → N Style loses the boot/tow fee editor, NMLD (one lots row) keeps it. **TowTruckPlatesEditor stays** — tow-truck plate matching is live functionality at apartments.

### Backend

- `run-weekly-invoicing` drafting SQL (routers/quickbooks.py:222-259) excludes `property_type = 'apartment'`. Since only apartment properties carry `tow_company_id`, this makes the drafting a no-op until a non-apartment property ever sets it — which is the intent: nobody on SaaS gets per-tow invoices. Endpoints stay; `/quickbooks/pending-invoices` will simply return nothing for apartment scopes.
- No data migration: `pending_invoices` is empty, nothing to void.

### Why nothing else breaks

- The fee columns (`boot_fee/tow_fee/revenue_share/lotlogic_tow_fee_cents`) keep their values; dispatch emails or future flows reading them are unaffected — we remove *editing/billing surfaces*, not data.
- The legacy `violations` revenue system is keyed on `lots` and never touched apartments.
- `PATCH /partners/{id}` and the Supabase self-update GRANT remain (the UI just stops offering fee edits to zero-lot partners).
- Partner Activity tab shows counts only, no money — no change needed.

## Parked — Stevensons leasing-office login (do not build until email confirmed)

Design that survives the blast-radius review, for when Gabe supplies the email:

- New `lot_owners` row (the leasing email) + nullable `lot_owners.login_for_owner_id → lot_owners(id)` pointing at the manager row.
- **Split-brain fix (required):** the backend authorizes off JWT `sub` only (`services/auth.py:240`); RLS uses the `owner_id` claim. So at login, `subject_from_claims` must resolve the **effective** identity: `Subject.id = login_for_owner_id` (manager) for all scoping, plus a `Subject.login_id = sub` used **only** by `/auth/me`'s account-row lookup and `/auth/change-password` (so the alias changes its *own* password, never the manager's). `/auth/login` must return `subject.id` = manager id — the frontend uses `session.id` for every query filter, and RLS `current_owner_id()` must agree with it.
- Known behaviors to disclose: notification emails resolved via `properties.owner_id` still go to the manager only; the alias row never appears in `/admin/clients` (property-driven); `/auth/me` self-heal merges admin flags — alias rows must never be platform admins.
- Constraint: `ix_lot_owners_email_active` — the alias email must not collide with any active account email.

## Out of scope / explicitly not changed

- Jack Erez's account: untouched, dormant (no password link prepared — Gabe's call 2026-08-12).
- Photo upload from the partner modal (v1 cut).
- Public QR registration flow, truck-plaza registration, pending-approval flow for public apartment registrations.
- Truck-plaza billing/cooldown-tow billing.
