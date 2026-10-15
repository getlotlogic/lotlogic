// ── Shared layer for the three public registration pages ───────────────────
// visit.html, resident.html, apt.html (Task 17 / FAT-18, FE-11, BACKEND-15).
// These three pages were 73%/69%/42% pairwise-duplicate copy-paste of the
// same ten-ish helper functions — see docs/frontend-baseline-2026-09-07.md
// section 3. This module is the behaviour-preserving extraction: where the
// three original implementations were byte-identical, the function just
// moved. Where they differed, each divergence is called out below with what
// was chosen and why. Full snippets of every divergence are in
// task-17-report.md.
//
// NOT here: `showSuccess` and `init`. `init` is genuinely different
// per-page control flow (different columns to fetch, different fallback
// navigation) and was never a real duplicate target. `showSuccess` LOOKS
// like a shared name (all three files define a function called
// `showSuccess`) but the three bodies are not a superset of one another —
// different argument shapes (resident.html takes a bare plate string; the
// other two take an options object with non-overlapping fields), different
// CSS classes (`success-plate` vs `success-ref`), different copy for
// plaza/apartment/resident-request/guest paths. Per the "ambiguous → do not
// guess, keep a per-page override" rule, `showSuccess` stays defined
// per-page, verbatim, in each entry file. See task-17-report.md.
//
// Also NOT here: the pay-to-park branch (`handlePlazaPaySubmit`,
// `handlePlazaReturn`, `plazaFetchStatus`, `plazaIdempotencyKey`,
// `plazaFormSig`, `plazaClearIdempotencyKeys`, `plazaForgetIdempotencyKey`,
// `plazaSpentKeyKind`, `plazaMoney`, `plazaLogoHtml`,
// `plazaPayErrorMessage`, `payToParkOn`, `showPlaza*`) — moves into
// src/visit.js verbatim, untouched, per the task brief.

// Raw fetch against Supabase PostgREST + Storage, not the supabase-js SDK:
// createClient() auto-opens a realtime WebSocket that can hang on strict
// networks / extensions and leave the page stuck on "Loading...". Constants
// were byte-identical across all three original files.
export const SUPABASE_URL = 'https://nzdkoouoaedbbccraoti.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im56ZGtvb3VvYWVkYmJjY3Jhb3RpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxMzg2OTQsImV4cCI6MjA4ODcxNDY5NH0.WrlTCKEmmziBUX1E9vBmBpHRSg7_RRKBLIxSPKy189E';
// Backend base — anon role can't write (or, for visit.html's pre-flight
// check, even read) certain tables directly; those calls route through the
// backend's public endpoints instead.
export const BACKEND_URL = 'https://lotlogic-backend-production.up.railway.app';

// reCAPTCHA v3 site key. Public value by Google's design — security relies
// only on the server-side RECAPTCHA_SECRET_KEY. Mirrored in each page's
// <meta name="recaptcha-site-key"> tag (which stays in the HTML — the
// pages still load the reCAPTCHA script tag themselves).
export const RECAPTCHA_SITE_KEY =
  (document.querySelector('meta[name=recaptcha-site-key]')?.content)
  || '6LdaAb4sAAAAACd5g-pYqnQBWHdvMmGCufwtEQnE';

// REGION_TOKENS and normalizePlate live in ./plate.js (pure, no DOM) so the
// /apt/ flow model and Node tests can import them; re-exported unchanged.
export { REGION_TOKENS, normalizePlate } from './plate.js';

// Byte-identical in visit.html and apt.html. resident.html never defined
// this function at all — it sends the raw trimmed phone value to the
// backend. Sharing it here doesn't change resident.js: resident.js simply
// doesn't call it, exactly as resident.html never did.
export function normalizePhone(s) {
  const digits = (s || '').replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  if (digits.startsWith('+')) return s;
  return digits ? ('+' + digits) : '';
}

// DIVERGENCE (superset): visit.html's newIdempotencyKey() only set the
// outer `idempotencyKey` module variable as a side effect and returned
// nothing; apt.html's version did the same AND returned the value.
// resident.html had no idempotency key at all (its one write endpoint,
// /resident_plates/register, doesn't accept one). Taking apt.html's
// return-value version as the superset — a pure generator with no shared
// mutable state, since a shared module holding page-owned mutable state
// would be the wrong shape here. Each entry file that needs it (visit.js,
// apt.js) keeps its own local `let idempotencyKey = null;` and assigns
// `idempotencyKey = newIdempotencyKey();`, reproducing the exact prior
// side effect explicitly instead of implicitly.
export function newIdempotencyKey() {
  return (crypto.randomUUID && crypto.randomUUID()) ||
    (Date.now().toString(36) + '-' + Math.random().toString(36).slice(2));
}

// Byte-identical across all three original files.
export async function pgRest(path, init = {}, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(SUPABASE_URL + '/rest/v1' + path, {
      ...init,
      signal: ctrl.signal,
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const err = new Error((body && body.message) || ('HTTP ' + res.status));
      err.code = body && body.code;
      err.details = body && body.details;
      err.status = res.status;
      throw err;
    }
    return body;
  } finally { clearTimeout(t); }
}

// POST to one of the public /register endpoints. Normalizes errors so
// callers can dispatch on err.status and err.detail. reCAPTCHA rejects come
// back as 400 with detail "recaptcha:<reason>"; a single friendly string is
// surfaced to the user (never log the token itself).
//
// DIVERGENCE (ambiguous — no superset, kept as a per-page override):
// visit.html and resident.html defaulted timeoutMs to 12000; apt.html
// defaulted it to 15000 (its uploads take longer). Every call site in all
// three files relies on the default rather than passing an explicit value,
// so this is a real behavioural difference, not incidental. The default
// here matches the 2-of-3 majority (12000); apt.js passes 15000 explicitly
// at each of its two call sites to preserve its original timeout.
export async function backendRegister(path, payload, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(BACKEND_URL + path, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const detail = body && (body.detail || body.message);
      const err = new Error(typeof detail === 'string' ? detail : ('HTTP ' + res.status));
      err.status = res.status;
      err.detail = detail;
      // The whole answer: a 400 can carry extras beside `detail` (apt.js reads
      // vehicle_required's "missing" list from here).
      err.body = body;
      throw err;
    }
    return body;
  } finally { clearTimeout(t); }
}

// Fetch a fresh reCAPTCHA v3 token for the given action. Returns null on
// script-load failure so the caller can decide whether to hard-fail or
// continue. Byte-identical across all three original files. The pages
// still load the reCAPTCHA <script> tag themselves — that stays in the
// HTML, this function just reads window.grecaptcha.
export async function getRecaptchaToken(action) {
  if (!window.grecaptcha || typeof grecaptcha.ready !== 'function') {
    return null;
  }
  return new Promise((resolve, reject) => {
    try {
      grecaptcha.ready(() => {
        grecaptcha.execute(RECAPTCHA_SITE_KEY, { action }).then(resolve, reject);
      });
    } catch (err) {
      reject(err);
    }
  });
}

// Translate a backend error into a message the driver/resident should see.
// reCAPTCHA failures → generic retry message (don't leak the reason).
// Byte-identical across all three original files.
export function friendlyErrorMessage(err) {
  const msg = (err && err.message) || '';
  if (msg.startsWith('recaptcha:') || /automated-access check failed/i.test(msg)) {
    return 'Please retry — automated-access check failed.';
  }
  if (err && err.name === 'AbortError') {
    return 'Request timed out. Please try again.';
  }
  return msg || 'Something went wrong. Please try again.';
}

// DIVERGENCE (superset, cosmetic only — identical rendered output):
// visit.html and resident.html each inlined this exact SVG+wordmark markup
// directly inside showNotFound/showConnectionError; apt.html had already
// factored it into its own logoHtml() helper and called `${logoHtml()}`.
// Adopting apt.html's extraction — it produces byte-identical DOM, just
// without three separate copies of the SVG path data.
export function logoHtml() {
  return `
    <div class="logo">
      <div class="shield"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#1F1B14" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M9 10h2a2 2 0 0 1 0 4H9zm0 0v4"/></svg></div>
      <h1>LotL<span>o</span>gic</h1>
    </div>`;
}

// Byte-identical across all three original files (once built on logoHtml()
// above — see the divergence note there).
export function showNotFound(title, message) {
  document.getElementById('app').innerHTML = `
    ${logoHtml()}
    <div class="not-found">
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(message)}</p>
    </div>
  `;
}

// Byte-identical across all three original files (once built on logoHtml()
// above), EXCEPT the retry button's callback: each page's original called
// its own `init()` directly by closure. Since `init` is page-specific and
// not part of this shared module, `retry` is passed in explicitly — every
// call site becomes `showConnectionError(err, init)`, which reproduces the
// exact original "Try again" behaviour.
export function showConnectionError(err, retry) {
  const detail = err && (err.name === 'AbortError' ? 'Request timed out.' : (err.message || 'Network error.'));
  const app = document.getElementById('app');
  app.innerHTML = `
    ${logoHtml()}
    <div class="not-found">
      <h2>Can't reach our server.</h2>
      <p>${escapeHtml(detail)}</p>
      <p>Check your connection — then give it another go.</p>
      <button id="retryBtn" class="submit-btn" style="margin-top:18px">Try again →</button>
    </div>
  `;
  const btn = document.getElementById('retryBtn');
  if (btn) btn.addEventListener('click', () => {
    app.innerHTML = '<div class="loading-state">Loading the form…</div>';
    retry();
  });
}

// DIVERGENCE (superset — apt.html's version handles more inputs without
// throwing): visit.html and resident.html were `div.textContent = str;`
// with no guard; apt.html was `div.textContent = str == null ? '' : str;`.
// Taking apt.html's guarded version for all three — it is a strict
// superset (every input the unguarded version handled, it also handles;
// `null`/`undefined` additionally render as empty string instead of the
// literal text "null"/coercion behaviour) and no call site in any of the
// three pages ever relied on str being null/undefined turning into a
// visible string.
export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : str;
  return div.innerHTML;
}

// Only visit.html had this constant and helper — resident.html and
// apt.html each inlined their own (shorter) column list directly in their
// `pgRest(`/properties?select=...`)` call. `pay_to_park_enabled` is asked
// for separately in visit.js because the anon column grant may not include
// it yet on an older DB — asking wide and re-asking narrow on any HTTP
// error keeps a schema drift from taking the FREE registration form down
// with it (see visit.js's loadPropertyRow). propertyQuery is parameterized
// on `columns` so resident.js and apt.js can build their own (shorter)
// query the same way instead of hand-concatenating the string themselves.
export const PROPERTY_COLUMNS = 'id,name,address,property_type,policy_text,policy_phone';

export function propertyQuery(qrCodeId, columns) {
  return `/properties?select=${columns}&qr_code_id=eq.${encodeURIComponent(qrCodeId)}&limit=1`;
}

// The apartment entry's pure helpers (?role= -> first screen, the /apt/
// address) live in ./aptEntry.js, which touches no DOM while loading and so can
// also be imported by Node tests and by the dashboard. Re-exported here so the
// three public pages keep a single import source.
export { initialScreenForRole, aptEntryUrl, groupQuery, groupRows, isGroup, groupEntryUrl } from './aptEntry.js';
