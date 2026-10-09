// `frontend/error-reporting.js` scrub() — what leaves the browser in a Sentry
// event. The `/r/<token>` page carries a 48 h bearer token in its path (until
// the page moves the address bar to `/r`), so every URL the event carries —
// the request url, the Referer, and navigation / fetch breadcrumbs — must
// have the token cut out, not only the query string.
//
// The loader is a classic script (an IIFE that only defines scrub when a DSN
// is set), so it is run in a vm sandbox with a fake window/document and a
// DSN, and the SDK <script> it appends is never loaded.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, '..', 'error-reporting.js'), 'utf8');

function loadScrub() {
  const window = { SENTRY_DSN: 'https://public@o0.ingest.sentry.io/1', location: { hostname: 'localhost' } };
  const document = { createElement: () => ({}), head: { appendChild() {} } };
  vm.runInNewContext(SRC, { window, document });
  assert.ok(window.LotLogicErrorReporting, 'the loader exposes scrub once a DSN is set');
  return window.LotLogicErrorReporting.scrub;
}

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln';

test('scrub: the request url loses the /r/<token> segment', () => {
  const scrub = loadScrub();
  const ev = scrub({ request: { url: `https://lotlogicparking.com/r/${TOKEN}?x=1` } });
  assert.equal(ev.request.url, 'https://lotlogicparking.com/r');
});

test('scrub: a relative /r/<token> url and a trailing slash are cut too', () => {
  const scrub = loadScrub();
  assert.equal(scrub({ request: { url: `/r/${TOKEN}/` } }).request.url, '/r');
});

test('scrub: the Referer header loses the token', () => {
  const scrub = loadScrub();
  const ev = scrub({ request: { url: 'https://lotlogicparking.com/app', headers: { Referer: `https://lotlogicparking.com/r/${TOKEN}` } } });
  assert.equal(ev.request.headers.Referer, 'https://lotlogicparking.com/r');
});

test('scrub: navigation and fetch breadcrumbs lose the token', () => {
  const scrub = loadScrub();
  const ev = scrub({
    breadcrumbs: [
      { category: 'navigation', data: { from: `/r/${TOKEN}`, to: '/r' } },
      { category: 'fetch', data: { url: `https://api.example.test/requests/action?token=${TOKEN}` } },
      { category: 'xhr', data: { url: `https://lotlogicparking.com/r/${TOKEN}` } },
    ],
  });
  const text = JSON.stringify(ev);
  assert.ok(!text.includes(TOKEN), text);
  assert.equal(ev.breadcrumbs[0].data.from, '/r');
  assert.equal(ev.breadcrumbs[1].data.url, 'https://api.example.test/requests/action');
  assert.equal(ev.breadcrumbs[2].data.url, 'https://lotlogicparking.com/r');
});

test('scrub: other paths are left as they were (query still dropped)', () => {
  const scrub = loadScrub();
  assert.equal(scrub({ request: { url: 'https://lotlogicparking.com/join/n-style?a=1' } }).request.url,
    'https://lotlogicparking.com/join/n-style');
  assert.equal(scrub({ request: { url: 'https://lotlogicparking.com/rentals/x' } }).request.url,
    'https://lotlogicparking.com/rentals/x');
});
