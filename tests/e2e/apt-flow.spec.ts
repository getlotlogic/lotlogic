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
 *   - make, model and color (Task F5a, rule R8) sit right after the plate and
 *     before the documents, 15 px labels and 52 px controls; leaving them empty
 *     is an error in the summary, in that order, with the same words inline;
 *     fixing one takes it out of the summary at once;
 *   - "Check your answers" shows the plate, and "white Honda Civic · ABC1234";
 *   - "Send for review" lands on the receipt with the backend's reference and
 *     the line saying where the emailed copy went; the receipt shows the same
 *     vehicle line; the row it names is the pending request in the database
 *     (with its make, model and color once task B4 is in the backend); a
 *     backend without vehicle_photo_url (before task B3) or without the make,
 *     model and color (before task B4) gets the request again without them,
 *     said on the receipt; a reload shows the same receipt from localStorage;
 *   - the backend's two answers about the vehicle (`vehicle_required`,
 *     `vehicle_color_invalid`) take the person back to Vehicle 1, with the
 *     message and the cursor in the first field the backend named, and Continue
 *     returns to "Check your answers";
 *   - the short-term form asks for the same three fields in the same words,
 *     sends them, and shows the same two answers beside the field. Its register
 *     call is answered by the test (the page's contract is what is checked, not
 *     a backend version);
 *   - no screen of the flow prints the office's phone (Gabe, 2026-10-15: "They
 *     don't need a phone number on it"): the seeded property has one, and neither
 *     the landing, the "No" branch of S1, the receipt (also after a reload) nor the
 *     short-term confirmation shows it or a link that dials it. The panel for a page
 *     a content blocker holds back still does, and a test says so.
 *
 * One QR for a group of properties (Task F6, spec 9) has its own block at the end: /apt/<group>
 * shows "Which address are you at?" for two or more verified apartments under <group>-, a tap
 * rewrites the URL to that property and continues as a direct visit, one sibling goes straight
 * in, an unknown prefix is the unknown-property state.
 *
 * Portal suite (tests/README.md, "Portal suite"): local backend and a
 * throwaway Postgres only. Without PORTAL_E2E=1 every test here is reported as
 * skipped, never failed.
 */
import { test, expect, skipUnlessPortal, frontendOrigin, sql, lit, PRODUCTION_API, pointAtLocalBackend, randomPlate } from '../fixtures/portal';
import {
  seedResidentApartment, openResidentFlow, toFirstVehicle, upload, vehicleAndDocumentsToReview, fillVehicle,
  photo, VEHICLE, vehicleLine, RESIDENT, OFFICE_PHONE, expectNoOfficePhone, seedApartmentGroup,
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
    // The flag is true (the default): the lease is on the list of what to have ready.
    await expect(page.locator('.flow')).toContainText('A copy or photo of your lease');
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

    // S3: make, model and color come right after the plate and before the documents,
    // in the F3 visual system (15 px labels, 52 px controls, 16 px text).
    const make = page.getByLabel('Make', { exact: true });
    const model = page.getByLabel('Model', { exact: true });
    const color = page.getByLabel('Color', { exact: true });
    const top = async (selector: string) => (await page.locator(selector).boundingBox())!.y;
    const stacked = [await top('#plate-v1'), await top('#make-v1'), await top('#model-v1'), await top('#color-v1'), await top('#card-plate-v1')];
    expect(stacked, 'plate, then make, model and color, then the documents').toEqual([...stacked].sort((a, b) => a - b));
    for (const control of [make, model, color]) {
      expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(52);
      expect(await control.evaluate((el) => getComputedStyle(el).fontSize)).toBe('16px');
    }
    for (const id of ['make-v1', 'model-v1', 'color-v1']) {
      expect(await page.locator(`label[for="${id}"]`).evaluate((el) => getComputedStyle(el).fontSize), id).toBe('15px');
    }
    // The Make field is free text with about forty suggestions; the Color field is the backend's fourteen.
    await expect(make).toHaveAttribute('list', 'vehicle-makes');
    expect(await page.locator('#vehicle-makes option').count()).toBeGreaterThanOrEqual(38);
    await expect(page.locator('#vehicle-makes option[value="Honda"]')).toHaveCount(1);
    // The backend takes 1 to 40 characters of each.
    await expect(make).toHaveAttribute('maxlength', '40');
    await expect(model).toHaveAttribute('maxlength', '40');
    await expect(color.locator('option')).toHaveText([
      'Choose a color', 'White', 'Black', 'Gray', 'Silver', 'Blue', 'Red', 'Green', 'Brown', 'Beige', 'Gold', 'Orange', 'Yellow', 'Purple', 'Other',
    ]);
    expect(await color.locator('option').evaluateAll((options) => options.map((o) => (o as HTMLOptionElement).value))).toEqual([
      '', 'white', 'black', 'gray', 'silver', 'blue', 'red', 'green', 'brown', 'beige', 'gold', 'orange', 'yellow', 'purple', 'other',
    ]);

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
    // Nothing else is filled in either: the summary lists it all in page order, the make, model
    // and color between the plate and the documents, in the brief's words.
    await expect(summary.locator('li')).toHaveText([
      'Enter the license plate',
      'Add the make.',
      'Add the model.',
      'Pick the color.',
      'Add a photo of the plate',
      ...(apartment.hasRules ? ['Add your vehicle registration card'] : []),
      'The selected file must be a JPG, PNG or WEBP',
    ]);
    for (const [control, id, message] of [[make, 'make-v1', 'Add the make.'], [model, 'model-v1', 'Add the model.'], [color, 'color-v1', 'Pick the color.']] as const) {
      await expect(page.locator(`#${id}-error`), id).toContainText(message);
      await expect(control, `${id} is marked invalid`).toHaveAttribute('aria-invalid', 'true');
      await expect(control, `${id} is described by its error`).toHaveAttribute('aria-describedby', new RegExp(`${id}-error`));
    }
    // Fixing a field takes its error out of the summary at once.
    await make.fill('Hon');
    await expect(page.locator('#make-v1-error')).toBeHidden();
    await expect(make).not.toHaveAttribute('aria-invalid', 'true');
    await expect(summary).not.toContainText('Add the make.');
    await expect(summary).toContainText('Add the model.');
    await color.selectOption('red');
    await expect(summary).not.toContainText('Pick the color.');
    await car.getByRole('button', { name: 'Remove' }).click();
    await expect(car.locator('.doc-error')).toHaveCount(0);
    await expect(summary, 'removed: no longer an error').not.toContainText('The selected file must be a JPG, PNG or WEBP');

    // S3 → S5: the documents upload on select; S5 shows the plate and three thumbnails.
    const plate = await vehicleAndDocumentsToReview(page, apartment);
    await expect(page.locator('#review-vehicle-v1')).toContainText(vehicleLine(plate));
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
    await expect(page.locator('.receipt-car'), 'the vehicle line on the receipt').toContainText(vehicleLine(plate));
    await expect(page.locator('.receipt')).toContainText('Pending approval');
    await expect(page.locator('.receipt')).toContainText('Protected from towing while the office reviews your request (up to 72 hours).');
    const emailed = `We emailed a copy of this receipt to ${RESIDENT.email} from dispatch@lotlogicparking.com. Check your spam folder if you don't see it.`;
    await expect(page.locator('.receipt-email')).toHaveText(emailed);
    await expect(page.locator('.receipt-email strong')).toHaveText(RESIDENT.email);
    await expect(page.locator('.keep')).toContainText('Save or screenshot this page.');
    await expectNoOfficePhone(page, 'S6, the receipt');

    // What went with the request. The first call carries everything the page collected: the
    // vehicle photo and the make, model and color. A backend that has them (tasks B3 and B4)
    // takes it in that one call; an older one refuses the unknown fields (422) and the page
    // sends the same request once more without them, saying so on the receipt.
    const photoNotSent = "Sent without the photo of the vehicle. It's optional, so nothing else is needed.";
    const detailsNotSent = 'Sent without the make, model and color — the office may ask for them.';
    const refused = [
      ...(apartment.hasVehiclePhoto ? [] : ['vehicle_photo_url']),
      ...(apartment.hasVehicleDetails ? [] : ['vehicle_make', 'vehicle_model', 'vehicle_color']),
    ];
    const notes = [...(apartment.hasVehiclePhoto ? [] : [photoNotSent]), ...(apartment.hasVehicleDetails ? [] : [detailsNotSent])];
    expect(registerCalls[0]).toHaveProperty('vehicle_photo_url');
    expect(registerCalls[0], 'the three fields, as typed (the color as the list\'s lowercase value)').toMatchObject({
      vehicle_make: VEHICLE.make, vehicle_model: VEHICLE.model, vehicle_color: VEHICLE.color,
    });
    if (!refused.length) {
      expect(registerCalls).toHaveLength(1);
    } else {
      expect(registerCalls, 'one retry, without the refused fields').toHaveLength(2);
      for (const field of Object.keys(registerCalls[0])) {
        if (refused.includes(field)) expect(registerCalls[1], `${field} is left out`).not.toHaveProperty(field);
        else expect(registerCalls[1], `${field} still goes`).toHaveProperty(field);
      }
      expect(warnings.some((w) => refused.every((field) => w.includes(field))), 'a console warning names the refused fields').toBe(true);
    }
    if (notes.length) await expect(page.locator('.receipt-note')).toHaveText(notes);
    else await expect(page.locator('.receipt-note')).toHaveCount(0);

    const row = sql(`SELECT upper(right(id::text, 8)), status, unit_number, phone, email,
                            id_doc_url IS NOT NULL, lease_doc_url IS NOT NULL, plate_photo_url IS NOT NULL
                            ${apartment.hasVehiclePhoto ? ', vehicle_photo_url IS NOT NULL' : ''}
                            ${apartment.hasVehicleDetails ? ', vehicle_make, vehicle_model, vehicle_color' : ''}
                       FROM public.resident_plates
                      WHERE property_id = ${lit(apartment.propertyId)} AND plate_text = ${lit(plate)}`);
    expect(row).toHaveLength(1);
    expect(row[0]).toEqual([ref, 'pending', RESIDENT.unit, '+17045550123', RESIDENT.email, 't', 't', 't',
      ...(apartment.hasVehiclePhoto ? ['t'] : []),
      ...(apartment.hasVehicleDetails ? [VEHICLE.make, VEHICLE.model, VEHICLE.color] : [])]);

    // A reload shows the same receipt, from localStorage: email line, vehicle line and notes included.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Request received' })).toBeVisible();
    await expect(page.locator('[data-ref]').first()).toHaveText(ref);
    await expect(page.locator('.receipt-email')).toHaveText(emailed);
    await expect(page.locator('.receipt-car')).toContainText(vehicleLine(plate));
    if (notes.length) await expect(page.locator('.receipt-note')).toHaveText(notes);
    else await expect(page.locator('.receipt-note')).toHaveCount(0);
    await expectNoOfficePhone(page, 'S6 after a reload');
  });

  test('a phone with nothing saved starts at S1, and a saved answer survives a reload mid-way', async ({ page }) => {
    const apartment = await seedResidentApartment();
    await openResidentFlow(page, apartment);
    await page.goto(`${frontendOrigin()}/apt/${apartment.slug}?role=resident`);
    await expect(page.getByRole('heading', { name: 'Before you start' })).toBeVisible();
    await toFirstVehicle(page);
    await page.getByLabel('License plate').fill('KEEP123');
    await fillVehicle(page, { make: 'Land Rover', model: 'Range Rover Sport', color: 'silver' });
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Vehicle 1' })).toBeVisible();
    await expect(page.getByLabel('License plate')).toHaveValue('KEEP123');
    await expect(page.getByLabel('Make', { exact: true })).toHaveValue('Land Rover');
    await expect(page.getByLabel('Model', { exact: true })).toHaveValue('Range Rover Sport');
    await expect(page.getByLabel('Color', { exact: true })).toHaveValue('silver');
    // and the browser's Back still walks the steps, answers intact
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'About you' })).toBeVisible();
    await expect(page.getByLabel('Full name')).toHaveValue(RESIDENT.name);
  });

  // "In the S5 error summary too": a request saved on the phone by the page before the make, model
  // and color existed (24 hours of localStorage) comes back complete but for those three. The only
  // place that shows is "Check your answers".
  test('a request saved before the make, model and color existed asks for them on "Check your answers"', async ({ page }) => {
    const apartment = await seedResidentApartment();
    await openResidentFlow(page, apartment);
    const doc = (kind: string, ext = 'jpg') => ({
      key: `apt/${apartment.propertyId}/${kind}/${'a'.repeat(32)}.${ext}`,
      name: `${kind}.${ext}`,
      size: 2048,
      type: ext === 'pdf' ? 'application/pdf' : 'image/jpeg',
    });
    const saved = {
      v: 1,
      savedAt: Date.now(),
      propertyId: apartment.propertyId,
      flow: {
        step: 'review', leaseholder: 'yes', name: RESIDENT.name, unit: RESIDENT.unit, phone: '(704) 555-0123', email: RESIDENT.email,
        vehicles: [{
          vid: 'v1', plate: 'OLD1234', ref: null, registrationSent: null, vehiclePhotoSent: null,
          docs: { plate: doc('plate'), registration: doc('registration'), vehicle: null },
        }],
        nextVid: 2, another: 'no', docs: { id: doc('id'), lease: doc('lease', 'pdf') }, returnTo: null, receipt: null,
      },
    };
    await page.addInitScript(([key, value]) => {
      try { if (!localStorage.getItem(key)) localStorage.setItem(key, value); } catch { /* blocked storage */ }
    }, [`lotlogic:apt:${apartment.slug}`, JSON.stringify(saved)]);
    await page.goto(`${frontendOrigin()}/apt/${apartment.slug}?role=resident`);

    await expect(page.getByRole('heading', { name: 'Check your answers' })).toBeVisible();
    await expect(page.locator('#review-vehicle-v1'), 'nothing describes it yet: the plate alone').toContainText('OLD1234');
    await expect(page.locator('#review-vehicle-v1 .vehicle-desc')).toHaveCount(0);
    await page.getByRole('button', { name: 'Send for review' }).click();
    const summary = page.locator('#errorSummary');
    await expect(summary).toBeFocused();
    await expect(summary.locator('li')).toHaveText(['Add the make.', 'Add the model.', 'Pick the color.']);

    // An entry leads to the vehicle's row, at its Change button (the first control in it);
    // Change goes to the vehicle's step, and Continue comes back.
    const change = page.locator('#review-vehicle-v1').getByRole('button', { name: /Change/ });
    await summary.getByRole('link', { name: 'Add the make.' }).click();
    await expect(change).toBeFocused();
    await change.click();
    await expect(page.getByRole('heading', { name: 'Vehicle 1' })).toBeVisible();
    await expect(page.getByLabel('Make', { exact: true }), 'Change puts the cursor in the first field the vehicle is missing, not the plate').toBeFocused();
    await fillVehicle(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Check your answers' })).toBeVisible();
    await expect(page.locator('#review-vehicle-v1')).toContainText(vehicleLine('OLD1234'));
    await page.getByRole('button', { name: 'Send for review' }).click();
    await expect(page.getByRole('heading', { name: 'Request received' })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.receipt-car')).toContainText(vehicleLine('OLD1234'));
  });

  // The page asks for the three fields before anything is sent, so these answers are a safety net
  // (a backend holding a request to rule R8 that the page's own checks let through). The test
  // plays the backend for the first send only; the second reaches the real one.
  for (const answer of [
    {
      code: 'vehicle_required',
      body: { detail: 'vehicle_required', missing: ['vehicle_color', 'vehicle_model'] },
      message: 'Add the make, model and color of the vehicle.',
      focus: 'model-v1', // the first of the two it names, in the page's order
    },
    {
      code: 'vehicle_color_invalid',
      body: { detail: 'vehicle_color_invalid' },
      message: 'Pick the color from the list.',
      focus: 'color-v1',
    },
  ]) {
    test(`the backend's ${answer.code} puts the person back on Vehicle 1, the cursor in the field it names`, async ({ page }) => {
      const apartment = await seedResidentApartment();
      await openResidentFlow(page, apartment);
      let sends = 0;
      await page.route(`${PRODUCTION_API}/resident_plates/register`, async (route) => {
        const req = route.request();
        if (req.method() !== 'POST') return route.fallback(); // the CORS preflight goes on to the harness
        sends += 1;
        if (sends > 1) return route.fallback();
        return route.fulfill({
          status: 400,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': req.headers()['origin'] ?? '*' },
          body: JSON.stringify(answer.body),
        });
      });
      await page.goto(`${frontendOrigin()}/apt/${apartment.slug}?role=resident`);
      await toFirstVehicle(page);
      const plate = await vehicleAndDocumentsToReview(page, apartment);
      await page.getByRole('button', { name: 'Send for review' }).click();

      // The fields are on the vehicle's own step: the page goes there, with the message in the
      // summary and beside the field, and the cursor in the first field the backend named.
      await expect(page.getByRole('heading', { name: 'Vehicle 1' })).toBeVisible();
      await expect(page.locator('#errorSummary')).toContainText(answer.message);
      await expect(page.locator(`#${answer.focus}`)).toBeFocused();
      await expect(page.locator(`#${answer.focus}-error`)).toContainText(answer.message);
      await expect(page).toHaveTitle(/^Error: Vehicle 1/);
      await expect(page.getByLabel('Make', { exact: true })).toHaveValue(VEHICLE.make);

      // Continue goes back to "Check your answers" (not the list), and the send now goes through.
      await page.getByRole('button', { name: 'Continue' }).click();
      await expect(page.getByRole('heading', { name: 'Check your answers' })).toBeVisible();
      await page.getByRole('button', { name: 'Send for review' }).click();
      await expect(page.getByRole('heading', { name: 'Request received' })).toBeVisible({ timeout: 20_000 });
      await expect(page.locator('.receipt-car')).toContainText(vehicleLine(plate));
      expect(sends).toBeGreaterThanOrEqual(2);
    });
  }

  test('the short-term form asks for the make, model and color in the same words, sends them, and shows the backend\'s two answers beside the field', async ({ page }) => {
    const apartment = await seedResidentApartment();
    await openResidentFlow(page, apartment);
    const sent: Record<string, unknown>[] = [];
    const answers: { status: number; body: Record<string, unknown> }[] = [
      { status: 400, body: { detail: 'vehicle_required', missing: ['vehicle_model'] } },
      { status: 400, body: { detail: 'vehicle_color_invalid' } },
      { status: 200, body: { reference_id: 'ab12cd34', plate_text: 'SHORT12', valid_until: null } },
    ];
    await page.route(`${PRODUCTION_API}/visitor_passes/register`, async (route) => {
      const req = route.request();
      const headers = {
        'access-control-allow-origin': req.headers()['origin'] ?? '*',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': 'POST, OPTIONS',
      };
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      sent.push(JSON.parse(req.postData() ?? '{}'));
      const answer = answers.shift()!;
      return route.fulfill({ status: answer.status, contentType: 'application/json', headers, body: JSON.stringify(answer.body) });
    });

    await page.goto(`${frontendOrigin()}/apt/${apartment.slug}?role=guest`);
    await expect(page.getByLabel('Full name')).toBeVisible();
    await expectNoOfficePhone(page, 'the short-term form');
    await page.getByLabel('Full name').fill('Sam Parker');
    await page.getByLabel("Unit you're visiting").fill('12B');
    await page.getByLabel('Phone number').fill('7045550123');
    await page.getByLabel('Email').fill('sam.parker@e2e.lotlogic.dev');
    await page.getByLabel('License plate').fill('SHORT12');
    await page.locator('#g_plate_photo').setInputFiles(photo('plate.png', [40, 60, 90]));
    await page.locator('#g_id').setInputFiles(photo('id.png', [120, 120, 120]));

    // The same three fields as the long-term form, right after the plate and before the documents.
    const make = page.getByLabel('Make', { exact: true });
    const model = page.getByLabel('Model', { exact: true });
    const color = page.getByLabel('Color', { exact: true });
    const top = async (selector: string) => (await page.locator(selector).boundingBox())!.y;
    const stacked = [await top('#g_plate'), await top('#g_make'), await top('#g_model'), await top('#g_color'), await top('#g_plate_photo')];
    expect(stacked, 'plate, then make, model and color, then the documents').toEqual([...stacked].sort((a, b) => a - b));
    for (const control of [make, model, color]) {
      expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(52);
      expect(await control.evaluate((el) => getComputedStyle(el).fontSize)).toBe('16px');
    }
    await expect(make).toHaveAttribute('list', 'vehicle-makes');
    expect(await page.locator('#vehicle-makes option').count()).toBeGreaterThanOrEqual(38);
    await expect(make).toHaveAttribute('maxlength', '40');
    await expect(model).toHaveAttribute('maxlength', '40');
    await expect(color.locator('option')).toHaveCount(15);
    // The page turns the browser's own arrow off, so every select on the form draws the same
    // chevron of its own: Color and "How long" look like the menus they are.
    for (const id of ['g_color', 'g_hours']) {
      expect(await page.locator(`#${id}`).evaluate((el) => getComputedStyle(el.parentElement!, '::after').content), `${id} draws a chevron`).toBe('""');
    }
    // Marked required for assistive technology, but not `required`: the browser's own bubble would
    // replace the form's words (the empty submit below shows ours).
    for (const control of [make, model, color]) await expect(control).toHaveAttribute('aria-required', 'true');

    // Required: nothing is sent, each field says so in the brief's words, the cursor goes to the first.
    const submit = page.getByRole('button', { name: /Get my pass/ });
    await submit.click();
    await expect(page.locator('#g_make-error')).toContainText('Add the make.');
    await expect(page.locator('#g_model-error')).toContainText('Add the model.');
    await expect(page.locator('#g_color-error')).toContainText('Pick the color.');
    await expect(make).toBeFocused();
    for (const control of [make, model, color]) await expect(control).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#errorMsg')).toBeEmpty();
    expect(sent, 'nothing left the page').toHaveLength(0);

    // Fixing a field clears its own error.
    await make.fill('Honda');
    await expect(page.locator('#g_make-error')).toBeHidden();
    await expect(page.locator('#g_model-error')).toBeVisible();
    await model.fill('Civic');
    await color.selectOption('white');
    await expect(page.locator('.field-error:not([hidden])')).toHaveCount(0);

    // The backend's two answers, beside the field they are about.
    await submit.click();
    await expect(page.locator('#g_model-error')).toContainText('Add the make, model and color of the vehicle.');
    await expect(model).toBeFocused();
    await submit.click();
    await expect(page.locator('#g_color-error')).toContainText('Pick the color from the list.');
    await expect(page.locator('#g_model-error'), 'the earlier message is gone').toBeHidden();
    await expect(color).toBeFocused();
    await submit.click();
    await expect(page.locator('.success-card')).toContainText('AB12CD34');
    await expectNoOfficePhone(page, 'the short-term confirmation');

    expect(sent).toHaveLength(3);
    for (const body of sent) {
      expect(body).toMatchObject({ plate_text: 'SHORT12', vehicle_make: 'Honda', vehicle_model: 'Civic', vehicle_color: 'white' });
    }
  });

  // Gabe, 2026-10-15: "They don't need a phone number on it." The seeded property has an office
  // phone (fixtures/aptFlow.ts), so a screen that still printed it, or a button that dials it,
  // would show it here. The receipt and the short-term confirmation are checked in the tests above.
  test('the landing and the "No" branch of S1 print no office phone', async ({ page }) => {
    const apartment = await seedResidentApartment();
    await openResidentFlow(page, apartment);
    await page.goto(`${frontendOrigin()}/apt/${apartment.slug}`);
    await expect(page.getByRole('button', { name: /I live here/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /I'm visiting/ })).toBeVisible();
    await expectNoOfficePhone(page, 'the landing');

    await page.getByRole('button', { name: /I live here/ }).click();
    await expect(page.getByRole('heading', { name: 'Before you start' })).toBeVisible();
    await page.getByLabel("No, I'm not on the lease").check();
    await expect(page.locator('#gateNo')).toContainText('Ask the office about adding you to the lease.');
    await expectNoOfficePhone(page, 'S1, "No, I\'m not on the lease"');
  });

  // The one place the office phone stays. Without Google's script (here aborted, as a content
  // blocker does, and no stand-in `grecaptcha`) the page cannot send anything and says so, with the
  // number as a link. It also shows the seeded phone does reach the page, so the absences above
  // are not vacuous.
  test('a page a content blocker holds back still says to call the office, the number a link that dials', async ({ page }) => {
    const apartment = await seedResidentApartment();
    await pointAtLocalBackend(page);
    await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
    await page.goto(`${frontendOrigin()}/apt/${apartment.slug}?role=resident`);
    await expect(page.getByRole('heading', { name: 'Before you start' })).toBeVisible();
    const panel = page.locator('#pageAlert');
    await expect(panel).toHaveText(`Something is blocking this page from sending. Turn off content blockers for this site, or call ${OFFICE_PHONE.shown}.`);
    await expect(panel.locator('a')).toHaveAttribute('href', `tel:${OFFICE_PHONE.stored}`);
    await expect(panel.locator('a')).toHaveText(OFFICE_PHONE.shown);
  });
});

// Task F8, spec 10: a property that does not ask for the lease. The resident gives an ID,
// the registration card and the photo of the plate, and reaches the receipt; the lease
// appears on no screen and goes nowhere.
test.describe('apartment without a lease upload @portal', () => {
  test.beforeEach(() => {
    skipUnlessPortal();
  });

  test('require_lease = false: S1 to the receipt with an ID and no lease', async ({ page }) => {
    const apartment = await seedResidentApartment({ requireLease: false });
    test.skip(!apartment.hasLeaseColumn, 'the harness database lacks properties.require_lease (backend task B5)');
    const uploads = await openResidentFlow(page, apartment);
    const registerCalls: Record<string, unknown>[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().endsWith('/resident_plates/register')) registerCalls.push(JSON.parse(r.postData() ?? '{}'));
    });

    await page.goto(`${frontendOrigin()}/apt/${apartment.slug}?role=resident`);
    await expect(page.getByRole('heading', { name: 'Before you start' })).toBeVisible();
    // S1: the rules are untouched, the lease is not on the list.
    await expect(page.locator('.flow')).toContainText('Only leaseholders can hold a long-term parking pass.');
    await expect(page.locator('.flow')).not.toContainText('A copy or photo of your lease');
    await expect(page.locator('.flow')).toContainText('Photo ID');
    await toFirstVehicle(page);

    const plate = await vehicleAndDocumentsToReview(page, apartment);
    // S5: an ID row, no lease row.
    await expect(page.locator('#review-id')).toBeVisible();
    await expect(page.locator('#review-lease')).toHaveCount(0);
    await expect(page.locator('.summary').last()).not.toContainText('Lease');
    expect(uploads.map((u) => u.kind)).not.toContain('lease');
    expect(uploads.map((u) => u.kind)).toContain('id');

    await page.getByRole('button', { name: 'Send for review' }).click();
    await expect(page.getByRole('heading', { name: 'Request received' })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.receipt')).not.toContainText('lease');
    expect(registerCalls[0].lease_doc_url ?? null).toBeNull();
    const row = sql(`SELECT id_doc_url IS NOT NULL, lease_doc_url IS NULL, plate_photo_url IS NOT NULL, status
                       FROM public.resident_plates
                      WHERE property_id = ${lit(apartment.propertyId)} AND plate_text = ${lit(plate)}`);
    expect(row).toEqual([['t', 't', 't', 'pending']]);
  });

  test('S4 asks for the ID only, in the id-only words, and Continue wants nothing else', async ({ page }) => {
    const apartment = await seedResidentApartment({ requireLease: false });
    test.skip(!apartment.hasLeaseColumn, 'the harness database lacks properties.require_lease (backend task B5)');
    await openResidentFlow(page, apartment);
    await page.goto(`${frontendOrigin()}/apt/${apartment.slug}?role=resident`);
    await toFirstVehicle(page);
    await page.getByLabel('License plate').fill(randomPlate());
    await fillVehicle(page);
    await upload(page, 'card-plate-v1', photo('plate.png', [40, 60, 90]));
    if (apartment.hasRules) await upload(page, 'card-registration-v1', photo('registration.png', [200, 190, 170]));
    await page.getByRole('button', { name: 'Continue' }).click();
    const no = page.getByLabel('No', { exact: true });
    if (await no.count()) await no.check();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Your ID', exact: true })).toBeVisible();
    await expect(page.locator('.intro')).toHaveText(
      "The property office and its parking enforcement company use this to confirm you're on the lease for this unit and that the cars are yours.",
    );
    await expect(page.locator('#card-id')).toBeVisible();
    await expect(page.locator('#card-lease')).toHaveCount(0);
    await expect(page).toHaveTitle(/^Your ID/);
    // Continue with no ID → one error, the ID's.
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.locator('#errorSummary li')).toHaveText(['Add a photo of your ID']);
  });
});

test.describe('one QR for a group of properties @portal', () => {
  test.beforeEach(() => {
    skipUnlessPortal();
  });

  test('the group link lists the siblings in order; a tap lands on that property\'s S1 with the URL rewritten', async ({ page }) => {
    const { group, members } = await seedApartmentGroup(3);
    await openResidentFlow(page, members[0]);
    await page.goto(`${frontendOrigin()}/apt/${group}?role=resident`);

    await expect(page.getByRole('heading', { name: 'Which address are you at?' })).toBeVisible();
    await expect(page.getByText('Pick the building your lease is for.')).toBeVisible();
    await expect(page.getByText('Not sure? Ask the office.')).toBeVisible();
    const buttons = page.locator('.pick-btn');
    await expect(buttons).toHaveCount(3);
    for (let i = 0; i < 3; i++) {
      await expect(buttons.nth(i).locator('.choice-title')).toHaveText(members[i].name);
      await expect(buttons.nth(i).locator('.sub')).toHaveText(members[i].address);
    }
    await expectNoOfficePhone(page, 'S0');

    // 52 px targets and 16 px text, as F5a asserted for the flow's controls
    for (let i = 0; i < 3; i++) {
      const box = await buttons.nth(i).boundingBox();
      expect(box!.height, `target ${i}`).toBeGreaterThanOrEqual(52);
      expect(await buttons.nth(i).locator('.sub').evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
    }
    for (const sel of ['.pick-lead', '.pick-office']) {
      expect(await page.locator(sel).evaluate((el) => parseFloat(getComputedStyle(el).fontSize)), sel).toBeGreaterThanOrEqual(16);
    }

    await buttons.nth(1).click();
    await expect(page.getByRole('heading', { name: 'Before you start' })).toBeVisible();
    const landed = new URL(page.url());
    expect(landed.pathname + landed.search).toBe(`/apt/${members[1].slug}?role=resident`);
    await expect(page.locator('.flow-top .property-name')).toHaveText(members[1].name);

    // the same as a direct visit: a reload stays on that property
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Before you start' })).toBeVisible();
    await expect(page.locator('.flow-top .property-name')).toHaveText(members[1].name);
  });

  test('a guest link carries the role through and says which address the person is visiting', async ({ page }) => {
    const { group, members } = await seedApartmentGroup(2);
    await openResidentFlow(page, members[0]);
    await page.goto(`${frontendOrigin()}/apt/${group}?role=guest`);
    await expect(page.getByText("Pick the address you're visiting.")).toBeVisible();
    await page.locator('.pick-btn').nth(0).click();
    await expect(page).toHaveURL(new RegExp(`/apt/${members[0].slug}\\?role=guest$`));
    await expect(page.locator('#guestForm')).toBeVisible();
    await expect(page.locator('.property-name strong')).toHaveText(members[0].name);
  });

  test('a prefix with one sibling goes straight to it, no S0', async ({ page }) => {
    const { group, members } = await seedApartmentGroup(1);
    await openResidentFlow(page, members[0]);
    await page.goto(`${frontendOrigin()}/apt/${group}?role=resident`);
    await expect(page.getByRole('heading', { name: 'Before you start' })).toBeVisible();
    await expect(page.locator('.pick-btn')).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/apt/${members[0].slug}\\?role=resident$`));
    await expect(page.locator('.flow-top .property-name')).toHaveText(members[0].name);
  });

  test('an exact property slug is never a group, even when siblings sit under it', async ({ page }) => {
    const { group, members } = await seedApartmentGroup(2);
    // a property whose slug is the prefix itself
    const parent = await seedResidentApartment({ slug: group });
    await openResidentFlow(page, parent);
    await page.goto(`${frontendOrigin()}/apt/${group}?role=resident`);
    await expect(page.getByRole('heading', { name: 'Before you start' })).toBeVisible();
    await expect(page.locator('.pick-btn')).toHaveCount(0);
    expect(members.length).toBe(2);
  });

  test('an unknown prefix is the unknown-property state', async ({ page }) => {
    await pointAtLocalBackend(page);
    await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
    await page.goto(`${frontendOrigin()}/apt/no-such-group-${Date.now()}?role=resident`);
    await expect(page.getByRole('heading', { name: 'Property not found' })).toBeVisible();
    await expect(page.locator('.pick-btn')).toHaveCount(0);
  });
});
