import React, { useState } from 'react';
import { fmtMoney, smartDate, fmtTime } from '../lib/format.js';
import { displayColor, colorHex } from '../lib/vehicles.js';

export function EarningsPage({ violations, lots, isOwner, user, onNavigate }) {
  const [period, setPeriod] = useState('month');
  const lotMap = Object.fromEntries(lots.map(l => [l.id, l]));

  // Invoicable-this-week summary (owner only): resolved tows in the last 7 days
  // that have not yet been stamped with invoiced_at and produced gross revenue.
  // This is the hand-off to the Billing tab.
  const weekCutoff = Date.now() - 7 * 86400000;
  const invoicableTows = isOwner ? violations.filter(v =>
    v.action_taken === 'tow'
    && v.status !== 'pending'
    && (v.gross_revenue || 0) > 0
    && !v.invoiced_at
    && new Date(v.resolved_at || v.detected_at).getTime() >= weekCutoff
  ) : [];
  const invoicableGross = invoicableTows.reduce((s, v) => s + (v.gross_revenue || 0), 0);

  const periodLabels = { week: 'This Week', month: 'This Month', all: 'All Time' };

  // Compute stats from the already-filtered violations prop (scoped to this user's lots)
  const now = Date.now();
  const cutoffs = { week: now - 7 * 86400000, month: now - 30 * 86400000, all: 0 };
  const periodViols = violations.filter(v => {
    const ts = new Date(v.resolved_at || v.detected_at).getTime();
    return ts >= cutoffs[period];
  });
  const resolved = periodViols.filter(v => v.action_taken && v.status !== 'pending')
    .sort((a, b) => new Date(b.resolved_at || b.detected_at) - new Date(a.resolved_at || a.detected_at));

  const totalOurs = resolved.reduce((s, v) => s + (v.our_revenue || 0), 0);
  const totalGross = resolved.reduce((s, v) => s + (v.gross_revenue || 0), 0);
  const totalViolations = periodViols.length;
  const actionsExecuted = resolved.filter(v => !['pending', 'plate_correction'].includes(v.action_taken)).length;
  const actionRate = totalViolations > 0 ? actionsExecuted / totalViolations : 0;

  // Action breakdown from local data
  const byAction = {};
  resolved.forEach(v => { if (v.action_taken && !['pending', 'plate_correction'].includes(v.action_taken)) byAction[v.action_taken] = (byAction[v.action_taken] || 0) + 1; });
  const actionEntries = Object.entries(byAction).filter(([k, v]) => v > 0 && k !== 'pending');

  // Per-lot breakdown for owners
  const byLot = {};
  resolved.forEach(v => {
    if (!byLot[v.lot_id]) byLot[v.lot_id] = { lot_id: v.lot_id, our_revenue_cents: 0, actions: 0 };
    byLot[v.lot_id].our_revenue_cents += (v.our_revenue || 0);
    byLot[v.lot_id].actions += 1;
  });
  const byLotEntries = Object.values(byLot).filter(e => e.actions > 0);

  // Daily earnings for bar chart (last 7 days)
  const dailyEarnings = [];
  for (let i = 6; i >= 0; i--) {
    const dayStart = new Date(); dayStart.setHours(0,0,0,0); dayStart.setDate(dayStart.getDate() - i);
    const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
    const dayViols = resolved.filter(v => {
      const ts = new Date(v.resolved_at || v.detected_at);
      return ts >= dayStart && ts < dayEnd;
    });
    const dayRev = dayViols.reduce((s, v) => s + (v.our_revenue || 0), 0);
    dailyEarnings.push({
      label: dayStart.toLocaleDateString('en-US', { weekday: 'short' }),
      value: dayRev,
      count: dayViols.length,
    });
  }
  const maxDailyRev = Math.max(...dailyEarnings.map(d => d.value), 1);

  return (
    <div className="page-enter">
      {/* Period picker */}
      <div className="earnings-period-row">
        {['week','month','all'].map(p => (
          <button key={p} className={`period-btn ${period === p ? 'active' : ''}`} onClick={() => setPeriod(p)}>
            {periodLabels[p]}
          </button>
        ))}
      </div>

      {/* Hero total */}
      <div className="earnings-hero">
        <div className="earnings-label">{periodLabels[period]} {isOwner ? 'Earnings' : 'Your Earnings'}</div>
        <div className="earnings-amount">
          <span>$</span>{(totalOurs / 100).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}
        </div>
        <div className="earnings-sub">
          {actionsExecuted} job{actionsExecuted !== 1 ? 's' : ''} completed
          {isOwner ? ` · ${fmtMoney(totalGross)} gross` : ''}
        </div>
        {!isOwner && totalGross > 0 && (
          <div style={{marginTop:12, display:'flex', gap:8, justifyContent:'center'}}>
            <div style={{background:'var(--bg-inset)', border:'1px solid var(--border)', borderRadius:8, padding:'6px 12px', fontSize:12}}>
              <span style={{color:'var(--text-muted)'}}>Gross </span>
              <strong style={{color:'var(--text-primary)'}}>{fmtMoney(totalGross)}</strong>
            </div>
            <div style={{background:'var(--bg-inset)', border:'1px solid var(--border)', borderRadius:8, padding:'6px 12px', fontSize:12}}>
              <span style={{color:'var(--text-muted)'}}>Partner </span>
              <strong style={{color:'var(--green)'}}>{fmtMoney(totalGross - totalOurs)}</strong>
            </div>
            <div style={{background:'var(--bg-inset)', border:'1px solid var(--border)', borderRadius:8, padding:'6px 12px', fontSize:12}}>
              <span style={{color:'var(--text-muted)'}}>LotLogic </span>
              <strong style={{color:'var(--accent)'}}>{fmtMoney(totalOurs)}</strong>
            </div>
          </div>
        )}
      </div>

      {/* Invoicable tows (owner only) — handoff to Billing */}
      {isOwner && invoicableTows.length > 0 && (
        <div
          onClick={() => onNavigate && onNavigate('invoices')}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onNavigate && onNavigate('invoices'); } }}
          style={{
            background: 'linear-gradient(90deg, rgba(59,130,246,.12), rgba(59,130,246,.04))',
            border: '1px solid rgba(59,130,246,.35)',
            borderRadius: 12,
            padding: 14,
            marginBottom: 16,
            cursor: onNavigate ? 'pointer' : 'default',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <div>
            <div style={{fontSize: 13, color: 'var(--text-muted)', marginBottom: 2}}>Invoicable this week</div>
            <div style={{fontSize: 18, fontWeight: 800, color: 'var(--text-primary)'}}>
              {invoicableTows.length} tow{invoicableTows.length !== 1 ? 's' : ''} · {fmtMoney(invoicableGross)}
            </div>
          </div>
          <div style={{fontSize: 13, color: 'var(--accent)', fontWeight: 700, whiteSpace: 'nowrap'}}>
            Review &amp; invoice →
          </div>
        </div>
      )}

      {/* KPI cards */}
      <div className="kpi-bar" style={{marginBottom:16}}>
        <div className="kpi-card">
          <div className="kpi-val blue">{totalViolations}</div>
          <div className="kpi-label">Recently expired</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-val green">{actionsExecuted}</div>
          <div className="kpi-label">Actioned</div>
        </div>
        <div className="kpi-card">
          <div className={`kpi-val ${actionRate >= 0.5 ? 'green' : actionRate >= 0.2 ? 'yellow' : 'red'}`}>
            {Math.round(actionRate * 100)}%
          </div>
          <div className="kpi-label">Action Rate</div>
        </div>
      </div>

      {/* Weekly earnings bar chart */}
      {period !== 'all' && (
        <div className="earnings-breakdown" style={{marginBottom:16}}>
          <div className="breakdown-header">Daily Earnings (Last 7 Days)</div>
          <div style={{padding:'12px 16px'}}>
            {dailyEarnings.map((d, i) => (
              <div key={i} className="bar-chart-row">
                <div className="bar-chart-label">{d.label}</div>
                <div className="bar-chart-track">
                  <div className="bar-chart-fill" style={{
                    width: `${Math.max((d.value / maxDailyRev) * 100, d.value > 0 ? 8 : 0)}%`,
                    background: d.value > 0 ? 'linear-gradient(90deg, #FBBF24, #C4940F)' : 'transparent',
                  }}>
                    {d.value > 0 && fmtMoney(d.value)}
                  </div>
                </div>
                <div className="bar-chart-value">{d.count} job{d.count !== 1 ? 's' : ''}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Action breakdown */}
      {actionEntries.length > 0 && (
        <div className="earnings-breakdown" style={{marginBottom:16}}>
          <div className="breakdown-header">By Action</div>
          {actionEntries.map(([action, count]) => {
            const colors = { boots: '#fbbf24', tows: '#f87171', dismissed: '#a78bfa', no_action: '#6b7280', already_gone: '#6b7280' };
            return (
              <div key={action} className="breakdown-row">
                <div style={{display:'flex', alignItems:'center', gap:8}}>
                  <span style={{width:8, height:8, borderRadius:'50%', background: colors[action] || '#6b7280', flexShrink:0}} />
                  <span style={{fontSize:15, fontWeight:700, color:'var(--text-primary)', textTransform:'capitalize'}}>{action.replace(/_/g, ' ')}</span>
                </div>
                <div style={{fontSize:15, fontWeight:700, color:'var(--text-muted)'}}>{count}×</div>
              </div>
            );
          })}
        </div>
      )}

      {/* Per-lot breakdown (owner only) */}
      {isOwner && byLotEntries.length > 0 && (
        <div className="earnings-breakdown" style={{marginBottom:16}}>
          <div className="breakdown-header">By Lot</div>
          {byLotEntries.map(item => {
            const lot = lotMap[item.lot_id];
            return (
              <div key={item.lot_id} className="breakdown-row">
                <div>
                  <div style={{fontSize:14, fontWeight:600, color:'var(--text-primary)'}}>{lot?.name || item.lot_id?.slice(0,8)}</div>
                  <div style={{fontSize:12, color:'var(--text-faint)'}}>{item.actions} action{item.actions !== 1 ? 's' : ''}</div>
                </div>
                <div className="breakdown-amt">{fmtMoney(item.our_revenue_cents)}</div>
              </div>
            );
          })}
        </div>
      )}

      {/* Line items */}
      {resolved.length === 0 ? (
        <div className="empty-state">
          <div className="empty-title">No earnings yet {period !== 'all' ? 'this period' : ''}</div>
          <div className="empty-body">Completed jobs will show up here</div>
        </div>
      ) : (
        <div className="earnings-breakdown">
          <div className="breakdown-header">Recent Jobs</div>
          {resolved.slice(0, 30).map(v => {
            const lot = lotMap[v.lot_id];
            return (
              <div key={v.id} className="breakdown-row">
                <div className="breakdown-left">
                  <div className="breakdown-date">{smartDate(v.resolved_at || v.detected_at)} · {fmtTime(v.resolved_at || v.detected_at)}</div>
                  <div className="breakdown-lot">{lot?.name || '—'}</div>
                  {v.plate_text && (
                    <div className="breakdown-plate" style={{display:'flex', alignItems:'center', gap:4}}>
                      {displayColor(v.vehicle_color) && <span style={{width:8, height:8, borderRadius:3, background:colorHex(v.vehicle_color), border:'1px solid rgba(255,255,255,.1)', flexShrink:0}} />}
                      {v.plate_text}
                    </div>
                  )}
                </div>
                <div className="breakdown-right">
                  <div className="breakdown-amt">{v.our_revenue ? fmtMoney(v.our_revenue) : '—'}</div>
                  <div className="breakdown-action">{(v.action_taken || v.status).replace(/_/g, ' ')}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
