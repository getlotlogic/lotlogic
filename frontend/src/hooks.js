import { useState, useEffect, useCallback, useRef } from 'react';
import { db } from './lib/db.js';
import { supabase } from './lib/supabase.js';
import { startVisiblePoll } from './lib/visiblePoll.js';

// FE-8. A dashboard left open on an office monitor used to poll forever. Every
// recurring fetch in this app goes through here.
export function useVisiblePolling(fn, ms, deps = []) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(
    () => startVisiblePoll({ fn: () => fnRef.current(), ms }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ms, ...deps],
  );
}

// ── Theme hook ────────────────────────────────────────────────
export function useTheme() {
  const [theme, setTheme] = useState(() => localStorage.getItem('lotlogic_theme') || 'light');
  useEffect(() => {
    localStorage.setItem('lotlogic_theme', theme);
    // Update meta theme-color for mobile browsers
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'dark' ? '#0c0e14' : '#f8f9fb';
  }, [theme]);
  const toggle = useCallback(() => setTheme(t => t === 'dark' ? 'light' : 'dark'), []);
  return { theme, toggle };
}

// ── Online/offline hook ──────────────────────────────────────
export function useOnlineStatus() {
  const [online, setOnline] = useState(navigator.onLine);
  const [reconnected, setReconnected] = useState(false);
  useEffect(() => {
    const goOnline = () => { setOnline(true); setReconnected(true); setTimeout(() => setReconnected(false), 3000); };
    const goOffline = () => { setOnline(false); setReconnected(false); };
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => { window.removeEventListener('online', goOnline); window.removeEventListener('offline', goOffline); };
  }, []);
  return { online, reconnected };
}

// ── Interval-fetch hook ──────────────────────────────────────
// One-shot + interval poller. Runs `fn` once on mount, then every `ms`
// milliseconds (pass 0 or negative to disable the interval and fire once only).
// Uses a single useEffect so the initial call and the first interval tick
// can't race, and sets a `cancelled` flag so a late-returning in-flight fetch
// doesn't push stale state after unmount.
//
// Dependencies go in `deps` — treat it like the deps array on useEffect.
// Because deps is dynamic we silence exhaustive-deps at the call site.
// THE shared hook for "who is currently registered." Wraps db.getActiveRoster
// (the single source of truth) with realtime updates + a 60s safety poll, and
// keeps the last good roster on screen if a refresh errors. Used by the Lots
// "Registered" count, the Registered drill-down, and the Truck Parking Log so
// all three render identical data. Returns { roster, loading, error, refresh }.
export function useActiveRoster(propertyId) {
  const [roster, setRoster] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Monotonic request token: a slow fetch for a previous propertyId must never
  // push its stale roster after a newer fetch has started. Each refresh claims
  // a token; only the latest token is allowed to write state.
  const reqRef = useRef(0);
  const refresh = useCallback(() => {
    if (!propertyId) return;
    const myReq = ++reqRef.current;
    db.getActiveRoster(propertyId)
      .then(r => { if (myReq === reqRef.current) { setRoster(r || []); setError(null); } })
      // Keep the previous roster — never blank on a transient error.
      .catch(e => { if (myReq === reqRef.current) setError(e?.message || 'Could not refresh roster'); })
      .finally(() => { if (myReq === reqRef.current) setLoading(false); });
  }, [propertyId]);
  useEffect(() => {
    // No property yet → clear the spinner instead of hanging on "Loading…".
    if (!propertyId) { setLoading(false); return; }
    reqRef.current++;            // invalidate any in-flight fetch from a prior id
    setLoading(true);
    refresh();
    // Only the 60s safety poll is gated by tab visibility — the realtime
    // channel below is push-based, costs nothing while idle, and is what
    // makes the roster feel live, so it is left running regardless.
    const stopPoll = startVisiblePoll({ fn: refresh, ms: 60000 });
    let ch = null;
    if (supabase) {
      ch = supabase.channel('active-roster-' + propertyId + '-' + Math.random().toString(36).slice(2, 8))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'visitor_passes', filter: 'property_id=eq.' + propertyId }, refresh)
        .subscribe();
    }
    return () => { stopPoll(); if (ch) { try { supabase.removeChannel(ch); } catch {} } };
  }, [propertyId, refresh]);
  return { roster, loading, error, refresh };
}

export function useIntervalFetch(fn, ms, deps) {
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (cancelled) return;
      try { await fn(); } catch (_) { /* caller is responsible for error state */ }
    };
    run();
    // FE-8: gated by tab visibility, and refreshes once immediately on
    // return — every caller of useIntervalFetch inherits this for free.
    const stop = startVisiblePoll({ fn: run, ms });
    return () => { cancelled = true; stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

// Keep a dashboard-wide ticker so every "time-left" label counts down in lockstep
// without each component setting its own interval.
//
// FE-8: deliberately NOT gated by tab visibility. It touches no network — it
// only re-renders whatever countdown text is already on screen — and gating
// it would freeze visible countdowns in a tab that was briefly backgrounded
// (e.g. switched away and immediately back), showing a stale time-left value
// until the next tick catches up.
const NOW_TICK_LISTENERS = new Set();
let NOW_TICK_INTERVAL = null;
export function useNowTick(everyMs = 30000) {
  const [t, setT] = useState(() => Date.now());
  useEffect(() => {
    const cb = () => setT(Date.now());
    NOW_TICK_LISTENERS.add(cb);
    if (!NOW_TICK_INTERVAL) {
      NOW_TICK_INTERVAL = setInterval(() => {
        NOW_TICK_LISTENERS.forEach(l => l());
      }, everyMs);
    }
    return () => {
      NOW_TICK_LISTENERS.delete(cb);
      if (NOW_TICK_LISTENERS.size === 0 && NOW_TICK_INTERVAL) {
        clearInterval(NOW_TICK_INTERVAL);
        NOW_TICK_INTERVAL = null;
      }
    };
  }, [everyMs]);
  return t;
}
