import React, { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase.js';
import { db } from '../lib/db.js';
import { apiFetch } from '../lib/api.js';

// ── TowActivityPage ─────────────────────────────
// Operator-facing repository of every tow-truck sighting at the property's
// gate cameras. Pulls all NMLD plates dynamically from
// enforcement_partners.tow_truck_plates plus Lev≤2 OCR variants so OCR drift
// (VK7434 from VX7434, PK7434, AA96116 from AA9611E, etc.) shows up.
//
// Visits are grouped by 20-minute clusters: N consecutive reads of the same
// truck collapse to one visit row with all camera frames as a thumbnail
// strip. Auto-refresh every 60s.
//
// Each visit also carries the state of its VIDEO evidence, read from the
// backend's /ops/tow-sightings. The camera keeps footage for a limited
// number of days and the archiver copies the window around a sighting into
// permanent storage; the chip on each visit says which of those two worlds
// the video is in, and — while it is still only on the camera — the date it
// runs out. That date is the one thing that turns into a lost tow if nobody
// looks at it in time.

// The lot is in Charlotte. Footage-expiry dates are decisions the operator
// makes standing in the lot, so they read in lot-local time regardless of
// where the browser is.
const LOT_TZ = 'America/New_York';

// Uppercase, alphanumerics only. plate_events.normalized_plate is already
// stored this way; the backend's truck_plate is not guaranteed to be, so both
// sides of the group match go through this.
const normPlate = (s) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const CHIP = {
  fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 3,
  whiteSpace: 'nowrap', letterSpacing: '.04em',
};
const CHIP_TONE = {
  ok:      { background: 'rgba(34,197,94,.15)',  color: '#22c55e' },
  pending: { background: 'rgba(255,255,255,.06)', color: 'var(--text-muted)' },
  gone:    { background: 'rgba(248,113,113,.15)', color: '#f87171' },
};

// Clip length, for the "is this the whole visit or a fragment" question.
function clipLength(seconds) {
  const s = Number(seconds || 0);
  if (!s) return null;
  return s < 60 ? `${Math.round(s)}s` : `${Math.round(s / 60)} min`;
}

// Which of the three states one clip is in. `clip` is a clip-shaped object —
// either the legacy `group.clip` (the visit's own camera) or one entry from
// the new per-camera `group.clips` array — and `footageExpiresAt` is the
// group-level expiry (the backend doesn't give a per-camera one; every
// camera at the property shares the same footage-retention window).
function clipStateFor(clip, footageExpiresAt) {
  if (clip && (clip.status === 'archived' || clip.status === 'partial')) {
    const len = clipLength(clip.duration_s);
    return {
      kind: 'saved',
      label: len ? `Clip archived · ${len}` : 'Clip archived',
      tone: CHIP_TONE.ok,
      title: clip.status === 'partial'
        ? 'Only part of the window made it into storage — watch it before relying on it'
        : 'The video around this sighting is in permanent storage',
    };
  }
  const expiresAt = footageExpiresAt ? new Date(footageExpiresAt) : null;
  const expired = (clip && clip.status === 'expired_unarchived')
    || (expiresAt && expiresAt.getTime() < Date.now());
  if (expired) {
    return {
      kind: 'gone',
      label: 'Footage expired',
      tone: CHIP_TONE.gone,
      title: 'The camera has overwritten this window and no clip was archived',
    };
  }
  const attempts = clip && clip.attempts;
  return {
    kind: 'pending',
    label: 'Clip pending',
    tone: CHIP_TONE.pending,
    title: clip && clip.status === 'failed'
      ? `Archiving failed${attempts ? ` after ${attempts} attempt${attempts === 1 ? '' : 's'}` : ''}${clip.error ? ` — ${clip.error}` : ''}`
      : 'Not archived yet — the video is still on the camera',
    // The one line that says when to act.
    until: expiresAt
      ? expiresAt.toLocaleDateString('en-US', { timeZone: LOT_TZ, month: 'short', day: 'numeric', year: 'numeric' })
      : null,
  };
}

// Legacy single-camera shape. `group` is the backend anchor row for the
// visit, or null when the backend knows nothing about it (older sightings,
// or the archiver has not run yet).
function clipState(group) {
  return clipStateFor(group && group.clip, group && group.footage_expires_at);
}

export function TowActivityPage({ user }) {
  const [events, setEvents] = useState([]);
  const [plates, setPlates] = useState([]);
  const [cameras, setCameras] = useState({});
  const [loading, setLoading] = useState(true);
  const [hours, setHours] = useState(72);
  const [lightbox, setLightbox] = useState(null);
  // Backend anchor rows keyed nowhere — matched to visits by plate + time
  // below. Empty array means "the page renders exactly as it did before the
  // evidence column existed", which is also what a 403 leaves behind.
  const [groups, setGroups] = useState([]);
  // Did the evidence read actually succeed? Distinguishes "the pipeline has
  // no record of this visit" (chip: no evidence record) from "this viewer is
  // not allowed to see evidence at all" (no chip, ever). Without it those two
  // look identical, and an operator can't tell a sighting the archiver never
  // saw from one they're simply not cleared for.
  const [evidenceOk, setEvidenceOk] = useState(false);
  const [clipBusyId, setClipBusyId] = useState(null);
  const [clipError, setClipError] = useState(null);
  // Refreshing every 60s, so the "you can't see this" debug line would
  // otherwise repeat forever in the console of every owner who isn't a
  // platform admin. Once is the whole signal.
  const evidenceWarnedRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  // Escape closes the evidence viewer — it was mouse-dismiss only, which made
  // it a keyboard trap for anyone reviewing evidence without a pointer.
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e) => { if (e.key === 'Escape') setLightbox(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox]);

  // Video-evidence metadata. Separate from the Supabase read below on
  // purpose: /ops/* is platform-admin only, so an owner who is not one gets a
  // 403 and this stays empty — the page then looks exactly as it always has,
  // with no chip, no button and no error. That is the 2026-05-31 ruling
  // (the tow crew must never see their own truck sightings) enforced at the
  // endpoint rather than by a client-side flag, and a failure here must never
  // degrade the sighting list itself.
  //
  // Refreshed on the same 60s tick as the reads below (see `refresh`). The
  // page's own header promises auto-refresh, and the state this carries is
  // exactly the one that changes while somebody watches: a visit archives a
  // few minutes after the truck leaves, and a chip stuck on "Clip pending"
  // until you navigate away and back contradicts the page in front of you.
  const loadEvidence = useCallback(async () => {
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    try {
      const body = await apiFetch(
        `/ops/tow-sightings?since=${encodeURIComponent(since)}&limit=1000`
      );
      if (!mountedRef.current) return;
      setGroups((body?.sightings || []).filter(s => s.is_group_anchor));
      setEvidenceOk(true);
    } catch (err) {
      if (!mountedRef.current) return;
      if (!evidenceWarnedRef.current) {
        evidenceWarnedRef.current = true;
        console.debug('tow-sightings evidence unavailable', err?.status || err?.message);
      }
      setGroups([]);
      setEvidenceOk(false);
    }
  }, []);

  // One visit can now carry several clips (one per camera at the property),
  // each with its own busy/error state — a click on camera A's button must
  // not spin or fail camera B's. `clipKey` is the one place that turns
  // (anchorId, camera) into the id used for both `clipBusyId` and
  // `clipError.id`, so the setter and every comparison agree on the same
  // string. No camera (the legacy single-clip case) keys off the anchor
  // alone, unchanged from before this array existed.
  const clipKey = (anchorId, camera) => (camera ? `${anchorId}:${camera}` : String(anchorId));

  const watchClip = useCallback(async (anchorId, camera) => {
    const key = clipKey(anchorId, camera);
    setClipBusyId(key);
    setClipError(null);
    try {
      // 15-minute presigned URL — opened and dropped, never held in state.
      const qs = camera ? `?camera=${encodeURIComponent(camera)}` : '';
      const { url } = await apiFetch(`/ops/tow-sightings/${anchorId}/clip${qs}`);
      if (!mountedRef.current) return;
      // window.open returns null when the browser blocks the window. Left
      // unchecked, a blocked pop-up looks exactly like a working click that
      // did nothing — the operator retries forever instead of allowing
      // pop-ups once.
      const opened = url ? window.open(url, '_blank', 'noopener') : null;
      if (!opened) {
        setClipError({
          id: key,
          message: url
            ? 'Your browser blocked the clip window — allow pop-ups for this site.'
            : 'The clip link came back empty.',
        });
      }
    } catch (err) {
      if (!mountedRef.current) return;
      setClipError({ id: key, message: err?.message || 'Could not open the clip.' });
    }
    if (!mountedRef.current) return;
    setClipBusyId(null);
  }, []);

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
  // One refresh cycle for both reads. The evidence read is deliberately not
  // awaited by `load` — it must never be able to delay or break the sighting
  // list, which is the part of this page that works for everyone.
  const refresh = useCallback(() => { load(); loadEvidence(); }, [load, loadEvidence]);
  useEffect(() => { setLoading(true); refresh(); }, [refresh]);
  useEffect(() => {
    const t = setInterval(refresh, 60_000);
    return () => clearInterval(t);
  }, [refresh]);

  // Cluster events into visits: consecutive reads within 20 minutes
  // collapse to one row. Walks the (descending) events list and starts a
  // new visit when the gap exceeds VISIT_GAP_MS.
  //
  // 20, not the 10 this page used to use, because the backend groups
  // sightings at 20 minutes. With two different gaps the page would split a
  // visit the backend kept whole and then hang one clip chip off two rows —
  // two answers to "how many times was the truck here".
  const VISIT_GAP_MS = 20 * 60 * 1000;
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

  // Match a visit to the backend group describing the same truck at the same
  // time: same plate once both sides are normalised, and the group's span
  // overlapping the visit's span widened by one gap on each side. The widening
  // matters because the two sides cluster the same reads from different
  // starting points, so their spans can be offset without disagreeing.
  const groupForVisit = (v) => {
    if (!groups.length) return null;
    const plates = new Set(
      v.frames.map(f => normPlate(f.normalized_plate || f.plate_text)).filter(Boolean)
    );
    if (!plates.size) return null;
    const visitFirst = new Date(v.first_at).getTime();
    const from = visitFirst - VISIT_GAP_MS;
    const to = new Date(v.last_at).getTime() + VISIT_GAP_MS;
    let best = null;
    let bestDist = Infinity;
    for (const g of groups) {
      if (!plates.has(normPlate(g.truck_plate))) continue;
      const gFirst = new Date(g.group_first_seen_at || g.seen_at).getTime();
      const gLast = new Date(g.group_last_seen_at || g.seen_at).getTime();
      if (!(gFirst <= to && gLast >= from)) continue;
      // Nearest start wins when a plate visits twice inside one widened window.
      const dist = Math.abs(gFirst - visitFirst);
      if (dist < bestDist) { bestDist = dist; best = g; }
    }
    return best;
  };

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
          const group = groupForVisit(v);
          // Gabe's requirement: whenever the tow truck shows up, both
          // cameras' viewpoints must be checked so it couldn't have left with
          // a truck unseen. The new backend gives one clip per active camera
          // at the property (`group.clips`) instead of just the sighting's
          // own camera (`group.clip`). An empty array reads the same as
          // absent — there's nothing to render per-camera either way — so
          // both fall back to the legacy single-chip shape below.
          const hasNewClips = !!(group && Array.isArray(group.clips) && group.clips.length);
          // No group and the evidence read worked → the pipeline genuinely has
          // nothing for this visit (it predates the archiver, or the sighting
          // never reached it). Say so. No group because the read was refused →
          // no chip at all, so the evidence column stays invisible to anyone
          // who isn't cleared for it. When the new per-camera shape is
          // present it owns the evidence UI instead of this single chip.
          const clip = (group && !hasNewClips)
            ? clipState(group)
            : (!group && evidenceOk
                ? { kind: 'none', label: 'No evidence record', tone: CHIP_TONE.pending,
                    title: 'The evidence pipeline has no clip record for this visit' }
                : null);
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
                  {clip && (
                    <span title={clip.title} style={{marginLeft:8, ...CHIP, ...clip.tone}}>
                      {clip.label}
                    </span>
                  )}
                  {clip && clip.kind === 'saved' && (
                    <button
                      onClick={() => watchClip(group.id)}
                      disabled={clipBusyId === clipKey(group.id)}
                      style={{
                        marginLeft:8, fontSize:11, fontWeight:700, padding:'3px 9px',
                        borderRadius:6, cursor: clipBusyId === clipKey(group.id) ? 'default' : 'pointer',
                        background:'transparent', color:'var(--text)',
                        border:'1px solid var(--border)',
                        opacity: clipBusyId === clipKey(group.id) ? .5 : 1,
                      }}>
                      {clipBusyId === clipKey(group.id) ? 'Opening…' : 'Watch clip'}
                    </button>
                  )}
                  {clip && clip.kind === 'pending' && clip.until && (
                    <span style={{marginLeft:8,fontSize:11,color:'var(--text-muted)'}}>
                      footage on camera until {clip.until}
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
              {clipError && group && clipError.id === clipKey(group.id) && (
                <div style={{color:'#f87171',fontSize:12,marginBottom:10}}>{clipError.message}</div>
              )}
              {hasNewClips && (
                // One line per camera, in the order the backend returned
                // them — this is the "did he leave with a truck unseen"
                // check: every active camera at the property gets its own
                // status and its own Watch clip button, not just the camera
                // that happened to read the plate.
                <div style={{display:'flex',flexDirection:'column',gap:6,marginBottom:10}}>
                  {group.clips.map((c) => {
                    const camState = clipStateFor(c, group.footage_expires_at);
                    const key = clipKey(group.id, c.camera_api_key);
                    return (
                      <div key={c.camera_api_key} style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
                        <span style={{fontSize:12,color:'var(--text)',minWidth:100,fontWeight:600}}>
                          {c.camera_name || c.camera_api_key}
                        </span>
                        <span title={camState.title} style={{...CHIP, ...camState.tone}}>
                          {camState.label}
                        </span>
                        {camState.kind === 'saved' && (
                          <button
                            onClick={() => watchClip(group.id, c.camera_api_key)}
                            disabled={clipBusyId === key}
                            style={{
                              fontSize:11, fontWeight:700, padding:'3px 9px',
                              borderRadius:6, cursor: clipBusyId === key ? 'default' : 'pointer',
                              background:'transparent', color:'var(--text)',
                              border:'1px solid var(--border)',
                              opacity: clipBusyId === key ? .5 : 1,
                            }}>
                            {clipBusyId === key ? 'Opening…' : 'Watch clip'}
                          </button>
                        )}
                        {camState.kind === 'pending' && camState.until && (
                          <span style={{fontSize:11,color:'var(--text-muted)'}}>
                            footage on camera until {camState.until}
                          </span>
                        )}
                        {clipError && clipError.id === key && (
                          <span style={{color:'#f87171',fontSize:12}}>{clipError.message}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
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

export default TowActivityPage;
