import React, { useState, useRef, useEffect, useCallback } from 'react';
import { requestsApi } from '../lib/requestsApi.js';
import { manualAddressValid, placeToFields, createPropertyBody } from '../lib/addPropertyFields.js';

// ── Add a property (spec §3.4a) ──────────────────────────────
//
// The property-only fields of the signup form: name, Google Places address
// with a manual fallback, and the duplicate-match card (§3.3). Shared with
// Task 25's SignupPage, which embeds this same component for the property
// section of full account creation.
//
// The only partner-scoping input this form takes from a caller is `slug` —
// a `/join/<slug>` link (Task 25); it's also what unlocks the live
// `/auth/signup/match` duplicate check on place-pick / ZIP blur (§3.3 —
// that endpoint resolves the partner from `slug`, server-side). There is
// deliberately no prop through which a caller can hand this form a partner
// id: spec §8.3 types the create body as `{slug | partner_id:null, …}` —
// `partner_id` can only ever be `null` (the bare-`/join` "Not listed"
// case) — so a client-supplied, non-null `partner_id` is exactly the
// trust-column input the backend design and the global "no route accepts
// partner_id/tenant_id from the client" constraint exist to keep out.
//
// The in-app "Add a property" button (doors (a) in Account and Lots, this
// task) has no `/join/<slug>` context, so it renders this form with no
// `slug` at all — see `createPropertyBody` in `../lib/addPropertyFields.js`,
// which falls back to `partner_id: null` in that case. That's functionally
// the same bare-`/join` "Not listed" flow (the inline duplicate check is
// skipped too, since it also needs a slug — the 409 on submit is the only
// duplicate signal for this door) until a real slug source lands on
// `/auth/me` for door (a) to use instead (see this task's report).
//
// `POST /apartment/properties` is the only write: `{slug | partner_id:null,
// property, force}` → `201 {property}` or `409 duplicate {candidates}`.

// Read once at module load — the meta tag build.mjs substitutes from
// VITE_GOOGLE_MAPS_KEY (dashboard.html). Empty when unset, which is exactly
// when this form must fall back to manual entry only.
const GOOGLE_MAPS_KEY = (typeof document !== 'undefined'
  && document.querySelector('meta[name=google-maps-key]')?.content) || '';

let placesScriptPromise = null;
/** Loads the Places library's `<gmp-place-autocomplete>` custom element exactly once. */
function loadPlacesScript() {
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

const INPUT_STYLE = { padding: '10px 12px', background: 'var(--bg-inset)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-primary)', fontSize: 14, width: '100%', boxSizing: 'border-box' };
const LABEL_STYLE = { display: 'block', fontSize: 11, color: 'var(--text-muted)', fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', marginBottom: 4, marginTop: 10 };
const LINK_BTN_STYLE = { background: 'transparent', border: 'none', color: 'var(--accent)', fontSize: 12, fontWeight: 700, cursor: 'pointer', padding: '6px 0', textAlign: 'left' };

function MatchCard({ title, candidates, onJoin, joiningId, extra }) {
  return (
    <div style={{ background: 'var(--bg-inset)', border: '1px solid var(--border)', borderRadius: 10, padding: 12, marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--text-primary)' }}>{title}</div>
      {candidates.map(c => (
        <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            {c.name}{c.street_line ? ` · ${c.street_line}` : ''}{c.manager_first_name ? ` · managed on LotLogic by ${c.manager_first_name}` : ''}
          </div>
          <button type="button" disabled={joiningId === c.id} onClick={() => onJoin(c.id)}
            style={{ background: 'var(--accent)', color: '#1A1206', border: 'none', borderRadius: 6, padding: '6px 10px', fontSize: 12, fontWeight: 700, cursor: joiningId === c.id ? 'wait' : 'pointer', whiteSpace: 'nowrap' }}>
            {joiningId === c.id ? 'Sending…' : "That's mine — ask to join"}
          </button>
        </div>
      ))}
      {extra}
    </div>
  );
}

export function AddPropertyForm({ slug = null, onSuccess, onJoined, onCancel, submitLabel = 'Add property' }) {
  const [name, setName] = useState('');
  const [manual, setManual] = useState(!GOOGLE_MAPS_KEY);
  const [placesReady, setPlacesReady] = useState(false);
  const [placesFailed, setPlacesFailed] = useState(false);
  const [placeFields, setPlaceFields] = useState(null);
  const [manualFields, setManualFields] = useState({ line1: '', city: '', state: '', zip: '' });
  const [match, setMatch] = useState(null);
  const [matchDismissed, setMatchDismissed] = useState(false);
  const [possibleDuplicateOf, setPossibleDuplicateOf] = useState(null);
  const [duplicateCandidates, setDuplicateCandidates] = useState(null);
  const [joiningId, setJoiningId] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const containerRef = useRef(null);
  const autocompleteElRef = useRef(null);

  // Google Places script — only while in autocomplete mode, only once.
  useEffect(() => {
    if (manual || !GOOGLE_MAPS_KEY) return;
    let cancelled = false;
    loadPlacesScript()
      .then(() => { if (!cancelled) setPlacesReady(true); })
      .catch(() => { if (!cancelled) { setPlacesFailed(true); setManual(true); } });
    return () => { cancelled = true; };
  }, [manual]);

  // Mount <gmp-place-autocomplete> once the script is ready. A plain DOM
  // element (not JSX) — the custom element isn't a known React tag and its
  // properties (`includedRegionCodes`) are set imperatively, same as any
  // other web component wired into a React tree.
  useEffect(() => {
    if (!placesReady || manual) return;
    const container = containerRef.current;
    if (!container) return;
    let el;
    try {
      el = document.createElement('gmp-place-autocomplete');
      el.includedRegionCodes = ['us'];
    } catch {
      setPlacesFailed(true);
      setManual(true);
      return;
    }
    container.innerHTML = '';
    container.appendChild(el);
    autocompleteElRef.current = el;

    async function onSelect(ev) {
      try {
        const prediction = ev?.placePrediction;
        const place = prediction?.toPlace ? prediction.toPlace() : null;
        if (place?.fetchFields) {
          await place.fetchFields({ fields: ['formattedAddress', 'location', 'id'] });
        }
        const fields = placeToFields(place);
        if (fields) {
          setPlaceFields(fields);
          setPossibleDuplicateOf(null);
          checkMatch({ place_id: fields.place_id });
        }
      } catch {
        // Leave the field alone — the operator can retry the pick or
        // switch to manual entry; this never blocks typing a name.
      }
    }
    el.addEventListener('gmp-select', onSelect);
    return () => { el.removeEventListener('gmp-select', onSelect); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placesReady, manual]);

  // §3.3: inline duplicate check on place pick and on manual-ZIP blur.
  // Best-effort — a failure here never blocks the form; the 409 on submit
  // is the backstop. Needs `slug` (the endpoint resolves the partner from
  // it); the in-app door (no slug) skips this and relies on that backstop.
  const checkMatch = useCallback(async ({ place_id = null, address_line1 = null, postal_code = null }) => {
    if (!slug) return;
    try {
      const res = await requestsApi.signupMatch({ slug, name: name || undefined, place_id, address_line1, postal_code });
      const candidates = Array.isArray(res?.candidates) ? res.candidates : [];
      setMatch(candidates[0] || null);
      setMatchDismissed(false);
    } catch { /* best-effort */ }
  }, [slug, name]);

  function onManualZipBlur() {
    if (manualAddressValid(manualFields)) {
      checkMatch({ address_line1: manualFields.line1, postal_code: manualFields.zip });
    }
  }

  async function joinInstead(propertyId) {
    setJoiningId(propertyId);
    setError('');
    try {
      await requestsApi.joinProperty(propertyId);
      onJoined && onJoined(propertyId);
    } catch (e) {
      setError(e.message || 'Could not send the join request — try again.');
    } finally {
      setJoiningId(null);
    }
  }

  function buildPropertyBody() {
    const base = { name: name.trim(), possible_duplicate_of: possibleDuplicateOf };
    if (manual) {
      const line1 = manualFields.line1.trim();
      const city = manualFields.city.trim();
      const state = manualFields.state.trim().toUpperCase();
      const zip = manualFields.zip.trim();
      return { ...base, address: `${line1}, ${city}, ${state} ${zip}`, address_line1: line1, city, state, postal_code: zip };
    }
    return { ...base, address: placeFields?.address || '', place_id: placeFields?.place_id || null, lat: placeFields?.lat ?? null, lng: placeFields?.lng ?? null };
  }

  async function submit(force) {
    setSubmitting(true);
    setError('');
    try {
      const body = createPropertyBody({ slug, property: buildPropertyBody(), force });
      const res = await requestsApi.createApartmentProperty(body);
      setDuplicateCandidates(null);
      onSuccess && onSuccess(res?.property || res);
    } catch (e) {
      if (e.code === 'duplicate' && Array.isArray(e.body?.candidates)) {
        setDuplicateCandidates(e.body.candidates);
      } else {
        setError(e.message || 'Could not add the property — try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  function handleSubmit(e) {
    e.preventDefault();
    if (submitting) return;
    if (!name.trim()) { setError('Property name is required.'); return; }
    if (manual && !manualAddressValid(manualFields)) { setError('Enter a complete address.'); return; }
    if (!manual && !placeFields) { setError('Pick an address, or enter it manually.'); return; }
    submit(false);
  }

  const canSubmit = name.trim().length > 0 && (manual ? manualAddressValid(manualFields) : !!placeFields) && !submitting;

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={{ ...LABEL_STYLE, marginTop: 0 }}>Property name</label>
      <input value={name} onChange={e => setName(e.target.value)} placeholder="Sunset Ridge Apartments" required style={INPUT_STYLE} />

      <label style={LABEL_STYLE}>Property address</label>
      {!manual ? (
        <>
          <div ref={containerRef} style={{ minHeight: 40 }}>
            {!placesReady && !placesFailed && (
              <input disabled placeholder="Loading address lookup…" style={{ ...INPUT_STYLE, opacity: 0.6 }} />
            )}
          </div>
          {placeFields?.address && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>{placeFields.address}</div>
          )}
          <button type="button" onClick={() => setManual(true)} style={LINK_BTN_STYLE}>Enter it manually</button>
        </>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <input value={manualFields.line1} onChange={e => setManualFields({ ...manualFields, line1: e.target.value })} placeholder="Street address" style={INPUT_STYLE} />
          <input value={manualFields.city} onChange={e => setManualFields({ ...manualFields, city: e.target.value })} placeholder="City" style={INPUT_STYLE} />
          <div style={{ display: 'flex', gap: 6 }}>
            <input value={manualFields.state} onChange={e => setManualFields({ ...manualFields, state: e.target.value.toUpperCase() })} placeholder="State" maxLength={2} style={{ ...INPUT_STYLE, width: 70 }} />
            <input value={manualFields.zip} onChange={e => setManualFields({ ...manualFields, zip: e.target.value })} onBlur={onManualZipBlur} placeholder="ZIP" style={INPUT_STYLE} />
          </div>
          {GOOGLE_MAPS_KEY && !placesFailed && (
            <button type="button" onClick={() => setManual(false)} style={LINK_BTN_STYLE}>Use address lookup instead</button>
          )}
        </div>
      )}

      {match && !matchDismissed && (
        <MatchCard
          title="Is this your property?"
          candidates={[match]}
          onJoin={joinInstead}
          joiningId={joiningId}
          extra={(
            <button type="button" onClick={() => { setPossibleDuplicateOf(match.id); setMatchDismissed(true); }} style={LINK_BTN_STYLE}>
              No, mine is different
            </button>
          )}
        />
      )}

      {duplicateCandidates && duplicateCandidates.length > 0 && (
        <MatchCard
          title="That property may already exist"
          candidates={duplicateCandidates}
          onJoin={joinInstead}
          joiningId={joiningId}
          extra={(
            <button type="button" disabled={submitting} onClick={() => submit(true)}
              style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px', fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', cursor: submitting ? 'wait' : 'pointer', alignSelf: 'flex-start' }}>
              Add it anyway
            </button>
          )}
        />
      )}

      {error && <div style={{ color: '#f87171', fontSize: 12, marginTop: 8 }}>{error}</div>}

      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        {onCancel && (
          <button type="button" onClick={onCancel} style={{ flex: 1, padding: '10px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-faint)', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>Cancel</button>
        )}
        {/* `--accent` is a light gold in the dark theme (#FBBF24) — '#1A1206'
            is the dark-ink pairing used elsewhere against the same token
            (AccountPage's Save button); white text here fails contrast. */}
        <button type="submit" disabled={!canSubmit} style={{ flex: 2, padding: '10px', background: 'var(--accent)', color: '#1A1206', border: 'none', borderRadius: 8, fontWeight: 700, cursor: canSubmit ? 'pointer' : 'default', opacity: canSubmit ? 1 : 0.6, fontFamily: 'inherit' }}>
          {submitting ? 'Adding…' : submitLabel}
        </button>
      </div>
    </form>
  );
}
