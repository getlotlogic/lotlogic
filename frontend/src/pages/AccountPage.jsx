import React, { useState } from 'react';
import { apiFetch } from '../lib/api.js';
import { supabase } from '../lib/supabase.js';
import { NotifyManager } from '../lib/notify.js';
import { useToast } from '../ui/Toast.jsx';
import { TowTruckPlatesEditor } from './account/TowTruckPlatesEditor.jsx';

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

export function AccountPage({ user, isImpersonating, onLogout, autoRefresh, setAutoRefresh, refreshInterval, setRefreshInterval, showFees = true, isPlatformAdmin = false }) {
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
