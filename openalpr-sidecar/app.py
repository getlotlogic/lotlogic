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
# DETECTOR_MODEL_PATH defaults to the Dockerfile-baked keremberke/yolov8m-
# license-plate ONNX. Env can override (e.g. point at lotlogic-plate.onnx
# for Charlotte-specific fine-tune). Empty string disables, falling back
# to the bundled open_image_models detector.
_DEFAULT_DETECTOR_PATH = "/app/models/yolov8m-plate.onnx"
DETECTOR_MODEL_PATH = os.environ.get("DETECTOR_MODEL_PATH",
                                     _DEFAULT_DETECTOR_PATH if os.path.exists(_DEFAULT_DETECTOR_PATH) else "")
# yolov8m-license-plate was trained at 640x640. Override at runtime if
# the active model uses a different training resolution.
DETECTOR_IMGSZ = int(os.environ.get("DETECTOR_IMGSZ", "640"))
# fast-plate-ocr v1.x ships several global models. cct-s-v2 is the current
# default in the upstream README and supports US plate formats. Switch to
# 'cct-xs-v1-global-model' for a smaller / faster variant.
OCR_MODEL = os.environ.get("OCR_MODEL", "cct-s-v2-global-model")
DETECTOR_MIN_CONF = float(os.environ.get("DETECTOR_MIN_CONF", "0.10"))
ALPR_MIN_CONFIDENCE = float(os.environ.get("ALPR_MIN_CONFIDENCE", "0.05"))
# Auto-equalize underexposed frames before detection. The Milesight 4G
# Solar ANPR variants ship a low-luma JPEG even in broad daylight, which
# pushes plate regions outside YOLO's training distribution. CLAHE on the
# luma channel restores local contrast without crushing highlights.
ENABLE_AUTO_EQUALIZE = os.environ.get("ENABLE_AUTO_EQUALIZE", "true").lower() == "true"
# Frames whose mean luminance is below this threshold get CLAHE applied.
# 80/255 ≈ "looks dim to a human." Daylight scenes are typically 110-160.
AUTO_EQUALIZE_LUMA_THRESHOLD = int(os.environ.get("AUTO_EQUALIZE_LUMA_THRESHOLD", "150"))
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
    version="3.12.2",
)

# Lazy-initialized at startup. Holds the heavy ONNX models so every
# request reuses them instead of paying load cost per call.
detector: Optional[LicensePlateDetector] = None
detector_fallback: Optional[LicensePlateDetector] = None
ocr_reader: Optional[LicensePlateRecognizer] = None
easyocr_reader = None  # only loaded if ENABLE_EASYOCR_FALLBACK=true
# PaddleOCR PPOCRv4 — runs in parallel with fast-plate-ocr on every
# crop variant. Stronger on low-contrast / IR-illuminated text where
# fast-plate-ocr returns empty. Multi-engine agreement boosts confidence
# in _ocr_best.
paddle_reader = None
paddle_load_error: Optional[str] = None
ENABLE_PADDLE_OCR = os.environ.get("ENABLE_PADDLE_OCR", "true").lower() == "true"

# DETR plate detector (transformer-based). When enabled, runs alongside
# YOLO and contributes detections from a different architecture family —
# DETR's attention layers handle small/angled plates better than YOLO's
# anchor-based head. We RUN BOTH and union the detections; the OCR step
# dedups by IoU so duplicate detections of the same plate are fine.
detr_processor = None
detr_model = None
detr_load_error: Optional[str] = None
detr_load_attempted = False
ENABLE_DETR = os.environ.get("ENABLE_DETR", "true").lower() == "true"
# Real plate-fine-tuned DETR — verified to exist on HF Hub. The earlier
# nateraw/* name I'd used was a hallucination and 404'd at runtime.
DETR_MODEL_NAME = os.environ.get("DETR_MODEL_NAME", "nickmuchi/detr-resnet50-license-plate-detection")
DETR_MIN_CONF = float(os.environ.get("DETR_MIN_CONF", "0.30"))


@app.on_event("startup")
def on_startup() -> None:
    global detector, detector_fallback, ocr_reader, easyocr_reader
    if DETECTOR_MODEL_PATH:
        # Custom Charlotte-trained model. Conf threshold here is a coarse
        # pre-filter; the existing DETECTOR_MIN_CONF gate runs again per crop
        # in _run_pipeline so behavior matches the bundled-detector path.
        detector = CustomYoloDetector(
            model_path=DETECTOR_MODEL_PATH,
            imgsz=DETECTOR_IMGSZ,
            conf_thresh=DETECTOR_MIN_CONF,
        )
        # Bundled detector as fallback — runs when the custom model finds
        # nothing. Lets us see whether dark-frame misses are a custom-model
        # weakness or a fundamental low-light/exposure issue.
        try:
            detector_fallback = LicensePlateDetector(detection_model=DETECTOR_MODEL)
            print(f"[startup] fallback detector loaded: {DETECTOR_MODEL}", flush=True)
        except Exception as e:
            print(f"[startup] fallback detector load failed: {e}", flush=True)
            detector_fallback = None
    else:
        detector = LicensePlateDetector(detection_model=DETECTOR_MODEL)
    ocr_reader = LicensePlateRecognizer(OCR_MODEL)
    if ENABLE_EASYOCR_FALLBACK:
        import easyocr as _easyocr
        easyocr_reader = _easyocr.Reader(["en"], gpu=False, verbose=False)
    # PaddleOCR + DETR are LOADED LAZILY on first /recognize call.
    # Eager startup loading was blocking past Railway's 60s healthcheck
    # window. Lazy loading lets uvicorn bind + /health respond
    # immediately; the first /recognize call pays the warm-up cost
    # once, then warm for the rest of container lifetime.
    print("[startup] paddle + DETR will lazy-load on first /recognize", flush=True)


_paddle_load_attempted = False
_detr_load_attempted = False


def _ensure_paddle_loaded() -> None:
    """Idempotent: load PaddleOCR if not already loaded. Called from the
    request path so cold-start /health doesn't pay model-download cost."""
    global paddle_reader, paddle_load_error, _paddle_load_attempted
    if _paddle_load_attempted or not ENABLE_PADDLE_OCR:
        return
    _paddle_load_attempted = True
    try:
        from paddleocr import PaddleOCR
        try:
            paddle_reader = PaddleOCR(use_angle_cls=False, lang="en")
        except TypeError:
            paddle_reader = PaddleOCR(use_angle_cls=False, lang="en",
                                      use_gpu=False, show_log=False)
        print(f"[lazy] PaddleOCR loaded", flush=True)
    except Exception as e:
        paddle_load_error = f"{type(e).__name__}: {e}"
        print(f"[lazy] PaddleOCR load failed: {paddle_load_error}", flush=True)
        paddle_reader = None


def _ensure_detr_loaded() -> None:
    """Idempotent: load DETR if not already loaded."""
    global detr_processor, detr_model, detr_load_error, _detr_load_attempted
    if _detr_load_attempted or not ENABLE_DETR:
        return
    _detr_load_attempted = True
    try:
        from transformers import DetrImageProcessor, DetrForObjectDetection
        detr_processor = DetrImageProcessor.from_pretrained(DETR_MODEL_NAME)
        detr_model = DetrForObjectDetection.from_pretrained(DETR_MODEL_NAME)
        detr_model.eval()
        print(f"[lazy] DETR loaded: {DETR_MODEL_NAME}", flush=True)
    except Exception as e:
        detr_load_error = f"{type(e).__name__}: {e}"
        print(f"[lazy] DETR load failed: {detr_load_error}", flush=True)
        detr_processor = None
        detr_model = None


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
        "version": "3.12.2",
        "detector_loaded": detector is not None,
        "detector_type": "custom" if DETECTOR_MODEL_PATH else "bundled",
        "detector_model": DETECTOR_MODEL_PATH or DETECTOR_MODEL,
        "detector_min_conf": DETECTOR_MIN_CONF,
        "alpr_min_confidence": ALPR_MIN_CONFIDENCE,
        "auto_equalize": ENABLE_AUTO_EQUALIZE,
        "auto_equalize_luma_threshold": AUTO_EQUALIZE_LUMA_THRESHOLD,
        "ocr_loaded": ocr_reader is not None,
        "easyocr_fallback": easyocr_reader is not None,
        "paddle_ocr_loaded": paddle_reader is not None,
        "paddle_load_error": paddle_load_error,
        "detr_loaded": detr_model is not None,
        "detr_model_name": DETR_MODEL_NAME if detr_model is not None else None,
        "detr_load_error": detr_load_error,
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
    if ENABLE_AUTO_EQUALIZE:
        yuv = cv2.cvtColor(img, cv2.COLOR_BGR2YUV)
        y_mean = float(yuv[:, :, 0].mean())
        if y_mean < AUTO_EQUALIZE_LUMA_THRESHOLD:
            clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
            yuv[:, :, 0] = clahe.apply(yuv[:, :, 0])
            img = cv2.cvtColor(yuv, cv2.COLOR_YUV2BGR)
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
    # Build a stack of OCR candidates per crop:
    #   [0] original (preserves working cameras' behavior unchanged)
    #   [1] upscaled (small crops below fast-plate-ocr's 140x40 input)
    #   [2] CLAHE-enhanced upscaled (for low-contrast underexposed plates)
    # OCR tries each; multi-variant agreement picks the canonical text.
    def _upscale(crop_in: np.ndarray, target_w: int = 280) -> np.ndarray:
        ch, cw = crop_in.shape[:2]
        if cw >= target_w:
            return crop_in
        scale = target_w / cw
        return cv2.resize(crop_in, (target_w, max(1, int(ch * scale))),
                          interpolation=cv2.INTER_CUBIC)

    def _clahe_crop(crop_in: np.ndarray) -> np.ndarray:
        try:
            yuv = cv2.cvtColor(crop_in, cv2.COLOR_BGR2YUV)
            clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 4))
            yuv[:, :, 0] = clahe.apply(yuv[:, :, 0])
            return cv2.cvtColor(yuv, cv2.COLOR_YUV2BGR)
        except Exception:
            return crop_in

    # PaddleOCR PPOCRv4 reader. Runs on each crop variant in parallel with
    # fast-plate-ocr; particularly strong on low-contrast / IR-illuminated
    # plates where fast-plate-ocr returns empty. Returns 0-N text regions
    # per call — we take the highest-confidence one and apply the same
    # A-Z0-9 normalization downstream.
    def _paddle_decode(c: np.ndarray) -> Optional[tuple]:
        if paddle_reader is None:
            return None
        try:
            result = paddle_reader.ocr(c, det=False, cls=False)
        except Exception:
            return None
        # PaddleOCR ocr(det=False) returns [[(text, conf), ...]] — first
        # batch, first hypothesis. det=False skips the text-region detector
        # and just OCRs the whole crop, which is what we want post-YOLO.
        if not result or not result[0]:
            return None
        try:
            text, conf = result[0][0]
        except Exception:
            return None
        if not text or not isinstance(text, str):
            return None
        return text, float(conf)

    results: List[tuple] = []
    for crop in crops:
        ocr_candidates = [crop]
        upscaled = _upscale(crop)
        if upscaled is not crop:
            ocr_candidates.append(upscaled)
        ocr_candidates.append(_clahe_crop(upscaled))
        for c in ocr_candidates:
            # PaddleOCR-only mode. fast-plate-ocr was producing low-quality
            # single-char partials ("A", "11", etc.) that polluted the
            # results pool. PaddleOCR PPOCRv4 reads low-contrast / IR plates
            # significantly better. Operator decision 2026-05-14 to drop
            # the parallel fast-plate-ocr call. The model stays loaded so
            # we can re-enable it as a fallback without a redeploy.
            paddle = _paddle_decode(c)
            if paddle is not None:
                results.append(paddle)
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
    used_fallback = False
    used_tiles = False

    def _run_detector(image: np.ndarray) -> list:
        if isinstance(detector, CustomYoloDetector):
            primary = detector.predict(image, conf_thresh=detector_floor)
            if len(primary) == 0 and detector_fallback is not None:
                return detector_fallback.predict(image)
            return primary
        return detector.predict(image)

    def _run_detr(image: np.ndarray) -> list:
        """Run the DETR plate detector on the full image. Returns _Detection-
        compatible namespaces so the rest of the pipeline can consume them
        identically to YOLO output."""
        if detr_processor is None or detr_model is None:
            return []
        try:
            import torch
            from PIL import Image as PILImage
            from types import SimpleNamespace
            # OpenCV uses BGR; PIL/transformers expect RGB.
            rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
            pil_img = PILImage.fromarray(rgb)
            inputs = detr_processor(images=pil_img, return_tensors="pt")
            with torch.no_grad():
                outputs = detr_model(**inputs)
            h0, w0 = image.shape[:2]
            target_sizes = torch.tensor([[h0, w0]])
            results = detr_processor.post_process_object_detection(
                outputs, target_sizes=target_sizes, threshold=DETR_MIN_CONF,
            )[0]
            out = []
            for score, box in zip(results["scores"].tolist(), results["boxes"].tolist()):
                x1, y1, x2, y2 = box
                out.append(SimpleNamespace(
                    confidence=float(score),
                    label="License Plate",
                    bounding_box=SimpleNamespace(
                        x1=int(x1), y1=int(y1), x2=int(x2), y2=int(y2),
                    ),
                ))
            return out
        except Exception as e:
            print(f"[detr] inference failed: {type(e).__name__}: {e}", flush=True)
            return []

    # Run YOLO and DETR detectors in parallel union mode. Both architectures
    # have different strengths — YOLO on bright/clean plates, DETR on
    # small/angled/cluttered scenes — combining them increases recall.
    # The OCR step dedups across overlapping bboxes naturally.
    det_results = _run_detector(img)
    detr_dets = _run_detr(img)
    det_results.extend(detr_dets)

    # Tiled fallback. When full-frame detection returns nothing, run the
    # detector on 2x2 overlapping tiles. At 608 imgsz the model sees each
    # tile at ~2x effective resolution, so small plates (~5% of frame width)
    # become detectable. Bbox coords are translated back to the original
    # frame so the rest of the pipeline is unchanged. Gated to fire only
    # when full-frame produced nothing, so the per-frame latency hit only
    # applies to "would have dropped anyway" frames.
    if len(det_results) == 0:
        h0, w0 = img.shape[:2]
        overlap = 0.2
        for row in range(2):
            for col in range(2):
                y1 = max(0, int(row * h0 / 2 - overlap * h0 / 2))
                y2 = min(h0, int((row + 1) * h0 / 2 + overlap * h0 / 2))
                x1 = max(0, int(col * w0 / 2 - overlap * w0 / 2))
                x2 = min(w0, int((col + 1) * w0 / 2 + overlap * w0 / 2))
                tile = img[y1:y2, x1:x2]
                if tile.size == 0:
                    continue
                tile_dets = _run_detector(tile)
                for det in tile_dets:
                    bb = det.bounding_box
                    # Wrap with a SimpleNamespace because some detector libs
                    # return immutable bbox objects. The pipeline downstream
                    # only reads .x1/.x2/.y1/.y2/.confidence/.bounding_box
                    # via getattr, so a plain namespace is enough.
                    from types import SimpleNamespace
                    translated = SimpleNamespace(
                        confidence=float(getattr(det, "confidence", 0.0)),
                        label=getattr(det, "label", "License Plate"),
                        bounding_box=SimpleNamespace(
                            x1=int(bb.x1) + x1, y1=int(bb.y1) + y1,
                            x2=int(bb.x2) + x1, y2=int(bb.y2) + y1,
                        ),
                    )
                    det_results.append(translated)
        if len(det_results) > 0:
            used_tiles = True

    raw_detection_count = len(det_results)

    # PaddleOCR full-frame fallback. When YOLO + tiled YOLO both find nothing,
    # run PaddleOCR's own text detector on the full image. It finds plate-shaped
    # text Vol. text general; we filter to plate-like candidates (length 4-9
    # alphanumeric after stripping). The hit rate is lower than YOLO+OCR but
    # catches frames where YOLO is bad at the specific plate angle / size.
    used_paddle_full_frame = False
    if raw_detection_count == 0 and paddle_reader is not None:
        try:
            full_results = paddle_reader.ocr(img, cls=False)
        except Exception:
            full_results = None
        if full_results and full_results[0]:
            plates_full: List[PlateCandidate] = []
            for entry in full_results[0]:
                # entry shape: [bbox_polygon, (text, confidence)]
                try:
                    text = entry[1][0]
                    conf = float(entry[1][1])
                except Exception:
                    continue
                if not text:
                    continue
                cleaned = re.sub(r"[^A-Z0-9]", "", text.upper())
                # Plate-shape filter: 4-9 alphanumerics is the typical plate
                # length envelope across US/EU formats.
                if not (4 <= len(cleaned) <= 9):
                    continue
                if conf < alpr_floor:
                    continue
                plates_full.append(PlateCandidate(plate=cleaned, confidence=round(conf, 4)))
            if plates_full:
                used_paddle_full_frame = True
                plates_full.sort(key=lambda p: p.confidence, reverse=True)
                return RecognizeResponse(
                    ok=True,
                    plates=plates_full,
                    raw_detection_count=len(plates_full),
                    processing_time_ms=(time.monotonic() - started) * 1000,
                    reason="paddle_full_frame_fallback",
                )

    if raw_detection_count == 0:
        return RecognizeResponse(
            ok=True,
            plates=[],
            raw_detection_count=0,
            processing_time_ms=(time.monotonic() - started) * 1000,
            reason="empty_scene_all_paths",
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
    # Capture every OCR attempt (even rejected ones) so the diag can see
    # what the OCR was reading. Resets per frame.
    debug_attempts: List[dict] = []
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
            debug_attempts.append({"text": None, "conf": conf, "ocr_conf": 0.0,
                                   "combined": 0.0, "aspect": round(aspect, 2),
                                   "drop": "aspect_gated"})
            continue
        crops = _ocr_variants(img, bbox)
        if not crops:
            debug_attempts.append({"text": None, "conf": conf, "ocr_conf": 0.0,
                                   "combined": 0.0, "drop": "no_crops"})
            continue
        plate_text, ocr_conf = _ocr_best(crops)
        if not plate_text:
            debug_attempts.append({"text": None, "conf": conf, "ocr_conf": float(ocr_conf),
                                   "combined": 0.0, "drop": "ocr_empty"})
            continue
        cleaned = re.sub(r"[^A-Z0-9]", "", plate_text.upper())
        combined_conf = conf * ocr_conf
        debug_attempts.append({"text": plate_text, "cleaned": cleaned,
                               "conf": round(conf, 3), "ocr_conf": round(float(ocr_conf), 3),
                               "combined": round(combined_conf, 3),
                               "drop": None if (cleaned and combined_conf >= alpr_floor)
                                       else ("empty_clean" if not cleaned else "below_floor")})
        if not cleaned:
            continue
        if combined_conf < alpr_floor:
            continue
        plates.append(PlateCandidate(plate=cleaned, confidence=round(combined_conf, 4)))

    plates.sort(key=lambda p: p.confidence, reverse=True)
    if plates:
        reason = None
    elif aspect_gated == raw_detection_count and raw_detection_count > 0:
        reason = f"all_dets_aspect_gated:{aspect_gated}"
    else:
        # Include a hint of what OCR actually read so we can diagnose.
        first_text = next((a.get("text") for a in debug_attempts if a.get("text")), None)
        reason = f"no_plate_shaped_text:{first_text}" if first_text else "no_plate_shaped_text"
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
    # Lazy-load the heavy non-essential models. Idempotent — only the
    # FIRST request after container start pays the download cost.
    _ensure_paddle_loaded()
    _ensure_detr_loaded()

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
