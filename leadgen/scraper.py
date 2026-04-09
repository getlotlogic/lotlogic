"""Scrape leads from Apify Google Maps actor, with SerpAPI and Google Maps API fallbacks."""

import re
import time

import requests

from . import config, db

# Apify Google Maps Scraper actor ID
APIFY_GOOGLE_MAPS_ACTOR = "compass/crawler-google-places"

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


def _extract_zip(address: str) -> str | None:
    """Extract zip code from an address string."""
    if not address:
        return None
    match = re.search(r"\b(\d{5}(?:-\d{4})?)\b", address)
    return match.group(1) if match else None


def search_apify(conn, query: str, city: str, state: str, lead_type: str) -> int:
    """Use Apify Google Maps scraper to find businesses. Returns count of new leads inserted."""
    api_key = config.APIFY_API_KEY
    if not api_key:
        return 0

    full_query = query.format(city=f"{city}, {state}")

    # Run the actor synchronously (waits for results)
    run_url = f"https://api.apify.com/v2/acts/{APIFY_GOOGLE_MAPS_ACTOR}/run-sync-get-dataset-items"

    try:
        resp = requests.post(
            run_url,
            params={"token": api_key},
            json={
                "searchStringsArray": [full_query],
                "maxCrawledPlacesPerSearch": config.MAX_RESULTS_PER_QUERY,
                "language": "en",
                "deeperCityScrape": False,
            },
            headers={"Content-Type": "application/json"},
            timeout=300,  # Actor runs can take a few minutes
        )
        resp.raise_for_status()
        results = resp.json()
    except requests.exceptions.Timeout:
        print(f"  Apify timeout (query may still be running on Apify)")
        return 0
    except Exception as e:
        print(f"  Apify error: {e}")
        return 0

    count = 0
    for place in results:
        address = place.get("address") or place.get("street")
        lead_data = {
            "type": lead_type,
            "company_name": place.get("title") or place.get("name", ""),
            "address": address,
            "city": place.get("city") or city,
            "state": place.get("state") or state,
            "zip": place.get("postalCode") or _extract_zip(address or ""),
            "phone": place.get("phone") or place.get("phoneUnformatted"),
            "website": place.get("website"),
            "google_maps_url": place.get("url") or place.get("placeUrl"),
            "rating": place.get("totalScore") or place.get("rating"),
            "review_count": place.get("reviewsCount") or place.get("reviewCount"),
            "source": "apify",
        }

        lead_id = db.insert_lead(conn, **lead_data)
        if lead_id:
            count += 1

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
            lead_data = {
                "type": lead_type,
                "company_name": place.get("title", ""),
                "address": place.get("address"),
                "city": city,
                "state": state,
                "zip": _extract_zip(place.get("address", "")),
                "phone": place.get("phone"),
                "website": place.get("website"),
                "google_maps_url": place.get("place_id_search"),
                "rating": place.get("rating"),
                "review_count": place.get("reviews"),
                "source": "serpapi",
            }

            lead_id = db.insert_lead(conn, **lead_data)
            if lead_id:
                count += 1

        start += len(results)
        time.sleep(config.SCRAPE_DELAY_SECONDS)

    return count


def search_google_maps(
    conn, query: str, city: str, state: str, lead_type: str
) -> int:
    """Search Google Maps Places API for businesses. Returns count of new leads inserted."""
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

            place_id = place.get("place_id")
            if place_id:
                try:
                    details = client.place(place_id, fields=["formatted_phone_number", "website"])
                    detail = details.get("result", {})
                    lead_data["phone"] = detail.get("formatted_phone_number")
                    lead_data["website"] = detail.get("website")
                    time.sleep(0.5)
                except Exception:
                    pass

            lead_id = db.insert_lead(conn, **lead_data)
            if lead_id:
                count += 1

        next_token = results.get("next_page_token")
        if not next_token:
            break
        time.sleep(2)
        try:
            results = client.places(query=full_query, page_token=next_token)
        except Exception:
            break

    return count


def scrape_city(conn, city: str, state: str, lead_type: str) -> int:
    """Run all search queries for a city and lead type. Returns total new leads.
    Priority: Apify > SerpAPI > Google Maps API."""
    queries = config.SEARCH_QUERIES.get(lead_type, [])
    total = 0

    for query in queries:
        formatted = query.format(city=f"{city}, {state}")
        print(f"  Searching: {formatted}")

        # Try Apify first, then SerpAPI, then Google Maps API
        count = search_apify(conn, query, city, state, lead_type)
        if count == 0:
            count = search_serpapi(conn, query, city, state, lead_type)
        if count == 0:
            count = search_google_maps(conn, query, city, state, lead_type)

        print(f"    Found {count} new leads")
        total += count
        time.sleep(config.SCRAPE_DELAY_SECONDS)

    return total
