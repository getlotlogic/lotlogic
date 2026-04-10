"""Send personalized cold emails via Gmail SMTP."""

import os
import random
import smtplib
import time
import uuid
from datetime import datetime, timedelta, timezone
from email.mime.text import MIMEText
from zoneinfo import ZoneInfo

from jinja2 import Environment, FileSystemLoader

from . import config, db

ET = ZoneInfo("America/New_York")

# Template directory
TEMPLATE_DIR = os.path.join(os.path.dirname(__file__), "templates")
_jinja_env = Environment(loader=FileSystemLoader(TEMPLATE_DIR))


def render_template(template_name: str, context: dict) -> tuple[str, str]:
    """Render an email template. Returns (subject, body).
    Templates have Subject on the first line, blank line, then body."""
    filename = f"{template_name}.txt"
    template = _jinja_env.get_template(filename)
    rendered = template.render(**context)

    lines = rendered.split("\n", 2)
    subject = lines[0].replace("Subject: ", "").strip()
    body = lines[2].strip() if len(lines) > 2 else ""

    return subject, body


def is_sending_allowed() -> bool:
    """Check if current time is within allowed sending hours (Mon-Fri, 8am-4pm ET)."""
    now = datetime.now(ET)
    if now.weekday() not in config.SEND_DAYS:
        return False
    if not (config.SEND_START_HOUR <= now.hour < config.SEND_END_HOUR):
        return False
    return True


def send_email(
    to_email: str,
    subject: str,
    body: str,
    gmail_address: str | None = None,
    app_password: str | None = None,
) -> str:
    """Send a single email via Gmail SMTP. Returns the message ID."""
    sender = gmail_address or config.GMAIL_ADDRESS
    password = app_password or config.GMAIL_APP_PASSWORD

    if not password:
        raise ValueError("GMAIL_APP_PASSWORD not set. Generate one at https://myaccount.google.com/apppasswords")

    msg = MIMEText(body, "plain")
    msg["From"] = sender
    msg["To"] = to_email
    msg["Subject"] = subject
    msg["Reply-To"] = sender
    message_id = f"<{uuid.uuid4()}@lotlogic.com>"
    msg["Message-ID"] = message_id

    with smtplib.SMTP(config.SMTP_SERVER if hasattr(config, "SMTP_SERVER") else "smtp.gmail.com", 587) as server:
        server.starttls()
        server.login(sender, password)
        server.sendmail(sender, to_email, msg.as_string())

    return message_id


def send_batch(
    conn,
    lead_type: str,
    template_name: str,
    max_count: int = 30,
    force: bool = False,
) -> int:
    """Send emails to contacts that haven't received this template yet.
    Returns count of emails sent."""
    if not force and not is_sending_allowed():
        now = datetime.now(ET)
        print(f"Outside sending hours (Mon-Fri {config.SEND_START_HOUR}am-{config.SEND_END_HOUR}pm ET). "
              f"Current time: {now.strftime('%A %I:%M %p ET')}")
        print("Use --force to override.")
        return 0

    sent_today = db.get_emails_sent_today(conn)
    remaining = config.MAX_EMAILS_PER_DAY - sent_today
    if remaining <= 0:
        print(f"Daily limit reached ({config.MAX_EMAILS_PER_DAY} emails). Try again tomorrow.")
        return 0

    contacts = db.get_unemailed_contacts(conn, lead_type, template_name)
    if not contacts:
        print("No contacts to email.")
        return 0

    to_send = min(len(contacts), max_count, remaining)
    print(f"Sending {to_send} emails (type={lead_type}, template={template_name})")
    print(f"Emails sent today: {sent_today}/{config.MAX_EMAILS_PER_DAY}")

    count = 0
    for i, contact in enumerate(contacts[:to_send]):
        # Build template context
        context = {
            "city": contact["city"] or "your area",
            "company_name": contact["company_name"] or "",
            "original_subject": db.get_original_subject(conn, contact["id"]) or "",
        }

        try:
            subject, body = render_template(template_name, context)
            message_id = send_email(contact["email"], subject, body)
            db.log_email_sent(conn, contact["id"], template_name, subject, message_id)
            count += 1
            print(f"  [{count}/{to_send}] Sent to {contact['email']} ({contact['company_name']})")
        except Exception as e:
            print(f"  ERROR sending to {contact['email']}: {e}")
            continue

        # Random delay between sends
        if i < to_send - 1:
            delay = random.uniform(config.MIN_SEND_DELAY_SECONDS, config.MAX_SEND_DELAY_SECONDS)
            print(f"    Waiting {delay:.0f}s...")
            time.sleep(delay)

    return count


def queue_followups(conn) -> int:
    """Queue follow-up emails for contacts that have been sent initial emails.
    Returns count of follow-ups queued."""
    count = 0
    now = datetime.now(timezone.utc)

    # Get all sent initial emails
    sent = db.get_sent_initial_emails(conn)

    for row in sent:
        contact_id = row["contact_id"]
        if row.get("sent_at"):
            raw = row["sent_at"].replace("Z", "+00:00") if isinstance(row["sent_at"], str) else row["sent_at"]
            sent_at = datetime.fromisoformat(raw) if isinstance(raw, str) else raw
            if sent_at.tzinfo is None:
                sent_at = sent_at.replace(tzinfo=timezone.utc)
        else:
            sent_at = now

        # Queue followup_1 (FOLLOWUP_1_DAYS after initial)
        followup_1_time = sent_at + timedelta(days=config.FOLLOWUP_1_DAYS)
        qid = db.queue_followup(conn, contact_id, "followup_1", followup_1_time)
        if qid:
            count += 1

        # Queue followup_2 (FOLLOWUP_2_DAYS after initial)
        followup_2_time = sent_at + timedelta(days=config.FOLLOWUP_2_DAYS)
        qid = db.queue_followup(conn, contact_id, "followup_2", followup_2_time)
        if qid:
            count += 1

    return count


def send_followups(conn, force: bool = False) -> int:
    """Send all due follow-up emails from the queue. Returns count sent."""
    if not force and not is_sending_allowed():
        now = datetime.now(ET)
        print(f"Outside sending hours. Current time: {now.strftime('%A %I:%M %p ET')}")
        print("Use --force to override.")
        return 0

    sent_today = db.get_emails_sent_today(conn)
    remaining = config.MAX_EMAILS_PER_DAY - sent_today

    due = db.get_due_followups(conn)
    if not due:
        print("No follow-ups due.")
        return 0

    to_send = min(len(due), remaining)
    if to_send <= 0:
        print(f"Daily limit reached ({config.MAX_EMAILS_PER_DAY} emails).")
        return 0

    print(f"Sending {to_send} follow-up emails")
    count = 0

    for i, item in enumerate(due[:to_send]):
        context = {
            "city": item["city"] or "your area",
            "company_name": item["company_name"] or "",
            "original_subject": db.get_original_subject(conn, item["contact_id"]) or "",
        }

        try:
            subject, body = render_template(item["template_name"], context)
            message_id = send_email(item["email"], subject, body)
            db.log_email_sent(conn, item["contact_id"], item["template_name"], subject, message_id)
            db.mark_queue_sent(conn, item["id"])
            count += 1
            print(f"  [{count}/{to_send}] Follow-up to {item['email']} ({item['template_name']})")
        except Exception as e:
            print(f"  ERROR: {item['email']}: {e}")
            continue

        if i < to_send - 1:
            delay = random.uniform(config.MIN_SEND_DELAY_SECONDS, config.MAX_SEND_DELAY_SECONDS)
            print(f"    Waiting {delay:.0f}s...")
            time.sleep(delay)

    return count
