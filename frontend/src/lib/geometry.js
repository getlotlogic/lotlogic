// ── Helper: point-in-polygon test (ray casting) ─────────────
export function pointInPolygon(px, py, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

// ── Bounding box to zone polygon overlap (IoU-style) ──
// Calculates what percentage of bbox area overlaps with zone polygon bounding rect.
// This is the primary zone matching method — replaces centroid point-in-polygon.
export function bboxZoneOverlap(bxMin, byMin, bxMax, byMax, zonePolygon) {
  // All coords in 0-100 scale
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

// ── Check if a vehicle is still present in a zone from latest detections ──
// Returns true if a vehicle bbox overlaps the zone by >= 30%, false if none, null if unknown.
export function isVehicleInZone(latestDetections, zoneId, cameraZones) {
  // null/undefined detections = data not available (inconclusive)
  // empty array = camera working, no vehicles detected (departed)
  if (latestDetections == null || !zoneId || !cameraZones?.length) return null;
  const zone = cameraZones.find(z => z.zone_id === zoneId);
  if (!zone?.polygon?.length) return null;
  for (const d of latestDetections) {
    if (!d.bbox) continue;
    // bbox is {x, y, w, h} in 0-100 scale
    const overlap = bboxZoneOverlap(d.bbox.x, d.bbox.y, d.bbox.x + d.bbox.w, d.bbox.y + d.bbox.h, zone.polygon);
    if (overlap >= 0.30) return true;
  }
  return false;
}

// ── Match a violation to its specific detection ──────────────
// Uses IoU-style overlap to find which detection best matches the zone.
// Returns the detection with the highest overlap >= 30%, or null.
export function matchViolationDetection(detections, zoneId, cameraZones) {
  if (!detections?.length || !zoneId || !cameraZones?.length) return null;
  const zone = cameraZones.find(z => z.zone_id === zoneId);
  if (!zone?.polygon?.length) return null;
  const dets = detections.filter(d => d.bbox && d.bbox.length === 4);
  let bestDet = null, bestOverlap = 0;
  for (const d of dets) {
    const [x1, y1, x2, y2] = d.bbox;
    // Convert from 0-1 normalized to 0-100 scale to match zone polygon
    const overlap = bboxZoneOverlap(x1 * 100, y1 * 100, x2 * 100, y2 * 100, zone.polygon);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestDet = d;
    }
  }
  return bestOverlap >= 0.30 ? bestDet : null;
}

