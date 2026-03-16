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
        "ALTER TABLE cameras ADD COLUMN IF NOT EXISTS jpeg_quality integer DEFAULT 85",
        "ALTER TABLE cameras ADD COLUMN IF NOT EXISTS resolution_width integer DEFAULT 1920",
        "ALTER TABLE cameras ADD COLUMN IF NOT EXISTS resolution_height integer DEFAULT 1080",
        "ALTER TABLE cameras ADD COLUMN IF NOT EXISTS codec text DEFAULT 'h264'",
        "ALTER TABLE cameras ADD COLUMN IF NOT EXISTS fps integer DEFAULT 15",
        "ALTER TABLE cameras ADD COLUMN IF NOT EXISTS night_mode boolean DEFAULT false",
        "ALTER TABLE cameras ADD COLUMN IF NOT EXISTS motion_sensitivity integer DEFAULT 50",
        "ALTER TABLE cameras ADD COLUMN IF NOT EXISTS connection_timeout integer DEFAULT 10",
        "ALTER TABLE cameras ADD COLUMN IF NOT EXISTS retry_interval integer DEFAULT 30",
        "ALTER TABLE cameras ADD COLUMN IF NOT EXISTS max_retries integer DEFAULT 3",
    ]

    for sql in migrations:
        print(f"Running: {sql[:60]}...")
        cur.execute(sql)

    conn.commit()
    print("MIGRATION_DONE")
    conn.close()


if __name__ == "__main__":
    main()
