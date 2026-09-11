import React from 'react';

// Health dot PLUS the word — a colour-only dot is invisible to a colour-blind
// operator at 6am, which is exactly who this screen is for.
const HEALTH = {
  red:   { color: '#f87171', word: 'red — needs attention' },
  amber: { color: '#fbbf24', word: 'amber — keep an eye on it' },
  green: { color: '#22c55e', word: 'green — all clear' },
};

export function BusinessStrip({ businesses }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 10 }}>
      {(businesses || []).map((b) => {
        const h = HEALTH[b.health] || HEALTH.green;
        return (
          <div
            key={b.slug}
            data-testid="business-card"
            data-health={b.health}
            style={{
              background: 'var(--bg-card)',
              border: `1px solid ${h.color}55`,
              borderRadius: 10,
              padding: 12,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: h.color, display: 'inline-block', flex: '0 0 auto' }} />
              <span style={{ fontWeight: 800, fontSize: 14, color: 'var(--text-primary)' }}>{b.name}</span>
            </div>
            <div style={{ fontSize: 12, fontWeight: 700, color: h.color, marginBottom: 4 }}>{h.word}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {b.open_high} open high · ${Number(b.spend_today_usd || 0).toFixed(2)} today
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default BusinessStrip;
