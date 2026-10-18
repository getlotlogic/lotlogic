// Unit tests for the native-shell bridge (src/lib/native.js).
//
// Inside the LotLogic iPhone app the dashboard runs in a WebView that puts
// `window.ReactNativeWebView` on the page. The bridge posts the session to
// the shell and gives the shell `window.LOTLOGIC_NATIVE_OPEN(url)` for a push
// tap. Everything here is a pure function or takes an injected window-alike,
// so it runs without a DOM; tests/e2e/native-bridge.spec.ts drives the real
// page.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  APP_ORIGIN,
  NATIVE,
  nativePost,
  postToShell,
  sessionMessage,
  SIGNED_OUT_MESSAGE,
  nativeOpenTarget,
  nativeDeepLink,
  createNativeOpenRouter,
} from '../src/lib/native.js';

// ── where the bridge lives ─────────────────────────────────────

test('APP_ORIGIN is the dashboard origin the push links name', () => {
  assert.equal(APP_ORIGIN, 'https://lotlogicparking.com');
});

test('outside a WebView (no window at all) NATIVE is false and nativePost posts nothing', () => {
  assert.equal(NATIVE, false);
  assert.equal(nativePost({ type: 'session', token: 't0k3n' }), false);
});

// ── posting ────────────────────────────────────────────────────

test('postToShell: no ReactNativeWebView on the window posts nothing and does not throw', () => {
  assert.equal(postToShell({}, { type: 'signed_out' }), false);
  assert.equal(postToShell(null, { type: 'signed_out' }), false);
  assert.equal(postToShell({ ReactNativeWebView: {} }, { type: 'signed_out' }), false);
});

test('postToShell: hands the shell one JSON string', () => {
  const sent = [];
  const win = { ReactNativeWebView: { postMessage: (m) => sent.push(m) } };
  assert.equal(postToShell(win, { type: 'signed_out' }), true);
  assert.equal(sent.length, 1);
  assert.equal(typeof sent[0], 'string');
  assert.deepEqual(JSON.parse(sent[0]), { type: 'signed_out' });
});

test('postToShell: a shell that throws never breaks the page', () => {
  const win = { ReactNativeWebView: { postMessage: () => { throw new Error('bridge gone'); } } };
  assert.equal(postToShell(win, { type: 'signed_out' }), false);
});

// ── the two messages ───────────────────────────────────────────

test('sessionMessage: exactly {type, token, email, role} from the stored session', () => {
  const session = {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'truck@example.com',
    business_name: 'Example Towing',
    is_admin: false,
    is_platform_admin: false,
    _role: 'partner',
    _token: 't0k3n',
    _expires_in: 604800,
    _ts: 1,
  };
  assert.deepEqual(sessionMessage(session), {
    type: 'session', token: 't0k3n', email: 'truck@example.com', role: 'partner',
  });
  assert.deepEqual(Object.keys(sessionMessage(session)), ['type', 'token', 'email', 'role']);
});

test('sessionMessage: an owner session says role "owner"', () => {
  assert.deepEqual(
    sessionMessage({ _token: 't0k3n', email: 'office@example.com', _role: 'owner' }),
    { type: 'session', token: 't0k3n', email: 'office@example.com', role: 'owner' },
  );
});

test('sessionMessage: no token, no message', () => {
  assert.equal(sessionMessage(null), null);
  assert.equal(sessionMessage(undefined), null);
  assert.equal(sessionMessage({ email: 'office@example.com', _role: 'owner' }), null);
  assert.equal(sessionMessage({ _token: '', email: 'office@example.com', _role: 'owner' }), null);
});

test('SIGNED_OUT_MESSAGE is {type: "signed_out"} and cannot be edited', () => {
  assert.deepEqual(SIGNED_OUT_MESSAGE, { type: 'signed_out' });
  assert.ok(Object.isFrozen(SIGNED_OUT_MESSAGE));
});

// ── what LOTLOGIC_NATIVE_OPEN accepts ──────────────────────────

test('nativeOpenTarget: the dashboard origin\'s /app links, as a path and query', () => {
  const cases = [
    ['https://lotlogicparking.com/app', '/app'],
    ['https://lotlogicparking.com/app?property=p1&section=requests&request=r1',
      '/app?property=p1&section=requests&request=r1'],
    ['https://lotlogicparking.com/app/', '/app/'],
    ['https://lotlogicparking.com/app?property=p1#row', '/app?property=p1'],
    ['/app', '/app'],
    ['/app?tab=lookup&plate=ABC1234', '/app?tab=lookup&plate=ABC1234'],
    ['  /app?property=p1  ', '/app?property=p1'],
  ];
  for (const [url, want] of cases) assert.equal(nativeOpenTarget(url), want, url);
});

test('nativeOpenTarget: anything that is not an /app link on the dashboard origin is ignored', () => {
  const rejected = [
    'https://evil.example/app?property=p1&request=r1',
    'http://lotlogicparking.com/app?property=p1',
    'https://www.lotlogicparking.com/app?property=p1',
    'https://lotlogicparking.com.evil.example/app',
    'https://lotlogicparking.com@evil.example/app',
    'https://user:pw@lotlogicparking.com/app',
    'https://lotlogicparking.com:8443/app',
    '//evil.example/app?property=p1',
    '/\\evil.example/app?property=p1',
    'javascript:alert(1)',
    'data:text/html,<p>hi</p>',
    'lotlogic://open?url=/app',
    'https://lotlogicparking.com/admin',
    'https://lotlogicparking.com/apple',
    'https://lotlogicparking.com/join/nstyle',
    '/application',
    '/r/some-token',
    'app?property=p1',
    '',
    '   ',
    null,
    undefined,
    42,
    {},
  ];
  for (const url of rejected) assert.equal(nativeOpenTarget(url), null, String(url));
});

// ── where it routes ────────────────────────────────────────────

test('nativeDeepLink: a request link with no section opens the Requests section', () => {
  const link = nativeDeepLink('/app?property=p1&request=r1');
  assert.equal(link.property, 'p1');
  assert.equal(link.request, 'r1');
  assert.equal(link.section, 'requests');
});

test('nativeDeepLink: an explicit section is kept', () => {
  assert.equal(nativeDeepLink('/app?property=p1&section=requests&request=r1').section, 'requests');
  assert.equal(nativeDeepLink('/app?property=p1&section=log&request=r1').section, 'log');
});

test('nativeDeepLink: the rest of the deep link reads as the page reads it', () => {
  assert.deepEqual(nativeDeepLink('/app?tab=lookup&plate=ABC1234'), {
    tab: 'lookup', property: null, section: null, request: null,
    firstrun: false, verify: false, upload: false, plate: 'ABC1234',
  });
  assert.deepEqual(nativeDeepLink('/app?property=p1&request=r1&upload=1'), {
    tab: null, property: 'p1', section: 'requests', request: 'r1',
    firstrun: false, verify: false, upload: true, plate: null,
  });
  assert.deepEqual(nativeDeepLink('/app'), {
    tab: null, property: null, section: null, request: null,
    firstrun: false, verify: false, upload: false, plate: null,
  });
});

// ── the open router (the shell can call before the app has mounted) ──

test('router: an open with no listener yet is kept and delivered once on listen', () => {
  const router = createNativeOpenRouter();
  assert.equal(router.open('https://lotlogicparking.com/app?property=p1&request=r1'), true);
  const got = [];
  router.listen((t) => got.push(t));
  assert.deepEqual(got, ['/app?property=p1&request=r1']);
  const again = [];
  router.listen((t) => again.push(t));
  assert.deepEqual(again, [], 'the kept open is delivered once, not replayed');
});

test('router: only the latest early open is kept', () => {
  const router = createNativeOpenRouter();
  router.open('/app?property=p1');
  router.open('/app?property=p2');
  const got = [];
  router.listen((t) => got.push(t));
  assert.deepEqual(got, ['/app?property=p2']);
});

test('router: a listener gets every accepted open and none of the ignored ones', () => {
  const router = createNativeOpenRouter();
  const got = [];
  router.listen((t) => got.push(t));
  assert.equal(router.open('https://evil.example/app?property=p1'), false);
  assert.equal(router.open('/app?property=p1&request=r1'), true);
  assert.equal(router.open('/app?property=p1&request=r2'), true);
  assert.deepEqual(got, ['/app?property=p1&request=r1', '/app?property=p1&request=r2']);
});

test('router: after the listener leaves, opens are kept for the next one', () => {
  const router = createNativeOpenRouter();
  const first = [];
  const stop = router.listen((t) => first.push(t));
  stop();
  router.open('/app?property=p3');
  assert.deepEqual(first, []);
  const second = [];
  router.listen((t) => second.push(t));
  assert.deepEqual(second, ['/app?property=p3']);
});

test('router: an ignored early open does not displace a kept one', () => {
  const router = createNativeOpenRouter();
  router.open('/app?property=p1');
  router.open('https://evil.example/app?property=p9');
  const got = [];
  router.listen((t) => got.push(t));
  assert.deepEqual(got, ['/app?property=p1']);
});
