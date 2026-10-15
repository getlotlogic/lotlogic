// Task F6 — one QR link for a group of properties (spec §9). Pure helpers in
// shared/aptEntry.js: the group is a qr_code_id prefix (<group>-*), resolved by
// the page; these decide what the rows mean.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { groupQuery, isGroup, groupRows, groupEntryUrl } from '../src/shared/aptEntry.js';
import { STRINGS } from '../src/shared/aptFlow.js';

const row = (slug, extra = {}) => ({
  id: `id-${slug}`, name: `Name ${slug}`, address: `1 ${slug} St`, qr_code_id: slug,
  property_type: 'apartment', verification_status: 'verified', ...extra,
});
const THREE = [row('fort-mill-townhomes-i'), row('fort-mill-townhomes-ii'), row('fort-mill-townhomes-iii')];

test('groupQuery is the PostgREST path of spec 9: prefix and a dash, in qr_code_id order', () => {
  assert.equal(
    groupQuery('fort-mill-townhomes'),
    '/properties?select=id,name,address,qr_code_id,property_type'
      + '&qr_code_id=like.fort-mill-townhomes-*&property_type=eq.apartment&order=qr_code_id&limit=25',
  );
});

test('groupQuery asks for no column the anon role cannot read', () => {
  assert.doesNotMatch(groupQuery('g'), /verification_status/);
});

test('rows from the live query carry no status and still count', () => {
  const live = [row('g-a'), row('g-b')].map(({ verification_status, ...r }) => r);
  assert.equal(isGroup(live, 'g'), true);
  assert.equal(groupRows(live).length, 2);
});

test('groupQuery refuses a slug that carries a LIKE or PostgREST wildcard or separator', () => {
  for (const bad of ['', null, undefined, 'a_b', 'a%b', 'a*b', 'a,b', 'a.b', 'a(b)', 'a b', 'a/b', '-']) {
    assert.equal(groupQuery(bad), null, JSON.stringify(bad));
  }
});

test('an exact match wins: a slug that is itself a property is never a group', () => {
  const rows = [row('villas'), row('villas-a'), row('villas-b')];
  assert.equal(isGroup(rows, 'villas'), false);
});

test('two or more verified apartment siblings are a group', () => {
  assert.equal(isGroup(THREE, 'fort-mill-townhomes'), true);
  assert.equal(isGroup(THREE.slice(0, 2), 'fort-mill-townhomes'), true);
});

test('one sibling is not a group (the page goes straight to it), zero is not either', () => {
  assert.equal(isGroup(THREE.slice(0, 1), 'fort-mill-townhomes'), false);
  assert.equal(isGroup([], 'fort-mill-townhomes'), false);
  assert.equal(isGroup(null, 'fort-mill-townhomes'), false);
  assert.equal(groupRows(THREE.slice(0, 1)).length, 1);
});

test('a sibling that is not an apartment is ignored', () => {
  const rows = [row('g-a'), row('g-b', { property_type: 'truck_plaza' }), row('g-c', { property_type: 'residential' })];
  assert.deepEqual(groupRows(rows).map((r) => r.slug), ['g-a']);
  assert.equal(isGroup(rows, 'g'), false);
});

test('a sibling that is not verified is ignored', () => {
  const rows = [row('g-a'), row('g-b', { verification_status: 'pending' }), row('g-c', { verification_status: null })];
  assert.deepEqual(groupRows(rows).map((r) => r.slug), ['g-a']);
  assert.equal(isGroup(rows, 'g'), false);
});

test('a row whose slug is not under the prefix is ignored', () => {
  const rows = [row('g-a'), row('g-b'), row('gx-c'), row('g')];
  assert.equal(isGroup(rows, 'g'), false, 'the exact row "g" is there');
  assert.deepEqual(groupRows(rows, 'g').map((r) => r.slug), ['g-a', 'g-b']);
});

test('a blank address stays blank (the page omits the line)', () => {
  const rows = [row('g-a', { address: '' }), row('g-b', { address: null }), row('g-c', { address: '   ' })];
  assert.deepEqual(groupRows(rows).map((r) => r.address), ['', '', '']);
});

test('rows come back as {slug, name, address} in qr_code_id order, whatever order they arrived in', () => {
  const shuffled = [THREE[2], THREE[0], THREE[1]];
  assert.deepEqual(groupRows(shuffled), [
    { slug: 'fort-mill-townhomes-i', name: 'Name fort-mill-townhomes-i', address: '1 fort-mill-townhomes-i St' },
    { slug: 'fort-mill-townhomes-ii', name: 'Name fort-mill-townhomes-ii', address: '1 fort-mill-townhomes-ii St' },
    { slug: 'fort-mill-townhomes-iii', name: 'Name fort-mill-townhomes-iii', address: '1 fort-mill-townhomes-iii St' },
  ]);
});

test('the role is carried through to the property link, and no role stays no role', () => {
  assert.equal(groupEntryUrl('fort-mill-townhomes-ii', '?role=resident'), '/apt/fort-mill-townhomes-ii?role=resident');
  assert.equal(groupEntryUrl('fort-mill-townhomes-ii', '?role=guest&utm=x'), '/apt/fort-mill-townhomes-ii?role=guest');
  assert.equal(groupEntryUrl('fort-mill-townhomes-ii', ''), '/apt/fort-mill-townhomes-ii');
  assert.equal(groupEntryUrl('fort-mill-townhomes-ii', '?role=admin'), '/apt/fort-mill-townhomes-ii');
});

test('S0 copy: spec 9 verbatim, no phone number, none of the banned pass words', () => {
  const p = STRINGS.en.pick;
  assert.equal(p.title, 'Which address are you at?');
  assert.equal(p.resident, 'Pick the building your lease is for.');
  assert.equal(p.guest, "Pick the address you're visiting.");
  assert.equal(p.office, 'Not sure? Ask the office.');
  const all = Object.values(p).join(" | ");
  assert.doesNotMatch(all, /\d{3}[\s.)-]*\d{3}[\s.-]*\d{4}/);
  assert.doesNotMatch(all, /\b(resident|visitor|permanent|temporary|guest|driver)\b/i);
});
