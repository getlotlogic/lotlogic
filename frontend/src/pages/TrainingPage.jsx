import React, { useState, useEffect, useCallback } from 'react';
import { fmtDateTime } from '../lib/format.js';
import { supabase } from '../lib/supabase.js';
import { useToast } from '../ui/Toast.jsx';
import { EventPhoto, usePhotoUrl } from '../ui/eventPhoto.jsx';

export function TrainingPage({ user, isOwner }) {
  // Operator review of cross-camera plate pairs with image evidence and
  // verify / dismiss actions. The cron-plate-pair-learn edge function
  // populates inferred_plate_pairs every 60s; this surface lets the
  // operator visually confirm a pair (raising confidence to 1.0 via
  // verified_at), dismiss false positives, or restore mistakes.
  //
  // RLS owner-only: partners (Frank) never see this surface.
  const { addToast } = useToast();
  const [pairs, setPairs] = useState([]);
  const [properties, setProperties] = useState({});
  const [cameras, setCameras] = useState({});
  // best plate_event per (normalized_plate, camera_id) — image source for cards
  const [evidence, setEvidence] = useState({});
  const [filter, setFilter] = useState('unverified'); // unverified | verified | dismissed | all
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(null);
  const [lightbox, setLightbox] = useState(null); // { eventId, url, plate, camera, ts }
  // Escape closes the evidence viewer (was mouse-dismiss only — keyboard trap).
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e) => { if (e.key === 'Escape') setLightbox(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox]);

  const load = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    try {
      let q = supabase
        .from('inferred_plate_pairs')
        .select('id, property_id, plate_a, plate_b, plate_a_camera_id, plate_b_camera_id, observations, confidence, first_seen_at, last_seen_at, dismissed_at, dismissed_by, verified_at, verified_by, resolved_pass_id')
        .order('last_seen_at', { ascending: false })
        .limit(500);
      if (filter === 'unverified') q = q.is('dismissed_at', null).is('verified_at', null);
      else if (filter === 'verified') q = q.is('dismissed_at', null).not('verified_at', 'is', null);
      else if (filter === 'dismissed') q = q.not('dismissed_at', 'is', null);
      const { data, error } = await q;
      if (error) throw error;
      setPairs(data || []);

      // Lookup property names + camera names + best-image-per-(plate, camera)
      const propIds = [...new Set((data || []).map(p => p.property_id))];
      const camIds = [...new Set((data || []).flatMap(p => [p.plate_a_camera_id, p.plate_b_camera_id]).filter(Boolean))];
      const plates = [...new Set((data || []).flatMap(p => [p.plate_a, p.plate_b]).filter(Boolean))];

      const [propRes, camRes, evRes] = await Promise.all([
        propIds.length ? supabase.from('properties').select('id, name').in('id', propIds) : Promise.resolve({ data: [] }),
        camIds.length ? supabase.from('alpr_cameras').select('id, name').in('id', camIds) : Promise.resolve({ data: [] }),
        plates.length ? supabase.from('plate_events')
          // `id`, not `image_url`: the photograph is minted per render by
          // EventPhoto/usePhotoUrl. `image_url` stays as a FILTER — "this read
          // has a photograph" is still the thing being selected for.
          .select('id, normalized_plate, camera_id, confidence, created_at')
          .in('normalized_plate', plates)
          .not('image_url', 'is', null)
          .gte('created_at', new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString())
          .order('confidence', { ascending: false })
          .limit(3000)
          : Promise.resolve({ data: [] }),
      ]);

      setProperties(Object.fromEntries((propRes.data || []).map(p => [p.id, p.name])));
      setCameras(Object.fromEntries((camRes.data || []).map(c => [c.id, c.name || c.id.slice(0, 6)])));
      // Pick the highest-confidence image per (plate, camera) — already pre-sorted desc by conf
      const best = {};
      for (const e of (evRes.data || [])) {
        const key = `${e.normalized_plate}|${e.camera_id}`;
        if (!best[key]) best[key] = e;
      }
      setEvidence(best);
    } catch (err) {
      console.warn('TrainingPage.load failed', err.message);
      addToast('Load failed: ' + err.message, 'error');
    }
    setLoading(false);
  }, [filter]);
  useEffect(() => { load(); }, [load]);

  // Auto-refresh every 60s to match cron-plate-pair-learn cadence. New
  // pairs land in the table within ~1 minute of a truck transiting both
  // cameras; this surface should show them without the operator having
  // to reload.
  useEffect(() => {
    const t = setInterval(() => { load(); }, 60_000);
    return () => clearInterval(t);
  }, [load]);

  async function setPairState(id, patch, toastMsg) {
    if (!supabase) return;
    setActing(id);
    try {
      const { error } = await supabase.from('inferred_plate_pairs').update(patch).eq('id', id);
      if (error) throw error;
      addToast(toastMsg, 'success');
      await load();
    } catch (err) {
      addToast('Failed: ' + err.message, 'error');
    }
    setActing(null);
  }
  const op = user?.email || 'operator';
  const verify = (id) => setPairState(id, { verified_at: new Date().toISOString(), verified_by: op, dismissed_at: null, dismissed_by: null }, 'Verified — same truck');
  const dismiss = (id) => setPairState(id, { dismissed_at: new Date().toISOString(), dismissed_by: op, verified_at: null, verified_by: null }, 'Dismissed — not the same truck');
  const reset = (id) => setPairState(id, { verified_at: null, verified_by: null, dismissed_at: null, dismissed_by: null }, 'Reset to unverified');

  function PairSide({ pair, side }) {
    const plate = side === 'a' ? pair.plate_a : pair.plate_b;
    const camId = side === 'a' ? pair.plate_a_camera_id : pair.plate_b_camera_id;
    const ev = evidence[`${plate}|${camId}`];
    const camName = cameras[camId] || (camId ? camId.slice(0, 6) : '—');
    // Every row in `evidence` was selected with `image_url IS NOT NULL`, so an
    // event id here means a photograph exists — known synchronously, which is
    // what the keyboard handlers and the zoom cursor gate on. The URL itself
    // arrives when the presign does, and the lightbox is handed the same
    // already-resolved URL rather than fetching it a second time.
    const url = usePhotoUrl(ev?.id);
    const open = () => url && setLightbox({ url, plate, camera: camName, ts: ev.created_at });
    return (
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Reviewing these photos IS the Training task — they must be
            keyboard-operable, not click-only. Same pattern as EarningsPage. */}
        <div
          role={ev?.id ? 'button' : undefined}
          tabIndex={ev?.id ? 0 : undefined}
          aria-label={ev?.id ? `View evidence photo for plate ${plate} from ${camName}` : undefined}
          onKeyDown={(e) => { if (ev?.id && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(); } }}
          style={{
            aspectRatio: '16/9',
            background: '#0a0a0a',
            borderRadius: 8,
            overflow: 'hidden',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: ev?.id ? 'zoom-in' : 'default',
            border: '1px solid var(--border-subtle)',
          }}
          onClick={open}
        >
          {ev?.id ? (
            <EventPhoto eventId={ev.id} alt={plate} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <span style={{ fontSize: 11, color: '#666' }}>no image</span>
          )}
        </div>
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontFamily: 'ui-monospace, monospace', fontWeight: 800, fontSize: 15, letterSpacing: 0.5 }}>{plate}</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{camName}{ev ? ` · conf ${Number(ev.confidence).toFixed(2)}` : ''}</span>
          {ev?.created_at && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'ui-monospace, monospace' }}>
              {new Date(ev.created_at).toLocaleString('en-US', {
                year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', second: '2-digit',
                hour12: false,
              })}
            </span>
          )}
        </div>
      </div>
    );
  }

  const filterChips = [
    { id: 'unverified', label: 'Needs review' },
    { id: 'verified',   label: 'Verified' },
    { id: 'dismissed',  label: 'Dismissed' },
    { id: 'all',        label: 'All' },
  ];

  return (
    <div style={{ padding: '16px 0', maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 8 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>Cross-camera plate pairs</h2>
        <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          {loading ? 'Loading…' : `${pairs.length} pair${pairs.length === 1 ? '' : 's'}`}
        </span>
      </div>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5, margin: '0 0 16px' }}>
        The system sees the same truck on two cameras within ~10 seconds and pairs the plate strings. Compare the photos — if they're the same truck (front placard + rear plate), tap <strong>Same truck</strong> to verify. If two unrelated trucks happened to pass through back-to-back, tap <strong>Not the same truck</strong>. Verified pairs are trusted for closing out passes when only one plate is registered.
      </p>

      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        {filterChips.map(c => {
          const active = filter === c.id;
          return (
            <button key={c.id} onClick={() => setFilter(c.id)} style={{
              fontSize: 12, fontWeight: 800, padding: '6px 12px', borderRadius: 999,
              border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
              background: active ? 'var(--accent)' : 'var(--bg-card)',
              color: active ? '#fff' : 'var(--text)',
              cursor: 'pointer',
            }}>{c.label}</button>
          );
        })}
      </div>

      {!loading && pairs.length === 0 && (
        <div style={{ padding: '40px 12px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 14, border: '1px dashed var(--border)', borderRadius: 12 }}>
          {filter === 'unverified' ? 'Nothing to review. New pairs land here as trucks transit both gate cameras within ~10s.'
            : filter === 'verified' ? 'No verified pairs yet.'
            : filter === 'dismissed' ? 'No dismissed pairs.'
            : 'No pairs in this view.'}
        </div>
      )}

      {!loading && pairs.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(360px, 100%), 1fr))', gap: 16 }}>
          {pairs.map(pair => {
            const confPct = Math.round(Number(pair.confidence || 0) * 100);
            const confColor = confPct >= 85 ? '#16a34a' : confPct >= 70 ? '#0284c7' : '#9ca3af';
            const isDismissed = !!pair.dismissed_at;
            const isVerified = !!pair.verified_at;
            const badgeColor = isVerified ? '#16a34a' : isDismissed ? '#dc2626' : confColor;
            const badgeText = isVerified ? 'VERIFIED' : isDismissed ? 'DISMISSED' : `${confPct}%`;
            const propName = properties[pair.property_id] || '';
            return (
              <div key={pair.id} style={{
                background: 'var(--bg-card)',
                border: `1px solid ${isVerified ? 'rgba(34,197,94,.35)' : isDismissed ? 'rgba(220,38,38,.25)' : 'var(--border-subtle)'}`,
                borderRadius: 12,
                padding: 14,
                opacity: isDismissed ? 0.65 : 1,
              }}>
                <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
                  <PairSide pair={pair} side="a" />
                  <div style={{ display: 'flex', alignItems: 'center', color: 'var(--text-muted)', fontSize: 18, fontWeight: 700 }}>↔</div>
                  <PairSide pair={pair} side="b" />
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12, gap: 8 }}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <span style={{ display: 'inline-block', padding: '3px 8px', borderRadius: 6, background: badgeColor, color: '#fff', fontWeight: 800, fontSize: 11, letterSpacing: 0.5 }}>{badgeText}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {pair.observations} obs · {fmtDateTime ? fmtDateTime(pair.last_seen_at) : new Date(pair.last_seen_at).toLocaleString()}
                    </span>
                  </div>
                  {propName && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{propName}</span>}
                </div>

                <div style={{ display: 'flex', gap: 8 }}>
                  {(isDismissed || isVerified) ? (
                    <button onClick={() => reset(pair.id)} disabled={acting === pair.id} style={{
                      flex: 1, padding: '10px 12px', borderRadius: 8, fontSize: 12, fontWeight: 700,
                      border: '1px solid var(--border)', background: 'var(--bg-page, var(--bg-card))',
                      cursor: acting === pair.id ? 'wait' : 'pointer', opacity: acting === pair.id ? 0.6 : 1,
                    }}>{acting === pair.id ? '…' : 'Reset'}</button>
                  ) : (
                    <>
                      <button onClick={() => verify(pair.id)} disabled={acting === pair.id} style={{
                        flex: 1, padding: '10px 12px', borderRadius: 8, fontSize: 12, fontWeight: 800,
                        border: '1px solid #16a34a', background: '#16a34a', color: '#fff',
                        cursor: acting === pair.id ? 'wait' : 'pointer', opacity: acting === pair.id ? 0.6 : 1,
                      }}>{acting === pair.id ? '…' : '✓ Same truck'}</button>
                      <button onClick={() => dismiss(pair.id)} disabled={acting === pair.id} style={{
                        flex: 1, padding: '10px 12px', borderRadius: 8, fontSize: 12, fontWeight: 700,
                        border: '1px solid var(--border)', background: 'var(--bg-page, var(--bg-card))',
                        cursor: acting === pair.id ? 'wait' : 'pointer', opacity: acting === pair.id ? 0.6 : 1,
                      }}>{acting === pair.id ? '…' : '✗ Not the same'}</button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {lightbox && (
        <div
          role="dialog" aria-modal="true" aria-label="Evidence photo viewer — press Escape to close"
          onClick={() => setLightbox(null)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,.85)', zIndex: 1000,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, cursor: 'zoom-out',
          }}
        >
          <div style={{ maxWidth: '90vw', maxHeight: '90vh' }} onClick={e => e.stopPropagation()}>
            <img src={lightbox.url} alt={lightbox.plate} style={{ maxWidth: '90vw', maxHeight: '80vh', display: 'block', borderRadius: 8 }} />
            <div style={{ color: '#fff', marginTop: 12, fontSize: 14, textAlign: 'center' }}>
              <span style={{ fontFamily: 'ui-monospace, monospace', fontWeight: 800, fontSize: 18, letterSpacing: 1 }}>{lightbox.plate}</span>
              <span style={{ marginLeft: 12, color: '#aaa', fontFamily: 'ui-monospace, monospace' }}>
                {lightbox.camera} · {new Date(lightbox.ts).toLocaleString('en-US', {
                  year: 'numeric', month: '2-digit', day: '2-digit',
                  hour: '2-digit', minute: '2-digit', second: '2-digit',
                  hour12: false,
                })}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default TrainingPage;
