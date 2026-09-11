import React from 'react';

// ── Error boundary ────────────────────────────────────────────
// Catches render / lifecycle throws in a subtree so a malformed record
// (e.g. tow_confirmation.delta_seconds === NaN) can't take the whole
// dashboard down. React 18 still supports class-component boundaries —
// there is no hook equivalent for componentDidCatch.
//
// Fallback UI: "Something went wrong loading this view" with the error
// message tucked into a <details> for devs / support. A Reload tab
// button resets the boundary's state so transient errors recover
// without a full page reload.
export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.handleReset = this.handleReset.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Surface enough context for after-the-fact debugging without leaking
    // user data. Uses console.error (not the ungated logger) so the dev
    // console stays clean in normal operation.
    if (typeof window !== 'undefined' && window.console && window.console.error) {
      window.console.error('[ErrorBoundary:' + (this.props.label || 'unknown') + ']', error, info);
    }
  }

  handleReset() {
    this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const label = this.props.label || 'this view';
    const message = (error && (error.message || String(error))) || 'Unknown error';
    return (
      React.createElement('div', {
        role: 'alert',
        style: {
          margin: 16,
          padding: 16,
          background: 'rgba(239,68,68,.08)',
          border: '1px solid rgba(239,68,68,.3)',
          borderRadius: 10,
          color: 'var(--text-primary)',
        },
      },
        React.createElement('div', {
          style: { fontSize: 14, fontWeight: 800, color: '#ef4444', marginBottom: 6 },
        }, 'Something went wrong loading ' + label + '.'),
        React.createElement('div', {
          style: { fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 },
        }, 'Try reloading. If it keeps happening, please report the details below.'),
        React.createElement('div', { style: { display: 'flex', gap: 8, marginBottom: 10 } },
          React.createElement('button', {
            onClick: this.handleReset,
            style: {
              fontSize: 12, fontWeight: 700, padding: '6px 12px', borderRadius: 6,
              border: '1px solid var(--accent)', background: 'var(--accent)', color: '#fff', cursor: 'pointer',
            },
          }, 'Reload tab'),
        ),
        React.createElement('details', null,
          React.createElement('summary', {
            style: { fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' },
          }, 'Error details'),
          React.createElement('pre', {
            style: {
              fontSize: 11, color: 'var(--text-muted)', marginTop: 6,
              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              background: 'var(--bg-inset)', padding: 8, borderRadius: 6,
              border: '1px solid var(--border)',
            },
          }, message),
        ),
      )
    );
  }
}
