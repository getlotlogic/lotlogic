import React, { useCallback, useContext, useEffect, useState } from 'react';
import { API, getSessionToken } from '../../lib/api.js';

// ── Documents and browser hooks for the approval queue ───────
//
// Document bytes are PII and auth-gated, so an <img src> cannot carry the
// bearer token. Each document is fetched to a Blob with an explicit
// Authorization header (through the page's cache, so a list thumbnail and the
// detail card fetch once), and every consumer makes its own object URL and
// revokes it when it unmounts.

export async function fetchDocBlob(path) {
  const token = getSessionToken();
  const res = await fetch(`${API}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (res.status === 401) {
    // Same as apiFetch: a dead session clears and returns to sign-in.
    try { localStorage.removeItem('lotlogic_session'); } catch { /* blocked storage */ }
    window.dispatchEvent(new CustomEvent('lotlogic:auth-expired'));
  }
  if (!res.ok) {
    const err = new Error(`Could not load document (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return res.blob();
}

/** The page's document cache (`createDocCache`), handed to every card and thumbnail. */
export const DocCacheContext = React.createContext(null);

/** `{status: idle|loading|ready|error, blob, retry}` for one docs path, fetched once `enabled`. */
export function useDoc(path, enabled) {
  const cache = useContext(DocCacheContext);
  const [state, setState] = useState({ status: 'idle', blob: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled || !path || !cache) return undefined;
    let live = true;
    setState({ status: 'loading', blob: null });
    cache.get(path).then(
      blob => { if (live) setState({ status: 'ready', blob }); },
      () => { if (live) setState({ status: 'error', blob: null }); },
    );
    return () => { live = false; };
  }, [path, enabled, cache, attempt]);
  const retry = useCallback(() => setAttempt(n => n + 1), []);
  return { ...state, retry };
}

/** An object URL for `blob`, revoked when the blob changes or the consumer unmounts. */
export function useObjectUrl(blob) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    if (!blob) { setUrl(null); return undefined; }
    const made = URL.createObjectURL(blob);
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [blob]);
  return url;
}

/** True once the element has come within `rootMargin` of the viewport (stays true). */
export function useInView(ref, rootMargin = '240px') {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (seen) return undefined;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') { setSeen(true); return undefined; }
    const io = new IntersectionObserver((entries) => {
      if (entries.some(e => e.isIntersecting)) { setSeen(true); io.disconnect(); }
    }, { rootMargin });
    io.observe(el);
    return () => io.disconnect();
  }, [seen, ref, rootMargin]);
  return seen;
}

export function useMediaQuery(query) {
  const read = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(query).matches
    : false);
  const [matches, setMatches] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const mql = window.matchMedia(query);
    const sync = () => setMatches(mql.matches);
    sync();
    if (mql.addEventListener) mql.addEventListener('change', sync);
    else mql.addListener(sync);
    return () => {
      if (mql.removeEventListener) mql.removeEventListener('change', sync);
      else mql.removeListener(sync);
    };
  }, [query]);
  return matches;
}
