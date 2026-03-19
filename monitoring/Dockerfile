FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY *.py .
COPY *.sh .

# Default: run health monitor in daemon mode
CMD ["python", "-u", "agent_monitor.py", "--daemon"]
