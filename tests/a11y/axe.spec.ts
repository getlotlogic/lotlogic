/**
 * Accessibility sweep. Runs axe-core across key pages, both logged-out
 * and logged-in, and fails on serious or critical violations.
 *
 * Minor/moderate issues are reported in the HTML output but don't fail the run —
 * that gives us a signal for "make it simpler" without being a blocker.
 */
import AxeBuilder from '@axe-core/playwright';
import { test, expect, accounts, loginAs } from '../fixtures/accounts';

const BLOCKING = new Set(['serious', 'critical']);

async function scan(page: any, label: string) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  const blocking = results.violations.filter(v => BLOCKING.has(v.impact ?? ''));
  const summary = results.violations.map(v => ({
    id: v.id,
    impact: v.impact,
    nodes: v.nodes.length,
    help: v.help,
  }));
  // eslint-disable-next-line no-console
  console.log(`[a11y ${label}] ${summary.length} violations:`, JSON.stringify(summary, null, 2));

  expect(
    blocking,
    `serious/critical a11y violations on ${label}:\n${JSON.stringify(blocking, null, 2)}`
  ).toEqual([]);
}

test.describe('accessibility @a11y', () => {
  test('landing page has no serious a11y violations', async ({ page }) => {
    await page.goto('/');
    await scan(page, 'landing');
  });

  test('login page has no serious a11y violations', async ({ page }) => {
    await page.goto('/dashboard.html');
    await scan(page, 'login');
  });

  test('dashboard (owner) has no serious a11y violations', async ({ page }) => {
    await loginAs(page, accounts.ownerA());
    await scan(page, 'dashboard-owner');
  });

  test('marketing pitch pages are accessible', async ({ page }) => {
    for (const path of ['/pitch-apartments.html', '/pitch-tow.html']) {
      await page.goto(path);
      await scan(page, `pitch:${path}`);
    }
  });
});
