FROM ubuntu:20.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1

# Ubuntu 20.04 (focal) is the last LTS with the openalpr package in the
# main archive. On 22.04+ the package was dropped, so we pin this base
# to avoid a build-from-source step that'd add ~10 min to every deploy.
# Python 3.8 is the distro default on 20.04 — adequate for FastAPI 0.110
# + pydantic 2.6.
RUN apt-get update && apt-get install -y --no-install-recommends \
    openalpr \
    openalpr-daemon \
    python3 \
    python3-pip \
    python3-venv \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt

COPY app.py .

ENV PORT=8000
EXPOSE 8000

# Railway injects $PORT at runtime; default 8000 for local testing.
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000}"]
