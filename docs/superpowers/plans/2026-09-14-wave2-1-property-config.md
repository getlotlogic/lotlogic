# Wave 2.1 — Property Configuration as Data

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every number, window, threshold, recipient and timezone that should differ between one site and the next stops being a Python constant, a PL/pgSQL literal, a `CHECK` bound or a global Railway/Supabase environment variable, and becomes one row-scoped `properties.config` JSONB document read through one typed loader. A property whose `config` is `NULL` behaves **exactly** as it does today, because the loader's defaults *are* today's constants. The immediate payoff: the monthly parking pass — built, priced at `app_rates.monthly_pass = 15000`, and refused by a trigger that hardcodes `hours > 48.5` — becomes sellable by writing a row, not by shipping a deploy.

**Architecture:** One additive column (`properties.config jsonb`), one pydantic model (`services/property_config.py::PropertyConfig`) whose field defaults are copied verbatim from the constants they replace, and one SQL function (`public.property_config(uuid)`) that merges the same defaults with the row in Postgres so triggers and edge functions get the *same answer* as Python without a round trip through the backend. Three readers, one source:

```
                    properties.config  (jsonb, NULL = "all defaults")
                              │
        ┌─────────────────────┼──────────────────────┐
        │                     │                      │
  load_property_config()  public.property_config()   GET /properties/{id}/config
  (Python, pydantic,      (SQL, SECURITY DEFINER,    (edge functions + dashboard,
   60 s TTL cache)         STABLE, defaults||row)     platform-admin write)
        │                     │                      │
   backend services      triggers + RLS-side       supabase/functions/*
                          policy checks
```

Each constant migrates **one at a time**, behind the loader, with a test that pins today's behaviour when `config` is absent. Nothing in this plan changes an observable outcome at Charlotte or at any N Style site on the day it lands; the behaviour change is opt-in, one JSON key at a time.

**How a property is read today — the measured list.** There is no loader and no cache: every caller writes its own `SELECT` against `public.properties`. Counted on `lotlogic-backend` `origin/main` @ `dc833b6` (`git grep -n "FROM public.properties" -- '*.py'`, test files excluded) and on `lotlogic` `origin/main`:

- **Eight single-column policy reads** — the ones this wave actually replaces: `routers/app_api.py:296` (`total_spaces`), `:356` (`app_rates`), `routers/public_registration.py:234` (`guest_auto_approve`), `:384` (`property_type`), `:570` (`property_type, tow_company_id`), `:680`, `services/apartment_notify.py:276` (`name`), `:317` (`name, reject_tow_disclaimer`).
- **Six ownership probes** (`SELECT 1 … WHERE id = :pid AND owner_id = …`) — `routers/lots.py:528`, `routers/resident_plates.py:40`, `routers/violations.py:840` and `:850`, `routers/visitor_passes.py:55` and `:65`. These are scope checks, not config reads; they stay exactly as they are.
- **Four joined/multi-column reads** — `routers/admin.py:79`, `routers/app_api.py:247`, `routers/plaza_payments.py:429` (never-edit), `services/apartment_notify.py:68`.
- **Two edge-function reads** — `supabase/functions/camera-snapshot/index.ts:273` (`select("property_type")`) and `camera-snapshot/sessions.ts:70` (`select("cooldown_hours")`). Task 14 replaces the second.

Eighteen backend call sites across nine files, plus two in Deno. That is the surface a loader collapses, and it is why the loader gets a 60-second TTL rather than none: the camera path already pays for one property read per event, and this must not become two.

**Tech Stack:** Python 3.11, FastAPI, SQLAlchemy 2 async + asyncpg, pydantic v2 / pydantic-settings, Supabase Postgres 17 behind a supavisor **SESSION-mode** pooler, pytest + pytest-asyncio (strict mode), ruff 0.16.5, Railway deploy from `main`, Supabase edge functions (Deno) + pg_cron, Vercel-hosted `frontend/src/**` built by `frontend/scripts/build.mjs` (Wave 2.6 landed — the dashboard is ES modules under `frontend/src/pages/`, no in-browser Babel).

**Spec:** `/Users/gabe/lotlogic/docs/superpowers/specs/2026-09-03-enterprise-readiness-program.md` — §3 Wave 2 item **2.1**; systemic move **S2**; Appendix A findings **BACKEND-17, DB-6, PIPE-7 (property half), PLATFORM-2, PLATFORM-4, PLATFORM-5, PLATFORM-15**.

**Depends on: Wave 2.4 (`wave2/schema-baseline`, branch currently 21 commits ahead of `origin/main`) being MERGED first.** This is a hard gate, not a preference — §3 of the program doc says so explicitly ("2.4 before 2.1 and 2.5 — you cannot safely add configuration columns … on a schema you cannot rebuild"), and three concrete things in this plan only exist after 2.4:

- `scripts/db/migrate.sh` and `migrations/0000_baseline.*` — every migration below is written to be applied by that runner and to be present in `supabase_migrations.schema_migrations`.
- the `schema-drift` CI job (`scripts/db/check_drift.py`) — which is what stops a `config`-reading trigger shipping ahead of the migration that defines the column.
- `scripts/db/regen_expected.sh` — every task that changes DDL must regenerate `scripts/db/expected_schema.sql`, `scripts/db/expected_census.txt` and `docs/db/schema.md` in the same commit, or `schema-rebuild` goes red.

Wave 2.1 also assumes **Wave 1** is in (green CI, request ids, Sentry) and takes **Wave 2.2** (organizations/RBAC) as a *successor*, not a prerequisite: the admin surface here is gated on today's `require_platform_admin`, and 2.2 re-points that gate at `memberships` without touching this plan's payload.

**Related, adjacent, NOT this wave:** 2.3 (one site-onboarding command) consumes the config schema as its request body — when 2.3 lands, `PropertyConfig` is what a new site is *created with*. 3.4 (per-site pipeline configuration and one matcher) owns `alpr_cameras.config` and the per-MAC environment maps; this plan builds the property half and the shape 3.4 nests into.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Never edit these files.** `routers/plaza_payments.py`, `services/plaza_settle.py`, `services/plaza_sweep.py`, `services/plaza_reconcile.py`, `services/square.py`, `services/stripe_plaza.py`. The Stripe cutover owns them, and `services/square.py::PRICE_CENTS` plus the `chk_plaza_payments_amount_matches_hours` CHECK are **Wave 3.6's** job, not this one (see Scope calls §1). `services/plaza_notify.py` is read-only here too, and that has a consequence Task 10 must respect: **`services/plaza_reconcile.py` and `services/tow_digest.py` do not own a timezone literal — they import `_LOT_TZ` from `services/plaza_notify.py:33`.** One of the two importers (`plaza_reconcile.py`) is on the never-edit list outright, and the owner (`plaza_notify.py`) is read-only, so the whole three-file chain is **deferred to the Stripe-cutover rebase** and is not Task 10's work (decision D11). Task 10 covers `routers/app_api.py`, `routers/quickbooks.py` and `services/apartment_notify.py` only; Task 15's census allowlist records the deferred chain by name so the drift guard does not go red on a literal nobody is allowed to touch.
- **A NULL `config` must change nothing.** This is the acceptance test for the entire wave. Every task ships a test asserting the pre-existing behaviour with `config IS NULL`, and only then a second test asserting the new behaviour with a config present. If a task cannot write the first test, the task is wrong.
- **Additive migrations only.** No column is dropped in this wave. `properties.cooldown_hours` stays and keeps working (Task 8 makes it the *fallback* the config reads, not a second source of truth). Deletions are a separate, later commit once every reader is proven to be on the loader.
- **`config` is never anon-readable and never client-writable.** `properties` today grants `anon` SELECT on exactly eight columns (`address, id, name, pay_to_park_enabled, policy_phone, policy_text, property_type, qr_code_id`) but grants `anon` and `authenticated` INSERT/UPDATE across **all** columns — so a column added without an explicit `REVOKE` inherits a write grant. `frontend/src/lib/db.js::updateProperty` writes `properties` straight through PostgREST with the user's JWT. Task 1's migration therefore `REVOKE`s `SELECT, INSERT, UPDATE (config)` from `anon` and `INSERT, UPDATE (config)` from `authenticated` in the same file that adds the column. Config writes go through the backend or they do not happen.
- **Secrets stay in env.** `config.py` `Settings` keeps every credential. What moves into `properties.config` is *policy*: numbers, windows, recipient lists, a timezone name. An API key never goes in a JSONB column that a platform admin can edit in a browser.
- **The user-facing naming rule applies** to anything that reaches a driver: **parking pass** is the only user-facing term. `frontend/scripts/check-naming.mjs` enforces it on the frontend; a policy string typed into a config editor is user-facing text, so Task 4's editor runs the same word list client-side before it will save.
- **PII discipline.** Nothing in a config document is a plate, a driver name or a phone number of a member of the public. Notice *recipient* addresses (staff, partner, owner) are in scope and are the one exception; they are never logged in full.
- **Ruff rule set unchanged.** `ruff.toml` stays `select = ["E4","E7","E9","F"]`, `ignore = ["E712","E701"]`.
- **Migrations (Wave 2.4 conventions).** `migrations/YYYYMMDDHHMMSS_snake_case_name.sql`, timestamp from `date -u +%Y%m%d%H%M%S`. The repo's `PreToolUse` hook (`.claude/hooks/migration-recorded-check.sh --pre`) blocks a write that does not match. Apply via the Supabase MCP `apply_migration` or `scripts/db/migrate.sh` — **never** the raw SQL editor, because only those two record the `supabase_migrations.schema_migrations` row that `schema-drift` compares against. A migration that needs `CREATE INDEX CONCURRENTLY` carries the marker `check_concurrently.sh` looks for. After any DDL: `scripts/db/regen_expected.sh "$PROD_DATABASE_URL"` and commit all three regenerated artifacts.
- **New DB tests go in `tests/plaza/`** (real Postgres 17: CI service container via `TEST_DATABASE_URL`, locally an `initdb` cluster, skipped if neither) and **every migration file this wave adds must be listed in `tests/plaza/conftest.py::MIGRATION_GLOBS`** — add `"20260914*.sql"` in Task 1 or the harness replays the live-schema extract without the new column and every DB test in this wave silently tests the old world. Pure-Python tests go in `tests/` and need their own `@pytest.mark.asyncio` (pytest-asyncio strict mode; `tests/plaza/` gets the marker automatically).
- **CI gate:** `ruff check .` → `python -m compileall -q -f .` → `pytest -x --tb=short -q` → `schema-rebuild` → `schema-drift`. All five before a task is done.
- **Commits:** one per task, conventional prefix. Append:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_012CxJpLkSpNFeXLVTrUfhWo
  ```
- **Do not push to `main` without asking.** Railway auto-deploys from `main`; there is no staging until Wave 3.3.

---

## File Structure

| File | Responsibility |
|---|---|
| `migrations/20260914*_properties_config.sql` **(new, T1)** | `properties.config jsonb`, `config_updated_at`, `config_updated_by`, the `jsonb_typeof = 'object'` CHECK, the grant revokes. |
| `migrations/20260914*_property_config_fn.sql` **(new, T5)** | `public.property_config_defaults()` + `public.property_config(uuid)` — the SQL half of the loader, SECURITY DEFINER + STABLE. |
| `services/property_config.py` **(new, T2)** | `PropertyConfig` (pydantic), `load_property_config()`, `invalidate_property_config()`, `DEFAULTS_JSON`. The one place a default lives in Python. |
| `routers/properties_config.py` **(new, T3)** | `GET/PUT /properties/{id}/config`, `GET /properties/config/schema`, `POST /properties/{id}/config/preview`. Platform-admin write, owner read. |
| `frontend/src/pages/admin/PropertyConfigEditor.jsx` **(new, T4)** | The editor. Rendered from `AdminConsolePage.jsx`; schema-driven, diff-against-defaults, naming-rule check before save. |
| `frontend/src/lib/propertyConfig.js` **(new, T4)** | `fetchPropertyConfig`, `savePropertyConfig`, `fetchConfigSchema` over `apiFetch` — never PostgREST. |
| `migrations/20260914*_stay_limit_from_config.sql` **(new, T6)** | `enforce_truck_plaza_stay_limit()` rewritten to read `property_config()`. The monthly-pass unblock. |
| `routers/app_api.py` *(modify, T7)* | `BOOKABLE_KINDS` becomes config-derived; `monthly` becomes quotable and bookable. |
| `migrations/20260914*_cooldown_from_config.sql` **(new, T8)** | `set_pass_cooldown_flag()` + `count_on_cooldown()` read `property_config()`; `properties.cooldown_hours` becomes the documented fallback. |
| `services/plate_matcher.py` *(modify, T9)* | Module constants become `PropertyConfig` field defaults; every call site takes the loaded config. |
| `services/lot_time.py` **(new, T10)** | `lot_tz(config)`, `lot_day_bounds(config, ymd)`, `fmt_local(config, dt)`. The one formatter. Three call sites collapse into it now (`app_api`, `quickbooks`, `apartment_notify`); the `plaza_notify._LOT_TZ` chain and the two dead weather jobs are deferred — Task 10's scope note. |
| `services/notices.py` **(new, T11)** | `resolve_recipients(config, …)` — the one place an override, an extra-recipient list and a disable flag are applied, and the one place a redirect is stamped. |
| `migrations/20260914*_notice_override_stamp.sql` **(new, T11)** | `outbound_notices.overridden_to text` — the column that makes a redirected send visible in the dashboard forever after. (`outbound_notices` itself already exists; Wave 2.7 Task 12 built it.) |
| `services/revenue.py` **(new, T12)** | `revenue_split(config, partner)` — per-property override on top of the partner default. |
| `services/tow_retention.py` *(modify, T13)* | `parse_overrides` keeps working; a new `camera_retention_days(config, api_key)` prefers `config.tow_evidence.cameras` and falls back to the env var. |
| `supabase/functions/_shared/propertyConfig.ts` **(new, T14)** | `getPropertyConfig(db, propertyId)` — one RPC, per-invocation memo. The edge half of the loader. |
| `supabase/functions/cron-sessions-sweep/index.ts` *(modify, T14)* | `COOLDOWN_HOURS`, `GRACE_EXPIRY_MINUTES`, `OVERSTAY_GRACE_MINUTES`, `EXIT_HINT_BUFFER_MINUTES`, `DISPATCH_HOLD_MINUTES`, `OVERSTAY_MAX_AGE_HOURS` read the shared config. |
| `supabase/functions/camera-snapshot/sessions.ts` *(modify, T14)* | `findCooldownPriorSession` reads the shared config instead of `select("cooldown_hours")`. |
| `supabase/functions/tow-dispatch-email/index.ts`, `tow-confirm/index.ts` *(modify, T14)* | `EMAIL_OVERRIDE_TO`, `OWNER_CC_EMAIL`, `FROM_EMAIL`, `DISPATCH_EMAILS_DISABLED`, `formatLocal(tz)` read the shared config. |
| `tests/test_property_config.py` **(new, T2)** | Defaults-are-today's-constants; NULL round-trips; unknown key rejected; cache TTL. |
| `tests/plaza/test_property_config_sql.py` **(new, T5)** | SQL defaults and Python defaults are the same document. The anti-drift test. |
| `tests/plaza/test_stay_limit_config.py` **(new, T6)** | 48.5 h still rejected with NULL config; 720 h accepted with a monthly config. |
| `tests/test_config_census.py` **(new, T15)** | The drift guard: a literal on the inventory list may not reappear outside `property_config.py`. |
| `docs/db/property-config.md` **(new, T15)** | The generated key reference: key → type → default → what reads it. |

---

## Scope calls — where the code contradicts the program doc

The doc merges seven findings into 2.1. Decisions, made here so no executor re-litigates them mid-task:

1. **The paid-parking price list (`services/square.py::PRICE_CENTS = {10:1500, 24:2500, 48:4000}` and `chk_plaza_payments_amount_matches_hours`) — OUT.** It reads like a per-property price and it is one, but Wave 3.6 owns it *explicitly* ("move the price list out of a table-wide CHECK constraint into the property row"), it is hard-gated on the Stripe cutover landing, and `services/square.py` is on the never-edit list. Touching it here means editing a money file with no staging. **The `PropertyConfig.pricing` section is defined in Task 2 with the right shape and left unread**, so 3.6 fills a slot rather than inventing one. `app_rates` (the NMLD reservation-app price table, a different product on the same property) **is** in scope, because the monthly pass lives there.
2. **Per-camera environment maps (`PR_MIN_SCORE_OVERRIDES`, `SKIP_SIDECAR_MACS`, `ROTATE_BEFORE_PROCESS`, `EXIT_MIN_DWELL_MINUTES`, `TRUCK_FUZZY_CANCEL_MIN`) — OUT, deliberately.** This is PIPE-7's *camera* half and the doc routes it to Wave 3.4 alongside `alpr_cameras.config`. What this wave does is **absorb the one per-camera override pattern that already shipped** — `TOW_FOOTAGE_RETENTION_OVERRIDES`, a `api_key:days,api_key:days` string parsed by `services/tow_retention.py` — into `config.tow_evidence.cameras{}` (Task 13). That proves the nesting shape 3.4 needs on a feature with two cameras and no enforcement consequence, instead of proving it on the tow path.
3. **`properties.policy_text` / `policy_phone` stay columns.** They are already anon-readable (the QR registration page reads them unauthenticated through `properties_public`), they are the legally-operative driver-facing copy, and moving them behind a config document that `anon` must not read would break `visit.html`. What moves into config is the *metadata*: `policy.require_ack`, `policy.version`, `policy.max_stay_note`. `frontend/src/shared/policy.js::DEFAULT_TRUCK_PLAZA_POLICY` (PLATFORM-4 — Charlotte's rules as the hardcoded default for every future plaza) stops being a runtime fallback and becomes a **seed template** offered by the Task 4 editor; a property with no `policy_text` renders nothing rather than silently inheriting Charlotte's rules. Recorded as decision **D5**.
4. **PLATFORM-5's Wave 1 half is already done.** §2 item 12 unset `EMAIL_OVERRIDE_TO` and added the start-up warning. What remains for 2.1 is the *structural* half: one global switch that replaces recipients at **every** site becomes `config.notices.override_to` per site, and a redirected send is stamped so the dashboard can show it forever after (Task 11).
5. **`revenue_share` stays on `enforcement_partners`; config adds an override.** The partner row is the contract default and `tests/test_partner_allowlist.py` already defends it from partner self-edit (SEC-5). A per-property `config.revenue.share_override` is additive and platform-admin-only, so the existing negative tests keep passing unchanged. Recorded as decision **D4**.
6. **Timezone: one column's worth of behaviour, spread over eleven places — but only five of them are Task 10's.** `PLATFORM-15`. Wave 1 item 8 already fixed the Parking Log symptom with `frontend/src/lib/lotdate.js::LOT_TIMEZONE`, whose own comment says *"Wave 2 replaces the constant with a `properties.timezone` column."* This plan puts it at `config.timezone` rather than a bare column, because it travels with every other site rule and because the SQL function makes it readable from a trigger. **In scope for Task 10:** `routers/app_api.py:66`, `routers/quickbooks.py:199`, `services/apartment_notify.py:327`, plus `lotdate.js` (which keeps `LOT_TIMEZONE` as its fallback and gains an optional argument) and the `markets.timezone` fallback underneath. **Deferred:** the single `_LOT_TZ` at `services/plaza_notify.py:33` and its two importers (`plaza_reconcile.py`, `tow_digest.py`) — `plaza_notify` is read-only this wave and `plaza_reconcile` is never-edit, so that chain moves on the Stripe-cutover rebase (decision D11). **Out permanently:** the two weather functions' `TZ` constants, both jobs being switched off and on fat decision 13's delete list.
7. **`enforcement_type`, `enforcement_hours`, `rules`, `monthly_fee`, `notes_migrated` — untouched.** Four of the 29 `properties` columns are read by nothing (verified: zero references in `routers/`, `services/`, `supabase/functions/`, `frontend/src/`), and `notes_migrated` is on fat decision 27's delete list. Migrating dead columns into a config document dignifies them. They are listed in the inventory as **drop candidates**, not as config keys.

---

## The inventory — every constant this wave is responsible for

`where it lives today` is a real file:line or object name, verified 2026-09-14 against **`lotlogic-backend` `origin/main` @ `dc833b6`** and **`lotlogic` `origin/main`** (the two refs pre-flight checked). `config key` is relative to the `properties.config` document root.

**One caveat on the numbers.** Wave 2.4 (`wave2/schema-baseline`), which this plan is gated on, shifts `models.py` down by nine lines — `revenue_share` is at 43/413 on `origin/main` and at 52/422 once 2.4 merges. Every other file cited here is byte-identical on both refs. **Grep the symbol, do not trust the line number**; the symbol is given in every row for exactly that reason.

### Stay caps and pass policy

| # | Constant / value | Where it lives today | Proposed config key |
|---|---|---|---|
| 1 | max stay `48.5` h (truck plaza) | `enforce_truck_plaza_stay_limit()` trigger body — `IF hours > 48.5 THEN RAISE` | `passes.max_stay_hours` (48) |
| 2 | min stay `0.5` h | same trigger — `IF hours < 0.5 THEN RAISE` | `passes.min_stay_minutes` (30) |
| 3 | second 48 h cap in Python | `routers/public_registration.py:407` `if body.stay_hours > 48` | `passes.max_stay_hours` |
| 4 | guest stay cap `72` h | `routers/public_registration.py:123, 196, 544` — `Field(..., ge=1, le=72)` ×2 + `if body.stay_hours > 72` | `passes.max_stay_hours` (apartment default 72) |
| 5 | policy-ack required | `enforce_truck_plaza_policy_ack()` trigger, gated on `property_type='truck_plaza'` | `policy.require_ack` (true for truck_plaza) |
| 6 | bookable durations `{h24, h48}` | `routers/app_api.py:73` `BOOKABLE_KINDS` + its comment naming the trigger as the blocker | `passes.bookable_durations` |
| 7 | monthly pass term (none) | does not exist — `duration_kind` CHECK allows `'monthly'`, nothing implements it | `passes.monthly_pass_days` (30) |
| 8 | `parking_registrations_max_stay` CHECK `expires_at <= registered_at + 48h` | `parking_registrations` table CHECK (legacy table, Wave 3.6 drops it) | *(none — legacy, recorded not migrated)* |

### Cooldown

| # | Constant / value | Where it lives today | Proposed config key |
|---|---|---|---|
| 9 | cooldown `interval '24 hours'` | `set_pass_cooldown_flag()` trigger body — **ignores `properties.cooldown_hours` entirely** (DB-6) | `cooldown.hours` |
| 10 | `properties.cooldown_hours` | column; `24` at Charlotte, `NULL` at all ten apartments | `cooldown.hours` (column becomes fallback) |
| 11 | `COOLDOWN_HOURS` env, default `24` | `supabase/functions/cron-sessions-sweep/index.ts:32` | `cooldown.hours` |
| 12 | `p_hours integer DEFAULT 24` | `count_on_cooldown(uuid, integer)` SQL function — the dashboard's "On Cooldown" tile calls it with no second arg | `cooldown.hours` |
| 13 | `_DEDUP_HOURS = 24` | `services/cooldown_notice.py:36` | `cooldown.notice_dedup_hours` |
| 14 | `interval '24 hours'` re-reg dedup | `services/reregistration_notice.py:136` | `cooldown.notice_dedup_hours` |
| 15 | 24-hour plate hold | `enforce_plate_hold()` trigger message + the `plate_holds.hold_until` writer | `cooldown.plate_hold_hours` |
| 16 | 2-minute "real park" floor | `supabase/functions/camera-snapshot/sessions.ts` — `exited_at - entered_at > 2 minutes` | `cooldown.min_park_minutes` |

### Grace windows and sweep timings

| # | Constant / value | Where it lives today | Proposed config key |
|---|---|---|---|
| 17 | `GRACE_MINUTES = 10` | `services/plate_matcher.py:63` | `grace.registration_minutes` |
| 18 | `GRACE_EXPIRY_MINUTES` env, default `15` | `supabase/functions/cron-sessions-sweep/index.ts:38` — **disagrees with #17** | `grace.registration_minutes` |
| 19 | `GRACE_MS = 15 * 60_000` | `supabase/functions/cron-no-reg-sweep/index.ts:13` — third copy | `grace.registration_minutes` |
| 20 | `OVERSTAY_GRACE_MINUTES` env, default `5` | `cron-sessions-sweep/index.ts:30` | `grace.overstay_minutes` |
| 21 | `EXIT_HINT_BUFFER_MINUTES` env, default `5` | `cron-sessions-sweep/index.ts:31` | `grace.exit_hint_buffer_minutes` |
| 22 | `DISPATCH_HOLD_MINUTES` env, default `5` | `cron-sessions-sweep/index.ts:394` | `grace.dispatch_hold_minutes` |
| 23 | `OVERSTAY_MAX_AGE_HOURS` env, default `6` | `cron-sessions-sweep/index.ts:402` | `grace.overstay_max_age_hours` |
| 24 | `SESSION_IDLE_MINUTES` env, default `3` | `camera-snapshot/index.ts:137` | `grace.session_idle_minutes` |

### Plate-confidence floors and match safety

| # | Constant / value | Where it lives today | Proposed config key |
|---|---|---|---|
| 25 | `PLATE_CONFIDENCE_MIN = 0.92` | `services/plate_matcher.py:59` (and a **stale third copy in the module docstring at :15, which says 0.85**) | `pipeline.plate_confidence_min` |
| 26 | `PR_MIN_SCORE` env, default `0.8` | `camera-snapshot/index.ts:35` — **disagrees with #25** | `pipeline.plate_confidence_min` |
| 27 | `CAMERA_SUSPEND_THRESHOLD = 0.70` | `services/plate_matcher.py:60` | `pipeline.camera_suspend_threshold` |
| 28 | `CAMERA_SUSPEND_MIN_EVENTS = 5`, `CAMERA_SUSPEND_DURATION_MIN = 30` | `services/plate_matcher.py:61-62` | `pipeline.camera_suspend_min_events`, `pipeline.camera_suspend_minutes` |
| 29 | `MIN_CONFIRMING_EVENTS = 2`, `CONFIRM_WINDOW_MIN = 5` | `services/plate_matcher.py:64-65` | `pipeline.min_confirming_events`, `pipeline.confirm_window_minutes` |
| 30 | `PR_MIN_PLATE_LEN` env, default `5` | `camera-snapshot/index.ts:60` | `pipeline.min_plate_length` |
| 31 | `REQUIRE_VEHICLE_SCORE` env, default `0.7` | `camera-snapshot/index.ts:64` | `pipeline.require_vehicle_score` |
| 32 | `TOW_CONFIRM_MIN_CONFIDENCE` env, default `0.65` | `tow-confirm/index.ts:26` | `pipeline.tow_confirm_min_confidence` |
| 33 | `TOW_CONFIRM_LOOKBACK_MINUTES` env, default `180` | `tow-confirm/index.ts:27` | `pipeline.tow_confirm_lookback_minutes` |
| 34 | `PR_MIN_SCORE_OVERRIDES`, `SKIP_SIDECAR_MACS`, `ROTATE_BEFORE_PROCESS`, `EXIT_MIN_DWELL_MINUTES=60`, `TRUCK_FUZZY_CANCEL_MIN=0.65`, `EXIT_MATCH_MAX_TOTAL_DIFFS=2` | `camera-snapshot/index.ts:42,92,104`, `truck_plaza_exit.ts:85,100,110` | **Wave 3.4** — `pipeline.cameras{}` slot reserved, not filled |

### Timezone (PLATFORM-15)

| # | Constant / value | Where it lives today | Proposed config key |
|---|---|---|---|
| 35 | `ZoneInfo("America/New_York")` — **in scope for Task 10** | `routers/app_api.py:66` (`LOT_TZ`), `routers/quickbooks.py:199` (`tz_name = "America/New_York"`, with a comment that literally names the missing column: *"property table doesn't carry market_id today; default tz"*), `services/apartment_notify.py:327` (inline `_zi("America/New_York")`) | `timezone` (top level) |
| 35b | `_LOT_TZ = ZoneInfo("America/New_York")` — **deferred, not Task 10** | **One** literal, at `services/plaza_notify.py:33`. `services/plaza_reconcile.py` and `services/tow_digest.py` do **not** own a copy — they import this one. `plaza_notify.py` is read-only this wave and `plaza_reconcile.py` is on the never-edit list, so the chain moves after the Stripe-cutover rebase (decision D11). Task 15 allowlists it. | `timezone` *(later)* |
| 35c | `markets.timezone`, default `"America/New_York"` | `models.py:27`; read at `routers/quickbooks.py:204` through a `Property → Lot → Market` hop that only resolves when the property is **also** present in the legacy `lots` table — which is why line 199 needs a hardcoded fallback at all | `timezone` — **reconcile, do not duplicate**: Task 10 makes `config.timezone` the answer and leaves `markets.timezone` as the legacy fallback under it, exactly as `cooldown_hours` sits under `cooldown.hours` |
| 36 | `tz = "America/New_York"` default arg | `tow-dispatch-email/index.ts:13`, `tow-dispatch-sms/index.ts:19`, `tow-confirm/index.ts:307` | `timezone` |
| 37 | `const TZ = "America/New_York"` | `weather-pull/index.ts:15`, `weather-risk-eval/index.ts:21` (both jobs inactive — fat decision 13) | `timezone` *(only if the jobs survive)* |
| 38 | `LOT_TIMEZONE = 'America/New_York'` | `frontend/src/lib/lotdate.js:9` — its own comment says Wave 2 replaces it | `timezone`, via the property row |

### Notice recipients and delivery overrides (PLATFORM-5)

| # | Constant / value | Where it lives today | Proposed config key |
|---|---|---|---|
| 39 | `cooldown_email_override_to` — **replaces ALL recipients at EVERY site** | `config.py:224`; read at `services/cooldown_notice.py:170`, `services/reregistration_notice.py:156` | `notices.override_to` (per property) |
| 40 | `EMAIL_OVERRIDE_TO` — the edge twin of #39 | `tow-dispatch-email/index.ts:559`, `tow-confirm/index.ts:318` | `notices.override_to` |
| 41 | `cooldown_notice_extra_recipients` | `config.py:223` | `notices.extra_recipients` |
| 42 | `cooldown_partner_email_enabled = True` | `config.py:222` | `notices.partner_email_enabled` |
| 43 | `DISPATCH_EMAILS_DISABLED` env | `tow-dispatch-email/index.ts:765` | `notices.dispatch_enabled` |
| 44 | `OWNER_CC_EMAIL` default `gabriel@lotlogicparking.com` — a personal address as a code default | `tow-dispatch-email/index.ts:567` | `notices.owner_cc` |
| 45 | `cooldown_from_email` / `FROM_EMAIL` default `dispatch@lotlogicparking.com` | `config.py:225`; `tow-dispatch-email/index.ts:107`, `tow-confirm/index.ts:317` | `notices.from_email` |
| 46 | `ARRIVAL_NOTIFY_COOLDOWN_MIN` env, default `15` | `tow-confirm/index.ts:247` | `notices.arrival_cooldown_minutes` |
| 47 | staff-recipient resolution (owner email + partner email, hardcoded join) | `services/apartment_notify.py:54 staff_recipients()` | `notices.staff_extra` (adds to, never replaces, the join) |

### Revenue split

| # | Constant / value | Where it lives today | Proposed config key |
|---|---|---|---|
| 48 | `revenue_share` default `0.25` | `models.py:43` (`Column(Numeric(5,4), default=0.25)`) and `models.py:413` (52/422 after Wave 2.4 merges — grep the symbol); applied at `routers/violations.py:431, 512, 766` and `routers/snapshots.py:192` | `revenue.share_override` (null ⇒ partner row wins) |
| 49 | `tow_fee_cents` / `boot_fee_cents` | `enforcement_partners` columns | `revenue.tow_fee_cents` / `revenue.boot_fee_cents` (null ⇒ partner row wins) |

### Tow-evidence retention — the per-camera pattern this wave absorbs

| # | Constant / value | Where it lives today | Proposed config key |
|---|---|---|---|
| 50 | `tow_footage_retention_days = 10` | `config.py:251` | `tow_evidence.footage_retention_days` |
| 51 | `tow_footage_retention_overrides` — `"api_key:days,api_key:days"`, set to `<camera-mac>:2` on Railway | `config.py:258`, parsed by `services/tow_retention.py::parse_overrides`, read at `services/tow_digest.py:470` and `routers/ops.py:399-400` | `tow_evidence.cameras.<api_key>.footage_retention_days` |
| 52 | `tow_clips_bucket` | `config.py:267` | *(stays in env — it is infrastructure, not policy)* |

### Per-property columns with no user interface (PLATFORM-2)

| # | Column | Where it lives today | Proposed config key |
|---|---|---|---|
| 53 | `guest_auto_approve` | `properties` column; read `routers/public_registration.py:234` | `features.guest_auto_approve` (mirrored, column kept) |
| 54 | `permanent_plates_disabled` | `properties` column | `features.permanent_plates_disabled` |
| 55 | `reject_tow_disclaimer` | `properties` column; read `services/apartment_notify.py:317` | `features.reject_tow_disclaimer` |
| 56 | `app_enabled`, `pay_to_park_enabled` | `properties` columns | `features.*` (mirrored; the flags themselves stay columns — fat decision 9 turns one off by UPDATE) |
| 57 | `app_rates` (incl. `monthly_pass: 15000`) | `properties` JSONB; read `routers/app_api.py:263, 356, 361, 464` | `pricing.app_rates` |
| 58 | `enforcement_type`, `enforcement_hours`, `rules`, `monthly_fee`, `notes_migrated` | `properties` columns, **zero readers anywhere** | *(drop candidates — not migrated)* |
| 59 | `enforce_truck_plaza_cooldown()` | A `BEFORE INSERT` trigger (`trg_visitor_passes_cooldown`) that still fires on **every** parking-pass registration and whose entire body has been `RETURN NEW;` since the 2026-05-31 policy change — verified byte-for-byte in production. It is fat decision 27(a). | *(drop candidate — not migrated. Task 8 rewrites the **other** cooldown trigger, `set_pass_cooldown_flag`; do not confuse the two, and do not teach this stub to read config. Delete it in the fat cull, not here.)* |

---

## Task Sequence

| # | Task | Depends on | Lane |
|---|---|---|---|
| 1 | Migration: `properties.config` + grants + CHECK | Wave 2.4 merged | — |
| 2 | `services/property_config.py` — the typed loader | 1 | — |
| 3 | `routers/properties_config.py` — the admin endpoint | 2 | C |
| 4 | Dashboard config editor (platform-admin only) | 3 | C |
| 5 | Migration: `public.property_config()` — the SQL half | 1, 2 | A |
| 6 | The 48-hour trigger reads config — **the monthly-pass unblock** | 5 | A |
| 7 | `app_api` sells the monthly pass | 6, 2 | A |
| 8 | Cooldown: trigger + `count_on_cooldown` read config | 5 | A |
| 9 | Plate-confidence floors + grace windows behind the loader | 2 | B |
| 10 | `services/lot_time.py` — timezone, three call sites (plaza chain deferred) | 2 | B |
| 11 | `services/notices.py` — recipients and overrides per property | 2 | B |
| 12 | `services/revenue.py` — per-property split override | 2 | B |
| 13 | Absorb `TOW_FOOTAGE_RETENTION_OVERRIDES` into `config.tow_evidence` | 2 | D |
| 14 | Edge functions read the same config (frontend repo) | 5, 3 | D |
| 15 | Drift guard, generated key reference, `CLAUDE.md` | all | — |

### Parallelism map

```
        T1  (migration: the column)
         │
        T2  (the typed loader)                    ← everything below reads this
         │
    ┌────┼─────────────┬──────────────┬──────────────┐
    │    │             │              │              │
   T5   T3            T9             T10            T13
 (SQL   (admin      (floors +      (timezone)     (tow
  fn)    endpoint)   grace)             │          overrides)
    │    │             │              T11              │
   T6   T4            │            (notices)           │
    │                 │                │               │
   T7                 └── T12 ─────────┘               │
    │                    (revenue)                     │
   T8 ─────────────────────────┬───────────────────────┘
                              T14  (edge functions — needs T5's RPC + T3's endpoint)
                               │
                              T15  (drift guard + docs)
```

- **T1 → T2 is the only strictly serial pair at the head.** Nothing else can start until the loader exists, because the whole point is that every constant moves *behind* it.
- **Four lanes run concurrently after T2.** Lane A (T5→T6→T7→T8, all SQL/trigger, all touching `visitor_passes` write-path behaviour) must stay serial within itself — two agents editing trigger bodies on the same table will collide in `regen_expected.sh`. Lane B (T9, T10, T11, T12) is four independent Python services; T12 lands after T10/T11 only because it is the smallest and makes a natural batching point, not because of a code dependency. Lane C (T3→T4) is the admin surface. Lane D (T13) is standalone.
- **T14 is the join point.** It needs T5 (the RPC exists) and T3 (a way to read config over HTTP for functions that would rather not hold a service-role client), and it should land *after* at least T6 and T8 so the edge copies it deletes are already redundant rather than about to become so.
- **Realistic shape for one worker:** T1, T2 (day 1) → lane A (days 2–3) → lane B (days 3–4) → lanes C/D (day 5) → T14, T15 (day 6). That is the program doc's 6 days.
- **Realistic shape for three workers:** T1+T2 by one worker, then A / B / C+D in parallel (2 days), then T14+T15 (1 day). ≈ 3.5 elapsed days for the same 6 person-days.

---

## Task 1: Migration — `properties.config`

**Files:**
- Create: `migrations/20260914HHMMSS_properties_config.sql`
- Modify: `tests/plaza/conftest.py` (add `"20260914*.sql"` to `MIGRATION_GLOBS`)
- Modify: `scripts/db/expected_schema.sql`, `scripts/db/expected_census.txt`, `docs/db/schema.md` (regenerated)
- Test: `tests/plaza/test_property_config_column.py`

**Interfaces:**
- Produces: `properties.config jsonb NULL`, `properties.config_updated_at timestamptz`, `properties.config_updated_by text`, constraint `properties_config_is_object`, and the revoked grants that every later task relies on.
- Consumes: nothing.

**Why `NULL` and not `'{}'::jsonb DEFAULT`.** A default of `{}` would make eleven rows change from "no opinion" to "an empty opinion", and the two are only the same while the loader is perfect. `NULL` is the honest encoding of *"this property has never been configured"*, and it is what Task 2's test asserts against.

- [ ] **Step 1: Write the migration**

```sql
-- properties.config — one JSONB document per site for everything that should
-- differ between one property and the next.
--
-- Wave 2.1 / systemic move S2. Additive and inert on the day it lands: NULL
-- means "every default", and services/property_config.py's defaults ARE the
-- constants that are in the code today. Nothing reads this column until the
-- migration that teaches a reader to read it.
--
-- Shape (see docs/db/property-config.md, generated in Task 15):
--   { "timezone": "America/New_York",
--     "passes":   { "max_stay_hours": 48, "min_stay_minutes": 30, ... },
--     "cooldown": { "hours": 24, ... },
--     "grace":    { "registration_minutes": 15, ... },
--     "pipeline": { "plate_confidence_min": 0.92, ... },
--     "notices":  { "override_to": null, "extra_recipients": [], ... },
--     "revenue":  { "share_override": null, ... },
--     "policy":   { "require_ack": true, "version": null },
--     "features": { ... },
--     "pricing":  { "app_rates": null },          -- Wave 3.6 fills this
--     "tow_evidence": { "footage_retention_days": 10, "cameras": {} } }

ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS config            jsonb,
  ADD COLUMN IF NOT EXISTS config_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS config_updated_by text;

COMMENT ON COLUMN public.properties.config IS
  'Per-site configuration document (Wave 2.1). NULL = every default. Validated '
  'on write by services/property_config.PropertyConfig and read in SQL via '
  'public.property_config(uuid). Never contains a secret: policy numbers, '
  'windows, recipient lists and a timezone name only.';
COMMENT ON COLUMN public.properties.config_updated_by IS
  'Email of the platform admin who last wrote config, or ''service'' for an '
  'X-API-Key caller. Audit only — never used for authorization.';

-- A top-level array or scalar would parse as valid JSON and then explode inside
-- every jsonb_extract_path below. Reject it at the door; it costs one bitmap
-- scan on a table of eleven rows.
ALTER TABLE public.properties
  DROP CONSTRAINT IF EXISTS properties_config_is_object;
ALTER TABLE public.properties
  ADD CONSTRAINT properties_config_is_object
  CHECK (config IS NULL OR jsonb_typeof(config) = 'object');

-- ── Grants ────────────────────────────────────────────────────────────────
-- properties holds TABLE-LEVEL INSERT and UPDATE for both anon and
-- authenticated (relacl: anon=awdDxtm, authenticated=arwdDxtm), so a new
-- column inherits a write grant the moment it is added. And
-- frontend/src/lib/db.js::updateProperty writes properties straight through
-- PostgREST with the user's JWT, under RLS policies (admin_write_properties
-- ALL, properties_owner_update) that let an owner PATCH their own row. Without
-- what follows, a leasing office could set its own cooldown to 0 from a
-- browser console and bypass every validation in Task 2.
--
-- A column-level REVOKE CANNOT fix this. Postgres will not subtract a column
-- privilege from a role that holds the table-level one: `REVOKE UPDATE
-- (config) ... FROM authenticated` emits a WARNING and changes nothing. The
-- only thing that works is to drop the table-level grant and re-grant column
-- lists — the same shape as 20260707170000_properties_anon_column_scope.sql,
-- which is how anon's SELECT came to be scoped to eight columns.
--
-- The 29 columns enumerated below are every column properties had BEFORE this
-- migration, in ordinal order. The three new ones are deliberately absent.
-- Re-granting them is not optional politeness: db.js::updateProperty is how
-- the dashboard edits a property's name, address, policy text and feature
-- flags today, and a revoke without a matching re-grant breaks all of it.
-- test_the_29_pre_existing_columns_keep_their_write_grant is the guard.

REVOKE INSERT, UPDATE ON public.properties FROM anon, authenticated;

GRANT INSERT (
     id, tow_company_id, name, address, qr_code_id, total_spaces, created_at,
     owner_id, market_id, partner_id, lat, lng, enforcement_type,
     enforcement_hours, rules, monthly_fee, active, onboarded_at,
     notes_migrated, property_type, policy_text, policy_phone,
     cooldown_hours, app_enabled, app_rates, guest_auto_approve,
     permanent_plates_disabled, reject_tow_disclaimer, pay_to_park_enabled
  ) ON public.properties TO anon, authenticated;

GRANT UPDATE (
     id, tow_company_id, name, address, qr_code_id, total_spaces, created_at,
     owner_id, market_id, partner_id, lat, lng, enforcement_type,
     enforcement_hours, rules, monthly_fee, active, onboarded_at,
     notes_migrated, property_type, policy_text, policy_phone,
     cooldown_hours, app_enabled, app_rates, guest_auto_approve,
     permanent_plates_disabled, reject_tow_disclaimer, pay_to_park_enabled
  ) ON public.properties TO anon, authenticated;

-- anon's SELECT is ALREADY column-scoped (eight columns, by the 20260707
-- migration above), so a new column is not auto-granted and a column-level
-- REVOKE here does work. Kept as an explicit belt-and-braces assertion rather
-- than relying on the earlier migration staying as it is.
REVOKE SELECT (config, config_updated_at, config_updated_by) ON public.properties FROM anon;

-- authenticated KEEPS its table-level SELECT, and therefore SELECT(config):
-- an owner may read their own site's configuration (RLS still scopes the row
-- to owner_id / partner_id), they just may not write it. The write path is
-- PUT /properties/{id}/config, platform-admin only (decision D7).
--
-- REFERENCES is left alone for both roles. It cannot read or change a value;
-- revoking it would churn the ACL diff for no security gain.

-- properties_public is the anon-facing view used by the QR registration pages.
-- It enumerates its columns, so config is already excluded — this is the
-- assertion that it stays that way.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.view_column_usage
     WHERE view_schema = 'public' AND view_name = 'properties_public'
       AND column_name = 'config'
  ) THEN
    RAISE EXCEPTION 'properties_public must not expose properties.config';
  END IF;
END $$;
```

- [ ] **Step 2: Add the glob to the test harness**

In `tests/plaza/conftest.py`, extend `MIGRATION_GLOBS`:

```python
MIGRATION_GLOBS = (
    "20260902*.sql", "20260905*.sql", "20260907*.sql", "20260910*.sql",
    "20260911*.sql",
    # Wave 2.1 — properties.config, public.property_config(), and the trigger
    # bodies that stop carrying their own numbers. Without this line the
    # harness replays the live-schema extract WITHOUT the config column and
    # every test below silently exercises the old world.
    "20260914*.sql",
)
```

- [ ] **Step 3: Fix the harness's anon column grant so it matches production**

`tests/plaza/schema/live_schema.sql:133` grants `anon` SELECT on **seven**
columns:

```sql
GRANT SELECT (id, name, address, property_type, policy_text, policy_phone, qr_code_id)
  ON public.properties TO anon;
```

Production grants **eight** — the same seven plus `pay_to_park_enabled`
(verified live). Every grant assertion in Step 4 would therefore be testing a
world that does not exist, and would keep passing after a change that widened
anon's real SELECT. Add the missing column:

```sql
GRANT SELECT (id, name, address, property_type, policy_text, policy_phone,
              qr_code_id, pay_to_park_enabled)
  ON public.properties TO anon;
```

The extract is also missing the table-level `GRANT INSERT, UPDATE ... TO anon,
authenticated` that production has, which is precisely the grant D1's revoke
removes — add it immediately above, so the harness can prove the revoke
actually subtracts something:

```sql
GRANT INSERT, UPDATE ON public.properties TO anon, authenticated;
```

Run the existing `tests/plaza/` suite once **before** touching anything else in
this task: if adding these grants breaks a test, the harness and production
disagreed about more than one column and that is worth knowing now.

- [ ] **Step 4: Write the tests**

`tests/plaza/test_property_config_column.py`:

```python
"""properties.config — the column, its CHECK, and the grants around it.

The security property this file pins down is narrow and load-bearing:
`properties` grants INSERT/UPDATE to anon and authenticated across every
column, and frontend/src/lib/db.js writes properties straight through
PostgREST. A config column that inherited those grants would let a leasing
office set its own cooldown to zero from a browser console.
"""
import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError


@pytest.mark.asyncio
async def test_config_defaults_to_null_for_every_existing_row(db_conn, seed_truck_plaza):
    row = (await db_conn.execute(
        text("SELECT config, config_updated_at FROM public.properties WHERE id = :p"),
        {"p": str(seed_truck_plaza.property_id)},
    )).first()
    assert row[0] is None, "a migration must not invent an opinion for an existing site"
    assert row[1] is None


@pytest.mark.asyncio
async def test_an_object_is_accepted(db_conn, seed_truck_plaza):
    await db_conn.execute(
        text("UPDATE public.properties SET config = :c::jsonb WHERE id = :p"),
        {"c": '{"passes": {"max_stay_hours": 720}}', "p": str(seed_truck_plaza.property_id)},
    )
    await db_conn.commit()


@pytest.mark.asyncio
@pytest.mark.parametrize("bad", ['[]', '"hello"', '42', 'true', 'null'])
async def test_a_non_object_is_rejected(db_conn, seed_truck_plaza, bad):
    """A top-level array parses as valid JSON and then explodes inside every
    jsonb_extract_path in every trigger that reads it."""
    with pytest.raises(IntegrityError):
        await db_conn.execute(
            text("UPDATE public.properties SET config = :c::jsonb WHERE id = :p"),
            {"c": bad, "p": str(seed_truck_plaza.property_id)},
        )
        # The CHECK fires on the statement, not the commit, so the commit must
        # be OUTSIDE the block — inside, it is unreachable and the test would
        # still pass if the constraint were dropped and the commit failed for
        # some other reason.
    await db_conn.rollback()


@pytest.mark.asyncio
async def test_anon_cannot_read_or_write_config(db_conn):
    """anon reads eight columns of properties for the QR page. config is not
    one of them, and never becomes one."""
    rows = (await db_conn.execute(text("""
        SELECT privilege_type
          FROM information_schema.column_privileges
         WHERE table_schema='public' AND table_name='properties'
           AND grantee='anon' AND column_name='config'
    """))).scalars().all()
    assert rows == [], f"anon holds {rows} on properties.config"


@pytest.mark.asyncio
async def test_authenticated_may_read_but_not_write_config(db_conn):
    """THE test for D1. It fails without the migration's table-level
    REVOKE: `information_schema.column_privileges` expands a table-level
    UPDATE across every column, so before the revoke this query returns
    {'SELECT','INSERT','UPDATE','REFERENCES'} and both asserts below blow up.
    A column-level `REVOKE UPDATE (config)` would leave it exactly as it was
    (Postgres warns and does nothing), so this test also catches the wrong
    fix, not just the missing one."""
    rows = set((await db_conn.execute(text("""
        SELECT privilege_type
          FROM information_schema.column_privileges
         WHERE table_schema='public' AND table_name='properties'
           AND grantee='authenticated' AND column_name='config'
    """))).scalars().all())
    assert "SELECT" in rows, "an owner may see their own site's configuration"
    assert "UPDATE" not in rows, "config is written through the backend, not PostgREST"
    assert "INSERT" not in rows


#: Every column properties had before this migration, ordinal order. Duplicated
#: here on purpose: if someone adds a column to the migration's GRANT list
#: without adding it here, that is a review conversation, not a silent pass.
PRE_EXISTING_COLUMNS = (
    "id", "tow_company_id", "name", "address", "qr_code_id", "total_spaces",
    "created_at", "owner_id", "market_id", "partner_id", "lat", "lng",
    "enforcement_type", "enforcement_hours", "rules", "monthly_fee", "active",
    "onboarded_at", "notes_migrated", "property_type", "policy_text",
    "policy_phone", "cooldown_hours", "app_enabled", "app_rates",
    "guest_auto_approve", "permanent_plates_disabled", "reject_tow_disclaimer",
    "pay_to_park_enabled",
)


@pytest.mark.asyncio
@pytest.mark.parametrize("role", ["anon", "authenticated"])
async def test_the_29_pre_existing_columns_keep_their_write_grant(db_conn, role):
    """The other half of D1, and the one that would actually take the product
    down. Dropping the table-level UPDATE without re-granting the 29 columns
    breaks frontend/src/lib/db.js::updateProperty — which is how the dashboard
    edits a property's name, address, policy text and feature flags. A revoke
    that over-reaches is a worse outage than the hole it closes."""
    granted = set((await db_conn.execute(text("""
        SELECT column_name
          FROM information_schema.column_privileges
         WHERE table_schema='public' AND table_name='properties'
           AND grantee=:role AND privilege_type='UPDATE'
    """), {"role": role})).scalars().all())
    assert granted == set(PRE_EXISTING_COLUMNS), (
        f"{role} UPDATE grant drifted: "
        f"missing={set(PRE_EXISTING_COLUMNS) - granted}, extra={granted - set(PRE_EXISTING_COLUMNS)}"
    )


@pytest.mark.asyncio
async def test_the_column_count_is_still_29_plus_3(db_conn):
    """If a later migration adds a column to properties, the GRANT lists above
    stop being 'every pre-existing column' and this test says so before the new
    column silently becomes unwritable by the dashboard."""
    total = (await db_conn.execute(text(
        "SELECT count(*) FROM information_schema.columns "
        "WHERE table_schema='public' AND table_name='properties'"))).scalar_one()
    assert total == 32, (
        f"properties now has {total} columns, not 29 + config/config_updated_at/"
        "config_updated_by. Decide whether the new column belongs in the "
        "anon/authenticated UPDATE grant, then update this test and the migration."
    )
```

- [ ] **Step 5: Apply, regenerate, verify**

```bash
cd /Users/gabe/lotlogic-backend
# apply via the Supabase MCP apply_migration (records the ledger row), then:
scripts/db/regen_expected.sh "$PROD_DATABASE_URL"
pytest tests/plaza/test_property_config_column.py -q
python scripts/db/check_drift.py --ledger-file <(psql "$PROD_SCHEMA_READER_URL" -qAt \
  -c "select name || '|' || version from supabase_migrations.schema_migrations")
```
Expected: all pass; `check_drift.py` clean; `git status` shows the three regenerated artifacts changed **plus a large ACL diff in `expected_schema.sql`** — the table-level grant becoming 29 column grants is exactly what D1's fix looks like in a `pg_dump`. Review that diff rather than rubber-stamping it: it is the only place the re-grant list is visible end-to-end.

- [ ] **Step 6: Commit**

```bash
git add migrations/20260914*_properties_config.sql tests/plaza/ scripts/db/expected_schema.sql \
        scripts/db/expected_census.txt docs/db/schema.md
git commit -m "feat(config): properties.config jsonb, with the write grant scoped to the old columns

One document per site for everything that should differ between one property
and the next. Additive and inert: NULL means every default, and nothing reads
the column yet.

The grant surgery is the point. properties held TABLE-LEVEL INSERT/UPDATE for
anon and authenticated, and frontend/src/lib/db.js writes properties through
PostgREST with the user's JWT, so config inherited a write grant the moment it
existed — a leasing office could have set its own cooldown to zero from a
browser console. A column-level REVOKE cannot subtract from a table-level
grant (Postgres warns and does nothing), so this drops the table grant and
re-grants the 29 pre-existing columns by name, the same shape
20260707170000_properties_anon_column_scope.sql used for anon's SELECT.
authenticated keeps SELECT so an owner can still see their site's rules.

Wave 2.1 / S2. Depends on Wave 2.4's migration runner and drift check."
```

---

## Task 2: `services/property_config.py` — the typed loader

**Files:**
- Create: `services/property_config.py`
- Test: `tests/test_property_config.py`

**Interfaces:**
- Consumes: `sqlalchemy.text`, `AsyncSession`, `config.get_settings()` (for the env fallbacks the config sits on top of).
- Produces, for every later task:
  - `PropertyConfig` — a frozen pydantic `BaseModel` with nested `PassesConfig`, `CooldownConfig`, `GraceConfig`, `PipelineConfig`, `NoticesConfig`, `RevenueConfig`, `PolicyConfig`, `FeaturesConfig`, `PricingConfig`, `TowEvidenceConfig`. `model_config = ConfigDict(extra="forbid", frozen=True)`.
  - `PropertyConfig.defaults() -> PropertyConfig`
  - `DEFAULTS_JSON: dict[str, dict]` — **keyed by property type**: `{"apartment": …, "truck_plaza": …}`, each value `PropertyConfig.defaults(t).model_dump(mode="json")`. Two documents, not one, because `property_config_defaults(p_property_type)` in Task 5 returns two and `defaults()` already branches on type (72 h / no ack vs 48 h / ack required). A single `DEFAULTS_JSON` would make "the SQL function reproduces it exactly" an ambiguous claim and would give the Task 5 parity test nothing to parameterise over.
  - `await load_property_config(db, property_id, *, fresh: bool = False) -> PropertyConfig`
  - `invalidate_property_config(property_id | None) -> None`
  - `parse_property_config(raw: dict | None, *, property_type: str = "apartment") -> PropertyConfig`

**The defaults-are-the-constants rule.** Every field default in this file is copied from the inventory table above, with the file:line it came from in the field's comment. Where two copies disagree today (#17 vs #18: `GRACE_MINUTES = 10` at `plate_matcher.py:63` vs `GRACE_EXPIRY_MINUTES = 15` in the sweep — and a *third*, stale, value of 15 in that module's own docstring at `:24`; #25 vs #26: `0.92` at `:59` vs `0.8` at the ingest gate, with the docstring at `:15` claiming 0.85), the default is **the one that governs enforcement today** — the sweep's 15 minutes and the matcher's 0.92 — and the disagreement is recorded in the field comment as the reason the constant had to move. Task 9 and Task 14 then converge the two readers on the single value, which is a behaviour change at exactly one site and is called out in that task's verification step.

- [ ] **Step 1: Write the failing tests**

`tests/test_property_config.py`:

```python
"""services/property_config.py — the typed loader.

The acceptance property for the whole of Wave 2.1 is here, in one line:

    PropertyConfig.defaults() == parse_property_config(None)

i.e. a property that has never been configured gets exactly the numbers that
are compiled into the code today. Every task downstream ships its own version
of this assertion against its own constant; this file proves the shape.
"""
from __future__ import annotations

import pytest

from services import property_config as pc


def test_a_null_config_is_the_defaults():
    assert pc.parse_property_config(None) == pc.PropertyConfig.defaults()


def test_an_empty_object_is_also_the_defaults():
    assert pc.parse_property_config({}) == pc.PropertyConfig.defaults()


def test_the_shipped_defaults_are_todays_constants():
    """Each of these is a line of code that exists on main right now. When one
    of them changes, this test is the thing that says so out loud.

    Asks for the TRUCK PLAZA defaults explicitly. `defaults()` with no
    argument is the apartment document, where max_stay_hours is 72 (the
    Field(le=72) bound on the guest registration form) — the 48 below is the
    stay-limit trigger's number and belongs to a truck plaza. Calling it bare
    and asserting 48 is how this test failed its own first run in review."""
    d = pc.PropertyConfig.defaults("truck_plaza")
    assert d.timezone == "America/New_York"                  # 11 literals, PLATFORM-15
    assert d.passes.max_stay_hours == 48                     # enforce_truck_plaza_stay_limit, 48.5
    # …and the other branch, so neither can drift unnoticed:
    assert pc.PropertyConfig.defaults().passes.max_stay_hours == 72
    assert pc.PropertyConfig.defaults("apartment").passes.max_stay_hours == 72
    assert d.passes.min_stay_minutes == 30                   # same trigger, 0.5h
    assert d.passes.bookable_durations == ["h24", "h48"]     # app_api.py:73 BOOKABLE_KINDS
    assert d.passes.monthly_pass_days == 30
    assert d.cooldown.hours == 24                            # set_pass_cooldown_flag, interval '24 hours'
    assert d.cooldown.notice_dedup_hours == 24               # cooldown_notice.py:36 _DEDUP_HOURS
    assert d.cooldown.plate_hold_hours == 24                 # enforce_plate_hold
    assert d.cooldown.min_park_minutes == 2                  # sessions.ts dwell floor
    assert d.grace.registration_minutes == 15                # cron-sessions-sweep GRACE_EXPIRY_MINUTES
    assert d.grace.overstay_minutes == 5
    assert d.grace.exit_hint_buffer_minutes == 5
    assert d.grace.dispatch_hold_minutes == 5
    assert d.grace.overstay_max_age_hours == 6
    assert d.pipeline.plate_confidence_min == 0.92           # plate_matcher.py:59
    assert d.pipeline.camera_suspend_threshold == 0.70
    assert d.pipeline.camera_suspend_min_events == 5
    assert d.pipeline.camera_suspend_minutes == 30
    assert d.pipeline.min_confirming_events == 2             # the only defence against shape-twin OCR
    assert d.pipeline.confirm_window_minutes == 5
    assert d.pipeline.tow_confirm_min_confidence == 0.65
    assert d.pipeline.tow_confirm_lookback_minutes == 180
    assert d.notices.override_to is None                     # PLATFORM-5
    assert d.notices.extra_recipients == []
    assert d.notices.partner_email_enabled is True
    assert d.notices.dispatch_enabled is True
    assert d.notices.from_email == "dispatch@lotlogicparking.com"
    assert d.notices.owner_cc is None                        # NOT a personal address
    assert d.revenue.share_override is None                  # the partner row wins
    assert d.tow_evidence.footage_retention_days == 10
    assert d.tow_evidence.cameras == {}


def test_a_partial_document_only_overrides_what_it_names():
    cfg = pc.parse_property_config({"cooldown": {"hours": 12}})
    assert cfg.cooldown.hours == 12
    assert cfg.cooldown.notice_dedup_hours == 24   # untouched
    assert cfg.passes.max_stay_hours == 48         # untouched


def test_an_unknown_key_is_rejected_loudly():
    """A typo in a config editor must not be a silently ignored setting. This
    is the reason extra='forbid' and not extra='ignore'."""
    with pytest.raises(ValueError) as e:
        pc.parse_property_config({"cooldown": {"hourz": 12}})
    assert "hourz" in str(e.value)


def test_out_of_range_values_are_rejected():
    for doc, bad in [
        ({"passes": {"max_stay_hours": 0}}, "max_stay_hours"),
        ({"passes": {"max_stay_hours": 10_000}}, "max_stay_hours"),
        ({"cooldown": {"hours": -1}}, "hours"),
        ({"pipeline": {"plate_confidence_min": 1.5}}, "plate_confidence_min"),
        ({"pipeline": {"min_confirming_events": 0}}, "min_confirming_events"),
        ({"revenue": {"share_override": 1.4}}, "share_override"),
        ({"timezone": "Mars/Olympus"}, "timezone"),
    ]:
        with pytest.raises(ValueError) as e:
            pc.parse_property_config(doc)
        assert bad in str(e.value), (doc, str(e.value))


def test_min_confirming_events_cannot_be_lowered_to_one():
    """plate_matcher's docstring calls this 'non-negotiable — the only defense
    against shape-twin OCR'. Making it configurable must not make it
    disableable."""
    with pytest.raises(ValueError):
        pc.parse_property_config({"pipeline": {"min_confirming_events": 1}})


def test_a_truck_plaza_gets_a_different_policy_default():
    apt = pc.parse_property_config(None, property_type="apartment")
    plaza = pc.parse_property_config(None, property_type="truck_plaza")
    assert plaza.policy.require_ack is True      # enforce_truck_plaza_policy_ack
    assert apt.policy.require_ack is False
    assert apt.passes.max_stay_hours == 72       # public_registration Field(le=72)
    assert plaza.passes.max_stay_hours == 48


@pytest.mark.parametrize("ptype", ["apartment", "truck_plaza"])
def test_defaults_json_is_plain_json(ptype):
    """Task 5's SQL function must reproduce these documents exactly, so neither
    may contain a Decimal, a datetime or a set. Two documents, keyed by
    property type — property_config_defaults(p_property_type) returns two."""
    import json
    assert set(pc.DEFAULTS_JSON) == {"apartment", "truck_plaza"}
    json.dumps(pc.DEFAULTS_JSON[ptype])
    assert pc.DEFAULTS_JSON[ptype] == pc.PropertyConfig.defaults(ptype).model_dump(mode="json")


@pytest.mark.asyncio
async def test_the_loader_caches_and_can_be_invalidated(monkeypatch):
    calls = []

    class _FakeDB:
        async def execute(self, *a, **k):
            calls.append(1)
            class _R:
                def first(self_inner):
                    return ({"cooldown": {"hours": 6}}, "truck_plaza")
            return _R()

    pid = "00000000-0000-0000-0000-0000000000aa"
    pc.invalidate_property_config(None)
    first = await pc.load_property_config(_FakeDB(), pid)
    second = await pc.load_property_config(_FakeDB(), pid)
    assert first.cooldown.hours == 6
    assert second is first
    assert len(calls) == 1, "a second read inside the TTL must not hit the database"

    pc.invalidate_property_config(pid)
    await pc.load_property_config(_FakeDB(), pid)
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_a_database_failure_returns_defaults_and_does_not_raise(caplog):
    """Enforcement must not stop because a config read failed. Defaults are
    today's behaviour, so falling back to them is the safe answer."""
    class _BoomDB:
        async def execute(self, *a, **k):
            raise RuntimeError("pool wedged")

    pc.invalidate_property_config(None)
    cfg = await pc.load_property_config(_BoomDB(), "00000000-0000-0000-0000-0000000000bb")
    assert cfg == pc.PropertyConfig.defaults()
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd /Users/gabe/lotlogic-backend && pytest tests/test_property_config.py -q
```
Expected: `ModuleNotFoundError: No module named 'services.property_config'`.

- [ ] **Step 3: Write `services/property_config.py`**

The skeleton (fill every section from the inventory; each field carries the file:line it replaced):

```python
"""services/property_config.py — one typed document per site (Wave 2.1 / S2).

Every number below is a constant that exists somewhere in the codebase right
now, with the place it came from named in its comment. That is the contract of
this file: **the defaults ARE today's behaviour**, so a property whose
``config`` column is NULL behaves exactly as it did before this module existed.
`tests/test_property_config.py::test_the_shipped_defaults_are_todays_constants`
is the assertion that keeps it true.

Two rules about what belongs here:

* **Policy, never secrets.** Numbers, windows, recipient lists and a timezone
  name. An API key stays in ``config.py``'s ``Settings``, because this document
  is editable by a platform admin in a browser.
* **``extra="forbid"``.** A typo in a config editor must be a 400, not a
  silently ignored setting. The whole reason a JSONB blob is tolerable here is
  that nothing ever reads it untyped.
* **``frozen=True`` is for immutability, not hashability.** Several fields are
  ``list`` or ``dict``, so a ``PropertyConfig`` is NOT hashable and cannot be a
  ``functools.lru_cache`` key or a set member. The cache below is keyed by
  **property id**; keep it that way.

The SQL half lives in ``public.property_config(uuid)`` (migration
``20260914*_property_config_fn.sql``) and must return the same document for the
same row — ``tests/plaza/test_property_config_sql.py`` diffs the two, for each
property type. ``DEFAULTS_JSON`` is keyed by property type for exactly that
reason: ``property_config_defaults(p_property_type)`` returns two documents
(72 h / no ack for an apartment, 48 h / ack required for a truck plaza), so the
Python side must expose two as well.
"""
from __future__ import annotations

import logging
import time
import uuid as _uuid
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import text

log = logging.getLogger(__name__)

#: How long a loaded config is trusted. Config changes are rare and a stale
#: read for one minute is never an enforcement hazard — but a per-event
#: SELECT on the hot camera path would be, so this is not zero. The admin
#: endpoint calls invalidate_property_config() on write, so the TTL is the
#: ceiling on staleness from an out-of-band UPDATE only.
CACHE_TTL_SECONDS = 60


class _Base(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class PassesConfig(_Base):
    #: enforce_truck_plaza_stay_limit(): `IF hours > 48.5 THEN RAISE`.
    #: Also routers/public_registration.py:407 (`if body.stay_hours > 48`) and
    #: rule 3 of DEFAULT_TRUCK_PLAZA_POLICY. Apartments default to 72 — see
    #: `for_property_type` below — matching Field(..., ge=1, le=72) at
    #: routers/public_registration.py:123/544.
    max_stay_hours: int = Field(48, ge=1, le=8_760)
    #: Same trigger: `IF hours < 0.5 THEN RAISE`.
    min_stay_minutes: int = Field(30, ge=1, le=1_440)
    #: routers/app_api.py:73 BOOKABLE_KINDS, whose own comment names the
    #: stay-limit trigger as the reason 'monthly' is absent.
    bookable_durations: list[Literal["h24", "h48", "monthly"]] = Field(
        default_factory=lambda: ["h24", "h48"]
    )
    #: The term a 'monthly' booking buys. Nothing implements this today;
    #: app_bookings.duration_kind already accepts the value.
    monthly_pass_days: int = Field(30, ge=1, le=366)
    #: Whether a monthly holder is exempt from cooldown.hours (decision D3).
    monthly_exempt_from_cooldown: bool = True

    @field_validator("bookable_durations")
    @classmethod
    def _no_duplicates(cls, v: list[str]) -> list[str]:
        if len(set(v)) != len(v):
            raise ValueError("bookable_durations contains a duplicate")
        return v


class CooldownConfig(_Base):
    #: set_pass_cooldown_flag(): `least(...) > reg - interval '24 hours'`.
    #: Note the trigger IGNORES properties.cooldown_hours today (DB-6) — the
    #: column exists, is 24 at Charlotte and NULL everywhere else, and nothing
    #: in the trigger reads it. Task 8 makes the column the fallback for this
    #: field rather than a second, silently-unused source of truth.
    hours: int = Field(24, ge=0, le=8_760)
    #: services/cooldown_notice.py:36 _DEDUP_HOURS, and the matching
    #: `interval '24 hours'` at services/reregistration_notice.py:136.
    notice_dedup_hours: int = Field(24, ge=1, le=8_760)
    #: enforce_plate_hold()'s message ("on a 24-hour hold until %").
    plate_hold_hours: int = Field(24, ge=0, le=8_760)
    #: camera-snapshot/sessions.ts: `exited_at - entered_at > 2 minutes` is the
    #: floor that separates a park from a drive-through.
    min_park_minutes: int = Field(2, ge=0, le=1_440)


class GraceConfig(_Base):
    #: FOUR copies today and two of them disagree with the rest:
    #:   services/plate_matcher.py:63        GRACE_MINUTES       = 10
    #:   services/plate_matcher.py:24        docstring says 15   (stale, Task 9)
    #:   cron-sessions-sweep/index.ts:38     GRACE_EXPIRY_MINUTES= 15
    #:   cron-no-reg-sweep/index.ts:13       GRACE_MS            = 15 * 60_000
    #: The sweep is what actually creates the violation, so 15 is the number
    #: that governs enforcement and 15 is the default. Task 9 converges
    #: plate_matcher onto it; that is a real (small) behaviour change and is
    #: verified explicitly there.
    registration_minutes: int = Field(15, ge=0, le=1_440)
    overstay_minutes: int = Field(5, ge=0, le=1_440)          # cron-sessions-sweep:30
    exit_hint_buffer_minutes: int = Field(5, ge=0, le=1_440)  # cron-sessions-sweep:31
    dispatch_hold_minutes: int = Field(5, ge=0, le=1_440)     # cron-sessions-sweep:394
    overstay_max_age_hours: int = Field(6, ge=1, le=168)      # cron-sessions-sweep:402
    session_idle_minutes: int = Field(3, ge=1, le=1_440)      # camera-snapshot:137


class PipelineConfig(_Base):
    #: services/plate_matcher.py:59 PLATE_CONFIDENCE_MIN = 0.92 — the floor an
    #: OCR read must clear before it can reach the enforcement path at all.
    #: (That module's own docstring at :15 still says 0.85; it has been wrong
    #: for months and Task 9 rewrites it to name this key instead of a value.)
    #: camera-snapshot/index.ts:35 PR_MIN_SCORE defaults to 0.8 for the
    #: *ingest* gate, which is a different (earlier, looser) question; both
    #: read this key and Task 14 documents which stage each applies to.
    plate_confidence_min: float = Field(0.92, ge=0.0, le=1.0)
    camera_suspend_threshold: float = Field(0.70, ge=0.0, le=1.0)   # plate_matcher.py:60
    camera_suspend_min_events: int = Field(5, ge=1, le=1_000)       # plate_matcher.py:61
    camera_suspend_minutes: int = Field(30, ge=1, le=1_440)         # plate_matcher.py:62
    #: plate_matcher.py:64. "non-negotiable — the only defense against
    #: shape-twin OCR." Configurable UPWARD only: ge=2, not ge=1.
    min_confirming_events: int = Field(2, ge=2, le=20)
    confirm_window_minutes: int = Field(5, ge=1, le=1_440)           # plate_matcher.py:65
    min_plate_length: int = Field(5, ge=1, le=16)                    # camera-snapshot:60
    require_vehicle_score: float = Field(0.7, ge=0.0, le=1.0)        # camera-snapshot:64
    tow_confirm_min_confidence: float = Field(0.65, ge=0.0, le=1.0)  # tow-confirm:26
    tow_confirm_lookback_minutes: int = Field(180, ge=1, le=1_440)   # tow-confirm:27


class NoticesConfig(_Base):
    """PLATFORM-5. One environment variable currently replaces every recipient
    at every site at once, in two different codebases under two different
    names (``COOLDOWN_EMAIL_OVERRIDE_TO`` in the backend, ``EMAIL_OVERRIDE_TO``
    in two edge functions). Per property, and stamped on the send."""
    #: Replaces ALL recipients for this property. A send that used it is
    #: stamped (services/notices.py) so the dashboard shows it forever after.
    override_to: str | None = None
    #: CC'd alongside the resolved recipients. Never replaces them.
    extra_recipients: list[str] = Field(default_factory=list)
    partner_email_enabled: bool = True        # config.py:222
    dispatch_enabled: bool = True             # tow-dispatch-email:765 (inverted)
    from_email: str = "dispatch@lotlogicparking.com"   # config.py:225
    #: tow-dispatch-email/index.ts:567 defaults this to a personal address.
    #: Default None: a site CCs the owner only if somebody says so.
    owner_cc: str | None = None
    #: Added to the owner+partner join in apartment_notify.staff_recipients().
    staff_extra: list[str] = Field(default_factory=list)
    arrival_cooldown_minutes: int = Field(15, ge=0, le=1_440)   # tow-confirm:247


class RevenueConfig(_Base):
    """Null means the enforcement_partners row wins — which is today's
    behaviour and keeps tests/test_partner_allowlist.py's SEC-5 negative
    tests passing untouched."""
    share_override: float | None = Field(None, ge=0.0, le=1.0)
    tow_fee_cents: int | None = Field(None, ge=0)
    boot_fee_cents: int | None = Field(None, ge=0)


class PolicyConfig(_Base):
    #: enforce_truck_plaza_policy_ack() raises when NULL on a truck_plaza row.
    require_ack: bool = False
    #: Bumped when policy_text changes, so a pass can record which version its
    #: holder acknowledged. Nothing reads it yet.
    version: str | None = None


class FeaturesConfig(_Base):
    """Mirrors the behaviour flags that are already columns. The columns stay
    authoritative in this wave (fat decision 9 turns app_enabled off with one
    UPDATE and must keep working); these exist so the editor can show them in
    one place and so a later wave can flip the direction."""
    guest_auto_approve: bool | None = None
    permanent_plates_disabled: bool | None = None
    reject_tow_disclaimer: bool | None = None


class PricingConfig(_Base):
    """Reserved for Wave 3.6 (the paid-parking price list currently living in
    services/square.py::PRICE_CENTS and the plaza_payments CHECK). Defined
    here so 3.6 fills a slot instead of inventing one. Written and read by
    nothing in this wave except app_rates."""
    app_rates: dict[str, int | str] | None = None


class TowEvidenceConfig(_Base):
    """Absorbs TOW_FOOTAGE_RETENTION_OVERRIDES — the per-camera override
    pattern that already shipped as an `api_key:days,...` string in a Railway
    variable box (config.py:258, services/tow_retention.py). Same semantics,
    typed, per property, editable without a deploy."""
    footage_retention_days: int = Field(10, ge=1, le=365)   # config.py:251
    cameras: dict[str, "CameraEvidenceConfig"] = Field(default_factory=dict)


class CameraEvidenceConfig(_Base):
    footage_retention_days: int = Field(..., ge=1, le=365)


class PropertyConfig(_Base):
    #: PLATFORM-15. Eleven literals across both repos; see the inventory.
    timezone: str = "America/New_York"
    passes: PassesConfig = Field(default_factory=PassesConfig)
    cooldown: CooldownConfig = Field(default_factory=CooldownConfig)
    grace: GraceConfig = Field(default_factory=GraceConfig)
    pipeline: PipelineConfig = Field(default_factory=PipelineConfig)
    notices: NoticesConfig = Field(default_factory=NoticesConfig)
    revenue: RevenueConfig = Field(default_factory=RevenueConfig)
    policy: PolicyConfig = Field(default_factory=PolicyConfig)
    features: FeaturesConfig = Field(default_factory=FeaturesConfig)
    pricing: PricingConfig = Field(default_factory=PricingConfig)
    tow_evidence: TowEvidenceConfig = Field(default_factory=TowEvidenceConfig)

    @field_validator("timezone")
    @classmethod
    def _real_zone(cls, v: str) -> str:
        try:
            ZoneInfo(v)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError(f"timezone {v!r} is not an IANA zone") from exc
        return v

    @classmethod
    def defaults(cls, property_type: str = "apartment") -> "PropertyConfig":
        """Today's constants, with the two per-property-type differences that
        already exist in the code applied: an apartment's guest pass caps at
        72h and needs no policy acknowledgement; a truck plaza caps at 48h and
        requires one (enforce_truck_plaza_policy_ack)."""
        if property_type == "truck_plaza":
            return cls(passes=PassesConfig(max_stay_hours=48),
                       policy=PolicyConfig(require_ack=True))
        return cls(passes=PassesConfig(max_stay_hours=72),
                   policy=PolicyConfig(require_ack=False))
```

…plus `DEFAULTS_JSON`, `parse_property_config`, the TTL cache, `load_property_config` (one `SELECT config, property_type FROM public.properties WHERE id = :pid`, wrapped so any exception logs at WARNING and returns `defaults()`), and `invalidate_property_config`.

- [ ] **Step 4: Green, lint, commit**

```bash
cd /Users/gabe/lotlogic-backend && pytest tests/test_property_config.py -q && ruff check services/property_config.py tests/test_property_config.py
git add services/property_config.py tests/test_property_config.py
git commit -m "feat(config): the typed property-config loader, defaults = today's constants

Every field default in services/property_config.py is a constant that exists in
the code today, with the file:line it came from in its comment, so a property
whose config column is NULL behaves exactly as it does now. extra='forbid' so a
typo in the editor is a 400 rather than a setting that silently does nothing.
min_confirming_events is ge=2, not ge=1 — configurable upward only.

Nothing reads this yet. Wave 2.1 / S2."
```

---

## Task 3: `routers/properties_config.py` — the admin endpoint

**Files:**
- Create: `routers/properties_config.py`
- Modify: `main.py` (one `include_router`)
- Test: `tests/test_property_config_endpoint.py`

**Interfaces:**
- `GET /properties/config/schema` → `PropertyConfig.model_json_schema()` plus `{"defaults": DEFAULTS_JSON}`. Platform-admin **or** owner. This is what drives Task 4's editor — the form is generated, so a field added in Task 2 appears in the UI with no frontend change.
- `GET /properties/{property_id}/config` → `{"config": <raw or null>, "effective": <merged>, "defaults": <…>, "updated_at", "updated_by"}`. Owner of the property (read-only) or platform admin.
- `PUT /properties/{property_id}/config` → validated, whole-document replace, `{"effective": …}`. **`require_platform_admin` only.**
- `POST /properties/{property_id}/config/preview` → validate without writing; returns the merged document or a 422 with the field path. The editor calls this on every keystroke-debounce so a bad value never reaches a save.

- [ ] **Step 1: Tests first** (`tests/test_property_config_endpoint.py`) — the four that matter:

```python
@pytest.mark.asyncio
async def test_an_owner_may_read_but_not_write(app_client, owner_token, property_id):
    r = await app_client.get(f"/properties/{property_id}/config",
                             headers={"Authorization": f"Bearer {owner_token}"})
    assert r.status_code == 200
    assert r.json()["config"] is None
    assert r.json()["effective"]["cooldown"]["hours"] == 24

    w = await app_client.put(f"/properties/{property_id}/config",
                             headers={"Authorization": f"Bearer {owner_token}"},
                             json={"cooldown": {"hours": 0}})
    assert w.status_code == 403


@pytest.mark.asyncio
async def test_an_owner_cannot_read_another_owners_config(app_client, owner_token, other_property_id):
    r = await app_client.get(f"/properties/{other_property_id}/config",
                             headers={"Authorization": f"Bearer {owner_token}"})
    assert r.status_code == 404          # 404, not 403 — same as assert_lot_access


@pytest.mark.asyncio
async def test_an_unknown_key_is_422_naming_the_field(app_client, admin_token, property_id):
    r = await app_client.put(f"/properties/{property_id}/config",
                             headers={"Authorization": f"Bearer {admin_token}"},
                             json={"cooldown": {"hourz": 12}})
    assert r.status_code == 422
    assert "hourz" in r.text


@pytest.mark.asyncio
async def test_a_write_stamps_the_author_and_invalidates_the_cache(
        app_client, admin_token, property_id, db_conn):
    await app_client.put(f"/properties/{property_id}/config",
                         headers={"Authorization": f"Bearer {admin_token}"},
                         json={"cooldown": {"hours": 12}})
    row = (await db_conn.execute(text(
        "SELECT config_updated_by, config_updated_at FROM public.properties WHERE id=:p"),
        {"p": str(property_id)})).first()
    assert row[0] and "@" in row[0]
    assert row[1] is not None
    cfg = await load_property_config(db_conn, property_id)
    assert cfg.cooldown.hours == 12      # not the 24 the loader cached a moment ago
```

- [ ] **Step 2: Write the router.** Key points: `assert_lot_access`-equivalent scoping for the read (`services/scope.py` — `properties` is scoped by `owner_id` / `partner_id`, so add `assert_property_access` there if it does not exist, following the existing helper shape); whole-document replace, not a merge, so "delete a key to return to the default" is expressible; `invalidate_property_config(property_id)` after a successful commit; the write is a single `UPDATE … SET config = :c::jsonb, config_updated_at = now(), config_updated_by = :who`.

- [ ] **Step 3: Register in `main.py`**, run the suite, commit as `feat(config): GET/PUT /properties/{id}/config, platform-admin write`.

---

## Task 4: The dashboard config editor (platform-admin only)

**Files (frontend repo, `/Users/gabe/lotlogic`):**
- Create: `frontend/src/pages/admin/PropertyConfigEditor.jsx`
- Create: `frontend/src/lib/propertyConfig.js`
- Modify: `frontend/src/pages/AdminConsolePage.jsx` (a "Configuration" panel per client row)
- Modify: `frontend/src/pages/ALPRPropertyDetailPage.jsx` (read-only "Site rules" card for owners)
- Test: `frontend/scripts/propertyConfigEditor.test.mjs`, plus one Playwright spec in `tests/e2e/`

**Interfaces:**
- `fetchConfigSchema()`, `fetchPropertyConfig(id)`, `savePropertyConfig(id, doc)`, `previewPropertyConfig(id, doc)` — all through `apiFetch`, **never** through `supabase.from('properties')`. Task 1's REVOKE makes the PostgREST path fail anyway; this makes it fail in the code review instead of in production.

**Design:**
- The form is **generated from `GET /properties/config/schema`**, grouped by top-level section, so a field added to `PropertyConfig` shows up with no frontend change. That is the entire reason the schema endpoint exists.
- Each field renders its **default alongside its value** and a "reset to default" affordance. A field equal to its default is visually inert. The save payload contains **only the fields that differ from the default** — so `properties.config` stays a small diff document and a default that changes in a later release propagates to every site that never overrode it.
- A **diff-before-save confirmation**: "cooldown.hours 24 → 12 at Charlotte Travel Plaza" with an explicit confirm. Config edits change enforcement; a slip is a tow.
- **Naming rule**: any free-text field (`policy.version`, notice addresses excepted) runs the same banned-word list `frontend/scripts/check-naming.mjs` enforces, client-side, before the save button enables.
- **Gated on `session.is_platform_admin === true`** exactly as `HqPage` is; owners get the read-only card on `ALPRPropertyDetailPage` instead.
- **Never renders a secret.** The schema has none, but the editor also refuses to render any key whose name matches `/key|secret|token|password/i` as a defensive stop.

- [ ] Steps: schema-driven renderer → diff payload → preview-on-change → confirm dialog → admin gate → read-only owner card → `frontend/scripts/build.mjs` passes → Playwright: a non-admin owner login cannot reach the editor and its PUT is 403.

---

## Task 5: Migration — `public.property_config()`, the SQL half

**Files:**
- Create: `migrations/20260914HHMMSS_property_config_fn.sql`
- Test: `tests/plaza/test_property_config_sql.py`

**Why a SQL function and not "have the trigger call the backend".** Three of the readers in this wave are `BEFORE INSERT` triggers on `visitor_passes` and two are pg_cron-driven edge functions. A trigger cannot make an HTTP call, and a per-row call would be a catastrophe on the hot registration path regardless. So the defaults exist twice — once in pydantic, once in SQL — and `tests/plaza/test_property_config_sql.py` is the test that makes the duplication safe by diffing the two documents.

- [ ] **Step 1: The migration**

```sql
-- public.property_config(uuid) — the SQL half of services/property_config.py.
--
-- Returns the FULL effective document for a property: the shipped defaults
-- (per property_type), with the row's `config` merged over the top, one level
-- deep per section. A trigger reads
--   (public.property_config(NEW.property_id) #>> '{passes,max_stay_hours}')::int
-- and gets exactly the number Python's PropertyConfig would give it.
--
-- SECURITY DEFINER because the BEFORE INSERT triggers on visitor_passes run as
-- whatever role is inserting — including `anon` through PostgREST on the public
-- QR path, which was deliberately REVOKEd from reading properties.config.
-- STABLE so Postgres calls it once per statement rather than once per row.
--
-- The defaults below are a literal copy of services/property_config.DEFAULTS_JSON.
-- tests/plaza/test_property_config_sql.py diffs the two and fails on any drift;
-- that test is the only thing that makes this duplication safe, so do not
-- weaken it.

CREATE OR REPLACE FUNCTION public.property_config_defaults(p_property_type text DEFAULT 'apartment')
RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path TO 'public', 'pg_catalog'
AS $$
  SELECT jsonb_build_object(
    'timezone', 'America/New_York',
    'passes', jsonb_build_object(
        'max_stay_hours', CASE WHEN p_property_type = 'truck_plaza' THEN 48 ELSE 72 END,
        'min_stay_minutes', 30,
        'bookable_durations', jsonb_build_array('h24','h48'),
        'monthly_pass_days', 30,
        'monthly_exempt_from_cooldown', true),
    'cooldown', jsonb_build_object(
        'hours', 24, 'notice_dedup_hours', 24,
        'plate_hold_hours', 24, 'min_park_minutes', 2),
    'grace', jsonb_build_object(
        'registration_minutes', 15, 'overstay_minutes', 5,
        'exit_hint_buffer_minutes', 5, 'dispatch_hold_minutes', 5,
        'overstay_max_age_hours', 6, 'session_idle_minutes', 3),
    'pipeline', jsonb_build_object(
        'plate_confidence_min', 0.92, 'camera_suspend_threshold', 0.70,
        'camera_suspend_min_events', 5, 'camera_suspend_minutes', 30,
        'min_confirming_events', 2, 'confirm_window_minutes', 5,
        'min_plate_length', 5, 'require_vehicle_score', 0.7,
        'tow_confirm_min_confidence', 0.65, 'tow_confirm_lookback_minutes', 180),
    'notices', jsonb_build_object(
        'override_to', NULL, 'extra_recipients', jsonb_build_array(),
        'partner_email_enabled', true, 'dispatch_enabled', true,
        'from_email', 'dispatch@lotlogicparking.com', 'owner_cc', NULL,
        'staff_extra', jsonb_build_array(), 'arrival_cooldown_minutes', 15),
    'revenue', jsonb_build_object(
        'share_override', NULL, 'tow_fee_cents', NULL, 'boot_fee_cents', NULL),
    'policy', jsonb_build_object(
        'require_ack', p_property_type = 'truck_plaza', 'version', NULL),
    'features', jsonb_build_object(
        'guest_auto_approve', NULL, 'permanent_plates_disabled', NULL,
        'reject_tow_disclaimer', NULL),
    'pricing', jsonb_build_object('app_rates', NULL),
    'tow_evidence', jsonb_build_object(
        'footage_retention_days', 10, 'cameras', jsonb_build_object())
  );
$$;

CREATE OR REPLACE FUNCTION public.property_config(p_property_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  r        record;
  defaults jsonb;
  merged   jsonb;
  k        text;
BEGIN
  SELECT property_type, config, cooldown_hours
    INTO r
    FROM public.properties
   WHERE id = p_property_id;

  IF NOT FOUND THEN
    -- An unknown property is not an error here: the caller is a trigger on a
    -- row whose FK will reject it a moment later anyway, and raising would
    -- replace a clear FK violation with a confusing one.
    RETURN public.property_config_defaults('apartment');
  END IF;

  defaults := public.property_config_defaults(coalesce(r.property_type, 'apartment'));

  -- DB-6 bridge: properties.cooldown_hours is the pre-config home of
  -- cooldown.hours (24 at Charlotte, NULL at the apartments) and the trigger
  -- that should have read it never did. Fold it in UNDER an explicit config
  -- value so a site that has been configured wins, and a site that has not
  -- keeps the column's answer. Task 8's migration is what makes the trigger
  -- actually read this; dropping the column is a later commit.
  IF r.cooldown_hours IS NOT NULL THEN
    defaults := jsonb_set(defaults, '{cooldown,hours}', to_jsonb(r.cooldown_hours));
  END IF;

  IF r.config IS NULL THEN
    RETURN defaults;
  END IF;

  -- Merge one level deep per section: `||` on jsonb replaces a whole key, so a
  -- config naming only {"cooldown":{"hours":12}} must not wipe
  -- notice_dedup_hours. Top-level scalars (timezone) merge with a plain ||.
  merged := defaults;
  FOR k IN SELECT jsonb_object_keys(r.config) LOOP
    IF jsonb_typeof(r.config -> k) = 'object' AND jsonb_typeof(merged -> k) = 'object' THEN
      merged := jsonb_set(merged, ARRAY[k], (merged -> k) || (r.config -> k));
    ELSE
      merged := jsonb_set(merged, ARRAY[k], r.config -> k);
    END IF;
  END LOOP;

  RETURN merged;
END;
$$;

REVOKE ALL ON FUNCTION public.property_config(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.property_config_defaults(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.property_config(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.property_config_defaults(text) TO authenticated, service_role;
```

- [ ] **Step 2: The anti-drift test** — `tests/plaza/test_property_config_sql.py`:

```python
"""The defaults exist twice — in pydantic and in PL/pgSQL — because a BEFORE
INSERT trigger cannot import Python. This file is the only thing that makes
that duplication safe."""
import json
import pytest
from sqlalchemy import text

from services.property_config import PropertyConfig


@pytest.mark.asyncio
@pytest.mark.parametrize("ptype", ["apartment", "truck_plaza"])
async def test_sql_defaults_equal_python_defaults(db_conn, ptype):
    sql_doc = (await db_conn.execute(
        text("SELECT public.property_config_defaults(:t)"), {"t": ptype})).scalar_one()
    py_doc = PropertyConfig.defaults(ptype).model_dump(mode="json")
    assert json.loads(json.dumps(sql_doc)) == py_doc, (
        "services/property_config.py and property_config_defaults() have drifted. "
        "Change both in the same commit, always."
    )


@pytest.mark.asyncio
async def test_a_partial_config_merges_per_section_not_per_document(db_conn, seed_truck_plaza):
    await db_conn.execute(text(
        "UPDATE public.properties SET config = '{\"cooldown\":{\"hours\":12}}'::jsonb WHERE id=:p"),
        {"p": str(seed_truck_plaza.property_id)})
    await db_conn.commit()
    doc = (await db_conn.execute(text("SELECT public.property_config(:p)"),
                                 {"p": str(seed_truck_plaza.property_id)})).scalar_one()
    assert doc["cooldown"]["hours"] == 12
    assert doc["cooldown"]["notice_dedup_hours"] == 24, "sibling keys must survive the merge"
    assert doc["passes"]["max_stay_hours"] == 48


@pytest.mark.asyncio
async def test_cooldown_hours_column_still_governs_an_unconfigured_site(db_conn, seed_truck_plaza):
    """DB-6's bridge: Charlotte has cooldown_hours = 24 and a NULL config."""
    await db_conn.execute(text(
        "UPDATE public.properties SET config = NULL, cooldown_hours = 36 WHERE id=:p"),
        {"p": str(seed_truck_plaza.property_id)})
    await db_conn.commit()
    doc = (await db_conn.execute(text("SELECT public.property_config(:p)"),
                                 {"p": str(seed_truck_plaza.property_id)})).scalar_one()
    assert doc["cooldown"]["hours"] == 36


@pytest.mark.asyncio
async def test_an_explicit_config_beats_the_legacy_column(db_conn, seed_truck_plaza):
    await db_conn.execute(text(
        "UPDATE public.properties SET config = '{\"cooldown\":{\"hours\":6}}'::jsonb, "
        "cooldown_hours = 36 WHERE id=:p"), {"p": str(seed_truck_plaza.property_id)})
    await db_conn.commit()
    doc = (await db_conn.execute(text("SELECT public.property_config(:p)"),
                                 {"p": str(seed_truck_plaza.property_id)})).scalar_one()
    assert doc["cooldown"]["hours"] == 6


@pytest.mark.asyncio
async def test_anon_cannot_execute_it(db_conn):
    can = (await db_conn.execute(text(
        "SELECT has_function_privilege('anon', 'public.property_config(uuid)', 'EXECUTE')"
    ))).scalar_one()
    assert can is False
```

- [ ] **Step 3:** apply, `regen_expected.sh`, `pytest tests/plaza/test_property_config_sql.py -q`, commit.

---

## Task 6: The 48-hour trigger reads config — the monthly-pass unblock

**Files:**
- Create: `migrations/20260914HHMMSS_stay_limit_from_config.sql`
- Modify: `routers/public_registration.py` (the Python twin at line 407 and the two `le=72` bounds)
- Test: `tests/plaza/test_stay_limit_config.py`

**This is the task the program doc names in one sentence:** *"Unblocks the monthly parking pass, which is built and priced but rejected by a hardcoded 48-hour trigger."* The trigger is `enforce_truck_plaza_stay_limit()`, fired `BEFORE INSERT OR UPDATE OF valid_from, valid_until ON public.visitor_passes`, and its body is:

```plpgsql
IF hours > 48.5 THEN RAISE EXCEPTION 'truck plaza stay cannot exceed 48 hours (got %)', hours;
IF hours < 0.5  THEN RAISE EXCEPTION 'truck plaza stay must be at least 30 minutes (got %)', hours;
```

`routers/app_api.py:73` already documents the consequence in its own comment: *"'monthly' exists in app_rates/app_bookings for display + phase 2, but the truck-plaza stay-limit trigger rejects a 30-day pass, so it is not bookable."* And `app_rates.monthly_pass = 15000` is already sitting on the Charlotte row in production.

- [ ] **Step 1: The migration**

```sql
-- enforce_truck_plaza_stay_limit() reads the property's own bounds.
--
-- Before: `hours > 48.5` and `hours < 0.5`, both baked in, applied to every
-- truck_plaza row at every site. That literal is the only reason the monthly
-- parking pass — built, priced at app_rates.monthly_pass, and accepted by
-- app_bookings.duration_kind's CHECK — cannot be sold (routers/app_api.py:73
-- says so in its own comment).
--
-- After: the same two numbers, read from public.property_config(). A property
-- with a NULL config gets 48 / 30 and behaves identically, which
-- tests/plaza/test_stay_limit_config.py asserts first, before it asserts
-- anything new.
--
-- The 0.5-hour half-hour tolerance on the upper bound is PRESERVED as
-- `max_stay_hours + 0.5`: it exists because valid_from is stamped a beat
-- before valid_until on the registration path and a 48h pass measures 48.0001
-- often enough to matter. Dropping it here would start rejecting passes that
-- register fine today.

CREATE OR REPLACE FUNCTION public.enforce_truck_plaza_stay_limit()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  ptype     text;
  hours     numeric;
  cfg       jsonb;
  max_hours numeric;
  min_mins  numeric;
BEGIN
  SELECT property_type INTO ptype FROM properties WHERE id = NEW.property_id;
  IF ptype IS DISTINCT FROM 'truck_plaza' THEN
    RETURN NEW;
  END IF;

  cfg       := public.property_config(NEW.property_id);
  max_hours := (cfg #>> '{passes,max_stay_hours}')::numeric;
  min_mins  := (cfg #>> '{passes,min_stay_minutes}')::numeric;
  hours     := EXTRACT(EPOCH FROM (NEW.valid_until - NEW.valid_from)) / 3600.0;

  IF hours > max_hours + 0.5 THEN
    RAISE EXCEPTION 'truck plaza stay cannot exceed % hours (got %)', max_hours, hours;
  END IF;
  IF hours < min_mins / 60.0 THEN
    RAISE EXCEPTION 'truck plaza stay must be at least % minutes (got % hours)', min_mins, hours;
  END IF;
  RETURN NEW;
END;
$$;
```

**Careful:** `routers/public_registration.py:146-165` parses these exact messages with `_STAY_LIMIT_RE = re.compile(r"truck plaza stay (cannot exceed|must be at least)[^\"]*", re.I)` to turn a `RAISE` into a 400. The new messages keep both prefixes byte-for-byte, so the regex still matches. **Test it explicitly** — a silently-unmatched message becomes a 500 on the public QR form.

- [ ] **Step 2: The Python twin.** `routers/public_registration.py:407` (`if body.stay_hours > 48`) becomes a config read; the two `Field(..., ge=1, le=72)` bounds stay as the *outer* schema bound (a schema bound cannot be per-row) and the per-property cap is enforced in the handler against `cfg.passes.max_stay_hours`. Raise the `le=` ceiling to `8760` so a monthly pass can reach the handler at all, and keep the handler as the real gate — the comment at line 121-123 already says this is the design.

- [ ] **Step 3: The tests** — `tests/plaza/test_stay_limit_config.py`:

```python
"""enforce_truck_plaza_stay_limit() — the trigger that makes the monthly pass
unsellable, and the config that unmakes it."""
import pytest
from sqlalchemy.exc import DBAPIError


@pytest.mark.asyncio
async def test_with_no_config_a_49_hour_stay_is_still_rejected(db_conn, seed_truck_plaza):
    """The old world, unchanged. This assertion runs FIRST in this file on
    purpose — it is the proof that the migration is inert at Charlotte."""
    with pytest.raises(DBAPIError) as e:
        await seed_truck_plaza.create_pass("ABC1234", hours=49)
    assert "cannot exceed" in str(e.value)


@pytest.mark.asyncio
async def test_with_no_config_a_48_hour_stay_still_succeeds(db_conn, seed_truck_plaza):
    p = await seed_truck_plaza.create_pass("ABC1235", hours=48)
    assert p.id


@pytest.mark.asyncio
async def test_the_half_hour_tolerance_survives(db_conn, seed_truck_plaza):
    """48.4h registers today because valid_from is stamped a beat before
    valid_until. It must keep registering."""
    p = await seed_truck_plaza.create_pass("ABC1236", hours=48.4)
    assert p.id


@pytest.mark.asyncio
async def test_with_no_config_a_20_minute_stay_is_still_rejected(db_conn, seed_truck_plaza):
    with pytest.raises(DBAPIError) as e:
        await seed_truck_plaza.create_pass("ABC1237", hours=0.33)
    assert "at least" in str(e.value)


@pytest.mark.asyncio
async def test_a_monthly_config_lets_a_30_day_pass_through(db_conn, seed_truck_plaza):
    """THE point of Wave 2.1. app_rates.monthly_pass = 15000 is already on the
    Charlotte row in production; this is the line of SQL between it and a sale."""
    await seed_truck_plaza.set_config({"passes": {"max_stay_hours": 744}})
    p = await seed_truck_plaza.create_pass("MONTHLY1", hours=720)
    assert p.id


@pytest.mark.asyncio
async def test_the_cap_still_binds_above_the_configured_value(db_conn, seed_truck_plaza):
    await seed_truck_plaza.set_config({"passes": {"max_stay_hours": 744}})
    with pytest.raises(DBAPIError):
        await seed_truck_plaza.create_pass("MONTHLY2", hours=800)


@pytest.mark.asyncio
async def test_the_error_messages_still_match_the_public_registration_regex():
    """routers/public_registration.py:147 turns these RAISEs into a 400 by
    regex. An unmatched message is a 500 on the public QR form."""
    from routers.public_registration import _STAY_LIMIT_RE
    assert _STAY_LIMIT_RE.search("truck plaza stay cannot exceed 48 hours (got 49.0)")
    assert _STAY_LIMIT_RE.search("truck plaza stay must be at least 30 minutes (got 0.33 hours)")
```

`seed_truck_plaza.set_config(doc)` is a small addition to `tests/plaza/conftest.py`'s `TruckPlazaSeed` — one `UPDATE public.properties SET config = :c::jsonb WHERE id = :pid`.

**The reset needs its own statement, not the truncate.** `TRUNCATE_TABLES` deliberately does **not** list `properties` (the docstring says so: *"``properties`` is deliberately absent — the truck-plaza seed row lives there and is created once per session"*), so a config written by one test would leak into every test after it and quietly change what the stay-limit trigger allows. Add an explicit reset to the `db_conn` fixture's per-test cleanup, alongside the `TRUNCATE`:

```python
# properties is NOT truncated (the seed row is session-scoped), so anything a
# test wrote to the config document has to be undone by hand. cooldown_hours
# goes back to 24 because that is the live Charlotte value the seed carries and
# public.property_config() folds it in under the defaults.
await conn.execute(text(
    "UPDATE public.properties SET config = NULL, config_updated_at = NULL, "
    "config_updated_by = NULL, cooldown_hours = 24"))
```

- [ ] **Step 4:** apply, regen, full suite, commit as `feat(config): the truck-plaza stay cap comes from property config (unblocks the monthly pass)`.

---

## Task 7: `app_api` sells the monthly pass

**Files:**
- Modify: `routers/app_api.py` (`BOOKABLE_KINDS`, `_price`, `/quote`, `/book`, `_insert_pass`)
- Test: `tests/test_app_api_monthly.py`, `tests/plaza/test_monthly_booking.py`

**Interfaces:** `BOOKABLE_KINDS` stops being a module constant and becomes `_bookable(cfg) -> dict[str, timedelta]`, built from `cfg.passes.bookable_durations` and `cfg.passes.monthly_pass_days`. `_price` gains a `monthly` branch reading `app_rates["monthly_pass"]` (already `15000` at Charlotte) with no weekday/weekend split — a month spans both.

- [ ] Steps: config-derived durations → `monthly` quote (flat price, `starts_at + monthly_pass_days`) → `monthly` book → the pass insert (which now clears Task 6's trigger) → `cfg.passes.monthly_exempt_from_cooldown` consulted by `set_pass_cooldown_flag` in Task 8 → a test that with a default config `duration_kind="monthly"` is still a 400 (today's behaviour), and only a configured property accepts it.

**Reminder:** `properties.app_enabled` is `false` on Charlotte today (Wave 1 item 13 turned it off, fat decision 9). This task makes the monthly pass *possible*; it does not turn the app back on. Say so in the commit message so nobody reads a green test as a live product.

---

## Task 8: Cooldown reads config

**Files:**
- Create: `migrations/20260914HHMMSS_cooldown_from_config.sql`
- Modify: `services/cooldown_notice.py` (`_DEDUP_HOURS`), `services/reregistration_notice.py` (the `interval '24 hours'` at line 136)
- Test: `tests/plaza/test_cooldown_config.py`, `tests/test_cooldown_notice.py` (extend)

**DB-6 in one paragraph.** `properties.cooldown_hours` exists, is `24` at Charlotte and `NULL` at all ten apartments, carries a `COMMENT` promising *"Hours a plate must wait between visits after parking. NULL = no cooldown enforcement"* — and `set_pass_cooldown_flag()`, the trigger that actually decides whether a pass is flagged, does not read it. It hardcodes `least(p.valid_until, p.exited_at) > reg - interval '24 hours'`. Meanwhile `count_on_cooldown(uuid, integer DEFAULT 24)` — which the dashboard's "On Cooldown (Tow if seen)" tile calls with **no** second argument — hardcodes its own 24, and `cron-sessions-sweep/index.ts:32` reads a **third** copy from a `COOLDOWN_HOURS` environment variable. Four places, one of which is a lie.

- [ ] **Step 1: The migration** — `set_pass_cooldown_flag()` takes `cfg := public.property_config(new.property_id)`, reads `(cfg #>> '{cooldown,hours}')::int`, and short-circuits `RETURN new` when it is `0` (which is what the column's `NULL = no cooldown enforcement` comment has always claimed). It also honours `cfg.passes.monthly_exempt_from_cooldown` when the new row is a monthly pass. `count_on_cooldown(p_property_id, p_hours)` keeps its signature — the dashboard calls it positionally — but its default changes from a literal `24` to `NULL`, and a `NULL` `p_hours` resolves through `property_config()`.

- [ ] **Step 2: The tests, in this order**

```python
async def test_charlottes_cooldown_is_unchanged_with_a_null_config(db_conn, seed_truck_plaza):
    """Charlotte has cooldown_hours = 24 and config = NULL. A truck that left
    23 hours ago must still be flagged; one that left 25 hours ago must not."""

async def test_an_apartment_with_null_cooldown_hours_is_still_never_flagged(...)
    """NULL cooldown_hours has always meant no enforcement. It still does."""

async def test_count_on_cooldown_with_no_second_argument_matches_the_trigger(...)
    """The dashboard tile and the flag must agree, which is exactly what four
    independent copies of the number could not guarantee."""

async def test_a_configured_12_hour_cooldown_flags_at_13_hours(...)

async def test_a_monthly_pass_holder_is_exempt_when_configured(...)
```

- [ ] **Step 3:** `_DEDUP_HOURS` and the re-registration `interval '24 hours'` become `cfg.cooldown.notice_dedup_hours`. Apply, regen, full suite, commit.

---

## Task 9: Plate-confidence floors and grace windows behind the loader

**Files:**
- Modify: `services/plate_matcher.py` — the seven module constants at **lines 59–65** (`PLATE_CONFIDENCE_MIN`, `CAMERA_SUSPEND_THRESHOLD`, `CAMERA_SUSPEND_MIN_EVENTS`, `CAMERA_SUSPEND_DURATION_MIN`, `GRACE_MINUTES`, `MIN_CONFIRMING_EVENTS`, `CONFIRM_WINDOW_MIN`), their uses at 126, 127, 179, 308, 311, 363, 366, 376, **and the module docstring at lines 13–32**
- Test: `tests/test_plate_matcher_config.py`

**Interfaces:** the constants stay as module-level names **re-exported from `PropertyConfig` defaults** (`PLATE_CONFIDENCE_MIN = PropertyConfig.defaults().pipeline.plate_confidence_min`) so nothing that imports them breaks, and every *function* in the module takes `cfg: PropertyConfig` and reads `cfg.pipeline.*`. The matcher already loads the event's `property_id` in `_load_event`, so the config load costs one extra query per event, cached for 60 s — measured against the 150–1,000 plate reads a day one site produces, that is effectively one query per minute per site.

**The one real behaviour change in this wave, called out here:** `GRACE_MINUTES = 10` in `plate_matcher.py` disagrees with `GRACE_EXPIRY_MINUTES = 15` in the sweep that actually files the violation. Converging on 15 widens the grace window in the matcher by five minutes — i.e. it makes the system *less* likely to flag an innocent registrant, which is the direction `plate_matcher.py`'s own docstring says to err in ("an innocent registrant being auto-towed is a worse failure than missing a real violation"). Verify it explicitly, and state it in the commit message rather than letting it ride as an implementation detail.

**Fix the docstring, which is already lying.** `plate_matcher.py`'s module docstring is the first thing any reader — human or agent — sees about how enforcement is gated, and two of its numbers have been wrong for months:

| Docstring says | Constant actually is |
|---|---|
| `:15` — "Per-camera OCR confidence floor (PLATE_CONFIDENCE_MIN, default **0.85**)" | `:59` — `0.92` |
| `:24` — "we wait GRACE_MINUTES (default **15**)" | `:63` — `10` |

That is a third stale copy of both numbers, in the one place nobody greps. The census test in Task 15 cannot catch it (it is prose, and the value `0.85` appears nowhere else), so it has to be fixed by hand here. **Rewrite the docstring to name the config keys, not values** — "below `cfg.pipeline.plate_confidence_min`", "we wait `cfg.grace.registration_minutes`" — so it cannot go stale again. Keep every word of the safety rationale; it is the best statement of intent in the repo and the reason `min_confirming_events` is `ge=2`.

- [ ] Steps: the docstring rewritten to name `cfg.pipeline.*` / `cfg.grace.*` rather than literals → defaults re-exported → each function takes `cfg` → a test per constant proving the default path is unchanged → one test proving a per-property override takes effect → the grace convergence test, named `test_the_matcher_and_the_sweep_now_agree_on_the_grace_window` → one test asserting the docstring contains no bare decimal that duplicates a `pipeline.*` default.

---

## Task 10: `services/lot_time.py` — one timezone helper, three call sites now

**Files:**
- Create: `services/lot_time.py`
- Modify: `routers/app_api.py:66` (`LOT_TZ`), `routers/quickbooks.py:199` (`tz_name`), `services/apartment_notify.py:327` (inline `_zi("America/New_York")`)
- Modify (frontend): `frontend/src/lib/lotdate.js` (accept a timezone argument), `frontend/src/pages/TruckParkingLog.jsx` (pass the property's)
- Test: `tests/test_lot_time.py`
- **Not modified:** `services/plaza_notify.py`, `services/plaza_reconcile.py`, `services/tow_digest.py` — see the scope note below.

**Scope, corrected (D3).** An earlier draft of this task listed `tow_digest.py` and `plaza_reconcile.py` as owning `_LOT_TZ`. They do not. There is **one** `_LOT_TZ`, defined at `services/plaza_notify.py:33`, and both of those modules import it. That matters because:

- `services/plaza_notify.py` is read-only this wave (Global Constraints), and
- `services/plaza_reconcile.py` is on the **never-edit** list outright.

So the three-file chain cannot be migrated here without editing a forbidden file, and it is **deferred to the Stripe-cutover rebase** (decision D11). Inventory row 35b records it; Task 15's census allowlist names `services/plaza_notify.py:33` explicitly so the drift guard does not go red on a literal nobody is allowed to touch. The deferral costs nothing today — all three modules serve the Charlotte plaza, which is in Eastern time — and it stops this task from being un-executable as written.

Two literals are also **out of scope permanently** for this task: `supabase/functions/weather-pull/index.ts:15` and `weather-risk-eval/index.ts:21`. Both jobs are switched off in the database and both are on fat decision 13's delete list; migrating a timezone into a job you may be deleting is the fat this program exists to stop.

**Interfaces:** `lot_tz(cfg) -> ZoneInfo`, `lot_now(cfg)`, `lot_day_bounds(cfg, ymd) -> tuple[datetime, datetime]` (UTC instants), `fmt_local(cfg, dt, fmt)`. Every one takes the config, never a bare string, so a caller cannot forget.

**`quickbooks.py` is the interesting one, and it has a second timezone home.** Line 199 carries `tz_name = "America/New_York"  # property table doesn't carry market_id today; default tz.` — a comment naming the missing column — and then lines 200–205 try to recover a real zone by hopping `Property → Lot → Market` to reach `markets.timezone` (`models.py:27`, same default), which only resolves when the property is *also* present in the legacy `lots` table. After this task `config.timezone` is the answer and the `markets.timezone` hop becomes the fallback **under** it, exactly as `properties.cooldown_hours` sits under `cooldown.hours` in Task 8. Do not delete the market hop and do not duplicate the value into both — resolve in one place, `lot_tz(cfg)`, and let it consult the market only when the config is silent.

`frontend/src/lib/lotdate.js:9` says `// Wave 2 replaces the constant with a properties.timezone column.` Keep `LOT_TIMEZONE` as the module default so every existing call site behaves identically, add `timeZone` as an optional argument to `tzOffsetOn` / `tzOffsetAt` / `lotDayBound` (the first two already take it), and thread the property's value in from the Parking Log. A property whose config has never been written sends the same string it sends today.

- [ ] Steps: the module → the three backend call sites → the `markets.timezone` fallback wired under `lot_tz` → the frontend argument → tests including a DST-boundary case (`lot_day_bounds(cfg, "2026-11-01")` must span 25 hours), one asserting a `Pacific/Honolulu` config actually shifts the day, and one asserting a NULL config still produces byte-identical bounds to today's `lotdate.js` output for the 8 PM–midnight window that Wave 1 item 8 fixed.

---

## Task 11: `services/notices.py` — recipients and overrides, per property

**Files:**
- Create: `services/notices.py`
- Modify: `services/cooldown_notice.py:170-176`, `services/reregistration_notice.py:156-162`, `services/apartment_notify.py:54 staff_recipients()`
- Migration: `migrations/20260914HHMMSS_notice_override_stamp.sql` — `outbound_notices.overridden_to text` (the table exists; Wave 2.7 Task 12 built it)
- Test: `tests/test_notices_resolution.py`

**PLATFORM-5, structurally.** Today `COOLDOWN_EMAIL_OVERRIDE_TO` is one string in one Railway variable box that **replaces every recipient at every site at once**, read in two backend modules; `EMAIL_OVERRIDE_TO` is its twin in two edge functions; and nothing in the code, the dashboard or an email body says an override is active. Wave 1 item 12 unset the secret and added a start-up warning. This task makes it per-property and makes a redirected send *visible forever after*.

**Interfaces:**

```python
@dataclass(frozen=True)
class Resolved:
    to: list[str]
    from_email: str
    overridden_from: list[str] | None   # the real recipients, when an override fired
    reason: str                         # "normal" | "override" | "disabled" | "no_recipient"

def resolve_recipients(cfg: PropertyConfig, *, partner_email: str | None,
                       owner_email: str | None = None, kind: str) -> Resolved: ...
```

Precedence, in one place: `notices.dispatch_enabled = false` → `Resolved(to=[], reason="disabled")`; else `notices.override_to` → replaces everything, `overridden_from` records who it displaced; else the natural recipients (`partner_email` when `notices.partner_email_enabled`, plus `notices.owner_cc`, plus `notices.extra_recipients`, plus `notices.staff_extra`), de-duplicated, order preserved. The env vars stay as a **deployment-wide fallback for one release** (`cfg.notices.override_to or settings.cooldown_email_override_to`) so this task cannot break a live send, and Task 15's census records the fallback as scheduled for deletion.

- [ ] Steps: the module + its precedence table → three call sites rewired → `overridden_to` stamped on `outbound_notices` → a dashboard badge is Task 4's job (add it there if Task 4 has already landed, else file it) → tests: default config reproduces today's list exactly; an override replaces and stamps; a disabled site sends nothing and says why; `extra_recipients` adds and never replaces.

---

## Task 12: `services/revenue.py` — the per-property split override

**Files:**
- Create: `services/revenue.py`
- Modify: `routers/violations.py:431, 512, 766`, `routers/snapshots.py:192`
- Test: `tests/test_revenue_split.py`

**Interfaces:** `revenue_split(cfg, partner) -> Decimal` and `fees(cfg, partner) -> tuple[int, int]`, both returning the partner row's value when the config override is `None` — which is every property on day one.

**Do not disturb SEC-5.** `tests/test_partner_allowlist.py` proves a partner login cannot set its own `revenue_share`, and `migrations/20260903125943_enforcement_partners_revoke_fee_update.sql` revokes the column-level UPDATE. A config override is platform-admin-only by construction (Task 3), so those tests are untouched — and this task adds one more: `test_a_partner_cannot_reach_the_config_override`.

- [ ] Steps: the helper → four call sites → tests: default config gives byte-identical `our_revenue` for the existing fixtures; an override of `0.30` changes it; a partner token gets 403 on the config PUT.

---

## Task 13: Absorb `TOW_FOOTAGE_RETENTION_OVERRIDES` into `config.tow_evidence`

**Files:**
- Modify: `services/tow_retention.py`, `services/tow_digest.py:470-471`, `routers/ops.py:399-400`
- Test: `tests/test_tow_retention.py` (extend), `tests/plaza/test_tow_sightings_service.py` (extend)

**Why this one and not another.** `TOW_FOOTAGE_RETENTION_OVERRIDES` is the per-camera override pattern that *already shipped* — `"<camera-mac>:2"` typed into a Railway variable box, parsed by a hand-rolled string splitter that silently skips a malformed entry, because the north camera's SD card recycles in ~2.3 days while the south's takes ~32. It is exactly the shape Wave 3.4 needs for `alpr_cameras.config`, and it is the safest possible place to prove that shape: two cameras, one site, and the worst case of getting it wrong is a digest line that says the wrong expiry date rather than a truck that gets towed.

**Interfaces:** `camera_retention_days(cfg: PropertyConfig, api_key: str, settings) -> int` — prefers `cfg.tow_evidence.cameras[api_key].footage_retention_days`, falls back to `parse_overrides(settings.tow_footage_retention_overrides)`, falls back to `cfg.tow_evidence.footage_retention_days`, falls back to `settings.tow_footage_retention_days`. `parse_overrides` itself is **unchanged** — its `days < 1` rejection and its skip-a-malformed-entry behaviour are load-bearing and already tested.

The retention table is bound into SQL in `services/tow_sightings.py` (Postgres applies each row's own retention rather than resolving in Python per row); that binding now receives the merged table from `camera_retention_days`, not `parse_overrides` directly.

- [ ] Steps: the resolver → the SQL binding takes the merged table → `GET /ops/tow-sightings`'s `retention_overrides` field reports the merged table and says which source won → tests: env-only still wins with a NULL config (today); config beats env; a malformed env entry with a valid config entry is still safe.

---

## Task 14: Edge functions read the same config

**Files (frontend repo, `/Users/gabe/lotlogic`):**
- Create: `supabase/functions/_shared/propertyConfig.ts`
- Modify: `supabase/functions/cron-sessions-sweep/index.ts` (lines 30, 31, 32, 38, 394, 402)
- Modify: `supabase/functions/camera-snapshot/sessions.ts` (`findCooldownPriorSession`'s `select("cooldown_hours")`) and `index.ts` (`SESSION_IDLE_MINUTES`, `PR_MIN_SCORE`, `PR_MIN_PLATE_LEN`, `REQUIRE_VEHICLE_SCORE`)
- Modify: `supabase/functions/cron-no-reg-sweep/index.ts` (`GRACE_MS`)
- Modify: `supabase/functions/tow-confirm/index.ts` (lines 26, 27, 247, 307, 317, 318)
- Modify: `supabase/functions/tow-dispatch-email/index.ts` (lines 13, 107, 559, 567, 765)
- Test: `supabase/functions/_shared/propertyConfig.test.ts`, plus a parity test

**Interfaces:**

```ts
// supabase/functions/_shared/propertyConfig.ts
//
// The edge half of services/property_config.py. One RPC per property per
// invocation, memoised — a sweep tick touching forty passes across two
// properties makes two calls, not forty.
//
// It calls public.property_config(uuid), the SAME SECURITY DEFINER function
// the triggers call, so an edge function and a trigger can never disagree
// about a site's rules. There is no second copy of the defaults here, and
// there must never be one: if the RPC fails, this throws rather than falling
// back to a guess, because a guessed cooldown window is a wrongly-flagged
// truck.
export type PropertyConfig = { /* mirrors DEFAULTS_JSON */ };
export async function getPropertyConfig(
  db: SupabaseClient, propertyId: string,
): Promise<PropertyConfig>;
export function resetPropertyConfigCache(): void;   // tests only
```

**The deletion is the point.** Each of these files currently reads its own `Deno.env.get(...)` copy of a number that also exists in Postgres or Python. After this task:
- `COOLDOWN_HOURS` (cron-sessions-sweep:32) — **deleted**, config only.
- `GRACE_EXPIRY_MINUTES` (:38) and `GRACE_MS` (cron-no-reg-sweep:13) — **deleted**, both read `grace.registration_minutes`.
- `OVERSTAY_GRACE_MINUTES`, `EXIT_HINT_BUFFER_MINUTES`, `DISPATCH_HOLD_MINUTES`, `OVERSTAY_MAX_AGE_HOURS` — **deleted**.
- `EMAIL_OVERRIDE_TO` in both functions — reads `notices.override_to`, env kept for one release as a deployment-wide fallback.
- `OWNER_CC_EMAIL`'s personal-address default — **deleted**; `notices.owner_cc`, default null.
- `formatLocal(ts, tz = "America/New_York")` ×3 — the default argument becomes required and is supplied from `config.timezone`.
- `TOW_CONFIRM_MIN_CONFIDENCE`, `TOW_CONFIRM_LOOKBACK_MINUTES`, `ARRIVAL_NOTIFY_COOLDOWN_MIN` — config, env fallback for one release.
- **Left alone:** `PR_MIN_SCORE_OVERRIDES`, `SKIP_SIDECAR_MACS`, `ROTATE_BEFORE_PROCESS`, `EXIT_MIN_DWELL_MINUTES`, `TRUCK_FUZZY_CANCEL_MIN` — Wave 3.4 (scope call §2).

- [ ] **Step 1:** the shared module + its test (memoisation; an RPC error throws and does not guess).
- [ ] **Step 2:** cron-sessions-sweep — the biggest single win, six constants.
- [ ] **Step 3:** camera-snapshot/sessions.ts — replace the one-column `select("cooldown_hours")` with `getPropertyConfig`, which is where the hot path already pays for a property read.
- [ ] **Step 4:** cron-no-reg-sweep, tow-confirm, tow-dispatch-email.
- [ ] **Step 5: the parity test.** One test that, for a fixture config document, asserts the TypeScript reader and `services/property_config.py` produce the same values for the eight keys the edge functions read. This is the same role `tests/plaza/test_property_config_sql.py` plays for the SQL half.
- [ ] **Step 6:** `deno check` on every touched function, then deploy each one **individually** and diff against `mcp__supabase__get_edge_function` first, per `CLAUDE.md`'s standing rule. `camera-snapshot` is the production ingest path — deploy it last, and watch `plate_events` for one camera cycle before calling it done.

---

## Task 15: Drift guard, generated key reference, `CLAUDE.md`

**Files:**
- Create: `tests/test_config_census.py`
- Create: `scripts/db/gen_property_config_doc.py`, `docs/db/property-config.md`
- Modify: `CLAUDE.md` (both repos), `docs/db/schema.md` (regenerated)

**The census test.** The failure mode this wave exists to prevent is not "a constant is in the wrong place" — it is "a constant comes back". `tests/test_config_census.py` greps the repo for each migrated literal and fails if it appears outside `services/property_config.py`, the migration that defines the SQL default, or an explicit allowlist with a one-line reason per entry. It is deliberately blunt and deliberately noisy:

```python
MIGRATED = {
    # value, the key that owns it now, where it is still legitimately allowed
    ("48.5", "passes.max_stay_hours", {"migrations/_archive/", "docs/"}),
    ("interval '24 hours'", "cooldown.hours", {"migrations/_archive/", "docs/"}),
    ("America/New_York", "timezone", {"services/property_config.py",
                                      "migrations/", "docs/",
                                      "frontend/src/lib/lotdate.js",     # the fallback
                                      # DEFERRED, not missed — plaza_notify.py
                                      # is read-only this wave and
                                      # plaza_reconcile.py is never-edit, so
                                      # this one _LOT_TZ and its two importers
                                      # move on the Stripe-cutover rebase
                                      # (decision D11, inventory row 35b).
                                      # Delete this entry then; do not widen it.
                                      "services/plaza_notify.py",
                                      # Both jobs are inactive and on fat
                                      # decision 13's delete list.
                                      "supabase/functions/weather-pull/",
                                      "supabase/functions/weather-risk-eval/"}),
    ("GRACE_MINUTES", "grace.registration_minutes", {"services/property_config.py"}),
    # ... one row per inventory line
}
```

Same idea as `tests/test_money_columns_cents.py`, which already does this for the `_cents` naming rule and is the precedent to copy.

**The generated reference.** `docs/db/property-config.md` is produced from `PropertyConfig.model_json_schema()` plus the inventory's "where it lives today" column, so the document cannot drift from the model. Regenerating it is a step in `scripts/db/regen_expected.sh`.

**`CLAUDE.md`**, both repos: a new "Per-property configuration" section saying, in four lines — the config lives on the row; the loader is `services/property_config.py`; SQL reads `public.property_config(uuid)`; **a new per-site number goes in the model, never in a constant.** Delete the now-false lines: the backend `CLAUDE.md`'s env-var inventory drops the six edge constants Task 14 deleted, and the `properties.cooldown_hours` description gains "read through `property_config()`; the trigger no longer carries its own 24."

- [ ] Steps: the census test (expect it to fail on first run and to name real leftovers — fix them) → the doc generator → `regen_expected.sh` calls it → `CLAUDE.md` in both repos → final full-suite + `schema-rebuild` + `schema-drift` green → commit.

---

## Decisions for Gabe

Each one is a thing you can picture, then one yes/no question with the answer I would take if you say nothing.

**1. Which numbers are per-site, and which stay one number for the whole company.**
*What/where:* The inventory above has 58 rows. Roughly forty of them are site policy — how long a truck may stay, how long the cooldown runs, what the grace window is, what timezone the lot is in, who gets the email, what your cut is. About a dozen are OCR safety numbers: the plate-confidence floor (0.92), the camera-suspension threshold (0.70), the two-reads-before-a-violation rule. Those last ones are not really about a site; they are about how much you trust a camera.
**Q: Put only the site-policy numbers on the property row, and leave the OCR safety floors as one company-wide number (still readable per-site, but nobody gets a UI to change them)?** *Recommended: **yes**. The confidence floor is the last thing between an OCR mistake and a tow; it should take a deploy and a code review to move, not a form field.*

**2. The monthly parking pass — price and term.**
*What/where:* `app_rates.monthly_pass = 15000` is already sitting on the Charlotte Travel Plaza row in the live database — $150 — next to `h24_weekday: 3500` and `h48_weekend: 5500`. Nothing has ever sold it, because the 48-hour trigger rejects the pass. Task 7 makes it sellable and needs to know the term.
**Q: Ship it as $150 for 30 days at Charlotte Travel Plaza?** *Recommended: **yes**. It is the number already in the database, and 30 days is what "monthly" means to a driver. Changing it later is one config edit, not a deploy — which is the whole point of this wave.*

**3. Does a monthly holder sit out the 24-hour cooldown?**
*What/where:* The cooldown rule says a truck that leaves must wait 24 hours before coming back, and re-registering inside that window flags the pass and emails the tow partner. A monthly holder is, by definition, going to come and go for thirty days.
**Q: Make a monthly pass exempt from the cooldown flag for the life of the pass?** *Recommended: **yes**. Otherwise every monthly customer generates a tow alert the second time they use the lot, and your partner learns to ignore the alerts.*

**4. A per-property cut, on top of the partner's default.**
*What/where:* `enforcement_partners.revenue_share` is 0.25 and applies to every property that partner works. Today there is no way to say "at this one site the split is 30%".
**Q: Add a per-property override that only you (platform admin) can set, leaving the partner's 25% as the default everywhere it isn't set?** *Recommended: **yes**. It is null everywhere on day one, so nothing changes, and the partner-can't-edit-their-own-fee protections stay exactly as they are.*

**5. Where the policy text lives.**
*What/where:* The truck-plaza policy — the seven numbered rules drivers agree to on the QR form — lives in `properties.policy_text` per site, but the *default* for a brand-new plaza is Charlotte's rules, hardcoded in `frontend/src/shared/policy.js`. So plaza #2 would silently inherit Charlotte's CAT-scale and diesel-island rules.
**Q: Leave the actual text in `policy_text` where it is, and turn the Charlotte default into a template you pick in the editor rather than something a new site inherits automatically?** *Recommended: **yes**. A new site starting with no policy is obvious and fixable; a new site starting with someone else's policy is invisible and legally awkward.*

**6. Making an email redirect impossible to forget.**
*What/where:* `EMAIL_OVERRIDE_TO` silently redirects every tow-dispatch email to one address instead of the partner's inbox, at every site at once. Nothing in the code or the dashboard says it is on. It is off now, but the mechanism is still there and you will use it again the next time you test something.
**Q: When an override is on, stamp every redirected email in the database and show a permanent banner on that property's page saying "notices are being redirected to X"?** *Recommended: **yes**. This is the cheap half of the fix; the expensive half is the week you spend wondering why the partner never got the email.*

**7. Who may edit a site's rules.**
*What/where:* A property owner logs in and can already edit their property row directly through the database API from the browser. Cooldown hours, stay caps and notice recipients are enforcement settings; a leasing office setting its own cooldown to zero would be a silent, invisible change to what gets towed.
**Q: Platform-admin only for editing, with owners getting a read-only "Site rules" card so they can see what their site is set to?** *Recommended: **yes**. Wave 2.2 adds real roles; when it lands, "property manager may edit these four keys" becomes a one-line change instead of a re-architecture.*

**8. Timezone, now or when it bites.**
*What/where:* Eleven places in the two repos have `America/New_York` typed into them. Every property you have is in Eastern time, so nothing is wrong today. The first Central-time site makes all eleven wrong at once, in the quiet way — a parking log that ends the day an hour early, a digest that goes out at 6 AM instead of 7. (Task 10 moves five of them; three more are deferred by decision 11 below and two are in jobs that are switched off.)
**Q: Set every existing property's timezone to `America/New_York` explicitly in the same migration, so behaviour is provably unchanged and site #11 is a form field?** *Recommended: **yes**. It is one line of SQL now and a bug hunt across two codebases later.*

**9. The two grace windows that disagree.**
*What/where:* When an unregistered truck is first seen, the system waits before treating it as a violation. The Python matcher waits 10 minutes; the sweep that actually files the violation waits 15. The sweep wins, so the real answer is 15 — the 10 has quietly never mattered.
**Q: Standardise on 15 minutes (the number that already governs enforcement) rather than 10?** *Recommended: **yes**. It is the behaviour you already have; making the other copy agree just stops the next reader mis-predicting the system.*

**10. The camera-retention overrides in the Railway box.**
*What/where:* `TOW_FOOTAGE_RETENTION_OVERRIDES=<camera-mac>:2` is a string in a Railway variable box saying the north camera's SD card only holds about two days of footage, against a ten-day default. It works. It is also the exact shape every future per-camera setting wants, and it is invisible to anyone who does not know to look in Railway.
**Q: Move it into the property's config (keeping the Railway variable working as a fallback for one release) so it shows up in the editor alongside everything else?** *Recommended: **yes**. Low stakes — the worst case of getting it wrong is a wrong expiry date in a digest email — which is exactly why it is the right place to prove the pattern before Wave 3.4 uses it on the tow path.*

**11. The three plaza files this wave has to leave alone.**
*What/where:* The daily tow digest, the money reconciliation and the plaza pass emails all get their "what time is it at the lot" from one line in `services/plaza_notify.py`. That file — and `plaza_reconcile.py`, which imports from it — are the Stripe cutover's files, and this plan's own rule is that nobody else edits them until that lands. So three of the eleven timezone literals stay put for now. It costs nothing today: all three serve Charlotte, which is Eastern.
**Q: Leave those three alone and move them as the first commit after the Stripe cutover merges, rather than making an exception to the never-edit rule now?** *Recommended: **yes**. The never-edit rule on the money files is the reason the pay-to-park path has stayed clean; spending it on a timezone constant that is currently correct is a bad trade.*
