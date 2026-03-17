#!/usr/bin/env python3
"""
LotLogic Async Snapshot Puller

Each camera runs as an independent asyncio task with its own:
  - Polling interval (from DB config)
  - Error tracking and exponential backoff
  - Connection management (HTTP token refresh)
  - Bandwidth tracking (for LTE cameras)

If one camera fails, the rest keep running.

New cameras are detected automatically every 60 seconds.
Removed/deactivated cameras are stopped gracefully.

Deploy to Railway:
    railway link
    railway up

Environment (all required — no hardcoded defaults):
    LOTLOGIC_API_URL   Backend URL
    LOTLOGIC_API_KEY   Backend API key
    SUPABASE_URL       Supabase project URL
    SUPABASE_KEY       Supabase service role key
    CAMERA_USER        Camera login username
    CAMERA_PASS        Camera login password
    LOT_ID             Lot UUID to monitor

Optional:
    PULL_INTERVAL      Override per-camera poll interval (seconds)
    LOG_LEVEL          DEBUG, INFO, WARNING (default: INFO)
"""

import argparse
import asyncio
import io
import logging
import os
import signal
import sys
import time
from datetime import datetime, timezone
from typing import Optional

import aiohttp

# ── Config ───────────────────────────────────────────────────────────────────

def _require_env(name: str) -> str:
    val = os.getenv(name)
    if not val:
        print(f"FATAL: Required environment variable {name} is not set", file=sys.stderr)
        sys.exit(1)
    return val


# Required — no hardcoded secrets
API_URL = os.getenv("LOTLOGIC_API_URL", "")
API_KEY = os.getenv("LOTLOGIC_API_KEY", "")
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_KEY = os.getenv("SUPABASE_KEY", "")
CAMERA_USER = os.getenv("CAMERA_USER", "")
CAMERA_PASS = os.getenv("CAMERA_PASS", "")

# Optional overrides
DEFAULT_POLL_INTERVAL = float(os.getenv("PULL_INTERVAL", "0"))  # 0 = use DB value
DEFAULT_LOT_ID = os.getenv("LOT_ID", "")

# Constants
CAMERA_RELOAD_INTERVAL = 60  # Check for new cameras every 60s
HEARTBEAT_INTERVAL = 30
INGEST_TIMEOUT = 30
HTTP_TIMEOUT = 10
MIN_FRAME_SIZE = 1000
MAX_BACKOFF = 300  # 5 minutes max backoff
INGEST_RETRY_ATTEMPTS = 2
INGEST_RETRY_DELAY = 2  # seconds

logging.basicConfig(
    level=getattr(logging, os.getenv("LOG_LEVEL", "INFO").upper(), logging.INFO),
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("puller")


# ── Supabase helpers (async) ────────────────────────────────────────────────

async def supabase_get(session: aiohttp.ClientSession, table: str, params: dict = None):
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    headers = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}
    async with session.get(url, headers=headers, params=params, timeout=aiohttp.ClientTimeout(total=10)) as r:
        r.raise_for_status()
        return await r.json()


async def supabase_patch(session: aiohttp.ClientSession, table: str, match_params: dict, data: dict):
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }
    async with session.patch(url, headers=headers, params=match_params, json=data, timeout=aiohttp.ClientTimeout(total=10)) as r:
        r.raise_for_status()


# ── Camera discovery ────────────────────────────────────────────────────────

async def get_cameras(session: aiohttp.ClientSession, lot_id: str = None, camera_id: str = None):
    params = {
        "active": "eq.true",
        "select": "id,name,lot_id,rtsp_url,http_snapshot_url,ip_address,port,channel,poll_interval_sec,deployment_profile,bandwidth_budget_mb,bandwidth_used_mb,zones",
    }
    if camera_id:
        params["id"] = f"eq.{camera_id}"
    elif lot_id:
        params["lot_id"] = f"eq.{lot_id}"
    return await supabase_get(session, "cameras", params)


# ── Per-camera async task ───────────────────────────────────────────────────

class CameraTask:
    """Independent async task for a single camera."""

    def __init__(self, camera: dict, session: aiohttp.ClientSession, dry_run: bool = False):
        self.camera = camera
        self.session = session
        self.dry_run = dry_run
        self.name = camera["name"]
        self.camera_id = camera["id"]
        self.lot_id = camera["lot_id"]
        self.channel = camera.get("channel", 0)
        self.deployment_profile = camera.get("deployment_profile", "wired")
        self.bandwidth_budget_mb = camera.get("bandwidth_budget_mb")
        self.bandwidth_used_mb = camera.get("bandwidth_used_mb", 0)
        self.zones = camera.get("zones") or []  # Zone polygons for detection filtering

        # Polling interval: env override > DB config > 30s default
        if DEFAULT_POLL_INTERVAL > 0:
            self.poll_interval = DEFAULT_POLL_INTERVAL
        else:
            self.poll_interval = camera.get("poll_interval_sec") or 30

        # HTTP token state
        self.token: Optional[str] = None
        self.token_expiry: float = 0
        self.base_url = self._resolve_base_url(camera)

        # Stats
        self.frames_sent = 0
        self.frames_failed = 0
        self.consecutive_failures = 0
        self.backoff_until: float = 0
        self.bytes_sent = 0

        # Control
        self._stop = asyncio.Event()
        self._task: Optional[asyncio.Task] = None

    def _resolve_base_url(self, camera: dict) -> str:
        from urllib.parse import urlparse
        if camera.get("http_snapshot_url"):
            parsed = urlparse(camera["http_snapshot_url"])
            return f"{parsed.scheme}://{parsed.netloc}"
        if camera.get("ip_address") and "trycloudflare.com" in camera.get("ip_address", ""):
            return f"https://{camera['ip_address']}"
        if camera.get("rtsp_url"):
            parsed = urlparse(camera["rtsp_url"])
            return f"http://{parsed.hostname}"
        return ""

    async def start(self):
        self._task = asyncio.create_task(self._run(), name=f"camera-{self.name}")
        log.info("[%s] Started (interval=%.0fs, profile=%s, base=%s)",
                 self.name, self.poll_interval, self.deployment_profile, self.base_url)

    async def stop(self):
        self._stop.set()
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        log.info("[%s] Stopped (sent=%d, failed=%d)", self.name, self.frames_sent, self.frames_failed)

    async def _run(self):
        try:
            # Initial login
            await self._login()

            while not self._stop.is_set():
                loop_start = time.monotonic()

                # Check backoff
                now = time.monotonic()
                if now < self.backoff_until:
                    wait = self.backoff_until - now
                    log.debug("[%s] Backing off %.1fs", self.name, wait)
                    try:
                        await asyncio.wait_for(self._stop.wait(), timeout=wait)
                        break  # stop was set
                    except asyncio.TimeoutError:
                        pass  # backoff complete

                # Check bandwidth budget
                if self.bandwidth_budget_mb and self.bandwidth_used_mb >= self.bandwidth_budget_mb:
                    log.warning("[%s] Bandwidth budget exhausted (%d/%d MB), pausing",
                                self.name, self.bandwidth_used_mb, self.bandwidth_budget_mb)
                    try:
                        await asyncio.wait_for(self._stop.wait(), timeout=60)
                        break
                    except asyncio.TimeoutError:
                        continue

                # Grab and send frame
                frame = await self._grab_frame()
                if frame is not None:
                    await self._send_frame(frame)
                else:
                    self.frames_failed += 1
                    self._apply_backoff()

                # Heartbeat (piggyback on frame cycle)
                await self._heartbeat()

                # Sleep remainder of interval
                elapsed = time.monotonic() - loop_start
                sleep_time = max(0, self.poll_interval - elapsed)
                if sleep_time > 0:
                    try:
                        await asyncio.wait_for(self._stop.wait(), timeout=sleep_time)
                        break  # stop was set
                    except asyncio.TimeoutError:
                        pass

        except asyncio.CancelledError:
            pass
        except Exception as e:
            log.error("[%s] Task crashed: %s", self.name, e, exc_info=True)

    # ── HTTP frame grab ──────────────────────────────────────────────────

    async def _login(self):
        if not self.base_url:
            log.error("[%s] No base URL configured", self.name)
            return

        url = f"{self.base_url}/cgi-bin/api.cgi?cmd=Login"
        payload = [{"cmd": "Login", "param": {"User": {
            "Version": "0", "userName": CAMERA_USER, "password": CAMERA_PASS,
        }}}]
        try:
            async with self.session.post(url, json=payload, timeout=aiohttp.ClientTimeout(total=HTTP_TIMEOUT)) as r:
                r.raise_for_status()
                data = await r.json()
                if data and data[0].get("code") == 0:
                    token_info = data[0]["value"]["Token"]
                    self.token = token_info["name"]
                    self.token_expiry = time.time() + token_info.get("leaseTime", 3600) - 60
                    log.info("[%s] Logged in (token expires in %ds)", self.name, token_info.get("leaseTime", 3600))
                    self.consecutive_failures = 0
                    self.backoff_until = 0
                else:
                    error = data[0].get("error", {}).get("detail", "unknown") if data else "no response"
                    log.error("[%s] Login failed: %s", self.name, error)
        except Exception as e:
            log.error("[%s] Login request failed: %s", self.name, e)

    async def _ensure_token(self):
        if self.token is None or time.time() > self.token_expiry:
            log.info("[%s] Token expired, re-logging in", self.name)
            await self._login()

    async def _grab_frame(self) -> Optional[bytes]:
        await self._ensure_token()
        if not self.token:
            return None

        url = f"{self.base_url}/cgi-bin/api.cgi?cmd=Snap&channel={self.channel}&rs=snap&token={self.token}"
        try:
            async with self.session.get(url, timeout=aiohttp.ClientTimeout(total=HTTP_TIMEOUT)) as r:
                r.raise_for_status()

                content_type = r.headers.get("content-type", "")
                if "json" in content_type or "text" in content_type:
                    log.warning("[%s] Got non-image response, refreshing token", self.name)
                    self.token = None
                    return None

                jpeg_bytes = await r.read()
                if len(jpeg_bytes) < MIN_FRAME_SIZE:
                    log.warning("[%s] Frame too small (%d bytes)", self.name, len(jpeg_bytes))
                    return None

                self.consecutive_failures = 0
                self.backoff_until = 0
                return jpeg_bytes

        except Exception as e:
            if self.consecutive_failures <= 3 or self.consecutive_failures % 10 == 0:
                log.warning("[%s] HTTP grab failed (%d): %s", self.name, self.consecutive_failures + 1, e)
            return None

    # ── Ingest with retry ────────────────────────────────────────────────

    async def _send_frame(self, jpeg_bytes: bytes):
        captured_at = datetime.now(timezone.utc)

        if self.dry_run:
            log.info("[%s] Captured %.0f KB — dry run", self.name, len(jpeg_bytes) / 1024)
            self.frames_sent += 1
            return

        url = f"{API_URL}/snapshots/ingest"
        headers = {"X-Api-Key": API_KEY}

        for attempt in range(1, INGEST_RETRY_ATTEMPTS + 1):
            try:
                form = aiohttp.FormData()
                form.add_field("image", io.BytesIO(jpeg_bytes), filename="frame.jpg", content_type="image/jpeg")
                form.add_field("camera_id", self.camera_id)
                form.add_field("lot_id", self.lot_id)
                form.add_field("captured_at", captured_at.isoformat())
                form.add_field("trigger_type", "poll")
                # Send zone polygons so backend only creates violations for vehicles inside zones
                if self.zones:
                    import json
                    form.add_field("zones", json.dumps(self.zones))

                async with self.session.post(url, headers=headers, data=form,
                                             timeout=aiohttp.ClientTimeout(total=INGEST_TIMEOUT)) as r:
                    r.raise_for_status()
                    result = await r.json()

                vehicles = result.get("vehicles_detected", 0)
                violations = result.get("violations_created", 0)
                snap_id = result.get("id", "?")
                log.info("[%s] #%s — %d vehicles, %d violations", self.name, snap_id, vehicles, violations)

                self.frames_sent += 1
                self.bytes_sent += len(jpeg_bytes)
                self._track_bandwidth(len(jpeg_bytes))
                return

            except Exception as e:
                if attempt < INGEST_RETRY_ATTEMPTS:
                    log.warning("[%s] Ingest attempt %d failed: %s — retrying in %ds",
                                self.name, attempt, e, INGEST_RETRY_DELAY)
                    await asyncio.sleep(INGEST_RETRY_DELAY)
                else:
                    log.error("[%s] Ingest failed after %d attempts: %s", self.name, attempt, e)
                    self.frames_failed += 1
                    self._apply_backoff()

    # ── Backoff logic ────────────────────────────────────────────────────

    def _apply_backoff(self):
        self.consecutive_failures += 1
        backoff = min(2 ** self.consecutive_failures, MAX_BACKOFF)
        self.backoff_until = time.monotonic() + backoff
        if self.consecutive_failures <= 5 or self.consecutive_failures % 10 == 0:
            log.warning("[%s] %d consecutive failures, backing off %.0fs",
                        self.name, self.consecutive_failures, backoff)

    # ── Heartbeat ────────────────────────────────────────────────────────

    _last_heartbeat: float = 0

    async def _heartbeat(self):
        now = time.monotonic()
        if now - self._last_heartbeat < HEARTBEAT_INTERVAL:
            return
        try:
            await supabase_patch(
                self.session,
                "cameras",
                {"id": f"eq.{self.camera_id}"},
                {"last_heartbeat": datetime.now(timezone.utc).isoformat(), "status": "active"},
            )
            self._last_heartbeat = now
        except Exception as e:
            log.debug("[%s] Heartbeat failed: %s", self.name, e)

    # ── Bandwidth tracking ───────────────────────────────────────────────

    def _track_bandwidth(self, frame_bytes: int):
        mb = frame_bytes / (1024 * 1024)
        self.bandwidth_used_mb += mb
        # Update DB periodically (every ~10 frames to avoid spam)
        if self.frames_sent % 10 == 0 and self.bandwidth_budget_mb:
            asyncio.create_task(self._update_bandwidth())

    async def _update_bandwidth(self):
        try:
            await supabase_patch(
                self.session,
                "cameras",
                {"id": f"eq.{self.camera_id}"},
                {"bandwidth_used_mb": int(self.bandwidth_used_mb)},
            )
        except Exception:
            pass


# ── Supervisor: manages all camera tasks ─────────────────────────────────

class PullerSupervisor:
    """Manages camera tasks. Hot-reloads cameras from DB."""

    def __init__(self, lot_id: str = None, camera_id: str = None, dry_run: bool = False):
        self.lot_id = lot_id
        self.camera_id = camera_id
        self.dry_run = dry_run
        self.tasks: dict[str, CameraTask] = {}  # camera_id -> CameraTask
        self._stop = asyncio.Event()
        self._session: Optional[aiohttp.ClientSession] = None

    async def run(self):
        connector = aiohttp.TCPConnector(limit=100, limit_per_host=10, ttl_dns_cache=300)
        async with aiohttp.ClientSession(connector=connector) as session:
            self._session = session

            # Initial camera load
            cameras = await get_cameras(session, lot_id=self.lot_id, camera_id=self.camera_id)
            if not cameras:
                log.error("No active cameras found")
                return

            log.info("Found %d camera(s):", len(cameras))
            for cam in cameras:
                log.info("  %s — %s (interval=%ss, profile=%s)",
                         cam["name"], cam.get("rtsp_url", cam.get("http_snapshot_url", "?")),
                         cam.get("poll_interval_sec", 30), cam.get("deployment_profile", "wired"))

            # Start all camera tasks
            for cam in cameras:
                task = CameraTask(cam, session, dry_run=self.dry_run)
                self.tasks[cam["id"]] = task
                await task.start()

            log.info("All %d camera tasks running", len(self.tasks))

            # Supervisor loop: hot-reload cameras
            while not self._stop.is_set():
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=CAMERA_RELOAD_INTERVAL)
                    break  # stop was set
                except asyncio.TimeoutError:
                    pass

                await self._reload_cameras(session)

            # Shutdown
            log.info("Shutting down %d camera tasks...", len(self.tasks))
            await asyncio.gather(*(t.stop() for t in self.tasks.values()))
            self._print_summary()

    async def _reload_cameras(self, session: aiohttp.ClientSession):
        try:
            cameras = await get_cameras(session, lot_id=self.lot_id, camera_id=self.camera_id)
        except Exception as e:
            log.warning("Camera reload failed: %s", e)
            return

        current_ids = set(self.tasks.keys())
        new_ids = {c["id"] for c in cameras}

        # Start new cameras
        for cam in cameras:
            if cam["id"] not in current_ids:
                log.info("New camera detected: %s", cam["name"])
                task = CameraTask(cam, session, dry_run=self.dry_run)
                self.tasks[cam["id"]] = task
                await task.start()

        # Stop removed cameras
        for cam_id in current_ids - new_ids:
            task = self.tasks.pop(cam_id)
            log.info("Camera removed: %s", task.name)
            await task.stop()

    def stop(self):
        self._stop.set()

    def _print_summary(self):
        total_sent = sum(t.frames_sent for t in self.tasks.values())
        total_failed = sum(t.frames_failed for t in self.tasks.values())
        total_bytes = sum(t.bytes_sent for t in self.tasks.values())
        log.info("=== Summary ===")
        log.info("Total frames sent: %d", total_sent)
        log.info("Total frames failed: %d", total_failed)
        log.info("Total data sent: %.1f MB", total_bytes / (1024 * 1024))
        for t in self.tasks.values():
            log.info("  [%s] sent=%d failed=%d consecutive_failures=%d",
                     t.name, t.frames_sent, t.frames_failed, t.consecutive_failures)


# ── Signal handling ──────────────────────────────────────────────────────

_supervisor: Optional[PullerSupervisor] = None


def _handle_signal(signum, _frame):
    log.info("Received signal %s, shutting down...", signum)
    if _supervisor:
        _supervisor.stop()


# ── CLI ──────────────────────────────────────────────────────────────────

def main():
    global _supervisor

    parser = argparse.ArgumentParser(
        description="LotLogic Async Snapshot Puller — one task per camera, auto-scaling",
    )
    parser.add_argument("--camera-id", "-c", help="Specific camera UUID (overrides lot)")
    parser.add_argument("--lot-id", "-l", default=DEFAULT_LOT_ID, help="Lot UUID")
    parser.add_argument("--dry-run", action="store_true", help="Capture but don't send")
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    # Validate required env vars
    missing = []
    for var in ["LOTLOGIC_API_URL", "LOTLOGIC_API_KEY", "SUPABASE_URL", "SUPABASE_KEY", "CAMERA_USER", "CAMERA_PASS"]:
        if not os.getenv(var):
            missing.append(var)

    if missing and not args.dry_run:
        log.error("Missing required environment variables: %s", ", ".join(missing))
        log.error("Set them in your Railway service or .env file")
        sys.exit(1)

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    _supervisor = PullerSupervisor(
        lot_id=args.lot_id or None,
        camera_id=args.camera_id or None,
        dry_run=args.dry_run,
    )

    asyncio.run(_supervisor.run())


if __name__ == "__main__":
    main()
