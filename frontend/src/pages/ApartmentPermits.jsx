import React, { useState, useEffect, useCallback, useRef, useMemo, memo } from 'react';
import { fmtPassRemaining } from '../lib/time.js';
import { fmtTime } from '../lib/format.js';
import { API, apiFetch, getSessionToken } from '../lib/api.js';
import { useNowTick } from '../hooks.js';
import { useToast } from '../ui/Toast.jsx';
import { useFocusTrap, useUid } from '../ui/focusTrap.js';
import { FeedbackModal } from '../ui/FeedbackModal.jsx';

// ── Apartment permit registry (M3) ───────────────────────────
// Leasing-office / partner view for an apartment property: a pending
// approval queue (residents + guests) with PII document viewers, plus
// active resident / guest rosters with extend + void controls.
//
// Doc bytes are PII and auth-gated, so an <img src> can't carry the
// bearer token. We fetch the doc to a blob with an explicit Authorization
// header (token via the shared getSessionToken helper), make an object URL,
// open it, and revoke the URL afterward so it doesn't leak.
async function fetchDocBlob(kind, id, which) {
  const token = getSessionToken();
  const res = await fetch(`${API}/apartment/docs/${kind}/${id}/${which}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (res.status === 401) {
    // Match apiFetch: dead session → clear it and bounce to login, don't just toast.
    try { localStorage.removeItem('lotlogic_session'); } catch {}
    window.dispatchEvent(new CustomEvent('lotlogic:auth-expired'));
  }
  if (!res.ok) {
    let msg = `Could not load document (${res.status})`;
    try { const b = await res.json(); if (b.detail) msg = b.detail; } catch {}
    throw new Error(msg);
  }
  return res.blob();
}


// ── In-page PII document viewer ──────────────────────────────
// Renders an already-fetched (authed) blob INLINE rather than opening a new tab.
// `window.open(blob:, '_blank', 'noopener')` is unreliable on mobile Safari
// (leasing / N Style on phones) — with noopener it frequently refuses blob:
// URLs and lands on a blank tab. The authed fetch-to-blob already happened in
// the caller, so we just render the resulting object URL here: images via <img>,
// PDFs via <iframe>. The object URL is revoked when the modal closes. Reuses the
// overlay + focus-trap pattern from FeedbackModal.
function DocViewerModal({ blob, label, onClose }) {
  const dialogRef = useRef(null);
  const titleId = useUid('doc-title');
  useFocusTrap(dialogRef, true, onClose);

  const [objectUrl, setObjectUrl] = useState(null);
  useEffect(() => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [blob]);

  const isPdf = (blob?.type || '').includes('pdf');

  return (
    <div
      onClick={onClose}
      style={{position:'fixed',inset:0,background:'rgba(0,0,0,.7)',zIndex:1100,display:'flex',alignItems:'center',justifyContent:'center',padding:16}}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
        style={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:12,padding:12,maxWidth:920,width:'100%',maxHeight:'92vh',display:'flex',flexDirection:'column',outline:'none'}}
      >
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:10,gap:12}}>
          <div id={titleId} style={{fontSize:15,fontWeight:800,color:'var(--text-primary)'}}>{label || 'Document'}</div>
          <div style={{display:'flex',gap:8}}>
            {objectUrl && (
              <a href={objectUrl} download className="pd-share-btn" style={{textDecoration:'none'}}>Download</a>
            )}
            <button onClick={onClose} className="pd-share-btn">Close</button>
          </div>
        </div>
        <div style={{flex:1,minHeight:0,overflow:'auto',background:'var(--bg-inset)',border:'1px solid var(--border)',borderRadius:8,display:'flex',alignItems:'center',justifyContent:'center'}}>
          {!objectUrl ? (
            <div style={{padding:24,fontSize:13,color:'var(--text-faint)'}}>Loading…</div>
          ) : isPdf ? (
            <iframe src={objectUrl} title={label || 'Document'} sandbox="" style={{width:'100%',height:'80vh',border:'none',borderRadius:6}} />
          ) : (
            <img src={objectUrl} alt={label || 'Document'} style={{maxWidth:'100%',maxHeight:'80vh',objectFit:'contain',display:'block'}} />
          )}
        </div>
      </div>
    </div>
  );
}

export function ApartmentPermits({ property }) {
  const propertyId = property?.id;
  const { addToast } = useToast();
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  // Currently-open PII document ({ blob, label }) for the in-page viewer.
  const [docView, setDocView] = useState(null);
  const [data, setData] = useState({ residents: [], guests: [] });
  const [loading, setLoading] = useState(true);
  // Non-null when the last refresh failed — distinguishes "nothing pending"
  // from "we don't know what's pending".
  const [loadErr, setLoadErr] = useState(null);
  // id of the row currently mid-action, so we can disable its buttons.
  const [busy, setBusy] = useState(null);
  const [docBusy, setDocBusy] = useState(null);
  const nowTick = useNowTick();

  const refresh = useCallback(async () => {
    if (!propertyId) return;
    setLoading(true);
    try {
      const res = await apiFetch(`/apartment/passes/permits?property_id=${propertyId}`);
      setData({ residents: res.residents || [], guests: res.guests || [] });
      setLoadErr(null);
    } catch (e) {
      // Record the failure so the queue can say "couldn't load" instead of
      // rendering the initial empty state as "Nothing waiting for review" —
      // a confident false negative backed only by a toast that auto-dismisses.
      setLoadErr(e.message || 'Could not load');
      addToast('Could not load permits. ' + (e.message || ''), 'error');
    } finally {
      setLoading(false);
    }
  }, [propertyId, addToast]);

  useEffect(() => { refresh(); }, [refresh]);

  // Fetches a PII doc (authed) to a blob, then opens it in the in-page viewer
  // modal. We do NOT window.open a blob: URL — mobile Safari refuses it under
  // noopener and lands on a blank tab. The modal owns the object URL lifecycle
  // (created on mount, revoked on close).
  const viewDoc = useCallback(async (kind, id, which, label) => {
    const key = `${kind}:${id}:${which}`;
    setDocBusy(key);
    try {
      const blob = await fetchDocBlob(kind, id, which);
      setDocView({ blob, label });
    } catch (e) {
      addToast(e.message || 'Could not load document.', 'error');
    } finally {
      setDocBusy(null);
    }
  }, [addToast]);

  // Generic action runner: POST to a path, refresh on success, surface errors.
  const runAction = useCallback(async (rowKey, path, body, okMsg) => {
    setBusy(rowKey);
    try {
      await apiFetch(path, {
        method: 'POST',
        headers: body ? { 'content-type': 'application/json' } : {},
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (okMsg) addToast(okMsg, 'success');
      await refresh();
    } catch (e) {
      addToast(e.message || 'Action failed.', 'error');
    } finally {
      setBusy(null);
    }
  }, [refresh, addToast]);

  const approve = (kind, id) => runAction(`${kind}:${id}`, `/apartment/passes/${kind}/${id}/approve`, null, 'Approved');
  const reject = (kind, id) => {
    const reason = window.prompt('Reason for rejection?');
    if (reason == null) return; // operator cancelled
    runAction(`${kind}:${id}`, `/apartment/passes/${kind}/${id}/reject`, { reason }, 'Rejected');
  };
  const voidPass = (kind, id) => {
    if (!window.confirm('Void this pass? This cannot be undone.')) return;
    runAction(`${kind}:${id}`, `/apartment/passes/${kind}/${id}/void`, null, 'Voided');
  };
  const extend = (id) => {
    const raw = window.prompt('Extend by how many hours? (1-72)');
    if (raw == null) return;
    const hours = parseInt(raw, 10);
    if (!Number.isInteger(hours) || hours < 1 || hours > 72) {
      addToast('Enter a whole number of hours between 1 and 72.', 'error');
      return;
    }
    runAction(`guest:${id}`, `/apartment/passes/guest/${id}/extend`, { hours }, `Extended ${hours}h`);
  };

  const residents = data.residents || [];
  const guests = data.guests || [];
  const pendingResidents = residents.filter(r => r.status === 'pending');
  const pendingGuests = guests.filter(g => g.status === 'pending');
  const pending = [
    ...pendingResidents.map(r => ({ ...r, _kind: 'resident' })),
    ...pendingGuests.map(g => ({ ...g, _kind: 'guest' })),
  ].sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
  const approvedResidents = residents.filter(r => r.status === 'approved');
  const activeGuests = guests.filter(g => g.status === 'active');

  const plateChip = (txt) => (
    <span style={{fontFamily:"'Courier New',monospace",background:'#fef3c7',color:'#1c1009',border:'1.5px solid #fbbf24',fontWeight:800,letterSpacing:'.08em',fontSize:13,padding:'3px 9px',borderRadius:4}}>{txt || '—'}</span>
  );
  const fmtTime = (t) => t ? new Date(t).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) : '—';
  // tag_expiration is a bare "YYYY-MM-DD" date — parse as local (not UTC) so the
  // displayed day doesn't shift backwards in western timezones.
  const fmtTagDate = (d) => {
    if (!d) return '';
    const [y, m, day] = String(d).split('-').map(Number);
    if (!y || !m || !day) return d;
    return new Date(y, m - 1, day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  const docButtons = (row, kind) => {
    const docs = [
      ['id', 'ID', row.has_id],
      ['lease', 'Lease', row.has_lease],
      ['plate', 'Plate', row.has_plate],
    ].filter(([, , present]) => present);
    if (docs.length === 0) return <span style={{fontSize:11,color:'var(--text-faint)'}}>No documents</span>;
    return (
      <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
        {docs.map(([which, label]) => {
          const key = `${kind}:${row.id}:${which}`;
          return (
            <button key={which} disabled={docBusy === key}
              onClick={() => viewDoc(kind, row.id, which, label)}
              style={{fontSize:11,fontWeight:700,padding:'3px 9px',borderRadius:6,border:'1px solid var(--border)',background:'var(--bg-inset)',color:'var(--text-primary)',cursor:docBusy===key?'wait':'pointer',opacity:docBusy===key?0.6:1}}>
              {docBusy === key ? 'Loading…' : `View ${label}`}
            </button>
          );
        })}
      </div>
    );
  };

  return (
    <div style={{display:'flex',flexDirection:'column',gap:18}}>
      {feedbackOpen && <FeedbackModal propertyId={propertyId} onClose={() => setFeedbackOpen(false)} />}
      {docView && <DocViewerModal blob={docView.blob} label={docView.label} onClose={() => setDocView(null)} />}
      {/* ── Pending approval queue ── */}
      <div>
        <div className="pd-section-head">
          <div style={{display:'flex',alignItems:'baseline',gap:8}}>
            <span className="pd-section-title">Pending approval</span>
            <span className="pd-section-count">{pending.length}</span>
          </div>
          <div style={{display:'flex',gap:8,flexWrap:'wrap',justifyContent:'flex-end'}}>
            <button onClick={() => setFeedbackOpen(true)} className="pd-share-btn">Feedback</button>
            <button onClick={refresh} className="pd-share-btn">Refresh</button>
          </div>
        </div>
        {loading ? (
          <div className="pd-empty">Loading…</div>
        ) : loadErr ? (
          <div className="pd-empty" style={{color:'#b45309'}}>
            Couldn't load the approval queue — this is not "nothing pending".{' '}
            <button onClick={refresh} className="pd-share-btn" style={{marginLeft:6}}>Retry</button>
          </div>
        ) : pending.length === 0 ? (
          <div className="pd-empty">
            {property?.guest_auto_approve
              ? 'Short-term passes approve automatically at this property — only long-term registrations appear here.'
              : 'Nothing waiting for review'}
          </div>
        ) : (
          <div style={{display:'flex',flexDirection:'column',gap:6}}>
            {pending.map(row => {
              const kind = row._kind;
              const rowKey = `${kind}:${row.id}`;
              const unit = kind === 'resident' ? row.unit_number : row.host_unit;
              const name = kind === 'resident' ? row.holder_name : row.visitor_name;
              return (
                <div key={rowKey} style={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8,padding:'10px 12px',display:'flex',flexDirection:'column',gap:8}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:10,flexWrap:'wrap'}}>
                    <div style={{minWidth:0,flex:1}}>
                      <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
                        {plateChip(row.plate_text)}
                        <span style={{fontSize:10,fontWeight:700,letterSpacing:'.06em',textTransform:'uppercase',padding:'2px 7px',borderRadius:20,background:kind==='resident'?'rgba(96,165,250,.12)':'rgba(192,132,252,.12)',color:kind==='resident'?'#60a5fa':'#c084fc',border:kind==='resident'?'1px solid rgba(96,165,250,.3)':'1px solid rgba(192,132,252,.3)'}}>{kind === 'resident' ? 'Long-term' : 'Short-term'}</span>
                        {unit && <span style={{fontSize:12,color:'var(--text-primary)',fontWeight:600}}>Unit {unit}</span>}
                        {name && <span style={{fontSize:12,color:'var(--text-primary)',fontWeight:600}}>{name}</span>}
                      </div>
                      <div style={{fontSize:11,color:'var(--text-faint)',marginTop:3}}>
                        Submitted {fmtTime(row.created_at)}{row.phone ? ` · ${row.phone}` : ''}{row.email ? ` · ${row.email}` : ''}
                      </div>
                    </div>
                  </div>
                  {docButtons(row, kind)}
                  <div style={{display:'flex',gap:8}}>
                    <button disabled={busy === rowKey} onClick={() => approve(kind, row.id)}
                      style={{flex:1,fontSize:12,fontWeight:700,padding:'7px',borderRadius:6,border:'1px solid rgba(74,222,128,.3)',background:'rgba(74,222,128,.12)',color:'#4ade80',cursor:busy===rowKey?'wait':'pointer',opacity:busy===rowKey?0.6:1}}>
                      {busy === rowKey ? 'Working…' : 'Approve'}
                    </button>
                    <button disabled={busy === rowKey} onClick={() => reject(kind, row.id)}
                      style={{flex:1,fontSize:12,fontWeight:700,padding:'7px',borderRadius:6,border:'1px solid rgba(239,68,68,.3)',background:'rgba(239,68,68,.1)',color:'#ef4444',cursor:busy===rowKey?'wait':'pointer',opacity:busy===rowKey?0.6:1}}>
                      Reject
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Approved residents ── */}
      <div>
        <div className="pd-section-head">
          <div style={{display:'flex',alignItems:'baseline',gap:8}}>
            <span className="pd-section-title">Long-term passes</span>
            <span className="pd-section-count">{approvedResidents.length}</span>
          </div>
        </div>
        {loadErr ? (
          <div className="pd-empty" style={{color:'#b45309'}}>Couldn't load — the list below may be incomplete.</div>
        ) : !loading && approvedResidents.length === 0 ? (
          <div className="pd-empty">No long-term passes yet</div>
        ) : (
          <div style={{display:'flex',flexDirection:'column',gap:6}}>
            {approvedResidents.map(r => {
              const rowKey = `resident:${r.id}`;
              return (
                <div key={rowKey} style={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8,padding:'10px 12px',display:'flex',justifyContent:'space-between',alignItems:'center',gap:10,flexWrap:'wrap'}}>
                  <div style={{minWidth:0,flex:1,display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
                    {plateChip(r.plate_text)}
                    {r.unit_number && <span style={{fontSize:12,color:'var(--text-primary)',fontWeight:600}}>Unit {r.unit_number}</span>}
                    {r.holder_name && <span style={{fontSize:12,color:'var(--text-muted)'}}>{r.holder_name}</span>}
                  </div>
                  <button disabled={busy === rowKey} onClick={() => voidPass('resident', r.id)}
                    style={{fontSize:11,fontWeight:700,padding:'5px 10px',borderRadius:6,border:'1px solid rgba(239,68,68,.3)',background:'rgba(239,68,68,.1)',color:'#ef4444',cursor:busy===rowKey?'wait':'pointer',opacity:busy===rowKey?0.6:1}}>
                    Void
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Active guests ── */}
      <div>
        <div className="pd-section-head">
          <div style={{display:'flex',alignItems:'baseline',gap:8}}>
            <span className="pd-section-title">Short-term passes</span>
            <span className="pd-section-count">{activeGuests.length}</span>
          </div>
        </div>
        {loadErr ? (
          <div className="pd-empty" style={{color:'#b45309'}}>Couldn't load — the list below may be incomplete.</div>
        ) : !loading && activeGuests.length === 0 ? (
          <div className="pd-empty">No short-term passes yet</div>
        ) : (
          <div style={{display:'flex',flexDirection:'column',gap:6}}>
            {activeGuests.map(g => {
              const rowKey = `guest:${g.id}`;
              const remainMs = g.valid_until ? new Date(g.valid_until).getTime() - nowTick : 0;
              const urgent = remainMs > 0 && remainMs < 60 * 60 * 1000;
              return (
                <div key={rowKey} style={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8,padding:'10px 12px',display:'flex',justifyContent:'space-between',alignItems:'center',gap:10,flexWrap:'wrap'}}>
                  <div style={{minWidth:0,flex:1}}>
                    <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
                      {plateChip(g.plate_text)}
                      {g.host_unit && <span style={{fontSize:12,color:'var(--text-primary)',fontWeight:600}}>Unit {g.host_unit}</span>}
                      {g.visitor_name && <span style={{fontSize:12,color:'var(--text-muted)'}}>{g.visitor_name}</span>}
                      {g.is_temp_tag && (
                        <span style={{fontSize:11,fontWeight:700,padding:'3px 8px',borderRadius:20,background:'rgba(148,163,184,.15)',color:'var(--text-muted)',border:'1px solid var(--border)',whiteSpace:'nowrap'}}>Temp tag</span>
                      )}
                      {g.tag_expired && (
                        <span style={{fontSize:11,fontWeight:700,padding:'3px 8px',borderRadius:20,background:'rgba(239,68,68,.12)',color:'#ef4444',border:'1px solid rgba(239,68,68,.3)',whiteSpace:'nowrap'}}>EXPIRED</span>
                      )}
                    </div>
                    <div style={{fontSize:11,color:'var(--text-faint)',marginTop:3}}>
                      {g.valid_until ? <>Expires {fmtTime(g.valid_until)}</> : 'No expiry'}
                      {g.is_temp_tag && g.tag_expiration && <> · tag expires {fmtTagDate(g.tag_expiration)}</>}
                    </div>
                  </div>
                  <div style={{display:'flex',alignItems:'center',gap:8}}>
                    {g.valid_until && (
                      <span style={{fontSize:11,fontWeight:700,padding:'4px 10px',borderRadius:20,whiteSpace:'nowrap',background:urgent?'rgba(251,191,36,.12)':'rgba(74,222,128,.12)',color:urgent?'#fbbf24':'#4ade80',border:urgent?'1px solid rgba(251,191,36,.25)':'1px solid rgba(74,222,128,.25)'}}>{fmtPassRemaining(remainMs)}</span>
                    )}
                    <button disabled={busy === rowKey} onClick={() => extend(g.id)}
                      style={{fontSize:11,fontWeight:700,padding:'5px 10px',borderRadius:6,border:'1px solid var(--border)',background:'var(--bg-inset)',color:'var(--text-primary)',cursor:busy===rowKey?'wait':'pointer',opacity:busy===rowKey?0.6:1}}>
                      Extend
                    </button>
                    <button disabled={busy === rowKey} onClick={() => voidPass('guest', g.id)}
                      style={{fontSize:11,fontWeight:700,padding:'5px 10px',borderRadius:6,border:'1px solid rgba(239,68,68,.3)',background:'rgba(239,68,68,.1)',color:'#ef4444',cursor:busy===rowKey?'wait':'pointer',opacity:busy===rowKey?0.6:1}}>
                      Void
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
