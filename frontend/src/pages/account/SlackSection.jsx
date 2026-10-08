import React from 'react';
import { getSlackStatus, listSlackIdentities, updateSlackIdentity, deleteSlackIdentity, slackInstallLink } from '../../lib/requestsApi.js';
import { ConfirmActionModal } from '../../ui/Dialog.jsx';
import { useToast } from '../../ui/Toast.jsx';
import { roleLabel, slackState } from './slackSection.js';

// ── Partner Account → Connect Slack / Slack people (spec §5.7, §6.1) ──
//
// `GET /partner/slack/status` drives everything below via the `slackState`
// state machine (not_connected | connected_no_feed | connected | revoked).
// The whole section is hidden — not an empty/error state, just absent — when
// that route 404s: a backend that hasn't shipped Task 17 yet.
//
// `roleLabel` is the only place a Slack `role` becomes text a person reads;
// it never renders the toggled-off role's own name, so the per-row switch
// below reads "Make office"/"Make truck" rather than echoing the DB value.

const ET = 'America/New_York';

function formatLastCheck(iso) {
  if (!iso) return 'never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'never';
  return d.toLocaleString('en-US', {
    timeZone: ET, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }) + ' ET';
}

const rowBtn = {
  background: 'transparent', border: '1px solid var(--border)', borderRadius: 8,
  padding: '7px 12px', fontSize: 12, fontWeight: 700, color: 'var(--text-primary)',
  cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
};
const primaryBtn = {
  ...rowBtn, background: 'var(--accent)', border: '1px solid var(--accent)', color: '#fff',
};

export function SlackSection({ user }) {
  const { addToast } = useToast();

  // null = still loading; false = 404'd, hide the whole section; true = show it.
  const [available, setAvailable] = React.useState(null);
  const [status, setStatus] = React.useState(null);
  const [connecting, setConnecting] = React.useState(false);
  const [connectErr, setConnectErr] = React.useState('');

  const [identities, setIdentities] = React.useState([]);
  const [identitiesLoading, setIdentitiesLoading] = React.useState(false);
  const [roleBusyId, setRoleBusyId] = React.useState(null);
  const [removeTarget, setRemoveTarget] = React.useState(null);
  const [removing, setRemoving] = React.useState(false);

  React.useEffect(() => {
    let active = true;
    getSlackStatus()
      .then(s => { if (active) { setStatus(s); setAvailable(true); } })
      .catch(e => {
        if (!active) return;
        if (e && e.status === 404) { setAvailable(false); return; }
        // Any other failure (offline, 500) falls back to the not_connected
        // render rather than hiding a feature that does exist — a stuck
        // spinner is worse than a Connect Slack button that just retries.
        setStatus(null);
        setAvailable(true);
      });
    return () => { active = false; };
  }, [user?.id]);

  const state = slackState(status);
  const showPeople = available === true && (state === 'connected' || state === 'connected_no_feed');

  React.useEffect(() => {
    if (!showPeople) return;
    let active = true;
    setIdentitiesLoading(true);
    listSlackIdentities()
      .then(rows => {
        if (!active) return;
        const list = Array.isArray(rows) ? rows : (rows && rows.items) || [];
        setIdentities(list.filter(i => i.status !== 'removed'));
      })
      .catch(() => { if (active) setIdentities([]); })
      .finally(() => { if (active) setIdentitiesLoading(false); });
    return () => { active = false; };
  }, [showPeople]);

  async function connect() {
    setConnecting(true);
    setConnectErr('');
    try {
      const { url } = await slackInstallLink();
      if (!url) throw new Error('Slack did not return an install link.');
      window.location = url;
    } catch (e) {
      setConnectErr(e.message || 'Could not start connecting Slack.');
      setConnecting(false);
    }
  }

  async function toggleRole(identity) {
    const nextRole = identity.role === 'manager' ? 'driver' : 'manager';
    setRoleBusyId(identity.slack_user_id);
    try {
      await updateSlackIdentity(identity.slack_user_id, { role: nextRole });
      setIdentities(prev => prev.map(i => (
        i.slack_user_id === identity.slack_user_id ? { ...i, role: nextRole } : i
      )));
    } catch (e) {
      addToast(e.message || 'Could not change that role.', 'error');
    } finally {
      setRoleBusyId(null);
    }
  }

  async function confirmRemove() {
    if (!removeTarget) return;
    setRemoving(true);
    try {
      await deleteSlackIdentity(removeTarget.slack_user_id);
      setIdentities(prev => prev.filter(i => i.slack_user_id !== removeTarget.slack_user_id));
      addToast(`Removed ${removeTarget.display_name || 'that person'} from Slack people.`, 'success');
      setRemoveTarget(null);
    } catch (e) {
      addToast(e.message || 'Could not remove that person.', 'error');
    } finally {
      setRemoving(false);
    }
  }

  if (available !== true) return null;

  return (
    <div className="settings-section" id="slack-section">
      <div className="settings-section-title">Slack</div>

      {state === 'not_connected' && (
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Connect Slack</div>
            <div className="settings-row-desc">Get a yes/no on a plate right in your crew's Slack.</div>
          </div>
          <button type="button" style={primaryBtn} onClick={connect} disabled={connecting}>
            {connecting ? 'Connecting…' : 'Connect Slack'}
          </button>
        </div>
      )}

      {state === 'revoked' && (
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Slack disconnected</div>
            <div className="settings-row-desc">The connection to Slack was revoked or the app was removed.</div>
          </div>
          <button type="button" style={primaryBtn} onClick={connect} disabled={connecting}>
            {connecting ? 'Connecting…' : 'Reconnect'}
          </button>
        </div>
      )}

      {(state === 'connected' || state === 'connected_no_feed') && (
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Connected</div>
            <div className="settings-row-desc">
              {status && status.team_name ? `Connected to ${status.team_name}` : 'Connected to Slack'}
            </div>
          </div>
        </div>
      )}

      {state === 'connected_no_feed' && (
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-desc">
              Feed channel: not set — run <code>/plate setup</code> in Slack
            </div>
          </div>
        </div>
      )}

      {connectErr && (
        <div style={{ color: '#ef4444', fontSize: 12, marginTop: 6 }}>{connectErr}</div>
      )}

      {showPeople && (
        <div style={{ marginTop: 14 }}>
          <div className="settings-section-title" style={{ fontSize: 12 }}>Slack people</div>
          {identitiesLoading && (
            <div className="settings-row-desc" style={{ padding: '6px 0' }}>Loading…</div>
          )}
          {!identitiesLoading && identities.length === 0 && (
            <div className="settings-row-desc" style={{ padding: '6px 0' }}>
              No one has talked to the bot yet.
            </div>
          )}
          {!identitiesLoading && identities.map(identity => (
            <div className="settings-row" key={identity.slack_user_id}>
              <div className="settings-row-info">
                <div className="settings-row-label">{identity.display_name || identity.slack_user_id}</div>
                <div className="settings-row-desc">
                  {roleLabel(identity.role)} · last check {formatLastCheck(identity.last_seen_at)}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <button
                  type="button"
                  style={rowBtn}
                  disabled={roleBusyId === identity.slack_user_id}
                  onClick={() => toggleRole(identity)}
                >
                  {roleBusyId === identity.slack_user_id
                    ? '…'
                    : (identity.role === 'manager' ? 'Make truck' : 'Make office')}
                </button>
                <button
                  type="button"
                  style={{ ...rowBtn, color: '#ef4444', borderColor: 'rgba(239,68,68,.3)' }}
                  onClick={() => setRemoveTarget(identity)}
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {removeTarget && (
        <ConfirmActionModal
          actionLabel="Remove from Slack people"
          description={(
            <>Removes <strong style={{ color: 'var(--text-primary)' }}>{removeTarget.display_name || removeTarget.slack_user_id}</strong> from Slack people. They'll see a prompt to be added back in LotLogic next time they message the bot.</>
          )}
          confirmLabel="Remove"
          confirmColor="#ef4444"
          submitting={removing}
          onConfirm={confirmRemove}
          onCancel={() => { if (!removing) setRemoveTarget(null); }}
        />
      )}
    </div>
  );
}
