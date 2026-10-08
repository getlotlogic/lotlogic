import React from 'react';
import { RequestRow } from './RequestRow.jsx';

// ── Recent (7 days) ──────────────────────────────────────────
//
// Spec §5.2: a collapsed `<details>` under the active groups, rows dimmed, the
// outcome written out in words, and Reinstate on the hold rows that are still
// inside the 7-day window (§4.2).
//
// The dimming is `.req-recent-row`, which sets muted *text* colours rather
// than an `opacity` on the row. That is the whole point: an .55-opacity box
// would drag the outcome pill below 4.5:1 in `.theme-light`, and the pill is
// the one thing in the row a manager actually came to read.

export function RecentList({ items, canAct, canFulfill, viewerName, onHistory, onReinstate, addToast }) {
  const rows = Array.isArray(items) ? items : [];
  if (rows.length === 0) return null;
  return (
    <details className="req-recent">
      <summary>Recent (7 days) · {rows.length}</summary>
      <div>
        {rows.map(r => (
          <RequestRow
            key={r.id}
            request={r}
            recent
            canAct={canAct}
            canFulfill={canFulfill}
            viewerName={viewerName}
            onHistory={onHistory}
            onReinstate={r.kind === 'hold' ? onReinstate : undefined}
            addToast={addToast}
          />
        ))}
      </div>
    </details>
  );
}
