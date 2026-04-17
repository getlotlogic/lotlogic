# LotLogic - Project Context & Learnings

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
- **Detection Pipeline**: Camera RTSP -> Snapshots (30s poll) -> YOLO + Plate Recognizer -> Zone filtering -> Violation creation
- **ALPR Parking Pass Pipeline**: Client posts image to `alpr-snapshot` edge fn -> PlateRecognizer Snapshot API -> `alpr-webhook` -> `plate_events` -> match against `resident_plates`/`visitor_passes` -> `alpr_violations`

## PlateRecognizer Integration (added Apr 2026)

OCR for the ALPR parking pass system. Cameras/clients send images; we call PlateRecognizer Snapshot API and feed detections into the pass/violation flow.

### Flow
1. Client (camera device, device gateway, or frontend upload) POSTs to `/functions/v1/alpr-snapshot` with `{api_key, image_url | image_base64, event_type?, mmc?}`. `api_key` identifies the `alpr_cameras` row.
2. Edge fn calls `https://api.platerecognizer.com/v1/plate-reader/` with the image, `regions` (env default `us`), and optional `mmc` for vehicle make/model/color.
3. For each result with `score >= PLATE_RECOGNIZER_MIN_SCORE` (default 0.7), the fn POSTs internally to `alpr-webhook` with the plate text, confidence, and a `raw_data` envelope containing the PlateRecognizer box/region/vehicle.
4. `alpr-webhook` dedups (5-min window per plate+property), matches against resident/visitor lists, and creates `alpr_violations` when unmatched.

### Env vars (on the Supabase Edge Functions runtime)
- `PLATE_RECOGNIZER_TOKEN` — API token from platerecognizer.com dashboard. REQUIRED.
- `PLATE_RECOGNIZER_MIN_SCORE` — float, default `0.8`. Plates below this score are dropped. Chosen to avoid misreads silently towing residents whose plate was OCR'd one character off.
- `PLATE_RECOGNIZER_REGIONS` — comma-separated region codes, default `us-ga`. Passed to PlateRecognizer to bias OCR.
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — already set for other functions; `alpr-snapshot` reuses them to call `alpr-webhook`.

### Deploy
```
supabase functions deploy alpr-snapshot
supabase secrets set PLATE_RECOGNIZER_TOKEN=...
```
Or via the Supabase MCP: `deploy_edge_function` with the `alpr-snapshot` source.

## Repository Structure
```
lotlogic/
├── frontend/          # React SPA deployed on Vercel (auto-deploy from main)
│   ├── index.html     # Single-file React app
│   ├── vercel.json    # Vercel config (SPA rewrites)
│   ├── Dockerfile     # nginx:alpine container (legacy Railway)
│   ├── nginx.conf     # SPA routing + compression (legacy Railway)
│   └── railway.toml   # Railway deploy config (legacy)
├── backend/           # Python modules imported by the API server
│   ├── violation_dedup.py
│   └── notifications.py
├── puller/            # Async snapshot capture (Railway worker service)
│   ├── async_puller.py
│   ├── Dockerfile
│   └── railway.toml
├── monitoring/        # AI monitoring agents (Railway worker service)
│   ├── agent_monitor.py
│   ├── zone_guardian.py
│   ├── Dockerfile
│   └── railway.toml
├── migrations/        # SQL schema patches
├── supabase-schema.sql
├── Makefile           # Unified build/run commands (make help)
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
4. **Seed passwords for existing accounts.** Two options:
   - Per-user: `curl -XPOST .../auth/request-password -d '{"email":"..."}'`. Capture the token from the DB and email a setup link to the user.
   - Bulk: `UPDATE lot_owners SET password_hash = crypt('temp', gen_salt('bf'))` then force a reset.
5. **Deploy the frontend** (merge PR). The login page now requires a password.
6. **Seed Playwright test accounts**: `cd tests && ADMIN_API_KEY=… npm run seed`.
   Then add the `TEST_*` secrets to GitHub so the workflow can run.
7. **Apply `migrations/20260417025411_rls_property_scope.sql`** LAST. This flips
   Supabase tables from public-read to JWT-scoped. Any still-anonymous reader
   goes to an empty result set the moment this lands.
8. Run `cd tests && npm run test:access` against prod to verify.

## Known Bottlenecks (Apr 2026)
- **No staging for the backend.** Railway deploys straight to prod from `main`. Nowhere to rehearse a migration or an auth change end-to-end.
- **No backend CI.** `getlotlogic/lotlogic-backend` has no GitHub Actions workflow — no tests, no lint, no syntax check. Python bugs ship on merge.
- **Migrations are manual.** Code can merge before the required migration is applied. Every schema change depends on human-in-the-loop.
- **Single 6000-line `frontend/dashboard.html` with in-browser Babel.** No type check, no component tests, no tree-shaking. Every change loads the entire file.
- **No shared types between Python and frontend.** A Pydantic field rename silently breaks the UI.
- **Gitignored lockfile.** CI dependency resolution is non-deterministic.
- **Secrets rotate by find-and-replace.** The old shared API key was embedded in the browser bundle and in CLAUDE.md — rotation was intrusive.

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
- The frontend is a single `frontend/index.html` file (React + Babel transpiled in-browser)
- Zone coordinates are percentage-based (0-100) mapped to SVG viewBox
- All timestamps are UTC (TIMESTAMPTZ)
- Violation status is only 'pending' or 'resolved' (CHECK constraint)
- `action_taken` values: boot, tow, dismissed, already_gone, no_action, plate_correction
