# Sub-project E — Internal LotLogic Admin Portal (the Frame) — Design

**Date:** 2026-06-29
**Status:** Approved-to-build (user: "build the frame before filling it" / "keep going, reviewing and revising")
**Builds on:** the existing `is_platform_admin` identity + the apartment registry (Phase 1) + temp-tag detection (D).

## Intent

A LotLogic-facing (NOT client-facing) console where we run the business: see every
client across types, **onboard a new client end-to-end** without hand-writing SQL,
and triage the bug/feature reports clients submit. This spec builds the **frame** —
all sections wired and working on the happy path — then we fill in depth iteratively.

## Foundation that already exists (do not rebuild)

- `lot_owners.is_platform_admin` (bool) → captured in the login JWT → `Subject.is_platform_admin`
  and `Subject.is_unrestricted` (service key OR platform admin) which already bypasses tenant
  scope at the API layer. So a platform-admin account can already read/act across all tenants
  **through the backend**.
- **Constraint that falls out:** Supabase RLS still filters the browser by `owner_id`/`partner_id`
  claims — a platform admin reading direct from the Supabase client would NOT see other tenants.
  Therefore the admin portal reads/writes go through the **backend** (`apiFetch`), never direct Supabase.
- Accounts: `lot_owners` (owner/leasing), `enforcement_partners` (tow partner). Field-allowlisted
  creation exists in `routers/lots.py` (`create_owner`, `create_partner`). Passwords are seeded via
  the existing reset-token flow (`/auth/request-password` → token → `/auth/set-password`); no email.
- `properties`: `owner_id`, `partner_id`, `tow_company_id`, `property_type ∈ (apartment, truck_plaza)`,
  `policy_text`, `policy_phone`, name/address. Apartment onboarding must set BOTH `partner_id` AND
  `tow_company_id` to the tow partner (the Phase-1 lesson).
- `client_feedback`: `id, property_id, account_type, submitted_by, kind ∈ (bug,feature), body,
  status ∈ (open,triaged,closed), created_at`.

## The Frame (v1 scaffold)

**Auth guard — `require_platform_admin`.** A new FastAPI dependency: resolve `require_subject`,
then allow only `subject.is_unrestricted` (service key OR platform admin); else 403. All `/admin/*`
endpoints use it. (Today's `create_owner`/`create_partner` gate on `is_service` only — the admin
portal uses a platform-admin JWT, so we need this broader guard for the new routes.)

**Surface — a separate internal page `frontend/admin.html`.** Not linked from the client dashboard,
never shipped into the client experience. Reuses the dashboard's login + `apiFetch` + `localStorage`
session. On load: if the logged-in account is not a platform admin (probe via a `GET /admin/whoami`
that 403s for non-admins), show an "access denied / sign in as an admin" state and nothing else.
Three sections, each working happy-path, built to refine:

1. **Clients overview** — `GET /admin/clients` returns every property across tenants:
   `id, name, address, property_type, owner_email, partner_email, tow_company_id`, and a small set of
   live counts (active passes, open violations) computed per property. Rendered as a table with a
   type badge. This is the spine the rest hangs off.

2. **Onboard new client** — `POST /admin/clients`, one transactional create:
   - Input: property `{name, address, property_type}`; optional new owner `{name, email}`; optional
     new tow partner `{name, email}` (or reference an existing `partner_id`).
   - Action (single tx): insert the property; if a new owner/partner is given, create those accounts
     (field-allowlisted) with a generated password-reset token each; link `properties.owner_id`,
     `partner_id`, and — for apartments — `tow_company_id = partner_id`.
   - Returns the created ids + **password-setup links** (the reset-token URLs) for each new account,
     so we hand them off manually (no email, per current policy).
   - A wizard form in `admin.html` (property fields → type select → owner fields → partner fields →
     submit → show the setup links to copy).

3. **Feedback inbox** — `GET /admin/feedback` lists `client_feedback` across all tenants (newest
   first, with the property name joined); `PATCH /admin/feedback/{id}` sets `status ∈ (open,triaged,closed)`.
   A simple list with a status control.

## Data flow
Browser (admin JWT) → `apiFetch('/admin/...')` → backend `require_platform_admin` → unrestricted
queries across all tenants → JSON. No direct Supabase reads in admin.html.

## Out of scope (fill later)
Per-client deep dashboards (reuse the existing dashboard for that), editing/deactivating clients,
billing/revenue rollups, audit log, role management beyond the single admin flag, emailing setup
links, analytics. The frame must make these easy to add, not include them.

## Security notes
- Every `/admin/*` route gated by `require_platform_admin`. No `owner_id`/`partner_id` accepted from
  the client as a scope override (the admin bypass is identity-derived, like the rest of the codebase).
- Account creation stays field-allowlisted (no setting `password_hash`/`is_platform_admin`/`active`
  via the splat). The onboarding endpoint must NOT let the caller set `is_platform_admin` on a new owner.
- Setup links contain a reset token — treat them like passwords in the UI (show once, copy button).

## Testing
- `require_platform_admin`: platform-admin subject passes; owner/partner (non-admin) → 403; service → passes.
- `GET /admin/clients`: returns cross-tenant rows for an admin (SQL-builder asserted); non-admin → 403.
- `POST /admin/clients`: creates property + accounts + links in one tx; apartment sets tow_company_id=partner_id;
  rejects `is_platform_admin` in the owner payload; returns setup links.
- `GET/PATCH /admin/feedback`: lists across tenants; status transition validated; bad status → 422; non-admin → 403.
- `admin.html`: esbuild/`node --check` clean; non-admin probe shows the denied state.
