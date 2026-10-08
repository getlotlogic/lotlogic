import React, { useState, useCallback, useEffect } from 'react';
import { requestsApi } from '../../lib/requestsApi.js';
import { useToast } from '../../ui/Toast.jsx';
import { VerifyEmailSheet } from './VerifyEmailSheet.jsx';
import { secondsUntilResend, cooldownRetryAfter, sentAtForRetryAfter } from '../../lib/verifyState.js';

// ── The You're-in card (spec §3.4 step 5) ────────────────────
//
// Shown once, above the Requests section, on the new-property signup landing
// (`/app?property=…&section=requests&firstrun=1`). Never on the join path —
// that account has no active membership and gets §3.7 (b)'s
// PendingMembershipPage instead, which App.jsx renders before this page is
// reachable at all.
//
// Copy is verbatim §3.4:
//   **You're in.** <Property> is live. <Partner> will confirm it's one of
//   their properties — usually the same day — and your requests reach them
//   from now on.
//   [Put a plate on hold] [Add a teammate]
//   We sent a 6-digit code to <email> — Enter code · Resend · Change email
//
// [Put a plate on hold] scrolls to the composer rather than navigating: the
// composer is already on this screen (it is the first thing under this card)
// and iOS Safari ignores programmatic focus without a gesture, so a tap that
// scrolls `#req-plate` into view and then focuses it is the only version
// that actually lands the keyboard. Before Task 22's RequestsSection merges
// there is no `#req-plate` in the DOM and the button is a no-op scroll to
// the top of the section — never a dead control that errors.
//
// [Add a teammate] goes to Account → Team. A full navigation (not a tab
// switch) because this card is three components deep inside the Lots tab
// and has no handle on App.jsx's `setTab`; `/app?tab=account` is the
// documented deep link for exactly this (`lib/deepLink.js`), and the
// dashboard bundle is already warm in cache by the time anyone taps it.

export function FirstRunCard({ property, partnerName, user, onDismiss }) {
  const { addToast } = useToast();
  const email = user?.email || '';
  // Spec §3.5: only a self-serve account with an unconfirmed mailbox is
  // asked for a code. Everyone else (admin/seed/invite) is verified by
  // construction and the code line must not render at all.
  const needsCode = user?.signup_source === 'self_serve' && !user?.email_verified;
  const [sentAt, setSentAt] = useState(user?.email_verify_sent_at || null);
  const [sheet, setSheet] = useState(null); // null | 'code' | 'changeEmail'
  const [currentEmail, setCurrentEmail] = useState(email);
  const resendDisabled = secondsUntilResend(sentAt) > 0;

  // Spec §3.4 step 5: the signup landing opens "with the composer at the top
  // of the viewport and the plate field as the first tap target" — the layout,
  // not `autofocus`, is what reaches a thumb on iOS. This card, the header,
  // the confirm-your-email banner and the chip row together are taller than
  // a phone's viewport, so without a scroll the plate field lands below the
  // fold. Once, on mount: bring `#req-plate` into view (RequestsSection mounts
  // a render or two after this card, once the section chip resolves — hence
  // the short poll). No focus here; [Put a plate on hold] still does that.
  useEffect(() => {
    let tries = 0;
    const t = setInterval(() => {
      const field = document.getElementById('req-plate');
      if (field || ++tries > 40) {
        clearInterval(t);
        if (field) { try { field.scrollIntoView({ block: 'center' }); } catch { /* old engines */ } }
      }
    }, 50);
    return () => clearInterval(t);
  }, []);

  const putOnHold = useCallback(() => {
    const field = document.getElementById('req-plate');
    const target = field || document.querySelector('.req-card');
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Progressive enhancement only — iOS Safari will ignore this, which is
    // why the scroll above is what the spec relies on.
    if (field) { try { field.focus({ preventScroll: true }); } catch { /* ignore */ } }
  }, []);

  const resend = useCallback(() => {
    requestsApi.resendVerification({}).then(() => {
      setSentAt(new Date().toISOString());
      addToast('Sent. Check your email — and the spam folder.', 'success');
    }).catch((e) => {
      const retryAfter = cooldownRetryAfter(e);
      if (retryAfter !== null) {
        setSentAt(sentAtForRetryAfter(retryAfter));
        addToast(`Already sent — try again in ${retryAfter}s.`, 'error');
        return;
      }
      addToast("Can't reach LotLogic — try again.", 'error');
    });
  }, [addToast]);

  return (
    <div className="firstrun-card" role="region" aria-label="You're in">
      <div className="firstrun-head">
        <strong>You&apos;re in.</strong>{' '}
        {property?.name ? `${property.name} is live.` : 'Your property is live.'}{' '}
        {partnerName || 'Your tow company'} will confirm it&apos;s one of their properties — usually the
        same day — and your requests reach them from now on.
      </div>
      <div className="firstrun-actions">
        <button type="button" className="firstrun-btn" onClick={putOnHold}>Put a plate on hold</button>
        <button type="button" className="firstrun-btn secondary"
          onClick={() => window.location.assign('/app?tab=account')}>Add a teammate</button>
      </div>
      {needsCode && (
        <div className="firstrun-code">
          We sent a 6-digit code to {currentEmail}
          {' — '}
          <button type="button" className="firstrun-link" onClick={() => setSheet('code')}>Enter code</button>
          {' · '}
          <button type="button" className="firstrun-link" onClick={resend} disabled={resendDisabled}>Resend</button>
          {' · '}
          <button type="button" className="firstrun-link" onClick={() => setSheet('changeEmail')}>Change email</button>
        </div>
      )}
      {onDismiss && (
        <button type="button" className="firstrun-dismiss" onClick={onDismiss} aria-label="Dismiss this card">
          <span aria-hidden="true">✕</span>
        </button>
      )}
      {sheet && (
        <VerifyEmailSheet
          open
          email={currentEmail}
          sentAt={sentAt}
          mode={sheet}
          onClose={() => setSheet(null)}
          onSuccess={() => { setSheet(null); addToast('Email confirmed', 'success'); onDismiss && onDismiss(); }}
          onEmailChanged={(next) => { setCurrentEmail(next); setSentAt(new Date().toISOString()); }}
        />
      )}
    </div>
  );
}

export default FirstRunCard;
