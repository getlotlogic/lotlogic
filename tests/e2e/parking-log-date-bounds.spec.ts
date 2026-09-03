/**
 * The Parking Log's date filter, in the LOT's timezone (FE-5).
 *
 * The Truck Parking Log at Charlotte — and the CSV export, which is the record
 * of who parked — filters by a date range. The screen builds "through today" as
 * a local calendar date; the data layer used to stamp that with a UTC
 * end-of-day (`T23:59:59.999Z`), which in Eastern time ends the day at 7:59:59
 * PM. Every truck registering between 8 PM and midnight — the night shift —
 * was missing from the log and from the export for that day. The lower bound
 * was bare, so it silently *gained* the previous evening: the window was
 * shifted, not merely short.
 *
 * `lotDayBound()` in `frontend/dashboard.html` is a pure function, so this spec
 * loads the real page and exercises it directly — no UI, no network, no
 * session. It also asserts the whole way through `db.getParkingLog`, so a
 * future edit that stops calling the helper is caught too.
 *
 * Tagged @desktop-only so the mobile-safari project (which targets the remote
 * deploy) skips it.
 *
 * Run: cd tests && npx playwright test parking-log-date-bounds --project=chromium-desktop
 */
import { test, expect, type Page } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const FRONTEND_DIR = path.resolve(__dirname, '../../frontend');
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

/** Boot the real dashboard file so its top-level helpers are defined. */
async function loadHelpers(page: Page) {
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  await page.route(/cdnjs\.cloudflare\.com\/ajax\/libs\/qrcode\//, (route) => route.abort());
  await page.goto(`${origin}/dashboard.html`);
  await page.waitForFunction(
    () => typeof (window as unknown as Record<string, unknown>).lotDayBound === 'function',
    undefined,
    { timeout: 30_000 },
  );
}

const bound = (page: Page, ymd: string, edge: 'start' | 'end') =>
  page.evaluate(({ d, e }) => (window as unknown as Record<string, any>).lotDayBound(d, e), { d: ymd, e: edge });

test.describe('Parking Log date bounds @desktop-only', () => {
  test('a 10 PM Eastern registration is inside "today"', async ({ page }) => {
    await loadHelpers(page);
    // 3 September 2026 is EDT (UTC-4). A pass created at 22:00 local is
    // 02:00 UTC the NEXT day — the exact row the old `Z` bound threw away.
    const upper = await bound(page, '2026-09-03', 'end');
    const lower = await bound(page, '2026-09-03', 'start');
    expect(upper).toBe('2026-09-03T23:59:59.999-04:00');
    expect(lower).toBe('2026-09-03T00:00:00.000-04:00');

    const tenPmEt = new Date('2026-09-04T02:00:00Z').getTime(); // 22:00 on 9/3 ET
    expect(tenPmEt).toBeGreaterThan(new Date(lower as string).getTime());
    expect(tenPmEt).toBeLessThan(new Date(upper as string).getTime());

    // And the bug, stated as the regression it was: the old bound excluded it.
    expect(tenPmEt).toBeGreaterThan(new Date('2026-09-03T23:59:59.999Z').getTime());
  });

  test('the window is a full lot-local day, not a shifted one', async ({ page }) => {
    await loadHelpers(page);
    const lower = new Date((await bound(page, '2026-09-03', 'start')) as string).getTime();
    const upper = new Date((await bound(page, '2026-09-03', 'end')) as string).getTime();
    expect(upper - lower).toBe(24 * 3600_000 - 1);

    // 7 PM Eastern the evening BEFORE is outside the window. The old bare
    // `from_date` parsed to 00:00 UTC and pulled it in.
    const sevenPmPrevEvening = new Date('2026-09-02T23:00:00Z').getTime();
    expect(sevenPmPrevEvening).toBeLessThan(lower);
  });

  test('the offset follows Eastern across the DST change', async ({ page }) => {
    await loadHelpers(page);
    expect(await bound(page, '2026-07-01', 'end')).toBe('2026-07-01T23:59:59.999-04:00'); // EDT
    expect(await bound(page, '2026-01-15', 'end')).toBe('2026-01-15T23:59:59.999-05:00'); // EST
  });

  test('the START bound is also right on the two transition days themselves', async ({ page }) => {
    await loadHelpers(page);
    // 2026-11-01: clocks fall back 2:00 AM EDT -> 1:00 AM EST. Midnight at
    // the start of the day is still pre-transition, so it's EDT — only the
    // midday anchor (used for the END bound) has already fallen back to EST.
    expect(await bound(page, '2026-11-01', 'start')).toBe('2026-11-01T00:00:00.000-04:00');
    expect(await bound(page, '2026-11-01', 'end')).toBe('2026-11-01T23:59:59.999-05:00'); // unchanged

    // 2026-03-08: clocks spring forward 2:00 AM EST -> 3:00 AM EDT. Midnight
    // at the start of the day is still pre-transition EST — the midday
    // anchor (used for the END bound) is already EDT.
    expect(await bound(page, '2026-03-08', 'start')).toBe('2026-03-08T00:00:00.000-05:00');
    expect(await bound(page, '2026-03-08', 'end')).toBe('2026-03-08T23:59:59.999-04:00'); // unchanged
  });

  test('a caller that already sent a full timestamp is left alone', async ({ page }) => {
    await loadHelpers(page);
    expect(await bound(page, '2026-09-03T12:00:00Z', 'end')).toBe('2026-09-03T12:00:00Z');
    expect(await bound(page, '', 'end')).toBe('');
  });

  test('the log and the CSV export both send the lot-local bounds', async ({ page }) => {
    await loadHelpers(page);
    const seen: string[] = [];
    await page.route(/\/visitor_passes\/parking-log/, (route) => {
      seen.push(route.request().url());
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ total: 0, page: 1, page_size: 500, rows: [] }),
      });
    });

    await page.evaluate(async (propertyId) => {
      const w = window as unknown as Record<string, any>;
      await w.db.getParkingLog(propertyId, { date_from: '2026-09-01', date_to: '2026-09-03' });
      await w.db.getParkingLog(propertyId, { date_from: '2026-09-01', date_to: '2026-09-03', format: 'csv' });
    }, PROPERTY_ID);

    expect(seen).toHaveLength(2);
    for (const url of seen) {
      const q = new URL(url).searchParams;
      expect(q.get('from_date')).toBe('2026-09-01T00:00:00.000-04:00');
      expect(q.get('to_date')).toBe('2026-09-03T23:59:59.999-04:00');
    }
    expect(new URL(seen[1]).searchParams.get('format')).toBe('csv');
  });
});
