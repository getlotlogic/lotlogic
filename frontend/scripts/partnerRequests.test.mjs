// Unit tests for the partner Requests tab's pure layer
// (src/lib/partnerRequests.js) plus the naming scan over the three files
// Task 27 adds under src/pages.
//
// Spec §5.4: grouped by property sorted by soonest expiry, tows above holds
// inside a property, filter chips All / Holds / Tows / Photos / Recent with
// counts, and a badge that counts only what Austin must act on —
// active tows + active photos + unconfirmed properties + pending joins.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import {
  badgeCount,
  countActionable,
  chipCounts,
  chipsFor,
  filterItems,
  groupAndSort,
  compareItems,
  timeLeftLabel,
  isEndingSoon,
  fmtTimeET,
  placedByLine,
  vehicleText,
  truncateNote,
  seenLine,
  refWithLineage,
  outcomeLabel,
  actionsFor,
  normalizePendingProperty,
} from '../src/lib/partnerRequests.js';

const ROOT = path.resolve(import.meta.dirname, '..');

// ── fixtures ─────────────────────────────────────────────────
// Obviously fake: plates, refs, names and numbers are all invented.
const hold = (over = {}) => ({
  id: over.id || 'h1',
  ref: over.ref || 'H-1842',
  property_id: over.property_id || 'prop-spring',
  property_name: over.property_name || 'Spring Lake Apartments',
  kind: 'hold',
  status: 'active',
  plate: 'ABC1234',
  expires_at: '2026-10-10T22:00:00Z',
  created_at: '2026-10-07T20:12:00Z',
  checked_count: 0,
  created_by: { name: 'Dana Ortiz', position: 'Property manager', type: 'member' },
  ...over,
});
const tow = (over = {}) => ({
  id: over.id || 't1',
  ref: over.ref || 'T-0231',
  property_id: over.property_id || 'prop-spring',
  property_name: over.property_name || 'Spring Lake Apartments',
  kind: 'tow',
  status: 'active',
  plate: 'XYZ789',
  expires_at: null,
  note: 'Blocking dumpster, 3rd night',
  created_at: '2026-10-07T13:30:00Z',
  checked_count: 0,
  created_by: { name: 'Dana Ortiz', position: 'Property manager', type: 'member' },
  ...over,
});
const photo = (over = {}) => ({ ...tow(over), kind: 'photo', ref: over.ref || 'P-0040', id: over.id || 'p1' });

// ── badgeCount ───────────────────────────────────────────────

test('badgeCount sums tows, photos, unconfirmed properties and pending joins', () => {
  assert.equal(badgeCount({ tows: 4, photos: 1, pendingProps: 1, pendingJoins: 2 }), 8);
});

test('badgeCount never counts holds — a missing key is zero, not NaN', () => {
  assert.equal(badgeCount({ tows: 2 }), 2);
  assert.equal(badgeCount({}), 0);
  assert.equal(badgeCount(), 0);
  assert.equal(badgeCount({ holds: 9 }), 0);
});

test('badgeCount floors junk to zero instead of propagating it', () => {
  assert.equal(badgeCount({ tows: null, photos: undefined, pendingProps: 'x', pendingJoins: -3 }), 0);
  assert.equal(badgeCount({ tows: '2', photos: 1.7 }), 3);
});

test('countActionable counts active tows and photos only', () => {
  const items = [hold(), hold({ id: 'h2', ref: 'H-1843' }), tow(), tow({ id: 't2', ref: 'T-0232' }), photo()];
  assert.deepEqual(countActionable(items), { tows: 2, photos: 1 });
  assert.deepEqual(countActionable([]), { tows: 0, photos: 0 });
  assert.deepEqual(countActionable(null), { tows: 0, photos: 0 });
});

test('countActionable ignores a row that is no longer active', () => {
  const items = [tow(), tow({ id: 't2', status: 'declined' }), photo({ status: 'fulfilled' })];
  assert.deepEqual(countActionable(items), { tows: 1, photos: 0 });
});

test('badgeCount over a real list is tows + photos + the two pending numbers', () => {
  const items = [hold(), tow(), photo()];
  assert.equal(badgeCount({ ...countActionable(items), pendingProps: 1, pendingJoins: 0 }), 3);
});

// ── filter chips ─────────────────────────────────────────────

test('chipCounts counts each kind and the total', () => {
  const items = [hold(), hold({ id: 'h2' }), tow(), photo()];
  assert.deepEqual(chipCounts(items), { all: 4, holds: 2, tows: 1, photos: 1 });
});

test('chipsFor labels Holds / Tows / Photos with counts and leaves All and Recent bare', () => {
  const chips = chipsFor([hold(), tow(), tow({ id: 't2' }), photo()]);
  assert.deepEqual(chips.map(c => c.id), ['all', 'holds', 'tows', 'photos', 'recent']);
  assert.deepEqual(chips.map(c => c.count), [null, 1, 2, 1, null]);
  assert.deepEqual(chips.map(c => c.label), ['All', 'Holds', 'Tows', 'Photos', 'Recent']);
});

test('filterItems narrows to the chosen chip and passes everything for All', () => {
  const items = [hold(), tow(), photo()];
  assert.equal(filterItems(items, 'all').length, 3);
  assert.deepEqual(filterItems(items, 'holds').map(i => i.kind), ['hold']);
  assert.deepEqual(filterItems(items, 'tows').map(i => i.kind), ['tow']);
  assert.deepEqual(filterItems(items, 'photos').map(i => i.kind), ['photo']);
  // `recent` is served by a different view, so it filters nothing here.
  assert.equal(filterItems(items, 'recent').length, 3);
  assert.equal(filterItems(items, undefined).length, 3);
});

// ── groupAndSort ─────────────────────────────────────────────

test('groupAndSort puts tows and photos above holds inside one property', () => {
  const items = [
    hold({ id: 'h1', ref: 'H-1842' }),
    tow({ id: 't1', ref: 'T-0231' }),
    photo({ id: 'p1', ref: 'P-0040' }),
  ];
  const groups = groupAndSort(items);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].items.map(i => i.ref), ['T-0231', 'P-0040', 'H-1842']);
});

test('groupAndSort orders holds inside a property by soonest expiry', () => {
  const items = [
    hold({ id: 'a', ref: 'H-3', expires_at: '2026-10-12T22:00:00Z' }),
    hold({ id: 'b', ref: 'H-1', expires_at: '2026-10-08T22:00:00Z' }),
    hold({ id: 'c', ref: 'H-2', expires_at: '2026-10-09T22:00:00Z' }),
  ];
  assert.deepEqual(groupAndSort(items)[0].items.map(i => i.ref), ['H-1', 'H-2', 'H-3']);
});

test('groupAndSort orders properties by their soonest expiry', () => {
  const items = [
    hold({ id: 'a', ref: 'H-late', property_id: 'p-late', property_name: 'Zebra Court', expires_at: '2026-10-20T22:00:00Z' }),
    hold({ id: 'b', ref: 'H-soon', property_id: 'p-soon', property_name: 'Anchor Place', expires_at: '2026-10-08T01:00:00Z' }),
    hold({ id: 'c', ref: 'H-mid', property_id: 'p-mid', property_name: 'Mid Oak', expires_at: '2026-10-09T01:00:00Z' }),
  ];
  const groups = groupAndSort(items);
  assert.deepEqual(groups.map(g => g.propertyName), ['Anchor Place', 'Mid Oak', 'Zebra Court']);
  assert.deepEqual(groups.map(g => g.count), [1, 1, 1]);
});

test('groupAndSort sorts a property with no expiry at all last, by oldest request', () => {
  const items = [
    tow({ id: 't-a', property_id: 'p-tow', property_name: 'Tow Only', created_at: '2026-10-07T10:00:00Z' }),
    hold({ id: 'h-a', property_id: 'p-hold', property_name: 'Has A Hold', expires_at: '2026-10-30T22:00:00Z' }),
  ];
  assert.deepEqual(groupAndSort(items).map(g => g.propertyName), ['Has A Hold', 'Tow Only']);
});

test('groupAndSort flags a property that is not yet confirmed', () => {
  const groups = groupAndSort([
    hold({ property_id: 'p-ok', property_name: 'Spring Lake Apartments', property_verified: true }),
    hold({ id: 'h2', property_id: 'p-pending', property_name: 'Sunset Ridge', property_verified: false, expires_at: '2026-10-09T01:00:00Z' }),
  ]);
  const byName = Object.fromEntries(groups.map(g => [g.propertyName, g.propertyVerified]));
  assert.equal(byName['Sunset Ridge'], false);
  assert.equal(byName['Spring Lake Apartments'], true);
});

test('groupAndSort treats a missing property_verified as confirmed', () => {
  const groups = groupAndSort([hold({ property_verified: undefined })]);
  assert.equal(groups[0].propertyVerified, true);
});

test('groupAndSort takes a property name from the lookup when the row has none', () => {
  const groups = groupAndSort([hold({ property_name: undefined, property_id: 'prop-9' })], { 'prop-9': 'Anchor Place' });
  assert.equal(groups[0].propertyName, 'Anchor Place');
});

test('groupAndSort tolerates an empty or missing list', () => {
  assert.deepEqual(groupAndSort([]), []);
  assert.deepEqual(groupAndSort(null), []);
});

test('compareItems is a total order — sorting twice gives the same answer', () => {
  const items = [tow({ id: 't2', ref: 'T-2' }), hold({ id: 'h1', ref: 'H-1' }), tow({ id: 't1', ref: 'T-1' })];
  const once = [...items].sort(compareItems).map(i => i.ref);
  const twice = [...items].sort(compareItems).sort(compareItems).map(i => i.ref);
  assert.deepEqual(once, twice);
});

// ── row copy ─────────────────────────────────────────────────

test('timeLeftLabel counts a hold down in days and hours', () => {
  const now = new Date('2026-10-08T18:00:00Z').getTime();
  assert.equal(timeLeftLabel(hold({ expires_at: '2026-10-10T22:00:00Z' }), now), '2d 4h left');
});

test('timeLeftLabel drops to hours, then to minutes, then to expired', () => {
  const now = new Date('2026-10-08T18:00:00Z').getTime();
  assert.equal(timeLeftLabel(hold({ expires_at: '2026-10-08T23:30:00Z' }), now), '5h left');
  assert.equal(timeLeftLabel(hold({ expires_at: '2026-10-08T18:48:00Z' }), now), '48 min left');
  assert.equal(timeLeftLabel(hold({ expires_at: '2026-10-08T17:00:00Z' }), now), 'expired');
});

test('timeLeftLabel reads new / seen for a tow or photo request', () => {
  const now = new Date('2026-10-08T18:00:00Z').getTime();
  assert.equal(timeLeftLabel(tow(), now), 'new');
  assert.equal(timeLeftLabel(tow({ partner_ack_at: '2026-10-07T13:40:00Z' }), now), 'seen');
  assert.equal(timeLeftLabel(photo(), now), 'new');
});

test('isEndingSoon is true only inside the last hour of a live hold', () => {
  const now = new Date('2026-10-08T18:00:00Z').getTime();
  assert.equal(isEndingSoon(hold({ expires_at: '2026-10-08T18:48:00Z' }), now), true);
  assert.equal(isEndingSoon(hold({ expires_at: '2026-10-08T23:30:00Z' }), now), false);
  assert.equal(isEndingSoon(hold({ expires_at: '2026-10-08T17:00:00Z' }), now), false);
  assert.equal(isEndingSoon(tow(), now), false);
});

test('fmtTimeET renders a timestamp in lot time, never the browser zone', () => {
  assert.equal(fmtTimeET('2026-10-07T20:12:00Z'), '4:12 PM');
  assert.equal(fmtTimeET('2026-10-07T13:30:00Z'), '9:30 AM');
  assert.equal(fmtTimeET(null), '');
});

test('placedByLine names the person, their role and the time', () => {
  assert.equal(placedByLine(hold()), 'Dana Ortiz (Property manager) · 4:12 PM');
});

test('placedByLine says written request on file for a tow', () => {
  assert.equal(placedByLine(tow()), 'written request on file · 9:30 AM');
});

test('placedByLine drops a role it does not have', () => {
  assert.equal(placedByLine(hold({ created_by: { name: 'Dana Ortiz' } })), 'Dana Ortiz · 4:12 PM');
  assert.equal(placedByLine(hold({ created_by: null })), '4:12 PM');
});

test('vehicleText reads year make model color', () => {
  assert.equal(vehicleText(hold({ year: 2019, make: 'Honda', model: 'Civic', color: 'gray' })), '2019 Honda Civic gray');
  assert.equal(vehicleText(hold({ make: 'Honda' })), 'Honda');
  assert.equal(vehicleText(hold()), '');
});

test('truncateNote shortens a long note with an ellipsis', () => {
  assert.equal(truncateNote('mom visiting, overflow row', 8), 'mom visi…');
  assert.equal(truncateNote('short', 8), 'short');
  assert.equal(truncateNote(null, 8), '');
});

test('seenLine reports the acknowledgement and the check count', () => {
  assert.equal(seenLine(hold({ partner_ack_at: '2026-10-07T21:40:00Z', checked_count: 3 })), 'Seen 5:40 PM · checked 3×');
  assert.equal(seenLine(hold({ checked_count: 2 })), 'checked 2×');
  assert.equal(seenLine(hold({ partner_ack_at: '2026-10-07T21:40:00Z' })), 'Seen 5:40 PM');
  assert.equal(seenLine(hold()), '');
});

test('refWithLineage reads §8.3\'s reinstated_from and shows the replaced number', () => {
  assert.equal(refWithLineage(hold({ ref: 'H-1850', reinstated_from: 'H-1842' })), 'H-1850 (replaces H-1842)');
  assert.equal(refWithLineage(tow({ ref: 'T-0240', reinstated_from: 'T-0231' })), 'T-0240 (replaces T-0231)');
  assert.equal(refWithLineage(photo({ ref: 'P-0041', reinstated_from: 'P-0040' })), 'P-0041 (replaces P-0040)');
  assert.equal(refWithLineage(hold({ ref: 'H-1842' })), 'H-1842');
});

test('refWithLineage never prints a uuid at the crew', () => {
  // §8.2's DDL makes reinstated_from a uuid FK, so a serializer that has not
  // resolved it to a reference number must leave the row reading bare.
  const uuid = '00000000-0000-4000-8000-000000000abc';
  assert.equal(refWithLineage(hold({ ref: 'H-1850', reinstated_from: uuid })), 'H-1850');
  assert.equal(refWithLineage(hold({ ref: 'H-1850', reinstated_from: 'H-1842x' })), 'H-1850');
  assert.equal(refWithLineage(hold({ ref: 'H-1850', reinstated_from: 42 })), 'H-1850');
});

test('refWithLineage ignores a field the spec does not define', () => {
  assert.equal(refWithLineage(hold({ ref: 'H-1850', reinstated_from_ref: 'H-1842' })), 'H-1850');
});

// ── a row that has ended ─────────────────────────────────────

test('outcomeLabel is empty while the row is live', () => {
  assert.equal(outcomeLabel(hold()), '');
  assert.equal(outcomeLabel(tow()), '');
  assert.equal(outcomeLabel({ kind: 'tow' }), '');
});

test('outcomeLabel names every resolution §8.2 allows', () => {
  assert.equal(outcomeLabel(tow({ status: 'fulfilled', resolution: 'towed' })), 'Towed');
  assert.equal(outcomeLabel(photo({ status: 'fulfilled', resolution: 'photographed' })), 'Photo sent');
  assert.equal(outcomeLabel(tow({ status: 'declined', resolution: 'declined' })), 'Declined');
  assert.equal(outcomeLabel(hold({ status: 'expired', resolution: 'expired' })), 'Expired');
  assert.equal(outcomeLabel(hold({ status: 'removed', resolution: 'property_removed' })), 'Property not confirmed');
});

test('outcomeLabel falls back to the status when there is no resolution', () => {
  assert.equal(outcomeLabel(hold({ status: 'removed' })), 'Removed by the office');
  assert.equal(outcomeLabel(hold({ status: 'expired' })), 'Expired');
  assert.equal(outcomeLabel(tow({ status: 'declined' })), 'Declined');
  assert.equal(outcomeLabel(tow({ status: 'fulfilled' })), 'Done');
  assert.equal(outcomeLabel(tow({ status: 'something-new' })), '');
});

test('timeLeftLabel reads the outcome, never new or seen, once a row has ended', () => {
  const now = Date.parse('2026-10-08T18:00:00Z');
  assert.equal(timeLeftLabel(tow({ status: 'fulfilled', resolution: 'towed' }), now), 'Towed');
  assert.equal(
    timeLeftLabel(tow({ status: 'fulfilled', resolution: 'towed', partner_ack_at: '2026-10-01T13:40:00Z' }), now),
    'Towed',
  );
  assert.equal(timeLeftLabel(photo({ status: 'declined', resolution: 'declined' }), now), 'Declined');
  assert.equal(timeLeftLabel(hold({ status: 'removed' }), now), 'Removed by the office');
  // An expired hold reads the word, not a stale countdown.
  assert.equal(
    timeLeftLabel(hold({ status: 'expired', resolution: 'expired', expires_at: '2026-10-02T18:00:00Z' }), now),
    'Expired',
  );
});

test('isEndingSoon never glows amber on a row that has ended', () => {
  const now = Date.parse('2026-10-08T18:00:00Z');
  assert.equal(isEndingSoon(hold({ expires_at: '2026-10-08T18:48:00Z' }), now), true);
  assert.equal(isEndingSoon(hold({ status: 'removed', expires_at: '2026-10-08T18:48:00Z' }), now), false);
});

// ── which controls a row gets ────────────────────────────────

test('a hold offers Got it plus Towed anyway, Decline and History behind the overflow', () => {
  assert.deepEqual(actionsFor(hold()), { buttons: ['ack'], menu: ['towed_anyway', 'decline', 'history'] });
});

test('a tow offers Got it, Towed and Decline up front', () => {
  assert.deepEqual(actionsFor(tow()), { buttons: ['ack', 'towed', 'decline'], menu: ['history'] });
});

test('a photo request asks for the photo instead of a tow', () => {
  assert.deepEqual(actionsFor(photo()), { buttons: ['ack', 'photographed', 'decline'], menu: ['history'] });
});

test('an acknowledged row drops Got it and keeps the rest', () => {
  assert.deepEqual(actionsFor(tow({ partner_ack_at: '2026-10-07T13:40:00Z' })), { buttons: ['towed', 'decline'], menu: ['history'] });
  assert.deepEqual(actionsFor(hold({ partner_ack_at: '2026-10-07T13:40:00Z' })), { buttons: [], menu: ['towed_anyway', 'decline', 'history'] });
});

test('a row that has ended offers History and nothing that would 409', () => {
  // §8.3: /ack is idempotent but /fulfill and /decline answer 409 `not_active`
  // on a terminal row, so Recent must not render the controls.
  const ended = { buttons: [], menu: ['history'] };
  assert.deepEqual(actionsFor(tow({ status: 'fulfilled', resolution: 'towed' })), ended);
  assert.deepEqual(actionsFor(tow({ status: 'fulfilled', resolution: 'towed', partner_ack_at: null })), ended);
  assert.deepEqual(actionsFor(photo({ status: 'fulfilled', resolution: 'photographed' })), ended);
  assert.deepEqual(actionsFor(tow({ status: 'declined', resolution: 'declined' })), ended);
  assert.deepEqual(actionsFor(hold({ status: 'expired', resolution: 'expired' })), ended);
  assert.deepEqual(actionsFor(hold({ status: 'removed' })), ended);
});

// ── the pending-property card ────────────────────────────────

test('normalizePendingProperty reads the nested manager shape', () => {
  const card = normalizePendingProperty({
    id: 'prop-1',
    name: 'Sunset Ridge Apartments',
    address: '123 Main St',
    manager: { name: 'Dana Ortiz', position: 'Property manager', phone: '(704) 555-0123' },
    active_holds: 2,
    similar_address: 'Sunset Ridge Apts',
  });
  assert.deepEqual(card, {
    id: 'prop-1',
    name: 'Sunset Ridge Apartments',
    address: '123 Main St',
    managerName: 'Dana Ortiz',
    managerPosition: 'Property manager',
    managerPhone: '(704) 555-0123',
    holds: 2,
    similarAddress: 'Sunset Ridge Apts',
  });
});

test('normalizePendingProperty reads the flat manager shape too', () => {
  const card = normalizePendingProperty({
    id: 'prop-2',
    name: 'Anchor Place',
    address_line1: '9 Anchor Way',
    manager_name: 'Lee Park',
    manager_position: 'Leasing',
    manager_phone: '(704) 555-0199',
    active_hold_count: 0,
    possible_duplicate_name: 'Anchor Pl',
  });
  assert.equal(card.address, '9 Anchor Way');
  assert.equal(card.managerName, 'Lee Park');
  assert.equal(card.managerPosition, 'Leasing');
  assert.equal(card.managerPhone, '(704) 555-0199');
  assert.equal(card.holds, 0);
  assert.equal(card.similarAddress, 'Anchor Pl');
});

test('normalizePendingProperty leaves what it was not given empty', () => {
  const card = normalizePendingProperty({ id: 'prop-3', name: 'Bare Row' });
  assert.equal(card.address, '');
  assert.equal(card.managerName, '');
  assert.equal(card.managerPhone, '');
  assert.equal(card.holds, 0);
  assert.equal(card.similarAddress, '');
  assert.equal(normalizePendingProperty(null), null);
});

// ── naming rule ──────────────────────────────────────────────
// The only user-facing pass word is "parking pass". `check-naming.mjs` scans
// `*.html` only, so the JSX this task adds carries its own scan. Comments are
// stripped first: the rule is about what ships, and a note about a DB column
// is not a UI string.
const BANNED = /\b(resident|visitor|permanent|temporary|guest|driver)s?\b/i;

function partnerRequestFiles() {
  const files = [
    path.join(ROOT, 'src/lib/partnerRequests.js'),
    path.join(ROOT, 'src/pages/PartnerRequestsPage.jsx'),
  ];
  const dir = path.join(ROOT, 'src/pages/partner');
  if (existsSync(dir)) for (const entry of readdirSync(dir)) files.push(path.join(dir, entry));
  return files;
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
}

test('no partner Requests source ships a banned word', () => {
  for (const file of partnerRequestFiles()) {
    const hit = stripComments(readFileSync(file, 'utf8')).match(BANNED);
    assert.equal(hit, null, `${path.basename(file)} uses "${hit?.[0]}" — say "parking pass"`);
  }
});

test('the naming scan is looking at files that exist', () => {
  const files = partnerRequestFiles();
  assert.ok(files.length >= 4, `expected the page, the lib and both partner components, got ${files.length}`);
  for (const f of files) assert.ok(existsSync(f), `${f} is missing`);
});

// ── the empty state and the page copy are the spec's, verbatim ──

test('the page carries the spec empty-state sentence verbatim', () => {
  const src = readFileSync(path.join(ROOT, 'src/pages/PartnerRequestsPage.jsx'), 'utf8');
  assert.ok(src.includes('Nothing active.'), 'missing the empty-state heading');
  assert.ok(
    src.includes('show up here the moment an office posts them'),
    'missing the empty-state body'
  );
});

test('the decline modal copy is the spec copy', () => {
  const src = readFileSync(path.join(ROOT, 'src/pages/PartnerRequestsPage.jsx'), 'utf8');
  assert.ok(src.includes('Decline this request'), 'missing the decline title');
  assert.ok(src.includes('The office will see your reason. The plate becomes eligible to tow.'), 'missing the decline body');
  assert.ok(src.includes("Tell the office why (they'll see this)"), 'missing the decline placeholder');
  assert.ok(src.includes('Decline request'), 'missing the decline button label');
});

test('the Not ours modal copy is the spec copy', () => {
  const src = readFileSync(path.join(ROOT, 'src/pages/PartnerRequestsPage.jsx'), 'utf8');
  assert.ok(src.includes('Not your property'), 'missing the reject title');
  assert.ok(
    src.includes("Their requests will stop showing to your crew and we'll let the person who signed up know."),
    'missing the reject body'
  );
});
