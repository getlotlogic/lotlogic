// Unit tests for the greyed upsell chips (spec §5.6):
// `src/pages/property/UpsellPanel.jsx`'s `lockedChips(features)` (which of
// the three upsell chips are locked) and `upsellCopy(feature)` (the spec's
// verbatim one-sentence pitch per chip).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { lockedChips, upsellCopy, upsellTitle, upsellFeatureName } from '../src/lib/upsell.js';

const ids = chips => chips.map(c => c.id);

test('all three locked when every flag reads explicit false', () => {
  const chips = lockedChips({ passes: false, qr: false, cameras: false });
  assert.deepEqual(ids(chips), ['log', 'qr', 'cameras']);
  assert.deepEqual(chips.map(c => c.label), ['Parking passes', 'QR codes', 'Cameras']);
  assert.ok(chips.every(c => c.locked === true));
});

test('only the flags that read false are locked', () => {
  assert.deepEqual(ids(lockedChips({ passes: true, qr: true, cameras: false })), ['cameras']);
  assert.deepEqual(ids(lockedChips({ passes: false, qr: false, cameras: true })), ['log', 'qr']);
  assert.deepEqual(ids(lockedChips({ passes: true, qr: true, cameras: true })), []);
});

test('an explicit qr:false locks qr even when passes reads true', () => {
  // Spec: qr implies passes (qr_code_id IS NOT NULL is one of the passes
  // OR-clauses), but the function itself must not assume that — it locks
  // exactly the flags handed to it, nothing inferred.
  assert.deepEqual(ids(lockedChips({ passes: true, qr: false, cameras: true })), ['qr']);
});

test('unknown never locks — explicit false only, same rule as isPortalOnly', () => {
  assert.deepEqual(lockedChips({}), []);
  assert.deepEqual(lockedChips(null), []);
  assert.deepEqual(lockedChips(undefined), []);
  assert.deepEqual(lockedChips({ passes: undefined, qr: undefined, cameras: undefined }), []);
});

test('upsellCopy is the spec\'s verbatim sentence, one per feature', () => {
  assert.equal(
    upsellCopy('passes'),
    'People who live or visit here register their own cars, so you stop managing hang tags.',
  );
  assert.equal(
    upsellCopy('qr'),
    'A sign at the entrance; anyone scans it and gets a parking pass in a minute.',
  );
  assert.equal(
    upsellCopy('cameras'),
    "Plate cameras spot cars with no parking pass and show who's in the lot right now.",
  );
  assert.equal(upsellCopy('unknown-feature'), '');
});

test('upsellTitle matches the chip label', () => {
  assert.equal(upsellTitle('passes'), 'Parking passes');
  assert.equal(upsellTitle('qr'), 'QR codes');
  assert.equal(upsellTitle('cameras'), 'Cameras');
});

test('upsellFeatureName reads naturally mid-sentence, for the FeedbackModal prefill', () => {
  assert.equal(upsellFeatureName('passes'), 'parking passes');
  assert.equal(upsellFeatureName('qr'), 'QR codes');
  assert.equal(upsellFeatureName('cameras'), 'cameras');
});

// ── Naming rule ───────────────────────────────────────────────
// The only user-facing pass word is "parking pass" — never "Resident",
// "Visitor", "Permanent", "Temporary", "Guest" or "Driver" (constraints.md).
// "Parking passes" / "parking pass" are explicitly allowed; this regex does
// not match either word.
const BANNED = /\b(resident|visitor|permanent|temporary|guest|driver)s?\b/i;

test('no locked-chip label or upsell sentence uses a banned word', () => {
  const allChips = lockedChips({ passes: false, qr: false, cameras: false });
  for (const c of allChips) {
    assert.equal(c.label.match(BANNED), null, `chip label "${c.label}" uses a banned word`);
  }
  for (const feature of ['passes', 'qr', 'cameras']) {
    const sentence = upsellCopy(feature);
    assert.equal(sentence.match(BANNED), null, `upsellCopy('${feature}') uses a banned word`);
  }
  // "Parking passes" itself must never trip the checker.
  assert.equal('Parking passes'.match(BANNED), null);
});

test('neither upsell source file carries a banned word', () => {
  for (const rel of ['../src/lib/upsell.js', '../src/pages/property/UpsellPanel.jsx']) {
    const file = path.resolve(import.meta.dirname, rel);
    const hit = readFileSync(file, 'utf8').match(BANNED);
    assert.equal(hit, null, `${rel} uses "${hit?.[0]}" — say "parking pass"`);
  }
});
