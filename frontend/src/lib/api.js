// ── Rails API fallback ───────────────────────────────────────
export const API = 'https://lotlogic-backend-production.up.railway.app';

// The backend scopes every response to the account whose JWT is presented.
// We stopped shipping the shared service key from the browser as part of the
// property-access-control rollout — clients must now be authenticated as a user.
export function getSessionToken() {
  try {
    const raw = localStorage.getItem('lotlogic_session');
    if (!raw) return null;
    return JSON.parse(raw)?._token ?? null;
  } catch {
    return null;
  }
}

export async function apiFetch(path, options = {}) {
  const token = getSessionToken();
  const headers = { ...(options.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const r = await fetch(API + path, { ...options, headers });
  if (r.status === 401) {
    // Session expired or invalid — clear and force re-login.
    try { localStorage.removeItem('lotlogic_session'); } catch {}
    window.dispatchEvent(new CustomEvent('lotlogic:auth-expired'));
  }
  if (!r.ok) {
    let msg = `Server error (${r.status})`;
    try {
      const body = await r.json();
      // Pydantic 422 returns { detail: [{msg, loc, type, ...}] } — same
      // array-shape bug authLogin already guards against: coercing the
      // array into new Error() renders "[object Object]" to the user.
      if (Array.isArray(body.detail)) {
        const msgs = body.detail.map(d => (d && typeof d === 'object' ? d.msg : String(d))).filter(Boolean);
        if (msgs.length) msg = msgs.join(', ');
      } else if (typeof body.detail === 'string') msg = body.detail;
      else if (body.error) msg = body.error;
    } catch {}
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

export async function authLogin(email, password) {
  const r = await fetch(API + '/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  let body = null;
  try { body = await r.json(); } catch {}
  if (!r.ok) {
    // Pydantic 422 returns { detail: [{msg, loc, type, ...}] }. The old
    // `body?.detail || fallback` path coerced the array to a string in
    // `new Error(...)`, which meant the login form rendered
    // "[object Object]" for every validation failure (e.g. an unparseable
    // email address). Fish out the human-readable `msg` fields when
    // detail is an array; fall back to string detail; last-ditch show
    // a generic "please check your email" message.
    const detail = body && body.detail;
    let pretty;
    if (Array.isArray(detail)) {
      const msgs = detail.map(d => (d && typeof d === 'object' ? d.msg : String(d))).filter(Boolean);
      pretty = msgs.length ? msgs.join(', ') : 'Please check your email and try again.';
    } else if (typeof detail === 'string') {
      pretty = detail;
    } else {
      pretty = `Sign-in failed (${r.status})`;
    }
    const err = new Error(pretty);
    err.status = r.status;
    err.detail = detail;
    throw err;
  }
  return body;
}

export async function authRequestPasswordReset(email) {
  const r = await fetch(API + '/auth/request-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  // We always return ok to the caller — endpoint is intentionally non-revealing.
  try { return await r.json(); } catch { return { ok: true }; }
}
