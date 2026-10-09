import React, { useState, useEffect } from 'react';
import { authLogin, authRequestPasswordReset } from '../lib/api.js';
import { RETURN_TO_KEY, returnToTarget } from '../lib/deepLink.js';

// ── Login ─────────────────────────────────────────────────────
export function LoginPage({ onLogin }) {
  const [email, setEmail] = useState(() => localStorage.getItem('lotlogic_email') || '');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [resetSent, setResetSent] = useState(false);

  // Keep the query across sign-in. Every portal email button points at
  // `/app?property=…&request=…`; a signed-out tap used to land on Lots with
  // the query gone, because `login()` re-renders the dashboard over whatever
  // was in the address bar. Park the location here on mount, and replay it
  // after `onLogin` — only `/app` locations, so nothing else can be planted
  // in sessionStorage and replayed.
  useEffect(() => {
    try {
      sessionStorage.setItem(RETURN_TO_KEY, window.location.pathname + window.location.search);
    } catch { /* private mode / blocked storage — the query is simply lost */ }
  }, []);

  function replayReturnTo() {
    let stored = null;
    try {
      stored = sessionStorage.getItem(RETURN_TO_KEY);
      sessionStorage.removeItem(RETURN_TO_KEY);
    } catch { return; }
    const target = returnToTarget(stored);
    if (!target) return;
    try { window.history.replaceState(null, '', target); } catch { /* ignore */ }
  }

  async function submit(e) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed || !password) return;
    setLoading(true); setError(''); setResetSent(false);
    try {
      const res = await authLogin(trimmed, password);
      localStorage.setItem('lotlogic_email', trimmed);
      const base = res.subject || {};
      const role = base.type === 'partner' ? 'partner' : 'owner';
      onLogin({
        id: base.id,
        email: base.email || trimmed,
        business_name: base.display_name,
        company_name: role === 'partner' ? base.display_name : undefined,
        // Surface admin flags into the session at login time so the dashboard
        // doesn't have to wait for the /auth/me self-heal to fire (which
        // races against the first loadData call). Backend /auth/login
        // returns these on the subject for owner accounts; partners always
        // false.
        is_admin: !!base.is_admin,
        is_platform_admin: !!base.is_platform_admin,
        _role: role,
        _token: res.token,
        _expires_in: res.expires_in,
      });
      replayReturnTo();
    } catch (err) {
      if (err.status === 401) setError('Invalid email or password.');
      else if (err.status === 403) setError(err.message || 'Password not set. Use "Email me a setup link" below.');
      else setError(err.message || "Can't connect right now. Check your connection and try again.");
    } finally { setLoading(false); }
  }

  async function sendResetLink() {
    const trimmed = email.trim();
    if (!trimmed) { setError('Enter your email first.'); return; }
    setError('');
    try {
      await authRequestPasswordReset(trimmed);
      setResetSent(true);
    } catch {
      // Endpoint is intentionally non-revealing — show the same success message.
      setResetSent(true);
    }
  }

  return (
    <div className="login-page" role="main">
      <div className="login-box">
        <div className="login-logo" aria-hidden="true">
          <div className="login-shield">LL</div>
          <div className="login-wordmark">Lot<span>Logic</span></div>
        </div>
        <div className="login-tagline">AI-powered parking enforcement — sign in to get started</div>
        <form onSubmit={submit} aria-label="Sign in">
          <label className="field-label" htmlFor="login-email">Your email</label>
          <input
            id="login-email"
            className="field-input"
            type="email"
            placeholder="you@company.com"
            value={email}
            onChange={e => setEmail(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            required
            autoFocus
            autoComplete="username"
            aria-required="true"
          />
          <label className="field-label" htmlFor="login-password" style={{marginTop:12}}>Password</label>
          <input
            id="login-password"
            className="field-input"
            type="password"
            placeholder="••••••••"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            autoComplete="current-password"
            aria-required="true"
          />
          <button className="login-btn" type="submit" disabled={loading || !email || !password} aria-busy={loading}>
            {loading ? 'Signing in…' : 'Sign In →'}
          </button>
        </form>
        {error && <div className="login-error" role="alert">{error}</div>}
        {resetSent && (
          <div className="login-note" role="status" style={{marginTop:12,fontSize:13,color:'var(--text-muted)'}}>
            If an account exists for that email, we've sent a setup link. Check your inbox.
          </div>
        )}
        <button
          type="button"
          onClick={sendResetLink}
          style={{background:'none',border:0,color:'var(--text-muted)',fontSize:13,marginTop:12,cursor:'pointer',textDecoration:'underline'}}
        >
          Forgot password? Email me a setup link.
        </button>
        <div className="login-note" style={{marginTop:16,fontSize:13,color:'var(--text-muted)'}}>
          New property? <a href="/join" style={{color:'var(--accent)',fontWeight:700}}>Create your account</a>
        </div>
      </div>
    </div>
  );
}
