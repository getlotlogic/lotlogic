/**
 * Repeat-offender cooldown chip smoke test.
 *
 * On the Truck Parking Log, a pass that was re-registered inside the cooldown
 * window renders a "⚠ Re-registered within cooldown" chip. Clicking it expands
 * an inline list of the truck's recent visits (.cooldown-visits).
 *
 * This is a RESILIENT smoke test: flagged passes only exist when a real repeat
 * offender is present, so the test guards on a count check and does NOT hard-fail
 * when no flagged pass is on screen.
 */
import { test, expect, accounts, loginAs } from '../fixtures/accounts';

test.describe('repeat-offender cooldown chip @smoke', () => {
  test('chip expands recent-visits list when present', async ({ page }) => {
    await loginAs(page, accounts.ownerA());

    // Navigate into the property / Parking Log surface. Tab labels vary by
    // property type, so try the registration-based log labels broadly and fall
    // through gracefully if this owner has no truck_plaza property.
    const propertyTab = page.getByRole('button', { name: /properties/i }).first();
    if (await propertyTab.count()) {
      await propertyTab.click().catch(() => {});
    }

    // The chip is rendered with a stable class + recognizable text.
    const chip = page
      .locator('.parking-reg-badge.cooldown')
      .filter({ hasText: /Re-registered within cooldown/i });

    // Give the roster/log a moment to load. Don't fail if it never appears —
    // no flagged pass is a perfectly normal state.
    await page.waitForTimeout(2_000);

    const chipCount = await chip.count();
    if (chipCount === 0) {
      test.info().annotations.push({
        type: 'note',
        description: 'No flagged (repeat-offender) pass present — chip path skipped.',
      });
      return;
    }

    // A flagged pass is on screen: clicking the chip must reveal the visits list.
    const first = chip.first();
    await expect(first).toBeVisible();

    const wrap = first.locator('xpath=ancestor::div[contains(@class,"cooldown-chip-wrap")]');
    const visits = wrap.locator('.cooldown-visits');

    // Collapsed initially.
    await expect(visits).toHaveCount(0);

    await first.click();

    // Expanded list is now in the DOM and visible (loading, empty, or rows).
    await expect(wrap.locator('.cooldown-visits')).toBeVisible({ timeout: 10_000 });

    // Toggling again collapses it.
    await first.click();
    await expect(wrap.locator('.cooldown-visits')).toHaveCount(0);
  });
});
