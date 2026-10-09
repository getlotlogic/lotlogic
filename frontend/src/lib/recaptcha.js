// ── reCAPTCHA v3 script loader (spec §3.2) ───────────────────
//
// `src/shared/register.js:getRecaptchaToken(action)` reads `window.grecaptcha`
// but deliberately does not load it — visit.html / resident.html / apt.html
// each carry their own `<script src="…/recaptcha/api.js">` tag. The dashboard
// shell cannot: `dashboard.html` serves `/app` as well as `/join`, and only
// `/join` submits a captcha. So the tag is appended here instead, once, from
// SignupPage's mount.
//
// Not an inline `<script>` in dashboard.html: `vercel.json`'s `script-src`
// is `'self' https://www.google.com …` with no `'unsafe-inline'`, so an
// inline loader would report (and, once that report-only header is enforced,
// fail) on every `/join` hit. A tag created by already-allowed bundle code
// is `script-src https://www.google.com`, which the `/join` CSP entry allows.

const SITE_KEY = (typeof document !== 'undefined'
  && document.querySelector('meta[name=recaptcha-site-key]')?.content) || '';

let promise = null;

/**
 * Appends the reCAPTCHA v3 tag exactly once. Resolves whether or not the
 * script actually loads — `getRecaptchaToken` already returns null when
 * `window.grecaptcha` is missing, and the server, not this page, decides
 * what a missing token means.
 * @returns {Promise<void>}
 */
export function loadRecaptcha() {
  if (promise) return promise;
  promise = new Promise((resolve) => {
    if (!SITE_KEY || typeof document === 'undefined') { resolve(); return; }
    if (window.grecaptcha) { resolve(); return; }
    const s = document.createElement('script');
    s.src = `https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(SITE_KEY)}`;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => resolve();
    document.head.appendChild(s);
  });
  return promise;
}
