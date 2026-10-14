// ── The manager's approval queue, pure half (task F4) ────────
//
// Everything the Passes tab decides without a DOM: which segment a row is in,
// how requests group by unit against the property's vehicle cap, which pending
// row would put a unit over that cap, the age chip against the 72-hour review
// window, the sentence a denial sends, what each document should prove, and
// the `?status=&q=` round trip. `scripts/permitsQueue.test.mjs` covers it.
//
// Rows come from `GET /apartment/passes/permits` (`{residents, guests}`) and
// keep every server column; `queueRows` only adds `kind` (the API path word,
// `resident` | `guest`, never shown) and a stable `key`.
//
// Two rules the whole file keeps:
//   * Copy says "parking pass" — long-term or short-term — and never names the
//     two tables' people (CLAUDE.md naming rule; portalNaming.test.mjs scans
//     this file's strings).
//   * The cap is advisory here. The backend refuses the (cap+1)th registration
//     (409 unit_vehicle_limit, task B1) but approve has no server check, so the
//     queue is the only place an over-limit approval is caught.

import { fmtET } from './holdTime.js';

/** Hours a long-term request is protected from tow while it waits (B2's `PENDING_PROTECTION_HOURS`). */
export const REVIEW_WINDOW_HOURS = 72;

const MINUTE = 60000;
const HOUR = 60 * MINUTE;

// ── Rows and segments ─────────────────────────────────────────

/** Flatten the permits payload into one list of rows with `kind` and `key`. */
export function queueRows(payload) {
  const longTerm = Array.isArray(payload?.residents) ? payload.residents : [];
  const shortTerm = Array.isArray(payload?.guests) ? payload.guests : [];
  return [
    ...longTerm.map(r => ({ ...r, kind: 'resident', key: `resident:${r.id}` })),
    ...shortTerm.map(r => ({ ...r, kind: 'guest', key: `guest:${r.id}` })),
  ];
}

export function isLongTerm(row) {
  return row?.kind === 'resident';
}

// Status → segment. A long-term pass is `approved`, a short-term one `active`;
// both read "Approved". Void, expired, cancelled, revoked and towed rows are
// not decisions waiting on anyone, so they sit in no segment.
const SEGMENT_BY_STATUS = {
  resident: { pending: 'pending', approved: 'approved', rejected: 'denied' },
  guest: { pending: 'pending', active: 'approved', rejected: 'denied' },
};

export const SEGMENTS = Object.freeze([
  { id: 'pending', label: 'Needs review' },
  { id: 'approved', label: 'Approved' },
  { id: 'denied', label: 'Denied' },
]);
const SEGMENT_IDS = SEGMENTS.map(s => s.id);

export function segmentOf(row) {
  return SEGMENT_BY_STATUS[row?.kind]?.[row?.status] || null;
}

// ── Normalisation, labels and search ──────────────────────────

/** Upper-case letters and digits only: `" #214 "` → `"214"`. */
export function normalizeUnit(text) {
  return String(text ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Same rule for plates: `"abc 1234"` → `"ABC1234"`. */
export function normalizePlate(text) {
  return normalizeUnit(text);
}

/** The unit as typed: the holder's own unit, or the unit a short-term pass visits. */
export function unitText(row) {
  return String((isLongTerm(row) ? row?.unit_number : row?.host_unit) ?? '').trim();
}

export function holderName(row) {
  return String((isLongTerm(row) ? row?.holder_name : row?.visitor_name) ?? '').trim();
}

export function plateText(row) {
  return String(row?.plate_text ?? '').trim();
}

/** `"214"` → `"Unit 214"`; a unit that already starts with a unit word stays as typed. */
export function unitLabel(typed) {
  const t = String(typed ?? '').trim();
  if (!t) return 'No unit given';
  return /^(unit|apt|apartment)\b/i.test(t) ? t : `Unit ${t}`;
}

/** Plate or unit, both normalised; a search that normalises to nothing keeps every row. */
export function matchesSearch(row, q) {
  const needle = normalizePlate(q);
  if (!needle) return true;
  return normalizePlate(row?.plate_text).includes(needle) || normalizeUnit(unitText(row)).includes(needle);
}

// ── The vehicle cap ───────────────────────────────────────────

/** `properties.max_vehicles_per_unit` (1..10, CHECK-enforced) or null for no cap. */
export function capOf(property) {
  const n = Number(property?.max_vehicles_per_unit);
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : null;
}

function createdMs(row) {
  const t = Date.parse(row?.created_at ?? '');
  return Number.isFinite(t) ? t : Infinity;
}

// Oldest first; the key breaks ties so the order never depends on payload order.
function byOldest(a, b) {
  const ta = createdMs(a);
  const tb = createdMs(b);
  if (ta !== tb) return ta < tb ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

// Long-term approved + pending rows per normalised unit. Short-term passes and
// rows without a unit never count (B1 counts the same population).
function capPopulation(rows) {
  const units = new Map();
  for (const row of rows || []) {
    if (!isLongTerm(row)) continue;
    const segment = segmentOf(row);
    if (segment !== 'approved' && segment !== 'pending') continue;
    const unit = normalizeUnit(unitText(row));
    if (!unit) continue;
    const entry = units.get(unit) || { approved: 0, pending: [] };
    if (segment === 'approved') entry.approved += 1;
    else entry.pending.push(row);
    units.set(unit, entry);
  }
  return units;
}

/** `{approved, pending}` long-term passes for one normalised unit. */
export function unitTally(rows, unitKey) {
  const entry = unitKey ? capPopulation(rows).get(unitKey) : null;
  return { approved: entry?.approved || 0, pending: entry?.pending.length || 0 };
}

/**
 * Keys of the pending requests that would put their unit over the cap. The
 * oldest requests keep the free slots; every newer one past them is over —
 * with one too many that is the newest pending row.
 */
export function overLimitKeys(rows, cap) {
  const over = new Set();
  if (cap == null) return over;
  for (const { approved, pending } of capPopulation(rows).values()) {
    const room = Math.max(0, cap - approved);
    for (const row of [...pending].sort(byOldest).slice(room)) over.add(row.key);
  }
  return over;
}

/** The unit group's count chip: `"2 of 2 vehicles · 1 approved, 1 pending"`. */
export function capChip(tally, cap) {
  const approved = tally?.approved || 0;
  const pending = tally?.pending || 0;
  const total = approved + pending;
  const parts = [approved && `${approved} approved`, pending && `${pending} pending`].filter(Boolean).join(', ');
  const tail = parts ? ` · ${parts}` : '';
  if (cap == null) return { text: `${total} ${total === 1 ? 'vehicle' : 'vehicles'}${tail}`, over: false };
  if (total > cap) return { text: `${total} vehicles, limit ${cap}${tail}`, over: true };
  return { text: `${total} of ${cap} ${cap === 1 ? 'vehicle' : 'vehicles'}${tail}`, over: false };
}

// ── Grouping and order ────────────────────────────────────────

/**
 * Needs review, grouped by normalised unit. Groups run oldest-request first,
 * and so do the rows inside each. The chip counts the unit's approved passes
 * as well as its pending ones, from every row — a search narrows what is
 * listed, never the cap math. A group holding only short-term requests has no
 * chip (they never count toward the cap).
 */
export function reviewGroups(rows, { q = '', cap = null } = {}) {
  const pending = (rows || []).filter(r => segmentOf(r) === 'pending' && matchesSearch(r, q)).sort(byOldest);
  const groups = new Map();
  for (const row of pending) {
    const key = normalizeUnit(unitText(row));
    let group = groups.get(key);
    if (!group) {
      group = { key, typed: [], rows: [] };
      groups.set(key, group);
    }
    group.rows.push(row);
    const typed = unitText(row);
    if (typed && !group.typed.includes(typed)) group.typed.push(typed);
  }
  return [...groups.values()].map(group => {
    const tally = unitTally(rows, group.key);
    return {
      key: group.key,
      label: unitLabel(group.typed[0] || ''),
      variants: group.typed.slice(1),
      rows: group.rows,
      tally,
      chip: group.key && group.rows.some(isLongTerm) ? capChip(tally, cap) : null,
    };
  });
}

function decidedMs(row) {
  for (const value of [row?.reviewed_at, row?.created_at]) {
    const t = Date.parse(value ?? '');
    if (Number.isFinite(t)) return t;
  }
  return -Infinity;
}

/** Approved or Denied: one flat list, the latest decision first. */
export function decidedRows(rows, segment, q = '') {
  return (rows || [])
    .filter(r => segmentOf(r) === segment && matchesSearch(r, q))
    .sort((a, b) => {
      const ta = decidedMs(a);
      const tb = decidedMs(b);
      if (ta !== tb) return ta > tb ? -1 : 1;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
}

/** Rows per segment after the search — what the segmented control shows. */
export function segmentCounts(rows, q = '') {
  const counts = { pending: 0, approved: 0, denied: 0 };
  for (const row of rows || []) {
    const segment = segmentOf(row);
    if (segment && matchesSearch(row, q)) counts[segment] += 1;
  }
  return counts;
}

// ── The 72-hour review window ─────────────────────────────────

function dayHours(ms) {
  const hours = Math.floor(ms / HOUR);
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest ? `${days}d ${rest}h` : `${days}d`;
}

// Minutes under an hour, hours under a day, then days and hours.
function span(ms) {
  if (ms < HOUR) return `${Math.max(1, Math.floor(ms / MINUTE))}m`;
  if (ms < 24 * HOUR) return `${Math.floor(ms / HOUR)}h`;
  return dayHours(ms);
}

/**
 * A long-term request's chip: green with more than a day of protection left,
 * amber in the last 24 hours, red once the window has passed (it still waits
 * for a person — nothing auto-declines). Text always carries the meaning.
 */
export function protectionChip(createdAt, nowMs) {
  const t = Date.parse(createdAt ?? '');
  if (!Number.isFinite(t) || !Number.isFinite(nowMs)) return null;
  const left = REVIEW_WINDOW_HOURS * HOUR - Math.max(0, nowMs - t);
  if (left > 24 * HOUR) return { tone: 'green', text: `${dayHours(left)} left` };
  if (left > 0) {
    const hours = Math.floor(left / HOUR);
    return { tone: 'amber', text: `${hours >= 1 ? `${hours}h` : span(left)} left` };
  }
  const ended = -left < MINUTE ? 'just now' : `${span(-left)} ago`;
  return { tone: 'red', text: `Protection ended ${ended} — still needs a decision` };
}

/** A short-term request is not protected while it waits (B2), so its chip is elapsed time only. */
export function waitingChip(createdAt, nowMs) {
  const t = Date.parse(createdAt ?? '');
  if (!Number.isFinite(t) || !Number.isFinite(nowMs)) return null;
  const waited = Math.max(0, nowMs - t);
  return { tone: 'neutral', text: waited < MINUTE ? 'Just now' : `Waiting ${span(waited)}` };
}

export function ageChip(row, nowMs) {
  if (segmentOf(row) !== 'pending') return null;
  return isLongTerm(row) ? protectionChip(row.created_at, nowMs) : waitingChip(row.created_at, nowMs);
}

// ── Denial reasons ────────────────────────────────────────────
//
// The sheet's radio list, in the agreed order. A choice writes ONE sentence
// into the existing free-text `reason`; the decision email interpolates it as
// "…was not approved: <reason>." (services/apartment_notify.py), so none of
// these end in a period — the email adds it.

export const DENY_REASONS = Object.freeze([
  { id: 'document_missing', label: 'A document is missing' },
  { id: 'document_unreadable', label: 'A document is unreadable or cut off' },
  { id: 'name_mismatch', label: "The name on the documents doesn't match the lease" },
  { id: 'plate_mismatch', label: "The plate in the photo doesn't match the plate entered" },
  { id: 'not_leaseholder', label: "You're not listed as a leaseholder for this unit" },
  { id: 'over_cap', label: 'This unit already has the maximum number of vehicles' },
  { id: 'other', label: 'Other (explain)' },
]);

const REASON_SENTENCES = {
  document_missing: () => 'A required document was missing from your request — please send it again with every document attached',
  document_unreadable: () => 'One of your documents was hard to read or cut off — please send your request again with a clear photo of the whole document',
  name_mismatch: () => "The name on your documents doesn't match the lease — please send your request again with documents in a leaseholder's name",
  plate_mismatch: () => "The plate in your photo doesn't match the plate number you entered — please check the number and send your request again",
  not_leaseholder: () => "You're not listed as a leaseholder for this unit, so a long-term parking pass isn't available — you can still ask for a short-term parking pass",
  over_cap: (cap) => (cap
    ? `This unit has already reached its limit of ${cap} vehicles — ask the office if one of them should be removed`
    : 'This unit has already reached its vehicle limit — ask the office if one of them should be removed'),
};

export const OTHER_MAX = 500;

/**
 * The reason text to send, or null when there is nothing valid to send yet.
 * "Other" is the manager's own words, whitespace collapsed and the trailing
 * period dropped (the email adds one); it needs two characters.
 */
export function denyReasonText(id, otherText = '', { cap = null } = {}) {
  if (id === 'other') {
    const text = String(otherText ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, OTHER_MAX)
      .replace(/[.\s]+$/, '');
    return text.length >= 2 ? text : null;
  }
  const sentence = REASON_SENTENCES[id];
  return sentence ? sentence(cap) : null;
}

/** The body line the decision email builds (`build_decision_body`), for the live preview. */
export function decisionEmailLine({ propertyName = '', reason = '' } = {}) {
  const where = propertyName ? ` at ${propertyName}` : '';
  return `Your parking registration${where} was not approved${reason ? `: ${reason}.` : '.'} If you have questions, please reply to this email.`;
}

/** The email's note when the property asks for it (`reject_tow_disclaimer`), quoted for the preview. */
export const TOW_NOTE = "Please note: vehicles parked on the property without an approved parking pass are subject to tow at the vehicle owner's expense.";

/** Which reason the sheet opens on: over limit from that button, missing when a document is. */
export function initialDenyReason(row, { viaOverLimit = false, requireRegistration = false } = {}) {
  if (viaOverLimit) return 'over_cap';
  if (missingDocs(row, { requireRegistration }).length) return 'document_missing';
  return null;
}

// ── Evidence ──────────────────────────────────────────────────

/**
 * The documents to show beside a request, in the order the manager checks
 * them, each with the typed value it should prove. Long-term requests carry
 * four; short-term requests only ever carry a plate photo and a photo ID.
 */
export function evidenceCards(row) {
  const plate = plateText(row);
  const name = holderName(row);
  const unit = unitText(row);
  const plateLine = plate ? `Should show ${plate}` : 'Should show the plate on this request';
  const nameLine = name ? `Should name ${name}` : 'Should name the person on this request';
  const plateCard = { which: 'plate', title: 'Plate photo', short: 'Plate', present: !!row?.has_plate, should: [plateLine] };
  const idCard = { which: 'id', title: 'Photo ID', short: 'ID', present: !!row?.has_id, should: [nameLine] };
  if (!isLongTerm(row)) return [plateCard, idCard];
  const leaseLine = name && unit ? `Should name ${name} and unit ${unit}`
    : name ? `Should name ${name}`
      : unit ? `Should show unit ${unit}`
        : 'Should name a leaseholder';
  return [
    plateCard,
    { which: 'registration', title: 'Registration', short: 'Registration', present: !!row?.has_registration, should: [plateLine, "Should be in a leaseholder's name"] },
    idCard,
    { which: 'lease', title: 'Lease', short: 'Lease', present: !!row?.has_lease, should: [leaseLine] },
  ];
}

/** The scoped docs proxy path (`GET /apartment/docs/{kind}/{id}/{which}`). */
export function docPath(row, which) {
  return `/apartment/docs/${row.kind}/${encodeURIComponent(row.id)}/${which}`;
}

/** Expected documents the row lacks; the registration card only where the property requires it. */
export function missingDocs(row, { requireRegistration = false } = {}) {
  return evidenceCards(row)
    .filter(card => !card.present && (card.which !== 'registration' || requireRegistration))
    .map(card => card.which);
}

// ── URL state (`?status=&q=`) ─────────────────────────────────

const Q_MAX = 40;

export function readQueueQuery(search) {
  const params = new URLSearchParams(String(search ?? '').replace(/^\?/, ''));
  const status = params.get('status');
  return {
    status: SEGMENT_IDS.includes(status) ? status : 'pending',
    q: (params.get('q') ?? '').trim().slice(0, Q_MAX),
  };
}

/** The new `location.search`: every other parameter kept, defaults left out. */
export function writeQueueQuery(search, { status = 'pending', q = '' } = {}) {
  const params = new URLSearchParams(String(search ?? '').replace(/^\?/, ''));
  params.delete('status');
  params.delete('q');
  if (status !== 'pending' && SEGMENT_IDS.includes(status)) params.set('status', status);
  const query = String(q ?? '').trim().slice(0, Q_MAX);
  if (query) params.set('q', query);
  const out = params.toString();
  return out ? `?${out}` : '';
}

// ── Decisions ─────────────────────────────────────────────────

/** What an approval changes on the row before the server answers. */
export function approvedPatch(row, nowIso) {
  return { status: isLongTerm(row) ? 'approved' : 'active', reviewed_at: nowIso };
}

/** The request "Next request" opens: the first one left in queue order. */
export function nextPendingKey(rows, { cap = null, q = '', after = null } = {}) {
  for (const group of reviewGroups(rows, { q, cap })) {
    for (const row of group.rows) if (row.key !== after) return row.key;
  }
  return null;
}

/** A failed approve / deny / void / extend, in words, and whether to reload the list. */
export function actionError(err, verb) {
  const status = err?.status;
  if (status === 401) return { text: 'Your session ended. Sign in again to continue.', refresh: false };
  if (status === 404) return { text: 'This request is no longer on file — refreshing the list.', refresh: true };
  if (status === 409) return { text: 'This request was already updated elsewhere — refreshing the list.', refresh: true };
  if (!status) return { text: `Couldn't ${verb} — check the connection and try again.`, refresh: false };
  return { text: `Couldn't ${verb}. Try again.`, refresh: false };
}

// ── Empty state and display lines ─────────────────────────────

// The `?role=` value apt.js reads to open the long-term form (task F2). An API
// word, not copy.
const LONG_TERM_ROLE = 'resident';

/** The apartment registration link a manager hands out (task F2's format). */
export function registrationLink(origin, qrCodeId) {
  if (!origin || !qrCodeId) return null;
  return `${origin}/apt/${encodeURIComponent(qrCodeId)}?role=${LONG_TERM_ROLE}`;
}

/** Approved long-term passes — "vehicles approved" in the empty state. */
export function approvedVehicleCount(rows) {
  return (rows || []).filter(r => isLongTerm(r) && r.status === 'approved').length;
}

export function allCaughtUpLine(count, propertyName) {
  return `All caught up. ${count} ${count === 1 ? 'vehicle' : 'vehicles'} approved at ${propertyName || 'this property'}.`;
}

/**
 * The "when" line on a row: times only — the list payload carries no reviewer
 * name, so none is shown. A live short-term pass says when it ends instead.
 */
export function decisionLine(row) {
  const stamp = (value, word) => {
    const label = fmtET(value);
    return label ? `${word} ${label}` : word;
  };
  if (!isLongTerm(row) && row?.status === 'active' && row?.valid_until) return stamp(row.valid_until, 'Ends');
  switch (row?.status) {
    case 'pending': return stamp(row.created_at, 'Submitted');
    case 'approved':
    case 'active': return stamp(row.reviewed_at, 'Approved');
    case 'rejected': return stamp(row.reviewed_at, 'Denied');
    case 'void': return stamp(row.reviewed_at, 'Voided');
    default: return stamp(row?.created_at, 'Submitted');
  }
}

const STATUS_TAGS = {
  pending: { tone: 'amber', text: 'Needs review' },
  approved: { tone: 'green', text: 'Approved' },
  active: { tone: 'green', text: 'Approved' },
  rejected: { tone: 'red', text: 'Denied' },
  void: { tone: 'neutral', text: 'Voided' },
  expired: { tone: 'neutral', text: 'Ended' },
  cancelled: { tone: 'neutral', text: 'Cancelled' },
  revoked: { tone: 'neutral', text: 'Revoked' },
  towed: { tone: 'neutral', text: 'Towed' },
};

/** A status tag is never colour alone. */
export function statusTag(row) {
  return STATUS_TAGS[row?.status] || { tone: 'neutral', text: 'Unknown status' };
}

/** "Long-term pass" / "Short-term pass" — the only pass names the queue uses. */
export function passTypeLabel(row) {
  return isLongTerm(row) ? 'Long-term pass' : 'Short-term pass';
}
