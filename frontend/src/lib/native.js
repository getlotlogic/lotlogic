// ── The native shell bridge ───────────────────────────────────
//
// The LotLogic iPhone app is this dashboard inside a WebView (spec
// 2026-10-18-lotlogic-iphone-app §2). react-native-webview puts
// `window.ReactNativeWebView` on the page before any script runs; that is the
// only sign the page is inside the shell. When it is there, App.jsx
//   - posts `{type: "session", token, email, role}` after every sign-in and
//     once on load when a session exists, and `{type: "signed_out"}` when the
//     person signs out (the shell keeps the token behind Face ID and registers
//     the phone for push with it);
//   - routes `window.LOTLOGIC_NATIVE_OPEN(url)`, which the shell calls with a
//     push's `data.url`, to that property, section and request without a
//     reload;
//   - marks `<html>` with the class `native` (a hook for shell-only CSS).
// In a browser none of this exists: nothing is posted, no global is made and
// no class is set.
//
// The shell talks to the page only through those two directions; it sets
// `localStorage['lotlogic_session']` itself before the page loads, so a
// restored session needs no code here.

import { readDeepLink } from './deepLink.js';

const WIN = typeof window !== 'undefined' ? window : null;

/** True inside the shell's WebView. Read once, at load. */
export const NATIVE = !!(WIN && WIN.ReactNativeWebView);

/** The one origin whose `/app` links `LOTLOGIC_NATIVE_OPEN` follows. */
export const APP_ORIGIN = 'https://lotlogicparking.com';

/**
 * The local hosts a dev build is served from. Only a page that is itself on
 * one of them also follows `http(s)://` `/app` links on them (any port).
 */
const DEV_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * Post one message to the shell on `win`, as the JSON string
 * react-native-webview's `onMessage` receives. A window with no shell, or a
 * shell that throws, posts nothing and never breaks the page.
 * @returns {boolean} whether the shell took it
 */
export function postToShell(win, message) {
  const shell = win && win.ReactNativeWebView;
  if (!shell || typeof shell.postMessage !== 'function') return false;
  try {
    shell.postMessage(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

/** Post to the shell when inside it; a no-op in a browser. */
export function nativePost(message) {
  return NATIVE ? postToShell(WIN, message) : false;
}

/**
 * The `session` message for a stored dashboard session
 * (`localStorage['lotlogic_session']`), or null when it holds no token.
 * `role` is the account's own role, `owner` (an office) or `partner` (a tow
 * company), never the "View as Partner" one.
 */
export function sessionMessage(session) {
  const token = session && session._token;
  if (typeof token !== 'string' || token === '') return null;
  return { type: 'session', token, email: session.email ?? null, role: session._role ?? null };
}

export const SIGNED_OUT_MESSAGE = Object.freeze({ type: 'signed_out' });

/**
 * What `LOTLOGIC_NATIVE_OPEN(url)` accepts: an `/app` link on
 * https://lotlogicparking.com, absolute or as a root-relative `/app…` path,
 * and, in dev only (the page itself is served from localhost or 127.0.0.1),
 * an `http(s)://localhost[:port]/app…` or `127.0.0.1` link too.
 * Returns the path and query to route to (`/app?property=…`; any fragment is
 * dropped), or null for anything else: another origin or scheme, a port
 * (outside dev), a user name, a protocol-relative `//host`, a path that is
 * not `/app` or under `/app/`.
 * @param {unknown} url
 * @param {string} [pageHost] the hostname the page is served from (defaults
 *   to the page's own)
 * @returns {string|null}
 */
export function nativeOpenTarget(url, pageHost = WIN?.location?.hostname) {
  if (typeof url !== 'string') return null;
  const raw = url.trim();
  // A root-relative path resolves against the dashboard origin; anything else
  // must be an absolute url on its own (so `app?x` or `evil/app` is refused).
  // A protocol-relative `//host` lands on another origin and is refused, in
  // dev too: only an absolute url can name a local host.
  const relative = raw.startsWith('/');
  let parsed;
  try { parsed = relative ? new URL(raw, APP_ORIGIN) : new URL(raw); } catch { return null; }
  if (parsed.username || parsed.password) return null;
  const devLink = !relative && DEV_HOSTS.has(pageHost) && DEV_HOSTS.has(parsed.hostname)
    && (parsed.protocol === 'http:' || parsed.protocol === 'https:');
  if (parsed.origin !== APP_ORIGIN && !devLink) return null;
  if (parsed.pathname !== '/app' && !parsed.pathname.startsWith('/app/')) return null;
  return `${parsed.pathname}${parsed.search}`;
}

/**
 * The deep link an accepted target means, read by the page's own reader
 * (`readDeepLink`). A push about a request names the request; it opens in
 * the property's Requests section even when the link carries no `section`,
 * rather than in whichever section the property page last remembered.
 */
export function nativeDeepLink(target) {
  const q = typeof target === 'string' ? target.indexOf('?') : -1;
  const link = readDeepLink(q === -1 ? '' : target.slice(q));
  if (link.request && !link.section) link.section = 'requests';
  return link;
}

/**
 * The shell can call `LOTLOGIC_NATIVE_OPEN` at any time, including before the
 * app has mounted. `open` keeps the latest accepted target until a listener
 * is there, and hands it over once; after that every accepted open goes
 * straight to the listener.
 */
export function createNativeOpenRouter() {
  let listener = null;
  let kept = null;
  return {
    open(url) {
      const target = nativeOpenTarget(url);
      if (!target) return false;
      if (listener) listener(target);
      else kept = target;
      return true;
    },
    listen(fn) {
      listener = fn;
      if (kept) {
        const target = kept;
        kept = null;
        fn(target);
      }
      return () => { if (listener === fn) listener = null; };
    },
  };
}

const router = createNativeOpenRouter();
if (NATIVE) {
  WIN.LOTLOGIC_NATIVE_OPEN = router.open;
  WIN.document?.documentElement?.classList.add('native');
}

/** App.jsx's listener for `LOTLOGIC_NATIVE_OPEN`; returns the unsubscribe. */
export const onNativeOpen = router.listen;
