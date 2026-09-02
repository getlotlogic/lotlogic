/**
 * Pay-to-park QR page (`frontend/visit.html`) — paid branch, idempotency key,
 * return-from-Square polling.
 *
 * Everything here runs against the LOCAL file: a tiny static server serves
 * `frontend/` and every network dependency (Supabase PostgREST, the backend,
 * reCAPTCHA, Google Fonts, Square) is stubbed with `page.route()`. That keeps
 * the suite honest about the page's own logic and keeps it runnable with no
 * backend, no database and no Square account.
 *
 * The money invariants under test:
 *   - the paid branch appears ONLY when `properties.pay_to_park_enabled` is
 *     true; a flag we cannot read must fall back to the free form, never break it;
 *   - the request body carries a duration ENUM and never an amount (§13.2);
 *   - one form's worth of data keeps ONE idempotency key across retries and
 *     the Square redirect, and a spent key is replaced rather than reused (§13.6);
 *   - "paid" is never painted from the query string — only from the status
 *     poll (§13.11).
 *
 * Tagged @desktop-only so the mobile-safari project (which needs WebKit and
 * targets the remote deploy) skips it.
 *
 * Run: cd tests && npx playwright test pay2park-visit --project=chromium-desktop
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const FRONTEND_DIR = path.resolve(__dirname, '../../frontend');

const QR = 'test-plaza-qr';
const PROPERTY_ID = '11111111-1111-4111-8111-111111111111';
const PAYMENT_ID = '22222222-2222-4222-8222-222222222222';
const CHECKOUT_URL = 'https://square.test/checkout/abc123';

const BASE_PROPERTY = {
  id: PROPERTY_ID,
  name: 'Test Truck Plaza',
  address: '1 Test Rd, Charlotte NC',
  property_type: 'truck_plaza',
  policy_text: 'Test policy text.',
  policy_phone: '(555) 000-0000',
};

type FlagMode = 'on' | 'off' | 'column-error';

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

/** reCAPTCHA stub + third-party blocking + the properties read. */
async function stubPage(page: Page, flag: FlagMode) {
  await page.addInitScript(() => {
    (window as unknown as { grecaptcha: unknown }).grecaptcha = {
      ready: (cb: () => void) => cb(),
      execute: () => Promise.resolve('stub-recaptcha-token'),
    };
  });

  // No third-party network in tests.
  await page.route(/https:\/\/(www\.google\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)\//,
    (route) => route.abort());

  await page.route(/\/rest\/v1\/properties/, (route) => {
    const asksForFlag = route.request().url().includes('pay_to_park_enabled');
    if (asksForFlag && flag === 'column-error') {
      // What PostgREST answers when the anon role cannot see the column.
      return route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          code: '42703',
          message: 'column properties.pay_to_park_enabled does not exist',
        }),
      });
    }
    const row: Record<string, unknown> = { ...BASE_PROPERTY };
    if (asksForFlag) row.pay_to_park_enabled = flag === 'on';
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([row]),
    });
  });

  // Plate-blur pre-flight — not under test here.
  await page.route(/\/visitor_passes\/check-active/, (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ active: false }),
  }));

  // Square's hosted checkout: a page we can land on.
  await page.route(`${CHECKOUT_URL}*`, (route) => route.fulfill({
    status: 200, contentType: 'text/html', body: '<html><body>square stub</body></html>',
  }));
}

/** Collects every quote-and-start body and answers with `handler`. */
async function stubQuote(
  page: Page,
  handler: (route: Route, callIndex: number) => Promise<void> | void,
): Promise<Array<Record<string, unknown>>> {
  const bodies: Array<Record<string, unknown>> = [];
  await page.route(/\/plaza\/quote-and-start/, async (route) => {
    bodies.push(route.request().postDataJSON());
    await handler(route, bodies.length - 1);
  });
  return bodies;
}

function okQuote(route: Route) {
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      plaza_payment_id: PAYMENT_ID,
      checkout_url: CHECKOUT_URL,
      amount_cents: 1500,
      stay_hours: 24,
    }),
  });
}

function refuse(route: Route, status: number, detail: string) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify({ detail }),
  });
}

async function openForm(page: Page, flag: FlagMode) {
  await stubPage(page, flag);
  await page.goto(`${origin}/visit.html?qr=${QR}`);
  await page.waitForSelector('#passForm');
}

async function fillPaidForm(page: Page) {
  await page.fill('#plate', 'ABC1234');
  await page.fill('#backPlate', 'XYZ5678');
  await page.fill('#phone', '(555) 123-4567');
  await page.fill('#companyName', 'ACME Trucking');
  await page.fill('#driverName', 'John Smith');
  await page.check('#payAck');
}

const errorText = (page: Page) => page.locator('#errorMsg .error');

test.describe('pay-to-park visit.html @desktop-only', () => {
  test('flag off keeps the free form exactly as it is', async ({ page }) => {
    await openForm(page, 'off');

    await expect(page.locator('#stayHours')).toBeVisible();
    await expect(page.locator('#stayHours option[value="12"]')).toHaveCount(1);
    await expect(page.locator('#payAck')).toHaveCount(0);
    await expect(page.locator('input[name="duration"]')).toHaveCount(0);
    await expect(page.locator('#submitBtn')).toBeEnabled();
    await expect(page.locator('#submitBtn')).toHaveText('Get parking pass →');
  });

  test('flag on shows two priced stays and gates submit on the acknowledgment', async ({ page }) => {
    await openForm(page, 'on');

    await expect(page.locator('#stayHours')).toHaveCount(0);
    const options = page.locator('.duration-option');
    await expect(options).toHaveCount(2);
    await expect(options.nth(0)).toContainText('24 hours — $15');
    await expect(options.nth(1)).toContainText('48 hours — $30');
    await expect(page.locator('input[name="duration"][value="h24"]')).toBeChecked();

    const ack = page.locator('#payAck');
    await expect(ack).toHaveCount(1);
    await expect(page.locator('.ack-row')).toContainText(
      'I understand payment is non-refundable, does not exempt my vehicle from the parking policies, and that violating any rule may result in towing at my expense.',
    );

    const btn = page.locator('#submitBtn');
    await expect(btn).toBeDisabled();
    await ack.check();
    await expect(btn).toBeEnabled();
    await expect(btn).toHaveText('Pay & register →');
  });

  test('submit posts a duration enum with no amount, then goes to Square', async ({ page }) => {
    await openForm(page, 'on');
    const bodies = await stubQuote(page, (route) => okQuote(route));

    await fillPaidForm(page);
    await page.click('#submitBtn');
    await page.waitForURL(`${CHECKOUT_URL}*`);

    expect(bodies).toHaveLength(1);
    const body = bodies[0];
    expect(body.property_id).toBe(PROPERTY_ID);
    expect(body.duration).toBe('h24');
    expect(body.plate_text).toBe('ABC1234');
    expect(body.back_plate).toBe('XYZ5678');
    expect(body.phone).toBe('+15551234567');
    expect(body.company_name).toBe('ACME Trucking');
    expect(body.visitor_name).toBe('John Smith');
    expect(body.policy_acknowledged).toBe(true);
    expect(body.recaptcha_token).toBe('stub-recaptcha-token');
    expect(String(body.idempotency_key).length).toBeGreaterThanOrEqual(16);
    expect(body).not.toHaveProperty('amount_cents');
    expect(body).not.toHaveProperty('stay_hours');
    expect(body).not.toHaveProperty('hours');
  });

  test('the same form keeps one key; changing the stay mints another', async ({ page }) => {
    await openForm(page, 'on');
    // 502 keeps the page put so we can retry the same form in one page load.
    const bodies = await stubQuote(page, (route) => refuse(route, 502, 'payments_unavailable'));

    await fillPaidForm(page);
    await page.click('#submitBtn');
    await expect(errorText(page)).toBeVisible();

    await page.click('#submitBtn');
    await expect.poll(() => bodies.length).toBe(2);

    await page.check('input[name="duration"][value="h48"]');
    await page.click('#submitBtn');
    await expect.poll(() => bodies.length).toBe(3);

    expect(bodies[1].idempotency_key).toBe(bodies[0].idempotency_key);
    expect(bodies[2].duration).toBe('h48');
    expect(bodies[2].idempotency_key).not.toBe(bodies[0].idempotency_key);

    // Both keys are the persisted ones, not module state.
    const stored = await page.evaluate(() =>
      Object.keys(sessionStorage).filter((k) => k.startsWith('plaza_idem_')).map((k) => sessionStorage.getItem(k)),
    );
    expect(stored).toHaveLength(2);
    expect(stored).toContain(bodies[0].idempotency_key);
    expect(stored).toContain(bodies[2].idempotency_key);
  });

  test('a settled quote is explained and the next attempt uses a fresh key', async ({ page }) => {
    await openForm(page, 'on');
    const bodies = await stubQuote(page, (route, i) =>
      i === 0 ? refuse(route, 409, 'quote_already_settled:paid') : okQuote(route));

    await fillPaidForm(page);
    await page.click('#submitBtn');

    await expect(errorText(page)).toHaveText('That payment attempt has already been used. Please try again.');
    expect(await page.evaluate(() =>
      Object.keys(sessionStorage).filter((k) => k.startsWith('plaza_idem_')).length)).toBe(0);

    await page.click('#submitBtn');
    await page.waitForURL(`${CHECKOUT_URL}*`);
    expect(bodies).toHaveLength(2);
    expect(bodies[1].idempotency_key).not.toBe(bodies[0].idempotency_key);
  });

  test('a plate hold shows the server wording', async ({ page }) => {
    await openForm(page, 'on');
    await stubQuote(page, (route) =>
      refuse(route, 409, 'This plate is on a 24-hour hold and cannot park yet.'));

    await fillPaidForm(page);
    await page.click('#submitBtn');
    await expect(errorText(page)).toHaveText('This plate is on a 24-hour hold and cannot park yet.');
  });

  test('429 and 503 map to plain language', async ({ page }) => {
    await openForm(page, 'on');
    let status = 429;
    let detail = 'too_many_pending_quotes';
    await stubQuote(page, (route) => refuse(route, status, detail));

    await fillPaidForm(page);
    await page.click('#submitBtn');
    await expect(errorText(page)).toHaveText(
      'Too many attempts in the last hour — please wait a bit and try again.');

    status = 503;
    detail = 'payments_unavailable';
    await page.click('#submitBtn');
    await expect(errorText(page)).toHaveText(
      'Payments are temporarily unavailable. Please try again in a few minutes.');
  });

  test('return from Square polls until the pass is live, then clears the key', async ({ page }) => {
    await stubPage(page, 'on');
    await page.addInitScript(() => sessionStorage.setItem('plaza_idem_deadbeef', 'old-key'));

    let calls = 0;
    await page.route(/\/plaza\/payments\/[^/]+\/status/, (route) => {
      calls += 1;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          calls === 1
            ? { payment_status: 'pending', pass_active: false }
            : { payment_status: 'paid', pass_active: true },
        ),
      });
    });

    await page.goto(`${origin}/visit.html?qr=${QR}&plaza_payment_id=${PAYMENT_ID}`);

    // Never "paid" from the query string alone.
    await expect(page.locator('#plazaStatus')).toHaveText('Confirming your payment…');
    await expect(page.locator('#passForm')).toHaveCount(0);

    await expect(page.locator('#plazaPaidCopy')).toHaveText(
      'Payment received. Your parking pass is active.', { timeout: 15_000 });
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(await page.evaluate(() =>
      Object.keys(sessionStorage).filter((k) => k.startsWith('plaza_idem_')).length)).toBe(0);
  });

  test('a failed payment says so instead of showing a pass', async ({ page }) => {
    await stubPage(page, 'on');
    await page.route(/\/plaza\/payments\/[^/]+\/status/, (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ payment_status: 'failed', pass_active: false }),
    }));

    await page.goto(`${origin}/visit.html?qr=${QR}&plaza_payment_id=${PAYMENT_ID}`);

    await expect(page.locator('#plazaFailed')).toHaveText('Payment did not go through.');
    await expect(page.locator('.success-card')).toHaveCount(0);
  });

  test('an unreadable pay_to_park_enabled column falls back to the free form', async ({ page }) => {
    const warnings: string[] = [];
    page.on('console', (m) => { if (m.type() === 'warning') warnings.push(m.text()); });

    await openForm(page, 'column-error');

    await expect(page.locator('#stayHours')).toBeVisible();
    await expect(page.locator('#payAck')).toHaveCount(0);
    await expect(page.locator('#submitBtn')).toHaveText('Get parking pass →');
    expect(warnings.join('\n')).toContain('pay_to_park_enabled unreadable');
  });
});
