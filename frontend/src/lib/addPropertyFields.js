// ── Pure helpers for AddPropertyForm ──────────────────────────
//
// Kept out of the .jsx component so they're importable by `node --test`
// with no JSX/DOM transform (mirrors deepLink.js / features.js).

/**
 * The "Enter it manually" fallback: four fields under the address label
 * (spec §5.1). `state` is validated as a two-letter postal abbreviation
 * (case-insensitive, normalized to uppercase by the caller) and `zip` as a
 * 5-digit or ZIP+4 code. `line1` / `city` just need to be non-empty — there
 * is no format to a street address or a city name worth rejecting here.
 * @param {{line1?: string, city?: string, state?: string, zip?: string}} fields
 * @returns {boolean}
 */
export function manualAddressValid(fields) {
  const f = fields || {};
  const line1 = (f.line1 || '').trim();
  const city = (f.city || '').trim();
  const state = (f.state || '').trim();
  const zip = (f.zip || '').trim();
  return line1.length > 0
    && city.length > 0
    && /^[A-Za-z]{2}$/.test(state)
    && /^\d{5}(-\d{4})?$/.test(zip);
}

/**
 * Maps a Google Places `Place` result (`fetchFields(['formattedAddress',
 * 'location','id'])`, spec §3.4a) to the fields the property body needs.
 * `location` is a `google.maps.LatLng` in the browser (methods `lat()` /
 * `lng()`) but a plain `{lat, lng}` is accepted too, so this is testable
 * without the Maps SDK loaded.
 * @param {{formattedAddress?: string, id?: string, location?: any}|null|undefined} place
 * @returns {{address: string, place_id: string|null, lat: number|null, lng: number|null}|null}
 */
export function placeToFields(place) {
  if (!place) return null;
  const loc = place.location;
  const coord = (fn, key) => {
    if (!loc) return null;
    const v = typeof loc[fn] === 'function' ? loc[fn]() : loc[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  return {
    address: typeof place.formattedAddress === 'string' ? place.formattedAddress : '',
    place_id: place.id || null,
    lat: coord('lat', 'lat'),
    lng: coord('lng', 'lng'),
  };
}

/**
 * The `POST /apartment/properties` request body (spec §3.4a, §8.3):
 * `{slug | partner_id:null, property, force}`. `partner_id` can only ever
 * be `null` — the bare-`/join` "Not listed" case — because every property
 * is scoped to a partner server-side, resolved from `slug`; the client is
 * never trusted to name one (this is exactly the trust-column input
 * `tests/test_no_client_tenant_id.py` and migration 3's dropped
 * owner-writable property policies exist to keep out of this request).
 * There is deliberately no parameter here through which a caller could
 * supply a client-side partner id — a slug is the only way to scope the
 * new property to a partner. The in-app "Add a property" door (Account
 * and Lots) has no `/join/<slug>` context, so it always falls into the
 * `partner_id:null` branch — functionally the same bare-`/join` "Not
 * listed" flow — until a real slug source lands on `/auth/me` (see this
 * task's report).
 * @param {{slug?: string|null, property: object, force?: boolean}} args
 * @returns {{slug: string, property: object, force: boolean}|{partner_id: null, property: object, force: boolean}}
 */
export function createPropertyBody({ slug = null, property, force = false }) {
  const body = { property, force: !!force };
  if (slug) body.slug = slug;
  else body.partner_id = null;
  return body;
}
