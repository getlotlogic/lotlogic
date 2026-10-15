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
 *   - the optional photo of the vehicle (kind "vehicle"): a wrong file is an
 *     error that holds Continue until it is removed or replaced, and an added
 *     photo is a third thumbnail on "Check your answers";
 *   - "Check your answers" shows the plate;
 *   - "Send for review" lands on the receipt with the backend's reference and
 *     the line saying where the emailed copy went; the row it names is the
 *     pending request in the database; a backend without vehicle_photo_url
 *     (before task B3) gets the request again without it, said on the receipt;
 *     a reload shows the same receipt from localStorage.
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
    const warnings: string[] = [];
    page.on('console', (m) => { if (m.type() === 'warning') warnings.push(m.text()); });
    const registerCalls: Record<string, unknown>[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().endsWith('/resident_plates/register')) registerCalls.push(JSON.parse(r.postData() ?? '{}'));
    });

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

    // S3: the photo of the vehicle is optional. A wrong file is an error that holds
    // Continue (the summary names it) until it is replaced or removed.
    const car = page.locator('#card-vehicle-v1');
    await expect(car.getByRole('heading', { name: 'Photo of the vehicle (optional)' })).toBeVisible();
    await expect(car).toContainText('The whole car with the plate visible. It helps the office and the tow team recognize your car.');
    await car.locator('input[data-input=files]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not a photo') });
    await expect(car.locator('.doc-error')).toContainText('The selected file must be a JPG, PNG or WEBP');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(summary).toBeFocused();
    await expect(summary).toContainText('The selected file must be a JPG, PNG or WEBP');
    await car.getByRole('button', { name: 'Remove' }).click();
    await expect(car.locator('.doc-error')).toHaveCount(0);
    await expect(summary, 'removed: no longer an error').not.toContainText('The selected file must be a JPG, PNG or WEBP');

    // S3 → S5: the documents upload on select; S5 shows the plate and three thumbnails.
    const plate = await vehicleAndDocumentsToReview(page, apartment);
    await expect(page.locator('#review-vehicle-v1')).toContainText(plate);
    await expect(page.locator('#review-vehicle-v1 .row-thumb')).toHaveCount(apartment.hasRules ? 3 : 2);
    await expect(page.locator('#review-vehicle-v1')).toContainText(
      apartment.hasRules ? 'Plate photo, registration card and vehicle photo added' : 'Plate and vehicle photos added',
    );
    await expect(page.locator('#review-unit')).toContainText(RESIDENT.unit);
    await expect(page.locator('#review-phone')).toContainText('(704) 555-0123');

    const kinds = uploads.map((u) => u.kind);
    expect(kinds, 'the refused text file never left the phone').toEqual(
      apartment.hasRules ? ['plate', 'registration', 'vehicle', 'id', 'lease'] : ['plate', 'vehicle', 'id', 'lease'],
    );
    for (const u of uploads) {
      expect(u.propertyId).toBe(apartment.propertyId);
      expect(u.token, 'every upload mints its own reCAPTCHA token').toMatch(/^e2e-token-apartment_upload-/);
    }
    expect(new Set(uploads.map((u) => u.token)).size, 'no token is reused').toBe(uploads.length);
    const platePart = uploads.find((u) => u.kind === 'plate')!;
    expect(platePart.filename).toBe('plate.jpg');
    expect(platePart.partType, 'a photo is re-encoded as JPEG before it is sent').toBe('image/jpeg');
    const carPart = uploads.find((u) => u.kind === 'vehicle')!;
    expect(carPart.filename).toBe('vehicle.jpg');
    expect(carPart.partType).toBe('image/jpeg');
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
    const emailed = `We emailed a copy of this receipt to ${RESIDENT.email} from dispatch@lotlogicparking.com. Check your spam folder if you don't see it.`;
    await expect(page.locator('.receipt-email')).toHaveText(emailed);
    await expect(page.locator('.receipt-email strong')).toHaveText(RESIDENT.email);
    await expect(page.locator('.keep')).toContainText('Save or screenshot this page.');

    // The vehicle photo went with the request (backend task B3), or an older backend
    // refused the field and the page sent the request once more without it.
    const notSent = "Sent without the photo of the vehicle. It's optional, so nothing else is needed.";
    expect(registerCalls[0]).toHaveProperty('vehicle_photo_url');
    if (apartment.hasVehiclePhoto) {
      expect(registerCalls).toHaveLength(1);
      await expect(page.locator('.receipt')).not.toContainText(notSent);
    } else {
      expect(registerCalls, 'one retry, without the refused field').toHaveLength(2);
      expect(registerCalls[1]).not.toHaveProperty('vehicle_photo_url');
      if (apartment.hasRules) expect(registerCalls[1]).toHaveProperty('registration_doc_url');
      await expect(page.locator('.receipt-note')).toHaveText(notSent);
      expect(warnings.some((w) => w.includes('vehicle_photo_url')), 'a console warning names the refused field').toBe(true);
    }

    const row = sql(`SELECT upper(right(id::text, 8)), status, unit_number, phone, email,
                            id_doc_url IS NOT NULL, lease_doc_url IS NOT NULL, plate_photo_url IS NOT NULL
                            ${apartment.hasVehiclePhoto ? ', vehicle_photo_url IS NOT NULL' : ''}
                       FROM public.resident_plates
                      WHERE property_id = ${lit(apartment.propertyId)} AND plate_text = ${lit(plate)}`);
    expect(row).toHaveLength(1);
    expect(row[0]).toEqual([ref, 'pending', RESIDENT.unit, '+17045550123', RESIDENT.email, 't', 't', 't',
      ...(apartment.hasVehiclePhoto ? ['t'] : [])]);

    // A reload shows the same receipt, from localStorage, email line included.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Request received' })).toBeVisible();
    await expect(page.locator('[data-ref]').first()).toHaveText(ref);
    await expect(page.locator('.receipt-email')).toHaveText(emailed);
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
