# Training Curator Design

**Date:** 2026-04-24
**Status:** Design — awaiting implementation
**Owner:** Gabe

## Purpose

Continuously improve the openalpr-sidecar's plate-detection accuracy by turning human-labeled rejection data into automatic config nudges. Runs as a Railway worker (mirrors `monitoring/zone_guardian.py`) on a 30-minute loop. Uses Claude API for pattern analysis and proposes or auto-applies config changes to the sidecar.

## Architecture

```
plate_events (Supabase)
  match_status = 'sidecar_rejected'
  raw_data._sidecar_reason ∈ {empty_scene, no_plate_shaped_text, below_min_confidence}
  raw_data.operator_label ∈ {real_plate, junk, NULL}
        │
        ▼ SELECT (last 7d, operator_label IS NOT NULL)
monitoring/training_curator.py  (Railway worker, every 30 min)
  1. pull_labeled_rejections           → Supabase REST (service role)
  2. pull_accepted_labeled_junk        → Supabase REST
  3. compute_confusion_matrix          → pure Python
  4. analyze_with_claude               → Anthropic API
  5. evaluate_safe_changes             → pure Python
  6a. auto_apply_safe_change           → railway variables set / supabase secrets set
  6b. queue_risky_change + email       → Resend API
  7. write_training_run                → Supabase REST
  8. check_unlabeled_queue_alert       → Supabase REST
        │
   ┌────┴─────┐
   ▼          ▼
training_runs   training_queue_alerts
```

## Data Flow

**Input — labeled rejections:** `plate_events` where `match_status = 'sidecar_rejected'` AND `raw_data->>'operator_label' IS NOT NULL`, last 7 days.

**Input — accepted junk:** `plate_events` where `match_status != 'sidecar_rejected'` AND `raw_data->>'operator_label' = 'junk'`, last 7 days. Represents false positives that passed the sidecar gate.

**Confusion matrix per rejection reason:**

| reason | labeled real_plate | labeled junk | fn_rate |
|---|---|---|---|
| empty_scene | 3 | 87 | 3.3% |
| no_plate_shaped_text | 12 | 214 | 5.3% |
| below_min_confidence | 8 | 42 | 16.0% |

**FN rate:** `real_plate / (real_plate + junk)` per reason. High = sidecar over-rejecting.
**FP proxy:** count of accepted events labeled `junk`. Rising = sidecar under-rejecting.

## Table DDL — `migrations/024_training_curator.sql`

```sql
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

CREATE TABLE IF NOT EXISTS public.training_queue_alerts (
  alert_id    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  sent_at     TIMESTAMPTZ NOT NULL    DEFAULT now(),
  queue_size  INT         NOT NULL,
  prior_size  INT         NOT NULL    DEFAULT 0
);

CREATE INDEX IF NOT EXISTS training_queue_alerts_sent_at_idx
  ON public.training_queue_alerts (sent_at DESC);
```

Note: `training_queue_alerts` already exists from Phase 1; the curator adds `prior_size`.

## Tunable Knobs

| Env Var | Where | Safe Range | Default | Auto-apply step |
|---|---|---|---|---|
| `OPENALPR_MIN_CONFIDENCE` | `camera-snapshot` Supabase secret | 0.50–0.95 | 0.80 | ±0.05 |
| `ALPR_MIN_CONFIDENCE` | `openalpr-sidecar` Railway env | 0.50–0.95 | 0.80 | ±0.05 |
| `ALPR_MIN_PLATE_LEN` | `openalpr-sidecar` Railway env | 3–8 | 4 | ±1 |
| `ALPR_MAX_PLATE_LEN` | `openalpr-sidecar` Railway env | 6–12 | 8 | ±1 |

## Auto-Apply vs. Propose

**SAFE (auto-apply) — all conditions:**
1. Single knob change.
2. Within ±5% (or ±1 integer) of current.
3. Within hard bounds.
4. Reduces FN rate without raising FP proxy >10% relative.
5. No prior auto-apply within last 24h.

**RISKY (email + queue):** compound changes, jumps >5%, FP proxy spike >10%, structural changes.

**Post-apply monitoring:** 6h after apply, recompute FN rate. If >2x prior baseline → auto-revert. If revert fails → email "MANUAL REVERT NEEDED".

## Notification Triggers

| Event | Condition | Email |
|---|---|---|
| Queue overflow | unlabeled ≥ 50 AND grew ≥ 20 since last alert | "Review needed — N frames" |
| Cycle complete | `changes_applied` non-empty | Diff + FN rate before/after |
| Risky change | Claude proposes structural change | Markdown report + manual instructions |
| Revert | post-apply FN >2x | "Auto-reverted — FN spike" |

Sender: Resend (RESEND_API_KEY), from `dispatch@lotlogicparking.com`, to `gabebs1@gmail.com`.

## Env Vars (new on training-curator Railway service)

| Var | Source | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | shared with monitoring | Claude API |
| `SUPABASE_SERVICE_ROLE_KEY` | NEW | RLS bypass for plate_events reads |
| `RESEND_API_KEY` | copy from tow-dispatch-email | Email |
| `CURATOR_EMAIL_TO` | `gabebs1@gmail.com` | Override target |
| `SUPABASE_ACCESS_TOKEN` | NEW (supabase.com → Account → Tokens) | secrets API |
| `RAILWAY_API_TOKEN` | NEW (Railway → Tokens) | Railway env updates |
| `OPENALPR_SIDECAR_SERVICE_ID` | Railway service ID | Target service |
| `CURATOR_LOOP_SECONDS` | 1800 | Loop interval |
| `CURATOR_DRY_RUN` | true initially | Log-only mode |

## Deployment

New Railway worker service in `lotlogic` project. Root: `monitoring/`. Start: `python -u training_curator.py --daemon`. Restart: ON_FAILURE max 10. Reuses `monitoring/Dockerfile` (`COPY *.py .`).

## Failure Modes

| Failure | Behavior |
|---|---|
| Supabase non-200 | Log, skip run, write `error_message`, retry next loop |
| Claude unavailable | Skip analysis, still write matrix |
| Railway/secrets CLI fails | Treat change as proposed-only, email manual instructions |
| Post-apply query empty | Reschedule revert check |
| Revert fails | Email "MANUAL REVERT NEEDED", no retry |

## Observability

- Structured JSON logs (matches `zone_guardian.py` format)
- Every loop writes `training_runs` row
- `changes_applied` JSONB = full audit trail
- Future: backend `/training-status` endpoint exposing last 10 runs to dashboard

## Hard Stops

- Confidence knobs clamped to [0.50, 0.95]
- No auto-apply within 24h of prior auto-apply
- No auto-apply during 6h post-apply revert window
- `CURATOR_DRY_RUN=true` disables all writes
