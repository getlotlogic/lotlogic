import React from 'react';

// Counters as text, not a chart — a chart that does not change a decision is
// decoration.
export function FleetHealth({ fleet }) {
  if (!fleet) return null;
  const {
    ok_24h = 0, failed_24h = 0,
    spend_today_usd = 0, budget_usd = 0,
    running = 0, cap = 0,
    dead_workers = [], budget_stop = false,
  } = fleet;

  return (
    <div data-testid="fleet-health" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: 12 }}>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
        <div>{ok_24h} ok / {failed_24h} failed</div>
        <div>${Number(spend_today_usd).toFixed(2)} of ${Number(budget_usd).toFixed(2)}</div>
        <div>{running} running of {cap}</div>
      </div>
      {budget_stop && (
        <div style={{ fontSize: 12, color: '#fbbf24', fontWeight: 700, marginTop: 8 }}>
          Budget stop is active — no new work is being claimed.
        </div>
      )}
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
        {dead_workers.length === 0 ? 'No dead workers.' : `Dead: ${dead_workers.join(', ')}`}
      </div>
    </div>
  );
}

export default FleetHealth;
