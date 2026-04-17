import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.BASE_URL ?? 'https://lotlogic-beta.vercel.app';
const API_URL = process.env.API_URL ?? 'https://lotlogic-backend-production.up.railway.app';

export default defineConfig({
  testDir: './',
  testMatch: ['e2e/**/*.spec.ts', 'a11y/**/*.spec.ts'],
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
