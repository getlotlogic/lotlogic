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
import {
  skipUnlessPortal, seedNStyle, apiSignup, apiVerify, apiCreateRequest, api, sql, lit,
  randomPlate, pointAtLocalBackend, frontendOrigin,
} from '../fixtures/portal';

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

/**
 * Portal cross-tenant checks (Task 30 Step 4; spec §8.3, §3.4a). Two
 * self-serve offices, A and B, each signed up from N Style's link against the
 * LOCAL backend — `@portal`, skipped unless PORTAL_E2E=1 (tests/README.md).
 * Misses are 404, never 403: a foreign property id must look exactly like a
 * nonexistent one.
 */
test.describe('portal access control @access @portal', () => {
  test.beforeEach(() => {
    skipUnlessPortal();
    seedNStyle();
  });

  test("office A cannot list office B's requests (404)", async () => {
    const a = await apiSignup();
    const b = await apiSignup();
    await apiVerify(b.token);
    await apiCreateRequest(b.token, { property_id: b.property_id, kind: 'hold', plate_text: randomPlate(), duration_hours: 24 });

    const mine = await api('GET', `/apartment/requests?property_id=${a.property_id}&view=active`, a.token);
    expect(mine.status, 'control: A can list its own property').toBe(200);
    for (const view of ['active', 'recent']) {
      const foreign = await api('GET', `/apartment/requests?property_id=${b.property_id}&view=${view}`, a.token);
      expect(foreign.status, `A → B's ${view} requests`).toBe(404);
      expect(JSON.stringify(foreign.body)).not.toContain(b.signup.name);
    }
  });

  test("office A cannot invite into office B's property (404)", async () => {
    const a = await apiSignup();
    const b = await apiSignup();
    await apiVerify(a.token);
    const body = { name: 'Pat Doe', email: `pw-invite-${Date.now()}@e2e.lotlogic.dev`, role: 'manager' };
    const foreign = await api('POST', `/properties/${b.property_id}/members/invite`, a.token, body);
    expect(foreign.status).toBe(404);
    expect(sql(`SELECT count(*) FROM public.lot_owners WHERE email = ${lit(body.email)}`)[0][0],
      'no account was created for the invitee').toBe('0');
    const own = await api('POST', `/properties/${a.property_id}/members/invite`, a.token, body);
    expect([200, 201], 'control: A can invite into its own property').toContain(own.status);
  });

  test('a self-serve session cannot write a verified property through PostgREST (42501)', async ({ page }) => {
    // The browser's Supabase client, holding A's session JWT, against the
    // harness DB under that JWT's own role and RLS (fixtures/postgrestShim.ts —
    // the local stand-in for the project's PostgREST). Migration 3 dropped
    // the owner write policies and the trust trigger guards
    // `verification_status`, so the insert must be refused by the database.
    const a = await apiSignup();
    await apiVerify(a.token);
    await pointAtLocalBackend(page);
    await page.goto(`${frontendOrigin()}/dashboard.html`);
    const owner = sql(`SELECT id FROM public.lot_owners WHERE email = ${lit(a.signup.email)}`)[0][0];
    const partner = seedNStyle().partnerId;
    const name = `Forged Verified ${Date.now()}`;
    const res = await page.evaluate(async ({ token, owner, partner, name }) => {
      const r = await fetch('https://nzdkoouoaedbbccraoti.supabase.co/rest/v1/properties', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({
          name, owner_id: owner, tow_company_id: partner, property_type: 'apartment',
          verification_status: 'verified',
        }),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    }, { token: a.token, owner, partner, name });
    expect([401, 403], JSON.stringify(res)).toContain(res.status);
    expect(res.body?.code).toBe('42501');
    expect(sql(`SELECT count(*) FROM public.properties WHERE name = ${lit(name)}`)[0][0]).toBe('0');
  });
});
