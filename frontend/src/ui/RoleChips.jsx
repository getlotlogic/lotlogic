import React, { useRef } from 'react';
import { ROLES } from '../lib/signupValidation.js';

// ── Your role — a chip row, not a <select> (spec §3.2 field 4) ─
//
// Six chips: Property manager · Assistant manager · Leasing · Maintenance ·
// Owner / regional · Other (→ a text field, 2–60 chars). 2-column grid below
// 400 px (3 rows), 3 columns at >= 400 px (2 rows) — the breakpoint is a
// media query on `.signup-chip-grid` in dashboard.html, because a viewport
// breakpoint cannot be expressed in an inline style.
//
// The selected chip is accent fill + `#1A1206` ink + a ✓ glyph: never colour
// alone (https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html).
// Chips are >= 44 px tall (WCAG 2.5.8 / Apple 44 pt).
//
// Semantics: a radio group, not a listbox and not six toggle buttons — one
// of a known set, exactly one answer. `role="radiogroup"` + `role="radio"` +
// `aria-checked`, with the WAI-ARIA radio-group keyboard pattern implemented
// here (https://www.w3.org/WAI/ARIA/apg/patterns/radio/): one tab stop (the
// checked chip, or the first when none is), roving tabindex, and the arrow
// keys move AND select, wrapping at both ends.

export function RoleChips({ value, onChange, otherText, onOtherText, onOtherBlur, error, labelId, errorId }) {
  const showOther = value === 'other';
  const refs = useRef([]);
  const current = ROLES.findIndex(r => r.id === value);
  const tabStop = current === -1 ? 0 : current;

  function onKeyDown(e, i) {
    let next = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % ROLES.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + ROLES.length) % ROLES.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = ROLES.length - 1;
    if (next == null) return;
    e.preventDefault();
    onChange(ROLES[next].id);
    refs.current[next]?.focus();
  }
  return (
    <div>
      <div className="signup-chip-grid" role="radiogroup" aria-labelledby={labelId}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={error ? errorId : undefined}>
        {ROLES.map((r, i) => {
          const selected = value === r.id;
          return (
            <button
              key={r.id}
              ref={el => { refs.current[i] = el; }}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={i === tabStop ? 0 : -1}
              onKeyDown={e => onKeyDown(e, i)}
              className={`signup-chip${selected ? ' selected' : ''}`}
              onClick={() => onChange(r.id)}
            >
              {selected && <span aria-hidden="true">✓ </span>}{r.label}
            </button>
          );
        })}
      </div>
      {showOther && (
        <>
          <label className="field-label" htmlFor="signup-role-other" style={{ marginTop: 10 }}>
            What is your role?
          </label>
          <input
            id="signup-role-other"
            className="field-input"
            type="text"
            value={otherText}
            onChange={e => onOtherText(e.target.value)}
            onBlur={onOtherBlur}
            maxLength={60}
            autoComplete="organization-title"
          />
        </>
      )}
    </div>
  );
}
