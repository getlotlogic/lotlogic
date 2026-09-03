# Dashboard Simplification — Logic & Reasoning Board

**Date:** 2026-05-31
**Question on the table:** the operator dashboard feels over-complicated. Is it? For whom? And what's the logical move to fix it?

---

## A. The complexity, quantified (grounded in `frontend/dashboard.html`)

| Metric | Value | So what |
|---|---|---|
| Total lines | **12,379** | One file, transpiled in-browser by Babel, no build step. Every change reloads the whole thing. |
| Page/view components | **18** | Login, Jobs, Earnings, Invoices, BillingQuickBooks, ConfirmationReview, TowTruckPlatesEditor, OperatorActivity, Overview, PartnerFeeEditor, Account, Analytics, ActivePassTracker, ALPRPropertyDetail, RegisteredDrill, ALPRProperties, TowActivity, Training |
| Role-gate checks (`isOwner`/`isPartner`/`account_type`) | **58** | Owner and crew experiences are *interleaved inside the same components* via conditionals. |
| Nav configs | **2** | Owner: Jobs/Lots/Tow-truck/Account. Crew: Jobs/Lots/Activity/Account. |

**Root cause of the "over-complicated" feeling:** one app serves two very different audiences (lot **owner/operator** vs **tow crew**) by hiding-and-branching, not by separation. The crew is handed a 12k-line owner app with the owner parts switched off — so it's heavy, the JobsPage is laced with `isOwner` branches, and the crew's tiny job is buried in a billing/analytics/QuickBooks machine.

---

## B. Audience × Surface matrix — who actually needs what

`C` = Core to the crew · `S` = Secondary · `✗` = Crew never needs (owner-only)

| Component | Built for | Crew need |
|---|---|---|
| LoginPage | both | C (entry) |
| **JobsPage** | both (isOwner branches) | **C** — the field command center |
| **ALPRPropertiesPage** (Lots/Search) | both | **C** — plate/company lookup |
| **ActivePassTracker / ALPRPropertyDetail** | both | **C** — pass status + detail |
| RegisteredDrill | both | S — registered list |
| AccountPage | both | C — login/settings |
| TowTruckPlatesEditor | partner | S — one-time setup |
| OperatorActivityPage | both | S — history/reporting |
| EarningsPage | owner | ✗ |
| InvoicesPage | owner | ✗ |
| BillingQuickBooksView | owner | ✗ |
| ConfirmationReviewView (7 billing queues) | owner | ✗ |
| OverviewPage | owner | ✗ |
| AnalyticsPage | owner | ✗ |
| PartnerFeeEditor | owner | ✗ |
| TowActivityPage (truck sightings) | owner | ✗ **(by design — crew must NOT see their own sightings)** |
| TrainingPage | owner | ✗ |

**The math:** the crew genuinely needs **~5 surfaces** (Jobs, Search, Pass detail, Account, + history). The other **~10 owner-only surfaces** ride along in the same bundle and the same components' conditionals. The crew pays — in load weight, clutter, mis-tap surface, and our maintenance cost — for machinery it never touches.

---

## C. The core reasoning

1. The crew's job is **narrow and well-defined** (the 5-step field workflow): see flagged jobs → verify present → check the plate → tow with evidence → spot-check others.
2. The dashboard is **broad and owner-centric** (billing, QuickBooks, analytics, fee config, training, multi-tenant CRUD).
3. Today these collide in **one monolith with 58 role gates.** That's the over-complication: not any single screen, but *audience-mixing inside a monolith.*
4. Therefore the highest-leverage simplification is **separation by audience**, not more hiding. Give the crew a small, purpose-built surface; leave the owner dashboard as the owner's tool.

### The fork (the real decision)
| Option | What it is | Pros | Cons |
|---|---|---|---|
| **A — Dedicated field surface** *(recommended)* | A focused crew view: Jobs + Search + Pass detail + Account only. Shares auth/`apiFetch`, drops everything owner. | Fast, sunlight-simple, few mis-taps; small to reason about; matches the crew's real job | Some shared-code factoring; a real (but bounded) build |
| **B — Simplify in place** | Keep one app; ruthlessly hide owner surfaces for partners, slim JobsPage | Least restructure now | Still a 12k-line monolith; role-gate sprawl persists; "over-complicated" feeling stays for maintainers |
| **C — Extract a separate `field.html`** | A standalone lightweight page, like `visit.html`/`resident.html` already are | Tiny, independent of the owner dashboard's weight; loads instantly on bad cell | New file; duplicates auth/fetch helpers; two surfaces to maintain |

**Recommendation: A (or C).** The crew never benefits from the owner machinery and pays for it. A purpose-built field surface is the clean "uncomplicate it" move; B leaves the complexity in place and just paints over it.

---

## D. Keep / Simplify / Cut-for-crew

| Decision | Surfaces |
|---|---|
| **KEEP (crew core)** | Jobs (redesigned), Lots→**Search** (instant), Pass detail, Account |
| **SIMPLIFY** | JobsPage — strip the `isOwner` branches out of the crew path; placard color + photo + "check pass" forward; OperatorActivity → optional/secondary |
| **CUT from crew view** | Earnings, Invoices, BillingQuickBooks, ConfirmationReview, Overview, Analytics, PartnerFeeEditor, **TowActivity (truck sightings — crew never sees)**, Training |

---

## E. The crew's decision logic (what the UI must encode)

```
Truck in the lot
│
├─ On the FLAGGED list (Jobs)?
│   ├─ YES → physically present?
│   │        ├─ YES → photo evidence exists? ──► DISPATCH TOW  (easy, defensible)
│   │        └─ NO  → mark gone / skip
│   └─ NO  → search the plate (instant)
│            ├─ ACTIVE pass?  ──► leave it  (placard color should match windshield)
│            └─ none / expired ──► legit tow ──► DISPATCH
```

Every node in this tree should be **one tap** in the UI. That's the entire crew product.

---

## F. Open decisions for you
1. **Architecture fork (C above):** dedicated field surface (A) vs simplify-in-place (B) vs separate `field.html` (C). This changes everything downstream.
2. **Scope:** are we also simplifying the **owner** dashboard (the CLAUDE.md audit mandate says it's bloated too), or only the crew experience for now?
3. **Confirmed:** crew never sees their own truck sightings — pulled from the design.

---

## G. The chosen approach: ADDITION BY SUBTRACTION

**Mental model (Gabe, 2026-05-31): it's ONE dashboard, two views.** The owner view is the comprehensive superset; the crew view is the **same dashboard with the owner-only features removed.** Not a separate app — a trimmed subset of the same codebase, gated by role.

Decision: don't build a separate field app and don't add a feature pile. **Make the crew view better by removing.** Simplify in place, executed as role-scoped deletion: the crew view = owner view minus {owner-only surfaces + owner widgets inside shared pages}. The owner view stays comprehensive. The earlier UX spec's *additive* items (walk-the-lot mode, new banners, net-new screens) are deprioritized; keep only net-removals or step-removals.

### The cut list (ranked by clutter removed)

1. **Three pass views → ONE.** Passes are currently reachable three overlapping ways: `ActivePassTracker` (two-column grid, 8751), `RegisteredDrill` (list, 10960), `TruckParkingLog` (search, 9388). **Delete two; keep one search-first view.** Biggest single simplification. *(Confirm exact overlap before deleting.)*
2. **Owner machinery → gone from the crew path.** The crew carries Earnings, Invoices, BillingQuickBooks, ConfirmationReview, Overview, Analytics, PartnerFeeEditor, Training, TowActivity via 58 role-gates. Make them unreachable for partners and strip `isOwner` branches out of the crew components (esp. JobsPage: drop the AI-quality banner 5300, owner KPI clutter). Shrinks the crew's bundle and mental model.
3. **Search steps → removed.** Delete the **"Apply" button** (search fires on type) and the dead **"0 passes" wall** (becomes a plain verdict). **KEEP the 4-day date default — Gabe confirmed it's good; do NOT change it.**
4. **A tab → removed.** Crew likely doesn't need **Activity** (reporting). 4 tabs → 3.
5. **Filter clutter → trimmed.** Status dropdown + multiple filter pills → only the essentials.

### What we are NOT doing (subtracted from the plan)
- No separate `field.html`, no walk-the-lot mode, no PassDetailSheet-as-new-screen (unless it *replaces* the three pass views and nets fewer lines), no crew truck-sighting banner.

### Net effect
Crew surface collapses toward the 5-step decision tree (§E): fewer tabs, fewer pass views, fewer taps, no owner clutter. Quality comes from what's gone.

---
*This board + the UX spec (`2026-05-31-operator-app-ux-design.md`) now operate in subtraction mode.*
