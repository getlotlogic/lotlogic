#!/usr/bin/env node
/**
 * Seed two lot_owners and one enforcement_partner for Playwright testing,
 * each with a password, an assigned lot, and deterministic IDs.
 *
 * Usage:
 *   API_URL=https://... ADMIN_API_KEY=... node scripts/seed-test-accounts.mjs
 *
 * Reads desired emails/passwords from env:
 *   TEST_OWNER_A_EMAIL, TEST_OWNER_A_PASSWORD
 *   TEST_OWNER_B_EMAIL, TEST_OWNER_B_PASSWORD
 *   TEST_PARTNER_A_EMAIL, TEST_PARTNER_A_PASSWORD
 *
 * Requires the backend /auth/seed-test-account endpoint (gated on ADMIN_API_KEY)
 * which is a no-op in production.
 */

const API_URL = process.env.API_URL ?? 'https://lotlogic-backend-production.up.railway.app';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

if (!ADMIN_API_KEY) {
  console.error('ADMIN_API_KEY is required.');
  process.exit(1);
}

const accounts = [
  {
    role: 'owner',
    email: process.env.TEST_OWNER_A_EMAIL ?? 'playwright-owner-a@lotlogic.test',
    password: process.env.TEST_OWNER_A_PASSWORD ?? 'playwright-a-pw-please-rotate',
    business_name: 'Playwright Owner A',
    with_lot: true,
  },
  {
    role: 'owner',
    email: process.env.TEST_OWNER_B_EMAIL ?? 'playwright-owner-b@lotlogic.test',
    password: process.env.TEST_OWNER_B_PASSWORD ?? 'playwright-b-pw-please-rotate',
    business_name: 'Playwright Owner B',
    with_lot: true,
  },
  {
    role: 'partner',
    email: process.env.TEST_PARTNER_A_EMAIL ?? 'playwright-partner-a@lotlogic.test',
    password: process.env.TEST_PARTNER_A_PASSWORD ?? 'playwright-partner-pw-please-rotate',
    company_name: 'Playwright Partner A',
    with_lot: false,
  },
];

for (const acct of accounts) {
  const res = await fetch(`${API_URL}/auth/seed-test-account`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Admin-Key': ADMIN_API_KEY,
    },
    body: JSON.stringify(acct),
  });
  if (!res.ok) {
    console.error(`seed failed for ${acct.email}: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const body = await res.json();
  console.log(`seeded ${acct.role} ${acct.email} → id ${body.id}`);
}
