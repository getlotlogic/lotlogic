// A partner — a real partner login OR an admin using "View as Partner" — must
// only ever see properties they actually enforce. db.getProperties returns
// EVERY property for a platform-admin session (the admin's real session stays
// active during impersonation), so we scope client-side by the partner's own
// id here. This is what keeps e.g. NMLD from seeing N Style's Stevensons in the
// NMLD partner view. Owners / admins in their own (non-impersonated) view are
// unaffected (role !== 'partner' → returned unchanged).
// `/auth/me`'s partner property shape carries `role:'partner'` and no
// `tow_company_id` — the backend has already scoped the list to the partner
// holding the token, so such a row is in scope by construction. The two column
// checks still cover the "View as Partner" path, which reads the tables
// (db.getPropertiesByOwnerColumn) precisely because it needs those columns.
export function scopePropsToPartner(props, user) {
  if (!user || user._role !== 'partner') return props;
  const pid = user.id;
  return (props || []).filter(p => p.tow_company_id === pid || p.partner_id === pid || p.role === 'partner');
}
