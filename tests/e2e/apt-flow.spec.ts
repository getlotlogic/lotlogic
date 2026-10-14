/**
 * The long-term parking-pass request, end to end (Fort Mill resident rules,
 * Task F3): /apt/<slug>?role=resident from "Before you start" to the receipt.
 *
 * What it pins down, in a real browser against the branch's build, the local
 * backend and the harness database (fixtures/aptFlow.ts says what is stood in
 * for — only the R2 upload and Google's reCAPTCHA script):
 *   - the S1 gate and S2's empty Continue put focus on the error summary, and
 *     the page title says "Error:";
 *   - each document card reaches "Uploaded" the moment its file is chosen, a
 *     photo goes up re-encoded as JPEG, and every upload carries its own
 *     reCAPTCHA token;
 *   - "Check your answers" shows the plate;
 *   - "Send for review" lands on the receipt with the backend's reference, the
 *     row it names is the pending request in the database, and a reload shows
 *     the same receipt from localStorage.
 *
 * Portal suite (tests/README.md, "Portal suite"): local backend and a
 * throwaway Postgres only. Without PORTAL_E2E=1 every test here is reported as
 * skipped, never failed.
 */
import { test, expect, skipUnlessPortal, frontendOrigin, sql, lit } from '../fixtures/portal';
import {
  seedResidentApartment, openResidentFlow, toFirstVehicle, vehicleAndDocumentsToReview, RESIDENT,
} from '../fixtures/aptFlow';

test.describe('apartment long-term request @portal', () => {
  test.beforeEach(() => {
    skipUnlessPortal();
  });

  test('S1 to S6: errors take focus, cards upload, the receipt carries the reference and survives a reload', async ({ page }) => {
    const apartment = await seedResidentApartment();
    const uploads = await openResidentFlow(page, apartment);

    await page.goto(`${frontendOrigin()}/apt/${apartment.slug}?role=resident`);
    await expect(page.getByRole('heading', { name: 'Before you start' })).toBeVisible();
    await expect(page.locator('.property-name')).toContainText(apartment.name);

    // S1: Start with no answer → the error summary, focused; answering clears it.
    await page.getByRole('button', { name: 'Start' }).click();
    const summary = page.locator('#errorSummary');
    await expect(summary).toBeFocused();
    await expect(summary).toContainText('Select whether your name is on the lease');
    await page.getByLabel("Yes, I'm on the lease").check();
    await expect(summary).toBeHidden();
    await page.getByRole('button', { name: 'Start' }).click();

    // S2: Continue with every field empty → four errors, summary focused, title flagged.
    await expect(page.getByRole('heading', { name: 'About you' })).toBeVisible();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(summary).toBeFocused();
    await expect(summary.locator('li')).toHaveText([
      'Enter your full name',
      'Enter your unit number',
      'Enter a phone number, like (704) 555-0123',
      'Enter your email address',
    ]);
    await expect(page).toHaveTitle(/^Error: About you/);
    // Back to S1 and forward again, through the real flow from the start.
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Before you start' })).toBeVisible();
    await expect(page.getByLabel("Yes, I'm on the lease")).toBeChecked();
    await toFirstVehicle(page);

    // S3 → S5: the documents upload on select; S5 shows the plate.
    const plate = await vehicleAndDocumentsToReview(page, apartment);
    await expect(page.locator('#review-vehicle-v1')).toContainText(plate);
    await expect(page.locator('#review-unit')).toContainText(RESIDENT.unit);
    await expect(page.locator('#review-phone')).toContainText('(704) 555-0123');

    const kinds = uploads.map((u) => u.kind);
    expect(kinds).toEqual(apartment.hasRules ? ['plate', 'registration', 'id', 'lease'] : ['plate', 'id', 'lease']);
    for (const u of uploads) {
      expect(u.propertyId).toBe(apartment.propertyId);
      expect(u.token, 'every upload mints its own reCAPTCHA token').toMatch(/^e2e-token-apartment_upload-/);
    }
    expect(new Set(uploads.map((u) => u.token)).size, 'no token is reused').toBe(uploads.length);
    const platePart = uploads.find((u) => u.kind === 'plate')!;
    expect(platePart.filename).toBe('plate.jpg');
    expect(platePart.partType, 'a photo is re-encoded as JPEG before it is sent').toBe('image/jpeg');
    const leasePart = uploads.find((u) => u.kind === 'lease')!;
    expect(leasePart.partType, 'a PDF goes as it is').toBe('application/pdf');

    // S5 → S6: the receipt carries the reference the backend minted for this row.
    await page.getByRole('button', { name: 'Send for review' }).click();
    await expect(page.getByRole('heading', { name: 'Request received' })).toBeVisible({ timeout: 20_000 });
    const ref = (await page.locator('[data-ref]').first().textContent())?.trim() ?? '';
    expect(ref).toMatch(/^[0-9A-F]{8}$/);
    await expect(page.locator('.receipt')).toContainText(plate);
    await expect(page.locator('.receipt')).toContainText('Pending approval');
    await expect(page.locator('.receipt')).toContainText('Protected from towing while the office reviews your request (up to 72 hours).');

    const row = sql(`SELECT upper(right(id::text, 8)), status, unit_number, phone, email,
                            id_doc_url IS NOT NULL, lease_doc_url IS NOT NULL, plate_photo_url IS NOT NULL
                       FROM public.resident_plates
                      WHERE property_id = ${lit(apartment.propertyId)} AND plate_text = ${lit(plate)}`);
    expect(row).toHaveLength(1);
    expect(row[0]).toEqual([ref, 'pending', RESIDENT.unit, '+17045550123', RESIDENT.email, 't', 't', 't']);

    // A reload shows the same receipt, from localStorage.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Request received' })).toBeVisible();
    await expect(page.locator('[data-ref]').first()).toHaveText(ref);
  });

  test('a phone with nothing saved starts at S1, and a saved answer survives a reload mid-way', async ({ page }) => {
    const apartment = await seedResidentApartment();
    await openResidentFlow(page, apartment);
    await page.goto(`${frontendOrigin()}/apt/${apartment.slug}?role=resident`);
    await expect(page.getByRole('heading', { name: 'Before you start' })).toBeVisible();
    await toFirstVehicle(page);
    await page.getByLabel('License plate').fill('KEEP123');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Vehicle 1' })).toBeVisible();
    await expect(page.getByLabel('License plate')).toHaveValue('KEEP123');
    // and the browser's Back still walks the steps, answers intact
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'About you' })).toBeVisible();
    await expect(page.getByLabel('Full name')).toHaveValue(RESIDENT.name);
  });
});
