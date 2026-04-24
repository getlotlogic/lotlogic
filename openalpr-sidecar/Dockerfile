FROM python:3.10-slim

ENV PYTHONUNBUFFERED=1
ENV DEBIAN_FRONTEND=noninteractive

# Minimal system deps for opencv (used internally by easyocr). Switched
# AWAY from openalpr apt package because:
#   - removed from Ubuntu 22.04+
#   - deadsnakes PPA on bionic (18.04) only ships bare python3.10, no
#     -dev/-venv/-distutils, so pip install fails
#   - building OpenALPR from source adds 10+ min to every deploy
# easyocr is pure pip + ships its own English OCR model, runs on CPU,
# catches plate-like text regions well enough to pre-filter PR calls.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download the easyocr English model during image build so runtime
# doesn't have to download ~100MB on first request.
RUN python -c "import easyocr; easyocr.Reader(['en'], gpu=False, verbose=False)"

COPY app.py .

ENV PORT=8000
EXPOSE 8000

CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000}"]
