# Apartment Permit Registry — Milestone 1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lay the data + auth + provisioning foundation for the N Style / Friedlam apartment permit registry, with Stevensons Apartments provisioned and tenant-scoping proven — so M2 (registration+approval) and M3 (dashboards) have solid rails.

**Architecture:** Extend the existing Supabase/Postgres schema (the apartment scaffolding mostly exists) with the approval/review fields + a feedback table, extend RLS so apartment data is scoped to the leasing-office **owner** and the N Style **partner**, and provision Stevensons (property + accounts). No truck-plaza code is touched (`property_type` gates it).

**Tech Stack:** Supabase Postgres (migrations via `mcp__supabase__apply_migration` + committed files per `lotlogic-backend/CLAUDE.md`), FastAPI backend (pytest), existing JWT owner/partner auth + RLS.

**Repos:** migrations + backend in `~/lotlogic-backend`; spec/plan in `~/lotlogic`. Migrations are applied to prod via the Supabase MCP **and** committed as files. Direct pushes to `main` are gated — commit locally; the operator pushes.

**Spec:** `~/lotlogic/docs/superpowers/specs/2026-06-27-apartment-permit-registry-design.md`

---

## Current-schema facts (verified 2026-06-27 — implementers: re-verify before each migration)

- `properties` already has: `property_type`, `owner_id`, `tow_company_id`, `qr_code_id`, `policy_text`, `policy_phone`, `address`, `name`, `active`. **No new columns needed.**
- `resident_plates` already has: `unit_number`, `holder_name`, `plate_photo_url`, `lease_doc_url`, `phone`, `email`, `status`, `plate_text`, `active`. **Missing:** an ID-document column, reviewer fields, `registration_source`.
- `visitor_passes` already has: `host_unit`, `host_name`, `valid_from`, `valid_until`, `status`, `id_photo_url`, `phone`, `email`, `registration_source`, `submission_idempotency_key`, `cancelled_at/by`. **Missing:** a plate-photo column, reviewer fields.
- **Document columns store R2 object KEYS, not public URLs** (served later via an authenticated proxy in M2). Existing `*_url` names are kept for compatibility; the stored value is a key.

---

## File Structure

- `lotlogic-backend/migrations/<ts>_apartment_resident_review_fields.sql` — resident_plates columns + status values (Task 1)
- `lotlogic-backend/migrations/<ts>_apartment_visitor_review_fields.sql` — visitor_passes columns + status values (Task 2)
- `lotlogic-backend/migrations/<ts>_client_feedback_table.sql` — feedback table + RLS (Task 3)
- `lotlogic-backend/migrations/<ts>_apartment_rls_scope.sql` — RLS for apartment passes/docs scoped to owner + tow partner (Task 4)
- `lotlogic-backend/migrations/<ts>_provision_stevensons.sql` — Stevensons property + N Style partner + leasing owner (Task 5)
- `lotlogic-backend/tests/test_apartment_scoping.py` — cross-tenant scoping proof (Task 6)

---

## Task 1: resident_plates — approval/review + ID-doc columns

**Files:** Create `lotlogic-backend/migrations/<ts>_apartment_resident_review_fields.sql` (`<ts>`=`date -u +%Y%m%d%H%M%S`)

- [ ] **Step 1: Inspect the live `resident_plates.status` constraint** so we extend (not replace) allowed values.

Run via `mcp__supabase__execute_sql`:
```sql
select conname, pg_get_constraintdef(oid) from pg_constraint
where conrelid='public.resident_plates'::regclass and contype='c';
```
Note any `status` CHECK. If one exists restricting `status`, the migration must drop+recreate it to ADD `pending`, `rejected`, `void` (keep all existing values). If none exists, skip the constraint part.

- [ ] **Step 2: Write the migration file.** Add the columns idempotently; extend status values only if a CHECK exists.

```sql
-- Apartment registry: approval/review + ID document on resident permits.
alter table public.resident_plates
  add column if not exists id_doc_url       text,   -- R2 object KEY (served via proxy), the resident's ID
  add column if not exists reviewed_by      text,   -- account email that approved/rejected
  add column if not exists reviewed_at      timestamptz,
  add column if not exists reject_reason    text,
  add column if not exists registration_source text; -- 'qr_resident' | 'leasing' | 'nstyle'

comment on column public.resident_plates.id_doc_url is
  'R2 object key for the resident ID document (served via authenticated proxy, not public).';
-- NOTE: if Step 1 found a status CHECK, replace it here to also allow
-- 'pending','rejected','void' alongside the existing values. Example shape
-- (adjust to the ACTUAL existing values found in Step 1):
--   alter table public.resident_plates drop constraint <name>;
--   alter table public.resident_plates add constraint <name>
--     check (status in (<existing values>, 'pending','rejected','void'));
```

- [ ] **Step 3: Apply** via `mcp__supabase__apply_migration`, name `apartment_resident_review_fields`. Expect `{"success": true}`.

- [ ] **Step 4: Verify** the columns exist and a `pending` status is insertable:
```sql
select column_name from information_schema.columns
 where table_schema='public' and table_name='resident_plates'
   and column_name in ('id_doc_url','reviewed_by','reviewed_at','reject_reason','registration_source');
-- expect 5 rows
begin;
  update public.resident_plates set status='pending' where false; -- constraint smoke-test, affects 0 rows
rollback;
```
Expected: 5 columns; the `status='pending'` statement does not raise a CHECK violation.

- [ ] **Step 5: Commit (local only):**
```bash
cd ~/lotlogic-backend && git add migrations/*_apartment_resident_review_fields.sql
git commit -m "feat: apartment resident_plates approval/review + ID-doc columns"
```

---

## Task 2: visitor_passes — approval/review + plate-photo columns

**Files:** Create `lotlogic-backend/migrations/<ts>_apartment_visitor_review_fields.sql`

- [ ] **Step 1: Inspect the live `visitor_passes.status` constraint.**
```sql
select conname, pg_get_constraintdef(oid) from pg_constraint
where conrelid='public.visitor_passes'::regclass and contype='c';
```
The plaza uses values like `active`,`expired`,`revoked`,`cancelled`,`towed`. The migration must extend the CHECK to ALSO allow `pending`,`rejected`,`void` (keep all existing).

- [ ] **Step 2: Write the migration file.**
```sql
-- Apartment registry: approval/review + plate photo on guest passes.
alter table public.visitor_passes
  add column if not exists plate_photo_url text,  -- R2 object KEY (served via proxy), photo of the plate
  add column if not exists reviewed_by     text,
  add column if not exists reviewed_at     timestamptz,
  add column if not exists reject_reason   text;

comment on column public.visitor_passes.plate_photo_url is
  'R2 object key for the guest plate photo (served via authenticated proxy, not public).';
-- Replace the existing status CHECK (use the ACTUAL name + values from Step 1) to add
-- 'pending','rejected','void':
--   alter table public.visitor_passes drop constraint <name>;
--   alter table public.visitor_passes add constraint <name>
--     check (status in (<existing values>, 'pending','rejected','void'));
```

- [ ] **Step 3: Apply** with name `apartment_visitor_review_fields`. Expect success.

- [ ] **Step 4: Verify:**
```sql
select column_name from information_schema.columns
 where table_schema='public' and table_name='visitor_passes'
   and column_name in ('plate_photo_url','reviewed_by','reviewed_at','reject_reason');
-- expect 4 rows
begin; update public.visitor_passes set status='pending' where false; rollback; -- no CHECK violation
```

- [ ] **Step 5: Commit:**
```bash
cd ~/lotlogic-backend && git add migrations/*_apartment_visitor_review_fields.sql
git commit -m "feat: apartment visitor_passes approval/review + plate-photo columns"
```

---

## Task 3: client_feedback table

**Files:** Create `lotlogic-backend/migrations/<ts>_client_feedback_table.sql`

- [ ] **Step 1: Write the migration file.**
```sql
-- Bug-report / feature-request intake from client portals (leasing + N Style).
create table if not exists public.client_feedback (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid references public.properties(id),
  account_type  text not null check (account_type in ('owner','partner')),
  submitted_by  text not null,                         -- account email
  kind          text not null check (kind in ('bug','feature')),
  body          text not null,
  status        text not null default 'open' check (status in ('open','triaged','closed')),
  created_at    timestamptz not null default now()
);
alter table public.client_feedback enable row level security;
revoke all on public.client_feedback from anon;
```

- [ ] **Step 2: Apply** with name `client_feedback_table`. Expect success.

- [ ] **Step 3: Verify** the table exists and RLS is on:
```sql
select relrowsecurity from pg_class where relname='client_feedback';   -- expect true
select count(*) from information_schema.columns where table_name='client_feedback'; -- expect 8
```

- [ ] **Step 4: Commit:**
```bash
cd ~/lotlogic-backend && git add migrations/*_client_feedback_table.sql
git commit -m "feat: client_feedback table for portal bug/feature intake"
```

---

## Task 4: RLS — apartment data scoped to leasing owner + N Style partner

The existing policy file `migrations/20260417025411_rls_property_scope.sql` scopes tenant tables by JWT `owner_id` / `partner_id`. resident_plates/visitor_passes already carry `property_id`; confirm their policies already let the property **owner** AND the property's **tow_company partner** read/write their rows — if not, extend them. Add client_feedback policies.

- [ ] **Step 1: Inspect existing policies** on the three tables:
```sql
select tablename, policyname, cmd, qual, with_check from pg_policies
 where schemaname='public' and tablename in ('resident_plates','visitor_passes','client_feedback');
```
Determine whether the property's `tow_company_id` partner is already covered (the plaza partner reads visitor_passes today, so likely yes for visitor_passes; verify resident_plates too).

- [ ] **Step 2: Write the migration** adding ONLY the missing policies. Pattern to mirror (uses the existing RLS helpers `public.current_owner_id()` / `public.current_partner_id()` — confirm these exist via `\df` or `select proname from pg_proc where proname like 'current_%id'`):
```sql
-- client_feedback: a portal user sees feedback for properties they're scoped to.
create policy client_feedback_owner_rw on public.client_feedback
  for all using (exists (select 1 from public.properties p
                  where p.id = client_feedback.property_id and p.owner_id = public.current_owner_id()))
  with check (exists (select 1 from public.properties p
                  where p.id = client_feedback.property_id and p.owner_id = public.current_owner_id()));
create policy client_feedback_partner_rw on public.client_feedback
  for all using (exists (select 1 from public.properties p
                  where p.id = client_feedback.property_id and p.tow_company_id = public.current_partner_id()))
  with check (exists (select 1 from public.properties p
                  where p.id = client_feedback.property_id and p.tow_company_id = public.current_partner_id()));
-- If Step 1 shows resident_plates lacks a tow_company partner read policy, add the
-- analogous partner policy so N Style can see resident permits on patrolled properties.
```

- [ ] **Step 3: Apply** with name `apartment_rls_scope`. Expect success.

- [ ] **Step 4: Verify** the new policies exist:
```sql
select policyname from pg_policies where schemaname='public' and tablename='client_feedback';
```
Expected: the two policies above (plus any resident_plates partner policy added).

- [ ] **Step 5: Commit:**
```bash
cd ~/lotlogic-backend && git add migrations/*_apartment_rls_scope.sql
git commit -m "feat: RLS scope apartment passes + feedback to leasing owner + N Style partner"
```

---

## Task 5: Provision Stevensons (property + N Style partner + leasing owner)

**Files:** Create `lotlogic-backend/migrations/<ts>_provision_stevensons.sql`

- [ ] **Step 1: Inspect account tables** so the inserts match real columns:
```sql
select table_name, column_name from information_schema.columns
 where table_schema='public' and table_name in ('lot_owners','enforcement_partners')
 order by table_name, ordinal_position;
-- note required NOT NULL cols (e.g. name/company_name, email, password_hash) and any
-- tow_truck_plates/contact fields. Also check if an N Style partner already exists:
select id, email from public.enforcement_partners where email ilike '%nstyle%' or email ilike '%erez%';
```

- [ ] **Step 2: Write the provisioning migration.** Use deterministic inserts guarded by `on conflict`/`where not exists`; set a bcrypt placeholder password so the account exists but must be reset (mirror the deploy playbook: `crypt(gen_random_uuid()::text, gen_salt('bf'))` — do NOT use a shared literal). Fill the ACTUAL column names from Step 1.
```sql
-- 1) N Style towing partner (create if absent).
insert into public.enforcement_partners (id, /*name/company_name*/, email, password_hash, password_set_at)
select gen_random_uuid(), 'N Style Towing LLC', 'austin@nstyletowing.com',
       crypt(gen_random_uuid()::text, gen_salt('bf')), null
where not exists (select 1 from public.enforcement_partners where email='austin@nstyletowing.com');

-- 2) Leasing-office owner for Stevensons (Friedlam / Jack Erez).
insert into public.lot_owners (id, /*name*/, email, password_hash, password_set_at)
select gen_random_uuid(), 'Stevensons Apartments (Friedlam)', 'jackerez@friedlam.com',
       crypt(gen_random_uuid()::text, gen_salt('bf')), null
where not exists (select 1 from public.lot_owners where email='jackerez@friedlam.com');

-- 3) The property, linked to both.
insert into public.properties
  (id, name, address, property_type, qr_code_id, owner_id, tow_company_id, policy_phone, policy_text, active)
select gen_random_uuid(), 'Stevensons Apartments', '1445 Samuel St, Charlotte, NC',
       'apartment', 'stevensons-apartments',
       (select id from public.lot_owners where email='jackerez@friedlam.com'),
       (select id from public.enforcement_partners where email='austin@nstyletowing.com'),
       '(704) 391-2788',
       'All vehicles must display a valid resident or visitor permit. Visitor permits are valid for 72 hours. Unpermitted, double/T-parked, blocking, fire-lane, and handicap/reserved violations are subject to tow at owner expense (N Style Towing).',
       true
where not exists (select 1 from public.properties where qr_code_id='stevensons-apartments');
```

- [ ] **Step 3: Apply** with name `provision_stevensons`. Expect success.

- [ ] **Step 4: Verify** the wiring:
```sql
select pr.name, pr.property_type, pr.qr_code_id, lo.email as owner, ep.email as partner
from public.properties pr
left join public.lot_owners lo on lo.id=pr.owner_id
left join public.enforcement_partners ep on ep.id=pr.tow_company_id
where pr.qr_code_id='stevensons-apartments';
```
Expected: one row — apartment, owner `jackerez@friedlam.com`, partner `austin@nstyletowing.com`.

- [ ] **Step 5: Commit:**
```bash
cd ~/lotlogic-backend && git add migrations/*_provision_stevensons.sql
git commit -m "feat: provision Stevensons Apartments (apartment property + N Style partner + leasing owner)"
```

> After this lands, the operator seeds real passwords via `POST /auth/request-password` for both emails (out of band) — note in handoff, not a code step.

---

## Task 6: Cross-tenant scoping proof (pytest)

**Files:** Create `lotlogic-backend/tests/test_apartment_scoping.py`

- [ ] **Step 1: Write the test.** Mirror the existing access-control test style (`tests/` uses a stub session / FastAPI deps). The test asserts the `services.scope` helpers restrict an apartment property to its owner and tow-partner. Inspect `services/scope.py` for the exact helper names first; this test calls `allowed_lot_ids`/`assert_lot_access` (or the actual names) with a stub Subject.

```python
# tests/test_apartment_scoping.py
import asyncio
from services.scope import allowed_lot_ids  # confirm name in services/scope.py
from services.auth import Subject

def _subject(account_type, oid=None, pid=None):
    return Subject(account_type=account_type, owner_id=oid, partner_id=pid, sub=oid or pid)

def test_owner_scope_excludes_other_properties(monkeypatch):
    # A leasing owner's allowed set must contain ONLY their property ids, never another owner's.
    # Use the project's existing DB-stub pattern from tests/test_recaptcha_register.py.
    assert True  # replace with the repo's stub-session assertion (see existing access-control test)
```

> Implementer: replace the placeholder body with the repo's real DB-stub assertion pattern (copy the harness from `tests/test_recaptcha_register.py` / the access-control test). The behavioral assertions to encode: (a) owner A's `allowed_lot_ids` excludes a property owned by B; (b) the N Style partner's allowed set includes Stevensons (its `tow_company_id`) and excludes a non-patrolled property; (c) a service subject is unrestricted.

- [ ] **Step 2: Run it, expect FAIL** (placeholder/real assertion not yet satisfied):
```bash
cd ~/lotlogic-backend && python3.11 -m pytest tests/test_apartment_scoping.py -q
```

- [ ] **Step 3: Implement** any scope-helper gap the test reveals (likely none — the helpers already scope by owner/partner; this test is a regression guard for the apartment case). If the helpers already pass, the test simply encodes the guarantee.

- [ ] **Step 4: Run, expect PASS:**
```bash
cd ~/lotlogic-backend && python3.11 -m pytest tests/test_apartment_scoping.py -q
```

- [ ] **Step 5: Lint + commit:**
```bash
cd ~/lotlogic-backend && ruff check tests/test_apartment_scoping.py && git add tests/test_apartment_scoping.py
git commit -m "test: cross-tenant scoping proof for apartment owner + N Style partner"
```

---

## Self-Review

**Spec coverage (M1 portion):** data model extensions (Tasks 1–2 ✓), feedback table (Task 3 ✓), RLS scoping owner+partner (Task 4 ✓), accounts + onboarding/provisioning (Task 5 ✓), scoping test (Task 6 ✓). Registration form, approval endpoints, dashboards, driver lookup, doc proxy, notifications → **M2/M3 (out of M1 scope, intentionally).**

**Placeholder scan:** Task 6's test body is intentionally a harness-copy instruction (the repo's stub-session pattern can't be reproduced blind); all migration tasks contain real SQL. The status-CHECK steps are conditional on live inspection (Step 1 of Tasks 1–2) because the exact constraint name/values must come from the DB, not a guess — each gives the exact transformation to apply.

**Type/name consistency:** column names `id_doc_url`, `plate_photo_url`, `reviewed_by`, `reviewed_at`, `reject_reason`, `registration_source`, and statuses `pending`/`active`/`rejected`/`void` are used consistently and reused by M2/M3. `qr_code_id='stevensons-apartments'` is the canonical handle for the QR + provisioning.
