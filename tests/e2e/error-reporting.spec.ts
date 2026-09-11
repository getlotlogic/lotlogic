/**
 * The error-reporting loader (`frontend/error-reporting.js`), on the four pages
 * that carry it: the dashboard and the three registration forms.
 *
 * The point of the loader is that it is INERT until an owner pastes a Sentry
 * DSN into it — the switch is off, and nothing about a driver's page changes
 * until someone decides otherwise. This spec pins both halves of that: nothing
 * is fetched while the DSN is empty, and the SDK is fetched (pinned, with its
 * integrity hash) as soon as one is set.
 *
 * Tagged @desktop-only so the mobile-safari project (which targets the remote
 * deploy) skips it.
 *
 * Run: cd tests && npx playwright test error-reporting --project=chromium-desktop
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { buildAndServeFrontend } from '../fixtures/buildAndServeFrontend';

const FRONTEND_DIR = path.resolve(__dirname, '../../frontend');
const PAGES = ['/dashboard.html', '/visit.html', '/apt.html', '/resident.html'];
const SENTRY_CDN = /browser\.sentry-cdn\.com/;

let origin: string;
let closeServer: () => Promise<void>;

// dashboard.html/visit.html/apt.html/resident.html all now load their app
// code as bundled ES modules (`/dashboard.js`, `/visit.js`, ...), produced
// by `npm run build` -- they exist only in frontend/dist/, never in the
// source tree, so this serves the BUILT output (see
// fixtures/buildAndServeFrontend.ts). Latent until Task 17: this spec's own
// assertions don't depend on the app module actually booting (they check
// the /error-reporting.js request + `window.Sentry`/`window.LotLogicErrorReporting`,
// which the loader script sets up independently of the page's own app
// script), so serving raw frontend/ never actually failed here -- fixed
// anyway for correctness, per Task 17 fix round 1.
test.beforeAll(async () => {
  ({ origin, close: closeServer } = await buildAndServeFrontend(FRONTEND_DIR));
});

test.afterAll(async () => {
  await closeServer();
});

/** Keep every third-party request this spec has no opinion about off the wire. */
async function quiet(page: Page) {
  await page.route(/fonts\.(googleapis|gstatic)\.com|google\.com\/recaptcha/, (r) => r.abort());
  await page.route(/^https:\/\/(lotlogic-backend-production\.up\.railway\.app|nzdkoouoaedbbccraoti\.supabase\.co)\//,
    (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
}

test.describe('error reporting @desktop-only', () => {
  for (const p of PAGES) {
    test(`${p} carries the loader and fetches nothing while the DSN is empty`, async ({ page }) => {
      const sentryHits: string[] = [];
      page.on('request', (r) => { if (SENTRY_CDN.test(r.url())) sentryHits.push(r.url()); });
      await quiet(page);

      const loaderRequests: number[] = [];
      page.on('response', (r) => { if (r.url().endsWith('/error-reporting.js')) loaderRequests.push(r.status()); });

      await page.goto(`${origin}${p}`);
      await page.waitForLoadState('load');

      expect(loaderRequests, `${p} must load /error-reporting.js`).toEqual([200]);
      expect(sentryHits, 'no SDK may be fetched while the DSN is empty').toEqual([]);
      expect(await page.evaluate(() => (window as unknown as Record<string, any>).Sentry)).toBeUndefined();
    });
  }

  test('a DSN turns it on, and the SDK is pinned with an integrity hash', async ({ page }) => {
    await quiet(page);
    let requested = '';
    // The SDK itself never has to run for this: block it at the network and
    // assert what the loader asked for.
    await page.route(SENTRY_CDN, (route) => { requested = route.request().url(); return route.abort(); });

    // The loader honours a DSN set before it runs, which is how a preview build
    // or a debug session points at its own project.
    await page.addInitScript(() => { (window as any).SENTRY_DSN = 'https://abc123@o0.ingest.sentry.io/1'; });
    await page.goto(`${origin}/visit.html`);

    await expect.poll(() => page.evaluate(
      () => (window as any).LotLogicErrorReporting?.sdkUrl ?? null,
    )).not.toBeNull();

    expect(requested).toContain('browser.sentry-cdn.com/');
    // Pinned by hash, not just by version: a compromised CDN cannot change what
    // runs on the page that takes card payments.
    const tag = await page.evaluate(() => {
      const el = document.querySelector('script[src*="sentry-cdn"]') as HTMLScriptElement | null;
      return el ? { src: el.src, integrity: el.integrity, cors: el.crossOrigin } : null;
    });
    expect(tag).not.toBeNull();
    expect(tag!.src).toMatch(/browser\.sentry-cdn\.com\/\d+\.\d+\.\d+\/bundle\.min\.js$/);
    expect(tag!.integrity).toMatch(/^sha384-/);
    expect(tag!.cors).toBe('anonymous');

    // A blocked or blocked-by-ad-blocker SDK must cost the driver nothing.
    expect(await page.locator('form, body').first().isVisible()).toBe(true);
  });

  test("a driver's details are stripped before an event leaves the browser", async ({ page }) => {
    await quiet(page);
    await page.route(SENTRY_CDN, (route) => route.abort());
    await page.addInitScript(() => { (window as any).SENTRY_DSN = 'https://abc123@o0.ingest.sentry.io/1'; });
    await page.goto(`${origin}/visit.html`);
    await expect.poll(
      () => page.evaluate(() => typeof (window as any).LotLogicErrorReporting?.scrub),
    ).toBe('function');

    const scrubbed = await page.evaluate(() => (window as any).LotLogicErrorReporting.scrub({
      request: {
        url: 'https://lotlogicparking.com/temp/abc?plate=ABC1234&phone=7045550001',
        cookies: { session: 'x' },
        data: { visitor_name: 'A Smith', phone: '7045550001' },
      },
      user: { email: 'driver@example.com' },
      breadcrumbs: [
        { category: 'ui.input', message: 'input#plate' },
        { category: 'fetch', data: { url: 'https://api/x?phone=7045550001' } },
      ],
    }));

    expect(scrubbed.request.url).toBe('https://lotlogicparking.com/temp/abc');
    expect(scrubbed.request.cookies).toBeUndefined();
    expect(scrubbed.request.data).toBeUndefined();
    expect(scrubbed.user).toBeUndefined();
    expect(scrubbed.breadcrumbs).toHaveLength(1);
    expect(scrubbed.breadcrumbs[0].data.url).toBe('https://api/x');
  });
});
