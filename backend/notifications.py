"""
LotLogic Notification Channel Abstraction

Pluggable notification system. Configure via NOTIFY_CHANNELS env var:
  - "in_app"           (default) — Supabase insert only, frontend handles display
  - "in_app,sms"       — in-app + SMS via configured provider
  - "in_app,sms,push"  — all channels

SMS providers are pluggable via NOTIFY_SMS_PROVIDER env var:
  - "twilio"   — Twilio REST API
  - "telnyx"   — Telnyx v2 API
  - "vonage"   — Vonage (Nexmo) SMS API
  - "log"      — Log to stdout only (dev/testing)

Each channel implements send(to, message, context) where context carries
structured metadata (violation_id, zone_name, etc.) for rich notifications.
"""

import asyncio
import os
import logging
from abc import ABC, abstractmethod
from datetime import datetime, timezone

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Channel interface
# ---------------------------------------------------------------------------

class NotificationChannel(ABC):
    """Base class for notification channels."""

    @abstractmethod
    async def send(self, to: str, message: str, context: dict) -> bool:
        """
        Send a notification.

        Args:
            to: Recipient identifier (phone number, user ID, push token, etc.)
            message: Human-readable message body
            context: Structured metadata — violation_id, zone_name, lot_name,
                     violation_type, snapshot_url, map_url, detected_at, etc.

        Returns:
            True if sent successfully, False otherwise.
        """
        ...

    @abstractmethod
    def name(self) -> str:
        """Channel name for logging."""
        ...


# ---------------------------------------------------------------------------
# In-App channel — stores notification in Supabase for frontend to pick up
# ---------------------------------------------------------------------------

class InAppChannel(NotificationChannel):
    """
    In-app notifications via Supabase Realtime.

    The violation INSERT itself IS the notification — the frontend's Realtime
    subscription picks it up and fires browser Notification + audio chime.

    This channel is a no-op at send time because the violation row was already
    inserted by process_snapshot() before notify() is called. It exists to
    make the channel list explicit and to provide a hook for future in-app
    notification tables (e.g., a dedicated notifications table with read/unread).
    """

    async def send(self, to: str, message: str, context: dict) -> bool:
        vid = context.get("violation_id", "?")
        logger.debug("In-app notification for violation %s (delivered via Realtime)", vid)
        return True

    def name(self) -> str:
        return "in_app"


# ---------------------------------------------------------------------------
# SMS channels — pluggable providers
# ---------------------------------------------------------------------------

class TwilioSMSChannel(NotificationChannel):
    """SMS via Twilio."""

    def __init__(self):
        self.account_sid = os.environ.get("TWILIO_ACCOUNT_SID", "")
        self.auth_token = os.environ.get("TWILIO_AUTH_TOKEN", "")
        self.from_number = os.environ.get("TWILIO_FROM_NUMBER", "")

    async def send(self, to: str, message: str, context: dict) -> bool:
        if not all([self.account_sid, self.auth_token, self.from_number]):
            logger.warning("Twilio credentials not configured — SMS not sent")
            return False
        try:
            from twilio.rest import Client as TwilioClient
            def _send():
                client = TwilioClient(self.account_sid, self.auth_token)
                client.messages.create(body=message, from_=self.from_number, to=to)
            await asyncio.to_thread(_send)
            logger.info("Twilio SMS sent to %s (violation %s)", to, context.get("violation_id", "?"))
            return True
        except Exception as e:
            logger.error("Twilio SMS to %s failed: %s", to, e)
            return False

    def name(self) -> str:
        return "twilio"


class TelnyxSMSChannel(NotificationChannel):
    """SMS via Telnyx. Requires: pip install telnyx"""

    def __init__(self):
        self.api_key = os.environ.get("TELNYX_API_KEY", "")
        self.from_number = os.environ.get("TELNYX_FROM_NUMBER", "")

    async def send(self, to: str, message: str, context: dict) -> bool:
        if not self.api_key or not self.from_number:
            logger.warning("Telnyx credentials not configured — SMS not sent")
            return False
        try:
            import telnyx
            telnyx.api_key = self.api_key
            def _send():
                telnyx.Message.create(from_=self.from_number, to=to, text=message)
            await asyncio.to_thread(_send)
            logger.info("Telnyx SMS sent to %s (violation %s)", to, context.get("violation_id", "?"))
            return True
        except Exception as e:
            logger.error("Telnyx SMS to %s failed: %s", to, e)
            return False

    def name(self) -> str:
        return "telnyx"


class VonageSMSChannel(NotificationChannel):
    """SMS via Vonage (Nexmo). Requires: pip install vonage"""

    def __init__(self):
        self.api_key = os.environ.get("VONAGE_API_KEY", "")
        self.api_secret = os.environ.get("VONAGE_API_SECRET", "")
        self.from_number = os.environ.get("VONAGE_FROM_NUMBER", "")

    async def send(self, to: str, message: str, context: dict) -> bool:
        if not all([self.api_key, self.api_secret, self.from_number]):
            logger.warning("Vonage credentials not configured — SMS not sent")
            return False
        try:
            import vonage
            def _send():
                client = vonage.Client(key=self.api_key, secret=self.api_secret)
                sms = vonage.Sms(client)
                sms.send_message({"from": self.from_number, "to": to.lstrip("+"), "text": message})
            await asyncio.to_thread(_send)
            logger.info("Vonage SMS sent to %s (violation %s)", to, context.get("violation_id", "?"))
            return True
        except Exception as e:
            logger.error("Vonage SMS to %s failed: %s", to, e)
            return False

    def name(self) -> str:
        return "vonage"


class LogSMSChannel(NotificationChannel):
    """Dev/test channel — logs SMS to stdout instead of sending."""

    async def send(self, to: str, message: str, context: dict) -> bool:
        logger.info("[LOG-SMS] To: %s | Message: %s", to, message[:120])
        return True

    def name(self) -> str:
        return "log"


# ---------------------------------------------------------------------------
# Web Push channel stub (for future Service Worker integration)
# ---------------------------------------------------------------------------

class WebPushChannel(NotificationChannel):
    """
    Web Push Notifications via VAPID.

    Requires:
      - pip install pywebpush
      - VAPID_PRIVATE_KEY, VAPID_CLAIMS env vars
      - A push_subscriptions table in Supabase storing per-user endpoints

    This is a stub — cowork needs to:
      1. Generate VAPID keys: `npx web-push generate-vapid-keys`
      2. Add Service Worker to frontend for background push
      3. Store push subscriptions when operator grants permission
      4. Implement _get_subscriptions() to query the subscriptions table
    """

    async def send(self, to: str, message: str, context: dict) -> bool:
        vapid_key = os.environ.get("VAPID_PRIVATE_KEY", "")
        if not vapid_key:
            logger.debug("Web Push not configured (VAPID_PRIVATE_KEY not set)")
            return False

        # Stub: would query push_subscriptions for this operator and send
        logger.warning("Web Push channel not yet implemented — skipping")
        return False

    def name(self) -> str:
        return "push"


# ---------------------------------------------------------------------------
# Channel registry + notification dispatcher
# ---------------------------------------------------------------------------

_SMS_PROVIDERS = {
    "twilio": TwilioSMSChannel,
    "telnyx": TelnyxSMSChannel,
    "vonage": VonageSMSChannel,
    "log": LogSMSChannel,
}


def _build_channels() -> list[NotificationChannel]:
    """Build channel list from env config."""
    channel_names = os.environ.get("NOTIFY_CHANNELS", "in_app").lower().split(",")
    channel_names = [c.strip() for c in channel_names if c.strip()]

    channels = []
    for ch in channel_names:
        if ch == "in_app":
            channels.append(InAppChannel())
        elif ch == "sms":
            provider = os.environ.get("NOTIFY_SMS_PROVIDER", "twilio").lower()
            cls = _SMS_PROVIDERS.get(provider)
            if cls:
                channels.append(cls())
            else:
                logger.error("Unknown SMS provider: %s (available: %s)", provider, list(_SMS_PROVIDERS.keys()))
        elif ch == "push":
            channels.append(WebPushChannel())
        else:
            logger.warning("Unknown notification channel: %s", ch)

    if not channels:
        channels.append(InAppChannel())

    logger.info("Notification channels: %s", [c.name() for c in channels])
    return channels


# Lazily initialized channel list
_channels: list[NotificationChannel] | None = None


def get_channels() -> list[NotificationChannel]:
    global _channels
    if _channels is None:
        _channels = _build_channels()
    return _channels


async def notify(to: str, message: str, context: dict) -> dict:
    """
    Send a notification through all configured channels.

    Args:
        to: Recipient phone/identifier (used by SMS/push, ignored by in_app)
        message: Human-readable message body
        context: Structured metadata for the notification

    Returns:
        dict with per-channel results: {"twilio": True, "in_app": True, ...}
    """
    results = {}
    for channel in get_channels():
        try:
            ok = await channel.send(to, message, context)
            results[channel.name()] = ok
        except Exception as e:
            logger.error("Channel %s failed: %s", channel.name(), e)
            results[channel.name()] = False
    return results


async def notify_violation(
    operator_phone: str,
    zone_name: str,
    lot_name: str,
    violation_type: str,
    snapshot_url: str,
    map_url: str,
    detected_at: str,
    violation_id: str,
):
    """Send initial violation alert through all channels."""
    message = (
        f"VIOLATION -- {violation_type or 'unauthorized'}\n"
        f"{zone_name or 'Unknown zone'} at {lot_name or 'Unknown lot'}\n"
        f"Photo: {snapshot_url or 'N/A'}\n"
        f"Map: {map_url or 'N/A'}\n"
        f"Detected: {detected_at or 'now'}\n"
        f"\nReply DONE to acknowledge."
    )
    context = {
        "type": "violation_alert",
        "violation_id": violation_id,
        "zone_name": zone_name,
        "lot_name": lot_name,
        "violation_type": violation_type,
        "snapshot_url": snapshot_url,
        "map_url": map_url,
        "detected_at": detected_at,
    }
    return await notify(operator_phone or "", message, context)


async def notify_departure(
    operator_phone: str,
    zone_name: str,
    lot_name: str,
    violation_id: str,
):
    """Send departure alert when vehicle leaves after driver acknowledged (en route)."""
    message = (
        f"CANCELLED — Vehicle left {zone_name or 'Unknown zone'} "
        f"at {lot_name or 'Unknown lot'}. No action needed."
    )
    context = {
        "type": "departure_alert",
        "violation_id": violation_id,
        "zone_name": zone_name,
        "lot_name": lot_name,
    }
    return await notify(operator_phone or "", message, context)


async def notify_reminder(
    operator_phone: str,
    zone_name: str,
    lot_name: str,
    violation_type: str,
    snapshot_url: str,
    detected_at: str,
    violation_id: str,
):
    """Send 30-min reminder through all channels."""
    message = (
        f"REMINDER -- {violation_type or 'unauthorized'} still active\n"
        f"{zone_name or 'Unknown zone'} at {lot_name or 'Unknown lot'}\n"
        f"Photo: {snapshot_url or 'N/A'}\n"
        f"First detected: {detected_at or '?'} (30 min ago)\n"
        f"\nReply DONE to acknowledge."
    )
    context = {
        "type": "violation_reminder",
        "violation_id": violation_id,
        "zone_name": zone_name,
        "lot_name": lot_name,
        "violation_type": violation_type,
        "snapshot_url": snapshot_url,
        "detected_at": detected_at,
    }
    return await notify(operator_phone or "", message, context)
