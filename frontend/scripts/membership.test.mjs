// Unit tests for the pending-membership state (src/lib/membership.js) —
// spec §3.7 (b): App.jsx renders PendingMembershipPage instead of Lots
// whenever /auth/me.properties has no member_status='active' row and >= 1
// 'pending' one.
import test from 'node:test';
import assert from 'node:assert/strict';

import { pendingMembershipState, pendingProperties } from '../src/lib/membership.js';

test('true with zero active and one pending', () => {
  const me = { properties: [{ id: 'p1', name: 'Sunset Ridge', member_status: 'pending' }] };
  assert.equal(pendingMembershipState(me), true);
});

test('false when an active membership exists alongside a pending one', () => {
  const me = { properties: [
    { id: 'p1', member_status: 'active' },
    { id: 'p2', member_status: 'pending' },
  ] };
  assert.equal(pendingMembershipState(me), false);
});

test('false with zero properties', () => {
  assert.equal(pendingMembershipState({ properties: [] }), false);
  assert.equal(pendingMembershipState({}), false);
  assert.equal(pendingMembershipState(null), false);
  assert.equal(pendingMembershipState(undefined), false);
});

test('false with only active memberships', () => {
  const me = { properties: [{ id: 'p1', member_status: 'active' }] };
  assert.equal(pendingMembershipState(me), false);
});

test('true with several pending and zero active', () => {
  const me = { properties: [
    { id: 'p1', member_status: 'pending' },
    { id: 'p2', member_status: 'pending' },
  ] };
  assert.equal(pendingMembershipState(me), true);
});

test('pendingProperties returns only the pending rows', () => {
  const me = { properties: [
    { id: 'p1', member_status: 'active' },
    { id: 'p2', member_status: 'pending', name: 'Sunset Ridge' },
  ] };
  assert.deepEqual(pendingProperties(me), [{ id: 'p2', member_status: 'pending', name: 'Sunset Ridge' }]);
});

test('pendingProperties tolerates a missing properties array', () => {
  assert.deepEqual(pendingProperties({}), []);
  assert.deepEqual(pendingProperties(null), []);
});
