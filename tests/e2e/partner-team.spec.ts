/**
 * The tow company's Team section (spec 2026-10-18-tow-company-team §1.3,
 * §1.4, §4) on THIS branch's local build, signed in through the real login
 * page. Every backend and Supabase call is answered by `page.route` from the
 * §1.3 contract (task T1 builds the real routes in parallel); nothing leaves
 * the machine — anything not stubbed is aborted, and the Supabase realtime
 * socket is mocked, never connected.
 *
 * What it pins down:
 *   - a partner Admin sees the roster with "Admin" / "Truck", the phone and
 *     the "last signed in …" / "Set-up link not used yet" line;
 *   - the header carries the member's own name, the Organization row the
 *     company's (and keeps it once the plates/fees enrichment lands);
 *   - Add a teammate posts `{name, email, phone, role}` and toasts;
 *   - a 409 `email_in_use` reads "That email already has a LotLogic login.";
 *   - the last Admin's role is locked, with the spec's reason;
 *   - Remove access asks with the spec's sentence, then DELETEs;
 *   - Resend set-up link POSTs …/resend;
 *   - a Dispatch member sees the roster read-only, no Add a teammate;
 *   - an owner's Account has no company Team section and never asks for one;
 *   - axe finds nothing serious or critical in the section, in either theme.
 *
 * P2 (spec §2.2, §2.3, §4 — task U1 builds the routes in parallel):
 *   - an Admin sees "All properties" on their own row and a checklist on a
 *     Truck's; "No properties yet" for a Truck with none;
 *   - Save PUTs `{property_ids}` and toasts; a 422 `unknown_property` reads
 *     as the reload sentence; a Dispatch member sees the checklist too;
 *   - a Truck gets Lookup · Requests · Account (no Lots, no Activity), lands
 *     on Requests even from a remembered Activity tab, never reads PostgREST,
 *     picks only their properties, reads "Checked at your 2 properties" under
 *     a Lookup verdict, and sees the roster read-only;
 *   - a Truck with no property reads "Ask {Admin name} to assign you a
 *     property." on Requests and Lookup ("your Admin" when none is named).
 *
 * Run: cd tests && npx playwright test e2e/partner-team
 */
import path from 'node:path';
import { test, expect, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { buildAndServeFrontend } from '../fixtures/buildAndServeFrontend';

const FRONTEND_DIR = path.resolve(__dirname, '../../frontend');
const BACKEND = 'https://lotlogic-backend-production.up.railway.app';
const SUPABASE = 'https://nzdkoouoaedbbccraoti.supabase.co';

let server: Awaited<ReturnType<typeof buildAndServeFrontend>>;
test.beforeAll(async () => { server = await buildAndServeFrontend(FRONTEND_DIR); });
test.afterAll(async () => { await server.close(); });

const COMPANY_ID = '22222222-2222-4222-8222-222222222222';
const COMPANY = 'Queen City Towing';
const DANA_ID = '33333333-3333-4333-8333-333333333331';
const SAM_ID = '33333333-3333-4333-8333-333333333332';
const TERRY_ID = '33333333-3333-4333-8333-333333333333';
const OWNER_ID = '44444444-4444-4444-8444-444444444444';
const PROPERTY_ID = '55555555-5555-4555-8555-555555555555';
// The company's two live properties (`/auth/me.properties` for an Admin or
// Dispatch: every one; for a Truck: their assignment).
const OAK_ID = '66666666-6666-4666-8666-666666666661';
const SPRING_ID = '66666666-6666-4666-8666-666666666662';
const OAK = { id: OAK_ID, name: 'Oak Hill Commons' };
const SPRING = { id: SPRING_ID, name: 'Spring Lake Apartments' };
const COMPANY_PROPERTIES = [OAK, SPRING];
// Also in an Admin's /auth/me.properties in one test, never assignable.
const PLAZA_ID = '66666666-6666-4666-8666-666666666663';
const REJECTED_ID = '66666666-6666-4666-8666-666666666664';
const asMeProperty = (p: { id: string; name: string }) => ({
  ...p, address: '1 Main St', role: 'partner', property_type: 'apartment', verification_status: 'verified',
  features: { passes: true, qr: true, cameras: false },
});
const FAKE_TOKEN = 'fake.jwt.for-test';

type MemberRole = 'admin' | 'dispatcher' | 'driver';

type Prop = { id: string; name: string };

/**
 * Three members: Dana (the signed-in Admin, or Dispatch), a Truck who has not
 * set a password and has no property yet (Sam), and a Truck with an
 * assignment (Terry — the one signed in when the session is a Truck's).
 */
function roster(danaRole: MemberRole = 'admin', terryProperties: Prop[] = [OAK]) {
  return {
    members: [
      {
        id: DANA_ID, name: 'Dana Reyes', email: 'dana@queencitytow.test', phone: '+17045550101',
        role: danaRole, last_login_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
        has_password: true, slack_linked: false, properties: [],
      },
      {
        id: SAM_ID, name: 'Sam Ortiz', email: 'sam@queencitytow.test', phone: null,
        role: 'driver', last_login_at: null, has_password: false, slack_linked: false, properties: [],
      },
      {
        id: TERRY_ID, name: 'Terry Banks', email: 'terry@queencitytow.test', phone: '+17045550103',
        role: 'driver', last_login_at: new Date(Date.now() - 26 * 3600_000).toISOString(),
        has_password: true, slack_linked: false, properties: terryProperties,
      },
    ],
  };
}

interface Seen {
  invites: unknown[];
  patches: Array<{ id: string; body: unknown }>;
  deletes: string[];
  resends: string[];
  teamGets: number;
  /** How many times the page asked for `GET /auth/me`. */
  meGets: number;
  assigns: Array<{ id: string; body: unknown; query: string }>;
  /** Every PostgREST path the page asked for (`/rest/v1/...`). */
  rest: string[];
}

interface StubOpts {
  account: 'partner' | 'owner';
  memberRole?: MemberRole;
  /** What `POST /partner/team/invite` answers. */
  invite?: { status: number; detail?: string };
  /** The post-login `enforcement_partners` Supabase read, answered after this many ms. */
  partnerRowDelayMs?: number;
  /** What `PUT /partner/team/{id}/properties` answers. */
  assign?: { status: number; detail?: string };
  /** A Truck session: their `/auth/me.properties` (and Terry's roster row). */
  truckProperties?: Prop[];
  /** A Truck session: `/auth/me.member.admin_names`. */
  adminNames?: string[];
  /** What `GET /partner/team` answers instead of the roster (404: a backend without the route). */
  teamStatus?: number;
  /** What `GET /auth/me` answers instead of its body (an outage). */
  meStatus?: number;
  /** An Admin or Dispatch session: rows added to `/auth/me.properties` as given. */
  meExtraProperties?: Array<Record<string, unknown>>;
}

const json = (route: Route, status: number, body: unknown) => route.fulfill({
  status,
  contentType: 'application/json',
  headers: { 'access-control-allow-origin': '*' },
  body: JSON.stringify(body),
});

async function stub(page: Page, opts: StubOpts): Promise<Seen> {
  const seen: Seen = { invites: [], patches: [], deletes: [], resends: [], teamGets: 0, meGets: 0, assigns: [], rest: [] };
  const memberRole = opts.memberRole ?? 'admin';
  const partner = opts.account === 'partner';
  // A Truck session is Terry's; Dana stays the company's Admin.
  const truck = memberRole === 'driver';
  const truckProperties = opts.truckProperties ?? COMPANY_PROPERTIES;
  const me = truck
    ? { id: TERRY_ID, name: 'Terry Banks', email: 'terry@queencitytow.test' }
    : { id: DANA_ID, name: 'Dana Reyes', email: 'dana@queencitytow.test' };
  const team = () => (truck ? roster('admin', truckProperties) : roster(memberRole));

  // Lowest priority (registered first): nothing but the local build may load.
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    return url.origin === server.origin ? route.continue() : route.abort();
  });
  // Realtime: mocked in the page, never connected to the real project.
  await page.routeWebSocket(/supabase\.co/, () => {});

  await page.route(`${SUPABASE}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/rest/v1/')) seen.rest.push(url.pathname);
    if (url.pathname === '/rest/v1/enforcement_partners' && partner && opts.partnerRowDelayMs !== undefined) {
      await new Promise((r) => setTimeout(r, opts.partnerRowDelayMs));
      return json(route, 200, { tow_fee: 250, boot_fee: 0, tow_truck_plates: ['QCT100'] });
    }
    return json(route, 200, []);
  });

  await page.route(`${BACKEND}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const m = req.method();
    if (m === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': '*',
          'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
        },
      });
    }
    if (m === 'POST' && p === '/auth/login') {
      return json(route, 200, {
        token: FAKE_TOKEN,
        expires_in: 604800,
        subject: partner
          ? {
            type: 'partner', id: COMPANY_ID, email: me.email, display_name: me.name,
            member_id: me.id, member_role: memberRole, is_admin: false, is_platform_admin: false,
          }
          : {
            type: 'owner', id: OWNER_ID, email: 'office@springlake.test', display_name: 'Spring Lake Apartments',
            is_admin: false, is_platform_admin: false,
          },
      });
    }
    if (m === 'GET' && p === '/auth/me') {
      seen.meGets += 1;
      if (opts.meStatus) return json(route, opts.meStatus, { detail: 'unavailable' });
      return json(route, 200, partner
        ? {
          type: 'partner', id: COMPANY_ID, email: me.email, display_name: COMPANY,
          company_name: COMPANY, phone: '+17045550100', is_admin: false, is_platform_admin: false,
          pending_joins: 0, pending_properties: 0, lots: [],
          properties: truck
            ? truckProperties.map(asMeProperty)
            : [...COMPANY_PROPERTIES.map(asMeProperty), ...(opts.meExtraProperties ?? [])],
          member: truck
            ? { id: me.id, name: me.name, role: memberRole, properties: truckProperties, admin_names: opts.adminNames ?? ['Dana Reyes'] }
            : { id: me.id, name: me.name, role: memberRole, properties: [], admin_names: ['Dana Reyes'] },
        }
        : {
          type: 'owner', id: OWNER_ID, email: 'office@springlake.test', display_name: 'Spring Lake Apartments',
          contact_name: 'Pat Lee', business_name: 'Spring Lake Apartments', email_verified: true,
          signup_source: 'legacy', is_admin: false, is_platform_admin: false, lots: [],
          properties: [{
            id: PROPERTY_ID, name: 'Spring Lake Apartments', address: '100 Lake Rd', property_type: 'apartment',
            verification_status: 'verified', role: 'admin', member_status: 'active',
            features: { passes: true, qr: true, cameras: false },
          }],
          rejected_properties: [],
        });
    }
    if (m === 'GET' && p === '/partner/team') {
      seen.teamGets += 1;
      if (opts.teamStatus) return json(route, opts.teamStatus, { detail: 'not_found' });
      return json(route, 200, team());
    }
    const props = p.match(/^\/partner\/team\/([^/]+)\/properties$/);
    if (props && m === 'PUT') {
      const id = decodeURIComponent(props[1]);
      const body = req.postDataJSON() as { property_ids: string[] };
      seen.assigns.push({ id, body, query: url.search });
      const answer = opts.assign ?? { status: 200 };
      if (answer.status >= 400) return json(route, answer.status, { detail: answer.detail });
      const member = team().members.find((x) => x.id === id);
      return json(route, 200, {
        member: { ...member, properties: COMPANY_PROPERTIES.filter((x) => body.property_ids.includes(x.id)) },
      });
    }
    // The Requests tab's list: nothing active.
    if (m === 'GET' && p === '/apartment/requests') return json(route, 200, { items: [] });
    // The Lookup "All properties" check: a Truck's verdict says how many
    // properties it covered (spec §2.2).
    if (m === 'GET' && p === '/partner/lookup') {
      return json(route, 200, {
        verdict: 'not_registered', matches: [],
        ...(truck ? { scope: { property_count: truckProperties.length } } : {}),
      });
    }
    if (m === 'POST' && p === '/partner/team/invite') {
      const body = req.postDataJSON();
      seen.invites.push(body);
      const answer = opts.invite ?? { status: 201 };
      if (answer.status >= 400) return json(route, answer.status, { detail: answer.detail });
      return json(route, 201, { member: { id: 'new', ...body, has_password: false, last_login_at: null } });
    }
    const one = p.match(/^\/partner\/team\/([^/]+)(\/resend)?$/);
    if (one && m === 'PATCH') {
      seen.patches.push({ id: decodeURIComponent(one[1]), body: req.postDataJSON() });
      return json(route, 200, { ok: true });
    }
    if (one && m === 'DELETE') {
      seen.deletes.push(decodeURIComponent(one[1]));
      return json(route, 200, { ok: true });
    }
    if (one && one[2] && m === 'POST') {
      seen.resends.push(decodeURIComponent(one[1]));
      return json(route, 200, { ok: true });
    }
    if (m === 'GET' && /^\/properties\/[^/]+\/members$/.test(p)) return json(route, 200, { members: [] });
    // Everything else this spec has no opinion about (Slack status, the
    // Requests list, …) is a route this backend "has not shipped".
    return json(route, 404, { detail: 'not_found' });
  });
  return seen;
}

async function signIn(page: Page, email: string) {
  await page.goto(`${server.origin}/app`);
  await page.locator('#login-email').fill(email);
  await page.locator('#login-password').fill('correct horse battery staple');
  await page.getByRole('button', { name: /sign in/i }).click();
}

async function openAccount(page: Page) {
  await page.getByRole('tab', { name: 'Account' }).first().click();
}

const team = (page: Page) => page.locator('#team-section');
const memberRow = (page: Page, name: string) => team(page).getByTestId('team-member').filter({ hasText: name });

test.describe('partner Team section', () => {
  test('an Admin sees the roster with the role labels, and the header says who is signed in', async ({ page }) => {
    const seen = await stub(page, { account: 'partner' });
    await signIn(page, 'dana@queencitytow.test');
    await expect(page.locator('.header-name')).toHaveText('Dana Reyes');
    await openAccount(page);

    await expect(team(page).getByText('Team', { exact: true })).toBeVisible();
    await expect(team(page).getByTestId('team-member')).toHaveCount(3);

    const dana = memberRow(page, 'Dana Reyes');
    await expect(dana.getByRole('combobox', { name: 'Role for Dana Reyes' })).toHaveValue('admin');
    await expect(dana.locator('option:checked')).toHaveText('Admin');
    await expect(dana).toContainText('(704) 555-0101');
    await expect(dana).toContainText(/last signed in \w{3} \d{1,2}:\d{2} (AM|PM)/);

    const sam = memberRow(page, 'Sam Ortiz');
    await expect(sam.getByRole('combobox', { name: 'Role for Sam Ortiz' })).toHaveValue('driver');
    await expect(sam.locator('option:checked')).toHaveText('Truck');
    await expect(sam).toContainText('Set-up link not used yet');

    // The person in the header and on the profile card; the company where
    // the company is meant.
    const org = page.locator('.settings-row').filter({ hasText: 'Organization' });
    await expect(org.locator('.settings-row-value')).toHaveText(COMPANY);
    // The word the copy rule bans never reaches the screen.
    await expect(page.locator('body')).not.toContainText(/\bdriver\b/i);
    expect(seen.teamGets).toBeGreaterThanOrEqual(1);
  });

  test('the company name survives the plates/fees read that lands after /auth/me', async ({ page }) => {
    await stub(page, { account: 'partner', partnerRowDelayMs: 1500 });
    await signIn(page, 'dana@queencitytow.test');
    await openAccount(page);
    // The plate is the late read's own field: once it is on screen, the
    // enrichment has replaced the session.
    await expect(page.getByText('QCT100')).toBeVisible({ timeout: 10_000 });
    const org = page.locator('.settings-row').filter({ hasText: 'Organization' });
    await expect(org.locator('.settings-row-value')).toHaveText(COMPANY);
    await expect(page.locator('.header-name')).toHaveText('Dana Reyes');
  });

  test('Add a teammate posts the body and shows the toast', async ({ page }) => {
    const seen = await stub(page, { account: 'partner' });
    await signIn(page, 'dana@queencitytow.test');
    await openAccount(page);

    await team(page).getByRole('button', { name: 'Add a teammate' }).click();
    const form = team(page).getByRole('form', { name: 'Add a teammate' });
    await form.getByLabel('Name').fill('  Lee Park ');
    await form.getByLabel('Email').fill('Lee@QueenCityTow.test');
    await form.getByLabel('Phone (optional)').fill('(704) 555-0142');
    await form.getByLabel('Dispatch').check();
    const gets = seen.teamGets;
    await form.getByRole('button', { name: 'Send invite' }).click();

    await expect.poll(() => seen.invites.length).toBe(1);
    expect(seen.invites[0]).toEqual({ name: 'Lee Park', email: 'lee@queencitytow.test', phone: '+17045550142', role: 'dispatcher' });
    await expect(page.locator('.toast.success')).toHaveText('Invite sent to lee@queencitytow.test');
    await expect(form).toHaveCount(0);
    await expect.poll(() => seen.teamGets).toBeGreaterThan(gets);
  });

  test('a form with no role is stopped before it is sent', async ({ page }) => {
    const seen = await stub(page, { account: 'partner' });
    await signIn(page, 'dana@queencitytow.test');
    await openAccount(page);

    await team(page).getByRole('button', { name: 'Add a teammate' }).click();
    const form = team(page).getByRole('form', { name: 'Add a teammate' });
    await form.getByLabel('Name').fill('Lee Park');
    await form.getByLabel('Email').fill('lee@queencitytow.test');
    await form.getByRole('button', { name: 'Send invite' }).click();
    await expect(form.getByRole('alert')).toHaveText('Pick a role: Admin, Dispatch or Truck.');
    expect(seen.invites).toEqual([]);
  });

  test('a 409 email_in_use reads as a sentence', async ({ page }) => {
    const seen = await stub(page, { account: 'partner', invite: { status: 409, detail: 'email_in_use' } });
    await signIn(page, 'dana@queencitytow.test');
    await openAccount(page);

    await team(page).getByRole('button', { name: 'Add a teammate' }).click();
    const form = team(page).getByRole('form', { name: 'Add a teammate' });
    await form.getByLabel('Name').fill('Pat Lee');
    await form.getByLabel('Email').fill('office@springlake.test');
    await form.getByLabel('Truck').check();
    await form.getByRole('button', { name: 'Send invite' }).click();

    await expect(form.getByRole('alert')).toHaveText('That email already has a LotLogic login.');
    await expect(form).toBeVisible();
    expect(seen.invites).toEqual([{ name: 'Pat Lee', email: 'office@springlake.test', role: 'driver' }]);
    await expect(page.locator('body')).not.toContainText('email_in_use');
  });

  test("the last Admin's role is locked with the reason; another member's role changes", async ({ page }) => {
    const seen = await stub(page, { account: 'partner' });
    await signIn(page, 'dana@queencitytow.test');
    await openAccount(page);

    const dana = memberRow(page, 'Dana Reyes');
    await expect(dana.getByRole('combobox', { name: 'Role for Dana Reyes' })).toBeDisabled();
    await expect(dana).toContainText('Add another Admin before changing this one.');
    // Never offered the way out of their own access.
    await expect(dana.getByRole('button', { name: 'Remove access' })).toHaveCount(0);

    const sam = memberRow(page, 'Sam Ortiz');
    await expect(sam).not.toContainText('Add another Admin before changing this one.');
    await sam.getByRole('combobox', { name: 'Role for Sam Ortiz' }).selectOption('dispatcher');
    await expect.poll(() => seen.patches).toEqual([{ id: SAM_ID, body: { role: 'dispatcher' } }]);
    await expect(page.locator('.toast.success')).toHaveText('Sam Ortiz is now Dispatch');
  });

  test('Remove access asks with the spec sentence, then removes', async ({ page }) => {
    const seen = await stub(page, { account: 'partner' });
    await signIn(page, 'dana@queencitytow.test');
    await openAccount(page);

    let asked = '';
    page.once('dialog', (d) => { asked = d.message(); void d.accept(); });
    await memberRow(page, 'Sam Ortiz').getByRole('button', { name: 'Remove access' }).click();
    await expect.poll(() => seen.deletes).toEqual([SAM_ID]);
    expect(asked).toBe('Sam Ortiz will lose access to Queen City Towing on LotLogic. Their past requests stay on the record.');
    await expect(memberRow(page, 'Sam Ortiz')).toHaveCount(0);
  });

  test('a dismissed Remove access sends nothing', async ({ page }) => {
    const seen = await stub(page, { account: 'partner' });
    await signIn(page, 'dana@queencitytow.test');
    await openAccount(page);

    page.once('dialog', (d) => { void d.dismiss(); });
    await memberRow(page, 'Sam Ortiz').getByRole('button', { name: 'Remove access' }).click();
    await expect(memberRow(page, 'Sam Ortiz')).toHaveCount(1);
    expect(seen.deletes).toEqual([]);
  });

  test('Resend set-up link is offered for a member with no password, and sends', async ({ page }) => {
    const seen = await stub(page, { account: 'partner' });
    await signIn(page, 'dana@queencitytow.test');
    await openAccount(page);

    await expect(memberRow(page, 'Dana Reyes').getByRole('button', { name: 'Resend set-up link' })).toHaveCount(0);
    await memberRow(page, 'Sam Ortiz').getByRole('button', { name: 'Resend set-up link' }).click();
    await expect.poll(() => seen.resends).toEqual([SAM_ID]);
    await expect(page.locator('.toast.success')).toHaveText('Set-up link sent to sam@queencitytow.test');
  });

  test('a Dispatch member sees the roster read-only and no Add a teammate', async ({ page }) => {
    await stub(page, { account: 'partner', memberRole: 'dispatcher' });
    await signIn(page, 'dana@queencitytow.test');
    await openAccount(page);

    await expect(team(page).getByTestId('team-member')).toHaveCount(3);
    await expect(memberRow(page, 'Dana Reyes').locator('.settings-row-value')).toHaveText('Dispatch');
    await expect(memberRow(page, 'Sam Ortiz').locator('.settings-row-value')).toHaveText('Truck');
    await expect(team(page).getByRole('button', { name: 'Add a teammate' })).toHaveCount(0);
    await expect(team(page).getByRole('combobox')).toHaveCount(0);
    await expect(team(page).getByRole('button', { name: 'Remove access' })).toHaveCount(0);
    await expect(team(page).getByRole('button', { name: 'Resend set-up link' })).toHaveCount(0);
  });

  for (const theme of ['light', 'dark']) {
    test(`axe: nothing serious or critical in the section (${theme} theme, form open, an error showing)`, async ({ page }) => {
      await page.addInitScript((t) => { try { localStorage.setItem('lotlogic_theme', t); } catch { /* blocked */ } }, theme);
      await stub(page, { account: 'partner', invite: { status: 409, detail: 'email_in_use' } });
      await signIn(page, 'dana@queencitytow.test');
      await openAccount(page);
      await team(page).getByRole('button', { name: 'Add a teammate' }).click();
      const form = team(page).getByRole('form', { name: 'Add a teammate' });
      await form.getByLabel('Name').fill('Pat Lee');
      await form.getByLabel('Email').fill('office@springlake.test');
      await form.getByLabel('Admin').check();
      await form.getByRole('button', { name: 'Send invite' }).click();
      await expect(form.getByRole('alert')).toBeVisible();

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .include('#team-section')
        .analyze();
      const blocking = results.violations.filter(v => ['serious', 'critical'].includes(v.impact ?? ''));
      expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
    });
  }

  test("an owner's Account has no company Team section, and never asks for one", async ({ page }) => {
    const seen = await stub(page, { account: 'owner' });
    await signIn(page, 'office@springlake.test');
    await expect(page.locator('.header-name')).toHaveText('Spring Lake Apartments');
    await openAccount(page);

    // The office's own per-property Team is unchanged …
    await expect(page.getByText('Who can authorize requests — Spring Lake Apartments')).toBeVisible();
    // … and the tow company's is absent.
    await expect(page.locator('#team-section')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add a teammate', exact: true })).toHaveCount(0);
    expect(seen.teamGets).toBe(0);
  });
});

// ── P2: assignments and scope ────────────────────────────────

const props = (page: Page, name: string) => memberRow(page, name).getByTestId('member-properties');

test.describe('partner Team: properties (P2)', () => {
  test('an Admin sees "All properties" on their own row and a checklist on a Truck\'s', async ({ page }) => {
    await stub(page, { account: 'partner' });
    await signIn(page, 'dana@queencitytow.test');
    await openAccount(page);

    await expect(props(page, 'Dana Reyes')).toHaveText('PropertiesAll properties');
    await expect(props(page, 'Dana Reyes').getByRole('checkbox')).toHaveCount(0);

    const terry = props(page, 'Terry Banks');
    await expect(terry.getByRole('checkbox')).toHaveCount(2);
    await expect(terry.getByRole('checkbox', { name: 'Oak Hill Commons' })).toBeChecked();
    await expect(terry.getByRole('checkbox', { name: 'Spring Lake Apartments' })).not.toBeChecked();
    await expect(terry.getByRole('button', { name: 'Save properties for Terry Banks' })).toBeDisabled();
    await expect(terry).not.toContainText('No properties yet');

    // A Truck with none: the amber line, and the same checklist, empty.
    const sam = props(page, 'Sam Ortiz');
    await expect(sam.getByText('No properties yet', { exact: true })).toBeVisible();
    await expect(sam.getByRole('checkbox', { checked: true })).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(/\bdriver\b/i);
  });

  test('Save posts {property_ids}, shows the toast and updates the row', async ({ page }) => {
    const seen = await stub(page, { account: 'partner' });
    await signIn(page, 'dana@queencitytow.test');
    await openAccount(page);

    const terry = props(page, 'Terry Banks');
    await terry.getByRole('checkbox', { name: 'Spring Lake Apartments' }).check();
    await terry.getByRole('button', { name: 'Save properties for Terry Banks' }).click();
    await expect.poll(() => seen.assigns).toEqual([{ id: TERRY_ID, body: { property_ids: [OAK_ID, SPRING_ID] }, query: '' }]);
    await expect(page.locator('.toast.success')).toHaveText('Properties saved for Terry Banks');
    await expect(terry.getByRole('checkbox', { name: 'Spring Lake Apartments' })).toBeChecked();
    await expect(terry.getByRole('button', { name: 'Save properties for Terry Banks' })).toBeDisabled();

    // The first property for a Truck with none: the amber line goes.
    const sam = props(page, 'Sam Ortiz');
    await sam.getByRole('checkbox', { name: 'Oak Hill Commons' }).check();
    await sam.getByRole('button', { name: 'Save properties for Sam Ortiz' }).click();
    await expect.poll(() => seen.assigns.length).toBe(2);
    expect(seen.assigns[1]).toEqual({ id: SAM_ID, body: { property_ids: [OAK_ID] }, query: '' });
    await expect(sam).not.toContainText('No properties yet');

    // Unassigning everything is a real save: an empty list, not nothing.
    await terry.getByRole('checkbox', { name: 'Oak Hill Commons' }).uncheck();
    await terry.getByRole('checkbox', { name: 'Spring Lake Apartments' }).uncheck();
    await terry.getByRole('button', { name: 'Save properties for Terry Banks' }).click();
    await expect.poll(() => seen.assigns.length).toBe(3);
    expect(seen.assigns[2]).toEqual({ id: TERRY_ID, body: { property_ids: [] }, query: '' });
    await expect(terry.getByText('No properties yet', { exact: true })).toBeVisible();
  });

  test('a 422 unknown_property reads as the reload sentence', async ({ page }) => {
    const seen = await stub(page, { account: 'partner', assign: { status: 422, detail: 'unknown_property' } });
    await signIn(page, 'dana@queencitytow.test');
    await openAccount(page);

    const terry = props(page, 'Terry Banks');
    await terry.getByRole('checkbox', { name: 'Spring Lake Apartments' }).check();
    await terry.getByRole('button', { name: 'Save properties for Terry Banks' }).click();
    await expect(terry.getByRole('alert')).toHaveText("One of those properties isn't yours any more. Reload and try again.");
    expect(seen.assigns).toHaveLength(1);
    await expect(page.locator('body')).not.toContainText('unknown_property');
    // Nothing was saved: the pick is still there to retry.
    await expect(terry.getByRole('checkbox', { name: 'Spring Lake Apartments' })).toBeChecked();
  });

  test('the checklist offers only the company\'s live properties: never a truck plaza or a rejected one', async ({ page }) => {
    // A partner's /auth/me.properties includes its truck plazas; the PUT
    // refuses one (422 unknown_property), so ticking it could never save.
    const seen = await stub(page, {
      account: 'partner',
      meExtraProperties: [
        { ...asMeProperty({ id: PLAZA_ID, name: 'I-85 Truck Plaza' }), property_type: 'truck_plaza' },
        { ...asMeProperty({ id: REJECTED_ID, name: 'Elm Court' }), verification_status: 'rejected' },
      ],
    });
    await signIn(page, 'dana@queencitytow.test');
    await openAccount(page);

    const terry = props(page, 'Terry Banks');
    await expect(terry.getByRole('checkbox')).toHaveCount(2);
    await expect(terry).not.toContainText('I-85 Truck Plaza');
    await expect(terry).not.toContainText('Elm Court');
    await terry.getByRole('checkbox', { name: 'Spring Lake Apartments' }).check();
    await terry.getByRole('button', { name: 'Save properties for Terry Banks' }).click();
    await expect.poll(() => seen.assigns).toEqual([{ id: TERRY_ID, body: { property_ids: [OAK_ID, SPRING_ID] }, query: '' }]);
  });

  test('a backend with no Team route: the section hides and never asks for the property list', async ({ page }) => {
    const seen = await stub(page, { account: 'partner', teamStatus: 404 });
    // Waits until no new /auth/me has arrived for a moment.
    const settle = async () => {
      let last = -1;
      while (seen.meGets !== last) { last = seen.meGets; await page.waitForTimeout(400); }
    };
    await signIn(page, 'dana@queencitytow.test');
    await expect(page.locator('.header-name')).toHaveText('Dana Reyes');
    await settle();
    const before = seen.meGets;

    await openAccount(page);
    await expect.poll(() => seen.teamGets).toBeGreaterThanOrEqual(1);
    await settle();
    await expect(page.locator('#team-section')).toHaveCount(0);
    expect(seen.meGets).toBe(before);
  });

  test('a Dispatch member sees the checklist too, and saves', async ({ page }) => {
    const seen = await stub(page, { account: 'partner', memberRole: 'dispatcher' });
    await signIn(page, 'dana@queencitytow.test');
    await openAccount(page);

    await expect(props(page, 'Dana Reyes')).toHaveText('PropertiesAll properties');
    const terry = props(page, 'Terry Banks');
    await expect(terry.getByRole('checkbox')).toHaveCount(2);
    await terry.getByRole('checkbox', { name: 'Spring Lake Apartments' }).check();
    await terry.getByRole('button', { name: 'Save properties for Terry Banks' }).click();
    await expect.poll(() => seen.assigns.map((a) => a.id)).toEqual([TERRY_ID]);
    await expect(page.locator('.toast.success')).toHaveText('Properties saved for Terry Banks');
    // Still no roster changes for Dispatch.
    await expect(team(page).getByRole('button', { name: 'Add a teammate' })).toHaveCount(0);
  });
});

/**
 * Records, from the first paint, whether a page a Truck must never reach was
 * ever on screen — even for one frame before App.jsx re-routes the tab. A
 * hidden nav button is not enough (spec §2.3): the render itself is guarded.
 * The markers are each page's own first-render text: Lots (ALPRPropertiesPage)
 * opens on "Loading properties..." (ASCII dots; Lookup's uses "…"), Activity
 * (OperatorActivityPage) on "Your Activity".
 */
async function watchForbiddenPages(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __forbiddenSeen: string[] };
    w.__forbiddenSeen = [];
    const markers: Array<[string, string]> = [['lots', 'Loading properties...'], ['activity', 'Your Activity']];
    const check = () => {
      const text = document.body ? document.body.textContent || '' : '';
      for (const [id, marker] of markers) {
        if (text.includes(marker) && !w.__forbiddenSeen.includes(id)) w.__forbiddenSeen.push(id);
      }
    };
    new MutationObserver(check).observe(document, { subtree: true, childList: true, characterData: true });
  });
}
const forbiddenSeen = (page: Page) => page.evaluate(() => (window as unknown as { __forbiddenSeen: string[] }).__forbiddenSeen);

test.describe('a Truck signed in (P2)', () => {
  const navTabs = (page: Page) => page.locator('.bottom-nav').getByRole('tab');

  test('Lookup · Requests · Account, landing on Requests, and no PostgREST read anywhere', async ({ page }) => {
    // A fresh device opens on the default tab, Lots — which a Truck may not
    // see, and whose page would read PostgREST if it rendered at all.
    await watchForbiddenPages(page);
    const seen = await stub(page, { account: 'partner', memberRole: 'driver' });
    await signIn(page, 'terry@queencitytow.test');

    await expect(page.locator('.header-name')).toHaveText('Terry Banks');
    await expect(navTabs(page)).toHaveText(['Lookup', 'Requests', 'Account']);
    await expect(page.getByRole('tab', { name: 'Lots' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Activity' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Requests' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: 'REQUESTS' })).toBeVisible();
    await expect(page.getByText('Nothing active.')).toBeVisible();

    // Lookup: only their properties, and the verdict says how many it covered.
    await page.getByRole('tab', { name: 'Lookup' }).click();
    const picker = page.locator('#lookup-scope');
    await expect(picker.locator('option')).toHaveText(['Oak Hill Commons', 'Spring Lake Apartments', 'All your properties']);
    await picker.selectOption('all');
    await page.locator('#lookup-plate').fill('ABC1234');
    await page.getByRole('button', { name: 'Check', exact: true }).click();
    await expect(page.getByTestId('lookup-scope-line')).toHaveText('Checked at your 2 properties');

    // Account: the roster read-only, their own properties named, no company
    // plates editor (a PostgREST write).
    await page.getByRole('tab', { name: 'Account' }).click();
    await expect(team(page).getByTestId('team-member')).toHaveCount(3);
    await expect(props(page, 'Terry Banks')).toHaveText('PropertiesOak Hill Commons, Spring Lake Apartments');
    await expect(props(page, 'Sam Ortiz')).toHaveText('PropertiesNo properties yet');
    await expect(props(page, 'Dana Reyes')).toHaveText('PropertiesAll properties');
    await expect(team(page).getByRole('checkbox')).toHaveCount(0);
    await expect(page.locator('#tow-truck-plates')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(/\bdriver\b/i);

    expect(seen.rest).toEqual([]);
    expect(await forbiddenSeen(page)).toEqual([]);
  });

  test('a remembered Activity tab (this device\'s last session) still lands on Requests', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('lotlogic_tab', 'activity'); } catch { /* blocked */ } });
    await watchForbiddenPages(page);
    const seen = await stub(page, { account: 'partner', memberRole: 'driver' });
    await signIn(page, 'terry@queencitytow.test');
    await expect(page.getByRole('tab', { name: 'Requests' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: 'REQUESTS' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Activity' })).toHaveCount(0);
    expect(seen.rest).toEqual([]);
    expect(await forbiddenSeen(page)).toEqual([]);
  });

  test('with no property yet: "Ask {Admin name} to assign you a property." on Requests and Lookup', async ({ page }) => {
    const seen = await stub(page, { account: 'partner', memberRole: 'driver', truckProperties: [], adminNames: ['Dana Reyes', 'Lee Park'] });
    await signIn(page, 'terry@queencitytow.test');

    await expect(navTabs(page)).toHaveText(['Lookup', 'Requests', 'Account']);
    await expect(page.getByText('Ask Dana Reyes to assign you a property.')).toBeVisible();
    await expect(page.getByText('Nothing active.')).toHaveCount(0);

    await page.getByRole('tab', { name: 'Lookup' }).click();
    await expect(page.getByText('Ask Dana Reyes to assign you a property.')).toBeVisible();
    await expect(page.locator('#lookup-plate')).toHaveCount(0);
    expect(seen.rest).toEqual([]);
  });

  test('Lookup never falls back to a PostgREST read when /auth/me fails', async ({ page }) => {
    // db.getProperties reads the properties table when /auth/me throws; a
    // Truck's token has no partner_id, so that read could only come back
    // empty, and a Truck reads nothing through PostgREST at all.
    const seen = await stub(page, { account: 'partner', memberRole: 'driver', meStatus: 503 });
    await signIn(page, 'terry@queencitytow.test');
    await expect(navTabs(page)).toHaveText(['Lookup', 'Requests', 'Account']);
    await page.getByRole('tab', { name: 'Lookup' }).click();
    await expect(page.getByText('No apartment properties assigned to this account.')).toBeVisible();
    expect(seen.rest).toEqual([]);
  });

  test('with no Admin named, the sentence asks "your Admin"', async ({ page }) => {
    await stub(page, { account: 'partner', memberRole: 'driver', truckProperties: [], adminNames: [] });
    await signIn(page, 'terry@queencitytow.test');
    await expect(page.getByText('Ask your Admin to assign you a property.')).toBeVisible();
  });
});
