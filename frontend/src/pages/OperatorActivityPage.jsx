import React from 'react';
const { useState, useEffect, useCallback, useRef, useMemo, memo } = React;
import { smartDate, fmtTime, timeAgo } from '../lib/format.js';
import { displayColor, colorHex } from '../lib/vehicles.js';

// ── Operator Activity page (no revenue, just job history) ────
export function OperatorActivityPage({ violations, lots }) {
  const lotMap = Object.fromEntries(lots.map(l => [l.id, l]));

  // Show completed actions in last 7 days
  const cutoff = Date.now() - 7 * 86400000;
  const completed = violations
    .filter(v => v.status !== 'pending' && v.action_taken && new Date(v.resolved_at || v.detected_at) > cutoff)
    .sort((a, b) => new Date(b.resolved_at || b.detected_at) - new Date(a.resolved_at || a.detected_at));

  // Stats
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const todayCount = completed.filter(v => new Date(v.resolved_at || v.detected_at).getTime() >= todayStart.getTime()).length;
  const weekCount = completed.length;

  // ── Analytics: distributions over the last 30 days of completed jobs ─────
  // Helps the operator know WHEN activity clusters so they can plan crew
  // shifts (per Gabe's Frank text: "what times of the day, just stuff you
  // can feed your guys").
  const analyticsCutoff = Date.now() - 30 * 86400000;
  const analyticsRows = violations.filter(
    v => v.status !== 'pending'
      && v.action_taken
      && new Date(v.resolved_at || v.detected_at).getTime() > analyticsCutoff
  );

  // 24-bucket hour-of-day histogram
  const hourCounts = new Array(24).fill(0);
  // 7-bucket day-of-week histogram (0 = Sun)
  const dayCounts = new Array(7).fill(0);
  // 30-bucket daily trend, oldest → newest
  const dailyTrend = new Array(30).fill(0);
  const trendStart = new Date();
  trendStart.setHours(0, 0, 0, 0);
  trendStart.setDate(trendStart.getDate() - 29);
  for (const v of analyticsRows) {
    const t = new Date(v.resolved_at || v.detected_at);
    hourCounts[t.getHours()]++;
    dayCounts[t.getDay()]++;
    const dayIdx = Math.floor((t.getTime() - trendStart.getTime()) / 86400000);
    if (dayIdx >= 0 && dayIdx < 30) dailyTrend[dayIdx]++;
  }

  const hourMax = Math.max(1, ...hourCounts);
  const dayMax = Math.max(1, ...dayCounts);
  const trendMax = Math.max(1, ...dailyTrend);
  const peakHour = hourCounts.indexOf(hourMax);
  const peakDay = dayCounts.indexOf(dayMax);
  const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const hourLabel = (h) => h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`;

  const actionColors = { boot: '#fbbf24', tow: '#f87171', dismissed: '#a78bfa', no_action: '#6b7280', already_gone: '#6b7280' };

  // Group by date (using smart labels)
  const grouped = {};
  completed.forEach(v => {
    const dateKey = smartDate(v.resolved_at || v.detected_at);
    if (!grouped[dateKey]) grouped[dateKey] = [];
    grouped[dateKey].push(v);
  });
  const dateGroups = Object.entries(grouped);

  return (
    <div className="page-enter">
      <div className="section-header">
        <div className="section-title">Your Activity</div>
        <div className="section-count">{weekCount} this week</div>
      </div>

      <div className="kpi-bar" style={{marginBottom:16}}>
        <div className="kpi-card">
          <div className="kpi-val blue">{todayCount}</div>
          <div className="kpi-label">Today</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-val green">{weekCount}</div>
          <div className="kpi-label">This Week</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-val">{analyticsRows.length}</div>
          <div className="kpi-label">30 Days</div>
        </div>
      </div>

      {/* ── Analytics: when activity happens. Helps plan crew shifts. ───── */}
      {analyticsRows.length > 0 && (
        <div style={{display:'flex',flexDirection:'column',gap:14,marginBottom:18}}>
          {/* 30-day trend */}
          <div style={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:12,padding:14}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',marginBottom:10}}>
              <div style={{fontSize:13,fontWeight:800,color:'var(--text-primary)'}}>Last 30 days</div>
              <div style={{fontSize:11,color:'var(--text-muted)',fontWeight:600}}>{analyticsRows.length} jobs</div>
            </div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(30, 1fr)',gap:2,alignItems:'end',height:60}}>
              {dailyTrend.map((c, i) => (
                <div
                  key={i}
                  title={c === 1 ? '1 job' : `${c} jobs`}
                  style={{
                    height: c === 0 ? 4 : `${Math.max(8, (c / trendMax) * 100)}%`,
                    background: c === 0 ? 'var(--border-subtle)' : '#3b82f6',
                    borderRadius:2,
                    opacity: c === 0 ? .35 : 0.85,
                  }}
                />
              ))}
            </div>
            <div style={{display:'flex',justifyContent:'space-between',marginTop:6,fontSize:10,color:'var(--text-faint)',fontWeight:600}}>
              <span>30 days ago</span>
              <span>Today</span>
            </div>
          </div>

          {/* Time-of-day histogram */}
          <div style={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:12,padding:14}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',marginBottom:10}}>
              <div style={{fontSize:13,fontWeight:800,color:'var(--text-primary)'}}>Time of day</div>
              <div style={{fontSize:11,color:'var(--text-muted)',fontWeight:600}}>
                {hourMax > 0 ? <>Peak: <span style={{color:'#fbbf24',fontWeight:800}}>{hourLabel(peakHour)}</span></> : '—'}
              </div>
            </div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(24, 1fr)',gap:2,alignItems:'end',height:64}}>
              {hourCounts.map((c, h) => (
                <div
                  key={h}
                  title={`${hourLabel(h)} — ${c === 1 ? '1 job' : `${c} jobs`}`}
                  style={{
                    height: c === 0 ? 4 : `${Math.max(10, (c / hourMax) * 100)}%`,
                    background: c === 0 ? 'var(--border-subtle)' : (h === peakHour ? '#fbbf24' : '#fbbf2466'),
                    borderRadius:2,
                    opacity: c === 0 ? .35 : 1,
                  }}
                />
              ))}
            </div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(8, 1fr)',marginTop:6,fontSize:10,color:'var(--text-faint)',fontWeight:600}}>
              {[0,3,6,9,12,15,18,21].map(h => <span key={h} style={{textAlign:'left'}}>{hourLabel(h)}</span>)}
            </div>
          </div>

          {/* Day-of-week histogram */}
          <div style={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:12,padding:14}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',marginBottom:10}}>
              <div style={{fontSize:13,fontWeight:800,color:'var(--text-primary)'}}>Day of week</div>
              <div style={{fontSize:11,color:'var(--text-muted)',fontWeight:600}}>
                {dayMax > 0 ? <>Peak: <span style={{color:'#4ade80',fontWeight:800}}>{dayLabels[peakDay]}</span></> : '—'}
              </div>
            </div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(7, 1fr)',gap:6,alignItems:'end',height:80}}>
              {dayCounts.map((c, d) => (
                <div key={d} style={{display:'flex',flexDirection:'column',alignItems:'center',gap:4,height:'100%',justifyContent:'flex-end'}}>
                  <div
                    style={{
                      width:'100%',
                      height: c === 0 ? 4 : `${Math.max(12, (c / dayMax) * 100)}%`,
                      background: c === 0 ? 'var(--border-subtle)' : (d === peakDay ? '#4ade80' : '#4ade8066'),
                      borderRadius:4,
                      opacity: c === 0 ? .35 : 1,
                    }}
                  />
                  <div style={{fontSize:10,fontWeight:700,color: d === peakDay ? '#4ade80' : 'var(--text-faint)',letterSpacing:'.04em'}}>{dayLabels[d]}</div>
                  <div style={{fontSize:11,fontWeight:800,color:'var(--text-primary)'}}>{c}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {dateGroups.length === 0 ? (
        <div className="empty-state">
          <div style={{width:48, height:48, borderRadius:12, background:'rgba(59,130,246,.1)', display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 12px', fontSize:22}}>⚡</div>
          <div className="empty-title">No activity yet</div>
          <div className="empty-body">Recent enforcement activity will appear here</div>
        </div>
      ) : (
        dateGroups.map(([dateLabel, items]) => (
          <div key={dateLabel}>
            <div style={{fontSize:12, fontWeight:700, color:'var(--text-faint)', marginBottom:8, marginTop:16, textTransform:'uppercase', letterSpacing:'.06em'}}>
              {dateLabel}
            </div>
            {items.map(v => {
              const lot = lotMap[v.lot_id];
              const col = actionColors[v.action_taken?.toLowerCase()] || '#9ca3af';
              return (
                <div key={v.id} className="job-card card-animated" style={{marginBottom:8}}>
                  <div className="job-body" style={{padding:'12px 16px'}}>
                    <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8}}>
                      <div>
                        <div style={{fontSize:14, fontWeight:700, color:'var(--text-primary)'}}>{lot?.name || 'Unknown Lot'}</div>
                        <div style={{fontSize:12, color:'var(--text-faint)'}}>{fmtTime(v.resolved_at || v.detected_at)}</div>
                      </div>
                      <span style={{padding:'8px 12px',minHeight:36, borderRadius:20, fontSize:11, fontWeight:700, textTransform:'uppercase', letterSpacing:'.04em', color:col, background:col + '15', border:`1px solid ${col}33`}}>
                        {(v.action_taken || 'handled').replace(/_/g, ' ')}
                      </span>
                    </div>
                    <div className="job-details">
                      {v.plate_text && (
                        <span className="plate-tag" style={{fontSize:11, padding:'3px 8px', display:'flex', alignItems:'center', gap:4}}>
                          {displayColor(v.vehicle_color) && <span style={{width:8, height:8, borderRadius:3, background:colorHex(v.vehicle_color), border:'1px solid rgba(0,0,0,.2)', flexShrink:0}} />}
                          {v.plate_text}
                        </span>
                      )}
                      {!v.plate_text && (
                        <span className="job-tag" style={{display:'flex', alignItems:'center', gap:4, color: displayColor(v.vehicle_color) ? 'inherit' : 'var(--text-faint)'}}>
                          {displayColor(v.vehicle_color) ? (
                            <span style={{width:8, height:8, borderRadius:3, background:colorHex(v.vehicle_color), border:'1px solid rgba(255,255,255,.15)', flexShrink:0}} />
                          ) : (
                            <span style={{width:8, height:8, borderRadius:3, background:'var(--unknown-pattern)', border:'1px solid var(--unknown-border)', flexShrink:0}} />
                          )}
                          <strong style={{textTransform:'capitalize'}}>{displayColor(v.vehicle_color) || 'Unknown'} {v.vehicle_type && v.vehicle_type !== 'car' ? v.vehicle_type : ''}</strong>
                        </span>
                      )}
                      {v.vehicle_make && <span className="job-tag" style={{color:'var(--purple)'}}><strong style={{textTransform:'capitalize'}}>{[v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ')}</strong></span>}
                      {v.zone_id && <span className="job-tag">Zone <strong>{v.zone_id}</strong></span>}
                      <span className="time-ago">{timeAgo(v.resolved_at || v.detected_at)}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ))
      )}
    </div>
  );
}
