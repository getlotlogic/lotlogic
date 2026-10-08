/**
 * Public signup — `/join/<slug>` (Task 25, spec §3.1–§3.4, §5.1).
 *
 * Mounted standalone through the `?e2e=1` test-hook surface
 * (`frontend/src/main.jsx`), served from THIS branch's local build rather
 * than BASE_URL: the page is not deployed yet, and the tiny static server in
 * `tests/fixtures/buildAndServeFrontend.ts` serves files only — it has no
 * `/join → dashboard.html` rewrite (that lives in `vercel.json`), so the
 * real route is not reachable there. Everything this page does on mount
 * (`GET /auth/signup/context`, `GET /auth/signup/match`, `POST /auth/signup`)
 * is routed, so no backend and no session are needed.
 *
 * `scan()` mirrors tests/a11y/axe.spec.ts's helper — same blocking-impact
 * set, WAIVED deliberately empty (the global constraint).
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
    .include('#signup-harness')
    .analyze();
  const blocking = results.violations.filter(v => BLOCKING.has(v.impact ?? ''));
  // eslint-disable-next-line no-console
  console.log(`[a11y ${label}] ${results.violations.length} violations:`,
    JSON.stringify(results.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })), null, 2));
  expect(blocking, `serious/critical a11y violations on ${label}:\n${JSON.stringify(blocking, null, 2)}`).toEqual([]);
}

const CONTEXT = {
  partner: { name: 'N Style Towing', phone_set: true },
  partners: [
    { slug: 'nstyle', name: 'N Style Towing' },
    { slug: 'frank', name: "Frank's Towing" },
  ],
};

interface MountOpts {
  slug?: string | null; mode?: string; light?: boolean;
  /** Replaces the default 200 CONTEXT answer; `n` counts calls from 1. */
  context?: (route: import('@playwright/test').Route, n: number) => Promise<void>;
}

async function mountSignup(page: Page, opts: MountOpts = {}) {
  const { slug = 'nstyle', mode = 'signup', light = false, context } = opts;
  let calls = 0;
  await page.unroute('**/auth/signup/context**');
  await page.route('**/auth/signup/context**', route => {
    calls += 1;
    if (context) return context(route, calls);
    return route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(CONTEXT),
    });
  });
  await page.goto(`${server.origin}/dashboard.html?e2e=1`);
  await page.waitForFunction(
    () => typeof (window as any).__lotlogicTestHooks?.SignupPage === 'function',
    undefined,
    { timeout: 30_000 },
  );
  await page.evaluate(({ slug, mode, light }) => {
    const hooks = (window as any).__lotlogicTestHooks;
    const host = document.createElement('div');
    host.id = 'signup-harness';
    // App.jsx wraps every page in `.app` / `.app.theme-light`; the harness
    // reproduces that so the light theme's token overrides actually apply.
    host.className = light ? 'app theme-light' : 'app';
    document.body.innerHTML = '';
    document.body.appendChild(host);
    hooks.ReactDOM.createRoot(host).render(
      hooks.React.createElement(hooks.ToastProvider, null,
        hooks.React.createElement(hooks.SignupPage, {
          slug, mode,
          theme: 'light',
          onToggleTheme: () => {},
          onDone: (session: any, nav: any) => {
            const marker = document.createElement('div');
            marker.id = 'signup-done';
            marker.textContent = JSON.stringify({ token: session?._token, url: nav?.url ?? null });
            document.body.appendChild(marker);
          },
        })),
    );
  }, { slug, mode, light });
}

/** Fill every one of the seven fields with a valid answer. */
async function fillValid(page: Page) {
  await page.locator('#signup-name').fill('Sunset Ridge Apartments');
  await page.locator('#signup-address').fill('123 Main St');
  await page.locator('input[placeholder="City"]').fill('Charlotte');
  await page.locator('.signup-state').fill('NC');
  await page.locator('input[placeholder="ZIP"]').fill('28205');
  await page.locator('#signup-contact').fill('Dana Ortiz');
  await page.getByRole('radio', { name: 'Property manager' }).click();
  await page.locator('#signup-email').fill('dana@sunsetridge.com');
  await page.locator('#signup-phone').fill('7045550123');
  await page.locator('#signup-password').fill('a short sentence works');
}

test.describe('public signup @a11y', () => {
  test('the form has no serious a11y violations', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 1200 });
    await mountSignup(page);
    await expect(page.getByText('N Style Towing uses LotLogic for parking requests. About a minute.')).toBeVisible();
    await scan(page, 'join');
    await page.screenshot({ path: '/tmp/join-form-390.png', fullPage: true });
  });

  test('the form has no serious a11y violations in the light theme either', async ({ page }) => {
    // The default `useTheme()` value is 'light', so this is the theme most
    // visitors land in; the scan above runs the dark tokens. Both grounds
    // matter — Ruling S3-b's whole point was a literal measured against only
    // one of them.
    await page.setViewportSize({ width: 390, height: 1200 });
    await mountSignup(page, { light: true });
    await expect(page.locator('#signup-name')).toBeVisible();
    await scan(page, 'join-light');
    await page.screenshot({ path: '/tmp/join-form-light-390.png', fullPage: true });
  });

  test('the manual-entry layout has no serious a11y violations', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 1200 });
    await mountSignup(page);
    // No VITE_GOOGLE_MAPS_KEY in this build, so the form already opens in
    // manual mode — assert that rather than clicking a link that is absent.
    await expect(page.locator('.signup-manual')).toBeVisible();
    await expect(page.locator('input[placeholder="ZIP"]')).toBeVisible();
    await scan(page, 'join-manual');
    await page.screenshot({ path: '/tmp/join-manual-390.png', fullPage: true });
  });

  test('the locked partner chip comes from the slug and is not editable', async ({ page }) => {
    await mountSignup(page);
    const chip = page.locator('.signup-partner-chip');
    await expect(chip).toHaveText('🚚 Requests go to N Style Towing');
    await expect(chip.locator('input, select, button')).toHaveCount(0);
  });

  test('an invalid slug says so instead of showing the form', async ({ page }) => {
    await page.route('**/auth/signup/context**', route => route.fulfill({
      status: 404, contentType: 'application/json', body: JSON.stringify({ detail: 'unknown_slug' }),
    }));
    await page.goto(`${server.origin}/dashboard.html?e2e=1`);
    await page.waitForFunction(() => typeof (window as any).__lotlogicTestHooks?.SignupPage === 'function',
      undefined, { timeout: 30_000 });
    await page.evaluate(() => {
      const hooks = (window as any).__lotlogicTestHooks;
      const host = document.createElement('div');
      host.id = 'signup-harness';
      document.body.innerHTML = '';
      document.body.appendChild(host);
      hooks.ReactDOM.createRoot(host).render(
        hooks.React.createElement(hooks.ToastProvider, null,
          hooks.React.createElement(hooks.SignupPage, { slug: 'nope', onDone: () => {} })),
      );
    });
    await expect(page.getByText("This link isn't valid. Ask your tow company for a new one.")).toBeVisible();
    await expect(page.locator('#signup-name')).toHaveCount(0);
  });

  test('bare /join asks who tows the property first, with Not listed', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mountSignup(page, { slug: null });
    await expect(page.getByRole('heading', { name: 'Who tows your property?' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'N Style Towing' })).toBeVisible();
    await expect(page.getByRole('button', { name: "Frank's Towing" })).toBeVisible();
    await page.getByRole('button', { name: 'Not listed' }).click();
    // "Not listed" goes straight to the form with no partner behind it.
    await expect(page.locator('#signup-name')).toBeVisible();
  });

  test('validation never fires on an untouched field, then goes live after the first error', async ({ page }) => {
    await mountSignup(page);
    await expect(page.locator('.signup-error')).toHaveCount(0);
    const nameField = page.locator('#signup-name');
    await nameField.fill('S');
    // Still untouched (not blurred) — nothing may be said yet.
    await expect(page.locator('.signup-error')).toHaveCount(0);
    await nameField.blur();
    await expect(page.getByText("Enter the property's name, as it appears on the sign.")).toBeVisible();
    // Live from here on: typing a valid value clears it without another blur.
    await nameField.fill('Sunset Ridge Apartments');
    await expect(page.getByText("Enter the property's name, as it appears on the sign.")).toHaveCount(0);
  });

  test('a short password gets the 12-character copy', async ({ page }) => {
    await mountSignup(page);
    await page.locator('#signup-password').fill('elevenchars');
    await page.locator('#signup-password').blur();
    await expect(page.getByText('Use at least 12 characters.')).toBeVisible();
  });

  test('Show/Hide flips the password field, and there is no confirm field', async ({ page }) => {
    await mountSignup(page);
    const pw = page.locator('#signup-password');
    await pw.fill('a short sentence works');
    await expect(pw).toHaveAttribute('type', 'password');
    await page.getByRole('button', { name: 'Show' }).click();
    await expect(pw).toHaveAttribute('type', 'text');
    await expect(page.locator('input[type=password]')).toHaveCount(0);
  });

  test('the phone field formats as you type and submits E.164', async ({ page }) => {
    let body: any = null;
    await page.route('**/auth/signup', route => {
      body = JSON.parse(route.request().postData() || '{}');
      return route.fulfill({
        status: 201, contentType: 'application/json',
        body: JSON.stringify({ token: 'fake-token', expires_in: 3600, next: 'property', property_id: 'p-1', subject: { id: 'a1', email: 'dana@sunsetridge.com', type: 'owner' } }),
      });
    });
    await mountSignup(page);
    await fillValid(page);
    await expect(page.locator('#signup-phone')).toHaveValue('(704) 555-0123');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.locator('#signup-done')).toBeVisible();
    expect(body.account.phone).toBe('+17045550123');
    expect(body.account.position).toBe('Property manager');
    expect(body.slug).toBe('nstyle');
    expect(body.property.postal_code).toBe('28205');
    expect(JSON.parse(await page.locator('#signup-done').innerText()).url)
      .toBe('/app?property=p-1&section=requests&firstrun=1');
  });

  test('the draft in sessionStorage never carries the password', async ({ page }) => {
    await mountSignup(page);
    await fillValid(page);
    const raw = await page.evaluate(() => sessionStorage.getItem('lotlogic_signup_draft'));
    expect(raw).toBeTruthy();
    expect(raw).toContain('Sunset Ridge Apartments');
    expect(raw).not.toContain('a short sentence works');
    expect(raw!.toLowerCase()).not.toContain('password');
  });

  test('the draft survives a reload: every answer but the password comes back', async ({ page }) => {
    await mountSignup(page);
    await fillValid(page);
    // Let the save effect commit the last keystroke.
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('lotlogic_signup_draft')))
      .toContain('7045550123');
    // A real reload (same tab, so the same sessionStorage), then a fresh mount.
    await page.reload();
    await mountSignup(page);
    await expect(page.locator('#signup-name')).toHaveValue('Sunset Ridge Apartments');
    await expect(page.locator('#signup-address')).toHaveValue('123 Main St');
    await expect(page.locator('input[placeholder="City"]')).toHaveValue('Charlotte');
    await expect(page.locator('.signup-state')).toHaveValue('NC');
    await expect(page.locator('input[placeholder="ZIP"]')).toHaveValue('28205');
    await expect(page.locator('#signup-contact')).toHaveValue('Dana Ortiz');
    await expect(page.getByRole('radio', { name: 'Property manager' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('#signup-email')).toHaveValue('dana@sunsetridge.com');
    await expect(page.locator('#signup-phone')).toHaveValue('(704) 555-0123');
    await expect(page.locator('#signup-password')).toHaveValue('');
    // And the stored copy was not clobbered by the remount's first save.
    expect(await page.evaluate(() => sessionStorage.getItem('lotlogic_signup_draft')))
      .toContain('Sunset Ridge Apartments');
  });

  test('a draft parked for another partner is not restored into this link', async ({ page }) => {
    await mountSignup(page);
    await page.locator('#signup-name').fill('Sunset Ridge Apartments');
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('lotlogic_signup_draft')))
      .toContain('Sunset Ridge');
    await page.reload();
    await mountSignup(page, { slug: 'frank' });
    await expect(page.locator('#signup-name')).toHaveValue('');
  });

  test('Try again after a failed context load really retries', async ({ page }) => {
    await mountSignup(page, {
      context: (route, n) => (n === 1
        ? route.abort('failed')
        : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CONTEXT) })),
    });
    await expect(page.getByText("Can't reach LotLogic right now — your answers are saved. Try again.")).toBeVisible();
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByText('N Style Towing uses LotLogic for parking requests. About a minute.')).toBeVisible();
    await expect(page.locator('#signup-name')).toBeVisible();
  });

  test('a throttled context load gets the 429 copy, not the dead-link copy', async ({ page }) => {
    await mountSignup(page, {
      context: (route, n) => (n === 1
        ? route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ detail: 'rate_limited', retry_after: 60 }) })
        : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CONTEXT) })),
    });
    await expect(page.getByText('Too many tries from this network. Wait a few minutes.')).toBeVisible();
    await expect(page.getByText("This link isn't valid. Ask your tow company for a new one.")).toHaveCount(0);
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.locator('#signup-name')).toBeVisible();
  });

  test('a field blurred while valid stays quiet when edited back into an error, until the next blur', async ({ page }) => {
    await mountSignup(page);
    const nameField = page.locator('#signup-name');
    await nameField.fill('Sunset Ridge Apartments');
    await nameField.blur();
    await nameField.fill('S');
    await expect(page.locator('.signup-error')).toHaveCount(0);
    await nameField.blur();
    await expect(page.getByText("Enter the property's name, as it appears on the sign.")).toBeVisible();
  });

  test('the role chips follow the radio-group keyboard pattern', async ({ page }) => {
    await mountSignup(page);
    const chips = page.getByRole('radio');
    await expect(chips).toHaveCount(6);
    // One tab stop: the first chip while none is checked.
    await expect(chips.nth(0)).toHaveAttribute('tabindex', '0');
    await expect(chips.nth(1)).toHaveAttribute('tabindex', '-1');
    await chips.nth(0).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('radio', { name: 'Assistant manager' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('radio', { name: 'Assistant manager' })).toBeFocused();
    await expect(page.getByRole('radio', { name: 'Assistant manager' })).toHaveAttribute('tabindex', '0');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    // Wraps from the first chip to the last.
    await expect(page.getByRole('radio', { name: 'Other' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('radio', { name: 'Other' })).toBeFocused();
  });

  test('verify-first: the code sheet posts the email (no session yet) and offers no Sign out or Change email', async ({ page }) => {
    await page.route('**/auth/signup', route => route.fulfill({
      status: 202, contentType: 'application/json', body: JSON.stringify({ ok: true, next: 'verify_email' }),
    }));
    let verifyBody: any = null;
    await page.route('**/auth/verify-email', route => {
      verifyBody = JSON.parse(route.request().postData() || '{}');
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ token: 'fake-token', expires_in: 3600, subject: { id: 'a1', type: 'owner' } }) });
    });
    await mountSignup(page);
    await fillValid(page);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.locator('.verify-code-input')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Change email' })).toHaveCount(0);
    await page.locator('.verify-code-input').fill('482190');
    await expect(page.locator('#signup-done')).toBeVisible();
    expect(verifyBody).toEqual({ code: '482190', email: 'dana@sunsetridge.com' });
  });

  test('422 renders the field messages and a summary that takes focus', async ({ page }) => {
    await page.route('**/auth/signup', route => route.fulfill({
      status: 422, contentType: 'application/json',
      body: JSON.stringify({ detail: [
        { loc: ['body', 'account', 'password'], msg: 'That password showed up in a data breach. Choose a different one.' },
      ] }),
    }));
    await mountSignup(page);
    await fillValid(page);
    await page.getByRole('button', { name: 'Create account' }).click();
    const summary = page.locator('[role=alert]').filter({ hasText: "There's a problem" });
    await expect(summary).toBeVisible();
    await expect(summary).toContainText('That password showed up in a data breach.');
    // `document.activeElement`, not `toBeFocused()`: WebKit reports a page
    // whose window is in the background (parallel workers) as "inactive" and
    // fails `toBeFocused` even when focus did move.
    await expect.poll(() => summary.evaluate(el => el === document.activeElement)).toBe(true);
    await expect(page.locator('#signup-password-error'))
      .toHaveText('That password showed up in a data breach. Choose a different one.');
  });

  test('429 and a network failure each get their own copy', async ({ page }) => {
    await page.route('**/auth/signup', route => route.fulfill({
      status: 429, contentType: 'application/json', body: JSON.stringify({ detail: 'rate_limited', retry_after: 300 }),
    }));
    await mountSignup(page);
    await fillValid(page);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByText('Too many tries from this network. Wait a few minutes.')).toBeVisible();

    await page.unroute('**/auth/signup');
    await page.route('**/auth/signup', route => route.abort('failed'));
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByText("Can't reach LotLogic right now — your answers are saved. Try again."))
      .toBeVisible();
  });

  test('an existing email gets the match card, not the button', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route('**/auth/signup', route => route.fulfill({
      status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true, next: 'check_email' }),
    }));
    await mountSignup(page);
    await fillValid(page);
    await page.getByRole('button', { name: 'Create account' }).click();
    // Spec §5.1: the card replaces the BUTTON, not the page — the answers
    // (and the draft) stay put for the add-property form after the sign-in.
    await expect(page.getByText('You already have an account.')).toBeVisible();
    await expect(page.getByText("Sign in and we'll add Sunset Ridge Apartments to it.")).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create account' })).toHaveCount(0);
    await expect(page.locator('#signup-name')).toHaveValue('Sunset Ridge Apartments');
    await expect(page.locator('.signup-btn-link'))
      .toHaveAttribute('href', '/app?return_to=%2Fjoin%2Fnstyle');
    await expect(page.getByRole('button', { name: 'Forgot your password? Email me a reset link' })).toBeVisible();
    // Draft kept, so the add-property form can prefill after the sign-in.
    expect(await page.evaluate(() => sessionStorage.getItem('lotlogic_signup_draft'))).toBeTruthy();
    await page.screenshot({ path: '/tmp/join-existing-account-390.png', fullPage: true });
  });

  test('the duplicate card offers "That\'s mine" and switches the form to a join', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 1200 });
    await page.route('**/auth/signup/match**', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ candidates: [
        { id: 'p-9', name: 'Sunset Ridge Apartments', street_line: '123 Main St', manager_first_name: 'Dana' },
      ] }),
    }));
    let body: any = null;
    await page.route('**/auth/signup', route => {
      body = JSON.parse(route.request().postData() || '{}');
      return route.fulfill({
        status: 201, contentType: 'application/json',
        body: JSON.stringify({ token: 'fake-token', next: 'pending_membership', property_name: 'Sunset Ridge Apartments', subject: { id: 'a1', type: 'owner' } }),
      });
    });
    await mountSignup(page);
    await fillValid(page);
    // The ZIP blur above already fired the match call.
    await expect(page.getByText('Is this your property?')).toBeVisible();
    await expect(page.locator('.signup-match-line')).toContainText('managed on LotLogic by Dana');
    await page.screenshot({ path: '/tmp/join-duplicate-card-390.png', fullPage: true });
    await page.getByRole('button', { name: "That's mine — ask to join" }).click();
    await expect(page.locator('.signup-readonly-name')).toHaveText('Sunset Ridge Apartments');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.locator('#signup-done')).toBeVisible();
    expect(body.property).toEqual({ id: 'p-9' });
  });

  test('add-property mode shows the property section only, with the Add property button', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mountSignup(page, { mode: 'add-property' });
    await expect(page.getByRole('heading', { name: 'Add a property to your account' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add property' })).toBeVisible();
    // No account fields at all.
    await expect(page.locator('#signup-contact')).toHaveCount(0);
    await expect(page.locator('#signup-email')).toHaveCount(0);
    await expect(page.locator('#signup-password')).toHaveCount(0);
    await scan(page, 'join-add-property');
  });

  test('the submit button is 56 px and never disabled', async ({ page }) => {
    await mountSignup(page);
    const btn = page.getByRole('button', { name: 'Create account' });
    await expect(btn).toBeEnabled();
    const box = await btn.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(56);
  });

  test('the role chips are 2 columns below 400 px and 3 at 400 px', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mountSignup(page);
    const cols = () => page.evaluate(() =>
      getComputedStyle(document.querySelector('.signup-chip-grid')!)
        .gridTemplateColumns.split(' ').length);
    expect(await cols()).toBe(2);
    await page.setViewportSize({ width: 430, height: 844 });
    expect(await cols()).toBe(3);
  });

  test('a selected chip carries the ✓ glyph as well as the accent fill', async ({ page }) => {
    await mountSignup(page);
    const chip = page.getByRole('radio', { name: 'Property manager' });
    await chip.click();
    await expect(chip).toHaveAttribute('aria-checked', 'true');
    await expect(chip).toContainText('✓');
    const bg = await chip.evaluate(el => getComputedStyle(el).backgroundColor);
    expect(bg).toBe('rgb(251, 191, 36)');
  });
});

// ── The You're-in card (spec §3.4 step 5) ─────────────────────
test.describe("FirstRunCard @a11y", () => {
  async function mountCard(page: Page, verified = false) {
    await page.goto(`${server.origin}/dashboard.html?e2e=1`);
    await page.waitForFunction(() => typeof (window as any).__lotlogicTestHooks?.FirstRunCard === 'function',
      undefined, { timeout: 30_000 });
    await page.evaluate((verified) => {
      const hooks = (window as any).__lotlogicTestHooks;
      const host = document.createElement('div');
      host.id = 'signup-harness';
      document.body.innerHTML = '';
      document.body.appendChild(host);
      hooks.ReactDOM.createRoot(host).render(
        hooks.React.createElement(hooks.ToastProvider, null,
          hooks.React.createElement(hooks.FirstRunCard, {
            property: { id: 'p1', name: 'Sunset Ridge Apartments' },
            partnerName: 'N Style',
            user: {
              email: 'dana@sunsetridge.com',
              signup_source: 'self_serve',
              email_verified: verified,
              email_verify_sent_at: null,
            },
            onDismiss: () => {},
          })),
      );
    }, verified);
    await expect(page.locator('.firstrun-card')).toBeVisible();
  }

  test('the card renders the spec copy and both buttons', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mountCard(page);
    await expect(page.locator('.firstrun-head')).toHaveText(
      "You're in. Sunset Ridge Apartments is live. N Style will confirm it's one of their properties — usually the same day — and your requests reach them from now on.",
    );
    await expect(page.getByRole('button', { name: 'Put a plate on hold' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add a teammate' })).toBeVisible();
    await expect(page.locator('.firstrun-code')).toContainText('We sent a 6-digit code to dana@sunsetridge.com');
    await scan(page, 'firstrun');
    await page.screenshot({ path: '/tmp/join-firstrun-390.png', fullPage: true });
  });

  test('Enter code opens VerifyEmailSheet', async ({ page }) => {
    await mountCard(page);
    await page.getByRole('button', { name: 'Enter code' }).click();
    await expect(page.locator('.verify-sheet')).toBeVisible();
  });

  test('a verified account gets no code line', async ({ page }) => {
    await mountCard(page, true);
    await expect(page.locator('.firstrun-code')).toHaveCount(0);
  });
});

// The §3.4a (c) round trip through the real App: signup → "You already have
// an account" → Sign in → back on /join/<slug> as the add-property form,
// prefilled from the draft. The static test server has no `/app` rewrite, so
// `/app…` is answered with dashboard.html exactly as vercel.json does.
test.describe('return_to round trip', () => {
  test('signing in from the existing-account card lands on the prefilled add-property form', async ({ page }) => {
    await page.route(/\/app(\?.*)?$/, async route => {
      const res = await route.fetch({ url: `${server.origin}/dashboard.html` });
      await route.fulfill({ response: res });
    });
    await page.route('**/auth/signup', route => route.fulfill({
      status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true, next: 'check_email' }),
    }));
    await page.route('**/auth/login', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ token: 'fake-token-test-only', expires_in: 3600,
        subject: { id: 'o-1', email: 'dana@sunsetridge.com', type: 'owner', display_name: 'Dana' } }),
    }));
    await page.route('**/auth/me', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ email: 'dana@sunsetridge.com', email_verified: true, properties: [] }),
    }));

    await mountSignup(page);
    await fillValid(page);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByText('You already have an account.')).toBeVisible();
    await page.locator('.signup-btn-link').click();
    await page.waitForURL(/\/app\?return_to=%2Fjoin%2Fnstyle$/);

    await page.locator('input[type=email]').fill('dana@sunsetridge.com');
    await page.locator('input[type=password]').fill('a short sentence works');
    await page.locator('form[aria-label="Sign in"] button[type=submit]').click();

    await expect(page.getByRole('heading', { name: 'Add a property to your account' })).toBeVisible();
    await expect(page.locator('input[placeholder="Sunset Ridge Apartments"]')).toHaveValue('Sunset Ridge Apartments');
    await expect(page.locator('input[placeholder="ZIP"]')).toHaveValue('28205');
    // Address bar moved to the /join link, return_to gone.
    expect(new URL(page.url()).pathname).toBe('/join/nstyle');
    expect(new URL(page.url()).search).toBe('');
  });

  test('a return_to that is not a /join link is dropped and stripped', async ({ page }) => {
    await page.route(/\/app(\?.*)?$/, async route => {
      const res = await route.fetch({ url: `${server.origin}/dashboard.html` });
      await route.fulfill({ response: res });
    });
    await page.route('**/auth/login', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ token: 'fake-token-test-only', expires_in: 3600,
        subject: { id: 'o-1', email: 'dana@sunsetridge.com', type: 'owner' } }),
    }));
    await page.route('**/auth/me', route => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ properties: [] }),
    }));
    await page.goto(`${server.origin}/app?return_to=${encodeURIComponent('https://evil.example/join/x')}`);
    await page.locator('input[type=email]').fill('dana@sunsetridge.com');
    await page.locator('input[type=password]').fill('a short sentence works');
    await page.locator('form[aria-label="Sign in"] button[type=submit]').click();
    await expect.poll(() => new URL(page.url()).search).toBe('');
    expect(new URL(page.url()).pathname).toBe('/app');
    await expect(page.getByRole('heading', { name: 'Add a property to your account' })).toHaveCount(0);
  });
});
