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

### Zone Matching: IoU Bounding Box Overlap (Upgraded March 2026)
The backend matches detections to zones using **IoU (Intersection over Union) overlap**: what
percentage of a vehicle's bounding box area falls inside the zone polygon.

**How it works:**
- Detection bbox `[x1, y1, x2, y2]` is intersected with the zone polygon using Shapely
- `overlap_pct = intersection_area / bbox_area`
- If `overlap_pct >= ZONE_IOU_THRESHOLD` (default 0.30 / 30%), the vehicle matches that zone
- If a vehicle overlaps multiple zones, it's assigned to the zone with the highest overlap
- `ZONE_IOU_THRESHOLD` is configurable via environment variable (default: 0.30)

**Why IoU replaced centroid matching:**
Previously, the backend used center-point-in-polygon: compute the bbox center, check if that single
point falls inside the zone. This caused repeated production failures where vehicles were clearly
inside a zone but their centroid landed 0.1-0.3% outside the polygon boundary (the Z1 and Z7
failures of March 2025). IoU eliminates this class of bug entirely — a car with 40% overlap gets
matched regardless of where its center point falls.

**`zone_overlap` column**: Violations now store the overlap percentage (`zone_overlap` DOUBLE PRECISION,
0-1 scale). This feeds into departure scoring — a car with 80% overlap generates a stronger presence
signal than one at 31%, so the system is more certain before declaring departure.

**Raw detections have `zone_id: none`** — the backend does NOT assign zones at the snapshot/detection level. Zone matching happens separately in the violation engine.

**Zone polygons use 0-1 normalized coords** in the DB — e.g. `[0.167, 0.645]` not `[16.7, 64.5]`

### Zone Guardian Agent (Updated March 2026)
`monitoring/zone_guardian.py` — Autonomous agent that runs every 10 minutes, scans ALL cameras/lots,
and detects zone overlap issues before they become problems:
- **low_overlap**: Vehicles overlap zone but below the IoU threshold (zone needs expansion)
- **overlap_borderline**: Zone works but vehicles are at 20-30% overlap (fragile, could break)
- **near_miss**: Vehicles detected near zone but not overlapping at all
- **zone_too_small**: Zone polygon too small for reliable IoU matching

**Auto-fix mode**: `--auto-fix` flag automatically patches zone polygons via the backend API,
expanding them to push vehicle overlap above the IoU threshold.

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

### Auto-Diagnosis System (Updated March 2026)
`monitoring/agent_tools.py` -> `diagnose_zone_issues()` goes deeper — compares actual detection
bounding boxes against zone polygons from recent snapshots to find WHY zones fail:
- **below_iou_threshold**: Vehicles overlap zone but below the 30% IoU threshold (zone needs expansion)
- **low_overlap**: Vehicles barely touch zone polygon (zone too small or offset)
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

### Camera Connectivity (ngrok Tunnel)
Cameras are on a local LAN (192.168.1.x) and exposed to the Railway-hosted puller via **ngrok** with a permanent static domain.

**Permanent tunnel domain**: `arsenious-pulpiest-rosendo.ngrok-free.dev`
**ngrok account**: LotLogic (`lotlogicai@gmail.com`)

**How it works:**
- A Raspberry Pi on the camera LAN runs `ngrok http 192.168.1.134:80 --domain arsenious-pulpiest-rosendo.ngrok-free.dev`
- ngrok proxies HTTPS requests from the internet to the camera's HTTP server on port 80
- The domain is stored in `cameras.ip_address` column in the DB
- The puller's `_resolve_base_url()` detects tunnel domains (ngrok-free.dev, trycloudflare.com, ngrok.io) in `ip_address` and builds `https://<domain>` as the base URL
- All HTTP requests through ngrok MUST include `ngrok-skip-browser-warning: true` header to bypass the free-tier interstitial page

**Critical gotchas:**
1. **Static domain**: Unlike Cloudflare quick tunnels, the ngrok domain is permanent and never changes. No DB updates needed on restart.
2. **`http_snapshot_url` must be NULL**: If this column has a value (e.g., a private LAN IP), the puller uses it FIRST, bypassing the tunnel. Keep it NULL for cloud-hosted pullers.
3. **Puller doesn't hot-reload URL changes**: The `_reload_cameras()` method only detects new/removed cameras — it does NOT update `base_url` on existing `CameraTask` instances. **You must restart the Railway puller service** after changing `ip_address` in the DB.
4. **Camera auth**: Puller authenticates via `/cgi-bin/api.cgi?cmd=Login` through the tunnel, gets a time-limited token for snapshot requests.
5. **ngrok-skip-browser-warning**: Free-tier ngrok serves an HTML interstitial for browser-like requests. The puller MUST send `ngrok-skip-browser-warning: true` header on ALL requests or it gets HTML instead of JSON/images.
6. **systemd service**: ngrok should run as a systemd service on the Pi for auto-start on boot (`/etc/systemd/system/ngrok-tunnel.service`).

### Key Thresholds
- Plate recognition alarm: < 20% = critical, < 50% = warning
- Camera heartbeat staleness: 10 minutes
- Confidence display: green > 0.8, yellow 0.5-0.8, red < 0.5
- Snapshot poll interval: 30 seconds default

## Revenue Model
- `gross_revenue` = boot_fee ($75 default) or tow_fee ($250 default)
- `our_revenue` = gross_revenue * revenue_share (30% default)
- Revenue stored in dollars in DB, displayed as cents in frontend (multiplied by 100)

## Security Notes
- RLS policies are currently PERMISSIVE (public read/write) - needs auth implementation
- Supabase anon key is exposed in frontend JS - this is expected for Supabase but RLS must be tightened
- Backend API should enforce authorization on every request

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
