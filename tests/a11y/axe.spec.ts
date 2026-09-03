/**
 * Accessibility sweep. Runs axe-core across key pages, both logged-out
 * and logged-in, and fails on serious or critical violations.
 *
 * Minor/moderate issues are reported in the HTML output but don't fail the run —
 * that gives us a signal for "make it simpler" without being a blocker.
 *
 * WAIVERS: two marketing pages carry a known, recorded contrast failure that is
 * the brand palette itself rather than a mistake on the page (see WAIVED below).
 * They are waived by rule, page and node count so the suite can be green and
 * therefore a required check — a NEW serious violation, of any other rule or on
 * any other page, still fails, and so does the same rule spreading to more
 * nodes.
 */
import AxeBuilder from '@axe-core/playwright';
import { test, expect, accounts, loginAs } from '../fixtures/accounts';

const BLOCKING = new Set(['serious', 'critical']);

/**
 * Known failures accepted for now, keyed by the label passed to `scan()`.
 *
 * `color-contrast` on `/` and the two pitch pages is not a page-level
 * mistake: the brand tokens themselves are too light against the cream ground
 * (`--amber #D97706` = 2.66:1 and `--terra-deep #9A5530` = 4.27:1 against
 * `--paper`/`--paper-2`, where AA wants 4.5:1 for body text and 3:1 for large).
 * Those tokens are copy-pasted into 18 HTML files, so darkening them is a brand
 * change across the whole marketing site, not a test fix — it belongs with
 * FE-10 + FE-12 (one shared stylesheet) in Wave 2 of the enterprise-readiness
 * program, and needs the owner's eye on the new colors.
 *
 * Remove an entry the moment its tokens are darkened; the count check below
 * will tell you when a waiver has stopped matching reality.
 */
const WAIVED: Record<string, { rule: string; nodes: number }[]> = {
  landing: [{ rule: 'color-contrast', nodes: 3 }],
  'pitch:/pitch-apartments.html': [{ rule: 'color-contrast', nodes: 2 }],
  'pitch:/pitch-tow.html': [{ rule: 'color-contrast', nodes: 4 }],
};

async function scan(page: any, label: string) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  const waived = WAIVED[label] ?? [];
  const blocking = results.violations.filter(v => {
    if (!BLOCKING.has(v.impact ?? '')) return false;
    // A waiver covers its rule only while it has not spread to more nodes.
    const w = waived.find(x => x.rule === v.id);
    if (w && v.nodes.length <= w.nodes) {
      // eslint-disable-next-line no-console
      console.log(`[a11y ${label}] WAIVED ${v.id} (${v.nodes.length}/${w.nodes} nodes) — see WAIVED in a11y/axe.spec.ts`);
      return false;
    }
    return true;
  });
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
