// ── The pending-membership state (spec §3.7 (b)) ──────────────
//
// `GET /auth/me` includes pending memberships in `properties` with
// `member_status='pending'` right alongside active ones (Task 14c's owner
// shape). `App.jsx` renders `PendingMembershipPage` instead of Lots exactly
// when the account has no `active` row and at least one `pending` one — a
// brand-new "ask to join" request with nothing else going on. An account
// that is active anywhere (even if it also has a separate pending join)
// keeps the normal Lots page; a pending join rides along inside it instead
// (that surface is Task 24/27's Team "Approve/Decline" list, not this page).

/**
 * @param {{properties?: Array<{member_status?: string}>}|null|undefined} me `GET /auth/me`'s owner shape
 * @returns {boolean}
 */
export function pendingMembershipState(me) {
  const properties = Array.isArray(me?.properties) ? me.properties : [];
  const hasActive = properties.some(p => p?.member_status === 'active');
  const hasPending = properties.some(p => p?.member_status === 'pending');
  return !hasActive && hasPending;
}

/**
 * The property(s) the account is waiting on. Used by `PendingMembershipPage`
 * to name the property in its copy ("We've asked Sunset Ridge Apartments…")
 * and to carry the id `requestsApi.resendJoinRequest` needs.
 * @param {{properties?: Array<object>}|null|undefined} me
 * @returns {Array<object>}
 */
export function pendingProperties(me) {
  const properties = Array.isArray(me?.properties) ? me.properties : [];
  return properties.filter(p => p?.member_status === 'pending');
}
