import React from 'react';

// ── NEW PROPERTY TO CONFIRM (spec §5.4, §3.8) ─────────────────
//
//   Sunset Ridge Apartments · 123 Main St
//   Dana Ortiz · Property manager
//   (704) 555-0123 · 2 holds
//   ⚠ Similar address: Sunset Ridge Apts
//   [ Confirm ]              [ Not ours ]
//
// Sticky until the queue is empty: an unconfirmed property is the one thing on
// this tab that blocks somebody else's work (the office is capped at 3 holds
// until N Style says the property is theirs), and it is the only item whose
// answer only N Style can give.
//
// The similar-address line comes from the route's `similar_address` /
// `possible_duplicate_of` name — it is a warning, never a block: two real
// properties can share a street.

const BTN = {
  borderRadius: 8, padding: '11px 16px', fontSize: 14, fontWeight: 700,
  cursor: 'pointer', minHeight: 44, flex: 1, fontFamily: 'inherit',
};

export function PendingPropertyCard({ property, busy, onConfirm, onReject }) {
  const identity = [property.name, property.address].filter(Boolean).join(' · ');
  const who = [property.managerName, property.managerPosition].filter(Boolean).join(' · ');
  const reach = [property.managerPhone, property.holds === 1 ? '1 hold' : `${property.holds} holds`]
    .filter(Boolean).join(' · ');
  return (
    <section
      aria-label={`Confirm ${property.name}`}
      aria-busy={busy ? 'true' : undefined}
      style={{
        background: 'var(--bg-card)', border: '1px solid rgba(251,191,36,.45)',
        borderRadius: 12, padding: 14, marginBottom: 10, opacity: busy ? 0.6 : 1,
      }}
    >
      <div style={{
        fontSize: 10, fontWeight: 800, letterSpacing: '.08em',
        color: '#fbbf24', marginBottom: 6,
      }}>
        NEW PROPERTY TO CONFIRM
      </div>
      <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--text-primary)' }}>{identity}</div>
      {who && <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 3 }}>{who}</div>}
      {reach && <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 3 }}>{reach}</div>}
      {property.similarAddress && (
        <div style={{ fontSize: 12, color: '#fbbf24', marginTop: 6 }}>
          <span aria-hidden="true">⚠ </span>Similar address: {property.similarAddress}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button
          type="button"
          disabled={busy}
          onClick={() => onConfirm(property)}
          style={{ ...BTN, background: 'var(--accent)', color: 'var(--accent-ink)', border: '1px solid var(--accent)' }}
        >
          Confirm
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onReject(property)}
          style={{
            ...BTN, background: 'var(--bg-inset)', color: 'var(--text-primary)',
            border: '1px solid var(--border)',
          }}
        >
          Not ours
        </button>
      </div>
    </section>
  );
}

export default PendingPropertyCard;
