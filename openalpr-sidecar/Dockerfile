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
