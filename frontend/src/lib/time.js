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
