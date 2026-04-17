# LotLogic: IoU Zone Matching + YOLO Upgrade — Full System Prompt

## Context

LotLogic is a parking enforcement platform. Cameras take snapshots every 30s, YOLO detects vehicles, and the system checks if vehicles are parked in violation zones. The current zone matching uses **center-point-in-polygon**: it calculates the centroid of each YOLO bounding box and checks if that single point falls inside the zone polygon. This has caused repeated production failures where vehicles clearly inside a zone are missed because their centroid lands 0.1-0.3% outside the polygon boundary.

We're switching from centroid matching to **bounding-box-to-zone-polygon overlap (IoU-style)**. Instead of reducing a vehicle to one point, we calculate what percentage of the bounding box area overlaps the zone polygon. If the overlap exceeds a threshold (default 30%), the vehicle matches that zone.

We're also upgrading YOLO to the latest Ultralytics model.

This change touches **every layer of the system**. Here's exactly what needs to change and where.

---

## 1. Backend (lotlogic-backend repo — FastAPI on Railway)

This is where YOLO inference and zone matching actually happen. The backend is a separate repo (`getlotlogic/lotlogic-backend`), deployed on Railway.

### 1a. Zone Matching — Replace centroid with overlap

Find the zone matching logic (wherever detections are assigned to zones). Currently it:
- Takes each detection's bbox `[x1, y1, x2, y2]` (normalized 0-1)
- Computes center: `cx = (x1+x2)/2, cy = (y1+y2)/2`
- Checks if `(cx, cy)` falls inside each zone polygon
- Assigns the detection to that zone (or no zone if center is outside all zones)

**Replace with:**

```python
from shapely.geometry import box, Polygon

def match_detection_to_zone(bbox, zones, iou_threshold=None):
    """Match a detection bbox to the best-overlapping zone.

    Args:
        bbox: [x1, y1, x2, y2] normalized 0-1
        zones: list of zone dicts with 'polygon' key (list of [x,y] points, 0-1 normalized)
        iou_threshold: minimum overlap percentage (0-1). Default from env var.

    Returns:
        (zone_id, overlap_pct) or (None, 0.0) if no zone matches
    """
    if iou_threshold is None:
        iou_threshold = float(os.environ.get("ZONE_IOU_THRESHOLD", "0.30"))

    x1, y1, x2, y2 = bbox
    det_box = box(x1, y1, x2, y2)
    det_area = det_box.area
    if det_area <= 0:
        return None, 0.0

    best_zone_id = None
    best_overlap = 0.0

    for zone in zones:
        zone_id = zone.get("zone_id") or zone.get("id")
        polygon_points = zone.get("polygon", [])
        if len(polygon_points) < 3:
            continue

        zone_poly = Polygon(polygon_points)
        if not zone_poly.is_valid:
            zone_poly = zone_poly.buffer(0)  # fix self-intersections

        intersection = det_box.intersection(zone_poly)
        overlap_pct = intersection.area / det_area

        if overlap_pct > best_overlap:
            best_overlap = overlap_pct
            best_zone_id = zone_id

    if best_overlap >= iou_threshold:
        return best_zone_id, round(best_overlap, 4)
    return None, 0.0
```

**Key rules:**
- `ZONE_IOU_THRESHOLD` env var, default `0.30` (30% of bbox must be inside zone)
- If a detection overlaps multiple zones, assign to the zone with the **highest overlap**
- Store `overlap_pct` on the detection/violation record for downstream use
- Log every match at DEBUG level: `"Detection bbox %s matched zone %s with overlap %.1f%%"`
- Add `shapely` to `requirements.txt`

### 1b. Store overlap_pct on violations

When creating a violation, include the overlap percentage:
```python
insert_data["zone_overlap"] = round(overlap_pct, 4)
```

This requires a new column on the `violations` table (see section 5).

### 1c. Pass overlap_pct to the dedup system

When calling `process_snapshot()` in `violation_dedup.py`, pass the overlap percentage alongside confidence. The dedup system should use it to weight presence scoring (see section 2).

### 1d. Upgrade YOLO

- Update `ultralytics` package to latest version in `requirements.txt` / `pyproject.toml`
- Find where the YOLO model is loaded (likely `YOLO('yolov8n.pt')` or similar)
- Upgrade to the latest model: `YOLO('yolo11n.pt')` (or `yolo11s.pt` if currently using `yolov8s.pt`) — match the size class (n→n, s→s, m→m)
- **Do NOT change** the confidence thresholds, class filters, or bbox output format
- **Verify** the output format is still `[x1, y1, x2, y2]` normalized 0-1 — the puller, monitoring agents, frontend, and dedup system all depend on this format
- The model file will auto-download on first run

---

## 2. Violation Dedup System (`backend/violation_dedup.py`)

File: `backend/violation_dedup.py`

The `process_snapshot()` function receives detection results per zone. Currently it uses `confidence` as the presence signal. With IoU, we should incorporate `zone_overlap` as an additional signal.

### Changes:

**Add `zone_overlap` parameter to `process_snapshot()`:**
```python
async def process_snapshot(
    ...existing params...,
    zone_overlap: float = None,  # NEW: 0.0-1.0, how much bbox overlaps zone
):
```

**Enhance presence scoring** (around line 209):
Currently: `presence_score = (confidence if confidence is not None else 0.5) if has_car else 0.0`

Change to weight by overlap:
```python
if has_car:
    base_confidence = confidence if confidence is not None else 0.5
    # Weight presence by zone overlap — a car with 80% overlap is more
    # definitively "in the zone" than one with 31% overlap
    if zone_overlap is not None and zone_overlap > 0:
        presence_score = base_confidence * (0.5 + 0.5 * zone_overlap)
        # e.g., conf=0.9, overlap=0.8 → 0.9 * 0.9 = 0.81
        # e.g., conf=0.9, overlap=0.3 → 0.9 * 0.65 = 0.585
    else:
        presence_score = base_confidence
else:
    presence_score = 0.0
```

This means a car with 80% zone overlap generates a stronger presence signal than one barely at the 30% threshold. The departure system will then require a cleaner absence signal to depart a high-overlap vehicle, which is correct — if a car is solidly inside a zone, you want to be more sure it's gone before departing.

**Include overlap in violation insert** (around line 410):
```python
if zone_overlap is not None:
    insert_data["zone_overlap"] = round(zone_overlap, 4)
```

---

## 3. Zone Guardian Agent (`monitoring/zone_guardian.py`)

File: `monitoring/zone_guardian.py`

The zone guardian's entire purpose was to detect and fix centroid gap issues. With IoU matching, the centroid gap problem goes away, but the guardian should be updated to monitor the **new** matching system.

### Changes:

**Update `analyze_camera_zones()`** to use IoU-based analysis instead of centroid-based:

Replace the current centroid classification logic (lines ~170-210) with overlap-based classification:

```python
for det in detections:
    bbox = det["bbox"]
    x1, y1, x2, y2 = bbox
    bbox_area = (x2 - x1) * (y2 - y1)
    if bbox_area <= 0:
        continue

    # Calculate overlap between detection bbox and zone polygon
    bx1, by1, bx2, by2 = bbox
    overlap_x = max(0, min(bx2, max_x) - max(bx1, min_x))
    overlap_y = max(0, min(by2, max_y) - max(by1, min_y))
    overlap_area = overlap_x * overlap_y
    overlap_pct = overlap_area / bbox_area if bbox_area > 0 else 0

    if overlap_pct >= 0.30:  # Matches IOU_THRESHOLD
        detections_matching.append({**det, "overlap_pct": round(overlap_pct, 4)})
    elif overlap_pct > 0.10:  # Partial overlap — borderline
        detections_borderline.append({**det, "overlap_pct": round(overlap_pct, 4)})
    elif overlap_pct > 0:  # Barely touching
        detections_low_overlap.append({**det, "overlap_pct": round(overlap_pct, 4)})
```

**Replace finding types:**
- Remove `centroid_gap` (no longer relevant)
- Remove `boundary_tight` (centroid boundary proximity no longer matters)
- Add `low_overlap_risk`: vehicles overlap zone between 10-30% — close to threshold, zone might need expansion
- Add `threshold_borderline`: vehicles consistently at 30-35% overlap — minor camera shift could push them below threshold
- Keep `near_miss` and `zone_too_small`

**Remove centroid-specific helper functions:**
- `bbox_centroid()` — no longer needed as primary matching tool
- `centroid_miss_distance()` — no longer relevant
- `expand_polygon()` — auto-fix should now adjust based on overlap thresholds, not centroid padding

**Update the auto-fix logic:**
Instead of expanding polygons by a centroid padding amount, the auto-fix should report "zone X has vehicles at 20-28% overlap — below the 30% threshold. Expanding the zone polygon would increase overlap to ~45%."

**Update docstring and comments** to reflect IoU-based matching instead of centroid-based.

---

## 4. Monitoring Agent Tools (`monitoring/agent_tools.py`)

File: `monitoring/agent_tools.py`

### `_bbox_zone_overlap()` (line 559):
This function already calculates overlap percentage. Keep it, but update the docstring to note that this is now the **primary matching method**, not just a diagnostic tool.

### `diagnose_zone_issues()` (line 588):
Update the diagnosis types:

**Remove/rename:**
- `center_outside_zone` → remove (this was the whole centroid gap problem, now solved)

**Update:**
- `low_overlap` → keep but reframe: "vehicles overlap zone but below the 30% IoU threshold"
- `zone_near_miss` → keep
- `zone_no_vehicles` → keep
- `zone_too_small` → keep
- `invalid_polygon` → keep

**Add new diagnosis:**
- `overlap_borderline`: vehicles consistently at 30-40% overlap — zone works but is fragile

**Update the docstring** (lines 588-606): remove all references to "CENTER-POINT-IN-POLYGON" and replace with IoU overlap description.

### `check_zone_detection_health()` (line 253):
Update the docstring to remove references to centroid matching. The function logic doesn't need to change since it's checking violation counts, not matching geometry.

---

## 5. Database Migration

Add a column to the `violations` table to store overlap percentage:

```sql
ALTER TABLE violations ADD COLUMN IF NOT EXISTS zone_overlap DOUBLE PRECISION;
COMMENT ON COLUMN violations.zone_overlap IS 'Percentage of detection bbox overlapping zone polygon (0-1 scale). Used for IoU-based zone matching.';
```

Save this as `migrations/add_zone_overlap.sql` and run it against the Supabase database.

---

## 6. Frontend (`frontend/index.html`)

File: `frontend/index.html`

### `pointInPolygon()` function (line 2961):
Keep this function — it's still useful for UI interactions (drawing zones, click detection).

### `isVehicleInZone()` function (line 2975):
**Replace centroid matching with overlap matching:**

Currently (line 2981-2983):
```javascript
const cx = (d.bbox.x + d.bbox.w / 2);
const cy = (d.bbox.y + d.bbox.h / 2);
if (pointInPolygon(cx, cy, zone.polygon)) return true;
```

Replace with overlap calculation:
```javascript
function bboxZoneOverlap(bbox, zonePolygon) {
  // bbox is [x1, y1, x2, y2] normalized 0-1
  // zonePolygon is array of {x, y} points (0-100 scale in frontend)
  const [bx1, by1, bx2, by2] = bbox;
  // Convert bbox to 0-100 scale to match zone polygon
  const bxMin = bx1 * 100, byMin = by1 * 100, bxMax = bx2 * 100, byMax = by2 * 100;

  // Approximate zone as bounding box (works for rectangular zones)
  const zxs = zonePolygon.map(p => p.x);
  const zys = zonePolygon.map(p => p.y);
  const zxMin = Math.min(...zxs), zxMax = Math.max(...zxs);
  const zyMin = Math.min(...zys), zyMax = Math.max(...zys);

  const overlapX = Math.max(0, Math.min(bxMax, zxMax) - Math.max(bxMin, zxMin));
  const overlapY = Math.max(0, Math.min(byMax, zyMax) - Math.max(byMin, zyMin));
  const bboxArea = (bxMax - bxMin) * (byMax - byMin);

  if (bboxArea <= 0) return 0;
  return (overlapX * overlapY) / bboxArea;
}
```

Update `isVehicleInZone()`:
```javascript
function isVehicleInZone(latestDetections, zoneId, cameraZones) {
  if (!latestDetections?.length || !zoneId || !cameraZones?.length) return null;
  const zone = cameraZones.find(z => z.zone_id === zoneId);
  if (!zone?.polygon?.length) return null;
  for (const d of latestDetections) {
    if (!d.bbox || d.bbox.length !== 4) continue;
    const overlap = bboxZoneOverlap(d.bbox, zone.polygon);
    if (overlap >= 0.30) return true;
  }
  return false;
}
```

### `matchViolationDetection()` function (line 2991):
Same change — replace centroid check with overlap check, return the detection with the highest overlap above threshold:

```javascript
function matchViolationDetection(detections, zoneId, cameraZones) {
  if (!detections?.length || !zoneId || !cameraZones?.length) return null;
  const zone = cameraZones.find(z => z.zone_id === zoneId);
  if (!zone?.polygon?.length) return null;

  let bestDet = null, bestOverlap = 0;
  for (const d of detections) {
    if (!d.bbox || d.bbox.length !== 4) continue;
    const overlap = bboxZoneOverlap(d.bbox, zone.polygon);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestDet = d;
    }
  }
  return bestOverlap >= 0.30 ? bestDet : null;
}
```

### Optional: Display overlap percentage in violation cards
If violations now include `zone_overlap`, consider displaying it in the UI alongside confidence. "Zone overlap: 67%" gives operators visibility into how solidly the vehicle is in the zone.

---

## 7. CLAUDE.md Updates

File: `CLAUDE.md`

Update the following sections to reflect IoU matching:

**"Critical Learning: Backend Uses CENTER-POINT-IN-POLYGON Matching"** → Rename to **"Zone Matching: IoU Bounding Box Overlap"** and describe the new system.

**Remove/update:**
- All references to "center point", "centroid", "centroid gap"
- The Z1 polygon boundary miss section (0.14% gap) — note it as historical, fixed by IoU
- Zone guardian centroid_gap descriptions

**Add:**
- IoU threshold documentation (default 0.30, configurable via `ZONE_IOU_THRESHOLD`)
- New zone_overlap column on violations table
- Note that zone polygons still use 0-1 normalized coords
- Note that detection bboxes still use 0-1 normalized [x1, y1, x2, y2]

---

## 8. Environment Variables

New env vars to add:

| Variable | Default | Description |
|----------|---------|-------------|
| `ZONE_IOU_THRESHOLD` | `0.30` | Minimum bbox-zone overlap (0-1) to count as a match |

Existing env vars that stay the same:
- `MIN_DETECTION_CONFIDENCE` (0.35)
- `DEPARTURE_WINDOW_SIZE` (6)
- `DEPARTURE_PRESENCE_THRESHOLD` (0.20)
- All other thresholds in violation_dedup.py

---

## 9. Testing Plan

1. **Unit test the overlap function**: Create test cases with known bbox + polygon coordinates and verify overlap percentages are correct
2. **Regression test with production data**: Pull recent `raw_detections` from snapshots table and run them through the new matching — compare zone assignments against old centroid method. The new method should match everything the old method matched PLUS the vehicles that were missed due to centroid gaps.
3. **Threshold tuning**: Run the overlap function against a batch of recent snapshots and plot the distribution of overlap percentages. If most vehicles are at 50-80% overlap, the 30% threshold has good margin. If many cluster around 30-35%, consider lowering the threshold.
4. **YOLO upgrade validation**: After upgrading the model, verify that `raw_detections` JSONB format hasn't changed — bbox format must still be `[x1, y1, x2, y2]` normalized 0-1.

---

## Summary of Changes By File

| File | Repo | Changes |
|------|------|---------|
| Zone matching logic | lotlogic-backend | Replace centroid with Shapely IoU overlap |
| YOLO model loading | lotlogic-backend | Upgrade to yolo11n/yolo11s |
| requirements.txt | lotlogic-backend | Add `shapely`, update `ultralytics` |
| `backend/violation_dedup.py` | lotlogic | Add `zone_overlap` param, weight presence scoring |
| `monitoring/zone_guardian.py` | lotlogic | Replace centroid analysis with overlap analysis |
| `monitoring/agent_tools.py` | lotlogic | Update `diagnose_zone_issues()`, keep `_bbox_zone_overlap()` |
| `frontend/index.html` | lotlogic | Replace `isVehicleInZone()` and `matchViolationDetection()` with overlap |
| `migrations/add_zone_overlap.sql` | lotlogic | Add `zone_overlap` column to violations |
| `CLAUDE.md` | lotlogic | Update documentation to reflect IoU matching |
