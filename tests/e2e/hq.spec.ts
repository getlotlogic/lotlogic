import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { buildAndServeFrontend } from '../fixtures/buildAndServeFrontend';
import { BOARD } from '../fixtures/brainBoard';

// Served from THIS branch's build, not from production: playwright.config.ts's
// baseURL points at the live Vercel site, which does not have this page.
// Absolute path, not the literal 'frontend' — buildAndServeFrontend's `cwd`
// option is resolved against the test runner's process.cwd() (tests/, the
// directory playwright is invoked from), not this spec file's directory, so
// a relative 'frontend' resolves to the nonexistent tests/frontend.
const FRONTEND_DIR = path.resolve(__dirname, '../../frontend');
let server: Awaited<ReturnType<typeof buildAndServeFrontend>>;
test.beforeAll(async () => { server = await buildAndServeFrontend(FRONTEND_DIR); });
test.afterAll(async () => { await server.close(); });

async function openHq(page: Page, { admin = true } = {}) {
  await page.route('**/brain/board', r => r.fulfill({ json: BOARD }));
  await page.route('**/auth/me', r => r.fulfill({
    json: { email: 'admin@example.com', is_platform_admin: admin },
  }));
  // No hash routing in this app: the tab is seeded the way the app itself
  // persists it (App.jsx:91-95).
  await page.addInitScript(() => {
    localStorage.setItem('lotlogic_session', JSON.stringify(
      { _token: 'hq-test-token-test-only', _role: 'owner', is_platform_admin: true, _ts: Date.now() }));
    localStorage.setItem('lotlogic_tab', 'hq');
  });
  await page.goto(`${server.origin}/dashboard.html`);
}

test('renders every section of the board', async ({ page }) => {
  await openHq(page);
  await expect(page.getByTestId('area-card')).toHaveCount(8);
  await expect(page.getByTestId('red-finding')).toHaveCount(2);
  await expect(page.getByTestId('question')).toHaveCount(3);
  await expect(page.getByTestId('fleet-health')).toContainText('150');
});

test('the tab survives the valid-tab coercion', async ({ page }) => {
  // App.jsx:171-177 coerces any tab not in `valid` back to 'lots'. This is the
  // assertion that the fourth edit was actually made.
  await openHq(page);
  await expect(page.getByTestId('hq-root')).toBeVisible();
  await expect(page.getByRole('tab', { name: /HQ/ })).toHaveAttribute('aria-selected', 'true');
});

test('clicking the HQ nav button opens it from another tab', async ({ page }) => {
  await page.route('**/brain/board', r => r.fulfill({ json: BOARD }));
  await page.route('**/auth/me', r => r.fulfill({
    json: { email: 'a@b.c', is_platform_admin: true } }));
  await page.addInitScript(() => {
    localStorage.setItem('lotlogic_session', JSON.stringify(
      { _token: 'hq-test-token-test-only', _role: 'owner', is_platform_admin: true, _ts: Date.now() }));
    localStorage.setItem('lotlogic_tab', 'lots');
  });
  await page.goto(`${server.origin}/dashboard.html`);
  await page.getByRole('tab', { name: /HQ/ }).click();
  await expect(page.getByTestId('hq-root')).toBeVisible();
});

test('sections appear in the spec order', async ({ page }) => {
  await openHq(page);
  const order = await page.$$eval('[data-section]',
    els => els.map(e => e.getAttribute('data-section')));
  expect(order).toEqual(['areas', 'priorities', 'red', 'questions', 'changed', 'fleet']);
});

test('the strip leads with the area that is red', async ({ page }) => {
  await openHq(page);
  const first = page.getByTestId('area-card').first();
  await expect(first).toHaveAttribute('data-health', 'red');
  await expect(first).toContainText(/ops/i);
  await expect(first).toContainText('2');
});

test('every area the board sends gets a card', async ({ page }) => {
  await openHq(page);
  const slugs = await page.$$eval('[data-testid="area-card"]',
    els => els.map(e => e.getAttribute('data-area')));
  expect(new Set(slugs)).toEqual(new Set(
    ['ops', 'evidence', 'money', 'customers', 'code', 'marketing', 'sales', 'cross']));
});

test('no card says business', async ({ page }) => {
  await openHq(page);
  expect((await page.locator('body').innerText()).toLowerCase()).not.toContain('business');
});

test('answering a question posts it and removes it from the list', async ({ page }) => {
  let posted: any = null;
  await page.route('**/brain/questions/*/answer', r => {
    posted = r.request().postDataJSON();
    return r.fulfill({ json: { answered: true, state: 'answered' } });
  });
  await openHq(page);
  const q = page.getByTestId('question').first();
  await q.getByRole('textbox').fill('yes, up to $200');
  await q.getByRole('button', { name: /answer/i }).click();
  await expect.poll(() => posted?.answer).toBe('yes, up to $200');
  await expect(page.getByTestId('question')).toHaveCount(2);
});

test('closing a red finding asks for a reason and posts it', async ({ page }) => {
  let posted: any = null;
  await page.route('**/brain/findings/*/close', r => {
    posted = r.request().postDataJSON();
    return r.fulfill({ json: { closed: true } });
  });
  await openHq(page);
  await page.getByTestId('red-finding').first().getByRole('button', { name: /close/i }).click();
  await page.getByTestId('close-reason').fill('pool resized');
  await page.getByRole('button', { name: /confirm/i }).click();
  await expect.poll(() => posted?.reason).toBe('pool resized');
});

test('a failed refresh keeps the last good board on screen', async ({ page }) => {
  await openHq(page);
  await expect(page.getByTestId('red-finding')).toHaveCount(2);
  await page.route('**/brain/board', r => r.fulfill({ status: 503, json: {} }));
  await page.getByTestId('hq-refresh').click();
  await expect(page.getByTestId('red-finding')).toHaveCount(2);
  await expect(page.getByTestId('hq-stale')).toBeVisible();
});

test('a cold failure on the first fetch shows Board unavailable with a working Refresh', async ({ page }) => {
  // Distinct from "a failed refresh keeps the last good board on screen"
  // above: there the FIRST fetch succeeds and only the SECOND fails. Here
  // the very first /brain/board call fails (a platform admin who opens HQ
  // during an outage), so there is no last-good board to fall back on.
  let calls = 0;
  await page.route('**/brain/board', r => {
    calls += 1;
    return calls === 1
      ? r.fulfill({ status: 503, json: { detail: 'database unavailable' } })
      : r.fulfill({ json: BOARD });
  });
  await page.route('**/auth/me', r => r.fulfill({
    json: { email: 'a@b.c', is_platform_admin: true } }));
  await page.addInitScript(() => {
    localStorage.setItem('lotlogic_session', JSON.stringify(
      { _token: 'hq-test-token-test-only', _role: 'owner', is_platform_admin: true, _ts: Date.now() }));
    localStorage.setItem('lotlogic_tab', 'hq');
  });
  await page.goto(`${server.origin}/dashboard.html`);

  const unavailable = page.getByTestId('hq-unavailable');
  await expect(unavailable).toBeVisible();
  await expect(unavailable).toContainText(/board unavailable/i);
  await expect(unavailable).toContainText('database unavailable');
  await expect(unavailable.getByTestId('hq-refresh')).toBeVisible();

  // Refresh re-fetches — the second call above succeeds, so the real board
  // replaces the unavailable card.
  await unavailable.getByTestId('hq-refresh').click();
  await expect(page.getByTestId('hq-root')).toBeVisible();
  await expect(page.getByTestId('area-card')).toHaveCount(8);
  expect(calls).toBeGreaterThanOrEqual(2);
});

test('a non-platform-admin never sees the tab', async ({ page }) => {
  await openHq(page, { admin: false });
  await expect(page.getByRole('tab', { name: /HQ/ })).toHaveCount(0);
  await expect(page.getByTestId('hq-root')).toHaveCount(0);
});

test('the page never uses a forbidden word', async ({ page }) => {
  await openHq(page);
  const text = await page.locator('body').innerText();
  for (const word of ['Resident', 'Visitor', 'Permanent', 'Temporary', 'Guest', 'Driver']) {
    expect(text).not.toContain(word);
  }
});
