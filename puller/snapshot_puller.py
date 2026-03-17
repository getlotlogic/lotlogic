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
API_KEY = os.getenv("LOTLOGIC_API_KEY")
if not API_KEY:
    raise RuntimeError("LOTLOGIC_API_KEY environment variable is required")
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
if not SUPABASE_URL or not SUPABASE_KEY:
    raise RuntimeError("SUPABASE_URL and SUPABASE_KEY environment variables are required")
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
    params = {
        "active": "eq.true",
        "select": "id,name,lot_id,rtsp_url,http_snapshot_url,ip_address,port,channel,poll_interval_sec,zones",
    }
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
        self.rtsp_url = self._build_rtsp_url(camera["rtsp_url"])
        self.cap = None
        self.failures = 0
        self.frames = 0
        self.connect()

    @staticmethod
    def _build_rtsp_url(rtsp_url):
        """Inject credentials into RTSP URL if not already present."""
        from urllib.parse import urlparse, quote
        parsed = urlparse(rtsp_url)
        if parsed.username:
            return rtsp_url
        user = os.getenv("CAMERA_USER", "admin")
        password = os.getenv("CAMERA_PASS")
        if not password:
            raise RuntimeError("CAMERA_PASS environment variable is required for RTSP cameras")
        return f"rtsp://{quote(user)}:{quote(password)}@{parsed.hostname}:{parsed.port or 554}{parsed.path}"

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
    Grab snapshots via Reolink HTTP API with token-based auth.
    Works through Cloudflare Tunnel or direct LAN access.

    Flow: Login → get token → use token for Snap requests → auto-refresh.
    """

    def __init__(self, camera, http_url=None):
        self.camera = camera
        self.name = camera["name"]
        self.failures = 0
        self.frames = 0
        self.token = None
        self.token_expiry = 0

        # Determine the base URL (scheme + host)
        if http_url:
            from urllib.parse import urlparse
            parsed = urlparse(http_url)
            self.base_url = f"{parsed.scheme}://{parsed.netloc}"
        elif camera.get("ip_address") and "trycloudflare.com" in camera.get("ip_address", ""):
            self.base_url = f"https://{camera['ip_address']}"
        else:
            from urllib.parse import urlparse
            parsed = urlparse(camera.get("rtsp_url", ""))
            self.base_url = f"http://{parsed.hostname}"

        self.channel = camera.get("channel", 0)
        self.user = os.getenv("CAMERA_USER", "admin")
        self.password = os.getenv("CAMERA_PASS", "Na9HTk&C1234")

        log.info("[%s] HTTP mode via %s", self.name, self.base_url)
        self._login()

    def _login(self):
        """Login to Reolink API and get a session token."""
        url = f"{self.base_url}/cgi-bin/api.cgi?cmd=Login"
        payload = [{"cmd": "Login", "param": {"User": {
            "Version": "0", "userName": self.user, "password": self.password,
        }}}]
        try:
            r = requests.post(url, json=payload, timeout=10)
            r.raise_for_status()
            data = r.json()
            if data and data[0].get("code") == 0:
                token_info = data[0]["value"]["Token"]
                self.token = token_info["name"]
                self.token_expiry = time.time() + token_info.get("leaseTime", 3600) - 60
                log.info("[%s] Logged in (token expires in %ds)", self.name, token_info.get("leaseTime", 3600))
            else:
                error = data[0].get("error", {}).get("detail", "unknown") if data else "no response"
                log.error("[%s] Login failed: %s", self.name, error)
        except requests.exceptions.RequestException as e:
            log.error("[%s] Login request failed: %s", self.name, e)

    def _ensure_token(self):
        """Refresh token if expired."""
        if self.token is None or time.time() > self.token_expiry:
            log.info("[%s] Token expired, re-logging in", self.name)
            self._login()

    def grab_frame(self):
        self._ensure_token()
        if not self.token:
            self.failures += 1
            return None

        url = f"{self.base_url}/cgi-bin/api.cgi?cmd=Snap&channel={self.channel}&rs=snap&token={self.token}"
        try:
            r = requests.get(url, timeout=10)
            r.raise_for_status()

            # Check if we got JSON (error) instead of an image
            content_type = r.headers.get("content-type", "")
            if "json" in content_type or "text" in content_type:
                # Token may have expired mid-session
                log.warning("[%s] Got non-image response, refreshing token", self.name)
                self.token = None
                self.failures += 1
                return None

            jpeg_bytes = r.content
            if len(jpeg_bytes) < 1000:
                log.warning("[%s] Frame too small (%d bytes)", self.name, len(jpeg_bytes))
                self.failures += 1
                return None

            self.failures = 0
            self.frames += 1
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
    import json as _json
    data = {
        "camera_id": camera["id"],
        "lot_id": camera["lot_id"],
        "captured_at": captured_at.isoformat(),
        "trigger_type": "poll",
    }
    # Send zone polygons so backend only creates violations for vehicles inside zones
    if camera.get("zones"):
        data["zones"] = _json.dumps(camera["zones"])
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
