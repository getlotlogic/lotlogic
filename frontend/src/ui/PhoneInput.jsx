import React from 'react';
import { formatUSPhone, nationalDigits } from '../lib/signupValidation.js';

// ── Mobile number (spec §3.2 field 6) ───────────────────────
//
// `type=tel autocomplete=tel inputmode=tel`, formatted as you type:
// `(704) 555-0123`. The spec names libphonenumber-js's `AsYouType('US')`;
// this uses the dependency-free US formatter in `lib/signupValidation.js`
// instead — see the DEVIATION note there and in this task's report. The
// submitted value is unchanged: E.164 `+1XXXXXXXXXX`, produced by
// `toE164US` at the call site.
//
// `value` is the digit string (the parent keeps `phone` as digits and calls
// `toE164US` on submit); the field DISPLAYS `formatUSPhone(value)`. That is
// safe as a controlled re-format with no caret bookkeeping because
// `formatUSPhone` never ends in a punctuation character — '704', '(704) 5',
// '(704) 555-0' all end in a digit — so a backspace always removes a digit
// and always makes progress. A paste, an autofill or a `fill()` of
// '7045550123' is handled by the same path: the digits are extracted and
// re-formatted.

export function PhoneInput({ id, value, onChange, onBlur, error, errorId, helpId, autoFocus }) {
  function handleChange(e) {
    onChange(nationalDigits(e.target.value));
  }
  return (
    <input
      id={id}
      className="field-input"
      type="tel"
      inputMode="tel"
      autoComplete="tel"
      autoCorrect="off"
      spellCheck={false}
      placeholder="(704) 555-0123"
      value={formatUSPhone(value)}
      onChange={handleChange}
      onBlur={onBlur}
      autoFocus={autoFocus}
      aria-invalid={error ? 'true' : undefined}
      aria-describedby={[error ? errorId : null, helpId].filter(Boolean).join(' ') || undefined}
    />
  );
}
