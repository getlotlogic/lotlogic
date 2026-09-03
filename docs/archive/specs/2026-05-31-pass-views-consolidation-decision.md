# DECISION REPORT — Merge ActivePassTracker into TruckParkingLog

**File:** `/Users/gabe/lotlogic/frontend/dashboard.html`
**Status:** ANALYSIS ONLY. No code changed. This report gates a production edit while the NMLD tow crew is live.
**Method:** 12-agent workflow — 5 parallel scope scouts → wiring-preserving plan → 5 independent adversarial break-reviews → synthesis.

---

## SECTION 1 — ENTIRE SCOPE: condensed wiring map

| Component | Lines | Props | Fetches | Realtime | Mutations | localStorage |
|---|---|---|---|---|---|---|
| **ActivePassTracker** (DELETE) | 8751–9386 | `propertyId` | `getVisitorPasses(…,{limit:200})` 8774; `getOpenAlprViolations` 8775 | 2 channels: `…-passes-{id}` (visitor_passes) 8789; `…-alpr-{id}` (alpr_violations) 8792 | `cancelVisitorPass`; `/violations/{id}/mark-no-tow` 9044 | none |
| **TruckParkingLog** (KEEP) | 9388–9836 | `propertyId` | `getParkingLog(…,{filters,page,page_size:100})` 9419; CSV `format:'csv'` 9472 | 1 channel: `parking-log-realtime-{id}-{nonce}` (visitor_passes) 9448 | `cancelVisitorPass` per-row | none |
| **ALPRPropertyDetailPage** (parent) | 9838–10960 | `propertyId,onBack,user` | `loadAll` 8-fetch Promise.all; `loadNoReg` | per-slice channels | various | `lotlogic_pd_section` 9890/9893; `lotlogic_pd_group` |
| **RegisteredDrill** (UNTOUCHED) | 10960–11061 | `propertyId,propertyName,onBack` | `/lots/{id}/registered` | none | cancel branches on `pass_type` | none |

**Facts the change rests on:**
- Both pass views read the SAME table (`visitor_passes`); neither takes parent state — each fetches off `propertyId`. Clean to cut.
- `getOpenAlprViolations` (no-reg + cooldown violations) is fetched **ONLY** inside ActivePassTracker — NOT in `loadAll`. **The one capability with no other home → MUST be re-homed or it's lost.**
- Section chips (10253): `all` / `noreg` / (truck-only) `tracker` 10256 / `log`. Tracker integration points: chip 10256 + render block 10411–10416 (+ dead comment 3357).
- **CONFIRMED: TruckParkingLog has NO `useNowTick`.** `deriveStatus` 9532 reads `Date.now()` inline at 9536. (The 9880 `useNowTick` is the parent's.) Root of multiple risks.

## SECTION 2 — RegisteredDrill verdict
**KEEP, do not fold, out of scope.** Lives in the property-LIST page (drill-down modal ~11148), different component tree; hits `/lots/{id}/registered` (merges visitor_passes + resident_plates); cancel branches Temporary→/visitor_passes vs permanent→/resident_plates (10995). Zero coupling to the two pass views.

## SECTION 3 — CONSOLIDATION PLAN (wiring-preserving)
**Governing rule:** network contract + table subscriptions stay byte-identical. The segment toggle is a **pure client-side filter over `rows` already in memory.** `getParkingLog` (9414–9430), the 4-day `date_from` default (9404), pagination, CSV, and the visitor_passes channel (9448) are FROZEN. The only new fetch is the alpr_violations re-homing — a SEPARATE parallel fetch, never folded into getParkingLog.

**Deletions:** ActivePassTracker body 8751–9386; tracker render block 10411–10416; tracker chip 10256; dead comment 3357. *(render block + chip MUST ship atomically — a chip without a block = dead tab; a block without a chip = ghost section.)*

**Additions (all inside TruckParkingLog):** `seg` state (local, NOT persisted); `useNowTick()` no-arg; **rewire deriveStatus 9536 `Date.now()`→`nowTick`**; `alprViols` state + `loadViols` + own interval + 2nd channel `parking-log-alpr-{id}-{nonce}` (dep `[propertyId, loadViols]`); lightbox (fast path `alpr_violations.plate_events.image_url`, slow path `getLatestPlateEventForPlate`); bulk-select (violations seg only); folded ViolationCard + `/violations/{id}/mark-no-tow`; segment toggle UI, filter applied AFTER existing sort.

**FROZEN:** getParkingLog params/4-day default/visitor_passes channel/pagination/CSV/per-row Cancel/passTotalCount badge; `loadAll` (no edit); log header/Live dot.
**NO-TOUCH (verified shared):** `useNowTick` (2292, 3+ consumers); `FirstSeenEvidence` (6723, used by no-reg + log); `placardSwatch` (keep local copies); db method bodies; apartment `log` branch 10433+; loadNoReg/noreg section; auth/RLS/reCAPTCHA; migrations; all Playwright specs (zero ActivePassTracker refs).

## SECTION 4 — RISK REGISTER (5 reviews deduped, by severity)

| # | Area | What breaks | Sev | Likelihood | Fix |
|---|---|---|---|---|---|
| R1 | Stale `localStorage='tracker'` → **blank page** (5/5 reviewers) | Crew last on the "Active+Violations" tab has `lotlogic_pd_section='tracker'`. After deploy that chip + its only render block are gone → `showSection()` matches nothing → BLANK body on the primary daily surface. | **BLOCKER** | likely→certain | **MUST-FIX.** Initializer 9889: coerce `v==='tracker'?'log':v`. Same commit as deletion. |
| R2 | `deriveStatus` uses `Date.now()`, non-reactive (4/5) | Drives sort, pills, AND new seg filter off a frozen clock. A pass expiring while viewed stays "Active" until some other re-render; sort/pill/seg can disagree. | **HIGH** | likely→certain | **MUST-FIX.** 9536 `Date.now()`→`nowTick`. |
| R3 | seg ✕ Status-dropdown → **silent empty grid** (R4 reviewer) | Status `<select>` 9595 sends `status=` to backend; `seg` post-filters client-side. `status=active` + `seg=violations` → backend rows dropped by seg → blank, no error. | **HIGH** | likely | **MUST-FIX.** On setSeg reset `status=''`+page1+refetch, or hide Status dropdown when `seg!=='all'`. |
| R4 | **CSV omits alpr_violations** | `handleExport` 9472 → getParkingLog(csv) returns ONLY visitor_passes. Re-homed alprViols never enter `rows`. A "Violations" CSV for court/billing silently misses every no-reg/cooldown violation on screen. | **HIGH** | certain | **RESOLVED (owner 2026-05-31): export = PARKING PASSES ONLY.** Label the button "Export passes (CSV)"; do NOT include violations; no separate violations CSV. Behavior is now intended + honest. |
| R5 | 4-day window hides >4-day overstays | Old tracker's getVisitorPasses had NO date filter → surfaced expired overstays of any age. Log defaults to 4-day. A 5+-day overstay still on-lot drops from Violations. | **HIGH** | possible | **MUST-FIX.** Parallel "open overstay" fetch (status=expired, no date filter) feeding only the Violations seg; keeps getParkingLog frozen. |
| R6 | `total`/pagination misleading under seg | Header shows full-filter total + "Page X of Y" while seg shows a subset; paging pages the full set. | MEDIUM | certain | seg-local count; suppress/relabel global total + pagination when `seg!=='all'`. |
| R7 | alpr_violations realtime omitted → stale | If parallel fetch ships without its companion channel, new violations wait for next poll. | MEDIUM | possible | Plan handles; use dep `[propertyId, loadViols]` + per-mount nonce. |
| R8 | Export enabled on Violations seg → wrong CSV | `filtersDirty` 9498 excludes `seg`; clean form on violations seg → Export dumps ALL passes. | MEDIUM | likely | Resolved by R4's fix. |
| R9 | Enforcement prominence: seg defaults 'all' | First view = 4-day paginated list, violations buried (was the at-a-glance tracker). Not a crash. | LOW | likely | Owner: default seg to active/violations, or prominent pills. |
| R10 | null `valid_until` classified differently | Tracker→`expiring` (surfaced); log→`active` (never hits violations seg). | LOW | unlikely | null-guard in violations filter. |
| R11 | Rich ActivePassCard live-countdown layout not preserved | Big "2h 45m left" card → denser list row. Behavior preserved; visual changes. | LOW | n/a | Owner: port card into `seg==='active'` or accept row. |

**Consensus/disagreement:** R1 unanimous (plan wrongly marked the fix optional — promote to required). R2 caught independently by 4 reviewers + confirmed by file read (treat HIGH, not the lone LOW rating). R3/R4/R6/R8 single-sourced (Reviewer 4 owns search/CSV) but uncontradicted and genuine — do not discount.

## SECTION 5 — GO / NO-GO

**Verdict: CONDITIONAL GO (safe-with-fixes).** Architecture sound, wiring cuts cleanly, nothing else (incl. tests) references ActivePassTracker. But the naive plan ships TWO certain incidents (R1 blank page, R3 empty grid) unless fixed. Do NOT edit until the must-fixes are folded in.

**MUST-FIX before editing:** R1 (localStorage coercion), R2 (nowTick rewire), R3 (seg×status), R5 (overstay fetch), R4 (CSV scope — owner picks).
**SHOULD-FIX:** R7 (alpr channel), R6/R8 (seg count + export gate).
**Owner UX calls (non-blocking):** R9 (default seg), R11 (active card), R10 (null valid_until).

### Post-edit manual verification checklist (live app)
1. **R1:** devtools set `localStorage.lotlogic_pd_section='tracker'`, reload truck_plaza detail → lands on Parking Log, not blank.
2. **Re-homing:** property w/ open no-reg/cooldown violation → Violations seg shows the card, expands to camera image, X dismiss works.
3. **R5:** expired pass >4 days still on-lot → shows in Violations.
4. **R3:** Status="active" then click Violations seg → not silently empty.
5. **R2:** watch a pass cross `valid_until` while idle → moves Active→Violations, pill/badge/sort agree within ~30s.
6. **R4:** export from Violations seg → contents match decided behavior; button label/disabled honest.
7. **R7:** new alpr_violation from pipeline → appears in Violations without refresh.
8. **Frozen contract:** Network tab — getParkingLog params unchanged (4-day, page_size 100), pagination + per-row Cancel work, passTotalCount badge unchanged.
9. **Atomicity:** chip bar shows All / No Registration Evidence Package / Parking Log — no dead tab, no ghost section.
10. **Neighbors:** no-reg section, apartment-mode passes list, RegisteredDrill drill-down all still work.
