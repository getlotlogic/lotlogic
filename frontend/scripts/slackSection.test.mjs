// Unit tests for the partner Account → Slack section's pure logic
// (src/pages/account/slackSection.js) and a static naming guard over the
// two source files that render this surface.
//
// Spec §5.7 / §6.1: the Slack role `driver` is never shown as "Driver" — it
// renders "Truck"; `manager` renders "Office". `GET /partner/slack/status`
// (`{connected, team_name, feed_channel_set, revoked}`) drives a four-state
// machine: not_connected | connected_no_feed | connected | revoked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { roleLabel, slackState, parseSlackRedirect, cleanSlackRedirectUrl } from '../src/pages/account/slackSection.js';

const ROOT = path.resolve(import.meta.dirname, '..');

// ── roleLabel ─────────────────────────────────────────────────

test('roleLabel renders the manager role as Office', () => {
  assert.equal(roleLabel('manager'), 'Office');
});

test('roleLabel renders the driver role as Truck', () => {
  assert.equal(roleLabel('driver'), 'Truck');
});

test('roleLabel never renders the banned word "Driver", even for unexpected input', () => {
  for (const bad of [undefined, null, '', 'Driver', 'DRIVER', 'resident', 'guest']) {
    assert.equal(roleLabel(bad), 'Truck');
  }
});

// ── slackState state machine ─────────────────────────────────

test('slackState: never connected', () => {
  assert.equal(slackState({ connected: false, feed_channel_set: false, revoked: false }), 'not_connected');
});

test('slackState: no status payload at all (loading / non-404 fetch failure)', () => {
  assert.equal(slackState(null), 'not_connected');
  assert.equal(slackState(undefined), 'not_connected');
});

test('slackState: connected, feed channel never set up', () => {
  assert.equal(slackState({ connected: true, feed_channel_set: false, revoked: false }), 'connected_no_feed');
});

test('slackState: fully connected', () => {
  assert.equal(slackState({ connected: true, feed_channel_set: true, revoked: false }), 'connected');
});

test('slackState: token revoked / app uninstalled wins over feed_channel_set', () => {
  assert.equal(slackState({ connected: true, feed_channel_set: true, revoked: true }), 'revoked');
  assert.equal(slackState({ connected: true, feed_channel_set: false, revoked: true }), 'revoked');
});

test('slackState: the backend sends connected:false with revoked:true for an uninstalled app', () => {
  assert.equal(slackState({ connected: false, revoked: true }), 'revoked');
  assert.equal(slackState({ connected: false, feed_channel_set: true, revoked: true }), 'revoked');
});

// ── the `?slack=connected|error` redirect App.jsx reads once on mount ──

test('parseSlackRedirect reads connected', () => {
  assert.equal(parseSlackRedirect('?tab=account&slack=connected'), 'connected');
});

test('parseSlackRedirect reads error', () => {
  assert.equal(parseSlackRedirect('?slack=error'), 'error');
});

test('parseSlackRedirect ignores everything else', () => {
  assert.equal(parseSlackRedirect('?tab=account'), null);
  assert.equal(parseSlackRedirect(''), null);
  assert.equal(parseSlackRedirect(null), null);
  assert.equal(parseSlackRedirect(undefined), null);
  assert.equal(parseSlackRedirect('?slack=bogus'), null);
});

test('cleanSlackRedirectUrl drops only the slack key', () => {
  assert.equal(cleanSlackRedirectUrl('/app', '?tab=account&slack=connected'), '/app?tab=account');
  assert.equal(cleanSlackRedirectUrl('/app', '?slack=error'), '/app');
  assert.equal(cleanSlackRedirectUrl('/app', ''), '/app');
});

// ── naming guard (constraints "Copy"): "Driver" never appears in source ──

function slackSourceFiles() {
  return [
    path.join(ROOT, 'src/pages/account/SlackSection.jsx'),
    path.join(ROOT, 'src/pages/account/slackSection.js'),
  ];
}

test('no Slack-section source file ever renders the banned label, capital-D', () => {
  // Case-sensitive and scoped to the capitalized display form on purpose:
  // the Slack `role` column's own DB/API value is the lowercase literal
  // 'driver' (sent verbatim in `PATCH /partner/slack/identities/{id}
  // {role}` and compared against in the toggle logic below) — the
  // constraints carve that out explicitly ("DB column and verdict names are
  // unchanged"). What is banned is ever presenting the word, capitalized,
  // to a person — roleLabel() above is the only place a role becomes
  // display text, and it never returns this.
  const BANNED_DISPLAY = /\bDriver\b/;
  for (const file of slackSourceFiles()) {
    const src = readFileSync(file, 'utf8');
    const hit = src.match(BANNED_DISPLAY);
    assert.equal(hit, null, `${path.basename(file)} renders the banned label "Driver"`);
  }
});

test('no Slack-section source file uses the other forbidden naming words', () => {
  const WORDS = /\b(resident|visitor|permanent|temporary|guest)s?\b/i;
  for (const file of slackSourceFiles()) {
    const src = readFileSync(file, 'utf8');
    const hit = src.match(WORDS);
    assert.equal(hit, null, `${path.basename(file)} uses "${hit?.[0]}" — say "parking pass"`);
  }
});

test('the naming guard above is actually reading real files', () => {
  for (const file of slackSourceFiles()) {
    assert.ok(readFileSync(file, 'utf8').length > 0, `${file} is empty or missing`);
  }
});
