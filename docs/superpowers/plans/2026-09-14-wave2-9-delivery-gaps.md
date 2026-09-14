# Wave 2.9 — Close the Delivery Gaps Wave 1 Exposed

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** every one of the 16 edge functions deploys from one workflow with a type-check and test gate in front of it; every production deploy of the backend and the frontend leaves a git tag behind so a rollback has a name; the three rollback procedures are written down where a stranger can follow them at 2 a.m.; the two money surfaces with no endpoint tests get them against the real-Postgres harness; and the developer documents stop describing a product that was deleted in March.

**Architecture:** Three independent seams, plus a documentation seam that binds them.

1. **Edge delivery.** `supabase/functions/` is 11,014 lines of TypeScript across 16 slugs. Two auto-deploy (`camera-snapshot`, `cron-sessions-sweep`) via hand-written single-function workflows with hand-maintained `paths:` lists; the other 14 deploy when a human remembers. Nothing type-checks any of them and nothing runs the 92 Deno tests that already exist. This plan replaces the two workflows with one matrix workflow whose matrix is *computed* from the import graph — `camera-snapshot` imports `../pr-ingest/r2.ts` and `cron-no-reg-sweep` imports `../camera-snapshot/no_reg_violations.ts`, so a hand-maintained path list is a bug waiting to happen and already is one.
2. **Named deploys.** Both repos have **zero git tags and zero GitHub releases** (verified 2026-09-14). Railway and Vercel each deploy from `main` on push. A tag written by CI at the moment of the push is the cheapest possible name for "the thing that was running before the bad one", and it needs no provider API token.
3. **Endpoint tests.** `tests/plaza/` is a real-Postgres harness (920-line conftest, PostgreSQL 17, live-schema extract + replayed migrations, `app_client` over `main.app`). QuickBooks invoicing (12 endpoints) has 37 lines of test — two unit tests on a pure payload builder. The reservation app (10 endpoints) has 133 lines covering phone normalisation and pricing arithmetic, and **zero endpoint tests**. Both are extended onto the existing harness rather than growing a second one, with QuickBooks and Stripe faked at the **HTTP boundary** (`httpx.MockTransport`, `stripe.default_http_client`) so the real OAuth refresh, retry and error-mapping code runs.
4. **Docs.** `RECOVERY.md` was last touched 2026-06-05 — it predates the live money path, counts 17 edge functions (there are 16), and has no rollback section at all. The backend `docs/` folder still ships an April plan for the retired camera-zone pipeline. Both `CLAUDE.md` files still describe `puller/`, `monitoring/`, `zone_guardian.py` and YOLO as live.

**Tech Stack:** Deno 2.7 (edge functions, `deno check` / `deno test`), Supabase CLI via `supabase/setup-cli@v1`, GitHub Actions (ubuntu-latest, Node 22), Python 3.11 + FastAPI + SQLAlchemy 2 async, pytest + pytest-asyncio, real PostgreSQL 17 via the CI service container, httpx, ruff 0.16.5 pinned, esbuild 0.28.2 (frontend), Railway (backend, deploy from `main`), Vercel (frontend, deploy from `main`).

**Spec:** `/Users/gabe/lotlogic/docs/superpowers/specs/2026-09-03-enterprise-readiness-program.md` — §3 Wave 2 item **2.9**, merging Appendix A findings **PIPE-3, PIPE-18, DEL-9, DEL-11, DEL-13, DEL-6, BACKEND-11, REL-8, REL-16, DB-9, DB-8, DB-10, SEC-3, SEC-14, SEC-15, BACKEND-16, BACKEND-18, BACKEND-20, FE-8, PIPE-11**. Read the 2.9 row and those twenty Appendix A rows before Task 0. The §2 items (Wave 1) and Wave 2.4 / 2.6 / 2.7 / 2.8 are prerequisites or neighbours — see "What is already true" below.

---

## What is already true (verified against `origin/main` on 2026-09-14)

**Read this before you start. Both local working trees are stale** — `/Users/gabe/lotlogic` is on `feat/apartment-permit-registry`, 131 commits behind `origin/main`; `/Users/gabe/lotlogic-backend` is on a local `main` that is 124 commits behind `origin/main`. This is the AUTO-1 / DEL-5 problem the program doc names in §2 item 10. **Every task below starts by branching from `origin/main`, not from whatever is checked out.**

Landed already — do not redo:

| Wave | What landed | Evidence on `origin/main` |
|---|---|---|
| W1 #1 | ruff pinned, rule set explicit | `lotlogic-backend/ruff.toml` has `select = ["E4","E7","E9","F"]`; `requirements-dev.txt` exists |
| W1 #4 | `/ready`, restart limit 10 | `railway.toml`: `healthcheckPath = "/ready"`, `restartPolicyMaxRetries = 10` |
| W1 #16 | lockfile, dev deps split, dependabot, pip-audit | `requirements.lock`, `scripts/gen_requirements_lock.py`, `.github/dependabot.yml`, `pip-audit` step (advisory) |
| W1 #17 | request ids + Sentry | `services/observability.py`, wired in `main.py` |
| W2.6 | dashboard build + module split | `frontend/src/` (54 modules), `frontend/scripts/build.mjs`, `.github/workflows/frontend-build.yml`, `npm run check:naming` |
| W2.7 | monitoring spine | `services/alerts.py`, `db_watchdog.py`, `job_registry.py`, `job_locks.py`, `outbound_notices.py`, `routers/ops.py`, `.github/workflows/uptime.yml` |
| W2.8 | cloud scheduler + findings ledger | `services/findings.py`, `tests/plaza/test_ops_findings*.py`, `ops_job_runs` `'railway'` source |
| — | CI runs a real Postgres 17 service container | `lotlogic-backend/.github/workflows/ci.yml` sets `TEST_DATABASE_URL` |
| — | frontend design docs archived | `lotlogic/docs/archive/` (46 documents), `docs/README.md` says what is still true |

**NOT landed — and 2.9 depends on parts of it:**

- **Wave 2.4 (schema baseline) has not shipped.** There is no `0000_baseline` migration, no `scripts/migrate.sh`, no drift-check CI job. `migrations/` holds 139 files, one of which (`20260818_visitor_passes_cooldown_indexes.sql`) is not in `YYYYMMDDHHMMSS_` form. 2.4's plan owns a `RECOVERY.md` edit to §1/§7/§10 about schema rebuildability — **that edit is 2.4's, not this plan's.** Task 7 here rewrites §3, §4 and adds a new §12 (rollback); it must not touch §7, and must not claim the schema is rebuildable. If 2.4 lands first, Task 7 merges around it; if 2.9 lands first, 2.4's Task 8 merges around Task 7. Both are additive to different sections, so either order works.
- **PIPE-11 (frontend design docs describe a dead system) is already mostly closed** by the 2026-09-03 archive move. The backend repo never got the same treatment — that is Task 8.

**Measured facts this plan is built on (re-measure if you are reading this weeks later):**

- 16 edge-function slugs, 11,014 lines of TypeScript. `deno check` run with CWD **inside each function directory**: **13 pass, 3 fail** — `cron-sessions-sweep` (1 error), `tow-dispatch-email` (3), `walk-around-ocr` (25). Run from the parent directory instead, 10 of 16 fail, because Deno discovers `deno.json` by walking up from the **CWD**, not from the entry file. The gate must `cd` into the slug. Six slugs have no `deno.json` at all (`check-violations`, `notify-expiring-plates`, `simbase-usage`, `tow-confirm`, `tow-dispatch-email`, `tow-dispatch-sms`) — they happen to pass because they import everything by full URL.
- `deno test` today: `pr-ingest` 22 pass, `cron-sessions-sweep` 11 pass, `cron-no-reg-sweep` 4 pass, `camera-snapshot` **55 pass / 2 fail**. That is PIPE-3's "its suite is red", and the cause is one missing method on a test stub (Task 2).
- Five edge functions hold `SUPABASE_SERVICE_ROLE_KEY` and gate on nothing: `camera-watchdog`, `cron-no-reg-sweep`, `cron-plate-pair-learn`, `weather-pull`, `weather-risk-eval`. Two more (`simbase-usage`, `walk-around-ocr`) gate only on Supabase's default JWT check, which the **public** anon key satisfies. That is SEC-3.
- Live camera credentials (`alpr_cameras.api_key`, the MAC the ingest path matches on) are committed in seven places across both repos: `camera-snapshot/extract.ts:210,257`, `config.py:254`, `lotlogic-backend/CLAUDE.md:162`, `tests/test_tow_retention.py:19`, `tests/plaza/conftest.py:111-112`, and four `tests/plaza/test_tow_*.py` files. That is SEC-14, and it is wider than the finding says.
- Secret scanning is a Claude Code `PreToolUse` hook (`.claude/hooks/pre-commit-secrets-scan.sh`) in both repos. It fires on `Write|Edit|MultiEdit` — a `git commit` typed in a terminal, or made by anyone who is not Claude, bypasses it entirely. That is SEC-15.
- `.env.example` documents **17** variables. `config.Settings` has **77** fields. That is BACKEND-20.
- 11 `setInterval` call sites in `frontend/src/`; exactly one file (`ALPRPropertyDetailPage.jsx`) listens for `visibilitychange`. That is FE-8.
- `set_pass_cooldown_flag` has been rewritten **7 times** across `migrations/`, `enforce_truck_plaza_cooldown` **5 times** — the most-rewritten business logic in the system, and there is no test that asserts the trigger's truth table. That is DB-9.
- `visitor_passes.cancelled_by` is free text; `routers/visitor_passes.py:276` branches a tow-relevant display on `cancelled_by.startswith("camera_exit")`, and `routers/visitor_passes.py:89` appends a free-text reason as a suffix of the same column. That is DB-8.
- Zero git tags and zero GitHub releases in either repo. That is DEL-11.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Branch from `origin/main`.** `git fetch origin && git switch -c <branch> origin/main`. Never branch from the stale local checkout.
- **Never edit these files.** `routers/plaza_payments.py`, `services/plaza_settle.py`, `services/square*.py`, `services/stripe_plaza.py`. The Stripe cutover owns them. This is why Square is faked nowhere in this plan (see Scope call 4) and why BACKEND-18's existing in-process rate limiter is not touched (Scope call 6).
- **Backward compatible.** No endpoint changes shape. No column is dropped. No edge function changes its request or response contract. A migration adds; it does not rewrite. The only behaviour changes a user could notice are (a) an idle dashboard tab stops polling (Task 15) and (b) five internal edge functions start requiring the `INTERNAL_TOKEN` they should always have required (Task 4) — both are called out in their tasks with the rollback.
- **No new secrets, no new accounts.** Everything here runs on secrets that already exist: `SUPABASE_ACCESS_TOKEN` (GitHub Actions, frontend repo), `INTERNAL_TOKEN` (Supabase edge secrets and GitHub Actions), `GITHUB_TOKEN` (automatic). If a task appears to need a new one, stop and put it in "Decisions for Gabe" instead of inventing it.
- **No secret VALUES in git, ever** — including in a test fixture, a comment, a doc, or a workflow `env:` default. Task 4 removes the ones that are already there; do not add more. Camera MACs count as secrets: they are the only credential the camera ingest path checks besides the URL secret.
- **CI must stay green at every commit.** `ruff check .` → `python -m compileall -q -f .` → `pytest -x --tb=short -q` on the backend; `npm ci && npm run build && npm run check:naming && npm test` in `frontend/`; the Playwright `e2e (local dist)` job. A task that cannot make all of those pass is not done.
- **Tests must be able to fail.** Every new test file gets one deliberate-break check recorded in the task: invert an assertion or break the code under test, watch the test go red, revert. A test that cannot fail is worse than no test — it is a green light wired to nothing. The 2 red `camera-snapshot` tests (Task 2) are the counter-example this whole wave exists to prevent: they were red for months and nothing looked.
- **Backend test conventions.** pytest-asyncio runs in **strict** mode (no ini file), so every coroutine test outside `tests/plaza/` needs `@pytest.mark.asyncio`. Tests inside `tests/plaza/` get the marker automatically from that package's `pytest_pycollect_makeitem` hook and run against real Postgres 17 — CI service container via `TEST_DATABASE_URL`, locally an `initdb` cluster from `/opt/homebrew/opt/postgresql@17/bin`, **skipped** if neither. Use `tests/plaza/` for anything that touches a table.
- **Migrations:** `migrations/YYYYMMDDHHMMSS_snake_case_name.sql` (`date -u +%Y%m%d%H%M%S`). Every migration applied to prod exists as a file **and** as a row in `supabase_migrations.schema_migrations` — apply via the Supabase MCP `apply_migration` or the CLI, never the raw SQL editor. Every new table gets `ENABLE ROW LEVEL SECURITY` and `REVOKE ALL … FROM anon, authenticated` in the same file.
- **Edge functions:** before overwriting a deployed function, diff against the deployed copy (`mcp__supabase__get_edge_function` or `supabase functions download <slug>`). The repo has drifted from the runtime before. After Task 3 the workflow is the only thing that should deploy, but the drift check stays mandatory for the first run.
- **Ruff rule set unchanged.** `select = ["E4","E7","E9","F"]`, `ignore = ["E712","E701"]`. Do not add rules; do not remove the ignores.
- **The user-facing naming rule applies to anything a customer can read** — "parking pass" only, never Resident / Visitor / Permanent / Temporary / Guest / Driver. Ops surfaces (workflow names, tag names, log lines, `RECOVERY.md`) are exempt, but `frontend/` is not: `npm run check:naming` enforces it and will fail the build.
- **Commits:** one per task, conventional prefix (`feat:` / `fix:` / `test:` / `chore:` / `docs:` / `ci:`). Append:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_012CxJpLkSpNFeXLVTrUfhWo
  ```
- **Do not push to `main` without asking.** Railway auto-deploys from `main`; Vercel auto-deploys from `main`; after Task 3, Supabase auto-deploys from `main` too. There is no staging (that is Wave 3.3).

---

## File Structure

### Frontend repo (`getlotlogic/lotlogic`)

| File | Responsibility |
|---|---|
| `supabase/functions/_ci/slugs.mjs` **(new)** | The import-graph walker. Enumerates slugs, resolves each one's transitive local file set, answers "which slugs does this changed-file list affect". No dependencies — plain Node 22. |
| `supabase/functions/_ci/slugs.test.mjs` **(new)** | Node `--test` coverage of the walker, including the two real cross-function edges. |
| `supabase/functions/_shared/internal_auth.ts` **(new)** | One `requireInternalToken(req)` used by the five functions that have no gate today. |
| `supabase/functions/{cron-sessions-sweep,tow-dispatch-email,walk-around-ocr}/index.ts` *(modify, Task 1)* | The 29 type errors. Six slugs have no `deno.json` and check clean without one — Task 1 deliberately does **not** add config files to live functions for cosmetic symmetry. |
| `supabase/functions/camera-snapshot/index.test.ts` *(modify, Task 2)* | The `visitor_passes` stub grows the `.in()` the production code has called since 2026-05-29. |
| `supabase/functions/{camera-watchdog,cron-no-reg-sweep,cron-plate-pair-learn,weather-pull,weather-risk-eval}/index.ts` *(modify, Task 4)* | Gate on `INTERNAL_TOKEN`. |
| `supabase/functions/camera-snapshot/extract.ts` *(modify, Task 4)* | The live MAC in the doc comment becomes a placeholder. |
| `.github/workflows/edge-functions.yml` **(new)** | check → test → changed-only deploy. Replaces the two single-function workflows. |
| `.github/workflows/auto-deploy-camera-snapshot.yml`, `auto-deploy-cron-sessions-sweep.yml` **(deleted, Task 3)** | Superseded. |
| `.github/workflows/deploy-tag.yml` **(new)** | Tags and releases every production (`main`) deploy as `frontend-<ts>-<sha>`. |
| `.github/workflows/secrets-scan.yml` **(new)** | gitleaks on every PR and push. |
| `.gitleaks.toml` **(new)** | Rule config + the narrow, commented allowlist. |
| `frontend/src/lib/visiblePoll.js` **(new)** | The pure, testable core of "poll only while the tab is visible". |
| `frontend/src/lib/visiblePoll.test.mjs` **(new)** | `node --test` coverage with a fake `document`. |
| `frontend/src/hooks.js` *(modify)* | `useVisiblePolling`; `useActiveRoster` and `useIntervalFetch` route through it. |
| `frontend/src/App.jsx`, `src/ui/ProofModal.jsx`, `src/pages/{TrainingPage,TowActivityPage,HqPage,ALPRPropertiesPage}.jsx` *(modify)* | The eight remaining raw `setInterval` sites. |
| `frontend/package.json` *(modify)* | `npm test` also picks up `src/lib/*.test.mjs`. |
| `RECOVERY.md` *(modify, Task 7)* | §3 and §4 corrected; new **§12 Rollback** with the three procedures. |
| `CLAUDE.md` *(modify, Task 8)* | The dead YOLO / zone / puller / monitoring sections go; the edge-deploy section describes the new workflow. |

### Backend repo (`getlotlogic/lotlogic-backend`)

| File | Responsibility |
|---|---|
| `.github/workflows/deploy-tag.yml` **(new)** | `backend-<ts>-<sha>` tag + release on every push to `main`. |
| `.github/workflows/secrets-scan.yml` **(new)**, `.gitleaks.toml` **(new)** | Same pair as the frontend. |
| `tests/plaza/schema/live_schema.sql` *(modify, Task 9)* | Adds `integrations`, `pending_invoices`, `alpr_violations`, `markets`, `lots`, `app_bookings`, `app_otp_codes` and the `v_violation_billing_status` view — verbatim from production. |
| `tests/plaza/conftest.py` *(modify, Task 9)* | Two new globs in `MIGRATION_GLOBS`, seven new names in `TRUNCATE_TABLES`, three new fixtures, camera MACs read from env. |
| `tests/plaza/fakes/__init__.py`, `tests/plaza/fakes/http.py` **(new, Task 10)** | `FakeHttp` — a route table plus a call log, exposed as an `httpx.MockTransport` handler and as a `stripe` HTTP client. |
| `services/quickbooks.py` *(modify, Task 10)* | One `_http_client()` factory; the four `httpx.AsyncClient(...)` call sites route through it. Behaviour identical. |
| `tests/plaza/test_quickbooks_endpoints.py` **(new, Task 11)** | 12 endpoints. |
| `tests/plaza/test_app_api_endpoints.py` **(new, Task 12)** | 10 endpoints. |
| `tests/plaza/test_cooldown_trigger.py` **(new, Task 13)** | The truth table for `set_pass_cooldown_flag` + `enforce_truck_plaza_cooldown`. |
| `migrations/20260914*_cancel_reason.sql` **(new, Task 14)** | `visitor_passes.cancel_reason` + a CHECK on `cancelled_by`. |
| `migrations/20260914*_hot_table_index_hygiene.sql` **(new, Task 14)** | Drops the duplicate indexes, adds the two missing FK indexes. |
| `migrations/20260914*_app_enabled_off_at_plaza.sql` **(new, Task 14)** | Wave 1 item 13's manual UPDATE, written down so a replay cannot re-open it. |
| `scripts/gen_env_example.py` **(new, Task 16)**, `.env.example` *(regenerated)* | 77 settings documented, and a test that fails when they drift. |
| `tests/test_env_example.py` **(new, Task 16)** | The drift gate. |
| `docs/README.md` **(new, Task 8)**, `docs/archive/**` **(new, Task 8)** | The backend gets the same "what in here is current" treatment the frontend got on 2026-09-03. |
| `CLAUDE.md` *(modify, Task 8)*, `recovery/db-state.md` *(modify, Task 7)* | Refresh. |

---

## Scope calls — where the merged findings meet the code

The doc merges twenty findings into 2.9. Not all twenty are delivery gaps, and two of them are already closed. Decisions, made here so no executor has to re-litigate them.

1. **PIPE-11 ("the design documents describe a system that no longer exists") — mostly DONE, remainder folded into Task 8.** The frontend repo archived 46 documents on 2026-09-03 (`docs/archive/`, `docs/README.md`). The backend repo did not: `docs/parking-violation-plan.md` (2026-04-17, 324 lines, the retired lots→properties plan), `docs/claude-code-setup.md` (2026-04-18), `docs/quickbooks-production-setup.md` (2026-04-18, still narrates a Resend→SendGrid migration as pending). Task 8 applies the frontend's own pattern to the backend. No new invention.

2. **BACKEND-16 ("biggest files hold several products; 38 functions too long to review") — OUT.** This is a refactor, not a delivery gap. The frontend half of the same problem was Wave 2.6 and took 9 days on its own; the backend equivalent (`routers/violations.py` 1,049 lines, `public_registration.py` 1,002, `apartment_passes.py` 899) is a Wave 3 shape. Splitting a router while simultaneously adding the first endpoint tests to a neighbouring router is the worst possible ordering: you would be moving code that nothing covers. **Tasks 11 and 12 build the coverage that makes BACKEND-16 safe later.** Recorded as decision **D9**.

3. **BACKEND-18 ("no global rate limiting; what exists lives in one process's memory") — OUT, and half of it is unreachable.** The in-process limiter is `routers/plaza_payments.py:105 _ip_quote_window` — a file this plan may not edit. The other real limiter (`app_otp_codes.attempts`) is already database-backed and already correct. A genuine global limiter needs a shared table and a decision about which surfaces get which budget, and Wave 3.2 (`partner_api_keys`, per-partner scoping) needs the same table — building it twice is the fat this programme exists to stop. Recorded as decision **D10**.

4. **Square is faked nowhere. QuickBooks and Stripe are faked at the HTTP boundary.** The task brief asks for all three; `services/square*.py` is on the never-edit list, and the existing 40-odd pay-to-park tests monkeypatch `square.fetch_payment` at the function boundary and are green. Injecting an `httpx_client` into `services/square._client()` means editing a frozen file to add a test hook, for a path that is already covered. Task 10 builds the HTTP-boundary fake as a general facility and uses it for QuickBooks (raw `httpx.AsyncClient` — a clean seam) and Stripe (`stripe.default_http_client` — the SDK's own documented seam). Converting the Square tests is explicitly out. Recorded as decision **D6**.

5. **REL-8 ("August wedge fix lives only in the live DB; DR path unverified") — IN, as documentation, not as a schema change.** The wedge fix has three parts: the flagged-only expression indexes (which *do* exist as `migrations/20260818_visitor_passes_cooldown_indexes.sql`, though its filename is 8 digits instead of 14 and would be invisible to 2.4's drift check), the Supabase compute and pooler settings (console-only), and the `cron.job_run_details` purge job (a pg_cron row). Only the first is a file, and **renaming a migration file that is already recorded in `schema_migrations` is a 2.4 decision, not a 2.9 one.** Task 7 writes all three down in `recovery/db-state.md` and adds the restore drill to `RECOVERY.md` §12.3. The rename is flagged to 2.4 in a note.

6. **DEL-6 ("43 of 72 backend endpoints untested") — IN only for the 22 endpoints 2.9 names.** The 2.9 row scopes it to QuickBooks (12) and the reservation app (10). The remaining ~21 untested endpoints are a Wave 3 problem and, for the route-guard class specifically, Wave 2.2's "walk every route and fail the build if a new endpoint has no guard" retires them wholesale. Do not expand.

7. **PIPE-3 ("camera pipeline auto-deploys with no test gate; its suite is red") — IN, and the red is one line.** `camera-snapshot/index.test.ts`'s `makeNoRegDb` builds a `visitor_passes` query stub with `select/eq/is/order/limit`. On 2026-05-29 `weak_plate_reads.ts:294` added `.in("status", ["active","expired"])` to the production query. The stub was never updated; the two `no-reg:` tests have thrown `TypeError: ... .in is not a function` ever since. Fixing the stub, not the production code, is the correct fix — and it is the proof that the gate Task 3 installs would have caught it on the day.

---

## Task Sequence

| # | Task | Repo | Depends on |
|---|---|---|---|
| 1 | Edge functions type-check clean (`deno check` green for all 16) | FE | — |
| 2 | Edge function tests green (`deno test` green for all 16) | FE | — |
| 3 | `edge-functions.yml` — one matrix workflow, check → test → changed-only deploy | FE | 1, 2 |
| 4 | Close the five open service-key functions; de-commit the camera MACs | FE + BE | 1 |
| 5 | gitleaks in CI on both repos | FE + BE | — |
| 6 | Production deploy tags + releases on both repos | FE + BE | — |
| 7 | `RECOVERY.md` refresh + the three rollback procedures + `recovery/db-state.md` | FE + BE | 3, 6 |
| 8 | Developer-doc refresh: backend `docs/` archive + README; purge the dead pipeline from both `CLAUDE.md`s | FE + BE | — |
| 9 | Harness schema extension for QuickBooks + the reservation app | BE | — |
| 10 | HTTP-boundary fakes (`FakeHttp`) for QuickBooks and Stripe | BE | — |
| 11 | QuickBooks invoicing — 12 endpoint tests | BE | 9, 10 |
| 12 | Reservation app — 10 endpoint tests | BE | 9, 10 |
| 13 | The cooldown trigger truth table (DB-9) | BE | 9 |
| 14 | Database hygiene: `cancel_reason`, index/FK hygiene, `app_enabled` as a migration | BE | 9 |
| 15 | Idle tabs stop polling (FE-8) | FE | — |
| 16 | `.env.example` generated from `Settings`, with a drift gate | BE | — |

**Parallelism.** Three waves. Each task is sized for one subagent.

- **Wave A — nine in parallel, no dependencies:** 1, 2, 5, 6, 8, 9, 10, 15, 16.
  Task 1 and Task 2 both touch `supabase/functions/`, but disjoint files (Task 1: three `index.ts` + six new `deno.json`; Task 2: one `index.test.ts`). Tasks 5, 6 and 8 span both repos; they touch only `.github/`, `.gitleaks.toml`, `docs/` and `CLAUDE.md`. Tasks 9, 10 and 16 are backend-only and disjoint (`tests/plaza/schema` + `conftest`, `tests/plaza/fakes` + `services/quickbooks.py`, `scripts/` + `.env.example`).
- **Wave B — six in parallel:** 3 (needs 1, 2), 4 (needs 1), 11 (needs 9, 10), 12 (needs 9, 10), 13 (needs 9), 14 (needs 9).
  Tasks 11, 12, 13 and 14 all add files under `tests/plaza/`; only Task 14 adds migrations, and only Task 9 edits `conftest.py`, so there are no write conflicts.
- **Wave C — one:** 7 (needs 3 and 6, because it documents the workflows and the tag names they produce).

Critical path: **1 → 3 → 7** (three tasks deep). Everything else finishes inside Wave B.

---

*(Tasks 1–16 follow. Each is self-contained: exact files, exact code, the command to run, the expected output, the commit.)*

---

### Task 1: Every edge function passes `deno check`

**Findings:** DEL-9, PIPE-18 (the gate half). **Repo:** `getlotlogic/lotlogic`. **Depends on:** nothing.

29 type errors across three slugs stand between today and a type-check gate. Fix them first; Task 3 installs the gate that keeps them fixed. Nothing here changes runtime behaviour — every fix is a type annotation, a default parameter, or a `?? ""` that matches what the other fifteen functions already do.

**Files:**
- Modify: `supabase/functions/tow-dispatch-email/index.ts` (3 errors)
- Modify: `supabase/functions/cron-sessions-sweep/index.ts` (1 error)
- Modify: `supabase/functions/walk-around-ocr/index.ts` (25 errors)

**Interfaces:** none change. No exported signature, no request shape, no response shape.

**How to run the check** — this is the load-bearing detail. Deno discovers `deno.json` by walking up from the **current working directory**, not from the entry file. Ten of sixteen slugs "fail" if you run `deno check camera-watchdog/index.ts` from `supabase/functions/`, purely because the slug's own `deno.json` import map is never found. Always:

```bash
cd supabase/functions/<slug> && deno check index.ts
```

Six slugs (`check-violations`, `notify-expiring-plates`, `simbase-usage`, `tow-confirm`, `tow-dispatch-email`, `tow-dispatch-sms`) have no `deno.json` — they import everything by full URL and check clean without one. **Do not add `deno.json` files to them.** The Supabase CLI reads a per-function `deno.json` at deploy time; adding one to six live functions to satisfy a cosmetic symmetry is a production change for no benefit.

- [ ] **Step 0: Record the baseline**

```bash
cd supabase/functions
for d in */; do n=${d%/}; ( cd "$n" && deno check --quiet index.ts >/dev/null 2>&1 \
  && echo "PASS $n" || echo "FAIL $n" ); done
```
Expect exactly: `FAIL cron-sessions-sweep`, `FAIL tow-dispatch-email`, `FAIL walk-around-ocr`, everything else `PASS`. If the failing set differs, the code has moved since 2026-09-14 — re-read before editing.

- [ ] **Step 1: `tow-dispatch-email` — `json()` gains a default status**

`json(body, status)` declares `status` as required; three callers omit it and all three mean 200 (`skipped: "violation_dismissed"` at :156, `skipped: "pass_exited_or_cancelled"` at :184, `skipped: "vehicle_exiting"` at :229 — all "we deliberately did nothing, and that is a success"). Give the parameter the default the callers assume:

```ts
// Internal-only function — gated by INTERNAL_TOKEN, never called from a
// browser, so no CORS preflight needed.
//
// `status` defaults to 200: the three "we deliberately did not dispatch"
// branches (violation_dismissed, pass_exited_or_cancelled, vehicle_exiting)
// are successful outcomes, and all three called json() with one argument.
// The signature said otherwise for months and nothing type-checked it.
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
```

- [ ] **Step 2: `cron-sessions-sweep` — name the overstay row type**

At `index.ts:465` a ternary builds `row` with two different shapes; TypeScript infers the union, and `supabase-js`'s `RejectExcessProperties` refuses it. Annotate the variable so there is one type:

```ts
    // Two shapes, one type. The stale branch carries action_taken/action_channel
    // (logged, never dispatched); the recent branch does not. Without this
    // annotation TS infers a union and supabase-js's RejectExcessProperties
    // rejects the insert — see Wave 2.9 Task 1.
    type OverstayViolationRow = {
      property_id: string;
      plate_text: string;
      status: string;
      violation_type: string;
      notes: string;
      action_taken?: string;
      action_channel?: string;
    };
    const row: OverstayViolationRow = stale
      ? {
```
(the two object literals are unchanged; only the declaration line changes).

If `deno check` still objects — supabase-js's generic inference is version-sensitive — the fallback is to split into two `.insert()` calls inside the two branches, which is also more readable. Do **not** reach for `as any` or `as Record<string, unknown>`: a cast here would hide exactly the class of error this task exists to surface.

- [ ] **Step 3: `walk-around-ocr` — annotate, and stop passing `undefined` to `createClient`**

Twenty-five errors, all mechanical. Apply in this order:

```ts
// :11-12 — every other function in this tree coalesces; this one did not, so
// createClient() was typed `string | undefined`.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// :24
function json(status: number, body: unknown) {

// :36
function normalizePlate(s: string): string {

// :40
function yyyymmdd(d: Date): string {

// :46
function b64urlToBytes(s: string): Uint8Array {

// :55
function bytesToB64url(arr: Uint8Array): string {

// :60
async function verifyBackendJwt(token: string) {

// :79
async function resolveSubject(req: Request) {

// :90
async function canAccessProperty(
  propertyId: string,
  ownerId: string | null,
  partnerId: string | null,
): Promise<boolean> {

// :103
async function callPlateRecognizer(imageBytes: Uint8Array) {
```

The two `TS2339` errors are the catch variable at `:121` (Deno types a catch binding as `unknown`; `err?.name` is not reachable on it):

```ts
  } catch (err) {
    clearTimeout(timer);
    // Deno types a catch binding as `unknown`. Narrow once, here, rather than
    // at each property access.
    const e = err as { name?: string; message?: string } | null;
    const reason = e?.name === "AbortError" ? "timeout" : (e?.message ?? "fetch_failed");
    return { ok: false, status: 0, bodyText: reason };
  }
```

The Plate Recognizer response is untyped JSON. Declare the two shapes it is read through rather than sprinkling `any` (`:132`, `:193-203`):

```ts
/** One Plate Recognizer `results[]` entry, in the fields this function reads. */
type PrResult = {
  plate?: string;
  score?: number;
  candidates?: Array<{ plate?: string; score?: number }>;
  model_make?: Array<{ make?: string; model?: string; score?: number }>;
  color?: Array<{ color?: string; score?: number }>;
  orientation?: Array<{ orientation?: string; score?: number }>;
  vehicle?: { type?: string; score?: number };
  region?: { code?: string; score?: number };
};

function extractVehicle(r: PrResult | null | undefined) {
```
then at the call sites: `results` becomes `const results: PrResult[] = Array.isArray(pr.data.results) ? pr.data.results : [];` and the three lambdas take `(r: PrResult)`, `(x: { plate: string })`, `(a: {score: number}, b: {score: number})`, `(c: { plate?: string; score?: number })`. Let `deno check` tell you the exact set — annotate until it is silent, and do not widen anything to `any`.

- [ ] **Step 4: Confirm all sixteen are clean, and that nothing moved**

```bash
cd supabase/functions
for d in */; do n=${d%/}; ( cd "$n" && deno check --quiet index.ts >/dev/null 2>&1 \
  && echo "PASS $n" || echo "FAIL $n" ); done
```
Expect sixteen `PASS`.

- [ ] **Step 5: Prove the gate can fail**

In `tow-dispatch-email/index.ts`, temporarily change `status = 200` back to `status: number`. Re-run Step 4 — expect `FAIL tow-dispatch-email`. Revert.

- [ ] **Step 6: Diff against the deployed runtime before committing**

Three of these are live functions and the repo has drifted from the runtime before. For each of `cron-sessions-sweep`, `tow-dispatch-email`, `walk-around-ocr`, fetch the deployed copy (`mcp__supabase__get_edge_function`) and diff against the pre-edit file. **If the deployed copy differs from `origin/main` in anything but your own edits, stop and report it** — you have found live source that is not in git, which is exactly what the 2026-06-05 recovery pass had to clean up once already.

**Commit:** `fix(edge): type-check clean across all 16 functions`

---

### Task 2: Every edge function passes `deno test`

**Findings:** PIPE-3, DEL-9 (the test half). **Repo:** `getlotlogic/lotlogic`. **Depends on:** nothing.

Four slugs carry Deno tests: `pr-ingest` (22), `cron-sessions-sweep` (11), `cron-no-reg-sweep` (4), `camera-snapshot` (57). Ninety-two of the ninety-four pass. The two that fail have failed since 2026-05-29 and nothing noticed — which is the whole of PIPE-3 in one sentence.

**Files:**
- Modify: `supabase/functions/camera-snapshot/index.test.ts`

**Interfaces:** none. This is a test-stub fix; production code is untouched.

- [ ] **Step 1: Reproduce**

```bash
cd supabase/functions/camera-snapshot && deno test --allow-all --no-check
```
Expect `FAILED | 55 passed | 2 failed`, both with:
```
TypeError: db.from(...).select(...).eq(...).in is not a function
    at findActiveUnexitedPassFuzzy (weak_plate_reads.ts:294:8)
```

- [ ] **Step 2: Understand before fixing**

`weak_plate_reads.ts:288-296` queries `visitor_passes`:

```ts
  const { data, error } = await db
    .from("visitor_passes")
    .select("id,valid_until,valid_from,plate_text,normalized_back_plate,overstay_violation_id")
    .eq("property_id", propertyId)
    // active OR expired (C2, 2026-05-29): pass_expiry.py may soft-expire a pass
    // before the SC211 buffer flushes its exit. cancelled/revoked/towed stay out.
    .in("status", ["active", "expired"])
    .is("exited_at", null)
```

`index.test.ts:622-635`'s `makeNoRegDb` builds a `visitor_passes` stub with `select / eq / is / order / limit` and no `in`. The `.in()` call is eleven weeks newer than the stub. **The production query is correct and must not change** — soft-expired passes genuinely have to stay matchable until the exit buffer flushes. The stub is what is wrong.

- [ ] **Step 3: Fix the stub**

In `makeNoRegDb`, the `visitor_passes` branch:

```ts
      // ── visitor_passes: active-pass fuzzy search ────────────────────────
      if (table === "visitor_passes") {
        const builder: any = {
          select(_cols: string) { return builder; },
          eq(_col: string, _val: unknown) { return builder; },
          // `.in("status", ["active","expired"])` — added to the production
          // query on 2026-05-29 (C2) and missing here ever since, which threw
          // `db.from(...).select(...).eq(...).in is not a function` and left
          // two tests red for eleven weeks with nothing watching. Wave 2.9
          // Task 3 is the gate that makes that impossible to repeat.
          in(_col: string, _vals: unknown[]) { return builder; },
          is(_col: string, _val: unknown) { return builder; },
          order(_col: string, _opts: unknown) { return builder; },
          limit(_n: number) {
            return Promise.resolve({ data: [], error: null });
          },
        };
        return builder;
      }
```

- [ ] **Step 4: Confirm all four suites**

```bash
cd supabase/functions
for n in camera-snapshot cron-no-reg-sweep cron-sessions-sweep pr-ingest; do
  echo "── $n"; ( cd "$n" && deno test --allow-all --no-check 2>&1 | tail -2 )
done
```
Expect `ok | 57 passed | 0 failed`, `4 passed`, `11 passed`, `22 passed`.

`--no-check` is deliberate here: Task 1 owns type-checking, Task 3's workflow runs both as separate steps, and keeping them separate means a type error and a behaviour failure never hide behind one another.

- [ ] **Step 5: Prove the tests can fail**

The two repaired tests assert the *shape* of a violation row that is written when an unmatched burst is flushed. Temporarily change `weak_plate_reads.ts`'s lingered/brief threshold (`≥10s span`) to `≥10000s` and re-run — expect `no-reg: unmatched burst with ≥10s span creates lingered violation row` to fail with a presence-strength mismatch, not a `TypeError`. Revert. This is the difference between "the test runs" and "the test tests".

**Commit:** `test(camera-snapshot): stub the .in() the production query has used since May`

---

### Task 3: One matrix workflow — check, test, deploy only what changed

**Findings:** PIPE-18, DEL-9, PIPE-3 (the gate). **Repo:** `getlotlogic/lotlogic`. **Depends on:** Tasks 1 and 2.

Today: two hand-written workflows deploy two functions, each with a hand-maintained `paths:` list; fourteen functions deploy when a human remembers; nothing checks or tests anything. The hand-maintained list is already load-bearing and already fragile — `auto-deploy-camera-snapshot.yml` has to name `supabase/functions/pr-ingest/{r2,normalize,types}.ts` because `camera-snapshot` imports them, and nothing enforces that the list stays true. Meanwhile `cron-no-reg-sweep` imports `../camera-snapshot/no_reg_violations.ts` and `../camera-snapshot/weak_plate_reads.ts` and has **no** workflow at all, so a change to `no_reg_violations.ts` silently leaves the deployed `cron-no-reg-sweep` stale.

So: compute the matrix from the import graph instead of maintaining it.

**Files:**
- Create: `supabase/functions/_ci/slugs.mjs`
- Create: `supabase/functions/_ci/slugs.test.mjs`
- Create: `.github/workflows/edge-functions.yml`
- Delete: `.github/workflows/auto-deploy-camera-snapshot.yml`, `.github/workflows/auto-deploy-cron-sessions-sweep.yml`
- Modify: `frontend/package.json` **only if** you choose to run `slugs.test.mjs` through the frontend's `npm test`; the workflow runs it directly, so this is optional and the default is not to touch it.

**Interfaces (produced by `_ci/slugs.mjs`, consumed by the workflow):**
- `slugs(): string[]` — every deployable slug, sorted. A directory under `supabase/functions/` that contains `index.ts` and whose name does not start with `_`.
- `filesFor(slug): string[]` — repo-relative paths of every local file that slug's `index.ts` transitively imports, plus every non-`.ts` file in the slug's own directory (`deno.json`, `auto-fuzzy-config.json`).
- `slugsForChanged(changedPaths: string[]): string[]` — the slugs to deploy. Also returns **every** slug when a workflow file or `supabase/config.toml` changed.
- CLI: `node _ci/slugs.mjs list` → JSON array; `node _ci/slugs.mjs changed < file-list` → JSON array.

- [ ] **Step 1: Write the walker**

`supabase/functions/_ci/slugs.mjs`:

```js
// The edge-function deploy matrix, computed from the import graph.
//
// Why this exists: camera-snapshot imports ../pr-ingest/r2.ts, and
// cron-no-reg-sweep imports ../camera-snapshot/no_reg_violations.ts. A
// hand-maintained `paths:` list has to encode those edges and has no way to
// notice when a new one appears — which is how cron-no-reg-sweep ended up with
// no deploy workflow at all while depending on a file that has one.
//
// No dependencies: this runs on the runner's stock Node.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FUNCTIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(FUNCTIONS_DIR, "../..");

/** Files that force a full redeploy of every slug when they change. */
const GLOBAL_PATHS = [
  "supabase/config.toml",
  ".github/workflows/edge-functions.yml",
];

const rel = (abs) => relative(REPO_ROOT, abs).split(/[\\/]/).join(posix.sep);

export function slugs() {
  return readdirSync(FUNCTIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
    .map((d) => d.name)
    .filter((n) => existsSync(join(FUNCTIONS_DIR, n, "index.ts")))
    .sort();
}

// Matches `import … from "x"`, `export … from "x"`, and bare `import "x"`.
const FROM_RE = /(?:^|[\s;])(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/g;
const BARE_RE = /(?:^|[\s;])import\s*["']([^"']+)["']/g;

function resolveLocal(fromFile, spec) {
  // Only relative specifiers are ours. Everything else is a remote URL
  // (https://deno.land/…, https://esm.sh/…) or a deno.json alias that maps to
  // one; assertGuards() below makes the alias case an error rather than a
  // silent miss.
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const cand of [base, `${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  throw new Error(`unresolved local import ${spec} from ${rel(fromFile)}`);
}

function closure(entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!file.endsWith(".ts")) continue;          // .json leaves have no imports
    const src = readFileSync(file, "utf8");
    for (const re of [FROM_RE, BARE_RE]) {
      re.lastIndex = 0;
      for (const m of src.matchAll(re)) {
        const next = resolveLocal(file, m[1]);
        if (next) stack.push(next);
      }
    }
  }
  return seen;
}

export function filesFor(slug) {
  const dir = join(FUNCTIONS_DIR, slug);
  const out = new Set([...closure(join(dir, "index.ts"))].map(rel));
  // Non-TS siblings the runtime reads (deno.json import map,
  // auto-fuzzy-config.json). They are inputs to the deploy even though no
  // import statement in a .ts file has to mention them.
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (d.isFile() && !d.name.endsWith(".ts")) out.add(rel(join(dir, d.name)));
  }
  return [...out].sort();
}

/**
 * Guard against two ways this walker could silently under-report.
 * Throws — a deploy matrix that quietly misses a slug is worse than a red build.
 */
export function assertGuards() {
  // 1. A deno.json alias pointing at a local path would be an import edge the
  //    regex cannot see.
  for (const slug of slugs()) {
    const cfg = join(FUNCTIONS_DIR, slug, "deno.json");
    if (!existsSync(cfg)) continue;
    const imports = JSON.parse(readFileSync(cfg, "utf8")).imports ?? {};
    for (const [alias, target] of Object.entries(imports)) {
      if (target.startsWith(".") || target.startsWith("/")) {
        throw new Error(
          `${slug}/deno.json maps "${alias}" to a local path (${target}). ` +
          `The deploy matrix resolves imports textually and cannot follow it. ` +
          `Import the file by relative path instead.`,
        );
      }
    }
  }
  // 2. A deno.json above a slug would change how `deno check` resolves inside
  //    it, so the CI gate and a developer's local run would disagree.
  for (const p of ["supabase/functions/deno.json", "deno.json", "deno.jsonc"]) {
    if (existsSync(join(REPO_ROOT, p))) {
      throw new Error(
        `${p} exists. Deno resolves config by walking up from the CWD, so this ` +
        `would silently override a slug's own deno.json. Remove it or teach ` +
        `_ci/slugs.mjs about it.`,
      );
    }
  }
}

export function slugsForChanged(changed) {
  const paths = changed.map((p) => p.trim()).filter(Boolean);
  if (paths.some((p) => GLOBAL_PATHS.includes(p))) return slugs();
  const touched = new Set(paths);
  return slugs().filter((s) => filesFor(s).some((f) => touched.has(f)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  assertGuards();
  const cmd = process.argv[2];
  if (cmd === "list") {
    process.stdout.write(JSON.stringify(slugs()));
  } else if (cmd === "changed") {
    const stdin = readFileSync(0, "utf8").split("\n");
    process.stdout.write(JSON.stringify(slugsForChanged(stdin)));
  } else {
    console.error("usage: slugs.mjs list | slugs.mjs changed < file-list");
    process.exit(2);
  }
}
```

- [ ] **Step 2: Test the walker against the two real cross-function edges**

`supabase/functions/_ci/slugs.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertGuards, filesFor, slugs, slugsForChanged } from "./slugs.mjs";

test("finds every deployable slug and no scaffolding", () => {
  const s = slugs();
  assert.ok(s.includes("camera-snapshot"));
  assert.ok(s.includes("weather-risk-eval"));
  assert.ok(!s.includes("_ci"));
  assert.equal(s.length, new Set(s).size);
});

test("camera-snapshot depends on pr-ingest sources", () => {
  // The edge the hand-written workflow had to encode by hand.
  const files = filesFor("camera-snapshot");
  assert.ok(files.includes("supabase/functions/pr-ingest/r2.ts"));
  assert.ok(files.includes("supabase/functions/pr-ingest/normalize.ts"));
  assert.ok(files.includes("supabase/functions/camera-snapshot/auto-fuzzy-config.json"));
});

test("cron-no-reg-sweep depends on camera-snapshot sources", () => {
  // The edge NO hand-written workflow encoded, which is the bug.
  const files = filesFor("cron-no-reg-sweep");
  assert.ok(files.includes("supabase/functions/camera-snapshot/no_reg_violations.ts"));
  assert.ok(files.includes("supabase/functions/camera-snapshot/weak_plate_reads.ts"));
});

test("a shared file redeploys every slug that reaches it", () => {
  const hit = slugsForChanged(["supabase/functions/camera-snapshot/no_reg_violations.ts"]);
  assert.deepEqual(hit.sort(), ["camera-snapshot", "cron-no-reg-sweep"]);
});

test("an unrelated change deploys nothing", () => {
  assert.deepEqual(slugsForChanged(["frontend/src/App.jsx"]), []);
});

test("config.toml redeploys everything", () => {
  assert.deepEqual(slugsForChanged(["supabase/config.toml"]), slugs());
});

test("the guards hold today", () => {
  assert.doesNotThrow(assertGuards);
});
```

Run it: `node --test supabase/functions/_ci/slugs.test.mjs` — expect 7 pass.

**Prove it can fail:** delete the `.in()` edge — i.e. temporarily rename `camera-snapshot/no_reg_violations.ts`'s import in `cron-no-reg-sweep/index.ts` to a remote URL — and watch the third test go red. Revert.

- [ ] **Step 3: The workflow**

`.github/workflows/edge-functions.yml`:

```yaml
# Every Supabase edge function: type-check, test, then deploy the ones whose
# sources actually changed.
#
# Replaces .github/workflows/auto-deploy-camera-snapshot.yml and
# auto-deploy-cron-sessions-sweep.yml, which covered 2 of 16 functions with
# hand-maintained path lists. The matrix here is computed from the import graph
# by supabase/functions/_ci/slugs.mjs.
#
# Secret required (already exists on this repo): SUPABASE_ACCESS_TOKEN — a
# personal access token from supabase.com/dashboard/account/tokens with access
# to project nzdkoouoaedbbccraoti.
#
# Rollback: re-run this workflow from the Actions tab with `ref` set to the
# frontend-* tag you want back and `only` set to the slug. See RECOVERY.md §12.3.

name: Edge functions

on:
  push:
    branches: [main]
    paths:
      - 'supabase/**'
      - '.github/workflows/edge-functions.yml'
  pull_request:
    paths:
      - 'supabase/**'
      - '.github/workflows/edge-functions.yml'
  workflow_dispatch:
    inputs:
      only:
        description: 'Comma-separated slugs to deploy (blank = all)'
        required: false
      ref:
        description: 'Git ref to deploy from — a frontend-* tag, for rollback (blank = this branch)'
        required: false

concurrency:
  # Never cancel a half-finished deploy matrix: a cancelled run leaves some
  # functions on the new code and some on the old.
  group: edge-functions-${{ github.ref }}
  cancel-in-progress: false

env:
  PROJECT_REF: nzdkoouoaedbbccraoti

jobs:
  plan:
    name: plan
    runs-on: ubuntu-latest
    outputs:
      all: ${{ steps.p.outputs.all }}
      deploy: ${{ steps.p.outputs.deploy }}
      deploy_count: ${{ steps.p.outputs.deploy_count }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          ref: ${{ inputs.ref || github.ref }}
      - uses: actions/setup-node@v4
        with: { node-version: '22' }

      - name: Walker self-test
        run: node --test supabase/functions/_ci/slugs.test.mjs

      - id: p
        name: Compute the matrix
        env:
          ONLY: ${{ inputs.only }}
          BEFORE: ${{ github.event.before }}
        run: |
          set -euo pipefail
          all=$(node supabase/functions/_ci/slugs.mjs list)
          echo "all=$all" >> "$GITHUB_OUTPUT"

          if [ -n "${ONLY:-}" ]; then
            # Manual re-deploy / rollback: exactly what was asked for.
            deploy=$(printf '%s' "$ONLY" | tr ',' '\n' | sed '/^$/d' \
              | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s.split("\n").filter(Boolean).map(x=>x.trim()))))')
          elif [ "${{ github.event_name }}" != "push" ]; then
            deploy='[]'
          elif [ -z "${BEFORE:-}" ] || [ "${BEFORE}" = "0000000000000000000000000000000000000000" ] \
               || ! git cat-file -e "${BEFORE}^{commit}" 2>/dev/null; then
            # First push, force-push, or a rewritten history: we cannot know
            # what changed, so redeploy everything rather than guess low.
            echo "::notice::no usable before-sha; deploying every function"
            deploy="$all"
          else
            deploy=$(git diff --name-only "${BEFORE}" "${{ github.sha }}" \
              | node supabase/functions/_ci/slugs.mjs changed)
          fi
          echo "deploy=$deploy" >> "$GITHUB_OUTPUT"
          echo "deploy_count=$(printf '%s' "$deploy" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).length)))')" >> "$GITHUB_OUTPUT"
          {
            echo "### Edge functions"
            echo "- slugs: $(printf '%s' "$all" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).length)))')"
            echo "- to deploy: \`$deploy\`"
          } >> "$GITHUB_STEP_SUMMARY"

  check:
    name: check ${{ matrix.slug }}
    needs: plan
    runs-on: ubuntu-latest
    timeout-minutes: 10
    strategy:
      fail-fast: false
      matrix:
        slug: ${{ fromJSON(needs.plan.outputs.all) }}
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ inputs.ref || github.ref }}
      - uses: denoland/setup-deno@v2
        with: { deno-version: v2.x }

      # CWD must be inside the slug: Deno resolves deno.json by walking up from
      # the working directory, not from the entry file. Running this from
      # supabase/functions/ makes 10 of 16 functions fail on a phantom
      # "Import @supabase/supabase-js not a dependency".
      - name: deno check
        working-directory: supabase/functions/${{ matrix.slug }}
        run: deno check index.ts

      - name: deno test
        working-directory: supabase/functions/${{ matrix.slug }}
        run: |
          set -euo pipefail
          if ls *.test.ts >/dev/null 2>&1; then
            deno test --allow-all --no-check
          else
            echo "no tests in ${{ matrix.slug }}"
          fi

  deploy:
    name: deploy ${{ matrix.slug }}
    needs: [plan, check]
    if: >-
      needs.plan.outputs.deploy_count != '0' &&
      (github.event_name == 'workflow_dispatch' ||
       (github.event_name == 'push' && github.ref == 'refs/heads/main'))
    runs-on: ubuntu-latest
    timeout-minutes: 10
    strategy:
      fail-fast: false
      # One at a time. A matrix of 16 concurrent `supabase functions deploy`
      # calls against one project is a good way to find that project's rate
      # limit during an incident.
      max-parallel: 2
      matrix:
        slug: ${{ fromJSON(needs.plan.outputs.deploy) }}
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ inputs.ref || github.ref }}
      - uses: supabase/setup-cli@v1
        with: { version: latest }

      # verify_jwt is declared per function in supabase/config.toml, which the
      # CLI reads. Do NOT pass --no-verify-jwt here: the flag and the file would
      # be two sources of truth, and the file is the one that survives a deploy
      # made from a laptop.
      - name: supabase functions deploy ${{ matrix.slug }}
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
        run: supabase functions deploy ${{ matrix.slug }} --project-ref "$PROJECT_REF"
```

- [ ] **Step 4: Delete the two superseded workflows**

```bash
git rm .github/workflows/auto-deploy-camera-snapshot.yml \
       .github/workflows/auto-deploy-cron-sessions-sweep.yml
```

- [ ] **Step 5: Validate the workflow before it can touch production**

```bash
# YAML parses and the two jobs reference a real matrix source.
python3 -c "import yaml,sys; d=yaml.safe_load(open('.github/workflows/edge-functions.yml')); print(sorted(d['jobs']))"
# The walker agrees with reality.
node supabase/functions/_ci/slugs.mjs list
node --test supabase/functions/_ci/slugs.test.mjs
```
Expect `['check', 'deploy', 'plan']` and a 16-element slug list.

- [ ] **Step 6: Land it on a PR first, and watch the check matrix run**

Open the PR. The `plan` and `check ×16` jobs must run and be green; `deploy` must be **skipped** (the `if:` excludes `pull_request`). If any `check` job is red, Task 1 or Task 2 is not finished — fix there, not here.

- [ ] **Step 7: Prove the gate blocks a bad deploy**

On the PR branch, push a commit that breaks one function's types (`const x: number = "no";` at the top of `check-violations/index.ts`). The `check check-violations` job must go red. Revert the commit before merging.

**Note for whoever merges:** the first push to `main` after this lands has `github.event.before` pointing at the pre-merge commit, so the changed-set will include the workflow file itself → `GLOBAL_PATHS` → **every** function redeploys once. That is intended: it is the first time in the repo's life that the deployed runtime is known to equal `main`.

**Commit:** `ci(edge): one matrix workflow — type-check, test, deploy only what changed`

---

### Task 4: Close the five open service-key functions; take the camera MACs out of git

**Findings:** SEC-3, SEC-14. **Repos:** `getlotlogic/lotlogic` + `getlotlogic/lotlogic-backend`. **Depends on:** Task 1.

Five edge functions hold `SUPABASE_SERVICE_ROLE_KEY` — the credential that bypasses every RLS policy for every tenant — and check nothing at all before using it: `camera-watchdog`, `cron-no-reg-sweep`, `cron-plate-pair-learn`, `weather-pull`, `weather-risk-eval`. Two more (`simbase-usage`, `walk-around-ocr`) are protected only by Supabase's default JWT check, which the **publishable anon key** satisfies. Separately, live camera credentials are committed in seven places.

**Files:**
- Create: `supabase/functions/_shared/internal_auth.ts`
- Modify: `supabase/functions/{camera-watchdog,cron-no-reg-sweep,cron-plate-pair-learn,weather-pull,weather-risk-eval}/index.ts`
- Modify: `supabase/functions/camera-snapshot/extract.ts` (the MAC in a doc comment)
- Modify (backend): `config.py`, `CLAUDE.md`, `tests/test_tow_retention.py`, `tests/plaza/conftest.py`, `tests/plaza/test_tow_sightings_service.py`, `tests/plaza/test_tow_sightings_endpoints.py`, `tests/plaza/test_tow_digest.py`

**Interfaces:**
- `requireInternalToken(req: Request): Response | null` — returns a 401 `Response` to return immediately, or `null` when the caller is authorised.

- [ ] **Step 1: The shared guard**

The pattern already exists, copy-pasted, in `check-violations`, `cron-sessions-sweep`, `notify-expiring-plates`, `tow-confirm`, `tow-dispatch-email` and `tow-dispatch-sms`. Lift it once. `supabase/functions/_shared/internal_auth.ts`:

```ts
// The one gate for functions that are invoked by pg_cron, the GitHub scheduler
// or the backend — never by a browser.
//
// Why it has to exist: verify_jwt=true is NOT authentication for these. The key
// it accepts is the publishable anon key, which ships in every page of
// lotlogicparking.com. A function holding SUPABASE_SERVICE_ROLE_KEY behind
// verify_jwt=true is, in practice, open to anyone who reads the page source.
//
// INTERNAL_TOKEN is already set as a Supabase edge secret and as a GitHub
// Actions secret (see RECOVERY.md §5) — this adds no new secret.

/** 401 Response to return immediately, or null when the caller is authorised. */
export function requireInternalToken(req: Request): Response | null {
  const expected = Deno.env.get("INTERNAL_TOKEN") ?? "";
  const provided = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  // Empty expected means the secret is not set. Fail CLOSED: an unconfigured
  // deployment must not be an open one.
  if (!expected || !timingSafeEqual(expected, provided)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}

/** Constant-time compare. Length still leaks; the token is fixed-length. */
function timingSafeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}
```

- [ ] **Step 2: Apply it to the five, feature-flagged for one deploy**

Each of the five gets, as the first thing inside its handler:

```ts
import { requireInternalToken } from "../_shared/internal_auth.ts";
…
  // SEC-3 (Wave 2.9 Task 4). ENFORCE_INTERNAL_TOKEN defaults to "true"; set it
  // to "false" for one deploy if a caller turns out to be sending no header, so
  // the 401s show up in the logs before they show up as a dead cron job.
  if ((Deno.env.get("ENFORCE_INTERNAL_TOKEN") ?? "true") !== "false") {
    const denied = requireInternalToken(req);
    if (denied) return denied;
  } else if (requireInternalToken(req)) {
    console.warn("internal_token: would have rejected this caller (enforcement off)");
  }
```

**Before merging, confirm every caller sends the header.** The callers are:
- `camera-watchdog` — invoked by whom? Check `recovery/pg_cron.sql` and the Supabase `cron.job` table (`mcp__supabase__execute_sql`: `select jobname, schedule, command from cron.job`). A pg_cron caller using `pg_net` must have `Authorization: Bearer <INTERNAL_TOKEN>` added to its `headers` argument in the same change.
- `cron-no-reg-sweep`, `cron-plate-pair-learn`, `weather-pull`, `weather-risk-eval` — per the program doc §4 decision 13, `plate_pair_learn`, `weather_pull`, `weather_risk_eval` and `no_reg_sweep` are all currently **switched off** in `cron.job`. Verify that before you assume a caller exists; a schedule that is off cannot break, and a schedule that is on must be updated in the same commit.

Record what you find in the commit message. If a pg_cron job needs its header updated, that is a migration (`migrations/20260914*_cron_internal_token_headers.sql` in the backend repo) — do not edit `cron.job` by hand.

- [ ] **Step 3: `simbase-usage` and `walk-around-ocr` — document, do not change**

`simbase-usage` reads a third-party billing API and writes nothing; `walk-around-ocr` verifies the backend-issued HS256 JWT itself (`verifyBackendJwt`) and scopes on `properties.tow_company_id`, so it is genuinely authenticated even though `verify_jwt=true` is not what is doing it. Add a one-line comment to each saying so, and leave them alone. Over-fixing `walk-around-ocr` would mean requiring `INTERNAL_TOKEN` from a browser, which would break the feature.

- [ ] **Step 4: Take the camera MACs out of source**

A camera's MAC **is** its `alpr_cameras.api_key` — the value `camera-snapshot` matches an inbound frame against. Seven committed occurrences:

| File | What to do |
|---|---|
| `supabase/functions/camera-snapshot/extract.ts:210` (doc comment) | replace with `"aabbccddeeff"` and add `// (placeholder — a real MAC is a camera credential)` |
| `lotlogic-backend/config.py:254` (doc comment giving a worked example) | replace with `"aabbccddeeff:2"` |
| `lotlogic-backend/CLAUDE.md:162` | replace with the placeholder |
| `lotlogic-backend/tests/test_tow_retention.py:19` | replace with `"aabbccddeeff"` — it is a unit test over a parser, the value is arbitrary |
| `lotlogic-backend/tests/plaza/conftest.py:111-112` | read from env with a non-live default (below) |
| `tests/plaza/test_tow_sightings_service.py`, `test_tow_sightings_endpoints.py`, `test_tow_digest.py` | import the conftest constants instead of the literals |

In `tests/plaza/conftest.py`:

```python
#: The plaza's two gate cameras, by api_key (the MAC the archiver knows them
#: by). A camera's MAC IS its credential — `camera-snapshot` matches inbound
#: frames on `alpr_cameras.api_key` — so the real values do not live in git.
#: Override with PLAZA_CAMERA_API_KEY / PLAZA_CAMERA_API_KEY_2 when running a
#: test against a real fixture; the defaults are fine for every test here,
#: which only needs two distinct opaque strings.
PLAZA_CAMERA_API_KEY = os.environ.get("PLAZA_CAMERA_API_KEY", "aabbccddee01")
PLAZA_CAMERA_API_KEY_2 = os.environ.get("PLAZA_CAMERA_API_KEY_2", "aabbccddee02")
```

`tests/plaza/test_tow_sightings_endpoints.py:54` asserts the literal `"1cc316536fb5"` with the comment "the archiver keys its camera credentials off this and cannot work without it" — that assertion is still worth making, so change it to compare against `PLAZA_CAMERA_API_KEY` imported from the conftest. The test keeps its meaning ("the endpoint returns the camera's key") and stops publishing the key.

**Do not rotate `alpr_cameras.api_key` in the database.** Rotation means reconfiguring two solar cameras over ZeroTier and is a site-visit risk during enforcement hours. De-committing is this task; rotating is decision **D5**.

- [ ] **Step 5: Verify**

```bash
# No live MAC left in either working tree.
grep -rInE '1cc316[0-9a-f]{6}' /Users/gabe/lotlogic /Users/gabe/lotlogic-backend \
  --include='*.ts' --include='*.py' --include='*.md' --include='*.sql' \
  | grep -v '/docs/archive/' || echo "clean"
# All 16 still check, and the five still parse.
cd supabase/functions; for d in */; do n=${d%/}; ( cd "$n" && deno check --quiet index.ts ) || echo "FAIL $n"; done
# Backend suite still green (the MAC change touches five test files).
cd /Users/gabe/lotlogic-backend && pytest -x --tb=short -q
```

Git history still contains the old values — that is a rewrite, not a fix, and is out of scope. Note it in the commit body so the rotation decision has the fact in front of it.

- [ ] **Step 6: Prove the guard can fail**

Add a temporary test call: `curl -s -o /dev/null -w '%{http_code}' -X POST "$SUPABASE_URL/functions/v1/weather-pull"` against a **local** `supabase functions serve` — expect `401`. With `-H "Authorization: Bearer $INTERNAL_TOKEN"` — expect `200`. Do not run this against production.

**Commits:** two, one per repo — `fix(edge): gate the five open service-key functions on INTERNAL_TOKEN` and `chore: stop committing live camera api_keys`

---

### Task 5: Secret scanning that runs on every commit, not only Claude's

**Finding:** SEC-15. **Repos:** both. **Depends on:** nothing.

Both repos have `.claude/hooks/pre-commit-secrets-scan.sh`, wired as a Claude Code `PreToolUse` hook on `Write|Edit|MultiEdit`. It is a good hook. It also cannot see a `git commit` typed in a terminal, a change made by any other tool, or a contribution from a teammate — and the frontend repo is **public**.

**Files (identical in both repos):**
- Create: `.gitleaks.toml`
- Create: `.github/workflows/secrets-scan.yml`

- [ ] **Step 1: `.gitleaks.toml`**

```toml
# Secret scanning for CI. The Claude Code PreToolUse hook
# (.claude/hooks/pre-commit-secrets-scan.sh) stays as it is — it catches things
# earlier. This catches everything the hook cannot see: a terminal commit, a
# teammate, another tool. Wave 2.9 Task 5 (SEC-15).
title = "LotLogic"

[extend]
useDefault = true

[[rules]]
id = "lotlogic-camera-api-key"
description = "A camera MAC is an alpr_cameras.api_key — a credential, not an identifier"
# Milesight OUI. Wave 2.9 Task 4 removed the committed ones; this keeps them out.
regex = '''1cc316[0-9a-f]{6}'''
tags = ["lotlogic", "camera"]

[allowlist]
description = "Narrow, justified exceptions. Every entry needs a reason."
paths = [
  # Frozen history. Rewriting it is a separate decision (see RECOVERY.md §12.4).
  '''^docs/archive/''',
  # The scanner's own rule file necessarily contains the patterns it matches.
  '''^\.gitleaks\.toml$''',
]
regexes = [
  # Placeholder credentials this repo deliberately publishes as examples.
  '''aabbccddee[0-9a-f]{2}''',
  '''your-secret-api-key-here''',
  '''ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx''',
]
```

- [ ] **Step 2: `.github/workflows/secrets-scan.yml`**

```yaml
name: Secret scan

on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  gitleaks:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # history scan needs the full graph

      - name: Install gitleaks
        run: |
          set -euo pipefail
          V=8.18.4
          curl -sSfL "https://github.com/gitleaks/gitleaks/releases/download/v${V}/gitleaks_${V}_linux_x64.tar.gz" \
            | sudo tar -xz -C /usr/local/bin gitleaks
          gitleaks version

      # Blocking from day one: the working tree is clean after Task 4, so this
      # can only go red on something NEW.
      - name: Scan the working tree
        run: gitleaks detect --source . --no-git --config .gitleaks.toml --redact --exit-code 1 --verbose

      # Advisory for now — git history still holds the camera keys Task 4 removed
      # from the tree, and rewriting history is a separate decision (D5). Flip
      # continue-on-error off once that is settled.
      - name: Scan git history (advisory)
        continue-on-error: true
        run: gitleaks detect --source . --config .gitleaks.toml --redact --exit-code 1 --verbose
```

- [ ] **Step 3: Verify, and prove it can fail**

```bash
V=8.18.4  # or brew install gitleaks
gitleaks detect --source . --no-git --config .gitleaks.toml --redact --exit-code 1 --verbose
```
Expect `no leaks found`. Then: `echo 'const k = "1cc3166600aa";' > /tmp/x.ts && cp /tmp/x.ts ./leaktest.ts`, re-run — expect exit 1 and a redacted finding. `rm leaktest.ts`.

If the tree scan is **not** clean, do not widen the allowlist to make it pass. Report what it found; a finding here is the point of the task.

**Commits:** one per repo — `ci: gitleaks on every push and PR`

---

### Task 6: Every production deploy leaves a name behind

**Finding:** DEL-11. **Repos:** both. **Depends on:** nothing.

Zero tags, zero releases, in both repos. Railway and Vercel each deploy from `main` on push, and "roll it back" currently means scrolling a provider dashboard looking for a timestamp you half remember. A tag written at the moment of the push costs nothing, needs no provider API token, and gives the rollback procedures in Task 7 something to name.

**Files (one per repo, differing only in the prefix and the body text):**
- Create: `.github/workflows/deploy-tag.yml`

- [ ] **Step 1: The workflow (backend version shown; frontend is the same with `backend` → `frontend`)**

```yaml
# Name every production deploy.
#
# Railway deploys this repo from `main` on push. This workflow runs on the same
# event and leaves an annotated tag plus a GitHub release behind, so "roll back
# to what was running before" has an answer that is a git ref rather than a
# timestamp in a dashboard. No provider API token: the rollback itself is done
# through Railway's own UI, pointed at the commit this tag names.
# See RECOVERY.md §12.1.

name: Tag production deploy

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: write   # push a tag, create a release

concurrency:
  group: deploy-tag
  cancel-in-progress: false

jobs:
  tag:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - id: names
        run: |
          set -euo pipefail
          sha="$(git rev-parse --short=7 HEAD)"
          tag="backend-$(date -u +%Y%m%d-%H%M)-${sha}"
          prev="$(git describe --tags --abbrev=0 --match 'backend-*' HEAD^ 2>/dev/null || true)"
          echo "tag=$tag"   >> "$GITHUB_OUTPUT"
          echo "prev=$prev" >> "$GITHUB_OUTPUT"
          echo "sha=$sha"   >> "$GITHUB_OUTPUT"

      - name: Tag
        env:
          TAG:  ${{ steps.names.outputs.tag }}
          PREV: ${{ steps.names.outputs.prev }}
        run: |
          set -euo pipefail
          git config user.name  "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          # The annotation is the rollback target: the tag that was live before
          # this one. Written here because it is cheap here and expensive at 2am.
          git tag -a "$TAG" -m "Production deploy of ${{ github.sha }}

          Previous production tag: ${PREV:-<none — first tagged deploy>}
          Roll back with: RECOVERY.md §12.1"
          git push origin "$TAG"

      - name: Release notes
        env:
          GH_TOKEN: ${{ github.token }}
          TAG:  ${{ steps.names.outputs.tag }}
          PREV: ${{ steps.names.outputs.prev }}
        run: |
          set -euo pipefail
          if [ -n "${PREV}" ]; then
            body="$(git log --no-merges --pretty='- %s (%h)' "${PREV}..${TAG}")"
            body="${body}

          Rollback target: \`${PREV}\` — see RECOVERY.md §12.1"
          else
            body="First tagged production deploy."
          fi
          gh release create "$TAG" --title "$TAG" --notes "$body" --latest

      - run: echo "Tagged **${{ steps.names.outputs.tag }}** (previous: ${{ steps.names.outputs.prev || 'none' }})" >> "$GITHUB_STEP_SUMMARY"
```

For the frontend repo: `backend-` → `frontend-`, and the header says "Vercel deploys this repo from `main` on push … the rollback itself is Vercel's Instant Rollback, pointed at the deployment built from the commit this tag names. See RECOVERY.md §12.2."

- [ ] **Step 2: Sanity-check the naming locally**

```bash
git fetch origin
sha=$(git rev-parse --short=7 origin/main)
echo "backend-$(date -u +%Y%m%d-%H%M)-${sha}"
git describe --tags --abbrev=0 --match 'backend-*' origin/main^ 2>/dev/null || echo "(no previous tag — expected on the first run)"
```

- [ ] **Step 3: Verify after merge — this is the one task you must watch land**

The tag is only real once the workflow runs on `main`. After the merge:
```bash
git fetch --tags origin && git tag --list 'backend-*' | tail -3
gh release list -R getlotlogic/lotlogic-backend | head -3
```
Expect exactly one tag and one release, and the release body to say "First tagged production deploy." The **second** deploy is the one that proves the `prev` logic — check that its notes list the commits between the two tags.

**Why no Railway/Vercel API call:** adding `RAILWAY_API_TOKEN` or `VERCEL_TOKEN` to GitHub Actions would let the workflow record the provider's own deployment id alongside the tag, which is slightly nicer. It also puts a token that can redeploy production into a third system for a nicety. Decision **D4** — default is no token.

**Commits:** one per repo — `ci: tag and release every production deploy`

---

### Task 7: `RECOVERY.md` — correct it, and write the three rollback procedures

**Findings:** REL-16, DEL-11, REL-8. **Repos:** both. **Depends on:** Tasks 3 and 6 (it documents the workflows and the tag names they produce).

`RECOVERY.md` (frontend repo root) was last written 2026-06-05. It predates the live pay-to-park money path, counts 17 edge functions (there are 16 — `test-resend-probe` is gone), says every function is `verify_jwt=false` except two (thirteen are, three are not), and **has no rollback section at all**. `recovery/db-state.md` (backend) is the same vintage.

**Files:**
- Modify: `lotlogic/RECOVERY.md` — §3 (deploy map), §4 (edge functions), §5 (secrets), §11 (checklist); **add §12 Rollback**
- Modify: `lotlogic-backend/recovery/db-state.md` — the August wedge state

**Do not touch §7.** Wave 2.4's plan rewrites §7 ("Migrations cannot rebuild the schema") when the baseline lands. Leaving it alone means either order works. If you find §7 already rewritten, 2.4 landed first — good, leave it.

- [ ] **Step 1: §3 — the deploy map now has a workflow for everything**

Replace the table:

```markdown
## 3. Repositories & deploy map
| Repo / path | Deploys to | Trigger |
|---|---|---|
| `lotlogic/frontend/*` | Vercel (project `lotlogic`, root dir `frontend/`) | auto on push to `main`; tagged `frontend-<ts>-<sha>` by `.github/workflows/deploy-tag.yml` |
| `lotlogic/supabase/functions/*` (all 16) | Supabase Edge | auto on push to `main` via `.github/workflows/edge-functions.yml` — type-checked and tested first, and only the slugs whose sources changed are deployed |
| `lotlogic/cloudflare-workers/email-tow-action` | Cloudflare Workers | **manual** `wrangler deploy` |
| `lotlogic/puller`, `lotlogic/monitoring` | Railway workers | auto on push — **both are the retired camera-zone pipeline; see programme fat decision 2 (turn off / delete)** |
| `lotlogic-backend` | Railway API (`lotlogic-backend-production.up.railway.app`) | auto on push to `main`; tagged `backend-<ts>-<sha>` by `.github/workflows/deploy-tag.yml` |

GitHub Actions secrets required: 🔑 `SUPABASE_ACCESS_TOKEN` (edge deploys),
🔑 `SUPABASE_URL`, 🔑 `INTERNAL_TOKEN`, the Playwright `TEST_*` account creds,
and 🔑 `VERCEL_AUTOMATION_BYPASS_SECRET` (preview e2e). The deploy-tag and
secret-scan workflows use the automatic `GITHUB_TOKEN` and need nothing added.
```

- [ ] **Step 2: §4 — sixteen functions, and which ones are actually authenticated**

```markdown
## 4. Edge functions (16 live, Supabase project `nzdkoouoaedbbccraoti`)
All need `SUPABASE_URL` + 🔑`SUPABASE_SERVICE_ROLE_KEY`.

`verify_jwt` is declared per function in `supabase/config.toml`, which the CLI
reads at deploy time — that file, not a CLI flag, is the source of truth.
**`verify_jwt=true` is not authentication**: the key it accepts is the
publishable anon key, which ships in every page of lotlogicparking.com. What
actually gates each function:

| Gate | Functions |
|---|---|
| 🔑`INTERNAL_TOKEN` bearer | check-violations · cron-sessions-sweep · notify-expiring-plates · tow-confirm · tow-dispatch-email · tow-dispatch-sms · camera-watchdog · cron-no-reg-sweep · cron-plate-pair-learn · weather-pull · weather-risk-eval |
| Trailing-path URL secret | camera-snapshot (🔑`CAMERA_SNAPSHOT_URL_SECRET`) · pr-ingest (🔑`PR_INGEST_URL_SECRET`) |
| 🔑`CAMERA_DEBUG_TOKEN` | camera-debug |
| Backend-issued HS256 JWT, verified in-function, scoped on `properties.tow_company_id` | walk-around-ocr |
| Anon key only — reads a third-party billing API, writes nothing | simbase-usage |

A camera's MAC **is** its `alpr_cameras.api_key`, the value `camera-snapshot`
matches an inbound frame against. Treat MACs as credentials: they belong in the
database and in the vault, never in source. They come back with a DB restore.

Deploy drift guard: the workflow is the only thing that should deploy. Before
any hand deploy, diff against the deployed copy (`supabase functions download
<slug>` or the MCP `get_edge_function`) — live source that is not in git has
happened here before.
```

- [ ] **Step 3: §12 — the three rollback procedures (new section, at the end)**

This is the heart of the task. Write it so a stranger can follow it under pressure, which means: what you type, what you expect to see, and how you know it worked.

````markdown
---

## 12. Rollback — how to undo a deploy

Every production deploy is tagged by CI at the moment of the push
(`.github/workflows/deploy-tag.yml` in each repo). The tag's annotation names
the tag that was live before it, so the rollback target is always one command
away:

```bash
git fetch --tags origin
git tag --list 'backend-*'  | tail -2   # or frontend-*
git show <newest-tag> | head -8         # the annotation names the previous one
```

There is no staging environment (that is Wave 3.3), so every rollback below is
performed against production. Tell someone before you start.

### 12.1 Backend (Railway)

Railway builds this repo's `main` with the Dockerfile and serves it at
`lotlogic-backend-production.up.railway.app`.

1. Find the target: `git show $(git tag --list 'backend-*' | tail -1) | head -8`
   → the line `Previous production tag: backend-…` is where you are going.
2. **Railway dashboard → project → the API service → Deployments.** Find the
   deployment whose commit is that tag's SHA (the tag name ends in the short
   SHA). Use **Redeploy** on it. Railway rebuilds that commit; it does not
   change what is on `main`.
3. Watch `/ready` — not `/health`. `/health` answers "ok" without touching the
   database and stayed green through both August wedges.
   `watch -n5 'curl -s -o /dev/null -w "%{http_code}\n" https://lotlogic-backend-production.up.railway.app/ready'`
   Expect `200` within about 90 seconds.
4. **Then fix `main`.** A Railway redeploy is not a code change: the next push
   to `main` deploys the bad commit again. Either `git revert <bad sha>` and
   push, or ship the fix forward. Until you do, the running code and `main`
   disagree — say so in the channel.
5. **If the bad deploy included a migration**, the rollback is not complete:
   Railway redeploying old code against a new schema is its own outage. Stop,
   read `recovery/db-state.md`, and roll the schema back first. Wave 2.4's
   baseline + migration runner is what makes this a procedure rather than an
   improvisation; until it lands, a migration rollback is a manual,
   write-it-down-as-you-go operation with a `pg_dump` taken first.

### 12.2 Frontend (Vercel)

Vercel builds `frontend/` from `main` on push.

1. Find the target tag as above, with `frontend-*`.
2. **Vercel dashboard → project `lotlogic` (team `gabebs1-2452s-projects`) →
   Deployments.** Find the Production deployment built from that tag's commit
   and use **Instant Rollback**. This is an alias switch, not a rebuild — it
   takes seconds and cannot fail on a build error.
3. Verify: load `https://lotlogicparking.com/app` in a private window and check
   that the dashboard renders and a property's roster loads. Then load the QR
   page for the plaza (`/visit?...`) — that is the surface a driver standing in
   a lot is using.
4. **Then fix `main`**, same reasoning as 12.1: the next push re-deploys the bad
   commit and silently un-does the rollback.

### 12.3 Edge functions (Supabase)

Supabase keeps no deployment history and has no rollback button. Redeploying the
old source **is** the rollback, and `.github/workflows/edge-functions.yml` can do
it from a tag.

1. **GitHub → Actions → "Edge functions" → Run workflow.**
2. Set **ref** to the `frontend-*` tag you want back, and **only** to the slug(s)
   to restore — e.g. `ref: frontend-20260914-1130-a1b2c3d`, `only: camera-snapshot`.
   Leaving `only` blank redeploys all 16 from that ref, which is the right move
   if you do not know which one broke.
3. The run type-checks and tests before it deploys, so a rollback to a commit
   that was itself broken fails loudly instead of shipping.
4. Verify the one that matters — the camera path:
   ```sql
   -- most recent frame the pipeline accepted
   select id, camera_id, plate_text, created_at
     from plate_events order by created_at desc limit 5;
   ```
   A gap that starts at the bad deploy and does not close within a few minutes
   of the rollback means the rollback did not take. Check the function's logs
   (`mcp__supabase__query_logs`, service `edge-function`).
5. **Then fix `main`**, same reasoning: the next push to `main` deploys the bad
   source again.
6. `camera-snapshot`, `pr-ingest` and `cron-sessions-sweep` write to the database
   on every invocation. Rolling one of them back does not un-write what the bad
   version wrote. Check `plate_events`, `visitor_passes` and `alpr_violations`
   for rows created during the bad window before you call it done.

### 12.4 What is NOT covered here

- **Database schema.** See §7 and `lotlogic-backend/recovery/db-state.md`.
  Wave 2.4 owns making this a procedure.
- **Git history rewrites.** Credentials that were committed and later removed are
  still in history. Removing them means a force-push that invalidates every
  clone and every open PR. Not an emergency operation; decide it deliberately.
- **Cloudflare Worker (`email-tow-action`)**: `wrangler rollback` from the
  `cloudflare-workers/email-tow-action` directory; it deploys by hand, so it is
  not tagged.
````

- [ ] **Step 4: §11 — the human checklist gets the items this wave created**

Add to the existing checklist:
- [ ] Confirm the first `backend-*` and `frontend-*` tags appeared after the next deploy of each repo.
- [ ] Do one **rehearsed** rollback of the frontend (12.2) at a quiet hour, and write the elapsed time next to the procedure. A procedure nobody has ever run is a wish.

- [ ] **Step 5: `recovery/db-state.md` — write the August wedge down (REL-8)**

The wedge fix has three parts and only one of them is a file. Record all three, including which are console-only:

```markdown
## August 2026 database wedge — the fix, and where each part lives

Two Postgres seizures (2026-08-18, 2026-08-22) and a 95-minute supavisor
checkout timeout (2026-09-04 22:50 → 09-05 00:25 ET). Four changes came out of
it. Only one is a file in this repo, which is why this section exists.

| Change | Where it lives | Reproducible from git? |
|---|---|---|
| Flagged-only expression indexes behind the `prior_flag_count` subquery | `migrations/20260818_visitor_passes_cooldown_indexes.sql` | Yes — **but the filename is 8 digits, not the `YYYYMMDDHHMMSS_` the rest use.** Wave 2.4's drift check will not see it. Flagged to 2.4; do not rename it here, it is already recorded in `supabase_migrations.schema_migrations` under this name. |
| Supabase compute Nano → Small; supavisor pool size 15 → 20 | Supabase dashboard only | **No.** Re-set by hand after any project restore. |
| Backend pool `DB_POOL_SIZE=8`, `DB_MAX_OVERFLOW=7` | Railway environment variables | **No.** Listed in RECOVERY.md §5; re-set by hand. |
| `cron.job_run_details` purge (406k rows / 156 MB removed, plus a daily purge job) | pg_cron row → `recovery/pg_cron.sql` | Yes, if `pg_cron.sql` is current — **verify it contains the purge job before trusting this line.** |

Restore drill (do this once, then write the date here): restore the most recent
Supabase backup into a scratch project, run `recovery/pg_cron.sql`, set the two
pool variables, and confirm `select count(*) from cron.job where active` matches
production. Last run: **never**.
```

Then actually check `recovery/pg_cron.sql` for the purge job and fix the line to say what is true.

- [ ] **Step 6: Verify**

```bash
cd /Users/gabe/lotlogic
grep -q '^## 12. Rollback' RECOVERY.md && echo "§12 present"
grep -c '### 12\.[123] ' RECOVERY.md          # expect 3
grep -q '17 live' RECOVERY.md && echo "STALE COUNT STILL THERE" || echo "count fixed"
grep -q 'test-resend-probe' RECOVERY.md && echo "GHOST FUNCTION STILL LISTED" || echo "ok"
# Every slug named in §4 exists.
for s in $(node supabase/functions/_ci/slugs.mjs list | tr -d '[]"' | tr ',' ' '); do
  grep -q "$s" RECOVERY.md || echo "MISSING FROM §4: $s"; done
```

**Commits:** two — `docs(recovery): three rollback procedures, and a deploy map that is true` and `docs(recovery): record which parts of the August wedge fix are reproducible`

---

### Task 8: Developer docs stop describing a product that was deleted in March

**Findings:** DEL-13, PIPE-11. **Repos:** both. **Depends on:** nothing.

The frontend repo solved this on 2026-09-03: 46 finished build plans moved to `docs/archive/`, and `docs/README.md` says in one page which documents are still true. The backend repo never got the treatment, and both `CLAUDE.md` files still narrate the retired camera-zone pipeline as if it were running.

**Scope boundary — read this twice.** `puller/`, `monitoring/`, `openalpr-sidecar/` and `supabase-schema.sql` are all still in the frontend repo and all still deploy. **Deleting them is fat decisions 1, 2 and 11 and needs Gabe's answer.** This task changes what the documents *say*, never what the code *is*. A `CLAUDE.md` that describes a retired service as retired-but-still-running is correct; one that deletes the service is out of scope.

**Files:**
- Create: `lotlogic-backend/docs/README.md`
- Move: `lotlogic-backend/docs/{parking-violation-plan.md,quickbooks-production-setup.md}` → `docs/archive/`
- Modify: `lotlogic/CLAUDE.md`, `lotlogic-backend/CLAUDE.md`, both `docs/claude-code-setup.md`

- [ ] **Step 1: Backend `docs/` — archive the finished, keep the living**

```bash
cd /Users/gabe/lotlogic-backend
mkdir -p docs/archive
git mv docs/parking-violation-plan.md docs/archive/2026-04-17-parking-violation-plan.md
git mv docs/quickbooks-production-setup.md docs/archive/2026-04-18-quickbooks-production-setup.md
```

`parking-violation-plan.md` (324 lines, 2026-04-17) is the lots→properties Phase A plan; Phase A3 is Wave 3.6's job and the document describes the retired zone pipeline throughout. `quickbooks-production-setup.md` (247 lines, 2026-04-18) narrates a Resend→SendGrid migration as pending; it completed in April.

**Before archiving the QuickBooks document, harvest it.** It is the only written account of the Intuit app configuration (realm, redirect URI, sandbox→production promotion). Anything in it that is still operationally required moves into `RECOVERY.md` §2/§5 or into the new `docs/README.md` — Task 11's tests will not tell you how to re-OAuth. Do this before the `git mv`, in the same commit.

- [ ] **Step 2: `lotlogic-backend/docs/README.md`**

Mirror the frontend's file, in the frontend's voice:

```markdown
# What in here is current

`docs/` accumulated build plans for work that shipped months ago, filed next to
the documents that are still true, with nothing marking which was which.

**Everything under `docs/archive/` is history.** Read it to find out why
something was built the way it was; never read it to find out how the system
works today.

## The living documents

| Document | What it is |
|---|---|
| [`../CLAUDE.md`](../CLAUDE.md) | The rulebook for this repo — architecture, the tenant-scoping pattern, what not to touch. Every AI session loads it at startup. |
| [`pay2park-rollout.md`](./pay2park-rollout.md) | The live pay-to-park money path: rollout state, the sandbox harness, the reconciliation loop. |
| [`../recovery/db-state.md`](../recovery/db-state.md) | Database state that migrations cannot rebuild, and which parts of the August 2026 wedge fix are reproducible from git. |
| [`../recovery/pg_cron.sql`](../recovery/pg_cron.sql) | Every scheduled database job, as SQL. Re-run after any restore. |
| [`claude-code-setup.md`](./claude-code-setup.md) | The project-scoped Claude Code / MCP configuration in `.claude/`. |

Disaster recovery and the secrets inventory live in the **frontend** repo's
[`RECOVERY.md`](https://github.com/getlotlogic/lotlogic/blob/main/RECOVERY.md) —
one runbook covers both repos. Rollback procedures are its §12.

Migrations are this repo's source of truth even though a copy of some of them
lives in the frontend repo.

## The archive

| File | What it held |
|---|---|
| `archive/2026-04-17-parking-violation-plan.md` | The lots→properties Phase A plan. Phase A3 is Wave 3.6. |
| `archive/2026-04-18-quickbooks-production-setup.md` | Intuit app setup, April. Anything still needed moved to RECOVERY.md §5. |

Nothing under `archive/` is maintained. If a document there still describes how
something works, that fact belongs in `CLAUDE.md`, not in the archive.
```

- [ ] **Step 3: `lotlogic/CLAUDE.md` — the dead-pipeline purge**

Roughly 90 lines describe machinery whose producer stopped in March. Replace, do not simply delete — a reader needs to know the sections went away on purpose:

- **Lines 29-31** (`Snapshot Puller`, `Monitoring`, `Detection Pipeline`): replace the three bullets with one:
  ```markdown
  - **Retired: the camera-zone pipeline.** `puller/` (Railway worker polling RTSP
    snapshots), `monitoring/` (the zone-guardian agent) and the YOLO zone-overlap
    violation engine were the original design. Their producer stopped in March
    2026; the live pipeline is the camera-based ALPR one below. The folders and
    the two Railway services still exist — deleting them is programme fat
    decision 2 and needs an answer, not a commit. **Do not build on them, and do
    not read `zone_occupancy`, `snapshots.raw_detections` or `camera_zones` as
    live data.**
  ```
- **Lines 80-146** (the whole "Detection Pipeline Gotchas & Learnings" block — zone IoU, Zone Guardian, detection monitoring, auto-diagnosis, the zone-coordinate gotchas): move verbatim to `docs/archive/2026-03-zone-pipeline-learnings.md` and leave a one-line pointer. That knowledge is real and was hard-won; it is just not current.
- **Line 69** (`supabase-schema.sql` in the repo tree): annotate — *"describes a database that no longer exists (creates `owners`/`partners`; the real tables are `lot_owners`/`enforcement_partners`). Nothing executes it. Deleting it is fat decision 11."*
- **Line 231** (`Edge functions deploy out-of-band` under Known Bottlenecks): this is now false. Replace with:
  ```markdown
  - ~~Edge functions deploy out-of-band~~ → **RESOLVED (Wave 2.9, 2026-09).** All
    16 deploy from `.github/workflows/edge-functions.yml` on push to `main`,
    type-checked (`deno check`) and tested (`deno test`) first, and only the
    slugs whose sources actually changed. The matrix is computed from the import
    graph by `supabase/functions/_ci/slugs.mjs`, so a shared file
    (`pr-ingest/r2.ts`, `camera-snapshot/no_reg_violations.ts`) redeploys every
    slug that reaches it. Rollback: RECOVERY.md §12.3.
  ```
- **The "Deploying edge functions" section (line 298)**: rewrite as "the workflow deploys; here is how to deploy one by hand in an emergency and how to roll one back". Keep the env-var inventory — it is accurate and useful. Keep the drift-check instruction.
- **Line 316**: two different values for `TOW_CONFIRM_MIN_CONFIDENCE` appear in this repo's own documents (`0.65` here, `0.85` in an older section). Check the deployed secret (`supabase secrets list`) and write the true one, once.

- [ ] **Step 4: `lotlogic-backend/CLAUDE.md` and both `claude-code-setup.md`**

- Backend `CLAUDE.md:162` carries a live camera MAC — Task 4 removes it; if Task 4 has not landed in your branch, leave that line alone and let Task 4 have it (do not both edit the same line).
- Both `docs/claude-code-setup.md` files are from 2026-04-18 and describe a `.claude/` that has moved on. Reconcile each against the actual directory (`ls -R .claude/`) and against `.claude/settings.json` — in particular the hooks section, which now has `pre-commit-secrets-scan.sh` **and** `migration-recorded-check.sh` and should say that CI runs gitleaks independently (Task 5).

- [ ] **Step 5: Verify**

```bash
cd /Users/gabe/lotlogic
# No document claims the zone pipeline is live outside the archive.
grep -rn "zone_guardian\|runs every 10 minutes" --include='*.md' . | grep -v '/docs/archive/' || echo "clean"
# The bottleneck list no longer claims manual edge deploys.
grep -n "Edge functions deploy out-of-band" CLAUDE.md
cd /Users/gabe/lotlogic-backend && test -f docs/README.md && ls docs/archive/
# Markdown links resolve (no tool needed — just check the ones you wrote).
```

Neither repo's tests cover prose, so the honest gate here is a re-read: open `CLAUDE.md` top to bottom and ask of each paragraph "is this true today". That is the whole finding.

**Commits:** two — `docs: archive the finished backend plans, say what is current` and `docs: stop describing the retired zone pipeline as live`

---

### Task 9: Extend the real-Postgres harness to cover QuickBooks and the reservation app

**Findings:** DEL-6, BACKEND-11 (the enabling half). **Repo:** `getlotlogic/lotlogic-backend`. **Depends on:** nothing.

`tests/plaza/` already is the harness the program doc calls "a 10,000-line test harness against a real database": PostgreSQL 17, a verbatim production schema extract, replayed migrations, `app_client` over `main.app`, and a `dbx` accessor. It covers eight tables. QuickBooks invoicing reads four it does not have; the reservation app reads two more.

This task adds the schema and the fixtures. Tasks 11 and 12 write the tests. Splitting them this way means the schema work — which is careful, catalog-reading, production-touching work — is one subagent's whole job.

**Files:**
- Modify: `tests/plaza/schema/live_schema.sql`
- Modify: `tests/plaza/conftest.py`

**Interfaces (produced for Tasks 11–14):**
- `seed_partner` — function fixture: `await seed_partner(quickbooks_customer_id="QB1", lotlogic_tow_fee_cents=10000, **overrides) -> uuid.UUID`
- `seed_violation` — function fixture: `await seed_violation(partner_id, *, action_taken="tow", tow_confirmed_at=..., plate="ABC1234", **overrides) -> uuid.UUID`, inserting into `alpr_violations` against the seeded plaza property
- `seed_integration` — function fixture: `await seed_integration(provider="quickbooks", realm_id="9341456900947821") -> uuid.UUID`, writing Fernet-encrypted token columns with `services.crypto.encrypt_str`
- `seed_booking` — function fixture: `await seed_booking(**overrides) -> uuid.UUID` for `app_bookings`
- `dbx` gains `count_bookings(**filters)`, `get_pending_invoice(id)`, `get_booking(id)`

- [ ] **Step 1: Pull the DDL from production, verbatim — do not hand-write it**

The existing file's header sets the standard: "Every CREATE TABLE column, CHECK constraint, index and function/trigger body below is a VERBATIM extract from production … Nothing here is hand-written except the section headers." Hold that line. Use `mcp__supabase__execute_sql` against `nzdkoouoaedbbccraoti` with catalog SELECTs (`information_schema.columns`, `pg_get_constraintdef`, `pg_indexes`, `pg_get_viewdef`) for:

| Object | Needed by | Notes |
|---|---|---|
| `integrations` | QuickBooks OAuth | Originates in `migrations/20260417213323_quickbooks_integration.sql`; take the **live** shape, which may have drifted. |
| `pending_invoices` | 8 of the 12 QB endpoints | Same migration. Includes `pending_invoices_partner_week_unique` — several tests depend on that constraint. |
| `alpr_violations` | `run-weekly-invoicing` | Large. **Omit the AFTER INSERT trigger `trg_alpr_retro_visitor_pass`** and its function, for exactly the reason the existing header gives for omitting it from `visitor_passes`: it reaches into three more tables no test here touches. Record the omission in the header. |
| `v_violation_billing_status` | `run-weekly-invoicing` joins it | A view. `pg_get_viewdef(…, true)`. |
| `markets`, `lots` | `run-weekly-invoicing` resolves a market timezone through `Lot` → `Market` | Minimal: the columns `models.py` declares. Without them the SQLAlchemy `select(Lot)` errors mid-request and the endpoint 500s for a reason that has nothing to do with invoicing. |
| `app_bookings`, `app_otp_codes` | the reservation app | From `migrations/20260728120000_app_bookings_and_rates.sql`. `properties.app_enabled` and `app_rates` are **already** in the extract (lines 110-111) — do not re-add them. |

`enforcement_partners` is already present and already has `quickbooks_customer_id` and `lotlogic_tow_fee_cents`. Confirm, do not re-add.

Foreign keys pointing at tables still outside the subset get commented out with a note, exactly as the existing file does.

- [ ] **Step 2: `MIGRATION_GLOBS` and `TRUNCATE_TABLES`**

```python
#: Migration files replayed on top of the live-schema extract, in sorted order
#: across every pattern. 20260902* is the pay-to-park set; 20260905* is the
#: Wave 2.7 ops-monitoring set (ops_job_runs, outbound_notices); 20260907* is
#: Wave 2.8's ops_job_runs_source_check update; 20260910*/20260911* are the
#: tow-sighting-evidence and brain sets; 20260914* is Wave 2.9's database
#: hygiene set (cancel_reason, hot-table indexes, app_enabled).
MIGRATION_GLOBS = (
    "20260902*.sql", "20260905*.sql", "20260907*.sql", "20260910*.sql",
    "20260911*.sql", "20260914*.sql",
)

TRUNCATE_TABLES = (
    "visitor_passes", "plaza_payments", "plate_holds", "plate_events",
    "plaza_reconciliations", "ops_job_runs", "outbound_notices", "ops_findings",
    "tow_sighting_clips", "tow_clip_files", "tow_digest_runs",
    "partner_truck_sightings", "alpr_cameras",
    # Wave 2.9: QuickBooks + reservation app. Order is irrelevant — one
    # TRUNCATE ... CASCADE. alpr_violations precedes enforcement_partners only
    # for readability.
    "alpr_violations", "pending_invoices", "integrations",
    "app_bookings", "app_otp_codes",
    "enforcement_partners",
    "brain.work_items", "brain.worker_runs", "brain.questions", "brain.metrics",
    "brain.facts", "brain.decisions", "brain.findings", "brain.entities",
    "brain.workers", "brain.retrieval_index",
)
```

Add `"integrations"` and `"pending_invoices"` to `PRODUCTION_CANARY_TABLES` as well — this harness drops schema `public`, and the canary list is the thing standing between a mistyped `TEST_DATABASE_URL` and production.

- [ ] **Step 3: The fixtures**

```python
@pytest_asyncio.fixture
async def seed_partner(db_conn):
    """An enforcement partner wired for QuickBooks invoicing.

    `quickbooks_customer_id` is what `run-weekly-invoicing` filters on: a
    partner without one is invisible to the whole flow, which is itself worth a
    test (see test_quickbooks_endpoints.py::test_weekly_skips_unmapped_partner).
    """
    async def _make(**overrides):
        pid = uuid.uuid4()
        row = {
            "id": pid,
            "company_name": overrides.pop("company_name", "Test Towing LLC"),
            "email": overrides.pop("email", "partner@example.invalid"),
            "active": overrides.pop("active", True),
            "quickbooks_customer_id": overrides.pop("quickbooks_customer_id", "QB-1"),
            "lotlogic_tow_fee_cents": overrides.pop("lotlogic_tow_fee_cents", 10000),
            **overrides,
        }
        cols = ", ".join(row)
        vals = ", ".join(f":{k}" for k in row)
        await db_conn.execute(
            text(f"INSERT INTO public.enforcement_partners ({cols}) VALUES ({vals})"), row
        )
        await db_conn.commit()
        return pid
    return _make


@pytest_asyncio.fixture
async def seed_integration(db_conn):
    """A connected QuickBooks integration row.

    The token columns are Fernet ciphertext — `services.quickbooks` decrypts
    them on every call, so a plaintext fixture would make every test fail inside
    the crypto layer instead of where the test is looking. ENCRYPTION_KEY comes
    from tests/conftest.py's defaults.
    """
    from services.crypto import encrypt_str

    async def _make(**overrides):
        iid = uuid.uuid4()
        row = {
            "id": iid,
            "provider": overrides.pop("provider", "quickbooks"),
            "realm_id": overrides.pop("realm_id", "9341456900947821"),
            "access_token_encrypted": encrypt_str(overrides.pop("access_token", "at-1")),
            "refresh_token_encrypted": encrypt_str(overrides.pop("refresh_token", "rt-1")),
            # Default: comfortably valid, so a test that is not ABOUT refresh
            # never accidentally exercises the refresh path. The refresh tests
            # pass expires_at explicitly.
            "expires_at": overrides.pop(
                "expires_at", datetime.now(timezone.utc) + timedelta(hours=1)
            ),
            **overrides,
        }
        cols = ", ".join(row)
        vals = ", ".join(f":{k}" for k in row)
        await db_conn.execute(
            text(f"INSERT INTO public.integrations ({cols}) VALUES ({vals})"), row
        )
        await db_conn.commit()
        return iid
    return _make
```

`seed_violation` and `seed_booking` follow the same shape. Give `seed_violation` the defaults that make a row **billable** (`action_taken='tow'`, `tow_confirmed_at` set, `invoiced_at IS NULL`, `action_at` inside the previous week and older than the 48-hour grace cutoff) and let tests override to make it not-billable — the interesting tests are the ones where a row is correctly *excluded*.

- [ ] **Step 4: Verify the harness still builds, and that the new tables are really there**

```bash
cd /Users/gabe/lotlogic-backend
pytest tests/plaza/test_harness.py -q                 # the harness's own self-test
pytest tests/plaza -q                                  # every existing suite still green
```
Then a throwaway assertion (delete it before committing) proving the schema landed:
```python
async def test_scratch(db_conn):
    for t in ("integrations", "pending_invoices", "alpr_violations",
              "app_bookings", "app_otp_codes", "markets", "lots"):
        await db_conn.execute(text(f"SELECT 1 FROM public.{t} LIMIT 1"))
    await db_conn.execute(text("SELECT 1 FROM public.v_violation_billing_status LIMIT 1"))
```

If Postgres 17 is not available locally the whole package **skips** — which looks like success. Check the summary line says `passed`, not `skipped`. `pg_ctl --version` or `brew install postgresql@17`.

- [ ] **Step 5: Prove the canary works**

Point `TEST_DATABASE_URL` at a database containing a table named `pending_invoices` and confirm the harness refuses to run rather than dropping schema `public`. Then unset it.

**Commit:** `test(harness): extend the live-schema extract to QuickBooks and the reservation app`

---

### Task 10: Fake QuickBooks and Stripe at the HTTP boundary

**Findings:** DEL-6, BACKEND-11 (the enabling half). **Repo:** `getlotlogic/lotlogic-backend`. **Depends on:** nothing.

A fake at the *function* boundary (`monkeypatch.setattr(qb, "create_invoice", …)`) tests the router and skips the client. A fake at the *HTTP* boundary runs the real OAuth refresh, the real header construction, the real status-code mapping, the real `QuickBooksError` translation — everything between the router and the wire — and stubs only the wire. That is the difference between "the endpoint calls something" and "the endpoint works".

**Square is out of scope** — `services/square*.py` is on the never-edit list and its 40-odd existing tests are green at the function boundary. See Scope call 4 and decision **D6**.

**Files:**
- Create: `tests/plaza/fakes/__init__.py`, `tests/plaza/fakes/http.py`
- Modify: `services/quickbooks.py` (one factory, four call sites)
- Modify: `tests/plaza/conftest.py` (two fixtures)

**Interfaces:**
- `FakeHttp()` — `.route(method, url_contains, *, status=200, json=None, content=None, headers=None, times=None)`, `.calls: list[RecordedCall]`, `.transport -> httpx.MockTransport`, `.assert_called(method, url_contains)`, `.last(method, url_contains) -> RecordedCall`
- `RecordedCall` — `method`, `url`, `headers`, `json_body`, `form_body`, `content`
- fixture `qb_http` → `FakeHttp` with `services.quickbooks._http_client` bound to it
- fixture `stripe_http` → `FakeHttp` with `stripe.default_http_client` bound to it

- [ ] **Step 1: The one production-side seam**

`services/quickbooks.py` builds a client in four places (`exchange_code`, `_refresh_tokens`, and twice in `_call_qb`). Give them one factory:

```python
def _http_client() -> httpx.AsyncClient:
    """The one place an outbound QuickBooks HTTP client is built.

    Tests bind this to a client carrying an ``httpx.MockTransport`` so the OAuth
    refresh, the header construction and the status-code mapping in ``_call_qb``
    all really run and only the wire is stubbed. Production passes no transport
    and behaves exactly as before.
    """
    return httpx.AsyncClient(timeout=30.0)
```
and replace each `async with httpx.AsyncClient(timeout=30.0) as client:` with `async with _http_client() as client:`. Four lines. **No behaviour change** — same class, same timeout, same context management. Confirm with `git diff --stat` that nothing else moved.

- [ ] **Step 2: `tests/plaza/fakes/http.py`**

```python
"""One outbound-HTTP fake, shared by the QuickBooks and Stripe suites.

The point is WHERE it sits. Patching ``services.quickbooks.create_invoice``
tests that the router calls something. Patching the transport underneath
``httpx`` means ``_call_qb`` really runs: it really refreshes an expired token,
really sets ``Authorization``/``Accept``, really maps a 401 to a retry and a 400
to ``QuickBooksError``. Only the socket is imaginary.

Routes are matched in registration order by (method, substring-of-url). An
unmatched request raises — a test that silently talks to an endpoint nobody
declared is a test that is lying about its scope.
"""
from __future__ import annotations

import json as _json
from dataclasses import dataclass, field
from typing import Any

import httpx


@dataclass
class RecordedCall:
    method: str
    url: str
    headers: dict[str, str]
    content: bytes
    json_body: Any = None
    form_body: dict[str, str] = field(default_factory=dict)


@dataclass
class _Route:
    method: str
    contains: str
    status: int
    json: Any
    content: bytes | None
    headers: dict[str, str]
    times: int | None
    used: int = 0


class FakeHttp:
    def __init__(self) -> None:
        self._routes: list[_Route] = []
        self.calls: list[RecordedCall] = []

    def route(self, method: str, url_contains: str, *, status: int = 200,
              json: Any = None, content: bytes | None = None,
              headers: dict[str, str] | None = None, times: int | None = None) -> "FakeHttp":
        """Answer `method` requests whose URL contains `url_contains`.

        `times=1` makes the route single-use, which is how you script a
        sequence: a 401 once, then a 200. That is the shape of a token refresh.
        """
        self._routes.append(_Route(method.upper(), url_contains, status, json,
                                   content, headers or {}, times))
        return self

    # ── httpx side ──────────────────────────────────────────────────────────
    @property
    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self._handle)

    def _handle(self, request: httpx.Request) -> httpx.Response:
        body = request.content or b""
        parsed = None
        form: dict[str, str] = {}
        ctype = request.headers.get("content-type", "")
        if body and "json" in ctype:
            try:
                parsed = _json.loads(body)
            except ValueError:
                parsed = None
        elif body and "x-www-form-urlencoded" in ctype:
            from urllib.parse import parse_qsl
            form = dict(parse_qsl(body.decode()))
        self.calls.append(RecordedCall(
            method=request.method, url=str(request.url),
            headers=dict(request.headers), content=body,
            json_body=parsed, form_body=form,
        ))
        for r in self._routes:
            if r.method != request.method or r.contains not in str(request.url):
                continue
            if r.times is not None and r.used >= r.times:
                continue
            r.used += 1
            if r.content is not None:
                return httpx.Response(r.status, content=r.content, headers=r.headers)
            return httpx.Response(r.status, json=r.json, headers=r.headers)
        raise AssertionError(
            f"FakeHttp: no route for {request.method} {request.url}. "
            f"Declared: {[(r.method, r.contains) for r in self._routes]}"
        )

    # ── assertions ──────────────────────────────────────────────────────────
    def matching(self, method: str, url_contains: str) -> list[RecordedCall]:
        return [c for c in self.calls
                if c.method == method.upper() and url_contains in c.url]

    def assert_called(self, method: str, url_contains: str, times: int | None = None) -> None:
        hits = self.matching(method, url_contains)
        assert hits, (f"expected {method} …{url_contains}; saw "
                      f"{[(c.method, c.url) for c in self.calls]}")
        if times is not None:
            assert len(hits) == times, f"expected {times} × {method} …{url_contains}, got {len(hits)}"

    def assert_not_called(self, method: str, url_contains: str) -> None:
        hits = self.matching(method, url_contains)
        assert not hits, f"did not expect {method} …{url_contains}; saw {[c.url for c in hits]}"

    def last(self, method: str, url_contains: str) -> RecordedCall:
        hits = self.matching(method, url_contains)
        assert hits, f"no {method} …{url_contains} recorded"
        return hits[-1]
```

- [ ] **Step 3: The two fixtures in `tests/plaza/conftest.py`**

```python
@pytest.fixture
def qb_http(monkeypatch):
    """QuickBooks faked at the socket. `services.quickbooks` runs for real."""
    from tests.plaza.fakes.http import FakeHttp
    from services import quickbooks as qb

    fake = FakeHttp()
    monkeypatch.setattr(
        qb, "_http_client",
        lambda: httpx.AsyncClient(timeout=30.0, transport=fake.transport),
    )
    return fake


@pytest.fixture
def stripe_http(monkeypatch):
    """Stripe faked at the socket, through the SDK's own client seam.

    `stripe.default_http_client` is the documented injection point; setting it
    means `stripe.PaymentIntent.create(...)` really builds the request, really
    signs it, and really parses the response — it just never opens a socket.
    """
    import stripe
    from stripe import http_client as stripe_http_client
    from tests.plaza.fakes.http import FakeHttp

    fake = FakeHttp()

    class _Client(stripe_http_client.HTTPClient):
        name = "fakehttp"

        def request(self, method, url, headers, post_data=None):
            resp = fake._handle(httpx.Request(
                method.upper(), url, headers=headers,
                content=(post_data.encode() if isinstance(post_data, str) else post_data),
            ))
            return resp.text, resp.status_code, dict(resp.headers)

        def request_with_retries(self, method, url, headers, post_data=None,
                                 max_network_retries=None):
            return self.request(method, url, headers, post_data)

    monkeypatch.setattr(stripe, "default_http_client", _Client())
    monkeypatch.setattr(get_settings(), "stripe_secret_key", "sk_test_fake", raising=False)
    return fake
```

**Verify the Stripe seam against the pinned SDK before you rely on it.** `requirements.txt` says `stripe>=9.0`; check what `requirements.lock` actually pins and confirm `stripe.http_client.HTTPClient` exposes `request_with_retries(method, url, headers, post_data=None, max_network_retries=None)` returning `(body, status, headers)`:
```bash
python -c "import stripe,inspect; from stripe import http_client as h; print(stripe.VERSION); print(inspect.signature(h.HTTPClient.request_with_retries))"
```
If the signature differs, adapt `_Client` — do **not** fall back to patching `stripe.PaymentIntent.create`, which would move the fake back to the function boundary and defeat the task. If the SDK genuinely has no client seam at the pinned version, stop and raise it as a decision.

- [ ] **Step 4: Prove the fake is at the boundary, not above it**

Add `tests/plaza/test_fake_http.py` — it is the test for the test infrastructure and it is worth having:

```python
async def test_qb_fake_runs_the_real_token_refresh(db_conn, seed_integration, qb_http):
    """An expired access token must produce a REAL refresh POST to Intuit's
    token endpoint before the API call — proof the fake sits under the client
    rather than over it."""
    await seed_integration(expires_at=datetime.now(timezone.utc) - timedelta(minutes=5))
    qb_http.route("POST", "oauth2/v1/tokens/bearer",
                  json={"access_token": "at-2", "refresh_token": "rt-2", "expires_in": 3600})
    qb_http.route("GET", "/query", json={"QueryResponse": {}})

    from services import quickbooks as qb
    integ = await qb.get_active_integration(db_conn)
    await qb._call_qb(db_conn, integ, "GET", "/query", request_id="t-1")

    qb_http.assert_called("POST", "oauth2/v1/tokens/bearer", times=1)
    assert qb_http.last("POST", "oauth2/v1/tokens/bearer").form_body["grant_type"] == "refresh_token"
    assert "Bearer at-2" in qb_http.last("GET", "/query").headers["authorization"]


async def test_unrouted_request_is_an_error(db_conn, seed_integration, qb_http):
    """A fake that answers anything is a fake that hides a bug."""
    await seed_integration()
    from services import quickbooks as qb
    integ = await qb.get_active_integration(db_conn)
    with pytest.raises(AssertionError, match="no route for"):
        await qb._call_qb(db_conn, integ, "GET", "/nowhere", request_id="t-2")
```

**Prove it can fail:** delete the `POST oauth2/v1/tokens/bearer` route from the first test — it must fail with `no route for POST …`, not pass. Restore.

- [ ] **Step 5: Everything still green**

```bash
pytest tests/plaza -q && ruff check . && python -m compileall -q -f .
```
The four-line change to `services/quickbooks.py` touches the live weekly-invoicing path — `tests/test_quickbooks_invoice_builder.py` does not cover it, which is precisely why Task 11 exists. Re-read the diff before committing.

**Commit:** `test(harness): fake QuickBooks and Stripe at the HTTP boundary`

---

### Task 11: QuickBooks invoicing — 12 endpoints, 12 tested

**Findings:** DEL-6, BACKEND-11. **Repo:** `getlotlogic/lotlogic-backend`. **Depends on:** Tasks 9 and 10.

`routers/quickbooks.py` is 608 lines over 12 endpoints and drafts the invoices Gabe actually sends. Its entire test coverage is 37 lines over `build_invoice_payload`, a pure function. Nothing tests that an owner cannot act on another owner's invoice, that a violation is not billed twice, or that a 401 from Intuit refreshes rather than fails.

**Files:**
- Create: `tests/plaza/test_quickbooks_endpoints.py`

**Interfaces:** consumes `app_client`, `dbx`, `service_headers()`, `seed_partner`, `seed_integration`, `seed_violation`, `qb_http`. Produces nothing.

**Auth shapes** (get these right or every test is testing the 401 path):
- `require_platform_admin` → satisfied by the service `X-API-Key` (`service_headers()`, `API_KEY=test` from `tests/conftest.py`) or by a platform-admin JWT. Both are `is_unrestricted`.
- `require_user_subject` + `subject.type != "owner" → 403` → an owner JWT: `{"Authorization": f"Bearer {issue_token('owner', owner_id, 'owner@example.invalid')}"}`.
- `run-weekly-invoicing` reads `request.state.subject` directly and accepts `service` **or** `owner`; a partner JWT must get 401.

- [ ] **Step 1: The route inventory, as a test**

Start the file with the list, and assert it is complete — so the next endpoint someone adds shows up as a failure here rather than as a gap nobody sees:

```python
QB_ROUTES = (
    ("GET",  "/quickbooks/oauth/start"),
    ("GET",  "/quickbooks/status"),
    ("GET",  "/quickbooks/oauth/callback"),
    ("POST", "/quickbooks/partners/{partner_id}/sync-customer"),
    ("POST", "/quickbooks/run-weekly-invoicing"),
    ("GET",  "/quickbooks/pending-invoices"),
    ("POST", "/quickbooks/pending-invoices/{pi_id}/remove-line"),
    ("POST", "/quickbooks/pending-invoices/{pi_id}/discard"),
    ("POST", "/quickbooks/pending-invoices/{pi_id}/email-for-review"),
    ("POST", "/quickbooks/pending-invoices/{pi_id}/send"),
    ("POST", "/quickbooks/pending-invoices/{pi_id}/void-draft"),
    ("POST", "/quickbooks/pending-invoices/{pi_id}/void-and-credit"),
)


def test_every_quickbooks_route_is_listed():
    """If this fails, someone added an endpoint. Add it to QB_ROUTES and test it."""
    import main
    live = {
        (m, r.path)
        for r in main.app.routes
        for m in getattr(r, "methods", ())
        if getattr(r, "path", "").startswith("/quickbooks")
        and m not in ("HEAD", "OPTIONS")
    }
    assert live == set(QB_ROUTES)
```

- [ ] **Step 2: One auth test per route, as a table**

```python
@pytest.mark.parametrize("method,path", QB_ROUTES)
async def test_no_credentials_is_rejected(app_client, method, path):
    url = path.format(partner_id=uuid.uuid4(), pi_id=uuid.uuid4())
    r = await app_client.request(method, url, json={})
    # /oauth/callback is Intuit's redirect target and is on the public list; it
    # must still refuse a forged state rather than 200.
    assert r.status_code in (400, 401, 403), f"{method} {path} → {r.status_code}"
```
and the one that matters most:
```python
async def test_owner_cannot_touch_another_owners_invoice(
    app_client, seed_partner, dbx, db_conn
):
    """The cross-tenant proof for the billing path. 404, not 403: telling a
    stranger that an invoice exists is itself a leak."""
    other_partner = await seed_partner(company_name="Someone Else Towing")
    pi_id = await _seed_pending_invoice(db_conn, other_partner)
    headers = {"Authorization": f"Bearer {issue_token('owner', uuid.uuid4(), 'a@example.invalid')}"}
    for action in ("remove-line", "discard", "email-for-review", "send",
                   "void-draft", "void-and-credit"):
        r = await app_client.post(
            f"/quickbooks/pending-invoices/{pi_id}/{action}",
            json={"violation_id": str(uuid.uuid4())}, headers=headers,
        )
        assert r.status_code == 404, f"{action} → {r.status_code}"
```

- [ ] **Step 3: The behaviour tests, one per endpoint**

Write these; each name states the fact it protects.

| Endpoint | Tests |
|---|---|
| `GET /oauth/start` | returns an Intuit URL carrying `client_id`, `redirect_uri` and a `state`; a non-admin gets 403 |
| `GET /status` | reports `connected: false` with no integration row; `connected: true` plus `realm_id` with one; **never** returns a token, encrypted or otherwise |
| `GET /oauth/callback` | a forged `state` is rejected without writing an `integrations` row; a valid one POSTs to `oauth2/v1/tokens/bearer` (assert via `qb_http`) and stores **ciphertext** — assert the stored column does not contain the plaintext token |
| `POST /partners/{id}/sync-customer` | creates a QB customer and stores `quickbooks_customer_id`; a second call is idempotent and does not create a second customer (`qb_http.assert_called("POST", "/customer", times=1)`) |
| `POST /run-weekly-invoicing` | (a) drafts one `pending_invoices` row per eligible partner with the right `total_cents`; (b) skips a partner with no `quickbooks_customer_id`; (c) `skipped_exists` on a second run in the same week — the `partner_id, week_start` unique constraint is the safety net and the test should prove the code does not rely on catching its 23505; (d) excludes a violation inside the 48-hour grace window; (e) excludes one already `invoiced_at`; (f) **an owner caller sees only their own properties' partners** — seed two owners and assert the scope; (g) a partner JWT gets 401 |
| `GET /pending-invoices` | an owner sees only theirs; a service key sees all; the response carries `partner_company_name` from the join |
| `remove-line` | drops the named violation from `line_items` and lowers `total_cents` by exactly that line; refuses (409/400) once status has left `pending_review` |
| `discard` | marks voided without calling QuickBooks at all — `qb_http.assert_not_called("POST", "/invoice")` |
| `email-for-review` | builds the PDF, sends one email, stamps `emailed_at`; an `EmailDeliveryError` leaves `emailed_at` **null** (the failure must not look like a success) |
| `send` | creates the QB invoice, stamps `sent_at`/`sent_by`/`quickbooks_invoice_id`, and marks the underlying violations `invoiced_at`; a QB 400 leaves every one of those unset |
| `void-draft` | deletes the QB draft and marks voided; a QB 404 (already gone) still marks voided locally — the ledger and the draft must not be able to disagree forever |
| `void-and-credit` | issues a credit memo for the invoice total and records it; refuses on an invoice that was never sent |

Two rules for writing them:
- **Assert on the database, not only the response.** `dbx.get_pending_invoice(pi_id)` after every mutation. A 200 that wrote nothing is the failure mode these endpoints have.
- **Money is integers.** Every assertion on an amount is on `_cents`. If a test wants to write `350`, stop and check whether you have found DB-7 again.

- [ ] **Step 4: The failure paths, which is where the value is**

```python
async def test_expired_token_refreshes_before_the_call(
    app_client, seed_integration, seed_partner, qb_http
):
    await seed_integration(expires_at=datetime.now(timezone.utc) - timedelta(minutes=1))
    qb_http.route("POST", "oauth2/v1/tokens/bearer",
                  json={"access_token": "at-2", "refresh_token": "rt-2", "expires_in": 3600})
    qb_http.route("POST", "/customer", json={"Customer": {"Id": "77"}})
    pid = await seed_partner(quickbooks_customer_id=None)
    r = await app_client.post(f"/quickbooks/partners/{pid}/sync-customer",
                              headers=service_headers())
    assert r.status_code == 200, r.text
    qb_http.assert_called("POST", "oauth2/v1/tokens/bearer", times=1)


async def test_quickbooks_5xx_does_not_half_write(
    app_client, seed_integration, qb_http, db_conn, seed_partner
):
    """A failed send must leave the invoice sendable, not stranded in a state
    where the violations are marked invoiced and no invoice exists."""
    await seed_integration()
    partner = await seed_partner()
    pi_id, viol_id = await _seed_pending_invoice_with_line(db_conn, partner)
    qb_http.route("POST", "/invoice", status=503, json={"Fault": {}})
    r = await app_client.post(f"/quickbooks/pending-invoices/{pi_id}/send",
                              headers=service_headers())
    assert r.status_code >= 400
    pi = await dbx.get_pending_invoice(pi_id)
    assert pi["status"] == "pending_review" and pi["sent_at"] is None
    assert (await dbx.get_violation(viol_id))["invoiced_at"] is None
```

**If a failure-path test goes red because the endpoint really does half-write, that is a finding, not a test bug.** Write the test to assert the *correct* behaviour, mark it `xfail(strict=True)` with a one-line reason and the endpoint name, and report it. Do not fix a money-path bug inside a test-writing task.

- [ ] **Step 5: Verify, and prove each test can fail**

```bash
pytest tests/plaza/test_quickbooks_endpoints.py -q          # expect ~30 passed
pytest tests/plaza -q && ruff check . && python -m compileall -q -f .
```
Deliberate-break sweep: comment out the `_load_scoped_pending_invoice` scope check in `routers/quickbooks.py` — `test_owner_cannot_touch_another_owners_invoice` must go red. Comment out the `existing` check in `run_weekly_invoicing` — the `skipped_exists` test must go red. Revert both. Record in the commit body which two you broke.

**Commit:** `test(quickbooks): endpoint coverage for all 12 invoicing routes`

---

### Task 12: The reservation app — 10 endpoints, 10 tested

**Findings:** DEL-6, BACKEND-11. **Repo:** `getlotlogic/lotlogic-backend`. **Depends on:** Tasks 9 and 10.

`routers/app_api.py` is 681 lines over 10 endpoints with **zero** endpoint tests. It writes real `visitor_passes` rows — the same rows the $15 QR checkout creates. With Stripe unconfigured it runs in "mock-pay" mode and confirms a booking for $0. Wave 1 item 13 turned its flag off at the plaza; fat decision 9 asks whether to ship it or park it. **Tests are what make either answer cheap** — see decision **D8**.

**Files:**
- Create: `tests/plaza/test_app_api_endpoints.py`

- [ ] **Step 1: The route inventory, same pattern as Task 11**

```python
APP_ROUTES = (
    ("POST", "/app/auth/request-code"),
    ("POST", "/app/auth/verify-code"),
    ("GET",  "/app/lots"),
    ("GET",  "/app/lots/{lot_id}"),
    ("GET",  "/app/lots/{lot_id}/spots"),
    ("POST", "/app/bookings/quote"),
    ("POST", "/app/bookings"),
    ("POST", "/app/stripe/webhook"),
    ("GET",  "/app/bookings/mine"),
    ("POST", "/app/bookings/{booking_id}/cancel"),
)
```
plus the same `test_every_app_route_is_listed` shape.

- [ ] **Step 2: The flag is the first test**

```python
async def test_a_property_with_app_enabled_false_is_invisible(app_client, db_conn):
    """Wave 1 item 13 turned this flag off at the plaza because mock-pay mode
    writes a real, free parking pass. Every read path filters on it; this test
    is what keeps that true."""
    await db_conn.execute(text(
        "UPDATE public.properties SET app_enabled = false WHERE id = :p"
    ), {"p": str(PLAZA_PROPERTY_ID)})
    await db_conn.commit()

    assert (await app_client.get("/app/lots")).json() == []
    assert (await app_client.get(f"/app/lots/{PLAZA_PROPERTY_ID}")).status_code == 404
    assert (await app_client.get(f"/app/lots/{PLAZA_PROPERTY_ID}/spots")).status_code == 404
    r = await app_client.post("/app/bookings/quote", json={
        "lot_id": str(PLAZA_PROPERTY_ID), "duration_kind": "h24",
        "starts_at": _iso(hours=1),
    })
    assert r.status_code == 404
```
Every other test in the file needs `app_enabled = true`, so put that in a module fixture and make **this** test the one that flips it off.

- [ ] **Step 3: OTP login — the DB-backed guard, end to end**

- `request-code` writes one `app_otp_codes` row per phone, stores a **hash** (assert the stored value is not the code), and returns 429 on a second request inside the window.
- `verify-code` with the wrong code increments `attempts` and returns 401; the sixth attempt returns 429 (`OTP_MAX_ATTEMPTS = 5`) even with the *right* code; an expired row returns 401; success returns a JWT whose `aud` is `APP_JWT_AUDIENCE`.
- A token minted for one phone cannot read another phone's `bookings/mine`. That is this router's cross-tenant proof and it is the reason to write these at all.
- The SMS send itself is faked: `monkeypatch.setattr(app_api, "send_sms", …)` — Twilio returns 401 in production and is not the subject here. Assert the code was *offered* to the sender, and assert it never appears in the HTTP response.

- [ ] **Step 4: Booking — both payment modes, explicitly**

```python
async def test_mock_pay_mode_confirms_a_free_booking_and_writes_a_real_pass(
    app_client, app_phone_token, dbx, monkeypatch
):
    """This is the Wave 1 item 13 hole, pinned down. With Stripe unconfigured
    the booking is confirmed at $0 and a REAL visitor_passes row appears — the
    same row the $15 checkout creates. The behaviour is documented and
    deliberate ('build/demo mode'); the test exists so that it can never become
    true by accident once Stripe IS configured."""
    monkeypatch.setattr(get_settings(), "stripe_secret_key", "", raising=False)
    r = await app_client.post("/app/bookings", json=_booking_body(), headers=app_phone_token)
    assert r.status_code == 200, r.text
    b = await dbx.get_booking(r.json()["booking_id"])
    assert b["payment_status"] == "mock" and b["status"] == "confirmed"
    assert b["pass_id"] is not None
    assert await dbx.count_passes(id=b["pass_id"], status="active") == 1


async def test_stripe_mode_leaves_the_booking_pending_until_the_webhook(
    app_client, app_phone_token, dbx, stripe_http
):
    stripe_http.route("POST", "/v1/payment_intents",
                      json={"id": "pi_1", "client_secret": "cs_1", "status": "requires_payment_method"})
    r = await app_client.post("/app/bookings", json=_booking_body(), headers=app_phone_token)
    assert r.json()["client_secret"] == "cs_1"
    b = await dbx.get_booking(r.json()["booking_id"])
    assert b["status"] == "pending" and b["payment_status"] == "pending"
    assert b["pass_id"] is None          # no pass until the money lands
    stripe_http.assert_called("POST", "/v1/payment_intents", times=1)
```

Also: `bookings/quote` prices weekday/weekend off the **local** day (the existing unit tests cover the arithmetic — here, prove the endpoint reads `properties.app_rates` and 404s when it is null); `idempotency_key` makes a repeated POST return the same booking rather than a second one; a booking whose plate is under a `plate_holds` row is refused by the trigger and surfaces as a 4xx, not a 500.

- [ ] **Step 5: The Stripe webhook**

- An unsigned or wrongly-signed body is rejected **before** any database write. Sign the good one with the SDK's own helper against a test `stripe_webhook_secret` so the real `construct_event` runs.
- `payment_intent.succeeded` flips the booking to paid/confirmed and creates the pass.
- The **same event delivered twice** creates exactly one pass. Stripe retries; this is the test that matters.
- An event for an unknown `payment_intent` is a 200 with no write (Stripe retries a non-2xx forever).
- With `stripe_webhook_secret` unset the endpoint refuses rather than trusting the body.

- [ ] **Step 6: `bookings/mine` and `cancel`**

- `mine` returns only the caller's phone's bookings, newest first.
- `cancel` sets `status='cancelled'`, `cancelled_by='app_user'`, and cancels the linked pass; cancelling someone else's booking is a 404; cancelling twice is idempotent.

- [ ] **Step 7: Verify and prove failure**

```bash
pytest tests/plaza/test_app_api_endpoints.py -q     # expect ~28 passed
pytest tests/plaza -q && ruff check .
```
Deliberate breaks: remove the `AND app_enabled = true` from the `/app/lots` query — the flag test must go red. Remove the `idempotency_key` unique lookup — the double-POST test must go red. Deliver the webhook event twice with the de-dup removed — the "exactly one pass" test must go red. Revert all three.

**Commit:** `test(app): endpoint coverage for all 10 reservation-app routes`

---

### Task 13: A truth table for the most-rewritten logic in the system

**Finding:** DB-9. **Repo:** `getlotlogic/lotlogic-backend`. **Depends on:** Task 9.

`set_pass_cooldown_flag` has been rewritten **seven** times across `migrations/`; `enforce_truck_plaza_cooldown` five; `count_on_cooldown` was changed to use the flag and reverted to a time window inside 32 hours on 2026-06-16. This is the single most-churned piece of business logic in the product, it runs as a `BEFORE INSERT` trigger inside the caller's transaction on every registration, and **no test asserts what it does**. The pay-to-park suite exercises it incidentally — it is in `live_schema.sql` and fires on every seeded pass — but nothing states the rule.

**Files:**
- Create: `tests/plaza/test_cooldown_trigger.py`

- [ ] **Step 1: Read the rule out of the current function, not out of the migrations**

```sql
SELECT pg_get_functiondef('public.set_pass_cooldown_flag'::regproc);
SELECT pg_get_functiondef('public.enforce_truck_plaza_cooldown'::regproc);
SELECT pg_get_functiondef('public.cooldown_match_key'::regproc);
```
against the **harness** database (which has replayed the migrations) and against **production** (`mcp__supabase__execute_sql`). **If the two differ, stop and report it** — that is drift between the schema extract and live, and it is a bigger finding than the missing test.

Write the rule down in the module docstring in English, with the migration that last changed it and the date. That docstring is the first written statement of this rule in the repo's history; treat it as the deliverable.

- [ ] **Step 2: The table**

One `pytest.mark.parametrize` over the dimensions the function actually reads — plate match key, property, the cooldown window, whether the prior pass exited, whether it was cancelled, and the `cooldown_flagged_at` stamp:

```python
@pytest.mark.parametrize(
    "prior_state,gap_hours,expect_flagged",
    [
        # The rule the flag exists for: a truck leaves and re-registers to
        # restart its stay clock. 20260703194500_cooldown_anchor_on_real_exit
        # anchors the window on the REAL exit, not on valid_until.
        ("exited",            1,  True),
        ("exited",           99,  False),
        # Never arrived, never exited: nothing to cool down from.
        ("no_show",           1,  False),
        # Operator cancelled the prior pass — not a re-registration.
        ("cancelled",         1,  False),
        # Still on the lot. This is an overlap, which is a different rule
        # (the re-registration tow alert, 2026-08-27), not a cooldown.
        ("active_unexited",   1,  False),
    ],
)
async def test_cooldown_flag_truth_table(
    db_conn, seed_truck_plaza, prior_state, gap_hours, expect_flagged
):
    ...
```

Then the cases that are not a simple grid, each as its own named test:
- **Plate equality is the match key, not the string.** `cooldown_match_key` normalises. Prove `AB-1234`, `ab1234` and `AB 1234` are one vehicle, and that a USDOT-synthesised plate (`DOT-1234567`) matches its own prior pass and not a look-alike licence plate.
- **Scope is per property.** The same plate at two properties does not flag.
- **`enforce_truck_plaza_cooldown` RAISEs inside the caller's transaction.** Assert the caller sees the error and that **no partial row survives** — this is the behaviour the whole real-Postgres harness exists for and a mock cannot reproduce it.
- **An apartment property is exempt.** The trigger is truck-plaza-only; a regression here would start flagging apartment passes.
- **`count_on_cooldown` agrees with the flag.** The 2026-06-16 flip-and-revert is the evidence that these two can disagree. Assert they do not.

- [ ] **Step 3: Verify and prove failure**

```bash
pytest tests/plaza/test_cooldown_trigger.py -q     # expect ~14 passed
```
Deliberate break: in the harness only, `CREATE OR REPLACE` the function with the window hardcoded to zero hours, re-run, expect the `("exited", 1, True)` row to fail; then restore by re-running the harness setup. **Do not run any part of this against production.**

**Commit:** `test(db): a truth table for the cooldown flag and its trigger`

---

### Task 14: Database hygiene — a cancel reason, index/FK debt, and a flag that stays off

**Findings:** DB-8, DB-10, REL-8 (the `app_enabled` half). **Repo:** `getlotlogic/lotlogic-backend`. **Depends on:** Task 9.

Three small, additive migrations. None drops a column; none rewrites a row's meaning.

**Files:**
- Create: `migrations/20260914HHMMSS_cancel_reason.sql`
- Create: `migrations/20260914HHMMSS_hot_table_index_hygiene.sql`
- Create: `migrations/20260914HHMMSS_app_enabled_off_at_plaza.sql`
- Modify: `routers/visitor_passes.py` (write the new column; keep reading the old one)
- Create: `tests/plaza/test_cancel_reason.py`

- [ ] **Step 1: DB-8 — `cancelled_by` is a code, `cancel_reason` is prose**

`visitor_passes.cancelled_by` is free text carrying at least six distinct meanings (`camera_exit`, `exited_early`, `superseded_by_reregistration`, `app_user`, an admin identity string) **and** an operator's free-text reason appended as a suffix (`routers/visitor_passes.py:89`). `routers/visitor_passes.py:276` branches on `cancelled_by.startswith("camera_exit")` — a prefix match against a column an operator can type into.

Additive fix:

```sql
-- DB-8. `cancelled_by` carries two things at once: WHO/WHAT cancelled the pass
-- (a code that code branches on) and, appended as a suffix, an operator's
-- free-text reason. routers/visitor_passes.py:276 decides tow-relevant display
-- with `cancelled_by.startswith('camera_exit')` — a prefix match against a
-- field a human types into.
--
-- Additive and reversible: the column stays, every existing value stays
-- readable, and the CHECK is NOT VALID so no historical row can block the
-- migration. New writes put prose in cancel_reason.
ALTER TABLE public.visitor_passes
  ADD COLUMN IF NOT EXISTS cancel_reason text;

COMMENT ON COLUMN public.visitor_passes.cancelled_by IS
  'WHO/WHAT cancelled: a code, not prose. Code branches on it. Free-text goes in cancel_reason.';
COMMENT ON COLUMN public.visitor_passes.cancel_reason IS
  'Operator free text. Display only — never branch on it.';

-- NOT VALID: constrains new rows, leaves the historical mess alone. Validating
-- it is a follow-up once the backfill is agreed (Wave 3.6 owns the pass tables).
ALTER TABLE public.visitor_passes
  ADD CONSTRAINT visitor_passes_cancelled_by_known
  CHECK (
    cancelled_by IS NULL
    OR cancelled_by IN (
      'camera_exit', 'exited_early', 'superseded_by_reregistration',
      'app_user', 'operator', 'admin', 'system'
    )
  ) NOT VALID;
```

**Before writing that list, measure it.** `SELECT split_part(cancelled_by,':',1) AS code, count(*) FROM visitor_passes WHERE cancelled_by IS NOT NULL GROUP BY 1 ORDER BY 2 DESC;` against production. The list above is a guess from grep; the query is the truth. If a code in production is missing from the CHECK, the constraint will reject a legitimate new write on the day someone hits that path.

Then in `routers/visitor_passes.py`: the cancel endpoint writes `cancelled_by = :who` (a code) and `cancel_reason = :reason` instead of concatenating. **Keep the read path reading `cancelled_by` with its prefix match** — old rows still have suffixes, and this plan is backward compatible. Add a comment saying when the prefix match can go (after the backfill, Wave 3.6).

- [ ] **Step 2: DB-10 — index and FK hygiene on the two hottest write tables**

`plate_events` and `visitor_passes` carry 13 and 19 indexes respectively in the live extract. Every one of them is write amplification on the hottest path in the product — a single site produces 150–1,000 plate reads a day.

Measure first, on **production**, and put the output in the migration's header comment:

```sql
-- Never used since the last stats reset:
SELECT relname, indexrelname, idx_scan, pg_size_pretty(pg_relation_size(indexrelid))
  FROM pg_stat_user_indexes
 WHERE relname IN ('plate_events','visitor_passes')
 ORDER BY idx_scan, pg_relation_size(indexrelid) DESC;

-- Exact or prefix duplicates:
SELECT indexrelid::regclass, indrelid::regclass, indkey, indpred IS NOT NULL AS partial
  FROM pg_index WHERE indrelid IN ('plate_events'::regclass,'visitor_passes'::regclass);

-- FKs with no supporting index (every DELETE on the parent seq-scans the child):
SELECT c.conname, c.conrelid::regclass
  FROM pg_constraint c
 WHERE c.contype='f' AND c.conrelid IN ('plate_events'::regclass,'visitor_passes'::regclass)
   AND NOT EXISTS (SELECT 1 FROM pg_index i
                    WHERE i.indrelid=c.conrelid AND (i.indkey::int2[])[0:array_length(c.conkey,1)-1] = c.conkey);
```

Rules for what goes in the migration:
- **`DROP INDEX CONCURRENTLY` only**, one statement per index, each with the `idx_scan` count that justified it in a comment above it.
- **Drop nothing with `idx_scan > 0`**, and nothing younger than 30 days — `idx_scan` since the last stats reset is not the same as "never used", and the August wedge indexes are three weeks old.
- **Never drop an index backing a unique or exclusion constraint**, and never one named in `ON CONFLICT`. `grep -rn "ON CONFLICT" routers/ services/ ../lotlogic/supabase/functions/` before you drop anything.
- **Add** a `CREATE INDEX CONCURRENTLY` for each unindexed FK the third query returns.
- `CONCURRENTLY` cannot run inside a transaction block. Note that in the header; the Supabase MCP `apply_migration` wraps statements — if it does, this migration is applied statement-by-statement by hand and recorded in `schema_migrations` explicitly. **Say so in the file.**

If the queries come back showing nothing safe to drop, **write the migration as a comment-only file recording the measurement and drop nothing.** A measured "no debt here" is a real result; a speculative `DROP INDEX` on the hottest table in a live enforcement system is not.

- [ ] **Step 3: REL-8 half — the plaza flag, as a migration**

Wave 1 item 13 turned `app_enabled` off at Charlotte with a manual `UPDATE`. There is no file. `migrations/20260728120000_app_bookings_and_rates.sql` ends by setting it **on** for that exact property id — so a migration replay re-opens the free-parking path.

```sql
-- Wave 1 item 13 / programme fat decision 9. `app_enabled = true` at the plaza
-- means routers/app_api.py's mock-pay branch confirms a $0 booking and writes a
-- REAL active parking pass on a paid lot. It was switched off by hand on
-- 2026-09-xx; migrations/20260728120000_app_bookings_and_rates.sql ends by
-- switching it ON, so a replay silently re-opens it.
--
-- Idempotent and instantly reversible (`UPDATE … SET app_enabled = true`).
-- Turning it back on is fat decision 9, not a code change.
UPDATE public.properties
   SET app_enabled = false
 WHERE id = 'bd44ace8-feda-42e1-9866-5d60f65e1712'
   AND app_enabled IS DISTINCT FROM false;
```

Task 12's tests set the flag themselves, so they are unaffected by the replay order.

- [ ] **Step 4: Verify**

```bash
pytest tests/plaza -q          # the migrations are replayed by the harness
ruff check . && python -m compileall -q -f .
```
`tests/plaza/test_migrations.py` already asserts the migration set applies cleanly; confirm it picked up the new `20260914*` glob (Task 9). Then `tests/plaza/test_cancel_reason.py`:
- a cancel writes a bare code to `cancelled_by` and the prose to `cancel_reason`;
- an unknown code is rejected by the CHECK on a **new** row;
- a pre-existing row with a suffixed `cancelled_by` still reads correctly through `routers/visitor_passes.py` (insert one directly to simulate history — the CHECK is `NOT VALID`, so it is allowed);
- `camera_exit` still drives the tow-relevant display.

**Prove it can fail:** drop the `NOT VALID` so the constraint validates — the historical-row test must fail. Revert.

- [ ] **Step 5: Apply to production deliberately**

These are applied via the Supabase MCP `apply_migration` (or the CLI), never the SQL editor, so each lands in `supabase_migrations.schema_migrations`. **Apply the `app_enabled` one first** — it is the one that closes a hole. `CONCURRENTLY` statements go last and are watched.

**Commit:** `fix(db): cancel_reason, measured index hygiene, and app_enabled as a migration`

---

### Task 15: An idle dashboard tab stops hammering the database

**Finding:** FE-8. **Repo:** `getlotlogic/lotlogic`. **Depends on:** nothing.

Eleven `setInterval` sites in `frontend/src/`. One file gates on `visibilitychange`. A dashboard left open on a back office monitor polls the roster every 60 s, snapshots every 10 s and the proof modal every 10 s forever, and the load grows with the number of properties an owner has. The database has seized twice.

**Files:**
- Create: `frontend/src/lib/visiblePoll.js`, `frontend/src/lib/visiblePoll.test.mjs`
- Modify: `frontend/src/hooks.js`
- Modify: `frontend/src/App.jsx`, `src/ui/ProofModal.jsx`, `src/pages/{TrainingPage,TowActivityPage,HqPage,ALPRPropertiesPage}.jsx`
- Modify: `frontend/package.json` (test glob)

**Interfaces:**
- `startVisiblePoll({ fn, ms, doc, onError }) -> stop()` — pure, injectable `doc`, no React. This is what the node test covers.
- `useVisiblePolling(fn, ms, deps)` — the React binding in `hooks.js`.

- [ ] **Step 1: The pure core**

`frontend/src/lib/visiblePoll.js`:

```js
// Poll only while the tab is visible, and refresh once the moment it becomes
// visible again — so a user coming back to the tab sees fresh data immediately
// rather than after a full interval.
//
// Pure and injectable so it can be tested under `node --test` with a fake
// document. The React binding is useVisiblePolling in ../hooks.js.
export function startVisiblePoll({ fn, ms, doc = globalThis.document, onError }) {
  if (!(ms > 0) || typeof fn !== 'function') return () => {};
  let timer = null;
  let stopped = false;

  const run = () => {
    if (stopped) return;
    try {
      const out = fn();
      if (out && typeof out.catch === 'function') out.catch(e => onError && onError(e));
    } catch (e) { if (onError) onError(e); }
  };
  const start = () => { if (timer == null && !stopped) timer = setInterval(run, ms); };
  const stop  = () => { if (timer != null) { clearInterval(timer); timer = null; } };
  const onVisibility = () => {
    if (stopped) return;
    if (doc.hidden) stop();
    else { run(); start(); }          // catch up, then resume
  };

  if (!doc.hidden) start();
  doc.addEventListener('visibilitychange', onVisibility);

  return () => {
    stopped = true;
    stop();
    doc.removeEventListener('visibilitychange', onVisibility);
  };
}
```

Note what it deliberately does **not** do: it does not fire `fn` on mount. Several call sites already load once themselves and a second immediate call would double every page's initial request. Mount-time loading stays the caller's job.

- [ ] **Step 2: The node test**

`frontend/src/lib/visiblePoll.test.mjs` — a fake `doc` with a `hidden` flag and a listener list, plus fake timers via `node:test`'s `t.mock.timers`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startVisiblePoll } from './visiblePoll.js';

function fakeDoc() {
  const ls = new Set();
  return {
    hidden: false,
    addEventListener: (_e, f) => ls.add(f),
    removeEventListener: (_e, f) => ls.delete(f),
    _fire() { for (const f of ls) f(); },
    get _listeners() { return ls.size; },
  };
}

test('polls while visible', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const doc = fakeDoc(); let n = 0;
  const stop = startVisiblePoll({ fn: () => n++, ms: 1000, doc });
  t.mock.timers.tick(3000);
  assert.equal(n, 3);
  stop();
});

test('stops while hidden and catches up on return', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const doc = fakeDoc(); let n = 0;
  const stop = startVisiblePoll({ fn: () => n++, ms: 1000, doc });
  doc.hidden = true; doc._fire();
  t.mock.timers.tick(10000);
  assert.equal(n, 0, 'a hidden tab must not poll at all');
  doc.hidden = false; doc._fire();
  assert.equal(n, 1, 'becoming visible refreshes immediately');
  t.mock.timers.tick(2000);
  assert.equal(n, 3);
  stop();
});

test('does not start while already hidden', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const doc = fakeDoc(); doc.hidden = true; let n = 0;
  const stop = startVisiblePoll({ fn: () => n++, ms: 1000, doc });
  t.mock.timers.tick(5000);
  assert.equal(n, 0);
  stop();
});

test('stop() removes the listener and the timer', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const doc = fakeDoc(); let n = 0;
  const stop = startVisiblePoll({ fn: () => n++, ms: 1000, doc });
  stop();
  assert.equal(doc._listeners, 0);
  t.mock.timers.tick(5000);
  assert.equal(n, 0);
});

test('a throwing fn does not kill the loop', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const doc = fakeDoc(); const errs = []; let n = 0;
  const stop = startVisiblePoll({
    fn: () => { n++; if (n === 1) throw new Error('boom'); },
    ms: 1000, doc, onError: e => errs.push(e),
  });
  t.mock.timers.tick(3000);
  assert.equal(n, 3);
  assert.equal(errs.length, 1);
  stop();
});
```

`package.json`: `"test": "node --test scripts/*.test.mjs src/lib/*.test.mjs"`.

- [ ] **Step 3: The React binding, and the conversions**

```js
import { startVisiblePoll } from './lib/visiblePoll.js';

// FE-8. A dashboard left open on an office monitor used to poll forever. Every
// recurring fetch in this app goes through here.
export function useVisiblePolling(fn, ms, deps = []) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(
    () => startVisiblePoll({ fn: () => fnRef.current(), ms }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ms, ...deps],
  );
}
```

Then convert, in this order and re-checking the UI after each:

| Site | Interval | Note |
|---|---|---|
| `hooks.js:69` `useActiveRoster` | 60 s | It also holds a Supabase realtime channel. **Leave the channel alone** — a realtime subscription is push, costs nothing while idle, and is what makes the roster feel live. Only the interval is gated. |
| `hooks.js:90` `useIntervalFetch` | caller's | Route its body through `startVisiblePoll`; every caller inherits the fix. |
| `hooks.js:108` `useNowTick` | 30 s | **Do not convert.** It is a shared countdown ticker that touches no network. Gating it would freeze visible countdowns in a tab that was briefly backgrounded. Add a comment saying so. |
| `App.jsx:341` training badge | 60 s | |
| `App.jsx:355` | — | Read it first: if it is a UI timer rather than a fetch, treat it like `useNowTick`. |
| `App.jsx:433` `pollSnapshots` | 10 s | The heaviest one. |
| `ui/ProofModal.jsx:130` | 10 s | A modal, so also confirm it stops on close. |
| `pages/TrainingPage.jsx:88`, `TowActivityPage.jsx:329`, `HqPage.jsx:48`, `ALPRPropertiesPage.jsx:109` | 60 s | |
| `ALPRPropertyDetailPage.jsx:424/452/495` | — | Already hand-rolls `visibilitychange`. Convert to the shared hook and delete the three hand-rolled pairs — same behaviour, sixty fewer lines. |

- [ ] **Step 4: Verify**

```bash
cd frontend
npm ci && npm test && npm run build && npm run check:naming
# Every remaining raw setInterval should be a non-network UI timer. Justify each.
grep -rn "setInterval" src/ | grep -v "lib/visiblePoll.js"
```
Then by hand: open `/app`, DevTools → Network, switch to another tab for a minute, come back. Expect **zero** requests while hidden and one burst on return. Record the before/after request count over 60 idle seconds in the commit body — that number is the finding.

`tests/visual/` compares DOM captures; a polling change should move nothing there. If `npm run visual:check` moves, you changed rendering, not polling — look again.

**Commit:** `perf(dashboard): stop polling while the tab is hidden`

---

### Task 16: `.env.example` describes all 77 settings, and a test keeps it that way

**Finding:** BACKEND-20. **Repo:** `getlotlogic/lotlogic-backend`. **Depends on:** nothing.

`.env.example` documents 17 variables. `config.Settings` has 77 fields. Four of the seventeen configure the retired YOLO stack. A new deployment — or the rebuild-from-zero in `RECOVERY.md` §10 — starts from a file that is 78% incomplete and partly about software that does not run.

**Files:**
- Create: `scripts/gen_env_example.py`
- Regenerate: `.env.example`
- Create: `tests/test_env_example.py`

- [ ] **Step 1: The generator, modelled on `scripts/gen_requirements_lock.py`**

```python
#!/usr/bin/env python3
"""Regenerate .env.example from config.Settings.

The file drifted to 17 of 77 settings — and four of the seventeen configure the
retired YOLO stack. Generating it means it can only be wrong for as long as it
takes someone to run this, and tests/test_env_example.py fails the build until
they do.

Usage:  python scripts/gen_env_example.py           # write .env.example
        python scripts/gen_env_example.py --check   # exit 1 if it would change
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from config import Settings  # noqa: E402

HEADER = """\
# Every setting config.Settings reads, generated by scripts/gen_env_example.py.
# Re-run that script after adding a field; tests/test_env_example.py fails until
# you do. No real values here — see RECOVERY.md §5 for where each one lives.
#
# A line commented out has a usable default in config.py and only needs setting
# to override it. An uncommented line has no default and the app needs it.
"""

#: Never print a default that is, or looks like, a credential — even the
#: harmless-looking ones. A default that is a person's email or phone number is
#: the BACKEND-14 mistake.
SENSITIVE = ("key", "secret", "token", "password", "sid", "dsn", "url", "email", "phone")


def render() -> str:
    lines = [HEADER]
    for name, field in sorted(Settings.model_fields.items()):
        env = name.upper()
        desc = (field.description or "").strip()
        if desc:
            lines.append(f"# {desc}")
        required = field.is_required()
        default = field.get_default(call_default_factory=True)
        if required:
            lines.append(f"{env}=")
        elif any(s in name for s in SENSITIVE) and default:
            lines.append(f"# {env}=<redacted default — see config.py>")
        else:
            lines.append(f"# {env}={'' if default is None else default}")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


if __name__ == "__main__":
    out = Path(__file__).resolve().parents[1] / ".env.example"
    text = render()
    if "--check" in sys.argv:
        cur = out.read_text() if out.exists() else ""
        if cur != text:
            print("`.env.example` is stale — run: python scripts/gen_env_example.py", file=sys.stderr)
            sys.exit(1)
        print("ok")
    else:
        out.write_text(text)
        print(f"wrote {out} ({len(Settings.model_fields)} settings)")
```

- [ ] **Step 2: The drift gate**

`tests/test_env_example.py` — a plain unit test, no database, so it runs in the fast half of the suite:

```python
"""`.env.example` must name every setting. BACKEND-20."""
from pathlib import Path

from config import Settings

ENV_EXAMPLE = Path(__file__).resolve().parents[1] / ".env.example"


def _documented() -> set[str]:
    out = set()
    for line in ENV_EXAMPLE.read_text().splitlines():
        s = line.lstrip("# ").strip()
        if "=" in s and s.split("=", 1)[0].isupper():
            out.add(s.split("=", 1)[0])
    return out


def test_every_setting_is_documented():
    missing = sorted({n.upper() for n in Settings.model_fields} - _documented())
    assert not missing, (
        f"{len(missing)} settings missing from .env.example: {missing}\n"
        "Run: python scripts/gen_env_example.py"
    )


def test_no_setting_is_documented_that_does_not_exist():
    """The other direction. A variable in .env.example that config.py no longer
    reads is how the YOLO stack stayed 'configurable' for five months after it
    stopped running."""
    extra = sorted(_documented() - {n.upper() for n in Settings.model_fields})
    assert not extra, f"{extra} are in .env.example but config.Settings does not read them"


def test_no_real_looking_secret_in_the_example():
    """A default that is a real key, a real email or a real phone number is a
    secret in git. BACKEND-14 put a personal mobile in source once already."""
    import re
    text = ENV_EXAMPLE.read_text()
    for pat, why in (
        (r"\+1\d{10}", "a real-looking phone number"),
        (r"[A-Za-z0-9._%+-]+@(?!example\.)(?!yourdomain\.)[A-Za-z0-9.-]+\.[A-Za-z]{2,}", "a real-looking email"),
        (r"\bsk_live_\w+", "a live Stripe key"),
        (r"\bSG\.[A-Za-z0-9_-]{20,}", "a SendGrid key"),
        (r"\bAC[0-9a-f]{32}\b", "a real Twilio SID"),
    ):
        assert not re.search(pat, text), f".env.example contains {why}"
```

- [ ] **Step 3: Descriptions where they are missing**

The generator emits a comment only where a field has `description=`. Most of `config.py`'s 77 fields carry a `#` comment above them instead, which pydantic never sees. **Do not mass-rewrite `config.py`** — that is a large diff over a file every module imports. Instead: for the ~20 fields a fresh deployment genuinely cannot boot or operate without (`DATABASE_URL`, `API_KEY`, `ENCRYPTION_KEY`, `JWT_SECRET`, the R2 five, `RECAPTCHA_SECRET_KEY`, the QuickBooks four, `SENDGRID_API_KEY`, `SUPABASE_URL`, `DASHBOARD_URL`), add `Field(..., description="…")` and let the rest generate bare. Cross-check that set against `RECOVERY.md` §5's "required to boot" list — if the two disagree, one of them is wrong and finding that out is worth the task on its own.

- [ ] **Step 4: Wire the check into CI**

In `.github/workflows/ci.yml`, after the ruff step:
```yaml
      - name: .env.example is current
        run: python scripts/gen_env_example.py --check
```
(The pytest gate covers it too; the explicit step gives a one-line failure message instead of a test traceback.)

- [ ] **Step 5: Verify and prove failure**

```bash
python scripts/gen_env_example.py && git diff --stat .env.example
pytest tests/test_env_example.py -q          # expect 3 passed
python scripts/gen_env_example.py --check    # expect "ok"
```
Deliberate break: add `zzz_test_setting: str = "x"` to `Settings`, run `pytest tests/test_env_example.py` — expect `test_every_setting_is_documented` to fail naming `ZZZ_TEST_SETTING`. Remove it.

Then read the generated file once, top to bottom. **If a setting's name does not tell you what it is for, that is the real finding** — add its `description` now, while you are the person who just looked it up.

**Commit:** `chore(config): generate .env.example from Settings, and gate it`

---

## Done means

- `deno check` and `deno test` are green for all 16 edge functions, and a red one blocks the deploy.
- A push to `main` in the frontend repo deploys exactly the edge functions whose sources changed — including the ones reached through a shared file — and nothing else.
- `git tag --list 'backend-*'` and `'frontend-*'` both return something, and each tag's annotation names the one before it.
- `RECOVERY.md` §12 has three procedures a stranger can follow, and one of them has been rehearsed.
- `pytest tests/plaza/test_quickbooks_endpoints.py tests/plaza/test_app_api_endpoints.py -q` covers 22 endpoints against real Postgres with QuickBooks and Stripe faked at the socket.
- Every new test file has one recorded deliberate break in its commit body.
- `gitleaks detect --no-git` is clean on both repos and runs on every PR.
- Both `CLAUDE.md` files are true when read top to bottom.
- Backend CI is green, frontend `build` / `check:naming` / `test` are green, and `e2e (local dist)` is green.

## Deliberately not in this wave

`BACKEND-16` (split the large routers) and `BACKEND-18` (global rate limiting) — see Scope calls 2 and 3, and decisions D9 and D10. Square's client stays at the function boundary (Scope call 4 / D6). Schema baseline, the migration runner and the CI drift check are Wave 2.4. Route-guard-by-default is Wave 2.2. A staging environment is Wave 3.3.

---

## Decisions for Gabe

Eleven. Each is one yes/no. The default is what happens if you say nothing — every default is the lower-risk option, and none of them needs a new account, a new secret or a new bill.

**D1 — Where the edge-function workflow deploys, and what it uses to get in.**
The new `Edge functions` workflow (frontend repo, `.github/workflows/edge-functions.yml`) deploys all 16 functions straight to the production Supabase project `nzdkoouoaedbbccraoti`, using the `SUPABASE_ACCESS_TOKEN` GitHub Actions secret that already exists and already deploys `camera-snapshot` today. There is no second Supabase project to deploy to, and this adds no new secret.
❓ **Deploy to the production Supabase project with the existing `SUPABASE_ACCESS_TOKEN`?** → *Recommended: **yes**.*

**D2 — Whether a type error can still reach production.**
The workflow type-checks and tests every function before it deploys any of them. Configured as a hard gate: one red function blocks the whole deploy, including the other fifteen.
❓ **Should a failing check block the deploy outright, rather than warn and ship?** → *Recommended: **yes**. The alternative is the state you are in now.*

**D3 — `walk-around-ocr`.**
It is the in-app walk-around plate OCR (operator photographs a truck, gets the plate back). 210 lines, 25 type errors, no `deno.json`. Task 1 spends most of its effort here. It is genuinely authenticated — it verifies the backend's own JWT — so it is not a security item.
❓ **Keep `walk-around-ocr` and fix it, rather than delete it?** → *Recommended: **yes** — it is a live operator feature, and 25 mechanical annotations is an hour.*

**D4 — Whether CI gets a token that can redeploy production.**
Deploy tagging (`deploy-tag.yml`, both repos) writes a git tag and a GitHub release on every push to `main`, using the automatic `GITHUB_TOKEN`. It does **not** call Railway or Vercel. The actual rollback is done in each provider's own UI, pointed at the commit the tag names. Adding `RAILWAY_API_TOKEN` / `VERCEL_TOKEN` would let the workflow also record the provider's deployment id — nicer, but it puts a production-redeploy credential into a third system.
❓ **Tag-only, no Railway or Vercel API token in GitHub Actions?** → *Recommended: **yes**.*

**D5 — The camera MACs that are already in git.**
A camera's MAC is its `alpr_cameras.api_key` — the credential the ingest path matches frames against — and both plaza cameras' MACs are committed in seven files across both repos, one of them in a public repo. Task 4 removes them from the working tree. It does **not** rotate the keys in the database (that means reconfiguring two solar cameras over ZeroTier) and does **not** rewrite git history (that means a force-push invalidating every clone).
❓ **De-commit only for now — leave the two camera keys unrotated and the history intact?** → *Recommended: **yes**, and book the rotation for the next time someone is physically at the plaza.*

**D6 — Square.**
The brief asks for Square, Stripe and QuickBooks faked at the HTTP boundary. `services/square.py` is on the never-edit list (the Stripe cutover owns it) and its ~40 existing tests are green faking at the function boundary. Injecting an HTTP transport means editing a frozen file to add a test hook, for a path that is already covered.
❓ **Leave `services/square.py` alone and fake only QuickBooks and Stripe at the HTTP boundary?** → *Recommended: **yes**.*

**D7 — How hard gitleaks bites on day one.**
The new secret scan (both repos) blocks on a finding in the **working tree** from the first run — after Task 4 the tree is clean, so it can only go red on something new. Scanning **git history** stays advisory, because history still holds the camera keys Task 4 removed and cleaning that is D5.
❓ **Block on the working tree, advisory on history until D5 is settled?** → *Recommended: **yes**.*

**D8 — Testing the reservation app when its future is undecided.**
`routers/app_api.py` (the NMLD truck app) is 681 lines, 10 endpoints, zero endpoint tests, and its flag is off at the plaza. Fat decision 9 asks "ship it or park it" and is still open. Task 12 is roughly a day.
❓ **Write the 10 endpoint tests now, before deciding whether to ship the app?** → *Recommended: **yes** — the tests are most of what "ship it" costs, and if the answer is "park it" they are what makes deleting it safe.*

**D9 — Splitting the big backend files.**
BACKEND-16 ("the biggest files hold several products; 38 functions too long to review") is merged into 2.9 by the programme doc. It is a refactor, not a delivery gap; the frontend equivalent was Wave 2.6 and took nine days on its own. Moving code that has no tests, in the same wave that is writing its first tests, is the wrong order.
❓ **Defer BACKEND-16 to Wave 3, after 2.9's tests land?** → *Recommended: **yes**.*

**D10 — Global rate limiting.**
BACKEND-18 is also merged into 2.9. Half of it lives in `routers/plaza_payments.py`, which this plan may not edit; the other half (`app_otp_codes.attempts`) is already database-backed and already correct. A real global limiter needs a shared table — and Wave 3.2's per-partner API keys need the same table.
❓ **Defer BACKEND-18 to Wave 3.2, so the table gets built once?** → *Recommended: **yes**.*

**D11 — Constraining `cancelled_by`.**
`visitor_passes.cancelled_by` carries a code *and* an operator's free text in one column, and `routers/visitor_passes.py` decides tow-relevant display with a string prefix match on it. Task 14 adds `cancel_reason` for the prose and a `NOT VALID` CHECK constraining new writes to a known set of codes — every historical row keeps working, nothing is dropped, nothing is backfilled.
❓ **Add `cancel_reason` and constrain new `cancelled_by` writes, leaving history untouched?** → *Recommended: **yes**.*
