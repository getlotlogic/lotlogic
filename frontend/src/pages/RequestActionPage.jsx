import React, { useCallback, useEffect, useState } from 'react';
import { getRequestAction, postRequestAction } from '../lib/requestsApi.js';
import {
  deriveInitialView, deriveResultView, deriveErrorView,
  previewCopy, actionButtonLabel, bodyText, ctaLabel, ctaAction,
  needsSignIn, signInHref,
} from '../lib/requestAction.js';

// ── `/r/<token>` one-tap email action page (spec §5.8) ───────
//
// Reached from the T-1h "ends soon" email's two buttons (Extend 24 hours /
// OK — it ends at …). The preview echoes the token's own action; when the
// hold has already ended the POST answers 409 `not_active` and the page
// turns that into the §5.8 ended state with "[Hold again for 24 hours]",
// which re-POSTs the same token with `action:'reinstate'`. Works whether or not the tapper has a
// LotLogic session — `App.jsx` renders this from both the signed-out and
// signed-in branches, and has already moved the address bar from
// `/r/<token>` to `/r` (`hideActionToken`); the token lives on only in
// App's state and this component's `token` prop — because the token carries its own authority; no
// property-member login is required to extend, acknowledge, or reinstate
// one specific hold.
//
// All of the state-machine logic (what the token's `action` means, what a
// result or error turns into, the six spec-verbatim copy strings) lives in
// `../lib/requestAction.js` so it can be unit-tested without a DOM
// (scripts/requestAction.test.mjs). This component is just: fetch, derive a
// view, render it, POST on tap.
export function RequestActionPage({ token }) {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [offline, setOffline] = useState(false);
  const [view, setView] = useState({ kind: 'invalid', request: null });

  const load = useCallback(() => {
    if (!token) {
      setView({ kind: 'invalid', request: null });
      setLoading(false);
      return;
    }
    setLoading(true);
    setOffline(false);
    getRequestAction(token)
      .then(preview => setView(deriveInitialView(preview)))
      .catch(() => setView({ kind: 'invalid', request: null }))
      .finally(() => setLoading(false));
  }, [token]);

  useEffect(() => { load(); }, [load]);

  function act(action, fallbackRequest) {
    if (!token || busy) return;
    setBusy(true);
    setOffline(false);
    postRequestAction({ token, action })
      .then(body => setView(deriveResultView(body, fallbackRequest)))
      .catch(err => {
        // No `.status` at all means the fetch itself failed (offline, DNS,
        // CORS) rather than the server answering with an error — that is
        // not "this link is used up," so it gets its own retryable message
        // instead of silently becoming the used/invalid copy.
        if (!err || err.status == null) { setOffline(true); return; }
        setView(deriveErrorView(action, err, fallbackRequest));
      })
      .finally(() => setBusy(false));
  }

  if (loading) {
    return (
      <div className="login-page" role="main">
        <div className="login-box" aria-busy="true" aria-live="polite">
          <p>Loading…</p>
        </div>
      </div>
    );
  }

  const request = view.request;

  // The ordinary preview — one primary button for whichever action this
  // token carries, nothing pressed yet.
  if (view.kind === 'preview') {
    return (
      <div className="login-page" role="main">
        <div className="login-box">
          <p>{previewCopy(request)}</p>
          <button
            type="button"
            className="login-btn"
            disabled={busy}
            aria-busy={busy}
            onClick={() => act(view.action, request)}
          >
            {busy ? 'Working…' : actionButtonLabel(view.action, request)}
          </button>
          {offline && <div className="login-error" role="alert">Can't reach LotLogic — try again.</div>}
        </div>
      </div>
    );
  }

  // Every terminal / edge view: extended, clamped, acknowledged, limit,
  // expired_reinstate, invalid, reinstated. `bodyText` is the spec copy with
  // any trailing "[Button label]" stripped for display; `ctaLabel`/`ctaAction`
  // give the real button for the two views that have one (acknowledged's
  // "[Extend 24 hours instead]", expired_reinstate's "[Hold again for 24
  // hours]") — both re-POST the same token with a different action.
  const label = ctaLabel(view);
  const action = ctaAction(view);

  return (
    <div className="login-page" role="main">
      <div className="login-box">
        <p>{bodyText(view)}</p>
        {label && (
          <button
            type="button"
            className="login-btn"
            disabled={busy}
            aria-busy={busy}
            onClick={() => act(action, request)}
          >
            {busy ? 'Working…' : label}
          </button>
        )}
        {needsSignIn(view) && (
          <div className="login-note" style={{ marginTop: 16, fontSize: 13 }}>
            <a href={signInHref(request)} style={{ color: 'var(--accent)', fontWeight: 700 }}>Sign in</a>
          </div>
        )}
        {offline && <div className="login-error" role="alert">Can't reach LotLogic — try again.</div>}
      </div>
    </div>
  );
}
