// Unit tests for the bottom-nav rule (src/lib/features.js).
//
// Spec §5 layout rules: when EVERY property on the account has
// `features.cameras=false` the owner nav collapses to Properties · Account
// (tab id stays `lots`); any camera brings back the full five. Partners get
// lots · requests · lookup · activity · account, with `requests` listed only
// once Task 27 flips `partnerRequestsReady`.
import test from 'node:test';
import assert from 'node:assert/strict';

import { navTabsFor, isPortalOnly, partnerRequestsReady } from '../src/lib/features.js';

const ids = tabs => tabs.map(t => t.id);
const labelOf = (tabs, id) => tabs.find(t => t.id === id)?.label;

const FIVE = ['lots', 'analytics', 'training', 'towactivity', 'account'];

test('owner with no cameras anywhere gets Properties · Account', () => {
  const tabs = navTabsFor('owner', [{ features: { cameras: false } }]);
  assert.deepEqual(ids(tabs), ['lots', 'account']);
  assert.equal(labelOf(tabs, 'lots'), 'Properties');
});

test('owner with several camera-less properties still gets Properties · Account', () => {
  const tabs = navTabsFor('owner', [
    { features: { cameras: false, passes: false, qr: false } },
    { features: { cameras: false, passes: true, qr: true } },
  ]);
  assert.deepEqual(ids(tabs), ['lots', 'account']);
});

test('one property with a camera brings back the five', () => {
  const tabs = navTabsFor('owner', [
    { features: { cameras: false } },
    { features: { cameras: true } },
  ]);
  assert.deepEqual(ids(tabs), FIVE);
  assert.equal(labelOf(tabs, 'lots'), 'Lots');
});

test('an unknown property list never collapses the nav', () => {
  // No properties loaded yet, a legacy PostgREST row with no `features` key,
  // or a non-array: all of these must keep today's five tabs rather than
  // hiding Analytics/Training/Tow truck from an owner who has cameras.
  assert.deepEqual(ids(navTabsFor('owner', [])), FIVE);
  assert.deepEqual(ids(navTabsFor('owner', null)), FIVE);
  assert.deepEqual(ids(navTabsFor('owner', [{}])), FIVE);
  assert.deepEqual(ids(navTabsFor('owner', [{ features: {} }])), FIVE);
  assert.deepEqual(ids(navTabsFor('owner', [{ features: { cameras: false } }, {}])), FIVE);
});

test('partner nav omits requests until Task 27 flips the constant', () => {
  const tabs = navTabsFor('partner', [{ features: { cameras: false } }], { partnerRequestsReady: false });
  assert.deepEqual(ids(tabs), ['lots', 'lookup', 'activity', 'account']);
});

test('partner nav lists requests when told it is ready', () => {
  const tabs = navTabsFor('partner', [], { partnerRequestsReady: true });
  assert.deepEqual(ids(tabs), ['lots', 'requests', 'lookup', 'activity', 'account']);
  assert.equal(labelOf(tabs, 'requests'), 'Requests');
});

test('partner nav defaults to the module constant', () => {
  const tabs = navTabsFor('partner', []);
  assert.equal(ids(tabs).includes('requests'), partnerRequestsReady === true);
});

test('a partner nav never collapses on the camera rule', () => {
  const tabs = navTabsFor('partner', [{ features: { cameras: false } }], { partnerRequestsReady: false });
  assert.equal(labelOf(tabs, 'lots'), 'Lots');
});

test('isPortalOnly is true only for an explicit cameras:false', () => {
  assert.equal(isPortalOnly({ features: { cameras: false } }), true);
  assert.equal(isPortalOnly({ features: { cameras: true } }), false);
  assert.equal(isPortalOnly({ features: {} }), false);
  assert.equal(isPortalOnly({}), false);
  assert.equal(isPortalOnly(null), false);
  assert.equal(isPortalOnly(undefined), false);
});
