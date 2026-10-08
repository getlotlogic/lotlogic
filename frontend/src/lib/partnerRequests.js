// ── The partner Requests tab's pure layer (spec §5.4) ─────────
//
// Everything here is a plain function over the request shape §8.3 returns
// (`{id, ref, property_id, kind, status, plate, …, expires_local, hours_left,
// created_by:{name, position, type}, partner_ack_at, checked_count,
// property_verified}`) so `node --test` can hold the ordering, the badge and
// every line of row copy to the spec without a browser.
//
// Two rules are load-bearing and both live here, once:
//   * the badge counts only what N Style must ACT on — active tows, active
//     photo requests, unconfirmed properties, pending join requests — never
//     every hold ("a badge of 14 that never clears is a badge he stops
//     reading");
//   * inside a property tows and photo requests sit above holds, and both the
//     rows and the property groups are ordered by soonest expiry.
//
// No timezone math ever decides a verdict: a hold's deadline is rendered from
// the server's `expires_local` ("Fri Oct 10, 6:00 PM ET"). The only formatting
// done here is the clock time of an event (`fmtTimeET`), pinned to the lot's
// zone so a phone in another state still reads lot time.

const LOT_TZ = 'America/New_York';

/** Non-negative integer, or 0 for anything that is not one. */
function count(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

const list = (items) => (Array.isArray(items) ? items : []);

/** A row is live unless it says otherwise — both views send `status`. */
export function isActive(item) {
  return !item?.status || item.status === 'active';
}

// ── the badge ────────────────────────────────────────────────

/**
 * Spec §5.4: **active tows + active photos + unconfirmed properties + pending
 * joins**. Holds are deliberately absent — they are the steady-state volume,
 * and a number that never reaches zero stops being read.
 */
export function badgeCount({ tows, photos, pendingProps, pendingJoins } = {}) {
  return count(tows) + count(photos) + count(pendingProps) + count(pendingJoins);
}

/** `{tows, photos}` over an active list — the two halves of the badge. */
export function countActionable(items) {
  let tows = 0;
  let photos = 0;
  for (const item of list(items)) {
    if (!isActive(item)) continue;
    if (item.kind === 'tow') tows++;
    else if (item.kind === 'photo') photos++;
  }
  return { tows, photos };
}

// ── filter chips ─────────────────────────────────────────────

export function chipCounts(items) {
  const rows = list(items);
  return {
    all: rows.length,
    holds: rows.filter(i => i.kind === 'hold').length,
    tows: rows.filter(i => i.kind === 'tow').length,
    photos: rows.filter(i => i.kind === 'photo').length,
  };
}

/**
 * The chip row: `(All)(Holds 9)(Tows 4)(Photos 1)(Recent)`. All and Recent
 * carry no number — All is "everything already on screen" and Recent is a
 * different view (`view=recent`), so a count there would be a promise this
 * list cannot keep.
 */
export function chipsFor(items) {
  const c = chipCounts(items);
  return [
    { id: 'all', label: 'All', count: null },
    { id: 'holds', label: 'Holds', count: c.holds },
    { id: 'tows', label: 'Tows', count: c.tows },
    { id: 'photos', label: 'Photos', count: c.photos },
    { id: 'recent', label: 'Recent', count: null },
  ];
}

const CHIP_KIND = { holds: 'hold', tows: 'tow', photos: 'photo' };

export function filterItems(items, chip) {
  const kind = CHIP_KIND[chip];
  return kind ? list(items).filter(i => i.kind === kind) : list(items);
}

// ── ordering ─────────────────────────────────────────────────

// Tows first, then photo requests, then holds: a hold is a "do nothing"
// instruction and a tow is work.
const KIND_RANK = { tow: 0, photo: 1, hold: 2 };

export function kindRank(kind) {
  return kind in KIND_RANK ? KIND_RANK[kind] : 3;
}

function millis(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Ascending, with "no value" last — the server's `expires_at NULLS LAST`. */
function byTimeNullsLast(a, b) {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

/**
 * Row order inside one property: kind, then soonest expiry, then oldest
 * request, then reference number. The last two keys make this a total order,
 * so the list does not reshuffle between polls.
 */
export function compareItems(a, b) {
  const byKind = kindRank(a?.kind) - kindRank(b?.kind);
  if (byKind) return byKind;
  const byExpiry = byTimeNullsLast(millis(a?.expires_at), millis(b?.expires_at));
  if (byExpiry) return byExpiry;
  const byCreated = byTimeNullsLast(millis(a?.created_at), millis(b?.created_at));
  if (byCreated) return byCreated;
  return String(a?.ref || '').localeCompare(String(b?.ref || ''));
}

/**
 * Group the active list by property, spec §5.4 order.
 *
 * @param {Array<object>} items rows from `GET /apartment/requests?view=active`
 * @param {Record<string,string>} [propertyNames] id → name, from
 *   `/auth/me.properties`, for a backend that does not echo the name on a row
 * @returns {Array<{propertyId, propertyName, propertyVerified, count, soonestExpiry, items}>}
 */
export function groupAndSort(items, propertyNames) {
  const names = propertyNames || {};
  const groups = new Map();
  for (const item of list(items)) {
    const id = item?.property_id || '';
    let group = groups.get(id);
    if (!group) {
      group = {
        propertyId: id,
        propertyName: item?.property_name || names[id] || id,
        propertyVerified: true,
        count: 0,
        soonestExpiry: null,
        items: [],
      };
      groups.set(id, group);
    }
    // One row saying the property is unconfirmed is enough — the header warns.
    if (item?.property_verified === false) group.propertyVerified = false;
    group.items.push(item);
  }
  const out = [...groups.values()];
  for (const group of out) {
    group.items.sort(compareItems);
    group.count = group.items.length;
    for (const item of group.items) {
      const t = millis(item.expires_at);
      if (t !== null && (group.soonestExpiry === null || t < group.soonestExpiry)) group.soonestExpiry = t;
    }
    group.oldest = group.items.reduce(
      (acc, i) => byTimeNullsLast(millis(i.created_at), acc) < 0 ? millis(i.created_at) : acc,
      null,
    );
  }
  out.sort((a, b) => {
    const byExpiry = byTimeNullsLast(a.soonestExpiry, b.soonestExpiry);
    if (byExpiry) return byExpiry;
    const byOldest = byTimeNullsLast(a.oldest, b.oldest);
    if (byOldest) return byOldest;
    return a.propertyName.localeCompare(b.propertyName);
  });
  return out;
}

// ── row copy ─────────────────────────────────────────────────

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function msLeft(item, now) {
  const at = millis(item?.expires_at);
  if (at === null) return null;
  return at - (Number.isFinite(now) ? now : Date.now());
}

// A row that has ended says what happened to it, in words — spec §5.2's
// Recent treatment ("an outcome pill in words": Expired, Towed, Photo sent,
// Declined, …), read from the partner's side, so "removed" names the office.
const OUTCOME_BY_RESOLUTION = {
  towed: 'Towed',
  photographed: 'Photo sent',
  declined: 'Declined',
  property_removed: 'Property not confirmed',
  expired: 'Expired',
};
const OUTCOME_BY_STATUS = {
  fulfilled: 'Done',
  declined: 'Declined',
  removed: 'Removed by the office',
  expired: 'Expired',
};

/**
 * The outcome word for a terminal row, '' while it is still live. `resolution`
 * is the precise answer (§8.2's CHECK pins the five values); `status` is the
 * fallback for a row the sweep ended without one.
 */
export function outcomeLabel(item) {
  if (isActive(item)) return '';
  return OUTCOME_BY_RESOLUTION[item?.resolution]
    || OUTCOME_BY_STATUS[item?.status]
    || '';
}

/**
 * The third column of a row. A live hold counts down; a live tow or photo
 * request says whether the crew has picked it up yet; a row that has ended
 * reads its outcome, because "new" on a tow fulfilled last week is a lie.
 */
export function timeLeftLabel(item, now) {
  if (!isActive(item)) return outcomeLabel(item);
  if (item?.kind !== 'hold') return item?.partner_ack_at ? 'seen' : 'new';
  const left = msLeft(item, now);
  if (left === null) return '';
  if (left <= 0) return 'expired';
  if (left < HOUR) return `${Math.round(left / MINUTE)} min left`;
  if (left < DAY) return `${Math.floor(left / HOUR)}h left`;
  return `${Math.floor(left / DAY)}d ${Math.floor((left % DAY) / HOUR)}h left`;
}

/** Under an hour and still live — the time line turns amber (spec §5.2). */
export function isEndingSoon(item, now) {
  if (item?.kind !== 'hold' || !isActive(item)) return false;
  const left = msLeft(item, now);
  return left !== null && left > 0 && left < HOUR;
}

const TIME_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: LOT_TZ, hour: 'numeric', minute: '2-digit',
});

/** "4:12 PM" in lot time. Empty for anything unparseable. */
export function fmtTimeET(iso) {
  const t = millis(iso);
  if (t === null) return '';
  return TIME_FMT.format(new Date(t));
}

/**
 * Who placed it and when. A tow request is a written instruction, so the line
 * says so — that sentence is what N Style acts on.
 */
export function placedByLine(item) {
  const time = fmtTimeET(item?.created_at);
  if (item?.kind === 'tow') return [`written request on file`, time].filter(Boolean).join(' · ');
  const by = item?.created_by || {};
  const who = by.position ? `${by.name} (${by.position})` : (by.name || '');
  return [who, time].filter(Boolean).join(' · ');
}

export function vehicleText(item) {
  return [item?.year, item?.make, item?.model, item?.color]
    .map(v => (v === null || v === undefined ? '' : String(v).trim()))
    .filter(Boolean)
    .join(' ');
}

export function truncateNote(note, max = 28) {
  const s = String(note || '').trim();
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** "Seen 5:40 PM · checked 3×" — acknowledgement, then partner checks. */
export function seenLine(item) {
  const parts = [];
  if (item?.partner_ack_at) parts.push(`Seen ${fmtTimeET(item.partner_ack_at)}`);
  const checked = count(item?.checked_count);
  if (checked > 0) parts.push(`checked ${checked}×`);
  return parts.join(' · ');
}

// H-1842 / T-0231 / P-0040 — one global sequence, never zero-padded (§4.2).
const REF_SHAPE = /^[HTP]-\d+$/;

/**
 * Lineage travels with the number everywhere it is shown — "H-1850 (replaces
 * H-1842)" (spec §4.2). §8.3's request shape carries the predecessor as
 * `reinstated_from`, which §8.2's DDL makes a `uuid REFERENCES
 * public.tow_requests(id)`, and a uuid must never reach the crew — so the
 * line renders only once that field holds a reference number. Against a
 * serializer that still sends the uuid the row shows the bare ref; the gap is
 * a cross-task concern for the request serializer, not a silent rename here.
 */
export function refWithLineage(item) {
  const ref = item?.ref || '';
  const from = item?.reinstated_from === null || item?.reinstated_from === undefined
    ? ''
    : String(item.reinstated_from);
  return REF_SHAPE.test(from) ? `${ref} (replaces ${from})` : ref;
}

// ── which controls a row gets ────────────────────────────────

/**
 * Spec §5.4: a hold shows **Got it** and hides the rest behind ⋯ (Towed
 * anyway · Decline… · History); a tow or photo request shows all three up
 * front. **Got it** disappears once the row is acknowledged — the row line
 * says "Seen 9:40 PM" instead.
 */
export function actionsFor(item) {
  // A row that has ended is read-only. Every write route answers 409
  // `not_active` on a terminal row (§8.3), so a control here would be a
  // promise of a generic error toast; History is the one thing still true.
  if (!isActive(item)) return { buttons: [], menu: ['history'] };
  const buttons = [];
  const menu = [];
  if (!item?.partner_ack_at) buttons.push('ack');
  if (item?.kind === 'tow') buttons.push('towed', 'decline');
  else if (item?.kind === 'photo') buttons.push('photographed', 'decline');
  else menu.push('towed_anyway', 'decline');
  menu.push('history');
  return { buttons, menu };
}

// ── the pending-property card ────────────────────────────────

const first = (...values) => {
  for (const v of values) if (v !== null && v !== undefined && v !== '') return v;
  return '';
};

/**
 * One row of `GET /partner/properties?verification_status=pending` flattened
 * for the confirm card. The route carries the manager's name, role and phone,
 * the active hold count and the similar-address hint; it is read through
 * several plausible key names because the card must still render a name and an
 * address against a backend that spells one of them differently.
 */
export function normalizePendingProperty(row) {
  if (!row) return null;
  const manager = row.manager || {};
  return {
    id: row.id,
    name: String(first(row.name) || ''),
    address: String(first(row.address, row.address_line1) || ''),
    managerName: String(first(manager.name, row.manager_name, row.signed_up_by, row.contact_name) || ''),
    managerPosition: String(first(manager.position, row.manager_position, row.position) || ''),
    managerPhone: String(first(manager.phone, row.manager_phone, row.signup_phone, row.phone) || ''),
    holds: count(first(row.active_holds, row.active_hold_count, row.holds)),
    similarAddress: String(
      first(row.similar_address, row.possible_duplicate_name, row.possible_duplicate_of_name) || '',
    ),
  };
}
