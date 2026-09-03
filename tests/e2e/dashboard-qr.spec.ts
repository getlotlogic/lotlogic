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
 * Same harness as `pay2park-dashboard.spec.ts`: serve `frontend/` locally, let
 * the real page transpile itself, then mount only the property detail page on
 * its own React root with every data call stubbed.
 *
 * What it pins down:
 *   - the pinned CDN script really loads and really exposes `QRCode.toCanvas`
 *     (this is the exact thing that was broken — the URL 404'd);
 *   - the tile's canvas is NON-EMPTY once it has drawn, i.e. it has dark
 *     pixels, not a blank box;
 *   - when the library fails to load the tile says so out loud —
 *     "QR unavailable — use Copy link" — instead of silently rendering nothing.
 *
 * Tagged @desktop-only so the mobile-safari project (which targets the remote
 * deploy) skips it.
 *
 * Run: cd tests && npx playwright test dashboard-qr --project=chromium-desktop
 */
import { test, expect, type Page } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const FRONTEND_DIR = path.resolve(__dirname, '../../frontend');
const PROPERTY_ID = '22222222-2222-4222-8222-222222222222';
const QR_CODE_ID = 'test-plaza-qr-0001';

/** The pinned QR library. If this ever 404s again, test 1 goes red. */
const QR_LIB = /cdnjs\.cloudflare\.com\/ajax\/libs\/qrcode\//;

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

type Options = {
  /** Block the QR library, reproducing the 404 this spec exists to catch. */
  breakQrLib?: boolean;
  /** Truck plazas only show the self-serve tile; apartments show both. */
  propertyType?: string;
};

/**
 * Boot the real dashboard file, then mount ONLY the property detail page on
 * its own root, as an owner, with its seven data calls answered locally.
 */
async function mountPropertyDetail(
  page: Page,
  { breakQrLib = false, propertyType = 'apartment' }: Options = {},
) {
  const json = (body: unknown, status = 200) => ({
    status, contentType: 'application/json', body: JSON.stringify(body),
  });

  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  if (breakQrLib) await page.route(QR_LIB, (route) => route.fulfill({ status: 404, body: '' }));

  // Nothing in this spec talks to a real backend or a real Supabase.
  await page.route(/^https:\/\/(lotlogic-backend-production\.up\.railway\.app|nzdkoouoaedbbccraoti\.supabase\.co)\//,
    (route) => route.fulfill(json({})));
  await page.route(/supabase\.co\/rest\/v1\//, (route) => route.fulfill(json([])));

  await page.goto(`${origin}/dashboard.html`);

  await page.waitForFunction(
    () => typeof (window as unknown as Record<string, unknown>).ALPRPropertyDetailPage === 'function',
    undefined,
    { timeout: 30_000 },
  );

  await page.evaluate(({ propertyId, qrCodeId, type }) => {
    const w = window as unknown as Record<string, any>;
    // The detail page loads its property through `db`; hand it one directly so
    // the tiles render without a session or a database.
    w.db.getProperty = async () => ({
      id: propertyId, name: 'Test Property', qr_code_id: qrCodeId,
      property_type: type, address: '1 Test Way', pay_to_park_enabled: false,
    });
    const host = document.createElement('div');
    host.id = 'qr-harness';
    document.body.appendChild(host);
    w.ReactDOM.createRoot(host).render(
      w.React.createElement(
        w.ToastProvider,
        null,
        w.React.createElement(w.ALPRPropertyDetailPage, {
          propertyId, onBack: () => {}, user: { _role: 'owner', id: 'u1' },
        }),
      ),
    );
  }, { propertyId: PROPERTY_ID, qrCodeId: QR_CODE_ID, type: propertyType });

  const detail = page.locator('#qr-harness');
  await expect(detail).toContainText('Self-serve pass');
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

test.describe('property QR codes @desktop-only', () => {
  test('the pinned QR library loads and exposes the drawing call', async ({ page }) => {
    const loaded: { url: string; status: number }[] = [];
    page.on('response', (r) => {
      if (QR_LIB.test(r.url())) loaded.push({ url: r.url(), status: r.status() });
    });
    await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
    await page.goto(`${origin}/dashboard.html`);
    await page.waitForFunction(
      () => typeof (window as unknown as Record<string, any>).QRCode?.toCanvas === 'function',
      undefined,
      { timeout: 30_000 },
    );
    expect(loaded.length, 'the dashboard requested the QR library').toBeGreaterThan(0);
    expect(loaded.every((r) => r.status === 200), JSON.stringify(loaded)).toBe(true);
  });

  test('the tile draws a real QR code, not an empty box', async ({ page }) => {
    await mountPropertyDetail(page);
    const canvas = '#qr-harness .pd-qr-canvas-wrap canvas';
    await expect(page.locator(canvas).first()).toBeVisible();
    // The draw happens in an effect after the property arrives.
    await expect.poll(() => canvasHasInk(page, canvas), { timeout: 15_000 }).toBe(true);
    await expect(page.locator('#qr-harness [data-testid="qr-unavailable"]')).toHaveCount(0);
  });

  test('a QR library that fails to load says so instead of drawing nothing', async ({ page }) => {
    const detail = await mountPropertyDetail(page, { breakQrLib: true });
    await expect(detail.locator('[data-testid="qr-unavailable"]').first()).toBeVisible();
    await expect(detail).toContainText('QR unavailable');
    // The escape hatch the note points at is still there.
    await expect(detail.getByRole('button', { name: 'Copy link' }).first()).toBeVisible();
  });
});
