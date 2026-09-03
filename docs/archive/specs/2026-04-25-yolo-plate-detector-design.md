# YOLOv9 + fast-plate-ocr Sidecar — Design Spec

**Date:** 2026-04-25
**Status:** Design — awaiting implementation plan execution
**Owner:** Gabe
**Replaces:** easyocr-only `openalpr-sidecar/app.py` (v2.0.0)

---

## Why this exists

The easyocr sidecar has two structural failure modes in production:

1. **False-negative at night.** easyocr's general-purpose text detector misclassifies IR/grayscale frames as containing no plate-shaped text, even when Plate Recognizer reads a plate cleanly. The `NIGHT_LUMA_THRESHOLD` workaround in `camera-snapshot/index.ts` papers over this by bypassing the sidecar gate on dim frames, adding cost.
2. **False-positive on side-of-car frames.** Stickers, DOT numbers, and body-panel text pass the letter+digit heuristic despite not being plates. The gate was widened (`4-9 chars`) to reduce recall loss, which made precision worse.

Root cause: easyocr was never a plate _detector_. It is a dense text scanner that runs over the full frame. A purpose-built two-stage pipeline — detect plate region first, OCR the crop second — eliminates both failure modes by construction.

---

## Stage-by-stage flow

```
POST /recognize  { image_base64, auth_token }
        │ decode + optional resize (1280px)
        ▼
Stage 1 — Plate Detector
  Model: yolo-v9-t-640-license-plate-end2end (ONNX, MIT)
  Input: full RGB frame
  Output: [(x1,y1,x2,y2, conf), ...]  ≥ DETECTOR_MIN_CONF
  No plates found → ok:true, plates:[], reason:empty_scene
        │ crop each bbox (+ 8px padding)
        ▼
Stage 2 — Plate OCR
  Model: global-plates-mobile-vit-v2-model (ONNX, MIT)
  Input: cropped plate region
  Output: plate_text, per-char confidence → mean conf
  OCR fails / empty → skip candidate, continue
        │ sort by detector_conf × ocr_conf
        ▼
Response builder
  Plates with alphanumeric text → PlateCandidate list
  Fallback to easyocr if ENABLE_EASYOCR_FALLBACK=true AND
    stage 1 or stage 2 raised an exception
```

---

## Pre-trained detector model evaluation

| # | Model | Source | Size (ONNX) | mAP50 | License | Notes |
|---|---|---|---|---|---|---|
| 1 | **yolo-v9-t-640-license-plate-end2end** | `ankandrew/open-image-models` (HF) | ~6 MB | 0.958 | MIT | **Recommended.** Tiny variant, CPU-fast, production-proven in fast-alpr. End-to-end NMS baked in. |
| 2 | yolo-v9-s-608-license-plate-end2end | `ankandrew/open-image-models` (HF) | ~16 MB | 0.966 | MIT | Small variant; higher mAP, 2-3× slower on CPU. Phase 3 upgrade candidate. |
| 3 | ml-debi/yolov8-license-plate-detection | HuggingFace `ml-debi` | 12.2 MB | unreported | unknown | ONNX available. No stated license — do not use until confirmed. |
| 4 | keremberke/yolov8m-license-plate-detection | HuggingFace `keremberke` | ~50 MB | unreported | CC-BY 4.0 (dataset) | Medium model; sparse model card. |
| 5 | morsetechlab/yolov11-license-plate-detection | HuggingFace `morsetechlab` | ~6 MB | unreported | unknown | YOLOv11 nano. No license statement. |

**Decision: option 1.** MIT, measured mAP50 of 0.958 on a diverse multi-region dataset, ONNX-only with NMS baked in, ~6 MB weight file, maintained by the same author as fast-plate-ocr.

---

## OCR model selection

`fast-plate-ocr` (MIT, `ankandrew/fast-plate-ocr`) is the only ONNX-native, CPU-optimized plate OCR library with published pre-trained weights that carries a permissive license as of late 2025.

**Model chosen: `global-plates-mobile-vit-v2-model`**

- Architecture: MobileViT, ~2 MB ONNX.
- Trained on multi-region dataset including North American plates. Global model's character set covers all US state formats.
- Returns per-character confidence; `fast-plate-ocr` exposes confidence on the result.
- Install: `pip install fast-plate-ocr[onnxruntime]` — pulls `onnxruntime-cpu`, not PyTorch.

**easyocr as fallback:** Keep in `requirements.txt`, controlled by `ENABLE_EASYOCR_FALLBACK` env (default `false`). Activated only when Stage 1 or Stage 2 raises unhandled exception. Remove in Phase 3.

---

## Ultralytics package vs ONNX-only

**Decision: ONNX-only (`onnxruntime-cpu` only).**

| Factor | ultralytics | onnxruntime-cpu only |
|---|---|---|
| Package install size | ~1.8 GB (pulls torch+torchvision) | ~35 MB |
| Docker image compressed | ~2.5 GB | ~300 MB |
| Railway cold start (hobby 1 vCPU) | 90-180 s | 15-30 s |
| Runtime inference (CPU, 1280px frame) | ~400 ms | ~300 ms |
| Requires PyTorch at runtime | yes | no |

ONNX path is strictly smaller, faster cold-start, sufficient because we use pre-trained weights only.

---

## Docker base image

`python:3.12-slim`. Total compressed image ~280-320 MB.

---

## Memory and cold-start estimates (Railway hobby, 1 vCPU)

| Phase | RAM | Notes |
|---|---|---|
| Image pull + extract | 300 MB peak | |
| Python startup + FastAPI init | 80 MB | |
| ONNX detector model load | +25 MB | yolo-v9-t ONNX |
| ONNX OCR model load | +15 MB | MobileViT v2 |
| Per-request peak (1280px frame) | +60 MB | |
| **Total steady-state** | ~180 MB | |
| Cold start to first healthy response | 20-35 s | vs 60-90 s for easyocr |

`healthcheckTimeout` reduced from 300s to 60s.

---

## Fallback behavior

| Failure | Behavior |
|---|---|
| Stage 1 model raises | If `ENABLE_EASYOCR_FALLBACK=true`: run easyocr full-frame; else `ok:false, reason:detector_error` — edge function falls through to PR. |
| Stage 1 returns zero boxes | `ok:true, plates:[], raw_detection_count:0, reason:empty_scene` — edge function skips PR. |
| Stage 2 OCR raises on a crop | Skip that crop; continue. If all crops fail → `ok:true, plates:[], reason:ocr_error`. |
| Sidecar unreachable / timeout | `ok:false` — edge function falls through to PR (existing behavior). |

---

## Response schema (backward-compatible)

`RecognizeResponse` Pydantic model unchanged:

```python
class RecognizeResponse(BaseModel):
    ok: bool
    plates: List[PlateCandidate]   # [{plate, confidence}], sorted desc
    raw_detection_count: int        # detector boxes before OCR filter
    processing_time_ms: float
    reason: Optional[str]
```

`callOpenAlprSidecar()` in `camera-snapshot/index.ts` consumes `body.plates`, `body.raw_detection_count`, `body.processing_time_ms`. None change.

**Semantic improvement:** `raw_detection_count` now counts YOLO plate boxes (not raw easyocr text regions), so `reason: empty_scene` is a stronger signal — no plate-shaped region found by a purpose-built detector.

---

## New environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DETECTOR_MODEL` | `yolo-v9-t-640-license-plate-end2end` | Stage 1 weight name |
| `OCR_MODEL` | `global-plates-mobile-vit-v2-model` | Stage 2 model name |
| `DETECTOR_MIN_CONF` | `0.40` | Min YOLO box confidence |
| `ENABLE_EASYOCR_FALLBACK` | `false` | Enable easyocr on pipeline exception |
| `ALPR_MIN_CONFIDENCE` | `0.50` | Min combined confidence (detector × OCR) |
| `ALPR_MAX_IMAGE_WIDTH` | `1280` | Resize long edge before Stage 1 |
| `SIDECAR_AUTH_TOKEN` | `""` | Unchanged |

`ALPR_MIN_PLATE_LEN` / `ALPR_MAX_PLATE_LEN` retired — plate-shape filtering is no longer needed since YOLO handles it structurally.

---

## Sources

- [ankandrew/open-image-models](https://github.com/ankandrew/open-image-models) — detector
- [ankandrew/fast-plate-ocr](https://github.com/ankandrew/fast-plate-ocr) — OCR
- [ankandrew/fast-alpr](https://github.com/ankandrew/fast-alpr) — end-to-end framework
