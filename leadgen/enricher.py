"""Find email addresses for scraped leads."""

import re
import time
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

from . import config, db

EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}")

# Emails to skip
SKIP_PREFIXES = {
    "noreply",
    "no-reply",
    "no_reply",
    "donotreply",
    "do-not-reply",
    "support",
    "example",
    "test",
    "admin",
    "webmaster",
    "postmaster",
    "mailer-daemon",
    "abuse",
}

# Pages to check for contact info
CONTACT_PATHS = ["/contact", "/contact-us", "/about", "/about-us", "/team", "/staff"]

# Preferred role-based prefixes by lead type
ROLE_MAP = {
    "apartment": {"info": "info", "office": "office", "manager": "manager", "leasing": "leasing"},
    "tow": {"dispatch": "dispatch", "info": "info", "office": "office", "towing": "dispatch"},
}


def _get_domain(url: str) -> str | None:
    """Extract domain from a URL."""
    try:
        parsed = urlparse(url if "://" in url else f"https://{url}")
        return parsed.netloc.lower().lstrip("www.")
    except Exception:
        return None


def _classify_email_role(email: str, lead_type: str) -> str | None:
    """Classify the role of an email based on its prefix."""
    prefix = email.split("@")[0].lower()
    roles = ROLE_MAP.get(lead_type, {})
    return roles.get(prefix)


def _should_skip_email(email: str) -> bool:
    """Check if an email should be skipped (generic/system addresses)."""
    prefix = email.split("@")[0].lower()
    return prefix in SKIP_PREFIXES


def _extract_emails_from_html(html: str, domain: str) -> set[str]:
    """Extract email addresses from HTML content, filtering to the company's domain."""
    emails = set()
    for match in EMAIL_RE.findall(html):
        email = match.lower()
        email_domain = email.split("@")[1] if "@" in email else ""
        # Keep emails from the company's domain, or generic domains if no domain match
        if domain in email_domain or email_domain == domain:
            if not _should_skip_email(email):
                emails.add(email)
    return emails


def scrape_website_emails(website: str, lead_type: str) -> list[dict]:
    """Crawl a company website looking for email addresses.
    Returns list of {email, role, source, verified}."""
    if not website:
        return []

    domain = _get_domain(website)
    if not domain:
        return []

    base_url = website if "://" in website else f"https://{website}"
    found_emails = set()
    pages_to_check = [base_url] + [urljoin(base_url, path) for path in CONTACT_PATHS]

    session = requests.Session()
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    })

    for url in pages_to_check[:5]:  # Cap at 5 pages
        try:
            resp = session.get(url, timeout=10, allow_redirects=True)
            if resp.status_code != 200:
                continue
            content_type = resp.headers.get("content-type", "")
            if "html" not in content_type:
                continue
            emails = _extract_emails_from_html(resp.text, domain)
            found_emails.update(emails)
            time.sleep(1)
        except Exception:
            continue

    # Also check for mailto: links via BeautifulSoup on the homepage
    try:
        resp = session.get(base_url, timeout=10, allow_redirects=True)
        if resp.status_code == 200:
            soup = BeautifulSoup(resp.text, "html.parser")
            for link in soup.find_all("a", href=True):
                href = link["href"]
                if href.startswith("mailto:"):
                    email = href.replace("mailto:", "").split("?")[0].lower().strip()
                    if EMAIL_RE.match(email) and not _should_skip_email(email):
                        email_domain = email.split("@")[1]
                        if domain in email_domain:
                            found_emails.add(email)
    except Exception:
        pass

    results = []
    for email in found_emails:
        role = _classify_email_role(email, lead_type)
        results.append({
            "email": email,
            "role": role,
            "source": "website_scrape",
            "verified": True,
        })
    return results


def search_hunter(domain: str) -> list[dict]:
    """Use Hunter.io API to find emails for a domain.
    Returns list of {email, name, role, source, verified}."""
    api_key = config.HUNTER_API_KEY
    if not api_key or not domain:
        return []

    try:
        resp = requests.get(
            "https://api.hunter.io/v2/domain-search",
            params={"domain": domain, "api_key": api_key},
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        print(f"  Hunter.io error: {e}")
        return []

    results = []
    for email_data in data.get("data", {}).get("emails", []):
        email = email_data.get("value", "").lower()
        if email and not _should_skip_email(email):
            results.append({
                "email": email,
                "name": f"{email_data.get('first_name', '')} {email_data.get('last_name', '')}".strip() or None,
                "role": email_data.get("position") or email_data.get("department"),
                "source": "hunter.io",
                "verified": email_data.get("verification", {}).get("status") == "valid",
            })
    return results


def guess_email_patterns(domain: str, lead_type: str) -> list[dict]:
    """Generate likely email addresses from common patterns.
    Returns list of {email, role, source, verified}."""
    if not domain:
        return []

    patterns = ["info", "contact", "office"]
    if lead_type == "tow":
        patterns.extend(["dispatch", "towing"])
    elif lead_type == "apartment":
        patterns.extend(["leasing", "manager", "management"])

    results = []
    for prefix in patterns:
        results.append({
            "email": f"{prefix}@{domain}",
            "role": ROLE_MAP.get(lead_type, {}).get(prefix),
            "source": "pattern_guess",
            "verified": False,
        })
    return results


def enrich_lead(conn, lead) -> int:
    """Find and store email contacts for a single lead. Returns count of new contacts."""
    lead_id = lead["id"]
    lead_type = lead["type"]
    website = lead["website"]
    count = 0

    # Strategy 1: Scrape website
    if website:
        emails = scrape_website_emails(website, lead_type)
        for email_info in emails:
            cid = db.insert_contact(
                conn,
                lead_id=lead_id,
                email=email_info["email"],
                role=email_info.get("role"),
                source=email_info["source"],
                verified=email_info.get("verified", False),
            )
            if cid:
                count += 1

    # Strategy 2: Hunter.io
    if count == 0 and website:
        domain = _get_domain(website)
        if domain:
            emails = search_hunter(domain)
            for email_info in emails:
                cid = db.insert_contact(
                    conn,
                    lead_id=lead_id,
                    email=email_info["email"],
                    name=email_info.get("name"),
                    role=email_info.get("role"),
                    source=email_info["source"],
                    verified=email_info.get("verified", False),
                )
                if cid:
                    count += 1

    # Strategy 3: Pattern guessing (only if nothing else worked)
    if count == 0 and website:
        domain = _get_domain(website)
        if domain:
            emails = guess_email_patterns(domain, lead_type)
            for email_info in emails:
                cid = db.insert_contact(
                    conn,
                    lead_id=lead_id,
                    email=email_info["email"],
                    role=email_info.get("role"),
                    source=email_info["source"],
                    verified=email_info.get("verified", False),
                )
                if cid:
                    count += 1

    return count


def enrich_all(conn, lead_type: str) -> int:
    """Enrich all leads of a given type that don't have contacts yet. Returns total new contacts."""
    leads = db.get_leads(conn, lead_type=lead_type, has_email=False)
    total = 0

    for i, lead in enumerate(leads, 1):
        print(f"  [{i}/{len(leads)}] Enriching: {lead['company_name']}")
        count = enrich_lead(conn, lead)
        print(f"    Found {count} contacts")
        total += count
        if i < len(leads):
            time.sleep(2)  # Rate limit between leads

    return total
