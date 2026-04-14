-- Migration 009: Marketing & SEO tables
-- Adds blog posts, Reddit leads, and marketing funnel tracking

-- ── Blog posts (SEO content engine) ──
CREATE TABLE IF NOT EXISTS blog_posts (
    id BIGSERIAL PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    meta_description TEXT,
    target_keyword TEXT,
    target_audience TEXT CHECK (target_audience IN ('apartment', 'tow', 'general')),
    body_html TEXT NOT NULL,
    published BOOLEAN DEFAULT FALSE,
    published_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Reddit leads (social media pipeline) ──
CREATE TABLE IF NOT EXISTS reddit_leads (
    id BIGSERIAL PRIMARY KEY,
    post_id TEXT NOT NULL UNIQUE,
    subreddit TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    author TEXT,
    url TEXT NOT NULL,
    score INTEGER DEFAULT 0,
    num_comments INTEGER DEFAULT 0,
    relevance_score REAL,
    target_audience TEXT CHECK (target_audience IN ('apartment', 'tow', 'general')),
    status TEXT DEFAULT 'new' CHECK (status IN ('new', 'drafted', 'replied', 'skipped')),
    draft_reply TEXT,
    replied_at TIMESTAMPTZ,
    discovered_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Marketing funnel events (track pitch page → demo request conversions) ──
CREATE TABLE IF NOT EXISTS funnel_events (
    id BIGSERIAL PRIMARY KEY,
    source TEXT NOT NULL,
    medium TEXT,
    page TEXT,
    event_type TEXT NOT NULL CHECK (event_type IN ('page_view', 'cta_click', 'demo_request', 'reply')),
    referrer TEXT,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Indexes ──
CREATE INDEX IF NOT EXISTS idx_blog_posts_published ON blog_posts(published, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_blog_posts_keyword ON blog_posts(target_keyword);
CREATE INDEX IF NOT EXISTS idx_reddit_leads_status ON reddit_leads(status);
CREATE INDEX IF NOT EXISTS idx_reddit_leads_subreddit ON reddit_leads(subreddit);
CREATE INDEX IF NOT EXISTS idx_funnel_events_source ON funnel_events(source, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_funnel_events_type ON funnel_events(event_type, created_at DESC);
