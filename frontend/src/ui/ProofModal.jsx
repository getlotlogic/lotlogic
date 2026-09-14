import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { supabase } from '../lib/supabase.js';
import { isVehicleInZone } from '../lib/geometry.js';
import { colorHex } from '../lib/vehicles.js';
import { resolveCameraSnapshot } from '../lib/db.js';
import { usePhotoUrl } from './eventPhoto.jsx';

// ── Image zoom overlay ──────────────────────────────────────
export function ImageZoom({ src, alt, onClose }) {
  if (!src) return null;
  return (
    <div className="snap-zoom-overlay" onClick={onClose}>
      <img src={src} alt={alt || 'Zoomed view'} onClick={e => e.stopPropagation()} />
      <button className="snap-zoom-close" onClick={onClose} aria-label="Close zoomed image">✕</button>
    </div>
  );
}

// ── Violation Proof Modal — iMessage-style full-screen photo viewer ──
// Detection bbox colors — module scope so the hoisted ProofImage can read it
// (the component-local copies inside the modals shadow this harmlessly).
const DET_COLORS = { car: '#3b82f6', truck: '#8b5cf6', bus: '#0d9488', motorcycle: '#ea580c', person: '#f59e0b' };

// Uses React Portal to render directly on document.body, bypassing all
// ancestor transforms that would trap position:fixed.
function ProofImage({ src, label, detection, timestamp }) {
  const imgRef = useRef(null);
  const wrapRef = useRef(null);
  const [loaded, setLoaded] = useState(false);
  const [coverPos, setCoverPos] = useState(null);

  const calcCover = useCallback(() => {
    const img = imgRef.current;
    const wrap = wrapRef.current;
    if (!img || !wrap || !img.naturalWidth) return;
    const cW = wrap.clientWidth, cH = wrap.clientHeight;
    const nW = img.naturalWidth, nH = img.naturalHeight;
    const scale = Math.max(cW / nW, cH / nH);
    const rW = nW * scale, rH = nH * scale;
    setCoverPos({ offX: (cW - rW) / 2, offY: (cH - rH) / 2, rW, rH });
  }, []);

  const det = detection;
  const cls = det ? (det.class || 'vehicle').toLowerCase() : 'car';
  const color = DET_COLORS[cls] || '#3b82f6';

  return (
    <div style={{flex:'1 1 0', minWidth:0}}>
      <div style={{fontSize:10, fontWeight:600, color:'rgba(255,255,255,.5)', marginBottom:6, textTransform:'uppercase', letterSpacing:'.06em', display:'flex', alignItems:'center', gap:6}}>
        {label}
        {timestamp && <span style={{fontWeight:500, color:'rgba(255,255,255,.3)', textTransform:'none', letterSpacing:0, fontSize:10}}>{timestamp}</span>}
      </div>
      <div ref={wrapRef} style={{position:'relative', borderRadius:10, overflow:'hidden', background:'#111', aspectRatio:'16/9', maxHeight:'calc(100vh - 120px)'}}>
        {src ? (
          <>
            <img ref={imgRef} src={src} alt={label}
              onLoad={() => { setLoaded(true); setTimeout(calcCover, 0); }}
              style={{width:'100%', height:'100%', objectFit:'cover', display: loaded ? 'block' : 'none'}}
            />
            {!loaded && (
              <div style={{position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center'}}>
                <div className="spin" style={{marginRight:8}} />
                <span style={{color:'rgba(255,255,255,.3)', fontSize:12}}>Loading…</span>
              </div>
            )}
            {loaded && det && coverPos && (() => {
              const [x1, y1, x2, y2] = det.bbox;
              const px = coverPos.offX + x1 * coverPos.rW;
              const py = coverPos.offY + y1 * coverPos.rH;
              const pw = (x2 - x1) * coverPos.rW;
              const ph = (y2 - y1) * coverPos.rH;
              return (
                <div style={{
                  position:'absolute', left:px, top:py, width:pw, height:ph,
                  border:`2px solid ${color}`, borderRadius:3,
                  pointerEvents:'none', boxSizing:'border-box',
                }} />
              );
            })()}
          </>
        ) : (
          <div style={{position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center', flexDirection:'column', gap:8}}>
            {label === 'Current' && <div className="spin" />}
            <span style={{color:'rgba(255,255,255,.3)', fontSize:12}}>{label === 'Current' ? 'Loading live view\u2026' : 'No snapshot'}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function ViolationProofModal({ violation, latestSnapshotUrl, latestDetections, cameraZones, matchedDetection, tunnelSnapshotUrl, onClose, onAutoGone }) {
  // An ALPR violation's detection photo is a plate read, not a YOLO snapshot:
  // its URL is presigned on demand rather than carried on the row. The two
  // legacy `_*_snapshot_url` fields still win when present, so the "Current"
  // camera-snapshot fallback restored in PR #243 is untouched by this.
  const detectionUrl = usePhotoUrl(violation._snapshot_event_id);
  if (!violation) return null;
  const DET_COLORS = { car: '#3b82f6', truck: '#8b5cf6', bus: '#0d9488', motorcycle: '#ea580c', person: '#f59e0b' };
  const det = matchedDetection;

  // Live-poll the latest snapshot from this camera every 10s while modal is open
  const [liveUrl, setLiveUrl] = useState(null);
  const [liveDets, setLiveDets] = useState(latestDetections);
  const [liveTime, setLiveTime] = useState(null);

  useEffect(() => {
    if (!supabase || !violation.camera_id) return;
    let cancelled = false;
    const poll = async () => {
      try {
        // Try DB snapshot first, then tunnel fallback via shared utility
        const result = await resolveCameraSnapshot(violation.camera_id, tunnelSnapshotUrl);
        if (cancelled) return;
        if (result?.url) {
          setLiveUrl(result.url);
          if (result.capturedAt) {
            const ago = Math.round((Date.now() - new Date(result.capturedAt).getTime()) / 1000);
            setLiveTime(ago < 60 ? `${ago}s ago` : `${Math.round(ago / 60)}m ago`);
          }
        }
        // Update detections from DB snapshot if available
        if (result?.snap?.raw_detections) {
          const dets = (result.snap.raw_detections.detections || []).map((d, i) => ({
            id: `det_${i}`,
            type: d.class === 'person' ? 'person' : 'vehicle',
            bbox: d.bbox ? { x: d.bbox[0] * 100, y: d.bbox[1] * 100, w: (d.bbox[2] - d.bbox[0]) * 100, h: (d.bbox[3] - d.bbox[1]) * 100 } : null,
            confidence: d.conf,
            label: d.class,
          }));
          setLiveDets(dets);
        }
      } catch (e) { console.warn('Live snapshot poll error:', e); }
    };
    poll(); // fetch immediately on open
    const iv = setInterval(poll, 10000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [violation.camera_id]);

  // Check if vehicle is still in zone using live snapshot detections
  const vehicleStillInZone = useMemo(() =>
    isVehicleInZone(liveDets, violation.zone_id, cameraZones),
    [liveDets, violation.zone_id, cameraZones]
  );

  const isPending = violation.status === 'pending' || violation.status === 'alerted' || violation.status === 'acknowledged';
  const vehicleDeparted = vehicleStillInZone === false && isPending;

  // Close on Escape key
  useEffect(() => {
    const handler = e => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', handler); document.body.style.overflow = ''; };
  }, [onClose]);

  // ProofImage is hoisted to module scope (above ViolationProofModal) so it
  // isn't redefined every render — that remounted it and flashed the images.

  const initialTime = violation.detected_at ? new Date(violation.detected_at).toLocaleTimeString([], {hour:'numeric', minute:'2-digit'}) : '';

  // Portal: render directly into document.body to escape all ancestor transforms
  return createPortal(
    <div onClick={onClose} style={{
      position:'fixed', inset:0, zIndex:9999,
      background:'rgba(0,0,0,.85)', backdropFilter:'blur(20px)', WebkitBackdropFilter:'blur(20px)',
      display:'flex', alignItems:'flex-start', justifyContent:'center',
      paddingTop:24, overflow:'hidden',
      animation:'fadeIn .15s ease',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width:'calc(100% - 48px)', maxWidth:960,
        cursor:'default',
      }}>
        {/* Close button — top right, iMessage style */}
        <button onClick={onClose} style={{
          position:'fixed', top:'max(16px, env(safe-area-inset-top))', right:16, width:44, height:44, borderRadius:'50%',
          background:'rgba(255,255,255,.12)', border:'none', color:'#fff', fontSize:16,
          cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center',
          zIndex:10000,
        }}>✕</button>

        {/* Photos — front and center */}
        <div style={{display:'flex', gap:16, marginBottom:16}}>
          <ProofImage
            src={violation._detection_snapshot_url || violation._snapshot_url || detectionUrl}
            label="Detection"
            detection={det}
            timestamp={initialTime}
          />
          <ProofImage
            src={liveUrl || latestSnapshotUrl || null}
            label="Current"
            detection={null}
            timestamp={liveTime || 'Live'}
          />
        </div>

        {/* Vehicle departed banner */}
        {(vehicleDeparted || violation.status === 'departed' || violation.departed_at) && (
          <div style={{
            background:'rgba(34,197,94,.15)', border:'1px solid rgba(34,197,94,.3)',
            borderRadius:10, padding:'12px 16px', marginBottom:12,
            display:'flex', alignItems:'center', justifyContent:'space-between', gap:12,
          }}>
            <div style={{display:'flex', alignItems:'center', gap:10}}>
              <span style={{fontSize:18}}>&#x2714;</span>
              <div>
                <div style={{color:'#4ade80', fontSize:14, fontWeight:700}}>Vehicle has left the zone</div>
                <div style={{color:'rgba(255,255,255,.5)', fontSize:12}}>
                  {violation.departed_at
                    ? `Confirmed gone at ${new Date(violation.departed_at).toLocaleTimeString([], {hour:'numeric', minute:'2-digit'})}`
                    : 'Current camera image shows no vehicle in this zone'}
                </div>
              </div>
            </div>
            {onAutoGone && (
              <button onClick={() => onAutoGone(violation.id)} style={{
                background:'#22c55e', color:'#fff', border:'none', borderRadius:8,
                padding:'8px 16px', fontSize:13, fontWeight:700, cursor:'pointer',
                whiteSpace:'nowrap', flexShrink:0,
              }}>Dismiss</button>
            )}
          </div>
        )}

        {/* Info bar — subtle, below photos */}
        <div style={{display:'flex', gap:10, flexWrap:'wrap', alignItems:'center'}}>
          {violation.plate_text && (
            <span style={{background:'rgba(255,255,255,.1)', color:'#fff', borderRadius:6, padding:'5px 12px', fontSize:13, fontWeight:700, fontFamily:'Courier New, monospace', letterSpacing:'.04em'}}>
              {violation.plate_text}
            </span>
          )}
          {violation.vehicle_color && (
            <span style={{color:'rgba(255,255,255,.5)', fontSize:12, display:'flex', alignItems:'center', gap:5}}>
              <span style={{width:8, height:8, borderRadius:'50%', background:colorHex(violation.vehicle_color)}} />
              {violation.vehicle_color} {violation.vehicle_type || 'car'}
            </span>
          )}
          <span style={{color:'rgba(255,255,255,.35)', fontSize:12}}>
            {(violation.violation_type || 'unauthorized').replace(/_/g, ' ')}
          </span>
          {violation.zone_id && (
            <span style={{color:'rgba(255,255,255,.25)', fontSize:11}}>Zone {violation.zone_id}</span>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
