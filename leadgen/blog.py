"""SEO blog engine — generates and publishes articles as static HTML.

The agent calls `generate_blog_post()` with a keyword and audience, gets
back rendered HTML, and writes it to frontend/blog/{slug}.html. Vercel
auto-deploys on merge.

All posts are also tracked in the Supabase `blog_posts` table so the agent
knows what's already been written and can avoid duplicate topics.
"""

import os
import re
from datetime import datetime, timezone
from typing import Optional

from supabase import Client

BLOG_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend", "blog")

# Target keywords by audience, ordered by search volume priority
KEYWORD_MAP = {
    "apartment": [
        "parking enforcement Charlotte NC apartments",
        "free parking enforcement for apartment complexes Charlotte",
        "digital parking passes for apartments Charlotte NC",
        "apartment parking management solutions Charlotte",
        "ALPR cameras for apartment communities Charlotte NC",
        "property management parking solutions Charlotte",
        "how to stop unauthorized parking at apartments Charlotte",
        "resident parking pass system Charlotte NC",
        "guest parking management for apartments Charlotte",
        "parking lot security cameras Charlotte NC",
        "HOA parking enforcement Charlotte NC",
        "solar powered security cameras Charlotte parking lots",
        "Charlotte apartment complex parking problems",
        "automated parking enforcement Charlotte NC",
    ],
    "tow": [
        "towing companies Charlotte NC",
        "private property towing Charlotte NC",
        "how to get towing contracts Charlotte apartments",
        "towing dispatch automation Charlotte",
        "ALPR towing alerts Charlotte NC",
        "tow company apartment complex contracts Charlotte",
        "parking violation detection Charlotte tow companies",
        "towing business Charlotte NC growth",
    ],
    "general": [
        "parking enforcement technology Charlotte NC",
        "license plate recognition parking Charlotte",
        "AI parking enforcement Charlotte NC",
        "smart parking solutions Charlotte private property",
        "digital parking pass vs sticker Charlotte apartments",
        "Charlotte NC parking management technology",
    ],
}


def slugify(text: str) -> str:
    """Convert text to URL-safe slug."""
    slug = text.lower().strip()
    slug = re.sub(r"[^\w\s-]", "", slug)
    slug = re.sub(r"[\s_]+", "-", slug)
    slug = re.sub(r"-+", "-", slug).strip("-")
    return slug


def get_unwritten_keywords(conn: Client) -> list[dict]:
    """Return keywords that don't have a published blog post yet."""
    existing = conn.table("blog_posts").select("target_keyword").execute().data
    existing_keywords = {r["target_keyword"].lower() for r in existing if r.get("target_keyword")}

    unwritten = []
    for audience, keywords in KEYWORD_MAP.items():
        for kw in keywords:
            if kw.lower() not in existing_keywords:
                unwritten.append({"keyword": kw, "audience": audience})
    return unwritten


def save_blog_post(
    conn: Client,
    slug: str,
    title: str,
    meta_description: str,
    target_keyword: str,
    target_audience: str,
    body_html: str,
    publish: bool = True,
) -> Optional[int]:
    """Save a blog post to Supabase and write the HTML file."""
    now = datetime.now(timezone.utc).isoformat()
    row = {
        "slug": slug,
        "title": title,
        "meta_description": meta_description,
        "target_keyword": target_keyword,
        "target_audience": target_audience,
        "body_html": body_html,
        "published": publish,
        "published_at": now if publish else None,
    }
    try:
        result = conn.table("blog_posts").insert(row).execute()
    except Exception:
        return None

    # Write the rendered HTML file
    html = render_article(title, meta_description, target_keyword, body_html, slug)
    filepath = os.path.join(BLOG_DIR, f"{slug}.html")
    os.makedirs(BLOG_DIR, exist_ok=True)
    with open(filepath, "w") as f:
        f.write(html)

    return result.data[0]["id"] if result.data else None


def get_published_posts(conn: Client) -> list[dict]:
    """Get all published blog posts for index generation."""
    return (
        conn.table("blog_posts")
        .select("slug,title,meta_description,target_audience,published_at")
        .eq("published", True)
        .order("published_at", desc=True)
        .execute()
        .data
    )


def render_article(
    title: str,
    meta_description: str,
    target_keyword: str,
    body_html: str,
    slug: str,
) -> str:
    """Render a complete blog article HTML page with SEO markup."""
    schema_json = (
        '{"@context":"https://schema.org","@type":"Article",'
        f'"headline":"{_escape(title)}",'
        f'"description":"{_escape(meta_description)}",'
        '"author":{"@type":"Person","name":"Gabriel Bowen-Slott"},'
        '"publisher":{"@type":"Organization","name":"LotLogic LLC"},'
        f'"mainEntityOfPage":"https://lotlogic-beta.vercel.app/blog/{slug}.html"'
        "}"
    )

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{_escape(title)} | LotLogic Blog</title>
  <meta name="description" content="{_escape(meta_description)}">
  <meta name="keywords" content="{_escape(target_keyword)}">
  <meta name="author" content="Gabriel Bowen-Slott">
  <link rel="canonical" href="https://lotlogic-beta.vercel.app/blog/{slug}.html">

  <!-- Open Graph -->
  <meta property="og:type" content="article">
  <meta property="og:title" content="{_escape(title)}">
  <meta property="og:description" content="{_escape(meta_description)}">
  <meta property="og:url" content="https://lotlogic-beta.vercel.app/blog/{slug}.html">
  <meta property="og:site_name" content="LotLogic">

  <!-- Twitter -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="{_escape(title)}">
  <meta name="twitter:description" content="{_escape(meta_description)}">

  <!-- Schema.org -->
  <script type="application/ld+json">{schema_json}</script>

  <style>
    * {{ margin: 0; padding: 0; box-sizing: border-box; }}
    body {{
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f1117;
      color: #d1d5db;
      line-height: 1.8;
      -webkit-font-smoothing: antialiased;
    }}
    .nav {{
      padding: 20px 24px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }}
    .nav a {{
      color: #3b82f6;
      text-decoration: none;
      font-weight: 600;
      font-size: 14px;
    }}
    .nav a:hover {{ text-decoration: underline; }}
    article {{
      max-width: 720px;
      margin: 0 auto;
      padding: 48px 24px 80px;
    }}
    article h1 {{
      font-size: clamp(28px, 5vw, 40px);
      font-weight: 800;
      color: #f9fafb;
      line-height: 1.2;
      margin-bottom: 16px;
      letter-spacing: -0.02em;
    }}
    article .meta {{
      color: #6b7280;
      font-size: 14px;
      margin-bottom: 40px;
    }}
    article h2 {{
      font-size: 24px;
      font-weight: 700;
      color: #f9fafb;
      margin-top: 40px;
      margin-bottom: 16px;
    }}
    article h3 {{
      font-size: 20px;
      font-weight: 700;
      color: #e5e7eb;
      margin-top: 32px;
      margin-bottom: 12px;
    }}
    article p {{
      margin-bottom: 20px;
      font-size: 17px;
    }}
    article ul, article ol {{
      margin-bottom: 20px;
      padding-left: 24px;
    }}
    article li {{
      margin-bottom: 8px;
      font-size: 17px;
    }}
    article strong {{ color: #f9fafb; }}
    article a {{ color: #3b82f6; text-decoration: none; }}
    article a:hover {{ text-decoration: underline; }}
    article blockquote {{
      border-left: 3px solid #3b82f6;
      padding-left: 20px;
      margin: 24px 0;
      color: #9ca3af;
      font-style: italic;
    }}
    .cta-box {{
      background: #1a1d27;
      border: 1px solid rgba(59,130,246,0.3);
      border-radius: 14px;
      padding: 32px;
      margin: 48px 0;
      text-align: center;
    }}
    .cta-box h3 {{
      color: #f9fafb;
      margin-top: 0;
      margin-bottom: 12px;
    }}
    .cta-box p {{
      color: #9ca3af;
      margin-bottom: 20px;
    }}
    .cta-box a.btn {{
      display: inline-block;
      background: linear-gradient(135deg, #3b82f6, #1d4ed8);
      color: #fff;
      padding: 12px 24px;
      border-radius: 10px;
      font-weight: 700;
      font-size: 15px;
      text-decoration: none;
    }}
    footer {{
      padding: 32px 24px;
      text-align: center;
      color: #4b5563;
      font-size: 13px;
      border-top: 1px solid rgba(255,255,255,0.06);
    }}
  </style>
</head>
<body>

  <nav class="nav">
    <a href="/blog/">&larr; LotLogic Blog</a>
  </nav>

  <article>
    <h1>{title}</h1>
    <div class="meta">By Gabriel Bowen-Slott &middot; LotLogic</div>

    {body_html}

    <div class="cta-box">
      <h3>Ready to automate parking enforcement?</h3>
      <p>Free cameras, digital passes, and automated towing — at zero cost to your community.</p>
      <a class="btn" href="mailto:lotlogicai@gmail.com?subject=LotLogic%20demo%20request">Book a 15-min demo &rarr;</a>
    </div>
  </article>

  <footer>
    &copy; 2026 LotLogic LLC &middot; AI-powered parking enforcement
  </footer>

</body>
</html>"""


def render_blog_index(posts: list[dict]) -> str:
    """Render the blog index page listing all published articles."""
    cards = ""
    for post in posts:
        audience_label = {
            "apartment": "Property Managers",
            "tow": "Tow Companies",
            "general": "Industry",
        }.get(post.get("target_audience", "general"), "Industry")

        cards += f"""
    <a href="/blog/{post['slug']}.html" class="post-card">
      <span class="badge">{audience_label}</span>
      <h3>{_escape(post['title'])}</h3>
      <p>{_escape(post.get('meta_description', ''))}</p>
    </a>"""

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LotLogic Blog — Parking Enforcement Insights</title>
  <meta name="description" content="Expert insights on parking enforcement, ALPR technology, digital parking passes, and property management solutions from LotLogic.">
  <link rel="canonical" href="https://lotlogic-beta.vercel.app/blog/">

  <meta property="og:type" content="website">
  <meta property="og:title" content="LotLogic Blog">
  <meta property="og:description" content="Expert insights on parking enforcement, ALPR technology, and property management.">
  <meta property="og:url" content="https://lotlogic-beta.vercel.app/blog/">

  <style>
    * {{ margin: 0; padding: 0; box-sizing: border-box; }}
    body {{
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f1117;
      color: #e5e7eb;
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
    }}
    .container {{ max-width: 900px; margin: 0 auto; padding: 0 24px; }}
    header {{
      padding: 60px 0 40px;
      text-align: center;
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }}
    header .logo {{
      display: inline-flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 20px;
    }}
    header .shield {{
      width: 36px; height: 36px;
      background: linear-gradient(135deg, #3b82f6, #1d4ed8);
      border-radius: 8px;
      display: flex; align-items: center; justify-content: center;
      font-weight: 900; font-size: 14px; color: #fff;
    }}
    header .wordmark {{ font-size: 18px; font-weight: 800; color: #f9fafb; }}
    header .wordmark span {{ color: #3b82f6; }}
    header h1 {{
      font-size: clamp(28px, 5vw, 40px);
      font-weight: 800;
      color: #f9fafb;
      margin-bottom: 12px;
      letter-spacing: -0.02em;
    }}
    header p {{ color: #9ca3af; font-size: 17px; }}
    .posts {{ padding: 40px 0 80px; display: grid; gap: 16px; }}
    .post-card {{
      display: block;
      background: #1a1d27;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 14px;
      padding: 28px;
      text-decoration: none;
      transition: border-color 0.15s;
    }}
    .post-card:hover {{ border-color: rgba(59,130,246,0.4); }}
    .post-card .badge {{
      display: inline-block;
      background: rgba(59,130,246,0.1);
      color: #3b82f6;
      padding: 3px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      margin-bottom: 12px;
    }}
    .post-card h3 {{
      font-size: 20px;
      font-weight: 700;
      color: #f9fafb;
      margin-bottom: 8px;
    }}
    .post-card p {{ font-size: 15px; color: #9ca3af; }}
    .empty {{ text-align: center; padding: 80px 0; color: #6b7280; }}
    footer {{
      padding: 32px 0;
      text-align: center;
      color: #4b5563;
      font-size: 13px;
      border-top: 1px solid rgba(255,255,255,0.06);
    }}
  </style>
</head>
<body>

  <header>
    <div class="container">
      <div class="logo">
        <div class="shield">LL</div>
        <div class="wordmark">Lot<span>Logic</span></div>
      </div>
      <h1>Parking Enforcement Insights</h1>
      <p>Expert guides on ALPR technology, digital parking passes, and automated enforcement for property managers and tow companies.</p>
    </div>
  </header>

  <section class="posts">
    <div class="container">
      {cards if cards else '<div class="empty">Blog posts coming soon.</div>'}
    </div>
  </section>

  <footer>
    &copy; 2026 LotLogic LLC &middot; AI-powered parking enforcement
  </footer>

</body>
</html>"""


def rebuild_index(conn: Client) -> None:
    """Rebuild the blog index page from all published posts."""
    posts = get_published_posts(conn)
    html = render_blog_index(posts)
    index_path = os.path.join(BLOG_DIR, "index.html")
    os.makedirs(BLOG_DIR, exist_ok=True)
    with open(index_path, "w") as f:
        f.write(html)


def _escape(text: str) -> str:
    """Escape text for HTML attributes."""
    return (
        text.replace("&", "&amp;")
        .replace('"', "&quot;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )
