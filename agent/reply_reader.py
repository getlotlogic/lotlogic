"""Gmail IMAP reply detection.

Connects to Gmail via IMAP, finds replies to outreach emails from the last
N days, and correlates them back to leadgen_contacts via the Message-ID
stored in leadgen_emails_sent.
"""

import email
import imaplib
import re
from datetime import datetime, timedelta, timezone
from email.header import decode_header
from typing import Optional

from leadgen import config, db


def _connect() -> imaplib.IMAP4_SSL:
    if not config.GMAIL_APP_PASSWORD:
        raise RuntimeError("GMAIL_APP_PASSWORD not set")
    mail = imaplib.IMAP4_SSL("imap.gmail.com")
    mail.login(config.GMAIL_ADDRESS, config.GMAIL_APP_PASSWORD)
    mail.select("INBOX")
    return mail


def _decode_header(raw: Optional[str]) -> str:
    if not raw:
        return ""
    parts = decode_header(raw)
    out = []
    for text, enc in parts:
        if isinstance(text, bytes):
            try:
                out.append(text.decode(enc or "utf-8", errors="replace"))
            except (LookupError, TypeError):
                out.append(text.decode("utf-8", errors="replace"))
        else:
            out.append(text)
    return "".join(out)


def _extract_from_email(from_header: str) -> str:
    match = re.search(r"<([^>]+)>", from_header)
    if match:
        return match.group(1).lower().strip()
    return from_header.lower().strip()


def _find_contact_id_by_message_id(conn, in_reply_to: str) -> Optional[int]:
    """Look up the contact_id for an original outreach email via its Message-ID."""
    if not in_reply_to:
        return None
    in_reply_to = in_reply_to.strip().strip("<>")
    full_id = f"<{in_reply_to}>"
    # Try both with and without angle brackets
    for mid in (in_reply_to, full_id):
        result = (
            conn.table(db.EMAILS_SENT)
            .select("contact_id")
            .eq("message_id", mid)
            .limit(1)
            .execute()
        )
        if result.data:
            return result.data[0]["contact_id"]
    return None


def _find_contact_id_by_email(conn, from_email: str) -> Optional[int]:
    """Fallback: look up contact_id by matching the sender's email address."""
    result = (
        conn.table(db.CONTACTS)
        .select("id")
        .eq("email", from_email.lower())
        .limit(1)
        .execute()
    )
    return result.data[0]["id"] if result.data else None


def check_for_replies(since_days: int = 14) -> list[dict]:
    """Connect to Gmail IMAP, find replies to outreach in the last N days.

    Returns a list of dicts:
        {
            "message_id": str,
            "from_email": str,
            "subject": str,
            "snippet": str,
            "contact_id": Optional[int],
        }

    A reply is any message whose In-Reply-To header matches a Message-ID in
    our leadgen_emails_sent table, OR any message from an address that exists
    in leadgen_contacts AND has "Re:" in the subject.
    """
    conn = db.get_db()
    mail = _connect()
    try:
        since_date = (datetime.now(timezone.utc) - timedelta(days=since_days)).strftime("%d-%b-%Y")
        status, data = mail.search(None, f'(SINCE {since_date})')
        if status != "OK" or not data or not data[0]:
            return []

        msg_ids = data[0].split()
        replies: list[dict] = []

        for msg_id in msg_ids:
            status, msg_data = mail.fetch(msg_id, "(RFC822.HEADER)")
            if status != "OK" or not msg_data:
                continue
            raw_header = b""
            for part in msg_data:
                if isinstance(part, tuple) and len(part) >= 2:
                    raw_header = part[1]
                    break
            if not raw_header:
                continue

            msg = email.message_from_bytes(raw_header)
            from_header = _decode_header(msg.get("From", ""))
            from_email = _extract_from_email(from_header)
            subject = _decode_header(msg.get("Subject", ""))
            in_reply_to = msg.get("In-Reply-To", "") or msg.get("References", "").split()[0] if msg.get("References") else msg.get("In-Reply-To", "")
            gmail_msg_id = msg.get("Message-ID", "").strip()

            # Skip our own outgoing mail
            if config.GMAIL_ADDRESS.lower() in from_email:
                continue

            # Try to correlate to a contact
            contact_id = _find_contact_id_by_message_id(conn, in_reply_to)
            if contact_id is None and subject.lower().startswith("re:"):
                contact_id = _find_contact_id_by_email(conn, from_email)
            elif contact_id is None and subject.lower().startswith("auto"):
                # Auto-reply / out-of-office — also correlate
                contact_id = _find_contact_id_by_email(conn, from_email)

            if contact_id is None:
                continue  # Not a reply to our outreach

            replies.append({
                "message_id": gmail_msg_id or msg_id.decode(),
                "imap_uid": msg_id.decode(),
                "from_email": from_email,
                "subject": subject,
                "snippet": "",  # populated by read_reply_body
                "contact_id": contact_id,
            })

        return replies
    finally:
        try:
            mail.close()
            mail.logout()
        except Exception:
            pass


def read_reply_body(imap_uid_or_message_id: str) -> str:
    """Fetch the full text body of a specific message."""
    mail = _connect()
    try:
        # Try as IMAP UID first
        try:
            status, data = mail.fetch(imap_uid_or_message_id.encode(), "(RFC822)")
        except Exception:
            status = "NO"
            data = None

        if status != "OK" or not data or not data[0]:
            # Try as Message-ID via search
            msg_id = imap_uid_or_message_id.strip().strip("<>")
            status, search_data = mail.search(
                None, f'(HEADER Message-ID "{msg_id}")'
            )
            if status != "OK" or not search_data or not search_data[0]:
                return "(message not found)"
            uid = search_data[0].split()[0]
            status, data = mail.fetch(uid, "(RFC822)")
            if status != "OK" or not data:
                return "(fetch failed)"

        raw = None
        for part in data:
            if isinstance(part, tuple) and len(part) >= 2:
                raw = part[1]
                break
        if not raw:
            return "(empty)"

        msg = email.message_from_bytes(raw)
        if msg.is_multipart():
            for part in msg.walk():
                ctype = part.get_content_type()
                if ctype == "text/plain":
                    payload = part.get_payload(decode=True)
                    if payload:
                        charset = part.get_content_charset() or "utf-8"
                        return payload.decode(charset, errors="replace").strip()
        else:
            payload = msg.get_payload(decode=True)
            if payload:
                charset = msg.get_content_charset() or "utf-8"
                return payload.decode(charset, errors="replace").strip()
        return "(no text body)"
    finally:
        try:
            mail.close()
            mail.logout()
        except Exception:
            pass
