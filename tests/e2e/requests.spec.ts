/**
 * The office's Requests section against the LOCAL backend (Task 30 Step 3;
 * spec §4.3, §5.2, §5.8). `@portal`: skipped unless PORTAL_E2E=1
 * (tests/README.md "Portal suite"). Every test signs up its own office
 * (API signup + the debug code) and uses its own random plate, so the specs
 * run in parallel on both projects without seeing each other.
 *
 * Database reads (fixture `sql` / `deliveries`): the `removed` delivery's
 * status after an Undo, and the hold's row after a one-tap `ack_end`.
 * Database writes: one — the hold's `expires_at` is pulled to T-1 h so the
 * `/r/<token>` preview is the "ends soon" one the mail links to. The token
 * itself is minted by the backend's own `issue_request_action_token`.
 */
import {
  test, expect, skipUnlessPortal, frontendOrigin, pointAtLocalBackend, seedNStyle,
  officeOnRequests, randomPlate, deliveries, latestRequest, sql, lit, mintActionToken,
  PARTNER_NAME,
} from '../fixtures/portal';
import type { Page } from '@playwright/test';

async function placeHold(page: Page, plate: string) {
  await page.getByRole('textbox', { name: 'Plate' }).fill(plate);
  await page.getByRole('button', { name: /^Put on hold until / }).click();
}

function holdRow(page: Page, plate: string) {
  return page.locator('.req-card', { hasText: plate }).filter({ hasText: /H-\d+/ }).first();
}

test.describe('office Requests section @portal', () => {
  test.beforeEach(async ({ page }) => {
    skipUnlessPortal();
    seedNStyle();
    await pointAtLocalBackend(page);
  });

  test('placing a hold toasts that it is sending to N Style', async ({ page }) => {
    const office = await officeOnRequests(page, frontendOrigin());
    const plate = randomPlate();
    await placeHold(page, plate);
    const toast = page.getByText(new RegExp(`^Hold H-\\d+ placed until .+ — sending to ${PARTNER_NAME}\\.$`));
    await expect(toast).toBeVisible();
    const req = latestRequest(office.property_id)!;
    await expect(toast).toContainText(`Hold H-${req.ref} placed until`);
    await expect(holdRow(page, plate)).toContainText(`H-${req.ref}`);
  });

  test('Undo inside the window: the removed notice never goes out', async ({ page }) => {
    const office = await officeOnRequests(page, frontendOrigin());
    const plate = randomPlate();
    await placeHold(page, plate);
    const row = holdRow(page, plate);
    await expect(row).toBeVisible();
    const req = latestRequest(office.property_id)!;

    await row.getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByText('Hold removed · Undo')).toBeVisible();
    const t0 = Date.now();
    await page.locator('.req-card[role="status"]', { hasText: 'Hold removed' }).getByRole('button', { name: 'Undo' }).click();
    expect(Date.now() - t0, 'Undo tapped inside the 10 s hold-back').toBeLessThan(10_000);
    await expect(holdRow(page, plate)).toBeVisible();

    // Every `removed` delivery the Remove queued is cancelled, none sent.
    await expect.poll(() => deliveries(req.id).filter((d) => d.event === 'removed').map((d) => d.status))
      .not.toContain('queued');
    const removed = deliveries(req.id).filter((d) => d.event === 'removed');
    expect(removed.length, 'Remove queued a notice to hold back').toBeGreaterThan(0);
    expect(removed.every((d) => d.status === 'cancelled'), JSON.stringify(removed)).toBe(true);
    expect(removed.some((d) => d.status === 'sent')).toBe(false);
  });

  /** An office with a hold pulled to T-1 h, and its `/r/<token>` ack_end page open. */
  async function ackEndPage(page: Page) {
    const office = await officeOnRequests(page, frontendOrigin());
    const plate = randomPlate();
    await placeHold(page, plate);
    await expect(holdRow(page, plate)).toBeVisible();
    const req = latestRequest(office.property_id)!;
    sql(`UPDATE public.tow_requests SET expires_at = now() + interval '50 minutes' WHERE id = ${lit(req.id)}`);
    const token = mintActionToken(req.id, 'ack_end');
    await page.goto(`${frontendOrigin()}/r/${token}`);
    const ok = page.getByRole('button', { name: /^OK — it ends at / });
    await expect(ok).toBeVisible({ timeout: 15_000 });
    return { req, ok };
  }
  const holdState = (id: string) =>
    sql(`SELECT status, expires_at, extension_count FROM public.tow_requests WHERE id = ${lit(id)}`)[0];

  test('the T-1 h link: "OK — it ends at" changes nothing about the hold', async ({ page }) => {
    const { req, ok } = await ackEndPage(page);
    const before = holdState(req.id);

    // The tap reaches the backend and is accepted — a click that never left
    // the page would also leave the row unchanged.
    const posted = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/requests/action');
    await ok.click();
    const res = await posted;
    expect(res.status(), 'POST /requests/action {action: ack_end}').toBe(200);
    expect(JSON.parse(res.request().postData() ?? '{}')).toMatchObject({ action: 'ack_end' });
    await expect(ok).toBeHidden();

    expect(holdState(req.id), 'ack_end leaves status, end time and extension count alone').toEqual(before);
  });

  // KNOWN BACKEND DEFECT (Task 13, found by this suite; task-30-report.md
  // "Fix round 1"): spec §6 `POST /requests/action` answers
  // `{result: 'acknowledged'}`, but `routers/request_actions.py` returns
  // `{result: 'acked'}`, which `deriveResultView` (spec-correct) renders as
  // "This link has expired." `test.fail` keeps the assertion live: once the
  // backend says `acknowledged` this "unexpectedly passes" and the marker
  // must come off.
  test('the T-1 h link: after "OK", the page confirms the end time (spec §5.8)', async ({ page }) => {
    test.fail(true, "backend: POST /requests/action returns result 'acked', the spec says 'acknowledged'");
    const { req, ok } = await ackEndPage(page);
    await ok.click();
    const refNo = req.ref.replace(/^H-/, '');
    await expect(page.getByText(new RegExp(`Got it\\. H-${refNo} ends at .+ as planned\\.`))).toBeVisible();
    await expect(page.getByRole('button', { name: 'Extend 24 hours instead' })).toBeVisible();
  });

  test('Extend sheet: "0 of 4" before, "1 of 4" after', async ({ page }) => {
    const office = await officeOnRequests(page, frontendOrigin());
    const plate = randomPlate();
    await placeHold(page, plate);
    const row = holdRow(page, plate);
    await expect(row).toBeVisible();

    await row.getByRole('button', { name: 'Extend' }).click();
    const sheet = page.getByRole('dialog', { name: new RegExp(`^Extend H-\\d+ · ${plate}$`) });
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('0 of 4 extensions used');
    await sheet.getByRole('button', { name: '24 hours' }).click();
    await sheet.locator('button[type="submit"]').click();
    await expect(page.getByText('Hold extended (1 of 4).')).toBeVisible();
    await expect(sheet).toBeHidden();

    const req = latestRequest(office.property_id)!;
    expect(sql(`SELECT extension_count FROM public.tow_requests WHERE id = ${lit(req.id)}`)[0][0]).toBe('1');
    await row.getByRole('button', { name: 'Extend' }).click();
    await expect(page.getByRole('dialog', { name: /^Extend H-/ })).toContainText('1 of 4 extensions used');
  });

  test('a second hold on the same plate: 409 flags the row and highlights Extend', async ({ page }) => {
    await officeOnRequests(page, frontendOrigin());
    const plate = randomPlate();
    await placeHold(page, plate);
    const row = holdRow(page, plate);
    await expect(row).toBeVisible();

    await placeHold(page, plate);
    const conflict = page.locator('.req-error', { hasText: `${plate} is already on hold` });
    await expect(conflict).toBeVisible();
    await conflict.getByRole('button', { name: 'Extend it instead' }).click();
    await expect(row).toHaveClass(/\breq-flag\b/);
    await expect(row.getByRole('button', { name: 'Extend' })).toHaveClass(/\breq-btn-flag\b/);
    await expect(row).toBeInViewport();
  });
});
