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
//
// The flag is the ONLY thing standing between a persistently-404ing chunk
// and an infinite refresh loop, so a reload happens only when the flag was
// written successfully. Storage that throws (Safari private mode, a full
// quota) therefore gets the ErrorBoundary rather than a spinning page.
const CHUNK_RELOAD_KEY = 'lotlogic:chunk-reload';
const RELOAD_WINDOW_MS = 60000;

function readReloadedAt() {
  try {
    return sessionStorage.getItem(CHUNK_RELOAD_KEY);
  } catch {
    return null; // private mode / storage disabled — treat as never reloaded
  }
}

// Returns whether the value was actually persisted. That matters on the
// failure path: the reload guard IS the stored flag, so if the write did not
// land there is nothing to stop the next load failing and reloading again,
// forever. Callers must not reload unless this returned true.
function writeReloadedAt(value) {
  try {
    if (value === null) sessionStorage.removeItem(CHUNK_RELOAD_KEY);
    else sessionStorage.setItem(CHUNK_RELOAD_KEY, value);
    return true;
  } catch {
    return false; // private mode / storage disabled / quota exceeded
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
        // Record the reload BEFORE performing it. If it could not be
        // recorded, do not reload at all — an unguarded reload on a page
        // whose chunk keeps 404ing is an endless refresh loop, which is
        // strictly worse for the user than the ErrorBoundary. Rethrowing
        // hands them the boundary's "Something went wrong" instead.
        if (!writeReloadedAt(String(Date.now()))) throw err;
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
