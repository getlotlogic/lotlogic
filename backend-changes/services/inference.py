"""
services/inference.py — YOLO11 vehicle detection pipeline

Takes a snapshot image, runs inference, returns structured detections.
Designed to be called per-snapshot from the ingest endpoint.

Model: YOLO11n fine-tuned on PKLot + your lot footage
Classes: car, truck, suv, motorcycle, empty_space
"""
import io
import os
import time
import logging
import threading
import numpy as np
from dataclasses import dataclass
from typing import Optional
from PIL import Image
from shapely.geometry import box as shapely_box, Polygon as ShapelyPolygon

log = logging.getLogger(__name__)

ZONE_IOU_THRESHOLD = float(os.environ.get("ZONE_IOU_THRESHOLD", "0.30"))

# Lazy-load the model — don't import at startup
_model = None
_model_lock = threading.Lock()  # Protects concurrent YOLO inference calls


def get_model(model_path: str):
    global _model
    if _model is None:
        try:
            from ultralytics import YOLO
            _model = YOLO(model_path)
            log.info(f"YOLO model loaded: {model_path}")
        except Exception as e:
            log.error(f"Failed to load YOLO model: {e}")
            raise
    return _model


@dataclass
class Detection:
    """A single vehicle detection from YOLO."""
    class_name: str       # 'car', 'truck', 'suv', 'motorcycle'
    confidence: float
    bbox: list[float]     # [x1, y1, x2, y2] normalized 0-1
    bbox_pixels: list[int]  # [x1, y1, x2, y2] in pixels
    center: tuple[float, float]  # (cx, cy) normalized


@dataclass
class InferenceResult:
    """Result of running inference on one snapshot."""
    vehicles: list[Detection]
    people: list[Detection]    # persons detected (COCO class 0)
    inference_ms: int
    image_width: int
    image_height: int
    raw_output: dict           # full YOLO output for DB storage


def run_inference(
    image_bytes: bytes,
    model_path: str,
    confidence_threshold: float = 0.25,
    iou_threshold: float = 0.3,
    imgsz: int = 1280,
) -> InferenceResult:
    """
    Run YOLO11 inference on a JPEG image.  Returns structured detections.

    Args:
        confidence_threshold: Minimum detection confidence (default 0.25).
        iou_threshold: NMS IoU threshold — lower values prevent merging
                       adjacent parked cars (default 0.3, YOLO default is 0.7).
        imgsz: Input image size for YOLO (default 1280 for better
               small-object detection; YOLO default is 640).
    """
    # COCO classes: person=0, car=2, motorcycle=3, bus=5, truck=7
    VEHICLE_CLASSES = {2: "car", 3: "motorcycle", 5: "bus", 7: "truck"}
    PERSON_CLASS_ID = 0
    ALL_CLASSES = [PERSON_CLASS_ID] + list(VEHICLE_CLASSES.keys())

    start = time.monotonic()

    try:
        img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    except Exception as e:
        log.error(f"Corrupt image — cannot decode JPEG: {e}")
        raise ValueError(f"Corrupt image: {e}")

    w, h = img.size
    model = get_model(model_path)

    # Serialize model access — PyTorch models are not thread-safe
    with _model_lock:
        results = model(
            img,
            conf=confidence_threshold,
            iou=iou_threshold,
            imgsz=imgsz,
            verbose=False,
            classes=ALL_CLASSES,
        )

    elapsed_ms = int((time.monotonic() - start) * 1000)

    detections = []
    people = []
    raw_boxes = []

    for result in results:
        boxes = result.boxes
        if boxes is None:
            continue
        for box in boxes:
            cls_id = int(box.cls[0].item())
            conf = float(box.conf[0].item())
            x1, y1, x2, y2 = box.xyxy[0].tolist()
            cx = ((x1 + x2) / 2) / w
            cy = ((y1 + y2) / 2) / h

            det = Detection(
                class_name="person" if cls_id == PERSON_CLASS_ID else VEHICLE_CLASSES.get(cls_id, "vehicle"),
                confidence=conf,
                bbox=[x1/w, y1/h, x2/w, y2/h],
                bbox_pixels=[int(x1), int(y1), int(x2), int(y2)],
                center=(cx, cy),
            )

            if cls_id == PERSON_CLASS_ID:
                people.append(det)
            else:
                detections.append(det)

            raw_boxes.append({
                "class": det.class_name,
                "conf": round(conf, 4),
                "bbox": [round(x1/w,4), round(y1/h,4), round(x2/w,4), round(y2/h,4)],
            })

    return InferenceResult(
        vehicles=detections,
        people=people,
        inference_ms=elapsed_ms,
        image_width=w,
        image_height=h,
        raw_output={"detections": raw_boxes, "count": len(raw_boxes)},
    )


def get_occupied_zones(
    detections: list[Detection],
    zones: list[dict],
    confidence_threshold: float = 0.80,
) -> list[dict]:
    """
    Cross-reference detections against lot zones using IoU bounding-box overlap.
    Returns which zones currently have a vehicle in them — rule-agnostic.
    The caller (snapshots.py) decides whether to fire a violation based on
    the zone's rule type and occupancy duration.

    A vehicle matches a zone when its bounding box overlaps the zone polygon
    by >= ZONE_IOU_THRESHOLD (default 30%).  If multiple detections overlap
    the same zone, the one with the highest overlap is selected.

    Supported rule types (stored in zone JSON):
      - "unauthorized"  → fire immediately on first detection (with SMS cooldown)
      - "time_limit"    → fire only after max_minutes have elapsed
      - "permit_required" → fire immediately (same as unauthorized for now)
      - "no_parking"    → fire immediately

    Zone format:
    {
      "zone_id": "A1",
      "space_number": 1,
      "polygon": [[x,y], ...],   # normalized 0-1
      "violation_type": "time_limit",
      "max_minutes": 5            # only for time_limit
    }
    """
    occupied = []

    for zone in zones:
        polygon_pts = zone.get("polygon", [])
        if not polygon_pts or len(polygon_pts) < 3:
            continue

        # Build Shapely polygon for the zone (normalised 0-1 coords)
        try:
            zone_poly = ShapelyPolygon(polygon_pts)
            if not zone_poly.is_valid:
                zone_poly = zone_poly.buffer(0)
        except Exception:
            continue

        best_det = None
        best_overlap = 0.0

        for det in detections:
            if det.confidence < confidence_threshold:
                continue

            # Build Shapely box from detection bbox [x1, y1, x2, y2]
            x1, y1, x2, y2 = det.bbox
            det_box = shapely_box(x1, y1, x2, y2)
            det_area = det_box.area
            if det_area <= 0:
                continue

            # IoU overlap: fraction of detection bbox inside zone polygon
            try:
                intersection = det_box.intersection(zone_poly)
                overlap_pct = intersection.area / det_area
            except Exception:
                overlap_pct = 0.0

            if overlap_pct >= ZONE_IOU_THRESHOLD and overlap_pct > best_overlap:
                best_det = det
                best_overlap = overlap_pct

        if best_det is not None:
            occupied.append({
                "zone_id": zone.get("zone_id"),
                "space_number": zone.get("space_number"),
                "violation_type": zone.get("violation_type", "unauthorized"),
                "max_minutes": zone.get("max_minutes"),
                "confidence": best_det.confidence,
                "vehicle_type": best_det.class_name,
                "vehicle_bbox": best_det.bbox,
                "zone_overlap": round(best_overlap, 4),
            })

    return occupied


# Keep backwards-compatible alias
def check_zone_violations(
    detections: list[Detection],
    zones: list[dict],
    violation_confidence_threshold: float = 0.80,
) -> list[dict]:
    """Deprecated — use get_occupied_zones instead."""
    return get_occupied_zones(detections, zones, violation_confidence_threshold)


# ── Vehicle colour detection ─────────────────────────────────────────────────

# Named colours with representative sRGB values used for nearest-neighbour match.
_COLOR_PALETTE: list[tuple[str, tuple[int, int, int]]] = [
    ("white",   (240, 240, 240)),
    ("silver",  (185, 185, 185)),
    ("gray",    (115, 115, 115)),
    ("black",   (28,  28,  28 )),
    ("red",     (195, 30,  30 )),
    ("maroon",  (120, 15,  15 )),
    ("orange",  (225, 105, 15 )),
    ("yellow",  (230, 200, 10 )),
    ("gold",    (200, 160, 15 )),
    ("beige",   (205, 185, 150)),
    ("tan",     (165, 135, 95 )),
    ("brown",   (115, 55,  20 )),
    ("green",   (35,  155, 35 )),
    ("teal",    (25,  130, 130)),
    ("blue",    (35,  80,  200)),
    ("navy",    (18,  28,  100)),
    ("purple",  (120, 35,  150)),
]


def _rgb_to_color_name(r: int, g: int, b: int) -> str:
    """Nearest-neighbour match in RGB space against the palette."""
    best_name, best_dist = "unknown", float("inf")
    for name, (cr, cg, cb) in _COLOR_PALETTE:
        d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2
        if d < best_dist:
            best_dist, best_name = d, name
    return best_name


def detect_vehicle_color(image_bytes: bytes, bbox_norm: list[float]) -> str:
    """
    Estimate the dominant colour of a vehicle from its bounding-box crop.

    Strategy
    --------
    1. Crop the bbox, then take the central 60 % to avoid background bleed.
    2. Downsample to 40×40 for speed.
    3. Compute per-pixel HSV to separate achromatic pixels (low saturation)
       from chromatic ones.
    4. If most pixels are achromatic, classify by median brightness →
       white / silver / gray / black.
    5. Otherwise use the median hue of chromatic pixels → named colour.
    6. Fall back to nearest-neighbour on the median RGB if still uncertain.

    Returns a lowercase colour name (e.g. "silver", "blue"), or "unknown"
    on any error.
    """
    try:
        img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        w, h = img.size
        x1n, y1n, x2n, y2n = bbox_norm
        px1, py1 = int(x1n * w), int(y1n * h)
        px2, py2 = int(x2n * w), int(y2n * h)
        if px2 <= px1 or py2 <= py1:
            return "unknown"

        crop = img.crop((px1, py1, px2, py2))
        cw, ch = crop.size

        # Take centre 50% to aggressively exclude pavement/shadow bleed at edges
        # (overhead parking cameras have significant ground bleed into bbox)
        mx, my = max(1, int(cw * 0.25)), max(1, int(ch * 0.25))
        crop = crop.crop((mx, my, cw - mx, ch - my))
        crop = crop.resize((40, 40), Image.LANCZOS)
        pixels = np.array(crop, dtype=np.float32).reshape(-1, 3)  # (N, 3) RGB

        # Apply Gaussian-weighted center sampling: pixels near center count more
        # This reduces edge artifacts from pavement/shadows
        h_px, w_px = 40, 40
        y_coords, x_coords = np.mgrid[0:h_px, 0:w_px]
        cx, cy = w_px / 2, h_px / 2
        weights = np.exp(-((x_coords - cx)**2 + (y_coords - cy)**2) / (2 * (w_px/3)**2))
        weights = weights.reshape(-1)
        weights = weights / weights.sum()

        r, g, b = pixels[:, 0], pixels[:, 1], pixels[:, 2]

        # Compute weighted-average RGB for the fallback nearest-neighbour match
        wr = float(np.sum(r * weights))
        wg = float(np.sum(g * weights))
        wb = float(np.sum(b * weights))

        # ── Vectorised HSV conversion (no colorsys import needed) ────────────
        r_n, g_n, b_n = r / 255.0, g / 255.0, b / 255.0
        vmax = np.maximum(np.maximum(r_n, g_n), b_n)   # V (brightness)
        vmin = np.minimum(np.minimum(r_n, g_n), b_n)
        delta = vmax - vmin                              # chroma
        sat = np.where(vmax > 0, delta / vmax, 0.0)     # S

        # ── Achromatic vs. chromatic split ─────────────────────────────────
        achromatic_mask = sat < 0.15
        achromatic_frac = float(achromatic_mask.mean())

        if achromatic_frac > 0.55:
            # Mostly achromatic — white / silver / gray / black by brightness
            median_v = float(np.median(vmax))
            if   median_v > 0.82: return "white"
            elif median_v > 0.60: return "silver"
            elif median_v > 0.35: return "gray"
            else:                 return "black"

        # ── Chromatic — find median hue of colour pixels ───────────────────
        chromatic_mask = ~achromatic_mask
        if chromatic_mask.sum() > 0:
            rv = r_n[chromatic_mask]
            gv = g_n[chromatic_mask]
            bv = b_n[chromatic_mask]
            vm = vmax[chromatic_mask]
            dm = delta[chromatic_mask]
            eps = 1e-9

            hue = np.where(
                vm == rv, 60 * ((gv - bv) / (dm + eps) % 6),
                np.where(vm == gv, 60 * ((bv - rv) / (dm + eps) + 2),
                         60 * ((rv - gv) / (dm + eps) + 4))
            ) % 360

            h_med = float(np.median(hue))
            if   h_med < 15 or h_med >= 345: return "red"
            elif h_med < 30:   return "orange"
            elif h_med < 65:   return "yellow"
            elif h_med < 75:   return "gold"
            elif h_med < 165:  return "green"
            elif h_med < 185:  return "teal"
            elif h_med < 260:  return "blue"
            elif h_med < 285:  return "navy"
            elif h_med < 310:  return "purple"
            elif h_med < 345:  return "maroon"

        # ── Fallback: nearest-neighbour on weighted-average RGB ────────────
        return _rgb_to_color_name(int(wr), int(wg), int(wb))

    except Exception as exc:
        log.debug("detect_vehicle_color failed: %s", exc)
        return "unknown"


# ── Customer validation — person entry zone check ─────────────────────────────

def people_in_entry_zone(
    people: list[Detection],
    entry_zone_polygon: list[list[float]],
    confidence_threshold: float = 0.50,
) -> bool:
    """
    Returns True if any detected person has their center point inside the
    given entry zone polygon.  Uses a lower confidence threshold than vehicle
    detection (0.50 vs 0.80) because person silhouettes from overhead parking
    cameras are smaller and harder to detect at high confidence.
    """
    if not people or not entry_zone_polygon:
        return False

    for person in people:
        if person.confidence < confidence_threshold:
            continue
        px, py = person.center
        if _point_in_polygon(px, py, entry_zone_polygon):
            return True
    return False


# ─────────────────────────────────────────────────────────────────────────────

def _point_in_polygon(px: float, py: float, polygon: list[list[float]]) -> bool:
    """
    Ray-casting algorithm to test if point (px, py) is inside polygon.
    Polygon is a list of [x, y] normalized coordinate pairs.
    """
    n = len(polygon)
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        if ((yi > py) != (yj > py)) and (px < (xj - xi) * (py - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside
