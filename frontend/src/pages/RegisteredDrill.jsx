import React from 'react';
const { useState, useEffect, useCallback, useRef, useMemo, memo } = React;
import { apiFetch } from '../lib/api.js';
import { useActiveRoster, useNowTick } from '../hooks.js';
import { useToast } from '../ui/Toast.jsx';

// ── RegisteredDrill — Active parking passes drill-down ───────────────────────
// Lists currently-registered parking passes from the shared useActiveRoster
// source (same data as the Truck Parking Log roster + the Lots "Registered"
// count). Shows plate, holder name, duration info, parking spot if present,
// and a green ACTIVE indicator.
export function RegisteredDrill({ propertyId, propertyName, onBack }) {
  const { addToast } = useToast();
  // Single source of truth — identical data to the Truck Parking Log roster and
  // the Lots "Registered" count. Realtime + 60s poll + keep-last-on-error are
  // all handled by the shared hook, so this screen can never disagree with the
  // others. Aliased to the names the rest of this component already uses.
  const { roster: rows, loading, error: err, refresh: load } = useActiveRoster(propertyId);
  const [confirmId, setConfirmId] = useState(null);
  const [acting, setActing] = useState(null);
  const nowTick = useNowTick(60000);

  // Compute human-readable pass duration. Rows are raw visitor_passes, so the
  // expiry is valid_until (expires_at kept as a fallback for safety).
  function passExpiryLabel(row) {
    const expiry = row.valid_until || row.expires_at;
    if (!expiry) return 'No expiry';
    const ms = new Date(expiry) - Date.now();
    if (ms <= 0) return 'Expired';
    const totalMins = Math.ceil(ms / 60000);
    if (totalMins < 60) return `Expires in ${totalMins}m`;
    const h = Math.floor(totalMins / 60);
    const m = totalMins % 60;
    return `Expires in ${h}h${m > 0 ? ` ${m}m` : ''}`;
  }

  async function removeRow(row) {
    setActing(row.id);
    try {
      // The roster is active visitor_passes only, so cancel always soft-cancels
      // the visitor pass. The shared hook re-pulls via realtime + the load()
      // below, so the row drops from every surface at once.
      await apiFetch(`/visitor_passes/${row.id}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'operator removed via dashboard' }),
      });
      addToast('Parking pass removed', 'success');
      load();
    } catch (e) {
      addToast('Remove failed: ' + (e?.message || ''), 'error');
    } finally {
      setActing(null);
      setConfirmId(null);
    }
  }

  return (
    <div className="page-enter">
      <div className="drill-paper">
        <header className="drill-head-paper">
          <div className="title">Registered{propertyName ? ` · ${propertyName}` : ''}</div>
          <button className="back" onClick={onBack}>‹ Back</button>
        </header>

        {/* Non-blocking refresh error — keep whatever roster we last had on
            screen and offer a retry, never a misleading empty state. */}
        {err && (
          <div style={{margin:'0 0 10px',padding:'10px 12px',background:'rgba(245,158,11,.1)',border:'1px solid rgba(245,158,11,.35)',borderRadius:8,color:'var(--ink-1-paper, var(--text-primary))',fontSize:12,display:'flex',alignItems:'center',gap:10,flexWrap:'wrap'}}>
            <span>Couldn't refresh — showing the last known roster.</span>
            <button type="button" onClick={() => load()} style={{fontSize:12,fontWeight:700,padding:'8px 12px',minHeight:36,borderRadius:6,border:'1px solid var(--border)',background:'transparent',color:'inherit',cursor:'pointer',fontFamily:'inherit'}}>Retry now</button>
          </div>
        )}

        {loading ? (
          <div style={{padding:'24px 16px',textAlign:'center',color:'var(--ink-3-paper)',fontSize:14}}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{padding:'24px 16px',textAlign:'center',color:'var(--ink-3-paper)',fontSize:14}}>{err ? "Couldn't load the roster — tap Retry above." : 'No active parking passes'}</div>
        ) : rows.map((row, i) => {
          const isConfirming = confirmId === row.id;
          const isActing = acting === row.id;
          return (
            <div key={row.id || i} className="reg-row-paper">
              <span className="plate-tag-paper" style={{fontSize:13,padding:'5px 9px'}}>{(row.plate_text || row.raw_plate || row.normalized_plate || '—').replace(/([A-Z0-9]{3})([A-Z0-9]+)/, '$1 $2')}</span>
              <div>
                <div className="reg-name-paper">{row.visitor_name || row.driver_name || row.company_name || 'Unknown'}</div>
                <div className="reg-detail-paper">
                  {passExpiryLabel(row)}{(row.parking_spot || row.space_number) ? ` · Space #${row.parking_spot || row.space_number}` : ''}
                </div>
              </div>
              <div className="reg-time-paper" style={{display:'flex',flexDirection:'column',alignItems:'flex-end',gap:6}}>
                {isConfirming ? (
                  <div style={{display:'flex',gap:6}}>
                    <button onClick={() => removeRow(row)} disabled={isActing} aria-label="Confirm remove" style={{fontSize:11,fontWeight:700,padding:'5px 10px',borderRadius:6,border:'1px solid var(--red-paper)',background:'var(--red-paper)',color:'var(--card-paper)',cursor:isActing?'wait':'pointer',letterSpacing:'.02em'}}>{isActing ? '…' : 'Confirm'}</button>
                    <button onClick={() => setConfirmId(null)} disabled={isActing} aria-label="Keep" style={{fontSize:11,fontWeight:600,padding:'5px 10px',borderRadius:6,border:'1px solid var(--border-strong-paper)',background:'var(--card-paper)',color:'var(--ink-paper)',cursor:'pointer'}}>Keep</button>
                  </div>
                ) : (
                  <>
                    <span className="reg-live-paper">● ACTIVE</span>
                    <div style={{display:'flex',alignItems:'center',gap:8}}>
                      {(row.valid_from || row.starts_at) && <span style={{fontSize:11,color:'var(--ink-3-paper)'}}>Since {new Date(row.valid_from || row.starts_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>}
                      <button onClick={() => setConfirmId(row.id)} aria-label="Remove parking pass" style={{fontSize:12,fontWeight:600,padding:'8px 12px',minHeight:36,borderRadius:6,border:'1px solid var(--border-strong-paper)',background:'transparent',color:'var(--red-paper)',cursor:'pointer',letterSpacing:'.02em'}}>Remove</button>
                    </div>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
