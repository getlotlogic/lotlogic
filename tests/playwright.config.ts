import { defineConfig, devices } from '@playwright/test';

// The portal suite (Task 30, tests/README.md "Portal suite") runs only with
// PORTAL_E2E=1, against a LOCAL backend and this branch's build, which
// `fixtures/portalGlobalSetup.ts` serves on a fixed origin the backend's CORS
// allow-list names. Under PORTAL_E2E the defaults follow that: BASE_URL is the
// served build and API_URL the local backend — never production.
const PORTAL_E2E = process.env.PORTAL_E2E === '1';
const PORTAL_FRONTEND_ORIGIN = `http://127.0.0.1:${process.env.PORTAL_FRONTEND_PORT ?? 4173}`;
const BASE_URL = process.env.BASE_URL
  ?? (PORTAL_E2E ? PORTAL_FRONTEND_ORIGIN : 'https://lotlogic-beta.vercel.app');
const API_URL = process.env.API_URL
  ?? (PORTAL_E2E ? 'http://localhost:8010' : 'https://lotlogic-backend-production.up.railway.app');
if (PORTAL_E2E) process.env.API_URL = API_URL;

// Vercel Preview deployments sit behind Deployment Protection (confirmed:
// `curl <preview>/dashboard.html` 302s to vercel.com/sso-api). Vercel's
// documented escape hatch for automation is a per-project "Protection Bypass
// for Automation" secret, sent as a header — see
// https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection#protection-bypass-for-automation.
// Only set when the secret is present; against production/live-beta this is
// simply absent and the headers are omitted.
const BYPASS_SECRET = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
const bypassHeaders: Record<string, string> = BYPASS_SECRET
  ? { 'x-vercel-protection-bypass': BYPASS_SECRET, 'x-vercel-set-bypass-cookie': 'true' }
  : {};

export default defineConfig({
  testDir: './',
  testMatch: ['e2e/**/*.spec.ts', 'a11y/**/*.spec.ts'],
  globalSetup: './fixtures/portalGlobalSetup.ts',
  // `@portal` specs need the local backend; without PORTAL_E2E they are
  // skipped inside the spec (`skipUnlessPortal()`), so a plain `npx
  // playwright test` reports them as skipped, never failed. `--grep @portal`
  // selects exactly the portal suite.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
    ['json', { outputFile: 'playwright-report/results.json' }],
  ],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    extraHTTPHeaders: {
      'x-lotlogic-test': '1',
      ...bypassHeaders,
    },
  },
  projects: [
    {
      name: 'chromium-desktop',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-safari',
      use: { ...devices['iPhone 14'] },
      grepInvert: /@desktop-only/,
    },
  ],
  metadata: {
    baseUrl: BASE_URL,
    apiUrl: API_URL,
  },
});
