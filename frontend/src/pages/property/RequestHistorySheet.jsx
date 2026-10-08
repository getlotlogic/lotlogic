import React, { useEffect, useState } from 'react';
import { Sheet } from '../../ui/Sheet.jsx';
import { SkeletonCards } from '../../ui/Skeletons.jsx';
import { requestsApi } from '../../lib/requestsApi.js';
import { requestErrorMessage } from '../../lib/requestErrors.js';
import { fmtET, fmtETStamp } from '../../lib/holdTime.js';
import { outcomeWords, refWithLineage, vehicleLine } from './RequestRow.jsx';

// ── History (spec §5.3) ──────────────────────────────────────
//
// One tap away, never in the way. `GET /apartment/requests/{id}` returns the
// request plus its `tow_request_events` and `tow_request_deliveries`; this
// sheet merges the two into one chronological list, because what a manager
// wants to know — "did it reach them, and when did they look at it" — is split
// across both tables.
//
// Everything is rendered from what the server sent. No state is inferred here:
// if an event type arrives that this file has no sentence for, it is shown with
// its own name rather than silently dropped.

const PHOTO_ALT_PREFIX = 'Photo of ';

/** The sentence for one `tow_request_events` row. */
export function eventSentence(ev) {
  const d = ev?.detail || {};
  const who = ev?.actor_display || d.actor_display || '';
  const role = d.position ? ` (${d.position})` : '';
  const surface = d.surface || ev?.surface || '';
  switch (ev?.event) {
    case 'created':
      return [`Placed by ${who || 'the office'}${role}`, surface].filter(Boolean).join(' · ');
    case 'notified':
      return 'Sent to N Style';
    case 'acked':
      return `Seen by ${who || 'N Style'}${d.partner ? ' (N Style)' : ''}`;
    case 'checked': {
      const via = surface ? ` via ${surface}` : '';
      const verdict = d.verdict ? ` · answer shown: ${String(d.verdict).toUpperCase().replace(/_/g, ' ')}` : '';
      return `Checked by N Style${via}${verdict}`;
    }
    case 'extended': {
      const to = d.to ? fmtET(d.to) : '';
      const n = d.n ? ` · ${d.n} of 4` : '';
      return `Extended${to ? ` to ${to}` : ''}${who ? ` by ${who}` : ''}${n}`;
    }
    case 'removed':
      return `Removed${who ? ` by ${who}` : ''}${d.note ? ` — "${d.note}"` : ''}`;
    case 'expired':
      return 'Hold ended · plate is eligible';
    case 'fulfilled':
      return d.resolution === 'photographed'
        ? `Photo sent${who ? ` by ${who}` : ''}`
        : `Towed${who ? ` by ${who}` : ''}`;
    case 'declined':
      return `Declined${d.reason ? ` — "${d.reason}"` : ''}${who ? ` by ${who}` : ''}`;
    case 'reinstated':
      return `Reinstated as ${d.ref || d.to_ref || 'a new request'}`;
    default:
      return ev?.event ? String(ev.event) : '';
  }
}

/** The sentence for one `tow_request_deliveries` row. */
export function deliverySentence(dv) {
  const ok = dv?.status === 'sent';
  const mark = ok ? ' ✓' : dv?.status === 'failed' ? ' — not delivered' : '';
  switch (dv?.channel) {
    case 'email': return `Emailed ${dv.target || 'N Style'}${mark}`;
    case 'slack': return `Posted to N Style Slack${mark}`;
    case 'sms': return `Texted ${dv.target || 'N Style'}${mark}`;
    default: return `Sent to N Style${mark}`;
  }
}

/**
 * Events and deliveries interleaved oldest-first, each already a sentence.
 *
 * The `notified` event and the `tow_request_deliveries` rows it produced are
 * the same fact recorded twice, so when any delivery is present the event is
 * dropped: the delivery rows say which channel and whether it landed, which
 * is strictly more than "Sent to N Style" and is what a manager chasing a
 * request came to read.
 */
export function timeline(events, deliveries) {
  const rows = [];
  const deliveryRows = Array.isArray(deliveries) ? deliveries : [];
  const haveDeliveries = deliveryRows.length > 0;
  for (const ev of Array.isArray(events) ? events : []) {
    if (haveDeliveries && ev?.event === 'notified') continue;
    rows.push({ at: ev?.created_at, text: eventSentence(ev), key: `e-${ev?.id ?? rows.length}` });
  }
  for (const dv of deliveryRows) {
    rows.push({
      at: dv?.sent_at || dv?.created_at,
      text: deliverySentence(dv),
      key: `d-${dv?.id ?? rows.length}`,
    });
  }
  return rows
    .filter(r => r.text)
    .sort((a, b) => {
      const ta = Date.parse(a.at || '') || 0;
      const tb = Date.parse(b.at || '') || 0;
      return ta - tb;
    });
}

export function RequestHistorySheet({ requestId, onClose, canAct, viewerName, onExtend, onRemove, addToast }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [photoUrl, setPhotoUrl] = useState(null);

  useEffect(() => {
    if (!requestId) return undefined;
    let alive = true;
    setData(null);
    setError('');
    requestsApi.getRequest(requestId)
      .then(out => { if (alive) setData(out); })
      .catch(err => { if (alive) setError(requestErrorMessage(err, 'Could not load this request.')); });
    return () => { alive = false; };
  }, [requestId]);

  const request = data?.request || null;

  useEffect(() => {
    if (!request?.has_photo || !request?.id) { setPhotoUrl(null); return undefined; }
    let url = null;
    let alive = true;
    requestsApi.fetchRequestPhoto(request.id)
      .then(blob => { if (alive) { url = URL.createObjectURL(blob); setPhotoUrl(url); } })
      .catch(() => { /* the sheet reads fine without it */ });
    return () => { alive = false; setPhotoUrl(null); if (url) URL.revokeObjectURL(url); };
  }, [request?.id, request?.has_photo]);

  const kindLabel = request ? String(request.kind || '').toUpperCase() : '';
  const title = request
    ? `${refWithLineage(request)} · ${kindLabel} · ${request.plate}`
    : 'History';

  const rows = request ? timeline(data?.events, data?.deliveries) : [];
  const vehicle = request ? vehicleLine(request) : '';
  const until = request?.expires_local || fmtET(request?.expires_at);

  return (
    <Sheet title={title} onClose={onClose}>
      {error && (
        <div className="req-error" role="status">{error}</div>
      )}
      {!request && !error && <SkeletonCards count={2} />}
      {request && (
        <>
          {request.kind === 'hold' && until && (
            <div className="req-when">Do not tow until {until}</div>
          )}
          {vehicle && <div className="req-meta">{vehicle}</div>}
          {photoUrl && (
            <img className="req-thumb" style={{ marginTop: 8 }} src={photoUrl}
              alt={`${PHOTO_ALT_PREFIX}${request.plate}`} />
          )}
          {request.note && <div className="req-meta">"{request.note}"</div>}
          {request.status !== 'active' && <div className="req-pill">{outcomeWords(request, viewerName)}</div>}

          <div className="req-section-title">History</div>
          <ul className="req-events">
            {rows.map(r => (
              <li key={r.key}>
                <span className="req-event-when">{fmtETStamp(r.at)}</span>{r.at ? '  ' : ''}{r.text}
              </li>
            ))}
            {rows.length === 0 && <li>Nothing has happened yet.</li>}
          </ul>

          {canAct && request.status === 'active' && (
            <div className="req-btn-row">
              {request.kind === 'hold' && (
                <button type="button" className="req-btn"
                  onClick={() => { onClose?.(); onExtend?.(request); }}>Extend</button>
              )}
              <button type="button" className="req-btn"
                onClick={() => { onClose?.(); onRemove?.(request); }}>Remove</button>
            </div>
          )}
        </>
      )}
    </Sheet>
  );
}
