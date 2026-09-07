import React, { useState, useEffect } from 'react';
import { db } from '../lib/db.js';
import { apiFetch } from '../lib/api.js';
import { scopePropsToPartner } from '../shared/scope.js';

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

// ── In-lot plate lookup (folded in from lookup.html) ──────────────
// Partner-facing field tool: pick an apartment property, punch a plate, get a
// glanceable Permitted / Expired / Not-registered verdict from the backend
// apartment lookup (RLS-scoped to the partner's own properties via apiFetch).
function PlateLookupVerdict({ out, history, typedPlate, onPick }) {
  const d = (out && out.detail) || {};
  // A same-plate rejection is the strongest hook-evidence there is — surface
  // it inside the verdict, not three scrolls below.
  const lastReject = history && history.entries ? history.entries.find(e => e.status === 'rejected') : null;
  // If normalization stripped characters, show what was actually checked so
  // a typo can't silently produce a tow verdict for the wrong string.
  const normalizedNote = typedPlate && d.plate && typedPlate.trim() !== d.plate
    ? `Checked as ${d.plate}` : null;
  const tag = d.is_temp_tag ? (
    d.tag_expired
      ? <div style={{ marginTop: 12, color: '#D9534F', fontWeight: 600, fontSize: 14, lineHeight: 1.45 }}>Temp tag EXPIRED — eligible for the expired-tag (48-hr-warning) tow path.</div>
      : <div style={{ marginTop: 12, color: 'var(--text-faint)', fontSize: 14 }}>Temp tag{d.tag_expiration ? ' · expires ' + fmtTagDate(d.tag_expiration) : ''}</div>
  ) : null;
  let tone = { border: '#D9534F', bg: 'rgba(217,83,79,.12)', fg: '#D9534F' };
  let glyph = '✗', headline = 'Not registered', sub = 'No active pass — eligible to tow.';
  if (out.verdict === 'resident') { tone = { border: '#3FA45B', bg: 'rgba(63,164,91,.12)', fg: '#3FA45B' }; glyph = '✓'; headline = 'Permitted'; sub = 'Parking pass' + (d.unit ? ' · Unit ' + d.unit : '') + (d.name ? ' · ' + d.name : ''); }
  else if (out.verdict === 'guest') { tone = { border: '#3FA45B', bg: 'rgba(63,164,91,.12)', fg: '#3FA45B' }; glyph = '✓'; headline = 'Permitted'; sub = 'Parking pass' + (d.unit ? ' · Unit ' + d.unit : '') + (d.hours_left != null ? ' · ' + d.hours_left + 'h left' : ''); }
  else if (out.verdict === 'expired_guest') {
    tone = { border: 'var(--accent)', bg: 'rgba(251,191,36,.12)', fg: 'var(--accent-dark)' }; glyph = '!'; headline = 'Expired pass';
    const ago = d.valid_until ? Math.max(0, Math.round((Date.now() - new Date(d.valid_until).getTime()) / 3600000)) : null;
    sub = 'Pass expired' + (ago != null ? ` ${ago}h ago` : '') + (d.unit ? ' · Unit ' + d.unit : '') + ' — eligible to tow.';
  }
  const suggestions = out.verdict === 'not_registered' && Array.isArray(out.suggestions) ? out.suggestions : [];
  return (
    <>
    <div style={{ marginTop: 20, border: '2px solid ' + tone.border, background: tone.bg, borderRadius: 12, padding: '24px 20px', textAlign: 'center' }}>
      <div style={{ fontSize: 48, lineHeight: 1, color: tone.fg, marginBottom: 8 }}>{glyph}</div>
      <div style={{ fontWeight: 800, fontSize: 24, color: tone.fg }}>{headline}</div>
      <div style={{ fontSize: 15, color: 'var(--text-secondary)', marginTop: 8, lineHeight: 1.4 }}>{sub}</div>
      {d.plate && <div style={{ display: 'inline-block', marginTop: 14, background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text-primary)', padding: '8px 16px', borderRadius: 8, fontFamily: 'ui-monospace, monospace', fontSize: 18, fontWeight: 700, letterSpacing: '.08em' }}>{d.plate}</div>}
      {normalizedNote && <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-faint)' }}>{normalizedNote}</div>}
      {lastReject && (out.verdict === 'not_registered' || out.verdict === 'expired_guest') && (
        <div style={{ marginTop: 12, fontSize: 13, fontWeight: 700, color: '#D9534F' }}>
          Registration rejected {new Date(lastReject.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}{lastReject.reject_reason ? ` — ${lastReject.reject_reason}` : ''}
        </div>
      )}
      {tag}
    </div>
    {/* Fuzzy near-misses: a typo or partial read shouldn't dead-end at
        "not registered". Tapping a plate re-runs the lookup on it, so the
        tow verdict is always rendered from a real exact check — the
        suggestion list itself is never a verdict. */}
    {suggestions.length > 0 && (
      <div style={{ marginTop: 14 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>
          No exact match — closest registered plates
        </div>
        <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', background: 'var(--bg-card)' }}>
          {suggestions.map((s, i) => (
            <button key={s.plate} onClick={() => onPick && onPick(s.plate)}
              aria-label={`Check plate ${s.plate}`}
              style={{ display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '13px 14px', background: 'none', border: 'none', borderBottom: i < suggestions.length - 1 ? '1px solid var(--border)' : 'none', cursor: 'pointer', textAlign: 'left' }}>
              <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 17, fontWeight: 700, letterSpacing: '.08em', color: 'var(--text-primary)' }}>{s.plate}</span>
              <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: s.active_now ? '#4ade80' : 'var(--accent-dark)' }}>
                  {s.source === 'resident' ? 'Pass on file' : (s.active_now ? 'Active pass' : 'Expired pass')}
                </span>
                {(s.unit || s.name) && <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{[s.unit ? 'Unit ' + s.unit : null, s.name].filter(Boolean).join(' · ')}</span>}
              </span>
            </button>
          ))}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 6, textAlign: 'center' }}>Tap a plate to check it.</div>
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
  const [propertyId, setPropertyId] = useState('');
  const [plate, setPlate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState(null);
  const [searchedPlate, setSearchedPlate] = useState('');

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
        try { remembered = localStorage.getItem('lotlogic_lookup_property'); } catch {}
        setPropertyId(apts.some(a => a.id === remembered) ? remembered : (apts[0]?.id || ''));
      })
      .catch(() => { if (alive) setProperties([]); });
    return () => { alive = false; };
  }, [user.id, user._role]);

  // Monotonic token: this lookup renders a tow-eligibility verdict, so a slow
  // response from a PREVIOUS plate must never overwrite the current one.
  // (Holding Enter, or typing plate → Enter → correcting → Enter, put two
  // requests in flight and whichever RETURNED last won.) Same reqRef pattern
  // as useActiveRoster.
  const lookupReqRef = React.useRef(0);
  // `overridePlate` lets a tapped suggestion re-run immediately with the
  // picked plate (state hasn't flushed yet). Button onClick passes an event
  // object, hence the typeof guard.
  async function run(overridePlate) {
    const pl = (typeof overridePlate === 'string' ? overridePlate : plate).trim();
    if (busy) return; // Enter key had no busy guard — the button did
    if (!propertyId || !pl) { setError('Pick a property and enter a plate.'); return; }
    const req = ++lookupReqRef.current;
    setBusy(true); setError(''); setResult(null); setHistory(null); setSearchedPlate(pl);
    try {
      const out = await apiFetch(`/apartment/passes/lookup?property_id=${encodeURIComponent(propertyId)}&plate=${encodeURIComponent(pl)}`);
      if (req === lookupReqRef.current) setResult(out);
      // Tag history rides along — best-effort, never blocks the verdict.
      apiFetch(`/apartment/passes/history?property_id=${encodeURIComponent(propertyId)}&plate=${encodeURIComponent(pl)}`)
        .then(h => { if (req === lookupReqRef.current) setHistory(h); })
        .catch(() => {});
    } catch (err) { if (req === lookupReqRef.current && err.status !== 401) setError(err.message || 'Lookup failed.'); }
    finally { if (req === lookupReqRef.current) setBusy(false); }
  }

  const labelStyle = { display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.06em', margin: '16px 0 6px' };
  return (
    <div style={{ maxWidth: 460, margin: '0 auto' }}>
      <div className="section-title" style={{ fontSize: 22, marginBottom: 4 }}>Plate lookup</div>
      <div style={{ fontSize: 13, color: 'var(--text-faint)', marginBottom: 8 }}>Check a plate against the property's registered passes.</div>
      {properties === null ? (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-faint)', fontSize: 13 }}>Loading properties…</div>
      ) : properties.length === 0 ? (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-faint)', fontSize: 13, border: '1px solid var(--border)', borderRadius: 12 }}>No apartment properties assigned to this account.</div>
      ) : (
        <>
          <label style={labelStyle}>Property</label>
          <select value={propertyId} onChange={e => { setPropertyId(e.target.value); try { localStorage.setItem('lotlogic_lookup_property', e.target.value); } catch {} }} style={{ width: '100%', padding: '12px 14px', background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-primary)', fontSize: 15 }}>
            {properties.map(p => <option key={p.id} value={p.id}>{p.name || p.address || p.id}</option>)}
          </select>
          <label style={labelStyle}>License plate</label>
          <input value={plate} onChange={e => setPlate(e.target.value.toUpperCase())} onKeyDown={e => { if (e.key === 'Enter') run(); }}
            autoCapitalize="characters" autoComplete="off" placeholder="ABC1234"
            style={{ width: '100%', padding: '16px 14px', background: 'var(--bg-card)', color: 'var(--text-primary)', border: '2px solid var(--border)', borderRadius: 10, fontSize: 26, fontWeight: 700, textAlign: 'center', letterSpacing: '.1em', fontFamily: 'ui-monospace, monospace', outlineColor: 'var(--accent)' }} />
          <button onClick={run} disabled={busy} style={{ width: '100%', marginTop: 18, padding: '15px', background: 'var(--text-primary)', color: 'var(--bg-primary)', border: 'none', borderRadius: 999, fontWeight: 700, fontSize: 16, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1 }}>
            {busy ? 'Checking…' : 'Check'}
          </button>
          {error && <div style={{ background: 'rgba(217,83,79,.12)', border: '1px solid #D9534F', color: '#D9534F', borderRadius: 8, padding: '10px 12px', fontSize: 13, marginTop: 16, textAlign: 'center' }}>{error}</div>}
          {result && <PlateLookupVerdict out={result} history={history} typedPlate={searchedPlate} onPick={(pl) => { setPlate(pl); run(pl); }} />}
          {history && history.entries && history.entries.length > 0 && (
            <div style={{ marginTop: 20 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>
                Pass history · {history.entries.length}{history.entries.length === 50 ? '+' : ''}
              </div>
              <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', background: 'var(--bg-card)' }}>
                {history.entries.map((e, i) => {
                  const statusColor = e.status === 'active' || e.status === 'approved' ? '#4ade80'
                    : e.status === 'rejected' ? '#ef4444'
                    : e.status === 'pending' ? '#fbbf24' : 'var(--text-faint)';
                  const fmt = (v) => v ? new Date(v).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;
                  return (
                    <div key={e.id} style={{ padding: '10px 14px', borderTop: i ? '1px solid var(--border-subtle)' : 'none', display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
                          {e.kind === 'permanent' ? 'Long-term pass' : 'Short-term pass'}
                          {e.unit ? ` · Unit ${e.unit}` : ''}{e.name ? ` · ${e.name}` : ''}
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 2 }}>
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
