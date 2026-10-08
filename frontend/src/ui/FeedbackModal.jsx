import React, { useState, useRef } from 'react';
import { apiFetch } from '../lib/api.js';
import { useToast } from './Toast.jsx';
import { useFocusTrap, useUid } from './focusTrap.js';

// ── Report a bug / Request a feature modal ───────────────────
// Available to leasing (owner) and N Style (partner) from any property view.
// Posts to the scoped backend intake; stored only (no email). Kind toggle +
// free-text body. Reuses the focus-trap + overlay pattern from the other modals.
//
// `kind` and `prefill` (spec §5.6) let a caller open this straight onto the
// Feature tab with the body already written — `UpsellPanel`'s "Ask
// LotLogic" button is `kind="feature"` with
// "<Property> is interested in <feature>." pre-filled. Both are optional and
// default to today's blank Bug tab, so every other call site is unchanged.
export function FeedbackModal({ propertyId, onClose, kind: initialKind = 'bug', prefill = '' }) {
  const { addToast } = useToast();
  const [kind, setKind] = useState(initialKind);
  const [body, setBody] = useState(prefill);
  const [submitting, setSubmitting] = useState(false);
  const dialogRef = useRef(null);
  const titleId = useUid('fb-title');
  const trimmed = body.trim();
  const disabled = submitting || trimmed.length < 1;
  const handleClose = submitting ? null : onClose;
  useFocusTrap(dialogRef, true, handleClose);

  const submit = async () => {
    setSubmitting(true);
    try {
      await apiFetch('/apartment/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ property_id: propertyId, kind, body: trimmed }),
      });
      addToast(kind === 'bug' ? 'Bug report sent. Thank you!' : 'Feature request sent. Thank you!', 'success');
      onClose();
    } catch (e) {
      addToast(e.message || 'Could not send. Please try again.', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const tab = (val, label) => (
    <button
      type="button"
      onClick={() => setKind(val)}
      style={{
        flex: 1, fontSize: 12, fontWeight: 700, padding: '7px', borderRadius: 6,
        // Literal `#FBBF24`, not `var(--accent)` — spec §5's layout rules:
        // "amber buttons use #1A1206 ink" (white here was 1.66:1, caught by
        // the axe scan Task 26 added once `UpsellPanel`'s "Ask LotLogic"
        // made the Feature tab open active by default). `var(--accent)`
        // itself is only #FBBF24 in dark theme — in light theme it's
        // #B85309, recalibrated for text/icon use, where #1A1206 ink is
        // 3.77:1 (fails 4.5:1). The literal amber is the same pairing
        // `AccountPage.jsx`'s Save button and `dashboard.html`'s
        // `.login-btn` use, which holds in both themes.
        border: '1px solid ' + (kind === val ? '#FBBF24' : 'var(--border)'),
        background: kind === val ? '#FBBF24' : 'var(--bg-inset)',
        color: kind === val ? '#1A1206' : 'var(--text-primary)',
        cursor: 'pointer',
      }}
    >{label}</button>
  );

  return (
    <div
      onClick={submitting ? undefined : onClose}
      style={{position:'fixed',inset:0,background:'rgba(0,0,0,.55)',zIndex:1000,display:'flex',alignItems:'center',justifyContent:'center',padding:16}}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
        style={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:12,padding:16,maxWidth:440,width:'100%',outline:'none'}}
      >
        <div id={titleId} style={{fontSize:16,fontWeight:800,color:'var(--text-primary)',marginBottom:10}}>Report a bug / Request a feature</div>
        <div style={{display:'flex',gap:8,marginBottom:10}}>
          {tab('bug', 'Bug')}
          {tab('feature', 'Feature')}
        </div>
        <textarea
          value={body}
          onChange={e => setBody(e.target.value)}
          rows={4}
          maxLength={4000}
          placeholder={kind === 'bug' ? 'What went wrong? Steps to reproduce help.' : 'What would you like to see?'}
          autoFocus
          style={{width:'100%',padding:'8px 10px',background:'var(--bg-inset)',border:'1px solid var(--border)',borderRadius:8,color:'var(--text-primary)',fontSize:13,fontFamily:'inherit',resize:'vertical',boxSizing:'border-box'}}
        />
        <div style={{display:'flex',justifyContent:'flex-end',gap:8,marginTop:10}}>
          <button onClick={onClose} disabled={submitting} className="pd-share-btn">Cancel</button>
          <button
            onClick={submit}
            disabled={disabled}
            style={{
              // Same literal-amber fix as the tab buttons above — not
              // `var(--accent)`, which is #B85309 in light theme (3.77:1
              // with #1A1206, fails 4.5:1).
              background:'#FBBF24', color:'#1A1206', border:'1px solid #FBBF24',
              borderRadius:6, padding:'4px 12px', fontSize:12, fontWeight:700,
              cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1,
            }}
          >{submitting ? '…' : 'Submit'}</button>
        </div>
      </div>
    </div>
  );
}
