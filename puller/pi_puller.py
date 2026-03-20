#!/usr/bin/env python3
"""
LotLogic Pi Puller — runs on the Raspberry Pi at the lot.

Grabs frames from local cameras and POSTs them to the backend API.
No tunnel needed — camera is on the same LAN.

Install:
    pip3 install requests

Usage:
    python3 pi_puller.py                          # run with env vars
    python3 pi_puller.py --camera-ip 192.168.1.134  # override camera IP

Environment:
    LOTLOGIC_API_URL    Backend URL (required)
    LOTLOGIC_API_KEY    Backend API key (required)
    CAMERA_IP           Camera IP on local network (default: 192.168.1.134)
    CAMERA_USER         Camera login username (required)
    CAMERA_PASS         Camera login password (required)
    CAMERA_ID           Camera UUID from Supabase (required)
    LOT_ID              Lot UUID from Supabase (required)
    POLL_INTERVAL       Seconds between snapshots (default: 30)
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

# ── Config ────────────────────────────────────────────────────────────────

API_URL = os.getenv("LOTLOGIC_API_URL", "https://lotlogic-backend-production.up.railway.app")
API_KEY = os.getenv("LOTLOGIC_API_KEY", "")
CAMERA_IP = os.getenv("CAMERA_IP", "192.168.1.134")
CAMERA_USER = os.getenv("CAMERA_USER", "")
CAMERA_PASS = os.getenv("CAMERA_PASS", "")
CAMERA_IDS = os.getenv("CAMERA_IDS", "")  # comma-separated camera UUIDs
CAMERA_ID = os.getenv("CAMERA_ID", "")     # single camera fallback
LOT_ID = os.getenv("LOT_ID", "")
POLL_INTERVAL = int(os.getenv("POLL_INTERVAL", "30"))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("pi-puller")

running = True


def handle_signal(sig, _frame):
    global running
    log.info("Shutting down...")
    running = False


signal.signal(signal.SIGINT, handle_signal)
signal.signal(signal.SIGTERM, handle_signal)

# ── Camera auth ───────────────────────────────────────────────────────────

class Camera:
    def __init__(self, ip, channel, camera_id, lot_id):
        self.ip = ip
        self.channel = channel
        self.camera_id = camera_id
        self.lot_id = lot_id
        self.base_url = f"http://{ip}"
        self.token = None
        self.token_expiry = 0
        self.session = requests.Session()
        self.consecutive_failures = 0

    def login(self):
        url = f"{self.base_url}/cgi-bin/api.cgi?cmd=Login"
        payload = [{"cmd": "Login", "param": {"User": {
            "Version": "0", "userName": CAMERA_USER, "password": CAMERA_PASS,
        }}}]
        try:
            r = self.session.post(url, json=payload, timeout=10)
            r.raise_for_status()
            data = r.json()
            if data and data[0].get("code") == 0:
                token_info = data[0]["value"]["Token"]
                self.token = token_info["name"]
                self.token_expiry = time.time() + token_info.get("leaseTime", 3600) - 60
                log.info("[ch%d] Logged in (token expires in %ds)", self.channel, token_info.get("leaseTime", 3600))
                return True
            else:
                error = data[0].get("error", {}).get("detail", "unknown") if data else "no response"
                log.error("[ch%d] Login failed: %s", self.channel, error)
        except Exception as e:
            log.error("[ch%d] Login error: %s", self.channel, e)
        return False

    def grab_frame(self):
        # Refresh token if needed
        if not self.token or time.time() > self.token_expiry:
            if not self.login():
                return None

        url = f"{self.base_url}/cgi-bin/api.cgi?cmd=Snap&channel={self.channel}&rs=snap&token={self.token}"
        try:
            r = self.session.get(url, timeout=10)
            r.raise_for_status()

            content_type = r.headers.get("content-type", "")
            if "json" in content_type or "text" in content_type:
                log.warning("[ch%d] Got non-image response, refreshing token", self.channel)
                self.token = None
                return None

            if len(r.content) < 1000:
                log.warning("[ch%d] Frame too small (%d bytes)", self.channel, len(r.content))
                return None

            self.consecutive_failures = 0
            return r.content

        except Exception as e:
            self.consecutive_failures += 1
            if self.consecutive_failures <= 3 or self.consecutive_failures % 10 == 0:
                log.warning("[ch%d] Grab failed (%d): %s", self.channel, self.consecutive_failures, e)
            return None

    def send_frame(self, jpeg_bytes):
        captured_at = datetime.now(timezone.utc)
        url = f"{API_URL}/snapshots/ingest"
        headers = {"X-Api-Key": API_KEY}

        for attempt in range(1, 3):
            try:
                files = {"image": ("frame.jpg", io.BytesIO(jpeg_bytes), "image/jpeg")}
                data = {
                    "camera_id": self.camera_id,
                    "lot_id": self.lot_id,
                    "captured_at": captured_at.isoformat(),
                    "trigger_type": "poll",
                }
                r = self.session.post(url, headers=headers, files=files, data=data, timeout=30)
                r.raise_for_status()
                result = r.json()
                vehicles = result.get("vehicles_detected", 0)
                violations = result.get("violations_created", 0)
                snap_id = result.get("id", "?")
                log.info("[ch%d] #%s — %d vehicles, %d violations (%.0fKB)",
                         self.channel, snap_id, vehicles, violations, len(jpeg_bytes) / 1024)
                return True

            except Exception as e:
                if attempt < 2:
                    log.warning("[ch%d] Ingest attempt %d failed: %s — retrying", self.channel, attempt, e)
                    time.sleep(2)
                else:
                    log.error("[ch%d] Ingest failed: %s", self.channel, e)
        return False


# ── Main loop ─────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="LotLogic Pi Puller")
    parser.add_argument("--camera-ip", default=CAMERA_IP, help="Camera IP on local network")
    parser.add_argument("--interval", type=int, default=POLL_INTERVAL, help="Poll interval in seconds")
    parser.add_argument("--dry-run", action="store_true", help="Grab frames but don't send")
    args = parser.parse_args()

    # Validate
    missing = []
    for var, val in [("LOTLOGIC_API_KEY", API_KEY), ("CAMERA_USER", CAMERA_USER), ("CAMERA_PASS", CAMERA_PASS), ("LOT_ID", LOT_ID)]:
        if not val and not args.dry_run:
            missing.append(var)

    camera_ids = [c.strip() for c in CAMERA_IDS.split(",") if c.strip()] if CAMERA_IDS else ([CAMERA_ID] if CAMERA_ID else [])
    if not camera_ids and not args.dry_run:
        missing.append("CAMERA_IDS or CAMERA_ID")

    if missing:
        log.error("Missing required: %s", ", ".join(missing))
        sys.exit(1)

    # Create camera objects — one per channel/ID
    cameras = []
    for i, cam_id in enumerate(camera_ids):
        cameras.append(Camera(args.camera_ip, i, cam_id, LOT_ID))

    if not cameras:
        # Dry run with no IDs — just test channel 0
        cameras.append(Camera(args.camera_ip, 0, "dry-run", "dry-run"))

    log.info("Starting Pi Puller — %d camera(s) at %s, interval=%ds", len(cameras), args.camera_ip, args.interval)

    while running:
        loop_start = time.time()

        for cam in cameras:
            if not running:
                break

            frame = cam.grab_frame()
            if frame is None:
                continue

            if args.dry_run:
                log.info("[ch%d] Grabbed %.0fKB — dry run, not sending", cam.channel, len(frame) / 1024)
            else:
                cam.send_frame(frame)

        # Sleep remainder of interval
        elapsed = time.time() - loop_start
        sleep_time = max(0, args.interval - elapsed)
        if sleep_time > 0 and running:
            time.sleep(sleep_time)

    log.info("Stopped.")


if __name__ == "__main__":
    main()
