import React, { useState, useEffect, useCallback, useRef, useMemo, memo } from 'react';
import { fmtMoney } from '../lib/format.js';
import { db } from '../lib/db.js';
import { SkeletonCards, SkeletonKPIs } from '../ui/Skeletons.jsx';

// ── Analytics tab ──────────────────────────────────────────────
export function AnalyticsPage({ lots, violations, partners = [], isOwner, onNavigate }) {
  const [hourlyData, setHourlyData] = useState(null);
  const [utilData, setUtilData] = useState(null);
  const [projData, setProjData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedLot, setSelectedLot] = useState('all');

  const lotIds = lots.map(l => l.id);
  const lotMap = Object.fromEntries(lots.map(l => [l.id, l]));

  useEffect(() => {
    if (lotIds.length === 0) { setLoading(false); return; }
    setLoading(true);
    const ids = selectedLot === 'all' ? lotIds : [selectedLot];
    Promise.all([
      db.getHourlyStats(ids),
      db.getUtilization(ids),
      db.getRevenueProjection(ids),
    ]).then(([h, u, p]) => {
      setHourlyData(h);
      setUtilData(u);
      setProjData(p);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [lots.length, selectedLot]);

  if (loading) return <div className="page-enter"><SkeletonKPIs /><SkeletonCards count={3} /></div>;

  if (lots.length === 0) {
    return (
      <div className="page-enter" style={{textAlign:'center',padding:40,color:'var(--text-muted)'}}>
        <div style={{fontSize:14,fontWeight:700,color:'var(--text-secondary)',marginBottom:4}}>No analytics yet</div>
        <div style={{fontSize:12}}>Add a lot on the Lots tab to start seeing utilization, revenue projections, and hourly stats.</div>
      </div>
    );
  }

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const maxHeat = hourlyData ? Math.max(...Object.values(hourlyData.heatmap), 1) : 1;

  // Get total spaces for utilization percentage
  const filteredLots = selectedLot === 'all' ? lots : lots.filter(l => l.id === selectedLot);
  const totalSpaces = filteredLots.reduce((s, l) => s + (l.total_spaces || 0), 0);

  return (
    <div className="page-enter">
      <div className="section-header">
        <div className="section-title">Analytics</div>
        {lots.length > 1 && (
          <select value={selectedLot} onChange={e => setSelectedLot(e.target.value)}
            style={{background:'var(--bg-card)', border:'1px solid var(--border)', borderRadius:8, padding:'5px 10px', fontSize:12, fontWeight:600, color:'var(--text-secondary)', fontFamily:'inherit'}}>
            <option value="all">All Lots</option>
            {lots.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        )}
      </div>

      {/* Revenue Projections */}
      {projData && (
        <div className="analytics-card">
          <div className="analytics-card-title">Revenue Projections</div>
          <div className="projection-row">
            <div className="projection-label">Monthly projection</div>
            <div>
              <span className="projection-val green">${projData.monthlyProjection.toLocaleString()}</span>
              {projData.trendPct !== 0 && (
                <span className={`projection-trend ${projData.trend}`}>
                  {projData.trend === 'up' ? '+' : ''}{projData.trendPct}%
                </span>
              )}
            </div>
          </div>
          <div className="projection-row">
            <div className="projection-label">Daily average</div>
            <div>
              <span className="projection-val blue">${projData.dailyAvg.toLocaleString()}</span>
            </div>
          </div>
          <div className="projection-row">
            <div className="projection-label">Last 7 days total</div>
            <div>
              <span className="projection-val">${projData.weeklyAvg.toLocaleString()}</span>
            </div>
          </div>
          <div className="projection-row">
            <div className="projection-label">Recently expired per day</div>
            <div>
              <span className="projection-val">{projData.violationsPerDay}</span>
              {projData.violTrendPct !== 0 && (
                <span className={`projection-trend ${projData.violTrend}`}>
                  {projData.violTrend === 'up' ? '+' : ''}{projData.violTrendPct}%
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* By Partner — tow count + revenue per partner (owner only) */}
      {isOwner && (() => {
        const now = Date.now();
        const since30 = now - 30 * 86400000;
        const lotPartner = Object.fromEntries(lots.map(l => [l.id, l.partner_id]));
        const partnerName = Object.fromEntries(partners.map(p => [p.id, p.company_name]));
        const agg = {};
        violations.forEach(v => {
          if (v.action_taken !== 'tow' || v.status === 'pending') return;
          const ts = new Date(v.resolved_at || v.detected_at).getTime();
          if (ts < since30) return;
          const pid = lotPartner[v.lot_id];
          if (!pid) return;
          if (!agg[pid]) agg[pid] = { partner_id: pid, tows: 0, gross: 0, invoicable_tows: 0, invoicable_gross: 0 };
          agg[pid].tows += 1;
          agg[pid].gross += (v.gross_revenue || 0);
          if (!v.invoiced_at && (v.gross_revenue || 0) > 0) {
            agg[pid].invoicable_tows += 1;
            agg[pid].invoicable_gross += (v.gross_revenue || 0);
          }
        });
        const rows = Object.values(agg).sort((a, b) => b.gross - a.gross);
        if (rows.length === 0) return null;
        return (
          <div className="analytics-card">
            <div className="analytics-card-title">By Partner (Last 30 Days)</div>
            {rows.map(r => (
              <div key={r.partner_id} style={{display:'flex', justifyContent:'space-between', alignItems:'center', padding:'8px 0', borderBottom:'1px solid var(--border)'}}>
                <div>
                  <div style={{fontSize:14, fontWeight:600, color:'var(--text-primary)'}}>
                    {partnerName[r.partner_id] || r.partner_id.slice(0, 8)}
                  </div>
                  <div style={{fontSize:12, color:'var(--text-muted)', marginTop:2}}>
                    {r.tows} tow{r.tows !== 1 ? 's' : ''} · {fmtMoney(r.gross)} gross
                  </div>
                </div>
                {r.invoicable_tows > 0 && (
                  <button
                    onClick={() => onNavigate && onNavigate('invoices')}
                    style={{fontSize:12, padding:'6px 10px', borderRadius:6, border:'1px solid rgba(59,130,246,.4)', background:'rgba(59,130,246,.1)', color:'var(--accent)', cursor:'pointer', fontWeight:600, whiteSpace:'nowrap'}}
                  >
                    Invoice {r.invoicable_tows} · {fmtMoney(r.invoicable_gross)}
                  </button>
                )}
              </div>
            ))}
          </div>
        );
      })()}

      {/* Peak Violation Hours Heatmap */}
      {hourlyData && (
        <div className="analytics-card">
          <div className="analytics-card-title">Peak Recently-Expired Hours (Last 90 Days)</div>
          <div style={{overflowX:'auto', paddingBottom:4}}>
            <div className="heatmap-grid" style={{minWidth:360}}>
              {/* Hour labels */}
              <div />
              {Array.from({length: 24}, (_, h) => (
                <div key={`h${h}`} className="heatmap-hour">{h % 3 === 0 ? `${h}` : ''}</div>
              ))}
              {/* Days */}
              {dayNames.map((day, dow) => (
                <React.Fragment key={day}>
                  <div className="heatmap-label">{day}</div>
                  {Array.from({length: 24}, (_, hour) => {
                    const count = hourlyData.heatmap[`${dow}-${hour}`] || 0;
                    const intensity = count / maxHeat;
                    const bg = count === 0
                      ? 'var(--bg-inset)'
                      : `rgba(239, 68, 68, ${0.15 + intensity * 0.85})`;
                    return (
                      <div key={`${dow}-${hour}`} className="heatmap-cell"
                        style={{background: bg}}
                        title={`${day} ${hour}:00 — ${count} recently expired`}
                      />
                    );
                  })}
                </React.Fragment>
              ))}
            </div>
          </div>
          <div style={{display:'flex', alignItems:'center', gap:6, marginTop:8, justifyContent:'flex-end'}}>
            <span style={{fontSize:10, color:'var(--text-faint)'}}>Low</span>
            {[0.15, 0.35, 0.55, 0.75, 1].map((v, i) => (
              <div key={i} style={{width:12, height:12, borderRadius:2, background:`rgba(239,68,68,${v})`}} />
            ))}
            <span style={{fontSize:10, color:'var(--text-faint)'}}>High</span>
          </div>
        </div>
      )}

      {/* Lot Utilization */}
      {utilData && totalSpaces > 0 && (
        <div className="analytics-card">
          <div className="analytics-card-title">Avg. Vehicles by Hour (Last 7 Days)</div>
          {Array.from({length: 24}, (_, hour) => {
            const avg = utilData.hourly[hour] || 0;
            const pct = Math.min((avg / totalSpaces) * 100, 100);
            const color = pct > 80 ? '#ef4444' : pct > 50 ? '#fbbf24' : '#4ade80';
            return (
              <div key={hour} className="utilization-bar-row">
                <div className="utilization-bar-label">{hour.toString().padStart(2, '0')}:00</div>
                <div className="utilization-bar-track">
                  <div className="utilization-bar-fill" style={{width: `${pct}%`, background: color}} />
                </div>
                <div className="utilization-bar-val">{avg.toFixed(1)}</div>
              </div>
            );
          }).filter((_, hour) => {
            // Only show hours 6am-11pm to reduce clutter
            return hour >= 6 && hour <= 23;
          })}
          <div style={{fontSize:11, color:'var(--text-faint)', marginTop:8, textAlign:'center'}}>
            {totalSpaces} total spaces across {filteredLots.length} lot{filteredLots.length !== 1 ? 's' : ''}
          </div>
        </div>
      )}

      {utilData && totalSpaces === 0 && (
        <div className="analytics-card">
          <div className="analytics-card-title">Lot Utilization</div>
          <div style={{padding:'16px 0', textAlign:'center', color:'var(--text-faint)', fontSize:13}}>
            Set total spaces on your lots to see utilization percentages
          </div>
        </div>
      )}

      {/* Quick stats */}
      <div className="analytics-card">
        <div className="analytics-card-title">Quick Stats</div>
        <div className="kpi-bar">
          <div className="kpi-card">
            <div className="kpi-val blue">{hourlyData?.total || 0}</div>
            <div className="kpi-label">Recently expired (90d)</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-val green">{lots.length}</div>
            <div className="kpi-label">Active Lots</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-val">{utilData?.totalSnapshots || 0}</div>
            <div className="kpi-label">Snapshots (7d)</div>
          </div>
        </div>
      </div>

      {/* Link to operator overview */}
      {isOwner && onNavigate && (
        <button onClick={() => onNavigate('overview')} style={{
          width:'100%', background:'var(--bg-card)', border:'1px solid var(--border)', borderRadius:12,
          padding:'14px 16px', display:'flex', alignItems:'center', justifyContent:'space-between',
          cursor:'pointer', fontFamily:'inherit', marginTop:4,
        }}>
          <div style={{textAlign:'left'}}>
            <div style={{fontSize:14, fontWeight:700, color:'var(--text-primary)'}}>Operator Overview</div>
            <div style={{fontSize:12, color:'var(--text-faint)', marginTop:2}}>View per-operator stats and impersonate partners</div>
          </div>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
      )}
    </div>
  );
}
