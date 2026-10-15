// Tests for frontend/src/lib/lotStatus.js - the pure half of the Lot status
// tab and the Lookup timeline (spec 2026-10-15-lot-status §2, §4).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_COPY,
  asOfLine,
  csvFilename,
  csvRows,
  csvText,
  filterByPlate,
  formatEnds,
  formatExpired,
  formatUntil,
  lastCheckLine,
  listTotals,
  timelineKindLabel,
  tiles,
} from '../src/lib/lotStatus.js';

test('formatExpired: hours under a day, then days', () => {
  assert.equal(formatExpired(3), 'expired 3h ago');
  assert.equal(formatExpired(1), 'expired 1h ago');
  assert.equal(formatExpired(23), 'expired 23h ago');
  assert.equal(formatExpired(48), 'expired 2d ago');
  assert.equal(formatExpired(71), 'expired 2d ago');
  assert.equal(formatExpired(24), 'expired 1d ago');
});

test('formatExpired: under an hour and bad input never read as nonsense', () => {
  assert.equal(formatExpired(0), 'expired under 1h ago');
  assert.equal(formatExpired(0.4), 'expired under 1h ago');
  assert.equal(formatExpired(null), 'expired');
  assert.equal(formatExpired(undefined), 'expired');
  assert.equal(formatExpired('x'), 'expired');
});

test('formatEnds: the clock in ET, with the weekday only when it is another ET day', () => {
  const now = '2026-10-15T20:00:00Z'; // 4:00 PM EDT Thu
  assert.equal(formatEnds('2026-10-16T03:40:00Z', now), 'ends 11:40 PM');
  assert.equal(formatEnds('2026-10-16T04:10:00Z', now), 'ends Fri 12:10 AM');
  assert.equal(formatEnds('nope', now), '');
  assert.equal(formatEnds(null, now), '');
});

test('formatUntil: do-not-tow rows with and without an end', () => {
  const now = '2026-10-15T20:00:00Z';
  assert.equal(formatUntil('2026-10-16T03:40:00Z', now), 'until 11:40 PM');
  assert.equal(formatUntil('2026-10-17T10:00:00Z', now), 'until Sat 6:00 AM');
  assert.equal(formatUntil(null, now), 'no end date');
});

test('lastCheckLine: how long ago and what the verdict was', () => {
  const now = '2026-10-15T20:00:00Z';
  assert.equal(lastCheckLine({ at: '2026-10-15T19:00:00Z', verdict: 'tow' }, now), 'last check 1h ago: tow');
  assert.equal(lastCheckLine({ at: '2026-10-15T19:50:00Z', verdict: 'not_registered' }, now), 'last check 10m ago: not registered');
  assert.equal(lastCheckLine({ at: '2026-10-15T19:59:50Z', verdict: 'tow' }, now), 'last check just now: tow');
  assert.equal(lastCheckLine({ at: '2026-10-13T20:00:00Z', verdict: 'tow' }, now), 'last check 2d ago: tow');
  assert.equal(lastCheckLine(null, now), 'no plate check yet');
});

test('asOfLine renders the server instant in ET', () => {
  assert.equal(asOfLine('2026-10-15T18:15:00Z'), 'As of 2:15 PM ET');
  assert.equal(asOfLine(null), '');
});

test('tiles: the six counts in the spec order, missing counts read 0', () => {
  const t = tiles({ registered_long_term: 42, short_term_active: 6, pending_protected: 3, holds_active: 2, open_requests: 1, towable: 4, expired_24h: 9 });
  assert.deepEqual(t.map(x => x.label), ['Registered', 'Short-term', 'Pending', 'Holds', 'Open', 'Towable']);
  assert.deepEqual(t.map(x => x.value), [42, 6, 3, 2, 1, 4]);
  assert.deepEqual(tiles(null).map(x => x.value), [0, 0, 0, 0, 0, 0]);
});

test('csvRows: header, then plate / car / kind / expired at / hours / last check', () => {
  const rows = csvRows([
    { plate: 'ABC1234', vehicle: 'white Honda Civic', kind: 'short_term', expired_at: '2026-10-15T15:00:00Z', hours_expired: 3, last_check: { at: '2026-10-15T17:00:00Z', verdict: 'tow' } },
    { plate: 'XYZ789', vehicle: '', kind: 'long_term', expired_at: '2026-10-13T04:00:00Z', hours_expired: 50, last_check: null },
  ]);
  assert.deepEqual(rows[0], ['Plate', 'Car', 'Pass', 'Expired at (ET)', 'Hours expired', 'Last check']);
  assert.deepEqual(rows[1], ['ABC1234', 'white Honda Civic', 'Short-term', 'Thu Oct 15, 11:00 AM ET', '3', 'tow at Thu Oct 15, 1:00 PM ET']);
  assert.deepEqual(rows[2], ['XYZ789', '', 'Long-term', 'Tue Oct 13, 12:00 AM ET', '50', '']);
  assert.deepEqual(csvRows([]), [rows[0]]);
  assert.deepEqual(csvRows(null), [rows[0]]);
});

test('csvText: quotes commas, quotes and newlines; neutralises spreadsheet formulas', () => {
  const text = csvText([['a', 'b,c', 'say "hi"', 'x\ny'], ['=1+1', '+2', '-3', '@x']]);
  assert.equal(text, 'a,"b,c","say ""hi""","x\ny"\r\n\'=1+1,\'+2,\'-3,\'@x\r\n');
});

test('csvFilename: <slug>-towable-<date>.csv with the ET date', () => {
  assert.equal(csvFilename('Spring Lake Apartments', '2026-10-16T03:30:00Z'), 'spring-lake-apartments-towable-2026-10-15.csv');
  assert.equal(csvFilename('', '2026-10-15T18:00:00Z'), 'lot-towable-2026-10-15.csv');
  assert.equal(csvFilename("Fort Mill #2 (North)", '2026-10-15T18:00:00Z'), 'fort-mill-2-north-towable-2026-10-15.csv');
});

test('filterByPlate: normalised substring, empty keeps everything, other keys untouched', () => {
  const rows = [{ plate: 'ABC1234' }, { plate: 'XYZ789' }, { plate: 'ABD5555' }];
  assert.deepEqual(filterByPlate(rows, 'ab'), [rows[0], rows[2]]);
  assert.deepEqual(filterByPlate(rows, ' abc-12 '), [rows[0]]);
  assert.deepEqual(filterByPlate(rows, ''), rows);
  assert.deepEqual(filterByPlate(rows, '   '), rows);
  assert.deepEqual(filterByPlate(rows, 'zzz'), []);
  assert.deepEqual(filterByPlate(null, 'a'), []);
});

test('listTotals: capped lists say how many more there are', () => {
  const counts = { registered_long_term: 60, short_term_active: 6, pending_protected: 3, holds_active: 2, towable: 63, expiring_4h: 2 };
  const data = { counts, towable: new Array(50).fill({}), do_not_tow: new Array(50).fill({}), expiring_soon: [{}, {}] };
  assert.deepEqual(listTotals(data), { towable: 63, do_not_tow: 71, expiring_soon: 2 });
  assert.deepEqual(listTotals({ counts: {}, towable: [{}], do_not_tow: [], expiring_soon: [] }), { towable: 1, do_not_tow: 0, expiring_soon: 0 });
});

test('empty-state copy is the spec text, verbatim', () => {
  assert.equal(EMPTY_COPY.towable, 'Nothing to tow right now.');
  assert.equal(EMPTY_COPY.do_not_tow, 'No holds or pending requests.');
  assert.equal(EMPTY_COPY.expiring_soon, 'Nothing ending in the next 4 hours.');
  assert.equal(EMPTY_COPY.timeline, 'No history for this plate here.');
});

test('timelineKindLabel covers every kind in the contract', () => {
  for (const k of ['pass_filed', 'pass_approved', 'pass_rejected', 'pass_expired', 'pass_cancelled', 'pass_exited', 'check', 'hold_opened', 'hold_ended', 'request_opened', 'request_resolved', 'towed']) {
    assert.ok(timelineKindLabel(k).label, k);
  }
  assert.equal(timelineKindLabel('something_new').label, 'Update');
});

import { LOT_STATUS_CHIP, rowTarget, withLotStatusChip } from '../src/lib/lotStatus.js';

const APARTMENT_CHIPS = [{ id: 'requests', label: 'Requests' }, { id: 'all', label: 'All' }, { id: 'log', label: 'Parking Passes' }, { id: 'qr', label: 'QR codes', locked: true }];

test('withLotStatusChip: first for a partner, right after Parking Passes for an owner', () => {
  assert.deepEqual(withLotStatusChip(APARTMENT_CHIPS, { isPartner: true }).map(c => c.id), ['lotstatus', 'requests', 'all', 'log', 'qr']);
  assert.deepEqual(withLotStatusChip(APARTMENT_CHIPS).map(c => c.id), ['requests', 'all', 'log', 'lotstatus', 'qr']);
  assert.equal(LOT_STATUS_CHIP.label, 'Lot status');
});

test('withLotStatusChip: never twice, and lands last when Parking Passes is absent', () => {
  const once = withLotStatusChip(APARTMENT_CHIPS);
  assert.equal(withLotStatusChip(once).filter(c => c.id === 'lotstatus').length, 1);
  assert.deepEqual(withLotStatusChip([{ id: 'all', label: 'All' }]).map(c => c.id), ['all', 'lotstatus']);
  assert.deepEqual(withLotStatusChip(null).map(c => c.id), ['lotstatus']);
});

test('rowTarget: holds open Requests, passes open the queue searched by plate', () => {
  assert.deepEqual(rowTarget({ plate: 'ABC1234', reason: 'hold', ref: 'H-0012' }, 'do_not_tow'), { section: 'requests' });
  assert.deepEqual(rowTarget({ plate: 'ABC1234', reason: 'pending' }, 'do_not_tow'), { section: 'log', status: 'pending', q: 'ABC1234' });
  assert.deepEqual(rowTarget({ plate: 'ABC1234', reason: 'short_term' }, 'do_not_tow'), { section: 'log', status: 'approved', q: 'ABC1234' });
  assert.deepEqual(rowTarget({ plate: 'XYZ789', kind: 'long_term' }, 'towable'), { section: 'log', status: 'approved', q: 'XYZ789' });
  assert.deepEqual(rowTarget({ plate: 'XYZ789', kind: 'short_term' }, 'expiring_soon'), { section: 'log', status: 'approved', q: 'XYZ789' });
});
