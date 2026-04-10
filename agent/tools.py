"""Tool definitions and handlers for the LotLogic lead gen agent.

Every tool is a thin wrapper over existing leadgen functions, with additional
safety: hard daily cap, business hours check, dry-run mode, and structured
result strings that Claude can reason about.
"""

import os
from typing import Any, Callable

from leadgen import config, db, emailer, enricher, scraper
from . import reply_reader, summary as summary_mod


DRY_RUN = os.environ.get("DRY_RUN", "false").lower() in ("true", "1", "yes")


# ────────────────────────────────────────────────────────────
# Tool schemas for the Anthropic API
# ────────────────────────────────────────────────────────────

AVAILABLE_TOOLS: list[dict[str, Any]] = [
    {
        "name": "get_stats",
        "description": (
            "Get current lead gen stats: total leads per type, contacts with email, "
            "emails sent today, replies, bounces, queued follow-ups. Call this FIRST "
            "every run to understand where things stand."
        ),
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "check_replies",
        "description": (
            "Check the Gmail inbox (IMAP) for new replies to outreach sent in the "
            "last 14 days. Returns a list of replies with from_email, subject, snippet. "
            "Does NOT mark anything — call categorize_reply for each one."
        ),
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "read_reply",
        "description": "Read the full body of a specific reply by its Gmail message ID.",
        "input_schema": {
            "type": "object",
            "properties": {
                "message_id": {"type": "string", "description": "Gmail message ID from check_replies"},
            },
            "required": ["message_id"],
        },
    },
    {
        "name": "categorize_reply",
        "description": (
            "Mark a contact based on their reply. 'interested' pauses the sequence "
            "and triggers an alert. 'not_interested' pauses. 'unsubscribe' permanently "
            "blocks. 'bounce' permanently blocks. 'ooo' is ignored (no action)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "contact_id": {"type": "integer"},
                "category": {
                    "type": "string",
                    "enum": ["interested", "not_interested", "unsubscribe", "bounce", "ooo"],
                },
            },
            "required": ["contact_id", "category"],
        },
    },
    {
        "name": "queue_followups",
        "description": (
            "Scan sent initial emails and queue follow-up 1 (3 days later) and "
            "follow-up 2 (10 days later) for each. Idempotent — skips already-queued. "
            "Call this before send_queued_followups."
        ),
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "send_queued_followups",
        "description": (
            "Send follow-up emails that are due today. Respects the 30/day cap and "
            "business hours. Returns the count actually sent."
        ),
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "scrape_city",
        "description": (
            "Scrape new leads from a city via Apify Google Maps actor. Use when the "
            "queue of unemailed contacts for a type is below 50. Typical yield: "
            "150-250 apartment leads or 30-40 tow leads per city."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "lead_type": {"type": "string", "enum": ["apartment", "tow"]},
                "city": {"type": "string", "description": "City name (e.g. Charlotte)"},
                "state": {"type": "string", "description": "2-letter state (e.g. NC)"},
            },
            "required": ["lead_type", "city", "state"],
        },
    },
    {
        "name": "enrich_leads",
        "description": (
            "Find email addresses for leads that don't have contacts yet. Scrapes "
            "each company's website, falls back to pattern guessing. Rate-limited. "
            "Call after scrape_city to get the contacts ready for outreach."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "lead_type": {"type": "string", "enum": ["apartment", "tow"]},
            },
            "required": ["lead_type"],
        },
    },
    {
        "name": "send_batch",
        "description": (
            "Send a batch of INITIAL cold outreach emails. Respects the 30/day "
            "global cap and business hours. Tool will refuse to send past the cap "
            "no matter what max_count you request."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "lead_type": {"type": "string", "enum": ["apartment", "tow"]},
                "template_name": {
                    "type": "string",
                    "enum": ["apartment_initial", "tow_initial"],
                },
                "max_count": {"type": "integer", "minimum": 1, "maximum": 30},
            },
            "required": ["lead_type", "template_name", "max_count"],
        },
    },
    {
        "name": "alert_human",
        "description": (
            "Send an urgent email to Gabriel. Use ONLY for interested replies, "
            "critical errors, or situations requiring human judgment. Do not use "
            "for routine summaries — the run summary handles that."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "subject": {"type": "string"},
                "body": {"type": "string"},
                "priority": {"type": "string", "enum": ["low", "medium", "high"]},
            },
            "required": ["subject", "body", "priority"],
        },
    },
]


# ────────────────────────────────────────────────────────────
# Tool handlers
# ────────────────────────────────────────────────────────────

def tool_get_stats() -> str:
    conn = db.get_db()
    stats = db.get_stats(conn)
    return (
        f"Apartment: {stats['apartment']['total']} leads, "
        f"{stats['apartment']['with_email']} with email, "
        f"{stats['apartment']['emailed']} already emailed, "
        f"{stats['apartment']['replied']} replied\n"
        f"Tow: {stats['tow']['total']} leads, "
        f"{stats['tow']['with_email']} with email, "
        f"{stats['tow']['emailed']} already emailed, "
        f"{stats['tow']['replied']} replied\n"
        f"Emails sent today: {stats['sent_today']}/{stats['max_per_day']}\n"
        f"Follow-ups queued: {stats['followups_queued']}\n"
        f"Remaining capacity today: {max(0, stats['max_per_day'] - stats['sent_today'])}"
    )


def tool_check_replies() -> str:
    try:
        replies = reply_reader.check_for_replies(since_days=14)
    except Exception as e:
        return f"ERROR checking replies: {e}"
    if not replies:
        return "No new replies."
    lines = [f"{len(replies)} new replies:"]
    for r in replies[:20]:
        lines.append(
            f"- id={r['message_id']} from={r['from_email']} "
            f"subject={r['subject'][:60]!r} contact_id={r.get('contact_id', 'unknown')}"
        )
    return "\n".join(lines)


def tool_read_reply(message_id: str) -> str:
    try:
        body = reply_reader.read_reply_body(message_id)
    except Exception as e:
        return f"ERROR reading reply: {e}"
    return body or "(empty body)"


def tool_categorize_reply(contact_id: int, category: str) -> str:
    if DRY_RUN:
        return f"DRY_RUN: would mark contact {contact_id} as {category}"
    conn = db.get_db()
    if category == "interested" or category == "not_interested":
        db.mark_contact_replied(conn, contact_id)
    elif category == "unsubscribe":
        db.mark_contact_unsubscribed(conn, contact_id)
        db.mark_contact_replied(conn, contact_id)
    elif category == "bounce":
        db.mark_contact_bounced(conn, contact_id)
    elif category == "ooo":
        return f"Contact {contact_id} is out-of-office — no action taken."
    return f"Contact {contact_id} marked as {category}."


def tool_queue_followups() -> str:
    if DRY_RUN:
        return "DRY_RUN: would queue follow-ups"
    conn = db.get_db()
    count = emailer.queue_followups(conn)
    return f"Queued {count} new follow-ups."


def tool_send_queued_followups() -> str:
    if DRY_RUN:
        return "DRY_RUN: would send queued follow-ups"
    if not emailer.is_sending_allowed():
        return "Outside sending hours (Mon-Fri 8am-4pm ET). No follow-ups sent."
    conn = db.get_db()
    count = emailer.send_followups(conn)
    return f"Sent {count} follow-up emails."


def tool_scrape_city(lead_type: str, city: str, state: str) -> str:
    if DRY_RUN:
        return f"DRY_RUN: would scrape {lead_type} in {city}, {state}"
    if not config.APIFY_API_KEY and not config.SERPAPI_KEY:
        return "ERROR: no scraper API key configured"
    conn = db.get_db()
    count = scraper.scrape_city(conn, city, state, lead_type)
    return f"Scraped {count} new {lead_type} leads from {city}, {state}."


def tool_enrich_leads(lead_type: str) -> str:
    if DRY_RUN:
        return f"DRY_RUN: would enrich {lead_type} leads"
    conn = db.get_db()
    count = enricher.enrich_all(conn, lead_type)
    return f"Found {count} new contacts for {lead_type} leads."


def tool_send_batch(lead_type: str, template_name: str, max_count: int) -> str:
    if DRY_RUN:
        return (
            f"DRY_RUN: would send up to {max_count} {template_name} emails to "
            f"{lead_type} contacts"
        )
    if not emailer.is_sending_allowed():
        return "Outside sending hours (Mon-Fri 8am-4pm ET). No emails sent."

    conn = db.get_db()
    sent_today = db.get_emails_sent_today(conn)
    remaining = config.MAX_EMAILS_PER_DAY - sent_today
    if remaining <= 0:
        return f"Daily cap reached ({config.MAX_EMAILS_PER_DAY}). No emails sent."

    capped = min(max_count, remaining)
    if capped < max_count:
        print(f"[tool] Capped request of {max_count} down to {capped} (daily limit)")

    count = emailer.send_batch(conn, lead_type, template_name, capped)
    return f"Sent {count} {template_name} emails. Daily total: {sent_today + count}/{config.MAX_EMAILS_PER_DAY}."


def tool_alert_human(subject: str, body: str, priority: str) -> str:
    if DRY_RUN:
        return f"DRY_RUN: would alert Gabriel — [{priority}] {subject}"
    try:
        summary_mod.send_alert(subject, body, priority)
    except Exception as e:
        return f"ERROR sending alert: {e}"
    return f"Alert sent to {config.ALERT_EMAIL} (priority={priority})."


# ────────────────────────────────────────────────────────────
# Dispatch
# ────────────────────────────────────────────────────────────

_HANDLERS: dict[str, Callable[..., str]] = {
    "get_stats": tool_get_stats,
    "check_replies": tool_check_replies,
    "read_reply": tool_read_reply,
    "categorize_reply": tool_categorize_reply,
    "queue_followups": tool_queue_followups,
    "send_queued_followups": tool_send_queued_followups,
    "scrape_city": tool_scrape_city,
    "enrich_leads": tool_enrich_leads,
    "send_batch": tool_send_batch,
    "alert_human": tool_alert_human,
}


def execute_tool(name: str, input_: dict) -> str:
    """Dispatch to the right handler. Always returns a string for Claude."""
    handler = _HANDLERS.get(name)
    if not handler:
        return f"ERROR: unknown tool {name!r}"
    try:
        return handler(**input_)
    except TypeError as e:
        return f"ERROR: bad arguments for {name}: {e}"
    except Exception as e:
        return f"ERROR in {name}: {type(e).__name__}: {e}"
