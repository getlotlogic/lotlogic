# Pay-to-park — Square SANDBOX failure matrix results

**Task 12** of `2026-09-01-truck-plaza-pay-to-park`. Run 2026-09-02, Square
**sandbox** only. No production credential, no live database, no deploy, no real
card, no real money.

**Result: 21 of 22 checks pass. Row 7 (double-tap submit) FAILS, and its failure
is a money-losing one.** Everything else in the matrix — including all four
recovery paths (dropped webhook, dead tunnel, Square outage, orphan TTL) — behaves
as designed.

---

## 1. What was run against what

| Piece | Value |
|---|---|
| Backend | real `main:app` under uvicorn, `127.0.0.1:8010`, branch `feat/pay-to-park` @ `47cf171` |
| Database | throwaway local PostgreSQL 17 on `127.0.0.1:55432`, loaded with `tests/plaza/schema/live_schema.sql` + all seven `migrations/20260902*.sql` |
| Plaza property | `bd44ace8-…-5d60f65e1712`, `pay_to_park_enabled = true` **in the local database only** |
| Frontend | `frontend/` served at `127.0.0.1:8011` from a **copy** whose `BACKEND_URL` and `SUPABASE_URL` point at localhost; the committed `visit.html` is untouched |
| Webhook path | `cloudflared` quick tunnel → `https://dean-dip-bandwidth-complications.trycloudflare.com/plaza/webhook` |
| Square subscription | `wbhk_13fa13f252b045a0a1cd850f2bfce5a5` — name `pay2park-sandbox-local`, events `payment.created` + `payment.updated`, api_version `2026-08-19` (**left in place**; its notification URL points at a tunnel that no longer exists and must be re-pointed before the next run) |
| Square location | `L362NGGHN0HP7` (sandbox, USD) |
| SMS | dummy Twilio credentials — the receipt is verified **at the call boundary**: the body is logged, the send is attempted, Twilio answers 401 |
| reCAPTCHA | unset with `DEBUG=true` (documented dev fail-open) |

Runner: `tests/plaza/sandbox/test_sandbox_matrix.py` (skipped unless
`PAY2PARK_SANDBOX=1`). Environment: `scripts/pay2park-sandbox.sh {up|down|status}`.

### One thing the Square sandbox does not give you

A sandbox payment-link URL does **not** serve the buyer-facing hosted checkout.
It serves Square's *Checkout API Sandbox Testing Panel*, which simulates a buyer
completing the page (its "Test Payment" button, which Square itself calls "a
one-time operation") and offers a non-payable "Preview Checkout" render of the
real UI. There is no card form to type a declined test card into, and no second
"pay" button to press. Rows **5**, **16** and **17** therefore work with what the
sandbox does expose, and each says below exactly what it did and did not prove.

---

## 2. The matrix

| # | Scenario | Expected | Observed | Result |
|---|---|---|---|---|
| 1 | Happy path 24h | 1 pass, $15, `valid_until = paid_at + 24h`, SMS | `paid`, `amount_cents=1500`, 1 pass, `status=active`, `registration_source=qr_paid`, `valid_from == paid_at`, window **24.00h**, receipt SMS attempted with the right body | **PASS** |
| 2 | Happy path 48h | 1 pass, $30, `+48h` | `paid`, `amount_cents=3000`, window **48.00h**, pass active | **PASS** |
| 3 | Webhook replay ×5 | 1 pass, 1 charge, 1 `pass_id` | 5 × HTTP 200, every outcome `already_settled`; 1 pass, 1 ledger row for the order, `pass_id` unchanged, `needs_manual_review` NULL | **PASS** |
| 4 | Webhook dropped | sweep creates the pass within ~2 min | subscription disabled → **zero** webhook deliveries; the sweep settled it after **98 s**; pass active, receipt attempted | **PASS** |
| 5 | Card declined | no pass, `payment_status='failed'` | no pass; webhook outcome `rejected_not_completed`; row stayed **`pending`** — the implementation deliberately **never writes `'failed'`** (see below) | **PASS** ¹ |
| 6 | Abandon at Square | no pass; row `abandoned` after TTL | row went **`abandoned`**, 0 passes (the sweep's orphan TTL did the write) | **PASS** |
| 7 | Double-tap submit | 1 ledger row, 1 order, 1 charge | 1 ledger row — **but 2 Square payment links on 2 different orders**; only one order id is stored, the other is payable and invisible to the system | **FAIL** |
| 8 | Back-button + resubmit | same key → same checkout, no 2nd charge | both 200, identical `checkout_url` and `plaza_payment_id`, 1 ledger row | **PASS** |
| 9 | Tampered amount (`amount_cents:1`) | server ignores it, charges $15 | HTTP **422** `extra_forbidden` and **no row created** — the field is rejected outright rather than ignored; a clean quote is `amount_cents=1500` | **PASS** ² |
| 10 | Forged / unsigned webhook | 400, no pass | unsigned **400**, garbage signature **400**, attacker-key signature **400**; pass count unchanged | **PASS** |
| 11 | Refunded payment, then webhook | no pass created | webhook 200 `rejected_refunded`, 0 passes, `pass_id` NULL, row `refunded` | **PASS** |
| 12 | Cooldown violator pays | pass + red TOW flag + no refund | `paid`, pass active, `reregistration_flagged_at` **set**, `refunded_at` NULL | **PASS** |
| 13 | Plate on active hold | blocked at quote-and-start, no charge | **409** "This plate is on a 24-hour hold and cannot park yet.", **0** `plaza_payments` rows | **PASS** |
| 14 | Square API down during sweep | rows stay `pending`, no crash, retries | `plaza sweep: Square unavailable; leaving 6 row(s) pending`; row stayed `pending`; process alive, `/health` 200; next sweep ran | **PASS** |
| 15 | Flag off mid-flight | new starts 503; in-flight still settles | new quote **503 `pay_to_park_disabled`**, 0 rows created; the in-flight checkout still settled to `paid` + active pass | **PASS** |
| 16 | Pay the SAME link twice | no second charge (or C1 records it) | Square refuses it: the re-opened link shows the completed state with **no payable button**; 1 pass, `pass_id` stable, no manual-review flag | **PASS** ³ |
| 17 | Payment methods offered | instant-capture rails only, no ACH | Square's stored `accepted_payment_methods` = `{apple_pay: true, google_pay: true, cash_app_pay: false, afterpay_clearpay: false}`; buyer preview renders card fields + a Google Pay button, **no** Cash App Pay, **no** Afterpay/Clearpay, **no** bank/ACH | **PASS** ⁴ |
| 18 | Webhook signature negative/positive | bad → 400, good → accepted | wrong key **400**, right key but wrong notification URL **400**, correct signature **200**; two `outcome=bad_signature` WARNINGs logged | **PASS** |
| 19 | Tunnel dead mid-payment | 120 s sweep settles it | `cloudflared` killed before the capture → 0 webhook lines; sweep settled after **108 s**, pass active | **PASS** |
| 20 | Return page | success copy appears | "You're **registered.** / Payment received. Your parking pass is active. / Pass for Charlotte Travel Plaza — we've texted you a confirmation." 0 JS errors | **PASS** |
| 98 | Square-side reconciliation | Square's ledger matches ours | 12 payments in the window: 10 `COMPLETED` ($165.00), 2 `FAILED`, $15.00 refunded — reconciled below | **PASS** |
| 99 | Post-matrix DB invariants | all zero | `0` / `0` / `0` | **PASS** |

¹ ² ³ ⁴ — see §4.

---

## 3. Row 7 — the one failure, and why it costs money

**What happens.** Two genuinely concurrent `POST /plaza/quote-and-start` calls
carrying the *same* idempotency key. The ledger holds perfectly: one
`plaza_payments` row, exactly as designed. Square does not. Both requests call
`CreatePaymentLink` with the same Square idempotency key before either has
committed, and **Square returns two different payment links on two different
orders**:

```
plaza_payment_id  a043ac5e-3174-4e57-bb5c-f4f14e9c42fd     ← ONE ledger row
  link https://sandbox.square.link/u/49DtCSpS  order vJ74oMcXOtVlxfBrrRrJHqHVTa4F   ← stored
  link https://sandbox.square.link/u/SYNlSyu8  order fBpj0HZ7II78qNKpsbQ3cMsVlb4F   ← ORPHAN
```

The two `UPDATE`s race; last write wins; `plaza_payments.square_order_id` ends up
holding **one** of the two orders. The other link stays live and payable.

**Why that is worse than a double charge.** `square_order_id` is the *only* thing
that maps a Square capture back to a quote — for the webhook (`_ROW_BY_ORDER_SQL`)
and for the sweep (`by_order`) alike. A capture on the orphan link maps to
nothing. Reproduced end-to-end:

```
orphan order   V0fivafpXpY08CL4bLHSzBkjnd4F   (of pp ded10238-55e4-44ff-aa6b-ea29707d8f13)
square payment JQW2zwBgKvWCFMzGXVtdrcrNun6YY  COMPLETED  1500

plaza webhook event=payment.updated payment=JQW2zwBgKvWCFMzGXVtdrcrNun6YY \
  order=V0fivafpXpY08CL4bLHSzBkjnd4F pp=None outcome=unknown_order pass=None

→ HTTP 200 {"ok": true, "noop": "unknown_order"}
→ ledger row stayed payment_status='pending', pass_id NULL, needs_manual_review NULL
→ visitor_passes for that plate: 0  (4 minutes of sweeps later: still 0)
```

So: **$15 captured, no pass, no flag, and the reconciliation sweep cannot recover
it** — it matches on the order id the row does not have. Meanwhile the driver is
redirected to `visit.html?...&plaza_payment_id=<the row>`, whose status poll sees
`pending` and, after its window, tells them *"Payment received — your pass is
being activated… You're okay to park."* A truck sits in the lot with no pass, a
paid receipt, and nothing on any screen saying so.

**Reachability.** This is not exotic. The driver's browser makes both requests
and follows whichever response it gets — including the orphan one. A double-tap
on flaky LTE at the plaza is precisely the scenario `§13.6` was written for.

**Not fixed here.** Task 12 reports; the controller dispatches fixes. For the
record, the shapes worth considering: create the Square link *before* committing
the row (or under a lock), or record every order id a quote ever produced so
`unknown_order` cannot happen, or treat `unknown_order` on a payment whose
`payment_note` carries `plaza:<uuid>` as a recoverable match instead of a no-op —
`create_checkout` already stamps that note on every link.

---

## 4. Footnotes on the four rows that passed with a caveat

**¹ Row 5 — the brief's `payment_status='failed'` does not exist.**
`services/plaza_settle.py` states it outright: *"the ledger never lies:
`payment_status='paid'` is written only when Square says money was captured, and
`'failed'` never is (in this ledger `failed` means no money moved)."* A declined
capture is recorded as the webhook outcome `rejected_not_completed`; the row stays
`pending` and the 24 h orphan TTL closes it as `abandoned` (row 6 proves that
write). The behaviour the brief cared about — **no pass, no money, no lie in the
ledger** — holds. The brief's cell is stale relative to the implemented design;
the ledger is right and the brief should be corrected, not the code.

The decline itself was produced through the Payments API (`cnon:card-nonce-declined`)
against our own order, since the sandbox panel has no card form. Square answered
`GENERIC_DECLINE`, recorded a FAILED payment on the order, and fired
`payment.created` exactly as a declined buyer would.

**² Row 9 — stricter than the brief asked.** The brief expected the server to
*ignore* a client-sent `amount_cents`. `QuoteStartRequest` has
`model_config = ConfigDict(extra="forbid")`, so it is a **422 with no row
created** instead. That is the stronger behaviour: an attacker learns nothing and
leaves no pending row behind. Price integrity separately confirmed — a clean
`h24` quote is `amount_cents=1500`, server-derived.

**³ Row 16 — the C1 precondition could not be forced in sandbox.** Square's
sandbox panel allows one test payment per link, so no second capture on a paid
link could be attempted. What was proven: re-opening a paid link presents the
completed state with no payable control, and our row stayed at one pass with a
stable `pass_id`. **What remains unproven: whether a production Square quick-pay
link accepts a second capture.** The `duplicate_capture` path (C1) that would
handle it is covered by unit tests, not by this run. Row 7's orphan-order finding
is the nearer and more likely double-charge route, and it is real.

**⁴ Row 17 — methods verified two ways, instant capture proven for one.**
Square's own stored `checkout_options.accepted_payment_methods` for the link
confirms I1's pinning arrived intact, and the buyer preview renders card fields
plus a Google Pay button and nothing else — importantly **no bank/ACH option**,
which is the location-level setting `services/square.py` warns about. Apple Pay
does not render in headless Chromium (it is a Safari/device capability), so its
absence there is not evidence either way. **Instant capture is proven for the
card rail only** — rows 1, 2, 12 and 15 each went from capture to an active pass
within seconds. Apple Pay and Google Pay rest on Square's contract, not on this
run.

---

## 5. Post-matrix invariants (run against the LOCAL sandbox database)

```sql
-- every paid row has exactly one pass; no orphan passes
SELECT count(*) FROM plaza_payments WHERE payment_status='paid' AND pass_id IS NULL
  AND needs_manual_review IS NULL;                     -- 0  ✅
SELECT count(*) FROM visitor_passes vp
  WHERE vp.registration_source='qr_paid' AND vp.plaza_payment_id IS NULL;  -- 0  ✅
-- no duplicate passes per payment
SELECT pass_id, count(*) FROM plaza_payments WHERE pass_id IS NOT NULL
 GROUP BY pass_id HAVING count(*) > 1;                 -- 0 rows  ✅
```

Ledger at the end of the run:

| `payment_status` | rows | cents |
|---|---|---|
| `paid` | 7 | 12000 |
| `pending` | 10 | 15000 |
| `abandoned` | 1 | 1500 |
| `refunded` | 1 | 1500 |

The `pending` rows are quotes the matrix deliberately never paid (rows 5, 7, 8,
9, 13, 14, 17 and their probes) — that is the correct resting state for an
unpaid quote until its TTL.

## 6. Square-side view of the run window

`payments.list(begin_time = 2026-09-02T16:58:58Z, location = L362NGGHN0HP7)`:

| | |
|---|---|
| payments | 12 |
| statuses | `COMPLETED` 10, `FAILED` 2 |
| completed | $165.00 |
| refunded | $15.00 |

Reconciled against the local ledger ($120.00 across 7 `paid` rows):

| Square captures | $ | accounted for by |
|---|---|---|
| 7 settled quotes | 120.00 | the 7 local `paid` rows |
| row 11's capture | 15.00 | refunded before settle → local row is `refunded`, not `paid` (correct) |
| row 7's orphan-link capture | 15.00 | **unaccounted for in the ledger — the row 7 defect** |
| pre-matrix smoke payment | 15.00 | one end-to-end payment taken before the matrix truncated the ledger |
| **total** | **165.00** | ✅ |

The two `FAILED` payments are row 5's decline and its earlier probe. **Every cent
Square holds is explained, and exactly one of them — the orphan capture — is
explained by a defect rather than by design.**

---

## 7. What this run does *not* cover

* **Railway's proxy.** `SQUARE_NOTIFICATION_URL` was a cloudflared hostname, not
  Railway's. §13.3's "does the notification URL survive the proxy byte-identically"
  is Task 13's post-deploy *Send test event*, per R41.
* **Real Twilio.** The receipt is verified at the call boundary (body logged, send
  attempted, 401 from Twilio's API). Delivery to a real handset is Task 13's.
* **The production hosted checkout.** See ³ — the sandbox substitutes a testing
  panel for the buyer page, so second-capture behaviour and the Apple/Google Pay
  rails are not exercised.
* **Refund endpoint over HTTP.** `POST /plaza/payments/{id}/refund` was not driven
  in this matrix; the refund path is covered by the 18 unit tests from Task 9, and
  row 11 exercised a Square-side refund end-to-end through the settle path.

## 8. Reproducing this

```bash
cd ~/lotlogic-backend-pay2park
scripts/pay2park-sandbox.sh up            # postgres + static + tunnel + subscription + uvicorn
PAY2PARK_SANDBOX=1 .venv/bin/pytest tests/plaza/sandbox/test_sandbox_matrix.py -q -s
scripts/pay2park-sandbox.sh down          # leaves the Square subscription in place
```

`up` re-points the standing Square subscription at the new tunnel URL and rotates
its signature key, so each run is self-contained. Square credentials come from
`.env.local` (git-ignored, sandbox-only, never printed). Nothing in this
environment can reach the live Supabase project or a production Square account.
