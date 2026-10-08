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
