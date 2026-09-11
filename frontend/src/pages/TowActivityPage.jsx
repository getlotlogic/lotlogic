import React, { useState, useEffect, useCallback, useRef, useMemo, memo } from 'react';
import { supabase } from '../lib/supabase.js';
import { db } from '../lib/db.js';

// ── TowActivityPage ─────────────────────────────
// Operator-facing repository of every tow-truck sighting at the property's
// gate cameras. Pulls all NMLD plates dynamically from
// enforcement_partners.tow_truck_plates plus Lev≤2 OCR variants so OCR drift
// (VK7434 from VX7434, PK7434, AA96116 from AA9611E, etc.) shows up.
//
// Visits are grouped by 10-minute clusters: N consecutive reads of the same
// truck collapse to one visit row with all camera frames as a thumbnail
// strip. Auto-refresh every 60s.
export function TowActivityPage({ user }) {
  const [events, setEvents] = useState([]);
  const [plates, setPlates] = useState([]);
  const [cameras, setCameras] = useState({});
  const [loading, setLoading] = useState(true);
  const [hours, setHours] = useState(72);
  const [lightbox, setLightbox] = useState(null);
  // Escape closes the evidence viewer — it was mouse-dismiss only, which made
  // it a keyboard trap for anyone reviewing evidence without a pointer.
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e) => { if (e.key === 'Escape') setLightbox(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox]);

  const load = useCallback(async () => {
    if (!supabase || !user?.id) return;
    try {
      const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
      // Scope to THIS owner's tow partners only — never read the full
      // enforcement_partners table (which would surface other tow companies' plates).
      const partners = await db.getPartnersForOwner(user.id);
      const allPlates = (partners || []).flatMap(p => p.tow_truck_plates || []).filter(Boolean);
      setPlates(allPlates);

      // Property scoping for the event queries below. For an owner session RLS
      // already scopes plate_events — but a PLATFORM ADMIN's JWT sees every
      // tenant, and the `match_status.eq.partner_truck` fallback had no
      // property filter at all, so an admin opening this tab pulled other
      // tenants' tow sightings. Explicit .in('property_id', …) makes the
      // scope structural instead of an accident of who's logged in.
      const props = await db.getProperties(user.id, user._role);
      const propIds = (props || [])
        .filter(p => !p.owner_id || p.owner_id === user.id)
        .map(p => p.id);
      if (propIds.length === 0) { setEvents([]); setLoading(false); return; }

      // Candidate fetch. This deliberately does NOT try to express the fuzzy
      // match in PostgREST: `normalized_plate.eq.X` is exact, and an earlier
      // comment here claimed the DB-side levenshtein extension was doing the
      // widening. It was not — the client-side variant filter below ran over
      // an already-exact result set and could only ever re-confirm rows the
      // server had matched exactly. OCR-drifted sightings never appeared, and
      // an empty page was indistinguishable from "no truck came".
      //
      // So: pull the window (exact plate hits + anything the ingest pipeline
      // already stamped partner_truck), then widen client-side. When canonical
      // plates are on file we also pull the unfiltered window so the variant
      // filter has something to work on.
      const orClauses = allPlates.map(p => `normalized_plate.eq.${p}`).join(',');
      // Guard the empty case: with no canonical plates registered, `orClauses`
      // is '' and `.or(',match_status.eq.partner_truck')` is a malformed
      // leading-comma PostgREST filter that errors → the page silently goes
      // empty. Fall back to the partner_truck match alone (the signal that
      // matters when no explicit plates are on file).
      const orFilter = orClauses
        ? `${orClauses},match_status.eq.partner_truck`
        : 'match_status.eq.partner_truck';
      const SELECT_COLS = 'id, created_at, normalized_plate, plate_text, confidence, image_url, match_status, camera_id, raw_data, property_id';
      const [exactRes, windowRes] = await Promise.all([
        supabase.from('plate_events').select(SELECT_COLS)
          .in('property_id', propIds)
          .gte('created_at', since).or(orFilter)
          .order('created_at', { ascending: false }).limit(1000),
        // Unfiltered window, only when there are canonical plates to compare
        // against. Bounded by the same 1000-row cap.
        allPlates.length
          ? supabase.from('plate_events').select(SELECT_COLS)
              .in('property_id', propIds)
              .gte('created_at', since)
              .order('created_at', { ascending: false }).limit(1000)
          : Promise.resolve({ data: [] }),
      ]);
      const seen = new Set();
      const pool = [...(exactRes.data || []), ...(windowRes.data || [])].filter(e => {
        if (seen.has(e.id)) return false;
        seen.add(e.id); return true;
      });

      // OCR-variant test. Deliberately TIGHTER than the Lev≤2 the old (dead)
      // code claimed: same length required, and at most ONE edit.
      //
      // Lev≤2 on a 6-7 char alphanumeric plate admits thousands of strings —
      // any two substitutions. This surface exists to establish that a partner
      // truck was physically on site, and it feeds billing. A civilian plate
      // two OCR characters from a tow plate, presented with photo evidence as
      // a "tow truck sighting", is worse than a missed sighting. Same-length
      // Lev≤1 matches the anchored rule used elsewhere in the pipeline
      // (sessions.ts plateSimilar).
      const variantOf = (read) => {
        if (!read) return null;
        for (const canonical of allPlates) {
          if (read === canonical) return null; // exact, not a variant
          if (read.length !== canonical.length) continue;
          let diffs = 0;
          for (let i = 0; i < read.length; i++) {
            if (read[i] !== canonical[i] && ++diffs > 1) break;
          }
          if (diffs === 1) return canonical;
        }
        return null;
      };
      const isExact = (read) => allPlates.includes(read);

      const matched = pool.reduce((acc, e) => {
        const read = e.normalized_plate || '';
        if (e.match_status === 'partner_truck' || isExact(read)) {
          acc.push({ ...e, _variantOf: null });
        } else {
          const canonical = variantOf(read);
          // Flagged, not hidden — the operator decides. See the OCR VARIANT
          // chip on the row.
          if (canonical) acc.push({ ...e, _variantOf: canonical });
        }
        return acc;
      }, []);
      setEvents(matched);

      const camIds = [...new Set(matched.map(e => e.camera_id).filter(Boolean))];
      if (camIds.length) {
        const { data: cams } = await supabase.from('alpr_cameras').select('id, name').in('id', camIds);
        setCameras(Object.fromEntries((cams || []).map(c => [c.id, c.name || c.id.slice(0, 6)])));
      }
    } catch (err) {
      console.warn('TowActivityPage.load failed', err.message);
    }
    setLoading(false);
  }, [hours, user?.id, user?._role]);
  useEffect(() => { setLoading(true); load(); }, [load]);
  useEffect(() => {
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  // Cluster events into visits: consecutive reads within 10 minutes
  // collapse to one row. Walks the (descending) events list and starts a
  // new visit when the gap exceeds VISIT_GAP_MS.
  const VISIT_GAP_MS = 10 * 60 * 1000;
  const visits = (() => {
    const out = [];
    let cur = null;
    const asc = [...events].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    for (const ev of asc) {
      const ts = new Date(ev.created_at).getTime();
      if (!cur || ts - new Date(cur.last_at).getTime() > VISIT_GAP_MS) {
        cur = { first_at: ev.created_at, last_at: ev.created_at, frames: [ev] };
        out.push(cur);
      } else {
        cur.last_at = ev.created_at;
        cur.frames.push(ev);
      }
    }
    return out.reverse(); // newest first
  })();

  return (
    <div className="page-enter" style={{padding: '16px 12px 80px', maxWidth: 1100, margin: '0 auto'}}>
      <div style={{display:'flex',alignItems:'baseline',justifyContent:'space-between',gap:12,marginBottom:8,flexWrap:'wrap'}}>
        <div>
          <h2 style={{margin:0,fontSize:22,fontWeight:800}}>Tow truck activity</h2>
          <div style={{fontSize:12,color:'var(--text-muted)',marginTop:4}}>
            Every time the tow partner's truck passed a gate camera. Tracking{' '}
            <code style={{padding:'1px 6px',background:'rgba(255,255,255,.06)',borderRadius:4}}>
              {plates.join(' · ') || '—'}
            </code>{' '}
            plus close OCR variants. Auto-refresh every 60s.
          </div>
        </div>
        <select value={hours} onChange={e => setHours(Number(e.target.value))} style={{background:'var(--bg-surface, var(--bg-card))',color:'var(--text)',border:'1px solid var(--border)',borderRadius:6,padding:'6px 10px',fontSize:13}}>
          <option value={6}>Last 6h</option>
          <option value={24}>Last 24h</option>
          <option value={72}>Last 3 days</option>
          <option value={168}>Last 7 days</option>
          <option value={720}>Last 30 days</option>
        </select>
      </div>
      <div style={{fontSize:12,color:'var(--text-muted)',marginBottom:16}}>
        {loading ? 'Loading…' : `${visits.length} visit${visits.length === 1 ? '' : 's'} · ${events.length} read${events.length === 1 ? '' : 's'} in the last ${hours}h`}
      </div>
      {!loading && visits.length === 0 && (
        <div style={{textAlign:'center',color:'var(--text-muted)',padding:'40px 20px',border:'1px dashed var(--border)',borderRadius:10}}>
          No tow truck sightings in this window.
        </div>
      )}
      <div style={{display:'flex',flexDirection:'column',gap:12}}>
        {visits.map((v, idx) => {
          const exact = plates.find(p => v.frames.some(f => f.normalized_plate === p));
          const camsInVisit = [...new Set(v.frames.map(f => cameras[f.camera_id] || (f.camera_id || '?').slice(0, 6)))];
          const spanSec = Math.round((new Date(v.last_at) - new Date(v.first_at)) / 1000);
          return (
            <div key={idx} style={{
              background: 'var(--bg-card)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 12,
              padding: 14,
            }}>
              <div style={{display:'flex',justifyContent:'space-between',gap:12,alignItems:'baseline',marginBottom:10,flexWrap:'wrap'}}>
                <div>
                  <span style={{fontFamily:'ui-monospace, monospace', fontWeight:800, fontSize:16, letterSpacing:.5}}>
                    {exact || v.frames[0].normalized_plate || '—'}
                  </span>
                  {!exact && (
                    // Name the plate this is a suspected OCR variant of. A bare
                    // "FUZZY" told the operator the read was inexact but not
                    // what it was matched against — and this evidence feeds
                    // billing, so "close to WHAT" is the operative question.
                    <span
                      title="One character different from a registered tow-truck plate — not an exact match"
                      style={{marginLeft:8,fontSize:10,padding:'2px 6px',background:'rgba(168,85,247,.15)',color:'#a855f7',borderRadius:3,fontWeight:700}}
                    >
                      {v.frames.find(f => f._variantOf)?._variantOf
                        ? `OCR VARIANT OF ${v.frames.find(f => f._variantOf)._variantOf}`
                        : 'FUZZY'}
                    </span>
                  )}
                </div>
                <div style={{fontSize:12,color:'var(--text-muted)', fontFamily:'ui-monospace,monospace'}}>
                  {new Date(v.first_at).toLocaleString('en-US', {
                    year:'numeric', month:'2-digit', day:'2-digit',
                    hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false,
                  })}
                  {spanSec >= 5 && <span style={{marginLeft:8,color:'var(--text-muted)'}}>· {spanSec}s span</span>}
                  <span style={{marginLeft:8,color:'var(--text-muted)'}}>· {camsInVisit.join(', ')}</span>
                  <span style={{marginLeft:8,color:'var(--text-muted)'}}>· {v.frames.length} read{v.frames.length===1?'':'s'}</span>
                </div>
              </div>
              <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(160px,1fr))', gap:8}}>
                {v.frames.map(f => {
                  const conf = Number(f.confidence ?? 0);
                  return (
                    <div key={f.id}
                      onClick={() => f.image_url && setLightbox({ url: f.image_url, plate: f.normalized_plate, camera: cameras[f.camera_id] || f.camera_id, ts: f.created_at, conf })}
                      style={{
                        background:'#0a0a0a', borderRadius:8, overflow:'hidden',
                        aspectRatio:'16/9', cursor: f.image_url ? 'zoom-in' : 'default',
                        border: f.match_status === 'partner_truck' ? '1px solid rgba(34,197,94,.45)' : '1px solid var(--border-subtle)',
                        position:'relative',
                      }}>
                      {f.image_url ? (
                        <img src={f.image_url} alt={f.normalized_plate} loading="lazy" style={{width:'100%',height:'100%',objectFit:'cover'}} />
                      ) : (
                        <div style={{display:'flex',alignItems:'center',justifyContent:'center',width:'100%',height:'100%',color:'#666',fontSize:11}}>no image</div>
                      )}
                      <div style={{position:'absolute',bottom:0,left:0,right:0,padding:'4px 6px',background:'linear-gradient(transparent, rgba(0,0,0,.85))',color:'#fff',fontSize:10,fontFamily:'ui-monospace,monospace',display:'flex',justifyContent:'space-between'}}>
                        <span style={{fontWeight:700}}>{f.normalized_plate || '—'}</span>
                        <span style={{opacity:.85}}>{conf.toFixed(2)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      {lightbox && (
        <div role="dialog" aria-modal="true" aria-label="Evidence photo viewer — press Escape to close" onClick={() => setLightbox(null)} style={{position:'fixed',inset:0,background:'rgba(0,0,0,.85)',zIndex:1000,display:'flex',alignItems:'center',justifyContent:'center',padding:20,cursor:'zoom-out'}}>
          <div style={{maxWidth:'90vw',maxHeight:'90vh'}} onClick={e => e.stopPropagation()}>
            <img src={lightbox.url} alt={lightbox.plate} style={{maxWidth:'90vw',maxHeight:'80vh',display:'block',borderRadius:8}} />
            <div style={{color:'#fff',marginTop:12,fontSize:14,textAlign:'center'}}>
              <span style={{fontFamily:'ui-monospace,monospace',fontWeight:800,fontSize:18,letterSpacing:1}}>{lightbox.plate}</span>
              <span style={{marginLeft:12,color:'#aaa',fontFamily:'ui-monospace,monospace'}}>
                {lightbox.camera} · {new Date(lightbox.ts).toLocaleString('en-US',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})} · conf {lightbox.conf?.toFixed(2)}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
