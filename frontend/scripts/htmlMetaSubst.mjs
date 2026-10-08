// ── `{{PLACEHOLDER}}` substitution for a staged HTML file ────
//
// `build.mjs`'s own string-substitution step for `dashboard.html` (spec
// §3.4a's Google Places loader needs the Maps key in a `<meta
// name="google-maps-key">` tag at build time, from `VITE_GOOGLE_MAPS_KEY` —
// there is no precedent for this in the build: `define` only ever sets
// `NODE_ENV`, and `visit.html`'s `recaptcha-site-key` meta is hardcoded,
// never substituted). Pulled into its own tiny pure module so it's
// `node --test`-able without running the real build.
//
// Unset/empty `value` substitutes an empty string, not the literal
// placeholder — `dashboard.html`'s `<meta name="google-maps-key"
// content="{{GOOGLE_MAPS_KEY}}">` must never ship the literal braces to a
// build that has no key configured; the form's manual-entry fallback is
// what that empty string is for (spec §3.4a).

/**
 * @param {string} html
 * @param {string} name the placeholder's bare name — `{{<name>}}` in the source
 * @param {string|null|undefined} value
 * @returns {string}
 */
export function injectMetaContent(html, name, value) {
  const placeholder = `{{${name}}}`;
  return html.split(placeholder).join(value || '');
}
