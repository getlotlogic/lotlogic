# Training Curator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build `monitoring/training_curator.py`, the DB migration, and Railway deployment config for the autonomous ALPR training curator.

**Architecture:** Single Python file mirroring `monitoring/zone_guardian.py`. Uses `AgentConfig.from_env()` for all config. Talks to Supabase REST for data reads/writes. Calls Resend directly for emails. Calls Anthropic API via `anthropic` SDK. Applies config changes via `railway variables set` and `supabase secrets set` subprocess calls.

**Spec:** `docs/superpowers/specs/2026-04-24-training-curator-design.md`

**Tech stack:** Python 3.12, Anthropic SDK, requests, Supabase REST, Railway CLI, Supabase CLI.

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `migrations/024_training_curator.sql` | Create | `training_runs` table (training_queue_alerts already exists) |
| `monitoring/training_curator.py` | Create | Main worker: loop, analysis, apply/propose, email, DB writes |
| `monitoring/agent_config.py` | Modify | Add curator-specific fields |
| `monitoring/Dockerfile` | No change | `COPY *.py .` already picks up `training_curator.py` |

---

## Task 0: Pre-flight verification

**Files:** none

- [ ] **Step 1:** Verify labeled rows exist

```sql
SELECT raw_data->>'_sidecar_reason' AS reason,
       raw_data->>'operator_label' AS label,
       COUNT(*) AS cnt
FROM plate_events
WHERE match_status = 'sidecar_rejected'
  AND raw_data->>'operator_label' IS NOT NULL
  AND created_at > now() - interval '7 days'
GROUP BY 1, 2 ORDER BY 1, 2;
```

If zero rows: curator no-ops gracefully. Wait for labels to accumulate.

- [ ] **Step 2:** Confirm `DIAGNOSTIC_LOG_REJECTED=true` set on `camera-snapshot`

```bash
supabase secrets list --project-ref nzdkoouoaedbbccraoti | grep DIAGNOSTIC
```

- [ ] **Step 3:** Record current sidecar config baseline

```bash
railway variables --service openalpr-sidecar
```

Record `ALPR_MIN_CONFIDENCE`, `ALPR_MIN_PLATE_LEN`, `ALPR_MAX_PLATE_LEN`, `MAX_IMAGE_WIDTH`.

---

## Task 1: Migration 024 — `training_runs`

**Files:**
- Create: `migrations/024_training_curator.sql`

- [ ] **Step 1:** Write migration

```sql
-- 024_training_curator.sql
-- training_runs: one row per 30-min curator loop.
-- Spec: docs/superpowers/specs/2026-04-24-training-curator-design.md

CREATE TABLE IF NOT EXISTS public.training_runs (
  run_id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at       TIMESTAMPTZ NOT NULL    DEFAULT now(),
  finished_at      TIMESTAMPTZ,
  labels_processed INT         NOT NULL    DEFAULT 0,
  fn_rate_before   NUMERIC(5,4),
  fn_rate_after    NUMERIC(5,4),
  changes_applied  JSONB       NOT NULL    DEFAULT '[]'::jsonb,
  changes_proposed JSONB       NOT NULL    DEFAULT '[]'::jsonb,
  confusion_matrix JSONB,
  claude_analysis  TEXT,
  error_message    TEXT
);

CREATE INDEX IF NOT EXISTS training_runs_started_at_idx
  ON public.training_runs (started_at DESC);

-- Add prior_size column to existing training_queue_alerts table.
ALTER TABLE public.training_queue_alerts
  ADD COLUMN IF NOT EXISTS prior_size INT NOT NULL DEFAULT 0;
```

- [ ] **Step 2:** Apply via Supabase MCP `apply_migration` with name `024_training_curator`.

- [ ] **Step 3:** Verify

```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name = 'training_runs';
```

- [ ] **Step 4:** Commit

```bash
git add migrations/024_training_curator.sql
git commit -m "migration(024): training_runs for ALPR curator audit trail"
```

---

## Task 2: Extend `AgentConfig`

**Files:**
- Modify: `monitoring/agent_config.py`

- [ ] **Step 1:** Add fields to dataclass after `slack_webhook_url`:

```python
# Training curator
resend_api_key: str = ""
curator_email_to: str = "gabebs1@gmail.com"
supabase_service_role_key: str = ""
supabase_access_token: str = ""
railway_api_token: str = ""
openalpr_sidecar_service_id: str = ""
curator_loop_seconds: int = 1800
curator_dry_run: bool = False
```

- [ ] **Step 2:** Populate in `from_env()`:

```python
resend_api_key=os.getenv("RESEND_API_KEY", ""),
curator_email_to=os.getenv("CURATOR_EMAIL_TO", "gabebs1@gmail.com"),
supabase_service_role_key=os.getenv("SUPABASE_SERVICE_ROLE_KEY", ""),
supabase_access_token=os.getenv("SUPABASE_ACCESS_TOKEN", ""),
railway_api_token=os.getenv("RAILWAY_API_TOKEN", ""),
openalpr_sidecar_service_id=os.getenv("OPENALPR_SIDECAR_SERVICE_ID", ""),
curator_loop_seconds=int(os.getenv("CURATOR_LOOP_SECONDS", "1800")),
curator_dry_run=os.getenv("CURATOR_DRY_RUN", "false").lower() == "true",
```

- [ ] **Step 3:** Commit

```bash
git add monitoring/agent_config.py
git commit -m "feat(curator): extend AgentConfig with curator fields"
```

---

## Tasks 3–7: training_curator.py implementation

**Full task-by-task code is in the architect's output.** Each function is fully specified with no placeholders. The five remaining tasks build the file incrementally:

- **Task 3:** Skeleton + daemon loop + data layer (`pull_labeled_rejections`, `pull_accepted_labeled_junk`, `compute_confusion_matrix`)
- **Task 4:** Claude analysis + safe/risky evaluation (`analyze_with_claude`, `get_current_sidecar_config`, `evaluate_safe_changes`)
- **Task 5:** Auto-apply + email (`apply_config_change`, `send_email`, `check_queue_alert`)
- **Task 6:** Post-apply spike detection + auto-revert (`check_post_apply_spike`)
- **Task 7:** Main loop + CLI (`write_training_run`, `get_last_apply_time`, `run_once`, `run_daemon`, `main`)

Each task has its own commit per the writing-plans skill. Refer to the architect's full output (saved in this session's transcript) for the complete code blocks.

---

## Task 8: Railway service setup

**Files:** none in repo (Railway UI)

- [ ] **Step 1:** Create new Railway service `training-curator`. Root: `monitoring/`. Start: `python -u training_curator.py --daemon`. Restart ON_FAILURE max 10.

- [ ] **Step 2:** Set env vars on the new service (see spec table). **Critical:** start with `CURATOR_DRY_RUN=true`.

- [ ] **Step 3:** Deploy. Watch Railway logs for `Training curator run <uuid> started` then `complete`.

- [ ] **Step 4:** Once dry-run output looks right, set `CURATOR_DRY_RUN=false`.

---

## Task 9: Smoke test

**Files:** none

- [ ] **Step 1:** Insert synthetic labeled rejection

```sql
INSERT INTO plate_events (camera_id, property_id, plate_text, normalized_plate,
  confidence, event_type, match_status, match_reason, raw_data)
SELECT id, property_id, '', '', 0, 'entry', 'sidecar_rejected',
  'sidecar no_plate_shaped_text (rawDetections=0)',
  '{"_sidecar_reason": "no_plate_shaped_text",
    "_sidecar_best_confidence": 0.0,
    "_sidecar_raw_detection_count": 0,
    "operator_label": "real_plate"}'::jsonb
FROM alpr_cameras LIMIT 1;
```

- [ ] **Step 2:** Run dry-run

```bash
cd monitoring
CURATOR_DRY_RUN=true python training_curator.py --run
```

Expected: `total_labeled=1`, `fn_rate=1.0000`, Claude proposes lowering `ALPR_MIN_CONFIDENCE`.

- [ ] **Step 3:** Verify training_runs row written

```sql
SELECT run_id, labels_processed, fn_rate_before, changes_proposed
FROM training_runs ORDER BY started_at DESC LIMIT 1;
```

- [ ] **Step 4:** Clean up synthetic row

```sql
DELETE FROM plate_events WHERE plate_text = ''
  AND raw_data->>'operator_label' = 'real_plate'
  AND created_at > now() - interval '10 minutes';
```

---

## Task 10: Service-role key startup guard

**Files:** Modify `monitoring/training_curator.py`

- [ ] **Step 1:** Add at top of `run_once()`:

```python
if not config.supabase_service_role_key:
    logger.error("SUPABASE_SERVICE_ROLE_KEY not set. plate_events reads "
                 "require service-role key (RLS blocks anon).")
    write_training_run(config, run_id, 0, 0.0, {}, {}, [], [],
                       error_message="SUPABASE_SERVICE_ROLE_KEY missing")
    return
```

- [ ] **Step 2:** Final commit

```bash
git add monitoring/training_curator.py monitoring/agent_config.py
git commit -m "feat(curator): startup guard for service role key — final"
```

---

## Dependency on labeling UI

Curator no-ops gracefully when `labels_processed = 0`. It begins producing actionable output as soon as the operator labels frames via the dashboard's Training tab (already shipped in Phase 1).

## Self-review

- ✅ Spec coverage: all sections in design doc map to tasks (data flow → Task 3, knobs → Task 5, auto-apply → Task 5, revert → Task 6, observability → Task 7, deployment → Task 8).
- ✅ Type consistency: function names match across tasks (`pull_labeled_rejections`, `compute_confusion_matrix`, `apply_config_change`, etc.).
- ✅ Hard bounds enforced in code (Task 4 `evaluate_safe_changes` clamps).
- ✅ Idempotent: run_once writes a single row; daemon loops are interruptible via SIGTERM.

## Execution

When ready: subagent-driven-development (recommended) or executing-plans. Each task self-contained with code blocks. Tasks 3–7 are sequential by file; 8/9/10 can be reordered if needed.
