import React, { useState, useEffect, useCallback, useRef, useMemo, memo } from 'react';
import { supabase } from '../lib/supabase.js';

// ── CrossCameraSightings ──
// Renders plate_events from cameras OTHER than the ones that fed the
// no-reg evidence package, within ±2 min of the first-seen time. Same
// time-window correlation we used in the audit cross-tab — surfaces the
// vehicle's path between gates (e.g. exited north gate, parked at south
// lot) so the operator can confirm the truck is the same physical vehicle
// even when OCR drift split the plate across cameras.
export function CrossCameraSightings({ plate, propertyId, when, excludeCameraIds = [], fmtDateTime }) {
  const [rows, setRows] = useState([]);
  const [cameraNames, setCameraNames] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!supabase || !propertyId || !when) { setLoading(false); return; }
    let cancelled = false;
    const t = new Date(when).getTime();
    const lo = new Date(t - 2 * 60 * 1000).toISOString();
    const hi = new Date(t + 2 * 60 * 1000).toISOString();
    setLoading(true);
    (async () => {
      // Pull every plate_event in the window for this property, then drop the
      // cameras already represented in the no-reg evidence array.
      const { data } = await supabase
        .from('plate_events')
        .select('id, created_at, normalized_plate, plate_text, confidence, image_url, camera_id')
        .eq('property_id', propertyId)
        .gte('created_at', lo)
        .lte('created_at', hi)
        .order('created_at', { ascending: true });
      if (cancelled) return;
      const exclude = new Set(excludeCameraIds.filter(Boolean));
      const filtered = (data || []).filter(r => !exclude.has(r.camera_id));
      setRows(filtered);
      // Resolve camera names for label chips.
      const ids = [...new Set(filtered.map(r => r.camera_id).filter(Boolean))];
      if (ids.length) {
        const { data: cams } = await supabase
          .from('alpr_cameras').select('id, name').in('id', ids);
        if (!cancelled) {
          setCameraNames(Object.fromEntries((cams || []).map(c => [c.id, c.name])));
        }
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [propertyId, when, JSON.stringify(excludeCameraIds)]);

  if (loading) return null;
  if (!rows.length) return null;
  return (
    <div onClick={e => e.stopPropagation()} style={{margin:'8px 0 4px',padding:'10px 12px',background:'rgba(0,0,0,.03)',border:'1px solid rgba(0,0,0,.08)',borderRadius:8}}>
      <div style={{fontSize:11,fontWeight:800,letterSpacing:'.05em',textTransform:'uppercase',color:'#7c2d12',marginBottom:6}}>
        Other-camera sightings near {fmtDateTime(when)} ({rows.length})
      </div>
      <div style={{display:'flex',gap:8,overflowX:'auto',WebkitOverflowScrolling:'touch',paddingBottom:4}}>
        {rows.map(r => {
          const delta = Math.round((new Date(r.created_at).getTime() - new Date(when).getTime()) / 1000);
          const sign = delta >= 0 ? '+' : '−';
          return (
            <a key={r.id} href={r.image_url || '#'} target="_blank" rel="noopener noreferrer"
               style={{flex:'0 0 auto',width:120,textDecoration:'none',color:'inherit',borderRadius:6,overflow:'hidden',border:'1px solid rgba(0,0,0,.12)',background:'#000'}}>
              {r.image_url ? (
                <img src={r.image_url} alt={r.normalized_plate} loading="lazy" style={{width:'100%',height:80,objectFit:'cover',display:'block'}} />
              ) : (
                <div style={{width:'100%',height:80,background:'#222'}} />
              )}
              <div style={{padding:'4px 6px',background:'#fff'}}>
                <div style={{fontFamily:"'Courier New',monospace",fontSize:11,fontWeight:800,color:'#7c2d12',letterSpacing:'.04em'}}>{r.normalized_plate || '—'}</div>
                <div style={{fontSize:9,color:'#6b7280',marginTop:1}}>{cameraNames[r.camera_id] || 'camera'} · {sign}{Math.abs(delta)}s</div>
                <div style={{fontSize:9,color:'#6b7280'}}>{fmtDateTime(r.created_at)}</div>
              </div>
            </a>
          );
        })}
      </div>
    </div>
  );
}
