// ── The apartment entry: /apt/<qr> ─────────────────────────────────────────
// An apartment property has ONE public registration address, /apt/<qr>. The
// printed QR signs and the dashboard's copy links reach it with a `role`
// query that skips the landing choice (?role=resident, ?role=guest);
// /perm/<qr> and /temp/<qr> send an apartment on to it, and keep serving
// truck plazas, and every other type, exactly as before.
//
// Pure functions only: no DOM, no network. They live apart from ./register.js
// on purpose. That module reads `document` while it loads, so neither a Node
// test nor the dashboard bundle can import it. register.js re-exports what the
// three public pages need.

const ROLES = ['resident', 'guest'];

/**
 * Which screen /apt/ opens first, from the page's `location.search`.
 * `resident` and `guest` skip the landing; anything else (no role, an unknown
 * one, another case) is the landing, as it was before ?role= existed.
 * @param {string|null|undefined} search
 * @returns {'resident'|'guest'|'landing'}
 */
export function initialScreenForRole(search) {
  const role = new URLSearchParams(search || '').get('role');
  return ROLES.includes(role) ? role : 'landing';
}

/**
 * The address /apt/ is entered at: path and query only, nothing else carried.
 * @param {string} qrCodeId  the property's `qr_code_id` (a slug)
 * @param {'resident'|'guest'} role
 */
export function aptEntryUrl(qrCodeId, role) {
  return `/apt/${encodeURIComponent(qrCodeId)}?role=${role}`;
}

/**
 * The two public registration links a property hands out (the dashboard's QR
 * tiles and Copy link buttons). An apartment has one entry and the role picks
 * the form; every other type keeps its own two pages. A property with no
 * `qr_code_id` yet (every portal signup, until one is assigned) has no address
 * to hand out: both links are null, never one that ends in /null.
 * @param {string} origin  e.g. window.location.origin
 * @param {{property_type?: string|null, qr_code_id?: string|null}|null|undefined} property
 * @returns {{shortTermUrl: string|null, longTermUrl: string|null}}
 */
export function registrationLinks(origin, property) {
  const qr = property && property.qr_code_id;
  if (!qr) return { shortTermUrl: null, longTermUrl: null };
  if (property.property_type === 'apartment') {
    return {
      shortTermUrl: origin + aptEntryUrl(qr, 'guest'),
      longTermUrl: origin + aptEntryUrl(qr, 'resident'),
    };
  }
  return { shortTermUrl: `${origin}/temp/${qr}`, longTermUrl: `${origin}/perm/${qr}` };
}

// ── One QR for a group of properties (Task F6, spec §9) ────────────────────
// /apt/<group> where no property has qr_code_id = <group> but two or more have
// qr_code_id LIKE '<group>-%' is a group: the resident picks the address and
// the page carries on as a visit to /apt/<that slug>. The group is only a
// prefix, so there is no list to keep, and no column to add.

const GROUP_SLUG = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/**
 * The PostgREST path that fetches a group's siblings, in qr_code_id order, or
 * null when the slug could not be a group prefix (it carries LIKE or PostgREST
 * syntax: `_ % * , . ( )` and the like). Needs only what the anon role can read:
 * `verification_status` is NOT among the anon column grants, so it is neither
 * selected nor filtered on here (see groupRows).
 * @param {string|null|undefined} group
 * @returns {string|null}
 */
export function groupQuery(group) {
  if (typeof group !== 'string' || !GROUP_SLUG.test(group)) return null;
  return '/properties?select=id,name,address,qr_code_id,property_type'
    + `&qr_code_id=like.${group}-*&property_type=eq.apartment&order=qr_code_id&limit=25`;
}

// `verification_status` is not readable by the anon role, so the live query does not carry it and
// every row passes that check; a row that does carry a status (a caller with more access, a test)
// counts only when it is 'verified'.
const isVerifiedApartment = (r) => r && r.property_type === 'apartment'
  && (!('verification_status' in r) || r.verification_status === 'verified')
  && typeof r.qr_code_id === 'string';

/**
 * The siblings worth offering, as {slug, name, address}, in qr_code_id order.
 * Only apartments count, and verified ones where the status is known (see above). When `group` is given, rows outside
 * `<group>-` are dropped too (the query already did that; this is the belt).
 * An address that is blank or missing is ''.
 * @param {Array<object>|null|undefined} rows
 * @param {string} [group]
 */
export function groupRows(rows, group) {
  const prefix = typeof group === 'string' ? `${group}-` : null;
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => isVerifiedApartment(r) && (prefix === null || r.qr_code_id.startsWith(prefix)))
    .sort((a, b) => (a.qr_code_id < b.qr_code_id ? -1 : a.qr_code_id > b.qr_code_id ? 1 : 0))
    .map((r) => ({
      slug: r.qr_code_id,
      name: String(r.name == null ? '' : r.name),
      address: typeof r.address === 'string' ? r.address.trim() : '',
    }));
}

/**
 * Is `slug` a group? No row is the slug itself (an exact match always wins),
 * and at least two verified apartments sit under `<slug>-`. One sibling is not
 * a group: the page goes straight to it.
 * @param {Array<object>|null|undefined} rows  the groupQuery result
 * @param {string} slug
 */
export function isGroup(rows, slug) {
  if (!Array.isArray(rows) || rows.some((r) => r && r.qr_code_id === slug)) return false;
  return groupRows(rows, slug).length >= 2;
}

/**
 * Where a tap on one property goes: /apt/<that slug>, the role carried through
 * from the group link (`?role=resident|guest`), or no query when the group
 * link had none (the property's own landing).
 * @param {string} slug
 * @param {string} search  the page's location.search
 */
export function groupEntryUrl(slug, search) {
  const role = initialScreenForRole(search);
  return role === 'landing' ? `/apt/${encodeURIComponent(slug)}` : aptEntryUrl(slug, role);
}
