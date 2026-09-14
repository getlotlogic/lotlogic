// Unit tests for src/lib/lotdate.js's `timeZone` argument (Wave 2.1 Task 10,
// frontend half). The backend half (services/lot_time.py) landed separately;
// this covers only what changed here: tzOffsetOn / tzOffsetAt / lotDayBound
// now take an optional `timeZone`, defaulting to LOT_TIMEZONE so a caller
// that never passes one — including every property today, decision 8 — gets
// byte-identical output to before this argument existed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LOT_TIMEZONE, lotDayBound, tzOffsetOn, tzOffsetAt } from '../src/lib/lotdate.js';

test('lotDayBound: a NULL/unconfigured property (no timeZone arg) reproduces the exact Wave 1 8pm-midnight fix', () => {
  // This is the regression the module's own header comment describes: a bare
  // date or a `Z`-stamped one ended the day at 19:59:59 Eastern, dropping
  // every truck that registered between 8pm and midnight. Assert the fixed
  // bound is still what it was before this task, with no timeZone passed —
  // i.e. a property whose config has never been written.
  const start = lotDayBound('2026-09-03', 'start');
  const end = lotDayBound('2026-09-03', 'end');
  assert.equal(start, '2026-09-03T00:00:00.000-04:00');
  assert.equal(end, '2026-09-03T23:59:59.999-04:00');
  // An 11:30pm Eastern registration must fall inside the window.
  const lateNight = new Date('2026-09-03T23:30:00.000-04:00').getTime();
  assert.ok(lateNight >= new Date(start).getTime() && lateNight <= new Date(end).getTime(),
    'an 8pm-midnight registration must remain inside "today" for an unconfigured property');
});

test('lotDayBound: passing timeZone=undefined explicitly matches omitting it (unconfigured config.timezone)', () => {
  // services/property_config.py resolves an absent `config.timezone` to
  // undefined/None before it ever reaches the frontend prop — this is the
  // shape TruckParkingLog actually passes for the ~100% of properties that
  // have never had config written (decision 8).
  for (const edge of ['start', 'end']) {
    assert.equal(lotDayBound('2026-09-03', edge, undefined), lotDayBound('2026-09-03', edge));
  }
  assert.equal(tzOffsetOn('2026-09-03', undefined), tzOffsetOn('2026-09-03'));
  assert.equal(tzOffsetAt(new Date('2026-09-03T12:00:00Z'), undefined), tzOffsetAt(new Date('2026-09-03T12:00:00Z')));
});

test('lotDayBound: passing the same value as LOT_TIMEZONE explicitly is byte-identical to the default', () => {
  assert.equal(lotDayBound('2026-09-03', 'start', LOT_TIMEZONE), lotDayBound('2026-09-03', 'start'));
  assert.equal(lotDayBound('2026-09-03', 'end', LOT_TIMEZONE), lotDayBound('2026-09-03', 'end'));
});

test('lotDayBound: a configured Pacific/Honolulu property actually shifts the day', () => {
  // Honolulu never observes DST, so this is a clean fixed -10:00 offset —
  // proof the argument is actually threaded through to Intl, not ignored.
  const start = lotDayBound('2026-06-15', 'start', 'Pacific/Honolulu');
  const end = lotDayBound('2026-06-15', 'end', 'Pacific/Honolulu');
  assert.equal(start, '2026-06-15T00:00:00.000-10:00');
  assert.equal(end, '2026-06-15T23:59:59.999-10:00');
  // And it must differ from the Eastern bound for the same calendar day —
  // the whole point of threading a per-property zone through.
  assert.notEqual(start, lotDayBound('2026-06-15', 'start'));
  assert.notEqual(new Date(start).getTime(), new Date(lotDayBound('2026-06-15', 'start')).getTime());
});

test('lotDayBound: the DST fall-back day (2026-11-01, America/New_York) spans ~25 hours, offset-aware at each edge', () => {
  // Clocks fall back at 2am local on 2026-11-01 (Sunday) — the calendar day
  // starts in EDT (-04:00, before the switch) and ends in EST (-05:00, after
  // it). tzOffsetAt (not tzOffsetOn) is what gives each edge its own offset;
  // this is the DST-boundary case the brief calls out explicitly.
  const start = lotDayBound('2026-11-01', 'start');
  const end = lotDayBound('2026-11-01', 'end');
  assert.equal(start, '2026-11-01T00:00:00.000-04:00');
  assert.equal(end, '2026-11-01T23:59:59.999-05:00');
  const spanHours = (new Date(end).getTime() - new Date(start).getTime()) / 3600000;
  assert.ok(spanHours > 24.9 && spanHours < 25, `expected ~25h span, got ${spanHours}h`);
});

test('lotDayBound: a non-bare-date string (already a full timestamp) passes straight through regardless of timeZone', () => {
  // TruckParkingLog resolves filters.date_from/date_to to full instants
  // itself and hands db.js the result — db.js's own lotDayBound call must
  // treat that as already-resolved and leave it alone, exactly as it did
  // before this task, so wiring the zone through TruckParkingLog doesn't
  // depend on db.js also knowing about it.
  const already = '2026-09-03T00:00:00.000-04:00';
  assert.equal(lotDayBound(already, 'start', 'Pacific/Honolulu'), already);
  assert.equal(lotDayBound('', 'start', 'Pacific/Honolulu'), '');
});
