// The manager's approval queue (task F4) — the pure half.
//
// Everything the Passes tab decides without a DOM lives in
// `src/lib/permitsQueue.js`: which segment a row belongs to, how requests
// group by unit against the vehicle cap, which pending row is over the
// limit, the age chip against the 72-hour review window, the sentence a
// denial sends, the evidence each card asks the manager to compare, and the
// `?status=&q=` round trip. Expected values below are written out by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  queueRows,
  segmentOf,
  normalizeUnit,
  normalizePlate,
  matchesSearch,
  capOf,
  unitTally,
  overLimitKeys,
  capChip,
  reviewGroups,
  decidedRows,
  segmentCounts,
  protectionChip,
  waitingChip,
  ageChip,
  DENY_REASONS,
  denyReasonText,
  decisionEmailLine,
  initialDenyReason,
  evidenceCards,
  docPath,
  missingDocs,
  readQueueQuery,
  writeQueueQuery,
  approvedPatch,
  nextPendingKey,
  actionError,
  registrationLink,
  allCaughtUpLine,
  approvedVehicleCount,
  unitLabel,
  decisionLine,
  statusTag,
  actionPath,
  serverPatch,
  patchRows,
  parseExtendHours,
  telHref,
  createDocCache,
  previewKind,
  downloadName,
  tagDateLabel,
} from '../src/lib/permitsQueue.js';

// ── Fixtures ─────────────────────────────────────────────────
// Shaped exactly like `GET /apartment/passes/permits` rows
// (`build_resident_list_sql` / `build_guest_list_sql`), every column present.

const NOW = Date.parse('2026-10-15T16:00:00Z');
const HOUR = 3600000;
const ago = (h) => new Date(NOW - h * HOUR).toISOString();

function longTerm(id, over = {}) {
  return {
    id,
    plate_text: 'TEST001',
    unit_number: '214',
    holder_name: 'Pat Example',
    status: 'pending',
    phone: '555-0100',
    email: 'pat@example.test',
    has_id: true,
    has_lease: true,
    has_plate: true,
    has_registration: true,
    has_vehicle_photo: false,
    created_at: ago(1),
    reviewed_at: null,
    ...over,
  };
}

function shortTerm(id, over = {}) {
  return {
    id,
    plate_text: 'TEST900',
    host_unit: '214',
    visitor_name: 'Sam Sample',
    status: 'pending',
    valid_from: null,
    valid_until: null,
    is_temp_tag: false,
    tag_expiration: null,
    tag_expired: false,
    phone: '555-0199',
    email: 'sam@example.test',
    has_id: true,
    has_plate: true,
    created_at: ago(1),
    reviewed_at: null,
    ...over,
  };
}

const rowsOf = (residents = [], guests = []) => queueRows({ residents, guests });
const keys = (rows) => rows.map(r => r.key);

// ── Rows and segments ────────────────────────────────────────

test('every row keeps its status and gets a kind and a key; rejected rows are no longer dropped', () => {
  const rows = rowsOf(
    [
      longTerm('r1', { status: 'pending' }),
      longTerm('r2', { status: 'approved' }),
      longTerm('r3', { status: 'rejected' }),
      longTerm('r4', { status: 'void' }),
    ],
    [
      shortTerm('g1', { status: 'pending' }),
      shortTerm('g2', { status: 'active' }),
      shortTerm('g3', { status: 'rejected' }),
      shortTerm('g4', { status: 'expired' }),
    ],
  );
  assert.deepEqual(keys(rows), [
    'resident:r1', 'resident:r2', 'resident:r3', 'resident:r4',
    'guest:g1', 'guest:g2', 'guest:g3', 'guest:g4',
  ]);
  assert.deepEqual(rows.map(segmentOf), [
    'pending', 'approved', 'denied', null,
    'pending', 'approved', 'denied', null,
  ]);
  assert.equal(rows[0].plate_text, 'TEST001', 'the server columns ride along untouched');
});

test('a payload missing one list is an empty list, not a crash', () => {
  assert.deepEqual(queueRows({ residents: [longTerm('r1')] }).length, 1);
  assert.deepEqual(queueRows(null), []);
});

test('short-term statuses that are not decisions fall out of every segment', () => {
  for (const status of ['revoked', 'cancelled', 'towed', 'void']) {
    assert.equal(segmentOf(rowsOf([], [shortTerm('g', { status })])[0]), null, status);
  }
});

// ── Normalisation and search ─────────────────────────────────

test('units and plates normalise to upper-case letters and digits', () => {
  assert.equal(normalizeUnit(' #214 '), '214');
  assert.equal(normalizeUnit('Apt 214'), 'APT214');
  assert.equal(normalizeUnit('b-12'), 'B12');
  assert.equal(normalizeUnit(null), '');
  assert.equal(normalizePlate('abc 1234'), 'ABC1234');
  assert.equal(normalizePlate('ABC-1234'), 'ABC1234');
});

test('search matches a normalised plate or unit', () => {
  const [row] = rowsOf([longTerm('r1', { plate_text: 'ABC1234', unit_number: '#214' })]);
  assert.equal(matchesSearch(row, 'abc 12'), true, 'plate, spacing and case ignored');
  assert.equal(matchesSearch(row, 'XYZ'), false);
  assert.equal(matchesSearch(row, '214'), true, 'unit, punctuation ignored');
  assert.equal(matchesSearch(row, 'unit 9'), false);
  assert.equal(matchesSearch(row, ''), true, 'an empty search keeps every row');
  assert.equal(matchesSearch(row, '#'), true, 'a search that normalises to nothing keeps every row');
});

test('a short-term row is searched by the unit it is visiting', () => {
  const [row] = rowsOf([], [shortTerm('g1', { host_unit: '330' })]);
  assert.equal(matchesSearch(row, '330'), true);
});

// ── The vehicle cap ──────────────────────────────────────────

test('the cap comes from the property row; anything outside 1..10 means no cap', () => {
  assert.equal(capOf({ max_vehicles_per_unit: 2 }), 2);
  assert.equal(capOf({ max_vehicles_per_unit: '2' }), 2);
  assert.equal(capOf({ max_vehicles_per_unit: null }), null);
  assert.equal(capOf({ max_vehicles_per_unit: 0 }), null);
  assert.equal(capOf({}), null);
  assert.equal(capOf(null), null);
});

test('a unit tally counts approved and pending long-term passes only, across typing variants', () => {
  const rows = rowsOf(
    [
      longTerm('a', { status: 'approved', unit_number: '214' }),
      longTerm('b', { status: 'pending', unit_number: '#214' }),
      longTerm('c', { status: 'rejected', unit_number: '214' }),
      longTerm('d', { status: 'void', unit_number: '214' }),
      longTerm('e', { status: 'pending', unit_number: '215' }),
    ],
    [shortTerm('g', { status: 'pending', host_unit: '214' })],
  );
  assert.deepEqual(unitTally(rows, '214'), { approved: 1, pending: 1 });
  assert.deepEqual(unitTally(rows, '215'), { approved: 0, pending: 1 });
  assert.deepEqual(unitTally(rows, ''), { approved: 0, pending: 0 }, 'no unit, no tally');
});

test('no cap configured: nothing is ever over the limit', () => {
  const rows = rowsOf([1, 2, 3, 4, 5].map(n => longTerm(`p${n}`, { created_at: ago(n) })));
  assert.equal(overLimitKeys(rows, null).size, 0);
});

test('cap 2 with one approved and two pending: the newest pending request is over', () => {
  const rows = rowsOf([
    longTerm('ok', { status: 'approved', created_at: ago(200) }),
    longTerm('older', { created_at: ago(30) }),
    longTerm('newer', { created_at: ago(2) }),
  ]);
  assert.deepEqual([...overLimitKeys(rows, 2)], ['resident:newer']);
});

test('cap 2 with two approved: every pending request in the unit is over', () => {
  const rows = rowsOf([
    longTerm('a1', { status: 'approved' }),
    longTerm('a2', { status: 'approved' }),
    longTerm('p1', { created_at: ago(5) }),
    longTerm('p2', { created_at: ago(4) }),
  ]);
  assert.deepEqual([...overLimitKeys(rows, 2)].sort(), ['resident:p1', 'resident:p2']);
});

test('cap 1 with two pending: the oldest keeps the slot, the newest is over', () => {
  const rows = rowsOf([
    longTerm('first', { created_at: ago(10) }),
    longTerm('second', { created_at: ago(9) }),
  ]);
  assert.deepEqual([...overLimitKeys(rows, 1)], ['resident:second']);
});

test('short-term passes never count toward the cap and are never tagged over it', () => {
  const rows = rowsOf(
    [longTerm('a', { status: 'approved' }), longTerm('p', { created_at: ago(3) })],
    [1, 2, 3].map(n => shortTerm(`g${n}`, { host_unit: '214', created_at: ago(n) })),
  );
  assert.equal(overLimitKeys(rows, 2).size, 0);
  assert.equal(overLimitKeys(rows, 1).has('resident:p'), true, 'the long-term row still counts against cap 1');
  assert.equal([...overLimitKeys(rows, 1)].some(k => k.startsWith('guest:')), false);
});

test('"#214" and "214 " are the same unit for the cap', () => {
  const rows = rowsOf([
    longTerm('a', { status: 'approved', unit_number: '214' }),
    longTerm('b', { status: 'approved', unit_number: '#214' }),
    longTerm('p', { unit_number: '214 ' }),
  ]);
  assert.deepEqual([...overLimitKeys(rows, 2)], ['resident:p']);
});

test('requests with no unit are never over the limit', () => {
  const rows = rowsOf([1, 2, 3].map(n => longTerm(`n${n}`, { unit_number: '', created_at: ago(n) })));
  assert.equal(overLimitKeys(rows, 2).size, 0);
});

test('the cap chip reads "n of cap vehicles" and says the limit when it is passed', () => {
  assert.deepEqual(capChip({ approved: 1, pending: 1 }, 2), { text: '2 of 2 vehicles · 1 approved, 1 pending', over: false });
  assert.deepEqual(capChip({ approved: 0, pending: 1 }, 2), { text: '1 of 2 vehicles · 1 pending', over: false });
  assert.deepEqual(capChip({ approved: 2, pending: 1 }, 2), { text: '3 vehicles, limit 2 · 2 approved, 1 pending', over: true });
  assert.deepEqual(capChip({ approved: 1, pending: 1 }, null), { text: '2 vehicles · 1 approved, 1 pending', over: false });
  assert.deepEqual(capChip({ approved: 0, pending: 1 }, null), { text: '1 vehicle · 1 pending', over: false });
});

// ── Grouping and order ───────────────────────────────────────

function groupFixture() {
  return rowsOf(
    [
      longTerm('a', { unit_number: '214', plate_text: 'TEST0A', created_at: ago(10) }),
      longTerm('b', { unit_number: '#214', plate_text: 'TEST0B', created_at: ago(40) }),
      longTerm('c', { unit_number: '101', status: 'approved', created_at: ago(500) }),
      longTerm('d', { unit_number: '330', plate_text: 'TEST0D', created_at: ago(60) }),
      longTerm('e', { unit_number: '214', status: 'approved', created_at: ago(400) }),
    ],
    [shortTerm('g', { host_unit: '101', plate_text: 'TEST0G', created_at: ago(5) })],
  );
}

test('needs review groups by unit, oldest request first across and within groups', () => {
  const groups = reviewGroups(groupFixture(), { cap: 2 });
  assert.deepEqual(groups.map(g => g.key), ['330', '214', '101']);
  assert.deepEqual(groups.map(g => keys(g.rows)), [
    ['resident:d'],
    ['resident:b', 'resident:a'],
    ['guest:g'],
  ]);
});

test('a group is labelled with the unit as first typed and lists the other spellings', () => {
  const unit214 = reviewGroups(groupFixture(), { cap: 2 })[1];
  assert.equal(unit214.label, 'Unit #214');
  assert.deepEqual(unit214.variants, ['214']);
});

test('the group chip counts the unit\'s approved passes too, not only what is on screen', () => {
  const [unit330, unit214, unit101] = reviewGroups(groupFixture(), { cap: 2 });
  assert.deepEqual(unit214.chip, { text: '3 vehicles, limit 2 · 1 approved, 2 pending', over: true });
  assert.deepEqual(unit330.chip, { text: '1 of 2 vehicles · 1 pending', over: false });
  assert.equal(unit101.chip, null, 'a group with only a short-term request has no cap chip');
});

test('a search narrows the rows but never the cap math', () => {
  const groups = reviewGroups(groupFixture(), { cap: 2, q: 'test0a' });
  assert.deepEqual(groups.map(g => keys(g.rows)), [['resident:a']]);
  assert.deepEqual(groups[0].chip, { text: '3 vehicles, limit 2 · 1 approved, 2 pending', over: true });
});

test('requests without a unit share one "No unit given" group with no chip', () => {
  const groups = reviewGroups(rowsOf([longTerm('x', { unit_number: '  ' })]), { cap: 2 });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, 'No unit given');
  assert.equal(groups[0].chip, null);
});

test('approved lists long-term approved and live short-term passes, latest decision first', () => {
  const rows = rowsOf(
    [
      longTerm('old', { status: 'approved', reviewed_at: ago(48) }),
      longTerm('new', { status: 'approved', reviewed_at: ago(1) }),
      longTerm('legacy', { status: 'approved', reviewed_at: null, created_at: ago(30) }),
      longTerm('wait', { status: 'pending' }),
      longTerm('no', { status: 'rejected', reviewed_at: ago(2) }),
    ],
    [
      shortTerm('live', { status: 'active', reviewed_at: ago(3) }),
      shortTerm('gone', { status: 'expired', reviewed_at: ago(3) }),
    ],
  );
  assert.deepEqual(keys(decidedRows(rows, 'approved')), ['resident:new', 'guest:live', 'resident:legacy', 'resident:old']);
  assert.deepEqual(keys(decidedRows(rows, 'denied')), ['resident:no']);
  assert.deepEqual(keys(decidedRows(rows, 'approved', 'live')), [], 'search applies (no plate or unit says LIVE)');
});

test('segment counts follow the search', () => {
  const rows = groupFixture();
  assert.deepEqual(segmentCounts(rows), { pending: 4, approved: 2, denied: 0 });
  assert.deepEqual(segmentCounts(rows, '214'), { pending: 2, approved: 1, denied: 0 });
});

// ── The 72-hour review window ────────────────────────────────

test('age chip at 3 h, 30 h and 80 h after submission', () => {
  assert.deepEqual(protectionChip(ago(3), NOW), { tone: 'green', text: '2d 21h left' });
  assert.deepEqual(protectionChip(ago(30), NOW), { tone: 'green', text: '1d 18h left' });
  assert.deepEqual(protectionChip(ago(80), NOW), { tone: 'red', text: 'Protection ended 8h ago — still needs a decision' });
});

test('age chip turns amber at 24 hours left and counts hours, then minutes', () => {
  assert.deepEqual(protectionChip(ago(47.5), NOW), { tone: 'green', text: '1d left' });
  assert.deepEqual(protectionChip(ago(48), NOW), { tone: 'amber', text: '24h left' });
  assert.deepEqual(protectionChip(ago(50), NOW), { tone: 'amber', text: '22h left' });
  assert.deepEqual(protectionChip(ago(69), NOW), { tone: 'amber', text: '3h left' });
  assert.deepEqual(protectionChip(ago(71.5), NOW), { tone: 'amber', text: '30m left' });
});

test('age chip past the window says how long ago protection ended', () => {
  assert.deepEqual(protectionChip(ago(72), NOW), { tone: 'red', text: 'Protection ended just now — still needs a decision' });
  assert.deepEqual(protectionChip(ago(72.5), NOW), { tone: 'red', text: 'Protection ended 30m ago — still needs a decision' });
  assert.deepEqual(protectionChip(ago(100), NOW), { tone: 'red', text: 'Protection ended 1d 4h ago — still needs a decision' });
});

test('an unreadable timestamp has no chip; a clock-skewed future one reads the full window', () => {
  assert.equal(protectionChip(null, NOW), null);
  assert.equal(protectionChip('not a date', NOW), null);
  assert.deepEqual(protectionChip(new Date(NOW + 5 * 60000).toISOString(), NOW), { tone: 'green', text: '3d left' });
});

test('a short-term request is not protected, so its chip only says how long it has waited', () => {
  assert.deepEqual(waitingChip(ago(3), NOW), { tone: 'neutral', text: 'Waiting 3h' });
  assert.deepEqual(waitingChip(ago(30), NOW), { tone: 'neutral', text: 'Waiting 1d 6h' });
  assert.deepEqual(waitingChip(ago(1 / 3), NOW), { tone: 'neutral', text: 'Waiting 20m' });
  assert.deepEqual(waitingChip(ago(0.005), NOW), { tone: 'neutral', text: 'Just now' });
});

test('ageChip picks the window for long-term rows, the wait for short-term rows, nothing once decided', () => {
  const [lt, decided] = rowsOf([longTerm('p', { created_at: ago(80) }), longTerm('a', { status: 'approved' })]);
  const [st] = rowsOf([], [shortTerm('g', { created_at: ago(80) })]);
  assert.equal(ageChip(lt, NOW).tone, 'red');
  assert.deepEqual(ageChip(st, NOW), { tone: 'neutral', text: 'Waiting 3d 8h' });
  assert.equal(ageChip(decided, NOW), null);
});

// ── Denial reasons ───────────────────────────────────────────

test('the deny sheet offers the seven reasons in the agreed order', () => {
  assert.deepEqual(DENY_REASONS.map(r => r.label), [
    'A document is missing',
    'A document is unreadable or cut off',
    "The name on the documents doesn't match the lease",
    "The plate in the photo doesn't match the plate entered",
    "You're not listed as a leaseholder for this unit",
    'This unit already has the maximum number of vehicles',
    'Other (explain)',
  ]);
});

test('each reason sends one calm sentence, without the period the email adds', () => {
  const sent = Object.fromEntries(DENY_REASONS.map(r => [r.id, denyReasonText(r.id, '', { cap: 2 })]));
  assert.deepEqual(sent, {
    document_missing: 'A required document was missing from your request — please send it again with every document attached',
    document_unreadable: 'One of your documents was hard to read or cut off — please send your request again with a clear photo of the whole document',
    name_mismatch: "The name on your documents doesn't match the lease — please send your request again with documents in a leaseholder's name",
    plate_mismatch: "The plate in your photo doesn't match the plate number you entered — please check the number and send your request again",
    not_leaseholder: "You're not listed as a leaseholder for this unit, so a long-term parking pass isn't available — you can still ask for a short-term parking pass",
    over_cap: 'This unit has already reached its limit of 2 vehicles — ask the office if one of them should be removed',
    other: null,
  });
});

test('the over-limit sentence drops the number when no cap is configured', () => {
  assert.equal(
    denyReasonText('over_cap', '', { cap: null }),
    'This unit has already reached its vehicle limit — ask the office if one of them should be removed',
  );
});

test('"Other" sends what the manager wrote, tidied, and needs at least two characters', () => {
  assert.equal(denyReasonText('other', ' x '), null);
  assert.equal(denyReasonText('other', 'a.'), null, 'the period the email adds does not count');
  assert.equal(denyReasonText('other', 'ok'), 'ok');
  assert.equal(denyReasonText('other', '  Parked in the\n fire lane twice.  '), 'Parked in the fire lane twice');
  assert.equal(denyReasonText('other', 'x'.repeat(600)).length, 500);
});

test('an unknown or missing reason sends nothing', () => {
  assert.equal(denyReasonText('nope'), null);
  assert.equal(denyReasonText(null), null);
});

test('the preview is the email\'s own sentence', () => {
  assert.equal(
    decisionEmailLine({ propertyName: 'Example Commons', reason: 'Something was missing' }),
    'Your parking registration at Example Commons was not approved: Something was missing. If you have questions, please reply to this email.',
  );
  assert.equal(
    decisionEmailLine({ propertyName: '', reason: 'Something was missing' }),
    'Your parking registration was not approved: Something was missing. If you have questions, please reply to this email.',
  );
});

test('the deny sheet opens on "over limit" from the over-limit button, on "missing" when a document is', () => {
  const [full] = rowsOf([longTerm('f')]);
  const [noLease] = rowsOf([longTerm('n', { has_lease: false })]);
  assert.equal(initialDenyReason(full, { viaOverLimit: true }), 'over_cap');
  assert.equal(initialDenyReason(noLease, {}), 'document_missing');
  assert.equal(initialDenyReason(full, {}), null);
});

// ── Evidence ─────────────────────────────────────────────────

test('a long-term request shows five documents in order, each with what it should prove', () => {
  const [row] = rowsOf([longTerm('r1', { plate_text: 'ABC1234', holder_name: 'Jane Example', unit_number: '214', has_registration: false, has_vehicle_photo: true })]);
  assert.deepEqual(evidenceCards(row), [
    { which: 'plate', title: 'Plate photo', short: 'Plate', present: true, should: ['Should show ABC1234'] },
    { which: 'vehicle', title: 'Vehicle photo', short: 'Car', present: true, should: ['Should show ABC1234'] },
    { which: 'registration', title: 'Registration', short: 'Registration', present: false, should: ['Should show ABC1234', "Should be in a leaseholder's name"] },
    { which: 'id', title: 'Photo ID', short: 'ID', present: true, should: ['Should name Jane Example'] },
    { which: 'lease', title: 'Lease', short: 'Lease', present: true, should: ['Should name Jane Example and unit 214'] },
  ]);
});

test('a short-term request has a plate photo and a photo ID only', () => {
  const [row] = rowsOf([], [shortTerm('g1', { plate_text: 'XYZ987', visitor_name: '', has_id: false })]);
  assert.deepEqual(evidenceCards(row), [
    { which: 'plate', title: 'Plate photo', short: 'Plate', present: true, should: ['Should show XYZ987'] },
    { which: 'id', title: 'Photo ID', short: 'ID', present: false, should: ['Should name the person on this request'] },
  ]);
});

test('each document streams from the scoped docs proxy', () => {
  const [lt] = rowsOf([longTerm('7f1c2b9e-0000-4000-8000-000000000001')]);
  const [st] = rowsOf([], [shortTerm('7f1c2b9e-0000-4000-8000-000000000002')]);
  assert.equal(docPath(lt, 'registration'), '/apartment/docs/resident/7f1c2b9e-0000-4000-8000-000000000001/registration');
  assert.equal(docPath(lt, 'vehicle'), '/apartment/docs/resident/7f1c2b9e-0000-4000-8000-000000000001/vehicle');
  assert.equal(docPath(st, 'plate'), '/apartment/docs/guest/7f1c2b9e-0000-4000-8000-000000000002/plate');
});

test('missing documents are the expected ones a row lacks; registration only where the property asks for it', () => {
  const [lt] = rowsOf([longTerm('m', { has_lease: false, has_registration: false })]);
  const [st] = rowsOf([], [shortTerm('s', { has_id: false })]);
  assert.deepEqual(missingDocs(lt, { requireRegistration: true }), ['registration', 'lease']);
  assert.deepEqual(missingDocs(lt, { requireRegistration: false }), ['lease']);
  assert.deepEqual(missingDocs(st, {}), ['id']);
});

test('the vehicle photo is optional: never missing, never a reason to deny', () => {
  const [noCar] = rowsOf([longTerm('c', { has_vehicle_photo: false })]);
  assert.equal(evidenceCards(noCar).find(c => c.which === 'vehicle').present, false, 'still shown, as Not provided');
  assert.deepEqual(missingDocs(noCar, { requireRegistration: true }), []);
  assert.equal(initialDenyReason(noCar, {}), null);
  const [legacy] = rowsOf([{ ...longTerm('l'), has_vehicle_photo: undefined }]);
  assert.equal(evidenceCards(legacy).find(c => c.which === 'vehicle').present, false, 'a list without the column reads as not provided');
});

// ── URL state ────────────────────────────────────────────────

test('the queue reads its segment and search from the query, defaulting to Needs review', () => {
  assert.deepEqual(readQueueQuery(''), { status: 'pending', q: '' });
  assert.deepEqual(readQueueQuery('?status=denied&q=214'), { status: 'denied', q: '214' });
  assert.deepEqual(readQueueQuery('?status=bogus&q=%20%20ab%20'), { status: 'pending', q: 'ab' });
  assert.equal(readQueueQuery(`?q=${'9'.repeat(80)}`).q.length, 40);
});

test('writing the query keeps every other parameter and leaves defaults out', () => {
  assert.equal(writeQueueQuery('?property=p1&section=log', { status: 'pending', q: '' }), '?property=p1&section=log');
  assert.equal(writeQueueQuery('?property=p1&status=denied&q=old', { status: 'approved', q: 'ABC 12' }), '?property=p1&status=approved&q=ABC+12');
  assert.equal(writeQueueQuery('', { status: 'pending', q: '   ' }), '');
});

test('the query round-trips', () => {
  for (const state of [
    { status: 'pending', q: '' },
    { status: 'approved', q: 'ABC 12' },
    { status: 'denied', q: '#214' },
  ]) {
    assert.deepEqual(readQueueQuery(writeQueueQuery('?property=p1', state)), state);
  }
});

// ── Decisions ────────────────────────────────────────────────

test('an optimistic approval moves a long-term row to approved and a short-term row to active', () => {
  const [lt] = rowsOf([longTerm('r')]);
  const [st] = rowsOf([], [shortTerm('g')]);
  assert.deepEqual(approvedPatch(lt, '2026-10-15T16:00:00.000Z'), { status: 'approved', reviewed_at: '2026-10-15T16:00:00.000Z' });
  assert.deepEqual(approvedPatch(st, '2026-10-15T16:00:00.000Z'), { status: 'active', reviewed_at: '2026-10-15T16:00:00.000Z' });
});

test('"Next request" is the next row in queue order, never the one just decided', () => {
  const rows = groupFixture();
  assert.equal(nextPendingKey(rows, { cap: 2 }), 'resident:d');
  assert.equal(nextPendingKey(rows, { cap: 2, after: 'resident:d' }), 'resident:b');
  assert.equal(nextPendingKey(rows, { cap: 2, q: '101' }), 'guest:g');
  assert.equal(nextPendingKey(rowsOf([longTerm('x', { status: 'approved' })]), {}), null);
});

test('a failed action says what happened and whether the list is being refreshed', () => {
  assert.deepEqual(actionError(new TypeError('Failed to fetch'), 'approve'), {
    text: "Couldn't approve — check the connection and try again.", refresh: false,
  });
  assert.deepEqual(actionError(Object.assign(new Error('Pass is approved and cannot be reviewed'), { status: 409 }), 'approve'), {
    text: 'This request was already updated elsewhere — refreshing the list.', refresh: true,
  });
  assert.deepEqual(actionError(Object.assign(new Error('Pass not found'), { status: 404 }), 'void'), {
    text: 'This request is no longer on file — refreshing the list.', refresh: true,
  });
  assert.deepEqual(actionError(Object.assign(new Error('Server error (500)'), { status: 500 }), 'deny'), {
    text: "Couldn't deny. Try again.", refresh: false,
  });
  assert.deepEqual(actionError(Object.assign(new Error('expired'), { status: 401 }), 'approve'), {
    text: 'Your session ended. Sign in again to continue.', refresh: false,
  });
});

// ── Empty state and copy helpers ─────────────────────────────

test('the registration link is the apartment flow with the long-term role', () => {
  assert.equal(registrationLink('https://example.test', 'fort-mill-townhomes-i'), 'https://example.test/apt/fort-mill-townhomes-i?role=resident');
  assert.equal(registrationLink('https://example.test', 'a b'), 'https://example.test/apt/a%20b?role=resident');
  assert.equal(registrationLink('https://example.test', null), null);
});

test('all caught up names the approved vehicles and the property', () => {
  const rows = rowsOf(
    [longTerm('a', { status: 'approved' }), longTerm('b', { status: 'approved' }), longTerm('c', { status: 'rejected' })],
    [shortTerm('g', { status: 'active' })],
  );
  assert.equal(approvedVehicleCount(rows), 2, 'long-term passes only');
  assert.equal(allCaughtUpLine(41, 'Example Commons'), 'All caught up. 41 vehicles approved at Example Commons.');
  assert.equal(allCaughtUpLine(1, 'Example Commons'), 'All caught up. 1 vehicle approved at Example Commons.');
  assert.equal(allCaughtUpLine(0, ''), 'All caught up. 0 vehicles approved at this property.');
});

test('a unit label adds "Unit" unless a unit word was typed already', () => {
  assert.equal(unitLabel('214'), 'Unit 214');
  assert.equal(unitLabel('#214'), 'Unit #214');
  assert.equal(unitLabel('Apt 214'), 'Apt 214');
  assert.equal(unitLabel('unit 9'), 'unit 9');
  assert.equal(unitLabel(''), 'No unit given');
});

test('the decision line gives times only, in Eastern time', () => {
  const [approved, denied, pending, voided] = rowsOf([
    longTerm('a', { status: 'approved', reviewed_at: '2026-10-15T13:02:00Z' }),
    longTerm('d', { status: 'rejected', reviewed_at: '2026-10-14T19:10:00Z' }),
    longTerm('p', { status: 'pending', created_at: '2026-10-13T12:00:00Z' }),
    longTerm('v', { status: 'void', reviewed_at: '2026-10-15T20:30:00Z' }),
  ]);
  const [live] = rowsOf([], [shortTerm('g', { status: 'active', reviewed_at: '2026-10-15T13:02:00Z', valid_until: '2026-10-15T20:30:00Z' })]);
  assert.equal(decisionLine(approved), 'Approved Thu Oct 15, 9:02 AM ET');
  assert.equal(decisionLine(denied), 'Denied Wed Oct 14, 3:10 PM ET');
  assert.equal(decisionLine(pending), 'Submitted Tue Oct 13, 8:00 AM ET');
  assert.equal(decisionLine(voided), 'Voided Thu Oct 15, 4:30 PM ET');
  assert.equal(decisionLine(live), 'Ends Thu Oct 15, 4:30 PM ET');
  assert.equal(decisionLine({ ...approved, reviewed_at: null }), 'Approved');
});

test('the status tag always carries a word', () => {
  const rows = rowsOf(
    [longTerm('p'), longTerm('a', { status: 'approved' }), longTerm('d', { status: 'rejected' }), longTerm('v', { status: 'void' })],
    [shortTerm('g', { status: 'active' }), shortTerm('x', { status: 'expired' })],
  );
  assert.deepEqual(rows.map(statusTag), [
    { tone: 'amber', text: 'Needs review' },
    { tone: 'green', text: 'Approved' },
    { tone: 'red', text: 'Denied' },
    { tone: 'neutral', text: 'Voided' },
    { tone: 'green', text: 'Approved' },
    { tone: 'neutral', text: 'Ended' },
  ]);
});

// ── Wiring helpers the page uses ─────────────────────────────

test('each decision posts to its own route for the row\'s table', () => {
  const [lt] = rowsOf([longTerm('11111111-1111-4111-8111-111111111111')]);
  const [st] = rowsOf([], [shortTerm('22222222-2222-4222-8222-222222222222')]);
  assert.equal(actionPath(lt, 'approve'), '/apartment/passes/resident/11111111-1111-4111-8111-111111111111/approve');
  assert.equal(actionPath(lt, 'reject'), '/apartment/passes/resident/11111111-1111-4111-8111-111111111111/reject');
  assert.equal(actionPath(st, 'void'), '/apartment/passes/guest/22222222-2222-4222-8222-222222222222/void');
  assert.equal(actionPath(st, 'extend'), '/apartment/passes/guest/22222222-2222-4222-8222-222222222222/extend');
});

test('a server answer patches only the decision columns, never the reviewer', () => {
  assert.deepEqual(
    serverPatch({ id: 'x', status: 'active', valid_from: 'A', valid_until: 'B', reviewed_by: 'office@example.test', reviewed_at: 'C' }),
    { status: 'active', valid_from: 'A', valid_until: 'B', reviewed_at: 'C' },
  );
  assert.deepEqual(serverPatch({ status: 'rejected', reject_reason: 'R', reviewed_at: 'C' }), { status: 'rejected', reject_reason: 'R', reviewed_at: 'C' });
  assert.deepEqual(serverPatch(null), {});
});

test('patching a row replaces only that row', () => {
  const rows = rowsOf([longTerm('a'), longTerm('b')]);
  const next = patchRows(rows, 'resident:b', { status: 'approved' });
  assert.equal(next[1].status, 'approved');
  assert.equal(next[1].plate_text, 'TEST001', 'the rest of the row is kept');
  assert.equal(next[0], rows[0], 'other rows keep their identity');
  assert.equal(rows[1].status, 'pending', 'the input is not mutated');
  assert.equal(patchRows(rows, 'resident:none', { status: 'void' }), rows, 'an unknown key changes nothing');
});

test('Extend takes a whole number of hours from 1 to 72', () => {
  assert.equal(parseExtendHours('24'), 24);
  assert.equal(parseExtendHours(' 5 '), 5);
  assert.equal(parseExtendHours('1'), 1);
  assert.equal(parseExtendHours('72'), 72);
  for (const bad of ['0', '73', '1.5', 'abc', '', '-3', null]) assert.equal(parseExtendHours(bad), null, String(bad));
});

test('a phone number becomes a dialable tel: link', () => {
  assert.equal(telHref('(555) 010-0100'), 'tel:5550100100');
  assert.equal(telHref('+1 555 010 0100'), 'tel:+15550100100');
  assert.equal(telHref(''), null);
  assert.equal(telHref('call me'), null);
});

// ── Documents in the browser ─────────────────────────────────

function countingFetcher(fail = new Set()) {
  const calls = [];
  const fetcher = (path) => {
    calls.push(path);
    return fail.has(path) ? Promise.reject(new Error(`nope ${path}`)) : Promise.resolve(`blob:${path}`);
  };
  return { calls, fetcher };
}

test('the thumbnail and the detail card share one fetch per document', async () => {
  const { calls, fetcher } = countingFetcher();
  const cache = createDocCache(fetcher, 10);
  const [a, b] = [cache.get('/d/1/plate'), cache.get('/d/1/plate')];
  assert.equal(await a, 'blob:/d/1/plate');
  assert.equal(await b, 'blob:/d/1/plate');
  assert.deepEqual(calls, ['/d/1/plate']);
});

test('a failed document fetch is forgotten, so Try again fetches it again', async () => {
  const fail = new Set(['/d/2/id']);
  const { calls, fetcher } = countingFetcher(fail);
  const cache = createDocCache(fetcher, 10);
  await assert.rejects(cache.get('/d/2/id'), /nope/);
  fail.clear();
  assert.equal(await cache.get('/d/2/id'), 'blob:/d/2/id');
  assert.deepEqual(calls, ['/d/2/id', '/d/2/id']);
});

test('the cache keeps the most recently used documents and drops the oldest past its limit', async () => {
  const { calls, fetcher } = countingFetcher();
  const cache = createDocCache(fetcher, 2);
  await cache.get('A');
  await cache.get('B');
  await cache.get('A');       // A is now the most recent
  await cache.get('C');       // evicts B
  await cache.get('A');       // still cached
  await cache.get('B');       // fetched again
  assert.deepEqual(calls, ['A', 'B', 'C', 'B']);
});

test('what a document can be previewed as, from the type the proxy served', () => {
  assert.equal(previewKind('application/pdf'), 'pdf');
  assert.equal(previewKind('image/jpeg'), 'image');
  assert.equal(previewKind('image/heic'), 'image', 'the browser decides: Safari renders it, Chrome errors to the fallback');
  assert.equal(previewKind('application/octet-stream'), 'none');
  assert.equal(previewKind(''), 'none');
  assert.equal(previewKind(undefined), 'none');
});

test('a downloaded document is named for what it is, with the right extension', () => {
  const [row] = rowsOf([longTerm('r', { plate_text: 'ABC 1234' })]);
  assert.equal(downloadName(row, 'plate', 'image/heic'), 'plate-ABC1234.heic');
  assert.equal(downloadName(row, 'registration', 'application/pdf'), 'registration-ABC1234.pdf');
  assert.equal(downloadName(row, 'id', 'application/octet-stream'), 'id-ABC1234');
});

test('a temp tag date is a calendar day, the same in every time zone', () => {
  assert.equal(tagDateLabel('2026-10-20'), 'Oct 20');
  assert.equal(tagDateLabel('2026-01-01'), 'Jan 1');
  assert.equal(tagDateLabel(''), '');
  assert.equal(tagDateLabel('soon'), 'soon', 'anything unparseable is shown as stored');
  assert.equal(tagDateLabel('2026-13-01'), '2026-13-01', 'an impossible month is shown as stored, not rolled into January');
  assert.equal(tagDateLabel('2026-12-31'), 'Dec 31');
});
