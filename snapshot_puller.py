#!/usr/bin/env python3
"""
LotLogic Snapshot Puller

Captures frames from cameras and POSTs them to the backend for inference.
Supports two modes:

  1. LOCAL mode (RTSP) — runs on the same LAN as the camera
     python snapshot_puller.py --interval 2

  2. REMOTE mode (HTTP) — runs anywhere (Railway, cloud VM, etc.)
     Requires camera to be reachable via public IP or tunnel.
     Set CAMERA_HTTP_URL or update the camera's rtsp_url to an HTTP
     snapshot endpoint (Reolink: http://<ip>/cgi-bin/api.cgi?cmd=Snap&channel=0)

     python snapshot_puller.py --interval 2 --http

Deploy to Railway:
    railway link
    railway up

Environment:
    LOTLOGIC_API_URL   Backend URL
    LOTLOGIC_API_KEY   Backend API key
    SUPABASE_URL       Supabase project URL
    SUPABASE_KEY       Supabase service role key
    CAMERA_HTTP_URL    Override: public HTTP snapshot URL for remote mode
    PULL_INTERVAL      Override: seconds between captures (default: 2)

Requires: pip install opencv-python-headless requests
"""

import argparse
import io
import logging
import os
import signal
import sys
import time
from datetime import datetime, timezone

import requests

# ── Config ───────────────────────────────────────────────────────────────────

API_URL = os.getenv("LOTLOGIC_API_URL", "https://lotlogic-backend-production.up.railway.app")
API_KEY = os.getenv("LOTLOGIC_API_KEY", "UJn9mwti15jbhgRUnhw6-VOk3TAt1VJAK3VNCIdAHa8")
SUPABASE_URL = os.getenv("SUPABASE_URL", "https://nzdkoouoaedbbccraoti.supabase.co")
SUPABASE_KEY = os.getenv(
    "SUPABASE_KEY",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im56ZGtvb3VvYWVkYmJjY3Jhb3RpIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzEzODY5NCwiZXhwIjoyMDg4NzE0Njk0fQ.e0mFejhADSSvoInPRw1fLd0iOl08bwZGbrDm8hlqXJs",
)
CAMERA_HTTP_URL = os.getenv("CAMERA_HTTP_URL", "")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("puller")

_running = True


def _handle_signal(signum, _frame):
    global _running
    log.info("Shutting down (signal %s)...", signum)
    _running = False


signal.signal(signal.SIGINT, _handle_signal)
signal.signal(signal.SIGTERM, _handle_signal)


# ── Supabase helpers ─────────────────────────────────────────────────────────

def supabase_get(table, params=None):
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    headers = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}
    r = requests.get(url, headers=headers, params=params, timeout=10)
    r.raise_for_status()
    return r.json()


def supabase_patch(table, match_params, data):
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }
    r = requests.patch(url, headers=headers, params=match_params, json=data, timeout=10)
    r.raise_for_status()


# ── Camera discovery ─────────────────────────────────────────────────────────

def get_cameras(lot_id=None, camera_id=None):
    params = {"active": "eq.true", "select": "id,name,lot_id,rtsp_url,channel,poll_interval_sec"}
    if camera_id:
        params["id"] = f"eq.{camera_id}"
    elif lot_id:
        params["lot_id"] = f"eq.{lot_id}"
    cameras = supabase_get("cameras", params)
    if not cameras:
        log.error("No active cameras found")
        sys.exit(1)
    return cameras


# ── Frame capture: RTSP mode (local network) ────────────────────────────────

class RTSPStream:
    """Persistent RTSP connection with auto-reconnect."""

    def __init__(self, camera):
        self.camera = camera
        self.name = camera["name"]
        self.rtsp_url = camera["rtsp_url"]
        self.cap = None
        self.failures = 0
        self.frames = 0
        self.connect()

    def connect(self):
        try:
            import cv2
        except ImportError:
            log.error("opencv-python-headless required for RTSP mode: pip install opencv-python-headless")
            sys.exit(1)

        if self.cap is not None:
            self.cap.release()

        log.info("[%s] Connecting RTSP: %s", self.name, self.rtsp_url)
        self.cap = cv2.VideoCapture(self.rtsp_url, cv2.CAP_FFMPEG)
        self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

        if not self.cap.isOpened():
            log.error("[%s] RTSP connection failed", self.name)
            self.cap = None
            return False

        log.info("[%s] RTSP connected", self.name)
        self.failures = 0
        return True

    def grab_frame(self):
        import cv2

        if self.cap is None or not self.cap.isOpened():
            if not self.connect():
                return None

        ret, frame = self.cap.read()
        if not ret or frame is None:
            self.failures += 1
            if self.failures >= 3:
                self.connect()
            return None

        self.failures = 0
        self.frames += 1
        h, w = frame.shape[:2]
        ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
        if not ok:
            return None
        return buf.tobytes(), w, h

    def release(self):
        if self.cap:
            self.cap.release()
            self.cap = None


# ── Frame capture: HTTP mode (remote / cloud) ───────────────────────────────

class HTTPStream:
    """
    Grab snapshots via HTTP — works from anywhere the camera is reachable.

    Supports:
      - Reolink HTTP API: http://<ip>/cgi-bin/api.cgi?cmd=Snap&channel=0&user=admin&password=xxx
      - Generic MJPEG/JPEG snapshot URLs
      - Any URL that returns image/jpeg
    """

    def __init__(self, camera, http_url=None):
        self.camera = camera
        self.name = camera["name"]
        self.failures = 0
        self.frames = 0

        # Build HTTP snapshot URL from RTSP URL if not provided
        if http_url:
            self.url = http_url
        else:
            self.url = self._rtsp_to_http(camera["rtsp_url"], camera.get("channel", 0))

        log.info("[%s] HTTP mode: %s", self.name, self.url)

    @staticmethod
    def _rtsp_to_http(rtsp_url, channel=0):
        """
        Convert rtsp://user:pass@host:554/path to Reolink HTTP snapshot URL.
        Reolink cameras expose: http://<host>/cgi-bin/api.cgi?cmd=Snap&channel=N
        """
        from urllib.parse import urlparse
        parsed = urlparse(rtsp_url)
        host = parsed.hostname
        user = parsed.username or "admin"
        password = parsed.password or ""

        if password:
            return f"http://{host}/cgi-bin/api.cgi?cmd=Snap&channel={channel}&rs=snap&user={user}&password={password}"
        else:
            # No auth embedded — try without (some cameras allow it on LAN)
            return f"http://{host}/cgi-bin/api.cgi?cmd=Snap&channel={channel}&rs=snap"

    def grab_frame(self):
        try:
            r = requests.get(self.url, timeout=10, stream=True)
            r.raise_for_status()
            content_type = r.headers.get("content-type", "")
            if "image" not in content_type and "octet" not in content_type:
                log.warning("[%s] Unexpected content-type: %s", self.name, content_type)
                self.failures += 1
                return None

            jpeg_bytes = r.content
            if len(jpeg_bytes) < 1000:
                log.warning("[%s] Frame too small (%d bytes), likely an error", self.name, len(jpeg_bytes))
                self.failures += 1
                return None

            self.failures = 0
            self.frames += 1
            # We don't know dimensions without decoding — pass 0,0
            return jpeg_bytes, 0, 0

        except requests.exceptions.RequestException as e:
            self.failures += 1
            if self.failures <= 3 or self.failures % 10 == 0:
                log.warning("[%s] HTTP grab failed (%d): %s", self.name, self.failures, e)
            return None

    def release(self):
        pass


# ── Ingest ───────────────────────────────────────────────────────────────────

def send_to_backend(camera, jpeg_bytes, captured_at):
    """POST frame to /snapshots/ingest for inference + violation detection."""
    url = f"{API_URL}/snapshots/ingest"
    files = {"image": ("frame.jpg", io.BytesIO(jpeg_bytes), "image/jpeg")}
    data = {
        "camera_id": camera["id"],
        "lot_id": camera["lot_id"],
        "captured_at": captured_at.isoformat(),
        "trigger_type": "poll",
    }
    headers = {"X-Api-Key": API_KEY}

    try:
        r = requests.post(url, headers=headers, data=data, files=files, timeout=30)
        r.raise_for_status()
        result = r.json()
        vehicles = result.get("vehicles_detected", 0)
        violations = result.get("violations_created", 0)
        snap_id = result.get("id", "?")
        log.info(
            "[%s] #%s — %d vehicles, %d new violations",
            camera["name"], snap_id, vehicles, violations,
        )
        return result
    except requests.exceptions.RequestException as e:
        log.error("[%s] Ingest failed: %s", camera["name"], e)
        return None


def update_heartbeat(camera_id):
    try:
        supabase_patch(
            "cameras",
            {"id": f"eq.{camera_id}"},
            {"last_heartbeat": datetime.now(timezone.utc).isoformat(), "status": "active"},
        )
    except Exception as e:
        log.warning("Heartbeat update failed: %s", e)


# ── Main loop ────────────────────────────────────────────────────────────────

def run(cameras, interval, use_http=False, http_url=None, dry_run=False):
    """Main polling loop."""

    # Create streams
    streams = {}
    for cam in cameras:
        if use_http:
            streams[cam["id"]] = HTTPStream(cam, http_url=http_url)
        else:
            streams[cam["id"]] = RTSPStream(cam)

    total_sent = 0
    total_errors = 0
    start_time = time.time()
    heartbeat_timer = time.time()

    log.info(
        "Pulling %d camera(s) every %.1fs (%s mode) — Ctrl+C to stop",
        len(cameras), interval, "HTTP" if use_http else "RTSP",
    )

    while _running:
        loop_start = time.time()

        for cam in cameras:
            if not _running:
                break

            stream = streams[cam["id"]]
            result = stream.grab_frame()

            if result is None:
                total_errors += 1
                continue

            jpeg_bytes, w, h = result
            captured_at = datetime.now(timezone.utc)

            if dry_run:
                log.info("[%s] Captured %.0f KB — dry run", cam["name"], len(jpeg_bytes) / 1024)
            else:
                resp = send_to_backend(cam, jpeg_bytes, captured_at)
                if resp:
                    total_sent += 1
                else:
                    total_errors += 1

        # Heartbeat every 30 seconds
        if not dry_run and time.time() - heartbeat_timer > 30:
            for cam in cameras:
                update_heartbeat(cam["id"])
            heartbeat_timer = time.time()

        # Sleep remainder
        elapsed = time.time() - loop_start
        sleep_time = max(0, interval - elapsed)
        if sleep_time > 0 and _running:
            time.sleep(sleep_time)

    # Summary
    elapsed_total = time.time() - start_time
    for stream in streams.values():
        stream.release()
    log.info(
        "Done. %d sent, %d errors in %.0fs (%.1f fps)",
        total_sent, total_errors, elapsed_total,
        total_sent / max(elapsed_total, 1),
    )


# ── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="LotLogic Snapshot Puller — capture camera frames and send for AI inference",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Local network (RTSP), 2-second interval for hardwired camera
  python snapshot_puller.py -i 2

  # Remote / cloud (HTTP snapshot), 3-second interval
  python snapshot_puller.py -i 3 --http

  # Remote with explicit camera URL (port-forwarded or tunneled)
  python snapshot_puller.py --http --http-url "http://myip:8080/cgi-bin/api.cgi?cmd=Snap&channel=0"

  # Deploy to Railway (uses env vars)
  railway up
""",
    )
    parser.add_argument(
        "--interval", "-i", type=float,
        default=float(os.getenv("PULL_INTERVAL", "2")),
        help="Seconds between captures (default: 2)",
    )
    parser.add_argument("--camera-id", "-c", help="Specific camera UUID")
    parser.add_argument(
        "--lot-id", "-l",
        default=os.getenv("LOT_ID", "b6c79def-5e5a-4a45-8684-a05d1fc9625d"),
        help="Lot UUID",
    )
    parser.add_argument(
        "--http", action="store_true",
        help="Use HTTP snapshot mode instead of RTSP (works from cloud)",
    )
    parser.add_argument(
        "--http-url",
        default=CAMERA_HTTP_URL,
        help="Override HTTP snapshot URL (for port-forwarded / tunneled cameras)",
    )
    parser.add_argument("--dry-run", action="store_true", help="Capture but don't send")
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    cameras = get_cameras(lot_id=args.lot_id, camera_id=args.camera_id)
    log.info("Found %d camera(s):", len(cameras))
    for cam in cameras:
        log.info("  %s — %s", cam["name"], cam["rtsp_url"])

    run(
        cameras,
        interval=args.interval,
        use_http=args.http or bool(args.http_url),
        http_url=args.http_url or None,
        dry_run=args.dry_run,
    )


if __name__ == "__main__":
    main()
