# Wave 2.7 — One Monitoring Spine, With a Dead-Man for Every Job

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every scheduled job in the estate — backend loop, pg_cron job, edge function, laptop job — writes a heartbeat to one table, one checker alerts through one dispatch layer when a job goes quiet, the database itself is watched by a probe that does not depend on the wedged pool, and a second Railway replica becomes safe.

**Architecture:** `services/plaza_alerts.py` already contains the only alerting machinery in the repo that works (two channels, per-condition cooldown armed only on success, PII discipline, never raises). We lift that machinery into `services/alerts.py` as a channel-injected dispatcher and make `plaza_alerts` its first caller — bit-for-bit identical behaviour, its 40-odd tests unchanged. On top of that dispatcher we build three consumers: a DB-health watchdog on a `NullPool` engine that cannot be starved by the wedged main pool; a `ops_job_runs` registry table written by every job class through four different transports; and a dead-man checker inside the existing `run_health_monitor` loop. Advisory locks keyed by job name make each in-process loop tick single-writer.

**Tech Stack:** Python 3.11, FastAPI, SQLAlchemy 2 async + asyncpg, Supabase Postgres 17 behind a supavisor **SESSION-mode** pooler, pytest + pytest-asyncio (strict mode), ruff 0.16.5, Railway deploy from `main`, Supabase edge functions (Deno) + pg_cron + pg_net, bash job wrapper on the laptop.

**Spec:** `/Users/gabe/lotlogic/docs/superpowers/specs/2026-09-03-enterprise-readiness-program.md` — section 3, Wave 2 item **2.7**; systemic move **S1**; Appendix A findings REL-6, REL-2, REL-9, REL-10, REL-12, REL-14, BACKEND-9, BACKEND-19, PIPE-8, PIPE-10, AUTO-2. Item **2.8** (cloud scheduler) consumes what this plan produces — 2.7 defines the dead-man contract that 2.8 enforces.

**Incident this plan answers:** 2026-09-04 22:50 → 2026-09-05 00:25 ET. Supabase on a Nano instance saturated; supavisor returned `ECHECKOUTTIMEOUT` for 95 minutes; `/ready` returned 503 the entire time; the only thing that told a human was a macOS desktop notification from a laptop script. Already fixed out-of-band: compute Nano → Small, pooler pool size 15 → 20, backend pool `DB_POOL_SIZE=8` / `DB_MAX_OVERFLOW=7`, `cron.job_run_details` purged (406k rows / 156 MB) plus a daily purge job, and an external GitHub Actions probe (`.github/workflows/uptime.yml`, branch `ops/uptime-probe`) whose failure emails the committer.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Never edit these files.** `routers/plaza_payments.py`, `services/plaza_settle.py`, `services/square*.py`, `services/stripe_plaza.py` (this last one does not exist in the repo today — the constraint is kept anyway so it stays true if it appears). `services/plaza_alerts.py` and `services/plaza_sweep.py` **are** in scope; Task 2 exists to edit the former.
- **No new third-party accounts.** No Pushover, no Healthchecks.io, no PagerDuty, no Better Stack. Channels available today: SendGrid email (works), GitHub Actions failure email (works), iMessage via `osascript` from the laptop (under test), macOS notification (last resort). **Twilio returns 401 — SMS is not a working channel.** Every new alert path must be built so a channel can be added later without touching its callers.
- **Secrets only via env.** `config.py` `Settings` fields, read through `get_settings()`. Never a literal in source, never a phone number or email address as a default value (a personal mobile was hardcoded as a fallback recipient once — BACKEND-14 — do not repeat it).
- **PII discipline in alert bodies.** No plate, no phone number, no driver or company name, no email address of a customer. Counts, ages, ids, job names, condition names only. This applies to email exactly as it applies to SMS.
- **The user-facing naming rule does not apply** (this is ops, not a product surface) — but the banned words still must not appear in an alert body, because `tests/plaza/test_plaza_alerts.py` asserts on `BANNED_WORDS = ("resident", "visitor", "permanent", "temporary", "guest", "driver")` and the ops bodies share the dispatcher.
- **Every loop must survive the database being down.** A heartbeat write that fails is logged at DEBUG and swallowed. An advisory-lock acquisition that cannot connect skips the tick and returns. Alerting never raises. A background loop must outlive whatever one iteration hits.
- **Ruff rule set unchanged.** `ruff.toml` stays `select = ["E4","E7","E9","F"]`, `ignore = ["E712","E701"]`. Do not add rules, do not remove the ignores. Blind `except Exception` in a loop body needs `# noqa: BLE001` only where the file already carries that comment style (`main.py`); the pinned rule set does not select `BLE`, so do not add noqa comments elsewhere.
- **Migrations:** `migrations/YYYYMMDDHHMMSS_snake_case_name.sql` (Supabase CLI timestamp naming; `date -u +%Y%m%d%H%M%S`). Every migration applied to prod must exist as a file **and** as a row in `supabase_migrations.schema_migrations` — apply via the Supabase MCP `apply_migration` or the CLI, never the raw SQL editor. Every new table gets `ENABLE ROW LEVEL SECURITY` and `REVOKE ALL … FROM anon, authenticated` in the same file.
- **Tests:** pytest-asyncio runs in **strict** mode (there is no pytest ini file), so every coroutine test outside `tests/plaza/` needs its own `@pytest.mark.asyncio`. Tests inside `tests/plaza/` get the marker automatically from that package's `pytest_pycollect_makeitem` hook and run against a real Postgres 17 (CI service container via `TEST_DATABASE_URL`; locally an `initdb` cluster; skipped if neither).
- **CI gate:** `ruff check .` → `python -m compileall -q -f .` → `pytest -x --tb=short -q`. All three must pass before any commit is considered done.
- **Commits:** one per task, conventional prefix (`feat:` / `fix:` / `test:` / `chore:`). Append the session attribution trailer the repo is using:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_012CxJpLkSpNFeXLVTrUfhWo
  ```
- **Do not push to `main` without asking.** Railway auto-deploys from `main`; there is no staging.

---

## File Structure

| File | Responsibility |
|---|---|
| `services/alerts.py` **(new)** | The dispatch layer. Channel abstraction, per-condition cooldown, raise/resolve state, log-only fallback. Knows nothing about plazas, databases or jobs. |
| `services/plaza_alerts.py` *(modify)* | Unchanged behaviour; its channel/cooldown internals become a thin binding over `services/alerts.py`. |
| `services/db_watchdog.py` **(new)** | 60 s probe of the pool on a dedicated `NullPool` engine, 5 s cap, 3-strike alert, recovery notice, last-result accessor for `/ready`. |
| `database.py` *(modify)* | Adds `ops_engine` — a `NullPool` engine with its own short timeouts, used by the watchdog, the job registry and the advisory locks so none of them competes for the request pool. |
| `services/job_registry.py` **(new)** | `heartbeat()` upsert, `list_jobs()`, `check_deadman()`. The Python half of the registry. |
| `services/job_locks.py` **(new)** | `job_lock(name)` async context manager over `pg_try_advisory_lock`, with a concurrency semaphore and a hard "skip the tick" answer. |
| `routers/ops.py` **(new)** | `GET /ops/jobs` (platform-admin) and `POST /ops/heartbeat/{job_name}` (service key) — the one page that shows every scheduled job and when it last succeeded. |
| `main.py` *(modify)* | Wires the watchdog task, wraps each of the seven loop bodies in a lock + heartbeat, includes the ops router, exposes the watchdog result on `/ready`. |
| `routers/cameras.py` *(modify, Task 8)* | Per-camera workers get `supervised()`. |
| `services/heartbeat.py` *(modify, Task 6)* | `run_health_monitor` also runs the dead-man check. |
| `migrations/20260905*_ops_job_runs.sql` **(new)** | `ops_job_runs` table + `ops_job_heartbeat()` SECURITY DEFINER function (the transport for pg_cron and edge functions). |
| `migrations/20260905*_outbound_notices.sql` **(new, optional Task 11)** | `outbound_notices` table for persisted notice-delivery intent. |
| `services/outbound_notices.py` **(new, optional Task 11)** | Enqueue + retry sweep for tow/cooldown/apartment emails. |
| `/Users/gabe/lotlogic/supabase/functions/cron-sessions-sweep/index.ts` *(modify, Task 9)* | Calls `ops_job_heartbeat` at the end of a successful run. |
| `/Users/gabe/lotlogic-agent/lib/job.sh` *(modify, Task 10)* | `_job_finish` also POSTs the verdict to `/ops/heartbeat/{job}`. |

---

## Scope calls — where the code contradicts the program doc

The doc merges eleven findings into 2.7. Three of them do not belong in a monitoring plan, and one is smaller than the doc implies. Decisions, made here so no executor has to re-litigate them:

1. **PIPE-8 (“the minute cron re-scans whole pass tables with N+1 lookups, unbounded”) — OUT.** This is a query-shape problem inside the `cron-sessions-sweep` edge function. It has no bearing on the dead-man contract; fixing it changes enforcement behaviour on the live plaza. It belongs with Wave 3 item 3.4 (“push allowlist matching into SQL so it stops silently truncating at 200 rows”), which already owns that file. **This plan gives that job a heartbeat (Task 9) and does not touch its query.**
2. **PIPE-10 (“a retried camera POST is processed twice; the de-dup hash is dead”) — OUT, and already double-booked.** Wave 3 item 3.4 explicitly says “make the retried-frame de-duplication work again (the hash and its index exist; the code that read them was deleted in April)”. It is an idempotency bug in `camera-snapshot`, not a monitoring gap. Leave it to 3.4.
3. **REL-10 (“camera feed workers unsupervised, boot-only, leak tasks”) — IN, minimally.** `routers/cameras.py:383 run_all_camera_workers()` spawns tasks straight into `_worker_tasks` with no `supervised()` wrapper, unlike the seven lifespan loops. That is a three-line fix and Task 8 does it. It does **not** get per-worker alerting or a registry row: these workers poll the legacy `cameras` table (the retired Reolink/zone pipeline), and fat decisions 2 and 3 propose deleting that entire stack. Building alerting for code queued for deletion is the fat this program exists to stop.
4. **REL-14 (“three notification vendors, one dead”) — IN, asymmetrically.** `config.py` already has the single `sms_enabled` flag (default `False`) and `services/heartbeat.py:_send_camera_alert` honours it. `services/plaza_alerts._send_sms_channel` does **not** — it sends whenever `PLAZA_ALERT_SMS_TO` is set. The new `services/alerts.py` ops channel gates SMS on `sms_enabled`; `plaza_alerts` keeps its current ungated behaviour, because gating it would change the outcome of ~30 tests that this plan is required to leave passing, and its SMS destination is empty in production anyway. **Recorded as open decision D3.**
5. **BACKEND-19 (“two per-camera queries inside a loop on lot state and health monitor”) — the health-monitor half is deferred.** Task 6 adds the dead-man check to `run_health_monitor` as a separate function; it does not refactor `check_camera_health`’s per-camera `SELECT`/`INSERT` on the legacy `Alert` table — same reason as 3 above. The lot-state half lives in `routers/lots.py` and is untouched here.
6. **“An external uptime check per public surface” — partly done.** `.github/workflows/uptime.yml` on branch `ops/uptime-probe` covers `/ready` and the PostgREST path. The QR registration page (`visit.html`) and the dashboard (`/app`) have no external probe. **Recorded as open decision D1**; this plan does not add them, because item 2.7’s third layer is the dead-man, and the external layer is already a landed artifact awaiting a merge decision.
7. **“Errors flow to one tracker with a request id” — already done.** `main.py` installs `install_request_id_logging()` and `init_sentry(settings)`; `services/observability.py` exists. Wave 1 item 17 landed. Nothing to do.

---

## Task Sequence

| # | Task | Depends on |
|---|---|---|
| 1 | `services/alerts.py` — the dispatch layer | — |
| 2 | `plaza_alerts` becomes a caller (behaviour frozen) | 1 |
| 3 | `database.ops_engine` + `services/db_watchdog.py` | 1 |
| 4 | Wire the watchdog into the lifespan and `/ready` | 3 |
| 5 | Migration: `ops_job_runs` + `ops_job_heartbeat()` | — |
| 6 | `services/job_registry.py` + backend loops stamp heartbeats | 5 |
| 7 | Dead-man checker in `run_health_monitor` | 6, 1 |
| 8 | `routers/ops.py` — `GET /ops/jobs`, `POST /ops/heartbeat/{job}` | 6 |
| 9 | `services/job_locks.py` + advisory locks around each loop tick; supervise camera workers | 6 |
| 10 | pg_cron and edge-function heartbeats (frontend repo) | 5, 8 |
| 11 | Laptop jobs heartbeat via `lib/job.sh` | 8 |
| 12 | **Optional / last:** `outbound_notices` + retry sweep | 5, 1 |

---

*(Tasks 1–12 follow. Each is self-contained: exact files, exact code, the command to run, the expected output, the commit.)*

---

### Task 1: `services/alerts.py` — the dispatch layer

**Files:**
- Create: `services/alerts.py`
- Modify: `config.py` (add three ops fields to `Settings`, after the `plaza_alert_email_to` field around line 155)
- Test: `tests/test_alerts.py`

**Interfaces:**
- Consumes: `services.email.send_email(to, subject, html, attachments=None, from_email=None) -> str` (raises `EmailDeliveryError` on non-2xx); `services.sms.send_sms(to, body) -> str | None` (returns `None` on failure, never raises for Twilio's own errors); `config.get_settings()`.
- Produces, for every later task:
  - `alerts.Channels(email_to, sms_to, send_email, send_sms)` — a frozen dataclass of four zero-or-kwarg callables.
  - `await alerts.send_on_channels(condition: str, subject: str, body: str, *, channels: Channels, label: str, logger: logging.Logger, max_body_chars: int = 300) -> tuple[str, str]` returning `(email_result, sms_result)`, each `"ok" | "fail" | "off"`.
  - `await alerts.dispatch(condition, subject, body, *, channels, last_sent: dict[str, datetime], now: datetime, label: str, logger: logging.Logger, unconfigured_log: str, cooldown_minutes: int = 60, max_body_chars: int = 300) -> str` returning `"sent" | "suppressed" | "failed"`.
  - `alerts.ops_channels() -> Channels`
  - `await alerts.notify_ops(condition: str, subject: str, body: str, *, now: datetime | None = None, cooldown_minutes: int = 60) -> str`
  - `await alerts.resolve_ops(condition: str, subject: str, body: str, *, now: datetime | None = None) -> str` returning `"sent" | "not_active" | "failed"`
  - `alerts.active_ops_conditions() -> list[str]`
  - `alerts.reset_ops_state() -> None`

- [ ] **Step 1: Add the ops settings to `config.py`**

Insert immediately after the `plaza_alert_email_to: str = ""` field (currently the last field in the `── Ops alerting ──` block):

```python
    # Ops alerts — the generic channel behind services/alerts.py. Everything
    # that is not a money alert and not a camera alert reports here: the
    # database watchdog, the job dead-man, a notice that could not be
    # delivered. Comma-separated list allowed. Empty falls back to
    # CAMERA_ALERT_EMAIL_TO so a deployment that already receives camera
    # alarms starts receiving these without a new environment variable; empty
    # for both means log-only.
    ops_alert_email_to: str = ""
    # Bodies are capped before they go out. 600 rather than the plaza's 300:
    # an ops email is read on a laptop, and SMS is off in this deployment
    # (see SMS_ENABLED) so nothing here is billed per segment.
    ops_alert_max_body_chars: int = 600
    # One alert per condition per hour. These are STATES, not events — a
    # database that is still down is still down on the next evaluation.
    ops_alert_cooldown_minutes: int = 60
```

- [ ] **Step 2: Write the failing tests**

Create `tests/test_alerts.py`:

```python
"""services/alerts.py — the ops dispatch layer (Wave 2.7, systemic move S1).

Everything the money alerts learned the hard way, generalised: two channels
attempted, either one landing counts as reported, the cooldown armed ONLY on a
successful send, an unconfigured deployment still leaves a WARNING behind, and
nothing in here ever raises — an alerting failure must not take down the loop
that would have reported the next failure.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

import pytest

from services import alerts

NOW = datetime(2026, 9, 5, 12, 0, tzinfo=timezone.utc)


def _channels(*, email=None, sms=None, email_to=("ops@example.invalid",), sms_to=""):
    """Build a Channels whose senders record calls into the lists they close over."""
    async def _default_email(**kwargs):
        return "msg-id"

    async def _default_sms(**kwargs):
        return "SM_fake"

    return alerts.Channels(
        email_to=lambda: list(email_to),
        sms_to=lambda: sms_to,
        send_email=email or _default_email,
        send_sms=sms or _default_sms,
    )


@pytest.fixture(autouse=True)
def _clean():
    alerts.reset_ops_state()
    yield
    alerts.reset_ops_state()


@pytest.mark.asyncio
async def test_email_only_deployment_reports_and_arms_the_cooldown():
    sent = []

    async def _email(**kwargs):
        sent.append(kwargs)
        return "msg-id"

    last_sent: dict[str, datetime] = {}
    result = await alerts.dispatch(
        "database_unreachable", "[LotLogic] db down", "3 consecutive probe failures",
        channels=_channels(email=_email), last_sent=last_sent, now=NOW,
        label="ops alert", logger=logging.getLogger("services.alerts"),
        unconfigured_log="ops alert (no OPS_ALERT_EMAIL_TO configured)",
    )

    assert result == "sent"
    assert last_sent == {"database_unreachable": NOW}
    assert sent[0]["to"] == ["ops@example.invalid"]
    assert sent[0]["subject"] == "[LotLogic] db down"
    assert "3 consecutive probe failures" in sent[0]["html"]


@pytest.mark.asyncio
async def test_a_failed_send_does_not_arm_the_cooldown():
    """M7. Arming on failure buys an outage a full hour of silence on a
    condition nobody has actually been told about."""
    async def _boom(**kwargs):
        raise RuntimeError("sendgrid 502")

    last_sent: dict[str, datetime] = {}
    result = await alerts.dispatch(
        "database_unreachable", "s", "b",
        channels=_channels(email=_boom), last_sent=last_sent, now=NOW,
        label="ops alert", logger=logging.getLogger("services.alerts"),
        unconfigured_log="unconfigured",
    )

    assert result == "failed"
    assert last_sent == {}


@pytest.mark.asyncio
async def test_either_channel_landing_counts_as_reported():
    """The point is that somebody was told, not which wire carried it."""
    async def _boom_email(**kwargs):
        raise RuntimeError("sendgrid down")

    async def _ok_sms(**kwargs):
        return "SM_ok"

    last_sent: dict[str, datetime] = {}
    result = await alerts.dispatch(
        "job_overdue:db-monitor", "s", "b",
        channels=_channels(email=_boom_email, sms=_ok_sms, sms_to="+15550000000"),
        last_sent=last_sent, now=NOW, label="ops alert",
        logger=logging.getLogger("services.alerts"), unconfigured_log="unconfigured",
    )

    assert result == "sent"
    assert last_sent == {"job_overdue:db-monitor": NOW}


@pytest.mark.asyncio
async def test_sms_returning_none_is_a_failure_not_a_success():
    """send_sms swallows Twilio's own errors and returns None. That is a
    failure — the Twilio account returns 401 in this deployment."""
    async def _none_sms(**kwargs):
        return None

    email_res, sms_res = await alerts.send_on_channels(
        "c", "s", "b",
        channels=_channels(email_to=(), sms=_none_sms, sms_to="+15550000000"),
        label="ops alert", logger=logging.getLogger("services.alerts"),
    )
    assert (email_res, sms_res) == ("off", "fail")


@pytest.mark.asyncio
async def test_no_destination_configured_is_log_only_and_still_arms(caplog):
    last_sent: dict[str, datetime] = {}
    with caplog.at_level(logging.INFO, logger="services.alerts"):
        result = await alerts.dispatch(
            "database_unreachable", "s", "probe failed 3x",
            channels=_channels(email_to=(), sms_to=""), last_sent=last_sent, now=NOW,
            label="ops alert", logger=logging.getLogger("services.alerts"),
            unconfigured_log="ops alert (no OPS_ALERT_EMAIL_TO configured)",
        )

    assert result == "sent"
    assert last_sent == {"database_unreachable": NOW}
    warnings = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
    assert any("OPS_ALERT_EMAIL_TO" in m for m in warnings), warnings


@pytest.mark.asyncio
async def test_the_cooldown_suppresses_a_repeat_and_expires():
    last_sent: dict[str, datetime] = {}
    kwargs = dict(
        channels=_channels(), label="ops alert",
        logger=logging.getLogger("services.alerts"), unconfigured_log="unconfigured",
        cooldown_minutes=60,
    )
    first = await alerts.dispatch("c", "s", "b", last_sent=last_sent, now=NOW, **kwargs)
    within = await alerts.dispatch(
        "c", "s", "b", last_sent=last_sent, now=NOW + timedelta(minutes=59), **kwargs)
    after = await alerts.dispatch(
        "c", "s", "b", last_sent=last_sent, now=NOW + timedelta(minutes=61), **kwargs)

    assert (first, within, after) == ("sent", "suppressed", "sent")


@pytest.mark.asyncio
async def test_bodies_are_truncated():
    sent = []

    async def _email(**kwargs):
        sent.append(kwargs)
        return "msg-id"

    await alerts.send_on_channels(
        "c", "s", "x" * 5000, channels=_channels(email=_email),
        label="ops alert", logger=logging.getLogger("services.alerts"),
        max_body_chars=300,
    )
    # The body is HTML-escaped inside a <pre>, so assert on the payload we fed
    # the channel rather than on the wrapper's length.
    assert sent[0]["html"].count("x") == 300


@pytest.mark.asyncio
async def test_notify_ops_marks_the_condition_active_and_resolve_clears_it(monkeypatch):
    sent = []

    async def _email(**kwargs):
        sent.append(kwargs["subject"])
        return "msg-id"

    monkeypatch.setattr(alerts, "ops_channels", lambda: _channels(email=_email))

    raised = await alerts.notify_ops("database_unreachable", "[LotLogic] db down", "b", now=NOW)
    assert raised == "sent"
    assert alerts.active_ops_conditions() == ["database_unreachable"]

    recovered = await alerts.resolve_ops(
        "database_unreachable", "[LotLogic] db recovered", "b",
        now=NOW + timedelta(minutes=5))
    assert recovered == "sent"
    assert alerts.active_ops_conditions() == []
    assert sent == ["[LotLogic] db down", "[LotLogic] db recovered"]


@pytest.mark.asyncio
async def test_resolve_on_a_condition_that_never_fired_sends_nothing(monkeypatch):
    """No 'recovered' for something nobody was told about."""
    sent = []

    async def _email(**kwargs):
        sent.append(kwargs)
        return "msg-id"

    monkeypatch.setattr(alerts, "ops_channels", lambda: _channels(email=_email))
    result = await alerts.resolve_ops("never_fired", "s", "b", now=NOW)

    assert result == "not_active"
    assert sent == []


@pytest.mark.asyncio
async def test_recovery_is_not_held_back_by_the_raise_cooldown(monkeypatch):
    """The 'it is back' message is the one message that must never be eaten."""
    sent = []

    async def _email(**kwargs):
        sent.append(kwargs["subject"])
        return "msg-id"

    monkeypatch.setattr(alerts, "ops_channels", lambda: _channels(email=_email))
    await alerts.notify_ops("c", "down", "b", now=NOW)
    result = await alerts.resolve_ops("c", "up", "b", now=NOW + timedelta(minutes=1))

    assert result == "sent"
    assert sent == ["down", "up"]


@pytest.mark.asyncio
async def test_a_second_raise_after_a_recovery_alerts_immediately(monkeypatch):
    """resolve_ops clears the cooldown too, so a flapping condition is not
    silent for the rest of the hour."""
    sent = []

    async def _email(**kwargs):
        sent.append(kwargs["subject"])
        return "msg-id"

    monkeypatch.setattr(alerts, "ops_channels", lambda: _channels(email=_email))
    await alerts.notify_ops("c", "down-1", "b", now=NOW)
    await alerts.resolve_ops("c", "up", "b", now=NOW + timedelta(minutes=1))
    again = await alerts.notify_ops("c", "down-2", "b", now=NOW + timedelta(minutes=2))

    assert again == "sent"
    assert sent == ["down-1", "up", "down-2"]


@pytest.mark.asyncio
async def test_the_ops_sms_channel_is_gated_on_sms_enabled(monkeypatch):
    """REL-14. Twilio returns 401; SMS is off until one flag says otherwise."""
    from config import get_settings

    settings = get_settings()
    monkeypatch.setattr(settings, "sms_enabled", False)
    monkeypatch.setattr(settings, "ops_alert_phone", "+15550000000")
    assert alerts.ops_channels().sms_to() == ""

    monkeypatch.setattr(settings, "sms_enabled", True)
    assert alerts.ops_channels().sms_to() == "+15550000000"


@pytest.mark.asyncio
async def test_ops_email_falls_back_to_the_camera_alert_recipients(monkeypatch):
    from config import get_settings

    settings = get_settings()
    monkeypatch.setattr(settings, "ops_alert_email_to", "")
    monkeypatch.setattr(settings, "camera_alert_email_to", "a@example.invalid, b@example.invalid")
    assert alerts.ops_channels().email_to() == ["a@example.invalid", "b@example.invalid"]

    monkeypatch.setattr(settings, "ops_alert_email_to", "c@example.invalid")
    assert alerts.ops_channels().email_to() == ["c@example.invalid"]
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
pytest tests/test_alerts.py -q
```
Expected: collection error — `ModuleNotFoundError: No module named 'services.alerts'`.

- [ ] **Step 4: Write `services/alerts.py`**

```python
"""services/alerts.py — one dispatch layer for every ops alert (S1, Wave 2.7).

This is ``services/plaza_alerts.py``'s channel machinery with the plaza taken
out of it. That module is the only alerting in the repo that has ever reached a
human, and everything it learned is preserved here verbatim:

* **Two channels, both attempted, either one landing counts.** The point is
  that somebody was told, not which wire carried it. Email is primary —
  Twilio returns 401 in this deployment, so an SMS-only alert is an alert
  nobody receives.
* **A per-condition cooldown, armed ONLY on a successful send.** The things we
  alert on are *states*, not events: a database that is down is still down on
  the next evaluation, and without the cooldown a bad hour sends twelve
  identical emails. Arming it on a *failed* send would buy an outage a full
  hour of silence on a condition nobody has actually been told about.
* **Log-only when nothing is configured.** A WARNING, not silence — and it
  arms the cooldown, because for that deployment the log line IS the delivery.
* **PII discipline.** Counts, ages, ids, condition names. Never a plate, a
  phone number, a company or a name. An ops mailbox is no more a place for
  those than an ops SMS is.
* **Nothing raises.** An alerting failure must not take down the loop that
  would have reported the next failure.

Two layers, deliberately:

``send_on_channels``  fire one message at whatever channels are configured and
                      report what each one did. No memory, no cooldown.
``dispatch``          the above plus the cooldown, keyed by condition, using a
                      caller-supplied ``last_sent`` dict so each caller owns
                      (and can inspect and reset) its own state.

Callers inject their channels rather than importing senders here, which is what
lets ``plaza_alerts`` keep its own module-level ``send_sms`` / ``send_email`` /
``_alert_to`` names — the names its test suite monkeypatches in thirty places.
It is also how a new channel arrives later: restore Twilio, or add a Pushover
sender, and only ``ops_channels()`` changes.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from html import escape
from typing import Awaitable, Callable

from config import get_settings
from services.email import send_email as _send_email
from services.sms import send_sms as _send_sms

log = logging.getLogger(__name__)

#: Default hard cap on an outgoing body. Twilio bills per 160-char segment and
#: an ops mail nobody reads to the end is an ops mail nobody reads.
DEFAULT_MAX_BODY_CHARS = 300


@dataclass(frozen=True)
class Channels:
    """The four things a dispatcher needs, injected rather than imported.

    ``email_to``    -> list of recipients, empty means "channel off"
    ``sms_to``      -> one destination, empty means "channel off"
    ``send_email``  -> awaitable, called with ``to=``, ``subject=``, ``html=``,
                       ``from_email=``. Raises on failure.
    ``send_sms``    -> awaitable, called with ``to=``, ``body=``. Returns a sid,
                       or ``None`` for a failure it already swallowed.
    """

    email_to: Callable[[], list[str]]
    sms_to: Callable[[], str]
    send_email: Callable[..., Awaitable[str]]
    send_sms: Callable[..., Awaitable[str | None]]


def _html_body(body: str) -> str:
    """The same monospace wrapper the money alerts have always used."""
    return (
        '<pre style="font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;'
        f'white-space:pre-wrap">{escape(body)}</pre>'
    )


async def _email_channel(
    condition: str, subject: str, body: str, *, channels: Channels,
    label: str, logger: logging.Logger, from_email: str | None,
) -> str:
    """Send on the email channel. ``"ok"`` | ``"fail"`` | ``"off"``. Never raises."""
    to = channels.email_to()
    if not to:
        return "off"
    try:
        await channels.send_email(
            to=to, subject=subject, html=_html_body(body), from_email=from_email,
        )
    except Exception:
        logger.warning("%s: email failed for %s", label, condition, exc_info=True)
        return "fail"
    return "ok"


async def _sms_channel(
    condition: str, body: str, *, channels: Channels,
    label: str, logger: logging.Logger,
) -> str:
    """Send on the SMS channel. ``"ok"`` | ``"fail"`` | ``"off"``. Never raises."""
    to = channels.sms_to()
    if not to:
        return "off"
    try:
        sid = await channels.send_sms(to=to, body=body)
    except Exception:
        logger.warning("%s: send_sms raised for %s", label, condition, exc_info=True)
        return "fail"
    if sid is None:
        # send_sms swallows Twilio's own errors and answers None. That is a
        # failure, and treating it as a success is how the camera alarm went
        # unheard for months.
        logger.warning("%s: SMS not sent for %s", label, condition)
        return "fail"
    return "ok"


async def send_on_channels(
    condition: str,
    subject: str,
    body: str,
    *,
    channels: Channels,
    label: str,
    logger: logging.Logger,
    from_email: str | None = None,
    max_body_chars: int = DEFAULT_MAX_BODY_CHARS,
) -> tuple[str, str]:
    """Attempt every configured channel once. Returns ``(email, sms)`` results.

    Both are attempted when both are configured; neither result gates the
    other. No cooldown, no memory — see ``dispatch`` for those.
    """
    body = body[:max_body_chars]
    email_result = await _email_channel(
        condition, subject, body, channels=channels, label=label,
        logger=logger, from_email=from_email,
    )
    sms_result = await _sms_channel(
        condition, body, channels=channels, label=label, logger=logger,
    )
    return email_result, sms_result


async def dispatch(
    condition: str,
    subject: str,
    body: str,
    *,
    channels: Channels,
    last_sent: dict[str, datetime],
    now: datetime,
    label: str,
    logger: logging.Logger,
    unconfigured_log: str,
    from_email: str | None = None,
    cooldown_minutes: int = 60,
    max_body_chars: int = DEFAULT_MAX_BODY_CHARS,
) -> str:
    """One alert, cooldown-aware. ``"sent"`` | ``"suppressed"`` | ``"failed"``.

    ``last_sent`` is mutated in place and belongs to the caller, so a module
    keeping its own cooldown memory can still expose, assert on and reset it.

    ``sent``        it went out on at least one configured channel — or, with
                    neither configured, the WARNING log line that IS the alert
                    in that deployment.
    ``suppressed``  this condition's cooldown is still running.
    ``failed``      a destination is configured and every configured channel
                    failed. The cooldown is NOT armed, so the next evaluation
                    tries again.

    Never raises.
    """
    previous = last_sent.get(condition)
    if previous is not None and now - previous < timedelta(minutes=cooldown_minutes):
        return "suppressed"

    email_result, sms_result = await send_on_channels(
        condition, subject, body, channels=channels, label=label, logger=logger,
        from_email=from_email, max_body_chars=max_body_chars,
    )

    if email_result == "off" and sms_result == "off":
        logger.warning("%s %s: %s", unconfigured_log, condition, body[:max_body_chars])
        last_sent[condition] = now
        return "sent"

    logger.info("%s channels %s email=%s sms=%s", label, condition,
                email_result, sms_result)

    if email_result == "ok" or sms_result == "ok":
        last_sent[condition] = now
        return "sent"
    return "failed"


# ── the ops caller ──────────────────────────────────────────────────────────
#: condition -> when it was last SENT. Not "last fired".
_ops_last_sent: dict[str, datetime] = {}
#: conditions currently raised. A "recovered" message is only sent for a
#: condition that is in here, so nobody gets an all-clear for an alarm they
#: were never told about.
_ops_active: set[str] = set()

OPS_LABEL = "ops alert"
OPS_UNCONFIGURED_LOG = "ops alert (no OPS_ALERT_EMAIL_TO / CAMERA_ALERT_EMAIL_TO configured)"


def _ops_email_to() -> list[str]:
    """OPS_ALERT_EMAIL_TO, falling back to the camera-alarm recipients.

    The fallback is deliberate: a deployment already receiving camera outage
    email should start receiving the database watchdog and the job dead-man
    without anyone having to add an environment variable first.
    """
    settings = get_settings()
    raw = (settings.ops_alert_email_to or "").strip() or (settings.camera_alert_email_to or "")
    return [a.strip() for a in raw.split(",") if a.strip()]


def _ops_sms_to() -> str:
    """One destination, and only when the master SMS flag is on (REL-14).

    The Twilio account returns 401. Every SMS path added after it died is gated
    on this one flag so restoring the account is one variable, not seven edits.
    """
    settings = get_settings()
    if not settings.sms_enabled:
        return ""
    return (settings.ops_alert_phone or "").strip()


def ops_channels() -> Channels:
    """The channels every ops alert uses. The one place a new channel lands."""
    return Channels(
        email_to=_ops_email_to,
        sms_to=_ops_sms_to,
        send_email=_send_email,
        send_sms=_send_sms,
    )


async def notify_ops(
    condition: str,
    subject: str,
    body: str,
    *,
    now: datetime | None = None,
    cooldown_minutes: int | None = None,
) -> str:
    """Raise one ops condition. ``"sent"`` | ``"suppressed"`` | ``"failed"``.

    The condition is remembered as active on ``sent`` so ``resolve_ops`` can
    later send the matching all-clear.
    """
    settings = get_settings()
    now = now or datetime.now(timezone.utc)
    result = await dispatch(
        condition, subject, body,
        channels=ops_channels(), last_sent=_ops_last_sent, now=now,
        label=OPS_LABEL, logger=log, unconfigured_log=OPS_UNCONFIGURED_LOG,
        from_email=(settings.cooldown_from_email or None),
        cooldown_minutes=(settings.ops_alert_cooldown_minutes
                          if cooldown_minutes is None else cooldown_minutes),
        max_body_chars=settings.ops_alert_max_body_chars,
    )
    if result == "sent":
        _ops_active.add(condition)
    return result


async def resolve_ops(
    condition: str,
    subject: str,
    body: str,
    *,
    now: datetime | None = None,
) -> str:
    """Clear one ops condition. ``"sent"`` | ``"not_active"`` | ``"failed"``.

    Deliberately exempt from the cooldown: "it is back" is the one message that
    must never be eaten, and it also CLEARS the cooldown, so a condition that
    flaps alerts again immediately rather than being silent for the rest of the
    hour.
    """
    if condition not in _ops_active:
        return "not_active"

    settings = get_settings()
    now = now or datetime.now(timezone.utc)
    email_result, sms_result = await send_on_channels(
        condition, subject, body, channels=ops_channels(), label=OPS_LABEL,
        logger=log, from_email=(settings.cooldown_from_email or None),
        max_body_chars=settings.ops_alert_max_body_chars,
    )

    if email_result == "off" and sms_result == "off":
        log.warning("%s %s RECOVERED: %s", OPS_UNCONFIGURED_LOG, condition, body)
        _ops_active.discard(condition)
        _ops_last_sent.pop(condition, None)
        return "sent"

    log.info("%s channels %s(recovered) email=%s sms=%s", OPS_LABEL, condition,
             email_result, sms_result)

    if email_result == "ok" or sms_result == "ok":
        _ops_active.discard(condition)
        _ops_last_sent.pop(condition, None)
        return "sent"
    return "failed"


def active_ops_conditions() -> list[str]:
    """Every currently-raised ops condition, sorted. Read by ``/ops/jobs``."""
    return sorted(_ops_active)


def reset_ops_state() -> None:
    """Drop every piece of module state. Tests and a manual ops reset only."""
    _ops_last_sent.clear()
    _ops_active.clear()
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd /Users/gabe/lotlogic-backend/.worktrees/uptime && pytest tests/test_alerts.py -q && ruff check services/alerts.py config.py tests/test_alerts.py
```
Expected: `14 passed`, ruff clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/gabe/lotlogic-backend/.worktrees/uptime
git add services/alerts.py config.py tests/test_alerts.py
git commit -m "feat(ops): generalise the money-alert dispatch into services/alerts.py

Two channels attempted, either one landing counts as reported, per-condition
cooldown armed only on a successful send, log-only WARNING when nothing is
configured, and a recovery path that is exempt from the cooldown. Channels are
injected so a restored Twilio or a new sender lands in one function.

Wave 2.7 / S1. No behaviour change anywhere yet — plaza_alerts becomes the
first caller in the next commit."
```

---

### Task 2: `plaza_alerts` becomes a caller — behaviour frozen

**Files:**
- Modify: `services/plaza_alerts.py` (replace `_send_email_channel`, `_send_sms_channel`, `_send` and the channel half of `send_reconcile_alert`; lines ~176–255)
- Test: `tests/plaza/test_plaza_alerts.py` — **not modified.** It is the acceptance test for this task.

**Interfaces:**
- Consumes: `alerts.Channels`, `alerts.send_on_channels`, `alerts.dispatch` from Task 1.
- Produces: nothing new. `plaza_alerts.record_signature_failure()`, `record_orphan_capture()`, `reset_state()`, `evaluate_alerts()`, `send_reconcile_alert()`, `_last_sent`, `_alert_to`, `_alert_email_to`, `send_email`, `send_sms`, `COOLDOWN_MINUTES`, `MAX_BODY_CHARS` all keep their exact names and semantics. `routers/plaza_payments.py:756` and `:838` call the first two and must keep working untouched.

**Why this is delicate:** `tests/plaza/test_plaza_alerts.py` monkeypatches `plaza_alerts.send_sms`, `plaza_alerts.send_email`, `plaza_alerts._alert_to` and `plaza_alerts._alert_email_to` in about thirty places, asserts `plaza_alerts._last_sent == {}` after a failed send, and asserts on two exact log strings emitted by the `services.plaza_alerts` logger:
- `"plaza alert channels pending_over_10m email=ok sms=off"`
- a WARNING containing `"PLAZA_ALERT_EMAIL_TO"`

So the binding must (a) resolve every sender through **plaza_alerts' own module globals at call time**, (b) pass `plaza_alerts`' own `log` object into the dispatcher, (c) pass `label="plaza alert"` so the channel line reads exactly as before, and (d) hand the dispatcher `_last_sent` itself rather than a copy.

- [ ] **Step 1: Run the existing suite to record the green baseline**

```bash
pytest tests/plaza/test_plaza_alerts.py -q
```
Expected: all pass (or the whole file skips with "no PostgreSQL available" — if it skips, install Postgres 17 or export `TEST_DATABASE_URL` before continuing; a skipped acceptance test proves nothing).

- [ ] **Step 2: Add the import and the channel binding**

In `services/plaza_alerts.py`, add to the import block (after `from config import get_settings`):

```python
from services import alerts
```

Then, immediately after `_email_subject`, add:

```python
def _channels() -> alerts.Channels:
    """Bind the shared dispatcher to THIS module's names.

    Every callable below resolves its target through ``plaza_alerts``' module
    globals at call time. That is load-bearing, not stylistic: the suite in
    ``tests/plaza/test_plaza_alerts.py`` monkeypatches ``plaza_alerts.send_sms``,
    ``plaza_alerts.send_email``, ``plaza_alerts._alert_to`` and
    ``plaza_alerts._alert_email_to`` in some thirty places, and a binding
    captured at import time would silently ignore all of them.
    """
    return alerts.Channels(
        email_to=lambda: _alert_email_to(),
        sms_to=lambda: _alert_to(),
        send_email=lambda **kw: send_email(**kw),
        send_sms=lambda **kw: send_sms(**kw),
    )


#: The label the dispatcher stamps on its log lines. Kept as a constant so the
#: exact string ``"plaza alert channels <condition> email=… sms=…"`` that the
#: suite asserts on cannot drift.
_LABEL = "plaza alert"
_UNCONFIGURED_LOG = (
    "plaza alert (no PLAZA_ALERT_EMAIL_TO / PLAZA_ALERT_SMS_TO configured)"
)
```

- [ ] **Step 3: Replace the three channel functions with the binding**

Delete `_send_email_channel` and `_send_sms_channel` entirely. Replace the body of `_send` (keeping its docstring verbatim — it is the record of why the cooldown arms only on success) with:

```python
async def _send(condition: str, body: str, *, now: datetime) -> str:
    """Dispatch one alert. Returns ``"sent"``, ``"suppressed"`` or ``"failed"``.

    ``sent``        it went out on at least ONE configured channel — an email,
                    an SMS, or, with neither destination configured, the
                    WARNING log line that IS the alert in that deployment.
    ``suppressed``  the 60-minute cooldown for this condition is still running.
    ``failed``      a destination is configured and every configured channel
                    failed.

    Both channels are attempted when both are configured. Either one landing is
    enough: the condition has been reported, and sending the same text twice an
    hour later because the other wire was down is noise, not safety.

    **The cooldown is armed only on ``sent`` (M7).** Arming it on a failed send
    would buy an outage a full hour of silence on a condition nobody has
    actually been told about; leaving it unarmed means the next evaluation, five
    minutes later, tries again. Log-only mode still arms it — the log line is a
    successful delivery for that deployment.

    The machinery itself now lives in ``services/alerts.py`` (Wave 2.7 / S1);
    this function is the plaza's binding of it. Behaviour is unchanged.

    Never raises.
    """
    return await alerts.dispatch(
        condition,
        _email_subject(condition),
        body,
        channels=_channels(),
        last_sent=_last_sent,
        now=now,
        label=_LABEL,
        logger=log,
        unconfigured_log=_UNCONFIGURED_LOG,
        from_email=(get_settings().cooldown_from_email or None),
        cooldown_minutes=COOLDOWN_MINUTES,
        max_body_chars=MAX_BODY_CHARS,
    )
```

- [ ] **Step 4: Rewrite the channel half of `send_reconcile_alert`, keeping its return contract**

```python
async def send_reconcile_alert(body: str) -> bool:
    """The daily reconciliation's channel — same two channels, NO cooldown.

    Deliberately exempt: the reconciliation runs once a day, so an hour-long
    cooldown shared with anything else could swallow the one message it ever
    sends. Returns True if the alert went out on at least one channel — note
    that an unconfigured deployment returns **False** here, unlike ``_send``,
    because the caller logs its own summary either way.
    """
    email_result, sms_result = await alerts.send_on_channels(
        "reconcile",
        _email_subject("reconcile"),
        body,
        channels=_channels(),
        label=_LABEL,
        logger=log,
        from_email=(get_settings().cooldown_from_email or None),
        max_body_chars=MAX_BODY_CHARS,
    )

    if email_result == "off" and sms_result == "off":
        log.warning(
            "plaza reconcile alert (no PLAZA_ALERT_EMAIL_TO / PLAZA_ALERT_SMS_TO "
            "configured): %s", body,
        )
        return False

    log.info("plaza alert channels reconcile email=%s sms=%s", email_result, sms_result)
    return email_result == "ok" or sms_result == "ok"
```

- [ ] **Step 5: Delete the now-unused imports**

`escape` (from `html`) and `timedelta` are no longer used in `plaza_alerts.py` if nothing else references them — check before deleting; `timedelta` may still be used elsewhere in the module. Ruff's `F401` will name any that are genuinely dead. `send_email` and `send_sms` **must stay imported** even though only the lambdas call them: they are the names the tests patch.

- [ ] **Step 6: Run the acceptance suite**

```bash
cd /Users/gabe/lotlogic-backend/.worktrees/uptime && pytest tests/plaza/test_plaza_alerts.py -q && pytest tests/test_alerts.py -q && ruff check services/plaza_alerts.py
```
Expected: the same count of passes as Step 1, zero failures, ruff clean. **If any test in that file needed editing, the task is wrong — revert and rebind, do not edit the test.**

- [ ] **Step 7: Run the whole suite (the plaza tests reach into `plaza_sweep` and `routers/plaza_payments`)**

```bash
cd /Users/gabe/lotlogic-backend/.worktrees/uptime && pytest -x --tb=short -q
```
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
cd /Users/gabe/lotlogic-backend/.worktrees/uptime
git add services/plaza_alerts.py
git commit -m "refactor(ops): plaza_alerts dispatches through services/alerts.py

The channel/cooldown/PII machinery moved to services/alerts.py in the previous
commit; this makes the money alerts its first caller. Behaviour is byte-for-byte
identical — same two channels, same 60-minute per-condition cooldown armed only
on success, same log strings — and tests/plaza/test_plaza_alerts.py is unchanged
and still green, which is the proof.

The binding resolves send_email / send_sms / _alert_to / _alert_email_to through
this module's globals at call time so the suite's ~30 monkeypatches still land."
```

---

### Task 3: `database.ops_engine` + `services/db_watchdog.py`

**Files:**
- Modify: `database.py` (append after `AsyncSessionLocal`)
- Create: `services/db_watchdog.py`
- Test: `tests/test_db_watchdog.py`

**Interfaces:**
- Consumes: `alerts.notify_ops`, `alerts.resolve_ops` (Task 1); `config.get_settings()`.
- Produces:
  - `database.ops_engine: AsyncEngine` — `NullPool`, 5 s connect + command timeout, `application_name=lotlogic-ops`. Used by this task and by Tasks 6 and 9.
  - `database.OPS_CONNECT_ARGS: dict`
  - `await db_watchdog.probe_once(*, timeout_s: float | None = None) -> tuple[bool, float, str | None]` → `(ok, latency_ms, error_or_None)`
  - `await db_watchdog.tick(*, now: datetime | None = None) -> dict` → the new last-result dict
  - `db_watchdog.last_result() -> dict` → `{"ok", "checked_at", "latency_ms", "consecutive_failures", "error"}`
  - `await db_watchdog.run_db_watchdog(interval_seconds: int | None = None) -> None` — the loop body for `supervised()`
  - `db_watchdog.reset_state() -> None`

**Why a second engine.** During the 2026-09-04 incident supavisor answered `ECHECKOUTTIMEOUT`: the main pool had no free slot and every borrower queued forever. A watchdog that borrows from that pool measures the queue, not the database, and worse, it takes a slot from a request. `ops_engine` uses `NullPool` — it opens a connection, uses it, closes it — with its own 5 s connect timeout, so a probe either answers within 5 s or reports a failure. It costs at most one transient pooler slot per probe (one every 60 s), against a pooler pool size of 20 and a backend ceiling of `8 + 7 = 15`.

- [ ] **Step 1: Add `ops_engine` to `database.py`**

Append after the `AsyncSessionLocal = async_sessionmaker(...)` block:

```python
# ── Ops engine ────────────────────────────────────────────────────────────
# A second engine, deliberately NOT pooled, for everything that has to be able
# to reach Postgres *while the main pool is wedged*: the database watchdog, the
# job-registry heartbeat, and the advisory locks around each background loop.
#
# During the 2026-09-04 incident supavisor answered ECHECKOUTTIMEOUT for 95
# minutes — the main pool had no free slot and every borrower queued. A probe
# that borrows from that pool measures the queue, not the database, and takes a
# slot from a real request while doing it. NullPool opens a connection, uses it,
# and closes it, so a probe either answers inside the timeout or reports a
# failure.
#
#   timeout          — asyncpg CONNECT timeout (5 s). This is the one that
#                      matters: it is the leg that hangs when the pooler is out
#                      of slots.
#   command_timeout  — client-side cap on the statement itself (5 s).
#   statement_timeout— server-side cap, one notch above, so the client wins.
OPS_TIMEOUT_SECONDS = 5

OPS_CONNECT_ARGS = {
    "timeout": OPS_TIMEOUT_SECONDS,
    "command_timeout": OPS_TIMEOUT_SECONDS,
    "server_settings": {
        "application_name": "lotlogic-ops",
        "statement_timeout": str(OPS_TIMEOUT_SECONDS * 1000 + 1000),
    },
}

ops_engine = create_async_engine(
    settings.database_url,
    poolclass=NullPool,
    echo=False,
    connect_args=OPS_CONNECT_ARGS,
)
```

and extend the import at the top of the file:

```python
from sqlalchemy.pool import NullPool
```

- [ ] **Step 2: Write the failing tests**

Create `tests/test_db_watchdog.py`:

```python
"""services/db_watchdog.py — the probe that survives the pool being wedged.

2026-09-04 22:50 → 2026-09-05 00:25 ET: supavisor returned ECHECKOUTTIMEOUT for
95 minutes, /ready answered 503 the whole time, and the only thing that told a
human was a macOS desktop notification from a laptop that happened to be awake.

The contract this file pins down:
  * three CONSECUTIVE failures alert, not the first (a single slow probe during
    a deploy is not an outage)
  * the alert is raised once, not every 60 seconds
  * coming back sends a recovery notice
  * the probe never raises, never hangs past its timeout, and never borrows
    from the pool it is measuring
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from services import db_watchdog

NOW = datetime(2026, 9, 5, 12, 0, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
def _clean():
    db_watchdog.reset_state()
    from services import alerts
    alerts.reset_ops_state()
    yield
    db_watchdog.reset_state()
    alerts.reset_ops_state()


@pytest.fixture
def raised(monkeypatch) -> list[tuple[str, str]]:
    """Capture notify_ops / resolve_ops instead of sending anything."""
    calls: list[tuple[str, str]] = []

    async def _notify(condition, subject, body, **kwargs):
        calls.append(("raise", condition))
        return "sent"

    async def _resolve(condition, subject, body, **kwargs):
        calls.append(("resolve", condition))
        return "sent"

    monkeypatch.setattr(db_watchdog.alerts, "notify_ops", _notify)
    monkeypatch.setattr(db_watchdog.alerts, "resolve_ops", _resolve)
    return calls


def _probe(results):
    """Return a fake probe_once that yields `results` in order, then repeats the last."""
    seq = list(results)

    async def _fake(*, timeout_s=None):
        item = seq.pop(0) if len(seq) > 1 else seq[0]
        return item

    return _fake


OK = (True, 12.0, None)
FAIL = (False, 5000.0, "TimeoutError: connect timed out")


@pytest.mark.asyncio
async def test_a_healthy_probe_records_success_and_alerts_nothing(monkeypatch, raised):
    monkeypatch.setattr(db_watchdog, "probe_once", _probe([OK]))

    result = await db_watchdog.tick(now=NOW)

    assert result["ok"] is True
    assert result["consecutive_failures"] == 0
    assert result["error"] is None
    assert raised == []


@pytest.mark.asyncio
async def test_two_failures_do_not_alert(monkeypatch, raised):
    """A single slow probe during a deploy is not an outage."""
    monkeypatch.setattr(db_watchdog, "probe_once", _probe([FAIL]))

    await db_watchdog.tick(now=NOW)
    result = await db_watchdog.tick(now=NOW + timedelta(seconds=60))

    assert result["consecutive_failures"] == 2
    assert raised == []


@pytest.mark.asyncio
async def test_the_third_consecutive_failure_alerts_once(monkeypatch, raised):
    monkeypatch.setattr(db_watchdog, "probe_once", _probe([FAIL]))

    for i in range(5):
        await db_watchdog.tick(now=NOW + timedelta(seconds=60 * i))

    assert raised == [("raise", "database_unreachable")]
    assert db_watchdog.last_result()["consecutive_failures"] == 5


@pytest.mark.asyncio
async def test_a_success_between_failures_resets_the_count(monkeypatch, raised):
    monkeypatch.setattr(db_watchdog, "probe_once", _probe([FAIL, FAIL, OK, FAIL]))

    await db_watchdog.tick(now=NOW)
    await db_watchdog.tick(now=NOW + timedelta(seconds=60))
    await db_watchdog.tick(now=NOW + timedelta(seconds=120))
    result = await db_watchdog.tick(now=NOW + timedelta(seconds=180))

    assert result["consecutive_failures"] == 1
    assert raised == []


@pytest.mark.asyncio
async def test_recovery_sends_the_all_clear(monkeypatch, raised):
    monkeypatch.setattr(db_watchdog, "probe_once", _probe([FAIL, FAIL, FAIL, OK]))

    for i in range(4):
        await db_watchdog.tick(now=NOW + timedelta(seconds=60 * i))

    assert raised == [("raise", "database_unreachable"),
                      ("resolve", "database_unreachable")]


@pytest.mark.asyncio
async def test_a_probe_that_raises_is_a_failure_not_a_crash(monkeypatch, raised):
    async def _boom(*, timeout_s=None):
        raise RuntimeError("engine is gone")

    monkeypatch.setattr(db_watchdog, "probe_once", _boom)

    result = await db_watchdog.tick(now=NOW)

    assert result["ok"] is False
    assert "engine is gone" in result["error"]


@pytest.mark.asyncio
async def test_an_alerting_failure_does_not_break_the_tick(monkeypatch):
    async def _boom(*args, **kwargs):
        raise RuntimeError("sendgrid exploded")

    monkeypatch.setattr(db_watchdog.alerts, "notify_ops", _boom)
    monkeypatch.setattr(db_watchdog, "probe_once", _probe([FAIL]))

    for i in range(3):
        result = await db_watchdog.tick(now=NOW + timedelta(seconds=60 * i))

    assert result["consecutive_failures"] == 3


@pytest.mark.asyncio
async def test_the_alert_body_carries_no_pii(monkeypatch):
    bodies = []

    async def _notify(condition, subject, body, **kwargs):
        bodies.append(body)
        return "sent"

    monkeypatch.setattr(db_watchdog.alerts, "notify_ops", _notify)
    monkeypatch.setattr(db_watchdog, "probe_once", _probe([FAIL]))

    for i in range(3):
        await db_watchdog.tick(now=NOW + timedelta(seconds=60 * i))

    assert bodies, "the third failure must alert"
    banned = ("resident", "visitor", "permanent", "temporary", "guest", "driver", "@")
    for body in bodies:
        for word in banned:
            assert word not in body.lower(), (word, body)


def test_last_result_before_the_first_probe_is_unknown_not_healthy():
    """/ready must not claim the watchdog is green before it has ever run."""
    result = db_watchdog.last_result()
    assert result["ok"] is None
    assert result["checked_at"] is None
    assert result["consecutive_failures"] == 0
```

- [ ] **Step 3: Run to verify failure**

```bash
cd /Users/gabe/lotlogic-backend/.worktrees/uptime && pytest tests/test_db_watchdog.py -q
```
Expected: `ModuleNotFoundError: No module named 'services.db_watchdog'`.

- [ ] **Step 4: Write `services/db_watchdog.py`**

```python
"""services/db_watchdog.py — is the database actually reachable? (Wave 2.7)

The incident this exists for: 2026-09-04 22:50 → 2026-09-05 00:25 ET. The
Supabase project was on a Nano instance, it saturated, supavisor answered
``ECHECKOUTTIMEOUT`` for ninety-five minutes, ``/ready`` returned 503 for all of
it, and the only thing that told a human was a macOS desktop notification from a
laptop script that happened to be awake.

Three design points, each one a lesson from that night:

1. **It must not borrow from the pool it is measuring.** During the outage every
   borrower of the main pool queued forever. A probe on that pool measures the
   queue, not the database, and takes a slot from a real request while doing it.
   This one runs on ``database.ops_engine`` — ``NullPool``, its own 5 s connect
   timeout — so a probe either answers or fails, and holds nothing.
2. **Three strikes, not one.** A single slow probe during a Railway deploy or a
   Supabase failover is not an outage. Three consecutive misses over three
   minutes is.
3. **It alerts once, and it says when it is over.** The condition is a state.
   ``services/alerts.py`` handles the "once" (per-condition cooldown) and the
   "over" (recovery message, exempt from that cooldown).

The last result is exposed on ``/ready`` so the external uptime probe and a
human curl see the same fact.
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone

from sqlalchemy import text

import database
from config import get_settings
from services import alerts

log = logging.getLogger(__name__)

#: The one condition name this module raises. Stable — it is the cooldown key
#: and it appears in /ops/jobs.
CONDITION = "database_unreachable"

#: Nothing has probed yet. `ok: None` rather than `False` on purpose: /ready
#: must not claim the watchdog is red before it has ever run, and must not
#: claim it is green either.
_state: dict = {
    "ok": None,
    "checked_at": None,
    "latency_ms": None,
    "consecutive_failures": 0,
    "error": None,
}


def reset_state() -> None:
    """Drop the probe memory. Tests and a manual ops reset only."""
    _state.update({
        "ok": None, "checked_at": None, "latency_ms": None,
        "consecutive_failures": 0, "error": None,
    })


def last_result() -> dict:
    """The last probe, as a JSON-safe dict. Read by /ready — must not block."""
    return dict(_state)


async def probe_once(*, timeout_s: float | None = None) -> tuple[bool, float, str | None]:
    """One ``SELECT 1`` on the ops engine. Returns ``(ok, latency_ms, error)``.

    Never raises: a probe that raises is a probe that stops probing. The
    ``asyncio.wait_for`` is a belt over asyncpg's own connect timeout —
    ``connect_args["timeout"]`` should fire first, but a hang between the two is
    exactly the failure mode this module exists to catch.
    """
    settings = get_settings()
    cap = timeout_s if timeout_s is not None else settings.db_watchdog_timeout_seconds
    started = time.monotonic()

    async def _run():
        async with database.ops_engine.connect() as conn:
            await conn.execute(text("SELECT 1"))

    try:
        await asyncio.wait_for(_run(), timeout=cap)
    except asyncio.TimeoutError:
        return False, (time.monotonic() - started) * 1000, f"timeout after {cap}s"
    except Exception as exc:
        return False, (time.monotonic() - started) * 1000, f"{type(exc).__name__}: {exc}"
    return True, (time.monotonic() - started) * 1000, None


async def tick(*, now: datetime | None = None) -> dict:
    """One probe, one state update, and the alert or all-clear that follows.

    Returns the new ``last_result()``. Never raises — including when the
    alerting itself fails, because a SendGrid outage must not stop the loop that
    would have reported the next database outage.
    """
    settings = get_settings()
    now = now or datetime.now(timezone.utc)

    try:
        ok, latency_ms, error = await probe_once()
    except Exception as exc:
        # probe_once is written not to raise; this is the guard for anything
        # past it (a repointed engine, a monkeypatch in a test).
        ok, latency_ms, error = False, 0.0, f"{type(exc).__name__}: {exc}"

    _state["ok"] = ok
    _state["checked_at"] = now.isoformat()
    _state["latency_ms"] = round(latency_ms, 1)
    _state["error"] = error
    _state["consecutive_failures"] = 0 if ok else _state["consecutive_failures"] + 1

    failures = _state["consecutive_failures"]
    threshold = settings.db_watchdog_failures_before_alert

    try:
        if not ok and failures >= threshold:
            log.error("db watchdog: %d consecutive failures — %s", failures, error)
            await alerts.notify_ops(
                CONDITION,
                "[LotLogic] database unreachable",
                # Counts, ages and a driver-level error string. No plate, no
                # phone, no address — an ops mailbox is not a place for PII.
                f"The API cannot reach Postgres.\n"
                f"Consecutive failed probes: {failures}\n"
                f"Probe interval: {settings.db_watchdog_interval_seconds}s\n"
                f"Probe timeout: {settings.db_watchdog_timeout_seconds}s\n"
                f"Last error: {error}\n\n"
                f"While this is true: registrations fail, the QR form returns "
                f"an error, /ready answers 503, and no exits are recorded.",
                now=now,
            )
        elif ok and failures == 0:
            await alerts.resolve_ops(
                CONDITION,
                "[LotLogic] database reachable again",
                f"Postgres is answering again ({_state['latency_ms']}ms).",
                now=now,
            )
    except Exception:
        log.warning("db watchdog: alerting failed", exc_info=True)

    return last_result()


async def run_db_watchdog(interval_seconds: int | None = None) -> None:
    """The loop. Pass to ``supervised("db_watchdog", ...)`` from the lifespan."""
    settings = get_settings()
    interval = interval_seconds or settings.db_watchdog_interval_seconds
    log.info("Database watchdog started (interval: %ss, timeout: %ss, alert after %d)",
             interval, settings.db_watchdog_timeout_seconds,
             settings.db_watchdog_failures_before_alert)
    while True:
        try:
            await tick()
        except Exception as exc:
            # tick is written not to raise. A background loop must outlive
            # whatever one iteration hits regardless.
            log.error("db watchdog tick error: %s", exc)
        await asyncio.sleep(interval)
```

- [ ] **Step 5: Add the watchdog settings to `config.py`**

Immediately after the `ops_alert_cooldown_minutes` field added in Task 1:

```python
    # ── Database watchdog (Wave 2.7) ──────────────────────────
    # A probe every 60s on a NullPool engine that cannot be starved by the pool
    # it is measuring. Three consecutive failures — three minutes — is an
    # outage; one slow probe during a deploy is not.
    db_watchdog_enabled: bool = True
    db_watchdog_interval_seconds: int = 60
    db_watchdog_timeout_seconds: float = 5.0
    db_watchdog_failures_before_alert: int = 3
```

- [ ] **Step 6: Run to verify pass**

```bash
cd /Users/gabe/lotlogic-backend/.worktrees/uptime && pytest tests/test_db_watchdog.py -q && ruff check services/db_watchdog.py database.py config.py
```
Expected: `9 passed`, ruff clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/gabe/lotlogic-backend/.worktrees/uptime
git add services/db_watchdog.py database.py config.py tests/test_db_watchdog.py
git commit -m "feat(ops): database watchdog on a pool that cannot be starved

Probes SELECT 1 every 60s over a new NullPool ops_engine with a 5s connect
timeout, so it measures Postgres rather than the queue in front of it. Three
consecutive failures raise 'database unreachable' through services/alerts.py;
recovery sends the all-clear.

The 2026-09-04 incident ran 95 minutes with /ready at 503 and no alert. This is
the in-process half of the answer; the GitHub Actions probe is the external half."
```

---

### Task 4: Wire the watchdog into the lifespan and onto `/ready`

**Files:**
- Modify: `main.py` — the lifespan (add one task next to the seven existing ones, and one cancel), and both `/ready` return paths (lines ~493–530)
- Test: `tests/test_readiness.py` (append two tests; do not change the existing ones)

**Interfaces:**
- Consumes: `db_watchdog.run_db_watchdog`, `db_watchdog.last_result` (Task 3); `services.task_supervisor.supervised`.
- Produces: `/ready` JSON gains a `"db_watchdog"` key on both the 200 and the 503 path. Nothing consumes it in this repo — the external probe and a human curl do.

**Note on the two timeouts.** `main.READY_TIMEOUT_SECONDS = 2.0` is Railway's readiness budget and stays 2 s; the watchdog's cap is 5 s. They measure different things: `/ready` says "can this instance serve the next request", the watchdog says "has the database been unreachable for three minutes". Do not unify them.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_readiness.py`:

```python
def test_ready_reports_the_watchdog_alongside_its_own_probe(monkeypatch):
    """One curl answers both questions: can I serve now, and has the database
    been unreachable for the last three minutes."""
    import database
    import main
    from services import db_watchdog

    db_watchdog.reset_state()
    monkeypatch.setattr(database, "AsyncSessionLocal", _session_factory())

    async def go():
        async with _client() as c:
            return await c.get("/ready")

    resp = asyncio.run(go())
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ready"
    assert body["db_watchdog"]["ok"] is None          # never probed in-process
    assert body["db_watchdog"]["consecutive_failures"] == 0


def test_ready_reports_the_watchdog_on_the_503_path_too(monkeypatch):
    """The 95-minute outage is exactly when you want the failure count."""
    import database
    import main
    from services import db_watchdog

    db_watchdog.reset_state()
    db_watchdog._state.update({
        "ok": False, "checked_at": "2026-09-05T04:00:00+00:00",
        "latency_ms": 5000.0, "consecutive_failures": 7,
        "error": "timeout after 5.0s",
    })
    monkeypatch.setattr(database, "AsyncSessionLocal", _session_factory(fail=True))

    async def go():
        async with _client() as c:
            return await c.get("/ready")

    resp = asyncio.run(go())
    assert resp.status_code == 503
    body = resp.json()
    assert body["database"] == "down"
    assert body["db_watchdog"]["consecutive_failures"] == 7
    assert body["db_watchdog"]["error"] == "timeout after 5.0s"
    db_watchdog.reset_state()
```

- [ ] **Step 2: Run to verify failure**

```bash
pytest tests/test_readiness.py -q
```
Expected: two failures — `KeyError: 'db_watchdog'`.

- [ ] **Step 3: Add the import and the lifespan task in `main.py`**

Add to the imports, next to `from services.heartbeat import ...`:

```python
from services.db_watchdog import run_db_watchdog, last_result as db_watchdog_result
```

In the lifespan, immediately after the `monitor_task = asyncio.create_task(...)` / `log.info("Health monitor started.")` pair:

```python
    # Database watchdog (Wave 2.7). Runs on database.ops_engine (NullPool, 5s
    # connect timeout), NOT the request pool — during the 2026-09-04 incident
    # every borrower of the request pool queued for 95 minutes, so a probe on
    # it would have measured the queue and stolen a slot from a driver.
    db_watchdog_task = None
    if settings.db_watchdog_enabled:
        db_watchdog_task = asyncio.create_task(supervised(
            "db_watchdog", run_db_watchdog,
        ))
        log.info("Database watchdog started.")
```

In the shutdown block, add the cancel and include it in the await loop:

```python
    if db_watchdog_task is not None:
        db_watchdog_task.cancel()
```

and change the tuple to:

```python
    for t in (pinger_task, monitor_task, reminder_task, pass_expiry_task,
              plaza_sweep_task, plaza_alerts_task, plaza_reconcile_task,
              db_watchdog_task):
        if t is None:
            continue
        try:
            await t
        except asyncio.CancelledError:
            pass
```

- [ ] **Step 4: Add the watchdog result to both `/ready` payloads**

In `readiness_check`, add `"db_watchdog": db_watchdog_result(),` to the 503 `content` dict (both the `TimeoutError` and the generic `except` branches) and to the 200 return dict. The 200 return becomes:

```python
    return {
        "status": "ready",
        "database": "ok",
        "db_watchdog": db_watchdog_result(),
        "version": settings.app_version,
    }
```

- [ ] **Step 5: Run to verify pass**

```bash
cd /Users/gabe/lotlogic-backend/.worktrees/uptime && pytest tests/test_readiness.py -q && ruff check main.py
```
Expected: all pass (the four pre-existing readiness tests plus the two new), ruff clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/gabe/lotlogic-backend/.worktrees/uptime
git add main.py tests/test_readiness.py
git commit -m "feat(ops): run the database watchdog and publish it on /ready

One curl now answers both questions — can this instance serve the next request,
and has Postgres been unreachable for the last three minutes. The watchdog task
is gated on DB_WATCHDOG_ENABLED and joins the lifespan's cancel-and-await set."
```

---

### Task 5: Migration — `ops_job_runs` + `ops_job_heartbeat()`

**Files:**
- Create: `migrations/20260905090000_ops_job_runs.sql`
- Modify: `tests/plaza/conftest.py` — `MIGRATION_GLOB` (line ~72) so the harness replays this migration too
- Test: `tests/plaza/test_ops_job_runs.py`

**Interfaces:**
- Produces, for Tasks 6, 8, 10 and 11:
  - table `public.ops_job_runs` — PK `job_name`
  - function `public.ops_job_heartbeat(p_job_name text, p_source text, p_expected_interval_s integer, p_ok boolean, p_error text) RETURNS void`, `SECURITY DEFINER`
  - the four `source` values: `'backend' | 'pg_cron' | 'edge' | 'laptop'`

**Where the tests live.** `tests/plaza/conftest.py` owns the only real-Postgres harness in the repo (`engine`, `db_conn`, the drop-and-rebuild of schema `public`, the production-canary refusal). Rather than fork it, DB-backed ops tests live in that package with a docstring saying the directory name refers to the harness, not the subject. Lifting the harness to `tests/conftest_pg.py` belongs to Wave 2.4 (rebuildable schema baseline) — recorded as open decision **D5**.

- [ ] **Step 1: Write the migration**

Create `migrations/20260905090000_ops_job_runs.sql`:

```sql
-- Wave 2.7 — one job registry, one dead-man.
--
-- Twenty-three scheduled jobs across four runtimes (in-process asyncio loops in
-- the FastAPI process, pg_cron rows calling edge functions over pg_net, edge
-- functions, and launchd jobs on a MacBook) and exactly one of them had an
-- alert. On 2026-08-30 a sweep failed outright and reported "done".
--
-- One row per job. Every runtime writes it: the backend through
-- services/job_registry.py, pg_cron and the edge functions through
-- ops_job_heartbeat() below, the laptop through POST /ops/heartbeat/{job}.
-- One checker reads it (services/job_registry.check_deadman) and alerts when a
-- job has been quiet for more than 2x its declared interval.
--
-- The rule this encodes: a monitor that cannot prove it ran is a monitor that
-- is down.

CREATE TABLE IF NOT EXISTS public.ops_job_runs (
    job_name              text PRIMARY KEY,
    -- Which runtime writes this row. Constrained so a typo cannot invent a
    -- fifth class of job that nothing knows how to interpret.
    source                text NOT NULL
                          CHECK (source IN ('backend', 'pg_cron', 'edge', 'laptop')),
    -- How often the job is SUPPOSED to succeed. The dead-man fires at 2x this,
    -- so one skipped run is tolerated and two are not.
    expected_interval_s   integer NOT NULL CHECK (expected_interval_s > 0),
    -- A job can be parked without deleting its history (a paused laptop job, a
    -- cron schedule turned off) — the checker skips a disabled row.
    enabled               boolean NOT NULL DEFAULT true,
    last_started_at       timestamptz,
    last_succeeded_at     timestamptz,
    last_failed_at        timestamptz,
    -- Truncated by the writer. Never a plate, a phone or a customer name: this
    -- table is read by an alerting path that emails it.
    last_error            text,
    consecutive_failures  integer NOT NULL DEFAULT 0,
    -- When the row first appeared. The checker uses it as the grace baseline
    -- for a job that has registered but never yet succeeded, so a freshly
    -- deployed job is not instantly overdue.
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.ops_job_runs IS
    'One row per scheduled job in the estate (backend loop, pg_cron, edge '
    'function, laptop job). Written on every run, read by the dead-man checker '
    'and by GET /ops/jobs. Wave 2.7.';

-- The checker's only query shape: enabled rows ordered by how long they have
-- been quiet. Small table (tens of rows) — this index is for correctness of
-- plan shape as the estate grows, not for today.
CREATE INDEX IF NOT EXISTS idx_ops_job_runs_quiet
    ON public.ops_job_runs (enabled, last_succeeded_at);

-- No tenant owns this table; it is platform operations. Deny both browser
-- roles outright rather than relying on the absence of a policy.
ALTER TABLE public.ops_job_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ops_job_runs FROM anon, authenticated;

-- ── the transport for pg_cron and the edge functions ────────────────────────
--
-- pg_cron runs as the job's owner and the edge functions hold the service key.
-- Neither has (or should have) a direct grant on the table, so both go through
-- this function. SECURITY DEFINER with a pinned search_path: without the pin, a
-- caller who can create a schema on the search path can shadow ops_job_runs.
CREATE OR REPLACE FUNCTION public.ops_job_heartbeat(
    p_job_name            text,
    p_source              text,
    p_expected_interval_s integer,
    p_ok                  boolean DEFAULT true,
    p_error               text    DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
    INSERT INTO public.ops_job_runs AS j (
        job_name, source, expected_interval_s,
        last_started_at, last_succeeded_at, last_failed_at,
        last_error, consecutive_failures, updated_at
    )
    VALUES (
        p_job_name, p_source, p_expected_interval_s,
        now(),
        CASE WHEN p_ok THEN now() END,
        CASE WHEN p_ok THEN NULL ELSE now() END,
        CASE WHEN p_ok THEN NULL ELSE left(p_error, 1000) END,
        CASE WHEN p_ok THEN 0 ELSE 1 END,
        now()
    )
    ON CONFLICT (job_name) DO UPDATE SET
        source               = EXCLUDED.source,
        expected_interval_s  = EXCLUDED.expected_interval_s,
        last_started_at      = EXCLUDED.last_started_at,
        -- COALESCE, not EXCLUDED: a failed run must not erase the last time
        -- the job actually worked. That timestamp is what the dead-man reads.
        last_succeeded_at    = COALESCE(EXCLUDED.last_succeeded_at, j.last_succeeded_at),
        last_failed_at       = COALESCE(EXCLUDED.last_failed_at, j.last_failed_at),
        last_error           = CASE WHEN p_ok THEN NULL ELSE left(p_error, 1000) END,
        consecutive_failures = CASE WHEN p_ok THEN 0 ELSE j.consecutive_failures + 1 END,
        updated_at           = now();
END;
$fn$;

COMMENT ON FUNCTION public.ops_job_heartbeat(text, text, integer, boolean, text) IS
    'Record one run of a scheduled job. Called by pg_cron job bodies and by '
    'edge functions; the backend uses services/job_registry.py instead.';

REVOKE ALL ON FUNCTION public.ops_job_heartbeat(text, text, integer, boolean, text)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ops_job_heartbeat(text, text, integer, boolean, text)
    TO service_role, postgres;
```

- [ ] **Step 2: Let the test harness replay it**

In `tests/plaza/conftest.py`, change:

```python
MIGRATION_GLOB = "20260902*.sql"
```

to:

```python
#: Migration files replayed on top of the live-schema extract, in sorted order
#: across every pattern. 20260902* is the pay-to-park set; 20260905* is the
#: Wave 2.7 ops-monitoring set (ops_job_runs, outbound_notices).
MIGRATION_GLOBS = ("20260902*.sql", "20260905*.sql")
```

and update its single use site (the loop that applies the migrations) to iterate both patterns and sort the union:

```python
    migration_files = sorted(
        {p for pattern in MIGRATION_GLOBS
           for p in (REPO_ROOT / "migrations").glob(pattern)},
        key=lambda p: p.name,
    )
```

Locate the existing use with `grep -n MIGRATION_GLOB tests/plaza/conftest.py` and replace in place; keep the surrounding logging untouched.

- [ ] **Step 3: Write the failing tests**

Create `tests/plaza/test_ops_job_runs.py`:

```python
"""migrations/20260905090000_ops_job_runs.sql — the job registry.

These run against the real harness Postgres, so every assertion below is
PostgreSQL behaviour rather than a reading of the SQL text: the CHECK that
refuses a fifth source, the upsert that does NOT erase last_succeeded_at on a
failure, the failure counter that resets on a success.

(The file lives in tests/plaza/ because that package owns the repo's only
real-Postgres harness. The directory name refers to the fixtures, not to the
subject — see Wave 2.4 for lifting the harness out.)
"""
import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError


async def _heartbeat(session, job, *, source="backend", interval=300, ok=True, error=None):
    await session.execute(
        text("SELECT public.ops_job_heartbeat(:j, :s, :i, :ok, :e)"),
        {"j": job, "s": source, "i": interval, "ok": ok, "e": error},
    )
    await session.commit()


async def _row(session, job):
    return (await session.execute(
        text("SELECT * FROM public.ops_job_runs WHERE job_name = :j"), {"j": job}
    )).mappings().first()


async def test_a_first_successful_run_creates_the_row(db_conn):
    await _heartbeat(db_conn, "plaza_sweep", interval=120)
    row = await _row(db_conn, "plaza_sweep")

    assert row["source"] == "backend"
    assert row["expected_interval_s"] == 120
    assert row["enabled"] is True
    assert row["last_succeeded_at"] is not None
    assert row["last_failed_at"] is None
    assert row["consecutive_failures"] == 0


async def test_a_failure_does_not_erase_the_last_success(db_conn):
    """The dead-man reads last_succeeded_at. A failed run must not blank it —
    otherwise a job that fails once looks like a job that has never run."""
    await _heartbeat(db_conn, "reminder_loop")
    first = await _row(db_conn, "reminder_loop")

    await _heartbeat(db_conn, "reminder_loop", ok=False, error="connection refused")
    after = await _row(db_conn, "reminder_loop")

    assert after["last_succeeded_at"] == first["last_succeeded_at"]
    assert after["last_failed_at"] is not None
    assert after["last_error"] == "connection refused"
    assert after["consecutive_failures"] == 1


async def test_consecutive_failures_accumulate_and_a_success_clears_them(db_conn):
    for _ in range(3):
        await _heartbeat(db_conn, "db-monitor", source="laptop", ok=False, error="boom")
    assert (await _row(db_conn, "db-monitor"))["consecutive_failures"] == 3

    await _heartbeat(db_conn, "db-monitor", source="laptop")
    row = await _row(db_conn, "db-monitor")
    assert row["consecutive_failures"] == 0
    assert row["last_error"] is None


async def test_a_long_error_is_truncated_not_rejected(db_conn):
    await _heartbeat(db_conn, "weekly-review", source="laptop", ok=False, error="x" * 5000)
    assert len((await _row(db_conn, "weekly-review"))["last_error"]) == 1000


async def test_an_unknown_source_is_refused(db_conn):
    with pytest.raises(Exception):
        await _heartbeat(db_conn, "mystery", source="cronjob-from-nowhere")
    await db_conn.rollback()


async def test_a_zero_interval_is_refused(db_conn):
    """expected_interval_s = 0 would make the dead-man threshold 0 and page
    forever."""
    with pytest.raises(Exception):
        await _heartbeat(db_conn, "bad-interval", interval=0)
    await db_conn.rollback()


async def test_row_level_security_is_on(db_conn):
    """The table is platform ops. Neither browser role gets near it."""
    enabled = (await db_conn.execute(text(
        "SELECT relrowsecurity FROM pg_class WHERE relname = 'ops_job_runs'"
    ))).scalar_one()
    assert enabled is True


async def test_the_heartbeat_function_pins_its_search_path(db_conn):
    """SECURITY DEFINER without a pinned search_path is how a definer function
    gets pointed at somebody else's table."""
    config = (await db_conn.execute(text(
        "SELECT proconfig FROM pg_proc WHERE proname = 'ops_job_heartbeat'"
    ))).scalar_one()
    assert config is not None
    assert any(c.startswith("search_path=") for c in config), config
```

- [ ] **Step 4: Run to verify failure**

```bash
cd /Users/gabe/lotlogic-backend/.worktrees/uptime && pytest tests/plaza/test_ops_job_runs.py -q
```
Expected: failures with `relation "public.ops_job_runs" does not exist` (if the harness cannot find Postgres it will skip instead — fix that first; see Task 2 Step 1).

- [ ] **Step 5: Run to verify pass, after the conftest edit lands**

```bash
cd /Users/gabe/lotlogic-backend/.worktrees/uptime && pytest tests/plaza/ -q
```
Expected: the new 8 pass, every pre-existing plaza test still passes.

- [ ] **Step 6: Apply the migration to production**

Use the Supabase MCP `apply_migration` with name `20260905090000_ops_job_runs` and the file's contents verbatim, so the row lands in `supabase_migrations.schema_migrations`. Do **not** paste it into the SQL editor — a raw editor run does not record, and this repo already carries 30+ applied migrations with no file.

Verify:

```sql
SELECT to_regclass('public.ops_job_runs') AS tbl,
       (SELECT count(*) FROM pg_proc WHERE proname = 'ops_job_heartbeat') AS fn;
```
Expected: `public.ops_job_runs | 1`.

- [ ] **Step 7: Commit**

```bash
cd /Users/gabe/lotlogic-backend/.worktrees/uptime
git add migrations/20260905090000_ops_job_runs.sql tests/plaza/test_ops_job_runs.py tests/plaza/conftest.py
git commit -m "feat(ops): ops_job_runs registry + ops_job_heartbeat()

One row per scheduled job across all four runtimes. A failed run stamps
last_failed_at and bumps consecutive_failures without erasing last_succeeded_at,
which is the timestamp the dead-man reads.

ops_job_heartbeat() is SECURITY DEFINER with a pinned search_path, granted to
service_role and postgres only — it is the transport for pg_cron job bodies and
edge functions, which hold no grant on the table itself.

The plaza harness now replays 20260905*.sql alongside 20260902*.sql so these
migrations are exercised against a real Postgres in CI."
```

---

### Task 6: `services/job_registry.py` + every backend loop stamps a heartbeat

**Files:**
- Create: `services/job_registry.py`
- Modify: `main.py` — each of the seven loop bodies plus the watchdog loop
- Test: `tests/test_job_registry.py` (unit, stubbed connection) and `tests/plaza/test_job_registry_db.py` (real Postgres)

**Interfaces:**
- Consumes: `database.ops_engine` (Task 3); table + function from Task 5.
- Produces, for Tasks 7, 8, 10:
  - `await job_registry.heartbeat(job_name: str, *, source: str = "backend", expected_interval_s: int, ok: bool = True, error: str | None = None) -> bool` — returns whether the write landed. **Never raises.**
  - `await job_registry.list_jobs() -> list[dict]` — every row, JSON-safe, ordered by `job_name`.
  - `await job_registry.overdue_jobs(*, now: datetime | None = None) -> list[dict]` — the rows past `2 × expected_interval_s`.
  - `job_registry.BACKEND_JOBS: dict[str, int]` — the canonical job-name → interval map for the eight in-process loops, so `main.py` and the tests cannot disagree about a name.

- [ ] **Step 1: Write the failing unit tests**

Create `tests/test_job_registry.py`:

```python
"""services/job_registry.py — the Python half of the dead-man.

The behaviour that matters when the database is the thing that is broken: a
heartbeat write that fails is swallowed, because a loop whose heartbeat raises
is a loop that stops doing its actual job. The dead-man is DB-backed anyway —
if the database is unreachable, services/db_watchdog.py is the alarm, not this.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from services import job_registry

NOW = datetime(2026, 9, 5, 12, 0, tzinfo=timezone.utc)


@pytest.mark.asyncio
async def test_a_heartbeat_write_that_fails_is_swallowed(monkeypatch, caplog):
    class _Engine:
        def begin(self):
            raise RuntimeError("ECHECKOUTTIMEOUT")

    monkeypatch.setattr(job_registry.database, "ops_engine", _Engine())

    landed = await job_registry.heartbeat("plaza_sweep", expected_interval_s=120)

    assert landed is False


@pytest.mark.asyncio
async def test_a_successful_heartbeat_reports_true(monkeypatch):
    calls = []

    class _Conn:
        async def execute(self, stmt, params=None):
            calls.append(params)

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

    class _Engine:
        def begin(self):
            return _Conn()

    monkeypatch.setattr(job_registry.database, "ops_engine", _Engine())

    landed = await job_registry.heartbeat(
        "plaza_sweep", expected_interval_s=120, ok=False, error="boom")

    assert landed is True
    assert calls[0]["j"] == "plaza_sweep"
    assert calls[0]["s"] == "backend"
    assert calls[0]["i"] == 120
    assert calls[0]["ok"] is False
    assert calls[0]["e"] == "boom"


def test_every_lifespan_loop_has_a_registry_entry():
    """A loop with no entry is a loop nothing watches — the exact gap 2.7
    exists to close. This test is the contract between main.py and the
    registry; adding an eighth loop without an interval fails the build."""
    assert set(job_registry.BACKEND_JOBS) == {
        "camera_pinger",
        "health_monitor",
        "reminder_loop",
        "pass_expiry",
        "plaza_sweep",
        "plaza_alerts",
        "plaza_reconcile",
        "db_watchdog",
    }
    for name, interval in job_registry.BACKEND_JOBS.items():
        assert interval > 0, name


def test_the_declared_intervals_match_the_sleeps_in_main():
    """main.py's asyncio.sleep values and the registry's expected intervals are
    two copies of the same number. Drift means the dead-man fires early or
    never — so read the source and assert they agree."""
    import pathlib
    import re

    source = pathlib.Path(__file__).resolve().parents[1].joinpath("main.py").read_text()
    # The loops sleep with a literal; the two supervised helpers take theirs as
    # an argument.
    assert "interval_seconds=30" in source            # camera_pinger
    assert "interval_seconds=300" in source           # health_monitor
    assert re.search(r"await asyncio\.sleep\(120\)", source)   # plaza_sweep
    assert re.search(r"await asyncio\.sleep\(300\)", source)   # the 5-minute loops

    assert job_registry.BACKEND_JOBS["camera_pinger"] == 30
    assert job_registry.BACKEND_JOBS["health_monitor"] == 300
    assert job_registry.BACKEND_JOBS["plaza_sweep"] == 120
    assert job_registry.BACKEND_JOBS["reminder_loop"] == 300
    assert job_registry.BACKEND_JOBS["pass_expiry"] == 300
    assert job_registry.BACKEND_JOBS["plaza_alerts"] == 300
    assert job_registry.BACKEND_JOBS["plaza_reconcile"] == 300
    assert job_registry.BACKEND_JOBS["db_watchdog"] == 60
```

- [ ] **Step 2: Write the failing real-Postgres tests**

Create `tests/plaza/test_job_registry_db.py`:

```python
"""services/job_registry.py against the real table.

(In tests/plaza/ for the harness — see tests/plaza/test_ops_job_runs.py.)
"""
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text

from services import job_registry


@pytest.fixture(autouse=True)
def _point_ops_engine_at_the_harness(monkeypatch, engine):
    """job_registry writes through database.ops_engine; in production that is a
    NullPool engine on the live URL. Repoint it at the harness cluster."""
    monkeypatch.setattr(job_registry.database, "ops_engine", engine)


async def test_heartbeat_round_trips_through_the_function(db_conn):
    assert await job_registry.heartbeat("plaza_sweep", expected_interval_s=120) is True

    row = (await db_conn.execute(text(
        "SELECT * FROM public.ops_job_runs WHERE job_name = 'plaza_sweep'"
    ))).mappings().one()
    assert row["source"] == "backend"
    assert row["last_succeeded_at"] is not None


async def test_list_jobs_returns_json_safe_rows(db_conn):
    await job_registry.heartbeat("plaza_sweep", expected_interval_s=120)
    await job_registry.heartbeat("db-monitor", source="laptop", expected_interval_s=300)

    jobs = await job_registry.list_jobs()
    names = [j["job_name"] for j in jobs]
    assert names == sorted(names)
    assert {"plaza_sweep", "db-monitor"} <= set(names)
    for job in jobs:
        assert isinstance(job["last_succeeded_at"], (str, type(None)))
        assert isinstance(job["quiet_seconds"], (int, type(None)))
        assert isinstance(job["overdue"], bool)


async def test_a_job_quiet_past_twice_its_interval_is_overdue(db_conn):
    await job_registry.heartbeat("stale_job", expected_interval_s=60)
    # Backdate the success past 2x60s.
    await db_conn.execute(text(
        "UPDATE public.ops_job_runs SET last_succeeded_at = now() - interval '5 minutes' "
        "WHERE job_name = 'stale_job'"))
    await db_conn.commit()

    overdue = await job_registry.overdue_jobs()
    assert [j["job_name"] for j in overdue] == ["stale_job"]
    assert overdue[0]["quiet_seconds"] >= 300


async def test_a_job_inside_twice_its_interval_is_not_overdue(db_conn):
    await job_registry.heartbeat("fresh_job", expected_interval_s=300)
    await db_conn.execute(text(
        "UPDATE public.ops_job_runs SET last_succeeded_at = now() - interval '4 minutes' "
        "WHERE job_name = 'fresh_job'"))
    await db_conn.commit()

    assert [j["job_name"] for j in await job_registry.overdue_jobs()] == []


async def test_a_disabled_job_is_never_overdue(db_conn):
    """Parking a job must not page anybody."""
    await job_registry.heartbeat("parked_job", expected_interval_s=60)
    await db_conn.execute(text(
        "UPDATE public.ops_job_runs SET enabled = false, "
        "last_succeeded_at = now() - interval '1 day' WHERE job_name = 'parked_job'"))
    await db_conn.commit()

    assert [j["job_name"] for j in await job_registry.overdue_jobs()] == []


async def test_a_registered_job_that_has_never_succeeded_gets_a_grace_window(db_conn):
    """A freshly deployed job must not be overdue the second it registers —
    but it must not be exempt forever either."""
    await job_registry.heartbeat(
        "never_ok", expected_interval_s=60, ok=False, error="first run failed")

    assert [j["job_name"] for j in await job_registry.overdue_jobs()] == []

    await db_conn.execute(text(
        "UPDATE public.ops_job_runs SET created_at = now() - interval '1 hour' "
        "WHERE job_name = 'never_ok'"))
    await db_conn.commit()

    assert [j["job_name"] for j in await job_registry.overdue_jobs()] == ["never_ok"]
```

Add `ops_job_runs` to the harness's `TRUNCATE_TABLES` tuple in `tests/plaza/conftest.py` so these tests do not leak rows into each other:

```python
TRUNCATE_TABLES = (
    "visitor_passes", "plaza_payments", "plate_holds", "plate_events",
    "plaza_reconciliations", "ops_job_runs",
)
```

- [ ] **Step 3: Run to verify failure**

```bash
pytest tests/test_job_registry.py tests/plaza/test_job_registry_db.py -q
```
Expected: `ModuleNotFoundError: No module named 'services.job_registry'`.

- [ ] **Step 4: Write `services/job_registry.py`**

```python
"""services/job_registry.py — the Python half of the dead-man (Wave 2.7).

Twenty-three scheduled jobs, one alert between them (REL-6), and a sweep that
failed outright and reported "done" (AUTO-2). The fix is one row per job, one
writer per runtime, one reader.

This module is the writer for the eight in-process loops and the reader for
everything. pg_cron and the edge functions write through
``public.ops_job_heartbeat()`` directly; the laptop writes through
``POST /ops/heartbeat/{job}``, which lands here.

Two rules the code enforces:

* **A heartbeat that cannot be written is swallowed.** A loop whose bookkeeping
  raises is a loop that stops doing its actual work. If the database is
  unreachable, ``services/db_watchdog.py`` is the alarm — not a stack trace in
  the reminder loop.
* **It writes through ``database.ops_engine``**, the NullPool engine, not the
  request pool. During the 2026-09-04 incident a heartbeat on the request pool
  would have queued for 95 minutes behind real traffic.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy import text

import database

log = logging.getLogger(__name__)

SOURCE_BACKEND = "backend"
SOURCE_PG_CRON = "pg_cron"
SOURCE_EDGE = "edge"
SOURCE_LAPTOP = "laptop"

#: The eight in-process loops and how often each is supposed to succeed. This
#: is the single source of truth for the names and the intervals — main.py
#: passes these values, tests/test_job_registry.py asserts they match the
#: sleeps in main.py, and the dead-man reads 2x them.
#:
#: An eighth loop added to the lifespan without an entry here fails
#: test_every_lifespan_loop_has_a_registry_entry — which is the point: a loop
#: nothing watches is the exact gap Wave 2.7 exists to close.
BACKEND_JOBS: dict[str, int] = {
    "camera_pinger": 30,
    "health_monitor": 300,
    "reminder_loop": 300,
    "pass_expiry": 300,
    "plaza_sweep": 120,
    "plaza_alerts": 300,
    "plaza_reconcile": 300,
    "db_watchdog": 60,
}

_HEARTBEAT_SQL = "SELECT public.ops_job_heartbeat(:j, :s, :i, :ok, :e)"

#: One query for both readers. ``quiet_seconds`` is measured from the last
#: SUCCESS, falling back to when the row was created — so a job that registered
#: and has never yet succeeded gets exactly one interval-pair of grace and then
#: becomes overdue like anything else.
_LIST_SQL = """
    SELECT job_name,
           source,
           expected_interval_s,
           enabled,
           last_started_at,
           last_succeeded_at,
           last_failed_at,
           last_error,
           consecutive_failures,
           created_at,
           EXTRACT(EPOCH FROM (
               now() - COALESCE(last_succeeded_at, created_at)
           ))::bigint AS quiet_seconds,
           (enabled
            AND COALESCE(last_succeeded_at, created_at)
                < now() - make_interval(secs => expected_interval_s * 2)
           ) AS overdue
      FROM public.ops_job_runs
     ORDER BY job_name
"""


async def heartbeat(
    job_name: str,
    *,
    source: str = SOURCE_BACKEND,
    expected_interval_s: int,
    ok: bool = True,
    error: str | None = None,
) -> bool:
    """Record one run. Returns whether the write landed. **Never raises.**"""
    try:
        async with database.ops_engine.begin() as conn:
            await conn.execute(text(_HEARTBEAT_SQL), {
                "j": job_name,
                "s": source,
                "i": expected_interval_s,
                "ok": ok,
                "e": (error or None) and str(error)[:1000],
            })
    except Exception as exc:
        # DEBUG, not WARNING: when the database is down every loop lands here
        # every tick, and the alarm for that is db_watchdog, not log volume.
        log.debug("job heartbeat failed for %s: %s", job_name, exc)
        return False
    return True


def _jsonable(row) -> dict:
    out = dict(row)
    for key in ("last_started_at", "last_succeeded_at", "last_failed_at", "created_at"):
        value = out.get(key)
        out[key] = value.isoformat() if isinstance(value, datetime) else value
    out["quiet_seconds"] = int(out["quiet_seconds"]) if out["quiet_seconds"] is not None else None
    out["overdue"] = bool(out["overdue"])
    return out


async def list_jobs() -> list[dict]:
    """Every registered job, JSON-safe, ordered by name. Raises on a DB error —
    the caller is an HTTP handler, and a 500 is the honest answer there."""
    async with database.ops_engine.connect() as conn:
        rows = (await conn.execute(text(_LIST_SQL))).mappings().all()
    return [_jsonable(r) for r in rows]


async def overdue_jobs(*, now: datetime | None = None) -> list[dict]:
    """Enabled jobs quiet for more than 2x their declared interval.

    ``now`` is accepted for symmetry with the alert layer and is unused: the
    comparison is made by Postgres against its own clock, which is the only
    clock every one of the four runtimes shares.
    """
    return [job for job in await list_jobs() if job["overdue"]]
```

- [ ] **Step 5: Stamp a heartbeat from every loop in `main.py`**

Add the import:

```python
from services import job_registry
```

Then in each loop body, after the successful work and inside the same `try`, and in each `except`, add the heartbeat. `_reminder_loop` becomes the pattern for all of them:

```python
    async def _reminder_loop():
        while True:
            try:
                async with AsyncSessionLocal() as db:
                    count = await run_reminders(db)
                    if count:
                        log.info(f"Reminder loop: {count} reminder(s) sent")
                await job_registry.heartbeat(
                    "reminder_loop",
                    expected_interval_s=job_registry.BACKEND_JOBS["reminder_loop"],
                )
            except Exception as e:
                log.error(f"Reminder loop error: {e}")
                await job_registry.heartbeat(
                    "reminder_loop",
                    expected_interval_s=job_registry.BACKEND_JOBS["reminder_loop"],
                    ok=False, error=str(e),
                )
            await asyncio.sleep(300)
```

Apply the identical shape to `_pass_expiry_loop` (`"pass_expiry"`), `_plaza_sweep_loop` (`"plaza_sweep"`), `_plaza_alerts_loop` (`"plaza_alerts"`) and `_plaza_reconcile_loop` (`"plaza_reconcile"`).

`camera_pinger` and `health_monitor` have their loop bodies in `services/heartbeat.py`, and `db_watchdog` in `services/db_watchdog.py`. Add the same two calls inside those three `while True` bodies rather than in `main.py`:
- `services/heartbeat.py::run_camera_pinger` — `"camera_pinger"`, after `await db.commit()` and in the `except`.
- `services/heartbeat.py::run_health_monitor` — `"health_monitor"`, after the ALPR check and in the `except`.
- `services/db_watchdog.py::run_db_watchdog` — `"db_watchdog"`, after `await tick()` and in the `except`. Note the watchdog's heartbeat records that the *watchdog ran*, not that the database was healthy — those are different facts and the registry row is the first.

- [ ] **Step 6: Run to verify pass**

```bash
cd /Users/gabe/lotlogic-backend/.worktrees/uptime && pytest tests/test_job_registry.py tests/plaza/test_job_registry_db.py -q && pytest -x --tb=short -q && ruff check .
```
Expected: all pass, ruff clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/gabe/lotlogic-backend/.worktrees/uptime
git add services/job_registry.py main.py services/heartbeat.py services/db_watchdog.py \
        tests/test_job_registry.py tests/plaza/test_job_registry_db.py tests/plaza/conftest.py
git commit -m "feat(ops): every in-process loop stamps a job heartbeat

Eight loops, eight rows in ops_job_runs, written through the NullPool ops
engine so a wedged request pool cannot swallow the bookkeeping. A heartbeat
that fails is logged at DEBUG and swallowed — a loop whose bookkeeping raises
is a loop that stops doing its actual work, and db_watchdog is the alarm for a
database that is down.

BACKEND_JOBS is the single source of truth for the eight names and intervals;
a test asserts it matches the sleeps in main.py, so a ninth loop cannot be
added without something watching it."
```

---

### Task 7: The dead-man checker inside `run_health_monitor`

**Files:**
- Create: nothing
- Modify: `services/heartbeat.py` — add `check_job_deadman()` and call it from `run_health_monitor`
- Modify: `config.py` — one flag
- Test: `tests/test_job_deadman.py`

**Interfaces:**
- Consumes: `job_registry.overdue_jobs()` (Task 6), `alerts.notify_ops` / `alerts.resolve_ops` (Task 1).
- Produces: `await heartbeat.check_job_deadman(*, now: datetime | None = None) -> list[dict]` — the overdue rows, for the caller's log summary. Condition names are `job_overdue:<job_name>`, one cooldown per job.

**Why here.** `run_health_monitor` already runs every 300 s off the lifespan and already owns "notice a thing has gone quiet and email about it" for cameras. A ninth loop for the dead-man would be a ninth thing to watch. The one caveat: the checker must run even when the camera checks raise, so it gets its own `try`.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_job_deadman.py`:

```python
"""The dead-man: alert when a scheduled job goes quiet (REL-6, AUTO-2).

Twenty-three scheduled jobs and one alert between them. On 2026-08-30 a sweep
failed outright and reported "done". The contract here:

  * one condition per job, so a noisy job cannot silence a quiet one
  * an alert when a job is quiet past 2x its declared interval
  * a recovery notice when it comes back
  * the body names the job and the age — never a plate, a phone or a customer
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from services import alerts, heartbeat

NOW = datetime(2026, 9, 5, 12, 0, tzinfo=timezone.utc)


def _job(name, *, quiet_seconds, interval=300, source="backend", failures=0, error=None):
    return {
        "job_name": name, "source": source, "expected_interval_s": interval,
        "enabled": True, "last_started_at": None,
        "last_succeeded_at": "2026-09-05T11:00:00+00:00",
        "last_failed_at": None, "last_error": error,
        "consecutive_failures": failures, "created_at": "2026-09-01T00:00:00+00:00",
        "quiet_seconds": quiet_seconds, "overdue": True,
    }


@pytest.fixture(autouse=True)
def _clean():
    alerts.reset_ops_state()
    yield
    alerts.reset_ops_state()


@pytest.fixture
def captured(monkeypatch):
    calls: list[tuple[str, str, str]] = []

    async def _notify(condition, subject, body, **kwargs):
        calls.append(("raise", condition, body))
        return "sent"

    async def _resolve(condition, subject, body, **kwargs):
        calls.append(("resolve", condition, body))
        return "sent"

    monkeypatch.setattr(heartbeat.alerts, "notify_ops", _notify)
    monkeypatch.setattr(heartbeat.alerts, "resolve_ops", _resolve)
    return calls


def _overdue(rows):
    async def _fake(*, now=None):
        return rows
    return _fake


@pytest.mark.asyncio
async def test_no_overdue_jobs_alerts_nothing(monkeypatch, captured):
    monkeypatch.setattr(heartbeat.job_registry, "overdue_jobs", _overdue([]))
    assert await heartbeat.check_job_deadman(now=NOW) == []
    assert captured == []


@pytest.mark.asyncio
async def test_one_overdue_job_raises_its_own_condition(monkeypatch, captured):
    monkeypatch.setattr(heartbeat.job_registry, "overdue_jobs",
                        _overdue([_job("db-monitor", quiet_seconds=3600, interval=300,
                                       source="laptop")]))

    overdue = await heartbeat.check_job_deadman(now=NOW)

    assert [j["job_name"] for j in overdue] == ["db-monitor"]
    assert [c[:2] for c in captured] == [("raise", "job_overdue:db-monitor")]
    body = captured[0][2]
    assert "db-monitor" in body
    assert "laptop" in body
    assert "60" in body            # 3600s rendered as minutes


@pytest.mark.asyncio
async def test_each_job_gets_its_own_condition(monkeypatch, captured):
    """A noisy job must not consume the cooldown of a quiet one."""
    monkeypatch.setattr(heartbeat.job_registry, "overdue_jobs", _overdue([
        _job("db-monitor", quiet_seconds=3600),
        _job("plate_sessions_sweep", quiet_seconds=900, interval=180, source="pg_cron"),
    ]))

    await heartbeat.check_job_deadman(now=NOW)

    assert sorted(c[1] for c in captured) == [
        "job_overdue:db-monitor", "job_overdue:plate_sessions_sweep",
    ]


@pytest.mark.asyncio
async def test_a_job_that_comes_back_gets_a_recovery_notice(monkeypatch, captured):
    monkeypatch.setattr(heartbeat.job_registry, "overdue_jobs",
                        _overdue([_job("db-monitor", quiet_seconds=3600)]))
    await heartbeat.check_job_deadman(now=NOW)

    monkeypatch.setattr(heartbeat.job_registry, "overdue_jobs", _overdue([]))
    await heartbeat.check_job_deadman(now=NOW)

    assert [c[:2] for c in captured] == [
        ("raise", "job_overdue:db-monitor"),
        ("resolve", "job_overdue:db-monitor"),
    ]


@pytest.mark.asyncio
async def test_a_registry_read_failure_does_not_kill_the_check(monkeypatch, captured):
    async def _boom(*, now=None):
        raise RuntimeError("ECHECKOUTTIMEOUT")

    monkeypatch.setattr(heartbeat.job_registry, "overdue_jobs", _boom)

    assert await heartbeat.check_job_deadman(now=NOW) == []
    assert captured == []


@pytest.mark.asyncio
async def test_the_body_carries_no_pii(monkeypatch, captured):
    monkeypatch.setattr(heartbeat.job_registry, "overdue_jobs",
                        _overdue([_job("weekly-review", quiet_seconds=99999,
                                       error="plate ABC1234 not found")]))

    await heartbeat.check_job_deadman(now=NOW)

    body = captured[0][2].lower()
    for word in ("resident", "visitor", "permanent", "temporary", "guest", "driver"):
        assert word not in body, (word, body)
    # last_error is operator-written text and can contain anything. It is
    # deliberately NOT in the alert body.
    assert "abc1234" not in body


@pytest.mark.asyncio
async def test_the_deadman_is_gated_by_a_flag(monkeypatch, captured):
    from config import get_settings

    monkeypatch.setattr(get_settings(), "job_deadman_enabled", False)
    monkeypatch.setattr(heartbeat.job_registry, "overdue_jobs",
                        _overdue([_job("db-monitor", quiet_seconds=3600)]))

    assert await heartbeat.check_job_deadman(now=NOW) == []
    assert captured == []
```

- [ ] **Step 2: Run to verify failure**

```bash
pytest tests/test_job_deadman.py -q
```
Expected: `AttributeError: module 'services.heartbeat' has no attribute 'check_job_deadman'`.

- [ ] **Step 3: Add the flag to `config.py`**

After the `db_watchdog_*` fields:

```python
    # The job dead-man. Reads ops_job_runs from the health-monitor loop and
    # alerts on anything quiet past 2x its declared interval. One condition per
    # job, so a noisy job cannot silence a quiet one.
    job_deadman_enabled: bool = True
```

- [ ] **Step 4: Implement `check_job_deadman` in `services/heartbeat.py`**

Add the imports at the top of the file:

```python
from services import alerts, job_registry
```

Then add, after `check_alpr_camera_health`:

```python
def _quiet_label(seconds: int | None) -> str:
    """`3600` -> `60 minutes`. Ages, not timestamps — a timestamp in an alert
    needs a timezone argument nobody wants to have at 2am."""
    if seconds is None:
        return "unknown"
    minutes = seconds // 60
    if minutes < 120:
        return f"{minutes} minutes"
    return f"{minutes // 60} hours"


async def check_job_deadman(*, now: datetime | None = None) -> list[dict]:
    """Alert on every scheduled job that has gone quiet. Never raises.

    Twenty-three scheduled jobs across four runtimes, and until Wave 2.7 exactly
    one of them had an alert (REL-6). On 2026-08-30 a sweep failed outright and
    reported "done" (AUTO-2). This is the reader that closes both.

    A job is overdue at **2x its declared interval**, so one skipped run is
    tolerated and two are not — the same rule as the laptop watchdog's
    ``jobs.tsv`` ``max_age_hours``. Each job gets its own alert condition
    (``job_overdue:<job_name>``) so a noisy job cannot consume the hourly
    cooldown of a quiet one, and each gets its own recovery notice.

    The body names the job, its runtime and its age. It deliberately does NOT
    carry ``last_error``: that column holds whatever the job wrote, and this
    path emails it.
    """
    if not get_settings().job_deadman_enabled:
        return []

    now = now or datetime.now(timezone.utc)

    try:
        overdue = await job_registry.overdue_jobs(now=now)
    except Exception:
        # The registry lives in the same database the jobs do. If it is
        # unreachable, db_watchdog is the alarm — not a stack trace here.
        log.warning("job dead-man: could not read the registry", exc_info=True)
        return []

    overdue_names = {job["job_name"] for job in overdue}

    for job in overdue:
        await alerts.notify_ops(
            f"job_overdue:{job['job_name']}",
            f"[LotLogic] scheduled job quiet: {job['job_name']}",
            (
                f"Job '{job['job_name']}' ({job['source']}) has not recorded a "
                f"successful run in {_quiet_label(job['quiet_seconds'])}.\n"
                f"Expected every {job['expected_interval_s']}s; "
                f"overdue past {job['expected_interval_s'] * 2}s.\n"
                f"Consecutive failures: {job['consecutive_failures']}\n\n"
                f"A monitor that cannot prove it ran is a monitor that is down."
            ),
            now=now,
        )

    # An all-clear for every job that was raised and is no longer overdue. The
    # active set is the alert layer's, so a restart cannot double-report.
    for condition in alerts.active_ops_conditions():
        if not condition.startswith("job_overdue:"):
            continue
        job_name = condition.split(":", 1)[1]
        if job_name in overdue_names:
            continue
        await alerts.resolve_ops(
            condition,
            f"[LotLogic] scheduled job healthy again: {job_name}",
            f"Job '{job_name}' has recorded a successful run again.",
            now=now,
        )

    return overdue
```

- [ ] **Step 5: Call it from `run_health_monitor`**

Inside the `while True` body, in its own `try` **after** the existing camera block's `try/except`, so a camera-check failure cannot skip the dead-man:

```python
        # The dead-man for every OTHER job. Its own try: a failure in the
        # camera checks above must not skip the check that notices the camera
        # checks stopped running.
        try:
            stale = await check_job_deadman()
            if stale:
                log.warning("%d scheduled job(s) overdue: %s",
                            len(stale), [j["job_name"] for j in stale])
        except Exception as e:
            log.error(f"Job dead-man error: {e}")
```

- [ ] **Step 6: Run to verify pass**

```bash
pytest tests/test_job_deadman.py tests/test_camera_alarm.py -q && ruff check services/heartbeat.py config.py
```
Expected: `7 passed` plus the pre-existing camera-alarm tests still green, ruff clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/gabe/lotlogic-backend/.worktrees/uptime
git add services/heartbeat.py config.py tests/test_job_deadman.py
git commit -m "feat(ops): dead-man alert for every scheduled job

Reads ops_job_runs from the health-monitor loop and alerts on anything quiet
past 2x its declared interval — one condition per job, one recovery notice per
job, same 2x rule the laptop watchdog already uses in jobs.tsv.

The body names the job, its runtime and its age, and deliberately omits
last_error: that column holds whatever the job wrote and this path emails it.

Closes the reader half of REL-6 and AUTO-2."
```

---

### Task 8: `routers/ops.py` — the one page that shows every job

**Files:**
- Create: `routers/ops.py`
- Modify: `main.py` — one import, one `include_router`
- Test: `tests/test_ops_endpoints.py`

**Interfaces:**
- Consumes: `job_registry.list_jobs`, `job_registry.heartbeat` (Task 6); `db_watchdog.last_result` (Task 3); `alerts.active_ops_conditions` (Task 1); `services.auth.require_platform_admin`.
- Produces:
  - `GET /ops/jobs` → `{"jobs": [...], "overdue": [names], "db_watchdog": {...}, "active_alerts": [conditions]}`
  - `POST /ops/heartbeat/{job_name}` body `{"ok": true, "source": "laptop", "expected_interval_s": 300, "error": null}` → `{"recorded": true}`

**Auth.** Both endpoints use the existing `require_platform_admin` dependency, which already admits the shared-service `X-API-Key` subject **and** a platform-admin JWT (`services/auth.py:295`, and `require_human_platform_admin:308` exists precisely because `require_platform_admin` lets the service key through). The laptop holds `API_KEY` already. **No new key, no new middleware entry, and neither path goes in `PUBLIC_PATHS`** — a heartbeat endpoint an anonymous caller can write is a dead-man anyone can silence.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_ops_endpoints.py`:

```python
"""GET /ops/jobs and POST /ops/heartbeat/{job} — the operator's one page.

"One page shows every scheduled job and when it last succeeded" is the Wave 2
outcome this serves. The heartbeat endpoint is the transport for the laptop
jobs, which must not hold a Supabase service key.
"""
from __future__ import annotations

import contextlib

import httpx
import pytest

from services import job_registry


@contextlib.asynccontextmanager
async def _client():
    import main

    transport = httpx.ASGITransport(app=main.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
        yield c


@pytest.fixture
def api_key():
    from config import get_settings
    return get_settings().api_key


@pytest.mark.asyncio
async def test_ops_jobs_requires_a_credential():
    """A dead-man an anonymous caller can read is an inventory of your
    schedule; one they can write is a dead-man they can silence."""
    async with _client() as c:
        resp = await c.get("/ops/jobs")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_ops_heartbeat_requires_a_credential():
    async with _client() as c:
        resp = await c.post("/ops/heartbeat/db-monitor",
                            json={"ok": True, "source": "laptop",
                                  "expected_interval_s": 300})
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_ops_jobs_lists_the_registry(monkeypatch, api_key):
    async def _list():
        return [{
            "job_name": "db-monitor", "source": "laptop", "expected_interval_s": 300,
            "enabled": True, "last_started_at": None,
            "last_succeeded_at": "2026-09-05T11:00:00+00:00", "last_failed_at": None,
            "last_error": None, "consecutive_failures": 0,
            "created_at": "2026-09-01T00:00:00+00:00",
            "quiet_seconds": 120, "overdue": False,
        }, {
            "job_name": "weekly-review", "source": "laptop", "expected_interval_s": 604800,
            "enabled": True, "last_started_at": None,
            "last_succeeded_at": "2026-08-01T11:00:00+00:00", "last_failed_at": None,
            "last_error": None, "consecutive_failures": 0,
            "created_at": "2026-08-01T00:00:00+00:00",
            "quiet_seconds": 3000000, "overdue": True,
        }]

    monkeypatch.setattr(job_registry, "list_jobs", _list)

    async with _client() as c:
        resp = await c.get("/ops/jobs", headers={"X-API-Key": api_key})

    assert resp.status_code == 200
    body = resp.json()
    assert [j["job_name"] for j in body["jobs"]] == ["db-monitor", "weekly-review"]
    assert body["overdue"] == ["weekly-review"]
    assert "db_watchdog" in body
    assert body["active_alerts"] == []


@pytest.mark.asyncio
async def test_a_heartbeat_lands_in_the_registry(monkeypatch, api_key):
    recorded = []

    async def _heartbeat(job_name, *, source, expected_interval_s, ok=True, error=None):
        recorded.append((job_name, source, expected_interval_s, ok, error))
        return True

    monkeypatch.setattr(job_registry, "heartbeat", _heartbeat)

    async with _client() as c:
        resp = await c.post(
            "/ops/heartbeat/db-monitor",
            headers={"X-API-Key": api_key},
            json={"ok": False, "source": "laptop", "expected_interval_s": 300,
                  "error": "probe returned 503"},
        )

    assert resp.status_code == 200
    assert resp.json() == {"recorded": True}
    assert recorded == [("db-monitor", "laptop", 300, False, "probe returned 503")]


@pytest.mark.asyncio
async def test_a_heartbeat_that_could_not_be_written_says_so(monkeypatch, api_key):
    """Honest, not optimistic: the laptop wrapper logs this rather than
    believing it reported in."""
    async def _heartbeat(job_name, **kwargs):
        return False

    monkeypatch.setattr(job_registry, "heartbeat", _heartbeat)

    async with _client() as c:
        resp = await c.post("/ops/heartbeat/db-monitor",
                            headers={"X-API-Key": api_key},
                            json={"ok": True, "source": "laptop",
                                  "expected_interval_s": 300})

    assert resp.status_code == 503
    assert resp.json()["recorded"] is False


@pytest.mark.asyncio
async def test_an_unknown_source_is_rejected_before_it_reaches_postgres(api_key):
    async with _client() as c:
        resp = await c.post("/ops/heartbeat/db-monitor",
                            headers={"X-API-Key": api_key},
                            json={"ok": True, "source": "wherever",
                                  "expected_interval_s": 300})
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_a_job_name_is_bounded(api_key):
    """The name is a primary key written by four different runtimes."""
    async with _client() as c:
        resp = await c.post("/ops/heartbeat/" + "x" * 200,
                            headers={"X-API-Key": api_key},
                            json={"ok": True, "source": "laptop",
                                  "expected_interval_s": 300})
    assert resp.status_code == 422
```

- [ ] **Step 2: Run to verify failure**

```bash
pytest tests/test_ops_endpoints.py -q
```
Expected: 404s where 200/422/503 are asserted.

- [ ] **Step 3: Write `routers/ops.py`**

```python
"""routers/ops.py — the operator's view of the monitoring spine (Wave 2.7).

``GET /ops/jobs`` is the Wave 2 outcome in one response: every scheduled job in
the estate, its runtime, and when it last succeeded — plus the database
watchdog's last probe and every ops condition currently raised.

``POST /ops/heartbeat/{job_name}`` is the transport for jobs that run outside
this process and must not hold a Supabase key. The laptop wrapper
(``~/lotlogic-agent/lib/job.sh``) posts its verdict here with the shared
service key it already has; a PostgREST insert with the service key would hand
a shell script the credential that bypasses every tenancy check for every
customer.

Both endpoints sit behind ``require_platform_admin``, which admits the shared
``X-API-Key`` service subject as well as a platform-admin JWT. Neither path is
in ``main.PUBLIC_PATHS``: a heartbeat endpoint an anonymous caller can write is
a dead-man anyone can silence.
"""
from __future__ import annotations

import logging
from typing import Literal, Optional

from fastapi import APIRouter, Depends, Path
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from services import alerts, db_watchdog, job_registry
from services.auth import Subject, require_platform_admin

log = logging.getLogger(__name__)

router = APIRouter(prefix="/ops", tags=["ops"])


class HeartbeatIn(BaseModel):
    """One run of a job that lives outside this process."""

    ok: bool = True
    #: Constrained here as well as in the CHECK constraint, so a typo is a 422
    #: with a field name rather than a 500 out of Postgres.
    source: Literal["backend", "pg_cron", "edge", "laptop"] = "laptop"
    #: How often this job is supposed to succeed. The dead-man fires at 2x.
    expected_interval_s: int = Field(gt=0, le=30 * 24 * 3600)
    #: Truncated by the registry. Never send a plate, a phone or a name.
    error: Optional[str] = Field(default=None, max_length=2000)


@router.get("/jobs")
async def list_jobs(subject: Subject = Depends(require_platform_admin)) -> dict:
    """Every scheduled job and when it last succeeded."""
    jobs = await job_registry.list_jobs()
    return {
        "jobs": jobs,
        "overdue": [j["job_name"] for j in jobs if j["overdue"]],
        "db_watchdog": db_watchdog.last_result(),
        "active_alerts": alerts.active_ops_conditions(),
    }


@router.post("/heartbeat/{job_name}")
async def record_heartbeat(
    payload: HeartbeatIn,
    job_name: str = Path(min_length=1, max_length=100),
    subject: Subject = Depends(require_platform_admin),
):
    """Record one run of an out-of-process job.

    Answers 503 when the write did not land, so the caller logs a failure
    rather than believing it reported in — an honest heartbeat endpoint is the
    whole point of a dead-man.
    """
    recorded = await job_registry.heartbeat(
        job_name,
        source=payload.source,
        expected_interval_s=payload.expected_interval_s,
        ok=payload.ok,
        error=payload.error,
    )
    if not recorded:
        log.warning("ops heartbeat for %s could not be written", job_name)
        return JSONResponse(status_code=503, content={"recorded": False})
    return {"recorded": True}
```

- [ ] **Step 4: Mount the router in `main.py`**

```python
from routers.ops import router as ops_router
```

and, in the router block, after `app.include_router(admin_router)`:

```python
app.include_router(ops_router)
```

- [ ] **Step 5: Run to verify pass**

```bash
cd /Users/gabe/lotlogic-backend/.worktrees/uptime && pytest tests/test_ops_endpoints.py tests/test_front_door.py -q && ruff check routers/ops.py main.py
```
Expected: `7 passed` plus `test_front_door.py` still green (it asserts on the public-path allow-list; `/ops/*` must **not** appear there).

- [ ] **Step 6: Commit**

```bash
cd /Users/gabe/lotlogic-backend/.worktrees/uptime
git add routers/ops.py main.py tests/test_ops_endpoints.py
git commit -m "feat(ops): GET /ops/jobs and POST /ops/heartbeat/{job}

One response shows every scheduled job in the estate, its runtime, when it last
succeeded, the database watchdog's last probe and every raised condition.

The heartbeat endpoint is how a job outside this process reports in without
holding a Supabase service key — the laptop wrapper posts with the shared
X-API-Key it already has. Both endpoints require a credential; neither is in
PUBLIC_PATHS, because a dead-man anyone can write is a dead-man anyone can
silence. A write that does not land answers 503, so the caller logs a failure
rather than believing it reported in."
```

---

### Task 9: Advisory locks around each loop tick, and supervise the camera workers

**Files:**
- Create: `services/job_locks.py`
- Modify: `main.py` (five loop bodies), `services/heartbeat.py` (two loop bodies), `services/db_watchdog.py` (one loop body), `routers/cameras.py:383-399` (`supervised`)
- Modify: `config.py` — one flag
- Test: `tests/test_job_locks.py` (unit) and `tests/plaza/test_job_locks_db.py` (real Postgres, two connections racing)

**Interfaces:**
- Consumes: `database.ops_engine` (Task 3).
- Produces:
  - `job_locks.lock_key(job_name: str) -> int` — stable signed 64-bit key from blake2b of the name.
  - `async with job_locks.job_lock(job_name) as acquired:` — `acquired` is `True` when this process holds the lock and `False` when it does not (another replica has it, or the database is unreachable). **Never raises.**
  - `await job_locks.run_locked(job_name: str, body: Callable[[], Awaitable[None]]) -> bool` — convenience wrapper returning whether the body ran.

**Why this is safe on this deployment, and when it would not be.** `pg_try_advisory_lock` takes a **session**-level lock; it is held until explicitly unlocked or the connection closes. Supabase's supavisor pooler for this project is in **SESSION mode**, so a client connection is pinned to one server backend for its lifetime and a session-level advisory lock behaves. **If the pooler is ever switched to TRANSACTION mode, this mechanism silently breaks** — the lock would be taken on whatever backend served that statement and released to another client. Recorded as open decision **D4**, and stated as a comment in the module so nobody flips the pooler without meeting it.

**Why the ops engine, and why a semaphore.** Each held lock occupies one connection for the duration of the tick. `ops_engine` is `NullPool`, so nothing is held between ticks — but eight loops could in principle hold eight simultaneous connections on top of the request pool's `8 + 7 = 15`, against a pooler pool size of 20. A `asyncio.Semaphore(3)` caps concurrent lock holders at three; a loop that cannot get a semaphore slot inside 1 s skips its tick, exactly as if another replica held the lock. Ticks are sub-second except `plaza_sweep`.

- [ ] **Step 1: Write the failing unit tests**

Create `tests/test_job_locks.py`:

```python
"""services/job_locks.py — one writer per job across replicas (REL-12).

The backend can only ever run as one instance today: seven background loops
live inside the web process, so a second Railway replica would run every sweep
twice. These locks are what makes a second replica safe, and — just as
important — what makes a tick that cannot get the lock a *skip* rather than a
crash or a duplicate.
"""
from __future__ import annotations

import asyncio

import pytest

from services import job_locks


def test_the_lock_key_is_stable_and_fits_a_bigint():
    key = job_locks.lock_key("plaza_sweep")
    assert key == job_locks.lock_key("plaza_sweep")
    assert job_locks.lock_key("plaza_alerts") != key
    assert -(2 ** 63) <= key < 2 ** 63


@pytest.mark.asyncio
async def test_a_database_that_cannot_be_reached_skips_the_tick(monkeypatch):
    """Not a crash, not a run-anyway: a skip. The DB being down is
    db_watchdog's alarm, and running unlocked is how two replicas double-send."""
    class _Engine:
        def connect(self):
            raise RuntimeError("ECHECKOUTTIMEOUT")

    monkeypatch.setattr(job_locks.database, "ops_engine", _Engine())

    async with job_locks.job_lock("plaza_sweep") as acquired:
        assert acquired is False


@pytest.mark.asyncio
async def test_a_lock_held_elsewhere_skips_the_tick(monkeypatch):
    class _Conn:
        async def execute(self, stmt, params=None):
            class _R:
                def scalar_one(self_inner):
                    return False
            return _R()

        async def close(self):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

    class _Engine:
        def connect(self):
            return _Conn()

    monkeypatch.setattr(job_locks.database, "ops_engine", _Engine())

    ran = False
    async with job_locks.job_lock("plaza_sweep") as acquired:
        if acquired:
            ran = True
    assert acquired is False
    assert ran is False


@pytest.mark.asyncio
async def test_the_lock_is_released_even_when_the_body_raises(monkeypatch):
    """A tick that throws must not wedge every future tick of that job."""
    statements = []

    class _Conn:
        async def execute(self, stmt, params=None):
            statements.append(str(stmt))

            class _R:
                def scalar_one(self_inner):
                    return True
            return _R()

        async def close(self):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

    class _Engine:
        def connect(self):
            return _Conn()

    monkeypatch.setattr(job_locks.database, "ops_engine", _Engine())

    with pytest.raises(ValueError):
        async with job_locks.job_lock("plaza_sweep") as acquired:
            assert acquired is True
            raise ValueError("tick blew up")

    assert any("pg_advisory_unlock" in s for s in statements), statements


@pytest.mark.asyncio
async def test_locks_can_be_disabled_by_flag(monkeypatch):
    """One env var turns the whole mechanism off if it ever misbehaves in
    production, without a deploy that reverts eight call sites."""
    from config import get_settings

    monkeypatch.setattr(get_settings(), "ops_advisory_locks_enabled", False)

    class _Engine:
        def connect(self):
            raise AssertionError("must not touch the database when disabled")

    monkeypatch.setattr(job_locks.database, "ops_engine", _Engine())

    async with job_locks.job_lock("plaza_sweep") as acquired:
        assert acquired is True


@pytest.mark.asyncio
async def test_run_locked_reports_whether_the_body_ran(monkeypatch):
    from config import get_settings

    monkeypatch.setattr(get_settings(), "ops_advisory_locks_enabled", False)
    calls = []

    async def _body():
        calls.append(1)

    assert await job_locks.run_locked("plaza_sweep", _body) is True
    assert calls == [1]
```

- [ ] **Step 2: Write the failing real-Postgres test**

Create `tests/plaza/test_job_locks_db.py`:

```python
"""Two connections, one lock — the behaviour a second Railway replica has.

(In tests/plaza/ for the harness — see tests/plaza/test_ops_job_runs.py.)
"""
import pytest

from services import job_locks


@pytest.fixture(autouse=True)
def _point_ops_engine_at_the_harness(monkeypatch, engine):
    monkeypatch.setattr(job_locks.database, "ops_engine", engine)
    from config import get_settings
    monkeypatch.setattr(get_settings(), "ops_advisory_locks_enabled", True)


async def test_the_second_holder_is_refused_and_the_first_is_not(engine):
    async with job_locks.job_lock("replica_race") as first:
        assert first is True
        async with job_locks.job_lock("replica_race") as second:
            assert second is False


async def test_the_lock_is_available_again_after_the_block(engine):
    async with job_locks.job_lock("replica_race") as first:
        assert first is True
    async with job_locks.job_lock("replica_race") as again:
        assert again is True


async def test_two_different_jobs_do_not_block_each_other(engine):
    async with job_locks.job_lock("job_a") as a:
        async with job_locks.job_lock("job_b") as b:
            assert (a, b) == (True, True)
```

- [ ] **Step 3: Run to verify failure**

```bash
pytest tests/test_job_locks.py tests/plaza/test_job_locks_db.py -q
```
Expected: `ModuleNotFoundError: No module named 'services.job_locks'`.

- [ ] **Step 4: Add the flag to `config.py`**

After `job_deadman_enabled`:

```python
    # Advisory locks around each background-loop tick, so a second Railway
    # replica is safe (REL-12). One switch to turn the whole mechanism off in
    # production without a deploy that reverts eight call sites.
    #
    # REQUIRES the supavisor pooler in SESSION mode. In TRANSACTION mode a
    # session-level advisory lock is taken on whatever backend served the
    # statement and handed to the next client — the mechanism breaks silently.
    ops_advisory_locks_enabled: bool = True
    # Concurrent lock holders. Each one occupies a connection for the duration
    # of its tick, on top of the request pool's DB_POOL_SIZE + DB_MAX_OVERFLOW.
    ops_advisory_lock_max_concurrent: int = 3
```

- [ ] **Step 5: Write `services/job_locks.py`**

```python
"""services/job_locks.py — one writer per job, across replicas (REL-12, BACKEND-9).

Seven background loops live inside the FastAPI web process. That is why the
backend can only ever run as one instance: a second Railway replica would run
every sweep, every reminder and every reconciliation twice. These locks are what
make a second replica safe.

The contract is deliberately blunt: **a tick that cannot get the lock is
skipped.** Not queued, not retried, not run anyway. Every one of these loops is
periodic and idempotent — the next tick is thirty seconds to five minutes away,
and the cost of skipping one is nothing next to the cost of two replicas
double-sending a tow dispatch.

That same "skip" is the answer when the database is unreachable. Running
unlocked because we could not check is the exact failure this exists to prevent,
and a database that is down is ``services/db_watchdog.py``'s alarm, not this
module's.

**Pooler mode is load-bearing.** ``pg_try_advisory_lock`` takes a SESSION-level
lock, held until unlocked or the connection closes. This project's supavisor
pooler runs in SESSION mode, so a client connection is pinned to one server
backend and the lock behaves. **In TRANSACTION mode this breaks silently** — the
lock would be taken on whichever backend served the statement and released to
another client. Do not switch the pooler without switching this to
``pg_try_advisory_xact_lock`` inside a single transaction that also does the
work, or to a lease row.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator, Awaitable, Callable

from sqlalchemy import text

import database
from config import get_settings

log = logging.getLogger(__name__)

#: Caps concurrent lock holders, because each one occupies a connection for the
#: duration of its tick on top of the request pool. Created lazily so the
#: setting can be read after the settings cache is populated.
_semaphore: asyncio.Semaphore | None = None
#: How long a loop waits for a semaphore slot before treating the tick as
#: skipped. Short on purpose: waiting is indistinguishable from being blocked.
_SEMAPHORE_WAIT_SECONDS = 1.0


def _get_semaphore() -> asyncio.Semaphore:
    global _semaphore
    if _semaphore is None:
        _semaphore = asyncio.Semaphore(
            get_settings().ops_advisory_lock_max_concurrent
        )
    return _semaphore


def reset_state() -> None:
    """Drop the semaphore so a test can change the cap. Tests only."""
    global _semaphore
    _semaphore = None


def lock_key(job_name: str) -> int:
    """A stable signed 64-bit advisory-lock key for a job name.

    blake2b rather than ``hash()``: Python's hash is randomised per process, so
    two replicas would take two different locks and neither would ever block.
    """
    digest = hashlib.blake2b(job_name.encode("utf-8"), digest_size=8).digest()
    return int.from_bytes(digest, "big", signed=True)


@asynccontextmanager
async def job_lock(job_name: str) -> AsyncIterator[bool]:
    """Hold the advisory lock for ``job_name`` for the duration of the block.

    Yields ``True`` when this process holds it and ``False`` when it does not —
    another replica has it, no semaphore slot was free, or the database could
    not be reached. **Never raises for a locking failure**; an exception from
    the body propagates, and the lock is released either way.

    With ``OPS_ADVISORY_LOCKS_ENABLED=false`` it yields ``True`` without
    touching the database, so the mechanism can be turned off in production
    without reverting eight call sites.
    """
    if not get_settings().ops_advisory_locks_enabled:
        yield True
        return

    try:
        await asyncio.wait_for(
            _get_semaphore().acquire(), timeout=_SEMAPHORE_WAIT_SECONDS
        )
    except asyncio.TimeoutError:
        log.debug("job lock %s: no slot free, skipping tick", job_name)
        yield False
        return

    key = lock_key(job_name)
    conn = None
    acquired = False
    try:
        try:
            conn = await database.ops_engine.connect()
            acquired = bool((await conn.execute(
                text("SELECT pg_try_advisory_lock(:k)"), {"k": key}
            )).scalar_one())
        except Exception as exc:
            # Running unlocked because we could not check is exactly the
            # failure this module prevents. Skip; db_watchdog is the alarm.
            log.debug("job lock %s: could not acquire (%s), skipping tick",
                      job_name, exc)
            acquired = False

        if not acquired:
            yield False
            return

        log.debug("job lock %s: acquired", job_name)
        yield True
    finally:
        if conn is not None:
            if acquired:
                try:
                    await conn.execute(
                        text("SELECT pg_advisory_unlock(:k)"), {"k": key})
                except Exception:
                    # Closing the connection releases a session-level lock
                    # anyway; the explicit unlock is belt-and-braces.
                    log.debug("job lock %s: unlock failed", job_name, exc_info=True)
            try:
                await conn.close()
            except Exception:
                log.debug("job lock %s: close failed", job_name, exc_info=True)
        _get_semaphore().release()


async def run_locked(job_name: str, body: Callable[[], Awaitable[None]]) -> bool:
    """Run ``body()`` under the job's lock. Returns whether it ran."""
    async with job_lock(job_name) as acquired:
        if not acquired:
            return False
        await body()
        return True
```

- [ ] **Step 6: Wrap each loop tick**

In `main.py`, each loop body becomes lock → work → heartbeat. `_plaza_sweep_loop`, complete:

```python
    async def _plaza_sweep_loop():
        from services.plaza_sweep import sweep_pending_payments
        while True:
            try:
                # One writer per job across replicas (REL-12). A tick that
                # cannot get the lock is SKIPPED — the next one is two minutes
                # away, and two replicas reconciling the same Square payments
                # is worse than one skipped sweep.
                async with job_locks.job_lock("plaza_sweep") as acquired:
                    if acquired:
                        await sweep_pending_payments(database.engine)
                        await job_registry.heartbeat(
                            "plaza_sweep",
                            expected_interval_s=job_registry.BACKEND_JOBS["plaza_sweep"],
                        )
            except Exception as e:  # noqa: BLE001
                log.error(f"Plaza sweep loop error: {e}")
                await job_registry.heartbeat(
                    "plaza_sweep",
                    expected_interval_s=job_registry.BACKEND_JOBS["plaza_sweep"],
                    ok=False, error=str(e),
                )
            await asyncio.sleep(120)
```

Apply the identical shape to `_reminder_loop`, `_pass_expiry_loop`, `_plaza_alerts_loop`, `_plaza_reconcile_loop` in `main.py`, and to the `while True` bodies of `run_camera_pinger` and `run_health_monitor` in `services/heartbeat.py` and `run_db_watchdog` in `services/db_watchdog.py`.

**A skipped tick writes no heartbeat**, on purpose: the replica that *does* hold the lock writes it, and a heartbeat from a replica that did no work would tell the dead-man the job ran when it did not.

Add the import to each file:

```python
from services import job_locks
```

- [ ] **Step 7: Supervise the per-camera workers (REL-10)**

In `routers/cameras.py::run_all_camera_workers` (line ~383), the task creation currently reads roughly `task = asyncio.create_task(_http_snapshot_worker(cid))`. Wrap it:

```python
            # Supervised like the seven lifespan loops: a catastrophic escape
            # from the worker body (a rename, an import error) otherwise kills
            # the worker silently and boots nothing in its place (REL-10).
            #
            # No registry row and no dead-man for these: they poll the legacy
            # `cameras` table (the retired Reolink/zone pipeline), and fat
            # decisions 2 and 3 propose deleting the whole stack. Building
            # alerting for code queued for deletion is the fat this program
            # exists to stop.
            task = asyncio.create_task(supervised(
                f"camera_worker:{cid}",
                lambda cid=cid: _http_snapshot_worker(cid),
            ))
```

and import at the top of `routers/cameras.py`:

```python
from services.task_supervisor import supervised
```

The `lambda cid=cid:` default-argument binding is load-bearing — without it every worker in the loop closes over the last `cid`.

- [ ] **Step 8: Run to verify pass**

```bash
pytest tests/test_job_locks.py tests/plaza/test_job_locks_db.py -q && pytest -x --tb=short -q && ruff check .
```
Expected: all pass, ruff clean.

- [ ] **Step 9: Commit**

```bash
cd /Users/gabe/lotlogic-backend/.worktrees/uptime
git add services/job_locks.py main.py services/heartbeat.py services/db_watchdog.py \
        routers/cameras.py config.py tests/test_job_locks.py tests/plaza/test_job_locks_db.py
git commit -m "feat(ops): advisory lock per job so a second replica is safe

Eight background loops take pg_try_advisory_lock keyed by a blake2b digest of
the job name before each tick. A tick that cannot get the lock is SKIPPED — the
next one is 30s to 5 minutes away, and two replicas double-sending a tow
dispatch is worse than one skipped sweep. A skipped tick writes no heartbeat, so
the dead-man is never told a job ran when it did not.

Session-level locks require the supavisor pooler in SESSION mode, which is what
this project runs; the module says so, loudly, next to the SQL.

Per-camera feed workers are now supervised() like the lifespan loops (REL-10) —
without a registry row, because the legacy camera stack they poll is queued for
deletion in fat decisions 2 and 3."
```

---

### Task 10: pg_cron and edge-function heartbeats (frontend repo)

**Files (repo `/Users/gabe/lotlogic`):**
- Create: `migrations/026_ops_job_heartbeats_cron.sql`
- Modify: `supabase/functions/cron-sessions-sweep/index.ts`
- Read first (do not guess): the live `cron.job` table

**Interfaces:**
- Consumes: `public.ops_job_heartbeat(text, text, integer, boolean, text)` from Task 5, which must be applied to production **before** this task starts.
- Produces: four `ops_job_runs` rows with `source='pg_cron'` or `'edge'`, which the Task 7 dead-man reads.

**The honest signal.** pg_cron fires `net.http_post` through pg_net, which is fire-and-forget: pg_cron learns nothing about whether the edge function succeeded. So the two classes of job report differently, and the difference is deliberate:
- **A job whose body is SQL** (`clear_stale_violation_queue`, `prune_camera_snapshot_diag`, `purge_cron_job_run_details`) appends `PERFORM public.ops_job_heartbeat(...)` to its own body. The heartbeat is written by the same transaction that did the work, so it cannot lie.
- **A job whose body is an HTTP poke** (`plate_sessions_sweep`) gets its heartbeat from **inside the edge function**, at the end of a successful run. Stamping it in the cron body would record "we sent a request", which is precisely the "the sweep failed and reported done" failure AUTO-2 names.

- [ ] **Step 1: Read the live cron schedule — do not work from memory**

```sql
SELECT jobid, jobname, schedule, active, command
  FROM cron.job
 ORDER BY jobname;
```

Record the exact `command` text of every **active** job. There are four expected: `plate_sessions_sweep` (every 3 min), `clear_stale_violation_queue` (hourly), `prune_camera_snapshot_diag` (daily), `purge_cron_job_run_details` (daily, added 2026-09-05). If the live set differs, the migration below covers what is actually there — a job you cannot see is a job you cannot heartbeat.

- [ ] **Step 2: Write the migration**

Create `migrations/026_ops_job_heartbeats_cron.sql` in the **frontend** repo (that is where the pg_cron schedules live — `migrations/014_session_cron_schedule.sql` is the precedent). Registration rows first, so the dead-man knows a job exists before its first run:

```sql
-- Wave 2.7 — give every database cron job a dead-man.
--
-- Two shapes, because pg_net is fire-and-forget and pg_cron therefore learns
-- nothing about whether the edge function it poked actually worked:
--
--   * a SQL-bodied job stamps its own heartbeat in the same transaction that
--     did the work, so the heartbeat cannot lie;
--   * an HTTP-poking job (plate_sessions_sweep) is stamped from INSIDE the
--     edge function on a successful run. Stamping it here would record "a
--     request was sent", which is exactly the "the sweep failed and reported
--     done" failure this is meant to catch (AUTO-2).
--
-- Register every job first, with created_at as the grace baseline, so a job
-- that has never yet run is visible on /ops/jobs as "registered, never
-- succeeded" rather than invisible.

INSERT INTO public.ops_job_runs
    (job_name, source, expected_interval_s, enabled)
VALUES
    -- every 3 minutes; the state machine that closes passes and files overstays
    ('plate_sessions_sweep',       'edge',    180,   true),
    -- hourly
    ('clear_stale_violation_queue','pg_cron', 3600,  true),
    -- daily
    ('prune_camera_snapshot_diag', 'pg_cron', 86400, true),
    -- daily; added 2026-09-05 after cron.job_run_details reached 406k rows/156MB
    ('purge_cron_job_run_details', 'pg_cron', 86400, true)
ON CONFLICT (job_name) DO UPDATE
    SET source              = EXCLUDED.source,
        expected_interval_s = EXCLUDED.expected_interval_s,
        enabled             = EXCLUDED.enabled;
```

- [ ] **Step 3: Append the heartbeat to each SQL-bodied cron job**

For **each** SQL-bodied job, take the `command` recorded in Step 1 and reschedule it with the heartbeat appended. `cron.schedule` with an existing `jobname` replaces the job in place. Template — substitute the real body verbatim, do not paraphrase it:

```sql
SELECT cron.schedule(
  'clear_stale_violation_queue',
  '<the schedule recorded in step 1>',
  $$
  DO $job$
  BEGIN
    -- <<< the exact command body recorded in step 1, unchanged >>>
    PERFORM public.ops_job_heartbeat(
      'clear_stale_violation_queue', 'pg_cron', 3600, true, NULL);
  EXCEPTION WHEN OTHERS THEN
    -- The heartbeat records the failure and then re-raises, so the row is
    -- honest AND cron.job_run_details still shows the job as failed.
    PERFORM public.ops_job_heartbeat(
      'clear_stale_violation_queue', 'pg_cron', 3600, false, SQLERRM);
    RAISE;
  END
  $job$;
  $$
);
```

Repeat for `prune_camera_snapshot_diag` (interval `86400`) and `purge_cron_job_run_details` (interval `86400`).

Note the nested dollar-quoting: `cron.schedule`'s body is `$$…$$` and the `DO` block uses `$job$…$job$`. Getting these the same way round is the single most common way this migration fails to apply.

- [ ] **Step 4: Stamp the heartbeat from inside `cron-sessions-sweep`**

In `/Users/gabe/lotlogic/supabase/functions/cron-sessions-sweep/index.ts`, at the end of the handler, after all three transitions have run and **only** on the success path:

```ts
// Wave 2.7 dead-man. Stamped here rather than in the pg_cron body because
// pg_net is fire-and-forget: the cron job only knows a request was sent, and
// "the sweep failed and reported done" is the exact failure this catches.
// Never throws — a heartbeat that cannot be written must not turn a successful
// sweep into a 500.
async function heartbeat(ok: boolean, error: string | null) {
  try {
    await supabase.rpc("ops_job_heartbeat", {
      p_job_name: "plate_sessions_sweep",
      p_source: "edge",
      p_expected_interval_s: 180,
      p_ok: ok,
      p_error: error ? String(error).slice(0, 1000) : null,
    });
  } catch (e) {
    console.error("ops heartbeat failed:", e);
  }
}
```

and call it on both paths — `await heartbeat(true, null)` before the success response, `await heartbeat(false, String(err))` in the handler's catch before re-throwing or returning the error response. Use the existing service-role Supabase client in that file; do not create a second one.

**Before editing:** diff the repo copy against what is actually deployed —
```bash
supabase functions download cron-sessions-sweep --project-ref nzdkoouoaedbbccraoti
```
or `mcp__supabase__get_edge_function`. This repo has a standing drift hazard between `supabase/functions/*` and the deployed runtime, and this file is on the enforcement hot path.

- [ ] **Step 5: Apply and deploy**

```bash
# migration, recorded in supabase_migrations.schema_migrations
# (Supabase MCP apply_migration, name: 026_ops_job_heartbeats_cron)

# edge function
supabase functions deploy cron-sessions-sweep --project-ref nzdkoouoaedbbccraoti
```

- [ ] **Step 6: Verify against the live database**

Wait five minutes (one `plate_sessions_sweep` cycle plus slack), then:

```sql
SELECT job_name, source, expected_interval_s, last_succeeded_at,
       consecutive_failures,
       EXTRACT(EPOCH FROM (now() - last_succeeded_at))::int AS quiet_s
  FROM public.ops_job_runs
 ORDER BY job_name;
```
Expected: `plate_sessions_sweep` has a `last_succeeded_at` within the last three minutes. The three daily/hourly jobs will still show `NULL` until their next fire — that is correct, and `created_at` is their grace baseline.

Then confirm the operator view:

```bash
curl -sS -H "X-API-Key: $API_KEY" https://api.lotlogicparking.com/ops/jobs | jq '.overdue, (.jobs | map({job_name, source, quiet_seconds}))'
```

- [ ] **Step 7: Commit (frontend repo)**

```bash
cd /Users/gabe/lotlogic
git add migrations/026_ops_job_heartbeats_cron.sql supabase/functions/cron-sessions-sweep/index.ts
git commit -m "feat(ops): heartbeat every database cron job

SQL-bodied jobs stamp ops_job_heartbeat() in the same transaction that does the
work. plate_sessions_sweep is stamped from inside the edge function instead,
because pg_net is fire-and-forget and a cron-side stamp would record 'a request
was sent' — which is exactly the 'the sweep failed and reported done' failure
this is meant to catch.

All four jobs are pre-registered so a job that has never run is visible on
/ops/jobs rather than invisible."
```

---

### Task 11: Laptop jobs report in through `lib/job.sh`

**Files (repo `/Users/gabe/lotlogic-agent`):**
- Modify: `lib/job.sh` — `_job_finish`
- Modify: `jobs.tsv` — add an interval column the backend can consume
- Create: `~/.config/lotlogic-agent/env` (not in git) holding `LOTLOGIC_API_KEY` and `LOTLOGIC_API_URL`

**Interfaces:**
- Consumes: `POST /ops/heartbeat/{job_name}` (Task 8).
- Produces: four `ops_job_runs` rows with `source='laptop'` — `daily-sweep`, `weekly-review`, `db-monitor`, `watchdog`.

**Why not PostgREST.** A shell script on a laptop must not hold the Supabase service key: that credential bypasses every tenancy check for every customer, and `lib/job.sh` is sourced by five scripts, three of which shell out to an AI session. The backend endpoint takes the shared `X-API-Key` the estate already uses and is the only write path.

**The laptop watchdog stays.** `watchdog.sh` keeps reading `state/last_success.*` and emailing — it is the thing that works when the network is down or the backend is the thing that failed. What changes is that the same verdict now also reaches the central registry, so `/ops/jobs` shows all twenty-three jobs, and Wave 2.8 has a contract to move these jobs to the cloud against.

- [ ] **Step 1: Add the interval column to `jobs.tsv`**

`jobs.tsv` currently carries `name / max_age_hours / schedule / what`. Add `interval_s` as a fifth column so one manifest feeds both the laptop watchdog (which reasons in `max_age_hours`) and the central dead-man (which reasons in `expected_interval_s`), and the two can never disagree:

```
# name<TAB>max_age_hours<TAB>schedule (human)<TAB>what it is<TAB>interval_s
# interval_s = the job's nominal cadence in seconds. The central dead-man
# (POST /ops/heartbeat) fires at 2x this; max_age_hours is the same rule
# expressed for the local watchdog. Keep them consistent: interval_s * 2
# should be about max_age_hours * 3600.
daily-sweep	30	every day 08:00	last-24h pass sweep of the live database	86400
weekly-review	180	Fridays 15:00	weekly code review + one UI proposal	604800
db-monitor	2	every 5 minutes	PostgREST probe that catches the database wedging	300
watchdog	13	every 6 hours	this dead-man switch itself	21600
```

Update the `while IFS=$'\t' read -r name max_age_hours schedule what; do` line in `watchdog.sh` to `... schedule what interval_s; do` so the extra column is consumed rather than silently glued onto `$what`.

- [ ] **Step 2: Create the credentials file**

```bash
mkdir -p ~/.config/lotlogic-agent
cat > ~/.config/lotlogic-agent/env <<'ENV'
# Read by lib/job.sh. The shared backend service key (Railway env API_KEY on
# lotlogic-backend) — NOT the Supabase service key, which must never live on
# this machine.
LOTLOGIC_API_URL=https://api.lotlogicparking.com
LOTLOGIC_API_KEY=<paste the Railway API_KEY value>
ENV
chmod 600 ~/.config/lotlogic-agent/env
```

- [ ] **Step 3: Post the verdict from `_job_finish`**

In `lib/job.sh`, add near the top with the other path constants:

```bash
JOB_ENV_FILE="${JOB_ENV_FILE:-$HOME/.config/lotlogic-agent/env}"
JOBS_TSV="$AGENT_HOME/jobs.tsv"
```

and add this function above `_job_finish`:

```bash
# Report this run to the central job registry (Wave 2.7). Best-effort and
# strictly additive: the local stamps in state/ and watchdog.sh remain the
# authority, because they keep working when the network is down or when the
# backend itself is the thing that failed. This is what makes /ops/jobs show
# all twenty-three jobs instead of nineteen.
#
# Never fails the job: a monitoring call that can fail a monitored job is a
# new outage source.
_job_report_central() {
  local ok="$1" err="$2" interval
  [ "$DRY_RUN" = "1" ] && return 0
  [ -f "$JOB_ENV_FILE" ] || { job_log "no $JOB_ENV_FILE — skipping central heartbeat"; return 0; }
  # shellcheck disable=SC1090
  . "$JOB_ENV_FILE"
  [ -n "${LOTLOGIC_API_KEY:-}" ] || { job_log "no LOTLOGIC_API_KEY — skipping central heartbeat"; return 0; }

  # The cadence comes from the manifest, so the local watchdog and the central
  # dead-man read one number.
  interval=$(awk -F'\t' -v n="$JOB_NAME" '$1==n {print $5}' "$JOBS_TSV" 2>/dev/null | head -1)
  [ -n "$interval" ] || interval=86400

  local payload
  payload=$(printf '{"ok":%s,"source":"laptop","expected_interval_s":%s,"error":%s}' \
    "$ok" "$interval" \
    "$( [ -n "$err" ] && printf '%s' "$err" | sed 's/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/"/' || echo null )")

  local code
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 \
    -X POST "${LOTLOGIC_API_URL}/ops/heartbeat/${JOB_NAME}" \
    -H "X-API-Key: ${LOTLOGIC_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "$payload" 2>/dev/null) || code="000"

  if [ "$code" = "200" ]; then
    job_log "central heartbeat recorded (ok=$ok)"
  else
    # A local-only stamp is still a stamp; watchdog.sh will notice if the job
    # itself stops. Log it and move on.
    job_log "central heartbeat NOT recorded (http $code)"
  fi
  return 0
}
```

Then call it from `_job_finish`, on both verdicts — immediately after the local stamp is written and before the ledger line, so the report happens whether or not the ledger append succeeds:

```bash
  if [ "$ok" = 1 ]; then
    _job_report_central true ""
  else
    _job_report_central false "$reason"
  fi
```

- [ ] **Step 4: Verify against the live backend**

```bash
cd /Users/gabe/lotlogic-agent && ./db-monitor-run.sh
curl -sS -H "X-API-Key: $API_KEY" https://api.lotlogicparking.com/ops/jobs \
  | jq '.jobs[] | select(.source=="laptop")'
```
Expected: a `db-monitor` row with `source: "laptop"`, `expected_interval_s: 300`, and `last_succeeded_at` within the last minute.

Then prove the failure path is honest:

```bash
cd /Users/gabe/lotlogic-agent
JOB_ENV_FILE=/dev/null ./db-monitor-run.sh    # no key: must still succeed locally
```
Expected: the job completes, its local stamp is written, and the log says `no LOTLOGIC_API_KEY — skipping central heartbeat`. A missing credential must never fail a monitored job.

And prove a dry run reports nothing:

```bash
DRY_RUN=1 ./db-monitor-run.sh
```
Expected: `dry-run finished` with no stamps and no central heartbeat — a rehearsal must not fool either watchdog into thinking a job ran.

- [ ] **Step 5: Commit (agent repo)**

`~/lotlogic-agent/` is not under git today (fat decision, and Wave 2.8 item “Put `~/lotlogic-agent/` under git”). If it still is not, **stop and ask** rather than initialising a repo as a side effect of this task. If it is, commit:

```bash
cd /Users/gabe/lotlogic-agent
git add lib/job.sh jobs.tsv watchdog.sh
git commit -m "feat(ops): laptop jobs report to the central registry

Every job's verdict now also POSTs to /ops/heartbeat/{job} with the shared
backend API key — never the Supabase service key, which must not live on this
machine. jobs.tsv grows an interval_s column so the local watchdog and the
central dead-man read one number.

Strictly additive: the local stamps and watchdog.sh remain the authority,
because they keep working when the network is down or when the backend is the
thing that failed. A missing credential or an unreachable backend logs and
moves on — a monitoring call that can fail a monitored job is a new outage
source."
```

---

### Task 12 — OPTIONAL, LAST: persist notice-delivery intent (`outbound_notices`)

> **Ship tasks 1–11 first and confirm them in production.** This task is the largest in the plan and the only one that touches the path a tow partner's email travels. If the night runs short, stop after Task 11: everything above stands on its own, and REL-9 stays open with a named owner rather than half-shipped.

**What is broken today (REL-9).** Three customer-facing notices are fire-and-forget with no record that they were ever attempted:

| Sender | Send site | Failure behaviour today |
|---|---|---|
| Cooldown re-registration notice to the tow partner | `services/cooldown_notice.py:192` inside `_deliver`, run as a FastAPI `BackgroundTasks` job | `except Exception: log.warning("cooldown notice send failed …")` — the email is gone |
| Re-registration violation notice | `services/reregistration_notice.py:177` | same shape |
| Apartment approval / rejection notice | `services/apartment_notify.py:213` | same shape |

`queue_cooldown_notice` reads the database in-request and then defers the SendGrid POST to `background_tasks.add_task(_deliver, *payload)`. A SendGrid 5xx, a Railway restart between the response and the task, or a container replacement all lose the notice silently — and the cooldown notice is, since the August camera redesign, *the only enforcement signal at Charlotte*.

`services/quickbooks.py:497` and the two alerting senders (`heartbeat.py:74`, `plaza_alerts.py:187`) stay out of scope: the invoice email is operator-triggered and visible in the UI, and an alert that could not be sent is reported by the failure of the channel itself.

**Files:**
- Create: `migrations/20260905093000_outbound_notices.sql`, `services/outbound_notices.py`
- Modify: `services/cooldown_notice.py`, `services/reregistration_notice.py`, `services/apartment_notify.py` (each: `_deliver` becomes enqueue-then-attempt), `main.py` (one loop), `config.py` (two settings), `services/job_registry.py` (`BACKEND_JOBS` gains `"notice_retry"`), `tests/test_job_registry.py` (the set assertion)
- Test: `tests/plaza/test_outbound_notices.py`

**Interfaces:**
- Produces:
  - table `public.outbound_notices`
  - `await outbound_notices.enqueue(kind, dedupe_key, recipients, subject, html, from_email) -> str | None` — the row id, or `None` if `dedupe_key` already exists
  - `await outbound_notices.attempt(notice_id) -> bool`
  - `await outbound_notices.sweep(*, limit: int = 25, now=None) -> dict` — `{"attempted", "sent", "failed", "abandoned"}`

- [ ] **Step 1: The migration**

Create `migrations/20260905093000_outbound_notices.sql`:

```sql
-- Wave 2.7 / REL-9 — a failed notice is retried, not logged and forgotten.
--
-- Three notices go out fire-and-forget from a FastAPI BackgroundTask today: the
-- cooldown re-registration notice to the tow partner (since the August camera
-- redesign, the ONLY enforcement signal at Charlotte), the re-registration
-- violation notice, and the apartment approval/rejection. A SendGrid 5xx or a
-- Railway restart between the response and the task loses the email with one
-- log line.
--
-- The row is the intent. It is written BEFORE the send is attempted, so an
-- attempt that never happens is still visible and still retried.
--
-- This table holds PII by construction — the rendered body carries a plate and
-- a company name, and `recipients` is a partner's mailbox. RLS on, both browser
-- roles revoked, and nothing in an ALERT body ever quotes it.

CREATE TABLE IF NOT EXISTS public.outbound_notices (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind            text NOT NULL
                    CHECK (kind IN ('cooldown', 'reregistration', 'apartment')),
    -- Idempotency. 'cooldown:<pass_id>' etc. A retry of the same event finds
    -- the row instead of queueing a second copy.
    dedupe_key      text NOT NULL UNIQUE,
    recipients      text[] NOT NULL CHECK (cardinality(recipients) > 0),
    subject         text NOT NULL,
    html            text NOT NULL,
    from_email      text,
    status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sent', 'failed', 'abandoned')),
    attempts        integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    last_error      text,
    sent_at         timestamptz,
    provider_message_id text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.outbound_notices IS
    'Delivery intent for customer-facing notices. Written before the send is '
    'attempted so a failure is retried rather than logged and forgotten. '
    'Wave 2.7 / REL-9.';

-- The sweep's only query: due, not terminal, oldest first.
CREATE INDEX IF NOT EXISTS idx_outbound_notices_due
    ON public.outbound_notices (next_attempt_at)
    WHERE status IN ('pending', 'failed');

ALTER TABLE public.outbound_notices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.outbound_notices FROM anon, authenticated;
```

- [ ] **Step 2: `services/outbound_notices.py`**

```python
"""services/outbound_notices.py — a notice that failed to send is retried (REL-9).

The row is written BEFORE the send is attempted. That ordering is the whole
design: an attempt that never happens — a Railway restart between the HTTP
response and the BackgroundTask, a container replacement mid-flight — is still
visible in the table and still retried.

Backoff is 1, 5, 25 and 125 minutes; the fifth failure marks the row
``abandoned`` and raises an ops alert, because at that point a human has to look
at SendGrid rather than wait for a sixth try.

Bodies here carry a plate and a company name by construction. Nothing in this
module ever puts one in an alert: the ops alert names the kind and the count.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy import text

import database
from services import alerts
from services.email import send_email

log = logging.getLogger(__name__)

#: 1, 5, 25, 125 minutes. The fifth failure abandons the row.
BACKOFF_MINUTES = (1, 5, 25, 125)
MAX_ATTEMPTS = len(BACKOFF_MINUTES) + 1
#: The sweep's cadence, and the registry interval for the "notice_retry" job.
SWEEP_INTERVAL_SECONDS = 60


async def enqueue(
    kind: str, dedupe_key: str, recipients: list[str],
    subject: str, html: str, from_email: str | None,
) -> str | None:
    """Record the intent. Returns the row id, or None if it already existed."""
    async with database.ops_engine.begin() as conn:
        row = (await conn.execute(text("""
            INSERT INTO public.outbound_notices
                (kind, dedupe_key, recipients, subject, html, from_email)
            VALUES (:kind, :key, :to, :subject, :html, :from_email)
            ON CONFLICT (dedupe_key) DO NOTHING
            RETURNING id
        """), {
            "kind": kind, "key": dedupe_key, "to": recipients,
            "subject": subject, "html": html, "from_email": from_email,
        })).mappings().first()
    return str(row["id"]) if row else None


async def attempt(notice_id: str, *, now: datetime | None = None) -> bool:
    """Send one queued notice and record the outcome. Never raises."""
    now = now or datetime.now(timezone.utc)

    async with database.ops_engine.begin() as conn:
        row = (await conn.execute(text("""
            SELECT id, kind, recipients, subject, html, from_email, attempts
              FROM public.outbound_notices
             WHERE id = CAST(:id AS uuid)
               AND status IN ('pending', 'failed')
               FOR UPDATE SKIP LOCKED
        """), {"id": notice_id})).mappings().first()
    if row is None:
        return False

    try:
        message_id = await send_email(
            to=list(row["recipients"]), subject=row["subject"],
            html=row["html"], from_email=row["from_email"],
        )
    except Exception as exc:
        attempts = int(row["attempts"]) + 1
        abandoned = attempts >= MAX_ATTEMPTS
        delay = BACKOFF_MINUTES[min(attempts - 1, len(BACKOFF_MINUTES) - 1)]
        async with database.ops_engine.begin() as conn:
            await conn.execute(text("""
                UPDATE public.outbound_notices
                   SET status          = CASE WHEN :abandoned THEN 'abandoned' ELSE 'failed' END,
                       attempts        = :attempts,
                       last_error      = left(:err, 1000),
                       next_attempt_at = now() + make_interval(mins => :delay),
                       updated_at      = now()
                 WHERE id = CAST(:id AS uuid)
            """), {"id": notice_id, "attempts": attempts, "abandoned": abandoned,
                   "err": f"{type(exc).__name__}: {exc}", "delay": delay})
        log.warning("notice %s (%s) attempt %d failed", notice_id, row["kind"], attempts)
        if abandoned:
            # Kind and count only — the body has a plate in it.
            await alerts.notify_ops(
                f"notice_abandoned:{row['kind']}",
                f"[LotLogic] notice undeliverable: {row['kind']}",
                f"A '{row['kind']}' notice failed {attempts} times and has been "
                f"abandoned. Check SendGrid, then re-queue from ops.\n"
                f"Notice id: {notice_id}",
                now=now,
            )
        return False

    async with database.ops_engine.begin() as conn:
        await conn.execute(text("""
            UPDATE public.outbound_notices
               SET status = 'sent', attempts = attempts + 1, sent_at = now(),
                   provider_message_id = :mid, last_error = NULL, updated_at = now()
             WHERE id = CAST(:id AS uuid)
        """), {"id": notice_id, "mid": message_id or ""})
    return True


async def sweep(*, limit: int = 25, now: datetime | None = None) -> dict:
    """Attempt every notice whose retry is due. Returns a count summary."""
    async with database.ops_engine.connect() as conn:
        rows = (await conn.execute(text("""
            SELECT id FROM public.outbound_notices
             WHERE status IN ('pending', 'failed')
               AND next_attempt_at <= now()
             ORDER BY next_attempt_at
             LIMIT :limit
        """), {"limit": limit})).mappings().all()

    sent = 0
    for row in rows:
        if await attempt(str(row["id"]), now=now):
            sent += 1
    return {"attempted": len(rows), "sent": sent, "failed": len(rows) - sent}
```

- [ ] **Step 3: Rewire the three senders**

In each of `services/cooldown_notice.py`, `services/reregistration_notice.py`, `services/apartment_notify.py`, replace the direct `await send_email(...)` in `_deliver` with enqueue-then-attempt, keeping the "never raises" contract. For `cooldown_notice.py`, `_deliver` becomes:

```python
async def _deliver(recipients: list[str], subject: str, html_body: str,
                   from_email: Optional[str], dedupe_key: str) -> None:
    """Deferred send. The intent is recorded FIRST, so a restart between the
    response and this task loses nothing — the retry sweep picks it up.
    Own try/except: this must never surface into the request."""
    try:
        notice_id = await outbound_notices.enqueue(
            "cooldown", dedupe_key, recipients, subject, html_body, from_email)
        if notice_id is None:
            log.info("cooldown notice already queued for %s", dedupe_key)
            return
        if await outbound_notices.attempt(notice_id):
            log.info("cooldown notice sent (%s)", dedupe_key)
        else:
            log.warning("cooldown notice queued for retry (%s)", dedupe_key)
    except Exception as e:  # noqa: BLE001
        log.warning("cooldown notice enqueue failed (%s): %s", dedupe_key, e)
```

`prepare_cooldown_notice` returns `(recipients, subject, html, from_email)`; extend it to return a fifth element `f"cooldown:{pass_id}"` and update `queue_cooldown_notice`'s `background_tasks.add_task(_deliver, *payload)` accordingly. Use `f"reregistration:{pass_id}"` and `f"apartment:{request_id}:{decision}"` for the other two — the apartment key must include the decision so an approval and a later rejection are two notices, not one deduped away.

**Note the deliberate behaviour change:** the log lines above no longer say "send failed", they say "queued for retry". `tests/test_apartment_notify.py` monkeypatches `send_email` and may assert on the old shape — read it before editing and update the assertions to the new contract in the same commit.

- [ ] **Step 4: The retry loop in `main.py`**

Add `"notice_retry": 60` to `job_registry.BACKEND_JOBS` (and to the set in `tests/test_job_registry.py::test_every_lifespan_loop_has_a_registry_entry`), then a ninth lifespan loop in the same shape as Task 9's:

```python
    async def _notice_retry_loop():
        from services.outbound_notices import sweep as sweep_notices
        while True:
            try:
                async with job_locks.job_lock("notice_retry") as acquired:
                    if acquired:
                        result = await sweep_notices()
                        if result["attempted"]:
                            log.info("Notice retry: attempted=%d sent=%d failed=%d",
                                     result["attempted"], result["sent"], result["failed"])
                        await job_registry.heartbeat(
                            "notice_retry",
                            expected_interval_s=job_registry.BACKEND_JOBS["notice_retry"],
                        )
            except Exception as e:  # noqa: BLE001
                log.error(f"Notice retry loop error: {e}")
                await job_registry.heartbeat(
                    "notice_retry",
                    expected_interval_s=job_registry.BACKEND_JOBS["notice_retry"],
                    ok=False, error=str(e),
                )
            await asyncio.sleep(60)
```

with the matching `notice_retry_task = asyncio.create_task(supervised("notice_retry", _notice_retry_loop))`, the cancel, and its entry in the shutdown tuple.

- [ ] **Step 5: Tests**

Create `tests/plaza/test_outbound_notices.py` covering, against the real harness Postgres:
1. `enqueue` writes a `pending` row and returns its id.
2. A second `enqueue` with the same `dedupe_key` returns `None` and leaves one row.
3. `attempt` with a stubbed `send_email` marks the row `sent`, stamps `sent_at` and `provider_message_id`, and clears `last_error`.
4. `attempt` with a raising `send_email` marks it `failed`, sets `attempts=1`, `last_error`, and `next_attempt_at ≈ now + 1 minute`.
5. Five consecutive failures mark it `abandoned` and raise exactly one `notice_abandoned:<kind>` ops alert (assert via a monkeypatched `alerts.notify_ops`).
6. `sweep` picks up only rows whose `next_attempt_at <= now()` and skips `sent` and `abandoned` rows.
7. The abandoned-notice alert body contains no plate and none of the `BANNED_WORDS`.

Stub `send_email` by monkeypatching `outbound_notices.send_email`; point `outbound_notices.database.ops_engine` at the harness `engine` fixture as `tests/plaza/test_job_registry_db.py` does. Add `outbound_notices` to `TRUNCATE_TABLES`.

- [ ] **Step 6: Run everything**

```bash
pytest -x --tb=short -q && ruff check . && python -m compileall -q -f .
```

- [ ] **Step 7: Apply the migration and commit**

Apply `20260905093000_outbound_notices` via the Supabase MCP `apply_migration`, then:

```bash
cd /Users/gabe/lotlogic-backend/.worktrees/uptime
git add migrations/20260905093000_outbound_notices.sql services/outbound_notices.py \
        services/cooldown_notice.py services/reregistration_notice.py \
        services/apartment_notify.py main.py services/job_registry.py config.py \
        tests/plaza/test_outbound_notices.py tests/test_job_registry.py \
        tests/test_apartment_notify.py
git commit -m "feat(ops): persist notice-delivery intent and retry failed sends

The three customer-facing notices — cooldown, re-registration, apartment
decision — write an outbound_notices row BEFORE the send is attempted, so an
attempt that never happens (a Railway restart between the response and the
BackgroundTask) is still visible and still retried. Backoff 1/5/25/125 minutes;
the fifth failure abandons the row and raises one ops alert naming the kind and
the count, never the body, which carries a plate.

Closes REL-9. The cooldown notice is, since the August camera redesign, the only
enforcement signal at Charlotte — losing one to a SendGrid 5xx was losing the
enforcement."
```

---

## Post-deploy verification (after Task 11 lands on `main`)

Run these against production, in order. This is the acceptance test for the plan.

- [ ] **1. The spine is up.**
  ```bash
  curl -sS https://api.lotlogicparking.com/ready | jq
  ```
  Expected: `status: "ready"`, `db_watchdog.ok: true`, `db_watchdog.consecutive_failures: 0`, a `latency_ms` under 100.

- [ ] **2. Every job is registered and green.**
  ```bash
  curl -sS -H "X-API-Key: $API_KEY" https://api.lotlogicparking.com/ops/jobs \
    | jq '{overdue, active_alerts, jobs: (.jobs | map({job_name, source, quiet_seconds, overdue}))}'
  ```
  Expected: 13 rows minimum — 8 backend loops (9 with Task 12), 4 database/edge jobs, 4 laptop jobs — with `overdue: []`. Any row missing is a job with no dead-man; any row overdue on day one means its `expected_interval_s` is wrong.

- [ ] **3. The dead-man actually fires.** Pick the least consequential laptop job and park it:
  ```sql
  UPDATE public.ops_job_runs
     SET last_succeeded_at = now() - interval '2 days'
   WHERE job_name = 'weekly-review';
  ```
  Within 5 minutes (one `health_monitor` tick) an email must arrive with subject `[LotLogic] scheduled job quiet: weekly-review`. Then let the job's next real run clear it, or heartbeat it by hand, and confirm the `scheduled job healthy again` email. **An alert path nobody has watched fire is an alert path that does not work** — this is the step that proves REL-6 is closed.

- [ ] **4. The watchdog actually fires.** Do **not** wedge production to test this. Instead, on a local run with `DATABASE_URL` pointed at a stopped cluster, confirm three ticks produce one `[LotLogic] database unreachable` email and a fourth successful tick produces the all-clear.

- [ ] **5. The advisory locks hold.** Temporarily scale the Railway service to 2 replicas for ten minutes and confirm from the logs that each tick of `plaza_sweep` runs on exactly one instance (`job lock plaza_sweep: acquired` on one, `skipping tick` on the other), then scale back to 1. **Do this only after step 2 is green**, and never during a plaza payment window.

- [ ] **6. Nothing regressed on the money path.** `tests/plaza/` green in CI, and one live `GET /plaza/payments/{id}/status` still answering.

---

## Open decisions — these need a one-line answer from Gabe

| # | Decision | Why it matters | Default if unanswered |
|---|---|---|---|
| **D1** | Merge `ops/uptime-probe` to `main`, and add external probes for `visit.html` (the QR page a driver scans) and `/app`? | 2.7's first layer is "an external uptime check per public surface". Today only `/ready` and PostgREST have one, and it is on an unmerged branch. The QR page going down is invisible to every check that exists. | Merge the branch as-is; the two extra probes stay open. |
| **D2** | Where should ops alerts go — `standardvendingcompany@gmail.com`, `gabriel@lotlogicparking.com`, or both? Set `OPS_ALERT_EMAIL_TO` on Railway. | Unset, it falls back to `CAMERA_ALERT_EMAIL_TO`; if that is also unset, every alert in this plan is a log line nobody reads. **This is the single setting that decides whether any of this reaches a human.** | Fall back to `CAMERA_ALERT_EMAIL_TO`. |
| **D3** | Should `plaza_alerts` SMS also be gated on `SMS_ENABLED`? | The new ops channel is gated; the plaza channel is not, because gating it changes ~30 passing tests. Twilio is dead so nothing sends today either way — this is about which behaviour is correct when it is restored. | Leave plaza ungated; revisit when Twilio is restored. |
| **D4** | Confirm the supavisor pooler stays in **SESSION** mode. | Task 9's advisory locks are session-level. In transaction mode they break **silently** — two replicas would both believe they hold the lock. | Assume SESSION; the module comments say so. |
| **D5** | Lift `tests/plaza/conftest.py`'s Postgres harness to a shared `tests/conftest_pg.py`? | Four new DB-backed test files now live in `tests/plaza/` only because that is where the harness is. It reads as though ops monitoring is part of the plaza. | Defer to Wave 2.4 (rebuildable schema baseline), which touches the harness anyway. |
| **D6** | Is iMessage-from-laptop worth wiring as a third channel? | It is the only channel that reaches a phone with Twilio dead, but it needs the laptop awake — which is the failure mode 2.8 exists to remove. Adding it would mean `alerts.Channels` grows a third sender. | No. Email plus the GitHub failure email, until 2.8 moves the jobs to the cloud. |
| **D7** | Ship Task 12 (`outbound_notices`) tonight, or take it as a follow-up day? | It is the only task that touches the path the tow partner's email travels, and the cooldown notice is currently the only enforcement signal at Charlotte. | Follow-up day. Tasks 1–11 stand alone. |

---

## Self-review

**Spec coverage.** Every finding merged into 2.7 has a task or an explicit exclusion: REL-6 → Tasks 5–8 + 10 + 11; REL-2 → already closed in Wave 1, and the camera alarm now shares the dispatcher via Task 1; REL-9 → Task 12 (optional, with the "leave it open with an owner" fallback stated); REL-10 → Task 9 Step 7, minimally and with a reason; REL-12 → Task 9; REL-14 → Task 1's `_ops_sms_to` gate, with the asymmetry recorded as D3; BACKEND-9 → Tasks 6 + 9; BACKEND-19 → deferred with a reason (scope call 5); PIPE-8, PIPE-10 → excluded with reasons (scope calls 1 and 2); AUTO-2 → Tasks 5–7 + 11. S1's three layers: external (D1, largely landed), dead-man (Tasks 5–11), errors (already done — scope call 7). "One page shows every scheduled job and when it last succeeded" → Task 8. "Before 2.8" → Task 11 hands 2.8 a heartbeat contract and a manifest column to schedule from.

**Type consistency.** `heartbeat(job_name, *, source, expected_interval_s, ok, error)` has the same signature at every call site (Tasks 6, 8, 11, 12) and in the router's `HeartbeatIn`. `job_lock(job_name) -> AsyncIterator[bool]` is used identically in all nine loop bodies. `alerts.dispatch(...)` returns `"sent" | "suppressed" | "failed"` in Tasks 1, 2, 3 and 7. `list_jobs()` rows carry `quiet_seconds` and `overdue`, produced in Task 6 and consumed in Tasks 7 and 8. The four `source` values are constrained identically in the SQL CHECK (Task 5) and the Pydantic `Literal` (Task 8).

**Known sharp edges, flagged rather than smoothed:**
- Task 2 is the only task that can silently regress money alerting. Its acceptance criterion is "`tests/plaza/test_plaza_alerts.py` unchanged and green" — if the file needs editing, the binding is wrong.
- Task 9's `lambda cid=cid:` in `run_all_camera_workers` is a closure bug waiting to happen without the default argument.
- Task 10's nested dollar-quoting (`$$` for `cron.schedule`, `$job$` for the `DO` block) is the most likely place that migration fails to apply.
- Task 12 changes log-line wording that `tests/test_apartment_notify.py` may assert on; read it before editing.
