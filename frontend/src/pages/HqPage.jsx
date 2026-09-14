import React, { useState, useEffect, useCallback, useRef } from 'react';
import { fetchBoard } from '../lib/brainApi.js';
import { useVisiblePolling } from '../hooks.js';
import { AreaStrip } from './hq/AreaStrip.jsx';
import { RedList } from './hq/RedList.jsx';
import { QuestionCard } from './hq/QuestionCard.jsx';
import { ChangedThisWeek } from './hq/ChangedThisWeek.jsx';
import { FleetHealth } from './hq/FleetHealth.jsx';

// ── HqPage ────────────────────────────────────────────────────
// One screen a human reads in a minute: red first, one sentence per item
// with an evidence link, no charts. Refreshes every 60s; a failed refresh
// keeps the last good board on screen with a quiet "last updated" mark — a
// status screen that blanks itself during an incident lies by omission.
const REFRESH_MS = 60_000;

function fmtClock(d) {
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

export function HqPage() {
  const [board, setBoard] = useState(null);
  const [error, setError] = useState(null);
  const [lastGoodAt, setLastGoodAt] = useState(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const load = useCallback(async () => {
    try {
      const b = await fetchBoard();
      if (!mountedRef.current) return;
      setBoard(b);
      setLastGoodAt(new Date());
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      // Keep whatever board is already on screen — only the error + stale
      // marker change. See REFRESH_MS comment above.
      setError(err);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  // FE-8: gated by tab visibility.
  useVisiblePolling(load, REFRESH_MS, [load]);

  // Optimistic removal only — the brief's "re-fetches next tick" means the
  // standing 60s interval above, not an immediate re-fetch. An immediate
  // re-fetch would race the interval and could put an answered question or a
  // closed finding right back on screen before the backend caught up.
  const handleAnswered = useCallback((id) => {
    setBoard((prev) => (prev ? { ...prev, questions: prev.questions.filter((q) => q.id !== id) } : prev));
  }, []);
  const handleClosed = useCallback((id) => {
    setBoard((prev) => (prev ? { ...prev, red: prev.red.filter((f) => f.id !== id) } : prev));
  }, []);

  // No board yet and no attempt has resolved either way — the first fetch
  // is still in flight. Nothing to show yet, but this is NOT the cold-failure
  // case below: render a minimal loading line rather than a blank screen
  // that is indistinguishable from "never going to load".
  if (!board && !error) {
    return (
      <div data-testid="hq-loading" className="page-enter" style={{ padding: '16px 12px', maxWidth: 1000, margin: '0 auto', fontSize: 13, color: 'var(--text-muted)' }}>
        Loading HQ…
      </div>
    );
  }

  // A cold failure: the FIRST fetch came back 403/503/network-error before
  // any board ever loaded. `return null` here would leave a platform admin
  // looking at a blank tab with no error and no way to retry short of the
  // silent 60s interval — indistinguishable from an app that is still
  // loading. Show the reason and the same Refresh button every other error
  // state on this page uses.
  if (!board && error) {
    return (
      <div className="page-enter" style={{ padding: '16px 12px calc(var(--bottom-nav-height, 58px) + env(safe-area-inset-bottom) + 24px)', maxWidth: 1000, margin: '0 auto' }}>
        <div
          data-testid="hq-unavailable"
          style={{
            background: 'var(--bg-card)', border: '1px solid var(--red)', borderRadius: 10,
            padding: 16, display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start',
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--text-primary)' }}>Board unavailable</div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{error.message || 'Could not load the board.'}</div>
          <button
            data-testid="hq-refresh"
            onClick={load}
            style={{
              fontSize: 12, fontWeight: 700, padding: '6px 14px', borderRadius: 6, cursor: 'pointer',
              background: 'transparent', color: 'var(--text-primary)', border: '1px solid var(--border)',
            }}
          >
            Refresh
          </button>
        </div>
      </div>
    );
  }

  const staleLabel = error && lastGoodAt ? `Last updated ${fmtClock(lastGoodAt)}` : null;

  return (
    <div
      data-testid="hq-root"
      className="page-enter"
      style={{
        // The fixed bottom nav (.bottom-nav) sits over the last card unless
        // this reserves at least its full height, including the safe-area
        // inset the nav itself pads into on notched phones — tied to the
        // nav's own --bottom-nav-height variable (dashboard.html) rather
        // than a bare magic number, plus a little breathing room.
        padding: '16px 12px calc(var(--bottom-nav-height, 58px) + env(safe-area-inset-bottom) + 24px)',
        maxWidth: 1000,
        margin: '0 auto',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: 'var(--text-primary)' }}>HQ</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {staleLabel && (
            <div data-testid="hq-stale" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {staleLabel} — refresh failed, showing the last good board
            </div>
          )}
          <button
            data-testid="hq-refresh"
            onClick={load}
            style={{
              fontSize: 12, fontWeight: 700, padding: '6px 14px', borderRadius: 6, cursor: 'pointer',
              background: 'transparent', color: 'var(--text-primary)', border: '1px solid var(--border)',
            }}
          >
            Refresh
          </button>
        </div>
      </div>

      <section data-section="areas" style={{ marginBottom: 22 }}>
        <AreaStrip areas={board.areas} />
      </section>

      <section data-section="priorities" style={{ marginBottom: 22 }}>
        <h3 style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.05em' }}>
          Priorities
        </h3>
        <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {(board.priorities || []).map((p, i) => (
            <li key={i} style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{p}</li>
          ))}
        </ol>
      </section>

      <section data-section="red" style={{ marginBottom: 22 }}>
        <h3 style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 700, color: 'var(--red)', textTransform: 'uppercase', letterSpacing: '.05em' }}>
          Red first
        </h3>
        <RedList findings={board.red} onClosed={handleClosed} />
      </section>

      <section data-section="questions" style={{ marginBottom: 22 }}>
        <h3 style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.05em' }}>
          Waiting on you
        </h3>
        {(board.questions || []).length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Nothing waiting.</div>
        ) : (
          board.questions.map((q) => (
            <QuestionCard key={q.id} question={q} onAnswered={handleAnswered} />
          ))
        )}
      </section>

      <section data-section="changed" style={{ marginBottom: 22 }}>
        <h3 style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.05em' }}>
          Changed this week
        </h3>
        <ChangedThisWeek items={board.changed_this_week} />
      </section>

      <section data-section="fleet">
        <h3 style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.05em' }}>
          Fleet health
        </h3>
        <FleetHealth fleet={board.fleet} />
      </section>
    </div>
  );
}

export default HqPage;
