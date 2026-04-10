-- Migration 008: Lead Generation + Agent Tables
-- Adds leadgen pipeline tables (migrated from local SQLite) and agent state/logs
-- Supports the autonomous Claude-powered lead gen agent running on Railway cron

-- ── Lead gen: scraped businesses ──
CREATE TABLE IF NOT EXISTS leadgen_leads (
    id BIGSERIAL PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('apartment', 'tow')),
    company_name TEXT NOT NULL,
    address TEXT,
    city TEXT,
    state TEXT,
    zip TEXT,
    phone TEXT,
    website TEXT,
    google_maps_url TEXT,
    rating REAL,
    review_count INTEGER,
    source TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (company_name, city, state)
);

-- ── Lead gen: email contacts per lead ──
CREATE TABLE IF NOT EXISTS leadgen_contacts (
    id BIGSERIAL PRIMARY KEY,
    lead_id BIGINT REFERENCES leadgen_leads(id) ON DELETE CASCADE,
    name TEXT,
    email TEXT NOT NULL,
    role TEXT,
    source TEXT,
    verified BOOLEAN DEFAULT FALSE,
    bounced BOOLEAN DEFAULT FALSE,
    unsubscribed BOOLEAN DEFAULT FALSE,
    replied BOOLEAN DEFAULT FALSE,
    last_reply_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (lead_id, email)
);

-- ── Lead gen: emails sent log ──
CREATE TABLE IF NOT EXISTS leadgen_emails_sent (
    id BIGSERIAL PRIMARY KEY,
    contact_id BIGINT REFERENCES leadgen_contacts(id) ON DELETE CASCADE,
    template_name TEXT NOT NULL,
    subject TEXT NOT NULL,
    sent_at TIMESTAMPTZ DEFAULT NOW(),
    status TEXT DEFAULT 'sent',
    message_id TEXT,
    gmail_thread_id TEXT
);

-- ── Lead gen: scheduled follow-ups ──
CREATE TABLE IF NOT EXISTS leadgen_email_queue (
    id BIGSERIAL PRIMARY KEY,
    contact_id BIGINT REFERENCES leadgen_contacts(id) ON DELETE CASCADE,
    template_name TEXT NOT NULL,
    scheduled_for TIMESTAMPTZ NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (contact_id, template_name)
);

-- ── Agent: per-run decision log ──
CREATE TABLE IF NOT EXISTS agent_logs (
    id BIGSERIAL PRIMARY KEY,
    run_id UUID DEFAULT gen_random_uuid(),
    run_started_at TIMESTAMPTZ DEFAULT NOW(),
    run_completed_at TIMESTAMPTZ,
    status TEXT DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
    claude_plan JSONB,
    actions_taken JSONB,
    outcomes JSONB,
    errors JSONB,
    summary TEXT
);

-- ── Agent: persistent state across runs ──
CREATE TABLE IF NOT EXISTS agent_state (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Indexes ──
CREATE INDEX IF NOT EXISTS idx_leadgen_emails_sent_contact ON leadgen_emails_sent(contact_id);
CREATE INDEX IF NOT EXISTS idx_leadgen_emails_sent_template ON leadgen_emails_sent(template_name);
CREATE INDEX IF NOT EXISTS idx_leadgen_emails_sent_at ON leadgen_emails_sent(sent_at);
CREATE INDEX IF NOT EXISTS idx_leadgen_contacts_lead ON leadgen_contacts(lead_id);
CREATE INDEX IF NOT EXISTS idx_leadgen_contacts_bounced ON leadgen_contacts(bounced) WHERE bounced = TRUE;
CREATE INDEX IF NOT EXISTS idx_leadgen_contacts_unsubscribed ON leadgen_contacts(unsubscribed) WHERE unsubscribed = TRUE;
CREATE INDEX IF NOT EXISTS idx_leadgen_queue_due ON leadgen_email_queue(scheduled_for, status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_leadgen_leads_type_city ON leadgen_leads(type, city);
CREATE INDEX IF NOT EXISTS idx_agent_logs_started ON agent_logs(run_started_at DESC);
