FROM ubuntu:18.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1

# OpenALPR is only available in Ubuntu 18.04 (bionic) universe repo.
# For modern Python, add deadsnakes PPA — download the GPG key via curl
# (NOT apt-key adv) to avoid the gpg-agent requirement that fails in
# Railway's sandboxed builder.
RUN echo "deb http://archive.ubuntu.com/ubuntu bionic universe" >> /etc/apt/sources.list && \
    echo "deb http://archive.ubuntu.com/ubuntu bionic-updates universe" >> /etc/apt/sources.list && \
    apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates gnupg \
    openalpr openalpr-daemon \
    && curl -fsSL 'https://keyserver.ubuntu.com/pks/lookup?op=get&search=0xF23C5A6CF475977595C89F51BA6932366A755776' | apt-key add - \
    && echo "deb http://ppa.launchpad.net/deadsnakes/ppa/ubuntu bionic main" > /etc/apt/sources.list.d/deadsnakes.list \
    && apt-get update && apt-get install -y --no-install-recommends \
    python3.10 python3.10-dev \
    && curl -sS https://bootstrap.pypa.io/get-pip.py | python3.10 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN python3.10 -m pip install --no-cache-dir -r requirements.txt

COPY app.py .

ENV PORT=8000
EXPOSE 8000

# Railway injects $PORT at runtime; default 8000 for local testing.
CMD ["sh", "-c", "python3.10 -m uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000}"]
