import React, { useState, useEffect, useCallback, useRef } from 'react';
import { supabase, applySupabaseAuth } from './lib/supabase.js';
import { apiFetch } from './lib/api.js';
import { db } from './lib/db.js';
import { useTheme, useOnlineStatus } from './hooks.js';
import { haptic, NotifyManager } from './lib/notify.js';
import { useToast } from './ui/Toast.jsx';
import { SkeletonCards } from './ui/Skeletons.jsx';
import { NavIconJobs, NavIconLots, NavIconEarnings, NavIconAccount, NavIconActivity, NavIconOverview } from './ui/icons.jsx';
import { lazyPage } from './lib/lazyPage.js';
import { readDeepLink, cleanDeepLink, readPublicRoute, readJoinSlug, emptyDeepLink } from './lib/deepLink.js';
import { navTabsFor, partnerRequestsReady } from './lib/features.js';
import { verifyState, secondsUntilResend, cooldownRetryAfter, sentAtForRetryAfter } from './lib/verifyState.js';
import { requestsApi } from './lib/requestsApi.js';
import { VerifyBanner } from './ui/VerifyBanner.jsx';
import { VerifyEmailSheet } from './pages/property/VerifyEmailSheet.jsx';
import { EarningsPage } from './pages/EarningsPage.jsx';
import { InvoicesPage } from './pages/InvoicesPage.jsx';
import { ALPRPropertiesPage } from './pages/ALPRPropertiesPage.jsx';
import { LoginPage } from './pages/LoginPage.jsx';
import { OperatorActivityPage } from './pages/OperatorActivityPage.jsx';
import { OverviewPage } from './pages/OverviewPage.jsx';
import { AccountPage } from './pages/AccountPage.jsx';
import { PlateLookupPage } from './pages/PlateLookupPage.jsx';
import { PartnerAppPage } from './pages/PartnerAppPage.jsx';

// Heavy tabs — lazy so a phone loads a login form, not a billing console.
// Each of these eight modules also carries `export default` for this.
const JobsPage         = lazyPage(() => import('./pages/JobsPage.jsx'));
const AnalyticsPage    = lazyPage(() => import('./pages/AnalyticsPage.jsx'));
const TowActivityPage  = lazyPage(() => import('./pages/TowActivityPage.jsx'));
const TrainingPage     = lazyPage(() => import('./pages/TrainingPage.jsx'));
const AdminConsolePage = lazyPage(() => import('./pages/AdminConsolePage.jsx'));
const HqPage           = lazyPage(() => import('./pages/HqPage.jsx'));

const NMLD_PARTNER_ID = '1826b6b4-e8dc-402f-b4e7-926e259a56fe';
const FRANK_APP_TAB_LIVE = true; // live in Frank's partner portal since 2026-08-07

// The public (no-session) routes `vercel.json` rewrites into this bundle, and
// the page each one renders. Empty on purpose: the pages land with their own
// tasks — Task 25 registers `join` (`<SignupPage slug onDone={login}/>`) and
// Task 29 registers `request-action` (the `/r/<token>` page). Until then an
// unregistered route falls through to the sign-in form, whose "New property?
// Create your account" link is the door, so no portal link is a dead end.
const PUBLIC_ROUTE_PAGES = {};
// Same table for a session that already exists: only `/join…` differs there
// (spec §3.2 — a signed-in manager opening someone else's link gets the
// add-property form), and Task 25 registers it.
const PUBLIC_ROUTE_PAGES_SIGNED_IN = {};

// Every tab id the dashboard knows. A `?tab=` deep link is only honoured for
// one of these; whether this particular account may SEE it is then settled by
// the coercion effect below against the nav it actually gets.
const KNOWN_TAB_IDS = [
  'overview', 'lots', 'requests', 'analytics', 'training', 'towactivity',
  'earnings', 'invoices', 'admin', 'app', 'hq', 'lookup', 'activity', 'account',
];



// ── Main App ──────────────────────────────────────────────────
export function App() {
  const { addToast } = useToast();
  const { theme, toggle: toggleTheme } = useTheme();
  const { online, reconnected } = useOnlineStatus();
  const [owner, setOwner] = useState(() => {
    try {
      const s = localStorage.getItem('lotlogic_session');
      if (!s) return null;
      const parsed = JSON.parse(s);
      // Session expires after 7 days locally, or sooner if the JWT is missing.
      if (!parsed._token) {
        localStorage.removeItem('lotlogic_session');
        return null;
      }
      if (parsed._ts && Date.now() - parsed._ts > 7 * 86400000) {
        localStorage.removeItem('lotlogic_session');
        return null;
      }
      return parsed;
    } catch { return null; }
  });

  useEffect(() => {
    function onAuthExpired() {
      setOwner(null);
    }
    window.addEventListener('lotlogic:auth-expired', onAuthExpired);
    return () => window.removeEventListener('lotlogic:auth-expired', onAuthExpired);
  }, []);

  // Self-heal stale sessions: always re-fetch admin flags from /auth/me
  // on mount, so a user who was elevated to admin after their cached
  // session was stamped (even with explicit `false`) gets the upgrade
  // without having to log out + log in. The /auth/me lookup is cheap
  // (one row) and only runs once per token change.
  useEffect(() => {
    if (!owner?._token) return;
    apiFetch('/auth/me').then(me => {
      if (!me || !me.email) return;
      // The property list with its `features` flags. Absent on a backend that
      // has not deployed the portal shape yet — leave the state alone then, so
      // the nav keeps every tab rather than collapsing on a missing key.
      if (Array.isArray(me.properties)) setProperties(me.properties);
      setOwner(prev => {
        if (!prev) return prev;
        // email_verified / signup_source / created_at / email_verify_sent_at
        // drive verifyState() (Task 23, spec §3.5) — the banner/wall above
        // the page content and the "Resend in Ns" countdown in
        // VerifyEmailSheet. Compared explicitly (not just is_admin) so the
        // banner unmounts the moment this self-heal re-runs after a verify.
        const next = {
          is_admin: !!me.is_admin,
          is_platform_admin: !!me.is_platform_admin,
          email_verified: !!me.email_verified,
          signup_source: me.signup_source,
          created_at: me.created_at,
          email_verify_sent_at: me.email_verify_sent_at ?? null,
        };
        const unchanged = Object.keys(next).every(k => prev[k] === next[k]);
        if (unchanged) return prev; // no change — avoid state churn / re-renders
        const merged = { ...prev, ...next };
        try { localStorage.setItem('lotlogic_session', JSON.stringify(merged)); } catch {}
        return merged;
      });
    }).catch(() => { /* ignore — gate falls back to JWT decode */ });
  }, [owner?._token]);
  // Parse deep link from SMS: /violations/{id} → open jobs tab and highlight
  const [deepLinkViolationId] = useState(() => {
    const path = window.location.pathname || '';
    const match = path.match(/\/violations\/([0-9a-f-]{36})/i);
    return match ? match[1] : null;
  });
  // The two paths `vercel.json` rewrites into this bundle without a session:
  // `/join…` (Task 25's SignupPage) and `/r/…` (Task 29's request-action
  // page). Read once — this never changes without a navigation.
  const [publicRoute] = useState(() => readPublicRoute(window.location.pathname));
  const [publicSlug] = useState(() => readJoinSlug(window.location.pathname));
  // `/app?property=…&section=…&request=…&tab=…&firstrun=&verify=&upload=&plate=`
  // — the portal's email and Slack buttons. Captured on mount before anything
  // can rewrite the address bar, applied once the session exists, then cleaned
  // out of the url so a refresh does not replay `firstrun`.
  const [deepLink, setDeepLink] = useState(() => readDeepLink(window.location.search));
  const clearDeepLink = useCallback(() => setDeepLink(emptyDeepLink()), []);

  // ── VerifyEmailSheet (Task 23, spec §5.9) ──────────────────
  // Owned here, not by whichever page happens to open it, because the sheet
  // is reached from three independent places: the banner/wall below, the
  // `?verify=1` deep link, and (once Task 22 lands) a tow/photo/pending-hold
  // gate via `onNeedVerify(resume)`. `verifySheetMode` picks the sub-view
  // ('code' default, 'changeEmail' when opened via "Change email");
  // `verifyFromWall` is the no-✕/Sign-out variant; `verifyResumeRef` holds
  // the submit a gate was waiting on, fired once on success and then forgotten.
  const [verifySheetOpen, setVerifySheetOpen] = useState(false);
  const [verifySheetMode, setVerifySheetMode] = useState('code');
  const [verifyFromWall, setVerifyFromWall] = useState(false);
  const verifyResumeRef = useRef(null);
  const openVerifySheet = useCallback((opts) => {
    const { mode = 'code', fromWall = false, resume = null } = opts || {};
    verifyResumeRef.current = typeof resume === 'function' ? resume : null;
    setVerifySheetMode(mode);
    setVerifyFromWall(fromWall);
    setVerifySheetOpen(true);
  }, []);
  const closeVerifySheet = useCallback(() => {
    setVerifySheetOpen(false);
    verifyResumeRef.current = null;
  }, []);
  // The shape Task 22's composer expects: `onNeedVerify(resume)`, one arg.
  const onNeedVerify = useCallback((resume) => openVerifySheet({ mode: 'code', fromWall: false, resume }), [openVerifySheet]);
  const handleVerifySuccess = useCallback((resp) => {
    setOwner(prev => {
      if (!prev) return prev;
      const merged = { ...prev, email_verified: true };
      // SIGNUP_VERIFY_FIRST's verify-email response carries the login shape
      // (spec §5.9 success row) — pick up the fresh token so the session
      // that landed signed-in-via-code keeps working.
      if (resp && typeof resp.token === 'string') { merged._token = resp.token; merged._ts = Date.now(); }
      try { localStorage.setItem('lotlogic_session', JSON.stringify(merged)); } catch {}
      return merged;
    });
    setVerifySheetOpen(false);
    addToast('Email confirmed', 'success');
    const resume = verifyResumeRef.current;
    verifyResumeRef.current = null;
    if (resume) resume();
  }, [addToast]);
  // VerifyEmailSheet's "Change email" success only updates its own local
  // `currentEmail` — this is what keeps `owner.email` (what the banner
  // actually renders) in sync, the same persist-to-session pattern
  // `handleVerifySuccess` above uses.
  const handleEmailChanged = useCallback((newEmail) => {
    setOwner(prev => {
      if (!prev) return prev;
      const merged = { ...prev, email: newEmail };
      try { localStorage.setItem('lotlogic_session', JSON.stringify(merged)); } catch {}
      return merged;
    });
  }, []);
  // A bare "Resend" tap from the banner/wall (not through the sheet) — the
  // cooldown gate is enforced by disabling the button (see bannerResendDisabled
  // below), but a raced double-tap (e.g. right after signup auto-sends the
  // first code) can still reach the server inside the 60s window and get
  // back the spec's documented 429 `resend_cooldown {retry_after}`. That is
  // not the same failure as a genuine offline/network error and must not
  // show the same "can't reach" toast — mirrors VerifyEmailSheet's own
  // resend() handling.
  const handleBannerResend = useCallback(() => {
    requestsApi.resendVerification({}).then(() => {
      setOwner(prev => (prev ? { ...prev, email_verify_sent_at: new Date().toISOString() } : prev));
      addToast('Sent. Check your email — and the spam folder.', 'success');
    }).catch((e) => {
      const retryAfter = cooldownRetryAfter(e);
      if (retryAfter !== null) {
        // Rebase email_verify_sent_at so secondsUntilResend() (driving
        // bannerResendDisabled) agrees with the server's retry_after,
        // instead of trusting a client clock that raced ahead of it.
        setOwner(prev => (prev ? { ...prev, email_verify_sent_at: sentAtForRetryAfter(retryAfter) } : prev));
        addToast(`Already sent — try again in ${retryAfter}s.`, 'error');
        return;
      }
      addToast("Can't reach LotLogic — try again.", 'error');
    });
  }, [addToast]);
  // `/auth/me.properties` — the per-property `features` flags behind the
  // bottom-nav rule (spec §5) and the §5.6 upsell chips.
  const [properties, setProperties] = useState([]);
  const [tab, setTab] = useState(() => {
    // Jobs tab is hidden (camera-driven; unreliable until cameras read 100% of
    // cars). Land on Lots and coerce any persisted 'jobs' so nobody opens it.
    try { const t = localStorage.getItem('lotlogic_tab'); return (!t || t === 'jobs') ? 'lots' : t; } catch { return 'lots'; }
  });
  const [lots, setLots] = useState([]);
  // True after the first successful lots fetch — tab coercion must not run
  // before this or a persisted Earnings/Billing tab gets bounced (and
  // re-persisted as 'lots') while `lots` is still the initial [].
  const [lotsLoaded, setLotsLoaded] = useState(false);
  const [lotStates, setLotStates] = useState({});
  const [violations, setViolations] = useState([]);
  const [alprViolations, setAlprViolations] = useState([]);
  const [partners, setPartners] = useState([]);
  const [viewAs, setViewAs] = useState(null); // null = owner view, partner object = partner-portal impersonation
  const [partnerSwitcherOpen, setPartnerSwitcherOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(() => {
    try { const v = localStorage.getItem('lotlogic_autorefresh'); return v !== 'false'; } catch { return true; }
  });
  const [refreshInterval, setRefreshInterval] = useState(() => {
    try { return parseInt(localStorage.getItem('lotlogic_refresh_interval')) || 30000; } catch { return 30000; }
  });
  const timerRef = useRef(null);

  // Persist settings across refresh
  useEffect(() => {
    try { localStorage.setItem('lotlogic_tab', tab); } catch {}
  }, [tab]);
  useEffect(() => {
    try { localStorage.setItem('lotlogic_autorefresh', String(autoRefresh)); } catch {}
  }, [autoRefresh]);
  useEffect(() => {
    try { localStorage.setItem('lotlogic_refresh_interval', String(refreshInterval)); } catch {}
  }, [refreshInterval]);

  const isOwner = owner?._role === 'owner' && !viewAs;
  const isOperator = owner?._role === 'partner' || !!viewAs;
  // Who is gated (spec §3.5): only a self-serve owner account that hasn't
  // confirmed. `viewAs` / partner sessions never carry signup_source, so
  // verifyState() falls through to 'verified' for them on its own.
  const emailVerifyState = isOwner ? verifyState(owner) : 'verified';
  // The banner/wall "Resend" button's client-side cooldown gate. `resendTick`
  // itself is unused — it only exists to force a re-render once a second so
  // `secondsUntilResend` (evaluated fresh against the real clock every
  // render) counts down and the button re-enables on its own, the same way
  // VerifyEmailSheet's own countdown does.
  const [, setResendTick] = useState(0);
  useEffect(() => {
    if (emailVerifyState === 'verified') return undefined;
    const id = setInterval(() => setResendTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [emailVerifyState]);
  const bannerResendDisabled = emailVerifyState !== 'verified'
    && secondsUntilResend(owner?.email_verify_sent_at) > 0;
  // Platform-admin (Gabe / Victor / Standard Vending) — gets admin-only surfaces.
  // Sourced from the JWT claim issued by /auth/login. Never set this from
  // partner-controlled state.
  const isPlatformAdmin = (() => {
    if (viewAs) return false;
    // Prefer the in-memory owner object (server-fresh from /auth/login or
    // the /auth/me self-heal above). Fall back to JWT-decode for the
    // first render before the owner state is hydrated.
    if (owner?.is_platform_admin === true) return true;
    if (owner?.is_platform_admin === false) return false;
    try {
      const tok = JSON.parse(localStorage.getItem('lotlogic_session') || '{}')._token;
      if (!tok) return false;
      const p = JSON.parse(atob(tok.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
      return !!p.is_platform_admin;
    } catch { return false; }
  })();

  // When viewing as a partner, filter lots/violations to that partner's lots
  const effectiveUser = viewAs ? { ...viewAs, _role: 'partner' } : owner;

  const viewAsLotIdsEarly = viewAs ? lots.filter(l => l.partner_id === viewAs.id).map(l => l.id) : null;
  // SaaS accounts (all-apartment, e.g. N Style + the apartment owners) have no
  // per-tow money flow: no legacy `lots` rows → no Earnings/Billing tabs, no
  // fee-schedule editor. Platform admins always see money surfaces; in
  // View-as-Partner the check runs against the impersonated partner's lots so
  // the admin sees exactly what that partner sees. No new flag anywhere —
  // "has zero legacy lots" IS the SaaS derivation (spec 2026-08-12).
  const showMoney = (isPlatformAdmin && !viewAs)
    || (viewAsLotIdsEarly ? viewAsLotIdsEarly.length > 0 : (lots || []).length > 0);

  // ── Bottom nav ─────────────────────────────────────────────
  // Base nav from the role + `/auth/me.properties` (spec §5: an account whose
  // every property has `features.cameras=false` gets Properties · Account,
  // tab id `lots`; any camera brings back the five). The account-specific
  // extras — money surfaces, the platform-admin consoles, Frank's app preview
  // — splice in ahead of Account, which stays last.
  const navExtras = isOwner
    ? [
      // SaaS (all-apartment) owners have no per-tow money flow — see showMoney.
      ...(showMoney ? [
        { id: 'earnings', label: 'Earnings' },
        { id: 'invoices', label: 'Billing' },
      ] : []),
      // Platform-admin only: the internal console (clients / onboard /
      // feedback) folded in from admin.html, Frank's app-preview tab for QA
      // before the partner-side entry (below) is switched on, and the fleet
      // status board (Task 23). Each is gated again at render.
      ...(isPlatformAdmin ? [
        { id: 'admin', label: 'Admin' },
        { id: 'app', label: 'App' },
        { id: 'hq', label: 'HQ' },
      ] : []),
    ]
    : [
      // NMLD only: live preview of Frank's NMLD Parking app. Held behind
      // FRANK_APP_TAB_LIVE until Gabe signs off on the admin-side QA pass.
      ...((FRANK_APP_TAB_LIVE && (viewAs?.id || owner?.id) === NMLD_PARTNER_ID) ? [{ id: 'app', label: 'App' }] : []),
    ];
  const navTabs = (() => {
    const base = navTabsFor(isOwner ? 'owner' : 'partner', properties, { partnerRequestsReady });
    const account = base.filter(t => t.id === 'account');
    return [...base.filter(t => t.id !== 'account'), ...navExtras, ...account];
  })();
  // Overview has no nav button (it is reached from the cards) but is a real
  // owner tab, so it stays valid.
  const validTabs = isOwner ? ['overview', ...navTabs.map(t => t.id)] : navTabs.map(t => t.id);

  useEffect(() => {
    if (!owner) return;
    // Don't coerce until lots have actually loaded once — showMoney is false
    // until then, and coercing a persisted 'earnings' tab away during that
    // window would bounce a legitimate legacy owner to Lots (and the
    // tab-persistence effect would write the bounce back to localStorage).
    // The transient `loading` flag is NOT a safe guard here: on mount this
    // effect fires before the loadData effect ever sets loading=true.
    if (!lotsLoaded) return;
    if (!validTabs.includes(tab)) setTab('lots');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, viewAs, isOwner, isPlatformAdmin, tab, showMoney, lotsLoaded, validTabs.join(',')]);

  // Apply the deep link, once, as soon as there is a session. Deliberately not
  // while signed out: the query has to survive the sign-in (LoginPage replays
  // it), and cleaning it then would throw away the request the email named.
  // `tab` wins when it names a real tab; otherwise a `property` link means
  // Lots, because that is where the property page lives. `verify` (the code
  // email's `/app?verify=1`, spec §5.9) opens VerifyEmailSheet directly — the
  // rest (`section`, `request`, `firstrun`, `upload`) travel down to the
  // Lots page as props.
  const deepLinkAppliedRef = useRef(false);
  useEffect(() => {
    if (!owner || deepLinkAppliedRef.current) return;
    deepLinkAppliedRef.current = true;
    if (deepLink.tab && KNOWN_TAB_IDS.includes(deepLink.tab)) setTab(deepLink.tab);
    else if (deepLink.property) setTab('lots');
    if (deepLink.verify) openVerifySheet({ mode: 'code', fromWall: false });
    cleanDeepLink();
  }, [owner, deepLink, openVerifySheet]);
  const viewAsLotIds = viewAsLotIdsEarly;
  const effectiveLots = viewAsLotIds ? lots.filter(l => viewAsLotIds.includes(l.id)) : lots;
  const effectiveViolations = viewAsLotIds ? violations.filter(v => viewAsLotIds.includes(v.lot_id)) : violations;
  const effectiveLotStates = viewAsLotIds
    ? Object.fromEntries(Object.entries(lotStates).filter(([id]) => viewAsLotIds.includes(id)))
    : lotStates;

  const realtimeRef = useRef(null);
  const loadIdRef = useRef(0); // Guard against race conditions in concurrent loadData calls

  const loadData = useCallback(async (o, silent = false) => {
    if (!o) return;
    const myId = ++loadIdRef.current; // Each call gets a unique ID
    if (!silent) setLoading(true);
    try {
      const filter = o._role === 'partner'
        ? { partner_id: o.id }
        : { owner_id: o.id };
      const lotsData = await db.getLots(filter);
      if (loadIdRef.current !== myId) return; // Stale call, discard
      setLots(lotsData);
      setLotsLoaded(true);

      // Fetch enforcement partners across both lots.partner_id and
      // properties.tow_company_id so ALPR-only properties (no lots row)
      // still surface their tow operator in the partner switcher.
      if (o._role === 'owner') {
        // Platform admins see every property, including apartment lots owned by
        // leasing offices — so pull partners across ALL properties (getAllPartnersForAdmin)
        // to surface e.g. N Style Towing in "View as Partner". Regular owners
        // stay scoped to their own properties' partners.
        (o.is_platform_admin ? db.getAllPartnersForAdmin() : db.getPartnersForOwner(o.id))
          .then(p => setPartners(p)).catch(() => {});
      }

      const [states, violsArrays] = await Promise.all([
        Promise.all(lotsData.map(l => db.getLotState(l.id).then(s => [l.id, s]).catch(() => [l.id, null]))),
        Promise.all(lotsData.map(l => db.getViolations(l.id).catch(() => []))),
      ]);
      if (loadIdRef.current !== myId) return; // Stale call, discard

      setLotStates(Object.fromEntries(states));

      const flat = [];
      lotsData.forEach((lot, i) => {
        const data = violsArrays[i];
        const items = Array.isArray(data) ? data : (data?.items || []);
        items.forEach(v => flat.push({ ...v, lot_id: v.lot_id || lot.id }));
      });
      setViolations(flat);

      // Load ALPR violations (all statuses for Jobs page + Passes tab)
      db.getAllALPRViolations(o.id, null, o._role).then(v => setAlprViolations(v)).catch(() => {});

      setLastRefresh(new Date());
    } catch (e) {
      console.error(e);
      if (!silent) addToast('Failed to load data. Check your connection.', 'error');
    }
    finally { if (!silent) setLoading(false); }
  }, [addToast]);

  function login(o) {
    const session = { ...o, _ts: Date.now() };
    setOwner(session);
    try { localStorage.setItem('lotlogic_session', JSON.stringify(session)); } catch {}
    applySupabaseAuth(session._token);
    loadData(session);

    // Partners: enrich the in-memory user with their fee + plate fields so the
    // PartnerFeeEditor and the "add tow-truck plates" nudge render against
    // real data instead of placeholders. Backend's GET /partners/me strips
    // these fields by design (PartnerSelfResponse), so go straight to
    // Supabase — column-level RLS allows the partner to SELECT their own row.
    if (session._role === 'partner' && supabase && session.id) {
      supabase
        .from('enforcement_partners')
        .select('tow_fee, boot_fee, tow_truck_plates')
        .eq('id', session.id)
        .maybeSingle()
        .then(({ data, error }) => {
          if (error || !data) return;
          const merged = { ...session, ...data, _ts: Date.now() };
          setOwner(merged);
          try { localStorage.setItem('lotlogic_session', JSON.stringify(merged)); } catch {}
        });
    }
  }

  function logout() {
    loadIdRef.current++; // Invalidate any in-flight loadData calls
    clearInterval(timerRef.current);
    if (realtimeRef.current) { supabase?.removeChannel(realtimeRef.current); realtimeRef.current = null; }
    if (alprRealtimeRef.current) { supabase?.removeChannel(alprRealtimeRef.current); alprRealtimeRef.current = null; }
    setOwner(null); setLots([]); setLotsLoaded(false); setLotStates({}); setViolations([]); setAlprViolations([]); setPartners([]); setViewAs(null);
    setTab('lots');
    try { localStorage.removeItem('lotlogic_session'); localStorage.removeItem('lotlogic_email'); } catch {}
  }

  // Pull-to-refresh handler
  async function handlePullRefresh() {
    if (refreshing || !owner) return;
    setRefreshing(true);
    haptic('medium');
    await loadData(owner, true);
    setRefreshing(false);
    haptic('light');
  }

  // Pull-to-refresh gesture
  const touchStartY = useRef(0);
  const pullDistance = useRef(0);
  const [showPTR, setShowPTR] = useState(false);
  useEffect(() => {
    if (!owner) return;
    const el = document.querySelector('.page-content');
    if (!el) return;
    function onTouchStart(e) { if (el.scrollTop <= 0) touchStartY.current = e.touches[0].clientY; else touchStartY.current = 0; }
    function onTouchMove(e) {
      if (!touchStartY.current) return;
      pullDistance.current = e.touches[0].clientY - touchStartY.current;
      if (pullDistance.current > 60 && el.scrollTop <= 0) setShowPTR(true);
    }
    function onTouchEnd() {
      if (showPTR || pullDistance.current > 80) handlePullRefresh();
      touchStartY.current = 0; pullDistance.current = 0; setShowPTR(false);
    }
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
    };
  }); // eslint-disable-line -- intentionally re-runs to capture latest handlePullRefresh/showPTR

  // Unreviewed inferred_plate_pairs count — drives the Training tab badge.
  // Refreshed every 60s so it tracks the cron-plate-pair-learn output.
  // Owner-only; partners never see this tab.
  const [trainingBadge, setTrainingBadge] = useState(0);
  useEffect(() => {
    if (!owner) return;
    let cancelled = false;
    async function refreshTrainingBadge() {
      try {
        // Must mirror the tab's default "unverified" filter exactly
        // (dismissed_at IS NULL AND verified_at IS NULL). Counting only on
        // dismissed_at meant every pair the operator verified stayed in the
        // badge forever — the badge read "40" while the tab it pointed at
        // said "Nothing to review", so operators learned to ignore it.
        const { count, error } = await supabase
          .from('inferred_plate_pairs')
          .select('id', { count: 'exact', head: true })
          .is('dismissed_at', null)
          .is('verified_at', null);
        if (!error && !cancelled) setTrainingBadge(count || 0);
      } catch { /* ignore */ }
    }
    refreshTrainingBadge();
    const t = setInterval(refreshTrainingBadge, 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [owner]);

  // Load data on mount if session was restored
  useEffect(() => { if (owner) loadData(owner); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Retry on reconnect
  useEffect(() => { if (reconnected && owner) loadData(owner, true); }, [reconnected]);

  // Auto-refresh + session expiration check
  useEffect(() => {
    if (!owner) return;
    if (!autoRefresh) { clearInterval(timerRef.current); return; }
    timerRef.current = setInterval(() => {
      // Check session expiration (7 days)
      if (owner._ts && Date.now() - owner._ts > 7 * 86400000) {
        addToast('Session expired. Please log in again.', 'error');
        logout();
        return;
      }
      if (navigator.onLine) loadData(owner, true);
    }, refreshInterval);
    return () => clearInterval(timerRef.current);
  }, [owner, loadData, autoRefresh, refreshInterval]);

  // Fast snapshot poll (every 10s) — refreshes latest_snapshot for cameras with active violations
  // so departure banners on cards update without waiting for the full 30s loadData cycle.
  // `violations` is read through a ref, NOT the dependency array: it's a new array
  // on every load, so depending on it tore the interval down and re-ran an
  // immediate all-camera poll on every refresh/realtime event — a request
  // amplifier stacked on top of the 30s loadData cycle. The ref keeps one
  // stable 10s cadence while activeCamIds() always sees current violations.
  const violationsRef = React.useRef(violations);
  violationsRef.current = violations;
  useEffect(() => {
    if (!supabase || !owner) return;
    const activeCamIds = () => {
      const pending = violationsRef.current.filter(v => ['pending', 'alerted', 'acknowledged'].includes(v.status));
      return [...new Set(pending.map(v => v.camera_id).filter(Boolean))];
    };
    const pollSnapshots = async () => {
      const camIds = activeCamIds();
      if (camIds.length === 0) return;
      try {
        const results = await Promise.all(camIds.map(cid =>
          supabase.from('snapshots')
            .select('camera_id, storage_url, url, raw_detections, captured_at, vehicles_detected')
            .eq('camera_id', cid)
            .order('captured_at', { ascending: false })
            .limit(1)
            .then(r => r.data?.[0] || null)
        ));
        setLotStates(prev => {
          const next = { ...prev };
          let changed = false;
          for (const [lotId, state] of Object.entries(next)) {
            if (!state?.cameras) continue;
            const updatedCams = state.cameras.map(cam => {
              const snap = results.find(r => r && r.camera_id === cam.camera_id);
              if (!snap) return cam;
              const base = snap.storage_url || snap.url;
              const newCaptured = snap.captured_at;
              // Only update if we have a newer snapshot
              if (cam.latest_snapshot?.captured_at && newCaptured && new Date(newCaptured) <= new Date(cam.latest_snapshot.captured_at)) return cam;
              changed = true;
              return {
                ...cam,
                latest_snapshot: {
                  url: base ? base + (base.includes('?') ? '&' : '?') + '_t=' + Date.now() : null,
                  captured_at: newCaptured,
                  vehicles_detected: snap.vehicles_detected || 0,
                  people_detected: 0,
                  plates_read: 0,
                  plate_readings: [],
                  detections: snap.raw_detections?.detections?.map((d, i) => ({
                    id: `det_${i}`,
                    type: d.class === 'person' ? 'person' : 'vehicle',
                    bbox: d.bbox ? { x: d.bbox[0] * 100, y: d.bbox[1] * 100, w: (d.bbox[2] - d.bbox[0]) * 100, h: (d.bbox[3] - d.bbox[1]) * 100 } : null,
                    confidence: d.conf,
                    label: d.class,
                  })) || [],
                },
              };
            });
            if (changed) next[lotId] = { ...state, cameras: updatedCams };
          }
          return changed ? next : prev;
        });
      } catch (e) { console.warn('Fast snapshot poll error:', e); }
    };
    pollSnapshots(); // run immediately on mount, don't wait 10s
    const iv = setInterval(pollSnapshots, 10000);
    return () => clearInterval(iv);
  }, [owner]);

  // Subscribe to realtime violation changes
  useEffect(() => {
    if (!owner || lots.length === 0) return;
    const lotIds = lots.map(l => l.id);
    // Debounce burst events (e.g. zone-guardian bulk updates) — collapse any
    // payloads that arrive within 800ms into a single loadData call. Previously
    // every event fired a full lots + properties(id) refetch, which showed up
    // as a 15+ query storm during zone re-evaluation.
    let refreshTimer = null;
    const channel = db.subscribeViolations(lotIds, (payload) => {
      if (payload.eventType === 'INSERT' && payload.new?.status === 'alerted') {
        NotifyManager.notifyNewViolation(payload.new);
      }
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => { loadData(owner, true); }, 800);
    }, (errStatus) => {
      addToast('Live updates disconnected. Data refreshes every 30s.', 'error');
    });
    realtimeRef.current = channel;
    return () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      if (channel) supabase?.removeChannel(channel);
    };
  }, [owner, lots.length, loadData, addToast]);

  // Subscribe to ALPR violation changes
  const alprRealtimeRef = useRef(null);
  useEffect(() => {
    if (!owner) return;
    let active = true;
    let refreshTimer = null;
    db.getProperties(owner.id, owner._role).then(props => {
      if (!active || !props || props.length === 0) return;
      const propIds = props.map(p => p.id);
      if (alprRealtimeRef.current) supabase?.removeChannel(alprRealtimeRef.current);
      const ch = db.subscribeALPRViolations(propIds, () => {
        if (!active) return;
        // Debounce bursts — collapse rapid plate-event / violation updates into
        // one refetch so we don't hammer /alpr_violations + /properties(id).
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
          if (!active) return;
          db.getAllALPRViolations(owner.id, null, owner._role).then(v => { if (active) setAlprViolations(v); }).catch(() => {});
        }, 800);
      });
      alprRealtimeRef.current = ch;
    }).catch(() => {});
    return () => {
      active = false;
      if (refreshTimer) clearTimeout(refreshTimer);
      if (alprRealtimeRef.current) supabase?.removeChannel(alprRealtimeRef.current);
    };
  }, [owner]);

  // Same theme root the rest of the app renders under (see the `.app` div
  // below) — without it, `.theme-light .login-page` etc. never match and
  // the login page ignores the operator's theme choice.
  if (!owner) {
    // `publicRoute` is the no-session switch for the two paths `vercel.json`
    // rewrites into this bundle. Both render the sign-in form today:
    //   'join'           → Task 25 swaps in <SignupPage slug onDone={login}/>;
    //                      until then the form's "New property? Create your
    //                      account" link is the door, so /join is never a
    //                      dead end.
    //   'request-action' → Task 29 swaps in the /r/<token> page; the spec's
    //                      own fallback copy for a token this page cannot use
    //                      is "Sign in to manage the hold", which is exactly
    //                      what the form offers.
    const PublicPage = publicRoute ? PUBLIC_ROUTE_PAGES[publicRoute] : null;
    return (
      <div className={`app ${theme === 'dark' ? '' : 'theme-light'}`}>
        {PublicPage
          ? <PublicPage route={publicRoute} slug={publicSlug} onDone={login} onLogin={login} />
          : <LoginPage onLogin={login} />}
      </div>
    );
  }

  // A signed-in manager opening someone else's `/join/<slug>` link gets the
  // add-property form, not the sign-in form (spec §3.2). Until Task 25
  // registers that page the dashboard renders as usual, and the Add a property
  // button on Lots is the door.
  const SignedInPublicPage = publicRoute === 'join' ? PUBLIC_ROUTE_PAGES_SIGNED_IN[publicRoute] : null;
  if (SignedInPublicPage) {
    return (
      <div className={`app ${theme === 'dark' ? '' : 'theme-light'}`}>
        <SignedInPublicPage route={publicRoute} slug={publicSlug} mode="add-property" user={owner} />
      </div>
    );
  }

  const pending = effectiveViolations.filter(v => ['pending', 'alerted', 'acknowledged'].includes(v.status)).length;
  const alprPending = alprViolations.filter(v => v.status === 'pending').length;

  // Handle "View as Partner" — entry point from Overview cards or header switcher
  function handleViewAs(partner) {
    setViewAs(partner);
    setPartnerSwitcherOpen(false);
    setTab('lots');
    haptic('medium');
  }
  function exitViewAs() {
    setViewAs(null);
    setPartnerSwitcherOpen(false);
    setTab('overview');
    haptic('light');
  }

  // Owner-side partners list — `partners` is already scoped to this owner
  // by getPartnersForOwner (covers both lots.partner_id and
  // properties.tow_company_id assignments). Just gate on role.
  const ownPartners = isOwner ? partners : [];

  // Role-based navigation:
  // Owner:    Overview + Jobs + Lots + Earnings + Invoices + Account
  // Operator (or viewing-as): Jobs + Lots + Activity + Earnings + Account
  const NavIconInvoices = () => React.createElement('svg', {width:22,height:22,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.8,strokeLinecap:'round',strokeLinejoin:'round'}, React.createElement('path', {d:'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z'}), React.createElement('polyline', {points:'14 2 14 8 20 8'}), React.createElement('line', {x1:'8',y1:'13',x2:'16',y2:'13'}), React.createElement('line', {x1:'8',y1:'17',x2:'12',y2:'17'}));
  const NavIconAnalytics = () => React.createElement('svg', {width:22,height:22,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.8,strokeLinecap:'round',strokeLinejoin:'round'}, React.createElement('line', {x1:'18',y1:'20',x2:'18',y2:'10'}), React.createElement('line', {x1:'12',y1:'20',x2:'12',y2:'4'}), React.createElement('line', {x1:'6',y1:'20',x2:'6',y2:'14'}));
  const NavIconTow = () => React.createElement('svg', {width:22,height:22,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.8,strokeLinecap:'round',strokeLinejoin:'round'}, React.createElement('path', {d:'M10 17h4V5H2v12h3'}), React.createElement('path', {d:'M20 17h2v-3.34a4 4 0 0 0-1.17-2.83L19 9h-5'}), React.createElement('circle', {cx:'7.5',cy:'17.5',r:'2.5'}), React.createElement('circle', {cx:'17.5',cy:'17.5',r:'2.5'}));
  const NavIconAdmin = () => React.createElement('svg', {width:22,height:22,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.8,strokeLinecap:'round',strokeLinejoin:'round'}, React.createElement('path', {d:'M12 2l7 4v6c0 4.4-3 7.5-7 9-4-1.5-7-4.6-7-9V6z'}));
  const NavIconLookup = () => React.createElement('svg', {width:22,height:22,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.8,strokeLinecap:'round',strokeLinejoin:'round'}, React.createElement('circle', {cx:'11',cy:'11',r:'7'}), React.createElement('line', {x1:'21',y1:'21',x2:'16.65',y2:'16.65'}));
  const NavIconApp = () => React.createElement('svg', {width:22,height:22,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.8,strokeLinecap:'round',strokeLinejoin:'round'}, React.createElement('rect', {x:'6.5',y:'2.5',width:'11',height:'19',rx:'2.5'}), React.createElement('line', {x1:'10.5',y1:'18.5',x2:'13.5',y2:'18.5'}));
  const NavIconHq = () => React.createElement('svg', {width:22,height:22,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.8,strokeLinecap:'round',strokeLinejoin:'round'}, React.createElement('rect', {x:'4',y:'10',width:'7',height:'11'}), React.createElement('rect', {x:'13',y:'4',width:'7',height:'17'}), React.createElement('line', {x1:'4',y1:'21',x2:'20',y2:'21'}));
  const navIcons = { app: NavIconApp, overview: NavIconOverview, jobs: NavIconJobs, lots: NavIconLots, earnings: NavIconEarnings, invoices: NavIconInvoices, activity: NavIconActivity, account: NavIconAccount, analytics: NavIconAnalytics, training: NavIconAnalytics, towactivity: NavIconTow, admin: NavIconAdmin, lookup: NavIconLookup, hq: NavIconHq };
  // Tab roles (kept intentionally narrow so each surface has one meaning):
  //   Jobs     → every violation needing action (enforcement + ALPR unified)
  //   Lots     → register + manage properties (plates, passes, cameras, plate detections)
  //   Analytics/Activity → summaries
  //   Earnings → $$
  // Badges hang off the base nav computed above (the Training badge is the
  // only live one today).
  const navTabsWithBadges = navTabs.map(t => ({ ...t, badge: t.id === 'training' ? trainingBadge : 0 }));

  const lastRefreshLabel = lastRefresh ? (
    Math.floor((Date.now() - lastRefresh) / 1000) < 10 ? 'Just now' :
    Math.floor((Date.now() - lastRefresh) / 1000) < 60 ? `${Math.floor((Date.now() - lastRefresh) / 1000)}s ago` :
    `${Math.floor((Date.now() - lastRefresh) / 60000)}m ago`
  ) : null;

  return (
    <div className={`app ${theme === 'dark' ? '' : 'theme-light'}`}>
      {/* Offline / reconnected banners */}
      {!online && <div className="offline-banner" role="alert">You're offline — data may be stale</div>}
      {reconnected && online && <div className="reconnected-banner" role="status">Back online — refreshing data</div>}

      <header className="header" role="banner">
        <div className="header-left">
          <div className="header-shield" aria-hidden="true">LL</div>
          <div className="header-wordmark">Lot<span>Logic</span></div>
        </div>
        <div className="header-right">
          <button
            className={`theme-toggle-btn ${theme === 'light' ? 'light' : ''}`}
            onClick={() => { toggleTheme(); haptic('light'); }}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          />
          {lastRefresh && (
            <div className={`conn-indicator ${online ? 'online' : 'offline'}`} title={lastRefreshLabel ? `Updated ${lastRefreshLabel}` : ''}>
              <span className={`conn-dot ${online ? 'on' : 'off'}`} />
              <span>{online ? (supabase ? 'Live' : 'Online') : 'Offline'}</span>
            </div>
          )}
          {isOwner && ownPartners.length > 0 && (
            <div style={{position:'relative'}}>
              <button
                onClick={() => setPartnerSwitcherOpen(o => !o)}
                aria-haspopup="menu"
                aria-expanded={partnerSwitcherOpen}
                title="Open one of your partners' portals"
                style={{
                  background:'rgba(167,139,250,.12)', color:'#a78bfa',
                  border:'1px solid rgba(167,139,250,.3)', borderRadius:8,
                  padding:'6px 10px', fontSize:12, fontWeight:700,
                  cursor:'pointer', whiteSpace:'nowrap',
                  display:'inline-flex', alignItems:'center', gap:6,
                }}
              >
                View as Partner
                <span style={{fontSize:10, opacity:.7}}>▾</span>
              </button>
              {partnerSwitcherOpen && (
                <>
                  <div
                    onClick={() => setPartnerSwitcherOpen(false)}
                    style={{position:'fixed', inset:0, zIndex:90}}
                    aria-hidden="true"
                  />
                  <div
                    role="menu"
                    style={{
                      position:'absolute', top:'calc(100% + 6px)', right:0, zIndex:91,
                      background:'var(--bg-card)', border:'1px solid var(--border)',
                      borderRadius:10, minWidth:240, maxWidth:320,
                      boxShadow:'0 10px 30px rgba(0,0,0,.35)', padding:6,
                    }}
                  >
                    <div style={{
                      fontSize:10, fontWeight:700, color:'var(--text-faint)',
                      textTransform:'uppercase', letterSpacing:'.05em',
                      padding:'8px 10px 4px',
                    }}>
                      Open partner portal
                    </div>
                    {ownPartners.map(p => (
                      <button
                        key={p.id}
                        role="menuitem"
                        onClick={() => handleViewAs(p)}
                        style={{
                          display:'block', width:'100%', textAlign:'left',
                          background:'transparent', color:'var(--text-primary)',
                          border:'none', borderRadius:6, padding:'8px 10px',
                          fontSize:13, fontWeight:600, cursor:'pointer',
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,.06)'}
                        onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                      >
                        <div>{p.company_name || p.contact_name}</div>
                        {p.email && <div style={{fontSize:11, color:'var(--text-faint)', marginTop:2}}>{p.email}</div>}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
          <div className="header-name" title={owner.business_name || owner.contact_name}>{owner.business_name || owner.contact_name}</div>
        </div>
      </header>

      {/* Confirm-your-email banner/wall (spec §3.5) — mounted above the page
          content, not inside it, so it stays put across tab switches and
          never scrolls away with the page it's gating. 'unverified' is the
          banner; 'walled' (day 7) is the wall — same three actions, heavier
          copy, no implicit dismiss either way. */}
      {emailVerifyState !== 'verified' && (
        <VerifyBanner
          variant={emailVerifyState === 'walled' ? 'wall' : 'banner'}
          email={owner.email}
          onEnterCode={() => openVerifySheet({ mode: 'code', fromWall: emailVerifyState === 'walled' })}
          onChangeEmail={() => openVerifySheet({ mode: 'changeEmail', fromWall: emailVerifyState === 'walled' })}
          onResend={handleBannerResend}
          resendDisabled={bannerResendDisabled}
        />
      )}

      <main id="main-content" className="page-content" role="main">
        {/* "Viewing as Partner" banner */}
        {viewAs && (
          <div style={{
            background:'linear-gradient(90deg, rgba(167,139,250,.15), rgba(59,130,246,.1))',
            border:'1px solid rgba(167,139,250,.3)', borderRadius:10, margin:'0 0 12px',
            padding:'10px 14px', display:'flex', alignItems:'center', justifyContent:'space-between',
          }}>
            <div>
              <div style={{fontSize:12, fontWeight:700, color:'#a78bfa', textTransform:'uppercase', letterSpacing:'.05em'}}>Viewing as Partner</div>
              <div style={{fontSize:14, fontWeight:800, color:'var(--text-primary)', marginTop:2}}>{viewAs.company_name || viewAs.contact_name}</div>
            </div>
            <button onClick={exitViewAs} style={{
              background:'rgba(255,255,255,.1)', color:'var(--text-primary)', border:'1px solid var(--border)',
              borderRadius:8, padding:'6px 14px', fontSize:12, fontWeight:700, cursor:'pointer',
            }}>
              Exit
            </button>
          </div>
        )}

        {/* Pull to refresh indicator */}
        {(showPTR || refreshing) && (
          <div className="ptr-spinner" role="status" aria-label="Refreshing">
            <span className="spin" />{refreshing ? 'Refreshing…' : 'Release to refresh'}
          </div>
        )}
        {/* Last updated */}
        {lastRefresh && !loading && (
          <div className="last-updated" aria-live="polite">Updated {lastRefreshLabel}</div>
        )}

        <div key={tab + (viewAs?.id || '')} className="page-slide">
          <React.Suspense fallback={<SkeletonCards />}>
          {tab === 'overview' && isOwner && !viewAs && <OverviewPage violations={violations} lots={lots} partners={partners} lotStates={lotStates} onViewAs={handleViewAs} />}
          {tab === 'jobs' && <JobsPage lots={effectiveLots} violations={effectiveViolations} alprViolations={alprViolations} loading={loading} lotStates={effectiveLotStates} onAction={() => loadData(owner, true)} isOwner={isOwner} deepLinkViolationId={deepLinkViolationId} user={effectiveUser} onNavigate={setTab} />}
          {tab === 'lots' && <ALPRPropertiesPage
            user={effectiveUser}
            impersonating={!!viewAs}
            initialSelectedId={deepLink.property}
            initialSection={deepLink.section}
            request={deepLink.request}
            upload={deepLink.upload}
            firstrun={deepLink.firstrun}
            verify={deepLink.verify}
            onNeedVerify={onNeedVerify}
          />}
          {tab === 'training' && isOwner && <TrainingPage user={effectiveUser} isOwner={isOwner} />}
          {tab === 'towactivity' && isOwner && <TowActivityPage user={effectiveUser} />}
          {tab === 'earnings' && isOwner && showMoney && <EarningsPage violations={effectiveViolations} lots={effectiveLots} isOwner={isOwner} user={effectiveUser} onNavigate={setTab} />}
          {tab === 'analytics' && isOwner && <AnalyticsPage lots={lots} violations={violations} partners={partners} isOwner={isOwner} onNavigate={setTab} />}
          {tab === 'invoices' && isOwner && showMoney && <InvoicesPage lots={lots} partners={partners} user={owner} isOwner={isOwner} isPlatformAdmin={isPlatformAdmin} />}
          {tab === 'admin' && isPlatformAdmin && <AdminConsolePage user={owner} />}
          {tab === 'hq' && isPlatformAdmin && <HqPage />}
          {tab === 'lookup' && isOperator && <PlateLookupPage user={effectiveUser} />}
          {tab === 'app' && (isPlatformAdmin || (FRANK_APP_TAB_LIVE && isOperator && (viewAs?.id || owner?.id) === NMLD_PARTNER_ID)) && <PartnerAppPage />}
          {tab === 'activity' && isOperator && <OperatorActivityPage violations={effectiveViolations} lots={effectiveLots} />}
          {tab === 'account' && <AccountPage user={effectiveUser} isImpersonating={!!viewAs} onLogout={logout} autoRefresh={autoRefresh} setAutoRefresh={setAutoRefresh} refreshInterval={refreshInterval} setRefreshInterval={setRefreshInterval} showFees={showMoney} isPlatformAdmin={isPlatformAdmin} />}
          </React.Suspense>
        </div>
      </main>

      <nav className="bottom-nav" role="navigation" aria-label="Main navigation">
        {/* Each button carries role="tab"; axe's aria-required-parent rule needs
            that role contained by role="tablist". The outer <nav> keeps its
            navigation landmark, so the tablist role goes on this wrapper —
            display:contents keeps it out of the flex layout .bottom-nav relies
            on for its direct children. */}
        <div role="tablist" aria-label="Main navigation" style={{display: 'contents'}}>
          {navTabsWithBadges.map(t => {
            const Icon = navIcons[t.id];
            return (
              <button key={t.id}
                className={`nav-item ${tab === t.id ? 'active' : ''}`}
                // Tapping a tab by hand retires the deep link: coming back to
                // Lots should show the list, not re-open the property the
                // email named half an hour ago.
                onClick={() => { clearDeepLink(); setTab(t.id); haptic('light'); }}
                aria-label={`${t.label}${t.badge > 0 ? `, ${t.badge} pending` : ''}`}
                aria-current={tab === t.id ? 'page' : undefined}
                role="tab"
                aria-selected={tab === t.id}
              >
                {t.badge > 0 && <span className="nav-badge" aria-hidden="true">{t.badge}</span>}
                {Icon && <Icon />}
                <span className="nav-label">{t.label}</span>
              </button>
            );
          })}
        </div>
      </nav>

      <VerifyEmailSheet
        open={verifySheetOpen}
        email={owner.email}
        sentAt={owner.email_verify_sent_at}
        mode={verifySheetMode}
        fromWall={verifyFromWall}
        onClose={closeVerifySheet}
        onSuccess={handleVerifySuccess}
        onEmailChanged={handleEmailChanged}
        onSignOut={logout}
      />
    </div>
  );
}
