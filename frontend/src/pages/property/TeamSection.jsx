import React, { useState, useEffect, useCallback } from 'react';
import { requestsApi } from '../../lib/requestsApi.js';
import { useToast } from '../../ui/Toast.jsx';

// ── Account → Team, per property (spec §5.7, §3.7) ───────────
//
// One of these per property an owner is an active member of, rendered under
// Account (AccountPage.jsx), not on the property detail page. Management —
// Add a teammate, Remove access, Approve/Decline — is `admin`-only; a plain
// `manager`/`viewer` member sees the same roster read-only, because they
// aren't the one who decides who else gets in.
function lastSignedInLabel(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const weekday = d.toLocaleDateString([], { weekday: 'short' });
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `last signed in ${weekday} ${time}`;
}

function roleLabel(role) {
  return role === 'viewer' ? 'View only' : 'Manager';
}

export function TeamSection({ property, user }) {
  const { addToast } = useToast();
  const isAdmin = property?.role === 'admin';
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showInvite, setShowInvite] = useState(false);
  const [invite, setInvite] = useState({ email: '', name: '', role: 'manager', admin: false });
  const [inviting, setInviting] = useState(false);
  const [busyId, setBusyId] = useState(null); // account_id of a row mid-action
  const [error, setError] = useState('');

  const load = useCallback(() => {
    if (!property?.id) return;
    setLoading(true);
    requestsApi.listMembers(property.id)
      .then(res => setMembers(Array.isArray(res) ? res : (res?.members || res?.items || [])))
      .catch(() => setMembers([]))
      .finally(() => setLoading(false));
  }, [property?.id]);

  useEffect(() => { load(); }, [load]);

  const active = members.filter(m => m.status === 'active');
  const pending = members.filter(m => m.status === 'pending');

  async function sendInvite(e) {
    e.preventDefault();
    if (inviting) return;
    setInviting(true);
    setError('');
    try {
      await requestsApi.inviteMember(property.id, { email: invite.email.trim(), name: invite.name.trim(), role: invite.role, admin: invite.admin });
      setInvite({ email: '', name: '', role: 'manager', admin: false });
      setShowInvite(false);
      addToast('Invite sent', 'success');
      load();
    } catch (e2) {
      setError(e2.message || 'Could not send the invite — try again.');
    } finally {
      setInviting(false);
    }
  }

  async function removeAccess(m) {
    if (!confirm(`${m.name || m.contact_name || 'This person'} will lose access to ${property.name} on LotLogic. Their past requests stay on the record.`)) return;
    setBusyId(m.account_id);
    try {
      await requestsApi.removeMember(property.id, m.account_id);
      load();
    } catch (e2) {
      addToast(e2.code === 'last_admin' ? "Can't remove the last admin — promote someone else first." : (e2.message || 'Could not remove access.'), 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function approve(m) {
    setBusyId(m.account_id);
    try { await requestsApi.approveMember(property.id, m.account_id); load(); }
    catch (e2) { addToast(e2.message || 'Could not approve.', 'error'); }
    finally { setBusyId(null); }
  }

  async function decline(m) {
    setBusyId(m.account_id);
    try { await requestsApi.declineMember(property.id, m.account_id); load(); }
    catch (e2) { addToast(e2.message || 'Could not decline.', 'error'); }
    finally { setBusyId(null); }
  }

  return (
    <div className="settings-section">
      <div className="settings-section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>Who can authorize requests — {property?.name}</span>
        {isAdmin && (
          <button onClick={() => setShowInvite(v => !v)} style={{ background: 'transparent', border: 'none', color: 'var(--accent)', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
            {showInvite ? 'Cancel' : '+ Add a teammate'}
          </button>
        )}
      </div>

      {loading ? (
        <div style={{ fontSize: 12, color: 'var(--text-faint)', padding: '8px 0' }}>Loading…</div>
      ) : (
        <>
          {active.map(m => {
            const signedIn = lastSignedInLabel(m.last_signed_in_at);
            return (
              <div className="settings-row" key={m.account_id}>
                <div className="settings-row-info">
                  <div className="settings-row-label">{m.name || m.contact_name}</div>
                  {/* Not `.settings-row-desc` — that shared class's
                      `--text-faint` is 2.62:1 on `--bg-card` in the dark
                      theme (axe: color-contrast, serious), pre-existing and
                      out of this task's scope to fix globally. `--text-muted`
                      is the same visual role (secondary line) at 5.14:1. */}
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                    {[m.position, m.email, signedIn].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div className="settings-row-value">{roleLabel(m.role)}</div>
                  {isAdmin && m.account_id !== user?.id && (
                    <button
                      onClick={() => removeAccess(m)}
                      disabled={busyId === m.account_id}
                      style={{ background: 'rgba(239,68,68,.15)', color: '#f87171', border: '1px solid rgba(239,68,68,.3)', borderRadius: 6, padding: '5px 9px', fontSize: 11, fontWeight: 700, cursor: busyId === m.account_id ? 'wait' : 'pointer' }}
                    >Remove access</button>
                  )}
                </div>
              </div>
            );
          })}

          {pending.map(m => (
            <div className="settings-row" key={m.account_id}>
              <div className="settings-row-info">
                <div className="settings-row-label">{m.name || m.contact_name} wants to join{m.position ? ` as ${m.position}` : ''}</div>
              </div>
              {isAdmin ? (
                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={() => approve(m)} disabled={busyId === m.account_id} style={{ background: 'rgba(74,222,128,.12)', color: '#4ade80', border: '1px solid rgba(74,222,128,.3)', borderRadius: 6, padding: '5px 10px', fontSize: 11, fontWeight: 700, cursor: busyId === m.account_id ? 'wait' : 'pointer' }}>Approve</button>
                  <button onClick={() => decline(m)} disabled={busyId === m.account_id} style={{ background: 'rgba(239,68,68,.15)', color: '#f87171', border: '1px solid rgba(239,68,68,.3)', borderRadius: 6, padding: '5px 10px', fontSize: 11, fontWeight: 700, cursor: busyId === m.account_id ? 'wait' : 'pointer' }}>Decline</button>
                </div>
              ) : (
                <div className="settings-row-value">Pending</div>
              )}
            </div>
          ))}

          {active.length === 0 && pending.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-faint)', padding: '8px 0' }}>No teammates yet.</div>
          )}
        </>
      )}

      {isAdmin && showInvite && (
        <form onSubmit={sendInvite} style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
          <input value={invite.name} onChange={e => setInvite({ ...invite, name: e.target.value })} placeholder="Full name" required
            style={{ padding: '10px 12px', background: 'var(--bg-inset)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-primary)', fontSize: 14 }} />
          <input type="email" value={invite.email} onChange={e => setInvite({ ...invite, email: e.target.value })} placeholder="Work email" required
            style={{ padding: '10px 12px', background: 'var(--bg-inset)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-primary)', fontSize: 14 }} />
          <div style={{ display: 'flex', gap: 6 }}>
            {['manager', 'viewer'].map(r => (
              <button key={r} type="button" onClick={() => setInvite({ ...invite, role: r })}
                style={{
                  flex: 1, padding: '8px', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer',
                  border: invite.role === r ? '1px solid var(--accent)' : '1px solid var(--border)',
                  background: invite.role === r ? 'var(--accent)' : 'transparent',
                  // '#fff' on --accent's dark-theme gold fails contrast — see
                  // AddPropertyForm.jsx's submit button for the same fix.
                  color: invite.role === r ? '#1A1206' : 'var(--text-primary)',
                }}
              >{r === 'manager' ? 'Manager' : 'View only'}</button>
            ))}
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-muted)', fontWeight: 600 }}>
            <input type="checkbox" checked={invite.admin} onChange={e => setInvite({ ...invite, admin: e.target.checked })} />
            Can add people
          </label>
          {error && <div style={{ color: '#f87171', fontSize: 12 }}>{error}</div>}
          <button type="submit" disabled={inviting} style={{ background: 'var(--accent)', color: '#1A1206', border: 'none', borderRadius: 8, padding: '10px', fontSize: 13, fontWeight: 700, cursor: inviting ? 'wait' : 'pointer' }}>
            {inviting ? 'Sending…' : 'Send invite'}
          </button>
        </form>
      )}
    </div>
  );
}
