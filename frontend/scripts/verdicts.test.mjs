// Tests for src/lib/verdicts.js (Task 20, spec §5.5). Each case maps
// straight to a row of the verdict table so a future edit to one verdict
// can't silently shift another's signal word or tone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { verdictPresentation, resolveAllScopeResult, scopeOptions, scopeCountLine } from '../src/lib/verdicts.js';

const BANNED = /\b(resident|visitor|permanent|temporary|guest|driver)s?\b/i;

test('hold -> DO NOT TOW, green, ✋, with ref/property/expiry/note/placed-by', () => {
  const p = verdictPresentation('hold', {
    ref: 'H-1842', property_name: 'Spring Lake Apartments', expires_local: 'Fri Oct 10, 6:00 PM ET',
    note: 'mom visiting', placed_at: '2026-10-07T20:12:00Z',
  }, 'property');
  assert.equal(p.signal, 'DO NOT TOW');
  assert.equal(p.glyph, '✋');
  assert.equal(p.tone, 'go');
  assert.match(p.reason, /H-1842/);
  assert.match(p.reason, /Spring Lake Apartments/);
  assert.match(p.reason, /Fri Oct 10, 6:00 PM ET/);
  assert.match(p.reason, /mom visiting/);
  assert.match(p.reason, /placed by the office/);
});

test('resident and guest both read DO NOT TOW, green, ✓', () => {
  for (const verdict of ['resident', 'guest']) {
    const p = verdictPresentation(verdict, { property_name: 'Spring Lake Apartments', hours_left: 14 }, 'property');
    assert.equal(p.signal, 'DO NOT TOW');
    assert.equal(p.glyph, '✓');
    assert.equal(p.tone, 'go');
    assert.match(p.reason, /Spring Lake Apartments/);
  }
});

test('guest with hours_left appends "<n>h left"', () => {
  const p = verdictPresentation('guest', { property_name: 'Spring Lake Apartments', hours_left: 14 }, 'property');
  assert.match(p.reason, /14h left/);
});

// ── pending: a long-term parking pass request the office has not reviewed ──
// Protected from tow while the office reviews it (the backend's 72-hour
// window). `protected_until_local` arrives already rendered in ET, so the
// presentation never does its own timezone or window arithmetic.

const hoursFromNow = (h) => new Date(Date.now() + h * 3600000).toISOString();

test('pending -> DO NOT TOW, green, ⏳, with the property, hours since submitted and the protected-until time', () => {
  const p = verdictPresentation('pending', {
    unit: '12B', name: 'Dana Ortiz', plate: 'ABC1234',
    submitted_at: hoursFromNow(-5), protected_until: hoursFromNow(67),
    protected_until_local: 'Sat Oct 17, 2:15 PM ET', property_name: 'Fort Mill Townhomes I',
  }, 'property');
  assert.equal(p.signal, 'DO NOT TOW');
  assert.equal(p.glyph, '⏳');
  assert.equal(p.tone, 'go');
  assert.match(p.reason, /pending approval/);
  assert.match(p.reason, /Fort Mill Townhomes I/);
  assert.match(p.reason, /submitted 5h ago/);
  assert.match(p.reason, /protected until Sat Oct 17, 2:15 PM ET/);
});

test('pending reason is the spec copy exactly, with no holder name or unit on the curb card', () => {
  const p = verdictPresentation('pending', {
    unit: '12B', name: 'Dana Ortiz', plate: 'ABC1234',
    submitted_at: hoursFromNow(-5), protected_until_local: 'Sat Oct 17, 2:15 PM ET',
    property_name: 'Fort Mill Townhomes I',
  }, 'property');
  assert.equal(
    p.reason,
    'Registration pending approval · Fort Mill Townhomes I · submitted 5h ago · protected until Sat Oct 17, 2:15 PM ET',
  );
});

test('pending leaves the protected-until clause out when the backend sent no local time', () => {
  const p = verdictPresentation('pending', { submitted_at: hoursFromNow(-3), property_name: 'Fort Mill Townhomes I' }, 'property');
  assert.equal(p.signal, 'DO NOT TOW');
  assert.match(p.reason, /pending approval/);
  assert.match(p.reason, /submitted 3h ago/);
  assert.doesNotMatch(p.reason, /protected until/);
});

test('pending with no readable submitted_at drops the age clause instead of printing NaN', () => {
  for (const bad of [undefined, null, '', 'not-a-date']) {
    const p = verdictPresentation('pending', {
      submitted_at: bad, property_name: 'Fort Mill Townhomes I', protected_until_local: 'Sat Oct 17, 2:15 PM ET',
    }, 'property');
    assert.equal(p.signal, 'DO NOT TOW', String(bad));
    assert.doesNotMatch(p.reason, /submitted|NaN|undefined|null/, String(bad));
    assert.match(p.reason, /protected until Sat Oct 17, 2:15 PM ET/, String(bad));
  }
});

test('a pending request submitted moments ago still shows its age (0h is not "missing")', () => {
  const p = verdictPresentation('pending', { submitted_at: new Date().toISOString(), property_name: 'X' }, 'property');
  assert.match(p.reason, /submitted \d+h ago/);
});

test('pending without a property_name falls back to "the property" like every other verdict', () => {
  const p = verdictPresentation('pending', { submitted_at: hoursFromNow(-1) }, 'property');
  assert.match(p.reason, /the property/);
});

test('pending with no detail at all is still DO NOT TOW — the verdict is authoritative, the detail is decoration', () => {
  for (const detail of [undefined, null, {}]) {
    const p = verdictPresentation('pending', detail, 'property');
    assert.equal(p.signal, 'DO NOT TOW');
    assert.equal(p.tone, 'go');
    assert.match(p.reason, /pending approval/);
    assert.doesNotMatch(p.reason, /undefined|null|NaN/);
  }
});

test('expired_guest -> ELIGIBLE TO TOW, amber (never green), !', () => {
  const p = verdictPresentation('expired_guest', { property_name: 'Spring Lake Apartments', hours_ago: 3 }, 'property');
  assert.equal(p.signal, 'ELIGIBLE TO TOW');
  assert.equal(p.glyph, '!');
  assert.equal(p.tone, 'amber');
  assert.match(p.reason, /expired 3h ago/);
});

test('tow_requested -> TOW REQUESTED, stop tone, 🚨', () => {
  const p = verdictPresentation('tow_requested', {
    property_name: 'Spring Lake Apartments', placed_at: '2026-10-05T13:30:00Z', note: 'blocking fire lane', ref: 'T-0231',
  }, 'property');
  assert.equal(p.signal, 'TOW REQUESTED');
  assert.equal(p.glyph, '🚨');
  assert.equal(p.tone, 'stop');
  assert.match(p.reason, /T-0231/);
  assert.match(p.reason, /blocking fire lane/);
});

test('not_registered -> ELIGIBLE TO TOW, stop tone, ✗, scoped to the property by name', () => {
  const p = verdictPresentation('not_registered', { property_name: 'Spring Lake Apartments' }, 'property');
  assert.equal(p.signal, 'ELIGIBLE TO TOW');
  assert.equal(p.glyph, '✗');
  assert.equal(p.tone, 'stop');
  assert.match(p.reason, /Spring Lake Apartments/);
});

test('not_registered under scope=all reads "any N Style property", not one property\'s name', () => {
  const p = verdictPresentation('not_registered', {}, 'all');
  assert.match(p.reason, /any N Style property/);
});

test('hold_unconfirmed is amber, never green, and says not yet confirmed', () => {
  const p = verdictPresentation('hold_unconfirmed', {
    ref: 'H-1842', property_name: 'Sunset Ridge Apartments', signed_up_by: 'Dana Ortiz',
    signup_phone: '(704) 555-0123', expires_local: 'Fri Oct 10, 6:00 PM ET',
  }, 'all');
  assert.equal(p.signal, 'HOLD — PROPERTY NOT CONFIRMED');
  assert.equal(p.tone, 'amber');
  assert.notEqual(p.tone, 'go');
  assert.match(p.reason, /not yet confirmed by N Style/);
  assert.match(p.reason, /Dana Ortiz/);
  assert.match(p.reason, /\(704\) 555-0123/);
});

test('on_file_elsewhere names the other property, amber, never "eligible to tow"', () => {
  const p = verdictPresentation('on_file_elsewhere', { property_id: 'p1', property_name: 'Spring Lake Apartments' }, 'all');
  assert.equal(p.tone, 'amber');
  assert.match(p.signal, /SPRING LAKE APARTMENTS/);
  assert.match(p.reason, /Spring Lake Apartments, not this lot/);
  assert.doesNotMatch(p.reason.toLowerCase(), /eligible to tow/);
  assert.equal(p.propertyId, 'p1');
});

test('grouped returns lines[], one per match, and no single signal word', () => {
  const p = verdictPresentation('grouped', {
    matches: [
      { property_name: 'Spring Lake', verdict: 'tow_requested', detail: { ref: 'T-0231' } },
      { property_name: 'Stevensons', verdict: 'resident', detail: {} },
    ],
  }, 'all');
  assert.equal(p.signal, null);
  assert.equal(p.lines.length, 2);
  assert.match(p.lines[0], /At Spring Lake: TOW REQUESTED T-0231/);
  assert.match(p.lines[1], /At Stevensons: parking pass/);
});

test('grouped: a pending match reads "pending approval" — plain English, no signal word', () => {
  const p = verdictPresentation('grouped', {
    matches: [
      { property_name: 'Fort Mill Townhomes I', verdict: 'pending', detail: { submitted_at: hoursFromNow(-2) } },
      { property_name: 'Spring Lake', verdict: 'tow_requested', detail: { ref: 'T-0231' } },
    ],
  }, 'all');
  assert.equal(p.signal, null);
  assert.equal(p.lines.length, 2);
  assert.equal(p.lines[0], 'At Fort Mill Townhomes I: pending approval');
  assert.match(p.lines[1], /At Spring Lake: TOW REQUESTED T-0231/);
});

test('unknown verdict -> the fallback line, amber, never "eligible to tow"', () => {
  for (const bogus of [undefined, null, '', 'something_new', 'towed_already']) {
    const p = verdictPresentation(bogus, {}, 'property');
    assert.equal(p.signal, "Can't read this answer — check in LotLogic");
    assert.equal(p.tone, 'amber');
    assert.doesNotMatch(p.signal.toLowerCase(), /eligible to tow/);
  }
});

test('no banned naming-rule word appears in any signal or reason string', () => {
  const cases = [
    ['hold', { ref: 'H-1', property_name: 'X', note: 'n', placed_at: '2026-01-01T00:00:00Z', expires_local: 'y' }],
    ['resident', { property_name: 'X' }],
    ['guest', { property_name: 'X', hours_left: 1 }],
    ['pending', { property_name: 'X', submitted_at: '2026-01-01T00:00:00Z', protected_until: '2026-01-04T00:00:00Z', protected_until_local: 'y' }],
    ['expired_guest', { property_name: 'X', hours_ago: 1 }],
    ['tow_requested', { property_name: 'X', ref: 'T-1', note: 'n' }],
    ['not_registered', { property_name: 'X' }],
    ['hold_unconfirmed', { ref: 'H-1', property_name: 'X', signed_up_by: 'Y', signup_phone: 'Z', expires_local: 'y' }],
    ['grouped', { matches: [{ property_name: 'X', verdict: 'pending', detail: {} }, { property_name: 'Y', verdict: 'guest', detail: {} }] }],
    ['on_file_elsewhere', { property_name: 'X' }],
    ['grouped', { matches: [{ property_name: 'X', verdict: 'guest', detail: {} }] }],
    ['bogus', {}],
  ];
  for (const [verdict, detail] of cases) {
    const p = verdictPresentation(verdict, detail, 'property');
    const strings = [p.signal, p.reason, ...(p.lines || [])].filter(Boolean);
    for (const s of strings) assert.doesNotMatch(s, BANNED, `${verdict} -> "${s}"`);
  }
});

// ── resolveAllScopeResult (on_file_elsewhere computed client-side) ──────

test('resolveAllScopeResult: no matches -> not_registered', () => {
  const r = resolveAllScopeResult({ verdict: 'not_registered', matches: [] }, 'p1');
  assert.equal(r.verdict, 'not_registered');
});

test('resolveAllScopeResult: single match at the remembered property -> passed through unchanged', () => {
  const r = resolveAllScopeResult({
    verdict: 'hold',
    matches: [{ property_id: 'p1', property_name: 'Spring Lake', verdict: 'hold', detail: { ref: 'H-1' } }],
  }, 'p1');
  assert.equal(r.verdict, 'hold');
  assert.equal(r.detail.ref, 'H-1');
});

test('resolveAllScopeResult: single match at a DIFFERENT property than remembered -> on_file_elsewhere', () => {
  const r = resolveAllScopeResult({
    verdict: 'hold',
    matches: [{ property_id: 'p2', property_name: 'Spring Lake', verdict: 'hold', detail: { ref: 'H-1' } }],
  }, 'p1');
  assert.equal(r.verdict, 'on_file_elsewhere');
  assert.equal(r.detail.property_name, 'Spring Lake');
});

test('resolveAllScopeResult: a pending match at a DIFFERENT property is on_file_elsewhere (amber), never a green DO NOT TOW for this lot', () => {
  const r = resolveAllScopeResult({
    verdict: 'pending',
    matches: [{ property_id: 'p2', property_name: 'Fort Mill Townhomes II', verdict: 'pending', detail: { unit: '12B' } }],
  }, 'p1');
  assert.equal(r.verdict, 'on_file_elsewhere');
  assert.equal(r.detail.property_name, 'Fort Mill Townhomes II');
  assert.equal(verdictPresentation(r.verdict, r.detail, 'all').tone, 'amber');
});

test('resolveAllScopeResult: no remembered property -> no on_file_elsewhere override, backend result stands', () => {
  const r = resolveAllScopeResult({
    verdict: 'hold',
    matches: [{ property_id: 'p2', property_name: 'Spring Lake', verdict: 'hold', detail: { ref: 'H-1' } }],
  }, null);
  assert.equal(r.verdict, 'hold');
});

test('resolveAllScopeResult: grouped with the remembered property among the matches stays grouped', () => {
  const r = resolveAllScopeResult({
    verdict: 'grouped',
    matches: [
      { property_id: 'p1', property_name: 'Spring Lake', verdict: 'tow_requested', detail: {} },
      { property_id: 'p2', property_name: 'Stevensons', verdict: 'resident', detail: {} },
    ],
  }, 'p1');
  assert.equal(r.verdict, 'grouped');
  assert.equal(r.detail.matches.length, 2);
});

test('resolveAllScopeResult: grouped stays grouped even when the remembered property has no match', () => {
  const r = resolveAllScopeResult({
    verdict: 'grouped',
    matches: [
      { property_id: 'p2', property_name: 'Spring Lake', verdict: 'tow_requested', detail: {} },
      { property_id: 'p3', property_name: 'Stevensons', verdict: 'resident', detail: {} },
    ],
  }, 'p1');
  assert.equal(r.verdict, 'grouped');
  assert.equal(r.detail.matches.length, 2);
});

// ── scopeOptions ──────────────────────────────────────────────────────

test('scopeOptions omits "All" when partnerLookupAvailable is false', () => {
  const opts = scopeOptions({ properties: [{ id: 'p1', name: 'Spring Lake' }], partnerLookupAvailable: false, companyName: 'N Style' });
  assert.equal(opts.length, 1);
  assert.ok(!opts.some(o => o.value === 'all'));
});

test('scopeOptions includes "All" labelled from companyName when available', () => {
  const opts = scopeOptions({ properties: [{ id: 'p1', name: 'Spring Lake' }], partnerLookupAvailable: true, companyName: 'N Style' });
  const all = opts.find(o => o.value === 'all');
  assert.ok(all);
  assert.equal(all.label, 'All N Style properties');
});

test('scopeOptions falls back to "All properties" with no companyName', () => {
  const opts = scopeOptions({ properties: [], partnerLookupAvailable: true, companyName: '' });
  const all = opts.find(o => o.value === 'all');
  assert.equal(all.label, 'All properties');
});

// ── "Checked at your {n} properties" (tow-company team spec §2.2, §4) ──
//
// The verdict JSON carries `scope: {property_count: n}` only for a Truck; the
// line is absent for everyone else.

test('scopeCountLine: the spec line for a Truck', () => {
  assert.equal(scopeCountLine({ property_count: 3 }), 'Checked at your 3 properties');
  assert.equal(scopeCountLine({ property_count: 11 }), 'Checked at your 11 properties');
});

test('scopeCountLine: one property reads as one', () => {
  assert.equal(scopeCountLine({ property_count: 1 }), 'Checked at your 1 property');
});

test('scopeCountLine: no line without a count', () => {
  for (const bad of [undefined, null, {}, { property_count: null }, { property_count: '3' }, { property_count: 2.5 }, { property_count: -1 }]) {
    assert.equal(scopeCountLine(bad), null, JSON.stringify(bad));
  }
});
