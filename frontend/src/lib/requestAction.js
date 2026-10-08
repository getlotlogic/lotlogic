// ── `/r/<token>` action page — pure logic ────────────────────
//
// Everything `RequestActionPage.jsx` needs that doesn't touch the DOM or the
// network lives here, so it can be unit-tested with `node --test` (spec
// §5.8). The page itself just wires these to `GET /requests/action?token=`
// and `POST /requests/action {token, action}` (`src/lib/requestsApi.js`).
//
// State machine — matched to the backend's real contract
// (lotlogic-backend `routers/request_actions.py`):
//   * GET returns `{action, request}`; `action` is ALWAYS the action baked
//     into the token the email button carried (`extend24` | `ack_end`, or
//     `reinstate` for a reinstate token). The preview never recomputes
//     `reinstate` for a hold that has already ended. `deriveInitialView`:
//       - `{kind:'preview', action, request}`   — show the action button
//       - `{kind:'limit', request}`              — extend24 with none left
//       - `{kind:'expired_reinstate', request}`  — a reinstate token
//   * Pressing the button POSTs `{token, action}`. The acknowledged view's
//     "[Extend 24 hours instead]" and the ended view's "[Hold again for 24
//     hours]" re-POST the *same* token with a different `action`; the
//     backend takes `body.action` over the token's own, so an extend24 or
//     ack_end token may reinstate (its single-use `jti` / `iat` checks
//     still apply).
//   * `deriveResultView` turns a 200 into `extended` / `clamped` /
//     `acknowledged` / `reinstated`, or `limit` — a refused extension
//     (`extension_limit` / `hold_window`) is a 200 `{result:'limit', request,
//     expires_local, extension_count}`, not an error.
//   * `deriveErrorView` turns a failed POST into `expired_reinstate` for the
//     409 `not_active` the backend answers when the hold has already ended
//     (the only 409 on the extend24 / ack_end path), and `invalid` for
//     everything else (400 `link_used` / `link_invalid`, a refused reinstate).
//
// The extended body carries `clamped: true` when the server cut the
// extension to the 7-day cap; that renders the clamp-specific line.

/** Most extensions a hold may have (spec §5.8 "All 4 extensions"). */
const MAX_EXTENSIONS = 4;

/**
 * The token in a `/r/<token>` path. Query strings are never consulted — the
 * email's two buttons are two different tokens at the same exact path, not
 * one token with an `?action=` query (a public route may not carry a path
 * *parameter*, but `/r/:path*` is a static rewrite, not a route match).
 * @param {string|null|undefined} pathname
 * @returns {string|null}
 */
export function readActionToken(pathname) {
  const path = typeof pathname === 'string' ? pathname : '';
  const m = path.match(/^\/r\/([^/?#]+)/);
  if (!m) return null;
  let token = m[1];
  try { token = decodeURIComponent(token); } catch { /* keep the raw segment */ }
  token = token.trim();
  return token === '' ? null : token;
}

/**
 * Take the 48 h bearer token out of the address bar once it has been read:
 * `/r/<token>` becomes `/r` (no query, no hash), so it does not sit in the
 * history, a screenshot, or an error report's url. The caller keeps the
 * token in state for the POST. Returns whether it rewrote the url.
 * @param {{location?: {pathname?: string}, history?: {replaceState: Function}}} w
 */
export function hideActionToken(w) {
  try {
    if (!w || !w.location || !readActionToken(w.location.pathname)) return false;
    w.history.replaceState(null, '', '/r');
    return true;
  } catch {
    return false; // a blocked history API must never break the page
  }
}

/** The trailing "9:14 PM ET" out of a full "Wed Oct 8, 9:14 PM ET". */
export function shortTime(expiresLocal) {
  if (typeof expiresLocal !== 'string') return '';
  const m = expiresLocal.match(/(\d{1,2}:\d{2}\s*[AP]M\s*ET)\s*$/i);
  return m ? m[1] : expiresLocal;
}

/** Preview text shown above the action button (spec §5.8). */
export function previewCopy(request) {
  if (!request) return '';
  return `Hold at ${request.property_name} · ${request.plate} · until ${request.expires_local}`;
}

/** One primary-button label per baked-in action (spec §5.8 / brief). */
export function actionButtonLabel(action, request) {
  switch (action) {
    case 'extend24': return 'Extend 24 hours';
    case 'ack_end': return `OK — it ends at ${shortTime(request && request.expires_local)}`;
    case 'reinstate': return 'Hold again for 24 hours';
    default: return '';
  }
}

/** `GET /requests/action?token=` response → the view to render first. */
export function deriveInitialView(preview) {
  if (!preview || !preview.request || !preview.action) {
    return { kind: 'invalid', request: null };
  }
  const { action, request } = preview;
  if (action === 'reinstate') return { kind: 'expired_reinstate', request };
  if (action === 'extend24' && Number(request.extensions_left) <= 0) {
    return { kind: 'limit', request };
  }
  if (action === 'extend24' || action === 'ack_end') {
    return { kind: 'preview', action, request };
  }
  return { kind: 'invalid', request: null };
}

/**
 * A successful `POST /requests/action` → the terminal view to render.
 * `fallbackRequest` (the request already on screen) is only used when a
 * `limit` body arrives without its own `request`.
 */
export function deriveResultView(body, fallbackRequest) {
  const request = body && body.request ? body.request : null;
  const result = body && body.result;
  if (result === 'extended') return { kind: body.clamped ? 'clamped' : 'extended', request };
  if (result === 'acknowledged') return { kind: 'acknowledged', request };
  if (result === 'reinstated') return { kind: 'reinstated', request };
  if (result === 'limit') {
    // Refused extension: the body's own `expires_local` / `extension_count`
    // are the post-rollback truth; the request supplies `ref` and the ids.
    const base = request || fallbackRequest || {};
    const merged = { ...base };
    if (body.expires_local) merged.expires_local = body.expires_local;
    if (body.extension_count != null) merged.extension_count = body.extension_count;
    return { kind: 'limit', request: merged };
  }
  return { kind: 'invalid', request };
}

/**
 * A failed `POST /requests/action` → the terminal view to render.
 * The backend's only 409 on the extend24 / ack_end path is `not_active`: the
 * hold has already ended. That is the §5.8 ended state with "[Hold again for
 * 24 hours]" (which re-POSTs this token with `action:'reinstate'`). The
 * 409 body carries no `request`, so `fallbackRequest` — the one already on
 * screen — supplies the "H-1842 ended at …" line. Everything else (400
 * `link_used` / `link_invalid`, a refused reinstate) is `invalid`.
 */
export function deriveErrorView(action, err, fallbackRequest) {
  const code = err && (typeof err.code === 'string' ? err.code
    : err.body && typeof err.body.detail === 'string' ? err.body.detail : undefined);
  if (err && err.status === 409 && code === 'not_active'
      && (action === 'extend24' || action === 'ack_end') && fallbackRequest) {
    return { kind: 'expired_reinstate', request: fallbackRequest };
  }
  return { kind: 'invalid', request: null };
}

/**
 * Extensions this hold still has: `extensions_left` when the backend sent
 * it (holds only), else `4 - extension_count`, else null (unknown).
 */
export function extensionsLeft(request) {
  if (!request) return null;
  if (typeof request.extensions_left === 'number') return request.extensions_left;
  if (typeof request.extension_count === 'number') return MAX_EXTENSIONS - request.extension_count;
  return null;
}

/** The result copy verbatim (spec §5.8) for every terminal / edge view. */
export function resultCopy(view) {
  const v = view || {};
  const r = v.request || {};
  switch (v.kind) {
    case 'extended':
      return `Extended to ${r.expires_local} · ${r.ref} · extension ${r.extension_count} of 4`;
    case 'clamped':
      return `Extended as far as allowed — to ${r.expires_local}`;
    case 'acknowledged': {
      // No "[Extend 24 hours instead]" once all 4 are used — it could only
      // come back as the limit page.
      const left = extensionsLeft(v.request);
      const offer = left === null || left > 0 ? ' [Extend 24 hours instead]' : '';
      return `Got it. ${r.ref} ends at ${r.expires_local} as planned.${offer}`;
    }
    case 'limit':
      return `All 4 extensions are used. ${r.ref} ends at ${r.expires_local}. Sign in to place a new hold after it ends.`;
    case 'expired_reinstate':
      return `${r.ref} ended at ${r.expires_local}. [Hold again for 24 hours]`;
    case 'invalid':
      return 'This link has expired. Sign in to manage the hold.';
    // Not spec-verbatim — §5.8 never shows what a successful Reinstate looks
    // like. Phrased after the `extended` line since it is the same shape
    // (the hold is active again); called out in the report.
    case 'reinstated':
      return `Hold placed again · ${r.ref} · until ${r.expires_local}`;
    default:
      return '';
  }
}

const TRAILING_BRACKET_RE = /\s*\[([^\]]+)\]\s*$/;

/** `resultCopy` with any trailing "[Button label]" stripped — the plain text. */
export function bodyText(view) {
  return resultCopy(view).replace(TRAILING_BRACKET_RE, '').trim();
}

/** The trailing "[Button label]" out of `resultCopy`, or null. */
export function ctaLabel(view) {
  const m = resultCopy(view).match(TRAILING_BRACKET_RE);
  return m ? m[1] : null;
}

/** The action a view's bracketed button (if any) re-POSTs. */
export function ctaAction(view) {
  if (!ctaLabel(view)) return null;
  switch (view && view.kind) {
    case 'acknowledged': return 'extend24';
    case 'expired_reinstate': return 'reinstate';
    default: return null;
  }
}

/** Views whose spec copy sends the reader to sign in. */
export function needsSignIn(view) {
  return ['extended', 'clamped', 'limit', 'invalid', 'reinstated'].includes(view && view.kind);
}

/** `/app?property=<id>&request=<id>` — `LoginPage`'s return-to replays this. */
export function signInHref(request) {
  if (!request || !request.property_id || !request.id) return '/app';
  return `/app?property=${encodeURIComponent(request.property_id)}&request=${encodeURIComponent(request.id)}`;
}
