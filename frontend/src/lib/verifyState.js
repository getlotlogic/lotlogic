// ── Email verification state (spec §3.5) ──────────────────────
//
// `verifyState(me)` reads exactly the three fields the spec names:
// `signup_source`, `email_verified`, `created_at` (the `/auth/me` owner
// shape, Task 14c). "Who is gated": the banner, the tow/photo gate and the
// wall apply ONLY when `signup_source==='self_serve' AND email_verified` is
// false — every admin/seed/invite account, and every self-serve account that
// has confirmed, is 'verified' unconditionally. After WALL_DAYS unverified
// days the banner becomes a wall ("The wall (day 7)").
//
// `now` is injectable everywhere here so the three pure functions test
// without a DOM or a clock.

export const WALL_DAYS = 7;
export const RESEND_COOLDOWN_SECONDS = 60;

/**
 * @param {{signup_source?: string, email_verified?: boolean, created_at?: string}} me
 * @param {Date} [now]
 * @returns {'verified'|'unverified'|'walled'}
 */
export function verifyState(me, now = new Date()) {
  if (!me) return 'verified';
  if (me.signup_source !== 'self_serve') return 'verified';
  if (me.email_verified) return 'verified';
  const created = me.created_at ? new Date(me.created_at) : now;
  if (Number.isNaN(created.getTime())) return 'unverified';
  const ageDays = (now.getTime() - created.getTime()) / 86400000;
  return ageDays >= WALL_DAYS ? 'walled' : 'unverified';
}

/**
 * The code field keeps digits only, capped at 6 — a pasted "482-190" becomes
 * "482190". The input's `value` already carries pasted text by the time
 * `onChange` fires, so this is the one place paste handling lives.
 * @param {string} input
 * @returns {string}
 */
export function onlyDigits(input) {
  return String(input ?? '').replace(/\D/g, '').slice(0, 6);
}

/**
 * Seconds left before "Resend" becomes a link, counting down from `cooldown`
 * seconds after `sentAt`. Floors at 0; a missing/invalid `sentAt` means
 * resend is available immediately.
 * @param {string|Date|null|undefined} sentAt
 * @param {Date} [now]
 * @param {number} [cooldown]
 * @returns {number}
 */
export function secondsUntilResend(sentAt, now = new Date(), cooldown = RESEND_COOLDOWN_SECONDS) {
  if (!sentAt) return 0;
  const sent = sentAt instanceof Date ? sentAt : new Date(sentAt);
  if (Number.isNaN(sent.getTime())) return 0;
  const elapsedSeconds = (now.getTime() - sent.getTime()) / 1000;
  const left = Math.ceil(cooldown - elapsedSeconds);
  return left > 0 ? left : 0;
}

/**
 * Tells apart the spec's documented 429 `resend_cooldown {retry_after}`
 * (a raced double-tap of Resend inside the 60s window — the server working
 * as designed) from every other rejection of `POST /auth/resend-verification`
 * (offline, DNS, CORS, a genuine 5xx) — those two are NOT the same failure
 * and must not show the same "can't reach" copy. Returns the cooldown
 * seconds remaining, or `null` when `e` is not a cooldown rejection.
 * @param {{code?: string, body?: {retry_after?: number}}} e
 * @param {number} [fallback] seconds to report when the body omits retry_after
 * @returns {number|null}
 */
export function cooldownRetryAfter(e, fallback = RESEND_COOLDOWN_SECONDS) {
  if (!e || e.code !== 'resend_cooldown') return null;
  return typeof e.body?.retry_after === 'number' ? e.body.retry_after : fallback;
}

/**
 * The inverse of `secondsUntilResend`: an `email_verify_sent_at` timestamp
 * that makes `secondsUntilResend(result, now, cooldown)` report `retryAfter`
 * seconds remaining. Used when the server's 429 `retry_after` disagrees with
 * what the client's own `sentAt` would compute (its clock, or a sibling tab's
 * resend, raced ahead of ours) — the server's number wins.
 * @param {number} retryAfter
 * @param {Date} [now]
 * @param {number} [cooldown]
 * @returns {string} ISO timestamp
 */
export function sentAtForRetryAfter(retryAfter, now = new Date(), cooldown = RESEND_COOLDOWN_SECONDS) {
  return new Date(now.getTime() - (cooldown - retryAfter) * 1000).toISOString();
}
