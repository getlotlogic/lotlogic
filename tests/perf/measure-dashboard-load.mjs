// Usage: node tests/perf/measure-dashboard-load.mjs --url=https://… [--json]
// Measures the operator dashboard the way an operator meets it: an iPhone 14
// on throttled LTE, cold cache, logged in. Emits the numbers that Wave 2.6 is
// judged on. No CI job runs this; it is a before/after ruler.
import { chromium, devices } from '@playwright/test';

const SLOW_4G = { downloadThroughput: 1.6e6 / 8, uploadThroughput: 750e3 / 8, latency: 150 };
const url = (process.argv.find(a => a.startsWith('--url=')) || '').slice(6)
         || process.env.BASE_URL || 'https://lotlogic-beta.vercel.app';

// Same Vercel "Protection Bypass for Automation" header as
// tests/playwright.config.ts — a Preview URL is behind Deployment Protection
// and 302s to vercel.com/sso-api without it. Absent for production/live-beta.
const BYPASS_SECRET = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
const bypassHeaders = BYPASS_SECRET
  ? { 'x-vercel-protection-bypass': BYPASS_SECRET, 'x-vercel-set-bypass-cookie': 'true' }
  : {};

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPhone 14'], extraHTTPHeaders: bypassHeaders });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send('Network.enable');
await cdp.send('Network.emulateNetworkConditions', { offline: false, ...SLOW_4G });
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 }); // a mid-range phone

const bytes = [];
page.on('response', async r => {
  const h = r.headers();
  bytes.push({ url: r.url(), status: r.status(), type: r.request().resourceType(),
               enc: Number(h['content-length'] || 0) });
});

const t0 = Date.now();
await page.goto(url + '/dashboard.html', { waitUntil: 'domcontentloaded' });
const domContentLoaded = Date.now() - t0;
// "Usable" = the login form is interactive. That is the first thing an
// operator can actually do, and it is behind the whole React boot today.
await page.getByLabel(/email/i).waitFor({ state: 'visible', timeout: 120_000 });
const timeToUsable = Date.now() - t0;

const paint = await page.evaluate(() => {
  const e = performance.getEntriesByType('paint');
  const lcp = performance.getEntriesByType('largest-contentful-paint').pop();
  return { fcp: (e.find(x => x.name === 'first-contentful-paint') || {}).startTime,
           lcp: lcp && lcp.startTime,
           transferred: performance.getEntriesByType('resource')
             .reduce((n, r) => n + (r.transferSize || 0), 0) };
});

const out = { url, when: new Date().toISOString(), profile: 'slow-4g + 4x CPU, iPhone 14',
              domContentLoaded, timeToUsable, ...paint, requests: bytes.length, bytes };
console.log(process.argv.includes('--json') ? JSON.stringify(out, null, 2)
  : `time-to-usable ${timeToUsable} ms · DCL ${domContentLoaded} ms · FCP ${Math.round(paint.fcp)} ms · ` +
    `${bytes.length} requests · ${(paint.transferred / 1024).toFixed(0)} KB transferred`);
await browser.close();
