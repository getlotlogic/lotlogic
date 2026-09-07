import React from 'react';
const { useState, useEffect, useCallback, useRef, useMemo, memo } = React;
import { apiFetch } from '../lib/api.js';
import { useToast } from './Toast.jsx';

// Partner-dashboard pass registration (N Style). Posts to the authenticated
// /visitor_passes/partner-register endpoint — auto-approved, attributed to the
// partner. Apartment properties only; the button is gated at the call site.
// Reuses the (previously orphaned) viol-modal bottom-sheet styles.
const REGISTER_INPUT_STYLE = {padding:'10px 12px',background:'var(--bg-inset)',border:'1px solid var(--border)',borderRadius:8,color:'var(--text-primary)',fontSize:14,width:'100%',boxSizing:'border-box'};
const REGISTER_LABEL_STYLE = {display:'block',fontSize:11,color:'var(--text-muted)',fontWeight:700,letterSpacing:'.04em',textTransform:'uppercase',marginBottom:4,marginTop:10};

export function RegisterPassModal({ prop, onClose }) {
  const { addToast } = useToast();
  const [f, setF] = useState({ plate: '', name: '', unit: '', phone: '', email: '', stayHours: '24', paperTag: false, tagExp: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(null);
  // One idempotency key per modal open — a double-tap or retry returns the
  // same pass instead of minting a second one (mirrors the QR form).
  const idemKey = useMemo(() => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(36).slice(2)), []);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setErr('');
    setBusy(true);
    try {
      const res = await apiFetch('/visitor_passes/partner-register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: prop.id,
          plate_text: f.plate.trim(),
          visitor_name: f.name.trim() || null,
          host_unit: f.unit.trim() || null,
          phone: f.phone.trim() || null,
          email: f.email.trim() || null,
          stay_hours: parseInt(f.stayHours, 10),
          is_temp_tag: !!f.paperTag,
          tag_expiration: (f.paperTag && f.tagExp) ? f.tagExp : null,
          submission_idempotency_key: idemKey,
        }),
      });
      setDone(res);
      addToast('Parking pass registered', 'success');
    } catch (ex) {
      setErr(ex && ex.message ? ex.message : 'Registration failed — try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="viol-modal-overlay" onClick={onClose}>
      <div className="viol-modal" onClick={e => e.stopPropagation()}>
        <div className="viol-modal-handle"></div>
        <div className="viol-modal-body">
          <div className="viol-modal-title">Register a parking pass</div>
          <div className="viol-modal-sub">{prop.name}</div>
          {done ? (
            <div>
              <div style={{background:'rgba(74,222,128,.1)',border:'1px solid rgba(74,222,128,.3)',borderRadius:10,padding:14,marginBottom:14}}>
                <div style={{fontSize:15,fontWeight:800,color:'#4ade80'}}>Pass active — {done.plate_text}</div>
                {done.valid_until && (
                  <div style={{fontSize:13,color:'var(--text-secondary)',marginTop:4}}>
                    Valid until {new Date(done.valid_until).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}
                  </div>
                )}
                <div style={{fontSize:12,color:'var(--text-faint)',marginTop:4}}>Reference {done.reference_id}</div>
              </div>
              <button onClick={onClose} style={{background:'var(--accent)',color:'#fff',border:'none',borderRadius:8,padding:'12px',fontSize:14,fontWeight:700,cursor:'pointer',width:'100%'}}>Done</button>
            </div>
          ) : (
            <form onSubmit={submit}>
              <label style={REGISTER_LABEL_STYLE}>License plate</label>
              <input value={f.plate} onChange={e => setF({...f, plate: e.target.value.toUpperCase()})} placeholder="ABC1234" required minLength={2} maxLength={20} autoFocus style={REGISTER_INPUT_STYLE} />
              <label style={REGISTER_LABEL_STYLE}>Name</label>
              <input value={f.name} onChange={e => setF({...f, name: e.target.value})} placeholder="Who is this pass for?" maxLength={120} style={REGISTER_INPUT_STYLE} />
              <label style={REGISTER_LABEL_STYLE}>Unit</label>
              <input value={f.unit} onChange={e => setF({...f, unit: e.target.value})} placeholder="Unit / apartment number" maxLength={60} style={REGISTER_INPUT_STYLE} />
              <label style={REGISTER_LABEL_STYLE}>Phone (optional)</label>
              <input type="tel" value={f.phone} onChange={e => setF({...f, phone: e.target.value})} placeholder="(704) 555-0100" style={REGISTER_INPUT_STYLE} />
              <label style={REGISTER_LABEL_STYLE}>Email (optional)</label>
              <input type="email" value={f.email} onChange={e => setF({...f, email: e.target.value})} placeholder="name@example.com" style={REGISTER_INPUT_STYLE} />
              <label style={REGISTER_LABEL_STYLE}>How long?</label>
              <select value={f.stayHours} onChange={e => setF({...f, stayHours: e.target.value})} style={REGISTER_INPUT_STYLE}>
                <option value="4">4 hours</option>
                <option value="8">8 hours</option>
                <option value="12">12 hours</option>
                <option value="24">1 day</option>
                <option value="48">2 days</option>
                <option value="72">3 days</option>
              </select>
              <label style={{display:'flex',alignItems:'center',gap:8,marginTop:12,fontSize:13,color:'var(--text-secondary)',cursor:'pointer'}}>
                <input type="checkbox" checked={f.paperTag} onChange={e => setF({...f, paperTag: e.target.checked})} />
                Paper tag
              </label>
              {f.paperTag && (
                <>
                  <label style={REGISTER_LABEL_STYLE}>Tag expiration (optional)</label>
                  <input type="date" value={f.tagExp} onChange={e => setF({...f, tagExp: e.target.value})} style={REGISTER_INPUT_STYLE} />
                  <div style={{fontSize:11,color:'var(--text-faint)',marginTop:4}}>Leave blank and we'll assume 30 days.</div>
                </>
              )}
              {err && <div style={{color:'#ef4444',fontSize:13,fontWeight:600,marginTop:10}}>{err}</div>}
              <button type="submit" disabled={busy} style={{background:'var(--accent)',color:'#fff',border:'none',borderRadius:8,padding:'12px',fontSize:14,fontWeight:700,cursor:'pointer',width:'100%',marginTop:14,opacity:busy?0.7:1}}>
                {busy ? 'Registering…' : 'Register pass'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
