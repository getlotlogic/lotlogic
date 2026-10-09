/**
 * Public signup and the account loops around it (Task 30 Step 2; spec §3.2,
 * §3.3, §3.5, §3.6, §5.1, §5.9) against the LOCAL backend — the real
 * `/join/nstyle` route, the real `POST /auth/signup`, the real code checks.
 * `@portal`: skipped unless PORTAL_E2E=1 (tests/README.md "Portal suite").
 *
 * Database touches (fixture `sql`): reading the captured reset mail out of
 * `outbound_notices`, and moving a verification code's clock
 * (`email_verify_expires_at`, `email_verify_attempts`,
 * `email_verify_sent_at`) to reach the expired / exhausted / cooldown states
 * without waiting an hour.
 */
import {
  test, expect, skipUnlessPortal, frontendOrigin, pointAtLocalBackend, seedNStyle,
  newSignup, fillSignup, apiSignup, apiVerify, uiLogin, mailbox, sql, lit, resetThrottle, TEST_CODE,
} from '../fixtures/portal';
import type { Page } from '@playwright/test';

test.describe('public signup @portal', () => {
  test.beforeEach(async ({ page }) => {
    skipUnlessPortal();
    seedNStyle();
    await pointAtLocalBackend(page);
  });

  test('the Places autocomplete mounts when a Maps key is baked in', async ({ page }) => {
    test.skip(!process.env.VITE_GOOGLE_MAPS_KEY,
      'VITE_GOOGLE_MAPS_KEY is not set for this build — the form opens in manual entry (covered below)');
    await page.unroute(/maps\.googleapis\.com/);
    await page.goto(`${frontendOrigin()}/join/nstyle`);
    await expect(page.locator('gmp-place-autocomplete')).toBeAttached({ timeout: 20_000 });
    await expect(page.locator('.signup-manual')).toHaveCount(0);
  });

  test('manual entry: ZIP blur finds the seeded twin and offers to join it', async ({ page }) => {
    // The twin: an N Style property already on file at this exact street + ZIP.
    const twin = await apiSignup(newSignup({ address: `${Math.floor(Math.random() * 9000) + 1000} Twin Oaks Dr` }));
    await page.goto(`${frontendOrigin()}/join/nstyle`);
    await expect(page.locator('.signup-manual')).toBeVisible({ timeout: 20_000 });

    await page.locator('#signup-name').fill('Somebody Else Apartments');
    await page.locator('#signup-address').fill(twin.signup.address);
    await page.locator('input[placeholder="City"]').fill(twin.signup.city);
    await page.locator('.signup-state').fill(twin.signup.state);
    const zip = page.locator('input[placeholder="ZIP"]');
    await zip.fill(twin.signup.zip);
    await expect(page.getByText('Is this your property?')).toHaveCount(0);
    await zip.blur();

    const card = page.locator('.signup-match', { hasText: 'Is this your property?' });
    await expect(card).toBeVisible();
    await expect(card).toContainText(twin.signup.name);
    await expect(card).toContainText(`managed on LotLogic by ${twin.signup.contact.split(' ')[0]}`);
  });

  test('an existing email keeps the draft, and sign-in opens the add-property form prefilled', async ({ page }) => {
    const existing = await apiSignup();
    const draft = newSignup({ email: existing.signup.email, password: existing.signup.password });

    await page.goto(`${frontendOrigin()}/join/nstyle`);
    await expect(page.locator('#signup-name')).toBeVisible({ timeout: 20_000 });
    await fillSignup(page, draft);
    resetThrottle();
    await page.getByRole('button', { name: 'Create account' }).click();

    const card = page.locator('.signup-match', { hasText: 'You already have an account.' });
    await expect(card).toBeVisible();
    await expect(card).toContainText(`Sign in and we'll add ${draft.name} to it.`);
    // The answers stay on screen — the card replaces the button, not the page.
    await expect(page.locator('#signup-name')).toHaveValue(draft.name);
    await expect(page.locator('#signup-address')).toHaveValue(draft.address);

    await card.getByRole('link', { name: 'Sign in' }).click();
    await page.waitForURL(/\/app\?return_to=/);
    resetThrottle();
    await page.getByLabel(/email/i).fill(existing.signup.email);
    await page.getByLabel(/password/i).fill(existing.signup.password);
    await page.getByRole('button', { name: /sign in|log in/i }).click();

    await expect(page.getByText('Add a property to your account')).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/join\/nstyle$/);
    await expect(page.getByRole('button', { name: 'Add property' })).toBeVisible();
    // AddPropertyForm's inputs carry placeholders, not ids.
    await expect(page.getByPlaceholder('Sunset Ridge Apartments')).toHaveValue(draft.name);
    await expect(page.getByPlaceholder('Street address')).toHaveValue(draft.address);
    await expect(page.getByPlaceholder('ZIP')).toHaveValue(draft.zip);
  });

  test('password reset: request → mail on file → set → sign in with the new password', async ({ page }) => {
    const acct = await apiSignup();
    // An unconfirmed self-serve mailbox is sent its code instead of a link
    // (spec §3.5 "confirm first, then reset"); this test is the link path.
    await apiVerify(acct.token);
    const email = acct.signup.email;
    const newPassword = 'a brand new passphrase';

    await page.goto(`${frontendOrigin()}/app`);
    await page.getByLabel(/email/i).fill(email);
    resetThrottle();
    await page.getByRole('button', { name: 'Forgot password? Email me a setup link.' }).click();
    await expect(page.getByText("If an account exists for that email, we've sent a setup link.")).toBeVisible();

    // The captured mail — the local backend sends nothing, the row is the mailbox.
    let html = '';
    await expect.poll(() => {
      html = mailbox(email).find((m) => m.kind === 'password_reset')?.html ?? '';
      return html.length > 0;
    }, { message: 'a password_reset notice for the account' }).toBe(true);
    const token = /set-password\?token=([A-Za-z0-9._~%-]+)/.exec(html)?.[1];
    expect(token, 'the mail carries a set-password link').toBeTruthy();

    await page.goto(`${frontendOrigin()}/set-password?token=${token}`);
    await page.locator('#pw').fill(newPassword);
    await page.getByRole('button', { name: 'Set password' }).click();
    await expect(page.getByRole('heading', { name: 'You’re all set' })).toBeVisible();

    // The old password no longer works; the new one does.
    await uiLogin(page, frontendOrigin(), email, acct.signup.password);
    await expect(page.getByRole('alert')).toBeVisible();
    await uiLogin(page, frontendOrigin(), email, newPassword);
    await expect(page.getByRole('tab', { name: /^properties$/i }).first()).toBeVisible({ timeout: 15_000 });
  });
});

// ── VerifyEmailSheet states (spec §5.9) ─────────────────────────────────────
async function openSheet(page: Page, email: string, password: string) {
  await uiLogin(page, frontendOrigin(), email, password);
  const banner = page.getByRole('status').filter({ hasText: 'Confirm your email' }).first();
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await banner.getByRole('button', { name: 'Enter code' }).click();
  const sheet = page.getByRole('dialog', { name: 'Enter the 6-digit code' });
  await expect(sheet).toBeVisible();
  return sheet;
}

function setVerifyClock(email: string, set: string) {
  sql(`UPDATE public.lot_owners SET ${set} WHERE lower(email) = lower(${lit(email)})`);
}

test.describe('VerifyEmailSheet @portal', () => {
  test.beforeEach(async ({ page }) => {
    skipUnlessPortal();
    seedNStyle();
    await pointAtLocalBackend(page);
  });

  test('wrong code: says so, counts tries, then the right code confirms', async ({ page }) => {
    const acct = await apiSignup();
    const sheet = await openSheet(page, acct.signup.email, acct.signup.password);
    const code = sheet.getByRole('textbox', { name: '6-digit code' });
    await code.fill(TEST_CODE === '000000' ? '111111' : '000000');
    await expect(sheet).toContainText("That code didn't match. 4 tries left.");
    await expect(code).toHaveValue('');
    await code.fill(TEST_CODE);
    await expect(page.getByText('Email confirmed')).toBeVisible();
    await expect(sheet).toBeHidden();
  });

  test('expired code: says so and sends a new one', async ({ page }) => {
    const acct = await apiSignup();
    const sheet = await openSheet(page, acct.signup.email, acct.signup.password);
    setVerifyClock(acct.signup.email, `email_verify_expires_at = now() - interval '1 minute'`);
    await sheet.getByRole('textbox', { name: '6-digit code' }).fill(TEST_CODE);
    await expect(sheet).toContainText(`That code expired. We sent a new one to ${acct.signup.email}.`);
    // The fresh code (the debug test code again) works.
    await sheet.getByRole('textbox', { name: '6-digit code' }).fill(TEST_CODE);
    await expect(page.getByText('Email confirmed')).toBeVisible();
  });

  test('exhausted: the fifth miss says too many tries and mints a fresh code', async ({ page }) => {
    const acct = await apiSignup();
    const sheet = await openSheet(page, acct.signup.email, acct.signup.password);
    setVerifyClock(acct.signup.email, 'email_verify_attempts = 4');
    await sheet.getByRole('textbox', { name: '6-digit code' }).fill(TEST_CODE === '000000' ? '111111' : '000000');
    await expect(sheet).toContainText(`Too many tries — we sent a fresh code to ${acct.signup.email}.`);
    const attempts = sql(`SELECT email_verify_attempts FROM public.lot_owners WHERE lower(email) = lower(${lit(acct.signup.email)})`)[0][0];
    expect(Number(attempts), 'a fresh code starts a fresh count').toBe(0);
  });

  test('resend cooldown: the server’s 429 turns Resend back into a countdown', async ({ page }) => {
    const acct = await apiSignup();
    // The page loads believing the last code went out two minutes ago, so
    // Resend is live…
    setVerifyClock(acct.signup.email, `email_verify_sent_at = now() - interval '2 minutes'`);
    const sheet = await openSheet(page, acct.signup.email, acct.signup.password);
    const resend = sheet.getByRole('button', { name: /^Resend/ });
    await expect(resend).toBeEnabled();
    // …while the server has just sent one (another tab, say).
    setVerifyClock(acct.signup.email, 'email_verify_sent_at = now()');
    await resend.click();
    // The countdown is text, not a control: no Resend button until it ends.
    await expect(sheet.getByText(/^Resend in \d+ s$/)).toBeVisible();
    await expect(sheet.getByRole('button', { name: /^Resend/ })).toHaveCount(0);
  });
});
