"""Daily summary + alert sender for the agent.

Uses the existing emailer.send_email() helper so we get the same Gmail SMTP
setup and headers.
"""

from datetime import datetime
from zoneinfo import ZoneInfo

from leadgen import config, emailer


ET = ZoneInfo("America/New_York")


def send_daily_summary(summary_text: str) -> None:
    """Email Gabriel the daily run summary."""
    today = datetime.now(ET).strftime("%A %b %d")
    subject = f"LotLogic lead gen: daily run {today}"
    body = f"""Daily lead gen agent run — {today}

{summary_text}

—
This is an automated summary from the LotLogic lead gen agent.
"""
    emailer.send_email(config.ALERT_EMAIL, subject, body)


def send_alert(subject: str, body: str, priority: str = "medium") -> None:
    """Send an urgent alert to Gabriel. Prefixes subject with priority marker."""
    prefix_map = {"high": "🚨 URGENT", "medium": "⚠️ ACTION", "low": "ℹ️ FYI"}
    prefix = prefix_map.get(priority, "⚠️ ACTION")
    full_subject = f"{prefix}: {subject}"
    full_body = f"{body}\n\n—\nSent by the LotLogic lead gen agent ({priority} priority)."
    emailer.send_email(config.ALERT_EMAIL, full_subject, full_body)
