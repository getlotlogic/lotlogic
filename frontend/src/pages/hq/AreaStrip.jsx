import React from 'react';

// Health dot PLUS the word — a colour-only dot is invisible to a colour-blind
// operator at 6am, which is exactly who this screen is for. Colours are
// theme-aware CSS variables (dashboard.html), not literals — a fixed hex
// can't clear 4.5:1 text contrast against both the dark and light --bg-card
// (the light and dark themes need opposite-direction luminance), and
// --green specifically is calibrated for large KPI numerals (3:1) elsewhere
// in the app, not small body text, so this uses --green-text instead.
const HEALTH = {
  red:   { color: 'var(--red)', word: 'red — needs attention', rank: 0 },
  amber: { color: 'var(--yellow)', word: 'amber — keep an eye on it', rank: 1 },
  green: { color: 'var(--green-text)', word: 'green — all clear', rank: 2 },
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
// on narrow viewports — nothing is hidden behind a fold, and the red one is
// still the first thing a human's thumb lands on. At >=1024px (HQ-1) there
// is room for all eight without a fold or a scrollbar, so `.hq-area-strip`'s
// desktop media query (dashboard.html) switches the same 220px cards from a
// scrolling single row to a wrapping grid instead — same card, same colors,
// no scroll either way.
export function AreaStrip({ areas }) {
  const ordered = byHealth(areas || []);
  return (
    <div
      role="group"
      aria-label="LotLogic's eight areas, scroll for more on narrow screens"
      tabIndex={0}
      className="hq-area-strip"
    >
      {ordered.map((area) => {
        const h = HEALTH[area.health] || HEALTH.green;
        return (
          <div
            key={area.slug}
            data-testid="area-card"
            data-health={area.health}
            data-area={area.slug}
            className="hq-area-card"
            style={{
              background: 'var(--bg-card)',
              border: `1px solid ${h.color}`,
              borderRadius: 10,
              padding: 12,
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
