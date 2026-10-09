// The `?e2e=1` test surface, in one place.
//
// `isE2E()` gates `window.__lotlogicTestHooks` (main.jsx) and — through
// `e2eApiOverride()` — the backend origin `lib/api.js` talks to. Both are
// refused on the production hostnames whatever the query string or the
// localStorage flag say, so a production visitor can never be pointed at
// another backend. Previews (`*.vercel.app`) and localhost still honour it.
//
// The override exists for the portal Playwright suite (tests/README.md,
// "Portal suite"): it boots the real bundle against a local backend on
// http://localhost:8010 by setting `window.__LOTLOGIC_API__` in an init
// script that runs before this module loads. Only an absolute http(s) origin
// is accepted, and the value is read once, at module load, exactly like the
// literal it replaces.
export const PROD_HOSTNAMES = new Set(['lotlogicparking.com', 'www.lotlogicparking.com']);

function browserEnv() {
  if (typeof window === 'undefined' || typeof location === 'undefined') return null;
  let flag = null;
  try { flag = localStorage.getItem('lotlogic:e2e'); } catch { /* blocked storage */ }
  return {
    hostname: location.hostname,
    search: location.search,
    flag,
    override: window.__LOTLOGIC_API__,
  };
}

export function isE2E(env = browserEnv()) {
  try {
    if (!env) return false;
    if (PROD_HOSTNAMES.has(env.hostname)) return false;
    return new URLSearchParams(env.search || '').get('e2e') === '1' || env.flag === '1';
  } catch {
    return false;
  }
}

export function e2eApiOverride(env = browserEnv()) {
  if (!isE2E(env)) return null;
  const v = env.override;
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch {
    return null;
  }
}
