# Wave 2.5 — Retention Policy, Written Down Then Implemented

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every class of data LotLogic holds has a written period, one nightly job that enforces it, and lifecycle rules committed as files rather than clicked in a dashboard — and no photograph of a vehicle, a driving licence or a lease is addressable by an unauthenticated URL.

**Architecture:** One policy document (`docs/RETENTION.md`) is the source of truth for *what* and *why*; `config.Settings` carries every period as an environment variable so a number changes without a deploy; a test parses the policy table and fails when the two disagree. The enforcement is one `services/retention.py` module holding a list of `RetentionRule` objects — each a name, a count query, a mutation query and a shared "referenced or open" guard — driven by `services/retention_sweep.py`, which runs as the eleventh lifespan loop under Wave 2.7's `job_locks.run_locked` + `job_registry.heartbeat` contract. It writes per-class counts to a new `ops_retention_runs` table **and nothing else** until `RETENTION_ENABLED` is true. Object storage is governed separately: R2 lifecycle JSON applied by `scripts/apply_r2_lifecycle.py`, and a Supabase migration for the two (empty, unreferenced) Storage buckets. Finally, the public r2.dev domain stops being how a photo is served: the dashboard fetches a 15-minute presign from a scope-checked endpoint, and the tow-dispatch email embeds a 48-hour presign matching its own action-token TTL.

**Tech Stack:** Python 3.11, FastAPI, SQLAlchemy 2 async + asyncpg, boto3 (already a dependency, `services/storage.py`), Supabase Postgres 17 behind a supavisor **SESSION-mode** pooler, pytest + pytest-asyncio (strict), ruff 0.16.5 (`select = ["E4","E7","E9","F"]`), Railway deploy from `main`, Supabase edge functions (Deno) + pg_cron, Cloudflare R2 (S3 API).

**Spec:** `/Users/gabe/lotlogic/docs/superpowers/specs/2026-09-03-enterprise-readiness-program.md` — §3 Wave 2 row **2.5**, findings **SEC-11** (no retention policy for plates, photos, phones, IDs or leases), **DB-5** (nothing ever deletes anything and nobody watches the DB grow), **FAT-20** / **PIPE-17** (camera snapshots kept forever in R2; `snapshot_retention_hours = 24` is read by zero lines of code), §2 item 14, and §4 fat decision **28** (the evidence period question).

**Policy document this plan writes and then implements:** `/Users/gabe/lotlogic/docs/RETENTION.md` (draft, committed by Task 1).

---

## Dependency: Wave 2.4 must be merged first

**This plan is hard-gated on Wave 2.4 (`docs/superpowers/plans/2026-09-05-wave2-4-schema-baseline.md`) being merged to `origin/main`.** That plan's own header says so from the other side: *"**Blocks:** Wave 2.1 (`properties.config`) and Wave 2.5 (retention deletes). Neither may start before Task 7 is green."*

The reason is not ceremony. This plan is the first thing in the history of the codebase that issues a `DELETE` against production tables. Wave 2.4 is what makes the schema rebuildable from files, gives migrations one canonical directory and one runner, and adds the CI drift check that proves a migration file and an applied record exist for each other. Deleting rows on a schema that exists only in production, whose 37 applied migrations have no file, is how a bad `DELETE` becomes unrecoverable.

**Status measured 2026-09-14:** `origin/wave2/schema-baseline` is **NOT** an ancestor of `origin/main` (`git merge-base --is-ancestor` → false). Wave 2.7 (monitoring spine) **is** merged — `services/job_registry.py`, `services/job_locks.py`, `services/alerts.py`, `services/findings.py`, `routers/ops.py`, `migrations/20260905090000_ops_job_runs.sql` and `migrations/20260907150000_ops_findings.sql` are all on `origin/main`, and this plan consumes them.

- [ ] **Task 0 gate:** `cd /Users/gabe/lotlogic-backend && git fetch origin && git merge-base --is-ancestor origin/wave2/schema-baseline origin/main && echo GATE-OPEN`. If this does not print `GATE-OPEN`, stop and report; do not start Task 2.

**Worktrees:**
- Backend (most of the work): create `/Users/gabe/lotlogic-backend-retention` from `origin/main` on branch `wave2/retention`. Do **not** work in `/Users/gabe/lotlogic-backend` — its `main` is 124 commits behind `origin/main`.
- Frontend (Tasks 9, 10b, 11): create `/Users/gabe/lotlogic-retention` from `origin/main` on branch `wave2/retention`. Do **not** work in `/Users/gabe/lotlogic` — it is on a feature branch with uncommitted dashboard changes.

**Test baseline:** `cd /Users/gabe/lotlogic-backend-retention && .venv/bin/pytest -q` before Task 1; record the number. It must only go up.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Production is read-only for this plan.** Every SQL in here is either a migration (applied through the Supabase MCP `apply_migration` or the Wave 2.4 runner, never the SQL editor) or a query the sweep issues at runtime in **dry-run mode**. No task in this plan deletes a production row. Task 13 is the go-live, and it is a flag flip performed by Gabe after reading seven nights of counts.
- **Never edit these files.** `routers/plaza_payments.py`, `services/plaza_settle.py`, `services/square*.py`, `services/plaza_alerts.py`, `services/plaza_sweep.py`, `services/plaza_reconcile.py`. The money path is not in scope, and `plaza_payments` is in the never-swept class (RETENTION.md §3.E).
- **The sweep may never reach a business record.** `alpr_violations`, `no_registration_violations`, `partner_truck_sightings`, `tow_clip_files`, `tow_sighting_clips`, `plaza_payments`, `plaza_reconciliations`, `pending_invoices`, `properties`, `enforcement_partners`, `lot_owners`, `alpr_violation_proof`. Task 7 has a test that walks every registered rule's target table and fails if one of these names appears.
- **Every rule is guarded, and the guard is shared.** One `_UNREFERENCED` / `_NOT_OPEN` SQL fragment, composed into each rule — never re-typed per rule. See Task 3 for why: `partner_truck_sightings.plate_event_id` is `ON DELETE CASCADE`, so an unguarded plate-read delete silently destroys tow evidence.
- **Statement timeouts on every batch.** Each batch runs `SET LOCAL statement_timeout = :ms` inside its own transaction. A retention sweep that wedges the pool is worse than one that never runs — the 2026-09-04 incident is the precedent.
- **Everything runs on `database.ops_engine`** (the `NullPool` engine from Wave 2.7), never the request pool.
- **PII discipline in findings and alert bodies.** Counts, ages, table names, class names. Never a plate, a phone number, an email address, a company name or an R2 key. `alerts.redact_text` is applied by `services/findings.py` on the way in; do not defeat it by putting a key in a `title`.
- **Secrets only via env**, as `config.Settings` fields read through `get_settings()`. No literal periods at a call site — a period that is not a setting is a period nobody can change at 11pm.
- **Migrations:** `migrations/YYYYMMDDHHMMSS_snake_case_name.sql` (`date -u +%Y%m%d%H%M%S`). Every new table gets `ENABLE ROW LEVEL SECURITY` and `REVOKE ALL … FROM anon, authenticated` in the same file, plus a commented rollback block at the bottom — the house style, see `migrations/20260907150000_ops_findings.sql`.
- **Tests:** pytest-asyncio is in **strict** mode with no ini file, so every coroutine test outside `tests/plaza/` needs its own `@pytest.mark.asyncio`. Tests inside `tests/plaza/` get the marker from that package's collect hook and run against a real Postgres 17 (`TEST_DATABASE_URL` in CI, an `initdb` cluster locally, skipped if neither). **Every Task 7 test belongs in `tests/plaza/` — a retention test that does not run against a real database with real foreign keys proves nothing**, because the whole risk is what the FKs do.
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
| `plate_events` | **72,480** rows · 125 MB (96 MB heap + 29 MB across **14** indexes) · 2026-04-19 → 2026-09-14 |
| `plate_events` per month | Apr 14,627 · May 8,855 · Jun 5,245 · Jul 9,860 · Aug 20,135 · Sep(1–14) 13,758 |
| `plate_events` last 7 days | **≈ 1,049 / day** (one live site, 6 cameras) |
| `plate_events.raw_data` | avg 996–1,288 B/row, ≈ 66 MB total, 30+ distinct top-level keys |
| `plate_events` older than 90 days | **27,280** — of which **26,569 are referenced by nothing** |
| `plate_events` older than 180 days | 0 (the pipeline is five months old) |
| `plate_events` with a photo URL | **68,770**, all on `https://pub-2b67cfea48564c9695230f8909348716.r2.dev` (public) |
| `camera_snapshot_diag` | 12,621 rows · 19 MB · **already pruned at 7 days** by pg_cron `prune_camera_snapshot_diag` (03:17 UTC) |
| `weak_plate_reads` | **17,329** rows · 5,280 kB · 2026-05-14 → **2026-05-19** · 100% older than 90 days |
| `plate_match_decisions` | 1,531 rows · 768 kB |
| `visitor_passes` | 3,099 rows · 2,784 kB across **20** indexes · 3,063 with a phone · 314 with an email · **314 with a government-ID photo** · 314 with a plate photo |
| `visitor_passes` ended >30 d ago / >90 d ago | **2,142** / 704 |
| `resident_plates` | 9 rows · 8 phones · **5 government-ID docs · 5 leases** · 5 plate photos |
| `plaza_payments` | 10 rows, **all 10 carry a phone number** |
| `alpr_violations` | 2,494 rows · 2,472 unresolved · **24 tow-confirmed and not yet invoiced** |
| `partner_truck_sightings` | 230 rows (tow evidence, `ON DELETE CASCADE` from `plate_events`) |
| `tow_clip_files` | 60 rows — 4 `archived` (**742 MB** of mp4) + 56 `expired_unarchived` |
| `plate_sessions` | 340 rows, **nothing written since 2026-05-12** |
| `snapshots` (legacy YOLO) | **0 rows, 11 MB — entirely index** |
| Supabase Storage buckets | `plate-snapshots` (**public**, 0 objects, 0 code references) · `tow-evidence` (private, 0 objects, 0 code references) |
| `TOW_CLIPS_BUCKET` | **unset in production** — clips are written to and presigned from the public `parking-snapshots` bucket |
| Properties / cameras | 11 (10 apartment, 1 truck plaza) / 6 |

### The foreign keys that make an unguarded DELETE dangerous

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
tow-clips/{property_id}/{YYYY-MM-DD}/{anchor}-{api_key}-{8hex}.mp4           lotlogic-agent/tow_archiver/r2.py:76
violations/… , snapshots/…                                                   services/storage.py:build_storage_key (legacy, no writer)
```

Accepted reads and rejected diagnostic frames **share a prefix root** (a property UUID) and differ only in a filename segment. R2 lifecycle filters on prefix. Therefore no rule can give them different periods until the keys change. Task 8a is that change.

---

## Scope calls — decided here so no executor re-litigates them

1. **`snapshot_retention_hours = 24` is deleted, not wired up (FAT-20).** It is a `config.Settings` field read by zero lines of code, and its 24-hour value contradicts every period in the policy. A setting that looks like policy and is not is worse than no setting. Task 1 deletes it and `services/storage.py`'s docstring claim that "non-violation snapshots are deleted after 24h via lifecycle rule" — which has been false since April.
2. **`plate_sessions`, `snapshots`, `zone_occupancy`, `violations`, `no_registration_violations` get no rule.** They are all either empty or have had no writer since March–May. Deleting from a dead table is not retention, it is a fat decision (spec §4 decisions 2, 3, 10) and belongs to Wave 3.6. This plan leaves them alone and says so in RETENTION.md §2.
3. **`camera_snapshot_diag` gets no new rule.** pg_cron `prune_camera_snapshot_diag` already deletes it at 7 days and already heartbeats into `ops_job_runs`. The policy documents it (A8); the sweep does not duplicate it. A second writer against the same table is a way to make two jobs fight.
4. **Tow footage retention is not touched.** `TOW_FOOTAGE_RETENTION_DAYS`, `TOW_FOOTAGE_RETENTION_OVERRIDES`, `services/tow_retention.parse_overrides` and the `tow_digest` expiry findings are shipped, tested and correct. This plan documents them (RETENTION.md §3.C) and adds exactly one thing they are missing: the **private clips bucket** those clips were always supposed to live in (Task 12). Do not refactor `tow_retention.py`.
5. **Apartment documents keep their streaming proxy; only the bucket moves.** `routers/apartment_docs.py`'s authenticated, scope-checked, `private, no-store` proxy is already the right design and is explicitly better than a presign. The finding is that it streams out of a bucket with a public r2.dev domain. Task 12 moves `apt/` to a private bucket; the proxy code is unchanged.
6. **The tow-dispatch email gets a 48-hour presign, not an authenticated proxy.** An email client cannot carry a bearer token. The email already mints a 48-hour HMAC action token for its Tow / No-Tow buttons; a photo URL with the same TTL is consistent, and it is the difference between "expires with the decision" and "forever".
7. **`ops_retention_runs` is a new table, not a reuse of `ops_findings`.** Findings are *distinct problems that get closed*; the dry-run evidence is *a time series of counts per class per night*. Putting a nightly count into a fingerprinted, deduplicating table would either file one row that bumps `seen_count` 7 times and loses every number, or 7 × 14 rows that defeat the dedupe. A finding is still filed — one, when a class's candidate count moves by more than an order of magnitude (Task 5) — because that is a problem, not a measurement.
8. **The `evidence/` copy (Task 8a) is a copy, not a move.** The camera function copies the accepted frame to `evidence/{property_id}/{violation_id}.jpg` when it files a violation. A move would break `plate_events.image_url` for the read that produced it; a copy costs one R2 PUT per violation (2,494 in five months) and lets the two prefixes carry genuinely different periods.

---

## File structure

| File | Responsibility |
|---|---|
| `/Users/gabe/lotlogic/docs/RETENTION.md` **(new, Task 1)** | The policy. Data class → why → period → mechanism → owner. The only place a period is *explained*. |
| `config.py` *(modify, Task 1)* | One `Settings` field per period. Deletes `snapshot_retention_hours`. |
| `tests/test_retention_policy.py` **(new, Task 1)** | Parses RETENTION.md's Setting column and asserts every name is a real `Settings` field and every `retention_*` field appears in the document. |
| `migrations/2026………_ops_retention_runs.sql` **(new, Task 2)** | `ops_retention_runs` — per class, per night, per mode counts. RLS + revoke + rollback. |
| `services/retention.py` **(new, Task 3)** | `RetentionRule`, the shared guard fragments, and the rule list. Pure SQL + dataclasses, no I/O. |
| `services/retention.py` *(extend, Task 4)* | The `plate_events.raw_data` strip rule — an `UPDATE`, with the keep-key allowlist as a module constant. |
| `services/retention_sweep.py` **(new, Task 5)** | The runner: dry-run vs live, batching, statement timeout, per-class rows into `ops_retention_runs`, findings on anomaly. |
| `main.py` *(modify, Task 6)* | Eleventh lifespan loop: `supervised("retention_sweep", …)` + `job_locks.run_locked` + `job_registry.heartbeat`. |
| `services/job_registry.py` *(modify, Task 6)* | `BACKEND_JOBS["retention_sweep"] = 3600`. |
| `tests/plaza/test_retention_*.py` **(new, Task 7)** | One test file per data class, against real Postgres with real FKs. |
| `ops/r2-lifecycle/parking-snapshots.json` **(new, Task 8)** | The lifecycle rules, as config. |
| `ops/r2-lifecycle/tow-clips.json`, `ops/r2-lifecycle/lotlogic-docs.json` **(new, Task 8)** | Same, for the two new private buckets. |
| `scripts/apply_r2_lifecycle.py` **(new, Task 8)** | Diff live-vs-file, apply only with `--yes`. |
| `/Users/gabe/lotlogic/supabase/functions/camera-snapshot/index.ts` *(modify, Task 8a)* | New key prefixes `reads/`, `diag/`, `debug/`; `evidence/` copy at violation time. |
| `migrations/2026………_storage_buckets_private.sql` **(new, Task 9)** | Makes the two Supabase Storage buckets private and documents that they are empty and unreferenced. |
| `routers/alpr.py` *(modify, Task 10)* | `GET /plate-events/{id}/photo` → 15-minute presign, scope-checked. |
| `/Users/gabe/lotlogic/frontend/dashboard.html` *(modify, Task 10)* | Replace direct `image_url` renders with the presign fetch. |
| `/Users/gabe/lotlogic/supabase/functions/tow-dispatch-email/index.ts` *(modify, Task 11)* | 48-hour presign instead of the permanent public URL. |
| `docs/RETENTION.md` *(modify, Task 13)* | Change log entry when the flag flips. |

---

## Task sequence, dependencies and parallelism

| # | Task | Depends on | Lane |
|---|---|---|---|
| 0 | **Gate:** Wave 2.4 merged to `origin/main` | — | — |
| 1 | `docs/RETENTION.md` + `config.Settings` periods + the policy⇄settings test | 0 | A |
| 2 | Migration: `ops_retention_runs` | 0 | A |
| 3 | `services/retention.py` — rules and the shared guard | 1 | A |
| 4 | The vendor-JSON strip rule (`UPDATE`, not `DELETE`) | 3 | A |
| 5 | `services/retention_sweep.py` — the runner, dry-run default | 2, 3, 4 | A |
| 6 | Wire the sweep into the lifespan as job #11 | 5 | A |
| 7 | One test per data class, against real Postgres | 3, 4, 5 | A |
| 8 | R2 lifecycle JSON + `scripts/apply_r2_lifecycle.py` | 1 | **B** |
| 8a | Key restructure: `reads/` `diag/` `debug/` + the `evidence/` copy | 8 | **B** |
| 9 | Supabase Storage buckets → private (migration) | 0 | **B** |
| 10 | Presigned photo endpoint + dashboard repoint | 1 | **C** |
| 11 | Tow-dispatch email: 48-hour presign | 10 | **C** |
| 12 | Private buckets: `TOW_CLIPS_BUCKET`, `lotlogic-docs`, then the public r2.dev domain off | 8a, 10, 11 | join |
| 13 | **Go-live:** seven nights of dry-run counts reviewed, then the flag | 6, 7, 12 | join |

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
- **Lane B** is the only lane that touches R2 config and the edge function's key shapes.
- **Lane C** is the only lane that touches `routers/alpr.py`, `dashboard.html` and `tow-dispatch-email`.
- Lanes A and C both add a backend route/module but never the same file. Lanes B and C both touch the frontend repo but never the same file (`camera-snapshot/index.ts` vs `dashboard.html` + `tow-dispatch-email/index.ts`).
- **Task 12 is a join and must be last but one.** Turning the public domain off before Tasks 10 and 11 are live breaks every photo in the dashboard and every tow email in flight.
- **Task 13 is a flag flip by Gabe**, not an agent action, and it cannot start until Task 6 has been in production for seven nights.

Suggested three-agent split: A = tasks 1→3→4→5→6→7; B = 8→8a and 9; C = 10→11. Then one agent joins on 12.

---

## Task 1: The policy document, the settings, and the test that keeps them honest

**Files:**
- Create: `/Users/gabe/lotlogic/docs/RETENTION.md` (frontend repo — it is the product-level document; the backend reads it in CI via a checked-in copy path, see Step 4)
- Modify: `config.py` (backend) — add the `── Retention ──` block, **delete** `snapshot_retention_hours`
- Modify: `services/storage.py` — delete the false docstring claim
- Create: `tests/test_retention_policy.py`

**Interfaces produced:**
- `Settings.retention_enabled: bool = False`
- `Settings.retention_plate_event_raw_days: int = 90`
- `Settings.retention_plate_event_row_days: int = 730`
- `Settings.retention_weak_plate_read_days: int = 90`
- `Settings.retention_plate_match_decision_days: int = 90`
- `Settings.retention_pass_phone_days: int = 30`
- `Settings.retention_payment_phone_days: int = 395`
- `Settings.retention_id_doc_days: int = 30`
- `Settings.retention_lease_doc_days: int = 90`
- `Settings.retention_pass_plate_photo_days: int = 90`
- `Settings.retention_ops_job_history_days: int = 90`
- `Settings.retention_closed_finding_days: int = 365`
- `Settings.retention_batch_size: int = 2000`
- `Settings.retention_max_batches_per_class: int = 50`
- `Settings.retention_statement_timeout_ms: int = 20000`

- [ ] **Step 1: Write `docs/RETENTION.md`.** The draft is already written at `/Users/gabe/lotlogic/docs/RETENTION.md`. Re-measure every number in its §2 against production (read-only) and correct any that has moved. Keep the `> **STATUS: DRAFT — not in force.**` banner: it is removed by Task 13 and by nothing else.

- [ ] **Step 2: Add the settings block to `config.py`**, immediately after the `── Tow footage retention ──` block so the two retention families sit together:

```python
    # ── Retention (Wave 2.5) ──────────────────────────────────────────────
    # Every period in docs/RETENTION.md is one of these fields, so a period
    # changes with a Railway variable rather than a deploy. The document is
    # the *why*; these are the *what*, and tests/test_retention_policy.py
    # fails the build when the two disagree.
    #
    # THE MASTER SWITCH. False means services/retention_sweep.py counts what
    # it would have done into public.ops_retention_runs and mutates nothing.
    # It ships False and stays False until seven nights of dry-run counts have
    # been read by a human (RETENTION.md §7 decision 15). There is deliberately
    # no per-class enable: a half-armed sweep is a sweep nobody can reason
    # about.
    retention_enabled: bool = False

    # A1 — strip the camera vendor's raw JSON down to the matched fields.
    # An UPDATE, never a DELETE: the read itself survives (A2's period).
    retention_plate_event_raw_days: int = 90
    # A2 — delete a plate read nothing points at. 730 rather than 365 because
    # a tow dispute can arrive a year late and the row is 1.3 kB without its
    # raw_data; the photograph (A3, 365 d) is the expensive half.
    retention_plate_event_row_days: int = 730
    # A9 / A10 — second-pass OCR material and the matcher's decision log.
    retention_weak_plate_read_days: int = 90
    retention_plate_match_decision_days: int = 90

    # B1 / B2 — blank the phone and email N days after the pass ends. The pass
    # row survives; only the two contact columns are nulled.
    retention_pass_phone_days: int = 30
    # B3 — a payment's contact phone is attached to a financial record, so it
    # outlives a pass phone: 13 months covers every card-network chargeback
    # window plus one tax cycle.
    retention_payment_phone_days: int = 395
    # B4 / B5 / B6 — R2 object deleted AND the column nulled, in that order.
    # ID is the shortest period in this file on purpose.
    retention_id_doc_days: int = 30
    retention_lease_doc_days: int = 90
    retention_pass_plate_photo_days: int = 90

    # D2 / D3 — the sweep's own history, and findings that are already closed.
    retention_ops_job_history_days: int = 90
    retention_closed_finding_days: int = 365

    # Mechanics, not policy. batch_size x max_batches_per_class is the hard
    # ceiling on one class in one night: 2000 x 50 = 100,000 rows, which is
    # more than the whole of plate_events today and still finishes inside the
    # hour the loop ticks on. A class that hits the ceiling files a finding
    # rather than running longer.
    retention_batch_size: int = 2000
    retention_max_batches_per_class: int = 50
    # SET LOCAL statement_timeout per batch. A retention sweep that wedges the
    # pool is worse than one that never runs (2026-09-04).
    retention_statement_timeout_ms: int = 20000
```

- [ ] **Step 3: Delete the setting that pretends to be a policy (FAT-20).**

In `config.py`, delete:
```python
    snapshot_retention_hours: int = 24              # delete non-violation snapshots after
```
Confirm it has no reader first — it does not:
```bash
cd /Users/gabe/lotlogic-backend-retention && grep -rn "snapshot_retention_hours" --include='*.py' . | grep -v "config.py"
```
Expected: no output.

In `services/storage.py`, delete these two lines from the module docstring, which have been false since the April lifecycle-rule deletion:
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

The document lives in the frontend repo and the settings in the backend, so the test needs a path. Resolve it from an environment variable with a sensible default and **skip** (not fail) when the document is not on disk, so a backend-only CI checkout stays green:

```python
"""The policy document and config.Settings must not drift apart.

docs/RETENTION.md is the only place a period is EXPLAINED; config.Settings is
the only place one is READ. A period that exists in one and not the other is
the exact failure this whole plan exists to prevent — a setting that looks
like policy and is enforced by nothing (FAT-20's `snapshot_retention_hours`),
or a policy nobody implemented (SEC-11).
"""
from __future__ import annotations

import os
import re
from pathlib import Path

import pytest

from config import Settings

_DEFAULT = Path.home() / "lotlogic" / "docs" / "RETENTION.md"
POLICY_PATH = Path(os.environ.get("RETENTION_POLICY_PATH", _DEFAULT))

pytestmark = pytest.mark.skipif(
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


def test_every_setting_named_in_the_policy_is_a_real_field():
    unknown = _settings_named_in_policy() - _retention_fields()
    assert not unknown, f"RETENTION.md names settings that do not exist: {sorted(unknown)}"


def test_every_period_field_is_explained_in_the_policy():
    missing = _retention_fields() - MECHANICS - _settings_named_in_policy()
    assert not missing, (
        "these periods are enforced by code but explained nowhere in "
        f"RETENTION.md: {sorted(missing)}"
    )


def test_the_master_switch_ships_off():
    """A retention sweep that is on by default is a retention sweep that
    deleted production before anyone read its dry run."""
    assert Settings.model_fields["retention_enabled"].default is False


def test_the_fake_policy_setting_is_gone():
    """FAT-20: `snapshot_retention_hours = 24` read like a policy and was read
    by zero lines of code."""
    assert "snapshot_retention_hours" not in Settings.model_fields
```

- [ ] **Step 5: Run and commit**

```bash
cd /Users/gabe/lotlogic-backend-retention && .venv/bin/pytest tests/test_retention_policy.py -q && ruff check config.py services/storage.py tests/test_retention_policy.py && .venv/bin/pytest -q
```
Expected: 4 passed in the new file, the full-suite number unchanged from the baseline.

```bash
git add config.py services/storage.py tests/test_retention_policy.py
git commit -m "feat(retention): periods as settings, and delete the setting that pretended to be one

Every period in docs/RETENTION.md is now a Settings field, so a period changes
with a Railway variable rather than a deploy, and tests/test_retention_policy.py
fails the build when the document and the code disagree.

snapshot_retention_hours = 24 is deleted: it was read by zero lines of code and
its value contradicted every real period (FAT-20). services/storage.py's claim
that non-violation snapshots are deleted after 24h via a lifecycle rule is
deleted with it — that rule was removed in April.

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
-- (a finding is a distinct PROBLEM that gets closed; "26,569 candidates
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

    -- The number the guard let through: rows past the cutoff AND referenced by
    -- nothing AND attached to nothing open.
    candidates      bigint NOT NULL DEFAULT 0 CHECK (candidates >= 0),
    -- Rows actually deleted/updated/nulled. Always 0 in dry_run.
    affected        bigint NOT NULL DEFAULT 0 CHECK (affected >= 0),
    -- Rows past the cutoff that the guard REFUSED. This is the number that
    -- proves the guard is doing something; a class where it is always 0
    -- should be looked at.
    protected       bigint NOT NULL DEFAULT 0 CHECK (protected >= 0),
    -- R2 objects deleted (B4/B5/B6 only; 0 for pure row rules).
    objects_deleted bigint NOT NULL DEFAULT 0 CHECK (objects_deleted >= 0),

    -- The age of the oldest candidate, for sanity: a cutoff bug shows up here
    -- as a suspiciously small number long before it shows up in `affected`.
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
    'guarantees nothing was. Wave 2.5; policy in docs/RETENTION.md.';

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
SELECT count(*) FROM public.ops_retention_runs;                     -- 0
SELECT relrowsecurity FROM pg_class WHERE relname='ops_retention_runs';  -- t
```

- [ ] **Step 3: Commit** (`feat(retention): ops_retention_runs — the dry run's evidence`).

---

## Task 3: `services/retention.py` — the rules, and one shared guard

**Files:** Create `services/retention.py`; test `tests/test_retention_rules.py` (pure-SQL-shape tests; the behavioural tests are Task 7).

**Interfaces produced:**
- `retention.RetentionRule` — frozen dataclass: `name`, `policy_ref`, `target_table`, `kind` (`"delete" | "update" | "null_columns" | "delete_objects"`), `days_setting`, `count_sql`, `mutate_sql`, `object_key_sql` (optional).
- `retention.rules() -> list[RetentionRule]` — the registry, built from `get_settings()` at call time (not import time, so a monkeypatched setting lands).
- `retention.NEVER_SWEEP: frozenset[str]` — the business-record table names.
- `retention.cutoff(days: int, *, now: datetime) -> datetime`

- [ ] **Step 1: Write the shared guard fragments.** These are the whole safety argument, so they are one constant each, composed — never re-typed:

```python
#: A plate read is UNREFERENCED when nothing in the schema points at it.
#: This is not belt-and-braces. The foreign keys make it load-bearing:
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
#: 2026-09-14: 27,280 reads older than 90 days, 26,569 referenced by nothing.
#: The guard costs 711 rows and buys the difference between a retention sweep
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

#: A pass is CLOSED when it cannot still be argued about: it has ended, and no
#: violation attached to it is open, held, disputed, or tow-confirmed but not
#: yet invoiced. Measured 2026-09-14: 2,472 unresolved violations and 24
#: tow-confirmed-but-uninvoiced — blanking the phone on one of those 24 is
#: blanking the contact for a tow you are about to invoice.
_PASS_NOT_OPEN = """
    vp.valid_until < :cutoff
AND vp.status <> 'active'
AND NOT EXISTS (
        SELECT 1 FROM public.alpr_violations v
         WHERE (v.plate_text = vp.plate_text AND v.property_id = vp.property_id)
           AND (   v.resolved_at IS NULL
                OR v.billing_held_at IS NOT NULL
                OR (v.tow_confirmed_at IS NOT NULL AND v.invoiced_at IS NULL))
    )
AND vp.overstay_violation_id IS NULL
"""
```

- [ ] **Step 2: Write `RetentionRule` and the registry.** One rule per policy row. Each carries a `count_sql` that returns `(candidates, protected, oldest)` and a `mutate_sql` that takes `:batch` and returns the affected id set. Example, A2:

```python
_A2_COUNT = f"""
SELECT count(*)                                                    AS candidates,
       count(*) FILTER (WHERE NOT ({_PLATE_EVENT_UNREFERENCED}))   AS protected,
       min(pe.created_at)                                          AS oldest
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
- `FOR UPDATE SKIP LOCKED` — the camera pipeline writes this table continuously; a batch must not block an ingest, and an ingest must not block the batch.
- `ORDER BY pe.created_at` — oldest first, so a truncated run makes monotonic progress instead of re-scanning the same window.
- The guard appears **twice** (in `count_sql`'s `protected` and in `mutate_sql`'s `WHERE`) and is the same constant both times. That is the point of the constant.
- `count(*) FILTER (WHERE NOT (...))` is what populates `ops_retention_runs.protected` — the number that proves the guard fired.

- [ ] **Step 3: `NEVER_SWEEP` and its test.**

```python
#: Tables the sweep must never be able to name. These are the invoice trail.
NEVER_SWEEP = frozenset({
    "alpr_violations", "alpr_violation_proof", "no_registration_violations",
    "partner_truck_sightings", "tow_clip_files", "tow_sighting_clips",
    "plaza_payments", "plaza_reconciliations", "pending_invoices",
    "properties", "enforcement_partners", "lot_owners",
})
```

```python
def test_no_rule_targets_a_business_record():
    """RETENTION.md §3.E. A rule that can reach the invoice trail is not a
    retention bug, it is a revenue bug."""
    for rule in retention.rules():
        assert rule.target_table not in retention.NEVER_SWEEP, rule.name
```

- [ ] **Step 4:** Additional shape tests — every rule's `days_setting` resolves to a real `Settings` field; every `mutate_sql` contains `LIMIT :batch`; every `delete`-kind rule's SQL contains `SKIP LOCKED`; the rule names are unique and match `ops_retention_runs.data_class` values the sweep will write.

- [ ] **Step 5:** `ruff check`, `pytest tests/test_retention_rules.py -q`, commit (`feat(retention): the rules, and the one guard they all share`).

---

## Task 4: The vendor-JSON strip — an `UPDATE`, not a `DELETE`

**Files:** Modify `services/retention.py`; test `tests/test_retention_rules.py`.

This is rule **A1** and it is the single largest, safest win in the plan: ~66 MB of vendor JSON on rows nobody will ever re-litigate, removable without deleting a single enforcement record.

- [ ] **Step 1: The keep-list, as a module constant with its measured justification.**

```python
#: The 12 keys a 90-day-old plate read still needs. Measured against
#: production 2026-09-14: `plate_events.raw_data` carries 30+ distinct
#: top-level keys and averages 996-1,288 bytes across 72,480 rows (~66 MB).
#: Everything not named here is vendor scratch — bounding boxes (34,270 rows),
#: MMC probability tables (47,757), retired-sidecar diagnostics (15,251), the
#: raw Milesight envelope (23,940) — useful for about a week while a camera is
#: being tuned, and never afterwards.
#:
#: The keys that stay are the ones a HUMAN argument turns on: which OCR
#: produced the read, which direction the vehicle was going, which pass it
#: matched and whether that match was fuzzy, and whether an operator ever
#: relabelled it.
RAW_DATA_KEEP_KEYS = (
    "ocr_source", "direction", "flow",
    "pass_id", "pass_match_fuzzy",
    "overstay", "cross_camera_match", "verified_pair_match",
    "operator_label", "operator_labeled_at",
    "_source", "_mmc_source",
)
```

- [ ] **Step 2: The SQL.** Idempotent, and it must not rewrite a row it has already stripped — otherwise every night re-dirties 26,000 pages for nothing:

```python
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

- [ ] **Step 3:** Register it as a `RetentionRule(name="plate_event_raw_json", policy_ref="A1", target_table="plate_events", kind="update", days_setting="retention_plate_event_raw_days", …)`.

**Note that A1 carries no `_PLATE_EVENT_UNREFERENCED` guard, deliberately.** It does not delete the read; a violation, a session, a sighting and a pass all keep pointing at the same row with the same plate, time, camera, confidence and photo. The only thing that leaves is vendor scratch. Making A1 respect the reference guard would exempt exactly the rows with the fattest `raw_data` (the matched ones) and defeat the purpose. Write this reasoning into the rule's docstring — it is the one place the plan deliberately does not use the shared guard, and the next reader will otherwise "fix" it.

- [ ] **Step 4:** Test that a stripped row keeps all 12 keys and loses the others; that re-running the rule affects **0** rows; that `raw_data` never becomes `NULL` (it becomes `{}`); that a row inside the cutoff is untouched.

- [ ] **Step 5:** `ruff check`, `pytest -q`, commit (`feat(retention): strip plate-read vendor JSON to the 12 matched fields at 90 days`).

---

## Task 5: `services/retention_sweep.py` — the runner

**Files:** Create `services/retention_sweep.py`; test `tests/test_retention_sweep.py` (fakes; Task 7 does it for real).

**Interfaces produced:**
- `await retention_sweep.run_sweep(*, now: datetime | None = None, force_dry_run: bool = False) -> dict` → `{"run_id", "mode", "classes": [...], "errors": int}`. **Never raises.**
- `await retention_sweep.run_class(rule, *, run_id, now, live) -> dict`
- `retention_sweep.SWEEP_INTERVAL_SECONDS = 3600`

- [ ] **Step 1: The mode decision, in one function, with the belt and the braces separate.**

```python
def _mode(*, force_dry_run: bool) -> str:
    """'live' only when the master switch is on and nobody asked otherwise.

    Two independent noes. `force_dry_run` is the caller's (the /ops endpoint
    passes it so an operator can ask "what would you do tonight?" without
    arming anything); `retention_enabled` is the deployment's. Either one is
    enough to keep the sweep counting instead of cutting.
    """
    if force_dry_run:
        return "dry_run"
    return "live" if get_settings().retention_enabled else "dry_run"
```

- [ ] **Step 2: The per-class body.** Shape:

1. `SELECT` the rule's `count_sql` with `:cutoff` → `candidates`, `protected`, `oldest`. **Always**, in both modes: the count is the dry run's whole product and the live run's before-picture.
2. If `mode == "dry_run"`: write the `ops_retention_runs` row with `affected = 0` and return. The migration's CHECK constraint makes that a database-enforced promise, not a code convention.
3. If `mode == "live"`: loop up to `retention_max_batches_per_class` times. Each iteration is its own transaction on `database.ops_engine`:

```python
async with database.ops_engine.begin() as conn:
    await conn.execute(text("SET LOCAL statement_timeout = :ms"),
                       {"ms": settings.retention_statement_timeout_ms})
    result = await conn.execute(text(rule.mutate_sql),
                                {"cutoff": cutoff, "batch": settings.retention_batch_size,
                                 **rule.extra_params})
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

- [ ] **Step 4: The anomaly finding.** Compare tonight's `candidates` against the median of the last 7 runs for the same class (one query against `ops_retention_runs`). File **one** `ops_findings` row when tonight is more than 10× the median or the class is `truncated`, through `findings.record_batch_and_notify("retention_sweep", …)` with stable fingerprints:

| fingerprint | severity | when |
|---|---|---|
| `retention-class-truncated` | `medium` | a class hit `retention_max_batches_per_class` |
| `retention-candidates-spike` | `medium` | tonight > 10 × the 7-run median |
| `retention-class-failed` | `high` | a class raised |
| `retention-dry-run-standing` | `low` | `retention_enabled` has been false for more than 21 days — the sweep noticing that nobody ever came back to the decision |

Bodies carry class names, counts and ages only. No plate, no key, no phone.

- [ ] **Step 5:** Tests with a fake rule list: dry run mutates nothing and still records counts; a rule that raises does not stop the next rule; the batch loop stops on a short batch; `truncated` is set at the cap; `force_dry_run=True` overrides `retention_enabled=True`; the object-then-column order is asserted by call sequence.

- [ ] **Step 6:** `ruff check`, `pytest -q`, commit (`feat(retention): the nightly sweep, dry-run by default`).

---

## Task 6: Wire the sweep in as lifespan job #11

**Files:** Modify `main.py`, `services/job_registry.py`.

- [ ] **Step 1:** `services/job_registry.py` — add to `BACKEND_JOBS`, with the comment the dict's own docstring demands (every entry must explain its interval):

```python
    # Ticks hourly and does nothing until 04:10 UTC, the same shape as
    # plaza_reconcile and tow_digest: the loop's cadence is the heartbeat's
    # cadence, the once-a-day check lives in the job body. So the dead-man
    # notices within two hours if this loop dies, not within two days.
    # 04:10 UTC is deliberately after pg_cron's prune_camera_snapshot_diag
    # (03:17) and purge_cron_job_run_details (03:45) so the three deletion
    # jobs never overlap on the same instance.
    "retention_sweep": 3600,
```

- [ ] **Step 2:** `main.py` — the loop, following `_tow_digest_loop` exactly (it is the closest existing sibling: hourly tick, daily body, lock, heartbeat on both paths):

```python
    # Retention sweep (Wave 2.5). Hourly tick; the body no-ops until 04:10 UTC.
    # RETENTION_ENABLED is false in production: every run counts what it would
    # have deleted into public.ops_retention_runs and mutates nothing. See
    # docs/RETENTION.md — the flag does not flip until seven nights of those
    # counts have been read by a human.
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

and `retention_sweep_task.cancel()` in the shutdown block with the others.

- [ ] **Step 3:** Wave 2.7 ships `tests/test_job_registry.py::test_every_lifespan_loop_has_a_registry_entry`, which walks `main.py`'s lifespan by AST and diffs the `supervised(...)` names against `BACKEND_JOBS` **in both directions**. It will fail if Step 1 and Step 2 disagree. Run it explicitly:

```bash
.venv/bin/pytest tests/test_job_registry.py -q
```

- [ ] **Step 4:** Add `GET /ops/retention` to `routers/ops.py` (platform-admin, same guard as `GET /ops/jobs`) returning the last 14 runs grouped by class, and `POST /ops/retention/dry-run` (platform-admin) which calls `run_sweep(force_dry_run=True)` on demand. This is how Task 13's go/no-go is read without a SQL client.

- [ ] **Step 5:** `ruff check`, full `pytest -q`, commit (`feat(retention): the sweep joins the job registry as loop #11`).

---

## Task 7: One test per data class — deletes exactly the eligible rows and nothing referenced

**Files:** Create `tests/plaza/test_retention_plate_events.py`, `…_passes_pii.py`, `…_documents.py`, `…_ops_history.py`.

**These belong in `tests/plaza/`** because that package runs against a real Postgres 17 with the real schema and therefore the real foreign keys. The entire risk in this plan is what `ON DELETE CASCADE` does when nobody is looking; a test with a mocked database proves nothing about that.

Each class gets the same five-test shape. The pattern, for A2:

- [ ] **Step 1: the positive** — three reads past the cutoff referenced by nothing; run live; exactly those three gone, `affected == 3`.
- [ ] **Step 2: the negative, one per referencing table.** This is the important one and it is five separate assertions, not one:

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
Each case: insert a read past the cutoff, attach exactly one referrer, run the rule live, assert the read still exists, assert `affected == 0`, assert `protected == 1`, **and assert the referrer row is still there** (the cascade cases fail this and nothing else).
- [ ] **Step 3: the boundary** — a read one second inside the cutoff survives, one second outside is a candidate.
- [ ] **Step 4: dry run mutates nothing** — same fixture as Step 1, `RETENTION_ENABLED=false`, assert the three rows still exist, `candidates == 3`, `affected == 0`, and that the `ops_retention_runs` row was written.
- [ ] **Step 5: the batch cap** — `retention_batch_size=2`, seven candidates, `retention_max_batches_per_class=2` → 4 deleted, `truncated is True`, the remaining 3 untouched and still candidates next run.

Per-class specifics:

| File | Rules | The negative that matters most |
|---|---|---|
| `test_retention_plate_events.py` | A1 (strip), A2 (row), A9, A10 | the six-way parametrize above; plus A1 must NOT strip a row inside the cutoff and must be a no-op on a second run |
| `test_retention_passes_pii.py` | B1, B2, B3 | a pass whose plate has an **unresolved** violation keeps its phone; a pass whose plate has a **tow-confirmed, uninvoiced** violation keeps its phone (24 such rows in production today); a pass still `active` keeps its phone; and after nulling, `plate_text`, `property_id` and the dates are **unchanged** — the row survives, only the contact leaves |
| `test_retention_documents.py` | B4, B5, B6 | the object is deleted **before** the column is nulled (assert call order against a fake storage); a failed object delete leaves the column set so the row retries next night; a document on a pass that was never reviewed uses pass-end + 30, not decision + 30 |
| `test_retention_ops_history.py` | D2, D3 | an **open** finding is never deleted regardless of age; `ops_retention_runs` sweeping itself does not delete the row it is currently writing |

Plus one cross-cutting test in `tests/test_retention_rules.py`:

```python
def test_every_rule_has_a_test_file():
    """A rule with no behavioural test is a rule that will delete production
    the first time its SQL is wrong."""
```
mapping `rule.name` → a `tests/plaza/test_retention_*.py` that mentions it.

- [ ] **Step 6:** `pytest tests/plaza/test_retention_*.py -q` (must actually run — if it reports "no PostgreSQL available", install Postgres 17 or export `TEST_DATABASE_URL` first; a skipped retention test proves nothing), then full `pytest -q`, then commit (`test(retention): one class, one file, one case per foreign key`).

---

## Task 8: R2 lifecycle rules, committed as config

**Files:** Create `ops/r2-lifecycle/parking-snapshots.json`, `ops/r2-lifecycle/tow-clips.json`, `ops/r2-lifecycle/lotlogic-docs.json`, `scripts/apply_r2_lifecycle.py`, `tests/test_r2_lifecycle_config.py`.

**Why a file and a script.** The rule that used to exist on `parking-snapshots` was deleted in April by a click, and the only record of it is a sentence in an audit. A rule in a repo can be reviewed, diffed and restored.

- [ ] **Step 1: `ops/r2-lifecycle/parking-snapshots.json`** — the S3 `LifecycleConfiguration` shape boto3 wants, with an `_comment` on each rule (boto3 ignores unknown keys at the top level, so keep comments in a sibling `_comments` object rather than inside a rule, and have the script strip it before the API call):

```json
{
  "_comments": {
    "debug-frames": "Sidecar empty-scene captures from bringing up a new camera model. Useful for about a fortnight. RETENTION.md A6.",
    "diag-frames": "Frames Plate Recognizer rejected, plus weak/no-plate reads. The material for tuning a camera that is reading badly. RETENTION.md A5.",
    "accepted-reads": "Every accepted plate photograph. 68,770 of them today. RETENTION.md A3.",
    "evidence": "The frame behind a filed violation, copied here at violation time by camera-snapshot so it outlives the read it came from. RETENTION.md A4 / spec fat decision 28.",
    "legacy-yolo": "services/storage.build_storage_key's prefixes. No writer since March; the YOLO pipeline is spec fat decision 3. RETENTION.md A7.",
    "legacy-flat-reads-<property>": "The back catalogue: reads written before Task 8a moved them under reads/. One rule per property UUID because that is what the old key shape allows. Delete these rules once the oldest flat key is past its period.",
    "abort-incomplete-uploads": "A failed multipart upload is billed and invisible. Nothing here uploads multipart today; the rule is cheap insurance."
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

- [ ] **Step 2:** Generate the `legacy-flat-reads-*` rules from production's actual property UUIDs (read-only query, `SELECT id FROM properties`), 11 of them, 365 days each, prefix `"<uuid>/"`. Commit them; they are deleted in a follow-up once the back catalogue ages out.

- [ ] **Step 3: `scripts/apply_r2_lifecycle.py`** — reads the JSON, strips `_comments`, calls `get_bucket_lifecycle_configuration`, prints a unified diff of live-vs-file, and calls `put_bucket_lifecycle_configuration` **only** with `--yes`. Default is diff-and-exit. It reuses `services.storage.get_r2_client()` so there is one credential path. Exit 1 on drift with no `--yes`, so it can be a CI check later.

- [ ] **Step 4: `tests/test_r2_lifecycle_config.py`** — pure JSON tests, no network: every rule ID unique; every `Days` matches the number in `docs/RETENTION.md` §5 (parse the table, same technique as Task 1); `evidence/` ≥ `reads/` (evidence must outlive the read it was copied from); no rule has an empty `Prefix` except the multipart abort.

- [ ] **Step 5:** `python scripts/apply_r2_lifecycle.py ops/r2-lifecycle/parking-snapshots.json` (diff only, no `--yes`) and paste the diff into the PR. **Do not apply.** Applying happens in Task 12, after Task 8a's keys exist — applying a `reads/` rule before anything writes `reads/` is harmless, but applying the `legacy-flat-reads-*` rules deletes the back catalogue on the spot.

- [ ] **Step 6:** commit (`feat(retention): R2 lifecycle rules as config, applied by a script that diffs first`).

---

## Task 8a: Key restructure — `reads/`, `diag/`, `debug/`, and the `evidence/` copy

**Files:** Modify `/Users/gabe/lotlogic/supabase/functions/camera-snapshot/index.ts` (lines ~391, ~628, ~903, ~977); tests in `supabase/functions/camera-snapshot/index.test.ts`.

> **CLAUDE.md trigger:** editing `supabase/functions/camera-snapshot/**` auto-dispatches `feature-dev:code-explorer` + `brainstormer` + `contrarian-reviewer` in parallel **before the first edit**, and `contrarian-reviewer` + `feature-dev:code-reviewer` after the deploy. Honour it. Also diff against `mcp__supabase__get_edge_function` before overwriting — the repo drifts from the deployed runtime.

- [ ] **Step 1:** Change the four key builders:

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
A **copy** (R2 `CopyObject` — no re-upload of the bytes), fire-and-forget with its own try/catch, because a failed evidence copy must not fail the violation. Log a warning and let the read's own 365-day copy be the fallback. Store the evidence key on the violation row in a new nullable `evidence_key text` column (migration; note that `alpr_violations.evidence_photo_url` already exists and is **NULL on all 2,494 rows and read by no code** — reuse it rather than adding a thirteenth column, and say so in the migration comment).

- [ ] **Step 3:** `plate_events.image_url` keeps pointing at the `reads/` object. Nothing is rewritten; the 68,770 existing flat keys stay valid and are covered by the `legacy-flat-reads-*` lifecycle rules.

- [ ] **Step 4:** Deno tests for all four key shapes and the copy; deploy with `supabase functions deploy camera-snapshot`; watch one live frame land under `reads/`.

- [ ] **Step 5:** commit (`feat(retention): prefix camera frames by kind so lifecycle rules can reach them`).

---

## Task 9: The two Supabase Storage buckets

**Files:** Create `migrations/$(date -u +%Y%m%d%H%M%S)_storage_buckets_private.sql`.

Measured: `plate-snapshots` is **public**, holds **0 objects**, and is referenced by **zero lines** of code in either repo (`grep -rn "plate-snapshots" frontend/ supabase/` → nothing). `tow-evidence` is private, 0 objects, 0 references. Both were created for designs that went to R2 instead.

- [ ] **Step 1:** Migration that flips `plate-snapshots` to private and documents both:

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

UPDATE storage.buckets SET public = false WHERE id = 'plate-snapshots';

COMMENT ON TABLE storage.objects IS
    'LotLogic stores no objects in Supabase Storage. Photographs, documents '
    'and tow clips live in Cloudflare R2 — see docs/RETENTION.md §5 for the '
    'bucket map and their lifecycle rules.';

-- Rollback:
-- UPDATE storage.buckets SET public = true WHERE id = 'plate-snapshots';
```

- [ ] **Step 2:** Apply via the Supabase MCP; verify `SELECT id, public FROM storage.buckets;` → both `false`.
- [ ] **Step 3:** commit (`chore(retention): the two empty Supabase Storage buckets are private`).

---

## Task 10: Presigned photo URLs everywhere a public r2.dev URL is served today

**Files:** Modify `routers/alpr.py` (or a new `routers/photos.py` if `alpr.py` has no natural home); modify `/Users/gabe/lotlogic/frontend/dashboard.html`; test `tests/plaza/test_photo_presign.py`.

### Where a public r2.dev URL is served today — the audit

| # | Surface | File | What it does |
|---|---|---|---|
| 1 | Pass list + parking log | `dashboard.html:3362, 3404` | joins `plate_events(image_url)` onto `visitor_passes` as `first_seen_image_url` |
| 2 | Violation queue | `dashboard.html:3560, 3702, 3721` | joins `plate_events(image_url)` onto `alpr_violations` |
| 3 | Recent reads strip | `dashboard.html:3577, 5176, 5211-5214` | `<img src={r.image_url}>` and `<a href={r.image_url}>` |
| 4 | Frame inspector / box overlay | `dashboard.html:3613, 3619, 4319` | `url: e.image_url` |
| 5 | Single-read lookup | `dashboard.html:3627-3631` | returns `image_url` |
| 6 | Read stream | `dashboard.html:3640` | `image_url` in the select list |
| 7 | Paired-gate snapshot | `dashboard.html:3753, 3765` | `_paired_snapshot_url` |
| 8 | Violation detail | `dashboard.html:5270, 7349, 7541, 7548, 9147` | `_snapshot_url`, tow/plate event images |
| 9 | Tuner page | `frontend/tuner.html` | reads `image_url` |
| 10 | **Tow-dispatch email** | `supabase/functions/tow-dispatch-email/index.ts:380, 393, 400` | pastes the URL into the email body and an `<img src>` — **Task 11** |
| 11 | Apartment ID / lease / plate docs | `routers/apartment_docs.py` | **already correct** — authenticated streaming proxy, `private, no-store`. Only the bucket moves (Task 12) |
| 12 | Tow clips | `routers/ops.py:527` | **already correct** — 15-minute presign. Only the bucket moves (Task 12) |

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
It reads `image_url`, derives the **key** by stripping `settings.r2_public_url` (and tolerating a key already stored as a bare key, which is what Task 8a onward will write), calls `storage.get_presigned_url(key, expires_in=900)`, and returns `{"url", "expires_at"}` with `Cache-Control: private, no-store`.

- [ ] **Step 2: stop storing the public URL.** Add `plate_events.image_key text` (migration, nullable, plus a backfill `UPDATE … SET image_key = replace(image_url, :public_base || '/', '')` run as a one-off in the same migration — 68,770 rows, a single statement, no FK involvement). New writes in `camera-snapshot` set both for one release; `image_url` is dropped in a follow-up once nothing reads it. **Do not drop it in this plan** — the dashboard is a 14,856-line file and Wave 2.6 is splitting it concurrently.

- [ ] **Step 3: the dashboard.** Add one helper beside `apiFetch`:

```js
// One place a photo URL is minted. Every `<img src>` and `<a href>` that used
// to take plate_events.image_url straight out of Supabase now goes through
// here: an authenticated fetch for a 15-minute presign, memoised per event id
// for 10 minutes so a list of 50 reads is 50 rows and not 50 round trips
// repeated on every re-render.
async function photoUrl(eventId) { … }
```
Repoint surfaces 1–9 in the table above. Surfaces 1, 2, 7 and 8 currently get the URL through a PostgREST join — change the select lists to fetch the event **id** instead of `image_url`, and resolve lazily when a thumbnail actually renders.

- [ ] **Step 4: tests.** `tests/plaza/test_photo_presign.py`: owner A cannot presign owner B's read (the cross-tenant assertion, mirroring `tests/e2e/access-control.spec.ts`); an unauthenticated call is 401; the response carries `private, no-store`; a read with no photo is 404; the presign TTL is 900 s. Add the matching cross-tenant assertion to `tests/e2e/access-control.spec.ts` — CLAUDE.md requires the backend route and the Playwright spec to land in the same PR.

- [ ] **Step 5:** commit (backend and frontend separately — two repos).

---

## Task 11: The tow-dispatch email — a 48-hour presign

**Files:** Modify `/Users/gabe/lotlogic/supabase/functions/tow-dispatch-email/index.ts` (lines 207, 380, 393–400).

The partner's email is the one photo consumer that genuinely cannot authenticate. It currently embeds the permanent public URL, which is why turning the public domain off would silently break every tow email ever sent.

- [ ] **Step 1:** Mint an S3 v4 presigned GET inside the edge function with the R2 credentials it already holds (`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_ACCOUNT_ID` / `R2_BUCKET_NAME`), TTL **172800 s (48 h)** — deliberately the same TTL as the HMAC action token the same email already mints for its Tow / No-Tow buttons. One expiry for the whole message: when the decision expires, so does the evidence link.

- [ ] **Step 2:** Replace both uses — the plain-text `PHOTO  {url}` line (:380) and the `<img src>` (:400). The alt text and layout do not change.

- [ ] **Step 3:** Add a line under the photo: *"This link expires in 48 hours — reply or use the dashboard after that."* An expired image in an old email should read as designed, not broken.

- [ ] **Step 4:** Deno test that the generated URL carries `X-Amz-Expires=172800` and a signature, and that a missing photo still renders the rest of the email (the existing `triggerEvent?.image_url ? … : null` guard shape is preserved).

- [ ] **Step 5:** Deploy (`supabase functions deploy tow-dispatch-email`), send one test dispatch with `EMAIL_OVERRIDE_TO` set to your own address, open the photo, then confirm it 403s after the TTL in a follow-up check. Commit.

---

## Task 12: Private buckets, then the public domain off

**Files:** `ops/r2-lifecycle/*.json` (apply), Railway variables, Cloudflare R2 settings, `docs/RETENTION.md` §5 table.

**This is a join. Do not start it until Tasks 8a, 10 and 11 are deployed and verified in production.**

- [ ] **Step 1:** Create two private R2 buckets: `tow-clips` and `lotlogic-docs`. No public domain on either.
- [ ] **Step 2:** Set `TOW_CLIPS_BUCKET=tow-clips` on the backend (Railway) and on `~/.config/lotlogic/r2.env` for `tow-clip-archiver`. The backend's warning — *"TOW_CLIPS_BUCKET is unset — presigning tow clip … from the public snapshot bucket"* — must stop appearing in the logs. Copy the 4 archived clips (742 MB) across and verify each presign resolves before deleting the originals.
- [ ] **Step 3:** Point `routers/apartment_docs.py` at `lotlogic-docs` via a new `Settings.r2_docs_bucket` (defaulting to `r2_bucket_name` so nothing breaks before the variable is set, exactly like `tow_clips_bucket`), copy the 319 `apt/` objects across, verify the proxy serves them, delete the originals.
- [ ] **Step 4:** Apply the lifecycle configurations: `python scripts/apply_r2_lifecycle.py ops/r2-lifecycle/*.json --yes`. Confirm with `get_bucket_lifecycle_configuration` on each bucket.
- [ ] **Step 5:** **Turn off the `pub-2b67cfea48564c9695230f8909348716.r2.dev` public domain on `parking-snapshots`.** Then verify, in this order:
  1. `curl -sI https://pub-2b67cfea48564c9695230f8909348716.r2.dev/<a known read key>` → **403/404**, not 200/206.
  2. Dashboard: thumbnails still render (Task 10).
  3. A fresh tow dispatch email: photo still renders (Task 11).
  4. `GET /ops/tow-sightings/{id}/clip`: still resolves (Task 12 Step 2).
  5. An apartment document through the proxy: still resolves (Step 3).
- [ ] **Step 6:** Update RETENTION.md §2's object-storage table and §6's last row to say the domain is off, with the date. Commit.

---

## Task 13: Go-live — seven nights, then the flag

**This is Gabe's decision, executed by Gabe or with his explicit go-ahead. An agent must not flip `RETENTION_ENABLED`.**

- [ ] **Step 1:** Task 6 has been deployed for **seven consecutive nights** with `RETENTION_ENABLED=false`. Confirm seven runs exist:
```sql
SELECT date_trunc('day', started_at)::date AS night, count(DISTINCT run_id) runs, count(*) class_rows
  FROM public.ops_retention_runs GROUP BY 1 ORDER BY 1;
```
- [ ] **Step 2:** Read the counts per class, and check each against this plan's measured inventory:
```sql
SELECT data_class, policy_ref, max(candidates) candidates, max(protected) protected,
       min(oldest_candidate_at)::date oldest, bool_or(truncated) truncated
  FROM public.ops_retention_runs
 WHERE started_at > now() - interval '8 days'
 GROUP BY 1, 2 ORDER BY 1;
```
  Expected on night one, from the 2026-09-14 measurements: `plate_event_raw_json` ≈ 27,280 candidates; `plate_event_row` ≈ 0 (nothing is 730 days old — the pipeline is five months old, so A2 correctly does nothing for another 19 months); `weak_plate_read` = 17,329 (the whole table); `plate_match_decision` a few hundred; `pass_contact` ≈ 2,142; `id_doc` / `lease_doc` / `pass_plate_photo` small double digits. **A class whose count is wildly different from this is a bug in the rule, not a surprise in the data — stop and find it.**
- [ ] **Step 3:** Confirm `protected > 0` for `plate_event_row`. A guard that never fires is a guard nobody has tested against production shapes.
- [ ] **Step 4:** Confirm `ops_findings` has no open `high` finding from `retention_sweep`.
- [ ] **Step 5:** Gabe answers the 15 questions in `docs/RETENTION.md` §7. Any "no" changes a `Settings` default, is committed, deployed, and adds **three more dry-run nights** for the classes that changed.
- [ ] **Step 6:** Set `RETENTION_ENABLED=true` on Railway. Watch the first live run: `SELECT * FROM ops_retention_runs WHERE mode='live' ORDER BY started_at DESC LIMIT 20;` and confirm `affected` matches the previous night's `candidates` within a few percent.
- [ ] **Step 7:** Remove the `> **STATUS: DRAFT — not in force.**` banner from `docs/RETENTION.md`, add the change-log row, commit.

---

## Decisions for Gabe

Each is one yes/no. **Execution can proceed through Tasks 1–12 in dry-run mode without any of these being answered** — the sweep counts and records, and nothing is deleted. They are needed before Task 13 only.

1. **Plate-read vendor JSON.** The camera vendor's raw payload — bounding boxes, MMC probability tables, retired-sidecar diagnostics — sits on all 72,480 plate reads, ~66 MB, 30+ keys each. → *Strip it after 90 days to the 12 fields we match on (plate, time, camera, photo and match all survive)?* **Recommended: yes.**
2. **Plate-read rows.** 72,480 reads; 26,569 of the 27,280 older than 90 days are referenced by no violation, session, tow sighting, pass or match decision. → *Delete an unreferenced plate read at 24 months?* **Recommended: yes** (nothing is that old yet; this arms it for 2028).
3. **Accepted plate photographs in R2.** 68,770 photos, kept forever since the lifecycle rule was deleted in April. → *Delete an accepted plate photo at 12 months?* **Recommended: yes.**
4. **Evidence photographs.** The frame behind a violation you invoiced for, copied to its own prefix so it outlives rule 3 (spec fat decision 28 asked 12 / 24 / forever). → *Keep evidence photos 24 months?* **Recommended: yes.**
5. **Diagnostic and rejected frames in R2.** Frames Plate Recognizer threw away; the material for tuning a badly-reading camera. → *Delete at 90 days?* **Recommended: yes.**
6. **Debug frames in R2.** Empty-scene captures from bringing up a new camera model. → *Delete at 14 days?* **Recommended: yes.**
7. **Weak plate reads.** 17,329 rows, nothing written since 19 May, 100% older than 90 days. → *Delete at 90 days — which clears the whole table on night one?* **Recommended: yes.**
8. **Driver phone numbers and emails.** 3,063 of 3,099 passes carry a phone; 2,142 of those passes ended more than 30 days ago. The pass row itself survives; only the contact columns are blanked. → *Blank the phone and email 30 days after the pass ends?* **Recommended: yes.**
9. **Payment contact phone.** All 10 plaza payments carry one, attached to a financial record you may need for a chargeback. → *Blank it at 13 months, keeping the payment row itself for 7 years?* **Recommended: yes.**
10. **Government-ID photographs.** 319 of them (314 guest, 5 resident), kept forever today, in a bucket with a public domain. → *Delete the ID photo 30 days after the registration is approved or rejected — pass end + 30 for one never reviewed?* **Recommended: yes.**
11. **Signed leases.** 5 of them, kept forever. → *Delete the lease 90 days after approval?* **Recommended: yes.**
12. **Plate photographs on a pass.** 319 of them. → *Delete 90 days after the pass ends?* **Recommended: yes.**
13. **Tow footage and archived clips.** Footage retention is already live and correct (`TOW_FOOTAGE_RETENTION_DAYS=10` plus per-camera overrides — north card ≈ 2.3 d, south ≈ 32 d); the 4 archived clips are 742 MB of tow proof. → *Leave the footage overrides exactly as they are, and give an archived clip the same 24 months as rule 4?* **Recommended: yes.**
14. **The public photo domain.** `pub-2b67cfea48564c9695230f8909348716.r2.dev` answers an unsigned GET for every plate photo, every apartment ID, every lease and every tow clip in `parking-snapshots`. → *Turn it off once the dashboard and the tow email are on presigned URLs (Tasks 10 and 11)?* **Recommended: yes.**
15. **Arming the sweep.** → *Run the sweep in dry-run for seven nights, then flip `RETENTION_ENABLED=true` if the counts match this plan's measured inventory?* **Recommended: yes.**
