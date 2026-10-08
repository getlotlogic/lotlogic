// Unit tests for errorFromResponse() in src/lib/api.js — the single place
// every portal error body is turned into an Error the UI can branch on.
//
// Portal routes answer `{"detail": "<code>", ...extra}`; the frontend reads
// `err.code` for the branch and `err.body` for the extras (`request_id`,
// `retry_after`, `tries_left`, `candidates`). `err.message` keeps today's
// derivation exactly, including the Pydantic 422 array shape.
//
// api.js's top level is constants and function declarations only, so it
// imports cleanly under node with no DOM.
import test from 'node:test';
import assert from 'node:assert/strict';

import { errorFromResponse } from '../src/lib/api.js';
import { requestsApi } from '../src/lib/requestsApi.js';

test('a portal error code with extras', () => {
  const err = errorFromResponse(409, { detail: 'active_hold_exists', request_id: 'r1' });
  assert.ok(err instanceof Error);
  assert.equal(err.status, 409);
  assert.equal(err.code, 'active_hold_exists');
  assert.equal(err.body.request_id, 'r1');
  assert.equal(err.message, 'active_hold_exists');
});

test('a Pydantic 422 array keeps the readable message and has no code', () => {
  const err = errorFromResponse(422, { detail: [{ msg: 'x' }] });
  assert.equal(err.code, undefined);
  assert.equal(err.message, 'x');
  assert.equal(err.status, 422);
  assert.deepEqual(err.body, { detail: [{ msg: 'x' }] });
});

test('a 422 array with several messages joins them, as it does today', () => {
  const err = errorFromResponse(422, { detail: [{ msg: 'a' }, { msg: 'b' }] });
  assert.equal(err.message, 'a, b');
  assert.equal(err.code, undefined);
});

test('no body at all', () => {
  const err = errorFromResponse(500, null);
  assert.equal(err.message, 'Server error (500)');
  assert.equal(err.body, null);
  assert.equal(err.code, undefined);
  assert.equal(err.status, 500);
});

test('an unparseable body is the same as no body', () => {
  const err = errorFromResponse(502, undefined);
  assert.equal(err.message, 'Server error (502)');
  assert.equal(err.body, null);
});

test('the legacy { error } shape still renders', () => {
  const err = errorFromResponse(400, { error: 'nope' });
  assert.equal(err.message, 'nope');
  assert.equal(err.code, undefined);
  assert.deepEqual(err.body, { error: 'nope' });
});

test('an empty object body falls back to the status message', () => {
  const err = errorFromResponse(403, {});
  assert.equal(err.message, 'Server error (403)');
  assert.equal(err.code, undefined);
});

test('an empty 422 array keeps the status message', () => {
  const err = errorFromResponse(422, { detail: [] });
  assert.equal(err.message, 'Server error (422)');
});

test('a requestsApi wrapper rethrows apiFetch\'s error untouched', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 409,
    json: async () => ({ detail: 'active_hold_exists', request_id: 'r1' }),
  });
  try {
    let thrown = null;
    try {
      await requestsApi.createRequest({ property_id: 'p1', kind: 'hold', plate_text: 'ABC1234' });
    } catch (e) { thrown = e; }
    assert.ok(thrown instanceof Error, 'the wrapper must throw');
    // Identical to what errorFromResponse would have produced — the wrapper
    // adds nothing and swallows nothing.
    const expected = errorFromResponse(409, { detail: 'active_hold_exists', request_id: 'r1' });
    assert.equal(thrown.status, expected.status);
    assert.equal(thrown.message, expected.message);
    assert.equal(thrown.code, expected.code);
    assert.deepEqual(thrown.body, expected.body);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a requestsApi wrapper returns parsed JSON on success', async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    seen.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({ items: [], next_cursor: null }) };
  };
  try {
    const out = await requestsApi.listRequests({ property_id: 'p1', view: 'active' });
    assert.deepEqual(out, { items: [], next_cursor: null });
    assert.ok(seen[0].url.endsWith('/apartment/requests?property_id=p1&view=active'), seen[0].url);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('requestsApi covers every portal route one function at a time', () => {
  for (const name of [
    'createRequest', 'listRequests', 'getRequest', 'extendRequest', 'removeRequest',
    'reinstateRequest', 'ackRequest', 'fulfillRequest', 'declineRequest', 'uploadPhoto',
    'fetchRequestPhoto', 'readPlate', 'lookupPlate', 'signupContext', 'signupMatch',
    'signup', 'verifyEmail', 'resendVerification', 'changeEmail', 'listMembers',
    'inviteMember', 'updateMember', 'removeMember', 'approveMember', 'declineMember',
    'joinProperty', 'resendJoinRequest', 'createApartmentProperty', 'updateApartmentProperty',
    'archiveApartmentProperty', 'listPartnerProperties', 'verifyPartnerProperty',
    'rejectPartnerProperty', 'slackInstallLink', 'listSlackIdentities', 'updateSlackIdentity',
    'deleteSlackIdentity', 'setSlackFeedChannel', 'getRequestAction', 'postRequestAction',
  ]) {
    assert.equal(typeof requestsApi[name], 'function', `requestsApi.${name} is missing`);
  }
});
