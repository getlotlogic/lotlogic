import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { apiFetch } from '../lib/api.js';
import { db } from '../lib/db.js';
import { EventPhoto, usePhotoUrl } from './eventPhoto.jsx';
import { fmtVisitDate, fmtStay, fmtCooldownDateTime, fmtHrsShort } from '../lib/passFormat.js';

// ── Truck Parking Log ────────────────────────────────────────
// Paginated, filterable temporary-pass log for truck_plaza properties.
// Data comes from the backend /visitor_passes/parking-log endpoint — the same
// shape as the CSV export so the two never drift.

// Repeat-offender chip. Renders ONLY when a pass carries cooldown_flagged_at
// (re-registered inside the cooldown window). Click toggles a lazy-fetched
// list of the truck's recent visits from the owner/partner-scoped backend
// endpoint. priorFlagCount > 0 appends "flagged N× before".
export function CooldownChip({ passId, priorFlagCount, registeredAt, priorEnd }) {
  const [open, setOpen] = React.useState(false);
  const [visits, setVisits] = React.useState(null); // null=unfetched, []=none
  const [loading, setLoading] = React.useState(false);
  const toggle = async () => {
    const next = !open; setOpen(next);
    if (next && visits === null) {
      setLoading(true);
      try {
        const res = await apiFetch(`/visitor_passes/${passId}/recent-visits`);
        setVisits(Array.isArray(res) ? res : (res?.visits || []));
      } catch { setVisits([]); }
      finally { setLoading(false); }
    }
  };
  // How badly the 24h cooldown was broken: they left at priorEnd, were allowed
  // back at priorEnd+24h, but re-registered at registeredAt.
  let breach = null;
  if (registeredAt && priorEnd) {
    const after = (new Date(registeredAt) - new Date(priorEnd)) / 3600000;
    if (!isNaN(after) && after >= 0 && after < 24) breach = { after, before: 24 - after };
  }
  const countSuffix = priorFlagCount > 0 ? ` · ${priorFlagCount}× before` : '';
  const body = breach
    ? `Back ${fmtHrsShort(breach.after)} after the prior pass ended${countSuffix}`
    : `Returned inside the cooldown window${countSuffix}`;
  // Same red TOW banner as ReregTowFlag — cooldown re-registration is the same
  // violation class; only the text differs. Keeps the expandable prior-visits.
  return (
    <div className="cooldown-chip-wrap" style={{
      marginTop: 8,
      background: 'rgba(239,68,68,.12)',
      border: '1px solid rgba(239,68,68,.45)',
      borderLeft: '4px solid #ef4444',
      borderRadius: 8,
      padding: '10px 12px',
    }}>
      <div style={{display:'flex',alignItems:'center',gap:8}}>
        <span style={{
          fontSize: 11, fontWeight: 900, letterSpacing: '.06em',
          color: '#fff', background: '#dc2626',
          padding: '2px 8px', borderRadius: 5, whiteSpace: 'nowrap',
        }}>🚨 TOW</span>
        <span style={{fontSize:13,fontWeight:800,color:'#ef4444'}}>Re-registered within the 24-hour cooldown</span>
      </div>
      <div style={{fontSize:12,color:'var(--text-secondary)',lineHeight:1.45,marginTop:4}}>{body}</div>
      <button className="cooldown-chip-cta" onClick={toggle} aria-expanded={open} style={{
        marginTop:6, background:'none', border:'none', padding:0, cursor:'pointer',
        color:'#ef4444', fontWeight:700, fontSize:12,
      }}>
        {open ? 'Hide prior visits ▴' : 'See prior visits ▾'}
      </button>
      {open && (
        <div className="cooldown-visits">
          {breach && (
            <div className="cooldown-breach">
              <div className="cooldown-breach-line">
                Prior pass ended <b>{fmtCooldownDateTime(priorEnd)}</b> → re-registered <b>{fmtCooldownDateTime(registeredAt)}</b>
              </div>
              <div className="cooldown-breach-emph">
                Re-registered {fmtHrsShort(breach.after)} after the prior pass ended · {fmtHrsShort(breach.before)} before the 24-hour cooldown cleared
              </div>
              <div className="cooldown-breach-line" style={{marginTop:6,color:'var(--text-muted)',fontSize:11}}>
                Based on registration times. Camera evidence is shown separately when a read exists — this flag is not, by itself, proof the truck was on the lot.
              </div>
            </div>
          )}
          <div className="cooldown-visits-head">Prior visits at this lot</div>
          {loading && <div className="cooldown-visits-loading">Loading…</div>}
          {visits && visits.length === 0 && !loading && (
            <div className="cooldown-visits-empty">No earlier visits on record.</div>
          )}
          {visits && visits.map(v => (
            <div className="cooldown-visit-row" key={v.id}>
              <EventPhoto eventId={v.photo_event_id} className="cooldown-visit-thumb" alt="" />
              <span className="cooldown-visit-date">{fmtVisitDate(v.date)}</span>
              <span className="cooldown-visit-stay">{fmtStay(v.stay_hours)}</span>
              <span className="cooldown-visit-outcome">{v.outcome}</span>
              {v.flagged && <span className="cooldown-visit-flag">⚠ flagged</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
// Re-registration → TOW banner. Renders on a pass the backend flagged because
// the truck registered again while it ALREADY held an active pass at this lot
// (matched on plate OR phone) — resetting its stay to dodge the 24h cooldown.
// Operator/tow-partner facing only; the driver is never shown this.
export function ReregTowFlag({ pass }) {
  // PLATE match = same truck re-upping (tow); PHONE-only (different plate) =
  // likely a second truck from the same company (review). Below the banner we
  // show BOTH overlapping passes — dates + photos — as on-the-spot proof for
  // the tow driver that the truck holds two passes at once.
  const phoneOnly = pass.matched_on === 'phone';
  const cfg = phoneOnly
    ? { accent:'#f59e0b', bg:'rgba(245,158,11,.10)', border:'rgba(245,158,11,.45)',
        chipBg:'#b45309', chip:'⚠ REVIEW', title:'Same phone, different plate',
        body:'A new pass shares this phone with an active one here, but the plate is different — likely a second truck from the same company. Verify before any tow.' }
    : { accent:'#ef4444', bg:'rgba(239,68,68,.12)', border:'rgba(239,68,68,.45)',
        chipBg:'#dc2626', chip:'🚨 TOW', title:'Re-registered while already parked',
        body:'Registered a new pass while a prior one here is still active (same plate).' };
  const ref = (id) => id ? '#' + String(id).slice(-8) : '';
  // The photo slot keeps its 48×34 box whether or not a photograph resolves —
  // the grey tile IS the placeholder, so the two proof rows never jump.
  const passRow = (label, from, until, id, photoEventId) => (
    <div style={{display:'flex',alignItems:'center',gap:10,padding:'6px 0',borderTop:'1px solid var(--border)'}}>
      <EventPhoto
        eventId={photoEventId}
        alt=""
        style={{width:48,height:34,objectFit:'cover',borderRadius:5,flex:'none'}}
        placeholder={<div style={{width:48,height:34,borderRadius:5,flex:'none',background:'var(--border)'}} />}
      />
      <div style={{display:'flex',flexDirection:'column',minWidth:0}}>
        <span style={{fontSize:12,fontWeight:700,color:'var(--text-primary)'}}>{label} · {ref(id)}</span>
        <span style={{fontSize:12,color:'var(--text-muted)'}}>{fmtCooldownDateTime(from)} → {fmtCooldownDateTime(until)}</span>
      </div>
    </div>
  );
  return (
    <div style={{
      marginTop: 8,
      background: cfg.bg,
      border: `1px solid ${cfg.border}`,
      borderLeft: `4px solid ${cfg.accent}`,
      borderRadius: 8,
      padding: '10px 12px',
      display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      <div style={{display:'flex',alignItems:'center',gap:8}}>
        <span style={{
          fontSize: 11, fontWeight: 900, letterSpacing: '.06em',
          color: '#fff', background: cfg.chipBg,
          padding: '2px 8px', borderRadius: 5, whiteSpace: 'nowrap',
        }}>{cfg.chip}</span>
        <span style={{fontSize:13,fontWeight:800,color:cfg.accent}}>{cfg.title}</span>
      </div>
      <div style={{fontSize:12,color:'var(--text-secondary)',lineHeight:1.45}}>
        {cfg.body}
      </div>
      <div style={{marginTop:2}}>
        <div style={{fontSize:11,fontWeight:600,letterSpacing:'.03em',color:'var(--text-muted)',textTransform:'uppercase',marginBottom:2}}>Proof — two passes at once</div>
        {passRow('Already active', pass.matched_valid_from, pass.matched_valid_until, pass.matched_active_pass_id, pass.matched_first_seen_event_id)}
        {passRow('This registration', pass.valid_from, pass.valid_until, pass.id, pass.first_seen_event_id)}
      </div>
    </div>
  );
}
// Inline vehicle image preview for a pass / violation row. Lazy-loads the best
// camera frame on intersection (exact->back->fuzzy via getBestVehicleFrame) and
// caches it in the parent's vehicleImageCache. MODULE-SCOPED (not nested in
// TruckParkingLog) so it has a stable component identity: a nested definition
// is a new function object every parent render, which makes React unmount/remount
// every instance and re-create its IntersectionObserver on each setCache call.
// Cache + setter come in as props so the parent still owns the state.
// ── Pass photos: ONE presentation for every camera frame on a pass ─────────
// Replaces the old three-way split (FirstSeenEvidence / VehicleImage /
// ExitImage) — three widgets, three styles, one of them not expandable at
// all. Per the standing design rule, every camera frame is just "the
// vehicle's photo": the strip renders however many the pass has in one
// uniform grid, and everything opens in one full-screen viewer with swipe
// (phone), arrow keys (desktop), counter and caption.
function PassPhotoViewer({ photos, startIndex, plate, exitEventId, onClose }) {
  const [i, setI] = useState(startIndex || 0);
  const touchX = useRef(null);
  const n = photos.length;
  const cur = photos[i] || photos[0];
  // Three presigns in flight at once — the frame on screen and its two
  // neighbours — so an arrow key or a swipe lands on an already-minted URL.
  // db.photoUrl memoises per event, so revisiting a frame costs nothing.
  const curUrl = usePhotoUrl(cur && cur.id);
  const nextUrl = usePhotoUrl(photos[i + 1] && photos[i + 1].id);
  const prevUrl = usePhotoUrl(photos[i - 1] && photos[i - 1].id);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') setI(v => Math.min(n - 1, v + 1));
      else if (e.key === 'ArrowLeft') setI(v => Math.max(0, v - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [n, onClose]);
  if (!cur) return null;
  const cap = (p) => `${p.camera || 'camera'} · ${p.at ? new Date(p.at).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) : ''}${p.id === exitEventId ? ' · exit read' : ''}`;
  return (
    <div
      role="dialog" aria-modal="true" aria-label={`Photos for ${plate || 'parking pass'} — swipe or use arrow keys, Escape closes`}
      onClick={onClose}
      onTouchStart={(e) => { touchX.current = e.touches[0].clientX; }}
      onTouchEnd={(e) => {
        if (touchX.current == null) return;
        const dx = e.changedTouches[0].clientX - touchX.current;
        touchX.current = null;
        if (dx < -40) setI(v => Math.min(n - 1, v + 1));
        else if (dx > 40) setI(v => Math.max(0, v - 1));
      }}
      style={{position:'fixed',inset:0,background:'rgba(0,0,0,.92)',zIndex:1000,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:'16px 8px'}}
    >
      <button
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        aria-label="Close photo viewer"
        style={{position:'absolute',top:'max(10px, env(safe-area-inset-top))',right:12,width:44,height:44,borderRadius:22,border:'1px solid rgba(255,255,255,.3)',background:'rgba(0,0,0,.5)',color:'#fff',fontSize:20,cursor:'pointer',zIndex:2}}
      >✕</button>
      <div onClick={(e) => e.stopPropagation()} style={{maxWidth:'96vw',display:'flex',flexDirection:'column',alignItems:'center',gap:10}}>
        <img src={curUrl || undefined} alt={cap(cur)} style={{maxWidth:'96vw',maxHeight:'76vh',objectFit:'contain',borderRadius:8,background:'#000'}} />
        <div style={{color:'#fff',fontSize:14,textAlign:'center',display:'flex',alignItems:'center',gap:12,flexWrap:'wrap',justifyContent:'center'}}>
          <span style={{fontFamily:'ui-monospace, monospace',fontWeight:800,letterSpacing:1}}>{plate || ''}</span>
          <span style={{opacity:.85}}>{cap(cur)}</span>
          {n > 1 && <span style={{opacity:.7,fontVariantNumeric:'tabular-nums'}}>{i + 1} / {n}</span>}
        </div>
        {n > 1 && (
          <div style={{display:'flex',alignItems:'center',gap:14}}>
            <button onClick={() => setI(v => Math.max(0, v - 1))} disabled={i === 0} aria-label="Previous photo"
              style={{width:44,height:44,borderRadius:22,border:'1px solid rgba(255,255,255,.3)',background:'rgba(255,255,255,.08)',color:'#fff',fontSize:18,cursor:i===0?'default':'pointer',opacity:i===0?.35:1}}>←</button>
            <div style={{display:'flex',gap:6}} aria-hidden="true">
              {photos.slice(0, 10).map((p, d) => (
                <span key={p.id || d} style={{width:8,height:8,borderRadius:4,background:d===i?'#fff':'rgba(255,255,255,.35)'}} />
              ))}
            </div>
            <button onClick={() => setI(v => Math.min(n - 1, v + 1))} disabled={i === n - 1} aria-label="Next photo"
              style={{width:44,height:44,borderRadius:22,border:'1px solid rgba(255,255,255,.3)',background:'rgba(255,255,255,.08)',color:'#fff',fontSize:18,cursor:i===n-1?'default':'pointer',opacity:i===n-1?.35:1}}>→</button>
          </div>
        )}
        {/* Preload neighbours so swiping never shows a blank frame. Both the
            presign and the image bytes are warmed, in that order. */}
        {nextUrl && <img src={nextUrl} alt="" style={{display:'none'}} />}
        {prevUrl && <img src={prevUrl} alt="" style={{display:'none'}} />}
      </div>
    </div>
  );
}

// Thumbnail that zooms toward the vehicle that produced the read. `box` is
// either a PR box {xmin,ymin,xmax,ymax} (pixels of the original frame) or a
// camera tracker box {x1,y1,x2,y2,res_w,res_h}. Without a box (older events)
// it renders exactly like the plain cover image. Full-frame evidence stays
// available in the viewer — only the thumbnail crops.
function CroppedImg({ eventId, box }) {
  const src = usePhotoUrl(eventId);
  const [dims, setDims] = useState(null);
  const base = {position:'absolute',inset:0,width:'100%',height:'100%',objectFit:'cover'};
  let style = base;
  if (box && dims) {
    const x1 = box.xmin ?? box.x1, y1 = box.ymin ?? box.y1;
    const x2 = box.xmax ?? box.x2, y2 = box.ymax ?? box.y2;
    const W = box.res_w || dims.w, H = box.res_h || dims.h;
    if ([x1, y1, x2, y2].every(v => typeof v === 'number' && isFinite(v)) && W > 0 && H > 0 && x2 > x1 && y2 > y1) {
      const cx = ((x1 + x2) / 2 / W) * 100;
      const cy = ((y1 + y2) / 2 / H) * 100;
      const boxFrac = Math.max((x2 - x1) / W, (y2 - y1) / H);
      // Zoom so the vehicle fills most of the tile; cap so tiny plate-only
      // boxes don't blow up into unrecognizable pixels.
      const zoom = Math.min(Math.max(0.45 / Math.max(boxFrac, 0.02), 1), 3.5);
      style = { ...base, objectPosition: `${cx}% ${cy}%`, transformOrigin: `${cx}% ${cy}%`, transform: `scale(${zoom})` };
    }
  }
  if (!src) return null;
  return <img src={src} alt="" loading="lazy" style={style}
    onLoad={box ? (e) => setDims({ w: e.target.naturalWidth, h: e.target.naturalHeight }) : undefined} />;
}

export function PassPhotoStrip({ pass, propertyId, cache, setCache }) {
  const containerRef = useRef(null);
  const [viewer, setViewer] = useState(null); // startIndex when open
  const entry = cache[pass.id];
  // A FAILED fetch is retryable after 15s; a successful empty result is
  // permanent. Without this split, one transient Supabase 503 stamped
  // {empty} into the cache for every strip on screen and ALL pass photos
  // vanished until a full reload happened to land in a healthy window.
  const retryable = entry?.failedAt && (Date.now() - entry.failedAt > 15000);
  useEffect(() => {
    if (entry && !retryable) return; // loaded, loading, or known-empty
    const el = containerRef.current;
    if (!el || !pass.id) return;
    const obs = new IntersectionObserver((entries) => {
      if (!entries[0].isIntersecting) return;
      obs.disconnect();
      setCache(c => ({ ...c, [pass.id]: { loading: true } }));
      (async () => {
        try {
          let photos = await db.getPassPhotos(pass.id);
          // A pass can point at its first-seen read without that read being
          // linked back to the pass (older backfills) — keep it, deduped by id.
          if (pass.first_seen_event_id && !photos.some(p => p.id === pass.first_seen_event_id)) {
            photos.unshift({ id: pass.first_seen_event_id, at: pass.first_seen_at || null, camera: null });
          }
          // No linked photos at all → the old best-frame fuzzy fallback, so
          // properties/passes that only ever had window-matched frames keep
          // their picture.
          if (photos.length === 0 && propertyId && pass.plate_text) {
            const ev = await db.getBestVehicleFrame(propertyId, pass.plate_text, pass.back_plate, pass.valid_from, pass.valid_until);
            if (ev?.event_id) photos = [{ id: ev.event_id, at: ev.created_at, camera: ev.camera_name || null }];
          }
          setCache(c => ({ ...c, [pass.id]: photos.length ? { photos } : { empty: true } }));
        } catch {
          setCache(c => ({ ...c, [pass.id]: { empty: true, failedAt: Date.now() } }));
        }
      })();
    }, { rootMargin: '200px' });
    obs.observe(el);
    return () => obs.disconnect();
  }, [pass.id, entry, propertyId, setCache]);

  if (entry?.empty && !entry?.failedAt) return null;
  const photos = entry?.photos || [];
  // FIXED-HEIGHT strip — this is the layout-shift fix. The old variable-height
  // grid popped in after lazy-load and shoved the No tow / Mark towed buttons
  // 100-300px mid-reach; operators reported taps landing on the wrong thing.
  // Now: if the pass is KNOWN to have a photo at first paint, the row's space
  // is reserved synchronously, so loading in the photos changes NOTHING about
  // the card's geometry. All photos render in one horizontally-scrollable row
  // at the same height.
  //
  // The "known" signal is `first_seen_event_id` — the pass's own column, so
  // still synchronous at first paint. It used to be `first_seen_image_url`,
  // which stopped being fetched when photo URLs became presigned-on-demand
  // (Wave 2.5 Task 10). A pass that has a first-seen read has a photograph of
  // it: the two were written together.
  const STRIP_H = 140;
  const reserve = photos.length > 0 || !!pass.first_seen_event_id || !!entry?.loading;
  const capText = (p) => `${p.camera || 'camera'}${p.at ? ' · ' + new Date(p.at).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) : ''}`;
  return (
    <div ref={containerRef} style={{
      // Observable-while-idle: display:none never intersects, so idle = 1px.
      height: reserve ? STRIP_H : 1,
      background: reserve && !photos.length ? 'var(--bg-inset)' : 'transparent',
      borderRadius: 8, position: 'relative', overflow: 'hidden',
    }}>
      {reserve && !photos.length && (
        <div style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center',fontSize:11,color:'var(--text-faint)',letterSpacing:'.04em',textTransform:'uppercase'}}>Loading photos…</div>
      )}
      {photos.length > 0 && (
        <div style={{display:'flex',gap:6,height:'100%',overflowX:'auto',WebkitOverflowScrolling:'touch',scrollSnapType:'x proximity'}}>
          {photos.map((p, idx) => (
            <button
              key={p.id || idx}
              type="button"
              onClick={(e) => { e.stopPropagation(); setViewer(idx); }}
              aria-label={`View photo ${idx + 1} of ${photos.length} for ${pass.plate_text || 'parking pass'} — ${capText(p)}`}
              style={{position:'relative',display:'block',flex:'0 0 auto',height:'100%',aspectRatio:'16/9',padding:0,border:'1px solid var(--border)',borderRadius:8,overflow:'hidden',background:'#000',cursor:'zoom-in',scrollSnapAlign:'start'}}
            >
              <CroppedImg eventId={p.id} box={p.box} />
              <span style={{position:'absolute',bottom:0,left:0,right:0,padding:'3px 7px',background:'linear-gradient(to top, rgba(0,0,0,.72), rgba(0,0,0,0))',fontSize:10,color:'#fff',textAlign:'left',display:'flex',justifyContent:'space-between',gap:6}}>
                <span style={{fontWeight:700,letterSpacing:'.03em',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{capText(p)}</span>
                {p.id === pass.exited_via_plate_event_id && <span style={{fontWeight:700}}>exit</span>}
              </span>
            </button>
          ))}
          {photos.length > 1 && (
            <span aria-hidden="true" style={{position:'sticky',right:0,alignSelf:'flex-start',marginLeft:-34,padding:'2px 7px',background:'rgba(0,0,0,.6)',color:'#fff',fontSize:10,fontWeight:800,borderRadius:8}}>{photos.length} photos</span>
          )}
        </div>
      )}
      {/* PORTAL, not inline: this strip sits inside overflow:hidden with an
          animated (transformed) ancestor, which turns position:fixed into
          position:fixed-relative-to-the-card — the viewer rendered as a dark
          smear squeezed into the card column. document.body escapes all of it.
          Same pattern as the existing createPortal overlay. */}
      {viewer !== null && createPortal(
        <PassPhotoViewer photos={photos} startIndex={viewer} plate={pass.plate_text} exitEventId={pass.exited_via_plate_event_id} onClose={() => setViewer(null)} />,
        document.body
      )}
    </div>
  );
}
