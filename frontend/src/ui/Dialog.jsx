import React, { useState, useEffect, useCallback, useRef, useMemo, memo } from 'react';
import { useFocusTrap, useUid } from './focusTrap.js';

// ── Confirm dialog ────────────────────────────────────────────
export function ConfirmDialog({ title, body, confirmLabel, confirmColor, onConfirm, onCancel }) {
  return (
    <div className="confirm-overlay" onClick={onCancel}>
      <div className="confirm-box" onClick={e => e.stopPropagation()}>
        <div className="confirm-title">{title}</div>
        <div className="confirm-body">{body}</div>
        <div className="confirm-btns">
          <button className="confirm-cancel" onClick={onCancel}>Cancel</button>
          <button className="confirm-ok" style={{background: confirmColor || '#3b82f6'}} onClick={onConfirm}>{confirmLabel || 'Confirm'}</button>
        </div>
      </div>
    </div>
  );
}

// ── Confirm action modal (inline, replaces window.prompt) ──────
// Reusable modal for plate-scoped operator actions: shows the plate, the
// action label, an optional reason textarea, and Confirm / Cancel buttons.
// Used by Confirmation review (force-bill / mark-no-tow / pause-billing /
// resume-billing) AND the Truck Parking Log cancel-pass flow.
//
// Props:
//   plate             - string plate shown prominently for confirmation
//   actionLabel       - verb displayed in the title (e.g. "Force bill")
//   description       - optional node under the title (falls back to generic)
//   confirmLabel      - button text (defaults to actionLabel)
//   confirmColor      - hex / token for the confirm background (red for
//                       destructive, accent for primary)
//   requireReason     - when true, Confirm stays disabled until the reason has
//                       at least 2 non-whitespace chars
//   reasonPlaceholder - placeholder text for the textarea
//   submitting        - disables buttons while a POST is in flight
//   onConfirm(reason) - called with trimmed reason (may be empty string)
//   onCancel()
export function ConfirmActionModal({
  plate,
  actionLabel,
  description,
  confirmLabel,
  confirmColor,
  requireReason = false,
  reasonPlaceholder = 'Reason (optional)',
  submitting = false,
  onConfirm,
  onCancel,
}) {
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();
  const disabled = submitting || (requireReason && trimmed.length < 2);
  const dialogRef = useRef(null);
  const titleId = useUid('modal-title');
  const descId = useUid('modal-desc');
  // ESC/overlay-click close is suppressed while submitting, matching the
  // existing pointer-guard on the overlay.
  const handleClose = submitting ? null : onCancel;
  useFocusTrap(dialogRef, true, handleClose);
  return (
    <div
      onClick={submitting ? undefined : onCancel}
      style={{position:'fixed',inset:0,background:'rgba(0,0,0,.55)',zIndex:1000,display:'flex',alignItems:'center',justifyContent:'center',padding:16}}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
        style={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:12,padding:16,maxWidth:440,width:'100%',outline:'none'}}
      >
        <div id={titleId} style={{fontSize:16,fontWeight:800,color:'var(--text-primary)',marginBottom:4}}>{actionLabel}?</div>
        <div id={descId} style={{fontSize:12,color:'var(--text-muted)',marginBottom:10}}>
          {description || <>Applies to plate <strong style={{color:'var(--text-primary)'}}>{plate || '—'}</strong>.</>}
        </div>
        <textarea
          value={reason}
          onChange={e => setReason(e.target.value)}
          rows={2}
          placeholder={reasonPlaceholder}
          autoFocus
          style={{width:'100%',padding:'8px 10px',background:'var(--bg-inset)',border:'1px solid var(--border)',borderRadius:8,color:'var(--text-primary)',fontSize:13,fontFamily:'inherit',resize:'vertical',boxSizing:'border-box'}}
        />
        <div style={{display:'flex',justifyContent:'flex-end',gap:8,marginTop:10}}>
          <button onClick={onCancel} disabled={submitting} className="pd-share-btn">Cancel</button>
          <button
            onClick={() => onConfirm(trimmed)}
            disabled={disabled}
            style={{
              background: confirmColor || 'var(--accent)',
              color: '#fff',
              border: '1px solid ' + (confirmColor || 'var(--accent)'),
              borderRadius: 6,
              padding: '4px 12px',
              fontSize: 12,
              fontWeight: 700,
              cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: disabled ? 0.6 : 1,
            }}
          >{submitting ? '…' : (confirmLabel || actionLabel)}</button>
        </div>
      </div>
    </div>
  );
}
