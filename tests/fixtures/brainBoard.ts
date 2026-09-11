// Fixture for the HQ tab's GET /brain/board — shaped exactly per
// CONTRACTS.md §4. No real plate, phone number or name appears anywhere in
// here; every id, worker and business below is invented for the test.
export const BOARD = {
  generated_at: '2026-09-11T18:03:00Z',
  businesses: [
    {
      slug: 'lotlogic', name: 'LotLogic', health: 'red',
      open_high: 2, open_total: 7, last_run_at: '2026-09-11T17:00:00Z',
      spend_today_usd: 12.40,
    },
    {
      slug: 'standard_water', name: 'Standard Water', health: 'amber',
      open_high: 0, open_total: 3, last_run_at: '2026-09-11T16:30:00Z',
      spend_today_usd: 4.10,
    },
    {
      slug: 'standard_vending', name: 'Standard Vending', health: 'green',
      open_high: 0, open_total: 0, last_run_at: '2026-09-11T17:10:00Z',
      spend_today_usd: 1.05,
    },
    {
      slug: 'cross', name: 'Cross-business', health: 'green',
      open_high: 0, open_total: 1, last_run_at: '2026-09-11T17:05:00Z',
      spend_today_usd: 0.20,
    },
  ],
  priorities: [
    'Keep the Supabase pool under 80% before onboarding a new worker.',
    'No spend gate over $200 goes unanswered for more than a day.',
    'Ship the deadman sweep before adding a fifth business.',
  ],
  red: [
    {
      id: 31, fingerprint: 'db-pool-saturated', business: 'lotlogic',
      worker: 'lotlogic-db-health',
      title: 'Supabase connection pool held above 90% for six hours straight.',
      evidence_url: 'https://example.com/evidence/db-pool-saturated',
      seen_count: 3,
      first_seen_at: '2026-09-11T12:00:00Z', last_seen_at: '2026-09-11T17:45:00Z',
    },
    {
      id: 32, fingerprint: 'camera-heartbeat-stale', business: 'lotlogic',
      worker: 'lotlogic-camera-health',
      title: 'South gate camera has not reported a heartbeat in 40 minutes.',
      evidence_url: 'https://example.com/evidence/camera-heartbeat-stale',
      seen_count: 5,
      first_seen_at: '2026-09-11T10:00:00Z', last_seen_at: '2026-09-11T17:50:00Z',
    },
  ],
  changed_this_week: [
    { kind: 'decision', business: 'lotlogic', title: 'Closed db-pool-saturated after resizing the pool.', at: '2026-09-11T15:00:00Z', worker: 'lotlogic-db-health' },
    { kind: 'fact', business: 'lotlogic', title: 'Supabase pool size raised from 8 to 12 connections.', at: '2026-09-11T14:00:00Z', worker: 'lotlogic-db-health' },
    { kind: 'metric', business: 'standard_water', title: 'Weekly review count: 14.', at: '2026-09-10T09:00:00Z', worker: 'water-reviews' },
    { kind: 'decision', business: 'standard_vending', title: 'Approved a restock of the Pavilion Blvd machine.', at: '2026-09-09T18:00:00Z', worker: 'vending-restock' },
    { kind: 'fact', business: 'cross', title: 'Fleet budget raised to $150 a day.', at: '2026-09-08T10:00:00Z', worker: 'brain-deadman' },
    { kind: 'metric', business: 'lotlogic', title: 'Passes issued per day: 41.', at: '2026-09-07T09:00:00Z', worker: 'lotlogic-metrics' },
  ],
  questions: [
    {
      id: 101, business: 'lotlogic', worker: 'lotlogic-billing-audit',
      question: 'Refund a customer up to $200 for a double tow charge?',
      context: 'Camera confirms one tow event; the billing system posted two charges for it.',
      gate_kind: 'spend', asked_at: '2026-09-10T12:00:00Z',
    },
    {
      id: 102, business: 'standard_water', worker: 'water-reviews',
      question: 'Send a reply to a one-star review disputing delivery timing?',
      context: 'Draft reply attached — the review claims a late delivery, dispatch logs show it was on time.',
      gate_kind: 'email_customer', asked_at: '2026-09-10T13:00:00Z',
    },
    {
      id: 103, business: 'lotlogic', worker: 'lotlogic-plate-pairs',
      question: 'Merge two plate records that look like the same truck?',
      context: 'Same USDOT number on both, one-character OCR drift between the two reads.',
      gate_kind: 'merge', asked_at: '2026-09-10T14:00:00Z',
    },
  ],
  fleet: {
    runs_24h: 612, ok_24h: 598, failed_24h: 14,
    spend_today_usd: 41.20, budget_usd: 150, cap: 60, running: 9,
    dead_workers: ['water-reviews'], budget_stop: false,
  },
};
