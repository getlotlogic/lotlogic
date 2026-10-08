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
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

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

/**
 * Same blocking rule as `scan()`, scoped to one subtree via axe's
 * `.include()` — for a harness-mounted component where the rest of the
 * stubbed page (empty-state copy on surfaces this test isn't about) is not
 * what the scan is meant to pin down. No WAIVED map: this is a different
 * query, not a waiver on `scan()`'s.
 */
async function scanIncluding(page: any, label: string, selector: string) {
  const results = await new AxeBuilder({ page })
    .include(selector)
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const blocking = results.violations.filter(v => BLOCKING.has(v.impact ?? ''));
  const summary = results.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help }));
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

/**
 * Greyed upsell chips (Task 26, spec §5.6) — the locked-chip contrast.
 *
 * No TEST_* account has a portal-only property (`features.passes=false`),
 * so unlike the credentialed `@auth` scans above this one does not touch
 * BASE_URL or the fixture login at all: same self-contained harness as
 * `tests/e2e/dashboard-qr.spec.ts` — serve `frontend/` from a throwaway
 * local server, boot the real bundle with `?e2e=1`, and mount
 * `ALPRPropertyDetailPage` directly with `db.getProperty` stubbed to a
 * property whose `passes`/`qr`/`cameras` all read `false`. That is enough
 * to exercise the real, muted (`var(--text-muted)`) locked-chip buttons and
 * the `UpsellPanel` one of them renders — nothing here depends on a seeded
 * account or a reachable backend.
 */
test.describe('upsell chips @a11y', () => {
  // `frontend/dashboard.html` is the committed source; `dashboard.js` is an
  // esbuild output that only exists under `dist/` (`npm run build` in
  // `frontend/`) — so this harness serves the built directory, not the
  // frontend root.
  const FRONTEND_DIR = path.resolve(__dirname, '../../frontend/dist');
  const PROPERTY_ID = '33333333-3333-4333-8333-333333333333';
  let server: http.Server;
  let origin: string;

  test.beforeAll(async () => {
    server = http.createServer((req, res) => {
      const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
      const file = path.join(FRONTEND_DIR, pathname.replace(/^\/+/, ''));
      if (!file.startsWith(FRONTEND_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
        return;
      }
      const type = file.endsWith('.html') ? 'text/html; charset=utf-8'
        : file.endsWith('.js') ? 'text/javascript; charset=utf-8'
        : file.endsWith('.css') ? 'text/css; charset=utf-8'
        : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type });
      fs.createReadStream(file).pipe(res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  test.afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('locked chips meet contrast, and the Cameras panel is clean', async ({ page }) => {
    const json = (body: unknown, status = 200) => ({
      status, contentType: 'application/json', body: JSON.stringify(body),
    });
    await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
    // Nothing in this test talks to a real backend or a real Supabase —
    // every call the detail page makes besides `db.getProperty` (stubbed
    // below) resolves through these to an empty result.
    await page.route(/^https:\/\/(lotlogic-backend-production\.up\.railway\.app|nzdkoouoaedbbccraoti\.supabase\.co)\//,
      (route) => route.fulfill(json({})));
    await page.route(/supabase\.co\/rest\/v1\//, (route) => route.fulfill(json([])));

    await page.goto(`${origin}/dashboard.html?e2e=1`);
    await page.waitForFunction(
      () => typeof (window as unknown as Record<string, any>).__lotlogicTestHooks?.ALPRPropertyDetailPage?.load === 'function',
      undefined,
      { timeout: 30_000 },
    );

    await page.evaluate(async ({ propertyId }) => {
      const hooks = (window as unknown as Record<string, any>).__lotlogicTestHooks;
      hooks.db.getProperty = async () => ({
        id: propertyId, name: 'Sunset Ridge Apartments', address: '123 Main St',
        property_type: 'apartment', qr_code_id: null,
      });
      const ALPRPropertyDetailPage = await hooks.ALPRPropertyDetailPage.load();
      const host = document.createElement('div');
      host.id = 'upsell-harness';
      document.body.appendChild(host);
      hooks.ReactDOM.createRoot(host).render(
        hooks.React.createElement(
          hooks.ToastProvider,
          null,
          hooks.React.createElement(ALPRPropertyDetailPage, {
            propertyId,
            onBack: () => {},
            user: { _role: 'owner', id: 'u1' },
            // Spec §5.6: the chip row is locked only when `passes`/`qr`/
            // `cameras` all read explicit `false` — a portal-only property.
            features: { passes: false, qr: false, cameras: false },
          }),
        ),
      );
    }, { propertyId: PROPERTY_ID });

    const harness = page.locator('#upsell-harness');
    await expect(harness).toContainText('Sunset Ridge Apartments');

    const lockedParkingPasses = harness.getByRole('button', { name: '🔒 Parking passes' });
    const lockedQr = harness.getByRole('button', { name: '🔒 QR codes' });
    const lockedCameras = harness.getByRole('button', { name: '🔒 Cameras' });
    await expect(lockedParkingPasses).toBeVisible();
    await expect(lockedQr).toBeVisible();
    await expect(lockedCameras).toBeVisible();

    // Scoped to the chip row itself (`data-testid="pd-section-chips"`), not
    // the whole stubbed page — this harness fakes an apartment with no
    // camera ever installed, so unrelated surfaces below (the live ALPR
    // plate-detection feed, say) render their real "nothing here" empty
    // state, which is not what this scan is for. What this pins down is
    // exactly the brief's ask: the locked chips' contrast
    // (`var(--text-muted)` >= 4.5:1 on both themes) and their
    // `aria-describedby`.
    await scanIncluding(page, 'upsell', '[data-testid="pd-section-chips"]');

    // Tap Cameras: `UpsellPanel` replaces the section, with its one-sentence
    // pitch and the `Ask LotLogic` button. Scan that card on its own too.
    await lockedCameras.click();
    await expect(harness.getByText(/Plate cameras spot cars/)).toBeVisible();
    await expect(harness.getByRole('button', { name: 'Ask LotLogic' })).toBeVisible();
    await scanIncluding(page, 'upsell-cameras-panel', '[data-testid="upsell-panel"]');

    // "Ask LotLogic" opens `FeedbackModal kind="feature"` prefilled per the
    // spec's exact sentence — scan the dialog too (it's a real page region,
    // not scoped out by `#upsell-harness`).
    await harness.getByRole('button', { name: 'Ask LotLogic' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('textbox')).toHaveValue(
      'Sunset Ridge Apartments is interested in cameras.',
    );
    await scanIncluding(page, 'upsell-feedback-modal', '[role="dialog"]');
  });
});
