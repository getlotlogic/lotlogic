FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1
ENV DEBIAN_FRONTEND=noninteractive

# opencv-python-headless needs libgl1 + libglib2.0 for cv2.imdecode.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download ONNX model weights at build time so runtime has zero
# network dependency and cold-start is bounded by container pull only.
# Both models cache under ~/.cache.
RUN python -c "from open_image_models import LicensePlateDetector; LicensePlateDetector(detection_model='yolo-v9-t-640-license-plate-end2end'); from fast_plate_ocr import LicensePlateRecognizer; LicensePlateRecognizer('global-plates-mobile-vit-v2-model'); print('Model pre-fetch complete')"

# easyocr fallback model — only used if ENABLE_EASYOCR_FALLBACK=true at
# runtime, but pre-fetching keeps the fallback path instant.
RUN python -c "import easyocr; easyocr.Reader(['en'], gpu=False, verbose=False)" || true

COPY app.py .

ENV PORT=8000
EXPOSE 8000

CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000}"]
