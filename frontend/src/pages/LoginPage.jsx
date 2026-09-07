import React, { useState, useEffect, useCallback, useRef, useMemo, memo } from 'react';
import { authLogin, authRequestPasswordReset } from '../lib/api.js';

// ── Login ─────────────────────────────────────────────────────
export function LoginPage({ onLogin }) {
  const [email, setEmail] = useState(() => localStorage.getItem('lotlogic_email') || '');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [resetSent, setResetSent] = useState(false);

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
      </div>
    </div>
  );
}
