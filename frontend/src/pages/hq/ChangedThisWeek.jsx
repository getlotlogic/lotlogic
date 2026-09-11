import React from 'react';

const KIND_LABEL = { fact: 'Fact', decision: 'Decision', metric: 'Metric' };

// Newest first, per the board contract — this renders in the order it's
// given rather than re-sorting.
export function ChangedThisWeek({ items }) {
  if (!items || items.length === 0) {
    return <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Nothing changed this week.</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {items.map((it, i) => (
        <div key={i} style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{KIND_LABEL[it.kind] || it.kind}</span>
          <span>{it.title}</span>
          <span>· {it.business} · {it.worker}</span>
        </div>
      ))}
    </div>
  );
}

export default ChangedThisWeek;
