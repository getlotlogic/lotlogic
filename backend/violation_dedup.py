"""
Violation Dedup System — Zone State Machine

Each zone has a state: CLEAR → ALERTED → ACKNOWLEDGED → CLEAR
The camera is the source of truth. The zone only re-arms when the camera
shows the zone is empty. Operator replies are acknowledgments only.

State machine:
  CLEAR  ──car detected──▶  ALERTED  ──zone empty──▶  CLEAR
                               │                        ▲
                               │                        │
                          operator acks            (auto re-arm)
                               │                        │
                               ▼                        │
                           ACKNOWLEDGED  ──zone empty──▶  CLEAR

Key rules:
  - No duplicate SMS while alerted or acknowledged
  - Zone ONLY re-arms on empty snapshot
  - One 30-min reminder if still alerted (not acknowledged)
"""

import os
import logging
from datetime import datetime, timezone
from supabase import create_client, Client

logger = logging.getLogger(__name__)

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://nzdkoouoaedbbccraoti.supabase.co")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

# SMS templates
SMS_INITIAL_TEMPLATE = (
    "🚨 VIOLATION — {violation_type}\n"
    "📍 {zone_name} at {lot_name}\n"
    "📸 {snapshot_url}\n"
    "🗺️ {map_url}\n"
    "⏰ {detected_at}\n"
    "\n"
    "Reply DONE to acknowledge."
)

SMS_REMINDER_TEMPLATE = (
    "⏰ REMINDER — {violation_type} still active\n"
    "📍 {zone_name} at {lot_name}\n"
    "📸 {snapshot_url}\n"
    "First detected: {detected_at} (30 min ago)\n"
    "\n"
    "Reply DONE to acknowledge."
)

# Accepted operator acknowledgment replies
ACK_KEYWORDS = {"DONE", "OK", "COMPLETE", "TOWED", "GOT IT", "ON IT"}

# Reminder delay in seconds (30 minutes)
REMINDER_DELAY_SECONDS = 1800


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
# SMS sending (Twilio integration point)
# ---------------------------------------------------------------------------

async def send_violation_sms(
    operator_phone: str,
    zone_name: str,
    lot_name: str,
    violation_type: str,
    snapshot_url: str,
    map_url: str,
    detected_at: str,
    violation_id: str,
):
    """Send initial violation alert SMS to the tow operator."""
    body = SMS_INITIAL_TEMPLATE.format(
        violation_type=violation_type or "unauthorized",
        zone_name=zone_name or "Unknown zone",
        lot_name=lot_name or "Unknown lot",
        snapshot_url=snapshot_url or "",
        map_url=map_url or "",
        detected_at=detected_at or "",
    )
    await _send_sms(operator_phone, body)
    logger.info("Sent violation SMS for %s to %s", violation_id, operator_phone)


async def send_reminder_sms(
    operator_phone: str,
    zone_name: str,
    lot_name: str,
    violation_type: str,
    snapshot_url: str,
    detected_at: str,
    violation_id: str,
):
    """Send 30-minute reminder SMS if operator hasn't acknowledged."""
    body = SMS_REMINDER_TEMPLATE.format(
        violation_type=violation_type or "unauthorized",
        zone_name=zone_name or "Unknown zone",
        lot_name=lot_name or "Unknown lot",
        snapshot_url=snapshot_url or "",
        detected_at=detected_at or "",
    )
    await _send_sms(operator_phone, body)
    logger.info("Sent reminder SMS for %s to %s", violation_id, operator_phone)


async def _send_sms(to: str, body: str):
    """
    Send SMS via Twilio.
    Requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER env vars.
    """
    account_sid = os.environ.get("TWILIO_ACCOUNT_SID")
    auth_token = os.environ.get("TWILIO_AUTH_TOKEN")
    from_number = os.environ.get("TWILIO_FROM_NUMBER")

    if not all([account_sid, auth_token, from_number]):
        logger.warning("Twilio credentials not configured — SMS not sent")
        return

    try:
        from twilio.rest import Client as TwilioClient
        client = TwilioClient(account_sid, auth_token)
        client.messages.create(body=body, from_=from_number, to=to)
    except Exception as e:
        logger.error("Failed to send SMS to %s: %s", to, e)


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
):
    """
    Main dedup entry point. Called every ~10s when a new snapshot arrives.

    If has_car is True and no active violation exists → create one, send SMS.
    If has_car is True and active violation exists → check for 30-min reminder.
    If has_car is False and active violation exists → clear it, re-arm zone.
    """
    sb = _get_supabase()

    # Check for active (non-cleared) violation on this zone
    active_resp = (
        sb.table("violations")
        .select("id, status, detected_at, sms_sent_at, reminder_sent_at")
        .eq("zone_id", zone_id)
        .in_("status", ["alerted", "acknowledged"])
        .limit(1)
        .execute()
    )
    active = active_resp.data

    if has_car:
        if active:
            # Car still there — check if 30-min reminder is needed
            violation = active[0]
            if (
                violation["status"] == "alerted"
                and violation.get("reminder_sent_at") is None
                and violation.get("sms_sent_at")
                and _seconds_since(violation["sms_sent_at"]) >= REMINDER_DELAY_SECONDS
            ):
                # Send ONE reminder
                if operator_phone:
                    await send_reminder_sms(
                        operator_phone=operator_phone,
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

        try:
            result = sb.table("violations").insert(insert_data).execute()
        except Exception as e:
            # Unique index violation → another processor already created one
            if "idx_one_active_violation_per_zone" in str(e):
                logger.warning("Dedup race caught by index for zone %s", zone_id)
                return {"action": "dedup_race", "zone_id": zone_id}
            raise

        violation_id = result.data[0]["id"]

        # Send SMS to tow operator
        if operator_phone:
            await send_violation_sms(
                operator_phone=operator_phone,
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
        # ZONE IS EMPTY — this is the ONLY way to re-arm
        if active:
            violation = active[0]
            duration = int(_seconds_since(violation["detected_at"]))
            now_ts = _now()
            sb.table("violations").update(
                {
                    "status": "cleared",
                    "cleared_at": now_ts,
                    "duration_seconds": duration,
                }
            ).eq("id", violation["id"]).execute()
            logger.info(
                "Violation %s cleared (zone %s empty after %ds)",
                violation["id"], zone_id, duration,
            )
            return {"action": "cleared", "violation_id": violation["id"], "duration": duration}

        # No active violation, zone already clear
        return {"action": "idle", "zone_id": zone_id}


# ---------------------------------------------------------------------------
# Operator acknowledgment — dashboard button
# ---------------------------------------------------------------------------

async def acknowledge_violation(violation_id: str, source: str = "dashboard"):
    """
    Operator says DONE — stops reminders but does NOT re-arm the zone.
    The zone only re-arms when the camera shows it's empty.

    Args:
        violation_id: UUID of the violation to acknowledge
        source: 'dashboard' or 'sms_reply'

    Returns:
        dict with status result
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
        # Already acknowledged, cleared, or doesn't exist
        return {"status": "no_change", "violation_id": violation_id}


# ---------------------------------------------------------------------------
# SMS reply webhook — Twilio POST /webhooks/sms-reply
# ---------------------------------------------------------------------------

async def handle_sms_reply(body: str, from_phone: str):
    """
    Handle operator SMS replies like 'DONE', 'OK', 'TOWED'.
    Acknowledges ALL active violations for the operator.

    Args:
        body: SMS message body
        from_phone: Sender phone number (E.164 format)

    Returns:
        dict with count of acknowledged violations
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

    # Acknowledge ALL active violations for this operator
    active_resp = (
        sb.table("violations")
        .select("id")
        .eq("operator_id", operator["id"])
        .eq("status", "alerted")
        .execute()
    )

    now_ts = _now()
    count = 0
    for v in active_resp.data:
        sb.table("violations").update(
            {
                "status": "acknowledged",
                "acknowledged_at": now_ts,
                "acknowledged_by": "sms_reply",
            }
        ).eq("id", v["id"]).execute()
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
# FastAPI route handlers (integrate into existing backend)
# ---------------------------------------------------------------------------

def register_routes(app):
    """
    Register violation dedup API routes on an existing FastAPI app.

    Usage in your main backend:
        from violation_dedup import register_routes
        register_routes(app)
    """
    from fastapi import FastAPI, Request
    from fastapi.responses import JSONResponse

    @app.post("/violations/{violation_id}/acknowledge")
    async def api_acknowledge(violation_id: str):
        """Operator acknowledges a violation from the dashboard."""
        result = await acknowledge_violation(violation_id, source="dashboard")
        return JSONResponse(content=result)

    @app.post("/webhooks/sms-reply")
    async def api_sms_reply(request: Request):
        """
        Twilio SMS webhook. Twilio sends form-encoded data with
        Body (message text) and From (sender phone).
        """
        form = await request.form()
        body = form.get("Body", "")
        from_phone = form.get("From", "")
        result = await handle_sms_reply(body, from_phone)
        # Return TwiML empty response (no auto-reply)
        return JSONResponse(
            content=result,
            headers={"Content-Type": "application/json"},
        )

    logger.info("Violation dedup routes registered")
