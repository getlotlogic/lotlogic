/**
 * Wave 2.6 follow-up: the login page used to render OUTSIDE the `.app
 * theme-light` root App.jsx wraps everything else in (`if (!owner) return
 * <LoginPage .../>` short-circuited before the themed `<div className="app
 * theme-light">` wrapper), so `.theme-light .login-page` and friends never
 * matched and the login page ignored the operator's theme — it always
 * rendered with the dark, unthemed default. See progress.md Task 15.
 *
 * This spec is self-contained (build-and-serve THIS branch's frontend, like
 * hq.spec.ts) rather than pointing at playwright.config.ts's default
 * baseURL (the live production site), and asserts on computed style rather
 * than a screenshot so it stays meaningful without regenerating a baseline
 * image every time an unrelated color token changes.
 */
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { buildAndServeFrontend } from '../fixtures/buildAndServeFrontend';

const FRONTEND_DIR = path.resolve(__dirname, '../../frontend');
let server: Awaited<ReturnType<typeof buildAndServeFrontend>>;
test.beforeAll(async () => { server = await buildAndServeFrontend(FRONTEND_DIR); });
test.afterAll(async () => { await server.close(); });

test('login page renders inside the theme-light root and picks up the light background', async ({ page }) => {
  // No lotlogic_session in localStorage -> App.jsx's `if (!owner)` branch,
  // the exact path that used to skip the theme wrapper.
  await page.goto(`${server.origin}/dashboard.html`);

  const loginPage = page.locator('.login-page');
  await expect(loginPage).toBeVisible();

  // The themed root must be an ancestor of .login-page, not a sibling —
  // this is the actual regression: before the fix, .app.theme-light and
  // .login-page were siblings under #root.
  const themeRootWrapsLogin = await page.evaluate(() => {
    const el = document.querySelector('.login-page');
    return !!el?.closest('.app.theme-light');
  });
  expect(themeRootWrapsLogin).toBe(true);

  // frontend/dashboard.html's `.theme-light .login-page` rule sets the
  // background to `#f8f9fb` (solid, under the amber radial highlight) —
  // the un-themed default rule instead resolves `var(--bg-primary)` to the
  // dark root token (#0E0F11). Asserting the resolved color, not just the
  // ancestor class, catches the CSS rule itself drifting from the token.
  const bg = await loginPage.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toBe('rgb(248, 249, 251)');
});
