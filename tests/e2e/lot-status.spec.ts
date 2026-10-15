/**
 * The Lot status tab and the Lookup timeline (task F7, spec
 * 2026-10-15-lot-status §4/§5), mounted standalone through the e2e test hooks
 * (`frontend/src/main.jsx`) on THIS branch's local build, with the two
 * endpoints served from `fixtures/lotStatus.ts` (the §2 contract). No session,
 * no backend. Runs on both projects; the phone project is the iPhone 14
 * viewport, which is the layout the tab is designed for.
 *
 * axe: `scan()` blocks on serious/critical with no waivers (WAIVED is empty
 * by construction - there is no map to put one in).
 */
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { buildAndServeFrontend } from '../fixtures/buildAndServeFrontend';
import { PROPERTY_ID, lotStatusFixture, serveLotStatus, timelineFixture } from '../fixtures/lotStatus';

const FRONTEND_DIR = path.resolve(__dirname, '../../frontend');
let server: Awaited<ReturnType<typeof buildAndServeFrontend>>;
test.beforeAll(async () => { server = await buildAndServeFrontend(FRONTEND_DIR); });
test.afterAll(async () => { await server.close(); });

const BLOCKING = new Set(['serious', 'critical']);

async function scan(page: Page, label: string, selector: string) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .include(selector)
    .analyze();
  const blocking = results.violations.filter(v => BLOCKING.has(v.impact ?? ''));
  expect(blocking, `serious/critical a11y violations on ${label}:\n${JSON.stringify(blocking, null, 2)}`).toEqual([]);
}

async function openHarness(page: Page) {
  await page.goto(`${server.origin}/dashboard.html?e2e=1`);
  await page.waitForFunction(
    () => typeof (window as any).__lotlogicTestHooks?.LotStatusTab === 'function'
      && typeof (window as any).__lotlogicTestHooks?.PlateLookupPage === 'function',
    undefined,
    { timeout: 30_000 },
  );
}

/** Mount the tab on its own root; row taps are recorded on `window.__opened`. */
async function mountTab(page: Page) {
  await openHarness(page);
  await page.evaluate((propertyId) => {
    const { React, ReactDOM, LotStatusTab } = (window as any).__lotlogicTestHooks;
    (window as any).__opened = [];
    const host = document.createElement('div');
    host.id = 'lot-harness';
    host.style.cssText = 'position:fixed;inset:0;overflow:auto;padding:16px;background:var(--bg-primary,#111);z-index:9999';
    document.body.appendChild(host);
    ReactDOM.createRoot(host).render(React.createElement(LotStatusTab, {
      propertyId, propertyName: 'Spring Lake Apartments',
      onOpenRow: (row: any, list: string) => (window as any).__opened.push({ plate: row.plate, list }),
    }));
  }, PROPERTY_ID);
  await expect(page.getByTestId('lot-status')).toBeVisible();
}

const plates = async (page: Page) => page.locator('.ls-plate').allTextContents();
const seg = (page: Page, name: RegExp) => page.getByRole('button', { name });

test.describe('Lot status tab @lot-status', () => {
  test('the six tiles equal the fixture counts, and the page says when it is as of', async ({ page }) => {
    const served = await serveLotStatus(page);
    await mountTab(page);
    const c = lotStatusFixture().counts;
    const want: Record<string, number> = {
      registered: c.registered_long_term, short_term: c.short_term_active, pending: c.pending_protected,
      holds: c.holds_active, open: c.open_requests, towable: c.towable,
    };
    // distinct values so a mislabelled tile cannot pass
    for (const [key, n] of Object.entries(want)) {
      await expect(page.getByTestId(`ls-tile-${key}`).locator('dd')).toHaveText(String(n));
    }
    await expect(page.getByTestId('ls-tile-registered').locator('dt')).toHaveText('Registered');
    await expect(page.getByTestId('ls-tile-towable').locator('dt')).toHaveText('Towable');
    await expect(page.getByTestId('ls-asof')).toHaveText('As of 11:15 PM ET');
    await expect(page.getByRole('heading', { name: 'Lot status · Spring Lake Apartments' })).toBeVisible();
    expect(served.lastQuery()?.get('property_id')).toBe(PROPERTY_ID);
  });

  test('Towable is the default list, longest expired first, with the car and the last check', async ({ page }) => {
    await serveLotStatus(page);
    await mountTab(page);
    await expect(seg(page, /^Towable \(3\)$/)).toHaveAttribute('aria-pressed', 'true');
    expect(await plates(page)).toEqual(['OLD1234', 'ABC1234', 'DEF5678']);
    const abc = page.locator('.ls-row', { hasText: 'ABC1234' });
    await expect(abc).toContainText('white Honda Civic');
    await expect(abc).toContainText('expired 3h ago');
    await expect(abc).toContainText('last check 1h ago: tow');
    await expect(abc).toContainText('Short-term');
    const old = page.locator('.ls-row', { hasText: 'OLD1234' });
    await expect(old).toContainText('expired 2d ago');
    await expect(old).toContainText('Long-term');
    await expect(old).toContainText('no plate check yet');
    await expect(page.locator('.ls-row', { hasText: 'DEF5678' })).toContainText('last check 10m ago: not registered');
  });

  test('Do not tow lists the soonest to lapse first, nulls last, with why and until when', async ({ page }) => {
    await serveLotStatus(page);
    await mountTab(page);
    await seg(page, /^Do not tow/).click();
    expect(await plates(page)).toEqual(['SHT5555', 'HLD0001', 'PND1111', 'LTR2222']);
    const hold = page.locator('.ls-row', { hasText: 'HLD0001' });
    await expect(hold).toContainText('black Ford F-150');
    await expect(hold).toContainText('Hold');
    await expect(hold).toContainText('H-0012');
    await expect(hold).toContainText('until Fri 1:15 AM');
    await expect(page.locator('.ls-row', { hasText: 'SHT5555' })).toContainText('Short-term parking pass');
    await expect(page.locator('.ls-row', { hasText: 'SHT5555' })).toContainText('until 11:40 PM');
    await expect(page.locator('.ls-row', { hasText: 'PND1111' })).toContainText('Under review');
    await expect(page.locator('.ls-row', { hasText: 'LTR2222' })).toContainText('Long-term parking pass');
    await expect(page.locator('.ls-row', { hasText: 'LTR2222' })).toContainText('no end date');
  });

  test('Ending soon shows the ET clock, the weekday once it is past midnight, and the time left', async ({ page }) => {
    await serveLotStatus(page);
    await mountTab(page);
    await seg(page, /^Ending soon \(2\)$/).click();
    expect(await plates(page)).toEqual(['XYZ789', 'LNG4321']);
    const first = page.locator('.ls-row', { hasText: 'XYZ789' });
    await expect(first).toContainText('ends 11:40 PM');
    await expect(first).toContainText('25m left');
    await expect(page.locator('.ls-row', { hasText: 'LNG4321' })).toContainText('ends Fri 12:10 AM');
  });

  test('the plate search filters the visible list and a miss says so', async ({ page }) => {
    await serveLotStatus(page);
    await mountTab(page);
    const search = page.getByRole('searchbox', { name: 'Search by plate' });
    await search.fill('abc');
    expect(await plates(page)).toEqual(['ABC1234']);
    await search.fill('ab-c 12');
    expect(await plates(page)).toEqual(['ABC1234']);
    await search.fill('zzz');
    await expect(page.getByText('No plates match “ZZZ”.')).toBeVisible();
    await page.getByRole('button', { name: 'Clear search' }).click();
    expect(await plates(page)).toHaveLength(3);
    // the filter follows the segment
    await search.fill('xyz');
    await seg(page, /^Ending soon/).click();
    expect(await plates(page)).toEqual(['XYZ789']);
  });

  test('empty states use the spec copy', async ({ page }) => {
    const empty = { ...lotStatusFixture(), do_not_tow: [], towable: [], expiring_soon: [], counts: { ...lotStatusFixture().counts, towable: 0 } };
    await serveLotStatus(page, { status: empty });
    await mountTab(page);
    await expect(page.getByText('Nothing to tow right now.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Export CSV' })).toHaveCount(0);
    await seg(page, /^Do not tow/).click();
    await expect(page.getByText('No holds or pending requests.')).toBeVisible();
    await seg(page, /^Ending soon/).click();
    await expect(page.getByText('Nothing ending in the next 4 hours.')).toBeVisible();
  });

  test('a capped list says how many more there are', async ({ page }) => {
    const big = lotStatusFixture();
    big.counts.registered_long_term = 60;
    await serveLotStatus(page, { status: big });
    await mountTab(page);
    await seg(page, /^Do not tow \(63\)$/).click();
    await expect(page.getByText('Showing the first 4 of 63.')).toBeVisible();
  });

  test('Export CSV downloads the towable list as <slug>-towable-<date>.csv', async ({ page }) => {
    await serveLotStatus(page);
    await mountTab(page);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export CSV' }).click(),
    ]);
    expect(download.suggestedFilename()).toBe('spring-lake-apartments-towable-2026-10-15.csv');
    const text = fs.readFileSync((await download.path())!, 'utf8');
    expect(text.split('\r\n')).toEqual([
      'Plate,Car,Pass,Expired at (ET),Hours expired,Last check',
      'OLD1234,,Long-term,"Tue Oct 13, 9:15 PM ET",50,',
      'ABC1234,white Honda Civic,Short-term,"Thu Oct 15, 8:15 PM ET",3,"tow at Thu Oct 15, 10:15 PM ET"',
      'DEF5678,silver Toyota Camry,Short-term,"Thu Oct 15, 9:45 PM ET",1,"not registered at Thu Oct 15, 11:05 PM ET"',
      '',
    ]);
  });

  test('a row tap hands the row and its list to the page, which opens the pass detail', async ({ page }) => {
    await serveLotStatus(page);
    await mountTab(page);
    await page.locator('.ls-row', { hasText: 'ABC1234' }).click();
    await seg(page, /^Do not tow/).click();
    await page.locator('.ls-row', { hasText: 'HLD0001' }).click();
    expect(await page.evaluate(() => (window as any).__opened)).toEqual([
      { plate: 'ABC1234', list: 'towable' },
      { plate: 'HLD0001', list: 'do_not_tow' },
    ]);
  });

  test('no name, unit, phone or document appears anywhere on the tab', async ({ page }) => {
    await serveLotStatus(page);
    await mountTab(page);
    for (const s of ['Do not tow', 'Ending soon']) {
      await seg(page, new RegExp(`^${s}`)).click();
      const text = (await page.getByTestId('lot-status').innerText()).toLowerCase();
      for (const banned of ['unit ', 'phone', 'document', 'resident', 'visitor', 'guest', 'permanent', 'temporary']) {
        expect(text, `"${banned}" on ${s}`).not.toContain(banned);
      }
    }
  });

  test('a load failure is not "nothing to tow", and Retry recovers', async ({ page }) => {
    let fail = true;
    await page.route('**/apartment/passes/lot-status**', (route) => fail
      ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"detail":"boom"}' })
      : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(lotStatusFixture()) }));
    await mountTab(page);
    await expect(page.getByText(/Couldn't load the lot status/)).toBeVisible();
    await expect(page.getByText('Nothing to tow right now.')).toHaveCount(0);
    fail = false;
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByTestId('ls-tile-towable').locator('dd')).toHaveText('3');
  });

  test('it refreshes itself every 60 s while visible, and not while hidden', async ({ page }) => {
    const served = await serveLotStatus(page);
    await page.clock.install();
    await mountTab(page);
    await expect.poll(() => served.lotStatusHits()).toBe(1);
    await page.clock.runFor(61_000);
    await expect.poll(() => served.lotStatusHits()).toBe(2);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    });
    await page.clock.runFor(125_000);
    expect(served.lotStatusHits()).toBe(2);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => served.lotStatusHits()).toBe(3);
  });

  test('Refresh fetches again on demand', async ({ page }) => {
    const served = await serveLotStatus(page);
    await mountTab(page);
    await expect.poll(() => served.lotStatusHits()).toBe(1);
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect.poll(() => served.lotStatusHits()).toBe(2);
  });

  test('has no serious a11y violations (every list)', async ({ page }) => {
    await serveLotStatus(page);
    await mountTab(page);
    await scan(page, 'lot-status towable', '#lot-harness');
    await seg(page, /^Do not tow/).click();
    await scan(page, 'lot-status do-not-tow', '#lot-harness');
    await seg(page, /^Ending soon/).click();
    await scan(page, 'lot-status ending-soon', '#lot-harness');
    await page.getByRole('searchbox', { name: 'Search by plate' }).fill('zzz');
    await scan(page, 'lot-status no match', '#lot-harness');
  });
});

/** Mount the real Lookup page with one apartment property and the lookup routes stubbed. */
async function mountLookup(page: Page) {
  await page.route('**/apartment/passes/lookup**', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ verdict: 'not_registered', detail: { plate: 'ABC1234' } }),
  }));
  await page.route('**/apartment/passes/history**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ entries: [] }),
  }));
  await openHarness(page);
  await page.evaluate((propertyId) => {
    const { React, ReactDOM, db, PlateLookupPage } = (window as any).__lotlogicTestHooks;
    db.getProperties = async () => [{ id: propertyId, name: 'Spring Lake Apartments', property_type: 'apartment' }];
    const host = document.createElement('div');
    host.id = 'lookup-harness';
    host.style.cssText = 'position:fixed;inset:0;overflow:auto;padding:16px;background:var(--bg-primary,#111);z-index:9999';
    document.body.appendChild(host);
    ReactDOM.createRoot(host).render(React.createElement(PlateLookupPage, { user: { id: 'o1', _role: 'owner' } }));
  }, PROPERTY_ID);
  await page.getByLabel('License plate').fill('abc1234');
  await page.getByRole('button', { name: 'Check', exact: true }).click();
}

test.describe('Lookup timeline @lot-status', () => {
  test('shows the plate\'s history newest first, each line with its time in ET', async ({ page }) => {
    await serveLotStatus(page);
    await mountLookup(page);
    const timeline = page.getByTestId('plate-timeline');
    await expect(timeline.getByRole('heading', { name: 'Timeline · 4' })).toBeVisible();
    const items = timeline.locator('.ls-event');
    await expect(items).toHaveCount(4);
    await expect(items.nth(0)).toContainText('Plate check');
    await expect(items.nth(0)).toContainText('DO NOT TOW - parking pass');
    await expect(items.nth(0)).toContainText('Thu Oct 15, 10:15 PM ET');
    await expect(items.nth(1)).toContainText('Pass expired');
    await expect(items.nth(1)).toContainText('short-term parking pass, 24 h');
    await expect(items.nth(2)).toContainText('Hold placed');
    await expect(items.nth(2)).toContainText('H-0012');
    await expect(items.nth(3)).toContainText('Pass filed');
    await expect(items.nth(3)).toContainText('Wed Oct 14, 8:10 PM ET');
  });

  test('asks for the property and the plate that was checked', async ({ page }) => {
    let seen: URLSearchParams | null = null;
    await serveLotStatus(page);
    await page.route('**/apartment/passes/timeline**', (route) => {
      seen = new URL(route.request().url()).searchParams;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(timelineFixture('ABC1234')) });
    });
    await mountLookup(page);
    await expect(page.getByTestId('plate-timeline').locator('.ls-event').first()).toBeVisible();
    expect(seen!.get('property_id')).toBe(PROPERTY_ID);
    expect(seen!.get('plate')).toBe('ABC1234');
  });

  test('an empty history says so', async ({ page }) => {
    await serveLotStatus(page, { timeline: { plate: 'ABC1234', events: [] } });
    await mountLookup(page);
    await expect(page.getByTestId('plate-timeline').getByText('No history for this plate here.')).toBeVisible();
  });

  test('a failed history is an error with Retry, not "no history"', async ({ page }) => {
    await serveLotStatus(page, { timeline: 500 });
    await mountLookup(page);
    const timeline = page.getByTestId('plate-timeline');
    await expect(timeline.getByText("Couldn't load the timeline.")).toBeVisible();
    await expect(timeline.getByText('No history for this plate here.')).toHaveCount(0);
    await expect(timeline.getByRole('button', { name: 'Retry' })).toBeVisible();
  });

  test('has no serious a11y violations', async ({ page }) => {
    await serveLotStatus(page);
    await mountLookup(page);
    await expect(page.getByTestId('plate-timeline').locator('.ls-event').first()).toBeVisible();
    await scan(page, 'lookup timeline', '[data-testid="plate-timeline"]');
  });
});
