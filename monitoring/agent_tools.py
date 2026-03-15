"""
LotLogic Autonomous Agent — Monitoring Tools

Standalone functions that check system health. Each returns a dict with:
  { "status": "ok"|"warning"|"error", "details": str, "data": dict }
"""

import json
import time
import logging
from datetime import datetime, timedelta, timezone

import requests

logger = logging.getLogger("lotlogic.tools")


# ── Dashboard Health ─────────────────────────────────────────────────────────

def check_dashboard(dashboard_url: str) -> dict:
    """Fetch the deployed dashboard and verify it loads correctly."""
    if not dashboard_url:
        return {"status": "warning", "details": "No DASHBOARD_URL configured", "data": {}}

    try:
        start = time.monotonic()
        resp = requests.get(dashboard_url, timeout=15)
        latency_ms = round((time.monotonic() - start) * 1000)

        checks = {
            "status_code": resp.status_code,
            "latency_ms": latency_ms,
            "has_react": "react" in resp.text.lower(),
            "has_supabase": "supabase" in resp.text.lower(),
            "has_lotlogic": "lotlogic" in resp.text.lower(),
            "content_length": len(resp.text),
        }

        if resp.status_code != 200:
            return {"status": "error", "details": f"HTTP {resp.status_code}", "data": checks}
        if latency_ms > 5000:
            return {"status": "warning", "details": f"Slow response: {latency_ms}ms", "data": checks}
        if not checks["has_react"]:
            return {"status": "error", "details": "React not found in page", "data": checks}

        return {"status": "ok", "details": f"Dashboard loaded in {latency_ms}ms", "data": checks}

    except requests.RequestException as e:
        return {"status": "error", "details": f"Connection failed: {e}", "data": {}}


# ── Backend API Health ───────────────────────────────────────────────────────

def check_api(api_url: str) -> dict:
    """Test key API endpoints for availability and response format."""
    results = {}
    endpoints = [
        ("GET", "/health", None),
        ("GET", "/violations?limit=1", None),
        ("GET", "/cameras?limit=1", None),
    ]

    for method, path, body in endpoints:
        try:
            start = time.monotonic()
            if method == "GET":
                resp = requests.get(f"{api_url}{path}", timeout=10)
            else:
                resp = requests.post(f"{api_url}{path}", json=body, timeout=10)
            latency_ms = round((time.monotonic() - start) * 1000)

            results[path] = {
                "status_code": resp.status_code,
                "latency_ms": latency_ms,
                "ok": 200 <= resp.status_code < 400,
            }
        except requests.RequestException as e:
            results[path] = {"status_code": 0, "latency_ms": 0, "ok": False, "error": str(e)}

    all_ok = all(r["ok"] for r in results.values())
    any_error = any(not r["ok"] for r in results.values())

    if any_error:
        failed = [p for p, r in results.items() if not r["ok"]]
        return {"status": "error", "details": f"Failed endpoints: {failed}", "data": results}

    return {"status": "ok", "details": "All API endpoints healthy", "data": results}


# ── Supabase Direct Check ────────────────────────────────────────────────────

def check_supabase(supabase_url: str, anon_key: str) -> dict:
    """Query Supabase REST API directly to verify database connectivity."""
    if not supabase_url or not anon_key:
        return {"status": "warning", "details": "Supabase not configured", "data": {}}

    headers = {
        "apikey": anon_key,
        "Authorization": f"Bearer {anon_key}",
    }

    checks = {}
    tables = ["violations", "cameras", "lots"]

    for table in tables:
        try:
            resp = requests.get(
                f"{supabase_url}/rest/v1/{table}?select=id&limit=1",
                headers=headers,
                timeout=10,
            )
            checks[table] = {
                "status_code": resp.status_code,
                "accessible": resp.status_code == 200,
            }
        except requests.RequestException as e:
            checks[table] = {"status_code": 0, "accessible": False, "error": str(e)}

    all_ok = all(c["accessible"] for c in checks.values())
    if not all_ok:
        failed = [t for t, c in checks.items() if not c["accessible"]]
        return {"status": "error", "details": f"Tables inaccessible: {failed}", "data": checks}

    return {"status": "ok", "details": "Supabase tables accessible", "data": checks}


# ── AI Detection Quality ─────────────────────────────────────────────────────

def check_detection_quality(supabase_url: str, anon_key: str) -> dict:
    """Analyze recent violations for AI detection quality metrics."""
    if not supabase_url or not anon_key:
        return {"status": "warning", "details": "Supabase not configured", "data": {}}

    headers = {
        "apikey": anon_key,
        "Authorization": f"Bearer {anon_key}",
    }

    try:
        # Get last 50 violations
        resp = requests.get(
            f"{supabase_url}/rest/v1/violations"
            "?select=id,plate_text,vehicle_color,vehicle_type,created_at"
            "&order=created_at.desc&limit=50",
            headers=headers,
            timeout=10,
        )
        if resp.status_code != 200:
            return {"status": "error", "details": f"HTTP {resp.status_code}", "data": {}}

        violations = resp.json()
        if not violations:
            return {"status": "warning", "details": "No violations found", "data": {}}

        total = len(violations)
        has_plate = sum(1 for v in violations if v.get("plate_text"))
        has_color = sum(1 for v in violations if v.get("vehicle_color") and v["vehicle_color"] != "gray")
        has_type = sum(1 for v in violations if v.get("vehicle_type") and v["vehicle_type"] != "car")

        metrics = {
            "total_recent": total,
            "plate_recognition_rate": round(has_plate / total * 100, 1),
            "color_detection_rate": round(has_color / total * 100, 1),
            "vehicle_type_variety": round(has_type / total * 100, 1),
        }

        # Determine overall quality
        plate_rate = metrics["plate_recognition_rate"]
        if plate_rate < 20:
            status = "error"
            detail = f"Critical: only {plate_rate}% plate recognition"
        elif plate_rate < 50:
            status = "warning"
            detail = f"Low plate recognition: {plate_rate}%"
        else:
            status = "ok"
            detail = f"Plate recognition at {plate_rate}%"

        return {"status": status, "details": detail, "data": metrics}

    except Exception as e:
        return {"status": "error", "details": str(e), "data": {}}


# ── Camera Status Check ──────────────────────────────────────────────────────

def check_cameras(supabase_url: str, anon_key: str) -> dict:
    """Check camera online status and snapshot freshness."""
    if not supabase_url or not anon_key:
        return {"status": "warning", "details": "Supabase not configured", "data": {}}

    headers = {
        "apikey": anon_key,
        "Authorization": f"Bearer {anon_key}",
    }

    try:
        resp = requests.get(
            f"{supabase_url}/rest/v1/cameras"
            "?select=id,name,status,last_heartbeat,snapshot_width,snapshot_height,active",
            headers=headers,
            timeout=10,
        )
        if resp.status_code != 200:
            return {"status": "error", "details": f"HTTP {resp.status_code}", "data": {}}

        cameras = resp.json()
        now = datetime.now(timezone.utc)
        stale_threshold = now - timedelta(minutes=10)

        results = []
        for cam in cameras:
            last = cam.get("last_heartbeat")
            is_stale = True
            if last:
                try:
                    last_dt = datetime.fromisoformat(last.replace("Z", "+00:00"))
                    is_stale = last_dt < stale_threshold
                except (ValueError, TypeError):
                    pass

            results.append({
                "id": cam["id"],
                "name": cam.get("name", "Unknown"),
                "status": cam.get("status", "unknown"),
                "resolution": f"{cam.get('snapshot_width', '?')}x{cam.get('snapshot_height', '?')}",
                "stale": is_stale,
            })

        offline = [c for c in results if c["status"] != "online"]
        stale = [c for c in results if c["stale"]]

        data = {
            "total": len(cameras),
            "online": len(cameras) - len(offline),
            "stale_snapshots": len(stale),
            "cameras": results,
        }

        if offline:
            return {"status": "error", "details": f"{len(offline)} cameras offline", "data": data}
        if stale:
            return {"status": "warning", "details": f"{len(stale)} cameras with stale snapshots", "data": data}

        return {"status": "ok", "details": f"All {len(cameras)} cameras healthy", "data": data}

    except Exception as e:
        return {"status": "error", "details": str(e), "data": {}}


# ── Revenue & Operations ─────────────────────────────────────────────────────

def check_operations(supabase_url: str, anon_key: str) -> dict:
    """Check recent operational metrics — violations per hour, action rates."""
    if not supabase_url or not anon_key:
        return {"status": "warning", "details": "Supabase not configured", "data": {}}

    headers = {
        "apikey": anon_key,
        "Authorization": f"Bearer {anon_key}",
    }

    try:
        # Get violations from last 24h
        since = (datetime.now(timezone.utc) - timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%S")
        resp = requests.get(
            f"{supabase_url}/rest/v1/violations",
            params={
                "select": "id,status,created_at",
                "created_at": f"gte.{since}",
                "order": "created_at.desc",
            },
            headers=headers,
            timeout=10,
        )
        if resp.status_code != 200:
            return {"status": "error", "details": f"HTTP {resp.status_code}", "data": {}}

        violations = resp.json()
        total = len(violations)
        actioned = sum(1 for v in violations if v.get("status") in ("booted", "towed"))
        pending = sum(1 for v in violations if v.get("status") == "pending")

        metrics = {
            "violations_24h": total,
            "violations_per_hour": round(total / 24, 1),
            "actioned": actioned,
            "pending": pending,
            "action_rate": round(actioned / total * 100, 1) if total > 0 else 0,
        }

        return {"status": "ok", "details": f"{total} violations in 24h", "data": metrics}

    except Exception as e:
        return {"status": "error", "details": str(e), "data": {}}


# ── Run All Checks ───────────────────────────────────────────────────────────

def run_all_checks(config) -> dict:
    """Run the full health check suite and return structured results."""
    results = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "checks": {
            "dashboard": check_dashboard(config.dashboard_url),
            "api": check_api(config.api_url),
            "supabase": check_supabase(config.supabase_url, config.supabase_anon_key),
            "detection_quality": check_detection_quality(config.supabase_url, config.supabase_anon_key),
            "cameras": check_cameras(config.supabase_url, config.supabase_anon_key),
            "operations": check_operations(config.supabase_url, config.supabase_anon_key),
        },
    }

    # Overall status
    statuses = [c["status"] for c in results["checks"].values()]
    if "error" in statuses:
        results["overall"] = "error"
    elif "warning" in statuses:
        results["overall"] = "warning"
    else:
        results["overall"] = "ok"

    return results
