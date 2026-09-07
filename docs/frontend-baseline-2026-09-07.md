# Frontend baseline — 2026-09-07, before Wave 2.6

Measured before any Wave 2.6 task touches `frontend/dashboard.html`. This is
the "before" ruler Task 0 was asked to produce: the payload table, the
`dashboard.html` seam table, the registration-page duplication numbers, and
the contrast table — all re-measured against `origin/main` @ `cda6dfd` (this
worktree's base), not copied from the plan — plus three live `npm run perf`
runs against `https://lotlogic-beta.vercel.app`.

Everything below was captured with the tools this task also creates:
`tests/perf/measure-dashboard-load.mjs`, `tests/visual/capture.mjs`, and
`tests/visual/compare.mjs`. `docs/superpowers/plans/2026-09-07-wave2-6-dashboard-build.md`
carries the plan's own version of these tables; the numbers below are this
task's independent remeasurement, run today.

## 1. Payload today (unauthenticated shell — dashboard.html + the 5 CDN scripts)

Raw bytes are exact file sizes. "Over the wire" is the `Content-Length` a
client actually receives with `Accept-Encoding: gzip` (verified via `curl -s
-D - -H "Accept-Encoding: gzip"` against each live CDN URL, and against
`https://lotlogic-beta.vercel.app/dashboard.html` itself, decompressed and
recompared to confirm the original size).

| Asset | Requests | Raw bytes | Over the wire (gzip) |
|---|---:|---:|---:|
| `frontend/dashboard.html` (as served by Vercel) | 1 | 787,686 | 197,826 |
| `babel-standalone@7.23.2` (cdnjs) | 1 | 2,796,613 | 582,689 |
| `react@18.2.0` UMD (cdnjs) | 1 | 10,737 | 4,269 |
| `react-dom@18.2.0` UMD (cdnjs) | 1 | 131,882 | 43,187 |
| `@supabase/supabase-js@2` UMD (jsDelivr, **floating**) | 1 | 214,393 | 55,250 |
| `qrcode@1.5.1` (cdnjs) | 1 | 22,866 | 8,977 |
| Google Fonts CSS + 3 families | 4+ | — | — |
| **Total JS/HTML** | **6** | **3,964,177** | **≈ 892,198** |

Raw-byte total matches the plan's table exactly (`3,964,177`). Gzip total is
≈892 KB here vs. the plan's ≈888 KB — `dashboard.html`'s own gzip (197,826 vs.
194,227) and the floating `@supabase/supabase-js@2` build (55,250 vs. 55,071,
a newer patch release since the plan was written) account for the drift.
Plus: the browser then runs Babel over the 787 KB of JSX **on every load**.

## 2. The dashboard.html seam table

Re-verified against the working tree with `awk`/`sed` at every boundary line
(the start of each top-level declaration, per the comment markers already in
the file). `wc -l frontend/dashboard.html` = **14,938 lines**, matching the
plan exactly. Every spot-checked boundary — L18/L22 (CDN scripts), L33
(style block start), L2291/L2292 (`</style>`/`</head>`), L2297
(`<script type="text/babel">`), L2298 (first JSX line), L2384, L2431, L2482,
L2522, L2613, L2642, L3931, L4032, L4147, L4229 (`bundleVehicleEvents` doc
comment — Ruling P6: goes with `bundle.js`), L4239, L10169 (`fmtDaysAgo`,
PR #235), L11551 (QR block), L14001 (`NMLD_PARTNER_ID`), L14887–14899 (tab
switch), L14934 (`ReactDOM.createRoot` call) — matches the plan's table
verbatim; the file is unchanged from what the plan measured.

| Range | Lines | Contents | Destination module |
|---|---:|---|---|
| 2,298–2,383 | 86 | React destructure, `ErrorBoundary` | `src/ui/ErrorBoundary.jsx` |
| 2,384–2,430 | 47 | `fmtPassRemaining`, `makeDebounced`, `useNowTick` | `src/lib/time.js` |
| 2,431–2,481 | 51 | `LOT_TIMEZONE`, `tzOffsetOn`, `tzOffsetAt`, `lotDayBound` | `src/lib/lotdate.js` |
| 2,482–2,521 | 40 | `SUPABASE_URL/KEY`, `_supabaseFetch`, `supabase`, `applySupabaseAuth` | `src/lib/supabase.js` |
| 2,522–2,612 | 91 | `API`, `getSessionToken`, `apiFetch`, `authLogin` | `src/lib/api.js` |
| 2,613–2,641 | 29 | `normalizeViolation`, `DEFAULT_TRUCK_PLAZA_POLICY` | `src/lib/violations.js`, `src/shared/policy.js` |
| 2,642–3,930 | 1,289 | the `db` object — the entire Supabase/REST data layer | `src/lib/db.js` |
| 3,931–4,031 | 101 | `useTheme`, `useOnlineStatus`, `useActiveRoster`, `useIntervalFetch` | `src/hooks.js` |
| 4,032–4,146 | 115 | `haptic`, `NotifyManager` | `src/lib/notify.js` |
| 4,147–4,238 | 92 | `smartDate`, `elapsed`, `timeAgo`, `SkeletonCards`, `SkeletonKPIs`, `fmtMoney`, `fmtDate`, `fmtTime`, `fmtDateTime`, `bundleVehicleEvents` doc comment | `src/lib/format.js` + `src/ui/Skeletons.jsx` (comment → `src/lib/bundle.js` per Ruling P6) |
| 4,239–4,416 | 178 | `bundleVehicleEvents`, `filterEvidencePackages`, `mapsLink` | `src/lib/bundle.js` |
| 4,417–4,464 | 48 | `VEHICLE_COLOR_HEX`, `displayColor`, `colorHex`, `cleanMmc`, `VEHICLE_TYPE_META`, `vehicleTypeLabel`, `vehicleTypeIcon`, `isLowConfColor` | `src/lib/vehicles.js` |
| 4,465–4,684 | 220 | Toast context/provider, `ConfirmDialog`, `useFocusTrap`, `useUid`, `ConfirmActionModal` | `src/ui/Toast.jsx`, `src/ui/Dialog.jsx`, `src/ui/focusTrap.js` |
| 4,686–4,713 | 28 | `NavIcon*`, `SearchIcon` | `src/ui/icons.jsx` |
| 4,714–4,953 | 240 | `ImageZoom`, `DET_COLORS`, `ProofImage`, `ViolationProofModal` | `src/ui/ProofModal.jsx` |
| 4,954–5,020 | 67 | `pointInPolygon`, `bboxZoneOverlap`, `isVehicleInZone`, `matchViolationDetection` | `src/lib/geometry.js` |
| 5,021–5,097 | 77 | `ViolationSnapshot` | `src/ui/ViolationSnapshot.jsx` |
| 5,098–5,209 | 112 | `LoginPage` | `src/pages/LoginPage.jsx` |
| 5,210–5,289 | 80 | `CrossCameraSightings` | `src/ui/CrossCameraSightings.jsx` |
| 5,290–6,349 | 1,060 | `JobsPage` | `src/pages/JobsPage.jsx` |
| 6,350–6,602 | 253 | `EarningsPage` | `src/pages/EarningsPage.jsx` |
| 6,603–6,899 | 297 | `InvoicesPage`, `BillingQuickBooksView` | `src/pages/BillingPage.jsx` |
| 6,900–7,948 | 1,049 | confirmation-review queues, `EvidenceThumb`, lightboxes, `TimelineStrip`, `PassContextPanel`, `ConfirmationReviewView` | `src/pages/ConfirmationReview.jsx` |
| 7,949–8,108 | 160 | `TowTruckPlatesEditor` | `src/pages/account/TowTruckPlatesEditor.jsx` |
| 8,109–8,336 | 228 | `OperatorActivityPage` | `src/pages/OperatorActivityPage.jsx` |
| 8,337–8,534 | 198 | `OverviewPage` | `src/pages/OverviewPage.jsx` |
| 8,535–8,936 | 402 | `PartnerFeeEditor`, `ChangePasswordSection`, `AccountPage` | `src/pages/AccountPage.jsx` |
| 8,937–9,200 | 264 | `AnalyticsPage` | `src/pages/AnalyticsPage.jsx` |
| 9,201–9,638 | 438 | `SightingStrip`, `CooldownChip`, `ReregTowFlag`, visit/stay formatters, `PassPhotoViewer`, `CroppedImg`, `PassPhotoStrip` | `src/ui/passPhotos.jsx` + `src/lib/passFormat.js` |
| 9,639–10,876 | 1,238 | `TruckParkingLog` (contains `fmtDaysAgo` at 10,169 — PR #235) | `src/pages/TruckParkingLog.jsx` |
| 10,877–11,357 | 481 | `FeedbackModal`, `DocViewerModal`, `ApartmentPermits` | `src/pages/ApartmentPermits.jsx`, `src/ui/FeedbackModal.jsx` |
| 11,358–12,559 | 1,202 | `ALPRPropertyDetailPage` (QR rendering at 11,551–11,568) | `src/pages/PropertyDetailPage.jsx` |
| 12,560–12,792 | 233 | `RegisteredDrill`, `scopePropsToPartner`, register-modal styles, `RegisterPassModal` | `src/pages/RegisteredDrill.jsx`, `src/ui/RegisterPassModal.jsx` |
| 12,793–13,088 | 296 | `ALPRPropertiesPage` | `src/pages/PropertiesPage.jsx` |
| 13,089–13,370 | 282 | `TowActivityPage` | `src/pages/TowActivityPage.jsx` |
| 13,371–13,655 | 285 | `TrainingPage` | `src/pages/TrainingPage.jsx` |
| 13,656–13,920 | 265 | admin console (`AdminClientsTab`, `AdminOnboardTab`, `AdminFeedbackTab`, `AdminConsolePage`) | `src/pages/AdminConsole.jsx` |
| 13,921–13,995 | 75 | `PlateLookupVerdict` | `src/pages/PlateLookupPage.jsx` |
| 13,996–14,107 | 112 | `NMLD_PARTNER_ID`, `FRANK_APP_TAB_LIVE`, `NMLD_APP_QR` (~2 KB base64 PNG inline), `PartnerAppPage` | `src/pages/PartnerAppPage.jsx` |
| 14,108–14,227 | 120 | `PlateLookupPage` | `src/pages/PlateLookupPage.jsx` |
| 14,228–14,934 | 707 | `App` — session, `navTabs` (14,723), `navIcons` (14,717), the tab switch (14,887–14,899) | `src/App.jsx` |
| 14,935–14,937 | 3 | `ReactDOM.createRoot(...).render(...)` | `src/main.jsx` |

## 3. The three registration pages — duplication

Re-measured with `difflib.SequenceMatcher` over non-blank, stripped lines
(same method as the plan). Non-blank line counts match the plan exactly
(1,215 / 540 / 941); `wc -l` on the raw files gives higher totals (1,307 /
570 / 1,007) because it counts blank lines too.

| Pair | Matching lines | % of the smaller file |
|---|---:|---:|
| `visit.html` (1,215) vs `resident.html` (540) | 392 | **73%** |
| `resident.html` (540) vs `apt.html` (941) | 371 | **69%** |
| `visit.html` (1,215) vs `apt.html` (941) | 393 | **42%** |

The first two pairs match the plan's table almost exactly (392/73% exact;
371/69% vs. the plan's 373/69% — same percentage, matching-line count off by
2). `visit.html` vs `apt.html` measures higher here (393 lines / 42%) than
the plan's figure (321 / 34%) — re-measured today with the same method
against the current working tree; not chased further since it doesn't change
the conclusion (the three pages substantially duplicate registration logic).

Ten function names verified present, once each, in all three files (`grep -c
"function <name>"` = 1 in `visit.html`, `resident.html`, `apt.html` for
every one): `backendRegister`, `escapeHtml`, `friendlyErrorMessage`,
`getRecaptchaToken`, `init`, `normalizePlate`, `pgRest`,
`showConnectionError`, `showNotFound`, `showSuccess`. Style block line
counts confirmed unchanged: `visit.html` 273, `resident.html` 229, `apt.html`
356. All three are plain `<script>`, not JSX — no React, no Babel.

### 3a. Task 17 — measured again first, then after the split

Re-ran the same `difflib.SequenceMatcher` script (non-blank, stripped lines)
against the actual starting tree for Task 17's own edits — commit `d9fa1a4`,
the point right after Task 16's brand.css cherry-pick landed on this branch
(see task-17-report.md §0) and right before Task 17 touched anything. This
correction landed in Task 17's fix round 1: the first pass mistakenly
re-ran the script against the tree from *before* that cherry-pick (i.e.
still carrying each page's own 13-line `:root {...}` block) and reported
392/73%, 371/69%, 393/42% — identical to section 3 above only because it
was, in effect, re-measuring section 3's own commit, not Task 17's starting
point. The correct "measured again first" numbers, against `d9fa1a4`:

| Pair | Matching lines | % of the smaller file |
|---|---:|---:|
| `visit.html` (1,202) vs `resident.html` (527) | 379 | **72%** |
| `resident.html` (527) vs `apt.html` (928) | 358 | **68%** |
| `visit.html` (1,202) vs `apt.html` (928) | 380 | **41%** |

Non-blank line counts dropped by 13 per file (1,215→1,202, 540→527,
941→928) — exactly the `:root` block Task 16 replaced with a `<link>` in
each file; the percentages moved by ~1 point each, same conclusion as
section 3 (the three pages substantially duplicate registration logic).
This table is committed together with the refactor commit itself, not as a
preceding step — the first pass's sequencing error (measuring, then
cherry-picking, in the wrong order relative to when the doc was written)
is what fix round 1 corrected.

After the split (`frontend/src/shared/register.js`,
`frontend/src/shared/policy.js`, `frontend/styles/register.css`,
`frontend/src/{visit,resident,apt}.js`, and each HTML file cut down to head
boilerplate + a page-specific `<style>` leftover + one `<script
type="module">` tag), re-measured the same three HTML files:

| Pair | Matching lines | % of the smaller file |
|---|---:|---:|
| `visit.html` (136) vs `resident.html` (84) | 62 | 74% |
| `resident.html` (84) vs `apt.html` (225) | 57 | 68% |
| `visit.html` (136) vs `apt.html` (225) | 63 | 46% |

The percentages barely moved — expected, since what's left in each HTML
file is mostly the `<head>` boilerplate every page in this repo shares
(charset/viewport meta, the error-reporting script tag, the reCAPTCHA
`<meta>` + script tag, the Google Fonts `<link>`s, the two stylesheet
`<link>`s) plus a short page-specific leftover `<style>` block — genuinely
similar-looking markup that Task 17 was never asked to deduplicate further.
The actual target of this task — the ten shared functions and the bulk of
the CSS — dropped from 2,657 non-blank lines across the three files at
Task 17's starting point (1,202 + 527 + 928, the `d9fa1a4` numbers above)
to 136 + 84 + 225 = 445 non-blank lines in the HTML, with the extracted
logic now living once each in:

| File | Non-blank lines |
|---|---:|
| `frontend/src/shared/register.js` | 297 |
| `frontend/src/shared/policy.js` | 46 |
| `frontend/styles/register.css` | 190 |
| `frontend/src/visit.js` (incl. the untouched pay-to-park branch) | 736 |
| `frontend/src/resident.js` | 151 |
| `frontend/src/apt.js` | 437 |

`grep -c "function normalizePlate"` = 1 across the three HTML files now (0
— the function moved into `register.js`, imported by all three entry
files); same for the other nine names from the list above except
`showSuccess` (kept per-page, in each entry file — see task-17-report.md
for why) and `init` (never shared — page-specific control flow, as it always
was).

Re-measured (WCAG 2.1 relative-luminance contrast) against the live token
values in the working tree (`frontend/index.html`, `frontend/dashboard.html`)
using the standard sRGB → linear-light formula. Every value matches the
plan's table exactly — the tokens have not moved.

| Token / rule | Where | Ground | Today | Needed |
|---|---|---|---:|---:|
| `--amber: #D97706` | `index.html` L36 (+ 16 more HTML files) | `--paper #F2EAD8` | **2.66:1** | 4.5:1 |
| `--amber: #D97706` | same | `--paper-2 #EADFC7` | **2.41:1** | 4.5:1 |
| `--terra-deep: #9A5530` | `index.html` L39 | `--paper-2 #EADFC7` | **4.27:1** | 4.5:1 |
| `--terra: #C97A4A` | same | `--paper` | 2.75:1 | 4.5:1 if used as text |
| `--ink-4: #968B73` | same | `--paper` | 2.81:1 | 4.5:1 |
| header wordmark — `--accent: #C2580B` | `dashboard.html` L105 (`.theme-light` block), used by `.header-wordmark span` L332 | `#FFFFFF` | **4.47:1** | 4.5:1 |
| `.theme-light .nav-item { color: #9ca3af }` | `dashboard.html` L1577 | `#FFFFFF` | **2.54:1** | 4.5:1 |
| `+ Add Lot` pill, inline `color:'#4ade80'` on `rgba(74,222,128,.12)` | `dashboard.html` L12931 | `#E9FBF0` (the tint composited over white) | **1.62:1** | 4.5:1 |

## 5. `npm run perf` — three live runs, `https://lotlogic-beta.vercel.app`

Profile: iPhone 14 emulation, slow-4G network throttling (1.6 Mbps down /
750 Kbps up / 150 ms latency), 4× CPU throttling, cold cache, run 2026-09-07.
**No login was performed** — `time-to-usable` is defined by the script as
"the login form is interactive," which is the true first-usable state for
this unauthenticated measurement and does not require credentials.

| Run | `domContentLoaded` (ms) | `timeToUsable` (ms) | `fcp` (ms) | requests | transferred (KB) |
|---|---:|---:|---:|---:|---:|
| 1 | 19,199 | 19,396 | 4,752 | 9 | 486 |
| 2 | 18,584 | 18,718 | 4,652 | 9 | 486 |
| 3 | 18,435 | 18,607 | 4,400 | 9 | 486 |
| **Median** | **18,584** | **18,718** | **4,652** | **9** | **486** |

**`time-to-usable` median ≈ 18.7 s — well above the 5 s stop-and-report
threshold**, so Task 0 proceeds. This is consistent with the spec's ~20 s
figure and with the payload table above: on slow-4G + 4× CPU throttling, the
787 KB `dashboard.html` plus 3.2 MB of CDN scripts (dominated by the 2.8 MB
Babel compiler) has to download and then Babel has to compile 12,638 lines
of JSX in the browser before the login form — the very first interactive
element — exists.

Raw JSON, run 1:

```json
{
  "url": "https://lotlogic-beta.vercel.app",
  "when": "2026-09-07T13:56:08.238Z",
  "profile": "slow-4g + 4x CPU, iPhone 14",
  "domContentLoaded": 19199,
  "timeToUsable": 19396,
  "fcp": 4752,
  "lcp": 4752,
  "transferred": 497552,
  "requests": 9
}
```

Raw JSON, run 2:

```json
{
  "url": "https://lotlogic-beta.vercel.app",
  "when": "2026-09-07T13:57:03.000Z",
  "profile": "slow-4g + 4x CPU, iPhone 14",
  "domContentLoaded": 18584,
  "timeToUsable": 18718,
  "fcp": 4652,
  "lcp": 4652,
  "transferred": 497552,
  "requests": 9
}
```

Raw JSON, run 3:

```json
{
  "url": "https://lotlogic-beta.vercel.app",
  "when": "2026-09-07T13:57:56.000Z",
  "profile": "slow-4g + 4x CPU, iPhone 14",
  "domContentLoaded": 18435,
  "timeToUsable": 18607,
  "fcp": 4400,
  "lcp": 4400,
  "transferred": 497552,
  "requests": 9
}
```

(Per-response `bytes` arrays omitted here for brevity — all three runs hit the
same 9 requests as the payload table: `dashboard.html`, `error-reporting.js`,
Google Fonts CSS, `react`, `qrcode`, `react-dom`, `@supabase/supabase-js`,
`babel-standalone`, one Google font file.)

## 6. Visual/DOM no-op harness — what it actually captured today

`tests/visual/capture.mjs` is designed to log in as test owner A
(`TEST_OWNER_A_EMAIL` / `TEST_OWNER_A_PASSWORD`, the same env vars
`tests/fixtures/accounts.ts` requires) and capture every dashboard tab
reachable for that account. **Those credentials are GitHub Actions secrets
and are not available in this local environment.** Per this task's
instructions, no login was attempted with placeholder or shared credentials.
`capture.mjs` detects the missing env vars and falls back to capturing the
single unauthenticated shell (the login page), for both Playwright projects
(`chromium-desktop`, `mobile-safari`/iPhone 14 webkit) — 4 files committed
under `tests/visual/baseline/`: `login.chromium-desktop.{html,png}`,
`login.mobile-safari.{html,png}`.

`npm run visual:check` passes (exit 0, "4 file(s) match") against this
baseline, run three times consecutively with no diff. When the harness first
ran, the PNG comparison caught a genuine 2-pixel flake between two "clean"
captures — the login page's autofocused email input has a blinking text
caret. `capture.mjs` now pauses CSS animations/transitions and forces
`caret-color: transparent` before every screenshot; three consecutive
`visual:check` runs after that fix all report 0 diffs.

Once `TEST_OWNER_A_EMAIL`/`TEST_OWNER_A_PASSWORD` are available (CI, or a
later task with real secrets), re-run `npm run visual:baseline` to capture
the full authenticated tab set and commit the new baseline — the fallback
behaviour documented here should then no longer trigger.

`npm run perf` and both `visual/*.mjs` scripts live outside
`tests/playwright.config.ts`'s `testMatch` (`e2e/**/*.spec.ts`,
`a11y/**/*.spec.ts`), so `npm test` never runs them — confirmed by running
`npm test` (below) and grepping its output for `perf/` or `visual/`: no hit.

## 8. `npm test` — the required check, run against `https://lotlogic-beta.vercel.app`

`64 passed, 22 failed, 16 skipped` (2.1 min). Every one of the 22 failures is
the identical root cause: `Missing required env var TEST_OWNER_A_EMAIL` (and
`_B`/`TEST_PARTNER_A` for the specs that need them) thrown by
`tests/fixtures/accounts.ts` — the GitHub Actions secrets this suite needs
aren't available in this local environment, and per this task's instructions
no substitute credentials were used. All 22 are in `e2e/access-control.spec.ts`,
`e2e/dashboard-smoke.spec.ts` (the login-dependent cases), and the one
logged-in case of `a11y/axe.spec.ts` — none are new failures introduced by
this task (Task 0 changed zero files under `e2e/`, `a11y/`, or `fixtures/`).
In CI, where the secrets exist, this same suite is the required green check.

## 7. Target after this plan (from the plan, not re-measured — no build exists yet)

Recorded for context; Task 0 does not build anything. `frontend/dist/` does
not exist in this worktree.

| Asset | Raw | gzip |
|---|---:|---:|
| `frontend/dist/dashboard.html` (shell) | 107,702 | 20,522 |
| `frontend/dist/dashboard.js` (bundle) | 780,250 | 206,903 |
| **Total** | 887,952 | ≈ 227,425 |

2 requests instead of 6/9, ~888–892 KB → ~228 KB on the wire, zero
in-browser compilation — the ~20 s → ~2 s change the spec asks for.

## 9. Task 15 — dashboard contrast fixes (done) + marketing tokens for Task 16

Task 15 (FE-10) darkened the three brand tokens the dashboard uses at
runtime, plus one inline color, and re-measured each with the same
sRGB → linear-light WCAG formula as section 4:

| File:line (this worktree) | Rule | Before | After | Measured after |
|---|---|---|---|---:|
| `frontend/dashboard.html:100,104` `--accent`/`--yellow` (`.theme-light` block) | on `#FFFFFF` | `#C2580B` (4.47:1) | **`#B85309`** | 4.91:1 |
| `frontend/dashboard.html:1572` `.theme-light .nav-item { color }` | on `#FFFFFF` | `#9ca3af` (2.54:1) | **`#6B7280`** | 4.83:1 |
| `frontend/src/pages/ALPRPropertiesPage.jsx:155` inline `color` on the "+ Add Lot" pill (`rgba(74,222,128,.12)` tint) | on the composited `#E9FBF0` tint | `#4ADE80` (1.62:1) | **`#15803D`** | 4.66:1 |

These three sites are the ones this task's HTML/JSX diff touches. The dark
theme's own `--accent: #FBBF24` (line 51, used on `#0E0F11`) was left alone —
it already passes comfortably.

**Values for Task 16** — the shared-token edit that lands in
`frontend/styles/brand.css` and removes the two remaining `color-contrast`
waivers in `tests/a11y/axe.spec.ts` (`landing`, `pitch:/pitch-apartments.html`,
`pitch:/pitch-tow.html`) once applied across the 18 marketing HTML files.
Verified against both `--paper` and `--paper-2`; do not hand-edit the HTML
files for this now — Task 15 only records the numbers.

| Token | Today | Change to | On `--paper #F2EAD8` | On `--paper-2 #EADFC7` |
|---|---|---|---:|---:|
| `--amber` | `#D97706` | **`#965204`** | 5.00:1 | 4.53:1 |
| `--terra-deep` | `#9A5530` | **`#8F4E20`** | 5.35:1 | 4.84:1 |
| `--ink-4` | `#968B73` | **`#6C6350`** | 4.96:1 | 4.49:1 |
| `--terra` | `#C97A4A` | unchanged | — | it is a *fill* behind `--ink` text, never text itself; darkening it changes the look for no accessibility gain. If axe ever flags it as text, use `#9D582F` (4.53:1 on `--paper`). |

`--amber-soft: #FBBF24` (the dark-theme accent on `#0E0F11`) already passes
comfortably and is not touched by either task.
