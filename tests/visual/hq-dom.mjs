#!/usr/bin/env node
// tests/visual/hq-dom.mjs — a structural snapshot, not a screenshot: it
// renders the HQ tab against a LOCAL build with the fixture board, extracts
// the section order, the per-section counts and the health words, and
// compares that to a committed baseline.
//
// Deliberately not tests/visual/capture.mjs: that script has no --only flag
// and its --url defaults to production, so running it here would overwrite
// the two committed login baselines with a capture of a site that does not
// have this page. This writes to visual/baseline-hq/ and touches nothing
// else.
//
//   node visual/hq-dom.mjs --write     # refresh the baseline (review the diff!)
//   node visual/hq-dom.mjs             # compare; non-zero exit on a difference
import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAndServeFrontend } from '../fixtures/buildAndServeFrontend.ts';
import { BOARD } from '../fixtures/brainBoard.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, '../../frontend');
const BASELINE_DIR = path.join(__dirname, 'baseline-hq');
const BASELINE_FILE = path.join(BASELINE_DIR, 'hq.json');

const WRITE = process.argv.includes('--write');

async function snapshot() {
  const server = await buildAndServeFrontend(FRONTEND_DIR);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('**/brain/board', (r) => r.fulfill({ json: BOARD }));
    await page.route('**/auth/me', (r) => r.fulfill({
      json: { email: 'a@b.c', is_platform_admin: true },
    }));
    await page.addInitScript(() => {
      localStorage.setItem('lotlogic_session', JSON.stringify(
        { _token: 'hq-test-token-test-only', _role: 'owner', is_platform_admin: true, _ts: Date.now() }));
      localStorage.setItem('lotlogic_tab', 'hq');
    });
    await page.goto(`${server.origin}/dashboard.html`);
    await page.waitForSelector('[data-testid="hq-root"]');

    const data = await page.evaluate(() => {
      const text = (el) => (el ? el.textContent.trim() : null);
      const sections = Array.from(document.querySelectorAll('[data-section]'))
        .map((el) => el.getAttribute('data-section'));
      const counts = {
        areas: document.querySelectorAll('[data-testid="area-card"]').length,
        priorities: document.querySelectorAll('[data-section="priorities"] li').length,
        red: document.querySelectorAll('[data-testid="red-finding"]').length,
        questions: document.querySelectorAll('[data-testid="question"]').length,
        changed: document.querySelectorAll('[data-section="changed"] > div > div').length,
      };
      const healthWords = Array.from(document.querySelectorAll('[data-testid="area-card"]'))
        .map((card) => ({
          area: card.getAttribute('data-area'),
          health: card.getAttribute('data-health'),
        }));
      const fleetLabels = text(document.querySelector('[data-testid="fleet-health"]'));
      return { sections, counts, healthWords, fleetLabels };
    });
    return data;
  } finally {
    await browser.close();
    await server.close();
  }
}

function diffLines(baseline, current) {
  const lines = [];
  const bStr = JSON.stringify(baseline, null, 2).split('\n');
  const cStr = JSON.stringify(current, null, 2).split('\n');
  const max = Math.max(bStr.length, cStr.length);
  for (let i = 0; i < max; i++) {
    if (bStr[i] !== cStr[i]) {
      lines.push(`  line ${i + 1}:`);
      lines.push(`    - ${bStr[i] ?? '<missing>'}`);
      lines.push(`    + ${cStr[i] ?? '<missing>'}`);
    }
  }
  return lines;
}

async function main() {
  const current = await snapshot();

  if (WRITE) {
    await mkdir(BASELINE_DIR, { recursive: true });
    await writeFile(BASELINE_FILE, `${JSON.stringify(current, null, 2)}\n`);
    console.log(`wrote ${path.relative(process.cwd(), BASELINE_FILE)}`);
    console.log(JSON.stringify(current, null, 2));
    return;
  }

  let baseline;
  try {
    baseline = JSON.parse(await readFile(BASELINE_FILE, 'utf8'));
  } catch (err) {
    console.error(`no baseline at ${BASELINE_FILE} — run with --write first`);
    process.exitCode = 1;
    return;
  }

  const baselineStr = JSON.stringify(baseline);
  const currentStr = JSON.stringify(current);
  if (baselineStr === currentStr) {
    console.log('hq-dom: no difference');
    return;
  }

  console.error('hq-dom: DIFFERENCE from baseline\n');
  for (const line of diffLines(baseline, current)) console.error(line);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
