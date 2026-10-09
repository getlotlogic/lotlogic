import React from 'react';

// ── VerifyBanner — banner + wall variants (spec §3.5) ────────
//
// Mounted above the page content whenever `verifyState(owner)` is not
// 'verified'. 'unverified' renders the one-line banner; 'walled' (day 7)
// renders the wall, whose copy and layout differ but whose three actions —
// Enter code, Resend, Change email — are the same. Enter code and Change
// email both open VerifyEmailSheet (every "[Enter code]" in the spec opens
// it); Resend posts directly, no sheet needed for a bare resend.
//
// Props:
//   variant        - 'banner' | 'wall'
//   email          - the address shown
//   onEnterCode()  - opens the sheet on the code-entry view
//   onChangeEmail()- opens the sheet on the change-email view
//   onResend()     - POSTs /auth/resend-verification directly
//   resendDisabled - true while a resend cooldown is active
export function VerifyBanner({ variant, email, onEnterCode, onChangeEmail, onResend, resendDisabled }) {
  const isWall = variant === 'wall';
  return (
    <div className={isWall ? 'verify-wall' : 'verify-banner'} role={isWall ? 'alert' : 'status'}>
      <div className="verify-banner-copy">
        {isWall ? (
          <>
            <div className="verify-wall-title">Confirm your email to keep placing requests.</div>
            <div className="verify-wall-line">Your current holds still work.</div>
            <div className="verify-wall-line">We sent a 6-digit code to {email}.</div>
          </>
        ) : (
          <div className="verify-banner-line">Confirm your email — we sent a 6-digit code to {email}.</div>
        )}
      </div>
      <div className="verify-banner-actions">
        <button type="button" className="verify-banner-btn" onClick={onEnterCode}>Enter code</button>
        <button type="button" className="verify-banner-btn" onClick={onResend} disabled={resendDisabled}>Resend</button>
        <button type="button" className="verify-banner-btn" onClick={onChangeEmail}>Change email</button>
      </div>
    </div>
  );
}

export default VerifyBanner;
