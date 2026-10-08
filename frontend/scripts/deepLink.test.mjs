// Unit tests for the dashboard's deep-link reader (src/lib/deepLink.js).
//
// Every portal email button lands on `/app?...` — `property`, `section`,
// `request`, `tab`, `firstrun`, `verify`, `upload`, `plate`. The reader is a
// pure function over a query string so it can be tested here without a DOM;
// `cleanDeepLink` and `returnToTarget` take an injected `window`-alike for the
// same reason.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  readDeepLink,
  cleanDeepLink,
  cleanedDeepLinkUrl,
  readPublicRoute,
  readJoinSlug,
  returnToTarget,
  readJoinReturnTo,
} from '../src/lib/deepLink.js';

function fakeWin(pathname, search) {
  const calls = [];
  return {
    calls,
    location: { pathname, search },
    history: { replaceState: (a, b, url) => calls.push(url) },
  };
}

test('readDeepLink: the signup landing link', () => {
  const dl = readDeepLink('?property=abc&section=requests&firstrun=1');
  assert.equal(typeof dl, 'object');
  assert.equal(dl.property, 'abc');
  assert.equal(dl.section, 'requests');
  assert.equal(dl.firstrun, true);
  assert.equal(dl.tab, null);
  assert.equal(dl.request, null);
  assert.equal(dl.verify, false);
  assert.equal(dl.upload, false);
  assert.equal(dl.plate, null);
});

test('readDeepLink: empty / missing search is all defaults', () => {
  for (const s of ['', '?', null, undefined]) {
    const dl = readDeepLink(s);
    assert.deepEqual(dl, {
      tab: null, property: null, section: null, request: null,
      firstrun: false, verify: false, upload: false, plate: null,
    });
  }
});

test('readDeepLink: the photo-upload link from a Slack [Photo sent] button', () => {
  const dl = readDeepLink('?property=p1&request=r9&upload=1');
  assert.equal(dl.property, 'p1');
  assert.equal(dl.request, 'r9');
  assert.equal(dl.upload, true);
});

test('readDeepLink: the lookup link and the verify link', () => {
  const lookup = readDeepLink('?tab=lookup&plate=ABC1234');
  assert.equal(lookup.tab, 'lookup');
  assert.equal(lookup.plate, 'ABC1234');
  assert.equal(readDeepLink('?verify=1').verify, true);
});

test('readDeepLink: flags are only true for 1/true/yes/bare', () => {
  assert.equal(readDeepLink('?firstrun=0').firstrun, false);
  assert.equal(readDeepLink('?firstrun=no').firstrun, false);
  assert.equal(readDeepLink('?firstrun=true').firstrun, true);
  assert.equal(readDeepLink('?firstrun').firstrun, true);
});

test('readDeepLink: blank values read as absent', () => {
  const dl = readDeepLink('?property=&section=%20');
  assert.equal(dl.property, null);
  assert.equal(dl.section, null);
});

test('cleanDeepLink leaves ?tab= out and keeps everything else', () => {
  const win = fakeWin('/app', '?tab=lookup&slack=connected');
  const url = cleanDeepLink(win);
  assert.equal(url, '/app?slack=connected');
  assert.deepEqual(win.calls, ['/app?slack=connected']);
  assert.ok(!url.includes('tab='));
});

test('cleanDeepLink drops the whole query when only deep-link keys were there', () => {
  const win = fakeWin('/app', '?property=abc&section=requests&firstrun=1');
  assert.equal(cleanDeepLink(win), '/app');
  assert.deepEqual(win.calls, ['/app']);
});

test('cleanedDeepLinkUrl is a no-op on a clean url', () => {
  assert.equal(cleanedDeepLinkUrl('/app', ''), '/app');
  assert.equal(cleanedDeepLinkUrl('/app', '?slack=connected'), '/app?slack=connected');
});

test('readPublicRoute maps the two rewritten paths', () => {
  assert.equal(readPublicRoute('/join'), 'join');
  assert.equal(readPublicRoute('/join/nstyle'), 'join');
  assert.equal(readPublicRoute('/r/abc.def.ghi'), 'request-action');
  assert.equal(readPublicRoute('/app'), null);
  assert.equal(readPublicRoute('/app/anything'), null);
  assert.equal(readPublicRoute(''), null);
  assert.equal(readPublicRoute(undefined), null);
});

test('readJoinSlug reads the partner slug, null for a bare /join', () => {
  assert.equal(readJoinSlug('/join/nstyle'), 'nstyle');
  assert.equal(readJoinSlug('/join/nstyle/extra'), 'nstyle');
  assert.equal(readJoinSlug('/join'), null);
  assert.equal(readJoinSlug('/join/'), null);
  assert.equal(readJoinSlug('/app'), null);
  assert.equal(readJoinSlug(undefined), null);
});

test('returnToTarget keeps only /app paths and always replays to /app', () => {
  assert.equal(returnToTarget('/app?property=abc&request=r1'), '/app?property=abc&request=r1');
  assert.equal(returnToTarget('/app'), '/app');
  assert.equal(returnToTarget('/app/'), '/app');
  assert.equal(returnToTarget('/join/nstyle?x=1'), null);
  assert.equal(returnToTarget(''), null);
  assert.equal(returnToTarget(null), null);
});

test('readJoinReturnTo honours only /join and /join/<slug>', () => {
  assert.deepEqual(readJoinReturnTo('?return_to=%2Fjoin%2Fnstyle'),
    { present: true, path: '/join/nstyle', slug: 'nstyle', rest: '' });
  assert.deepEqual(readJoinReturnTo('?return_to=%2Fjoin'),
    { present: true, path: '/join', slug: null, rest: '' });
  // Kept: the other keys, in place.
  assert.equal(readJoinReturnTo('?tab=lots&return_to=%2Fjoin%2Fn-s_1').rest, '?tab=lots');
  assert.equal(readJoinReturnTo('?tab=lots&return_to=%2Fjoin%2Fn-s_1').slug, 'n-s_1');
  // Refused, but still `present` so the caller strips the key.
  for (const bad of [
    'https://evil.example/join/nstyle', '//evil.example', '/join/', '/join/a/b',
    '/join/nstyle?x=1', '/join/nstyle#x', '/app', '/joinx', '/join/%2e%2e', 'javascript:alert(1)', '',
  ]) {
    const r = readJoinReturnTo(`?return_to=${encodeURIComponent(bad)}`);
    assert.equal(r.present, true, bad);
    assert.equal(r.path, null, bad);
    assert.equal(r.slug, null, bad);
  }
  assert.deepEqual(readJoinReturnTo('?tab=lots'), { present: false, path: null, slug: null, rest: '?tab=lots' });
  assert.equal(readJoinReturnTo(undefined).present, false);
});

test('returnToTarget leaves a return_to query to App.jsx', () => {
  assert.equal(returnToTarget('/app?return_to=%2Fjoin%2Fnstyle'), null);
  assert.equal(returnToTarget('/app?tab=lots&return_to=x'), null);
});
