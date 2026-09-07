#!/usr/bin/env node
/**
 * tests/visual/capture.mjs — the no-op verification harness for Wave 2.6.
 *
 * Usage:
 *   node visual/capture.mjs --out=visual/baseline [--url=https://…]
 *   node visual/capture.mjs --out=visual/current   [--url=https://…]
 *
 * Logs in as test owner A, visits every dashboard tab reachable for that
 * account, and writes, per tab, per Playwright project (chromium-desktop /
 * mobile-safari — the same two projects tests/playwright.config.ts runs):
 *   <tab>.<project>.html  — a normalized `document.body.outerHTML`
 *   <tab>.<project>.png   — a full-page screenshot
 *
 * Credentials come from TEST_OWNER_A_EMAIL / TEST_OWNER_A_PASSWORD — the
 * same env vars tests/fixtures/accounts.ts requires, seeded via GitHub
 * Actions secrets. If they are not set (e.g. running locally without those
 * secrets), capture falls back to the single unauthenticated tab ("login":
 * the dashboard's login shell) and prints a warning to stderr. That is a
 * deliberate degrade — never log in with credentials that aren't actually
 * available — not a bug in this script.
 *
 * Normalization strips exactly three sources of legitimate render churn:
 *   - React's data-reactroot-style internal attributes
 *   - useUid()-generated ids (modal-title-3, lightbox-title-7, fb-title-1,
 *     doc-title-2, modal-desc-4 — see useUid() call sites in dashboard.html)
 *     rewritten to `<prefix>-N`
 *   - ISO timestamps and "Nm/Nh/Nd/Ns ago" / "just now" relative-time text,
 *     rewritten to `<T>`
 * Anything else that differs between two captures is a real change.
 */
import { chromium, webkit, devices } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

function arg(name, def) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}

const OUT = path.resolve(process.cwd(), arg('out', 'visual/current'));
const URL = arg('url', process.env.BASE_URL || 'https://lotlogic-beta.vercel.app');
const EMAIL = process.env.TEST_OWNER_A_EMAIL;
const PASSWORD = process.env.TEST_OWNER_A_PASSWORD;
const AUTHENTICATED = !!(EMAIL && PASSWORD);

const PROJECTS = {
  'chromium-desktop': { launcher: chromium, device: devices['Desktop Chrome'] },
  'mobile-safari': { launcher: webkit, device: devices['iPhone 14'] },
};

// ── normalization ──────────────────────────────────────────────────────
const KNOWN_UID_PREFIXES = ['modal-title-', 'modal-desc-', 'lightbox-title-', 'fb-title-', 'doc-title-'];
const escapeRe = (s) => s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
const UID_RE = new RegExp(`(?:${KNOWN_UID_PREFIXES.map(escapeRe).join('|')})\\d+`, 'g');
const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?/g;
const RELTIME_RE = /\b\d+\s?(?:s|m|h|d)\s+ago\b|\bjust now\b|\bJust now\b/g;
const REACT_INTERNAL_RE = /\s+data-reactroot(="[^"]*")?/gi;

function normalize(html) {
  return html
    .replace(REACT_INTERNAL_RE, '')
    .replace(UID_RE, (m) => m.replace(/\d+$/, 'N'))
    .replace(ISO_RE, '<T>')
    .replace(RELTIME_RE, '<T>');
}

// ── capture helpers ────────────────────────────────────────────────────
// The 0-pixel-tolerance PNG gate needs a page that renders the *same* pixels
// on every capture. Two real sources of non-determinism showed up in
// practice: a blinking text-input caret (the login email field autofocuses)
// and CSS transitions/animations landing mid-frame depending on capture
// timing. Neither is a "real" visual difference a task could introduce —
// pause/hide both before every screenshot.
async function stabilize(page) {
  await page.addStyleTag({
    content: `*, *::before, *::after {
      animation-play-state: paused !important;
      animation-duration: 0s !important;
      animation-delay: 0s !important;
      transition-duration: 0s !important;
      transition-delay: 0s !important;
      caret-color: transparent !important;
    }`,
  });
  await page.evaluate(() => document.activeElement?.blur?.());
}

async function settle(page) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(500);
  await stabilize(page);
}

async function writeCapture(tabId, projectName, page) {
  // Strip <script> tags before serializing. Scripts aren't rendered content,
  // and Wave 2.6's whole point is changing *how* the JS is delivered (inline
  // Babel block -> external esbuild bundle) without changing what the DOM
  // looks like — the gate must be blind to that, or it fails on Task 1/2
  // even though nothing user-visible moved.
  const html = normalize(await page.evaluate(() => {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll('script').forEach((s) => s.remove());
    return clone.outerHTML;
  }));
  await writeFile(path.join(OUT, `${tabId}.${projectName}.html`), html);
  await page.screenshot({ path: path.join(OUT, `${tabId}.${projectName}.png`), fullPage: true });
}

async function loginAndListTabs(page) {
  await page.goto(`${URL}/dashboard.html`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel(/email/i).fill(EMAIL);
  await page.getByLabel(/password/i).fill(PASSWORD);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await page.getByRole('tab', { name: /^lots$/i }).first().waitFor({ state: 'visible', timeout: 20_000 });
  const labels = await page.locator('[role="tablist"] [role="tab"]').evaluateAll(
    (els) => els.map((el) => el.getAttribute('aria-label') || el.textContent || '')
  );
  return labels.map((l) => l.split(',')[0].trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''));
}

async function run() {
  await mkdir(OUT, { recursive: true });
  const manifest = { url: URL, when: new Date().toISOString(), authenticated: AUTHENTICATED, tabs: [] };

  if (!AUTHENTICATED) {
    console.error(
      'visual/capture.mjs: TEST_OWNER_A_EMAIL / TEST_OWNER_A_PASSWORD not set locally — ' +
      'capturing the UNAUTHENTICATED SHELL ONLY (the login page). Full per-tab capture needs ' +
      'the Playwright test-account secrets, which only exist in GitHub Actions.'
    );
  }

  for (const [projectName, { launcher, device }] of Object.entries(PROJECTS)) {
    const browser = await launcher.launch();
    const ctx = await browser.newContext({ ...device });
    const page = await ctx.newPage();

    if (AUTHENTICATED) {
      const tabIds = await loginAndListTabs(page);
      if (manifest.tabs.length === 0) manifest.tabs = tabIds;
      for (let i = 0; i < tabIds.length; i++) {
        await page.locator('[role="tablist"] [role="tab"]').nth(i).click();
        await settle(page);
        await writeCapture(tabIds[i], projectName, page);
      }
    } else {
      await page.goto(`${URL}/dashboard.html`, { waitUntil: 'domcontentloaded' });
      await page.getByLabel(/email/i).waitFor({ state: 'visible', timeout: 30_000 });
      await settle(page);
      await writeCapture('login', projectName, page);
      if (manifest.tabs.length === 0) manifest.tabs = ['login'];
    }

    await browser.close();
  }

  await writeFile(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(
    `Captured ${manifest.tabs.length} tab(s) × ${Object.keys(PROJECTS).length} project(s) into ${OUT}` +
    (AUTHENTICATED ? '' : ' (unauthenticated shell only)')
  );
}

await run();
