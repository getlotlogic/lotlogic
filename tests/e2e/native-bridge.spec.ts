/**
 * The native-shell bridge: the dashboard inside the LotLogic iPhone app
 * (spec 2026-10-18-lotlogic-iphone-app §2; `frontend/src/lib/native.js` and
 * its wiring in `frontend/src/App.jsx`).
 *
 * The app is the dashboard in a WebView. react-native-webview puts
 * `window.ReactNativeWebView` on the page; when it is there the dashboard
 *   - posts `{type:"session", token, email, role}` after every sign-in and
 *     once on load when a session exists, and `{type:"signed_out"}` when the
 *     person signs out;
 *   - exposes `window.LOTLOGIC_NATIVE_OPEN(url)`, which the shell calls with a
 *     push's `data.url` to land on that property, section and request
 *     without reloading the page.
 * Without it (any browser) nothing changes: no post, no global.
 *
 * Serves the BUILT frontend (fixtures/buildAndServeFrontend.ts, with
 * vercel.json's rewrites so `/app` is the real route) and answers every
 * backend and Supabase call locally — the fake token is `t0k3n` and nothing
 * here reaches a live service. Any other host (fonts, error reporting) is
 * aborted, and WebSockets (Supabase realtime) are mocked with no server.
 *
 * The shell is stood in for by `addInitScript`, which installs
 * `window.ReactNativeWebView = {postMessage}` before the bundle runs, the
 * way the WebView does. Its posts are collected in Node through an exposed
 * binding, so they survive a reload.
 *
 * Tagged @desktop-only: it builds and serves its own copy and drives
 * Chromium's safe-area emulation, so the mobile-safari project skips it.
 *
 * Run: cd tests && npx playwright test e2e/native-bridge --project=chromium-desktop
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import path from 'node:path';
import { buildAndServeFrontend } from '../fixtures/buildAndServeFrontend';

const FRONTEND_DIR = path.resolve(__dirname, '../../frontend');
const BACKEND = 'https://lotlogic-backend-production.up.railway.app';
const SUPABASE = 'https://nzdkoouoaedbbccraoti.supabase.co';
const TOKEN = 't0k3n';

const PROPERTY_ID = '33333333-3333-4333-8333-333333333333';
const PROPERTY_NAME = 'Example Commons';
const REQUEST_ID = '44444444-4444-4444-8444-444444444444';
const SECOND_REQUEST_ID = '55555555-5555-4555-8555-555555555555';

type Role = 'partner' | 'owner';
const ACCOUNTS: Record<Role, { id: string; email: string; name: string }> = {
  partner: { id: '11111111-1111-4111-8111-111111111111', email: 'truck@example.com', name: 'Example Towing' },
  owner: { id: '22222222-2222-4222-8222-222222222222', email: 'office@example.com', name: 'Example Apartments' },
};

let origin: string;
let closeServer: () => Promise<void>;

test.beforeAll(async () => {
  ({ origin, close: closeServer } = await buildAndServeFrontend(FRONTEND_DIR));
});

test.afterAll(async () => {
  await closeServer();
});

// ── the stand-in backend ───────────────────────────────────────

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, HEAD, OPTIONS',
  'access-control-expose-headers': 'content-range',
};

function json(route: Route, body: unknown, status = 200, headers: Record<string, string> = {}) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: { ...CORS, ...headers },
    body: JSON.stringify(body),
  });
}

/** One active request row in the `/apartment/requests` shape. */
function requestRow(id: string, kind: 'hold' | 'tow', n: number) {
  const now = Date.now();
  return {
    id,
    ref: `${kind === 'hold' ? 'H' : 'T'}-${String(n).padStart(4, '0')}`,
    kind,
    status: 'active',
    property_id: PROPERTY_ID,
    plate: `EXA${String(n).padStart(4, '0')}`,
    created_at: new Date(now - 60 * 60 * 1000).toISOString(),
    expires_at: new Date(now + 20 * 60 * 60 * 1000).toISOString(),
    sent_at: new Date(now - 59 * 60 * 1000).toISOString(),
    created_by: { name: 'Example' },
  };
}

/**
 * Thirty holds, then the two tow requests a push can name. Holds render
 * first, so the tows sit far below the fold on a desktop viewport: landing
 * on one in view only happens if the page scrolled to it.
 */
function requestList() {
  const holds = Array.from({ length: 30 }, (_, i) =>
    requestRow(`66666666-6666-4666-8666-${String(i).padStart(12, '0')}`, 'hold', i + 1));
  return [...holds, requestRow(REQUEST_ID, 'tow', 101), requestRow(SECOND_REQUEST_ID, 'tow', 102)];
}

interface StubOptions {
  /** `GET /auth/me` answers 401 (an expired or revoked token). */
  meUnauthorized?: boolean;
}

async function stubNetwork(page: Page, role: Role, opts: StubOptions = {}) {
  const account = ACCOUNTS[role];
  const meProperty = {
    id: PROPERTY_ID,
    name: PROPERTY_NAME,
    address: '1 Example Way, Charlotte, NC',
    role: role === 'owner' ? 'admin' : 'partner',
    member_status: 'active',
    verification_status: 'verified',
    property_type: 'apartment',
    features: { passes: false, qr: false, cameras: false },
  };
  const propertyRow = {
    id: PROPERTY_ID,
    name: PROPERTY_NAME,
    address: '1 Example Way, Charlotte, NC',
    property_type: 'apartment',
    owner_id: ACCOUNTS.owner.id,
    tow_company_id: ACCOUNTS.partner.id,
    qr_code_id: null,
    created_at: '2026-10-01T00:00:00Z',
  };

  // WebSockets (Supabase realtime): mocked, never connected anywhere.
  await page.routeWebSocket(/.*/, () => {});

  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());

    if (url.origin === origin) return route.continue();

    if (req.method() === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: { ...CORS, 'access-control-allow-headers': req.headers()['access-control-request-headers'] ?? '*' },
      });
    }

    if (url.origin === BACKEND) {
      const p = url.pathname;
      if (req.method() === 'POST' && p === '/auth/login') {
        return json(route, {
          token: TOKEN,
          expires_in: 604800,
          subject: { id: account.id, email: account.email, type: role, display_name: account.name },
        });
      }
      if (req.method() === 'GET' && p === '/auth/me') {
        if (opts.meUnauthorized) return json(route, { detail: 'invalid_token' }, 401);
        return json(route, {
          email: account.email,
          is_admin: false,
          is_platform_admin: false,
          email_verified: true,
          properties: [meProperty],
          pending_joins: 0,
        });
      }
      if (req.method() === 'GET' && p === '/apartment/requests') {
        const view = url.searchParams.get('view');
        return json(route, { items: view === 'active' ? requestList() : [] });
      }
      if (req.method() === 'GET' && p.startsWith('/partner/properties')) return json(route, { items: [] });
      return json(route, {});
    }

    if (url.origin === SUPABASE) {
      const p = url.pathname;
      const wantsObject = (req.headers()['accept'] ?? '').includes('vnd.pgrst.object');
      if (p === '/rest/v1/properties' && wantsObject) return json(route, propertyRow);
      if (p.startsWith('/rest/v1/')) {
        if (wantsObject) return json(route, { code: 'PGRST116', message: 'no rows' }, 406);
        return json(route, [], 200, { 'content-range': '*/0' });
      }
      return json(route, {});
    }

    // Fonts, error reporting, anything else: never leaves the machine.
    return route.abort();
  });
}

// ── the stand-in shell ─────────────────────────────────────────

/**
 * `window.ReactNativeWebView = {postMessage}` before any page script runs,
 * as react-native-webview does. Returns the raw strings the page posted.
 */
async function installShell(page: Page): Promise<string[]> {
  const posted: string[] = [];
  await page.exposeFunction('__lotlogicShellSpy', (raw: string) => { posted.push(raw); });
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, any>;
    w.ReactNativeWebView = { postMessage: (raw: string) => { w.__lotlogicShellSpy(raw); } };
  });
  return posted;
}

/** What the shell's injected bootstrap does before the page loads (§3.3). */
async function seedSession(page: Page, role: Role) {
  const account = ACCOUNTS[role];
  await page.addInitScript(({ account, role, token }) => {
    // Once per page, not once per document: a reload must find what the
    // page itself left (sign-out clears it).
    if (sessionStorage.getItem('__seeded')) return;
    sessionStorage.setItem('__seeded', '1');
    localStorage.setItem('lotlogic_session', JSON.stringify({
      id: account.id,
      email: account.email,
      business_name: account.name,
      is_admin: false,
      is_platform_admin: false,
      _role: role,
      _token: token,
      _ts: Date.now(),
    }));
  }, { account, role, token: TOKEN });
}

const parse = (raw: string) => JSON.parse(raw);
const header = (page: Page) => page.locator('header.header');

async function signIn(page: Page, role: Role) {
  await page.locator('#login-email').fill(ACCOUNTS[role].email);
  await page.locator('#login-password').fill('not-a-real-password');
  await page.getByRole('button', { name: /Sign In/ }).click();
  await expect(header(page)).toBeVisible({ timeout: 20_000 });
}

async function signOut(page: Page) {
  await page.getByRole('tab', { name: 'Account' }).click();
  await page.getByRole('button', { name: 'Sign Out' }).click();
  await expect(page.locator('#login-email')).toBeVisible();
}

async function emulateNotch(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 47, bottom: 34, left: 0, right: 0 } });
}

async function chromeMetrics(page: Page) {
  return page.evaluate(() => {
    const h = getComputedStyle(document.querySelector('header.header')!);
    const n = getComputedStyle(document.querySelector('nav.bottom-nav')!);
    return { headerPaddingTop: h.paddingTop, headerHeight: h.height, navPaddingBottom: n.paddingBottom };
  });
}

test.describe('native shell bridge @desktop-only', () => {
  test.beforeEach(({ browserName }) => {
    test.skip(browserName !== 'chromium', 'serves its own build and uses Chromium safe-area emulation');
  });

  // (a) ──────────────────────────────────────────────────────────
  test('in a browser the page posts nothing, creates no bridge global, and the header is unchanged', async ({ page }) => {
    await stubNetwork(page, 'owner');
    // Any fallback channel (window.postMessage, a parent frame) would show up here.
    await page.addInitScript(() => {
      const w = window as unknown as Record<string, any>;
      const seen: unknown[] = [];
      w.__windowPosts = seen;
      const original = window.postMessage.bind(window);
      window.postMessage = ((message: unknown, ...rest: any[]) => { seen.push(message); return (original as any)(message, ...rest); }) as typeof window.postMessage;
    });

    await page.goto(`${origin}/app`);
    await signIn(page, 'owner');
    await page.reload();
    await expect(header(page)).toBeVisible();

    const globals = await page.evaluate(() => ({
      shell: 'ReactNativeWebView' in window,
      open: 'LOTLOGIC_NATIVE_OPEN' in window,
    }));
    expect(globals).toEqual({ shell: false, open: false });

    // The signed-in header, exactly as the dashboard draws it.
    await expect(header(page)).toHaveAttribute('class', 'header');
    expect(await header(page).getAttribute('style')).toBeNull();
    await expect(header(page).locator('.header-wordmark')).toHaveText('LotLogic');
    await expect(header(page).locator('.header-name')).toHaveText(ACCOUNTS.owner.name);

    await signOut(page);
    const ours = await page.evaluate(() => ((window as unknown as Record<string, any>).__windowPosts as unknown[])
      .filter((m) => typeof m === 'string' && /"type"\s*:\s*"(session|signed_out)"/.test(m)));
    expect(ours).toEqual([]);
  });

  // (b) ──────────────────────────────────────────────────────────
  for (const role of ['partner', 'owner'] as const) {
    test(`in the shell, a ${role} sign-in posts the session, a reload posts it again, sign-out posts signed_out`, async ({ page }) => {
      const posted = await installShell(page);
      await stubNetwork(page, role);

      await page.goto(`${origin}/app`);
      await expect(page.locator('#login-email')).toBeVisible();
      expect(posted, 'signed out, the page has no session to post').toEqual([]);

      await signIn(page, role);
      const session = { type: 'session', token: TOKEN, email: ACCOUNTS[role].email, role };
      await expect.poll(() => posted.map(parse)).toStrictEqual([session]);
      expect(typeof posted[0], 'the shell receives one JSON string').toBe('string');

      await page.reload();
      await expect(header(page)).toBeVisible();
      await expect.poll(() => posted.map(parse)).toStrictEqual([session, session]);

      await signOut(page);
      await expect.poll(() => posted.map(parse)).toStrictEqual([session, session, { type: 'signed_out' }]);
      expect(await page.evaluate(() => localStorage.getItem('lotlogic_session'))).toBeNull();
    });
  }

  test('in the shell, a stored session the server refuses is posted on load but is not a sign-out', async ({ page }) => {
    const posted = await installShell(page);
    await stubNetwork(page, 'owner', { meUnauthorized: true });
    await seedSession(page, 'owner');

    await page.goto(`${origin}/app`);
    await expect(page.locator('#login-email')).toBeVisible({ timeout: 20_000 });
    // Settle: anything the bounce were going to post has had its chance.
    await page.waitForTimeout(500);
    expect(posted.map(parse)).toStrictEqual([
      { type: 'session', token: TOKEN, email: ACCOUNTS.owner.email, role: 'owner' },
    ]);
  });

  // (c) ──────────────────────────────────────────────────────────
  test('in the shell, LOTLOGIC_NATIVE_OPEN opens the request a push names, without a reload, and ignores a foreign origin', async ({ page }) => {
    await installShell(page);
    await stubNetwork(page, 'owner');
    await seedSession(page, 'owner');
    // The property page remembers its last section; a push must still land
    // on Requests when the link names a request and no section.
    await page.addInitScript(() => localStorage.setItem('lotlogic_pd_section:apartment', 'log'));

    await page.goto(`${origin}/app`);
    await expect(page.getByText(PROPERTY_NAME).first()).toBeVisible({ timeout: 20_000 });
    await page.evaluate(() => { (window as unknown as Record<string, any>).__sameDocument = true; });
    const open = (url: string) => page.evaluate((u) => (window as unknown as Record<string, any>).LOTLOGIC_NATIVE_OPEN(u), url);

    // A foreign origin is ignored: nothing opens, the address bar is untouched.
    expect(await open(`https://evil.example/app?property=${PROPERTY_ID}&section=requests&request=${REQUEST_ID}`)).toBe(false);
    expect(await open(`//evil.example/app?property=${PROPERTY_ID}&request=${REQUEST_ID}`)).toBe(false);
    await page.waitForTimeout(300);
    await expect(page.locator('[data-request-id]')).toHaveCount(0);
    expect(new URL(page.url()).search).toBe('');

    // The push link: that property, its Requests section, that request.
    expect(await open(`https://lotlogicparking.com/app?property=${PROPERTY_ID}&request=${REQUEST_ID}`)).toBe(true);
    const row = page.locator(`[data-request-id="${REQUEST_ID}"]`);
    await expect(row).toHaveClass(/req-flag/, { timeout: 20_000 });
    await expect(row).toBeInViewport();
    expect(await page.evaluate(() => (window as unknown as Record<string, any>).__sameDocument)).toBe(true);
    await expect.poll(() => new URL(page.url()).search, { message: 'the deep link is cleaned out of the address bar' }).toBe('');

    // A second push while that property is open moves to the new request.
    expect(await open(`/app?property=${PROPERTY_ID}&section=requests&request=${SECOND_REQUEST_ID}`)).toBe(true);
    const second = page.locator(`[data-request-id="${SECOND_REQUEST_ID}"]`);
    await expect(second).toHaveClass(/req-flag/, { timeout: 20_000 });
    await expect(second).toBeInViewport();
    await expect(row).not.toHaveClass(/req-flag/);
    expect(await page.evaluate(() => (window as unknown as Record<string, any>).__sameDocument)).toBe(true);
  });

  test('in the shell, a push opened before sign-in lands on its request once the person signs in', async ({ page }) => {
    await installShell(page);
    await stubNetwork(page, 'partner');

    await page.goto(`${origin}/app`);
    await expect(page.locator('#login-email')).toBeVisible();
    expect(await page.evaluate((u) => (window as unknown as Record<string, any>).LOTLOGIC_NATIVE_OPEN(u),
      `https://lotlogicparking.com/app?property=${PROPERTY_ID}&section=requests&request=${REQUEST_ID}`)).toBe(true);

    await signIn(page, 'partner');
    const row = page.locator(`[data-request-id="${REQUEST_ID}"]`);
    await expect(row).toHaveClass(/req-flag/, { timeout: 20_000 });
    await expect(row).toBeInViewport();
  });

  // (d) ──────────────────────────────────────────────────────────
  // The dashboard's header and bottom nav already pad by env(safe-area-*)
  // for everyone (viewport-fit=cover, the home-screen web app). Inside the
  // shell that is what clears the notch; the browser keeps exactly what it
  // had — making it shell-only would take it away from the home-screen web
  // app, which the bridge must not change.
  test('in the shell, the header clears the notch and the nav clears the home indicator', async ({ page }) => {
    await installShell(page);
    await stubNetwork(page, 'owner');
    await seedSession(page, 'owner');
    await page.goto(`${origin}/app`);
    await expect(header(page)).toBeVisible({ timeout: 20_000 });

    expect(await chromeMetrics(page), 'no notch, no padding').toEqual({
      headerPaddingTop: '0px', headerHeight: '58px', navPaddingBottom: '0px',
    });
    await emulateNotch(page);
    expect(await chromeMetrics(page)).toEqual({
      headerPaddingTop: '47px', headerHeight: '105px', navPaddingBottom: '34px',
    });
  });

  test('in a browser, the same notch gets the same header and nav as before the bridge', async ({ page }) => {
    await stubNetwork(page, 'owner');
    await seedSession(page, 'owner');
    await page.goto(`${origin}/app`);
    await expect(header(page)).toBeVisible({ timeout: 20_000 });

    await emulateNotch(page);
    expect(await chromeMetrics(page)).toEqual({
      headerPaddingTop: '47px', headerHeight: '105px', navPaddingBottom: '34px',
    });
  });
});
