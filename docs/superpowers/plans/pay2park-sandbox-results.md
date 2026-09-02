# Pay-to-park — Square SANDBOX failure matrix results

**Task 12** of `2026-09-01-truck-plaza-pay-to-park`. Run 2026-09-02, Square
**sandbox** only. No production credential, no live database, no deploy, no real
card, no real money.

**Result: 22 of 22 checks pass, plus one new row.** The first run found **row 7
(double-tap submit) failing, and failing by losing money**. Ruling **R49** fixed
it, and the affected rows were re-run against the fix:

| | |
|---|---|
| Run 1 (backend `90ca4ca`) | 21 of 22 — **row 7 FAIL** |
| Re-run after R49 (backend `a1afd8d`) | rows **1, 3, 4, 7, 8, 19** re-run + new row **23** — **all PASS**, zero unexplained cents at Square |

Everything else in the matrix — including all four recovery paths (dropped
webhook, dead tunnel, Square outage, orphan TTL) — behaved as designed in run 1
and was not re-run.

---

## 1. What was run against what

| Piece | Value |
|---|---|
| Backend | real `main:app` under uvicorn, `127.0.0.1:8010`, branch `feat/pay-to-park` @ `47cf171` (run 1) / `a1afd8d` (re-run, with R49) |
| Database | throwaway local PostgreSQL 17 on `127.0.0.1:55432`, loaded with `tests/plaza/schema/live_schema.sql` + all seven `migrations/20260902*.sql` |
| Plaza property | `bd44ace8-…-5d60f65e1712`, `pay_to_park_enabled = true` **in the local database only** |
| Frontend | `frontend/` served at `127.0.0.1:8011` from a **copy** whose `BACKEND_URL` and `SUPABASE_URL` point at localhost; the committed `visit.html` is untouched |
| Webhook path | `cloudflared` quick tunnel → `https://dean-dip-bandwidth-complications.trycloudflare.com/plaza/webhook` (run 1); `https://safely-theology-princeton-cord.trycloudflare.com/plaza/webhook` (re-run) |
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
| 3 | Webhook replay ×5 | 1 pass, 1 charge, 1 `pass_id` | 5 × HTTP 200, every outcome `already_settled`; 1 pass, 1 ledger row for the order, `pass_id` unchanged, `needs_manual_review` NULL — **identical on the re-run** | **PASS** ⁵ |
| 4 | Webhook dropped | sweep creates the pass within ~2 min | subscription disabled → **zero** webhook deliveries; the sweep settled it after **98 s** (re-run: **171 s**, still inside one FLOOR+interval window); pass active, receipt attempted | **PASS** ⁵ |
| 5 | Card declined | **no pass; the row stays `pending` and the 24 h TTL closes it as `abandoned`** — the ledger never writes `'failed'` (R50) | no pass; webhook outcome `rejected_not_completed`; row stayed `pending` | **PASS** ¹ |
| 6 | Abandon at Square | no pass; row `abandoned` after TTL | row went **`abandoned`**, 0 passes (the sweep's orphan TTL did the write) | **PASS** |
| 7 | Double-tap submit | 1 ledger row, 1 order, 1 charge | **Run 1: FAIL** — 1 ledger row but **2 Square links on 2 orders**, one of them payable and invisible to the ledger. **Re-run after R49a: PASS** — both requests 200 with the same `plaza_payment_id` and the same `checkout_url`; Square's own Orders API reports **1** order created in the closed window and it is the one the row stores, and Square minted **1** payment link in that window | **PASS** ⁵ |
| 8 | Back-button + resubmit | same key → same checkout, no 2nd charge | both 200, identical `checkout_url` and `plaza_payment_id`, 1 ledger row — **identical on the re-run** | **PASS** ⁵ |
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
| 19 | Tunnel dead mid-payment | 120 s sweep settles it | `cloudflared` killed before the capture → 0 webhook lines; sweep settled after **108 s** (re-run: **107 s**), pass active | **PASS** ⁵ |
| 23 | Orphan capture recovered by the payment note (new, R49b) | a capture on an order the ledger never stored still becomes a pass | second link built by hand for a live pending quote — same `payment_note`, different order — then paid. The webhook's order lookup found nothing, the note mapped it home: `paid`, **1** pass active, `needs_manual_review` NULL, and the row's `square_order_id` moved from `F668bg…` (the quote's own link, never paid) to `77lcnt…` (the order that actually took the money). `mapped_by=note` logged; **no** orphan alert | **PASS** ⁵ |
| 20 | Return page | success copy appears | "You're **registered.** / Payment received. Your parking pass is active. / Pass for Charlotte Travel Plaza — we've texted you a confirmation." 0 JS errors | **PASS** |
| 98 | Square-side reconciliation | Square's ledger matches ours | 12 payments in the window: 10 `COMPLETED` ($165.00), 2 `FAILED`, $15.00 refunded — reconciled below | **PASS** |
| 99 | Post-matrix DB invariants | all zero | `0` / `0` / `0` | **PASS** |

¹ ² ³ ⁴ — see §4.  ⁵ — re-run after R49; see §3.

---

## 3. Row 7 — the failure, and the fix (R49)

### 3a. What run 1 found

Two genuinely concurrent `POST /plaza/quote-and-start` calls carrying the *same*
idempotency key. The ledger held perfectly: one `plaza_payments` row, exactly as
designed. Square did not. Both requests called `CreatePaymentLink` with the same
Square idempotency key before either had committed, and **Square returned two
different payment links on two different orders**:

```
plaza_payment_id  a043ac5e-3174-4e57-bb5c-f4f14e9c42fd     ← ONE ledger row
  link https://sandbox.square.link/u/49DtCSpS  order vJ74oMcXOtVlxfBrrRrJHqHVTa4F   ← stored
  link https://sandbox.square.link/u/SYNlSyu8  order fBpj0HZ7II78qNKpsbQ3cMsVlb4F   ← ORPHAN
```

The two `UPDATE`s raced; last write won; the other link stayed live and payable.
`square_order_id` was the *only* thing mapping a Square capture back to a quote —
for the webhook (`_ROW_BY_ORDER_SQL`) and the sweep (`by_order`) alike — so a
capture on the orphan link mapped to nothing. Reproduced end-to-end:

```
orphan order   V0fivafpXpY08CL4bLHSzBkjnd4F   (of pp ded10238-55e4-44ff-aa6b-ea29707d8f13)
square payment JQW2zwBgKvWCFMzGXVtdrcrNun6YY  COMPLETED  1500

plaza webhook event=payment.updated payment=JQW2zwBgKvWCFMzGXVtdrcrNun6YY \
  order=V0fivafpXpY08CL4bLHSzBkjnd4F pp=None outcome=unknown_order pass=None

→ HTTP 200 {"ok": true, "noop": "unknown_order"}
→ ledger row stayed payment_status='pending', pass_id NULL, needs_manual_review NULL
→ visitor_passes for that plate: 0  (4 minutes of sweeps later: still 0)
```

**$15 captured, no pass, no flag, no recovery path** — and the driver, redirected
to `visit.html?...&plaza_payment_id=<the row>`, was told *"Payment received —
your pass is being activated… You're okay to park."* A double-tap on flaky LTE at
the plaza is precisely the scenario §13.6 was written for.

### 3b. What R49 changed

**(a) One link per quote.** `_start_checkout` now takes `SELECT … FOR UPDATE` on
the `plaza_payments` row, re-reads `square_checkout_url` under that lock and
returns it if it is already set, and calls Square **while holding the lock**.
Square's own idempotency is unchanged and still does not collapse concurrent
in-flight creates — the lock is what makes the second request wait, re-read and
hand back the first one's link. The R6 recovery is intact: a NULL URL after a
Square failure releases the lock and is retried under it next time.

**(b) Money is never orphaned.** Every link already carried
`payment_note = "plaza:<plaza_payment_id>"`; the payment's `note` is now part of
the normalized payment shape, and both the webhook and the sweep fall back to it
when the order id maps to no row. The settle accepts the order mismatch on that
path and **records the order the capture actually landed on** — unless another
quote already owns that order, which stays `manual_review` / `order_mismatch`.

**(c) A capture that matches neither** is still a 200 `noop=unknown_order`, but
now logs at ERROR: `plaza webhook: orphan capture payment=… order=… amount=…`
(Task 13 alerts on it). No plate, no phone, no body.

### 3c. What the re-run proves — from Square's side, not ours

The whole point of the run-1 failure was that **our ledger looked correct while a
second payable order existed**, so the re-run asks Square:

```
row 7   two concurrent submits, one key
        both HTTP 200, same plaza_payment_id, same checkout_url
        Square Orders API, window [17:53:20Z, 17:53:30Z], states DRAFT|OPEN|COMPLETED|CANCELED:
          1 order — HngM3IGVqzmQdUr6YxL3YWy0nd4F   == the order stored on the row
        Square payment links created in that window:
          1 link  — S7U7HR36T7PIKIL4 → HngM3IGVqzmQdUr6YxL3YWy0nd4F
        orphan orders: none
```

(`state_filter` has to name `DRAFT` explicitly — an order behind an *unpaid*
payment link is a DRAFT and SearchOrders' default states exclude it, which would
make any number of orphan links read as zero. SearchOrders is also not
read-your-writes, so the row polls until the order is indexed and then looks once
more after a pause, rather than trusting the first empty answer.)

And **row 23** forces the orphan that R49a now prevents, to prove R49b catches it
anyway: a second payment link built by hand for a live pending quote, same note,
different order, then paid.

```
quote   pp c8b9b974-6721-42a3-b13c-2d2618ee07ac
        row held order F668bgLNicgTVxt48X0yuCkPia4F   (its own link, never paid)
hand-made link on order 77lcnts84itEY1yJMoljNFlGef4F, payment_note plaza:<pp>
→ paid on Square (square payment 52jXO8MT2mzgQVl9G65moRi60SMZY)
→ plaza webhook: mapped_by=note payment=52jXO8MT2… order=77lcnts84… pp=c8b9b974-…
→ payment_status='paid', 1 active pass, needs_manual_review NULL
→ row's square_order_id is now 77lcnts84itEY1yJMoljNFlGef4F — the order that took the money
→ zero "orphan capture" alerts
```

## 4. Footnotes on the four rows that passed with a caveat

**¹ Row 5 — RULED (R50): the expected outcome is "no pass; the row stays
`pending` and the TTL closes it as `abandoned`", never `'failed'`.** The Expected
column above has been corrected accordingly. The reasoning:
`services/plaza_settle.py` states it outright: *"the ledger never lies:
`payment_status='paid'` is written only when Square says money was captured, and
`'failed'` never is (in this ledger `failed` means no money moved)."* A declined
capture is recorded as the webhook outcome `rejected_not_completed`; the row stays
`pending` and the 24 h orphan TTL closes it as `abandoned` (row 6 proves that
write). The behaviour the brief cared about — **no pass, no money, no lie in the
ledger** — holds. The brief's cell was stale relative to the implemented design
(R20), and R50 corrects the brief rather than the code. **Do not "fix" the ledger
toward `'failed'`.**

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
was the nearer and more likely double-charge route; R49 has closed it.

**RULED (R51):** because the sandbox structurally cannot answer "does a paid
quick-pay link accept a second capture", **Task 13's $1 shadow test owns it** —
one real link, paid, then paid again, with the admin refund endpoint used to
return whatever lands, before the flag flips. Nothing here defers it further.

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

**Re-run** (fresh ledger, rows 1, 3, 4, 7, 8, 19, 23): the same three invariants
returned `0` / `0` / `0` again.

| `payment_status` | rows | cents |
|---|---|---|
| `paid` | 4 | 6000 |
| `pending` | 4 | 6000 |

The four `paid` rows are rows 1, 4, 19 and 23; the four `pending` are row 8's
quote and row 7's three double-tap quotes (row 7 was exercised three times while
the Square-side evidence query was being corrected — see §3c — and none of those
quotes was ever paid).

## 6. Square-side view of the run window

### Run 1

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

### Re-run

`payments.list(begin_time = 2026-09-02T17:45:32Z, location = L362NGGHN0HP7)`:

| | |
|---|---|
| payments | 4 |
| statuses | `COMPLETED` 4 |
| completed | $60.00 |
| refunded | $0.00 |

Local ledger: **4 `paid` rows, $60.00**. Four captures, four passes, four paid
rows, to the cent — including row 23's, which was captured on an order the ledger
had never seen. **Zero unexplained cents.** That is the line that failed in run 1.

---

## 7. What this run does *not* cover

* **Railway's proxy.** `SQUARE_NOTIFICATION_URL` was a cloudflared hostname, not
  Railway's. §13.3's "does the notification URL survive the proxy byte-identically"
  is Task 13's post-deploy *Send test event*, per R41.
* **Real Twilio.** The receipt is verified at the call boundary (body logged, send
  attempted, 401 from Twilio's API). Delivery to a real handset is Task 13's.
* **The production hosted checkout.** See ³ — the sandbox substitutes a testing
  panel for the buyer page, so second-capture behaviour and the Apple/Google Pay
  rails are not exercised. R51 hands the second-capture question to Task 13's $1
  shadow test.
* **Rows not re-run.** 2, 5, 6, 9–18 and 20 were not re-run after R49. R49 touches
  `_start_checkout`'s locking, the webhook/sweep note fallback and one settle
  branch; the full backend suite (448 passed / 24 skipped) covers those rows'
  paths at unit level, and none of them exercises a concurrent same-key quote or
  an unmapped order.
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

To re-run a subset against what is already there (as the R49 re-run did), add
`PAY2PARK_SANDBOX_KEEP=1` — it skips the ledger truncate and updates only the
selected rows' records:

```bash
PAY2PARK_SANDBOX=1 PAY2PARK_SANDBOX_KEEP=1 .venv/bin/pytest \
  tests/plaza/sandbox/test_sandbox_matrix.py -q -s -p no:randomly \
  -k "row_01 or row_03 or row_07 or row_23 or row_08 or row_04 or row_19 or test_zz"
```

Row 19 kills the tunnel and must stay last; row 3 reads row 1's payment.

`up` re-points the standing Square subscription at the new tunnel URL and rotates
its signature key, so each run is self-contained. Square credentials come from
`.env.local` (git-ignored, sandbox-only, never printed). Nothing in this
environment can reach the live Supabase project or a production Square account.
