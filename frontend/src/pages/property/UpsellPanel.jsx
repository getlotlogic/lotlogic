import React, { useState } from 'react';
import { FeedbackModal } from '../../ui/FeedbackModal.jsx';
import { lockedChips, upsellCopy, upsellTitle, upsellFeatureName } from '../../lib/upsell.js';

// ── Greyed upsell tabs (spec §5.6) ───────────────────────────
//
// A property with `features.passes=false` and `features.cameras=false`
// shows a chip row of `Requests · 🔒 Parking passes · 🔒 QR codes ·
// 🔒 Cameras`. The locked chips are real, keyboard-reachable buttons —
// `ALPRPropertyDetailPage.jsx` renders them muted via `var(--text-muted)`
// (already ≥ 4.5:1 on both themes) with `aria-describedby="Not included
// yet"`. Tapping one renders this panel in place of the section it would
// otherwise show: one card, a title, the spec's one-sentence pitch, and a
// single `Ask LotLogic` button that opens `FeedbackModal` pre-filled with
// the spec's exact sentence.
//
// `lockedChips` / `upsellCopy` and friends are plain JS in `lib/upsell.js`
// (no JSX, so `frontend/scripts/upsell.test.mjs` can import them under
// `node --test` with no build step) and re-exported here so every other
// caller — `ALPRPropertyDetailPage.jsx` included — has one import path.
export { lockedChips, upsellCopy, upsellTitle, upsellFeatureName };

/**
 * @param {object} props
 * @param {'passes'|'qr'|'cameras'} props.feature
 * @param {string} props.propertyName
 * @param {string} [props.propertyId]
 */
export function UpsellPanel({ feature, propertyName, propertyId }) {
  const [asking, setAsking] = useState(false);
  const title = upsellTitle(feature);
  const sentence = upsellCopy(feature);
  const prefill = `${propertyName} is interested in ${upsellFeatureName(feature)}.`;

  return (
    <div
      data-testid="upsell-panel"
      style={{
        background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12,
        padding: 20, textAlign: 'center',
      }}
    >
      <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text-primary)' }}>{title}</div>
      <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.5 }}>{sentence}</div>
      <button
        onClick={() => setAsking(true)}
        style={{
          // Spec §5's layout rules: "amber buttons use #1A1206 ink" — the
          // literal brand amber, NOT `var(--accent)`. `--accent` is
          // #FBBF24 in dark theme (11.1:1 with #1A1206) but #B85309 in
          // light theme (3.77:1 with #1A1206 — fails WCAG AA), because
          // light theme recalibrates `--accent` for use as *text/icon*
          // color on light surfaces, not as a button fill. The literal
          // #FBBF24 is the same pairing `AccountPage.jsx`'s Save button and
          // `dashboard.html`'s `.login-btn` use for exactly this reason.
          marginTop: 16, background: '#FBBF24', color: '#1A1206', border: 'none',
          borderRadius: 8, padding: '10px 20px', fontSize: 14, fontWeight: 700, cursor: 'pointer',
        }}
      >Ask LotLogic</button>
      {asking && (
        <FeedbackModal
          propertyId={propertyId}
          kind="feature"
          prefill={prefill}
          onClose={() => setAsking(false)}
        />
      )}
    </div>
  );
}
