# Wave 2.5 — Retention Policy, Written Down Then Implemented

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Revision 2 (2026-09-14) — pre-flight fix pass.** A read-only pre-flight against `lotlogic-backend@origin/main`, `lotlogic@origin/main`, Supabase and Railway found 19 defects, 4 of them blocking. All are applied; the change log at the end of this file lists each one and what changed. The single most important correction: **revision 1's claim that "no task in this plan deletes a production row" was literally true and materially misleading**, because Task 12 applied R2 lifecycle rules and deleted copied originals before the flag. That is fixed — see "The one safety rule" below.

**Goal:** Every class of data LotLogic holds has a written period, one nightly job that enforces it, and lifecycle rules committed as files rather than clicked in a dashboard — and no photograph of a vehicle, a driving licence or a lease is addressable by an unauthenticated URL.

**Architecture:** One policy document (`docs/RETENTION.md`) is the source of truth for *what* and *why*; `config.Settings` carries every period as an environment variable so a number changes without a deploy; a test parses the policy table and fails when the two disagree. The enforcement is one `services/retention.py` module holding a list of `RetentionRule` objects — each a name, a cutoff column, a count query, a mutation query and a shared "referenced or open" guard — driven by `services/retention_sweep.py`, which runs as the eleventh lifespan loop under Wave 2.7's `job_locks.run_locked` + `job_registry.heartbeat` contract. It writes per-class counts to a new `ops_retention_runs` table **and nothing else** until `RETENTION_ENABLED` is true. Object storage is governed separately: R2 lifecycle JSON that `scripts/apply_r2_lifecycle.py` **reports on** but does not apply until go-live, and a Supabase migration for the two (empty, unreferenced) Storage buckets. Finally, the public r2.dev domain stops being how a photo is served: the dashboard's data layer fetches a 15-minute presign from a scope-checked endpoint, and the tow-dispatch email embeds a 48-hour presign matching its own action-token TTL.

**Tech Stack:** Python 3.11, FastAPI, SQLAlchemy 2 async + asyncpg, boto3 (already a dependency, `services/storage.py`), Supabase Postgres 17 behind a supavisor **SESSION-mode** pooler, pytest + pytest-asyncio (strict), ruff 0.16.5 (`select = ["E4","E7","E9","F"]`), Railway deploy from `main`, Supabase edge functions (Deno) + pg_cron, Cloudflare R2 (S3 API), frontend ES modules under `frontend/src/` built by esbuild (Wave 2.6 has landed).

**Spec:** `/Users/gabe/lotlogic/docs/superpowers/specs/2026-09-03-enterprise-readiness-program.md` — §3 Wave 2 row **2.5**, findings **SEC-11** (no retention policy for plates, photos, phones, IDs or leases), **DB-5** (nothing ever deletes anything and nobody watches the DB grow), **FAT-20** / **PIPE-17** (camera snapshots kept forever in R2; `snapshot_retention_hours = 24` is read by zero lines of code), §2 item 14, and §4 fat decision **28** (the evidence period question).

**Policy document this plan writes and then implements:** `docs/RETENTION.md`.

---

## The one safety rule

**Nothing in this plan deletes or moves a production object or row before Gabe flips `RETENTION_ENABLED`.** That flag is the gate on the object store exactly as much as on the database, and for a reason revision 1 missed: **an R2 lifecycle rule is enforced by Cloudflare, not by our flag.** Applying `debug/` (14 days) or the legacy-YOLO rules (30 days) deletes matching objects the instant the rule lands, no code involved. Therefore:

- `scripts/apply_r2_lifecycle.py` ships with a **report mode as its default** — it lists what each rule *would* expire, with counts, and files them as `ops_findings`. Applying is `--yes`, and **`--yes` is not run until Task 13**, except for the one rule that can only delete failed uploads (`AbortIncompleteMultipartUpload`).
- Task 12's bucket moves are **copy-only**. Deleting the originals of the apartment documents is a separate, flag-gated step in Task 13.
- The row sweep's two independent noes (`force_dry_run`, `retention_enabled=False`) and `ops_retention_runs`' database-level `CHECK (mode <> 'dry_run' OR (affected = 0 AND objects_deleted = 0))` remain as designed.

### The only production mutations in Tasks 1–12, and they are not deletions

Two, both flagged here because "read-only" would otherwise be a lie:

| Task | Mutation | Why it is safe | Shape |
|---|---|---|---|
| **9** | `UPDATE storage.buckets SET public = false WHERE id = 'plate-snapshots'` | The bucket holds **0 objects** and is referenced by **zero lines** of code in either repo. Nothing can break; nothing is destroyed. | One row, one boolean |
| **10 Step 2** | Backfill `plate_events.image_key` from `image_url` on ~68,843 rows | Additive column, no FK involvement, no deletion. But it is the hottest table in the schema, so it is **batched at 5,000 rows** with `SET LOCAL statement_timeout`, not one statement | Additive, batched |

Everything else in Tasks 1–12 is additive: new files, new tables, new columns, new endpoints, new lifecycle JSON that is read but not applied.

---

## Dependency: Wave 2.4 must be merged first

**This plan is hard-gated on Wave 2.4 (`docs/superpowers/plans/2026-09-05-wave2-4-schema-baseline.md`) being merged to `origin/main`.** That plan's own header says so from the other side: *"**Blocks:** Wave 2.1 (`properties.config`) and Wave 2.5 (retention deletes). Neither may start before Task 7 is green."*

The reason is not ceremony. This plan is the first thing in the history of the codebase that issues a `DELETE` against production tables. Wave 2.4 is what makes the schema rebuildable from files, gives migrations one canonical directory and one runner, and adds the CI drift check that proves a migration file and an applied record exist for each other. Deleting rows on a schema that exists only in production, whose 37 applied migrations have no file, is how a bad `DELETE` becomes unrecoverable.

**Status measured 2026-09-14:** `origin/wave2/schema-baseline` is **NOT** an ancestor of `origin/main` — the gate is **CLOSED**. Wave 2.7 (monitoring spine) **is** merged, with the exact signatures this plan uses: `services/job_registry.py` (`heartbeat(job, *, source, expected_interval_s, ok, error)`, `BACKEND_JOBS`), `services/job_locks.py` (`run_locked(name, body) -> bool`), `services/alerts.py` (`redact_text(text, limit)`), `services/findings.py` (`record_batch_and_notify(job, findings, *, now)`), `routers/ops.py`, `database.ops_engine`, `migrations/20260905090000_ops_job_runs.sql`, `migrations/20260907150000_ops_findings.sql`, and `tests/test_job_registry.py::test_every_lifespan_loop_has_a_registry_entry`. **Ten** `supervised()` loops exist today; the sweep is #11.

- [ ] **Task 0 gate:** `cd /Users/gabe/lotlogic-backend && git fetch origin && git merge-base --is-ancestor origin/wave2/schema-baseline origin/main && echo GATE-OPEN`. If this does not print `GATE-OPEN`, stop and report; do not start Task 2.

**Worktrees** (verified 2026-09-14):
- Backend: create `/Users/gabe/lotlogic-backend-retention` from `origin/main` on branch `wave2/retention`. `/Users/gabe/lotlogic-backend` is itself at `origin/main` and clean, so it is a safe base to branch from — but it has **no `.venv`**, and every `pytest` invocation in this plan assumes one. First command in the new worktree:
  ```bash
  python3.11 -m venv .venv && .venv/bin/pip install -r requirements.txt -r requirements-dev.txt
  ```
- Frontend: create `/Users/gabe/lotlogic-retention` from `origin/main` on branch `wave2/retention`. Do **not** work in `/Users/gabe/lotlogic` — it is on `feat/apartment-permit-registry` with 17 dirty paths including `frontend/dashboard.html`.

**Test baseline:** `cd /Users/gabe/lotlogic-backend-retention && .venv/bin/pytest -q` before Task 1; record the number. It must only go up.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **The one safety rule above governs every task.** No production object or row is deleted or moved before Task 13.
- **Never edit these files.** `routers/plaza_payments.py`, `services/plaza_settle.py`, `services/square*.py`, `services/plaza_alerts.py`, `services/plaza_sweep.py`, `services/plaza_reconcile.py`.
- **No *destructive* rule may target a business record.** `alpr_violations`, `alpr_violation_proof`, `no_registration_violations`, `partner_truck_sightings`, `tow_clip_files`, `tow_sighting_clips`, `plaza_payments`, `plaza_reconciliations`, `pending_invoices`, `properties`, `enforcement_partners`, `lot_owners`. "Destructive" is `rule.kind in {"delete", "delete_objects"}`. **Nulling one contact column on such a row is permitted and whitelisted** — rule B3 nulls `plaza_payments.phone`, which removes personal data while leaving the financial record whole. The whitelist is `retention.ALLOWED_COLUMN_NULLING = {"plaza_payments": {"phone"}}` and Task 3 has two tests holding both halves of the line.
- **Every rule names its cutoff column.** There is no `created_at` on `weak_plate_reads` (it is `seen_at`) and none on `ops_findings` (it is `first_seen_at` / `last_seen_at` / `closed_at`, with `state` rather than `status`). A `RetentionRule` carries `cutoff_column` and the SQL interpolates it; a rule that assumes `created_at` errors on both of those tables.
- **Every rule is guarded, and the guard is shared.** One `_PLATE_EVENT_UNREFERENCED` / `_PASS_NOT_OPEN` SQL fragment, composed into each rule — never re-typed per rule. `partner_truck_sightings.plate_event_id` is `ON DELETE CASCADE`, so an unguarded plate-read delete silently destroys tow evidence.
- **Statement timeouts on every batch.** Each batch runs `SET LOCAL statement_timeout = :ms` inside its own transaction. A retention sweep that wedges the pool is worse than one that never runs — the 2026-09-04 incident is the precedent. This applies to Task 10's backfill too.
- **Everything runs on `database.ops_engine`** (the `NullPool` engine from Wave 2.7), never the request pool.
- **PII discipline in findings and alert bodies.** Counts, ages, table names, class names. Never a plate, a phone number, an email address, a company name or an R2 key. `alerts.redact_text` is applied by `services/findings.py` on the way in; do not defeat it by putting a key in a `title`.
- **Secrets only via env**, as `config.Settings` fields read through `get_settings()`. No literal periods at a call site.
- **Migrations:** `migrations/YYYYMMDDHHMMSS_snake_case_name.sql` (`date -u +%Y%m%d%H%M%S`). Every new table gets `ENABLE ROW LEVEL SECURITY` and `REVOKE ALL … FROM anon, authenticated` in the same file, plus a commented rollback block. **Migrations carry no bind parameters** — a value that varies goes in as an inlined literal with a comment saying where it came from.
- **Tests:** pytest-asyncio is in **strict** mode with no ini file, so every coroutine test outside `tests/plaza/` needs its own `@pytest.mark.asyncio`. Tests inside `tests/plaza/` get the marker from that package's collect hook and run against a real Postgres 17 (`TEST_DATABASE_URL` in CI, an `initdb` cluster locally, skipped if neither). **Every Task 7 test belongs in `tests/plaza/`** — the whole risk is what the foreign keys do, and a mocked database proves nothing about that.
- **Ruff rule set unchanged.** `select = ["E4","E7","E9","F"]`, `ignore = ["E712","E701"]`. `# noqa: BLE001` only where the file already uses that style.
- **CI gate:** `ruff check .` → `python -m compileall -q -f .` → `pytest -x --tb=short -q`. All three green before a task is done.
- **Commits:** one per task, conventional prefix, with the trailer:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_012CxJpLkSpNFeXLVTrUfhWo
  ```
- **Do not push to `main` without asking.** Railway auto-deploys from `main`; there is no staging.

---

## Measured inventory (2026-09-14, read-only against production)

These numbers are the plan's justification and the dry run's expected answer. Task 1 re-measures and commits them into `docs/RETENTION.md`; if a number has moved, the task text changes, not the number.

| Fact | Value |
|---|---|
| `plate_events` | **72,553** rows · 125 MB (96 MB heap + 29 MB across **14** indexes) · 2026-04-19 → 2026-09-14 |
| `plate_events` per month | Apr 14,627 · May 8,855 · Jun 5,245 · Jul 9,860 · Aug 20,135 · Sep(1–14) 13,758 |
| `plate_events` last 7 days | **≈ 1,049 / day** (one live site, 6 cameras) |
| `plate_events.raw_data` | avg 996–1,288 B/row, ≈ 66 MB total, **67** distinct top-level keys |
| `plate_events` older than 90 d | **27,297** — of which **≈26,586 are referenced by nothing** |
| `plate_events` older than 730 d | **0** — rule A2 correctly does nothing until 2028 |
| `plate_events` with a photo URL | **68,843**, 100% on `https://pub-2b67cfea48564c9695230f8909348716.r2.dev` |
| `camera_snapshot_diag` | 12,621 rows · 19 MB · **already pruned at 7 d** by pg_cron `prune_camera_snapshot_diag` (03:17 UTC) |
| `weak_plate_reads` | **17,329** rows · 5,280 kB · 2026-05-14 → **2026-05-19** · 100% older than 90 d · **timestamp column is `seen_at`** |
| `plate_match_decisions` | 1,531 rows (223 older than 90 d) · 768 kB |
| `visitor_passes` | 3,099 rows · 2,784 kB across **20** indexes · 3,063 with a phone · 314 with an email · **314 with a government-ID photo** · 314 with a plate photo |
| `visitor_passes` ended >30 d ago and not `active` | **2,142** |
| `resident_plates` | 9 rows (6 `active`; statuses `approved` / `pending`; 3 reviewed) · 8 phones · **5 ID docs · 5 leases** · 5 plate photos · **no `valid_until` column** |
| `plaza_payments` | 10 rows, **all 10 carry a phone number** |
| `alpr_violations` | 2,494 rows · **864 with `resolved_at IS NULL`** · statuses: `dismissed` 2,466 / `resolved` 22 / `dispatched` 7 — **zero in status `open`** · **24 tow-confirmed and not yet invoiced** |
| `partner_truck_sightings` | 230 rows (tow evidence, `ON DELETE CASCADE` from `plate_events`) |
| `tow_clip_files` | 60 rows — 4 `archived` (**742 MB** of mp4) + 56 `expired_unarchived` |
| `plate_sessions` | 340 rows, no insert since 2026-05-12 — but **pg_cron `plate_sessions_sweep` runs every 3 minutes and writes it.** Not a dead table |
| `snapshots` (legacy YOLO) | **0 rows, 11 MB — entirely index** |
| `ops_findings` | 4 rows, **0 closed** · columns `state` / `first_seen_at` / `last_seen_at` / `closed_at` |
| Supabase Storage buckets | `plate-snapshots` (**public**, 0 objects, 0 code references) · `tow-evidence` (private, 0 objects, 0 code references) |
| `TOW_CLIPS_BUCKET` | **SET** on Railway `lotlogic-backend`/production. Clips already live in a private bucket |
| `SNAPSHOT_RETENTION_HOURS` | still set on Railway, read by zero lines of code — Task 1 removes both |
| Properties / cameras | 11 (10 apartment, 1 truck plaza) / 6 |

> **On "unresolved violations".** Revision 1 said 2,472. That was
> `status <> 'resolved'`, which counts every dismissal and is the wrong
> predicate: a dismissed row can still be awaiting a resolution timestamp, a
> billing hold or an invoice. The guard-relevant number is
> `resolved_at IS NULL` = **864**, of which 857 carry status `dismissed` and 7
> `dispatched`. Nothing is in status `open`, so a guard keyed on that string
> would match zero rows and let every phone number through.

### Not measurable from here

Nobody executing this review holds R2 credentials. **Object counts inside the bucket, whether any lifecycle rule exists today, and whether the r2.dev domain answers an unsigned GET are unverified.** Every R2 number quoted in this plan is a database count of *references*, not an object count. Task 8's report mode is what turns them into measured facts, and it is read-only.

### The foreign keys that make an unguarded DELETE dangerous

All six verified against production 2026-09-14.

| Child | Column | On delete of a `plate_events` row |
|---|---|---|
| `plate_match_decisions` | `plate_event_id` | **CASCADE** |
| `partner_truck_sightings` | `plate_event_id` | **CASCADE — silently deletes tow evidence** |
| `visitor_passes` | `first_seen_event_id`, `exited_via_plate_event_id` | **SET NULL — silently blanks a pass's photo** |
| `parking_passes` | `exited_via_plate_event_id` | SET NULL |
| `alpr_violations` | `plate_event_id` | NO ACTION (errors — the safe direction) |
| `plate_sessions` | `entry_plate_event_id`, `exit_plate_event_id` | NO ACTION (errors) |

### R2 key shapes in `parking-snapshots` today, and why lifecycle rules cannot work on them

```
debug/{property_id}/{YYYY-MM-DD}/sidecarempty-{api_key}-{epoch}.jpg          camera-snapshot/index.ts:391
{property_id}/{YYYY-MM-DD}/diag-{api_key}-{epoch}-rejected-{reason}.jpg      camera-snapshot/index.ts:628, :903
{property_id}/{YYYY-MM-DD}/{api_key}-{epoch}-{PLATE}.jpg                     camera-snapshot/index.ts:977   ← ACCEPTED
apt/{property_id}/{id|lease|plate}/{uuid4hex}.{ext}                          routers/apartment_docs.py:build_doc_key
violations/… , snapshots/…                                                   services/storage.build_storage_key (legacy, no writer)
```
(Tow clips live in the separate, private `TOW_CLIPS_BUCKET` under `tow-clips/`, written by `lotlogic-agent/tow_archiver/r2.py:76`.)

Accepted reads and rejected diagnostic frames **share a prefix root** (a property UUID) and differ only in a filename segment. R2 lifecycle filters on prefix. Therefore no rule can give them different periods until the keys change. Task 8a is that change.

---

## Scope calls — decided here so no executor re-litigates them

1. **`snapshot_retention_hours = 24` is deleted, not wired up (FAT-20).** It is a `config.Settings` field read by zero lines of code, and its value contradicts every period in the policy. Task 1 deletes the field, the false docstring in `services/storage.py`, **and the `SNAPSHOT_RETENTION_HOURS` variable still set on Railway** — pydantic-settings 2.11's `extra='forbid'` only rejects unmatched *dotenv* keys, not process env, so leaving it set is harmless but leaves a ghost policy in the variable box.
2. **`snapshots`, `zone_occupancy`, `violations`, `no_registration_violations` get no rule.** They are empty or have had no writer since March–May. Deleting from a dead table is not retention, it is a fat decision (spec §4 decisions 2, 3, 10) and belongs to Wave 3.6. **`plate_sessions` is not in this list and is not dead** — pg_cron `plate_sessions_sweep` writes it every 3 minutes. It gets no rule for a different reason: it is 304 kB and it is the session state machine's own working set.
3. **`camera_snapshot_diag` gets no new rule.** pg_cron `prune_camera_snapshot_diag` already deletes it at 7 days and already heartbeats into `ops_job_runs`. The policy documents it (A8); the sweep does not duplicate it. A second writer against the same table is a way to make two jobs fight.
4. **Tow footage retention is not touched, and there is no bucket gap.** `TOW_FOOTAGE_RETENTION_DAYS`, `TOW_FOOTAGE_RETENTION_OVERRIDES`, `services/tow_retention.parse_overrides` and the `tow_digest` expiry findings are shipped, tested and correct — and **`TOW_CLIPS_BUCKET` is set in production**, so clips already live in a private bucket and the 15-minute presign on `GET /ops/tow-sightings/{id}/clip` is doing real work. (Revision 1 claimed the opposite and built three tasks on it; they are withdrawn.) The only thing C2 still lacks is a lifecycle rule, which Task 13 applies.
5. **Apartment documents keep their streaming proxy; only the bucket moves.** `routers/apartment_docs.py`'s authenticated, scope-checked, `private, no-store` proxy is already the right design and is explicitly better than a presign. The finding is that it streams out of a bucket with a public domain. Task 12 **copies** `apt/` to a private bucket; the proxy code is unchanged and the originals are deleted in Task 13.
6. **The tow-dispatch email gets a 48-hour presign, not an authenticated proxy.** An email client cannot carry a bearer token. The email already mints a 48-hour HMAC action token for its Tow / No-Tow buttons; a photo URL with the same TTL is consistent, and it is the difference between "expires with the decision" and "forever".
7. **`ops_retention_runs` is a new table, not a reuse of `ops_findings`.** Findings are *distinct problems that get closed*; the dry-run evidence is *a time series of counts per class per night*. A fingerprinted, deduplicating table would either file one row that bumps `seen_count` 7 times and loses every number, or 7 × 14 rows that defeat the dedupe. A finding is still filed — one, when a class's candidate count moves by more than an order of magnitude (Task 5) — because that is a problem, not a measurement.
8. **The `evidence/` copy (Task 8a) is a copy, not a move**, and it reuses the **existing** `alpr_violations.evidence_photo_url` column rather than adding one. That column exists, is NULL on all 2,494 rows, and is read by no code — it is exactly the column this needs, and adding a thirteenth beside it would be the fat this programme exists to stop. A move (rather than a copy) would break `plate_events.image_url` for the read that produced the frame; a copy costs one R2 `CopyObject` per violation.
9. **`resident_plates` is in scope for B1/B2/B4/B5/B6, with its own guard.** It has **no `valid_until` column**, so the `visitor_passes` guard cannot be reused: its rules key on `active = false` plus `status` (`approved` / `pending`) plus `reviewed_at`, falling back to `created_at` where a row was never reviewed. Nine rows today, five of them holding a lease and a government ID — the smallest table in the plan and the most sensitive.

---

## File structure

| File | Responsibility |
|---|---|
| `docs/RETENTION.md` **(new, Task 1)** | The policy. Data class → why → period → mechanism → owner. The only place a period is *explained*. |
| `config.py` *(modify, Task 1)* | One `Settings` field per period. Deletes `snapshot_retention_hours`. |
| `tests/test_retention_policy.py` **(new, Task 1)** | Parses RETENTION.md's Setting column; asserts the document and the settings agree. |
| `migrations/2026………_ops_retention_runs.sql` **(new, Task 2)** | `ops_retention_runs` — per class, per night, per mode counts. RLS + revoke + rollback. |
| `services/retention.py` **(new, Task 3)** | `RetentionRule` (incl. `cutoff_column`, `extra_params`), the shared guards, `NEVER_SWEEP`, `ALLOWED_COLUMN_NULLING`, and the rule list. Pure SQL + dataclasses, no I/O. |
| `services/retention.py` *(extend, Task 4)* | The `plate_events.raw_data` strip rule — an `UPDATE`, with the keep-key allowlist as a module constant. |
| `services/retention_sweep.py` **(new, Task 5)** | `run_due_sweep()` / `run_sweep()` / `run_class()`: dry-run vs live, batching, statement timeout, per-class rows into `ops_retention_runs`, findings on anomaly. |
| `main.py` *(modify, Task 6)* | Eleventh lifespan loop: `supervised("retention_sweep", …)` + `job_locks.run_locked` + `job_registry.heartbeat`. |
| `services/job_registry.py` *(modify, Task 6)* | `BACKEND_JOBS["retention_sweep"] = 3600`. |
| `routers/ops.py` *(modify, Task 6)* | `GET /ops/retention`, `POST /ops/retention/dry-run`. |
| `tests/plaza/test_retention_*.py` **(new, Task 7)** | One file per data class, against real Postgres with real FKs. |
| `ops/r2-lifecycle/*.json` **(new, Task 8)** | The lifecycle rules, as config. |
| `scripts/apply_r2_lifecycle.py` **(new, Task 8)** | **Report by default**, diff on request, apply only with `--yes`. |
| `supabase/functions/camera-snapshot/index.ts` *(modify, Task 8a)* | New key prefixes `reads/`, `diag/`, `debug/`; `evidence/` copy at violation time. |
| `migrations/2026………_storage_buckets_private.sql` **(new, Task 9)** | Makes `plate-snapshots` private. |
| `routers/alpr.py` *(modify, Task 10)* | `GET /plate-events/{id}/photo` → 15-minute presign, scope-checked. |
| `frontend/src/lib/db.js` *(modify, Task 10)* | The data layer — 20 of the 41 `image_url` references live here. The chokepoint. |
| `frontend/src/ui/*.jsx`, `frontend/src/pages/*.jsx`, `frontend/tuner.html` *(modify, Task 10)* | The seven render sites. |
| `supabase/functions/tow-dispatch-email/index.ts` *(modify, Task 11)* | 48-hour presign instead of the permanent public URL. |

---

## Task sequence, dependencies and parallelism

| # | Task | Depends on | Lane | Touches production? |
|---|---|---|---|---|
| 0 | **Gate:** Wave 2.4 merged to `origin/main` | — | — | no |
| 1 | `docs/RETENTION.md` + `config.Settings` periods + the policy⇄settings test | 0 | A | no (removes one unused Railway var) |
| 2 | Migration: `ops_retention_runs` | 0 | A | additive |
| 3 | `services/retention.py` — rules, guards, the two invariants | 1 | A | no |
| 4 | The vendor-JSON strip rule (`UPDATE`, not `DELETE`) | 3 | A | no |
| 5 | `services/retention_sweep.py` — `run_due_sweep`, dry-run default | 2, 3, 4 | A | no |
| 6 | Wire the sweep into the lifespan as job #11 | 5 | A | writes `ops_retention_runs` only |
| 7 | One test per data class, against real Postgres | 3, 4, 5 | A | no |
| 8 | R2 lifecycle JSON + `scripts/apply_r2_lifecycle.py` (**report mode**) | 1 | **B** | no — read-only |
| 8a | Key restructure: `reads/` `diag/` `debug/` + the `evidence/` copy | 8 | **B** | new writes only |
| 9 | `plate-snapshots` Storage bucket → private (migration) | 0 | **B** | **one boolean, 0 objects** |
| 10 | Presigned photo endpoint + dashboard-module repoint | 1 | **C** | **additive column + batched backfill** |
| 11 | Tow-dispatch email: 48-hour presign | 10 | **C** | no |
| 12 | **Copy-only:** `apt/` → `lotlogic-docs`; the safe multipart-abort rule | 8a, 10, 11 | join | copies, deletes nothing |
| 13 | **Go-live:** seven nights reviewed → flag → lifecycle rules → delete copied originals → public domain off | 6, 7, 12 | join | **yes — all of it** |

**Parallelism map.** Three lanes run concurrently after Task 1:

```
        ┌── Lane A (backend sweep) ───────────────────────────────────────────┐
  0 ──► 1 ──► 3 ──► 4 ──► 5 ──► 6 ──┐
        │                  └──► 7 ──┤
        │                           │
        ├── Lane B (object storage) │
        ├──► 8 ──► 8a ──────────────┤
   0 ───┴──► 9 ────────────────────►├──► 12 ──► 13
        │                           │
        └── Lane C (presigned URLs) │
           ► 10 ──► 11 ─────────────┘
```

- **Lane A** is the only lane that touches `services/` and `main.py`.
- **Lane B** is the only lane that touches R2 config and `camera-snapshot/index.ts`.
- **Lane C** is the only lane that touches `routers/alpr.py`, `frontend/src/`, `tuner.html` and `tow-dispatch-email`.
- Lanes A and C both add a backend route/module but never the same file. Lanes B and C both touch the frontend repo but never the same file (`supabase/functions/camera-snapshot/` vs `frontend/src/` + `supabase/functions/tow-dispatch-email/`).
- **Task 12 is a join and must be second to last.** It is copy-only, but it is the step that makes Task 13's deletions safe.
- **Task 13 is Gabe's decision**, and it is the only task in this plan that destroys anything.

Suggested three-agent split: A = tasks 1→3→4→5→6→7; B = 8→8a and 9; C = 10→11. Then one agent joins on 12.

---

## Task 1: The policy document, the settings, and the test that keeps them honest

**Files:**
- Create: `docs/RETENTION.md` (frontend repo)
- Modify: `config.py` (backend) — add the `── Retention ──` block, **delete** `snapshot_retention_hours`
- Modify: `services/storage.py` — delete the false docstring claim
- Create: `tests/test_retention_policy.py`
- Railway: remove the `SNAPSHOT_RETENTION_HOURS` variable

**Interfaces produced:** `Settings.retention_enabled: bool = False`, `retention_plate_event_raw_days=90`, `retention_plate_event_row_days=730`, `retention_weak_plate_read_days=90`, `retention_plate_match_decision_days=90`, `retention_pass_phone_days=30`, `retention_payment_phone_days=395`, `retention_id_doc_days=30`, `retention_lease_doc_days=90`, `retention_pass_plate_photo_days=90`, `retention_ops_job_history_days=90`, `retention_closed_finding_days=365`, `retention_batch_size=2000`, `retention_max_batches_per_class=50`, `retention_statement_timeout_ms=20000`.

- [ ] **Step 1: Write `docs/RETENTION.md`.** The draft already exists. Re-measure every number in its §2 against production (read-only) and correct any that has moved. Keep the `> **STATUS: DRAFT — not in force.**` banner: it is removed by Task 13 and by nothing else.

- [ ] **Step 2: Add the settings block to `config.py`**, immediately after the `── Tow footage retention ──` block:

```python
    # ── Retention (Wave 2.5) ──────────────────────────────────────────────
    # Every period in docs/RETENTION.md is one of these fields, so a period
    # changes with a Railway variable rather than a deploy. The document is
    # the *why*; these are the *what*, and tests/test_retention_policy.py
    # fails the build when the two disagree.
    #
    # THE MASTER SWITCH — and it gates the object store as much as the
    # database. False means services/retention_sweep.py counts what it would
    # have done into public.ops_retention_runs and mutates nothing, AND that
    # scripts/apply_r2_lifecycle.py has not been run with --yes, AND that no
    # original copied to a private bucket has been deleted. It ships False and
    # stays False until seven nights of dry-run counts have been read by a
    # human (RETENTION.md §7 decision 15). There is deliberately no per-class
    # enable: a half-armed sweep is a sweep nobody can reason about.
    retention_enabled: bool = False

    # A1 — strip the camera vendor's raw JSON down to the matched fields.
    # An UPDATE, never a DELETE: the read itself survives (A2's period).
    retention_plate_event_raw_days: int = 90
    # A2 — delete a plate read nothing points at. 730 rather than 365 because
    # a tow dispute can arrive a year late and the row is ~1.3 kB without its
    # raw_data; the photograph (A3, 365 d) is the expensive half. Nothing in
    # production is 730 days old yet, so this rule is armed for 2028.
    retention_plate_event_row_days: int = 730
    # A9 / A10 — second-pass OCR material and the matcher's decision log.
    # NOTE A9's cutoff column is weak_plate_reads.seen_at; that table has no
    # created_at. The column lives on the rule, not here.
    retention_weak_plate_read_days: int = 90
    retention_plate_match_decision_days: int = 90

    # B1 / B2 — blank the phone and email N days after the pass ends. The pass
    # row survives; only the two contact columns are nulled. visitor_passes
    # keys on valid_until + status; resident_plates has NO valid_until and
    # keys on active/status/reviewed_at (see services/retention.py).
    retention_pass_phone_days: int = 30
    # B3 — a payment's contact phone is attached to a financial record, so it
    # outlives a pass phone: 13 months covers every card-network chargeback
    # window plus one tax cycle. plaza_payments is a NEVER_SWEEP table; this
    # single column is whitelisted in retention.ALLOWED_COLUMN_NULLING.
    retention_payment_phone_days: int = 395
    # B4 / B5 / B6 — R2 object deleted AND the column nulled, in that order.
    # ID is the shortest period in this file on purpose.
    retention_id_doc_days: int = 30
    retention_lease_doc_days: int = 90
    retention_pass_plate_photo_days: int = 90

    # D2 / D3 — the sweep's own history, and findings that are already closed.
    # D3's cutoff column is ops_findings.closed_at with state = 'closed'; that
    # table has no status and no created_at.
    retention_ops_job_history_days: int = 90
    retention_closed_finding_days: int = 365

    # Mechanics, not policy. batch_size x max_batches_per_class is the hard
    # ceiling on one class in one night: 2000 x 50 = 100,000 rows, more than
    # the whole of plate_events today and still comfortably inside the hour
    # the loop ticks on. A class that hits the ceiling files a finding rather
    # than running longer.
    retention_batch_size: int = 2000
    retention_max_batches_per_class: int = 50
    # SET LOCAL statement_timeout per batch. A retention sweep that wedges the
    # pool is worse than one that never runs (2026-09-04).
    retention_statement_timeout_ms: int = 20000
```

- [ ] **Step 3: Delete the setting that pretends to be a policy (FAT-20).**

Confirm it has no reader (verified — zero hits outside `config.py`):
```bash
cd /Users/gabe/lotlogic-backend-retention && grep -rn "snapshot_retention_hours" --include='*.py' . | grep -v "config.py"
```
Delete `snapshot_retention_hours: int = 24` from `config.py`. Then **remove `SNAPSHOT_RETENTION_HOURS` from the Railway `lotlogic-backend` production variables in the same change** — pydantic-settings 2.11's `extra='forbid'` only rejects unmatched dotenv keys, not process env, so leaving it set will not crash the boot, but it leaves a number in the variable box that reads like policy and governs nothing.

In `services/storage.py`, delete these two docstring lines, false since the April lifecycle-rule deletion:
```
Only violation snapshots are kept long-term.
Non-violation snapshots are deleted after 24h via lifecycle rule.
```
and replace with:
```
Retention is governed by docs/RETENTION.md and enforced in two places:
R2 bucket lifecycle rules (ops/r2-lifecycle/*.json, applied by
scripts/apply_r2_lifecycle.py) for objects whose period depends on when they
were written, and services/retention_sweep.py for objects whose period
depends on a row (an ID photo's period runs from the registration decision,
not from the upload).
```

- [ ] **Step 4: Write `tests/test_retention_policy.py`.**

The document lives in the frontend repo and the settings in the backend. **The two document-parsing tests skip when the file is absent; the two code-only tests must not** — a module-level `pytestmark` would mean the FAT-20 regression and the master-switch default never run in backend CI, which is where they matter most.

```python
"""The policy document and config.Settings must not drift apart.

docs/RETENTION.md is the only place a period is EXPLAINED; config.Settings is
the only place one is READ. A period that exists in one and not the other is
the exact failure this whole plan exists to prevent — a setting that looks
like policy and is enforced by nothing (FAT-20's `snapshot_retention_hours`),
or a policy nobody implemented (SEC-11).

The two document-parsing tests skip when RETENTION.md is not on disk (it lives
in the frontend repo). The two code-only tests below them do NOT skip: they are
regression guards on this repo's own config and must run in backend CI, which
never has the document checked out.
"""
from __future__ import annotations

import os
import re
from pathlib import Path

import pytest

from config import Settings

_DEFAULT = Path.home() / "lotlogic" / "docs" / "RETENTION.md"
POLICY_PATH = Path(os.environ.get("RETENTION_POLICY_PATH", _DEFAULT))

needs_policy = pytest.mark.skipif(
    not POLICY_PATH.is_file(),
    reason=f"RETENTION.md not on disk at {POLICY_PATH} (set RETENTION_POLICY_PATH)",
)

#: Settings fields that are mechanics, not periods — they need no policy row.
MECHANICS = {
    "retention_batch_size",
    "retention_max_batches_per_class",
    "retention_statement_timeout_ms",
    "retention_enabled",
}


def _settings_named_in_policy() -> set[str]:
    """Every `RETENTION_*` token appearing in a backticked cell, lowercased."""
    text = POLICY_PATH.read_text(encoding="utf-8")
    return {m.lower() for m in re.findall(r"`(RETENTION_[A-Z0-9_]+)", text)}


def _retention_fields() -> set[str]:
    return {n for n in Settings.model_fields if n.startswith("retention_")}


@needs_policy
def test_every_setting_named_in_the_policy_is_a_real_field():
    unknown = _settings_named_in_policy() - _retention_fields()
    assert not unknown, f"RETENTION.md names settings that do not exist: {sorted(unknown)}"


@needs_policy
def test_every_period_field_is_explained_in_the_policy():
    missing = _retention_fields() - MECHANICS - _settings_named_in_policy()
    assert not missing, (
        "these periods are enforced by code but explained nowhere in "
        f"RETENTION.md: {sorted(missing)}"
    )


def test_the_master_switch_ships_off():
    """A retention sweep that is on by default is a retention sweep that
    deleted production before anyone read its dry run. Runs everywhere."""
    assert Settings.model_fields["retention_enabled"].default is False


def test_the_fake_policy_setting_is_gone():
    """FAT-20: `snapshot_retention_hours = 24` read like a policy and was read
    by zero lines of code. Runs everywhere — this is a config regression guard,
    not a documentation check."""
    assert "snapshot_retention_hours" not in Settings.model_fields
```

- [ ] **Step 5: Run and commit**

```bash
cd /Users/gabe/lotlogic-backend-retention && .venv/bin/pytest tests/test_retention_policy.py -q && ruff check config.py services/storage.py tests/test_retention_policy.py && .venv/bin/pytest -q
```
Expected: 4 passed (or 2 passed / 2 skipped without the document — **never 4 skipped**), and the full-suite number unchanged from the baseline.

```bash
git add config.py services/storage.py tests/test_retention_policy.py
git commit -m "feat(retention): periods as settings, and delete the setting that pretended to be one

Every period in docs/RETENTION.md is now a Settings field, so a period changes
with a Railway variable rather than a deploy, and tests/test_retention_policy.py
fails the build when the document and the code disagree.

snapshot_retention_hours = 24 is deleted: it was read by zero lines of code and
its value contradicted every real period (FAT-20). The matching Railway variable
goes with it. services/storage.py's claim that non-violation snapshots are
deleted after 24h via a lifecycle rule is deleted too — that rule was removed in
April.

Wave 2.5 / SEC-11, DB-5, FAT-20."
```

---

## Task 2: Migration — `ops_retention_runs`

**Files:** Create `migrations/$(date -u +%Y%m%d%H%M%S)_ops_retention_runs.sql`

**Why a table and not a log line.** The seven-night dry run is the only evidence anyone will have when deciding whether to arm a delete. A `log.info` in Railway is gone in three days. This is one row per class per run, forever queryable, and it is what Task 13's go/no-go reads.

- [ ] **Step 1: Write the migration**

```sql
-- Wave 2.5 — the retention sweep's own record of what it did, or would have.
--
-- Nothing in LotLogic has ever deleted anything (DB-5), so the first delete
-- ships disarmed: services/retention_sweep.py runs nightly with
-- RETENTION_ENABLED=false, counts the rows each rule WOULD have touched, and
-- writes them here. Seven nights of these rows are what a human reads before
-- the flag is flipped (docs/RETENTION.md §7 decision 15) — and after it is
-- flipped, the same rows are the audit trail of what was actually removed.
--
-- One row per (run, data class). Not fingerprinted, not deduplicated: this is
-- a time series of counts, which is exactly the shape ops_findings is not
-- (a finding is a distinct PROBLEM that gets closed; "26,586 candidates
-- tonight" is a measurement).

CREATE TABLE IF NOT EXISTS public.ops_retention_runs (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- One uuid per sweep, shared by every class row that sweep produced, so
    -- "what did the 2026-09-15 run do" is one equality predicate.
    run_id          uuid        NOT NULL,
    started_at      timestamptz NOT NULL DEFAULT now(),
    finished_at     timestamptz,

    -- Matches services/retention.py's RetentionRule.name, and the policy's
    -- row id (A1, A2, B4 …) is carried in policy_ref so a row can be traced
    -- back to the sentence that authorised it.
    data_class      text NOT NULL,
    policy_ref      text NOT NULL,
    target_table    text NOT NULL,

    -- 'dry_run' — counted only, nothing mutated. 'live' — mutated.
    -- CHECK, not a boolean: a third mode ('skipped') is plausible and a
    -- boolean would have to be nullable to express it.
    mode            text NOT NULL CHECK (mode IN ('dry_run', 'live', 'skipped')),

    -- ELIGIBLE rows only: past the cutoff AND past the guard. This number is
    -- what Task 13's go/no-go compares against the plan's inventory, and what
    -- a live run's `affected` should match within a few percent the next
    -- night. It does NOT include `protected`.
    candidates      bigint NOT NULL DEFAULT 0 CHECK (candidates >= 0),
    -- Rows actually deleted/updated/nulled. Always 0 in dry_run.
    affected        bigint NOT NULL DEFAULT 0 CHECK (affected >= 0),
    -- Rows past the cutoff that the guard REFUSED. Disjoint from candidates:
    -- candidates + protected = everything past the cutoff. This is the number
    -- that proves the guard fired; a class where it is always 0 should be
    -- looked at.
    protected       bigint NOT NULL DEFAULT 0 CHECK (protected >= 0),
    -- R2 objects deleted (B4/B5/B6 only; 0 for pure row rules).
    objects_deleted bigint NOT NULL DEFAULT 0 CHECK (objects_deleted >= 0),

    -- The age of the oldest ELIGIBLE row, for sanity: a cutoff bug shows up
    -- here as a suspiciously small number long before it shows up in
    -- `affected`.
    oldest_candidate_at timestamptz,
    batches         integer NOT NULL DEFAULT 0 CHECK (batches >= 0),
    -- True when the class hit retention_max_batches_per_class and stopped
    -- with work left. The sweep files a finding when this is true.
    truncated       boolean NOT NULL DEFAULT false,

    duration_ms     integer,
    -- Redacted by services/alerts.redact_text before insert, same discipline
    -- as ops_job_runs.last_error.
    error           text,

    CONSTRAINT ops_retention_runs_dry_run_mutates_nothing CHECK (
        mode <> 'dry_run' OR (affected = 0 AND objects_deleted = 0)
    )
);

COMMENT ON TABLE public.ops_retention_runs IS
    'One row per data class per nightly retention sweep. In dry_run mode the '
    'counts are what WOULD have been touched and a database-level CHECK '
    'guarantees nothing was. `candidates` counts rows that passed BOTH the '
    'cutoff and the guard; `protected` counts those the guard refused. '
    'Wave 2.5; policy in docs/RETENTION.md.';

-- The two query shapes: "show me one run" and "show me this class over time"
-- (the seven-night go/no-go, and the anomaly check inside the sweep).
CREATE INDEX IF NOT EXISTS idx_ops_retention_runs_run
    ON public.ops_retention_runs (run_id);
CREATE INDEX IF NOT EXISTS idx_ops_retention_runs_class_time
    ON public.ops_retention_runs (data_class, started_at DESC);

-- Platform operations, no tenant. Deny both browser roles outright rather than
-- relying on the absence of a policy.
ALTER TABLE public.ops_retention_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ops_retention_runs FROM anon, authenticated;

-- Rollback (manual — run by hand if this migration needs to be reverted):
--
-- DROP INDEX IF EXISTS public.idx_ops_retention_runs_class_time;
-- DROP INDEX IF EXISTS public.idx_ops_retention_runs_run;
-- DROP TABLE IF EXISTS public.ops_retention_runs;
```

- [ ] **Step 2: Apply it** through the Supabase MCP `apply_migration` (so the row lands in `supabase_migrations.schema_migrations` and Wave 2.4's drift check stays green), then verify:

```sql
SELECT count(*) FROM public.ops_retention_runs;                          -- 0
SELECT relrowsecurity FROM pg_class WHERE relname='ops_retention_runs';  -- t
```

- [ ] **Step 3: Commit** (`feat(retention): ops_retention_runs — the dry run's evidence`).

---

## Task 3: `services/retention.py` — the rules, the guards, and the two invariants

**Files:** Create `services/retention.py`; test `tests/test_retention_rules.py` (pure-SQL-shape tests; the behavioural tests are Task 7).

**Interfaces produced:**

```python
@dataclass(frozen=True)
class RetentionRule:
    name: str                       # matches ops_retention_runs.data_class
    policy_ref: str                 # "A2", "B4" — the RETENTION.md row
    target_table: str
    kind: str                       # "delete" | "update" | "null_columns" | "delete_objects"
    days_setting: str               # a Settings field name
    cutoff_column: str              # NOT assumed to be created_at — see below
    count_sql: str                  # -> (candidates, protected, oldest)
    mutate_sql: str                 # takes :cutoff, :batch — RETURNING the ids
    object_key_sql: str | None = None     # delete_objects only
    nulled_columns: tuple[str, ...] = ()  # null_columns / delete_objects only
    extra_params: Mapping[str, Any] = field(default_factory=dict)
```

- `retention.rules() -> list[RetentionRule]` — built from `get_settings()` at call time (not import time, so a monkeypatched setting lands).
- `retention.NEVER_SWEEP: frozenset[str]`
- `retention.ALLOWED_COLUMN_NULLING: Mapping[str, frozenset[str]]`
- `retention.DESTRUCTIVE_KINDS: frozenset[str] = frozenset({"delete", "delete_objects"})`
- `retention.cutoff(days: int, *, now: datetime) -> datetime`

**`cutoff_column` is not decoration.** Three of the twelve rules do not have a `created_at` to key on, and a rule that assumes one raises `UndefinedColumn` at runtime rather than failing a test:

| Rule | Table | Cutoff column | Why |
|---|---|---|---|
| A9 | `weak_plate_reads` | **`seen_at`** | the table has `seen_at` / `processed_at` and no `created_at` |
| D3 | `ops_findings` | **`closed_at`** (+ `state = 'closed'`) | the table has `state` / `first_seen_at` / `last_seen_at` / `closed_at`; there is no `status` and no `created_at`, and an open or `wontfix` row must never be deleted at any age |
| D2 | `ops_retention_runs` | `started_at` | that is the column this plan's own migration creates |

**`extra_params` is not decoration either.** Rule A1 binds a keep-key list (`:keep`); without a per-rule parameter bag, Task 5's executor has nowhere to put it and Task 4's SQL cannot be issued. It defaults to an empty mapping, so eleven of the twelve rules never mention it.

- [ ] **Step 1: Write the shared guard fragments.** These are the whole safety argument, so they are one constant each, composed — never re-typed:

```python
#: A plate read is UNREFERENCED when nothing in the schema points at it.
#: This is not belt-and-braces. The foreign keys make it load-bearing
#: (all six verified against production 2026-09-14):
#:
#:   plate_match_decisions.plate_event_id    ON DELETE CASCADE
#:   partner_truck_sightings.plate_event_id  ON DELETE CASCADE  ← TOW EVIDENCE
#:   visitor_passes.first_seen_event_id      ON DELETE SET NULL ← a pass's photo
#:   visitor_passes.exited_via_plate_event_id ON DELETE SET NULL
#:   parking_passes.exited_via_plate_event_id ON DELETE SET NULL
#:   alpr_violations.plate_event_id          NO ACTION (errors — safe)
#:   plate_sessions.entry/exit_plate_event_id NO ACTION (errors — safe)
#:
#: So a naive `DELETE FROM plate_events WHERE created_at < …` destroys tow
#: sightings and blanks pass photos WITHOUT RAISING ANYTHING. Measured
#: 2026-09-14: 27,297 reads older than 90 days, ~26,586 referenced by nothing.
#: The guard costs ~711 rows and buys the difference between a retention sweep
#: and an incident.
_PLATE_EVENT_UNREFERENCED = """
    NOT EXISTS (SELECT 1 FROM public.alpr_violations v
                 WHERE v.plate_event_id = pe.id)
AND NOT EXISTS (SELECT 1 FROM public.partner_truck_sightings s
                 WHERE s.plate_event_id = pe.id)
AND NOT EXISTS (SELECT 1 FROM public.plate_match_decisions d
                 WHERE d.plate_event_id = pe.id)
AND NOT EXISTS (SELECT 1 FROM public.plate_sessions ps
                 WHERE ps.entry_plate_event_id = pe.id
                    OR ps.exit_plate_event_id  = pe.id)
AND NOT EXISTS (SELECT 1 FROM public.visitor_passes vp
                 WHERE vp.first_seen_event_id      = pe.id
                    OR vp.exited_via_plate_event_id = pe.id)
AND NOT EXISTS (SELECT 1 FROM public.parking_passes pp
                 WHERE pp.exited_via_plate_event_id = pe.id)
"""

#: A guest pass is CLOSED when it cannot still be argued about: it has ended,
#: it is not active, and no violation on that plate at that property is
#: unresolved, held, or tow-confirmed-but-uninvoiced.
#:
#: `v.resolved_at IS NULL` — NOT `v.status <> 'resolved'`. Measured
#: 2026-09-14: resolved_at IS NULL is 864 rows; status <> 'resolved' is 2,473,
#: because 2,466 rows carry status 'dismissed' and a dismissal is not a
#: resolution. And nothing at all is in status 'open', so a guard keyed on
#: that string matches zero rows and lets every phone number through. Of the
#: 864, 24 are tow-confirmed and not yet invoiced — blanking the contact on
#: one of those is blanking the contact for a tow you are about to bill.
_GUEST_PASS_NOT_OPEN = """
    vp.valid_until < :cutoff
AND vp.status <> 'active'
AND NOT EXISTS (
        SELECT 1 FROM public.alpr_violations v
         WHERE v.plate_text = vp.plate_text
           AND v.property_id = vp.property_id
           AND (   v.resolved_at IS NULL
                OR v.billing_held_at IS NOT NULL
                OR (v.tow_confirmed_at IS NOT NULL AND v.invoiced_at IS NULL))
    )
AND vp.overstay_violation_id IS NULL
"""

#: resident_plates HAS NO valid_until. Nine rows today, six of them active,
#: statuses 'approved' and 'pending', three ever reviewed. A permanent plate
#: has no end date — it has an ACTIVE flag — so "the pass ended" means the
#: registration was deactivated, and the clock runs from the review decision
#: where there was one and from creation where there was not.
_RESIDENT_PLATE_NOT_OPEN = """
    rp.active = false
AND COALESCE(rp.reviewed_at, rp.created_at) < :cutoff
AND NOT EXISTS (
        SELECT 1 FROM public.alpr_violations v
         WHERE v.plate_text = rp.plate_text
           AND v.property_id = rp.property_id
           AND (   v.resolved_at IS NULL
                OR v.billing_held_at IS NOT NULL
                OR (v.tow_confirmed_at IS NOT NULL AND v.invoiced_at IS NULL))
    )
"""
```

- [ ] **Step 2: Write `RetentionRule` and the registry.** One rule per policy row. Each `count_sql` returns `(candidates, protected, oldest)`; each `mutate_sql` takes `:cutoff` and `:batch` and returns the affected ids. Rule A2, in full — note that `candidates` is guard-filtered, which is what `ops_retention_runs`' column comment and Task 13's go/no-go both assume:

```python
_A2_COUNT = f"""
SELECT count(*) FILTER (WHERE {_PLATE_EVENT_UNREFERENCED})       AS candidates,
       count(*) FILTER (WHERE NOT ({_PLATE_EVENT_UNREFERENCED})) AS protected,
       min(pe.created_at) FILTER (WHERE {_PLATE_EVENT_UNREFERENCED}) AS oldest
  FROM public.plate_events pe
 WHERE pe.created_at < :cutoff
"""

_A2_DELETE = f"""
WITH doomed AS (
    SELECT pe.id
      FROM public.plate_events pe
     WHERE pe.created_at < :cutoff
       AND {_PLATE_EVENT_UNREFERENCED}
     ORDER BY pe.created_at
     LIMIT :batch
     FOR UPDATE SKIP LOCKED
)
DELETE FROM public.plate_events t USING doomed d
 WHERE t.id = d.id
RETURNING t.id
"""
```

Notes an executor must not "simplify away":
- **`candidates` is `FILTER (WHERE guard)`, not a bare `count(*)`.** `candidates` and `protected` are disjoint and sum to everything past the cutoff. A bare count would make `candidates` include the rows the guard refuses, contradict the migration's column comment, and make Task 13's "affected should match last night's candidates" check wrong by exactly the number of protected rows.
- `min(...) FILTER (WHERE guard)` for the same reason: `oldest_candidate_at` must describe a row the sweep would actually touch.
- `FOR UPDATE SKIP LOCKED` — the camera pipeline writes this table continuously; a batch must not block an ingest, and an ingest must not block the batch.
- `ORDER BY pe.created_at` — oldest first, so a truncated run makes monotonic progress instead of re-scanning the same window.
- The guard appears three times in the count and once in the mutation, and it is the same constant every time. That is the point of the constant.

- [ ] **Step 3: The two invariants and their two tests.**

```python
#: Tables no DESTRUCTIVE rule may name. These are the invoice trail.
NEVER_SWEEP = frozenset({
    "alpr_violations", "alpr_violation_proof", "no_registration_violations",
    "partner_truck_sightings", "tow_clip_files", "tow_sighting_clips",
    "plaza_payments", "plaza_reconciliations", "pending_invoices",
    "properties", "enforcement_partners", "lot_owners",
})

DESTRUCTIVE_KINDS = frozenset({"delete", "delete_objects"})

#: The ONE exception, and it is a whitelist rather than a hole.
#:
#: Rule B3 nulls plaza_payments.phone at 13 months. plaza_payments is a
#: NEVER_SWEEP table and must stay one: it is the payment ledger, it is a
#: 7-year record, and nothing may delete a row from it. But nulling a single
#: contact column is a different act from deleting a row — it removes personal
#: data while leaving the financial record whole, which is the entire point of
#: the rule. Encoding that as a table+column whitelist rather than as an
#: exemption means adding a second one is a deliberate edit with a policy row
#: beside it, which is the bar this is meant to set.
ALLOWED_COLUMN_NULLING: Mapping[str, frozenset[str]] = {
    "plaza_payments": frozenset({"phone"}),
}
```

```python
def test_no_destructive_rule_targets_a_business_record():
    """RETENTION.md §3.E. A rule that can DELETE from the invoice trail is not
    a retention bug, it is a revenue bug."""
    for rule in retention.rules():
        if rule.kind in retention.DESTRUCTIVE_KINDS:
            assert rule.target_table not in retention.NEVER_SWEEP, rule.name


def test_column_nulling_on_a_business_record_is_whitelisted():
    """The other half of the same line. Nulling a contact column on a
    never-swept table is allowed, but only where RETENTION.md says so — and
    the column has to be named, not just the table."""
    for rule in retention.rules():
        if rule.target_table not in retention.NEVER_SWEEP:
            continue
        allowed = retention.ALLOWED_COLUMN_NULLING.get(rule.target_table, frozenset())
        assert rule.nulled_columns, (
            f"{rule.name} targets never-swept {rule.target_table} but nulls nothing"
        )
        assert set(rule.nulled_columns) <= allowed, (
            f"{rule.name} nulls {sorted(set(rule.nulled_columns) - allowed)} on "
            f"{rule.target_table}, which RETENTION.md §3.E does not permit"
        )
```

- [ ] **Step 4: The full registry.** Twelve rules — A1, A2, A9, A10, B1/B2 (×2: `visitor_passes` and `resident_plates`), B3, B4, B5, B6, D2, D3. The two B1/B2 rules are **separate rules with separate guards**, not one rule with a branch: `resident_plates` has no `valid_until`, and pretending otherwise is how the SQL errors at runtime.

- [ ] **Step 5: Shape tests.** Every rule's `days_setting` resolves to a real `Settings` field; every rule's `cutoff_column` exists on `information_schema.columns` for its `target_table` (a real-Postgres test in `tests/plaza/`, since it needs the schema); every `mutate_sql` contains `LIMIT :batch`; every `delete`-kind `mutate_sql` contains `SKIP LOCKED`; every rule that binds a parameter beyond `:cutoff`/`:batch` declares it in `extra_params`; rule names are unique.

- [ ] **Step 6:** `ruff check`, `pytest tests/test_retention_rules.py -q`, commit (`feat(retention): the rules, their cutoff columns, and the two invariants`).

---

## Task 4: The vendor-JSON strip — an `UPDATE`, not a `DELETE`

**Files:** Modify `services/retention.py`; test `tests/test_retention_rules.py`.

This is rule **A1** and it is the single largest, safest win in the plan: ~66 MB of vendor JSON on rows nobody will ever re-litigate, removable without deleting a single enforcement record.

- [ ] **Step 1: The keep-list, as a module constant with its measured justification.** It is a **`list`**, not a tuple: asyncpg binds a Python list to a Postgres array, and `= ANY(:keep)` / `<> ALL(:keep)` against a tuple is either a syntax error or a silently-wrong row comparison.

```python
#: The 12 keys a 90-day-old plate read still needs. Measured against
#: production 2026-09-14: `plate_events.raw_data` carries 67 distinct
#: top-level keys and averages 996-1,288 bytes across 72,553 rows (~66 MB).
#: Everything not named here is vendor scratch — bounding boxes (34,270 rows),
#: MMC probability tables (47,757), retired-sidecar diagnostics (15,251), the
#: raw Milesight envelope (23,940) — useful for about a week while a camera is
#: being tuned, and never afterwards.
#:
#: The keys that stay are the ones a HUMAN argument turns on: which OCR
#: produced the read, which direction the vehicle was going, which pass it
#: matched and whether that match was fuzzy, and whether an operator ever
#: relabelled it.
#:
#: A list, not a tuple: asyncpg binds a list to a Postgres array, which is
#: what `= ANY(:keep)` and `<> ALL(:keep)` below require.
RAW_DATA_KEEP_KEYS: list[str] = [
    "ocr_source", "direction", "flow",
    "pass_id", "pass_match_fuzzy",
    "overstay", "cross_camera_match", "verified_pair_match",
    "operator_label", "operator_labeled_at",
    "_source", "_mmc_source",
]
```

- [ ] **Step 2: The SQL.** Idempotent, and it must not rewrite a row it has already stripped — otherwise every night re-dirties 26,000 pages for nothing:

```python
_A1_COUNT = """
SELECT count(*)               AS candidates,
       0::bigint              AS protected,
       min(pe.created_at)     AS oldest
  FROM public.plate_events pe
 WHERE pe.created_at < :cutoff
   AND pe.raw_data IS NOT NULL
   AND EXISTS (SELECT 1 FROM jsonb_object_keys(pe.raw_data) k
                WHERE k <> ALL (:keep))
"""

_A1_STRIP = """
WITH doomed AS (
    SELECT pe.id
      FROM public.plate_events pe
     WHERE pe.created_at < :cutoff
       AND pe.raw_data IS NOT NULL
       -- Already stripped? Then every remaining key is in the keep-list and
       -- there is nothing to do. Without this the sweep rewrites the same
       -- rows every night forever, which is a lot of WAL to achieve nothing.
       AND EXISTS (
           SELECT 1 FROM jsonb_object_keys(pe.raw_data) k
            WHERE k <> ALL (:keep)
       )
     ORDER BY pe.created_at
     LIMIT :batch
     FOR UPDATE SKIP LOCKED
)
UPDATE public.plate_events t
   SET raw_data = (
        SELECT COALESCE(jsonb_object_agg(k.key, k.value), '{}'::jsonb)
          FROM jsonb_each(t.raw_data) k
         WHERE k.key = ANY (:keep)
   )
  FROM doomed d
 WHERE t.id = d.id
RETURNING t.id
"""
```

- [ ] **Step 3: Register it.**

```python
RetentionRule(
    name="plate_event_raw_json",
    policy_ref="A1",
    target_table="plate_events",
    kind="update",
    days_setting="retention_plate_event_raw_days",
    cutoff_column="created_at",
    count_sql=_A1_COUNT,
    mutate_sql=_A1_STRIP,
    extra_params={"keep": RAW_DATA_KEEP_KEYS},
)
```

**A1 carries no `_PLATE_EVENT_UNREFERENCED` guard, deliberately** — hence `protected` is a literal `0`. It does not delete the read; a violation, a session, a sighting and a pass all keep pointing at the same row with the same plate, time, camera, confidence and photo. The only thing that leaves is vendor scratch. Making A1 respect the reference guard would exempt exactly the rows with the fattest `raw_data` (the matched ones) and defeat the purpose. Put this reasoning in the rule's docstring — it is the one place the plan deliberately does not use the shared guard, and the next reader will otherwise "fix" it.

- [ ] **Step 4:** Test that a stripped row keeps all 12 keys and loses the others; that re-running the rule affects **0** rows and reports **0** candidates; that `raw_data` becomes `{}` and never `NULL`; that a row inside the cutoff is untouched; that `:keep` binds (a rule whose `extra_params` is dropped raises, it does not silently strip everything).

- [ ] **Step 5:** `ruff check`, `pytest -q`, commit (`feat(retention): strip plate-read vendor JSON to the 12 matched fields at 90 days`).

---

## Task 5: `services/retention_sweep.py` — the runner

**Files:** Create `services/retention_sweep.py`; test `tests/test_retention_sweep.py` (fakes; Task 7 does it for real).

**Interfaces produced:**

```python
SWEEP_INTERVAL_SECONDS = 3600
DUE_HOUR_UTC = 4
DUE_MINUTE_UTC = 10

async def run_due_sweep(*, now: datetime | None = None) -> dict:
    """The loop's entry point. Mirrors services/tow_digest.run_due_digest.

    Returns {"ran": bool, "run_id": str | None, "mode": str, "classes": list,
             "errors": int, "utc_day": str}.

    `ran` is False — and every other field is empty/zero — when it is not yet
    04:10 UTC, or when today's sweep has already been recorded. The loop ticks
    hourly and calls this every tick; the once-a-day decision lives here, in
    the job body, exactly as tow_digest does it, so the dead-man watches the
    LOOP's cadence and not the job's. Never raises.
    """

async def run_sweep(*, now=None, force_dry_run: bool = False) -> dict: ...
async def run_class(rule, *, run_id, now, live) -> dict: ...
```

**Idempotence, the same way `tow_digest` gets it.** "Today's sweep has already run" is one query against `ops_retention_runs` for a row whose `started_at` falls in the current UTC day — not a module-level flag, which a redeploy resets, and not a file, which Railway's ephemeral filesystem eats. The advisory lock from `job_locks.run_locked` makes the check-then-write safe across replicas.

- [ ] **Step 1: The mode decision, in one function, with the belt and the braces separate.**

```python
def _mode(*, force_dry_run: bool) -> str:
    """'live' only when the master switch is on and nobody asked otherwise.

    Two independent noes. `force_dry_run` is the caller's (POST
    /ops/retention/dry-run passes it so an operator can ask "what would you do
    tonight?" without arming anything); `retention_enabled` is the
    deployment's. Either one is enough to keep the sweep counting instead of
    cutting.
    """
    if force_dry_run:
        return "dry_run"
    return "live" if get_settings().retention_enabled else "dry_run"
```

- [ ] **Step 2: The per-class body.** Shape:

1. `SELECT` the rule's `count_sql` with `:cutoff` (+ `**rule.extra_params`) → `candidates`, `protected`, `oldest`. **Always**, in both modes: the count is the dry run's whole product and the live run's before-picture.
2. If `mode == "dry_run"`: write the `ops_retention_runs` row with `affected = 0` and return. The migration's CHECK constraint makes that a database-enforced promise, not a code convention.
3. If `mode == "live"`: loop up to `retention_max_batches_per_class` times. Each iteration is its own transaction on `database.ops_engine`:

```python
async with database.ops_engine.begin() as conn:
    await conn.execute(text("SET LOCAL statement_timeout = :ms"),
                       {"ms": settings.retention_statement_timeout_ms})
    result = await conn.execute(
        text(rule.mutate_sql),
        {"cutoff": cutoff,
         "batch": settings.retention_batch_size,
         **rule.extra_params},
    )
    ids = result.scalars().all()
```
   Stop when a batch returns fewer than `batch_size` rows. If the loop exits with the batch cap reached, set `truncated = true`.
4. Wrap the whole class in `try/except` — **one class failing must not stop the others.** Record the exception in `ops_retention_runs.error` via `alerts.redact_text(str(exc), limit=1000)` and count it in the run's `errors`.

- [ ] **Step 3: Object deletion for B4/B5/B6, in the only safe order.**

For a rule with `kind == "delete_objects"`, the R2 object and the column are two mutations and they can fail independently. The order is fixed and it is: **delete the object first, then null the column.**

```python
# Object first, column second. If the object delete succeeds and the column
# update then fails, the next night's candidate query still finds the row and
# retries — deleting an already-absent R2 key is a no-op, so the retry is
# free. The other order strands the object forever: the column is null, so the
# row is no longer a candidate, and nothing anywhere else knows the key.
# An orphaned R2 object holding a photograph of a driving licence is the exact
# outcome this policy exists to prevent.
```
`services/storage.delete_snapshot(key)` already swallows and logs its own failure and returns a bool — check it, and skip the column update when it is `False`.

- [ ] **Step 4: The anomaly finding.** Compare tonight's `candidates` against the median of the last 7 runs for the same class (one query against `ops_retention_runs`). File **one** `ops_findings` row via `findings.record_batch_and_notify("retention_sweep", …)` with stable fingerprints:

| fingerprint | severity | when |
|---|---|---|
| `retention-class-truncated` | `medium` | a class hit `retention_max_batches_per_class` |
| `retention-candidates-spike` | `medium` | tonight > 10 × the 7-run median |
| `retention-class-failed` | `high` | a class raised |
| `retention-dry-run-standing` | `low` | `retention_enabled` has been false for more than 21 days — the sweep noticing that nobody came back to the decision |

Bodies carry class names, counts and ages only. No plate, no key, no phone.

- [ ] **Step 5:** Tests with a fake rule list: `run_due_sweep` returns `{"ran": False}` before 04:10 UTC and after today's row exists; dry run mutates nothing and still records counts; a rule that raises does not stop the next rule; the batch loop stops on a short batch; `truncated` is set at the cap; `force_dry_run=True` overrides `retention_enabled=True`; `extra_params` reach both the count and the mutation; the object-then-column order is asserted by call sequence.

- [ ] **Step 6:** `ruff check`, `pytest -q`, commit (`feat(retention): the nightly sweep, dry-run by default`).

---

## Task 6: Wire the sweep in as lifespan job #11

**Files:** Modify `main.py`, `services/job_registry.py`, `routers/ops.py`.

- [ ] **Step 1:** `services/job_registry.py` — add to `BACKEND_JOBS`, with the comment the dict's own docstring demands (every entry must explain its interval):

```python
    # Ticks hourly and does nothing until 04:10 UTC, the same shape as
    # plaza_reconcile and tow_digest: the loop's cadence is the heartbeat's
    # cadence, the once-a-day check lives in the job body. So the dead-man
    # notices within two hours if this loop dies, not within two days.
    #
    # 04:10 UTC puts it clear of the three deletion jobs already in that
    # window: clear_stale_violation_queue (hourly, on the hour — so it also
    # runs at 04:00), prune_camera_snapshot_diag (03:17) and
    # purge_cron_job_run_details (03:45). Ten past the hour is deliberately
    # not on the hour.
    "retention_sweep": 3600,
```

- [ ] **Step 2:** `main.py` — the loop, following `_tow_digest_loop` exactly (the closest existing sibling: hourly tick, daily body, lock, heartbeat on both paths):

```python
    # Retention sweep (Wave 2.5). Hourly tick; run_due_sweep no-ops until
    # 04:10 UTC and once a day thereafter. RETENTION_ENABLED is false in
    # production: every run counts what it would have deleted into
    # public.ops_retention_runs and mutates nothing. See docs/RETENTION.md —
    # the flag does not flip until seven nights of those counts have been read
    # by a human, and it gates the R2 lifecycle rules too.
    async def _retention_sweep_loop():
        while True:
            try:
                outcome: dict = {}

                async def _tick():
                    result = await retention_sweep.run_due_sweep()
                    outcome.update(result)
                    if result.get("ran"):
                        log.info(
                            "Retention sweep %s: mode=%s classes=%s errors=%s",
                            result["run_id"], result["mode"],
                            len(result["classes"]), result["errors"],
                        )

                if await job_locks.run_locked("retention_sweep", _tick):
                    ok = outcome.get("errors", 0) == 0
                    await job_registry.heartbeat(
                        "retention_sweep",
                        expected_interval_s=job_registry.BACKEND_JOBS["retention_sweep"],
                        ok=ok,
                        error=None if ok else f"{outcome.get('errors')} class(es) failed",
                    )
            except Exception as e:  # noqa: BLE001
                log.error(f"Retention sweep loop error: {e}")
                await job_registry.heartbeat(
                    "retention_sweep",
                    expected_interval_s=job_registry.BACKEND_JOBS["retention_sweep"],
                    ok=False, error=str(e),
                )
            await asyncio.sleep(3600)

    retention_sweep_task = asyncio.create_task(
        supervised("retention_sweep", _retention_sweep_loop))
    log.info("Retention sweep loop started (dry-run unless RETENTION_ENABLED).")
```

and `retention_sweep_task.cancel()` in the shutdown block with the other ten.

- [ ] **Step 3:** Wave 2.7 ships `tests/test_job_registry.py::test_every_lifespan_loop_has_a_registry_entry`, which walks `main.py`'s lifespan by AST and diffs the `supervised(...)` names against `BACKEND_JOBS` **in both directions**, plus `test_the_declared_intervals_match_the_sleeps_in_main`. Both will fail if Step 1 and Step 2 disagree:

```bash
.venv/bin/pytest tests/test_job_registry.py -q
```

- [ ] **Step 4:** Add to `routers/ops.py` (both platform-admin, same guard as `GET /ops/jobs`):
- `GET /ops/retention` — the last 14 runs grouped by class. This is how Task 13's go/no-go is read without a SQL client.
- `POST /ops/retention/dry-run` — calls `run_sweep(force_dry_run=True)` on demand, bypassing the once-a-day gate but never the mode gate.

- [ ] **Step 5:** `ruff check`, full `pytest -q`, commit (`feat(retention): the sweep joins the job registry as loop #11`).

---

## Task 7: One test per data class — deletes exactly the eligible rows and nothing referenced

**Files:** Create `tests/plaza/test_retention_plate_events.py`, `…_passes_pii.py`, `…_resident_plates.py`, `…_documents.py`, `…_ops_history.py`.

**These belong in `tests/plaza/`** because that package runs against a real Postgres 17 with the real schema and therefore the real foreign keys. The entire risk in this plan is what `ON DELETE CASCADE` does when nobody is looking; a test with a mocked database proves nothing about that.

Each class gets the same five-test shape. The pattern, for A2:

- [ ] **Step 1: the positive** — three reads past the cutoff referenced by nothing; run live; exactly those three gone, `affected == 3`, `candidates == 3`, `protected == 0`.
- [ ] **Step 2: the negative, one per referencing table.** This is the important one and it is six separate cases, not one:

```python
@pytest.mark.parametrize("referrer", [
    "alpr_violations",          # NO ACTION — an unguarded delete would ERROR
    "partner_truck_sightings",  # CASCADE  — would silently destroy tow evidence
    "plate_match_decisions",    # CASCADE  — would silently destroy the audit log
    "plate_sessions",           # NO ACTION — would ERROR
    "visitor_passes",           # SET NULL — would silently blank a pass's photo
    "parking_passes",           # SET NULL
])
async def test_a_referenced_read_is_never_deleted(db, referrer):
    """One case per foreign key, because the failure MODE differs per key and
    only two of the six are loud. A single combined test would pass on the two
    that raise and hide the four that do damage quietly."""
```
Each case: insert a read past the cutoff, attach exactly one referrer, run the rule live, assert the read still exists, assert `affected == 0`, assert `candidates == 0` **and `protected == 1`** (the two are disjoint — this is what pins the Task 3 Step 2 `FILTER` shape), **and assert the referrer row is still there** (the cascade cases fail this and nothing else).
- [ ] **Step 3: the boundary** — a read one second inside the cutoff survives, one second outside is a candidate.
- [ ] **Step 4: dry run mutates nothing** — same fixture as Step 1, `RETENTION_ENABLED=false`, assert the three rows still exist, `candidates == 3`, `affected == 0`, and that the `ops_retention_runs` row was written.
- [ ] **Step 5: the batch cap** — `retention_batch_size=2`, seven candidates, `retention_max_batches_per_class=2` → 4 deleted, `truncated is True`, the remaining 3 untouched and still candidates next run.

Per-class specifics:

| File | Rules | The negative that matters most |
|---|---|---|
| `test_retention_plate_events.py` | A1 (strip), A2 (row), A9, A10 | the six-way parametrize above; plus A1 must not strip a row inside the cutoff and must report **0 candidates** on a second run; plus **A9 keys on `seen_at`** — a test that inserts a `weak_plate_reads` row and asserts the rule finds it (a `created_at` assumption raises `UndefinedColumn` here, and this is the test that catches it) |
| `test_retention_passes_pii.py` | B1, B2 (`visitor_passes`), B3 | a pass whose plate has a violation with `resolved_at IS NULL` keeps its phone; a pass whose plate has a **tow-confirmed, uninvoiced** violation keeps its phone (24 such rows in production); a pass whose only violation is `dismissed` **with** a `resolved_at` **is** eligible — this is the test that pins the 864-vs-2,473 distinction; a pass still `active` keeps its phone; after nulling, `plate_text`, `property_id` and the dates are **unchanged** |
| `test_retention_resident_plates.py` | B1, B2, B4, B5, B6 on `resident_plates` | the table has **no `valid_until`**: an `active = true` row is never eligible at any age; an inactive row that was reviewed uses `reviewed_at`; an inactive row never reviewed falls back to `created_at`; a `pending` row that is still active keeps everything |
| `test_retention_documents.py` | B4, B5, B6 | the object is deleted **before** the column is nulled (assert call order against a fake storage); a failed object delete leaves the column set so the row retries next night; a document on a pass never reviewed uses the fallback clock |
| `test_retention_ops_history.py` | D2, D3 | an `open` finding is never deleted regardless of age; a `wontfix` finding is never deleted; **D3 keys on `closed_at` + `state`** — a rule that reaches for `status` or `created_at` raises here; `ops_retention_runs` sweeping itself does not delete the row it is currently writing |

Plus two cross-cutting tests:

```python
def test_every_rule_has_a_test_file():
    """A rule with no behavioural test is a rule that will delete production
    the first time its SQL is wrong."""

async def test_every_cutoff_column_exists(db):
    """Real Postgres, information_schema. Three of the twelve rules do not key
    on created_at and there is no way to know that from Python."""
```

- [ ] **Step 6:** `pytest tests/plaza/test_retention_*.py -q` (must actually run — if it reports "no PostgreSQL available", install Postgres 17 or export `TEST_DATABASE_URL` first; a skipped retention test proves nothing), then full `pytest -q`, then commit (`test(retention): one class, one file, one case per foreign key`).

---

## Task 8: R2 lifecycle rules as config — **report mode, not apply mode**

**Files:** Create `ops/r2-lifecycle/parking-snapshots.json`, `ops/r2-lifecycle/tow-clips.json`, `ops/r2-lifecycle/lotlogic-docs.json`, `scripts/apply_r2_lifecycle.py`, `tests/test_r2_lifecycle_config.py`.

**Why a file and a script.** The rule that used to exist on `parking-snapshots` was deleted in April by a click, and the only record of it is a sentence in an audit. A rule in a repo can be reviewed, diffed and restored.

**Why this task applies nothing.** An R2 lifecycle rule is enforced by Cloudflare. `RETENTION_ENABLED` cannot gate it, so the gate has to be the script's own default and the plan's task order. Applying `debug/` (14 d) or the legacy-YOLO rules (30 d) deletes matching objects the moment it lands — before anyone has seen a count. So this task ships the rules and a **report**; Task 13 applies them.

- [ ] **Step 1: `ops/r2-lifecycle/parking-snapshots.json`** — the S3 `LifecycleConfiguration` shape boto3 wants, with comments in a sibling `_comments` object that the script strips before the API call (an unknown key inside a `Rule` is rejected by the API; one at the top level is merely ignored, but stripping is explicit):

```json
{
  "_comments": {
    "debug-frames": "Sidecar empty-scene captures from bringing up a new camera model. Useful for about a fortnight. RETENTION.md A6. DESTRUCTIVE ON APPLY — Task 13 only.",
    "diag-frames": "Frames Plate Recognizer rejected, plus weak/no-plate reads. RETENTION.md A5. Nothing lives under this prefix until Task 8a ships.",
    "accepted-reads": "Every accepted plate photograph. 68,843 referenced from the database today. RETENTION.md A3.",
    "evidence": "The frame behind a filed violation, copied here at violation time by camera-snapshot so it outlives the read it came from. RETENTION.md A4 / spec fat decision 28.",
    "legacy-yolo": "services/storage.build_storage_key's prefixes. No writer since March; the YOLO pipeline is spec fat decision 3. RETENTION.md A7. DESTRUCTIVE ON APPLY — Task 13 only.",
    "legacy-flat-reads-<property>": "The back catalogue: reads written before Task 8a moved them under reads/. One rule per property UUID because that is what the old key shape allows. Nothing is 365 days old yet (the oldest object is ~5 months), so this is armed rather than immediate. Delete these rules once the oldest flat key is past its period.",
    "abort-incomplete-uploads": "A failed multipart upload is billed and invisible. This is the ONE rule safe to apply before go-live: it can only ever delete an upload that never completed."
  },
  "Rules": [
    { "ID": "debug-frames",    "Status": "Enabled", "Filter": { "Prefix": "debug/" },      "Expiration": { "Days": 14 } },
    { "ID": "diag-frames",     "Status": "Enabled", "Filter": { "Prefix": "diag/" },       "Expiration": { "Days": 90 } },
    { "ID": "accepted-reads",  "Status": "Enabled", "Filter": { "Prefix": "reads/" },      "Expiration": { "Days": 365 } },
    { "ID": "evidence",        "Status": "Enabled", "Filter": { "Prefix": "evidence/" },   "Expiration": { "Days": 730 } },
    { "ID": "legacy-yolo-snapshots",  "Status": "Enabled", "Filter": { "Prefix": "snapshots/" },  "Expiration": { "Days": 30 } },
    { "ID": "legacy-yolo-violations", "Status": "Enabled", "Filter": { "Prefix": "violations/" }, "Expiration": { "Days": 30 } },
    { "ID": "abort-incomplete-uploads", "Status": "Enabled", "Filter": { "Prefix": "" },
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 7 } }
  ]
}
```

**There is deliberately no `apt/` rule.** Apartment documents are row-driven: an ID photo's clock starts at the registration decision, not at the upload, so a date-based lifecycle rule would delete it at the wrong time. Rules B4–B6 in the sweep own those objects, and Task 12 moves them to their own bucket so the absence of a rule is not an accident waiting to be "fixed".

- [ ] **Step 2:** Generate the `legacy-flat-reads-*` rules from production's actual property UUIDs (read-only `SELECT id FROM properties`, 11 of them), 365 days each, prefix `"<uuid>/"`. Commit them; they are deleted in a follow-up once the back catalogue ages out.

- [ ] **Step 3: `scripts/apply_r2_lifecycle.py`** — three modes, and the safest is the default:

| Mode | Flag | What it does |
|---|---|---|
| **Report** | *(default)* | For each rule, `list_objects_v2` under its prefix and count how many objects are already past `Expiration.Days`, with total bytes and the oldest key's age. Prints a table and files one `ops_findings` row per rule via `POST /ops/findings/r2_lifecycle_report`. **Read-only — no `put_bucket_lifecycle_configuration`, no `delete_object`.** |
| Diff | `--diff` | `get_bucket_lifecycle_configuration`, unified diff of live-vs-file, exit 1 on drift. Usable as a CI check later. |
| Apply | `--yes` | `put_bucket_lifecycle_configuration`. **Task 13 only.** The script refuses `--yes` unless `--i-understand-this-deletes-objects` is also passed. |

It reuses `services.storage.get_r2_client()` so there is one credential path.

- [ ] **Step 4: `tests/test_r2_lifecycle_config.py`** — pure JSON tests, no network: every rule ID unique; every `Days` matches the number in `docs/RETENTION.md` §5 (parse the table, same technique as Task 1); `evidence/` ≥ `reads/` (evidence must outlive the read it was copied from); no rule has an empty `Prefix` except the multipart abort; **`--yes` is not present anywhere in this repo's CI configuration or Makefile** (a grep test — the point is that applying is a human act).

- [ ] **Step 5: Run the report and paste it into the PR.**

```bash
python scripts/apply_r2_lifecycle.py ops/r2-lifecycle/parking-snapshots.json
```

This is the first time anyone has measured what is actually in the bucket — object counts, total bytes and oldest-object age are **unverified** until this runs, because nobody reviewing this plan holds R2 credentials. Expect the report to show:
- `debug/` and `snapshots/`/`violations/` with a **non-zero** past-period count — these are the rules that delete on apply, and the report is where that number stops being a guess.
- `reads/`, `diag/`, `evidence/` and every `legacy-flat-reads-*` rule at **zero**, because the oldest object in the bucket is roughly five months old and every one of those periods is 365 days or more. (Revision 1 warned that applying the legacy rules would "delete the back catalogue on the spot". That was wrong, and the report proves it either way.)

**Do not pass `--yes`.**

- [ ] **Step 6:** commit (`feat(retention): R2 lifecycle rules as config, reported before they are ever applied`).

---

## Task 8a: Key restructure — `reads/`, `diag/`, `debug/`, and the `evidence/` copy

**Files:** Modify `supabase/functions/camera-snapshot/index.ts` (lines ~391, ~628, ~903, ~977); tests in `supabase/functions/camera-snapshot/index.test.ts`; one migration comment (no new column).

> **CLAUDE.md trigger:** editing `supabase/functions/camera-snapshot/**` auto-dispatches `feature-dev:code-explorer` + `brainstormer` + `contrarian-reviewer` in parallel **before the first edit**, and `contrarian-reviewer` + `feature-dev:code-reviewer` after the deploy. Honour it. Also diff against `mcp__supabase__get_edge_function` before overwriting — the repo drifts from the deployed runtime.

- [ ] **Step 1:** Change the four key builders (line numbers verified against `origin/main`):

| Line | Today | Becomes |
|---|---|---|
| 391 | `debug/${property_id}/${dateStr}/sidecarempty-…` | unchanged — already prefixed |
| 628 | `${property_id}/${dateStr}/diag-${api_key}-…-rejected-${reason}.jpg` | `diag/${property_id}/${dateStr}/${api_key}-${epochMs}-rejected-${reason}.jpg` |
| 903 | `${property_id}/${dateStr}/diag-…-rejected-pr_no_plate.jpg` | `diag/${property_id}/${dateStr}/${api_key}-${epochMs}-rejected-pr_no_plate.jpg` |
| 977 | `${property_id}/${dateStr}/${api_key}-${epochMs}-${plateUpper}.jpg` | `reads/${property_id}/${dateStr}/${api_key}-${epochMs}-${plateUpper}.jpg` |

Extract a single `objectKey(kind, property_id, dateStr, rest)` helper so a fifth writer cannot invent a sixth shape.

- [ ] **Step 2: the `evidence/` copy.** At the point the function inserts an `alpr_violations` row, copy the triggering frame:

```
evidence/{property_id}/{violation_id}.jpg
```

A **copy** (R2 `CopyObject` — no re-upload of the bytes), fire-and-forget with its own try/catch, because a failed evidence copy must not fail the violation. Log a warning and let the read's own 365-day copy be the fallback.

**Store the evidence key in the existing `alpr_violations.evidence_photo_url` column. Do not add a column.** That column already exists, is NULL on all 2,494 rows, and is read by no code in either repo — it is exactly the column this needs, and a thirteenth beside it is the fat this programme exists to stop. Ship a migration that carries only a `COMMENT ON COLUMN` recording the new meaning (and note that despite the `_url` suffix it now holds a *key*, resolved through the same presign path as everything else).

- [ ] **Step 3:** `plate_events.image_url` keeps pointing at the read object. Nothing is rewritten; the 68,843 existing flat keys stay valid and are covered by the `legacy-flat-reads-*` lifecycle rules.

- [ ] **Step 4:** Deno tests for all four key shapes and the copy; deploy with `supabase functions deploy camera-snapshot`; watch one live frame land under `reads/`.

- [ ] **Step 5:** commit (`feat(retention): prefix camera frames by kind so lifecycle rules can reach them`).

---

## Task 9: The `plate-snapshots` Storage bucket

**Files:** Create `migrations/$(date -u +%Y%m%d%H%M%S)_storage_buckets_private.sql`.

Measured: `plate-snapshots` is **public**, holds **0 objects**, and is referenced by **zero lines** of code in either repo. `tow-evidence` is private, 0 objects, 0 references. Both were created for designs that went to R2 instead.

**This is one of the two production mutations in Tasks 1–12** (see the header). It changes one boolean on a bucket with nothing in it.

- [ ] **Step 1:** Migration:

```sql
-- Wave 2.5 — Supabase Storage: two buckets, no objects, no readers, one of
-- them public.
--
-- Measured 2026-09-14: storage.objects is EMPTY for both buckets and neither
-- bucket name appears anywhere in lotlogic or lotlogic-backend. They are
-- leftovers from designs that ended up on Cloudflare R2. `plate-snapshots`
-- being public is therefore harmless today and a loaded gun tomorrow: the
-- next person to reach for a Supabase bucket for a photo finds one already
-- created, already public, already named after plates.
--
-- Private, not dropped. Dropping a bucket is irreversible through this API
-- and the cost of keeping two empty private rows is zero; a DROP is a
-- separate decision with a separate approval (RETENTION.md §5).
--
-- No COMMENT ON anything in the `storage` schema: those objects are owned by
-- `supabase_storage_admin` and the `postgres` role this migration runs as is
-- not a member, so a COMMENT statement fails the whole migration. The note
-- above is the documentation.

UPDATE storage.buckets SET public = false WHERE id = 'plate-snapshots';

-- Rollback:
-- UPDATE storage.buckets SET public = true WHERE id = 'plate-snapshots';
```

- [ ] **Step 2:** Apply via the Supabase MCP; verify `SELECT id, public FROM storage.buckets;` → both `false`.
- [ ] **Step 3:** commit (`chore(retention): the two empty Supabase Storage buckets are private`).

---

## Task 10: Presigned photo URLs everywhere a public r2.dev URL is served today

**Files:** Modify `routers/alpr.py` (or a new `routers/photos.py` if `alpr.py` has no natural home); modify the frontend modules listed below; test `tests/plaza/test_photo_presign.py`.

### Where a public r2.dev URL is served today — audited against `origin/main`

**Wave 2.6 has landed.** `frontend/dashboard.html` is now **2,335 lines and contains zero `image_url` references**; the dashboard is ES modules under `frontend/src/`, built by esbuild (`frontend/package.json` → `node scripts/build.mjs`). Revision 1's audit pointed at a 14,856-line single file with line numbers from an uncommitted branch — all of it stale. The real surfaces, 41 references across 10 files:

| File | Hits | What it does |
|---|---|---|
| **`frontend/src/lib/db.js`** | **20** | **The chokepoint.** Every PostgREST read that joins or selects `image_url`: pass lists (`first_seen_image_url` flattening, ×2), the violation queue (×3), recent reads, the frame inspector, single-read lookup, the read stream, paired-gate snapshots |
| `frontend/src/pages/TrainingPage.jsx` | 10 | selects `image_url`, renders it, and gates its keyboard handlers on it |
| `frontend/src/ui/passPhotos.jsx` | 7 | `first_seen_image_url` + a fallback `ev.image_url`; reserves layout on its presence |
| `frontend/src/pages/ALPRPropertyDetailPage.jsx` | 7 | property-level read and violation galleries |
| `frontend/src/pages/TowActivityPage.jsx` | 5 | tow evidence thumbnails |
| `frontend/src/ui/CrossCameraSightings.jsx` | 4 | `<a href>` + `<img src>` per sighting |
| `frontend/src/pages/ConfirmationReview.jsx` | 3 | plate + truck event images in the review queue |
| `frontend/tuner.html` | 3 | standalone tuning page |
| `frontend/src/pages/JobsPage.jsx` | 1 | one reference |
| `frontend/src/lib/bundle.js` | 1 | truck-plaza vehicle-event bundling — a *comment*, check before touching |

**That `db.js` holds 20 of the 41 is the good news in this task**: the data layer is one file, so the presign helper lands once and most render sites need only to stop expecting a URL where they now get an id.

| Already correct — do not change | Why |
|---|---|
| `routers/apartment_docs.py` | authenticated streaming proxy, `Cache-Control: private, no-store`. Only the bucket moves (Task 12) |
| `routers/ops.py:527` tow clip | 15-minute presign from an **already-private** bucket (`TOW_CLIPS_BUCKET` is set) |
| `supabase/functions/tow-dispatch-email` | **Task 11** owns it |

- [ ] **Step 1: the endpoint.**

```python
@router.get("/plate-events/{event_id}/photo")
async def get_plate_event_photo(
    event_id: uuid.UUID = Path(...),
    subject: Subject = Depends(require_subject),
    db: AsyncSession = Depends(get_db),
):
    """A 15-minute presigned URL for one plate read's photograph.

    JSON, not a 302, for the same reason GET /ops/tow-sightings/{id}/clip is
    JSON (controller ruling R9): a browser navigation cannot carry the bearer
    token require_subject needs, so a redirect would 401 before it reached R2.
    The dashboard fetches this with its authenticated client and opens the url
    it gets back.

    Scope-checked against the read's property through services.scope — the
    helper used at 55 other call sites. Wave 1 item 5 is the precedent: two
    photo endpoints sat behind the login wall and never asked whether that
    login owned the lot, and photo ids were sequential.

    Cache-Control: private, no-store — an intermediary must not hold a URL
    that is dead in fifteen minutes, and must not hold a photograph at all.
    """
```

It reads `image_key` (falling back to deriving it from `image_url` by stripping `settings.r2_public_url`), calls `storage.get_presigned_url(key, expires_in=900)`, and returns `{"url", "expires_at"}` with `Cache-Control: private, no-store`.

- [ ] **Step 2: stop storing the public URL — additively, and batched.**

Add `plate_events.image_key text` (nullable, additive, no FK). Then backfill it. **This is the second of the two production mutations in Tasks 1–12** and the plan's one large write, so:

- **Batched at 5,000 rows**, not one statement. ~68,843 rows on the hottest table in the schema, which the camera pipeline is writing to continuously; a single unbounded `UPDATE` takes a snapshot-wide lock footprint and is exactly the shape that wedged the pool on 2026-09-04.
- `SET LOCAL statement_timeout` on every batch.
- **The base URL is an inlined literal, not a bind parameter.** A migration file carries no bind params; `:public_base` in a `.sql` file is either a syntax error or asyncpg treating it as a literal colon-string. The value is `https://pub-2b67cfea48564c9695230f8909348716.r2.dev`, measured from production (100% of 68,843 rows), and the migration says so in a comment.

```sql
-- Backfill plate_events.image_key from image_url, 5,000 rows at a time.
--
-- The base URL below is inlined rather than parameterised because a migration
-- file carries no bind parameters. It is the value on 100% of the 68,843 rows
-- carrying an image_url, measured 2026-09-14:
--   SELECT DISTINCT substring(image_url from '^https?://[^/]+') FROM plate_events;
--   -> https://pub-2b67cfea48564c9695230f8909348716.r2.dev   (one row)
-- If that ever returns more than one row, this DO block must grow a CASE.
DO $backfill$
DECLARE
    touched integer;
BEGIN
    LOOP
        SET LOCAL statement_timeout = '20s';
        WITH batch AS (
            SELECT id FROM public.plate_events
             WHERE image_url IS NOT NULL AND image_key IS NULL
             LIMIT 5000
             FOR UPDATE SKIP LOCKED
        )
        UPDATE public.plate_events t
           SET image_key = replace(
                   t.image_url,
                   'https://pub-2b67cfea48564c9695230f8909348716.r2.dev/', '')
          FROM batch b
         WHERE t.id = b.id;
        GET DIAGNOSTICS touched = ROW_COUNT;
        EXIT WHEN touched = 0;
        COMMIT;   -- one transaction per batch; requires a procedural context
    END LOOP;
END
$backfill$;
```

New writes in `camera-snapshot` set both `image_url` and `image_key` for one release. **`image_url` is not dropped in this plan** — Wave 2.6's modules are the readers and a follow-up retires it once nothing reads it.

- [ ] **Step 3: the frontend.** Add one helper in `frontend/src/lib/db.js`, beside the existing `apiFetch` usage:

```js
// One place a photo URL is minted. Every `<img src>` and `<a href>` that used
// to take plate_events.image_url straight out of Supabase now goes through
// here: an authenticated fetch for a 15-minute presign, memoised per event id
// for 10 minutes so a list of 50 reads is 50 rows and not 50 round trips
// repeated on every re-render.
export async function photoUrl(eventId) { … }
```

Then, in order:
1. **`db.js` first** — change the 20 references: the select lists fetch the event **id** instead of `image_url`, and the two `first_seen_image_url` flattenings return `first_seen_event_id` instead. This is the change that makes the other nine files' work mechanical.
2. The seven render modules (`TrainingPage.jsx`, `passPhotos.jsx`, `ALPRPropertyDetailPage.jsx`, `TowActivityPage.jsx`, `CrossCameraSightings.jsx`, `ConfirmationReview.jsx`, `JobsPage.jsx`) — resolve lazily when a thumbnail actually renders. `passPhotos.jsx`'s layout reservation (it reserves row height on `first_seen_image_url` being truthy) switches to reserving on the **id** being present, so the synchronous reservation it was designed for still works.
3. `tuner.html` — standalone, 3 references.
4. `bundle.js` — check whether its single hit is the comment it appears to be; if so, leave it.
5. `npm run build` and confirm the built output is regenerated.

- [ ] **Step 4: tests.** `tests/plaza/test_photo_presign.py`: owner A cannot presign owner B's read (the cross-tenant assertion); an unauthenticated call is 401; the response carries `private, no-store`; a read with no photo is 404; the presign TTL is 900 s; a row with `image_key` set and a row with only `image_url` both resolve. Add the matching cross-tenant assertion to `tests/e2e/access-control.spec.ts` — CLAUDE.md requires the backend route and the Playwright spec to land in the same PR.

- [ ] **Step 5:** commit (backend and frontend separately — two repos).

---

## Task 11: The tow-dispatch email — a 48-hour presign

**Files:** Modify `supabase/functions/tow-dispatch-email/index.ts` (lines 207, 380, 393–400 — verified against `origin/main`).

The partner's email is the one photo consumer that genuinely cannot authenticate. It currently embeds the permanent public URL, which is why turning the public domain off would silently break every tow email ever sent.

- [ ] **Step 1:** Mint an S3 v4 presigned GET inside the edge function with the R2 credentials it already holds (`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_ACCOUNT_ID` / `R2_BUCKET_NAME`), TTL **172800 s (48 h)** — deliberately the same TTL as the HMAC action token the same email already mints for its Tow / No-Tow buttons. One expiry for the whole message: when the decision expires, so does the evidence link.

- [ ] **Step 2:** Replace both uses — the plain-text `PHOTO  {url}` line (:380) and the `<img src>` (:400). The alt text and layout do not change.

- [ ] **Step 3:** Add a line under the photo: *"This link expires in 48 hours — reply or use the dashboard after that."* An expired image in an old email should read as designed, not broken.

- [ ] **Step 4:** Deno test that the generated URL carries `X-Amz-Expires=172800` and a signature, and that a missing photo still renders the rest of the email (the existing `triggerEvent?.image_url ? … : null` guard shape is preserved).

- [ ] **Step 5:** Deploy (`supabase functions deploy tow-dispatch-email`), send one test dispatch with `EMAIL_OVERRIDE_TO` set to your own address, open the photo, then confirm it 403s after the TTL in a follow-up check. Commit.

---

## Task 12: Copy-only — the private documents bucket

**Files:** `config.py` (`r2_docs_bucket`), `routers/apartment_docs.py`, Railway variables, Cloudflare R2.

**This is a join. Do not start it until Tasks 8a, 10 and 11 are deployed and verified in production.**

**Nothing here deletes anything.** Originals stay where they are; the public domain stays on; the lifecycle rules stay unapplied. All three of those are Task 13, behind the flag.

- [ ] **Step 1:** Create one private R2 bucket: `lotlogic-docs`. No public domain. (`TOW_CLIPS_BUCKET` already exists, is already private and is already in use — revision 1 claimed otherwise and built two steps on it; both are withdrawn.)

- [ ] **Step 2:** Add `Settings.r2_docs_bucket: str = ""`, defaulting to `r2_bucket_name` at the call site exactly like `tow_clips_bucket` does, so nothing breaks before the variable is set. Point `routers/apartment_docs.py`'s `upload_bytes` / `download_bytes` at it.

- [ ] **Step 3: Copy, do not move.** `CopyObject` all 319 `apt/` objects from `parking-snapshots` to `lotlogic-docs`. Verify each one: `head_object` on both sides, compare `ContentLength` and `ETag`, and fetch three through the authenticated proxy end-to-end. **Leave the originals in place.** Set `R2_DOCS_BUCKET=lotlogic-docs` on Railway; the proxy now reads from the private bucket while the originals sit untouched as a rollback.

- [ ] **Step 4: Apply the one safe lifecycle rule.**

```bash
python scripts/apply_r2_lifecycle.py ops/r2-lifecycle/parking-snapshots.json \
    --only abort-incomplete-uploads --yes --i-understand-this-deletes-objects
```

`AbortIncompleteMultipartUpload` can only ever delete an upload that never completed — there is no object to lose. Every other rule in that file waits for Task 13.

- [ ] **Step 5: Re-run the report** now that `reads/`, `diag/` and `evidence/` have real objects under them (Task 8a has been live for a while by this point):

```bash
python scripts/apply_r2_lifecycle.py ops/r2-lifecycle/parking-snapshots.json
python scripts/apply_r2_lifecycle.py ops/r2-lifecycle/tow-clips.json
```

Paste both into the PR. These counts are Task 13's input.

- [ ] **Step 6:** Update RETENTION.md §2's object-storage table with the first real object counts. Commit.

---

## Task 13: Go-live — the only task that destroys anything

**This is Gabe's decision, executed by Gabe or with his explicit go-ahead. An agent must not flip `RETENTION_ENABLED`, must not pass `--yes`, and must not delete a copied original.**

Everything destructive in this programme happens here, in this order.

### Part A — read the evidence

- [ ] **A1:** Task 6 has been deployed for **seven consecutive nights** with `RETENTION_ENABLED=false`. Confirm seven runs exist:
```sql
SELECT date_trunc('day', started_at)::date AS night, count(DISTINCT run_id) runs, count(*) class_rows
  FROM public.ops_retention_runs GROUP BY 1 ORDER BY 1;
```
- [ ] **A2:** Read the counts per class and check each against this plan's measured inventory:
```sql
SELECT data_class, policy_ref, max(candidates) candidates, max(protected) protected,
       min(oldest_candidate_at)::date oldest, bool_or(truncated) truncated
  FROM public.ops_retention_runs
 WHERE started_at > now() - interval '8 days'
 GROUP BY 1, 2 ORDER BY 1;
```
  Expected on night one, from the 2026-09-14 measurements:

  | `data_class` | expected `candidates` | note |
  |---|---|---|
  | `plate_event_raw_json` (A1) | ≈ 27,297 | `protected` is 0 by design — A1 has no reference guard |
  | `plate_event_row` (A2) | **0** | nothing is 730 days old; the rule is armed for 2028. A non-zero number here is a cutoff bug |
  | `weak_plate_read` (A9) | **17,329** | the whole table |
  | `plate_match_decision` (A10) | ≈ 223 | |
  | `guest_pass_contact` (B1/B2) | ≈ 2,142 | |
  | `resident_plate_contact` (B1/B2) | low single digits | 9 rows in the table, 6 active |
  | `payment_contact` (B3) | **0** | the oldest payment is 12 days old; 13 months away |
  | `id_doc` / `lease_doc` / `pass_plate_photo` (B4/B5/B6) | small double digits | |
  | `retention_run_history` (D2) | 0 | the table is 7 days old |
  | `closed_finding` (D3) | **0** | zero findings are closed today |

  **A class whose count is wildly different from this is a bug in the rule, not a surprise in the data — stop and find it.**
- [ ] **A3:** Confirm `protected > 0` for `plate_event_row`. A guard that never fires is a guard nobody has tested against production shapes. (Expected ≈ 711 once the 730-day cutoff has anything to filter; before then, confirm it on a `tests/plaza` fixture instead.)
- [ ] **A4:** Confirm `ops_findings` has no open `high` finding from `retention_sweep`.
- [ ] **A5:** Read the R2 report from Task 12 Step 5. The `debug/` and legacy-YOLO numbers are the objects Part C deletes.
- [ ] **A6:** Gabe answers the 15 questions in `docs/RETENTION.md` §7. Any "no" changes a `Settings` default or drops a lifecycle rule, is committed, deployed, and adds **three more dry-run nights** for the classes that changed.

### Part B — arm the row sweep

- [ ] **B1:** Set `RETENTION_ENABLED=true` on Railway.
- [ ] **B2:** Watch the first live run:
```sql
SELECT * FROM ops_retention_runs WHERE mode='live' ORDER BY started_at DESC LIMIT 20;
```
  Confirm `affected` matches the previous night's `candidates` within a few percent, and that `protected` has not moved.
- [ ] **B3:** Spot-check three classes by hand: a stripped `plate_events.raw_data` has exactly the 12 keys; a blanked pass still has its plate, property and dates; `weak_plate_reads` is empty.

### Part C — arm object storage (gated on B being clean, and on decisions 5, 6 and 14)

- [ ] **C1:** Apply the lifecycle rules, one bucket at a time, reading the report's expected-deletion count out loud before each:
```bash
python scripts/apply_r2_lifecycle.py ops/r2-lifecycle/parking-snapshots.json --yes --i-understand-this-deletes-objects
python scripts/apply_r2_lifecycle.py ops/r2-lifecycle/tow-clips.json          --yes --i-understand-this-deletes-objects
```
  `debug/` (decision 6) and the legacy-YOLO rules delete on apply. `reads/`, `diag/`, `evidence/` and the `legacy-flat-reads-*` rules delete nothing yet — nothing in the bucket is 365 days old.
- [ ] **C2:** Verify with `get_bucket_lifecycle_configuration` on each bucket, and re-run the report: every rule's past-period count should now be 0 or falling.
- [ ] **C3:** **Delete the copied originals.** Only now, and only after `head_object` confirms the `lotlogic-docs` copy of each key: delete the 319 `apt/` objects from `parking-snapshots`.
- [ ] **C4:** **Turn off the `pub-2b67cfea48564c9695230f8909348716.r2.dev` public domain** on `parking-snapshots` (decision 14). Then verify, in this order:
  1. `curl -sI https://pub-2b67cfea48564c9695230f8909348716.r2.dev/<a known read key>` → **403/404**, not 200/206.
  2. Dashboard: thumbnails still render (Task 10).
  3. A fresh tow dispatch email: photo still renders (Task 11).
  4. `GET /ops/tow-sightings/{id}/clip`: still resolves.
  5. An apartment document through the proxy: still resolves from `lotlogic-docs`.

### Part D — close it out

- [ ] **D1:** Remove the `> **STATUS: DRAFT — not in force.**` banner from `docs/RETENTION.md`, add the change-log row with the date the flag flipped, update §2's object-storage table with post-apply counts, commit.

---

## Decisions for Gabe

Each is one yes/no. **Execution can proceed through Tasks 1–12 in dry-run mode without any of these being answered** — the sweep counts and records, the lifecycle rules are reported but not applied, and nothing is deleted or moved. They are needed before Task 13 only.

1. **Plate-read vendor JSON.** The camera vendor's raw payload — bounding boxes, MMC probability tables, retired-sidecar diagnostics — sits on all 72,553 plate reads, ~66 MB, 67 keys each. → *Strip it after 90 days to the 12 fields we match on (plate, time, camera, photo and match all survive)?* **Recommended: yes.**
2. **Plate-read rows.** 72,553 reads; ≈26,586 of the 27,297 older than 90 days are referenced by no violation, session, tow sighting, pass or match decision. Nothing is yet 730 days old. → *Delete an unreferenced plate read at 24 months?* **Recommended: yes** (this arms it for 2028).
3. **Accepted plate photographs in R2.** 68,843 referenced from the database, kept forever since the lifecycle rule was deleted in April. → *Delete an accepted plate photo at 12 months?* **Recommended: yes.**
4. **Evidence photographs.** The frame behind a violation you invoiced for, copied to its own prefix so it outlives rule 3 (spec fat decision 28 asked 12 / 24 / forever). → *Keep evidence photos 24 months?* **Recommended: yes.**
5. **Diagnostic and rejected frames in R2.** Frames Plate Recognizer threw away; the material for tuning a badly-reading camera. → *Delete at 90 days?* **Recommended: yes.**
6. **Debug frames in R2.** Empty-scene captures from bringing up a new camera model. **This is one of two rules that deletes objects the moment it is applied** — Task 12's report says exactly how many. → *Delete at 14 days?* **Recommended: yes.**
7. **Weak plate reads.** 17,329 rows, nothing written since 19 May, 100% older than 90 days. → *Delete at 90 days — which clears the whole table on night one?* **Recommended: yes.**
8. **Driver phone numbers and emails.** 3,063 of 3,099 passes carry a phone; 2,142 of those passes ended more than 30 days ago and are no longer active. The pass row itself survives; only the contact columns are blanked. → *Blank the phone and email 30 days after the pass ends?* **Recommended: yes.**
9. **Payment contact phone.** All 10 plaza payments carry one, attached to a financial record you may need for a chargeback. `plaza_payments` stays a never-swept table; this one column is the single whitelisted exception. → *Blank it at 13 months, keeping the payment row itself for 7 years?* **Recommended: yes.**
10. **Government-ID photographs.** 319 of them (314 guest, 5 resident), kept forever today, in a bucket with a public domain. → *Delete the ID photo 30 days after the registration is approved or rejected — pass end + 30 for one never reviewed?* **Recommended: yes.**
11. **Signed leases.** 5 of them, kept forever. → *Delete the lease 90 days after approval?* **Recommended: yes.**
12. **Plate photographs on a pass.** 319 of them. → *Delete 90 days after the pass ends?* **Recommended: yes.**
13. **Tow footage and archived clips.** Footage retention is already live and correct (`TOW_FOOTAGE_RETENTION_DAYS=10` plus per-camera overrides — north card ≈ 2.3 d, south ≈ 32 d), and the clips are already in a private bucket. → *Leave the footage overrides exactly as they are, and give an archived clip the same 24 months as rule 4?* **Recommended: yes.**
14. **The public photo domain.** `pub-2b67cfea48564c9695230f8909348716.r2.dev` is the permanent address of every plate photo, every apartment ID and every lease in `parking-snapshots`. → *Turn it off once the dashboard modules and the tow email are on presigned URLs (Tasks 10 and 11)?* **Recommended: yes.**
15. **Arming everything.** Flipping `RETENTION_ENABLED` is what arms the row sweep **and** authorises the R2 lifecycle rules and the deletion of the originals already copied to `lotlogic-docs`. → *Run the sweep in dry-run for seven nights, then flip it if the counts match this plan's measured inventory?* **Recommended: yes.**

---

## Revision 2 — what the pre-flight changed

| # | Defect | Fixed how |
|---|---|---|
| **D1** | `plaza_payments` was both swept (B3) and never-swept (§3.E) — Task 3's invariant test would have failed on its own rule | Invariant narrowed to `rule.kind in DESTRUCTIVE_KINDS`; added `ALLOWED_COLUMN_NULLING = {"plaza_payments": {"phone"}}` and a **second** test asserting any rule touching a never-swept table nulls only whitelisted columns. Global Constraints and RETENTION.md §3.E rewritten to state both halves |
| **D2** | Task 6 called `run_due_sweep()`, which Task 5 never built | Task 5's interface block now specifies `run_due_sweep(*, now) -> {"ran", "run_id", "mode", "classes", "errors", "utc_day"}`, mirroring `tow_digest.run_due_digest`, with the once-a-day idempotence keyed on an `ops_retention_runs` row in the current UTC day |
| **D3** | Task 10 audited a 14,856-line `dashboard.html` with line numbers from an uncommitted branch; `origin/main` has 2,335 lines and zero `image_url` | Re-audited against `origin/main`: 41 references across 10 ES-module files, table by file with hit counts, `frontend/src/lib/db.js` (20 hits) named as the chokepoint and sequenced first. Stale line numbers deleted |
| **D12** | Task 12 applied R2 lifecycle with `--yes` and deleted copied originals — both before the flag, and lifecycle is enforced by Cloudflare, not by `RETENTION_ENABLED` | New "one safety rule" header section. `apply_r2_lifecycle.py` defaults to **report mode**; `--yes` also requires `--i-understand-this-deletes-objects`; Task 12 is copy-only and applies only `AbortIncompleteMultipartUpload`; all destructive applies and the original-deletion move to Task 13 Part C |
| **D4** | `RetentionRule` had no parameter bag, so Task 4's `:keep` binding had nowhere to live | `extra_params: Mapping[str, Any] = field(default_factory=dict)` added to the dataclass and threaded through Task 5's count and mutate calls; `RAW_DATA_KEEP_KEYS` changed from tuple to **list** so asyncpg binds it as an array |
| **D5** | `_A2_COUNT`'s `candidates` was a bare `count(*)`, so it included `protected` — contradicting the migration's column comment and Task 13's expected numbers | `count(*) FILTER (WHERE guard)` for `candidates` and `min(...) FILTER (WHERE guard)` for `oldest`; migration comment now states `candidates + protected = everything past the cutoff`; Task 7 Step 2 asserts the two are disjoint |
| **D6** | Task 9's `COMMENT ON TABLE storage.objects` fails — that schema is owned by `supabase_storage_admin` and `postgres` is not a member | Statement deleted; the reasoning moved into the migration's header comment, with a note saying why there is no `COMMENT ON` |
| **D7** | Task 10's backfill used `:public_base`; migrations carry no bind parameters | Base URL inlined as a literal with the measuring query in a comment; backfill rewritten as a `DO` block batched at **5,000 rows** with `SET LOCAL statement_timeout` and `FOR UPDATE SKIP LOCKED` |
| **D8** | `resident_plates` had no rule, guard or test, despite holding 5 leases and 5 government IDs | New `_RESIDENT_PLATE_NOT_OPEN` guard (keys on `active` / `status` / `COALESCE(reviewed_at, created_at)` — the table has **no `valid_until`**); B1/B2/B4/B5/B6 split into separate per-table rules; new `tests/plaza/test_retention_resident_plates.py`; scope call 9 records the decision |
| **D9** | Task 8a both added `evidence_key` and said to reuse `evidence_photo_url` | New-column sentence deleted; the task now reuses `evidence_photo_url` (exists, NULL on all rows, read by no code) and ships only a `COMMENT ON COLUMN`. Scope call 8 records why |
| **D10** | Task 1's module-level `pytestmark` skipped all four tests when the document was absent, so the FAT-20 regression never ran in backend CI | `skipif` moved onto the two document-parsing tests only; `test_the_fake_policy_setting_is_gone` and `test_the_master_switch_ships_off` now run everywhere, with a docstring saying why |
| **D13** | "2,472 unresolved violations" was `status <> 'resolved'`, which counts 2,466 dismissals | Corrected to **864** (`resolved_at IS NULL`) in the plan inventory, RETENTION.md §2/§4 and the `_GUEST_PASS_NOT_OPEN` comment, with the full status distribution (`dismissed` 2,466 / `resolved` 22 / `dispatched` 7 / **`open` 0**) and an explicit note that a guard keyed on `status = 'open'` matches nothing |
| **D14** | `TOW_CLIPS_BUCKET` was called unset; it **is** set on Railway production | Finding withdrawn everywhere: plan inventory, RETENTION.md §2 table, §3.C "Open gap" (now "C2/C3 are closed, not open"), scope call 4, and Task 12 — which loses two steps. The "warning on every presign" and "the presign is decorative" claims are deleted |
| **D15** | Rules assumed `created_at`, which does not exist on `weak_plate_reads` or `ops_findings` | `cutoff_column` added to `RetentionRule` with a table naming all three exceptions (A9 → `seen_at`, D3 → `closed_at` + `state='closed'`, D2 → `started_at`); a real-Postgres `information_schema` test asserts every rule's column exists; Task 7 adds a per-table case for each |
| **D11** | Task 8 Step 5 warned that applying the legacy-flat rules would "delete the back catalogue on the spot" — nothing is 365 days old | Corrected: Step 5 now states which rules genuinely delete on apply (`debug/`, legacy-YOLO) and which are armed-but-idle, and the report mode measures it either way |
| **D16** | Worktree preamble said `/Users/gabe/lotlogic-backend` was 124 commits behind; it is at `origin/main` and clean, and has no `.venv` | Preamble corrected; a `python3.11 -m venv .venv && pip install` step added as the first command in the new worktree, since every `pytest` line assumes one |
| **D17** | `SNAPSHOT_RETENTION_HOURS` is still set on Railway | Task 1 Step 3 now removes the Railway variable alongside the field, with a note that pydantic-settings 2.11's `extra='forbid'` would not have caught it |
| **D18** | 04:10 UTC was called the third deletion job in the window; `clear_stale_violation_queue` runs hourly so it is the fourth. `plate_sessions` was called dead | `BACKEND_JOBS` comment lists all four jobs; scope call 2 and RETENTION.md §2 record that pg_cron `plate_sessions_sweep` writes `plate_sessions` every 3 minutes and that it is excluded for a different reason |
| **D19** | Task 1 Step 4 claimed CI reads the policy "via a checked-in copy path"; it skips | Wording corrected — the two document tests skip, the two code tests do not, and the expected output line says `2 passed / 2 skipped`, **never 4 skipped** |
