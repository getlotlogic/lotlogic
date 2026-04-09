"""SQLite database models and helpers for the lead generation pipeline."""

import re
import sqlite3
from datetime import datetime, timezone

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    company_name TEXT NOT NULL,
    address TEXT,
    city TEXT,
    state TEXT,
    zip TEXT,
    phone TEXT,
    website TEXT,
    google_maps_url TEXT,
    rating REAL,
    review_count INTEGER,
    source TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(company_name, city, state)
);

CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER REFERENCES leads(id),
    name TEXT,
    email TEXT NOT NULL,
    role TEXT,
    source TEXT,
    verified BOOLEAN DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS emails_sent (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER REFERENCES contacts(id),
    template_name TEXT NOT NULL,
    subject TEXT NOT NULL,
    sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'sent',
    message_id TEXT
);

CREATE TABLE IF NOT EXISTS email_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER REFERENCES contacts(id),
    template_name TEXT NOT NULL,
    scheduled_for TIMESTAMP NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
"""

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


def get_db(db_path: str | None = None) -> sqlite3.Connection:
    """Get a database connection, creating tables if needed."""
    path = db_path or config.DB_PATH
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(SCHEMA)
    return conn


def insert_lead(conn: sqlite3.Connection, **kwargs) -> int | None:
    """Insert a lead, deduplicating on (company_name, city, state). Returns lead id or None if duplicate."""
    name = normalize_company_name(kwargs["company_name"])
    try:
        cur = conn.execute(
            """INSERT INTO leads (type, company_name, address, city, state, zip,
               phone, website, google_maps_url, rating, review_count, source)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                kwargs["type"],
                name,
                kwargs.get("address"),
                kwargs.get("city"),
                kwargs.get("state"),
                kwargs.get("zip"),
                kwargs.get("phone"),
                kwargs.get("website"),
                kwargs.get("google_maps_url"),
                kwargs.get("rating"),
                kwargs.get("review_count"),
                kwargs.get("source", "google_maps"),
            ),
        )
        conn.commit()
        return cur.lastrowid
    except sqlite3.IntegrityError:
        return None


def insert_contact(
    conn: sqlite3.Connection,
    lead_id: int,
    email: str,
    name: str | None = None,
    role: str | None = None,
    source: str = "website_scrape",
    verified: bool = False,
) -> int | None:
    """Insert a contact for a lead. Skips if same email already exists for this lead."""
    existing = conn.execute(
        "SELECT id FROM contacts WHERE lead_id = ? AND email = ?",
        (lead_id, email.lower()),
    ).fetchone()
    if existing:
        return None
    cur = conn.execute(
        """INSERT INTO contacts (lead_id, name, email, role, source, verified)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (lead_id, name, email.lower(), role, source, int(verified)),
    )
    conn.commit()
    return cur.lastrowid


def get_leads(
    conn: sqlite3.Connection,
    lead_type: str | None = None,
    has_email: bool | None = None,
    city: str | None = None,
) -> list[sqlite3.Row]:
    """Get leads with optional filters."""
    query = "SELECT l.* FROM leads l"
    conditions = []
    params = []

    if has_email is True:
        query += " INNER JOIN contacts c ON c.lead_id = l.id"
    elif has_email is False:
        query += " LEFT JOIN contacts c ON c.lead_id = l.id"
        conditions.append("c.id IS NULL")

    if lead_type:
        conditions.append("l.type = ?")
        params.append(lead_type)
    if city:
        conditions.append("l.city = ?")
        params.append(city)

    if conditions:
        query += " WHERE " + " AND ".join(conditions)

    if has_email is True:
        query += " GROUP BY l.id"

    return conn.execute(query, params).fetchall()


def get_unemailed_contacts(
    conn: sqlite3.Connection, lead_type: str, template_name: str
) -> list[sqlite3.Row]:
    """Get contacts for a lead type that haven't been sent a specific template."""
    return conn.execute(
        """SELECT c.*, l.city, l.company_name, l.type as lead_type
           FROM contacts c
           JOIN leads l ON l.id = c.lead_id
           WHERE l.type = ?
             AND c.id NOT IN (
                 SELECT contact_id FROM emails_sent WHERE template_name = ?
             )""",
        (lead_type, template_name),
    ).fetchall()


def log_email_sent(
    conn: sqlite3.Connection,
    contact_id: int,
    template_name: str,
    subject: str,
    message_id: str | None = None,
) -> int:
    """Record a sent email."""
    cur = conn.execute(
        """INSERT INTO emails_sent (contact_id, template_name, subject, message_id)
           VALUES (?, ?, ?, ?)""",
        (contact_id, template_name, subject, message_id),
    )
    conn.commit()
    return cur.lastrowid


def queue_followup(
    conn: sqlite3.Connection,
    contact_id: int,
    template_name: str,
    scheduled_for: datetime,
) -> int | None:
    """Queue a follow-up email. Skips if already queued for this contact/template."""
    existing = conn.execute(
        "SELECT id FROM email_queue WHERE contact_id = ? AND template_name = ? AND status = 'pending'",
        (contact_id, template_name),
    ).fetchone()
    if existing:
        return None
    cur = conn.execute(
        """INSERT INTO email_queue (contact_id, template_name, scheduled_for)
           VALUES (?, ?, ?)""",
        (contact_id, template_name, scheduled_for.isoformat()),
    )
    conn.commit()
    return cur.lastrowid


def get_due_followups(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    """Get queued follow-ups that are due to be sent."""
    now = datetime.now(timezone.utc).isoformat()
    return conn.execute(
        """SELECT eq.*, c.email, c.name as contact_name, l.city, l.company_name, l.type as lead_type
           FROM email_queue eq
           JOIN contacts c ON c.id = eq.contact_id
           JOIN leads l ON l.id = c.lead_id
           WHERE eq.status = 'pending' AND eq.scheduled_for <= ?""",
        (now,),
    ).fetchall()


def mark_queue_sent(conn: sqlite3.Connection, queue_id: int) -> None:
    """Mark a queued item as sent."""
    conn.execute("UPDATE email_queue SET status = 'sent' WHERE id = ?", (queue_id,))
    conn.commit()


def get_emails_sent_today(conn: sqlite3.Connection) -> int:
    """Count emails sent today."""
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    row = conn.execute(
        "SELECT COUNT(*) as cnt FROM emails_sent WHERE date(sent_at) = ?",
        (today,),
    ).fetchone()
    return row["cnt"]


def get_original_subject(conn: sqlite3.Connection, contact_id: int) -> str | None:
    """Get the subject of the first email sent to a contact (for Re: threading)."""
    row = conn.execute(
        "SELECT subject FROM emails_sent WHERE contact_id = ? ORDER BY sent_at ASC LIMIT 1",
        (contact_id,),
    ).fetchone()
    return row["subject"] if row else None


def get_stats(conn: sqlite3.Connection) -> dict:
    """Get aggregate pipeline statistics."""
    stats = {}
    for lead_type in ("apartment", "tow"):
        total = conn.execute(
            "SELECT COUNT(*) as cnt FROM leads WHERE type = ?", (lead_type,)
        ).fetchone()["cnt"]

        with_email = conn.execute(
            """SELECT COUNT(DISTINCT l.id) as cnt FROM leads l
               JOIN contacts c ON c.lead_id = l.id WHERE l.type = ?""",
            (lead_type,),
        ).fetchone()["cnt"]

        emailed = conn.execute(
            """SELECT COUNT(DISTINCT c.id) as cnt FROM contacts c
               JOIN leads l ON l.id = c.lead_id
               JOIN emails_sent es ON es.contact_id = c.id
               WHERE l.type = ?""",
            (lead_type,),
        ).fetchone()["cnt"]

        replied = conn.execute(
            """SELECT COUNT(DISTINCT c.id) as cnt FROM contacts c
               JOIN leads l ON l.id = c.lead_id
               JOIN emails_sent es ON es.contact_id = c.id
               WHERE l.type = ? AND es.status = 'replied'""",
            (lead_type,),
        ).fetchone()["cnt"]

        stats[lead_type] = {
            "total": total,
            "with_email": with_email,
            "emailed": emailed,
            "replied": replied,
        }

    stats["sent_today"] = get_emails_sent_today(conn)
    stats["max_per_day"] = config.MAX_EMAILS_PER_DAY

    followups = conn.execute(
        "SELECT COUNT(*) as cnt FROM email_queue WHERE status = 'pending'"
    ).fetchone()["cnt"]
    stats["followups_queued"] = followups

    return stats
