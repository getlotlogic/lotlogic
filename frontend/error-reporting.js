/**
 * LotLogic front-end error reporting — one config for every page.
 *
 * Nothing here runs, and nothing is downloaded, until a DSN is filled in below.
 * That is deliberate: the switch is off until the owner creates the Sentry
 * project and pastes its DSN, and turning it on is a one-line edit in one file
 * rather than four.
 *
 * Why it exists: when a driver says "the QR code didn't work at 9:40 last
 * night", there is currently no way to find out what happened. If visit.html —
 * the form that takes a $15 card payment — throws on some phone, the driver
 * sees a stuck page, gives up, and the business never learns of it. Same for
 * the operator dashboard.
 *
 * Loaded by: dashboard.html, visit.html, apt.html, resident.html.
 *
 * ── TO TURN IT ON ────────────────────────────────────────────────────────────
 *   1. sentry.io → create a project of type "Browser JavaScript".
 *   2. Paste its DSN into SENTRY_DSN below. That value is public by design —
 *      it identifies the project, it does not grant access to it.
 *   3. Deploy. Confirm with `window.Sentry.captureMessage('hello')` in the
 *      console on lotlogicparking.com/app.
 * ─────────────────────────────────────────────────────────────────────────────
 */
(function () {
  'use strict';

  // ── CONFIG — the only line to edit ─────────────────────────────────────────
  var SENTRY_DSN = '';

  // Pinned with an integrity hash: a third party cannot silently change what
  // runs on the page that takes card payments. v8 rather than the newest major
  // because these pages are opened on whatever phone a driver is carrying.
  var SDK_URL = 'https://browser.sentry-cdn.com/8.55.0/bundle.min.js';
  var SDK_SRI = 'sha384-BlRl+vkcjdIA/AKRb8zWtiqlVVXepUsSv0+vho7ZMUTsNudEyQjGUKo9W86Hc1EC';

  // A page may override the DSN before this script runs (a preview build, a
  // one-off debug session). Otherwise the config above wins.
  if (!window.SENTRY_DSN) window.SENTRY_DSN = SENTRY_DSN;
  if (!window.SENTRY_DSN) return; // Off. Nothing is fetched, nothing is defined.

  var host = window.location.hostname;
  var environment = (host === 'lotlogicparking.com' || host === 'www.lotlogicparking.com')
    ? 'production'
    : (host === 'localhost' || host === '127.0.0.1') ? 'local' : 'preview';

  /**
   * Drop anything that could carry a driver's or an operator's details before
   * it leaves the browser. The QR forms hold a name, a phone number and a
   * plate; none of that belongs in an error report.
   */
  function scrub(event) {
    try {
      if (event.request) {
        delete event.request.cookies;
        delete event.request.data;
        if (event.request.url) event.request.url = String(event.request.url).split('?')[0];
      }
      delete event.user;
      if (event.breadcrumbs) {
        event.breadcrumbs = event.breadcrumbs.filter(function (b) {
          return b.category !== 'ui.input'; // keystrokes in the pass form
        }).map(function (b) {
          if (b.data && b.data.url) b.data.url = String(b.data.url).split('?')[0];
          return b;
        });
      }
    } catch (_) { /* never let scrubbing break the page */ }
    return event;
  }

  // What this page would report, exposed so it can be inspected from the
  // console while chasing a specific driver's report — and asserted by
  // tests/e2e/error-reporting.spec.ts without executing the vendor SDK.
  window.LotLogicErrorReporting = { environment: environment, scrub: scrub, sdkUrl: SDK_URL };

  var s = document.createElement('script');
  s.src = SDK_URL;
  s.integrity = SDK_SRI;
  s.crossOrigin = 'anonymous';
  s.async = true;
  s.onload = function () {
    if (!window.Sentry || typeof window.Sentry.init !== 'function') return;
    try {
      window.Sentry.init({
        dsn: window.SENTRY_DSN,
        environment: environment,
        sendDefaultPii: false,
        // Errors only for now. Performance tracing is a separate decision with
        // a separate bill.
        tracesSampleRate: 0,
        beforeSend: scrub,
      });
    } catch (_) { /* a broken DSN must not break the page */ }
  };
  // An ad blocker, a captive portal or a dead CDN must cost the driver nothing.
  s.onerror = function () {};
  (document.head || document.documentElement).appendChild(s);
})();
