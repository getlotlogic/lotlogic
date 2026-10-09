/**
 * The portal's acceptance path, end to end (Task 30 Step 1, spec §3.4, §3.5,
 * §3.8, §5.2, §5.5): a property manager signs up from N Style's link, places
 * a hold behind the 6-digit code, and N Style's partner login sees it in
 * Lookup — amber partner-wide until N Style confirms the property, green
 * after.
 *
 * Runs on the `mobile-safari` project only (the brief's device profile:
 * Playwright's iPhone 14, WebKit) and only with PORTAL_E2E=1 against the
 * LOCAL backend — tests/README.md "Portal suite". The wall-clock time from
 * the `/join` load to the hold placed is recorded as a test annotation
 * (`acceptance-path-ms`) and printed, target < 3 min.
 *
 * The one place this test touches the database directly: the local backend
 * has no SendGrid key, so `dispatch_now` leaves the partner email `failed`;
 * the test flips that delivery to `sent` (`markDeliveriesSent`) and lets the
 * section's 30 s poll pick it up (fast-forwarded with Playwright's clock).
 */
import {
  test, expect, skipUnlessPortal, frontendOrigin, pointAtLocalBackend, portalContext,
  seedNStyle, newSignup, fillSignup, resetThrottle, propertyOf, latestRequest, deliveries,
  markDeliveriesSent, uiLogin, isolatePlate, TEST_CODE, PARTNER_NAME,
} from '../fixtures/portal';
import type { Page } from '@playwright/test';

const PLATE = 'ABC1234';
const GO_RGB = 'rgb(63, 164, 91)'; // --verdict-go #3FA45B, both themes

async function verdictCard(page: Page) {
  const card = page.getByRole('status').filter({ hasText: /TOW|HOLD/ }).first();
  await expect(card).toBeVisible({ timeout: 5_000 });
  return card;
}

async function bg(page: Page, locator: ReturnType<Page['locator']>) {
  return locator.evaluate((el) => getComputedStyle(el).backgroundColor);
}

/** The computed colour of `var(--accent)` in the page's current theme. */
async function accentRgb(page: Page) {
  return page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.background = 'var(--accent)';
    (document.querySelector('.app') || document.body).appendChild(probe);
    const c = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return c;
  });
}

async function lookup(page: Page, scopeLabel: string | RegExp, plate: string) {
  await page.getByRole('tab', { name: /^lookup$/i }).click();
  const scope = page.locator('select').first();
  await expect(scope).toBeVisible();
  const label = typeof scopeLabel === 'string'
    ? scopeLabel
    : (await scope.locator('option').allInnerTexts()).find((t) => scopeLabel.test(t));
  expect(label, `scope option ${scopeLabel}`).toBeTruthy();
  await scope.selectOption({ label: label as string });
  const field = page.getByPlaceholder('ABC1234');
  await field.fill(plate);
  await page.getByRole('button', { name: /^check$/i }).click();
}

test.describe('portal acceptance path @portal', () => {
  test.beforeEach(({}, testInfo) => {
    skipUnlessPortal();
    test.skip(testInfo.project.name !== 'mobile-safari', 'acceptance path runs on the mobile-safari profile only');
  });

  test('signup → code → hold → N Style sees it amber, confirms, sees it green', async ({ page, browser }, testInfo) => {
    test.setTimeout(180_000);
    const nstyle = seedNStyle();
    // ABC1234 is the brief's plate, so an earlier run's hold on it must not
    // turn the All-scope verdict into a grouped one.
    isolatePlate(nstyle.partnerId, PLATE);
    const signup = newSignup();
    await pointAtLocalBackend(page);
    await page.clock.install();
    resetThrottle();

    // ── /join/nstyle → seven fields → Create account ─────────────────────
    const t0 = Date.now();
    await page.goto(`${frontendOrigin()}/join/nstyle`);
    await expect(page.locator('#signup-name')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.signup-partner-chip')).toContainText(`Requests go to ${PARTNER_NAME}`);
    await fillSignup(page, signup);
    await expect(page.getByRole('radio', { name: 'Property manager' })).toBeChecked();
    await page.getByRole('button', { name: 'Create account' }).click();

    // ── lands on /app: You're-in card + the Requests composer ────────────
    await page.waitForURL(/\/app(\?|$)/, { timeout: 20_000 });
    await expect(page.getByRole('region', { name: "You're in" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(`${signup.name} is live.`, { exact: false })).toBeVisible();
    const plate = page.getByRole('textbox', { name: 'Plate' });
    await expect(plate).toBeVisible();
    // Spec §3.4 step 5: the plate field is the first tap target in the
    // viewport — the layout, not autofocus, puts it there on iOS.
    await expect.poll(async () => {
      const box = await plate.boundingBox();
      const vh = page.viewportSize()!.height;
      return box ? box.y >= 0 && box.y + box.height <= vh : false;
    }, { message: 'plate field inside the viewport on landing', timeout: 5_000 }).toBe(true);

    const property = propertyOf(signup.email);
    expect(property.status, 'a self-serve property starts pending').toBe('pending');

    // ── first hold on the pending property → VerifyEmailSheet → 482190 ───
    await plate.fill(PLATE);
    await page.getByRole('button', { name: /^Put on hold until / }).click();
    const sheet = page.getByRole('dialog', { name: 'Enter the 6-digit code' });
    await expect(sheet).toBeVisible();
    await sheet.getByRole('textbox', { name: '6-digit code' }).fill(TEST_CODE); // auto-submits at 6 digits
    await expect(page.getByText('Email confirmed')).toBeVisible();
    await expect(sheet).toBeHidden();

    // ── the hold is placed: H- ref, "Sending…" ───────────────────────────
    const row = page.locator('.req-card', { hasText: PLATE }).filter({ hasText: /H-\d+/ }).first();
    await expect(row).toBeVisible({ timeout: 10_000 });
    const tHold = Date.now();
    const elapsed = tHold - t0;
    testInfo.annotations.push({ type: 'acceptance-path-ms', description: String(elapsed) });
    testInfo.annotations.push({ type: 'device-profile', description: `${testInfo.project.name} (${testInfo.project.use.userAgent?.match(/iPhone OS [\d_]+/)?.[0] ?? 'iPhone'}, ${page.viewportSize()!.width}x${page.viewportSize()!.height})` });
    // eslint-disable-next-line no-console
    console.log(`[acceptance] /join load → hold placed: ${(elapsed / 1000).toFixed(1)} s on ${testInfo.project.name}`);
    expect(elapsed, 'acceptance path under 3 minutes').toBeLessThan(180_000);

    const req = latestRequest(property.id);
    expect(req, 'the hold row exists').not.toBeNull();
    expect(req!.kind).toBe('hold');
    expect(req!.status).toBe('active');
    const ref = `H-${req!.ref}`;
    await expect(row).toContainText(ref);
    await expect(row).toContainText('Sending…');

    // ── the delivery: the local backend cannot send, so mark it sent ─────
    await expect.poll(() => deliveries(req!.id).length, { message: 'dispatch_now wrote a delivery row' }).toBeGreaterThan(0);
    markDeliveriesSent(req!.id);
    await page.clock.fastForward(30_000); // the section's 30 s poll
    await expect(row).toContainText(`Sent to ${PARTNER_NAME} ✓`, { timeout: 10_000 });

    // ── N Style, second context: Lookup on that property → green ─────────
    const partnerCtx = await portalContext(browser, { ...testInfo.project.use });
    const partner = await partnerCtx.newPage();
    await uiLogin(partner, frontendOrigin(), nstyle.email, nstyle.password);
    await expect(partner.getByRole('tab', { name: /^lookup$/i })).toBeVisible({ timeout: 15_000 });

    await lookup(partner, signup.name, PLATE);
    let card = await verdictCard(partner);
    await expect(card).toContainText('DO NOT TOW');
    await expect(card).toContainText(ref);
    expect(await bg(partner, card)).toBe(GO_RGB);

    // ── scope = All → amber, the property is not confirmed yet ───────────
    await lookup(partner, /^All .* properties$/, PLATE);
    card = await verdictCard(partner);
    await expect(card).toContainText('HOLD — PROPERTY NOT CONFIRMED');
    expect(await bg(partner, card)).toBe(await accentRgb(partner));
    expect(await bg(partner, card)).not.toBe(GO_RGB);

    // ── Requests tab → Confirm → back to Lookup All → green ──────────────
    await partner.getByRole('tab', { name: /^requests\b/i }).first().click();
    const confirmCard = partner.getByRole('region', { name: `Confirm ${signup.name}` });
    await expect(confirmCard).toBeVisible({ timeout: 10_000 });
    await confirmCard.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(partner.getByText(`Confirmed — ${signup.name} is yours.`)).toBeVisible();
    await expect(confirmCard).toBeHidden();
    expect(propertyOf(signup.email).status).toBe('verified');

    await lookup(partner, /^All .* properties$/, PLATE);
    card = await verdictCard(partner);
    await expect(card).toContainText('DO NOT TOW');
    await expect(card).toContainText(ref);
    expect(await bg(partner, card)).toBe(GO_RGB);

    await partnerCtx.close();
  });
});
