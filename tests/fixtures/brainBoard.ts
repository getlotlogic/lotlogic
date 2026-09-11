// Fixture for the HQ tab's GET /brain/board — shaped exactly per
// CONTRACTS.md §4. No real plate, phone number or name appears anywhere in
// here; every id and worker below is invented for the test. `areas` below
// are CONTRACTS §1's eight areas (Task 24 Step 0 / spec §9.5, ruling SC-2),
// replacing the old four-business dimension the strip used to render.
export const BOARD = {
  generated_at: '2026-09-11T18:03:00Z',
  areas: [
    {
      slug: 'ops', name: 'Ops', health: 'red',
      open_high: 2, open_total: 7, last_run_at: '2026-09-11T17:00:00Z',
      spend_today_usd: 12.40,
    },
    {
      slug: 'evidence', name: 'Evidence', health: 'green',
      open_high: 0, open_total: 1, last_run_at: '2026-09-11T17:05:00Z',
      spend_today_usd: 0.20,
    },
    {
      slug: 'money', name: 'Money', health: 'amber',
      open_high: 0, open_total: 3, last_run_at: '2026-09-11T16:30:00Z',
      spend_today_usd: 4.10,
    },
    {
      slug: 'customers', name: 'Customers', health: 'green',
      open_high: 0, open_total: 0, last_run_at: '2026-09-11T17:10:00Z',
      spend_today_usd: 1.05,
    },
    {
      slug: 'code', name: 'Code', health: 'green',
      open_high: 0, open_total: 0, last_run_at: '2026-09-11T17:12:00Z',
      spend_today_usd: 0.50,
    },
    {
      slug: 'marketing', name: 'Marketing', health: 'green',
      open_high: 0, open_total: 0, last_run_at: '2026-09-11T17:15:00Z',
      spend_today_usd: 0.10,
    },
    {
      slug: 'sales', name: 'Sales', health: 'green',
      open_high: 0, open_total: 0, last_run_at: '2026-09-11T17:18:00Z',
      spend_today_usd: 0.05,
    },
    {
      slug: 'cross', name: 'Cross', health: 'green',
      open_high: 0, open_total: 1, last_run_at: '2026-09-11T17:20:00Z',
      spend_today_usd: 0.20,
    },
  ],
  priorities: [
    'Keep the Supabase pool under 80% before onboarding a new worker.',
    'No spend gate over $200 goes unanswered for more than a day.',
    'Ship the deadman sweep before onboarding a ninth area.',
  ],
  red: [
    {
      id: 31, fingerprint: 'ops:db-pool-saturated', area: 'ops',
      worker: 'ops-db-health',
      title: 'Supabase connection pool held above 90% for six hours straight.',
      evidence_url: 'https://example.com/evidence/db-pool-saturated',
      seen_count: 3,
      first_seen_at: '2026-09-11T12:00:00Z', last_seen_at: '2026-09-11T17:45:00Z',
    },
    {
      id: 32, fingerprint: 'ops:camera-gap-north', area: 'ops',
      worker: 'ops-camera-health',
      title: 'South gate camera has not reported a heartbeat in 40 minutes.',
      evidence_url: 'https://example.com/evidence/camera-gap-north',
      seen_count: 5,
      first_seen_at: '2026-09-11T10:00:00Z', last_seen_at: '2026-09-11T17:50:00Z',
    },
  ],
  changed_this_week: [
    { kind: 'decision', area: 'ops', title: 'Closed db-pool-saturated after resizing the pool.', at: '2026-09-11T15:00:00Z', worker: 'ops-db-health' },
    { kind: 'fact', area: 'ops', title: 'Supabase pool size raised from 8 to 12 connections.', at: '2026-09-11T14:00:00Z', worker: 'ops-db-health' },
    { kind: 'metric', area: 'money', title: 'Weekly billing review count: 14.', at: '2026-09-10T09:00:00Z', worker: 'money-billing-audit' },
    { kind: 'decision', area: 'customers', title: 'Approved a partner fee-schedule change for a Charlotte plaza.', at: '2026-09-09T18:00:00Z', worker: 'customers-partner-fees' },
    { kind: 'fact', area: 'cross', title: 'Fleet budget raised to $150 a day.', at: '2026-09-08T10:00:00Z', worker: 'brain-deadman' },
    { kind: 'metric', area: 'evidence', title: 'Plate-match confidence this week: 96%.', at: '2026-09-07T09:00:00Z', worker: 'evidence-plate-quality' },
  ],
  questions: [
    {
      id: 101, area: 'money', worker: 'money-billing-audit',
      question: 'Refund a customer up to $200 for a double tow charge?',
      context: 'Camera confirms one tow event; the billing system posted two charges for it.',
      gate_kind: 'spend', asked_at: '2026-09-10T12:00:00Z',
    },
    {
      id: 102, area: 'customers', worker: 'customers-partner-comms',
      question: 'Send a reply to a partner disputing a fee-schedule change?',
      context: 'Draft reply attached — the partner claims the new fee posted early, billing logs show it matched the effective date.',
      gate_kind: 'email_customer', asked_at: '2026-09-10T13:00:00Z',
    },
    {
      id: 103, area: 'evidence', worker: 'evidence-plate-pairs',
      question: 'Merge two plate records that look like the same truck?',
      context: 'Same USDOT number on both, one-character OCR drift between the two reads.',
      gate_kind: 'merge', asked_at: '2026-09-10T14:00:00Z',
    },
  ],
  fleet: {
    runs_24h: 612, ok_24h: 598, failed_24h: 14,
    spend_today_usd: 41.20, budget_usd: 150, cap: 60, running: 9,
    dead_workers: ['sales-lead-followup'], budget_stop: false,
  },
};
