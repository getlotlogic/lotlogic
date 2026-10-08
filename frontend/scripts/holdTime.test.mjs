// Tests for frontend/src/lib/holdTime.js — the Requests composer's pure
// helpers (spec §4.3 presets and the button label, §5.2 plate validation and
// the row's time line).
//
// Everything here is a pure function over an instant, so the assertions can
// pin exact strings. The two things worth stating up front:
//
//  1. Every label is rendered in `America/New_York` with "ET" spelled out,
//     whatever the machine running the test is set to. The tests therefore
//     assert the ET rendering of a UTC instant, never a local one.
//  2. The spec's illustrative labels ("Wed Oct 8, 9:14 PM ET", "Thu Oct 9,
//     9:14 PM ET") are a real Wednesday and Thursday in **2025** — Oct 8
//     2026 is a Thursday. So the assertions that pin those verbatim spec
//     strings use the 2025 instants, and a separate case covers the 2026
//     instant the task brief names with its arithmetically correct label.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_HOLD_RULES,
  buttonLabel,
  defaultPresetId,
  extendChips,
  extendLabel,
  fmtET,
  fmtETClock,
  fmtETShort,
  holdRowTime,
  minutesLeft,
  normalizePlate,
  pickerMax,
  pickerMin,
  plateFieldError,
  plateNote,
  presets,
  toLocalInputValue,
} from '../src/lib/holdTime.js';

// The ET wall-clock fields of an instant, as a plain object, so a test can say
// "tomorrow 06:00 ET" without doing offset arithmetic by hand.
function etFields(d) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const out = {};
  for (const p of parts) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return out;
}

// ── fmtET and the button labels ──────────────────────────────

test('fmtET renders an instant as "<Wkd Mon D>, <h:mm AM/PM> ET"', () => {
  assert.equal(fmtET(new Date('2025-10-09T01:14:00Z')), 'Wed Oct 8, 9:14 PM ET');
});

test('fmtET is America/New_York, not the machine zone', () => {
  // 2025-01-15T18:30Z is 1:30 PM EST — a different calendar hour from UTC and
  // from every zone east of London.
  assert.equal(fmtET(new Date('2025-01-15T18:30:00Z')), 'Wed Jan 15, 1:30 PM ET');
});

test('fmtET crosses the ET date line correctly', () => {
  // 03:30Z on the 9th is still 11:30 PM on the 8th in ET.
  assert.equal(fmtET(new Date('2025-10-09T03:30:00Z')), 'Wed Oct 8, 11:30 PM ET');
});

test('fmtET renders midnight and noon as 12, never 0 or 24', () => {
  assert.equal(fmtET(new Date('2025-10-09T04:00:00Z')), 'Thu Oct 9, 12:00 AM ET');
  assert.equal(fmtET(new Date('2025-10-09T16:00:00Z')), 'Thu Oct 9, 12:00 PM ET');
});

test('fmtET of nothing is the empty string, not "Invalid Date"', () => {
  assert.equal(fmtET(null), '');
  assert.equal(fmtET(undefined), '');
  assert.equal(fmtET(''), '');
  assert.equal(fmtET('not a date'), '');
});

test('fmtET accepts an ISO string as well as a Date', () => {
  assert.equal(fmtET('2025-10-09T01:14:00Z'), 'Wed Oct 8, 9:14 PM ET');
});

test('buttonLabel is the spec§4.3 sentence, date and ET included', () => {
  assert.equal(
    buttonLabel(new Date('2025-10-09T01:14:00Z')),
    'Put on hold until Wed Oct 8, 9:14 PM ET',
  );
});

test('buttonLabel of the brief’s 2026 instant names the ET day it really is', () => {
  // 2026-10-08T01:14Z is 9:14 PM on Wednesday **October 7** in ET. The task
  // brief's "Wed Oct 8" pairs 2025's weekday with 2026's date; the function
  // must not reproduce that.
  assert.equal(
    buttonLabel(new Date('2026-10-08T01:14:00Z')),
    'Put on hold until Wed Oct 7, 9:14 PM ET',
  );
});

test('extendLabel is the spec §5.2 sentence', () => {
  assert.equal(
    extendLabel(new Date('2025-10-10T01:14:00Z')),
    'Extend to Thu Oct 9, 9:14 PM ET',
  );
});

test('fmtETShort is weekday + clock, fmtETClock is the clock alone', () => {
  assert.equal(fmtETShort(new Date('2025-10-08T01:12:00Z')), 'Tue 9:12 PM');
  assert.equal(fmtETClock(new Date('2025-10-08T01:40:00Z')), '9:40 PM');
});

// ── presets ──────────────────────────────────────────────────

test('presets are Overnight / 24 hours / 3 days / 7 days, in that order', () => {
  const p = presets(new Date('2026-10-07T13:00:00Z'));
  assert.deepEqual(p.map(x => x.id), ['overnight', 'h24', 'd3', 'd7']);
  assert.deepEqual(p.map(x => x.label), [
    'Overnight · until 6 AM', '24 hours', '3 days', '7 days',
  ]);
});

test('24 hours is the preselected preset', () => {
  assert.equal(defaultPresetId(), 'h24');
  assert.equal(defaultPresetId(DEFAULT_HOLD_RULES), 'h24');
  // It must be a preset that actually exists in the list.
  assert.ok(presets(new Date()).some(p => p.id === defaultPresetId()));
});

test('the duration presets carry hours the API will accept (1–168)', () => {
  const p = presets(new Date('2026-10-07T13:00:00Z'));
  const byId = Object.fromEntries(p.map(x => [x.id, x]));
  assert.equal(byId.h24.durationHours, 24);
  assert.equal(byId.d3.durationHours, 72);
  assert.equal(byId.d7.durationHours, 168);
  // Overnight is an absolute time, so it has no duration to send.
  assert.equal(byId.overnight.durationHours, null);
  for (const x of p) {
    if (x.durationHours === null) continue;
    assert.ok(x.durationHours >= 1 && x.durationHours <= 168, `${x.id} out of range`);
  }
});

test('the duration presets are exactly that many hours from now', () => {
  const now = new Date('2026-10-07T13:00:00Z');
  const byId = Object.fromEntries(presets(now).map(x => [x.id, x]));
  assert.equal(byId.h24.expiresAt.getTime() - now.getTime(), 24 * 3600000);
  assert.equal(byId.d3.expiresAt.getTime() - now.getTime(), 72 * 3600000);
  assert.equal(byId.d7.expiresAt.getTime() - now.getTime(), 168 * 3600000);
});

test('overnight at 3:00 AM ET is today 6:00 AM ET — 3 hours is over the floor', () => {
  // 07:00Z on 2026-10-07 is 03:00 EDT.
  const overnight = presets(new Date('2026-10-07T07:00:00Z'))[0];
  assert.deepEqual(etFields(overnight.expiresAt), {
    year: 2026, month: 10, day: 7, hour: 6, minute: 0,
  });
});

test('overnight at 5:30 AM ET rolls to TOMORROW 6:00 AM — the 1-hour floor', () => {
  // 09:30Z on 2026-10-07 is 05:30 EDT: today's 06:00 is only 30 minutes away,
  // so the 1-hour floor pushes it to the 8th (spec §4.3).
  const overnight = presets(new Date('2026-10-07T09:30:00Z'))[0];
  assert.deepEqual(etFields(overnight.expiresAt), {
    year: 2026, month: 10, day: 8, hour: 6, minute: 0,
  });
});

test('overnight at exactly 5:00 AM ET is today 6:00 AM — the floor is inclusive', () => {
  const overnight = presets(new Date('2026-10-07T09:00:00Z'))[0];
  assert.deepEqual(etFields(overnight.expiresAt), {
    year: 2026, month: 10, day: 7, hour: 6, minute: 0,
  });
});

test('overnight at 9:00 AM ET is tomorrow 6:00 AM', () => {
  // 13:00Z on 2026-10-07 is 09:00 EDT.
  const overnight = presets(new Date('2026-10-07T13:00:00Z'))[0];
  assert.deepEqual(etFields(overnight.expiresAt), {
    year: 2026, month: 10, day: 8, hour: 6, minute: 0,
  });
});

test('overnight at 11:30 PM ET is the next morning, not the one just gone', () => {
  // 03:30Z on the 8th is 23:30 EDT on the 7th.
  const overnight = presets(new Date('2026-10-08T03:30:00Z'))[0];
  assert.deepEqual(etFields(overnight.expiresAt), {
    year: 2026, month: 10, day: 8, hour: 6, minute: 0,
  });
});

test('overnight lands on 6:00 AM ET across the November DST fall-back', () => {
  // 2026-11-01 is the EDT -> EST switch. 2026-11-01T02:00Z is 10:00 PM EDT on
  // Oct 31; the next 6 AM is 06:00 EST on Nov 1 = 11:00Z, a 25-hour night.
  const overnight = presets(new Date('2026-11-01T02:00:00Z'))[0];
  assert.deepEqual(etFields(overnight.expiresAt), {
    year: 2026, month: 11, day: 1, hour: 6, minute: 0,
  });
  assert.equal(overnight.expiresAt.toISOString(), '2026-11-01T11:00:00.000Z');
});

test('overnight lands on 6:00 AM ET across the March DST spring-forward', () => {
  // 2026-03-08 is the EST -> EDT switch; 06:00 EDT is 10:00Z.
  const overnight = presets(new Date('2026-03-08T03:00:00Z'))[0];
  assert.deepEqual(etFields(overnight.expiresAt), {
    year: 2026, month: 3, day: 8, hour: 6, minute: 0,
  });
  assert.equal(overnight.expiresAt.toISOString(), '2026-03-08T10:00:00.000Z');
});

test('the overnight hour comes from hold_rules and is named in the label', () => {
  const p = presets(new Date('2026-10-07T13:00:00Z'), { overnight_hour: 5 });
  assert.equal(p[0].label, 'Overnight · until 5 AM');
  assert.deepEqual(etFields(p[0].expiresAt), {
    year: 2026, month: 10, day: 8, hour: 5, minute: 0,
  });
});

test('an overnight hour of 0 reads "12 AM", 13 reads "1 PM"', () => {
  assert.equal(presets(new Date('2026-10-07T13:00:00Z'), { overnight_hour: 0 })[0].label,
    'Overnight · until 12 AM');
  assert.equal(presets(new Date('2026-10-07T13:00:00Z'), { overnight_hour: 13 })[0].label,
    'Overnight · until 1 PM');
});

test('hold_rules may only tighten: max_days 3 drops the 7-day chip', () => {
  const p = presets(new Date('2026-10-07T13:00:00Z'), { max_days: 3 });
  assert.deepEqual(p.map(x => x.id), ['overnight', 'h24', 'd3']);
  assert.deepEqual(p.map(x => x.label), ['Overnight · until 6 AM', '24 hours', '3 days']);
});

test('hold_rules may not loosen past the DB ceiling of 7 days', () => {
  const p = presets(new Date('2026-10-07T13:00:00Z'), { max_days: 30 });
  assert.equal(p[p.length - 1].durationHours, 168);
  assert.equal(p[p.length - 1].label, '7 days');
});

test('max_days 1 leaves Overnight and 24 hours only', () => {
  const p = presets(new Date('2026-10-07T13:00:00Z'), { max_days: 1 });
  assert.deepEqual(p.map(x => x.id), ['overnight', 'h24']);
});

test('a junk hold_rules object falls back to the documented defaults', () => {
  for (const rules of [null, undefined, 'nope', {}, { overnight_hour: 99, max_days: 0 }]) {
    const p = presets(new Date('2026-10-07T13:00:00Z'), rules);
    assert.equal(p[0].label, 'Overnight · until 6 AM', JSON.stringify(rules));
    assert.ok(p.some(x => x.id === 'h24'), JSON.stringify(rules));
  }
});

test('DEFAULT_HOLD_RULES is the spec §4.3 default jsonb', () => {
  assert.deepEqual(DEFAULT_HOLD_RULES, {
    default_hours: 24, max_days: 7, overnight_hour: 6, pending_hold_cap: 3,
  });
});

// ── the picker bounds ────────────────────────────────────────

test('the "Pick a time" picker is capped at max_days out', () => {
  const now = new Date('2026-10-07T13:00:00Z');
  assert.equal(pickerMax(now), toLocalInputValue(new Date(now.getTime() + 168 * 3600000)));
  assert.equal(pickerMax(now, { max_days: 3 }),
    toLocalInputValue(new Date(now.getTime() + 72 * 3600000)));
  // Never past the DB ceiling, whatever hold_rules says.
  assert.equal(pickerMax(now, { max_days: 99 }),
    toLocalInputValue(new Date(now.getTime() + 168 * 3600000)));
});

test('the picker floor is an hour out — duration_hours starts at 1', () => {
  const now = new Date('2026-10-07T13:00:00Z');
  assert.equal(pickerMin(now), toLocalInputValue(new Date(now.getTime() + 3600000)));
});

test('toLocalInputValue is the datetime-local shape, no seconds, no zone', () => {
  const v = toLocalInputValue(new Date('2026-10-07T13:00:00Z'));
  assert.match(v, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  // It is the browser's own zone, so `new Date(v)` round-trips to the minute.
  assert.equal(Math.abs(new Date(v).getTime() - Date.parse('2026-10-07T13:00:00Z')) < 60000, true);
});

// ── the row's time line ──────────────────────────────────────

test('minutesLeft rounds down and never goes negative', () => {
  const now = new Date('2026-10-07T13:00:00Z');
  assert.equal(minutesLeft(new Date('2026-10-07T13:48:30Z'), now), 48);
  assert.equal(minutesLeft(new Date('2026-10-07T12:00:00Z'), now), 0);
  assert.equal(minutesLeft(null, now), null);
});

test('over an hour left, the hold row reads "until <ET> · 22h"', () => {
  const now = new Date('2026-10-07T01:14:00Z');
  const line = holdRowTime(new Date('2026-10-07T23:14:00Z'), now);
  assert.equal(line.urgent, false);
  assert.equal(line.until, 'until Wed Oct 7, 7:14 PM ET');
  assert.equal(line.tail, '22h');
});

test('under an hour left, the tail is the amber Extend nudge', () => {
  const now = new Date('2026-10-07T13:00:00Z');
  const line = holdRowTime(new Date('2026-10-07T13:48:00Z'), now);
  assert.equal(line.urgent, true);
  assert.equal(line.tail, '⚠ 48 min left — Extend?');
  // The ET time stays on screen — "rendered in America/New_York with ET on
  // every surface" is not waived by the nudge.
  assert.equal(line.until, 'until Wed Oct 7, 9:48 AM ET');
});

test('exactly 60 minutes left is not yet urgent', () => {
  const now = new Date('2026-10-07T13:00:00Z');
  assert.equal(holdRowTime(new Date('2026-10-07T14:00:00Z'), now).urgent, false);
  assert.equal(holdRowTime(new Date('2026-10-07T13:59:00Z'), now).urgent, true);
});

test('an already-past expiry reads 0 min left and stays urgent', () => {
  const now = new Date('2026-10-07T13:00:00Z');
  const line = holdRowTime(new Date('2026-10-07T12:00:00Z'), now);
  assert.equal(line.urgent, true);
  assert.equal(line.tail, '⚠ 0 min left — Extend?');
});

test('holdRowTime prefers the server’s expires_local over client math', () => {
  const now = new Date('2026-10-07T13:00:00Z');
  const line = holdRowTime(new Date('2026-10-08T13:00:00Z'), now, 'Fri Oct 10, 6:00 PM ET');
  assert.equal(line.until, 'until Fri Oct 10, 6:00 PM ET');
  // The countdown is still computed from the instant, not from the string.
  assert.equal(line.tail, '24h');
});

test('holdRowTime with no expiry at all renders nothing', () => {
  assert.deepEqual(holdRowTime(null, new Date()), { until: '', tail: '', urgent: false });
});

// ── plate normalization and validation ───────────────────────

test('normalizePlate uppercases and drops everything but letters and digits', () => {
  assert.equal(normalizePlate('abc 1234'), 'ABC1234');
  assert.equal(normalizePlate('abc-1234'), 'ABC1234');
  assert.equal(normalizePlate('  ab c1 2 3 4 '), 'ABC1234');
  assert.equal(normalizePlate(null), '');
});

test('under 2 alphanumerics is the spec §5.2 field error', () => {
  for (const bad of ['', '   ', '-', 'A', 'A-']) {
    assert.equal(plateFieldError(bad), 'Enter the plate, like ABC1234.', JSON.stringify(bad));
  }
});

test('2 alphanumerics or more passes', () => {
  for (const ok of ['AB', 'A1', 'abc 1234', 'ABC-1234']) {
    assert.equal(plateFieldError(ok), null, ok);
  }
});

test('plateNote says what was actually checked, and only when it differs', () => {
  assert.equal(plateNote('abc 1234'), 'Checked as ABC1234');
  assert.equal(plateNote('ABC-1234'), 'Checked as ABC1234');
  assert.equal(plateNote('ABC1234'), null);
  assert.equal(plateNote('  ABC1234  '), null, 'surrounding whitespace is not a change worth naming');
  assert.equal(plateNote(''), null);
});

// ── extendChips: the ExtendSheet's chips (§4.3 + §8.3) ───────
//
// The per-transition window is "new `expires_at` > old **and** ≤ `now()+7d`",
// enforced in the service under the row lock with 422 `hold_window` (§4.3,
// §8.3). A chip is a promise the button then prints verbatim, so a chip that
// the server would refuse must not exist. Two rules, both asserted here:
//
//   * every chip is clamped to `now + max_days`, and
//   * a chip whose clamped instant is not strictly past the current expiry is
//     dropped entirely.
//
// Every chip also carries an absolute `expiresAt` and `durationHours: null`:
// the extend payload is the instant the label printed, never a relative
// duration whose anchor the API contract does not pin down.

test('extendChips measures from the hold’s expiry, not from now', () => {
  const now = new Date('2026-10-07T13:00:00Z');
  const request = { expires_at: '2026-10-08T01:14:00Z' };   // 12 h out
  const chips = extendChips(request, now, null);
  const h24 = chips.find(c => c.id === 'h24');
  // §5.2's own example: a hold ending 9:14 PM extends to 9:14 PM the next day.
  assert.equal(extendLabel(h24.expiresAt), 'Extend to Thu Oct 8, 9:14 PM ET');
});

test('every extendChips chip is clamped to now + max_days — never past it', () => {
  const now = new Date('2026-10-07T13:00:00Z');
  const ceiling = now.getTime() + 7 * 24 * 3600000;
  // A hold with 6 days left: "24 hours" fits, "3 days" and "7 days" do not.
  const request = { expires_at: '2026-10-13T13:00:00Z' };
  const chips = extendChips(request, now, null);
  assert.ok(chips.length > 0);
  for (const c of chips) {
    assert.ok(c.expiresAt.getTime() <= ceiling, `${c.label} is past now + 7 d`);
  }
  // The longest chip lands exactly on the ceiling rather than disappearing.
  assert.equal(chips[chips.length - 1].expiresAt.getTime(), ceiling);
});

test('extendChips drops any chip that is not strictly past the current expiry', () => {
  const now = new Date('2026-10-07T13:00:00Z');
  const request = { expires_at: '2026-10-14T13:00:00Z' };   // already at now + 7 d
  assert.deepEqual(extendChips(request, now, null), []);
});

test('extendChips never repeats an instant', () => {
  const now = new Date('2026-10-07T13:00:00Z');
  const request = { expires_at: '2026-10-13T20:00:00Z' };
  const chips = extendChips(request, now, null);
  const stamps = chips.map(c => c.expiresAt.getTime());
  assert.equal(new Set(stamps).size, stamps.length);
});

test('extendChips always sends an absolute time, never a duration', () => {
  const now = new Date('2026-10-07T13:00:00Z');
  const chips = extendChips({ expires_at: '2026-10-08T01:14:00Z' }, now, null);
  for (const c of chips) {
    assert.equal(c.durationHours, null, c.label);
    assert.ok(c.expiresAt instanceof Date, c.label);
  }
});

test('extendChips honours a tightened max_days', () => {
  const now = new Date('2026-10-07T13:00:00Z');
  const ceiling = now.getTime() + 2 * 24 * 3600000;
  const chips = extendChips({ expires_at: '2026-10-08T13:00:00Z' }, now, { max_days: 2 });
  for (const c of chips) assert.ok(c.expiresAt.getTime() <= ceiling, c.label);
  assert.equal(chips[chips.length - 1].expiresAt.getTime(), ceiling);
});

test('extendChips with no expiry at all still offers the chips from now', () => {
  const now = new Date('2026-10-07T13:00:00Z');
  const chips = extendChips({}, now, null);
  assert.ok(chips.length >= 2);
  for (const c of chips) assert.ok(c.expiresAt.getTime() > now.getTime(), c.label);
});
