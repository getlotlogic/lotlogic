// Task F2 — one entry for apartment registration: /apt/<qr>, with ?role= to
// skip its landing choice. Tests for the pure helpers (shared/aptEntry.js) and,
// below them, for what resident.js, visit.js and apt.js do with them.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { initialScreenForRole, aptEntryUrl } from '../src/shared/aptEntry.js';

const ORIGIN = 'https://lotlogic-beta.vercel.app';

// ── ?role= → first screen ─────────────────────────────────────────────────

test('?role=resident opens the long-term form and ?role=guest the short-term form', () => {
  assert.equal(initialScreenForRole('?role=resident'), 'resident');
  assert.equal(initialScreenForRole('?role=guest'), 'guest');
});

test('no role, an empty role or an unknown role is the landing, as before', () => {
  for (const search of ['', '?', '?role=', '?role=admin', '?role=resident,guest', '?roles=guest', '?qr=abc']) {
    assert.equal(initialScreenForRole(search), 'landing', JSON.stringify(search));
  }
});

test('a missing search string is the landing', () => {
  assert.equal(initialScreenForRole(undefined), 'landing');
  assert.equal(initialScreenForRole(null), 'landing');
});

test('the role must match exactly: another case or padding is not a role', () => {
  for (const search of ['?role=Resident', '?role=GUEST', '?role=%20guest', '?role=guest%20']) {
    assert.equal(initialScreenForRole(search), 'landing', JSON.stringify(search));
  }
});

test('the role is found among other parameters, with or without the leading ?', () => {
  assert.equal(initialScreenForRole('?qr=fort-mill-townhomes-i&role=guest'), 'guest');
  assert.equal(initialScreenForRole('?role=resident&utm_source=sign'), 'resident');
  assert.equal(initialScreenForRole('role=guest'), 'guest');
});

test('the first role wins when the parameter is repeated', () => {
  assert.equal(initialScreenForRole('?role=guest&role=resident'), 'guest');
  assert.equal(initialScreenForRole('?role=nope&role=resident'), 'landing');
});

// ── the /apt/ address ──────────────────────────────────────────────────────

test('aptEntryUrl is /apt/<qr>?role=<role> and nothing else', () => {
  assert.equal(aptEntryUrl('fort-mill-townhomes-i', 'resident'), '/apt/fort-mill-townhomes-i?role=resident');
  assert.equal(aptEntryUrl('fort-mill-townhomes-i', 'guest'), '/apt/fort-mill-townhomes-i?role=guest');
});

test('aptEntryUrl keeps a path-safe slug byte for byte and escapes the rest', () => {
  assert.equal(aptEntryUrl('villas-at-1825', 'guest'), '/apt/villas-at-1825?role=guest');
  assert.equal(aptEntryUrl('a b/c?d#e', 'guest'), '/apt/a%20b%2Fc%3Fd%23e?role=guest');
});

test('what aptEntryUrl writes is what initialScreenForRole reads back', () => {
  for (const role of ['resident', 'guest']) {
    const url = new URL(aptEntryUrl('fort-mill-townhomes-i', role), 'https://example.test');
    assert.equal(initialScreenForRole(url.search), role);
    assert.deepEqual(url.pathname.split('/').filter(Boolean), ['apt', 'fort-mill-townhomes-i']);
  }
});

// ── what the three public pages do with them ───────────────────────────────
// resident.js, visit.js and apt.js run `init()` the moment they load and talk
// to `window`, `document` and `fetch`. This stubs just enough of each to watch
// what a page does with a property row: where it navigates, and what it
// renders into #app. Each case imports the page under a fresh query string, so
// it gets its own module state (its own `property` and `qrCodeId`);
// ./shared/register.js is shared and only reads the globals when called.
const LOADING = '<div class="loading-state">Loading the form…</div>';
const QR = 'fort-mill-townhomes-i';

const APARTMENT = { id: 'prop-apartment', name: 'Fort Mill Townhomes I', address: '100 Bollin Cir', property_type: 'apartment', policy_phone: '+17045550100' };
const PLAZA = { id: 'prop-plaza', name: 'Charlotte Travel Plaza', address: '1 Plaza Rd', property_type: 'truck_plaza', policy_text: 'No idling.', policy_phone: '(555) 000-0000' };
const UNTYPED = { id: 'prop-untyped', name: 'Some Lot', address: '2 Lot St', property_type: null };

function stubElement() {
  const handlers = {};
  return {
    handlers,
    addEventListener(type, fn) { handlers[type] = fn; },
    value: '', textContent: '', innerHTML: '', files: [], checked: false, disabled: false,
    style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    insertAdjacentHTML() {}, querySelector: () => null, querySelectorAll: () => [],
    setAttribute() {}, focus() {}, remove() {},
  };
}

const realConsoleError = console.error;
const realGlobals = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
let runNumber = 0;

async function openPage(file, url, rows) {
  const where = new URL(url);
  const replaced = [];
  const queries = [];
  const errors = [];
  const app = { innerHTML: LOADING };
  const elements = new Map();
  globalThis.window = { location: { pathname: where.pathname, search: where.search, replace: (to) => replaced.push(to) } };
  globalThis.document = {
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById(id) {
      if (id === 'app') return app;
      if (!elements.has(id)) elements.set(id, stubElement());
      return elements.get(id);
    },
    createElement() {
      let text = '';
      return {
        set textContent(v) { text = String(v); },
        get innerHTML() { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
      };
    },
  };
  globalThis.fetch = async (input) => {
    queries.push(String(input));
    return { ok: true, status: 200, text: async () => JSON.stringify(rows) };
  };
  console.error = (...args) => errors.push(args.map(String).join(' '));
  try {
    await import(`../src/${file}?run=${++runNumber}`);
    // init() is fire-and-forget; every stub resolves at once, so it is done
    // as soon as the page has navigated or drawn something over the loader.
    const deadline = Date.now() + 2000;
    while (!replaced.length && app.innerHTML === LOADING && Date.now() < deadline) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    console.error = realConsoleError;
  }
  return { replaced, queries, errors, app, elements };
}

after(() => {
  console.error = realConsoleError;
  for (const [key, value] of Object.entries(realGlobals)) {
    if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  }
});

// resident.js: /perm/<qr>, /register/<qr>, /resident.html?qr=<qr>
test('resident.js sends an apartment to /apt/<qr>?role=resident, before any form is drawn', async () => {
  const page = await openPage('resident.js', `${ORIGIN}/perm/${QR}`, [APARTMENT]);
  assert.deepEqual(page.replaced, [`/apt/${QR}?role=resident`]);
  assert.equal(page.app.innerHTML, LOADING, 'the old form must not flash before the redirect');
  assert.deepEqual(page.errors, []);
});

test('resident.js reads the id from ?qr= too, and carries nothing else across', async () => {
  const page = await openPage('resident.js', `${ORIGIN}/resident.html?qr=${QR}&utm_source=sign`, [APARTMENT]);
  assert.deepEqual(page.replaced, [`/apt/${QR}?role=resident`]);
});

test('resident.js leaves a truck plaza on its own dead end', async () => {
  const page = await openPage('resident.js', `${ORIGIN}/perm/charlotte-travel-plaza`, [PLAZA]);
  assert.deepEqual(page.replaced, []);
  assert.match(page.app.innerHTML, /Use the parking-pass QR/);
});

test('resident.js still serves a property of any other type its own form', async () => {
  const page = await openPage('resident.js', `${ORIGIN}/perm/some-lot`, [UNTYPED]);
  assert.deepEqual(page.replaced, []);
  assert.match(page.app.innerHTML, /id="regForm"/);
  assert.deepEqual(page.errors, []);
});

test('resident.js does not redirect a link that matches no property', async () => {
  const page = await openPage('resident.js', `${ORIGIN}/perm/no-such-lot`, []);
  assert.deepEqual(page.replaced, []);
  assert.match(page.app.innerHTML, /Property Not Found/);
});

// visit.js: /temp/<qr>, /visit/<qr>, /visit.html?qr=<qr>
test('visit.js sends an apartment to /apt/<qr>?role=guest, before any form is drawn', async () => {
  const page = await openPage('visit.js', `${ORIGIN}/temp/${QR}`, [APARTMENT]);
  assert.deepEqual(page.replaced, [`/apt/${QR}?role=guest`]);
  assert.equal(page.app.innerHTML, LOADING, 'the old form must not flash before the redirect');
  assert.deepEqual(page.errors, []);
});

test('visit.js carries nothing but the role across, even from a payment-return link', async () => {
  const page = await openPage('visit.js', `${ORIGIN}/visit.html?qr=${QR}&plaza_payment_id=11111111-1111-4111-8111-111111111111`, [APARTMENT]);
  assert.deepEqual(page.replaced, [`/apt/${QR}?role=guest`]);
});

test('visit.js leaves a truck plaza on the plaza form', async () => {
  const page = await openPage('visit.js', `${ORIGIN}/temp/charlotte-travel-plaza`, [PLAZA]);
  assert.deepEqual(page.replaced, []);
  assert.match(page.app.innerHTML, /Truck License Plate/);
  assert.deepEqual(page.errors, []);
});

test('visit.js still serves a property of any other type its own form', async () => {
  const page = await openPage('visit.js', `${ORIGIN}/temp/some-lot`, [UNTYPED]);
  assert.deepEqual(page.replaced, []);
  assert.match(page.app.innerHTML, /id="passForm"/);
  assert.deepEqual(page.errors, []);
});

test('visit.js does not redirect a link that matches no property', async () => {
  const page = await openPage('visit.js', `${ORIGIN}/temp/no-such-lot`, []);
  assert.deepEqual(page.replaced, []);
  assert.match(page.app.innerHTML, /Lot Not Found/);
});

// apt.js: /apt/<qr>[?role=…]
test('apt.js opens the long-term form for ?role=resident, skipping the landing', async () => {
  const page = await openPage('apt.js', `${ORIGIN}/apt/${QR}?role=resident`, [APARTMENT]);
  assert.match(page.app.innerHTML, /id="residentForm"/);
  assert.doesNotMatch(page.app.innerHTML, /id="chooseResident"/);
  assert.deepEqual(page.errors, []);
});

test('apt.js opens the short-term form for ?role=guest, skipping the landing', async () => {
  const page = await openPage('apt.js', `${ORIGIN}/apt/${QR}?role=guest`, [APARTMENT]);
  assert.match(page.app.innerHTML, /id="guestForm"/);
  assert.doesNotMatch(page.app.innerHTML, /id="chooseGuest"/);
  assert.deepEqual(page.errors, []);
});

test('apt.js shows the landing with no role, and with a role it does not know', async () => {
  for (const search of ['', '?role=admin', '?role=', '?role=Resident']) {
    const page = await openPage('apt.js', `${ORIGIN}/apt/${QR}${search}`, [APARTMENT]);
    assert.match(page.app.innerHTML, /id="chooseResident"/, search);
    assert.match(page.app.innerHTML, /id="chooseGuest"/, search);
    assert.deepEqual(page.errors, [], search);
  }
});

test('the landing choices still lead to their forms', async () => {
  const page = await openPage('apt.js', `${ORIGIN}/apt/${QR}`, [APARTMENT]);
  page.elements.get('chooseGuest').handlers.click();
  assert.match(page.app.innerHTML, /id="guestForm"/);
  page.elements.get('backLink').handlers.click();
  page.elements.get('chooseResident').handlers.click();
  assert.match(page.app.innerHTML, /id="residentForm"/);
});

test('the back link on a form opened by ?role= still returns to the landing', async () => {
  for (const role of ['resident', 'guest']) {
    const page = await openPage('apt.js', `${ORIGIN}/apt/${QR}?role=${role}`, [APARTMENT]);
    assert.match(page.app.innerHTML, new RegExp(`id="${role}Form"`), `?role=${role} opens its form first`);
    page.elements.get('backLink').handlers.click();
    assert.match(page.app.innerHTML, /id="chooseResident"/, role);
    assert.match(page.app.innerHTML, /id="chooseGuest"/, role);
  }
});

test('apt.js honours ?role= on the ?qr= form of the link too', async () => {
  const page = await openPage('apt.js', `${ORIGIN}/apt.html?qr=${QR}&role=guest`, [APARTMENT]);
  assert.match(page.app.innerHTML, /id="guestForm"/);
  assert.match(page.queries[0], new RegExp(`qr_code_id=eq\\.${QR}\\b`));
});

// the whole route, hop by hop
test('an old /perm/ sign ends on the long-term form, and an old /temp/ sign on the short-term form', async () => {
  const perm = await openPage('resident.js', `${ORIGIN}/perm/${QR}`, [APARTMENT]);
  const landedPerm = await openPage('apt.js', new URL(perm.replaced[0], ORIGIN).href, [APARTMENT]);
  assert.match(landedPerm.app.innerHTML, /id="residentForm"/);

  const temp = await openPage('visit.js', `${ORIGIN}/temp/${QR}`, [APARTMENT]);
  const landedTemp = await openPage('apt.js', new URL(temp.replaced[0], ORIGIN).href, [APARTMENT]);
  assert.match(landedTemp.app.innerHTML, /id="guestForm"/);
});
