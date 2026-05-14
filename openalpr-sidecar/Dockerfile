FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1
ENV DEBIAN_FRONTEND=noninteractive

# opencv-python-headless needs libgl1 + libglib2.0 for cv2.imdecode.
# paddlepaddle needs libgomp1 (GNU OpenMP runtime) for CPU inference.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install CPU-only torch first so the rest of the requirements file can
# pick up the already-installed torch as a transitive dep without
# pulling the CUDA-bundled wheel (which is 5x larger).
#
# Use --extra-index-url (not --index-url) so pip can still resolve
# torch's transitive deps (filelock, networkx, sympy, etc.) from PyPI.
# --index-url would force ONLY the PyTorch CDN and torch's deps would
# 404 — this was the v3.12.0 build failure.
RUN pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cpu torch==2.2.2+cpu

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download ONNX model weights at build time so cold-start is bounded
# by container pull. Best-effort (|| true): if model download is flaky,
# fall back to lazy load on first request rather than failing the build.
RUN python -c "from open_image_models import LicensePlateDetector; LicensePlateDetector(detection_model='yolo-v9-s-608-license-plate-end2end'); LicensePlateDetector(detection_model='yolo-v9-t-640-license-plate-end2end'); from fast_plate_ocr import LicensePlateRecognizer; LicensePlateRecognizer('cct-s-v2-global-model'); print('YOLO + fast-plate-ocr pre-fetch complete')" || true

# easyocr pre-fetch (fallback model). Best-effort.
RUN python -c "import easyocr; easyocr.Reader(['en'], gpu=False, verbose=False)" || true

# PaddleOCR PPOCRv4 — DO NOT pre-fetch at build time. The model download
# from Baidu's CDN is flaky and causes intermittent Railway build failures.
# Models lazy-load on first /recognize call after container start (adds
# ~5-10s to the first request, then warm for the rest of the container's
# lifetime). Worth the trade for build reliability.

# keremberke/yolov8m-license-plate — plate-specific YOLOv8m, benchmarks
# better than the bundled yolo-v9-s-608 on small/angled plates. Download
# the ONNX export at build time so /app/models/yolov8m-plate.onnx is
# available for CustomYoloDetector. Best-effort: if HF Hub flakes, the
# sidecar falls back to the bundled detector via the existing
# DETECTOR_MODEL_PATH-or-bundled branch in app.py.
RUN mkdir -p /app/models && python -c "from huggingface_hub import hf_hub_download; p = hf_hub_download(repo_id='keremberke/yolov8m-license-plate', filename='best.onnx', local_dir='/app/models'); import os; os.rename(p, '/app/models/yolov8m-plate.onnx'); print('plate detector ONNX cached at /app/models/yolov8m-plate.onnx')" || true

# DETR plate detector. nateraw/detr-license-plate-detector is the
# most-validated public plate-fine-tuned DETR available. Model lazy-loads
# on first /recognize call after startup (~30s download + ~10s init).
# Skipping the pre-fetch at build time per the same hygiene as PaddleOCR
# — HF Hub downloads can flake during build and bring down the whole
# image. Lazy load is one-time, then warm forever.

COPY app.py .
COPY custom_yolo.py .

# Custom Charlotte fine-tuned YOLO. Build context must contain models/
# (gitignored from public release; copy lotlogic-plate.onnx in before build).
# The COPY uses a glob so the build doesn't fail when the file is absent —
# in that case DETECTOR_MODEL_PATH should stay unset and the sidecar falls
# back to the bundled detector.
RUN mkdir -p /app/models
COPY models/* /app/models/

ENV PORT=8000
EXPOSE 8000

CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000}"]
