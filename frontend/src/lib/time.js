import { useState, useEffect } from 'react';

// ── Shared helpers (parking passes) ──────────────────────────
// Format a millisecond duration as "Xh Ym left" / "Zm left" / "<1m left" / "Expired"
export function fmtPassRemaining(ms) {
  if (ms <= 0) return 'Expired';
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h >= 1) return `${h}h ${m}m left`;
  if (m >= 1) return `${m}m left`;
  return '<1m left';
}

// Return a debounced version of fn that coalesces calls within `wait` ms.
// Useful for realtime callbacks that can fire in bursts.
export function makeDebounced(fn, wait) {
  let t = null;
  return function debounced(...args) {
    if (t) clearTimeout(t);
    t = setTimeout(() => { t = null; fn(...args); }, wait);
  };
}

// Keep a dashboard-wide ticker so every "time-left" label counts down in lockstep
// without each component setting its own interval.
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

