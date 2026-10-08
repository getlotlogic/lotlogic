// ── Google Places loader (spec §3.2 field 2 / §3.4a) ─────────
//
// Extracted from AddPropertyForm.jsx (Task 24) so SignupPage's own property
// section (Task 25) mounts the same `<gmp-place-autocomplete>` element from
// the same single script load rather than carrying a second copy of this
// loader — two copies would each hold their own `placesScriptPromise` and
// could append two `<script>` tags for the same library.
//
// The key is read once at module load from the `<meta name="google-maps-key">`
// tag `scripts/build.mjs` substitutes from `VITE_GOOGLE_MAPS_KEY`. Empty when
// the env var is unset, which is exactly when the form must fall back to
// manual entry only — never a hardcoded fallback literal.

export const GOOGLE_MAPS_KEY = (typeof document !== 'undefined'
  && document.querySelector('meta[name=google-maps-key]')?.content) || '';

let placesScriptPromise = null;

/** Loads the Places library's `<gmp-place-autocomplete>` custom element exactly once. */
export function loadPlacesScript() {
  if (!GOOGLE_MAPS_KEY) return Promise.reject(new Error('no Google Maps key configured'));
  if (placesScriptPromise) return placesScriptPromise;
  placesScriptPromise = new Promise((resolve, reject) => {
    if (window.google?.maps?.places) { resolve(); return; }
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(GOOGLE_MAPS_KEY)}&libraries=places&v=weekly&loading=async`;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Google Maps script failed to load'));
    document.head.appendChild(script);
  });
  return placesScriptPromise;
}
