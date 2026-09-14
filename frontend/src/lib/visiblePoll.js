// Poll only while the tab is visible, and refresh once the moment it becomes
// visible again — so a user coming back to the tab sees fresh data immediately
// rather than after a full interval.
//
// Pure and injectable so it can be tested under `node --test` with a fake
// document. The React binding is useVisiblePolling in ../hooks.js.
export function startVisiblePoll({ fn, ms, doc = globalThis.document, onError }) {
  if (!(ms > 0) || typeof fn !== 'function') return () => {};
  let timer = null;
  let stopped = false;

  const run = () => {
    if (stopped) return;
    try {
      const out = fn();
      if (out && typeof out.catch === 'function') out.catch(e => onError && onError(e));
    } catch (e) { if (onError) onError(e); }
  };
  const start = () => { if (timer == null && !stopped) timer = setInterval(run, ms); };
  const stop  = () => { if (timer != null) { clearInterval(timer); timer = null; } };
  const onVisibility = () => {
    if (stopped) return;
    if (doc.hidden) stop();
    else { run(); start(); }          // catch up, then resume
  };

  if (!doc.hidden) start();
  doc.addEventListener('visibilitychange', onVisibility);

  return () => {
    stopped = true;
    stop();
    doc.removeEventListener('visibilitychange', onVisibility);
  };
}
