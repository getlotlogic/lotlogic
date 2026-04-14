"""Reddit monitoring for social media lead generation.

Scans target subreddits for posts about parking enforcement, property
management parking issues, and towing. Stores relevant posts in the
`reddit_leads` Supabase table. The agent uses this to find social engagement
opportunities and draft helpful replies.

Uses PRAW (Python Reddit API Wrapper). Requires Reddit API credentials:
    REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USER_AGENT
"""

import os
import time
from typing import Optional

import requests
from supabase import Client

from . import config

# Subreddits to monitor, organized by target audience
SUBREDDITS = {
    "apartment": [
        "propertymanagement",
        "landlord",
        "HOA",
        "apartments",
        "CommercialRealEstate",
        "PropertyManagement",
        "Charlotte",
        "CharlotteNC",
    ],
    "tow": [
        "Towing",
        "Charlotte",
    ],
    "general": [
        "RealEstate",
        "securitycameras",
        "Charlotte",
        "CharlotteNC",
    ],
}

# Keywords that indicate a relevant post
KEYWORDS = [
    "parking enforcement",
    "unauthorized parking",
    "towing contract",
    "parking sticker",
    "parking pass",
    "parking management",
    "resident parking",
    "visitor parking",
    "parking lot camera",
    "ALPR",
    "license plate recognition",
    "parking complaint",
    "parking violation",
    "tow truck",
    "private property towing",
    "gate cards",
    "parking decal",
    "parking permit",
    "boot vehicle",
    "parking garage security",
    "someone parking in my spot",
    "towing service",
    "apartment parking",
    "HOA parking",
    # Charlotte-specific
    "Charlotte parking",
    "Charlotte towing",
    "Charlotte apartment parking",
    "uptown Charlotte parking",
    "South End parking",
    "NoDa parking",
    "parking Charlotte NC",
]

# Reddit OAuth token URL
REDDIT_TOKEN_URL = "https://www.reddit.com/api/v1/access_token"
REDDIT_API_BASE = "https://oauth.reddit.com"


def _get_reddit_token() -> Optional[str]:
    """Get an OAuth2 access token from Reddit using app-only (script) flow."""
    client_id = os.environ.get("REDDIT_CLIENT_ID", "")
    client_secret = os.environ.get("REDDIT_CLIENT_SECRET", "")
    if not client_id or not client_secret:
        return None

    user_agent = os.environ.get("REDDIT_USER_AGENT", "LotLogic:leadgen:v1.0 (by /u/lotlogic)")

    try:
        resp = requests.post(
            REDDIT_TOKEN_URL,
            auth=(client_id, client_secret),
            data={"grant_type": "client_credentials"},
            headers={"User-Agent": user_agent},
            timeout=15,
        )
        resp.raise_for_status()
        return resp.json().get("access_token")
    except Exception as e:
        print(f"Reddit auth error: {e}")
        return None


def _reddit_search(token: str, subreddit: str, query: str, limit: int = 25) -> list[dict]:
    """Search a subreddit using Reddit's OAuth API."""
    user_agent = os.environ.get("REDDIT_USER_AGENT", "LotLogic:leadgen:v1.0 (by /u/lotlogic)")
    headers = {
        "Authorization": f"Bearer {token}",
        "User-Agent": user_agent,
    }

    try:
        resp = requests.get(
            f"{REDDIT_API_BASE}/r/{subreddit}/search",
            params={
                "q": query,
                "restrict_sr": "on",
                "sort": "new",
                "t": "month",
                "limit": limit,
            },
            headers=headers,
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        print(f"  Reddit search error for r/{subreddit}: {e}")
        return []

    posts = []
    for child in data.get("data", {}).get("children", []):
        post = child.get("data", {})
        if post.get("is_self", True):
            posts.append({
                "post_id": post.get("id", ""),
                "subreddit": subreddit,
                "title": post.get("title", ""),
                "body": (post.get("selftext", "") or "")[:2000],
                "author": post.get("author", "[deleted]"),
                "url": f"https://www.reddit.com{post.get('permalink', '')}",
                "score": post.get("score", 0),
                "num_comments": post.get("num_comments", 0),
            })
    return posts


def _score_relevance(title: str, body: str) -> float:
    """Score a post's relevance to LotLogic (0.0-1.0) based on keyword matches."""
    text = f"{title} {body}".lower()
    matches = sum(1 for kw in KEYWORDS if kw.lower() in text)
    return min(1.0, matches / 3.0)  # 3+ keyword matches = max relevance


def scan_subreddits(
    conn: Client,
    audience: Optional[str] = None,
    limit_per_sub: int = 25,
) -> int:
    """Scan target subreddits for relevant posts. Returns count of new leads stored."""
    token = _get_reddit_token()
    if not token:
        print("No Reddit API credentials configured — skipping Reddit scan")
        return 0

    subs_to_scan: dict[str, list[str]] = {}
    if audience:
        if audience in SUBREDDITS:
            subs_to_scan[audience] = SUBREDDITS[audience]
    else:
        subs_to_scan = dict(SUBREDDITS)

    total_new = 0

    for aud, subreddit_list in subs_to_scan.items():
        for subreddit in subreddit_list:
            print(f"  Scanning r/{subreddit}...")

            # Search with a few key terms
            search_queries = [
                "parking enforcement",
                "towing",
                "parking management",
                "parking camera",
                "unauthorized parking",
            ]

            seen_ids: set[str] = set()
            for query in search_queries:
                posts = _reddit_search(token, subreddit, query, limit=limit_per_sub)
                for post in posts:
                    if post["post_id"] in seen_ids:
                        continue
                    seen_ids.add(post["post_id"])

                    relevance = _score_relevance(post["title"], post["body"])
                    if relevance < 0.3:
                        continue

                    # Check if already in DB
                    existing = (
                        conn.table("reddit_leads")
                        .select("id")
                        .eq("post_id", post["post_id"])
                        .limit(1)
                        .execute()
                    )
                    if existing.data:
                        continue

                    # Store as new reddit lead
                    try:
                        conn.table("reddit_leads").insert({
                            "post_id": post["post_id"],
                            "subreddit": post["subreddit"],
                            "title": post["title"],
                            "body": post["body"],
                            "author": post["author"],
                            "url": post["url"],
                            "score": post["score"],
                            "num_comments": post["num_comments"],
                            "relevance_score": relevance,
                            "target_audience": aud,
                            "status": "new",
                        }).execute()
                        total_new += 1
                    except Exception:
                        pass  # UNIQUE constraint on post_id

                time.sleep(1)  # Rate limit between search queries

            time.sleep(2)  # Rate limit between subreddits

    return total_new


def get_pending_reddit_leads(conn: Client, limit: int = 10) -> list[dict]:
    """Get Reddit leads that haven't had a reply drafted yet."""
    return (
        conn.table("reddit_leads")
        .select("*")
        .eq("status", "new")
        .order("relevance_score", desc=True)
        .limit(limit)
        .execute()
        .data
    )


def save_draft_reply(conn: Client, lead_id: int, draft: str) -> None:
    """Save a drafted reply for a Reddit lead."""
    conn.table("reddit_leads").update({
        "draft_reply": draft,
        "status": "drafted",
    }).eq("id", lead_id).execute()


def mark_replied(conn: Client, lead_id: int) -> None:
    """Mark a Reddit lead as replied (human posted the reply)."""
    from datetime import datetime, timezone
    conn.table("reddit_leads").update({
        "status": "replied",
        "replied_at": datetime.now(timezone.utc).isoformat(),
    }).eq("id", lead_id).execute()


def mark_skipped(conn: Client, lead_id: int) -> None:
    """Mark a Reddit lead as skipped (not worth replying to)."""
    conn.table("reddit_leads").update({"status": "skipped"}).eq("id", lead_id).execute()


def get_reddit_stats(conn: Client) -> dict:
    """Get Reddit lead statistics."""
    stats = {}
    for status in ("new", "drafted", "replied", "skipped"):
        result = (
            conn.table("reddit_leads")
            .select("id", count="exact")
            .eq("status", status)
            .execute()
        )
        stats[status] = result.count or 0
    return stats
