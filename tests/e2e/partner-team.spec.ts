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
const OWNER_ID = '44444444-4444-4444-8444-444444444444';
const PROPERTY_ID = '55555555-5555-4555-8555-555555555555';
const FAKE_TOKEN = 'fake.jwt.for-test';

type MemberRole = 'admin' | 'dispatcher' | 'driver';

/** Two members: the signed-in Admin (Dana) and a Truck who has not set a password (Sam). */
function roster(danaRole: MemberRole = 'admin') {
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
    ],
  };
}

interface Seen {
  invites: unknown[];
  patches: Array<{ id: string; body: unknown }>;
  deletes: string[];
  resends: string[];
  teamGets: number;
}

interface StubOpts {
  account: 'partner' | 'owner';
  memberRole?: MemberRole;
  /** What `POST /partner/team/invite` answers. */
  invite?: { status: number; detail?: string };
  /** The post-login `enforcement_partners` Supabase read, answered after this many ms. */
  partnerRowDelayMs?: number;
}

const json = (route: Route, status: number, body: unknown) => route.fulfill({
  status,
  contentType: 'application/json',
  headers: { 'access-control-allow-origin': '*' },
  body: JSON.stringify(body),
});

async function stub(page: Page, opts: StubOpts): Promise<Seen> {
  const seen: Seen = { invites: [], patches: [], deletes: [], resends: [], teamGets: 0 };
  const memberRole = opts.memberRole ?? 'admin';
  const partner = opts.account === 'partner';

  // Lowest priority (registered first): nothing but the local build may load.
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    return url.origin === server.origin ? route.continue() : route.abort();
  });
  // Realtime: mocked in the page, never connected to the real project.
  await page.routeWebSocket(/supabase\.co/, () => {});

  await page.route(`${SUPABASE}/**`, async (route) => {
    const url = new URL(route.request().url());
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
          'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
        },
      });
    }
    if (m === 'POST' && p === '/auth/login') {
      return json(route, 200, {
        token: FAKE_TOKEN,
        expires_in: 604800,
        subject: partner
          ? {
            type: 'partner', id: COMPANY_ID, email: 'dana@queencitytow.test', display_name: 'Dana Reyes',
            member_id: DANA_ID, member_role: memberRole, is_admin: false, is_platform_admin: false,
          }
          : {
            type: 'owner', id: OWNER_ID, email: 'office@springlake.test', display_name: 'Spring Lake Apartments',
            is_admin: false, is_platform_admin: false,
          },
      });
    }
    if (m === 'GET' && p === '/auth/me') {
      return json(route, 200, partner
        ? {
          type: 'partner', id: COMPANY_ID, email: 'dana@queencitytow.test', display_name: COMPANY,
          company_name: COMPANY, phone: '+17045550100', is_admin: false, is_platform_admin: false,
          pending_joins: 0, pending_properties: 0, lots: [], properties: [],
          member: { id: DANA_ID, name: 'Dana Reyes', role: memberRole },
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
      return json(route, 200, roster(memberRole));
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
    await expect(team(page).getByTestId('team-member')).toHaveCount(2);

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

    await expect(team(page).getByTestId('team-member')).toHaveCount(2);
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
