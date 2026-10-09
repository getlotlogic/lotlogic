/**
 * Portal suite helpers (Task 30) — the N Style communication portal end to
 * end against a LOCAL backend. Never production: every helper here either
 * talks to `API_URL` (default http://localhost:8010) or runs `psql` against
 * `PORTAL_TEST_PG_URL`, the throwaway harness database printed by the
 * backend's `python -m tests.portal.cluster`. tests/README.md ("Portal
 * suite") has the full recipe.
 *
 * Gating: every portal spec calls `skipUnlessPortal()` first, so with
 * `PORTAL_E2E` unset the whole suite is reported as skipped, never failed —
 * which is what CI sees until Gabe flips the repository variable after the
 * backend deploys.
 *
 * The one deliberate direct-DB surface. The browser half of this suite never
 * reads or writes the database; the fixture does, for exactly the things a
 * browser cannot reach:
 *   - seeding N Style (`signup_slug='nstyle'`) on the seeded partner A row;
 *   - clearing `auth_throttle` so a run's signups do not trip the 5/h IP rule;
 *   - reading `outbound_notices` (the captured mail — `mailbox()`), since the
 *     local backend has no SendGrid key and sends nothing;
 *   - marking a `tow_request_deliveries` row sent (`markDeliveriesSent`) —
 *     the local `dispatch_now` cannot reach SendGrid, so the row goes
 *     `failed`; the acceptance path flips it to `sent` to see the row's
 *     "Sent to N Style ✓" (documented in the report as the one place the
 *     end-to-end test touches the DB);
 *   - moving a verification code's clock (`email_verify_expires_at`,
 *     `email_verify_sent_at`) for the expired / cooldown sheet states.
 *
 * The verification code itself is never read from the DB (it is stored as a
 * hash): the backend is started with `SIGNUP_TEST_CODE=482190`, which
 * `services.email_verification.new_code` honours only under `DEBUG=true`.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';
import { routeSupabaseToHarness } from './postgrestShim';
import { isLoopbackUrl } from './portalGuard';
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

export const PORTAL_E2E = process.env.PORTAL_E2E === '1';
export const PORTAL_API_URL = (process.env.API_URL ?? 'http://localhost:8010').replace(/\/+$/, '');
export const PG_URL = process.env.PORTAL_TEST_PG_URL ?? '';
/** The `lotlogic-backend` worktree the local backend runs from (token minting). */
export const BACKEND_DIR = process.env.PORTAL_BACKEND_DIR ?? '';
/** `settings.signup_test_code` the local backend was started with. */
export const TEST_CODE = process.env.SIGNUP_TEST_CODE ?? '482190';
export const PARTNER_SLUG = 'nstyle';
export const PARTNER_NAME = 'N Style';
export const PRODUCTION_API = 'https://lotlogic-backend-production.up.railway.app';

/** Call at the top of every portal `describe`. */
export function skipUnlessPortal() {
  test.skip(!PORTAL_E2E, 'portal suite: set PORTAL_E2E=1 with a local backend (tests/README.md, "Portal suite")');
  test.skip(PORTAL_E2E && !PG_URL, 'portal suite: PORTAL_TEST_PG_URL is required (the harness DB from tests.portal.cluster)');
  // Both the API the browser drives and the DB `sql()` writes must be on
  // this machine (fixtures/portalGuard.ts) — never production, never a
  // remote database a mistyped env var points at.
  test.skip(PORTAL_E2E && !isLoopbackUrl(PORTAL_API_URL), 'portal suite: API_URL must be a loopback backend, never production');
  test.skip(PORTAL_E2E && !!PG_URL && !isLoopbackUrl(PG_URL), 'portal suite: PORTAL_TEST_PG_URL must be a loopback harness database');
}

// ── the frontend under test ────────────────────────────────────────────────
/** The branch's build, served once for the whole run by
 *  `fixtures/portalGlobalSetup.ts` on the origin the local backend's CORS
 *  allow-list names. `/join/nstyle`, `/app?…` and `/r/<token>` are the real
 *  routes there (`vercel.json` rewrites). */
export function frontendOrigin(): string {
  const o = process.env.PORTAL_FRONTEND_ORIGIN;
  if (!o) throw new Error('PORTAL_FRONTEND_ORIGIN unset — the portal global setup did not run (PORTAL_E2E=1?)');
  return o;
}

/**
 * Point a browser context at the local backend before any page script runs:
 * the `lotlogic:e2e` flag plus `window.__LOTLOGIC_API__` (lib/e2e.js — the
 * override is refused on the production hostnames and without the flag).
 * Supabase never sees the request: the dashboard's PostgREST reads would
 * otherwise go to the production project with a locally signed JWT, so they
 * are answered from the harness DB under the token's own role and RLS
 * (`fixtures/postgrestShim.ts`). Google's reCAPTCHA / Maps scripts and Sentry
 * are aborted — the local backend runs with no reCAPTCHA secret (DEBUG skips
 * verification) and no Maps key is baked into the build.
 */
const pointed = new WeakSet<BrowserContext | Page>();
export async function pointAtLocalBackend(target: BrowserContext | Page, apiUrl = PORTAL_API_URL) {
  // Idempotent per page/context: a describe's beforeEach and `loginAs` may
  // both call this; a second set of init scripts and routes adds nothing.
  if (pointed.has(target)) return;
  pointed.add(target);
  await target.setExtraHTTPHeaders({ 'x-forwarded-for': fakeClientIp() });
  await target.addInitScript((api) => {
    try { localStorage.setItem('lotlogic:e2e', '1'); } catch { /* blocked storage */ }
    (window as unknown as { __LOTLOGIC_API__: string }).__LOTLOGIC_API__ = api;
  }, apiUrl);
  await routeSupabaseToHarness(target, PG_URL);
  // Static pages that carry their own literal backend origin
  // (`set-password.html`'s `const API = …`) would otherwise post a reset
  // token to production. Proxy that host to the local backend instead; a
  // test browser never reaches the production API.
  await target.route((url) => url.origin === PRODUCTION_API, async (route) => {
    const req = route.request();
    const cors = {
      'access-control-allow-origin': req.headers()['origin'] ?? '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
    };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const local = req.url().replace(PRODUCTION_API, apiUrl);
    const res = await route.fetch({ url: local });
    return route.fulfill({ response: res, headers: { ...res.headers(), ...cors } });
  });
  await target.route(/google\.com\/recaptcha|gstatic\.com\/recaptcha|maps\.googleapis\.com|sentry/, (r) => r.abort());
}

export async function portalContext(browser: Browser, opts: Parameters<Browser['newContext']>[0] = {}) {
  const context = await browser.newContext(opts);
  await pointAtLocalBackend(context);
  return context;
}

// ── psql ───────────────────────────────────────────────────────────────────
/** SQL string literal. Test values only — never user input. */
export function lit(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** Run SQL against the harness DB; returns rows as arrays of strings. */
export function sql(query: string): string[][] {
  if (!PG_URL) throw new Error('PORTAL_TEST_PG_URL is not set');
  if (!isLoopbackUrl(PG_URL)) throw new Error('PORTAL_TEST_PG_URL is not a loopback database; the portal fixture refuses to write to it');
  const out = execFileSync('psql', [PG_URL, '-X', '-q', '-At', '-F', '\t', '-v', 'ON_ERROR_STOP=1', '-c', query], {
    encoding: 'utf8',
  });
  return out.split('\n').filter((l) => l.length > 0).map((l) => l.split('\t'));
}

export function sqlValue(query: string): string | null {
  const rows = sql(query);
  return rows.length ? rows[0][0] : null;
}

/**
 * A fake client address, one /24 per caller. The backend throttles by the
 * first `X-Forwarded-For` hop (Railway's edge sets it), and two rules count
 * per IP or per /24 (`signup_ip` 5/h, `pending_property_slash24` 3/day). Every
 * spec signs up from 127.0.0.1, in parallel, so each page and each API signup
 * presents its own 10.x.y.0/24 — the rules stay on, they just stop counting
 * unrelated tests as one burst.
 */
export function fakeClientIp(): string {
  return `10.${crypto.randomInt(256)}.${crypto.randomInt(256)}.${1 + crypto.randomInt(250)}`;
}

/** Clears the signup / login throttle windows — every spec signs up fresh
 *  accounts from 127.0.0.1, and `signup_ip` is 5 an hour. */
export function resetThrottle() {
  sql('DELETE FROM public.auth_throttle');
}

/**
 * N Style as the signup partner: the seeded partner A row (`npm run seed`)
 * gets `signup_slug='nstyle'`, signup on, the company name and a phone. One
 * partner both receives the signups and signs in to Lookup / Requests, so
 * the acceptance path's "sign in as partner A" is N Style's own view.
 */
export function seedNStyle(): { partnerId: string; email: string; password: string } {
  const email = process.env.TEST_PARTNER_A_EMAIL ?? '';
  const password = process.env.TEST_PARTNER_A_PASSWORD ?? '';
  if (!email || !password) throw new Error('TEST_PARTNER_A_EMAIL / TEST_PARTNER_A_PASSWORD are required (npm run seed)');
  const id = sqlValue(`
    UPDATE public.enforcement_partners
       SET signup_slug = NULL
     WHERE signup_slug = ${lit(PARTNER_SLUG)} AND lower(email) <> lower(${lit(email)});
    UPDATE public.enforcement_partners
       SET signup_slug = ${lit(PARTNER_SLUG)}, signup_enabled = true, active = true,
           company_name = ${lit(PARTNER_NAME)}, phone = '7045550199'
     WHERE lower(email) = lower(${lit(email)})
    RETURNING id`);
  if (!id) throw new Error(`partner ${email} is not seeded — run \`npm run seed\` against ${PORTAL_API_URL}`);
  return { partnerId: id, email, password };
}

/**
 * Isolation for a fixed plate. Lookup's "All N Style properties" scope
 * answers across every property the partner has, so an earlier run's still
 * active hold on the same plate turns a single verdict into a grouped one.
 * Archives (as the backend's own `archived_at`, which the trust trigger
 * allows for the `postgres` role) every OTHER property of this partner that
 * has an active request on `plate`. Specs that run in parallel use random
 * plates (`randomPlate()`), so only fixed-plate callers ever need this.
 */
export function isolatePlate(partnerId: string, plate: string, keepPropertyId?: string) {
  sql(`UPDATE public.properties p SET archived_at = now()
        WHERE p.tow_company_id = ${lit(partnerId)} AND p.archived_at IS NULL
          AND (${lit(keepPropertyId ?? null)}::uuid IS NULL OR p.id <> ${lit(keepPropertyId ?? null)}::uuid)
          AND EXISTS (SELECT 1 FROM public.tow_requests r
                       WHERE r.property_id = p.id AND r.status = 'active'
                         AND r.normalized_plate = upper(regexp_replace(${lit(plate)}, '[^A-Za-z0-9]', '', 'g')))`);
}

/**
 * Run hygiene for a reused harness DB (called once by the global setup):
 * archive the properties earlier runs' throwaway signups created
 * (`pw-signup-*@e2e.lotlogic.dev` owners, created before this run started).
 * The seeded owner A / B and partner accounts are never touched. A no-op on a
 * fresh harness such as CI's.
 */
export function archiveEarlierRuns() {
  if (!PG_URL || !isLoopbackUrl(PG_URL)) return;
  sql(`UPDATE public.properties p SET archived_at = now()
         FROM public.lot_owners o
        WHERE o.id = p.owner_id AND o.email LIKE 'pw-signup-%@e2e.lotlogic.dev'
          AND p.archived_at IS NULL AND p.created_at < now()`);
}

/** A plate no other spec in the run is using. */
export function randomPlate(): string {
  const letters = 'ABCDEFGHJKLMNPRSTUVWXYZ';
  const pick = () => letters[crypto.randomInt(letters.length)];
  return `${pick()}${pick()}${pick()}${crypto.randomInt(1000, 9999)}`;
}

// ── accounts ───────────────────────────────────────────────────────────────
export interface SignupInput {
  slug?: string;
  name: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  contact: string;
  role: string;
  email: string;
  phone: string;
  password: string;
}

/** A unique, obviously fake signup. `e2e.lotlogic.dev` — the backend's
 *  email validator refuses the reserved `.test` TLD. */
export function newSignup(overrides: Partial<SignupInput> = {}): SignupInput {
  const tag = crypto.randomBytes(4).toString('hex');
  return {
    slug: PARTNER_SLUG,
    name: `Sunset Ridge ${tag}`,
    address: `${100 + (parseInt(tag.slice(0, 4), 16) % 8000)} Portal Test St`,
    city: 'Charlotte',
    state: 'NC',
    zip: '28205',
    contact: 'Dana Ortiz',
    role: 'Property manager',
    email: `pw-signup-${tag}@e2e.lotlogic.dev`,
    phone: '(704) 555-0123',
    password: 'twelve chars ok',
    ...overrides,
  };
}

/** Fill the seven `/join/<slug>` fields (manual address entry — no Maps key
 *  is baked into the local build). Does not submit. */
export async function fillSignup(page: Page, s: SignupInput) {
  await page.locator('#signup-name').fill(s.name);
  await page.locator('#signup-address').fill(s.address);
  await page.locator('input[placeholder="City"]').fill(s.city);
  await page.locator('.signup-state').fill(s.state);
  await page.locator('input[placeholder="ZIP"]').fill(s.zip);
  await page.locator('#signup-contact').fill(s.contact);
  await page.getByRole('radio', { name: s.role }).click();
  await page.locator('#signup-email').fill(s.email);
  await page.locator('#signup-phone').fill(s.phone);
  await page.locator('#signup-password').fill(s.password);
}

/** Open `/join/<slug>`, fill, Create account, land on `/app`. */
export async function signupProperty(page: Page, origin: string, s: SignupInput = newSignup()) {
  resetThrottle();
  await page.goto(`${origin}/join/${s.slug ?? PARTNER_SLUG}`);
  await expect(page.locator('#signup-name')).toBeVisible({ timeout: 20_000 });
  await fillSignup(page, s);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/app(\?|$)/, { timeout: 20_000 });
  return s;
}

/** `POST /auth/signup` straight to the local backend (no browser) — for
 *  specs whose subject is not the signup form. Returns the login payload
 *  (`token`, `property_id`, …). */
export async function apiSignup(s: SignupInput = newSignup()): Promise<{ token: string; property_id: string; signup: SignupInput; body: any }> {
  resetThrottle();
  const body = {
    slug: s.slug ?? PARTNER_SLUG,
    recaptcha_token: null,
    client_tz: 'America/New_York',
    account: {
      contact_name: s.contact, email: s.email, phone: s.phone.replace(/\D/g, ''),
      position: s.role, password: s.password,
    },
    property: {
      name: s.name, address_line1: s.address, city: s.city, state: s.state, postal_code: s.zip,
    },
  };
  const r = await api('POST', '/auth/signup', null, body);
  if (r.status !== 201 && r.status !== 200) throw new Error(`signup ${s.email}: ${r.status} ${JSON.stringify(r.body)}`);
  return { token: r.body.token, property_id: r.body.property_id, signup: s, body: r.body };
}

/** Confirm a self-serve account's email with the debug test code. */
export async function apiVerify(token: string) {
  const r = await api('POST', '/auth/verify-email', token, { code: TEST_CODE });
  if (r.status !== 200) throw new Error(`verify-email: ${r.status} ${JSON.stringify(r.body)}`);
}

/** The text the office composer and the T-1 h mail attach to a tow
 *  (RequestComposer.jsx `ATTESTATION`). */
export const TOW_ATTESTATION =
  'I am the owner or lessee of this parking area, or their authorized agent, ' +
  'and I am requesting in writing that this vehicle be removed.';

/** `POST /apartment/requests` as the office. */
export async function apiCreateRequest(token: string, body: Record<string, unknown>) {
  const r = await api('POST', '/apartment/requests', token, body);
  if (r.status !== 201) throw new Error(`create request: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.request ?? r.body;
}

/** N Style confirms a pending property (`POST /partner/properties/{id}/verify`). */
export async function apiConfirmProperty(partnerToken: string, propertyId: string) {
  const r = await api('POST', `/partner/properties/${propertyId}/verify`, partnerToken, {});
  if (r.status !== 200) throw new Error(`verify property: ${r.status} ${JSON.stringify(r.body)}`);
}

/** A self-serve office with a confirmed email, signed in on `page` at its
 *  property's Requests section. */
export async function officeOnRequests(page: Page, origin: string, opts: { confirmProperty?: boolean } = {}) {
  const acct = await apiSignup();
  await apiVerify(acct.token);
  if (opts.confirmProperty) {
    const p = seedNStyle();
    await apiConfirmProperty(await apiToken(p.email, p.password), acct.property_id);
  }
  await uiLogin(page, origin, acct.signup.email, acct.signup.password,
    `/app?property=${acct.property_id}&section=requests`);
  await expect(page.getByRole('textbox', { name: 'Plate' })).toBeVisible({ timeout: 15_000 });
  return acct;
}

/** API sign-in; returns the session token. */
export async function apiToken(email: string, password: string): Promise<string> {
  resetThrottle();
  const r = await fetch(`${PORTAL_API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(`login ${email}: ${r.status} ${await r.text()}`);
  return (await r.json()).token;
}

/** Sign in through the real login form. `path` may carry a deep link
 *  (`/app?property=…&section=requests`), which App.jsx applies once the
 *  session exists. */
export async function uiLogin(page: Page, origin: string, email: string, password: string, path = '/app') {
  resetThrottle();
  await page.goto(`${origin}${path}`);
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
}

export async function api(method: string, p: string, token: string | null, body?: unknown, ip = fakeClientIp()) {
  const r = await fetch(`${PORTAL_API_URL}${p}`, {
    method,
    headers: {
      'x-forwarded-for': ip,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json: any = null;
  try { json = await r.json(); } catch { /* empty */ }
  return { status: r.status, body: json };
}

export function accountId(email: string): string {
  const id = sqlValue(`SELECT id FROM public.lot_owners WHERE lower(email) = lower(${lit(email)})`);
  if (!id) throw new Error(`no lot_owners row for ${email}`);
  return id;
}

/** The (single) property a fresh self-serve account owns. */
export function propertyOf(email: string): { id: string; status: string } {
  const row = sql(`
    SELECT p.id, p.verification_status FROM public.properties p
      JOIN public.property_members pm ON pm.property_id = p.id
      JOIN public.lot_owners lo ON lo.id = pm.account_id
     WHERE lower(lo.email) = lower(${lit(email)})
     ORDER BY p.created_at DESC LIMIT 1`)[0];
  if (!row) throw new Error(`no property for ${email}`);
  return { id: row[0], status: row[1] };
}

// ── mail and deliveries ────────────────────────────────────────────────────
export interface CapturedMail { kind: string; subject: string; html: string; status: string; created_at: string }

/** Captured mail: `outbound_notices` rows addressed to `email`, newest first. */
export function mailbox(email: string): CapturedMail[] {
  return sql(`
    SELECT kind, subject, replace(replace(html, E'\\t', ' '), E'\\n', ' '), status, created_at
      FROM public.outbound_notices
     WHERE lower(${lit(email)}) = ANY (SELECT lower(r) FROM unnest(recipients) r)
     ORDER BY created_at DESC`).map(([kind, subject, html, status, created_at]) => ({ kind, subject, html, status, created_at }));
}

export function deliveries(requestId: string): { event: string; channel: string; status: string }[] {
  return sql(`SELECT event, channel, status FROM public.tow_request_deliveries
               WHERE request_id = ${lit(requestId)} ORDER BY id`)
    .map(([event, channel, status]) => ({ event, channel, status }));
}

/** The local backend has no SendGrid key, so `dispatch_now` leaves every
 *  partner email `failed` (or `queued`). Flip this request's deliveries to
 *  `sent` — the state a real send leaves behind. */
export function markDeliveriesSent(requestId: string) {
  sql(`UPDATE public.tow_request_deliveries
          SET status = 'sent', sent_at = now(), provider_id = 'e2e-fixture'
        WHERE request_id = ${lit(requestId)} AND status IN ('queued', 'failed')`);
}

export function latestRequest(propertyId: string): { id: string; ref: string; status: string; kind: string } | null {
  const row = sql(`SELECT id, ref_no, status, kind FROM public.tow_requests
                    WHERE property_id = ${lit(propertyId)} ORDER BY created_at DESC LIMIT 1`)[0];
  return row ? { id: row[0], ref: row[1], status: row[2], kind: row[3] } : null;
}

/** A one-tap email token (`/r/<token>`), minted by the backend's own
 *  `services.auth.issue_request_action_token` with the local backend's
 *  `JWT_SECRET` — the same function the T-1 h mail calls. */
export function mintActionToken(requestId: string, action: 'extend24' | 'ack_end' | 'reinstate'): string {
  if (!BACKEND_DIR) throw new Error('PORTAL_BACKEND_DIR (the lotlogic-backend worktree) is required to mint a token');
  const py = path.join(BACKEND_DIR, '.venv', 'bin', 'python');
  return execFileSync(py, ['-c',
    'import sys; from services.auth import issue_request_action_token as t; print(t(sys.argv[1], sys.argv[2]))',
    requestId, action], {
    cwd: BACKEND_DIR,
    encoding: 'utf8',
    env: {
      ...process.env,
      JWT_SECRET: process.env.PORTAL_JWT_SECRET ?? 'portal-test-secret',
      API_KEY: 'test',
      DATABASE_URL: 'postgresql+asyncpg://unused:unused@localhost/unused',
      TWILIO_ACCOUNT_SID: 'test', TWILIO_AUTH_TOKEN: 'test', TWILIO_FROM_NUMBER: '+15555555555',
      R2_ACCOUNT_ID: 'test', R2_ACCESS_KEY_ID: 'test', R2_SECRET_ACCESS_KEY: 'test',
      R2_PUBLIC_URL: 'https://test.invalid', ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    },
  }).trim();
}

export { test, expect };
