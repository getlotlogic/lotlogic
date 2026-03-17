#!/usr/bin/env python3
"""
LotLogic Zone Guardian — Autonomous Zone Detection Agent

Runs continuously across ALL lots and cameras. Detects when YOLO vehicle
centroids fall through gaps in zone polygons and automatically fixes them.

The #1 cause of silent zone failures: the backend uses CENTER-POINT-IN-POLYGON
matching. A vehicle bbox can overlap a zone by 40%+ but if the centroid lands
0.1% outside the polygon boundary, no violation is created. This agent catches
those gaps before they become a problem.

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


# ── Geometry Helpers ─────────────────────────────────────────────────────────

def polygon_bounds(polygon):
    """Get bounding box of a polygon: (min_x, min_y, max_x, max_y)."""
    xs = [p[0] for p in polygon]
    ys = [p[1] for p in polygon]
    return min(xs), min(ys), max(xs), max(ys)


def point_in_polygon_approx(px, py, polygon):
    """Approximate point-in-polygon using bounding box. Good enough for
    rectangular parking zones. For complex polygons, use ray casting."""
    min_x, min_y, max_x, max_y = polygon_bounds(polygon)
    return min_x <= px <= max_x and min_y <= py <= max_y


def bbox_centroid(bbox):
    """Get center point of a detection bbox [x1, y1, x2, y2]."""
    return (bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2


def centroid_miss_distance(cx, cy, polygon):
    """Calculate how far a centroid misses a polygon boundary.
    Returns (dx, dy) where negative means inside, positive means outside."""
    min_x, min_y, max_x, max_y = polygon_bounds(polygon)
    dx = max(min_x - cx, cx - max_x, 0)
    dy = max(min_y - cy, cy - max_y, 0)
    return dx, dy


def expand_polygon(polygon, padding):
    """Expand a polygon outward by padding amount (in normalized 0-1 coords).
    Works by shifting each edge outward from the centroid."""
    if len(polygon) < 3:
        return polygon

    # Find centroid of polygon
    cx = sum(p[0] for p in polygon) / len(polygon)
    cy = sum(p[1] for p in polygon) / len(polygon)

    expanded = []
    for px, py in polygon:
        # Direction from centroid to point
        dx = px - cx
        dy = py - cy
        dist = (dx ** 2 + dy ** 2) ** 0.5
        if dist > 0:
            # Move point outward by padding
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
    """Analyze all zones on a camera for centroid gaps.

    Returns list of findings, each with:
    - zone_id, camera info
    - detected centroids that miss the zone
    - recommended polygon fix
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
                cx, cy = bbox_centroid(bbox)
                detections.append({
                    "bbox": bbox,
                    "cx": cx,
                    "cy": cy,
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

        # Classify each detection relative to this zone
        centroids_inside = []
        centroids_overlapping_but_outside = []
        centroids_near = []

        for det in detections:
            cx, cy = det["cx"], det["cy"]
            bbox = det["bbox"]

            # Is centroid inside zone?
            if point_in_polygon_approx(cx, cy, polygon):
                centroids_inside.append(det)
                continue

            # Does bbox overlap zone at all?
            bx1, by1, bx2, by2 = bbox
            overlap_x = max(0, min(bx2, max_x) - max(bx1, min_x))
            overlap_y = max(0, min(by2, max_y) - max(by1, min_y))
            bbox_area = (bx2 - bx1) * (by2 - by1)

            if overlap_x > 0 and overlap_y > 0 and bbox_area > 0:
                overlap_pct = (overlap_x * overlap_y) / bbox_area * 100
                if overlap_pct > 10:
                    dx, dy = centroid_miss_distance(cx, cy, polygon)
                    centroids_overlapping_but_outside.append({
                        **det,
                        "overlap_pct": round(overlap_pct, 1),
                        "miss_dx": round(dx, 4),
                        "miss_dy": round(dy, 4),
                    })
                    continue

            # Is centroid near zone? (within 5% of frame)
            dx, dy = centroid_miss_distance(cx, cy, polygon)
            if dx < 0.05 and dy < 0.05:
                centroids_near.append({
                    **det,
                    "miss_dx": round(dx, 4),
                    "miss_dy": round(dy, 4),
                })

        has_violations = zid in violation_zone_ids

        # ── Finding: Centroid gap (the Z1 problem) ──
        if centroids_overlapping_but_outside and not has_violations:
            # Calculate exact fix: how much to expand polygon
            max_miss_dx = max(d["miss_dx"] for d in centroids_overlapping_but_outside)
            max_miss_dy = max(d["miss_dy"] for d in centroids_overlapping_but_outside)
            # Add 2% safety margin so future slight shifts don't break it again
            fix_padding = max(max_miss_dx, max_miss_dy) + 0.02

            fixed_polygon = expand_polygon(polygon, fix_padding)
            fixed_bounds = polygon_bounds(fixed_polygon)

            # Verify fix works — would the missed centroids now be inside?
            would_fix = sum(
                1 for d in centroids_overlapping_but_outside
                if point_in_polygon_approx(d["cx"], d["cy"], fixed_polygon)
            )

            findings.append({
                "severity": "error",
                "type": "centroid_gap",
                "camera_id": cid,
                "camera_name": cname,
                "zone_id": zid,
                "zone_type": zone.get("violation_type", "unknown"),
                "current_polygon": polygon,
                "recommended_polygon": fixed_polygon,
                "current_bounds": {
                    "x": [round(min_x, 4), round(max_x, 4)],
                    "y": [round(min_y, 4), round(max_y, 4)],
                },
                "recommended_bounds": {
                    "x": [round(fixed_bounds[0], 4), round(fixed_bounds[2], 4)],
                    "y": [round(fixed_bounds[1], 4), round(fixed_bounds[3], 4)],
                },
                "vehicles_affected": len(centroids_overlapping_but_outside),
                "max_miss": {
                    "dx": max_miss_dx,
                    "dy": max_miss_dy,
                    "pct": f"{max(max_miss_dx, max_miss_dy) * 100:.2f}%",
                },
                "fix_would_resolve": f"{would_fix}/{len(centroids_overlapping_but_outside)}",
                "fix_padding_applied": round(fix_padding, 4),
                "message": (
                    f"CENTROID GAP: Zone '{zid}' on '{cname}' — "
                    f"{len(centroids_overlapping_but_outside)} vehicles overlap this zone but "
                    f"their centroids miss by up to {max(max_miss_dx, max_miss_dy)*100:.2f}%. "
                    f"Zone boundary needs to expand by ~{fix_padding*100:.1f}% to capture them. "
                    f"Current Y range: [{min_y:.4f}-{max_y:.4f}], "
                    f"recommended: [{fixed_bounds[1]:.4f}-{fixed_bounds[3]:.4f}]."
                ),
            })

        # ── Finding: Zone working but near-misses detected ──
        elif has_violations and centroids_overlapping_but_outside:
            max_miss = max(
                max(d["miss_dx"], d["miss_dy"])
                for d in centroids_overlapping_but_outside
            )
            if max_miss < 0.01:  # Within 1% — dangerously close
                findings.append({
                    "severity": "warning",
                    "type": "boundary_tight",
                    "camera_id": cid,
                    "camera_name": cname,
                    "zone_id": zid,
                    "vehicles_at_risk": len(centroids_overlapping_but_outside),
                    "closest_miss_pct": f"{max_miss * 100:.2f}%",
                    "message": (
                        f"TIGHT BOUNDARY: Zone '{zid}' on '{cname}' is producing violations "
                        f"but {len(centroids_overlapping_but_outside)} vehicle centroids are "
                        f"within {max_miss*100:.2f}% of the zone boundary. A slight camera "
                        f"shift could cause them to fall outside. Consider expanding the zone."
                    ),
                })

        # ── Finding: Near-miss vehicles not caught ──
        elif centroids_near and not has_violations and not centroids_overlapping_but_outside:
            findings.append({
                "severity": "warning",
                "type": "near_miss",
                "camera_id": cid,
                "camera_name": cname,
                "zone_id": zid,
                "vehicles_near": len(centroids_near),
                "message": (
                    f"NEAR MISS: Zone '{zid}' on '{cname}' — "
                    f"{len(centroids_near)} vehicles detected near but not overlapping "
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
                    f"{zone_area*100:.2f}% of the frame. Small zones are fragile — "
                    f"minor camera movements can cause centroid misses."
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

    if finding["type"] == "centroid_gap":
        lines.append(f"  Vehicles affected: {finding['vehicles_affected']}")
        lines.append(f"  Max centroid miss: {finding['max_miss']['pct']}")
        lines.append(f"  Fix: expand polygon by {finding['fix_padding_applied']*100:.1f}%")
        cb = finding["current_bounds"]
        rb = finding["recommended_bounds"]
        lines.append(f"  Current Y: [{cb['y'][0]:.4f} - {cb['y'][1]:.4f}]")
        lines.append(f"  Fixed Y:   [{rb['y'][0]:.4f} - {rb['y'][1]:.4f}]")

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
    """Scan all active cameras for zone centroid gaps.

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

            if f["type"] == "centroid_gap" and auto_fix:
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
            "centroid_gaps": sum(1 for f in all_findings if f["type"] == "centroid_gap"),
            "boundary_tight": sum(1 for f in all_findings if f["type"] == "boundary_tight"),
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
    print(f"  Centroid gaps: {result['summary']['centroid_gaps']}")
    print(f"  Tight boundaries: {result['summary']['boundary_tight']}")
    print(f"  Near misses: {result['summary']['near_misses']}")
    if auto_fix:
        print(f"  Fixes applied: {fixes_applied}")
    print(f"{'='*60}")

    for f in all_findings:
        icon = {"error": "X", "warning": "!"}.get(f["severity"], "?")
        print(f"  [{icon}] {f['message']}")

    if not all_findings:
        print("  All zones healthy — no centroid gaps detected")

    print()

    # Alert on errors
    if errors:
        alert_body = "\n\n".join(format_finding_alert(f) for f in errors)
        send_alert(config, f"Zone Guardian: {len(errors)} centroid gap(s) detected", alert_body)

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
                        help="Automatically fix centroid gaps by expanding zone polygons")
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
