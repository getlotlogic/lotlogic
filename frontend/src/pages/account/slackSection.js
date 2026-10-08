// ── Partner Account → Slack: pure helpers ────────────────────
//
// Kept out of SlackSection.jsx on purpose: `node --test` (frontend/scripts)
// has no JSX transform, so any symbol a test imports must live in a file the
// native ESM loader can parse as plain JavaScript. This mirrors the existing
// split in this codebase (features.js / deepLink.js next to the .jsx that
// consumes them) — see frontend/scripts/features.test.mjs.

/**
 * The naming rule (spec/constraints "Copy"): the Slack `driver` role is
 * never capitalized and shown as its own name — it renders "Truck" on
 * screen; `manager` renders "Office". Any value other than the two the DB's
 * CHECK constraint allows still falls through to "Truck", so this can never
 * surface the banned label.
 * @param {string} role 'manager' | 'driver'
 * @returns {'Office'|'Truck'}
 */
export function roleLabel(role) {
  return role === 'manager' ? 'Office' : 'Truck';
}

/**
 * The partner Slack connection as one of four states, from the shape
 * `GET /partner/slack/status` returns: `{connected, team_name,
 * feed_channel_set, revoked}` (spec line ~1050, backend Task 17).
 *
 * `status` may be `null`/`undefined` — before the fetch resolves, or when it
 * failed with something other than 404 (slack_installations row load
 * failure, offline, etc.) — and that is treated the same as a partner who
 * has never connected: `not_connected`.
 *
 * @param {{connected?: boolean, feed_channel_set?: boolean, revoked?: boolean}|null|undefined} status
 * @returns {'not_connected'|'connected_no_feed'|'connected'|'revoked'}
 */
export function slackState(status) {
  if (!status || !status.connected) return 'not_connected';
  if (status.revoked) return 'revoked';
  if (!status.feed_channel_set) return 'connected_no_feed';
  return 'connected';
}

/**
 * The `?slack=` value `/slack/oauth_redirect` lands the partner back on
 * `/app?tab=account&slack=connected` (or `…&slack=error`) with — or `null`
 * for anything else. deepLink.js deliberately leaves this key alone ("for
 * whoever owns it"); this module is that owner.
 * @param {string|null|undefined} search `location.search`
 * @returns {'connected'|'error'|null}
 */
export function parseSlackRedirect(search) {
  let params;
  try {
    params = new URLSearchParams(typeof search === 'string' ? search.replace(/^\?/, '') : '');
  } catch {
    return null;
  }
  const v = params.get('slack');
  return v === 'connected' || v === 'error' ? v : null;
}

/**
 * The url App.jsx's one-time toast effect replaces into, so a refresh does
 * not replay the toast — same `path?remaining-query` shape as
 * `cleanedDeepLinkUrl` in deepLink.js, scoped to just the `slack` key.
 * @param {string|null|undefined} pathname
 * @param {string|null|undefined} search
 * @returns {string}
 */
export function cleanSlackRedirectUrl(pathname, search) {
  const params = new URLSearchParams(typeof search === 'string' ? search.replace(/^\?/, '') : '');
  params.delete('slack');
  const rest = params.toString();
  const path = pathname || '/';
  return rest ? `${path}?${rest}` : path;
}
