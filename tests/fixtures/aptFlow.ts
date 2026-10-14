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

// ── the apartment ─────────────────────────────────────────────────────────────
export interface ResidentApartment {
  slug: string;
  propertyId: string;
  name: string;
  /** The harness database has the B1 columns: cap 2 and the registration card. */
  hasRules: boolean;
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
  // The register route calls services.plate_synonyms.synonym_set, which reads
  // inferred_plate_pairs; the portal subset schema does not carry that table
  // (no portal test drove /resident_plates/register before). An empty one with
  // the columns it reads is what production has for a property with no pairs.
  sql(`CREATE TABLE IF NOT EXISTS public.inferred_plate_pairs (
         property_id uuid, plate_a text, plate_b text, verified_at timestamptz, dismissed_at timestamptz)`);
  return { slug, propertyId: account.property_id, name: account.signup.name, hasRules };
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

/** S3 → S5: one vehicle with its documents, then the ID and the lease. Returns the plate. */
export async function vehicleAndDocumentsToReview(page: Page, apartment: ResidentApartment, plate = randomPlate()) {
  await page.getByLabel('License plate').fill(plate);
  await upload(page, 'card-plate-v1', photo('plate.png', [40, 60, 90]));
  if (apartment.hasRules) {
    await upload(page, 'card-registration-v1', photo('registration.png', [200, 190, 170]));
  } else {
    await expect(page.locator('#card-registration-v1')).toHaveCount(0);
  }
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Your vehicles' })).toBeVisible();
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
