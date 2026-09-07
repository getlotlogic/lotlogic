import React from 'react';

// ── Loading skeleton ─────────────────────────────────────────
export function SkeletonCards({ count = 3 }) {
  return Array.from({ length: count }).map((_, i) => (
    <div key={i} className="skeleton-card" style={{ animationDelay: `${i * .05}s` }}>
      <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
        <div className="skeleton skeleton-circle" />
        <div style={{ flex: 1 }}>
          <div className="skeleton skeleton-line w60" />
          <div className="skeleton skeleton-line w40" />
        </div>
      </div>
      <div className="skeleton skeleton-line w80" />
      <div className="skeleton skeleton-line w30" />
    </div>
  ));
}

export function SkeletonKPIs() {
  return (
    <div className="kpi-bar">
      {[1, 2, 3, 4].map(i => <div key={i} className="skeleton skeleton-kpi" />)}
    </div>
  );
}
