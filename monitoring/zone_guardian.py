#!/usr/bin/env python3
"""
LotLogic Zone Guardian — Autonomous Zone Detection Agent

Runs continuously across ALL lots and cameras. Monitors zone polygon health
by analyzing bounding box overlap between YOLO detections and zone polygons.

The backend uses IoU (Intersection over Union) overlap matching: a vehicle's
bounding box must overlap a zone polygon by at least 30% (ZONE_IOU_THRESHOLD)
to be assigned to that zone. This agent detects when vehicles are near zones
but below the overlap threshold, and when zones are too small for reliable matching.

Usage:
    # Single scan of all lots
    python zone_guardian.py --scan

    # Autonomous daemon (runs every 10 minutes)
    python zone_guardian.py --daemon

    # Scan and auto-fix (patches zones via API)
    python zone_guardian.py --scan --auto-fix

    # Scan specific camera
    python zone_guardian.py --scan --camera-id <uuid>
"""

import argparse
import json
import logging
import signal
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

from agent_config import AgentConfig

# ── Logging ──────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("lotlogic.zone_guardian")

_running = True


def _handle_signal(signum, frame):
    global _running
    logger.info("Shutting down zone guardian...")
    _running = False


signal.signal(signal.SIGINT, _handle_signal)
signal.signal(signal.SIGTERM, _handle_signal)


# ── IoU Overlap Threshold (must match backend ZONE_IOU_THRESHOLD) ────────────

import os

ZONE_IOU_THRESHOLD = float(os.environ.get("ZONE_IOU_THRESHOLD", "0.30"))


# ── Geometry Helpers ─────────────────────────────────────────────────────────

def polygon_bounds(polygon):
    """Get bounding box of a polygon: (min_x, min_y, max_x, max_y)."""
    xs = [p[0] for p in polygon]
    ys = [p[1] for p in polygon]
    return min(xs), min(ys), max(xs), max(ys)


def bbox_zone_overlap(bbox, polygon):
    """Calculate what percentage of a detection bbox overlaps a zone polygon.

    Uses bounding-box approximation (good for rectangular parking zones).
    Returns overlap as a fraction 0.0-1.0 relative to the bbox area.

    This mirrors the backend's IoU matching logic — a vehicle matches a zone
    when overlap >= ZONE_IOU_THRESHOLD (default 0.30).
    """
    x1, y1, x2, y2 = bbox
    bbox_area = (x2 - x1) * (y2 - y1)
    if bbox_area <= 0:
        return 0.0

    min_x, min_y, max_x, max_y = polygon_bounds(polygon)
    overlap_x = max(0, min(x2, max_x) - max(x1, min_x))
    overlap_y = max(0, min(y2, max_y) - max(y1, min_y))

    if overlap_x <= 0 or overlap_y <= 0:
        return 0.0

    return (overlap_x * overlap_y) / bbox_area


def expand_polygon(polygon, padding):
    """Expand a polygon outward by padding amount (in normalized 0-1 coords).
    Works by shifting each edge outward from the centroid."""
    if len(polygon) < 3:
        return polygon

    cx = sum(p[0] for p in polygon) / len(polygon)
    cy = sum(p[1] for p in polygon) / len(polygon)

    expanded = []
    for px, py in polygon:
        dx = px - cx
        dy = py - cy
        dist = (dx ** 2 + dy ** 2) ** 0.5
        if dist > 0:
            scale = (dist + padding) / dist
            expanded.append([
                round(cx + dx * scale, 4),
                round(cy + dy * scale, 4),
            ])
        else:
            expanded.append([px, py])

    return expanded


# ── Core Analysis ────────────────────────────────────────────────────────────

def analyze_camera_zones(camera, snapshots, violations, config):
    """Analyze all zones on a camera for overlap issues.

    Uses IoU-style bounding box overlap analysis (matching the backend's zone
    matching logic). Detects vehicles below the overlap threshold, borderline
    matches, and zones that are too small for reliable detection.

    Returns list of findings, each with:
    - zone_id, camera info
    - overlap analysis for each detection
    - recommended polygon fix (if applicable)
    - severity (error/warning)
    """
    cid = camera["id"]
    cname = camera.get("name", "Unknown")
    zones = camera.get("zones") or []
    findings = []

    if not zones:
        return findings

    # Collect all vehicle detections from recent snapshots
    detections = []
    for snap in snapshots:
        raw = snap.get("raw_detections") or {}
        dets = raw.get("detections", []) if isinstance(raw, dict) else []
        for d in dets:
            bbox = d.get("bbox") or d.get("bounding_box")
            if bbox and len(bbox) == 4:
                detections.append({
                    "bbox": bbox,
                    "conf": d.get("conf", d.get("confidence", 0)),
                })

    if not detections:
        return findings

    # Which zones have produced violations?
    violation_zone_ids = set(v.get("zone_id") for v in violations)

    for zone in zones:
        zid = zone.get("zone_id") or zone.get("id") or "unknown"
        polygon = zone.get("polygon", [])
        if not polygon or len(polygon) < 3:
            continue

        min_x, min_y, max_x, max_y = polygon_bounds(polygon)
        zone_area = (max_x - min_x) * (max_y - min_y)

        # Classify each detection by overlap with this zone
        dets_above_threshold = []    # overlap >= IoU threshold (matching)
        dets_borderline = []         # overlap 20-30% (close to threshold)
        dets_low_overlap = []        # overlap 5-20% (touching but not enough)
        dets_near_miss = []          # overlap 0-5% (barely touching)

        for det in detections:
            overlap = bbox_zone_overlap(det["bbox"], polygon)

            if overlap >= ZONE_IOU_THRESHOLD:
                dets_above_threshold.append({**det, "overlap": round(overlap, 4)})
            elif overlap >= 0.20:
                dets_borderline.append({**det, "overlap": round(overlap, 4)})
            elif overlap >= 0.05:
                dets_low_overlap.append({**det, "overlap": round(overlap, 4)})
            elif overlap > 0:
                dets_near_miss.append({**det, "overlap": round(overlap, 4)})

        has_violations = zid in violation_zone_ids

        # ── Finding: Vehicles below IoU threshold (zone needs expansion) ──
        if (dets_borderline or dets_low_overlap) and not has_violations and not dets_above_threshold:
            below_threshold = dets_borderline + dets_low_overlap
            max_overlap = max(d["overlap"] for d in below_threshold)
            # Estimate how much to expand — increase zone to push overlap above threshold
            deficit = ZONE_IOU_THRESHOLD - max_overlap
            fix_padding = deficit + 0.02  # 2% safety margin

            fixed_polygon = expand_polygon(polygon, fix_padding)
            # Verify fix — recalculate overlap with expanded polygon
            would_fix = sum(
                1 for d in below_threshold
                if bbox_zone_overlap(d["bbox"], fixed_polygon) >= ZONE_IOU_THRESHOLD
            )

            findings.append({
                "severity": "error",
                "type": "low_overlap",
                "camera_id": cid,
                "camera_name": cname,
                "zone_id": zid,
                "zone_type": zone.get("violation_type", "unknown"),
                "current_polygon": polygon,
                "recommended_polygon": fixed_polygon,
                "vehicles_affected": len(below_threshold),
                "max_overlap": f"{max_overlap * 100:.1f}%",
                "threshold": f"{ZONE_IOU_THRESHOLD * 100:.0f}%",
                "fix_would_resolve": f"{would_fix}/{len(below_threshold)}",
                "fix_padding_applied": round(fix_padding, 4),
                "message": (
                    f"LOW OVERLAP: Zone '{zid}' on '{cname}' — "
                    f"{len(below_threshold)} vehicles overlap this zone at up to "
                    f"{max_overlap*100:.1f}% but the IoU threshold is "
                    f"{ZONE_IOU_THRESHOLD*100:.0f}%. Zone needs expansion to capture them."
                ),
            })

        # ── Finding: Zone works but vehicles are borderline ──
        elif has_violations and dets_borderline:
            min_overlap = min(d["overlap"] for d in dets_borderline)
            findings.append({
                "severity": "warning",
                "type": "overlap_borderline",
                "camera_id": cid,
                "camera_name": cname,
                "zone_id": zid,
                "vehicles_at_risk": len(dets_borderline),
                "lowest_overlap": f"{min_overlap * 100:.1f}%",
                "threshold": f"{ZONE_IOU_THRESHOLD * 100:.0f}%",
                "message": (
                    f"BORDERLINE OVERLAP: Zone '{zid}' on '{cname}' is producing violations "
                    f"but {len(dets_borderline)} vehicles have overlap between 20-30%. "
                    f"A slight camera shift could push them below the {ZONE_IOU_THRESHOLD*100:.0f}% "
                    f"threshold. Consider expanding the zone."
                ),
            })

        # ── Finding: Near-miss vehicles not caught ──
        elif dets_near_miss and not has_violations and not dets_above_threshold and not dets_borderline:
            findings.append({
                "severity": "warning",
                "type": "near_miss",
                "camera_id": cid,
                "camera_name": cname,
                "zone_id": zid,
                "vehicles_near": len(dets_near_miss),
                "message": (
                    f"NEAR MISS: Zone '{zid}' on '{cname}' — "
                    f"{len(dets_near_miss)} vehicles detected near but barely overlapping "
                    f"this zone. Zone may need to be repositioned."
                ),
            })

        # ── Finding: Zone too small ──
        if zone_area < 0.005:
            findings.append({
                "severity": "warning",
                "type": "zone_too_small",
                "camera_id": cid,
                "camera_name": cname,
                "zone_id": zid,
                "zone_area_pct": f"{zone_area * 100:.2f}%",
                "message": (
                    f"SMALL ZONE: Zone '{zid}' on '{cname}' covers only "
                    f"{zone_area*100:.2f}% of the frame. Small zones are unreliable "
                    f"for IoU overlap matching."
                ),
            })

    return findings


# ── API Actions ──────────────────────────────────────────────────────────────

def apply_zone_fix(config, camera_id, zones, finding):
    """Apply a zone polygon fix via the backend API."""
    api_url = config.api_url
    api_key = "UJn9mwti15jbhgRUnhw6-VOk3TAt1VJAK3VNCIdAHa8"

    # Update the specific zone's polygon in the zones array
    updated_zones = []
    for z in zones:
        zid = z.get("zone_id") or z.get("id")
        if zid == finding["zone_id"]:
            updated = dict(z)
            updated["polygon"] = finding["recommended_polygon"]
            updated_zones.append(updated)
            logger.info("  Fixing zone %s: expanding polygon", zid)
        else:
            updated_zones.append(z)

    try:
        resp = requests.patch(
            f"{api_url}/cameras/{camera_id}/zones",
            json={"zones": updated_zones},
            headers={
                "Content-Type": "application/json",
                "X-Api-Key": api_key,
            },
            timeout=15,
        )
        if resp.status_code in (200, 204):
            logger.info("  Zone fix applied successfully via API")
            return True
        else:
            logger.error("  Zone fix failed: HTTP %d — %s", resp.status_code, resp.text[:200])
            return False
    except requests.RequestException as e:
        logger.error("  Zone fix request failed: %s", e)
        return False


# ── Alert Formatting ─────────────────────────────────────────────────────────

def format_finding_alert(finding):
    """Format a finding as a Slack/log alert string."""
    severity_icon = {"error": "🔴", "warning": "🟡"}.get(finding["severity"], "⚪")
    lines = [f"{severity_icon} *{finding['type'].upper()}*: {finding['message']}"]

    if finding["type"] == "low_overlap":
        lines.append(f"  Vehicles affected: {finding['vehicles_affected']}")
        lines.append(f"  Max overlap: {finding['max_overlap']} (threshold: {finding['threshold']})")
        lines.append(f"  Fix: expand polygon by {finding['fix_padding_applied']*100:.1f}%")

    return "\n".join(lines)


def send_alert(config, subject, body):
    """Send alert via Slack webhook if configured."""
    if config.slack_webhook_url:
        try:
            requests.post(
                config.slack_webhook_url,
                json={"text": f"*{subject}*\n{body}"},
                timeout=10,
            )
        except Exception as e:
            logger.error("Slack alert failed: %s", e)
    logger.info("ALERT: %s — %s", subject, body[:200])


# ── Scan All Lots ────────────────────────────────────────────────────────────

def scan_all(config, camera_filter=None, auto_fix=False):
    """Scan all active cameras for zone overlap issues.

    Returns dict with all findings across all lots.
    """
    headers = {
        "apikey": config.supabase_anon_key,
        "Authorization": f"Bearer {config.supabase_anon_key}",
    }
    supabase = config.supabase_url

    logger.info("Zone Guardian: scanning all cameras...")

    # Get all active cameras
    cam_params = "?select=id,name,lot_id,zones,active,status&active=eq.true"
    if camera_filter:
        cam_params += f"&id=eq.{camera_filter}"

    cam_resp = requests.get(
        f"{supabase}/rest/v1/cameras{cam_params}",
        headers=headers,
        timeout=15,
    )
    if cam_resp.status_code != 200:
        logger.error("Failed to fetch cameras: HTTP %d", cam_resp.status_code)
        return {"error": f"HTTP {cam_resp.status_code}"}

    cameras = cam_resp.json()
    if not cameras:
        logger.info("No active cameras found")
        return {"cameras": 0, "findings": []}

    now = datetime.now(timezone.utc)
    since = (now - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S")

    all_findings = []
    fixes_applied = 0

    for cam in cameras:
        cid = cam["id"]
        cname = cam.get("name", "Unknown")
        zones = cam.get("zones") or []

        if not zones:
            continue

        # Get recent snapshots with raw detections
        snap_resp = requests.get(
            f"{supabase}/rest/v1/snapshots",
            params={
                "select": "id,raw_detections,vehicles_detected,captured_at",
                "camera_id": f"eq.{cid}",
                "captured_at": f"gte.{since}",
                "order": "captured_at.desc",
                "limit": "20",
            },
            headers=headers,
            timeout=15,
        )
        snapshots = snap_resp.json() if snap_resp.status_code == 200 else []

        # Get recent violations for this camera
        viol_resp = requests.get(
            f"{supabase}/rest/v1/violations",
            params={
                "select": "id,zone_id,detected_at",
                "camera_id": f"eq.{cid}",
                "order": "detected_at.desc",
                "limit": "200",
            },
            headers=headers,
            timeout=15,
        )
        violations = viol_resp.json() if viol_resp.status_code == 200 else []

        # Run analysis
        findings = analyze_camera_zones(cam, snapshots, violations, config)
        all_findings.extend(findings)

        # Handle findings
        for f in findings:
            logger.info("[%s] %s: %s", f["severity"].upper(), f["type"], f["message"])

            if f["type"] == "low_overlap" and auto_fix:
                logger.info("  Auto-fixing zone %s on %s...", f["zone_id"], cname)
                success = apply_zone_fix(config, cid, zones, f)
                if success:
                    fixes_applied += 1
                    # Update local zones for subsequent analysis
                    for z in zones:
                        if (z.get("zone_id") or z.get("id")) == f["zone_id"]:
                            z["polygon"] = f["recommended_polygon"]

    # Summary
    errors = [f for f in all_findings if f["severity"] == "error"]
    warnings = [f for f in all_findings if f["severity"] == "warning"]

    result = {
        "timestamp": now.isoformat(),
        "cameras_scanned": len(cameras),
        "total_zones": sum(len(c.get("zones") or []) for c in cameras),
        "findings": all_findings,
        "summary": {
            "errors": len(errors),
            "warnings": len(warnings),
            "low_overlap": sum(1 for f in all_findings if f["type"] == "low_overlap"),
            "overlap_borderline": sum(1 for f in all_findings if f["type"] == "overlap_borderline"),
            "near_misses": sum(1 for f in all_findings if f["type"] == "near_miss"),
            "zones_too_small": sum(1 for f in all_findings if f["type"] == "zone_too_small"),
            "fixes_applied": fixes_applied,
        },
    }

    # Print summary
    print(f"\n{'='*60}")
    print(f"  Zone Guardian Scan — {now.strftime('%Y-%m-%d %H:%M:%S UTC')}")
    print(f"{'='*60}")
    print(f"  Cameras scanned: {result['cameras_scanned']}")
    print(f"  Total zones: {result['total_zones']}")
    print(f"  Low overlap: {result['summary']['low_overlap']}")
    print(f"  Borderline overlap: {result['summary']['overlap_borderline']}")
    print(f"  Near misses: {result['summary']['near_misses']}")
    if auto_fix:
        print(f"  Fixes applied: {fixes_applied}")
    print(f"{'='*60}")

    for f in all_findings:
        icon = {"error": "X", "warning": "!"}.get(f["severity"], "?")
        print(f"  [{icon}] {f['message']}")

    if not all_findings:
        print("  All zones healthy — no overlap issues detected")

    print()

    # Alert on errors
    if errors:
        alert_body = "\n\n".join(format_finding_alert(f) for f in errors)
        send_alert(config, f"Zone Guardian: {len(errors)} zone overlap issue(s) detected", alert_body)

    # Save report
    report_dir = config.report_dir
    report_dir.mkdir(parents=True, exist_ok=True)
    report_file = report_dir / f"zone_guardian_{now.strftime('%Y%m%d_%H%M%S')}.json"
    report_file.write_text(json.dumps(result, indent=2, default=str))
    logger.info("Report saved: %s", report_file)

    return result


# ── Daemon Mode ──────────────────────────────────────────────────────────────

def run_daemon(config, auto_fix=False):
    """Run zone guardian continuously."""
    scan_interval = 600  # 10 minutes
    logger.info("Zone Guardian daemon starting (interval: %ds, auto_fix: %s)",
                scan_interval, auto_fix)

    while _running:
        try:
            scan_all(config, auto_fix=auto_fix)
        except Exception as e:
            logger.exception("Scan failed: %s", e)

        # Sleep in small increments for responsive shutdown
        for _ in range(scan_interval // 2):
            if not _running:
                break
            time.sleep(2)

    logger.info("Zone Guardian daemon stopped.")


# ── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="LotLogic Zone Guardian — Autonomous zone gap detection agent"
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--scan", action="store_true",
                       help="Single scan of all cameras")
    group.add_argument("--daemon", action="store_true",
                       help="Run continuously (every 10 minutes)")

    parser.add_argument("--auto-fix", action="store_true",
                        help="Automatically fix low-overlap zones by expanding zone polygons")
    parser.add_argument("--camera-id", type=str, default=None,
                        help="Scan only this camera (UUID)")

    args = parser.parse_args()
    config = AgentConfig.from_env()

    if args.scan:
        scan_all(config, camera_filter=args.camera_id, auto_fix=args.auto_fix)
    elif args.daemon:
        run_daemon(config, auto_fix=args.auto_fix)


if __name__ == "__main__":
    main()
