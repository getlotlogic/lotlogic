import React from 'react';
const { useState, useEffect, useCallback, useRef, useMemo, memo } = React;
import { supabase } from '../lib/supabase.js';
import { db } from '../lib/db.js';
import { DEFAULT_TRUCK_PLAZA_POLICY } from '../shared/policy.js';
import { scopePropsToPartner } from '../shared/scope.js';
import { ErrorBoundary } from '../ui/ErrorBoundary.jsx';
import { useToast } from '../ui/Toast.jsx';
import { RegisterPassModal } from '../ui/RegisterPassModal.jsx';
import { ALPRPropertyDetailPage } from './ALPRPropertyDetailPage.jsx';
import { RegisteredDrill } from './RegisteredDrill.jsx';

export function ALPRPropertiesPage({ user, impersonating = false }) {
  const { addToast } = useToast();
  // Property deletion cascades to plates, cameras and passes. Partners enforce
  // lots, they don't own them — and an admin impersonating a partner arrives
  // here with _role === 'partner' too, so this single check covers both.
  const canDelete = user?._role === 'owner';
  const [properties, setProperties] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [newProp, setNewProp] = useState({ name: '', address: '', property_type: 'apartment' });
  const [saving, setSaving] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  // KPI counts per property_id — { [propId]: { openJobs, noReg, overstays, registered } }
  const [kpiCounts, setKpiCounts] = useState({});
  // Drill-down state: { propId, drill: 'noreg' | 'registered' }
  const [drillState, setDrillState] = useState(null); // { propId, drill }
  // Partner "Register a parking pass" modal — the property being registered at.
  const [registerProp, setRegisterProp] = useState(null);

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    db.getProperties(user.id, user._role).then(p => { setProperties(scopePropsToPartner(p, user)); setLoading(false); }).catch(() => setLoading(false));
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

  async function handleAdd(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const propData = { ...newProp };
      if (user._role === 'partner') propData.tow_company_id = user.id;
      else propData.owner_id = user.id;
      if (propData.property_type === 'truck_plaza' && !propData.policy_text) {
        propData.policy_text = DEFAULT_TRUCK_PLAZA_POLICY;
      }
      await db.createProperty(propData);
      setNewProp({ name: '', address: '', property_type: 'apartment' });
      setShowAdd(false);
      const p = await db.getProperties(user.id, user._role);
      setProperties(scopePropsToPartner(p, user));
    } catch (err) { addToast('Failed to create property. ' + (err.message || ''), 'error'); }
    setSaving(false);
  }

  if (selectedId) return <ErrorBoundary label="this property"><ALPRPropertyDetailPage propertyId={selectedId} onBack={() => setSelectedId(null)} user={user} /></ErrorBoundary>;

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
          <button onClick={() => setShowAdd(!showAdd)} style={{background:'rgba(74,222,128,.12)',color:'#4ade80',border:'1px solid rgba(74,222,128,.3)',borderRadius:8,padding:'6px 14px',fontSize:12,fontWeight:700,cursor:'pointer'}}>{showAdd ? 'Cancel' : '+ Add Lot'}</button>
        )}
      </div>

      {showAdd && (
        <form onSubmit={handleAdd} style={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:10,padding:14,marginBottom:12,display:'flex',flexDirection:'column',gap:8}}>
          <input value={newProp.name} onChange={e => setNewProp({...newProp, name: e.target.value})} placeholder="Lot name" required style={{padding:'10px 12px',background:'var(--bg-inset)',border:'1px solid var(--border)',borderRadius:8,color:'var(--text-primary)',fontSize:14}} />
          <input value={newProp.address} onChange={e => setNewProp({...newProp, address: e.target.value})} placeholder="Address" style={{padding:'10px 12px',background:'var(--bg-inset)',border:'1px solid var(--border)',borderRadius:8,color:'var(--text-primary)',fontSize:14}} />
          <label style={{display:'block',fontSize:11,color:'var(--text-muted)',fontWeight:700,letterSpacing:'.04em',textTransform:'uppercase',marginTop:2}}>Property Type</label>
          <select value={newProp.property_type} onChange={e => setNewProp({...newProp, property_type: e.target.value})} style={{padding:'10px 12px',background:'var(--bg-inset)',border:'1px solid var(--border)',borderRadius:8,color:'var(--text-primary)',fontSize:14}}>
            <option value="apartment">Apartment</option>
            <option value="truck_plaza">Truck Plaza</option>
          </select>
          {newProp.property_type === 'truck_plaza' && (
            <>
              <label style={{display:'block',fontSize:11,color:'var(--text-muted)',fontWeight:700,letterSpacing:'.04em',textTransform:'uppercase',marginTop:2}}>Parking Policy Text</label>
              <textarea
                value={newProp.policy_text ?? DEFAULT_TRUCK_PLAZA_POLICY}
                onChange={e => setNewProp({...newProp, policy_text: e.target.value})}
                rows={8}
                style={{padding:'10px 12px',background:'var(--bg-inset)',border:'1px solid var(--border)',borderRadius:8,color:'var(--text-primary)',fontSize:12,fontFamily:'monospace',resize:'vertical'}}
              />
              <button type="button" onClick={() => setNewProp({...newProp, policy_text: DEFAULT_TRUCK_PLAZA_POLICY})} className="pd-share-btn" style={{alignSelf:'flex-start'}}>Reset to default</button>
              <label style={{display:'block',fontSize:11,color:'var(--text-muted)',fontWeight:700,letterSpacing:'.04em',textTransform:'uppercase',marginTop:2}}>Towing Contact Phone</label>
              <input type="tel" value={newProp.policy_phone || ''} onChange={e => setNewProp({...newProp, policy_phone: e.target.value})} placeholder="+12692176208" style={{padding:'10px 12px',background:'var(--bg-inset)',border:'1px solid var(--border)',borderRadius:8,color:'var(--text-primary)',fontSize:14}} />
            </>
          )}
          <button type="submit" disabled={saving} style={{background:'var(--accent)',color:'#fff',border:'none',borderRadius:8,padding:'10px',fontSize:14,fontWeight:700,cursor:'pointer'}}>{saving ? 'Creating...' : 'Create Lot'}</button>
        </form>
      )}

      {properties.length === 0 ? (
        <div style={{textAlign:'center',padding:40,color:'var(--text-muted)'}}>
          <div style={{fontSize:14}}>No lots yet</div>
          <div style={{fontSize:12,marginTop:4}}>Add a lot to start managing parking passes</div>
        </div>
      ) : (
        <div>
          {[...properties].sort((a, b) => {
            const ka = kpiCounts[a.id] || {}, kb = kpiCounts[b.id] || {};
            const score = (k) => (k.registered || 0) + (k.openJobs || 0) + (k.overstays || 0) + (k.noReg || 0);
            return score(kb) - score(ka);
          }).map(p => {
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
                      aria-label={`Delete property ${p.name}`}
                      onClick={async (e) => { e.stopPropagation(); if (!confirm('Delete "' + p.name + '"? This removes all its plates, cameras, and passes.')) return; try { await db.deleteProperty(p.id); setProperties(prev => prev.filter(x => x.id !== p.id)); } catch (err) { addToast('Failed to delete. ' + (err.message || ''), 'error'); } }}
                      style={{background:'rgba(239,68,68,.1)',color:'#ef4444',border:'1px solid rgba(239,68,68,.3)',borderRadius:6,padding:'6px 10px',marginTop:2,fontSize:11,fontWeight:700,cursor:'pointer'}}
                    >Delete</button>
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
