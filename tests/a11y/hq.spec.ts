import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { buildAndServeFrontend } from '../fixtures/buildAndServeFrontend';
import { BOARD } from '../fixtures/brainBoard';

// Served from THIS branch's build, not from production — same reasoning as
// tests/e2e/hq.spec.ts. Absolute path: buildAndServeFrontend's `cwd` option
// resolves against the test runner's process.cwd() (tests/), not this spec
// file's directory, so a relative 'frontend' resolves to the nonexistent
// tests/frontend.
const FRONTEND_DIR = path.resolve(__dirname, '../../frontend');
let server: Awaited<ReturnType<typeof buildAndServeFrontend>>;
test.beforeAll(async () => { server = await buildAndServeFrontend(FRONTEND_DIR); });
test.afterAll(async () => { await server.close(); });

async function openHq(page: Page) {
  await page.route('**/brain/board', r => r.fulfill({ json: BOARD }));
  await page.route('**/auth/me', r => r.fulfill({
    json: { email: 'a@b.c', is_platform_admin: true } }));
  await page.addInitScript(() => {
    localStorage.setItem('lotlogic_session', JSON.stringify(
      { _token: 'hq-test-token-test-only', _role: 'owner', is_platform_admin: true, _ts: Date.now() }));
    localStorage.setItem('lotlogic_tab', 'hq');
  });
  await page.goto(`${server.origin}/dashboard.html`);
  await expect(page.getByTestId('hq-root')).toBeVisible();
}

test('no serious or critical accessibility violations', async ({ page }) => {
  await openHq(page);
  const results = await new AxeBuilder({ page }).include('[data-testid="hq-root"]').analyze();
  const bad = results.violations.filter(v => ['serious', 'critical'].includes(v.impact!));
  expect(bad.map(v => `${v.id}: ${v.help}`)).toEqual([]);
});

test('health is never communicated by colour alone', async ({ page }) => {
  await openHq(page);
  const card = page.getByTestId('area-card').filter({ hasText: /ops/i });
  await expect(card).toContainText(/red|needs attention/i);
});

test('the answer field is reachable by keyboard from the question heading',
  async ({ page }) => {
    await openHq(page);
    // A real traversal: focus the first question's own heading, then Tab until
    // the textbox has focus, with a hard bound so a broken order fails instead
    // of looping.
    await page.getByTestId('question').first().getByRole('heading').focus();
    let reached = false;
    for (let i = 0; i < 10 && !reached; i++) {
      await page.keyboard.press('Tab');
      reached = await page.evaluate(() =>
        document.activeElement?.tagName === 'TEXTAREA' ||
        (document.activeElement as HTMLInputElement)?.type === 'text');
    }
    expect(reached).toBe(true);
  });

test('every close button names what it closes', async ({ page }) => {
  await openHq(page);
  const buttons = page.getByTestId('red-finding').getByRole('button', { name: /close/i });
  const count = await buttons.count();
  expect(count).toBe(2);
  for (let i = 0; i < count; i++) {
    const label = await buttons.nth(i).getAttribute('aria-label');
    expect(label, 'a bare "Close" is meaningless to a screen reader').toMatch(/close finding/i);
  }
});
