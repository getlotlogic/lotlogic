import React, { useState } from 'react';
import { PASSWORD_MAX } from '../lib/signupValidation.js';

// ── Create a password (spec §3.2 field 7) ────────────────────
//
// `type=password autocomplete=new-password`, a Show/Hide toggle, **no
// confirm field**, paste allowed ("Don't double up your inputs" —
// https://web.dev/articles/sign-up-form-best-practices). Nothing here
// blocks paste or `onCopy`: a password manager has to be able to fill it.
//
// Show/Hide is a real button with `aria-pressed`, inside the field's trailing
// edge, >= 44 px wide. The label says what the button will do when tapped
// ("Show" while hidden), which is the convention the pattern libraries use.
//
// 128 is enforced by `maxLength` rather than an invented error string: the
// spec gives copy for the 12-char floor and for a breached password, and
// none for "too long", so the field simply cannot exceed it.

export function PasswordField({ id, value, onChange, onBlur, error, errorId, helpId }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="signup-pw-wrap">
      <input
        id={id}
        className="field-input signup-pw-input"
        type={shown ? 'text' : 'password'}
        autoComplete="new-password"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        maxLength={PASSWORD_MAX}
        value={value}
        onChange={e => onChange(e.target.value)}
        onBlur={onBlur}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={[error ? errorId : null, helpId].filter(Boolean).join(' ') || undefined}
      />
      <button
        type="button"
        className="signup-pw-toggle"
        aria-pressed={shown}
        aria-controls={id}
        onClick={() => setShown(s => !s)}
      >
        {shown ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}
