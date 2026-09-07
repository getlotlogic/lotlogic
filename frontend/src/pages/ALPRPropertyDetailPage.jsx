import React, { useState, useEffect, useCallback, useRef, useMemo, memo } from 'react';
import { makeDebounced } from '../lib/time.js';
import { fmtDateTime } from '../lib/format.js';
import { bundleVehicleEvents, filterEvidencePackages } from '../lib/bundle.js';
import { supabase } from '../lib/supabase.js';
import { API, apiFetch } from '../lib/api.js';
import { db } from '../lib/db.js';
import { DEFAULT_TRUCK_PLAZA_POLICY } from '../shared/policy.js';
import { useIntervalFetch, useNowTick } from '../hooks.js';
import { ErrorBoundary } from '../ui/ErrorBoundary.jsx';
import { useToast } from '../ui/Toast.jsx';
import { SkeletonCards } from '../ui/Skeletons.jsx';
import { CrossCameraSightings } from '../ui/CrossCameraSightings.jsx';
import { ApartmentPermits } from './ApartmentPermits.jsx';
import { lazyPage } from '../lib/lazyPage.js';

// Heavy — lazy-loaded so opening a property doesn't pull in the full
// parking-log bundle before the operator ever scrolls to it.
const TruckParkingLog = lazyPage(() => import('./TruckParkingLog.jsx'));

// Swipeable fullscreen carousel for the matched-vehicle snapshots on
// No Registration Evidence Package cards. On phones the inline 2-up grid
// is fine for triage, but verifying a plate read needs the full frame.
// Props:
//   snaps: [{ url, taken_at, confidence }, …]  in display order
//   startIndex: which thumbnail was tapped
//   plate: header text
//   onClose: () => void
function SnapsLightbox({ snaps, startIndex, plate, onClose }) {
  const [index, setIndex] = useState(startIndex || 0);
  const touchRef = useRef({ x: 0, y: 0, t: 0 });
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') setIndex(i => Math.max(0, i - 1));
      else if (e.key === 'ArrowRight') setIndex(i => Math.min(snaps.length - 1, i + 1));
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [snaps.length, onClose]);
  function onTouchStart(e) {
    const t = e.touches[0];
    touchRef.current = { x: t.clientX, y: t.clientY, t: Date.now() };
  }
  function onTouchEnd(e) {
    const t = e.changedTouches[0];
    const dx = t.clientX - touchRef.current.x;
    const dy = t.clientY - touchRef.current.y;
    const dt = Date.now() - touchRef.current.t;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) && dt < 600) {
      if (dx < 0) setIndex(i => Math.min(snaps.length - 1, i + 1));
      else setIndex(i => Math.max(0, i - 1));
    }
  }
  const snap = snaps[index];
  const taken = snap?.taken_at ? new Date(snap.taken_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '';
  const conf = snap?.confidence != null ? Math.round(snap.confidence * (snap.confidence <= 1 ? 100 : 1)) + '%' : null;
  return (
    <div
      onClick={onClose}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      role="dialog"
      aria-modal="true"
      aria-label="Vehicle snapshots"
      style={{position:'fixed',inset:0,background:'rgba(0,0,0,.92)',zIndex:1200,display:'flex',flexDirection:'column',padding:'env(safe-area-inset-top, 12px) 12px env(safe-area-inset-bottom, 12px)',gap:8}}
    >
      {/* Header */}
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',color:'#fff',padding:'4px 4px',gap:8}}>
        <div style={{display:'flex',flexDirection:'column',minWidth:0}}>
          <div style={{fontFamily:"'Courier New',monospace",fontWeight:800,fontSize:18,letterSpacing:'.04em'}}>{plate || 'Snapshot'}</div>
          <div style={{fontSize:11,color:'#cbd5e1'}}>{index + 1} of {snaps.length}{taken ? ` · ${taken}` : ''}{conf ? ` · ${conf} conf` : ''}</div>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          aria-label="Close"
          style={{background:'rgba(255,255,255,.12)',color:'#fff',border:'1px solid rgba(255,255,255,.2)',borderRadius:999,width:36,height:36,fontSize:18,fontWeight:700,cursor:'pointer',lineHeight:1,display:'flex',alignItems:'center',justifyContent:'center'}}
        >×</button>
      </div>
      {/* Image */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{flex:1,display:'flex',alignItems:'center',justifyContent:'center',minHeight:0,position:'relative'}}
      >
        {snap?.url && (
          <img
            key={snap.url}
            src={snap.url}
            alt={`${plate || 'vehicle'} snapshot ${index + 1}`}
            style={{maxWidth:'100%',maxHeight:'100%',objectFit:'contain',borderRadius:6,background:'#000',animation:'snap-fade-in 200ms ease-out'}}
          />
        )}
        {snaps.length > 1 && (
          <>
            <button
              onClick={(e) => { e.stopPropagation(); setIndex(i => Math.max(0, i - 1)); }}
              disabled={index === 0}
              aria-label="Previous"
              style={{position:'absolute',left:8,top:'50%',transform:'translateY(-50%)',width:44,height:44,borderRadius:'50%',background:'rgba(0,0,0,.5)',color:'#fff',border:'1px solid rgba(255,255,255,.2)',fontSize:22,fontWeight:700,cursor:index===0?'default':'pointer',opacity:index===0?.3:1,display:'flex',alignItems:'center',justifyContent:'center'}}
            >‹</button>
            <button
              onClick={(e) => { e.stopPropagation(); setIndex(i => Math.min(snaps.length - 1, i + 1)); }}
              disabled={index === snaps.length - 1}
              aria-label="Next"
              style={{position:'absolute',right:8,top:'50%',transform:'translateY(-50%)',width:44,height:44,borderRadius:'50%',background:'rgba(0,0,0,.5)',color:'#fff',border:'1px solid rgba(255,255,255,.2)',fontSize:22,fontWeight:700,cursor:index===snaps.length-1?'default':'pointer',opacity:index===snaps.length-1?.3:1,display:'flex',alignItems:'center',justifyContent:'center'}}
            >›</button>
          </>
        )}
      </div>
      {/* Dot indicators */}
      {snaps.length > 1 && (
        <div onClick={(e) => e.stopPropagation()} style={{display:'flex',justifyContent:'center',gap:6,padding:'4px 0'}}>
          {snaps.map((_, i) => (
            <button key={i} onClick={(e) => { e.stopPropagation(); setIndex(i); }} aria-label={`Snapshot ${i+1}`}
              style={{width:8,height:8,borderRadius:'50%',border:'none',background:i===index?'#fff':'rgba(255,255,255,.4)',cursor:'pointer',padding:0,transition:'background 160ms'}} />
          ))}
        </div>
      )}
    </div>
  );
}


// Shown under every plate / visitor-pass row: a compact strip of the most
// recent plate_events linked to that registration. Each thumbnail surfaces
// the match_status and rolling OCR confidence so an operator can glance
// at a pass and see whether anything looks wrong before it ever becomes a
// tow candidate.
function SightingStrip({ sightings, cameras, nowTick }) {
  if (!sightings || sightings.length === 0) {
    return (
      <div style={{fontSize:11,color:'var(--text-faint)',fontStyle:'italic'}}>No ALPR sightings yet.</div>
    );
  }
  const cameraById = Object.fromEntries((cameras || []).map(c => [c.id, c]));
  const sorted = [...sightings].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const lastSeenMs = nowTick - new Date(sorted[0].created_at).getTime();
  const lastSeenStr = lastSeenMs < 60000 ? 'just now'
    : lastSeenMs < 3600000 ? Math.floor(lastSeenMs / 60000) + 'm ago'
    : lastSeenMs < 86400000 ? Math.floor(lastSeenMs / 3600000) + 'h ago'
    : Math.floor(lastSeenMs / 86400000) + 'd ago';
  const lowConfCount = sorted.filter(s => s.match_status === 'low_confidence').length;
  return (
    <div style={{borderTop:'1px dashed var(--border-subtle)',paddingTop:8}}>
      <div style={{display:'flex',alignItems:'center',gap:10,fontSize:11,color:'var(--text-muted)',marginBottom:6}}>
        <span style={{fontWeight:700,color:'var(--text-secondary)',letterSpacing:'.04em',textTransform:'uppercase'}}>{sorted.length} sighting{sorted.length === 1 ? '' : 's'}</span>
        <span>· last seen {lastSeenStr}</span>
        {lowConfCount > 0 && (
          <span style={{fontSize:10,fontWeight:700,padding:'2px 6px',borderRadius:4,background:'rgba(251,191,36,.12)',color:'#fbbf24',border:'1px solid rgba(251,191,36,.25)'}}>{lowConfCount} LOW CONFIDENCE</span>
        )}
      </div>
      <div style={{display:'flex',gap:6,overflowX:'auto',WebkitOverflowScrolling:'touch',paddingBottom:2}}>
        {sorted.slice(0, 10).map(ev => {
          const cam = cameraById[ev.camera_id];
          const conf = typeof ev.confidence === 'number' ? Math.round(ev.confidence * (ev.confidence <= 1 ? 100 : 1)) : null;
          const statusColor = ev.match_status === 'matched' ? '#4ade80'
            : ev.match_status === 'visitor_pass_fuzzy' ? '#4ade80'
            : ev.match_status === 'partner_truck' ? '#4ade80'
            : ev.match_status === 'low_confidence' ? '#fbbf24'
            : ev.match_status === 'camera_suspended' ? '#f87171'
            : 'var(--text-faint)';
          const title = `${cam?.name || 'camera'} · ${new Date(ev.created_at).toLocaleString()} · ${ev.match_status}${conf != null ? ` · ${conf}%` : ''}`;
          return (
            <div key={ev.id} title={title} style={{flexShrink:0,width:72,display:'flex',flexDirection:'column',gap:2}}>
              <div style={{position:'relative',width:72,height:54,borderRadius:6,overflow:'hidden',border:'1px solid var(--border-subtle)',background:'var(--bg-inset)'}}>
                {ev.image_url
                  ? <img src={ev.image_url} alt="plate sighting" loading="lazy" style={{width:'100%',height:'100%',objectFit:'cover'}} />
                  : <div style={{width:'100%',height:'100%',display:'flex',alignItems:'center',justifyContent:'center',fontSize:10,color:'var(--text-faint)'}}>No image</div>
                }
                <div style={{position:'absolute',top:3,right:3,width:8,height:8,borderRadius:'50%',background:statusColor,boxShadow:'0 0 0 2px rgba(0,0,0,.35)'}} />
              </div>
              <div style={{fontSize:10,color:'var(--text-faint)',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>
                {new Date(ev.created_at).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})}{conf != null ? ` · ${conf}%` : ''}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}


export function ALPRPropertyDetailPage({ propertyId, onBack, user }) {
  // QR codes + camera registration are owner-only surfaces. Partners see
  // the property + plates + parking log but not the operational chrome.
  const isOwner = user?._role === 'owner';
  const { addToast } = useToast();
  const [property, setProperty] = useState(null);
  const [plates, setPlates] = useState([]);
  const [cameras, setCameras] = useState([]);
  const [events, setEvents] = useState([]);
  // Group-by-session toggle for the Plate Detections list. Default ON to match
  // the user's expectation: "1-2 shots per vehicle, not 100." Off shows the raw
  // per-frame timeline. Persisted to localStorage so it survives reloads.
  const [groupBySession, setGroupBySession] = useState(() => {
    try { return localStorage.getItem('lotlogic_pd_group') !== '0'; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem('lotlogic_pd_group', groupBySession ? '1' : '0'); } catch {}
  }, [groupBySession]);
  const [loading, setLoading] = useState(true);
  const [showAddPlate, setShowAddPlate] = useState(false);
  const [showAddCam, setShowAddCam] = useState(false);
  const [newPlate, setNewPlate] = useState({ plate_text: '', unit_number: '', holder_name: '', vehicle_description: '', phone: '' });
  const [newCam, setNewCam] = useState({ name: '', location_description: '' });
  const [newApiKey, setNewApiKey] = useState(null);
  const [saving, setSaving] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState(null);
  const [passTotalCount, setPassTotalCount] = useState(0);
  const [openSessions, setOpenSessions] = useState([]);
  const [activeHolds, setActiveHolds] = useState([]);
  // Stuck tows — overstay violations whose partner dispatch exhausted its
  // retries (status='dispatch_failed'). These are invisible everywhere else
  // and never auto-retry, so the operator needs an explicit queue.
  const [stuckDispatch, setStuckDispatch] = useState([]);
  // SC211: Possible no parking pass violations
  const [noRegViolations, setNoRegViolations] = useState([]);
  const [noRegActing, setNoRegActing] = useState(null); // id of row being acted on
  // Bulk-select state for the No Registration Evidence Package surface.
  const [noRegSelectMode, setNoRegSelectMode] = useState(false);
  const [noRegSelected, setNoRegSelected] = useState(() => new Set());
  const [noRegBatching, setNoRegBatching] = useState(false);
  // Per-row expand toggle. Cross-camera sightings only load when expanded.
  const [noRegExpanded, setNoRegExpanded] = useState(() => new Set());
  // Snap-thumbnail lightbox state for the matched-vehicle frames.
  const [noRegSnapLightbox, setNoRegSnapLightbox] = useState(null);
  const nowTick = useNowTick();
  const tempQrRef = useRef(null);
  const permQrRef = useRef(null);
  // The QR drawing library is a third-party CDN script. When it fails to load
  // the tiles used to render an empty white box with nothing in the console —
  // say so instead, and point at the Copy link button that still works.
  const [qrLibFailed, setQrLibFailed] = useState(false);

  const isTruckPlaza = property?.property_type === 'truck_plaza';

  // Top-of-page section filter. Lets the operator focus on one surface
  // (tracker, log, plates, cameras) instead of scrolling past everything.
  // Persists across reloads.
  const [sectionFilter, setSectionFilter] = useState(() => {
    try {
      // Default to 'log' so opening any property page lands directly on
      // the Parking Log — the surface everyone actually uses. Previously
      // defaulted to 'all' which dumped every section.
      const saved = localStorage.getItem('lotlogic_pd_section') || 'log';
      // Migration: 'tracker' no longer exists. Anyone with it cached
      // gets bumped to 'log' (the same content area, just renamed).
      if (saved === 'tracker') return 'log';
      return saved;
    } catch { return 'log'; }
  });
  useEffect(() => {
    try { localStorage.setItem('lotlogic_pd_section', sectionFilter); } catch {}
  }, [sectionFilter]);
  const showSection = (key) => sectionFilter === 'all' || sectionFilter === key;

  const loadAll = useCallback(async () => {
    if (!propertyId) return;
    setLoading(true);
    const [prop, pl, cam, ev, pCount, os, ah] = await Promise.all([
      db.getProperty(propertyId),
      db.getResidentPlates(propertyId),
      db.getALPRCameras(propertyId),
      db.getRecentPlateEvents(propertyId, 50),
      db.countVisitorPasses(propertyId),
      db.getOpenSessions(propertyId),
      db.getActiveHolds(propertyId),
    ]);
    setProperty(prop);
    setPlates(pl);
    setCameras(cam);
    setEvents(ev);
    setPassTotalCount(pCount);
    setOpenSessions(os);
    setActiveHolds(ah);
    setLoading(false);
  }, [propertyId]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Possible No Registration Evidence Packages — bundled client-side from
  // plate_events (replacing the legacy no_registration_violations table flow
  // which was tied to the apartment SC211 pipeline). See bundleVehicleEvents
  // and filterEvidencePackages at module scope. Rule: lingering (≥3 reads
  // spanning ≥60s) AND no pass match AND no tow match, last 24h.
  const loadNoReg = useCallback(async () => {
    if (!propertyId || !supabase) return;
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const [eventsRes, pairsRes] = await Promise.all([
        supabase
          .from('plate_events')
          .select('id, camera_id, normalized_plate, plate_text, confidence, image_url, match_status, created_at, raw_data')
          .eq('property_id', propertyId)
          .gte('created_at', since)
          .order('created_at', { ascending: true })
          .limit(2000),
        // Operator-VERIFIED pairs only — heuristic-confidence pairs
        // would carry FP risk in this wider time window.
        supabase
          .from('inferred_plate_pairs')
          .select('plate_a, plate_b')
          .eq('property_id', propertyId)
          .not('verified_at', 'is', null)
          .is('dismissed_at', null),
      ]);
      if (eventsRes.error) throw eventsRes.error;
      const bundles = bundleVehicleEvents(eventsRes.data || [], pairsRes.data || []);
      const evidence = filterEvidencePackages(bundles)
        .sort((a, b) => new Date(b.first_seen_at) - new Date(a.first_seen_at));
      setNoRegViolations(evidence);
    } catch (err) {
      console.warn('vehicle-event bundling failed:', err.message);
    }
  }, [propertyId]);

  useEffect(() => { loadNoReg(); }, [loadNoReg]);

  // Stuck tows: overstay violations the dispatch pipeline gave up on
  // (status='dispatch_failed'). The partner was never paged and nothing
  // retries, so without this surface they sit invisible forever. Read-only
  // queue — the operator escalates manually; we don't auto-act from the UI.
  const loadStuckDispatch = useCallback(async () => {
    if (!propertyId) return;
    try {
      const rows = await db.getALPRViolations(propertyId, 'dispatch_failed');
      setStuckDispatch(rows || []);
    } catch (err) {
      console.warn('stuck-dispatch load failed:', err.message);
    }
  }, [propertyId]);

  useEffect(() => { loadStuckDispatch(); }, [loadStuckDispatch]);

  // Evidence packages are FYI — dismiss is purely local (hide from operator
  // view). No backend mutation, no notifications. Bundles also auto-clear
  // after 24h as plate_events age out of the bundling window.
  function handleNoRegDismiss(id) {
    setNoRegViolations(prev => prev.filter(r => r.id !== id));
    addToast('Hidden', 'success');
  }

  // Mark Towed was a legacy enforcement action that doesn't apply — these
  // are informational evidence packages, not tow-actionable violations.
  // Stub kept so the existing render block compiles; the button itself is
  // removed below.
  function handleNoRegTow() {}

  function dismissSelectedNoReg() {
    if (!noRegSelected.size) return;
    setNoRegBatching(true);
    const ids = new Set(noRegSelected);
    setNoRegViolations(prev => prev.filter(r => !ids.has(r.id)));
    addToast(`${ids.size} hidden`, 'success');
    setNoRegSelected(new Set());
    setNoRegSelectMode(false);
    setNoRegBatching(false);
  }
  function toggleNoRegSelect(id) {
    setNoRegSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleNoRegExpand(id) {
    setNoRegExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // Render the Temporary + Permanent QR codes once we know the property
  useEffect(() => {
    if (!property?.qr_code_id) return;
    if (typeof QRCode === 'undefined' || typeof QRCode.toCanvas !== 'function') {
      console.error('qr: QRCode library did not load');
      setQrLibFailed(true);
      return;
    }
    setQrLibFailed(false);
    const opts = { width: 320, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0f172a', light: '#ffffff' } };
    const draw = (canvas, url, label) => {
      if (!canvas) return;
      QRCode.toCanvas(canvas, url, opts, err => {
        if (err) { console.error(label + ' qr:', err); setQrLibFailed(true); }
      });
    };
    draw(tempQrRef.current, `${window.location.origin}/temp/${property.qr_code_id}`, 'temp');
    draw(permQrRef.current, `${window.location.origin}/perm/${property.qr_code_id}`, 'perm');
  }, [property?.qr_code_id]);

  // ── Permanent plates (new /perm submissions land here) ──
  // Same live pattern as parking regs and plate events so the admin doesn't
  // have to reload after a resident submits the form.
  const refreshPlates = useCallback(async () => {
    if (!propertyId) return;
    const pl = await db.getResidentPlates(propertyId);
    setPlates(pl);
  }, [propertyId]);
  useIntervalFetch(refreshPlates, 20000, [refreshPlates]);
  useEffect(() => {
    if (!supabase || !propertyId) return;
    const debouncedRefresh = makeDebounced(refreshPlates, 200);
    const channel = supabase.channel('resident-plates-' + propertyId)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'resident_plates',
        filter: 'property_id=eq.' + propertyId,
      }, debouncedRefresh)
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [propertyId, refreshPlates]);
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible') refreshPlates(); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [refreshPlates]);

  // ── Pass count (new /visit submissions bump it) ──
  // This used to also fetch a 50-row visitorPasses list into state that
  // NOTHING rendered (the consumer was ActivePassTracker, deleted when the
  // roster became the single source of truth). The dead fetch ran every 20s
  // plus on every realtime event. Only the count is still consumed.
  const refreshVisitorPasses = useCallback(async () => {
    if (!propertyId) return;
    const count = await db.countVisitorPasses(propertyId);
    setPassTotalCount(count);
  }, [propertyId]);
  useIntervalFetch(refreshVisitorPasses, 20000, [refreshVisitorPasses]);
  useEffect(() => {
    if (!supabase || !propertyId) return;
    const debouncedRefresh = makeDebounced(refreshVisitorPasses, 200);
    const channel = supabase.channel('visitor-passes-' + propertyId)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'visitor_passes',
        filter: 'property_id=eq.' + propertyId,
      }, debouncedRefresh)
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [propertyId, refreshVisitorPasses]);
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible') refreshVisitorPasses(); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [refreshVisitorPasses]);

  // ── ALPR cameras (register / remove + last_seen updates) ──
  const refreshCameras = useCallback(async () => {
    if (!propertyId) return;
    const cam = await db.getALPRCameras(propertyId);
    setCameras(cam);
  }, [propertyId]);
  useEffect(() => {
    if (!supabase || !propertyId) return;
    const debouncedRefresh = makeDebounced(refreshCameras, 250);
    const channel = supabase.channel('alpr-cameras-' + propertyId)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'alpr_cameras',
        filter: 'property_id=eq.' + propertyId,
      }, debouncedRefresh)
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [propertyId, refreshCameras]);

  // ── Recent plate detections (ALPR) ──
  // Keep this list fresh the same way as parking regs: realtime + 20s poll + visibility.
  const refreshEvents = useCallback(async () => {
    if (!propertyId) return;
    const ev = await db.getRecentPlateEvents(propertyId, 50);
    setEvents(ev);
  }, [propertyId]);
  useIntervalFetch(refreshEvents, 20000, [refreshEvents]);
  useEffect(() => {
    if (!supabase || !propertyId) return;
    const debouncedRefresh = makeDebounced(refreshEvents, 200);
    const channel = supabase.channel('plate-events-' + propertyId)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'plate_events',
        filter: 'property_id=eq.' + propertyId,
      }, debouncedRefresh)
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [propertyId, refreshEvents]);
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible') refreshEvents(); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [refreshEvents]);

  // ── Open sessions + active holds ──
  const refreshSessions = useCallback(async () => {
    if (!propertyId) return;
    const [s, h] = await Promise.all([
      db.getOpenSessions(propertyId),
      db.getActiveHolds(propertyId),
    ]);
    setOpenSessions(s);
    setActiveHolds(h);
  }, [propertyId]);
  useIntervalFetch(refreshSessions, 20000, [refreshSessions]);
  useEffect(() => {
    if (!supabase || !propertyId) return;
    const debouncedRefresh = makeDebounced(refreshSessions, 200);
    const ch1 = supabase.channel('plate-sessions-' + propertyId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'plate_sessions', filter: 'property_id=eq.' + propertyId }, debouncedRefresh)
      .subscribe();
    const ch2 = supabase.channel('plate-holds-' + propertyId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'plate_holds', filter: 'property_id=eq.' + propertyId }, debouncedRefresh)
      .subscribe();
    return () => { supabase.removeChannel(ch1); supabase.removeChannel(ch2); };
  }, [propertyId, refreshSessions]);

  const cameraById = useMemo(() => Object.fromEntries((cameras || []).map(c => [c.id, c])), [cameras]);

  async function handleAddPlate(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = { ...newPlate, property_id: propertyId };
      payload.holder_role = isTruckPlaza ? 'employee' : 'resident';
      if (isTruckPlaza) {
        // Apartment-only fields stay NULL on employee rows.
        delete payload.unit_number;
        delete payload.lease_doc_url;
        delete payload.plate_expiration;
      }
      await db.addResidentPlate(payload);
      setNewPlate({ plate_text: '', unit_number: '', holder_name: '', vehicle_description: '', phone: '' });
      setShowAddPlate(false);
      const pl = await db.getResidentPlates(propertyId);
      setPlates(pl);
    } catch (err) { addToast('Failed to add plate. ' + (err.message || ''), 'error'); }
    setSaving(false);
  }

  async function handleSaveSettings(e) {
    e.preventDefault();
    if (!settingsDraft) return;
    setSaving(true);
    try {
      const updates = {};
      // property_type change only allowed when there are zero passes.
      if (settingsDraft.property_type !== property.property_type) {
        if (passTotalCount > 0) {
          addToast('Cannot change property type after passes have been recorded.', 'error');
          setSaving(false);
          return;
        }
        updates.property_type = settingsDraft.property_type;
      }
      if (settingsDraft.property_type === 'truck_plaza') {
        updates.policy_text = settingsDraft.policy_text || DEFAULT_TRUCK_PLAZA_POLICY;
        updates.policy_phone = settingsDraft.policy_phone || null;
      }
      const updated = await db.updateProperty(propertyId, updates);
      setProperty(updated);
      setShowSettings(false);
      addToast('Settings saved', 'success');
    } catch (err) {
      addToast('Failed to save settings. ' + (err.message || ''), 'error');
    }
    setSaving(false);
  }

  async function handleRemovePlate(id) {
    // An unguarded failure here was indistinguishable from a mis-click: the
    // await rejected, the row stayed on screen, and the operator got nothing
    // but an unhandled rejection in the console. Mirrors handleApprovePlate.
    try {
      await db.removeResidentPlate(id);
      // Use functional setState so a realtime event landing between click and
      // commit doesn't get clobbered by the closure-captured `plates`.
      setPlates(prev => prev.filter(p => p.id !== id));
      addToast('Parking pass removed', 'success');
    } catch (err) {
      addToast('Failed to remove. ' + (err.message || ''), 'error');
    }
  }

  async function handleApprovePlate(id) {
    try {
      await db.approveResidentPlate(id);
      setPlates(prev => prev.map(p => p.id === id ? { ...p, status: 'approved', active: true } : p));
      addToast('Plate approved', 'success');
    } catch (err) {
      addToast('Failed to approve. ' + (err.message || ''), 'error');
    }
  }

  async function handleAddCamera(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const cam = await db.registerALPRCamera({ ...newCam, property_id: propertyId });
      setNewApiKey(cam.api_key);
      setNewCam({ name: '', location_description: '' });
      const cams = await db.getALPRCameras(propertyId);
      setCameras(cams);
    } catch (err) { addToast('Failed to register camera. ' + (err.message || ''), 'error'); }
    setSaving(false);
  }

  if (loading) return <div className="page-enter"><div style={{textAlign:'center',padding:40,color:'var(--text-muted)'}}>Loading...</div></div>;
  if (!property) return <div className="page-enter"><div style={{textAlign:'center',padding:40,color:'var(--text-muted)'}}>Lot not found</div></div>;

  const tempUrl = `${window.location.origin}/temp/${property.qr_code_id}`;
  const permUrl = `${window.location.origin}/perm/${property.qr_code_id}`;

  return (
    <div className="page-enter">
      <button onClick={onBack} style={{background:'none',border:'none',color:'var(--accent)',fontSize:13,fontWeight:700,cursor:'pointer',padding:0,marginBottom:12}}>← Back to Lots</button>

      <div style={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:12,padding:'16px',marginBottom:16}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:12}}>
          <div style={{minWidth:0,flex:1}}>
            <div style={{fontSize:18,fontWeight:800,color:'var(--text-primary)'}}>{property.name}</div>
            <div style={{fontSize:13,color:'var(--text-muted)',marginTop:2}}>{property.address || 'No address'}</div>
            <div style={{fontSize:10,fontWeight:700,letterSpacing:'.06em',textTransform:'uppercase',padding:'2px 7px',borderRadius:20,background:isTruckPlaza?'rgba(251,146,60,.12)':'rgba(96,165,250,.12)',color:isTruckPlaza?'#fb923c':'#60a5fa',border:isTruckPlaza?'1px solid rgba(251,146,60,.3)':'1px solid rgba(96,165,250,.3)',display:'inline-block',marginTop:6}}>{isTruckPlaza ? 'Truck Plaza' : 'Apartment'}</div>
          </div>
          <button
            onClick={() => {
              setSettingsDraft({
                property_type: property.property_type || 'apartment',
                policy_text: property.policy_text || DEFAULT_TRUCK_PLAZA_POLICY,
                policy_phone: property.policy_phone || '',
              });
              setShowSettings(!showSettings);
            }}
            className="pd-share-btn"
          >{showSettings ? 'Close' : 'Settings'}</button>
        </div>
      </div>

      {/* Top section filter — pick what's visible below. Sticks to the top of
          the property page; default "All" shows everything. */}
      <div style={{
        position: 'sticky', top: 'calc(58px + env(safe-area-inset-top))', zIndex: 30,
        display: 'flex', gap: 6, flexWrap: 'wrap',
        padding: '10px 4px',
        background: 'var(--bg-page, var(--bg-card))',
        marginBottom: 12,
        borderBottom: '1px solid var(--border-subtle, transparent)',
      }}>
        {(() => {
          const chips = [
            { id: 'all',     label: 'All' },
            // No-registration evidence is a camera-enforcement concept — truck
            // plaza only. Apartments are registration-based and don't get it.
            ...(isTruckPlaza ? [{ id: 'noreg', label: 'No Registration Evidence Package' }] : []),
            // ActivePassTracker chip removed entirely — the component was
            // deleted in the parking-pass consolidation. The Parking Log
            // is the single source of truth now.
            ...(isTruckPlaza ? [{ id: 'log', label: 'Parking Log' }, { id: 'history', label: 'History' }] : [{ id: 'log', label: 'Parking Passes' }]),
          ];
          return chips.map(c => {
            const active = sectionFilter === c.id;
            return (
              <button key={c.id}
                onClick={() => setSectionFilter(c.id)}
                style={{
                  fontSize: 12, fontWeight: 800,
                  padding: '6px 12px', borderRadius: 999,
                  border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                  background: active ? 'var(--accent)' : 'var(--bg-card)',
                  color: active ? '#fff' : 'var(--text-primary)',
                  cursor: 'pointer',
                  letterSpacing: '.02em',
                  whiteSpace: 'nowrap',
                  transition: 'background .12s ease, border-color .12s ease',
                }}
              >{c.label}</button>
            );
          });
        })()}
      </div>

      {showSettings && settingsDraft && (
        <form onSubmit={handleSaveSettings} style={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:10,padding:14,marginBottom:16,display:'flex',flexDirection:'column',gap:8}}>
          <label style={{fontSize:11,color:'var(--text-muted)',fontWeight:700,letterSpacing:'.04em',textTransform:'uppercase'}}>Property Type</label>
          <select
            value={settingsDraft.property_type}
            disabled={passTotalCount > 0}
            onChange={e => setSettingsDraft({...settingsDraft, property_type: e.target.value})}
            style={{padding:'10px 12px',background:'var(--bg-inset)',border:'1px solid var(--border)',borderRadius:8,color:'var(--text-primary)',fontSize:14,opacity: passTotalCount > 0 ? 0.6 : 1}}
          >
            <option value="apartment">Apartment</option>
            <option value="truck_plaza">Truck Plaza</option>
          </select>
          {passTotalCount > 0 && (
            <div style={{fontSize:11,color:'var(--text-faint)'}}>
              Property type is locked: {passTotalCount} parking pass{passTotalCount === 1 ? '' : 'es'} on record. Changing type after passes exist would corrupt the log.
            </div>
          )}
          {settingsDraft.property_type === 'truck_plaza' && (
            <>
              <label style={{fontSize:11,color:'var(--text-muted)',fontWeight:700,letterSpacing:'.04em',textTransform:'uppercase',marginTop:4}}>Parking Policy Text</label>
              <textarea
                value={settingsDraft.policy_text}
                onChange={e => setSettingsDraft({...settingsDraft, policy_text: e.target.value})}
                rows={10}
                style={{padding:'10px 12px',background:'var(--bg-inset)',border:'1px solid var(--border)',borderRadius:8,color:'var(--text-primary)',fontSize:12,fontFamily:'monospace',resize:'vertical'}}
              />
              <button type="button" onClick={() => setSettingsDraft({...settingsDraft, policy_text: DEFAULT_TRUCK_PLAZA_POLICY})} className="pd-share-btn" style={{alignSelf:'flex-start'}}>Reset to default</button>
              <label style={{fontSize:11,color:'var(--text-muted)',fontWeight:700,letterSpacing:'.04em',textTransform:'uppercase',marginTop:4}}>Towing Contact Phone</label>
              <input type="tel" value={settingsDraft.policy_phone} onChange={e => setSettingsDraft({...settingsDraft, policy_phone: e.target.value})} placeholder="+12692176208" style={{padding:'10px 12px',background:'var(--bg-inset)',border:'1px solid var(--border)',borderRadius:8,color:'var(--text-primary)',fontSize:14}} />
            </>
          )}
          <button type="submit" disabled={saving} style={{background:'var(--accent)',color:'#fff',border:'none',borderRadius:8,padding:'10px',fontSize:14,fontWeight:700,cursor:'pointer',marginTop:4}}>{saving ? 'Saving...' : 'Save Settings'}</button>
        </form>
      )}

      {/* Two QR codes — one for Temporary, one for Permanent. Owner-only.
          Partners don't share QR codes with drivers — that's the property
          owner's onboarding flow. */}
      {isOwner && (
        <div className="pd-qr-grid">
          <div className="pd-qr-tile">
            <div className="pd-qr-head">
              <span className="pd-share-label" style={{color:'#3b82f6'}}>Self-serve pass</span>
              <span className="pd-qr-sub">up to 48 hrs</span>
            </div>
            <div className="pd-qr-canvas-wrap"><canvas ref={tempQrRef} /></div>
            {qrLibFailed && <div className="pd-qr-fallback" data-testid="qr-unavailable">QR unavailable &mdash; use Copy link</div>}
            <div className="pd-qr-url">{tempUrl}</div>
            <button className="pd-share-btn" onClick={() => { navigator.clipboard.writeText(tempUrl); addToast('Self-serve link copied', 'success'); }}>Copy link</button>
          </div>
          {/* Long-term (owner-approved) QR is apartment-only. On a truck plaza
              the /perm form short-circuits to a dead end, so don't surface the
              tile — employees are added via the Approved Plates editor instead. */}
          {!isTruckPlaza && (
          <div className="pd-qr-tile">
            <div className="pd-qr-head">
              <span className="pd-share-label" style={{color:'#4ade80'}}>Long-term pass</span>
              <span className="pd-qr-sub">owner-approved</span>
            </div>
            <div className="pd-qr-canvas-wrap"><canvas ref={permQrRef} /></div>
            {qrLibFailed && <div className="pd-qr-fallback" data-testid="qr-unavailable">QR unavailable &mdash; use Copy link</div>}
            <div className="pd-qr-url">{permUrl}</div>
            <button className="pd-share-btn" onClick={() => { navigator.clipboard.writeText(permUrl); addToast('Long-term link copied', 'success'); }}>Copy link</button>
          </div>
          )}
        </div>
      )}

      {/* Permanent Plates (Employees) — owner-only. Partners only need to
          see the truck parking log; the employee allowlist is internal
          property management. */}
      {showSection('plates') && isOwner && (() => {
        const pendingCount = plates.filter(p => p.status === 'pending').length;
        const label = isTruckPlaza ? 'Approved Plates (Employees)' : 'Approved Plates';
        return (
          <div className="pd-section-head">
            <div style={{display:'flex',alignItems:'baseline',gap:8}}>
              <span className="pd-section-title">{label}</span>
              <span className="pd-section-count">{plates.length}</span>
              {pendingCount > 0 && <span style={{fontSize:10,fontWeight:700,letterSpacing:'.06em',padding:'2px 7px',borderRadius:20,background:'rgba(251,191,36,.12)',color:'#fbbf24',border:'1px solid rgba(251,191,36,.25)'}}>{pendingCount} PENDING</span>}
            </div>
            <button onClick={() => setShowAddPlate(!showAddPlate)} className="pd-share-btn" style={{color:'#4ade80'}}>{showAddPlate ? 'Cancel' : '+ Add'}</button>
          </div>
        );
      })()}

      {isOwner && showAddPlate && (
        <form onSubmit={handleAddPlate} style={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:10,padding:14,marginBottom:12,display:'flex',flexDirection:'column',gap:8}}>
          <input value={newPlate.plate_text} onChange={e => setNewPlate({...newPlate, plate_text: e.target.value})} placeholder="Plate (e.g. ABC1234)" required style={{padding:'8px 10px',background:'var(--bg-inset)',border:'1px solid var(--border)',borderRadius:6,color:'var(--text-primary)',fontSize:14,textTransform:'uppercase'}} />
          <input value={newPlate.holder_name} onChange={e => setNewPlate({...newPlate, holder_name: e.target.value})} placeholder={isTruckPlaza ? 'Employee name' : 'Holder name'} style={{padding:'8px 10px',background:'var(--bg-inset)',border:'1px solid var(--border)',borderRadius:6,color:'var(--text-primary)',fontSize:14}} />
          {isTruckPlaza && (
            <input type="tel" value={newPlate.phone} onChange={e => setNewPlate({...newPlate, phone: e.target.value})} placeholder="Phone" style={{padding:'8px 10px',background:'var(--bg-inset)',border:'1px solid var(--border)',borderRadius:6,color:'var(--text-primary)',fontSize:14}} />
          )}
          <input value={newPlate.vehicle_description} onChange={e => setNewPlate({...newPlate, vehicle_description: e.target.value})} placeholder={isTruckPlaza ? 'Vehicle (e.g. Freightliner Cascadia)' : 'Vehicle (e.g. Blue Honda Civic)'} style={{padding:'8px 10px',background:'var(--bg-inset)',border:'1px solid var(--border)',borderRadius:6,color:'var(--text-primary)',fontSize:14}} />
          {!isTruckPlaza && (
            <input value={newPlate.unit_number || ''} onChange={e => setNewPlate({...newPlate, unit_number: e.target.value})} placeholder="Unit number (optional)" style={{padding:'8px 10px',background:'var(--bg-inset)',border:'1px solid var(--border)',borderRadius:6,color:'var(--text-primary)',fontSize:14}} />
          )}
          <button type="submit" disabled={saving} style={{background:'var(--accent)',color:'#fff',border:'none',borderRadius:6,padding:'8px',fontSize:13,fontWeight:700,cursor:'pointer'}}>{saving ? 'Saving...' : 'Add Plate'}</button>
        </form>
      )}

      {isOwner && (
        <div style={{display:'flex',flexDirection:'column',gap:6}}>
          {plates.map(p => {
            const mySightings = events.filter(e => e.resident_plate_id === p.id);
            return (
              <div key={p.id} style={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8,padding:'10px 12px',display:'flex',flexDirection:'column',gap:8}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:8}}>
                  <div style={{minWidth:0,flex:1}}>
                    <span style={{fontWeight:800,fontSize:15,color:'var(--text-primary)',letterSpacing:'.03em',fontFamily:"'Courier New',monospace"}}>{p.plate_text}</span>
                    {p.status === 'pending' && <span style={{fontSize:10,fontWeight:700,color:'#fbbf24',background:'rgba(251,191,36,.12)',padding:'2px 6px',borderRadius:4,marginLeft:6,border:'1px solid rgba(251,191,36,.25)'}}>PENDING</span>}
                    {p.usdot_number && (
                      <span title={`USDOT ${p.usdot_number}`} style={{marginLeft:6,fontSize:10,fontWeight:700,textTransform:'uppercase',letterSpacing:'.06em',padding:'2px 6px',borderRadius:14,background:'#1d4ed820',color:'#60a5fa',border:'1px solid #3b82f640'}}>USDOT</span>
                    )}
                    {p.mc_number && (
                      <span title={`MC ${p.mc_number}`} style={{marginLeft:6,fontSize:10,fontWeight:700,textTransform:'uppercase',letterSpacing:'.06em',padding:'2px 6px',borderRadius:14,background:'#1d4ed820',color:'#60a5fa',border:'1px solid #3b82f640'}}>MC#</span>
                    )}
                    <span style={{fontSize:12,color:'var(--text-muted)',marginLeft:8}}>{p.holder_name || ''}{p.phone ? ` · ${p.phone}` : ''}</span>
                    {p.back_plate && <div style={{fontSize:11,fontWeight:700,fontFamily:"'Courier New',monospace",letterSpacing:'.05em',color:'var(--text-muted)',marginTop:2}}>Trailer · {p.back_plate}</div>}
                    {p.usdot_number && <div style={{fontSize:11,color:'var(--text-muted)',marginTop:2}}>USDOT {p.usdot_number}</div>}
                    {p.mc_number && <div style={{fontSize:11,color:'var(--text-muted)',marginTop:2}}>MC {p.mc_number}</div>}
                  </div>
                  <div style={{display:'flex',gap:6,flexShrink:0}}>
                    {p.status === 'pending' && (
                      <button onClick={() => handleApprovePlate(p.id)} style={{background:'rgba(74,222,128,.12)',color:'#4ade80',border:'1px solid rgba(74,222,128,.3)',borderRadius:6,padding:'4px 10px',fontSize:11,fontWeight:700,cursor:'pointer',fontFamily:'inherit'}}>Approve</button>
                    )}
                    <button onClick={() => handleRemovePlate(p.id)} style={{background:'rgba(239,68,68,.1)',color:'#ef4444',border:'1px solid rgba(239,68,68,.3)',borderRadius:6,padding:'4px 10px',fontSize:11,fontWeight:700,cursor:'pointer'}}>Remove</button>
                  </div>
                </div>
                <SightingStrip sightings={mySightings} cameras={cameras} nowTick={nowTick} />
              </div>
            );
          })}
          {plates.length === 0 && <div className="pd-empty">No approved plates yet</div>}
        </div>
      )}

      {/* ActivePassTracker was deleted — it duplicated what TruckParkingLog
          already does (search, status filters, tow/no-tow per row). Per the
          consolidation: search-first workflow is the right operator UX, and
          owners get the same data via the Parking Log. Image preview moved
          inline into Parking Log rows. */}

      {/* Parking Log — primary surface for both operators and owners. */}
      {showSection('log') && (isTruckPlaza ? (
        <>
          <div className="pd-section-head">
            <div style={{display:'flex',alignItems:'baseline',gap:8}}>
              <span className="pd-section-title">Parking Pass Log</span>
              <span className="pd-section-count">{passTotalCount.toLocaleString()}</span>
            </div>
            <div className="pd-section-meta">
              <span style={{width:6,height:6,borderRadius:'50%',background:'#4ade80',animation:'pulse-dot 1.5s infinite'}} />
              Live
            </div>
          </div>
          <ErrorBoundary label="truck parking log"><React.Suspense fallback={<SkeletonCards />}><TruckParkingLog propertyId={propertyId} propertyType={property?.property_type} payToParkEnabled={property?.pay_to_park_enabled === true} isOwner={isOwner} /></React.Suspense></ErrorBoundary>
        </>
      ) : (
        // Apartment permit registry (M3): pending approval queue + resident /
        // guest rosters with doc viewing, approve/reject, extend, void.
        <ErrorBoundary label="apartment permits"><ApartmentPermits property={property} /></ErrorBoundary>
      ))}

      {/* History — permanent, all-time record of every registration (truck
          plazas). For the tow company / owner to audit everything, forever. */}
      {showSection('history') && isTruckPlaza && (
        <>
          <div className="pd-section-head">
            <div style={{display:'flex',alignItems:'baseline',gap:8}}>
              <span className="pd-section-title">History</span>
            </div>
            <div className="pd-section-meta">All registrations · all time</div>
          </div>
          <ErrorBoundary label="history"><React.Suspense fallback={<SkeletonCards />}><TruckParkingLog propertyId={propertyId} propertyType={property?.property_type} payToParkEnabled={property?.pay_to_park_enabled === true} isOwner={isOwner} mode="history" /></React.Suspense></ErrorBoundary>
        </>
      )}

      {/* Cameras — owner-only. Partners don't manage hardware. */}
      {showSection('cameras') && isOwner && (
        <>
          <div className="pd-section-head">
            <div style={{display:'flex',alignItems:'baseline',gap:8}}>
              <span className="pd-section-title">ALPR Cameras</span>
              <span className="pd-section-count">{cameras.length}</span>
            </div>
            <button onClick={() => { setShowAddCam(!showAddCam); setNewApiKey(null); }} className="pd-share-btn" style={{color:'#3b82f6'}}>{showAddCam ? 'Cancel' : '+ Register'}</button>
          </div>

          {newApiKey && (
            <div style={{background:'rgba(74,222,128,.08)',border:'1px solid rgba(74,222,128,.3)',borderRadius:8,padding:12,marginBottom:12}}>
              <div style={{fontSize:12,fontWeight:700,color:'#4ade80',marginBottom:4}}>Camera registered! Save this API key (shown once):</div>
              <div style={{fontSize:13,fontFamily:'monospace',color:'var(--text-primary)',wordBreak:'break-all',background:'var(--bg-inset)',padding:8,borderRadius:6}}>{newApiKey}</div>
            </div>
          )}

          {showAddCam && (
            <form onSubmit={handleAddCamera} style={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:10,padding:14,marginBottom:12,display:'flex',flexDirection:'column',gap:8}}>
              <input value={newCam.name} onChange={e => setNewCam({...newCam, name: e.target.value})} placeholder="Camera name" required style={{padding:'8px 10px',background:'var(--bg-inset)',border:'1px solid var(--border)',borderRadius:6,color:'var(--text-primary)',fontSize:14}} />
              <input value={newCam.location_description} onChange={e => setNewCam({...newCam, location_description: e.target.value})} placeholder="Location (e.g. Main entrance)" style={{padding:'8px 10px',background:'var(--bg-inset)',border:'1px solid var(--border)',borderRadius:6,color:'var(--text-primary)',fontSize:14}} />
              <button type="submit" disabled={saving} style={{background:'var(--accent)',color:'#fff',border:'none',borderRadius:6,padding:'8px',fontSize:13,fontWeight:700,cursor:'pointer'}}>{saving ? 'Registering...' : 'Register Camera'}</button>
            </form>
          )}

          <div style={{display:'flex',flexDirection:'column',gap:6}}>
            {cameras.map(c => {
              // Health badge: a camera flagged active is only truly healthy if
              // it has phoned home recently. last_seen_at is written by
              // camera-snapshot on every accepted POST. A disabled camera shows
              // a flat "Disabled"; an active one with no/old heartbeat surfaces
              // the brownout (solar/RUT) so dead cameras stop showing green.
              const seenMs = c.last_seen_at ? new Date(c.last_seen_at).getTime() : null;
              const ageMin = seenMs ? (nowTick - seenMs) / 60000 : null;
              let badge;
              if (!c.active) {
                badge = { label: 'Disabled', color: '#ef4444', bg: 'rgba(239,68,68,.12)' };
              } else if (ageMin == null) {
                badge = { label: 'No heartbeat', color: '#ef4444', bg: 'rgba(239,68,68,.12)' };
              } else if (ageMin > 60) {
                badge = { label: 'Stale', color: '#ef4444', bg: 'rgba(239,68,68,.12)' };
              } else if (ageMin > 15) {
                badge = { label: 'Delayed', color: '#fbbf24', bg: 'rgba(251,191,36,.12)' };
              } else {
                badge = { label: 'Active', color: '#4ade80', bg: 'rgba(74,222,128,.12)' };
              }
              return (
              <div key={c.id} style={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8,padding:'10px 12px'}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                  <div style={{fontWeight:700,fontSize:14,color:'var(--text-primary)'}}>{c.name}</div>
                  <div style={{display:'flex',gap:6,alignItems:'center'}}>
                    <span style={{fontSize:10,fontWeight:700,padding:'2px 7px',borderRadius:6,background:badge.bg,color:badge.color}}>{badge.label}</span>
                    <button onClick={async () => { if (!confirm('Remove camera "' + c.name + '"?')) return; try { await db.removeALPRCamera(c.id); const cams = await db.getALPRCameras(propertyId); setCameras(cams); } catch (err) { addToast('Failed to remove camera. ' + (err.message || ''), 'error'); } }} style={{background:'rgba(239,68,68,.1)',color:'#ef4444',border:'1px solid rgba(239,68,68,.3)',borderRadius:6,padding:'2px 8px',fontSize:10,fontWeight:700,cursor:'pointer'}}>Remove</button>
                  </div>
                </div>
                {c.location_description && <div style={{fontSize:12,color:'var(--text-muted)',marginTop:2}}>{c.location_description}</div>}
                {c.last_seen_at
                  ? <div style={{fontSize:11,color:'var(--text-faint)',marginTop:2}}>Last seen: {new Date(c.last_seen_at).toLocaleString()}</div>
                  : c.active && <div style={{fontSize:11,color:'#ef4444',marginTop:2}}>No heartbeat received yet</div>}
              </div>
              );
            })}
            {cameras.length === 0 && <div className="pd-empty">No cameras registered</div>}
          </div>
        </>
      )}

      {/* SC211: Possible no parking pass — brand-v2 drill-down panel, inline within property detail */}
      {isTruckPlaza && showSection('noreg') && noRegViolations.length > 0 && (() => {
        const flaggedCount = noRegViolations.filter(r => r.status === 'flagged').length;
        return (
          <div style={{marginBottom:16}}>
            <div className="pd-section-head">
              <div style={{display:'flex',alignItems:'baseline',gap:6}}>
                <span className="pd-section-title">Possible no parking pass</span>
                {flaggedCount > 0 && <span className="nreg-badge-count">{flaggedCount} flagged</span>}
              </div>
              <div style={{display:'flex',gap:6,alignItems:'center'}}>
                {noRegSelectMode ? (
                  <>
                    <button
                      onClick={() => noRegSelected.size === noRegViolations.length
                        ? setNoRegSelected(new Set())
                        : setNoRegSelected(new Set(noRegViolations.map(r => r.id)))}
                      style={{fontSize:11,fontWeight:700,padding:'5px 10px',borderRadius:6,border:'1px solid var(--border)',background:'var(--bg-card)',color:'var(--text-primary)',cursor:'pointer'}}
                    >{noRegSelected.size === noRegViolations.length ? 'Clear' : 'Select all'}</button>
                    <button
                      onClick={() => { setNoRegSelectMode(false); setNoRegSelected(new Set()); }}
                      style={{fontSize:11,fontWeight:700,padding:'5px 10px',borderRadius:6,border:'1px solid var(--border)',background:'var(--bg-card)',color:'var(--text-muted)',cursor:'pointer'}}
                    >Cancel</button>
                  </>
                ) : (
                  <button
                    onClick={() => setNoRegSelectMode(true)}
                    style={{fontSize:11,fontWeight:700,padding:'5px 10px',borderRadius:6,border:'1px solid var(--border)',background:'var(--bg-card)',color:'var(--text-primary)',cursor:'pointer'}}
                  >Select</button>
                )}
              </div>
            </div>
            <div className="drill-paper">
              {noRegViolations.map(row => {
                const isActing = noRegActing === row.id;
                const anyActing = !!noRegActing;
                const isSelected = noRegSelected.has(row.id);
                const isExpanded = noRegExpanded.has(row.id);
                const strength = (row.presence_strength || '').toLowerCase();
                const stageClass = row.status === 'flagged' ? 'stage-flagged'
                  : row.status === 'pending' ? 'stage-pending'
                  : row.status === 'dismissed' ? 'stage-dismissed'
                  : 'stage-resolved';
                let graceLabel = null;
                if (row.status === 'pending' && row.grace_until) {
                  const minsLeft = Math.max(0, Math.ceil((new Date(row.grace_until) - Date.now()) / 60000));
                  graceLabel = minsLeft > 0 ? `In grace (${minsLeft} min left)` : 'Grace expired';
                }
                const evidence = Array.isArray(row.evidence) ? row.evidence : [];
                const bestConf = row.best_confidence;
                const sorted = evidence.slice().sort((a, b) => (b.confidence || 0) - (a.confidence || 0)).slice(0, 4);
                const bestIdx = sorted.findIndex(e => e.confidence === bestConf);
                const confPct = bestConf != null ? Math.round(bestConf * (bestConf <= 1 ? 100 : 1)) : null;
                const firstSeen = row.first_seen_at || row.created_at;
                const ageMins = firstSeen ? Math.round((Date.now() - new Date(firstSeen)) / 60000) : null;
                const excludeCams = evidence.map(e => e.camera_id).filter(Boolean);
                return (
                  <div
                    key={row.id}
                    className={`nr-row-paper ${stageClass}`}
                    onClick={() => {
                      if (noRegSelectMode) toggleNoRegSelect(row.id);
                      else toggleNoRegExpand(row.id);
                    }}
                    style={isSelected ? { outline: '2px solid #3b82f6', outlineOffset: 2, cursor: 'pointer' } : { cursor: 'pointer' }}
                  >
                    <div className="nr-row-top-paper">
                      <span className="plate-tag-paper">{(row.raw_plate || row.normalized_plate || '—').replace(/([A-Z0-9]{3})([A-Z0-9]+)/, '$1 $2')}</span>
                      <div className="nr-times-paper">
                        {noRegSelectMode && (
                          <span aria-hidden="true" style={{display:'inline-flex',alignItems:'center',justifyContent:'center',width:20,height:20,marginRight:6,borderRadius:4,border:`2px solid ${isSelected ? '#3b82f6' : '#94a3b8'}`,background:isSelected ? '#3b82f6' : 'transparent',color:'#fff',fontSize:12,fontWeight:900,lineHeight:1}}>{isSelected ? '✓' : ''}</span>
                        )}
                        {ageMins != null && <span className="age">{ageMins} min ago</span>}
                        {firstSeen && <span>First seen {fmtDateTime(firstSeen)}</span>}
                      </div>
                    </div>
                    <div className="nr-meta-paper">
                      {strength === 'lingered' ? <span className="badge lingered">Lingered</span> : strength === 'brief' ? <span className="badge">Brief</span> : null}
                      {row.status === 'flagged' && <span className="badge lingered">Flagged</span>}
                      {graceLabel && <span className="badge" style={{background:'var(--amber-bg-paper)',color:'var(--amber-paper)'}}>{graceLabel}</span>}
                      {confPct != null && <span>{confPct}% confidence</span>}
                      {row.last_seen_at && <span>Last seen {fmtDateTime(row.last_seen_at)}</span>}
                      {row.exit_seen_at && <span style={{color:'var(--green-paper)'}}>Exited {fmtDateTime(row.exit_seen_at)}</span>}
                    </div>
                    {sorted.length > 0 && (
                      <div className="nr-snaps-paper">
                        {sorted.map((ev, i) => (
                          <div
                            key={i}
                            className={`nr-snap-paper${bestIdx === i ? ' best' : ''}`}
                            role="button"
                            tabIndex={0}
                            onClick={e => { e.stopPropagation(); setNoRegSnapLightbox({ snaps: sorted, startIndex: i, plate: row.raw_plate || row.normalized_plate }); }}
                            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setNoRegSnapLightbox({ snaps: sorted, startIndex: i, plate: row.raw_plate || row.normalized_plate }); } }}
                          >
                            {ev.url && <img src={ev.url} alt="evidence frame" loading="lazy" />}
                            <span className="snc">{ev.confidence != null ? Math.round(ev.confidence * (ev.confidence <= 1 ? 100 : 1)) + '%' : ''}</span>
                            {ev.taken_at && <span className="snt">{fmtDateTime(ev.taken_at)}</span>}
                          </div>
                        ))}
                      </div>
                    )}
                    {isExpanded && firstSeen && (
                      <CrossCameraSightings
                        plate={row.raw_plate || row.normalized_plate}
                        propertyId={propertyId}
                        when={firstSeen}
                        excludeCameraIds={excludeCams}
                        fmtDateTime={fmtDateTime}
                      />
                    )}
                    <div className="nr-actions-paper" onClick={e => e.stopPropagation()}>
                      <button
                        className="btn-paper"
                        disabled={anyActing}
                        onClick={() => handleNoRegDismiss(row.id)}
                        style={{opacity: anyActing ? 0.6 : 1, cursor: anyActing ? 'wait' : 'pointer'}}
                      >{isActing ? '…' : 'Hide'}</button>
                    </div>
                  </div>
                );
              })}
            </div>
            {noRegSelectMode && noRegSelected.size > 0 && (
              <div style={{
                position:'fixed', bottom:80, right:16, zIndex:50,
                display:'flex',alignItems:'center',gap:10,
                padding:'10px 14px',borderRadius:999,
                background:'#dc2626',color:'#fff',
                boxShadow:'0 8px 28px rgba(220,38,38,.4)',
              }}>
                <span style={{fontSize:13,fontWeight:800}}>{noRegSelected.size} selected</span>
                <button
                  onClick={dismissSelectedNoReg}
                  disabled={noRegBatching}
                  style={{
                    fontSize:13,fontWeight:800,padding:'7px 14px',borderRadius:999,
                    border:'1px solid rgba(255,255,255,.4)',
                    background:noRegBatching ? 'rgba(255,255,255,.2)' : 'rgba(255,255,255,.95)',
                    color:noRegBatching ? '#fff' : '#dc2626',
                    cursor:noRegBatching ? 'wait' : 'pointer',
                  }}
                >{noRegBatching ? 'Dismissing…' : 'Dismiss selected'}</button>
              </div>
            )}
            {noRegSnapLightbox && (
              <SnapsLightbox
                snaps={noRegSnapLightbox.snaps}
                startIndex={noRegSnapLightbox.startIndex}
                plate={noRegSnapLightbox.plate}
                onClose={() => setNoRegSnapLightbox(null)}
              />
            )}
          </div>
        );
      })()}

      {/* Stuck Tows — overstay violations whose partner dispatch exhausted its
          retries (status='dispatch_failed'). Nobody was paged and nothing
          retries, so this is the only place they surface. Owner-only; read-only
          escalation queue. */}
      {isOwner && stuckDispatch.length > 0 && (
        <>
          <div className="pd-section-head">
            <div style={{display:'flex',alignItems:'baseline',gap:8}}>
              <span className="pd-section-title">Stuck Tows</span>
              <span className="pd-section-count">{stuckDispatch.length}</span>
            </div>
            <div className="pd-section-meta" style={{color:'#f87171'}}>Dispatch failed — partner not notified</div>
          </div>
          <div style={{display:'flex',flexDirection:'column',gap:6,marginBottom:16}}>
            {stuckDispatch.slice(0, 25).map(v => {
              const ev = Array.isArray(v.plate_events) ? v.plate_events[0] : v.plate_events;
              const camName = ev?.alpr_cameras?.name;
              return (
                <div key={v.id} style={{background:'var(--bg-card)',border:'1px solid rgba(248,113,113,.3)',borderRadius:8,padding:'10px 12px',display:'flex',alignItems:'center',gap:12}}>
                  {ev?.image_url && <img src={ev.image_url} alt="plate" loading="lazy" style={{width:60,height:46,objectFit:'cover',borderRadius:6,border:'1px solid var(--border-subtle)',flexShrink:0}} />}
                  <div style={{minWidth:0,flex:1}}>
                    <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
                      <span style={{fontFamily:"'Courier New',monospace",background:'#fef3c7',color:'#1c1009',border:'1.5px solid #fbbf24',fontWeight:800,letterSpacing:'.08em',fontSize:13,padding:'3px 9px',borderRadius:4}}>{v.plate_text}</span>
                      <span style={{fontSize:10,fontWeight:700,textTransform:'uppercase',letterSpacing:'.06em',padding:'3px 8px',borderRadius:20,background:'rgba(248,113,113,.12)',color:'#f87171',border:'1px solid rgba(248,113,113,.4)'}}>Dispatch failed</span>
                      {typeof v.dispatch_attempts === 'number' && <span style={{fontSize:11,color:'var(--text-faint)'}}>{v.dispatch_attempts} attempts</span>}
                    </div>
                    <div style={{fontSize:11,color:'var(--text-muted)',marginTop:3}}>
                      {camName ? camName + ' · ' : ''}{new Date(v.created_at).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}
                    </div>
                    {v.last_dispatch_error && <div style={{fontSize:10,color:'var(--text-faint)',marginTop:2,fontStyle:'italic',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{v.last_dispatch_error}</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Needs Review — match_status held for human decision before enforcement.
          Owner-only: partners don't approve flagged plate events. */}
      {isOwner && (() => {
        const reviewable = events.filter(e => ['low_confidence','review_needed','camera_suspended','overstay'].includes(e.match_status));
        if (reviewable.length === 0) return null;
        const statusLabel = {
          low_confidence:      { label: 'Low confidence', color: '#fbbf24' },
          review_needed:       { label: 'Ambiguous match', color: '#fbbf24' },
          camera_suspended:    { label: 'Camera suspended', color: '#f87171' },
          overstay:            { label: 'Overstay', color: '#f87171' },
          partner_truck:       { label: 'Partner truck', color: '#4ade80' },
          visitor_pass_fuzzy:  { label: 'Pass (fuzzy)', color: '#4ade80' },
        };
        return (
          <>
            <div className="pd-section-head">
              <div style={{display:'flex',alignItems:'baseline',gap:8}}>
                <span className="pd-section-title">Needs Review</span>
                <span className="pd-section-count">{reviewable.length}</span>
              </div>
              <div className="pd-section-meta" style={{color:'#fbbf24'}}>No enforcement until cleared</div>
            </div>
            <div style={{display:'flex',flexDirection:'column',gap:6,marginBottom:16}}>
              {reviewable.slice(0, 10).map(ev => {
                const cam = cameraById[ev.camera_id];
                const conf = typeof ev.confidence === 'number' ? Math.round(ev.confidence * (ev.confidence <= 1 ? 100 : 1)) : null;
                const s = statusLabel[ev.match_status] || { label: ev.match_status, color: 'var(--text-faint)' };
                return (
                  <div key={ev.id} style={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8,padding:'10px 12px',display:'flex',alignItems:'center',gap:12}}>
                    {ev.image_url && <img src={ev.image_url} alt="plate" loading="lazy" style={{width:60,height:46,objectFit:'cover',borderRadius:6,border:'1px solid var(--border-subtle)',flexShrink:0}} />}
                    <div style={{minWidth:0,flex:1}}>
                      <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
                        <span style={{fontFamily:"'Courier New',monospace",background:'#fef3c7',color:'#1c1009',border:'1.5px solid #fbbf24',fontWeight:800,letterSpacing:'.08em',fontSize:13,padding:'3px 9px',borderRadius:4}}>{ev.plate_text}</span>
                        <span style={{fontSize:10,fontWeight:700,textTransform:'uppercase',letterSpacing:'.06em',padding:'3px 8px',borderRadius:20,background:`${s.color}20`,color:s.color,border:`1px solid ${s.color}40`}}>{s.label}</span>
                        {conf != null && <span style={{fontSize:11,color:'var(--text-faint)'}}>{conf}%</span>}
                      </div>
                      <div style={{fontSize:11,color:'var(--text-muted)',marginTop:3}}>
                        {cam ? cam.name : 'Camera'} · {new Date(ev.created_at).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}
                      </div>
                      {ev.match_reason && <div style={{fontSize:10,color:'var(--text-faint)',marginTop:2,fontStyle:'italic'}}>{ev.match_reason}</div>}
                    </div>
                    <div style={{display:'flex',gap:6,flexShrink:0}}>
                      <button
                        onClick={async () => {
                          try {
                            const fd = new FormData();
                            fd.append('reason', 'operator review');
                            await apiFetch(`/alpr/events/${ev.id}/dismiss`, { method: 'POST', body: fd });
                            addToast('Event dismissed', 'success');
                            refreshEvents();
                          } catch (err) { addToast('Dismiss failed: ' + (err.message || ''), 'error'); }
                        }}
                        style={{background:'rgba(148,163,184,.12)',color:'var(--text-muted)',border:'1px solid var(--border)',borderRadius:6,padding:'4px 10px',fontSize:11,fontWeight:700,cursor:'pointer'}}>Dismiss</button>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        );
      })()}

      {/* In Lot Now / Plate Holds / Plate Detections — owner-only.
          Partners' single function is "who's signed in / allowed to be here" —
          that's the parking log above. Operational signals below are noise
          for them. */}
      {isOwner && (
      <>
      <div className="pd-section-head">
        <div style={{display:'flex',alignItems:'baseline',gap:8}}>
          <span className="pd-section-title">In Lot Now</span>
          <span className="pd-section-count">{openSessions.length}</span>
        </div>
      </div>
      <div style={{display:'flex',flexDirection:'column',gap:6}}>
        {openSessions.length === 0 ? (
          <div className="pd-empty">Lot is empty</div>
        ) : openSessions.map(s => {
          const enteredMs = new Date(s.entered_at).getTime();
          const mins = Math.floor((nowTick - enteredMs) / 60000);
          const stateColor = s.state === 'registered' ? '#4ade80'
            : s.state === 'resident' ? '#60a5fa'
            : s.state === 'grace'    ? '#fbbf24'
            : s.state === 'expired'  ? '#f87171'
            : 'var(--text-faint)';
          return (
            <div key={s.id} style={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8,padding:'10px 12px',display:'flex',alignItems:'center',gap:12}}>
              <div style={{minWidth:0,flex:1}}>
                <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
                  <span style={{fontFamily:"'Courier New',monospace",background:'#fef3c7',color:'#1c1009',border:'1.5px solid #fbbf24',fontWeight:800,letterSpacing:'.08em',fontSize:13,padding:'3px 9px',borderRadius:4}}>{s.plate_text}</span>
                  {(s.plate_text || '').startsWith('DOT-') && (
                    <span title="No license plate visible — read via USDOT OCR" style={{fontSize:10,fontWeight:700,textTransform:'uppercase',letterSpacing:'.06em',padding:'3px 8px',borderRadius:20,background:'#1d4ed820',color:'#60a5fa',border:'1px solid #3b82f640'}}>USDOT</span>
                  )}
                  {(s.plate_text || '').startsWith('MC-') && (
                    <span title="Matched by Motor Carrier number, not plate" style={{fontSize:10,fontWeight:700,textTransform:'uppercase',letterSpacing:'.06em',padding:'3px 8px',borderRadius:20,background:'#1d4ed820',color:'#60a5fa',border:'1px solid #3b82f640'}}>MC#</span>
                  )}
                  <span style={{fontSize:10,fontWeight:700,textTransform:'uppercase',letterSpacing:'.06em',padding:'3px 8px',borderRadius:20,background:`${stateColor}20`,color:stateColor,border:`1px solid ${stateColor}40`}}>{(s.state || 'unknown').replace('_',' ')}</span>
                  {s.vehicle_type && <span style={{fontSize:11,color:'var(--text-muted)'}}>{s.vehicle_type}</span>}
                </div>
                <div style={{fontSize:11,color:'var(--text-muted)',marginTop:3}}>
                  Here {mins}m · entered {new Date(s.entered_at).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})}
                  {s.last_detected_at && s.last_detected_at !== s.entered_at && (
                    <> · last seen {Math.max(0, Math.floor((nowTick - new Date(s.last_detected_at).getTime()) / 60000))}m ago</>
                  )}
                </div>
                {s.exit_hinted_at && (
                  <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',letterSpacing:'.06em',marginTop:4,color:'#fb923c'}}>
                    Closing soon · exit inferred {Math.max(0, Math.floor((nowTick - new Date(s.exit_hinted_at).getTime()) / 60000))}m ago
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Plate Holds */}
      <div className="pd-section-head">
        <div style={{display:'flex',alignItems:'baseline',gap:8}}>
          <span className="pd-section-title">24-Hour Holds</span>
          <span className="pd-section-count">{activeHolds.length}</span>
        </div>
      </div>
      <div style={{display:'flex',flexDirection:'column',gap:6}}>
        {activeHolds.length === 0 ? (
          <div className="pd-empty">No active holds</div>
        ) : activeHolds.map(h => {
          const untilMs = new Date(h.hold_until).getTime();
          const remaining = Math.max(0, Math.floor((untilMs - nowTick) / 60000));
          return (
            <div key={h.id} style={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8,padding:'10px 12px',display:'flex',alignItems:'center',gap:12}}>
              <div style={{minWidth:0,flex:1}}>
                <span style={{fontFamily:"'Courier New',monospace",background:'#fee2e2',color:'#7f1d1d',border:'1.5px solid #f87171',fontWeight:800,letterSpacing:'.08em',fontSize:13,padding:'3px 9px',borderRadius:4}}>{h.normalized_plate}</span>
                <span style={{fontSize:11,color:'var(--text-muted)',marginLeft:8}}>
                  held {new Date(h.held_at).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})} · {remaining}m left · reason: {h.reason}
                </span>
              </div>
              <button
                onClick={async () => {
                  if (!confirm(`Release the 24h hold on ${h.normalized_plate}?`)) return;
                  try {
                    await db.releasePlateHold(h.id);
                    addToast({ kind:'success', text:`Hold released for ${h.normalized_plate}` });
                    refreshSessions();
                  } catch (err) {
                    addToast({ kind:'error', text:`Release failed: ${err.message}` });
                  }
                }}
                style={{background:'#1f2937',color:'#f9fafb',border:'1px solid #374151',borderRadius:6,padding:'5px 10px',fontSize:11,cursor:'pointer'}}
              >Release</button>
            </div>
          );
        })}
      </div>

      {/* Recent plate detections (live ALPR feed) */}
      <div className="pd-section-head">
        <div style={{display:'flex',alignItems:'baseline',gap:8}}>
          <span className="pd-section-title">Plate Detections</span>
          <span className="pd-section-count">{events.length}</span>
        </div>
        <div className="pd-section-meta" style={{display:'flex',alignItems:'center',gap:10}}>
          <button onClick={() => setGroupBySession(g => !g)}
            title={groupBySession ? 'Showing one row per vehicle visit. Click to see every individual frame.' : 'Showing every individual frame. Click to collapse same-vehicle frames into one row.'}
            style={{
              fontSize:10, fontWeight:700, padding:'3px 9px', borderRadius:14,
              background: groupBySession ? 'rgba(59,130,246,.18)' : 'transparent',
              color: groupBySession ? '#60a5fa' : 'var(--text-muted)',
              border: groupBySession ? '1px solid #3b82f655' : '1px solid var(--border)',
              cursor:'pointer', textTransform:'uppercase', letterSpacing:'.05em',
            }}>
            {groupBySession ? '◉ Grouped' : '○ Group by vehicle'}
          </button>
          <span style={{display:'flex',alignItems:'center',gap:4}}>
            <span style={{width:6,height:6,borderRadius:'50%',background:'#4ade80',animation:'pulse-dot 1.5s infinite'}} />
            Live
          </span>
        </div>
      </div>
      <div style={{display:'flex',flexDirection:'column',gap:6}}>
        {events.length === 0 ? (
          <div className="pd-empty">No plate detections yet</div>
        ) : (() => {
          // When groupBySession is on, collapse all events sharing a session_id
          // into a single representative row (the most recent confirmed-plate
          // event in the session, or the most recent overall if none was a
          // confirmed match). Show a "+N more" badge so the operator knows
          // how many frames are hidden. Click to expand inline.
          let displayRows;
          if (groupBySession) {
            const groups = new Map();
            for (const ev of events) {
              const key = ev.session_id || ev.id; // events without a session stand alone
              if (!groups.has(key)) groups.set(key, []);
              groups.get(key).push(ev);
            }
            displayRows = Array.from(groups.values()).map(grp => {
              // Pick representative: prefer the highest-confidence non-suppressed
              // event (the canonical PR read), fall back to the most recent.
              const canonical = grp
                .filter(e => e.match_status !== 'dedup_suppressed')
                .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0]
                || grp.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
              const groupCount = grp.length;
              return { ...canonical, _groupCount: groupCount, _groupAll: grp };
            }).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
          } else {
            displayRows = events;
          }
          return displayRows.map(ev => {
          const cam = cameraById[ev.camera_id];
          const conf = typeof ev.confidence === 'number' ? Math.round(ev.confidence * (ev.confidence <= 1 ? 100 : 1)) : null;
          const evType = ev.event_type || 'patrol';
          const evColor = evType === 'entry' ? '#4ade80' : (evType === 'exit' ? '#f59e0b' : '#60a5fa');
          const statusColor = ['matched','resident','visitor_pass','self_registered','visitor_pass_fuzzy','partner_truck'].includes(ev.match_status) ? '#4ade80'
            : ['low_confidence','review_needed','camera_suspended','grace_window','pending','overstay'].includes(ev.match_status) ? '#fbbf24'
            : ev.match_status === 'unmatched' ? '#f87171'
            : ev.match_status === 'dedup_suppressed' ? '#94a3b8'
            : 'var(--text-faint)';
          return (
            <div key={ev.id} style={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8,padding:'10px 12px',display:'flex',alignItems:'center',gap:12}}>
              {ev.image_url && (
                <img src={ev.image_url} alt="plate" loading="lazy"
                  style={{width:52,height:40,objectFit:'cover',borderRadius:6,border:'1px solid var(--border-subtle)',flexShrink:0,background:'var(--bg-inset)'}} />
              )}
              <div style={{minWidth:0,flex:1}}>
                <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
                  <span style={{fontFamily:"'Courier New',monospace",background:'#fef3c7',color:'#1c1009',border:'1.5px solid #fbbf24',fontWeight:800,letterSpacing:'.08em',fontSize:13,padding:'3px 9px',borderRadius:4}}>{ev.plate_text}</span>
                  {(ev.plate_text || '').startsWith('DOT-') && (
                    <span title="No license plate visible — read via USDOT OCR (ParkPow)" style={{fontSize:10,fontWeight:700,textTransform:'uppercase',letterSpacing:'.06em',padding:'3px 8px',borderRadius:20,background:'#1d4ed820',color:'#60a5fa',border:'1px solid #3b82f640'}}>USDOT</span>
                  )}
                  {(ev.plate_text || '').startsWith('MC-') && (
                    <span title="Matched by Motor Carrier number" style={{fontSize:10,fontWeight:700,textTransform:'uppercase',letterSpacing:'.06em',padding:'3px 8px',borderRadius:20,background:'#1d4ed820',color:'#60a5fa',border:'1px solid #3b82f640'}}>MC#</span>
                  )}
                  <span style={{fontSize:10,fontWeight:700,textTransform:'uppercase',letterSpacing:'.06em',padding:'3px 8px',borderRadius:20,background:`${evColor}20`,color:evColor,border:`1px solid ${evColor}40`}}>{evType}</span>
                  {ev.match_status && (
                    <span title={ev.match_reason || ev.match_status} style={{fontSize:10,fontWeight:700,textTransform:'uppercase',letterSpacing:'.06em',padding:'3px 8px',borderRadius:20,background:`${statusColor}18`,color:statusColor,border:`1px solid ${statusColor}40`}}>{ev.match_status.replace(/_/g, ' ')}</span>
                  )}
                  {ev.plate_sessions?.state && (
                    <span style={{fontSize:10,fontWeight:700,textTransform:'uppercase',letterSpacing:'.06em',padding:'3px 8px',borderRadius:20,background:'#1f293720',color:'#9ca3af',border:'1px solid #37415140'}}>session: {ev.plate_sessions.state.replace('_',' ')}</span>
                  )}
                  {ev._groupCount > 1 && (
                    <span title="Same-vehicle frames collapsed; click 'Group by vehicle' off to see all"
                      style={{fontSize:10,fontWeight:700,padding:'3px 8px',borderRadius:20,background:'rgba(59,130,246,.18)',color:'#60a5fa',border:'1px solid #3b82f655'}}>
                      +{ev._groupCount - 1} more frame{ev._groupCount > 2 ? 's' : ''}
                    </span>
                  )}
                  {conf != null && <span style={{fontSize:11,color:'var(--text-faint)'}}>{conf}%</span>}
                </div>
                <div style={{fontSize:11,color:'var(--text-muted)',marginTop:3,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                  {cam ? cam.name : 'Camera'}{cam?.location_description ? ` · ${cam.location_description}` : ''} · {new Date(ev.created_at).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}
                </div>
              </div>
            </div>
          );
        });
        })()}
      </div>
      </>
      )}
    </div>
  );
}

export default ALPRPropertyDetailPage;
