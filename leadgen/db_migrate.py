"""One-shot migration script: copies data from the legacy SQLite leads.db
to Supabase (leadgen_* tables). Preserves email history. Safe to re-run —
dedups on (company_name, city, state) for leads and (lead_id, email) for
contacts.

Usage:
    python -m leadgen.db_migrate [--sqlite-path leadgen/leads.db]

Requires SUPABASE_SERVICE_KEY in the environment.
"""

import argparse
import sqlite3
import sys
from typing import Optional

from . import config, db


def _sqlite_conn(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn


def migrate_leads(sqlite: sqlite3.Connection, supabase) -> dict[int, int]:
    """Copy leads from SQLite to Supabase. Returns old_id → new_id map."""
    id_map: dict[int, int] = {}
    rows = sqlite.execute("SELECT * FROM leads").fetchall()
    print(f"Migrating {len(rows)} leads...")

    for i, row in enumerate(rows, 1):
        new_id = db.insert_lead(
            supabase,
            type=row["type"],
            company_name=row["company_name"],
            address=row["address"],
            city=row["city"],
            state=row["state"],
            zip=row["zip"],
            phone=row["phone"],
            website=row["website"],
            google_maps_url=row["google_maps_url"],
            rating=row["rating"],
            review_count=row["review_count"],
            source=row["source"],
        )
        if new_id is None:
            # Duplicate — look up existing id by (name, city, state)
            normalized = db.normalize_company_name(row["company_name"])
            existing = (
                supabase.table(db.LEADS)
                .select("id")
                .eq("company_name", normalized)
                .eq("city", row["city"] or "")
                .eq("state", row["state"] or "")
                .limit(1)
                .execute()
            )
            if existing.data:
                new_id = existing.data[0]["id"]
        if new_id is not None:
            id_map[row["id"]] = new_id
        if i % 25 == 0:
            print(f"  ... {i}/{len(rows)}")
    return id_map


def migrate_contacts(
    sqlite: sqlite3.Connection, supabase, lead_id_map: dict[int, int]
) -> dict[int, int]:
    """Copy contacts. Returns old_id → new_id map."""
    id_map: dict[int, int] = {}
    rows = sqlite.execute("SELECT * FROM contacts").fetchall()
    print(f"Migrating {len(rows)} contacts...")

    for i, row in enumerate(rows, 1):
        new_lead_id = lead_id_map.get(row["lead_id"])
        if new_lead_id is None:
            continue  # orphaned contact
        new_id = db.insert_contact(
            supabase,
            lead_id=new_lead_id,
            email=row["email"],
            name=row["name"],
            role=row["role"],
            source=row["source"],
            verified=bool(row["verified"]),
        )
        if new_id is None:
            # Look up existing by (lead_id, email)
            existing = (
                supabase.table(db.CONTACTS)
                .select("id")
                .eq("lead_id", new_lead_id)
                .eq("email", row["email"].lower())
                .limit(1)
                .execute()
            )
            if existing.data:
                new_id = existing.data[0]["id"]
        if new_id is not None:
            id_map[row["id"]] = new_id
        if i % 100 == 0:
            print(f"  ... {i}/{len(rows)}")
    return id_map


def migrate_emails_sent(
    sqlite: sqlite3.Connection, supabase, contact_id_map: dict[int, int]
) -> None:
    """Copy emails_sent history."""
    rows = sqlite.execute("SELECT * FROM emails_sent").fetchall()
    print(f"Migrating {len(rows)} sent emails...")

    for i, row in enumerate(rows, 1):
        new_contact_id = contact_id_map.get(row["contact_id"])
        if new_contact_id is None:
            continue
        supabase.table(db.EMAILS_SENT).insert({
            "contact_id": new_contact_id,
            "template_name": row["template_name"],
            "subject": row["subject"],
            "sent_at": row["sent_at"],
            "status": row["status"] or "sent",
            "message_id": row["message_id"],
        }).execute()
        if i % 25 == 0:
            print(f"  ... {i}/{len(rows)}")


def migrate_queue(
    sqlite: sqlite3.Connection, supabase, contact_id_map: dict[int, int]
) -> None:
    """Copy pending email queue entries."""
    rows = sqlite.execute(
        "SELECT * FROM email_queue WHERE status = 'pending'"
    ).fetchall()
    print(f"Migrating {len(rows)} pending queue entries...")

    for row in rows:
        new_contact_id = contact_id_map.get(row["contact_id"])
        if new_contact_id is None:
            continue
        try:
            supabase.table(db.EMAIL_QUEUE).insert({
                "contact_id": new_contact_id,
                "template_name": row["template_name"],
                "scheduled_for": row["scheduled_for"],
                "status": "pending",
            }).execute()
        except Exception:
            pass  # UNIQUE on (contact_id, template_name)


def main() -> int:
    parser = argparse.ArgumentParser(description="Migrate leadgen SQLite → Supabase")
    parser.add_argument(
        "--sqlite-path",
        default=config.DB_PATH,
        help="Path to the SQLite leads.db",
    )
    args = parser.parse_args()

    print(f"Source: {args.sqlite_path}")
    try:
        sqlite = _sqlite_conn(args.sqlite_path)
    except sqlite3.OperationalError as e:
        print(f"ERROR: cannot open SQLite DB at {args.sqlite_path}: {e}")
        return 1

    # Verify tables exist
    tables = sqlite.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()
    table_names = {t["name"] for t in tables}
    needed = {"leads", "contacts", "emails_sent", "email_queue"}
    missing = needed - table_names
    if missing:
        print(f"ERROR: SQLite DB missing tables: {missing}")
        return 1

    supabase = db.get_db()
    print(f"Target: Supabase ({config.SUPABASE_URL})")
    print()

    lead_id_map = migrate_leads(sqlite, supabase)
    print(f"Migrated {len(lead_id_map)} leads")
    print()

    contact_id_map = migrate_contacts(sqlite, supabase, lead_id_map)
    print(f"Migrated {len(contact_id_map)} contacts")
    print()

    migrate_emails_sent(sqlite, supabase, contact_id_map)
    migrate_queue(sqlite, supabase, contact_id_map)

    print()
    print("Done. Verify with: python -m leadgen.cli stats")
    return 0


if __name__ == "__main__":
    sys.exit(main())
