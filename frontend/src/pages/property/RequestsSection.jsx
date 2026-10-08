import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { requestsApi } from '../../lib/requestsApi.js';
import { latestGate, applyIfCurrent } from '../../lib/latest.js';
import { requestErrorMessage } from '../../lib/requestErrors.js';
import { useIntervalFetch } from '../../hooks.js';
import { SkeletonCards } from '../../ui/Skeletons.jsx';
import { RequestComposer } from './RequestComposer.jsx';
import { RequestRow, isUnreached } from './RequestRow.jsx';
import { RecentList } from './RecentList.jsx';
import { RequestHistorySheet } from './RequestHistorySheet.jsx';
import { ExtendSheet } from './ExtendSheet.jsx';

// ── The Requests section (spec §5.2) ─────────────────────────
//
// The portal's home. First chip, default section, and the only surface a
// camera-less property manager uses day to day.
//
// Data comes through `requestsApi` (so `apiFetch`, so the Bearer token, so
// server-side scoping) and nowhere else — no PostgREST reads here. Two lists:
// `view=active` and `view=recent`, polled every 30 s while the section is
// mounted, the way the rest of the property page polls.
//
// Props
//   property       the property row, plus the `/auth/me` entry merged on
//                  (`role`, `partner_phone`, `verification_status`)
//   user           the signed-in account (`email_verified`, `_role`)
//   role           the member role: admin | manager | viewer | partner
//   onNeedVerify   opens Task 23's VerifyEmailSheet; defaults to a no-op, so
//                  until 23 lands the composer's inline copy is the whole answer
//   request        deep link: the request id to scroll to and expand
//   upload         deep link: open that request's photo expander (§6.5)
//   onAskUpsell    opens the §5.6 UpsellPanel's FeedbackModal (Task 24)

// Spec §5.2's Undo window is 5 s on screen; the server holds the `removed`
// deliveries for 10 s, so an Undo inside the toast always beats the email.
const UNDO_MS = 5000;

const EMPTY_TITLE = 'No requests yet.';
const EMPTY_BODY = "Put a plate on hold so N Style won't tow it, request a tow, or ask for a photo. Every request is logged with who and when.";
const LOAD_ERROR = "Couldn't load requests. Your last list is still shown.";

/** Active holds first, then tow and photo — the §5.2 grouping. */
export function groupActive(items) {
  const rows = Array.isArray(items) ? items : [];
  return {
    holds: rows.filter(r => r.kind === 'hold'),
    others: rows.filter(r => r.kind !== 'hold'),
  };
}

/**
 * The persistent banner's sentence (§5.2), or '' when every request has
 * reached N Style. Named after the oldest unreached request, because that is
 * the one the manager should be phoning about.
 */
export function unreachedBanner(items, phone, now = Date.now()) {
  const rows = (Array.isArray(items) ? items : [])
    .filter(r => r.status === 'active' && isUnreached(r, now))
    .sort((a, b) => Date.parse(a.created_at || '') - Date.parse(b.created_at || ''));
  if (rows.length === 0) return '';
  const ref = rows[0].ref || 'a request';
  // `enforcement_partners.phone` must be set for N Style before go-live
  // (§11). Until it is, the sentence still names the request — a banner with
  // no number beats no banner at all.
  return phone
    ? `⚠ We couldn't reach N Style about ${ref} — call ${phone}.`
    : `⚠ We couldn't reach N Style about ${ref}.`;
}

export function RequestsSection({
  property,
  user,
  role = 'admin',
  onNeedVerify,
  request: deepRequestId = null,
  upload: deepUpload = false,
  onAskUpsell,
  addToast,
}) {
  const [active, setActive] = useState(null);     // null = never loaded
  const [recent, setRecent] = useState([]);
  const [error, setError] = useState('');
  const [historyId, setHistoryId] = useState(null);
  const [extending, setExtending] = useState(null);
  const [flaggedId, setFlaggedId] = useState(null);
  // The 5-second Undo affordance. `addToast` takes a string and cannot carry a
  // control, so the toast says the sentence and this card is the tap target.
  const [undo, setUndo] = useState(null);
  const plateRef = useRef(null);
  const undoRef = useRef(null);
  const deepHandledRef = useRef(false);
  // Out-of-order guard: a list fetch that started before an Extend must not
  // land after the post-extend reload and put the old count back on screen.
  const loadGateRef = useRef(null);
  if (!loadGateRef.current) loadGateRef.current = latestGate();

  const propertyId = property?.id || null;
  const isViewer = role === 'viewer';
  const canAct = role === 'admin' || role === 'manager';
  // §8.3 scopes `POST …/{id}/fulfill` to "partner / Slack", and §6.5's
  // [Photo sent] button — the one surface that deep-links into the row's
  // upload — is in the partner's Slack feed. The office would get a 404, so
  // the control is not rendered for the office at all (§5's "no dead
  // controls"), and never for a viewer.
  const canFulfill = role === 'partner';
  // §5.2's Recent pills say "Removed by you" for the caller and the actor's
  // first name for a teammate; only this component knows who the caller is.
  const viewerName = user?.name || user?.contact_name || '';
  const isPending = property?.verification_status === 'pending';
  const rules = property?.hold_rules;

  const load = useCallback(async () => {
    const gate = loadGateRef.current;
    const ticket = gate.take();
    if (!propertyId) return;
    try {
      const [a, r] = await Promise.all([
        requestsApi.listRequests({ property_id: propertyId, view: 'active' }),
        requestsApi.listRequests({ property_id: propertyId, view: 'recent' }),
      ]);
      applyIfCurrent(gate, ticket, () => {
        setActive(a?.items || []);
        setRecent(r?.items || []);
        setError('');
      });
    } catch (err) {
      // "Your last list is still shown" is a promise: never blank what is on
      // screen because one poll failed.
      if (!gate.isCurrent(ticket)) return;
      if (err?.status !== 401) setError(LOAD_ERROR);
    }
  }, [propertyId]);

  // Spec §5.2: polled every 30 s while the section is mounted.
  useIntervalFetch(load, 30000, [load]);

  useEffect(() => () => { if (undoRef.current) clearTimeout(undoRef.current); }, []);

  // The deep link `/app?property=…&request=<id>` scrolls that row into view
  // once the list it lives in has arrived.
  useEffect(() => {
    if (!deepRequestId || deepHandledRef.current || active === null) return;
    deepHandledRef.current = true;
    setFlaggedId(deepRequestId);
    const t = setTimeout(() => scrollToRequest(deepRequestId), 60);
    return () => clearTimeout(t);
  }, [deepRequestId, active]);

  function scrollToRequest(id) {
    if (!id) return;
    const el = document.querySelector(`[data-request-id="${CSS.escape(String(id))}"]`);
    if (!el) return;
    try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch { el.scrollIntoView(); }
  }

  const { holds, others } = useMemo(() => groupActive(active || []), [active]);

  /**
   * The server's `expires_local` for one of the rows on screen. §8.3's 409
   * `active_hold_exists` body is `{request_id}` only, so the composer's
   * conflict sentence gets its time from here.
   */
  const expiryFor = useCallback((requestId) => {
    const row = (active || []).find(r => String(r.id) === String(requestId));
    return row?.expires_local || '';
  }, [active]);
  const banner = useMemo(
    () => unreachedBanner(active || [], property?.partner_phone),
    [active, property?.partner_phone],
  );

  function onCreated(created) {
    // Taking a ticket retires any poll already in flight, so it cannot land
    // after this and drop the row we just added.
    loadGateRef.current.take();
    if (created) setActive(prev => [created, ...(prev || [])]);
    load();
  }

  function onConflict({ requestId }) {
    if (!requestId) return;
    setFlaggedId(requestId);
    scrollToRequest(requestId);
  }

  // Remove is optimistic: the row leaves at once and the toast carries the
  // Undo. The server holds every `removed` delivery for 10 s, so an Undo
  // inside this window is invisible to N Style (§5.2).
  async function remove(target) {
    // A poll that started before this click holds a list that still contains
    // the row; taking a ticket makes its response stale.
    loadGateRef.current.take();
    setActive(prev => (prev || []).filter(r => r.id !== target.id));
    try {
      await requestsApi.removeRequest(target.id, {});
    } catch (err) {
      addToast?.(requestErrorMessage(err, 'Could not remove that hold.'), 'error');
      load();
      return;
    }
    showUndo(target);
  }

  function showUndo(target) {
    // The toast system takes a string and auto-dismisses; the Undo control it
    // cannot render lives beside the composer for the same 5 s.
    addToast?.('Hold removed · Undo', 'success');
    setUndo({ id: target.id, ref: target.ref, plate: target.plate });
    if (undoRef.current) clearTimeout(undoRef.current);
    undoRef.current = setTimeout(() => setUndo(null), UNDO_MS);
  }

  async function doUndo() {
    const target = undo;
    setUndo(null);
    if (undoRef.current) clearTimeout(undoRef.current);
    if (!target) return;
    const gate = loadGateRef.current;
    const ticket = gate.take();
    try {
      const out = await requestsApi.reinstateRequest(target.id, { undo: true });
      const next = out?.request || out;
      applyIfCurrent(gate, ticket, () => {
        if (next) setActive(prev => [next, ...(prev || [])]);
      });
      load();
    } catch (err) {
      addToast?.(requestErrorMessage(err, 'Could not undo that.'), 'error');
      load();
    }
  }

  async function reinstate(target) {
    try {
      const out = await requestsApi.reinstateRequest(target.id, {});
      const next = out?.request || out;
      addToast?.(
        next?.expires_local
          ? `Hold ${next.ref} placed until ${next.expires_local} — sending to N Style.`
          : `Hold ${next?.ref || ''} placed — sending to N Style.`,
        'success',
      );
      load();
    } catch (err) {
      if (err?.code === 'active_hold_exists') {
        onConflict({ requestId: err.body?.request_id });
        return;
      }
      addToast?.(requestErrorMessage(err, 'Could not place that hold again.'), 'error');
    }
  }

  const rowProps = {
    canAct,
    canFulfill,
    viewerName,
    onExtend: setExtending,
    onRemove: remove,
    onHistory: (r) => setHistoryId(r.id),
    addToast,
    onPhotoSent: () => load(),
  };

  const loading = active === null;
  const nothingYet = !loading && holds.length === 0 && others.length === 0 && recent.length === 0;

  return (
    <div>
      {banner && (
        <div className="req-banner" role="status">{banner}</div>
      )}

      {/* Only the office places, extends, removes or reinstates (§4.3). A
          viewer gets the one muted line; N Style gets no composer at all —
          its own surface is the §5.4 Requests tab. */}
      {isViewer && <p className="req-quiet">{viewerLine(property)}</p>}
      {canAct && (
        <RequestComposer
          property={property}
          rules={rules}
          holdCount={holds.length}
          emailVerified={user?.email_verified}
          onCreated={onCreated}
          onNeedVerify={onNeedVerify}
          onConflict={onConflict}
          expiryFor={expiryFor}
          addToast={addToast}
          plateInputRef={plateRef}
        />
      )}

      {undo && (
        <div className="req-card" role="status">
          <span className="req-quiet">Hold removed</span>{' '}
          <button type="button" className="req-link" onClick={doUndo}>Undo</button>
        </div>
      )}

      {error && (
        <div className="req-card" role="status">
          <span className="req-quiet">{LOAD_ERROR}</span>{' '}
          <button type="button" className="req-link" onClick={load}>Retry</button>
        </div>
      )}

      {loading && <SkeletonCards count={2} />}

      {nothingYet && (
        <div className="req-card">
          <div className="req-empty-title">{EMPTY_TITLE}</div>
          <p className="req-help">{EMPTY_BODY}</p>
          {canAct && (
            <button type="button" className="req-btn" onClick={() => {
              try { plateRef.current?.focus({ preventScroll: false }); } catch { /* iOS without a gesture */ }
            }}>Put a plate on hold</button>
          )}
        </div>
      )}

      {!loading && !nothingYet && (
        <>
          <div className="req-section-title">On hold · {holds.length}</div>
          {holds.map(r => (
            <RequestRow key={r.id} request={r} flagged={flaggedId === r.id}
              openUpload={deepUpload && deepRequestId === r.id} {...rowProps} />
          ))}

          <div className="req-section-title">Tow &amp; photo requests · {others.length}</div>
          {others.map(r => (
            <RequestRow key={r.id} request={r} flagged={flaggedId === r.id}
              openUpload={deepUpload && deepRequestId === r.id} {...rowProps} />
          ))}

          <RecentList
            items={recent}
            canAct={canAct}
            canFulfill={canFulfill}
            viewerName={viewerName}
            onHistory={(r) => setHistoryId(r.id)}
            onReinstate={reinstate}
            addToast={addToast}
          />
        </>
      )}

      {isPending && (
        <p className="req-quiet" style={{ marginTop: 12 }}>
          Waiting for N Style to confirm {property?.name} — holds work now.
        </p>
      )}

      {historyId && (
        <RequestHistorySheet
          requestId={historyId}
          onClose={() => setHistoryId(null)}
          canAct={canAct}
          viewerName={viewerName}
          onExtend={setExtending}
          onRemove={remove}
          addToast={addToast}
        />
      )}

      {extending && (
        <ExtendSheet
          request={extending}
          rules={rules}
          onClose={() => setExtending(null)}
          onExtended={() => load()}
          onAskUpsell={onAskUpsell}
          addToast={addToast}
        />
      )}
    </div>
  );
}

/**
 * The viewer's one muted line (§5.2), naming the admin to ask. The name comes
 * from the property payload; with nothing to name, the line still has to say
 * what the viewer can and cannot do.
 */
export function viewerLine(property) {
  const raw = property?.admin_first_name || property?.signed_up_by || property?.contact_name || '';
  const first = String(raw).trim().split(/\s+/)[0];
  return first
    ? `View only — ask ${first} to place holds.`
    : 'View only — ask an admin to place holds.';
}
