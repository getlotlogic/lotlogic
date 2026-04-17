/**
 * Golden-path smoke tests. These are the flows the product MUST NEVER break.
 * When a usability change lands, these catch regressions before users do.
 */
import { test, expect, accounts, loginAs } from '../fixtures/accounts';

test.describe('dashboard smoke @smoke', () => {
  test('login page renders key elements', async ({ page }) => {
    await page.goto('/dashboard.html');
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.getByLabel(/password/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /sign in|log in/i })).toBeVisible();
  });

  test('rejects bad password with a clear error', async ({ page }) => {
    await page.goto('/dashboard.html');
    await page.getByLabel(/email/i).fill(accounts.ownerA().email);
    await page.getByLabel(/password/i).fill('definitely-not-the-password');
    await page.getByRole('button', { name: /sign in|log in/i }).click();

    await expect(
      page.getByText(/incorrect|invalid|wrong|try again/i)
    ).toBeVisible({ timeout: 10_000 });
  });

  test('owner can log in and navigate core tabs', async ({ page }) => {
    await loginAs(page, accounts.ownerA());

    for (const tab of ['Jobs', 'Properties', 'Passes']) {
      const btn = page.getByRole('button', { name: new RegExp(tab, 'i') }).first();
      await btn.click();
      // No unhandled error text
      await expect(page.getByText(/something went wrong|unhandled error/i)).toHaveCount(0);
    }
  });

  test('logout clears session and returns to login', async ({ page }) => {
    await loginAs(page, accounts.ownerA());

    const logout = page.getByRole('button', { name: /log ?out|sign ?out/i }).first();
    await logout.click();

    await expect(page.getByLabel(/email/i)).toBeVisible();
    const stored = await page.evaluate(() => localStorage.getItem('lotlogic_session'));
    expect(stored).toBeNull();
  });

  test('dashboard survives offline then back online', async ({ page, context }) => {
    await loginAs(page, accounts.ownerA());
    await context.setOffline(true);

    // Try a refresh action if one exists.
    const refresh = page.getByRole('button', { name: /refresh/i }).first();
    if (await refresh.count()) await refresh.click();

    await context.setOffline(false);
    // Page should still be rendered, no crash.
    await expect(page.locator('body')).toBeVisible();
  });
});

test.describe('homepage marketing smoke @smoke', () => {
  test('landing page loads and has a primary CTA', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('body')).toBeVisible();
    const ctas = page.getByRole('link', { name: /get started|book|demo|contact/i });
    expect(await ctas.count()).toBeGreaterThan(0);
  });
});
