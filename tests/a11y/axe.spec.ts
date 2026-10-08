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
import { test as baseTest } from '@playwright/test';
import { buildAndServeFrontend, type BuiltFrontendServer } from '../fixtures/buildAndServeFrontend';
import path from 'node:path';

const BLOCKING = new Set(['serious', 'critical']);

/**
 * Known failures accepted for now, keyed by the label passed to `scan()`.
 *
 * Both waivers that used to live here are retired.
 *
 * The `/` and pitch-page `color-contrast` waivers: FE-10 darkened the brand
 * tokens and FE-12 (Task 16) moved them out of 18 copy-pasted `:root` blocks
 * into one shared `frontend/styles/brand.css` that every marketing page links.
 * The Slice-3 fix round re-solved every text token against `--paper-3` too —
 * the third paper ground, a real content background that Tasks 15/16 never
 * measured, on which all six were still failing: `--ink-3` -> `#625848`,
 * `--ink-4` -> `#5F5746`, `--amber` -> `#874904`, `--terra-deep` -> `#84461B`,
 * `--status-ok` -> `#3A6039`, `--status-no` -> `#993A2C` (>= 4.66:1 on all
 * three grounds).
 *
 * `dashboard-owner` had the same class of problem (header wordmark, "+ Add
 * Lot" pill, six bottom-nav labels) plus a real `aria-required-parent` bug
 * (six bottom-nav `role="tab"` buttons + the active one counted twice by
 * axe, missing a `role="tablist"` wrapper). Wave 2 Task 15 (FE-10) fixed
 * both: `--accent`/`--yellow` #C2580B -> #B85309 (4.91:1), `.theme-light
 * .nav-item` #9ca3af -> #6B7280 (4.83:1), the "+ Add Lot" pill's inline
 * `#4ade80` -> `#15803D`, and `frontend/src/App.jsx`'s
 * bottom nav now wraps its tab buttons in a `role="tablist"` div. This suite
 * runs against BASE_URL (the deployed site), not the local file, so these
 * fixes can't be proven here until this branch ships — the waiver entries are
 * removed now on the strength of the local contrast-checker + computed-style
 * proof (see Tasks 15 and 16's reports); if the deployed scan still fails on
 * any of these rules, that's a real regression, not a stale waiver.
 *
 * The pill's `#15803D` was itself wrong: it was measured only against the
 * light theme's tint and scores 3.09:1 on the dark one. No single literal
 * clears both grounds, so it is now `var(--text-primary)` (14.18:1 dark /
 * 15.28:1 light) — Ruling S3-b.
 *
 * The WAIVED map stays in place (not deleted) as the documented home for
 * this pattern. Re-add an entry here only if a real new violation shows up
 * against the preview — leave the map as an empty `{}` otherwise: it's the
 * extension point for `scan()`'s node-count-drift check, empty on purpose,
 * not dead code.
 */
const WAIVED: Record<string, { rule: string; nodes: number }[]> = {};

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

  // @auth — needs TEST_OWNER_A_* credentials. CI's offline `pull_request` job
  // runs this file with `--grep-invert @auth`, so this is the one case that is
  // skipped there; the credentialed preview job runs the whole file.
  test('dashboard (owner) has no serious a11y violations @auth', async ({ page }) => {
    await loginAs(page, accounts.ownerA());
    await scan(page, 'dashboard-owner');
  });

  test('marketing pitch pages are accessible', async ({ page }) => {
    for (const path of ['/pitch-apartments.html', '/pitch-tow.html']) {
      await page.goto(path);
      await scan(page, `pitch:${path}`);
    }
  });

  // Ruling S3-c. These two were the pages the marketing-token fix (Task 16)
  // changed but nothing scanned: services.html and brand-v2.html are the only
  // two that put token-coloured text on `--paper-3`, the ground Tasks 15/16
  // never measured. They are unauthenticated, so they run in CI's local-dist
  // job as well as against the preview.
  test('services and brand pages are accessible', async ({ page }) => {
    for (const path of ['/services.html', '/brand-v2.html']) {
      await page.goto(path);
      await scan(page, `marketing:${path}`);
    }
  });
});

// ── team-owner / pending-membership (Task 24, spec §5.7 / §3.7 (b)) ────────
//
// Neither page needs a login or a backend to render meaningfully — Team is
// one property's membership list, PendingMembershipPage is a static copy
// screen — so both mount in isolation via `window.__lotlogicTestHooks`
// (`frontend/src/main.jsx`'s `?e2e=1` surface), the same mechanism
// `dashboard-qr.spec.ts` uses for ALPRPropertyDetailPage. This runs against
// a locally built `frontend/dist/`, not BASE_URL, so it needs no env vars
// and no `@auth` credentials.
let portalServer: BuiltFrontendServer;

baseTest.beforeAll(async () => {
  portalServer = await buildAndServeFrontend(path.resolve(__dirname, '../../frontend'));
});

baseTest.afterAll(async () => {
  await portalServer.close();
});

baseTest.describe('accessibility — isolated mounts @a11y', () => {
  baseTest('Team (owner) has no serious a11y violations', async ({ page }) => {
    await page.goto(`${portalServer.origin}/dashboard.html?e2e=1`);
    await page.waitForFunction(
      () => typeof (window as unknown as Record<string, any>).__lotlogicTestHooks?.TeamSection === 'function',
    );
    await page.evaluate(() => {
      const hooks = (window as unknown as Record<string, any>).__lotlogicTestHooks;
      hooks.requestsApi.listMembers = async () => ([
        { account_id: 'a1', name: 'Dana Ortiz', position: 'Property manager', email: 'dana@sunsetridge.com', role: 'admin', status: 'active', last_signed_in_at: '2026-10-07T20:10:00Z' },
        { account_id: 'a2', name: 'Marcus Lee', position: 'Assistant manager', role: 'manager', status: 'pending' },
      ]);
      const host = document.createElement('div');
      host.id = 'a11y-team-harness';
      document.body.appendChild(host);
      hooks.ReactDOM.createRoot(host).render(
        hooks.React.createElement(
          hooks.ToastProvider,
          null,
          hooks.React.createElement(hooks.TeamSection, {
            property: { id: 'p1', name: 'Sunset Ridge Apartments', role: 'admin' },
            user: { id: 'a1', _role: 'owner' },
          }),
        ),
      );
    });
    await expect(page.locator('#a11y-team-harness')).toContainText('Dana Ortiz');
    await scan(page, 'team-owner');
  });

  baseTest('PendingMembershipPage has no serious a11y violations', async ({ page }) => {
    await page.goto(`${portalServer.origin}/dashboard.html?e2e=1`);
    await page.waitForFunction(
      () => typeof (window as unknown as Record<string, any>).__lotlogicTestHooks?.PendingMembershipPage === 'function',
    );
    await page.evaluate(() => {
      const hooks = (window as unknown as Record<string, any>).__lotlogicTestHooks;
      const host = document.createElement('div');
      host.id = 'a11y-pending-harness';
      document.body.appendChild(host);
      hooks.ReactDOM.createRoot(host).render(
        hooks.React.createElement(hooks.PendingMembershipPage, {
          me: { properties: [{ id: 'p1', name: 'Sunset Ridge Apartments', member_status: 'pending' }] },
          user: { email: 'dana@sunsetridge.com' },
          onLogout: () => {},
          onAddProperty: () => {},
        }),
      );
    });
    await expect(page.locator('#a11y-pending-harness')).toContainText('Request sent.');
    await scan(page, 'pending-membership');
  });
});
