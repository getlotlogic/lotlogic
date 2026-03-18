"""
Violation Dedup System — Zone State Machine

State machine:
  CLEAR  ──car detected──▶  ALERTED  ──operator acks──▶  ACKNOWLEDGED
                               │                              │
                          3 empty snaps                  operator resolves
                               │                          (boot/tow/dismiss)
                               ▼                              │
                           DEPARTED                           ▼
                          (zone re-arms)                  RESOLVED
                                                         (zone re-arms)

Key rules:
  - No duplicate SMS while alerted or acknowledged
  - Zone re-arms after 3 consecutive empty snapshots (car departed)
  - Departed violations are terminal — no operator action needed
  - Operator can still resolve before departure (boot/tow/dismiss)
  - One 30-min reminder if still alerted (not acknowledged)

Accuracy rules:
  - Confirmation snapshots: car must be detected in 2+ consecutive snapshots
    before a violation is created (prevents single-frame false positives)
  - Minimum confidence threshold: detections below MIN_CONFIDENCE are ignored
  - Cross-zone plate dedup: if same plate already has an active violation on
    the same lot, don't create a duplicate in another zone
  - Confidence, plate, and vehicle data are stored on violation records

SMS Provider:
  Set NOTIFY_SMS_PROVIDER env var to swap providers without code changes:
    "twilio"  — Twilio (default, existing)
    "telnyx"  — Telnyx v2 API
    "vonage"  — Vonage/Nexmo
    "log"     — Stdout only (dev/testing)
  Set NOTIFY_CHANNELS="in_app,sms" to enable SMS alongside in-app.
"""

import os
import logging
from datetime import datetime, timedelta, timezone
from supabase import create_client, Client

from notifications import notify_violation, notify_reminder

logger = logging.getLogger(__name__)

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://nzdkoouoaedbbccraoti.supabase.co")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

# Accepted operator acknowledgment replies (SMS inbound)
ACK_KEYWORDS = {"DONE", "OK", "COMPLETE", "TOWED", "GOT IT", "ON IT"}

# Reminder delay in seconds (30 minutes)
REMINDER_DELAY_SECONDS = 1800

# Consecutive empty snapshots before a violation is marked 'departed'
EMPTY_STREAK_THRESHOLD = 3

# Cooldown after operator resolves — don't re-fire on same zone for this many seconds.
# Prevents "resolved → next snapshot → new violation" loop when car is still being towed.
RESOLVED_COOLDOWN_SECONDS = 300  # 5 minutes

# Minimum YOLO confidence to accept a detection. Below this, the snapshot is
# treated as "no car detected" to avoid false positives from shadows/reflections.
MIN_CONFIDENCE = float(os.environ.get("MIN_DETECTION_CONFIDENCE", "0.35"))

# Consecutive confirmed snapshots required before creating a violation.
# Prevents single-frame false positives (e.g., a shadow or passing car).
CONFIRMATION_SNAPSHOTS = int(os.environ.get("CONFIRMATION_SNAPSHOTS", "2"))

# In-memory confirmation tracker: zone_id → consecutive detection count.
# Reset to 0 when a snapshot has no car (or below confidence threshold).
_zone_confirmations: dict[str, int] = {}


def _get_supabase() -> Client:
    """Create a Supabase client using service key for backend operations."""
    if not SUPABASE_KEY:
        raise RuntimeError("SUPABASE_SERVICE_KEY not set")
    return create_client(SUPABASE_URL, SUPABASE_KEY)


def _now() -> str:
    """ISO-formatted UTC timestamp."""
    return datetime.now(timezone.utc).isoformat()


def _seconds_since(iso_ts: str) -> float:
    """Seconds elapsed since the given ISO timestamp."""
    then = datetime.fromisoformat(iso_ts.replace("Z", "+00:00"))
    return (datetime.now(timezone.utc) - then).total_seconds()


# ---------------------------------------------------------------------------
# Core detection pipeline — called every ~10s per snapshot
# ---------------------------------------------------------------------------

async def process_snapshot(
    camera_id: str,
    zone_id: str,
    lot_id: str,
    snapshot_url: str,
    has_car: bool,
    zone_name: str = "",
    lot_name: str = "",
    violation_type: str = "unauthorized",
    operator_id: str = None,
    operator_phone: str = None,
    map_url: str = "",
    confidence: float = None,
    plate_text: str = None,
    plate_confidence: float = None,
    vehicle_color: str = None,
    vehicle_type: str = None,
):
    """
    Main dedup entry point. Called every ~10s when a new snapshot arrives.

    If has_car is True and active violation exists → check for 30-min reminder.
    If has_car is True and no active violation → check cooldown, then create one + send text.
    If has_car is False and active violation → increment empty_streak (3 → departed).
    If has_car is False and no active violation → idle (zone is clear).

    Accuracy guards:
    - Detections below MIN_CONFIDENCE are treated as no-car.
    - Car must be confirmed in CONFIRMATION_SNAPSHOTS consecutive snapshots
      before a violation is created.
    - If plate_text matches an active violation on the same lot (different zone),
      the detection is treated as a duplicate and skipped.
    """
    sb = _get_supabase()

    # ── Confidence gate: reject low-confidence detections ──
    if has_car and confidence is not None and confidence < MIN_CONFIDENCE:
        logger.debug(
            "Zone %s detection rejected: confidence %.2f < threshold %.2f",
            zone_id, confidence, MIN_CONFIDENCE,
        )
        has_car = False  # treat as no detection

    # Check for active (non-cleared) violation on this zone
    active_resp = (
        sb.table("violations")
        .select("id, status, detected_at, sms_sent_at, reminder_sent_at, empty_streak")
        .eq("zone_id", zone_id)
        .in_("status", ["alerted", "acknowledged"])
        .limit(1)
        .execute()
    )
    active = active_resp.data

    if has_car:
        if active:
            # Car still there — reset empty streak and check for reminder
            violation = active[0]
            if (violation.get("empty_streak") or 0) > 0:
                sb.table("violations").update(
                    {"empty_streak": 0}
                ).eq("id", violation["id"]).execute()
            if (
                violation["status"] == "alerted"
                and violation.get("reminder_sent_at") is None
                and _seconds_since(violation.get("sms_sent_at") or violation["detected_at"]) >= REMINDER_DELAY_SECONDS
            ):
                # Send ONE reminder via notification channels
                await notify_reminder(
                    operator_phone=operator_phone or "",
                    zone_name=zone_name,
                    lot_name=lot_name,
                    violation_type=violation_type,
                    snapshot_url=snapshot_url,
                    detected_at=violation["detected_at"],
                    violation_id=violation["id"],
                )
                sb.table("violations").update(
                    {"reminder_sent_at": _now()}
                ).eq("id", violation["id"]).execute()
                logger.info("30-min reminder sent for violation %s", violation["id"])
            # Otherwise: do nothing. Zone is locked to this violation event.
            return {"action": "existing", "violation_id": violation["id"]}

        # Cooldown check: don't re-fire if a violation on this zone was
        # recently resolved or departed. Prevents the "operator boots car →
        # 30 seconds later → new violation for same car" loop.
        cooldown_resp = (
            sb.table("violations")
            .select("id, status, resolved_at, departed_at")
            .eq("zone_id", zone_id)
            .in_("status", ["resolved", "departed", "cleared"])
            .order("resolved_at", desc=True)  # most recent first
            .limit(1)
            .execute()
        )
        if cooldown_resp.data:
            prev = cooldown_resp.data[0]
            closed_at = prev.get("resolved_at") or prev.get("departed_at") or prev.get("cleared_at")
            if closed_at and _seconds_since(closed_at) < RESOLVED_COOLDOWN_SECONDS:
                logger.info(
                    "Zone %s in cooldown (violation %s %s %ds ago) — skipping new violation",
                    zone_id, prev["id"], prev["status"],
                    int(_seconds_since(closed_at)),
                )
                return {"action": "cooldown", "zone_id": zone_id, "previous_id": prev["id"]}

        # ── Confirmation gate: require consecutive detections ──
        # Prevents single-frame false positives (shadows, passing cars, YOLO glitches).
        _zone_confirmations[zone_id] = _zone_confirmations.get(zone_id, 0) + 1
        if _zone_confirmations[zone_id] < CONFIRMATION_SNAPSHOTS:
            logger.info(
                "Zone %s confirmation %d/%d — waiting for more snapshots before creating violation",
                zone_id, _zone_confirmations[zone_id], CONFIRMATION_SNAPSHOTS,
            )
            return {"action": "confirming", "zone_id": zone_id, "count": _zone_confirmations[zone_id]}

        # ── Cross-zone plate dedup ──
        # If same plate already has an active violation on this lot (any zone),
        # don't create a duplicate. This handles cars detected across zone boundaries.
        if plate_text and plate_text.strip():
            plate_dup_resp = (
                sb.table("violations")
                .select("id, zone_id")
                .eq("lot_id", lot_id)
                .eq("plate_text", plate_text.strip().upper())
                .in_("status", ["alerted", "acknowledged"])
                .limit(1)
                .execute()
            )
            if plate_dup_resp.data:
                existing = plate_dup_resp.data[0]
                logger.info(
                    "Zone %s plate %s already has active violation %s in zone %s — skipping duplicate",
                    zone_id, plate_text, existing["id"], existing["zone_id"],
                )
                _zone_confirmations.pop(zone_id, None)
                return {"action": "plate_dedup", "zone_id": zone_id, "existing_id": existing["id"]}

        # Confirmation met — reset counter
        _zone_confirmations.pop(zone_id, None)

        # NEW violation: car detected, no active violation on this zone
        now_ts = _now()
        insert_data = {
            "zone_id": zone_id,
            "camera_id": camera_id,
            "lot_id": lot_id,
            "snapshot_url": snapshot_url,
            "violation_type": violation_type,
            "status": "alerted",
            "detected_at": now_ts,
            "sms_sent_at": now_ts,
        }
        if operator_id:
            insert_data["operator_id"] = operator_id
        if confidence is not None:
            insert_data["confidence"] = round(confidence, 4)
        if plate_text and plate_text.strip():
            insert_data["plate_text"] = plate_text.strip().upper()
        if plate_confidence is not None:
            insert_data["plate_confidence"] = round(plate_confidence, 4)
        if vehicle_color:
            insert_data["vehicle_color"] = vehicle_color
        if vehicle_type:
            insert_data["vehicle_type"] = vehicle_type

        try:
            result = sb.table("violations").insert(insert_data).execute()
        except Exception as e:
            # Unique index violation → another processor already created one
            if "idx_one_active_violation_per_zone" in str(e):
                logger.warning("Dedup race caught by index for zone %s", zone_id)
                return {"action": "dedup_race", "zone_id": zone_id}
            raise

        violation_id = result.data[0]["id"]

        # Send alert via all configured notification channels
        await notify_violation(
            operator_phone=operator_phone or "",
            zone_name=zone_name,
            lot_name=lot_name,
            violation_type=violation_type,
            snapshot_url=snapshot_url,
            map_url=map_url,
            detected_at=now_ts,
            violation_id=violation_id,
        )

        logger.info("New violation %s created for zone %s", violation_id, zone_id)
        return {"action": "created", "violation_id": violation_id}

    else:
        # No car — reset confirmation counter for this zone
        _zone_confirmations.pop(zone_id, None)

        # Zone appears empty — increment empty streak on active violation.
        # After EMPTY_STREAK_THRESHOLD consecutive empty snapshots, mark
        # the violation as 'departed' and unlock the zone for new detections.
        if active:
            violation = active[0]
            new_streak = (violation.get("empty_streak") or 0) + 1

            if new_streak >= EMPTY_STREAK_THRESHOLD:
                # Car is gone — mark departed, unlock zone
                sb.table("violations").update(
                    {
                        "status": "departed",
                        "departed_at": _now(),
                        "empty_streak": new_streak,
                    }
                ).eq("id", violation["id"]).execute()
                logger.info(
                    "Violation %s departed after %d empty snapshots — zone %s re-armed",
                    violation["id"], new_streak, zone_id,
                )
                return {"action": "departed", "violation_id": violation["id"]}
            else:
                # Not enough consecutive empties yet — just bump the counter
                sb.table("violations").update(
                    {"empty_streak": new_streak}
                ).eq("id", violation["id"]).execute()
                logger.debug(
                    "Zone %s empty streak %d/%d for violation %s",
                    zone_id, new_streak, EMPTY_STREAK_THRESHOLD, violation["id"],
                )
                return {"action": "existing", "violation_id": violation["id"]}

        # No active violation, zone is clear — nothing to do
        return {"action": "idle", "zone_id": zone_id}


# ---------------------------------------------------------------------------
# Operator acknowledgment — dashboard button
# ---------------------------------------------------------------------------

async def acknowledge_violation(violation_id: str, source: str = "dashboard"):
    """
    Operator says DONE — stops reminders. Zone re-arms when the operator
    later resolves the violation (boot/tow/dismiss) from the dashboard.
    """
    sb = _get_supabase()
    now_ts = _now()

    result = (
        sb.table("violations")
        .update(
            {
                "status": "acknowledged",
                "acknowledged_at": now_ts,
                "acknowledged_by": source,
            }
        )
        .eq("id", violation_id)
        .eq("status", "alerted")  # Only acknowledge if currently alerted
        .execute()
    )

    if result.data:
        logger.info("Violation %s acknowledged via %s", violation_id, source)
        return {"status": "acknowledged", "violation_id": violation_id}
    else:
        return {"status": "no_change", "violation_id": violation_id}


# ---------------------------------------------------------------------------
# Inbound SMS webhook — provider-agnostic
# ---------------------------------------------------------------------------

async def handle_sms_reply(body: str, from_phone: str):
    """
    Handle operator SMS replies like 'DONE', 'OK', 'TOWED'.
    Acknowledges ALL active violations for the operator matching by phone.

    Works with any SMS provider — the webhook just needs to extract
    the message body and sender phone from the provider's POST payload.
    """
    keyword = body.strip().upper()
    if keyword not in ACK_KEYWORDS:
        logger.debug("Ignoring unrecognized SMS reply: %s", body)
        return {"status": "ignored", "reason": "unrecognized_keyword"}

    sb = _get_supabase()

    # Look up operator by phone number
    operator = _get_operator_by_phone(sb, from_phone)
    if not operator:
        logger.warning("SMS reply from unknown phone: %s", from_phone)
        return {"status": "ignored", "reason": "unknown_phone"}

    # Find lots assigned to this partner
    lots_resp = (
        sb.table("lots")
        .select("id")
        .eq("partner_id", operator["id"])
        .execute()
    )
    lot_ids = [l["id"] for l in lots_resp.data] if lots_resp.data else []

    # Acknowledge active violations: match by operator_id OR by lot ownership
    now_ts = _now()
    viol_ids = set()

    # By operator_id
    by_operator = (
        sb.table("violations")
        .select("id")
        .eq("operator_id", operator["id"])
        .eq("status", "alerted")
        .execute()
    )
    viol_ids.update(v["id"] for v in by_operator.data)

    # By lot ownership (operator_id may be null on older violations)
    for lid in lot_ids:
        by_lot = (
            sb.table("violations")
            .select("id")
            .eq("lot_id", lid)
            .eq("status", "alerted")
            .execute()
        )
        viol_ids.update(v["id"] for v in by_lot.data)

    count = 0
    for vid in viol_ids:
        sb.table("violations").update(
            {
                "status": "acknowledged",
                "acknowledged_at": now_ts,
                "acknowledged_by": "sms_reply",
            }
        ).eq("id", vid).execute()
        count += 1

    logger.info("SMS reply from %s acknowledged %d violations", from_phone, count)
    return {"status": "acknowledged", "count": count}


def _get_operator_by_phone(sb: Client, phone: str):
    """Look up a partner/operator by phone number."""
    result = (
        sb.table("partners")
        .select("id, name, phone")
        .eq("phone", phone)
        .limit(1)
        .execute()
    )
    return result.data[0] if result.data else None


# ---------------------------------------------------------------------------
# Standalone reminder job — run on a schedule (cron, Railway cron, etc.)
# ---------------------------------------------------------------------------

async def run_reminders():
    """
    Query violations where status='alerted' AND reminder_sent_at IS NULL
    AND detected_at older than 30 minutes. Send reminder, set reminder_sent_at.

    Call this from a scheduler (cron job, Railway cron, or background task).
    Returns count of reminders sent.
    """
    sb = _get_supabase()
    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=REMINDER_DELAY_SECONDS)).isoformat()

    resp = (
        sb.table("violations")
        .select("id, zone_id, lot_id, operator_id, violation_type, snapshot_url, detected_at")
        .eq("status", "alerted")
        .is_("reminder_sent_at", "null")
        .lt("detected_at", cutoff)
        .limit(100)
        .execute()
    )

    if not resp.data:
        logger.debug("run_reminders: no violations need reminders")
        return 0

    count = 0
    for v in resp.data:
        phone, zone_name, lot_name = _resolve_context(sb, v)

        await notify_reminder(
            operator_phone=phone or "",
            zone_name=zone_name or v.get("zone_id", "Unknown"),
            lot_name=lot_name,
            violation_type=v.get("violation_type", "unauthorized"),
            snapshot_url=v.get("snapshot_url", ""),
            detected_at=v.get("detected_at", ""),
            violation_id=v["id"],
        )

        # Mark reminder sent even if no phone (prevent retrying every cycle)
        sb.table("violations").update(
            {"reminder_sent_at": _now()}
        ).eq("id", v["id"]).execute()
        count += 1
        logger.info("Reminder sent for violation %s (phone=%s)", v["id"], phone or "none")

    logger.info("run_reminders: sent %d reminders", count)
    return count


def _resolve_context(sb: Client, violation: dict) -> tuple:
    """Resolve operator phone, zone_name, lot_name from a violation row."""
    phone = None
    zone_name = ""
    lot_name = ""

    # Operator phone: try operator_id first, then lot→partner chain
    if violation.get("operator_id"):
        op = sb.table("partners").select("phone").eq("id", violation["operator_id"]).limit(1).execute()
        if op.data:
            phone = op.data[0].get("phone")

    if violation.get("lot_id"):
        lot = sb.table("lots").select("name, partner_id").eq("id", violation["lot_id"]).limit(1).execute()
        if lot.data:
            lot_name = lot.data[0].get("name", "")
            if not phone:
                pid = lot.data[0].get("partner_id")
                if pid:
                    partner = sb.table("partners").select("phone").eq("id", pid).limit(1).execute()
                    if partner.data:
                        phone = partner.data[0].get("phone")

    # Zone name from camera zones JSONB
    if violation.get("zone_id") and violation.get("lot_id"):
        cam = sb.table("cameras").select("zones").eq("lot_id", violation["lot_id"]).limit(1).execute()
        if cam.data and cam.data[0].get("zones"):
            for z in cam.data[0]["zones"]:
                zid = z.get("zone_id") or z.get("id")
                if zid == violation["zone_id"]:
                    zone_name = z.get("label") or z.get("name") or zid
                    break

    return phone, zone_name, lot_name


# ---------------------------------------------------------------------------
# FastAPI route handlers (integrate into existing backend)
# ---------------------------------------------------------------------------

def register_routes(app):
    """
    Register violation dedup API routes on an existing FastAPI app.

    Usage in your main backend:
        from violation_dedup import register_routes
        register_routes(app)
    """
    from fastapi import Request
    from fastapi.responses import JSONResponse

    @app.post("/violations/{violation_id}/acknowledge")
    async def api_acknowledge(violation_id: str):
        """Operator acknowledges a violation from the dashboard."""
        result = await acknowledge_violation(violation_id, source="dashboard")
        return JSONResponse(content=result)

    @app.post("/webhooks/sms-reply")
    async def api_sms_reply(request: Request):
        """
        Inbound SMS webhook. Works with any provider — just extracts
        message body and sender phone from the POST payload.

        Twilio sends:  Body=..., From=...
        Telnyx sends:  data.payload.text, data.payload.from.phone_number
        Vonage sends:  text=..., msisdn=...
        """
        content_type = request.headers.get("content-type", "")

        if "json" in content_type:
            # Telnyx / generic JSON webhooks
            data = await request.json()
            # Telnyx v2 format
            if "data" in data and "payload" in data.get("data", {}):
                payload = data["data"]["payload"]
                body_text = payload.get("text", "")
                from_ph = payload.get("from", {}).get("phone_number", "")
            # Vonage format
            elif "text" in data:
                body_text = data.get("text", "")
                from_ph = "+" + data.get("msisdn", "")
            else:
                body_text = data.get("Body", data.get("body", ""))
                from_ph = data.get("From", data.get("from", ""))
        else:
            # Twilio form-encoded
            form = await request.form()
            body_text = form.get("Body", "")
            from_ph = form.get("From", "")

        result = await handle_sms_reply(body_text, from_ph)
        return JSONResponse(content=result)

    @app.post("/reminders/run")
    async def api_run_reminders():
        """Trigger reminder check manually or via cron."""
        count = await run_reminders()
        return JSONResponse(content={"reminders_sent": count})

    logger.info("Violation dedup routes registered")
