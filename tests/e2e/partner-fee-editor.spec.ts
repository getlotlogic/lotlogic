/**
 * Partner fee editor — `PartnerFeeEditor` in `frontend/dashboard.html`.
 *
 * Fees are locked for partners: `enforcement_partners.tow_fee`/`boot_fee` are
 * read-only GENERATED dollar columns (back-compat reads only), and the
 * backend's `PATCH /partners/{id}` allowlist only accepts the `_cents`
 * fields from a service / platform-admin caller — never from a partner's own
 * session. So a real partner sees a plain read-only display (no inputs, no
 * Save); only a platform-admin session gets the editable form, which saves
 * through the backend in cents.
 *
 * This spec serves the local, uncommitted `frontend/` tree over a throwaway
 * static server (the fix hasn't been deployed) and stubs every network call
 * the dashboard makes on load, so it never touches the live backend or
 * Supabase project.
 *
 * Run: cd tests && npx playwright test partner-fee-editor --project=chromium-desktop
 */
import { test, expect, type Page } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const FRONTEND_DIR = path.resolve(__dirname, '../../frontend');
const BACKEND_HOST = 'lotlogic-backend-production.up.railway.app';
const SUPABASE_HOST = 'nzdkoouoaedbbccraoti.supabase.co';
const PARTNER_ID = '11111111-1111-1111-1111-111111111111';

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

/**
 * Seed an already-authenticated partner session before any app script runs.
 * The session's own `_role` is always 'partner' — that's what makes
 * `PartnerFeeEditor` render at all (`AccountPage`'s `!isOwner` gate). Whether
 * the *editable* form appears on top of that is driven by `is_platform_admin`
 * on the session, which the App component reads straight off `owner` before
 * its `/auth/me` self-heal call resolves.
 */
async function seedPartnerSession(page: Page, { isPlatformAdmin = false } = {}) {
  await page.addInitScript(({ partnerId, isPlatformAdmin }) => {
    localStorage.setItem('lotlogic_session', JSON.stringify({
      id: partnerId,
      _role: 'partner',
      _token: 'fake.jwt.for-test',
      _ts: Date.now(),
      email: 'partner@example.com',
      contact_name: 'Test Partner',
      is_platform_admin: isPlatformAdmin,
      // Mirrors what a real session carries after the post-login Supabase
      // enrichment (read-only dollar values, from the GENERATED columns).
      tow_fee: 250,
      boot_fee: 75,
    }));
  }, { partnerId: PARTNER_ID, isPlatformAdmin });
}

/**
 * Stub every backend/Supabase call the dashboard fires on load for a partner
 * session, and capture the one PATCH under test. `onPatch` receives the
 * parsed JSON body every time `PATCH /partners/{id}` is hit.
 */
async function stubNetwork(page: Page, onPatch: (body: unknown) => void, { isPlatformAdmin = false } = {}) {
  await page.route(/fonts\.(googleapis|gstatic)\.com|google\.com\/recaptcha/, (r) => r.abort());

  await page.route(new RegExp(`^https://${BACKEND_HOST}/`), (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === 'PATCH' && url.pathname === `/partners/${PARTNER_ID}`) {
      onPatch(req.postDataJSON());
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: PARTNER_ID }),
      });
    }
    if (req.method() === 'GET' && url.pathname === '/auth/me') {
      // The App component self-heals admin flags from /auth/me on mount and
      // overwrites the seeded session with whatever this returns — echo the
      // same is_platform_admin so the two stay consistent.
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ email: 'partner@example.com', is_admin: false, is_platform_admin: isPlatformAdmin }),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.route(new RegExp(`^https://${SUPABASE_HOST}/`), (route) => {
    const req = route.request();
    const url = new URL(req.url());
    // The dashboard only renders money surfaces (including the fee editor)
    // once it has at least one lot for this partner — `showMoney` gates on
    // `lots.length > 0`.
    if (req.method() === 'GET' && url.pathname === '/rest/v1/lots') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ id: 'lot-1', partner_id: PARTNER_ID, owner_id: 'owner-1', active: true, name: 'Test Lot' }]),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
}

test.describe('partner fee editor @desktop-only', () => {
  test('a partner session sees fees as read-only, with no Save path', async ({ page }) => {
    await seedPartnerSession(page, { isPlatformAdmin: false });
    await stubNetwork(page, () => {}, { isPlatformAdmin: false });

    await page.goto(`${origin}/dashboard.html`);
    await page.getByRole('tab', { name: 'Account' }).click();

    const feeSection = page.locator('.settings-section').filter({ hasText: 'Your fees' });
    await expect(feeSection).toBeVisible({ timeout: 15_000 });

    // The dollar amounts are shown as plain text, not editable inputs.
    await expect(feeSection.getByText('$250')).toBeVisible();
    await expect(feeSection.getByText('$75')).toBeVisible();
    await expect(page.getByLabel('Tow fee in dollars')).toHaveCount(0);
    await expect(page.getByLabel('Boot fee in dollars')).toHaveCount(0);
    await expect(feeSection.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);

    await expect(feeSection.getByText('Fees are set by LotLogic — contact us to change them.')).toBeVisible();
  });

  test('a platform-admin session can save fees, PATCHing the backend in cents', async ({ page }) => {
    let patchBody: any = null;
    await seedPartnerSession(page, { isPlatformAdmin: true });
    await stubNetwork(page, (body) => { patchBody = body; }, { isPlatformAdmin: true });

    await page.goto(`${origin}/dashboard.html`);
    await page.getByRole('tab', { name: 'Account' }).click();

    const towInput = page.getByLabel('Tow fee in dollars');
    const bootInput = page.getByLabel('Boot fee in dollars');
    await expect(towInput).toBeVisible({ timeout: 15_000 });
    await expect(bootInput).toBeVisible();

    await towInput.fill('300');
    await bootInput.fill('90');

    await page.getByRole('button', { name: 'Save', exact: true }).click();

    await expect.poll(() => patchBody, {
      message: 'PartnerFeeEditor must PATCH the backend on save',
      timeout: 10_000,
    }).not.toBeNull();

    // Dollars in the form, cents on the wire — and only the two fields the
    // form edits, nothing else (no `tow_fee`/`boot_fee` dollar keys, which
    // are read-only GENERATED columns the backend allowlist rejects).
    expect(patchBody).toEqual({ tow_fee_cents: 30000, boot_fee_cents: 9000 });

    await expect(page.getByText('✓ Saved')).toBeVisible({ timeout: 5_000 });
  });

  test('a platform-admin session sees a failed save surfaced via the toast, not a silent drop', async ({ page }) => {
    await seedPartnerSession(page, { isPlatformAdmin: true });
    await stubNetwork(page, () => {}, { isPlatformAdmin: true });

    // Override just the PATCH to fail, mimicking the allowlist rejecting a
    // field this caller may not set.
    await page.route(new RegExp(`^https://${BACKEND_HOST}/partners/${PARTNER_ID}$`), (route) => {
      if (route.request().method() === 'PATCH') {
        return route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ detail: "Field 'tow_fee_cents' is not editable via this endpoint." }),
        });
      }
      return route.continue();
    });

    await page.goto(`${origin}/dashboard.html`);
    await page.getByRole('tab', { name: 'Account' }).click();

    const towInput = page.getByLabel('Tow fee in dollars');
    await expect(towInput).toBeVisible({ timeout: 15_000 });
    await towInput.fill('300');
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    await expect(page.getByText(/not editable via this endpoint/i).first()).toBeVisible({ timeout: 10_000 });
    // Toast system (`useToast`/`addToast`) also carries the failure.
    await expect(page.locator('.toast.error')).toBeVisible({ timeout: 10_000 });
  });
});
