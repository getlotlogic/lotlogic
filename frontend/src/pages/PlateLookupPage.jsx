import React, { useState, useEffect } from 'react';
import { db } from '../lib/db.js';
import { apiFetch } from '../lib/api.js';
import { scopePropsToPartner } from '../shared/scope.js';
import { verdictPresentation, resolveAllScopeResult, scopeOptions } from '../lib/verdicts.js';

const REMEMBERED_KEY = 'lotlogic_lookup_property';
const ALL_SCOPE = 'all';

// tag_expiration is a bare "YYYY-MM-DD" date — parse as LOCAL (not UTC) so the
// displayed day doesn't shift backwards in western timezones. Ported verbatim
// from lookup.html.
function fmtTagDate(s) {
  if (!s) return '';
  const parts = String(s).split('-').map(Number);
  if (parts.length !== 3 || parts.some(n => !n)) return s;
  return new Date(parts[0], parts[1] - 1, parts[2])
    .toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// Tone (from verdicts.js) -> the actual fill/ink pair. 'go'/'stop' are fixed
// safety colors (never theme-swapped — see dashboard.html's :root comment);
// 'amber' reuses the already-themed --accent token with the one new ink
// token; 'neutral' is the grouped card, same chrome as any other card.
const TONE_STYLE = {
  go: { fill: 'var(--verdict-go)', ink: '#0E0F11' },
  stop: { fill: 'var(--verdict-stop)', ink: '#F5F5F0' },
  amber: { fill: 'var(--accent)', ink: 'var(--verdict-amber-ink)' },
  neutral: { fill: 'var(--bg-card)', ink: 'var(--text-primary)' },
};

// ── In-lot plate lookup (folded in from lookup.html) ──────────────
// Partner-facing field tool: pick an apartment property (or, once the
// backend route exists, "All N Style properties"), punch a plate, get a
// glanceable verdict card straight off the spec §5.5 table.
function PlateLookupVerdict({ out, scope, propertyName, history, typedPlate, onPick, onSwitchProperty }) {
  const detail = { ...(out.detail || {}) };
  if (scope !== 'all' && !detail.property_name && propertyName) detail.property_name = propertyName;
  const pres = verdictPresentation(out.verdict, detail, scope);
  const style = TONE_STYLE[pres.tone] || TONE_STYLE.neutral;

  const d = out.detail || {};
  // A same-plate rejection is the strongest hook-evidence there is — surface
  // it inside the verdict, not three scrolls below.
  const lastReject = history && history.entries ? history.entries.find(e => e.status === 'rejected') : null;
  // If normalization stripped characters, show what was actually checked so
  // a typo can't silently produce a tow verdict for the wrong string.
  const normalizedNote = typedPlate && d.plate && typedPlate.trim() !== d.plate
    ? `Checked as ${d.plate}` : null;
  const tag = d.is_temp_tag ? (
    d.tag_expired
      ? <div style={{ marginTop: 12, fontWeight: 600, fontSize: 14, lineHeight: 1.45 }}>Temp tag EXPIRED — eligible for the expired-tag (48-hr-warning) tow path.</div>
      : <div style={{ marginTop: 12, fontSize: 14, opacity: .85 }}>Temp tag{d.tag_expiration ? ' · expires ' + fmtTagDate(d.tag_expiration) : ''}</div>
  ) : null;
  const suggestions = out.verdict === 'not_registered' && Array.isArray(out.suggestions) ? out.suggestions : [];

  return (
    <>
    <div role="status" aria-live="polite" style={{ marginTop: 20, borderRadius: 12, padding: '24px 20px', textAlign: 'center', background: style.fill, color: style.ink, border: pres.tone === 'neutral' ? '1px solid var(--border)' : 'none' }}>
      {pres.lines ? (
        // grouped: ≥2 properties disagree — one line per property, tappable
        // through to that property's own card (spec §5.5 "grouped" row).
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {pres.lines.map((line, i) => {
            const match = (d.matches || [])[i];
            return (
              <button key={match?.property_id || i} onClick={() => onSwitchProperty && match?.property_id && onSwitchProperty(match.property_id)}
                style={{ textAlign: 'left', background: 'none', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', color: 'inherit', fontSize: 14, fontWeight: 700, cursor: match?.property_id ? 'pointer' : 'default' }}>
                {line}
              </button>
            );
          })}
        </div>
      ) : (
        <>
          {pres.glyph && <div style={{ fontSize: 40, lineHeight: 1, marginBottom: 8 }}>{pres.glyph}</div>}
          <div style={{ fontWeight: 800, fontSize: 32, letterSpacing: '-.01em' }}>{pres.signal}</div>
          {pres.reason && <div style={{ fontSize: 14, marginTop: 10, lineHeight: 1.45, opacity: .92 }}>{pres.reason}</div>}
          {out.verdict === 'on_file_elsewhere' && pres.propertyId && (
            <button onClick={() => onSwitchProperty && onSwitchProperty(pres.propertyId)}
              style={{ marginTop: 10, background: 'none', border: '1px solid currentColor', color: 'inherit', borderRadius: 999, padding: '6px 14px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
              Check at {pres.propertyName}
            </button>
          )}
        </>
      )}
      {d.plate && <div style={{ display: 'inline-block', marginTop: 14, background: 'rgba(0,0,0,.12)', border: '1px solid currentColor', padding: '8px 16px', borderRadius: 8, fontFamily: "'DM Mono', ui-monospace, monospace", fontSize: 18, fontWeight: 700, letterSpacing: '.08em' }}>{d.plate}</div>}
      {normalizedNote && <div style={{ marginTop: 8, fontSize: 12, opacity: .75 }}>{normalizedNote}</div>}
      {lastReject && (out.verdict === 'not_registered' || out.verdict === 'expired_guest') && (
        <div style={{ marginTop: 12, fontSize: 13, fontWeight: 700 }}>
          Registration rejected {new Date(lastReject.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}{lastReject.reject_reason ? ` — ${lastReject.reject_reason}` : ''}
        </div>
      )}
      {tag}
    </div>
    <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>Checked just now · logged</div>
    {/* Fuzzy near-misses: a typo or partial read shouldn't dead-end at
        "not registered". Tapping a plate re-runs the lookup on it, so the
        tow verdict is always rendered from a real exact check — the
        suggestion list itself is never a verdict. */}
    {suggestions.length > 0 && (
      <div style={{ marginTop: 14 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>
          No exact match — closest registered plates
        </div>
        <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', background: 'var(--bg-card)' }}>
          {suggestions.map((s, i) => (
            <button key={s.plate} onClick={() => onPick && onPick(s.plate)}
              aria-label={`Check plate ${s.plate}`}
              style={{ display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '13px 14px', background: 'none', border: 'none', borderBottom: i < suggestions.length - 1 ? '1px solid var(--border)' : 'none', cursor: 'pointer', textAlign: 'left' }}>
              <span style={{ fontFamily: "'DM Mono', ui-monospace, monospace", fontSize: 17, fontWeight: 700, letterSpacing: '.08em', color: 'var(--text-primary)' }}>{s.plate}</span>
              <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: s.active_now ? '#4ade80' : 'var(--accent-dark)' }}>
                  {s.source === 'resident' ? 'Pass on file' : (s.active_now ? 'Active pass' : 'Expired pass')}
                </span>
                {(s.unit || s.name) && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{[s.unit ? 'Unit ' + s.unit : null, s.name].filter(Boolean).join(' · ')}</span>}
              </span>
            </button>
          ))}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6, textAlign: 'center' }}>Tap a plate to check it.</div>
      </div>
    )}
    </>
  );
}

export function PlateLookupPage({ user }) {
  // Load the partner's OWN properties (RLS-scoped by tow_company_id via
  // db.getProperties) — same source ALPRPropertiesPage uses. The App-level
  // `lots` state comes from the `lots` table, which has no property_type and
  // doesn't include the apartment registry rows, so we must not use it here.
  const [properties, setProperties] = useState(null); // null = still loading
  const [scopeValue, setScopeValue] = useState(''); // a property id, or ALL_SCOPE
  const [rememberedPropertyId, setRememberedPropertyId] = useState('');
  const [plate, setPlate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null); // { verdict, detail, suggestions?, scope }
  const [history, setHistory] = useState(null);
  const [searchedPlate, setSearchedPlate] = useState('');
  // Task 20 ships before Task 8 — /partner/lookup 404s on the live backend
  // until then. Probe once; render "All N Style properties" only once the
  // route has proven it exists (any non-404 answer).
  const [partnerLookupAvailable, setPartnerLookupAvailable] = useState(false);
  const [probeDone, setProbeDone] = useState(false);

  useEffect(() => {
    let alive = true;
    db.getProperties(user.id, user._role)
      .then(p => {
        if (!alive) return;
        const apts = scopePropsToPartner(p || [], user).filter(x => x.property_type === 'apartment')
          .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
        setProperties(apts);
        // Remember the operator's property — defaulting to the alphabetical
        // first lot made 'not registered' verdicts against the WRONG property.
        let remembered = null;
        try { remembered = localStorage.getItem(REMEMBERED_KEY); } catch {}
        const initial = apts.some(a => a.id === remembered) ? remembered : (apts[0]?.id || '');
        setScopeValue(initial);
        setRememberedPropertyId(initial);
      })
      .catch(() => { if (alive) setProperties([]); });
    return () => { alive = false; };
  }, [user.id, user._role]);

  // Scope probe — partner subjects only (spec §5.5: "All N Style properties"
  // is an explicit choice in the picker, partner subjects only).
  useEffect(() => {
    if (user._role !== 'partner') return;
    let alive = true;
    apiFetch('/partner/lookup?plate=PROBE0')
      .then(() => { if (alive) setPartnerLookupAvailable(true); })
      .catch(err => { if (alive) setPartnerLookupAvailable(err.status !== 404); })
      .finally(() => { if (alive) setProbeDone(true); });
    return () => { alive = false; };
  }, [user.id, user._role]);

  // Deep link `/app?tab=lookup&plate=ABC1234&property=<id>` (Task 20 reads
  // `plate`/`property` off location.search itself, so it works even before
  // Task 21 wires the `tab` query into the shell).
  const deepLinkRanRef = React.useRef(false);
  useEffect(() => {
    if (deepLinkRanRef.current) return;
    if (properties === null) return; // wait for the property list to resolve
    deepLinkRanRef.current = true;
    let qs;
    try { qs = new URLSearchParams(window.location.search); } catch { return; }
    const qPlate = qs.get('plate');
    const qProperty = qs.get('property');
    if (!qPlate) return;
    const nextScope = qProperty === ALL_SCOPE && partnerLookupAvailable
      ? ALL_SCOPE
      : (properties.some(p => p.id === qProperty) ? qProperty : scopeValue);
    setPlate(qPlate.toUpperCase());
    if (nextScope && nextScope !== scopeValue) setScopeValue(nextScope);
    run(qPlate, nextScope);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [properties]);

  // Monotonic token: this lookup renders a tow-eligibility verdict, so a slow
  // response from a PREVIOUS plate must never overwrite the current one.
  // (Holding Enter, or typing plate → Enter → correcting → Enter, put two
  // requests in flight and whichever RETURNED last won.) Same reqRef pattern
  // as useActiveRoster.
  const lookupReqRef = React.useRef(0);
  // `overridePlate` lets a tapped suggestion (or a deep link) re-run
  // immediately with the picked plate (state hasn't flushed yet). Button
  // onClick passes an event object, hence the typeof guard.
  async function run(overridePlate, overrideScope) {
    const pl = (typeof overridePlate === 'string' ? overridePlate : plate).trim();
    const scope = typeof overrideScope === 'string' ? overrideScope : scopeValue;
    if (busy) return; // Enter key had no busy guard — the button did
    if (!scope || !pl) { setError('Pick a property and enter a plate.'); return; }
    const req = ++lookupReqRef.current;
    setBusy(true); setError(''); setResult(null); setHistory(null); setSearchedPlate(pl);
    try {
      if (scope === ALL_SCOPE) {
        const out = await apiFetch(`/partner/lookup?plate=${encodeURIComponent(pl)}`);
        if (req !== lookupReqRef.current) return;
        const resolved = resolveAllScopeResult(out, rememberedPropertyId);
        const rendered = { verdict: resolved.verdict, detail: { ...resolved.detail, plate: pl } };
        setResult(rendered);
        vibrateIfDoNotTow(rendered, 'all');
      } else {
        const out = await apiFetch(`/apartment/passes/lookup?property_id=${encodeURIComponent(scope)}&plate=${encodeURIComponent(pl)}`);
        if (req === lookupReqRef.current) {
          setResult(out);
          vibrateIfDoNotTow(out, 'property', properties?.find(p => p.id === scope)?.name);
        }
        // Tag history rides along — best-effort, never blocks the verdict.
        apiFetch(`/apartment/passes/history?property_id=${encodeURIComponent(scope)}&plate=${encodeURIComponent(pl)}`)
          .then(h => { if (req === lookupReqRef.current) setHistory(h); })
          .catch(() => {});
      }
    } catch (err) { if (req === lookupReqRef.current && err.status !== 401) setError(err.message || 'Lookup failed.'); }
    finally { if (req === lookupReqRef.current) setBusy(false); }
  }

  // navigator.vibrate([40]) on DO NOT TOW (spec §5.5) — a short, distinct
  // buzz the driver's hand feels without having to read the screen first.
  function vibrateIfDoNotTow(out, scope, propertyName) {
    const detail = { ...(out.detail || {}) };
    if (scope !== 'all' && !detail.property_name && propertyName) detail.property_name = propertyName;
    const pres = verdictPresentation(out.verdict, detail, scope);
    if (pres.tone === 'go') {
      try { navigator.vibrate && navigator.vibrate([40]); } catch {}
    }
  }

  function selectProperty(id) {
    setScopeValue(id);
    if (id !== ALL_SCOPE) {
      setRememberedPropertyId(id);
      try { localStorage.setItem(REMEMBERED_KEY, id); } catch {}
    }
  }

  function switchPropertyAndRecheck(id) {
    selectProperty(id);
    run(searchedPlate || plate, id);
  }

  const labelStyle = { display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.06em', margin: '16px 0 6px' };
  const options = scopeOptions({ properties, partnerLookupAvailable, companyName: user.company_name });
  const selectedPropertyName = properties?.find(p => p.id === scopeValue)?.name;

  return (
    <div style={{ maxWidth: 460, margin: '0 auto' }}>
      <div className="section-title" style={{ fontSize: 22, marginBottom: 4 }}>Plate lookup</div>
      <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 8 }}>Check a plate against the property's registered passes.</div>
      {properties === null ? (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Loading properties…</div>
      ) : properties.length === 0 ? (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, border: '1px solid var(--border)', borderRadius: 12 }}>No apartment properties assigned to this account.</div>
      ) : (
        <>
          <label style={labelStyle} htmlFor="lookup-scope">Checking</label>
          <select id="lookup-scope" value={scopeValue} onChange={e => selectProperty(e.target.value)} style={{ width: '100%', padding: '12px 14px', background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-primary)', fontSize: 15 }}>
            {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          {probeDone && !partnerLookupAvailable && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>All-properties check is coming soon — pick a property.</div>
          )}
          <label style={labelStyle} htmlFor="lookup-plate">License plate</label>
          <input id="lookup-plate" value={plate} onChange={e => setPlate(e.target.value.toUpperCase())} onKeyDown={e => { if (e.key === 'Enter') run(); }}
            autoCapitalize="characters" autoCorrect="off" spellCheck="false" enterKeyHint="done" autoComplete="off" placeholder="ABC1234"
            style={{ width: '100%', padding: '16px 14px', background: 'var(--bg-card)', color: 'var(--text-primary)', border: '2px solid var(--border)', borderRadius: 10, fontSize: 32, fontWeight: 700, textAlign: 'center', letterSpacing: '.1em', fontFamily: "'DM Mono', ui-monospace, monospace", outlineColor: 'var(--accent)' }} />
          <button onClick={() => run()} disabled={busy} style={{ width: '100%', marginTop: 18, padding: '15px', background: 'var(--text-primary)', color: 'var(--bg-primary)', border: 'none', borderRadius: 999, fontWeight: 700, fontSize: 16, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1 }}>
            {busy ? 'Checking…' : 'Check'}
          </button>
          {error && <div style={{ background: 'rgba(217,83,79,.12)', border: '1px solid #D9534F', color: '#D9534F', borderRadius: 8, padding: '10px 12px', fontSize: 13, marginTop: 16, textAlign: 'center' }}>{error}</div>}
          {result && (
            <PlateLookupVerdict out={result} scope={scopeValue === ALL_SCOPE ? 'all' : 'property'} propertyName={selectedPropertyName}
              history={history} typedPlate={searchedPlate} onPick={(pl) => { setPlate(pl); run(pl); }}
              onSwitchProperty={switchPropertyAndRecheck} />
          )}
          {history && history.entries && history.entries.length > 0 && (
            <div style={{ marginTop: 20 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>
                Pass history · {history.entries.length}{history.entries.length === 50 ? '+' : ''}
              </div>
              <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', background: 'var(--bg-card)' }}>
                {history.entries.map((e, i) => {
                  const statusColor = e.status === 'active' || e.status === 'approved' ? '#4ade80'
                    : e.status === 'rejected' ? '#ef4444'
                    : e.status === 'pending' ? '#fbbf24' : 'var(--text-muted)';
                  const fmt = (v) => v ? new Date(v).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;
                  return (
                    <div key={e.id} style={{ padding: '10px 14px', borderTop: i ? '1px solid var(--border-subtle)' : 'none', display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
                          {e.kind === 'permanent' ? 'Long-term pass' : 'Short-term pass'}
                          {e.unit ? ` · Unit ${e.unit}` : ''}{e.name ? ` · ${e.name}` : ''}
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                          {fmt(e.created_at)}{e.valid_until ? ` → ${fmt(e.valid_until)}` : ''}
                        </div>
                        {e.reject_reason && (
                          <div style={{ fontSize: 12, fontWeight: 700, color: '#D9534F', marginTop: 2 }}>Rejected — {e.reject_reason}</div>
                        )}
                      </div>
                      <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em', color: statusColor, alignSelf: 'center' }}>{e.status}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
