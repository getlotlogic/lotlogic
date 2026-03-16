#!/usr/bin/env python3
"""One-shot migration: add missing columns to cameras table."""
import os
import sys

def main():
    try:
        import psycopg2
    except ImportError:
        os.system("pip install psycopg2-binary")
        import psycopg2

    db_url = os.environ.get("DATABASE_URL", "")
    if not db_url:
        print("ERROR: DATABASE_URL not set")
        sys.exit(1)

    # Convert asyncpg URL to standard if needed
    db_url = db_url.replace("postgresql+asyncpg://", "postgresql://")

    print(f"Connecting to database...")
    conn = psycopg2.connect(db_url)
    cur = conn.cursor()

    migrations = [
        "ALTER TABLE cameras ADD COLUMN IF NOT EXISTS deployment_profile text DEFAULT 'cloud'",
    ]

    for sql in migrations:
        print(f"Running: {sql[:60]}...")
        cur.execute(sql)

    conn.commit()
    print("MIGRATION_DONE")
    conn.close()


if __name__ == "__main__":
    main()
