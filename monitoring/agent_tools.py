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


# ── Zone Detection Health ────────────────────────────────────────────────────

def check_zone_detection_health(supabase_url: str, anon_key: str) -> dict:
    """Detect zones that aren't picking up violations — silent zones, confidence
    issues, camera-too-far problems, and detection dropoffs.

    Checks performed:
    1. Silent zones: online cameras with zones configured but zero recent detections
    2. Confidence skew: zones where avg confidence is abnormally high (over-filtering)
       or abnormally low (bad angle/distance)
    3. Detection dropoff: zones that previously had detections but stopped
    4. Snapshot-to-violation ratio: cameras taking snapshots but creating no violations
    5. Low-resolution risk: cameras with resolution too low for plate reading at distance
    """
    if not supabase_url or not anon_key:
        return {"status": "warning", "details": "Supabase not configured", "data": {}}

    headers = {
        "apikey": anon_key,
        "Authorization": f"Bearer {anon_key}",
    }

    try:
        # Fetch cameras with zone config
        cam_resp = requests.get(
            f"{supabase_url}/rest/v1/cameras"
            "?select=id,name,lot_id,online,zones,snapshot_width,snapshot_height,last_heartbeat",
            headers=headers,
            timeout=10,
        )
        if cam_resp.status_code != 200:
            return {"status": "error", "details": f"Cameras HTTP {cam_resp.status_code}", "data": {}}

        cameras = cam_resp.json()
        if not cameras:
            return {"status": "warning", "details": "No cameras found", "data": {}}

        now = datetime.now(timezone.utc)
        since_24h = (now - timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%S")
        since_7d = (now - timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%S")

        # Fetch recent violations (last 24h) grouped by camera and zone
        viol_resp = requests.get(
            f"{supabase_url}/rest/v1/violations",
            params={
                "select": "id,camera_id,zone_id,confidence,plate_confidence,detected_at",
                "detected_at": f"gte.{since_24h}",
                "order": "detected_at.desc",
                "limit": "500",
            },
            headers=headers,
            timeout=10,
        )

        # Fetch 7-day violations for trend comparison
        viol_7d_resp = requests.get(
            f"{supabase_url}/rest/v1/violations",
            params={
                "select": "id,camera_id,zone_id,detected_at",
                "detected_at": f"gte.{since_7d}",
                "order": "detected_at.desc",
                "limit": "2000",
            },
            headers=headers,
            timeout=10,
        )

        # Fetch recent snapshots to check detection ratios
        snap_resp = requests.get(
            f"{supabase_url}/rest/v1/snapshots",
            params={
                "select": "id,camera_id,vehicles_detected,captured_at",
                "captured_at": f"gte.{since_24h}",
                "order": "captured_at.desc",
                "limit": "500",
            },
            headers=headers,
            timeout=10,
        )

        violations_24h = viol_resp.json() if viol_resp.status_code == 200 else []
        violations_7d = viol_7d_resp.json() if viol_7d_resp.status_code == 200 else []
        snapshots_24h = snap_resp.json() if snap_resp.status_code == 200 else []

        # ── Analysis ────────────────────────────────────────────────

        alerts = []
        zone_stats = {}

        # Build per-camera, per-zone violation counts (24h)
        cam_zone_24h = {}
        cam_confidences = {}
        for v in violations_24h:
            cid = v.get("camera_id")
            zid = v.get("zone_id", "unknown")
            key = (cid, zid)
            cam_zone_24h[key] = cam_zone_24h.get(key, 0) + 1

            # Track confidence values per zone
            if key not in cam_confidences:
                cam_confidences[key] = []
            conf = v.get("confidence")
            if conf is not None:
                cam_confidences[key].append(conf)

        # Build per-camera, per-zone violation counts (7d, for trend)
        cam_zone_7d = {}
        for v in violations_7d:
            cid = v.get("camera_id")
            zid = v.get("zone_id", "unknown")
            key = (cid, zid)
            cam_zone_7d[key] = cam_zone_7d.get(key, 0) + 1

        # Build per-camera snapshot counts and vehicle detection counts
        cam_snapshots = {}
        cam_vehicles_seen = {}
        for s in snapshots_24h:
            cid = s.get("camera_id")
            cam_snapshots[cid] = cam_snapshots.get(cid, 0) + 1
            detected = s.get("vehicles_detected", 0) or 0
            cam_vehicles_seen[cid] = cam_vehicles_seen.get(cid, 0) + detected

        # ── Check 1: Silent zones (online camera + zones but no violations) ──

        for cam in cameras:
            cid = cam["id"]
            cname = cam.get("name", "Unknown")
            is_online = cam.get("online", False)
            zones = cam.get("zones") or []

            if not is_online:
                continue

            if isinstance(zones, list) and len(zones) > 0:
                for zone in zones:
                    zid = zone.get("id") or zone.get("zone_id") or "unknown"
                    key = (cid, zid)
                    count_24h = cam_zone_24h.get(key, 0)
                    count_7d = cam_zone_7d.get(key, 0)

                    zone_stats[f"{cname}/{zid}"] = {
                        "camera_id": cid,
                        "camera_name": cname,
                        "zone_id": zid,
                        "violations_24h": count_24h,
                        "violations_7d": count_7d,
                    }

                    if count_24h == 0 and count_7d == 0:
                        alerts.append({
                            "severity": "warning",
                            "type": "silent_zone",
                            "camera": cname,
                            "zone": zid,
                            "message": f"Zone '{zid}' on camera '{cname}' has NEVER detected a violation. "
                                       "Possible causes: zone polygon too small, camera too far, "
                                       "confidence threshold too high, or zone not in vehicle path.",
                        })
                    elif count_24h == 0 and count_7d > 0:
                        # Had detections before but stopped
                        daily_avg_7d = round(count_7d / 7, 1)
                        alerts.append({
                            "severity": "error",
                            "type": "detection_dropoff",
                            "camera": cname,
                            "zone": zid,
                            "message": f"Zone '{zid}' on camera '{cname}' had ~{daily_avg_7d} "
                                       f"violations/day over 7d but ZERO in last 24h. "
                                       "Detection may have stopped — check camera angle, "
                                       "obstructions, or backend inference pipeline.",
                        })

            # Check cameras without any zones configured
            if isinstance(zones, list) and len(zones) == 0:
                snap_count = cam_snapshots.get(cid, 0)
                if snap_count > 0:
                    alerts.append({
                        "severity": "warning",
                        "type": "no_zones_configured",
                        "camera": cname,
                        "message": f"Camera '{cname}' is online and taking snapshots "
                                   f"({snap_count} in 24h) but has NO zones configured. "
                                   "No violations can be created without zones.",
                    })

        # ── Check 2: Confidence skew ──

        for (cid, zid), confs in cam_confidences.items():
            if len(confs) < 3:
                continue
            avg_conf = sum(confs) / len(confs)
            cam_name = next((c.get("name", "Unknown") for c in cameras if c["id"] == cid), "Unknown")

            if avg_conf > 0.95:
                alerts.append({
                    "severity": "warning",
                    "type": "confidence_too_high",
                    "camera": cam_name,
                    "zone": zid,
                    "avg_confidence": round(avg_conf, 3),
                    "message": f"Zone '{zid}' on '{cam_name}' has avg confidence {avg_conf:.1%}. "
                               "This may indicate over-filtering — only very obvious violations "
                               "are being caught while borderline ones are missed. Consider "
                               "lowering the confidence threshold.",
                })
            elif avg_conf < 0.3:
                alerts.append({
                    "severity": "error",
                    "type": "confidence_too_low",
                    "camera": cam_name,
                    "zone": zid,
                    "avg_confidence": round(avg_conf, 3),
                    "message": f"Zone '{zid}' on '{cam_name}' has avg confidence {avg_conf:.1%}. "
                               "Camera may be too far, at a bad angle, or obstructed. "
                               "Low-confidence detections create unreliable violations.",
                })

        # ── Check 3: Snapshot-to-violation ratio (seeing cars but no violations) ──

        for cam in cameras:
            cid = cam["id"]
            cname = cam.get("name", "Unknown")
            if not cam.get("online", False):
                continue

            snap_count = cam_snapshots.get(cid, 0)
            vehicles_seen = cam_vehicles_seen.get(cid, 0)
            cam_violations = sum(
                cnt for (c, z), cnt in cam_zone_24h.items() if c == cid
            )

            if snap_count > 10 and vehicles_seen > 20 and cam_violations == 0:
                alerts.append({
                    "severity": "error",
                    "type": "vehicles_seen_no_violations",
                    "camera": cname,
                    "snapshots_24h": snap_count,
                    "vehicles_detected_24h": vehicles_seen,
                    "message": f"Camera '{cname}' detected {vehicles_seen} vehicles across "
                               f"{snap_count} snapshots in 24h but created ZERO violations. "
                               "The detection pipeline is seeing cars but not flagging them. "
                               "Check: zone polygons may not overlap vehicle positions, "
                               "confidence threshold may be filtering everything out, "
                               "or the violation engine may not be running.",
                })

        # ── Check 4: Low resolution risk ──

        for cam in cameras:
            cid = cam["id"]
            cname = cam.get("name", "Unknown")
            width = cam.get("snapshot_width", 640)
            height = cam.get("snapshot_height", 360)

            if width and height and (width < 640 or height < 360):
                alerts.append({
                    "severity": "warning",
                    "type": "low_resolution",
                    "camera": cname,
                    "resolution": f"{width}x{height}",
                    "message": f"Camera '{cname}' resolution is {width}x{height} which is below "
                               "minimum recommended 640x360. Plate recognition accuracy drops "
                               "significantly at low resolutions, especially at distance.",
                })

        # ── Build result ──

        error_alerts = [a for a in alerts if a["severity"] == "error"]
        warning_alerts = [a for a in alerts if a["severity"] == "warning"]

        data = {
            "cameras_analyzed": len(cameras),
            "zones_tracked": len(zone_stats),
            "alerts": alerts,
            "alert_counts": {
                "error": len(error_alerts),
                "warning": len(warning_alerts),
            },
            "zone_stats": zone_stats,
        }

        if error_alerts:
            return {
                "status": "error",
                "details": f"{len(error_alerts)} zone detection errors: "
                           + "; ".join(a["type"] for a in error_alerts[:3]),
                "data": data,
            }
        elif warning_alerts:
            return {
                "status": "warning",
                "details": f"{len(warning_alerts)} zone detection warnings: "
                           + "; ".join(a["type"] for a in warning_alerts[:3]),
                "data": data,
            }

        return {
            "status": "ok",
            "details": f"All {len(zone_stats)} zones detecting normally",
            "data": data,
        }

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
            "zone_detection_health": check_zone_detection_health(config.supabase_url, config.supabase_anon_key),
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
