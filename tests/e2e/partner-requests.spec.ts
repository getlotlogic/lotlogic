/**
 * N Style's Requests tab against the LOCAL backend (Task 30 Step 3; spec
 * §3.8, §5.4). Runs on both projects. `@portal`: skipped unless PORTAL_E2E=1
 * (tests/README.md "Portal suite").
 *
 * Each test has its own office (API signup + the debug code) and a random
 * plate, and drives N Style — the seeded partner A — through the real tab.
 * Requests are created through the office API, not the composer: the
 * composer has its own spec (requests.spec.ts) and here it is only setup.
 */
import {
  test, expect, skipUnlessPortal, frontendOrigin, pointAtLocalBackend, portalContext,
  seedNStyle, apiSignup, apiVerify, apiCreateRequest, randomPlate, uiLogin, sql, lit, mailbox,
  api, apiToken,
  TOW_ATTESTATION, PARTNER_NAME,
} from '../fixtures/portal';
import type { Page } from '@playwright/test';

async function partnerOnRequests(page: Page) {
  const nstyle = seedNStyle();
  await uiLogin(page, frontendOrigin(), nstyle.email, nstyle.password);
  await page.getByRole('tab', { name: /^requests\b/i }).first().click();
  await expect(page.getByRole('tablist', { name: /filter requests/i })).toBeVisible({ timeout: 15_000 });
}

async function verifiedOffice() {
  const office = await apiSignup();
  await apiVerify(office.token);
  return office;
}

/** One `<li>` of the active list (PartnerRequestRow). */
function requestRow(page: Page, plate: string) {
  return page.getByRole('listitem').filter({ hasText: plate });
}

test.describe('partner Requests tab @portal', () => {
  test.beforeEach(async ({ page }) => {
    skipUnlessPortal();
    await pointAtLocalBackend(page);
  });

  test('Got it marks the request Seen', async ({ page }) => {
    const office = await verifiedOffice();
    const plate = randomPlate();
    const hold = await apiCreateRequest(office.token, {
      property_id: office.property_id, kind: 'hold', plate_text: plate, duration_hours: 24,
    });
    await partnerOnRequests(page);

    const gotIt = page.getByRole('button', { name: `Got it — ${plate}, ${hold.ref}` });
    await expect(gotIt).toBeVisible();
    await gotIt.click();
    await expect(page.getByText(new RegExp(`^Seen .+ — ${hold.ref}\\.$`))).toBeVisible();
    await expect(gotIt).toHaveCount(0);
    await expect(requestRow(page, plate)).toContainText(/Seen \d/);
    expect(sql(`SELECT partner_ack_at IS NOT NULL FROM public.tow_requests WHERE id = ${lit(hold.id)}`)[0][0]).toBe('t');
  });

  test('Decline needs a reason, and the office sees it', async ({ page }) => {
    const office = await verifiedOffice();
    const plate = randomPlate();
    const tow = await apiCreateRequest(office.token, {
      property_id: office.property_id, kind: 'tow', plate_text: plate,
      note: 'Blocking the dumpster', attestation_text: TOW_ATTESTATION,
    });
    await partnerOnRequests(page);

    await page.getByRole('button', { name: `Decline… — ${plate}, ${tow.ref}` }).click();
    const dialog = page.getByRole('dialog', { name: 'Decline this request' });
    await expect(dialog).toBeVisible();
    const confirm = dialog.getByRole('button', { name: 'Decline request' });
    await expect(confirm).toBeDisabled();
    const reason = dialog.getByPlaceholder("Tell the office why (they'll see this)");
    await reason.fill('   ');
    await expect(confirm, 'whitespace is not a reason').toBeDisabled();
    await reason.fill('Car has a valid permit on the dash');
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: `Decline… — ${plate}, ${tow.ref}` })).toHaveCount(0);

    const row = sql(`SELECT status, resolution_note FROM public.tow_requests WHERE id = ${lit(tow.id)}`)[0];
    expect(row).toEqual(['declined', 'Car has a valid permit on the dash']);
  });

  test('Not ours archives the property, ends its requests and mails the office', async ({ page }) => {
    const office = await verifiedOffice();
    const plate = randomPlate();
    const hold = await apiCreateRequest(office.token, {
      property_id: office.property_id, kind: 'hold', plate_text: plate, duration_hours: 24,
    });

    await partnerOnRequests(page);
    const card = page.getByRole('region', { name: `Confirm ${office.signup.name}` });
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Not ours' }).click();
    const dialog = page.getByRole('dialog', { name: 'Not your property' });
    await expect(dialog).toBeVisible();
    const confirm = dialog.getByRole('button', { name: 'Not ours' });
    await expect(confirm, 'a reason is required').toBeDisabled();
    await dialog.getByPlaceholder('Tell us why (required)').fill('Not one of our contracts');
    await confirm.click();
    await expect(card).toBeHidden();

    // §3.8: rejected + archived; the active hold flips to declined with the
    // `property_rejected` note (which the UI renders as "Property not
    // confirmed by N Style"); the members are mailed.
    const prop = sql(`SELECT verification_status, archived_at IS NOT NULL FROM public.properties WHERE id = ${lit(office.property_id)}`)[0];
    expect(prop).toEqual(['rejected', 't']);
    expect(sql(`SELECT status, resolution_note FROM public.tow_requests WHERE id = ${lit(hold.id)}`)[0])
      .toEqual(['declined', 'property_rejected']);
    await expect.poll(() => mailbox(office.signup.email).map((m) => m.subject))
      .toContain(`${PARTNER_NAME} didn't recognize ${office.signup.name}`);
  });

  // Spec §3.8: "its next login with no other property renders an
  // explanation, not an empty list".
  test("after Not ours, the office's next sign-in explains instead of an empty list", async ({ browser }, testInfo) => {
    const office = await verifiedOffice();
    const nstyle = seedNStyle();
    const nstyleToken = await apiToken(nstyle.email, nstyle.password);
    const r = await api('POST', `/partner/properties/${office.property_id}/reject`, nstyleToken, { reason: 'Not one of our contracts' });
    expect(r.status).toBe(200);

    const officeCtx = await portalContext(browser, { ...testInfo.project.use });
    const officePage = await officeCtx.newPage();
    await uiLogin(officePage, frontendOrigin(), office.signup.email, office.signup.password);
    await expect(officePage.getByRole('tab', { name: /^lots$|^properties$/i }).first()).toBeVisible({ timeout: 15_000 });
    await expect(officePage.getByText(`${PARTNER_NAME} didn't recognize ${office.signup.name}.`)).toBeVisible({ timeout: 5_000 });
    await expect(officePage.getByText("Reply to the email we sent if that's a mistake, or add a property.")).toBeVisible();
    await officeCtx.close();
  });
});
