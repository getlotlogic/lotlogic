# Wave 2.2 + 2.3 — One Tenancy Model with RBAC in One Place, and One Site-Onboarding Command

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "All nine N Style sites" becomes a query instead of nine `owner_id` comparisons; a leasing office gets three named staff logins instead of one shared password; the four disagreeing copies of *"does this login own this property"* become one function that a build-breaking test keeps everyone using; every admin action that moves money leaves a server-written row nobody's browser can drop; and standing up site #12 becomes one `POST` whose request body **is** the new-site checklist — every column written, both QR ids minted, the policy image uploaded, setup links and a printable QR sheet handed back, no SQL and no deploy.

**Why one plan:** 2.3 writes the rows 2.2 defines. An onboarding endpoint that creates a property but no `organizations` / `users` / `memberships` rows is the *third* half-complete property-creation path, next to the two that already exist. The program doc says so directly: *"2.2 before 2.3 (onboarding writes org and membership rows)."*

**Architecture:** Three new tables (`organizations`, `users`, `memberships`) plus one column (`properties.organization_id`) sit *beside* `lot_owners` and `enforcement_partners`, which stay exactly where they are — they are the billing/fee entities, and their ids are what every production RLS policy and every issued JWT is keyed on. An organization is the new name for one legacy account (`organizations.legacy_owner_id` / `legacy_partner_id`); a user is a person with their own password; a membership is `(user, org, role)`. A login therefore resolves to a `users` row, but the JWT it gets still carries the `owner_id` / `partner_id` claim taken from **the organization's** legacy link — so a brand-new staff login satisfies today's `properties_authenticated_select` RLS policy with **zero RLS changes**, and today's owner and partner logins keep working byte-for-byte through the whole rollout. On top of those rows, `services/tenancy.py` becomes the single ownership answer; `routers/visitor_passes._assert_property_scope` keeps its name and signature (`routers/plaza_payments.py` imports it and is on the never-edit list) and its body becomes one delegating line. A route-walk test over `main.app.routes` fails the build when an endpoint has neither a guard dependency nor an entry in `main.PUBLIC_PATHS`. `admin_audit_log` is written inside the mutating transaction, replacing a browser-side insert into a table **that does not exist in production**. Then `POST /admin/sites` merges the two property-creation paths into one.

**Tech Stack:** Python 3.11, FastAPI, SQLAlchemy 2 async + asyncpg, Supabase Postgres 17 behind a supavisor SESSION-mode pooler, pytest + pytest-asyncio (strict), ruff 0.16.5 pinned with `select = ["E4","E7","E9","F"]`, Railway deploy from `main`; frontend React 18 + esbuild 0.28.2 modules under `frontend/src/` (Wave 2.6 landed), Vercel from `dist/`, Playwright.

**Spec:** `/Users/gabe/lotlogic/docs/superpowers/specs/2026-09-03-enterprise-readiness-program.md` — §3 Wave 2 rows **2.2** and **2.3**; systemic move **S3**; Appendix A findings **PLATFORM-8, DB-13, BACKEND-6, SEC-4, SEC-6, SEC-8, SEC-12, FE-16** (2.2) and **PLATFORM-1, PLATFORM-11** (2.3).

**Revision:** post-preflight (`.superpowers/sdd/2026-09-14-wave2-2-tenancy-rbac-onboarding/preflight.md`). Nine blocking defects and four fix-in-plan items are closed; the corrections that matter most to an executor are called out in the Facts table and in scope calls 6 and 11–13. In particular: **`violations.gross_revenue` holds cents**, **`organizations` carries no foreign keys and is never truncated**, **`upload_bytes` takes `(data, key, content_type)` and returns a tuple**, and **the QR sheet is `qr-sheet.html`, not a dashboard tab**.

---

## Global Constraints

Every task's requirements implicitly include this section.

### Never edit these files

`routers/plaza_payments.py`, `services/plaza_settle.py`, `services/plaza_sweep.py`, `services/square*.py`, `services/stripe_plaza.py`, and the paid branch of `frontend/src/visit.js`. The Stripe cutover owns them.

**This constraint has teeth in this plan.** `routers/plaza_payments.py` line 76 does `from routers.visitor_passes import _assert_property_scope`. That import path and that function's `(db, subject, property_id, *, allow_partner)` signature are therefore **frozen for the life of this plan**. Task 4 changes the function's *body* to one delegating line and nothing else. Any task that proposes renaming or moving it is wrong.

### Tenancy and security

- **No route path changes.** Not one. Every path that answers today answers identically after this plan. New paths are added (`POST /admin/sites`, `GET /admin/sites/{id}/policy-image`…); nothing is renamed, nothing is redirected, nothing is deprecated out from under a caller.
- **Today's owner and partner logins keep working through the entire rollout.** Every task must leave `POST /auth/login` accepting the same credentials with the same result. Task 2's backfill is what makes this true; run it before Task 9 changes what login reads.
- **`lot_owners` and `enforcement_partners` are not deleted, renamed, or emptied.** They stay as the fee/billing entities and as the identities every RLS policy resolves. `DB-13`'s "three identity tables" becomes "two legacy account tables plus one person table with an explicit link between them", not "one table" — collapsing them is a Wave 3 migration with an RLS rewrite attached, and this plan is explicitly the additive half.
- **A scope miss is 404, never 403.** `services/scope.py`'s comment says why: 403 tells the caller the row exists. The one existing helper that returns 403 (`routers/resident_plates._assert_property_scope`, for a non-owner subject) is corrected to 404 in Task 4, and that is a deliberate, recorded behaviour change.
- **Do not accept `owner_id`, `partner_id` or `organization_id` as a client-supplied query parameter on any tenant-scoped route.** `tests/test_no_client_tenant_id.py` enforces the first two; Task 3 adds the third to `FORBIDDEN_PARAM_NAMES`.
- **Platform-admin gates.** Every `/admin/*` and `/ops/*` route uses `Depends(require_platform_admin)`, which admits the shared `X-API-Key` service subject and a platform-admin JWT and rejects everything else with 403. New admin routes in this plan use it unchanged — do not invent a second admin gate.

### Migrations (Wave 2.4 runner conventions)

- File name `migrations/YYYYMMDDHHMMSS_snake_case_name.sql` in the **backend** repo (`/Users/gabe/lotlogic-backend`), 14-digit UTC timestamp from `date -u +%Y%m%d%H%M%S`. `scripts/db/migrate.sh` hard-errors on any other filename.
- **Additive only, with exactly one written-down exception.** No `DROP TABLE`, no `DROP COLUMN`, no `ALTER COLUMN … TYPE`, no narrowing `CHECK` on an existing column, no `NOT NULL` added to an existing column. Every statement in this plan is `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `INSERT … WHERE NOT EXISTS`, or `UPDATE … WHERE col IS NULL`. Re-running any migration in this plan must be a no-op.
  **The exception is Task 1's `CREATE OR REPLACE FUNCTION public.is_platform_admin()`.** It is required, not optional — see scope call 12 and Gabe decision D10 — and it is still re-runnable. No other existing object is redefined anywhere in this wave.
- **No foreign key from `organizations` to `lot_owners` or `enforcement_partners`.** `enforcement_partners` is truncated between every pay-to-park test and `TRUNCATE … CASCADE` follows referencing tables; an FK there would carry the cascade into `organizations`, then `properties.organization_id`, then the session-scoped plaza seed and every pass and event row hanging off it. Plain `uuid` columns plus two partial unique indexes. `organizations` is **never** added to `TRUNCATE_TABLES`.
- **Every new fixture owns its rows.** Mint uuids inside the fixture, insert your own `properties` / `lot_owners` / `organizations` rows, delete them in teardown. Never `UPDATE` a seeded row (`seed_truck_plaza` asserts on the plaza property, and `properties` is deliberately not truncated), and never use a constant id in a table that is not truncated — the second use dies on the primary key.
- **Any test that executes a whole migration file goes through the raw asyncpg connection**, as `tests/plaza/conftest.py::_apply_schema` does and documents: the asyncpg dialect sends one prepared statement, which cannot carry multiple commands or a dollar-quoted block.
- Apply via the Supabase MCP `apply_migration` or the Supabase CLI — **never** the raw SQL editor, which does not record in `supabase_migrations.schema_migrations`.
- Every new table gets `ENABLE ROW LEVEL SECURITY` and `REVOKE ALL … FROM anon, authenticated` **in the same file**. The backend reaches these tables as the service role; no PostgREST client reads them.
- A new column on `public.properties` is **not** granted to `anon`. Production revoked the table-level SELECT and granted back a named column list (`20260707170000_properties_anon_column_scope.sql`), so a new column is private by default. Task 12 grants exactly one new column to `anon` on purpose, and says why in the file.
- `migrations/0000_baseline*` artifacts are never edited.
- After production is migrated, regenerate **all three** derived artifacts together — `scripts/db/expected_schema.sql`, `scripts/db/expected_census.txt`, `docs/db/schema.md` — with `scripts/db/regen_expected.sh <PROD_URL>`. They go stale together; never regenerate one. This is a human step, never CI, never an agent (Task 17).
- Add each new migration's glob to `tests/plaza/conftest.py::MIGRATION_GLOBS` so the real-Postgres harness replays it. `20260914*.sql` is one glob covering every migration in this plan.

### Tests

- **Real Postgres.** Anything that asserts on rows goes in `tests/plaza/`, which runs against an actual Postgres 17 (CI service container via `TEST_DATABASE_URL`; locally an `initdb` cluster; **skips** with a reason if neither). Tests in that package get `@pytest.mark.asyncio` automatically from the package's collect hook; every coroutine test **outside** it needs its own marker (pytest-asyncio is in strict mode and there is no ini file).
- New tables used by tests go in `TRUNCATE_TABLES` in `tests/plaza/conftest.py`, and any table a test needs that `tests/plaza/schema/live_schema.sql` does not create must be added there (it has `properties` and `enforcement_partners` but **not** `lot_owners`).
- **Every test in this plan must be able to fail.** A test that passes against the unfixed code is not a test. Where that is non-obvious — the route-walk gate especially — the task includes a step that *proves* the failure mode by running the checker against a deliberately unguarded fixture app.
- Backend CI gate, all three, before a backend commit counts as done:
  ```bash
  ruff check . && python -m compileall -q -f . && pytest -x --tb=short -q
  ```
  `ruff.toml` stays `select = ["E4","E7","E9","F"]`, `ignore = ["E712","E701"]`. Do not widen it. There is no formatter.
- CI must stay green on both jobs: `lint-and-test` **and** `schema-rebuild` (baseline + every post-baseline migration must rebuild production's schema and match the committed census byte-for-byte).
- Frontend gate, from the frontend repo:
  ```bash
  cd frontend && npm ci && npm run build && npm test && npm run check:naming
  cd ../tests && BASE_URL=http://localhost:8252 npm run visual:check
  ```
  and the `e2e (local dist)` job must stay green (it builds `frontend/`, serves `dist/` on `:8252`, and runs the self-serving specs, the DOM no-op gate and the unauthenticated a11y sweep).

### Naming, secrets, entity

- **Dashboard naming rule, enforced by `npm run check:naming`:** the only user-facing pass noun is **parking pass**. Never write Resident, Visitor, Permanent, Temporary, Guest or Driver in rendered copy, `aria-label`, `alt`, `title` or `placeholder`. Database and symbol names keep their legacy words (`resident_plates`, `visitor_passes`, `holder_role`). New user-facing copy in this plan — the onboarding form, the QR sheet, the runbook — is written under this rule from the first draft. "Organization", "site", "login", "role", "owner", "partner", "operator" are all allowed.
- **No secrets in any repo.** New settings are `config.py` `Settings` fields read through `get_settings()`. Never a literal, never a personal email or phone as a default value.
- **No PII in an alert body or an ops finding.** The audit table is a different thing — it is the record of who did what, and it legitimately stores an actor email. Nothing from it is ever forwarded to an alert body.
- **LotLogic is a separate entity.** Nothing in this plan touches, imports from, or writes to Standard Water, The NC Standard Vending Company, the Pokémon machines, or the `gabe-brain` estate. The `brain.*` schema that lives in this database is LotLogic's own and is out of scope here.

### Repo mechanics

- **Backend worktree:** `/Users/gabe/lotlogic-backend-tenancy` on branch `wave2/tenancy-rbac`, off `origin/main`:
  ```bash
  git -C /Users/gabe/lotlogic-backend fetch origin
  git -C /Users/gabe/lotlogic-backend worktree add -b wave2/tenancy-rbac \
      /Users/gabe/lotlogic-backend-tenancy origin/main
  ```
  **Note:** `/Users/gabe/lotlogic-backend` itself is 124 commits behind `origin/main`. Never read the current state of the code from it.
- **Frontend worktree:** `/Users/gabe/lotlogic-fe-tenancy` on branch `wave2/tenancy-frontend`, off `origin/main`:
  ```bash
  git -C /Users/gabe/lotlogic fetch origin
  git -C /Users/gabe/lotlogic worktree add -b wave2/tenancy-frontend \
      /Users/gabe/lotlogic-fe-tenancy origin/main
  ```
  **Note:** `/Users/gabe/lotlogic` is on `feat/apartment-permit-registry`, dirty, and its `frontend/dashboard.html` is the pre-Wave-2.6 14k-line file. The real frontend is `origin/main`'s `frontend/src/` module tree.
- **Do not push to either `main` without asking.** Railway auto-deploys the backend from `main`; Vercel auto-deploys the frontend from `main`. There is no staging.
- **Commits:** one per task, Conventional Commits with a scope (`feat(tenancy):`, `fix(auth):`, `test(guards):`, `docs:`), a wrapped body saying *why*, and the trailers:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_012CxJpLkSpNFeXLVTrUfhWo
  ```

---

## Facts verified against production on 2026-09-14 — use these, do not re-derive them

| Thing | Value |
|---|---|
| `organizations`, `users`, `memberships` | **Do not exist.** No name collision in `public`. |
| `properties` | 11 rows; **every one** has `qr_code_id`, `owner_id`, `partner_id`, `tow_company_id`, `policy_text`. `market_id` is set on 1 of 11 (Charlotte). `organization_id` does not exist. |
| `properties.tow_company_id` vs `partner_id` | **Equal on all 11 rows** (`count(*) FILTER (WHERE tow_company_id IS DISTINCT FROM partner_id) = 0`). Widening the partner branch to `tow_company_id OR partner_id` is a no-op today and matches both RLS and the frontend's `scopePropsToPartner`. |
| `properties.qr_code_id` shape | A slug: `charlotte-travel-plaza`, `villas-at-1825`, `fort-mill-townhomes-iii`. `UNIQUE`. Consumed as `/temp/<qr>` and `/perm/<qr>` (Vercel rewrites → `visit.html` / `resident.html`). |
| `lot_owners` | 7 rows. 2 are `is_platform_admin`. One row — **`Stevensons Apartments (Friedlam)`** — owns **9** properties and has **no password set**; its login has never been used. That row is the nine-site organization. **N Style is the tow partner, not the owner** — an `enforcement_partners` row. The program doc's "all nine N Style sites" phrasing names the sites by who tows at them; the owning company is Friedlam. |
| `enforcement_partners` | 3 rows. `markets` has exactly 1 row. |
| `properties.app_enabled` | `false` on all 11 (Wave 1 item 13 turned the plaza's off). `pay_to_park_enabled` likewise false on all 11. |
| `action_logs` | **`to_regclass('public.action_logs')` is NULL — the table does not exist.** `frontend/src/lib/db.js:370` inserts into it on every boot/tow and swallows the error in a `console.warn`. Every tow audit record ever "written" was discarded. This is SEC-8, and it is worse than the finding's wording. |
| `permitted_vehicles` | Also does not exist (same origin: the untrusted `supabase-schema.sql`). Out of scope; recorded for fat decision 11. |
| `violations.gross_revenue` / `our_revenue` | **Hold CENTS**, despite the unsuffixed names. Proof, three ways: `models.ViolationUpdate.gross_revenue  # in cents`; `POST /violations/{id}/action` (violations.py:509-512) assigns `partner.boot_fee_cents` / `tow_fee_cents` straight into `v.gross_revenue`; `/violations/revenue` returns `gross_revenue_cents=gross` and `gross_revenue_dollars=round(gross / 100, 2)`. **Never multiply or divide these by 100.** The naming is DB-7's remaining half and is out of scope here. (`frontend/src/lib/db.js` *does* treat them as dollars — that is the DB-7 bug Task 7 removes by deleting the browser's arithmetic entirely.) |
| `integrations` | 1 row, no owner/org column. `/quickbooks/oauth/start` and `/status` are **already** `require_platform_admin` with deterministic `ORDER BY connected_at DESC` — half of SEC-6 landed. The remaining half is the missing org column. |
| RLS helpers | `public.current_owner_id()`, `public.current_partner_id()`, `public.is_platform_admin()` — all `STABLE SECURITY DEFINER`, all read `request.jwt.claim.*` / `request.jwt.claims`. `properties_authenticated_select` is `owner_id = current_owner_id() OR partner_id = current_partner_id()`. |
| Frontend hardcoded UUID | `frontend/src/App.jsx:30` `const NMLD_PARTNER_ID = '1826b6b4-e8dc-402f-b4e7-926e259a56fe';` used at lines **177, 572, 719** to gate the App tab. That is FE-16. |
| Policy image today | A **static file committed to the frontend repo**: `frontend/policy/<qr_code_id>.jpg`, read by `src/visit.js:191` with an `onerror` fallback to `policy_text`. Adding site #12's policy means a frontend commit and a Vercel deploy. |
| The four ownership copies | `routers/visitor_passes.py:37`, `routers/resident_plates.py:31`, `routers/lots.py:523` (inline), `routers/quickbooks.py:185` and `:322` (inline `Property.owner_id == subject.id` **as one predicate inside a query that projects `Property.tow_company_id`** — the predicate is what changes, not the projection). `plaza_payments.py`, `apartment_passes.py`, `apartment_docs.py` all **import** the visitor_passes one. |
| Route guard vocabulary | `services/auth.py`: `require_subject`, `require_user_subject`, `require_platform_admin`, `resolve_subject`. `routers/app_api.py`: `require_app_phone`. `main.PUBLIC_PATHS` is a **19**-entry tuple plus three prefix/suffix rules in `main._is_public_path` (`/plaza/payments/*/status`, `/app/*`, and the debug-only docs rule). The 19: `/health`, `/ready`, `/violations/sms-webhook`, `/operator-portal.html`, `/zone_editor.html`, `/billing.html`, `/auth/login`, `/auth/set-password`, `/auth/request-password`, `/auth/seed-test-account`, `/alpr/ingest`, `/quickbooks/oauth/callback`, `/violations/action`, `/visitor_passes/check-active`, `/visitor_passes/register`, `/resident_plates/register`, `/apartment/uploads`, `/plaza/quote-and-start`, `/plaza/webhook`. |
| SEC-12 | **Already closed.** `violation_dedup.py`'s `/violations/{id}/acknowledge` calls `assert_lot_access`; `/reminders/run` is `require_platform_admin`. Wave 1 item 5 landed. |
| Wave 2.4 | **Merged to backend `origin/main`** on 2026-09-14 (`07f111d`, PR #84). `scripts/db/migrate.sh`, `regen_expected.sh`, `expected_schema.sql`, `expected_census.txt`, `inventory.sql` and CI's `schema-rebuild` job are all on `main`. This wave's six migrations land under the runner and the drift check from day one; Gabe decision D10 is therefore already answered. |
| `services/storage.upload_bytes` | Signature is **`upload_bytes(data: bytes, key: str, content_type: str) -> tuple[str, str]`**, returning `(storage_key, public_url)` — data FIRST, and it returns a tuple, not a URL string. It raises on failure (unlike `upload_snapshot`, which swallows). Build the public URL from its **second return value**, never by string-concatenating `r2_public_url` yourself. |
| `services/quickbooks` OAuth state | `build_authorize_url()` mints `secrets.token_urlsafe(24)` and records it in the module-level `_oauth_states` dict with a timestamp; `verify_state(state)` **pops** it (single use, 10-minute sweep). `exchange_code(code, realm_id, db)` takes **no subject** — and `GET /quickbooks/oauth/callback` is in `PUBLIC_PATHS`, so there is no `Subject` at the callback at all. |
| `tests/plaza/conftest.py` canary | `PRODUCTION_CANARY_TABLES = ("alpr_violations", "lot_owners", "pending_invoices")` and `_apply_schema` checks it **before** `DROP SCHEMA public` — so a table the harness itself creates must not stay on that list, or a persistent `TEST_DATABASE_URL` refuses to start on session two. |
| `tests/plaza/conftest.py` multi-statement SQL | `_apply_schema` connects with **raw asyncpg** and says why: "the asyncpg dialect sends everything as a prepared statement, which cannot carry more than one command, while these scripts are multi-statement and full of dollar-quoted function bodies". Any test that executes a whole migration file must do the same. |
| `tests/plaza/conftest.py` seed | `seed_truck_plaza` **asserts** on the session-scoped plaza row (`property_type == 'truck_plaza'`, `policy_text is not None`) and `properties` is deliberately absent from `TRUNCATE_TABLES`. A fixture that `UPDATE`s that row breaks every later test in the session. |
| Wave 2.6 | **Landed.** `frontend/src/` is ~30 modules; `frontend/package.json` has `build`, `test`, `check:naming`; `dist/` is the Vercel output dir. |
| Wave 2.7 / 2.8 | **Landed.** `services/alerts.py`, `services/job_registry.py`, `services/findings.py`, `routers/ops.py` (5 platform-admin endpoints), `ops_job_runs`, `ops_findings`, `outbound_notices`. |

---

## Scope calls — where the code contradicts the program doc

Decided here so no executor re-litigates them.

1. **`DB-13`'s "three identity tables" does not become one table in this wave.** The doc's own 2.2 row asks for `users` + `memberships`, not for deleting `lot_owners` / `enforcement_partners`. Those two tables carry the fee schedule, the QuickBooks customer id, the tow-truck plate roster, and the ids that **every** production RLS policy and **every** issued JWT resolves. Collapsing them is an RLS rewrite plus a JWT-claim migration with a token-expiry window — Wave 3 work, and the program doc already parks the equivalent legacy-table convergence in 3.6. This plan adds the third table and the explicit link; it removes nothing.

2. **`SEC-4` (login rate limit) is in, and it is a database counter, not an in-process one.** Wave 2.7 established that a second Railway replica must be safe, and an in-memory limiter is per-replica — it silently multiplies the limit by the replica count. Task 8 uses a table. It is a *counter*, not a lock: a database hiccup degrades to "allow the attempt" and logs, never to "nobody can sign in".

3. **`SEC-6` is half-landed; this plan finishes the org half only.** The gate and the deterministic ordering are already on `main`. Task 11 adds `integrations.organization_id` and makes the resolution per-org with a documented fallback to the single unowned row, so the one live QuickBooks connection keeps working untouched. It does **not** build a per-org OAuth flow — there is one billing entity today, and a second one is what makes that worth writing.

4. **`SEC-8` is bigger than the finding's wording, and the fix is a route change, not just a table.** The finding says the audit record "is written by the browser and dropped on failure". Verified: it is written by the browser into a table **that does not exist**, so it is dropped *always* — and the same browser code computes `gross_revenue` and `our_revenue` from client-held fee values and writes them straight to `violations` through Supabase, bypassing the backend entirely. Task 6 adds `admin_audit_log`; Task 7 routes the action through the existing `POST /violations/{id}/resolve`, derives the fee server-side from `enforcement_partners.{boot,tow}_fee_cents`, and writes the audit row in the same transaction. **`violations.gross_revenue` / `our_revenue` already hold cents** (see the Facts table), so the server-side assignment is a straight copy of the fee column and there is no `× 100` or `// 100` anywhere in this plan. The half of DB-7 still open is that the *browser* treats those columns as dollars — Task 7 closes it by deleting the browser's arithmetic, not by renaming a column.

5. **`SEC-12` is already closed — this plan locks it in rather than re-fixing it.** Task 5's route-walk test is what makes the closure permanent, which is precisely what the 2.2 row asks for ("permanently retires the class of bug behind items 5 and 15").

6. **The printable QR sheet is a standalone entry page — `qr-sheet.html`, not a dashboard tab.** Two decisions in one.

   *Not a backend PDF:* rendering a QR server-side means a new Python dependency (`segno`/`qrcode`) inside the image the Dockerfile builds from `requirements.lock`, for one page an admin prints once per site. The frontend already **bundles** `qrcode@1.5.4` (Wave 2.6 moved it off the CDN precisely because a CDN 404 blanked the QR tiles).

   *Not a dashboard tab either:* `App.jsx` takes its current tab from `localStorage.getItem('lotlogic_tab')` (line 95) and **never reads `window.location.pathname`**, and line 178 coerces any tab not in the valid list back to `lots`. A `/app/qr-sheet?property=…` link would therefore open the dashboard on whatever tab the admin last used — the page would be unreachable by URL, which is the only way it is ever opened. So it is a **fourth standalone entry page** alongside `visit.html` / `resident.html` / `apt.html`: `frontend/qr-sheet.html` + `frontend/src/qr-sheet.js`, added to `build.mjs`'s `entryPoints`, fetching its property from the backend with the admin's own JWT out of `localStorage` (`lib/api.js::apiFetch`). `POST /admin/sites` returns `{SITE_URL}/qr-sheet.html?property=<id>`.

7. **The policy image moves to R2 with a public object key, not behind a signed redirect.** The page that renders it (`visit.html`) is scanned by an anonymous driver who holds no credential, and the image is the *posted public policy* — the same document nailed to a post at the entrance. `routers/apartment_docs.py`'s streaming-behind-a-scope-check pattern is right for a lease and wrong for this. The key carries 8 random hex characters so the bucket's public base cannot be used to enumerate. The existing `frontend/policy/<qr>.jpg` files stay in place as the fallback; nothing breaks on deploy day.

8. **`properties.timezone` is NOT added here.** Eleven hardcoded timezone literals and a `properties.timezone` column are Wave 2.1 (`PLATFORM-15`), which owns `properties.config`. Task 13's request schema accepts nothing this plan cannot store. When 2.1 lands, one field is added to `SiteOnboardRequest` and one column to the insert — that is the whole cost of having kept them separate.

9. **No `organizations`-scoped RLS policy is added.** Today's policies resolve `current_owner_id()` / `current_partner_id()`, and Task 9 keeps supplying those claims from the *organization's* legacy link — so a brand-new staff login satisfies existing RLS with no policy change and no new SQL helper function. Adding an org-scoped policy now would be a second, untested authorization path for zero behaviour gained. The backend reaches the three new tables as the service role.

10. **`FE-16`'s replacement is a row, not a config constant.** Swapping the hardcoded UUID for an env var or a list moves the problem. `/auth/me` gains a `features` object computed server-side from the subject's own properties (`app_enabled`), and the App tab renders on `features.partner_app`. Site #12 turning the app on is then an `UPDATE`, which is the whole point of Wave 2.

11. **`admin_audit_log.actor_type` records `'user'` when there is a user, and drops `'system'`.** `Subject.type` is `Literal["owner","partner","service"]`, so a CHECK admitting `'system'` admits a value no code path can produce, and `'user'` would be unreachable if it were copied straight from `subject.type`. The rule: `'service'` when `subject.is_service`, else `'user'` when `subject.user_id` is set (a Wave 2.2 login), else `subject.type` (a legacy owner/partner login). The CHECK is `('user','owner','partner','service')` — four values, all reachable, and the distribution across them is itself the rollout's progress meter.

12. **The `is_platform_admin()` SQL function must stop resolving through the shared org identity — and Task 1 fixes it.** This is the one genuine security consequence of the "JWT carries the *organization's* legacy id" design. `public.is_platform_admin()` is `SELECT is_platform_admin FROM lot_owners WHERE id = public.current_owner_id()`, and production has **two** `lot_owners` rows with that flag set. After Task 9, every login in a platform-admin organization presents that org's legacy id — so a `viewer` added to the LotLogic org would inherit **database-level** platform admin through `admin_select_properties` / `admin_write_properties`, regardless of the API-level flag. Task 1 therefore redefines the function: when the token carries a `user_id` claim, the answer is that **user's own** `users.is_platform_admin`; with no such claim (every token issued before this wave) the existing `lot_owners` branch is used verbatim. That is a `CREATE OR REPLACE` on a function, which is not additive in the strict sense — it is called out here as the one deliberate exception, because shipping the org-identity design without it would hand a staff login the admin RLS policies.

13. **`int(gross * share)` stays truncating.** `POST /violations/{id}/action` (violations.py:512) and the tow-confirm correlator (violations.py:766) both already do `int(v.gross_revenue * float(partner.revenue_share))`, so a $350 tow at 25% books $87.50 → 8750 cents exactly, and the truncation only ever bites on a share that produces a fraction of a cent. Rounding differently in a third place would make two call sites disagree about the same tow. Keep `int()`, verbatim; changing the rounding of a money calculation is its own change with its own reconciliation.

---

## File Structure

**Backend** — `/Users/gabe/lotlogic-backend-tenancy`

| File | Responsibility |
|---|---|
| `migrations/20260914140000_tenancy_organizations_users_memberships.sql` **(new)** | The three tables + `properties.organization_id`. RLS on, anon/authenticated revoked. |
| `migrations/20260914140100_tenancy_backfill_from_legacy_accounts.sql` **(new)** | Seeds orgs/users/memberships from `lot_owners` / `enforcement_partners` / `properties`. Idempotent, with a fail-closed assertion block. |
| `migrations/20260914140200_admin_audit_log.sql` **(new)** | `admin_audit_log` (SEC-8). |
| `migrations/20260914140300_auth_login_attempts.sql` **(new)** | `auth_login_attempts` (SEC-4). |
| `migrations/20260914140400_integrations_organization_id.sql` **(new)** | `integrations.organization_id` (SEC-6). |
| `migrations/20260914140500_properties_policy_image_url.sql` **(new)** | `properties.policy_image_url` + the one deliberate `anon` column grant. |
| `services/tenancy.py` **(new)** | **The** ownership helper. `Role`, `allowed_property_ids`, `assert_property_access`, `user_organizations`, `require_org_role`. |
| `services/audit.py` **(new)** | `record(db, ...)` — appends one `admin_audit_log` row to the caller's open transaction. Never opens its own session, never commits. |
| `services/login_throttle.py` **(new)** | `check(db, email)` / `record_failure` / `record_success` over `auth_login_attempts`. Fails open. |
| `services/site_onboarding.py` **(new)** | The one transaction behind `POST /admin/sites`: slug minting, org/user/membership/partner/property writes, setup-link assembly. |
| `services/auth.py` *(modify)* | `Subject` gains `user_id` and `organization_ids`; `issue_token` gains `user_id` / `org_ids` / `role` claims (additive — `owner_id`/`partner_id` unchanged). |
| `routers/visitor_passes.py` *(modify)* | `_assert_property_scope` keeps its name and signature; body becomes one delegating line. **`plaza_payments.py` imports it — do not move it.** |
| `routers/resident_plates.py` *(modify)* | Its private copy deleted; call site points at `services/tenancy.py`. |
| `routers/lots.py` *(modify)* | The inline copy in `list_registered` deleted; `PATCH /partners/{id}` writes an audit row. |
| `routers/quickbooks.py` *(modify)* | The two inline `Property.owner_id == subject.id` filters go through `tenancy.allowed_property_ids`; connection resolution becomes per-org. |
| `routers/violations.py` *(modify)* | `resolve_violation` derives the fee server-side and writes the audit row in the same transaction. |
| `routers/auth.py` *(modify)* | Login resolves `users` first with a legacy fallback; throttle; `/auth/me` returns `organization`, `role`, `features`. |
| `routers/admin.py` *(modify)* | `POST /admin/sites`, `POST /admin/sites/{id}/policy-image`, `GET /admin/sites/{id}` (the narrow read the printable sheet calls with the admin's JWT); `POST /admin/clients` kept as a thin, audited alias. |
| `models.py` *(modify)* | `Organization`, `User`, `Membership` declarative classes; `Property` gains `organization_id`. |
| `config.py` *(modify)* | `login_max_attempts`, `login_lockout_minutes`, `login_attempt_window_minutes`, `policy_image_max_bytes`. |
| `tests/test_route_guards.py` **(new)** | The route walk. Fails the build on an unguarded endpoint. |
| `tests/plaza/test_tenancy_scope.py` **(new)** | The helper, against real Postgres, with the cross-tenant negatives. |
| `tests/plaza/test_tenancy_backfill.py` **(new)** | The migration's own proof: re-runnable, counts match, no orphan property. |
| `tests/plaza/test_admin_audit_log.py` **(new)** | The audit row is written in the mutating transaction and rolls back with it. |
| `tests/plaza/test_site_onboarding.py` **(new)** | One POST produces a fully-formed, QR-serving site. |
| `tests/test_login_throttle.py`, `tests/test_admin_sites_api.py` **(new)** | Router-level contract. |
| `tests/plaza/schema/live_schema.sql` *(modify)* | Gains `lot_owners` and `properties.organization_id` so the harness can exercise the backfill. |
| `tests/plaza/conftest.py` *(modify)* | `20260914*.sql` glob; `memberships` / `users` / `admin_audit_log` / `auth_login_attempts` in `TRUNCATE_TABLES` (**never `organizations`** — see Task 1); `lot_owners` out of `PRODUCTION_CANARY_TABLES`, because the harness now creates it. |
| `docs/runbooks/new-site.md` **(new)** | PLATFORM-11. Generated from `SiteOnboardRequest`, with a test that fails when they drift. |
| `scripts/gen_new_site_runbook.py` **(new)** | The generator. |

**Frontend** — `/Users/gabe/lotlogic-fe-tenancy`

| File | Responsibility |
|---|---|
| `frontend/src/App.jsx` *(modify)* | `NMLD_PARTNER_ID` deleted; tab gates read `me.features` / `me.role`. |
| `frontend/src/lib/db.js` *(modify)* | `recordAction` posts to the backend; the browser-side fee math and the `action_logs` insert are deleted. |
| `frontend/src/pages/AdminConsolePage.jsx` *(modify)* | The Onboard tab becomes the one site-onboarding screen (the checklist), with the policy-image upload and the QR-sheet link. |
| `frontend/src/pages/ALPRPropertiesPage.jsx` *(modify)* | The inline add-property form posts to `POST /admin/sites` for admins; non-admins lose a form that could only ever make a half-built site. |
| `frontend/qr-sheet.html` + `frontend/src/qr-sheet.js` **(new)** | `/qr-sheet.html?property=<id>` — the printable sheet, as a **standalone entry page** beside `visit.html` / `resident.html` / `apt.html`. Not a dashboard tab: `App.jsx` routes from `localStorage`, never from `pathname`. |
| `frontend/scripts/build.mjs` *(modify)* | `src/qr-sheet.js` joins `entryPoints`, and both new files join the not-silently-empty assert list. |
| `frontend/src/visit.js` *(modify)* | Prefers `property.policy_image_url`; existing `/policy/<qr>.jpg` stays as the fallback. |
| `frontend/vercel.json` | **Unchanged.** The sheet's URL is the file itself; a prettier `/qr-sheet` rewrite is a one-liner if it is ever wanted, and this plan does not add rewrites it does not need. |
| `tests/e2e/access-control.spec.ts` *(modify)* | Cross-tenant assertions extended to the org era. |
| `tests/e2e/site-onboarding.spec.ts` **(new)** | Self-serving spec for the onboarding screen's validation and the QR sheet's print layout. |

---

## Task Sequence

| # | Task | Repo | Depends on |
|---|---|---|---|
| 1 | Migration — `organizations`, `users`, `memberships`, `properties.organization_id` | backend | — |
| 2 | Migration — backfill from `lot_owners` / `enforcement_partners` / `properties` | backend | 1 |
| 3 | `services/tenancy.py` — the one RBAC helper | backend | 1 |
| 4 | Adopt it: delete the four copies | backend | 3 |
| 5 | `tests/test_route_guards.py` — the route walk | backend | — |
| 6 | Migration + `services/audit.py` — `admin_audit_log` | backend | — |
| 7 | Server-side fee + audit on every money action; browser stops writing both | backend + frontend | 6 |
| 8 | SEC-4 — login throttle and lockout | backend | — |
| 9 | Login resolves `users`; JWT and `/auth/me` carry org, role and features | backend | 2, 3 |
| 10 | FE-16 — capability-driven tab gates; delete the hardcoded partner UUID | frontend | 9 |
| 11 | SEC-6 — `integrations.organization_id`, per-org QuickBooks resolution | backend | 2 |
| 12 | Migration — `properties.policy_image_url` + the upload endpoint | backend | 1 |
| 13 | **`POST /admin/sites`** — the one site-onboarding command | backend | 2, 3, 6, 12 |
| 14 | The printable QR sheet (`/qr-sheet.html`, a standalone entry page) | frontend + backend | 13 |
| 15 | One onboarding screen; retire the direct-Supabase property insert | frontend | 13, 14 |
| 16 | PLATFORM-11 — `docs/runbooks/new-site.md`, generated from the schema | backend | 13 |
| 17 | Cutover — apply to prod, regenerate the three schema artifacts, verify | both | all |

**Parallelism map (one line):** wave A `{1, 5, 6, 8}` all start immediately; wave B `{2, 3}` after 1 and `{7}` after 6; wave C `{4, 9, 11, 12}` after their deps (`4`←3, `9`←2+3, `11`←2, `12`←1); wave D `{10, 13}` (`10`←9, `13`←2+3+6+12); wave E `{14, 16}` after 13; wave F `{15}` after 14; wave G `{17}` last — so at peak four subagents run concurrently, and the only true serialisation is 1 → 2/3 → 13 → 14 → 15 → 17.

---

*(Tasks 1–17 follow. Each is self-contained: exact files, exact code, the command to run, the expected output, the commit.)*

---

### Task 1: Migration — `organizations`, `users`, `memberships`, `properties.organization_id`

**Files:**
- Create: `migrations/20260914140000_tenancy_organizations_users_memberships.sql`
- Modify: `models.py` (add three declarative classes; add one column to `Property`)
- Modify: `tests/plaza/conftest.py` (`MIGRATION_GLOBS` + `TRUNCATE_TABLES`)
- Modify: `tests/plaza/schema/live_schema.sql` (add `lot_owners`, which the subset omits)
- Test: `tests/plaza/test_tenancy_tables.py`

**Interfaces:**
- Consumes: nothing. This task adds rows nobody reads yet.
- Produces, for Tasks 2, 3, 9, 11, 13:
  - `public.organizations(id, name, kind, legacy_owner_id, legacy_partner_id, active, created_at)`, `kind ∈ {owner, partner, platform}`. **`legacy_owner_id` and `legacy_partner_id` are plain `uuid` columns with no foreign key** — see Step 1's comment for why.
  - `public.users(id, email, display_name, phone, password_hash, password_set_at, last_login_at, password_reset_token, password_reset_expires_at, is_platform_admin, active, default_organization_id, created_at)`, unique on `lower(email)`.
  - `public.memberships(id, user_id, organization_id, role, created_at)`, `role ∈ {admin, manager, staff, viewer}`, unique on `(user_id, organization_id)`.
  - `public.properties.organization_id uuid` → `organizations(id) ON DELETE SET NULL`.
  - `models.Organization`, `models.User`, `models.Membership`.

- [ ] **Step 1: Write the migration**

`migrations/20260914140000_tenancy_organizations_users_memberships.sql`:

```sql
-- Wave 2.2 — one tenancy model. Additive only.
--
-- Three tables and one column. Nothing here alters or drops anything shipped
-- code reads, and no login changes behaviour until 20260914140100 fills these
-- rows in and routers/auth.py starts reading them (Task 9).
--
--   organizations  "all nine N Style sites" becomes a query instead of nine
--                  owner_id comparisons.
--   users          a PERSON, with their own password. This is what ends "a
--                  company is an account" — ten leasing offices sharing ten
--                  passwords, and a staff member leaving means rotating the
--                  office's only credential.
--   memberships    (user, org, role). The ONLY place a role is stored.
--   properties.organization_id  the join that makes an org a tenant.
--
-- WHY lot_owners / enforcement_partners SURVIVE UNTOUCHED: they carry the fee
-- schedule, the QuickBooks customer id and the tow-truck plate roster, and
-- their ids are what every production RLS policy resolves
-- (properties_authenticated_select = owner_id = current_owner_id() OR
-- partner_id = current_partner_id()) and what every issued JWT carries.
-- organizations.legacy_owner_id / legacy_partner_id is the explicit link, and
-- Task 9 derives the JWT's owner_id claim from THE ORGANISATION — so a brand
-- new staff login with no lot_owners row of its own still satisfies today's
-- RLS with zero policy changes.
--
-- RLS: on, with anon and authenticated revoked. No PostgREST client reads
-- these; the backend reaches them as the service role. Adding a policy later
-- is additive.

BEGIN;

CREATE TABLE IF NOT EXISTS public.organizations (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name               text NOT NULL,
    kind               text NOT NULL,
    -- At most ONE legacy link, or none (a platform org, or an org created
    -- after the cutover that never had a legacy account).
    --
    -- DELIBERATELY NOT FOREIGN KEYS. A REFERENCES enforcement_partners(id)
    -- here would put `organizations` downstream of a table the pay-to-park
    -- harness truncates between every test -- and `TRUNCATE ... CASCADE`
    -- follows referencing tables, so it would reach organizations, then
    -- properties.organization_id, then the session-scoped plaza seed row and
    -- every pass/event table hanging off it. One missing FK is a far smaller
    -- price than a test harness that silently deletes its own fixture.
    -- Referential integrity is held instead by the two partial UNIQUE indexes
    -- below plus the kind/link CHECK, and by the fact that exactly one code
    -- path writes these columns (services/site_onboarding.py and the backfill).
    legacy_owner_id    uuid,
    legacy_partner_id  uuid,
    active             boolean NOT NULL DEFAULT true,
    created_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT organizations_name_not_blank CHECK (btrim(name) <> ''),
    CONSTRAINT organizations_kind_check
        CHECK (kind IN ('owner', 'partner', 'platform')),
    CONSTRAINT organizations_one_legacy_link
        CHECK (num_nonnulls(legacy_owner_id, legacy_partner_id) <= 1),
    CONSTRAINT organizations_legacy_link_matches_kind CHECK (
           (kind = 'owner'    AND legacy_partner_id IS NULL)
        OR (kind = 'partner'  AND legacy_owner_id   IS NULL)
        OR (kind = 'platform' AND legacy_owner_id IS NULL AND legacy_partner_id IS NULL)
    )
);

-- Partial uniques, not plain ones: many orgs may legitimately have NULL here.
CREATE UNIQUE INDEX IF NOT EXISTS organizations_legacy_owner_key
    ON public.organizations (legacy_owner_id) WHERE legacy_owner_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS organizations_legacy_partner_key
    ON public.organizations (legacy_partner_id) WHERE legacy_partner_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.users (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email                     text NOT NULL,
    display_name              text,
    phone                     text,
    -- Same column set lot_owners and enforcement_partners already carry, so
    -- the backfill is a straight copy and services/auth.py's bcrypt +
    -- reset-token code works unchanged against either shape.
    password_hash             text,
    password_set_at           timestamptz,
    last_login_at             timestamptz,
    password_reset_token      text,
    password_reset_expires_at timestamptz,
    is_platform_admin         boolean NOT NULL DEFAULT false,
    active                    boolean NOT NULL DEFAULT true,
    -- The org whose legacy link supplies this login's owner_id/partner_id JWT
    -- claim. One today; an org switcher is Wave 3 (see decision D2).
    default_organization_id   uuid REFERENCES public.organizations(id) ON DELETE SET NULL,
    created_at                timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT users_email_not_blank CHECK (btrim(email) <> '')
);

-- Case-insensitive uniqueness. routers/auth.py has looked accounts up with
-- func.lower(email) since April; there is no citext extension installed and
-- this plan is not the place to add one.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key
    ON public.users (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS users_password_reset_token_key
    ON public.users (password_reset_token) WHERE password_reset_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.memberships (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    -- The role is the POWER; organizations.kind is the FLAVOUR. A membership
    -- with role 'admin' in a partner-kind org is a tow-company administrator;
    -- the same role in an owner-kind org is a property administrator. Keeping
    -- 'owner'/'partner' out of this enum is deliberate — it is exactly the
    -- confusion that produced four disagreeing scope helpers.
    role            text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT memberships_role_check
        CHECK (role IN ('admin', 'manager', 'staff', 'viewer')),
    CONSTRAINT memberships_user_org_key UNIQUE (user_id, organization_id)
);

CREATE INDEX IF NOT EXISTS memberships_organization_id_idx
    ON public.memberships (organization_id);

ALTER TABLE public.properties
    ADD COLUMN IF NOT EXISTS organization_id uuid
        REFERENCES public.organizations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS properties_organization_id_idx
    ON public.properties (organization_id);

-- NOT granted to anon. Production revoked properties' table-level SELECT and
-- granted back a named column list (20260707170000_properties_anon_column_scope),
-- so a new column is private by default and the public QR forms cannot read it.
-- That is the intended state for this one.

-- ── The one deliberate non-additive statement in this wave ──────────────────
--
-- Task 9 issues a JWT whose owner_id claim is THE ORGANISATION'S legacy id, so
-- that a login created after this wave satisfies today's RLS with no policy
-- change. That design has exactly one dangerous consequence, and this is it:
--
--   public.is_platform_admin() reads lot_owners.is_platform_admin via
--   current_owner_id(), and production has TWO lot_owners rows with that flag
--   set. Without the change below, a 'viewer' added to a platform-admin
--   organisation would present that org's legacy id and inherit DATABASE-level
--   platform admin through admin_select_properties / admin_write_properties --
--   regardless of what the API-level is_platform_admin claim says.
--
-- So: when the token carries a user_id claim (every token issued from Task 9
-- onward), the answer is THAT USER'S OWN flag. With no such claim -- every
-- token issued before this wave, and every service-role connection -- the
-- existing lot_owners branch runs verbatim. Backward compatible by
-- construction, and re-runnable (CREATE OR REPLACE).

CREATE OR REPLACE FUNCTION public.current_app_user_id()
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
    SELECT NULLIF(NULLIF(
        COALESCE(
            current_setting('request.jwt.claim.user_id', true),
            (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'user_id')
        ),
        ''
    ), 'null')::uuid
$fn$;

REVOKE EXECUTE ON FUNCTION public.current_app_user_id() FROM anon;

CREATE OR REPLACE FUNCTION public.is_platform_admin()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
    SELECT CASE
        WHEN public.current_app_user_id() IS NOT NULL THEN
            COALESCE((SELECT u.is_platform_admin
                        FROM public.users u
                       WHERE u.id = public.current_app_user_id()
                         AND u.active), FALSE)
        ELSE
            COALESCE((SELECT is_platform_admin
                        FROM lot_owners
                       WHERE id = public.current_owner_id()), FALSE)
    END
$fn$;

ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memberships   ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.organizations FROM anon, authenticated;
REVOKE ALL ON public.users         FROM anon, authenticated;
REVOKE ALL ON public.memberships   FROM anon, authenticated;

COMMIT;
```

- [ ] **Step 2: Add the ORM classes to `models.py`**

After the existing `class Property(Base):` block, and add the one column to `Property` itself:

```python
class Organization(Base):
    """A customer company. `kind` says which side of the product they are on;
    `legacy_*_id` is the explicit link to the pre-2.2 account row whose id
    every RLS policy and every JWT claim still resolves."""
    __tablename__ = "organizations"
    id                = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name              = Column(Text, nullable=False)
    kind              = Column(Text, nullable=False)
    # Plain UUIDs, no ForeignKey -- mirroring the migration. See its comment.
    legacy_owner_id   = Column(UUID(as_uuid=True))
    legacy_partner_id = Column(UUID(as_uuid=True))
    active            = Column(Boolean, nullable=False, default=True)
    created_at        = Column(TIMESTAMP(timezone=True), server_default=func.now())


class User(Base):
    """A person who signs in. Not a company — that is Organization."""
    __tablename__ = "users"
    id                        = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email                     = Column(Text, nullable=False)
    display_name              = Column(Text)
    phone                     = Column(Text)
    password_hash             = Column(Text)
    password_set_at           = Column(TIMESTAMP(timezone=True))
    last_login_at             = Column(TIMESTAMP(timezone=True))
    password_reset_token      = Column(Text)
    password_reset_expires_at = Column(TIMESTAMP(timezone=True))
    is_platform_admin         = Column(Boolean, nullable=False, default=False)
    active                    = Column(Boolean, nullable=False, default=True)
    default_organization_id   = Column(UUID(as_uuid=True), ForeignKey("organizations.id"))
    created_at                = Column(TIMESTAMP(timezone=True), server_default=func.now())


class Membership(Base):
    """(user, org, role). The only place a role is stored."""
    __tablename__ = "memberships"
    id              = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id         = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    organization_id = Column(UUID(as_uuid=True), ForeignKey("organizations.id"), nullable=False)
    role            = Column(Text, nullable=False)
    created_at      = Column(TIMESTAMP(timezone=True), server_default=func.now())
```

and inside `class Property(Base):`, after `tow_company_id`:

```python
    organization_id = Column(UUID(as_uuid=True), ForeignKey("organizations.id"))
```

Import whatever of `Text`, `Boolean`, `func` the file does not already pull from `sqlalchemy`. `python -m compileall` will not catch a missing name — `pytest` importing `models` will.

- [ ] **Step 3: Teach the harness about the new tables**

In `tests/plaza/conftest.py`, extend the glob tuple and the truncate list:

```python
MIGRATION_GLOBS = (
    "20260902*.sql", "20260905*.sql", "20260907*.sql", "20260910*.sql",
    "20260911*.sql", "20260914*.sql",
)
```

```python
TRUNCATE_TABLES = (
    ...,
    # Wave 2.2. `organizations` is DELIBERATELY ABSENT and must stay absent:
    # properties.organization_id references it, the statement is one
    # `TRUNCATE ... CASCADE`, and `properties` is session-scoped (it holds the
    # plaza seed row `seed_truck_plaza` asserts on). Truncating organizations
    # would cascade straight through properties into every pass and event
    # table and delete the harness's own fixture. Tests that need an
    # organisation create one with a fresh uuid and delete it in teardown.
    "memberships", "users", "admin_audit_log", "auth_login_attempts",
    ...
)
```

Child-before-parent ordering is cosmetic (one `TRUNCATE … CASCADE`), but keep it so the list reads as the dependency order. `admin_audit_log` and `auth_login_attempts` are Tasks 6 and 8 — list them now; the harness skips any table `to_regclass` cannot resolve, so a not-yet-created table is harmless.

Truncating `users` **does** cascade into `memberships` and into `admin_audit_log.actor_user_id`; both are on the list, so that is intended. Nothing on the list references `organizations`, `properties` or `enforcement_partners`, so nothing reaches the session seed.

In `tests/plaza/schema/live_schema.sql`, add `lot_owners` (the subset does not have it, and `organizations.legacy_owner_id` references it) immediately **before** `CREATE TABLE public.properties`:

```sql
-- Added for Wave 2.2: organizations.legacy_owner_id references this table, so
-- the harness needs it to replay 20260914140000. Column set copied verbatim
-- from production 2026-09-14; the live default is uuid_generate_v4() and this
-- subset installs pgcrypto only, so gen_random_uuid() is substituted (same
-- substitution enforcement_partners already carries below).
CREATE TABLE public.lot_owners (
    id                        uuid NOT NULL DEFAULT gen_random_uuid(),
    business_name             text NOT NULL,
    contact_name              text NOT NULL,
    phone                     text NOT NULL,
    email                     text NOT NULL,
    billing_address           text,
    active                    boolean NOT NULL DEFAULT true,
    created_at                timestamp with time zone NOT NULL DEFAULT now(),
    password_hash             text,
    password_set_at           timestamp with time zone,
    last_login_at             timestamp with time zone,
    password_reset_token      text,
    password_reset_expires_at timestamp with time zone,
    is_platform_admin         boolean NOT NULL DEFAULT false,
    is_admin                  boolean NOT NULL DEFAULT false,
    CONSTRAINT lot_owners_pkey PRIMARY KEY (id)
);
```

**And remove `lot_owners` from the canary list in the same edit.** `tests/plaza/conftest.py::PRODUCTION_CANARY_TABLES = ("alpr_violations", "lot_owners", "pending_invoices")` is the "this database is production-shaped, refuse to drop schema `public`" guard, and `_apply_schema` checks it **before** the `DROP SCHEMA`, against the database as it arrives. Once the harness creates `lot_owners` itself, its presence is no longer evidence of a production database — it is evidence of the *previous session*. CI is unaffected (a fresh `postgres:17` service container each run), but a developer with a persistent `TEST_DATABASE_URL` would get a hard refusal on session two. So:

```python
#: A database holding any of these is production-shaped, and this harness drops
#: schema `public`. Refuse rather than find out.
#:
#: `lot_owners` was on this list until Wave 2.2. It came off when live_schema.sql
#: started creating it: a table the harness makes itself cannot distinguish
#: "production" from "this harness's own previous session", and with a persistent
#: TEST_DATABASE_URL it made session two refuse to start. `alpr_violations` and
#: `pending_invoices` are still production-only and still guard.
PRODUCTION_CANARY_TABLES = ("alpr_violations", "pending_invoices")
```

Verify by running `pytest tests/plaza/ -q` **twice in a row** against a persistent `TEST_DATABASE_URL`. Both runs must be green.

- [ ] **Step 4: The test**

`tests/plaza/test_tenancy_tables.py`:

```python
"""The Wave 2.2 tenancy tables exist with the shape the rest of the wave assumes.

Cheap, but not trivial: five of these assertions are the difference between an
additive migration and a data-loss migration, and three of them (the partial
uniques, the case-insensitive email index, the kind/legacy CHECK) are the ones a
hand-written `CREATE TABLE` gets wrong.

FIXTURE RULE, and it applies to every test file this plan adds: `organizations`
is NOT in TRUNCATE_TABLES (truncating it would cascade through
`properties.organization_id` into the session-scoped plaza seed row that
`seed_truck_plaza` asserts on). So every row these tests create carries a uuid
generated in the test and is deleted in teardown. Never `UPDATE` a seeded row;
never insert a fixed id into `properties`, `lot_owners` or `organizations`.
"""
import uuid

import pytest
from sqlalchemy import text


@pytest.fixture
async def tmp_ids(db_conn):
    """Hand out fresh uuids, then delete everything they name."""
    made = {"organizations": [], "users": [], "lot_owners": []}

    def new(table):
        i = uuid.uuid4()
        made[table].append(i)
        return i

    yield new

    if made["users"]:
        await db_conn.execute(text(
            "DELETE FROM public.memberships WHERE user_id = ANY(CAST(:ids AS uuid[]))"),
            {"ids": [str(i) for i in made["users"]]})
    for table in ("users", "organizations", "lot_owners"):
        if made[table]:
            await db_conn.execute(
                text(f"DELETE FROM public.{table} WHERE id = ANY(CAST(:ids AS uuid[]))"),
                {"ids": [str(i) for i in made[table]]})
    await db_conn.commit()


async def _scalar(db_conn, sql, **kw):
    return (await db_conn.execute(text(sql), kw)).scalar()


async def test_tables_exist(db_conn):
    for t in ("organizations", "users", "memberships"):
        assert await _scalar(db_conn, f"SELECT to_regclass('public.{t}')") is not None


async def test_properties_has_organization_id(db_conn):
    assert await _scalar(db_conn, """
        SELECT 1 FROM information_schema.columns
         WHERE table_schema='public' AND table_name='properties'
           AND column_name='organization_id'
    """) == 1


async def test_organizations_has_no_foreign_keys(db_conn):
    """A REFERENCES enforcement_partners here would put `organizations`
    downstream of a table the harness truncates between every test, and
    `TRUNCATE ... CASCADE` would reach the session-scoped plaza property
    through properties.organization_id and delete the harness's own fixture."""
    fks = (await db_conn.execute(text("""
        SELECT conname FROM pg_constraint
         WHERE conrelid = 'public.organizations'::regclass AND contype = 'f'
    """))).scalars().all()
    assert fks == [], f"organizations must carry no foreign key, found: {fks}"


async def test_email_uniqueness_is_case_insensitive(db_conn, tmp_ids):
    u1, u2 = tmp_ids("users"), tmp_ids("users")
    tag = u1.hex[:6]
    await db_conn.execute(text("INSERT INTO public.users (id, email) VALUES (:i, :e)"),
                          {"i": str(u1), "e": f"Ops+{tag}@Example.com"})
    rejected = False
    try:
        await db_conn.execute(text("INSERT INTO public.users (id, email) VALUES (:i, :e)"),
                              {"i": str(u2), "e": f"ops+{tag}@example.com"})
    except Exception:
        rejected = True
        await db_conn.rollback()
    assert rejected, "users.email must be unique case-insensitively"


async def test_two_orgs_may_share_a_null_legacy_link(db_conn, tmp_ids):
    # The PARTIAL index is the point: a plain UNIQUE would let exactly one org
    # exist without a legacy account -- which is every org created from now on.
    a, b = tmp_ids("organizations"), tmp_ids("organizations")
    await db_conn.execute(text(
        "INSERT INTO public.organizations (id, name, kind) "
        "VALUES (:a,'A','owner'),(:b,'B','owner')"), {"a": str(a), "b": str(b)})
    assert await _scalar(db_conn,
        "SELECT count(*) FROM public.organizations "
        "WHERE id = ANY(CAST(:ids AS uuid[])) AND legacy_owner_id IS NULL",
        ids=[str(a), str(b)]) == 2


async def test_one_organization_per_legacy_owner(db_conn, tmp_ids):
    """The partial unique is what makes the backfill re-runnable: without it a
    second run makes a second org for the same account."""
    legacy = uuid.uuid4()          # a plain uuid now -- there is no FK to satisfy
    a, b = tmp_ids("organizations"), tmp_ids("organizations")
    await db_conn.execute(text(
        "INSERT INTO public.organizations (id, name, kind, legacy_owner_id) "
        "VALUES (:a,'A','owner',:l)"), {"a": str(a), "l": str(legacy)})
    rejected = False
    try:
        await db_conn.execute(text(
            "INSERT INTO public.organizations (id, name, kind, legacy_owner_id) "
            "VALUES (:b,'B','owner',:l)"), {"b": str(b), "l": str(legacy)})
    except Exception:
        rejected = True
        await db_conn.rollback()
    assert rejected


async def test_kind_and_legacy_link_must_agree(db_conn, tmp_ids):
    org = tmp_ids("organizations")
    rejected = False
    try:
        await db_conn.execute(text("""
            INSERT INTO public.organizations (id, name, kind, legacy_owner_id)
            VALUES (:o, 'wrong kind', 'partner', :l)
        """), {"o": str(org), "l": str(uuid.uuid4())})
    except Exception:
        rejected = True
        await db_conn.rollback()
    assert rejected, "a partner-kind org must not carry legacy_owner_id"


async def test_membership_role_is_constrained(db_conn, tmp_ids):
    org, user = tmp_ids("organizations"), tmp_ids("users")
    await db_conn.execute(text(
        "INSERT INTO public.organizations (id, name, kind) VALUES (:o,'Org','owner')"),
        {"o": str(org)})
    await db_conn.execute(text("INSERT INTO public.users (id, email) VALUES (:u, :e)"),
                          {"u": str(user), "e": f"m+{user.hex[:6]}@example.test"})
    rejected = False
    try:
        await db_conn.execute(text("""
            INSERT INTO public.memberships (user_id, organization_id, role)
            VALUES (:u, :o, 'superuser')
        """), {"u": str(user), "o": str(org)})
    except Exception:
        rejected = True
        await db_conn.rollback()
    assert rejected, "memberships.role must be one of admin/manager/staff/viewer"


async def test_new_tables_are_revoked_from_anon_and_authenticated(db_conn):
    leaked = (await db_conn.execute(text("""
        SELECT table_name, grantee, privilege_type
          FROM information_schema.role_table_grants
         WHERE table_schema = 'public'
           AND table_name IN ('organizations','users','memberships')
           AND grantee IN ('anon','authenticated')
    """))).all()
    assert leaked == [], f"tenancy tables are reachable by a browser key: {leaked}"


async def test_is_platform_admin_reads_the_user_row_when_a_user_claim_is_present(
    db_conn, tmp_ids
):
    """Scope call 12 -- the one real security consequence of issuing the
    ORGANISATION'S legacy id as the owner_id claim. Without this branch a
    `viewer` added to a platform-admin org inherits admin_select_properties
    and admin_write_properties at the database level."""
    user = tmp_ids("users")
    await db_conn.execute(text(
        "INSERT INTO public.users (id, email, is_platform_admin) VALUES (:u, :e, false)"),
        {"u": str(user), "e": f"staff+{user.hex[:6]}@example.test"})
    claims = '{"user_id": "%s", "owner_id": "%s"}' % (user, uuid.uuid4())
    await db_conn.execute(text("SELECT set_config('request.jwt.claims', :c, true)"),
                          {"c": claims})
    assert (await db_conn.execute(text("SELECT public.is_platform_admin()"))).scalar() is False

    await db_conn.execute(text(
        "UPDATE public.users SET is_platform_admin = true WHERE id = :u"), {"u": str(user)})
    await db_conn.execute(text("SELECT set_config('request.jwt.claims', :c, true)"),
                          {"c": claims})
    assert (await db_conn.execute(text("SELECT public.is_platform_admin()"))).scalar() is True


async def test_is_platform_admin_falls_back_to_lot_owners_without_a_user_claim(
    db_conn, tmp_ids
):
    """Every token issued before this wave carries no user_id claim and must
    behave exactly as it does today."""
    owner = tmp_ids("lot_owners")
    await db_conn.execute(text("""
        INSERT INTO public.lot_owners (id, business_name, contact_name, phone, email,
                                       is_platform_admin)
        VALUES (:o, 'Legacy', 'Legacy', '', :e, true)
    """), {"o": str(owner), "e": f"legacy+{owner.hex[:6]}@example.test"})
    await db_conn.execute(text("SELECT set_config('request.jwt.claims', :c, true)"),
                          {"c": '{"owner_id": "%s"}' % owner})
    assert (await db_conn.execute(text("SELECT public.is_platform_admin()"))).scalar() is True
```

- [ ] **Step 5: Run**

```bash
cd /Users/gabe/lotlogic-backend-tenancy
ruff check . && python -m compileall -q -f . && pytest -x --tb=short -q
pytest tests/plaza/test_tenancy_tables.py -q   # and again, to prove idempotence
```

Expected: all twelve pass, and — with a **persistent** `TEST_DATABASE_URL` — a second consecutive full run of `tests/plaza/` is identical. That second run is the real assertion of this step: it is what proves both the canary edit (a table the harness creates cannot stay on the production-canary list) and the `TRUNCATE` edit (nothing this wave adds reaches the session-scoped `properties` seed).

- [ ] **Step 6: Commit** — do **not** apply to production yet (Task 17 does that, after Task 2 exists, so prod never sits with empty tenancy tables).

```
feat(tenancy): organizations, users and memberships, beside the legacy accounts

Three tables and one column. An organization is the new name for one lot_owners
or enforcement_partners row and keeps an explicit link to it, because that
legacy id is what every RLS policy resolves and what every issued JWT carries --
so nothing about today's logins changes when these rows appear. A user is a
person with their own password, which is what ends "a leasing office is a shared
credential"; a membership is (user, org, role), the only place a role is stored.

organizations.legacy_* are plain uuid columns with NO foreign key, on purpose: a
REFERENCES enforcement_partners would put organizations downstream of a table
the pay-to-park harness truncates between every test, and TRUNCATE ... CASCADE
would follow it into properties.organization_id and delete the session-scoped
plaza seed. Two partial unique indexes plus the kind/link CHECK carry the
integrity instead.

One statement here is deliberately not additive: is_platform_admin() is
redefined to read the user's OWN flag when the token carries a user_id claim.
Without it, issuing the organization's legacy id as the owner_id claim (Task 9)
would give every login in a platform-admin org the admin RLS policies.

PLATFORM-8, DB-13 (the additive half).
```

---

### Task 2: Migration — backfill organizations, users and memberships from the legacy accounts

**Files:**
- Create: `migrations/20260914140100_tenancy_backfill_from_legacy_accounts.sql`
- Test: `tests/plaza/test_tenancy_backfill.py`

**Interfaces:**
- Consumes: Task 1's tables.
- Produces, for Tasks 9, 11, 13: one `organizations` row per `lot_owners` row and per `enforcement_partners` row; one `users` row per distinct login email; one `admin` membership per user in its own org; `properties.organization_id` populated for every property with an `owner_id`.

**This is the task that makes "today's logins keep working" true.** After it, every existing credential resolves through *either* path to the same JWT claims.

- [ ] **Step 1: Write the migration**

`migrations/20260914140100_tenancy_backfill_from_legacy_accounts.sql`:

```sql
-- Wave 2.2 — seed the tenancy model from what is already in production.
--
-- Every statement is INSERT ... WHERE NOT EXISTS, ON CONFLICT DO NOTHING, or
-- UPDATE ... WHERE col IS NULL, so re-running this file changes nothing. That
-- matters more than usual here: scripts/db/migrate.sh's CI job runs the whole
-- migration set twice to prove the runner is idempotent.
--
-- Verified against production 2026-09-14: 7 lot_owners, 3 enforcement_partners,
-- 11 properties (all 11 with an owner_id), 1 market. Expected result: 10
-- organizations, up to 10 users (accounts with a blank email produce none),
-- one membership each, 11 properties with an organization_id.

BEGIN;

-- 1. One organization per lot_owners row.
INSERT INTO public.organizations (name, kind, legacy_owner_id, active)
SELECT COALESCE(NULLIF(btrim(o.business_name), ''),
                NULLIF(btrim(o.contact_name), ''),
                o.email),
       'owner', o.id, o.active
  FROM public.lot_owners o
 WHERE NOT EXISTS (
       SELECT 1 FROM public.organizations g WHERE g.legacy_owner_id = o.id);

-- 2. One organization per enforcement_partners row.
INSERT INTO public.organizations (name, kind, legacy_partner_id, active)
SELECT COALESCE(NULLIF(btrim(p.company_name), ''),
                NULLIF(btrim(p.contact_name), ''),
                p.email,
                'Partner ' || left(p.id::text, 8)),
       'partner', p.id, p.active
  FROM public.enforcement_partners p
 WHERE NOT EXISTS (
       SELECT 1 FROM public.organizations g WHERE g.legacy_partner_id = p.id);

-- 3. properties.organization_id, via the owner the property already points at.
--    A property with no owner_id keeps a NULL organization_id and is caught by
--    the assertion at the bottom only if it HAS an owner_id -- an ownerless
--    property is a pre-existing data state, not something this file created.
UPDATE public.properties p
   SET organization_id = g.id
  FROM public.organizations g
 WHERE g.legacy_owner_id = p.owner_id
   AND p.organization_id IS NULL;

-- 4. One user per account that can actually sign in.
--
--    DISTINCT ON (lower(email)) is load-bearing: two lot_owners rows sharing an
--    email would otherwise make ONE statement violate users_email_lower_key and
--    abort the whole migration. Oldest row wins, which is the row whose password
--    hash people have been using.
--
--    The NOT EXISTS re-checks against users itself so a re-run is a no-op and so
--    the partner pass below cannot collide with a user the owner pass just made
--    -- owners take precedence, exactly as routers/auth.py::_find_account_by_email
--    has since April. A partner sharing an owner's email therefore gets no user
--    row and keeps signing in through the legacy path (Task 9 keeps that path).
INSERT INTO public.users (
        email, display_name, phone, password_hash, password_set_at, last_login_at,
        password_reset_token, password_reset_expires_at,
        is_platform_admin, active, default_organization_id)
SELECT DISTINCT ON (lower(o.email))
       o.email,
       COALESCE(NULLIF(btrim(o.contact_name), ''), NULLIF(btrim(o.business_name), '')),
       NULLIF(btrim(o.phone), ''),
       o.password_hash, o.password_set_at, o.last_login_at,
       o.password_reset_token, o.password_reset_expires_at,
       o.is_platform_admin, o.active, g.id
  FROM public.lot_owners o
  JOIN public.organizations g ON g.legacy_owner_id = o.id
 WHERE btrim(COALESCE(o.email, '')) <> ''
   AND NOT EXISTS (
       SELECT 1 FROM public.users u WHERE lower(u.email) = lower(o.email))
 ORDER BY lower(o.email), o.created_at;

INSERT INTO public.users (
        email, display_name, phone, password_hash, password_set_at, last_login_at,
        password_reset_token, password_reset_expires_at,
        is_platform_admin, active, default_organization_id)
SELECT DISTINCT ON (lower(p.email))
       p.email,
       COALESCE(NULLIF(btrim(p.contact_name), ''), NULLIF(btrim(p.company_name), '')),
       NULLIF(btrim(p.phone), ''),
       p.password_hash, p.password_set_at, p.last_login_at,
       p.password_reset_token, p.password_reset_expires_at,
       -- enforcement_partners has no is_platform_admin column and never will:
       -- a tow partner is not a LotLogic administrator.
       false, p.active, g.id
  FROM public.enforcement_partners p
  JOIN public.organizations g ON g.legacy_partner_id = p.id
 WHERE btrim(COALESCE(p.email, '')) <> ''
   AND NOT EXISTS (
       SELECT 1 FROM public.users u WHERE lower(u.email) = lower(p.email))
 ORDER BY lower(p.email), p.created_at;

-- 5. Every backfilled user is an admin of its own organization. That is exactly
--    the power it has today -- the whole account. Narrower roles start with the
--    SECOND login an org creates (Task 13).
INSERT INTO public.memberships (user_id, organization_id, role)
SELECT u.id, u.default_organization_id, 'admin'
  FROM public.users u
 WHERE u.default_organization_id IS NOT NULL
ON CONFLICT (user_id, organization_id) DO NOTHING;

-- 6. Fail closed. A property that has an owner but no organization would be a
--    property the new helper cannot see, i.e. a tenant locked out of their own
--    site -- abort rather than ship that.
DO $backfill$
DECLARE
    orphans int;
    orgless_owners int;
BEGIN
    SELECT count(*) INTO orphans
      FROM public.properties
     WHERE owner_id IS NOT NULL AND organization_id IS NULL;
    IF orphans > 0 THEN
        RAISE EXCEPTION
            'tenancy backfill: % properties have an owner_id but no organization_id',
            orphans;
    END IF;

    SELECT count(*) INTO orgless_owners
      FROM public.lot_owners o
     WHERE NOT EXISTS (
           SELECT 1 FROM public.organizations g WHERE g.legacy_owner_id = o.id);
    IF orgless_owners > 0 THEN
        RAISE EXCEPTION
            'tenancy backfill: % lot_owners rows have no organization', orgless_owners;
    END IF;
END
$backfill$;

COMMIT;
```

- [ ] **Step 2: The test**

`tests/plaza/test_tenancy_backfill.py` — it must run the backfill *itself* against seeded legacy rows, because the harness replays the migration into an empty schema where there are no legacy accounts to backfill.

```python
"""20260914140100 — the backfill that keeps every existing login working.

The harness replays migrations against an empty schema, so the file's own run
is a no-op. These tests seed the legacy shapes production actually has --
including the two that break a naive backfill: two owner rows sharing an email,
and a partner whose email collides with an owner's -- then execute the file and
assert on the result. Then they execute it a second time and assert nothing
moved.
"""
import uuid
from dataclasses import dataclass
from pathlib import Path

import pytest
from sqlalchemy import text

MIGRATION = (Path(__file__).resolve().parents[2]
             / "migrations" / "20260914140100_tenancy_backfill_from_legacy_accounts.sql")


async def _run_backfill(db_conn):
    """Execute the whole migration file as one script.

    Through the RAW asyncpg connection, exactly as `conftest._apply_schema`
    does and for the reason its docstring gives: "the asyncpg dialect sends
    everything as a prepared statement, which cannot carry more than one
    command, while these scripts are multi-statement and full of dollar-quoted
    function bodies that must not be split". This file is both -- eight
    statements plus a `DO $backfill$` block. `execute(text(...))` and
    `exec_driver_sql` both go through the dialect and both fail on it.
    """
    await db_conn.commit()          # leave no open transaction behind
    raw = await db_conn.get_raw_connection()
    await raw.driver_connection.execute(MIGRATION.read_text())


@dataclass
class LegacySeed:
    owner_a: uuid.UUID       # has properties, and a duplicate-email twin
    owner_dup: uuid.UUID     # same email as owner_a, created LATER
    owner_admin: uuid.UUID
    partner_a: uuid.UUID
    partner_shared: uuid.UUID   # email collides with owner_a
    property_id: uuid.UUID      # this fixture's OWN property, not the seed
    email_a: str
    email_admin: str


@pytest.fixture
async def legacy_rows(db_conn):
    """The two legacy shapes that break a naive backfill, on rows we own.

    Every id is generated here and deleted in teardown. In particular this
    fixture creates its OWN `properties` row rather than re-pointing the
    session-scoped plaza seed: `seed_truck_plaza` asserts on that row, and
    `properties` is deliberately absent from TRUNCATE_TABLES, so an `UPDATE`
    to it would leak into every later test in the session. `lot_owners` is not
    truncated either, which is why the ids are fresh per use rather than
    constants -- a fixed id dies on the primary key the second time the
    fixture runs.
    """
    s = LegacySeed(
        owner_a=uuid.uuid4(), owner_dup=uuid.uuid4(), owner_admin=uuid.uuid4(),
        partner_a=uuid.uuid4(), partner_shared=uuid.uuid4(),
        property_id=uuid.uuid4(),
        email_a="", email_admin="",
    )
    tag = s.owner_a.hex[:8]
    s.email_a = f"ops+{tag}@example.test"
    s.email_admin = f"admin+{tag}@example.test"

    await db_conn.execute(text("""
        INSERT INTO public.lot_owners (id, business_name, contact_name, phone, email,
                                       password_hash, is_platform_admin, created_at)
        VALUES
          (:a, 'Friedlam Group', 'Ana', '', :ea, '$2b$12$hash1', false,
           now() - interval '2 days'),
          -- SAME email, NEWER row: DISTINCT ON must keep the OLDER row's hash,
          -- because that is the password people are actually using.
          (:dup, 'Friedlam Group (dup)', 'Ana2', '', :ea_upper, '$2b$12$hash2', false, now()),
          (:adm, 'LotLogic', 'Gabe', '', :eadm, '$2b$12$hash3', true, now())
    """), {"a": str(s.owner_a), "dup": str(s.owner_dup), "adm": str(s.owner_admin),
           "ea": s.email_a, "ea_upper": s.email_a.upper(), "eadm": s.email_admin})

    market_id = (await db_conn.execute(
        text("SELECT id FROM public.markets ORDER BY created_at LIMIT 1"))).scalar()
    if market_id is None:
        market_id = uuid.uuid4()
        await db_conn.execute(text(
            "INSERT INTO public.markets (id, name, state) VALUES (:m, 'Test', 'NC')"),
            {"m": str(market_id)})

    await db_conn.execute(text("""
        INSERT INTO public.enforcement_partners (id, market_id, company_name, contact_name,
                                                 phone, email, created_at)
        VALUES
          (:p, :m, 'NMLD Towing', 'Frank', '', :ep, now()),
          -- email collides with owner_a: owners win, this one gets NO user row
          (:ps, :m, 'Shared Inbox Towing', 'Sam', '', :ea, now())
    """), {"p": str(s.partner_a), "ps": str(s.partner_shared), "m": str(market_id),
           "ep": f"dispatch+{tag}@example.test", "ea": s.email_a})

    await db_conn.execute(text("""
        INSERT INTO public.properties (id, name, address, property_type, qr_code_id, owner_id)
        VALUES (:pid, 'Backfill Fixture Site', '1 Test Way', 'apartment', :qr, :a)
    """), {"pid": str(s.property_id), "qr": f"backfill-fixture-{tag}", "a": str(s.owner_a)})
    await db_conn.commit()

    yield s

    # Teardown, children first. properties.organization_id is ON DELETE SET NULL,
    # so the org delete cannot take the property with it -- delete the property
    # explicitly anyway, because this fixture created it.
    await db_conn.rollback()
    await db_conn.execute(text("""
        DELETE FROM public.memberships
         WHERE user_id IN (SELECT id FROM public.users WHERE lower(email) IN (:ea, :eadm)
                            OR email LIKE :like)
    """), {"ea": s.email_a, "eadm": s.email_admin, "like": f"%+{tag}@example.test"})
    await db_conn.execute(text("DELETE FROM public.properties WHERE id = :pid"),
                          {"pid": str(s.property_id)})
    await db_conn.execute(text("DELETE FROM public.users WHERE email LIKE :like"),
                          {"like": f"%+{tag}@example.test"})
    await db_conn.execute(text(
        "DELETE FROM public.organizations "
        " WHERE legacy_owner_id = ANY(CAST(:o AS uuid[])) "
        "    OR legacy_partner_id = ANY(CAST(:p AS uuid[]))"),
        {"o": [str(s.owner_a), str(s.owner_dup), str(s.owner_admin)],
         "p": [str(s.partner_a), str(s.partner_shared)]})
    await db_conn.execute(text(
        "DELETE FROM public.enforcement_partners WHERE id = ANY(CAST(:p AS uuid[]))"),
        {"p": [str(s.partner_a), str(s.partner_shared)]})
    await db_conn.execute(text(
        "DELETE FROM public.lot_owners WHERE id = ANY(CAST(:o AS uuid[]))"),
        {"o": [str(s.owner_a), str(s.owner_dup), str(s.owner_admin)]})
    await db_conn.commit()


# Every assertion below is scoped to the fixture's OWN ids. `organizations`,
# `users` and `properties` all carry rows this test did not create --
# organizations because it is (correctly) not truncated, properties because the
# plaza seed is session-scoped -- so a bare `count(*)` would be a flake waiting
# for the next test file.


async def test_every_legacy_account_gets_an_organization(db_conn, legacy_rows):
    s = legacy_rows
    await _run_backfill(db_conn)
    owners = (await db_conn.execute(text(
        "SELECT count(*) FROM public.organizations "
        " WHERE kind='owner' AND legacy_owner_id = ANY(CAST(:o AS uuid[]))"),
        {"o": [str(s.owner_a), str(s.owner_dup), str(s.owner_admin)]})).scalar()
    partners = (await db_conn.execute(text(
        "SELECT count(*) FROM public.organizations "
        " WHERE kind='partner' AND legacy_partner_id = ANY(CAST(:p AS uuid[]))"),
        {"p": [str(s.partner_a), str(s.partner_shared)]})).scalar()
    assert (owners, partners) == (3, 2)


async def test_duplicate_emails_collapse_to_the_oldest_row(db_conn, legacy_rows):
    s = legacy_rows
    await _run_backfill(db_conn)
    rows = (await db_conn.execute(text(
        "SELECT password_hash FROM public.users WHERE lower(email) = :e"),
        {"e": s.email_a})).all()
    assert len(rows) == 1, "one login email is one user"
    assert rows[0][0] == "$2b$12$hash1", "the older account's password must survive"


async def test_a_partner_sharing_an_owner_email_gets_no_user_row(db_conn, legacy_rows):
    s = legacy_rows
    await _run_backfill(db_conn)
    # ...and therefore keeps signing in through the legacy path, which Task 9
    # deliberately keeps. The alternative -- overwriting the owner's hash with
    # the partner's -- would lock a customer out.
    tag = s.owner_a.hex[:8]
    mine = (await db_conn.execute(text(
        "SELECT count(*) FROM public.users WHERE email LIKE :like"),
        {"like": f"%+{tag}@example.test"})).scalar()
    assert mine == 3       # owner_a, owner_admin, partner_a -- not partner_shared


async def test_every_backfilled_user_is_an_admin_of_its_own_org(db_conn, legacy_rows):
    s = legacy_rows
    await _run_backfill(db_conn)
    tag = s.owner_a.hex[:8]
    orphans = (await db_conn.execute(text("""
        SELECT count(*) FROM public.users u
         WHERE u.email LIKE :like
           AND NOT EXISTS (SELECT 1 FROM public.memberships m
                            WHERE m.user_id = u.id
                              AND m.organization_id = u.default_organization_id
                              AND m.role = 'admin')
    """), {"like": f"%+{tag}@example.test"})).scalar()
    assert orphans == 0


async def test_platform_admin_flag_carries_over(db_conn, legacy_rows):
    s = legacy_rows
    await _run_backfill(db_conn)
    assert (await db_conn.execute(text(
        "SELECT is_platform_admin FROM public.users WHERE lower(email) = :e"),
        {"e": s.email_admin})).scalar() is True


async def test_the_fixture_property_gets_an_organization(db_conn, legacy_rows):
    s = legacy_rows
    await _run_backfill(db_conn)
    org = (await db_conn.execute(text(
        "SELECT organization_id FROM public.properties WHERE id = :pid"),
        {"pid": str(s.property_id)})).scalar()
    assert org is not None
    assert (await db_conn.execute(text(
        "SELECT legacy_owner_id FROM public.organizations WHERE id = :g"),
        {"g": str(org)})).scalar() == s.owner_a


async def test_rerunning_changes_nothing(db_conn, legacy_rows):
    s = legacy_rows
    tag = s.owner_a.hex[:8]
    counts = text("""
        SELECT (SELECT count(*) FROM public.organizations
                 WHERE legacy_owner_id = ANY(CAST(:o AS uuid[]))
                    OR legacy_partner_id = ANY(CAST(:p AS uuid[]))),
               (SELECT count(*) FROM public.users WHERE email LIKE :like),
               (SELECT count(*) FROM public.memberships m
                  JOIN public.users u ON u.id = m.user_id
                 WHERE u.email LIKE :like)
    """)
    params = {"o": [str(s.owner_a), str(s.owner_dup), str(s.owner_admin)],
              "p": [str(s.partner_a), str(s.partner_shared)],
              "like": f"%+{tag}@example.test"}
    await _run_backfill(db_conn)
    before = (await db_conn.execute(counts, params)).first()
    await _run_backfill(db_conn)
    after = (await db_conn.execute(counts, params)).first()
    assert before == after


async def test_an_owned_property_without_an_org_aborts_the_migration(db_conn, legacy_rows):
    """Prove the fail-closed block can actually fail.

    Point the fixture's own property at an owner id no organization can be
    built from, and the DO block must raise rather than ship a tenant who
    cannot see their own site. Only this fixture's property is touched.
    """
    s = legacy_rows
    await _run_backfill(db_conn)
    await db_conn.execute(text("""
        UPDATE public.properties
           SET organization_id = NULL, owner_id = :ghost
         WHERE id = :pid
    """), {"ghost": str(uuid.uuid4()), "pid": str(s.property_id)})
    await db_conn.commit()
    with pytest.raises(Exception) as exc:
        await _run_backfill(db_conn)
    assert "organization_id" in str(exc.value) or "no organization" in str(exc.value)
```

**Note on the fixture, and it is the rule for every fixture this plan adds:** `properties` and `lot_owners` are deliberately absent from `TRUNCATE_TABLES` — the truck-plaza seed row lives in the first and `seed_truck_plaza` asserts on it; the second is now created by `live_schema.sql` and is not per-test state. So `legacy_rows` creates **its own** property and its own owner rows with uuids minted at fixture time, and deletes every one of them in teardown. It never `UPDATE`s the seed row, and it never uses a constant id (a constant would die on the primary key the second time the fixture runs, because `lot_owners` is not truncated). `enforcement_partners` **is** truncated between tests; the fixture still deletes its partner rows so the teardown reads the same either way.

- [ ] **Step 3: Run**

```bash
cd /Users/gabe/lotlogic-backend-tenancy
pytest tests/plaza/test_tenancy_backfill.py -q
ruff check . && python -m compileall -q -f . && pytest -x --tb=short -q
```

Expected: 8 passed, and **passing twice in a row** — run `pytest tests/plaza/test_tenancy_backfill.py -q` twice against the same database. A second run that fails on a duplicate key means a fixture is using a constant id or is not tearing down. If `test_an_owned_property_without_an_org_aborts_the_migration` passes without raising, the `DO $backfill$` block is not doing its job and the migration is not fail-closed.

- [ ] **Step 4: Commit**

```
feat(tenancy): backfill organizations, users and memberships from live accounts

Idempotent, fail-closed, and shaped around the two things production actually
contains: owner rows that share an email (oldest wins, so the password people
use survives) and a partner whose email collides with an owner's (the owner
wins, matching _find_account_by_email's April precedence -- the partner keeps
the legacy login path rather than having its hash silently replace an owner's).

This is the task that makes "every existing login keeps working" true: after
it, both paths resolve to the same JWT claims.
```

---

### Task 3: `services/tenancy.py` — the one RBAC helper

**Files:**
- Create: `services/tenancy.py`
- Modify: `services/auth.py` (two fields on `Subject`, defaulted so nothing else changes)
- Modify: `tests/test_no_client_tenant_id.py` (`organization_id` joins the forbidden list)
- Test: `tests/plaza/test_tenancy_scope.py`

**Interfaces:**
- Consumes: `services.auth.Subject`; an open `AsyncSession`.
- Produces, for Tasks 4, 9, 11, 13:
  - `tenancy.Role` — `VIEWER < STAFF < MANAGER < ADMIN`, a `str` enum whose values match the `memberships.role` CHECK.
  - `await tenancy.assert_property_access(db, subject, property_id, *, allow_partner: bool = False, need: Role = Role.STAFF) -> None` — raises `HTTPException(404, "Property not found")` on any miss. **`need` only ever gates the org-membership branch**; the legacy owner/partner branches have no role to check and are unaffected by it. Task 4's frozen alias passes `need=Role.VIEWER` explicitly so a `viewer` membership keeps the read access the alias has always granted — see that task for why the STAFF default is wrong there.
  - `await tenancy.allowed_property_ids(db, subject, *, allow_partner: bool = True, need: Role = Role.VIEWER) -> set[uuid.UUID] | None` — `None` means unrestricted.
  - `await tenancy.user_organizations(db, user_id) -> list[OrgMembership]` where `OrgMembership = (organization_id, kind, role, legacy_owner_id, legacy_partner_id, name)`.
  - `tenancy.roles_at_least(need: Role) -> list[str]`.
- Also produces: `Subject.user_id: uuid.UUID | None = None` and `Subject.organization_ids: tuple[uuid.UUID, ...] = ()` — added here with defaults so every existing `Subject(...)` construction in the repo and in tests keeps compiling; Task 9 is what starts populating them.

- [ ] **Step 1: Extend `Subject`**

In `services/auth.py`, inside `@dataclass(frozen=True) class Subject`, after `is_platform_admin`:

```python
    #: The `users` row behind this session, when the login resolved through the
    #: Wave 2.2 tenancy model. `None` for a service key and for a legacy
    #: owner/partner login issued before Task 9 (or after it, for the accounts
    #: the backfill deliberately left on the legacy path). `services/tenancy.py`
    #: treats a `None` here as "this subject has no memberships", which is
    #: exactly right: it then falls back to the legacy owner_id/partner_id
    #: branches and behaves as it did before this wave.
    user_id: Optional[uuid.UUID] = None
    #: Organisations this login is a member of, from the `org_ids` claim. Empty
    #: for every pre-Task-9 token. Carried on the Subject so a route that only
    #: needs "which orgs" does not re-query; `services/tenancy.py` never trusts
    #: it for an authorisation decision -- it re-reads `memberships` instead,
    #: because a membership revoked after the token was issued must take effect
    #: before the token expires.
    organization_ids: tuple[uuid.UUID, ...] = ()
```

and in `subject_from_claims`, parse them defensively (a malformed claim must degrade to "no orgs", never 500):

```python
    raw_user_id = claims.get("user_id")
    user_id: Optional[uuid.UUID] = None
    if raw_user_id:
        try:
            user_id = uuid.UUID(str(raw_user_id))
        except (ValueError, TypeError, AttributeError):
            log.debug("subject_from_claims: unparseable user_id claim")

    org_ids: list[uuid.UUID] = []
    for raw in (claims.get("org_ids") or []):
        try:
            org_ids.append(uuid.UUID(str(raw)))
        except (ValueError, TypeError, AttributeError):
            continue
```

then pass `user_id=user_id, organization_ids=tuple(org_ids)` into the returned `Subject`.

- [ ] **Step 2: Write `services/tenancy.py`**

```python
"""services/tenancy.py — the one answer to "does this login own this property".

Before Wave 2.2 there were four, and they disagreed:

  routers/visitor_passes._assert_property_scope
      unrestricted bypass; owner -> properties.owner_id; partner -> tow_company_id
      but only when the caller passed allow_partner=True; 404 on every miss.
      The most complete of the four, and the one plaza_payments.py, apartment_passes.py
      and apartment_docs.py all import.
  routers/resident_plates._assert_property_scope
      `subject.is_service` rather than `subject.is_unrestricted` -- so a PLATFORM
      ADMIN got a 403 from this one and a pass from that one; 403 (not 404) for a
      non-owner, which tells the caller the property exists; no partner branch.
  routers/lots.py::list_registered
      the resident_plates rules, re-typed inline, with the same two defects.
  routers/quickbooks.py
      `Property.owner_id == subject.id` inline, twice; no unrestricted branch at
      all, so the service key sees nothing.

Resolved here, once:

  * unrestricted (service key OR platform admin) always passes. The `is_service`
    check was a bug whose only effect was a 403 for the one person who is allowed
    to see everything.
  * a miss is ALWAYS 404, never 403. services/scope.py's comment says why: 403
    tells the caller the row exists.
  * a partner passes only when the caller opts in, and only on a property it
    actually enforces -- now `tow_company_id OR partner_id`, matching both the
    RLS policy (properties_authenticated_select) and the dashboard's
    scopePropsToPartner. Verified 2026-09-14: those two columns are equal on all
    11 production rows, so this widening is a no-op today and a correctness fix
    the first time they differ.

The new, additive branch is organisation membership: a login whose organisation
owns the property passes even when properties.owner_id does not point at that
login's legacy account. That is what lets a leasing office have three named
staff logins -- the second and third have no lot_owners row at all.

Read `memberships` on every call rather than trusting the token's `org_ids`
claim. A JWT lives for hours; a membership revoked this morning must stop
working this morning.

`need` applies to the MEMBERSHIP branch only. A legacy owner or partner login
carries no role -- it is the whole account -- so raising `need` cannot take
access away from anyone who has it today. That asymmetry is deliberate: it is
what lets Task 4 be a pure substitution.
"""
from __future__ import annotations

import enum
import uuid
from typing import NamedTuple, Optional

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from services.auth import Subject

#: Uniform miss message. Never "you do not have access to property X".
PROPERTY_NOT_FOUND = "Property not found"


class Role(str, enum.Enum):
    """Values match the memberships.role CHECK, ordered least to most power."""
    VIEWER = "viewer"
    STAFF = "staff"
    MANAGER = "manager"
    ADMIN = "admin"


_RANK: dict[Role, int] = {Role.VIEWER: 0, Role.STAFF: 1, Role.MANAGER: 2, Role.ADMIN: 3}


def roles_at_least(need: Role) -> list[str]:
    """Role names ranking at or above `need`, for a SQL `= ANY(...)`."""
    return [r.value for r in Role if _RANK[r] >= _RANK[need]]


class OrgMembership(NamedTuple):
    organization_id: uuid.UUID
    name: str
    kind: str
    role: str
    legacy_owner_id: Optional[uuid.UUID]
    legacy_partner_id: Optional[uuid.UUID]


# One statement, three branches OR'd together, so a check is one round trip
# whichever branch answers. CAST(:x AS uuid) rather than a bare :x: asyncpg
# refuses to infer a type for a NULL parameter, and every one of these is
# legitimately NULL for some subject shape.
_ACCESS_PREDICATE = """
    (   (CAST(:owner_id AS uuid) IS NOT NULL AND p.owner_id = CAST(:owner_id AS uuid))
     OR (:allow_partner AND CAST(:partner_id AS uuid) IS NOT NULL
         AND (   p.tow_company_id = CAST(:partner_id AS uuid)
              OR p.partner_id     = CAST(:partner_id AS uuid)))
     OR (CAST(:user_id AS uuid) IS NOT NULL AND p.organization_id IS NOT NULL
         AND EXISTS (
             SELECT 1
               FROM public.memberships m
               JOIN public.users u ON u.id = m.user_id
              WHERE m.user_id = CAST(:user_id AS uuid)
                AND m.organization_id = p.organization_id
                AND m.role = ANY(CAST(:roles AS text[]))
                AND u.active))
    )
"""

_ASSERT_SQL = f"""
    SELECT 1 FROM public.properties p
     WHERE p.id = CAST(:property_id AS uuid) AND {_ACCESS_PREDICATE}
     LIMIT 1
"""

_LIST_SQL = f"""
    SELECT p.id FROM public.properties p
     WHERE {_ACCESS_PREDICATE}
"""


def _params(subject: Subject, *, allow_partner: bool, need: Role) -> dict:
    return {
        "owner_id": str(subject.id) if subject.is_owner and subject.id else None,
        "partner_id": str(subject.id) if subject.is_partner and subject.id else None,
        "user_id": str(subject.user_id) if subject.user_id else None,
        "allow_partner": allow_partner,
        "roles": roles_at_least(need),
    }


async def assert_property_access(
    db: AsyncSession,
    subject: Subject,
    property_id: uuid.UUID,
    *,
    allow_partner: bool = False,
    need: Role = Role.STAFF,
) -> None:
    """Raise 404 unless `subject` may act on `property_id`.

    `allow_partner` defaults to False so a write path stays owner-side unless it
    says otherwise -- the same default routers/visitor_passes._assert_property_scope
    has shipped with since April, kept deliberately so Task 4 is a mechanical
    substitution and not a behaviour change at 20 call sites.
    """
    if subject.is_unrestricted:
        return
    if not (subject.is_owner or subject.is_partner or subject.user_id):
        raise HTTPException(status_code=404, detail=PROPERTY_NOT_FOUND)
    row = (await db.execute(
        text(_ASSERT_SQL),
        {**_params(subject, allow_partner=allow_partner, need=need),
         "property_id": str(property_id)},
    )).first()
    if not row:
        raise HTTPException(status_code=404, detail=PROPERTY_NOT_FOUND)


async def allowed_property_ids(
    db: AsyncSession,
    subject: Subject,
    *,
    allow_partner: bool = True,
    need: Role = Role.VIEWER,
) -> Optional[set[uuid.UUID]]:
    """The property ids `subject` may see. `None` means unrestricted.

    Mirrors services/scope.allowed_lot_ids' contract exactly -- None means "add
    no filter", an empty set means "no properties at all" -- so a caller can
    swap one for the other without re-reading the None handling.
    """
    if subject.is_unrestricted:
        return None
    if not (subject.is_owner or subject.is_partner or subject.user_id):
        return set()
    rows = (await db.execute(
        text(_LIST_SQL), _params(subject, allow_partner=allow_partner, need=need)
    )).all()
    return {r[0] for r in rows}


async def user_organizations(db: AsyncSession, user_id: uuid.UUID) -> list[OrgMembership]:
    """Every organisation this user belongs to, with the role held in each.

    Task 9 uses this to build the JWT claims; Task 13 uses it to decide whether
    an admin is adding a login to an org that exists."""
    rows = (await db.execute(text("""
        SELECT g.id, g.name, g.kind, m.role, g.legacy_owner_id, g.legacy_partner_id
          FROM public.memberships m
          JOIN public.organizations g ON g.id = m.organization_id
         WHERE m.user_id = CAST(:uid AS uuid) AND g.active
         ORDER BY g.created_at
    """), {"uid": str(user_id)})).all()
    return [OrgMembership(*r) for r in rows]
```

- [ ] **Step 3: `organization_id` joins the forbidden-parameter list**

In `tests/test_no_client_tenant_id.py`:

```python
FORBIDDEN_PARAM_NAMES = {"owner_id", "partner_id", "organization_id"}
```

and extend `ROUTER_MODULES` with the routers added since that file was written, which are also the ones this plan touches:

```python
ROUTER_MODULES = [
    "routers.auth",
    "routers.snapshots",
    "routers.violations",
    "routers.alpr",
    "routers.lots",
    "routers.cameras",
    "routers.quickbooks",
    "routers.visitor_passes",
    "routers.resident_plates",
    "routers.apartment_passes",
    "routers.apartment_docs",
    "routers.admin",
]
```

**Expect this to surface real hits.** Read each one before adding it to `VERIFIED_SAFE`; the file's own comment says an exemption means you have confirmed the handler scopes first and only honours the client value for `subject.is_service`. If a hit is not genuinely safe, that is a finding, not a test to loosen — record it and fix it in the same commit.

- [ ] **Step 4: The test**

`tests/plaza/test_tenancy_scope.py`, against real Postgres. The negatives are the point.

```python
"""services/tenancy.py -- the one ownership helper (BACKEND-6).

Every assertion here is a case where at least one of the four old copies got a
different answer. The three that matter most:

  * a PLATFORM ADMIN on a resident-plates-shaped call (the old copy returned 403)
  * a partner on a property it enforces via partner_id but not tow_company_id
    (the old copy returned 404; RLS and the dashboard both said yes)
  * a staff login with a membership but no lot_owners row (impossible before 2.2)
"""
import uuid
from dataclasses import dataclass

import pytest
from sqlalchemy import text

from services.auth import Subject
from services.tenancy import Role, allowed_property_ids, assert_property_access


@dataclass
class Scoped:
    property_id: uuid.UUID
    owner_id: uuid.UUID
    partner_id: uuid.UUID
    other_owner: uuid.UUID
    org_id: uuid.UUID
    staff_user: uuid.UUID


@pytest.fixture
async def scoped_property(db_conn):
    """A property this test owns outright.

    NOT the plaza seed. `seed_truck_plaza` asserts on that row's
    property_type and policy_text, `properties` is absent from
    TRUNCATE_TABLES, and an UPDATE to it leaks into every later test in the
    session. Every id here is minted per use and deleted in teardown --
    `organizations` is (correctly) never truncated, so a constant org id would
    collide on the second use.
    """
    s = Scoped(property_id=uuid.uuid4(), owner_id=uuid.uuid4(),
               partner_id=uuid.uuid4(), other_owner=uuid.uuid4(),
               org_id=uuid.uuid4(), staff_user=uuid.uuid4())
    tag = s.property_id.hex[:8]
    await db_conn.execute(text(
        "INSERT INTO public.organizations (id, name, kind) VALUES (:g,'Scope Org','owner')"),
        {"g": str(s.org_id)})
    await db_conn.execute(text(
        "INSERT INTO public.users (id, email, active) VALUES (:u, :e, true)"),
        {"u": str(s.staff_user), "e": f"staff+{tag}@example.test"})
    await db_conn.execute(text(
        "INSERT INTO public.memberships (user_id, organization_id, role) "
        "VALUES (:u, :g, 'staff')"), {"u": str(s.staff_user), "g": str(s.org_id)})
    # tow_company_id deliberately NULL: the partner is attached by partner_id
    # only, which is the case the shipped helper got wrong.
    await db_conn.execute(text("""
        INSERT INTO public.properties
            (id, name, address, property_type, qr_code_id,
             owner_id, partner_id, tow_company_id, organization_id)
        VALUES (:pid, 'Scope Fixture Site', '2 Test Way', 'apartment', :qr,
                :o, :p, NULL, :g)
    """), {"pid": str(s.property_id), "qr": f"scope-fixture-{tag}",
           "o": str(s.owner_id), "p": str(s.partner_id), "g": str(s.org_id)})
    await db_conn.commit()

    yield s

    await db_conn.rollback()
    await db_conn.execute(text("DELETE FROM public.properties WHERE id = :pid"),
                          {"pid": str(s.property_id)})
    await db_conn.execute(text("DELETE FROM public.memberships WHERE user_id = :u"),
                          {"u": str(s.staff_user)})
    await db_conn.execute(text("DELETE FROM public.users WHERE id = :u"),
                          {"u": str(s.staff_user)})
    await db_conn.execute(text("DELETE FROM public.organizations WHERE id = :g"),
                          {"g": str(s.org_id)})
    await db_conn.commit()


def _subject(scoped, **kw):
    base = dict(type="owner", id=scoped.owner_id, email="o@example.test")
    base.update(kw)
    return Subject(**base)


async def test_owner_of_the_property_passes(db_conn, scoped_property):
    s = scoped_property
    await assert_property_access(db_conn, _subject(s), s.property_id)


async def test_a_different_owner_gets_404_not_403(db_conn, scoped_property):
    s = scoped_property
    with pytest.raises(Exception) as exc:
        await assert_property_access(db_conn, _subject(s, id=s.other_owner), s.property_id)
    assert getattr(exc.value, "status_code", None) == 404


async def test_platform_admin_passes_where_the_old_copy_returned_403(db_conn, scoped_property):
    s = scoped_property
    admin = _subject(s, id=s.other_owner, is_platform_admin=True)
    await assert_property_access(db_conn, admin, s.property_id)


async def test_service_key_passes(db_conn, scoped_property):
    await assert_property_access(
        db_conn, Subject(type="service", id=None), scoped_property.property_id)


async def test_partner_is_denied_unless_the_caller_opts_in(db_conn, scoped_property):
    s = scoped_property
    partner = Subject(type="partner", id=s.partner_id, email="p@example.test")
    with pytest.raises(Exception) as exc:
        await assert_property_access(db_conn, partner, s.property_id)
    assert getattr(exc.value, "status_code", None) == 404
    await assert_property_access(db_conn, partner, s.property_id, allow_partner=True)


async def test_partner_matches_on_partner_id_not_only_tow_company_id(db_conn, scoped_property):
    # The fixture sets tow_company_id = NULL on purpose. The shipped helper
    # checked only tow_company_id and would 404 here, disagreeing with the RLS
    # policy and with the dashboard's own client-side scoping.
    s = scoped_property
    partner = Subject(type="partner", id=s.partner_id, email="p@example.test")
    await assert_property_access(db_conn, partner, s.property_id, allow_partner=True)


async def test_a_membership_grants_access_with_no_legacy_account(db_conn, scoped_property):
    s = scoped_property
    staff = Subject(type="owner", id=None, email="staff@example.test", user_id=s.staff_user)
    await assert_property_access(db_conn, staff, s.property_id, need=Role.STAFF)


async def test_a_viewer_still_reads_through_the_frozen_alias_default(db_conn, scoped_property):
    """D12. The helper defaults to need=STAFF; the alias Task 4 keeps must pass
    need=VIEWER, or a viewer membership 404s on every read it guards."""
    s = scoped_property
    await db_conn.execute(text(
        "UPDATE public.memberships SET role='viewer' WHERE user_id=:u"),
        {"u": str(s.staff_user)})
    await db_conn.commit()
    viewer = Subject(type="owner", id=None, email="v@example.test", user_id=s.staff_user)
    await assert_property_access(db_conn, viewer, s.property_id, need=Role.VIEWER)
    with pytest.raises(Exception):
        await assert_property_access(db_conn, viewer, s.property_id)   # STAFF default


async def test_a_membership_below_the_required_role_is_denied(db_conn, scoped_property):
    s = scoped_property
    staff = Subject(type="owner", id=None, email="staff@example.test", user_id=s.staff_user)
    with pytest.raises(Exception) as exc:
        await assert_property_access(db_conn, staff, s.property_id, need=Role.ADMIN)
    assert getattr(exc.value, "status_code", None) == 404


async def test_a_deactivated_user_loses_access_immediately(db_conn, scoped_property):
    s = scoped_property
    await db_conn.execute(text("UPDATE public.users SET active=false WHERE id=:u"),
                          {"u": str(s.staff_user)})
    await db_conn.commit()
    staff = Subject(type="owner", id=None, email="staff@example.test", user_id=s.staff_user)
    with pytest.raises(Exception):
        await assert_property_access(db_conn, staff, s.property_id)


async def test_allowed_property_ids_is_none_for_unrestricted(db_conn, scoped_property):
    assert await allowed_property_ids(db_conn, Subject(type="service", id=None)) is None


async def test_allowed_property_ids_is_scoped_to_the_owner(db_conn, scoped_property):
    s = scoped_property
    assert await allowed_property_ids(db_conn, _subject(s, id=s.other_owner)) == set()
    assert s.property_id in await allowed_property_ids(db_conn, _subject(s))
```

- [ ] **Step 5: Run**

```bash
cd /Users/gabe/lotlogic-backend-tenancy
ruff check . && python -m compileall -q -f . && pytest -x --tb=short -q
```

Expected: 12 new tests pass, twice in a row against the same database; `tests/test_no_client_tenant_id.py` still passes (or names a genuine finding you then fix).

- [ ] **Step 6: Commit**

```
feat(tenancy): one services/tenancy.py, replacing four disagreeing scope copies

The four copies disagreed on three things: whether a platform admin is allowed
(resident_plates checked is_service, not is_unrestricted -- so Gabe got a 403
from one endpoint and a pass from the next), whether a miss is 403 or 404 (403
tells the caller the row exists), and whether a partner matches on
tow_company_id alone or also on partner_id (RLS and the dashboard said both;
the helper said one). All three are resolved here, and the org-membership
branch is added, so a leasing office can have named staff logins.

Closes BACKEND-6. Task 4 deletes the copies.
```

---

### Task 4: Delete the four copies

**Files:**
- Modify: `routers/visitor_passes.py` (body of `_assert_property_scope` → one delegating line; **name and signature frozen**)
- Modify: `routers/resident_plates.py` (delete its copy)
- Modify: `routers/lots.py` (delete the inline copy in `list_registered`)
- Modify: `routers/quickbooks.py` (two inline filters → `tenancy.allowed_property_ids`)
- Test: `tests/test_one_ownership_helper.py` (new), plus every existing suite unchanged and green

**Interfaces:**
- Consumes: `services/tenancy.py` from Task 3.
- Produces: no new interface. `routers.visitor_passes._assert_property_scope` continues to exist with the same import path and signature — `routers/plaza_payments.py:76` imports it and that file is on the never-edit list.

- [ ] **Step 1: `routers/visitor_passes.py` — keep the name, empty the body**

Replace the function body (keep the `def` line exactly as it is):

```python
async def _assert_property_scope(
    db: AsyncSession, subject: Subject, property_id: uuid.UUID,
    *, allow_partner: bool = False,
) -> None:
    """Raise 404 unless the subject is authorized to see this property.

    KEPT AS A NAME, NOT AS AN IMPLEMENTATION. routers/plaza_payments.py,
    routers/apartment_passes.py and routers/apartment_docs.py all import this
    symbol, and plaza_payments.py is on the Stripe cutover's never-edit list --
    so this path and this signature are frozen. The rules moved to
    services/tenancy.py in Wave 2.2 and this is now one line.
    """
    await tenancy.assert_property_access(
        db, subject, property_id,
        allow_partner=allow_partner,
        # need=VIEWER, NOT the helper's STAFF default. This alias guards a mix
        # of reads and writes across four routers, and before Wave 2.2 there
        # was no role concept at all -- every member of an account could do all
        # of it. Delegating at STAFF would newly 404 a `viewer` membership on
        # every read this alias covers, which is a permission regression
        # invented by a default. Tightening individual endpoints to
        # need=Role.MANAGER (cancel, edit) is a follow-up with its own tests,
        # not a side effect of this substitution.
        need=tenancy.Role.VIEWER,
    )
```

with `from services import tenancy` at the top.

- [ ] **Step 2: `routers/resident_plates.py`**

Delete its `_assert_property_scope` entirely and change the one call site (`cancel_resident_plate`, ~line 79):

```python
    await tenancy.assert_property_access(db, subject, row["property_id"])
```

**Behaviour change, deliberate, say so in the commit:** a platform admin who used to get `403 Owner account required` now passes, and a partner who used to get 403 now gets 404. Both are corrections, and the 403→404 change is the whole reason `services/scope.py` returns 404.

- [ ] **Step 3: `routers/lots.py::list_registered`**

Replace the seven inline lines (`# Tenant scope: mirrors _assert_property_scope from visitor_passes.py` through the `raise HTTPException(status_code=404, ...)`) with:

```python
    # `lot_id` is a property_id here -- the ALPR pipeline uses `properties`
    # while the legacy pipeline uses `lots`, and the dashboard passes the same
    # UUID into both. One helper now answers for both shapes.
    await tenancy.assert_property_access(db, subject, lot_id)
```

- [ ] **Step 4: `routers/quickbooks.py` — replace the predicate, keep the projection**

There are exactly **two** inline sites, and neither is a `SELECT *`. Read them before editing:

- `run_weekly_invoicing`, **line 185** — inside `select(_distinct(Property.tow_company_id)).where(Property.tow_company_id.is_not(None), Property.owner_id == subject.id)`. It is collecting **partner ids**, not property rows.
- `_owner_partner_ids`, **line 322** — `select(Property.tow_company_id).where(Property.tow_company_id.is_not(None), Property.owner_id == subject.id)`. Same shape.

So at each site: **keep the `Property.tow_company_id` projection exactly as it is, and swap only the `Property.owner_id == subject.id` predicate** for the helper's id set.

```python
    prop_ids = await tenancy.allowed_property_ids(db, subject, allow_partner=False)
    # None = unrestricted (service key / platform admin) -> add no property
    # filter at all. This query has never had an unrestricted branch, which is
    # the third thing the inline copy got wrong (BACKEND-6).
    q = select(_distinct(Property.tow_company_id)).where(
        Property.tow_company_id.is_not(None))
    if prop_ids is not None:
        q = q.where(Property.id.in_(prop_ids))
```

`prop_ids == set()` makes `Property.id.in_(set())` match nothing — correct, and exactly what the old predicate did for an owner with no properties.

The raw SQL at line ~245 already takes a nullable `:owner_id` parameter; **leave it and keep passing `owner_scope_id`**. It is a second, narrower filter inside the invoice query, and removing it is not this task's job.

**Do not change what QuickBooks invoices.** The acceptance criterion for this step is `tests/test_quickbooks_connection.py` and `tests/test_quickbooks_invoice_builder.py` **unchanged and green**. If either needs editing, the substitution is wrong.

- [ ] **Step 5: The test that keeps them deleted**

`tests/test_one_ownership_helper.py`:

```python
"""There is exactly one implementation of "does this login own this property".

BACKEND-6 was four copies that disagreed. This is the test that stops a fifth
appearing: it greps the router package for the shapes the four copies had.
A new router that needs a property scope check must import services.tenancy.
"""
from __future__ import annotations

import pathlib
import re

ROUTERS = pathlib.Path(__file__).resolve().parents[1] / "routers"

#: The SQL shape all four copies shared, in any whitespace arrangement.
_INLINE_SCOPE = re.compile(
    r"FROM\s+public\.properties\s+WHERE\s+id\s*=\s*:\w+\s+AND\s+(owner_id|tow_company_id)",
    re.IGNORECASE | re.DOTALL,
)

#: `Property.owner_id == subject.id` and friends.
_ORM_SCOPE = re.compile(r"Property\.(owner_id|tow_company_id|partner_id)\s*==\s*subject\.id")

ALLOWED = {
    # The frozen name plaza_payments.py imports. Its body is one delegating
    # line; this file asserts that below.
    "visitor_passes.py",
}


def test_no_router_hand_rolls_a_property_scope_check():
    offenders = []
    for path in sorted(ROUTERS.glob("*.py")):
        src = path.read_text()
        squashed = " ".join(src.split())
        if _INLINE_SCOPE.search(squashed) or _ORM_SCOPE.search(src):
            offenders.append(path.name)
    unexpected = [o for o in offenders if o not in ALLOWED]
    assert not unexpected, (
        "these routers hand-roll a property ownership check instead of calling "
        f"services.tenancy.assert_property_access: {unexpected}"
    )


def test_the_frozen_alias_delegates_and_does_not_reimplement():
    src = (ROUTERS / "visitor_passes.py").read_text()
    start = src.index("async def _assert_property_scope")
    body = src[start:src.index("\ndef ", start)]
    assert "tenancy.assert_property_access" in body
    assert "public.properties" not in body, (
        "_assert_property_scope must stay a delegating alias -- plaza_payments.py "
        "imports it and is on the never-edit list, so the NAME is frozen and the "
        "RULES live in services/tenancy.py"
    )


def test_the_alias_is_still_importable_from_its_frozen_path():
    from routers.visitor_passes import _assert_property_scope  # noqa: F401
```

**Prove it can fail:** before committing, paste the old `resident_plates` body back into that file, run `pytest tests/test_one_ownership_helper.py`, confirm `test_no_router_hand_rolls_a_property_scope_check` fails and names `resident_plates.py`, then remove it again.

- [ ] **Step 6: Run everything**

```bash
cd /Users/gabe/lotlogic-backend-tenancy
ruff check . && python -m compileall -q -f . && pytest -x --tb=short -q
```

The whole suite must be green with **no edits to** `tests/test_apartment_scoping.py`, `tests/test_snapshot_scoping.py`, `tests/test_owner_allowlist.py`, `tests/test_partner_allowlist.py`, `tests/test_quickbooks_*.py` or `tests/plaza/test_plaza_summary.py`. Those six files are the regression surface for this substitution. One of them needing an edit means a behaviour changed that this task did not intend.

- [ ] **Step 7: Commit**

```
refactor(tenancy): the four ownership copies become one call each

visitor_passes._assert_property_scope keeps its name and signature forever --
plaza_payments.py imports it and that file is frozen by the Stripe cutover --
and becomes one delegating line. resident_plates', lots' and quickbooks' copies
are deleted.

Two deliberate behaviour changes, both corrections: a platform admin now passes
the resident-plates and registered-passes checks (they tested is_service, so the
one account allowed to see everything got a 403), and a non-owner subject gets
404 instead of 403 there (403 confirms the property exists).

tests/test_one_ownership_helper.py is what stops a fifth copy appearing.
```

---

### Task 5: `tests/test_route_guards.py` — the route walk that fails the build

**Files:**
- Create: `tests/test_route_guards.py`
- Modify: `main.py` — **comments only**, plus one exported helper name (see Step 2). No behaviour change.

**Interfaces:**
- Consumes: `main.app.routes`, `main.PUBLIC_PATHS`, `main._is_public_path`, the guard dependency names in `services/auth.py` and `routers/app_api.py`.
- Produces: `tests/test_route_guards.py::HANDLER_VERIFIED` — the single, reviewed list of endpoints whose credential is checked inside the handler rather than by a dependency. Every future addition to it is a code-review decision with a written reason.

This is the task the 2.2 row calls *"a test that walks every route and fails the build if a new endpoint has no guard and no explicit public-list entry — that permanently retires the class of bug behind items 5 and 15."* It is independent of every other task and can run first.

- [ ] **Step 1: Write the walker**

`tests/test_route_guards.py`:

```python
"""Every route is guarded, or explicitly public. No third option.

The bug class this retires, twice over:

  * BACKEND-2 / SEC-1 -- two endpoints sat behind the login wall and never asked
    whether the login owned the lot, so any apartment-manager credential could
    walk sequential photo ids across every property.
  * SEC-5 / PLATFORM-6 -- the tow partner could edit the fees LotLogic's revenue
    is computed from.

Both were "somebody added a route and nobody noticed what it did not check".
A grep does not catch that. Walking the assembled app does.

Three rules, checked separately so a failure says which one broke:

  1. Every APIRoute either (a) resolves as public through main._is_public_path,
     (b) has a guard dependency in its dependency tree, or (c) is in
     HANDLER_VERIFIED with a reason. Nothing else passes.
  2. Every entry in main.PUBLIC_PATHS corresponds to a route that exists. A
     stale entry is a path that is allow-listed for whatever claims it next.
  3. Every entry in HANDLER_VERIFIED still corresponds to a route that exists
     and is still not otherwise guarded -- so the list shrinks when a route is
     fixed properly, instead of quietly outliving it.
"""
from __future__ import annotations

import pytest
from fastapi import Depends, FastAPI
from fastapi.routing import APIRoute

import main

#: Dependencies that resolve or require an authenticated subject. A route whose
#: dependency tree contains ANY of these has asked the question. Whether it then
#: scopes the answer is services/tenancy.py's job and
#: tests/test_no_client_tenant_id.py's -- this file only asks whether the
#: question was asked at all.
GUARD_DEPENDENCIES = frozenset({
    "require_subject",
    "resolve_subject",
    "require_user_subject",
    "require_platform_admin",
    # routers/app_api.py -- the NMLD app's own JWT (aud="nmld-app").
    "require_app_phone",
})

#: Routes whose credential is verified INSIDE the handler, not by a dependency.
#: Keyed (METHOD, path) -> the reason you verified.
#:
#: Almost every one of these is ALSO in main.PUBLIC_PATHS, and must be: the
#: middleware has to stand aside or Square, Twilio, a camera or a driver's
#: phone would be 401'd before the handler could check the credential it
#: actually holds. That overlap is exactly why `_is_unguarded` consults THIS
#: dict FIRST -- checking PUBLIC_PATHS first made the entire list dead code.
#:
#: Adding an entry is a code-review decision: you have read the handler and
#: confirmed it rejects an unauthenticated caller before doing anything. Do NOT
#: add an entry to make this file green.
HANDLER_VERIFIED: dict[tuple[str, str], str] = {
    ("POST", "/alpr/ingest"):
        "per-camera X-Camera-Key, validated against alpr_cameras.api_key in the "
        "handler. Cameras hold no JWT and no service key.",
    ("POST", "/plaza/webhook"):
        "Square's x-square-hmacsha256-signature, verified in-handler against "
        "SQUARE_WEBHOOK_SIGNATURE_KEY over the raw bytes.",
    ("POST", "/violations/sms-webhook"):
        "Twilio's X-Twilio-Signature, verified when "
        "TWILIO_WEBHOOK_VALIDATION_ENABLED is on (off while the account is dead).",
    ("GET", "/violations/action"):
        "JWT in the URL, audience 'violation-action'. GET only RENDERS the "
        "confirm form -- a corporate link scanner cannot record a tow.",
    ("POST", "/violations/action"):
        "same one-purpose 48h JWT, decoded by decode_violation_action_token.",
    ("GET", "/quickbooks/oauth/callback"):
        "Intuit redirect; authenticated by the signed `state` parameter "
        "(verify_state) before any token exchange.",
    ("POST", "/auth/login"): "issues the credential; cannot require one.",
    ("POST", "/auth/set-password"): "consumes a single-use reset token.",
    ("POST", "/auth/request-password"): "generates a reset token; rate-limited in Task 8.",
    ("POST", "/auth/seed-test-account"):
        "X-Admin-Key against ADMIN_API_KEY, and a no-op when that is empty "
        "(which is production). Fat decision 24 proposes deleting it.",
    ("POST", "/visitor_passes/register"): "public QR form; reCAPTCHA v3 in-handler.",
    ("POST", "/resident_plates/register"): "public QR form; reCAPTCHA v3 in-handler.",
    ("POST", "/apartment/uploads"): "public QR form; reCAPTCHA v3 in-handler.",
    ("POST", "/plaza/quote-and-start"):
        "public pay-to-park entrance; reCAPTCHA v3 + properties.pay_to_park_enabled.",
    ("GET", "/visitor_passes/check-active"):
        "public pre-flight. Returns {active, valid_until, reference_id} only.",
    ("GET", "/health"): "liveness. No database, no data.",
    ("GET", "/ready"): "readiness probe for Railway, which presents no credential.",
}

#: Static operator pages served from the backend root. They are in PUBLIC_PATHS
#: by NAME (deliberately, so a future route cannot join the list by being called
#: something.html) and fat decision 5 proposes deleting all three.
STATIC_PAGE_PATHS = frozenset({
    "/operator-portal.html", "/zone_editor.html", "/billing.html",
})


def _guard_names(route: APIRoute) -> set[str]:
    """Every dependency callable name in the route's dependency tree."""
    seen: set[str] = set()
    stack = list(getattr(route.dependant, "dependencies", []))
    while stack:
        dep = stack.pop()
        call = getattr(dep, "call", None)
        if call is not None:
            seen.add(getattr(call, "__name__", ""))
        stack.extend(getattr(dep, "dependencies", []))
    return seen


def _api_routes() -> list[APIRoute]:
    return [r for r in main.app.routes if isinstance(r, APIRoute)]


def _is_unguarded(route: APIRoute, method: str) -> bool:
    """ORDER MATTERS. HANDLER_VERIFIED is consulted BEFORE _is_public_path.

    Almost every entry in HANDLER_VERIFIED is also in main.PUBLIC_PATHS -- it
    has to be, or the session middleware would 401 the very callers (Square,
    Twilio, a camera, a driver's phone) whose credential the handler exists to
    check. Asking `_is_public_path` first therefore classified all of them as
    "public" and left HANDLER_VERIFIED dead code: a route could lose its
    in-handler check entirely and nothing would notice, because PUBLIC_PATHS
    had already excused it.

    Reversed, the two lists say different things and both stay alive:
    PUBLIC_PATHS says "the session middleware stands aside here", and
    HANDLER_VERIFIED says "...and this is the credential that makes that safe".
    """
    if (method, route.path) in HANDLER_VERIFIED:
        return False
    if route.path in STATIC_PAGE_PATHS:
        return False
    if main._is_public_path(route.path):
        return False
    if GUARD_DEPENDENCIES & _guard_names(route):
        return False
    return True


def test_every_route_is_guarded_or_explicitly_public():
    unguarded = sorted(
        f"{m} {r.path}  (endpoint {r.endpoint.__module__}.{r.endpoint.__name__})"
        for r in _api_routes()
        for m in sorted(r.methods or set())
        if m not in ("HEAD", "OPTIONS") and _is_unguarded(r, m)
    )
    assert not unguarded, (
        "These endpoints have no guard dependency and no explicit public entry.\n"
        "Add `subject: Subject = Depends(require_subject)` (then scope with "
        "services/tenancy.py), or `Depends(require_platform_admin)` for an "
        "admin/ops route. If the route is genuinely public, add it to "
        "main.PUBLIC_PATHS; if it verifies its own credential in the handler, "
        "add it to HANDLER_VERIFIED in this file WITH A REASON.\n\n  "
        + "\n  ".join(unguarded)
    )


def test_public_paths_all_resolve_to_a_real_route():
    known = {r.path for r in _api_routes()} | STATIC_PAGE_PATHS
    stale = sorted(p for p in main.PUBLIC_PATHS if p not in known)
    assert not stale, (
        "main.PUBLIC_PATHS allow-lists paths that no route serves. An allow-list "
        "entry outliving its route is a hole waiting for the next thing mounted "
        f"there: {stale}"
    )


def test_handler_verified_has_no_stale_entries():
    live = {(m, r.path) for r in _api_routes() for m in (r.methods or set())}
    stale = sorted(k for k in HANDLER_VERIFIED if k not in live)
    assert not stale, f"HANDLER_VERIFIED names routes that no longer exist: {stale}"


def test_every_public_api_path_carries_a_written_reason():
    """The rule that makes HANDLER_VERIFIED load-bearing rather than decorative.

    A path in PUBLIC_PATHS is one the session middleware waves through. For an
    API route that is only safe because the handler checks something else -- a
    Square HMAC, a Twilio signature, a per-camera key, a reCAPTCHA token, a
    single-use JWT in the URL. That reason belongs next to the path, not in
    someone's head.

    Exempt: the three static operator pages, which serve a file, check nothing,
    and are queued for deletion by fat decision 5.
    """
    documented = {p for _m, p in HANDLER_VERIFIED}
    undocumented = sorted(
        p for p in main.PUBLIC_PATHS
        if p not in STATIC_PAGE_PATHS and p not in documented
    )
    assert not undocumented, (
        "these paths are in main.PUBLIC_PATHS with no HANDLER_VERIFIED entry "
        "saying what the handler checks instead. Add one, with the reason you "
        f"verified: {undocumented}"
    )


def test_handler_verified_entries_are_not_already_guarded():
    """The list must shrink when a route gets a real dependency."""
    redundant = sorted(
        f"{m} {r.path}"
        for r in _api_routes()
        for m in (r.methods or set())
        if (m, r.path) in HANDLER_VERIFIED and GUARD_DEPENDENCIES & _guard_names(r)
    )
    assert not redundant, (
        "these now have a guard dependency -- drop them from HANDLER_VERIFIED: "
        f"{redundant}"
    )


# ── The proof that the walker can actually fail ──────────────────────────────

def test_the_walker_flags_an_unguarded_route():
    """Run the same predicate over a throwaway app with one naked endpoint.

    Without this, a walker with a bug in `_guard_names` would pass everything
    forever and nobody would know. This is the test for the test.
    """
    from services.auth import require_subject

    probe = FastAPI()

    @probe.post("/danger/unguarded")
    async def _unguarded():           # noqa: ANN202 - fixture endpoint
        return {}

    @probe.post("/safe/guarded")
    async def _guarded(subject=Depends(require_subject)):   # noqa: ANN202
        return {}

    routes = [r for r in probe.routes if isinstance(r, APIRoute)]
    naked = [r for r in routes if not (GUARD_DEPENDENCIES & _guard_names(r))]
    assert [r.path for r in naked] == ["/danger/unguarded"]


@pytest.mark.parametrize("path", sorted(main.PUBLIC_PATHS))
def test_no_admin_or_ops_path_is_public(path):
    """A heartbeat endpoint an anonymous caller can write is a dead-man anyone
    can silence; an admin endpoint an anonymous caller can reach is worse."""
    assert not path.startswith(("/admin", "/ops", "/quickbooks/pending-invoices"))
```

- [ ] **Step 2: One comment in `main.py`**

Above `PUBLIC_PATHS`, add:

```python
# Adding a path here is the ONLY way to make a route public. tests/test_route_guards.py
# walks main.app.routes and fails the build on any endpoint that has neither a
# guard dependency nor an entry here (or, for a route that checks its own
# credential in the handler, an entry in that file's HANDLER_VERIFIED with a
# written reason). Do not delete that test to make a branch green.
```

No code change in `main.py`. If `_is_public_path` needs to become public API for the test, it does not — a leading underscore is a convention, not a barrier, and the test imports it deliberately.

- [ ] **Step 3: Run, and expect real hits**

```bash
cd /Users/gabe/lotlogic-backend-tenancy
pytest tests/test_route_guards.py -q
```

`main.PUBLIC_PATHS` has **19** entries today: three static operator pages (exempt) and **16** API paths. `HANDLER_VERIFIED` above has **17** entries covering exactly those 16 — `/violations/action` appears twice because its GET and POST check the same token for different reasons — so `test_every_public_api_path_carries_a_written_reason` should pass on the first run. If it does not, a path was added to PUBLIC_PATHS without anyone writing down why it is safe; that is the finding.

`test_every_route_is_guarded_or_explicitly_public` is the one that will name routes. For each one, in order of preference:
1. it should have a guard → **add the dependency** (this is a real finding; fix it in this commit and say so);
2. it is genuinely public → add it to `main.PUBLIC_PATHS`;
3. it verifies its own credential → add it to `HANDLER_VERIFIED` **with the reason you verified**.

Never take option 2 or 3 without reading the handler. Record in the commit body every route that took option 1 — those are the bugs this task found.

- [ ] **Step 4: Full gate**

```bash
ruff check . && python -m compileall -q -f . && pytest -x --tb=short -q
```

- [ ] **Step 5: Commit**

```
test(guards): walk every route and fail the build on an unguarded endpoint

An endpoint now has exactly three lawful states: a guard dependency, an entry
in main.PUBLIC_PATHS, or an entry in HANDLER_VERIFIED with a written reason for
the credential it checks itself. Anything else fails CI.

Two more rules keep the allow-lists honest: a PUBLIC_PATHS entry whose route no
longer exists fails (an allow-list outliving its route is a hole waiting for
whatever is mounted there next), and a HANDLER_VERIFIED entry that has since
gained a real dependency fails so the list shrinks.

This is what permanently retires the class of bug behind BACKEND-2/SEC-1 and
SEC-5/PLATFORM-6 -- both were "somebody added a route and nobody noticed what
it did not check".
```

---

### Task 6: Migration + `services/audit.py` — `admin_audit_log` (SEC-8)

**Files:**
- Create: `migrations/20260914140200_admin_audit_log.sql`
- Create: `services/audit.py`
- Modify: `models.py` (`AdminAuditLog`)
- Test: `tests/plaza/test_admin_audit_log.py`

**Interfaces:**
- Consumes: an open `AsyncSession`, a `Subject`, the request id from `services/observability.get_request_id()` when available.
- Produces, for Tasks 7, 11, 13 and `routers/admin.py`:
  - `await audit.record(db, subject, action, *, property_id=None, organization_id=None, target_table=None, target_id=None, gross_fee_cents=None, lotlogic_revenue_cents=None, partner_payout_cents=None, detail=None) -> None`
  - `audit.Action` — the string constants, so a typo is an import error rather than an unqueryable row.

- [ ] **Step 1: The migration**

`migrations/20260914140200_admin_audit_log.sql`:

```sql
-- SEC-8 -- the tow audit record, written by the server, inside the transaction
-- that does the thing.
--
-- What it replaces: frontend/src/lib/db.js:370 inserted an audit row from the
-- BROWSER into `action_logs` -- a table that, verified 2026-09-14,
-- to_regclass('public.action_logs') says DOES NOT EXIST. Every insert failed,
-- every failure was swallowed by a console.warn, and every tow audit record
-- ever "written" was discarded. The same browser code computed gross_revenue
-- and our_revenue from client-held fee values and wrote them to `violations`
-- through PostgREST, bypassing the backend entirely.
--
-- This table is append-only by intent: no UPDATE path exists in the code and
-- nothing here ever deletes a row. Retention is Wave 2.5's decision (SEC-11 /
-- DB-5) -- it is named there rather than guessed here.
--
-- MONEY IS IN CENTS -- and so, despite their names, are
-- violations.gross_revenue / our_revenue (models.ViolationUpdate says "# in
-- cents"; /violations/revenue returns gross_revenue_cents=gross and
-- gross_revenue_dollars=round(gross/100, 2)). So the audit row's *_cents
-- columns are a STRAIGHT COPY of those values. There is no x100 and no //100
-- anywhere in this plan; a conversion here would re-create DB-7, the finding
-- that reported a $350 tow as $3.50. Renaming those two columns is the half of
-- DB-7 still open and is not this plan's job.

BEGIN;

CREATE TABLE IF NOT EXISTS public.admin_audit_log (
    id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    occurred_at             timestamptz NOT NULL DEFAULT now(),
    -- WHO. actor_user_id is the Wave 2.2 users row; actor_account_id is the
    -- legacy lot_owners / enforcement_partners id, kept because that is what a
    -- pre-2.2 token carries and what the fee schedule is keyed on. A service
    -- key has neither and is recorded as actor_type='service'.
    actor_type              text NOT NULL,
    actor_user_id           uuid REFERENCES public.users(id) ON DELETE SET NULL,
    actor_account_id        uuid,
    actor_email             text,
    organization_id         uuid REFERENCES public.organizations(id) ON DELETE SET NULL,
    -- WHAT
    action                  text NOT NULL,
    property_id             uuid REFERENCES public.properties(id) ON DELETE SET NULL,
    target_table            text,
    target_id               text,
    -- HOW MUCH, as the server computed it -- not as a browser asserted it.
    gross_fee_cents         integer,
    lotlogic_revenue_cents  integer,
    partner_payout_cents    integer,
    -- Anything else, as a small object. Never a full row dump.
    detail                  jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- Ties the row to the request-id middleware's log lines (Wave 1 item 17).
    request_id              text,
    -- Four values, all reachable (see services/audit.py::_actor_type):
    --   'service' -- the shared X-API-Key, or a path with no session subject
    --   'user'    -- a Wave 2.2 login (subject.user_id is set)
    --   'owner' / 'partner' -- a legacy login still on the pre-2.2 path
    -- The mix across these four IS the rollout's progress meter. 'system' was
    -- on this list in an earlier draft and no code path could produce it --
    -- Subject.type is Literal["owner","partner","service"] -- so it is gone.
    CONSTRAINT admin_audit_log_actor_type_check
        CHECK (actor_type IN ('user', 'owner', 'partner', 'service')),
    CONSTRAINT admin_audit_log_action_not_blank CHECK (btrim(action) <> '')
);

CREATE INDEX IF NOT EXISTS admin_audit_log_occurred_at_idx
    ON public.admin_audit_log (occurred_at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_log_property_idx
    ON public.admin_audit_log (property_id, occurred_at DESC)
    WHERE property_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS admin_audit_log_action_idx
    ON public.admin_audit_log (action, occurred_at DESC);

ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.admin_audit_log FROM anon, authenticated;
-- Explicitly: the browser must never be able to write this table. That is the
-- entire finding.

COMMIT;
```

- [ ] **Step 2: `services/audit.py`**

```python
"""services/audit.py — one append-only record of who did what, written by us.

The rule this module exists to enforce: **an audit row is appended to the
caller's open transaction and is never committed by this module.** It therefore
cannot be dropped independently of the thing it records -- if the tow rolls
back, so does its audit row, and if the tow commits, so does its audit row.
That is the half of SEC-8 that a table alone does not fix.

Two things this module will not do:

  * open its own session. A second session means a second transaction means the
    exact failure mode the finding describes, just moved to the server.
  * raise. An audit write that fails must not roll back a tow that succeeded...
    except that it CANNOT fail independently, because it is in the same
    transaction. So it does not catch, either: a failure here is a failure of
    the whole operation, which is correct and is what makes the record trustworthy.
"""
from __future__ import annotations

import json
import uuid
from typing import Optional

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from services.auth import Subject


class Action:
    """Action names. Constants, so a typo is an ImportError, not a row nobody
    can find again."""
    VIOLATION_RESOLVED = "violation.resolved"
    VIOLATION_ACTION_EMAIL = "violation.action_via_email"
    PASS_CANCELLED = "pass.cancelled"
    PARTNER_FEES_UPDATED = "partner.fees_updated"
    SITE_ONBOARDED = "site.onboarded"
    SITE_POLICY_IMAGE_UPLOADED = "site.policy_image_uploaded"
    LOGIN_CREATED = "login.created"
    QUICKBOOKS_CONNECTED = "quickbooks.connected"


_INSERT = """
INSERT INTO public.admin_audit_log
    (actor_type, actor_user_id, actor_account_id, actor_email, organization_id,
     action, property_id, target_table, target_id,
     gross_fee_cents, lotlogic_revenue_cents, partner_payout_cents,
     detail, request_id)
VALUES
    (:actor_type, CAST(:actor_user_id AS uuid), CAST(:actor_account_id AS uuid),
     :actor_email, CAST(:organization_id AS uuid),
     :action, CAST(:property_id AS uuid), :target_table, :target_id,
     :gross_fee_cents, :lotlogic_revenue_cents, :partner_payout_cents,
     CAST(:detail AS jsonb), :request_id)
"""


def _actor_type(subject: Subject) -> str:
    """Which of the four actor shapes this is.

    `subject.type` alone is not enough: it is Literal["owner","partner","service"],
    so copying it would make 'user' unreachable and leave a Wave 2.2 staff login
    indistinguishable from the legacy owner account it shares an RLS identity
    with -- which is the one distinction an audit trail has to make.
    """
    if subject.is_service:
        return "service"
    if subject.user_id is not None:
        return "user"
    return subject.type


def _request_id() -> Optional[str]:
    # Soft dependency: services/observability.py is Wave 1 item 17 and is
    # present, but a unit test may import this module without an active request.
    try:
        from services.observability import get_request_id
        return get_request_id()
    except Exception:       # noqa: BLE001 - an audit row without a request id
        return None         # is worth far more than an exception here.


async def record(
    db: AsyncSession,
    subject: Subject,
    action: str,
    *,
    property_id: Optional[uuid.UUID] = None,
    organization_id: Optional[uuid.UUID] = None,
    target_table: Optional[str] = None,
    target_id: Optional[str] = None,
    gross_fee_cents: Optional[int] = None,
    lotlogic_revenue_cents: Optional[int] = None,
    partner_payout_cents: Optional[int] = None,
    detail: Optional[dict] = None,
) -> None:
    """Append one audit row to `db`'s OPEN transaction. Does not commit."""
    await db.execute(text(_INSERT), {
        "actor_type": _actor_type(subject),
        "actor_user_id": str(subject.user_id) if subject.user_id else None,
        "actor_account_id": str(subject.id) if subject.id else None,
        "actor_email": subject.email,
        "organization_id": str(organization_id) if organization_id else None,
        "action": action,
        "property_id": str(property_id) if property_id else None,
        "target_table": target_table,
        "target_id": str(target_id) if target_id is not None else None,
        "gross_fee_cents": gross_fee_cents,
        "lotlogic_revenue_cents": lotlogic_revenue_cents,
        "partner_payout_cents": partner_payout_cents,
        "detail": json.dumps(detail or {}),
        "request_id": _request_id(),
    })
```

Add the matching `AdminAuditLog` declarative class to `models.py` for read paths (`id` as `BigInteger`, `Identity()`; everything else nullable except `actor_type` and `action`).

- [ ] **Step 3: The test**

`tests/plaza/test_admin_audit_log.py`:

```python
"""The audit row lives or dies with the thing it records.

The old shape: the BROWSER inserted into `action_logs`, a table that does not
exist, and swallowed the error. The new shape must make the opposite guarantee
-- so the load-bearing test here is the ROLLBACK one.
"""
import uuid

import pytest
from sqlalchemy import text

from services import audit
from services.auth import Subject

SUBJECT = Subject(type="owner", id=uuid.UUID("aaaa0000-0000-0000-0000-00000000000a"),
                  email="ops@example.test")


async def _rows(db_conn):
    return (await db_conn.execute(text(
        "SELECT action, gross_fee_cents, actor_email, detail FROM public.admin_audit_log "
        "ORDER BY id"))).all()


async def test_record_appends_a_row_without_committing(db_conn):
    await audit.record(db_conn, SUBJECT, audit.Action.VIOLATION_RESOLVED,
                       gross_fee_cents=35000, lotlogic_revenue_cents=10000,
                       partner_payout_cents=25000, target_table="violations",
                       target_id="v-1")
    assert len(await _rows(db_conn)) == 1
    await db_conn.rollback()
    assert await _rows(db_conn) == [], (
        "the audit row must roll back with its transaction -- if it survives a "
        "rollback it is recording things that did not happen"
    )


async def test_record_survives_the_commit_it_rode_in_on(db_conn):
    await audit.record(db_conn, SUBJECT, audit.Action.PASS_CANCELLED, target_id="p-1")
    await db_conn.commit()
    rows = await _rows(db_conn)
    assert len(rows) == 1 and rows[0][0] == "pass.cancelled"


async def test_money_is_recorded_in_cents(db_conn):
    await audit.record(db_conn, SUBJECT, audit.Action.VIOLATION_RESOLVED,
                       gross_fee_cents=35000)
    await db_conn.commit()
    assert (await _rows(db_conn))[0][1] == 35000


async def test_the_four_actor_types_are_all_reachable(db_conn):
    """D15. 'user' must be distinguishable from the legacy owner account it
    shares an RLS identity with -- that distinction is the point of the table."""
    import uuid as _uuid
    await audit.record(db_conn, Subject(type="service", id=None),
                       audit.Action.SITE_ONBOARDED)
    await audit.record(db_conn, SUBJECT, audit.Action.PASS_CANCELLED)
    await audit.record(db_conn, Subject(type="partner", id=_uuid.uuid4(),
                                        email="p@example.test"),
                       audit.Action.PASS_CANCELLED)
    await audit.record(db_conn, Subject(type="owner", id=SUBJECT.id,
                                        email="staff@example.test",
                                        user_id=_uuid.uuid4()),
                       audit.Action.PASS_CANCELLED)
    await db_conn.commit()
    seen = (await db_conn.execute(text(
        "SELECT actor_type FROM public.admin_audit_log ORDER BY id"))).scalars().all()
    assert seen == ["service", "owner", "partner", "user"]


async def test_an_unknown_action_string_is_rejected_only_if_blank(db_conn):
    # The CHECK is deliberately loose on vocabulary (new actions must not need a
    # migration) and strict on blankness (an unnamed action is unqueryable).
    with pytest.raises(Exception):
        await audit.record(db_conn, SUBJECT, "   ")


async def test_the_table_is_unreachable_from_a_browser_key(db_conn):
    leaked = (await db_conn.execute(text("""
        SELECT grantee, privilege_type FROM information_schema.role_table_grants
         WHERE table_schema='public' AND table_name='admin_audit_log'
           AND grantee IN ('anon','authenticated')
    """))).all()
    assert leaked == []
```

- [ ] **Step 4: Run and commit**

```bash
cd /Users/gabe/lotlogic-backend-tenancy
ruff check . && python -m compileall -q -f . && pytest -x --tb=short -q
```

```
feat(audit): admin_audit_log, written by the server inside the transaction

SEC-8, and it was worse than the finding's wording: the browser inserted the
tow audit record into `action_logs`, a table that does not exist in production
(to_regclass is NULL), and swallowed the failure in a console.warn. Every tow
audit record ever "written" was discarded.

services/audit.record appends to the CALLER'S open transaction and never
commits, so an audit row cannot be lost independently of the thing it records.
The test that matters is the rollback one.

Task 7 puts the write sites in and takes the browser out of the loop.
```

---

### Task 7: Server-side fee and audit on every money action; the browser stops writing both

**Files (backend):**
- Modify: `routers/violations.py` — `resolve_violation`, `violation_action` (the email POST)
- Modify: `routers/visitor_passes.py`, `routers/resident_plates.py` — cancel paths write an audit row
- Modify: `routers/lots.py` — `update_partner` writes an audit row
- Test: `tests/plaza/test_violation_resolve_audit.py`

**Files (frontend):**
- Modify: `frontend/src/lib/db.js` — `recordAction` posts to the backend; the fee math and the `action_logs` insert are deleted
- Test: `tests/e2e/…` — the existing `partner-fee-editor.spec.ts` must stay green

**Interfaces:**
- Consumes: `services/audit.py` (Task 6); the existing `POST /violations/{violation_id}/resolve`.
- Produces: `resolve_violation` now derives `gross_revenue` from the partner's fee schedule when the client omits it, and writes one `admin_audit_log` row per action.

- [ ] **Step 1: Derive the fee server-side in `routers/violations.py::resolve_violation`, in cents**

**Read `POST /violations/{violation_id}/action` (violations.py:493–515) first and copy it.** That endpoint already does this correctly and its comment already explains the trap:

```python
                # Fall back to the partner's default fee schedule. Both sides
                # of this assignment are cents — the fee columns used to hold
                # whole dollars, which is why a $350 tow was reported as $3.50
                # (DB-7); see 20260903131539_partner_fees_to_cents.sql.
                v.gross_revenue = (
                    partner.boot_fee_cents if body.action == "boot" else partner.tow_fee_cents
                )
            v.our_revenue = int(v.gross_revenue * float(partner.revenue_share))
```

`violations.gross_revenue` and `our_revenue` **hold cents** (`models.ViolationUpdate.gross_revenue  # in cents`; `/violations/revenue` returns `gross_revenue_cents=gross` alongside `gross_revenue_dollars=round(gross / 100, 2)`). So the assignment is a straight copy of the fee column. **There is no `× 100` and no `// 100` in this task, anywhere.** A conversion here would re-create the exact 100× error DB-7 exists to have fixed.

`resolve_violation` takes `update.gross_revenue` from the client and multiplies it by the partner's share. Keep accepting it (the field is in `ViolationUpdate`; removing it is a breaking API change and the deployed dashboard still sends it), but stop *needing* it:

```python
    if update.action_taken in ("boot", "tow") or update.gross_revenue is not None:
        partner = (await db.execute(
            select(EnforcementPartner).where(EnforcementPartner.id == v.partner_id)
        )).scalar_one_or_none()
        if partner:
            # The fee schedule is the server's, not the browser's (SEC-8: the
            # dashboard computed this from values it held in React state and
            # wrote the result straight to `violations` through PostgREST).
            # EVERY value in this block is cents — client-supplied, fee column
            # and stored column alike. Do not convert. Same shape as
            # record_violation_action above; keep them identical so one tow
            # cannot book two different numbers depending on which route the
            # dashboard happened to call.
            if update.gross_revenue is not None:
                v.gross_revenue = int(update.gross_revenue)
            else:
                v.gross_revenue = (
                    partner.boot_fee_cents if update.action_taken == "boot"
                    else partner.tow_fee_cents
                )
            # int(), not round(): violations.py:512 and :766 both truncate, and
            # a third rounding rule would make two call sites disagree about
            # the same tow. See scope call 13.
            v.our_revenue = int(v.gross_revenue * float(partner.revenue_share))
```

Then, before the existing `await db.commit()` — again with no conversion:

```python
    gross_cents = v.gross_revenue
    ours_cents = v.our_revenue
    await audit.record(
        db, subject, audit.Action.VIOLATION_RESOLVED,
        target_table="violations", target_id=str(violation_id),
        gross_fee_cents=gross_cents,
        lotlogic_revenue_cents=ours_cents,
        partner_payout_cents=(gross_cents - ours_cents)
                             if gross_cents is not None and ours_cents is not None else None,
        detail={"action_taken": v.action_taken, "status": v.status,
                "marked_by": v.marked_by},
    )
```

Do the same in the email-action POST (`violation_action`), with `audit.Action.VIOLATION_ACTION_EMAIL` and `detail={"action": body.action, "via": "email_token"}`. That path has no session subject — and do **not** invent one: `SubjectType` is `Literal["owner","partner","service"]`. Pass `Subject(type="service", id=None, email=None)`; `_actor_type` records `'service'` and `detail["via"]` says which service path it was. Do not widen `SubjectType` for this.

- [ ] **Step 2: Keep the zone re-arm, server-side**

`db.recordAction` does one more thing the backend does not, and it is the thing that makes enforcement keep working (`frontend/src/lib/db.js:309–329`): on a **non-revenue** outcome it reads the violation's `camera_id` + `zone_id`, nulls `violations.zone_id`, and resets `zone_occupancy.violation_triggered = false` for that `(camera_id, zone_id)` — so the dedup layer can fire a fresh violation for the same space next scan. Move it verbatim into `resolve_violation`, before the commit:

```python
    # Zone re-arm. Moved from frontend/src/lib/db.js:309-329 with Wave 2.2 --
    # it is the reason a dismissed violation does not permanently deafen the
    # dedup layer for that space. Only on outcomes that earn no revenue: a
    # booted or towed vehicle is still there, and re-arming would file a
    # duplicate against it.
    if update.action_taken in ("dismissed", "no_action", "already_gone"):
        pre_camera_id, pre_zone_id = v.camera_id, v.zone_id
        v.zone_id = None
        if pre_camera_id and pre_zone_id:
            await db.execute(text("""
                UPDATE public.zone_occupancy
                   SET violation_triggered = false
                 WHERE camera_id = CAST(:cid AS uuid) AND zone_id = :zid
            """), {"cid": str(pre_camera_id), "zid": pre_zone_id})
```

Capture `camera_id` / `zone_id` **before** nulling, exactly as the browser does — the browser's `SELECT camera_id, zone_id ... .single()` ahead of the update exists for that reason and its comment says so.

**`record_violation_action` (`POST /violations/{id}/action`) has the same gap.** Add the identical block there in the same commit, or the two routes disagree about whether a dismissal re-arms the zone — which is how four ownership helpers happened.

- [ ] **Step 3: Audit the other three write sites**

- `routers/visitor_passes.py::cancel_pass` → `audit.Action.PASS_CANCELLED`, `property_id=row["property_id"]`, `target_table="visitor_passes"`, `detail={"reason": payload.reason}`.
- `routers/resident_plates.py::cancel_resident_plate` → same action, `target_table="resident_plates"`.
- `routers/lots.py::update_partner` → `audit.Action.PARTNER_FEES_UPDATED`, `target_table="enforcement_partners"`, `detail={"fields": sorted(changed_fields)}`. **This is the SEC-5/PLATFORM-6 surface** — the fee edit that used to be able to zero out LotLogic's revenue now leaves a row naming who changed which fields.

All of these calls go **before** the existing `await db.commit()` in their handler. None adds a commit.

- [ ] **Step 4: Take the browser out of the loop (`frontend/src/lib/db.js`)**

`recordAction` currently does four things: computes `gross_revenue` / `our_revenue` / `partner_payout` from `extra._partner` and `extra._ownerFees` **in dollars** (`p.tow_fee || 250`) and writes them into columns that hold **cents** — that is the live half of DB-7 — `UPDATE`s `violations` through Supabase, re-arms the zone (lines 309–329, now moved server-side by Step 2), and inserts into the nonexistent `action_logs` (line 370). Replace the whole branch with one backend call:

```js
  async recordAction(violId, action, extra = {}) {
    if (action === 'plate_correction') {
      // Not money and not an enforcement decision: leave it on the direct path.
      if (!supabase) throw new Error('Data service unavailable');
      const { error } = await supabase.from('violations')
        .update({ plate_text: extra.plate_text }).eq('id', violId);
      if (error) throw new Error(error.message || 'Plate update failed');
      return { success: true };
    }
    // Everything else goes through the backend. The fee schedule and the audit
    // row are the server's -- the browser used to compute both, and the audit
    // half went into a table that does not exist.
    await apiFetch(`/violations/${violId}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        status: 'resolved',
        action_taken: action,
        notes: extra.notes || undefined,
      }),
    });
    return { success: true };
  },
```

Delete: the `action_logs` insert (line 370) and its `logEntry` object; the `grossFee` / `share` arithmetic; the `_vPre` pre-fetch and the `zone_occupancy` reset at lines 309–329 (Step 2 owns them now); and the now-unused `extra._partner` / `extra._ownerFees` / `extra._performerEmail` plumbing at the three `JobsPage.jsx` call sites (169, 198, 328).

**Leave `db.deleteViolation`'s own zone reset (lines 579–588) alone.** It is a different path with a different lifecycle and this task does not touch it.

**Naming rule:** no user-facing string changes in this task. `npm run check:naming` must pass unchanged.

- [ ] **Step 5: Tests**

`tests/plaza/test_violation_resolve_audit.py` — against real Postgres, with a partner whose `tow_fee_cents` is **35000** and `revenue_share` **0.25**. Every number below is cents:

1. `POST /violations/{id}/resolve` with `action_taken="tow"` and **no** `gross_revenue` writes `gross_revenue = 35000` and `our_revenue = 8750`, read straight off the partner row. *A `350` here is DB-7 reborn and the test exists to say so.*
2. The same call writes exactly one `admin_audit_log` row with `action='violation.resolved'`, `gross_fee_cents=35000`, `lotlogic_revenue_cents=8750`, `partner_payout_cents=26250`, and `actor_email` equal to the caller's.
3. The numbers from `POST /violations/{id}/resolve` and `POST /violations/{id}/action` are **identical** for the same violation and the same partner — resolve one violation each way and assert `(gross_revenue, our_revenue)` matches. Two routes, one tow, one answer.
4. A client that *does* send `gross_revenue` still wins, in cents (send `40000`, expect `40000` / `10000`) — backward compatibility, because the dashboard on `main` sends it until this task's frontend half deploys.
5. **Zone re-arm (D8).** Given a violation with `camera_id` and `zone_id` set and a `zone_occupancy` row with `violation_triggered = true`: resolving it `dismissed` nulls `violations.zone_id` and flips that row back to `false`. Resolving it `tow` does **neither** — the vehicle is still there and re-arming would file a duplicate against it. *Without this test the dedup layer stays permanently deaf for that space and nothing fails.*
6. A resolve that fails its invoiced-at guard (409) writes **no** audit row and leaves `zone_occupancy` untouched — the row, the mutation and the re-arm share a transaction.
7. A cross-tenant caller gets 404 and writes no audit row.

Fixtures follow the plan's rule: this file creates its own `properties`, `violations`, `camera_zones`/`zone_occupancy` and `enforcement_partners` rows with fresh uuids and deletes them in teardown.

Frontend: `tests/e2e/partner-fee-editor.spec.ts` stays green unchanged; run the self-serving specs and `npm run visual:check`.

- [ ] **Step 6: Run both gates, commit twice (one per repo)**

```
fix(violations): the fee schedule and the audit row are the server's

SEC-8. The dashboard computed gross_revenue and our_revenue from partner fee
values it held in React state and wrote them to `violations` through PostgREST,
then inserted an audit row into `action_logs` -- a table that does not exist --
and swallowed the failure.

resolve_violation now derives the fee from enforcement_partners.{boot,tow}_fee_cents
when the client omits it (the client value still wins while the old dashboard is
deployed), in CENTS on both sides of the assignment -- violations.gross_revenue
holds cents despite its name, and the browser's `p.tow_fee || 250` dollars were
the live half of DB-7. It writes one admin_audit_log row in the same transaction,
and it now performs the zone re-arm the browser used to do: on a dismissal the
violation's zone_id is cleared and zone_occupancy.violation_triggered is reset,
so the dedup layer can fire again for that space. Without moving that, deleting
the browser code would have left every dismissed space permanently deaf.

The partner fee editor -- the SEC-5 surface -- now leaves a row naming who
changed which fields.
```

---

### Task 8: SEC-4 — login throttle and lockout

**Files:**
- Create: `migrations/20260914140300_auth_login_attempts.sql`
- Create: `services/login_throttle.py`
- Modify: `config.py` (three fields), `routers/auth.py` (`login`, `request_password_reset`)
- Test: `tests/plaza/test_login_throttle_db.py`, `tests/test_login_throttle.py`

**Interfaces:**
- Produces: `await login_throttle.check(db, email) -> int | None` (minutes remaining, or `None` when allowed); `await login_throttle.record_failure(db, email)`; `await login_throttle.record_success(db, email)`.

**Why a table and not a dict:** Wave 2.7 established that a second Railway replica must be safe. An in-process counter is per-replica, which silently multiplies the limit by the replica count. This is a counter, not a lock — see the fail-open rule below.

- [ ] **Step 1: The migration**

```sql
-- SEC-4 -- no rate limit or lockout on the dashboard login.
--
-- One row per login identity, not per attempt: a row-per-attempt table on a
-- public endpoint is an unbounded write amplifier an anonymous caller controls.
-- The key is lower(email) and a row is created for an email that does not
-- exist, so the limiter cannot be used to enumerate accounts -- it answers the
-- same way for a real address and a made-up one.
--
-- NOT a security boundary on its own: routers/auth.py already does a dummy
-- bcrypt compare for unknown emails and returns an identical 401. This raises
-- the cost of a credential-stuffing run; it does not replace that.

BEGIN;

CREATE TABLE IF NOT EXISTS public.auth_login_attempts (
    email_key        text PRIMARY KEY,
    failed_count     integer NOT NULL DEFAULT 0,
    first_failure_at timestamptz,
    last_failure_at  timestamptz,
    locked_until     timestamptz,
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT auth_login_attempts_email_key_is_lowercase
        CHECK (email_key = lower(email_key))
);

CREATE INDEX IF NOT EXISTS auth_login_attempts_locked_until_idx
    ON public.auth_login_attempts (locked_until) WHERE locked_until IS NOT NULL;

ALTER TABLE public.auth_login_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.auth_login_attempts FROM anon, authenticated;

COMMIT;
```

- [ ] **Step 2: `config.py`**

After `password_reset_ttl_hours`:

```python
    # SEC-4. Ten attempts inside the window, then a lockout. Tuned for a real
    # human on a phone in a parking lot who has forgotten which of two passwords
    # this is -- not for a bank. Set LOGIN_MAX_ATTEMPTS=0 to disable entirely
    # (the limiter then never locks, and is still recorded).
    login_max_attempts: int = 10
    login_attempt_window_minutes: int = 15
    login_lockout_minutes: int = 15
```

- [ ] **Step 3: `services/login_throttle.py`**

```python
"""services/login_throttle.py — SEC-4.

Fails OPEN. A database hiccup must degrade to "let the sign-in attempt through
and log it", never to "nobody can sign in". The limiter raises the cost of a
credential-stuffing run; it is not the thing standing between an attacker and
an account -- bcrypt is.

One row per lower(email), created whether or not the address exists, so the
limiter's behaviour cannot be used to enumerate accounts.
"""
from __future__ import annotations

import logging
from typing import Optional

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import get_settings

log = logging.getLogger(__name__)


def _key(email: str) -> str:
    return (email or "").strip().lower()


async def check(db: AsyncSession, email: str) -> Optional[int]:
    """Minutes remaining on a lockout, or None if the attempt may proceed."""
    settings = get_settings()
    if settings.login_max_attempts <= 0:
        return None
    try:
        row = (await db.execute(text("""
            SELECT GREATEST(0, CEIL(EXTRACT(EPOCH FROM (locked_until - now())) / 60.0))::int
              FROM public.auth_login_attempts
             WHERE email_key = :k AND locked_until IS NOT NULL AND locked_until > now()
        """), {"k": _key(email)})).scalar()
    except Exception as e:  # noqa: BLE001 - fail open, on purpose
        log.warning("login throttle check failed, allowing attempt: %s", e)
        return None
    return int(row) if row else None


async def record_failure(db: AsyncSession, email: str) -> None:
    """Count one failure and lock when the count crosses the threshold.

    The window resets the counter rather than sliding it: ten failures inside
    fifteen minutes locks; ten failures spread over two hours does not.
    """
    settings = get_settings()
    try:
        await db.execute(text("""
            INSERT INTO public.auth_login_attempts
                (email_key, failed_count, first_failure_at, last_failure_at, updated_at)
            VALUES (:k, 1, now(), now(), now())
            ON CONFLICT (email_key) DO UPDATE SET
                failed_count = CASE
                    WHEN public.auth_login_attempts.first_failure_at
                         < now() - make_interval(mins => :window) THEN 1
                    ELSE public.auth_login_attempts.failed_count + 1 END,
                first_failure_at = CASE
                    WHEN public.auth_login_attempts.first_failure_at
                         < now() - make_interval(mins => :window) THEN now()
                    ELSE public.auth_login_attempts.first_failure_at END,
                last_failure_at = now(),
                locked_until = CASE
                    WHEN (CASE
                            WHEN public.auth_login_attempts.first_failure_at
                                 < now() - make_interval(mins => :window) THEN 1
                            ELSE public.auth_login_attempts.failed_count + 1 END) >= :maxf
                    THEN now() + make_interval(mins => :lock)
                    ELSE public.auth_login_attempts.locked_until END,
                updated_at = now()
        """), {"k": _key(email), "window": settings.login_attempt_window_minutes,
               "maxf": settings.login_max_attempts,
               "lock": settings.login_lockout_minutes})
        await db.commit()
    except Exception as e:  # noqa: BLE001
        log.warning("login throttle record_failure failed: %s", e)
        await db.rollback()


async def record_success(db: AsyncSession, email: str) -> None:
    try:
        await db.execute(text("""
            UPDATE public.auth_login_attempts
               SET failed_count = 0, first_failure_at = NULL,
                   locked_until = NULL, updated_at = now()
             WHERE email_key = :k
        """), {"k": _key(email)})
    except Exception as e:  # noqa: BLE001
        log.warning("login throttle record_success failed: %s", e)
```

`record_success` deliberately does **not** commit — it rides the `await db.commit()` that `login` already does for `last_login_at`.

- [ ] **Step 4: Wire it into `routers/auth.py::login`**

At the top of the handler, before `_find_account_by_email`:

```python
    locked_for = await login_throttle.check(db, req.email)
    if locked_for is not None:
        # 429, not 401: this is about pace, not credentials, and the limiter
        # answers identically for an address that does not exist -- so it
        # cannot be used to enumerate accounts.
        raise HTTPException(
            status_code=429,
            detail=f"Too many sign-in attempts. Try again in {locked_for} minute(s).",
        )
```

and on both 401 paths (`found is None` and the failed `verify_password`), call `await login_throttle.record_failure(db, req.email)` **before** raising. On success, `await login_throttle.record_success(db, req.email)` before the existing commit.

Apply the same `check` (without `record_failure`) to `POST /auth/request-password` — an unthrottled reset-token generator is a free email cannon.

- [ ] **Step 5: Tests**

`tests/plaza/test_login_throttle_db.py` (real Postgres):
1. Nine failures leave `check` returning `None`.
2. The tenth sets `locked_until`, and `check` returns a positive minute count.
3. A successful login clears the counter and the lock.
4. A failure whose `first_failure_at` is outside the window resets the count to 1 rather than incrementing (set `first_failure_at` back by hand and assert).
5. An email that does not exist gets a row, and the lockout response is byte-identical to the one a real address gets.

`tests/test_login_throttle.py` (router-level, `httpx.ASGITransport`):
6. Eleven `POST /auth/login` calls with a bad password return `401 × 10` then `429`.
7. `LOGIN_MAX_ATTEMPTS=0` disables the lock entirely (eleventh call is still 401).
8. **Fail-open:** monkeypatch `login_throttle.check` to raise; the login still answers 401/200, never 500.

- [ ] **Step 6: Run and commit**

```
feat(auth): rate-limit and lock out repeated failed sign-ins (SEC-4)

A table, not a process dict: Wave 2.7 made a second Railway replica safe, and
an in-process counter silently multiplies the limit by the replica count.

Fails open by design -- a database hiccup degrades to "allow and log", never to
"nobody can sign in". The key is lower(email) and a row is created for an
address that does not exist, so the limiter answers identically either way and
cannot be used to enumerate accounts. bcrypt plus the existing dummy-hash
compare remain the actual boundary; this raises the cost of stuffing.
```

---

### Task 9: Login resolves `users`; the JWT and `/auth/me` carry org, role and features

**Files:**
- Modify: `services/auth.py` (`issue_token` gains three additive claims)
- Modify: `routers/auth.py` (`_find_account_by_email` gains a `users` pass; `login`; `/auth/me`; `set_password`; `request_password_reset`)
- Test: `tests/plaza/test_login_tenancy.py`, `tests/test_auth_me_shape.py`

**Interfaces:**
- Consumes: Task 2's backfilled rows; `services/tenancy.user_organizations`.
- Produces:
  - JWT claims gain `user_id`, `org_ids` (list), `role` (the role in the default org). `owner_id` / `partner_id` / `role: "authenticated"` / `account_type` / `is_platform_admin` are **unchanged**.
  - `GET /auth/me` gains `organization: {id, name, kind, role}` and `features: {partner_app: bool}`. Every existing key is unchanged.

**This is the backward-compatibility hinge of the whole plan.** Read the ordering rule in Step 2 before writing a line.

- [ ] **Step 1: `issue_token` gains three claims, changes none**

In `services/auth.py::issue_token`, add keyword-only parameters and append to `claims`:

```python
def issue_token(
    role: Literal["owner", "partner"],
    account_id: uuid.UUID,
    email: str,
    *,
    is_platform_admin: bool = False,
    user_id: Optional[uuid.UUID] = None,
    org_ids: Optional[list[uuid.UUID]] = None,
    org_role: Optional[str] = None,
) -> str:
```

```python
    # Wave 2.2, additive. `owner_id` / `partner_id` above are untouched -- they
    # are what public.current_owner_id() / current_partner_id() read, and every
    # RLS policy in production resolves through them. A login created after this
    # wave has no legacy account row of its own, so `account_id` above is THE
    # ORGANISATION'S legacy id, not the user's: that is what makes a brand-new
    # staff login satisfy properties_authenticated_select with no policy change.
    if user_id is not None:
        claims["user_id"] = str(user_id)
    if org_ids:
        claims["org_ids"] = [str(o) for o in org_ids]
    if org_role:
        claims["org_role"] = org_role
```

Note the claim is `org_role`, not `role` — `role` is already `"authenticated"` and Supabase requires it to stay that way. Task 3's `subject_from_claims` reads `org_ids`; extend it to read `org_role` into a plain attribute if a later task needs it (it does not today — `services/tenancy.py` re-reads `memberships`).

- [ ] **Step 2: Login resolution order — write this exactly**

`_find_account_by_email` keeps its existing two passes and gains a **third, first** pass over `users`. The order is:

1. **`users`** by `lower(email)`, `active`, **with a non-empty `password_hash`**. If found → the tenancy path.
2. **`lot_owners`** (unchanged).
3. **`enforcement_partners`** (unchanged).

The "with a non-empty `password_hash`" qualifier is what makes the rollout safe: the backfill copies hashes across, so an account with a password resolves at step 1 and gets the same bcrypt compare against the same hash. An account **without** one — production has exactly one, the nine-property N Style owner — falls through to step 2 and gets the existing `403 Password not set` message, unchanged.

On the tenancy path, resolve the legacy id from the *organization*:

```python
    memberships = await tenancy.user_organizations(db, user.id)
    default = next((m for m in memberships if m.organization_id == user.default_organization_id),
                   memberships[0] if memberships else None)
    if default is None:
        # A user with no membership can sign in and see nothing. That is a data
        # error, not an auth error -- say so rather than 401ing them into a loop.
        raise HTTPException(
            status_code=403,
            detail="This login is not attached to an organization yet. "
                   "Ask your LotLogic rep to finish setting it up.",
        )
    account_type = "owner" if default.kind in ("owner", "platform") else "partner"
    legacy_id = default.legacy_owner_id or default.legacy_partner_id
```

and then — the single most important line in this task:

```python
    # A login with no legacy account behind its org cannot satisfy today's RLS
    # policies, which resolve current_owner_id() / current_partner_id(). Rather
    # than issue a token that silently returns empty pages, refuse. Task 13's
    # onboarding always creates the legacy row alongside the org, so this is a
    # data-integrity guard, not a path a customer reaches.
    if legacy_id is None:
        raise HTTPException(
            status_code=403,
            detail="This organization is not fully provisioned. "
                   "Ask your LotLogic rep to finish setting it up.",
        )
    token = issue_token(
        role=account_type,
        account_id=legacy_id,            # <- the ORG's legacy id, not the user's
        email=user.email,
        is_platform_admin=user.is_platform_admin,
        user_id=user.id,
        org_ids=[m.organization_id for m in memberships],
        org_role=default.role,
    )
```

`last_login_at` is stamped on the `users` row **and**, when `legacy_id` points at one, on the legacy row too, so the admin console's existing "last seen" column keeps working.

- [ ] **Step 3: `/auth/me` gains two keys and loses none**

**`/auth/me` has no `default` in scope.** `default` is a local of `login()`; `me()` is a separate handler with two branches of its own (owner / partner) and no membership lookup at all. Resolve it once, before the branch-specific work, from the subject:

```python
    # Wave 2.2. The session's organisation, resolved HERE -- `login()`'s
    # `default` is a local of that function and is not in scope in this one.
    # `subject.user_id` is None for every legacy login and for a service key,
    # in which case there is no organisation to report and the key is null.
    org = None
    if subject.user_id is not None:
        memberships = await tenancy.user_organizations(db, subject.user_id)
        default_org_id = (await db.execute(text(
            "SELECT default_organization_id FROM public.users WHERE id = :u"
        ), {"u": str(subject.user_id)})).scalar()
        org = next((m for m in memberships if m.organization_id == default_org_id),
                   memberships[0] if memberships else None)
```

then append to the returned dict **on both branches**, identically:

```python
        # Wave 2.2. Present only when the session resolved through the tenancy
        # model; a legacy login gets `organization: None` and the dashboard
        # falls back to what it already does. Never remove a key from this
        # response -- App.jsx merges it into a persisted localStorage session.
        "organization": (
            {"id": str(org.organization_id), "name": org.name,
             "kind": org.kind, "role": org.role}
            if org is not None else None
        ),
        # FE-16. Computed from the subject's OWN properties, so site #12 turning
        # the reservation app on is an UPDATE, not a frontend deploy with a
        # customer's UUID pasted into it.
        "features": {"partner_app": partner_app_enabled},
```

where `partner_app_enabled` is one query:

```python
    prop_ids = await tenancy.allowed_property_ids(db, subject, allow_partner=True)
    if prop_ids is None:
        partner_app_enabled = True          # service key / platform admin
    elif not prop_ids:
        partner_app_enabled = False
    else:
        partner_app_enabled = bool((await db.execute(text("""
            SELECT 1 FROM public.properties
             WHERE id = ANY(CAST(:ids AS uuid[])) AND app_enabled LIMIT 1
        """), {"ids": [str(i) for i in prop_ids]})).first())
```

Verified: `app_enabled` is `false` on all 11 production rows today (Wave 1 item 13 turned the plaza's off), so `features.partner_app` is `false` for everyone at deploy time — including NMLD, whose App tab the hardcoded UUID currently shows. **That is a visible change for exactly one customer and it needs Gabe's yes** (decision D4): either flip `app_enabled = true` on the properties NMLD enforces at cutover, or accept the tab disappearing until the reservation app is finished.

- [ ] **Step 4: Password set / reset reach both tables**

`POST /auth/set-password` and `POST /auth/request-password` look the token up in `lot_owners` then `enforcement_partners`. Add `users` as a **third** lookup and, when a `users` row is updated, mirror the new `password_hash` onto the legacy row the org points at (and vice versa). Two tables holding one credential is the price of a backward-compatible rollout; it ends when Wave 3 collapses them. Write that sentence into the code as a comment so the next reader knows it is deliberate.

- [ ] **Step 5: Tests**

`tests/plaza/test_login_tenancy.py` (real Postgres, seeded exactly like the backfill leaves things):
1. A legacy owner whose `users` row exists with the same hash signs in and gets a token whose `owner_id` claim equals the legacy `lot_owners.id` — **the exact assertion that proves RLS keeps working**.
2. That token also carries `user_id`, `org_ids` and `org_role: "admin"`.
3. A second user created under the same org (no `lot_owners` row of its own) signs in and gets the **same** `owner_id` claim — one shared RLS identity, three named logins.
4. A user with a membership but whose org has no legacy link gets 403 with the "not fully provisioned" message, **not** a token that returns empty pages.
5. A user with no membership at all gets the other 403.
6. An account with `password_hash IS NULL` still falls through to the legacy path and still gets `403 Password not set` — the N Style case.
7. A partner login gets `account_type: "partner"` and a `partner_id` claim, unchanged.
8. `GET /auth/me` returns every pre-2.2 key **plus** `organization` and `features`; assert key-by-key against a literal list so a future refactor cannot drop one.
9. **D13 regression:** `GET /auth/me` on a **legacy** session — `subject.user_id is None`, the owner branch **and** the partner branch — returns `200` with `organization: None`. An earlier draft appended `login()`'s local `default` to this handler; on the legacy path that is a `NameError` and a 500 on the endpoint the dashboard polls on every load. Assert both branches explicitly, not just the owner one.
10. `GET /auth/me` on a **tenancy** session returns the org whose id equals `users.default_organization_id`, and a user whose `default_organization_id` is NULL gets its first membership rather than `None`.

- [ ] **Step 6: Full gate, then commit**

```
feat(auth): sign in through users + memberships, without moving the RLS identity

The claim that matters is owner_id/partner_id, because public.current_owner_id()
and current_partner_id() are what every RLS policy resolves. So this derives it
from THE ORGANISATION'S legacy link, not from the user -- which is what lets a
brand-new staff login with no lot_owners row of its own satisfy
properties_authenticated_select with zero policy changes.

Resolution order is users (with a password) -> lot_owners -> enforcement_partners,
so an account the backfill left alone keeps its exact behaviour, including the
403 "Password not set" the one passwordless owner sees today.

/auth/me gains `organization` and `features` and loses nothing; App.jsx merges
that response into a persisted session.
```

---

### Task 10: FE-16 — capability-driven tab gates, and the hardcoded partner UUID is deleted

**Files:**
- Modify: `frontend/src/App.jsx`
- Test: `frontend/tests/…` node test + `tests/e2e/dashboard-smoke.spec.ts` unchanged and green

**Interfaces:**
- Consumes: `/auth/me`'s `features.partner_app` and `organization.role` (Task 9).
- Produces: no `NMLD_PARTNER_ID`, anywhere.

- [ ] **Step 1: Delete the constant and its three uses**

`frontend/src/App.jsx:30` — delete:

```js
const NMLD_PARTNER_ID = '1826b6b4-e8dc-402f-b4e7-926e259a56fe';
```

Line 177 (the valid-tab list for a partner session), 563 (the nav item) and 710 (the render gate) each compare `(viewAs?.id || owner?.id) === NMLD_PARTNER_ID`. Replace all three with one derived boolean near the other gates:

```js
  // FE-16. Was a customer's UUID pasted into shipped code -- which meant site
  // #12 getting the reservation app was a frontend deploy. It is now a row:
  // /auth/me computes `features.partner_app` from properties.app_enabled over
  // the properties this login actually has.
  const partnerAppEnabled = !!owner?.features?.partner_app;
```

and use `(FRANK_APP_TAB_LIVE && partnerAppEnabled)` where the UUID comparison was. Keep `FRANK_APP_TAB_LIVE` — it is a separate kill switch and deleting it is fat decision 9's call, not this task's.

- [ ] **Step 2: Merge `features` into the persisted session**

`App.jsx` already refreshes `is_admin` / `is_platform_admin` from `/auth/me` into the persisted `owner` object (the `prev.is_admin === !!me.is_admin` guard around line 400 in the module tree). Extend the same merge to `features` and `organization`, keeping the same "only setState when something actually changed" shape so it does not re-render on every poll:

```js
        const sameFeatures = JSON.stringify(prev.features || null) === JSON.stringify(me.features || null);
        const sameOrg = (prev.organization?.id || null) === (me.organization?.id || null)
                     && (prev.organization?.role || null) === (me.organization?.role || null);
        if (prev.is_admin === !!me.is_admin
            && prev.is_platform_admin === !!me.is_platform_admin
            && sameFeatures && sameOrg) {
          return prev;
        }
        const merged = { ...prev, is_admin: !!me.is_admin,
                         is_platform_admin: !!me.is_platform_admin,
                         features: me.features || null,
                         organization: me.organization || null };
```

- [ ] **Step 3: Test**

Add `frontend/scripts/app-gates.test.mjs` (the repo's `npm test` is `node --test scripts/*.test.mjs`) exercising a pure helper extracted from the gate logic — extract `export function visibleTabs({ isOwner, isPlatformAdmin, showMoney, partnerAppEnabled })` from `App.jsx` and assert:
1. a partner session with `partnerAppEnabled: false` has no `app` tab;
2. the same session with `true` has one;
3. a platform admin has `admin`, `app` and `hq` regardless;
4. **no test and no source file in `frontend/src/` contains the string `1826b6b4`** — a grep assertion, so the UUID cannot come back.

Then `tests/e2e/dashboard-smoke.spec.ts` and `tests/e2e/access-control.spec.ts` unchanged and green, plus `npm run visual:check` (the App tab is not in the visual baseline's login-shell captures, so zero DOM diffs is the expected result).

- [ ] **Step 4: Commit**

```
fix(dashboard): the App tab is a row, not a customer's UUID in shipped code

FE-16. `NMLD_PARTNER_ID = '1826b6b4-...'` gated a whole tab on one customer's id,
so site #12 getting the reservation app meant a frontend deploy. /auth/me now
computes features.partner_app from properties.app_enabled over the properties the
login actually has, and the gate reads that.

A grep assertion in the node tests stops the UUID coming back.
```

---

### Task 11: SEC-6 — `integrations.organization_id`, per-org QuickBooks resolution

**Files:**
- Create: `migrations/20260914140400_integrations_organization_id.sql`
- Modify: `models.py` (`Integration.organization_id`), `services/quickbooks.py`, `routers/quickbooks.py`
- Test: `tests/plaza/test_quickbooks_connection_scope.py`; `tests/test_quickbooks_connection.py` unchanged and green

**Interfaces:**
- Consumes: Task 2's organizations.
- Produces: `await quickbooks.get_connection(db, organization_id=None) -> Integration | None` — resolves the org's row, falling back to the single unowned row when none exists.

Half of SEC-6 is already on `main` (platform-admin gate, deterministic `ORDER BY connected_at DESC`). This finishes the org half and stops there — building a per-org OAuth flow is worth doing when there is a second billing entity, and there is one.

- [ ] **Step 1: The migration**

```sql
-- SEC-6 (the org half). The QuickBooks connection was ONE global row selected
-- with "take any row" -- so the day a second property owner has a login, they
-- could replace it and invoices start writing into a nondeterministic company
-- file. The gate and the deterministic ordering landed already; this adds the
-- column that makes "whose books?" a stored answer instead of an assumption.
--
-- Nullable and unbackfilled on purpose: the one live row belongs to LotLogic
-- itself, not to a customer org, and services/quickbooks.get_connection treats
-- a NULL organization_id as "the platform's connection". A second billing
-- entity is what makes backfilling it meaningful.

BEGIN;

ALTER TABLE public.integrations
    ADD COLUMN IF NOT EXISTS organization_id uuid
        REFERENCES public.organizations(id) ON DELETE SET NULL;

-- One live connection per (provider, org). The partial index lets the existing
-- unowned row coexist with future per-org ones.
CREATE UNIQUE INDEX IF NOT EXISTS integrations_provider_org_key
    ON public.integrations (provider, organization_id)
    WHERE organization_id IS NOT NULL;

COMMIT;
```

- [ ] **Step 2: One resolver, in the one place that reads the connection**

There is **one** such query in `services/quickbooks.py` — `get_active_integration` (line 135) — plus the copy inside `routers/quickbooks.py::status` (line 68). Two sites, not three. Change both to call the resolver:

```python
async def get_connection(db: AsyncSession, organization_id: uuid.UUID | None = None):
    """The QuickBooks connection to use.

    An org's own row when it has one; otherwise the platform's unowned row.
    Deterministic in both cases -- "take any row" is how a second owner's
    connect could have silently redirected LotLogic's invoices into their
    company file (SEC-6).
    """
    if organization_id is not None:
        own = await db.scalar(
            select(Integration).where(
                Integration.provider == "quickbooks",
                Integration.organization_id == organization_id,
            ).limit(1))
        if own is not None:
            return own
    return await db.scalar(
        select(Integration).where(
            Integration.provider == "quickbooks",
            Integration.organization_id.is_(None),
        ).order_by(Integration.connected_at.desc()).limit(1))
```

- [ ] **Step 3: The org travels in the OAuth state, because the callback has no subject**

**`GET /quickbooks/oauth/callback` is in `main.PUBLIC_PATHS` and `exchange_code(code, realm_id, db)` takes no subject.** Intuit redirects the browser back to us; there is no `Authorization` header, no `Subject`, and nothing to stamp an `organization_id` or an audit actor from. An earlier draft said "`exchange_code` stamps `organization_id` from the connecting subject" — there is no connecting subject at that point in the flow.

The only thing that crosses the round trip is `state`. So carry it there.

`services/quickbooks.py` already mints `state = secrets.token_urlsafe(24)` and holds it server-side in the module-level `_oauth_states` dict with a timestamp, `verify_state` popping it (single use, 10-minute sweep). Widen the value from a timestamp to a pair, and hand the org id back on the way out:

```python
#: state token -> (minted_at, organization_id | None). Held server-side rather
#: than signed into the string: the token is already 24 unguessable bytes and
#: already single-use, so there is nothing for a signature to add -- and a
#: server-side value cannot be replayed after `verify_state` pops it.
_oauth_states: dict[str, tuple[datetime, Optional[uuid.UUID]]] = {}


def build_authorize_url(
    state: Optional[str] = None, *, organization_id: Optional[uuid.UUID] = None,
) -> tuple[str, str]:
    state = state or secrets.token_urlsafe(24)
    _oauth_states[state] = (datetime.now(timezone.utc), organization_id)
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=10)
    for s, (t, _org) in list(_oauth_states.items()):
        if t < cutoff:
            _oauth_states.pop(s, None)
    ...


def consume_state(state: str) -> tuple[bool, Optional[uuid.UUID]]:
    """Pop a state token. Returns (was_valid, organization_id).

    Replaces verify_state(), which returned a bare bool and threw the org away.
    Keep the old name as a one-line alias if anything else imports it.
    """
    entry = _oauth_states.pop(state, None)
    if entry is None:
        return False, None
    return True, entry[1]
```

`exchange_code` gains a keyword-only `organization_id: uuid.UUID | None = None` and stamps it on the row it creates (leaving it unchanged on a reconnect of an existing `realm_id`). The callback becomes:

```python
    ok, organization_id = consume_state(state)
    if not ok:
        raise HTTPException(400, "Invalid or expired state")
    integ = await exchange_code(code, realmId, db, organization_id=organization_id)
```

- [ ] **Step 4: The audit row is written by `oauth_start`, which *does* have a subject**

`GET /quickbooks/oauth/start` is `Depends(require_platform_admin)`. That is the authenticated end of this flow and the only end that knows who a human is, so that is where the audit row goes:

```python
@router.get("/oauth/start")
async def oauth_start(
    subject: Subject = Depends(require_platform_admin),
    db: AsyncSession = Depends(get_db),
):
    # A platform admin connecting on LotLogic's behalf leaves organization_id
    # NULL -- the platform's own books, which is the one live row today. An
    # org-scoped connect passes that org's id, and it rides back through the
    # state token (Step 3) because the callback has no subject to ask.
    organization_id = None if subject.is_platform_admin or subject.is_service else ...
    url, state = build_authorize_url(organization_id=organization_id)
    await audit.record(
        db, subject, audit.Action.QUICKBOOKS_CONNECTED,
        organization_id=organization_id, target_table="integrations",
        detail={"stage": "authorize_redirect"},
    )
    await db.commit()
    return {"auth_url": url}
```

The row records the *intent* and its actor, stamped at the moment a named human asked for it. The callback writes no audit row at all, and the reason is one line in its docstring: **there is no subject there to attribute it to, and an audit row with no actor is worse than none.**

- [ ] **Step 5: Tests**

`tests/plaza/test_quickbooks_connection_scope.py`:
1. With only the unowned row, `get_connection(db)` and `get_connection(db, org)` both return it — today's behaviour, preserved.
2. With an org row present, `get_connection(db, that_org)` returns it and `get_connection(db, other_org)` returns the unowned one.
3. Two rows for the same `(provider, org)` cannot be inserted (the partial unique).
4. `exchange_code(..., organization_id=None)` leaves the column NULL — the platform's own books, which is the one live row.
5. **`consume_state` round-trips the org id** and is single-use: a second `consume_state` with the same token returns `(False, None)`. *This is the whole D6 fix; without it the callback has nothing to stamp.*
6. An expired state (mint one, wind `_oauth_states`'s timestamp back 11 minutes) returns `(False, None)`.
7. `GET /quickbooks/oauth/start` writes exactly one `admin_audit_log` row with `action='quickbooks.connected'` and the caller's email; the **callback writes none** — assert the count does not move across a simulated callback.
8. `tests/test_quickbooks_connection.py` and `tests/test_quickbooks_invoice_builder.py` green **unchanged**. If either needs an edit, the resolver changed behaviour it should not have. If either calls `verify_state`, keep the one-line alias rather than editing the test.

- [ ] **Step 6: Commit**

```
fix(quickbooks): the connection knows whose books it is (SEC-6, org half)

integrations.organization_id, nullable, with one resolver: the org's own row if
it has one, otherwise the platform's unowned row. The one live connection is
LotLogic's own and is deliberately left unowned, so nothing about weekly
invoicing changes today.

The org id travels in the OAuth state token, because the callback genuinely has
no subject to ask -- it is in PUBLIC_PATHS, Intuit redirects a browser to it,
and exchange_code takes no Subject. _oauth_states already holds a server-side,
single-use, unguessable token per flow; its value grows from a timestamp to
(timestamp, organization_id) and consume_state hands the org back. The audit row
is written by /oauth/start, the authenticated end, where a named human exists to
attribute it to; the callback writes none and says why.

The gate and the deterministic ordering landed earlier; a per-org OAuth flow is
worth writing when a second billing entity exists.
```

---

### Task 12: Migration — `properties.policy_image_url`, and the upload endpoint

**Files:**
- Create: `migrations/20260914140500_properties_policy_image_url.sql`
- Modify: `routers/admin.py` (`POST /admin/sites/{property_id}/policy-image`), `config.py`
- Modify: `frontend/src/visit.js` (prefer the stored URL; keep the existing fallback)
- Test: `tests/test_policy_image_upload.py`

**Interfaces:**
- Consumes: `services/storage.upload_bytes(data, key, content_type) -> tuple[str, str]` — **data first, and it returns `(storage_key, public_url)`, not a URL string**; `settings.r2_public_url`; `services/tenancy.assert_property_access`.
- Produces: `properties.policy_image_url text`, readable by `anon`; `POST /admin/sites/{property_id}/policy-image` (multipart, platform-admin) returning `{"policy_image_url": ...}`.

**Why this is its own task:** adding site #12's posted policy today means committing `frontend/policy/<qr>.jpg` to the frontend repo and waiting for a Vercel deploy. That is one of the three "a new site costs a deploy" steps, and Task 13 cannot claim to be a one-command onboarding while it is true.

- [ ] **Step 1: The migration**

```sql
-- The property's posted policy image stops being a file committed to the
-- frontend repo (frontend/policy/<qr_code_id>.jpg, read by src/visit.js:191)
-- and becomes a row. That file is one of the three reasons adding a site
-- currently costs a deploy.
--
-- GRANTED TO anon, deliberately and narrowly. Production revoked properties'
-- table-level SELECT and granted back a named column list
-- (20260707170000_properties_anon_column_scope), so a new column is private by
-- default -- correct for organization_id, wrong for this one: the page that
-- renders it is scanned by a driver who holds no credential, and the image IS
-- the public notice nailed to a post at the entrance. The object key carries 8
-- random hex characters so the bucket's public base cannot be enumerated.

BEGIN;

ALTER TABLE public.properties
    ADD COLUMN IF NOT EXISTS policy_image_url text;

GRANT SELECT (policy_image_url) ON public.properties TO anon;

COMMIT;
```

**Check this one against CI's census step with particular care** — a column-level grant is an object the `scripts/db/inventory.sql` census may or may not count. If `schema-rebuild` fails on the census diff, that is the expected, correct behaviour: production is migrated first, then all three derived artifacts are regenerated together (Task 17).

- [ ] **Step 2: `config.py`**

```python
    # The posted policy image. 8 MB: these are phone photographs of a printed
    # sign, and the existing charlotte-travel-plaza.jpg is 1.1 MB.
    policy_image_max_bytes: int = 8 * 1024 * 1024
```

- [ ] **Step 3: The endpoint**

In `routers/admin.py` (platform-admin gated like the rest of the router):

```python
_POLICY_IMAGE_TYPES = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}


@router.post("/sites/{property_id}/policy-image")
async def upload_policy_image(
    property_id: uuid.UUID,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    subject: Subject = Depends(require_platform_admin),
) -> dict:
    """Upload the property's posted policy image and store its public URL.

    Content-type allow-list and a size cap enforced WITHOUT buffering the whole
    upload first -- routers/apartment_docs.py does the same and for the same
    reason. Unlike that endpoint, the object here is public by design: it is the
    notice posted at the entrance, and the page that renders it is scanned by
    someone holding no credential.
    """
    ext = _POLICY_IMAGE_TYPES.get((file.content_type or "").lower())
    if ext is None:
        raise HTTPException(status_code=415, detail="Policy image must be JPEG, PNG or WebP.")

    limit = settings.policy_image_max_bytes
    chunks, total = [], 0
    while chunk := await file.read(64 * 1024):
        total += len(chunk)
        if total > limit:
            raise HTTPException(status_code=413,
                                detail=f"Policy image must be under {limit // (1024*1024)} MB.")
        chunks.append(chunk)

    # 8 random hex characters: the snapshots bucket has a public base URL, so an
    # object key must not be guessable from the property id alone.
    key = f"policy/{property_id}/{secrets.token_hex(4)}{ext}"
    # upload_bytes(data, key, content_type) -> (storage_key, public_url).
    # Data FIRST, and take the URL from its second return value rather than
    # rebuilding it: storage.py owns how a public URL is formed, and it raises
    # on a failed put (unlike upload_snapshot, which swallows), so a failure
    # here surfaces to the admin instead of writing a dead URL to the row.
    _stored_key, url = await upload_bytes(b"".join(chunks), key, file.content_type)

    updated = (await db.execute(text("""
        UPDATE public.properties SET policy_image_url = :url
         WHERE id = CAST(:pid AS uuid)
     RETURNING id, organization_id
    """), {"url": url, "pid": str(property_id)})).mappings().first()
    if not updated:
        raise HTTPException(status_code=404, detail="Property not found")

    await audit.record(db, subject, audit.Action.SITE_POLICY_IMAGE_UPLOADED,
                       property_id=property_id,
                       organization_id=updated["organization_id"],
                       target_table="properties", target_id=str(property_id),
                       detail={"bytes": total, "content_type": file.content_type})
    await db.commit()
    return {"policy_image_url": url}
```

- [ ] **Step 4: `frontend/src/visit.js` prefers the row**

At the policy block (~line 188), replace the two hardcoded `/policy/${qrCodeId}.jpg` occurrences with a resolved source and keep the existing `onerror` chain intact:

```js
  // The posted policy image. Prefer the stored URL (Wave 2.3 -- adding a site no
  // longer means committing a JPEG to this repo); fall back to the committed
  // /policy/<qr>.jpg for the sites that predate it; fall back again to the text
  // policy when neither exists. The onerror listener below already handles the
  // last hop and is unchanged.
  const policySrc = property.policy_image_url || `/policy/${qrCodeId}.jpg`;
```

**Do not touch the paid branch of `visit.js`** (Global Constraints). This edit is in the shared policy block above it; if the diff reaches a `paid`-guarded line, stop.

- [ ] **Step 5: Tests**

`tests/test_policy_image_upload.py` (router-level, `upload_bytes` monkeypatched):
1. A non-admin subject gets 403.
2. `text/html` gets 415.
3. A payload one byte over the cap gets 413 **and `upload_bytes` is never called** — the cap must bite before the upload, not after.
4. A valid JPEG returns a URL under `settings.r2_public_url`, containing 8 hex characters, and the row is updated.
5. An unknown property id gets 404 and no row is written.
6. One `admin_audit_log` row is written with `action='site.policy_image_uploaded'`.

Frontend: a node test asserting `policySrc` prefers `property.policy_image_url`, plus `npm run check:naming` and `npm run visual:check` green.

- [ ] **Step 6: Commit (two, one per repo)**

```
feat(sites): the posted policy image is a row, not a file in the frontend repo

Adding a site's policy today means committing frontend/policy/<qr>.jpg and
waiting for a Vercel deploy -- one of the three reasons a new site costs a
deploy. properties.policy_image_url is granted to anon narrowly and on purpose:
the page that renders it is scanned by a driver holding no credential, and the
image IS the notice posted at the entrance. The object key carries 8 random hex
characters so the bucket's public base cannot be enumerated.

The committed JPEGs stay as the fallback; nothing breaks on deploy day.
```

---

### Task 13: `POST /admin/sites` — the one site-onboarding command

**Files:**
- Create: `services/site_onboarding.py`
- Modify: `routers/admin.py` (`POST /admin/sites`, `GET /admin/sites/{property_id}`; `POST /admin/clients` becomes a thin alias)
- Test: `tests/plaza/test_site_onboarding.py`, `tests/test_admin_sites_api.py`

**Interfaces:**
- Consumes: Tasks 2, 3, 6, 12.
- Produces:
  - `SiteOnboardRequest` — **the new-site checklist** (Task 16 generates the runbook from it).
  - `SiteOnboardResponse` — property id, org id, qr ids and URLs, the QR-sheet URL (`{SITE_URL}/qr-sheet.html?property=<id>`, a standalone entry page — see Task 14), one setup link per created login, and a `checklist` object naming what is still outstanding.
  - `site_onboarding.mint_qr_code_id(db, name) -> str`.

**What it replaces.** Two half-paths:
- `POST /admin/clients` (the admin console's Onboard tab) writes `name`, `address`, `property_type`, `owner_id`, `partner_id`, `tow_company_id` — and **not** `qr_code_id`, so the property it creates can never serve `/temp/<qr>` or `/perm/<qr>`. That is PLATFORM-1 exactly.
- The dashboard's inline add-property form (`ALPRPropertiesPage.jsx` → `db.createProperty`) writes straight to Supabase, mints a `qr_code_id` **in the browser**, and creates no owner or partner account at all.

- [ ] **Step 1: The request schema — this is the checklist**

In `routers/admin.py`:

```python
class SiteOrganizationIn(BaseModel):
    """Who owns the site. Either an existing organization, or a new one."""
    model_config = ConfigDict(extra="forbid")
    existing_id: Optional[uuid.UUID] = None
    name: Optional[str] = None


class SiteLoginIn(BaseModel):
    """One named person who can sign in. Not a shared office password."""
    model_config = ConfigDict(extra="forbid")
    email: EmailStr
    display_name: str
    role: Literal["admin", "manager", "staff", "viewer"] = "manager"


class SiteEnforcementIn(BaseModel):
    """The tow partner. An existing one, or a new one with its own login."""
    model_config = ConfigDict(extra="forbid")
    existing_partner_id: Optional[uuid.UUID] = None
    company_name: Optional[str] = None
    contact_name: Optional[str] = None
    email: Optional[EmailStr] = None
    phone: Optional[str] = None
    #: Omitted = the enforcement_partners defaults (25% / $150 / $350). Set only
    #: when this site's deal differs. Cents, per the money-column rule.
    revenue_share: Optional[float] = Field(default=None, ge=0, le=1)
    boot_fee_cents: Optional[int] = Field(default=None, ge=0)
    tow_fee_cents: Optional[int] = Field(default=None, ge=0)


class SitePolicyIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    #: Shown on the QR form when no policy image is uploaded. Required for a
    #: truck plaza (the driver agrees to it); optional for an apartment.
    policy_text: Optional[str] = None
    policy_phone: Optional[str] = None


class SiteSettingsIn(BaseModel):
    """Everything the two old paths left NULL and someone later fixed by hand."""
    model_config = ConfigDict(extra="forbid")
    total_spaces: int = Field(default=0, ge=0)
    cooldown_hours: Optional[int] = Field(default=None, ge=0, le=720)
    guest_auto_approve: bool = False
    permanent_plates_disabled: bool = False
    reject_tow_disclaimer: bool = False
    #: Both default OFF. app_enabled is fat decision 9's free-parking path and
    #: pay_to_park_enabled takes card payments -- neither is a thing a new site
    #: gets by accident.
    app_enabled: bool = False
    pay_to_park_enabled: bool = False
    lat: Optional[float] = None
    lng: Optional[float] = None


class SiteIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1)
    address: str = Field(min_length=1)
    property_type: Literal["apartment", "truck_plaza"]
    #: Omitted = the single configured market. Named so site #12 in a second
    #: city is a field, not a migration.
    market_id: Optional[uuid.UUID] = None
    #: Omitted = minted from the name. Supply one only to match a sign already
    #: printed.
    qr_code_id: Optional[str] = Field(default=None, pattern=r"^[a-z0-9][a-z0-9-]{2,59}$")


class SiteOnboardRequest(BaseModel):
    """THE NEW-SITE CHECKLIST.

    Every field here is something that used to be a step in a 25-step run-book,
    14 of them raw SQL. If a new site needs something this schema cannot say,
    that is the bug -- add the field, do not reach for psql.
    """
    model_config = ConfigDict(extra="forbid")
    organization: SiteOrganizationIn
    site: SiteIn
    enforcement: SiteEnforcementIn = SiteEnforcementIn()
    logins: list[SiteLoginIn] = Field(default_factory=list, max_length=10)
    policy: SitePolicyIn = SitePolicyIn()
    settings: SiteSettingsIn = SiteSettingsIn()
```

- [ ] **Step 2: `services/site_onboarding.py` — one transaction**

```python
"""services/site_onboarding.py — standing up a site is ONE transaction.

PLATFORM-1: today there are two ways to create a property and each does half the
job. The admin console never writes qr_code_id, so its property can never serve
a registration link; the dashboard's inline form mints the qr id IN THE BROWSER
and creates no accounts. This is the merge.

Order matters, and it is: organization -> partner -> property -> users ->
memberships. Everything is in the caller's transaction and the router commits
once, so a half-built site is not a state this code can produce -- which is the
property routers/admin.py::onboard_client already had and the one thing about it
worth keeping.
"""
```

Key pieces:

```python
_SLUG_STRIP = re.compile(r"[^a-z0-9]+")


def slugify(name: str) -> str:
    """`The Villas at 1825` -> `villas-at-1825`.

    Matches the shape production already uses (verified 2026-09-14: eleven
    slugs, all of this form). Leading articles are dropped because every
    existing slug drops them.
    """
    s = _SLUG_STRIP.sub("-", (name or "").lower()).strip("-")
    for article in ("the-", "a-", "an-"):
        if s.startswith(article):
            s = s[len(article):]
            break
    return s[:40].strip("-") or "site"


async def mint_qr_code_id(db: AsyncSession, name: str, requested: str | None = None) -> str:
    """A unique, human-readable qr_code_id. Server-side, always.

    The browser minted this before (db.createProperty appended a UUID slice), so
    two admins creating the same site in two tabs produced two properties and
    one printed sign pointing at whichever won. properties.qr_code_id is UNIQUE;
    this loop asks the database rather than assuming.
    """
    base = requested or slugify(name)
    for attempt in range(8):
        candidate = base if attempt == 0 else f"{base}-{secrets.token_hex(2)}"
        taken = (await db.execute(
            text("SELECT 1 FROM public.properties WHERE qr_code_id = :q LIMIT 1"),
            {"q": candidate})).first()
        if not taken:
            return candidate
    raise HTTPException(status_code=409,
                        detail="Could not mint a unique QR code id for that name.")
```

and `async def onboard(db, subject, body, *, site_url) -> dict` doing, in order:

1. **Organization.** `existing_id` → load and verify it exists and `kind='owner'`; else insert `(name=body.organization.name or body.site.name, kind='owner')`.
2. **Owner legacy row.** An org with no `legacy_owner_id` gets one created now — a `lot_owners` row carrying the org's name, the first login's email, `phone=''`. **This is not optional**: Task 9 refuses to issue a token for an org with no legacy link, because such a token satisfies no RLS policy and returns empty pages. Stamp `organizations.legacy_owner_id`.
3. **Partner.** `existing_partner_id` → verify; else, when `company_name` is given, insert an `enforcement_partners` row (`market_id` from `body.site.market_id` or the single configured market — the same lookup `onboard_client` uses today), apply any fee overrides, create its organization (`kind='partner'`, `legacy_partner_id`), and a `users` row + `admin` membership for its contact email.
4. **Property.** One INSERT writing **every** column the schema has a meaning for:

```sql
INSERT INTO public.properties
    (name, address, property_type, qr_code_id, owner_id, partner_id, tow_company_id,
     organization_id, market_id, total_spaces, lat, lng,
     policy_text, policy_phone, cooldown_hours,
     guest_auto_approve, permanent_plates_disabled, reject_tow_disclaimer,
     app_enabled, pay_to_park_enabled, active, onboarded_at)
VALUES (...)
RETURNING id, qr_code_id
```

   `tow_company_id = partner_id` for an apartment and `NULL` for a truck plaza — the rule `onboard_client` already encodes; keep it and keep its comment.
5. **Logins.** For each entry in `body.logins`: find-or-create the `users` row by `lower(email)`, mint a reset token (`generate_reset_token()`, expiring at `now + settings.password_reset_ttl_hours`), insert the membership at the requested role, set `default_organization_id` when the user has none. The **first** login also gets its token mirrored onto the new `lot_owners` row so the legacy path works for it too.
6. **Audit.** One `audit.record(..., Action.SITE_ONBOARDED, property_id, organization_id, detail={"logins": n, "partner": bool, "qr_code_id": ...})`, plus one `Action.LOGIN_CREATED` per new user.

The router commits once and rolls back on any failure, exactly as `onboard_client` does today — including the `except HTTPException: rollback; raise` / `except Exception: rollback; log; 500` pair.

- [ ] **Step 3: The response — setup links, QR links, and what is still missing**

```python
    return {
        "property_id": str(prop_id),
        "organization_id": str(org_id),
        "qr": {
            "code_id": qr_code_id,
            "pass_url": f"{site}/temp/{qr_code_id}",
            "permanent_url": f"{site}/perm/{qr_code_id}",
            # A standalone entry page, not a dashboard tab -- App.jsx routes
            # from localStorage, never from the pathname, so an /app/... link
            # could not open it. See Task 14 and scope call 6.
            "sheet_url": f"{site}/qr-sheet.html?property={prop_id}",
        },
        "logins": [{"email": e, "role": r, "setup_link": f"{site}/set-password?token={t}"}
                   for e, r, t in created_logins],
        "partner": ({"id": str(partner_id), "setup_link": ...} if partner_token else None),
        # Not an error list -- a to-do list. The one thing a POST cannot carry is
        # the policy photograph, so it is always here on a fresh site.
        "checklist": {
            "policy_image_uploaded": False,
            "cameras_registered": False,
            "policy_text_set": bool(body.policy.policy_text),
            "logins_created": len(created_logins),
        },
    }
```

`"/temp/"` and `"/perm/"` are the live Vercel rewrites (`→ visit.html` / `resident.html`); `set-password` lives at the **site root**, not under `/app`, and `_setup_link` in `routers/admin.py` already says why.

- [ ] **Step 4: `POST /admin/clients` becomes a thin alias**

Do not delete it — the deployed dashboard calls it until Task 15 ships, and the Global Constraints say no route path changes. Rewrite its body to build a `SiteOnboardRequest` from the old payload and call `site_onboarding.onboard`, then return the **old** response shape (`{property_id, owner: {...}, partner: {...}}`) so the deployed frontend is unaffected. Add one line to its docstring: *"Kept for the pre-2.3 dashboard. New callers use POST /admin/sites, which writes the QR ids."*

The alias is what makes PLATFORM-1 fixed for **everyone** on the day this deploys, including anyone still on a cached dashboard bundle — the old form's properties start getting QR ids too.

- [ ] **Step 5: Tests**

`tests/plaza/test_site_onboarding.py` (real Postgres — this is the task's whole point):
1. **One POST produces a site that can serve a QR code.** `qr_code_id` is non-null, unique, and matches the production slug shape. *This is the PLATFORM-1 regression test and it must fail against `onboard_client`.*
2. Every column in the `properties` insert is non-NULL where the request supplied a value — assert field-by-field against the request, not against a count.
3. `organization_id` is set, the org has a `legacy_owner_id`, and a `lot_owners` row exists behind it.
4. Each `logins` entry gets a `users` row, a membership at the requested role, and a distinct setup link.
5. A second site under the same `existing_id` reuses the org and creates no second `lot_owners` row.
6. A duplicate name mints `villas-at-1825-ab12`, not a collision — insert a property at the plain slug first and assert the suffix shape.
7. **Rollback:** a request whose second login has a duplicate email leaves **no** property, **no** org, **no** user (patch the second insert to raise, assert every table's count is unchanged).
8. An apartment gets `tow_company_id = partner_id`; a truck plaza gets `NULL`.
9. One `site.onboarded` audit row, with the property and org ids on it.
10. `POST /admin/clients` with the **old** payload returns the **old** shape and now also writes a `qr_code_id`.

`tests/test_admin_sites_api.py` (router-level): non-admin → 403; `extra="forbid"` rejects an unknown field with 422 (so a typo in the checklist is caught, not silently dropped); `qr_code_id` failing the pattern → 422; an unknown `existing_id` → 404.

- [ ] **Step 6: Commit**

```
feat(sites): one command stands up a site (PLATFORM-1)

Two half-paths become one. The admin console never wrote qr_code_id -- so every
property it created was one that could never serve /temp/<qr> or /perm/<qr> --
and the dashboard's inline form minted the qr id in the BROWSER and created no
accounts at all.

POST /admin/sites writes every column the schema has a meaning for, mints both
QR ids server-side against the UNIQUE constraint, creates the organization, the
legacy owner row the RLS identity needs, the partner, and one named login per
person, and returns setup links, both QR URLs, the printable sheet's URL and a
checklist of what is still outstanding. One transaction; a half-built site is
not a state this code can produce.

POST /admin/clients stays as a thin alias over the same service so the deployed
dashboard keeps working -- and starts writing QR ids the day this deploys.

The request schema IS the new-site checklist. Task 16 generates the runbook from it.
```

---

### Task 14: The printable QR sheet — a standalone entry page

**Files:**
- Create: `frontend/qr-sheet.html`, `frontend/src/qr-sheet.js`
- Modify: `frontend/scripts/build.mjs` (`entryPoints` + the not-silently-empty assert list), `frontend/styles/` (a print block)
- Modify: `routers/admin.py` — `GET /admin/sites/{property_id}` returns the fields the sheet renders
- Test: `tests/e2e/qr-sheet.spec.ts` (self-serving, runs in `e2e (local dist)`)

**Interfaces:**
- Consumes: `qrcode@1.5.4` (already a bundled dependency), `src/lib/api.js::apiFetch` (which reads the admin's JWT out of `localStorage['lotlogic_session']._token`), Task 13's `qr.sheet_url`.
- Produces: `/qr-sheet.html?property=<uuid>` — one page, two QR codes, `@media print` styled to a US-Letter sheet.

**Not a dashboard tab, and not a backend PDF.** Scope call 6 has both halves; the first is the one a reviewer will want to re-litigate, so it is restated here with the evidence:

> `App.jsx` reads its current tab from `localStorage.getItem('lotlogic_tab')` (line 95) and **never** looks at `window.location.pathname`. Line 178 then coerces any tab outside the valid list back to `'lots'`. A `/app/qr-sheet?property=…` link would open the dashboard on whatever tab the admin last used — the page would be unreachable by the only means it is ever reached, a link. Making it reachable means teaching `App.jsx` to route on `pathname`, which is a router: a change to every tab's history behaviour, the deep-link semantics of eight lazy pages, and the visual baseline, in service of one printable page.

So it is a **fourth standalone entry page**, exactly like `visit.html` / `resident.html` / `apt.html`: its own HTML shell, its own esbuild entry, no React, no dashboard shell. `POST /admin/sites` returns `{SITE_URL}/qr-sheet.html?property=<id>`.

- [ ] **Step 1: `GET /admin/sites/{property_id}` — what the sheet needs, and nothing else**

The page holds the admin's own JWT, so it asks the backend rather than Supabase. Add to `routers/admin.py` (platform-admin gated like the rest of the router):

```python
@router.get("/sites/{property_id}")
async def get_site(
    property_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    subject: Subject = Depends(require_platform_admin),
) -> dict:
    """The fields the printable QR sheet renders. Deliberately narrow: this
    response is rendered by a page with no login screen of its own, so it
    carries nothing that is not already printed on the sheet."""
    row = (await db.execute(text("""
        SELECT id, name, address, qr_code_id, policy_phone, property_type
          FROM public.properties WHERE id = CAST(:pid AS uuid)
    """), {"pid": str(property_id)})).mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="Property not found")
    return dict(row)
```

- [ ] **Step 2: `frontend/qr-sheet.html`**

Copy `visit.html`'s shell shape: `<!doctype html>`, the brand stylesheet link, one `<div id="sheet">`, and `<script type="module" src="/qr-sheet.js"></script>`. No `error-reporting.js` needed (this page makes one call and shows its failure inline).

- [ ] **Step 3: `frontend/src/qr-sheet.js`**

```js
// The sheet an operator prints and posts at the entrance. Two codes: one for a
// parking pass, one to register a vehicle. Deliberately boring -- it is printed
// in black on white, at a distance, by someone standing in a parking lot.
//
// A standalone entry page rather than a dashboard tab: App.jsx takes its tab
// from localStorage and never from the pathname, so a /app/... link could not
// open this. Same pattern as visit.html / resident.html / apt.html.
//
// Naming rule: the codes are labelled by what a person DOES with them, never by
// a pass class.
import QRCode from 'qrcode';
import { apiFetch } from './lib/api.js';

const root = document.getElementById('sheet');
const propertyId = new URLSearchParams(window.location.search).get('property');

function fail(message) {
  root.textContent = message;
  root.className = 'qr-sheet-error';
}

async function main() {
  if (!propertyId) return fail('No site selected.');
  let property;
  try {
    property = await apiFetch(`/admin/sites/${propertyId}`);
  } catch (err) {
    // apiFetch clears the session and fires lotlogic:auth-expired on a 401;
    // this page has no login form, so say where to get one.
    return fail(err.status === 401
      ? 'Sign in at /app first, then reopen this link.'
      : err.message);
  }
  if (!property.qr_code_id) {
    return fail('This site has no QR code id yet. Re-run onboarding.');
  }

  root.innerHTML = `
    <header>
      <h1>${escapeHtml(property.name)}</h1>
      <p>${escapeHtml(property.address || '')}</p>
    </header>
    <section>
      <figure>
        <canvas id="qrPass" aria-label="Scan to get a parking pass at ${escapeHtml(property.name)}"></canvas>
        <figcaption>Scan to get a parking pass</figcaption>
      </figure>
      <figure>
        <canvas id="qrRegister" aria-label="Scan to register a vehicle at ${escapeHtml(property.name)}"></canvas>
        <figcaption>Scan to register a vehicle</figcaption>
      </figure>
    </section>
    <footer>
      ${property.policy_phone ? `<p>Questions: ${escapeHtml(property.policy_phone)}</p>` : ''}
      <p class="qr-sheet-code">${escapeHtml(property.qr_code_id)}</p>
    </footer>
    <button type="button" class="qr-sheet-print">Print</button>
  `;
  root.querySelector('.qr-sheet-print').addEventListener('click', () => window.print());

  // 1024px at error-correction H: this gets printed, photocopied, and then
  // rained on. The dashboard's on-screen tiles use 320/'M'.
  const opts = { width: 1024, margin: 2, errorCorrectionLevel: 'H',
                 color: { dark: '#000000', light: '#ffffff' } };
  const origin = window.location.origin;
  QRCode.toCanvas(document.getElementById('qrPass'),
                  `${origin}/temp/${property.qr_code_id}`, opts, e => e && fail('QR unavailable'));
  QRCode.toCanvas(document.getElementById('qrRegister'),
                  `${origin}/perm/${property.qr_code_id}`, opts, e => e && fail('QR unavailable'));
}

main();
```

Reuse `escapeHtml` from wherever `visit.js` gets it rather than writing a second copy — eleven copies of the plate normaliser is the cautionary tale this repo already has.

- [ ] **Step 4: Wire it into the build**

`frontend/scripts/build.mjs`, two edits:

```js
  entryPoints: [
    path.join(ROOT, 'src/dashboard.jsx'),
    path.join(ROOT, 'src/visit.js'),
    path.join(ROOT, 'src/resident.js'),
    path.join(ROOT, 'src/apt.js'),
    path.join(ROOT, 'src/qr-sheet.js'),
  ],
```

and add `'qr-sheet.html', 'qr-sheet.js'` to the "assert the deploy is not silently empty" list. Everything at the repo root is copied into `dist/` by default, so `qr-sheet.html` ships with no further change — but the assert is what catches an entry point that silently stopped emitting.

**No `vercel.json` change.** The URL is the file: `/qr-sheet.html?property=<id>`. A prettier `/qr-sheet` rewrite is one line in `vercel.json` if Gabe wants it later; it is not needed for the link to work and this plan does not add rewrites it does not need.

- [ ] **Step 5: Print CSS**

In the stylesheet, one block. Every rule here exists because of paper:

```css
@media print {
  .qr-sheet-print { display: none !important; }
  #sheet { color: #000; background: #fff; }
  #sheet section { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5in; }
  #sheet canvas { width: 3.25in; height: 3.25in; }
  /* A sheet that prints its second code on a second page is a sheet someone
     posts half of. */
  #sheet figure { break-inside: avoid; }
  @page { size: letter portrait; margin: 0.5in; }
}
```

- [ ] **Step 6: Test**

`tests/e2e/qr-sheet.spec.ts`, self-serving via `fixtures/buildAndServeFrontend.ts` (so it runs in the credential-free `e2e (local dist)` job, like `pay2park-visit.spec.ts` and `hq.spec.ts`). Stub `GET /admin/sites/*` with `page.route`:

1. **The page is reachable by URL.** `goto('/qr-sheet.html?property=<uuid>')` renders the site name — the assertion that the whole standalone-page decision exists for. *An `/app/qr-sheet` version of this test would have failed, and that is D7.*
2. Both canvases render with non-zero dimensions. *A blank QR tile is exactly the bug FE-4 was, and it shipped silently because nothing asserted on the canvas.*
3. The codes encode `/temp/<qr>` and `/perm/<qr>` — assert on the arguments `QRCode.toCanvas` was called with, via a page-level spy installed in an `addInitScript`. No new dependency.
4. `page.emulateMedia({ media: 'print' })` → the Print button is hidden and both `<figure>`s are in the viewport.
5. A stubbed 401 renders "Sign in at /app first", not a blank page.
6. A property with a null `qr_code_id` renders the "re-run onboarding" message rather than two empty boxes.
7. `npm run check:naming` passes on the new copy.

- [ ] **Step 7: Commit**

```
feat(frontend): a printable QR sheet, as its own entry page

Standalone, not a dashboard tab: App.jsx takes its current tab from
localStorage and never reads window.location.pathname, and line 178 coerces
anything unknown back to 'lots' -- so an /app/qr-sheet link would open on
whatever tab the admin last used. This page is only ever reached by a link, so
it follows visit.html / resident.html / apt.html instead: own shell, own
esbuild entry, no React.

Frontend rather than a backend PDF: qrcode@1.5.4 is already bundled (Wave 2.6
moved it off the CDN because a CDN 404 blanked the dashboard's QR tiles), and
the alternative is a new Python dependency in the production image for a page
an admin prints once per site.

1024px at error-correction H, because this gets printed, photocopied and rained
on. The e2e spec asserts the page is reachable by URL and that the canvases
actually rendered -- a blank QR tile is precisely how FE-4 shipped unnoticed.
```

---

### Task 15: One onboarding screen; the direct-Supabase property insert is retired

**Files:**
- Modify: `frontend/src/pages/AdminConsolePage.jsx` (the Onboard tab becomes the checklist form)
- Modify: `frontend/src/pages/ALPRPropertiesPage.jsx` (the inline add-property form)
- Modify: `frontend/src/lib/db.js` (`createProperty` deleted)
- Test: `tests/e2e/site-onboarding.spec.ts` (new, self-serving); `tests/e2e/access-control.spec.ts` green unchanged

**Interfaces:**
- Consumes: `POST /admin/sites`, `POST /admin/sites/{id}/policy-image`, `/qr-sheet.html`.
- Produces: no client-side `qr_code_id` minting anywhere in the repo.

- [ ] **Step 1: The Onboard tab becomes the checklist**

`AdminOnboardTab` today posts `{property:{name,address,property_type}, owner, partner, existing_partner_id}`. Rebuild it as five labelled groups mirroring `SiteOnboardRequest` — Site, Organization, Enforcement, Logins (a repeatable row: email, name, role), Settings — posting to `POST /admin/sites`.

The result panel replaces today's two setup links with:
- one setup link per login, each with the existing `AdminSetupLink` copy-button component (reuse it, do not re-style it);
- the two QR URLs;
- **Open the printable QR sheet** → the response's own `qr.sheet_url` (`/qr-sheet.html?property=<id>`), rendered as `<a target="_blank" rel="noopener">`. Use the value the server returned rather than rebuilding the URL in the browser — the server owns that shape, and rebuilding it is how the browser ended up minting `qr_code_id` in the first place;
- a **policy image** file input that immediately `POST`s to `/admin/sites/{id}/policy-image` and ticks `checklist.policy_image_uploaded`;
- the remaining `checklist` items as an unticked list.

**Naming rule:** the two QR links are labelled "Parking pass form" and "Vehicle registration form". Not "Temporary"/"Permanent", not "Visitor"/"Resident". `npm run check:naming` is the gate.

- [ ] **Step 2: `ALPRPropertiesPage`'s inline form**

That form calls `db.createProperty`, which inserts into Supabase directly and mints the QR id in the browser. Two changes:
- For a platform admin, the form posts to `POST /admin/sites` (with the org taken from the current property list's org, and no logins — the admin is adding a site to an org that already has them).
- For everyone else, **remove the form**. A non-admin using it could only ever produce a property with no accounts and a browser-minted QR id; there is no version of that which is not a support ticket. Replace it with one line: *"Ask your LotLogic rep to add a site."*

Then delete `db.createProperty` entirely. `db.updateProperty` and `db.deleteProperty` stay — editing an existing site through Supabase under RLS is a different thing and not this plan's to change.

- [ ] **Step 3: Tests**

`tests/e2e/site-onboarding.spec.ts` (self-serving, credential-free — stub the two API calls with `page.route`):
1. Submitting with an empty site name does not fire the request (client-side required fields).
2. A successful response renders one setup link per login, both QR URLs, and a QR-sheet link whose href is exactly the `qr.sheet_url` the stubbed response returned (`/qr-sheet.html?property=<id>`), opened in a new tab.
3. Adding and removing a login row keeps the roles in sync with what is posted.
4. The policy-image input posts multipart to `/admin/sites/{id}/policy-image` and ticks the checklist item.
5. A 422 from `extra="forbid"` renders the field-level message rather than a bare "failed".
6. **Grep assertion:** no file under `frontend/src/` contains `.from('properties').insert` — the browser no longer creates properties.

`tests/e2e/access-control.spec.ts` must stay green **unchanged**: it is the canonical cross-tenant proof and this task must not move it.

- [ ] **Step 4: Commit**

```
feat(dashboard): one onboarding screen, and the browser stops creating properties

The Onboard tab becomes the checklist SiteOnboardRequest describes -- site,
organization, enforcement, named logins, settings -- and its result panel hands
back a setup link per person, both QR URLs, the printable sheet and what is
still outstanding, including the policy image it uploads in place.

db.createProperty is deleted. It inserted into Supabase directly and minted the
qr_code_id IN THE BROWSER, so two admins in two tabs produced two properties and
one printed sign pointing at whichever won. The non-admin version of that form is
removed outright: it could only ever produce a property with no accounts.
```

---

### Task 16: PLATFORM-11 — `docs/runbooks/new-site.md`, generated from the schema

**Files:**
- Create: `scripts/gen_new_site_runbook.py`, `docs/runbooks/new-site.md`
- Test: `tests/test_new_site_runbook.py`

**Interfaces:**
- Consumes: `routers.admin.SiteOnboardRequest` (its JSON schema, field descriptions and defaults).
- Produces: a committed runbook that **cannot drift**, because a test regenerates it and diffs.

The finding is *"no customer-facing documentation and no repeatable new-site runbook"*. A hand-written runbook next to a changing schema is the same problem as `supabase-schema.sql` (fat decision 11): a document that describes a system that no longer exists. Generate it.

- [ ] **Step 1: The generator**

```python
"""scripts/gen_new_site_runbook.py — docs/runbooks/new-site.md, from the schema.

The request schema IS the checklist (Wave 2.3). A hand-maintained runbook beside
it drifts the same way supabase-schema.sql did, so this renders one from
SiteOnboardRequest.model_json_schema() and tests/test_new_site_runbook.py fails
when the committed file and a fresh render disagree.

Prose that is not derivable from the schema -- what to do before the POST, what
to do after it, how to hand a setup link to a customer -- lives in the PREAMBLE
and EPILOGUE constants below. Edit those; never edit the generated middle.
"""
```

Render: a title and the one-line "how to run this" (a `curl` against `POST /admin/sites`, and where the screen is in the dashboard), then `PREAMBLE`, then per top-level group a table of `field · type · required · default · what it means` taken from the schema's `description`/`title`/`default`, then `EPILOGUE` (setup links are one-time and expire after `PASSWORD_RESET_TTL_HOURS`; print the QR sheet; register the cameras; upload the policy image; how to verify by scanning the printed code yourself).

Every `Field(...)` in Task 13's schema needs a `description=` for this to be worth reading — **adding those descriptions is part of this task**, and they are also what the dashboard form's helper text should say.

- [ ] **Step 2: The drift test**

`tests/test_new_site_runbook.py`:

```python
def test_the_committed_runbook_matches_the_schema():
    from scripts.gen_new_site_runbook import render
    committed = (REPO / "docs" / "runbooks" / "new-site.md").read_text()
    assert committed == render(), (
        "docs/runbooks/new-site.md is stale. Regenerate it:\n"
        "    python scripts/gen_new_site_runbook.py > docs/runbooks/new-site.md\n"
        "A runbook that describes a schema the code no longer has is worse than "
        "no runbook -- that is what supabase-schema.sql became."
    )


def test_every_request_field_is_documented():
    from routers.admin import SiteOnboardRequest
    missing = _fields_without_a_description(SiteOnboardRequest)
    assert not missing, f"these onboarding fields have no description: {missing}"
```

- [ ] **Step 3: Commit**

```
docs: a new-site runbook generated from the onboarding schema (PLATFORM-11)

Hand-written documentation beside a changing schema drifts -- that is what
supabase-schema.sql became, a 529-line file describing tables that do not exist.
docs/runbooks/new-site.md renders from SiteOnboardRequest, and a test fails when
the committed file and a fresh render disagree.

Every field gained a description, which is also the dashboard form's helper text.
```

---

### Task 17: Cutover — apply to production, regenerate the schema artifacts, verify

**Files:**
- Modify: `scripts/db/expected_schema.sql`, `scripts/db/expected_census.txt`, `docs/db/schema.md` (all three, regenerated together, never by hand)
- Modify: `CLAUDE.md` in both repos — the tenancy section

**Depends on:** every other task.

**This task is a human at the keyboard.** It applies migrations to the live database and regenerates committed files from it. Do not delegate any step below to an unattended agent.

- [ ] **Step 1: Apply the six migrations to production, in order**

```
20260914140000_tenancy_organizations_users_memberships
20260914140100_tenancy_backfill_from_legacy_accounts
20260914140200_admin_audit_log
20260914140300_auth_login_attempts
20260914140400_integrations_organization_id
20260914140500_properties_policy_image_url
```

via the Supabase MCP `apply_migration` (one call each, the file's contents verbatim). Between 140000 and 140100, confirm the three tables exist and are empty. After 140100, confirm the expected counts:

```sql
SELECT (SELECT count(*) FROM organizations) AS orgs,          -- expect 10
       (SELECT count(*) FROM users) AS users,                 -- expect <= 10
       (SELECT count(*) FROM memberships) AS memberships,
       (SELECT count(*) FROM properties WHERE organization_id IS NULL) AS orphan_props;
```

`orphan_props` must be **0**. It cannot be anything else — the migration's `DO $backfill$` block raises — but read it anyway; that is what a verified fact is.

- [ ] **Step 2: Regenerate all three derived artifacts, together**

```bash
unset PGUSER PGPASSWORD PGHOST PGPORT PGDATABASE
eval "$(supabase db dump --linked --dry-run 2>/dev/null | grep '^export PG')"
cd /Users/gabe/lotlogic-backend-tenancy
scripts/db/regen_expected.sh \
  "postgresql://${PGUSER}:${PGPASSWORD}@${PGHOST}:${PGPORT}/${PGDATABASE}?options=-c%20role%3Dpostgres"
git diff -- scripts/db/expected_schema.sql scripts/db/expected_census.txt docs/db/schema.md
```

Review the diff before committing. It must contain **only** the six migrations' objects: three tables plus `admin_audit_log` and `auth_login_attempts`, their indexes, three new columns, one column-level grant. Anything else in that diff is drift this plan did not cause and needs its own explanation before you commit it.

**Wave 2.4 merged to backend `main` on 2026-09-14 (`07f111d`, PR #84)**, so `scripts/db/regen_expected.sh` and the `schema-rebuild` CI job are on `main` and this step runs on this branch, as written. Gabe decision D10 is answered by that merge; nothing here is blocked on it.

- [ ] **Step 3: Deploy order**

Backend first, then frontend. The backend is backward compatible with the deployed dashboard (Task 13 keeps `POST /admin/clients`; Task 9 adds keys to `/auth/me` and removes none; Task 7's `resolve_violation` still honours a client-sent `gross_revenue`). The frontend is **not** backward compatible with the old backend — Task 15's form posts to a route that does not exist until the backend ships.

- [ ] **Step 4: Post-deploy verification — the acceptance test**

1. **Every existing login still works.** Sign in as the platform admin, as a partner, and as one apartment owner. Each lands on the same dashboard with the same properties. *If any of the three fails, roll back the frontend and stop — every later check assumes this one.*
2. **The new claims are there.** Decode the admin's token (`jwt.io` offline, or `python -c` locally): `owner_id` unchanged, plus `user_id`, `org_ids`, `org_role`.
3. **RLS still answers.** With that token, the dashboard's property list loads through Supabase — that is `properties_authenticated_select` resolving `current_owner_id()` from the claim, i.e. the whole backward-compatibility argument, proven live.
4. **A second login into one org.** `POST /admin/sites` against the nine-property N Style org with one extra `logins` entry at role `staff`. Open the setup link in a private window, set a password, sign in. That login must see the same nine sites — **this is the thing this wave was for**, and it has never been possible before.
5. **The route walk is green in CI** on the merge commit, and `schema-rebuild` is green.
6. **Onboard a real site end to end.** A throwaway site through the new screen: setup links arrive, the QR sheet prints, `/temp/<qr>` opens the pass form on a phone, the policy image renders. Then delete it (`DELETE FROM properties WHERE qr_code_id = '<throwaway>'`) and confirm the org, users and memberships cascade or are cleaned up by hand.
7. **An audit row exists for a real action.** Resolve one violation from the dashboard and `SELECT * FROM admin_audit_log ORDER BY id DESC LIMIT 1` — actor, property, and the fee in cents, computed by the server.
8. **The throttle fires.** Eleven bad passwords against a test account → `429`, then wait out `LOGIN_LOCKOUT_MINUTES` and confirm it clears. *An alert path nobody has watched fire is an alert path that does not work*; the same is true of a lockout.
9. **Money path untouched.** `tests/plaza/` green in CI, and one live `GET /plaza/payments/{id}/status` still answering.

- [ ] **Step 5: Update `CLAUDE.md` in both repos**

The backend's "Auth & Property Access Control" section and the frontend's "Security Notes" both describe the pre-2.2 model. Replace the "How a request is scoped" list with the org/user/membership version, and add the two rules a future session most needs:

> **The RLS identity is the ORGANISATION's legacy id, not the user's.** `issue_token` is called with the org's `legacy_owner_id` / `legacy_partner_id` so a login created after Wave 2.2 — which has no `lot_owners` row of its own — still satisfies `properties_authenticated_select`. Do not "clean this up" by passing `users.id`; every RLS policy in production resolves `current_owner_id()`.
>
> **There is one property scope helper: `services/tenancy.py`.** `routers/visitor_passes._assert_property_scope` is a frozen alias over it (`plaza_payments.py` imports that path and is on the never-edit list). `tests/test_one_ownership_helper.py` fails the build on a fifth copy, and `tests/test_route_guards.py` fails it on an unguarded route.

- [ ] **Step 6: Commit**

```
chore(tenancy): apply Wave 2.2/2.3 to production and regenerate the schema record

Six additive migrations applied; expected_schema.sql, expected_census.txt and
docs/db/schema.md regenerated together from the migrated database.

Verified live: all three login shapes still work; the JWT still carries the
legacy owner_id that every RLS policy resolves; and -- for the first time -- a
second named login inside one organization sees that organization's nine sites.
```

---

## Decisions for Gabe

Ten. Each is one yes/no. **Every one has a default, so execution proceeds if you do not answer** — the defaults are what the tasks above already assume.

---

**D1 · What an extra login can do by default**

Right now an account *is* a company: the Stevensons login and the nine-site N Style login each have total power over everything they touch, because there is nothing else they could have. This wave adds roles — `admin`, `manager`, `staff`, `viewer` — stored on the membership. The question is where a *second* login lands when you add one to an existing office. `manager` means: see the sites, register and cancel parking passes, work the log and the violation queue — but **not** change the tow fees or the revenue split, and **not** add more logins. `admin` means everything, including those two.

**Should a new login added to an existing organization default to `manager` — day-to-day power, but no fee changes and no adding more logins?** *(Default if unanswered: yes, `manager`. The onboarding form still lets you pick `admin` per person.)*

---

**D2 · One login, one company**

A `users` row carries `default_organization_id`, and the JWT it gets is scoped to that one organization. So a person who genuinely works for two customers — a regional manager over two apartment groups, say — needs two email addresses today. Building the alternative means an organization switcher in the dashboard and a "which org is this request for" parameter on every scoped route, which is a wave of its own.

**Is it fine that one login belongs to exactly one company for now, with an organization switcher left to Wave 3?** *(Default if unanswered: yes. The data model already supports multiple memberships; only the token and the UI assume one.)*

---

**D3 · The nine N Style sites become one organization**

Production has one `lot_owners` row — "Stevensons Apartments (Friedlam)" — that owns nine of the eleven properties and **has never had a password set**. The backfill turns that row into one organization with nine sites under it, which is exactly the "all nine N Style sites is a query" the program doc asks for. The alternative is nine organizations, one per site, which would mean nine separate logins for one leasing company.

**Should those nine sites sit under one organization?** *(Default if unanswered: yes. Splitting later is an `UPDATE properties SET organization_id`; merging later is harder.)*

---

**D4 · Frank's App tab disappears at cutover**

The App tab in the partner dashboard is gated today on one customer's UUID pasted into shipped code (`NMLD_PARTNER_ID`). This wave replaces that with a row: the tab shows when the partner enforces a property with `properties.app_enabled = true`. Verified today, `app_enabled` is **false on all eleven properties** — Wave 1 item 13 turned the plaza's off because the reservation app, with Stripe unconfigured, confirms a booking for $0 and writes a real parking pass. So on the day this deploys, Frank's App tab goes away. Turning it back on is one `UPDATE`, but that `UPDATE` also re-opens the free-parking path.

**Should the App tab stay hidden until the reservation app is actually finished, rather than flipping `app_enabled = true` at cutover to keep it visible?** *(Default if unanswered: yes, hidden. It is the same switch fat decision 9 asks you to leave off.)*

---

**D5 · You gain access you did not have**

Two endpoints — cancelling a permanent parking pass, and the registered-passes list on a property — checked "is this the service key?" rather than "is this the service key *or* a platform admin?". So your own admin login gets a 403 from those two today while getting a pass from every neighbouring endpoint. The one helper fixes that, which means your login can now cancel a parking pass on any property.

**OK for a platform-admin login to be able to cancel a parking pass and read the registered list on any property, the way it already can everywhere else?** *(Default if unanswered: yes. The inconsistency is the bug; the service key could always do this.)*

---

**D6 · What counts as "the partner's property"**

The database's own rule says a partner can see a property when `partner_id` **or** `tow_company_id` points at them, and the dashboard's client-side filter says the same. The backend helper checked only `tow_company_id`. Verified today those two columns are **equal on all eleven rows**, so aligning them changes nothing right now — it changes what happens the first time a site has one company dispatching and another on the paperwork.

**Should the backend match the database's rule — a partner sees a property when either column names them?** *(Default if unanswered: yes. Three rules for one question is how BACKEND-6 happened.)*

---

**D7 · How hard to lock a login out**

There is no limit on failed sign-ins today — an attacker can try passwords against `ops@…` forever. This adds: ten failures inside fifteen minutes locks the address for fifteen minutes, and the limiter behaves identically for an email that does not exist (so it cannot be used to find out which addresses are real). Ten is chosen for a real person on a phone in a parking lot who is unsure which of two passwords this is, not for a bank.

**Is ten failed sign-ins in fifteen minutes, then a fifteen-minute lockout, right?** *(Default if unanswered: yes. All three numbers are env vars — `LOGIN_MAX_ATTEMPTS`, `LOGIN_ATTEMPT_WINDOW_MINUTES`, `LOGIN_LOCKOUT_MINUTES` — changeable without a deploy.)*

---

**D8 · How long the audit trail is kept**

`admin_audit_log` records who resolved which tow, for how much, and who changed a fee. It is small — a few thousand rows a year — and it is the evidence behind a weekly invoice if a partner ever disputes one. Wave 2.5 is about to put deletion rules on everything in the database, and this table is on the list by default.

**Should `admin_audit_log` be exempt from Wave 2.5's retention sweep and kept indefinitely?** *(Default if unanswered: yes, keep it. It is tiny, and the one thing you would want during a billing dispute.)*

---

**D9 · Removing a form from the Lots page**

The Lots page has an "add property" form that any owner or partner login can use. It writes straight to the database from the browser, invents the QR code id in the browser, and creates no accounts — so a property made with it is half-built by construction. This wave removes it for everyone except a platform admin, who gets the real onboarding form instead. A customer who clicks where it used to be sees one line: *"Ask your LotLogic rep to add a site."*

**OK to remove the add-property form for non-admin logins?** *(Default if unanswered: yes. Nobody but you has ever used it, and what it produces needs hand-repair either way.)*

---

**D10 · Non-admin logins in the LotLogic organization**

*(The original D10 — "should Wave 2.4 merge first?" — answered itself: 2.4 merged to backend `main` on 2026-09-14 as PR #84, so this wave's six migrations land under the runner and the drift check from day one. This is the question that replaced it, and it is the one real security consequence of the design.)*

`public.is_platform_admin()` is the database's own answer to "is this session an administrator", and today it works by looking up the JWT's `owner_id` in `lot_owners`. This wave issues the **organization's** legacy id as that claim, so every login in an organization would get the same answer — meaning a `viewer` added to the LotLogic organization would inherit administrator rights **inside the database**, where the API's own role check cannot see it. Task 1 fixes that by making the function read the signed-in person's own flag when the token carries one, falling back to today's behaviour for tokens issued before this wave. It is the only statement in the wave that changes something that already exists.

**Should that function change ship as part of this wave, rather than being deferred?** *(Default if unanswered: yes, ship it in Task 1. Deferring it means a window in which adding a front-desk login to the LotLogic organization silently hands out database-level admin.)*

---

## Self-review

**Finding coverage.** Every finding merged into 2.2 and 2.3 has a task or a written exclusion:
`PLATFORM-8` → Tasks 1, 2, 9, 13. `DB-13` → Tasks 1, 2, with scope call 1 stating plainly that the three identity tables become two-plus-one in this wave and not one. `BACKEND-6` → Tasks 3, 4, plus `tests/test_one_ownership_helper.py`, which is what stops a fifth copy. `SEC-4` → Task 8. `SEC-6` → Task 11 (org half; the gate and the ordering landed already — verified on `main`). `SEC-8` → Tasks 6, 7, with scope call 4 recording that the finding understated it: the browser wrote to a table that does not exist and also computed the money. `SEC-12` → already closed on `main`; Task 5 is what makes the closure permanent, which is what the 2.2 row actually asks for. `FE-16` → Task 10, with the replacement being a row and not a constant. `PLATFORM-1` → Task 13, including the `POST /admin/clients` alias so the fix reaches callers on a cached bundle. `PLATFORM-11` → Task 16, generated rather than hand-written.

**The 2.2 row's four literal asks.** `organizations` + `properties.organization_id` → Task 1. `users` + `memberships(user_id, org_id, role)` → Task 1. "Collapse the four disagreeing copies into one helper" → Tasks 3 and 4, and the four copies are named individually with what each got wrong. "A test that walks every route and fails the build if a new endpoint has no guard and no explicit public-list entry" → Task 5, with a test-for-the-test that proves the walker can fail.

**The 2.3 row's literal asks.** "Writes every column" → Task 13 Step 2's insert, asserted field-by-field against the request rather than by count. "Mints the QR ids" → `mint_qr_code_id`, server-side, against the `UNIQUE` constraint, with the collision path tested. "Uploads the policy image" → Task 12. "Returns setup links and a printable QR sheet" → Task 13 Step 3 and Task 14. "The request schema *becomes* the new-site checklist" → Task 16 makes that literally true by generating the runbook from it and failing CI on drift.

**Backward compatibility, traced end to end.** Task 2 backfills before Task 9 reads. Task 9 resolves `users` **only when a password hash is present**, so the one passwordless production account keeps its exact current behaviour, error message included. The JWT's `owner_id` comes from the **organization's** legacy link, so a login created tomorrow satisfies `properties_authenticated_select` with no RLS change — Task 17 step 3 proves that live rather than assuming it. `/auth/me` gains keys and loses none (`App.jsx` merges it into a persisted session). `POST /admin/clients` survives as an alias. `resolve_violation` still honours a client-sent `gross_revenue`. No route path changes anywhere. Every migration is `IF NOT EXISTS` / `WHERE NOT EXISTS` / `WHERE col IS NULL`, which is also what CI's "runner is idempotent" step requires.

**Type consistency.** `assert_property_access(db, subject, property_id, *, allow_partner, need)` has one signature and one 404 message at every call site (Tasks 4, 7, 12, 13). `allowed_property_ids` returns `None`-means-unrestricted, matching `services/scope.allowed_lot_ids` exactly so the two can be read interchangeably. `audit.record(db, subject, action, **kw)` never commits, in all six call sites. `Role` values match the `memberships.role` CHECK. Every money field this plan adds ends in `_cents`.

**What the pre-flight caught, and where it is now closed.** Recorded so a reviewer can check the fix rather than re-derive the defect:
`violations.gross_revenue` holds **cents**, not dollars — Task 7 Step 1 now copies `partner.{boot,tow}_fee_cents` straight across with no conversion, and its test asserts 35000/8750/26250 (an earlier draft would have re-created DB-7, the 100× under-report, in the same file that exists to fix it).
An FK from `organizations` to `enforcement_partners` would have let the harness's per-test `TRUNCATE … CASCADE` reach the session-scoped plaza seed — Task 1 drops both legacy FKs for plain uuids plus partial uniques, and `organizations` is barred from `TRUNCATE_TABLES` with the reason inline.
`upload_bytes` is `(data, key, content_type) -> (key, url)` — Task 12 takes the URL from the return value instead of rebuilding it.
Executing a migration file through SQLAlchemy cannot work (one prepared statement, no dollar-quoted blocks) — Task 2 goes through the raw asyncpg connection the harness already uses for exactly this.
`HANDLER_VERIFIED` was dead code because `PUBLIC_PATHS` shadowed it — Task 5 checks it first and adds a test that every public API path carries a written reason.
`/app/qr-sheet` was unreachable because `App.jsx` routes from `localStorage` and coerces unknown tabs — Task 14 is a standalone `qr-sheet.html` entry page, and its first e2e assertion is that the URL opens it.
`resolve_violation` did not re-arm the zone the browser re-armed — Task 7 Step 2 moves that logic server-side, into both resolve routes, with the test that proves a dismissal frees the space and a tow does not.
The OAuth callback has no `Subject` to stamp — Task 11 carries the org id in the single-use state token and writes the audit row from `/oauth/start`, where a named human exists.
`/auth/me` had no `default` in scope — Task 9 Step 3 resolves the org in that handler, with a regression test on **both** legacy branches.
And the one the pre-flight surfaced as a note rather than a defect, now scope call 12: issuing the organization's legacy id as `owner_id` would have given every login in a platform-admin org **database-level** admin through `is_platform_admin()`. Task 1 redefines that function. It is the only existing object this wave changes, and it is Gabe decision D10.

**Known sharp edges, flagged rather than smoothed:**
- **Task 9 is the one task that can lock a customer out.** Its acceptance criterion is three real logins in step 4 of Task 17, in a private window, before the frontend deploys. If the `legacy_id is None` guard ever fires for a real customer, the data is wrong and the 403 is the correct outcome — a token that satisfies no RLS policy renders an empty dashboard with no error, which is much worse.
- **Task 4 touches QuickBooks.** Its criterion is `tests/test_quickbooks_*.py` **unchanged** and green. If either file needs an edit, the substitution changed invoicing behaviour and is wrong.
- **Task 7 changes how the dashboard resolves a violation** — from a direct PostgREST write to a backend call. The old path bypassed the backend's invoiced-at guard entirely, so some resolves that "worked" before will now correctly 409. Expect that, and do not add an override.
- **Task 12's column-level `GRANT` may move CI's object census.** That is not a failure; it is the drift check doing its job, and Task 17 step 2 is where it is resolved — by regenerating from production, never by editing the committed file.
- **`tests/plaza/schema/live_schema.sql` is already stale against production** (it has no `pay_to_park_enabled`). Task 1 adds `lot_owners` to it; it does not undertake to re-sync the whole file, and a test that depends on a column the subset lacks will fail confusingly. Add the column you need to that file in the task that needs it.
- **Adding `lot_owners` to the harness schema forces it off `PRODUCTION_CANARY_TABLES`.** That check runs *before* the `DROP SCHEMA`, so a table the harness creates itself would make a persistent `TEST_DATABASE_URL` refuse to start on the second session. CI (a fresh container per run) would never have shown it. `alpr_violations` and `pending_invoices` remain, and both are still production-only. Run `tests/plaza/` twice in a row against a persistent database as the acceptance check for Task 1.
- **Task 7 now edits two routes, not one.** `resolve_violation` and `record_violation_action` must end up with byte-identical fee arithmetic and byte-identical zone re-arm. If they drift, one tow books two different numbers depending on which route the dashboard called — the same failure mode as four ownership helpers, in the money path.
- **Two tables hold one password during the rollout** (Task 9 step 4). Deliberate, commented in the code, and it ends when Wave 3 collapses the identity tables. A reset that updates one and not the other is the failure mode; the mirroring is what prevents it, and it needs a test on both directions.
