// ── Hold presets, ET labels, plate rules ─────────────────────
//
// The pure half of the Requests composer (spec §4.3 and §5.2). Everything
// here is a function of an instant and the partner's `hold_rules`, so it is
// all covered by `scripts/holdTime.test.mjs` without a DOM.
//
// Two rules shape the whole module:
//
//  1. **No client-side timezone math ever decides a verdict.** These labels
//     are *display only*. The client sends `duration_hours` (or an absolute
//     `expires_at` for Overnight and the picker) and the server computes the
//     real `expires_at` in UTC and returns `expires_local`; the row swaps the
//     server's string in the moment it arrives. What is computed here is what
//     the button has to promise before the request exists.
//  2. **Every label is `America/New_York` with "ET" spelled out**, whatever
//     zone the phone is in. A manager in Charlotte and a tow dispatcher on a
//     laptop set to UTC must read the same sentence.
//
// The one place the browser's own zone is correct is the `datetime-local`
// picker: that input is in local time by definition, so `pickerMin` /
// `pickerMax` are local strings and the button label still renders the ET
// equivalent of whatever was picked.

const ZONE = 'America/New_York';
const HOUR_MS = 3600000;

/** Spec §4.3's `enforcement_partners.hold_rules` defaults. */
export const DEFAULT_HOLD_RULES = Object.freeze({
  default_hours: 24,
  max_days: 7,
  overnight_hour: 6,
  pending_hold_cap: 3,
});

// The DB CHECK ceilings. `hold_rules` may only *tighten* these (§4.3), so a
// loosened value is clamped rather than trusted.
const MAX_DAYS_CEILING = 7;
const MAX_HOURS_CEILING = MAX_DAYS_CEILING * 24; // 168, the API's upper bound

function intIn(value, lo, hi, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  return i < lo || i > hi ? fallback : i;
}

/** `hold_rules` with every field validated and clamped to the DB ceilings. */
export function resolveHoldRules(rules) {
  const r = rules && typeof rules === 'object' ? rules : {};
  return {
    default_hours: intIn(r.default_hours, 1, MAX_HOURS_CEILING, DEFAULT_HOLD_RULES.default_hours),
    max_days: Math.min(
      MAX_DAYS_CEILING,
      intIn(r.max_days, 1, MAX_DAYS_CEILING, DEFAULT_HOLD_RULES.max_days),
    ),
    overnight_hour: intIn(r.overnight_hour, 0, 23, DEFAULT_HOLD_RULES.overnight_hour),
    pending_hold_cap: intIn(r.pending_hold_cap, 1, 99, DEFAULT_HOLD_RULES.pending_hold_cap),
  };
}

/** A `Date` from a Date / ISO string / epoch ms, or null when unusable. */
function toDate(when) {
  if (when instanceof Date) return Number.isNaN(when.getTime()) ? null : when;
  if (typeof when === 'number' && Number.isFinite(when)) return new Date(when);
  if (typeof when === 'string' && when.trim()) {
    const d = new Date(when);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

// ── ET formatting ────────────────────────────────────────────

const ET_LABEL = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE,
  weekday: 'short', month: 'short', day: 'numeric',
  hour: 'numeric', minute: '2-digit',
});

const ET_FIELDS = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23',
});

function partsOf(formatter, d) {
  const out = {};
  for (const p of formatter.formatToParts(d)) if (p.type !== 'literal') out[p.type] = p.value;
  return out;
}

/** The ET wall-clock fields of an instant, as numbers. */
function etFields(d) {
  const p = partsOf(ET_FIELDS, d);
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    hour: Number(p.hour), minute: Number(p.minute), second: Number(p.second),
  };
}

/**
 * The instant at which ET's wall clock reads the given fields.
 *
 * `Date.UTC(…)` of an ET wall time is wrong by the zone offset, and the offset
 * itself depends on the instant — so guess, measure the offset at the guess,
 * correct, and measure once more. Two passes converge for every case except
 * the hour that does not exist on a spring-forward morning, where the second
 * pass lands on the following real instant. That is the right answer for a
 * "next 6 AM" question.
 */
function etWallToUtc(year, month, day, hour, minute) {
  const target = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = target;
  for (let pass = 0; pass < 2; pass++) {
    const f = etFields(new Date(guess));
    const asIfUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
    guess = target - (asIfUtc - guess);
  }
  return new Date(guess);
}

/** The same ET calendar date, `n` days later. */
function addDays({ year, month, day }, n) {
  const t = new Date(Date.UTC(year, month - 1, day + n));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

/** `"Wed Oct 8, 9:14 PM ET"` — the canonical portal timestamp. */
export function fmtET(when) {
  const d = toDate(when);
  if (!d) return '';
  const p = partsOf(ET_LABEL, d);
  return `${p.weekday} ${p.month} ${p.day}, ${p.hour}:${p.minute} ${p.dayPeriod} ET`;
}

/** `"Tue 9:12 PM"` — weekday plus clock, for a "who and when" byline. */
export function fmtETShort(when) {
  const d = toDate(when);
  if (!d) return '';
  const p = partsOf(ET_LABEL, d);
  return `${p.weekday} ${p.hour}:${p.minute} ${p.dayPeriod}`;
}

/** `"9:40 PM"` — the clock alone, for an event already dated by its group. */
export function fmtETClock(when) {
  const d = toDate(when);
  if (!d) return '';
  const p = partsOf(ET_LABEL, d);
  return `${p.hour}:${p.minute} ${p.dayPeriod}`;
}

/** `"Tue Oct 7, 4:12 PM"` — a History row's stamp, dated but without "ET". */
export function fmtETStamp(when) {
  const d = toDate(when);
  if (!d) return '';
  const p = partsOf(ET_LABEL, d);
  return `${p.weekday} ${p.month} ${p.day}, ${p.hour}:${p.minute} ${p.dayPeriod}`;
}

/**
 * The hold button's promise. Spec §4.3: "the button label is the single source
 * of truth — always 'Put on hold until <Wkd Mon D>, <h:mm AM/PM> ET', date and
 * ET included, whatever the chip says."
 */
export function buttonLabel(expiresAt) {
  const label = fmtET(expiresAt);
  return label ? `Put on hold until ${label}` : 'Put on hold';
}

/** The ExtendSheet's button: "Extend to Thu Oct 9, 9:14 PM ET". */
export function extendLabel(expiresAt) {
  const label = fmtET(expiresAt);
  return label ? `Extend to ${label}` : 'Extend';
}

// ── presets ──────────────────────────────────────────────────

/** `6` → `"6 AM"`, `0` → `"12 AM"`, `13` → `"1 PM"`. */
function hourLabel(hour24) {
  const period = hour24 < 12 ? 'AM' : 'PM';
  const h = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${h} ${period}`;
}

/**
 * The next ET wall-clock `hour`:00 that is at least an hour away.
 *
 * Spec §4.3: "the next 6:00 AM America/New_York that is ≥ 1 hour away — at
 * 5:30 AM it rolls to tomorrow's 6:00 AM rather than failing the 1-hour
 * floor". The floor exists because the API's `duration_hours` starts at 1, so
 * a 30-minute hold would be rejected.
 */
function overnightAt(now, hour) {
  const floor = now.getTime() + HOUR_MS;
  const today = etFields(now);
  // Three days of headroom: today, tomorrow, and one spare for the DST hour
  // that does not exist.
  for (let i = 0; i < 3; i++) {
    const { year, month, day } = addDays(today, i);
    const candidate = etWallToUtc(year, month, day, hour, 0);
    if (candidate.getTime() >= floor) return candidate;
  }
  return new Date(floor);
}

/**
 * The "Don't tow until" chips (spec §4.3).
 *
 * @param {Date|string|number} [now]
 * @param {object} [rules] `enforcement_partners.hold_rules`
 * @returns {{id: string, label: string, expiresAt: Date, durationHours: number|null}[]}
 *
 * `durationHours` is what the client sends for a plain duration; Overnight is
 * an absolute time, so it carries `null` and the composer sends its
 * `expiresAt` instead. "Pick a time…" is not a preset — it is the picker, and
 * its bounds are `pickerMin` / `pickerMax`.
 */
export function presets(now, rules) {
  const base = toDate(now) || new Date();
  const r = resolveHoldRules(rules);
  const capHours = r.max_days * 24;

  const out = [{
    id: 'overnight',
    label: `Overnight · until ${hourLabel(r.overnight_hour)}`,
    expiresAt: overnightAt(base, r.overnight_hour),
    durationHours: null,
  }];

  const seen = new Set();
  for (const [id, hours, label] of [
    ['h24', 24, '24 hours'],
    ['d3', 72, '3 days'],
    ['d7', capHours, `${r.max_days} days`],
  ]) {
    if (hours > capHours || seen.has(hours)) continue;
    seen.add(hours);
    out.push({
      id,
      label,
      expiresAt: new Date(base.getTime() + hours * HOUR_MS),
      durationHours: hours,
    });
  }
  return out;
}

/**
 * The chip that starts selected — 24 hours (spec §5.2's wireframe). Derived
 * from `hold_rules.default_hours` so a tightened default still preselects a
 * chip that exists.
 */
export function defaultPresetId(rules) {
  const r = resolveHoldRules(rules);
  const list = presets(new Date(), r);
  const match = list.find(p => p.durationHours === r.default_hours);
  if (match) return match.id;
  // A default_hours with no chip of its own falls back to the longest chip
  // that is not Overnight, and to Overnight only if nothing else survived.
  const durations = list.filter(p => p.durationHours !== null);
  return durations.length ? durations[durations.length - 1].id : list[0].id;
}

// ── the "Pick a time…" picker ────────────────────────────────

/**
 * `"2026-10-07T13:00"` — the `datetime-local` value for an instant, in the
 * **browser's** zone, because that is the only zone that input speaks.
 */
export function toLocalInputValue(when) {
  const d = toDate(when);
  if (!d) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The earliest the picker allows — an hour out, the API's `duration_hours` floor. */
export function pickerMin(now) {
  const base = toDate(now) || new Date();
  return toLocalInputValue(new Date(base.getTime() + HOUR_MS));
}

/** The latest the picker allows — `max_days` out, never past the 7-day ceiling. */
export function pickerMax(now, rules) {
  const base = toDate(now) || new Date();
  const r = resolveHoldRules(rules);
  return toLocalInputValue(new Date(base.getTime() + r.max_days * 24 * HOUR_MS));
}

// ── the row's time line ──────────────────────────────────────

/** Whole minutes until `expiresAt`, floored at 0; null when there is no expiry. */
export function minutesLeft(expiresAt, now) {
  const end = toDate(expiresAt);
  if (!end) return null;
  const from = toDate(now) || new Date();
  return Math.max(0, Math.floor((end.getTime() - from.getTime()) / 60000));
}

/**
 * The hold row's second line (spec §5.2): `until <ET> · 22h`, and under an
 * hour the amber `until <ET> · ⚠ 48 min left — Extend?`.
 *
 * `expiresLocal` is the server's own `expires_local` string. When present it
 * wins over the client's rendering — the server resolved the real
 * `expires_at`, and the two can differ by the rounding the service applies.
 * The countdown is still computed from the instant, never parsed back out of
 * the string.
 */
export function holdRowTime(expiresAt, now, expiresLocal) {
  const label = (typeof expiresLocal === 'string' && expiresLocal.trim())
    ? expiresLocal.trim()
    : fmtET(expiresAt);
  if (!label) return { until: '', tail: '', urgent: false };
  const mins = minutesLeft(expiresAt, now);
  if (mins === null) return { until: `until ${label}`, tail: '', urgent: false };
  if (mins < 60) {
    return { until: `until ${label}`, tail: `⚠ ${mins} min left — Extend?`, urgent: true };
  }
  const hours = Math.floor(mins / 60);
  if (hours < 48) return { until: `until ${label}`, tail: `${hours}h`, urgent: false };
  return { until: `until ${label}`, tail: `${Math.floor(hours / 24)}d`, urgent: false };
}

// ── plate rules ──────────────────────────────────────────────

/** Byte-identical to the backend's normalization: upper-case alphanumerics. */
export function normalizePlate(raw) {
  return String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Spec §5.2's field error, verbatim. */
export const PLATE_ERROR = 'Enter the plate, like ABC1234.';

/**
 * The composer's submit-time plate check (§5.2): "empty or < 2 alphanumerics →
 * 'Enter the plate, like ABC1234.' under the field; a plate with spaces or
 * dashes is accepted".
 */
export function plateFieldError(raw) {
  return normalizePlate(raw).length < 2 ? PLATE_ERROR : null;
}

/**
 * "Checked as ABC1234" — shown under the input only when normalization
 * actually changed something a user typed, so a typo can never silently
 * become a different plate.
 */
export function plateNote(raw) {
  const normalized = normalizePlate(raw);
  if (!normalized) return null;
  return String(raw ?? '').trim() === normalized ? null : `Checked as ${normalized}`;
}
