# Truck-Plaza Pay-to-Park Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate the Charlotte Travel Plaza QR parking registration behind a Square payment ($15/24h, $30/48h) so a `visitor_passes` row exists **iff** a Square payment is confirmed — with zero regression to cameras, dashboard, cooldown, or tow decisions.

**Architecture:** Mirror the proven `app_bookings` pattern: the QR form creates a **pending `plaza_payments` row only** (never a pass), the driver pays on Square-hosted Checkout, and a signature-verified webhook (backstopped by a reconciliation sweep) creates the pass inside **one locked transaction** with a deterministic idempotency key. Everything downstream is unchanged. Rollout is staged behind `properties.pay_to_park_enabled`, sandbox-first.

**Tech Stack:** FastAPI + SQLAlchemy `text()` (Railway), Supabase Postgres, Square Python SDK (Checkout + Payments + Webhooks), vanilla JS `visit.html`, React-in-Babel `dashboard.html` (Vercel), Twilio (`services/sms.py`).

**Spec:** `docs/superpowers/specs/2026-09-01-truck-plaza-pay-to-park-design.md` — **§13 "Failure Modes & Hardening" is binding.** Read it before Task 1.

## Global Constraints

- **Property:** Charlotte Travel Plaza `bd44ace8-feda-42e1-9866-5d60f65e1712`, `property_type='truck_plaza'`.
- **Pricing:** flat `{24h → 1500, 48h → 3000}` cents, USD. **No tax. No weekday/weekend split** — never copy `app_api._price`/`LOT_TZ` logic into this path.
- **The invariant:** a `visitor_passes` row exists **iff** a Square payment is CONFIRMED for it. Every task preserves this.
- **Never-throw-after-charge:** any pass-INSERT failure inside the settle path is caught → `payment_status='paid'`, `pass_id NULL`, `needs_manual_review` reason, ops alert, **HTTP 200 to Square**. Never 500 (retry storm), never silent.
- **Exactly-once:** pass INSERT carries `submission_idempotency_key = 'plaza-' || plaza_payments.id`; 23505 IntegrityError is absorbed → return existing pass. `pass_id IS NULL` is **not** a concurrency guard.
- **Fail closed:** mock-pay only when `SQUARE_ENVIRONMENT != 'production'`. Prod + missing creds → `quote-and-start` 503. Never a free pass.
- **DO NOT MODIFY** `enforce_truck_plaza_cooldown`, `enforce_truck_plaza_stay_limit`, `set_pass_cooldown_flag`, or any apartment path. They are already correct.
- **Feature flag gates only the entrance** (`quote-and-start` + frontend). Never the webhook or sweep.
- **SQL:** always parameterized `text()` binds. **Migrations:** applied via Supabase MCP so they record in `supabase_migrations.schema_migrations`.
- **No real charge** until Task 12's sandbox matrix is green.

---

### Task 1: Migration — `plaza_payments` table, constraint extension, flag, indexes

**Files:**
- Create: `lotlogic-backend/migrations/20260902000010_plaza_payments.sql`
- Create: `lotlogic-backend/migrations/20260902000020_registration_source_qr_paid.sql`
- Create: `lotlogic-backend/migrations/20260902000030_visitor_passes_plaza_payment_link.sql`
- Create: `lotlogic-backend/migrations/20260902000040_properties_pay_to_park_flag.sql`

**Interfaces:**
- Produces: table `plaza_payments`; column `visitor_passes.plaza_payment_id`; column `properties.pay_to_park_enabled`; `registration_source` accepts `'qr_paid'`.

- [ ] **Step 1: Verify the LIVE constraint before writing anything** (the repo migrations are stale — §13.1)

```sql
SELECT pg_get_constraintdef(oid) FROM pg_constraint
WHERE conname = 'visitor_passes_registration_source_check';
```
Expected: a list containing `qr_scan, dashboard, sms, import, qr_guest, qr_resident`. **Copy the live list verbatim** into Step 3 and append `qr_paid` (and `app`, which is also missing and already written by `app_api.py:405`). Dropping any existing value breaks apartment registration.

- [ ] **Step 2: Write `20260902000010_plaza_payments.sql`**

```sql
CREATE TABLE IF NOT EXISTS public.plaza_payments (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id            uuid NOT NULL REFERENCES public.properties(id),
  plate_text             text NOT NULL,
  back_plate             text,
  phone                  text NOT NULL,
  company_name           text NOT NULL,
  visitor_name           text NOT NULL,
  stay_hours             int  NOT NULL,
  policy_acknowledged_at timestamptz NOT NULL,
  amount_cents           int  NOT NULL,
  currency               text NOT NULL DEFAULT 'usd',
  square_order_id        text UNIQUE,
  square_payment_id      text,
  square_receipt_url     text,
  square_checkout_url    text,
  payment_status         text NOT NULL DEFAULT 'pending'
    CHECK (payment_status IN ('pending','paid','failed','refunded','abandoned')),
  needs_manual_review    text,
  refund_amount_cents    int,
  refunded_at            timestamptz,
  pass_id                uuid REFERENCES public.visitor_passes(id),
  idempotency_key        text UNIQUE NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  paid_at                timestamptz,
  CONSTRAINT chk_plaza_payments_amount_matches_hours CHECK (
    (stay_hours = 24 AND amount_cents = 1500) OR
    (stay_hours = 48 AND amount_cents = 3000)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_plaza_payments_pass
  ON public.plaza_payments(pass_id) WHERE pass_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_plaza_payments_status_created
  ON public.plaza_payments(payment_status, created_at);

ALTER TABLE public.plaza_payments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.plaza_payments FROM anon, authenticated;
```
Both `ENABLE RLS` **and** `REVOKE` are required — REVOKE alone leaves RLS off; ENABLE alone leaves default grants. The row holds plate/phone/company PII.

- [ ] **Step 3: Write `20260902000020_registration_source_qr_paid.sql`** using the live list from Step 1

```sql
ALTER TABLE public.visitor_passes
  DROP CONSTRAINT visitor_passes_registration_source_check;
ALTER TABLE public.visitor_passes
  ADD CONSTRAINT visitor_passes_registration_source_check
  CHECK (registration_source IN
    ('qr_scan','dashboard','sms','import','qr_guest','qr_resident','app','qr_paid'))
  NOT VALID;
ALTER TABLE public.visitor_passes
  VALIDATE CONSTRAINT visitor_passes_registration_source_check;
```
`NOT VALID` + `VALIDATE` avoids holding ACCESS EXCLUSIVE during a full scan on a table taking continuous camera inserts.

- [ ] **Step 4: Write `20260902000030_visitor_passes_plaza_payment_link.sql`**

```sql
ALTER TABLE public.visitor_passes ADD COLUMN IF NOT EXISTS plaza_payment_id uuid;
ALTER TABLE public.visitor_passes
  ADD CONSTRAINT fk_visitor_passes_plaza_payment
  FOREIGN KEY (plaza_payment_id) REFERENCES public.plaza_payments(id) NOT VALID;
ALTER TABLE public.visitor_passes VALIDATE CONSTRAINT fk_visitor_passes_plaza_payment;
```
Nullable, no default → metadata-only, no table rewrite. **No `paid_amount_cents`** — it drifts on refund (§13.10); the dashboard reads amount via JOIN.

- [ ] **Step 5: Write `20260902000040_properties_pay_to_park_flag.sql`**

```sql
ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS pay_to_park_enabled boolean NOT NULL DEFAULT false;
```
Default **false** — nothing changes until Task 13 flips it.

- [ ] **Step 6: Apply all four via Supabase MCP `apply_migration`, one at a time, in order**

- [ ] **Step 7: Verify against the live DB**

```sql
SELECT pg_get_constraintdef(oid) FROM pg_constraint
 WHERE conname IN ('visitor_passes_registration_source_check','chk_plaza_payments_amount_matches_hours');
SELECT relrowsecurity FROM pg_class WHERE relname='plaza_payments';
SELECT indexname FROM pg_indexes WHERE tablename='plaza_payments';
SELECT has_table_privilege('anon','public.plaza_payments','SELECT') AS anon_can_read;
```
Expected: `qr_paid` present and no prior value dropped; `relrowsecurity = true`; both indexes present; `anon_can_read = false`.

- [ ] **Step 8: Commit**

```bash
cd ~/lotlogic-backend && git add migrations/ && \
git commit -m "feat(pay2park): plaza_payments table, qr_paid source, pass link, property flag"
```

---

### Task 2: `services/square.py` — Square client, signature verification, refund

**Files:**
- Create: `lotlogic-backend/services/square.py`
- Test: `lotlogic-backend/tests/test_square_service.py`

**Interfaces:**
- Produces:
  - `square_enabled() -> bool`
  - `is_production() -> bool`
  - `PRICE_CENTS: dict[int,int]` = `{24: 1500, 48: 3000}`
  - `price_for(stay_hours: int) -> int` (raises `ValueError` on unknown)
  - `create_checkout(*, idempotency_key: str, amount_cents: int, reference_id: str, redirect_url: str) -> dict` → `{"order_id","checkout_url"}`
  - `verify_webhook_signature(*, raw_body: bytes, signature: str) -> bool`
  - `fetch_payment(payment_id: str) -> dict | None` → `{"id","order_id","status","amount_cents","currency","location_id","refunded_cents","receipt_url","created_at"}`
  - `list_recent_payments(begin_time_iso: str) -> list[dict]` (same shape)
  - `refund_payment(*, payment_id: str, amount_cents: int, idempotency_key: str) -> dict`

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_square_service.py
import base64, hashlib, hmac, pytest
from services import square as sq

def test_price_for_known_tiers():
    assert sq.price_for(24) == 1500
    assert sq.price_for(48) == 3000

def test_price_for_rejects_unknown_duration():
    with pytest.raises(ValueError):
        sq.price_for(12)

def test_verify_webhook_signature_uses_notification_url_plus_body(monkeypatch):
    """Square signs HMAC-SHA256(notificationURL + rawBody) — NOT Stripe's body-only."""
    monkeypatch.setattr(sq, "_signature_key", lambda: "test-sig-key")
    monkeypatch.setattr(sq, "_notification_url", lambda: "https://api.example.com/plaza/webhook")
    body = b'{"type":"payment.updated"}'
    expected = base64.b64encode(hmac.new(
        b"test-sig-key",
        b"https://api.example.com/plaza/webhook" + body,
        hashlib.sha256,
    ).digest()).decode()
    assert sq.verify_webhook_signature(raw_body=body, signature=expected) is True

def test_verify_webhook_signature_rejects_body_only_hmac(monkeypatch):
    monkeypatch.setattr(sq, "_signature_key", lambda: "test-sig-key")
    monkeypatch.setattr(sq, "_notification_url", lambda: "https://api.example.com/plaza/webhook")
    body = b'{"type":"payment.updated"}'
    body_only = base64.b64encode(
        hmac.new(b"test-sig-key", body, hashlib.sha256).digest()
    ).decode()
    assert sq.verify_webhook_signature(raw_body=body, signature=body_only) is False

def test_verify_webhook_signature_rejects_garbage(monkeypatch):
    monkeypatch.setattr(sq, "_signature_key", lambda: "test-sig-key")
    monkeypatch.setattr(sq, "_notification_url", lambda: "https://api.example.com/plaza/webhook")
    assert sq.verify_webhook_signature(raw_body=b"{}", signature="not-a-signature") is False

def test_square_disabled_when_unconfigured(monkeypatch):
    monkeypatch.delenv("SQUARE_ACCESS_TOKEN", raising=False)
    assert sq.square_enabled() is False
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/lotlogic-backend && python -m pytest tests/test_square_service.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'services.square'`

- [ ] **Step 3: Implement `services/square.py`**

```python
"""Square client for truck-plaza pay-to-park.

Env: SQUARE_ACCESS_TOKEN, SQUARE_LOCATION_ID, SQUARE_WEBHOOK_SIGNATURE_KEY,
     SQUARE_NOTIFICATION_URL, SQUARE_ENVIRONMENT ('sandbox'|'production').

Pricing here is FLAT and timezone-independent by design. Do NOT introduce
weekday/weekend or lot-local-TZ logic (that belongs to app_api only).
"""
import base64, hashlib, hmac, logging, os
from typing import Any

log = logging.getLogger(__name__)

PRICE_CENTS: dict[int, int] = {24: 1500, 48: 3000}
CURRENCY = "USD"

def _env(name: str) -> str | None:
    v = os.getenv(name)
    return v.strip() if v and v.strip() else None

def _signature_key() -> str | None:
    return _env("SQUARE_WEBHOOK_SIGNATURE_KEY")

def _notification_url() -> str | None:
    # Pinned to config — never rebuilt from request.url (Railway's proxy
    # rewrites scheme/host and would break signature verification).
    return _env("SQUARE_NOTIFICATION_URL")

def is_production() -> bool:
    return (_env("SQUARE_ENVIRONMENT") or "sandbox").lower() == "production"

def square_enabled() -> bool:
    return bool(_env("SQUARE_ACCESS_TOKEN") and _env("SQUARE_LOCATION_ID"))

def price_for(stay_hours: int) -> int:
    try:
        return PRICE_CENTS[int(stay_hours)]
    except (KeyError, TypeError, ValueError):
        raise ValueError(f"unsupported stay_hours: {stay_hours!r}")

def _client():
    from square.client import Client
    return Client(
        access_token=_env("SQUARE_ACCESS_TOKEN"),
        environment="production" if is_production() else "sandbox",
    )

def create_checkout(*, idempotency_key: str, amount_cents: int,
                    reference_id: str, redirect_url: str) -> dict[str, Any]:
    body = {
        "idempotency_key": idempotency_key,
        "quick_pay": {
            "name": "Truck Parking — Charlotte Travel Plaza",
            "price_money": {"amount": amount_cents, "currency": CURRENCY},
            "location_id": _env("SQUARE_LOCATION_ID"),
        },
        "checkout_options": {
            "redirect_url": redirect_url,
            "ask_for_shipping_address": False,
        },
        "payment_note": f"plaza:{reference_id}",
    }
    res = _client().checkout.create_payment_link(body=body)
    if res.is_error():
        raise RuntimeError(f"square checkout failed: {res.errors}")
    link = res.body["payment_link"]
    return {"order_id": link["order_id"], "checkout_url": link["url"]}

def verify_webhook_signature(*, raw_body: bytes, signature: str) -> bool:
    key, url = _signature_key(), _notification_url()
    if not key or not url or not signature:
        return False
    expected = base64.b64encode(
        hmac.new(key.encode(), url.encode() + raw_body, hashlib.sha256).digest()
    ).decode()
    return hmac.compare_digest(expected, signature)

def _payment_shape(p: dict) -> dict[str, Any]:
    amt = (p.get("amount_money") or {})
    refunded = (p.get("refunded_money") or {})
    return {
        "id": p.get("id"),
        "order_id": p.get("order_id"),
        "status": p.get("status"),
        "amount_cents": amt.get("amount"),
        "currency": amt.get("currency"),
        "location_id": p.get("location_id"),
        "refunded_cents": refunded.get("amount") or 0,
        "receipt_url": p.get("receipt_url"),
        "created_at": p.get("created_at"),
    }

def fetch_payment(payment_id: str) -> dict[str, Any] | None:
    res = _client().payments.get_payment(payment_id=payment_id)
    if res.is_error():
        log.warning("square get_payment failed: %s", res.errors)
        return None
    return _payment_shape(res.body.get("payment") or {})

def list_recent_payments(begin_time_iso: str) -> list[dict[str, Any]]:
    """ONE call per sweep — never N x get_payment (§13.8)."""
    res = _client().payments.list_payments(
        begin_time=begin_time_iso,
        location_id=_env("SQUARE_LOCATION_ID"),
    )
    if res.is_error():
        log.warning("square list_payments failed: %s", res.errors)
        return []
    return [_payment_shape(p) for p in (res.body.get("payments") or [])]

def refund_payment(*, payment_id: str, amount_cents: int,
                   idempotency_key: str) -> dict[str, Any]:
    res = _client().refunds.refund_payment(body={
        "idempotency_key": idempotency_key,
        "payment_id": payment_id,
        "amount_money": {"amount": amount_cents, "currency": CURRENCY},
    })
    if res.is_error():
        raise RuntimeError(f"square refund failed: {res.errors}")
    return res.body.get("refund") or {}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/lotlogic-backend && python -m pytest tests/test_square_service.py -v`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
cd ~/lotlogic-backend && git add services/square.py tests/test_square_service.py && \
git commit -m "feat(pay2park): Square client with notificationURL+body signature verification"
```

---

### Task 3: Extract the shared pass finalizer out of `public_registration.py`

This is §13.5 — the red 🚨 TOW banner Frank acts on comes from `reregistration_flagged_at`, which is set by ~250 lines of app code **after** the INSERT. If the webhook replays only the INSERT, paid violators never surface. Extract once, call from both paths. **Pure refactor — free-path behavior must not change.**

**Files:**
- Modify: `lotlogic-backend/routers/public_registration.py:505-700`
- Create: `lotlogic-backend/services/pass_finalize.py`
- Test: `lotlogic-backend/tests/test_pass_finalize.py`

**Interfaces:**
- Produces: `finalize_truck_plaza_pass(conn, *, pass_id: str, property_id: str, plate_text: str, back_plate: str | None, phone: str, valid_from, best_effort: bool = True) -> dict` → `{"first_seen_event_id","reregistration_flagged","matched_active_pass_id","matched_on"}`

- [ ] **Step 1: Read the current post-insert block end to end**

Read `public_registration.py:505-700`. Catalogue the four things it does: first-seen photo backfill (`:505-642`), MMC copy (`:623-639`), re-registration TOW flag (`:644-694`), and the cooldown/re-reg partner notices (`:691,700`).

- [ ] **Step 2: Write the failing test**

```python
# tests/test_pass_finalize.py
from services.pass_finalize import finalize_truck_plaza_pass

def test_finalize_flags_reregistration_when_active_pass_exists(db_conn, seed_truck_plaza):
    """A second pass for the same plate while one is active => TOW flag."""
    first = seed_truck_plaza.create_pass(plate="TEST1234", hours=24)
    second = seed_truck_plaza.create_pass(plate="TEST1234", hours=24)
    out = finalize_truck_plaza_pass(
        db_conn, pass_id=second.id, property_id=seed_truck_plaza.property_id,
        plate_text="TEST1234", back_plate=None, phone="+17045551234",
        valid_from=second.valid_from,
    )
    assert out["reregistration_flagged"] is True
    assert out["matched_active_pass_id"] == first.id
    assert out["matched_on"] == "plate"

def test_finalize_is_best_effort_and_never_raises(db_conn, seed_truck_plaza):
    """A finalizer failure must never roll back the pass/payment linkage."""
    out = finalize_truck_plaza_pass(
        db_conn, pass_id="00000000-0000-0000-0000-000000000000",
        property_id=seed_truck_plaza.property_id, plate_text="NOPE",
        back_plate=None, phone="+17045550000", valid_from=None,
    )
    assert out["reregistration_flagged"] is False
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd ~/lotlogic-backend && python -m pytest tests/test_pass_finalize.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'services.pass_finalize'`

- [ ] **Step 4: Move the block verbatim into `services/pass_finalize.py`**

Cut `public_registration.py:505-700` into `finalize_truck_plaza_pass(...)`. Keep the SQL byte-identical — this is a move, not a rewrite. Wrap the whole body in `try/except Exception` that logs and returns the default dict when `best_effort=True`, so a finalizer failure can never roll back the caller's transaction.

- [ ] **Step 5: Call it from the free path**

In `public_registration.py`, replace the removed block with:
```python
from services.pass_finalize import finalize_truck_plaza_pass
...
finalize_truck_plaza_pass(
    conn, pass_id=pass_id, property_id=property_id, plate_text=plate_norm,
    back_plate=back_plate_val, phone=phone, valid_from=valid_from,
)
```

- [ ] **Step 6: Run the full registration suite — free path must be unchanged**

Run: `cd ~/lotlogic-backend && python -m pytest tests/ -k "registration or finalize" -v`
Expected: all pass, including the pre-existing free-path tests.

- [ ] **Step 7: Commit**

```bash
cd ~/lotlogic-backend && git add services/pass_finalize.py routers/public_registration.py tests/test_pass_finalize.py && \
git commit -m "refactor(pay2park): extract shared finalize_truck_plaza_pass (no behavior change)"
```

---

### Task 4: The settle path — exactly-once pass creation under a row lock

The heart of the system (§13.0). Every money guarantee rests here.

**Files:**
- Create: `lotlogic-backend/services/plaza_settle.py`
- Test: `lotlogic-backend/tests/test_plaza_settle.py`

**Interfaces:**
- Consumes: `services.square.fetch_payment`, `services.pass_finalize.finalize_truck_plaza_pass`
- Produces: `settle_payment(engine, *, plaza_payment_id: str, square_payment: dict) -> dict` → `{"outcome","pass_id"}` where outcome ∈ `{"created","already_settled","rejected_not_completed","rejected_amount_mismatch","rejected_refunded","manual_review"}`

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_plaza_settle.py
from services.plaza_settle import settle_payment

def _sq(pp, **over):
    base = {"id":"sqpay_1","order_id":pp.square_order_id,"status":"COMPLETED",
            "amount_cents":pp.amount_cents,"currency":"USD",
            "location_id":"LOC_TEST","refunded_cents":0,
            "receipt_url":"https://sq/r/1","created_at":"2026-09-02T15:00:00Z"}
    base.update(over); return base

def test_settle_creates_exactly_one_pass(engine, pending_payment):
    out = settle_payment(engine, plaza_payment_id=pending_payment.id,
                         square_payment=_sq(pending_payment))
    assert out["outcome"] == "created" and out["pass_id"]

def test_settle_is_idempotent_across_five_replays(engine, pending_payment):
    """Webhook replay x5 => exactly ONE pass (design §10.4 / checklist 35)."""
    outs = [settle_payment(engine, plaza_payment_id=pending_payment.id,
                           square_payment=_sq(pending_payment)) for _ in range(5)]
    pass_ids = {o["pass_id"] for o in outs}
    assert len(pass_ids) == 1
    assert [o["outcome"] for o in outs].count("created") == 1
    assert engine.count_passes(plaza_payment_id=pending_payment.id) == 1

def test_settle_rejects_amount_mismatch(engine, pending_payment):
    out = settle_payment(engine, plaza_payment_id=pending_payment.id,
                         square_payment=_sq(pending_payment, amount_cents=100))
    assert out["outcome"] == "rejected_amount_mismatch"
    assert engine.count_passes(plaza_payment_id=pending_payment.id) == 0

def test_settle_rejects_refunded_payment(engine, pending_payment):
    out = settle_payment(engine, plaza_payment_id=pending_payment.id,
                         square_payment=_sq(pending_payment, refunded_cents=1500))
    assert out["outcome"] == "rejected_refunded"
    assert engine.count_passes(plaza_payment_id=pending_payment.id) == 0

def test_settle_rejects_approved_not_captured(engine, pending_payment):
    """APPROVED = delayed capture, funds NOT taken. Never issue."""
    out = settle_payment(engine, plaza_payment_id=pending_payment.id,
                         square_payment=_sq(pending_payment, status="APPROVED"))
    assert out["outcome"] == "rejected_not_completed"
    assert engine.count_passes(plaza_payment_id=pending_payment.id) == 0

def test_settle_valid_until_is_paid_at_plus_hours(engine, pending_payment):
    out = settle_payment(engine, plaza_payment_id=pending_payment.id,
                         square_payment=_sq(pending_payment))
    p = engine.get_pass(out["pass_id"])
    assert (p.valid_until - p.valid_from).total_seconds() == pending_payment.stay_hours * 3600
    assert p.valid_from.isoformat().startswith("2026-09-02T15:00")  # Square's ts, not now()

def test_settle_records_manual_review_on_trigger_error(engine, held_plate_payment):
    """A trigger RAISE after capture must NOT lose the money."""
    out = settle_payment(engine, plaza_payment_id=held_plate_payment.id,
                         square_payment=_sq(held_plate_payment))
    assert out["outcome"] == "manual_review"
    row = engine.get_payment(held_plate_payment.id)
    assert row.payment_status == "paid" and row.pass_id is None
    assert row.needs_manual_review
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd ~/lotlogic-backend && python -m pytest tests/test_plaza_settle.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'services.plaza_settle'`

- [ ] **Step 3: Implement `services/plaza_settle.py`**

```python
"""Settle a Square payment into a visitor_pass. Called by BOTH the webhook
and the reconciliation sweep — they must share this exact code path.

Guarantees (spec §13.0/§13.1/§13.2):
  * exactly-once via deterministic submission_idempotency_key + unique index
  * one transaction, one commit, row-locked
  * never raises past the caller: a trigger error becomes manual_review
"""
import logging, os
from sqlalchemy import text

log = logging.getLogger(__name__)

def settle_payment(engine, *, plaza_payment_id: str, square_payment: dict) -> dict:
    idem = f"plaza-{plaza_payment_id}"
    with engine.begin() as conn:                      # ONE transaction
        row = conn.execute(text("""
            SELECT id, property_id, plate_text, back_plate, phone, company_name,
                   visitor_name, stay_hours, amount_cents, currency,
                   policy_acknowledged_at, payment_status, pass_id
              FROM plaza_payments
             WHERE id = :id
             FOR UPDATE
        """), {"id": plaza_payment_id}).mappings().first()

        if row is None:
            return {"outcome": "already_settled", "pass_id": None}
        if row["pass_id"]:
            return {"outcome": "already_settled", "pass_id": str(row["pass_id"])}

        # --- verify Square's re-fetched state, not the event body (§13.2) ---
        if square_payment.get("status") != "COMPLETED":
            return {"outcome": "rejected_not_completed", "pass_id": None}
        if (square_payment.get("refunded_cents") or 0) > 0:
            conn.execute(text("UPDATE plaza_payments SET payment_status='refunded' WHERE id=:id"),
                         {"id": plaza_payment_id})
            return {"outcome": "rejected_refunded", "pass_id": None}
        if square_payment.get("amount_cents") != row["amount_cents"]:
            conn.execute(text("""UPDATE plaza_payments
                                    SET payment_status='failed',
                                        needs_manual_review='amount_mismatch'
                                  WHERE id=:id"""), {"id": plaza_payment_id})
            return {"outcome": "rejected_amount_mismatch", "pass_id": None}
        if (square_payment.get("currency") or "").upper() != (row["currency"] or "usd").upper():
            return {"outcome": "rejected_amount_mismatch", "pass_id": None}
        loc = os.getenv("SQUARE_LOCATION_ID")
        if loc and square_payment.get("location_id") != loc:
            return {"outcome": "rejected_amount_mismatch", "pass_id": None}

        paid_at = square_payment.get("created_at")     # Square's ts, never now()

        try:
            pass_id = conn.execute(text("""
                INSERT INTO visitor_passes (
                  property_id, plate_text, back_plate, visitor_name, company_name,
                  phone, valid_from, valid_until, status, registration_source,
                  policy_acknowledged_at, submission_idempotency_key,
                  plaza_payment_id, stay_days
                ) VALUES (
                  :property_id, :plate_text, :back_plate, :visitor_name, :company_name,
                  :phone, :paid_at, :paid_at::timestamptz + make_interval(hours => :stay_hours),
                  'active', 'qr_paid',
                  :policy_ack, :idem,
                  :plaza_payment_id, GREATEST(1, CEIL(:stay_hours / 24.0)::int)
                )
                ON CONFLICT (submission_idempotency_key) DO NOTHING
                RETURNING id
            """), {
                "property_id": row["property_id"], "plate_text": row["plate_text"],
                "back_plate": row["back_plate"], "visitor_name": row["visitor_name"],
                "company_name": row["company_name"], "phone": row["phone"],
                "paid_at": paid_at, "stay_hours": row["stay_hours"],
                "policy_ack": row["policy_acknowledged_at"], "idem": idem,
                "plaza_payment_id": plaza_payment_id,
            }).scalar()

            if pass_id is None:   # concurrent winner already inserted it
                pass_id = conn.execute(text(
                    "SELECT id FROM visitor_passes WHERE submission_idempotency_key = :idem"
                ), {"idem": idem}).scalar()

            conn.execute(text("""
                UPDATE plaza_payments
                   SET pass_id = :pass_id, payment_status = 'paid',
                       paid_at = :paid_at, square_payment_id = :sq_id,
                       square_receipt_url = :receipt, needs_manual_review = NULL
                 WHERE id = :id
            """), {"pass_id": pass_id, "paid_at": paid_at,
                   "sq_id": square_payment.get("id"),
                   "receipt": square_payment.get("receipt_url"),
                   "id": plaza_payment_id})

        except Exception as exc:                       # trigger RAISE, CHECK, anything
            log.exception("plaza settle: pass insert failed for %s", plaza_payment_id)
            reason = str(exc)[:400]
            with engine.begin() as c2:                 # separate txn — must survive
                c2.execute(text("""
                    UPDATE plaza_payments
                       SET payment_status='paid', pass_id=NULL,
                           paid_at=:paid_at, square_payment_id=:sq_id,
                           needs_manual_review=:reason
                     WHERE id=:id
                """), {"paid_at": paid_at, "sq_id": square_payment.get("id"),
                       "reason": reason, "id": plaza_payment_id})
            return {"outcome": "manual_review", "pass_id": None}

    # --- post-commit, best-effort: photo backfill + TOW flag + notices ---
    try:
        from services.pass_finalize import finalize_truck_plaza_pass
        with engine.begin() as conn:
            finalize_truck_plaza_pass(
                conn, pass_id=str(pass_id), property_id=str(row["property_id"]),
                plate_text=row["plate_text"], back_plate=row["back_plate"],
                phone=row["phone"], valid_from=paid_at,
            )
    except Exception:
        log.exception("plaza settle: finalizer failed (non-fatal) for %s", plaza_payment_id)

    return {"outcome": "created", "pass_id": str(pass_id)}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/lotlogic-backend && python -m pytest tests/test_plaza_settle.py -v`
Expected: 7 passed — **especially `test_settle_is_idempotent_across_five_replays`**

- [ ] **Step 5: Commit**

```bash
cd ~/lotlogic-backend && git add services/plaza_settle.py tests/test_plaza_settle.py && \
git commit -m "feat(pay2park): exactly-once locked settle path with amount+state verification"
```

---

### Task 5: `POST /plaza/quote-and-start` — pre-payment gate + Square checkout

**Files:**
- Create: `lotlogic-backend/routers/plaza_payments.py`
- Modify: `lotlogic-backend/main.py` (register router)
- Test: `lotlogic-backend/tests/test_plaza_quote_start.py`

**Interfaces:**
- Consumes: `services.square.{square_enabled,is_production,price_for,create_checkout}`
- Produces: `POST /plaza/quote-and-start` → `{"plaza_payment_id","checkout_url","amount_cents","stay_hours"}`

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_plaza_quote_start.py
def test_rejects_client_supplied_amount(client, plaza_flag_on):
    """Amount is server-derived. A client amount must never be honored."""
    r = client.post("/plaza/quote-and-start", json={
        "property_id": PLAZA_ID, "duration": "h24", "amount_cents": 1,
        "plate_text": "ABC1234", "back_plate": "XYZ9999", "phone": "+17045551234",
        "company_name": "Acme", "visitor_name": "Driver", "policy_acknowledged": True,
        "idempotency_key": "11111111-1111-4111-8111-111111111111",
        "recaptcha_token": "test",
    })
    assert r.status_code == 200
    assert r.json()["amount_cents"] == 1500

def test_rejects_unknown_duration(client, plaza_flag_on):
    r = client.post("/plaza/quote-and-start", json={**VALID, "duration": "h12"})
    assert r.status_code == 422

def test_same_idempotency_key_returns_same_checkout(client, plaza_flag_on):
    a = client.post("/plaza/quote-and-start", json=VALID).json()
    b = client.post("/plaza/quote-and-start", json=VALID).json()
    assert a["plaza_payment_id"] == b["plaza_payment_id"]
    assert a["checkout_url"] == b["checkout_url"]

def test_idempotency_collision_with_different_plate_is_rejected(client, plaza_flag_on):
    client.post("/plaza/quote-and-start", json=VALID)
    r = client.post("/plaza/quote-and-start", json={**VALID, "plate_text": "OTHER99"})
    assert r.status_code == 409

def test_requires_policy_acknowledgement(client, plaza_flag_on):
    r = client.post("/plaza/quote-and-start", json={**VALID, "policy_acknowledged": False})
    assert r.status_code == 400

def test_rejects_plate_on_active_hold_before_payment(client, plaza_flag_on, held_plate):
    """plate-hold must block BEFORE money moves (§13.1)."""
    r = client.post("/plaza/quote-and-start", json={**VALID, "plate_text": held_plate})
    assert r.status_code == 409
    assert "hold" in r.json()["detail"].lower()

def test_503_when_flag_off(client, plaza_flag_off):
    assert client.post("/plaza/quote-and-start", json=VALID).status_code == 503

def test_503_in_production_without_square_creds(client, plaza_flag_on, prod_no_creds):
    """Fail CLOSED — never fall back to a free pass."""
    assert client.post("/plaza/quote-and-start", json=VALID).status_code == 503
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd ~/lotlogic-backend && python -m pytest tests/test_plaza_quote_start.py -v`
Expected: FAIL — 404 (route not registered)

- [ ] **Step 3: Implement the router**

```python
"""Truck-plaza pay-to-park endpoints. Public + Square webhook."""
import logging, uuid
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, constr
from sqlalchemy import text
from typing import Literal

from db import engine
from services import square as sq
from services.recaptcha import verify_recaptcha

log = logging.getLogger(__name__)
router = APIRouter(prefix="/plaza", tags=["plaza-payments"])

DURATIONS: dict[str, int] = {"h24": 24, "h48": 48}

class QuoteStartBody(BaseModel):
    property_id: str
    duration: Literal["h24", "h48"]          # enum ONLY — never hours/amount
    plate_text: constr(strip_whitespace=True, min_length=2, max_length=16)
    back_plate: constr(strip_whitespace=True, max_length=16) | None = None
    phone: constr(strip_whitespace=True, min_length=7, max_length=24)
    company_name: constr(strip_whitespace=True, min_length=1, max_length=120)
    visitor_name: constr(strip_whitespace=True, min_length=1, max_length=120)
    policy_acknowledged: bool
    idempotency_key: constr(min_length=16, max_length=64)
    recaptcha_token: str | None = None
    class Config:
        extra = "forbid"                      # reject amount_cents, pass_id, etc.

@router.post("/quote-and-start")
async def quote_and_start(body: QuoteStartBody, request: Request):
    if not body.policy_acknowledged:
        raise HTTPException(400, "policy_not_acknowledged")
    await verify_recaptcha(body.recaptcha_token, action="plaza_pay")

    stay_hours = DURATIONS[body.duration]
    amount_cents = sq.price_for(stay_hours)         # server-derived, always

    with engine.begin() as conn:
        prop = conn.execute(text("""
            SELECT id, pay_to_park_enabled, property_type
              FROM properties WHERE id = :id
        """), {"id": body.property_id}).mappings().first()
        if not prop or prop["property_type"] != "truck_plaza":
            raise HTTPException(404, "property_not_found")
        if not prop["pay_to_park_enabled"]:
            raise HTTPException(503, "pay_to_park_disabled")

        if sq.is_production() and not sq.square_enabled():
            raise HTTPException(503, "payments_unavailable")   # FAIL CLOSED

        plate = body.plate_text.upper()
        held = conn.execute(text("""
            SELECT 1 FROM plate_holds
             WHERE upper(plate_text) = :p AND hold_until > now() LIMIT 1
        """), {"p": plate}).first()
        if held:
            raise HTTPException(409, "This plate is on a 24-hour hold and cannot park yet.")

        existing = conn.execute(text("""
            SELECT id, plate_text, phone, amount_cents, stay_hours, square_checkout_url
              FROM plaza_payments WHERE idempotency_key = :k
        """), {"k": body.idempotency_key}).mappings().first()
        if existing:
            if existing["plate_text"] != plate or existing["phone"] != body.phone:
                raise HTTPException(409, "idempotency_key_reuse_mismatch")
            return {"plaza_payment_id": str(existing["id"]),
                    "checkout_url": existing["square_checkout_url"],
                    "amount_cents": existing["amount_cents"],
                    "stay_hours": existing["stay_hours"]}

        pp_id = str(uuid.uuid4())
        conn.execute(text("""
            INSERT INTO plaza_payments (
              id, property_id, plate_text, back_plate, phone, company_name,
              visitor_name, stay_hours, policy_acknowledged_at, amount_cents,
              currency, idempotency_key, payment_status
            ) VALUES (
              :id, :property_id, :plate, :back_plate, :phone, :company,
              :visitor, :hours, now(), :amount, 'usd', :key, 'pending'
            )
        """), {"id": pp_id, "property_id": body.property_id, "plate": plate,
               "back_plate": (body.back_plate or "").upper() or None,
               "phone": body.phone, "company": body.company_name,
               "visitor": body.visitor_name, "hours": stay_hours,
               "amount": amount_cents, "key": body.idempotency_key})

    checkout = sq.create_checkout(
        idempotency_key=body.idempotency_key, amount_cents=amount_cents,
        reference_id=pp_id,
        redirect_url=f"{os.getenv('SITE_URL','https://lotlogicparking.com')}"
                     f"/visit.html?plaza_payment_id={pp_id}",
    )
    with engine.begin() as conn:
        conn.execute(text("""UPDATE plaza_payments
                                SET square_order_id=:oid, square_checkout_url=:url
                              WHERE id=:id"""),
                     {"oid": checkout["order_id"], "url": checkout["checkout_url"], "id": pp_id})

    log.info("plaza quote-and-start pp=%s order=%s amount=%s",
             pp_id, checkout["order_id"], amount_cents)
    return {"plaza_payment_id": pp_id, "checkout_url": checkout["checkout_url"],
            "amount_cents": amount_cents, "stay_hours": stay_hours}
```

Register in `main.py`: `app.include_router(plaza_payments.router)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/lotlogic-backend && python -m pytest tests/test_plaza_quote_start.py -v`
Expected: 8 passed

- [ ] **Step 5: Commit**

```bash
cd ~/lotlogic-backend && git add routers/plaza_payments.py main.py tests/test_plaza_quote_start.py && \
git commit -m "feat(pay2park): quote-and-start with server pricing, plate-hold gate, fail-closed"
```

---

### Task 6: Square webhook + public status endpoint + auth allow-list

**Files:**
- Modify: `lotlogic-backend/routers/plaza_payments.py`
- Modify: `lotlogic-backend/main.py` (auth-exempt paths — §13.9)
- Test: `lotlogic-backend/tests/test_plaza_webhook.py`

**Interfaces:**
- Consumes: `services.plaza_settle.settle_payment`, `services.square.{verify_webhook_signature,fetch_payment}`
- Produces: `POST /plaza/webhook`, `GET /plaza/payments/{id}/status` → `{"payment_status","pass_active"}`

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_plaza_webhook.py
def test_unsigned_webhook_rejected(client):
    r = client.post("/plaza/webhook", data=b'{"type":"payment.updated"}')
    assert r.status_code == 400

def test_signed_webhook_creates_pass(client, pending_payment, sq_stub):
    r = client.post("/plaza/webhook", data=signed_body(pending_payment),
                    headers=sig_header(pending_payment))
    assert r.status_code == 200
    assert count_passes(pending_payment.id) == 1

def test_webhook_replay_x5_creates_exactly_one_pass(client, pending_payment, sq_stub):
    for _ in range(5):
        assert client.post("/plaza/webhook", data=signed_body(pending_payment),
                           headers=sig_header(pending_payment)).status_code == 200
    assert count_passes(pending_payment.id) == 1

def test_unknown_order_returns_200_noop(client, sq_stub):
    """Never 500 — Square would retry forever."""
    r = client.post("/plaza/webhook", data=signed_body_unknown(),
                    headers=sig_header_unknown())
    assert r.status_code == 200

def test_settle_failure_still_returns_200(client, held_plate_payment, sq_stub):
    r = client.post("/plaza/webhook", data=signed_body(held_plate_payment),
                    headers=sig_header(held_plate_payment))
    assert r.status_code == 200
    assert get_payment(held_plate_payment.id).needs_manual_review

def test_status_endpoint_returns_status_only_no_pii(client, paid_payment):
    body = client.get(f"/plaza/payments/{paid_payment.id}/status").json()
    assert body["payment_status"] == "paid"
    assert "phone" not in body and "plate_text" not in body \
       and "square_receipt_url" not in body
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd ~/lotlogic-backend && python -m pytest tests/test_plaza_webhook.py -v`
Expected: FAIL — 404

- [ ] **Step 3: Implement the webhook + status endpoint**

```python
@router.post("/webhook")
async def square_webhook(request: Request):
    raw = await request.body()                      # RAW body before any parse
    sig = request.headers.get("x-square-hmacsha256-signature", "")
    if not sq.verify_webhook_signature(raw_body=raw, signature=sig):
        log.warning("plaza webhook: signature verification FAILED")
        raise HTTPException(400, "bad_signature")

    import json
    payload = json.loads(raw or b"{}")
    obj = (payload.get("data") or {}).get("object") or {}
    payment_id = ((obj.get("payment") or {}).get("id"))
    if not payment_id:
        return {"ok": True, "noop": "no_payment_id"}

    payment = sq.fetch_payment(payment_id)          # re-fetch: never trust body
    if not payment:
        return {"ok": True, "noop": "payment_not_found"}

    with engine.begin() as conn:
        pp = conn.execute(text(
            "SELECT id FROM plaza_payments WHERE square_order_id = :oid"
        ), {"oid": payment.get("order_id")}).mappings().first()
    if not pp:
        return {"ok": True, "noop": "unknown_order"}   # 200, never 500

    try:
        from services.plaza_settle import settle_payment
        out = settle_payment(engine, plaza_payment_id=str(pp["id"]),
                             square_payment=payment)
        if out["outcome"] == "created":
            from services.plaza_notify import send_paid_receipt_sms
            try:
                send_paid_receipt_sms(str(pp["id"]))
            except Exception:
                log.exception("plaza webhook: receipt SMS failed (non-fatal)")
        log.info("plaza webhook settle pp=%s outcome=%s", pp["id"], out["outcome"])
    except Exception:
        log.exception("plaza webhook: settle raised for pp=%s", pp["id"])
    return {"ok": True}                              # ALWAYS 200

@router.get("/payments/{plaza_payment_id}/status")
async def payment_status(plaza_payment_id: str):
    """Public, keyed by FULL uuid, status only — no PII, no receipt URL."""
    with engine.begin() as conn:
        row = conn.execute(text("""
            SELECT pp.payment_status,
                   (vp.id IS NOT NULL AND vp.status='active') AS pass_active
              FROM plaza_payments pp
              LEFT JOIN visitor_passes vp ON vp.id = pp.pass_id
             WHERE pp.id = :id
        """), {"id": plaza_payment_id}).mappings().first()
    if not row:
        raise HTTPException(404, "not_found")
    return {"payment_status": row["payment_status"],
            "pass_active": bool(row["pass_active"])}
```

- [ ] **Step 4: Add the three public paths to the auth-exempt allow-list in `main.py`**

The webhook's auth is the Square signature in-handler, never the middleware. A new router outside `/app/*` would 401 today.
```python
PUBLIC_PATHS = {
    ...,
    "/plaza/quote-and-start",
    "/plaza/webhook",
}
PUBLIC_PATH_PREFIXES = (..., "/plaza/payments/")
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd ~/lotlogic-backend && python -m pytest tests/test_plaza_webhook.py -v`
Expected: 6 passed

- [ ] **Step 6: Commit**

```bash
cd ~/lotlogic-backend && git add routers/plaza_payments.py main.py tests/test_plaza_webhook.py && \
git commit -m "feat(pay2park): signature-verified webhook, status endpoint, auth allow-list"
```

---

### Task 7: Reconciliation sweep + orphan TTL

**Files:**
- Create: `lotlogic-backend/services/plaza_sweep.py`
- Modify: `lotlogic-backend/main.py` (lifespan task, mirroring `pass_expiry`)
- Test: `lotlogic-backend/tests/test_plaza_sweep.py`

**Interfaces:**
- Produces: `async def sweep_pending_payments(engine) -> dict` → `{"checked","settled","abandoned"}`

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_plaza_sweep.py
import pytest
from services.plaza_sweep import sweep_pending_payments

@pytest.mark.asyncio
async def test_sweep_recovers_dropped_webhook(engine, pending_payment_2min_old, sq_stub_completed):
    out = await sweep_pending_payments(engine)
    assert out["settled"] == 1
    assert count_passes(pending_payment_2min_old.id) == 1

@pytest.mark.asyncio
async def test_sweep_skips_rows_younger_than_floor(engine, pending_payment_10s_old, sq_stub_completed):
    out = await sweep_pending_payments(engine)
    assert out["checked"] == 0

@pytest.mark.asyncio
async def test_sweep_marks_stale_rows_abandoned(engine, pending_payment_25h_old, sq_stub_none):
    out = await sweep_pending_payments(engine)
    assert out["abandoned"] == 1
    assert get_payment(pending_payment_25h_old.id).payment_status == "abandoned"

@pytest.mark.asyncio
async def test_sweep_uses_one_list_call_not_n_gets(engine, many_pending, sq_call_counter):
    await sweep_pending_payments(engine)
    assert sq_call_counter.list_payments == 1
    assert sq_call_counter.get_payment == 0

@pytest.mark.asyncio
async def test_sweep_survives_square_outage(engine, pending_payment_2min_old, sq_stub_raises):
    out = await sweep_pending_payments(engine)      # must not raise
    assert out["settled"] == 0
    assert get_payment(pending_payment_2min_old.id).payment_status == "pending"
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd ~/lotlogic-backend && python -m pytest tests/test_plaza_sweep.py -v`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the sweep**

```python
"""Reconciliation backstop for dropped Square webhooks.

Load discipline (§13.8): ONE Square list call per sweep, bounded working set,
indexed predicate, per-row guards. This DB has wedged on periodic load before.
"""
import logging
from datetime import datetime, timedelta, timezone
from sqlalchemy import text

log = logging.getLogger(__name__)

FLOOR_SECONDS = 90          # ignore rows younger than this (webhook's turn)
WINDOW_HOURS = 24           # bound the working set
BATCH_LIMIT = 200

async def sweep_pending_payments(engine) -> dict:
    from services import square as sq
    from services.plaza_settle import settle_payment

    now = datetime.now(timezone.utc)
    with engine.begin() as conn:
        rows = conn.execute(text("""
            SELECT id, square_order_id, created_at
              FROM plaza_payments
             WHERE payment_status = 'pending'
               AND created_at < now() - make_interval(secs => :floor)
               AND created_at > now() - make_interval(hours => :window)
               AND square_order_id IS NOT NULL
             ORDER BY created_at
             LIMIT :lim
        """), {"floor": FLOOR_SECONDS, "window": WINDOW_HOURS,
               "lim": BATCH_LIMIT}).mappings().all()

        stale = conn.execute(text("""
            UPDATE plaza_payments
               SET payment_status = 'abandoned'
             WHERE payment_status = 'pending'
               AND created_at <= now() - make_interval(hours => :window)
            RETURNING id
        """), {"window": WINDOW_HOURS}).rowcount or 0

    if not rows:
        return {"checked": 0, "settled": 0, "abandoned": stale}

    begin = (now - timedelta(hours=WINDOW_HOURS)).isoformat()
    try:
        payments = sq.list_recent_payments(begin)      # ONE call
    except Exception:
        log.exception("plaza sweep: Square unavailable; leaving rows pending")
        return {"checked": len(rows), "settled": 0, "abandoned": stale}

    by_order = {p["order_id"]: p for p in payments if p.get("order_id")}
    settled = 0
    for r in rows:
        p = by_order.get(r["square_order_id"])
        if not p:
            continue
        try:
            out = settle_payment(engine, plaza_payment_id=str(r["id"]), square_payment=p)
            if out["outcome"] == "created":
                settled += 1
                from services.plaza_notify import send_paid_receipt_sms
                try:
                    send_paid_receipt_sms(str(r["id"]))
                except Exception:
                    log.exception("plaza sweep: receipt SMS failed (non-fatal)")
        except Exception:
            log.exception("plaza sweep: settle failed for %s", r["id"])

    log.info("plaza sweep checked=%d settled=%d abandoned=%d", len(rows), settled, stale)
    return {"checked": len(rows), "settled": settled, "abandoned": stale}
```

Wire into `main.py` lifespan on a 120s loop, same shape as `services/pass_expiry.py`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/lotlogic-backend && python -m pytest tests/test_plaza_sweep.py -v`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
cd ~/lotlogic-backend && git add services/plaza_sweep.py main.py tests/test_plaza_sweep.py && \
git commit -m "feat(pay2park): reconciliation sweep with one-call batching and orphan TTL"
```

---

### Task 8: SMS receipt (the driver's independent confirmation)

The single highest-value UX mitigation (§13.7) — it survives a dead redirect, a closed tab, and bad LTE. It *is* the receipt.

**Files:**
- Create: `lotlogic-backend/services/plaza_notify.py`
- Test: `lotlogic-backend/tests/test_plaza_notify.py`

**Interfaces:**
- Produces: `send_paid_receipt_sms(plaza_payment_id: str) -> bool`

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_plaza_notify.py
from services.plaza_notify import send_paid_receipt_sms

def test_receipt_sms_contains_amount_expiry_and_nonrefundable(paid_payment, sms_spy):
    assert send_paid_receipt_sms(paid_payment.id) is True
    body = sms_spy.last_body
    assert "$15" in body
    assert "Charlotte Travel Plaza" in body
    assert "non-refundable" in body.lower()

def test_receipt_sms_not_sent_when_unpaid(pending_payment, sms_spy):
    assert send_paid_receipt_sms(pending_payment.id) is False
    assert sms_spy.last_body is None
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd ~/lotlogic-backend && python -m pytest tests/test_plaza_notify.py -v`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```python
"""Driver-facing receipt. Independent of the browser redirect."""
import logging
from sqlalchemy import text
from db import engine
from services.sms import send_sms

log = logging.getLogger(__name__)

def send_paid_receipt_sms(plaza_payment_id: str) -> bool:
    with engine.begin() as conn:
        row = conn.execute(text("""
            SELECT pp.phone, pp.amount_cents, pp.plate_text,
                   vp.valid_until, p.name AS property_name
              FROM plaza_payments pp
              JOIN visitor_passes vp ON vp.id = pp.pass_id
              JOIN properties p ON p.id = pp.property_id
             WHERE pp.id = :id AND pp.payment_status = 'paid'
        """), {"id": plaza_payment_id}).mappings().first()
    if not row:
        return False

    dollars = f"${row['amount_cents'] // 100}"
    until = row["valid_until"].strftime("%a %-I:%M%p").replace("AM", "a").replace("PM", "p")
    body = (f"{dollars} paid — {row['plate_text']} parked at {row['property_name']} "
            f"until {until}. Non-refundable; plaza rules still apply.")
    send_sms(to=row["phone"], body=body)
    log.info("plaza receipt SMS sent pp=%s", plaza_payment_id)
    return True
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/lotlogic-backend && python -m pytest tests/test_plaza_notify.py -v`
Expected: 2 passed

- [ ] **Step 5: Commit**

```bash
cd ~/lotlogic-backend && git add services/plaza_notify.py tests/test_plaza_notify.py && \
git commit -m "feat(pay2park): SMS receipt on pass creation"
```

---

### Task 9: Admin refund endpoint (platform-admin only)

**Files:**
- Modify: `lotlogic-backend/routers/plaza_payments.py`
- Test: `lotlogic-backend/tests/test_plaza_refund.py`

**Interfaces:**
- Produces: `POST /plaza/payments/{id}/refund` (auth: `require_platform_admin`)

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_plaza_refund.py
def test_refund_requires_platform_admin(client, paid_payment, partner_jwt):
    r = client.post(f"/plaza/payments/{paid_payment.id}/refund",
                    headers={"Authorization": f"Bearer {partner_jwt}"})
    assert r.status_code in (401, 403)

def test_refund_marks_refunded_and_cancels_pass(client, paid_payment, admin_jwt, sq_stub):
    r = client.post(f"/plaza/payments/{paid_payment.id}/refund",
                    headers={"Authorization": f"Bearer {admin_jwt}"})
    assert r.status_code == 200
    assert get_payment(paid_payment.id).payment_status == "refunded"
    assert get_pass(paid_payment.pass_id).status == "cancelled"

def test_double_refund_is_idempotent(client, paid_payment, admin_jwt, sq_stub):
    client.post(f"/plaza/payments/{paid_payment.id}/refund",
                headers={"Authorization": f"Bearer {admin_jwt}"})
    r2 = client.post(f"/plaza/payments/{paid_payment.id}/refund",
                     headers={"Authorization": f"Bearer {admin_jwt}"})
    assert r2.status_code == 409
    assert sq_stub.refund_calls == 1
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd ~/lotlogic-backend && python -m pytest tests/test_plaza_refund.py -v`
Expected: FAIL — 404

- [ ] **Step 3: Implement**

```python
from services.auth import require_platform_admin, Subject
from fastapi import Depends

@router.post("/payments/{plaza_payment_id}/refund")
async def refund(plaza_payment_id: str,
                 subject: Subject = Depends(require_platform_admin)):
    """Operational safety valve for a true processing error (e.g. double
    charge). NOT a customer-facing refund — policy is no refunds (§6)."""
    with engine.begin() as conn:
        row = conn.execute(text("""
            SELECT id, square_payment_id, amount_cents, pass_id
              FROM plaza_payments
             WHERE id = :id AND payment_status = 'paid'
             FOR UPDATE
        """), {"id": plaza_payment_id}).mappings().first()
        if not row:
            raise HTTPException(409, "not_refundable")

        sq.refund_payment(payment_id=row["square_payment_id"],
                          amount_cents=row["amount_cents"],
                          idempotency_key=f"refund-{plaza_payment_id}")

        conn.execute(text("""
            UPDATE plaza_payments
               SET payment_status='refunded', refunded_at=now(),
                   refund_amount_cents=:amt
             WHERE id=:id
        """), {"amt": row["amount_cents"], "id": plaza_payment_id})

        if row["pass_id"]:
            conn.execute(text("""
                UPDATE visitor_passes SET status='cancelled', cancelled_at=now()
                 WHERE id=:pid AND status='active'
            """), {"pid": row["pass_id"]})

    log.info("plaza refund issued pp=%s by=%s", plaza_payment_id, subject.id)
    return {"ok": True, "refunded_cents": row["amount_cents"]}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/lotlogic-backend && python -m pytest tests/test_plaza_refund.py -v`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
cd ~/lotlogic-backend && git add routers/plaza_payments.py tests/test_plaza_refund.py && \
git commit -m "feat(pay2park): admin-only refund with deterministic idempotency"
```

---

### Task 10: Frontend — `visit.html` paid branch, persisted key, return polling

**Files:**
- Modify: `lotlogic/frontend/visit.html` (truck-plaza branch ~461-571, submit ~677-741, add return handler)

**Interfaces:**
- Consumes: `POST /plaza/quote-and-start`, `GET /plaza/payments/{id}/status`

- [ ] **Step 1: Gate the paid branch on the flag**

In `showTruckPlazaForm()`, read `property.pay_to_park_enabled`. When false, render today's free form unchanged. When true, replace the 12/24/36/48 dropdown with two priced options only:
```html
<label><input type="radio" name="duration" value="h24" checked> 24 hours — $15</label>
<label><input type="radio" name="duration" value="h48"> 48 hours — $30</label>
```

- [ ] **Step 2: Persist the idempotency key across the Square redirect**

```javascript
// Survives the full-page redirect to Square and any reload (§13.6).
function plazaIdempotencyKey(formSig) {
  const k = 'plaza_idem_' + formSig;
  let v = null;
  try { v = sessionStorage.getItem(k); } catch (e) {}
  if (!v) {
    v = (crypto.randomUUID && crypto.randomUUID()) ||
        (Date.now() + '-' + Math.random().toString(36).slice(2));
    try { sessionStorage.setItem(k, v); } catch (e) {}
  }
  return v;
}
// formSig = hash of plate+backPlate+phone+company+driver+duration, so the key
// changes only when the submitted data changes.
```

- [ ] **Step 3: Add the pre-payment acknowledgment (§13.13)**

Above the pay button, a required checkbox:
> "I understand payment is **non-refundable**, does **not** exempt my vehicle from the parking policies, and that violating any rule may result in towing at my expense."

Block submit until checked.

- [ ] **Step 4: Submit → redirect to Square**

```javascript
const res = await fetch(BACKEND_URL + '/plaza/quote-and-start', {
  method: 'POST', headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({
    property_id: property.id, duration: selectedDuration,
    plate_text: plate, back_plate: backPlate, phone: phone,
    company_name: company, visitor_name: driver,
    policy_acknowledged: true, idempotency_key: idemKey,
    recaptcha_token: await getRecaptchaToken('plaza_pay'),
  }),
});
const data = await res.json();
if (!res.ok) { showError(data.detail || 'Could not start payment.'); return; }
window.location.href = data.checkout_url;
```

- [ ] **Step 5: Add the return-from-Square polling handler**

```javascript
// Never paint "paid" from a query param — poll the server for truth (§13.11).
async function handlePlazaReturn(ppId) {
  showPending('Confirming your payment…');
  for (let i = 0; i < 10; i++) {                  // ~20s
    try {
      const r = await fetch(BACKEND_URL + '/plaza/payments/' + ppId + '/status');
      if (r.ok) {
        const s = await r.json();
        if (s.pass_active) { showSuccessPaid(); return; }
        if (s.payment_status === 'failed') { showError('Payment did not go through.'); return; }
      }
    } catch (e) {}
    await new Promise(r => setTimeout(r, 2000));
  }
  showPending("Payment received — your pass is being activated and we've texted " +
              "you a confirmation. You're okay to park.");
}
const ppId = new URLSearchParams(location.search).get('plaza_payment_id');
if (ppId) handlePlazaReturn(ppId);
```

- [ ] **Step 6: Verify in a browser against sandbox**

Load `visit.html?qr=<plaza>` with the flag on; confirm two priced options, the ack gate, redirect to Square sandbox, and the return page reaching "registered".

- [ ] **Step 7: Commit**

```bash
cd ~/lotlogic && git add frontend/visit.html && \
git commit -m "feat(pay2park): paid QR branch, persisted idempotency key, return polling"
```

---

### Task 11: Dashboard — paid stamp, revenue stat, "payment processing" strip

**Files:**
- Modify: `lotlogic-backend/routers/visitor_passes.py` (parking-log JSON ~398-428; CSV ~170/356)
- Modify: `lotlogic/frontend/dashboard.html`

- [ ] **Step 1: Add the payment JOIN to the parking-log query**

```sql
LEFT JOIN plaza_payments pp ON pp.id = vp.plaza_payment_id
```
Select `pp.amount_cents AS paid_amount_cents, pp.square_receipt_url, pp.payment_status`. Reading through the JOIN keeps `plaza_payments` the single source of truth (no drift on refund — §13.10).

- [ ] **Step 2: Update the CSV columns in lockstep**

Add the header to `_LOG_CSV_COLUMNS` **and** the matching value in `_row_to_csv` in the same edit — they are positional; a mismatch right-shifts every column in the auditor export.

- [ ] **Step 3: Render the paid stamp**

```jsx
{r.paid_amount_cents && (
  <span className="paid-stamp">
    ${(r.paid_amount_cents / 100).toFixed(0)} · {r.stay_days === 2 ? '48h' : '24h'} ·
    paid {fmtTime(r.paid_at)}
    {r.square_receipt_url &&
      <a href={r.square_receipt_url} target="_blank" rel="noopener">receipt</a>}
  </span>
)}
```

- [ ] **Step 4: Add the revenue stat**

Header stat reading `plaza_payments WHERE payment_status='paid'`: "Today: N passes · $X collected" + month-to-date.

- [ ] **Step 5: Add the "payment processing — hold off" strip (§13.7)**

Above the roster, when any `plaza_payments` row is `pending` and < 15 min old:
```jsx
<div className="processing-strip">
  ⏳ {n} payment{n>1?'s':''} processing — pass{n>1?'es':''} activating. Don't tow.
</div>
```
This is the false-tow guard: it makes a just-paid truck visible to Frank *before* the pass exists.

- [ ] **Step 6: Verify on the dashboard against sandbox data**

- [ ] **Step 7: Commit**

```bash
cd ~/lotlogic-backend && git add routers/visitor_passes.py && \
git commit -m "feat(pay2park): expose payment fields on parking log"
cd ~/lotlogic && git add frontend/dashboard.html && \
git commit -m "feat(pay2park): paid stamp, revenue stat, payment-processing strip"
```

---

### Task 12: Square sandbox failure matrix — **the gate before any real money**

Nothing proceeds past this task until every row is green.

**Files:**
- Create: `lotlogic-backend/tests/test_plaza_sandbox_matrix.py`
- Create: `lotlogic/docs/superpowers/plans/pay2park-sandbox-results.md`

- [ ] **Step 1: Configure sandbox credentials (Gabe, account-side)**

Square Sandbox: access token, location id, a webhook subscription for `payment.updated` pointed at the sandbox backend URL, and that subscription's signature key. Set `SQUARE_ENVIRONMENT=sandbox`. **Never enter production credentials at this stage.**

- [ ] **Step 2: Run the full matrix and record each result**

| # | Scenario | Expected |
|---|---|---|
| 1 | Happy path 24h | 1 pass, `$15`, `valid_until = paid_at+24h`, SMS sent |
| 2 | Happy path 48h | 1 pass, `$30`, `+48h` |
| 3 | Webhook replay ×5 | exactly 1 pass, 1 charge, 1 `pass_id` |
| 4 | Webhook dropped | sweep creates the pass within ~2 min |
| 5 | Card declined | no pass, `payment_status='failed'` |
| 6 | Abandon at Square | no pass; row `abandoned` after TTL |
| 7 | Double-tap submit | 1 `plaza_payments`, 1 order, 1 charge |
| 8 | Back-button + resubmit | same key reused → same checkout, no 2nd charge |
| 9 | Tampered amount (`amount_cents:1`) | server ignores it, charges $15 |
| 10 | Forged/unsigned webhook | 400, no pass |
| 11 | Refunded payment then webhook | no pass created |
| 12 | Cooldown violator pays | pass created **+ red TOW flag** + no refund |
| 13 | Plate on active hold | blocked at quote-and-start, **no charge** |
| 14 | Square API down during sweep | rows stay `pending`, no crash, retries next cycle |
| 15 | Flag off mid-flight | new starts 503; in-flight payments still settle |

- [ ] **Step 3: Verify the live DB invariants after the matrix**

```sql
-- every paid row has exactly one pass; no orphan passes
SELECT count(*) FROM plaza_payments WHERE payment_status='paid' AND pass_id IS NULL
  AND needs_manual_review IS NULL;                     -- expect 0
SELECT count(*) FROM visitor_passes vp
  WHERE vp.registration_source='qr_paid' AND vp.plaza_payment_id IS NULL;  -- expect 0
-- no duplicate passes per payment
SELECT pass_id, count(*) FROM plaza_payments WHERE pass_id IS NOT NULL
 GROUP BY pass_id HAVING count(*) > 1;                 -- expect 0 rows
```

- [ ] **Step 4: Record results and commit**

```bash
cd ~/lotlogic && git add docs/superpowers/plans/pay2park-sandbox-results.md && \
git commit -m "test(pay2park): sandbox failure matrix results — all green"
```

---

### Task 13: Observability, reconciliation job, and staged production rollout

**Files:**
- Modify: `lotlogic-db-monitor` (money alerts)
- Create: `lotlogic-backend/services/plaza_reconcile.py` (daily 3-way check)
- Modify: `lotlogic/docs/superpowers/specs/2026-09-01-truck-plaza-pay-to-park-design.md` (record go-live)

- [ ] **Step 1: Wire the money alerts (§13.12)**

- any `plaza_payments` `pending` > 10 min → alert (the false-tow early warning)
- any webhook signature failure → alert
- N consecutive Square API errors in the sweep → alert
- any row with `needs_manual_review NOT NULL` → alert

- [ ] **Step 2: Implement the daily 3-way reconciliation**

Compare, for the prior day: Square settlements total ↔ `SUM(plaza_payments WHERE payment_status='paid')` ↔ `COUNT(visitor_passes WHERE plaza_payment_id IS NOT NULL)`. Any mismatch → alert. This also produces the 25% / 75% payout figure.

- [ ] **Step 3: Deploy in the mandated order (§13.9)**

1. Migrations applied (Task 1) ✔
2. Backend deployed, flag **off** — webhook + sweep live but no entrance
3. Square **production** webhook subscription + secrets set; verify with Square's "send test event"
4. Frontend deployed, paid branch gated on the flag
5. **Flip `pay_to_park_enabled = true` for the plaza — last**

- [ ] **Step 4: One real $1 shadow charge before going to $15/$30**

Temporarily price a single test transaction at $1 on a real card, confirm end-to-end (pass, SMS, dashboard, receipt), refund it via the admin endpoint, then restore $15/$30.

- [ ] **Step 5: Watch the first day**

Monitor the ledger (`~/lotlogic-agent/pay2park/OPEN-FINDINGS.md`), the alerts, and the daily reconciliation. Rollback = flip the flag off; the webhook and sweep keep running so in-flight payments still settle.

- [ ] **Step 6: Commit**

```bash
cd ~/lotlogic-backend && git add services/plaza_reconcile.py && \
git commit -m "feat(pay2park): daily 3-way reconciliation and money alerts"
```

---

## Self-Review

**Spec coverage:** §3 schematic → Tasks 4–7, 10. §4 data model → Task 1 (with §13.10 corrections: no `paid_amount_cents`, partial unique index, RLS both ways). §5 Square + reliability → Tasks 2, 4, 6, 7. §6 no-refunds → Task 9 (admin-only valve). §7 reconciliation/payout → Task 13. §8 dashboard → Task 11. §10 test plan → Task 12. §12 disclaimer → applied to `properties.policy_text` during Task 13 Step 3 alongside the flag flip. §13.0–13.13 → distributed as noted per task.

**Placeholder scan:** none — every code step carries real, runnable content.

**Type consistency:** `settle_payment(engine, *, plaza_payment_id, square_payment) -> {"outcome","pass_id"}` is used identically in Tasks 6 and 7. `finalize_truck_plaza_pass(conn, *, pass_id, property_id, plate_text, back_plate, phone, valid_from)` matches between Tasks 3, 4. `sq.list_recent_payments` / `sq.fetch_payment` return the same `_payment_shape` dict consumed by `settle_payment`. `send_paid_receipt_sms(plaza_payment_id)` matches in Tasks 6, 7, 8.

**One gap flagged for the executor:** §12's policy text update (the "8. PAID PARKING — NO REFUNDS" section and the release-of-liability rewrite) is a single `UPDATE properties SET policy_text = …` — it must land in Task 13 Step 3 **before** the flag flip, so no driver can pay under the old rules.
