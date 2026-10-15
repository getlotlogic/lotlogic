import React, { useCallback, useRef, useState } from 'react';
import { Sheet } from '../../ui/Sheet.jsx';
import { useUid } from '../../ui/focusTrap.js';
import { apiFetch } from '../../lib/api.js';
import { fmtET } from '../../lib/holdTime.js';
import {
  DENY_REASONS,
  OTHER_MAX,
  TOW_NOTE,
  actionError,
  actionPath,
  decisionEmailLine,
  denyReasonText,
  parseExtendHours,
  plateText,
} from '../../lib/permitsQueue.js';
import { PassSummary } from './parts.jsx';

// ── The queue's three sheets: Deny, Void, Extend ─────────────
//
// Each owns its own form state, posts to the existing route, and reports back
// with `onDone(serverRow, extra)`. A 404/409 means the row changed under the
// manager, so the sheet closes and the page refreshes (`onStale`). Everything
// else stays in the sheet as an inline error with the values kept.
//
// The sheet's close handler is held stable here whatever the parent passes:
// `useFocusTrap` re-runs (and re-focuses the first control) whenever its
// `onClose` changes, and the page re-renders every 30 s for the age chips.

function useStableClose(onClose, busyRef) {
  const latest = useRef(onClose);
  latest.current = onClose;
  return useCallback(() => { if (!busyRef.current) latest.current(); }, [busyRef]);
}

const JSON_POST = { method: 'POST', headers: { 'content-type': 'application/json' } };

function Spinner() {
  return <span className="pq-spin" aria-hidden="true" />;
}

export function DenySheet({ row, propertyName, cap, towNote, initialReason, onClose, onDone, onStale }) {
  const [reasonId, setReasonId] = useState(initialReason || '');
  const [other, setOther] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const busy = useRef(false);
  const close = useStableClose(onClose, busy);
  const groupName = useUid('pq-reason');
  const otherId = useUid('pq-other');
  const hintId = useUid('pq-deny-hint');

  const text = denyReasonText(reasonId, other, { cap });
  const hasEmail = !!String(row.email || '').trim();
  const plate = plateText(row);

  async function submit(e) {
    e.preventDefault();
    if (!text || busy.current) return;
    busy.current = true;
    setSending(true);
    setError('');
    try {
      const out = await apiFetch(actionPath(row, 'reject'), { ...JSON_POST, body: JSON.stringify({ reason: text }) });
      busy.current = false;
      onDone(out, { reason: text, notified: hasEmail });
    } catch (err) {
      busy.current = false;
      setSending(false);
      const failure = actionError(err, 'deny');
      if (failure.refresh) onStale(failure.text);
      else setError(failure.text);
    }
  }

  return (
    <Sheet title="Deny this request?" onClose={close}>
      <PassSummary row={row} />
      <form onSubmit={submit} noValidate>
        <fieldset className="pq-reasons">
          <legend className="pq-label">Reason</legend>
          {DENY_REASONS.map(reason => (
            <label key={reason.id} className="pq-reason">
              <input
                type="radio"
                name={groupName}
                value={reason.id}
                checked={reasonId === reason.id}
                onChange={() => setReasonId(reason.id)}
              />
              <span>{reason.label}</span>
            </label>
          ))}
        </fieldset>

        {reasonId === 'other' && (
          <div className="pq-field">
            <label htmlFor={otherId} className="pq-label">The reason they will read</label>
            <textarea
              id={otherId}
              className="req-textarea"
              rows={3}
              maxLength={OTHER_MAX}
              value={other}
              onChange={e => setOther(e.target.value)}
              aria-describedby={!text ? hintId : undefined}
            />
          </div>
        )}

        <div className="pq-preview">
          <div className="pq-preview-label">What they will receive</div>
          {!hasEmail ? (
            <p className="pq-preview-quiet">There's no email address on this request, so no message will be sent.</p>
          ) : text ? (
            <>
              <p className="pq-preview-text">{decisionEmailLine({ propertyName, reason: text })}</p>
              {towNote && <p className="pq-preview-text">{TOW_NOTE}</p>}
            </>
          ) : (
            <p className="pq-preview-quiet">Choose a reason to see the message.</p>
          )}
        </div>

        <div className="pq-sheet-actions">
          {error && <p className="req-error" role="alert">{error}</p>}
          <button
            type="submit"
            className="pq-btn pq-btn--danger"
            disabled={!text}
            aria-describedby={!text ? hintId : undefined}
          >
            {sending ? <><Spinner />Denying…</> : hasEmail ? 'Deny and notify' : 'Deny'}
          </button>
          <button type="button" className="pq-btn pq-btn--quiet" onClick={close}>Cancel</button>
          {!text && (
            <p id={hintId} className="pq-hint">
              {reasonId === 'other' ? 'Write at least 2 characters.' : 'Choose a reason first.'}
            </p>
          )}
        </div>
        <span className="pq-sr" aria-live="polite">{sending ? `Denying ${plate}` : ''}</span>
      </form>
    </Sheet>
  );
}

export function VoidSheet({ row, propertyName, onClose, onDone, onStale }) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const busy = useRef(false);
  const close = useStableClose(onClose, busy);
  const plate = plateText(row);

  async function voidNow() {
    if (busy.current) return;
    busy.current = true;
    setSending(true);
    setError('');
    try {
      const out = await apiFetch(actionPath(row, 'void'), { method: 'POST' });
      busy.current = false;
      onDone(out);
    } catch (err) {
      busy.current = false;
      setSending(false);
      const failure = actionError(err, 'void this parking pass');
      if (failure.refresh) onStale(failure.text);
      else setError(failure.text);
    }
  }

  return (
    <Sheet title="Void this parking pass?" onClose={close}>
      <PassSummary row={row} />
      <p className="pq-sheet-copy">
        {plate || 'This vehicle'} will no longer have a parking pass at {propertyName || 'this property'}. This can't be undone.
      </p>
      <div className="pq-sheet-actions">
        {error && <p className="req-error" role="alert">{error}</p>}
        <button type="button" className="pq-btn pq-btn--danger" onClick={voidNow}>
          {sending ? <><Spinner />Voiding…</> : 'Void pass'}
        </button>
        <button type="button" className="pq-btn pq-btn--quiet" onClick={close}>Keep pass</button>
      </div>
    </Sheet>
  );
}

export function ExtendPassSheet({ row, onClose, onDone, onStale }) {
  const [raw, setRaw] = useState('24');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const busy = useRef(false);
  const close = useStableClose(onClose, busy);
  const inputId = useUid('pq-hours');
  const hintId = useUid('pq-hours-hint');
  const ends = fmtET(row.valid_until);

  async function submit(e) {
    e.preventDefault();
    if (busy.current) return;
    const hours = parseExtendHours(raw);
    if (hours == null) { setError('Enter a whole number of hours between 1 and 72.'); return; }
    busy.current = true;
    setSending(true);
    setError('');
    try {
      const out = await apiFetch(actionPath(row, 'extend'), { ...JSON_POST, body: JSON.stringify({ hours }) });
      busy.current = false;
      onDone(out, { hours });
    } catch (err) {
      busy.current = false;
      setSending(false);
      const failure = actionError(err, 'extend this parking pass');
      if (failure.refresh) onStale(failure.text);
      else setError(failure.text);
    }
  }

  return (
    <Sheet title="Extend this parking pass?" onClose={close}>
      <PassSummary row={row} />
      {ends && <p className="pq-sheet-copy">Ends {ends}</p>}
      <form onSubmit={submit} noValidate>
        <div className="pq-field">
          <label htmlFor={inputId} className="pq-label">Extend by (hours)</label>
          <input
            id={inputId}
            className="req-input pq-hours"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={raw}
            onChange={e => setRaw(e.target.value)}
            aria-describedby={hintId}
            aria-invalid={error ? 'true' : undefined}
          />
          <p id={hintId} className="pq-hint">1 to 72 hours, added to the current end time.</p>
        </div>
        <div className="pq-sheet-actions">
          {error && <p className="req-error" role="alert">{error}</p>}
          <button type="submit" className="pq-btn pq-btn--primary">
            {sending ? <><Spinner />Extending…</> : 'Extend'}
          </button>
          <button type="button" className="pq-btn pq-btn--quiet" onClick={close}>Cancel</button>
        </div>
      </form>
    </Sheet>
  );
}
