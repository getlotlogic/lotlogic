import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { requestsApi } from '../lib/requestsApi.js';
import { authRequestPasswordReset } from '../lib/api.js';
import { getRecaptchaToken } from '../shared/register.js';
import { loadRecaptcha } from '../lib/recaptcha.js';
import { GOOGLE_MAPS_KEY, loadPlacesScript } from '../lib/places.js';
import { placeToFields, manualAddressValid } from '../lib/addPropertyFields.js';
import { AddPropertyForm } from '../ui/AddPropertyForm.jsx';
import { RoleChips } from '../ui/RoleChips.jsx';
import { PhoneInput } from '../ui/PhoneInput.jsx';
import { PasswordField } from '../ui/PasswordField.jsx';
import { VerifyEmailSheet } from './property/VerifyEmailSheet.jsx';
import {
  ERR, ROLES, DRAFT_KEY,
  propertyNameError, fullNameError, emailError, normalizeEmail,
  phoneError, toE164US, passwordError, roleError, positionFor,
  addressError,
  serializeDraft, readDraft, fieldErrorsFrom422,
} from '../lib/signupValidation.js';

// ── Public signup — `/join/<slug>` (spec §3.1–§3.4, §5.1) ────
//
// One scrolling page, seven fields, no Continue taps. Rendered from the
// dashboard bundle (`App.jsx`'s `publicRoute === 'join'` branch), reusing
// `.login-box` / `.field-*` / `.login-btn` / `.login-error` and the theme,
// so the page costs no new CSS beyond the `.signup-*` block in
// dashboard.html.
//
// Three modes, one component:
//   mode="signup"        (default) full account creation → POST /auth/signup
//   mode="add-property"  a signed-in manager opened someone's /join link
//                        (spec §3.2) → the property section only, via
//                        AddPropertyForm → POST /apartment/properties
//   bare `/join`         no slug: one question first ("Who tows your
//                        property?") — partner chips + Not listed (§3.1)
//
// Validation timing (spec §3.2, https://baymard.com/blog/inline-form-validation):
// on blur; live only after a field's own first error; never on an untouched
// field. `live` enforces both: a field goes live only when a blur (or a
// submit) finds an error in it, and only a live field shows its message.
//
// The submit button is always enabled and carries `aria-busy` while in
// flight (https://adamsilver.io/blog/the-problem-with-disabled-buttons-and-what-to-do-instead/).

// Spec §5.1 header line: "N Style Towing uses LotLogic for parking
// requests. About a minute."
const headerLine = (partnerName) => `${partnerName} uses LotLogic for parking requests. About a minute.`;

const ERR_INVALID_SLUG = "This link isn't valid. Ask your tow company for a new one.";
const ERR_NETWORK = "Can't reach LotLogic right now — your answers are saved. Try again.";
const ERR_THROTTLED = 'Too many tries from this network. Wait a few minutes.';

const HELP_PHONE = (partnerName) => `${partnerName} calls this number if they have a question about a request.`;
const HELP_PASSWORD = 'At least 12 characters. A short sentence works.';

/** The session shape `login()` stores, built from a `/auth/*` token body. */
function sessionFromAuth(res, fallbackEmail) {
  const base = (res && res.subject) || {};
  const role = base.type === 'partner' ? 'partner' : 'owner';
  return {
    id: base.id,
    email: base.email || fallbackEmail,
    business_name: base.display_name,
    company_name: role === 'partner' ? base.display_name : undefined,
    is_admin: !!base.is_admin,
    is_platform_admin: !!base.is_platform_admin,
    // A self-serve signup is unverified by construction (spec §3.5) — the
    // banner and the You're-in card's code line both key on this.
    email_verified: !!base.email_verified,
    signup_source: base.signup_source || 'self_serve',
    email_verify_sent_at: base.email_verify_sent_at || new Date().toISOString(),
    _role: role,
    _token: res && res.token,
    _expires_in: res && res.expires_in,
  };
}

/** `?src=` (a campaign / QR tag, spec §3.2 hidden fields), else 'join'. */
function readSrc() {
  try {
    const v = new URLSearchParams(window.location.search).get('src');
    return (v && v.trim()) || 'join';
  } catch { return 'join'; }
}

function readStoredDraft() {
  let raw = null;
  try { raw = sessionStorage.getItem(DRAFT_KEY); } catch { return null; }
  const d = readDraft(raw);
  // "cleared on success or after 24 h" — `readDraft` refuses an expired one;
  // this is what actually takes it out of storage rather than leaving a dead
  // key behind for the rest of the session.
  if (!d && raw != null) clearStoredDraft();
  return d;
}
function clearStoredDraft() {
  try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* blocked storage */ }
}

// One wrapper for every state of this page. Defined at MODULE scope on
// purpose: an inline `const Shell = …` inside the component would be a new
// component identity on every render, which remounts the whole form — and
// the input the thumb is in — on every keystroke.
function Shell({ children, title, sub, theme, onToggleTheme }) {
  return (
    <div className="login-page" role="main">
      <div className="login-box signup-box">
        <div className="signup-topbar">
          <div className="login-logo" aria-hidden="true">
            <div className="login-shield">LL</div>
            <div className="login-wordmark">Lot<span>Logic</span></div>
          </div>
          {onToggleTheme && (
            <button type="button" className="signup-theme-btn" onClick={onToggleTheme}
              aria-label={theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'}>
              <span aria-hidden="true">{theme === 'dark' ? '☼' : '◐'}</span>
            </button>
          )}
        </div>
        <h1 className="signup-h1">{title}</h1>
        {sub && <p className="signup-sub">{sub}</p>}
        {children}
      </div>
    </div>
  );
}

export function SignupPage({ slug = null, mode = 'signup', onDone, theme, onToggleTheme }) {
  const addProperty = mode === 'add-property';

  // reCAPTCHA v3: appended here, not from dashboard.html, so `/app` never
  // pays for it (spec §3.2 hidden fields; see lib/recaptcha.js). Mount-time,
  // not submit-time, so the token is ready the moment the button is tapped.
  useEffect(() => { if (!addProperty) loadRecaptcha(); }, [addProperty]);

  // ── Draft read ONCE, before any state exists (spec §3.2 "Draft kept in
  // sessionStorage") ──
  // The field state below is seeded from it through lazy initialisers. A
  // restore *effect* cannot do this: the save effect runs on the same first
  // commit and would write the empty form over the stored draft before any
  // restore could read it — which is exactly what a reload, or Back from the
  // sign-in detour, used to hit. A draft parked for a different partner's
  // link is not restored into this one.
  const [draft] = useState(() => {
    const d = readStoredDraft();
    if (!d) return null;
    if (slug && d.slug && d.slug !== slug) return null;
    return d;
  });
  const fromDraft = addProperty ? null : draft;

  // ── Partner context (spec §3.1) ────────────────────────────
  // A bare `/join` that already picked a partner (and then reloaded) goes
  // back to that partner's form, not to the question.
  const [chosenSlug, setChosenSlug] = useState(() => slug || fromDraft?.slug || null);
  const [notListed, setNotListed] = useState(false);
  const [ctx, setCtx] = useState(null);           // { partner, partners }
  // loading | ready | invalid | throttled | offline
  const [ctxState, setCtxState] = useState(addProperty ? 'ready' : 'loading');
  // "Try again" bumps this: re-setting `chosenSlug` to the value it already
  // holds is a no-op to React, so the effect would never run again.
  const [ctxReloadKey, setCtxReloadKey] = useState(0);
  useEffect(() => {
    // Add-property mode renders AddPropertyForm alone and never reads the
    // context, so it does not pay for (or get throttled by) the call.
    if (addProperty) return undefined;
    let live = true;
    setCtxState('loading');
    requestsApi.signupContext(chosenSlug || undefined).then((res) => {
      if (!live) return;
      setCtx(res || {});
      // A slug that resolves to no partner is a dead link, not an empty page.
      if (chosenSlug && !res?.partner) setCtxState('invalid');
      else setCtxState('ready');
    }).catch((e) => {
      if (!live) return;
      if (e.status === 404 || e.code === 'unknown_slug' || e.code === 'signup_disabled') setCtxState('invalid');
      else if (e.status === 429) setCtxState('throttled');
      else setCtxState('offline');
    });
    return () => { live = false; };
  }, [addProperty, chosenSlug, ctxReloadKey]);

  const partnerName = ctx?.partner?.name || 'your tow company';
  const partners = Array.isArray(ctx?.partners) ? ctx.partners : [];

  // ── The seven fields ───────────────────────────────────────
  const d0 = fromDraft || {};
  const [name, setName] = useState(() => d0.name || '');
  const [manual, setManual] = useState(() => !GOOGLE_MAPS_KEY || d0.manual === true);
  const [placesReady, setPlacesReady] = useState(false);
  const [placesFailed, setPlacesFailed] = useState(false);
  const [placeFields, setPlaceFields] = useState(() => d0.placeFields || null);
  const [manualFields, setManualFields] = useState(() => ({
    line1: '', city: '', state: '', zip: '', ...(d0.manualFields || {}),
  }));
  const [contactName, setContactName] = useState(() => d0.contactName || '');
  const [role, setRole] = useState(() => d0.role || null);
  const [roleOther, setRoleOther] = useState(() => d0.roleOther || '');
  const [email, setEmail] = useState(() => d0.email || '');
  const [phone, setPhone] = useState(() => d0.phone || '');
  const [password, setPassword] = useState('');

  // §3.3 — the duplicate card, and the join branch it can switch the form to.
  const [match, setMatch] = useState(null);
  const [matchDismissed, setMatchDismissed] = useState(false);
  const [joinProperty, setJoinProperty] = useState(null); // {id, name, street_line}
  const [possibleDuplicateOf, setPossibleDuplicateOf] = useState(null);

  // Validation bookkeeping: `live` gates every message. A field goes live
  // the first time it is measured with an error in it (on blur, or by a
  // submit) and stays live from then on, so its message tracks every
  // keystroke. A field blurred while VALID stays quiet if it is later
  // edited back into an error — until the next blur says so.
  const [live, setLive] = useState({});
  const [serverFields, setServerFields] = useState({});
  const [summary, setSummary] = useState([]);       // the 422 summary lines
  const [formError, setFormError] = useState('');   // network / 429 / unexpected
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState(null);     // null | 'check_email' | 'verify_email'
  const [resetSent, setResetSent] = useState(false);
  const summaryRef = useRef(null);
  // Move focus to the summary once it is in the DOM (GOV.UK validation
  // pattern). An effect on the committed summary, not a requestAnimationFrame
  // from the submit handler: rAF is paused in a background tab, so the focus
  // move could silently never happen.
  useEffect(() => {
    if (summary.length) summaryRef.current?.focus();
  }, [summary]);

  // ── Draft (spec §3.2 "Draft kept in sessionStorage", §3.4a (c)) ──
  // Property + account fields only; `serializeDraft` is built on an
  // allowlist so the password cannot reach sessionStorage even by accident.
  useEffect(() => {
    if (addProperty) return;
    const payload = serializeDraft({
      slug: chosenSlug, name, manual, manualFields, placeFields,
      contactName, role, roleOther, email, phone,
      joinPropertyId: joinProperty?.id || null,
    });
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(payload)); } catch { /* blocked storage */ }
  }, [addProperty, chosenSlug, name, manual, manualFields, placeFields,
    contactName, role, roleOther, email, phone, joinProperty]);

  // ── Google Places (spec §3.2 field 2) ──────────────────────
  const containerRef = useRef(null);
  useEffect(() => {
    if (addProperty || manual || !GOOGLE_MAPS_KEY) return;
    let cancelled = false;
    loadPlacesScript()
      .then(() => { if (!cancelled) setPlacesReady(true); })
      .catch(() => { if (!cancelled) { setPlacesFailed(true); setManual(true); } });
    return () => { cancelled = true; };
  }, [addProperty, manual]);

  const checkMatch = useCallback(async (args) => {
    const { place_id = null, address_line1 = null, postal_code = null } = args || {};
    if (!chosenSlug) return; // the endpoint resolves the partner from the slug
    try {
      const res = await requestsApi.signupMatch({
        slug: chosenSlug, name: name || undefined, place_id, address_line1, postal_code,
      });
      const candidates = Array.isArray(res?.candidates) ? res.candidates : [];
      setMatch(candidates[0] || null);
      setMatchDismissed(false);
    } catch { /* best-effort — never blocks the form */ }
  }, [chosenSlug, name]);

  useEffect(() => {
    if (addProperty || !placesReady || manual) return;
    const container = containerRef.current;
    if (!container) return;
    let el;
    try {
      el = document.createElement('gmp-place-autocomplete');
      el.includedRegionCodes = ['us'];
    } catch {
      setPlacesFailed(true); setManual(true); return;
    }
    container.innerHTML = '';
    container.appendChild(el);
    async function onSelect(ev) {
      try {
        const prediction = ev?.placePrediction;
        const place = prediction?.toPlace ? prediction.toPlace() : null;
        if (place?.fetchFields) await place.fetchFields({ fields: ['formattedAddress', 'location', 'id'] });
        const fields = placeToFields(place);
        if (fields) {
          setPlaceFields(fields);
          setPossibleDuplicateOf(null);
          checkMatch({ place_id: fields.place_id });
        }
      } catch { /* leave the field alone; manual entry is always available */ }
    }
    el.addEventListener('gmp-select', onSelect);
    return () => { el.removeEventListener('gmp-select', onSelect); };
  }, [addProperty, placesReady, manual, checkMatch]);

  // ── Errors ─────────────────────────────────────────────────
  const joining = !!joinProperty;
  const errors = useMemo(() => ({
    propertyName: joining ? null : propertyNameError(name),
    address: joining ? null : addressError({ manual, manualFields, placeFields }),
    fullName: fullNameError(contactName),
    role: roleError(role, roleOther),
    email: emailError(email),
    phone: phoneError(phone),
    password: passwordError(password),
  }), [joining, name, manual, manualFields, placeFields, contactName, role, roleOther, email, phone, password]);

  /** The message to render under a field: server message first, then local. */
  const shown = (key) => serverFields[key] || (live[key] ? errors[key] : null) || null;
  const errId = (key) => `signup-${key}-error`;

  function blur(key) {
    if (errors[key]) setLive(l => (l[key] ? l : { ...l, [key]: true }));
    setServerFields(s => (s[key] ? { ...s, [key]: undefined } : s));
  }

  function onManualZipBlur() {
    blur('address');
    if (manualAddressValid(manualFields)) {
      checkMatch({ address_line1: manualFields.line1, postal_code: manualFields.zip });
    }
  }

  // ── Submit (spec §3.4) ─────────────────────────────────────
  async function submit(e) {
    e.preventDefault();
    if (submitting) return;
    setFormError(''); setSummary([]); setServerFields({});

    const allKeys = ['propertyName', 'address', 'fullName', 'role', 'email', 'phone', 'password'];
    setLive(Object.fromEntries(allKeys.map(k => [k, true])));
    const local = allKeys.map(k => errors[k]).filter(Boolean);
    if (local.length) {
      setSummary(local);
      return;
    }

    setSubmitting(true);
    // reCAPTCHA v3, action `property_signup` (spec §3.2 hidden fields). A
    // null token (script blocked, offline) is sent as-is: the server decides,
    // and this page must not refuse to submit on a client-side signal.
    const recaptchaToken = await getRecaptchaToken('property_signup').catch(() => null);
    const property = joining
      ? { id: joinProperty.id }
      : buildProperty();
    const body = {
      slug: chosenSlug || null,
      recaptcha_token: recaptchaToken,
      client_tz: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return null; } })(),
      src: readSrc(),
      account: {
        contact_name: contactName.trim(),
        email: normalizeEmail(email),
        phone: toE164US(phone),
        position: positionFor(role, roleOther),
        password,
      },
      property,
    };

    try {
      const res = await requestsApi.signup(body);
      handleSignupResponse(res);
    } catch (err) {
      handleSignupError(err);
    } finally {
      setSubmitting(false);
    }
  }

  function buildProperty() {
    const base = { name: name.trim(), possible_duplicate_of: possibleDuplicateOf };
    if (manual) {
      const line1 = manualFields.line1.trim();
      const city = manualFields.city.trim();
      const state = manualFields.state.trim().toUpperCase();
      const zip = manualFields.zip.trim();
      return { ...base, address: `${line1}, ${city}, ${state} ${zip}`, address_line1: line1, city, state, postal_code: zip };
    }
    return {
      ...base,
      address: placeFields?.address || '',
      place_id: placeFields?.place_id || null,
      lat: placeFields?.lat ?? null,
      lng: placeFields?.lng ?? null,
    };
  }

  function handleSignupResponse(res) {
    const next = res?.next;
    if (next === 'check_email') { setOutcome('check_email'); return; }   // draft kept
    if (next === 'verify_email') { setOutcome('verify_email'); return; } // SIGNUP_VERIFY_FIRST
    const session = sessionFromAuth(res, normalizeEmail(email));
    clearStoredDraft();
    if (next === 'pending_membership') { onDone?.(session); return; }
    // next === 'property'
    const url = res?.property_id
      ? `/app?property=${encodeURIComponent(res.property_id)}&section=requests&firstrun=1`
      : '/app';
    onDone?.(session, { url });
  }

  function handleSignupError(err) {
    if (err.status === 422) {
      const { fields, messages } = fieldErrorsFrom422(err.body?.detail);
      // A coded 422 (pending_property_limit, email_unverified…) has a string
      // detail, not an array — there is nothing to pin to a field, so it is
      // the summary.
      if (!messages.length) setSummary([err.message]);
      else setSummary(messages);
      setServerFields(fields);
      return;
    }
    if (err.status === 429) { setFormError(ERR_THROTTLED); return; }
    if (err.status === 404 || err.code === 'unknown_slug' || err.code === 'signup_disabled') {
      setCtxState('invalid');
      return;
    }
    // No `.status` means fetch itself rejected — offline, DNS, CORS.
    if (!err.status) { setFormError(ERR_NETWORK); return; }
    setFormError(err.message || ERR_NETWORK);
  }

  async function sendResetLink() {
    // Deliberately non-revealing, exactly like LoginPage's: the same
    // "a reset link is on its way" line whether or not the address exists.
    try { await authRequestPasswordReset(normalizeEmail(email)); } catch { /* ignore */ }
    setResetSent(true);
  }

  // ── mode="add-property" (spec §3.2 / §3.4a door (b)) ───────
  if (addProperty) {
    return (
      <Shell theme={theme} onToggleTheme={onToggleTheme} title="Add a property to your account">
        <AddPropertyForm
          slug={chosenSlug || null}
          initialDraft={draft}
          submitLabel="Add property"
          onSuccess={(prop) => {
            clearStoredDraft();
            const id = prop?.id;
            window.location.assign(id
              ? `/app?property=${encodeURIComponent(id)}&section=requests&firstrun=1`
              : '/app');
          }}
          onJoined={() => { clearStoredDraft(); window.location.assign('/app'); }}
          onCancel={() => window.location.assign('/app')}
        />
      </Shell>
    );
  }

  // ── Invalid slug / offline context ─────────────────────────
  if (ctxState === 'invalid') {
    return (
      <Shell theme={theme} onToggleTheme={onToggleTheme} title="Create your account">
        <div className="login-error" role="alert">{ERR_INVALID_SLUG}</div>
        <div className="login-note signup-foot">
          Already have an account? <a href="/app">Sign in</a>
        </div>
      </Shell>
    );
  }
  if (ctxState === 'offline' || ctxState === 'throttled') {
    return (
      <Shell theme={theme} onToggleTheme={onToggleTheme} title="Create your account">
        <div className="login-error" role="alert">{ctxState === 'throttled' ? ERR_THROTTLED : ERR_NETWORK}</div>
        <button type="button" className="login-btn" onClick={() => setCtxReloadKey(k => k + 1)}>Try again</button>
      </Shell>
    );
  }

  // ── Bare `/join` — one question first (spec §3.1) ──────────
  if (!chosenSlug && !notListed) {
    return (
      <Shell theme={theme} onToggleTheme={onToggleTheme} title="Who tows your property?">
        {ctxState === 'loading' && <p className="signup-sub">Loading…</p>}
        <div className="signup-chip-grid" role="group" aria-label="Who tows your property?">
          {partners.map(p => (
            <button key={p.slug || p.name} type="button" className="signup-chip"
              onClick={() => { setChosenSlug(p.slug); setMatch(null); }}>
              {p.name}
            </button>
          ))}
        </div>
        <button type="button" className="signup-link-btn" onClick={() => setNotListed(true)}>
          Not listed
        </button>
      </Shell>
    );
  }

  // ── SIGNUP_VERIFY_FIRST — the code sheet (spec §3.6) ───────
  if (outcome === 'verify_email') {
    return (
      <Shell theme={theme} onToggleTheme={onToggleTheme} title="Confirm your email" sub={`We sent a 6-digit code to ${normalizeEmail(email)}`}>
        <VerifyEmailSheet
          open
          email={normalizeEmail(email)}
          sentAt={new Date().toISOString()}
          mode="code"
          fromWall
          onSuccess={(resp) => {
            clearStoredDraft();
            if (resp && resp.token) onDone?.(sessionFromAuth(resp, normalizeEmail(email)));
            else window.location.assign('/app');
          }}
          onSignOut={() => window.location.assign('/app')}
          publicEmail={normalizeEmail(email)}
        />
      </Shell>
    );
  }

  // ── The form ───────────────────────────────────────────────
  const anyShown = ['propertyName', 'address', 'fullName', 'role', 'email', 'phone', 'password'].some(k => shown(k));
  return (
    <Shell theme={theme} onToggleTheme={onToggleTheme} title="Create your account" sub={headerLine(partnerName)}>
      {/* Locked partner chip — from the slug, not editable (spec §5.1). */}
      <div className="signup-partner-chip">
        <span aria-hidden="true">🚚 </span>Requests go to {partnerName}
      </div>

      {summary.length > 0 && (
        <div className="login-error" role="alert" tabIndex={-1} ref={summaryRef}
          aria-labelledby="signup-summary-title">
          <div id="signup-summary-title" style={{ fontWeight: 800, marginBottom: 6 }}>
            There&apos;s a problem
          </div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {summary.map((m, i) => <li key={i}>{m}</li>)}
          </ul>
        </div>
      )}
      {formError && <div className="login-error" role="alert">{formError}</div>}

      <form onSubmit={submit} noValidate aria-label="Create your account">
        <h2 className="signup-legend">Your property</h2>

        {joining ? (
          <div className="signup-readonly">
            <div className="signup-readonly-name">{joinProperty.name}</div>
            {joinProperty.street_line && <div className="signup-readonly-line">{joinProperty.street_line}</div>}
            <button type="button" className="signup-link-btn" onClick={() => { setJoinProperty(null); setMatch(null); }}>
              Use a different property
            </button>
          </div>
        ) : (
          <>
            <label className="field-label" htmlFor="signup-name">Property name</label>
            <input
              id="signup-name"
              className="field-input"
              type="text"
              autoComplete="organization"
              placeholder="Sunset Ridge Apartments"
              value={name}
              onChange={e => setName(e.target.value)}
              onBlur={() => blur('propertyName')}
              aria-invalid={shown('propertyName') ? 'true' : undefined}
              aria-describedby={shown('propertyName') ? errId('propertyName') : undefined}
            />
            {shown('propertyName') && <div className="signup-error" id={errId('propertyName')}>{shown('propertyName')}</div>}

            <label className="field-label" htmlFor="signup-address" style={{ marginTop: 12 }}>Property address</label>
            {!manual ? (
              <>
                <div ref={containerRef} className="signup-places" onBlur={() => blur('address')}>
                  {!placesReady && !placesFailed && (
                    <input id="signup-address" className="field-input" disabled placeholder="Loading address lookup…" />
                  )}
                </div>
                {placeFields?.address && <div className="signup-help">{placeFields.address}</div>}
                <button type="button" className="signup-link-btn" onClick={() => setManual(true)}>Enter it manually</button>
              </>
            ) : (
              <div className="signup-manual">
                <input id="signup-address" className="field-input" placeholder="Street address"
                  autoComplete="street-address" value={manualFields.line1}
                  onChange={e => setManualFields({ ...manualFields, line1: e.target.value })}
                  onBlur={() => blur('address')} />
                <input className="field-input" placeholder="City" autoComplete="address-level2"
                  value={manualFields.city}
                  onChange={e => setManualFields({ ...manualFields, city: e.target.value })}
                  onBlur={() => blur('address')} />
                <div className="signup-manual-row">
                  <input className="field-input signup-state" placeholder="State" autoComplete="address-level1"
                    maxLength={2} value={manualFields.state}
                    onChange={e => setManualFields({ ...manualFields, state: e.target.value.toUpperCase() })}
                    onBlur={() => blur('address')} />
                  <input className="field-input" placeholder="ZIP" autoComplete="postal-code"
                    inputMode="numeric" value={manualFields.zip}
                    onChange={e => setManualFields({ ...manualFields, zip: e.target.value })}
                    onBlur={onManualZipBlur} />
                </div>
                {GOOGLE_MAPS_KEY && !placesFailed && (
                  <button type="button" className="signup-link-btn" onClick={() => setManual(false)}>
                    Use address lookup instead
                  </button>
                )}
              </div>
            )}
            {shown('address') && <div className="signup-error" id={errId('address')}>{shown('address')}</div>}

            {match && !matchDismissed && (
              <div className="signup-match">
                <div className="signup-match-title">Is this your property?</div>
                <div className="signup-match-line">
                  {match.name}
                  {match.street_line ? ` · ${match.street_line}` : ''}
                  {match.manager_first_name ? ` · managed on LotLogic by ${match.manager_first_name}` : ''}
                </div>
                <div className="signup-match-actions">
                  <button type="button" className="signup-match-yes"
                    onClick={() => { setJoinProperty(match); setMatchDismissed(true); }}>
                    That&apos;s mine — ask to join
                  </button>
                  <button type="button" className="signup-link-btn"
                    onClick={() => { setPossibleDuplicateOf(match.id); setMatchDismissed(true); }}>
                    No, mine is different
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        <h2 className="signup-legend">About you</h2>
        <label className="field-label" htmlFor="signup-contact">Full name</label>
        <input
          id="signup-contact"
          className="field-input"
          type="text"
          autoComplete="name"
          spellCheck={false}
          placeholder="Dana Ortiz"
          value={contactName}
          onChange={e => setContactName(e.target.value)}
          onBlur={() => blur('fullName')}
          aria-invalid={shown('fullName') ? 'true' : undefined}
          aria-describedby={shown('fullName') ? errId('fullName') : undefined}
        />
        {shown('fullName') && <div className="signup-error" id={errId('fullName')}>{shown('fullName')}</div>}

        <div className="field-label" id="signup-role-label" style={{ marginTop: 12 }}>Your role</div>
        <RoleChips
          value={role}
          onChange={setRole}
          otherText={roleOther}
          onOtherText={setRoleOther}
          onOtherBlur={() => blur('role')}
          error={shown('role')}
          labelId="signup-role-label"
          errorId={errId('role')}
        />
        {shown('role') && <div className="signup-error" id={errId('role')}>{shown('role')}</div>}

        <label className="field-label" htmlFor="signup-email" style={{ marginTop: 12 }}>Work email</label>
        <input
          id="signup-email"
          className="field-input"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          autoCorrect="off"
          placeholder="dana@sunsetridge.com"
          value={email}
          onChange={e => setEmail(e.target.value)}
          onBlur={() => blur('email')}
          aria-invalid={shown('email') ? 'true' : undefined}
          aria-describedby={shown('email') ? errId('email') : undefined}
        />
        {shown('email') && <div className="signup-error" id={errId('email')}>{shown('email')}</div>}

        <label className="field-label" htmlFor="signup-phone" style={{ marginTop: 12 }}>Mobile number</label>
        <PhoneInput
          id="signup-phone"
          value={phone}
          onChange={setPhone}
          onBlur={() => blur('phone')}
          error={shown('phone')}
          errorId={errId('phone')}
          helpId="signup-phone-help"
        />
        {shown('phone') && <div className="signup-error" id={errId('phone')}>{shown('phone')}</div>}
        <div className="signup-help" id="signup-phone-help">{HELP_PHONE(partnerName)}</div>

        <h2 className="signup-legend">Sign in</h2>
        <label className="field-label" htmlFor="signup-password">Create a password</label>
        <PasswordField
          id="signup-password"
          value={password}
          onChange={setPassword}
          onBlur={() => blur('password')}
          error={shown('password')}
          errorId={errId('password')}
          helpId="signup-password-help"
        />
        {shown('password') && <div className="signup-error" id={errId('password')}>{shown('password')}</div>}
        <div className="signup-help" id="signup-password-help">{HELP_PASSWORD}</div>

        {outcome !== 'check_email' && (
          <p className="signup-terms">
            By creating an account you agree to the <a href="/terms.html">Terms</a> and{' '}
            <a href="/privacy.html">Privacy Policy</a>, including sharing your requests with {partnerName}.
          </p>
        )}

        {outcome === 'check_email' ? (
          // Spec §5.1: this card replaces the BUTTON, not the page — every
          // answer stays on screen (and in the draft) so signing in and
          // coming back to the add-property form costs no retyping.
          <div className="signup-match" role="status">
            <div className="signup-match-title">You already have an account.</div>
            <div className="signup-match-line">
              Sign in and we&apos;ll add {name.trim() || 'your property'} to it.
            </div>
            <a className="login-btn signup-btn-link"
              href={`/app?return_to=${encodeURIComponent(chosenSlug ? `/join/${chosenSlug}` : '/join')}`}>Sign in</a>
            <button type="button" className="signup-link-btn" onClick={sendResetLink}>
              Forgot your password? Email me a reset link
            </button>
            {resetSent && (
              <div className="signup-help" role="status">
                If that email is on file, a reset link is on its way.
              </div>
            )}
          </div>
        ) : (
          <>
            <button className="login-btn signup-submit" type="submit" aria-busy={submitting}>
              {submitting ? 'Creating account…' : 'Create account'}
            </button>
            {anyShown && !summary.length && (
              <div className="signup-help" role="status">Check the highlighted answers above.</div>
            )}
          </>
        )}
      </form>

      <div className="login-note signup-foot">
        Already have an account? <a href="/app">Sign in</a>
      </div>
    </Shell>
  );
}

export default SignupPage;
export { ROLES, ERR };
