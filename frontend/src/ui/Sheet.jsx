import React, { useRef } from 'react';
import { useFocusTrap, useUid } from './focusTrap.js';

// ── Bottom sheet ─────────────────────────────────────────────
// The portal's sheet shell (spec §5: "every sheet copies FeedbackModal's focus
// trap"). Same trap, same ESC handling, same focus restore — the difference is
// that it rises from the bottom edge, which is where a thumb is on a phone.
//
// `dismissible={false}` is the §5.9 "wall" variant: no ✕, no backdrop tap, no
// ESC. The caller is then responsible for whatever way out it does offer.
//
// Carries no copy of its own beyond the close button's accessible name, so a
// sheet's words all live in the component that opens it.
export function Sheet({ title, onClose, dismissible = true, children }) {
  const panelRef = useRef(null);
  const titleId = useUid('sheet-title');
  const close = dismissible ? onClose : null;
  useFocusTrap(panelRef, true, close);

  return (
    <div
      className="req-sheet-backdrop"
      onClick={dismissible ? onClose : undefined}
    >
      <div
        ref={panelRef}
        className="req-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
      >
        <div className="req-sheet-head">
          <div id={titleId} className="req-sheet-title">{title}</div>
          {dismissible && (
            <button type="button" className="req-sheet-close" onClick={onClose} aria-label="Close">✕</button>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}
