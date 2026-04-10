"""Configuration for the LotLogic lead generation pipeline."""

import os

from dotenv import load_dotenv

load_dotenv()

# Gmail credentials
GMAIL_ADDRESS = os.getenv("GMAIL_ADDRESS", "lotlogicai@gmail.com")
GMAIL_APP_PASSWORD = os.getenv("GMAIL_APP_PASSWORD", "")

# API keys
APIFY_API_KEY = os.getenv("APIFY_API_KEY", "")  # Primary scraper
GOOGLE_MAPS_API_KEY = os.getenv("GOOGLE_MAPS_API_KEY", "")
SERPAPI_KEY = os.getenv("SERPAPI_KEY", "")
HUNTER_API_KEY = os.getenv("HUNTER_API_KEY", "")

# Supabase (backend uses SERVICE key for writes)
SUPABASE_URL = os.getenv("SUPABASE_URL", "https://nzdkoouoaedbbccraoti.supabase.co")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")

# Anthropic (agent)
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")

# Alert recipient
ALERT_EMAIL = os.getenv("ALERT_EMAIL", "gabebs1@gmail.com")

# Target cities
TARGET_CITIES = [
    ("Charlotte", "NC"),
    ("Raleigh", "NC"),
    ("Durham", "NC"),
    ("Greensboro", "NC"),
    ("Columbia", "SC"),
    ("Greenville", "SC"),
    ("Atlanta", "GA"),
]

# Rate limits — email sending
MAX_EMAILS_PER_DAY = 30
MIN_SEND_DELAY_SECONDS = 30
MAX_SEND_DELAY_SECONDS = 90

# Follow-up timing (days after initial send)
FOLLOWUP_1_DAYS = 3
FOLLOWUP_2_DAYS = 10

# Scraping
SCRAPE_DELAY_SECONDS = 3
MAX_RESULTS_PER_QUERY = 60

# Sending hours (ET)
SEND_START_HOUR = 8
SEND_END_HOUR = 16
SEND_DAYS = [0, 1, 2, 3, 4]  # Mon-Fri

# Database (legacy SQLite path, kept for one-shot migration script)
DB_PATH = os.path.join(os.path.dirname(__file__), "leads.db")

# Search queries by lead type
SEARCH_QUERIES = {
    "apartment": [
        "apartment management company in {city}",
        "property management company in {city}",
        "apartment complex in {city}",
        "HOA management in {city}",
        "residential property management {city}",
    ],
    "tow": [
        "towing company in {city}",
        "private property towing {city}",
        "tow truck service {city}",
    ],
}
