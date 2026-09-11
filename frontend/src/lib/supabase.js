import { createClient } from '@supabase/supabase-js';

// ── Supabase client ──────────────────────────────────────────
export const SUPABASE_URL = 'https://nzdkoouoaedbbccraoti.supabase.co';
export const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im56ZGtvb3VvYWVkYmJjY3Jhb3RpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxMzg2OTQsImV4cCI6MjA4ODcxNDY5NH0.WrlTCKEmmziBUX1E9vBmBpHRSg7_RRKBLIxSPKy189E';

// Mutable token ref. _supabaseFetch injects this into every request so the
// RLS policies on visitor_passes / resident_plates / scoped tables see the
// owner_id / partner_id claim from the backend-signed JWT.
//
// setSession() is unusable here — it calls /auth/v1/user to validate the
// token, which 403s because our backend signs JWTs outside of Supabase
// Auth. A silent validation failure drops the session, so every request
// falls back to the anon key. Patching rest.headers post-hoc also doesn't
// work: supabase.from() spreads those headers into a fresh object per call,
// so mutations after init never propagate. A custom global.fetch reads the
// current token on each outbound request, which is the only path that works.
export let _supabaseToken = null;
export function _supabaseFetch(input, init) {
  if (_supabaseToken) {
    const h = new Headers((init && init.headers) || (input && input.headers) || {});
    h.set('Authorization', 'Bearer ' + _supabaseToken);
    return fetch(input, { ...(init || {}), headers: h });
  }
  return fetch(input, init);
}
export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { global: { fetch: _supabaseFetch } });

export function applySupabaseAuth(token) {
  _supabaseToken = token || null;
  try { supabase?.realtime?.setAuth?.(token || null); } catch {}
}

// Apply on initial load so a refresh keeps Supabase authenticated.
try {
  const existing = JSON.parse(localStorage.getItem('lotlogic_session') || 'null');
  if (existing?._token) applySupabaseAuth(existing._token);
} catch {}
