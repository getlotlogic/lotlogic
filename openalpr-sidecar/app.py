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

SIDECAR_AUTH_TOKEN = os.environ.get("SIDECAR_AUTH_TOKEN", "")
DETECTOR_MODEL = os.environ.get("DETECTOR_MODEL", "yolo-v9-s-608-license-plate-end2end")
# fast-plate-ocr v1.x ships several global models. cct-s-v2 is the current
# default in the upstream README and supports US plate formats. Switch to
# 'cct-xs-v1-global-model' for a smaller / faster variant.
OCR_MODEL = os.environ.get("OCR_MODEL", "cct-s-v2-global-model")
DETECTOR_MIN_CONF = float(os.environ.get("DETECTOR_MIN_CONF", "0.40"))
ALPR_MIN_CONFIDENCE = float(os.environ.get("ALPR_MIN_CONFIDENCE", "0.50"))
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
    detector = LicensePlateDetector(detection_model=DETECTOR_MODEL)
    ocr_reader = LicensePlateRecognizer(OCR_MODEL)
    if ENABLE_EASYOCR_FALLBACK:
        import easyocr as _easyocr
        easyocr_reader = _easyocr.Reader(["en"], gpu=False, verbose=False)


class RecognizeRequest(BaseModel):
    image_base64: str = Field(..., description="Base64-encoded JPEG (data: URI prefix optional).")
    auth_token: Optional[str] = Field(None, description="Shared secret; must match SIDECAR_AUTH_TOKEN.")


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


def _decode_image(image_base64: str) -> np.ndarray:
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
    if MAX_IMAGE_WIDTH > 0 and img.shape[1] > MAX_IMAGE_WIDTH:
        scale = MAX_IMAGE_WIDTH / img.shape[1]
        new_w = MAX_IMAGE_WIDTH
        new_h = int(img.shape[0] * scale)
        img = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA)
    return img


def _run_pipeline(img: np.ndarray) -> RecognizeResponse:
    started = time.monotonic()

    # Stage 1: plate detection. Returns a list of detection objects with
    # bounding box + confidence. End-to-end NMS is baked into the model,
    # so duplicates are already suppressed.
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

    # Stage 2: OCR each crop. Skip crops below DETECTOR_MIN_CONF or with
    # OCR exceptions; we only emit confident plates.
    plates: List[PlateCandidate] = []
    h, w = img.shape[:2]
    for det in det_results:
        # open-image-models exposes detections via .bounding_box and
        # .confidence on the result objects. Bounding box has x1/y1/x2/y2.
        bbox = getattr(det, "bounding_box", det)
        conf = float(getattr(det, "confidence", 0.0))
        if conf < DETECTOR_MIN_CONF:
            continue
        x1 = max(0, int(bbox.x1) - 8)
        y1 = max(0, int(bbox.y1) - 8)
        x2 = min(w, int(bbox.x2) + 8)
        y2 = min(h, int(bbox.y2) + 8)
        crop = img[y1:y2, x1:x2]
        if crop.size == 0:
            continue
        try:
            ocr_result = ocr_reader.run(crop, return_confidence=True)
            # fast-plate-ocr returns a list of PlatePrediction objects.
            if not ocr_result:
                continue
            pred = ocr_result[0]
            # API name shifted between v1.0 and v1.1 — try both.
            plate_text = getattr(pred, "plate", None) or getattr(pred, "text", "") or ""
            if hasattr(pred, "char_probs") and pred.char_probs is not None:
                ocr_conf = float(pred.char_probs.mean())
            elif hasattr(pred, "confidence"):
                ocr_conf = float(pred.confidence)
            else:
                ocr_conf = 1.0
        except Exception:
            continue
        if not plate_text:
            continue
        cleaned = re.sub(r"[^A-Z0-9]", "", plate_text.upper())
        if not cleaned:
            continue
        combined_conf = conf * ocr_conf
        if combined_conf < ALPR_MIN_CONFIDENCE:
            continue
        plates.append(PlateCandidate(plate=cleaned, confidence=round(combined_conf, 4)))

    plates.sort(key=lambda p: p.confidence, reverse=True)
    reason = None if plates else "no_plate_shaped_text"
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
        img = _decode_image(req.image_base64)
    except Exception as err:
        raise HTTPException(status_code=400, detail=str(err))

    try:
        return _run_pipeline(img)
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
