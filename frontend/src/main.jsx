import React from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from './ui/ErrorBoundary.jsx';
import { ToastProvider } from './ui/Toast.jsx';
import { App } from './App.jsx';
import { db } from './lib/db.js';
import { lotDayBound } from './lib/lotdate.js';

createRoot(document.getElementById('root')).render(
  <ErrorBoundary label="the dashboard"><ToastProvider><App /></ToastProvider></ErrorBoundary>
);

// ── e2e test hooks ──────────────────────────────────────────────
// The dashboard used to be Babel-transpiled in the browser from one inline
// <script>, so every top-level component and helper landed on `window` for
// free and Playwright just grabbed them. esbuild bundles everything into
// module scope now — nothing survives onto `window` on its own. This is the
// one deliberate crack in that: an explicit, minimal surface for the specs
// that need to mount a component in isolation or call a pure helper
// directly, gated so it never reaches a real visitor's page.
//
// ALPRPropertyDetailPage and TruckParkingLog are lazy pages in the real app
// (`lazyPage(() => import(...))`), so they don't exist as a plain, callable
// component until their chunk loads. Handing tests the React.lazy() wrapper
// itself isn't equivalent to the old global (it's not a function, and
// mounting it means dragging Suspense into every harness), so each is
// exposed instead as `{ load() }`, resolving to the module's default export
// via the same dynamic import the app already uses to fetch that chunk.
function isE2E() {
  try {
    return new URLSearchParams(location.search).has('e2e')
      || localStorage.getItem('lotlogic:e2e') === '1';
  } catch {
    return false;
  }
}

if (isE2E()) {
  window.__lotlogicTestHooks = {
    // React + ReactDOM: specs mount a component on a second root, alongside
    // the app's own. That only works without "Invalid hook call" if it's the
    // SAME React/ReactDOM module instance the bundle already loaded — so
    // hand out this bundle's copies rather than letting the test import its
    // own from node_modules.
    React,
    ReactDOM: { createRoot },
    // db: the single data-access object every page calls through. Specs
    // stub individual methods on it (e.g. `db.getProperty`) to hand a
    // mounted page fixture data without a real backend or Supabase session.
    db,
    ToastProvider,
    lotDayBound,
    ALPRPropertyDetailPage: {
      load: () => import('./pages/ALPRPropertyDetailPage.jsx').then((m) => m.default),
    },
    TruckParkingLog: {
      load: () => import('./pages/TruckParkingLog.jsx').then((m) => m.default),
    },
  };
}
