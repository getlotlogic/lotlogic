# LotLogic Industry Spec

> **Date:** 2026-04-26
> **Status:** Living document. Update quarterly or when a new competitor / acquisition shifts the landscape.
> **Audience:** Founder strategic anchor. Reference when scoping any new feature against "is this what the industry calls a complete platform?"

---

## 1. What category LotLogic is in

LotLogic is a **private-property parking enforcement platform** — software that detects unauthorized vehicles, dwell-time violations, and access-control breaches at parking facilities owned by private operators (truck plazas, apartment complexes, retail centers, hotels, hospitals, employee lots).

**LotLogic is NOT:**
- Municipal/government enforcement (T2, AIMS, Gtechna, Conduent, Rekor public-sector arm)
- Consumer parking marketplace (SpotHero, ParkWhiz, Passport)
- Parking-payment infrastructure (Metropolis, Flash, ParkMobile, Flowbird)
- Tow-dispatch operations software (TowBook, TOPS, TRAC)
- General-purpose computer vision (Hayden AI, Genetec AutoVu, Vigilant/Motorola)

These adjacent categories will appear in feature comparisons; LotLogic should *integrate with* most of them, not *compete head-on*.

---

## 2. The complete industry feature surface

The list below is the industry-standard feature set across enterprise parking-enforcement platforms (T2 / AIMS / Gtechna / Metropolis / Rekor / Park Loyalty / AirGarage). Mark every row with one of:

- ✅ — LotLogic has it today
- ⚠️ — partial / verticalized to truck plazas only
- ❌ — missing
- 🚫 — out of scope (we don't compete here)

### 2.1 Detection layer

| Feature | LotLogic | Notes |
|---|---|---|
| Fixed-camera ALPR (cellular / IP) | ✅ | Milesight 4G, edge-function ingest |
| Mobile/in-vehicle ALPR (officer car) | 🚫 | Not the truck-plaza model |
| Handheld ALPR (officer phone/scanner) | 🚫 | Not the truck-plaza model |
| Fixed-camera occupancy/spot detection | ❌ | Pilot/TA do this; LotLogic doesn't need to (our customer cares about violations, not utilization) |
| Computer-vision auto-retraining loop | ✅ | Genuine moat — competitors use static off-the-shelf ALPR |
| Plateless vehicle identity (USDOT/MC) | ✅ | Genuine moat — no major competitor does this |
| Multi-camera entry/exit pairing | ⚠️ | Code present, currently broken (orientation bug, all 4 cameras = 'entry') |
| Sidecar / cost-saving local OCR | ✅ | YOLO sidecar before cloud PR |
| Image-similarity burst dedup | ✅ | Just shipped (PR #115) |
| Auto-tuned fuzzy match config | ✅ | Just shipped (PR #116) |

### 2.2 Identity & access control

| Feature | LotLogic | Notes |
|---|---|---|
| Permanent permit list (residents/employees) | ✅ | `resident_plates` |
| Temporary visitor pass (time-windowed) | ✅ | `visitor_passes` with valid_from/valid_until |
| Self-service permit registration (QR/web) | ✅ | `visit.html`, `resident.html` |
| Permit categories (resident, employee, vendor, contractor, event) | ⚠️ | Two categories (resident/employee + visitor); single property today |
| Permit waitlist / lottery (universities) | 🚫 | Out of scope |
| HR-system integration (Workday, Banner, PeopleSoft, Ellucian) | 🚫 | University-vertical play, not LotLogic |
| Hold/blocklist (24h cooldown after tow) | ✅ | `plate_holds` + 24h post-tow |
| Allowlist by USDOT/MC (truck-plaza only) | ✅ | Genuine differentiator |

### 2.3 Citation / violation lifecycle

| Feature | LotLogic | Notes |
|---|---|---|
| Auto-generated violation on rule break | ✅ | `alpr_violations` |
| State machine: pending → resolved | ✅ | Two-state |
| State machine: pending → appealed → adjudicated → resolved | ❌ | **Industry table-stakes; LotLogic missing** |
| Citation with evidence (photo, GPS, timestamp) | ✅ | image_url + plate_event row |
| Citation revenue / fee schedule per partner | ✅ | `enforcement_partners.fee_schedule` |
| Manual operator override / dismiss | ✅ | Confirmation Review tab |
| Reissue / void citation | ⚠️ | Pause/resume billing exists; full void path is incomplete |
| Multi-citation / repeat-offender escalation | ❌ | One violation per session |
| Court / DMV integration for unpaid citations | 🚫 | Government play, out of scope |
| Collections workflow (after-N-days unpaid) | ⚠️ | Tow is the collection in our model |

### 2.4 Citizen / driver self-service

| Feature | LotLogic | Notes |
|---|---|---|
| Public QR for visitor permit registration | ✅ | `visit.html` |
| Public QR for permanent plate registration | ✅ | `resident.html` |
| Look-up violation by plate | ❌ | **Industry table-stakes; missing** |
| Pay violation/release fee online (Stripe) | ❌ | **Highest-leverage gap** |
| Dispute / appeal a citation online | ❌ | Industry table-stakes; missing |
| Receipt / confirmation email | ⚠️ | Operator side has it; driver side doesn't |
| Mobile-friendly UX | ✅ | All public pages are mobile-first |

### 2.5 Operator dashboard

| Feature | LotLogic | Notes |
|---|---|---|
| Property management (CRUD) | ✅ | |
| Camera registration | ✅ | |
| Open-session live view | ✅ | |
| Recent plate detections feed | ✅ | |
| Hold list management | ✅ | 24h holds w/ Release button |
| Visitor pass log / parking log | ✅ | Truck Parking Log tab |
| Confirmation Review (post-tow billing) | ✅ | Genuine workflow |
| Earnings / revenue reporting | ✅ | Billing tab |
| Per-camera occupancy / heatmap | ❌ | Could be added but not table-stakes |
| Operator activity log / audit trail | ⚠️ | Partial via plate_events; no formal audit log |
| Operator labeling for ML retraining | ✅ | **Genuine moat — Training tab + auto-retrain pipeline** |
| Realtime updates | ✅ | Supabase realtime everywhere |

### 2.6 Partner / tow-operator workflow

| Feature | LotLogic | Notes |
|---|---|---|
| Partner self-service onboarding | ❌ | Manual setup today; **near-term build target** |
| Partner email dispatch on tow | ✅ | HMAC action buttons |
| Partner SMS dispatch | ⚠️ | Code exists (`tow-dispatch-sms`), no traffic |
| Tow truck plate registration | ✅ | `enforcement_partners.tow_truck_plates` |
| Camera-confirmed tow (sighting → confirmation) | ⚠️ | Code present (`tow-confirm`), not wired into ingest |
| Partner mobile app | ❌ | Email + dashboard is enough today |
| Partner revenue accounting | ✅ | `our_revenue` field, fee schedules |

### 2.7 Infrastructure & ops

| Feature | LotLogic | Notes |
|---|---|---|
| Multi-tenant (property → owner → partner scoping) | ✅ | RLS policies, JWT-scoped |
| Edge-function serverless ingest | ✅ | **Genuine architectural advantage** |
| ALPR cost optimization (sidecar + dedup + lock) | ✅ | Sophisticated — most competitors don't bother |
| Cellular SIM management | ⚠️ | SIMbase visibility added; no automation |
| Camera health monitoring | ⚠️ | Manual today; needs auto-alerting |
| Auto-scaling | ✅ | Inherited from Supabase + Vercel + Modal |
| Backups / DR | ⚠️ | Supabase managed; no formal DR plan |
| SOC 2 / data-handling certifications | ❌ | Required for enterprise sales |

### 2.8 Differentiator stack (LotLogic advantages)

These are features competitors don't have. **Treat as moats — invest, don't dilute.**

1. **Continuously-retrained, property-specific YOLO detector** (Modal GPU + operator labels)
2. **USDOT / MC plateless-vehicle identity** end-to-end
3. **Edge-function ingest at single-camera $/month operating cost**
4. **Sidecar + per-camera cooldown + per-(camera, plate) PR lock** for ALPR-cost minimization
5. **Auto-tuned fuzzy match config** (just shipped)
6. **Image-similarity burst dedup** (just shipped)

---

## 3. The industry-standard minimum viable platform

To be credibly "in the same conversation" as T2 / AIMS / Park Loyalty / AirGarage, a platform must have:

1. ✅ Fixed-camera ALPR with zone detection
2. ✅ Permit registration (permanent + temporary)
3. ✅ Auto violation creation
4. ✅ Operator dashboard
5. ✅ Tow / boot dispatch workflow
6. ❌ **Citizen pay-online for violations or release**
7. ❌ **Citation appeals workflow** (pending → appealed → resolved)
8. ❌ **Citizen plate look-up** (driver checks "do I have a violation?")

LotLogic has **5 of 8**. The 3 missing pieces are all **citizen-facing** and all **buildable in 4-6 weeks combined**. After those, LotLogic clears the bar to look like a complete platform on a sales call.

---

## 4. Where LotLogic should NOT compete

These categories will eat months of build time for zero margin if pursued:

- **Municipal / on-street enforcement** — Hayden AI, Rekor, T2 own this; deep gov-procurement moats.
- **University parking systems** — AIMS owns the Workday/Banner/PeopleSoft integrations.
- **Consumer parking marketplace** — SpotHero / ParkWhiz two-sided network already saturated.
- **Parking-payment infrastructure** — Metropolis just raised $1.6B at $5B valuation.
- **Boot devices / kiosk hardware** — capex-heavy, not a software moat.
- **Tow-dispatch operations software** — TowBook / TOPS already serve this market; LotLogic should *integrate with* them, not compete.

---

## 5. The truck-plaza vertical — LotLogic's unique seat

**Confirmed via web research:** zero dedicated player exists for truck-plaza overstay enforcement.

- Pilot Flying J, TA/Petro, Love's, Speedway, Casey's: reservation systems + occupancy, **no enforcement**
- Trucker Path, Park My Truck: driver-side discovery apps, **no enforcement**
- Rekor, Metropolis, Hayden: ALPR exists but targets municipal/retail, **not truck-plaza**

**Why the gap exists:**
- Truck-stop economics historically tolerated overstay (drivers buy fuel/food anyway)
- HOS regulations made enforcement politically awkward
- Driver-facing brands (Pilot, TA) have reservation revenue, not violation revenue, so they have no incentive to build enforcement

**Why it's now viable:**
- Lot capacity is the binding constraint at high-traffic plazas — overstay = lost legitimate parker
- Property liability for incidents (theft, assault, drug activity in long-stay vehicles) is growing
- Insurance carriers are starting to require enforcement audit logs
- Trucking companies want enforcement at their *yards*, separate from public truck stops

**LotLogic's position:** First-mover with ~6-12 months before Rekor or AirGarage notices and pivots downmarket.

---

## 6. Threat model (18 months)

| Threat | Probability | Impact | Mitigation |
|---|---|---|---|
| **Rekor pivots downmarket** into truck-plaza enforcement | Medium | High | Win 10-20 properties before they notice |
| **Hayden AI** extends transit CV into property enforcement | Medium | High | Invest in USDOT moat (CV alone won't do plateless) |
| **AirGarage** scales gig-enforcer model into truck-plazas | Low | Medium | Automation > gig labor for truck plazas (24/7, no bandwidth) |
| **Metropolis** acquires a truck-stop chain | Low | Catastrophic | Lock in multi-year contracts before this happens |
| **Pilot Flying J** builds enforcement in-house | Low | Medium | Position as white-label / partner instead of competitor |
| **A new AI-first startup** raises $10M+ in this niche | Medium | Medium | Watch funding announcements; consider a small seed raise to defend |
| **Plate Recognizer / ParkPow** packages a competing product | Low | High (we depend on them) | Continued investment in self-hosted SDK |

---

## 7. Spec-driven 12-month roadmap

Order is by **leverage per build week**, not by interest.

### Quarter 1 (now — 2026-Q3): close the citizen-facing gap

- **C1 — Citation appeals workflow** (~1 week)
  Add states: `pending → appealed → adjudicated_paid / adjudicated_voided / resolved`. Operator UI for reviewing appeals. Driver can submit appeal with text + photo evidence. Closes a table-stakes gap.

- **C2 — Public plate look-up** (~3 days)
  `lookup.html` → enter plate → see open violations + outstanding fees. No login required. Matches T2 / AIMS / Gtechna's standard.

- **C3 — Pay-to-release portal** (~1-2 weeks)
  When a vehicle is towed: operator/partner publishes a release fee. Driver scans QR / visits URL → Stripe checkout → release token issued. **Highest revenue-impact feature on this list** — closes the cash-only release loop.

### Quarter 2: deepen the moat + open the next vertical

- **M1 — Auto-retrain v2** (in flight, just shipped)
  Auto-tuned fuzzy match config (PR #116) + image-hash burst dedup (PR #115) + monthly Modal cron schedule.

- **M2 — Camera health auto-alerting** (~3 days)
  Existing diagnostic data plus a 30-min silence threshold → operator email/SMS. Removes a real ops paper-cut (cameras went dark for 12h yesterday with no alert).

- **M3 — Partner self-service onboarding** (~1 week)
  Tow companies sign up themselves, configure their plates, see assigned violations. Removes the founder from the manual onboarding loop. Required for scaling past 5 properties.

- **M4 — Multi-property dashboard** (~2 weeks)
  Operator with N properties sees them on one screen with cross-property aggregates. Required for property-management chains (Casey's, Speedway).

### Quarter 3: scale + sales

- **S1 — Compliance / audit-log report** (~1 week)
  Generate a "we enforced X violations / Y warnings / Z grace periods over period [..]" PDF for property insurance + liability. Sells the platform to insurance partners.

- **S2 — White-label / partner API** (~2 weeks)
  REST endpoints so Pilot / TA / regional chains can embed LotLogic enforcement into their existing operator portals without using our dashboard.

- **S3 — SOC 2 Type 1 prep** (~ongoing)
  Required for enterprise truck-stop chains (Pilot, TA). Long-pole; start early.

### Quarter 4: defend + expand

- **D1 — End-to-end matching classifier** (Layer C from PR #116 plan)
  Replace `plateSimilar` + dHash thresholds with a learned classifier. Bigger moat against any AI-first new entrant.

- **D2 — Apartment / multifamily vertical kit** (~3 weeks)
  Resident permit + visitor pass UI tuned for apartments. Extends current code without forking. Opens a 100x larger TAM.

- **D3 — Insurance / risk-rating data product**
  Sell anonymized "incidents per million sq ft" metrics to insurance underwriters. Pure data-product, very high margin.

---

## 8. Positioning sentence

For external use (sales decks, website hero, investor pitches):

> **LotLogic is the ML-first parking enforcement platform purpose-built for truck plazas and private operators. Custom-trained computer vision tunes itself to your lot. Plateless tractors are tracked by USDOT/MC. Tow dispatch is one tap. No officers, no kiosks, no chalk.**

For technical / industry use:

> **LotLogic provides edge-first ALPR ingest with auto-retraining detection, native plateless-vehicle identity, and end-to-end tow workflow — at a fraction of the per-camera cost of legacy enforcement platforms.**

---

## 9. Glossary

| Term | LotLogic meaning |
|---|---|
| **Permanent plate / Permit holder** | Resident, employee, or long-term tenant — `resident_plates` row |
| **Temporary pass / Visitor** | Time-windowed authorization — `visitor_passes` row |
| **Driver** | The operator of a vehicle being detected (avoid "user" — they're not a software user) |
| **Property** | A single physical lot — `properties` row |
| **Owner** | The entity that books revenue for the property — `lot_owners` |
| **Partner** | The tow company contracted to enforce — `enforcement_partners` |
| **Operator (UI sense)** | Person clicking dashboard buttons — typically owner or owner's staff |
| **Session** | A vehicle's continuous presence on a property — `plate_sessions` |
| **Violation** | A confirmed enforcement event — `alpr_violations` |
| **Plate event** | A single ALPR detection — `plate_events` |
| **Hold** | 24h post-tow cooldown preventing re-registration — `plate_holds` |
| **Anchored session** | A `plate_sessions` row with ≥3 hi-confidence detections — fuzzy match runs looser |

---

## 10. Update protocol

This doc is the strategic anchor. Update it when:

- A new competitor raises >$10M funding
- An acquisition shifts the landscape (e.g., Rekor buys a truck-stop chain)
- LotLogic ships a feature that closes one of the ❌ rows above
- A previously-out-of-scope category becomes in-scope (e.g., we decide to pursue universities)
- The truck-plaza-vertical thesis materially changes (new competitor enters, customer says "we don't care about overstay")

Quarterly review minimum.
