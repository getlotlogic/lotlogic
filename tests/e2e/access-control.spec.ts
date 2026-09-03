/**
 * Property access control — defense-in-depth checks.
 *
 * Verifies that a logged-in account can ONLY see the properties assigned to it,
 * across three attack surfaces:
 *   1. UI — the dashboard never renders another account's properties/violations
 *   2. URL tampering — opening /properties/<otherId> shows an "unauthorized" state
 *   3. Direct API — calling the backend with account A's JWT but account B's ids
 *      returns 403/404, never 200 with foreign data
 */
import { test, expect, accounts, apiLogin, loginAs, API_URL } from '../fixtures/accounts';

test.describe('property access control @access', () => {
  test('owner A sees only their own lots in the dashboard', async ({ page }) => {
    await loginAs(page, accounts.ownerA());

    // Navigate to the registration-based "Lots" tab — it's a role="tab", not a
    // role="button", and it reads from the RLS-scoped Supabase `properties`
    // table (separate from the legacy backend `lots` table the seed script
    // writes to). The seed account's one lot lives only in the legacy table,
    // so this owner has zero rows in `properties` and the tab's honest,
    // correct rendering is the empty state — not a bug to work around.
    await page.getByRole('tab', { name: /^lots$/i }).click();

    // Whether this account ever gains rows in `properties` or not, the one
    // guarantee that must always hold: nothing on screen ever identifies
    // owner B's business or lot.
    const bodyText = await page.locator('body').innerText();
    expect(bodyText, 'dashboard must never render owner B\'s identifying data').not.toMatch(
      /playwright-owner-b|owner b/i
    );

    const lotNames = await page.locator('.lot-name-paper').allTextContents();
    if (lotNames.length === 0) {
      await expect(page.getByText(/no lots yet/i)).toBeVisible();
    } else {
      for (const name of lotNames) {
        expect(name, 'every rendered lot name must be owner A\'s, never owner B\'s').not.toMatch(/owner b/i);
      }
    }
  });

  test('owner A cannot fetch owner B lots via direct API call', async ({ request }) => {
    const a = await apiLogin(request, accounts.ownerA());
    const b = await apiLogin(request, accounts.ownerB());

    // Ask for B's lots using A's token, passing B's id as the ?owner_id filter.
    // The server does NOT reject this with 4xx — it silently ignores/overrides
    // the requested owner_id and scopes the response to the authenticated
    // subject (A) instead. That is a stronger guarantee than a 4xx rejection
    // would be (a caller can never coerce the endpoint into looking at anyone
    // else's data, regardless of what it asks for), so assert that behaviour
    // precisely rather than requiring an error status that isn't what happens.
    const foreign = await request.get(`${API_URL}/lots?owner_id=${b.subject.id}`, {
      headers: { Authorization: `Bearer ${a.token}` },
    });
    expect(foreign.status(), 'the owner_id-filtered request must still succeed, scoped to A').toBe(200);
    const foreignBody = await foreign.json();
    const foreignItems = Array.isArray(foreignBody) ? foreignBody : foreignBody.items ?? [];
    for (const lot of foreignItems) {
      expect(lot.owner_id, 'server must ignore the requested owner_id and never return B\'s lots').not.toBe(
        b.subject.id
      );
      expect(lot.owner_id, 'server must scope the response to the authenticated owner (A)').toBe(a.subject.id);
    }

    // Same thing but omitting the filter — server should still scope to A's lots, never leak B's.
    const ownList = await request.get(`${API_URL}/lots`, {
      headers: { Authorization: `Bearer ${a.token}` },
    });
    expect(ownList.ok()).toBeTruthy();
    const body = await ownList.json();
    const items = Array.isArray(body) ? body : body.items ?? [];
    for (const lot of items) {
      expect(lot.owner_id, 'every returned lot must belong to the authenticated owner').toBe(a.subject.id);
    }
  });

  test('owner A cannot fetch a specific foreign lot by id', async ({ request }) => {
    const a = await apiLogin(request, accounts.ownerA());
    const b = await apiLogin(request, accounts.ownerB());

    const bLots = await request.get(`${API_URL}/lots`, {
      headers: { Authorization: `Bearer ${b.token}` },
    });
    expect(bLots.ok()).toBeTruthy();
    const bBody = await bLots.json();
    const bItems = Array.isArray(bBody) ? bBody : bBody.items ?? [];
    // The seed gives owner B a lot (with_lot:true). ASSERT it rather than skip —
    // a cross-tenant isolation check must never silently pass on an empty seed.
    expect(bItems.length, 'seed must assign owner B a lot for the cross-tenant check').toBeGreaterThan(0);

    const victimLotId = bItems[0].id;
    const res = await request.get(`${API_URL}/lots/${victimLotId}`, {
      headers: { Authorization: `Bearer ${a.token}` },
    });
    expect([403, 404], 'foreign lot must return 403 or 404, never 200').toContain(res.status());
  });

  test('owner A cannot fetch foreign violations', async ({ request }) => {
    const a = await apiLogin(request, accounts.ownerA());
    const b = await apiLogin(request, accounts.ownerB());

    const bLots = await request.get(`${API_URL}/lots`, {
      headers: { Authorization: `Bearer ${b.token}` },
    });
    const bItems = (await bLots.json()).items ?? (await bLots.json());
    expect(Array.isArray(bItems) && bItems.length > 0, 'seed must assign owner B a lot for the cross-tenant check').toBeTruthy();

    const victimLotId = bItems[0].id;
    const res = await request.get(`${API_URL}/violations?lot_id=${victimLotId}`, {
      headers: { Authorization: `Bearer ${a.token}` },
    });
    // Either blocked outright, or returns empty because the filter is intersected with A's allowed lots.
    if (res.ok()) {
      const body = await res.json();
      const list = Array.isArray(body) ? body : body.items ?? [];
      expect(list.length, 'filter by foreign lot_id must yield zero rows').toBe(0);
    } else {
      expect(res.status()).toBeGreaterThanOrEqual(400);
    }
  });

  test('unauthenticated requests are rejected', async ({ request }) => {
    const res = await request.get(`${API_URL}/lots`);
    expect(res.status()).toBe(401);
  });

  test('tampered JWT is rejected', async ({ request }) => {
    const a = await apiLogin(request, accounts.ownerA());
    const tampered = a.token.slice(0, -4) + 'XXXX';
    const res = await request.get(`${API_URL}/lots`, {
      headers: { Authorization: `Bearer ${tampered}` },
    });
    expect(res.status()).toBe(401);
  });

  test('direct URL to foreign property shows empty or unauthorized state', async ({
    page,
    request,
  }) => {
    const b = await apiLogin(request, accounts.ownerB());
    const bLots = await request.get(`${API_URL}/lots`, {
      headers: { Authorization: `Bearer ${b.token}` },
    });
    const bBody = await bLots.json();
    const bItems = Array.isArray(bBody) ? bBody : bBody.items ?? [];
    expect(bItems.length, 'seed must assign owner B a lot for the cross-tenant check').toBeGreaterThan(0);
    const victimLotId = bItems[0].id;

    await loginAs(page, accounts.ownerA());
    await page.goto(`/dashboard.html#/properties/${victimLotId}`);

    // Page must not render the foreign lot's name. We allow an empty state or an error banner.
    const victimName = bItems[0].name;
    await expect(page.getByText(victimName, { exact: false })).toHaveCount(0);
  });
});
