// ── Deep links into the dashboard ────────────────────────────
//
// Every portal email / Slack button lands on the dashboard bundle with the
// surface it means in the query string:
//
//   /app?property=<id>&section=requests&firstrun=1   signup landing (§3.4 step 5)
//   /app?property=<id>&request=<id>                  "Open in LotLogic" on a request
//   /app?property=<id>&request=<id>&upload=1         Slack "[Photo sent]" (§6.5)
//   /app?verify=1                                    the 6-digit code email (§5.9)
//   /app?tab=lookup&plate=ABC1234                    the partner lookup link
//
// App.jsx reads this ONCE on mount, applies it, and then cleans the query with
// a `replaceState` so a refresh does not replay `firstrun`. Keeping the reader
// a pure function over the query string is what makes it testable without a
// DOM (scripts/deepLink.test.mjs).

// The keys this module owns. `cleanDeepLink` strips exactly these and leaves
// anything else (e.g. `?slack=connected`) for whoever owns it.
export const DEEP_LINK_KEYS = ['tab', 'property', 'section', 'request', 'firstrun', 'verify', 'upload', 'plate'];

const EMPTY = {
  tab: null, property: null, section: null, request: null,
  firstrun: false, verify: false, upload: false, plate: null,
};

/** The deep link with nothing in it — App.jsx uses this to forget one. */
export function emptyDeepLink() {
  return { ...EMPTY };
}

/**
 * Parse a `location.search` string.
 * @param {string|null|undefined} search
 * @returns {{tab: string|null, property: string|null, section: string|null,
 *            request: string|null, firstrun: boolean, verify: boolean,
 *            upload: boolean, plate: string|null}}
 */
export function readDeepLink(search) {
  const params = new URLSearchParams(typeof search === 'string' ? search.replace(/^\?/, '') : '');
  const str = (key) => {
    const raw = params.get(key);
    if (raw == null) return null;
    const trimmed = raw.trim();
    return trimmed === '' ? null : trimmed;
  };
  // `?firstrun`, `?firstrun=1`, `?firstrun=true` and `?firstrun=yes` are all
  // on; an explicit `0`/`no`/anything else is off.
  const flag = (key) => {
    const raw = params.get(key);
    if (raw == null) return false;
    const v = raw.trim().toLowerCase();
    return v === '' || v === '1' || v === 'true' || v === 'yes';
  };
  return {
    tab: str('tab'),
    property: str('property'),
    section: str('section'),
    request: str('request'),
    firstrun: flag('firstrun'),
    verify: flag('verify'),
    upload: flag('upload'),
    plate: str('plate'),
  };
}

/**
 * The url `cleanDeepLink` would navigate to: same path, deep-link keys removed,
 * every other parameter kept in place.
 */
export function cleanedDeepLinkUrl(pathname, search) {
  const params = new URLSearchParams(typeof search === 'string' ? search.replace(/^\?/, '') : '');
  for (const key of DEEP_LINK_KEYS) params.delete(key);
  const rest = params.toString();
  const path = pathname || '/';
  return rest ? `${path}?${rest}` : path;
}

/**
 * Strip the deep-link keys from the address bar without a navigation, so a
 * refresh does not replay `firstrun` (or re-open the composer).
 * @param {Window} [win] injectable for tests
 * @returns {string|null} the url that was replaced in
 */
export function cleanDeepLink(win) {
  const w = win || (typeof window !== 'undefined' ? window : null);
  if (!w || !w.location) return null;
  const url = cleanedDeepLinkUrl(w.location.pathname, w.location.search);
  try { w.history.replaceState(null, '', url); } catch { /* non-browser / blocked */ }
  return url;
}

/**
 * The public (no session required) route this path asks for, or null for the
 * ordinary dashboard. `vercel.json` rewrites `/join`, `/join/:path*` and
 * `/r/:path*` to `dashboard.html`, so these are the only two.
 */
export function readPublicRoute(pathname) {
  const path = typeof pathname === 'string' ? pathname : '';
  if (path === '/join' || path.startsWith('/join/') || path.startsWith('/join?')) return 'join';
  if (path === '/r' || path.startsWith('/r/')) return 'request-action';
  return null;
}

/**
 * The partner slug in a `/join/<slug>` link, or null for a bare `/join`
 * (which asks the "who do you send requests to?" question instead).
 */
export function readJoinSlug(pathname) {
  const path = typeof pathname === 'string' ? pathname : '';
  const m = path.match(/^\/join\/([^/?#]+)/);
  if (!m) return null;
  let slug = m[1];
  try { slug = decodeURIComponent(slug); } catch { /* keep the raw segment */ }
  slug = slug.trim();
  return slug === '' ? null : slug;
}

/** sessionStorage key LoginPage parks the pre-sign-in location under. */
export const RETURN_TO_KEY = 'lotlogic_return_to';

/**
 * Where to replay to after a sign-in. Only `/app` locations are honoured —
 * anything else (a `/join` link, an off-site value someone planted in
 * sessionStorage) is dropped — and the path is always normalized to `/app`,
 * so only the query survives.
 * @param {string|null|undefined} stored `pathname + search` captured on mount
 * @returns {string|null}
 */
export function returnToTarget(stored) {
  if (typeof stored !== 'string' || !stored.startsWith('/app')) return null;
  const q = stored.indexOf('?');
  const search = q === -1 ? '' : stored.slice(q);
  return search && search !== '?' ? `/app${search}` : '/app';
}
