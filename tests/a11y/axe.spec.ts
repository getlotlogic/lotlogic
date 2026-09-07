/**
 * Accessibility sweep. Runs axe-core across key pages, both logged-out
 * and logged-in, and fails on serious or critical violations.
 *
 * Minor/moderate issues are reported in the HTML output but don't fail the run —
 * that gives us a signal for "make it simpler" without being a blocker.
 *
 * WAIVERS: a handful of known, recorded violations are waived rather than
 * blocking the suite — see WAIVED below for exactly which rule, which page,
 * how many nodes, and why. They're waived by rule + page + node count so the
 * suite can be green and therefore a required check — a NEW serious
 * violation, of any other rule or on any other page, still fails, and so does
 * the same rule spreading to more nodes.
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
 *
 * `dashboard-owner` had the same class of problem (header wordmark, "+ Add
 * Lot" pill, six bottom-nav labels) plus a real `aria-required-parent` bug
 * (six bottom-nav `role="tab"` buttons + the active one counted twice by
 * axe, missing a `role="tablist"` wrapper). Wave 2 Task 15 (FE-10) fixed
 * both: `--accent`/`--yellow` #C2580B -> #B85309 (4.91:1), `.theme-light
 * .nav-item` #9ca3af -> #6B7280 (4.83:1), the "+ Add Lot" pill's inline
 * `#4ade80` -> `#15803D` (4.66:1 on its tint), and `frontend/src/App.jsx`'s
 * bottom nav now wraps its tab buttons in a `role="tablist"` div. This suite
 * runs against BASE_URL (the deployed site), not the local file, so these
 * fixes can't be proven here until this branch ships — this waiver entry is
 * removed now on the strength of the local contrast-checker + computed-style
 * proof (see Task 15's report); if the deployed scan still fails on either
 * rule, that's a real regression, not a stale waiver.
 *
 * The landing/pitch `color-contrast` waivers remain: `--amber`,
 * `--terra-deep`, `--ink-4` are copy-pasted into 18 HTML files and land in
 * Task 16's shared stylesheet (FE-12), not here. Remove those entries the
 * moment Task 16 darkens the tokens; the node-count check below will tell
 * you when a waiver has stopped matching reality.
 *
 * The WAIVED map stays in place (not deleted) as the documented home for
 * the two waivers above. Once Task 16 darkens the marketing tokens and
 * those two entries are removed, the map goes empty — leave it as an empty
 * `{}` rather than deleting it: it's the extension point for `scan()`'s
 * node-count-drift check, empty on purpose, not dead code.
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
