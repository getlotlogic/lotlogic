import React from 'react';
import { db } from '../lib/db.js';
import { apiFetch } from '../lib/api.js';
import { useIntervalFetch } from '../hooks.js';
import { ErrorBoundary } from '../ui/ErrorBoundary.jsx';
import { SkeletonCards } from '../ui/Skeletons.jsx';
import { lazyPage } from '../lib/lazyPage.js';

// Heavy — lazy-loaded so opening Billing doesn't pull in either sub-tab's
// bundle before the operator picks it. Own lazy() calls from App.jsx's
// (TowActivityPage is also a top-level tab there); esbuild code-splitting
// resolves both dynamic import() call sites to the same chunk.
const TowActivityPage = lazyPage(() => import('./TowActivityPage.jsx'));
const ConfirmationReviewView = lazyPage(() => import('./ConfirmationReview.jsx'));

// ── Billing page (owner only) — partners + QuickBooks invoice lifecycle ────
// The earnings tab is the canonical job/revenue log; this page hosts two
// sub-tabs:
//   • Invoices            → QB lifecycle (drafts, emails, send to QB)
//   • Confirmation review → per-violation billing_status queues + operator
//                           overrides (force-bill / no-tow / pause / resume).
export function InvoicesPage({ lots, partners: partnersProp, user, isOwner = true, isPlatformAdmin = false }) {
  // Partners don't get the QuickBooks invoice-sending surface (that's an
  // owner-only server flow). They land straight on the Confirmation
  // Review sub-tab, which already scopes server-side via tow_company_id.
  const [subTab, setSubTab] = React.useState(isOwner ? 'invoices' : 'review');

  const tabBtn = (id, label) => React.createElement('button', {
    key: id,
    onClick: () => setSubTab(id),
    style: {
      background: 'transparent', border: 'none', padding: '10px 4px',
      fontSize: 14, fontWeight: 700, cursor: 'pointer',
      color: subTab === id ? 'var(--text-primary)' : 'var(--text-muted)',
      borderBottom: subTab === id ? '2px solid var(--accent)' : '2px solid transparent',
      marginBottom: -1,
    },
  }, label);

  let body;
  if (subTab === 'tow-activity' && isPlatformAdmin) {
    body = React.createElement(ErrorBoundary, { label: 'tow activity' },
      React.createElement(React.Suspense, { fallback: React.createElement(SkeletonCards) },
        React.createElement(TowActivityPage, { user })));
  } else if (isOwner && subTab === 'invoices') {
    body = React.createElement(BillingQuickBooksView, { partnersProp, lots });
  } else {
    body = React.createElement(ErrorBoundary, { label: 'confirmation review' },
      React.createElement(React.Suspense, { fallback: React.createElement(SkeletonCards) },
        React.createElement(ConfirmationReviewView, { user, lots, partnersProp })));
  }

  return React.createElement('div', { className: 'page-enter' },
    // Hide the sub-tab nav entirely for partners — they only see
    // confirmation review, no QB surface to switch to.
    isOwner && React.createElement('div', {
      style: {
        display: 'flex', gap: 18, flexWrap: 'wrap', borderBottom: '1px solid var(--border)',
        marginBottom: 16,
      }
    },
      tabBtn('invoices', 'Invoices'),
      tabBtn('review', 'Confirmation review'),
      isPlatformAdmin && tabBtn('tow-activity', 'Tow Activity'),
    ),
    body,
  );
}

function BillingQuickBooksView({ partnersProp, lots }) {
  const [partners, setPartners] = React.useState(partnersProp || null);
  const [invoices, setInvoices] = React.useState(null);
  const [qbStatus, setQbStatus] = React.useState(null);
  const [err, setErr] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const refresh = React.useCallback(async () => {
    setBusy(true); setErr('');
    try {
      const parts = await db.getPartnersForLots(lots || []);
      setPartners(parts);
      const [inv, status] = await Promise.all([
        apiFetch('/quickbooks/pending-invoices'),
        apiFetch('/quickbooks/status').catch(() => ({ connected: false })),
      ]);
      setInvoices(inv);
      setQbStatus(status);
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [lots]);

  useIntervalFetch(refresh, 0, [refresh]);

  async function act(path, body) {
    try {
      await apiFetch(path, {
        method: 'POST',
        headers: body ? { 'content-type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      await refresh();
    } catch (e) { alert(e.message); }
  }

  async function syncPartner(pid, btn) {
    btn.disabled = true;
    btn.textContent = 'Creating…';
    try {
      await apiFetch(`/quickbooks/partners/${pid}/sync-customer`, { method: 'POST' });
      await refresh();
    } catch (e) {
      alert(e.message);
      btn.disabled = false;
      btn.textContent = 'Create in QuickBooks';
    }
  }

  const statusColor = {
    pending_review:     { bg: 'rgba(251,191,36,.15)',  fg: '#f59e0b' },
    emailed_for_review: { bg: 'rgba(59,130,246,.15)',  fg: '#3b82f6' },
    sent:               { bg: 'rgba(16,185,129,.15)',  fg: '#10b981' },
    voided:             { bg: 'rgba(107,114,128,.2)',  fg: '#6b7280' },
  };

  const actionsFor = {
    pending_review: [
      { label: 'Email me for review', name: 'email-for-review', primary: true },
      { label: 'Discard',              name: 'discard' },
    ],
    emailed_for_review: [
      { label: 'Send to partner', name: 'send', primary: true, confirm: 'Send this invoice to the partner via QuickBooks?' },
      { label: 'Void draft',      name: 'void-draft' },
    ],
    sent: [
      { label: 'Void & credit', name: 'void-and-credit', confirm: 'Create a credit memo? This reverses a sent invoice.' },
    ],
    voided: [],
  };

  return React.createElement('div', { className: 'page-section' },
    React.createElement('h2', { style: { fontSize: 18, fontWeight: 700, marginBottom: 4, color: 'var(--text-primary)' } }, 'Billing & QuickBooks'),
    React.createElement('p', { style: { fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 } },
      'Weekly invoices to enforcement partners — review, email a preview, then send via QuickBooks.'),

    err && React.createElement('div', {
      style: { background: 'rgba(239,68,68,.1)', border: '1px solid rgba(239,68,68,.3)', color: '#ef4444', padding: 10, borderRadius: 8, fontSize: 13, marginBottom: 12 }
    }, err),

    // QB connection card
    React.createElement('div', { style: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: 14, marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 } },
      React.createElement('div', null,
        React.createElement('div', { style: { fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 } },
          'QuickBooks connection',
          qbStatus && qbStatus.connected && React.createElement('span', {
            style: { fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: 'rgba(16,185,129,.15)', color: '#10b981', textTransform: 'uppercase', letterSpacing: '.04em' }
          }, 'Connected'),
        ),
        React.createElement('div', { style: { fontSize: 12, color: 'var(--text-muted)' } },
          qbStatus && qbStatus.connected
            ? 'Linked to QB realm #' + qbStatus.realm_id + (qbStatus.connected_at ? ' · since ' + qbStatus.connected_at.slice(0, 10) : '')
            : 'Authorize LotLogic to create invoices in your QuickBooks Online account.'),
      ),
      React.createElement('button', {
        onClick: async (e) => {
          const b = e.currentTarget;
          b.disabled = true;
          const orig = b.textContent;
          b.textContent = 'Opening…';
          try {
            const { url } = await apiFetch('/quickbooks/oauth/start');
            window.location.href = url;
          } catch (err) {
            alert(err.message);
            b.disabled = false;
            b.textContent = orig;
          }
        },
        style: {
          fontSize: 13, padding: '8px 14px', borderRadius: 8,
          border: qbStatus && qbStatus.connected ? '1px solid var(--border)' : '1px solid var(--accent)',
          background: qbStatus && qbStatus.connected ? 'transparent' : 'var(--accent)',
          color: qbStatus && qbStatus.connected ? 'var(--text-primary)' : '#fff',
          cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap',
        }
      }, qbStatus && qbStatus.connected ? 'Reconnect' : 'Connect QuickBooks'),
    ),

    // Partners
    React.createElement('div', { style: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: 14, marginBottom: 12 } },
      React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 } },
        React.createElement('div', { style: { fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' } }, 'Partners'),
        React.createElement('button', {
          onClick: refresh, disabled: busy,
          style: { fontSize: 12, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }
        }, busy ? 'Refreshing…' : 'Refresh'),
      ),
      !partners ? React.createElement('div', { style: { color: 'var(--text-muted)', fontSize: 13 } }, 'Loading…') :
      partners.length === 0 ? React.createElement('div', { style: { color: 'var(--text-muted)', fontSize: 13 } }, 'No partners yet.') :
      React.createElement('div', { style: { display: 'flex', flexDirection: 'column' } },
        partners.map(p => React.createElement('div', {
          key: p.id,
          style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid var(--border)' }
        },
          React.createElement('div', null,
            React.createElement('div', { style: { fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' } }, p.company_name),
            React.createElement('div', { style: { fontSize: 12, color: 'var(--text-muted)' } },
              (p.contact_name || '') + ' · $' + (((p.lotlogic_tow_fee_cents ?? 10000) / 100).toFixed(2)) + '/tow'),
          ),
          p.quickbooks_customer_id
            ? React.createElement('span', { style: { fontSize: 12, color: 'var(--green)', fontWeight: 600 } }, 'QB #' + p.quickbooks_customer_id)
            : React.createElement('button', {
                onClick: (e) => syncPartner(p.id, e.currentTarget),
                style: { fontSize: 12, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer', fontWeight: 600 }
              }, 'Create in QuickBooks'),
        ))
      )
    ),

    // Pending invoices
    React.createElement('div', null,
      React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 } },
        React.createElement('div', { style: { fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' } }, 'Pending invoices'),
        React.createElement('button', {
          onClick: async (e) => {
            const b = e.currentTarget;
            b.disabled = true;
            const orig = b.textContent;
            b.textContent = 'Generating…';
            try {
              const res = await apiFetch('/quickbooks/run-weekly-invoicing', { method: 'POST' });
              const drafted = (res.results || []).filter(r => r.status === 'drafted').length;
              const skipped = (res.results || []).filter(r => r.status === 'skipped_exists').length;
              const noTows = (res.results || []).filter(r => r.status === 'no_tows').length;
              alert(`Drafted: ${drafted} · Already existed: ${skipped} · No tows this week: ${noTows}`);
              await refresh();
            } catch (err) {
              alert(err.message);
            } finally {
              b.disabled = false;
              b.textContent = orig;
            }
          },
          style: { fontSize: 12, padding: '6px 12px', borderRadius: 6, border: '1px solid var(--accent)', background: 'var(--accent)', color: '#fff', cursor: 'pointer', fontWeight: 600 },
          title: 'Draft this week\'s pending invoices from resolved tows',
        }, 'Generate invoices now'),
      ),
      !invoices ? React.createElement('div', { style: { color: 'var(--text-muted)', fontSize: 13 } }, 'Loading…') :
      invoices.length === 0 ? React.createElement('div', { style: { color: 'var(--text-muted)', fontSize: 13, padding: 12, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12 } }, 'No pending invoices yet. Click Generate invoices now, or wait for the Monday 6am ET cron.') :
      React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        invoices.map(pi => {
          const sc = statusColor[pi.status] || { bg: 'transparent', fg: 'var(--text-muted)' };
          const actions = actionsFor[pi.status] || [];
          return React.createElement('div', {
            key: pi.id,
            style: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: 14 }
          },
            React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8, gap: 8 } },
              React.createElement('div', null,
                React.createElement('div', { style: { fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' } }, pi.partner_company_name || pi.partner_id),
                React.createElement('div', { style: { fontSize: 12, color: 'var(--text-muted)', marginTop: 2 } },
                  'Week of ' + pi.week_start + ' · ' + pi.line_items.length + ' tow(s) · $' + (pi.total_cents / 100).toFixed(2)),
              ),
              React.createElement('span', {
                style: { fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 10, background: sc.bg, color: sc.fg, textTransform: 'uppercase', letterSpacing: '.04em', whiteSpace: 'nowrap' }
              }, pi.status.replace(/_/g, ' ')),
            ),

            pi.line_items.length > 0 && React.createElement('div', { style: { marginBottom: 10 } },
              pi.line_items.map(ln => React.createElement('div', {
                key: ln.violation_id,
                style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', fontSize: 12, color: 'var(--text-secondary)', borderBottom: '1px solid var(--border)' }
              },
                React.createElement('span', null, (ln.plate || '—') + ' · ' + ln.lot_name + ' · ' + (ln.resolved_at || '').slice(0, 10)),
                React.createElement('span', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                  '$' + (ln.amount_cents / 100).toFixed(2),
                  pi.status === 'pending_review' && React.createElement('button', {
                    onClick: () => act('/quickbooks/pending-invoices/' + pi.id + '/remove-line', { violation_id: ln.violation_id }),
                    style: { border: 'none', background: 'transparent', color: '#ef4444', cursor: 'pointer', fontSize: 14, padding: 0, lineHeight: 1 },
                    title: 'Remove this line',
                    'aria-label': 'Remove line for plate ' + (ln.plate || 'unknown'),
                  }, '\u2715'),
                ),
              ))
            ),

            actions.length > 0 && React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
              actions.map(a => React.createElement('button', {
                key: a.name,
                onClick: () => {
                  if (a.confirm && !window.confirm(a.confirm)) return;
                  act('/quickbooks/pending-invoices/' + pi.id + '/' + a.name);
                },
                style: {
                  fontSize: 12, padding: '6px 12px', borderRadius: 6,
                  border: '1px solid ' + (a.primary ? 'var(--accent)' : 'var(--border)'),
                  background: a.primary ? 'var(--accent)' : 'transparent',
                  color: a.primary ? '#fff' : 'var(--text-primary)',
                  cursor: 'pointer', fontWeight: 600,
                }
              }, a.label))
            ),

            pi.quickbooks_invoice_id && React.createElement('div', { style: { fontSize: 11, color: 'var(--text-muted)', marginTop: 8 } }, 'QB invoice #' + pi.quickbooks_invoice_id),
            pi.sent_at && React.createElement('div', { style: { fontSize: 11, color: 'var(--text-muted)', marginTop: 2 } }, 'Sent ' + pi.sent_at.slice(0, 10) + (pi.sent_by ? ' by ' + pi.sent_by : '')),
          );
        })
      )
    ),
  );
}
