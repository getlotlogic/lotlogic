// ── Per-property feature flags and the bottom-nav rule ───────
//
// `GET /auth/me` returns, for every non-archived property on the account,
// `{id, name, address, role, member_status, verification_status,
//   property_type, features:{passes, qr, cameras}}` (spec §8.3). Nothing is a
// new column: `passes`, `qr` and `cameras` are derived server-side.
//
// Spec §5 layout rules: a leasing office that runs the portal and nothing else
// must not stare at three empty camera surfaces. When EVERY property on the
// account has `features.cameras=false` the owner nav is Properties · Account
// (the tab id stays `lots`); when any property has a camera, the full five
// tabs show. Analytics / Training / Tow truck are never shown locked — the
// upsell lives inside the property page (§5.6), once.

// Flipped to true by Task 27, when the partner Requests page exists. Until
// then the tab is not listed, because it would render nothing.
export const partnerRequestsReady = false;

/**
 * A property that runs the portal only — no plate cameras.
 * Deliberately requires an EXPLICIT `cameras: false`: a legacy PostgREST row
 * (the `/auth/me` fallback in db.getProperties) carries no `features` at all,
 * and treating "unknown" as portal-only would hide Analytics/Training/Tow
 * truck from an owner who does have cameras.
 */
export function isPortalOnly(property) {
  return property?.features?.cameras === false;
}

const OWNER_TABS = [
  // Jobs tab hidden until cameras read 100% — everything surfaces on the pass.
  { id: 'lots', label: 'Lots' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'training', label: 'Training' },
  { id: 'towactivity', label: 'Tow truck' },
  { id: 'account', label: 'Account' },
];

const OWNER_PORTAL_ONLY_TABS = [
  { id: 'lots', label: 'Properties' },
  { id: 'account', label: 'Account' },
];

/**
 * The base bottom-nav for a role. App.jsx splices its own extras (Earnings /
 * Billing when there is a money flow, the platform-admin consoles, the NMLD
 * app preview) in before Account and attaches badges.
 *
 * @param {'owner'|'partner'} role
 * @param {Array<object>|null|undefined} properties `/auth/me.properties`
 * @param {{partnerRequestsReady?: boolean}} [opts]
 * @returns {Array<{id: string, label: string}>}
 */
export function navTabsFor(role, properties, opts = {}) {
  if (role === 'partner') {
    const requestsReady = opts.partnerRequestsReady ?? partnerRequestsReady;
    // Earnings + Billing/Invoices are owner-only surfaces — partners must
    // NEVER see revenue_share, fee schedules, or QuickBooks state. Removed
    // 2026-04-28 per Gabe, and this list is why.
    return [
      { id: 'lots', label: 'Lots' },
      ...(requestsReady ? [{ id: 'requests', label: 'Requests' }] : []),
      // In-lot plate lookup, folded in from lookup.html — the tow partner's
      // field tool. Shows for a partner login and when an admin views-as-partner.
      { id: 'lookup', label: 'Lookup' },
      { id: 'activity', label: 'Activity' },
      { id: 'account', label: 'Account' },
    ];
  }
  const list = Array.isArray(properties) ? properties : [];
  const portalOnly = list.length > 0 && list.every(isPortalOnly);
  return (portalOnly ? OWNER_PORTAL_ONLY_TABS : OWNER_TABS).map(t => ({ ...t }));
}
