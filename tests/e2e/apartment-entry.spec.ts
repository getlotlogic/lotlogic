/**
 * One entry for apartment registration (Fort Mill resident rules, Task F2):
 * an apartment has a single public address, /apt/<slug>, and the older
 * /perm/<slug> and /temp/<slug> links end up there. An apartment manager's
 * printed QR signs and copied links used to point at those two pages, which
 * collect no unit, ID or lease; the flow that does is /apt/.
 *
 * What it pins down, in a real browser against the branch's build and the
 * local harness database (the page's own `properties` read goes through the
 * PostgREST stand-in, as the anon role under the database's own grants):
 *   - /perm/<slug> ends on /apt/<slug>?role=resident with the long-term form
 *     open and the landing choice skipped;
 *   - /temp/<slug> ends on /apt/<slug>?role=guest with the short-term form open;
 *   - the bare /apt/<slug>, and one with a role it does not know, still show
 *     the landing, and the back link on a form opened by ?role= returns to it.
 *
 * Portal suite (tests/README.md, "Portal suite"): local backend and a
 * throwaway Postgres only. Without PORTAL_E2E=1 every test here is reported as
 * skipped, never failed.
 */
import crypto from 'node:crypto';
import type { Page } from '@playwright/test';
import {
  test, expect, skipUnlessPortal, frontendOrigin, pointAtLocalBackend, apiSignup, sqlValue, lit,
} from '../fixtures/portal';

/**
 * A fresh apartment property with a public slug. A portal signup has no
 * printed signs, so it has no `qr_code_id`; the registration pages look a
 * property up by it, so the fixture gives this one a slug. The one write a
 * browser cannot make, done as the harness database's own role, like the rest
 * of fixtures/portal.ts.
 */
async function seedApartment() {
  const account = await apiSignup();
  const slug = `apt-entry-${crypto.randomBytes(4).toString('hex')}`;
  const type = sqlValue(`UPDATE public.properties SET qr_code_id = ${lit(slug)}
                          WHERE id = ${lit(account.property_id)} RETURNING property_type`);
  // Fail here, loudly, if a signup stops producing an apartment, rather than
  // pass vacuously on a page that never redirects.
  expect(type, 'a portal signup is an apartment property').toBe('apartment');
  return { slug, name: account.signup.name };
}

/** The public page, pointed at the harness: Supabase reads answered from the
 *  harness database, reCAPTCHA / Maps / Sentry aborted, fonts skipped. */
async function openPublicSite(page: Page) {
  await pointAtLocalBackend(page);
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
}

test.describe('apartment entry @portal', () => {
  test.beforeEach(() => {
    skipUnlessPortal();
  });

  test('an old /perm/<slug> sign ends on the long-term form at /apt/<slug>?role=resident', async ({ page }) => {
    const apartment = await seedApartment();
    await openPublicSite(page);

    await page.goto(`${frontendOrigin()}/perm/${apartment.slug}`);

    await expect(page).toHaveURL(`${frontendOrigin()}/apt/${apartment.slug}?role=resident`);
    await expect(page.locator('#residentForm')).toBeVisible();
    await expect(page.locator('.property-name')).toContainText(apartment.name);
    // ?role= skips the landing choice.
    await expect(page.locator('#chooseResident')).toHaveCount(0);
  });

  test('an old /temp/<slug> sign ends on the short-term form at /apt/<slug>?role=guest', async ({ page }) => {
    const apartment = await seedApartment();
    await openPublicSite(page);

    await page.goto(`${frontendOrigin()}/temp/${apartment.slug}`);

    await expect(page).toHaveURL(`${frontendOrigin()}/apt/${apartment.slug}?role=guest`);
    await expect(page.locator('#guestForm')).toBeVisible();
    await expect(page.locator('.property-name')).toContainText(apartment.name);
    await expect(page.locator('#chooseGuest')).toHaveCount(0);
  });

  test('the bare /apt/<slug> keeps its landing, and the back link on a ?role= form returns to it', async ({ page }) => {
    const apartment = await seedApartment();
    await openPublicSite(page);
    const entry = `${frontendOrigin()}/apt/${apartment.slug}`;

    await page.goto(entry);
    await expect(page.locator('#chooseResident')).toBeVisible();
    await expect(page.locator('#chooseGuest')).toBeVisible();

    // A role this page does not know is the landing too.
    await page.goto(`${entry}?role=nope`);
    await expect(page.locator('#chooseResident')).toBeVisible();

    await page.goto(`${entry}?role=guest`);
    await expect(page.locator('#guestForm')).toBeVisible();
    await page.locator('#backLink').click();
    await expect(page.locator('#chooseResident')).toBeVisible();
    await expect(page.locator('#chooseGuest')).toBeVisible();
  });
});
