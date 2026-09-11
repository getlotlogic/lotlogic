import React from 'react';
import { fmtMoney } from '../lib/format.js';

// ── Owner Overview page — per-operator stats + "View as" ──────
export function OverviewPage({ violations, lots, partners, lotStates, onViewAs }) {
  const lotMap = Object.fromEntries(lots.map(l => [l.id, l]));

  // Map partner_id → lots assigned
  const partnerLots = {};
  lots.forEach(l => {
    if (l.partner_id) {
      if (!partnerLots[l.partner_id]) partnerLots[l.partner_id] = [];
      partnerLots[l.partner_id].push(l);
    }
  });

  // Global KPIs
  const _activeStatuses = ['pending', 'alerted', 'acknowledged'];
  const _closedStatuses = ['resolved', 'cleared', 'departed'];
  const pending = violations.filter(v => _activeStatuses.includes(v.status)).length;
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const todayResolved = violations.filter(v => _closedStatuses.includes(v.status) && new Date(v.resolved_at || v.cleared_at || v.detected_at) >= todayStart).length;
  const totalGross = violations.filter(v => _closedStatuses.includes(v.status)).reduce((s, v) => s + (v.gross_revenue || 0), 0);
  const totalOurs = violations.filter(v => _closedStatuses.includes(v.status)).reduce((s, v) => s + (v.our_revenue || 0), 0);

  // Camera stats
  const allCams = Object.values(lotStates).flatMap(s => s?.cameras || []);
  const camsOnline = allCams.filter(c => c.online).length;
  const camsTotal = allCams.length;

  // Per-operator stats
  const operatorStats = partners.map(p => {
    const pLots = partnerLots[p.id] || [];
    const pLotIds = pLots.map(l => l.id);
    const pViols = violations.filter(v => pLotIds.includes(v.lot_id));
    const pPending = pViols.filter(v => _activeStatuses.includes(v.status)).length;
    const pResolved = pViols.filter(v => _closedStatuses.includes(v.status));
    const pTodayResolved = pResolved.filter(v => new Date(v.resolved_at || v.detected_at) >= todayStart).length;
    const pGross = pResolved.reduce((s, v) => s + (v.gross_revenue || 0), 0);
    const pOurs = pResolved.reduce((s, v) => s + (v.our_revenue || 0), 0);
    const pPartnerPay = pGross - pOurs;
    const booted = pResolved.filter(v => v.action_taken === 'boot').length;
    const towed = pResolved.filter(v => v.action_taken === 'tow').length;
    const dismissed = pResolved.filter(v => v.action_taken === 'dismissed' || v.action_taken === 'already_gone' || v.action_taken === 'no_action').length;
    // Avg response time (detected → resolved) in minutes
    const responseTimes = pResolved.filter(v => v.detected_at && v.resolved_at).map(v => (new Date(v.resolved_at) - new Date(v.detected_at)) / 60000);
    const avgResponse = responseTimes.length > 0 ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length) : null;

    return { partner: p, lots: pLots, pending: pPending, todayResolved: pTodayResolved, totalResolved: pResolved.length, gross: pGross, ours: pOurs, partnerPay: pPartnerPay, booted, towed, dismissed, avgResponse };
  });

  return (
    <div className="page-enter">
      <div className="section-header">
        <div className="section-title">Overview</div>
        <div className="section-count">{lots.length} lot{lots.length !== 1 ? 's' : ''} · {partners.length} operator{partners.length !== 1 ? 's' : ''}</div>
      </div>

      {/* Global KPIs */}
      <div className="kpi-bar" style={{marginBottom:16}}>
        <div className="kpi-card">
          <div className="kpi-val red">{pending}</div>
          <div className="kpi-label">Active</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-val green">{todayResolved}</div>
          <div className="kpi-label">Resolved Today</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-val blue">{camsOnline}/{camsTotal}</div>
          <div className="kpi-label">Cameras</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-val green">{fmtMoney(totalOurs)}</div>
          <div className="kpi-label">Revenue</div>
        </div>
      </div>

      {/* Per-operator cards */}
      <div className="section-header" style={{marginTop:20}}>
        <div className="section-title">Operators</div>
      </div>

      {operatorStats.length === 0 ? (
        <div className="empty-state">
          <div style={{width:48, height:48, borderRadius:12, background:'rgba(59,130,246,.1)', display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 12px', fontSize:22}}>👥</div>
          <div className="empty-title">No operators assigned</div>
          <div className="empty-body">Enforcement partners linked to your lots will appear here</div>
        </div>
      ) : operatorStats.map(os => (
        <div key={os.partner.id} className="card-animated" style={{
          background:'var(--bg-card)', border:'1px solid var(--border)', borderRadius:14,
          marginBottom:12, overflow:'hidden',
        }}>
          {/* Operator header */}
          <div style={{padding:'14px 16px 10px', display:'flex', justifyContent:'space-between', alignItems:'flex-start'}}>
            <div>
              <div style={{fontSize:16, fontWeight:800, color:'var(--text-primary)'}}>{os.partner.company_name || os.partner.contact_name}</div>
              <div style={{fontSize:12, color:'var(--text-faint)', marginTop:2}}>{os.partner.email} · {os.lots.length} lot{os.lots.length !== 1 ? 's' : ''}</div>
            </div>
            <button onClick={() => onViewAs(os.partner)} style={{
              background:'rgba(59,130,246,.1)', color:'#3b82f6', border:'1px solid rgba(59,130,246,.25)',
              borderRadius:8, padding:'6px 12px', fontSize:12, fontWeight:700, cursor:'pointer',
              whiteSpace:'nowrap',
            }}>
              View as Partner
            </button>
          </div>

          {/* Operator KPIs */}
          <div style={{display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:1, background:'var(--border)'}}>
            <div style={{background:'var(--bg-card)', padding:'10px 8px', textAlign:'center'}}>
              <div style={{fontSize:18, fontWeight:800, color:'var(--red)'}}>{os.pending}</div>
              <div style={{fontSize:10, fontWeight:600, color:'var(--text-faint)', textTransform:'uppercase', letterSpacing:'.04em'}}>Pending</div>
            </div>
            <div style={{background:'var(--bg-card)', padding:'10px 8px', textAlign:'center'}}>
              <div style={{fontSize:18, fontWeight:800, color:'var(--green)'}}>{os.todayResolved}</div>
              <div style={{fontSize:10, fontWeight:600, color:'var(--text-faint)', textTransform:'uppercase', letterSpacing:'.04em'}}>Today</div>
            </div>
            <div style={{background:'var(--bg-card)', padding:'10px 8px', textAlign:'center'}}>
              <div style={{fontSize:18, fontWeight:800, color:'var(--text-primary)'}}>{os.totalResolved}</div>
              <div style={{fontSize:10, fontWeight:600, color:'var(--text-faint)', textTransform:'uppercase', letterSpacing:'.04em'}}>All Time</div>
            </div>
            <div style={{background:'var(--bg-card)', padding:'10px 8px', textAlign:'center'}}>
              <div style={{fontSize:18, fontWeight:800, color:'var(--green)'}}>{fmtMoney(os.partnerPay)}</div>
              <div style={{fontSize:10, fontWeight:600, color:'var(--text-faint)', textTransform:'uppercase', letterSpacing:'.04em'}}>Paid Out</div>
            </div>
          </div>

          {/* Action breakdown + fees */}
          <div style={{padding:'10px 16px 14px', display:'flex', flexWrap:'wrap', gap:8, alignItems:'center'}}>
            {os.booted > 0 && <span style={{padding:'3px 10px', borderRadius:20, fontSize:11, fontWeight:700, color:'#fbbf24', background:'rgba(251,191,36,.1)', border:'1px solid rgba(251,191,36,.2)'}}>Boot ×{os.booted}</span>}
            {os.towed > 0 && <span style={{padding:'3px 10px', borderRadius:20, fontSize:11, fontWeight:700, color:'#f87171', background:'rgba(248,113,113,.1)', border:'1px solid rgba(248,113,113,.2)'}}>Tow ×{os.towed}</span>}
            {os.dismissed > 0 && <span style={{padding:'3px 10px', borderRadius:20, fontSize:11, fontWeight:700, color:'#a78bfa', background:'rgba(167,139,250,.1)', border:'1px solid rgba(167,139,250,.2)'}}>Dismissed ×{os.dismissed}</span>}
            {os.avgResponse != null && <span style={{padding:'3px 10px', borderRadius:20, fontSize:11, fontWeight:600, color:'var(--text-muted)', background:'var(--bg-inset)', border:'1px solid var(--border)'}}>Avg {os.avgResponse < 60 ? `${os.avgResponse}m` : `${Math.round(os.avgResponse / 60)}h`} response</span>}
            <span style={{marginLeft:'auto', fontSize:11, color:'var(--text-faint)'}}>
              Boot ${os.partner.boot_fee || 75} · Tow ${os.partner.tow_fee || 250} · {Math.round((os.partner.revenue_share || 0.3) * 100)}% share
            </span>
          </div>

          {/* Tow-truck plates registered for this partner. Camera-based
              tow-confirm correlates these against partner_truck_sightings
              when an enforcement vehicle passes through the property —
              that auto-releases billing without manual review. Surfacing
              them here lets owners spot a partner whose registered list
              is missing a truck (new vehicle in fleet) so the correlation
              keeps working. Empty list = warning. */}
          <div style={{padding:'0 16px 14px', display:'flex', alignItems:'flex-start', gap:10, flexWrap:'wrap'}}>
            <div style={{fontSize:10, fontWeight:700, color:'var(--text-faint)', letterSpacing:'.06em', textTransform:'uppercase', marginTop:6, flexShrink:0}}>
              Tow-truck plates
            </div>
            <div style={{flex:'1 1 200px', display:'flex', flexWrap:'wrap', gap:6}}>
              {(os.partner.tow_truck_plates || []).length === 0 ? (
                <span style={{fontSize:11, fontWeight:600, color:'#b45309', background:'rgba(251,191,36,.12)', border:'1px solid rgba(251,191,36,.35)', borderRadius:14, padding:'8px 12px',minHeight:36}}>
                  ⚠ none registered — every tow requires manual confirm
                </span>
              ) : (
                (os.partner.tow_truck_plates || []).map((plate, i) => (
                  <span key={i} style={{fontSize:12, fontWeight:800, fontFamily:"'Courier New',monospace", letterSpacing:'.05em', color:'var(--text-primary)', background:'var(--bg-inset)', border:'1px solid var(--border)', borderRadius:6, padding:'4px 10px'}}>
                    {plate}
                  </span>
                ))
              )}
            </div>
          </div>
        </div>
      ))}

      {/* Revenue split summary */}
      {totalGross > 0 && (
        <div className="earnings-breakdown" style={{marginTop:8, marginBottom:16}}>
          <div className="breakdown-header">Revenue Split (All Time)</div>
          <div className="breakdown-row">
            <div style={{display:'flex', alignItems:'center', gap:8}}>
              <span style={{width:8, height:8, borderRadius:'50%', background:'var(--green)', flexShrink:0}} />
              <span style={{fontSize:15, fontWeight:700, color:'var(--text-primary)'}}>Gross Revenue</span>
            </div>
            <div style={{fontSize:15, fontWeight:700, color:'var(--green)'}}>{fmtMoney(totalGross)}</div>
          </div>
          <div className="breakdown-row">
            <div style={{display:'flex', alignItems:'center', gap:8}}>
              <span style={{width:8, height:8, borderRadius:'50%', background:'var(--accent)', flexShrink:0}} />
              <span style={{fontSize:15, fontWeight:700, color:'var(--text-primary)'}}>LotLogic Cut</span>
            </div>
            <div style={{fontSize:15, fontWeight:700, color:'var(--accent)'}}>{fmtMoney(totalOurs)}</div>
          </div>
          {operatorStats.map(os => os.partnerPay > 0 && (
            <div key={os.partner.id} className="breakdown-row">
              <div style={{display:'flex', alignItems:'center', gap:8}}>
                <span style={{width:8, height:8, borderRadius:'50%', background:'#a78bfa', flexShrink:0}} />
                <span style={{fontSize:15, fontWeight:700, color:'var(--text-primary)'}}>{os.partner.company_name || os.partner.contact_name}</span>
              </div>
              <div style={{fontSize:15, fontWeight:700, color:'#a78bfa'}}>{fmtMoney(os.partnerPay)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
