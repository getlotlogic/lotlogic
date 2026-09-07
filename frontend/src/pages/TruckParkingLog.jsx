import React, { useState, useEffect, useCallback, useRef, useMemo, memo } from 'react';
import { fmtMoney, fmtTime, fmtDateTime } from '../lib/format.js';
import { supabase } from '../lib/supabase.js';
import { API } from '../lib/api.js';
import { db } from '../lib/db.js';
import { useActiveRoster, useIntervalFetch } from '../hooks.js';
import { useToast } from '../ui/Toast.jsx';
import { ConfirmActionModal } from '../ui/Dialog.jsx';
import { CooldownChip, ReregTowFlag, PassPhotoStrip } from '../ui/passPhotos.jsx';

export function TruckParkingLog({ propertyId, propertyType, payToParkEnabled = false, isOwner = false, mode = 'default' }) {
  // mode='history' → the permanent, all-time record (no date lower bound): every
  // registration ever, all statuses, searchable + CSV. 'default' = the live ops
  // log (last 4 days). Same machinery either way.
  const isHistory = mode === 'history';
  const { addToast } = useToast();
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  // PARITY FIX (2026-06-03): the backend /visitor_passes/parking-log
  // endpoint silently filters out passes that the ActivePassTracker's
  // direct Supabase query returns — operator searched a real active pass
  // here, got 0 hits, towed it. To guarantee parity with what the Active
  // list shows, we ALSO fetch directly from Supabase (same query the
  // ActivePassTracker uses) and merge the union into the search pool.
  // This means: if a pass appears in Active + Violations, it's
  // guaranteed to appear in Parking Log search.
  // THE single source of truth for the registered roster — shared with the
  // Registered drill-down and the Lots "Registered" count via useActiveRoster,
  // so all three always show identical data. Realtime updates, a 60s safety
  // poll, and keep-last-on-error all live inside the hook. The backend parking
  // log (below) is used ONLY for history/search and is purely additive — it can
  // never subtract from this roster.
  const { roster: activeRoster, error: rosterError, refresh: refreshRoster } = useActiveRoster(propertyId);
  // Backend-side filters: date range + status. Changes require an Apply because
  // they refetch from the server. Search text is separate state below and is
  // pure client-side (live filter on already-fetched rows).
  // LOCAL calendar date, not toISOString().slice(0,10) — that's the UTC date,
  // which after ~8pm Eastern is already tomorrow. The UTC version shifted
  // date_from a day forward every evening, trimming the earliest local day
  // off the 4-day ops window right when the night shift was using it.
  const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const [filters, setFilters] = useState(() => {
    const today = new Date();
    // History mode = the permanent record: NO lower bound (empty date_from →
    // backend returns all-time), so nothing is ever dropped/forgotten.
    if (isHistory) {
      return { date_from: '', date_to: localDay(today), status: '' };
    }
    // Default ops view: last 4 days. Older passes are historical and clutter
    // the working queue (and live in the History tab). Adjustable via date_from.
    const fourDaysAgo = new Date(today.getTime() - 4 * 24 * 60 * 60 * 1000);
    return {
      date_from: localDay(fourDaysAgo),
      date_to: localDay(today),
      status: '',
    };
  });
  // Live search text. Drives client-side substring matching across every
  // field a driver enters on the QR form (plate, name, company, phone,
  // parking spot, reference ID). Updates as the operator types —
  // no Apply, no debounce. The filter runs against rows already in memory.
  const [searchText, setSearchText] = useState('');
  const [cancelModal, setCancelModal] = useState(null); // { id, plate_text } | null
  const [cancelling, setCancelling] = useState(false);
  const [exporting, setExporting] = useState(false);
  // Pay-to-park counters (GET /plaza/summary). null until the endpoint answers,
  // and back to null on any error — a lot that isn't taking payments, an older
  // backend, or a viewer the endpoint won't answer for must all render exactly
  // the page that existed before pay-to-park, not an error.
  const [paySummary, setPaySummary] = useState(null);
  // Three conditions, and each one is load-bearing:
  //   truck_plaza          — apartments have no paid flow at all;
  //   pay_to_park_enabled  — a plaza that hasn't been switched on has no
  //                          payments, and "Today: 0 passes · $0.00 collected"
  //                          on the live Charlotte lot reads as a broken till,
  //                          not as an accurate zero;
  //   not History          — this component is mounted TWICE (the ops log and
  //                          the all-time History), and with the section filter
  //                          on "all" both are on screen: ungated, the strip
  //                          and the stat would render twice and the summary
  //                          would be fetched twice on every poll.
  // Gating the FETCH on all three (rather than only the render) is what keeps
  // the doubled request from happening at all. `paySummary` stays null here, so
  // the stat and the strip below are gated by construction.
  const isPayToPark = propertyType === 'truck_plaza' && payToParkEnabled === true && !isHistory;
  // Camera-snapshot cache for inline violation/auto-cleared image previews.
  // Keyed by row id. The image fetch is lazy (IntersectionObserver) so a
  // 500-row log doesn't hammer the API on load. Replaces what ActivePassTracker
  // used to surface as a click-to-expand thumbnail; now inline so operators
  // can visually match the truck to the row without an extra tap.
  const [vehicleImageCache, setVehicleImageCache] = useState({});
  // Open alpr_violations for this property keyed by normalized plate, so
  // each visitor-pass row can show "✅ Towed / ✖ No Tow" buttons when the
  // pass became an overstay-violation. Operators used to have to leave the
  // Parking Log and go to Billing → Confirmation Review to mark these,
  // which broke the natural workflow of "I'm looking at the pass, here's
  // what happened to the truck."
  const [violationByPlate, setViolationByPlate] = useState(new Map());
  // Per-row submitting state — instead of a global flag that disables EVERY
  // tow/no-tow button while any one is in flight. Operators on a busy lot
  // tap row after row; they can't wait 2 seconds between each. Tracks the
  // pass_id whose action is currently in flight (null otherwise). Buttons
  // disable only when their own row matches.
  const [submittingRowId, setSubmittingRowId] = useState(null);

  // Property switch: clear caches keyed by row id so a new property never
  // inherits a stale image, violation lookup, or submitting flag from the
  // previous property. Realtime + load() handle the refresh below.
  useEffect(() => {
    setVehicleImageCache({});
    setViolationByPlate(new Map());
    setSubmittingRowId(null);
    setPillStatusFilter(null);
  }, [propertyId]);
  // Auto-widening: if a search returns 0 matches in the current date window
  // but might match outside it, offer one-click to extend the window back 90d.
  const [widening, setWidening] = useState(false);
  // Click-to-filter on the status pills. null = no pill filter (show all).
  // Toggles between null and the status name on click. Client-side overlay
  // on top of search + date filters — doesn't refetch.
  const [pillStatusFilter, setPillStatusFilter] = useState(null);

  // ── search normalization helpers ─────────────────────────────────────
  // Plate field is stored normalized (uppercase, alphanumeric only) by both
  // QR forms. Phone is stored E.164 ("+15551234567"). Operator input needs
  // the same treatment so "abc 1234" matches "ABC1234" and "(555) 123-4"
  // matches "+15551234567".
  function normalizePlateForSearch(s) {
    return (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }
  function normalizePhoneForSearch(s) {
    return (s || '').replace(/\D/g, '');
  }

  // PassPhotoStrip is defined at module scope so it keeps a stable component
  // identity across this component's frequent re-renders; it takes the photo
  // cache + setter as props.
  // Returns the list of field names this row matched on, or [] if no match.
  // An empty/whitespace-only query is treated as "no filter" by the caller,
  // so we don't bother here.
  function searchMatches(row, query) {
    const matched = [];
    const qLower = query.trim().toLowerCase();
    if (!qLower) return matched;
    const qPlate = normalizePlateForSearch(query);
    const qPhone = normalizePhoneForSearch(query);

    // Plate: ≥2 alphanumeric chars to avoid noise (typing "ab" shouldn't
    // match every plate containing AB; typing "abc" should).
    // Tractors register a front plate AND a trailer (rear) plate, and the card
    // renders both — an operator reading the trailer placard must be able to
    // find the truck by it. Searching plate_text alone returned "No matches"
    // for a registered, on-cooldown truck whose trailer plate was on screen.
    if (qPlate.length >= 2) {
      if (normalizePlateForSearch(row.plate_text).includes(qPlate)) {
        matched.push('plate');
      } else if (normalizePlateForSearch(row.back_plate).includes(qPlate)) {
        matched.push('trailer');
      }
    }
    // Driver name on the visitor pass.
    if ((row.visitor_name || '').toLowerCase().includes(qLower)) matched.push('name');
    // Carrier / company.
    if ((row.company_name || '').toLowerCase().includes(qLower)) matched.push('company');
    // Phone: digits-only match against E.164 stored value. ≥4 digit
    // threshold prevents random short numerics from matching every phone.
    if (qPhone.length >= 4 && normalizePhoneForSearch(row.phone).includes(qPhone)) {
      matched.push('phone');
    }
    // Parking spot: stored as text or number; coerce to string.
    if (row.parking_spot != null && String(row.parking_spot).toLowerCase().includes(qLower)) {
      matched.push('spot');
    }
    // Reference ID: short generated identifier printed on the driver's
    // success card; they may quote it on the phone.
    if ((row.reference_id || '').toLowerCase().includes(qLower)) matched.push('ref');

    return matched;
  }

  const trimmedSearch = searchText.trim();
  const hasSearch = trimmedSearch.length > 0;

  const load = useCallback(async () => {
    if (!propertyId) return;
    setLoading(true);
    setErr(null);
    try {
      // Fetch backend log + open alpr violations in parallel. allSettled so
      // a violations-fetch failure doesn't blow away the log AND a log-fetch
      // failure doesn't blow away the violation map. Each side is preserved
      // independently — a network blip on one shouldn't strip tow buttons
      // from the screen.
      // History is the permanent record — it must load EVERY pass, not just the
      // most recent 500, or the oldest registrations silently vanish (Charlotte
      // already has >540). getAllParkingLog pages through the whole result set;
      // once every row is in memory the client-side search box covers 100% of
      // history. Default (live-ops) mode keeps a single 500-row recent window.
      const logFetch = isHistory
        ? db.getAllParkingLog(propertyId, {
            date_from: filters.date_from,
            date_to: filters.date_to,
            status: filters.status,
          })
        : db.getParkingLog(propertyId, {
            date_from: filters.date_from,
            date_to: filters.date_to,
            status: filters.status,
            page: 1,
            page_size: 500,
          });
      const [resOutcome, violOutcome, payOutcome] = await Promise.allSettled([
        logFetch,
        db.getOpenAlprViolations(propertyId),
        // Pay-to-park counters ride the same fetch (and therefore the same 60s
        // poll + realtime refresh) rather than opening a second timer.
        isPayToPark ? db.getPlazaSummary(propertyId) : Promise.resolve(null),
      ]);
      // Set before the log's own failure can throw below: a lot with no
      // payments, an older backend, or a viewer the endpoint won't answer for
      // must all render the page exactly as it was before pay-to-park.
      setPaySummary(payOutcome.status === 'fulfilled' ? payOutcome.value : null);
      if (resOutcome.status === 'fulfilled') {
        const res = resOutcome.value;
        // Backend returns `{ items, total, page, page_size }` per the docstring
        // on db.getParkingLog. A prior refactor switched this to res.rows which
        // is undefined, so `rows` was always [] and the search matched nothing
        // even when `total` showed hundreds of passes. Accept both keys so the
        // page stays correct if the backend response shape ever changes again.
        const items = res.items || res.rows || [];
        setRows(items);
        setTotal(res.total ?? items.length);
      } else {
        // Log fetch failed — keep the previous rows on screen rather than
        // emptying the list. Operator should see the error banner instead.
        throw resOutcome.reason;
      }
      if (violOutcome.status === 'fulfilled') {
        // Build plate→violation map. The alpr_violations table doesn't store
        // visitor_pass_id on every row, so we match by normalized plate +
        // property_id (already filtered server-side). Only OPEN violations
        // (action_taken IS NULL) come back from getOpenAlprViolations.
        const viols = violOutcome.value;
        const m = new Map();
        for (const v of (viols || [])) {
          const k = normalizePlateForSearch(v.plate_text);
          if (k && !m.has(k)) m.set(k, v);
        }
        setViolationByPlate(m);
      }
      // else: keep previous violationByPlate so the tow/no-tow buttons
      // don't silently disappear from a network blip.
    } catch (e) {
      setErr(e.message || 'Failed to load log');
    }
    setLoading(false);
  }, [propertyId, filters, isPayToPark]);

  // Handler for the tow / no-tow confirmation modal. Calls the existing
  // backend endpoints (force-bill for tow-confirmation, mark-no-tow for
  // dismissal). Both are owner-scoped on the backend; partners still see
  // the buttons here for visual consistency but the API call will 403
  // for them (caught and surfaced via toast).
  // Action handler. Branches on whether the row has a matched open
  // alpr_violation (the typical case) or not (camera-less property,
  // already-actioned violation, or cron hasn't created one yet).
  //   - WITH violation_id  → goes through the violation state machine
  //                          (force-bill = towed, mark-no-tow = no tow).
  //                          Billing handling is partner-side.
  //   - WITHOUT violation  → falls back to cancel-pass with a note. The
  //                          row clears from the working view; no billing
  //                          happens (there's no violation to bill).
  async function handleViolationAction(kind, payload, reason) {
    // Defensive guards — if pass_id is missing (corrupted row data), refuse
    // to fire the action rather than POSTing to /visitor_passes/undefined/cancel
    // (which the backend silently 404s, leaving the operator thinking the
    // tap succeeded). Surface a clear error instead.
    if (!payload.pass_id && !payload.violation_id) {
      addToast('Cannot action this row — missing ids. Refresh and retry.', 'error');
      return;
    }
    setSubmittingRowId(payload.pass_id || payload.violation_id);
    const label = kind === 'tow' ? 'Marked towed' : 'Marked no-tow';
    try {
      const note = reason || `${label} from Parking Log`;
      if (payload.violation_id) {
        try {
          if (kind === 'tow') {
            // Partners RECORD the tow (feeds the confirmation/billing
            // pipeline); owners release billing directly. The old code
            // called force-bill for everyone — and force-bill 404s partner
            // JWTs by design ("Violation not found"), so the tow partner's
            // one critical tap failed every time a violation was open.
            if (isOwner) {
              await db.forceBillViolation(payload.violation_id, note);
              addToast('Marked towed — billing released', 'success');
            } else {
              await db.markViolationTowed(payload.violation_id, note);
              addToast('Marked towed', 'success');
            }
          } else {
            await db.markViolationNoTow(payload.violation_id, note);
            addToast('Marked no-tow', 'success');
          }
        } catch (e) {
          // Stale violation id (closed between page load and the tap by a
          // cron sweep or email action) — the tap must still succeed. Fall
          // through to closing the pass with an audit note.
          if (payload.pass_id && /not found/i.test(String(e.message || ''))) {
            await db.cancelVisitorPass(payload.pass_id, `${label} (violation already closed): ${note}`);
            addToast(`${label} (pass closed)`, 'success');
          } else { throw e; }
        }
      } else if (kind === 'tow') {
        // No open violation (cooldown / tow-if-seen): create the tow record —
        // it feeds the same confirmation/billing pipeline as any other tow.
        await db.recordCooldownTow(payload.pass_id, reason || 'Cooldown tow from Parking Log');
        addToast('Tow recorded', 'success');
      } else {
        // No linked violation — close the pass with a clear audit note.
        // Reason prefix lets future review queries filter these out as
        // operator-actioned rather than driver-cancelled.
        await db.cancelVisitorPass(
          payload.pass_id,
          `${label} (no linked violation): ${note}`
        );
        addToast(`${label} (pass cancelled)`, 'success');
      }
      load();
    } catch (e) {
      addToast(`${label} failed: ${e.message || 'unknown error'}`, 'error');
    } finally {
      setSubmittingRowId(null);
    }
  }


  // Initial load + on filter / page changes via `load` identity. The 60s poll
  // is a safety net: realtime delivers updates instantly, but if the realtime
  // socket silently dies (laptop sleep, network switch, supabase-js drop) the
  // poll guarantees the roster still self-heals and never freezes stale.
  useIntervalFetch(load, 60000, [load]);

  // (The authoritative roster + its realtime/poll now live in useActiveRoster
  // above — the old parallel direct-pull was deleted as part of collapsing
  // everything onto one source of truth.)

  // Realtime subscription. New passes inserted (and exit/overstay updates)
  // refresh the log silently — filter + pagination state are preserved
  // because `load` reads from current state, not from the realtime payload.
  //
  // Channel name includes a per-mount nonce because supabase-js v2's
  // removeChannel is asynchronous; when the effect re-runs (e.g. operator
  // applies filters → `load` identity changes), recreating a channel with
  // the same name before the prior one's unsubscribe ACK arrives silently
  // fails and realtime stops. The nonce keeps each subscription's name
  // unique so the new one establishes cleanly while the old one tears down.
  useEffect(() => {
    if (!supabase || !propertyId) return;
    const nonce = Math.random().toString(36).slice(2, 10);
    const ch = supabase.channel('parking-log-realtime-' + propertyId + '-' + nonce)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'visitor_passes', filter: 'property_id=eq.' + propertyId }, () => load())
      .subscribe();
    return () => { try { supabase.removeChannel(ch); } catch {} };
  }, [propertyId, load]);

  async function handleCancel(reason) {
    if (!cancelModal) return;
    setCancelling(true);
    try {
      await db.cancelVisitorPass(cancelModal.id, reason || undefined);
      addToast('Pass cancelled', 'success');
      setCancelModal(null);
      load();
    } catch (e) {
      addToast('Cancel failed: ' + (e.message || ''), 'error');
    } finally {
      setCancelling(false);
    }
  }

  async function handleExport() {
    setExporting(true);
    try {
      // The backend DOES have a column-aware plate filter (front OR trailer,
      // both normalized), so a plate-shaped search is exported faithfully.
      // It has no filter for name/company/phone/spot/ref — for those the CSV
      // still covers the date window, and we say so out loud rather than
      // handing over a file that quietly disagrees with the screen.
      const exportParams = { ...filters, format: 'csv' };
      const searchIsPlateShaped = /^[A-Za-z0-9\s-]{2,}$/.test(trimmedSearch)
        && normalizePlateForSearch(trimmedSearch).length >= 2;
      if (hasSearch && searchIsPlateShaped) {
        exportParams.plate = normalizePlateForSearch(trimmedSearch);
      } else if (hasSearch) {
        addToast('Export covers the date range — the text search is not applied to CSV', 'info');
      }
      const blob = await db.getParkingLog(propertyId, exportParams);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const today = new Date().toISOString().slice(0, 10);
      a.download = `truck-parking-log-${today}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      addToast('Export failed: ' + (e.message || ''), 'error');
    }
    setExporting(false);
  }

  function widenDateRange() {
    // 90-day lookback covers nearly every realistic "I swear they were here
    // a while ago" case without dumping a year of rows on the operator.
    const today = new Date();
    const ninetyDaysAgo = new Date(today.getTime() - 90 * 24 * 60 * 60 * 1000);
    const next = {
      ...filters,
      date_from: localDay(ninetyDaysAgo),
      date_to: localDay(today),
    };
    setWidening(true);
    setFilters(next);
    setTimeout(() => setWidening(false), 800);
  }
  const inputStyle = {padding:'8px 10px',background:'var(--bg-inset)',border:'1px solid var(--border)',borderRadius:8,color:'var(--text-primary)',fontSize:13,fontFamily:'inherit'};
  const labelStyle = {display:'flex',flexDirection:'column',gap:5,fontSize:10,color:'var(--text-muted)',fontWeight:700,letterSpacing:'.06em',textTransform:'uppercase'};
  // Traffic-light coloring for on-site plate scanning:
  //   GREY    = recently expired (window closed ≤4 days ago, may still be in lot)
  //   YELLOW  = expiring soon (active but < 3h to valid_until)
  //   GREEN   = active and >3h remaining
  //   GREY    = expired (window closed > 4 days ago; no camera exit detected
  //             and no operator action — kept for the permanent record)
  //
  // `expiring` and `auto_cleared` are DERIVED at render time. The DB only
  // knows active|expired|... — the time-windowed buckets are purely visual.
  // Adding a new status = one row in each of the three maps below, and one
  // entry in deriveStatus(). Everything downstream consumes from these maps.
  const EXPIRING_WINDOW_MS = 3 * 60 * 60 * 1000;
  // A pass whose window ended within the last 4 days shows as "Recently expired";
  // older than that it's just "Expired" and lives in the permanent History.
  // (Was a 24h "auto-clear" cut; widened to 4 days per ops.)
  const AUTO_CLEAR_WINDOW_MS = 4 * 24 * 60 * 60 * 1000;
  const statusColor = {
    active: '#4ade80',
    expiring: '#facc15',
    // Neutral grey, never a red alert: a "recently expired" pass usually just
    // means the window ended and the camera (north gate, at night) didn't catch
    // the exit — not a violation.
    expired: '#94a3b8',
    auto_cleared: '#6b7280',
    cancelled: 'var(--text-muted)',
    revoked: 'var(--text-muted)',
    towed: '#f59e0b',
  };
  const statusDisplay = {
    active: 'Active',
    expiring: 'Expiring soon',
    expired: 'Recently expired',
    auto_cleared: 'Expired',
    cancelled: 'Cancelled',
    revoked: 'Revoked',
    towed: 'Towed',
  };
  // Order: live passes first (expiring soon is most time-sensitive, then
  // active), housekeeping in the middle, expired records LAST.
  const statusOrder = { expiring: 0, active: 1, towed: 2, auto_cleared: 3, cancelled: 4, revoked: 5, expired: 6 };
  // Soft explainer under the plate. The expired tiers carry the cover-the-
  // customer note: an expiry often just means the camera missed the exit
  // (night/power gaps at the north gate), not a violation.
  const statusExplainer = {
    expired: "Parking window ended — the vehicle may have already exited (the camera may not have captured it).",
    auto_cleared: "Parking window ended (over 4 days ago) — kept here for the permanent record. If this truck is still on the lot, tap Mark towed.",
  };

  function deriveStatus(r) {
    const raw = r.status || 'active';
    if (raw !== 'active') {
      // Expired rows split by age: ≤4 days = "Recently expired" (surfaced),
      // older = "Expired" (permanent record). Same row, different label.
      if (raw === 'expired' && r.valid_until) {
        const expiredAgo = Date.now() - new Date(r.valid_until).getTime();
        if (expiredAgo >= AUTO_CLEAR_WINDOW_MS) return 'auto_cleared';
      }
      return raw;
    }
    if (!r.valid_until) return 'active';
    const remaining = new Date(r.valid_until).getTime() - Date.now();
    if (remaining <= 0) {
      // Crossed the expiry boundary just now — still bucket by age so
      // the 4-day cut catches the case where status hasn't been flipped
      // to 'expired' by the backend yet.
      if (-remaining >= AUTO_CLEAR_WINDOW_MS) return 'auto_cleared';
      return 'expired';
    }
    if (remaining < EXPIRING_WINDOW_MS) return 'expiring';
    return 'active';
  }
  // The Parking Log (default mode) is simplified to FOUR mutually-exclusive
  // buckets. On Cooldown and Recently expired are split at the 24h line so a
  // pass never double-counts. Operator voids/revokes/tows and anything that
  // ended >4 days ago are NOT shown here — they live in the History tab.
  const useBuckets = !isHistory;
  // Order drives BOTH the pill row and the list: expiring soon first (most
  // time-sensitive), then active, then the ended buckets.
  const TRUCK_BUCKET_ORDER = ['expiring', 'active', 'cooldown', 'recently_expired'];
  const truckBucketMeta = {
    cooldown:         { label: 'On Cooldown',      color: '#ef4444' },
    active:           { label: 'Active',           color: '#4ade80' },
    expiring:         { label: 'Expiring soon',    color: '#facc15' },
    recently_expired: { label: 'Recently expired', color: '#94a3b8' },
  };
  function truckBucket(r) {
    const now = Date.now();
    const vu = r.valid_until ? new Date(r.valid_until).getTime() : null;
    const ex = r.exited_at ? new Date(r.exited_at).getTime() : null;
    const status = r.status || 'active';
    const cb = String(r.cancelled_by || '');
    // Operator/admin void, revoke, tow → not a natural pass-end; History only.
    if (status === 'revoked' || status === 'towed') return null;
    if (status === 'cancelled' && !cb.startsWith('camera_exit')) return null;
    const DAY = 24 * 60 * 60 * 1000;
    // Still parked (valid window, no exit, not camera-closed) → active/expiring.
    const parked = ex === null && status !== 'cancelled' && vu !== null && vu > now;
    if (parked) return (vu - now) <= EXPIRING_WINDOW_MS ? 'expiring' : 'active';
    // Ended. Pass END = camera exit if seen, else the time limit (matches the
    // count_on_cooldown RPC). On cooldown for 24h from that end.
    const end = ex !== null ? ex : vu;
    if (end !== null && end <= now && (now - end) <= DAY) return 'cooldown';
    // Recently expired = TIMED OUT (no camera exit, not cancelled) 24h–4 days ago.
    if (ex === null && status !== 'cancelled' && vu !== null && vu <= now - DAY && vu > now - AUTO_CLEAR_WINDOW_MS) return 'recently_expired';
    return null;
  }
  const fmtDateTime = (s) => s ? new Date(s).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
  // Human-relative day label for the operator's "how long ago" scan.
  // "Today", "Yesterday", or "N days ago".
  const fmtDaysAgo = (s) => {
    if (!s) return '';
    const ms = Date.now() - new Date(s).getTime();
    const days = Math.floor(ms / (24 * 60 * 60 * 1000));
    if (days <= 0) return 'Today';
    if (days === 1) return 'Yesterday';
    return `${days} days ago`;
  };
  // Union the authoritative live roster (the single source of truth) with the
  // backend history log. Roster first so every currently-registered pass is
  // present; backend rows overwrite on id so they win where they carry richer
  // joined fields. History is additive only — it can never remove a roster pass.
  const allRowsMap = new Map();
  for (const r of activeRoster) allRowsMap.set(r.id, r);
  for (const r of rows) allRowsMap.set(r.id, r);   // backend wins: carries joined fields
  const unionRows = Array.from(allRowsMap.values());

  // "Registered right now" — mirrors the backend GET /{lot_id}/registered
  // contract exactly: active status, not yet exited, still inside its window.
  // Anything matching this MUST appear in the default view regardless of the
  // date filter, so a truck that just registered can never be missing.
  const isCurrentlyRegistered = (r) =>
    (r.status || 'active') === 'active' &&
    !r.exited_at &&
    (!r.valid_until || new Date(r.valid_until).getTime() > Date.now());

  // Default (no search) view = the COMPLETE live roster of currently-registered
  // vehicles (authoritative, date-window-independent) followed by the recent
  // historical rows from the windowed backend log (violations / cancelled /
  // auto-cleared) for operational context. This is the fix for passes silently
  // dropping off the active list: the roster is built from the union of the
  // authoritative active fetch + direct pull, never from the windowed log alone.
  const defaultMatches = (() => {
    if (useBuckets) {
      // Parking Log = ONLY the four buckets (On Cooldown / Active / Expiring
      // soon / Recently expired). Everything else (operator-closed, ended >4
      // days ago) lives in the History tab.
      return unionRows.filter(r => truckBucket(r) !== null).map(r => ({ row: r, matched: [] }));
    }
    const seen = new Set();
    const roster = [];
    for (const r of unionRows) {
      if (isCurrentlyRegistered(r)) { roster.push({ row: r, matched: [] }); seen.add(r.id); }
    }
    const history = [];
    for (const r of rows) {
      if (!seen.has(r.id)) history.push({ row: r, matched: [] });
    }
    return roster.concat(history);
  })();

  // Live filter: when there's a search query, narrow to matches across the
  // full union. Each entry carries the `matched` field list so we can show
  // "matched: name" chips beside the result. When there's no search, show the
  // authoritative roster + windowed history (defaultMatches).
  const visitorMatches = hasSearch
    ? unionRows.map(r => ({ row: r, matched: searchMatches(r, trimmedSearch) }))
               .filter(x => x.matched.length > 0)
    : defaultMatches;

  // Counts by derived status — drives the per-status pills above the grid.
  // Always derived from the currently-displayed visitor passes so it stays
  // honest as the operator types.
  const visitorRows = visitorMatches.map(x => x.row);
  const statusCounts = visitorRows.reduce((acc, r) => {
    const s = deriveStatus(r);
    acc[s] = (acc[s] || 0) + 1;
    return acc;
  }, {});
  // Default (Parking Log) mode uses the four mutually-exclusive buckets; History
  // keeps the full derived statuses. `pillList` is the unified shape the pill
  // row renders from either way.
  const bucketCounts = useBuckets ? visitorRows.reduce((acc, r) => {
    const b = truckBucket(r);
    if (b) acc[b] = (acc[b] || 0) + 1;
    return acc;
  }, {}) : {};
  const pillList = useBuckets
    ? TRUCK_BUCKET_ORDER.filter(b => bucketCounts[b]).map(b => ({
        id: b, label: truckBucketMeta[b].label, color: truckBucketMeta[b].color,
        count: bucketCounts[b], loud: b === 'cooldown' || b === 'expiring',
      }))
    : ['expiring','active','towed','auto_cleared','cancelled','revoked','expired']
        .filter(s => statusCounts[s]).map(s => ({
          id: s, label: statusDisplay[s] || s, color: statusColor[s] || 'var(--text-muted)',
          count: statusCounts[s], loud: s === 'expiring',
        }));

  // Apply the pill-tap status filter on top of search results. The status
  // pills above the grid show counts derived from `visitorMatches` (i.e.
  // they reflect the search), so clicking one acts as a drill-down on
  // those counts. Set to null to clear and see everything again.
  const pillFilteredMatches = pillStatusFilter
    ? visitorMatches.filter(x => (useBuckets ? truckBucket(x.row) : deriveStatus(x.row)) === pillStatusFilter)
    : visitorMatches;

  // Sort: violations → expiring → active → towed → cancelled → revoked.
  // Within a status group, newest first so the latest activity floats up.
  // Sort preserves the matched-fields metadata so chips render alongside.
  const sortedMatches = [...pillFilteredMatches].sort((a, b) => {
    let oa, ob;
    if (useBuckets) {
      const ia = TRUCK_BUCKET_ORDER.indexOf(truckBucket(a.row));
      const ib = TRUCK_BUCKET_ORDER.indexOf(truckBucket(b.row));
      oa = ia < 0 ? 99 : ia; ob = ib < 0 ? 99 : ib;
    } else {
      oa = statusOrder[deriveStatus(a.row)] ?? 99;
      ob = statusOrder[deriveStatus(b.row)] ?? 99;
    }
    if (oa !== ob) return oa - ob;
    const ta = new Date(a.row.created_at || 0).getTime();
    const tb = new Date(b.row.created_at || 0).getTime();
    return tb - ta;
  });


  // Total displayed reflects whatever's actually on screen right now —
  // accounts for both search filter AND the pill drill-down.
  const displayedTotal = pillStatusFilter
    ? pillFilteredMatches.length
    : (hasSearch ? visitorMatches.length : defaultMatches.length);

  // Pretty labels for the "matched: X" chip on each result.
  const matchedFieldLabel = {
    plate: 'plate',
    trailer: 'trailer plate',
    name: 'name',
    company: 'company',
    phone: 'phone',
    spot: 'parking spot',
    ref: 'reference ID',
  };

  // Common chip style for the small "matched: X" pill beside each result.
  const matchedChip = (field) => (
    <span key={field} style={{fontSize:10,fontWeight:700,letterSpacing:'.05em',textTransform:'uppercase',padding:'2px 7px',borderRadius:12,background:'rgba(168,85,247,.14)',color:'#c084fc',border:'1px solid rgba(168,85,247,.35)'}}>
      matched: {matchedFieldLabel[field] || field}
    </span>
  );

  const pendingCount = paySummary?.pending_recent || 0;

  return (
    <div style={{display:'flex',flexDirection:'column',gap:14}}>
      {/* Payments still settling (§13.7). A truck that has just paid has no
          pass yet — Square's webhook is seconds away — so for that window it
          looks exactly like a truck that never registered. This strip is the
          only thing between it and a tow truck, which is why it sits above
          everything else and cannot be dismissed. It disappears on its own
          once the payment lands (or 15 minutes later, when an unfinished
          checkout stops being a truck to hold off on). */}
      {pendingCount > 0 && (
        <div className="processing-strip" role="status">
          <span aria-hidden="true">⏳</span>
          <span>
            <strong>{pendingCount} payment{pendingCount > 1 ? 's' : ''} processing</strong>
            {' — '}pass{pendingCount > 1 ? 'es' : ''} activating. Don't tow.
          </span>
        </div>
      )}

      {/* Towed-someone reminder. Drivers walk along trucks, run the plate,
          take a photo, come back to the tow truck, and physically tow.
          The thing they routinely forget is the LAST step — coming back
          to the app to tap "Mark towed" on the pass. Without it the pass
          stays open and the log falls out of sync. A persistent (not
          dismissable) banner here keeps the habit fresh. Operators asked for this. */}
      <div style={{
        background:'rgba(239,68,68,.08)',
        border:'1px solid rgba(239,68,68,.3)',
        borderLeft:'4px solid #ef4444',
        borderRadius:10,
        padding:'10px 14px',
        display:'flex',
        alignItems:'center',
        gap:10,
        fontSize:12,
        color:'var(--text-primary)',
        lineHeight:1.4,
      }}>
        
        <span><strong>The system runs itself — except for one tap.</strong> Pull a truck, <strong>mark towed</strong> on its pass. It's the one input the system can't run without — skip it and it <strong style={{fontSize:14}}>breaks</strong>.</span>
      </div>

      {/* ── Search bar (always-visible, live) ──────────────────────────── */}
      {/* Operator-anchor. Filters everything below as the user types.
          Matches across: plate, driver name, company, phone,
          parking spot, reference ID. Spans both visitor passes (this tab)
          and the permanent allowlist so a Swift driver registered as an
          employee surfaces in the same search. */}
      <div style={{position:'relative'}}>
        <input
          type="text"
                    value={searchText}
          onChange={e => setSearchText(e.target.value)}
          placeholder="Search plate, name, company, phone, spot, or ref ID…"
          style={{
            width:'100%', padding:'14px 44px 14px 44px',
            background:'var(--bg-card)', border:'1.5px solid var(--border)',
            borderRadius:12, color:'var(--text-primary)', fontSize:15,
            fontFamily:'inherit', boxSizing:'border-box',
          }}
        />
        <span aria-hidden="true" style={{position:'absolute',left:14,top:'50%',transform:'translateY(-50%)',fontSize:18,opacity:.55}}>🔍</span>
        {hasSearch && (
          <button
            type="button"
            onClick={() => setSearchText('')}
            aria-label="Clear search"
            title="Clear search"
            style={{position:'absolute',right:8,top:'50%',transform:'translateY(-50%)',background:'transparent',border:'none',cursor:'pointer',padding:6,color:'var(--text-muted)',fontSize:16,lineHeight:1}}
          >✕</button>
        )}
      </div>

      {/* The date/status filter form used to live here. Removed in the
          parking-pass simplification — the smart search box + tap-pills
          (below) do the same job with less chrome. Default date window is
          7 days; the "🔭 Search the last 90 days" button in the empty
          state widens it on demand. CSV export moved behind the ⋯ overflow
          next to the total count (owner desktop only — operators on phones
          don't export from the field). */}

      {/* Non-blocking refresh error. The roster below is sourced independently
          from Supabase, so a backend-log hiccup must NEVER blank the view: we
          show a quiet amber notice + manual retry and KEEP the last known
          roster on screen. It auto-recovers on the next 60s poll. */}
      {(err || rosterError) && (
        <div style={{padding:'10px 12px',background:'rgba(245,158,11,.1)',border:'1px solid rgba(245,158,11,.35)',borderRadius:8,color:'var(--text-primary)',fontSize:12,display:'flex',alignItems:'center',gap:10,flexWrap:'wrap'}}>
          <span>Couldn't refresh from the server — showing the last known roster. Retrying automatically…</span>
          <button type="button" onClick={() => { load(); refreshRoster(); }} style={{fontSize:12,fontWeight:700,padding:'8px 12px',minHeight:36,borderRadius:6,border:'1px solid var(--border)',background:'transparent',color:'var(--text-primary)',cursor:'pointer',fontFamily:'inherit'}}>Retry now</button>
        </div>
      )}

      {/* ── Header summary row (always rendered — NEVER gated on error, so the
          roster + counts stay visible through a backend blip) ───────────── */}
      {(
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:12,flexWrap:'wrap'}}>
          <div style={{display:'flex',gap:14,alignItems:'baseline',flexWrap:'wrap'}}>
            <div style={{fontSize:22,fontWeight:800,color:'var(--text-primary)',letterSpacing:'-.01em',display:'flex',alignItems:'baseline',gap:6}}>
              {displayedTotal.toLocaleString()}<span style={{fontSize:13,fontWeight:600,color:'var(--text-muted)'}}>{displayedTotal === 1 ? 'match' : (hasSearch ? 'matches' : 'passes')}</span>
              {/* CSV export — owner only, lives next to the total count
                  instead of in a chrome-heavy form. Hidden for partners and
                  on phones (operators don't export CSVs in the field). */}
              {isOwner && (
                <button
                  type="button"
                  onClick={handleExport}
                  disabled={exporting}
                  title="Download these results as CSV (date / status filters apply; smart search filter does not)."
                  className="pd-csv-export-owner"
                  style={{
                    marginLeft:8,
                    fontSize:11, fontWeight:700,
                    padding:'4px 8px', borderRadius:6,
                    border:'1px solid var(--border)',
                    background:'transparent',
                    color:'var(--text-muted)',
                    cursor: exporting ? 'wait' : 'pointer',
                    fontFamily:'inherit',
                  }}
                >{exporting ? 'Exporting…' : '↓ CSV'}</button>
              )}
            </div>
            {/* What the lot took in. Cents come down from the backend so the
                dashboard never does money arithmetic on a float; today and the
                month are both the LOT's day, not UTC's.
                Both windows are checked individually, not just the object,
                because the backend deliberately sends them as null to a tow
                partner (R42) — the partner still gets the processing strip
                above, and nothing here. The same check covers an older backend
                answering a shape this page doesn't recognise: hide the stat,
                never blank the log. */}
            {paySummary?.today && paySummary?.month_to_date && (
              <div style={{display:'flex',gap:12,alignItems:'baseline',flexWrap:'wrap',fontSize:12,color:'var(--text-muted)'}}>
                <span>
                  <strong style={{color:'var(--text-primary)',fontWeight:800}}>Today:</strong>{' '}
                  {paySummary.today.count} pass{paySummary.today.count === 1 ? '' : 'es'} · {fmtMoney(paySummary.today.cents)} collected
                </span>
                <span>
                  <strong style={{color:'var(--text-primary)',fontWeight:800}}>Month:</strong>{' '}
                  {paySummary.month_to_date.count} · {fmtMoney(paySummary.month_to_date.cents)}
                </span>
              </div>
            )}
            {/* Money captured that never became a pass — a mismatched amount, a
                trigger that fired after the charge, a second charge on one
                order. The backend has been writing these down since day one
                and nothing on any screen said so. Owner-only: the count comes
                back null for a tow partner, and `null > 0` is false, so the
                same expression is the gate. No link yet — the number is the
                prompt to go and look. */}
            {paySummary?.needs_review > 0 && (
              <div style={{fontSize:12,fontWeight:600,color:'#f59e0b'}}>
                ⚠️ {paySummary.needs_review} {paySummary.needs_review === 1 ? 'payment needs' : 'payments need'} review
              </div>
            )}
            {pillList.length > 0 && (
              <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center'}}>
                {pillList.map(({ id: s, label, color, count, loud: isLoud }) => {
                  const isActive = pillStatusFilter === s;
                  const otherActive = pillStatusFilter && !isActive;
                  return (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setPillStatusFilter(isActive ? null : s)}
                      aria-pressed={isActive}
                      title={isActive ? `Showing only ${label} — click to clear` : `Filter to ${label} only`}
                      style={{
                        fontSize: isLoud ? 13 : 11,
                        fontWeight: 800,
                        padding: isLoud ? '6px 14px' : '5px 12px',
                        minHeight: 32,
                        borderRadius: 20,
                        background: isActive ? color : `${color}${isLoud ? '26' : '1a'}`,
                        color: isActive ? '#fff' : color,
                        border: `1px solid ${isActive ? color : `${color}${isLoud ? '66' : '40'}`}`,
                        boxShadow: isActive ? `0 0 0 3px ${color}33` : 'none',
                        opacity: otherActive ? 0.5 : 1,
                        textTransform: 'uppercase',
                        letterSpacing: '.04em',
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                        transition: 'background .12s, opacity .12s, box-shadow .12s',
                      }}
                    >
                      {count} {label}
                    </button>
                  );
                })}
                {pillStatusFilter && (
                  <button
                    type="button"
                    onClick={() => setPillStatusFilter(null)}
                    aria-label="Clear status filter"
                    title="Clear status filter"
                    style={{
                      fontSize: 11, fontWeight: 800,
                      padding: '5px 10px', minHeight: 32,
                      borderRadius: 20,
                      background: 'transparent',
                      color: 'var(--text-muted)',
                      border: '1px solid var(--border)',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      letterSpacing: '.04em',
                      textTransform: 'uppercase',
                    }}
                  >✕ All</button>
                )}
              </div>
            )}
          </div>
          <div style={{fontSize:11,color:'var(--text-muted)'}}>
            {filters.date_from ? new Date(filters.date_from+'T00:00:00').toLocaleDateString(undefined,{month:'short',day:'numeric'}) : ''} → {filters.date_to ? new Date(filters.date_to+'T00:00:00').toLocaleDateString(undefined,{month:'short',day:'numeric'}) : ''}
          </div>
        </div>
      )}

      {/* ── Visitor-pass results ──────────────────────────────────────── */}
      {loading && sortedMatches.length === 0 ? (
        <div style={{padding:40,textAlign:'center',color:'var(--text-muted)',fontSize:13,background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:12}}>Loading…</div>
      ) : sortedMatches.length === 0 ? (
        <div style={{padding:40,textAlign:'center',background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:12}}>
          <div style={{width:48,height:48,borderRadius:12,background:'rgba(96,165,250,.1)',display:'flex',alignItems:'center',justifyContent:'center',margin:'0 auto 10px',fontSize:22,color:'var(--text-faint)'}}>▤</div>
          <div style={{fontSize:14,fontWeight:700,color:'var(--text-primary)'}}>
            {hasSearch ? `No matches for "${trimmedSearch}"` : ((err || rosterError) ? "Couldn't load the roster" : (useBuckets ? 'Nothing active or recently expired' : 'No passes for these filters'))}
          </div>
          <div style={{fontSize:12,color:'var(--text-muted)',marginTop:4,maxWidth:480,margin:'4px auto 0'}}>
            {hasSearch
              ? <>Try a shorter chunk of the plate, just the first name, or the company. Phone numbers also work.</>
              : ((err || rosterError)
                  ? <>Connection issue — the list refreshes automatically every minute. Tap “Retry now” above if it persists.</>
                  : (useBuckets
                      ? <>Active, expiring, on-cooldown, and recently-expired passes show here. Older records are in the History tab.</>
                      : <>Try widening the date range or clearing the status filter.</>))}
          </div>
          {/* History mode is already all-time, so the "widen to 90 days" button
              would only NARROW it — hide it there. */}
          {hasSearch && !isHistory && (
            <button
              type="button"
              onClick={widenDateRange}
              disabled={widening}
              style={{marginTop:14,background:'rgba(74,222,128,.12)',color:'#4ade80',border:'1px solid rgba(74,222,128,.3)',borderRadius:8,padding:'8px 16px',fontSize:13,fontWeight:700,cursor:widening?'wait':'pointer',fontFamily:'inherit'}}
            >{widening ? 'Loading…' : '🔭 Search the last 90 days'}</button>
          )}
        </div>
      ) : (
        <div style={{display:'grid',gap:10,gridTemplateColumns:'repeat(auto-fill, minmax(min(380px, 100%), 1fr))'}}>
          {sortedMatches.map(({ row: r, matched }) => {
            const s = deriveStatus(r);
            // Parking Log (bucket) mode badges the bucket; History badges the
            // full derived status.
            const bkt = useBuckets ? truckBucket(r) : null;
            const bktMeta = bkt ? truckBucketMeta[bkt] : null;
            const dispLabel = bktMeta ? bktMeta.label : (statusDisplay[s] || s);
            const color = bktMeta ? bktMeta.color : (statusColor[s] || 'var(--text-muted)');
            const isActive = (r.status || 'active') === 'active';
            const isViolation = s === 'expired';
            const isExpiring = bkt ? bkt === 'expiring' : s === 'expiring';
            const isAutoCleared = s === 'auto_cleared';
            const driverLine = [r.visitor_name, r.company_name].filter(Boolean).join(' · ') || '—';
            const detailChips = [];
            if (r.parking_spot) detailChips.push({ label: 'Spot', value: r.parking_spot });
            // Derive stay from real timestamps; fall back to stay_days*24 if missing.
            // 12/24/36/48 hour passes ALL got stored as stay_days=1 or 2 due to ceil math,
            // so showing "Xd" misleads — render hours unless it's an exact multiple of 24.
            {
              const hrs = r.valid_from && r.valid_until
                ? Math.round((new Date(r.valid_until) - new Date(r.valid_from)) / 3600000)
                : (r.stay_days ? r.stay_days * 24 : null);
              if (hrs && hrs > 0) detailChips.push({ label: 'Stay', value: hrs % 24 === 0 ? `${hrs/24}d` : `${hrs}h` });
            }
            return (
              <div key={r.id} style={{
                background: isExpiring ? 'rgba(250,204,21,.06)' : isAutoCleared ? 'rgba(107,114,128,.04)' : 'var(--bg-card)',
                border:`1px solid ${isExpiring ? 'rgba(250,204,21,.4)' : isAutoCleared ? 'rgba(107,114,128,.3)' : 'var(--border)'}`,
                borderLeft:`${isExpiring ? 6 : 3}px solid ${color}`,
                borderRadius:12,
                padding: isExpiring ? 18 : 14,
                display:'flex',
                flexDirection:'column',
                gap: isExpiring ? 14 : 10,
                position:'relative',
                opacity: isAutoCleared ? 0.85 : 1,
                boxShadow: isExpiring ? '0 2px 18px rgba(250,204,21,.08)' : 'none',
              }}>
                {/* Top row: plate + status pill */}
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:10}}>
                  <div style={{display:'flex',flexDirection:'column',gap:3,minWidth:0}}>
                    <div style={{display:'flex',flexWrap:'wrap',alignItems:'center',gap:8,minWidth:0}}>
                      <div style={{
                        fontSize: isExpiring ? 32 : 18,
                        fontWeight: 900,
                        fontFamily:"'DM Mono','Courier New',monospace",
                        letterSpacing: isExpiring ? '.08em' : '.06em',
                        color: isExpiring ? '#ca8a04' : 'var(--text-primary)',
                        lineHeight: 1.05,
                      }}>
                        {r.plate_text}
                      </div>
                    </div>
                    {r.back_plate && (
                      <div style={{
                        fontSize: 11,
                        fontWeight: 700,
                        fontFamily:"'DM Mono','Courier New',monospace",
                        letterSpacing: '.05em',
                        color: 'var(--text-muted)',
                      }}>Trailer · {r.back_plate}</div>
                    )}
                  </div>
                  <span aria-label={`Pass status: ${dispLabel}`} style={{
                    fontSize: isExpiring ? 13 : 10,
                    fontWeight: 800,
                    padding: isExpiring ? '5px 12px' : '4px 10px',
                    borderRadius:20,
                    background:`${color}${isExpiring ? '26' : '1a'}`,
                    color,
                    border:`1px solid ${color}${isExpiring ? '66' : '40'}`,
                    textTransform:'uppercase',
                    letterSpacing:'.06em',
                    whiteSpace:'nowrap',
                    flexShrink:0,
                  }}>{dispLabel}</span>
                </div>

                {/* Pass holder / company / phone line */}
                <div style={{display:'flex',flexDirection:'column',gap:3}}>
                  <div style={{fontSize:13,color:'var(--text-primary)',fontWeight:600}}>{driverLine}</div>
                  {r.phone && <div style={{fontSize:12,color:'var(--text-muted)'}}>📞 {r.phone}</div>}
                </div>

                {/* Paid stamp. Comes through the parking log's JOIN on the
                    payment ledger, so a refund shows here on the next refresh
                    with nothing to keep in sync. Absent on every pass that was
                    registered for free — those rows look exactly as they did.

                    Gated on `payment_status`, not on the amount: the backend
                    withholds `paid_amount_cents` and `square_receipt_url` from
                    the tow partner (the lot's revenue is not a contractor's
                    business), and that row still has to say it is paid. */}
                {r.payment_status != null && (
                  r.payment_status === 'refunded' ? (
                    // Refunded says one thing and stops. An amount would read
                    // as money the lot still has, and a receipt link would send
                    // the operator to a Square page for a charge that was given
                    // back — both are worse than silence.
                    <span className="paid-stamp is-refunded">refunded</span>
                  ) : (
                    <span className="paid-stamp">
                      <span>
                        {/* The word stands in for the amount when the reader
                            is not allowed the amount — the stamp still has to
                            say "this one is paid". */}
                        {r.paid_amount_cents != null ? fmtMoney(r.paid_amount_cents) : 'paid'}
                        {/* The stay the driver BOUGHT, off the payment row.
                            stay_days cannot tell 10h from 24h (both round up
                            to 1 day), so inferring from it labelled a 10h pass
                            "24h". The old inference is kept only as a fallback
                            for a row served by a backend that predates the
                            paid_stay_hours column. */}
                        {' · '}{r.paid_stay_hours != null ? `${r.paid_stay_hours}h` : (r.stay_days === 2 ? '48h' : '24h')}
                        {/* History spans months, so a bare clock time there is
                            ambiguous — it needs the date with it. */}
                        {r.paid_at ? ` · paid ${isHistory ? fmtDateTime(r.paid_at) : fmtTime(r.paid_at)}` : ''}
                      </span>
                      {r.square_receipt_url && (
                        <a href={r.square_receipt_url} target="_blank" rel="noopener">receipt</a>
                      )}
                    </span>
                  )
                )}

                {/* Repeat-offender chip — only on passes the backend flagged as
                    re-registered inside the cooldown window. Click expands the
                    truck's recent visit history (lazy-fetched). */}
                {r.cooldown_flagged_at && (
                  <CooldownChip
                    passId={r.id}
                    priorFlagCount={r.prior_flag_count || 0}
                    registeredAt={r.valid_from}
                    priorEnd={r.cooldown_prior_end}
                  />
                )}

                {/* Re-registration → TOW. Only on passes the backend flagged
                    because the truck registered again while already holding an
                    active pass here (matched on plate OR phone). Operator/tow
                    facing — the driver never sees this. */}
                {r.reregistration_flagged_at && (
                  <ReregTowFlag pass={r} />
                )}

                {/* Status explainer. In bucket mode it only belongs on the
                    Recently-expired bucket — otherwise an "On Cooldown" row
                    would carry the grey "window ended" note and read as
                    self-contradictory. History keeps the original behaviour. */}
                {statusExplainer[s] && (!useBuckets || bkt === 'recently_expired') && (
                  <div style={{
                    fontSize: 12, lineHeight: 1.45,
                    padding: '8px 10px',
                    background: 'rgba(107,114,128,.08)',
                    borderLeft: '3px solid rgba(107,114,128,.5)',
                    borderRadius: 6,
                    color: 'var(--text-muted)',
                    fontStyle: 'italic',
                  }}>
                    {statusExplainer[s]}
                  </div>
                )}

                {/* Detail chips */}
                {(detailChips.length > 0 || matched.length > 0 || r.policy_acknowledged_at) && (
                  <div style={{display:'flex',flexWrap:'wrap',gap:6}}>
                    {detailChips.map((c, i) => (
                      <span key={i} style={{fontSize:11,padding:'3px 9px',borderRadius:14,background:'var(--bg-inset)',color:'var(--text-secondary)',border:'1px solid var(--border-subtle)',display:'inline-flex',alignItems:'center'}}>
                        <span style={{fontWeight:600,color:'var(--text-faint)',marginRight:5,textTransform:'uppercase',fontSize:10,letterSpacing:'.06em'}}>{c.label}</span>
                        <span style={{textTransform:'capitalize',fontWeight:700,color:'var(--text-primary)'}}>{c.value}</span>
                      </span>
                    ))}
                    {r.policy_acknowledged_at && (
                      <span title={`Acknowledged ${fmtDateTime(r.policy_acknowledged_at)}`} style={{fontSize:11,padding:'3px 9px',borderRadius:14,background:'rgba(74,222,128,.1)',color:'#4ade80',border:'1px solid rgba(74,222,128,.3)',display:'inline-flex',alignItems:'center',gap:4,fontWeight:700}}>
                        ✓ Policy
                      </span>
                    )}
                    {matched.map(matchedChip)}
                  </div>
                )}

                {/* ALL of this pass's camera photos — entry, exit, retro-linked
                    — in one uniform strip. One photo renders full-width; more
                    render as equal tiles (2-up on phones); >4 collapses into a
                    "+N more" tile. Tap anything for the full-screen viewer
                    (swipe / arrow keys / Escape). Replaces the old three-widget
                    split, one of which wasn't expandable at all. */}
                <PassPhotoStrip pass={r} propertyId={propertyId} cache={vehicleImageCache} setCache={setVehicleImageCache} />

                {/* Time range */}
                <div style={{display:'grid',gridTemplateColumns: r.exited_at ? '1fr auto 1fr auto 1fr' : '1fr auto 1fr',alignItems:'center',gap:10,padding:'10px 12px',background:'var(--bg-inset)',borderRadius:8,fontSize:11}}>
                  <div>
                    <div style={{color:'var(--text-faint)',fontWeight:700,letterSpacing:'.06em',textTransform:'uppercase',fontSize:10,marginBottom:2}}>Registered</div>
                    <div style={{color:'var(--text-primary)',fontWeight:600}}>{fmtDateTime(r.created_at)}</div>
                    <div style={{color:'var(--text-muted)',fontSize:10,marginTop:1,fontWeight:600}}>{fmtDaysAgo(r.created_at)}</div>
                  </div>
                  {r.exited_at && <div style={{color:'var(--text-faint)',fontSize:14}}>→</div>}
                  {r.exited_at && (
                    <div style={{textAlign:'center'}}>
                      <div style={{color:'var(--text-faint)',fontWeight:700,letterSpacing:'.06em',textTransform:'uppercase',fontSize:10,marginBottom:2}}>Exited</div>
                      <div style={{color:'var(--text-primary)',fontWeight:600}}>{fmtDateTime(r.exited_at)}</div>
                    </div>
                  )}
                  <div style={{color:'var(--text-faint)',fontSize:14}}>→</div>
                  <div style={{textAlign:'right'}}>
                    <div style={{color:'var(--text-faint)',fontWeight:700,letterSpacing:'.06em',textTransform:'uppercase',fontSize:10,marginBottom:2}}>{r.cancelled_at ? 'Cancelled' : 'Expires'}</div>
                    <div style={{color:'var(--text-primary)',fontWeight:600}}>{fmtDateTime(r.cancelled_at || r.valid_until)}</div>
                    {r.cancelled_by && <div style={{color:'var(--text-faint)',fontSize:10,marginTop:1}}>by {r.cancelled_by}</div>}
                  </div>
                </div>

                {/* Actions row. Cancel-pass for active passes; tow-decision
                    for expired passes that have a matching open ALPR
                    violation (the overstay case). 44px-tall tap targets
                    for mobile thumb use; color-coded so destructive vs
                    benign is visually unambiguous in sun. */}
                {(() => {
                  const violKey = normalizePlateForSearch(r.plate_text);
                  const openViolation = violationByPlate.get(violKey);
                  // Tow / No-tow buttons show on EVERY expired or
                  // auto-cleared row, regardless of whether we have a
                  // matched open alpr_violation. Why: many rows don't
                  // have one (cron didn't create it, or the property
                  // has no ALPR cameras, or the violation was already
                  // actioned). Without these buttons, operators can't
                  // act on those rows from the Parking Log at all.
                  // If a violation is matched, the action goes through
                  // the violation state machine (force-bill / mark-no-tow).
                  // If not, it falls back to cancel-pass with a note so
                  // the row clears from the working view.
                  const isCooldown = s === 'cooldown';
                  const showTowActions = s === 'expired' || s === 'auto_cleared' || isCooldown;
                  if (!isActive && !showTowActions) return null;
                  return (
                    <div style={{display:'flex',justifyContent:'flex-end',gap:8,marginTop:-2,flexWrap:'wrap'}}>
                      {isActive && (
                        <button
                          onClick={() => setCancelModal({ id: r.id, plate_text: r.plate_text })}
                          style={{minHeight:44,background:'rgba(239,68,68,.1)',color:'#ef4444',border:'1px solid rgba(239,68,68,.3)',borderRadius:8,padding:'10px 14px',fontSize:13,fontWeight:700,cursor:'pointer',fontFamily:'inherit'}}
                        >Cancel pass</button>
                      )}
                      {showTowActions && (() => {
                        // Per-row in-flight check — only the row whose
                        // action is currently being processed disables.
                        // Other rows stay tappable.
                        const rowBusy = submittingRowId === r.id;
                        return (
                          <>
                            <button
                              onClick={() => handleViolationAction('no-tow', { violation_id: openViolation?.id || null, pass_id: r.id, plate_text: r.plate_text }, '')}
                              disabled={rowBusy}
                              title="Truck left or you chose not to tow — closes without billing"
                              style={{minHeight:44,background:'var(--bg-inset)',color:'var(--text-primary)',border:'1px solid var(--border)',borderRadius:8,padding:'10px 14px',fontSize:13,fontWeight:700,cursor:rowBusy?'wait':'pointer',opacity:rowBusy?0.55:1,fontFamily:'inherit',display:'inline-flex',alignItems:'center',gap:6}}
                            >
                              <span aria-hidden="true">✖</span> No tow
                            </button>
                            <button
                              onClick={() => handleViolationAction('tow', { violation_id: openViolation?.id || null, pass_id: r.id, plate_text: r.plate_text }, '')}
                              disabled={rowBusy}
                              title="Confirm tow happened — releases billing for the partner"
                              style={{minHeight:44,background:'#ef4444',color:'#fff',border:'1px solid #ef4444',borderRadius:8,padding:'10px 14px',fontSize:13,fontWeight:800,cursor:rowBusy?'wait':'pointer',opacity:rowBusy?0.55:1,fontFamily:'inherit',display:'inline-flex',alignItems:'center',gap:6}}
                            >
                              Mark towed
                            </button>
                          </>
                        );
                      })()}
                    </div>
                  );
                })()}
              </div>
            );
          })}
        </div>
      )}

      {/* Pagination removed: we fetch up to 500 rows for the date window
          and filter client-side as the operator types, so server-side
          pages no longer apply. If a property genuinely sees >500 passes
          in a 7-day window we'll surface a warning and re-introduce paging. */}
      {/* Shown in BOTH modes. This was previously gated to History only, on
          the theory that a "showing 500 of 540" line would contradict the
          bucket cards — but the resolution chosen was to hide the discrepancy,
          which meant On Cooldown / Expiring counts silently undercounted past
          500 rows with no visible signal. An honest warning beats a quietly
          wrong bucket count on a surface that drives tow decisions. The
          roster union still guarantees currently-registered trucks appear. */}
      {!loading && total > rows.length && (
        <div style={{fontSize:11,color:'#facc15',padding:'8px 12px',background:'rgba(250,204,21,.08)',border:'1px solid rgba(250,204,21,.3)',borderRadius:8}}>
          {isHistory
            ? <>Showing {rows.length.toLocaleString()} of {total.toLocaleString()} passes. Search by plate, name, or company to find any specific registration.</>
            : <>This window holds more passes than the {rows.length.toLocaleString()} loaded — bucket counts may run low. Currently-registered trucks always appear; use History for the complete record.</>}
        </div>
      )}

      {cancelModal && (
        <ConfirmActionModal
          plate={cancelModal.plate_text}
          actionLabel="Cancel pass"
          description={<>Soft-cancels the active pass for <strong style={{color:'var(--text-primary)'}}>{cancelModal.plate_text}</strong>. The row stays in the log.</>}
          confirmLabel="Cancel pass"
          confirmColor="#ef4444"
          reasonPlaceholder="Reason (optional)"
          submitting={cancelling}
          onConfirm={(reason) => handleCancel(reason)}
          onCancel={() => { if (!cancelling) setCancelModal(null); }}
        />
      )}

      {/* Confirmation modal removed for tow/no-tow — these are one-tap
          actions. The Cancel pass modal above is kept because it's a
          different kind of action (operator-initiated on an active pass,
          not a response to an existing violation). */}
    </div>
  );
}

export default TruckParkingLog;
