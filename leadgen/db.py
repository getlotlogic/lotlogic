"""Supabase-backed data layer for the lead generation pipeline.

Replaces the previous SQLite implementation. Function signatures are preserved
so scraper, enricher, emailer, and cli don't need to change beyond imports.
All functions accept a Supabase Client as the first argument (named `conn`
for historical reasons) and return dicts or lists of dicts.
"""

import os
import re
from datetime import datetime, timezone
from typing import Any, Optional

from supabase import Client, create_client

from . import config

# Table names (all prefixed to avoid collision with main app tables)
LEADS = "leadgen_leads"
CONTACTS = "leadgen_contacts"
EMAILS_SENT = "leadgen_emails_sent"
EMAIL_QUEUE = "leadgen_email_queue"

# Suffixes to strip when normalizing company names
_STRIP_SUFFIXES = re.compile(
    r"\b(llc|inc|corp|corporation|co|company|ltd|limited|group|holdings)\b",
    re.IGNORECASE,
)


def normalize_company_name(name: str) -> str:
    """Normalize a company name for dedup: lowercase, strip common suffixes and punctuation."""
    name = name.lower().strip()
    name = _STRIP_SUFFIXES.sub("", name)
    name = re.sub(r"[.,\-'\"]+", " ", name)
    name = re.sub(r"\s+", " ", name).strip()
    return name


def get_db(_unused: Optional[str] = None) -> Client:
    """Return a Supabase client. The `_unused` param is kept for signature
    compatibility with the old SQLite get_db(db_path) API."""
    url = os.environ.get("SUPABASE_URL", "https://nzdkoouoaedbbccraoti.supabase.co")
    key = os.environ.get("SUPABASE_SERVICE_KEY") or os.environ.get("SUPABASE_KEY", "")
    if not key:
        raise RuntimeError(
            "SUPABASE_SERVICE_KEY not set — add it to leadgen/.env or export it"
        )
    return create_client(url, key)


# ────────────────────────────────────────────────────────────
# Leads
# ────────────────────────────────────────────────────────────

def insert_lead(conn: Client, **kwargs: Any) -> Optional[int]:
    """Insert a lead, deduplicating on (company_name, city, state).
    Returns lead id or None if duplicate."""
    name = normalize_company_name(kwargs["company_name"])

    # Check for duplicate (Postgres UNIQUE constraint would raise — we pre-check for speed)
    existing = (
        conn.table(LEADS)
        .select("id")
        .eq("company_name", name)
        .eq("city", kwargs.get("city") or "")
        .eq("state", kwargs.get("state") or "")
        .limit(1)
        .execute()
    )
    if existing.data:
        return None

    row = {
        "type": kwargs["type"],
        "company_name": name,
        "address": kwargs.get("address"),
        "city": kwargs.get("city"),
        "state": kwargs.get("state"),
        "zip": kwargs.get("zip"),
        "phone": kwargs.get("phone"),
        "website": kwargs.get("website"),
        "google_maps_url": kwargs.get("google_maps_url"),
        "rating": kwargs.get("rating"),
        "review_count": kwargs.get("review_count"),
        "source": kwargs.get("source", "google_maps"),
    }
    try:
        result = conn.table(LEADS).insert(row).execute()
    except Exception:
        # Race on UNIQUE constraint — another writer beat us
        return None
    return result.data[0]["id"] if result.data else None


def get_leads(
    conn: Client,
    lead_type: Optional[str] = None,
    has_email: Optional[bool] = None,
    city: Optional[str] = None,
) -> list[dict]:
    """Get leads with optional filters.

    If has_email is True/False, we filter by whether any contact exists.
    Implemented as two queries (can't do LEFT JOIN in PostgREST easily)."""
    query = conn.table(LEADS).select("*")
    if lead_type:
        query = query.eq("type", lead_type)
    if city:
        query = query.eq("city", city)
    all_leads = query.execute().data

    if has_email is None:
        return all_leads

    # Fetch all lead IDs that have contacts
    lead_ids_with_contacts = set()
    offset = 0
    while True:
        batch = (
            conn.table(CONTACTS)
            .select("lead_id")
            .range(offset, offset + 999)
            .execute()
            .data
        )
        if not batch:
            break
        lead_ids_with_contacts.update(row["lead_id"] for row in batch)
        if len(batch) < 1000:
            break
        offset += 1000

    if has_email:
        return [l for l in all_leads if l["id"] in lead_ids_with_contacts]
    return [l for l in all_leads if l["id"] not in lead_ids_with_contacts]


# ────────────────────────────────────────────────────────────
# Contacts
# ────────────────────────────────────────────────────────────

def insert_contact(
    conn: Client,
    lead_id: int,
    email: str,
    name: Optional[str] = None,
    role: Optional[str] = None,
    source: str = "website_scrape",
    verified: bool = False,
) -> Optional[int]:
    """Insert a contact for a lead. Skips if same email already exists for this lead."""
    email = email.lower()
    existing = (
        conn.table(CONTACTS)
        .select("id")
        .eq("lead_id", lead_id)
        .eq("email", email)
        .limit(1)
        .execute()
    )
    if existing.data:
        return None
    row = {
        "lead_id": lead_id,
        "name": name,
        "email": email,
        "role": role,
        "source": source,
        "verified": verified,
    }
    try:
        result = conn.table(CONTACTS).insert(row).execute()
    except Exception:
        return None
    return result.data[0]["id"] if result.data else None


def get_unemailed_contacts(
    conn: Client, lead_type: str, template_name: str
) -> list[dict]:
    """Get contacts for a lead type that haven't been sent a specific template.
    Filters out bounced, unsubscribed, and replied contacts.
    Returns dicts with c.* plus denormalized l.city, l.company_name, l.type."""
    # 1. Get all contacts that have already received this template
    already_sent = (
        conn.table(EMAILS_SENT)
        .select("contact_id")
        .eq("template_name", template_name)
        .execute()
        .data
    )
    already_sent_ids = {row["contact_id"] for row in already_sent}

    # 2. Get all leads of this type
    leads = conn.table(LEADS).select("id,city,company_name,type").eq("type", lead_type).execute().data
    leads_by_id = {l["id"]: l for l in leads}
    if not leads_by_id:
        return []

    # 3. Get contacts for those leads that are not excluded
    contacts: list[dict] = []
    lead_id_list = list(leads_by_id.keys())
    # Chunk in groups of 200 to stay under PostgREST URL limits
    for i in range(0, len(lead_id_list), 200):
        chunk = lead_id_list[i : i + 200]
        batch = (
            conn.table(CONTACTS)
            .select("*")
            .in_("lead_id", chunk)
            .eq("bounced", False)
            .eq("unsubscribed", False)
            .eq("replied", False)
            .execute()
            .data
        )
        contacts.extend(batch)

    # 4. Filter out already-sent and denormalize lead fields
    result = []
    for c in contacts:
        if c["id"] in already_sent_ids:
            continue
        lead = leads_by_id.get(c["lead_id"])
        if not lead:
            continue
        c["city"] = lead["city"]
        c["company_name"] = lead["company_name"]
        c["lead_type"] = lead["type"]
        result.append(c)
    return result


def mark_contact_bounced(conn: Client, contact_id: int) -> None:
    conn.table(CONTACTS).update({"bounced": True}).eq("id", contact_id).execute()


def mark_contact_unsubscribed(conn: Client, contact_id: int) -> None:
    conn.table(CONTACTS).update({"unsubscribed": True}).eq("id", contact_id).execute()


def mark_contact_replied(conn: Client, contact_id: int) -> None:
    now = datetime.now(timezone.utc).isoformat()
    conn.table(CONTACTS).update(
        {"replied": True, "last_reply_at": now}
    ).eq("id", contact_id).execute()
    # Cancel any pending followups for this contact
    conn.table(EMAIL_QUEUE).update({"status": "cancelled"}).eq(
        "contact_id", contact_id
    ).eq("status", "pending").execute()


# ────────────────────────────────────────────────────────────
# Emails sent
# ────────────────────────────────────────────────────────────

def log_email_sent(
    conn: Client,
    contact_id: int,
    template_name: str,
    subject: str,
    message_id: Optional[str] = None,
) -> Optional[int]:
    """Record a sent email."""
    row = {
        "contact_id": contact_id,
        "template_name": template_name,
        "subject": subject,
        "message_id": message_id,
    }
    result = conn.table(EMAILS_SENT).insert(row).execute()
    return result.data[0]["id"] if result.data else None


def get_sent_initial_emails(conn: Client) -> list[dict]:
    """Return all initial outreach emails (used to schedule follow-ups)."""
    all_rows: list[dict] = []
    offset = 0
    while True:
        batch = (
            conn.table(EMAILS_SENT)
            .select("contact_id,sent_at,template_name")
            .in_("template_name", ["apartment_initial", "tow_initial"])
            .range(offset, offset + 999)
            .execute()
            .data
        )
        if not batch:
            break
        all_rows.extend(batch)
        if len(batch) < 1000:
            break
        offset += 1000
    return all_rows


def get_emails_sent_today(conn: Client) -> int:
    """Count emails sent today (UTC date)."""
    today_start = datetime.now(timezone.utc).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    result = (
        conn.table(EMAILS_SENT)
        .select("id", count="exact")
        .gte("sent_at", today_start.isoformat())
        .execute()
    )
    return result.count or 0


def get_original_subject(conn: Client, contact_id: int) -> Optional[str]:
    """Get the subject of the first email sent to a contact (for Re: threading)."""
    result = (
        conn.table(EMAILS_SENT)
        .select("subject")
        .eq("contact_id", contact_id)
        .order("sent_at", desc=False)
        .limit(1)
        .execute()
    )
    return result.data[0]["subject"] if result.data else None


# ────────────────────────────────────────────────────────────
# Email queue (follow-ups)
# ────────────────────────────────────────────────────────────

def queue_followup(
    conn: Client,
    contact_id: int,
    template_name: str,
    scheduled_for: datetime,
) -> Optional[int]:
    """Queue a follow-up email. Skips if already queued."""
    existing = (
        conn.table(EMAIL_QUEUE)
        .select("id")
        .eq("contact_id", contact_id)
        .eq("template_name", template_name)
        .eq("status", "pending")
        .limit(1)
        .execute()
    )
    if existing.data:
        return None
    row = {
        "contact_id": contact_id,
        "template_name": template_name,
        "scheduled_for": scheduled_for.isoformat(),
    }
    try:
        result = conn.table(EMAIL_QUEUE).insert(row).execute()
    except Exception:
        return None
    return result.data[0]["id"] if result.data else None


def get_due_followups(conn: Client) -> list[dict]:
    """Get queued follow-ups that are due. Denormalizes email + lead info."""
    now = datetime.now(timezone.utc).isoformat()
    queue_rows = (
        conn.table(EMAIL_QUEUE)
        .select("*")
        .eq("status", "pending")
        .lte("scheduled_for", now)
        .execute()
        .data
    )
    if not queue_rows:
        return []

    contact_ids = list({r["contact_id"] for r in queue_rows})
    contacts: dict[int, dict] = {}
    # Chunk to stay under URL limits
    for i in range(0, len(contact_ids), 200):
        chunk = contact_ids[i : i + 200]
        batch = (
            conn.table(CONTACTS)
            .select("*")
            .in_("id", chunk)
            .eq("bounced", False)
            .eq("unsubscribed", False)
            .eq("replied", False)
            .execute()
            .data
        )
        for c in batch:
            contacts[c["id"]] = c

    lead_ids = list({c["lead_id"] for c in contacts.values()})
    leads: dict[int, dict] = {}
    for i in range(0, len(lead_ids), 200):
        chunk = lead_ids[i : i + 200]
        batch = (
            conn.table(LEADS)
            .select("id,city,company_name,type")
            .in_("id", chunk)
            .execute()
            .data
        )
        for l in batch:
            leads[l["id"]] = l

    result = []
    for q in queue_rows:
        c = contacts.get(q["contact_id"])
        if not c:
            continue  # contact was filtered (bounced/unsub/replied)
        l = leads.get(c["lead_id"])
        if not l:
            continue
        result.append({
            **q,
            "email": c["email"],
            "contact_name": c.get("name"),
            "city": l["city"],
            "company_name": l["company_name"],
            "lead_type": l["type"],
        })
    return result


def mark_queue_sent(conn: Client, queue_id: int) -> None:
    """Mark a queued item as sent."""
    conn.table(EMAIL_QUEUE).update({"status": "sent"}).eq("id", queue_id).execute()


# ────────────────────────────────────────────────────────────
# Stats and export
# ────────────────────────────────────────────────────────────

def get_stats(conn: Client) -> dict:
    """Get aggregate pipeline statistics."""
    stats: dict = {}

    for lead_type in ("apartment", "tow"):
        total = (
            conn.table(LEADS)
            .select("id", count="exact")
            .eq("type", lead_type)
            .execute()
            .count
            or 0
        )

        # Lead IDs for this type
        type_leads = (
            conn.table(LEADS).select("id").eq("type", lead_type).execute().data
        )
        lead_id_set = {l["id"] for l in type_leads}

        # Contacts belonging to those leads
        contact_ids_for_type: set[int] = set()
        leads_with_email_set: set[int] = set()
        if lead_id_set:
            lead_ids = list(lead_id_set)
            for i in range(0, len(lead_ids), 200):
                chunk = lead_ids[i : i + 200]
                batch = (
                    conn.table(CONTACTS)
                    .select("id,lead_id")
                    .in_("lead_id", chunk)
                    .execute()
                    .data
                )
                for c in batch:
                    contact_ids_for_type.add(c["id"])
                    leads_with_email_set.add(c["lead_id"])

        with_email = len(leads_with_email_set)

        # Emailed contacts = contacts_for_type ∩ contacts with at least one emails_sent row
        emailed = 0
        replied = 0
        if contact_ids_for_type:
            contact_ids = list(contact_ids_for_type)
            emailed_ids: set[int] = set()
            for i in range(0, len(contact_ids), 200):
                chunk = contact_ids[i : i + 200]
                batch = (
                    conn.table(EMAILS_SENT)
                    .select("contact_id")
                    .in_("contact_id", chunk)
                    .execute()
                    .data
                )
                emailed_ids.update(r["contact_id"] for r in batch)
            emailed = len(emailed_ids)

            # Replied = contacts marked replied=true
            replied_rows = (
                conn.table(CONTACTS)
                .select("id", count="exact")
                .eq("replied", True)
                .in_("id", contact_ids[:200])  # Approximate for stats
                .execute()
            )
            replied = replied_rows.count or 0

        stats[lead_type] = {
            "total": total,
            "with_email": with_email,
            "emailed": emailed,
            "replied": replied,
        }

    stats["sent_today"] = get_emails_sent_today(conn)
    stats["max_per_day"] = config.MAX_EMAILS_PER_DAY

    queued = (
        conn.table(EMAIL_QUEUE)
        .select("id", count="exact")
        .eq("status", "pending")
        .execute()
        .count
        or 0
    )
    stats["followups_queued"] = queued

    return stats


def export_all(conn: Client) -> list[dict]:
    """Return all leads joined with contacts for CSV export."""
    leads = conn.table(LEADS).select("*").execute().data
    if not leads:
        return []

    leads_by_id = {l["id"]: l for l in leads}
    lead_ids = list(leads_by_id.keys())

    all_contacts: list[dict] = []
    for i in range(0, len(lead_ids), 200):
        chunk = lead_ids[i : i + 200]
        batch = (
            conn.table(CONTACTS).select("*").in_("lead_id", chunk).execute().data
        )
        all_contacts.extend(batch)

    contacts_by_lead: dict[int, list[dict]] = {}
    for c in all_contacts:
        contacts_by_lead.setdefault(c["lead_id"], []).append(c)

    rows = []
    for lead in leads:
        lead_contacts = contacts_by_lead.get(lead["id"], [])
        if not lead_contacts:
            rows.append({
                "type": lead["type"],
                "company_name": lead["company_name"],
                "address": lead["address"],
                "city": lead["city"],
                "state": lead["state"],
                "zip": lead["zip"],
                "phone": lead["phone"],
                "website": lead["website"],
                "rating": lead["rating"],
                "review_count": lead["review_count"],
                "source": lead["source"],
                "email": None,
                "contact_name": None,
                "role": None,
                "email_source": None,
                "verified": None,
            })
        else:
            for c in lead_contacts:
                rows.append({
                    "type": lead["type"],
                    "company_name": lead["company_name"],
                    "address": lead["address"],
                    "city": lead["city"],
                    "state": lead["state"],
                    "zip": lead["zip"],
                    "phone": lead["phone"],
                    "website": lead["website"],
                    "rating": lead["rating"],
                    "review_count": lead["review_count"],
                    "source": lead["source"],
                    "email": c["email"],
                    "contact_name": c.get("name"),
                    "role": c.get("role"),
                    "email_source": c.get("source"),
                    "verified": c.get("verified"),
                })
    return rows
