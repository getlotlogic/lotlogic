"""
Violation Dedup System — Zone State Machine

State machine:
  CLEAR  ──car confirmed──▶  ALERTED  ──operator acks──▶  ACKNOWLEDGED
                                │                              │
                          sliding window                  operator resolves
                          says car gone                   (boot/tow/dismiss)
                          OR plate swap                        │
                                │                              ▼
                                ▼                          RESOLVED
                            DEPARTED                    (zone re-arms)
                          (zone re-arms)

Key rules:
  - No duplicate SMS while alerted or acknowledged
  - Departed violations are terminal — no operator action needed
  - Operator can still resolve before departure (boot/tow/dismiss)
  - One 30-min reminder if still alerted (not acknowledged)

Inference pipeline (rock-solid detection):

  1. Confidence-weighted presence scoring:
     - Each snapshot contributes a score, not a binary True/False
     - High-confidence detection (0.90) = strong presence signal
     - Low-confidence detection (0.36) = weak signal, barely above noise
     - No detection = 0.0 (absence signal)
     - Departure triggers when weighted presence drops below threshold

  2. Plate-based car swap detection:
     - If active violation has a plate and new detection shows a DIFFERENT plate,
       the original car left and a new one arrived
     - Auto-depart old violation → create new one for the new plate
     - Prevents "wrong car" violations where operator finds a different vehicle

  3. Sliding window departure (replaces brittle consecutive-empty-streak):
     - Tracks last N snapshots per zone with confidence weights
     - Car departs when weighted presence score < 0.2 (mostly empty)
       OR N consecutive empties (fast path, default 5)
     - Single YOLO miss or false positive doesn't reset departure progress

  4. Sliding window confirmation (arrival):
     - Car must be detected in M of last N snapshots (default 2 of 3)
     - One YOLO miss between two real detections doesn't reset confirmation
     - Prevents single-frame false positives from shadows/passing cars

Accuracy rules:
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

# ── Departure detection (sliding window with confidence weighting) ──
#
# Each snapshot stores a confidence score (0.0 = no car, 0.0-1.0 = detection
# confidence). The departure decision uses the WEIGHTED average of the window
# rather than a simple empty/non-empty ratio.
#
# Example: window = [0.0, 0.92, 0.0, 0.0, 0.0, 0.0]
#   Weighted presence = (0 + 0.92 + 0 + 0 + 0 + 0) / 6 = 0.153
#   0.153 < DEPARTURE_PRESENCE_THRESHOLD (0.2) → DEPARTED
#
# A single low-confidence detection (0.36) barely moves the needle:
#   window = [0.0, 0.36, 0.0, 0.0, 0.0, 0.0] → 0.06 → still departs
#
# But a real car consistently detected (0.85+) holds the zone:
#   window = [0.88, 0.0, 0.91, 0.87, 0.0, 0.90] → 0.59 → stays
#
# Consecutive streak is kept as a fast path for clear exits.
EMPTY_STREAK_THRESHOLD = int(os.environ.get("EMPTY_STREAK_THRESHOLD", "5"))

# Sliding window size: how many recent snapshots to consider for departure.
DEPARTURE_WINDOW_SIZE = int(os.environ.get("DEPARTURE_WINDOW_SIZE", "6"))

# Weighted presence threshold below which the car is considered gone.
# 0.2 means the average confidence across the window is very low.
DEPARTURE_PRESENCE_THRESHOLD = float(os.environ.get("DEPARTURE_PRESENCE_THRESHOLD", "0.20"))

# In-memory sliding window per zone: zone_id → list of floats (confidence scores).
# 0.0 = no detection, >0 = detection confidence. Capped at DEPARTURE_WINDOW_SIZE.
_zone_presence: dict[str, list[float]] = {}

# Cooldown after operator resolves — don't re-fire on same zone for this many seconds.
# Prevents "resolved → next snapshot → new violation" loop when car is still being towed.
RESOLVED_COOLDOWN_SECONDS = 300  # 5 minutes

# Shorter cooldown when plates aren't readable. If we can't identify the car,
# we can't tell if it's the same one or a new one. Use a shorter cooldown so
# we don't block new violations for 5 minutes on every zone cycle.
PLATELESS_COOLDOWN_SECONDS = int(os.environ.get("PLATELESS_COOLDOWN_SECONDS", "90"))

# Maximum time a violation can sit in 'alerted' without operator action before
# auto-clearing. Prevents zones from being permanently locked by ignored violations.
# Default: 4 hours. Set to 0 to disable.
STALE_VIOLATION_SECONDS = int(os.environ.get("STALE_VIOLATION_SECONDS", "14400"))

# Maximum time a violation can sit in 'acknowledged' without resolution.
# Operator acknowledged but never booted/towed. Default: 8 hours.
STALE_ACKNOWLEDGED_SECONDS = int(os.environ.get("STALE_ACKNOWLEDGED_SECONDS", "28800"))

# Minimum YOLO confidence to accept a detection. Below this, the snapshot is
# treated as "no car detected" to avoid false positives from shadows/reflections.
MIN_CONFIDENCE = float(os.environ.get("MIN_DETECTION_CONFIDENCE", "0.35"))

# ── Arrival confirmation (sliding window) ──
# Car must be detected in CONFIRMATION_REQUIRED of the last CONFIRMATION_WINDOW
# snapshots. This is more robust than strict consecutive detections — one YOLO
# miss between two real detections doesn't reset confirmation.
#
# Default: 2 detections in last 3 snapshots.
CONFIRMATION_REQUIRED = int(os.environ.get("CONFIRMATION_REQUIRED", "2"))
CONFIRMATION_WINDOW = int(os.environ.get("CONFIRMATION_WINDOW", "3"))

# In-memory confirmation tracker: zone_id → list of bools (recent detection results).
# Capped at CONFIRMATION_WINDOW entries.
_zone_confirmations: dict[str, list[bool]] = {}


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
    Main dedup entry point. Called every ~10-30s when a new snapshot arrives.

    Inference pipeline:
    1. Confidence gate → reject noise, compute presence score
    2. Plate swap detection → auto-depart if a different car replaced the original
    3. Sliding window departure → weighted presence score, not brittle consecutive streak
    4. Sliding window confirmation → M of N detections, not strict consecutive
    """
    sb = _get_supabase()

    # ── Confidence gate: reject low-confidence, compute presence score ──
    # presence_score: 0.0 = no car, else the detection confidence (0.35–1.0).
    # When confidence is None (backend didn't send it), use a conservative default
    # of 0.5 — enough to register as a detection but not strong enough to single-
    # handedly hold a zone against departure. 0.75 was too high and made ghost
    # detections (no metadata) act like rock-solid confirmations.
    if has_car and confidence is not None and confidence < MIN_CONFIDENCE:
        logger.debug(
            "Zone %s detection rejected: confidence %.2f < threshold %.2f",
            zone_id, confidence, MIN_CONFIDENCE,
        )
        has_car = False
    presence_score = (confidence if confidence is not None else 0.5) if has_car else 0.0

    # Check for active (non-cleared) violation on this zone
    active_resp = (
        sb.table("violations")
        .select("id, status, detected_at, sms_sent_at, reminder_sent_at, empty_streak, plate_text")
        .eq("zone_id", zone_id)
        .in_("status", ["alerted", "acknowledged"])
        .limit(1)
        .execute()
    )
    active = active_resp.data

    # ── Stale violation auto-clear ──
    # If a violation has been sitting in 'alerted' or 'acknowledged' for too long
    # without operator action, auto-clear it so the zone can create new violations.
    # This is the #1 reason for "why aren't there more violations" — a single
    # ignored alert permanently locks a zone.
    if active:
        violation = active[0]
        age_seconds = _seconds_since(violation["detected_at"])
        stale_limit = (
            STALE_ACKNOWLEDGED_SECONDS if violation["status"] == "acknowledged"
            else STALE_VIOLATION_SECONDS
        )
        if stale_limit > 0 and age_seconds > stale_limit:
            sb.table("violations").update(
                {
                    "status": "departed",
                    "departed_at": _now(),
                    "empty_streak": violation.get("empty_streak") or 0,
                }
            ).eq("id", violation["id"]).execute()
            _zone_presence.pop(zone_id, None)
            _zone_confirmations.pop(zone_id, None)
            logger.warning(
                "Violation %s auto-cleared: %s for %.0f hours with no operator action — zone %s re-armed",
                violation["id"], violation["status"], age_seconds / 3600, zone_id,
            )
            active = []  # zone is now clear, fall through to create new if has_car

    # ── Update confidence-weighted sliding window ──
    # NOTE: we do NOT clear the window when creating a new violation. The window
    # should reflect the actual recent detection history for the zone, not reset
    # on violation lifecycle events. This allows faster departure detection after
    # short-lived violations.
    window = _zone_presence.setdefault(zone_id, [])
    window.append(presence_score)
    if len(window) > DEPARTURE_WINDOW_SIZE:
        window[:] = window[-DEPARTURE_WINDOW_SIZE:]

    if has_car:
        if active:
            violation = active[0]

            # ── Plate swap detection ──
            # If we have a plate for both the violation and the current detection,
            # and they're DIFFERENT, the original car left and a new one arrived.
            # Auto-depart the old violation so a new one can be created.
            normalized_plate = plate_text.strip().upper() if plate_text and plate_text.strip() else None
            violation_plate = violation.get("plate_text", "").strip().upper() if violation.get("plate_text") else None

            if (
                normalized_plate
                and violation_plate
                and normalized_plate != violation_plate
                # Require decent plate confidence to avoid OCR-flicker false swaps
                and (plate_confidence is None or plate_confidence >= 0.60)
            ):
                logger.info(
                    "Plate swap detected in zone %s: violation %s has plate %s, "
                    "new detection has plate %s (conf=%.2f) — auto-departing old violation",
                    zone_id, violation["id"], violation_plate, normalized_plate,
                    plate_confidence or 0.0,
                )
                sb.table("violations").update(
                    {
                        "status": "departed",
                        "departed_at": _now(),
                        "empty_streak": 0,
                    }
                ).eq("id", violation["id"]).execute()
                _zone_presence.pop(zone_id, None)
                _zone_confirmations.pop(zone_id, None)
                # Fall through to create a new violation for the new plate below
                active = []
            else:
                # Same car still there — reset empty streak and check for reminder
                update_fields = {}
                if (violation.get("empty_streak") or 0) > 0:
                    update_fields["empty_streak"] = 0
                if snapshot_url:
                    update_fields["snapshot_url"] = snapshot_url
                if update_fields:
                    sb.table("violations").update(update_fields).eq("id", violation["id"]).execute()
                if (
                    violation["status"] == "alerted"
                    and violation.get("reminder_sent_at") is None
                    and _seconds_since(violation.get("sms_sent_at") or violation["detected_at"]) >= REMINDER_DELAY_SECONDS
                ):
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
                return {"action": "existing", "violation_id": violation["id"]}

        # ── No active violation (or just auto-cleared/plate-swapped) ──

        # Cooldown check: don't re-fire if a violation on this zone was
        # recently resolved or departed.
        cooldown_resp = (
            sb.table("violations")
            .select("id, status, resolved_at, departed_at, plate_text")
            .eq("zone_id", zone_id)
            .in_("status", ["resolved", "departed", "cleared"])
            .order("resolved_at", desc=True)
            .limit(1)
            .execute()
        )
        if cooldown_resp.data:
            prev = cooldown_resp.data[0]
            closed_at = prev.get("resolved_at") or prev.get("departed_at") or prev.get("cleared_at")
            if closed_at:
                elapsed = _seconds_since(closed_at)
                prev_plate = prev.get("plate_text", "").strip().upper() if prev.get("plate_text") else None
                curr_plate = plate_text.strip().upper() if plate_text and plate_text.strip() else None

                if curr_plate and prev_plate and curr_plate != prev_plate:
                    # Different plate = different car → skip cooldown entirely
                    logger.info(
                        "Zone %s cooldown bypassed: new plate %s != previous %s",
                        zone_id, curr_plate, prev_plate,
                    )
                elif curr_plate and prev_plate and curr_plate == prev_plate:
                    # Same plate = same car still around → full cooldown
                    if elapsed < RESOLVED_COOLDOWN_SECONDS:
                        logger.info(
                            "Zone %s in cooldown (same plate %s, %ds ago) — skipping",
                            zone_id, curr_plate, int(elapsed),
                        )
                        return {"action": "cooldown", "zone_id": zone_id, "previous_id": prev["id"]}
                else:
                    # Can't read plates — use shorter cooldown so we don't block
                    # new violations for 5 minutes when we can't even tell if it's
                    # the same car. This was a major violation-killer: every plateless
                    # detection was blocked for the full 5-minute cooldown.
                    if elapsed < PLATELESS_COOLDOWN_SECONDS:
                        logger.info(
                            "Zone %s in plateless cooldown (%ds/%ds ago) — skipping",
                            zone_id, int(elapsed), PLATELESS_COOLDOWN_SECONDS,
                        )
                        return {"action": "cooldown", "zone_id": zone_id, "previous_id": prev["id"]}

        # ── Sliding window confirmation gate ──
        # Require CONFIRMATION_REQUIRED detections in last CONFIRMATION_WINDOW snapshots.
        conf_window = _zone_confirmations.setdefault(zone_id, [])
        conf_window.append(True)
        if len(conf_window) > CONFIRMATION_WINDOW:
            conf_window[:] = conf_window[-CONFIRMATION_WINDOW:]
        detection_count = sum(1 for v in conf_window if v)
        if detection_count < CONFIRMATION_REQUIRED:
            logger.info(
                "Zone %s confirmation %d/%d in last %d snapshots — waiting",
                zone_id, detection_count, CONFIRMATION_REQUIRED, len(conf_window),
            )
            return {"action": "confirming", "zone_id": zone_id, "count": detection_count}

        # ── Cross-zone plate dedup ──
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
                    "Zone %s plate %s already active on zone %s — skipping duplicate",
                    zone_id, plate_text, existing["zone_id"],
                )
                _zone_confirmations.pop(zone_id, None)
                return {"action": "plate_dedup", "zone_id": zone_id, "existing_id": existing["id"]}

        # Confirmation met — reset confirmation tracker only (NOT the presence window)
        _zone_confirmations.pop(zone_id, None)

        # ── Create new violation ──
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
            if "idx_one_active_violation_per_zone" in str(e):
                logger.warning("Dedup race caught by index for zone %s", zone_id)
                return {"action": "dedup_race", "zone_id": zone_id}
            raise

        violation_id = result.data[0]["id"]

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
        # No car — update confirmation window (for zones building toward confirmation)
        conf_window = _zone_confirmations.get(zone_id)
        if conf_window is not None:
            conf_window.append(False)
            if len(conf_window) > CONFIRMATION_WINDOW:
                conf_window[:] = conf_window[-CONFIRMATION_WINDOW:]
            if not any(conf_window):
                _zone_confirmations.pop(zone_id, None)

        # ── Departure decision: confidence-weighted sliding window ──
        # Uses BOTH consecutive streak AND weighted presence score.
        # Either condition triggers departure:
        #   1. Consecutive streak ≥ EMPTY_STREAK_THRESHOLD (fast path)
        #   2. Window with ≥4 entries and weighted presence below threshold
        #      (don't require full window — allows faster departure)
        if active:
            violation = active[0]
            new_streak = (violation.get("empty_streak") or 0) + 1

            window = _zone_presence.get(zone_id, [])
            weighted_presence = sum(window) / len(window) if window else 0.0
            # Allow window-based departure with ≥4 entries (not just when full at 6).
            # This means departure can trigger after ~2 minutes instead of ~3 minutes.
            window_ready = len(window) >= max(4, DEPARTURE_WINDOW_SIZE - 2)

            should_depart = (
                new_streak >= EMPTY_STREAK_THRESHOLD
                or (window_ready and weighted_presence < DEPARTURE_PRESENCE_THRESHOLD)
            )

            if should_depart:
                sb.table("violations").update(
                    {
                        "status": "departed",
                        "departed_at": _now(),
                        "empty_streak": new_streak,
                    }
                ).eq("id", violation["id"]).execute()
                _zone_presence.pop(zone_id, None)
                _zone_confirmations.pop(zone_id, None)
                logger.info(
                    "Violation %s departed (streak=%d, presence=%.2f, window=%d) — zone %s re-armed",
                    violation["id"], new_streak, weighted_presence, len(window), zone_id,
                )
                return {"action": "departed", "violation_id": violation["id"]}
            else:
                sb.table("violations").update(
                    {"empty_streak": new_streak}
                ).eq("id", violation["id"]).execute()
                logger.debug(
                    "Zone %s streak=%d/%d, presence=%.2f for violation %s",
                    zone_id, new_streak, EMPTY_STREAK_THRESHOLD,
                    weighted_presence, violation["id"],
                )
                return {"action": "existing", "violation_id": violation["id"]}

        # No active violation, zone is clear
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


async def clear_stale_violations():
    """
    Standalone stale violation cleanup — runs independently of process_snapshot.

    Catches violations that process_snapshot's inline stale check misses:
    - Zones that were renamed/deleted (orphaned zone_ids)
    - Cameras that went offline permanently
    - Pipeline outages that prevent process_snapshot from running

    Call this from a scheduler alongside run_reminders().
    """
    sb = _get_supabase()

    # Find all active violations older than their stale limit
    alerted_cutoff = datetime.now(timezone.utc) - timedelta(seconds=STALE_VIOLATION_SECONDS)
    ack_cutoff = datetime.now(timezone.utc) - timedelta(seconds=STALE_ACKNOWLEDGED_SECONDS)

    if STALE_VIOLATION_SECONDS <= 0 and STALE_ACKNOWLEDGED_SECONDS <= 0:
        return 0

    count = 0

    # Clear stale 'alerted' violations
    if STALE_VIOLATION_SECONDS > 0:
        stale_alerted = (
            sb.table("violations")
            .select("id, zone_id, detected_at")
            .eq("status", "alerted")
            .lt("detected_at", alerted_cutoff.isoformat())
            .limit(100)
            .execute()
        )
        for v in stale_alerted.data:
            sb.table("violations").update(
                {"status": "departed", "departed_at": _now()}
            ).eq("id", v["id"]).execute()
            _zone_presence.pop(v["zone_id"], None)
            _zone_confirmations.pop(v["zone_id"], None)
            count += 1
            logger.warning(
                "Stale cleanup: violation %s (zone %s) alerted since %s — auto-departed",
                v["id"], v["zone_id"], v["detected_at"],
            )

    # Clear stale 'acknowledged' violations
    if STALE_ACKNOWLEDGED_SECONDS > 0:
        stale_acked = (
            sb.table("violations")
            .select("id, zone_id, detected_at")
            .eq("status", "acknowledged")
            .lt("detected_at", ack_cutoff.isoformat())
            .limit(100)
            .execute()
        )
        for v in stale_acked.data:
            sb.table("violations").update(
                {"status": "departed", "departed_at": _now()}
            ).eq("id", v["id"]).execute()
            _zone_presence.pop(v["zone_id"], None)
            _zone_confirmations.pop(v["zone_id"], None)
            count += 1
            logger.warning(
                "Stale cleanup: violation %s (zone %s) acknowledged since %s — auto-departed",
                v["id"], v["zone_id"], v["detected_at"],
            )

    logger.info("clear_stale_violations: cleared %d stale violations", count)
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

    @app.post("/violations/clear-stale")
    async def api_clear_stale():
        """Clear stale violations that process_snapshot missed (orphaned zones, offline cameras)."""
        count = await clear_stale_violations()
        return JSONResponse(content={"cleared": count})

    logger.info("Violation dedup routes registered")
