import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmActionModal } from '../ui/Dialog.jsx';
import { useFocusTrap, useUid } from '../ui/focusTrap.js';
import { SkeletonCards } from '../ui/Skeletons.jsx';
import { useToast } from '../ui/Toast.jsx';
import {
  ackRequest,
  declineRequest,
  fetchRequestPhoto,
  fulfillRequest,
  getRequest,
  listPartnerProperties,
  listRequests,
  rejectPartnerProperty,
  uploadPhoto,
  verifyPartnerProperty,
} from '../lib/requestsApi.js';
import {
  badgeCount,
  chipsFor,
  countActionable,
  emptyStateKind,
  filterItems,
  fmtTimeET,
  groupAndSort,
  normalizePendingProperty,
} from '../lib/partnerRequests.js';
import { PartnerRequestRow } from './partner/PartnerRequestRow.jsx';
import { PendingPropertyCard } from './partner/PendingPropertyCard.jsx';

// ── Partner Requests tab (spec §5.4) ──────────────────────────
//
// The whole of N Style's inbox on one screen: the properties waiting to be
// confirmed (sticky, because nobody else can answer them), then every active
// request across their properties, grouped by property, soonest deadline
// first, tows and photo requests above holds.
//
// Three rules worth naming:
//   * `/apartment/requests?view=active` already excludes archived and rejected
//     properties server-side — the same filter feeds the badge — so this page
//     never re-derives who is in scope;
//   * no deadline is computed here. A hold's line is the server's
//     `expires_local` string, so a phone in another timezone and the tow truck
//     read the same sentence;
//   * a photo request is fulfilled only with a photo attached. The confirm
//     button is never `disabled` — it reads "Add the photo" until one is
//     picked, so a tap always explains itself (422 `photo_required` is
//     unreachable from here).

const ACTIVE_LIMIT = 200;

const PAGE_PAD = { padding: '0 2px 24px' };

// Every sentence this tab shows, spec §5.4 verbatim, in one block so the copy
// test can hold it to the spec character for character and nothing reflows it.
const COPY = {
  emptyTitle: 'Nothing active.',
  emptyBody: "Holds and tow requests from your properties show up here the moment an office posts them — and in Slack if you've connected it.",
  // §5.4 gives no empty-state copy for the Recent chip, and its sentence
  // above is about the active list — "Nothing active." under a 7-day history
  // reads as "nothing is live", which is a different claim. These two lines
  // are this task's own words; the report says so.
  emptyRecentTitle: 'Nothing in the last 7 days.',
  emptyRecentBody: 'Requests your crew has finished, declined or let expire show up here for a week.',
  loadFailed: "Couldn't load requests. Your last list is still shown.",
  declineTitle: 'Decline this request',
  declineBody: 'The office will see your reason. The plate becomes eligible to tow.',
  declinePlaceholder: "Tell the office why (they'll see this)",
  declineConfirm: 'Decline request',
  rejectTitle: 'Not your property',
  rejectBody: "Their requests will stop showing to your crew and we'll let the person who signed up know.",
  rejectConfirm: 'Not ours',
  rejectPlaceholder: 'Tell us why (required)',
};

export function PartnerRequestsPage({ pendingJoins = 0, propertyNames, onBadgeChange }) {
  const { addToast } = useToast();
  const [items, setItems] = useState([]);
  const [recent, setRecent] = useState([]);
  const [pending, setPending] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [chip, setChip] = useState('all');
  const [busyId, setBusyId] = useState(null);
  const [modal, setModal] = useState(null);
  const [history, setHistory] = useState(null);
  const [photo, setPhoto] = useState(null);
  // `Date.now()` snapshot the countdown labels render against. Ticked once a
  // minute so "48 min left" does not go stale while Austin reads the screen.
  const [now, setNow] = useState(() => Date.now());
  const mounted = useRef(true);

  useEffect(() => () => { mounted.current = false; }, []);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const load = useCallback(async ({ quiet } = {}) => {
    if (!quiet) setLoading(true);
    try {
      const [active, pendingProps] = await Promise.all([
        listRequests({ view: 'active', limit: ACTIVE_LIMIT }),
        // A backend without Task 15's router answers 404 — the tab still works
        // as a request list, it just cannot offer the confirm cards.
        listPartnerProperties({ verification_status: 'pending' }).catch(() => null),
      ]);
      if (!mounted.current) return;
      setItems(Array.isArray(active?.items) ? active.items : []);
      setPending(
        (Array.isArray(pendingProps?.items) ? pendingProps.items : (Array.isArray(pendingProps) ? pendingProps : []))
          .map(normalizePendingProperty)
          .filter(Boolean),
      );
      setLoadError(null);
    } catch (err) {
      if (mounted.current) setLoadError(err);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Recent (7 days) is a second view, fetched only when the chip asks for it.
  useEffect(() => {
    if (chip !== 'recent') return;
    let cancelled = false;
    listRequests({ view: 'recent', limit: ACTIVE_LIMIT })
      .then(res => { if (!cancelled) setRecent(Array.isArray(res?.items) ? res.items : []); })
      .catch(() => { /* the chip falls back to an empty list; the active view is untouched */ });
    return () => { cancelled = true; };
  }, [chip]);

  const chips = useMemo(() => chipsFor(items), [items]);
  const shown = chip === 'recent' ? recent : filterItems(items, chip);
  const groups = useMemo(() => groupAndSort(shown, propertyNames), [shown, propertyNames]);
  const toDo = badgeCount({ ...countActionable(items), pendingProps: pending.length, pendingJoins });
  // The Recent chip is a second view, so it gets its own empty state — the
  // spec's "Nothing active." sentence is a claim about the active list.
  const empty = emptyStateKind(chip) === 'recent'
    ? { title: COPY.emptyRecentTitle, body: COPY.emptyRecentBody }
    : { title: COPY.emptyTitle, body: COPY.emptyBody };

  // Every write ends the same way: tell App the badge moved, then re-read the
  // list rather than patching a row by hand — the server owns the state
  // machine, and a quiet refetch is cheaper than a wrong optimistic row.
  const afterWrite = useCallback(async (message) => {
    if (message) addToast(message, 'success');
    if (onBadgeChange) onBadgeChange();
    await load({ quiet: true });
  }, [addToast, load, onBadgeChange]);

  const failed = useCallback((err) => {
    addToast(err?.message || 'That did not go through — try again.', 'error');
  }, [addToast]);

  const runAction = useCallback(async (id, fn, message) => {
    setBusyId(id);
    try {
      await fn();
      await afterWrite(message);
    } catch (err) {
      failed(err);
    } finally {
      if (mounted.current) setBusyId(null);
    }
  }, [afterWrite, failed]);

  const onRowAction = useCallback((action, item) => {
    if (action === 'ack') {
      runAction(item.id, () => ackRequest(item.id), `Seen ${fmtTimeET(new Date().toISOString())} — ${item.ref}.`);
      return;
    }
    if (action === 'photo') { setPhoto(item); return; }
    if (action === 'history') { setHistory({ item, detail: null, error: null }); return; }
    setModal({ kind: action, item });
  }, [runAction]);

  // Stable identity on purpose: `useFocusTrap`'s effect lists `onClose` in its
  // deps, and this page re-renders every 60 s on the `now` tick. An inline
  // arrow would tear the trap down and re-arm it each minute, which re-focuses
  // the ✕ and loses the element focus should return to on close.
  const closePhoto = useCallback(() => setPhoto(null), []);

  const onConfirmProperty = useCallback((property) => {
    runAction(property.id, () => verifyPartnerProperty(property.id), `Confirmed — ${property.name} is yours.`);
  }, [runAction]);

  return (
    <div style={PAGE_PAD}>
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12,
      }}>
        <h2 style={{
          fontSize: 12, fontWeight: 800, letterSpacing: '.1em', margin: 0,
          color: 'var(--text-muted)',
        }}>
          REQUESTS
        </h2>
        {toDo > 0 && (
          <span style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 700, color: 'var(--accent)' }}>
            {toDo} to do
          </span>
        )}
      </div>

      {/* Sticky until the queue is empty. */}
      {pending.length > 0 && (
        <div style={{
          position: 'sticky', top: 0, zIndex: 5, paddingTop: 2,
          background: 'var(--bg-page, var(--bg-card))',
        }}>
          {pending.map(p => (
            <PendingPropertyCard
              key={p.id}
              property={p}
              busy={busyId === p.id}
              onConfirm={onConfirmProperty}
              onReject={(property) => setModal({ kind: 'reject_property', property })}
            />
          ))}
        </div>
      )}

      <div role="tablist" aria-label="Filter requests" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        {chips.map(c => (
          <button
            key={c.id}
            role="tab"
            type="button"
            aria-selected={chip === c.id}
            onClick={() => setChip(c.id)}
            style={{
              borderRadius: 999, padding: '7px 13px', fontSize: 12, fontWeight: 700,
              minHeight: 36, cursor: 'pointer', fontFamily: 'inherit',
              background: chip === c.id ? 'var(--accent)' : 'var(--bg-inset)',
              // --text-muted on --bg-inset is 4.47:1 in .theme-light; the
              // chips are a control, so they take the secondary ink.
              color: chip === c.id ? 'var(--accent-ink)' : 'var(--text-secondary)',
              border: `1px solid ${chip === c.id ? 'var(--accent)' : 'var(--border)'}`,
            }}
          >
            {c.label}{c.count === null ? '' : ` ${c.count}`}
          </button>
        ))}
      </div>

      {loading && <SkeletonCards count={2} />}

      {!loading && loadError && (
        <div role="alert" style={{
          background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12,
          padding: 14, marginBottom: 10, fontSize: 13, color: 'var(--text-muted)',
        }}>
          {COPY.loadFailed}{' '}
          <button
            type="button"
            onClick={() => load()}
            style={{
              background: 'transparent', border: 'none', color: 'var(--accent)',
              fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', padding: 0,
            }}
          >
            Retry
          </button>
        </div>
      )}

      {!loading && !loadError && groups.length === 0 && pending.length === 0 && (
        <div style={{
          background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12,
          padding: 18, textAlign: 'center',
        }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--text-primary)' }}>{empty.title}</div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.5 }}>
            {empty.body}
          </div>
        </div>
      )}

      {groups.map(group => (
        <section key={group.propertyId || group.propertyName} style={{ marginBottom: 14 }}>
          <h3 style={{
            fontSize: 11, fontWeight: 800, letterSpacing: '.08em', margin: '0 0 6px',
            color: group.propertyVerified ? 'var(--text-muted)' : 'var(--yellow)',
            textTransform: 'uppercase',
          }}>
            {group.propertyName}
            {!group.propertyVerified && <span> <span aria-hidden="true">⚠ </span>not yet confirmed</span>}
            <span style={{ color: 'var(--text-muted)' }}> · {group.count}{chip === 'recent' ? '' : ' active'}</span>
          </h3>
          <ul style={{
            listStyle: 'none', margin: 0, padding: '0 12px',
            background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12,
          }}>
            {group.items.map(item => (
              <PartnerRequestRow
                key={item.id}
                item={item}
                now={now}
                busy={busyId === item.id}
                onAction={onRowAction}
              />
            ))}
          </ul>
        </section>
      ))}

      {modal && (
        <RequestActionModal
          modal={modal}
          onClose={() => setModal(null)}
          onDone={async (message) => { setModal(null); await afterWrite(message); }}
          onFailed={failed}
        />
      )}

      {history && (
        <HistorySheet
          state={history}
          onClose={() => setHistory(null)}
          onLoaded={(detail) => setHistory(h => (h ? { ...h, detail } : h))}
          onError={(error) => setHistory(h => (h ? { ...h, error } : h))}
        />
      )}

      {photo && <PhotoViewer item={photo} onClose={closePhoto} />}
    </div>
  );
}

// ── The four write dialogs ────────────────────────────────────
// All four reuse `ConfirmActionModal`: its `extra` slot carries the photo
// picker for the two fulfill flows, and `requireReason` carries the two that
// must be explained.

function RequestActionModal({ modal, onClose, onDone, onFailed }) {
  const { kind, item, property } = modal;
  const [submitting, setSubmitting] = useState(false);
  const [photoKey, setPhotoKey] = useState(null);
  const [photoName, setPhotoName] = useState('');
  const [uploading, setUploading] = useState(false);
  const [photoHint, setPhotoHint] = useState('');
  const fileRef = useRef(null);
  // The picker needs a real id: a <label> with no htmlFor leaves the file
  // input nameless, and it is the only control that can finish "Photo sent ✓".
  const photoInputId = useUid('request-photo');

  const wantsPhoto = kind === 'towed' || kind === 'photographed';
  const photoRequired = kind === 'photographed';

  const pick = async (file) => {
    if (!file) return;
    setUploading(true);
    setPhotoHint('');
    try {
      const res = await uploadPhoto(file, item.property_id);
      setPhotoKey(res?.photo_key || null);
      setPhotoName(file.name || 'photo');
    } catch (err) {
      setPhotoKey(null);
      setPhotoName('');
      setPhotoHint(
        err?.status === 413
          ? 'That photo is over 10 MB. Try a smaller one.'
          : 'Couldn’t add the photo — try again.',
      );
    } finally {
      setUploading(false);
    }
  };

  const submit = async (reason) => {
    if (photoRequired && !photoKey) {
      // Never a dead `disabled` button: say what is missing and open the picker.
      setPhotoHint('Add the photo first.');
      if (fileRef.current) fileRef.current.click();
      return;
    }
    setSubmitting(true);
    try {
      if (kind === 'reject_property') {
        await rejectPartnerProperty(property.id, { reason });
        await onDone(`${property.name} marked not yours.`);
        return;
      }
      if (kind === 'decline') {
        await declineRequest(item.id, { reason });
        await onDone(`${item.ref} declined.`);
        return;
      }
      if (kind === 'photographed') {
        await fulfillRequest(item.id, { resolution: 'photographed', photo_key: photoKey, note: reason || undefined });
        await onDone(`Photo sent for ${item.ref}.`);
        return;
      }
      // `towed` and `towed_anyway` are the same transition — a hold keeps the
      // hold on the record and resolves `towed` (spec §4.2 "Towed anyway").
      await fulfillRequest(item.id, {
        resolution: 'towed',
        photo_key: photoKey || undefined,
        note: reason || undefined,
      });
      await onDone(`${item.ref} marked towed.`);
    } catch (err) {
      setSubmitting(false);
      onFailed(err);
    }
  };

  const copy = modalCopy(modal, { photoKey });

  return (
    <ConfirmActionModal
      plate={item?.plate || ''}
      actionLabel={copy.actionLabel}
      description={copy.description}
      confirmLabel={copy.confirmLabel}
      confirmColor={copy.confirmColor}
      requireReason={copy.requireReason}
      reasonPlaceholder={copy.reasonPlaceholder}
      submitting={submitting}
      onConfirm={submit}
      onCancel={onClose}
      extra={wantsPhoto ? (
        <div style={{ marginBottom: 10 }} aria-busy={uploading ? 'true' : undefined}>
          <label htmlFor={photoInputId} style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', display: 'block', marginBottom: 4 }}>
            {photoRequired ? 'Add the photo' : 'Add a photo (optional)'}
          </label>
          <input
            id={photoInputId}
            ref={fileRef}
            type="file"
            accept="image/*"
            onChange={e => pick(e.target.files?.[0])}
            style={{ fontSize: 12, color: 'var(--text-muted)' }}
          />
          <div aria-live="polite" style={{ fontSize: 12, marginTop: 4, color: photoHint ? 'var(--red)' : 'var(--text-muted)' }}>
            {uploading ? 'Adding the photo…' : (photoHint || (photoKey ? `${photoName} added.` : ''))}
          </div>
        </div>
      ) : null}
    />
  );
}

/** Every string a dialog shows, in one place, taken from spec §5.4. */
function modalCopy(modal, { photoKey }) {
  const { kind, item } = modal;
  if (kind === 'reject_property') {
    return {
      actionLabel: COPY.rejectTitle,
      description: COPY.rejectBody,
      confirmLabel: COPY.rejectConfirm,
      confirmColor: '#dc2626',
      requireReason: true,
      reasonPlaceholder: COPY.rejectPlaceholder,
    };
  }
  if (kind === 'decline') {
    return {
      actionLabel: COPY.declineTitle,
      description: COPY.declineBody,
      confirmLabel: COPY.declineConfirm,
      confirmColor: '#dc2626',
      requireReason: true,
      reasonPlaceholder: COPY.declinePlaceholder,
    };
  }
  if (kind === 'towed_anyway') {
    return {
      actionLabel: `Mark ${item.ref} towed`,
      description: `This records that ${item.plate} was towed while a hold was active. The office will see this.`,
      confirmLabel: 'Mark towed',
      confirmColor: '#dc2626',
      requireReason: false,
      reasonPlaceholder: 'Note (optional)',
    };
  }
  if (kind === 'photographed') {
    return {
      actionLabel: `Send the photo for ${item.ref}`,
      description: `Plate ${item.plate}. The office sees the photo as soon as you send it.`,
      confirmLabel: photoKey ? 'Photo sent ✓' : 'Add the photo',
      confirmColor: null,
      requireReason: false,
      reasonPlaceholder: 'Note (optional)',
    };
  }
  return {
    actionLabel: `Mark ${item.ref} towed`,
    description: `Plate ${item.plate}. The office sees this the moment you confirm.`,
    confirmLabel: 'Mark towed',
    confirmColor: null,
    requireReason: false,
    reasonPlaceholder: 'Note (optional)',
  };
}

// ── History ───────────────────────────────────────────────────
// `GET /apartment/requests/{id}` answers `{request, events, deliveries}` and
// this sheet is the partner's view of spec §5.3 — the same record the office
// reads, with the partner's own actions already on the row behind it.
//
// NOTE for the integration merge (Task 30): Task 22 adds
// `src/pages/property/RequestHistorySheet.jsx`, the office's version of this
// sheet, which does not exist on this branch (Task 22 runs in parallel). When
// both land, this sheet is the one to delete — pass `actor="partner"` to Task
// 22's component and render it here instead.

function HistorySheet({ state, onClose, onLoaded, onError }) {
  const { item, detail, error } = state;
  useEffect(() => {
    let cancelled = false;
    getRequest(item.id)
      .then(res => { if (!cancelled) onLoaded(res); })
      .catch(err => { if (!cancelled) onError(err); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  const rows = [
    ...(detail?.events || []).map(e => ({
      at: e.created_at || e.at,
      text: eventLine(e),
    })),
    ...(detail?.deliveries || []).map(d => ({
      at: d.sent_at || d.created_at,
      text: `${d.channel === 'slack' ? 'Posted to Slack' : `Emailed ${d.target || 'the office'}`}${d.status === 'sent' ? ' ✓' : ` · ${d.status || 'queued'}`}`,
    })),
  ].sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 1000, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`History for ${item.ref}`}
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--bg-card)', borderTopLeftRadius: 16, borderTopRightRadius: 16,
          border: '1px solid var(--border)', padding: 16, width: '100%', maxWidth: 520,
          maxHeight: '80vh', overflowY: 'auto',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--text-primary)' }}>
            {item.ref} · {String(item.kind || '').toUpperCase()} · {item.plate}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close history"
            style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: 'var(--text-muted)', fontSize: 18, cursor: 'pointer' }}
          >
            ✕
          </button>
        </div>
        {item.expires_local && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>Do not tow until {item.expires_local}</div>
        )}
        <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.08em', color: 'var(--text-muted)', margin: '12px 0 6px' }}>
          HISTORY
        </div>
        {error && <div role="alert" style={{ fontSize: 13, color: 'var(--text-muted)' }}>Couldn&rsquo;t load the history.</div>}
        {!error && !detail && <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Loading…</div>}
        {rows.length > 0 && (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {rows.map((r, i) => (
              <li key={i} style={{ fontSize: 12, color: 'var(--text-muted)', padding: '4px 0' }}>
                <span aria-hidden="true">● </span>{fmtTimeET(r.at)} {r.text}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

const EVENT_TEXT = {
  created: 'Placed',
  notified: 'Sent',
  acked: 'Seen',
  checked: 'Checked by your crew',
  extended: 'Extended',
  removed: 'Taken off by the office',
  expired: 'Ended on its own',
  fulfilled: 'Done',
  declined: 'Declined',
  reinstated: 'Put back',
};

function eventLine(event) {
  const label = EVENT_TEXT[event?.kind || event?.event] || event?.kind || 'Updated';
  const who = event?.actor_display || event?.actor_name;
  return who ? `${label} by ${who}` : label;
}

// ── A request's photo ─────────────────────────────────────────
// `<img src>` cannot carry a Bearer header, so the route is read as a blob
// through `apiFetch` and the object URL is revoked on unmount.

function PhotoViewer({ item, onClose }) {
  const [url, setUrl] = useState(null);
  const [error, setError] = useState(false);
  // role="dialog" aria-modal="true" is a promise: Escape closes it, Tab stays
  // inside it, and there is a control a keyboard can reach to dismiss it.
  const dialogRef = useRef(null);
  useFocusTrap(dialogRef, true, onClose);
  useEffect(() => {
    let revoke = null;
    let cancelled = false;
    fetchRequestPhoto(item.id)
      .then(blob => {
        if (cancelled) return;
        revoke = URL.createObjectURL(blob);
        setUrl(revoke);
      })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; if (revoke) URL.revokeObjectURL(revoke); };
  }, [item.id]);
  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.8)', zIndex: 1001, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Photo for ${item.ref}`}
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
        style={{ outline: 'none', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close photo"
          style={{
            background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8,
            color: 'var(--text-primary)', fontSize: 16, minHeight: 44, minWidth: 44,
            cursor: 'pointer', fontFamily: 'inherit',
          }}
        >
          ✕
        </button>
        {url && <img src={url} alt={`Photo sent with ${item.ref}`} style={{ maxWidth: '100%', maxHeight: '80vh', borderRadius: 10 }} />}
        {!url && !error && <div style={{ color: '#fff', fontSize: 13 }}>Loading…</div>}
        {error && <div role="alert" style={{ color: '#fff', fontSize: 13 }}>Couldn&rsquo;t load that photo.</div>}
      </div>
    </div>
  );
}

export default PartnerRequestsPage;
