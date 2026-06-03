/**
 * Parking Log smart search regression tests.
 *
 * Locks in the fixes from PRs #207, #208, #210, #211 so they can't quietly
 * regress. Each test corresponds to a specific bug class we just shipped a
 * fix for. If any of these fail, an operator is about to wrongly tow a
 * truck — treat as P0.
 *
 * Coverage:
 *   - Smart search box present + autofocused + labeled to catch all fields
 *   - No "Apply dates" button (PR #211 — date/status auto-apply)
 *   - No old separate Plate / Company filter inputs
 *   - Date input change triggers refetch without needing Apply
 *   - Empty-state copy points operators to broader search options
 *   - "🔭 Search the last 90 days" widening button present in empty state
 *   - Search input clears via the ✕ button
 *
 * These tests are *structural* — they don't depend on specific pass data
 * existing in the test account. Data-dependent assertions (e.g. "searching
 * 'Brannon' finds Daniel Brannon's pass") require seeded fixture passes,
 * which would couple the tests to whatever's in the dev DB on a given day.
 * Adding those is a separate PR if you want full end-to-end coverage.
 */
import { test, expect, accounts, loginAs } from '../fixtures/accounts';
import type { Page } from '@playwright/test';

// Helper: navigate to the first truck-plaza property's detail page and open
// the Parking Log tab. Returns the property-detail page handle if found,
// or skips the test if the account has no truck-plaza properties.
async function openParkingLog(page: Page): Promise<boolean> {
  await loginAs(page, accounts.ownerA());

  // Properties tab — naming varies (Properties / Lots), try both.
  const propsTab = page.getByRole('button', { name: /properties|lots/i }).first();
  if (await propsTab.count()) await propsTab.click();

  // First "Truck Plaza" badge → its enclosing card → click it.
  const truckPlazaBadge = page.getByText(/Truck Plaza/i).first();
  if (!(await truckPlazaBadge.count())) return false;
  // Walk up to a clickable ancestor and click.
  const clickable = truckPlazaBadge.locator('xpath=ancestor::button[1] | ancestor::a[1] | ancestor::div[@role="button"][1]').first();
  if (await clickable.count()) {
    await clickable.click();
  } else {
    await truckPlazaBadge.click();
  }

  // Pick the "Parking Log" chip in the section filter.
  const logChip = page.getByRole('button', { name: /^parking log$/i }).first();
  if (await logChip.count()) await logChip.click();

  return true;
}

test.describe('parking log smart search @smoke', () => {
  test('smart search box exists with multi-field placeholder', async ({ page }) => {
    const opened = await openParkingLog(page);
    test.skip(!opened, 'No truck plaza property available on this test account');

    // The big search box at the top of TruckParkingLog. Placeholder must
    // mention plate, driver, company, phone — that's the contract operators
    // rely on to know what they can search.
    const searchInput = page.locator(
      'input[placeholder*="plate" i][placeholder*="driver" i][placeholder*="company" i]'
    ).first();
    await expect(searchInput).toBeVisible({ timeout: 10_000 });

    // Autofocus: cursor should land here without operator tap.
    await expect(searchInput).toBeFocused();
  });

  test('no "Apply dates" button — date/status auto-apply', async ({ page }) => {
    const opened = await openParkingLog(page);
    test.skip(!opened, 'No truck plaza property available');

    // The Apply button was removed in PR #211. If anyone re-adds it,
    // the friction returns and operators get confused again.
    const applyBtn = page.getByRole('button', { name: /^apply( dates)?$/i });
    await expect(applyBtn).toHaveCount(0);
  });

  test('no separate "Plate" / "Company only" inputs (those are now in smart search)', async ({ page }) => {
    const opened = await openParkingLog(page);
    test.skip(!opened, 'No truck plaza property available');

    // Pre-#207 the form had two separate text inputs labeled "Plate" and
    // "Company". Both got folded into the smart search. Verify they're gone.
    await expect(page.locator('input[placeholder="ABC 1234"]')).toHaveCount(0);
    await expect(page.locator('input[placeholder="ACME"]')).toHaveCount(0);
  });

  test('typing in search filters live (no Apply / debounce > 1s)', async ({ page }) => {
    const opened = await openParkingLog(page);
    test.skip(!opened, 'No truck plaza property available');

    const searchInput = page.locator('input[placeholder*="plate" i]').first();
    await searchInput.fill('xyz-improbable-string-no-pass-matches-this');

    // Empty-state header should appear within a second — confirms live
    // filter, not pending-on-Apply.
    await expect(
      page.getByText(/no matches for/i)
    ).toBeVisible({ timeout: 1500 });
  });

  test('empty-state offers "Search the last 90 days" widening button', async ({ page }) => {
    const opened = await openParkingLog(page);
    test.skip(!opened, 'No truck plaza property available');

    const searchInput = page.locator('input[placeholder*="plate" i]').first();
    await searchInput.fill('xyz-improbable-string-no-pass-matches-this');

    // Auto-widen entry point — operators panicking about missing data
    // need a one-tap escape hatch.
    await expect(
      page.getByRole('button', { name: /search the last 90 days/i })
    ).toBeVisible({ timeout: 2000 });
  });

  test('search input clears via the ✕ button', async ({ page }) => {
    const opened = await openParkingLog(page);
    test.skip(!opened, 'No truck plaza property available');

    const searchInput = page.locator('input[placeholder*="plate" i]').first();
    await searchInput.fill('xyz');

    const clearBtn = page.getByRole('button', { name: /clear search/i });
    await expect(clearBtn).toBeVisible();
    await clearBtn.click();

    await expect(searchInput).toHaveValue('');
  });

  test('changing date filter triggers refetch immediately', async ({ page }) => {
    const opened = await openParkingLog(page);
    test.skip(!opened, 'No truck plaza property available');

    // Grab the "From" date input.
    const fromInput = page.locator('input[type="date"]').first();
    await expect(fromInput).toBeVisible();

    // Change to 30 days ago and verify no Apply step is required.
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);
    await fromInput.fill(thirtyDaysAgo);

    // Wait briefly — if auto-apply works, the date range caption in the
    // header updates to reflect the new range without any other action.
    await expect(
      page.getByText(new RegExp(thirtyDaysAgo))
    ).toBeVisible({ timeout: 3000 });
  });
});
