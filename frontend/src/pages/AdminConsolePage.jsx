import React, { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '../lib/api.js';

// ── Platform-admin console (folded in from admin.html) ────────────
// Cross-tenant client overview, one-transaction onboarding, and feedback
// triage. Admin-only: the router gates this on isPlatformAdmin. Every read/
// write goes through the BACKEND (apiFetch) — never the Supabase client,
// whose RLS would scope results down to a single tenant.
const ADMIN_STATUSES = ['open', 'triaged', 'closed'];

function fmtAdminDate(s) {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d)) return s;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// A one-time setup link (password-reset token URL) rendered with a copy button.
function AdminSetupLink({ label, url }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard?.writeText(url).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 1600);
    }).catch(() => {});
  }
  return (
    <div style={{ marginTop: 12, border: '1px dashed var(--border)', borderRadius: 10, padding: '12px 14px', background: 'var(--bg-primary)' }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>{label} · setup link — share once</div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input readOnly value={url} onFocus={e => e.target.select()} style={{ flex: '1 1 auto', minWidth: 0, fontFamily: 'ui-monospace, monospace', fontSize: 12, padding: '9px 11px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-primary)' }} />
        <button type="button" onClick={copy} style={{ flex: '0 0 auto', padding: '0 16px', background: 'var(--accent)', color: '#1a1a1a', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
    </div>
  );
}

function AdminClientsTab() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setError('');
    try {
      const data = await apiFetch('/admin/clients');
      setRows(Array.isArray(data) ? data : (data?.clients || []));
    } catch (err) { if (err.status !== 401) { setError(err.message); setRows([]); } }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (rows === null && !error) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-faint)', fontSize: 13 }}>Loading clients…</div>;
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div className="section-title" style={{ fontSize: 20 }}>Clients{rows && rows.length ? ` · ${rows.length}` : ''}</div>
        <button onClick={load} style={{ background: 'transparent', color: 'var(--text-faint)', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Refresh</button>
      </div>
      {error && <div style={{ background: 'rgba(217,83,79,.12)', border: '1px solid #D9534F', color: '#D9534F', borderRadius: 8, padding: '10px 12px', fontSize: 13, marginBottom: 12 }}>{error}</div>}
      {rows && rows.length ? (
        <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', background: 'var(--bg-card)' }}>
          {rows.map((c, i) => {
            const open = c.open_violation_count ?? 0;
            const active = c.active_pass_count ?? 0;
            return (
              <div key={c.id} className="admin-client-row" style={{ display: 'grid', gridTemplateColumns: '1.6fr .8fr 1fr auto auto', gap: 12, alignItems: 'center', padding: '14px 16px', borderTop: i ? '1px solid var(--border-subtle)' : 'none' }}>
                <div>
                  <div style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: 14 }}>{c.name || '—'}</div>
                  {c.address ? <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 2 }}>{c.address}</div> : null}
                </div>
                <div><span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--text-faint)' }}>{c.property_type || '—'}</span></div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', wordBreak: 'break-word' }}>
                  <div>{c.owner_email || '—'}</div>
                  {c.partner_email ? <div style={{ color: 'var(--text-faint)', marginTop: 2 }}>{c.partner_email}</div> : null}
                </div>
                <div style={{ textAlign: 'right', fontSize: 13, color: active ? 'var(--text-primary)' : 'var(--text-faint)' }} title="Active passes">{active}<span style={{ fontSize: 10, color: 'var(--text-faint)', display: 'block' }}>passes</span></div>
                <div style={{ textAlign: 'right', fontSize: 13, fontWeight: open ? 700 : 400, color: open ? '#D9534F' : 'var(--text-faint)' }} title="Open violations">{open}<span style={{ fontSize: 10, color: 'var(--text-faint)', display: 'block' }}>open</span></div>
              </div>
            );
          })}
        </div>
      ) : (!error && <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-faint)', fontSize: 13, border: '1px solid var(--border)', borderRadius: 12 }}>Nothing on the books yet. Onboard a property to see it here.</div>)}
    </div>
  );
}

function AdminOnboardTab() {
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [propertyType, setPropertyType] = useState('apartment');
  const [ownerOn, setOwnerOn] = useState(true);
  const [ownerName, setOwnerName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [partnerOn, setPartnerOn] = useState(false);
  const [partnerName, setPartnerName] = useState('');
  const [partnerEmail, setPartnerEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  const inputStyle = { width: '100%', padding: '11px 13px', background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-primary)', fontSize: 14, marginBottom: 12 };
  const labelStyle = { display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 };

  async function submit(e) {
    e.preventDefault();
    if (!name.trim() || !address.trim()) { setError('Property name and address are required.'); return; }
    setBusy(true); setError(''); setResult(null);
    const payload = {
      property: { name: name.trim(), address: address.trim(), property_type: propertyType },
      owner: ownerOn ? { name: ownerName.trim(), email: ownerEmail.trim() } : null,
      partner: partnerOn ? { name: partnerName.trim(), email: partnerEmail.trim() } : null,
      existing_partner_id: null,
    };
    try {
      const res = await apiFetch('/admin/clients', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      setResult(res);
      setName(''); setAddress(''); setOwnerName(''); setOwnerEmail(''); setPartnerName(''); setPartnerEmail(''); setPartnerOn(false);
    } catch (err) { if (err.status !== 401) setError(err.message); } finally { setBusy(false); }
  }

  return (
    <div>
      <div className="section-title" style={{ fontSize: 20, marginBottom: 14 }}>Onboard a property</div>
      {result && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 16, marginBottom: 16, background: 'var(--bg-card)' }}>
          <div style={{ color: '#3FA45B', fontWeight: 700, fontSize: 14 }}>✓ Property created.</div>
          {(result.owner?.setup_link || result.partner?.setup_link) ? (
            <>
              <p style={{ fontSize: 12, color: 'var(--text-faint)', margin: '10px 0 2px', lineHeight: 1.5 }}>Hand each setup link to the account holder. It sets their password and works once — treat it like a secret.</p>
              {result.owner?.setup_link && <AdminSetupLink label="Owner" url={result.owner.setup_link} />}
              {result.partner?.setup_link && <AdminSetupLink label="Partner" url={result.partner.setup_link} />}
            </>
          ) : <p style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 10 }}>No new accounts created (no setup links to share).</p>}
        </div>
      )}
      <form onSubmit={submit} style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 20, background: 'var(--bg-card)' }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 12 }}>1 · Property</div>
        <label style={labelStyle}>Property name</label>
        <input style={inputStyle} value={name} onChange={e => setName(e.target.value)} placeholder="Maple Court Apartments" />
        <label style={labelStyle}>Address</label>
        <input style={inputStyle} value={address} onChange={e => setAddress(e.target.value)} placeholder="123 Main St, Charlotte NC" />
        <label style={labelStyle}>Property type</label>
        <select style={inputStyle} value={propertyType} onChange={e => setPropertyType(e.target.value)}>
          <option value="apartment">apartment</option>
          <option value="truck_plaza">truck_plaza</option>
        </select>

        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.08em', margin: '18px 0 12px', paddingTop: 16, borderTop: '1px solid var(--border-subtle)' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', textTransform: 'none', letterSpacing: 0, fontSize: 14, color: 'var(--text-primary)' }}>
            <input type="checkbox" checked={ownerOn} onChange={e => setOwnerOn(e.target.checked)} /> 2 · Create an owner account
          </label>
        </div>
        {ownerOn && (
          <div className="admin-form-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div><label style={labelStyle}>Owner name</label><input style={inputStyle} value={ownerName} onChange={e => setOwnerName(e.target.value)} /></div>
            <div><label style={labelStyle}>Owner email</label><input style={inputStyle} type="email" value={ownerEmail} onChange={e => setOwnerEmail(e.target.value)} /></div>
          </div>
        )}

        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.08em', margin: '6px 0 12px', paddingTop: 16, borderTop: '1px solid var(--border-subtle)' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', textTransform: 'none', letterSpacing: 0, fontSize: 14, color: 'var(--text-primary)' }}>
            <input type="checkbox" checked={partnerOn} onChange={e => setPartnerOn(e.target.checked)} /> 3 · Create a partner (tow company) account
          </label>
        </div>
        {partnerOn && (
          <>
            <div className="admin-form-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div><label style={labelStyle}>Partner name</label><input style={inputStyle} value={partnerName} onChange={e => setPartnerName(e.target.value)} /></div>
              <div><label style={labelStyle}>Partner email</label><input style={inputStyle} type="email" value={partnerEmail} onChange={e => setPartnerEmail(e.target.value)} /></div>
            </div>
            <p style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 4 }}>For apartments, the partner is also set as the tow company.</p>
          </>
        )}

        <button type="submit" disabled={busy} style={{ width: '100%', marginTop: 18, padding: '13px', background: 'var(--accent)', color: '#1a1a1a', border: 'none', borderRadius: 999, fontWeight: 700, fontSize: 15, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1 }}>
          {busy ? 'Creating…' : 'Create property'}
        </button>
        {error && <div style={{ background: 'rgba(217,83,79,.12)', border: '1px solid #D9534F', color: '#D9534F', borderRadius: 8, padding: '10px 12px', fontSize: 13, marginTop: 12 }}>{error}</div>}
      </form>
    </div>
  );
}

function AdminFeedbackRow({ item }) {
  const [status, setStatus] = useState(item.status || 'open');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function change(next) {
    const prev = status;
    setStatus(next); setSaving(true); setError('');
    try {
      await apiFetch(`/admin/feedback/${item.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: next }) });
    } catch (err) { setStatus(prev); if (err.status !== 401) setError(err.message); } finally { setSaving(false); }
  }
  const kind = (item.kind || '').toLowerCase();
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, padding: '16px', borderTop: '1px solid var(--border-subtle)' }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: 14 }}>{item.property_name || '—'}</span>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', padding: '2px 8px', borderRadius: 6, background: kind === 'bug' ? 'rgba(217,83,79,.14)' : 'rgba(63,164,91,.14)', color: kind === 'bug' ? '#D9534F' : '#3FA45B' }}>{item.kind || '—'}</span>
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 8, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{item.body || ''}</div>
        <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 8 }}>{item.account_type || ''}{item.submitted_by ? ' · ' + item.submitted_by : ''}{' · ' + fmtAdminDate(item.created_at)}</div>
        {error && <div style={{ fontSize: 11, color: '#D9534F', marginTop: 6 }}>{error}</div>}
      </div>
      <select value={status} disabled={saving} onChange={e => change(e.target.value)} style={{ alignSelf: 'start', padding: '8px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-primary)', fontSize: 13 }}>
        {ADMIN_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
      </select>
    </div>
  );
}

function AdminFeedbackTab() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setError('');
    try {
      const data = await apiFetch('/admin/feedback');
      setRows(Array.isArray(data) ? data : (data?.feedback || []));
    } catch (err) { if (err.status !== 401) { setError(err.message); setRows([]); } }
  }, []);
  useEffect(() => { load(); }, [load]);
  if (rows === null && !error) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-faint)', fontSize: 13 }}>Loading feedback…</div>;
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div className="section-title" style={{ fontSize: 20 }}>Feedback{rows && rows.length ? ` · ${rows.length}` : ''}</div>
        <button onClick={load} style={{ background: 'transparent', color: 'var(--text-faint)', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Refresh</button>
      </div>
      {error && <div style={{ background: 'rgba(217,83,79,.12)', border: '1px solid #D9534F', color: '#D9534F', borderRadius: 8, padding: '10px 12px', fontSize: 13, marginBottom: 12 }}>{error}</div>}
      {rows && rows.length ? (
        <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', background: 'var(--bg-card)' }}>
          {rows.map(item => <AdminFeedbackRow key={item.id} item={item} />)}
        </div>
      ) : (!error && <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-faint)', fontSize: 13, border: '1px solid var(--border)', borderRadius: 12 }}>No notes from the field yet.</div>)}
    </div>
  );
}

export function AdminConsolePage({ user }) {
  const [sub, setSub] = useState('clients');
  const tabBtn = (id, label) => (
    <button onClick={() => setSub(id)} style={{ background: sub === id ? 'var(--bg-card)' : 'transparent', color: sub === id ? 'var(--text-primary)' : 'var(--text-faint)', border: '1px solid ' + (sub === id ? 'var(--border)' : 'transparent'), borderRadius: 8, padding: '8px 14px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>{label}</button>
  );
  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 18, flexWrap: 'wrap' }}>
        {tabBtn('clients', 'Clients')}
        {tabBtn('onboard', 'Onboard')}
        {tabBtn('feedback', 'Feedback')}
      </div>
      {sub === 'clients' && <AdminClientsTab />}
      {sub === 'onboard' && <AdminOnboardTab />}
      {sub === 'feedback' && <AdminFeedbackTab />}
    </div>
  );
}

export default AdminConsolePage;
