# LotLogic Playwright tests

Continuous end-to-end coverage for the dashboard, access control, and accessibility.

## Suites

- `e2e/access-control.spec.ts` — verifies each account can only see its own properties, across the UI, URL tampering, and direct API calls. This is the functional proof that the authz system works.
- `e2e/dashboard-smoke.spec.ts` — golden-path login, navigation, logout, offline resilience. Catches UX regressions.
- `a11y/axe.spec.ts` — axe-core sweep of public + logged-in pages. Fails on `serious`/`critical`; `minor`/`moderate` are reported but non-blocking.

## Running locally

```bash
cd tests
npm install
npx playwright install --with-deps chromium

# Point at your target. Defaults to the live beta URL.
export BASE_URL=https://lotlogic-beta.vercel.app
export API_URL=https://lotlogic-backend-production.up.railway.app

# Seeded test accounts (see scripts/seed-test-accounts.mjs)
export TEST_OWNER_A_EMAIL=playwright-owner-a@lotlogic.test
export TEST_OWNER_A_PASSWORD=...
export TEST_OWNER_B_EMAIL=playwright-owner-b@lotlogic.test
export TEST_OWNER_B_PASSWORD=...
export TEST_PARTNER_A_EMAIL=playwright-partner-a@lotlogic.test
export TEST_PARTNER_A_PASSWORD=...

npm test                # full suite
npm run test:access     # just access control
npm run test:smoke      # just smoke
npm run test:a11y       # just accessibility
npm run test:ui         # interactive UI mode
npm run report          # open the last HTML report
```

## Seeding test accounts

The seed script creates two owners and one enforcement partner, each with a password,
and assigns one lot to each owner so cross-tenant checks have real rows to compare.

```bash
ADMIN_API_KEY=... npm run seed
```

The backend exposes `POST /auth/seed-test-account` guarded by `ADMIN_API_KEY`.

## CI

`.github/workflows/playwright.yml` runs the full suite on every push and PR, against
the Vercel preview URL when available, otherwise the live beta. Test accounts are
read from GitHub Actions secrets.
