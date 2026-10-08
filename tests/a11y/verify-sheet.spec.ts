/**
 * VerifyEmailSheet (Task 23, spec §5.9) — mounted standalone via the e2e
 * test-hook surface (`frontend/src/main.jsx`'s `window.__lotlogicTestHooks`,
 * the same mechanism `tests/e2e/pay2park-dashboard.spec.ts` uses for
 * TruckParkingLog), served from THIS branch's local build rather than
 * BASE_URL — the sheet isn't deployed yet, so scanning the live site would
 * either 404 or scan a stale bundle.
 *
 * No session, no `/auth/me` — the component takes `email` / `sentAt` as
 * props and talks to the backend only through `requestsApi.verifyEmail` /
 * `resendVerification`, both routed here.
 *
 * `scan(page, 'verify-sheet')` mirrors tests/a11y/axe.spec.ts's helper
 * (same blocking-impact set, no waivers) — kept local to this file because
 * that one isn't exported; the hq.spec.ts a11y file already keeps its own
 * local check rather than importing one.
 */
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { buildAndServeFrontend } from '../fixtures/buildAndServeFrontend';

const FRONTEND_DIR = path.resolve(__dirname, '../../frontend');
let server: Awaited<ReturnType<typeof buildAndServeFrontend>>;
test.beforeAll(async () => { server = await buildAndServeFrontend(FRONTEND_DIR); });
test.afterAll(async () => { await server.close(); });

const BLOCKING = new Set(['serious', 'critical']);

async function scan(page: Page, label: string) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .include('#verify-harness')
    .analyze();
  const blocking = results.violations.filter(v => BLOCKING.has(v.impact ?? ''));
  expect(blocking, `serious/critical a11y violations on ${label}:\n${JSON.stringify(blocking, null, 2)}`).toEqual([]);
}

interface MountOpts {
  mode?: 'code' | 'changeEmail';
  fromWall?: boolean;
  email?: string;
  sentAt?: string | null;
}

async function mountSheet(page: Page, opts: MountOpts = {}) {
  const { mode = 'code', fromWall = false, email = 'dana@sunsetridge.com', sentAt = null } = opts;

  await page.goto(`${server.origin}/dashboard.html?e2e=1`);
  await page.waitForFunction(
    () => typeof (window as any).__lotlogicTestHooks?.VerifyEmailSheet === 'function'
      && typeof (window as any).__lotlogicTestHooks?.ToastProvider === 'function',
    undefined,
    { timeout: 30_000 },
  );

  await page.evaluate(({ mode, fromWall, email, sentAt }) => {
    const hooks = (window as any).__lotlogicTestHooks;
    const { React, ReactDOM, VerifyEmailSheet } = hooks;

    function Harness() {
      const [open, setOpen] = React.useState(true);
      const [marker, setMarker] = React.useState(null as string | null);
      const [changedEmail, setChangedEmail] = React.useState(null as string | null);
      return React.createElement(
        React.Fragment,
        null,
        marker && React.createElement('div', { id: 'verify-marker', role: 'status' }, marker),
        // Stands in for App.jsx's handleEmailChanged — this harness doesn't
        // own a real `owner` object, so it just records what the sheet
        // handed back, which is exactly what the fix needs proven: that
        // VerifyEmailSheet calls onEmailChanged(newEmail) at all, and with
        // the submitted address.
        changedEmail && React.createElement('div', { id: 'email-changed-marker', role: 'status' }, changedEmail),
        React.createElement(VerifyEmailSheet, {
          open,
          email,
          sentAt,
          mode,
          fromWall,
          onClose: () => setOpen(false),
          onSuccess: () => { setOpen(false); setMarker('Email confirmed'); },
          onEmailChanged: (newEmail: string) => setChangedEmail(newEmail),
          onSignOut: () => setMarker('Signed out'),
        }),
      );
    }

    const host = document.createElement('div');
    host.id = 'verify-harness';
    document.body.appendChild(host);
    ReactDOM.createRoot(host).render(React.createElement(Harness));
  }, { mode, fromWall, email, sentAt });

  await expect(page.locator('.verify-sheet')).toBeVisible();
}

test.describe('VerifyEmailSheet @a11y', () => {
  test('the code-entry sheet has no serious a11y violations', async ({ page }) => {
    await mountSheet(page);
    await scan(page, 'verify-sheet');
  });

  test('wrong: a mismatched code clears the field and shows tries left', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route('**/auth/verify-email', (route) => route.fulfill({
      status: 400, contentType: 'application/json',
      body: JSON.stringify({ detail: 'code_mismatch', tries_left: 3 }),
    }));
    await mountSheet(page);
    await page.locator('.verify-code-input').fill('111111');
    await expect(page.locator('.verify-sheet-msg.error')).toHaveText("That code didn't match. 3 tries left.");
    await expect(page.locator('.verify-code-input')).toHaveValue('');
    await page.screenshot({ path: '/tmp/verify-sheet-wrong.png' });
  });

  test('exhausted: the 5th miss gets a fresh code, no tap needed', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route('**/auth/verify-email', (route) => route.fulfill({
      status: 400, contentType: 'application/json',
      body: JSON.stringify({ detail: 'code_exhausted' }),
    }));
    await mountSheet(page);
    await page.locator('.verify-code-input').fill('222222');
    await expect(page.locator('.verify-sheet-msg.error'))
      .toHaveText('Too many tries — we sent a fresh code to dana@sunsetridge.com.');
    await page.screenshot({ path: '/tmp/verify-sheet-exhausted.png' });
  });

  test('success: a matching code closes the sheet and fires onSuccess', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route('**/auth/verify-email', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ email_verified: true }),
    }));
    await mountSheet(page);
    await page.locator('.verify-code-input').fill('482190');
    await expect(page.locator('#verify-marker')).toHaveText('Email confirmed');
    await expect(page.locator('.verify-sheet')).toHaveCount(0);
    await page.locator('#verify-marker').screenshot({ path: '/tmp/verify-sheet-success.png' });
  });

  test('offline: a network failure keeps the code and says so', async ({ page }) => {
    await page.route('**/auth/verify-email', (route) => route.abort('failed'));
    await mountSheet(page);
    await page.locator('.verify-code-input').fill('333333');
    await expect(page.locator('.verify-sheet-msg.error')).toHaveText("Can't reach LotLogic — try again.");
  });

  test('the wall-opened variant has no ✕ and a Sign out link instead', async ({ page }) => {
    await mountSheet(page, { fromWall: true });
    await expect(page.locator('.verify-sheet-close')).toHaveCount(0);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.locator('#verify-marker')).toHaveText('Signed out');
  });

  test('change-email mode asks where to send the code instead', async ({ page }) => {
    await page.route('**/auth/change-email', (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }),
    }));
    await mountSheet(page, { mode: 'changeEmail' });
    await expect(page.getByText('Where should we send the code instead?')).toBeVisible();
    await page.locator('.verify-change-input').fill('new@example.com');
    await page.getByRole('button', { name: 'Send code' }).click();
    await expect(page.locator('.verify-sheet-sub')).toHaveText('We sent it to new@example.com');
  });

  test('change-email success also calls onEmailChanged, not just the sheet\'s own local state', async ({ page }) => {
    // Regression for the fix-round-1 blocking finding: a successful
    // "Change email" used to update only the sheet's own `currentEmail` —
    // nothing told the caller (App.jsx, which owns `owner.email` and is
    // what the banner actually renders), so the banner kept showing the
    // stale address indefinitely. onEmailChanged(newEmail) is the fix.
    await page.route('**/auth/change-email', (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }),
    }));
    await mountSheet(page, { mode: 'changeEmail' });
    await page.locator('.verify-change-input').fill('fresh@example.com');
    await page.getByRole('button', { name: 'Send code' }).click();
    await expect(page.locator('#email-changed-marker')).toHaveText('fresh@example.com');
  });

  test('a pasted "482-190" keeps digits only and auto-submits at 6', async ({ page }) => {
    // A real `paste` ClipboardEvent, not `.fill()` — the field's native
    // `maxlength=6` would otherwise truncate "482-190" (7 chars with the
    // dash) to "482-19" before this component's JS ever runs, same as it
    // would in a real browser. This is exactly the case the paste handler
    // in VerifyEmailSheet.jsx exists for.
    let body: string | null = null;
    await page.route('**/auth/verify-email', (route) => {
      body = route.request().postData();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ email_verified: true }) });
    });
    await mountSheet(page);
    await page.locator('.verify-code-input').focus();
    await page.evaluate(() => {
      const el = document.querySelector('.verify-code-input') as HTMLInputElement;
      const dt = new DataTransfer();
      dt.setData('text', '482-190');
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await expect(page.locator('#verify-marker')).toHaveText('Email confirmed');
    expect(JSON.parse(body!)).toEqual({ code: '482190' });
  });
});

// ── VerifyBanner's Resend cooldown gate (fix-round-1 blocking finding) ───
//
// The banner's Resend button had no client-side cooldown gate at all
// (`resendDisabled` was never passed at the App.jsx call site), so a user
// who double-tapped Resend inside the spec's 60s cooldown (e.g. right after
// signup auto-sends the first code) could race a real request through and
// get told "Can't reach LotLogic — try again" for the server's own
// documented 429 `resend_cooldown {retry_after}` — a normal-use path, not a
// contrived one. These mount the real `VerifyBanner` standalone (no App.jsx
// session machinery needed — it is a dumb props-in component) to prove the
// `resendDisabled` prop actually disables the button.
async function mountBanner(page: Page, opts: { resendDisabled?: boolean } = {}) {
  const { resendDisabled = false } = opts;
  await page.goto(`${server.origin}/dashboard.html?e2e=1`);
  await page.waitForFunction(
    () => typeof (window as any).__lotlogicTestHooks?.VerifyBanner === 'function',
    undefined,
    { timeout: 30_000 },
  );
  await page.evaluate(({ resendDisabled }) => {
    const { React, ReactDOM, VerifyBanner } = (window as any).__lotlogicTestHooks;
    const host = document.createElement('div');
    host.id = 'banner-harness';
    document.body.appendChild(host);
    ReactDOM.createRoot(host).render(React.createElement(VerifyBanner, {
      variant: 'banner',
      email: 'dana@sunsetridge.com',
      onEnterCode: () => {},
      onChangeEmail: () => {},
      onResend: () => {},
      resendDisabled,
    }));
  }, { resendDisabled });
}

test.describe('VerifyBanner resend cooldown @a11y', () => {
  test('resendDisabled=true disables the Resend button', async ({ page }) => {
    await mountBanner(page, { resendDisabled: true });
    await expect(page.getByRole('button', { name: 'Resend' })).toBeDisabled();
  });

  test('resendDisabled=false (the default, cooldown expired) leaves it tappable', async ({ page }) => {
    await mountBanner(page, { resendDisabled: false });
    await expect(page.getByRole('button', { name: 'Resend' })).toBeEnabled();
  });
});
