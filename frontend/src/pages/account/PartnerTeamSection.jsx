import React, { useState, useEffect, useCallback } from 'react';
import { listTeam, inviteTeammate, patchTeammate, removeTeammate, resendTeammate } from '../../lib/requestsApi.js';
import { isImpersonating } from '../../lib/db.js';
import { useToast } from '../../ui/Toast.jsx';
import {
  TEAM_ROLES, teamRoleLabel, canManageTeam, teamMembers, buildInvite,
  memberStatusLine, memberPhone, lastAdminBlocked, LAST_ADMIN_REASON,
  teamErrorMessage, removeConfirmText,
} from '../../lib/partnerTeam.js';

// ── Partner Account → Team (spec 2026-10-18-tow-company-team §1.4) ──
//
// The tow company's people: everyone on the team sees the roster; an Admin
// adds a teammate, changes a role, removes access and resends a set-up link.
// The shape is the office's `pages/property/TeamSection.jsx`.
//
// The whole section is absent (not an error state) while the first
// `GET /partner/team` is in flight and when it 404s — a backend that has not
// shipped the route, or a session the route does not answer for (a platform
// admin's View as Partner), exactly as SlackSection hides itself.
//
// P2/P3 fields on a member (`properties`, `slack_linked`) are not rendered
// yet.

const EMPTY_INVITE = { name: '', email: '', phone: '', role: '' };

const inputStyle = {
  width: '100%', boxSizing: 'border-box', padding: '10px 12px', background: 'var(--bg-inset)',
  border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-primary)', fontSize: 14,
  fontFamily: 'inherit',
};
const labelStyle = { display: 'block', fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 4 };
const rowBtn = {
  background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 9px',
  fontSize: 11, fontWeight: 700, color: 'var(--text-primary)', cursor: 'pointer', fontFamily: 'inherit',
  whiteSpace: 'nowrap',
};
// `--red` on the card passes 4.5:1 in both themes; the office section's
// #f87171-on-pink does not in the light theme (axe: color-contrast).
const removeBtn = { ...rowBtn, color: 'var(--red)', border: '1px solid var(--red)' };

export function PartnerTeamSection({ user }) {
  const { addToast } = useToast();
  const manage = canManageTeam(user);
  const companyName = user?.company_name || user?.business_name || '';
  // "View as Partner": the session is a platform admin's, `user` is the company
  // viewed; every call names it, and the backend allows that for an admin only.
  const partnerId = isImpersonating(user?.id) ? user.id : undefined;

  // null = first load in flight; false = 404, hide the section; true = show it.
  const [available, setAvailable] = useState(null);
  const [members, setMembers] = useState([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [invite, setInvite] = useState(EMPTY_INVITE);
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null); // member id of a row mid-action

  const load = useCallback(() => (
    listTeam({ partnerId })
      .then(res => { setMembers(teamMembers(res)); setLoadFailed(false); setAvailable(true); })
      .catch(e => {
        if (e && e.status === 404) { setAvailable(false); return; }
        setLoadFailed(true);
        setAvailable(true);
      })
  ), []);

  useEffect(() => { load(); }, [load, user?.id]);

  async function sendInvite(e) {
    e.preventDefault();
    if (inviting) return;
    const built = buildInvite(invite);
    if (!built.ok) {
      setError(Object.values(built.errors)[0]);
      return;
    }
    setInviting(true);
    setError('');
    try {
      await inviteTeammate(built.body, { partnerId });
      setInvite(EMPTY_INVITE);
      setShowInvite(false);
      addToast(`Invite sent to ${built.body.email}`, 'success');
      load();
    } catch (e2) {
      setError(teamErrorMessage(e2, 'Could not send the invite. Try again.'));
    } finally {
      setInviting(false);
    }
  }

  async function changeRole(m, role) {
    if (role === m.role) return;
    setBusyId(m.id);
    try {
      await patchTeammate(m.id, { role }, { partnerId });
      setMembers(prev => prev.map(x => (x.id === m.id ? { ...x, role } : x)));
      addToast(`${m.name || 'That teammate'} is now ${teamRoleLabel(role)}`, 'success');
    } catch (e2) {
      addToast(teamErrorMessage(e2, 'Could not change that role. Try again.'), 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function removeAccess(m) {
    if (!window.confirm(removeConfirmText(m, companyName))) return;
    setBusyId(m.id);
    try {
      await removeTeammate(m.id, { partnerId });
      setMembers(prev => prev.filter(x => x.id !== m.id));
    } catch (e2) {
      addToast(teamErrorMessage(e2, 'Could not remove access. Try again.'), 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function resend(m) {
    setBusyId(m.id);
    try {
      await resendTeammate(m.id, { partnerId });
      addToast(m.email ? `Set-up link sent to ${m.email}` : 'Set-up link sent', 'success');
    } catch (e2) {
      addToast(teamErrorMessage(e2, 'Could not send the set-up link. Try again.'), 'error');
    } finally {
      setBusyId(null);
    }
  }

  if (available !== true) return null;

  return (
    <div className="settings-section" id="team-section" aria-labelledby="team-section-title">
      <div className="settings-section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span id="team-section-title">Team</span>
        {manage && (
          <button
            type="button"
            onClick={() => { setShowInvite(v => !v); setError(''); }}
            aria-expanded={showInvite}
            style={{ background: 'transparent', border: 'none', color: 'var(--accent)', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}
          >
            {showInvite ? 'Cancel' : 'Add a teammate'}
          </button>
        )}
      </div>

      {loadFailed && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '10px 16px' }}>Could not load your team. Try again in a moment.</div>
      )}

      {!loadFailed && members.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '10px 16px' }}>No teammates yet.</div>
      )}

      {members.map(m => {
        const blocked = lastAdminBlocked(members, m);
        const busy = busyId === m.id;
        const isSelf = !!user?.member_id && m.id === user.member_id;
        const line = [memberPhone(m.phone), memberStatusLine(m)].filter(Boolean).join(' · ');
        return (
          <div className="settings-row" key={m.id} data-testid="team-member" style={{ flexWrap: 'wrap', gap: 8 }}>
            <div className="settings-row-info">
              <div className="settings-row-label">{m.name}</div>
              {/* `--text-muted`, not `.settings-row-desc`'s `--text-faint`
                  (2.62:1 on `--bg-card` in the dark theme) — the office
                  TeamSection's same fix. */}
              {line && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{line}</div>}
              {manage && blocked && (
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{LAST_ADMIN_REASON}</div>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {manage ? (
                <select
                  aria-label={`Role for ${m.name}`}
                  value={m.role}
                  disabled={blocked || busy}
                  onChange={e => changeRole(m, e.target.value)}
                  style={{ background: 'var(--bg-inset)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 8, padding: '4px 8px', fontSize: 13, fontWeight: 600, fontFamily: 'inherit' }}
                >
                  {TEAM_ROLES.map(r => <option key={r} value={r}>{teamRoleLabel(r)}</option>)}
                </select>
              ) : (
                <div className="settings-row-value">{teamRoleLabel(m.role)}</div>
              )}
              {manage && m.has_password === false && (
                <button type="button" style={rowBtn} disabled={busy} onClick={() => resend(m)}>Resend set-up link</button>
              )}
              {manage && !isSelf && (
                <button
                  type="button"
                  style={{ ...removeBtn, cursor: blocked ? 'not-allowed' : busy ? 'wait' : 'pointer', opacity: blocked ? 0.6 : 1 }}
                  disabled={blocked || busy}
                  onClick={() => removeAccess(m)}
                >Remove access</button>
              )}
            </div>
          </div>
        );
      })}

      {manage && showInvite && (
        <form onSubmit={sendInvite} noValidate aria-label="Add a teammate" style={{ display: 'flex', flexDirection: 'column', gap: 10, borderTop: '1px solid var(--border)', padding: '12px 16px 16px' }}>
          <div>
            <label htmlFor="team-invite-name" style={labelStyle}>Name</label>
            <input id="team-invite-name" value={invite.name} autoComplete="off"
              onChange={e => setInvite({ ...invite, name: e.target.value })} style={inputStyle} />
          </div>
          <div>
            <label htmlFor="team-invite-email" style={labelStyle}>Email</label>
            <input id="team-invite-email" type="email" value={invite.email} autoComplete="off" autoCapitalize="none"
              onChange={e => setInvite({ ...invite, email: e.target.value })} style={inputStyle} />
          </div>
          <div>
            <label htmlFor="team-invite-phone" style={labelStyle}>Phone (optional)</label>
            <input id="team-invite-phone" type="tel" inputMode="tel" value={invite.phone} autoComplete="off"
              onChange={e => setInvite({ ...invite, phone: e.target.value })} style={inputStyle} />
          </div>
          <fieldset style={{ border: 'none', margin: 0, padding: 0 }}>
            <legend style={labelStyle}>Role</legend>
            <div style={{ display: 'flex', gap: 6 }}>
              {TEAM_ROLES.map(r => {
                const on = invite.role === r;
                return (
                  <label key={r} style={{
                    flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                    padding: '8px', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer',
                    border: on ? '1px solid var(--accent)' : '1px solid var(--border)',
                    background: on ? 'var(--accent)' : 'transparent',
                    // --accent-ink is the ink that passes on --accent in each theme.
                    color: on ? 'var(--accent-ink)' : 'var(--text-primary)',
                  }}>
                    <input type="radio" name="team-invite-role" value={r} checked={on}
                      onChange={() => setInvite({ ...invite, role: r })} />
                    {teamRoleLabel(r)}
                  </label>
                );
              })}
            </div>
          </fieldset>
          {error && <div role="alert" style={{ color: 'var(--red)', fontSize: 12 }}>{error}</div>}
          <button type="submit" disabled={inviting} style={{ background: 'var(--accent)', color: 'var(--accent-ink)', border: 'none', borderRadius: 8, padding: '10px', fontSize: 13, fontWeight: 700, cursor: inviting ? 'wait' : 'pointer', fontFamily: 'inherit' }}>
            {inviting ? 'Sending…' : 'Send invite'}
          </button>
        </form>
      )}
    </div>
  );
}
