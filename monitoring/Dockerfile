FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY *.py .
COPY *.sh .

RUN useradd --create-home appuser && \
    mkdir -p /app/logs /app/reports && \
    chown appuser:appuser /app/logs /app/reports
USER appuser

# Default: run health monitor in daemon mode
CMD ["python", "-u", "agent_monitor.py", "--daemon"]
