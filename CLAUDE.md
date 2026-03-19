# LotLogic - Project Context & Learnings

## What This Is
AI-powered parking enforcement platform. Cameras detect vehicles in zones, create violations, operators take action (boot/tow/dismiss).

## Architecture
- **Frontend**: React SPA in `frontend/index.html`, deployed on Railway via Docker/nginx
- **Backend**: Python API on Railway at `https://lotlogic-backend-production.up.railway.app`
  - Backend modules (notifications, violation dedup) live in `backend/`
- **Database**: Supabase (PostgreSQL) at `https://nzdkoouoaedbbccraoti.supabase.co`
- **Snapshot Puller**: Async camera polling service in `puller/`, deployed as Railway worker
- **Monitoring**: Python agent system in `monitoring/` with Claude AI analysis (containerized)
- **Detection Pipeline**: Camera RTSP -> Snapshots (30s poll) -> YOLO + Plate Recognizer -> Zone filtering -> Violation creation

## Repository Structure
```
lotlogic/
├── frontend/          # React SPA + nginx (Railway web service)
│   ├── index.html     # Single-file React app
│   ├── Dockerfile     # nginx:alpine container
│   ├── nginx.conf     # SPA routing + compression
│   └── railway.toml   # Railway deploy config
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
- `violations` - Detected violations with `confidence`, `plate_confidence`, `zone_id`, `camera_id`
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

### Critical Learning: Backend Uses CENTER-POINT-IN-POLYGON Matching (March 2025)
**Root cause of zone 7 failure**: The backend violation engine matches detections to zones using
the **center point of the bounding box**, NOT bounding box overlap percentage.

This means:
- A vehicle bbox can overlap a zone by 40%+ but if the bbox CENTER falls outside the zone, **no violation is created**
- Example: Zone `zone_1_mmuxri9a` had a vehicle overlapping it by 47%, but the vehicle center was 0.003 above the zone top boundary → ZERO violations
- Zones must be drawn **large enough that vehicle centers fall inside**, not just that vehicles visually overlap
- Zones typically need to extend further toward the camera (lower Y values) because YOLO bbox centers tend to be higher than where the vehicle visually sits on the ground

**Fix applied**: Cowork redrawn zones with new IDs (`mmux` prefix) and wider polygons. After redraw, zone 7 started producing violations.

**Raw detections have `zone_id: none`** — the backend does NOT assign zones at the snapshot/detection level. Zone matching happens separately in the violation engine.

**Zone polygons use 0-1 normalized coords** in the DB — e.g. `[0.167, 0.645]` not `[16.7, 64.5]`

### Issue: Z1 Polygon Boundary Miss (March 2025)
**Exact root cause**: YOLO centroid for the car in Z1 was at y=66.77%, but Z1's top polygon edge
started at y=66.91% — literally **0.14% too low**. The car was detected fine, it just fell through
a tiny gap between zones. Fixed by extending Z1's top boundary from ~66.9% up to 64.5%.

**Key insight**: Zone polygons need a **safety margin** (at least 2%) beyond where vehicle centroids
actually appear. YOLO bbox centers shift slightly between frames, so a zone boundary that's perfectly
flush with a centroid position will intermittently miss.

### Zone Guardian Agent (Added March 2025)
`monitoring/zone_guardian.py` — Autonomous agent that runs every 10 minutes, scans ALL cameras/lots,
and detects centroid gap issues before they become problems:
- **centroid_gap**: Vehicles overlap zone but centroids fall outside polygon (the Z1/Z7 problem)
- **boundary_tight**: Zone works but centroids are within 1% of edge (future risk)
- **near_miss**: Vehicles detected near zone but not overlapping at all
- **zone_too_small**: Zone polygon too small for reliable centroid matching

**Auto-fix mode**: `--auto-fix` flag automatically patches zone polygons via the backend API,
expanding them with a 2% safety margin to capture missed centroids.

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

### Auto-Diagnosis System (Added March 2025)
`monitoring/agent_tools.py` -> `diagnose_zone_issues()` goes deeper — compares actual detection
bounding boxes against zone polygons from recent snapshots to find WHY zones fail:
- **zone_matching_failure**: Vehicles overlap zone but backend doesn't assign zone_id (pipeline bug)
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
- **Frontend**: `frontend/Dockerfile` copies `index.html` + `nginx.conf` into nginx:alpine
- **Puller**: `puller/Dockerfile` runs `async_puller.py` in python:3.12-slim
- **Monitoring**: `monitoring/Dockerfile` runs agents in python:3.12-slim
- **Migrations**: `puller/Dockerfile.migrate` runs one-shot schema patches
- Railway auto-deploys on push to main (each service has its own root directory)
- GitHub Pages deployment via `.github/workflows/pages.yml` (serves `frontend/`)
- Use `make help` to see all build/run commands
- Each Railway service should have its root directory set to its subdirectory (e.g., `frontend/`, `puller/`, `monitoring/`)

## Development Rules
- The frontend is a single `frontend/index.html` file (React + Babel transpiled in-browser)
- Zone coordinates are percentage-based (0-100) mapped to SVG viewBox
- All timestamps are UTC (TIMESTAMPTZ)
- Violation status is only 'pending' or 'resolved' (CHECK constraint)
- `action_taken` values: boot, tow, dismissed, already_gone, no_action, plate_correction
