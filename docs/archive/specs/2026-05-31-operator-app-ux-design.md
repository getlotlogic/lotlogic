# LotLogic Operator/Enforcement-Crew App — UX Design Spec

**Date:** 2026-05-31
**Status:** Design proposal, ready for review
**Primary audience:** NMLD Towing crew (Victor, Frank) on phones in the field; secondary: lot operator

> Source: code-architect design pass over `frontend/dashboard.html` + backend endpoints, grounded in the crew's real field workflow. Line numbers reference `frontend/dashboard.html` at the time of writing — re-confirm before editing.

---

## 0. Hard Constraints (applied throughout)

1. User-facing copy uses **"parking pass"** exclusively. Never Resident / Visitor / Permanent / Temporary / Guest / Driver.
2. Surface everything: show low-confidence reads with confidence score, let crew dismiss; filter obvious OCR garbage (non-plate text).
3. Frame changes by UX impact first, technical detail second.
4. Implementation target: single `frontend/dashboard.html` in-browser-Babel React SPA. No build step.
5. Mobile-first: one-handed, 48dp+ tap targets, sunlight-readable contrast, tolerant of poor cell signal (cache aggressively, show stale data rather than blank).

---

## 1. Current-State Map of Crew-Facing Screens

### 1.1 Navigation
Partner role gets four bottom tabs (lines 12201–12204): **Jobs | Lots | Activity | Account**. Tab state persists in `localStorage.lotlogic_tab` (line 11806). Default on login: `jobs` (line 11949).

### 1.2 JOBS Tab — `JobsPage` (lines 4896–5817)
KPI bar (5263), live detection chips (5283), search input shown only when violations exist (5317), filter pills All/Overstays/Open/Handled (5326), partner nudge to add tow-truck plates (5344), "Dispatches awaiting your response" queue (5378–5450, plate + lot + Tow/No-tow), main violation list (5536–5817) with `ViolationSnapshot` (5600), live presence indicator (5612), actions (5764).
**Missing for the field crew:** no placard color on cards; no per-job "check if registered" link; no photo thumbnail on the awaiting-response rows; no one-tap call; no partner-truck sighting surface; no walk-the-lot mode.

### 1.3 LOTS Tab — `ALPRPropertiesPage` (line 12340)
`RegisteredDrill` (10960, no search), `ActivePassTracker` (8750–9277, two-column grid w/ placard chip at 9005), `TruckParkingLog` (9388, the full search UI: From/To, Plate, Company, Status, Apply, Export CSV; results cards w/ `FirstSeenEvidence`; empty state "No passes for these filters").
**Critical flaws:** filter-then-Apply (no as-you-type); date range defaults to last 4 days (a truck registered 5 days ago is invisible); Export disabled while filters dirty.

### 1.4 ACTIVITY — `OperatorActivityPage` (7697–8209)
7-day history + histograms. Reporting surface, not field-work.

### 1.5 ACCOUNT — `AccountPage` (8210–8285)
`TowTruckPlatesEditor` (7537), theme, refresh interval, logout.

### 1.6 `TowActivityPage` (11270–11399) — OWNER ONLY (gated at 12342, `isOwner`)
Clusters tow-truck sightings from `partner_truck_sightings`. **By design, the tow crew must NOT see their own truck sightings** — that's an owner/billing concern. Correctly owner-gated; leave it that way. (Earlier draft proposed exposing it to the crew; that idea is dropped.)

### 1.7 Auth
`LoginPage` (4704), `apiFetch` (2368, Bearer + 401 handling), `applySupabaseAuth` (2341).

---

## 2. The Headline Gap
There is no consolidated **"job page"** that answers, at lot-entry: *which vehicles are flagged to tow right now here? For each — is it physically present (photo)? Does it have a valid pass (one-tap check)? What does the placard look like (color match to windshield)? If registered, who do I call? If not, one tap to dispatch.* Instead there are three disconnected surfaces (Jobs / Lots / owner-only TowActivity), a search that needs an Apply tap, and placard color buried as a 10px chip in expanded cards.

---

## 3. Redesign Architecture
Don't build a separate app. Restructure the partner four-tab nav into a workflow-driven layout with a redesigned JOBS tab as the "field command center," and a crew-optimized instant-search on the LOTS tab. Additive changes to `JobsPage`, `TruckParkingLog`, and the nav list — no new files, no build change.
**Tab rename (partners):** Jobs / **Search** / Activity / Account — "Search" describes what the crew uses the Lots tab for (one-line change, 12203).

---

## 4. Screen-by-Screen Design

### 4.1 JOBS — "Field Command Center"
Each flagged row renders as a card: snapshot thumbnail (72×72, tappable to full-screen, from `plate_events.image_url` already in `getAllALPRViolations` line 3459); plate in large DM Mono; **confidence shown only when <0.85**; status pill (NO PASS red / OVERSTAY amber); company + contact; **placard color as an 18px+ swatch on the card face** (primary windshield-match cue); time since flagged; three actions: **View photo · Check pass · Tow**.
- **"Check pass"** → switch to Search tab, pre-fill plate, auto-run (no Apply). Impl: App-level `[searchPreset,setSearchPreset]` (~line 11809), thread `onSearchPlate` into JobsPage. ~15 lines.
- **Photo lightbox:** reuse the `Lightbox` pattern from `ConfirmationReviewView` (~6959–7080); extract to shared component.
- **Awaiting-response queue** (5400–5446): add 56×56 thumbnail (`v._snapshot_url`, line 4940) + placard color; grow Tow/No-tow to 48px.

### 4.2 SEARCH Tab (was LOTS)
**Search-as-you-type:** `db.getParkingLog(propertyId,{plate:q,company_name:q,page_size:30})` on 300ms debounce, no Apply. Backend already forgiving (visitor_passes.py ~228–255: normalized plate incl. trailer/back plate; tokenized ILIKE + trigram company). Default `from_date` 30 days for search. "Active only" toggle adds `status:'active'`.
**Result card (scannable):** plate large; big **verdict** ACTIVE (green) / NO PASS (red) / EXPIRING (amber); 18px placard swatch + name; company + expiry countdown; Photo + tappable Call (`tel:`); trailer plate if present.
**Never a dead "0 passes" wall** — empty state becomes: *"'ABC 1234' has no active parking pass at this lot. If it's here, it may be a legit tow."* + **[Dispatch tow →]** CTA. Note "Also searched trailer plates / last 30 days."
**Recent searches:** last 5 in `localStorage.lotlogic_recent_searches`, tappable chips when input empty.
**Placard color filter:** scrollable color pills above results, client-side filter on `placard_color` — find "the yellow placard truck" instantly.

### 4.3 Pass Detail (shared `PassDetailSheet`, ~150 lines)
Slide-up sheet usable from Search results and Jobs "Check pass." Plate 48px; 24px placard swatch; company + contact; full-width **tappable phone** (removes need to text owner for the number); stay/registered/expires + countdown; camera snapshot card; Cancel Pass + Dispatch Tow (confirm/hold before firing).

### 4.4 Tow-Decision Screen (defensible tow)
Shows the **snapshot evidence before** confirming + "No valid parking pass found." **"DISPATCH TOW" requires a 2-second hold** (`onPointerDown` timer, progress bar) — prevents accidental/glove/pocket taps. Success → green banner → card moves to "Awaiting tow co."

### 4.5 Partner-Truck Sighting Surface — REMOVED
Intentionally NOT built. The tow crew should never see their own truck sightings; that data stays owner-only (billing/correlation). `TowActivityPage` remains owner-gated.

---

## 5. Data Flow — Full Field Workflow
1. **Arrive / open Jobs** → `loadData()` (11870) → `getAllALPRViolations()` (11906) → `JobsPage` `mappedAlpr` (4926); FLAGGED filter = `action_taken IS NULL`.
2. **Eyeball lot** → tap card → full-screen photo; placard swatch matches windshield.
3. **Confirm no pass** → "Check pass" → Search pre-filled → `GET /visitor_passes/parking-log?plate=…&from_date=30d` (forgiving) → ACTIVE card or NO PASS + Dispatch CTA.
4. **Tow with evidence** → confirm screen (photo shown) → 2s hold → `dispatchALPRViolation` → status `dispatched`, `action_channel='dashboard'`.
5. **Spot-check others** → Search, type plate, <300ms verdict; recent searches speed the next.

---

## 6. ASCII Wireframes

### 6.1 Jobs — Field Command Center
```
┌────────────────────────────────────────────┐
│  JOBS — Charlotte Travel Plaza         [↻] │
├──────────────┬──────────────┬──────────────┤
│  3  FLAGGED  │  12  ACTIVE  │  2  DONE     │
│ [FLAGGED▼] [ALL JOBS] [HANDLED TODAY]      │
├────────────────────────────────────────────┤
│ ┌──────────────────────────────────────┐   │
│ │ [cam 72x72]  ABC 1234   conf 0.83    │   │
│ │              NO PASS  ●              │   │
│ │  Mitchell · CiCi Trucking            │   │
│ │  ████ YELLOW placard     43 min ago  │   │
│ │  [📷 Photo] [🔍 Check pass] [Tow →]  │   │
│ └──────────────────────────────────────┘   │
├────────────────────────────────────────────┤
│  [ Jobs ]  [ Search ] [ Activity ][Acct]   │
└────────────────────────────────────────────┘
```

### 6.2 Search — Instant Pass Lookup
```
┌────────────────────────────────────────────┐
│  Search Passes — Charlotte Travel Plaza    │
│ ┌──────────────────────────────────────┐   │
│ │ 🔍  ABC 1234                       ✕ │   │
│ └──────────────────────────────────────┘   │
│  [● All] [● Active] [● Violations]         │
│  Placard: [All][● Red][● Yel][● Blue]      │
├────────────────────────────────────────────┤
│ ┌──────────────────────────────────────┐   │
│ │  ABC 1234                ✓ ACTIVE    │   │
│ │  ████ Yellow   CiCi Trucking         │   │
│ │  Expires in 22h 56m · Jun 1 9:44AM   │   │
│ │  Trailer: XYZ 8888                   │   │
│ │  [📷 Photo]   [📞 Call]              │   │
│ └──────────────────────────────────────┘   │
│  Recent: [ABC 1234] [XYZ 9876] [CiCi]      │
└────────────────────────────────────────────┘
```

### 6.3 No Pass Found
```
┌────────────────────────────────────────────┐
│ 🔍  QRS 5555                            ✕  │
│            NO PASS FOUND                    │
│  "QRS 5555" has no active parking pass      │
│  at Charlotte Travel Plaza.                 │
│  [Dispatch tow for QRS 5555 →]              │
│  Also checked trailer plates · last 30 days │
└────────────────────────────────────────────┘
```

### 6.4 Tow Decision
```
┌────────────────────────────────────────────┐
│  DISPATCH TOW?    QRS 5555                   │
│  Lot: Charlotte Travel Plaza                │
│  ┌──────────────────────────────────────┐  │
│  │  [Camera snapshot, full width]       │  │
│  │  South Gate · May 31 4:12 PM         │  │
│  └──────────────────────────────────────┘  │
│  No active parking pass found.              │
│  [ Cancel ]   [ DISPATCH TOW — hold 2s ]    │
│               ████████░░░░░ (hold)          │
└────────────────────────────────────────────┘
```

---

## 7. Prioritized Punch List

### P1 — Quick Wins (0–2h each)
- **QW-1** Rename LOTS→"Search" for partners (12203). *Crew instantly knows where to look up plates.*
- **QW-2** Placard swatch 10px→18px + bold name on card face (9554, 8906). *One-glance windshield match in sunlight.*
- **QW-3** Photo thumbnail (56×56) on awaiting-response rows (5406–5446, `_snapshot_url`). *See the vehicle before tapping Tow.*
- **QW-4** Remove Apply requirement — fire search on plate/company change w/ 400ms debounce (9488, 9414). *The "I search and it don't show" problem disappears.*
- **QW-5** Default 30-day range when plate/company non-empty (9402). *A truck from last week is findable.*
- **QW-6** Phone as `tel:` link (9740). *Call the company without copying the number.*
- **QW-7** Show confidence only when <0.85 (4956 + card render). *Know when to double-check a plate.*
- **QW-8** Empty-state copy → definitive "No active parking pass found for [plate]" (9658). *An answer, not a dead end.*

### P2 — Medium (3–8h each)
- **ME-1** Recent searches w/ localStorage chips.
- **ME-2** Placard-color filter pills on results.
- **ME-3** "Check pass" on job cards → pre-filled Search via App-level `searchPreset` (~15 lines). *6 taps → 1.*
- **ME-4** "Dispatch tow" CTA from search empty state.
- **ME-5** 72×72 photo thumbnail on job cards (`loading="lazy"`).
- **ME-6** Shared `Lightbox` component (extract from 6959–7080).
- **ME-7** Stacked job-card layout, full-width 48px Tow button. *No mis-taps one-handed.*

### P3 — Larger (1–3 days each)
- **LR-1** `PassDetailSheet` bottom sheet (~150 lines; can absorb redundant inline expansions for ~net +70).
- **LR-3** Tow-decision confirmation w/ 2-second hold (~80 lines).
- **LR-4** "Walk-the-lot" mode — full-screen plate input, as-you-type verdict, Clear for next (~120 lines). *Check 20 plates in 5 min.*

---

## 8. Implementation Map (all in `frontend/dashboard.html`)
| Item | Location | Change |
|---|---|---|
| QW-1 | 12203 | `label:'Search'` |
| QW-2 | 9554, 8906–8909 | swatch 18px + bold name |
| QW-3 | 5406–5446 | add `<img src={v._snapshot_url}>` 56×56 |
| QW-4 | 9488–9492, 9414 | debounced useEffect on plate/company |
| QW-5 | 9402 | extend from_date to −30d when searching |
| QW-6 | 9740 | wrap phone in `<a href="tel:…">` |
| QW-7 | 4956 + card render | `{conf<0.85 && …}` |
| QW-8 | 9658–9662 | conditional empty-state copy |
| ME-1 | ~9389 | recent-search state + localStorage |
| ME-2 | ~9651 | derive colors, pills, client filter |
| ME-3 | 4896, 5767+ | `onSearchPlate` prop + App state |
| ME-4 | 9658–9662 | verdict + Dispatch CTA |
| ME-5 | 5547+ | img left of card |
| ME-6 | ~6959 | extract `Lightbox` |
| ME-7 | 5767–5813 | stacked, full-width Tow |
| LR-1 | ~9385 | `PassDetailSheet` ~150 lines |
| LR-3 | new/JobsPage | confirm + hold ~80 lines |
| LR-4 | new + FAB | walk-the-lot ~120 lines |

---

## 9. Critical Details
- **Error handling:** on failed search refresh (bad signal) keep last result w/ "stale" marker, never blank. Dispatch failure → toast, keep screen open, never silent. Lightbox: spinner → "Photo unavailable" on 404, never broken-image icon.
- **State:** `searchPreset` App-level atom (init null, consumed+cleared on Search mount). Recent searches FIFO max 5, try/catch localStorage. Lift `lightbox` state to App if shared.
- **Performance:** `loading="lazy"` thumbnails; 300ms debounce on text, 0ms on color/status (client-side); `page_size:30` for instant search (relies on backend trigram ranking). Existing `visitor_passes` realtime sub (9448) covers live updates.
- **Security:** `searchPreset` is internal, not URL-derived (no XSS). "Dispatch tow" must anchor to an existing `alpr_violations.id` or create a tracked `tow_jobs` row first (audit trail) — never a naked tow. Partner sighting query scoped to `tow_company_id`.
- **Backward-compat:** date-range search keeps Apply; only plate/company fire on-type. `ActivePassTracker` grid unchanged. New props optional-defaulted.

---

## 10. Open Questions (resolve before building the dependent items)
1. **`alpr_violations` vs `tow_jobs`** — "Dispatch tow" from a no-pass search: if a matching open `alpr_violation` exists at this property use `dispatchALPRViolation`; else create a `tow_jobs` row. `GET /visitor_passes/check-active` is a clean pre-flight.
3. **File size** — changes add ~600 lines (→ ~10.6k). Within the existing single-file pattern but flagged by the CLAUDE.md audit mandate; let LR-1 replace redundant inline expansions to stay closer to net-zero.

---
*Design proposal — review, then we sequence implementation (P1 quick wins first).*
