/**
 * The long-term parking-pass request on /apt/<slug>?role=resident (Fort Mill
 * resident rules, Task F3) — shared by e2e/apt-flow.spec.ts and the a11y scans
 * of its screens in a11y/axe.spec.ts.
 *
 * Portal suite only (local backend + harness database, tests/README.md). What
 * is real and what is stood in for:
 *   - the property row is read by the page through the PostgREST stand-in, as
 *     the anon role under the harness database's own grants;
 *   - POST /resident_plates/register goes to the LOCAL backend (the production
 *     host is proxied by `pointAtLocalBackend`), so the reference on the
 *     receipt is the one the backend minted;
 *   - POST /apartment/uploads is answered here with a key of the exact shape
 *     the backend hands out (`apt/<property>/<kind>/<32 hex>.<ext>`): the local
 *     backend has no R2 bucket to put the bytes in. The register call then
 *     validates those keys for real;
 *   - Google's reCAPTCHA script is aborted by `pointAtLocalBackend`, so the page
 *     gets a stand-in `grecaptcha` whose tokens the DEBUG backend accepts.
 */
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import type { Page, Route } from '@playwright/test';
import {
  expect, apiSignup, seedNStyle, sql, sqlValue, lit, pointAtLocalBackend, PRODUCTION_API, randomPlate,
} from './portal';

// ── a 1×1 PNG, built here (no fixture files) ─────────────────────────────────
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/** A valid one-pixel RGB PNG of the given colour. */
export function onePixelPng(rgb: [number, number, number]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); // width
  header.writeUInt32BE(1, 4); // height
  header[8] = 8;              // bit depth
  header[9] = 2;              // colour type: RGB
  const scanline = Buffer.from([0, ...rgb]); // filter byte + one pixel
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(scanline)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export const photo = (name: string, rgb: [number, number, number]) => ({ name, mimeType: 'image/png', buffer: onePixelPng(rgb) });

// ── the office phone: on no screen but the content-blocker panel ─────────────
/**
 * The seeded apartment's office phone, as production's Fort Mill rows have one. Gabe,
 * 2026-10-15: "They don't need a phone number on it" — no screen of the flow prints it,
 * or a link that dials it, except the panel a content blocker brings up ("… or call
 * (704) 555-0100"), which the person has no other way past. A property with a phone is what
 * lets a test see a screen that still did.
 */
export const OFFICE_PHONE = { stored: '+17045550100', shown: '(704) 555-0100' };

/** Phone-shaped text: ten digits grouped 3-3-4 with whatever sits between — (704) 555-0100, 704.555.0100, +1 704 555 0100. */
const PHONE_SHAPED = /(?:\+?1[\s.-]*)?\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}/;

/** The screen offers no office phone: no link that dials, no number in any format, no "Questions? Call". */
export async function expectNoOfficePhone(page: Page, screen: string) {
  await expect(page.locator('a[href^="tel:"]'), `${screen}: nothing dials the office`).toHaveCount(0);
  const text = await page.locator('main').innerText();
  expect(text, `${screen}: no phone number, in any format`).not.toMatch(PHONE_SHAPED);
  expect(text, `${screen}: no "Questions? Call"`).not.toMatch(/Questions\?\s*Call/i);
}

// ── the apartment ─────────────────────────────────────────────────────────────
export interface ResidentApartment {
  slug: string;
  propertyId: string;
  name: string;
  /** The harness database has the B1 columns: cap 2 and the registration card. */
  hasRules: boolean;
  /**
   * The harness database has backend task B3's `resident_plates.vehicle_photo_url`
   * (and so, from the same backend branch, the `vehicle_photo_url` register field).
   * Without it the register call answers 422 to that field and the page sends the
   * request once more without it.
   */
  hasVehiclePhoto: boolean;
  /**
   * The harness database has backend task B4's `resident_plates.vehicle_make`
   * (and so, from the same backend branch, the `vehicle_make`, `vehicle_model`
   * and `vehicle_color` register fields). Without it the register call answers
   * 422 to those fields and the page sends the request once more without them.
   */
  hasVehicleDetails: boolean;
}

/**
 * A fresh apartment with a public slug. A portal signup has no printed signs,
 * so it has no `qr_code_id`; the page looks a property up by it. Where the
 * harness has the resident-rules columns (backend Task B1's migration), the
 * property gets Fort Mill's rules: two vehicles per unit, registration card
 * required.
 */
export async function seedResidentApartment(): Promise<ResidentApartment> {
  seedNStyle(); // the signup partner (slug "nstyle") must exist
  const account = await apiSignup();
  const slug = `apt-flow-${crypto.randomBytes(4).toString('hex')}`;
  const type = sqlValue(`UPDATE public.properties SET qr_code_id = ${lit(slug)}
                          WHERE id = ${lit(account.property_id)} RETURNING property_type`);
  expect(type, 'a portal signup is an apartment property').toBe('apartment');
  const hasRules = sqlValue(`SELECT count(*) FROM information_schema.columns
                              WHERE table_schema = 'public' AND table_name = 'properties'
                                AND column_name IN ('max_vehicles_per_unit', 'require_vehicle_registration')`) === '2';
  if (hasRules) {
    sql(`UPDATE public.properties SET max_vehicles_per_unit = 2, require_vehicle_registration = true
          WHERE id = ${lit(account.property_id)}`);
  }
  sql(`UPDATE public.properties SET policy_phone = ${lit(OFFICE_PHONE.stored)} WHERE id = ${lit(account.property_id)}`);
  const hasVehiclePhoto = sqlValue(`SELECT count(*) FROM information_schema.columns
                                     WHERE table_schema = 'public' AND table_name = 'resident_plates'
                                       AND column_name = 'vehicle_photo_url'`) === '1';
  const hasVehicleDetails = sqlValue(`SELECT count(*) FROM information_schema.columns
                                       WHERE table_schema = 'public' AND table_name = 'resident_plates'
                                         AND column_name = 'vehicle_make'`) === '1';
  return { slug, propertyId: account.property_id, name: account.signup.name, hasRules, hasVehiclePhoto, hasVehicleDetails };
}

export interface UploadSeen { kind: string; filename: string; partType: string; propertyId: string; token: string }

/**
 * Point the page at the harness and stand in for the two outside services
 * (R2 uploads, reCAPTCHA). Returns the uploads the page made, in order.
 */
export async function openResidentFlow(page: Page, apartment: ResidentApartment): Promise<UploadSeen[]> {
  await pointAtLocalBackend(page);
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  await page.addInitScript(() => {
    (window as unknown as { grecaptcha: unknown }).grecaptcha = {
      ready: (cb: () => void) => cb(),
      execute: (_key: string, opts: { action: string }) => Promise.resolve(`e2e-token-${opts.action}-${Math.random().toString(36).slice(2)}`),
    };
  });
  const seen: UploadSeen[] = [];
  await page.route(`${PRODUCTION_API}/apartment/uploads`, async (route: Route) => {
    const req = route.request();
    const cors = {
      'access-control-allow-origin': req.headers()['origin'] ?? '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
    };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const body = (req.postDataBuffer() ?? Buffer.alloc(0)).toString('latin1');
    const field = (name: string) => new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`).exec(body)?.[1] ?? '';
    const file = /name="file"; filename="([^"]+)"\r\nContent-Type: ([^\r]+)/.exec(body);
    const upload: UploadSeen = {
      kind: field('kind'),
      filename: file?.[1] ?? '',
      partType: file?.[2] ?? '',
      propertyId: field('property_id'),
      token: field('recaptcha_token'),
    };
    seen.push(upload);
    const ext = upload.filename.endsWith('.pdf') ? 'pdf' : 'jpg';
    const key = `apt/${upload.propertyId}/${upload.kind}/${crypto.randomBytes(16).toString('hex')}.${ext}`;
    return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ key }) });
  });
  return seen;
}

/** Choose a file on a document card (the "Choose" input) and wait for "Uploaded". */
export async function upload(page: Page, cardId: string, file: { name: string; mimeType: string; buffer: Buffer }) {
  await page.locator(`#${cardId} input[data-input=files]`).setInputFiles(file);
  await expect(page.locator(`#${cardId} .doc-ok`)).toHaveText('Uploaded');
}

export const RESIDENT = {
  name: 'Jane Smith',
  unit: '214',
  phone: '7045550123',
  email: 'jane.smith@e2e.lotlogic.dev',
};

/** The vehicle every walkthrough registers: what a person types, and what the page shows and sends. */
export type Vehicle = { make: string; model: string; color: string };
export const VEHICLE: Vehicle = { make: 'Honda', model: 'Civic', color: 'white' };

/** "white Honda Civic · ABC1234" — the line S3b, S5 and the receipt show for a vehicle. */
export const vehicleLine = (plate: string, v: Vehicle = VEHICLE) => `${v.color} ${v.make} ${v.model} · ${plate}`;

/** The three vehicle fields, on S3 or on the short-term form (same labels on both). */
export async function fillVehicle(page: Page, v: Vehicle = VEHICLE) {
  await page.getByLabel('Make', { exact: true }).fill(v.make);
  await page.getByLabel('Model', { exact: true }).fill(v.model);
  await page.getByLabel('Color', { exact: true }).selectOption(v.color);
}

/** S1 → S3: through the gate and About you, onto Vehicle 1. */
export async function toFirstVehicle(page: Page) {
  await page.getByLabel("Yes, I'm on the lease").check();
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByRole('heading', { name: 'About you' })).toBeVisible();
  await page.getByLabel('Full name').fill(RESIDENT.name);
  await page.getByLabel('Unit number').fill(RESIDENT.unit);
  await page.getByLabel('Mobile phone').fill(RESIDENT.phone);
  await page.getByLabel('Email').fill(RESIDENT.email);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Vehicle 1' })).toBeVisible();
}

/**
 * S3 → S5: one vehicle with its plate, make, model and color, its documents
 * (and, unless `vehiclePhoto` is false, the optional photo of the vehicle), then
 * the ID and the lease. Returns the plate.
 */
export async function vehicleAndDocumentsToReview(
  page: Page, apartment: ResidentApartment, plate = randomPlate(), { vehiclePhoto = true } = {},
) {
  await page.getByLabel('License plate').fill(plate);
  await fillVehicle(page);
  await upload(page, 'card-plate-v1', photo('plate.png', [40, 60, 90]));
  if (apartment.hasRules) {
    await upload(page, 'card-registration-v1', photo('registration.png', [200, 190, 170]));
  } else {
    await expect(page.locator('#card-registration-v1')).toHaveCount(0);
  }
  if (vehiclePhoto) await upload(page, 'card-vehicle-v1', photo('car.png', [90, 30, 30]));
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Your vehicles' })).toBeVisible();
  await expect(page.locator('#row-v1'), 'the list shows the vehicle as "white Honda Civic · ABC1234"').toContainText(vehicleLine(plate));
  const no = page.getByLabel('No', { exact: true });
  if (await no.count()) await no.check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Your ID and lease' })).toBeVisible();
  await upload(page, 'card-id', photo('id.png', [120, 120, 120]));
  await upload(page, 'card-lease', { name: 'lease.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% e2e lease\n%%EOF\n') });
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Check your answers' })).toBeVisible();
  return plate;
}
