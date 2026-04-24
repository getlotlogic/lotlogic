FROM ubuntu:20.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1

# Enable universe repo — openalpr is available in Ubuntu 20.04 (focal) universe.
# Use echo instead of add-apt-repository to avoid gpg-agent issues in
# Railway's sandboxed builder.
RUN echo "deb http://archive.ubuntu.com/ubuntu focal universe" >> /etc/apt/sources.list && \
    echo "deb http://archive.ubuntu.com/ubuntu focal-updates universe" >> /etc/apt/sources.list && \
    apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates \
    openalpr \
    openalpr-daemon \
    python3 python3-venv python3-pip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt

COPY app.py .

ENV PORT=8000
EXPOSE 8000

# Railway injects $PORT at runtime; default 8000 for local testing.
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000}"]
