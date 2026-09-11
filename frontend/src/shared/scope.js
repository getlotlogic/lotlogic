// A partner — a real partner login OR an admin using "View as Partner" — must
// only ever see properties they actually enforce. db.getProperties returns
// EVERY property for a platform-admin session (the admin's real session stays
// active during impersonation), so we scope client-side by the partner's own
// id here. This is what keeps e.g. NMLD from seeing N Style's Stevensons in the
// NMLD partner view. Owners / admins in their own (non-impersonated) view are
// unaffected (role !== 'partner' → returned unchanged).
export function scopePropsToPartner(props, user) {
  if (!user || user._role !== 'partner') return props;
  const pid = user.id;
  return (props || []).filter(p => p.tow_company_id === pid || p.partner_id === pid);
}
