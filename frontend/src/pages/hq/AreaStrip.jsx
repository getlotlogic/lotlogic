import React from 'react';

// Health dot PLUS the word — a colour-only dot is invisible to a colour-blind
// operator at 6am, which is exactly who this screen is for.
const HEALTH = {
  red:   { color: '#f87171', word: 'red — needs attention', rank: 0 },
  amber: { color: '#fbbf24', word: 'amber — keep an eye on it', rank: 1 },
  green: { color: '#22c55e', word: 'green — all clear', rank: 2 },
};

// Ordered by health, not alphabetically — red, then amber, then green,
// stable within each band by the area's own order. The whole point of the
// screen is that the thing that is wrong is at the top left.
function byHealth(areas) {
  return areas
    .map((area, i) => ({ area, i }))
    .sort((x, y) => {
      const rx = (HEALTH[x.area.health] || HEALTH.green).rank;
      const ry = (HEALTH[y.area.health] || HEALTH.green).rank;
      return rx !== ry ? rx - ry : x.i - y.i;
    })
    .map(({ area }) => area);
}

// LotLogic's eight areas (spec §9.5 / ruling SC-2). Eight cards do not fit
// four-across on a phone, so this is a horizontally scrolling, snapping row
// rather than a grid — nothing is hidden behind a fold, and the red one is
// still the first thing a human's thumb lands on.
export function AreaStrip({ areas }) {
  const ordered = byHealth(areas || []);
  return (
    <div
      style={{
        display: 'flex',
        gap: 10,
        overflowX: 'auto',
        scrollSnapType: 'x mandatory',
        paddingBottom: 4,
        WebkitOverflowScrolling: 'touch',
      }}
    >
      {ordered.map((area) => {
        const h = HEALTH[area.health] || HEALTH.green;
        return (
          <div
            key={area.slug}
            data-testid="area-card"
            data-health={area.health}
            data-area={area.slug}
            style={{
              background: 'var(--bg-card)',
              border: `1px solid ${h.color}55`,
              borderRadius: 10,
              padding: 12,
              flex: '0 0 220px',
              scrollSnapAlign: 'start',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: h.color, display: 'inline-block', flex: '0 0 auto' }} />
              <span style={{ fontWeight: 800, fontSize: 14, color: 'var(--text-primary)' }}>{area.name}</span>
            </div>
            <div style={{ fontSize: 12, fontWeight: 700, color: h.color, marginBottom: 4 }}>{h.word}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {area.open_high} open high · ${Number(area.spend_today_usd || 0).toFixed(2)} today
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default AreaStrip;
