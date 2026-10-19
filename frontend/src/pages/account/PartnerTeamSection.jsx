import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { listTeam, inviteTeammate, patchTeammate, removeTeammate, resendTeammate, assignProperties } from '../../lib/requestsApi.js';
import { db, isImpersonating } from '../../lib/db.js';
import { scopePropsToPartner } from '../../shared/scope.js';
import { useToast } from '../../ui/Toast.jsx';
import {
  TEAM_ROLES, teamRoleLabel, canManageTeam, teamMembers, buildInvite,
  memberStatusLine, memberPhone, lastAdminBlocked, LAST_ADMIN_REASON,
  teamErrorMessage, removeConfirmText,
  canAssignProperties, propertiesRow, memberPropertyIds, assignableProperties, sameIdSet, idsToSave,
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
// P2 (spec §2.2, §2.3): each member's **Properties** row — "All properties"
// for an Admin or Dispatch, a checklist with Save for a Truck when the
// viewer may assign (Admin, Dispatch), read-only text otherwise; "No
// properties yet" in amber for a Truck with none. The checklist lists the
// company's live properties as the VIEWER's `/auth/me.properties` gives them
// (an Admin or Dispatch is unrestricted, so that is every one), read through
// `db.getProperties` so a platform admin's View as Partner gets the viewed
// company's own (the `tow_company_id` column read) rather than the admin's.
// The P3 field (`slack_linked`) is not rendered yet.

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
// `--yellow` is the dashboard's amber, 4.5:1 or better on `--bg-card` in
// both themes (the Requests tab's "not yet confirmed" uses it the same way).
const AMBER = 'var(--yellow)';
// Read by a screen reader, not shown: the dashboard shell has no class for it.
const VISUALLY_HIDDEN = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0,
};

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
  // Properties (P2): the checklist's rows, each Truck's unsaved picks, and a
  // failed save's sentence, by member id.
  const assign = canAssignProperties(user);
  const [companyProperties, setCompanyProperties] = useState(null); // null = not loaded
  const [picks, setPicks] = useState({});
  const [assignErrors, setAssignErrors] = useState({});
  const [savingId, setSavingId] = useState(null); // member id of a Save in flight

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

  // Only someone who may assign needs the company's property list; a Truck's
  // section never asks for it.
  useEffect(() => {
    if (!assign || !user?.id) return undefined;
    let alive = true;
    db.getProperties(user.id, user._role)
      .then(p => { if (alive) setCompanyProperties(assignableProperties(scopePropsToPartner(p || [], user))); })
      .catch(() => { if (alive) setCompanyProperties([]); });
    return () => { alive = false; };
  }, [assign, user?.id, user?._role]); // eslint-disable-line react-hooks/exhaustive-deps

  const propertyNames = useMemo(() => {
    const map = {};
    for (const p of companyProperties || []) map[p.id] = p.name;
    return map;
  }, [companyProperties]);

  function picked(m) {
    return Object.prototype.hasOwnProperty.call(picks, m.id) ? picks[m.id] : memberPropertyIds(m);
  }

  function togglePick(m, propertyId, on) {
    const current = picked(m);
    const next = on ? [...current.filter(id => id !== propertyId), propertyId] : current.filter(id => id !== propertyId);
    setPicks(prev => ({ ...prev, [m.id]: next }));
    setAssignErrors(prev => ({ ...prev, [m.id]: '' }));
  }

  async function saveProperties(m) {
    const ids = idsToSave(picked(m), companyProperties);
    setBusyId(m.id);
    setSavingId(m.id);
    setAssignErrors(prev => ({ ...prev, [m.id]: '' }));
    try {
      const res = await assignProperties(m.id, ids, { partnerId });
      // The row takes the server's answer; a response without the member
      // still shows what was saved.
      const saved = res && res.member && typeof res.member === 'object'
        ? res.member
        : { properties: ids.map(id => ({ id, name: propertyNames[id] || '' })) };
      setMembers(prev => prev.map(x => (x.id === m.id ? { ...x, ...saved, id: x.id } : x)));
      setPicks(prev => { const next = { ...prev }; delete next[m.id]; return next; });
      addToast(`Properties saved for ${m.name || 'that teammate'}`, 'success');
    } catch (e2) {
      setAssignErrors(prev => ({ ...prev, [m.id]: teamErrorMessage(e2, 'Could not save those properties. Try again.') }));
    } finally {
      setBusyId(null);
      setSavingId(null);
    }
  }

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
        const row = propertiesRow(m, user, propertyNames);
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
            {row && (
              <MemberProperties
                member={m}
                row={row}
                properties={companyProperties}
                picked={row.kind === 'checklist' ? picked(m) : []}
                busy={busy}
                saving={savingId === m.id}
                error={assignErrors[m.id] || ''}
                onToggle={(propertyId, on) => togglePick(m, propertyId, on)}
                onSave={() => saveProperties(m)}
              />
            )}
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

// One member's Properties row (spec §2.3). `row` is `propertiesRow(...)`.
function MemberProperties({ member, row, properties, picked, busy, saving, error, onToggle, onSave }) {
  const label = <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 4 }}>Properties</div>;
  const wrap = { flexBasis: '100%', minWidth: 0 };
  if (row.kind !== 'checklist') {
    return (
      <div style={wrap} data-testid="member-properties">
        {label}
        <div style={{ fontSize: 13, fontWeight: row.empty ? 700 : 600, color: row.empty ? AMBER : 'var(--text-primary)' }}>{row.text}</div>
      </div>
    );
  }
  const saved = memberPropertyIds(member);
  const unchanged = sameIdSet(saved, picked);
  const list = properties || [];
  return (
    <fieldset style={{ ...wrap, border: 'none', margin: 0, padding: 0 }} data-testid="member-properties">
      <legend style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 4, padding: 0 }}>
        Properties<span style={VISUALLY_HIDDEN}> for {member.name}</span>
      </legend>
      {row.note && <div style={{ fontSize: 13, fontWeight: 700, color: AMBER, marginBottom: 6 }}>{row.note}</div>}
      {properties === null && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading properties…</div>}
      {properties !== null && list.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Your company has no properties to assign yet.</div>
      )}
      {list.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {list.map(p => (
            <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-primary)', cursor: busy ? 'wait' : 'pointer' }}>
              <input
                type="checkbox"
                checked={picked.includes(p.id)}
                disabled={busy}
                onChange={e => onToggle(p.id, e.target.checked)}
              />
              {p.name}
            </label>
          ))}
          <div>
            <button
              type="button"
              style={{ ...rowBtn, marginTop: 4, cursor: busy ? 'wait' : unchanged ? 'not-allowed' : 'pointer', opacity: unchanged ? 0.6 : 1 }}
              disabled={busy || unchanged}
              aria-label={`Save properties for ${member.name}`}
              onClick={onSave}
            >{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      )}
      {error && <div role="alert" style={{ color: 'var(--red)', fontSize: 12, marginTop: 6 }}>{error}</div>}
    </fieldset>
  );
}
