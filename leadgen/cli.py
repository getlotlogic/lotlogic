"""CLI interface for the LotLogic lead generation pipeline."""

import csv
import sys

import click

from . import config, db, emailer, enricher, scraper


def get_conn():
    return db.get_db()


@click.group()
def cli():
    """LotLogic Lead Generation Pipeline"""
    pass


@cli.command()
@click.option("--type", "lead_type", required=True, type=click.Choice(["apartment", "tow"]))
@click.option("--city", required=True, help="City name (e.g. Charlotte)")
@click.option("--state", required=True, help="State abbreviation (e.g. NC)")
def scrape(lead_type, city, state):
    """Scrape leads via Apify, SerpAPI, or Google Maps API."""
    if not config.APIFY_API_KEY and not config.SERPAPI_KEY and not config.GOOGLE_MAPS_API_KEY:
        click.echo("ERROR: Set APIFY_API_KEY, SERPAPI_KEY, or GOOGLE_MAPS_API_KEY in .env")
        sys.exit(1)

    conn = get_conn()
    click.echo(f"Scraping {lead_type} leads in {city}, {state}...")
    total = scraper.scrape_city(conn, city, state, lead_type)
    click.echo(f"\nDone! {total} new leads added.")
    conn.close()


@cli.command()
@click.option("--type", "lead_type", required=True, type=click.Choice(["apartment", "tow"]))
def enrich(lead_type):
    """Find email addresses for scraped leads."""
    conn = get_conn()
    leads = db.get_leads(conn, lead_type=lead_type, has_email=False)
    click.echo(f"Enriching {len(leads)} {lead_type} leads without contacts...")
    total = enricher.enrich_all(conn, lead_type)
    click.echo(f"\nDone! {total} new contacts found.")
    conn.close()


@cli.command()
@click.option("--type", "lead_type", required=True, type=click.Choice(["apartment", "tow"]))
@click.option("--template", required=True, help="Template name (e.g. apartment_initial)")
@click.option("--limit", default=5, help="Number of emails to preview")
def preview(lead_type, template, limit):
    """Preview emails before sending."""
    conn = get_conn()
    contacts = db.get_unemailed_contacts(conn, lead_type, template)

    if not contacts:
        click.echo("No contacts to preview.")
        conn.close()
        return

    for i, contact in enumerate(contacts[:limit]):
        context = {
            "city": contact["city"] or "your area",
            "company_name": contact["company_name"] or "",
            "original_subject": db.get_original_subject(conn, contact["id"]) or "",
        }
        subject, body = emailer.render_template(template, context)

        click.echo(f"\n{'='*60}")
        click.echo(f"To: {contact['email']} ({contact['company_name']})")
        click.echo(f"Subject: {subject}")
        click.echo(f"{'='*60}")
        click.echo(body)

    remaining = len(contacts) - limit
    if remaining > 0:
        click.echo(f"\n... and {remaining} more contacts")

    conn.close()


@cli.command()
@click.option("--type", "lead_type", required=True, type=click.Choice(["apartment", "tow"]))
@click.option("--template", required=True, help="Template name (e.g. apartment_initial)")
@click.option("--max", "max_count", default=30, help="Max emails to send")
@click.option("--force", is_flag=True, help="Override sending hours check")
def send(lead_type, template, max_count, force):
    """Send emails to contacts."""
    if not config.GMAIL_APP_PASSWORD:
        click.echo("ERROR: Set GMAIL_APP_PASSWORD in .env")
        click.echo("Generate one at https://myaccount.google.com/apppasswords")
        sys.exit(1)

    conn = get_conn()
    count = emailer.send_batch(conn, lead_type, template, max_count, force=force)
    click.echo(f"\nSent {count} emails.")
    conn.close()


@cli.command("queue-followups")
def queue_followups():
    """Queue follow-up emails for contacts that received initial outreach."""
    conn = get_conn()
    count = emailer.queue_followups(conn)
    click.echo(f"Queued {count} follow-up emails.")
    conn.close()


@cli.command("send-followups")
@click.option("--force", is_flag=True, help="Override sending hours check")
def send_followups(force):
    """Send queued follow-ups that are due."""
    if not config.GMAIL_APP_PASSWORD:
        click.echo("ERROR: Set GMAIL_APP_PASSWORD in .env")
        sys.exit(1)

    conn = get_conn()
    count = emailer.send_followups(conn, force=force)
    click.echo(f"\nSent {count} follow-up emails.")
    conn.close()


@cli.command()
def stats():
    """Show pipeline statistics."""
    conn = get_conn()
    s = db.get_stats(conn)

    click.echo("\n=== LotLogic Lead Gen Stats ===")
    for lead_type in ("apartment", "tow"):
        t = s[lead_type]
        label = "Apartment" if lead_type == "apartment" else "Tow"
        click.echo(
            f"{label} Leads: {t['total']} | "
            f"With Email: {t['with_email']} | "
            f"Emailed: {t['emailed']} | "
            f"Replied: {t['replied']}"
        )
    click.echo(f"Emails Sent Today: {s['sent_today']}/{s['max_per_day']}")
    click.echo(f"Follow-ups Queued: {s['followups_queued']}")
    click.echo()
    conn.close()


@cli.command()
@click.option("--output", required=True, help="Output CSV file path")
def export(output):
    """Export leads and contacts to CSV."""
    conn = get_conn()
    rows = conn.execute(
        """SELECT l.type, l.company_name, l.address, l.city, l.state, l.zip,
                  l.phone, l.website, l.rating, l.review_count, l.source,
                  c.email, c.name as contact_name, c.role, c.source as email_source,
                  c.verified
           FROM leads l
           LEFT JOIN contacts c ON c.lead_id = l.id
           ORDER BY l.type, l.city, l.company_name"""
    ).fetchall()

    with open(output, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow([
            "type", "company_name", "address", "city", "state", "zip",
            "phone", "website", "rating", "review_count", "source",
            "email", "contact_name", "role", "email_source", "verified",
        ])
        for row in rows:
            writer.writerow(list(row))

    click.echo(f"Exported {len(rows)} rows to {output}")
    conn.close()


if __name__ == "__main__":
    cli()
