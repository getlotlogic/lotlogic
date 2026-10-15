// ── State of the lot, pure half (task F7) ────────────────────
//
// What the Lot status tab and the Lookup timeline decide without a DOM: the
// time phrases a driver reads at the curb, the six count tiles, the plate
// filter, the CSV, and the empty-state copy. The payloads come from
// `GET /apartment/passes/lot-status` and `/timeline` (spec
// 2026-10-15-lot-status §2); neither carries a name, unit, phone or document,
// and nothing here adds one. `scripts/lotStatus.test.mjs` covers it.
//
// Every clock is America/New_York with "ET" spelled out where a date is shown,
// whatever zone the phone is in (same rule as holdTime.js).

import { fmtET, fmtETClock, fmtETShort, normalizePlate } from './holdTime.js';

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const ET_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});

/** Spec §4 empty states and the timeline's, verbatim. */
export const EMPTY_COPY = Object.freeze({
  towable: 'Nothing to tow right now.',
  do_not_tow: 'No holds or pending requests.',
  expiring_soon: 'Nothing ending in the next 4 hours.',
  timeline: 'No history for this plate here.',
});

/** The segmented control, in order. Towable is the default. */
export const LIST_SEGMENTS = Object.freeze([
  { id: 'towable', label: 'Towable' },
  { id: 'do_not_tow', label: 'Do not tow' },
  { id: 'expiring_soon', label: 'Ending soon' },
]);

function ms(when) {
  const t = typeof when === 'number' ? when : new Date(when).getTime();
  return Number.isFinite(t) && when !== null && when !== undefined && when !== '' ? t : null;
}

function etDay(t) {
  return ET_DAY.format(new Date(t));
}

/** "expired 3h ago" under a day, "expired 2d ago" from a day on. */
export function formatExpired(hours) {
  const h = typeof hours === 'number' ? hours : NaN;
  if (!Number.isFinite(h) || h < 0) return 'expired';
  if (h < 1) return 'expired under 1h ago';
  if (h < 24) return `expired ${Math.floor(h)}h ago`;
  return `expired ${Math.floor(h / 24)}d ago`;
}

/** "ends 11:40 PM" (ET); another ET day adds the weekday so 12:10 AM is not read as tonight. */
export function formatEnds(iso, now = Date.now()) {
  const t = ms(iso);
  if (t === null) return '';
  const base = ms(now);
  const sameDay = base !== null && etDay(t) === etDay(base);
  return `ends ${sameDay ? fmtETClock(t) : fmtETShort(t)}`;
}

/** "until 11:40 PM" for a hold or short-term pass, "no end date" when open-ended. */
export function formatUntil(iso, now = Date.now()) {
  const t = ms(iso);
  if (t === null) return 'no end date';
  const base = ms(now);
  const sameDay = base !== null && etDay(t) === etDay(base);
  return `until ${sameDay ? fmtETClock(t) : fmtETShort(t)}`;
}

/** "10m ago" / "1h ago" / "2d ago" / "just now". */
export function agoPhrase(iso, now = Date.now()) {
  const t = ms(iso);
  const base = ms(now);
  if (t === null || base === null) return '';
  const d = Math.max(0, base - t);
  if (d < MINUTE) return 'just now';
  if (d < HOUR) return `${Math.floor(d / MINUTE)}m ago`;
  if (d < DAY) return `${Math.floor(d / HOUR)}h ago`;
  return `${Math.floor(d / DAY)}d ago`;
}

const verdictText = (v) => String(v ?? '').replace(/_/g, ' ').trim();

/** "last check 1h ago: tow", so a second truck does not re-check what the first one did. */
export function lastCheckLine(check, now = Date.now()) {
  if (!check || !check.at) return 'no plate check yet';
  const when = agoPhrase(check.at, now);
  const verdict = verdictText(check.verdict);
  return `last check ${when}${verdict ? `: ${verdict}` : ''}`;
}

/** "As of 2:15 PM ET". */
export function asOfLine(iso) {
  const t = ms(iso);
  return t === null ? '' : `As of ${fmtETClock(t)} ET`;
}

/** The six count tiles, in the spec's order. A missing count reads 0. */
export function tiles(counts) {
  const c = counts && typeof counts === 'object' ? counts : {};
  const n = (k) => (Number.isFinite(c[k]) ? c[k] : 0);
  return [
    { key: 'registered', label: 'Registered', value: n('registered_long_term') },
    { key: 'short_term', label: 'Short-term', value: n('short_term_active') },
    { key: 'pending', label: 'Pending', value: n('pending_protected') },
    { key: 'holds', label: 'Holds', value: n('holds_active') },
    { key: 'open', label: 'Open', value: n('open_requests') },
    { key: 'towable', label: 'Towable', value: n('towable') },
  ];
}

/**
 * How many each list really holds. The server caps `towable` and `do_not_tow`
 * at 50; the counts say how many that hides. Do not tow is the four reasons
 * the counts name (long-term, short-term, pending, hold).
 */
export function listTotals(data) {
  const c = data?.counts && typeof data.counts === 'object' ? data.counts : {};
  const len = (k) => (Array.isArray(data?.[k]) ? data[k].length : 0);
  const num = (k) => (Number.isFinite(c[k]) ? c[k] : 0);
  const dnt = num('registered_long_term') + num('short_term_active') + num('pending_protected') + num('holds_active');
  return {
    towable: Math.max(len('towable'), num('towable')),
    do_not_tow: Math.max(len('do_not_tow'), dnt),
    expiring_soon: Math.max(len('expiring_soon'), num('expiring_4h')),
  };
}

/** Case- and punctuation-insensitive "contains" on the plate; an empty query keeps everything. */
export function filterByPlate(rows, q) {
  const list = Array.isArray(rows) ? rows : [];
  const needle = normalizePlate(q);
  if (!needle) return list;
  return list.filter(r => normalizePlate(r?.plate).includes(needle));
}

export const passKindLabel = (kind) => (kind === 'long_term' ? 'Long-term' : 'Short-term');

/** Why a plate is protected, as a tag. */
export function reasonTag(reason) {
  switch (reason) {
    case 'hold': return { label: 'Hold', tone: 'amber' };
    case 'pending': return { label: 'Under review', tone: 'info' };
    case 'long_term': return { label: 'Long-term parking pass', tone: 'green' };
    default: return { label: 'Short-term parking pass', tone: 'green' };
  }
}

// ── CSV ──────────────────────────────────────────────────────

const CSV_HEADER = ['Plate', 'Car', 'Pass', 'Expired at (ET)', 'Hours expired', 'Last check'];

/** Header plus one row per towable plate. Plate, car, pass, expired at, hours expired, last check. */
export function csvRows(towable) {
  const rows = (Array.isArray(towable) ? towable : []).map(r => {
    const check = r?.last_check;
    const verdict = check ? verdictText(check.verdict) : '';
    return [
      String(r?.plate ?? ''),
      String(r?.vehicle ?? ''),
      passKindLabel(r?.kind),
      r?.expired_at ? fmtET(r.expired_at) : '',
      Number.isFinite(r?.hours_expired) ? String(r.hours_expired) : '',
      check && check.at ? `${verdict ? `${verdict} at ` : ''}${fmtET(check.at)}` : '',
    ];
  });
  return [CSV_HEADER, ...rows];
}

/** RFC 4180 text. A cell a spreadsheet would run as a formula gets a leading apostrophe. */
export function csvText(rows) {
  const cell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return (Array.isArray(rows) ? rows : []).map(r => r.map(cell).join(',') + '\r\n').join('');
}

/** `<slug>-towable-<ET date>.csv`. */
export function csvFilename(propertyName, now = Date.now()) {
  const slug = String(propertyName ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'lot';
  const t = ms(now);
  return `${slug}-towable-${etDay(t === null ? Date.now() : t)}.csv`;
}

// ── Timeline ─────────────────────────────────────────────────

const TIMELINE_KINDS = {
  pass_filed: { label: 'Pass filed', tone: 'info' },
  pass_approved: { label: 'Pass approved', tone: 'green' },
  pass_rejected: { label: 'Pass denied', tone: 'red' },
  pass_expired: { label: 'Pass expired', tone: 'amber' },
  pass_cancelled: { label: 'Pass cancelled', tone: 'neutral' },
  pass_exited: { label: 'Left the lot', tone: 'neutral' },
  check: { label: 'Plate check', tone: 'neutral' },
  hold_opened: { label: 'Hold placed', tone: 'amber' },
  hold_ended: { label: 'Hold ended', tone: 'neutral' },
  request_opened: { label: 'Request opened', tone: 'info' },
  request_resolved: { label: 'Request resolved', tone: 'neutral' },
  towed: { label: 'Towed', tone: 'red' },
};

export function timelineKindLabel(kind) {
  return TIMELINE_KINDS[kind] || { label: 'Update', tone: 'neutral' };
}

// ── Where the tab sits, and where a row goes ─────────────────

export const LOT_STATUS_CHIP = Object.freeze({ id: 'lotstatus', label: 'Lot status' });

/**
 * The property page's chip row with the Lot status chip placed: first for a
 * partner session (the driver at the curb), right after the Parking Passes
 * chip for an owner or office session. Apartments only; the caller passes the
 * apartment chip list.
 */
export function withLotStatusChip(chips, { isPartner = false } = {}) {
  const list = (Array.isArray(chips) ? chips : []).filter(c => c.id !== LOT_STATUS_CHIP.id);
  if (isPartner) return [LOT_STATUS_CHIP, ...list];
  const at = list.findIndex(c => c.id === 'log');
  if (at < 0) return [...list, LOT_STATUS_CHIP];
  return [...list.slice(0, at + 1), LOT_STATUS_CHIP, ...list.slice(at + 1)];
}

/**
 * What a row tap opens. A hold goes to the Requests section (the request
 * detail lives there); everything else to the Parking Passes queue searched
 * for that plate, on the segment its reason belongs to (pending stays under
 * "Needs review", the rest under "Approved"). The pass detail is where the
 * office sees the unit and documents.
 */
export function rowTarget(row, list) {
  if (list === 'do_not_tow' && row?.reason === 'hold') return { section: 'requests' };
  const status = list === 'do_not_tow' && row?.reason === 'pending' ? 'pending' : 'approved';
  return { section: 'log', status, q: String(row?.plate ?? '') };
}
