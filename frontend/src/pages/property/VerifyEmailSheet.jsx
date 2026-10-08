import React, { useState, useRef, useEffect, useCallback } from 'react';
import { requestsApi } from '../../lib/requestsApi.js';
import { onlyDigits, secondsUntilResend, RESEND_COOLDOWN_SECONDS } from '../../lib/verifyState.js';
import { useFocusTrap, useUid } from '../../ui/focusTrap.js';

// ── VerifyEmailSheet — the 6-digit code (spec §5.9) ──────────
//
// Opened by every "[Enter code]" in the document (the You're-in card, the
// banner, the wall, the tow/photo inline message, a pending-property hold,
// and `/app?verify=1` from the code email). Sheet from the bottom,
// focus-trapped like FeedbackModal, dismissible except when opened by the
// wall — the wall-opened variant has no ✕ and a Sign out link instead.
//
// One field: inputmode=numeric autocomplete=one-time-code maxlength=6, paste
// accepted (digits only kept — the input's `value` already carries pasted
// text by the time onChange fires, so `onlyDigits` is the only paste
// handling needed), submits automatically at 6 digits. "Resend in 42 s"
// counts down from `sentAt` (lot_owners.email_verify_sent_at); "Resend"
// becomes a tappable link at 0 s.
//
// Props:
//   open        - render/mount gate (sheet renders nothing while closed)
//   email       - the address shown ("We sent it to …")
//   sentAt      - email_verify_sent_at, ISO string or null, for the countdown
//   mode        - 'code' (default) | 'changeEmail' — which sub-view opens first
//   fromWall    - true when the wall opened this sheet: no ✕, Sign out instead
//   onClose()   - dismiss (ignored when fromWall)
//   onSuccess(verifyEmailResponse) - 200 from POST /auth/verify-email; the
//     caller unmounts the banner/wall, toasts "Email confirmed", and fires
//     any pending resume() (Task 22's composer)
//   onSignOut() - the wall variant's Sign out link
export function VerifyEmailSheet({
  open,
  email,
  sentAt,
  mode = 'code',
  fromWall = false,
  onClose,
  onSuccess,
  onSignOut,
}) {
  const [code, setCode] = useState('');
  // idle | submitting | wrong | expired | exhausted | offline
  const [status, setStatus] = useState('idle');
  const [triesLeft, setTriesLeft] = useState(null);
  // idle | sending | resent | error
  const [resendState, setResendState] = useState('idle');
  const [changingEmail, setChangingEmail] = useState(mode === 'changeEmail');
  const [newEmail, setNewEmail] = useState('');
  const [changeEmailSubmitting, setChangeEmailSubmitting] = useState(false);
  const [currentEmail, setCurrentEmail] = useState(email);
  const [secondsLeft, setSecondsLeft] = useState(() => secondsUntilResend(sentAt));

  const dialogRef = useRef(null);
  const inputRef = useRef(null);
  const titleId = useUid('verify-title');
  const newEmailId = `${titleId}-newemail`;

  // Reset every transient bit whenever the sheet (re)opens, so a sheet
  // reused across triggers (banner vs. wall vs. ?verify=1) never carries a
  // stale code, error or change-email draft from the last time it was open.
  useEffect(() => {
    if (!open) return;
    setCode('');
    setStatus('idle');
    setTriesLeft(null);
    setResendState('idle');
    setChangingEmail(mode === 'changeEmail');
    setNewEmail('');
    setCurrentEmail(email);
    setSecondsLeft(secondsUntilResend(sentAt));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // One-second countdown ticking down to 0; the effect itself only depends on
  // `open` so it doesn't restart and double-count every time secondsLeft
  // changes.
  useEffect(() => {
    if (!open) return undefined;
    const id = setInterval(() => setSecondsLeft((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(id);
  }, [open]);

  // ESC closes unless this is the wall-opened, no-dismiss variant.
  useFocusTrap(dialogRef, open, fromWall ? null : onClose);

  const submit = useCallback(async () => {
    if (code.length !== 6 || status === 'submitting') return;
    setStatus('submitting');
    try {
      const resp = await requestsApi.verifyEmail({ code });
      setStatus('idle');
      setCode('');
      onSuccess?.(resp);
    } catch (e) {
      // A genuine fetch failure (offline, DNS, CORS) never reaches
      // errorFromResponse, so it has no numeric `.status` — that's the one
      // reliable signal to tell it apart from a 400 the server answered.
      if (typeof e?.status !== 'number') {
        setStatus('offline');
        return;
      }
      if (e.code === 'code_mismatch') {
        setStatus('wrong');
        setTriesLeft(typeof e.body?.tries_left === 'number' ? e.body.tries_left : null);
        setCode('');
        inputRef.current?.focus();
        return;
      }
      if (e.code === 'code_expired') {
        setStatus('expired');
        setCode('');
        return;
      }
      if (e.code === 'code_exhausted') {
        setStatus('exhausted');
        setCode('');
        return;
      }
      setStatus('offline');
    }
  }, [code, status, onSuccess]);

  // Auto-submit at 6 digits.
  useEffect(() => {
    if (open && !changingEmail && code.length === 6) submit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  function handleCodeChange(e) {
    const digits = onlyDigits(e.target.value);
    setCode(digits);
    if (status !== 'idle' && status !== 'submitting') setStatus('idle');
  }

  // The field's native `maxlength=6` (spec §5.9) truncates a paste BEFORE
  // onChange ever sees it — pasting "482-190" (7 characters once the dash is
  // counted) would land as "482-19", and onlyDigits() on that gives "48219",
  // one short. Intercepting the paste and writing the filtered digits
  // ourselves is the only way "digits only kept" and "maxlength=6" are both
  // true at once. A one-time-code field's paste replaces the whole value —
  // there's no reasonable "insert at cursor" for a 6-digit code.
  function handleCodePaste(e) {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData)?.getData('text') || '';
    const digits = onlyDigits(text);
    setCode(digits);
    if (status !== 'idle' && status !== 'submitting') setStatus('idle');
  }

  const resend = useCallback(async () => {
    if (secondsLeft > 0 || resendState === 'sending') return;
    setResendState('sending');
    try {
      await requestsApi.resendVerification({});
      setResendState('resent');
      setSecondsLeft(RESEND_COOLDOWN_SECONDS);
    } catch (e) {
      if (e?.code === 'resend_cooldown') {
        setSecondsLeft(typeof e.body?.retry_after === 'number' ? e.body.retry_after : RESEND_COOLDOWN_SECONDS);
        setResendState('idle');
        return;
      }
      setResendState('error');
    }
  }, [secondsLeft, resendState]);

  const submitChangeEmail = useCallback(async () => {
    const trimmed = newEmail.trim();
    if (!trimmed || changeEmailSubmitting) return;
    setChangeEmailSubmitting(true);
    try {
      await requestsApi.changeEmail({ email: trimmed });
      setCurrentEmail(trimmed);
      setChangingEmail(false);
      setCode('');
      setStatus('idle');
      setResendState('resent');
      setSecondsLeft(RESEND_COOLDOWN_SECONDS);
    } catch {
      // POST /auth/change-email answers 200 always (spec §3.5) — this only
      // fires on a network failure, which the offline copy already covers.
      setStatus('offline');
    } finally {
      setChangeEmailSubmitting(false);
    }
  }, [newEmail, changeEmailSubmitting]);

  if (!open) return null;
  const canResend = secondsLeft <= 0;

  return (
    <div className="verify-sheet-overlay" onClick={fromWall ? undefined : onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="verify-sheet"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="verify-sheet-handle" aria-hidden="true" />
        <div className="verify-sheet-header">
          <div id={titleId} className="verify-sheet-title">
            {changingEmail ? 'Change email' : 'Enter the 6-digit code'}
          </div>
          {!fromWall && (
            <button type="button" className="verify-sheet-close" onClick={onClose} aria-label="Close">✕</button>
          )}
        </div>
        {!changingEmail && (
          <div className="verify-sheet-sub">We sent it to {currentEmail}</div>
        )}

        {changingEmail ? (
          <div className="verify-change-email">
            <label className="verify-change-label" htmlFor={newEmailId}>
              Where should we send the code instead?
            </label>
            <input
              id={newEmailId}
              type="email"
              autoFocus
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              className="verify-change-input"
              placeholder="name@example.com"
              autoComplete="email"
            />
            <button
              type="button"
              className="verify-confirm-btn"
              disabled={changeEmailSubmitting || !newEmail.trim()}
              onClick={submitChangeEmail}
            >
              {changeEmailSubmitting ? '…' : 'Send code'}
            </button>
            <button
              type="button"
              className="verify-link-btn verify-change-back"
              onClick={() => setChangingEmail(false)}
            >
              Back
            </button>
          </div>
        ) : (
          <>
            <input
              ref={inputRef}
              autoFocus
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={handleCodeChange}
              onPaste={handleCodePaste}
              disabled={status === 'submitting'}
              className="verify-code-input"
              aria-label="6-digit code"
            />
            <button
              type="button"
              className="verify-confirm-btn"
              disabled={code.length !== 6 || status === 'submitting'}
              onClick={submit}
            >
              {status === 'submitting' ? '…' : 'Confirm'}
            </button>

            <div className="verify-sheet-msg-slot" aria-live="polite">
              {status === 'wrong' && (
                <div className="verify-sheet-msg error">
                  That code didn't match.{triesLeft != null ? ` ${triesLeft} tries left.` : ''}
                </div>
              )}
              {status === 'expired' && (
                <div className="verify-sheet-msg error">That code expired. We sent a new one to {currentEmail}.</div>
              )}
              {status === 'exhausted' && (
                <div className="verify-sheet-msg error">Too many tries — we sent a fresh code to {currentEmail}.</div>
              )}
              {status === 'offline' && (
                <div className="verify-sheet-msg error">Can't reach LotLogic — try again.</div>
              )}
              {status === 'idle' && resendState === 'resent' && (
                <div className="verify-sheet-msg success">Sent. Check {currentEmail} — and the spam folder.</div>
              )}
            </div>

            <div className="verify-sheet-footer">
              {canResend ? (
                <button
                  type="button"
                  className="verify-link-btn"
                  onClick={resend}
                  disabled={resendState === 'sending'}
                >
                  Resend
                </button>
              ) : (
                <span className="verify-resend-countdown">Resend in {secondsLeft} s</span>
              )}
              <span aria-hidden="true" className="verify-sheet-footer-dot"> · </span>
              <button type="button" className="verify-link-btn" onClick={() => setChangingEmail(true)}>
                Change email
              </button>
            </div>
          </>
        )}

        {fromWall && (
          <button type="button" className="verify-signout-link" onClick={onSignOut}>
            Sign out
          </button>
        )}
      </div>
    </div>
  );
}

export default VerifyEmailSheet;
