// ── Greyed upsell tabs — pure helpers (spec §5.6) ────────────
//
// Split out of `src/pages/property/UpsellPanel.jsx` so these are plain JS
// (no JSX), importable from `node --test` without a build step — same
// reason `lib/features.js`'s `navTabsFor`/`isPortalOnly` sit next to, not
// inside, the components that render them, and `lib/holdTime.js` sits next
// to Task 22's Requests components.
//
// A property with no pass flow switched on and no cameras shows the chip
// row `Requests · 🔒 Parking passes · 🔒 QR codes · 🔒 Cameras` — real,
// keyboard-reachable buttons, muted via `var(--text-muted)` (≥ 4.5:1 on both
// themes), `aria-describedby="Not included yet"`. Tapping one renders
// `UpsellPanel.jsx` in place of the section it would otherwise show: one
// card, a title, the spec's one-sentence pitch, and a single `Ask LotLogic`
// button that opens `FeedbackModal` pre-filled with the spec's sentence.
//
// Source of truth: `GET /auth/me → properties[].features {passes, qr,
// cameras}` — no new column, nothing derived client-side beyond "which flag
// reads false".

/** Chip id -> display label, in the order the spec's example row lists them. */
const CHIP_DEFS = [
  { feature: 'passes', id: 'log', label: 'Parking passes' },
  { feature: 'qr', id: 'qr', label: 'QR codes' },
  { feature: 'cameras', id: 'cameras', label: 'Cameras' },
];

/**
 * Which of the three upsell chips are locked for this property. Mirrors
 * `isPortalOnly` in `lib/features.js`: requires an EXPLICIT `false` on the
 * matching flag. A legacy row with no `features` at all, or a flag that is
 * `true` or merely absent, is never locked — "unknown" must never hide a
 * feature a property actually has.
 *
 * @param {{passes?: boolean, qr?: boolean, cameras?: boolean}|null|undefined} features
 * @returns {Array<{id: string, feature: string, label: string, locked: true}>}
 */
export function lockedChips(features) {
  const f = features || {};
  return CHIP_DEFS
    .filter((c) => f[c.feature] === false)
    .map((c) => ({ id: c.id, feature: c.feature, label: c.label, locked: true }));
}

/** The spec's verbatim one-sentence pitch, keyed by feature. */
export function upsellCopy(feature) {
  switch (feature) {
    case 'passes':
      return 'People who live or visit here register their own cars, so you stop managing hang tags.';
    case 'qr':
      return 'A sign at the entrance; anyone scans it and gets a parking pass in a minute.';
    case 'cameras':
      return "Plate cameras spot cars with no parking pass and show who's in the lot right now.";
    default:
      return '';
  }
}

/** The card title for a locked feature — the chip label, unlocked of its 🔒. */
export function upsellTitle(feature) {
  return CHIP_DEFS.find((c) => c.feature === feature)?.label ?? feature;
}

/** Mid-sentence phrasing for the `FeedbackModal` prefill — lowercase except the QR acronym. */
export function upsellFeatureName(feature) {
  if (feature === 'qr') return 'QR codes';
  if (feature === 'cameras') return 'cameras';
  if (feature === 'passes') return 'parking passes';
  return feature;
}
