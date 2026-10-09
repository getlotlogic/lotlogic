// Unit tests for the `/r/<token>` action page's pure logic
// (src/lib/requestAction.js — spec §5.8). The result strings are taken
// verbatim from the spec file so a wording slip here is a real bug, not a
// style nit.
//
// The response fixtures below are copied from the backend's real contract
// (lotlogic-backend `routers/request_actions.py` + its
// `tests/portal/test_request_actions_db.py`), not from what the page wishes
// it got:
//   * GET  /requests/action → `{action, request}`; `action` is ALWAYS the
//     token's own baked-in action (`claims['a']`). The preview never
//     recomputes `reinstate` for an ended hold.
//   * POST, refused extension (`extension_limit` / `hold_window`) → HTTP 200
//     `{result:'limit', request, expires_local, extension_count}`.
//   * POST on a hold that already ended → 409 `{detail:'not_active'}` (the
//     only 409 on the extend24 / ack_end path; no `request` in the body).
//   * POST `{token, action:'reinstate'}` is accepted for an extend24 or
//     ack_end token (`test_an_extend_link_can_reinstate_via_the_action_override`).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  readActionToken,
  hideActionToken,
  shortTime,
  previewCopy,
  actionButtonLabel,
  deriveInitialView,
  deriveResultView,
  deriveErrorView,
  resultCopy,
  bodyText,
  ctaLabel,
  ctaAction,
  needsSignIn,
  signInHref,
} from '../src/lib/requestAction.js';

// ── readActionToken — path only, query ignored ──────────────
test('readActionToken: plain /r/<token>', () => {
  assert.equal(readActionToken('/r/abc123'), 'abc123');
});

test('readActionToken: trailing slash and extra segments are part of the token up to the next /', () => {
  assert.equal(readActionToken('/r/abc.def-GHI_123'), 'abc.def-GHI_123');
});

test('readActionToken: a bare /r or /r/ has no token', () => {
  assert.equal(readActionToken('/r'), null);
  assert.equal(readActionToken('/r/'), null);
});

test('readActionToken: not a /r/ path at all', () => {
  assert.equal(readActionToken('/app'), null);
  assert.equal(readActionToken('/join/n-style'), null);
  assert.equal(readActionToken(''), null);
  assert.equal(readActionToken(null), null);
});

test('readActionToken: the query string is never consulted, even a conflicting ?token=', () => {
  // The two email buttons are two different tokens at the same exact path
  // (spec §5.8) — a `?token=` on the querystring must never win over, or
  // get confused with, the path segment. readActionToken only ever sees
  // pathname, so this is really asserting the function's contract, but it
  // is the exact failure mode the brief calls out: "query ignored."
  assert.equal(readActionToken('/r/real-token'), 'real-token');
  // Simulate a caller that (wrongly) concatenated the search string onto
  // the pathname it passed in — the match stops at the `?`, proving the
  // regex itself treats `?` as a boundary rather than swallowing it.
  assert.equal(readActionToken('/r/real-token?token=decoy'), 'real-token');
});

test('readActionToken: percent-encoding is decoded', () => {
  assert.equal(readActionToken('/r/abc%2Edef'), 'abc.def');
});

// ── hideActionToken — the 48 h bearer token leaves the address bar ──
function fakeWindow(pathname, search = '', hash = '') {
  const calls = [];
  return {
    calls,
    location: { pathname, search, hash },
    history: { replaceState: (state, title, url) => { calls.push(url); } },
  };
}

test('hideActionToken: /r/<token> is replaced with a bare /r', () => {
  const w = fakeWindow('/r/eyJhbGciOi.secret.sig');
  assert.equal(hideActionToken(w), true);
  assert.deepEqual(w.calls, ['/r']);
});

test('hideActionToken: a query or hash on the link goes too — nothing of the link survives', () => {
  const w = fakeWindow('/r/tok', '?utm=mail', '#x');
  hideActionToken(w);
  assert.deepEqual(w.calls, ['/r']);
});

test('hideActionToken: a path with no token is left alone', () => {
  for (const p of ['/r', '/r/', '/app', '/join/n-style']) {
    const w = fakeWindow(p);
    assert.equal(hideActionToken(w), false);
    assert.deepEqual(w.calls, [], p);
  }
});

test('hideActionToken: a history that throws (sandboxed frame) never breaks the page', () => {
  const w = { location: { pathname: '/r/tok' }, history: { replaceState() { throw new Error('blocked'); } } };
  assert.equal(hideActionToken(w), false);
  assert.equal(hideActionToken(undefined), false);
});

// ── shortTime ────────────────────────────────────────────────
test('shortTime: pulls the trailing clock-time off a full local string', () => {
  assert.equal(shortTime('Wed Oct 8, 9:14 PM ET'), '9:14 PM ET');
});

test('shortTime: already-short input passes through', () => {
  assert.equal(shortTime('9:14 PM ET'), '9:14 PM ET');
});

test('shortTime: non-string input is empty, not a throw', () => {
  assert.equal(shortTime(undefined), '');
  assert.equal(shortTime(null), '');
});

// ── previewCopy ──────────────────────────────────────────────
test('previewCopy: the on-mount preview line (spec §5.8 / brief verbatim)', () => {
  const request = {
    property_name: 'Sunset Ridge Apartments',
    plate: 'ABC1234',
    expires_local: 'Wed Oct 8, 9:14 PM ET',
  };
  assert.equal(
    previewCopy(request),
    'Hold at Sunset Ridge Apartments · ABC1234 · until Wed Oct 8, 9:14 PM ET'
  );
});

test('previewCopy: no request yet is empty, not "Hold at undefined"', () => {
  assert.equal(previewCopy(null), '');
});

// ── actionButtonLabel ────────────────────────────────────────
test('actionButtonLabel: extend24', () => {
  assert.equal(actionButtonLabel('extend24', { expires_local: 'Wed Oct 8, 9:14 PM ET' }), 'Extend 24 hours');
});

test('actionButtonLabel: ack_end carries the short clock time', () => {
  assert.equal(
    actionButtonLabel('ack_end', { expires_local: 'Wed Oct 8, 9:14 PM ET' }),
    'OK — it ends at 9:14 PM ET'
  );
});

test('actionButtonLabel: reinstate', () => {
  assert.equal(actionButtonLabel('reinstate', {}), 'Hold again for 24 hours');
});

// ── Backend-shaped fixtures ─────────────────────────────────
// `services.tow_requests._fetch` — trimmed to the fields the page reads.
function hold(over = {}) {
  return {
    id: 'req-1', ref: 'H-1842', property_id: 'prop-1', kind: 'hold', status: 'active',
    plate: 'ABC1234', expires_local: 'Wed Oct 8, 9:14 PM ET', hours_left: 1,
    extension_count: 1, extensions_left: 3, ...over,
  };
}
// The `ApiError` `api.js` throws: `.status`, `.body`, `.code = body.detail`.
function apiError(status, body) {
  const err = new Error(String(body && body.detail));
  err.status = status;
  err.body = body;
  err.code = typeof body?.detail === 'string' ? body.detail : undefined;
  return err;
}
// 200 for a refused extension (`_extend`'s `extension_limit` / `hold_window` branch).
const LIMIT_200 = {
  result: 'limit',
  request: hold({ extension_count: 4, extensions_left: 0 }),
  expires_local: 'Wed Oct 8, 9:14 PM ET',
  extension_count: 4,
};
// 409 for a hold that has already ended (`svc.extend` → `not_active`).
const NOT_ACTIVE_409 = apiError(409, { detail: 'not_active' });

// ── deriveInitialView ────────────────────────────────────────
test('deriveInitialView: extend24 with extensions left is an ordinary preview', () => {
  const request = hold();
  assert.deepEqual(deriveInitialView({ action: 'extend24', request }), {
    kind: 'preview', action: 'extend24', request,
  });
});

test('deriveInitialView: ack_end is an ordinary preview too', () => {
  const request = hold();
  assert.deepEqual(deriveInitialView({ action: 'ack_end', request }), {
    kind: 'preview', action: 'ack_end', request,
  });
});

test('deriveInitialView: extend24 with zero extensions left is the limit edge copy', () => {
  const request = hold({ extension_count: 4, extensions_left: 0 });
  assert.deepEqual(deriveInitialView({ action: 'extend24', request }), { kind: 'limit', request });
});

test('deriveInitialView: a reinstate token (action echoed as-is) is the ended view', () => {
  const request = hold({ status: 'expired' });
  assert.deepEqual(deriveInitialView({ action: 'reinstate', request }), { kind: 'expired_reinstate', request });
});

test('deriveInitialView: no request (bad token) is invalid', () => {
  assert.deepEqual(deriveInitialView(null), { kind: 'invalid', request: null });
  assert.deepEqual(deriveInitialView({}), { kind: 'invalid', request: null });
});

// ── deriveResultView ─────────────────────────────────────────
test('deriveResultView: extended', () => {
  const request = hold({ expires_local: 'Thu Oct 9, 9:14 PM ET', extension_count: 2, extensions_left: 2 });
  const body = { result: 'extended', request, clamped: false, expires_local: request.expires_local };
  assert.deepEqual(deriveResultView(body), { kind: 'extended', request });
});

test('deriveResultView: extended + clamped flag renders the clamped kind', () => {
  const request = hold({ expires_local: 'Tue Oct 14, 3:00 PM ET' });
  const body = { result: 'extended', request, clamped: true, expires_local: request.expires_local };
  assert.deepEqual(deriveResultView(body), { kind: 'clamped', request });
});

test('deriveResultView: acknowledged', () => {
  const request = hold();
  assert.deepEqual(deriveResultView({ result: 'acknowledged', request, expires_local: request.expires_local }),
    { kind: 'acknowledged', request });
});

test('deriveResultView: reinstated', () => {
  const request = hold({ ref: 'H-1850', extension_count: 0, extensions_left: 4 });
  assert.deepEqual(deriveResultView({ result: 'reinstated', request, expires_local: request.expires_local }),
    { kind: 'reinstated', request });
});

test('deriveResultView: the backend\'s 200 `limit` is the limit view, not "link expired"', () => {
  const view = deriveResultView(LIMIT_200);
  assert.equal(view.kind, 'limit');
  assert.equal(view.request.ref, 'H-1842');
  assert.equal(
    resultCopy(view),
    'All 4 extensions are used. H-1842 ends at Wed Oct 8, 9:14 PM ET. Sign in to place a new hold after it ends.'
  );
  assert.equal(needsSignIn(view), true);
  assert.equal(ctaLabel(view), null);
});

test('deriveResultView: a `limit` body without `request` still renders its ref from the page\'s request', () => {
  const body = { result: 'limit', expires_local: 'Wed Oct 8, 9:14 PM ET', extension_count: 4 };
  const view = deriveResultView(body, hold({ expires_local: 'stale' }));
  assert.equal(view.kind, 'limit');
  assert.equal(
    resultCopy(view),
    'All 4 extensions are used. H-1842 ends at Wed Oct 8, 9:14 PM ET. Sign in to place a new hold after it ends.'
  );
});

test('deriveResultView: an unrecognized result falls back to invalid', () => {
  assert.deepEqual(deriveResultView({ result: 'something_else' }), { kind: 'invalid', request: null });
});

// ── deriveErrorView ──────────────────────────────────────────
test('deriveErrorView: 409 not_active on extend24 is the ended state with Hold again', () => {
  const onScreen = hold();
  const view = deriveErrorView('extend24', NOT_ACTIVE_409, onScreen);
  assert.deepEqual(view, { kind: 'expired_reinstate', request: onScreen });
  assert.equal(bodyText(view), 'H-1842 ended at Wed Oct 8, 9:14 PM ET.');
  assert.equal(ctaLabel(view), 'Hold again for 24 hours');
  assert.equal(ctaAction(view), 'reinstate');
});

test('deriveErrorView: 409 not_active on ack_end is the same ended state', () => {
  const onScreen = hold();
  assert.deepEqual(deriveErrorView('ack_end', NOT_ACTIVE_409, onScreen), { kind: 'expired_reinstate', request: onScreen });
});

test('deriveErrorView: 409 not_active never claims the extensions are used up', () => {
  const view = deriveErrorView('extend24', NOT_ACTIVE_409, hold());
  assert.notEqual(view.kind, 'limit');
  assert.ok(!resultCopy(view).includes('All 4 extensions'));
});

test('deriveErrorView: a 409 with any other code on extend24 is invalid, not limit', () => {
  assert.deepEqual(deriveErrorView('extend24', apiError(409, { detail: 'something_else' }), hold()),
    { kind: 'invalid', request: null });
});

test('deriveErrorView: 409 from a reinstate attempt (not_reinstatable / reinstate_window) is invalid', () => {
  assert.deepEqual(deriveErrorView('reinstate', apiError(409, { detail: 'reinstate_window' }), hold()),
    { kind: 'invalid', request: null });
  assert.deepEqual(deriveErrorView('reinstate', NOT_ACTIVE_409, hold()), { kind: 'invalid', request: null });
});

test('deriveErrorView: 400 link_used / link_invalid is invalid regardless of action', () => {
  assert.deepEqual(deriveErrorView('ack_end', apiError(400, { detail: 'link_used' }), hold()), { kind: 'invalid', request: null });
  assert.deepEqual(deriveErrorView('extend24', apiError(400, { detail: 'link_invalid' }), hold()), { kind: 'invalid', request: null });
});

// ── acknowledged with no extensions left ─────────────────────
test('acknowledged with 0 extensions left offers no "[Extend 24 hours instead]"', () => {
  const request = hold({ extension_count: 4, extensions_left: 0 });
  const view = deriveResultView({ result: 'acknowledged', request, expires_local: request.expires_local });
  assert.equal(view.kind, 'acknowledged');
  assert.equal(ctaLabel(view), null);
  assert.equal(ctaAction(view), null);
  assert.equal(bodyText(view), 'Got it. H-1842 ends at Wed Oct 8, 9:14 PM ET as planned.');
  assert.ok(!resultCopy(view).includes('Extend 24 hours instead'));
});

test('acknowledged falls back to extension_count >= 4 when extensions_left is absent', () => {
  const request = hold({ extension_count: 4 });
  delete request.extensions_left;
  assert.equal(ctaLabel({ kind: 'acknowledged', request }), null);
});

test('acknowledged with extensions left still offers "[Extend 24 hours instead]"', () => {
  const view = { kind: 'acknowledged', request: hold({ extension_count: 3, extensions_left: 1 }) };
  assert.equal(ctaLabel(view), 'Extend 24 hours instead');
  assert.equal(ctaAction(view), 'extend24');
});

// ── resultCopy — the six spec-verbatim outcomes ─────────────
test('resultCopy: extended', () => {
  const view = { kind: 'extended', request: { ref: 'H-1842', expires_local: 'Thu Oct 9, 9:14 PM ET', extension_count: 2 } };
  assert.equal(resultCopy(view), 'Extended to Thu Oct 9, 9:14 PM ET · H-1842 · extension 2 of 4');
});

test('resultCopy: clamped', () => {
  const view = { kind: 'clamped', request: { expires_local: 'Tue Oct 14, 3:00 PM ET' } };
  assert.equal(resultCopy(view), 'Extended as far as allowed — to Tue Oct 14, 3:00 PM ET');
});

test('resultCopy: acknowledged', () => {
  const view = { kind: 'acknowledged', request: { ref: 'H-1842', expires_local: 'Wed Oct 8, 9:14 PM ET' } };
  assert.equal(resultCopy(view), 'Got it. H-1842 ends at Wed Oct 8, 9:14 PM ET as planned. [Extend 24 hours instead]');
});

test('resultCopy: limit', () => {
  const view = { kind: 'limit', request: { ref: 'H-1842', expires_local: 'Wed Oct 8, 9:14 PM ET' } };
  assert.equal(resultCopy(view), 'All 4 extensions are used. H-1842 ends at Wed Oct 8, 9:14 PM ET. Sign in to place a new hold after it ends.');
});

test('resultCopy: expired-with-reinstate', () => {
  const view = { kind: 'expired_reinstate', request: { ref: 'H-1842', expires_local: '9:14 PM ET' } };
  assert.equal(resultCopy(view), 'H-1842 ended at 9:14 PM ET. [Hold again for 24 hours]');
});

test('resultCopy: used/invalid', () => {
  assert.equal(resultCopy({ kind: 'invalid', request: null }), 'This link has expired. Sign in to manage the hold.');
});

test('resultCopy: an unknown kind renders nothing rather than throwing', () => {
  assert.equal(resultCopy({ kind: 'nonsense' }), '');
  assert.equal(resultCopy(undefined), '');
});

// ── bodyText / ctaLabel / ctaAction / needsSignIn ───────────
test('bodyText strips the trailing bracketed button off acknowledged', () => {
  const view = { kind: 'acknowledged', request: { ref: 'H-1842', expires_local: 'Wed Oct 8, 9:14 PM ET' } };
  assert.equal(bodyText(view), 'Got it. H-1842 ends at Wed Oct 8, 9:14 PM ET as planned.');
  assert.equal(ctaLabel(view), 'Extend 24 hours instead');
  assert.equal(ctaAction(view), 'extend24');
});

test('bodyText strips the trailing bracketed button off expired_reinstate', () => {
  const view = { kind: 'expired_reinstate', request: { ref: 'H-1842', expires_local: '9:14 PM ET' } };
  assert.equal(bodyText(view), 'H-1842 ended at 9:14 PM ET.');
  assert.equal(ctaLabel(view), 'Hold again for 24 hours');
  assert.equal(ctaAction(view), 'reinstate');
});

test('bodyText is a no-op when there is no bracket (extended has none)', () => {
  const view = { kind: 'extended', request: { ref: 'H-1842', expires_local: 'Thu Oct 9, 9:14 PM ET', extension_count: 2 } };
  assert.equal(bodyText(view), resultCopy(view));
  assert.equal(ctaLabel(view), null);
  assert.equal(ctaAction(view), null);
});

test('needsSignIn: exactly the views whose copy sends the reader to sign in', () => {
  assert.equal(needsSignIn({ kind: 'extended' }), true);
  assert.equal(needsSignIn({ kind: 'clamped' }), true);
  assert.equal(needsSignIn({ kind: 'limit' }), true);
  assert.equal(needsSignIn({ kind: 'invalid' }), true);
  assert.equal(needsSignIn({ kind: 'reinstated' }), true);
  assert.equal(needsSignIn({ kind: 'acknowledged' }), false);
  assert.equal(needsSignIn({ kind: 'expired_reinstate' }), false);
  assert.equal(needsSignIn({ kind: 'preview' }), false);
});

// ── signInHref ───────────────────────────────────────────────
test('signInHref: the LoginPage return-to target (spec §5.8 / brief)', () => {
  assert.equal(
    signInHref({ property_id: 'prop-1', id: 'req-1' }),
    '/app?property=prop-1&request=req-1'
  );
});

test('signInHref: falls back to plain /app when the request is unknown', () => {
  assert.equal(signInHref(null), '/app');
  assert.equal(signInHref({}), '/app');
});
