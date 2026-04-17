import { test as base, expect, APIRequestContext, Page } from '@playwright/test';

export type TestAccount = {
  label: string;
  email: string;
  password: string;
  role: 'owner' | 'partner';
};

const required = (name: string): string => {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Missing required env var ${name}. Set it in .env or CI secrets. ` +
      `Seed test accounts with \`npm run seed\`.`
    );
  }
  return v;
};

export const accounts = {
  ownerA: (): TestAccount => ({
    label: 'ownerA',
    email: required('TEST_OWNER_A_EMAIL'),
    password: required('TEST_OWNER_A_PASSWORD'),
    role: 'owner',
  }),
  ownerB: (): TestAccount => ({
    label: 'ownerB',
    email: required('TEST_OWNER_B_EMAIL'),
    password: required('TEST_OWNER_B_PASSWORD'),
    role: 'owner',
  }),
  partnerA: (): TestAccount => ({
    label: 'partnerA',
    email: required('TEST_PARTNER_A_EMAIL'),
    password: required('TEST_PARTNER_A_PASSWORD'),
    role: 'partner',
  }),
};

export const API_URL =
  process.env.API_URL ?? 'https://lotlogic-backend-production.up.railway.app';

export async function loginAs(page: Page, account: TestAccount): Promise<string> {
  await page.goto('/dashboard.html');
  await page.getByLabel(/email/i).fill(account.email);
  await page.getByLabel(/password/i).fill(account.password);
  await page.getByRole('button', { name: /sign in|log in/i }).click();

  await expect(page.getByRole('button', { name: /jobs|properties/i }).first()).toBeVisible({
    timeout: 15_000,
  });

  const token = await page.evaluate(() => {
    try {
      const s = localStorage.getItem('lotlogic_session');
      if (!s) return null;
      const parsed = JSON.parse(s);
      return parsed._token ?? null;
    } catch {
      return null;
    }
  });
  expect(token, 'login must produce a JWT in lotlogic_session._token').toBeTruthy();
  return token as string;
}

export async function apiLogin(
  request: APIRequestContext,
  account: TestAccount
): Promise<{ token: string; subject: { type: string; id: string } }> {
  const res = await request.post(`${API_URL}/auth/login`, {
    data: { email: account.email, password: account.password },
    headers: { 'content-type': 'application/json' },
  });
  expect(res.ok(), `login failed for ${account.label}: ${res.status()} ${await res.text()}`).toBeTruthy();
  const body = await res.json();
  expect(body.token).toBeTruthy();
  return { token: body.token, subject: body.subject };
}

type Fixtures = {
  ownerAToken: string;
  ownerBToken: string;
  partnerAToken: string;
};

export const test = base.extend<Fixtures>({
  ownerAToken: async ({ request }, use) => {
    const { token } = await apiLogin(request, accounts.ownerA());
    await use(token);
  },
  ownerBToken: async ({ request }, use) => {
    const { token } = await apiLogin(request, accounts.ownerB());
    await use(token);
  },
  partnerAToken: async ({ request }, use) => {
    const { token } = await apiLogin(request, accounts.partnerA());
    await use(token);
  },
});

export { expect };
