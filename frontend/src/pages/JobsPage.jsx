import React from 'react';
const { useState, useEffect, useCallback, useRef, useMemo, memo } = React;
import { smartDate, elapsed, fmtMoney, fmtTime } from '../lib/format.js';
import { mapsLink } from '../lib/bundle.js';
import { displayColor, colorHex, cleanMmc } from '../lib/vehicles.js';
import { isVehicleInZone, matchViolationDetection } from '../lib/geometry.js';
import { supabase } from '../lib/supabase.js';
import { db } from '../lib/db.js';
import { haptic } from '../lib/notify.js';
import { SkeletonCards, SkeletonKPIs } from '../ui/Skeletons.jsx';
import { useToast } from '../ui/Toast.jsx';
import { SearchIcon } from '../ui/icons.jsx';
import { ViolationProofModal } from '../ui/ProofModal.jsx';
import { ViolationSnapshot } from '../ui/ViolationSnapshot.jsx';

// ── Jobs tab (current violations) ─────────────────────────────
export function JobsPage({ lots, violations, alprViolations = [], loading, lotStates, onAction, isOwner, deepLinkViolationId, user, onNavigate }) {
  const lotMap = Object.fromEntries(lots.map(l => [l.id, l]));
  const [selectedViol, setSelectedViol] = useState(null);

  const [acting, setActing] = useState(null);
  const actingRef = useRef(false); // Guard against double-tap race condition

  const { addToast } = useToast();


  // Auto-select violation from SMS deep link
  useEffect(() => {
    if (deepLinkViolationId && violations.length && !selectedViol) {
      const match = violations.find(v => v.id === deepLinkViolationId);
      if (match) {
        setSelectedViol(match);
        // Clear URL path so refresh doesn't re-trigger
        window.history.replaceState(null, '', '/');
      }
    }
  }, [deepLinkViolationId, violations, selectedViol]);

  // Map ALPR parking pass violations into a format compatible with violation cards
  const mappedAlpr = alprViolations.map(av => ({
    ...av,
    _isALPR: true,
    detected_at: av.created_at,
    // status mapping: 'pending' = newly fired, 'dispatched' = sent to partner & waiting,
    // 'acknowledged' = partner replied. Don't conflate dispatched with acknowledged —
    // the partner hasn't acted yet on a dispatched row.
    status: av.status === 'pending' ? 'alerted'
          : av.status === 'dispatched' ? 'dispatched'
          : av.status === 'acknowledged' ? 'acknowledged'
          : 'resolved',
    _origStatus: av.status,
    lot_id: null,
    _lot_name: av.properties?.name || 'Unknown Property',
    _snapshot_url: av.plate_events?.image_url || null,
    _paired_snapshot_url: av._paired_snapshot_url || null,
    _paired_camera_name: av._paired_camera_name || null,
    _detections: null,
    plate_text: av.plate_text,
    // MMC: prefer the violation row's own columns (filled by the
    // alpr_violation_fill_mmc trigger), fall back to the linked plate_event for
    // rows that predate the trigger. cleanMmc nulls onboard "-" / unknown noise.
    vehicle_color: cleanMmc(av.vehicle_color) ?? cleanMmc(av.plate_events?.vehicle_color),
    vehicle_type:  cleanMmc(av.vehicle_type)  ?? cleanMmc(av.plate_events?.vehicle_type),
    vehicle_make:  cleanMmc(av.vehicle_make)  ?? cleanMmc(av.plate_events?.vehicle_make),
    vehicle_model: cleanMmc(av.vehicle_model) ?? cleanMmc(av.plate_events?.vehicle_model),
    // Preserve the real DB violation_type so the Jobs-tab filters (Overstays /
    // Open Jobs) can split alpr_violations rows correctly. Forcing
    // 'parking_pass' here masked 'overstay' and 'cooldown', funneling everything
    // into Open Jobs and emptying the Overstays pill.
    violation_type: av.violation_type || 'parking_pass',
    zone_id: null, space_number: null,
    camera_id: av.plate_events?.camera_id || null,
    _camera_name: av.plate_events?.alpr_cameras?.name || null,
    _usdot_number: av.plate_events?.usdot_number || null,
    _mc_number: av.plate_events?.mc_number || null,
    confidence: av.plate_events?.confidence || null,
    our_revenue: 0, gross_revenue: 0,
    sms_sent_at: null, sms_delivered: null, reminder_sent_at: null,
    resolved_at: av.resolved_at || null, departed_at: null, cleared_at: null,
    // Carry the actual DB action_taken through verbatim. Do NOT infer from status —
    // a 'dispatched' row hasn't been acted on yet (action_taken is genuinely null).
    action_taken: av.action_taken ?? null,
  }));
  const allViolations = [...violations, ...mappedAlpr];

  // Active jobs = actionable violations (alerted/dispatched/acknowledged). Rows that
  // are still in the partner-awaiting state (alerted/dispatched without action_channel)
  // are rendered separately in the "X dispatches awaiting your response" block above,
  // so we exclude them here to avoid showing the same row twice on the page.
  const isPartnerAwaiting = (v) =>
    !v.action_channel && ['alerted', 'dispatched'].includes(v._origStatus || v.status);
  const active = allViolations
    .filter(v => ['alerted', 'dispatched', 'acknowledged'].includes(v.status))
    .filter(v => !(user?._role === 'partner' && isPartnerAwaiting(v)))
    .sort((a, b) => new Date(a.detected_at) - new Date(b.detected_at));

  // Recent = resolved/cleared today (calendar day)
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const todayCutoff = todayStart.getTime();
  const recent = allViolations
    .filter(v => ['resolved', 'cleared', 'departed'].includes(v.status) && new Date(v.resolved_at || v.departed_at || v.cleared_at || v.detected_at).getTime() >= todayCutoff)
    .sort((a, b) => new Date(b.resolved_at || b.departed_at || b.cleared_at || b.detected_at) - new Date(a.resolved_at || a.departed_at || a.cleared_at || a.detected_at));

  // KPIs
  const avgWaitMins = active.length > 0
    ? Math.round(active.reduce((s, v) => s + (Date.now() - new Date(v.detected_at)) / 60000, 0) / active.length)
    : 0;
  const todayResolved = recent.length;
  const todayRevenue = recent.reduce((s, v) => s + (v.our_revenue || 0), 0);

  // Build camera_id → zones lookup for matching detections to violations
  const allCams = Object.values(lotStates).flatMap(s => s?.cameras || []);
  const camZonesMap = useMemo(() => {
    const m = {};
    allCams.forEach(c => { if (c.zones?.length) m[c.camera_id] = c.zones; });
    return m;
  }, [lotStates]);

  // Live detection counts from lot states
  const liveVehicles = allCams.reduce((s, c) => s + (c.latest_snapshot?.vehicles_detected || c.latest_snapshot?.vehicle_count || 0), 0);
  const livePeople = allCams.reduce((s, c) => s + (c.latest_snapshot?.people_detected || c.latest_snapshot?.person_count || c.latest_snapshot?.humans_detected || 0), 0);
  // AI detection quality metrics
  const totalViols = [...active, ...recent];
  const violsWithColor = totalViols.filter(v => displayColor(v.vehicle_color));
  const colorDetRate = totalViols.length > 0 ? Math.round((violsWithColor.length / totalViols.length) * 100) : null;
  const violsWithType = totalViols.filter(v => v.vehicle_type && v.vehicle_type !== 'car');
  const typeDetRate = totalViols.length > 0 ? Math.round((violsWithType.length / totalViols.length) * 100) : null;
  const aiHealthScore = totalViols.length > 0
    ? Math.round(((colorDetRate || 0) * 0.6 + (typeDetRate || 0) * 0.4))
    : null;

  const actionLabels = { boot: 'Boot', tow: 'Tow', dismissed: 'Dismiss', already_gone: 'Already Gone', no_action: 'No Action' };
  const actionColors = { boot: '#fbbf24', tow: '#ef4444', dismissed: '#a78bfa', already_gone: '#6b7280', no_action: '#6b7280' };

  // Status badge config for dedup state machine
  const statusBadge = {
    alerted:      { label: 'Active',         color: '#ef4444', bg: 'rgba(239,68,68,.12)',  icon: '●' },
    pending:      { label: 'Active',         color: '#ef4444', bg: 'rgba(239,68,68,.12)',  icon: '●' },
    dispatched:   { label: 'Awaiting tow co', color: '#fbbf24', bg: 'rgba(251,191,36,.14)', icon: '🟠' },
    acknowledged: { label: 'Acknowledged',   color: '#f59e0b', bg: 'rgba(245,158,11,.12)', icon: '🟡' },
    cleared:      { label: 'Cleared',      color: '#4ade80', bg: 'rgba(74,222,128,.12)', icon: '✓' },
    resolved:     { label: 'Resolved',     color: '#4ade80', bg: 'rgba(74,222,128,.12)', icon: '✓' },
    departed:     { label: 'Cancelled — Vehicle Left', color: '#6b7280', bg: 'rgba(107,114,128,.12)', icon: '🚫' },
  };

  const [acking, setAcking] = useState(null);

  async function handleAcknowledge(violId) {
    if (actingRef.current) return;
    actingRef.current = true;
    setAcking(violId);
    try {
      await db.acknowledgeViolation(violId);
      addToast('Acknowledged — no more alerts until zone clears', 'success');
      if (onAction) onAction();
    } catch (e) {
      addToast('Acknowledge failed: ' + (e.message || 'Unknown error'), 'error');
    } finally { setAcking(null); actingRef.current = false; }
  }

  async function handleAction(violId, action) {
    // Guard against double-tap: if already processing any action, bail out
    if (actingRef.current) return;
    actingRef.current = true;
    setSelectedViol(null);
    setActing(violId);
    try {
      // ALPR dispatches and legacy YOLO violations live in different tables.
      // The merged list marks ALPR rows with _isALPR — route them through the
      // dedicated alpr_violations updaters; falling back to db.recordAction
      // would silently update zero rows in the legacy `violations` table.
      const target = allViolations.find(v => v.id === violId);
      const isAlpr = !!target?._isALPR;
      if (isAlpr) {
        if (action === 'tow') {
          await db.dispatchALPRViolation(violId);
        } else {
          // Everything else from this surface (No-tow, dismiss, already_gone,
          // no_action) collapses to no_tow on the ALPR row.
          await db.dismissALPRViolation(violId, `Operator action: ${action}`);
        }
        addToast(`${actionLabels[action] || action} recorded`, 'success');
        if (onAction) onAction();
        return;
      }

      const extra = {};
      // Pass fee schedule for revenue calculation on boot/tow
      if ((action === 'boot' || action === 'tow') && user) {
        extra._performerEmail = user.email;
        if (user._role === 'partner') {
          extra._partner = { id: user.id, boot_fee: user.boot_fee, tow_fee: user.tow_fee, revenue_share: user.revenue_share };
        } else {
          // Owner acting directly — record gross revenue with 100% to LotLogic (no partner split)
          extra._ownerFees = { boot_fee: 75, tow_fee: 250 };
          extra._ownerId = user.id;
        }
      }
      const result = await db.recordAction(violId, action, extra);
      if (result && result.success !== false) {
        addToast(`${actionLabels[action] || action} recorded`, 'success');
      }
      if (onAction) onAction();
    } catch (e) {
      console.error('handleAction error:', e);
      const msg = e.status === 409 ? 'Already resolved' : (e.message || 'Unknown error');
      addToast(`Action failed: ${msg}`, 'error');
      if (onAction) onAction();
    } finally { setActing(null); actingRef.current = false; }
  }

  function requestAction(violId, action) {
    haptic(action === 'tow' ? 'heavy' : action === 'boot' ? 'medium' : 'light');
    handleAction(violId, action);
  }

  // Smart departure detection: require 3 consecutive empty snapshots before flagging
  // Flags as "departed" (stays on dashboard) — does NOT auto-resolve
  const departedFlaggedRef = useRef(new Set());     // violations already flagged as departed
  const emptyStreakRef = useRef({});                 // violationId -> { count, lastSnapshotTime }
  const DEPARTED_STREAK = 3;                        // consecutive empty snapshots required (~1.5min at 30s intervals)

  // Auto-recover false departures: if backend marked departed but car is still in zone, re-alert
  const recoveredRef = useRef(new Set());
  useEffect(() => {
    if (!allCams.length) return;
    for (const v of violations) {
      if (v.status !== 'departed' || !v.zone_id || recoveredRef.current.has(v.id)) continue;
      const cam = allCams.find(c => c.camera_id === v.camera_id);
      if (!cam?.latest_snapshot) continue;
      const dets = cam.latest_snapshot.detections || [];
      const zones = camZonesMap[v.camera_id] || [];
      const stillThere = isVehicleInZone(dets, v.zone_id, zones);
      if (stillThere === true) {
        recoveredRef.current.add(v.id);
        departedFlaggedRef.current.delete(v.id);
        delete emptyStreakRef.current[v.id];
        if (supabase) {
          supabase.from('violations').update({
            status: 'alerted', departed_at: null, empty_streak: 0
          }).eq('id', v.id).then(() => {
            if (window.LOTLOGIC_DEBUG) console.log(`Auto-recovered false departure: ${v.id}, zone ${v.zone_id}`);
            if (onAction) onAction();
          });
        }
      }
    }
    // Clean recovered set for violations no longer in list
    const allIds = new Set(violations.map(v => v.id));
    for (const id of recoveredRef.current) { if (!allIds.has(id)) recoveredRef.current.delete(id); }
  }, [violations, allCams, camZonesMap]);

  useEffect(() => {
    if (!active.length || !allCams.length) return;
    for (const v of active) {
      // Skip if already flagged as departed (in DB or locally)
      if (v.status === 'departed' || v.departed_at || departedFlaggedRef.current.has(v.id)) continue;

      const cam = allCams.find(c => c.camera_id === v.camera_id);
      if (!cam?.latest_snapshot) continue;

      const dets = cam.latest_snapshot.detections || [];
      const zones = camZonesMap[v.camera_id] || [];
      const snapTime = cam.latest_snapshot.captured_at || null;
      const gone = isVehicleInZone(dets, v.zone_id, zones);

      const streak = emptyStreakRef.current[v.id] || { count: 0, lastSnapshotTime: null };

      if (gone === false) {
        // Only count if this is a different snapshot than the last one we checked
        if (snapTime && snapTime !== streak.lastSnapshotTime) {
          streak.count++;
          streak.lastSnapshotTime = snapTime;
        }
        emptyStreakRef.current[v.id] = streak;

        if (streak.count >= DEPARTED_STREAK) {
          departedFlaggedRef.current.add(v.id);
          if (window.LOTLOGIC_DEBUG) console.log(`Vehicle departed — violation ${v.id}, zone ${v.zone_id}, ${streak.count} consecutive empty snapshots`);
          db.markDeparted(v.id, streak.count);
        }
      } else if (gone === true) {
        // Vehicle confirmed in zone — reset streak
        emptyStreakRef.current[v.id] = { count: 0, lastSnapshotTime: null };
      }
      // gone === null (inconclusive / missing data) — don't reset streak, just skip
    }
    // Clean up streaks for violations no longer active
    const activeIds = new Set(active.map(v => v.id));
    for (const id of Object.keys(emptyStreakRef.current)) {
      if (!activeIds.has(id)) delete emptyStreakRef.current[id];
    }
  }, [active, allCams, camZonesMap]);

  // Auto-dismiss stale violations:
  // 1. Violations older than 2h with no acknowledgment → auto-depart
  // 2. Violations already flagged as departed → auto-resolve after 30s grace period
  const autoDismissedRef = useRef(new Set());
  const STALE_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours
  const DEPARTED_AUTO_DISMISS_MS = 30 * 1000; // 30s after departure confirmed
  const departedTimersRef = useRef({}); // violId -> timestamp when departure was first flagged

  useEffect(() => {
    if (!active.length) return;
    const now = Date.now();
    for (const v of active) {
      if (autoDismissedRef.current.has(v.id)) continue;

      // Age-based: alerted for 2+ hours with no acknowledgment
      if (v.status === 'alerted' && !v.acknowledged_at) {
        const age = now - new Date(v.detected_at).getTime();
        if (age > STALE_AGE_MS) {
          autoDismissedRef.current.add(v.id);
          if (window.LOTLOGIC_DEBUG) console.log(`Auto-dismissing stale violation ${v.id}: ${Math.round(age / 60000)}m old, no acknowledgment`);
          db.markDeparted(v.id, 0);
          continue;
        }
      }

      // Departure-confirmed: auto-resolve 30s after departure flagged
      const isDeparted = v.status === 'departed' || v.departed_at || departedFlaggedRef.current.has(v.id);
      if (isDeparted) {
        if (!departedTimersRef.current[v.id]) {
          departedTimersRef.current[v.id] = now;
        } else if (now - departedTimersRef.current[v.id] > DEPARTED_AUTO_DISMISS_MS) {
          autoDismissedRef.current.add(v.id);
          delete departedTimersRef.current[v.id];
          if (window.LOTLOGIC_DEBUG) console.log(`Auto-resolving departed violation ${v.id} after grace period`);
          db.recordAction(v.id, 'already_gone', {}).catch(e => console.warn('Auto-dismiss failed:', e));
          continue;
        }
      } else {
        delete departedTimersRef.current[v.id]; // Reset if vehicle came back
      }
    }
    // Cleanup refs for removed violations
    const activeIds = new Set(active.map(v => v.id));
    for (const id of autoDismissedRef.current) { if (!activeIds.has(id)) autoDismissedRef.current.delete(id); }
    for (const id of Object.keys(departedTimersRef.current)) { if (!activeIds.has(id)) delete departedTimersRef.current[id]; }
  }, [active]);

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all'); // all | nreg | overstays | open | handled

  const isOverstay = (v) => (v.violation_type || '').toLowerCase().includes('overstay');

  // Partner-awaiting rows (dispatched, no Tow/No-tow recorded yet) live in their
  // own "awaiting your response" block above and are excluded from `active`. But
  // the pills + search must still apply to them, AND the pill COUNTS must include
  // them — otherwise "Open jobs" reads 0 while 16 dispatches sit above unhandled.
  // So count + filter over the full open universe (awaiting + in-progress).
  const awaitingRaw = allViolations.filter(isPartnerAwaiting);
  const openUniverse = user?._role === 'partner' ? [...awaitingRaw, ...active] : active;

  // Derived lists per filter (counts span the full open universe)
  const overstayJobs = openUniverse.filter(isOverstay);
  const openJobs = openUniverse.filter(v => !v._isNoReg && !isOverstay(v));
  // "Handled today" = resolved/cleared/towed today
  const todayStartMs = (() => { const d = new Date(); d.setHours(0,0,0,0); return d.getTime(); })();
  const handledToday = allViolations.filter(v =>
    ['resolved','cleared','departed','dismissed'].includes(v.status) &&
    new Date(v.resolved_at || v.departed_at || v.cleared_at || v.detected_at).getTime() >= todayStartMs
  );

  // Plate matching needs the same normalization the QR forms use on
  // registration: uppercase, strip non-alphanumeric. Without this, typing
  // "abc 1234" wouldn't match the stored "ABC1234". ≥2 alphanumeric
  // characters required so a stray "a" doesn't match every plate with
  // an A in it. Mirrors the TruckParkingLog smart-search rule.
  const matchesSearch = (v) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    const qPlate = q.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const normPlate = (v.plate_text || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return (qPlate.length >= 2 && normPlate.includes(qPlate)) ||
      (v.vehicle_color?.toLowerCase().includes(q)) ||
      (v.vehicle_type?.toLowerCase().includes(q)) ||
      (v.vehicle_make?.toLowerCase().includes(q)) ||
      (v.vehicle_model?.toLowerCase().includes(q)) ||
      (lotMap[v.lot_id]?.name?.toLowerCase().includes(q)) ||
      (v._lot_name?.toLowerCase().includes(q)) ||
      (v._camera_name?.toLowerCase().includes(q)) ||
      (v.zone_id?.toLowerCase().includes(q));
  };
  // Pill predicate for the awaiting + in-progress lists. 'handled' swaps in its
  // own source list, so it isn't a predicate here.
  const matchesPill = (v) =>
    filter === 'overstays' ? isOverstay(v)
    : filter === 'open' ? (!v._isNoReg && !isOverstay(v))
    : true; // 'all'

  // In-progress list: 'handled' shows handledToday; otherwise the active list
  // narrowed by the pill. Search applies in every case.
  const filteredActive = (filter === 'handled' ? handledToday : active.filter(matchesPill))
    .filter(matchesSearch);
  // Awaiting block, narrowed by the same pill + search. 'handled' hides it
  // (an awaiting dispatch is by definition not yet handled).
  const filteredAwaiting = filter === 'handled'
    ? []
    : awaitingRaw.filter(matchesPill).filter(matchesSearch);

  if (loading && violations.length === 0) {
    return <div className="page-enter"><SkeletonKPIs /><SkeletonCards count={4} /></div>;
  }

  return (
    <div className="page-enter">
      {/* KPI bar */}
      <div className="kpi-bar">
        <div className="kpi-card">
          <div className={`kpi-val ${active.length > 0 ? 'red' : 'green'}`}>{active.length}</div>
          <div className="kpi-label">Active</div>
        </div>
        <div className="kpi-card">
          <div className={`kpi-val ${avgWaitMins >= 45 ? 'red' : 'blue'}`}>{avgWaitMins}<span style={{fontSize:12}}>m</span></div>
          <div className="kpi-label">Avg Wait</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-val green">{todayResolved}</div>
          <div className="kpi-label">Today</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-val green">{fmtMoney(todayRevenue)}</div>
          <div className="kpi-label">Earned</div>
        </div>
      </div>

      {/* Live detection bar */}
      {(liveVehicles > 0 || livePeople > 0) && (
        <div style={{display:'flex', gap:8, marginBottom:14, flexWrap:'wrap'}}>
          <div className="cam-det-chip" style={{padding:'5px 10px'}}>
            <span className="det-dot vehicles" /> {liveVehicles} vehicle{liveVehicles !== 1 ? 's' : ''} tracked
          </div>
          <div className="cam-det-chip" style={{padding:'5px 10px'}}>
            <span className="det-dot people" /> {livePeople} {livePeople === 1 ? 'person' : 'people'} tracked
          </div>
          {colorDetRate != null && (
            <div className="cam-det-chip" style={{padding:'5px 10px', background: colorDetRate >= 60 ? 'rgba(74,222,128,.08)' : colorDetRate >= 30 ? 'rgba(251,191,36,.08)' : 'rgba(239,68,68,.08)', border: `1px solid ${colorDetRate >= 60 ? 'rgba(74,222,128,.2)' : colorDetRate >= 30 ? 'rgba(251,191,36,.2)' : 'rgba(239,68,68,.2)'}`}}>
              <span style={{width:7, height:7, borderRadius:'50%', background: colorDetRate >= 60 ? '#4ade80' : colorDetRate >= 30 ? '#fbbf24' : '#ef4444', flexShrink:0}} /> {colorDetRate}% color detected
            </div>
          )}
        </div>
      )}

      {/* AI Detection Health banner - only show for owners when quality is poor */}
      {isOwner && aiHealthScore != null && aiHealthScore < 50 && (
        <div style={{
          background:'rgba(245,158,11,.06)', border:'1px solid rgba(245,158,11,.2)', borderRadius:10,
          padding:'10px 14px', marginBottom:14, display:'flex', alignItems:'flex-start', gap:10
        }}>
          <div style={{fontSize:16, flexShrink:0, marginTop:1}}>⚠</div>
          <div>
            <div style={{fontSize:13, fontWeight:700, color:'#f59e0b', marginBottom:2}}>AI Detection Quality: {aiHealthScore}%</div>
            <div style={{fontSize:11, color:'#92400e', lineHeight:1.4}}>
              {(colorDetRate || 0) < 30 && 'Color detection is low — may improve with higher resolution snapshots. '}
              {violsWithType.length === 0 && 'Vehicle types show as "car" — finer classification (sedan/SUV/truck) may improve with higher resolution. '}
            </div>
          </div>
        </div>
      )}

      {/* Search and filter */}
      {(active.length > 0 || awaitingRaw.length > 0 || handledToday.length > 0) && (
        <div className="search-bar">
          <div className="search-wrap">
            <SearchIcon />
            <input className="search-input" placeholder="Search plate, color, type, make, lot, camera…" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        </div>
      )}
      {/* Filter pill row — brand-v2 style, horizontally scrollable */}
      {(active.length > 0 || awaitingRaw.length > 0 || handledToday.length > 0) && (
        <div className="filter-bar-paper" style={{marginBottom:8}}>
          <button className={`filter-pill-paper${filter === 'all' ? ' active' : ''}`} onClick={() => setFilter('all')}>
            All<span className="n">{openUniverse.length + handledToday.length}</span>
          </button>
          <button className={`filter-pill-paper${filter === 'overstays' ? ' active' : ''}`} onClick={() => setFilter('overstays')}>
            Overstays<span className="n">{overstayJobs.length}</span>
          </button>
          <button className={`filter-pill-paper${filter === 'open' ? ' active' : ''}`} onClick={() => setFilter('open')}>
            Open jobs<span className="n">{openJobs.length}</span>
          </button>
          <button className={`filter-pill-paper${filter === 'handled' ? ' active' : ''}`} onClick={() => setFilter('handled')}>
            Handled today<span className="n">{handledToday.length}</span>
          </button>
        </div>
      )}

      {/* Partner: persistent yellow nudge if they haven't registered tow-truck plates.
          Without plates, every tow requires manual owner confirmation before billing releases. */}
      {user?._role === 'partner' && ((user?.tow_truck_plates?.length ?? 0) === 0) && (
        <div style={{
          background:'rgba(251,191,36,.08)', border:'1px solid rgba(251,191,36,.3)', borderRadius:10,
          padding:'10px 14px', marginBottom:14, display:'flex', alignItems:'flex-start', gap:10,
        }} role="status">
          <div style={{fontSize:16, flexShrink:0, marginTop:1}} aria-hidden="true">⚠</div>
          <div style={{flex:1, minWidth:0}}>
            <div style={{fontSize:13, fontWeight:700, color:'#fbbf24', marginBottom:2}}>
              Add your tow-truck plates so billing auto-releases after each tow.
            </div>
            <div style={{fontSize:11, color:'var(--text-muted)', lineHeight:1.4}}>
              Without plates, every tow has to be confirmed manually by the property owner before we can bill.
            </div>
          </div>
          <button
            onClick={() => {
              if (onNavigate) onNavigate('account');
              // Wait for the Account tab to mount, then scroll to the plates editor.
              setTimeout(() => {
                const el = document.getElementById('tow-truck-plates');
                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }, 80);
            }}
            style={{
              fontSize:12, padding:'6px 12px', borderRadius:6, cursor:'pointer', fontWeight:700,
              border:'1px solid rgba(251,191,36,.5)', background:'rgba(251,191,36,.12)',
              color:'#fbbf24', whiteSpace:'nowrap', flexShrink:0,
            }}
          >Add plates →</button>
        </div>
      )}

      {/* Partner "Awaiting your response" queue — dispatches where we haven't recorded any
          action (action_channel is null) and the row is still alerted/dispatched. Distinct from
          the general Open Jobs list so partners see exactly what the dispatch system is waiting on. */}
      {user?._role === 'partner' && (() => {
        const awaiting = filteredAwaiting;
        if (awaiting.length === 0) return null;
        return (
          <div style={{marginBottom:18}}>
            <div className="section-header">
              <div className="section-title" style={{color:'#fbbf24'}}>
                {awaiting.length} dispatch{awaiting.length === 1 ? '' : 'es'} awaiting your response
              </div>
              <div className="section-count">{awaiting.length}</div>
            </div>
            <div style={{fontSize:12,color:'var(--text-muted)',marginBottom:8,lineHeight:1.4}}>
              LotLogic spotted a vehicle without a valid parking pass and sent it to your team.
              Tap <b>Tow</b> to dispatch a truck, or <b>No-tow</b> to skip. The job will then move
              into the In&nbsp;Progress list below until our cameras confirm the outcome.
            </div>
            <div style={{display:'flex', flexDirection:'column', gap:8}}>
              {awaiting.map(v => {
                const isActing = acting === v.id;
                const anyActing = acting !== null;
                const lotName = lotMap[v.lot_id]?.name || v._lot_name || '—';
                const dispatchedAt = v.dispatched_at || v.created_at || v.detected_at;
                // Car identity our cameras captured — helps the partner recognize
                // the vehicle before dispatching. "car" is too generic to show.
                const vehicleDesc = [v.vehicle_color, v.vehicle_type && v.vehicle_type !== 'car' ? v.vehicle_type : null, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ');
                return (
                  <div key={'awaiting-' + v.id} style={{
                    background:'var(--bg-card)', border:'1px solid rgba(251,191,36,.25)',
                    borderRadius:10, padding:'10px 12px',
                    display:'flex', flexWrap:'wrap', alignItems:'center', gap:10,
                  }}>
                    {v._snapshot_url && (
                      <img src={v._snapshot_url} alt={`Vehicle ${v.plate_text || ''}`} loading="lazy"
                        style={{width:56, height:56, objectFit:'cover', borderRadius:8, border:'1px solid var(--border)', flexShrink:0}} />
                    )}
                    <div style={{flex:1, minWidth:180}}>
                      <div style={{display:'flex', alignItems:'center', gap:8, flexWrap:'wrap', marginBottom:4}}>
                        <span style={{
                          fontFamily:'ui-monospace, Menlo, monospace', fontSize:13, fontWeight:700,
                          background:'var(--bg-inset)', padding:'2px 8px', borderRadius:6,
                          border:'1px solid var(--border)', color:'var(--text-primary)',
                        }}>{v.plate_text || '—'}</span>
                        <span style={{fontSize:12, color:'var(--text-secondary)'}}>{lotName}</span>
                      </div>
                      {vehicleDesc && (
                        <div style={{display:'flex', alignItems:'center', gap:6, fontSize:11, color:'var(--text-secondary)', textTransform:'capitalize', marginBottom:3}}>
                          {displayColor(v.vehicle_color) && <span style={{width:8, height:8, borderRadius:3, background:colorHex(v.vehicle_color), border:'1px solid rgba(128,128,128,.3)', flexShrink:0}} />}
                          {vehicleDesc}
                        </div>
                      )}
                      <div style={{fontSize:11, color:'var(--text-faint)'}}>
                        Dispatched {dispatchedAt ? fmtTime(dispatchedAt) : '—'}
                      </div>
                    </div>
                    <div style={{display:'flex', gap:6, flexShrink:0}}>
                      <button
                        onClick={() => requestAction(v.id, 'tow')}
                        disabled={anyActing}
                        style={{
                          fontSize:12, padding:'6px 12px', borderRadius:6, fontWeight:700,
                          border:'1px solid #ef4444', background:'#ef4444', color:'#fff',
                          cursor: anyActing ? 'wait' : 'pointer', opacity: anyActing ? 0.6 : 1,
                        }}
                      >{isActing ? '…' : 'Tow'}</button>
                      <button
                        onClick={() => requestAction(v.id, 'no_action')}
                        disabled={anyActing}
                        style={{
                          fontSize:12, padding:'6px 12px', borderRadius:6, fontWeight:600,
                          border:'1px solid var(--border)', background:'transparent', color:'var(--text-primary)',
                          cursor: anyActing ? 'wait' : 'pointer', opacity: anyActing ? 0.6 : 1,
                        }}
                      >{isActing ? '…' : 'No-tow'}</button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Active jobs */}
      <div className="section-header">
        <div className="section-title">
          {filter === 'overstays' ? 'Overstays'
            : filter === 'open' ? 'Open Jobs'
            : filter === 'handled' ? 'Handled Today'
            : (user?._role === 'partner' ? 'In progress' : 'All Jobs')}
        </div>
        <div className="section-count">{filteredActive.length}</div>
      </div>
      {filter === 'all' && (
        <div style={{fontSize:12,color:'var(--text-muted)',margin:'0 0 10px',lineHeight:1.4}}>
          {user?._role === 'partner' ? (
            <>Dispatches your team has already responded to. They'll auto-close once our cameras confirm the tow or the vehicle leaves. This list does <b>not</b> include items still awaiting your Tow / No-tow decision — those live above.</>
          ) : (
            <>Active jobs at your lots that haven't been resolved yet. Includes dispatches in flight to your tow partner plus anything that hasn't been acted on.</>
          )}
        </div>
      )}
      {filter === 'open' && (
        <div style={{fontSize:12,color:'var(--text-muted)',margin:'0 0 10px',lineHeight:1.4}}>
          Active jobs that aren't overstays and don't fall under <i>Possible no parking pass</i>.
        </div>
      )}
      {filter === 'overstays' && (
        <div style={{fontSize:12,color:'var(--text-muted)',margin:'0 0 10px',lineHeight:1.4}}>
          Vehicles that had a parking pass but stayed past <code>valid_until</code>.
        </div>
      )}
      {filter === 'handled' && (
        <div style={{fontSize:12,color:'var(--text-muted)',margin:'0 0 10px',lineHeight:1.4}}>
          Resolved, cleared, departed, or dismissed today.
        </div>
      )}

      {filteredActive.length === 0 && active.length > 0 ? (
        <div className="empty-state" style={{marginBottom: 28, padding:'30px 20px'}}>
          <div className="empty-title">No matches</div>
          <div className="empty-body">Try adjusting your search or filter</div>
        </div>
      ) : filteredActive.length === 0 ? (
        <div className="empty-state" style={{marginBottom: 28}}>
          <div style={{width:48, height:48, borderRadius:12, background:'rgba(74,222,128,.1)', display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 12px', fontSize:22}}>✓</div>
          <div className="empty-title">All clear</div>
          <div className="empty-body">
            {user?._role === 'partner'
              ? "No in-progress jobs right now. New dispatches will show above when LotLogic sends them."
              : "Nothing pending at your lots right now"}
          </div>
          {/* Partner-only orientation mini-explainer. Owners see the existing empty state unchanged. */}
          {user?._role === 'partner' && (
            <div style={{
              marginTop:20, paddingTop:20, borderTop:'1px solid var(--border)',
              display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(180px, 1fr))', gap:14,
              textAlign:'left',
            }}>
              <div>
                <div style={{fontSize:12, fontWeight:700, color:'var(--text-primary)', marginBottom:4}}>
                  How a dispatch arrives
                </div>
                <div style={{fontSize:12, color:'var(--text-muted)', lineHeight:1.5}}>
                  SMS or email with plate + lot. Click the link to open this app on the job.
                </div>
              </div>
              <div>
                <div style={{fontSize:12, fontWeight:700, color:'var(--text-primary)', marginBottom:4}}>
                  What you'll do
                </div>
                <div style={{fontSize:12, color:'var(--text-muted)', lineHeight:1.5}}>
                  Tap Tow or Boot. Our cameras confirm the tow-plate sighting automatically.
                </div>
              </div>
              <div>
                <div style={{fontSize:12, fontWeight:700, color:'var(--text-primary)', marginBottom:4}}>
                  After the tow
                </div>
                <div style={{fontSize:12, color:'var(--text-muted)', lineHeight:1.5}}>
                  Our cameras confirm your truck on-site and close the job automatically. We handle the rest.
                </div>
              </div>
            </div>
          )}
        </div>
      ) : (
        filteredActive.map((v, idx) => {
          const lot = lotMap[v.lot_id];
          const timer = elapsed(v.detected_at);
          const urgent = timer?.val >= 45;
          const isActing = acting === v.id;
          const anyActing = acting !== null; // Disable all buttons when any action in flight
          const typeClass = v.violation_type?.toLowerCase().includes('unauthorized')
            ? 'unauthorized' : v.violation_type?.toLowerCase().includes('cooldown')
            ? 'unauthorized' : v.violation_type?.toLowerCase().includes('overtime')
            ? 'overtime' : v.violation_type?.toLowerCase().includes('overstay')
            ? 'overtime' : 'default';
          return (
            <div key={v.id} className={`job-card card-animated ${urgent ? 'urgent' : ''} ${(v.status === 'departed' || v.departed_at || departedFlaggedRef.current.has(v.id)) ? 'departed' : ''}`} style={{position:'relative', cursor:'pointer'}} onClick={(e) => {
              // Open the detail modal when the card body is tapped. Action
              // buttons inside the card stopPropagation themselves so this
              // only fires on non-button areas.
              if (e.target.closest('button') || e.target.closest('a')) return;
              setSelectedViol(v);
            }}>
              {/* Lifecycle stripe for ALPR / no-reg rows — left-edge color indicator */}
              {(v._isNoReg || v._isALPR) && (() => {
                const stripeColor = v._isNoReg
                  ? (v._origStatus === 'flagged' ? 'var(--red-paper)' : 'var(--amber-paper)')
                  : (v._origStatus === 'pending' || v._origStatus === 'dispatched' ? 'var(--amber-paper)'
                    : v._origStatus === 'resolved' ? 'var(--green-paper)'
                    : 'var(--ink-4-paper)');
                return (
                  <div aria-hidden="true" style={{
                    position:'absolute', left:0, top:8, bottom:8,
                    width:4, borderRadius:'0 4px 4px 0', background:stripeColor, zIndex:2,
                  }} />
                );
              })()}
              {/* Owner delete X */}
              {isOwner && (
                <button
                  onClick={async (e) => {
                    e.stopPropagation();
                    try {
                      await db.deleteViolation(v.id, !!v._isALPR);
                      addToast('Job deleted', 'success');
                      if (onAction) onAction();
                    } catch (err) {
                      addToast('Failed to delete: ' + (err.message || 'Unknown error'), 'error');
                    }
                  }}
                  style={{
                    position:'absolute', top:8, right:8, zIndex:5, width:28, height:28, borderRadius:'50%',
                    background:'rgba(0,0,0,.5)', backdropFilter:'blur(4px)', border:'none', cursor:'pointer',
                    display:'flex', alignItems:'center', justifyContent:'center', padding:0,
                  }}
                  aria-label="Delete job"
                  title="Delete job"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="3" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              )}
              {urgent && (
                <div className="job-urgent-bar">
                  <span style={{display:'inline-block', width:6, height:6, borderRadius:'50%', background:'#fff', animation:'pulse-dot 1.5s infinite'}} />
                  Needs attention — waiting {timer.val} {timer.unit}
                </div>
              )}
              {/* Snapshot photo with single bounding box on violating vehicle */}
              <ViolationSnapshot src={v._snapshot_url} detections={v._detections} matchedDetection={matchViolationDetection(v._detections, v.zone_id, camZonesMap[v.camera_id])} maxHeight={220} borderRadius={0} onClick={v._snapshot_url ? () => setSelectedViol(v) : undefined} />
              {/* Paired-camera snapshot — the second camera at the same gate that
                  fired around the same time. Helps operator visually verify a real
                  paired transit before dispatching. */}
              {v._paired_snapshot_url && (
                <div style={{borderTop:'1px solid rgba(255,255,255,.06)'}}>
                  <div style={{fontSize:10, color:'var(--text-muted)', padding:'6px 12px', letterSpacing:'.06em', textTransform:'uppercase', fontWeight:700}}>
                    Paired camera{v._paired_camera_name ? ` — ${v._paired_camera_name}` : ''}
                  </div>
                  <ViolationSnapshot src={v._paired_snapshot_url} maxHeight={160} borderRadius={0} />
                </div>
              )}
              {/* Live vehicle presence indicator */}
              {(() => {
                const isDeparted = v.status === 'departed' || v.departed_at || departedFlaggedRef.current.has(v.id);
                const streak = emptyStreakRef.current[v.id]?.count || 0;
                const verifying = !isDeparted && streak > 0;

                if (isDeparted) {
                  const departedAgo = v.departed_at
                    ? Math.round((Date.now() - new Date(v.departed_at).getTime()) / 60000)
                    : null;
                  return (
                    <div style={{
                      background:'rgba(34,197,94,.15)', borderBottom:'1px solid rgba(34,197,94,.3)',
                      padding:'8px 16px', display:'flex', alignItems:'center', justifyContent:'space-between', gap:8,
                    }}>
                      <span style={{color:'#4ade80', fontSize:12, fontWeight:700, display:'flex', alignItems:'center', gap:6}}>
                        <span style={{fontSize:14}}>&#x2714;</span>
                        Vehicle left{departedAgo != null && departedAgo > 0 ? ` ${departedAgo}m ago` : ''}
                      </span>
                      <button onClick={(e) => { e.stopPropagation(); requestAction(v.id, 'already_gone'); }} disabled={anyActing} style={{
                        background:'rgba(34,197,94,.2)', color:'#4ade80', border:'1px solid rgba(34,197,94,.3)', borderRadius:6,
                        padding:'4px 12px', fontSize:11, fontWeight:700, cursor: anyActing ? 'not-allowed' : 'pointer',
                      }}>Dismiss</button>
                    </div>
                  );
                }
                if (verifying) {
                  const pct = Math.min(100, Math.round((streak / DEPARTED_STREAK) * 100));
                  return (
                    <div style={{
                      background:'rgba(251,191,36,.08)', borderBottom:'1px solid rgba(251,191,36,.2)',
                      padding:'6px 16px', display:'flex', flexDirection:'column', gap:4,
                    }}>
                      <span style={{color:'#fbbf24', fontSize:11, fontWeight:600, display:'flex', alignItems:'center', gap:6}}>
                        <div className="spin" style={{width:10, height:10, borderWidth:2}} />
                        Checking if vehicle left ({streak}/{DEPARTED_STREAK})
                      </span>
                      <div style={{height:2, borderRadius:2, background:'rgba(251,191,36,.15)', overflow:'hidden'}}>
                        <div style={{height:'100%', width:`${pct}%`, background:'#fbbf24', borderRadius:2, transition:'width .3s ease'}} />
                      </div>
                    </div>
                  );
                }
                // Live presence check — show vehicle still detected in zone
                const cam = allCams.find(c => c.camera_id === v.camera_id);
                const presence = cam?.latest_snapshot ? isVehicleInZone(
                  cam.latest_snapshot.detections || [],
                  v.zone_id,
                  camZonesMap[v.camera_id] || []
                ) : null;
                const snapAge = cam?.latest_snapshot?.captured_at
                  ? Math.round((Date.now() - new Date(cam.latest_snapshot.captured_at).getTime()) / 1000)
                  : null;
                const snapAgeLabel = snapAge != null
                  ? (snapAge < 60 ? `${snapAge}s ago` : `${Math.round(snapAge / 60)}m ago`)
                  : null;
                if (presence === true) {
                  return (
                    <div style={{
                      background:'rgba(239,68,68,.06)', borderBottom:'1px solid rgba(239,68,68,.15)',
                      padding:'6px 16px', display:'flex', alignItems:'center', gap:6,
                    }}>
                      <span style={{width:6, height:6, borderRadius:'50%', background:'#ef4444', flexShrink:0, animation:'pulse-dot 1.5s infinite'}} />
                      <span style={{color:'rgba(239,68,68,.8)', fontSize:11, fontWeight:600}}>Vehicle still in zone</span>
                      {snapAgeLabel && <span style={{color:'rgba(255,255,255,.3)', fontSize:10, marginLeft:'auto'}}>{snapAgeLabel}</span>}
                    </div>
                  );
                }
                if (presence === false) {
                  return (
                    <div style={{
                      background:'rgba(251,191,36,.06)', borderBottom:'1px solid rgba(251,191,36,.15)',
                      padding:'6px 16px', display:'flex', alignItems:'center', gap:6,
                    }}>
                      <div className="spin" style={{width:8, height:8, borderWidth:2, flexShrink:0}} />
                      <span style={{color:'rgba(251,191,36,.8)', fontSize:11, fontWeight:600}}>Vehicle not detected — verifying...</span>
                      {snapAgeLabel && <span style={{color:'rgba(255,255,255,.3)', fontSize:10, marginLeft:'auto'}}>{snapAgeLabel}</span>}
                    </div>
                  );
                }
                return null;
              })()}
              {/* Vehicle summary bar — quick-glance info for the tow operator */}
              <div className="vehicle-summary">
                {v._isNoReg ? (
                  <span className="vs-item">
                    <span style={{fontWeight:800, letterSpacing:'.04em', fontFamily:'SFMono-Regular, Consolas, monospace'}}>{v.plate_text}</span>
                    <span style={{color:'#ef8070', marginLeft:6}}>No parking pass</span>
                  </span>
                ) : v._isALPR ? (
                  <span className="vs-item">
                    <span style={{fontWeight:800, letterSpacing:'.04em', fontFamily:'SFMono-Regular, Consolas, monospace'}}>{v.plate_text}</span>
                    <span style={{color:'var(--text-muted)', marginLeft:6}}>Unregistered plate</span>
                  </span>
                ) : (
                  <span className="vs-item">
                    {displayColor(v.vehicle_color) ? (
                      <>
                        <span style={{width:10, height:10, borderRadius:3, background:colorHex(v.vehicle_color), border:'1px solid rgba(128,128,128,.3)', flexShrink:0}} />
                        <span style={{textTransform:'capitalize'}}>{[v.vehicle_color, v.vehicle_type && v.vehicle_type !== 'car' ? v.vehicle_type : null, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ')}</span>
                      </>
                    ) : (
                      <span style={{color:'var(--text-muted)', textTransform:'capitalize'}}>{[v.vehicle_type && v.vehicle_type !== 'car' ? v.vehicle_type : 'Vehicle', v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ')}</span>
                    )}
                  </span>
                )}
                {v.zone_id && <><span className="vs-divider" /><span className="vs-item" style={{color:'var(--text-muted)'}}>Zone {v.zone_id}</span></>}
                {v.space_number && <><span className="vs-divider" /><span className="vs-item" style={{color:'var(--text-muted)'}}>#{v.space_number}</span></>}
              </div>
              {/* Lot name + timer row */}
              <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', padding:'8px 16px'}}>
                <div style={{flex:1, minWidth:0}}>
                  <div className="job-lot-name" style={{fontSize:14, display:'flex', alignItems:'center', gap:8}}>
                    {v._isNoReg ? v._lot_name : v._isALPR ? v._lot_name : (lot?.name || 'Unknown Lot')}
                    {v._isNoReg && <span style={{fontSize:10, fontWeight:700, padding:'2px 7px', borderRadius:6, background:'rgba(177,69,53,.15)', color:'#ef8070', whiteSpace:'nowrap'}}>NO PASS</span>}
                    {!v._isNoReg && v._isALPR && <span style={{fontSize:10, fontWeight:700, padding:'2px 7px', borderRadius:6, background:'rgba(177,69,53,.15)', color:'#ef8070', whiteSpace:'nowrap'}}>NO PASS</span>}
                    {/* Status badge */}
                    {(() => {
                      const badge = statusBadge[v.status] || statusBadge.pending;
                      return (
                        <span style={{
                          fontSize:10, fontWeight:700, padding:'2px 7px', borderRadius:6,
                          background: badge.bg, color: badge.color, whiteSpace:'nowrap',
                        }}>
                          {badge.icon} {badge.label}
                        </span>
                      );
                    })()}
                  </div>
                  <div className="job-lot-addr" style={{display:'flex', alignItems:'center', gap:6}}>
                    {fmtTime(v.detected_at)} · {(v.violation_type || 'violation').replace(/_/g, ' ')}
                    {v._camera_name && <span style={{fontSize:11,color:'var(--text-muted)'}}>· {v._camera_name}</span>}
                    {v.sms_sent_at && (
                      <span style={{fontSize:10, fontWeight:600, color: v.sms_delivered ? 'var(--green)' : 'var(--yellow)'}}>
                        {v.sms_delivered ? '✓ SMS' : '○ SMS'}
                      </span>
                    )}
                    {v.reminder_sent_at && (
                      <span style={{fontSize:10, fontWeight:600, color:'var(--text-muted)'}}>
                        · Reminder sent
                      </span>
                    )}
                  </div>
                </div>
                {timer && (
                  <div className="job-timer">
                    <div className={`job-timer-val ${timer.long ? 'long' : ''}`}>{timer.val}</div>
                    <div className="job-timer-label">{timer.unit}</div>
                  </div>
                )}
              </div>
              {/* Primary actions — hidden for departed violations (dismiss from banner instead) */}
              {!(v.status === 'departed' || v.departed_at || departedFlaggedRef.current.has(v.id)) && (<>
              {v._isALPR ? (
              <>
              <div className="job-actions-row" role="group" aria-label="Enforcement actions" style={{gap:8, padding:'10px 12px'}}>
                <button className="action-btn tow" disabled={anyActing} onClick={async () => { setActing(v.id); try { await db.dispatchALPRViolation(v.id); addToast('Tow dispatched', 'success'); if (onAction) onAction(); } catch(e) { addToast('Failed: '+(e.message||''), 'error'); } setActing(null); }} aria-label="Dispatch tow" style={{padding:'12px 6px', fontSize:13}}>
                  {isActing ? '…' : 'Dispatch Tow'}
                </button>
                <button className="action-btn dismiss" disabled={anyActing} onClick={async () => { setActing(v.id); try { await db.dismissALPRViolation(v.id); addToast('Pass dismissed', 'success'); if (onAction) onAction(); } catch(e) { addToast('Failed: '+(e.message||''), 'error'); } setActing(null); }} aria-label="Dismiss" style={{padding:'12px 6px', fontSize:13}}>
                  {isActing ? '…' : 'Dismiss'}
                </button>
              </div>
              </>
              ) : (
              <>
              <div className="job-actions-row" role="group" aria-label="Enforcement actions" style={{gap:8, padding:'10px 12px'}}>
                <button className="action-btn boot" disabled={anyActing} onClick={() => requestAction(v.id, 'boot')} aria-label={`Boot vehicle for $${user?.boot_fee || 75}`} style={{padding:'12px 6px', fontSize:13}}>
                  {isActing ? '…' : `Boot · $${user?.boot_fee || 75}`}
                </button>
                <button className="action-btn tow" disabled={anyActing} onClick={() => requestAction(v.id, 'tow')} aria-label={`Tow vehicle for $${user?.tow_fee || 250}`} style={{padding:'12px 6px', fontSize:13}}>
                  {isActing ? '…' : `Tow · $${user?.tow_fee || 250}`}
                </button>
              </div>
              <div className="job-secondary-actions" style={{display:'flex', alignItems:'center', padding:'0 12px 10px', gap:8, flexWrap:'wrap'}}>
                  {v.status === 'alerted' && (
                    <button className="action-btn" disabled={anyActing || acking === v.id}
                      onClick={(e) => { e.stopPropagation(); handleAcknowledge(v.id); }}
                      aria-label="Acknowledge"
                      style={{background:'rgba(245,158,11,.12)', border:'1px solid rgba(245,158,11,.3)', color:'#f59e0b'}}>
                      {acking === v.id ? '…' : 'Acknowledge'}
                    </button>
                  )}
                  <button className="action-btn dismiss" disabled={anyActing} onClick={() => requestAction(v.id, 'dismissed')} aria-label="Dismiss">
                    Dismiss
                  </button>
                  <button className="action-btn gone" disabled={anyActing} onClick={() => requestAction(v.id, 'already_gone')} aria-label="Mark vehicle as already gone">
                    Gone
                  </button>
                  <div style={{flex:'1 1 auto'}} />
                {lot?.address && (
                  <a href={mapsLink(lot.address)} target="_blank" rel="noopener"
                    className="action-btn navigate" style={{textDecoration:'none', display:'flex', alignItems:'center', justifyContent:'center', gap:4}}
                    onClick={e => { e.stopPropagation(); haptic('medium'); }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
                    Navigate
                  </a>
                )}
              </div>
              </>
              )}
              </>)}
            </div>
          );
        })
      )}

      {/* Recent completed — hidden when the 'handled' filter pill is active to avoid duplication */}
      {recent.length > 0 && filter !== 'handled' && (
        <>
          <div className="section-header" style={{marginTop: 24}}>
            <div className="section-title">Handled Today</div>
            <div className="section-count">{recent.length} jobs</div>
          </div>
          {recent.map(v => {
            const lot = lotMap[v.lot_id];
            const actionColor = { boot: '#fbbf24', tow: '#f87171', dismissed: '#a78bfa', no_action: '#6b7280', already_gone: '#6b7280' };
            const col = actionColor[v.action_taken?.toLowerCase()] || '#9ca3af';
            return (
              <div key={v.id} className="job-card" style={{position:'relative'}}>
                {/* Owner delete X */}
                {isOwner && (
                  <button
                    onClick={async (e) => {
                      e.stopPropagation();
                      try {
                        await db.deleteViolation(v.id, !!v._isALPR);
                        addToast('Job deleted', 'success');
                        if (onAction) onAction();
                      } catch (err) {
                        addToast('Failed to delete: ' + (err.message || 'Unknown error'), 'error');
                      }
                    }}
                    style={{
                      position:'absolute', top:8, right:8, zIndex:5, width:28, height:28, borderRadius:'50%',
                      background:'rgba(0,0,0,.5)', backdropFilter:'blur(4px)', border:'none', cursor:'pointer',
                      display:'flex', alignItems:'center', justifyContent:'center', padding:0,
                    }}
                    aria-label="Delete job"
                    title="Delete job"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="3" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </button>
                )}
                <div className="job-body">
                  <div className="job-top">
                    <div>
                      <div className="job-lot-name" style={{fontSize:14, display:'flex', alignItems:'center', gap:6}}>
                        {v._isALPR ? v._lot_name : (lot?.name || 'Unknown Lot')}
                        {v._isALPR && <span style={{fontSize:9, fontWeight:700, padding:'2px 6px', borderRadius:4, background:'rgba(167,139,250,.15)', color:'#a78bfa'}}>PARKING PASS</span>}
                      </div>
                      <div className="job-lot-addr">{smartDate(v.detected_at)} · {fmtTime(v.detected_at)}</div>
                    </div>
                    {v.our_revenue > 0 && (
                      <div className="job-timer" style={{background:'var(--revenue-bg)'}}>
                        <div style={{fontSize:15, fontWeight:800, color:'var(--green)'}}>{fmtMoney(v.our_revenue)}</div>
                        <div className="job-timer-label">earned</div>
                      </div>
                    )}
                  </div>
                  <div className="job-details">
                    {displayColor(v.vehicle_color) ? (
                      <span style={{display:'flex', alignItems:'center', gap:4, fontSize:11, color:'var(--text-secondary)'}}>
                        <span style={{width:8, height:8, borderRadius:3, background:colorHex(v.vehicle_color), border:'1px solid rgba(0,0,0,.2)', flexShrink:0}} />
                        <span style={{textTransform:'capitalize'}}>{[v.vehicle_color, v.vehicle_type && v.vehicle_type !== 'car' ? v.vehicle_type : null].filter(Boolean).join(' ')}</span>
                      </span>
                    ) : v.vehicle_type && v.vehicle_type !== 'car' ? (
                      <span style={{fontSize:11, color:'var(--text-muted)', textTransform:'capitalize'}}>{v.vehicle_type}</span>
                    ) : null}
                    {v.zone_id && <span className="job-tag">Zone <strong>{v.zone_id}</strong></span>}
                    {v.status === 'cleared' ? (
                      <span className="job-tag" style={{color:'#4ade80'}}>✓ <strong style={{color:'#4ade80'}}>Cleared</strong>{v.duration_seconds ? ` · ${Math.round(v.duration_seconds / 60)}m` : ''}</span>
                    ) : (v.status === 'departed' || v.action_taken === 'already_gone') ? (
                      <span className="job-tag" style={{color:'#6b7280'}}>🚫 <strong style={{color:'#6b7280'}}>Vehicle Left</strong></span>
                    ) : (
                      <span className="job-tag" style={{color: col}}>✓ <strong style={{color: col}}>{(v.action_taken || 'handled').replace(/_/g, ' ')}</strong></span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </>
      )}

      {/* Violation detail modal */}
      {selectedViol && (() => {
        const cam = allCams.find(c => c.camera_id === selectedViol.camera_id);
        const latestUrl = cam?.latest_snapshot?.url || cam?.latest_snapshot?.storage_url || null;
        const latestDets = cam?.latest_snapshot?.detections || [];
        const zones = camZonesMap[selectedViol.camera_id] || [];
        const matched = matchViolationDetection(selectedViol._detections, selectedViol.zone_id, zones);
        return <ViolationProofModal
          violation={selectedViol}
          latestSnapshotUrl={latestUrl}
          latestDetections={latestDets}
          cameraZones={zones}
          matchedDetection={matched}
          tunnelSnapshotUrl={cam?.tunnel_snapshot_url}
          onClose={() => setSelectedViol(null)}
          onAutoGone={(violId) => { setSelectedViol(null); handleAction(violId, 'already_gone'); }}
        />;
      })()}

    </div>
  );
}
