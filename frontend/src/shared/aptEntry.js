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
