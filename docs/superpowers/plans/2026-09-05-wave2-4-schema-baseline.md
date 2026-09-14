# Wave 2.4 — Rebuildable Schema Baseline, One Migration Runner, Drift Check in CI

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the LotLogic production schema something you *build* rather than a place you *edit*. At the end of this plan a fresh empty Postgres 17 can be turned into a byte-for-byte-equivalent copy of the production `public` schema by one command, CI proves that on every pull request, and a second CI job fails when a migration file has no applied record in production (or vice versa).

**Architecture:** One baseline dump seals 176 applied migrations into a single file. One 14-line-convention directory (`lotlogic-backend/migrations/`) is canonical. One `psql`-based runner applies the baseline, records the sealed history into `supabase_migrations.schema_migrations` without re-running it, then applies only post-baseline files. One normalizer turns any `pg_dump --schema-only` into an order-independent canonical form, so "rebuild from scratch" and "what prod actually looks like" can be diffed as text.

**Tech Stack:** Postgres 17.6 (Supabase project `nzdkoouoaedbbccraoti`), `pg_dump`/`psql` 17 client, Supabase CLI 2.90.0 (already authenticated on Gabe's Mac), GitHub Actions with a `postgres:17` service container, Python 3.11 stdlib (no new dependencies — the backend has `asyncpg` only, no `psycopg2`).

**Spec:** `docs/superpowers/specs/2026-09-03-enterprise-readiness-program.md` — §3 Wave 2 item **2.4**, merging findings **DB-4, BACKEND-12, DEL-7, FAT-11, PIPE-13, DB-11, BACKEND-10** (Appendix A, lines 338–471). §5 systemic moves and the `RECOVERY.md` pointer are in force. Read the 2.4 row and Appendix A rows for those seven IDs before Task 0.

**Blocks:** Wave 2.1 (`properties.config`) and Wave 2.5 (retention deletes). Neither may start before Task 7 is green.
**Runs alongside:** Wave 2.7 (`docs/superpowers/plans/2026-09-05-wave2-7-monitoring-spine.md` — `ops_job_runs`, `outbound_notices`). See "Contract with Wave 2.7" below — this plan does **not** rename or move the directory 2.7 writes into.

**Worktrees:**
- Backend (canonical, where almost everything lands): create `/Users/gabe/lotlogic-backend-schema` from `origin/main` on branch `wave2/schema-baseline`. Do **not** work in `/Users/gabe/lotlogic-backend/.worktrees/uptime` — that worktree is on `ops/uptime-probe` and belongs to Wave 1.
- Frontend (deletes only): create `/Users/gabe/lotlogic-schema` from `origin/main` on branch `wave2/schema-baseline`. Do **not** work in `/Users/gabe/lotlogic` — it is on `feat/apartment-permit-registry` with uncommitted changes to `frontend/dashboard.html` and `frontend/index.html`.

**Test baseline:** `cd /Users/gabe/lotlogic-backend-schema && .venv/bin/pytest -q` before Task 0; record the number. No task in this plan changes application code, so that number must not move.

---

## Measured inventory (2026-09-05, read-only against production)

Every number below was measured, not estimated. Task 0 re-measures and commits them; if a number has moved, the plan's task text is what changes, not the numbers.

| Fact | Value |
|---|---|
| Applied migration records (`supabase_migrations.schema_migrations`) | **176** (175 distinct names; `truck_plaza_passes` recorded twice) |
| Version range | `20260318144400` → `20260903141703` |
| Applied records with `statements` populated | **176 / 176** — the full SQL of every applied migration is recoverable from the ledger |
| Backend migration files (`lotlogic-backend/migrations/*.sql`) | **127** (126 distinct names; `passes_vehicle_type_column.sql` appears twice) |
| Frontend migration files (`lotlogic/migrations/*.sql`) | **25** numbered + 1 in `migrations/ops/` |
| Applied with **no file in either repo** | **37** |
| Backend files with **no applied record** | **3** (`account_passwords`, `rls_property_scope`, `visitor_passes_cooldown_indexes`) — all three are in fact *in* production under different recorded names |
| Frontend files with **no applied record** | **6** — 4 are applied under other names, **2 are genuinely absent from production** (`009_marketing_seo`, `025_visitor_passes_search_indexes`) |
| Frontend files duplicating a backend file | **4** (`alpr_parking_pass`, `alpr_indexes_constraints`, `landing_pages`, `leadgen_agent`) — this is PIPE-13's "same migration in two repos" |
| public tables / views / matviews | 51 / 3 (`properties_public`, `v_camera_uptime_vs_weather`, `v_violation_billing_status`) / 1 (`lot_stats`) |
| public functions / RLS policies / triggers | 70 / 86 / 28 |
| indexes / sequences / FK constraints / CHECK constraints | 217 / 12 / 88 / 48 |
| generated columns | 2 — `enforcement_partners.tow_fee = (tow_fee_cents / 100)`, `.boot_fee = (boot_fee_cents / 100)` |
| enum types in public | 0 |
| pg_cron jobs | **8** (4 of them **inactive**) — `recovery/pg_cron.sql` documents 6 and marks none inactive |
| Extensions installed **in `public`** | `fuzzystrmatch` 1.2, `pg_trgm` 1.6 — these appear in a `--schema=public` dump and must exist in CI |
| Extensions outside `public` | `pg_cron` (pg_catalog), `pg_net`, `pg_stat_statements`, `pgcrypto`, `uuid-ossp` (extensions), `supabase_vault` (vault), `plpgsql` |
| public objects referencing `auth.*` | **2 RLS policies** (`plate_events.plate_events_admin_label`, `fuzzy_match_runs.fuzzy_match_runs_admin_read`), both `auth.jwt()`. **Zero** public functions reference `auth.*`, `net.*`, `vault.*` or `cron.*`. |
| Column defaults needing non-`public` functions | `gen_random_uuid()` (built-in in PG17 ✓) and unqualified `uuid_generate_v4()` (needs `uuid-ossp` in an `extensions` schema on the search path) |
| Roles referenced by policies/grants | `anon` (1 policy), `authenticated` (69 policies), `service_role`, `postgres` |

### Corrections to the spec and to committed docs — read these before writing any code

1. **`supabase-schema.sql` has no blocker.** Spec fat item ❓11 says the file "is the only origin of `permitted_vehicles` and `action_logs`, which the dashboard reads and writes". Measured: **neither table exists in production**, and `grep` across both repos finds them referenced *only inside `supabase-schema.sql` itself*. There is nothing to resolve — Task 11 deletes the file outright, no question to Gabe.
2. **The frontend migrations are at `lotlogic/migrations/`, not `lotlogic/supabase/migrations/`.** `lotlogic/supabase/` contains only `config.toml`, `functions/` and `.temp/`. There are 25 numbered files (`001_…` → `025_…`) plus `migrations/ops/2026-04-20-register-charlotte-cameras.sql`, which is a *seed*, not a migration.
3. **The baseline dump needs no new secret from Gabe.** `supabase db dump --linked` was verified working from `/Users/gabe/lotlogic` (already linked to `nzdkoouoaedbbccraoti`, `supabase/.temp/linked-project.json` present). The CLI mints a temporary `cli_login_postgres` role from the stored access token — **no DB password prompt**. `supabase migration list --linked` was also verified working the same way.
4. **`recovery/pg_cron.sql` is wrong in three ways.** Live `cron.job` has 8 jobs; the file has 6. `plate_sessions_sweep` runs `*/3 * * * *`, the file says `* * * * *`. Four jobs are `active = false` in production (`plate_pair_learn`, `weather_pull_6h`, `weather_risk_eval_6h`, `no_reg_sweep`) and the file would re-enable all of them on a restore. Two live jobs are absent from the file entirely (`prune_camera_snapshot_diag`, `purge_cron_job_run_details`). Task 3 replaces it.
5. **`puller/migrate.py` is a third, undeclared migration runner** (`lotlogic/puller/migrate.py`, run by `Dockerfile.migrate`). It `ALTER TABLE cameras ADD COLUMN IF NOT EXISTS` × 13. It is **not wired to a live Railway service** — `puller/railway.toml` builds `Dockerfile`, not `Dockerfile.migrate`. Task 11 deletes it.
6. **`009_marketing_seo` is dead and its consumers are already broken.** `blog_posts`, `reddit_leads` and `funnel_events` do not exist in production, but `lotlogic/agent/tools.py`, `agent/prompt.py`, `leadgen/reddit_monitor.py` and `leadgen/blog.py` read them. That is a live leadgen bug, **out of scope for this plan** — record it, do not fix it.
7. **`20260417024653_account_passwords.sql` landed only half.** `lot_owners.password_hash` exists; its unique index `ix_lot_owners_email_active` does **not**. The applied record is `20260417155407_repair_account_passwords_migration`. The baseline captures reality (no index); whether the index should exist is a separate question — see Open Decisions.
8. **The backend's `CLAUDE.md` already specifies this convention** (§"Database Migrations", lines 205–212): `migrations/`, `YYYYMMDDHHMMSS_snake_case.sql`, version = timestamp, name = filename minus prefix, recorded in `supabase_migrations.schema_migrations`. This plan does not invent a convention; it enforces the one already written down. `CLAUDE.md` line 261 literally proposes this CI check as a known bottleneck.
9. **The frontend's `CLAUDE.md` line 64 already says the backend repo is the source of truth** for migrations. Choosing the backend's directory as canonical contradicts nothing.

---

## Global Constraints

- **Canonical migration directory: `lotlogic-backend/migrations/`.** It is not renamed, not moved, not re-numbered, and not made into a package by this plan. Every existing file keeps its exact filename. This is the contract Wave 2.7 depends on.
- **Canonical naming: `YYYYMMDDHHMMSS_snake_case.sql`**, 14-digit UTC timestamp. One existing file violates it — `20260818_visitor_passes_cooldown_indexes.sql` (8 digits). Task 6 renames **that file only**, to `20260818111839_visitor_passes_cooldown_indexes.sql` (the version of its first recorded half).
- **Canonical ledger: `supabase_migrations.schema_migrations`.** Do **not** create a `public.schema_migrations`. Reasons, in order: (a) it already holds 176 rows of real history including the full SQL text of every applied migration; (b) it is what the Supabase MCP `apply_migration` tool and the Supabase CLI already write to, so no existing workflow has to change; (c) `CLAUDE.md` already documents it as the ledger; (d) a second ledger is a second thing that can drift, which is the exact bug this plan closes.
- **Match by `name`, not `version`.** Production versions are stamped by `apply_migration` at apply time and routinely differ from the filename timestamp (file `20260903131539_partner_fees_to_cents.sql` is recorded as version `20260903141703`). Every drift comparison in this plan keys on the **name** (filename minus the timestamp prefix, minus `.sql`). Version mismatch is a *warning*, never a failure.
- **The baseline is applied, the sealed history is recorded.** Nothing in `0000_baseline.manifest.txt` is ever re-executed. Pre-baseline migrations reference tables that were later dropped, roles that no longer exist, and data that no longer matches; replaying them is not a rebuild, it is archaeology.
- **Production is read-only for the whole of this plan.** No `mcp__supabase__apply_migration`, no `supabase db push`, no writes of any kind to `nzdkoouoaedbbccraoti`. Every prod interaction is `SELECT` or `pg_dump`. If a task appears to need a prod write, stop and put it in Open Decisions.
- **No new Python dependencies.** The backend has `asyncpg` and no `psycopg2`. The runner and the drift check use `psql` (present on GitHub runners and via Homebrew on the Mac) driven from `bash`, plus Python 3.11 **stdlib only** for normalizing and diffing.
- **Pin the client version.** Prod is Postgres 17.6; the CI service is `postgres:17`; Gabe's Mac has `pg_dump` **18.3**, which emits `\restrict` psql meta-commands PG17 does not. Every dump that gets committed or compared must be produced by a **17.x** client. `scripts/db/dump_schema.sh` asserts this and exits 1 otherwise.
- **The dump is `--schema=public` only.** `auth`, `storage`, `realtime`, `vault`, `cron`, `net`, `extensions`, `graphql*`, `supabase_functions` and `supabase_migrations` are Supabase-platform-managed; they are excluded and must stay excluded, or the "rebuild" becomes "reinstall Supabase".
- **Schema only. No data. Ever.** `plate_events` and `visitor_passes` hold plate reads, phone numbers and photo URLs. Nothing in this plan may produce a file containing a row of production data. The one exception is `cron.job` definitions, which are configuration expressed as rows — Task 3 handles them as a **seed script**, not a data dump.
- **One commit per task**, on `wave2/schema-baseline` in the worktree the task names. Never `--force`, never rebase, never push unless the task says so.
- **Nothing is deployed by implementers.** These tasks produce files and CI jobs. Gabe adds the one required GitHub secret (Task 8) and runs the one-time verification in Task 12.

### Contract with Wave 2.7 (`ops_job_runs`, `outbound_notices`)

Verified against 2.7's own plan (§Global Constraints line 28, §file table lines 54–55): it adds `migrations/20260905*_ops_job_runs.sql` and optionally `migrations/20260905*_outbound_notices.sql`, using the same `YYYYMMDDHHMMSS_snake_case.sql` convention and the same ledger. Nothing here needs to change for it. Specifically:
- **File location:** `lotlogic-backend/migrations/` — unchanged by this plan.
- **File name:** `20260905HHMMSS_ops_job_runs.sql`, timestamp from `date -u +%Y%m%d%H%M%S`, which is **later than the cutover `20260903141703`** and therefore automatically post-baseline. No coordination needed.
- **How it gets applied:** `mcp__supabase__apply_migration` with `name = "ops_job_runs"` (exactly the filename minus prefix and `.sql`), or `supabase migration up`. Both write the ledger row. A raw SQL Editor run does not, and will fail Task 8's drift job.
- **What 2.7 must not do:** do not add the table to `0000_baseline.sql`, do not touch `0000_baseline.manifest.txt`, do not regenerate `expected_schema.sql` by hand — Task 7's CI job regenerates it and 2.7's PR simply includes the regenerated file (Task 7 prints the exact command to do that).

---

### Task 0: Worktrees, and commit the inventory as a script plus a generated table

**Files:**
- Create: `lotlogic-backend-schema/scripts/db/inventory.sql`
- Create: `lotlogic-backend-schema/docs/db/schema-inventory.md`

**Set up first:**
```bash
cd /Users/gabe/lotlogic-backend && git fetch origin && \
  git worktree add /Users/gabe/lotlogic-backend-schema -b wave2/schema-baseline origin/main
cd /Users/gabe/lotlogic && git fetch origin && \
  git worktree add /Users/gabe/lotlogic-schema -b wave2/schema-baseline origin/main
```

**`scripts/db/inventory.sql`** — one file, run against any database, prints the object census. This is the thing that gets re-run after every restore and in Task 10's runbook.
```sql
-- scripts/db/inventory.sql — object census for the public schema.
-- Usage: psql "$DATABASE_URL" -qAtF'|' -f scripts/db/inventory.sql
select 'tables',            count(*)::text from pg_tables         where schemaname='public'
union all select 'views',   count(*)::text from pg_views          where schemaname='public'
union all select 'matviews',count(*)::text from pg_matviews       where schemaname='public'
union all select 'functions',count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
union all select 'policies',count(*)::text from pg_policies       where schemaname='public'
union all select 'triggers',count(*)::text from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal
union all select 'indexes', count(*)::text from pg_indexes        where schemaname='public'
union all select 'sequences',count(*)::text from pg_sequences     where schemaname='public'
union all select 'fk_constraints',count(*)::text from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname='public' and c.contype='f'
union all select 'check_constraints',count(*)::text from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname='public' and c.contype='c'
union all select 'generated_columns',count(*)::text from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and a.attgenerated<>''
union all select 'extensions_in_public',count(*)::text from pg_extension e join pg_namespace n on n.oid=e.extnamespace where n.nspname='public'
order by 1;
```

**The three inventory queries** (run read-only against prod via `mcp__supabase__execute_sql`; results go into the generated doc):
```sql
-- (a) the ledger
select version, name from supabase_migrations.schema_migrations order by version;
-- (b) cron, including the inactive ones recovery/pg_cron.sql hides
select jobid, jobname, schedule, active, command from cron.job order by jobid;
-- (c) extensions and where they live
select e.extname, n.nspname as schema, e.extversion
from pg_extension e join pg_namespace n on n.oid=e.extnamespace order by 1;
```

**`docs/db/schema-inventory.md`** carries this table template, filled from (a) diffed against `ls migrations/`. Normalise both sides with: strip `.sql`, strip every leading `<digits>_` group, lowercase.

| Bucket | Count | Meaning | Disposition |
|---|---|---|---|
| Applied **and** filed in backend | 123 | healthy | left alone |
| Applied, **no file anywhere** | 37 | the DB-4 hole | recovered to `migrations/_archive/` (Task 5); sealed by the baseline |
| Backend file, **no applied record** | 3 | recorded under another name | listed in the manifest as aliases (Task 2) |
| Frontend file, applied under another name | 19 | PIPE-13 duplication | deleted (Task 6) |
| Frontend file, **never applied, objects absent** | 2 | dead | archived, not applied (Task 6) |
| Frontend file, duplicates a backend file | 4 | PIPE-13 | deleted (Task 6) |

**Verification:**
```bash
cd /Users/gabe/lotlogic-backend-schema && \
  test -f scripts/db/inventory.sql && test -f docs/db/schema-inventory.md && \
  grep -q '^| Applied, \*\*no file anywhere\*\* | 37 |' docs/db/schema-inventory.md && echo OK
```

**Commit:** `docs(db): inventory production schema and migration ledger vs files`

---

### Task 1: The one dump normalizer both CI and humans use

Two `pg_dump --schema-only` runs of the *same* schema on two different servers differ in header comments, `SET` lines, and statement order. A text diff of raw dumps is useless. This task makes dumps comparable.

**Files:**
- Create: `lotlogic-backend-schema/scripts/db/dump_schema.sh`
- Create: `lotlogic-backend-schema/scripts/db/normalize_dump.py`
- Create: `lotlogic-backend-schema/tests/test_schema_tooling.py`

**`scripts/db/dump_schema.sh`:**
```bash
#!/usr/bin/env bash
# Dump the public schema of $1 in a canonical, comparable form on stdout.
# The ONLY dump path in this repo. Used by: the baseline (Task 2), the CI
# rebuild check (Task 7), and any human re-dump after a restore (Task 10).
set -euo pipefail

DB_URL="${1:?usage: dump_schema.sh <postgres-url>}"
PG_DUMP="${PG_DUMP:-pg_dump}"

# Prod is 17.6 and CI is postgres:17. An 18.x client emits \restrict meta-
# commands and reorders ACLs; a 16.x client cannot read PG17 catalogs. Pin it.
ver="$("$PG_DUMP" --version | grep -oE '[0-9]+' | head -1)"
if [ "$ver" != "17" ]; then
  echo "dump_schema.sh: need pg_dump 17.x, found $ver." >&2
  echo "  macOS:  brew install postgresql@17 && export PG_DUMP=/opt/homebrew/opt/postgresql@17/bin/pg_dump" >&2
  echo "  ubuntu: apt-get install -y postgresql-client-17  (PGDG repo)" >&2
  exit 1
fi

"$PG_DUMP" "$DB_URL" \
  --schema-only \
  --schema=public \
  --no-owner \
  --quote-all-identifiers \
  | python3 "$(dirname "$0")/normalize_dump.py"
```

**`scripts/db/normalize_dump.py`** — stdlib only. `pg_dump` separates statements with a blank line, so paragraph-splitting is a safe statement split even through `$$`-quoted function bodies. Sorting the paragraphs makes the result independent of dump order (which follows OIDs, and OIDs differ between prod and a fresh rebuild).
```python
#!/usr/bin/env python3
"""Canonicalize a pg_dump --schema-only stream so two servers can be diffed.

Reads a dump on stdin, writes one line per statement on stdout, sorted.
Newlines inside a statement become the literal two characters '\\n', so the
output is line-oriented and `diff` points at the statement that changed.

Dropped: psql meta-commands, session GUCs, comment-only lines, ownership.
Kept:    everything that defines shape or access -- tables, columns, defaults,
         constraints, indexes, functions, triggers, policies, GRANT/REVOKE,
         CREATE EXTENSION, COMMENT ON.
"""
import re
import sys

DROP_LINE = re.compile(
    r"^\s*(--"                       # comment-only lines (incl. the header)
    r"|\\(un)?restrict\b"            # PG18 psql meta-commands
    r"|SET\s"                        # session GUCs: search_path, client_encoding, ...
    r"|SELECT\s+pg_catalog\.set_config"
    r"|ALTER\s+.*\sOWNER\s+TO\s"     # --no-owner should remove these; belt and braces
    r")",
    re.IGNORECASE,
)


def main() -> int:
    kept = [ln.rstrip() for ln in sys.stdin.read().splitlines() if not DROP_LINE.match(ln)]
    paragraphs, current = [], []
    for line in kept:
        if line.strip():
            current.append(line.strip())
        elif current:
            paragraphs.append(current)
            current = []
    if current:
        paragraphs.append(current)
    for p in sorted("\\n".join(p) for p in paragraphs):
        print(p)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

**`tests/test_schema_tooling.py`** — proves the normalizer is order-independent and drops what it claims to:
```python
import subprocess, sys, pathlib

NORM = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "db" / "normalize_dump.py"


def norm(text: str) -> str:
    return subprocess.run(
        [sys.executable, str(NORM)], input=text, capture_output=True, text=True, check=True
    ).stdout


def test_statement_order_does_not_matter():
    a = 'CREATE TABLE "a" (\n    "x" integer\n);\n\nCREATE TABLE "b" (\n    "y" integer\n);\n'
    b = 'CREATE TABLE "b" (\n    "y" integer\n);\n\nCREATE TABLE "a" (\n    "x" integer\n);\n'
    assert norm(a) == norm(b)


def test_noise_is_dropped():
    out = norm(
        "-- PostgreSQL database dump\n"
        "\\restrict abc\n"
        "SET search_path = public;\n"
        "SELECT pg_catalog.set_config('search_path', '', false);\n"
        'ALTER TABLE "public"."a" OWNER TO "postgres";\n'
        "\n"
        'CREATE TABLE "a" (\n    "x" integer\n);\n'
    )
    assert out.strip() == 'CREATE TABLE "a" (\\n"x" integer\\n);'


def test_grants_and_policies_survive():
    out = norm('GRANT SELECT ON TABLE "public"."a" TO "anon";\n')
    assert "GRANT SELECT" in out and "anon" in out
```

**Verification:**
```bash
cd /Users/gabe/lotlogic-backend-schema && chmod +x scripts/db/dump_schema.sh && \
  .venv/bin/pytest tests/test_schema_tooling.py -q
```
Expected: `3 passed`. Backend suite total must equal the Task 0 baseline **+3**.

**Commit:** `feat(db): canonical schema dump + normalizer used by every drift check`

---

### Task 2: Dump `0000_baseline.sql` and freeze the sealed history manifest

**Files:**
- Create: `lotlogic-backend-schema/migrations/0000_baseline.sql` (generated, committed)
- Create: `lotlogic-backend-schema/migrations/0000_baseline.manifest.txt` (generated, committed)
- Create: `lotlogic-backend-schema/scripts/db/make_baseline.sh`

**Why a manifest and not 176 reconstructed files:** the drift check must compare two *equal-sized* sets. Making them equal by fabricating 37 files from ledger SQL that will never be executed is busywork that invites someone to run it. Instead the manifest declares "these 176 names are inside `0000_baseline.sql`; the runner records them and never runs them", and the drift check compares only what came *after* the cutover. History is preserved for forensics separately (Task 5).

**`scripts/db/make_baseline.sh`** — run once, by hand, on Gabe's Mac. It needs no secret: `supabase db dump --linked` was verified to mint a temporary `cli_login_postgres` role from the already-stored access token, and `/Users/gabe/lotlogic` is already linked to `nzdkoouoaedbbccraoti`.
```bash
#!/usr/bin/env bash
# Regenerate migrations/0000_baseline.sql and its manifest from production.
# Run from the backend worktree. Requires: a PG17 pg_dump, and either
# PROD_DATABASE_URL, or the Supabase CLI already linked at $LINKED_DIR.
set -euo pipefail
cd "$(dirname "$0")/../.."
LINKED_DIR="${LINKED_DIR:-/Users/gabe/lotlogic}"

if [ -n "${PROD_DATABASE_URL:-}" ]; then
  scripts/db/dump_schema.sh "$PROD_DATABASE_URL" > migrations/0000_baseline.sql
else
  # Extract the CLI's temporary credentials, then use OUR dump path, so the
  # baseline is normalized identically to every dump CI ever takes.
  eval "$(cd "$LINKED_DIR" && supabase db dump --linked --dry-run 2>/dev/null | grep '^export PG')"
  scripts/db/dump_schema.sh \
    "postgresql://${PGUSER}:${PGPASSWORD}@${PGHOST}:${PGPORT}/${PGDATABASE}" \
    > migrations/0000_baseline.sql
fi

wc -l migrations/0000_baseline.sql
```

**`migrations/0000_baseline.manifest.txt`** — generated from the ledger, `version|name`, one per line, sorted by version, with a header. Produce it with:
```sql
select version || '|' || name as row
from supabase_migrations.schema_migrations order by version;
```
Header to prepend verbatim:
```
# 0000_baseline.manifest.txt — the migration history SEALED INTO 0000_baseline.sql.
# cutover_version: 20260903141703
# generated: 2026-09-05  rows: 176
#
# The runner RECORDS every row below into supabase_migrations.schema_migrations
# after applying 0000_baseline.sql. It NEVER re-executes them. Do not add rows
# by hand: a migration authored after the cutover is a FILE in migrations/, and
# the runner applies it normally.
#
# Three backend files have no row here because production recorded them under a
# different name. They are inside the baseline; the aliases are:
#   20260417024653_account_passwords.sql          -> 20260417155407 repair_account_passwords_migration (PARTIAL: columns landed, ix_lot_owners_email_active did not)
#   20260417025411_rls_property_scope.sql         -> 20260417154008 tighten_rls_policies + 20260417154411 restore_rls_policies_for_operational_tables
#   20260818_visitor_passes_cooldown_indexes.sql  -> 20260818111839 visitor_passes_cooldown_flagged_partial_idx + 20260818111936 visitor_passes_cooldown_key_expr_idx
```

**Sanity checks the implementer must run on the produced baseline before committing:**
```bash
cd /Users/gabe/lotlogic-backend-schema
grep -c '^CREATE TABLE' migrations/0000_baseline.sql          # expect 51
grep -c '^CREATE POLICY' migrations/0000_baseline.sql         # expect 86
grep -c '^CREATE INDEX\|^CREATE UNIQUE INDEX' migrations/0000_baseline.sql  # expect ~205 (217 minus PK-backed)
grep -c 'CREATE EXTENSION' migrations/0000_baseline.sql       # expect 2 (pg_trgm, fuzzystrmatch)
grep -c 'plate_text\|visitor_name\|phone' migrations/0000_baseline.sql  # column names only
grep -niE "INSERT INTO|COPY .* FROM stdin" migrations/0000_baseline.sql # MUST be empty — no data
wc -l migrations/0000_baseline.manifest.txt                   # expect 176 + 13 header lines
```

**Verification:**
```bash
cd /Users/gabe/lotlogic-backend-schema && \
  test -s migrations/0000_baseline.sql && \
  ! grep -qiE "^INSERT INTO|^COPY " migrations/0000_baseline.sql && \
  [ "$(grep -c '|' migrations/0000_baseline.manifest.txt)" -eq 176 ] && \
  grep -q '^# cutover_version: 20260903141703$' migrations/0000_baseline.manifest.txt && echo OK
```

**Commit:** `feat(db): 0000_baseline schema dump + sealed-history manifest (176 migrations)`

---

### Task 3: The two things a schema dump cannot carry — cron jobs and the role/auth shim

`cron.schedule()` writes rows into `cron.job`; a `--schema=public` dump contains none of it, and `recovery/pg_cron.sql` is measurably stale (see Corrections §4). Separately, a fresh Postgres has no `anon`/`authenticated`/`service_role` roles and no `auth.jwt()`, so the baseline's 86 policies and its GRANTs cannot even parse.

**Files:**
- Create: `lotlogic-backend-schema/migrations/0000_baseline.cron.sql`
- Create: `lotlogic-backend-schema/migrations/0000_baseline.prereqs.sql`
- Delete: `lotlogic-backend-schema/recovery/pg_cron.sql` (superseded; Task 10 re-points the docs)

**`migrations/0000_baseline.cron.sql`** — generated from live `cron.job`, **preserving `active`**. Generate the body with:
```sql
select format(
  E'select cron.schedule(%L, %L, $job$%s$job$);\n%s',
  jobname, schedule, command,
  case when active then '' else format(E'update cron.job set active = false where jobname = %L;\n', jobname) end
)
from cron.job order by jobid;
```
Header, verbatim:
```sql
-- 0000_baseline.cron.sql — pg_cron schedule, captured live 2026-09-05.
-- NOT part of the schema and NOT applied by the runner or by CI: the CI
-- Postgres has no pg_cron and no pg_net. This is a RESTORE seed, run by hand
-- against a freshly restored Supabase project (see RECOVERY.md §10).
--
-- 8 jobs. FOUR ARE INACTIVE IN PRODUCTION and are recreated inactive here;
-- do not "fix" that -- turning them on is a product decision, not a restore step:
--   plate_pair_learn, weather_pull_6h, weather_risk_eval_6h, no_reg_sweep
-- Verify after running:
--   select jobid, jobname, schedule, active from cron.job order by jobid;
```

**`migrations/0000_baseline.prereqs.sql`** — what a non-Supabase Postgres needs before `0000_baseline.sql` will apply. Applied by the runner **only** when the roles are absent, so it is a no-op against Supabase.
```sql
-- 0000_baseline.prereqs.sql — makes a stock Postgres 17 able to accept
-- 0000_baseline.sql. On Supabase every object below already exists and every
-- statement is a no-op. Measured need (2026-09-05):
--   * 69 policies name role "authenticated", 1 names "anon"; GRANTs name
--     "anon", "authenticated", "service_role".
--   * 2 policies call auth.jwt(): plate_events.plate_events_admin_label and
--     fuzzy_match_runs.fuzzy_match_runs_admin_read. NO public function
--     references auth.*, net.*, vault.* or cron.*.
--   * Column defaults call unqualified uuid_generate_v4(), which resolves
--     through Supabase's search_path entry for the "extensions" schema.

do $$ begin
  create role "anon" nologin noinherit;                exception when duplicate_object then null; end $$;
do $$ begin
  create role "authenticated" nologin noinherit;       exception when duplicate_object then null; end $$;
do $$ begin
  create role "service_role" nologin noinherit bypassrls; exception when duplicate_object then null; end $$;

create schema if not exists "extensions";
create extension if not exists "uuid-ossp" with schema "extensions";
create extension if not exists "pgcrypto"  with schema "extensions";
-- pg_trgm and fuzzystrmatch live in public on production; 0000_baseline.sql
-- creates them itself. Both ship with the official postgres:17 image.

-- Minimal auth shim. Supabase's real auth.jwt() reads a request-local GUC;
-- this returns an empty object so the two admin policies parse and evaluate
-- to false. It is never installed on Supabase (schema already exists there).
create schema if not exists "auth";
create or replace function "auth"."jwt"() returns jsonb
  language sql stable as $$ select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
create or replace function "auth"."uid"() returns uuid
  language sql stable as $$ select nullif(auth.jwt()->>'sub','')::uuid $$;
create or replace function "auth"."role"() returns text
  language sql stable as $$ select auth.jwt()->>'role' $$;

alter database current_database_placeholder set search_path = "public", "extensions";
```
> The `alter database` line cannot use a placeholder in real SQL — the runner substitutes it. Write the last line as a comment in the file and have `migrate.sh` issue
> `ALTER DATABASE "<current db>" SET search_path = "public","extensions";` via `\gexec`, or simply `SET search_path` per session. Prefer the per-session `SET`, so the file stays a plain script: replace that line with `-- search_path is set per-session by scripts/db/migrate.sh`.

**Verification:**
```bash
cd /Users/gabe/lotlogic-backend-schema && \
  [ "$(grep -c 'cron.schedule(' migrations/0000_baseline.cron.sql)" -eq 8 ] && \
  [ "$(grep -c 'set active = false' migrations/0000_baseline.cron.sql)" -eq 4 ] && \
  grep -q 'create role "authenticated"' migrations/0000_baseline.prereqs.sql && \
  ! test -f recovery/pg_cron.sql && echo OK
```

**Commit:** `feat(db): live cron seed (8 jobs, 4 inactive) + stock-Postgres prereqs; drop stale recovery/pg_cron.sql`

---

### Task 4: The runner

One script, usable from CI and by hand, that turns an empty database into production's schema and keeps the ledger honest.

**Files:**
- Create: `lotlogic-backend-schema/scripts/db/migrate.sh`

```bash
#!/usr/bin/env bash
# migrate.sh — the one migration runner.
#
#   scripts/db/migrate.sh <DATABASE_URL> [--baseline] [--dry-run]
#
# Ledger: supabase_migrations.schema_migrations (version text, name text).
# Ordering: filename. Matching: NAME, because production versions are stamped
# at apply time by apply_migration and routinely differ from the filename.
#
# --baseline : the database is empty. Apply prereqs + 0000_baseline.sql, then
#              RECORD (never execute) every row of 0000_baseline.manifest.txt.
# --dry-run  : print what would run, touch nothing.
#
# migrations/_archive/ is forensic and is never applied or considered.
set -euo pipefail
cd "$(dirname "$0")/../.."

DB_URL="${1:?usage: migrate.sh <postgres-url> [--baseline] [--dry-run]}"; shift
BASELINE=0; DRY=0
for a in "$@"; do
  case "$a" in
    --baseline) BASELINE=1 ;;
    --dry-run)  DRY=1 ;;
    *) echo "unknown flag: $a" >&2; exit 2 ;;
  esac
done

PSQL=(psql "$DB_URL" -v ON_ERROR_STOP=1 -q --no-psqlrc)
run() { if [ "$DRY" = 1 ]; then echo "WOULD RUN: $*"; else "${PSQL[@]}" "$@"; fi; }

# --- ledger ---------------------------------------------------------------
run -c 'create schema if not exists supabase_migrations;
        create table if not exists supabase_migrations.schema_migrations (
          version text primary key, statements text[], name text,
          created_by text, idempotency_key text unique, rollback text[]);'

applied_names() {
  psql "$DB_URL" -qAt --no-psqlrc \
    -c "select coalesce(name,'') from supabase_migrations.schema_migrations" | sort -u
}

# --- baseline -------------------------------------------------------------
if [ "$BASELINE" = 1 ]; then
  echo "==> prereqs"
  run -f migrations/0000_baseline.prereqs.sql
  echo "==> 0000_baseline.sql"
  run -c "set search_path = public, extensions;" -f migrations/0000_baseline.sql
  echo "==> recording sealed history"
  grep -v '^#' migrations/0000_baseline.manifest.txt | grep '|' | while IFS='|' read -r v n; do
    run -c "insert into supabase_migrations.schema_migrations (version, name, statements)
            values ('$v', '$n', array['-- sealed into 0000_baseline.sql'])
            on conflict (version) do nothing;"
  done
fi

# --- post-baseline files --------------------------------------------------
CUTOVER="$(grep '^# cutover_version:' migrations/0000_baseline.manifest.txt | awk '{print $3}')"
APPLIED="$(applied_names)"
count=0
for f in $(ls migrations/*.sql | sort); do
  base="$(basename "$f" .sql)"
  case "$base" in 0000_baseline*) continue ;; esac
  ver="${base%%_*}"; name="${base#*_}"
  [ "$ver" -le "$CUTOVER" ] 2>/dev/null && continue          # sealed
  if printf '%s\n' "$APPLIED" | grep -qxF "$name"; then
    echo "==> skip (already applied): $name"; continue
  fi
  echo "==> apply: $base"
  run -1 -f "$f"
  run -c "insert into supabase_migrations.schema_migrations (version, name, statements)
          values ('$ver', '$name', array['-- applied by scripts/db/migrate.sh'])
          on conflict (version) do nothing;"
  count=$((count+1))
done
echo "==> applied $count post-baseline migration(s)"
```

**Notes for the implementer:** `run -1 -f "$f"` wraps each migration in a single transaction. Two existing kinds of statement cannot run inside one — `CREATE INDEX CONCURRENTLY` and `ALTER TYPE … ADD VALUE`. `grep -l "CONCURRENTLY" migrations/*.sql` before shipping; if any post-baseline file hits, add a `-- migrate:no-transaction` marker convention and drop `-1` for those files. As of the cutover there are none post-baseline.

**Verification** (needs a local Postgres 17; `docker run --rm -d -p 55432:5432 -e POSTGRES_PASSWORD=postgres --name pgtest postgres:17`):
```bash
cd /Users/gabe/lotlogic-backend-schema && chmod +x scripts/db/migrate.sh
U="postgresql://postgres:postgres@localhost:55432/postgres"
scripts/db/migrate.sh "$U" --baseline
psql "$U" -qAt -c "select count(*) from pg_tables where schemaname='public'"                 # 51
psql "$U" -qAt -c "select count(*) from pg_policies where schemaname='public'"               # 86
psql "$U" -qAt -c "select count(*) from supabase_migrations.schema_migrations"               # 176
scripts/db/migrate.sh "$U" --baseline   # idempotent: applies nothing, errors nothing
docker rm -f pgtest
```

**Commit:** `feat(db): one migration runner (baseline + record-sealed-history + post-baseline files)`

---

### Task 5: Recover the 37 unfiled migrations from the ledger into `_archive/`

DB-4's "the schema exists only in production" is half true: the *SQL* of all 176 applied migrations is sitting in `supabase_migrations.schema_migrations.statements` (verified: 176/176 populated, e.g. `platform_admin_mechanism` is 6,221 characters). Recover it before anything can drop the ledger.

**Files:**
- Create: `lotlogic-backend-schema/migrations/_archive/<version>_<name>.sql` × 37
- Create: `lotlogic-backend-schema/migrations/_archive/README.md`

**Recovery query** (read-only; run per name via `mcp__supabase__execute_sql`, or once with `PROD_DATABASE_URL` and `psql -qAt`):
```sql
select array_to_string(statements, E'\n;\n')
from supabase_migrations.schema_migrations
where name = :name;
```

**The 37 names** (applied, no file in either repo, normalized):
`add_back_plate_to_vehicle_pair_tables`, `add_cooldown_violation_type`, `add_property_cooldown_hours`, `audit_c2_billing_view_security_invoker_revoke_dml`, `audit_phase0_deactivate_phantom_cams_drop_dup_index`, `audit_revoke_inert_anon_dml_enforcement_partners`, `auto_clear_stale_violation_queue_12h`, `auto_clear_stale_violation_queue_15h`, `backend_statement_timeout_backstop`, `bridge_cameras_to_alpr_cameras`, `camera_snapshot_diag_retention`, `cooldown_use_greatest_reference`, `cross_camera_photo_attach`, `enable_rls_on_remaining_tables`, `fuzzy_match_config_history`, `h4_stop_completed_status_write_registration_killer`, `h4_visitor_pass_exit_discipline_retro_match`, `h4_visitor_pass_exit_discipline_retro_match_canonical`, `h8_properties_public_view_scope_anon`, `idx_visitor_passes_property_created`, `inferred_plate_pairs_fk_fix`, `inferred_plate_pairs_min_gap_bump`, `is_platform_admin_security_definer`, `plate_events_admin_label_policy`, `platform_admin_mechanism`, `reject_tow_disclaimer_flag`, `repair_account_passwords_migration`, `tow_confirmation_action_taken_constraint`, `training_runs_audit`, `vehicle_mmc_columns`, `vehicle_type_columns`, `visitor_passes_cooldown_flagged_partial_idx`, `visitor_passes_cooldown_key_expr_idx`, `walkaround_026_tow_evidence_columns`, `weather_crons_view_and_watchdog_secret`, `weather_risk_uptime_tables`, `wedge_prevention_cleanup`.

Note `idx_visitor_passes_property_created` and `backend_statement_timeout_backstop` — those are the two fixes from the 2026-08-18/08-22 DB wedge. They had no file anywhere. That is the concrete cost of DB-4.

**`migrations/_archive/README.md`:**
```markdown
# migrations/_archive — recovered history, NOT a runnable directory

37 migrations were applied to production with no file in either repo. Their SQL
was recovered on 2026-09-05 from `supabase_migrations.schema_migrations.statements`
and written here for forensics: "when did this index appear, and why".

**These files are never applied.** Their effects are already inside
`migrations/0000_baseline.sql`. `scripts/db/migrate.sh` skips this directory;
so do both CI jobs. Several reference tables that have since been dropped and
would fail if run.

Never add a file here by hand. A new migration is a file in `migrations/`.
```

**Verification:**
```bash
cd /Users/gabe/lotlogic-backend-schema && \
  [ "$(ls migrations/_archive/*.sql | wc -l | tr -d ' ')" -eq 37 ] && \
  grep -q "idx_visitor_passes_property_created" <(ls migrations/_archive/) && \
  ! grep -q "_archive" scripts/db/migrate.sh && echo OK
```
(That last check is a reminder: the runner globs `migrations/*.sql`, which does not descend into `_archive/`. Confirm by reading, not by adding an exclusion.)

**Commit:** `feat(db): recover 37 unfiled migrations from the ledger into migrations/_archive`

---

### Task 6: Fold the frontend's 25 files in and delete the directory

Every one of the 25 has now been classified against production. Nineteen are already applied under some name, four duplicate a backend file outright (PIPE-13), and two were never applied and their objects do not exist.

**Files:**
- Delete: `lotlogic-schema/migrations/` (all 25 `.sql` plus `ops/`)
- Create: `lotlogic-backend-schema/migrations/_archive/frontend_009_marketing_seo.sql`
- Create: `lotlogic-backend-schema/migrations/_archive/frontend_025_visitor_passes_search_indexes.sql`
- Create: `lotlogic-backend-schema/seeds/2026-04-20-register-charlotte-cameras.sql` (moved from `lotlogic/migrations/ops/`)
- Rename: `lotlogic-backend-schema/migrations/20260818_visitor_passes_cooldown_indexes.sql` → `20260818111839_visitor_passes_cooldown_indexes.sql`
- Modify: `lotlogic-schema/CLAUDE.md` (line 64, the `migrations/` tree entry)

**Disposition table — record the outcome in `docs/db/schema-inventory.md`:**

| Frontend file | In production? | Recorded as | Action |
|---|---|---|---|
| `001_violation_dedup` | yes (`violations.departed_at` present) | `20260318185936 violation_dedup_fix` | delete |
| `002_violation_departure` | yes | same | delete |
| `003_add_departed_status` | yes | same | delete |
| `004_add_zone_overlap` | yes | `20260318144400 entry_zones` | delete |
| `005_alpr_parking_pass` | yes | `20260328015744` | delete (duplicate of backend file) |
| `006_alpr_indexes_constraints` | yes | `20260328015758` | delete (duplicate) |
| `007_landing_pages` | yes | `20260403221339` | delete (duplicate) |
| `008_leadgen_agent` | yes | `20260410144538` | delete (duplicate) |
| `009_marketing_seo` | **no** — `blog_posts`, `reddit_leads`, `funnel_events` absent | — | archive, do **not** apply |
| `010`–`023` (14 files) | yes | recorded verbatim, e.g. `20260419171505 010_pr_ingest_enums` | delete |
| `024_cameras_gate_id_bidirectional` | yes | `20260427135347 cameras_gate_id_bidirectional` | delete |
| `025_visitor_passes_search_indexes` | **no** — `visitor_passes_plate_text_trgm_idx` absent | — | archive, do **not** apply (see Open Decisions) |
| `ops/2026-04-20-register-charlotte-cameras.sql` | n/a — it is a seed, not a migration | — | move to `lotlogic-backend/seeds/` |

**`lotlogic-schema/CLAUDE.md` line 64** — replace
```
├── migrations/        # SQL schema patches (backend repo is source of truth)
```
with nothing (delete the line), and add to the "Known Bottlenecks" section:
```markdown
- **This repo holds no migrations.** All DB schema lives in
  `lotlogic-backend/migrations/`, applied by `scripts/db/migrate.sh` and gated
  by the `schema-rebuild` + `schema-drift` CI jobs there. Edge functions in
  `supabase/functions/` still deploy from here; the database does not.
```

**Verification:**
```bash
cd /Users/gabe/lotlogic-schema && ! test -d migrations && \
  ! grep -q 'migrations/ *#' CLAUDE.md && echo "frontend OK"
cd /Users/gabe/lotlogic-backend-schema && \
  test -f seeds/2026-04-20-register-charlotte-cameras.sql && \
  test -f migrations/20260818111839_visitor_passes_cooldown_indexes.sql && \
  ! test -f migrations/20260818_visitor_passes_cooldown_indexes.sql && \
  [ "$(ls migrations/*.sql | grep -cvE '/[0-9]{14}_|0000_baseline')" -eq 0 ] && echo "backend OK"
```
That last check is the point of the task: **every** file in `migrations/` now matches `YYYYMMDDHHMMSS_*.sql` or is a `0000_baseline*` artifact.

**Commit** (two, one per repo):
- frontend: `refactor(db): delete lotlogic/migrations — backend repo is the single migration source`
- backend: `refactor(db): absorb frontend migrations; normalize the one off-convention filename`

---

### Task 7: CI job `schema-rebuild` — prove the baseline rebuilds

**Files:**
- Modify: `lotlogic-backend-schema/.github/workflows/ci.yml`
- Create: `lotlogic-backend-schema/migrations/expected_schema.sql` (generated, committed)

`expected_schema.sql` is produced **by this job on a rebuilt database**, not from prod — it is the fixed point of "baseline + all post-baseline migrations". Task 12 separately proves that fixed point equals production.

Add as a second job in `ci.yml` (it does not touch `lint-and-test`; it needs no Python deps, so it runs in ~40 s):
```yaml
  schema-rebuild:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    services:
      postgres:
        image: postgres:17
        env:
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: postgres
        ports: ["5432:5432"]
        options: >-
          --health-cmd pg_isready --health-interval 10s
          --health-timeout 5s --health-retries 5
    env:
      DATABASE_URL: postgresql://postgres:postgres@localhost:5432/postgres
    steps:
      - uses: actions/checkout@v4

      # ubuntu-latest ships a PG16 client; the baseline is PG17 and
      # scripts/db/dump_schema.sh refuses anything else.
      - name: Install PostgreSQL 17 client
        run: |
          sudo install -d /usr/share/postgresql-common/pgdg
          sudo curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
            https://www.postgresql.org/media/keys/ACCC4CF8.asc
          echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
            https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
            | sudo tee /etc/apt/sources.list.d/pgdg.list
          sudo apt-get update -qq
          sudo apt-get install -y --no-install-recommends postgresql-client-17
          echo "/usr/lib/postgresql/17/bin" >> "$GITHUB_PATH"
          /usr/lib/postgresql/17/bin/pg_dump --version

      - name: Rebuild the schema from scratch
        run: scripts/db/migrate.sh "$DATABASE_URL" --baseline

      - name: Object census must match the committed inventory
        run: |
          psql "$DATABASE_URL" -qAtF'|' -f scripts/db/inventory.sql | tee /tmp/census.txt
          grep -qx 'tables|51'   /tmp/census.txt
          grep -qx 'policies|86' /tmp/census.txt
          grep -qx 'functions|70' /tmp/census.txt

      # A second --baseline run must be a no-op: the runner is idempotent, so a
      # half-finished restore can always be resumed.
      - name: Runner is idempotent
        run: scripts/db/migrate.sh "$DATABASE_URL" --baseline

      - name: Diff the rebuilt schema against migrations/expected_schema.sql
        run: |
          scripts/db/dump_schema.sh "$DATABASE_URL" > /tmp/actual_schema.sql
          if ! diff -u migrations/expected_schema.sql /tmp/actual_schema.sql; then
            echo "::error::Rebuilt schema differs from migrations/expected_schema.sql."
            echo "If your migration is the cause, regenerate and commit it:"
            echo "  scripts/db/migrate.sh \"\$DATABASE_URL\" --baseline"
            echo "  scripts/db/dump_schema.sh \"\$DATABASE_URL\" > migrations/expected_schema.sql"
            exit 1
          fi
```

To produce the committed `expected_schema.sql` the first time, run the same two commands locally against the throwaway container from Task 4.

**Wave 2.7's PR will fail this job until it regenerates the file** — that is the intended behaviour, and the error message above tells it exactly what to run. Say so in the 2.7 handoff.

**Verification:**
```bash
cd /Users/gabe/lotlogic-backend-schema && \
  python3 -c "import yaml,sys; d=yaml.safe_load(open('.github/workflows/ci.yml')); \
    assert 'schema-rebuild' in d['jobs'] and 'lint-and-test' in d['jobs']; print('OK')"
# then push the branch and confirm the job is green on the PR
```

**Commit:** `ci(db): schema-rebuild job — fresh Postgres 17 -> baseline -> normalized diff`

---

### Task 8: CI job `schema-drift` — files vs what production actually has

This is BACKEND-12: "nothing detects code shipping ahead of its migration". It is the one job in this plan that touches production, read-only.

**🔑 NEEDS GABE — one role and one secret.** Everything else in this plan runs with credentials that already exist.

Gabe runs this once in the Supabase SQL editor:
```sql
create role ci_schema_reader with login password '<generate a long random password>';
grant usage on schema supabase_migrations to ci_schema_reader;
grant select on supabase_migrations.schema_migrations to ci_schema_reader;
-- Nothing else. This role cannot read one row of application data.
```
Then adds a repository secret on **`getlotlogic/lotlogic-backend`** (Settings → Secrets and variables → Actions → New repository secret):
- Name: `PROD_SCHEMA_READER_URL`
- Value: `postgresql://ci_schema_reader.nzdkoouoaedbbccraoti:<password>@aws-1-us-east-1.pooler.supabase.com:5432/postgres`
  (pooler host and port taken from `/Users/gabe/lotlogic/supabase/.temp/pooler-url`; Supabase's pooler expects the username form `<role>.<project-ref>`.)

*Fallback if the role is a problem:* `supabase migration list --linked` was verified to work with **only** a `SUPABASE_ACCESS_TOKEN` — no DB password — so the job could instead `supabase init` into a scratch dir, `supabase link --project-ref nzdkoouoaedbbccraoti`, and parse that output. It is slower, couples CI to the CLI version, and compares versions rather than names. Use it only if Gabe declines the read-only role.

**Files:**
- Create: `lotlogic-backend-schema/scripts/db/check_drift.py`
- Modify: `lotlogic-backend-schema/.github/workflows/ci.yml`

**`scripts/db/check_drift.py`** — stdlib, shells out to `psql`:
```python
#!/usr/bin/env python3
"""Fail when migrations/ and the production ledger disagree.

Compares NAMES (filename minus the 14-digit prefix, minus .sql), not versions:
apply_migration stamps its own timestamp, so file 20260903131539_partner_fees_
to_cents.sql is recorded in production as version 20260903141703. A version
mismatch is a warning; a missing name on either side is a failure.

Only POST-baseline migrations are compared. Everything at or below
cutover_version is sealed into 0000_baseline.sql and listed in its manifest.
"""
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MIG = ROOT / "migrations"
MANIFEST = MIG / "0000_baseline.manifest.txt"
FNAME = re.compile(r"^(\d{14})_(.+)\.sql$")


def cutover() -> str:
    for line in MANIFEST.read_text().splitlines():
        if line.startswith("# cutover_version:"):
            return line.split(":", 1)[1].strip()
    sys.exit("no cutover_version in 0000_baseline.manifest.txt")


def files_after(cut: str) -> dict[str, str]:
    out = {}
    for p in sorted(MIG.glob("*.sql")):
        m = FNAME.match(p.name)
        if not m:
            sys.exit(f"{p.name} does not match YYYYMMDDHHMMSS_name.sql")
        ver, name = m.groups()
        if ver > cut:
            if name in out:
                sys.exit(f"duplicate migration name after the cutover: {name}")
            out[name] = ver
    return out


def applied_after(url: str, cut: str) -> dict[str, str]:
    sql = (
        "select name || '|' || version from supabase_migrations.schema_migrations "
        f"where version > '{cut}' order by version"
    )
    res = subprocess.run(
        ["psql", url, "-qAt", "--no-psqlrc", "-c", sql],
        capture_output=True, text=True, check=True,
    )
    rows = {}
    for line in res.stdout.splitlines():
        if "|" in line:
            name, ver = line.rsplit("|", 1)
            rows[name] = ver
    return rows


def main() -> int:
    url = os.environ.get("PROD_SCHEMA_READER_URL")
    if not url:
        sys.exit("PROD_SCHEMA_READER_URL is not set")
    cut = cutover()
    files, applied = files_after(url and cut), applied_after(url, cut)
    files = files_after(cut)

    errs, warns = [], []
    for name, ver in sorted(files.items()):
        if name not in applied:
            errs.append(
                f"FILE WITH NO APPLIED RECORD: migrations/{ver}_{name}.sql\n"
                f"  The code in this PR may depend on it. Apply it with the Supabase\n"
                f"  MCP apply_migration (name='{name}') before merging."
            )
        elif applied[name] != ver:
            warns.append(f"version drift: {name} file={ver} applied={applied[name]}")
    for name, ver in sorted(applied.items()):
        if name not in files:
            errs.append(
                f"APPLIED WITH NO FILE: version {ver} name '{name}'\n"
                f"  Someone changed production without committing the SQL. Recover it:\n"
                f"    select array_to_string(statements, E'\\n;\\n')\n"
                f"      from supabase_migrations.schema_migrations where version='{ver}';\n"
                f"  and commit it as migrations/{ver}_{name}.sql."
            )
    for w in warns:
        print(f"::warning::{w}")
    for e in errs:
        print(f"::error::{e}")
    print(f"\ncutover {cut}: {len(files)} file(s), {len(applied)} applied record(s), {len(errs)} error(s)")
    return 1 if errs else 0


if __name__ == "__main__":
    raise SystemExit(main())
```
*(Implementer: delete the stray `files = files_after(url and cut)` line — it is left in deliberately so you read the function before shipping it.)*

**CI job:**
```yaml
  schema-drift:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    # Forks have no secrets; skip rather than fail red on every outside PR.
    if: github.event_name == 'push' || github.event.pull_request.head.repo.full_name == github.repository
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.11" }
      - run: sudo apt-get update -qq && sudo apt-get install -y --no-install-recommends postgresql-client
      - name: Compare migrations/ to the production ledger
        env:
          PROD_SCHEMA_READER_URL: ${{ secrets.PROD_SCHEMA_READER_URL }}
        run: |
          if [ -z "$PROD_SCHEMA_READER_URL" ]; then
            echo "::error::PROD_SCHEMA_READER_URL is not set. See docs/superpowers/plans/2026-09-05-wave2-4-schema-baseline.md Task 8."
            exit 1
          fi
          python3 scripts/db/check_drift.py
```

**Verification:**
```bash
cd /Users/gabe/lotlogic-backend-schema
# With no post-baseline files and no post-baseline applied records, drift is zero:
PROD_SCHEMA_READER_URL="$PROD_SCHEMA_READER_URL" python3 scripts/db/check_drift.py; echo "exit=$?"   # expect 0
# Prove it fails: touch a fake future migration, re-run, expect exit 1, then delete it.
touch migrations/29990101000000_fake_drift_probe.sql
PROD_SCHEMA_READER_URL="$PROD_SCHEMA_READER_URL" python3 scripts/db/check_drift.py; echo "exit=$?"   # expect 1
rm migrations/29990101000000_fake_drift_probe.sql
```

**Commit:** `ci(db): schema-drift job — migrations/ vs the production ledger (BACKEND-12)`

---

### Task 9: Generated schema doc, and demote `models.py` (BACKEND-10)

`models.py` is 653 lines and 35 classes that partially mirror a 51-table database. It is read as documentation and it is wrong. Generate the real thing from the same baseline the runner uses, so it can never drift.

**Files:**
- Create: `lotlogic-backend-schema/scripts/db/gen_schema_doc.py`
- Create: `lotlogic-backend-schema/docs/db/schema.md` (generated, committed)
- Modify: `lotlogic-backend-schema/models.py` (module docstring only)
- Modify: `lotlogic-backend-schema/.github/workflows/ci.yml` (staleness gate)

**`scripts/db/gen_schema_doc.py`** — stdlib; parses `migrations/expected_schema.sql` (already normalized: one statement per line) and emits Markdown. No DB connection, so it runs in CI with no secret.
```python
#!/usr/bin/env python3
"""Generate docs/db/schema.md from migrations/expected_schema.sql.

Input is normalized (one statement per line, \\n for internal newlines), so
parsing is a regex over lines rather than a SQL parser.

Emits, per table: columns with types/defaults/NOT NULL, primary key, foreign
keys, CHECK constraints, indexes, triggers, and RLS policies with their roles.
Then a section for views, matviews and functions.

Regenerate:  python3 scripts/db/gen_schema_doc.py > docs/db/schema.md
CI fails if the committed file differs from the regenerated one.
"""
```
Required output shape (the CI gate only checks byte-equality, but the doc has to be worth reading):
```markdown
# LotLogic database schema

Generated from `migrations/expected_schema.sql` by `scripts/db/gen_schema_doc.py`.
**Do not edit.** 51 tables · 3 views · 1 materialized view · 70 functions ·
86 RLS policies · 28 triggers · 217 indexes.

`models.py` is NOT this. It is a partial SQLAlchemy mirror covering 35 of the
51 tables and is not authoritative for any column.

## visitor_passes
| Column | Type | Null | Default |
|---|---|---|---|
...
**Primary key:** …  **Foreign keys:** …  **Checks:** …  **Indexes:** …
**RLS policies:** `visitor_passes_scoped_select` (SELECT, `authenticated`) …
```

**`models.py` docstring** — prepend:
```python
"""SQLAlchemy models for the subset of tables this service writes through the ORM.

NOT the schema of record. The database has 51 public tables; this file declares
35, and several declared here have columns the ORM does not know about.

  * Schema of record:  migrations/0000_baseline.sql + migrations/*.sql
  * Human-readable:    docs/db/schema.md (generated; regenerate with
                       scripts/db/gen_schema_doc.py)

Adding a column here does not create it. Write a migration.
"""
```

**CI staleness gate** — add as a step of `schema-rebuild`, after the expected-schema diff:
```yaml
      - name: docs/db/schema.md is in sync
        run: |
          python3 scripts/db/gen_schema_doc.py > /tmp/schema.md
          diff -u docs/db/schema.md /tmp/schema.md || {
            echo "::error::docs/db/schema.md is stale. Run: python3 scripts/db/gen_schema_doc.py > docs/db/schema.md"
            exit 1
          }
```

**Verification:**
```bash
cd /Users/gabe/lotlogic-backend-schema && \
  python3 scripts/db/gen_schema_doc.py > /tmp/s.md && diff -q /tmp/s.md docs/db/schema.md && \
  grep -c '^## ' docs/db/schema.md   # expect 51 table sections + the trailing sections
```

**Commit:** `docs(db): generate schema.md from the baseline; mark models.py non-authoritative`

---

### Task 10: Rewrite the recovery story

`RECOVERY.md` §7 currently says "Migrations cannot rebuild the schema (30+ unfiled). Authoritative recovery = Supabase backup." After Task 7 that is false, and leaving it false means the next person under pressure reaches for the wrong artifact. Both recovery docs also carry stale counts (46 tables, 66 functions, 80 policies, 26 triggers, 5 cron jobs — measured today: 51 / 70 / 86 / 28 / 8).

**Files:**
- Modify: `lotlogic/RECOVERY.md` (in `lotlogic-schema`) — §1, §7, §10
- Modify: `lotlogic-backend-schema/recovery/db-state.md` — full rewrite

**`RECOVERY.md` §7** — replace the whole section with:
```markdown
## 7. Database — rebuildable from git as of 2026-09-05

Measured: 51 tables (all RLS-on), 3 views, 1 matview, 70 functions, 86 policies,
28 triggers, 8 pg_cron jobs (4 of them intentionally inactive), 217 indexes.

**The schema now rebuilds from `lotlogic-backend/migrations/`.** One command:

```bash
cd lotlogic-backend
scripts/db/migrate.sh "$DATABASE_URL" --baseline
```

That applies `0000_baseline.prereqs.sql` (roles + extension schema; a no-op on
Supabase), then `0000_baseline.sql` (the full public schema), records the 176
sealed migrations in `supabase_migrations.schema_migrations`, and applies every
post-baseline file. It is idempotent — safe to re-run after a partial restore.

CI proves this on every pull request (`schema-rebuild`), and a second job
(`schema-drift`) fails when a migration file has no applied record in production
or a production record has no file.

**Still not in the schema dump, still needed after a restore:**
1. `migrations/0000_baseline.cron.sql` — the 8 pg_cron jobs. Run it by hand.
   Four are recreated inactive on purpose; do not turn them on.
2. Table **data**. The schema is in git; the rows are not. Data recovery is a
   Supabase backup or PITR restore, and nothing else.
3. Per-camera `alpr_cameras.api_key` values — data, so item 2 covers them.

**TODO (unchanged, still the highest-priority DR gap): confirm daily backups +
PITR in the Supabase dashboard, and do one test restore.** The schema being
rebuildable does not give you back a single plate read.
```

**`RECOVERY.md` §1** — change the DB bullet from
`⚠️ **DB**: schema can't be rebuilt from migrations/ alone; depends on Supabase backups → CONFIRM (§7).`
to
`✅ **DB schema**: rebuilds from git (`scripts/db/migrate.sh --baseline`), proven by CI. ⚠️ **DB data**: Supabase backups only → still CONFIRM (§7).`

**`RECOVERY.md` §10 step 1** — change
`Restore Supabase project from backup (or new project + pg_dump); enable extensions; run recovery/pg_cron.sql`
to
`Restore Supabase project from backup for DATA. For schema on a fresh project: `lotlogic-backend/scripts/db/migrate.sh "$DATABASE_URL" --baseline`, then `psql "$DATABASE_URL" -f lotlogic-backend/migrations/0000_baseline.cron.sql`.`

**`recovery/db-state.md`** — delete the "⚠️ The migration files do NOT fully rebuild this database" section entirely, refresh the counts table to the measured values above, replace the "How to take a full schema dump" block with a pointer to `scripts/db/dump_schema.sh`, and point the cron line at `migrations/0000_baseline.cron.sql`.

**Verification:**
```bash
cd /Users/gabe/lotlogic-schema && \
  ! grep -q "schema can't be rebuilt" RECOVERY.md && \
  grep -q 'migrate.sh "\$DATABASE_URL" --baseline' RECOVERY.md && echo OK
cd /Users/gabe/lotlogic-backend-schema && \
  ! grep -q "do NOT fully rebuild" recovery/db-state.md && \
  ! grep -q "recovery/pg_cron.sql" recovery/db-state.md && echo OK
```

**Commit** (two, one per repo): `docs(recovery): the schema rebuilds from git — rewrite the DB recovery procedure`

---

### Task 11: Retire `supabase-schema.sql` and the third runner (FAT-11, DB-11)

**Files:**
- Delete: `lotlogic-schema/supabase-schema.sql` (529 lines)
- Delete: `lotlogic-schema/puller/migrate.py`, `lotlogic-schema/puller/Dockerfile.migrate`
- Modify: `lotlogic-schema/CLAUDE.md` — remove the tree entry at line 66 and the note at line 146

The spec gated this delete on resolving `permitted_vehicles` and `action_logs`. **The gate is already open:** neither table exists in production, and outside `supabase-schema.sql` itself no file in either repo mentions either name. There is nothing to migrate and no question for Gabe.

`puller/migrate.py` is a one-shot `psycopg2` script that `ALTER TABLE cameras ADD COLUMN IF NOT EXISTS` × 13 against the legacy `cameras` table. `puller/railway.toml` builds `Dockerfile`, not `Dockerfile.migrate`, so nothing runs it. Leaving a second way to change the schema in the tree defeats the purpose of this plan.

**`CLAUDE.md` line 146** currently reads `Camera status values: active (not online as in supabase-schema.sql)`. Replace with `Camera status values: active` — the parenthetical refers to a deleted file.

Also delete the backend `CLAUDE.md` bottleneck bullet `**supabase-schema.sql drifts from migrations/.** Every new schema change should update both or neither.` (Task 12 rewrites that section anyway; do the delete here so the two repos land consistent.)

**Verification:**
```bash
cd /Users/gabe/lotlogic-schema && \
  ! test -f supabase-schema.sql && ! test -f puller/migrate.py && \
  ! test -f puller/Dockerfile.migrate && \
  ! grep -rq "supabase-schema.sql" --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=docs . && \
  ! grep -rq "permitted_vehicles\|action_logs" --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=docs . && \
  echo OK
```
**Record but do not fix:** `agent/tools.py`, `agent/prompt.py`, `leadgen/reddit_monitor.py` and `leadgen/blog.py` read `blog_posts` / `reddit_leads` / `funnel_events`, which do not exist in production. That leadgen path is already broken and is out of scope — add it to the Wave 2.9 list.

**Commit:** `chore: delete supabase-schema.sql and the unused puller migration runner (FAT-11, DB-11)`

---

### Task 12: Make the convention enforceable, and prove the baseline equals production

**Files:**
- Modify: `lotlogic-backend-schema/CLAUDE.md` — the "Database Migrations" section (lines 205–232)
- Modify: `lotlogic-backend-schema/.claude/hooks/migration-recorded-check.sh`
- Create: `lotlogic-backend-schema/docs/db/baseline-verification-2026-09-05.md`

**Replace the backend `CLAUDE.md` "Database Migrations" section** — in particular delete the "Current migration history" code block, which lists 25 of 176 migrations and has been wrong since April:
```markdown
## Database Migrations

`migrations/` is the **only** place database schema lives, for both repos.
Naming: `YYYYMMDDHHMMSS_snake_case.sql`, 14-digit UTC timestamp
(`date -u +%Y%m%d%H%M%S`). Ledger: `supabase_migrations.schema_migrations`
(`version` = a timestamp, `name` = filename minus prefix minus `.sql`).

- `migrations/0000_baseline.sql` is the schema as of 2026-09-05, sealing the 176
  migrations listed in `0000_baseline.manifest.txt`. Never edit either file, and
  never re-run anything the manifest names.
- `migrations/_archive/` is recovered history. Never applied, never extended.
- Rebuild any empty database: `scripts/db/migrate.sh "$DATABASE_URL" --baseline`.
- Regenerate the committed dump after adding a migration:
  `scripts/db/migrate.sh "$DB" --baseline && scripts/db/dump_schema.sh "$DB" > migrations/expected_schema.sql`
- Apply to production with the Supabase MCP `apply_migration` (pass `name` =
  the filename minus prefix and `.sql`) or `supabase migration up`. **Both record
  the ledger row. A raw SQL Editor run does not** — and the `schema-drift` CI job
  will fail your next PR because of it.
- Two CI jobs enforce all of the above: `schema-rebuild` (baseline + migrations
  on a fresh Postgres 17 must equal `expected_schema.sql`) and `schema-drift`
  (post-baseline files must equal post-baseline ledger rows, matched by name).
- The filename timestamp will not equal the recorded version — `apply_migration`
  stamps its own. That is a warning, not an error; names are what must match.
```

**Upgrade the hook from warn-only to blocking on the filename pattern.** Change the final `sys.exit(0)` to `sys.exit(2)` when `PATTERN` fails (Claude Code treats exit 2 on a `PostToolUse` hook as a blocking error), and replace the "insert a row into schema_migrations" tip with `Apply via mcp__supabase__apply_migration (name='<filename minus prefix and .sql>') — it records the ledger row for you. A raw SQL Editor run does not, and CI schema-drift will fail.` Keep the reminder itself non-blocking (exit 0) — only a malformed *filename* blocks.

**`docs/db/baseline-verification-2026-09-05.md`** — the one-time proof, run by Gabe on his Mac after Task 7 is green. This is the check Task 7 structurally cannot do (CI has no prod access):
```bash
# 1. rebuild from git into a throwaway container
docker run --rm -d -p 55432:5432 -e POSTGRES_PASSWORD=postgres --name pgverify postgres:17
sleep 5
cd /Users/gabe/lotlogic-backend-schema
export PG_DUMP=/opt/homebrew/opt/postgresql@17/bin/pg_dump   # 17.x, not the 18.3 on PATH
scripts/db/migrate.sh "postgresql://postgres:postgres@localhost:55432/postgres" --baseline
scripts/db/dump_schema.sh "postgresql://postgres:postgres@localhost:55432/postgres" > /tmp/rebuilt.sql

# 2. dump production through the SAME normalizer
eval "$(cd /Users/gabe/lotlogic && supabase db dump --linked --dry-run 2>/dev/null | grep '^export PG')"
scripts/db/dump_schema.sh "postgresql://${PGUSER}:${PGPASSWORD}@${PGHOST}:${PGPORT}/${PGDATABASE}" > /tmp/prod.sql

# 3. they must be identical
diff -u /tmp/prod.sql /tmp/rebuilt.sql && echo "BASELINE VERIFIED"
docker rm -f pgverify
```
Paste the diff (ideally empty) into the doc with the date. Expect a small residue on the first run — Supabase-managed GRANTs to `supabase_admin`, or `postgres`-owned defaults. Each residual line is either (a) genuinely platform-managed, in which case add it to `normalize_dump.py`'s `DROP_LINE` **with a comment saying why**, or (b) a real gap in the baseline, in which case the baseline is wrong and Task 2 gets re-run. Do not add a blanket exclusion.

**Verification:**
```bash
cd /Users/gabe/lotlogic-backend-schema && \
  ! grep -q "Current migration history" CLAUDE.md && \
  grep -q "schema-drift" CLAUDE.md && \
  test -f docs/db/baseline-verification-2026-09-05.md && \
  grep -q "BASELINE VERIFIED" docs/db/baseline-verification-2026-09-05.md && echo OK
```

**Commit:** `docs(db): one migration convention, enforced by hook and CI; record baseline verification`

---

## Open decisions — need a one-line answer from Gabe

1. **🔑 The read-only role and `PROD_SCHEMA_READER_URL` secret (Task 8).** The only credential this plan needs that does not already exist. Without it the `schema-drift` job cannot run. The exact `CREATE ROLE` is in Task 8; the role can read one table and nothing else. *Blocking Task 8 only — Tasks 0–7 and 9–12 proceed without it.*
2. **`025_visitor_passes_search_indexes` — apply, or let it go?** Five trigram indexes on `visitor_passes` (`plate_text`, `visitor_name`, `company_name`, `phone_digits`, `lower(placard_color)`). Written in April, never applied, and `placard_color` was removed as a concept in June (migration `035_drop_placard_color`). The table already carries the wedge-prevention indexes from August, and the database has seized twice. **Plan default: archive, do not apply.** Overturn only if dashboard search is measurably slow.
3. **`ix_lot_owners_email_active` / `ix_enforcement_partners_email_active` — recreate?** `20260417024653_account_passwords.sql` intended two unique partial indexes on `(lower(email)) WHERE active`; the columns landed but the indexes did not. Today nothing stops two active `lot_owners` rows sharing an email. **Plan default: leave it — the baseline records reality, and adding a UNIQUE index to a live table is a Wave 2.2 tenancy change, not a baseline change.** Flag it into 2.2.
4. **The four inactive pg_cron jobs.** `plate_pair_learn`, `weather_pull_6h`, `weather_risk_eval_6h` and `no_reg_sweep` are `active = false` in production. `recovery/pg_cron.sql` would have silently re-enabled all four on a restore. Task 3 preserves them inactive. **Is that right, or was one of them switched off by accident?** `no_reg_sweep` in particular was deliberately *added* in the July audit and is now off.
5. **Does anything still need the legacy `lots` table and `cameras` table?** Both are in the baseline because they are in production, so this plan is unaffected either way — but Wave 3.6 ("finish the two half-migrations") wants to drop `lots`, and `puller/migrate.py` (deleted in Task 11) was the last thing writing `cameras` columns. Worth knowing before 3.6.
