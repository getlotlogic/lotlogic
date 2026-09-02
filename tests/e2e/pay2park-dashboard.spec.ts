/**
 * Pay-to-park on the operator dashboard — the paid stamp, the revenue stat,
 * and the "payment processing — don't tow" strip.
 *
 * `frontend/dashboard.html` is one 14k-line file with an in-browser Babel
 * script, and there is no unit harness for it. So this spec does the next best
 * thing to a unit test: it serves `frontend/` locally, lets the real page
 * transpile and define its components, and then mounts `TruckParkingLog` on
 * its own React root with every data call stubbed by `page.route`. Nothing
 * here talks to the backend, Supabase or a session — which means it fails for
 * exactly one reason: this component rendered the wrong thing.
 *
 * What it pins down:
 *   - a paid pass wears "$15.00 · 24h · paid <time>" and links its receipt;
 *   - a refunded one says only "refunded" — no amount, no receipt link;
 *   - a pass registered for free is untouched — no stamp at all;
 *   - the header carries today's and the month's collected totals;
 *   - `pending_recent > 0` puts the false-tow guard above everything (§13.7),
 *     and the count drives the plural;
 *   - a tow partner (R42: `today: null`) gets the guard and no takings;
 *   - a plaza with `pay_to_park_enabled` false, and the History mount, never
 *     ASK for the summary — this component is mounted twice on one screen;
 *   - a summary endpoint that 404s hides all of it rather than breaking the
 *     page — the log still renders.
 *
 * Tagged @desktop-only so the mobile-safari project (which targets the remote
 * deploy) skips it.
 *
 * Run: cd tests && npx playwright test pay2park-dashboard --project=chromium-desktop
 */
import { test, expect, type Page } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const FRONTEND_DIR = path.resolve(__dirname, '../../frontend');
const PROPERTY_ID = '11111111-1111-4111-8111-111111111111';
const RECEIPT_URL = 'https://squareup.test/receipt/abc123';

/** Far enough ahead that the row is always in the "active" bucket. */
const soon = () => new Date(Date.now() + 20 * 3600_000).toISOString();

const PAID_ROW = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  property_id: PROPERTY_ID,
  plate_text: 'PAID1234',
  visitor_name: 'A Smith',
  company_name: 'Paid Freight LLC',
  phone: '+17045550001',
  status: 'active',
  stay_days: 1,
  valid_from: new Date(Date.now() - 4 * 3600_000).toISOString(),
  valid_until: soon(),
  created_at: new Date(Date.now() - 4 * 3600_000).toISOString(),
  exited_at: null,
  paid_amount_cents: 1500,
  paid_at: '2026-09-02T18:14:00Z',
  payment_status: 'paid',
  square_receipt_url: RECEIPT_URL,
};

const FREE_ROW = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
  property_id: PROPERTY_ID,
  plate_text: 'FREE5678',
  visitor_name: 'B Jones',
  company_name: 'Free Freight LLC',
  phone: '+17045550002',
  status: 'active',
  stay_days: 1,
  valid_from: new Date(Date.now() - 3 * 3600_000).toISOString(),
  valid_until: soon(),
  created_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
  exited_at: null,
  paid_amount_cents: null,
  paid_at: null,
  payment_status: null,
  square_receipt_url: null,
};

const SUMMARY = {
  today: { count: 3, cents: 4500 },
  month_to_date: { count: 12, cents: 18000 },
  pending_recent: 2,
};

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
  rows?: unknown[];
  summary?: unknown;
  summaryStatus?: number;
  /** Mirrors `properties.pay_to_park_enabled`. */
  payToParkEnabled?: boolean;
  /** 'history' is the second mount of this same component. */
  mode?: 'default' | 'history';
};

/** Counts every request the page made to the summary endpoint. */
type Mounted = { log: ReturnType<Page['locator']>; summaryCalls: () => number };

/**
 * Boot the real dashboard file, then mount ONLY the parking log on its own
 * root. The page's own App renders the login screen behind it and is ignored;
 * we assert against the component under test.
 */
async function mountParkingLog(
  page: Page,
  {
    rows,
    summary = SUMMARY,
    summaryStatus = 200,
    payToParkEnabled = true,
    mode = 'default',
  }: Options = {},
): Promise<Mounted> {
  let summaryCalls = 0;
  const json = (body: unknown, status = 200) => ({
    status, contentType: 'application/json', body: JSON.stringify(body),
  });

  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());

  // Registration order matters: Playwright tries handlers most-recent-first, so
  // the catch-all goes down FIRST and the specific routes below override it.
  // Anything the page reaches for that this spec has no opinion about (auth/me,
  // images, …) answers harmlessly rather than hitting the real network.
  await page.route(/^https:\/\/(lotlogic-backend-production\.up\.railway\.app|nzdkoouoaedbbccraoti\.supabase\.co)\//,
    (route) => route.fulfill(json({})));

  // Every Supabase read the log leans on (roster, open violations) answers empty
  // — the backend log is the source under test here.
  await page.route(/supabase\.co\/rest\/v1\//, (route) => route.fulfill(json([])));

  await page.route(/\/visitor_passes\/parking-log/, (route) => route.fulfill(json({
    total: (rows ?? [PAID_ROW, FREE_ROW]).length,
    page: 1,
    page_size: 500,
    rows: rows ?? [PAID_ROW, FREE_ROW],
  })));

  await page.route(/\/plaza\/summary/, (route) => {
    summaryCalls += 1;
    return route.fulfill(
      summaryStatus === 200 ? json(summary) : json({ detail: 'Property not found' }, summaryStatus),
    );
  });

  await page.goto(`${origin}/dashboard.html`);

  // Babel transpiles the inline script into a real <script>, so the page's
  // components become globals. Wait for that rather than for any UI.
  await page.waitForFunction(
    () => typeof (window as Record<string, unknown>).TruckParkingLog === 'function'
      && typeof (window as Record<string, unknown>).ToastProvider === 'function',
    undefined,
    { timeout: 30_000 },
  );

  await page.evaluate((props) => {
    const w = window as unknown as Record<string, any>;
    const host = document.createElement('div');
    host.id = 'p2p-harness';
    document.body.appendChild(host);
    w.ReactDOM.createRoot(host).render(
      w.React.createElement(
        w.ToastProvider,
        null,
        w.React.createElement(w.TruckParkingLog, { ...props, isOwner: true }),
      ),
    );
  }, { propertyId: PROPERTY_ID, propertyType: 'truck_plaza', payToParkEnabled, mode });

  const log = page.locator('#p2p-harness');
  // The log renders from the same fetch as the summary, so waiting for a row
  // means the summary call has either happened or been deliberately skipped.
  await expect(log).toContainText('PAID1234');
  return { log, summaryCalls: () => summaryCalls };
}

test.describe('pay-to-park dashboard @desktop-only', () => {
  test('a paid pass wears its stamp, a free one does not', async ({ page }) => {
    const { log } = await mountParkingLog(page);

    const stamp = log.locator('.paid-stamp');
    await expect(stamp).toHaveCount(1);
    await expect(stamp).toContainText('$15.00');
    await expect(stamp).toContainText('24h');
    await expect(stamp).toContainText(/paid \d{1,2}:\d{2}\s?(AM|PM)/i);

    // The receipt opens away from the dashboard, and without handing the new
    // tab a live reference back to this one.
    const receipt = stamp.locator('a');
    await expect(receipt).toHaveAttribute('href', RECEIPT_URL);
    await expect(receipt).toHaveAttribute('target', '_blank');
    await expect(receipt).toHaveAttribute('rel', /noopener/);

    // The free pass is on screen and carries nothing new.
    await expect(log).toContainText('FREE5678');
  });

  test('a refunded pass says only that — no amount, no receipt', async ({ page }) => {
    const { log } = await mountParkingLog(page, {
      rows: [{ ...PAID_ROW, payment_status: 'refunded' }],
    });

    const stamp = log.locator('.paid-stamp');
    await expect(stamp).toHaveText('refunded');
    await expect(stamp).not.toContainText('$15');
    await expect(stamp).not.toContainText('paid');
    await expect(stamp.locator('a')).toHaveCount(0);
  });

  test('History dates the stamp, because it spans months', async ({ page }) => {
    const { log } = await mountParkingLog(page, { mode: 'history' });

    // "Sep 2, 2:14 PM" — a bare clock time would be ambiguous in an all-time record.
    await expect(log.locator('.paid-stamp'))
      .toContainText(/paid [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2}\s?(AM|PM)/i);
  });

  test('the header reports what the lot has collected', async ({ page }) => {
    const { log } = await mountParkingLog(page);

    await expect(log).toContainText('Today:');
    await expect(log).toContainText('3 passes · $45.00 collected');
    await expect(log).toContainText('Month:');
    await expect(log).toContainText('12 · $180.00');
  });

  test('payments in flight raise the false-tow guard', async ({ page }) => {
    const { log } = await mountParkingLog(page);

    const strip = log.locator('.processing-strip');
    await expect(strip).toHaveCount(1);
    await expect(strip).toContainText('2 payments processing');
    await expect(strip).toContainText('passes activating');
    await expect(strip).toContainText("Don't tow.");
  });

  test('one payment in flight reads in the singular', async ({ page }) => {
    const { log } = await mountParkingLog(page, { summary: { ...SUMMARY, pending_recent: 1 } });

    await expect(log.locator('.processing-strip')).toContainText('1 payment processing');
    await expect(log.locator('.processing-strip')).toContainText('pass activating');
  });

  test('a tow partner gets the guard and none of the takings (R42)', async ({ page }) => {
    // What the backend sends a partner: the count that stops a false tow,
    // and null for both revenue windows.
    const { log } = await mountParkingLog(page, {
      summary: { today: null, month_to_date: null, pending_recent: 2 },
    });

    await expect(log.locator('.processing-strip')).toContainText('2 payments processing');
    await expect(log).not.toContainText('collected');
    await expect(log).not.toContainText('Today:');
    await expect(log).not.toContainText('Month:');
  });

  test('a plaza that is not taking payments never asks for the summary', async ({ page }) => {
    // The live Charlotte plaza before the flag is flipped. "Today: 0 passes ·
    // $0.00 collected" would read as a broken till, not as an accurate zero.
    const { log, summaryCalls } = await mountParkingLog(page, { payToParkEnabled: false });

    expect(summaryCalls()).toBe(0);
    await expect(log.locator('.processing-strip')).toHaveCount(0);
    await expect(log).not.toContainText('collected');
  });

  test('the History mount never asks for the summary either', async ({ page }) => {
    // This component is on screen TWICE when the section filter is "all".
    // Ungated, the strip and the stat would render twice and the summary would
    // be fetched twice on every poll.
    const { log, summaryCalls } = await mountParkingLog(page, { mode: 'history' });

    expect(summaryCalls()).toBe(0);
    await expect(log.locator('.processing-strip')).toHaveCount(0);
    await expect(log).not.toContainText('collected');
  });

  test('a summary the viewer cannot read hides the money, not the log', async ({ page }) => {
    const { log } = await mountParkingLog(page, { summaryStatus: 404 });

    await expect(log).toContainText('PAID1234');
    await expect(log.locator('.processing-strip')).toHaveCount(0);
    await expect(log).not.toContainText('collected');
    // The stamp comes from the log row, not the summary — it survives.
    await expect(log.locator('.paid-stamp')).toHaveCount(1);
  });
});
