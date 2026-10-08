import React, { useEffect, useRef, useState } from 'react';
import { requestsApi } from '../../lib/requestsApi.js';
import { requestErrorMessage } from '../../lib/requestErrors.js';
import { useNowTick } from '../../hooks.js';
import { fmtETClock, fmtETShort, holdRowTime } from '../../lib/holdTime.js';

// ── One request row (spec §5.2) ──────────────────────────────
//
// The row answers three questions in order, top to bottom: what was asked,
// who has it, and what happened. The status line is the only place "Sent to
// N Style ✓" is ever written — never a toast, because a toast is gone before
// the dispatch has actually succeeded.
//
// The photo is fetched through `apiFetch` as a blob: `GET …/{id}/photo` needs
// the Bearer header and an `<img src>` cannot carry one. The object URL is
// revoked on unmount and whenever the request id changes.

const KIND_LABEL = { hold: 'HOLD', tow: 'TOW', photo: 'PHOTO' };
const KIND_GLYPH = { hold: '✋', tow: '🚨', photo: '📷' };

// Spec §5.2: no `sent` delivery 5 minutes after `created` and the row says so.
const UNREACHED_AFTER_MS = 5 * 60 * 1000;

/** True when nothing has reached N Style and enough time has passed to say so. */
export function isUnreached(request, now = Date.now()) {
  if (!request || request.sent_at) return false;
  const created = Date.parse(request.created_at || '');
  if (Number.isNaN(created)) return false;
  return now - created > UNREACHED_AFTER_MS;
}

/** `"2019 Honda Civic · gray"` — only the parts that exist. */
export function vehicleLine(request) {
  const vehicle = [request?.year, request?.make, request?.model].filter(Boolean).join(' ');
  return [vehicle, request?.color].filter(Boolean).join(' · ');
}

/** `"Marcus Webb"` → `"Marcus"`; §5.2's pills name the actor's first name. */
function firstName(display) {
  return String(display || '').trim().split(/\s+/)[0] || '';
}

/**
 * The outcome, in words, for a finished request (§5.2's Recent pills).
 *
 * `property_rejected` is tested **first**: it is a `resolution_note`, and the
 * backend may well set it alongside `resolution='declined'`, in which case
 * falling through to the `declined` case would render the raw code §3.8
 * forbids — `Declined — "property_rejected"`.
 *
 * @param {object} request
 * @param {string} [viewerName] the signed-in account's display name, so
 *   "Removed by you" is said only when the caller is in fact the actor.
 */
export function outcomeWords(request, viewerName) {
  const who = request?.resolved_by_display || '';
  if (request?.resolution_note === 'property_rejected') return 'Property not confirmed by N Style';
  switch (request?.resolution) {
    case 'expired': return 'Expired';
    case 'property_removed': {
      if (!who) return 'Removed';
      const mine = viewerName && who.trim().toLowerCase() === String(viewerName).trim().toLowerCase();
      return mine ? 'Removed by you' : `Removed by ${firstName(who)}`;
    }
    case 'towed': return 'Towed';
    case 'photographed': return 'Photo sent';
    case 'declined':
      return request.resolution_note
        ? `Declined — "${request.resolution_note}"`
        : 'Declined';
    default:
      if (request?.status === 'declined') {
        return request.resolution_note ? `Declined — "${request.resolution_note}"` : 'Declined';
      }
      return request?.status ? String(request.status) : '';
  }
}

/** The §4.2 lineage suffix: "H-1850 (replaces H-1842)". */
export function refWithLineage(request) {
  const ref = request?.ref || '';
  const from = request?.reinstated_from_ref;
  return from ? `${ref} (replaces ${from})` : ref;
}

export function RequestRow({
  request,
  canAct = false,
  canFulfill = false,
  viewerName = '',
  flagged = false,
  openUpload = false,
  onExtend,
  onRemove,
  onHistory,
  onReinstate,
  onPhotoSent,
  addToast,
  recent = false,
}) {
  const nowTick = useNowTick(30000);
  const [photoUrl, setPhotoUrl] = useState(null);
  const [uploadOpen, setUploadOpen] = useState(openUpload);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const rowRef = useRef(null);
  const fileRef = useRef(null);

  // The deep link `/app?property=…&request=<id>&upload=1` (§6.5's [Photo sent]
  // button) lands with the row already expanded; move the viewport and the
  // keyboard to the file input once, on mount.
  useEffect(() => {
    if (!openUpload) return;
    setUploadOpen(true);
    const t = setTimeout(() => {
      try { rowRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch { /* older Safari */ }
      try { fileRef.current?.focus({ preventScroll: true }); } catch { /* iOS ignores it without a gesture */ }
    }, 0);
    return () => clearTimeout(t);
  }, [openUpload]);

  useEffect(() => {
    if (!request?.has_photo || !request?.id) { setPhotoUrl(null); return undefined; }
    let url = null;
    let alive = true;
    requestsApi.fetchRequestPhoto(request.id)
      .then(blob => {
        if (!alive) return;
        url = URL.createObjectURL(blob);
        setPhotoUrl(url);
      })
      .catch(() => { /* the row reads fine without it */ });
    return () => {
      alive = false;
      setPhotoUrl(null);
      if (url) URL.revokeObjectURL(url);
    };
  }, [request?.id, request?.has_photo]);

  if (!request) return null;

  const kind = request.kind || 'hold';
  const isHold = kind === 'hold';
  const active = request.status === 'active';
  // Only an active hold gets a countdown. A removed or expired one still has
  // an `expires_at`, and rendering "22h left" against it would be a lie — the
  // outcome pill is what that row is for.
  const time = (isHold && active)
    ? holdRowTime(request.expires_at, new Date(nowTick), request.expires_local)
    : null;
  const unreached = active && isUnreached(request, nowTick);
  const vehicle = vehicleLine(request);
  const by = request.created_by?.name || '';

  async function sendPhoto(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploadError('');
    if (file.size > 10 * 1024 * 1024) { setUploadError('That photo is over 10 MB. Try a smaller one.'); return; }
    setUploading(true);
    try {
      const up = await requestsApi.uploadPhoto(file, request.property_id);
      await requestsApi.fulfillRequest(request.id, {
        resolution: 'photographed',
        photo_key: up?.photo_key,
      });
      addToast?.('Photo sent', 'success');
      onPhotoSent?.(request.id);
      setUploadOpen(false);
    } catch (err) {
      // §5.2's "the hold still works" belongs to the composer's optional
      // photo; a photo request has no hold to still work.
      setUploadError(requestErrorMessage(err, "Couldn't send the photo. Try again."));
    } finally {
      setUploading(false);
    }
  }

  // The status line, in the §5.2 order: delivery → seen → checked. Each part
  // carries a word, so none of them is colour-only.
  const statusParts = [];
  if (unreached) statusParts.push("⚠ Couldn't reach N Style");
  else if (request.sent_at) statusParts.push('Sent to N Style ✓');
  else if (active) statusParts.push('Sending…');
  if (request.partner_ack_at) {
    const who = request.partner_ack_by_display || 'N Style';
    const at = fmtETClock(request.partner_ack_at);
    statusParts.push(at ? `Seen by ${who} ${at}` : `Seen by ${who}`);
  }
  if (request.checked_count > 0) statusParts.push(`Checked by N Style ${request.checked_count}×`);

  return (
    <div
      ref={rowRef}
      className={`req-card${flagged ? ' req-flag' : ''}${recent ? ' req-recent-row' : ''}`}
      data-request-id={request.id}
    >
      <div className="req-row-head">
        <span className="req-kind">{KIND_GLYPH[kind]} {KIND_LABEL[kind] || kind}</span>
        <span className="req-plate">{request.plate}</span>
        <span className="req-ref">{refWithLineage(request)}</span>
      </div>

      {time && (time.until || time.tail) && (
        <div className={`req-when${time.urgent ? ' urgent' : ''}`}>
          {time.until}{time.tail ? <> · <span className="req-tail">{time.tail}</span></> : null}
        </div>
      )}

      {(vehicle || request.note) && (
        <div className="req-meta">
          {vehicle}
          {vehicle && request.note ? ' · ' : ''}
          {request.note ? `"${request.note}"` : ''}
        </div>
      )}

      {(by || request.created_at) && (
        <div className="req-meta">
          {[by, fmtETShort(request.created_at)].filter(Boolean).join(' · ')}
        </div>
      )}

      {photoUrl && (
        <img className="req-thumb" style={{ marginTop: 8 }} src={photoUrl}
          alt={`Photo of ${request.plate}`} />
      )}

      {statusParts.length > 0 && (
        <div className={`req-status${unreached ? ' req-unreached' : ''}`}>
          {statusParts.join(' · ')}
        </div>
      )}

      {!active && <div className="req-pill">{outcomeWords(request, viewerName)}</div>}

      {/* The §6.5 [Photo sent] surface: upload a photo against this request.
          Only on an open photo request — a hold has nothing to fulfil — and
          only for the partner, because §8.3 scopes `/fulfill` to
          "partner / Slack" and the office would be shown a 404. */}
      {canFulfill && active && kind === 'photo' && (
        <div style={{ marginTop: 8 }}>
          <button type="button" className="req-link" aria-expanded={uploadOpen}
            aria-controls={`req-upload-${request.id}`} onClick={() => setUploadOpen(v => !v)}>
            {uploadOpen ? '− Add the photo' : '+ Add the photo'}
          </button>
          {uploadOpen && (
            <div id={`req-upload-${request.id}`} style={{ marginTop: 6 }}>
              <input
                ref={fileRef}
                type="file"
                className="req-input"
                accept="image/jpeg,image/png,image/webp,image/*"
                aria-label={`Add the photo for ${request.plate}`}
                disabled={uploading}
                onChange={sendPhoto}
              />
              {uploading && <div className="req-progress" role="progressbar" aria-label="Sending the photo" />}
              {uploadError && <div className="req-error">{uploadError}</div>}
            </div>
          )}
        </div>
      )}

      <div className="req-btn-row">
        {canAct && active && isHold && (
          /* §4.3: the 409 scrolls this row in "with Extend highlighted" —
             the button itself, not just the card. */
          <button type="button" className={`req-btn${flagged ? ' req-btn-flag' : ''}`}
            onClick={() => onExtend?.(request)}>Extend</button>
        )}
        {canAct && active && (
          <button type="button" className="req-btn" onClick={() => onRemove?.(request)}>Remove</button>
        )}
        {canAct && !active && isHold && onReinstate && (
          <button type="button" className="req-btn" onClick={() => onReinstate(request)}>Reinstate</button>
        )}
        <button type="button" className="req-link" onClick={() => onHistory?.(request)}>History</button>
      </div>
    </div>
  );
}
