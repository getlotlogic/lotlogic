// ── `/r/<token>` action page — pure logic ────────────────────
//
// Everything `RequestActionPage.jsx` needs that doesn't touch the DOM or the
// network lives here, so it can be unit-tested with `node --test` (spec
// §5.8). The page itself just wires these to `GET /requests/action?token=`
// and `POST /requests/action {token, action}` (`src/lib/requestsApi.js`).
//
// State machine: GET returns `{action, request}` where `action` is baked
// into the token the email button carried (`extend24` | `ack_end`) or
// recomputed as `reinstate` when the hold already ended but is still inside
// the 7-day reinstate window (spec §5.8 "A hold that has already expired...
// offers Reinstate"). `deriveInitialView` turns that into a `view`:
//   - `{kind:'preview', action, request}`           — show the action button
//   - `{kind:'limit', request}`                      — extend24 with none left
//   - `{kind:'expired_reinstate', request}`           — offer Reinstate
// Pressing the button POSTs `{token, action}` (the brief's exact body shape
// — not `{token}` alone, because the acknowledged view's "[Extend 24 hours
// instead]" and the expired view's "[Hold again for 24 hours]" both re-POST
// the *same* token with a different `action`, and only `ack_end` is
// documented as repeatable without consuming the token's `jti`).
// `deriveResultView` turns a 200 into a terminal view (`extended` /
// `clamped` / `acknowledged` / `reinstated`); `deriveErrorView` turns a
// failed POST into `limit` (409 while extending) or `invalid` (anything
// else, including the documented 400 used/expired).
//
// Assumption called out in the report: the spec's POST success shape is
// `{result, request}` with no field distinguishing a plain extension from
// one the server clamped to the 7-day cap. This reads an optional `clamped`
// boolean carried alongside `result`/`request` — if the deployed backend
// omits it, every successful extension renders as `extended` (never wrongly
// as `clamped`; the copy stays correct, just not the clamp-specific line).

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

/** A successful `POST /requests/action` → the terminal view to render. */
export function deriveResultView(body) {
  const request = body && body.request ? body.request : null;
  const result = body && body.result;
  if (result === 'extended') return { kind: body.clamped ? 'clamped' : 'extended', request };
  if (result === 'acknowledged') return { kind: 'acknowledged', request };
  if (result === 'reinstated') return { kind: 'reinstated', request };
  return { kind: 'invalid', request };
}

/**
 * A failed `POST /requests/action` → the terminal view to render.
 * `fallbackRequest` is the request from the page's last known preview — the
 * 409 extension-limit body carries no `request`, so the "H-1842 ends at…"
 * line needs the one already on screen.
 */
export function deriveErrorView(action, err, fallbackRequest) {
  if (err && err.status === 409 && action === 'extend24') {
    return { kind: 'limit', request: fallbackRequest || null };
  }
  return { kind: 'invalid', request: null };
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
    case 'acknowledged':
      return `Got it. ${r.ref} ends at ${r.expires_local} as planned. [Extend 24 hours instead]`;
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
