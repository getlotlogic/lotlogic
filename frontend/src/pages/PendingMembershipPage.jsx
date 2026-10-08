import React, { useState } from 'react';
import { requestsApi } from '../lib/requestsApi.js';
import { pendingProperties } from '../lib/membership.js';

// ── PendingMembershipPage (spec §3.7 (b)) ────────────────────
//
// Rendered by App.jsx instead of Lots whenever the account has no `active`
// membership and >= 1 `pending` one — the "That's mine — ask to join"
// outcome. Nav is Account only (App.jsx's job, not this page's).
export function PendingMembershipPage({ me, user, onLogout, onAddProperty }) {
  const pending = pendingProperties(me);
  const property = pending[0] || null;
  const email = user?.email || me?.email || '';

  const [resendState, setResendState] = useState('idle'); // 'idle' | 'sending' | 'sent' | 'cooldown'
  const [cooldownHours, setCooldownHours] = useState(null);
  const [resendError, setResendError] = useState('');

  async function resend() {
    if (!property?.id || resendState === 'sending' || resendState === 'sent') return;
    setResendState('sending');
    setResendError('');
    try {
      await requestsApi.resendJoinRequest(property.id);
      setResendState('sent');
    } catch (e) {
      if (e.code === 'resend_cooldown') {
        const hours = Math.ceil((e.body?.retry_after || 0) / 3600);
        setCooldownHours(hours);
        setResendState('cooldown');
      } else {
        setResendState('idle');
        setResendError(e.message || 'Could not resend — try again.');
      }
    }
  }

  const resendLabel = resendState === 'sending' ? 'Sending…'
    : resendState === 'sent' ? 'Sent again'
    : resendState === 'cooldown' ? `Already sent today — try again in ${cooldownHours} h`
    : 'Resend request';
  const resendDisabled = resendState === 'sending' || resendState === 'sent' || resendState === 'cooldown';

  return (
    <div className="page-enter" style={{ textAlign: 'center', padding: '40px 16px' }}>
      <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--text-primary)' }}>Request sent.</div>
      <div style={{ fontSize: 14, color: 'var(--text-secondary)', marginTop: 10, lineHeight: 1.6 }}>
        We've asked {property?.name || 'the property'} and N Style to add you.
      </div>
      <div style={{ fontSize: 14, color: 'var(--text-secondary)', marginTop: 4, lineHeight: 1.6 }}>
        We'll email {email || 'you'} when they do — usually the same day.
      </div>

      {resendError && <div style={{ color: '#f87171', fontSize: 12, marginTop: 10 }}>{resendError}</div>}

      <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 20, flexWrap: 'wrap' }}>
        <button
          onClick={resend}
          disabled={resendDisabled}
          style={{
            background: resendDisabled ? 'rgba(59,130,246,.15)' : 'var(--accent)',
            // Dark theme's --accent is a light gold (#FBBF24) — white text on
            // it fails contrast (axe: 1.64:1). `#1A1206` is the dark-ink
            // pairing AccountPage's PartnerFeeEditor Save button already
            // uses against the same token.
            color: resendDisabled ? 'var(--text-faint)' : '#1A1206',
            border: 'none', borderRadius: 8, padding: '10px 16px', fontSize: 13, fontWeight: 700,
            cursor: resendDisabled ? 'default' : 'pointer', fontFamily: 'inherit',
          }}
        >{resendLabel}</button>
        <button
          onClick={onLogout}
          style={{ background: 'rgba(239,68,68,.15)', color: '#f87171', border: '1px solid rgba(239,68,68,.3)', borderRadius: 8, padding: '10px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}
        >Sign out</button>
      </div>

      {onAddProperty && (
        <div style={{ marginTop: 24, fontSize: 13, color: 'var(--text-muted)' }}>
          Not the right property?{' '}
          <button onClick={onAddProperty} style={{ background: 'transparent', border: 'none', color: 'var(--accent)', fontWeight: 700, cursor: 'pointer', fontSize: 13, padding: 0, fontFamily: 'inherit' }}>
            Add a different property
          </button>
        </div>
      )}
    </div>
  );
}
