// Unit tests for the bottom-nav rule (src/lib/features.js).
//
// Spec §5 layout rules: when EVERY property on the account has
// `features.cameras=false` the owner nav collapses to Properties · Account
// (tab id stays `lots`); any camera brings back the full five. Partners get
// lots · requests · lookup · activity · account, with `requests` listed only
// once Task 27 flips `partnerRequestsReady`.
import test from 'node:test';
import assert from 'node:assert/strict';

import { navTabsFor, isPortalOnly, partnerRequestsReady, KNOWN_TAB_IDS, isKnownTab } from '../src/lib/features.js';

const ids = tabs => tabs.map(t => t.id);
const labelOf = (tabs, id) => tabs.find(t => t.id === id)?.label;

const FOUR = ['lots', 'analytics', 'towactivity', 'account'];

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

test('one property with a camera brings back the four', () => {
  const tabs = navTabsFor('owner', [
    { features: { cameras: false } },
    { features: { cameras: true } },
  ]);
  assert.deepEqual(ids(tabs), FOUR);
  assert.equal(labelOf(tabs, 'lots'), 'Lots');
});

test('an unknown property list never collapses the nav', () => {
  // No properties loaded yet, a legacy PostgREST row with no `features` key,
  // or a non-array: all of these must keep today's five tabs rather than
  // hiding Analytics/Tow truck from an owner who has cameras.
  assert.deepEqual(ids(navTabsFor('owner', [])), FOUR);
  assert.deepEqual(ids(navTabsFor('owner', null)), FOUR);
  assert.deepEqual(ids(navTabsFor('owner', [{}])), FOUR);
  assert.deepEqual(ids(navTabsFor('owner', [{ features: {} }])), FOUR);
  assert.deepEqual(ids(navTabsFor('owner', [{ features: { cameras: false } }, {}])), FOUR);
});

test('partner nav omits requests until Task 27 flips the constant', () => {
  const tabs = navTabsFor('partner', [{ features: { cameras: false } }], { partnerRequestsReady: false });
  assert.deepEqual(ids(tabs), ['lots', 'lookup', 'activity', 'account']);
});

test('partner nav lists requests when told it is ready (and the partner has a portal property)', () => {
  const tabs = navTabsFor('partner', [{ property_type: 'apartment' }], { partnerRequestsReady: true });
  assert.deepEqual(ids(tabs), ['lots', 'requests', 'lookup', 'activity', 'account']);
  assert.equal(labelOf(tabs, 'requests'), 'Requests');
});

test('partner nav defaults to the module constant', () => {
  const tabs = navTabsFor('partner', [{ property_type: 'apartment' }]);
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

test('training, app and hq are no longer tabs: a deep link to them is not honoured', () => {
  for (const id of ['training', 'app', 'hq']) {
    assert.equal(isKnownTab(id), false, id);
    assert.equal(KNOWN_TAB_IDS.includes(id), false, id);
  }
  assert.equal(isKnownTab('lots'), true);
  assert.equal(isKnownTab('admin'), true);
  assert.equal(isKnownTab(null), false);
});

test('no role gets a training tab', () => {
  assert.equal(ids(navTabsFor('owner', [])).includes('training'), false);
  assert.equal(ids(navTabsFor('partner', [], { partnerRequestsReady: true })).includes('training'), false);
});

test('a partner with only truck plazas (NMLD) keeps the pre-portal nav: no Requests, no Lookup', () => {
  const plazaOnly = [{ id: 'p1', property_type: 'truck_plaza', features: { cameras: true } }];
  assert.deepEqual(ids(navTabsFor('partner', plazaOnly, { partnerRequestsReady: true })), ['lots', 'activity', 'account']);
  assert.deepEqual(ids(navTabsFor('partner', [], { partnerRequestsReady: true })), ['lots', 'activity', 'account']);
});

test('a partner with an apartment property (N Style) gets Requests and Lookup', () => {
  const mixed = [{ id: 'p1', property_type: 'truck_plaza' }, { id: 'p2', property_type: 'apartment', features: { cameras: false } }];
  assert.deepEqual(ids(navTabsFor('partner', mixed, { partnerRequestsReady: true })), ['lots', 'requests', 'lookup', 'activity', 'account']);
});
