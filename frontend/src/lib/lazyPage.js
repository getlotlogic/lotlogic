import React from 'react';

// ── Stale-chunk-safe lazy loading ──────────────────────────────
// After a Vercel redeploy, a tab left open from before the deploy still
// references the OLD dashboard.js, which requests chunk files by their old
// content hash (`chunks/JobsPage-<oldhash>.js`). Those files are gone from
// the new deployment, so the dynamic import 404s, the lazy import rejects,
// and the ErrorBoundary shows "Something went wrong" — whose "Reload tab"
// button only resets boundary state, not the page, so it loops forever on
// the same stale bundle.
//
// lazyPage() wraps React.lazy so a rejected import reloads the page ONCE
// (picking up the new dashboard.js with correct chunk hashes) instead of
// falling straight to the error boundary. A sessionStorage flag guards
// against a reload loop if the chunk is missing for some other reason
// (bad deploy, network failure): a second failure within 60s of the first
// reload rethrows so the ErrorBoundary's normal UI shows instead of
// reloading forever. A successful import clears the flag.
const CHUNK_RELOAD_KEY = 'lotlogic:chunk-reload';
const RELOAD_WINDOW_MS = 60000;

function readReloadedAt() {
  try {
    return sessionStorage.getItem(CHUNK_RELOAD_KEY);
  } catch {
    return null; // private mode / storage disabled — treat as never reloaded
  }
}

function writeReloadedAt(value) {
  try {
    if (value === null) sessionStorage.removeItem(CHUNK_RELOAD_KEY);
    else sessionStorage.setItem(CHUNK_RELOAD_KEY, value);
  } catch {
    // private mode / storage disabled — nothing to persist, nothing to do
  }
}

export function lazyPage(loader) {
  return React.lazy(async () => {
    try {
      const mod = await loader();
      writeReloadedAt(null);
      return mod;
    } catch (err) {
      const reloadedAt = readReloadedAt();
      const withinWindow = reloadedAt !== null && (Date.now() - Number(reloadedAt)) < RELOAD_WINDOW_MS;
      if (!withinWindow) {
        writeReloadedAt(String(Date.now()));
        try {
          location.reload();
        } catch {
          // no reload available (e.g. non-browser test harness) — fall
          // through and rethrow so the caller still sees the failure.
        }
      }
      throw err;
    }
  });
}
