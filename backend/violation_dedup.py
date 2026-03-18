"""
Violation Dedup System — Zone State Machine

Violations require manual operator resolution. The system never auto-clears.

State machine:
  CLEAR  ──car detected──▶  ALERTED  ──operator acks──▶  ACKNOWLEDGED
                                                              │
                                                     operator resolves
                                                       (boot/tow/dismiss)
                                                              │
                                                              ▼
                                                          RESOLVED
                                                              │
                                                         zone re-arms
                                                      (dedup query finds
                                                       no active violation)

Key rules:
  - No duplicate SMS while alerted or acknowledged
  - Violations persist until operator manually resolves
  - Zone re-arms only after operator closes the violation
  - One 30-min reminder if still alerted (not acknowledged)

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
):
    """
    Main dedup entry point. Called every ~10s when a new snapshot arrives.

    If has_car is True and no active violation exists → create one, send text.
    If has_car is True and active violation exists → check for 30-min reminder.
    If has_car is False and active violation exists → do nothing (require manual resolution).
    If has_car is False and no active violation → idle (zone is clear).
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
        # Zone appears empty — but violations require manual operator resolution.
        # Do NOT auto-clear. The violation stays alerted/acknowledged until the
        # operator handles it via dashboard or SMS reply.
        if active:
            violation = active[0]
            logger.debug(
                "Zone %s appears empty but violation %s still active (status=%s) — awaiting operator",
                zone_id, violation["id"], violation["status"],
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
