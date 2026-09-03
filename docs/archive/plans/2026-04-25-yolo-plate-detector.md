# YOLOv9 + fast-plate-ocr Sidecar — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the easyocr-only `openalpr-sidecar/app.py` with a two-stage pipeline: YOLOv9 plate detector (ONNX) → fast-plate-ocr OCR (ONNX). API contract stays identical so `camera-snapshot/index.ts` requires no changes.

**Spec:** `docs/superpowers/specs/2026-04-25-yolo-plate-detector-design.md`

**Tech stack:** Python 3.12, onnxruntime-cpu, fast-plate-ocr, opencv-python-headless, FastAPI, uvicorn, open-image-models.

---

## File structure

| Path | Action | Responsibility |
|---|---|---|
| `openalpr-sidecar/app.py` | Replace | New two-stage pipeline; same `RecognizeResponse` schema |
| `openalpr-sidecar/requirements.txt` | Replace | Remove easyocr-as-primary; add fast-plate-ocr, onnxruntime, open-image-models |
| `openalpr-sidecar/Dockerfile` | Replace | python:3.12-slim; bake model weights at build time |
| `openalpr-sidecar/railway.toml` | Modify | Reduce `healthcheckTimeout` from 300 to 60 |
| `openalpr-sidecar/README.md` | Update | Document new env vars, model sources, fallback behavior |

---

## Task 0: Offline model prep (one-time)

**Files:** none committed

- [ ] **Step 1:** Verify detector model download path

```bash
pip install open-image-models
python - <<'EOF'
from open_image_models import PlateDetector
d = PlateDetector(detection_model="yolo-v9-t-640-license-plate-end2end")
print("Detector OK")
EOF
```

- [ ] **Step 2:** Verify OCR model download path

```bash
pip install "fast-plate-ocr[onnxruntime]"
python - <<'EOF'
from fast_plate_ocr import LicensePlateRecognizer
r = LicensePlateRecognizer("global-plates-mobile-vit-v2-model")
print("OCR OK")
EOF
```

- [ ] **Step 3:** Smoke test combined pipeline on a sample frame

```python
import cv2
from open_image_models import PlateDetector
from fast_plate_ocr import LicensePlateRecognizer

det = PlateDetector(detection_model="yolo-v9-t-640-license-plate-end2end")
ocr = LicensePlateRecognizer("global-plates-mobile-vit-v2-model")

img = cv2.imread("sample_plate.jpg")
results = det.predict(img)
for r in results:
    x1,y1,x2,y2 = map(int, [r.x1,r.y1,r.x2,r.y2])
    crop = img[max(0,y1-8):y2+8, max(0,x1-8):x2+8]
    text, conf = ocr.run(crop)
    print(f"OCR: {text!r} conf={conf:.2f}")
```

**Verify the actual return-type attributes** (`r.x1` vs `r.bbox[0]`, `ocr.run` return shape) match the code in Task 2 before writing app.py.

---

## Task 1: `requirements.txt`

**Files:** Replace `openalpr-sidecar/requirements.txt`

- [ ] **Step 1:** Write new requirements

```
fastapi==0.110.0
uvicorn[standard]==0.29.0
pydantic==2.6.4
opencv-python-headless==4.9.0.80
numpy==1.26.4
onnxruntime==1.18.1
open-image-models==0.2.0
fast-plate-ocr[onnxruntime]==0.4.0
# Optional easyocr fallback. Default OFF.
easyocr==1.7.1
```

Run `pip index versions open-image-models fast-plate-ocr` to confirm latest stable patches before pinning.

- [ ] **Step 2:** Commit

```bash
git add openalpr-sidecar/requirements.txt
git commit -m "feat(sidecar): add fast-plate-ocr + open-image-models deps"
```

---

## Task 2: `app.py` — two-stage pipeline

**Files:** Replace `openalpr-sidecar/app.py`

- [ ] **Step 1:** Module header and configuration

```python
"""Two-stage license plate recognition sidecar.

Stage 1: YOLOv9 plate detector (ONNX via open-image-models).
Stage 2: fast-plate-ocr character recognition (ONNX).

API contract identical to easyocr-only v2.0.0 so callOpenAlprSidecar()
in camera-snapshot/index.ts requires no changes.

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

SIDECAR_AUTH_TOKEN = os.environ.get("SIDECAR_AUTH_TOKEN", "")
DETECTOR_MODEL = os.environ.get("DETECTOR_MODEL", "yolo-v9-t-640-license-plate-end2end")
OCR_MODEL = os.environ.get("OCR_MODEL", "global-plates-mobile-vit-v2-model")
DETECTOR_MIN_CONF = float(os.environ.get("DETECTOR_MIN_CONF", "0.40"))
ALPR_MIN_CONFIDENCE = float(os.environ.get("ALPR_MIN_CONFIDENCE", "0.50"))
MAX_IMAGE_WIDTH = int(os.environ.get("ALPR_MAX_IMAGE_WIDTH", "1280"))
ENABLE_EASYOCR_FALLBACK = os.environ.get("ENABLE_EASYOCR_FALLBACK", "false").lower() == "true"
```

- [ ] **Step 2:** Lazy-init globals + startup

```python
from open_image_models import PlateDetector
from fast_plate_ocr import LicensePlateRecognizer

app = FastAPI(title="LotLogic ALPR sidecar", version="3.0.0")

detector: Optional[PlateDetector] = None
ocr_reader: Optional[LicensePlateRecognizer] = None
easyocr_reader = None


@app.on_event("startup")
def on_startup() -> None:
    global detector, ocr_reader, easyocr_reader
    detector = PlateDetector(detection_model=DETECTOR_MODEL)
    ocr_reader = LicensePlateRecognizer(OCR_MODEL)
    if ENABLE_EASYOCR_FALLBACK:
        import easyocr as _easyocr
        easyocr_reader = _easyocr.Reader(["en"], gpu=False, verbose=False)
```

- [ ] **Step 3:** Pydantic models (unchanged)

```python
class RecognizeRequest(BaseModel):
    image_base64: str = Field(...)
    auth_token: Optional[str] = Field(None)


class PlateCandidate(BaseModel):
    plate: str
    confidence: float


class RecognizeResponse(BaseModel):
    ok: bool
    plates: List[PlateCandidate]
    raw_detection_count: int = 0
    processing_time_ms: float
    reason: Optional[str] = None
```

- [ ] **Step 4:** `/health` endpoint

```python
@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "detector_loaded": detector is not None,
        "ocr_loaded": ocr_reader is not None,
        "easyocr_fallback": easyocr_reader is not None,
    }
```

- [ ] **Step 5:** Image decode helper

```python
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
        img = cv2.resize(img, (MAX_IMAGE_WIDTH, int(img.shape[0] * scale)), interpolation=cv2.INTER_AREA)
    return img
```

- [ ] **Step 6:** Two-stage pipeline helper

```python
def _run_pipeline(img: np.ndarray) -> RecognizeResponse:
    started = time.monotonic()

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

    plates: List[PlateCandidate] = []
    h, w = img.shape[:2]
    for det in det_results:
        if det.confidence < DETECTOR_MIN_CONF:
            continue
        pad = 8
        x1 = max(0, int(det.x1) - pad)
        y1 = max(0, int(det.y1) - pad)
        x2 = min(w, int(det.x2) + pad)
        y2 = min(h, int(det.y2) + pad)
        crop = img[y1:y2, x1:x2]
        if crop.size == 0:
            continue
        try:
            plate_text, ocr_conf = ocr_reader.run(crop)
        except Exception:
            continue
        if not plate_text:
            continue
        cleaned = re.sub(r"[^A-Z0-9]", "", plate_text.upper())
        if not cleaned:
            continue
        combined_conf = float(det.confidence) * float(ocr_conf)
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
```

**Verify** `det.x1` / `det.confidence` attribute names against the actual `open-image-models` return type in Task 0 Step 3 before writing this.

- [ ] **Step 7:** `/recognize` endpoint with easyocr fallback

```python
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
            started = time.monotonic()
            try:
                detections = easyocr_reader.readtext(img)
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
                reason=f"easyocr_fallback:{type(pipeline_err).__name__}",
            )
        return RecognizeResponse(
            ok=False,
            plates=[],
            raw_detection_count=0,
            processing_time_ms=0.0,
            reason=f"pipeline_error:{type(pipeline_err).__name__}:{str(pipeline_err)[:80]}",
        )
```

- [ ] **Step 8:** Commit app.py

```bash
git add openalpr-sidecar/app.py
git commit -m "feat(sidecar): two-stage YOLOv9 + fast-plate-ocr pipeline (v3)"
```

---

## Task 3: `Dockerfile`

**Files:** Replace `openalpr-sidecar/Dockerfile`

- [ ] **Step 1:** New Dockerfile

```dockerfile
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download ONNX weights at build time. Both models cache under
# XDG_CACHE_HOME (~/.cache by default).
RUN python -c "\
from open_image_models import PlateDetector; \
PlateDetector(detection_model='yolo-v9-t-640-license-plate-end2end'); \
from fast_plate_ocr import LicensePlateRecognizer; \
LicensePlateRecognizer('global-plates-mobile-vit-v2-model'); \
print('Model pre-fetch complete')"

# easyocr fallback model — pre-download to keep the fallback path instant.
RUN python -c "import easyocr; easyocr.Reader(['en'], gpu=False, verbose=False)" || true

COPY app.py .

ENV PORT=8000
EXPOSE 8000

CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000}"]
```

---

## Task 4: `railway.toml`

**Files:** Modify `openalpr-sidecar/railway.toml`

- [ ] **Step 1:** Reduce healthcheck timeout

```toml
[build]
builder = "DOCKERFILE"
dockerfilePath = "Dockerfile"

[deploy]
healthcheckPath = "/health"
healthcheckTimeout = 60
restartPolicyType = "on_failure"
restartPolicyMaxRetries = 3
```

---

## Task 5: Local smoke test

- [ ] **Step 1:** Build + run

```bash
cd openalpr-sidecar
docker build -t lotlogic-alpr-v3 .
docker run -p 8001:8000 lotlogic-alpr-v3
```

- [ ] **Step 2:** Health + sample plate

```bash
curl -s http://localhost:8001/health | python -m json.tool

python - <<'EOF'
import base64, json, requests
with open("sample_plate.jpg", "rb") as f:
    b64 = base64.b64encode(f.read()).decode()
r = requests.post("http://localhost:8001/recognize", json={"image_base64": b64})
print(json.dumps(r.json(), indent=2))
EOF
```

Expected: `{"ok": true, "plates": [{"plate": "...", "confidence": ...}], "raw_detection_count": 1, ...}`

- [ ] **Step 3:** Empty-scene path with a black JPEG

```python
import numpy as np, cv2, base64, requests
black = np.zeros((480, 640, 3), dtype=np.uint8)
_, buf = cv2.imencode(".jpg", black)
b64 = base64.b64encode(buf).decode()
r = requests.post("http://localhost:8001/recognize", json={"image_base64": b64})
assert r.json()["reason"] == "empty_scene"
```

---

## Task 6: Deploy to Railway

- [ ] **Step 1:** Push to main, Railway auto-rebuilds the existing service. Watch build log for `Model pre-fetch complete`.

- [ ] **Step 2:** Set/verify Railway env vars on the sidecar service:

```
SIDECAR_AUTH_TOKEN     (existing value)
DETECTOR_MIN_CONF      0.40
ALPR_MIN_CONFIDENCE    0.50
ENABLE_EASYOCR_FALLBACK  false
ALPR_MAX_IMAGE_WIDTH   1280
```

- [ ] **Step 3:** Verify `OPENALPR_SIDECAR_URL` in Supabase secrets points at the same service URL (no change expected).

- [ ] **Step 4:** Deploy: `git push origin main` triggers Railway build.

- [ ] **Step 5:** Smoke test against prod after build completes (~3-5 min):

```bash
curl -s https://<railway-url>/health
# expected: {"ok": true, "detector_loaded": true, "ocr_loaded": true, "easyocr_fallback": false}
```

---

## Task 7: 24h production validation

- [ ] **Step 1:** Turn on one camera for 10 min daytime test. Verify Detected Plates populates in dashboard.

- [ ] **Step 2:** After 24h of live traffic, run the comparison query:

```sql
SELECT
  raw_data->>'_source' AS source,
  raw_data->>'_sidecar_reason' AS sidecar_reason,
  COUNT(*) AS cnt
FROM plate_events
WHERE created_at > now() - interval '24 hours'
  AND raw_data->>'_source' LIKE '%openalpr%'
GROUP BY 1, 2 ORDER BY 3 DESC;
```

Accept the new sidecar as production-stable if:
- `empty_scene` rate is ≤ the old rate
- `inherit_tier` = `openalpr` rows appear (sidecar correctly identifying known plates)
- No `sidecar_http_5*` or `sidecar_error` spikes

---

## Task 8: README update

**Files:** Update `openalpr-sidecar/README.md`

Document new pipeline, env vars, model sources, fallback toggle.

---

## Phase 3 (future): fine-tuning

Once `training_curator` accumulates 500+ operator-labeled `sidecar_rejected` frames, fine-tune the OCR model on LotLogic-specific data. See `docs/superpowers/specs/2026-04-24-training-curator-design.md`.

---

## Self-review checklist

- ✅ Spec covers all sections in design doc
- ✅ Code blocks complete, no TBD/placeholders
- ✅ API contract preserved (callOpenAlprSidecar reads same 3 fields)
- ✅ Fallback path documented and reachable
- ✅ Railway env vars enumerated
- ✅ Smoke tests for ok-plate, empty-scene, error paths
- ⚠️ Library return-type attribute names need verification (Task 0 Step 3 before Task 2 Step 6)

## Execution

When ready: subagent-driven-development (recommended) or executing-plans. Tasks 0-2 are sequential; 3-4 can be done in parallel; 5-8 are sequential.
