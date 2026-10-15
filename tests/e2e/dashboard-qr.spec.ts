/**
 * The property QR codes on the operator dashboard (FE-4).
 *
 * An owner opens a property in `/app` and sees one or two tiles, each meant to
 * show a scannable QR code they print and post at the lot — that code is how a
 * driver reaches the registration form. For months the tiles drew an empty
 * white box: the drawing library was loaded from a CDN path that 404s, and the
 * page's `typeof QRCode === 'undefined'` guard returned quietly, so there was
 * nothing on screen and nothing in the console to report.
 *
 * Serves the BUILT frontend (fixtures/buildAndServeFrontend.ts) and mounts only
 * the property detail page on its own React root with every data call stubbed.
 * (It used to serve `frontend/` straight from source; since Task 17 the page's
 * script exists only after a build, so the page never booted and this spec
 * timed out waiting for it.)
 *
 * What it pins down:
 *   - the tile's canvas is NON-EMPTY once it has drawn, i.e. it has dark
 *     pixels, not a blank box — that only happens if the bundled `qrcode`
 *     module actually ran, so a missing/broken module fails this test too.
 *   - an apartment opens on its Requests section, where the QR tiles are not on
 *     screen at all. Moving to another section MOUNTS fresh, blank canvases, and
 *     they have to be drawn then too — they used to stay white boxes.
 *   - each tile fits its column on a phone and on a tablet, with the QR square
 *     and whole: the library sizes the canvas with an inline 320px that no
 *     stylesheet width can beat, which made a tile 366px wide and clipped it on
 *     any column narrower than that. The heading's qualifier ("up to 72 hrs") is
 *     not broken across two lines to fit beside it; it moves under it.
 *   - side by side, the two codes sit level at every width: from the one-column
 *     breakpoint to 640px, where the column stops growing, the pair stacks its
 *     qualifiers under the headings together instead of one tile doing it and
 *     its neighbour not (which set one code 16px lower). A plaza's lone tile
 *     keeps its qualifier beside its heading.
 *   - an apartment hands out ONE entry, /apt/<qr>, with the role in the query
 *     (short-term = guest, long-term = resident), on the tile and on Copy link,
 *     and says "parking pass"; a truck plaza keeps /temp/<qr> and its own label.
 *   - the bitmap is the link: what each canvas encodes is read back from its
 *     pixels and compared with the QR code the same library makes for the link
 *     printed under it, so a pair swapped between the tiles, or still pointing
 *     at the old /temp/ and /perm/ pages, fails here and not on a printed sign.
 *   - the codes are drawn again when the page reloads its data (which unmounts
 *     the tiles), and a property with no registration address shows no tiles
 *     rather than a blank box over a link that ends in /null.
 *
 * Tagged @desktop-only so the mobile-safari project (which targets the remote
 * deploy) skips it.
 *
 * Run: cd tests && npx playwright test dashboard-qr --project=chromium-desktop
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildAndServeFrontend } from '../fixtures/buildAndServeFrontend';

const FRONTEND_DIR = path.resolve(__dirname, '../../frontend');
const PROPERTY_ID = '22222222-2222-4222-8222-222222222222';
const QR_CODE_ID = 'test-plaza-qr-0001';

// The encoder the dashboard bundles (frontend/package.json pins qrcode). The
// expected code for a link is made here, in Node, so the test does not ask the
// page what the page drew. It is resolved in beforeAll, once the build has run,
// and not when this file loads: where only tests/ is installed (the post-deploy
// e2e job), a load-time require stops Playwright reading any spec and the whole
// run reports 0 tests, where it should fail this spec alone, as its siblings do.
let QRCode: {
  create(text: string, options: { errorCorrectionLevel: 'M' }): { modules: { size: number; data: Uint8Array } };
};

let origin: string;
let closeServer: () => Promise<void>;

test.beforeAll(async () => {
  ({ origin, close: closeServer } = await buildAndServeFrontend(FRONTEND_DIR));
  QRCode = createRequire(path.join(FRONTEND_DIR, 'package.json'))('qrcode');
});

test.afterAll(async () => {
  await closeServer();
});

type Options = {
  /** Truck plazas only show the self-serve tile; apartments show both. */
  propertyType?: string;
  /** The property's `qr_code_id`; null is a property that has no slug yet
   *  (every portal signup, until one is assigned). */
  qrCodeId?: string | null;
  /** The section the page opens on (the deep link / remembered chip). Left
   *  out, the page picks its own default: Requests for an apartment. */
  initialSection?: string;
};

/**
 * Boot the real dashboard file, then mount ONLY the property detail page on
 * its own root, as an owner, with its seven data calls answered locally.
 */
async function mountPropertyDetail(
  page: Page,
  { propertyType = 'apartment', qrCodeId = QR_CODE_ID, initialSection }: Options = {},
) {
  const json = (body: unknown, status = 200) => ({
    status, contentType: 'application/json', body: JSON.stringify(body),
  });

  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());

  // Nothing in this spec talks to a real backend or a real Supabase.
  await page.route(/^https:\/\/(lotlogic-backend-production\.up\.railway\.app|nzdkoouoaedbbccraoti\.supabase\.co)\//,
    (route) => route.fulfill(json({})));
  await page.route(/supabase\.co\/rest\/v1\//, (route) => route.fulfill(json([])));

  // `?e2e=1` is what makes the bundle expose `window.__lotlogicTestHooks` —
  // see `frontend/src/main.jsx`. Without it this is a real visitor's page.
  await page.goto(`${origin}/dashboard.html?e2e=1`);

  await page.waitForFunction(
    () => typeof (window as unknown as Record<string, any>).__lotlogicTestHooks?.ALPRPropertyDetailPage?.load === 'function',
    undefined,
    { timeout: 30_000 },
  );

  await page.evaluate(async ({ propertyId, qrCodeId, type, section }) => {
    const hooks = (window as unknown as Record<string, any>).__lotlogicTestHooks;
    // The detail page loads its property through `db`; hand it one directly so
    // the tiles render without a session or a database.
    // A test can hold the next load open (`hold()`), so the page sits in its
    // "Loading..." state, which has no tiles, for as long as the test needs.
    let gate: Promise<void> = Promise.resolve();
    let release: () => void = () => {};
    hooks.db.getProperty = async () => {
      await gate;
      return {
        id: propertyId, name: 'Test Property', qr_code_id: qrCodeId,
        property_type: type, address: '1 Test Way', pay_to_park_enabled: false,
      };
    };
    const ALPRPropertyDetailPage = await hooks.ALPRPropertyDetailPage.load();
    // The app's own shell, so the page gets the column it really gets
    // (`.page-content` is max 640px, with 16px gutters) and not the bare body.
    const shell = document.createElement('div');
    shell.className = 'app theme-light';
    const main = document.createElement('main');
    main.className = 'page-content';
    const host = document.createElement('div');
    host.id = 'qr-harness';
    main.appendChild(host);
    shell.appendChild(main);
    document.body.appendChild(shell);
    const root = hooks.ReactDOM.createRoot(host);
    const render = (user: Record<string, unknown>) => root.render(
      hooks.React.createElement(
        hooks.ToastProvider,
        null,
        hooks.React.createElement(ALPRPropertyDetailPage, {
          propertyId, onBack: () => {}, user,
          ...(section ? { initialSection: section } : {}),
        }),
      ),
    );
    render({ _role: 'owner', id: 'u1' });
    (window as unknown as Record<string, unknown>).__qrHarness = {
      hold() { gate = new Promise<void>((resolve) => { release = resolve; }); },
      release() { release(); },
      // Same property, same role, another account: the page reloads its data
      // (loadAll depends on user.id) and nothing the tiles depend on changes.
      signInAs(id: string) { render({ _role: 'owner', id }); },
    };
  }, { propertyId: PROPERTY_ID, qrCodeId, type: propertyType, section: initialSection ?? null });

  const detail = page.locator('#qr-harness');
  await expect(detail.locator('[data-testid="pd-section-chips"]')).toBeVisible();
  return detail;
}

/** True when the canvas has drawn something other than blank white. */
async function canvasHasInk(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const c = document.querySelector(sel) as HTMLCanvasElement | null;
    if (!c || !c.width || !c.height) return false;
    const ctx = c.getContext('2d');
    if (!ctx) return false;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    for (let i = 0; i < data.length; i += 4) {
      // Anything meaningfully darker than the white QR background counts.
      if (data[i + 3] > 0 && data[i] < 128 && data[i + 1] < 128 && data[i + 2] < 128) return true;
    }
    return false;
  }, selector);
}

const TILE_CANVAS = (n: number) => `#qr-harness .pd-qr-tile:nth-child(${n}) canvas`;

/** The links a tile could be encoding: the apartment entry in each role, and
 *  the old pages a plaza still uses. Naming the one a canvas does encode is
 *  what makes a swapped pair, or a stale link, read as such in the failure. */
const knownLinks = () => [
  `${origin}/apt/${QR_CODE_ID}?role=guest`,
  `${origin}/apt/${QR_CODE_ID}?role=resident`,
  `${origin}/temp/${QR_CODE_ID}`,
  `${origin}/perm/${QR_CODE_ID}`,
];

/**
 * Which of the known links the canvas encodes, read from its pixels: the
 * centre of every module of the link's QR code must be dark where the code has
 * a dark module and light where it does not. null when the canvas is blank or
 * encodes none of them. The drawing is qrcode's: width 320 and margin 1 module.
 */
async function linkEncodedBy(page: Page, selector: string): Promise<string | null> {
  const candidates = knownLinks().map((url) => {
    const { size, data } = QRCode.create(url, { errorCorrectionLevel: 'M' }).modules;
    return { url, size, dark: Array.from(data) };
  });
  return page.evaluate(({ sel, grids }) => {
    const canvas = document.querySelector(sel) as HTMLCanvasElement | null;
    const ctx = canvas && canvas.width ? canvas.getContext('2d') : null;
    if (!canvas || !ctx) return null;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const margin = 1;
    for (const grid of grids) {
      const scale = canvas.width / (grid.size + 2 * margin);
      let matches = true;
      for (let row = 0; row < grid.size && matches; row++) {
        for (let col = 0; col < grid.size; col++) {
          const x = Math.floor((margin + col + 0.5) * scale);
          const y = Math.floor((margin + row + 0.5) * scale);
          const at = (y * canvas.width + x) * 4;
          const dark = data[at + 3] > 0 && data[at] < 128 && data[at + 1] < 128 && data[at + 2] < 128;
          if (dark !== (grid.dark[row * grid.size + col] === 1)) { matches = false; break; }
        }
      }
      if (matches) return grid.url;
    }
    return null;
  }, { sel: selector, grids: candidates });
}

/** The code on tile `n` is the QR code for `url`, and for no other link. */
async function expectTileEncodes(page: Page, n: number, url: string) {
  await expect.poll(() => linkEncodedBy(page, TILE_CANVAS(n)), {
    message: `tile ${n}'s QR code encodes ${url}`, timeout: 15_000,
  }).toBe(url);
}

/** Record what the Copy link buttons write, instead of touching the clipboard. */
async function recordClipboard(page: Page) {
  await page.addInitScript(() => {
    const copied: string[] = [];
    (window as unknown as Record<string, unknown>).__copied = copied;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (text: string) => { copied.push(text); return Promise.resolve(); } },
    });
  });
}
const copiedLinks = (page: Page) =>
  page.evaluate(() => (window as unknown as { __copied: string[] }).__copied);

test.describe('property QR codes @desktop-only', () => {
  test('the tile draws a real QR code, not an empty box', async ({ page }) => {
    const detail = await mountPropertyDetail(page, { initialSection: 'all' });
    await expect(detail.locator('.pd-qr-tile')).toHaveCount(2);
    await expect(page.locator(TILE_CANVAS(1))).toBeVisible();
    // The draw happens in an effect after the property arrives.
    await expect.poll(() => canvasHasInk(page, TILE_CANVAS(1)), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => canvasHasInk(page, TILE_CANVAS(2)), { timeout: 15_000 }).toBe(true);
    await expect(page.locator('#qr-harness [data-testid="qr-unavailable"]')).toHaveCount(0);
  });

  test('an apartment draws both codes after leaving Requests, where its tiles are not mounted', async ({ page }) => {
    const detail = await mountPropertyDetail(page, { propertyType: 'apartment' });
    // Requests is the apartment default and nothing else renders there.
    await expect(detail.locator('.pd-qr-tile')).toHaveCount(0);
    await detail.getByRole('button', { name: 'All', exact: true }).click();
    await expect(detail.locator('.pd-qr-tile')).toHaveCount(2);
    await expect.poll(() => canvasHasInk(page, TILE_CANVAS(1)), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => canvasHasInk(page, TILE_CANVAS(2)), { timeout: 15_000 }).toBe(true);
    await expectTileEncodes(page, 1, `${origin}/apt/${QR_CODE_ID}?role=guest`);
    await expectTileEncodes(page, 2, `${origin}/apt/${QR_CODE_ID}?role=resident`);
  });

  test('the codes are drawn again when the page reloads its data and its tiles come back', async ({ page }) => {
    const detail = await mountPropertyDetail(page, { propertyType: 'apartment', initialSection: 'all' });
    await expectTileEncodes(page, 1, `${origin}/apt/${QR_CODE_ID}?role=guest`);
    await expectTileEncodes(page, 2, `${origin}/apt/${QR_CODE_ID}?role=resident`);

    // Another account opens the same property: the page reloads, and while it
    // does it shows "Loading..." and no tiles. Nothing a tile depends on changed.
    await page.evaluate(() => {
      const harness = (window as unknown as Record<string, any>).__qrHarness;
      harness.hold();
      harness.signInAs('u2');
    });
    await expect(detail.locator('.pd-qr-tile')).toHaveCount(0);
    await page.evaluate(() => (window as unknown as Record<string, any>).__qrHarness.release());

    // The tiles that come back are fresh, blank canvases, and need drawing again.
    await expect(detail.locator('.pd-qr-tile')).toHaveCount(2);
    await expectTileEncodes(page, 1, `${origin}/apt/${QR_CODE_ID}?role=guest`);
    await expectTileEncodes(page, 2, `${origin}/apt/${QR_CODE_ID}?role=resident`);
  });

  test('an apartment hands out its one entry, /apt/<qr> with the role, labelled parking pass', async ({ page }) => {
    await recordClipboard(page);
    const detail = await mountPropertyDetail(page, { propertyType: 'apartment', initialSection: 'all' });
    const short = detail.locator('.pd-qr-tile').nth(0);
    const long = detail.locator('.pd-qr-tile').nth(1);
    await expect(short.locator('.pd-share-label')).toHaveText('Short-term parking pass');
    await expect(short.locator('.pd-qr-url')).toHaveText(`${origin}/apt/${QR_CODE_ID}?role=guest`);
    await expect(long.locator('.pd-share-label')).toHaveText('Long-term parking pass');
    await expect(long.locator('.pd-qr-url')).toHaveText(`${origin}/apt/${QR_CODE_ID}?role=resident`);
    // The short-term form at /apt/ (apt.js) goes up to 72 hours, so the tile says so.
    await expect(short.locator('.pd-qr-sub')).toHaveText('up to 72 hrs');
    await expect(long.locator('.pd-qr-sub')).toHaveText('owner-approved');

    // What gets printed is the bitmap, not the text under it: each code encodes
    // the link under it, and not the other tile's, nor the old /temp/ and /perm/.
    await expectTileEncodes(page, 1, `${origin}/apt/${QR_CODE_ID}?role=guest`);
    await expectTileEncodes(page, 2, `${origin}/apt/${QR_CODE_ID}?role=resident`);

    await short.getByRole('button', { name: 'Copy link' }).click();
    await expect(page.getByText('Short-term link copied')).toBeVisible();
    await long.getByRole('button', { name: 'Copy link' }).click();
    await expect(page.getByText('Long-term link copied')).toBeVisible();
    expect(await copiedLinks(page)).toEqual([
      `${origin}/apt/${QR_CODE_ID}?role=guest`,
      `${origin}/apt/${QR_CODE_ID}?role=resident`,
    ]);
  });

  test('a truck plaza shows its one tile, drawn, on the /temp/ link', async ({ page }) => {
    await recordClipboard(page);
    const detail = await mountPropertyDetail(page, { propertyType: 'truck_plaza' });
    await expect(detail.locator('.pd-qr-tile')).toHaveCount(1);
    await expect.poll(() => canvasHasInk(page, TILE_CANVAS(1)), { timeout: 15_000 }).toBe(true);
    const tile = detail.locator('.pd-qr-tile').first();
    await expect(tile.locator('.pd-share-label')).toHaveText('Self-serve pass');
    await expect(tile.locator('.pd-qr-sub')).toHaveText('up to 48 hrs');
    await expect(tile.locator('.pd-qr-url')).toHaveText(`${origin}/temp/${QR_CODE_ID}`);
    await expectTileEncodes(page, 1, `${origin}/temp/${QR_CODE_ID}`);
    await tile.getByRole('button', { name: 'Copy link' }).click();
    await expect(page.getByText('Self-serve link copied')).toBeVisible();
    expect(await copiedLinks(page)).toEqual([`${origin}/temp/${QR_CODE_ID}`]);
  });

  test('a property with no registration address shows no QR tiles and no link that ends in /null', async ({ page }) => {
    const detail = await mountPropertyDetail(page, { propertyType: 'apartment', initialSection: 'all', qrCodeId: null });
    // The page has loaded (its section chips are up); a tile now would be a
    // blank box over a link the manager could copy and print.
    await expect(detail.locator('.pd-qr-tile')).toHaveCount(0);
    await expect(detail.getByRole('button', { name: 'Copy link' })).toHaveCount(0);
    await expect(detail).not.toContainText('/null');
  });

  // 540 and 580 are where the two tiles are narrowest side by side (the grid
  // goes to one column at 520), and where a qualifier used to break in two.
  for (const width of [360, 390, 540, 580, 600, 700]) {
    test(`each tile fits its column at ${width}px, with the QR square and whole and its heading unbroken`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const detail = await mountPropertyDetail(page, { propertyType: 'apartment', initialSection: 'all' });
      await expect(detail.locator('.pd-qr-tile')).toHaveCount(2);
      await expect.poll(() => canvasHasInk(page, TILE_CANVAS(2)), { timeout: 15_000 }).toBe(true);
      const column = (await detail.boundingBox())!;
      for (const n of [1, 2]) {
        const tile = (await detail.locator('.pd-qr-tile').nth(n - 1).boundingBox())!;
        const canvas = (await page.locator(TILE_CANVAS(n)).boundingBox())!;
        expect(tile.x, `tile ${n} starts inside the column`).toBeGreaterThanOrEqual(column.x - 0.5);
        expect(tile.x + tile.width, `tile ${n} ends inside the column`).toBeLessThanOrEqual(column.x + column.width + 0.5);
        expect(canvas.x + canvas.width, `QR ${n} ends inside its tile`).toBeLessThanOrEqual(tile.x + tile.width);
        expect(Math.abs(canvas.width - canvas.height), `QR ${n} is square`).toBeLessThan(1);
        expect(canvas.width, `QR ${n} stays large enough to scan`).toBeGreaterThanOrEqual(160);
        // "up to 72 hrs" and "owner-approved" are not broken across two lines to
        // fit beside the heading: they move under it when there is no room.
        const sub = (await detail.locator('.pd-qr-sub').nth(n - 1).boundingBox())!;
        expect(sub.height, `tile ${n}'s qualifier is one line`).toBeLessThan(18);
        expect(sub.x + sub.width, `tile ${n}'s qualifier ends inside its tile`).toBeLessThanOrEqual(tile.x + tile.width);
      }
    });
  }

  // Side by side, whether a tile's qualifier fits beside its heading depends on
  // the words in that tile and on the font, so left to flow one tile stacked it
  // while its neighbour did not, and the two codes sat at different heights (16px
  // apart in Manrope between about 566 and 600px). From the one-column
  // breakpoint to 640px, where the column stops growing, the pair stacks
  // together; the layout is the same at every width above that.
  test('the two QR codes sit level at every width the pair is squeezed, 521 to 640px', async ({ page }) => {
    await page.setViewportSize({ width: 600, height: 900 });
    const detail = await mountPropertyDetail(page, { propertyType: 'apartment', initialSection: 'all' });
    await expect(detail.locator('.pd-qr-tile')).toHaveCount(2);
    await expect.poll(() => canvasHasInk(page, TILE_CANVAS(1)), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => canvasHasInk(page, TILE_CANVAS(2)), { timeout: 15_000 }).toBe(true);
    const uneven: Array<[width: number, apart: number]> = [];
    for (let width = 521; width <= 640; width++) {
      await page.setViewportSize({ width, height: 900 });
      const first = (await page.locator(TILE_CANVAS(1)).boundingBox())!;
      const second = (await page.locator(TILE_CANVAS(2)).boundingBox())!;
      if (Math.abs(first.y - second.y) >= 1) uneven.push([width, Math.round(second.y - first.y)]);
    }
    // "566-599px (16px apart)" reads better in a failure than one line per width.
    const ranges: string[] = [];
    for (let i = 0; i < uneven.length; ) {
      let j = i;
      while (j + 1 < uneven.length && uneven[j + 1][0] === uneven[j][0] + 1 && uneven[j + 1][1] === uneven[i][1]) j++;
      ranges.push(`${uneven[i][0]}-${uneven[j][0]}px (${uneven[i][1]}px apart)`);
      i = j + 1;
    }
    expect(ranges, 'widths at which the two codes are not level').toEqual([]);
  });

  test('the pair puts its qualifiers under their headings while squeezed, and beside them once the column is full width', async ({ page }) => {
    const direction = async (width: number) => {
      await page.setViewportSize({ width, height: 900 });
      return page.locator('#qr-harness .pd-qr-head').evaluateAll((heads) => heads.map((h) => getComputedStyle(h).flexDirection));
    };
    await mountPropertyDetail(page, { propertyType: 'apartment', initialSection: 'all' });
    expect(await direction(521), 'at 521px').toEqual(['column', 'column']);
    expect(await direction(580), 'at 580px').toEqual(['column', 'column']);
    expect(await direction(640), 'at 640px').toEqual(['column', 'column']);
    expect(await direction(641), 'at 641px').toEqual(['row', 'row']);
    expect(await direction(1100), 'at 1100px').toEqual(['row', 'row']);
  });

  test('a truck plaza\'s lone tile keeps its qualifier beside its heading', async ({ page }) => {
    await page.setViewportSize({ width: 580, height: 900 });
    const detail = await mountPropertyDetail(page, { propertyType: 'truck_plaza' });
    await expect(detail.locator('.pd-qr-tile')).toHaveCount(1);
    await expect(detail.locator('.pd-qr-head')).toHaveCSS('flex-direction', 'row');
  });

  // Two tests were removed here, both stale for the same reason: qrcode is
  // bundled (Task 14), not loaded from a CDN.
  //   - "the pinned QR library loads and exposes the drawing call" asserted a
  //     `cdnjs.cloudflare.com` request and a `window.QRCode` global, neither
  //     of which the bundle produces — its intent (the library is present)
  //     is covered by "draws a real QR code" above, which fails outright if
  //     the bundled `qrcode` module is missing.
  //   - "a QR library that fails to load says so instead of drawing nothing"
  //     (and its breakQrLib fixture) tested a CDN-404 fallback that no
  //     longer exists: a load failure now means the whole
  //     ALPRPropertyDetailPage chunk failed to fetch, which is
  //     lazyPage()'s reload-once/ErrorBoundary path, not a QRCode-specific UI.
});
