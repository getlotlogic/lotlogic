import React from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { fmtPassRemaining, makeDebounced } from './lib/time.js';
import { lotDayBound } from './lib/lotdate.js';
import { smartDate, elapsed, timeAgo, fmtMoney, fmtDate, fmtTime, fmtDateTime } from './lib/format.js';
import { bundleVehicleEvents, filterEvidencePackages, mapsLink } from './lib/bundle.js';
import { displayColor, colorHex, cleanMmc } from './lib/vehicles.js';
import { isVehicleInZone, matchViolationDetection } from './lib/geometry.js';
import { fmtVisitDate, fmtStay, fmtCooldownDateTime, fmtHrsShort } from './lib/passFormat.js';
import { supabase, applySupabaseAuth } from './lib/supabase.js';
import { API, apiFetch, getSessionToken, authLogin, authRequestPasswordReset } from './lib/api.js';
import { db } from './lib/db.js';
import { DEFAULT_TRUCK_PLAZA_POLICY } from './shared/policy.js';
import { useTheme, useOnlineStatus, useActiveRoster, useIntervalFetch, useNowTick } from './hooks.js';
import { haptic, NotifyManager } from './lib/notify.js';
import { ErrorBoundary } from './ui/ErrorBoundary.jsx';
import { SkeletonCards, SkeletonKPIs } from './ui/Skeletons.jsx';
import { ToastProvider, useToast } from './ui/Toast.jsx';
import { ConfirmActionModal } from './ui/Dialog.jsx';
import { useFocusTrap, useUid } from './ui/focusTrap.js';
import { NavIconJobs, NavIconLots, NavIconEarnings, NavIconAccount, NavIconActivity, NavIconOverview, SearchIcon } from './ui/icons.jsx';
import { ViolationProofModal } from './ui/ProofModal.jsx';
import { ViolationSnapshot } from './ui/ViolationSnapshot.jsx';
import { CrossCameraSightings } from './ui/CrossCameraSightings.jsx';
import { CooldownChip, ReregTowFlag, PassPhotoStrip } from './ui/passPhotos.jsx';
import { FeedbackModal } from './ui/FeedbackModal.jsx';
import { RegisterPassModal } from './ui/RegisterPassModal.jsx';
import { EarningsPage } from './pages/EarningsPage.jsx';
import { InvoicesPage } from './pages/InvoicesPage.jsx';
import { TowActivityPage } from './pages/TowActivityPage.jsx';
import { JobsPage } from './pages/JobsPage.jsx';
import { ALPRPropertiesPage } from './pages/ALPRPropertiesPage.jsx';
import { scopePropsToPartner } from './shared/scope.js';
// The file was written against the UMD globals; keep that shape so the 12,638
// lines below are untouched. Task 12 removes this shim when App.jsx lands.
const ReactDOM = { createRoot, createPortal };

const { useState, useEffect, useCallback, useRef, useMemo, memo } = React;











// ── Login ─────────────────────────────────────────────────────
function LoginPage({ onLogin }) {
  const [email, setEmail] = useState(() => localStorage.getItem('lotlogic_email') || '');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [resetSent, setResetSent] = useState(false);

  async function submit(e) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed || !password) return;
    setLoading(true); setError(''); setResetSent(false);
    try {
      const res = await authLogin(trimmed, password);
      localStorage.setItem('lotlogic_email', trimmed);
      const base = res.subject || {};
      const role = base.type === 'partner' ? 'partner' : 'owner';
      onLogin({
        id: base.id,
        email: base.email || trimmed,
        business_name: base.display_name,
        company_name: role === 'partner' ? base.display_name : undefined,
        // Surface admin flags into the session at login time so the dashboard
        // doesn't have to wait for the /auth/me self-heal to fire (which
        // races against the first loadData call). Backend /auth/login
        // returns these on the subject for owner accounts; partners always
        // false.
        is_admin: !!base.is_admin,
        is_platform_admin: !!base.is_platform_admin,
        _role: role,
        _token: res.token,
        _expires_in: res.expires_in,
      });
    } catch (err) {
      if (err.status === 401) setError('Invalid email or password.');
      else if (err.status === 403) setError(err.message || 'Password not set. Use "Email me a setup link" below.');
      else setError(err.message || "Can't connect right now. Check your connection and try again.");
    } finally { setLoading(false); }
  }

  async function sendResetLink() {
    const trimmed = email.trim();
    if (!trimmed) { setError('Enter your email first.'); return; }
    setError('');
    try {
      await authRequestPasswordReset(trimmed);
      setResetSent(true);
    } catch {
      // Endpoint is intentionally non-revealing — show the same success message.
      setResetSent(true);
    }
  }

  return (
    <div className="login-page" role="main">
      <div className="login-box">
        <div className="login-logo" aria-hidden="true">
          <div className="login-shield">LL</div>
          <div className="login-wordmark">Lot<span>Logic</span></div>
        </div>
        <div className="login-tagline">AI-powered parking enforcement — sign in to get started</div>
        <form onSubmit={submit} aria-label="Sign in">
          <label className="field-label" htmlFor="login-email">Your email</label>
          <input
            id="login-email"
            className="field-input"
            type="email"
            placeholder="you@company.com"
            value={email}
            onChange={e => setEmail(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            required
            autoFocus
            autoComplete="username"
            aria-required="true"
          />
          <label className="field-label" htmlFor="login-password" style={{marginTop:12}}>Password</label>
          <input
            id="login-password"
            className="field-input"
            type="password"
            placeholder="••••••••"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            autoComplete="current-password"
            aria-required="true"
          />
          <button className="login-btn" type="submit" disabled={loading || !email || !password} aria-busy={loading}>
            {loading ? 'Signing in…' : 'Sign In →'}
          </button>
        </form>
        {error && <div className="login-error" role="alert">{error}</div>}
        {resetSent && (
          <div className="login-note" role="status" style={{marginTop:12,fontSize:13,color:'var(--text-muted)'}}>
            If an account exists for that email, we've sent a setup link. Check your inbox.
          </div>
        )}
        <button
          type="button"
          onClick={sendResetLink}
          style={{background:'none',border:0,color:'var(--text-muted)',fontSize:13,marginTop:12,cursor:'pointer',textDecoration:'underline'}}
        >
          Forgot password? Email me a setup link.
        </button>
      </div>
    </div>
  );
}






function normalizeTruckPlate(s) {
  return (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}



// "Seen on camera before registering" evidence block. Shows the snapshot
// inline (objectFit:contain so nothing is cropped) and opens a fullscreen
// overlay on click for the full uncropped frame. Esc / outside-click closes.


// ── Tow-truck plates editor (enforcement partner self-settings) ────
// Writes directly to enforcement_partners.tow_truck_plates via Supabase REST.
// Normalization matches the tow-confirm edge function so stored plates
// compare cleanly against camera sightings.
function TowTruckPlatesEditor({ user }) {
  const [plates, setPlates] = React.useState(() => (user?.tow_truck_plates || []).slice());
  const [draft, setDraft] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState('');
  const [saved, setSaved] = React.useState(false);

  // Stringified signature of the incoming plates array. Using just `user?.id`
  // missed updates where the parent refetched and only the plates array
  // mutated (same user id, different list). Re-sync whenever the list
  // content changes.
  const userPlatesKey = JSON.stringify(user?.tow_truck_plates ?? []);
  React.useEffect(() => {
    // Re-sync on user id change or plates array content change.
    setPlates((user?.tow_truck_plates || []).slice());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, userPlatesKey]);

  // Track last persist intent so we can show an "added" vs. generic save message.
  // Stateful instead of a function arg so the flag survives the async setTimeout.
  const [lastAction, setLastAction] = React.useState(null); // 'added' | 'removed' | null

  async function persist(next, action) {
    setSaving(true); setErr(''); setSaved(false);
    try {
      if (!supabase || !user?.id) throw new Error('Not authenticated');
      const { error } = await supabase
        .from('enforcement_partners')
        .update({ tow_truck_plates: next })
        .eq('id', user.id);
      if (error) throw new Error(error.message);
      setPlates(next);
      setLastAction(action || null);
      setSaved(true);
      // Longer linger on the "Plate added" banner — it carries instructional
      // copy the partner needs time to read.
      setTimeout(() => setSaved(false), action === 'added' ? 4000 : 1500);
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setSaving(false);
    }
  }

  function addPlate() {
    const norm = normalizeTruckPlate(draft);
    if (!norm) { setDraft(''); return; }
    if (plates.includes(norm)) { setDraft(''); return; }
    const next = [...plates, norm];
    setDraft('');
    persist(next, 'added');
  }

  function removePlate(p) {
    const next = plates.filter(x => x !== p);
    persist(next, 'removed');
  }

  return React.createElement('div', { className: 'settings-section', id: 'tow-truck-plates' },
    React.createElement('div', {
      className: 'settings-section-title',
      style: { display: 'flex', alignItems: 'center', gap: 6 },
    },
      'Tow-truck plates',
      // Info glyph with native tooltip — clarifies when auto-confirmation runs.
      React.createElement('span', {
        'aria-label': 'Auto-confirmation runs when one of these plates is seen by the property\'s cameras after you report a tow.',
        title: 'Auto-confirmation runs when one of these plates is seen by the property\'s cameras after you report a tow.',
        role: 'img',
        tabIndex: 0,
        style: {
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 16, height: 16, borderRadius: '50%', fontSize: 11, fontWeight: 700,
          background: 'var(--bg-inset)', color: 'var(--text-muted)',
          border: '1px solid var(--border)', cursor: 'help',
        }
      }, 'i'),
    ),
    React.createElement('div', {
      style: { fontSize: 12, color: 'var(--text-muted)', padding: '0 0 10px' }
    }, 'Plates of tow trucks operated by this partner. Camera sightings of these plates confirm that a tow actually happened.'),

    React.createElement('div', {
      style: { display: 'flex', flexWrap: 'wrap', gap: 6, padding: '4px 0 10px' }
    },
      plates.length === 0
        ? React.createElement('div', { style: { fontSize: 12, color: 'var(--text-faint)', lineHeight: 1.45 } },
            React.createElement('div', { style: { color: 'var(--text-muted)', marginBottom: 4 } },
              'No plates registered yet. ',
              React.createElement('strong', { style: { color: 'var(--text-primary)', fontWeight: 700 } },
                'Add your tow-truck plates so camera sightings automatically confirm your tows.'),
            ),
            React.createElement('div', null,
              'Without plates, every tow has to be confirmed manually by the property owner before we can release billing.',
            ),
          )
        : plates.map(p => React.createElement('span', {
            key: p,
            style: {
              display: 'inline-flex', alignItems: 'center', gap: 6,
              fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, fontWeight: 700,
              padding: '4px 4px 4px 10px', borderRadius: 8,
              background: 'var(--bg-inset)', border: '1px solid var(--border)', color: 'var(--text-primary)',
            }
          },
            p,
            React.createElement('button', {
              onClick: () => removePlate(p), disabled: saving,
              title: 'Remove plate',
              'aria-label': 'Remove tow-truck plate ' + p,
              style: {
                background: 'transparent', border: 'none', color: 'var(--text-faint)',
                cursor: saving ? 'wait' : 'pointer', padding: '0 6px', fontSize: 14, lineHeight: 1,
              },
            }, '\u2715'),
          )),
    ),

    React.createElement('div', {
      style: { display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0' }
    },
      React.createElement('input', {
        type: 'text',
        value: draft,
        onChange: e => setDraft(e.target.value),
        onKeyDown: e => { if (e.key === 'Enter') { e.preventDefault(); addPlate(); } },
        placeholder: 'Add plate (e.g. T-123-AB)',
        disabled: saving,
        style: {
          flex: 1, fontSize: 13, padding: '6px 10px', borderRadius: 6,
          border: '1px solid var(--border)', background: 'var(--bg-inset)',
          color: 'var(--text-primary)', fontFamily: 'ui-monospace, Menlo, monospace', textTransform: 'uppercase',
        },
      }),
      React.createElement('button', {
        onClick: addPlate,
        disabled: saving || !normalizeTruckPlate(draft),
        style: {
          fontSize: 13, padding: '6px 14px', borderRadius: 6, cursor: 'pointer', fontWeight: 700,
          border: '1px solid var(--accent)', background: 'var(--accent)', color: '#fff',
          opacity: (saving || !normalizeTruckPlate(draft)) ? 0.6 : 1,
        }
      }, saving ? 'Saving…' : 'Add plate'),
    ),

    err && React.createElement('div', {
      style: { fontSize: 12, color: '#ef4444', padding: '6px 0 0' }
    }, err),
    saved && !err && React.createElement('div', {
      style: { fontSize: 12, color: 'var(--green)', padding: '6px 0 0', lineHeight: 1.45 }
    }, lastAction === 'added'
         ? 'Plate added! Camera sightings will now auto-confirm your tows within a few minutes.'
         : 'Saved'),
  );
}

// ── Operator Activity page (no revenue, just job history) ────
function OperatorActivityPage({ violations, lots }) {
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

// ── Owner Overview page — per-operator stats + "View as" ──────
function OverviewPage({ violations, lots, partners, lotStates, onViewAs }) {
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

// ── Account / Settings page ────────────────────────────────────
function PartnerFeeEditor({ user, isPlatformAdmin = false }) {
  // Fees are locked for partners — LotLogic sets them, not the partner.
  // `tow_fee`/`boot_fee` are read-only GENERATED columns (dollars, derived
  // from `tow_fee_cents`/`boot_fee_cents`); the backend's PATCH
  // /partners/{id} allowlist now only accepts the `_cents` fields from a
  // service / platform-admin caller, never from a partner's own session. So
  // a real partner gets a plain read-only display here; only a
  // platform-admin session (e.g. admin viewing/editing on a partner's
  // behalf) gets the editable form and Save.
  const [towFee, setTowFee] = React.useState(user?.tow_fee ?? 100);
  const [bootFee, setBootFee] = React.useState(user?.boot_fee ?? 0);
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState('');
  const [saved, setSaved] = React.useState(false);
  const { addToast } = useToast();

  // Re-sync when the user prop changes (parent refetched).
  React.useEffect(() => {
    setTowFee(user?.tow_fee ?? 100);
    setBootFee(user?.boot_fee ?? 0);
  }, [user?.id, user?.tow_fee, user?.boot_fee]);

  if (!isPlatformAdmin) {
    return (
      <div className="settings-section">
        <div className="settings-section-title">Your fees</div>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Tow Fee</div>
            <div className="settings-row-desc">What you bill per tow</div>
          </div>
          <div style={{fontSize:16, fontWeight:700, color:'var(--text-primary)'}}>
            ${user?.tow_fee ?? 100}
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Boot Fee</div>
            <div className="settings-row-desc">What you bill per boot</div>
          </div>
          <div style={{fontSize:16, fontWeight:700, color:'var(--text-primary)'}}>
            ${user?.boot_fee ?? 0}
          </div>
        </div>
        <div style={{fontSize:12, color:'var(--text-faint)', marginTop:10}}>
          Fees are set by LotLogic — contact us to change them.
        </div>
      </div>
    );
  }

  const dirty = towFee !== (user?.tow_fee ?? 100) || bootFee !== (user?.boot_fee ?? 0);

  async function save() {
    setSaving(true); setErr(''); setSaved(false);
    try {
      if (!user?.id) throw new Error('Not authenticated');
      const tow = Number(towFee);
      const boot = Number(bootFee);
      if (!Number.isFinite(tow) || tow < 0) throw new Error('Tow fee must be a non-negative number');
      if (!Number.isFinite(boot) || boot < 0) throw new Error('Boot fee must be a non-negative number');
      await apiFetch(`/partners/${user.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tow_fee_cents: Math.round(tow * 100),
          boot_fee_cents: Math.round(boot * 100),
        }),
      });
      setSaved(true);
      addToast('Fees saved', 'success');
      setTimeout(() => setSaved(false), 1800);
    } catch (e) {
      const msg = e.message || String(e);
      setErr(msg);
      addToast('Failed to save fees: ' + msg, 'error');
    } finally {
      setSaving(false);
    }
  }

  const inputStyle = {
    padding: '10px 12px', background: 'var(--bg-inset)', border: '1px solid var(--border)',
    borderRadius: 8, color: 'var(--text-primary)', fontSize: 16, fontWeight: 700,
    width: 110, fontFamily: 'inherit', textAlign: 'right',
  };

  return (
    <div className="settings-section">
      <div className="settings-section-title">Your fees</div>
      <div className="settings-row">
        <div className="settings-row-info">
          <div className="settings-row-label">Tow Fee</div>
          <div className="settings-row-desc">What you bill per tow</div>
        </div>
        <div style={{display:'flex',alignItems:'center',gap:6,color:'var(--text-faint)',fontSize:15}}>
          $
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="1"
            value={towFee}
            onChange={(e) => setTowFee(e.target.value)}
            disabled={saving}
            aria-label="Tow fee in dollars"
            style={inputStyle}
          />
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-info">
          <div className="settings-row-label">Boot Fee</div>
          <div className="settings-row-desc">What you bill per boot. Set to 0 if you don't boot.</div>
        </div>
        <div style={{display:'flex',alignItems:'center',gap:6,color:'var(--text-faint)',fontSize:15}}>
          $
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="1"
            value={bootFee}
            onChange={(e) => setBootFee(e.target.value)}
            disabled={saving}
            aria-label="Boot fee in dollars"
            style={inputStyle}
          />
        </div>
      </div>
      {(dirty || err || saved) && (
        <div style={{display:'flex',justifyContent:'flex-end',alignItems:'center',gap:10,marginTop:10}}>
          {err && <span style={{color:'#ef4444',fontSize:12,fontWeight:600}}>{err}</span>}
          {saved && <span style={{color:'#4ade80',fontSize:12,fontWeight:700}}>✓ Saved</span>}
          {dirty && (
            <button
              onClick={save}
              disabled={saving}
              style={{
                background: saving ? 'rgba(251,191,36,.25)' : '#FBBF24',
                color: saving ? '#FBBF24' : '#1A1206',
                border: 'none', borderRadius: 8, padding: '9px 16px',
                fontSize: 13, fontWeight: 700, cursor: saving ? 'progress' : 'pointer',
                fontFamily: 'inherit', letterSpacing: '.04em',
              }}
            >{saving ? 'Saving…' : 'Save'}</button>
          )}
        </div>
      )}
    </div>
  );
}

function ChangePasswordSection() {
  const [open, setOpen] = React.useState(false);
  const [cur, setCur] = React.useState('');
  const [next, setNext] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');
  const [done, setDone] = React.useState(false);
  const { addToast } = useToast();

  async function submit(e) {
    e.preventDefault();
    setErr('');
    if (next.length < 8) { setErr('New password must be at least 8 characters.'); return; }
    if (next !== confirm) { setErr('New passwords do not match.'); return; }
    setBusy(true);
    try {
      await apiFetch('/auth/change-password', { method: 'POST', body: JSON.stringify({ current_password: cur, new_password: next }) });
      setDone(true); setCur(''); setNext(''); setConfirm('');
      addToast('Password changed', 'success');
      setTimeout(() => { setOpen(false); setDone(false); }, 1500);
    } catch (e2) {
      setErr(e2.message || 'Could not change password.');
    } finally { setBusy(false); }
  }

  const input = { width: '100%', padding: '12px 14px', background: 'var(--bg-card)', border: '1.5px solid var(--border)', borderRadius: 10, color: 'var(--text-primary)', fontSize: 16, marginTop: 8, outlineColor: 'var(--accent)' };
  return (
    <div className="settings-section">
      <div className="settings-section-title">Password</div>
      {!open ? (
        <button onClick={() => setOpen(true)} style={{ width: '100%', padding: '13px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 10, color: 'var(--text-primary)', fontWeight: 700, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit' }}>Change password</button>
      ) : (
        <form onSubmit={submit}>
          <input type="password" autoComplete="current-password" placeholder="Current password" value={cur} onChange={e => setCur(e.target.value)} style={input} />
          <input type="password" autoComplete="new-password" placeholder="New password (8+ characters)" value={next} onChange={e => setNext(e.target.value)} style={input} />
          <input type="password" autoComplete="new-password" placeholder="Confirm new password" value={confirm} onChange={e => setConfirm(e.target.value)} style={input} />
          {err && <div style={{ color: '#f87171', fontSize: 13, marginTop: 10 }}>{err}</div>}
          {done && <div style={{ color: '#4ade80', fontSize: 13, marginTop: 10 }}>Password changed.</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button type="button" onClick={() => { setOpen(false); setErr(''); setCur(''); setNext(''); setConfirm(''); }} style={{ flex: 1, padding: '12px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 10, color: 'var(--text-faint)', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>Cancel</button>
            <button type="submit" disabled={busy} style={{ flex: 2, padding: '12px', background: 'var(--text-primary)', color: 'var(--bg-primary)', border: 'none', borderRadius: 10, fontWeight: 700, cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.6 : 1, fontFamily: 'inherit' }}>{busy ? 'Saving…' : 'Update password'}</button>
          </div>
        </form>
      )}
    </div>
  );
}

function AccountPage({ user, isImpersonating, onLogout, autoRefresh, setAutoRefresh, refreshInterval, setRefreshInterval, showFees = true, isPlatformAdmin = false }) {
  const isOwner = user._role === 'owner';
  const [notifyPrefs, setNotifyPrefs] = useState(() => NotifyManager.getPrefs());
  const [notifyPerm, setNotifyPerm] = useState(() => NotifyManager.getPermission());

  function updateNotify(patch) {
    const next = NotifyManager.updatePrefs(patch);
    setNotifyPrefs(next);
  }

  function ToggleSwitch({ on, onChange }) {
    return (
      <div onClick={onChange} style={{
        width: 44, height: 24, borderRadius: 12, cursor: 'pointer', transition: 'background .2s',
        background: on ? '#4ade80' : 'rgba(107,114,128,.3)', position: 'relative', flexShrink: 0,
      }}>
        <div style={{
          width: 20, height: 20, borderRadius: 10, background: '#fff', position: 'absolute', top: 2,
          left: on ? 22 : 2, transition: 'left .2s', boxShadow: '0 1px 3px rgba(0,0,0,.3)',
        }} />
      </div>
    );
  }

  return (
    <div className="page-enter">
      {/* Profile card */}
      <div style={{textAlign:'center', marginBottom:20}}>
        <div style={{width:64, height:64, borderRadius:16, background:'linear-gradient(135deg, #3b82f6, #2563eb)', display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 12px', fontSize:22, fontWeight:800, color:'#fff'}}>
          {(user.contact_name || user.business_name || 'U').charAt(0).toUpperCase()}
        </div>
        <div style={{fontSize:20, fontWeight:800, color:'var(--text-primary)'}}>{user.contact_name || user.business_name}</div>
        <div style={{fontSize:13, color:'var(--text-faint)', marginTop:2}}>{user.email}</div>
        <div style={{marginTop:6}}>
          <span style={{fontSize:11, fontWeight:700, padding:'3px 10px', borderRadius:20, textTransform:'uppercase', letterSpacing:'.06em',
            background: isOwner ? 'rgba(59,130,246,.12)' : 'rgba(139,92,246,.12)',
            color: isOwner ? '#60a5fa' : '#a78bfa',
            border: `1px solid ${isOwner ? 'rgba(59,130,246,.2)' : 'rgba(139,92,246,.2)'}`}}>
            {isOwner ? 'Lot Owner' : 'Towing Partner'}
          </span>
        </div>
      </div>

      {/* Account info */}
      <div className="settings-section">
        <div className="settings-section-title">Account</div>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Role</div>
            <div className="settings-row-desc">{isOwner ? 'Full access to lots, cameras, earnings, and zones' : 'Dispatched to confirmed tows; cameras close the job automatically'}</div>
          </div>
          <div className="settings-row-value" style={{color: isOwner ? '#60a5fa' : '#a78bfa'}}>{isOwner ? 'Owner' : 'Towing Partner'}</div>
        </div>
        {user.business_name && (
          <div className="settings-row">
            <div className="settings-row-info"><div className="settings-row-label">Organization</div></div>
            <div className="settings-row-value">{user.business_name}</div>
          </div>
        )}
        {user.phone && (
          <div className="settings-row">
            <div className="settings-row-info"><div className="settings-row-label">Phone</div></div>
            <div className="settings-row-value">{user.phone}</div>
          </div>
        )}
      </div>

      {/* Partner self-service fee schedule — editable Tow Fee + Boot Fee
          (their own rates, what they bill the vehicle owner per action).
          revenue_share stays hidden — that's LotLogic's platform cut and
          part of the partner agreement, not a self-service field. */}
      {/* SaaS (all-apartment) partners pay a subscription — no per-tow fee
          schedule to edit. Tow-truck plates below stay for everyone: plate
          matching is live enforcement, not money. */}
      {!isOwner && showFees && <PartnerFeeEditor user={user} isPlatformAdmin={isPlatformAdmin} />}

      {/* Tow-truck plates — enforcement partners only. Used by the tow-confirm
          edge function to match camera sightings against partner trucks. */}
      {!isOwner && <TowTruckPlatesEditor user={user} />}

      {/* App settings */}
      <div className="settings-section">
        <div className="settings-section-title">App</div>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Auto-refresh</div>
            <div className="settings-row-desc">
              {autoRefresh ? `Data refreshes every ${refreshInterval / 1000}s` : 'Auto-refresh is paused'}
            </div>
          </div>
          <ToggleSwitch on={autoRefresh} onChange={() => setAutoRefresh(!autoRefresh)} />
        </div>
        {autoRefresh && (
          <div className="settings-row">
            <div className="settings-row-info">
              <div className="settings-row-label">Refresh Interval</div>
              <div className="settings-row-desc">How often to poll for updates</div>
            </div>
            <select value={refreshInterval} onChange={e => setRefreshInterval(Number(e.target.value))} style={{
              background: 'var(--bg-inset)', color: 'var(--text-primary)', border: '1px solid var(--border)',
              borderRadius: 8, padding: '4px 8px', fontSize: 13, fontWeight: 600,
            }}>
              <option value={10000}>10s</option>
              <option value={15000}>15s</option>
              <option value={30000}>30s</option>
              <option value={60000}>60s</option>
            </select>
          </div>
        )}
      </div>

      {/* Notification settings */}
      <div className="settings-section">
        <div className="settings-section-title">Notifications</div>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Alert Sound</div>
            <div className="settings-row-desc">Play chime when a new violation is detected</div>
          </div>
          <div style={{display:'flex', alignItems:'center', gap:8}}>
            <button onClick={() => NotifyManager.playChime()} style={{
              background:'var(--bg-inset)', border:'1px solid var(--border)', borderRadius:6,
              padding:'3px 8px', fontSize:11, fontWeight:600, color:'var(--text-muted)', cursor:'pointer',
            }}>Test</button>
            <ToggleSwitch on={notifyPrefs.sound} onChange={() => updateNotify({ sound: !notifyPrefs.sound })} />
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Browser Notifications</div>
            <div className="settings-row-desc">
              {notifyPerm === 'granted' ? 'Desktop alerts when tab is in background' :
               notifyPerm === 'denied' ? 'Blocked — enable in browser settings' :
               notifyPerm === 'unsupported' ? 'Not supported in this browser' :
               'Click Enable to allow desktop alerts'}
            </div>
          </div>
          <div style={{display:'flex', alignItems:'center', gap:8}}>
            {notifyPerm === 'default' && (
              <button onClick={async () => {
                const p = await NotifyManager.requestPermission();
                setNotifyPerm(p);
                if (p === 'granted') updateNotify({ browser: true });
              }} style={{
                background:'var(--accent)', color:'#fff', border:'none', borderRadius:6,
                padding:'4px 12px', fontSize:12, fontWeight:700, cursor:'pointer',
              }}>Enable</button>
            )}
            {notifyPerm === 'granted' && (
              <ToggleSwitch on={notifyPrefs.browser} onChange={() => updateNotify({ browser: !notifyPrefs.browser })} />
            )}
            {notifyPerm === 'denied' && (
              <div className="settings-row-value" style={{color:'#f87171'}}>Blocked</div>
            )}
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Vibration</div>
            <div className="settings-row-desc">Haptic feedback on mobile devices</div>
          </div>
          <div className="settings-row-value" style={{color: navigator.vibrate ? 'var(--green)' : 'var(--text-faint)'}}>
            {navigator.vibrate ? 'Auto' : 'Unsupported'}
          </div>
        </div>
      </div>

      {/* System info */}
      <div className="settings-section">
        <div className="settings-section-title">System</div>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Database</div>
            <div className="settings-row-desc">Live data connection</div>
          </div>
          <div className="settings-row-value" style={{color: supabase ? '#4ade80' : '#fbbf24'}}>{supabase ? 'Connected' : 'Rails API'}</div>
        </div>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Version</div>
          </div>
          <div className="settings-row-value">5.0.0</div>
        </div>
      </div>

      {isImpersonating ? (
        <div className="settings-section">
          <div className="settings-section-title">Password</div>
          <div style={{ fontSize: 13, color: 'var(--text-faint)', lineHeight: 1.5 }}>Exit partner view to change your own password. This account manages its password from its own login.</div>
        </div>
      ) : <ChangePasswordSection />}

      <button className="login-btn" style={{background:'rgba(239,68,68,.15)', color:'#f87171', boxShadow:'none', border:'1px solid rgba(239,68,68,.3)'}} onClick={onLogout}>
        Sign Out
      </button>
    </div>
  );
}

// ── Analytics tab ──────────────────────────────────────────────
function AnalyticsPage({ lots, violations, partners = [], isOwner, onNavigate }) {
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

// ── ALPR Page Components ─────────────────────────────────────













function TrainingPage({ user, isOwner }) {
  // Operator review of cross-camera plate pairs with image evidence and
  // verify / dismiss actions. The cron-plate-pair-learn edge function
  // populates inferred_plate_pairs every 60s; this surface lets the
  // operator visually confirm a pair (raising confidence to 1.0 via
  // verified_at), dismiss false positives, or restore mistakes.
  //
  // RLS owner-only: partners (Frank) never see this surface.
  const { addToast } = useToast();
  const [pairs, setPairs] = useState([]);
  const [properties, setProperties] = useState({});
  const [cameras, setCameras] = useState({});
  // best plate_event per (normalized_plate, camera_id) — image source for cards
  const [evidence, setEvidence] = useState({});
  const [filter, setFilter] = useState('unverified'); // unverified | verified | dismissed | all
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(null);
  const [lightbox, setLightbox] = useState(null); // { url, plate, camera, ts }
  // Escape closes the evidence viewer (was mouse-dismiss only — keyboard trap).
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e) => { if (e.key === 'Escape') setLightbox(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox]);

  const load = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    try {
      let q = supabase
        .from('inferred_plate_pairs')
        .select('id, property_id, plate_a, plate_b, plate_a_camera_id, plate_b_camera_id, observations, confidence, first_seen_at, last_seen_at, dismissed_at, dismissed_by, verified_at, verified_by, resolved_pass_id')
        .order('last_seen_at', { ascending: false })
        .limit(500);
      if (filter === 'unverified') q = q.is('dismissed_at', null).is('verified_at', null);
      else if (filter === 'verified') q = q.is('dismissed_at', null).not('verified_at', 'is', null);
      else if (filter === 'dismissed') q = q.not('dismissed_at', 'is', null);
      const { data, error } = await q;
      if (error) throw error;
      setPairs(data || []);

      // Lookup property names + camera names + best-image-per-(plate, camera)
      const propIds = [...new Set((data || []).map(p => p.property_id))];
      const camIds = [...new Set((data || []).flatMap(p => [p.plate_a_camera_id, p.plate_b_camera_id]).filter(Boolean))];
      const plates = [...new Set((data || []).flatMap(p => [p.plate_a, p.plate_b]).filter(Boolean))];

      const [propRes, camRes, evRes] = await Promise.all([
        propIds.length ? supabase.from('properties').select('id, name').in('id', propIds) : Promise.resolve({ data: [] }),
        camIds.length ? supabase.from('alpr_cameras').select('id, name').in('id', camIds) : Promise.resolve({ data: [] }),
        plates.length ? supabase.from('plate_events')
          .select('normalized_plate, camera_id, image_url, confidence, created_at')
          .in('normalized_plate', plates)
          .not('image_url', 'is', null)
          .gte('created_at', new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString())
          .order('confidence', { ascending: false })
          .limit(3000)
          : Promise.resolve({ data: [] }),
      ]);

      setProperties(Object.fromEntries((propRes.data || []).map(p => [p.id, p.name])));
      setCameras(Object.fromEntries((camRes.data || []).map(c => [c.id, c.name || c.id.slice(0, 6)])));
      // Pick the highest-confidence image per (plate, camera) — already pre-sorted desc by conf
      const best = {};
      for (const e of (evRes.data || [])) {
        const key = `${e.normalized_plate}|${e.camera_id}`;
        if (!best[key]) best[key] = e;
      }
      setEvidence(best);
    } catch (err) {
      console.warn('TrainingPage.load failed', err.message);
      addToast('Load failed: ' + err.message, 'error');
    }
    setLoading(false);
  }, [filter]);
  useEffect(() => { load(); }, [load]);

  // Auto-refresh every 60s to match cron-plate-pair-learn cadence. New
  // pairs land in the table within ~1 minute of a truck transiting both
  // cameras; this surface should show them without the operator having
  // to reload.
  useEffect(() => {
    const t = setInterval(() => { load(); }, 60_000);
    return () => clearInterval(t);
  }, [load]);

  async function setPairState(id, patch, toastMsg) {
    if (!supabase) return;
    setActing(id);
    try {
      const { error } = await supabase.from('inferred_plate_pairs').update(patch).eq('id', id);
      if (error) throw error;
      addToast(toastMsg, 'success');
      await load();
    } catch (err) {
      addToast('Failed: ' + err.message, 'error');
    }
    setActing(null);
  }
  const op = user?.email || 'operator';
  const verify = (id) => setPairState(id, { verified_at: new Date().toISOString(), verified_by: op, dismissed_at: null, dismissed_by: null }, 'Verified — same truck');
  const dismiss = (id) => setPairState(id, { dismissed_at: new Date().toISOString(), dismissed_by: op, verified_at: null, verified_by: null }, 'Dismissed — not the same truck');
  const reset = (id) => setPairState(id, { verified_at: null, verified_by: null, dismissed_at: null, dismissed_by: null }, 'Reset to unverified');

  function PairSide({ pair, side }) {
    const plate = side === 'a' ? pair.plate_a : pair.plate_b;
    const camId = side === 'a' ? pair.plate_a_camera_id : pair.plate_b_camera_id;
    const ev = evidence[`${plate}|${camId}`];
    const camName = cameras[camId] || (camId ? camId.slice(0, 6) : '—');
    return (
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Reviewing these photos IS the Training task — they must be
            keyboard-operable, not click-only. Same pattern as EarningsPage. */}
        <div
          role={ev?.image_url ? 'button' : undefined}
          tabIndex={ev?.image_url ? 0 : undefined}
          aria-label={ev?.image_url ? `View evidence photo for plate ${plate} from ${camName}` : undefined}
          onKeyDown={(e) => { if (ev?.image_url && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setLightbox({ url: ev.image_url, plate, camera: camName, ts: ev.created_at }); } }}
          style={{
            aspectRatio: '16/9',
            background: '#0a0a0a',
            borderRadius: 8,
            overflow: 'hidden',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: ev?.image_url ? 'zoom-in' : 'default',
            border: '1px solid var(--border-subtle)',
          }}
          onClick={() => ev?.image_url && setLightbox({ url: ev.image_url, plate, camera: camName, ts: ev.created_at })}
        >
          {ev?.image_url ? (
            <img src={ev.image_url} alt={plate} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <span style={{ fontSize: 11, color: '#666' }}>no image</span>
          )}
        </div>
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontFamily: 'ui-monospace, monospace', fontWeight: 800, fontSize: 15, letterSpacing: 0.5 }}>{plate}</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{camName}{ev ? ` · conf ${Number(ev.confidence).toFixed(2)}` : ''}</span>
          {ev?.created_at && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'ui-monospace, monospace' }}>
              {new Date(ev.created_at).toLocaleString('en-US', {
                year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', second: '2-digit',
                hour12: false,
              })}
            </span>
          )}
        </div>
      </div>
    );
  }

  const filterChips = [
    { id: 'unverified', label: 'Needs review' },
    { id: 'verified',   label: 'Verified' },
    { id: 'dismissed',  label: 'Dismissed' },
    { id: 'all',        label: 'All' },
  ];

  return (
    <div style={{ padding: '16px 0', maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 8 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>Cross-camera plate pairs</h2>
        <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          {loading ? 'Loading…' : `${pairs.length} pair${pairs.length === 1 ? '' : 's'}`}
        </span>
      </div>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5, margin: '0 0 16px' }}>
        The system sees the same truck on two cameras within ~10 seconds and pairs the plate strings. Compare the photos — if they're the same truck (front placard + rear plate), tap <strong>Same truck</strong> to verify. If two unrelated trucks happened to pass through back-to-back, tap <strong>Not the same truck</strong>. Verified pairs are trusted for closing out passes when only one plate is registered.
      </p>

      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        {filterChips.map(c => {
          const active = filter === c.id;
          return (
            <button key={c.id} onClick={() => setFilter(c.id)} style={{
              fontSize: 12, fontWeight: 800, padding: '6px 12px', borderRadius: 999,
              border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
              background: active ? 'var(--accent)' : 'var(--bg-card)',
              color: active ? '#fff' : 'var(--text)',
              cursor: 'pointer',
            }}>{c.label}</button>
          );
        })}
      </div>

      {!loading && pairs.length === 0 && (
        <div style={{ padding: '40px 12px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 14, border: '1px dashed var(--border)', borderRadius: 12 }}>
          {filter === 'unverified' ? 'Nothing to review. New pairs land here as trucks transit both gate cameras within ~10s.'
            : filter === 'verified' ? 'No verified pairs yet.'
            : filter === 'dismissed' ? 'No dismissed pairs.'
            : 'No pairs in this view.'}
        </div>
      )}

      {!loading && pairs.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(360px, 100%), 1fr))', gap: 16 }}>
          {pairs.map(pair => {
            const confPct = Math.round(Number(pair.confidence || 0) * 100);
            const confColor = confPct >= 85 ? '#16a34a' : confPct >= 70 ? '#0284c7' : '#9ca3af';
            const isDismissed = !!pair.dismissed_at;
            const isVerified = !!pair.verified_at;
            const badgeColor = isVerified ? '#16a34a' : isDismissed ? '#dc2626' : confColor;
            const badgeText = isVerified ? 'VERIFIED' : isDismissed ? 'DISMISSED' : `${confPct}%`;
            const propName = properties[pair.property_id] || '';
            return (
              <div key={pair.id} style={{
                background: 'var(--bg-card)',
                border: `1px solid ${isVerified ? 'rgba(34,197,94,.35)' : isDismissed ? 'rgba(220,38,38,.25)' : 'var(--border-subtle)'}`,
                borderRadius: 12,
                padding: 14,
                opacity: isDismissed ? 0.65 : 1,
              }}>
                <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
                  <PairSide pair={pair} side="a" />
                  <div style={{ display: 'flex', alignItems: 'center', color: 'var(--text-muted)', fontSize: 18, fontWeight: 700 }}>↔</div>
                  <PairSide pair={pair} side="b" />
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12, gap: 8 }}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <span style={{ display: 'inline-block', padding: '3px 8px', borderRadius: 6, background: badgeColor, color: '#fff', fontWeight: 800, fontSize: 11, letterSpacing: 0.5 }}>{badgeText}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {pair.observations} obs · {fmtDateTime ? fmtDateTime(pair.last_seen_at) : new Date(pair.last_seen_at).toLocaleString()}
                    </span>
                  </div>
                  {propName && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{propName}</span>}
                </div>

                <div style={{ display: 'flex', gap: 8 }}>
                  {(isDismissed || isVerified) ? (
                    <button onClick={() => reset(pair.id)} disabled={acting === pair.id} style={{
                      flex: 1, padding: '10px 12px', borderRadius: 8, fontSize: 12, fontWeight: 700,
                      border: '1px solid var(--border)', background: 'var(--bg-page, var(--bg-card))',
                      cursor: acting === pair.id ? 'wait' : 'pointer', opacity: acting === pair.id ? 0.6 : 1,
                    }}>{acting === pair.id ? '…' : 'Reset'}</button>
                  ) : (
                    <>
                      <button onClick={() => verify(pair.id)} disabled={acting === pair.id} style={{
                        flex: 1, padding: '10px 12px', borderRadius: 8, fontSize: 12, fontWeight: 800,
                        border: '1px solid #16a34a', background: '#16a34a', color: '#fff',
                        cursor: acting === pair.id ? 'wait' : 'pointer', opacity: acting === pair.id ? 0.6 : 1,
                      }}>{acting === pair.id ? '…' : '✓ Same truck'}</button>
                      <button onClick={() => dismiss(pair.id)} disabled={acting === pair.id} style={{
                        flex: 1, padding: '10px 12px', borderRadius: 8, fontSize: 12, fontWeight: 700,
                        border: '1px solid var(--border)', background: 'var(--bg-page, var(--bg-card))',
                        cursor: acting === pair.id ? 'wait' : 'pointer', opacity: acting === pair.id ? 0.6 : 1,
                      }}>{acting === pair.id ? '…' : '✗ Not the same'}</button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {lightbox && (
        <div
          role="dialog" aria-modal="true" aria-label="Evidence photo viewer — press Escape to close"
          onClick={() => setLightbox(null)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,.85)', zIndex: 1000,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, cursor: 'zoom-out',
          }}
        >
          <div style={{ maxWidth: '90vw', maxHeight: '90vh' }} onClick={e => e.stopPropagation()}>
            <img src={lightbox.url} alt={lightbox.plate} style={{ maxWidth: '90vw', maxHeight: '80vh', display: 'block', borderRadius: 8 }} />
            <div style={{ color: '#fff', marginTop: 12, fontSize: 14, textAlign: 'center' }}>
              <span style={{ fontFamily: 'ui-monospace, monospace', fontWeight: 800, fontSize: 18, letterSpacing: 1 }}>{lightbox.plate}</span>
              <span style={{ marginLeft: 12, color: '#aaa', fontFamily: 'ui-monospace, monospace' }}>
                {lightbox.camera} · {new Date(lightbox.ts).toLocaleString('en-US', {
                  year: 'numeric', month: '2-digit', day: '2-digit',
                  hour: '2-digit', minute: '2-digit', second: '2-digit',
                  hour12: false,
                })}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Platform-admin console (folded in from admin.html) ────────────
// Cross-tenant client overview, one-transaction onboarding, and feedback
// triage. Admin-only: the router gates this on isPlatformAdmin. Every read/
// write goes through the BACKEND (apiFetch) — never the Supabase client,
// whose RLS would scope results down to a single tenant.
const ADMIN_STATUSES = ['open', 'triaged', 'closed'];

function fmtAdminDate(s) {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d)) return s;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

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

// A one-time setup link (password-reset token URL) rendered with a copy button.
function AdminSetupLink({ label, url }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard?.writeText(url).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 1600);
    }).catch(() => {});
  }
  return (
    <div style={{ marginTop: 12, border: '1px dashed var(--border)', borderRadius: 10, padding: '12px 14px', background: 'var(--bg-primary)' }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>{label} · setup link — share once</div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input readOnly value={url} onFocus={e => e.target.select()} style={{ flex: '1 1 auto', minWidth: 0, fontFamily: 'ui-monospace, monospace', fontSize: 12, padding: '9px 11px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-primary)' }} />
        <button type="button" onClick={copy} style={{ flex: '0 0 auto', padding: '0 16px', background: 'var(--accent)', color: '#1a1a1a', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
    </div>
  );
}

function AdminClientsTab() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setError('');
    try {
      const data = await apiFetch('/admin/clients');
      setRows(Array.isArray(data) ? data : (data?.clients || []));
    } catch (err) { if (err.status !== 401) { setError(err.message); setRows([]); } }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (rows === null && !error) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-faint)', fontSize: 13 }}>Loading clients…</div>;
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div className="section-title" style={{ fontSize: 20 }}>Clients{rows && rows.length ? ` · ${rows.length}` : ''}</div>
        <button onClick={load} style={{ background: 'transparent', color: 'var(--text-faint)', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Refresh</button>
      </div>
      {error && <div style={{ background: 'rgba(217,83,79,.12)', border: '1px solid #D9534F', color: '#D9534F', borderRadius: 8, padding: '10px 12px', fontSize: 13, marginBottom: 12 }}>{error}</div>}
      {rows && rows.length ? (
        <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', background: 'var(--bg-card)' }}>
          {rows.map((c, i) => {
            const open = c.open_violation_count ?? 0;
            const active = c.active_pass_count ?? 0;
            return (
              <div key={c.id} className="admin-client-row" style={{ display: 'grid', gridTemplateColumns: '1.6fr .8fr 1fr auto auto', gap: 12, alignItems: 'center', padding: '14px 16px', borderTop: i ? '1px solid var(--border-subtle)' : 'none' }}>
                <div>
                  <div style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: 14 }}>{c.name || '—'}</div>
                  {c.address ? <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 2 }}>{c.address}</div> : null}
                </div>
                <div><span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--text-faint)' }}>{c.property_type || '—'}</span></div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', wordBreak: 'break-word' }}>
                  <div>{c.owner_email || '—'}</div>
                  {c.partner_email ? <div style={{ color: 'var(--text-faint)', marginTop: 2 }}>{c.partner_email}</div> : null}
                </div>
                <div style={{ textAlign: 'right', fontSize: 13, color: active ? 'var(--text-primary)' : 'var(--text-faint)' }} title="Active passes">{active}<span style={{ fontSize: 10, color: 'var(--text-faint)', display: 'block' }}>passes</span></div>
                <div style={{ textAlign: 'right', fontSize: 13, fontWeight: open ? 700 : 400, color: open ? '#D9534F' : 'var(--text-faint)' }} title="Open violations">{open}<span style={{ fontSize: 10, color: 'var(--text-faint)', display: 'block' }}>open</span></div>
              </div>
            );
          })}
        </div>
      ) : (!error && <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-faint)', fontSize: 13, border: '1px solid var(--border)', borderRadius: 12 }}>Nothing on the books yet. Onboard a property to see it here.</div>)}
    </div>
  );
}

function AdminOnboardTab() {
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [propertyType, setPropertyType] = useState('apartment');
  const [ownerOn, setOwnerOn] = useState(true);
  const [ownerName, setOwnerName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [partnerOn, setPartnerOn] = useState(false);
  const [partnerName, setPartnerName] = useState('');
  const [partnerEmail, setPartnerEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  const inputStyle = { width: '100%', padding: '11px 13px', background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-primary)', fontSize: 14, marginBottom: 12 };
  const labelStyle = { display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 };

  async function submit(e) {
    e.preventDefault();
    if (!name.trim() || !address.trim()) { setError('Property name and address are required.'); return; }
    setBusy(true); setError(''); setResult(null);
    const payload = {
      property: { name: name.trim(), address: address.trim(), property_type: propertyType },
      owner: ownerOn ? { name: ownerName.trim(), email: ownerEmail.trim() } : null,
      partner: partnerOn ? { name: partnerName.trim(), email: partnerEmail.trim() } : null,
      existing_partner_id: null,
    };
    try {
      const res = await apiFetch('/admin/clients', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      setResult(res);
      setName(''); setAddress(''); setOwnerName(''); setOwnerEmail(''); setPartnerName(''); setPartnerEmail(''); setPartnerOn(false);
    } catch (err) { if (err.status !== 401) setError(err.message); } finally { setBusy(false); }
  }

  return (
    <div>
      <div className="section-title" style={{ fontSize: 20, marginBottom: 14 }}>Onboard a property</div>
      {result && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 16, marginBottom: 16, background: 'var(--bg-card)' }}>
          <div style={{ color: '#3FA45B', fontWeight: 700, fontSize: 14 }}>✓ Property created.</div>
          {(result.owner?.setup_link || result.partner?.setup_link) ? (
            <>
              <p style={{ fontSize: 12, color: 'var(--text-faint)', margin: '10px 0 2px', lineHeight: 1.5 }}>Hand each setup link to the account holder. It sets their password and works once — treat it like a secret.</p>
              {result.owner?.setup_link && <AdminSetupLink label="Owner" url={result.owner.setup_link} />}
              {result.partner?.setup_link && <AdminSetupLink label="Partner" url={result.partner.setup_link} />}
            </>
          ) : <p style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 10 }}>No new accounts created (no setup links to share).</p>}
        </div>
      )}
      <form onSubmit={submit} style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 20, background: 'var(--bg-card)' }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 12 }}>1 · Property</div>
        <label style={labelStyle}>Property name</label>
        <input style={inputStyle} value={name} onChange={e => setName(e.target.value)} placeholder="Maple Court Apartments" />
        <label style={labelStyle}>Address</label>
        <input style={inputStyle} value={address} onChange={e => setAddress(e.target.value)} placeholder="123 Main St, Charlotte NC" />
        <label style={labelStyle}>Property type</label>
        <select style={inputStyle} value={propertyType} onChange={e => setPropertyType(e.target.value)}>
          <option value="apartment">apartment</option>
          <option value="truck_plaza">truck_plaza</option>
        </select>

        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.08em', margin: '18px 0 12px', paddingTop: 16, borderTop: '1px solid var(--border-subtle)' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', textTransform: 'none', letterSpacing: 0, fontSize: 14, color: 'var(--text-primary)' }}>
            <input type="checkbox" checked={ownerOn} onChange={e => setOwnerOn(e.target.checked)} /> 2 · Create an owner account
          </label>
        </div>
        {ownerOn && (
          <div className="admin-form-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div><label style={labelStyle}>Owner name</label><input style={inputStyle} value={ownerName} onChange={e => setOwnerName(e.target.value)} /></div>
            <div><label style={labelStyle}>Owner email</label><input style={inputStyle} type="email" value={ownerEmail} onChange={e => setOwnerEmail(e.target.value)} /></div>
          </div>
        )}

        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.08em', margin: '6px 0 12px', paddingTop: 16, borderTop: '1px solid var(--border-subtle)' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', textTransform: 'none', letterSpacing: 0, fontSize: 14, color: 'var(--text-primary)' }}>
            <input type="checkbox" checked={partnerOn} onChange={e => setPartnerOn(e.target.checked)} /> 3 · Create a partner (tow company) account
          </label>
        </div>
        {partnerOn && (
          <>
            <div className="admin-form-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div><label style={labelStyle}>Partner name</label><input style={inputStyle} value={partnerName} onChange={e => setPartnerName(e.target.value)} /></div>
              <div><label style={labelStyle}>Partner email</label><input style={inputStyle} type="email" value={partnerEmail} onChange={e => setPartnerEmail(e.target.value)} /></div>
            </div>
            <p style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 4 }}>For apartments, the partner is also set as the tow company.</p>
          </>
        )}

        <button type="submit" disabled={busy} style={{ width: '100%', marginTop: 18, padding: '13px', background: 'var(--accent)', color: '#1a1a1a', border: 'none', borderRadius: 999, fontWeight: 700, fontSize: 15, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1 }}>
          {busy ? 'Creating…' : 'Create property'}
        </button>
        {error && <div style={{ background: 'rgba(217,83,79,.12)', border: '1px solid #D9534F', color: '#D9534F', borderRadius: 8, padding: '10px 12px', fontSize: 13, marginTop: 12 }}>{error}</div>}
      </form>
    </div>
  );
}

function AdminFeedbackRow({ item }) {
  const [status, setStatus] = useState(item.status || 'open');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function change(next) {
    const prev = status;
    setStatus(next); setSaving(true); setError('');
    try {
      await apiFetch(`/admin/feedback/${item.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: next }) });
    } catch (err) { setStatus(prev); if (err.status !== 401) setError(err.message); } finally { setSaving(false); }
  }
  const kind = (item.kind || '').toLowerCase();
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, padding: '16px', borderTop: '1px solid var(--border-subtle)' }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: 14 }}>{item.property_name || '—'}</span>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', padding: '2px 8px', borderRadius: 6, background: kind === 'bug' ? 'rgba(217,83,79,.14)' : 'rgba(63,164,91,.14)', color: kind === 'bug' ? '#D9534F' : '#3FA45B' }}>{item.kind || '—'}</span>
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 8, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{item.body || ''}</div>
        <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 8 }}>{item.account_type || ''}{item.submitted_by ? ' · ' + item.submitted_by : ''}{' · ' + fmtAdminDate(item.created_at)}</div>
        {error && <div style={{ fontSize: 11, color: '#D9534F', marginTop: 6 }}>{error}</div>}
      </div>
      <select value={status} disabled={saving} onChange={e => change(e.target.value)} style={{ alignSelf: 'start', padding: '8px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-primary)', fontSize: 13 }}>
        {ADMIN_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
      </select>
    </div>
  );
}

function AdminFeedbackTab() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setError('');
    try {
      const data = await apiFetch('/admin/feedback');
      setRows(Array.isArray(data) ? data : (data?.feedback || []));
    } catch (err) { if (err.status !== 401) { setError(err.message); setRows([]); } }
  }, []);
  useEffect(() => { load(); }, [load]);
  if (rows === null && !error) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-faint)', fontSize: 13 }}>Loading feedback…</div>;
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div className="section-title" style={{ fontSize: 20 }}>Feedback{rows && rows.length ? ` · ${rows.length}` : ''}</div>
        <button onClick={load} style={{ background: 'transparent', color: 'var(--text-faint)', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Refresh</button>
      </div>
      {error && <div style={{ background: 'rgba(217,83,79,.12)', border: '1px solid #D9534F', color: '#D9534F', borderRadius: 8, padding: '10px 12px', fontSize: 13, marginBottom: 12 }}>{error}</div>}
      {rows && rows.length ? (
        <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', background: 'var(--bg-card)' }}>
          {rows.map(item => <AdminFeedbackRow key={item.id} item={item} />)}
        </div>
      ) : (!error && <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-faint)', fontSize: 13, border: '1px solid var(--border)', borderRadius: 12 }}>No notes from the field yet.</div>)}
    </div>
  );
}

function AdminConsolePage({ user }) {
  const [sub, setSub] = useState('clients');
  const tabBtn = (id, label) => (
    <button onClick={() => setSub(id)} style={{ background: sub === id ? 'var(--bg-card)' : 'transparent', color: sub === id ? 'var(--text-primary)' : 'var(--text-faint)', border: '1px solid ' + (sub === id ? 'var(--border)' : 'transparent'), borderRadius: 8, padding: '8px 14px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>{label}</button>
  );
  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 18, flexWrap: 'wrap' }}>
        {tabBtn('clients', 'Clients')}
        {tabBtn('onboard', 'Onboard')}
        {tabBtn('feedback', 'Feedback')}
      </div>
      {sub === 'clients' && <AdminClientsTab />}
      {sub === 'onboard' && <AdminOnboardTab />}
      {sub === 'feedback' && <AdminFeedbackTab />}
    </div>
  );
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


// ── Frank's app-preview tab (partner: NMLD only) ─────────────────────────
// Live embed of the NMLD Parking app (nmld-parking-preview.vercel.app)
// framed as a phone, with partner-pitch copy. The surrounding page uses
// dashboard vars so the tab reads native; the app's cream brand appears
// only inside the bezel.
const NMLD_PARTNER_ID = '1826b6b4-e8dc-402f-b4e7-926e259a56fe';
const FRANK_APP_TAB_LIVE = true; // live in Frank's partner portal since 2026-08-07
const NMLD_APP_URL = 'https://nmld-parking-preview.vercel.app';
const NMLD_APP_QR = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAALoAAAC6CAIAAACWbMCmAAAD3ElEQVR4nO3dMW4bMRCGUTvIMbbI/U+VYg/gNkWAHGAb/tQMSTnvlYElRfEHIgPucj///vn6gDE/Bn8O5EJGLgTkQkAuBH4+/+i6fn3sc9+/m975+b2enzXy3e+pv+HIp4+8aqXn39DqQkAuBORCQC4E5MJrk9HeaaVvxhn5FiPvcxW985y9vwurCwG5EJALAbkQkAvVk1HVRLNyOqja2Rl556ttp+m034XVhYBcCMiFgFwIyIX+yWivqvmlasK6p3aa5j5rL6sLAbkQkAsBuRCQC999Mlp5xd3cPPWOU88IqwsBuRCQCwG5EJAL/ZPRyv/nV51dMLJr03fiwVU0Ye39XVhdCMiFgFwIyIWAXKiejPaekHbaDtHVdrbD+afVWV0IyIWAXAjIhYBcCHy+4/OMVp450HfW99W2i9TH6kJALgTkQkAuBORC9fOM5vYyVk4QVad/z73qbvv3OW2esroQkAsBuRCQCwG5cMaeUd8EUaXvjO6nvivl+q7T86RXXiIXAnIhIBcCcqF6z6hqXjhtz6jPvfCMu75/+SerCwG5EJALAbkQkAs79oxOuxJs5Tx1v+FJfU8mI4rJhYBcCMiFgFyonoxW3kO08lV9+1P3wmvnRt656ltYXQjIhYBcCMiFgFzon4z27q3s3TeZs/fTq1hdCMiFgFwIyIWAXNhxNt3I+1R9Vt91eqfNXNfW+6fsGfESuRCQCwG5EJALr01GK2eBlSe/Vb2qysqr8qpmSasLAbkQkAsBuRCQCzvOpjvtlOy5d66ale6FM5fnGXEouRCQCwG5EJALO+4zWvlUnb5r3vbOU5fnGfGdyIWAXAjIhYBcOOM+o9OeOtQ3PVWpelZR3ze1uhCQCwG5EJALAbmw4z6jlTs7fSdpz7kWfvreedPqQkAuBORCQC4E5MIZe0Yj9j4/6PmquVMjRlTNL3PvU/U7tboQkAsBuRCQCwG50L9ntPJnTju1+2rbo1k5c3nSK+3kQkAuBORCQC70n03XZ2Qf5/wz5e6i6wZX3vPl1G6KyYWAXAjIhYBceG0yOu0Onaqfecfz6+6tp6PbM+IlciEgFwJyISAXqiejp9Oex1p1IsTcZ11b7yF6cjYdR5ALAbkQkAsBudA/Ga209+q+d3zK7dU2t1pdCMiFgFwIyIWAXPhek9FpZ31fU1fKjbzP+U+wtboQkAsBuRCQCwG50D8Z9d15NGflXTx7T7RbeYb5k9WFgFwIyIWAXAjIherJaO/1bH0ncq+c+O6pPZqVu1ojrC4E5EJALgTkQkAuBD7//vlKfp7/mtWFgFwIyIWAXAjIhY9x/wDS7j9x732MRgAAAABJRU5ErkJggg==';

function PartnerAppPage() {
  const [loaded, setLoaded] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [frameKey, setFrameKey] = React.useState(0);
  const [narrow, setNarrow] = React.useState(() => window.matchMedia('(max-width: 1100px)').matches);
  React.useEffect(() => {
    const mq = window.matchMedia('(max-width: 1100px)');
    const fn = (e) => setNarrow(e.matches);
    mq.addEventListener ? mq.addEventListener('change', fn) : mq.addListener(fn);
    return () => { mq.removeEventListener ? mq.removeEventListener('change', fn) : mq.removeListener(fn); };
  }, []);
  React.useEffect(() => {
    if (loaded) return;
    const t = setTimeout(() => { if (!loaded) setFailed(true); }, 30000);
    return () => clearTimeout(t);
  }, [loaded, frameKey]);

  const scale = narrow ? 0.66 : 0.75;
  const boxW = Math.round(414 * scale), boxH = Math.round(868 * scale);
  const bullets = [
    ['$', 'Book ahead, pay online', 'Drivers reserve and pay before they arrive. No cash, no envelope drop.'],
    ['#', 'Numbered spots', 'Every reservation is a specific spot. No circling, no doubling up.'],
    ['▤', 'The plate is the pass', "Cameras verify who's parked. No permits, no tags, no gate hardware."],
    ['⚑', 'Enforcement built in', 'Unreserved trucks get flagged automatically — and NMLD runs the tows.'],
    ['⏱', 'Live rates', null],
  ];
  const phone = (
    <div style={{width: boxW, height: boxH}}>
      <div style={{transform: `scale(${scale})`, transformOrigin: 'top left'}}>
        <div style={{position:'relative', width:414, height:868, padding:12, background:'#101113', border:'1px solid var(--border)', borderRadius:54, boxShadow:'0 24px 60px rgba(0,0,0,.5), inset 0 0 0 2px #2A2C31'}}>
          <div style={{position:'absolute', width:96, height:26, borderRadius:13, background:'#101113', top:22, left:'50%', transform:'translateX(-50%)', zIndex:2}} />
          <div style={{position:'absolute', width:110, height:5, borderRadius:3, background:'#3A3D44', bottom:11, left:'50%', transform:'translateX(-50%)', zIndex:2}} />
          <iframe key={frameKey} src={NMLD_APP_URL + "?embed=1"} title="NMLD Parking live preview" loading="lazy"
            onLoad={() => { setLoaded(true); setFailed(false); }}
            style={{width:390, height:818, border:0, borderRadius:'40px 40px 14px 14px', background:'#F2EAD8', opacity: loaded ? 1 : 0, transition:'opacity .3s'}} />
          {!loaded && !failed && (
            <div style={{position:'absolute', inset:12, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:10, borderRadius:40, background:'#F2EAD8'}}>
              <span className="spin" />
              <span style={{fontSize:12, color:'#6E6350'}}>Loading preview…</span>
            </div>
          )}
          {failed && (
            <div style={{position:'absolute', inset:12, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:8, borderRadius:40, background:'var(--bg-inset)', padding:24, textAlign:'center'}}>
              <span style={{fontSize:13, fontWeight:700, color:'var(--text-secondary)'}}>The preview is taking a while.</span>
              <span style={{fontSize:12, color:'var(--text-muted)'}}>Slow connection or a cold start — it may still appear on its own.</span>
              <button onClick={() => { setFailed(false); setLoaded(false); setFrameKey(k => k + 1); }}
                style={{marginTop:6, background:'var(--bg-inset)', border:'1px solid var(--border)', borderRadius:8, padding:'6px 14px', fontSize:12, fontWeight:700, color:'var(--text-primary)', cursor:'pointer'}}>
                Retry
              </button>
              <a href={NMLD_APP_URL} target="_blank" rel="noopener" style={{fontSize:12, color:'var(--accent)'}}>Open in browser instead</a>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div style={{width:'min(1020px, calc(100vw - 32px))', position:'relative', left:'50%', transform:'translateX(-50%)'}}>
      <div style={{fontSize:12, fontWeight:700, letterSpacing:'.08em', color:'var(--accent)', textTransform:'uppercase'}}>NMLD Parking</div>
      <h2 className="section-title" style={{fontSize:26, margin:'6px 0 8px'}}>Your parking app. Your name on it.</h2>
      <p style={{fontSize:14, color:'var(--text-muted)', maxWidth:560, lineHeight:1.55, margin:0}}>
        This is NMLD Parking — reservations, payments, and enforcement for your truck lot, running live below.
        When it ships, it's published under your own App Store and Google Play listing, powered by LotLogic.
      </p>
      <div style={{display:'flex', gap:32, alignItems: narrow ? 'center' : 'flex-start', marginTop:24, flexDirection: narrow ? 'column' : 'row'}}>
        <div style={{display:'flex', flexDirection:'column', alignItems:'center', gap:10}}>
          {phone}
          <div style={{fontSize:12, color:'var(--text-faint)', textAlign:'center', maxWidth: boxW}}>
            Live preview — the shipping version installs from the App Store and Google Play as NMLD Parking.
          </div>
        </div>
        <div style={{flex:1, minWidth:300, maxWidth: narrow ? 480 : undefined, width: narrow ? '100%' : undefined}}>
          {bullets.map(([glyph, title, body]) => (
            <div key={title} style={{display:'flex', gap:12, marginBottom:16}}>
              <div style={{width:28, height:28, borderRadius:8, background:'var(--bg-inset)', border:'1px solid var(--border)', display:'flex', alignItems:'center', justifyContent:'center', color:'var(--accent)', fontSize:14, fontWeight:800, flexShrink:0}}>{glyph}</div>
              <div>
                <div style={{fontSize:14, fontWeight:700, color:'var(--text-primary)'}}>{title}</div>
                <div style={{fontSize:13, color:'var(--text-muted)', lineHeight:1.5}}>
                  {body || (
                    <React.Fragment>
                      <span style={{color:'var(--accent)', fontVariantNumeric:'tabular-nums', fontWeight:700}}>$35</span> a night,{' '}
                      <span style={{color:'var(--accent)', fontVariantNumeric:'tabular-nums', fontWeight:700}}>$50</span> for 48 hours — shown in-app before anyone commits.
                    </React.Fragment>
                  )}
                </div>
              </div>
            </div>
          ))}
          <div style={{background:'var(--bg-card)', border:'1px solid var(--border)', borderRadius:14, padding:16, display:'flex', gap:14, alignItems:'center', marginTop:20}}>
            <div style={{flex:1}}>
              <div style={{fontSize:13, fontWeight:700, color:'var(--text-primary)', marginBottom:4}}>Open on your phone</div>
              <a href={NMLD_APP_URL} target="_blank" rel="noopener" style={{fontSize:13, color:'var(--accent)', fontFamily:'ui-monospace, monospace'}}>nmld-parking-preview.vercel.app</a>
            </div>
            <img src={NMLD_APP_QR} alt="QR code to open the NMLD Parking preview" width={96} height={96} style={{borderRadius:8, background:'#fff', padding:4}} />
          </div>
        </div>
      </div>
    </div>
  );
}

function PlateLookupPage({ user }) {
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

// ── Main App ──────────────────────────────────────────────────
function App() {
  const { addToast } = useToast();
  const { theme, toggle: toggleTheme } = useTheme();
  const { online, reconnected } = useOnlineStatus();
  const [owner, setOwner] = useState(() => {
    try {
      const s = localStorage.getItem('lotlogic_session');
      if (!s) return null;
      const parsed = JSON.parse(s);
      // Session expires after 7 days locally, or sooner if the JWT is missing.
      if (!parsed._token) {
        localStorage.removeItem('lotlogic_session');
        return null;
      }
      if (parsed._ts && Date.now() - parsed._ts > 7 * 86400000) {
        localStorage.removeItem('lotlogic_session');
        return null;
      }
      return parsed;
    } catch { return null; }
  });

  useEffect(() => {
    function onAuthExpired() {
      setOwner(null);
    }
    window.addEventListener('lotlogic:auth-expired', onAuthExpired);
    return () => window.removeEventListener('lotlogic:auth-expired', onAuthExpired);
  }, []);

  // Self-heal stale sessions: always re-fetch admin flags from /auth/me
  // on mount, so a user who was elevated to admin after their cached
  // session was stamped (even with explicit `false`) gets the upgrade
  // without having to log out + log in. The /auth/me lookup is cheap
  // (one row) and only runs once per token change.
  useEffect(() => {
    if (!owner?._token) return;
    apiFetch('/auth/me').then(me => {
      if (!me || !me.email) return;
      setOwner(prev => {
        if (!prev) return prev;
        if (prev.is_admin === !!me.is_admin && prev.is_platform_admin === !!me.is_platform_admin) {
          return prev; // no change — avoid state churn / re-renders
        }
        const merged = { ...prev, is_admin: !!me.is_admin, is_platform_admin: !!me.is_platform_admin };
        try { localStorage.setItem('lotlogic_session', JSON.stringify(merged)); } catch {}
        return merged;
      });
    }).catch(() => { /* ignore — gate falls back to JWT decode */ });
  }, [owner?._token]);
  // Parse deep link from SMS: /violations/{id} → open jobs tab and highlight
  const [deepLinkViolationId] = useState(() => {
    const path = window.location.pathname || '';
    const match = path.match(/\/violations\/([0-9a-f-]{36})/i);
    return match ? match[1] : null;
  });
  const [tab, setTab] = useState(() => {
    // Jobs tab is hidden (camera-driven; unreliable until cameras read 100% of
    // cars). Land on Lots and coerce any persisted 'jobs' so nobody opens it.
    try { const t = localStorage.getItem('lotlogic_tab'); return (!t || t === 'jobs') ? 'lots' : t; } catch { return 'lots'; }
  });
  const [lots, setLots] = useState([]);
  // True after the first successful lots fetch — tab coercion must not run
  // before this or a persisted Earnings/Billing tab gets bounced (and
  // re-persisted as 'lots') while `lots` is still the initial [].
  const [lotsLoaded, setLotsLoaded] = useState(false);
  const [lotStates, setLotStates] = useState({});
  const [violations, setViolations] = useState([]);
  const [alprViolations, setAlprViolations] = useState([]);
  const [partners, setPartners] = useState([]);
  const [viewAs, setViewAs] = useState(null); // null = owner view, partner object = partner-portal impersonation
  const [partnerSwitcherOpen, setPartnerSwitcherOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(() => {
    try { const v = localStorage.getItem('lotlogic_autorefresh'); return v !== 'false'; } catch { return true; }
  });
  const [refreshInterval, setRefreshInterval] = useState(() => {
    try { return parseInt(localStorage.getItem('lotlogic_refresh_interval')) || 30000; } catch { return 30000; }
  });
  const timerRef = useRef(null);

  // Persist settings across refresh
  useEffect(() => {
    try { localStorage.setItem('lotlogic_tab', tab); } catch {}
  }, [tab]);
  useEffect(() => {
    try { localStorage.setItem('lotlogic_autorefresh', String(autoRefresh)); } catch {}
  }, [autoRefresh]);
  useEffect(() => {
    try { localStorage.setItem('lotlogic_refresh_interval', String(refreshInterval)); } catch {}
  }, [refreshInterval]);

  const isOwner = owner?._role === 'owner' && !viewAs;
  const isOperator = owner?._role === 'partner' || !!viewAs;
  // Platform-admin (Gabe / Victor / Standard Vending) — gets admin-only surfaces.
  // Sourced from the JWT claim issued by /auth/login. Never set this from
  // partner-controlled state.
  const isPlatformAdmin = (() => {
    if (viewAs) return false;
    // Prefer the in-memory owner object (server-fresh from /auth/login or
    // the /auth/me self-heal above). Fall back to JWT-decode for the
    // first render before the owner state is hydrated.
    if (owner?.is_platform_admin === true) return true;
    if (owner?.is_platform_admin === false) return false;
    try {
      const tok = JSON.parse(localStorage.getItem('lotlogic_session') || '{}')._token;
      if (!tok) return false;
      const p = JSON.parse(atob(tok.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
      return !!p.is_platform_admin;
    } catch { return false; }
  })();

  // When viewing as a partner, filter lots/violations to that partner's lots
  const effectiveUser = viewAs ? { ...viewAs, _role: 'partner' } : owner;

  const viewAsLotIdsEarly = viewAs ? lots.filter(l => l.partner_id === viewAs.id).map(l => l.id) : null;
  // SaaS accounts (all-apartment, e.g. N Style + the apartment owners) have no
  // per-tow money flow: no legacy `lots` rows → no Earnings/Billing tabs, no
  // fee-schedule editor. Platform admins always see money surfaces; in
  // View-as-Partner the check runs against the impersonated partner's lots so
  // the admin sees exactly what that partner sees. No new flag anywhere —
  // "has zero legacy lots" IS the SaaS derivation (spec 2026-08-12).
  const showMoney = (isPlatformAdmin && !viewAs)
    || (viewAsLotIdsEarly ? viewAsLotIdsEarly.length > 0 : (lots || []).length > 0);

  useEffect(() => {
    if (!owner) return;
    // Don't coerce until lots have actually loaded once — showMoney is false
    // until then, and coercing a persisted 'earnings' tab away during that
    // window would bounce a legitimate legacy owner to Lots (and the
    // tab-persistence effect would write the bounce back to localStorage).
    // The transient `loading` flag is NOT a safe guard here: on mount this
    // effect fires before the loadData effect ever sets loading=true.
    if (!lotsLoaded) return;
    const valid = isOwner
      ? ['overview', 'lots', 'analytics', 'training', 'towactivity', 'account',
         ...(showMoney ? ['earnings', 'invoices'] : []),
         ...(isPlatformAdmin ? ['admin', 'app'] : [])]
      : ['lots', 'lookup', 'activity', 'account',
         ...(((viewAs?.id || owner?.id) === NMLD_PARTNER_ID) ? ['app'] : [])];
    if (!valid.includes(tab)) setTab('lots');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, viewAs, isOwner, isPlatformAdmin, tab, showMoney, lotsLoaded]);
  const viewAsLotIds = viewAsLotIdsEarly;
  const effectiveLots = viewAsLotIds ? lots.filter(l => viewAsLotIds.includes(l.id)) : lots;
  const effectiveViolations = viewAsLotIds ? violations.filter(v => viewAsLotIds.includes(v.lot_id)) : violations;
  const effectiveLotStates = viewAsLotIds
    ? Object.fromEntries(Object.entries(lotStates).filter(([id]) => viewAsLotIds.includes(id)))
    : lotStates;

  const realtimeRef = useRef(null);
  const loadIdRef = useRef(0); // Guard against race conditions in concurrent loadData calls

  const loadData = useCallback(async (o, silent = false) => {
    if (!o) return;
    const myId = ++loadIdRef.current; // Each call gets a unique ID
    if (!silent) setLoading(true);
    try {
      const filter = o._role === 'partner'
        ? { partner_id: o.id }
        : { owner_id: o.id };
      const lotsData = await db.getLots(filter);
      if (loadIdRef.current !== myId) return; // Stale call, discard
      setLots(lotsData);
      setLotsLoaded(true);

      // Fetch enforcement partners across both lots.partner_id and
      // properties.tow_company_id so ALPR-only properties (no lots row)
      // still surface their tow operator in the partner switcher.
      if (o._role === 'owner') {
        // Platform admins see every property, including apartment lots owned by
        // leasing offices — so pull partners across ALL properties (getAllPartnersForAdmin)
        // to surface e.g. N Style Towing in "View as Partner". Regular owners
        // stay scoped to their own properties' partners.
        (o.is_platform_admin ? db.getAllPartnersForAdmin() : db.getPartnersForOwner(o.id))
          .then(p => setPartners(p)).catch(() => {});
      }

      const [states, violsArrays] = await Promise.all([
        Promise.all(lotsData.map(l => db.getLotState(l.id).then(s => [l.id, s]).catch(() => [l.id, null]))),
        Promise.all(lotsData.map(l => db.getViolations(l.id).catch(() => []))),
      ]);
      if (loadIdRef.current !== myId) return; // Stale call, discard

      setLotStates(Object.fromEntries(states));

      const flat = [];
      lotsData.forEach((lot, i) => {
        const data = violsArrays[i];
        const items = Array.isArray(data) ? data : (data?.items || []);
        items.forEach(v => flat.push({ ...v, lot_id: v.lot_id || lot.id }));
      });
      setViolations(flat);

      // Load ALPR violations (all statuses for Jobs page + Passes tab)
      db.getAllALPRViolations(o.id, null, o._role).then(v => setAlprViolations(v)).catch(() => {});

      setLastRefresh(new Date());
    } catch (e) {
      console.error(e);
      if (!silent) addToast('Failed to load data. Check your connection.', 'error');
    }
    finally { if (!silent) setLoading(false); }
  }, [addToast]);

  function login(o) {
    const session = { ...o, _ts: Date.now() };
    setOwner(session);
    try { localStorage.setItem('lotlogic_session', JSON.stringify(session)); } catch {}
    applySupabaseAuth(session._token);
    loadData(session);

    // Partners: enrich the in-memory user with their fee + plate fields so the
    // PartnerFeeEditor and the "add tow-truck plates" nudge render against
    // real data instead of placeholders. Backend's GET /partners/me strips
    // these fields by design (PartnerSelfResponse), so go straight to
    // Supabase — column-level RLS allows the partner to SELECT their own row.
    if (session._role === 'partner' && supabase && session.id) {
      supabase
        .from('enforcement_partners')
        .select('tow_fee, boot_fee, tow_truck_plates')
        .eq('id', session.id)
        .maybeSingle()
        .then(({ data, error }) => {
          if (error || !data) return;
          const merged = { ...session, ...data, _ts: Date.now() };
          setOwner(merged);
          try { localStorage.setItem('lotlogic_session', JSON.stringify(merged)); } catch {}
        });
    }
  }

  function logout() {
    loadIdRef.current++; // Invalidate any in-flight loadData calls
    clearInterval(timerRef.current);
    if (realtimeRef.current) { supabase?.removeChannel(realtimeRef.current); realtimeRef.current = null; }
    if (alprRealtimeRef.current) { supabase?.removeChannel(alprRealtimeRef.current); alprRealtimeRef.current = null; }
    setOwner(null); setLots([]); setLotsLoaded(false); setLotStates({}); setViolations([]); setAlprViolations([]); setPartners([]); setViewAs(null);
    setTab('lots');
    try { localStorage.removeItem('lotlogic_session'); localStorage.removeItem('lotlogic_email'); } catch {}
  }

  // Pull-to-refresh handler
  async function handlePullRefresh() {
    if (refreshing || !owner) return;
    setRefreshing(true);
    haptic('medium');
    await loadData(owner, true);
    setRefreshing(false);
    haptic('light');
  }

  // Pull-to-refresh gesture
  const touchStartY = useRef(0);
  const pullDistance = useRef(0);
  const [showPTR, setShowPTR] = useState(false);
  useEffect(() => {
    if (!owner) return;
    const el = document.querySelector('.page-content');
    if (!el) return;
    function onTouchStart(e) { if (el.scrollTop <= 0) touchStartY.current = e.touches[0].clientY; else touchStartY.current = 0; }
    function onTouchMove(e) {
      if (!touchStartY.current) return;
      pullDistance.current = e.touches[0].clientY - touchStartY.current;
      if (pullDistance.current > 60 && el.scrollTop <= 0) setShowPTR(true);
    }
    function onTouchEnd() {
      if (showPTR || pullDistance.current > 80) handlePullRefresh();
      touchStartY.current = 0; pullDistance.current = 0; setShowPTR(false);
    }
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
    };
  }); // eslint-disable-line -- intentionally re-runs to capture latest handlePullRefresh/showPTR

  // Unreviewed inferred_plate_pairs count — drives the Training tab badge.
  // Refreshed every 60s so it tracks the cron-plate-pair-learn output.
  // Owner-only; partners never see this tab.
  const [trainingBadge, setTrainingBadge] = useState(0);
  useEffect(() => {
    if (!owner) return;
    let cancelled = false;
    async function refreshTrainingBadge() {
      try {
        // Must mirror the tab's default "unverified" filter exactly
        // (dismissed_at IS NULL AND verified_at IS NULL). Counting only on
        // dismissed_at meant every pair the operator verified stayed in the
        // badge forever — the badge read "40" while the tab it pointed at
        // said "Nothing to review", so operators learned to ignore it.
        const { count, error } = await supabase
          .from('inferred_plate_pairs')
          .select('id', { count: 'exact', head: true })
          .is('dismissed_at', null)
          .is('verified_at', null);
        if (!error && !cancelled) setTrainingBadge(count || 0);
      } catch { /* ignore */ }
    }
    refreshTrainingBadge();
    const t = setInterval(refreshTrainingBadge, 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [owner]);

  // Load data on mount if session was restored
  useEffect(() => { if (owner) loadData(owner); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Retry on reconnect
  useEffect(() => { if (reconnected && owner) loadData(owner, true); }, [reconnected]);

  // Auto-refresh + session expiration check
  useEffect(() => {
    if (!owner) return;
    if (!autoRefresh) { clearInterval(timerRef.current); return; }
    timerRef.current = setInterval(() => {
      // Check session expiration (7 days)
      if (owner._ts && Date.now() - owner._ts > 7 * 86400000) {
        addToast('Session expired. Please log in again.', 'error');
        logout();
        return;
      }
      if (navigator.onLine) loadData(owner, true);
    }, refreshInterval);
    return () => clearInterval(timerRef.current);
  }, [owner, loadData, autoRefresh, refreshInterval]);

  // Fast snapshot poll (every 10s) — refreshes latest_snapshot for cameras with active violations
  // so departure banners on cards update without waiting for the full 30s loadData cycle.
  // `violations` is read through a ref, NOT the dependency array: it's a new array
  // on every load, so depending on it tore the interval down and re-ran an
  // immediate all-camera poll on every refresh/realtime event — a request
  // amplifier stacked on top of the 30s loadData cycle. The ref keeps one
  // stable 10s cadence while activeCamIds() always sees current violations.
  const violationsRef = React.useRef(violations);
  violationsRef.current = violations;
  useEffect(() => {
    if (!supabase || !owner) return;
    const activeCamIds = () => {
      const pending = violationsRef.current.filter(v => ['pending', 'alerted', 'acknowledged'].includes(v.status));
      return [...new Set(pending.map(v => v.camera_id).filter(Boolean))];
    };
    const pollSnapshots = async () => {
      const camIds = activeCamIds();
      if (camIds.length === 0) return;
      try {
        const results = await Promise.all(camIds.map(cid =>
          supabase.from('snapshots')
            .select('camera_id, storage_url, url, raw_detections, captured_at, vehicles_detected')
            .eq('camera_id', cid)
            .order('captured_at', { ascending: false })
            .limit(1)
            .then(r => r.data?.[0] || null)
        ));
        setLotStates(prev => {
          const next = { ...prev };
          let changed = false;
          for (const [lotId, state] of Object.entries(next)) {
            if (!state?.cameras) continue;
            const updatedCams = state.cameras.map(cam => {
              const snap = results.find(r => r && r.camera_id === cam.camera_id);
              if (!snap) return cam;
              const base = snap.storage_url || snap.url;
              const newCaptured = snap.captured_at;
              // Only update if we have a newer snapshot
              if (cam.latest_snapshot?.captured_at && newCaptured && new Date(newCaptured) <= new Date(cam.latest_snapshot.captured_at)) return cam;
              changed = true;
              return {
                ...cam,
                latest_snapshot: {
                  url: base ? base + (base.includes('?') ? '&' : '?') + '_t=' + Date.now() : null,
                  captured_at: newCaptured,
                  vehicles_detected: snap.vehicles_detected || 0,
                  people_detected: 0,
                  plates_read: 0,
                  plate_readings: [],
                  detections: snap.raw_detections?.detections?.map((d, i) => ({
                    id: `det_${i}`,
                    type: d.class === 'person' ? 'person' : 'vehicle',
                    bbox: d.bbox ? { x: d.bbox[0] * 100, y: d.bbox[1] * 100, w: (d.bbox[2] - d.bbox[0]) * 100, h: (d.bbox[3] - d.bbox[1]) * 100 } : null,
                    confidence: d.conf,
                    label: d.class,
                  })) || [],
                },
              };
            });
            if (changed) next[lotId] = { ...state, cameras: updatedCams };
          }
          return changed ? next : prev;
        });
      } catch (e) { console.warn('Fast snapshot poll error:', e); }
    };
    pollSnapshots(); // run immediately on mount, don't wait 10s
    const iv = setInterval(pollSnapshots, 10000);
    return () => clearInterval(iv);
  }, [owner]);

  // Subscribe to realtime violation changes
  useEffect(() => {
    if (!owner || lots.length === 0) return;
    const lotIds = lots.map(l => l.id);
    // Debounce burst events (e.g. zone-guardian bulk updates) — collapse any
    // payloads that arrive within 800ms into a single loadData call. Previously
    // every event fired a full lots + properties(id) refetch, which showed up
    // as a 15+ query storm during zone re-evaluation.
    let refreshTimer = null;
    const channel = db.subscribeViolations(lotIds, (payload) => {
      if (payload.eventType === 'INSERT' && payload.new?.status === 'alerted') {
        NotifyManager.notifyNewViolation(payload.new);
      }
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => { loadData(owner, true); }, 800);
    }, (errStatus) => {
      addToast('Live updates disconnected. Data refreshes every 30s.', 'error');
    });
    realtimeRef.current = channel;
    return () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      if (channel) supabase?.removeChannel(channel);
    };
  }, [owner, lots.length, loadData, addToast]);

  // Subscribe to ALPR violation changes
  const alprRealtimeRef = useRef(null);
  useEffect(() => {
    if (!owner) return;
    let active = true;
    let refreshTimer = null;
    db.getProperties(owner.id, owner._role).then(props => {
      if (!active || !props || props.length === 0) return;
      const propIds = props.map(p => p.id);
      if (alprRealtimeRef.current) supabase?.removeChannel(alprRealtimeRef.current);
      const ch = db.subscribeALPRViolations(propIds, () => {
        if (!active) return;
        // Debounce bursts — collapse rapid plate-event / violation updates into
        // one refetch so we don't hammer /alpr_violations + /properties(id).
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
          if (!active) return;
          db.getAllALPRViolations(owner.id, null, owner._role).then(v => { if (active) setAlprViolations(v); }).catch(() => {});
        }, 800);
      });
      alprRealtimeRef.current = ch;
    }).catch(() => {});
    return () => {
      active = false;
      if (refreshTimer) clearTimeout(refreshTimer);
      if (alprRealtimeRef.current) supabase?.removeChannel(alprRealtimeRef.current);
    };
  }, [owner]);

  if (!owner) return <LoginPage onLogin={login} />;

  const pending = effectiveViolations.filter(v => ['pending', 'alerted', 'acknowledged'].includes(v.status)).length;
  const alprPending = alprViolations.filter(v => v.status === 'pending').length;

  // Handle "View as Partner" — entry point from Overview cards or header switcher
  function handleViewAs(partner) {
    setViewAs(partner);
    setPartnerSwitcherOpen(false);
    setTab('lots');
    haptic('medium');
  }
  function exitViewAs() {
    setViewAs(null);
    setPartnerSwitcherOpen(false);
    setTab('overview');
    haptic('light');
  }

  // Owner-side partners list — `partners` is already scoped to this owner
  // by getPartnersForOwner (covers both lots.partner_id and
  // properties.tow_company_id assignments). Just gate on role.
  const ownPartners = isOwner ? partners : [];

  // Role-based navigation:
  // Owner:    Overview + Jobs + Lots + Earnings + Invoices + Account
  // Operator (or viewing-as): Jobs + Lots + Activity + Earnings + Account
  const NavIconInvoices = () => React.createElement('svg', {width:22,height:22,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.8,strokeLinecap:'round',strokeLinejoin:'round'}, React.createElement('path', {d:'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z'}), React.createElement('polyline', {points:'14 2 14 8 20 8'}), React.createElement('line', {x1:'8',y1:'13',x2:'16',y2:'13'}), React.createElement('line', {x1:'8',y1:'17',x2:'12',y2:'17'}));
  const NavIconAnalytics = () => React.createElement('svg', {width:22,height:22,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.8,strokeLinecap:'round',strokeLinejoin:'round'}, React.createElement('line', {x1:'18',y1:'20',x2:'18',y2:'10'}), React.createElement('line', {x1:'12',y1:'20',x2:'12',y2:'4'}), React.createElement('line', {x1:'6',y1:'20',x2:'6',y2:'14'}));
  const NavIconTow = () => React.createElement('svg', {width:22,height:22,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.8,strokeLinecap:'round',strokeLinejoin:'round'}, React.createElement('path', {d:'M10 17h4V5H2v12h3'}), React.createElement('path', {d:'M20 17h2v-3.34a4 4 0 0 0-1.17-2.83L19 9h-5'}), React.createElement('circle', {cx:'7.5',cy:'17.5',r:'2.5'}), React.createElement('circle', {cx:'17.5',cy:'17.5',r:'2.5'}));
  const NavIconAdmin = () => React.createElement('svg', {width:22,height:22,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.8,strokeLinecap:'round',strokeLinejoin:'round'}, React.createElement('path', {d:'M12 2l7 4v6c0 4.4-3 7.5-7 9-4-1.5-7-4.6-7-9V6z'}));
  const NavIconLookup = () => React.createElement('svg', {width:22,height:22,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.8,strokeLinecap:'round',strokeLinejoin:'round'}, React.createElement('circle', {cx:'11',cy:'11',r:'7'}), React.createElement('line', {x1:'21',y1:'21',x2:'16.65',y2:'16.65'}));
  const NavIconApp = () => React.createElement('svg', {width:22,height:22,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.8,strokeLinecap:'round',strokeLinejoin:'round'}, React.createElement('rect', {x:'6.5',y:'2.5',width:'11',height:'19',rx:'2.5'}), React.createElement('line', {x1:'10.5',y1:'18.5',x2:'13.5',y2:'18.5'}));
  const navIcons = { app: NavIconApp, overview: NavIconOverview, jobs: NavIconJobs, lots: NavIconLots, earnings: NavIconEarnings, invoices: NavIconInvoices, activity: NavIconActivity, account: NavIconAccount, analytics: NavIconAnalytics, training: NavIconAnalytics, towactivity: NavIconTow, admin: NavIconAdmin, lookup: NavIconLookup };
  // Tab roles (kept intentionally narrow so each surface has one meaning):
  //   Jobs     → every violation needing action (enforcement + ALPR unified)
  //   Lots     → register + manage properties (plates, passes, cameras, plate detections)
  //   Analytics/Activity → summaries
  //   Earnings → $$
  const navTabs = isOwner ? [
    // Jobs tab hidden until cameras read 100% — everything surfaces on the pass.
    { id: 'lots',        label: 'Lots',        badge: 0 },
    { id: 'analytics',   label: 'Analytics',   badge: 0 },
    { id: 'training',    label: 'Training',    badge: trainingBadge },
    { id: 'towactivity', label: 'Tow truck',   badge: 0 },
    // SaaS (all-apartment) owners have no per-tow money flow — see showMoney.
    ...(showMoney ? [
      { id: 'earnings',    label: 'Earnings',    badge: 0 },
      { id: 'invoices',    label: 'Billing',     badge: 0 },
    ] : []),
    // Platform-admin only: the internal console (clients / onboard / feedback),
    // folded in from admin.html. Gated again at render on isPlatformAdmin.
    ...(isPlatformAdmin ? [{ id: 'admin', label: 'Admin', badge: 0 }] : []),
    // Soft launch of Frank's app-preview tab: platform admins only, for QA
    // before the partner-side entry (below) is switched on.
    ...(isPlatformAdmin ? [{ id: 'app', label: 'App', badge: 0 }] : []),
    { id: 'account',     label: 'Account',     badge: 0 },
  ] : [
    // Partner navigation. Earnings + Billing/Invoices are owner-only
    // surfaces — partners must NEVER see revenue_share, fee schedules,
    // or QuickBooks state. Removed 2026-04-28 per Gabe.
    { id: 'lots',     label: 'Lots',     badge: 0 },
    // In-lot plate lookup, folded in from lookup.html — the tow partner's
    // field tool. Shows for a partner login and when an admin views-as-partner.
    { id: 'lookup',   label: 'Lookup',   badge: 0 },
    { id: 'activity', label: 'Activity', badge: 0 },
    // NMLD only: live preview of Frank's NMLD Parking app. Held behind
    // FRANK_APP_TAB_LIVE until Gabe signs off on the admin-side QA pass.
    ...((FRANK_APP_TAB_LIVE && (viewAs?.id || owner?.id) === NMLD_PARTNER_ID) ? [{ id: 'app', label: 'App', badge: 0 }] : []),
    { id: 'account',  label: 'Account',  badge: 0 },
  ];

  const lastRefreshLabel = lastRefresh ? (
    Math.floor((Date.now() - lastRefresh) / 1000) < 10 ? 'Just now' :
    Math.floor((Date.now() - lastRefresh) / 1000) < 60 ? `${Math.floor((Date.now() - lastRefresh) / 1000)}s ago` :
    `${Math.floor((Date.now() - lastRefresh) / 60000)}m ago`
  ) : null;

  return (
    <div className={`app ${theme === 'dark' ? '' : 'theme-light'}`}>
      {/* Offline / reconnected banners */}
      {!online && <div className="offline-banner" role="alert">You're offline — data may be stale</div>}
      {reconnected && online && <div className="reconnected-banner" role="status">Back online — refreshing data</div>}

      <header className="header" role="banner">
        <div className="header-left">
          <div className="header-shield" aria-hidden="true">LL</div>
          <div className="header-wordmark">Lot<span>Logic</span></div>
        </div>
        <div className="header-right">
          <button
            className={`theme-toggle-btn ${theme === 'light' ? 'light' : ''}`}
            onClick={() => { toggleTheme(); haptic('light'); }}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          />
          {lastRefresh && (
            <div className={`conn-indicator ${online ? 'online' : 'offline'}`} title={lastRefreshLabel ? `Updated ${lastRefreshLabel}` : ''}>
              <span className={`conn-dot ${online ? 'on' : 'off'}`} />
              <span>{online ? (supabase ? 'Live' : 'Online') : 'Offline'}</span>
            </div>
          )}
          {isOwner && ownPartners.length > 0 && (
            <div style={{position:'relative'}}>
              <button
                onClick={() => setPartnerSwitcherOpen(o => !o)}
                aria-haspopup="menu"
                aria-expanded={partnerSwitcherOpen}
                title="Open one of your partners' portals"
                style={{
                  background:'rgba(167,139,250,.12)', color:'#a78bfa',
                  border:'1px solid rgba(167,139,250,.3)', borderRadius:8,
                  padding:'6px 10px', fontSize:12, fontWeight:700,
                  cursor:'pointer', whiteSpace:'nowrap',
                  display:'inline-flex', alignItems:'center', gap:6,
                }}
              >
                View as Partner
                <span style={{fontSize:10, opacity:.7}}>▾</span>
              </button>
              {partnerSwitcherOpen && (
                <>
                  <div
                    onClick={() => setPartnerSwitcherOpen(false)}
                    style={{position:'fixed', inset:0, zIndex:90}}
                    aria-hidden="true"
                  />
                  <div
                    role="menu"
                    style={{
                      position:'absolute', top:'calc(100% + 6px)', right:0, zIndex:91,
                      background:'var(--bg-card)', border:'1px solid var(--border)',
                      borderRadius:10, minWidth:240, maxWidth:320,
                      boxShadow:'0 10px 30px rgba(0,0,0,.35)', padding:6,
                    }}
                  >
                    <div style={{
                      fontSize:10, fontWeight:700, color:'var(--text-faint)',
                      textTransform:'uppercase', letterSpacing:'.05em',
                      padding:'8px 10px 4px',
                    }}>
                      Open partner portal
                    </div>
                    {ownPartners.map(p => (
                      <button
                        key={p.id}
                        role="menuitem"
                        onClick={() => handleViewAs(p)}
                        style={{
                          display:'block', width:'100%', textAlign:'left',
                          background:'transparent', color:'var(--text-primary)',
                          border:'none', borderRadius:6, padding:'8px 10px',
                          fontSize:13, fontWeight:600, cursor:'pointer',
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,.06)'}
                        onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                      >
                        <div>{p.company_name || p.contact_name}</div>
                        {p.email && <div style={{fontSize:11, color:'var(--text-faint)', marginTop:2}}>{p.email}</div>}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
          <div className="header-name" title={owner.business_name || owner.contact_name}>{owner.business_name || owner.contact_name}</div>
        </div>
      </header>

      <main id="main-content" className="page-content" role="main">
        {/* "Viewing as Partner" banner */}
        {viewAs && (
          <div style={{
            background:'linear-gradient(90deg, rgba(167,139,250,.15), rgba(59,130,246,.1))',
            border:'1px solid rgba(167,139,250,.3)', borderRadius:10, margin:'0 0 12px',
            padding:'10px 14px', display:'flex', alignItems:'center', justifyContent:'space-between',
          }}>
            <div>
              <div style={{fontSize:12, fontWeight:700, color:'#a78bfa', textTransform:'uppercase', letterSpacing:'.05em'}}>Viewing as Partner</div>
              <div style={{fontSize:14, fontWeight:800, color:'var(--text-primary)', marginTop:2}}>{viewAs.company_name || viewAs.contact_name}</div>
            </div>
            <button onClick={exitViewAs} style={{
              background:'rgba(255,255,255,.1)', color:'var(--text-primary)', border:'1px solid var(--border)',
              borderRadius:8, padding:'6px 14px', fontSize:12, fontWeight:700, cursor:'pointer',
            }}>
              Exit
            </button>
          </div>
        )}

        {/* Pull to refresh indicator */}
        {(showPTR || refreshing) && (
          <div className="ptr-spinner" role="status" aria-label="Refreshing">
            <span className="spin" />{refreshing ? 'Refreshing…' : 'Release to refresh'}
          </div>
        )}
        {/* Last updated */}
        {lastRefresh && !loading && (
          <div className="last-updated" aria-live="polite">Updated {lastRefreshLabel}</div>
        )}

        <div key={tab + (viewAs?.id || '')} className="page-slide">
          {tab === 'overview' && isOwner && !viewAs && <OverviewPage violations={violations} lots={lots} partners={partners} lotStates={lotStates} onViewAs={handleViewAs} />}
          {tab === 'jobs' && <JobsPage lots={effectiveLots} violations={effectiveViolations} alprViolations={alprViolations} loading={loading} lotStates={effectiveLotStates} onAction={() => loadData(owner, true)} isOwner={isOwner} deepLinkViolationId={deepLinkViolationId} user={effectiveUser} onNavigate={setTab} />}
          {tab === 'lots' && <ALPRPropertiesPage user={effectiveUser} impersonating={!!viewAs} />}
          {tab === 'training' && isOwner && <TrainingPage user={effectiveUser} isOwner={isOwner} />}
          {tab === 'towactivity' && isOwner && <TowActivityPage user={effectiveUser} />}
          {tab === 'earnings' && isOwner && showMoney && <EarningsPage violations={effectiveViolations} lots={effectiveLots} isOwner={isOwner} user={effectiveUser} onNavigate={setTab} />}
          {tab === 'analytics' && isOwner && <AnalyticsPage lots={lots} violations={violations} partners={partners} isOwner={isOwner} onNavigate={setTab} />}
          {tab === 'invoices' && isOwner && showMoney && <InvoicesPage lots={lots} partners={partners} user={owner} isOwner={isOwner} isPlatformAdmin={isPlatformAdmin} />}
          {tab === 'admin' && isPlatformAdmin && <AdminConsolePage user={owner} />}
          {tab === 'lookup' && isOperator && <PlateLookupPage user={effectiveUser} />}
          {tab === 'app' && (isPlatformAdmin || (FRANK_APP_TAB_LIVE && isOperator && (viewAs?.id || owner?.id) === NMLD_PARTNER_ID)) && <PartnerAppPage />}
          {tab === 'activity' && isOperator && <OperatorActivityPage violations={effectiveViolations} lots={effectiveLots} />}
          {tab === 'account' && <AccountPage user={effectiveUser} isImpersonating={!!viewAs} onLogout={logout} autoRefresh={autoRefresh} setAutoRefresh={setAutoRefresh} refreshInterval={refreshInterval} setRefreshInterval={setRefreshInterval} showFees={showMoney} isPlatformAdmin={isPlatformAdmin} />}
        </div>
      </main>

      <nav className="bottom-nav" role="navigation" aria-label="Main navigation">
        {/* Each button carries role="tab"; axe's aria-required-parent rule needs
            that role contained by role="tablist". The outer <nav> keeps its
            navigation landmark, so the tablist role goes on this wrapper —
            display:contents keeps it out of the flex layout .bottom-nav relies
            on for its direct children. */}
        <div role="tablist" aria-label="Main navigation" style={{display: 'contents'}}>
          {navTabs.map(t => {
            const Icon = navIcons[t.id];
            return (
              <button key={t.id}
                className={`nav-item ${tab === t.id ? 'active' : ''}`}
                onClick={() => { setTab(t.id); haptic('light'); }}
                aria-label={`${t.label}${t.badge > 0 ? `, ${t.badge} pending` : ''}`}
                aria-current={tab === t.id ? 'page' : undefined}
                role="tab"
                aria-selected={tab === t.id}
              >
                {t.badge > 0 && <span className="nav-badge" aria-hidden="true">{t.badge}</span>}
                {Icon && <Icon />}
                <span className="nav-label">{t.label}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <ErrorBoundary label="the dashboard"><ToastProvider><App /></ToastProvider></ErrorBoundary>
);
