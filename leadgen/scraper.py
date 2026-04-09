"""Scrape leads from Google Maps Places API and SerpAPI."""

import time
from urllib.parse import urlparse

import requests

from . import config, db

# Rotate user agents for direct HTTP requests
USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
]
_ua_index = 0


def _next_ua() -> str:
    global _ua_index
    ua = USER_AGENTS[_ua_index % len(USER_AGENTS)]
    _ua_index += 1
    return ua


def _parse_address_components(components: list[dict]) -> dict:
    """Parse Google Maps address components into city/state/zip."""
    result = {"city": None, "state": None, "zip": None}
    for comp in components:
        types = comp.get("types", [])
        if "locality" in types:
            result["city"] = comp["long_name"]
        elif "administrative_area_level_1" in types:
            result["state"] = comp["short_name"]
        elif "postal_code" in types:
            result["zip"] = comp["long_name"]
    return result


def search_google_maps(
    conn, query: str, city: str, state: str, lead_type: str
) -> int:
    """Search Google Maps Places API (New) for businesses. Returns count of new leads inserted."""
    api_key = config.GOOGLE_MAPS_API_KEY
    if not api_key:
        return 0

    try:
        import googlemaps
    except ImportError:
        print("  googlemaps package not installed, skipping Google Maps API")
        return 0

    client = googlemaps.Client(key=api_key)
    full_query = query.format(city=f"{city}, {state}")
    count = 0

    try:
        results = client.places(query=full_query)
    except Exception as e:
        print(f"  Google Maps API error: {e}")
        return 0

    while True:
        for place in results.get("results", []):
            lead_data = {
                "type": lead_type,
                "company_name": place.get("name", ""),
                "address": place.get("formatted_address"),
                "city": city,
                "state": state,
                "rating": place.get("rating"),
                "review_count": place.get("user_ratings_total"),
                "source": "google_maps",
                "google_maps_url": f"https://www.google.com/maps/place/?q=place_id:{place.get('place_id', '')}",
            }

            # Get details for phone and website
            place_id = place.get("place_id")
            if place_id:
                try:
                    details = client.place(place_id, fields=["formatted_phone_number", "website"])
                    detail = details.get("result", {})
                    lead_data["phone"] = detail.get("formatted_phone_number")
                    lead_data["website"] = detail.get("website")
                    time.sleep(0.5)  # Rate limit detail requests
                except Exception:
                    pass

            # Parse address components if available
            addr_comps = place.get("address_components")
            if addr_comps:
                parsed = _parse_address_components(addr_comps)
                lead_data["city"] = parsed["city"] or city
                lead_data["state"] = parsed["state"] or state
                lead_data["zip"] = parsed["zip"]

            lead_id = db.insert_lead(conn, **lead_data)
            if lead_id:
                count += 1

        # Check for more pages
        next_token = results.get("next_page_token")
        if not next_token:
            break
        time.sleep(2)  # Required delay before using next_page_token
        try:
            results = client.places(query=full_query, page_token=next_token)
        except Exception:
            break

    return count


def search_serpapi(conn, query: str, city: str, state: str, lead_type: str) -> int:
    """Search SerpAPI Google Maps results as fallback. Returns count of new leads inserted."""
    api_key = config.SERPAPI_KEY
    if not api_key:
        return 0

    full_query = query.format(city=f"{city}, {state}")
    count = 0
    start = 0

    while start < config.MAX_RESULTS_PER_QUERY:
        try:
            resp = requests.get(
                "https://serpapi.com/search",
                params={
                    "engine": "google_maps",
                    "q": full_query,
                    "api_key": api_key,
                    "start": start,
                },
                headers={"User-Agent": _next_ua()},
                timeout=30,
            )
            resp.raise_for_status()
            data = resp.json()
        except Exception as e:
            print(f"  SerpAPI error: {e}")
            break

        results = data.get("local_results", [])
        if not results:
            break

        for place in results:
            website = place.get("website")
            lead_data = {
                "type": lead_type,
                "company_name": place.get("title", ""),
                "address": place.get("address"),
                "city": city,
                "state": state,
                "phone": place.get("phone"),
                "website": website,
                "google_maps_url": place.get("place_id_search"),
                "rating": place.get("rating"),
                "review_count": place.get("reviews"),
                "source": "serpapi",
            }

            # Try to extract zip from address
            address = place.get("address", "")
            if address:
                import re
                zip_match = re.search(r"\b(\d{5}(?:-\d{4})?)\b", address)
                if zip_match:
                    lead_data["zip"] = zip_match.group(1)

            lead_id = db.insert_lead(conn, **lead_data)
            if lead_id:
                count += 1

        start += len(results)
        time.sleep(config.SCRAPE_DELAY_SECONDS)

    return count


def scrape_city(conn, city: str, state: str, lead_type: str) -> int:
    """Run all search queries for a city and lead type. Returns total new leads."""
    queries = config.SEARCH_QUERIES.get(lead_type, [])
    total = 0

    for query in queries:
        formatted = query.format(city=f"{city}, {state}")
        print(f"  Searching: {formatted}")

        # Try Google Maps API first, then SerpAPI
        count = search_google_maps(conn, query, city, state, lead_type)
        if count == 0:
            count = search_serpapi(conn, query, city, state, lead_type)

        print(f"    Found {count} new leads")
        total += count
        time.sleep(config.SCRAPE_DELAY_SECONDS)

    return total
