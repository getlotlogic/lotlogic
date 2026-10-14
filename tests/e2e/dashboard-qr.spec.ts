/**
 * The property QR codes on the operator dashboard (FE-4).
 *
 * An owner opens a property in `/app` and sees one or two tiles, each meant to
 * show a scannable QR code they print and post at the lot — that code is how a
 * driver reaches the registration form. For months the tiles drew an empty
 * white box: the drawing library was loaded from a CDN path that 404s, and the
 * page's `typeof QRCode === 'undefined'` guard returned quietly, so there was
 * nothing on screen and nothing in the console to report.
 *
 * Serves the BUILT frontend (fixtures/buildAndServeFrontend.ts) and mounts only
 * the property detail page on its own React root with every data call stubbed.
 * (It used to serve `frontend/` straight from source; since Task 17 the page's
 * script exists only after a build, so the page never booted and this spec
 * timed out waiting for it.)
 *
 * What it pins down:
 *   - the tile's canvas is NON-EMPTY once it has drawn, i.e. it has dark
 *     pixels, not a blank box — that only happens if the bundled `qrcode`
 *     module actually ran, so a missing/broken module fails this test too.
 *   - an apartment opens on its Requests section, where the QR tiles are not on
 *     screen at all. Moving to another section MOUNTS fresh, blank canvases, and
 *     they have to be drawn then too — they used to stay white boxes.
 *   - a truck plaza shows the one tile it has.
 *
 * Tagged @desktop-only so the mobile-safari project (which targets the remote
 * deploy) skips it.
 *
 * Run: cd tests && npx playwright test dashboard-qr --project=chromium-desktop
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { buildAndServeFrontend } from '../fixtures/buildAndServeFrontend';

const FRONTEND_DIR = path.resolve(__dirname, '../../frontend');
const PROPERTY_ID = '22222222-2222-4222-8222-222222222222';
const QR_CODE_ID = 'test-plaza-qr-0001';

let origin: string;
let closeServer: () => Promise<void>;

test.beforeAll(async () => {
  ({ origin, close: closeServer } = await buildAndServeFrontend(FRONTEND_DIR));
});

test.afterAll(async () => {
  await closeServer();
});

type Options = {
  /** Truck plazas only show the self-serve tile; apartments show both. */
  propertyType?: string;
  /** The section the page opens on (the deep link / remembered chip). Left
   *  out, the page picks its own default: Requests for an apartment. */
  initialSection?: string;
};

/**
 * Boot the real dashboard file, then mount ONLY the property detail page on
 * its own root, as an owner, with its seven data calls answered locally.
 */
async function mountPropertyDetail(
  page: Page,
  { propertyType = 'apartment', initialSection }: Options = {},
) {
  const json = (body: unknown, status = 200) => ({
    status, contentType: 'application/json', body: JSON.stringify(body),
  });

  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());

  // Nothing in this spec talks to a real backend or a real Supabase.
  await page.route(/^https:\/\/(lotlogic-backend-production\.up\.railway\.app|nzdkoouoaedbbccraoti\.supabase\.co)\//,
    (route) => route.fulfill(json({})));
  await page.route(/supabase\.co\/rest\/v1\//, (route) => route.fulfill(json([])));

  // `?e2e=1` is what makes the bundle expose `window.__lotlogicTestHooks` —
  // see `frontend/src/main.jsx`. Without it this is a real visitor's page.
  await page.goto(`${origin}/dashboard.html?e2e=1`);

  await page.waitForFunction(
    () => typeof (window as unknown as Record<string, any>).__lotlogicTestHooks?.ALPRPropertyDetailPage?.load === 'function',
    undefined,
    { timeout: 30_000 },
  );

  await page.evaluate(async ({ propertyId, qrCodeId, type, section }) => {
    const hooks = (window as unknown as Record<string, any>).__lotlogicTestHooks;
    // The detail page loads its property through `db`; hand it one directly so
    // the tiles render without a session or a database.
    hooks.db.getProperty = async () => ({
      id: propertyId, name: 'Test Property', qr_code_id: qrCodeId,
      property_type: type, address: '1 Test Way', pay_to_park_enabled: false,
    });
    const ALPRPropertyDetailPage = await hooks.ALPRPropertyDetailPage.load();
    const host = document.createElement('div');
    host.id = 'qr-harness';
    document.body.appendChild(host);
    hooks.ReactDOM.createRoot(host).render(
      hooks.React.createElement(
        hooks.ToastProvider,
        null,
        hooks.React.createElement(ALPRPropertyDetailPage, {
          propertyId, onBack: () => {}, user: { _role: 'owner', id: 'u1' },
          ...(section ? { initialSection: section } : {}),
        }),
      ),
    );
  }, { propertyId: PROPERTY_ID, qrCodeId: QR_CODE_ID, type: propertyType, section: initialSection ?? null });

  const detail = page.locator('#qr-harness');
  await expect(detail.locator('[data-testid="pd-section-chips"]')).toBeVisible();
  return detail;
}

/** True when the canvas has drawn something other than blank white. */
async function canvasHasInk(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const c = document.querySelector(sel) as HTMLCanvasElement | null;
    if (!c || !c.width || !c.height) return false;
    const ctx = c.getContext('2d');
    if (!ctx) return false;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    for (let i = 0; i < data.length; i += 4) {
      // Anything meaningfully darker than the white QR background counts.
      if (data[i + 3] > 0 && data[i] < 128 && data[i + 1] < 128 && data[i + 2] < 128) return true;
    }
    return false;
  }, selector);
}

const TILE_CANVAS = (n: number) => `#qr-harness .pd-qr-tile:nth-child(${n}) canvas`;

test.describe('property QR codes @desktop-only', () => {
  test('the tile draws a real QR code, not an empty box', async ({ page }) => {
    const detail = await mountPropertyDetail(page, { initialSection: 'all' });
    await expect(detail.locator('.pd-qr-tile')).toHaveCount(2);
    await expect(page.locator(TILE_CANVAS(1))).toBeVisible();
    // The draw happens in an effect after the property arrives.
    await expect.poll(() => canvasHasInk(page, TILE_CANVAS(1)), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => canvasHasInk(page, TILE_CANVAS(2)), { timeout: 15_000 }).toBe(true);
    await expect(page.locator('#qr-harness [data-testid="qr-unavailable"]')).toHaveCount(0);
  });

  test('an apartment draws both codes after leaving Requests, where its tiles are not mounted', async ({ page }) => {
    const detail = await mountPropertyDetail(page, { propertyType: 'apartment' });
    // Requests is the apartment default and nothing else renders there.
    await expect(detail.locator('.pd-qr-tile')).toHaveCount(0);
    await detail.getByRole('button', { name: 'All', exact: true }).click();
    await expect(detail.locator('.pd-qr-tile')).toHaveCount(2);
    await expect.poll(() => canvasHasInk(page, TILE_CANVAS(1)), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => canvasHasInk(page, TILE_CANVAS(2)), { timeout: 15_000 }).toBe(true);
  });

  test('a truck plaza shows its one tile, drawn', async ({ page }) => {
    const detail = await mountPropertyDetail(page, { propertyType: 'truck_plaza' });
    await expect(detail.locator('.pd-qr-tile')).toHaveCount(1);
    await expect.poll(() => canvasHasInk(page, TILE_CANVAS(1)), { timeout: 15_000 }).toBe(true);
  });

  // Two tests were removed here, both stale for the same reason: qrcode is
  // bundled (Task 14), not loaded from a CDN.
  //   - "the pinned QR library loads and exposes the drawing call" asserted a
  //     `cdnjs.cloudflare.com` request and a `window.QRCode` global, neither
  //     of which the bundle produces — its intent (the library is present)
  //     is covered by "draws a real QR code" above, which fails outright if
  //     the bundled `qrcode` module is missing.
  //   - "a QR library that fails to load says so instead of drawing nothing"
  //     (and its breakQrLib fixture) tested a CDN-404 fallback that no
  //     longer exists: a load failure now means the whole
  //     ALPRPropertyDetailPage chunk failed to fetch, which is
  //     lazyPage()'s reload-once/ErrorBoundary path, not a QRCode-specific UI.
});
