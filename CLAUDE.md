# LotLogic - Project Context & Learnings

## Proactive agent / skill triggers (default-on, no need to ask)

These are durable instructions: fire the agent automatically when the trigger fits. Don't ask permission for read-only auditors, reviewers, monitors, or researchers — Gabe has pre-authorized these.

| Trigger | Auto-dispatch |
|---|---|
| About to edit `supabase/functions/{camera-snapshot,cron-sessions-sweep,tow-dispatch-email,tow-confirm}/**` | `feature-dev:code-explorer` + `brainstormer` + `contrarian-reviewer` in parallel before the first edit |
| Just shipped an ALPR pipeline edge-function fix | `contrarian-reviewer` + `feature-dev:code-reviewer` in parallel after the deploy |
| User says "turn on cameras", "go live", "ship it" for production traffic | `launch-readiness-auditor` first, block enable until green |
| Live monitoring session (cameras on, watching DB) | Background `general-purpose` agent polling DB + edge logs every 60–120s |
| User mentions cost, spend, billing, calls, savings | `brainstormer` + `researcher` in parallel |
| Library / API / Deno / Postgres syntax question | `mcp__claude_ai_Context7__query-docs` before answering from memory |
| Pre-commit-hook block on edge-function drift | Diff against `mcp__supabase__get_edge_function` before retrying |

**Skip the dispatch when** the change is a typo, doc-only edit, or single-line config flip and dispatching would take longer than the work itself.

## What This Is
AI-powered parking enforcement platform. Cameras detect vehicles in zones, create violations, operators take action (boot/tow/dismiss).

## Architecture
- **Frontend**: React SPA in `frontend/index.html`, deployed on Vercel (auto-deploys from `main` branch, root dir: `frontend/`)
  - Live URL: `https://lotlogic-beta.vercel.app`
  - Vercel project: `lotlogic` on team `gabebs1-2452s-projects`
- **Backend**: Python API on Railway at `https://lotlogic-backend-production.up.railway.app`
  - Backend modules (notifications, violation dedup) live in `backend/`
- **Database**: Supabase (PostgreSQL) at `https://nzdkoouoaedbbccraoti.supabase.co`
- **Snapshot Puller**: Async camera polling service in `puller/`, deployed as Railway worker
- **Monitoring**: Python agent system in `monitoring/` with Claude AI analysis (containerized)
- **Detection Pipeline**: Camera RTSP -> Snapshots (30s poll) -> YOLO -> Zone filtering -> Violation creation
- **Camera-based ALPR pipeline** (rebuilt 2026-04-19, live): Milesight 4G Traffic Sensing Camera → HTTP POST with JSON body (`values.image` = base64 JPEG, `values.devMac` = camera id) → `supabase/functions/camera-snapshot/` → calls Plate Recognizer `/v1/plate-reader/` synchronously → uploads snapshot to R2 bucket `parking-snapshots` → inserts `plate_events` → opens/closes `plate_sessions` via the session state machine → allowlist match against `resident_plates` / `visitor_passes` (cron sweepers create `alpr_violations` on grace/pass expiry) → fires `tow-confirm` + `tow-dispatch-email` fire-and-forget. Consolidated reference: `docs/superpowers/specs/2026-04-20-alpr-pipeline-post-gut-consolidated-design.md` (indexes the three sub-specs: milesight ingest, session state machine, USDOT OCR fallback). `pr-ingest` edge function remains deployed for cameras that DO webhook in via PR, but receives no production traffic.
- **USDOT / MC first-class** (2026-04-20): plateless tractors are supported end-to-end. QR forms (`visit.html` + `resident.html` truck-plaza branches) accept optional USDOT + MC (5-8 digits); if no license plate is given, frontend synthesizes `plate_text = DOT-<usdot>` / `MC-<mc>`. Backend stores `usdot_number` / `mc_number` columns on `visitor_passes` and `resident_plates` (migration 015). `camera-snapshot::findActive{Resident,VisitorPass}` branches on plate prefix to match against those columns instead of `plate_text`. Camera-side synthesis runs via the ParkPow USDOT OCR fallback when Plate Recognizer returns zero plates (feature-flagged via `ENABLE_USDOT_FALLBACK=true` + `PARKPOW_USDOT_TOKEN`).

## Repository Structure
```
lotlogic/
├── frontend/          # Vercel-deployed static pages (auto-deploy from main)
│   ├── dashboard.html # ~7000-line single-file React SPA (Babel in-browser)
│   ├── index.html     # Marketing / landing
│   ├── visit.html     # Public QR → temporary-pass form
│   ├── resident.html  # Public QR → permanent-plate form
│   ├── privacy.html
│   ├── terms.html
│   ├── pitch-*.html   # Sales / pitch decks
│   ├── blog/          # Content + SEO pages
│   └── vercel.json    # SPA rewrites + cache headers
├── supabase/
│   └── functions/     # Edge functions deployed via `supabase functions deploy`
│       ├── camera-snapshot/       # Primary ingest: camera JSON/image POST -> PR -> plate_events -> violation -> email
│       ├── pr-ingest/              # Alt ingest: PR webhook (multipart) -> plate_events -> violation. No traffic today.
│       ├── camera-debug/          # One-off diagnostic. Captures raw POST body + headers to R2. Delete when not bringing up new camera models.
│       ├── tow-confirm/           # Camera-based tow-truck sighting correlator
│       ├── tow-dispatch-email/    # Partner email w/ action buttons (SendGrid, fallback Resend)
│       ├── tow-dispatch-sms/      # Partner SMS dispatch
│       ├── check-violations/      # Soft-expire + batch housekeeping
│       └── notify-expiring-plates/
├── backend/           # Python modules imported by the API server
│   ├── violation_dedup.py
│   └── notifications.py
├── puller/            # Async snapshot capture (Railway worker service)
├── monitoring/        # AI monitoring agents (Railway worker service)
├── leadgen/           # Cold-outreach blog / email automation
├── migrations/        # SQL schema patches (backend repo is source of truth)
├── tests/             # Playwright E2E
├── supabase-schema.sql
├── Makefile
└── CLAUDE.md
```

## Key Tables
- `cameras` - IP cameras with RTSP URLs, zones (JSONB), resolution settings
- `snapshots` - Camera captures with `raw_detections` JSONB and `vehicles_detected` count
- `violations` - Detected violations with `confidence`, `plate_confidence`, `zone_id`, `camera_id`, `zone_overlap`
- `lots` - Parking lots linked to owners and partners
- `partners` - Enforcement operators with fee schedules and revenue share

## Detection Pipeline Gotchas & Learnings

### Issue: Zones Not Detecting Violations (March 2025)
**Root cause**: Cowork identified that zones weren't picking up violations. Multiple potential causes:
1. **Camera too far from zone** - YOLO bounding boxes become too small at distance, confidence drops below threshold
2. **Confidence threshold too aggressive** - If backend filters detections above a certain confidence, close-but-not-perfect detections get dropped
3. **Zone polygon mismatch** - Zone polygons drawn in the UI (percentage-based 0-100 SVG coords) may not align with where vehicles actually appear in the camera frame
4. **Resolution too low** - At 640x360 (default), plates become unreadable at distance. Plate Recognizer needs clear character rendering
5. **Snapshot-to-violation gap** - Camera sees vehicles (vehicles_detected > 0 in snapshots) but violation engine doesn't create violations if zone overlap check fails

### Zone Matching: IoU Bounding Box Overlap (Upgraded March 2025)
The backend violation engine matches detections to zones using **IoU-style bounding box overlap**.
A detection's bbox must overlap the zone polygon by at least **30%** (configurable via `ZONE_IOU_THRESHOLD`
env var) to count as a match. If a detection overlaps multiple zones, it's assigned to the zone with
the highest overlap percentage.

This replaced the previous center-point-in-polygon approach which caused repeated production failures
(e.g., zone 7 had vehicles overlapping by 47% but centroid landing 0.003 outside the boundary).

- **Overlap threshold**: 30% default (`ZONE_IOU_THRESHOLD` env var, 0-1 scale)
- **`zone_overlap` column** on `violations` table stores the overlap percentage (0-1 scale)
- The dedup system weights presence scoring by overlap — higher overlap = stronger presence signal
- Zone polygons still use **0-1 normalized coords** in the DB
- Detection bboxes still use **0-1 normalized** `[x1, y1, x2, y2]`
- **Raw detections have `zone_id: none`** — zone matching happens in the violation engine, not at snapshot level

**Historical note**: The Z1/Z7 centroid gap issues (March 2025) are fully resolved by IoU matching —
vehicles no longer need their exact center point inside the zone, just sufficient bounding box overlap.

### Zone Guardian Agent (Updated March 2025)
`monitoring/zone_guardian.py` — Autonomous agent that runs every 10 minutes, scans ALL cameras/lots,
and monitors IoU overlap quality for all zone-detection pairs:
- **low_overlap_risk**: Vehicles overlap zone between 10-30% — below IoU threshold, no violations created
- **threshold_borderline**: Vehicles at 30-35% overlap — zone works but fragile to camera shifts
- **near_miss**: Vehicles detected near zone but not overlapping at all
- **zone_too_small**: Zone polygon too small for reliable overlap matching

**Auto-fix mode**: `--auto-fix` flag automatically patches zone polygons via the backend API,
expanding them to increase overlap above the 30% IoU threshold.

**Usage**:
- `python zone_guardian.py --scan` — single scan
- `python zone_guardian.py --daemon` — continuous monitoring (every 10 min)
- `python zone_guardian.py --scan --auto-fix` — scan and auto-patch zones
- `python zone_guardian.py --scan --camera-id <uuid>` — scan specific camera

### Detection Monitoring System (Added March 2025)
`monitoring/agent_tools.py` -> `check_zone_detection_health()` now automatically detects:
- **Silent zones**: Online camera with zones configured but zero violations ever
- **Detection dropoff**: Zone had violations in 7-day window but zero in last 24h
- **Confidence skew (high)**: Avg confidence > 95% means over-filtering, missing borderline violations
- **Confidence skew (low)**: Avg confidence < 30% means bad angle/distance/obstruction
- **Vehicles seen but no violations**: Snapshots detect vehicles but violation engine creates nothing
- **Low resolution risk**: Camera resolution below 640x360 minimum
- **No zones configured**: Camera online and taking snapshots but no zones defined

### Auto-Diagnosis System (Updated March 2025)
`monitoring/agent_tools.py` -> `diagnose_zone_issues()` goes deeper — compares actual detection
bounding boxes against zone polygons from recent snapshots to find WHY zones fail:
- **low_overlap**: Vehicles overlap zone but below the 30% IoU threshold (zone too small or offset)
- **overlap_borderline**: Vehicles at 30-40% overlap — zone works but fragile to camera changes
- **zone_near_miss**: Vehicles detected NEAR zone but not overlapping (zone needs shifting)
- **zone_no_vehicles**: Zone in area where no vehicles appear in frame
- **zone_too_small**: Zone covers < 0.5% of frame, unreliable matching
- **invalid_polygon**: Zone has < 3 polygon points

### Database Schema vs Code Gotchas
- `cameras` table does NOT have an `online` column — use `status` and `active` instead
- Camera status values: `active` (not `online` as in supabase-schema.sql)
- Zone polygon coords are **0-1 normalized** in the DB, not 0-100 percentage
- Detection bboxes are also **0-1 normalized** `[x1, y1, x2, y2]`
- Camera has `resolution_width`/`resolution_height` AND `snapshot_width`/`snapshot_height` columns

### Key Thresholds
- **Zone IoU threshold**: 30% default (`ZONE_IOU_THRESHOLD` env var) — minimum bbox overlap to match a zone
- Plate recognition alarm: < 20% = critical, < 50% = warning
- Camera heartbeat staleness: 10 minutes
- Confidence display: green > 0.8, yellow 0.5-0.8, red < 0.5
- Snapshot poll interval: 30 seconds default

## Revenue Model
- `gross_revenue` = boot_fee ($75 default) or tow_fee ($250 default)
- `our_revenue` = gross_revenue * revenue_share (30% default)
- Revenue stored in dollars in DB, displayed as cents in frontend (multiplied by 100)

## Security Notes
- Property access control rolled out (Apr 2026): owners/partners authenticate with email + password against the backend `/auth/login`, which returns a JWT signed with `JWT_SECRET` (set to the Supabase JWT secret). The frontend forwards the token to both the backend and Supabase, so RLS and API routes enforce the same account → property mapping.
- Shared X-API-Key remains for service-to-service callers (puller, monitoring, leadgen). It is no longer shipped in the dashboard bundle.
- RLS policies live in `lotlogic-backend/migrations/20260417025411_rls_property_scope.sql` (SELECT-only, keyed on JWT claims `owner_id` / `partner_id`).

## Auth & Property Access Control (added Apr 2026)

### How a request is scoped
1. User submits email + password to the LoginPage in `frontend/dashboard.html`.
2. `authLogin()` posts to the backend `POST /auth/login`. Backend looks the email up in `lot_owners` first, then `enforcement_partners`, runs bcrypt, and returns a JWT.
3. The JWT is stored in `localStorage.lotlogic_session._token`.
4. `apiFetch()` attaches `Authorization: Bearer <jwt>` to every backend call. The shared `X-API-Key` is no longer used in the browser.
5. `applySupabaseAuth()` forwards the same JWT to the Supabase client via `supabase.auth.setSession(...)`, so RLS policies on `lots`, `cameras`, `camera_zones`, `snapshots`, `violations`, `lot_owners`, `enforcement_partners` see the `owner_id` / `partner_id` claims.
6. On any `401` response, `apiFetch()` clears the session and fires `window.dispatchEvent('lotlogic:auth-expired')` — the App component catches that and returns to the login page.

### Files to know
- `frontend/dashboard.html` — single-file React SPA. Search for `LoginPage`, `apiFetch`, `authLogin`, `applySupabaseAuth` to find the auth flow. Backend calls go through `apiFetch(path, options)`; direct Supabase reads go through the `db` object.
- `tests/fixtures/accounts.ts` — shared test fixtures and the `loginAs(page, account)` helper for Playwright.
- `tests/e2e/access-control.spec.ts` — the canonical security proof. Run this whenever the auth plumbing changes.

### When you change auth-adjacent code
- Update both the backend route and the Playwright spec in the same PR — they're the two halves of the contract.
- If you add a new route that returns tenant-owned data, require `Subject = Depends(require_subject)` in the backend handler and filter via `services.scope` helpers. Then add a cross-tenant assertion in `tests/e2e/access-control.spec.ts`.
- If you add a new Supabase table that holds tenant data, extend `migrations/*_rls_property_scope.sql` with a matching policy.

## Testing
- Playwright harness in `tests/` — access-control E2E, dashboard smoke, a11y sweep.
- `cd tests && npm ci && npx playwright install --with-deps chromium && npm test`.
- GitHub Actions workflow `.github/workflows/playwright.yml` runs the suite on every push / PR against the Vercel preview or live beta.
- Seed test accounts via `ADMIN_API_KEY=… npm run seed` (requires backend `ADMIN_API_KEY` env var to be set — leave it empty in production once seeded).
- Required GitHub secrets for CI: `TEST_OWNER_A_EMAIL` / `PASSWORD`, `TEST_OWNER_B_EMAIL` / `PASSWORD`, `TEST_PARTNER_A_EMAIL` / `PASSWORD`, optional `API_URL`, optional `VERCEL_PREVIEW_URL`.
- Note: `tests/package-lock.json` is gitignored via the root `.gitignore`, so CI falls back to `npm ci || npm install`. If dep-resolution ever flakes in CI, un-gitignore it for `tests/`.

## Deploy Playbook — Property Access Control Rollout (first time only)

The auth/RLS changes must be shipped in this order. Skipping steps will lock
users out or blank their data.

1. **Apply `migrations/20260417024653_account_passwords.sql`** to Supabase
   (adds `password_hash` + related columns). Use the Supabase MCP
   `apply_migration` so the row lands in `supabase_migrations.schema_migrations`.
2. **Set Railway env vars** on `lotlogic-backend`:
   - `JWT_SECRET` = the Supabase JWT secret (Settings → API → JWT Secret).
     Must match Supabase, or RLS will reject our tokens.
   - `ADMIN_API_KEY` = a random secret, only used for seeding test accounts.
     Clear this after test seeding is done.
3. **Deploy the backend** (merge PR or push to `main`). `/auth/login` is now live.
4. **Seed passwords for existing accounts** via per-user reset tokens:
   `curl -XPOST .../auth/request-password -d '{"email":"..."}'`. Capture the token from the DB and email a setup link to the user.
   Do NOT bulk-set a shared password like `'temp'` — every owner ends up with the same trivial credential until they happen to rotate. If bulk seeding is unavoidable, generate a unique random password per row (`password_hash = crypt(gen_random_uuid()::text, gen_salt('bf'))`) and deliver each one out-of-band.
5. **Deploy the frontend** (merge PR). The login page now requires a password.
6. **Seed Playwright test accounts**: `cd tests && ADMIN_API_KEY=… npm run seed`.
   Then add the `TEST_*` secrets to GitHub so the workflow can run.
7. **Apply `migrations/20260417025411_rls_property_scope.sql`** LAST. This flips
   Supabase tables from public-read to JWT-scoped. Any still-anonymous reader
   goes to an empty result set the moment this lands.
8. Run `cd tests && npm run test:access` against prod to verify.

## Known Bottlenecks (Apr 2026)
- **No staging for the backend.** Railway deploys straight to prod from `main`. Nowhere to rehearse a migration or an auth change end-to-end.
- **Migrations are manual.** Code can merge before the required migration is applied. Every schema change depends on human-in-the-loop.
- **Single ~7000-line `frontend/dashboard.html` with in-browser Babel.** No type check, no component tests, no tree-shaking. Every change loads the entire file.
- **No shared types between Python and frontend.** A Pydantic field rename silently breaks the UI.
- **Gitignored lockfile.** CI dependency resolution is non-deterministic.
- **Secrets rotate by find-and-replace.** The old shared API key was embedded in the browser bundle and in CLAUDE.md — rotation was intrusive.
- **Edge functions deploy out-of-band.** `supabase/functions/*` lives here but `supabase functions deploy` is a manual step. Repo can drift from deployed runtime. When you touch an edge function, diff against `mcp__supabase__get_edge_function` before pushing.

Resolved vs earlier versions of this note:
- ~~No backend CI~~ → `getlotlogic/lotlogic-backend` now has `.github/workflows/ci.yml` (ruff + compileall + pytest).

## Build & Deploy

### Frontend — Vercel
- **Live URL**: https://lotlogic-beta.vercel.app
- **Vercel Project**: `lotlogic` (ID: `prj_X69wXEACGHveq0etAvX3xFBWDsqJ`)
- **Vercel Team**: `gabebs1-2452s-projects` (ID: `team_r9Qsbhq7f117Wza8KnrvV55t`)
- **Root directory**: `frontend/` (configured in Vercel project settings)
- **Framework**: None — static HTML, no build step
- **Deploy trigger**: Auto-deploys on push to `main` via GitHub integration
- **Preview deploys**: Created automatically for PRs
- **Config**: `frontend/vercel.json` handles SPA rewrites (all routes → `index.html`) and cache headers
- **To deploy manually**: Push to `main` or open a PR — Vercel picks it up automatically
- **Vercel MCP tools available**: Use `list_deployments`, `get_deployment`, `get_deployment_build_logs`, `get_runtime_logs`, `deploy_to_vercel` for deployment management

### Backend & Workers — Railway
- **Backend**: FastAPI on Railway — auto-deploys from `getlotlogic/lotlogic-backend` repo
- **Puller**: `puller/Dockerfile` runs `async_puller.py` in python:3.12-slim (Railway worker)
- **Monitoring**: `monitoring/Dockerfile` runs agents in python:3.12-slim (Railway worker)
- **Migrations**: `puller/Dockerfile.migrate` runs one-shot schema patches
- Railway auto-deploys on push to main (each service has its own root directory)
- Use `make help` to see all build/run commands
- Each Railway service should have its root directory set to its subdirectory (e.g., `puller/`, `monitoring/`)

## Development Rules
- The dashboard is a single `frontend/dashboard.html` file (React + Babel transpiled in-browser)
- QR registration flow uses two separate single-file pages: `frontend/visit.html` (temporary) and `frontend/resident.html` (permanent)
- Zone coordinates in the DB and new code are **0-1 normalized**. Legacy 0-100 values are converted on read by `_convert_camera_zones()` in `routers/snapshots.py` — do NOT write new 0-100 coords.
- All timestamps are UTC (TIMESTAMPTZ)
- Legacy `violations` row status is only 'pending' or 'resolved' (CHECK constraint); `alpr_violations` uses a richer state machine driven by `action_taken` + `tow_confirmed_at`
- `action_taken` values: boot, tow, dismissed, already_gone, no_action, plate_correction; on `alpr_violations` also: `tow`, `no_tow`
- **User-facing naming rule**: never write "Resident", "Visitor", or "Guest" in any UI string, email body, SMS body, or comment. Use **Permanent**, **Temporary**, or **Driver**. Database column names stay (`resident_plates`, `visitor_passes`, `visitor_name`) — UI labels everything.

## Truck-plaza passes (Apr 2026)

Spec: [`getlotlogic/lotlogic-backend` → `docs/superpowers/specs/2026-04-18-truck-plaza-passes-design.md`]

- `properties.property_type` ∈ (`apartment`, `truck_plaza`) drives form variants in `visit.html` / `resident.html` and tab labels in the dashboard.
- `visit.html` on a truck_plaza property renders a different form (company name, parking space, placard color, policy ack checkbox, 24h/48h stay radio). Pre-flight active-pass check hits the backend `GET /visitor_passes/check-active` (public; Supabase RLS blocks anon reads of visitor_passes, so the pre-flight MUST go through the backend).
- `resident.html` branches holder role on `property.property_type`: apartments write `holder_role='resident'`, truck plazas write `holder_role='employee'`.
- Dashboard (`dashboard.html`): property create/edit has a `property_type` selector + `policy_text` / `policy_phone` fields for truck_plaza. Tab labels on the property detail page switch: apartment = Permanent Plates / Temporary Passes; truck_plaza = Permanent Plates (Employees) / Truck Parking Log.
- Truck Parking Log tab backed by `GET /visitor_passes/parking-log?property_id=...&format=json|csv` with date/plate/company/status filters + operator Cancel (via `POST /visitor_passes/{id}/cancel`) + CSV export.

## Tow confirmation + Confirmation review tab

Spec: [`getlotlogic/lotlogic-backend` → `docs/superpowers/specs/2026-04-18-tow-confirmation-design.md`]

- `supabase/functions/tow-confirm/` — correlates camera sightings of tow-truck plates (listed in `enforcement_partners.tow_truck_plates`) back to open violations. Claims sightings via `partner_truck_sightings.consumed_by_violation_id`. Exit-event correlation uses a lookback window (`TOW_CONFIRM_LOOKBACK_MINUTES`, default 180). **Not currently wired into the new pipeline** — `camera-snapshot` does not fan out to `tow-confirm`. Re-enabling it is a separate task; see TODO in `camera-snapshot/index.ts`.
- `supabase/functions/camera-snapshot/` fires `tow-dispatch-email` fire-and-forget after every new `alpr_violations` insert. No SMS today.
- `supabase/functions/tow-dispatch-email/` mints HMAC-SHA256 JWT action tokens (aud `violation-action`, 48h TTL, signed with `JWT_SECRET` — MUST match the backend's) and renders two one-click buttons. Clicking hits backend `GET /violations/action` (render confirm form) → `POST /violations/action` (atomic resolve). Provider: SendGrid (primary) with Resend fallback. Click/open tracking is disabled in `tracking_settings` so Tow / No Tow links resolve straight to the backend without SendGrid's `url{N}.<domain>` redirector (whose SSL cert is flaky on first provisioning).
- Dashboard Billing tab has a **Confirmation review** sub-tab with 7 queues derived from `v_violation_billing_status`: Possible fraud → Needs verification → Unreported confirmed → Confirmed → Pending → No tow → Held/Force-billed. Per-row operator actions: Bill Anyway, Mark No-Tow, Pause/Resume Billing (all owner-scoped, hit backend endpoints `POST /violations/{id}/{force-bill|mark-no-tow|pause-billing|resume-billing}`).
- Partner settings: `AccountPage` has a **tow-truck plates** editor writing `enforcement_partners.tow_truck_plates`. Plates normalized byte-identically to `tow-confirm/index.ts`.

## Deploying edge functions

Edge functions deploy independently of the Vercel push-to-main flow. **Diff against deployed runtime before overwriting.**

```bash
# Diff first (recommended):
supabase functions download <slug> --project-ref nzdkoouoaedbbccraoti
# Or use the MCP: mcp__supabase__get_edge_function

# Deploy:
supabase functions deploy tow-confirm
supabase functions deploy tow-dispatch-email
# Set secrets where needed:
supabase secrets set JWT_SECRET=$SUPABASE_JWT_SECRET  # tow-dispatch-email
```

New env vars required:
- `tow-dispatch-email`: `JWT_SECRET` (= the Supabase JWT secret = backend's `JWT_SECRET`), `BACKEND_URL` (optional, defaults to prod), `SENDGRID_API_KEY` (primary provider) OR `RESEND_API_KEY` (fallback), `FROM_EMAIL` (must be on a domain-authenticated sender — currently `dispatch@lotlogicparking.com`), `FROM_NAME` (optional, "LotLogic" default), `EMAIL_OVERRIDE_TO` (optional test-recipient override; unset in prod).
- `tow-confirm`: `TOW_CONFIRM_MIN_CONFIDENCE` (default 0.85), `TOW_CONFIRM_LOOKBACK_MINUTES` (default 180)
- `camera-snapshot` / `pr-ingest`: `PLATE_RECOGNIZER_TOKEN`, `PR_MIN_SCORE` (default `0.8`), `PR_DEDUP_WINDOW_SECONDS` (default `0`; currently `300` in prod), `CAMERA_SNAPSHOT_URL_SECRET` (primary) or `PR_INGEST_URL_SECRET` (fallback shared secret for the trailing-path URL), `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_PUBLIC_BASE_URL`.

## Email sending (added Apr 2026)

Domain: `lotlogicparking.com` registered in Cloudflare (Gabe's account). Inbound = Cloudflare Email Routing (FREE); forwards `dispatch@`, `gabriel@`, + future custom addresses to `standardvendingcompany@gmail.com`. Outbound = SendGrid (Twilio's email product) with the domain Domain-Authenticated via 3 CNAMEs in Cloudflare DNS (gray cloud / DNS-only — NOT proxied). `FROM_EMAIL=dispatch@lotlogicparking.com`. Single Sender Verification is not used.

Guardrails:
- Never turn on the orange cloud (Cloudflare proxy) for SendGrid CNAMEs — they're `em{N}.lotlogicparking.com`, `s1._domainkey.lotlogicparking.com`, `s2._domainkey.lotlogicparking.com` and must be DNS-only.
- SendGrid tracking is explicitly disabled per-message in `tow-dispatch-email/index.ts` via `tracking_settings`. Re-enabling it will route every link through `url{N}.lotlogicparking.com` and the branded-link SSL cert breaks Tow / No Tow buttons until provisioned.
- `EMAIL_OVERRIDE_TO` currently set to `standardvendingcompany@gmail.com` during testing. Production: unset the secret and emails route to each violation's `enforcement_partners.email`.
