"""Two-stage license plate recognition sidecar (v3).

Stage 1 — Plate Detection: YOLOv9-t (ONNX via open-image-models, MIT)
Stage 2 — OCR: fast-plate-ocr global-plates-mobile-vit-v2-model (ONNX, MIT)

Runs on Railway. Accepts a base64-encoded JPEG via POST /recognize and
returns plate candidates. Replaces the easyocr-only v2 sidecar — easyocr
was a generic text detector misclassifying real plates and accepting
non-plate text (stickers, DOT numbers). The two-stage pipeline trusts
a purpose-built detector for "is there a plate here" and a purpose-built
OCR for reading the cropped region.

API contract is identical to v2 so callOpenAlprSidecar() in
camera-snapshot/index.ts requires no changes.

Spec: docs/superpowers/specs/2026-04-25-yolo-plate-detector-design.md
"""

import base64
import json
import os
import re
import time
from typing import List, Optional

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from open_image_models import LicensePlateDetector
from fast_plate_ocr import LicensePlateRecognizer

from custom_yolo import CustomYoloDetector

SIDECAR_AUTH_TOKEN = os.environ.get("SIDECAR_AUTH_TOKEN", "")
DETECTOR_MODEL = os.environ.get("DETECTOR_MODEL", "yolo-v9-s-608-license-plate-end2end")
# Optional path to a custom-trained YOLO ONNX (e.g. our Charlotte fine-tune).
# When set, this overrides DETECTOR_MODEL and uses the custom_yolo wrapper
# (raw-prediction graph + Python NMS). When unset, fall back to the bundled
# *-end2end model from open-image-models.
DETECTOR_MODEL_PATH = os.environ.get("DETECTOR_MODEL_PATH", "")
DETECTOR_IMGSZ = int(os.environ.get("DETECTOR_IMGSZ", "640"))
# fast-plate-ocr v1.x ships several global models. cct-s-v2 is the current
# default in the upstream README and supports US plate formats. Switch to
# 'cct-xs-v1-global-model' for a smaller / faster variant.
OCR_MODEL = os.environ.get("OCR_MODEL", "cct-s-v2-global-model")
DETECTOR_MIN_CONF = float(os.environ.get("DETECTOR_MIN_CONF", "0.15"))
ALPR_MIN_CONFIDENCE = float(os.environ.get("ALPR_MIN_CONFIDENCE", "0.50"))
# Hard cap on OCR calls per frame. With low DETECTOR_MIN_CONF overrides
# the YOLO model can return 50+ candidate bboxes, each costing ~50-100ms
# of OCR. Total processing time scales linearly and can blow past the
# edge function's 4-12s timeout, leading to a camera retry-and-back-off
# cascade. We sort detections by confidence descending and OCR only
# the top N. Plates that don't make the cut are usually noise anyway.
MAX_OCR_PER_FRAME = int(os.environ.get("MAX_OCR_PER_FRAME", "8"))
# Aspect ratio gate (width/height) for plate-shaped detections. US plates
# are nominally 2:1; allow 0.45–5.0 to keep heavily-rotated grille plates
# (which can read square at extreme angles) and reject grille-slat noise
# / mudflap silhouettes that consistently come back square at low conf.
PLATE_ASPECT_MIN = float(os.environ.get("PLATE_ASPECT_MIN", "0.40"))
PLATE_ASPECT_MAX = float(os.environ.get("PLATE_ASPECT_MAX", "5.0"))

# Per-camera threshold overrides. JSON map of camera_id -> float in [0, 1].
# When the request includes a camera_id present in the map, that camera's
# YOLO detector + combined-confidence floors are dropped to the override
# value. Used for far-mounted gate cameras whose plates appear small in
# the frame (low pixels => lower YOLO conf + lower OCR conf), so the
# default 0.15 / 0.50 floors throw out otherwise valid reads. Cameras
# not in the map use the global defaults.
def _parse_override_map(env_name: str) -> dict:
    raw = os.environ.get(env_name, "").strip()
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
        out: dict = {}
        for k, v in parsed.items():
            try:
                f = float(v)
                if 0.0 <= f <= 1.0:
                    out[str(k)] = f
            except (TypeError, ValueError):
                continue
        return out
    except Exception:
        return {}

DETECTOR_MIN_CONF_OVERRIDES = _parse_override_map("DETECTOR_MIN_CONF_OVERRIDES")
ALPR_MIN_CONFIDENCE_OVERRIDES = _parse_override_map("ALPR_MIN_CONFIDENCE_OVERRIDES")
print(
    f"[startup] DETECTOR_MIN_CONF={DETECTOR_MIN_CONF} "
    f"overrides={DETECTOR_MIN_CONF_OVERRIDES or 'none'}",
    flush=True,
)
print(
    f"[startup] ALPR_MIN_CONFIDENCE={ALPR_MIN_CONFIDENCE} "
    f"overrides={ALPR_MIN_CONFIDENCE_OVERRIDES or 'none'}",
    flush=True,
)

# Per-camera image rotation. JSON map of camera_id -> rotation direction:
#   "cw"   → 90° clockwise
#   "ccw"  → 90° counter-clockwise
#   "180"  → 180°
# Used when a camera is physically mounted rotated 90° (timestamp on the
# LEFT edge of the frame instead of the top). YOLO and fast-plate-ocr
# are trained on upright images, so a sideways scene tanks both detection
# and OCR confidence. Rotating server-side BEFORE detection puts the
# scene back upright for the models. Cameras not in the map are not
# rotated.
def _parse_rotation_map(env_name: str) -> dict:
    raw = os.environ.get(env_name, "").strip()
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
        valid = {"cw", "ccw", "180"}
        return {str(k): str(v).lower() for k, v in parsed.items() if str(v).lower() in valid}
    except Exception:
        return {}

ROTATE_BEFORE_PROCESS = _parse_rotation_map("ROTATE_BEFORE_PROCESS")
print(
    f"[startup] ROTATE_BEFORE_PROCESS={ROTATE_BEFORE_PROCESS or 'none'}",
    flush=True,
)
print(f"[startup] MAX_OCR_PER_FRAME={MAX_OCR_PER_FRAME}", flush=True)
MAX_IMAGE_WIDTH = int(os.environ.get("ALPR_MAX_IMAGE_WIDTH", "1280"))
ENABLE_EASYOCR_FALLBACK = os.environ.get("ENABLE_EASYOCR_FALLBACK", "false").lower() == "true"

app = FastAPI(
    title="LotLogic ALPR sidecar",
    description="YOLOv9 detector + fast-plate-ocr — purpose-built plate reader.",
    version="3.0.0",
)

# Lazy-initialized at startup. Holds the heavy ONNX models so every
# request reuses them instead of paying load cost per call.
detector: Optional[LicensePlateDetector] = None
ocr_reader: Optional[LicensePlateRecognizer] = None
easyocr_reader = None  # only loaded if ENABLE_EASYOCR_FALLBACK=true


@app.on_event("startup")
def on_startup() -> None:
    global detector, ocr_reader, easyocr_reader
    if DETECTOR_MODEL_PATH:
        # Custom Charlotte-trained model. Conf threshold here is a coarse
        # pre-filter; the existing DETECTOR_MIN_CONF gate runs again per crop
        # in _run_pipeline so behavior matches the bundled-detector path.
        detector = CustomYoloDetector(
            model_path=DETECTOR_MODEL_PATH,
            imgsz=DETECTOR_IMGSZ,
            conf_thresh=DETECTOR_MIN_CONF,
        )
    else:
        detector = LicensePlateDetector(detection_model=DETECTOR_MODEL)
    ocr_reader = LicensePlateRecognizer(OCR_MODEL)
    if ENABLE_EASYOCR_FALLBACK:
        import easyocr as _easyocr
        easyocr_reader = _easyocr.Reader(["en"], gpu=False, verbose=False)


class RecognizeRequest(BaseModel):
    image_base64: str = Field(..., description="Base64-encoded JPEG (data: URI prefix optional).")
    auth_token: Optional[str] = Field(None, description="Shared secret; must match SIDECAR_AUTH_TOKEN.")
    camera_id: Optional[str] = Field(None, description="Optional camera UUID; used to look up per-camera threshold overrides.")


class PlateCandidate(BaseModel):
    plate: str
    confidence: float


class RecognizeResponse(BaseModel):
    ok: bool
    plates: List[PlateCandidate]
    # In v3 this counts YOLO plate-region detections (not raw text regions
    # like easyocr v2). Stronger signal: 0 means no plate-shaped region
    # was found by a purpose-built detector.
    raw_detection_count: int = 0
    processing_time_ms: float
    reason: Optional[str] = None


@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "version": "3.0.0",
        "detector_loaded": detector is not None,
        "ocr_loaded": ocr_reader is not None,
        "easyocr_fallback": easyocr_reader is not None,
    }


def _decode_image(image_base64: str, camera_id: Optional[str] = None) -> np.ndarray:
    raw = image_base64
    if raw.startswith("data:"):
        raw = raw.split(",", 1)[1] if "," in raw else raw
    image_bytes = base64.b64decode(raw, validate=True)
    if not image_bytes:
        raise ValueError("empty image")
    nparr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("cannot decode JPEG")
    # Apply per-camera rotation BEFORE downscaling so the scene is upright
    # for the detector and OCR. Cameras physically mounted 90° rotated
    # (timestamp on left edge) need this to be readable by upright-trained
    # models.
    rot = ROTATE_BEFORE_PROCESS.get(camera_id or "")
    if rot == "cw":
        img = cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)
    elif rot == "ccw":
        img = cv2.rotate(img, cv2.ROTATE_90_COUNTERCLOCKWISE)
    elif rot == "180":
        img = cv2.rotate(img, cv2.ROTATE_180)
    if MAX_IMAGE_WIDTH > 0 and img.shape[1] > MAX_IMAGE_WIDTH:
        scale = MAX_IMAGE_WIDTH / img.shape[1]
        new_w = MAX_IMAGE_WIDTH
        new_h = int(img.shape[0] * scale)
        img = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA)
    return img


# Number of OCR variants generated per kept bbox. Used to budget the
# top-N detection cap so total OCR calls per frame remain bounded by
# MAX_OCR_PER_FRAME (preserves the timeout protection from #195).
OCR_VARIANTS_PER_BBOX = 3


def _sobel_y_offset(crop: np.ndarray, target_h: int) -> int:
    """Find the y-offset of the band with the highest vertical-Sobel
    edge density. Plate characters create many character-edge
    transitions per row, so this often locates the plate text band.

    Caveat: also fires on chrome trim, badge edges, and grille slats —
    that's why we keep this as ONE variant alongside center-trim, and
    let multi-variant agreement / fast-plate-ocr's own confidence
    pick the winner.
    """
    h = crop.shape[0]
    if target_h >= h:
        return 0
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.ndim == 3 else crop
    sobel_x = np.abs(cv2.Sobel(gray, cv2.CV_64F, 1, 0, ksize=3))
    row_density = sobel_x.sum(axis=1)
    kernel = np.ones(target_h, dtype=np.float64)
    band_score = np.convolve(row_density, kernel, mode="valid")
    y_off = int(np.argmax(band_score))
    return max(0, min(h - target_h, y_off))


def _ocr_variants(img: np.ndarray, bbox) -> List[np.ndarray]:
    """Return up to OCR_VARIANTS_PER_BBOX crop variants for one bbox.

    The detector frequently emits boxes that contain the plate plus a
    chunk of bumper/grille around it (operator labels were drawn
    loose). fast-plate-ocr is trained on tight ~2:1 crops, so a
    square 146x130 box containing a plate plus surrounding bumper
    fails OCR even when the plate is plainly visible.

    Variants (each cheap to construct; OCR is the cost driver):
      [0] loose         — current behavior; preserves working cameras
      [1] tight-center  — 2:1, center-trim of the height
      [2] tight-sobel   — 2:1, y-offset by max edge-density band

    Both trim heuristics have failure modes:
      • center-trim clips plates that aren't vertically centered
      • Sobel-trim locks onto chrome/badges with high edge density
    Generating both lets fast-plate-ocr pick whichever cleanly OCRs;
    multi-variant agreement is the strongest signal we have without
    a retrain.
    """
    h, w = img.shape[:2]
    x1 = max(0, int(bbox.x1) - 8)
    y1 = max(0, int(bbox.y1) - 8)
    x2 = min(w, int(bbox.x2) + 8)
    y2 = min(h, int(bbox.y2) + 8)
    loose = img[y1:y2, x1:x2]
    if loose.size == 0:
        return []

    bh, bw = loose.shape[:2]
    aspect = bw / max(bh, 1)
    variants: List[np.ndarray] = [loose]

    if aspect < 1.8 and bw > 0:
        target_h = max(1, min(bh, int(bw / 2.0)))
        if target_h < bh:
            y_center = max(0, (bh - target_h) // 2)
            tight_c = loose[y_center:y_center + target_h, :]
            if tight_c.size:
                variants.append(tight_c)
            y_sobel = _sobel_y_offset(loose, target_h)
            if y_sobel != y_center:
                tight_s = loose[y_sobel:y_sobel + target_h, :]
                if tight_s.size:
                    variants.append(tight_s)
    elif aspect > 2.5 and bh > 0:
        target_w = max(1, min(bw, int(bh * 2.0)))
        if target_w < bw:
            x_center = max(0, (bw - target_w) // 2)
            tight_c = loose[:, x_center:x_center + target_w]
            if tight_c.size:
                variants.append(tight_c)

    return variants


def _ocr_best(crops: List[np.ndarray]):
    """Run fast-plate-ocr on each crop variant; pick the best read.

    Selection order:
      1. If two or more variants decode to the SAME normalized plate
         string, return that string with the highest conf among
         agreeing variants. Multi-variant agreement is a far stronger
         signal than any single variant's char_probs (which are
         resolution-biased — a tight crop systematically scores higher
         than a loose crop on the same plate).
      2. Otherwise, return the single highest-conf decode.

    Returns (text, conf) or (None, 0.0) if no variant decoded.
    """
    results: List[tuple] = []
    for crop in crops:
        try:
            ocr_result = ocr_reader.run(crop, return_confidence=True)
        except Exception:
            continue
        if not ocr_result:
            continue
        pred = ocr_result[0]
        text = getattr(pred, "plate", None) or getattr(pred, "text", "") or ""
        if not text:
            continue
        if hasattr(pred, "char_probs") and pred.char_probs is not None:
            conf = float(pred.char_probs.mean())
        elif hasattr(pred, "confidence"):
            conf = float(pred.confidence)
        else:
            conf = 1.0
        results.append((text, conf))
    if not results:
        return None, 0.0
    # Group by normalized text so "ABC-123" and "ABC123" count as agreeing.
    groups: dict = {}
    for text, conf in results:
        key = re.sub(r"[^A-Z0-9]", "", text.upper())
        groups.setdefault(key, []).append((text, conf))
    # If any group has >1 variant agreeing, that's the winner — pick the
    # member with the highest conf as the canonical text.
    for members in groups.values():
        if len(members) > 1:
            members.sort(key=lambda x: x[1], reverse=True)
            return members[0]
    # No agreement — single best.
    results.sort(key=lambda x: x[1], reverse=True)
    return results[0]


def _run_pipeline(img: np.ndarray, camera_id: Optional[str] = None) -> RecognizeResponse:
    started = time.monotonic()

    # Per-camera floor overrides. None unless camera_id is in the map.
    detector_floor = DETECTOR_MIN_CONF_OVERRIDES.get(camera_id or "", DETECTOR_MIN_CONF)
    alpr_floor = ALPR_MIN_CONFIDENCE_OVERRIDES.get(camera_id or "", ALPR_MIN_CONFIDENCE)

    # Stage 1: plate detection. Returns a list of detection objects with
    # bounding box + confidence. End-to-end NMS is baked into the model,
    # so duplicates are already suppressed.
    if isinstance(detector, CustomYoloDetector):
        det_results = detector.predict(img, conf_thresh=detector_floor)
    else:
        det_results = detector.predict(img)
    raw_detection_count = len(det_results)

    if raw_detection_count == 0:
        return RecognizeResponse(
            ok=True,
            plates=[],
            raw_detection_count=0,
            processing_time_ms=(time.monotonic() - started) * 1000,
            reason="empty_scene",
        )

    # Stage 2: OCR each crop. Skip crops below the per-camera detector
    # floor or with OCR exceptions; we only emit confident plates.
    # Sort by confidence descending and cap so total OCR calls stay
    # bounded by MAX_OCR_PER_FRAME — each kept bbox triggers up to
    # OCR_VARIANTS_PER_BBOX OCR calls, so the bbox cap is divided by
    # the variant count to preserve the timeout protection from #195.
    det_cap = max(1, MAX_OCR_PER_FRAME // OCR_VARIANTS_PER_BBOX)
    sorted_dets = sorted(
        det_results,
        key=lambda d: float(getattr(d, "confidence", 0.0)),
        reverse=True,
    )[:det_cap]
    plates: List[PlateCandidate] = []
    aspect_gated = 0
    for det in sorted_dets:
        bbox = getattr(det, "bounding_box", det)
        conf = float(getattr(det, "confidence", 0.0))
        if conf < detector_floor:
            continue
        # Aspect-ratio gate: skip detections that are nowhere near plate-
        # shaped (super-tall, super-wide). Square-ish boxes 1.0–1.5 are
        # kept because grille-mounted commercial plates can appear nearly
        # square at extreme angles; the OCR variants below handle them.
        bw = max(1, int(bbox.x2) - int(bbox.x1))
        bh = max(1, int(bbox.y2) - int(bbox.y1))
        aspect = bw / bh
        if aspect < PLATE_ASPECT_MIN or aspect > PLATE_ASPECT_MAX:
            aspect_gated += 1
            continue
        crops = _ocr_variants(img, bbox)
        if not crops:
            continue
        plate_text, ocr_conf = _ocr_best(crops)
        if not plate_text:
            continue
        cleaned = re.sub(r"[^A-Z0-9]", "", plate_text.upper())
        if not cleaned:
            continue
        combined_conf = conf * ocr_conf
        if combined_conf < alpr_floor:
            continue
        plates.append(PlateCandidate(plate=cleaned, confidence=round(combined_conf, 4)))

    plates.sort(key=lambda p: p.confidence, reverse=True)
    if plates:
        reason = None
    elif aspect_gated == raw_detection_count and raw_detection_count > 0:
        reason = f"all_dets_aspect_gated:{aspect_gated}"
    else:
        reason = "no_plate_shaped_text"
    return RecognizeResponse(
        ok=True,
        plates=plates,
        raw_detection_count=raw_detection_count,
        processing_time_ms=(time.monotonic() - started) * 1000,
        reason=reason,
    )


def _easyocr_fallback(img: np.ndarray, original_err: Exception) -> RecognizeResponse:
    """Last-ditch fallback when the v3 ONNX pipeline raises. Same logic as
    the v2 sidecar so the system degrades to the prior known-good behavior
    instead of taking the sidecar offline. Activated only when
    ENABLE_EASYOCR_FALLBACK=true."""
    started = time.monotonic()
    try:
        detections = easyocr_reader.readtext(img) if easyocr_reader else []
    except Exception:
        detections = []
    plates: List[PlateCandidate] = []
    for _bbox, text, conf in detections:
        cleaned = re.sub(r"[^A-Z0-9]", "", (text or "").upper())
        if not (4 <= len(cleaned) <= 9):
            continue
        if not re.search(r"[A-Z]", cleaned) or not re.search(r"[0-9]", cleaned):
            continue
        if float(conf) < 0.50:
            continue
        plates.append(PlateCandidate(plate=cleaned, confidence=float(conf)))
    plates.sort(key=lambda p: p.confidence, reverse=True)
    return RecognizeResponse(
        ok=True,
        plates=plates,
        raw_detection_count=len(detections),
        processing_time_ms=(time.monotonic() - started) * 1000,
        reason=f"easyocr_fallback:{type(original_err).__name__}",
    )


@app.post("/recognize", response_model=RecognizeResponse)
def recognize(req: RecognizeRequest) -> RecognizeResponse:
    if SIDECAR_AUTH_TOKEN and req.auth_token != SIDECAR_AUTH_TOKEN:
        raise HTTPException(status_code=401, detail="unauthorized")
    if detector is None or ocr_reader is None:
        raise HTTPException(status_code=503, detail="models not loaded yet")

    try:
        img = _decode_image(req.image_base64, camera_id=req.camera_id)
    except Exception as err:
        raise HTTPException(status_code=400, detail=str(err))

    try:
        return _run_pipeline(img, camera_id=req.camera_id)
    except Exception as pipeline_err:
        if ENABLE_EASYOCR_FALLBACK and easyocr_reader is not None:
            return _easyocr_fallback(img, pipeline_err)
        return RecognizeResponse(
            ok=False,
            plates=[],
            raw_detection_count=0,
            processing_time_ms=0.0,
            reason=f"pipeline_error:{type(pipeline_err).__name__}:{str(pipeline_err)[:80]}",
        )
