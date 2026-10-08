import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mustVerifyFirst, verifyResume } from '../src/lib/requestGate.js';

test('an unverified email gates tow, photo and a hold on a pending property', () => {
  assert.equal(mustVerifyFirst({ kind: 'tow', isPending: false, emailVerified: false }), true);
  assert.equal(mustVerifyFirst({ kind: 'photo', isPending: false, emailVerified: false }), true);
  assert.equal(mustVerifyFirst({ kind: 'hold', isPending: true, emailVerified: false }), true);
});

test('a hold on a confirmed property, or an email not known to be unverified, is not gated', () => {
  assert.equal(mustVerifyFirst({ kind: 'hold', isPending: false, emailVerified: false }), false);
  assert.equal(mustVerifyFirst({ kind: 'tow', isPending: false, emailVerified: true }), false);
  assert.equal(mustVerifyFirst({ kind: 'hold', isPending: true, emailVerified: undefined }), false);
});

test('the resume after a correct code skips the gate even while emailVerified is still false', () => {
  // The sheet fires the resume from the closure of the render that asked,
  // where emailVerified is still false; gating again would never place it.
  assert.equal(mustVerifyFirst({ kind: 'hold', isPending: true, emailVerified: false, afterVerify: true }), false);
  assert.equal(mustVerifyFirst({ kind: 'tow', isPending: false, emailVerified: false, afterVerify: true }), false);
});

test('verifyResume re-runs submit with afterVerify set, and no event', () => {
  const calls = [];
  verifyResume((...args) => calls.push(args))();
  assert.deepEqual(calls, [[null, { afterVerify: true }]]);
});
