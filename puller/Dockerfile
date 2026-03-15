FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY snapshot_puller.py .

CMD ["python", "-u", "snapshot_puller.py", "--http"]
