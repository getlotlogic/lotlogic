import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase.js';
import { db } from '../lib/db.js';
import { scopePropsToPartner } from '../shared/scope.js';
import { ErrorBoundary } from '../ui/ErrorBoundary.jsx';
import { useToast } from '../ui/Toast.jsx';
import { SkeletonCards } from '../ui/Skeletons.jsx';
import { RegisterPassModal } from '../ui/RegisterPassModal.jsx';
import { AddPropertyForm } from '../ui/AddPropertyForm.jsx';
import { RejectedPropertyNotice } from '../ui/RejectedPropertyNotice.jsx';
import { RegisteredDrill } from './RegisteredDrill.jsx';
import { lazyPage } from '../lib/lazyPage.js';
import { listRequests } from '../lib/requestsApi.js';

// Heavy — lazy-loaded so opening the Lots list doesn't pull in the full
// property-detail bundle (which itself pulls in TruckParkingLog).
const ALPRPropertyDetailPage = lazyPage(() => import('./ALPRPropertyDetailPage.jsx'));

// `initialSelectedId` / `initialSection` / `request` / `upload` / `firstrun` /
// `verify` are the deep link App.jsx read out of `/app?…` — the portal's email
// and Slack buttons land here (spec §3.4 step 5). `initialSelectedId` opens
// that property straight away instead of the list; the rest travel on to the
// property page, which owns the surfaces they name.
export function ALPRPropertiesPage({
  user,
  impersonating = false,
  initialSelectedId = null,
  initialSection = null,
  request = null,
  upload = false,
  firstrun = false,
  verify = false,
  // App.jsx's VerifyEmailSheet opener (Task 23) — threaded through to the
  // detail page's RequestsSection, whose composer calls it when a hold on a
  // pending property needs the 6-digit code first. Without it the default
  // no-op leaves the composer's "Confirm your email" line with nothing to open.
  onNeedVerify,
}) {
  const { addToast } = useToast();
  // Property deletion cascades to plates, cameras and passes. Partners enforce
  // lots, they don't own them — and an admin impersonating a partner arrives
  // here with _role === 'partner' too, so this single check covers both.
  const canDelete = user?._role === 'owner';
  const [properties, setProperties] = useState([]);
  const [loading, setLoading] = useState(true);
  // Door (a) — "Add a property" opens AddPropertyForm as a modal, with no
  // `slug` prop (no `/join/<slug>` context here) so it posts
  // `partner_id: null` rather than a client-supplied partner id — see
  // AddPropertyForm.jsx's header comment. The old inline "Create Lot" form
  // (PostgREST insert, both property types) is gone for owners (spec
  // §3.4a — self-serve is apartment-only now; a new truck plaza still goes
  // through POST /admin/clients, unchanged).
  const [showAddProperty, setShowAddProperty] = useState(false);
  // "Not ours" (spec §3.8) — Task 14c's owner shape lists an archived,
  // rejected property here (excluded from `properties` outright) so the
  // Lots page can explain an empty list instead of showing "No lots yet".
  const [rejectedProperties, setRejectedProperties] = useState([]);
  const [selectedId, setSelectedId] = useState(initialSelectedId);
  // KPI counts per property_id — { [propId]: { openJobs, noReg, overstays, registered } }
  const [kpiCounts, setKpiCounts] = useState({});
  // Drill-down state: { propId, drill: 'noreg' | 'registered' }
  const [drillState, setDrillState] = useState(null); // { propId, drill }
  // Partner "Register a parking pass" modal — the property being registered at.
  const [registerProp, setRegisterProp] = useState(null);
  // ON HOLD / TOW counts for portal-only cards (spec §5.4/§5.6,
  // `features.passes=false`) — { [propId]: { hold, tow } }. Only fetched for
  // those properties; a normal card never shows this row.
  const [requestCounts, setRequestCounts] = useState({});

  function refetchProperties() {
    if (!user) return;
    return db.getProperties(user.id, user._role).then(p => setProperties(scopePropsToPartner(p, user)));
  }

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    refetchProperties().catch(() => {}).finally(() => setLoading(false));
    if (user._role === 'owner') {
      db.getRejectedProperties(user.id).then(setRejectedProperties).catch(() => setRejectedProperties([]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // Fetch all 4 KPI counts for every visible property (best-effort, non-blocking).
  // Re-fetched every 60s — the counts drift while the tab sits open (passes expire
  // into the 3h window, cooldowns lapse) and nothing else invalidates them.
  useEffect(() => {
    if (!properties.length) return;
    const load = () => Promise.all(
      properties.map(async p => {
        // Per-property KPI counts. The no-reg count slot was wired to
        // /no-reg-violations (now retired). Hardcode to [] until the KPI
        // tile is either removed or rewired to query vehicle-event bundles.
        const [noRegRows, openRows, overstayRows, registeredRows, cooldownRow] = await Promise.all([
          Promise.resolve([]),
          supabase
            ? supabase.from('alpr_violations')
                .select('id', { count: 'exact', head: true })
                .eq('property_id', p.id)
                .in('status', ['pending', 'dispatched'])
                .then(r => ({ count: r.count || 0 }))
                .catch(() => ({ count: 0 }))
            : Promise.resolve({ count: 0 }),
          supabase
            ? supabase.from('alpr_violations')
                .select('id', { count: 'exact', head: true })
                .eq('property_id', p.id)
                .ilike('violation_type', '%overstay%')
                .in('status', ['pending', 'dispatched'])
                .then(r => ({ count: r.count || 0 }))
                .catch(() => ({ count: 0 }))
            : Promise.resolve({ count: 0 }),
          // Single source of truth — same query the drill + parking log use,
          // so the count can never disagree with the lists.
          db.getActiveRoster(p.id)
            .catch(() => []),
          // Truck-plaza only: plates currently on a 24h cooldown — a pass whose
          // END (camera exit if seen, else the time-limit expiry) was within the
          // last 24h. Registration-based, no camera dependence. Powers the "On
          // Cooldown (Tow if seen)" tile.
          (p.property_type === 'truck_plaza' && supabase)
            ? supabase.rpc('count_on_cooldown', { p_property_id: p.id })
                .then(r => ({ count: r.data ?? 0 }))
                .catch(() => ({ count: 0 }))
            : Promise.resolve({ count: 0 }),
        ]);
        // Expiring soon = active passes within 3h of their limit. Derived from
        // the roster we just fetched (no extra query); mirrors the EXPIRING
        // window the parking log uses.
        const roster = Array.isArray(registeredRows) ? registeredRows : [];
        const EXPIRING_MS = 3 * 60 * 60 * 1000;
        const expiringSoon = roster.filter(r => {
          const ms = r.valid_until ? new Date(r.valid_until).getTime() - Date.now() : null;
          return ms !== null && ms > 0 && ms < EXPIRING_MS;
        }).length;
        return [p.id, {
          noReg: Array.isArray(noRegRows) ? noRegRows.length : 0,
          openJobs: openRows.count,
          overstays: overstayRows.count,
          registered: roster.length,
          onCooldown: cooldownRow.count,
          expiringSoon,
        }];
      })
    ).then(pairs => {
      const counts = {};
      pairs.forEach(([id, kpi]) => { counts[id] = kpi; });
      setKpiCounts(counts);
    });
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [properties]);

  // ON HOLD / TOW counts for portal-only cards only — `features.passes=false`
  // (spec §5.6). Every other card's status pill comes from the ALPR KPI
  // effect above; this is the one request this list makes for a property
  // that has no cameras, no passes, nothing else to poll.
  useEffect(() => {
    const portalOnly = properties.filter(p => p?.features?.passes === false);
    if (!portalOnly.length) return;
    const load = () => Promise.all(
      portalOnly.map(p =>
        listRequests({ property_id: p.id, view: 'active' })
          .then(r => {
            const items = Array.isArray(r?.items) ? r.items : [];
            return [p.id, {
              hold: items.filter(i => i.kind === 'hold').length,
              tow: items.filter(i => i.kind === 'tow').length,
            }];
          })
          .catch(() => [p.id, { hold: 0, tow: 0 }])
      )
    ).then(pairs => {
      setRequestCounts(prev => {
        const next = { ...prev };
        pairs.forEach(([id, counts]) => { next[id] = counts; });
        return next;
      });
    });
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [properties]);

  function handlePropertyAdded(property) {
    setShowAddProperty(false);
    addToast('Property added', 'success');
    refetchProperties();
    if (property?.id) setSelectedId(property.id);
  }

  function handleJoinedPending() {
    setShowAddProperty(false);
    addToast('Request sent', 'success');
    refetchProperties();
  }

  if (selectedId) return <ErrorBoundary label="this property"><React.Suspense fallback={<SkeletonCards />}><ALPRPropertyDetailPage
    propertyId={selectedId}
    onBack={() => setSelectedId(null)}
    user={user}
    // This list's own `/auth/me` row for the open property — the detail
    // page's `db.getProperty` read is a raw table row with no computed
    // `features` key, so this is the only way it learns which upsell chips
    // (spec §5.6) are locked.
    features={properties.find(p => p.id === selectedId)?.features}
    // Only the property the deep link named gets the deep link's props; once
    // the operator navigates to a different property they are back to normal.
    initialSection={selectedId === initialSelectedId ? initialSection : null}
    request={selectedId === initialSelectedId ? request : null}
    upload={selectedId === initialSelectedId ? upload : false}
    firstrun={selectedId === initialSelectedId ? firstrun : false}
    verify={selectedId === initialSelectedId ? verify : false}
    onNeedVerify={onNeedVerify}
  /></React.Suspense></ErrorBoundary>;

  if (loading) return <div className="page-enter"><div style={{textAlign:'center',padding:40,color:'var(--text-muted)'}}>Loading properties...</div></div>;

  // If a drill-down is open, render it on top
  if (drillState) {
    const prop = properties.find(p => p.id === drillState.propId);
    // 'noreg' drill-down removed — evidence packages live on the property
    // detail page now (vehicle-event bundling).
    if (drillState.drill === 'registered') {
      return (
        <ErrorBoundary label="registered drill-down">
          <RegisteredDrill propertyId={drillState.propId} propertyName={prop?.name || ''} onBack={() => setDrillState(null)} />
        </ErrorBoundary>
      );
    }
  }

  return (
    <div className="page-enter">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
        <div style={{fontSize:16,fontWeight:800,color:'var(--text-primary)'}}>Lots</div>
        {user?._role !== 'partner' && (
          <button onClick={() => setShowAddProperty(true)} style={{background:'rgba(74,222,128,.12)',color:'var(--text-primary)',border:'1px solid rgba(74,222,128,.3)',borderRadius:8,padding:'6px 14px',fontSize:12,fontWeight:700,cursor:'pointer'}}>+ Add a property</button>
        )}
      </div>

      {showAddProperty && (
        <div className="viol-modal-overlay" onClick={() => setShowAddProperty(false)}>
          <div className="viol-modal" onClick={e => e.stopPropagation()}>
            <div className="viol-modal-handle"></div>
            <div className="viol-modal-body">
              <div className="viol-modal-title">Add a property</div>
              <AddPropertyForm
                onCancel={() => setShowAddProperty(false)}
                onSuccess={handlePropertyAdded}
                onJoined={handleJoinedPending}
              />
            </div>
          </div>
        </div>
      )}

      {properties.length === 0 ? (
        rejectedProperties.length > 0 ? (
          <RejectedPropertyNotice rejectedProperties={rejectedProperties} onAddProperty={() => setShowAddProperty(true)} />
        ) : (
          <div style={{textAlign:'center',padding:40,color:'var(--text-muted)'}}>
            <div style={{fontSize:14}}>No lots yet</div>
            <div style={{fontSize:12,marginTop:4}}>Add a property to start managing parking passes</div>
          </div>
        )
      ) : (
        <div>
          {[...properties].sort((a, b) => {
            const ka = kpiCounts[a.id] || {}, kb = kpiCounts[b.id] || {};
            const score = (k) => (k.registered || 0) + (k.openJobs || 0) + (k.overstays || 0) + (k.noReg || 0);
            return score(kb) - score(ka);
          }).map(p => {
            // Portal-only (spec §5.4/§5.6): a property with no pass flow
            // switched on gets the stripped card — name, address, the
            // verification pill, ON HOLD/TOW counts from the portal's own
            // requests, and a single View property button. No Registered
            // KPI (there's nothing registered to count) and no "Register a
            // parking pass" action (today's partner card shows both — they
            // are hidden here for both roles).
            if (p?.features?.passes === false) {
              const counts = requestCounts[p.id] || { hold: 0, tow: 0 };
              const verified = p.verification_status === 'verified';
              return (
                <article key={p.id} className="lot-card-paper">
                  <div className="lot-head-paper">
                    <div style={{minWidth:0,flex:1}}>
                      <div className="lot-name-paper">{p.name}</div>
                      <div className="lot-addr-paper">{p.address || 'No address'}</div>
                    </div>
                    <div style={{display:'flex',flexDirection:'column',alignItems:'flex-end',gap:6}}>
                      <span className={`lot-pill-paper ${verified ? 'green' : 'amber'}`}>
                        <span className="dot"></span>{verified ? 'Confirmed' : 'Waiting for N Style'}
                      </span>
                      {canDelete && (
                      <button
                        aria-label={`Delete property ${p.name}`}
                        onClick={async (e) => { e.stopPropagation(); if (!confirm('Delete "' + p.name + '"? This removes all its plates, cameras, and passes.')) return; try { await db.deleteProperty(p.id); setProperties(prev => prev.filter(x => x.id !== p.id)); } catch (err) { addToast('Failed to delete. ' + (err.message || ''), 'error'); } }}
                        style={{background:'rgba(239,68,68,.1)',color:'#ef4444',border:'1px solid rgba(239,68,68,.3)',borderRadius:6,padding:'6px 10px',marginTop:2,fontSize:11,fontWeight:700,cursor:'pointer'}}
                      >Delete</button>
                      )}
                    </div>
                  </div>
                  <div style={{fontSize:12,fontWeight:700,color:'var(--text-muted)',letterSpacing:'.02em',padding:'10px 0'}}>
                    ON HOLD · {counts.hold} · TOW · {counts.tow}
                  </div>
                  <div className="lot-foot-paper">
                    <button onClick={() => setSelectedId(p.id)}>View property <span className="arr">›</span></button>
                  </div>
                </article>
              );
            }
            const kpi = kpiCounts[p.id] || {};
            const openJobs = kpi.openJobs || 0;
            const noReg = kpi.noReg || 0;
            const overstays = kpi.overstays || 0;
            const registered = kpi.registered || 0;
            const onCooldown = kpi.onCooldown || 0;
            const expiringSoon = kpi.expiringSoon || 0;
            const isTruckPlaza = p.property_type === 'truck_plaza';
            // Lot-level status pill. Truck plazas key off the on-cooldown count
            // (camera-driven jobs are hidden); apartments keep the jobs pill.
            const pillCls = isTruckPlaza
              ? (onCooldown > 0 ? 'red' : 'green')
              : (noReg > 0 ? 'red' : openJobs > 0 ? 'amber' : 'green');
            const pillLabel = isTruckPlaza
              ? (onCooldown > 0 ? `${onCooldown} on cooldown` : 'All clear')
              : (noReg > 0 ? 'Needs attention' : openJobs > 0 ? `${openJobs} open job${openJobs !== 1 ? 's' : ''}` : 'All clear');
            return (
              <article key={p.id} className="lot-card-paper">
                <div className="lot-head-paper">
                  <div style={{minWidth:0,flex:1}}>
                    <div className="lot-name-paper">{p.name}</div>
                    <div className="lot-addr-paper">{p.address || 'No address'}</div>
                  </div>
                  <div style={{display:'flex',flexDirection:'column',alignItems:'flex-end',gap:6}}>
                    <span className={`lot-pill-paper ${pillCls}`}>
                      <span className="dot"></span>{pillLabel}
                    </span>
                    {/* Owners only. This cascades to every plate, camera and
                        pass on the property, so a tow partner (or an admin in
                        "View as Partner") must never be shown the control —
                        previously it rendered for everyone and relied purely
                        on RLS to reject the write. Tap target raised off 10px:
                        it sits directly under the status pill on a mobile-first
                        card, and a mis-tap there was unrecoverable. */}
                    {canDelete && (
                    <button
                      aria-label={`Archive property ${p.name}`}
                      // Soft delete (spec §8.2/§8.3: POST /apartment/properties/{id}/archive,
                      // archived_at=now()) — plates/cameras/passes/history are kept, not wiped;
                      // the property just stops appearing on every list and verdict. No
                      // verbatim confirmation copy exists in the spec for this dialog.
                      onClick={async (e) => { e.stopPropagation(); if (!confirm('Archive "' + p.name + '"? It stops accepting new requests and leaves your Lots list. Its plates, cameras, passes and history stay on the record.')) return; try { await db.deleteProperty(p.id); setProperties(prev => prev.filter(x => x.id !== p.id)); } catch (err) { addToast('Failed to archive. ' + (err.message || ''), 'error'); } }}
                      style={{background:'rgba(239,68,68,.1)',color:'#ef4444',border:'1px solid rgba(239,68,68,.3)',borderRadius:6,padding:'6px 10px',marginTop:2,fontSize:11,fontWeight:700,cursor:'pointer'}}
                    >Archive</button>
                    )}
                  </div>
                </div>

                <div className={'kpis-paper' + (p.property_type === 'truck_plaza' ? '' : ' single')}>
                  {isTruckPlaza ? (
                    /* Truck plaza: camera-driven Open Jobs/Overstays are hidden.
                       The three pass-states that matter — On Cooldown (pass
                       ended, camera exit OR time limit, within 24h → tow if
                       seen), Active (currently parked), Expiring soon (<3h
                       left). The no-registration evidence package stays inside
                       the property, not on the card. */
                    <>
                      <button
                        className={`kpi-paper ${onCooldown > 0 ? 'red' : 'calm'}`}
                        onClick={() => setSelectedId(p.id)}
                        aria-label={`On cooldown, tow if seen, for ${p.name}`}
                      >
                        <div className="top-row"><div className="val">{onCooldown}</div><div className="chev">›</div></div>
                        <div className="label">On Cooldown (Tow if seen)</div>
                      </button>
                      <button
                        className="kpi-paper green"
                        onClick={() => setDrillState({ propId: p.id, drill: 'registered' })}
                        aria-label={`Active parking passes for ${p.name}`}
                      >
                        <div className="top-row"><div className="val">{registered}</div><div className="chev">›</div></div>
                        <div className="label">Active</div>
                      </button>
                      <button
                        className={`kpi-paper ${expiringSoon > 0 ? 'amber' : 'calm'}`}
                        onClick={() => setSelectedId(p.id)}
                        aria-label={`Expiring soon for ${p.name}`}
                      >
                        <div className="top-row"><div className="val">{expiringSoon}</div><div className="chev">›</div></div>
                        <div className="label">Expiring soon</div>
                      </button>
                    </>
                  ) : (
                    <>
                      {/* Apartments only need "Registered" — Open Jobs / Overstays
                          are enforcement/truck-plaza concepts and are omitted. */}
                      <button
                        className="kpi-paper green"
                        onClick={() => setDrillState({ propId: p.id, drill: 'registered' })}
                        aria-label={`Registered parking passes for ${p.name}`}
                      >
                        <div className="top-row"><div className="val">{registered}</div><div className="chev">›</div></div>
                        <div className="label">Registered</div>
                      </button>
                    </>
                  )}
                </div>

                <div className="lot-foot-paper">
                  {/* Partner staff register passes over the phone/counter.
                      Apartment cards only — truck-plaza registration is a
                      different flow (policy ack, cooldown, 48h cap). Hidden in
                      View-as-Partner: the admin's owner token would 404 on the
                      partner-scoped endpoint. */}
                  {user?._role === 'partner' && !impersonating && p.property_type === 'apartment' && (
                    <button onClick={() => setRegisterProp(p)}>Register a parking pass</button>
                  )}
                  <button onClick={() => setSelectedId(p.id)}>View property <span className="arr">›</span></button>
                </div>
              </article>
            );
          })}
        </div>
      )}
      {registerProp && <RegisterPassModal prop={registerProp} onClose={() => setRegisterProp(null)} />}
    </div>
  );
}
