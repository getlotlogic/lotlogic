# LotLogic Industry Spec

> **Date:** 2026-04-26 (v2 — multi-vertical scope)
> **Status:** Living document. Update quarterly or when a new competitor / acquisition shifts the landscape.
> **Audience:** Founder strategic anchor. Reference when scoping any new feature against "is this what the industry calls a complete platform?"

---

## 1. The end-state vision

**LotLogic is the Metropolis of parking enforcement.**

Metropolis built the dominant AI parking-payment platform: one driver app, one operator dashboard, frictionless across thousands of properties spanning lots, gas stations, drive-thrus. $5B valuation, $1.6B raised in 2025.

LotLogic builds the dominant AI parking-enforcement platform — the same shape, the other half of the parking workflow. **One enforcement layer, every vertical:** truck plazas, residential, retail, hotels, hospitals, employee lots, office parks. One operator dashboard. One driver-facing portal for permits, lookups, and payments. Frictionless across thousands of properties.

These are complementary halves of the same future. Metropolis sees you in, LotLogic sees you out (or pays for it). The platforms don't compete — they're the two sides of every parking transaction at scale.

**LotLogic's wedge into that future is the truck-plaza vertical** (zero competitors today, defensible niche). Every other vertical is added by reusing the same core: detection, identity, citation lifecycle, partner workflow, payment, reporting.

---

## 2. Vertical map

LotLogic plays in **all of these.** Sequence is by leverage of beachhead → broader market.

| Vertical | TAM | Ours? | Beachhead status | Direct competitors |
|---|---|---|---|---|
| **Truck plazas** | small (~5k US locations) | **first** | live, 1 property | none |
| **Residential / multifamily** | huge (~50k apt complexes US) | **second** | not started | **Parking Boss** (Yardi-bundled), **Park Loyalty** ($23M Series A) |
| **HOAs / private communities** | large (~350k US HOAs) | second | not started | Park Loyalty, AirGarage |
| **Retail centers / shopping malls** | medium | third | not started | T2, Rekor, AirGarage |
| **Hotels** | medium | third | not started | T2, AIMS |
| **Hospitals** | medium-large | third | not started | T2, AIMS |
| **Employee lots / office parks** | medium | fourth | not started | T2, AIMS |
| **Universities / schools** | medium | 🚫 SKIP | — | AIMS owns Workday/Banner integrations |
| **Municipal / on-street** | huge | 🚫 SKIP | — | T2, Rekor, Hayden own gov procurement |
| **Airports** | small but high-$ | 🚫 SKIP | — | Specialized incumbents |

**Strategy:** Trucking proves the platform. Residential scales the platform. Retail/hotels/hospitals broaden the platform. Skip municipal + university — they have moats LotLogic can't crack in a reasonable timeframe.

---

## 3. The complete industry feature surface

Symbols: ✅ have today · ⚠️ partial · ❌ missing · 🚫 out of scope (will not pursue)

### 3.1 Detection layer

| Feature | LotLogic | Notes |
|---|---|---|
| Fixed-camera ALPR (cellular / IP) | ✅ | Milesight 4G, edge-function ingest |
| Computer-vision auto-retraining loop | ✅ | **Genuine moat** — competitors run static off-the-shelf ALPR |
| Plateless vehicle identity (USDOT/MC) | ✅ | **Truck-plaza moat** — irrelevant in residential |
| Multi-camera entry/exit pairing | ⚠️ | Code present, currently broken (orientation bug) |
| Sidecar + cost-saving local OCR | ✅ | Pre-PR YOLO sidecar |
| Image-similarity burst dedup | ✅ | Just shipped (PR #115) |
| Auto-tuned fuzzy match config | ✅ | Just shipped (PR #116) |
| Mobile/in-vehicle ALPR (officer car) | 🚫 | Skip — not the AI-first model |
| Handheld ALPR (officer phone) | 🚫 | Skip — not the AI-first model |

### 3.2 Identity & access control

| Feature | LotLogic | Notes |
|---|---|---|
| Permanent permit list (residents/employees) | ✅ | `resident_plates` |
| Temporary visitor pass (time-windowed) | ✅ | `visitor_passes` |
| Self-service permit registration (QR/web) | ✅ | `visit.html`, `resident.html` |
| Permit categories — resident, employee, vendor, contractor, day-pass, event | ⚠️ | 2 categories today; **needs to expand for residential** |
| Permit waitlist / lottery | ❌ | Useful for high-density apt buildings |
| HR-system integration (Workday, Banner) | 🚫 | University-only |
| Property-mgmt-system integration (Yardi, RealPage, Entrata) | ❌ | **High-leverage for residential** — Parking Boss is bundled into Yardi |
| Hold/blocklist (24h post-tow) | ✅ | `plate_holds` |
| Allowlist by USDOT/MC | ✅ | Truck-plaza only |

### 3.3 Citation / violation lifecycle

| Feature | LotLogic | Notes |
|---|---|---|
| Auto-generated violation on rule break | ✅ | `alpr_violations` |
| pending → resolved | ✅ | Two-state |
| **pending → appealed → adjudicated → resolved** | ❌ | **Industry table-stakes; missing** |
| Citation with evidence (photo, GPS, timestamp) | ✅ | image_url + plate_event row |
| Per-partner fee schedule | ✅ | `enforcement_partners.fee_schedule` |
| Manual operator override / dismiss | ✅ | Confirmation Review tab |
| Reissue / void citation | ⚠️ | Pause/resume exists; void path incomplete |
| Multi-citation / repeat-offender escalation | ❌ | Useful for residential |
| Court / DMV integration | 🚫 | Government play |
| Collections workflow | ⚠️ | Tow IS the collection in truck-plaza model; **need different flow for residential** |

### 3.4 Driver / citizen self-service (table-stakes for every vertical)

| Feature | LotLogic | Notes |
|---|---|---|
| Public QR for visitor permit | ✅ | `visit.html` |
| Public QR for permanent plate | ✅ | `resident.html` |
| **Look-up violation by plate** | ❌ | **Table-stakes; missing** |
| **Pay violation/release fee online (Stripe)** | ❌ | **Highest-leverage gap — required for every vertical** |
| **Dispute / appeal a citation online** | ❌ | Table-stakes; missing |
| Receipt / confirmation email | ⚠️ | Operator side only |
| Mobile-friendly UX | ✅ | All public pages mobile-first |
| Driver app (iOS/Android) | ❌ | Eventually; web-first is fine for now |

### 3.5 Operator dashboard

| Feature | LotLogic | Notes |
|---|---|---|
| Property mgmt (CRUD) | ✅ | |
| Camera registration | ✅ | |
| Open-session live view | ✅ | |
| Recent plate detections feed | ✅ | |
| Hold list management | ✅ | 24h holds w/ Release |
| Visitor pass log / parking log | ✅ | Truck Parking Log tab |
| Confirmation Review | ✅ | Genuine workflow |
| Earnings / revenue reporting | ✅ | Billing tab |
| **Multi-property dashboard** | ❌ | **Required for property mgmt companies running 50+ apt complexes** |
| Per-property occupancy / heatmap | ❌ | Optional; not table-stakes |
| Operator activity log / audit trail | ⚠️ | Partial |
| **Operator labeling for ML retraining** | ✅ | **Genuine moat** |
| Realtime updates | ✅ | Supabase realtime |

### 3.6 Partner / tow-operator workflow

| Feature | LotLogic | Notes |
|---|---|---|
| Partner self-service onboarding | ❌ | Manual today; **near-term build target** |
| Partner email dispatch on tow | ✅ | HMAC action buttons |
| Partner SMS dispatch | ⚠️ | Code exists, no traffic |
| Tow truck plate registration | ✅ | `tow_truck_plates` |
| Camera-confirmed tow correlation | ⚠️ | Code present, not wired into ingest |
| Partner mobile app | ❌ | Email + dashboard sufficient today |
| Partner revenue accounting | ✅ | `our_revenue`, fee schedules |

### 3.7 Multi-tenant infrastructure

| Feature | LotLogic | Notes |
|---|---|---|
| RLS scoping (owner_id / partner_id JWT claims) | ✅ | |
| Edge-function serverless ingest | ✅ | **Architectural advantage at multi-property scale** |
| ALPR cost optimization (sidecar + dedup + lock) | ✅ | Sophisticated |
| **Property-management company hierarchy** | ❌ | **One mgmt company → 50 properties → 500 cameras** — required for residential |
| Cellular SIM management | ⚠️ | Visibility only |
| Camera health monitoring | ⚠️ | Manual today |
| Auto-scaling | ✅ | Supabase + Vercel + Modal |
| Backups / DR | ⚠️ | Supabase managed |
| **SOC 2 Type 1** | ❌ | Required for property mgmt companies + enterprise truck-stop chains |
| **SOC 2 Type 2** | ❌ | Required for hospitals |

### 3.8 LotLogic's moat stack — invest, don't dilute

1. **Continuously-retrained, property-specific YOLO detector**
   - Per-property tuning matters MORE in residential (every lot has different lighting/angles/vehicle mix)
   - Competitors use static ALPR — they can't compete on per-property accuracy
2. **Edge-function ingest at single-camera $/month operating cost**
   - Matters MORE at multi-property scale (50 properties × 2 cameras each = 100 cameras at fractional infrastructure cost)
   - Legacy stacks need a server per N properties
3. **USDOT / MC plateless-vehicle identity**
   - Truck-plaza-only moat; doesn't help in residential
4. **Sidecar + per-camera cooldown + per-(camera, plate) PR lock**
   - Cost optimization that compounds across the platform
5. **Auto-tuned fuzzy match + image-hash burst dedup** (just shipped)
6. **Operator labeling → auto-retrain → auto-deploy loop**
   - Self-improving system; every operator label makes the platform smarter for every property

---

## 4. The minimum viable platform — multi-vertical edition

To be credibly "in the same conversation" as T2 / Park Loyalty / AirGarage / Parking Boss:

1. ✅ Fixed-camera ALPR with zone detection
2. ✅ Permit registration (permanent + temporary)
3. ✅ Auto violation creation
4. ✅ Operator dashboard
5. ✅ Tow / boot dispatch workflow
6. ❌ **Citizen pay-online** — required for every vertical
7. ❌ **Citation appeals workflow** — required for every vertical
8. ❌ **Citizen plate look-up** — required for every vertical
9. ❌ **Multi-property dashboard** — required for residential mgmt companies
10. ❌ **Property-mgmt-system integration** (Yardi/RealPage/Entrata) — required for residential at scale

**LotLogic: 5 of 10.** The 5 missing are all required to enter residential at any scale. **Build all 5 in Q1-Q2 2026.**

---

## 5. Where LotLogic should NOT compete

- **Municipal / on-street enforcement** — Hayden, Rekor, T2 own this; gov-procurement moats
- **University parking** — AIMS owns Workday/Banner integrations
- **Consumer parking marketplace** — SpotHero / ParkWhiz two-sided network
- **Parking-payment infrastructure** — Metropolis owns this; we are the *enforcement* half, not the *payment* half (though we'll process violation payments)
- **Boot devices / kiosk hardware** — capex-heavy, not a software moat
- **Tow-dispatch operations software** — TowBook / TOPS exist; we *integrate*, don't compete
- **Airports** — long sales cycles, specialized incumbents

---

## 6. Truck-plaza beachhead — why it matters for the larger play

The truck-plaza vertical is the **beachhead, not the destination.** Three reasons it's the right wedge:

1. **Zero direct competitors.** Confirmed via web research — Pilot, TA, Trucker Path do reservations + occupancy, none do enforcement. We can win 100% market share before Rekor/Metropolis notice.
2. **Hardest case validates the platform.** Truck plazas have plateless tractors, harsh lighting, weather, multi-day stays, partner-operated tows. If LotLogic works here, residential is comparatively easy.
3. **Unit economics prove out.** Tow revenue per violation ($75-$250) >> apartment overstay fines ($25-$50). Truck-plaza revenue funds the residential expansion.

**Win 5-10 truck plazas → use the case studies + revenue → fund the residential vertical kit.**

---

## 7. Threat model (18 months)

| Threat | Probability | Impact | Mitigation |
|---|---|---|---|
| **Rekor pivots downmarket** into private property | Medium | High | Win 20+ properties before they notice |
| **Hayden AI** extends from transit into residential | Medium | High | Invest in property-mgmt-system integration moat |
| **AirGarage** scales to nationwide residential | Medium | High | Automation > gig labor for 24/7 monitoring |
| **Metropolis** adds enforcement to payment platform | Low | **Catastrophic** | Lock multi-year contracts; consider partnership/acquisition before they buy a competitor |
| **Parking Boss / Yardi** invests in tech depth | High | High | Beat them on per-property cost + ML accuracy |
| **Park Loyalty** raises Series B and goes broad | High | Medium | They're municipal-leaning; we go private-property + ML-first |
| **Plate Recognizer** packages a competing product | Low | High | Continued self-hosted SDK investment |
| **A new AI-first startup** raises $20M+ in this niche | Medium | Medium | Watch funding; consider raise to defend |

---

## 8. 12-month roadmap — multi-vertical edition

Ordered by leverage per build week toward the Metropolis-shape end state.

### Q1 (now → Aug 2026): Close the citizen-facing gap, ship the platform layer

The 3 missing citizen-facing features below are the SAME features residential needs as truck plazas need. Build once, deploy to all verticals.

- **C1 — Citation appeals workflow** (~1 week)
  Adds states `pending → appealed → adjudicated_paid / adjudicated_voided`. Operator + driver UI. Closes a table-stakes gap for every vertical.
- **C2 — Public plate look-up** (~3 days)
  `lookup.html` → enter plate → see open violations + outstanding fees.
- **C3 — Pay-to-release portal** (~1-2 weeks)
  Stripe-backed. Driver scans QR / visits URL → pays release fee → release token issued. **Highest revenue impact** — closes the cash-only release loop. Also serves as the residential pay-violation flow.

### Q2 (Aug → Nov 2026): Open the residential vertical

- **R1 — Apartment vertical kit** (~3 weeks)
  Permit categories: resident, employee, vendor day-pass, guest. Recurring permit renewal. Multi-citation escalation. UI tuned for apt managers.
- **R2 — Multi-property dashboard** (~2 weeks)
  Property-mgmt company sees N properties on one screen with cross-property aggregates.
- **R3 — Property-mgmt company hierarchy** (~1 week)
  Schema + RLS for company → properties → managers → tenants.
- **R4 — Yardi / RealPage / Entrata integration** (~3 weeks each, sequential)
  Read tenants from PMS, auto-generate permits. Parking Boss is bundled into Yardi today; we need the same hookup to win their customers.

### Q3 (Nov 2026 → Feb 2027): Scale + sales infrastructure

- **S1 — Compliance / audit-log report** (~1 week, sells to insurance partners)
- **S2 — White-label / partner API** (~2 weeks)
- **S3 — SOC 2 Type 1 prep** (~ongoing) — required for residential mgmt companies
- **S4 — Partner self-service onboarding** (~1 week) — tow companies sign up themselves
- **S5 — Camera health auto-alerting** (~3 days)

### Q4 (Feb → May 2027): Defend + expand to general commercial

- **D1 — End-to-end matching classifier** (replaces plateSimilar entirely)
- **D2 — Retail / hotel / hospital vertical kit** (~3 weeks)
- **D3 — Insurance / risk-rating data product**
- **D4 — Driver mobile app** (iOS + Android via React Native, ~6 weeks)
  Web is fine for Q1-Q3; Q4+ a real app starts to matter for citizen retention

### 2027+ (post-roadmap): The Metropolis-shape end state

- One driver app: scan-to-pay, look-up, dispute, register, view permits — across all properties
- One operator console: any vertical, any scale
- White-label / OEM relationships with property-mgmt companies
- Insurance / risk data products
- Eventually: enforcement layer for Metropolis itself (partnership not competition)

---

## 9. Positioning sentences

**External (sales / web hero / pitch deck):**

> **LotLogic is the AI parking-enforcement platform — purpose-built for every vertical. One system covers truck plazas, apartments, retail, hotels, and offices. Computer vision tunes itself to each lot. Drivers register, look up, pay, and dispute online. Operators manage every property from one dashboard.**

**The Metropolis-comparable framing (for investors):**

> **Metropolis is winning parking payments. LotLogic is winning parking enforcement. Same future, two halves of every parking transaction. We start where Metropolis isn't — truck plazas, residential, private property — and scale to every vertical that has cars and rules.**

**Technical / industry use:**

> **LotLogic provides edge-first ALPR ingest with auto-retraining computer vision, end-to-end citation lifecycle, and one driver portal across every vertical — at a fraction of the per-camera cost of legacy enforcement platforms.**

---

## 10. Glossary

| Term | LotLogic meaning |
|---|---|
| Permanent plate / Permit holder | Resident, employee, long-term tenant — `resident_plates` |
| Temporary pass / Visitor | Time-windowed authorization — `visitor_passes` |
| Driver | Operator of a detected vehicle (avoid "user" — they aren't a software user) |
| Property | A single physical lot — `properties` |
| Property mgmt company | A parent entity owning many properties (apartments use this; not yet in schema) |
| Owner | Books revenue for the property — `lot_owners` |
| Partner | Tow company contracted to enforce — `enforcement_partners` |
| Operator (UI sense) | Person clicking dashboard buttons |
| Session | Vehicle's continuous presence on a property — `plate_sessions` |
| Violation | Confirmed enforcement event — `alpr_violations` |
| Plate event | A single ALPR detection — `plate_events` |
| Hold | 24h post-tow cooldown — `plate_holds` |
| Vertical | A market segment with shared rules: truck plazas, residential, retail, etc. |
| Vertical kit | A configuration / UI overlay on top of the core platform that fits a specific vertical |

---

## 11. Update protocol

Update this doc when:
- A new competitor raises >$10M
- An acquisition shifts landscape (Rekor buys Park Loyalty, Yardi buys Parking Boss again)
- LotLogic ships a feature that closes one of the ❌ rows
- A new vertical is opened or closed
- The Metropolis-shape end-state thesis materially changes

Quarterly review minimum.
