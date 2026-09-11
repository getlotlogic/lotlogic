import React, { useState } from 'react';
import { closeFinding } from '../../lib/brainApi.js';

// Every open high finding: one sentence, the worker, seen_count, an
// evidence link, and a Close button that asks for a reason before it lets
// go of the row.
export function RedList({ findings, onClosed }) {
  const [closingId, setClosingId] = useState(null);
  const [reason, setReason] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [errId, setErrId] = useState(null);

  function startClose(id) {
    setClosingId(id);
    setReason('');
    setErrId(null);
  }

  async function confirm(id) {
    setBusyId(id);
    try {
      await closeFinding(id, reason);
      setBusyId(null);
      setClosingId(null);
      setReason('');
      onClosed?.(id);
    } catch {
      setBusyId(null);
      setErrId(id);
    }
  }

  if (!findings || findings.length === 0) {
    return <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No open high findings.</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {findings.map((f) => (
        <div
          key={f.fingerprint}
          data-testid="red-finding"
          style={{ background: 'var(--bg-card)', border: '1px solid rgba(248,113,113,.35)', borderRadius: 10, padding: 12 }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <div style={{ flex: '1 1 200px', minWidth: 200 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>{f.title}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                {f.worker} · seen {f.seen_count}×
                {f.evidence_url && (
                  <>
                    {' · '}
                    <a href={f.evidence_url} target="_blank" rel="noreferrer" style={{ color: '#a78bfa' }}>evidence</a>
                  </>
                )}
              </div>
            </div>
            {closingId !== f.id ? (
              <button
                onClick={() => startClose(f.id)}
                style={{
                  fontSize: 12, fontWeight: 700, padding: '6px 14px', borderRadius: 6, cursor: 'pointer',
                  background: 'transparent', color: 'var(--text-primary)', border: '1px solid var(--border)',
                }}
              >
                Close
              </button>
            ) : (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  data-testid="close-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Reason"
                  style={{
                    background: 'var(--bg-surface, var(--bg-card))', color: 'var(--text)',
                    border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px', fontSize: 13,
                  }}
                />
                <button
                  onClick={() => confirm(f.id)}
                  disabled={busyId === f.id || !reason.trim()}
                  style={{
                    fontSize: 12, fontWeight: 700, padding: '6px 14px', borderRadius: 6,
                    cursor: busyId === f.id || !reason.trim() ? 'default' : 'pointer',
                    background: 'rgba(34,197,94,.15)', color: '#22c55e', border: '1px solid rgba(34,197,94,.35)',
                    opacity: busyId === f.id || !reason.trim() ? .6 : 1,
                  }}
                >
                  {busyId === f.id ? 'Closing…' : 'Confirm'}
                </button>
              </div>
            )}
          </div>
          {errId === f.id && <div style={{ color: '#f87171', fontSize: 12, marginTop: 6 }}>Could not close — try again.</div>}
        </div>
      ))}
    </div>
  );
}

export default RedList;
