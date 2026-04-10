FROM python:3.12-slim

WORKDIR /app

# Copy and install both agent and leadgen requirements
COPY agent/requirements.txt /app/agent/requirements.txt
COPY leadgen/requirements.txt /app/leadgen/requirements.txt
RUN pip install --no-cache-dir -r /app/agent/requirements.txt -r /app/leadgen/requirements.txt

# Copy both packages
COPY leadgen/ /app/leadgen/
COPY agent/ /app/agent/

ENV PYTHONPATH=/app
ENV PYTHONUNBUFFERED=1

# Single-shot run — Railway cron triggers this.
CMD ["python", "-u", "-m", "agent.run"]
