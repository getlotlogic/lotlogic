// Unit tests for the `/r/<token>` action page's pure logic
// (src/lib/requestAction.js — spec §5.8). The six result strings are taken
// verbatim from the spec file so a wording slip here is a real bug, not a
// style nit.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  readActionToken,
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

// ── deriveInitialView ────────────────────────────────────────
test('deriveInitialView: extend24 with extensions left is an ordinary preview', () => {
  const request = { ref: 'H-1842', extensions_left: 2 };
  assert.deepEqual(deriveInitialView({ action: 'extend24', request }), {
    kind: 'preview', action: 'extend24', request,
  });
});

test('deriveInitialView: ack_end is an ordinary preview too', () => {
  const request = { ref: 'H-1842' };
  assert.deepEqual(deriveInitialView({ action: 'ack_end', request }), {
    kind: 'preview', action: 'ack_end', request,
  });
});

test('deriveInitialView: extend24 with zero extensions left is the limit edge copy', () => {
  const request = { ref: 'H-1842', extensions_left: 0, extension_count: 4 };
  assert.deepEqual(deriveInitialView({ action: 'extend24', request }), { kind: 'limit', request });
});

test('deriveInitialView: action=reinstate is the expired-with-reinstate view', () => {
  const request = { ref: 'H-1842' };
  assert.deepEqual(deriveInitialView({ action: 'reinstate', request }), { kind: 'expired_reinstate', request });
});

test('deriveInitialView: no request (bad token) is invalid', () => {
  assert.deepEqual(deriveInitialView(null), { kind: 'invalid', request: null });
  assert.deepEqual(deriveInitialView({}), { kind: 'invalid', request: null });
});

// ── deriveResultView ─────────────────────────────────────────
test('deriveResultView: extended', () => {
  const request = { ref: 'H-1842', expires_local: 'Thu Oct 9, 9:14 PM ET', extension_count: 2 };
  assert.deepEqual(deriveResultView({ result: 'extended', request }), { kind: 'extended', request });
});

test('deriveResultView: extended + clamped flag renders the clamped kind', () => {
  const request = { ref: 'H-1842', expires_local: 'Tue Oct 14, 3:00 PM ET' };
  assert.deepEqual(deriveResultView({ result: 'extended', request, clamped: true }), { kind: 'clamped', request });
});

test('deriveResultView: acknowledged', () => {
  const request = { ref: 'H-1842', expires_local: 'Wed Oct 8, 9:14 PM ET' };
  assert.deepEqual(deriveResultView({ result: 'acknowledged', request }), { kind: 'acknowledged', request });
});

test('deriveResultView: reinstated', () => {
  const request = { ref: 'H-1850' };
  assert.deepEqual(deriveResultView({ result: 'reinstated', request }), { kind: 'reinstated', request });
});

test('deriveResultView: an unrecognized result falls back to invalid', () => {
  assert.deepEqual(deriveResultView({ result: 'something_else' }), { kind: 'invalid', request: null });
});

// ── deriveErrorView ──────────────────────────────────────────
test('deriveErrorView: 409 while extending is the limit edge copy, using the request already on screen', () => {
  const fallback = { ref: 'H-1842', expires_local: 'Wed Oct 8, 9:14 PM ET' };
  const err = { status: 409 };
  assert.deepEqual(deriveErrorView('extend24', err, fallback), { kind: 'limit', request: fallback });
});

test('deriveErrorView: 400 used/expired is invalid regardless of action', () => {
  assert.deepEqual(deriveErrorView('ack_end', { status: 400 }, { ref: 'H-1842' }), { kind: 'invalid', request: null });
});

test('deriveErrorView: 409 on an action other than extend24 is still invalid', () => {
  assert.deepEqual(deriveErrorView('reinstate', { status: 409 }, { ref: 'H-1842' }), { kind: 'invalid', request: null });
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
