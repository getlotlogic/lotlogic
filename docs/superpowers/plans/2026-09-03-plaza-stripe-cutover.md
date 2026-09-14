# Plaza Square → Stripe Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Charlotte Travel Plaza pay-to-park checkout from LotLogic's Square account to Frank's **Stripe** account — with the live Square rows still settling, refunding and reconciling untouched — and bill Frank 25% of net sales on a biweekly statement. The switch is one env var (`PLAZA_PROCESSOR`), and it is reversible at every step.

**Architecture:** A thin async **processor dispatcher** (`services/processor.py`) sits between the plaza code and the two payment SDKs. Every `plaza_payments` row carries a `processor` column stamped at quote time; every servicing call (`fetch`, `list`, `refund`, `expire`, ownership check) dispatches on **that row's** processor, forever. New quotes use `processor.current()`. Square keeps working the entire time; Stripe becomes current only when the flag flips in the runbook.

**Tech Stack:** FastAPI + SQLAlchemy `text()` (Railway), Supabase Postgres, `stripe==15.6.1` (async, `StripeClient` + `client.v1.*`), `squareup` SDK (sync, wrapped in `asyncio.to_thread`), vanilla JS `visit.html`, React-in-Babel `dashboard.html` (Vercel), SendGrid, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-03-plaza-stripe-cutover-design.md` — **v2, binding.** §13's rulings S1–S34 are requirements, not advice. Read it before Task 0.

**Parent spec (still in force):** `docs/superpowers/specs/2026-09-01-truck-plaza-pay-to-park-design.md` — everything except the processor sections (§4, §7, §13.8) still binds: prices, pass lifecycle, no refunds, admin-only refund, exactly-once settle, money alerts, watcher.

**Code inventory of the Square implementation** (file:line for every touchpoint): the implementer of any task should read the sections of `services/square.py`, `routers/plaza_payments.py`, `services/plaza_settle.py`, `services/plaza_sweep.py`, `services/plaza_reconcile.py` its task names before writing a line.

**Worktrees:**
- Backend: `/Users/gabe/lotlogic-backend-pay2park` (branch `feat/pay-to-park`, which equals `main`). Python: `.venv/bin/python`, pytest: `.venv/bin/pytest`.
- Frontend: `/Users/gabe/lotlogic-pay2park` (`frontend/visit.html`, `frontend/dashboard.html`, `tests/e2e/pay2park-*.spec.ts`).
- Watcher: `/Users/gabe/lotlogic-agent/pay2park/payment-watch.sh`.

**Test baseline:** `cd /Users/gabe/lotlogic-backend-pay2park && .venv/bin/pytest tests/ -q` → **553 passed, 26 skipped**. Every task states the expected new total. The plaza suite runs against a **real local Postgres** (`tests/plaza/conftest.py` boots a cluster, applies `tests/plaza/schema/live_schema.sql` then replays `migrations/<glob>` in sorted order).

**Frontend test command:** `cd /Users/gabe/lotlogic-pay2park/tests && npx playwright test e2e/pay2park-visit.spec.ts e2e/pay2park-dashboard.spec.ts --project=chromium-desktop`.

---

## Global Constraints

Carried forward from the parent plan (`2026-09-01-truck-plaza-pay-to-park.md`), corrected where the live system has moved on:

- **Property:** Charlotte Travel Plaza `bd44ace8-feda-42e1-9866-5d60f65e1712`, `property_type='truck_plaza'`.
- **Pricing:** flat `PRICE_CENTS = {10: 1500, 24: 2500, 48: 4000}` cents, USD (three tiers as of migration `20260902000120` — the parent plan's `{24:1500, 48:3000}` is historical). **No tax. No weekday/weekend split** — never copy `app_api._price`/`LOT_TZ` logic into this path. A quote's amount lives **on its row**; never re-price at settle time.
- **The invariant:** a `visitor_passes` row exists **iff** a payment is CONFIRMED for it. Every task preserves this, for both processors.
- **Never-throw-after-charge:** any pass-INSERT failure inside the settle path is caught → `payment_status='paid'`, `pass_id NULL`, `needs_manual_review` reason, ops alert, **HTTP 200 to the processor**. Never 500 (retry storm), never silent.
- **Exactly-once:** pass INSERT carries `submission_idempotency_key = 'plaza-' || plaza_payments.id`; 23505 IntegrityError is absorbed → return existing pass. `pass_id IS NULL` is **not** a concurrency guard.
- **Fail closed:** production + missing/unusable processor credentials → `quote-and-start` 503 `payments_unavailable`. Never a free pass.
- **DO NOT MODIFY** `enforce_truck_plaza_cooldown`, `enforce_truck_plaza_stay_limit`, `set_pass_cooldown_flag`, `enforce_plate_hold`, or any apartment path. They are already correct.
- **Feature flags gate only the entrance** (`pay_to_park_enabled` + `PLAZA_PROCESSOR`), **never** the webhook, sweep, reconcile, refund or statement paths.
- **SQL:** always parameterized `text()` binds. **Migrations:** written as files and exercised by the harness replay; applied to production by a human (see "nothing deployed" below).

Added for this change:

- **No column renames (S13).** `square_order_id`, `square_payment_id`, `square_receipt_url`, `square_checkout_url`, `square_refund_id`, `square_cents`, `square_count`, `unmatched_square_payment_ids` all keep their names and get `COMMENT ON COLUMN`. A rename is a later expand/contract change, never inside a money cutover.
- **Async adapters (S19).** Every adapter method is `async def`. Square's sync SDK is wrapped in `asyncio.to_thread` **inside `services/square_adapter.py`**, never at a call site. After Task 1 no plaza module may `await asyncio.to_thread(sq.<fn>, …)` directly.
- **Never `stripe.api_key = …`** and never module-level `stripe.checkout.Session.*` / `stripe.Webhook.construct_event` — those resolve the NMLD app's global key and would charge/verify against the wrong account (S23). Use a per-call `StripeClient` instance.
- **`client.v1.*` only.** `client.v1.checkout.sessions.*_async`, `client.v1.refunds.create_async`, `client.v1.webhook_endpoints.create_async`, `client.construct_event`.
- **Params dict + options dict call form:** `await client.v1.checkout.sessions.create_async(params, {"idempotency_key": key})`. Never keyword-argument style.
- **Ownership gate before any alert (S15).** No orphan-capture, dispute or refund alert may fire for an object whose `metadata.source != "lotlogic-plaza"`. Frank's other Stripe sales must never page `billing@`.
- **`processor` stamped on every `plaza_payments` INSERT** (from Task 2 on). No INSERT relies on the column DEFAULT except as a stale-writer backstop (S14).
- **Nothing is deployed or applied by implementers.** No `mcp__supabase__apply_migration`, no Railway env changes, no `railway up`, no `git push`, no `vercel` deploy, no live Stripe API calls with a real key. Migrations are files replayed by the test harness. Tasks 15–16 produce documents and skipped harnesses, not actions.
- **`PLAZA_PROCESSOR` stays unset (= `square`) for every task.** The branch must be deployable and behaviour-identical at the end of every task with the flag unset. Only Task 16's runbook flips it, and a human runs that.
- **One commit per task**, on `feat/pay-to-park` in the worktree named by the task. Never `--force`, never rebase.

---

### Task 0: Pin `stripe`, add plaza Stripe settings, and build the processor dispatcher

Implements spec §2 (config), §4 (dispatcher shape). Nothing calls the dispatcher yet — this task only creates it and proves it works.

**Files:**
- Modify: `lotlogic-backend-pay2park/requirements.txt`
- Modify: `lotlogic-backend-pay2park/config.py`
- Create: `lotlogic-backend-pay2park/services/processor.py`
- Create: `lotlogic-backend-pay2park/services/square_adapter.py`
- Test: `lotlogic-backend-pay2park/tests/plaza/test_processor.py`

**Interfaces:**
- Produces: `processor.for_row(processor: str) -> module`, `processor.current() -> str`, `processor.any_enabled() -> bool`, `processor.PROCESSORS = ("square", "stripe")`
- Produces: `services.square_adapter` exposing the async adapter surface over `services.square`.

**Existing tests that must gain a Stripe twin:** none yet. This task adds the first `tests/plaza/test_processor.py`.

- [ ] **Step 1: Pin the SDK (S20)**

`requirements.txt` line 24 currently reads `stripe>=9.0`. Replace with exactly:
```
stripe==15.6.1
```
The webhook endpoint is created with the library's own `_ApiVersion.CURRENT` (`2026-08-26.dahlia` in 15.6.1). A floating range would silently move the API version the endpoint was registered under. Verify the pin matches what is installed:
```bash
cd /Users/gabe/lotlogic-backend-pay2park && .venv/bin/python -c "import stripe; from stripe._api_version import _ApiVersion; print(stripe.VERSION, _ApiVersion.CURRENT)"
```
Expected: `15.6.1 2026-08-26.dahlia`.

- [ ] **Step 2: Add the three plaza settings (spec §2)**

In `config.py`, immediately **after** the existing `# ── Stripe (NMLD app payments) ──` block (lines 27–32), add a separate block. The names are deliberately distinct from `stripe_secret_key` / `stripe_webhook_secret`, which belong to `routers/app_api.py` and must not be touched:
```python
    # ── Stripe (plaza pay-to-park — FRANK'S account, not LotLogic's) ──────────
    # Distinct from the NMLD app's stripe_* fields above: different account,
    # different merchant of record. Never cross-wire them.
    stripe_plaza_secret_key: str = ""
    stripe_plaza_webhook_secret: str = ""
    #: Which processor NEW quotes use. Unset = 'square' (the pre-cutover
    #: default). Flipping this is the entire cutover; existing rows are
    #: serviced by their own stamped `processor` forever.
    plaza_processor: str = "square"
```

- [ ] **Step 3: Write the failing tests**

```python
# tests/plaza/test_processor.py
"""The processor dispatcher — spec §4."""
import pytest

from services import processor


def test_for_row_square_returns_the_square_adapter():
    from services import square_adapter
    assert processor.for_row("square") is square_adapter


def test_for_row_stripe_returns_the_stripe_client():
    from services import stripe_plaza
    assert processor.for_row("stripe") is stripe_plaza


def test_for_row_rejects_an_unknown_processor():
    """A row carrying garbage must not silently fall back to a live SDK."""
    with pytest.raises(ValueError):
        processor.for_row("paypal")


def test_for_row_rejects_none_and_empty():
    for bad in (None, ""):
        with pytest.raises(ValueError):
            processor.for_row(bad)


def test_current_defaults_to_square(monkeypatch):
    monkeypatch.delenv("PLAZA_PROCESSOR", raising=False)
    from config import get_settings
    get_settings.cache_clear()
    assert processor.current() == "square"


def test_current_rejects_an_invalid_setting(monkeypatch):
    """A typo in the Railway var must fail loudly, never quote on a guess."""
    monkeypatch.setenv("PLAZA_PROCESSOR", "stipe")
    from config import get_settings
    get_settings.cache_clear()
    with pytest.raises(ValueError):
        processor.current()
    get_settings.cache_clear()


def test_any_enabled_is_true_when_square_is_configured(monkeypatch):
    monkeypatch.setenv("SQUARE_ACCESS_TOKEN", "tok")
    monkeypatch.setenv("SQUARE_LOCATION_ID", "LOC")
    assert processor.any_enabled() is True


def test_adapters_expose_the_whole_surface():
    """Both adapters must answer the same calls, or a row type is unserviceable."""
    from services import square_adapter, stripe_plaza
    required = (
        "create_checkout", "fetch_payment", "fetch_by_payment_id",
        "list_payments_between", "refund_payment", "expire_checkout",
        "enabled", "ownership_mismatch",
    )
    for mod in (square_adapter, stripe_plaza):
        for name in required:
            assert hasattr(mod, name), f"{mod.__name__} missing {name}"
```

Note: two of these import `services.stripe_plaza`, which Task 3 creates. **Create a minimal placeholder in this task** — see Step 5.

- [ ] **Step 4: Run to verify they fail**

Run: `cd /Users/gabe/lotlogic-backend-pay2park && .venv/bin/pytest tests/plaza/test_processor.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'services.processor'`

- [ ] **Step 5: Implement `services/square_adapter.py`**

An async facade over the untouched `services/square.py`. **`services/square.py` is not modified in this task or any other** — it stays the sync SDK wrapper it is today. Every `to_thread` in the plaza codebase moves in here (S19).

```python
"""Async adapter over the sync Square SDK (spec §4).

`services/square.py` stays exactly as it is — a sync client. This module is
the only place allowed to run it on a worker thread, so every plaza call site
can be a plain `await adapter.<fn>(...)` regardless of processor.
"""
import asyncio
import os
from typing import Any

from services import square as sq

PROCESSOR = "square"


def enabled() -> bool:
    return sq.square_enabled()


async def create_checkout(*, idempotency_key, amount_cents, reference_id,
                          success_url, cancel_url, label, property_name,
                          property_id, plate) -> dict[str, Any]:
    # Square has no cancel URL, no label and no metadata on a quick_pay link:
    # the extra kwargs exist so the two adapters share one signature. They are
    # accepted and dropped here rather than branching at the call site.
    return await asyncio.to_thread(
        sq.create_checkout,
        idempotency_key=idempotency_key,
        amount_cents=amount_cents,
        reference_id=reference_id,
        redirect_url=success_url,
    )


async def fetch_payment(order_id: str) -> dict[str, Any] | None:
    """Square's stored id IS the payment id for our purposes at this seam.

    Callers that hold a Square PAYMENT id use `fetch_by_payment_id`; this one
    exists so the Stripe adapter (whose stored id is a SESSION id) has a twin.
    Square cannot look a payment up by order id in one call, so this returns
    None and the Square sweep keeps using `list_payments_between` (unchanged).
    """
    return None


async def fetch_by_payment_id(payment_id: str) -> dict[str, Any] | None:
    p = await asyncio.to_thread(sq.fetch_payment, payment_id)
    if p is None:
        return None
    return _tag(p)


async def list_payments_between(begin_iso: str, end_iso: str) -> list[dict[str, Any]]:
    rows = await asyncio.to_thread(sq.list_payments_between, begin_iso, end_iso)
    return [_tag(p) for p in rows]


async def list_recent_payments(begin_iso: str) -> list[dict[str, Any]]:
    """Square-only: the one-call-per-sweep list the Square sweep is built on."""
    rows = await asyncio.to_thread(sq.list_recent_payments, begin_iso)
    return [_tag(p) for p in rows]


async def refund_payment(*, payment_id: str, amount_cents: int,
                         idempotency_key: str) -> dict[str, Any]:
    r = await asyncio.to_thread(
        sq.refund_payment, payment_id=payment_id,
        amount_cents=amount_cents, idempotency_key=idempotency_key,
    )
    return {"id": r.get("id"), "status": (r.get("status") or "").upper()}


async def expire_checkout(order_id: str) -> None:
    """Square payment links have no expire API — the 24h TTL does the work."""
    return None


def ownership_mismatch(payment: dict, row) -> str | None:
    """S18 — the reason string, not a bool.

    Byte-for-byte the check `services/plaza_settle.py` did inline before the
    dispatcher: the capture must be at our configured location.
    """
    loc = os.getenv("SQUARE_LOCATION_ID")
    if loc and payment.get("location_id") != loc:
        return "location_mismatch"
    return None


def _tag(p: dict[str, Any]) -> dict[str, Any]:
    """Add the two fields the normalized shape gained for Stripe (spec §4)."""
    p = dict(p)
    p.setdefault("processor", PROCESSOR)
    p.setdefault("livemode", sq.is_production())
    return p
```

- [ ] **Step 6: Implement `services/processor.py`**

```python
"""Processor dispatcher (spec §4). Dispatch only — no I/O, no SDK imports at
module scope, so importing this never touches a network client.

`for_row` is the whole safety story: a row quoted on Square is serviced by
Square forever, whatever `PLAZA_PROCESSOR` says today.
"""
from config import get_settings

PROCESSORS = ("square", "stripe")


def for_row(processor: str):
    if processor == "square":
        from services import square_adapter
        return square_adapter
    if processor == "stripe":
        from services import stripe_plaza
        return stripe_plaza
    raise ValueError(f"unknown processor: {processor!r}")


def current() -> str:
    """Which processor NEW quotes use. Validated — never guessed."""
    value = (get_settings().plaza_processor or "square").strip().lower()
    if value not in PROCESSORS:
        raise ValueError(f"PLAZA_PROCESSOR must be one of {PROCESSORS}, got {value!r}")
    return value


def any_enabled() -> bool:
    """Gates the reconcile/sweep loops (S16). True if EITHER processor is
    configured — the cutover day has rows on both."""
    for name in PROCESSORS:
        try:
            if for_row(name).enabled():
                return True
        except Exception:
            continue
    return False
```

- [ ] **Step 7: Create the `services/stripe_plaza.py` placeholder**

Task 3 fills this in. For now it must import cleanly and expose the surface so `test_adapters_expose_the_whole_surface` passes and `for_row("stripe")` works:

```python
"""Stripe client for plaza pay-to-park (spec §5). FILLED IN BY TASK 3.

Every function here raises until Task 3 lands. That is deliberate: the
dispatcher must resolve, but no code path may reach a half-built client.
"""
from typing import Any

PROCESSOR = "stripe"


def enabled() -> bool:
    return False


def _not_yet(*_a, **_k):
    raise NotImplementedError("services.stripe_plaza — Task 3")


async def create_checkout(**_kwargs) -> dict[str, Any]:
    _not_yet()


async def fetch_payment(order_id: str) -> dict[str, Any] | None:
    _not_yet()


async def fetch_by_payment_id(payment_id: str) -> dict[str, Any] | None:
    _not_yet()


async def list_payments_between(begin_iso: str, end_iso: str) -> list[dict[str, Any]]:
    _not_yet()


async def refund_payment(**_kwargs) -> dict[str, Any]:
    _not_yet()


async def expire_checkout(order_id: str) -> None:
    _not_yet()


def ownership_mismatch(payment: dict, row) -> str | None:
    _not_yet()
```

- [ ] **Step 8: Run the new tests, then the whole suite**

```bash
cd /Users/gabe/lotlogic-backend-pay2park
.venv/bin/pytest tests/plaza/test_processor.py -q     # expect 8 passed
.venv/bin/pytest tests/ -q
```

**Done when:**
- `tests/plaza/test_processor.py` — 8 passed.
- Full suite: **561 passed, 26 skipped** (553 + 8).
- `grep -rn "asyncio.to_thread" services/ routers/` still shows the pre-existing plaza call sites (Task 1 moves them) and the new ones inside `square_adapter.py` only.
- `requirements.txt` reads `stripe==15.6.1`.
- No behaviour change: nothing imports `services.processor` outside the test yet.

- [ ] **Step 9: Commit**

```bash
cd /Users/gabe/lotlogic-backend-pay2park && \
git add requirements.txt config.py services/processor.py services/square_adapter.py services/stripe_plaza.py tests/plaza/test_processor.py && \
git commit -m "feat(plaza-stripe): pin stripe 15.6.1, plaza Stripe settings, async processor dispatcher"
```

---

### Task 1: Route every Square call site through the dispatcher — behaviour identical

Implements spec §4 ("Every `sq.<fn>(row…)` call site becomes `processor.for_row(row['processor']).<fn>(…)`"). The `processor` column does not exist yet, so **every call site passes the literal `"square"`**. Task 2 swaps the literal for the column. This split is what keeps the branch deployable: this task cannot change behaviour, and the next one is a pure additive migration.

**Files:**
- Modify: `lotlogic-backend-pay2park/routers/plaza_payments.py`
- Modify: `lotlogic-backend-pay2park/services/plaza_settle.py`
- Modify: `lotlogic-backend-pay2park/services/plaza_sweep.py`
- Modify: `lotlogic-backend-pay2park/services/plaza_reconcile.py`

**Interfaces:**
- Consumes: `services.processor.for_row`, `services.square_adapter`
- Changes: `settle_payment(...)` keeps its parameter name `square_payment` (no renames — S13) but gains `processor: str = "square"` so it can pick the adapter for the ownership check.

**Existing tests that must gain a Stripe twin:** none yet — but **every** existing Square test must keep passing untouched wherever possible. Where a monkeypatch target moves (see Step 6), update the test's target and nothing else.

- [ ] **Step 1: Read the call sites before editing**

The complete list (inventory §2), all in `/Users/gabe/lotlogic-backend-pay2park`:
- `routers/plaza_payments.py:293-299` — `sq.create_checkout` in `_start_checkout`
- `routers/plaza_payments.py:784` — `sq.fetch_payment` in the webhook, via `asyncio.to_thread`
- `routers/plaza_payments.py:1057-1062` — `sq.refund_payment`, via `asyncio.to_thread`
- `services/plaza_settle.py:300,307` — `os.getenv("SQUARE_LOCATION_ID")` + the location `elif` leg
- `services/plaza_sweep.py:227` — `sq.list_recent_payments`, via `asyncio.to_thread`
- `services/plaza_reconcile.py:342-344` — `sq.list_payments_between`, via `asyncio.to_thread`
- `services/plaza_reconcile.py:367` — `sq.square_enabled()` gate

Leave alone: `sq.price_for`, `sq.is_production`, `sq.square_enabled` inside `quote-and-start`'s fail-closed gate, `sq.verify_webhook_signature`, `sq.note_payment_id`, `sq.PRICE_CENTS`. Those are Square-specific and stay so until Tasks 5/10.

- [ ] **Step 2: `_start_checkout` — dispatch on `processor.current()`**

Replace the `asyncio.to_thread(sq.create_checkout, …)` block (plaza_payments.py:291-299) with the full nine-argument adapter call. `success_url` is today's `redirect_url` verbatim; `cancel_url` is the same URL with `&checkout=cancel` (S2 — Task 5 of the frontend consumes it, and adding it now costs Square nothing because the Square adapter drops it):

```python
adapter = processor.for_row(processor.current())
checkout = await adapter.create_checkout(
    idempotency_key=idempotency_key,
    amount_cents=amount_cents,
    reference_id=str(payment_id),
    success_url=redirect_url,
    cancel_url=f"{redirect_url}&checkout=cancel",
    label=_TIER_LABEL[stay_hours],
    property_name=property_name,
    property_id=str(property_id),
    plate=plate,
)
```
Add the label map next to `DURATION_HOURS`:
```python
#: Human tier label, used in the processor's line-item name.
_TIER_LABEL: dict[int, str] = {10: "10 hours", 24: "24 hours", 48: "48 hours"}
```
`property_name` and `plate` must be added to `_LOCK_QUOTE_SQL`'s SELECT (or read from the row already loaded) — do **not** add a second query. The lock SQL becomes:
```sql
    SELECT pp.id, pp.payment_status, pp.square_order_id, pp.square_checkout_url,
           pp.plate_text, p.name AS property_name
      FROM public.plaza_payments pp
      JOIN public.properties p ON p.id = pp.property_id
     WHERE pp.id = :id
     FOR UPDATE OF pp
```
`FOR UPDATE OF pp` — locking the joined `properties` row too would serialize every quote at the plaza behind one row.

- [ ] **Step 3: The webhook's re-fetch — dispatch by literal `"square"`**

`routers/plaza_payments.py:784`:
```python
payment = await processor.for_row("square").fetch_by_payment_id(payment_id)
```
(The literal is correct here and stays correct after Task 2: `/plaza/webhook` is Square's endpoint and only ever carries Square payment ids.)

- [ ] **Step 4: The refund endpoint — dispatch by the row's processor**

`routers/plaza_payments.py:1056-1068`:
```python
refund = await processor.for_row(row_processor).refund_payment(
    payment_id=row["square_payment_id"],
    amount_cents=amount_cents,
    idempotency_key=idempotency_key,
)
```
where `row_processor = "square"` for now — add it as a local, so Task 2's change is one line. Add `processor` to `_REFUNDABLE_SQL`'s SELECT in Task 2, not here.

- [ ] **Step 5: Settle — the ownership check moves behind the adapter (S18)**

In `services/plaza_settle.py`, `settle_payment`/`_settle_locked` gain a keyword-only `processor: str = "square"`. Replace the location leg of the mismatch chain (plaza_settle.py:300, 306-307):
```python
        loc = os.getenv("SQUARE_LOCATION_ID")
        ...
        elif loc and square_payment.get("location_id") != loc:
            mismatch = "location_mismatch"
```
with:
```python
        adapter = proc.for_row(processor)
        ...
        elif (owner_reason := adapter.ownership_mismatch(square_payment, row)) is not None:
            mismatch = owner_reason
```
Keep the leg in the **same position in the same `elif` chain** — amount, then currency, then order, then ownership. Moving it changes which reason a doubly-wrong capture gets. Drop the now-unused `import os` only if nothing else in the module uses it (check first).

The reason→outcome mapping at the bottom of the chain stays exactly as it is this task:
```python
outcome = "manual_review" if mismatch == "order_mismatch" else "rejected_amount_mismatch"
```
Task 4 extends it. `location_mismatch` must keep mapping to `rejected_amount_mismatch` — changing Square's outcome vocabulary here would break the watcher's pattern list.

- [ ] **Step 6: Sweep and reconcile**

`services/plaza_sweep.py:227`:
```python
payments = await processor.for_row("square").list_recent_payments(begin)
```
`services/plaza_reconcile.py:342-344`:
```python
return await processor.for_row("square").list_payments_between(
    start.isoformat(), end.isoformat())
```
`services/plaza_reconcile.py:367` — leave `sq.square_enabled()` alone this task; Task 8 replaces it with `processor.any_enabled()`.

Both calls also pass `processor="square"` down into `settle_payment(...)`.

- [ ] **Step 7: Repoint the tests' monkeypatch targets (no assertion changes)**

Four files stub `services.square` functions that are now reached through the adapter. The adapter delegates to the same module functions, so `monkeypatch.setattr(sq, "fetch_payment", …)` **still works** — the adapter looks the attribute up at call time. Verify that is true by running the suite; if any test fails because it patched a name the adapter captured at import, repoint it to `services.square_adapter` and change nothing else. Files to watch:
`tests/plaza/test_plaza_quote_start.py` (stubs `sq.create_checkout` at lines 148, 177, 575, 595, 969 — these WILL need repointing, because the adapter's `create_checkout` signature differs from `sq.create_checkout`; patch `square_adapter.create_checkout` with an **async** fake taking the new nine kwargs),
`tests/plaza/test_plaza_webhook.py` (`sq.fetch_payment` → `square_adapter.fetch_by_payment_id`, async),
`tests/plaza/test_plaza_sweep.py` (`sq.list_recent_payments` → `square_adapter.list_recent_payments`, async),
`tests/plaza/test_plaza_reconcile.py` (`sq.list_payments_between` → `square_adapter.list_payments_between`, async; the two `sq._client` unit tests at lines 538-601 test the raw SDK wrapper and stay pointed at `services.square`),
`tests/plaza/test_plaza_refund.py` (`sq.refund_payment` → `square_adapter.refund_payment`, async).

- [ ] **Step 8: Run the suite**

```bash
cd /Users/gabe/lotlogic-backend-pay2park && .venv/bin/pytest tests/ -q
```

**Done when:**
- Full suite: **561 passed, 26 skipped** — the same count as Task 0. This task adds no tests and must lose none.
- `grep -rn "asyncio.to_thread(sq\.\|to_thread(\s*sq\." routers/ services/` returns **nothing** outside `services/square_adapter.py`.
- `grep -rn "SQUARE_LOCATION_ID" services/plaza_settle.py` returns nothing (it lives in the adapter now).
- Behaviour identical: a webhook, a sweep, a reconcile and a refund all take the same code path with the same outcomes.

- [ ] **Step 9: Commit**

```bash
cd /Users/gabe/lotlogic-backend-pay2park && \
git add routers/plaza_payments.py services/plaza_settle.py services/plaza_sweep.py services/plaza_reconcile.py tests/plaza/ && \
git commit -m "refactor(plaza-stripe): route every processor call through the dispatcher (no behaviour change)"
```

---

### Task 2: Migration `20260903000010` — `processor` column, `(day, processor)` PK, harness replay

Implements spec §3 (data model) and rulings S12, S13, S14. **Additive and defaulted, so it is safe under the currently-deployed code** — that is what makes step 1 of the runbook ("migration first, at any time") true.

**Files:**
- Create: `lotlogic-backend-pay2park/migrations/20260903000010_plaza_payments_processor.sql`
- Modify: `lotlogic-backend-pay2park/tests/plaza/conftest.py` (migration glob)
- Modify: `lotlogic-backend-pay2park/routers/plaza_payments.py` (stamp + read `processor`)
- Modify: `lotlogic-backend-pay2park/services/plaza_reconcile.py` (`ON CONFLICT (day, processor)`)
- Test: `lotlogic-backend-pay2park/tests/plaza/test_migrations.py` (extend)

**Interfaces:**
- Produces: `plaza_payments.processor`, `plaza_reconciliations.processor`, PK `plaza_reconciliations(day, processor)`.

**Existing tests that must gain a Stripe twin (inventory §10):** `test_migrations.py` (new `processor` assertions), `test_harness.py` (the replay must now pick up a `20260903*` file), `test_plaza_reconcile.py` (the upsert's conflict target changed).

- [ ] **Step 1: Write the migration — verbatim from spec §3**

`migrations/20260903000010_plaza_payments_processor.sql`:
```sql
SET lock_timeout = '5s';
ALTER TABLE public.plaza_payments
  ADD COLUMN processor text NOT NULL DEFAULT 'square'
    CONSTRAINT chk_plaza_payments_processor CHECK (processor IN ('square','stripe'));
-- DEFAULT stays (S14): a stale writer mislabels a row instead of killing the entrance.
COMMENT ON COLUMN public.plaza_payments.processor      IS 'square = quoted on the LotLogic Square account (pre-cutover); stripe = quoted on the plaza operator''s Stripe account. Decides which client services this row forever.';
COMMENT ON COLUMN public.plaza_payments.square_order_id    IS 'Processor order id: Square order id, or Stripe Checkout Session id (cs_…). Column name is historical.';
COMMENT ON COLUMN public.plaza_payments.square_payment_id  IS 'Processor payment id: Square payment id, or Stripe PaymentIntent id (pi_…).';
COMMENT ON COLUMN public.plaza_payments.square_checkout_url IS 'Hosted checkout URL for this quote (Square payment link or Stripe session.url).';
COMMENT ON COLUMN public.plaza_payments.square_receipt_url  IS 'Processor receipt URL (Square receipt, or Stripe charge.receipt_url).';
COMMENT ON COLUMN public.plaza_payments.square_refund_id    IS 'Processor refund id (Square refund id, or Stripe re_…).';

ALTER TABLE public.plaza_reconciliations
  ADD COLUMN processor text NOT NULL DEFAULT 'square'
    CONSTRAINT chk_plaza_reconciliations_processor CHECK (processor IN ('square','stripe')),
  DROP CONSTRAINT plaza_reconciliations_pkey,
  ADD PRIMARY KEY (day, processor);
```
Then the reconciliation column comments (spec §3: "square_count / square_cents / unmatched_square_payment_ids keep their names; COMMENT them as 'processor …'"):
```sql
COMMENT ON COLUMN public.plaza_reconciliations.processor    IS 'Which processor this day''s legs were counted from. The cutover day has one row per processor.';
COMMENT ON COLUMN public.plaza_reconciliations.square_cents IS 'Processor-side captured cents for the day (Square or Stripe). Column name is historical.';
COMMENT ON COLUMN public.plaza_reconciliations.square_count IS 'Processor-side captured payment count for the day. Column name is historical.';
```
**No renames.** No `DROP DEFAULT`. No `NOT VALID`.

- [ ] **Step 2: Widen the harness migration glob**

`tests/plaza/conftest.py:71` currently reads:
```python
MIGRATION_GLOB = "20260902*.sql"
```
Change to:
```python
#: Every pay-to-park migration, in sorted order. Widened past 20260902 when the
#: Stripe cutover added 20260903 files — a glob pinned to one day silently
#: stops replaying new migrations and the suite stays green while the schema
#: it tests no longer exists.
MIGRATION_GLOB = "2026090[23]*.sql"
```
Update the two docstrings that name `20260902*` (conftest.py:21-22 and the `_schema_scripts` docstring at :189) and the assertion message at :195-198 in the same edit.

- [ ] **Step 3: Write the failing tests**

Append to `tests/plaza/test_migrations.py`:
```python
# ── 20260903000010: processor ───────────────────────────────────────────────
async def test_plaza_payments_processor_defaults_to_square(db_conn, seed_truck_plaza):
    """S14 — the DEFAULT stays, so a stale writer mislabels instead of 500ing."""
    pid = await insert_payment(db_conn, seed_truck_plaza.property_id)
    got = (await db_conn.execute(
        text("SELECT processor FROM plaza_payments WHERE id = :id"), {"id": pid}
    )).scalar_one()
    assert got == "square"


async def test_plaza_payments_processor_rejects_an_unknown_value(db_conn, seed_truck_plaza):
    with pytest.raises(IntegrityError):
        await insert_payment(db_conn, seed_truck_plaza.property_id, processor="paypal")
    await db_conn.rollback()


async def test_plaza_payments_processor_accepts_stripe(db_conn, seed_truck_plaza):
    pid = await insert_payment(db_conn, seed_truck_plaza.property_id, processor="stripe")
    assert pid is not None


async def test_square_columns_were_not_renamed(db_conn):
    """S13 — a rename inside a money cutover is not rollback-able."""
    cols = {r[0] for r in (await db_conn.execute(text(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_schema='public' AND table_name='plaza_payments'"
    ))).all()}
    for name in ("square_order_id", "square_payment_id", "square_receipt_url",
                 "square_checkout_url", "square_refund_id"):
        assert name in cols


async def test_reconciliations_primary_key_is_day_processor(db_conn):
    """S12 — the table is day-keyed, not property-keyed; the cutover day needs both halves."""
    cols = [r[0] for r in (await db_conn.execute(text("""
        SELECT a.attname
          FROM pg_index i
          JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
         WHERE i.indrelid = 'public.plaza_reconciliations'::regclass AND i.indisprimary
         ORDER BY a.attnum
    """))).all()]
    assert cols == ["day", "processor"]


async def test_two_processor_rows_can_share_one_day(db_conn):
    """The cutover day writes one Square row and one Stripe row."""
    for proc in ("square", "stripe"):
        await db_conn.execute(text("""
            INSERT INTO plaza_reconciliations
                (day, processor, square_cents, square_count, ledger_cents,
                 ledger_count, pass_count, lotlogic_share_cents, plaza_share_cents, ok)
            VALUES ('2026-09-05', :p, 0, 0, 0, 0, 0, 0, 0, true)
        """), {"p": proc})
    await db_conn.commit()
    n = (await db_conn.execute(text(
        "SELECT count(*) FROM plaza_reconciliations WHERE day='2026-09-05'"))).scalar_one()
    assert n == 2
```

- [ ] **Step 4: Run to verify they fail**

Run: `cd /Users/gabe/lotlogic-backend-pay2park && .venv/bin/pytest tests/plaza/test_migrations.py -q`
Expected: FAIL — `column "processor" does not exist`

- [ ] **Step 5: Stamp `processor` on the INSERT (`routers/plaza_payments.py:522-545`)**

Add the column and the bind — **never rely on the DEFAULT** for our own writes:
```sql
                INSERT INTO public.plaza_payments (
                    id, property_id, plate_text, back_plate, phone, company_name,
                    visitor_name, stay_hours, policy_acknowledged_at, amount_cents,
                    currency, idempotency_key, payment_status, processor
                ) VALUES (
                    :id, :property_id, :plate, :back_plate, :phone, :company_name,
                    :visitor_name, :stay_hours, now(), :amount_cents,
                    'usd', :key, 'pending', :processor
                )
```
with `"processor": processor.current()` in the params dict. Import as `from services import processor as proc` if the local name `processor` collides — it does, inside `quote_and_start`; use `proc` module-wide in this router and never shadow it.

- [ ] **Step 6: Read `processor` everywhere a row is serviced**

Add `pp.processor` to the SELECT list of:
- `_QUOTE_BY_KEY_SQL` (plaza_payments.py:110)
- `_LOCK_QUOTE_SQL` (plaza_payments.py:193)
- `_REFUNDABLE_SQL` (plaza_payments.py:933)
- the settle row lock (plaza_settle.py:213-222)

and replace the Task 1 literals:
- refund endpoint: `row_processor = row["processor"]`
- `_start_checkout`: keeps `proc.current()` (a new quote has no row processor yet — it is being stamped in the same transaction)
- `settle_payment` callers pass `processor=row["processor"]`; inside `_settle_locked`, prefer the locked row's own value over the argument and log a WARNING if they disagree (a disagreement means a caller mapped a capture to a row of the other processor — that is `ownership_mismatch` territory, and the row wins).

- [ ] **Step 7: Fix the reconcile upsert — the PK changed under it**

`services/plaza_reconcile.py:135-154`. `ON CONFLICT (day)` is **invalid** the moment the PK becomes `(day, processor)`; leaving it would raise `there is no unique or exclusion constraint matching the ON CONFLICT specification` on the first reconcile tick after the migration. Change the INSERT column list and the conflict target:
```sql
    INSERT INTO public.plaza_reconciliations
        (day, processor, square_cents, square_count, ledger_cents, ledger_count, pass_count,
         refunded_cents, lotlogic_share_cents, plaza_share_cents, ok, details)
    VALUES
        (:day, :processor, :square_cents, :square_count, :ledger_cents, :ledger_count, :pass_count,
         :refunded_cents, :lotlogic_share_cents, :plaza_share_cents, :ok, CAST(:details AS jsonb))
    ON CONFLICT (day, processor) DO UPDATE SET
```
(the SET list is unchanged). Bind `"processor": "square"` for now — Task 8 makes it per-processor. Also add `processor` to `_ROWS_PRESENT_SQL`'s SELECT list; Task 8 changes the predicate.

- [ ] **Step 8: Run the suite**

```bash
cd /Users/gabe/lotlogic-backend-pay2park && .venv/bin/pytest tests/ -q
```

**Done when:**
- `tests/plaza/test_migrations.py` — 6 new tests pass.
- Full suite: **567 passed, 26 skipped**.
- `sorted(Path('migrations').glob('2026090[23]*.sql'))` includes the new file (assert it in the harness or eyeball the replay log).
- A reconcile tick still writes exactly one row per day, now with `processor='square'`.
- The migration file contains **no** `DROP DEFAULT`, **no** `RENAME`, **no** `NOT VALID`.

- [ ] **Step 9: Commit**

```bash
cd /Users/gabe/lotlogic-backend-pay2park && \
git add migrations/20260903000010_plaza_payments_processor.sql tests/plaza/ routers/plaza_payments.py services/plaza_reconcile.py && \
git commit -m "feat(plaza-stripe): processor column, (day,processor) reconciliation PK, processor stamped on every quote"
```

---

### Task 3: `services/stripe_plaza.py` + the in-process fake Stripe HTTP client

Implements spec §5.1–§5.4 and rulings S1, S3, S4, S6, S10, S11, S18, S19, S20, S21, S32, S33. Nothing routes to this yet.

**Files:**
- Modify: `lotlogic-backend-pay2park/services/stripe_plaza.py` (replace the Task 0 placeholder)
- Create: `lotlogic-backend-pay2park/tests/plaza/stripe_fake.py`
- Test: `lotlogic-backend-pay2park/tests/plaza/test_stripe_plaza.py`

**Interfaces:**
- Produces the full adapter surface from spec §4, all `async`, all returning the normalized payment dict:
  `{"id", "order_id", "status", "amount_cents", "currency", "refunded_cents", "receipt_url", "created_at", "note", "processor", "livemode"}`

**Existing tests that must gain a Stripe twin:** none directly — this is new surface. But `tests/plaza/test_plaza_settle.py`'s `_sq(...)` payment-dict builder is the shape contract; the new `_stripe_payment(...)` helper here must produce a dict with the **same keys plus `note`/`processor`/`livemode`**, and Task 4 asserts that.

- [ ] **Step 1: Introspect the library before writing (do not trust memory)**

```bash
cd /Users/gabe/lotlogic-backend-pay2park && .venv/bin/python -c "
import stripe, inspect
print(inspect.signature(stripe.StripeClient.__init__))
print(inspect.signature(stripe.HTTPXClient.__init__))
c = stripe.StripeClient('sk_test_x')
print([m for m in dir(c.v1.checkout.sessions) if not m.startswith('_')])
print(inspect.signature(c.construct_event))
print(inspect.signature(stripe.WebhookSignature.generate_signature_header))
for m in ('request','request_async','request_stream','request_stream_async'):
    print(m, inspect.signature(getattr(stripe.HTTPClient, m)))
"
```
Verified facts you may rely on (spec §13 tail): `request` returns `(str, int, headers)`; `request_async` returns `(bytes, int, headers)`; `generate_signature_header(payload: str, secret: str, timestamp=None)`; `_ApiVersion.CURRENT == "2026-08-26.dahlia"`.

- [ ] **Step 2: Write the fake Stripe HTTP client (S32)**

`tests/plaza/stripe_fake.py` — a stateful `stripe.HTTPClient` subclass. **All four request methods must be implemented**: a caller-supplied `http_client` gets no async fallback, so a missing `request_async` fails at runtime, not at import.

```python
"""In-process fake Stripe (spec §9.2). Mounted via
`stripe.StripeClient(key, http_client=FakeStripeHTTP(state))`.

Implements request / request_async / request_stream / request_stream_async
(S32 — a caller-supplied client gets no async fallback).

Routes served:
  POST /v1/checkout/sessions            (idempotency-key replay semantics)
  GET  /v1/checkout/sessions            (list, with `payment_intent` + `created` filters)
  GET  /v1/checkout/sessions/{id}       (retrieve, with expand)
  POST /v1/checkout/sessions/{id}/expire
  POST /v1/refunds
Helpers:
  state.pay(session_id, outcome=...)    flips state and returns the event bodies
  state.event(type, obj)                signed with WebhookSignature.generate_signature_header
"""
```
Required behaviours, each asserted by a test below:
- `POST /v1/checkout/sessions` with an `Idempotency-Key` header: **same key + identical params → the same session object** (not a new one); **same key + different params → HTTP 400 `{"error": {"type": "idempotency_error"}}`**. This is what proves the R6 recovery retry (S1) is safe.
- `GET .../sessions/{id}` honours `expand[]=payment_intent` and `expand[]=payment_intent.latest_charge`; without the expand it returns the id string, so a wrong prefix is visible (S33).
- `GET /v1/checkout/sessions?payment_intent=pi_…` can be made to return **two** rows on demand (`state.duplicate_sessions_for(pi_id)`) so the S10 sentinel is testable.
- `POST .../expire` on an already-`complete` session returns the session unchanged with HTTP 200 (idempotent, per spec §6).
- `state.pay(session_id, outcome="succeeded"|"processing"|"failed")` sets `payment_status`, PI `status`, and creates a `latest_charge` with `amount_captured`, `amount_refunded=0`, `receipt_url`, and an **epoch integer** `created`.

- [ ] **Step 3: Write the failing tests**

`tests/plaza/test_stripe_plaza.py`:
```python
def test_create_checkout_params_match_the_spec()          # every §5.1 key present, byte-exact
def test_create_checkout_sets_no_expires_at()             # S1: expires_at MUST be absent
def test_create_checkout_disables_adaptive_pricing()      # S4
def test_create_checkout_excludes_async_payment_methods() # S6: the 11-entry list, exact
def test_create_checkout_returns_order_id_and_checkout_url()
def test_same_idempotency_key_same_params_returns_same_session()   # S1/R6 recovery
def test_same_idempotency_key_different_params_raises()            # idempotency_error surfaces
def test_shape_status_completed_requires_paid_and_succeeded()      # S6 belt-and-braces
def test_shape_processing_intent_is_not_completed()                # async capture mints no pass
def test_shape_amount_comes_from_amount_captured_not_amount_total()  # S3
def test_shape_falls_back_to_session_amount_when_no_charge()
def test_shape_tolerates_missing_payment_intent_and_charge()       # a 500 = redelivery loop
def test_shape_created_at_round_trips_through_parse_paid_at()      # S21
def test_shape_note_from_client_reference_id()
def test_shape_note_falls_back_to_metadata_plaza_payment_id()
def test_fetch_payment_returns_none_for_unknown_session()
def test_fetch_payment_propagates_transport_errors()               # webhook → 500 → redelivery
def test_fetch_by_payment_id_returns_the_single_session()
def test_fetch_by_payment_id_two_sessions_returns_the_ambiguous_sentinel()   # S10
def test_fetch_by_payment_id_no_session_returns_none()
def test_list_payments_between_drops_foreign_sessions()            # metadata.source gate
def test_list_payments_between_paginates_to_max_pages()
def test_list_payments_between_raises_on_api_failure()             # empty day != failed call
def test_refund_uppercases_status_and_returns_id()
def test_refund_accepts_pending_requires_action_succeeded()        # S11
def test_expire_checkout_is_idempotent_on_a_complete_session()
def test_ownership_mismatch_none_for_our_live_session()
def test_ownership_mismatch_flags_foreign_metadata_source()        # S15/S24
def test_ownership_mismatch_flags_wrong_property_id()
def test_ownership_mismatch_flags_non_usd_currency()               # S4
def test_ownership_mismatch_flags_livemode_false_in_production()   # S5
```
Key assertions, spelled out:
```python
def test_create_checkout_sets_no_expires_at(fake_stripe):
    """S1 — expires_at + a fixed idempotency key = IdempotencyError on every
    recovery retry. The TTL is the sweep's job (§6), never the session's."""
    params = fake_stripe.last_request_params("POST", "/v1/checkout/sessions")
    assert "expires_at" not in params

def test_create_checkout_excludes_async_payment_methods(fake_stripe):
    """S6 — an async bank debit captures days later and would mint a pass."""
    params = fake_stripe.last_request_params("POST", "/v1/checkout/sessions")
    assert params["excluded_payment_method_types"] == [
        "us_bank_account", "acss_debit", "sepa_debit", "bacs_debit",
        "au_becs_debit", "nz_bank_account", "pay_by_bank", "customer_balance",
        "boleto", "konbini", "oxxo",
    ]

def test_shape_created_at_round_trips_through_parse_paid_at():
    """S21 — an epoch integer through _parse_paid_at sends every payment to
    manual review. _shape must hand settle an ISO-8601 UTC string."""
    from services.plaza_settle import _parse_paid_at
    shaped = stripe_plaza._shape(session_with(charge_created=1788000000))
    assert shaped["created_at"] == "2026-09-03T..."   # exact string from the epoch
    assert _parse_paid_at(shaped["created_at"]) is not None
```

- [ ] **Step 4: Run to verify they fail**

Run: `cd /Users/gabe/lotlogic-backend-pay2park && .venv/bin/pytest tests/plaza/test_stripe_plaza.py -q`
Expected: FAIL — `NotImplementedError: services.stripe_plaza — Task 3`

- [ ] **Step 5: Implement the client**

Module constants:
```python
PROCESSOR = "stripe"
CURRENCY = "USD"
NOTE_PREFIX = "plaza:"                 # identical to services.square — one vocabulary
CLIENT_TIMEOUT_SECONDS = 20.0
MAX_NETWORK_RETRIES = 2
MAX_RECONCILE_PAGES = 50               # same cap as Square's list_payments_between
#: What `fetch_by_payment_id` returns when Stripe has more than one session for
#: one PaymentIntent (S10). settle maps this to needs_manual_review.
AMBIGUOUS_STATUS = "AMBIGUOUS_SESSION"
_EXPAND = ["payment_intent", "payment_intent.latest_charge"]
_EXPAND_LIST = ["data.payment_intent", "data.payment_intent.latest_charge"]  # S33
```

Client construction (verified against 15.6.1) — a fresh client per call, never a module global:
```python
def _client():
    key = get_settings().stripe_plaza_secret_key.strip()
    if not key:
        raise RuntimeError("stripe_plaza: STRIPE_PLAZA_SECRET_KEY is not set")
    return stripe.StripeClient(
        key,
        max_network_retries=MAX_NETWORK_RETRIES,
        http_client=stripe.HTTPXClient(timeout=CLIENT_TIMEOUT_SECONDS),
    )
```
`enabled()` is `bool(get_settings().stripe_plaza_secret_key.strip())`.
`is_test_key()` is `key.startswith(("rk_test_", "sk_test_"))` (S5).
`is_production()` — see the note under Task 10 Step 2; it delegates to `services.square.is_production()` so the plaza has exactly one notion of "production".

`create_checkout` builds **exactly** these params (spec §5.1, verbatim):
```python
params = {
  "mode": "payment",
  "line_items": [{"quantity": 1, "price_data": {"currency": "usd", "unit_amount": amount_cents,
                  "product_data": {"name": f"Parking — {label} — {property_name}"}}}],
  "client_reference_id": str(pp_id),
  "metadata": {"source": "lotlogic-plaza", "plaza_payment_id": str(pp_id),
               "property_id": str(property_id), "plate": plate},
  "payment_intent_data": {"metadata": <same dict>, "description": f"plaza:{pp_id}"},
  "success_url": success_url,
  "cancel_url": cancel_url,
  "customer_creation": "if_required",
  "submit_type": "pay",
  "adaptive_pricing": {"enabled": False},
  "excluded_payment_method_types": ["us_bank_account","acss_debit","sepa_debit","bacs_debit",
      "au_becs_debit","nz_bank_account","pay_by_bank","customer_balance","boleto","konbini","oxxo"],
}
session = await client.v1.checkout.sessions.create_async(params, {"idempotency_key": idempotency_key})
return {"order_id": session.id, "checkout_url": session.url}
```
There is **no** `expires_at` key (S1). Write that as a comment above the dict, not just in the plan.

`_shape(session)` maps exactly the spec §5.2 table. Two rules that are easy to get wrong:
- `status` is `"COMPLETED"` **iff** `session.payment_status == "paid"` **and** `payment_intent.status == "succeeded"`; otherwise return the raw session status uppercased, so a `processing` async capture reads `"OPEN"`/`"COMPLETE"` and settle answers `rejected_not_completed`.
- `created_at` converts the **epoch integer** `latest_charge.created` (else `session.created`) to an ISO-8601 UTC string with `datetime.fromtimestamp(v, tz=timezone.utc).isoformat()` (S21).
`_shape` must never raise on `payment_intent is None` or `latest_charge is None`.

`fetch_payment(order_id)` → `sessions.retrieve_async(order_id, {"expand": _EXPAND})`; a Stripe `InvalidRequestError` for a missing resource → `None`; every other exception propagates (webhook → 500 → redelivery).

`fetch_by_payment_id(payment_id)` → `sessions.list_async({"payment_intent": payment_id, "expand": _EXPAND_LIST})`; `len(data) > 1` → return `{"status": AMBIGUOUS_STATUS, "processor": "stripe", "id": payment_id, "order_id": None, "note": None}`; `0` → `None`; else `_shape(data[0])`.

`list_payments_between(begin_iso, end_iso)` → `sessions.list_async({"created": {"gte": ts0, "lt": ts1}, "limit": 100, "expand": _EXPAND_LIST})`, auto-paginated to `MAX_RECONCILE_PAGES`, `RuntimeError` on API failure, and **client-side drop** of any session whose `metadata.source != "lotlogic-plaza"` (Frank's other traffic is invisible to us and never counted). `ts0`/`ts1` are epoch ints derived from the ISO bounds.

**No list-based sweep for Stripe (S7/S8)** — do not add a `list_recent_payments`. `sessions.list` has no metadata filter and is newest-first with no sort option; on Frank's shared account a page cap would starve exactly the oldest row. Put that sentence in the module docstring.

`refund_payment(*, payment_id, amount_cents, idempotency_key)`:
```python
refund = await client.v1.refunds.create_async(
    {"payment_intent": payment_id, "amount": amount_cents},
    {"idempotency_key": idempotency_key},
)
return {"id": refund.id, "status": (refund.status or "").upper()}
```

`expire_checkout(order_id)` → `sessions.expire_async(order_id, {})`; swallow the "already complete / already expired" `InvalidRequestError` and return `None`.

`ownership_mismatch(payment, row) -> str | None` (S18):
```python
def ownership_mismatch(payment, row):
    md = payment.get("metadata") or {}
    if md.get("source") != "lotlogic-plaza":
        return "ownership_mismatch"
    if str(md.get("property_id") or "") != str(row["property_id"]):
        return "ownership_mismatch"
    if (payment.get("currency") or "").upper() != CURRENCY:       # S4
        return "ownership_mismatch"
    if is_production() and payment.get("livemode") is not True:   # S5
        return "ownership_mismatch"
    return None
```
`_shape` must therefore carry `metadata` through on the normalized dict (an extra key beyond the §4 list is fine; the consumers read by name).

- [ ] **Step 6: Run the tests, then the suite**

```bash
cd /Users/gabe/lotlogic-backend-pay2park
.venv/bin/pytest tests/plaza/test_stripe_plaza.py -q     # expect 31 passed
.venv/bin/pytest tests/ -q
```

**Done when:**
- `tests/plaza/test_stripe_plaza.py` — 31 passed.
- Full suite: **598 passed, 26 skipped**.
- `grep -n "stripe.api_key\|stripe.checkout.Session\|stripe.Webhook\." services/stripe_plaza.py` → **nothing**.
- `grep -n "expires_at" services/stripe_plaza.py` → **nothing**.
- Every SDK call in the module is `client.v1.…_async(params, options)`.

- [ ] **Step 7: Commit**

```bash
cd /Users/gabe/lotlogic-backend-pay2park && \
git add services/stripe_plaza.py tests/plaza/stripe_fake.py tests/plaza/test_stripe_plaza.py && \
git commit -m "feat(plaza-stripe): Stripe checkout/fetch/list/refund/expire client + in-process fake"
```

---

### Task 4: Settle — ownership chain, `ambiguous_session`, currency and livemode

Implements spec §4 (settle's location check becomes `adapter.ownership_mismatch`), §5.2 (currency/livemode) and rulings S10, S18. Task 1 already moved the leg behind the adapter; this task makes the **outcomes** right for Stripe and adds the ambiguous-session state.

**Files:**
- Modify: `lotlogic-backend-pay2park/services/plaza_settle.py`
- Test: `lotlogic-backend-pay2park/tests/plaza/test_plaza_settle.py` (extend)

**Interfaces:**
- Adds `needs_manual_review` values `ownership_mismatch`, `ambiguous_session` (spec §3).
- `settle_payment(...)` signature unchanged apart from Task 1's `processor` kwarg.

**Existing tests that must gain a Stripe twin (inventory §10):** `tests/plaza/test_plaza_settle.py` — every test that builds a `_sq(...)` COMPLETED dict gets a `_stripe(...)` twin. Parametrize with `processor="square"|"stripe"` where the assertion is identical; write separate tests only where the expected reason differs.

- [ ] **Step 1: Write the failing tests**

Add to `tests/plaza/test_plaza_settle.py`:
```python
def _stripe(pp, **over):
    """The Stripe-shaped normalized payment. Same keys as _sq plus note/processor/livemode."""
    base = {"id": "pi_1", "order_id": pp.square_order_id, "status": "COMPLETED",
            "amount_cents": pp.amount_cents, "currency": "USD",
            "refunded_cents": 0, "receipt_url": "https://pay.stripe.com/receipts/1",
            "created_at": "2026-09-03T15:00:00+00:00", "note": f"plaza:{pp.id}",
            "processor": "stripe", "livemode": True,
            "metadata": {"source": "lotlogic-plaza", "plaza_payment_id": str(pp.id),
                         "property_id": str(pp.property_id), "plate": pp.plate_text}}
    base.update(over)
    return base


async def test_stripe_capture_creates_exactly_one_pass(engine, pending_stripe_payment):
    out = await settle_payment(engine, plaza_payment_id=pending_stripe_payment.id,
                               square_payment=_stripe(pending_stripe_payment),
                               background_tasks=None, processor="stripe")
    assert out["outcome"] == "created" and out["pass_id"]


async def test_stripe_replay_x5_creates_exactly_one_pass(engine, pending_stripe_payment):
    outs = [await settle_payment(engine, plaza_payment_id=pending_stripe_payment.id,
                                 square_payment=_stripe(pending_stripe_payment),
                                 background_tasks=None, processor="stripe")
            for _ in range(5)]
    assert len({o["pass_id"] for o in outs}) == 1
    assert [o["outcome"] for o in outs].count("created") == 1


async def test_stripe_foreign_metadata_source_is_ownership_mismatch(engine, pending_stripe_payment):
    """S15/S24 — a session that is not ours never becomes a pass."""
    out = await settle_payment(
        engine, plaza_payment_id=pending_stripe_payment.id,
        square_payment=_stripe(pending_stripe_payment, metadata={"source": "franks-other-store"}),
        background_tasks=None, processor="stripe")
    assert out["outcome"] == "manual_review"
    assert await review_reason(pending_stripe_payment.id) == "ownership_mismatch"


async def test_stripe_wrong_property_id_is_ownership_mismatch(engine, pending_stripe_payment): ...
async def test_stripe_non_usd_currency_never_settles(engine, pending_stripe_payment): ...  # S4
async def test_stripe_livemode_false_in_production_is_ownership_mismatch(engine, pending_stripe_payment, monkeypatch): ...  # S5


async def test_ambiguous_session_sentinel_marks_review_and_leaves_row_pending(engine, pending_stripe_payment):
    """S10 — two sessions for one PaymentIntent is a human's call, not a guess."""
    from services import stripe_plaza
    sentinel = {"status": stripe_plaza.AMBIGUOUS_STATUS, "processor": "stripe",
                "id": "pi_1", "order_id": None, "note": None}
    out = await settle_payment(engine, plaza_payment_id=pending_stripe_payment.id,
                               square_payment=sentinel, background_tasks=None,
                               processor="stripe")
    assert out["outcome"] == "manual_review"
    row = await get_row(pending_stripe_payment.id)
    assert row["needs_manual_review"] == "ambiguous_session"
    assert row["payment_status"] == "pending"      # no money fields stamped
    assert row["paid_at"] is None
    assert row["square_payment_id"] is None


async def test_square_location_mismatch_outcome_is_unchanged(engine, pending_payment):
    """Regression guard: Square's reason string and outcome must not move."""
    ...
    assert out["outcome"] == "rejected_amount_mismatch"
    assert await review_reason(pending_payment.id) == "location_mismatch"


async def test_ownership_mismatch_outcome_is_manual_review(engine, pending_stripe_payment):
    """A stranger's capture is never 'a pricing disagreement'."""
```
Add a `pending_stripe_payment` fixture to `tests/plaza/conftest.py` — the existing `plaza_payment_factory` with `processor="stripe"` and a `cs_test_…` order id.

- [ ] **Step 2: Run to verify they fail**

Run: `cd /Users/gabe/lotlogic-backend-pay2park && .venv/bin/pytest tests/plaza/test_plaza_settle.py -q`
Expected: FAIL — `ambiguous_session` never written; `ownership_mismatch` mapped to `rejected_amount_mismatch`.

- [ ] **Step 3: Handle the ambiguous sentinel — before the COMPLETED check**

In `_settle_locked`, immediately after the row lock and the terminal-state guards, before `if square_payment.get("status") != "COMPLETED"`:
```python
        if square_payment.get("status") == stripe_plaza.AMBIGUOUS_STATUS:
            # S10 — Stripe returned more than one Checkout Session for this
            # PaymentIntent. Which one the driver bought is not derivable, and
            # guessing writes the wrong stay onto a real charge. Flag and stop:
            # the row stays `pending` with no money fields stamped, so the
            # sweep keeps re-checking and a human resolves it.
            await conn.execute(text(_MARK_AMBIGUOUS_SQL), {"id": plaza_payment_id})
            return "manual_review", None, None
```
with
```python
_MARK_AMBIGUOUS_SQL = """
    UPDATE public.plaza_payments
       SET needs_manual_review = 'ambiguous_session'
     WHERE id = :id
       AND needs_manual_review IS NULL
"""
```
Import `stripe_plaza` lazily inside the function (module-level import of an SDK-touching module from settle is unnecessary coupling), or compare against the literal `"AMBIGUOUS_SESSION"` with a comment pointing at `stripe_plaza.AMBIGUOUS_STATUS`.

- [ ] **Step 4: Extend the reason → outcome mapping**

```python
#: Reasons that are a HUMAN's call, not a pricing disagreement: nobody can
#: tell from the amount alone what the customer bought.
_REVIEW_REASONS = frozenset({"order_mismatch", "ownership_mismatch", "ambiguous_session"})
...
outcome = "manual_review" if mismatch in _REVIEW_REASONS else "rejected_amount_mismatch"
```
`location_mismatch` stays outside the set — Square's outcome vocabulary is unchanged (the watcher matches on it).

- [ ] **Step 5: Run the suite**

```bash
cd /Users/gabe/lotlogic-backend-pay2park && .venv/bin/pytest tests/ -q
```

**Done when:**
- 10 new settle tests pass; every pre-existing settle test still passes untouched.
- Full suite: **608 passed, 26 skipped**.
- A Stripe COMPLETED capture creates exactly one pass; five replays create exactly one.
- A non-ours / wrong-property / non-USD / test-mode-in-prod capture is `manual_review` with reason `ownership_mismatch` and **no pass**.
- The ambiguous sentinel leaves `payment_status='pending'`, `paid_at IS NULL`, `square_payment_id IS NULL`.

- [ ] **Step 6: Commit**

```bash
cd /Users/gabe/lotlogic-backend-pay2park && \
git add services/plaza_settle.py tests/plaza/test_plaza_settle.py tests/plaza/conftest.py && \
git commit -m "feat(plaza-stripe): settle ownership chain, ambiguous_session, currency/livemode gates"
```

---

### Task 5: `POST /plaza/stripe/webhook` — route, allow-list, ownership gate, settle mapping

Implements spec §5.5 (everything except the refund/dispute handlers, which are Task 6) and rulings S15, S22, S23, S24. **The `main.py` allow-list entry ships in this commit (S22)** — a route without it 401s every delivery and Stripe retries into a wall.

**Files:**
- Modify: `lotlogic-backend-pay2park/routers/plaza_payments.py`
- Modify: `lotlogic-backend-pay2park/main.py`
- Modify: `lotlogic-backend-pay2park/services/plaza_alerts.py`
- Test: `lotlogic-backend-pay2park/tests/plaza/test_stripe_webhook.py` (new)

**Interfaces:**
- Produces: `POST /plaza/stripe/webhook`. `/plaza/webhook` stays Square's, untouched.
- Changes: `plaza_alerts.record_signature_failure(processor: str = "square")`; new condition `stripe_signature_failure`.

**Existing tests that must gain a Stripe twin (inventory §10):** `tests/plaza/test_plaza_webhook.py` — the whole file. Its Stripe counterpart is this task's new file; the Square file must not be edited except where `record_signature_failure`'s new argument changes a spy's signature.

- [ ] **Step 1: Write the failing tests**

`tests/plaza/test_stripe_webhook.py`:
```python
def _signed(body: dict, secret: str) -> tuple[bytes, str]:
    payload = json.dumps(body)
    header = stripe.WebhookSignature.generate_signature_header(payload, secret)
    return payload.encode(), header

async def test_bad_signature_is_400_and_counts_a_failure(app_client, stripe_secret, alert_spy)
async def test_missing_signature_header_is_400(app_client, stripe_secret)
async def test_session_completed_settles_and_creates_one_pass(app_client, pending_stripe_payment, fake_stripe)
async def test_payment_intent_succeeded_settles_the_same_row(app_client, pending_stripe_payment, fake_stripe)
async def test_both_events_in_either_order_create_exactly_one_pass(app_client, pending_stripe_payment, fake_stripe)
async def test_redelivered_event_returns_already_settled(app_client, pending_stripe_payment, fake_stripe)
async def test_event_body_is_never_trusted(app_client, pending_stripe_payment, fake_stripe):
    """The body claims paid/$999; the fetched session says unpaid. No pass."""
async def test_payment_intent_succeeded_while_session_unpaid_is_rejected_not_completed(...)
async def test_foreign_session_returns_200_not_ours_and_raises_no_alert(app_client, fake_stripe, alert_spy):
    """S15 — Frank's other sales must never page billing@."""
    assert body["outcome"] == "not_ours"
    assert alert_spy.orphan_captures == 0
async def test_unmatched_ours_completed_capture_raises_the_orphan_alert(app_client, fake_stripe, alert_spy)
async def test_note_recovery_requires_ownership(app_client, pending_stripe_payment, fake_stripe):
    """S24 — a stranger's session must not be adopted through the note path."""
async def test_note_recovery_succeeds_when_ownership_holds(...)
async def test_session_expired_marks_the_row_abandoned_without_a_fetch(app_client, pending_stripe_payment, fake_stripe):
    assert fake_stripe.request_count("GET", "/v1/checkout/sessions/…") == 0
async def test_session_expired_on_a_paid_row_is_a_noop(...)
async def test_transport_failure_returns_500_so_stripe_redelivers(app_client, pending_stripe_payment, fake_stripe)
async def test_unknown_session_returns_200(app_client, fake_stripe)
async def test_webhook_path_is_public(app_client):
    """S22 — without the allow-list entry every delivery 401s."""
    r = await app_client.post("/plaza/stripe/webhook", content=b"{}")
    assert r.status_code != 401
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd /Users/gabe/lotlogic-backend-pay2park && .venv/bin/pytest tests/plaza/test_stripe_webhook.py -q`
Expected: FAIL — 404 / 401.

- [ ] **Step 3: Implement the route**

Shape it on the existing `square_webhook` (plaza_payments.py:711-895) so the outcome vocabulary, the `_noop`/`_retry` helpers, the `_log_webhook` line and the 200/500 contract are shared. Differences only:

```python
_STRIPE_EVENTS = frozenset({
    "checkout.session.completed", "checkout.session.async_payment_succeeded",
    "checkout.session.async_payment_failed", "checkout.session.expired",
    "payment_intent.succeeded", "payment_intent.payment_failed",
    "charge.refunded", "charge.refund.updated",
    "charge.dispute.created", "charge.dispute.closed",
})

@router.post("/stripe/webhook")
async def stripe_webhook(request: Request, background_tasks: BackgroundTasks,
                         db: AsyncSession = Depends(get_db)):
    raw = await request.body()                         # RAW bytes before any parse
    sig = request.headers.get("stripe-signature", "")
    secret = get_settings().stripe_plaza_webhook_secret.strip()
    try:
        # S23 — the CLIENT form. The module-level stripe.Webhook.construct_event
        # resolves the NMLD app's global key and would verify against the wrong
        # account's secret.
        event = stripe_plaza.construct_event(raw, sig, secret)
    except Exception:
        plaza_alerts.record_signature_failure("stripe")
        log.warning("plaza stripe webhook: signature verification FAILED ip=%s", _client_ip(request))
        raise HTTPException(status_code=400, detail="bad_signature")
```
Add `construct_event(raw, sig, secret)` to `services/stripe_plaza.py` as a thin `_client().construct_event(raw, sig, secret, tolerance=300)` wrapper, so the router never touches the SDK directly.

Then, **never trust the body** (spec §5.5):
```python
    etype = event["type"]
    obj = (event.get("data") or {}).get("object") or {}
    if etype not in _STRIPE_EVENTS:
        return _noop("unsubscribed_event", event_type=etype)

    if etype == "checkout.session.expired":
        # Idempotent, no fetch: an expired session cannot become paid.
        await db.execute(text(
            "UPDATE public.plaza_payments SET payment_status='abandoned' "
            "WHERE square_order_id = :sid AND payment_status = 'pending'"
        ), {"sid": obj.get("id")})
        await db.commit()
        return _noop("expired", event_type=etype)

    if etype.startswith("checkout.session."):
        payment = await stripe_plaza.fetch_payment(obj.get("id"))
    else:                                    # payment_intent.* and charge.*
        pi = obj.get("id") if etype.startswith("payment_intent.") else obj.get("payment_intent")
        payment = await stripe_plaza.fetch_by_payment_id(pi)
```
Transport failure inside those fetches propagates → `_retry("transient_error")` → **500** so Stripe redelivers. `None` → `_noop("payment_not_found")`.

Mapping and the ownership gate:
```python
    row = await _row_by_order(db, payment.get("order_id"))
    mapped_by = "order"
    if row is None:
        noted = _note_payment_id(payment.get("note"))
        if noted:
            candidate = await _row_by_id(db, noted)
            # S24 — the note alone must never adopt a stranger's session.
            if candidate is not None and stripe_plaza.ownership_mismatch(payment, candidate) is None:
                row, mapped_by = candidate, "note"
    if row is None:
        # S15 — the ownership gate comes BEFORE any alert. Frank's other sales
        # are not our orphans.
        if stripe_plaza.ownership_mismatch(payment, _NO_ROW) is not None:
            return _noop("not_ours", event_type=etype)
        if _is_stripe_orphan_capture(payment):
            log.error("plaza stripe webhook: ORPHAN capture pi=%s amount_cents=%s",
                      payment.get("id"), payment.get("amount_cents"))
            plaza_alerts.record_orphan_capture()
        return _noop("unknown_order", event_type=etype)
```
`ownership_mismatch` takes a row; for the no-row case check only `metadata.source` — add a module-level helper `stripe_plaza.is_ours(payment) -> bool` (source check only) and use it here, so the row-scoped function keeps its exact meaning.

Settle exactly as the Square webhook does:
```python
    await db.rollback()
    out = await settle_payment(engine, plaza_payment_id=row["id"], square_payment=payment,
                               background_tasks=background_tasks,
                               allow_order_mismatch=(mapped_by == "note"),
                               processor="stripe")
```
Response codes identical to Square's: 500 only for `transient_error`; 200 for everything else; `outcome == "created"` queues `_send_receipt_safely`.

- [ ] **Step 4: Add the allow-list entry in the SAME commit (S22)**

`main.py` `PUBLIC_PATHS` (around line 297), next to `"/plaza/webhook"`:
```python
    # The plaza's Stripe endpoint. Its auth is the Stripe signature verified
    # in-handler, exactly like the Square one above — the middleware has no
    # credential to check and would 401 every delivery (S22).
    "/plaza/stripe/webhook",
```

- [ ] **Step 5: Teach the alerts module about the second signature counter**

`services/plaza_alerts.py`:
```python
CONDITIONS = (
    "pending_over_10m",
    "manual_review",
    "signature_failures",
    "stripe_signature_failure",
    "orphan_captures",
    "sweep_square_errors",
)
```
`record_signature_failure(processor: str = "square")` bumps one of two counters; the default keeps every existing Square call site working unchanged. Add `"stripe_signature_failure": {"count": stripe_signature_failures}` to the `conditions` dict. Same 60-minute per-condition cooldown, same channels.

- [ ] **Step 6: Run the suite**

```bash
cd /Users/gabe/lotlogic-backend-pay2park && .venv/bin/pytest tests/ -q
```

**Done when:**
- `tests/plaza/test_stripe_webhook.py` — 18 passed.
- Full suite: **626 passed, 26 skipped**.
- `"/plaza/stripe/webhook" in main.PUBLIC_PATHS` — asserted by a test, in this commit.
- A foreign session returns 200 `not_ours` and bumps **no** counter.
- `grep -n "stripe.Webhook\.\|stripe.api_key" routers/plaza_payments.py services/stripe_plaza.py` → nothing.

- [ ] **Step 7: Commit**

```bash
cd /Users/gabe/lotlogic-backend-pay2park && \
git add routers/plaza_payments.py main.py services/plaza_alerts.py tests/plaza/test_stripe_webhook.py && \
git commit -m "feat(plaza-stripe): signature-verified Stripe webhook, ownership gate, allow-list entry"
```

---

### Task 6: Stripe webhook — refund, refund-failure and dispute handlers + money alerts

Implements the rest of spec §5.5 and rulings S11, S25. These are the events that move money **after** a pass exists.

**Files:**
- Modify: `lotlogic-backend-pay2park/routers/plaza_payments.py`
- Modify: `lotlogic-backend-pay2park/services/plaza_alerts.py`
- Test: `lotlogic-backend-pay2park/tests/plaza/test_stripe_webhook_money.py` (new)

**Interfaces:**
- Produces alert conditions `external_refund`, `refund_failed`, `dispute`, `dispute_lost`.
- Adds `refunded_by` values `stripe:dashboard`, `stripe:dispute`; `needs_manual_review` value `refund_failed`.

**Existing tests that must gain a Stripe twin (inventory §10):** `tests/plaza/test_plaza_refund.py` covers the admin endpoint (Task 9); this task's events have no Square counterpart — Square's subscription is `payment.created`/`payment.updated` only.

- [ ] **Step 1: Write the failing tests**

`tests/plaza/test_stripe_webhook_money.py`:
```python
async def test_charge_refunded_on_a_paid_row_marks_refunded_and_cancels_the_pass(...)
    """Dashboard refund: row 'refunded', refunded_by='stripe:dashboard', pass cancelled, alert external_refund."""
async def test_charge_refunded_when_we_issued_it_is_not_a_second_refund(...)
    """square_refund_id already set → no duplicate alert, ledger untouched."""
async def test_refund_updated_failed_reverts_to_paid_and_flags(...)
    """S11 — revert to paid, clear refunded_at/refund_amount_cents, KEEP square_refund_id,
    stamp needs_manual_review='refund_failed', alert. The pass is NOT re-activated."""
async def test_refund_updated_canceled_takes_the_same_path(...)
async def test_refund_updated_succeeded_is_a_noop(...)
async def test_dispute_created_alerts_with_plate_company_amount(...)
async def test_dispute_closed_lost_is_treated_like_a_refund(...)
    """S25 — row 'refunded', refunded_by='stripe:dispute', refund_amount_cents = disputed
    amount, pass cancelled if active, alert dispute_lost. Never billed to Frank as revenue."""
async def test_dispute_closed_won_changes_nothing(...)
async def test_dispute_on_a_foreign_charge_raises_no_alert(...)     # S15
async def test_every_money_event_returns_200(...)
async def test_refund_events_are_idempotent_on_redelivery(...)
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd /Users/gabe/lotlogic-backend-pay2park && .venv/bin/pytest tests/plaza/test_stripe_webhook_money.py -q`
Expected: FAIL — the handlers return `unsubscribed_event`.

- [ ] **Step 3: Implement the handlers**

All four run **after** the ownership gate from Task 5 and all reuse the existing `_MARK_REFUNDED_SQL` / `_CANCEL_PASS_SQL` so the ledger writes stay in one place.

`charge.refunded` on a `paid` row with `square_refund_id IS NULL` (i.e. somebody refunded in Frank's Stripe dashboard, not through our endpoint):
```sql
UPDATE public.plaza_payments
   SET payment_status = 'refunded', refunded_at = now(),
       refund_amount_cents = :amount, refunded_by = 'stripe:dashboard',
       square_refund_id = :refund_id
 WHERE id = :id AND payment_status = 'paid'
RETURNING id, pass_id
```
then cancel the pass with the existing `_CANCEL_PASS_SQL` and raise `plaza_alerts.record_money_event("external_refund", …)`.

`charge.refund.updated` with `status IN ('failed','canceled')` on a `refunded` row (S11):
```sql
UPDATE public.plaza_payments
   SET payment_status = 'paid', refunded_at = NULL, refund_amount_cents = NULL,
       needs_manual_review = 'refund_failed'
 WHERE id = :id AND payment_status = 'refunded'
```
`square_refund_id` is **kept** — it is the id of the refund that failed and the only way to find it again. The pass is **not** re-activated: a cancelled pass whose driver has left must not silently come back; a human decides.

`charge.dispute.created` → alert `dispute` with plate, company and amount. No ledger write.

`charge.dispute.closed` with `status == 'lost'` (S25) → the refund path with `refunded_by='stripe:dispute'` and `refund_amount_cents` = the disputed amount, pass cancelled if active, alert `dispute_lost`. Any other close status → 200, no write.

- [ ] **Step 4: Add the four alert conditions**

`services/plaza_alerts.py` `CONDITIONS` gains `"external_refund"`, `"refund_failed"`, `"dispute"`, `"dispute_lost"`. These are **events**, not states, so they are counters bumped by the webhook (like `orphan_captures`) rather than SQL predicates. PII rule from the parent rollout doc still holds for the alert **body**: ids and amounts only — the plate/company in the dispute alert is the one documented exception, because Frank needs to know which truck; keep it out of any file the watcher writes.

- [ ] **Step 5: Run the suite**

**Done when:**
- 12 new tests pass. Full suite: **638 passed, 26 skipped**.
- A dashboard refund cancels the pass and alerts exactly once, even on redelivery.
- A failed refund reverts to `paid` with `needs_manual_review='refund_failed'` and leaves the pass cancelled.
- A lost dispute is a refund, not revenue.
- A dispute on a charge that is not ours raises nothing.

- [ ] **Step 6: Commit**

```bash
cd /Users/gabe/lotlogic-backend-pay2park && \
git add routers/plaza_payments.py services/plaza_alerts.py tests/plaza/test_stripe_webhook_money.py && \
git commit -m "feat(plaza-stripe): external refund, failed-refund revert and dispute handlers"
```

---

### Task 7: Stripe per-row sweep, 60-minute TTL, stale-URL guard, pending window

Implements spec §6 in full and rulings S1, S2b, S7, S8, S17, S26. Square's sweep is **unchanged** — this is a second code path inside the same tick, selected per row.

**Files:**
- Modify: `lotlogic-backend-pay2park/services/plaza_sweep.py`
- Modify: `lotlogic-backend-pay2park/routers/plaza_payments.py` (stale-URL guard + `_PENDING_WINDOW_MINUTES`)
- Modify: `lotlogic-backend-pay2park/services/plaza_alerts.py` (`pending_over_70m`)
- Test: `lotlogic-backend-pay2park/tests/plaza/test_plaza_sweep.py` (extend) + `tests/plaza/test_plaza_alerts.py` (extend)

**Interfaces:**
- Produces: `STRIPE_QUOTE_TTL_MINUTES = 60`, `STRIPE_SWEEP_BATCH_LIMIT = 50`.

**Existing tests that must gain a Stripe twin (inventory §10):** `tests/plaza/test_plaza_sweep.py` (the whole stub-driven set), `tests/plaza/test_plaza_alerts.py` (`pending_over_10m`), `tests/plaza/test_plaza_summary.py` (`pending_recent` window).

- [ ] **Step 1: Write the failing tests**

`tests/plaza/test_plaza_sweep.py` additions:
```python
async def test_stripe_sweep_settles_a_missed_webhook(engine, pending_stripe_payment, fake_stripe)
async def test_stripe_sweep_fetches_per_row_not_by_listing(engine, fake_stripe):
    """S7/S8 — sessions.list has no metadata filter and is newest-first, so a
    page cap would starve exactly the oldest row on Frank's shared account."""
    assert fake_stripe.request_count("GET", "/v1/checkout/sessions") == 0
    assert fake_stripe.request_count("GET", "/v1/checkout/sessions/{id}") == n_pending
async def test_stripe_sweep_expires_a_61_minute_row(engine, pending_stripe_payment, fake_stripe):
    """expire_checkout, then mark abandoned — AFTER re-fetching and settling if paid."""
async def test_stripe_sweep_settles_a_61_minute_row_that_turns_out_paid(engine, ...):
    """The re-fetch comes first. Expiring a paid session must never write off real money."""
async def test_stripe_sweep_expire_is_idempotent_on_a_complete_session(...)
async def test_stripe_sweep_is_capped_at_50_rows_per_tick(engine, ...)
async def test_stripe_sweep_respects_the_90s_floor(engine, ...)
async def test_stripe_sweep_leaves_square_rows_to_the_square_path(engine, ...)
async def test_square_sweep_still_makes_exactly_one_list_call(engine, ...)   # regression
async def test_stripe_sweep_survives_one_row_raising(engine, ...)
async def test_24h_abandon_ttl_still_applies_to_both_processors(engine, ...)
```
`tests/plaza/test_plaza_alerts.py` additions:
```python
async def test_pending_over_70m_fires_for_a_stale_stripe_row(engine)
async def test_pending_over_70m_ignores_square_rows(engine)
async def test_pending_over_10m_still_ignores_stripe_rows(engine)
```
`tests/plaza/test_plaza_summary.py`:
```python
async def test_pending_recent_window_is_60_minutes(engine)   # S26
```

- [ ] **Step 2: Run to verify they fail**

- [ ] **Step 3: Add the constants (S17, S26)**

`services/plaza_sweep.py`:
```python
#: How long a Stripe quote stays payable. The sweep expires the session at this
#: age and writes the row off. Deliberately EQUAL to Stripe's 24h idempotency
#: key scope? No — that is WINDOW_HOURS below. This is our own, shorter TTL,
#: because a Stripe session with no expires_at lives 24h by default (S1) and a
#: link payable for a day is a link payable twice.
STRIPE_QUOTE_TTL_MINUTES = 60
#: Per-row fetches, so the tick's cost is bounded by OUR pending count, never
#: by Frank's volume. §13.8's "no N x GetPayment" is re-ruled for Stripe: N is
#: already flood-capped by quote-and-start's reCAPTCHA + per-IP cap.
STRIPE_SWEEP_BATCH_LIMIT = 50
```
Keep `WINDOW_HOURS = 24` as the shared abandon backstop and add the S17 note there: *"The 24h idempotency-key scope at Stripe and this 24h abandon TTL are deliberately equal. Widen neither alone."*

`routers/plaza_payments.py`: `_PENDING_WINDOW_MINUTES = 15` becomes
```python
#: How long a `pending` row is still "processing" rather than abandoned, and
#: the dashboard's "don't tow" window. ONE constant, cited in both places
#: (S26): a window shorter than the checkout's own life tells Frank a truck is
#: unpaid while its driver is still on the payment page.
_PENDING_WINDOW_MINUTES = 60
```
Import the sweep's TTL rather than duplicating the number if the import is clean; otherwise assert equality in a test.

- [ ] **Step 4: Implement the per-row Stripe sweep**

Split the working-set SELECT by processor. Square's query and its single `list_recent_payments` call are untouched. The Stripe leg:
```sql
    SELECT id, square_order_id, created_at
      FROM public.plaza_payments
     WHERE payment_status = 'pending'
       AND processor = 'stripe'
       AND created_at < now() - make_interval(secs => CAST(:floor AS double precision))
       AND created_at > now() - make_interval(hours => CAST(:window AS int))
       AND square_order_id IS NOT NULL
     ORDER BY created_at
     LIMIT :lim
```
(`:lim` = `STRIPE_SWEEP_BATCH_LIMIT`, `:floor` = `FLOOR_SECONDS`, `:window` = `WINDOW_HOURS`; oldest-first, matching `idx_plaza_payments_status_created`.)

Per row, in this exact order — the ordering is the whole safety argument:
1. `payment = await stripe_plaza.fetch_payment(row["square_order_id"])`
2. if `payment` is not None and COMPLETED → `settle_payment(..., processor="stripe")`, count it, send the receipt SMS on `outcome == "created"` exactly as the Square path does, and **stop** (never expire a session that paid).
3. else if the row is older than `STRIPE_QUOTE_TTL_MINUTES` → `await stripe_plaza.expire_checkout(row["square_order_id"])`, then `UPDATE … SET payment_status='abandoned' WHERE id=:id AND payment_status='pending'`.
4. else leave it pending.

Per-row `try/except` so one row cannot take the batch down; a transport failure bumps the same `_consecutive_square_errors` counter the alerts read (rename its docstring, not the symbol — a rename would break `plaza_alerts.consecutive_square_errors()`).

- [ ] **Step 5: Implement the stale-URL guard (S2b)**

In `_serve_existing` (plaza_payments.py:335-380), **before** re-serving `existing["square_checkout_url"]`:
```python
    if (existing["processor"] == "stripe"
            and existing["created_at"] <= now_utc() - timedelta(minutes=STRIPE_QUOTE_TTL_MINUTES)):
        # The sweep will expire this session; handing its URL back would send
        # the driver to a page that fails at the card step. Write it off here
        # and make them re-quote — the frontend already forgets the key on a
        # 409 and submits a fresh one (S2b).
        await db.execute(text(
            "UPDATE public.plaza_payments SET payment_status='abandoned' "
            "WHERE id=:id AND payment_status='pending'"), {"id": existing["id"]})
        await db.commit()
        raise HTTPException(status_code=409, detail="quote_already_settled:abandoned")
```
Add `pp.created_at` and `pp.processor` to `_QUOTE_BY_KEY_SQL`'s SELECT (Task 2 added `processor`; add `created_at` here).

- [ ] **Step 6: Add the `pending_over_70m` condition**

`services/plaza_alerts.py`:
```python
CONDITIONS = (
    "pending_over_10m",        # Square rows — unchanged until Square is removed
    "pending_over_70m",        # Stripe rows: TTL + 10 means the sweep is not expiring
    ...
)
#: TTL (60) + 10. A Stripe row older than this is an anomaly by construction:
#: the sweep should have expired it at 60 minutes.
STRIPE_PENDING_ALERT_MINUTES = 70
```
`_PENDING_SQL` gains a `:processor` bind and is run twice — once with `processor='square'` at `PENDING_ALERT_MINUTES`, once with `processor='stripe'` at `STRIPE_PENDING_ALERT_MINUTES`. Same `PENDING_WINDOW_HOURS = 24` upper bound both times.

- [ ] **Step 7: Run the suite**

**Done when:**
- 11 sweep tests + 3 alert tests + 1 summary test pass. Full suite: **653 passed, 26 skipped**.
- A Stripe tick makes **zero** `GET /v1/checkout/sessions` (list) calls and exactly one retrieve per pending row.
- A 61-minute unpaid Stripe row ends `abandoned` with `sessions/{id}/expire` called once.
- A 61-minute row that turns out **paid** settles into a pass and is never expired.
- Square's sweep still makes exactly one list call per tick.
- `_PENDING_WINDOW_MINUTES == STRIPE_QUOTE_TTL_MINUTES == 60`, asserted.

- [ ] **Step 8: Commit**

```bash
cd /Users/gabe/lotlogic-backend-pay2park && \
git add services/plaza_sweep.py services/plaza_alerts.py routers/plaza_payments.py tests/plaza/ && \
git commit -m "feat(plaza-stripe): per-row Stripe sweep, 60-min TTL, stale-URL guard, pending_over_70m"
```

---

### Task 8: Reconcile per processor — `(day, processor)` rows and the `any_enabled()` gate

Implements spec §11 and rulings S16, S16b. Task 2 already fixed the upsert's conflict target; this task makes the job actually run once per processor.

**Files:**
- Modify: `lotlogic-backend-pay2park/services/plaza_reconcile.py`
- Test: `lotlogic-backend-pay2park/tests/plaza/test_plaza_reconcile.py` (extend)

**Interfaces:**
- Changes: `reconcile_day(engine, day, *, processor: str) -> dict`; `run_due_reconciliation` loops `PROCESSORS`.

**Existing tests that must gain a Stripe twin (inventory §10):** `tests/plaza/test_plaza_reconcile.py` — the stub fixture (lines 69-73) and the disabled-Square test (line 527). The two raw-SDK pagination tests (lines 538-601) stay pointed at `services.square` and gain a Stripe counterpart already written in Task 3.

- [ ] **Step 1: Write the failing tests**

```python
async def test_cutover_day_writes_one_row_per_processor(engine, fake_stripe, sq_stub):
    """S16b — the day the flag flips has Square money in the morning and
    Stripe money in the afternoon. One row would lose half of it."""
    rows = await rows_for_day(engine, day)
    assert {r["processor"] for r in rows} == {"square", "stripe"}

async def test_ledger_legs_are_filtered_by_processor(engine):
    """Every leg — ledger, ids, refunds, passes — carries AND processor = :processor."""

async def test_reconcile_runs_when_only_stripe_is_configured(engine, monkeypatch):
    """S16 — gating on square_enabled() skipped the cutover day's Stripe half."""
    monkeypatch.setattr(square_adapter, "enabled", lambda: False)
    monkeypatch.setattr(stripe_plaza, "enabled", lambda: True)
    assert (await run_due_reconciliation(engine))["ran"]

async def test_reconcile_does_not_run_when_neither_is_configured(engine, monkeypatch)

async def test_presence_check_is_keyed_by_day_and_processor(engine):
    """S16b — a day with only its Square row must still generate its Stripe row."""

async def test_stripe_leg_counts_only_our_sessions(engine, fake_stripe):
    """Frank's other sales are dropped client-side and never counted."""

async def test_a_processor_api_failure_writes_nothing_for_that_processor_only(engine, ...):
    """One processor down must not suppress the other's row."""
```

- [ ] **Step 2: Run to verify they fail**

- [ ] **Step 3: Thread `processor` through every leg**

Every SQL constant in `services/plaza_reconcile.py` gains `AND processor = :processor` — `_LEDGER_SQL`, `_LEDGER_IDS_SQL`, `_REFUNDS_SQL`, and `_PASSES_SQL` (as `AND pp.processor = :processor`). `_KNOWN_SQUARE_IDS_SQL` stays global by id, deliberately: a capture recorded a minute the other side of midnight is still a capture this ledger knows about, and adding a processor filter there would create false "unmatched" alarms on the cutover day.

`_ROWS_PRESENT_SQL` becomes:
```sql
    SELECT day, processor FROM public.plaza_reconciliations
     WHERE day = ANY(:days) AND processor = :processor
```
and the caller's "which days are missing" set becomes a set of `(day, processor)` pairs (S16b).

`_list_square_payments(start, end, processor)` dispatches through `processor.for_row(name).list_payments_between(...)` and keeps its `RuntimeError`-on-failure contract for both.

- [ ] **Step 4: Loop the processors and swap the gate**

```python
async def run_due_reconciliation(engine) -> dict:
    if not proc.any_enabled():          # S16 — was sq.square_enabled()
        return {"ran": False, "reason": "no_processor_configured"}
    ...
    for name in proc.PROCESSORS:
        if not proc.for_row(name).enabled():
            continue
        for day in missing_days_for(name):
            await reconcile_day(engine, day, processor=name)
```
A failure inside one processor's `reconcile_day` is caught and logged, and the loop continues to the other — one processor being down must never suppress the other's row.

The 25/75 split (`LOTLOGIC_SHARE = 0.25`) is computed per row, per processor, exactly as today. It is the **daily** report; the biweekly invoice figure comes from Task 11's statement, which has its own basis (spec §7) and is not expected to sum to this.

- [ ] **Step 5: Run the suite**

**Done when:**
- 7 new reconcile tests pass. Full suite: **660 passed, 26 skipped**.
- The cutover day produces `(day,'square')` and `(day,'stripe')`, both `ok`.
- Reconcile runs with Square disabled and Stripe configured.
- Every money leg is processor-filtered; `_KNOWN_SQUARE_IDS_SQL` deliberately is not (assert the comment survives).

- [ ] **Step 6: Commit**

```bash
cd /Users/gabe/lotlogic-backend-pay2park && \
git add services/plaza_reconcile.py tests/plaza/test_plaza_reconcile.py && \
git commit -m "feat(plaza-stripe): reconcile per processor with (day, processor) rows"
```

---

### Task 9: Admin refund endpoint — dispatch by row and the Stripe accepted states

Implements spec §5.4 and ruling S11. Task 1 already dispatched the call; this task fixes the **accepted-state set**, which is different for Stripe and currently would 502 a perfectly good refund.

**Files:**
- Modify: `lotlogic-backend-pay2park/routers/plaza_payments.py`
- Test: `lotlogic-backend-pay2park/tests/plaza/test_plaza_refund.py` (extend)

**Interfaces:**
- Adds `needs_manual_review` value `refund_requires_action`.

**Existing tests that must gain a Stripe twin (inventory §10):** `tests/plaza/test_plaza_refund.py` — the `RefundStub` fixture (lines 78-112) gets a Stripe twin patching `stripe_plaza.refund_payment`; every existing assertion is duplicated for a `processor='stripe'` row.

- [ ] **Step 1: Write the failing tests**

```python
async def test_stripe_refund_succeeded_marks_refunded_and_cancels_the_pass(...)
async def test_stripe_refund_pending_is_accepted(...)
async def test_stripe_refund_requires_action_is_accepted_and_flagged(...):
    """S11 — REQUIRES_ACTION is not a failure; it is a refund that needs a
    human at Stripe. Ledger written, needs_manual_review='refund_requires_action'."""
async def test_stripe_refund_failed_is_502_and_leaves_the_ledger_untouched(...)
async def test_stripe_refund_canceled_is_502_and_leaves_the_ledger_untouched(...)
async def test_square_refund_accepted_states_are_unchanged(...):
    """Regression: Square still accepts exactly {PENDING, COMPLETED}."""
async def test_refund_uses_the_rows_processor_not_the_current_one(monkeypatch, ...):
    """A Square row refunds through Square even after PLAZA_PROCESSOR=stripe."""
```

- [ ] **Step 2: Run to verify they fail**

- [ ] **Step 3: Make the accepted states per-processor**

Replace the single frozenset (plaza_payments.py:973) with a map:
```python
#: A 200 from a processor is not the same as a refund (R36). Each processor has
#: its own vocabulary for "the money is on its way back".
_REFUND_ACCEPTED_STATES: dict[str, frozenset[str]] = {
    "square": frozenset({"PENDING", "COMPLETED"}),
    # S11 — Stripe's REQUIRES_ACTION means the refund needs a step at Stripe,
    # not that it failed. Treating it as a failure left the driver's money in
    # limbo with our ledger claiming nothing happened.
    "stripe": frozenset({"PENDING", "REQUIRES_ACTION", "SUCCEEDED"}),
}
#: Accepted, but a human must finish it.
_REFUND_REVIEW_STATES = frozenset({"REQUIRES_ACTION"})
```
The check at plaza_payments.py:1075 becomes `if refund_status not in _REFUND_ACCEPTED_STATES[row_processor]:` → 502 `refund_failed`, ledger untouched (unchanged behaviour otherwise).

When `refund_status in _REFUND_REVIEW_STATES`, `_MARK_REFUNDED_SQL` additionally sets `needs_manual_review = 'refund_requires_action'`. Add it as an extra bind rather than a second UPDATE, so the ledger write stays one statement inside one transaction.

- [ ] **Step 4: Run the suite**

**Done when:**
- 7 new refund tests pass. Full suite: **667 passed, 26 skipped**.
- `REQUIRES_ACTION` writes the ledger **and** the review flag.
- `FAILED`/`CANCELED` → 502, `payment_status` still `paid`, pass still active.
- A `processor='square'` row still refunds through Square with the old state set, whatever `PLAZA_PROCESSOR` says.

- [ ] **Step 5: Commit**

```bash
cd /Users/gabe/lotlogic-backend-pay2park && \
git add routers/plaza_payments.py tests/plaza/test_plaza_refund.py && \
git commit -m "feat(plaza-stripe): per-processor refund accepted states, refund_requires_action"
```

---

### Task 10: `quote-and-start` — Stripe fail-closed gates and the `already_parked` refusal

Implements spec §2 (fail-closed rules), §8 (`already_parked`) and rulings S5, S31.

**Files:**
- Modify: `lotlogic-backend-pay2park/routers/plaza_payments.py`
- Modify: `lotlogic-backend-pay2park/services/stripe_plaza.py` (boot check helpers)
- Modify: `lotlogic-backend-pay2park/main.py` (boot log + api_version assert)
- Test: `lotlogic-backend-pay2park/tests/plaza/test_plaza_quote_start.py` (extend)

**Interfaces:**
- Produces: 409 `already_parked` with `{"detail": {"reason": "already_parked", "valid_until": "<iso>"}}`.

**Existing tests that must gain a Stripe twin (inventory §10):** `tests/plaza/test_plaza_quote_start.py` — the `create_checkout` fixtures (lines 123-222) and the R49a double-tap race test (line 969) all get `processor='stripe'` twins driven through the fake Stripe client.

- [ ] **Step 1: Write the failing tests**

```python
async def test_stripe_quote_stamps_processor_stripe(app_client, monkeypatch, fake_stripe)
async def test_stripe_quote_returns_the_session_url(app_client, fake_stripe)
async def test_double_tap_one_key_mints_one_session(app_client, fake_stripe):
    """R49a under Stripe: the ROW LOCK is the guard, not the idempotency key."""
async def test_retry_after_a_create_failure_returns_the_same_session(app_client, fake_stripe):
    """S1 — same key, identical params, so Stripe replays rather than erroring."""
async def test_production_with_no_stripe_key_is_503(app_client, monkeypatch)
async def test_production_with_a_test_key_is_503(app_client, monkeypatch):
    """S5 — a test key in production mints free passes. Refuse, loudly."""
async def test_non_production_with_a_test_key_quotes_normally(app_client, monkeypatch)
async def test_already_parked_returns_409_with_valid_until(app_client, paid_payment):
    """S31 — a second phone / private tab must not produce a second charge."""
    assert r.status_code == 409
    assert r.json()["detail"]["reason"] == "already_parked"
    assert r.json()["detail"]["valid_until"]
async def test_already_parked_only_matches_the_same_property_and_plate(...)
async def test_already_parked_ignores_expired_and_cancelled_passes(...)
async def test_already_parked_ignores_a_pending_unpaid_quote(...):
    """Only an ACTIVE PAID pass refuses. A pending quote is the R6 retry path."""
async def test_already_parked_uses_the_normalized_plate(...)
async def test_square_quote_path_is_unchanged(app_client, sq_stub)   # regression
```

- [ ] **Step 2: Add the production fail-closed gates (spec §2, S5)**

Extend the existing gate at plaza_payments.py:445:
```python
    current = proc.current()
    adapter = proc.for_row(current)
    if sq.is_production() and not adapter.enabled():
        log.error("plaza quote-and-start refused: production with no %s credentials", current)
        raise HTTPException(status_code=503, detail="payments_unavailable")
    if current == "stripe" and sq.is_production() and stripe_plaza.is_test_key():
        # S5 — a test key in production takes no money and would mint free
        # passes for every driver until someone noticed the Stripe dashboard
        # was empty.
        log.critical("plaza quote-and-start refused: PRODUCTION with a Stripe TEST key")
        raise HTTPException(status_code=503, detail="payments_unavailable")
```
`sq.is_production()` (i.e. `SQUARE_ENVIRONMENT == 'production'`) stays the plaza's single notion of "production" — see the Ambiguities section at the end of this plan. `stripe_plaza.is_production()` delegates to it, so there is one answer, not two.

At boot, in `main.py`'s lifespan, log and assert (spec §2):
```python
    from stripe._api_version import _ApiVersion
    import stripe as _stripe
    log.info("plaza stripe: library=%s api_version=%s processor=%s",
             _stripe.VERSION, _ApiVersion.CURRENT, proc.current())
    if proc.current() == "stripe" and stripe_plaza.is_test_key() and sq.is_production():
        log.critical("plaza stripe: PRODUCTION is configured with a TEST key — "
                     "quote-and-start will refuse every request")
```
The boot log is the only place the version pair is visible before a driver hits the page; it is what the runbook's step 2 verification reads.

- [ ] **Step 3: Implement `already_parked` (S31)**

Placed with the other pre-payment refusals (plate hold, cooldown), **before** any row is written and before any processor call — the whole point is that no money moves:
```sql
    SELECT vp.valid_until
      FROM public.visitor_passes vp
      JOIN public.plaza_payments pp ON pp.pass_id = vp.id
     WHERE vp.property_id = :pid
       AND vp.normalized_plate = :plate
       AND vp.status = 'active'
       AND vp.valid_until > now()
       AND pp.payment_status = 'paid'
     ORDER BY vp.valid_until DESC
     LIMIT 1
```
```python
    if parked is not None:
        raise HTTPException(status_code=409, detail={
            "reason": "already_parked",
            "valid_until": parked["valid_until"].isoformat(),
        })
```
Use the same plate normalization the rest of the router uses (whatever `plate` already holds at that point — do **not** introduce a second normalizer). Only an **active paid** pass refuses: an unpaid/pending quote must still fall through to the R6 recovery path, and a cancelled or expired pass is not parked.

This replaces the paid→paid TOW-flag path **for the same plate at the same property only**. Different-plate re-registration rules are untouched: do not go near `services/pass_finalize.py`.

- [ ] **Step 4: Run the suite**

**Done when:**
- 13 new quote-start tests pass. Full suite: **680 passed, 26 skipped**.
- Production + no key → 503; production + `rk_test_` → 503 + a CRITICAL log line.
- The same idempotency key after a create failure returns the **same** session (no `IdempotencyError`).
- A plate with an active paid pass gets 409 `already_parked` and **no** `plaza_payments` row is written.
- The Square quote path is byte-identical in behaviour.

- [ ] **Step 5: Commit**

```bash
cd /Users/gabe/lotlogic-backend-pay2park && \
git add routers/plaza_payments.py services/stripe_plaza.py main.py tests/plaza/test_plaza_quote_start.py && \
git commit -m "feat(plaza-stripe): fail-closed Stripe gates and already_parked refusal"
```

---

### Task 11: `plaza_statements` — migration and the statement computation

Implements spec §7 (table, period, basis) and rulings S27, S28, S29. Computation only; the loop, the email and the API are Task 12.

**Files:**
- Create: `lotlogic-backend-pay2park/migrations/20260903000020_plaza_statements.sql`
- Create: `lotlogic-backend-pay2park/services/plaza_statement.py`
- Test: `lotlogic-backend-pay2park/tests/plaza/test_plaza_statement.py` (new)
- Modify: `lotlogic-backend-pay2park/tests/plaza/test_migrations.py` (extend)

**Interfaces:**
- Produces: `period_bounds(n: int) -> tuple[date, date]`, `period_instants(start: date, end: date) -> tuple[datetime, datetime]`, `compute_statement(conn, *, property_id, period_start, period_end) -> dict`.

**Existing tests that must gain a Stripe twin:** none — this is new surface. But the statement must count **both** processors (there is no processor column, S27), so every test seeds a mix of `square` and `stripe` rows and asserts the per-processor split lands in `details`.

- [ ] **Step 1: Write the migration**

`migrations/20260903000020_plaza_statements.sql` — the columns exactly as spec §7 lists them:
```sql
CREATE TABLE IF NOT EXISTS public.plaza_statements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     uuid NOT NULL REFERENCES public.properties(id),
  period_start    date NOT NULL,
  period_end      date NOT NULL,          -- exclusive
  gross_cents     int  NOT NULL,
  refunded_cents  int  NOT NULL,
  excluded_cents  int  NOT NULL,
  net_cents       int  NOT NULL,
  fee_bps         int  NOT NULL DEFAULT 2500,
  fee_cents       int  NOT NULL,
  payment_count   int  NOT NULL,
  refund_count    int  NOT NULL,
  excluded_count  int  NOT NULL,
  details         jsonb NOT NULL DEFAULT '{}',
  generated_at    timestamptz NOT NULL DEFAULT now(),
  emailed_at      timestamptz,
  email_error     text,
  CONSTRAINT uq_plaza_statements_period UNIQUE (property_id, period_start)
);

ALTER TABLE public.plaza_statements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.plaza_statements FROM anon, authenticated;

COMMENT ON TABLE public.plaza_statements IS 'Biweekly 25% invoice basis. One row per property per period, both processors together (S27) — the per-processor split lives in details.';
COMMENT ON COLUMN public.plaza_statements.period_end IS 'EXCLUSIVE. Period N = anchor 2026-08-31 + 14N days, computed in America/New_York (S28).';
```
`ENABLE RLS` **and** `REVOKE` for the same reason as `plaza_payments`: this is revenue data.

- [ ] **Step 2: Write the failing tests**

`tests/plaza/test_plaza_statement.py`:
```python
def test_period_zero_is_aug31_to_sep14():
    assert period_bounds(0) == (date(2026, 8, 31), date(2026, 9, 14))

def test_periods_are_14_day_mondays():
    for n in range(6):
        s, e = period_bounds(n)
        assert s.weekday() == 0 and (e - s).days == 14

def test_period_four_crosses_dst_without_shifting(  ):
    """S28 — Oct 26 – Nov 9 2026 spans the DST end. Date arithmetic in ET then
    converted to instants gives 04:00Z and 05:00Z; timedelta on UTC instants
    would give 04:00Z for both and lose an hour of the last day."""
    s, e = period_bounds(4)
    assert (s, e) == (date(2026, 10, 26), date(2026, 11, 9))
    si, ei = period_instants(s, e)
    assert si.isoformat() == "2026-10-26T04:00:00+00:00"
    assert ei.isoformat() == "2026-11-09T05:00:00+00:00"

async def test_gross_counts_paid_and_refunded_rows(db_conn, seed_truck_plaza):
    """S29 — a same-period refund is counted once in gross and subtracted once
    below, so it nets to zero. Excluding it from gross would net it to -amount."""

async def test_same_period_refund_nets_to_zero(db_conn, seed_truck_plaza):
    st = await compute_statement(...)
    assert st["gross_cents"] == 2500 and st["refunded_cents"] == 2500
    assert st["net_cents"] == 0 and st["fee_cents"] == 0

async def test_prior_period_refund_is_a_credit_line(db_conn, seed_truck_plaza):
    """Refunds are dated by refunded_at REGARDLESS of paid_at."""
    assert st["details"]["credits"][0]["plaza_payment_id"] == str(prior_id)
    assert st["net_cents"] == -2500 or st["net_cents"] == gross - 2500

async def test_excluded_rows_are_paid_with_no_pass(db_conn, seed_truck_plaza):
    """Money taken, no service — not billed, listed with a reason."""
    assert st["excluded_count"] == 1
    assert st["details"]["excluded"][0]["reason"]

async def test_fee_is_25_percent_of_net_rounded(db_conn, seed_truck_plaza):
    assert st["fee_bps"] == 2500
    assert st["fee_cents"] == round(st["net_cents"] * 0.25)

async def test_details_carry_the_per_processor_split(db_conn, seed_truck_plaza):
    """S27 — one row per period; the split is data, not a second row."""
    assert st["details"]["by_processor"] == {"square": {...}, "stripe": {...}}

async def test_details_carry_per_tier_counts_and_payment_ids(db_conn, seed_truck_plaza)

async def test_statement_is_unique_per_property_and_period(db_conn, seed_truck_plaza)
```
Plus a `test_migrations.py` addition asserting RLS + the UNIQUE constraint.

- [ ] **Step 3: Run to verify they fail**

- [ ] **Step 4: Implement `services/plaza_statement.py`**

Constants, verbatim from spec §7:
```python
#: Period 0 starts here. A Monday, chosen with Gabe.
ANCHOR = date(2026, 8, 31)
PERIOD_DAYS = 14
FEE_BPS = 2500
LOT_TZ = ZoneInfo("America/New_York")
#: The hour, local, after which an ended period is generated.
GENERATE_AFTER_LOCAL = time(7, 0)
```
`period_bounds(n)` is **date arithmetic**: `ANCHOR + timedelta(days=PERIOD_DAYS * n)` on `date` objects, never on aware instants (S28). `period_instants(start, end)` converts each date to `datetime(..., tzinfo=LOT_TZ)` and then to UTC — that is the only place a timezone is applied, and it is what makes period 4's two bounds 04:00Z and 05:00Z.

The three basis predicates, exactly as spec §7 states them (S29):
```sql
-- gross: money taken IN the period. A refunded row is counted here too, and
-- subtracted below, so a same-period refund nets to zero exactly once.
SELECT count(*) AS n, COALESCE(sum(amount_cents), 0) AS cents
  FROM public.plaza_payments
 WHERE property_id = :pid
   AND payment_status IN ('paid','refunded')
   AND paid_at >= :start AND paid_at < :end

-- refunded: dated by refunded_at REGARDLESS of paid_at. A refund or a lost
-- dispute against a prior period appears here as a CREDIT LINE.
SELECT count(*) AS n, COALESCE(sum(COALESCE(refund_amount_cents, amount_cents)), 0) AS cents
  FROM public.plaza_payments
 WHERE property_id = :pid
   AND refunded_at >= :start AND refunded_at < :end

-- excluded: money taken, no service. Not billed; listed with reasons.
SELECT count(*) AS n, COALESCE(sum(amount_cents), 0) AS cents
  FROM public.plaza_payments
 WHERE property_id = :pid
   AND payment_status = 'paid'
   AND pass_id IS NULL
   AND paid_at >= :start AND paid_at < :end
```
`net = gross − refunded − excluded`; `fee = round(net * 0.25)`. Processor fees are Frank's cost and are **not** deducted (stated to Gabe in spec §12).

`details` carries: `payment_ids`, `by_tier` (`{10: n, 24: n, 48: n}`), `by_processor` (`{"square": {...}, "stripe": {...}}` — S27), `excluded` (ids + reasons), `credits` (prior-period refunds: id, `paid_at`, `refunded_at`, amount). Ids and amounts only — **no plate, phone or company name** in the row or the email body (the parent rollout doc's PII rule).

Write a module docstring stating: *"The daily reconcile dates refunds by `paid_at` (a capture-day check); this statement dates them by `refunded_at` (an invoice). The two are not expected to sum, and neither is wrong."* (S29.)

- [ ] **Step 5: Run the suite**

**Done when:**
- 11 statement tests + 2 migration tests pass. Full suite: **693 passed, 26 skipped**.
- Period 4's instants are `2026-10-26T04:00:00+00:00` / `2026-11-09T05:00:00+00:00`.
- A same-period refund nets to 0; a prior-period refund is a credit line.
- `details.by_processor` splits a mixed period.
- No PII anywhere in a computed statement.

- [ ] **Step 6: Commit**

```bash
cd /Users/gabe/lotlogic-backend-pay2park && \
git add migrations/20260903000020_plaza_statements.sql services/plaza_statement.py tests/plaza/test_plaza_statement.py tests/plaza/test_migrations.py && \
git commit -m "feat(plaza-stripe): plaza_statements table and biweekly 25% statement computation"
```

---

### Task 12: Statement generation loop, email, CSV and admin API

Implements the rest of spec §7 and ruling S30.

**Files:**
- Modify: `lotlogic-backend-pay2park/services/plaza_statement.py`
- Modify: `lotlogic-backend-pay2park/main.py` (supervised loop)
- Modify: `lotlogic-backend-pay2park/routers/plaza_payments.py` (admin API)
- Modify: `lotlogic-backend-pay2park/services/plaza_alerts.py` (`statement_unemailed`)
- Test: `lotlogic-backend-pay2park/tests/plaza/test_plaza_statement_loop.py` (new)

**Interfaces:**
- Produces: `run_due_statements(engine) -> dict`; `GET /plaza/statements?property_id=`, `GET /plaza/statements/{id}`, `GET /plaza/statements/{id}.csv` — all behind `require_human_platform_admin`.
- Config: `PLAZA_STATEMENT_EMAIL_TO`, default `billing@lotlogicparking.com`.

**Existing tests that must gain a Stripe twin:** none. `tests/plaza/test_plaza_alerts.py` gains the `statement_unemailed` condition.

- [ ] **Step 1: Write the failing tests**

```python
async def test_generates_one_row_per_ended_period(engine)
async def test_does_not_generate_before_0700_local(engine, frozen_clock)
async def test_does_not_generate_a_period_that_has_not_ended(engine, frozen_clock)
async def test_is_idempotent_across_ticks(engine):
    """UNIQUE (property_id, period_start) plus a re-check — never two invoices."""
async def test_computes_and_inserts_in_one_transaction(engine)
async def test_emails_after_insert_and_stamps_emailed_at(engine, sendgrid_spy)
async def test_email_failure_records_email_error_and_retries_next_tick(engine, sendgrid_spy)
async def test_statement_unemailed_alert_fires_one_hour_after_generated_at(engine):
    """S30 — an un-emailed statement is invisible; nobody invoices Frank."""
async def test_subject_line_names_the_period_and_the_amount(engine, sendgrid_spy):
    assert subject == "Plaza statement Aug 31–Sep 13: invoice Frank $X"
async def test_email_body_lists_excluded_and_credit_lines(engine, sendgrid_spy)
async def test_email_carries_a_csv_attachment(engine, sendgrid_spy)
async def test_admin_api_requires_a_human_platform_admin(app_client)
async def test_admin_api_rejects_the_service_api_key(app_client)
async def test_admin_list_filters_by_property(app_client)
async def test_admin_csv_columns_match_the_header(app_client):
    """Positional CSV: header and values edited in lockstep or the export right-shifts."""
async def test_there_is_no_regenerate_endpoint(app_client):
    """Corrections are a new row via SQL + a ledger note, never a silent rewrite."""
```

- [ ] **Step 2: Implement `run_due_statements`**

Same shape as `run_due_reconciliation`: for every period whose `period_end` has passed and whose local time is at or after 07:00 ET, and which has no row for the property, compute + insert **in one transaction**, then email. Email failure writes `email_error` and leaves `emailed_at` NULL; the next tick retries the email without recomputing (a recompute after a correction would silently change an invoice already sent).

Subject: `Plaza statement Aug 31–Sep 13: invoice Frank $X` — the dates are the **inclusive** human range (`period_end - 1 day`), the amount is `fee_cents / 100`. Body: totals table + excluded lines + credit lines. CSV attached. From `dispatch@` via SendGrid, to `PLAZA_STATEMENT_EMAIL_TO` (default `billing@lotlogicparking.com`), reusing `services/email.py`.

Register it in `main.py` as a fourth supervised loop next to the other three, 300s interval, **ungated** — like the others, "money already taken still has to be invoiced after the flag is turned off":
```python
    plaza_statement_task = asyncio.create_task(
        supervised("plaza_statement", _plaza_statement_loop))
```
and cancel it in the shutdown block alongside the other three.

- [ ] **Step 3: Add the `statement_unemailed` alert (S30)**

`services/plaza_alerts.py` `CONDITIONS` gains `"statement_unemailed"`, backed by:
```sql
    SELECT count(*) AS n
      FROM public.plaza_statements
     WHERE emailed_at IS NULL
       AND generated_at <= now() - interval '1 hour'
```

- [ ] **Step 4: Implement the admin API**

Three endpoints on the existing router, all `Depends(require_human_platform_admin)` (R46 — rejects the service `X-API-Key`, human JWT only), all read-only. **No regenerate endpoint** (spec §7). The `.csv` route builds its header and its value row in the same function, adjacent, with a comment saying they are positional.

Do **not** add these to `main.py`'s `PUBLIC_PATHS`. Confirm the existing `/plaza/payments/*/status` prefix rule cannot match `/plaza/statements/*` (it cannot — it requires the `/plaza/payments/` prefix and a `/status` suffix), and add a test that asserts it.

- [ ] **Step 5: Run the suite**

**Done when:**
- 16 new tests pass. Full suite: **709 passed, 26 skipped**.
- A generated statement is emailed and `emailed_at` stamped; a send failure retries without recomputing.
- `statement_unemailed` fires an hour after `generated_at`.
- The admin endpoints 403 for a service key and for an owner/partner JWT.
- Four supervised loops start and stop cleanly.

- [ ] **Step 6: Commit**

```bash
cd /Users/gabe/lotlogic-backend-pay2park && \
git add services/plaza_statement.py services/plaza_alerts.py routers/plaza_payments.py main.py tests/plaza/test_plaza_statement_loop.py && \
git commit -m "feat(plaza-stripe): biweekly statement loop, email, CSV and admin API"
```

---

### Task 13: Frontend — cancel return, `already_parked`, copy, Playwright

Implements spec §8 and rulings S2, S31. **Worktree: `/Users/gabe/lotlogic-pay2park`.**

**Files:**
- Modify: `lotlogic-pay2park/frontend/visit.html`
- Modify: `lotlogic-pay2park/tests/e2e/pay2park-visit.spec.ts`
- (Read-only check) `lotlogic-pay2park/frontend/dashboard.html` — the spec says the dashboard is unchanged; confirm and do not edit.

**Interfaces:**
- Consumes: `POST /plaza/quote-and-start` (409 `already_parked`), `GET /plaza/payments/{id}/status`, the `?checkout=cancel` return param.

**Existing tests that must gain a Stripe twin:** `tests/e2e/pay2park-visit.spec.ts` (17 tests today) gains three rows; `pay2park-dashboard.spec.ts` (16 tests) is untouched apart from the receipt-link check below.

- [ ] **Step 1: Write the failing Playwright rows**

In `tests/e2e/pay2park-visit.spec.ts`:
```ts
test('cancel return renders NOT registered and never the paid copy', async ({ page }) => {
  // ?checkout=cancel with the row still pending (S2)
  await expect(page.getByText(/You did not complete payment/i)).toBeVisible();
  await expect(page.getByText(/not\s+registered/i)).toBeVisible();
  await expect(page.getByText(/Payment received/i)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Try again/i })).toBeVisible();
});

test('Try again re-submits the same form and reuses the same key', async ({ page }) => {
  // same idempotency key => same session URL while it lives
});

test('already_parked shows the plate-has-a-pass message with the time', async ({ page }) => {
  // 409 { reason: 'already_parked', valid_until }
  await expect(page.getByText(/This plate already has a parking pass until/i)).toBeVisible();
});
```

- [ ] **Step 2: Implement the cancel path (S2)**

`handlePlazaReturn` (visit.html:1202) currently runs for any `plaza_payment_id`. Branch first on `checkout=cancel`:
```javascript
const params = new URLSearchParams(window.location.search);
const plazaPaymentId = params.get('plaza_payment_id');
const cancelled = params.get('checkout') === 'cancel';
```
On `cancelled` **and** a status still `pending`, render:
> "You did not complete payment. Your truck is **not** registered."

with a **Try again** button that re-submits the same form. The key is still in `sessionStorage`, so the same idempotency key produces the same session URL while it lives; if the backend answers 409 `quote_already_settled:abandoned` (the Task 7 stale-URL guard), clear the key and re-quote — `plazaClearIdempotencyKeys()` already exists for this.

**The "Payment received — your parking pass is being activated" copy (visit.html:1231) must never render on the cancel path.** Guard it explicitly, not by ordering.

If the status is already `paid`/`pass_active` on a cancel return (the driver paid, then hit back), show the normal success — the money is the truth, not the query param.

- [ ] **Step 3: Handle `already_parked` (S31)**

In the submit handler (around visit.html:1121), before the generic error branch:
```javascript
if (res.status === 409 && data && data.detail && data.detail.reason === 'already_parked') {
  showPlazaMessage('This plate already has a parking pass until ' +
                   fmtLocalTime(data.detail.valid_until) + '.');
  return;
}
```
No retry button — a second pass for the same plate is exactly what this refuses.

- [ ] **Step 4: Update the copy that names Square (spec §8)**

visit.html:1232 — replace *"Square will also email or text you a receipt if you entered your contact info at checkout"* with:
> "Stripe emails your receipt to the address you enter at checkout."

Sweep the file for every other user-visible "Square" string; code comments naming Square (lines 948, 960, 980, 1016, 1094, 1177) may stay as history but must not contradict — update any that describe current behaviour. **The user-facing naming rule still applies: the only user-facing term for the thing being bought is "parking pass".**

- [ ] **Step 5: Confirm the dashboard needs no change**

`dashboard.html:10621-10623` renders `r.square_receipt_url` as an outbound receipt link. The column keeps its name (S13) and now holds `charge.receipt_url` for Stripe rows, so the link keeps working with **zero** frontend change. Verify by eye and by running `pay2park-dashboard.spec.ts` unchanged. Do not rename the field.
The "processing — don't tow" strip (dashboard.html:10256-10271) is driven by `pending_recent`, whose window moved from 15 to 60 minutes in the backend (Task 7); its copy mentions "Square's webhook" — change that phrase to "the payment webhook" and nothing else.

- [ ] **Step 6: Run the frontend suite**

```bash
cd /Users/gabe/lotlogic-pay2park/tests && \
npx playwright test e2e/pay2park-visit.spec.ts e2e/pay2park-dashboard.spec.ts --project=chromium-desktop
```

**Done when:**
- `pay2park-visit.spec.ts`: **20 passed** (17 + 3). `pay2park-dashboard.spec.ts`: **16 passed**, unchanged.
- The cancel path never renders the paid copy — asserted, not eyeballed.
- No user-visible string in `visit.html` says "Square".
- `git diff --stat` shows `dashboard.html` changed by one copy line only.

- [ ] **Step 7: Commit**

```bash
cd /Users/gabe/lotlogic-pay2park && \
git add frontend/visit.html frontend/dashboard.html tests/e2e/pay2park-visit.spec.ts && \
git commit -m "feat(plaza-stripe): cancel return path, already_parked message, Stripe receipt copy"
```

---

### Task 14: The fake-Stripe end-to-end matrix — the gate before any live key

Implements spec §9.2 in full. Every row drives the **real** router, the real settle, the real sweep and the real reconcile against the in-process fake Stripe and the real local Postgres. Nothing here touches the network.

**Files:**
- Create: `lotlogic-backend-pay2park/tests/plaza/test_stripe_matrix.py`
- Modify: `lotlogic-backend-pay2park/tests/plaza/stripe_fake.py` (whatever the matrix needs that Task 3 did not)
- Modify: `lotlogic-backend-pay2park/tests/plaza/conftest.py` (matrix fixtures)

**Existing tests that must gain a Stripe twin (inventory §10):** this file **is** the Stripe twin of `tests/plaza/sandbox/test_sandbox_matrix.py`'s 24 rows — but it runs in CI, unskipped, because the fake needs no tunnel and no account.

- [ ] **Step 1: Write the matrix — one test per row, named for the row**

The rows, taken verbatim from spec §9.2. Every one is a `test_` function in this file:

| # | Row | Expected |
|---|---|---|
| 1 | happy 10h | one pass, `$15`, `valid_until = paid_at + 10h`, `processor='stripe'` |
| 2 | happy 24h | one pass, `$25`, `+24h` |
| 3 | happy 48h | one pass, `$40`, `+48h` |
| 4 | decline | no pass, row not `paid` |
| 5 | double-tap one link | one session, one charge, one pass (R49a under the row lock) |
| 6 | redelivered webhook | exactly one pass, second delivery `already_settled` |
| 7 | both events, order A (`session.completed` then `pi.succeeded`) | one pass |
| 8 | both events, order B (`pi.succeeded` then `session.completed`) | one pass |
| 9 | async `processing` capture | **no pass**, `rejected_not_completed` (S6) |
| 10 | pay after expire | Stripe refuses; row stays `abandoned`, no pass |
| 11 | refund via endpoint — `succeeded` | row `refunded`, pass cancelled |
| 12 | refund via endpoint — `pending` | accepted, ledger written |
| 13 | refund via endpoint — `requires_action` | accepted + `needs_manual_review='refund_requires_action'` (S11) |
| 14 | refund later `failed` | revert to `paid`, `needs_manual_review='refund_failed'`, alert, pass stays cancelled (S11) |
| 15 | dashboard refund | `refunded_by='stripe:dashboard'`, pass cancelled, alert `external_refund` |
| 16 | dispute created | alert `dispute`, no ledger write |
| 17 | dispute closed `lost` | `refunded_by='stripe:dispute'`, pass cancelled, alert `dispute_lost` (S25) |
| 18 | foreign session in the account | 200 `not_ours`, **no alert** (S15) |
| 19 | note recovery **without** ownership | not adopted (S24) |
| 20 | note recovery **with** ownership | adopted, one pass |
| 21 | `amount_captured` < `amount_total` | manual review, no pass (S3) |
| 22 | currency ≠ USD | manual review, no pass (S4) |
| 23 | `expired` event | row `abandoned`, no fetch issued |
| 24 | sweep settles a missed webhook | pass created by the sweep |
| 25 | sweep expires a 61-min row | `abandoned`, `expire` called once |
| 26 | stale-URL guard | 409 `quote_already_settled:abandoned` on re-serve (S2b) |
| 27 | quote retry after a create failure | same key → same session, no second charge (S1) |
| 28 | cancel return | not-registered copy path exercised via the status endpoint |
| 29 | `already_parked` | 409, no row written (S31) |
| 30 | reconcile day with both processors | `(day,'square')` + `(day,'stripe')`, both `ok` (S16b) |
| 31 | statement: same-period refund | net 0 (S29) |
| 32 | statement: prior-period credit | credit line present (S29) |
| 33 | statement: excluded manual-review row | excluded, not billed |
| 34 | statement: period-4 DST bounds | 04:00Z / 05:00Z (S28) |
| 35 | `livemode=False` in production | `ownership_mismatch`, no pass (S5) |

- [ ] **Step 2: Run the matrix**

```bash
cd /Users/gabe/lotlogic-backend-pay2park && .venv/bin/pytest tests/plaza/test_stripe_matrix.py -q
```

- [ ] **Step 3: Run the whole suite and the invariant sweep**

After the matrix, assert the same DB invariants the parent plan's Task 12 Step 3 asserts, now processor-aware:
```sql
-- every paid row has exactly one pass, or a review reason
SELECT count(*) FROM plaza_payments
 WHERE payment_status='paid' AND pass_id IS NULL AND needs_manual_review IS NULL;  -- 0
-- no qr_paid pass without its payment
SELECT count(*) FROM visitor_passes vp
 WHERE vp.registration_source='qr_paid' AND vp.plaza_payment_id IS NULL;           -- 0
-- no duplicate passes per payment
SELECT pass_id, count(*) FROM plaza_payments WHERE pass_id IS NOT NULL
 GROUP BY pass_id HAVING count(*) > 1;                                              -- 0 rows
-- every row carries a processor we can service
SELECT count(*) FROM plaza_payments WHERE processor NOT IN ('square','stripe');    -- 0
-- no Stripe row is being serviced by Square, or vice versa
SELECT count(*) FROM plaza_payments
 WHERE processor='stripe' AND square_order_id IS NOT NULL
   AND square_order_id NOT LIKE 'cs_%';                                             -- 0
```

**Done when:**
- All 35 matrix rows pass. Full suite: **744 passed, 26 skipped**.
- Every invariant query returns 0.
- The matrix runs with no network access (unplug wifi and re-run once to prove it).

- [ ] **Step 4: Commit**

```bash
cd /Users/gabe/lotlogic-backend-pay2park && \
git add tests/plaza/test_stripe_matrix.py tests/plaza/stripe_fake.py tests/plaza/conftest.py && \
git commit -m "test(plaza-stripe): 35-row fake-Stripe end-to-end matrix"
```

---

### Task 15: Live test-mode matrix harness (skipped without env)

Implements spec §9.3. **This task writes a harness and runs nothing against Stripe.** A human with a `rk_test_…` key runs it later; green here gates the live cutover.

**Files:**
- Create: `lotlogic-backend-pay2park/tests/plaza/stripe_live/__init__.py`
- Create: `lotlogic-backend-pay2park/tests/plaza/stripe_live/test_stripe_test_mode_matrix.py`
- Create: `lotlogic-backend-pay2park/scripts/pay2park-stripe-test.sh`

**Existing tests that must gain a Stripe twin (inventory §10):** `tests/plaza/sandbox/test_sandbox_matrix.py` — this is its Stripe counterpart. Model the skip guard, the results-json append and the `test_zz*` invariant/summary tails on that file; do not delete or edit the Square sandbox file, which stays as the record of the Square rollout.

- [ ] **Step 1: Skip guard first**

```python
pytestmark = pytest.mark.skipif(
    os.getenv("PAY2PARK_STRIPE_TEST") != "1",
    reason="live Stripe test-mode matrix — needs rk_test_ credentials and a running stack",
)
```
Every test must skip in CI. Verify with `.venv/bin/pytest tests/ -q` showing the new tests as **skipped**, never errored at collection (no module-level SDK calls, no module-level env reads that raise).

- [ ] **Step 2: The rows (spec §9.3)**

- Playwright against the **real hosted Checkout** with Stripe test cards: `4242 4242 4242 4242` (success), `4000 0000 0000 0002` (decline), `4000 0025 0000 3155` (3DS), and cancel via the page's own back link.
- Webhooks reach the backend under test by the test pulling `events.list` and POSTing each event to itself with a **locally computed** signature (`stripe.WebhookSignature.generate_signature_header`) — no tunnel required.
- **Assert a swept session yields a non-null `receipt_url`** (S33 — this is the row that catches a wrong `expand` prefix, which the fake cannot catch because the fake honours whatever prefix it is given).
- Assert `processor='stripe'` on every row created, and `livemode is False` on every shaped payment.

- [ ] **Step 3: The runner script**

`scripts/pay2park-stripe-test.sh` — mirrors `scripts/pay2park-sandbox.sh`'s `up`/`down` shape: reads `rk_test_…` from `.env.local` (mode 600, **never committed** — add `.env.local` to `.gitignore` if it is not already), boots uvicorn + the static server, exports `PAY2PARK_STRIPE_TEST=1`, and prints the pytest command. It must refuse to start if the key does not begin `rk_test_`/`sk_test_`.

**Done when:**
- Full suite: **744 passed, 26 + 18 = 44 skipped** — every new row skipped, none errored.
- `grep -rn "rk_live\|sk_live" tests/ scripts/` → nothing.
- `scripts/pay2park-stripe-test.sh` refuses a live key.
- The file's docstring states plainly: *green here gates the live cutover; nobody flips `PLAZA_PROCESSOR` without it.*

- [ ] **Step 4: Commit**

```bash
cd /Users/gabe/lotlogic-backend-pay2park && \
git add tests/plaza/stripe_live/ scripts/pay2park-stripe-test.sh .gitignore && \
git commit -m "test(plaza-stripe): live test-mode matrix harness (skipped without PAY2PARK_STRIPE_TEST)"
```

---

### Task 16: Cutover runbook, watcher update, monitoring docs

Implements spec §10 and §11 and ruling S34. **Documents and a shell-script prompt — no deploys, no env changes, no migrations applied.** A human runs every step in the runbook.

**Files:**
- Modify: `lotlogic-backend-pay2park/docs/pay2park-rollout.md` (new §11)
- Modify: `/Users/gabe/lotlogic-agent/pay2park/payment-watch.sh`
- Modify: `/Users/gabe/lotlogic-agent/pay2park/CHARTER.md`

- [ ] **Step 1: Write `docs/pay2park-rollout.md` §11 — the cutover runbook**

Six steps, verbatim from spec §10, plus the pre-reqs (Frank's account **activated** with payouts enabled; "Successful payments" customer emails on; the restricted live key pasted to Gabe's chat, never committed):

1. **Migration first** (`20260903000010`, `20260903000020`) — additive, defaulted, safe under old code. Apply via Supabase MCP at any time before step 2. Verify `processor` present and the reconciliations PK is `(day, processor)`:
```sql
SELECT column_name FROM information_schema.columns
 WHERE table_name='plaza_payments' AND column_name='processor';
SELECT a.attname FROM pg_index i JOIN pg_attribute a
    ON a.attrelid=i.indrelid AND a.attnum = ANY(i.indkey)
 WHERE i.indrelid='public.plaza_reconciliations'::regclass AND i.indisprimary;
```
2. **Deploy the backend** with `STRIPE_PLAZA_SECRET_KEY` set and `PLAZA_PROCESSOR` **unset** (Square keeps quoting). The route is live and 400s everything (no secret yet). Verify `/health`, one status poll, one sweep tick `errors=0`, dashboard summary 200, and the boot line `plaza stripe: library=15.6.1 api_version=2026-08-26.dahlia processor=square`.
3. **Create the webhook endpoint via API** and save the secret — it is returned **once**; lost = delete and recreate:
```python
ep = await client.v1.webhook_endpoints.create_async({
    "url": "https://<backend>/plaza/stripe/webhook",
    "enabled_events": [
        "checkout.session.completed", "checkout.session.async_payment_succeeded",
        "checkout.session.async_payment_failed", "checkout.session.expired",
        "payment_intent.succeeded", "payment_intent.payment_failed",
        "charge.refunded", "charge.refund.updated",
        "charge.dispute.created", "charge.dispute.closed",
    ],
    "api_version": _ApiVersion.CURRENT,
}, {})
# ep.secret — save to STRIPE_PLAZA_WEBHOOK_SECRET, then Railway redeploy.
```
Send a Stripe test event; expect **200** `not_ours` or `no_session`. A 400 `bad_signature` means the secret is wrong — fix it before going further.
4. **Merge the frontend** (cancel path, `already_parked` copy). **Update the watcher** — Step 2 below.
5. **Quiet hour, pending = 0:** set `PLAZA_PROCESSOR=stripe`. Smoke with Gabe's card: $15 / 10h → pass active, `processor='stripe'`, receipt email arrives → admin refund → `refunded`, pass cancelled, Stripe shows the refund. Start-and-cancel one checkout → cancel copy renders → **Try again** → pay. Start-and-abandon one → row `abandoned` at ~60 min by the sweep.
6. **Next morning:** `plaza_reconciliations` has `(day,'square')` and `(day,'stripe')` rows for the cutover day, both `ok`. Watcher green. Ledger + memory updated.

**Rollback at any step:** `PLAZA_PROCESSOR=square` — new quotes go to Square, Stripe rows keep settling per row. The deploy itself is rollback-safe because the migration is additive with a default (S13/S14).

Also add to §1's env table: `STRIPE_PLAZA_SECRET_KEY`, `STRIPE_PLAZA_WEBHOOK_SECRET`, `PLAZA_PROCESSOR`, `PLAZA_STATEMENT_EMAIL_TO`, and a line saying **`SQUARE_ENVIRONMENT=production` must stay set** — it is the plaza's single "am I in production" marker and Stripe's `livemode` gate reads it (see the Ambiguities section of the plan).

- [ ] **Step 2: Update the watcher (S34)**

`/Users/gabe/lotlogic-agent/pay2park/payment-watch.sh` — the SQL and patterns live inside the `claude -p` prompt string:
- **STEP 1a:** add `processor` to the column list it selects (it already selects every column except the three PII fields, so this is automatic — but say so explicitly in the prompt so the reviewer reports per-processor).
- **STEP 1c:** add the invariants `every row's processor IN ('square','stripe')` and `no row with processor='stripe' whose square_order_id does not start 'cs_'`; change "the latest `plaza_reconciliations` row" to "the latest row **per processor**".
- **STEP 2:** fix the stale price pairing. It currently reads `amount/hours pairing (24→1500, 48→3000)` — that is the **two-tier** price list, retired two migrations ago. Replace with the three current pairs: **`10→1500, 24→2500, 48→4000`**.
- **STEP 2:** extend the `needs_manual_review` reason enumeration with `ownership_mismatch`, `ambiguous_session`, `refund_requires_action`, `refund_failed`.
- **STEP 2:** extend the refund check to `refunded_by ∈ {admin:<id>, stripe:dashboard, stripe:dispute}`.
- **STEP 2:** the pending threshold is now processor-dependent — 10 min for Square rows, **70 min** for Stripe rows.
- **STEP 3:** add `plaza stripe webhook` to the log-line patterns and the outcomes `not_ours`, `no_session`, `expired`, `unsubscribed_event` to the accepted outcome vocabulary.
- Add a statement check: `plaza_statements` rows with `emailed_at IS NULL` more than an hour after `generated_at` are a finding.

- [ ] **Step 3: Update `CHARTER.md`**

Line 16 says *"Square signature scheme (`notificationURL+body`, not Stripe's)"*. Replace with a two-line note: `/plaza/webhook` is Square's scheme (`HMAC-SHA256(notificationURL + rawBody)`); `/plaza/stripe/webhook` is Stripe's (`t=…,v1=…` over `timestamp.payload`, verified with `client.construct_event`, tolerance 300s). Both are live during the wind-down.

- [ ] **Step 4: Document the monitoring changes (spec §11)**

In the rollout doc's alerts section, list the seven new conditions and what each means: `external_refund`, `refund_failed`, `dispute`, `dispute_lost`, `stripe_signature_failure`, `statement_unemailed`, `pending_over_70m`. Email channel unchanged (Twilio is still non-functional in this deployment — parent rollout §1).

**Done when:**
- `docs/pay2park-rollout.md` has a §11 a human can follow start to finish with no reference to this plan.
- The watcher prompt contains `10→1500, 24→2500, 48→4000` and no `48→3000`.
- `grep -n "48→3000\|48->3000" /Users/gabe/lotlogic-agent/pay2park/payment-watch.sh` → nothing.
- Nothing was deployed, applied or flipped.

- [ ] **Step 5: Commit (two repos)**

```bash
cd /Users/gabe/lotlogic-backend-pay2park && git add docs/pay2park-rollout.md && \
git commit -m "docs(plaza-stripe): §11 cutover runbook and monitoring changes"
cd /Users/gabe/lotlogic-agent/pay2park && git add payment-watch.sh CHARTER.md && \
git commit -m "chore(pay2park-watch): processor-aware invariants, three-tier prices, Stripe patterns"
```

---

## Stripe twins for the existing Square tests (inventory §10)

Every file below stubs Square today. The right-hand column is the task that must give it a Stripe counterpart — either as processor-parametrized twins in the same file, or as the named new file.

| Existing test file | What it stubs today | Stripe twin lands in |
|---|---|---|
| `tests/plaza/test_plaza_quote_start.py` | `sq.create_checkout` (lines 148, 177, 575, 595, 969) | Task 1 (repoint to `square_adapter`, async), Task 10 (Stripe twins incl. the R49a double-tap) |
| `tests/plaza/test_plaza_webhook.py` | `sq._signature_key`, `sq._notification_url`, `sq.fetch_payment` | Task 1 (repoint), Tasks 5 + 6 (`test_stripe_webhook.py`, `test_stripe_webhook_money.py`) |
| `tests/plaza/test_plaza_sweep.py` | `sq.list_recent_payments`, `sq.fetch_payment` | Task 1 (repoint), Task 7 (per-row Stripe sweep tests in the same file) |
| `tests/plaza/test_plaza_reconcile.py` | `sq.list_payments_between`, `sq.square_enabled`, `sq._client` | Task 1 (repoint), Task 2 (conflict target), Task 8 (per-processor twins) |
| `tests/plaza/test_plaza_refund.py` | `sq.refund_payment` | Task 1 (repoint), Task 9 (Stripe state twins) |
| `tests/plaza/test_plaza_settle.py` | `PRICE_CENTS` import; hand-built `_sq()` dicts | Task 4 (`_stripe()` twins, ownership/ambiguous/livemode) |
| `tests/plaza/test_plaza_alerts.py` | in-process counters | Tasks 5, 6, 7, 12 (new conditions) |
| `tests/plaza/test_plaza_summary.py` | `pending_recent` window | Task 7 (60-minute window) |
| `tests/plaza/test_migrations.py` | schema assertions | Task 2 (`processor`, PK), Task 11 (`plaza_statements`) |
| `tests/plaza/test_harness.py` | schema replay | Task 2 (migration glob widened past `20260902*`) |
| `tests/plaza/test_parking_log_payments.py` | `square_receipt_url` in the log | **No twin needed** — the column keeps its name (S13) and holds Stripe's `charge.receipt_url`. Task 13 verifies the dashboard link still works. |
| `tests/plaza/test_plaza_notify.py`, `test_pass_finalize.py` | no Square calls | **No twin needed** — processor-agnostic by construction. |
| `tests/plaza/sandbox/test_sandbox_matrix.py` | live Square sandbox (24 rows) | Task 14 (fake, in CI) + Task 15 (live test-mode). The Square file is **not** edited or deleted. |

---

## Coverage: every spec section and every ruling maps to a task

### Spec sections

| Spec § | Task(s) |
|---|---|
| §1 Non-goals | Global Constraints |
| §2 Access model, config, fail-closed rules | 0, 10, 16 |
| §3 Data model (migration, new enum values) | 2, 6, 11 |
| §4 Processor abstraction | 0, 1, 2, 4 |
| §5.1 Create checkout | 3 |
| §5.2 `_shape` | 3 |
| §5.3 Fetch / list | 3 |
| §5.4 Refund | 3, 9 |
| §5.5 Webhook | 5, 6 |
| §6 TTL, sweep, dashboard window | 7 |
| §7 Biweekly 25% statement | 11, 12 |
| §8 Frontend | 10 (backend half), 13 |
| §9.1 Processor-parametrized twins | every task (twin table above) |
| §9.2 In-process fake Stripe matrix | 3 (fake), 14 (matrix) |
| §9.3 Live test-mode matrix | 15 |
| §9.4 Production smoke | 16 (runbook step 5) |
| §10 Cutover runbook | 16 |
| §11 Monitoring changes | 5, 6, 7, 12, 16 |
| §12 Open items for Gabe | Ambiguities section below |

### Rulings

| Ruling | Task(s) | Where it is proved |
|---|---|---|
| S1 no `expires_at`; TTL via sweep | 3, 7 | `test_create_checkout_sets_no_expires_at`; matrix row 27 |
| S2 cancel URL + not-registered copy | 1, 13 | Playwright cancel row; matrix row 28 |
| S2b stale-URL guard | 7 | `_serve_existing` 409; matrix row 26 |
| S3 `amount_captured`, not the ask | 3 | `test_shape_amount_comes_from_amount_captured_not_amount_total`; matrix row 21 |
| S4 adaptive pricing off + USD assert | 3, 4 | `test_create_checkout_disables_adaptive_pricing`; matrix row 22 |
| S5 test key in prod + `livemode` | 3, 10 | `test_production_with_a_test_key_is_503`; matrix row 35 |
| S6 async methods excluded + `succeeded` rule | 3 | `test_create_checkout_excludes_async_payment_methods`; matrix row 9 |
| S7 per-row Stripe sweep | 3, 7 | `test_stripe_sweep_fetches_per_row_not_by_listing` |
| S8 no DESC page-cap starvation | 7 | same test (zero list calls) |
| S9 `PLAZA_PROCESSOR` default | 0, 16 | default `"square"` in `Settings`; the flip is documented as a later removal change |
| S10 ambiguous session sentinel | 3, 4 | `test_fetch_by_payment_id_two_sessions_returns_the_ambiguous_sentinel`; `test_ambiguous_session_sentinel_marks_review_and_leaves_row_pending` |
| S11 refund accepted states + revert | 6, 9 | matrix rows 12–14 |
| S12 reconciliations PK `(day, processor)` | 2 | `test_reconciliations_primary_key_is_day_processor` |
| S13 no renames | 2 + Global Constraints | `test_square_columns_were_not_renamed` |
| S14 DEFAULT kept | 2 | `test_plaza_payments_processor_defaults_to_square` |
| S15 ownership gate before any alert | 5, 6 | `test_foreign_session_returns_200_not_ours_and_raises_no_alert`; matrix row 18 |
| S16 `any_enabled()` gate | 8 | `test_reconcile_runs_when_only_stripe_is_configured` |
| S16b `(day, processor)` presence | 8 | `test_presence_check_is_keyed_by_day_and_processor`; matrix row 30 |
| S17 24h key scope ≡ 24h abandon TTL | 7 | comment on `WINDOW_HOURS` + `test_24h_abandon_ttl_still_applies_to_both_processors` |
| S18 `ownership_mismatch → str \| None` | 0, 1, 3, 4 | `test_adapters_expose_the_whole_surface`; the settle `elif` chain tests |
| S19 async adapters, Square wrapped | 0, 1 | `grep` gate in Task 1's Done-when |
| S20 pin 15.6.1 + boot assert | 0, 10 | `requirements.txt`; the boot log line verified in runbook step 2 |
| S21 epoch → ISO round trip | 3 | `test_shape_created_at_round_trips_through_parse_paid_at` |
| S22 allow-list in the same commit | 5 | `test_webhook_path_is_public`, committed with the route |
| S23 `client.construct_event` | 5 | `grep -n "stripe.Webhook\."` returns nothing |
| S24 note fallback needs ownership | 5 | `test_note_recovery_requires_ownership`; matrix rows 19–20 |
| S25 lost dispute is not revenue | 6, 11 | `test_dispute_closed_lost_is_treated_like_a_refund`; matrix row 17 |
| S26 dashboard window ≡ TTL | 7 | `test_pending_recent_window_is_60_minutes` + the equality assertion |
| S27 no statement `processor` column | 11 | `test_details_carry_the_per_processor_split` |
| S28 DST period bounds | 11 | `test_period_four_crosses_dst_without_shifting`; matrix row 34 |
| S29 refund basis + credit lines | 11 | `test_same_period_refund_nets_to_zero`, `test_prior_period_refund_is_a_credit_line` |
| S30 `statement_unemailed` alert | 12 | `test_statement_unemailed_alert_fires_one_hour_after_generated_at` |
| S31 `already_parked` 409 | 10, 13 | `test_already_parked_returns_409_with_valid_until`; matrix row 29 |
| S32 fake implements the async methods | 3 | the fake subclasses `stripe.HTTPClient` and defines all four |
| S33 explicit `expand` prefixes + receipt assertion | 3, 15 | `_EXPAND` / `_EXPAND_LIST` constants; the live matrix's non-null `receipt_url` assertion |
| S34 watcher's stale price check | 16 | `grep` for `48→3000` returns nothing |

---

## Ambiguities in the spec, and how this plan resolves them

1. **"rulings S1–S24" in the header vs the S1–S34 table in §13.** The §13 table is authoritative; the header's range is a typo. All 34 rulings (plus S2b and S16b, which appear only in §6/§11 prose) are covered above.
2. **How does the Stripe path know it is "in production"?** §2 names only three config values, none of which is an environment marker, yet S5 and the `livemode` check both need one. **Resolution:** `stripe_plaza.is_production()` delegates to the existing plaza-wide `services.square.is_production()` (`SQUARE_ENVIRONMENT == 'production'`), which is already set correctly on Railway. One notion of production for the whole plaza, not two that can disagree. The runbook's env table gains a line saying `SQUARE_ENVIRONMENT` must stay set even after Square's wind-down; when Square is removed, that removal change must introduce a dedicated `PLAZA_ENVIRONMENT` in the same commit.
3. **`pending_over_10m` → `pending_over_70m`: rename or add?** §6 says the alert "becomes" `pending_over_70m` but also that "Square rows keep the old threshold". **Resolution:** two conditions, not a rename — `pending_over_10m` scoped to `processor='square'` and a new `pending_over_70m` scoped to `processor='stripe'`. A rename would silently stop alerting on Square rows during the wind-down.
4. **Task order: webhook before settle, or settle before webhook?** The suggested spine put the webhook first. **Resolution: settle first (Task 4), webhook second (Task 5).** With the pre-Task-4 settle, a Stripe payment (which carries no `location_id`) trips the `location_mismatch` leg and every capture lands in manual review. Landing the webhook first would make the branch un-deployable for exactly one commit.
5. **The reconciliations PK change breaks the existing upsert.** §3 changes the PK to `(day, processor)` but does not mention `_UPSERT_SQL`'s `ON CONFLICT (day)`, which becomes invalid the moment the migration lands. **Resolution:** the conflict target and the INSERT column list change in the **same task as the migration** (Task 2), before Task 8's per-processor work. Otherwise the first reconcile tick after the migration raises.
6. **The test harness only replays `migrations/20260902*.sql`.** Not mentioned in the spec. A `20260903*` migration would be invisible and the suite would stay green against a schema that no longer exists. **Resolution:** Task 2 widens `MIGRATION_GLOB` to `"2026090[23]*.sql"` and updates the three comments that name the old glob.
7. **`fetch_payment(order_id)` has no Square meaning.** §4 gives both adapters the same surface, but Square cannot look a payment up by order id in one call. **Resolution:** Square's `fetch_payment` returns `None` with a docstring explaining why, and the Square sweep keeps its single `list_recent_payments` call (§13.8 of the parent spec, unchanged). Only the Stripe sweep is per-row.
8. **`ownership_mismatch(payment, row)` needs a row; the webhook's unmatched branch has none.** S15 requires the ownership gate precisely where there is no row. **Resolution:** a second helper `stripe_plaza.is_ours(payment) -> bool` that checks `metadata.source` only, used for the no-row gate; the row-scoped function keeps its exact meaning for settle.
9. **Can a statement's `net_cents` go negative?** §7 does not say what happens when prior-period credits exceed the period's gross. **Resolution:** negative `net_cents` and negative `fee_cents` are stored as computed, never clamped — clamping would silently forgive a credit Frank is owed. **Surfaced to Gabe:** a negative statement means LotLogic owes Frank that period; say if you want it carried forward instead.
10. **Does `already_parked` count a pass whose payment is flagged for manual review?** §8 says "an active paid pass". **Resolution:** the guard reads `plaza_payments.payment_status = 'paid'` and `visitor_passes.status = 'active'` and `valid_until > now()` — a `needs_manual_review` stamp does not exempt a real, active pass, so it refuses. An unpaid/pending quote never refuses (that is the R6 recovery path).
11. **Prices.** Both specs are written against `$15/24h, $30/48h`. The live system has been on three tiers since migration `20260902000120`: **10h $15, 24h $25, 48h $40**. **Resolution:** live wins; the Global Constraints state the current table, every test uses it, and the watcher's stale two-tier check is corrected in Task 16 (S34).
12. **`cancel_url` on the Square adapter.** §5.1 defines it for Stripe only. **Resolution:** it is part of the shared nine-argument `create_checkout` signature and the Square adapter drops it, so no call site branches on processor. The frontend's `?checkout=cancel` handling is processor-agnostic.
13. **`PLAZA_STATEMENT_EMAIL_TO` is not in the §2 config table** although §7 names it. **Resolution:** added as a `Settings` field in Task 12 with default `billing@lotlogicparking.com`, and listed in the runbook's env table.
14. **Still open for Gabe (spec §12, not blocking the build):** Frank's key + account activation + receipt-email setting; the statement basis (net of refunds and lost disputes, before processor fees, credit lines for prior-period refunds); `already_parked` changing today's behaviour (a second purchase for a plate that already holds an active paid pass is now refused instead of charged-and-flagged); and the plaza rules text §3, which still says "24–48 hours" and belongs to the Square wind-down change.

---

## Self-Review

**Deployability at every step.** After every task, `PLAZA_PROCESSOR` is unset, Square quotes and settles exactly as it does today, and the branch can ship. Task 1 is a pure refactor with an unchanged test count. Task 2's migration is additive with a default and safe under the currently-deployed code (that is what makes runbook step 1 true). Tasks 3–9 add Stripe surface that nothing reaches until Task 10's gates and the flag flip. Tasks 11–12 are a new table and a new loop that read data both processors write.

**Type consistency.** The normalized payment dict (`id, order_id, status, amount_cents, currency, refunded_cents, receipt_url, created_at, note, processor, livemode`, plus `metadata` on Stripe) is produced by `square_adapter._tag` and `stripe_plaza._shape` and consumed identically by `settle_payment`, the sweep and the reconcile. `settle_payment(engine, *, plaza_payment_id, square_payment, background_tasks, allow_order_mismatch, processor)` is called with the same signature from the Square webhook, the Stripe webhook, the Square sweep and the Stripe sweep. `ownership_mismatch(payment, row) -> str | None` has the same meaning in both adapters; `is_ours(payment) -> bool` exists only on the Stripe side and is used only where there is no row.

**Placeholder scan.** Task 0 deliberately ships a `NotImplementedError` placeholder for `services/stripe_plaza.py` so the dispatcher resolves before Task 3 fills it; that is the only intentional stub, it raises rather than returning a wrong answer, and Task 3 replaces it entirely. No other step contains a TODO or a fake value.

**Test-count arithmetic.** 553 baseline → 561 (T0) → 561 (T1) → 567 (T2) → 598 (T3) → 608 (T4) → 626 (T5) → 638 (T6) → 653 (T7) → 660 (T8) → 667 (T9) → 680 (T10) → 693 (T11) → 709 (T12) → 709 (T13, frontend only) → 744 (T14) → 744 with 44 skipped (T15) → 744 (T16). If an implementer's count differs, reconcile before committing: a missing test is a missing guarantee, and an extra one is fine only if it is named in the plan.

**Two things flagged for the executor.**
1. **Task 2's migration and Task 2's `ON CONFLICT` change must ship in one commit.** Applying the migration against a deployment that still says `ON CONFLICT (day)` breaks the reconcile loop on its next tick. The runbook's "migration first, any time" only holds because the backend that reads it ships with the fixed upsert.
2. **Nothing in Tasks 0–15 may call Stripe with a live key, apply a migration, or change a Railway variable.** Task 16 writes the runbook; a human executes it. The first real charge is the smoke test in runbook step 5, after the Task 15 live test-mode matrix is green.
