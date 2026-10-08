// Unit tests for src/lib/verifyState.js — email verification state (spec
// §3.5), the digit-only code field, and the resend countdown. All three are
// pure functions over an injected `now`/value so they test without a DOM.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  verifyState,
  onlyDigits,
  secondsUntilResend,
  cooldownRetryAfter,
  sentAtForRetryAfter,
  WALL_DAYS,
  RESEND_COOLDOWN_SECONDS,
} from '../src/lib/verifyState.js';

const NOW = new Date('2026-10-08T00:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();

test('an admin account is verified regardless of email_verified', () => {
  const me = { signup_source: 'admin', email_verified: false, created_at: daysAgo(100) };
  assert.equal(verifyState(me, NOW), 'verified');
});

test('a seed/invite account is verified regardless of email_verified', () => {
  assert.equal(verifyState({ signup_source: 'seed', email_verified: false, created_at: daysAgo(30) }, NOW), 'verified');
  assert.equal(verifyState({ signup_source: 'invite', email_verified: false, created_at: daysAgo(30) }, NOW), 'verified');
});

test('a self-serve account that has confirmed is verified regardless of age', () => {
  const me = { signup_source: 'self_serve', email_verified: true, created_at: daysAgo(400) };
  assert.equal(verifyState(me, NOW), 'verified');
});

test('a self-serve unverified account 2 days old is unverified (banner)', () => {
  const me = { signup_source: 'self_serve', email_verified: false, created_at: daysAgo(2) };
  assert.equal(verifyState(me, NOW), 'unverified');
});

test('a self-serve unverified account 8 days old is walled', () => {
  const me = { signup_source: 'self_serve', email_verified: false, created_at: daysAgo(8) };
  assert.equal(verifyState(me, NOW), 'walled');
});

test('the wall boundary is exactly WALL_DAYS (>= , not >)', () => {
  assert.equal(WALL_DAYS, 7);
  const justUnder = { signup_source: 'self_serve', email_verified: false, created_at: daysAgo(6.99) };
  const exactlyAt = { signup_source: 'self_serve', email_verified: false, created_at: daysAgo(7) };
  const justOver = { signup_source: 'self_serve', email_verified: false, created_at: daysAgo(7.01) };
  assert.equal(verifyState(justUnder, NOW), 'unverified');
  assert.equal(verifyState(exactlyAt, NOW), 'walled');
  assert.equal(verifyState(justOver, NOW), 'walled');
});

test('no me at all is verified (never block a render before the session loads)', () => {
  assert.equal(verifyState(null, NOW), 'verified');
  assert.equal(verifyState(undefined, NOW), 'verified');
});

test('the code field keeps digits only from a pasted "482-190"', () => {
  assert.equal(onlyDigits('482-190'), '482190');
});

test('onlyDigits caps at 6 digits and ignores everything else', () => {
  assert.equal(onlyDigits('4 8 2 1 9 0 7 7'), '482190');
  assert.equal(onlyDigits(''), '');
  assert.equal(onlyDigits(null), '');
  assert.equal(onlyDigits(undefined), '');
});

test('countdown math: a sent_at 18 s ago leaves 42 s', () => {
  const now = new Date('2026-10-08T00:01:00Z');
  const sentAt = new Date(now.getTime() - 18_000).toISOString();
  assert.equal(secondsUntilResend(sentAt, now), 42);
  assert.equal(RESEND_COOLDOWN_SECONDS, 60);
});

test('countdown floors at 0 once the cooldown has fully elapsed', () => {
  const now = new Date('2026-10-08T00:01:00Z');
  const sentAt = new Date(now.getTime() - 90_000).toISOString();
  assert.equal(secondsUntilResend(sentAt, now), 0);
});

test('countdown is 0 immediately (a fresh code just sent at t=0)', () => {
  const now = new Date('2026-10-08T00:01:00Z');
  assert.equal(secondsUntilResend(now.toISOString(), now), 60);
});

test('a missing sent_at means resend is available right away', () => {
  assert.equal(secondsUntilResend(null), 0);
  assert.equal(secondsUntilResend(undefined), 0);
  assert.equal(secondsUntilResend('not-a-date'), 0);
});

// ── cooldownRetryAfter / sentAtForRetryAfter (fix-round-1 blocking finding) ──
// The banner's "Resend" catch block used to treat the spec's documented 429
// `resend_cooldown {retry_after}` identically to a genuine offline failure.
// These two pure helpers are what the fixed App.jsx catch branches on.

test('cooldownRetryAfter reads retry_after off a resend_cooldown rejection', () => {
  const e = { code: 'resend_cooldown', body: { retry_after: 37 } };
  assert.equal(cooldownRetryAfter(e), 37);
});

test('cooldownRetryAfter falls back to RESEND_COOLDOWN_SECONDS when the body omits retry_after', () => {
  const e = { code: 'resend_cooldown', body: {} };
  assert.equal(cooldownRetryAfter(e), RESEND_COOLDOWN_SECONDS);
  assert.equal(cooldownRetryAfter({ code: 'resend_cooldown' }), RESEND_COOLDOWN_SECONDS);
});

test('cooldownRetryAfter is null for every other rejection — offline, 5xx, missing e', () => {
  assert.equal(cooldownRetryAfter({ code: 'offline' }), null);
  assert.equal(cooldownRetryAfter({ status: 500 }), null);
  assert.equal(cooldownRetryAfter(null), null);
  assert.equal(cooldownRetryAfter(undefined), null);
});

test('sentAtForRetryAfter round-trips through secondsUntilResend', () => {
  const now = new Date('2026-10-08T00:01:00Z');
  const sentAt = sentAtForRetryAfter(23, now);
  assert.equal(secondsUntilResend(sentAt, now), 23);
});

test('sentAtForRetryAfter at the full cooldown is "sent right now"', () => {
  const now = new Date('2026-10-08T00:01:00Z');
  assert.equal(sentAtForRetryAfter(RESEND_COOLDOWN_SECONDS, now), now.toISOString());
});
