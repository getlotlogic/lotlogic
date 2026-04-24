"""Lightweight ALPR sidecar for cost-efficient plate pre-filtering.

Runs on Railway. Accepts a base64-encoded JPEG via POST /recognize and
returns plate candidates extracted via easyocr (pure-Python OCR, runs
on CPU, ships with English model).

Invoked by the camera-snapshot edge function BEFORE the paid Plate
Recognizer API. If easyocr reads a plate-shaped text region and we
already have an open session for that plate, we skip PR entirely.

Rationale for easyocr vs OpenALPR binary: openalpr binary installs via
apt were broken on current Ubuntu bases (removed from 22.04 main, no
longer distributed for Debian). easyocr is pure pip + English model
shipped with the package — no OS-level gymnastics, predictable builds.
Accuracy is lower than a dedicated ALPR engine but sufficient to
pre-filter known plates already in our DB.
"""

import base64
import os
import re
import time
from typing import List, Optional

import cv2
import easyocr
import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

APP_AUTH_TOKEN = os.environ.get("SIDECAR_AUTH_TOKEN", "")
MIN_CONFIDENCE = float(os.environ.get("ALPR_MIN_CONFIDENCE", "0.55"))
MIN_PLATE_LEN = int(os.environ.get("ALPR_MIN_PLATE_LEN", "5"))
MAX_PLATE_LEN = int(os.environ.get("ALPR_MAX_PLATE_LEN", "8"))

app = FastAPI(
    title="LotLogic ALPR sidecar",
    description="Free pre-filter in front of Plate Recognizer.",
    version="2.0.0",
)

# Lazy-initialized at startup. Holds the heavy easyocr model so every
# request reuses it instead of paying startup cost per call.
reader: Optional[easyocr.Reader] = None


@app.on_event("startup")
def on_startup() -> None:
    global reader
    reader = easyocr.Reader(["en"], gpu=False, verbose=False)


class RecognizeRequest(BaseModel):
    image_base64: str = Field(..., description="Base64-encoded JPEG (data: URI prefix optional).")
    auth_token: Optional[str] = Field(None, description="Shared secret; must match SIDECAR_AUTH_TOKEN.")


class PlateCandidate(BaseModel):
    plate: str
    confidence: float


class RecognizeResponse(BaseModel):
    ok: bool
    plates: List[PlateCandidate]
    processing_time_ms: float
    reason: Optional[str] = None


@app.get("/health")
def health() -> dict:
    return {"ok": True, "reader_loaded": reader is not None}


@app.post("/recognize", response_model=RecognizeResponse)
def recognize(req: RecognizeRequest) -> RecognizeResponse:
    if APP_AUTH_TOKEN and req.auth_token != APP_AUTH_TOKEN:
        raise HTTPException(status_code=401, detail="unauthorized")

    if reader is None:
        raise HTTPException(status_code=503, detail="reader not loaded yet")

    started = time.monotonic()

    raw = req.image_base64
    if raw.startswith("data:"):
        raw = raw.split(",", 1)[1] if "," in raw else raw

    try:
        image_bytes = base64.b64decode(raw, validate=True)
    except Exception as err:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"bad base64: {err}")

    if not image_bytes:
        raise HTTPException(status_code=400, detail="empty image")

    nparr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(status_code=400, detail="cannot decode jpeg")

    # easyocr returns [(bbox, text, confidence), ...] — text may contain
    # spaces/punctuation; plates never do, so we normalize and filter.
    detections = reader.readtext(img)

    plates: List[PlateCandidate] = []
    for _bbox, text, conf in detections:
        cleaned = re.sub(r"[^A-Z0-9]", "", (text or "").upper())
        if not (MIN_PLATE_LEN <= len(cleaned) <= MAX_PLATE_LEN):
            continue
        # Plate shape rule: must contain at least one letter AND one digit.
        # Rejects pure text strings ("EXITONLY") and pure numbers ("123456").
        if not re.search(r"[A-Z]", cleaned) or not re.search(r"[0-9]", cleaned):
            continue
        if float(conf) < MIN_CONFIDENCE:
            continue
        plates.append(PlateCandidate(plate=cleaned, confidence=float(conf)))

    # Sort highest confidence first so the caller can just read plates[0].
    plates.sort(key=lambda p: p.confidence, reverse=True)

    return RecognizeResponse(
        ok=True,
        plates=plates,
        processing_time_ms=(time.monotonic() - started) * 1000,
    )
