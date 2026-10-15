import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiFetch } from '../lib/api.js';
import { useNowTick } from '../hooks.js';
import { useToast } from '../ui/Toast.jsx';
import { FeedbackModal } from '../ui/FeedbackModal.jsx';
import { SkeletonCards } from '../ui/Skeletons.jsx';
import {
  SEGMENTS,
  actionError,
  actionPath,
  ageChip,
  allCaughtUpLine,
  approvedPatch,
  approvedVehicleCount,
  capChip,
  capOf,
  createDocCache,
  decidedRows,
  initialDenyReason,
  isLongTerm,
  nextPendingKey,
  normalizeUnit,
  overLimitKeys,
  patchRows,
  plateText,
  queueRows,
  readQueueQuery,
  registrationLink,
  reviewGroups,
  segmentCounts,
  segmentOf,
  serverPatch,
  unitLabel,
  unitTally,
  unitText,
  writeQueueQuery,
} from '../lib/permitsQueue.js';
import { DocCacheContext, fetchDocBlob, useMediaQuery } from './permits/docs.js';
import { DocViewerModal } from './permits/DocViewerModal.jsx';
import { QueueRow } from './permits/QueueRow.jsx';
import { RequestDetail } from './permits/RequestDetail.jsx';
import { DenySheet, ExtendPassSheet, VoidSheet } from './permits/sheets.jsx';
import { Tag } from './permits/parts.jsx';

// ── The manager's approval queue (Passes tab, task F4) ───────
//
// Needs review / Approved / Denied over the whole permits payload, a plate-or-
// unit search, requests grouped by unit against the property's vehicle cap,
// each request's documents inline beside the values they prove, one-tap
// Approve (optimistic; the row comes back if the server says no), Deny through
// a reason sheet that previews the email, and Void / Extend behind a "More
// actions" menu with real confirms. The pure rules live in
// `lib/permitsQueue.js` (scripts/permitsQueue.test.mjs).
//
// Layout: at 1024 px and up a 360 px list beside a sticky detail pane; below
// that the detail replaces the list, pushed onto history so the browser or
// hardware Back closes it. `?status=&q=` keep the segment and search across a
// refresh.

const WIDE_QUERY = '(min-width: 1024px)';

// The detail's top (its Back control) to the top of the screen. The app
// header does not stick today (see the .pq-layout note in dashboard.html), but
// if it ever does, step back out from under it.
function scrollDetailIntoView(heading) {
  const detail = heading?.closest('.pq-detail');
  if (!detail) return;
  try {
    detail.scrollIntoView({ block: 'start' });
    const header = document.querySelector('.header');
    const overlap = header ? header.getBoundingClientRect().bottom - detail.getBoundingClientRect().top : 0;
    window.scrollBy(0, overlap > 0 ? -(overlap + 8) : -8);
  } catch { /* ignore */ }
}

function replaceQuery(state) {
  try {
    const { pathname, search, hash } = window.location;
    const next = writeQueueQuery(search, state);
    if (next !== search) window.history.replaceState(window.history.state, '', `${pathname}${next}${hash}`);
  } catch { /* history blocked: the view still works, it just will not survive a refresh */ }
}

export function ApartmentPermits({ property }) {
  const propertyId = property?.id;
  const propertyName = property?.name || '';
  const cap = capOf(property);
  const requireRegistration = property?.require_vehicle_registration === true;
  const { addToast } = useToast();
  const now = useNowTick();
  const isWide = useMediaQuery(WIDE_QUERY);

  const initialQuery = useMemo(() => readQueueQuery(window.location.search), []);
  const [segment, setSegment] = useState(initialQuery.status);
  const [q, setQ] = useState(initialQuery.q);
  const [rows, setRows] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  // Non-null when the last load failed — "nothing pending" and "we don't know
  // what's pending" must never look the same.
  const [loadErr, setLoadErr] = useState(null);
  const [selectedKey, setSelectedKey] = useState(null);
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [sheet, setSheet] = useState(null);
  const [docView, setDocView] = useState(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [savingKeys, setSavingKeys] = useState(() => new Set());
  const [announcement, setAnnouncement] = useState('');

  const docCache = useMemo(() => createDocCache(fetchDocBlob), [propertyId]);
  // Optimistic patches still waiting on the server, re-applied over any list
  // that lands in the meantime.
  const inFlight = useRef(new Map());
  const loadToken = useRef(0);
  const openerRef = useRef(null);
  const listScrollY = useRef(0);
  const headingRef = useRef(null);
  // Where focus goes after the next commit: `{to: 'heading' | 'segment',
  // onlyIfLost, scroll}`. A decision removes the button that had focus
  // (Approve, or a sheet's opener in a row that just left the list), so focus
  // lands somewhere that still exists instead of falling to <body>.
  const pendingFocus = useRef(null);
  const segmentRefs = useRef({});
  const phoneWasOpen = useRef(false);
  // Sheets and viewers render into the app root, not in place: the tab and
  // page wrappers keep a filled entrance-animation transform, which turns a
  // position: fixed overlay inside them into one anchored to the page box
  // (the backdrop covered one column and the buttons sat off screen).
  const rootRef = useRef(null);
  const [layer, setLayer] = useState(null);
  useEffect(() => { setLayer(rootRef.current?.closest('.app') || document.body); }, []);
  const overlay = (node) => (layer ? createPortal(node, layer) : null);

  const refresh = useCallback(async () => {
    if (!propertyId) return;
    const token = ++loadToken.current;
    setLoading(true);
    try {
      const res = await apiFetch(`/apartment/passes/permits?property_id=${encodeURIComponent(propertyId)}`);
      if (token !== loadToken.current) return;
      let next = queueRows(res);
      for (const [key, patch] of inFlight.current) next = patchRows(next, key, patch);
      setRows(next);
      setLoaded(true);
      setLoadErr(null);
    } catch (e) {
      if (token !== loadToken.current) return;
      setLoadErr(e?.message || 'Could not load');
    } finally {
      if (token === loadToken.current) setLoading(false);
    }
  }, [propertyId]);

  // A decision the server just confirmed is newer than any list still in
  // flight, so that list is dropped rather than painted over it.
  const supersedeLoads = useCallback(() => {
    loadToken.current += 1;
    setLoading(false);
  }, []);

  useEffect(() => {
    setRows([]);
    setLoaded(false);
    setSelectedKey(null);
    setPhoneOpen(false);
    refresh();
  }, [refresh]);

  // ?status=&q= follow the view; leaving the queue takes them out again.
  useEffect(() => { replaceQuery({ status: segment, q }); }, [segment, q]);
  useEffect(() => () => replaceQuery({}), []);

  const say = useCallback((text, type) => {
    addToast(text, type);
    setAnnouncement(text);
  }, [addToast]);

  // ── Derived lists ──
  const overKeys = useMemo(() => overLimitKeys(rows, cap), [rows, cap]);
  const counts = useMemo(() => segmentCounts(rows, q), [rows, q]);
  const groups = useMemo(() => (segment === 'pending' ? reviewGroups(rows, { q, cap }) : []), [rows, q, cap, segment]);
  const decided = useMemo(() => (segment === 'pending' ? [] : decidedRows(rows, segment, q)), [rows, segment, q]);
  const visible = segment === 'pending' ? groups.flatMap(g => g.rows) : decided;
  const selectedRow = selectedKey ? rows.find(r => r.key === selectedKey) || null : null;
  const sheetRow = sheet ? rows.find(r => r.key === sheet.key) || null : null;
  const phoneDetail = !isWide && phoneOpen && !!selectedRow;

  // Laptop: the pane always shows something when the list does. A new segment
  // or search selects its first request; a decision keeps the decided row on
  // screen (it shows its new status and "Next request").
  useEffect(() => {
    if (!isWide || !loaded) return;
    setSelectedKey(current => (current && visible.some(r => r.key === current) ? current : (visible[0]?.key || null)));
  }, [isWide, loaded, segment, q]); // eslint-disable-line react-hooks/exhaustive-deps

  // A phone that turns into a laptop shows the pane instead.
  useEffect(() => { if (isWide) setPhoneOpen(false); }, [isWide]);

  // Phone: the pushed detail closes on Back, reopens on Forward.
  useEffect(() => {
    const onPop = (e) => {
      const key = e.state && e.state.pqDetail;
      if (key) { setSelectedKey(key); setPhoneOpen(true); } else setPhoneOpen(false);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Leaving the queue with the detail pushed: take the entry back off so the
  // next Back press is not a dead one.
  const phoneOpenRef = useRef(false);
  phoneOpenRef.current = phoneDetail;
  useEffect(() => () => {
    try { if (phoneOpenRef.current && window.history.state?.pqDetail) window.history.back(); } catch { /* ignore */ }
  }, []);

  // Phone focus and scroll: into the detail on open, back to the row (and the
  // list position) on close.
  useEffect(() => {
    if (phoneDetail) {
      phoneWasOpen.current = true;
      scrollDetailIntoView(headingRef.current);
      headingRef.current?.focus({ preventScroll: true });
    } else if (phoneWasOpen.current) {
      phoneWasOpen.current = false;
      window.scrollTo(0, listScrollY.current);
      const opener = openerRef.current;
      const target = opener && opener.isConnected ? opener : segmentRefs.current[segment];
      try { target?.focus({ preventScroll: true }); } catch { /* ignore */ }
    }
  }, [phoneDetail]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const want = pendingFocus.current;
    if (!want) return;
    pendingFocus.current = null;
    const active = document.activeElement;
    if (want.onlyIfLost && active && active !== document.body && active.isConnected) return;
    const heading = headingRef.current && headingRef.current.isConnected ? headingRef.current : null;
    const target = want.to === 'heading' && heading ? heading : segmentRefs.current[segment];
    try { target?.focus({ preventScroll: true }); } catch { /* ignore */ }
    if (want.scroll && !isWide) scrollDetailIntoView(heading);
  });

  const openRow = useCallback((row, el) => {
    openerRef.current = el;
    setSelectedKey(row.key);
    if (!isWide) {
      listScrollY.current = window.scrollY;
      try { window.history.pushState({ ...(window.history.state || {}), pqDetail: row.key }, ''); } catch { /* ignore */ }
      setPhoneOpen(true);
    }
  }, [isWide]);

  const closeDetail = useCallback(() => {
    if (window.history.state && window.history.state.pqDetail) window.history.back();
    else setPhoneOpen(false);
  }, []);

  const goNext = useCallback((key) => {
    pendingFocus.current = { to: 'heading', scroll: true };
    setSelectedKey(key);
    if (!isWide) {
      try { window.history.replaceState({ ...(window.history.state || {}), pqDetail: key }, ''); } catch { /* ignore */ }
    }
  }, [isWide]);

  const markSaving = useCallback((key, on) => {
    setSavingKeys(prev => {
      const next = new Set(prev);
      if (on) next.add(key); else next.delete(key);
      return next;
    });
  }, []);

  // ── Decisions ──
  const approve = useCallback(async (row) => {
    if (inFlight.current.has(row.key)) return;
    const before = { status: row.status, reviewed_at: row.reviewed_at };
    const patch = approvedPatch(row, new Date().toISOString());
    inFlight.current.set(row.key, patch);
    pendingFocus.current = { to: 'heading', onlyIfLost: true };
    setRows(rs => patchRows(rs, row.key, patch));
    markSaving(row.key, true);
    const unit = unitText(row);
    try {
      const out = await apiFetch(actionPath(row, 'approve'), { method: 'POST' });
      inFlight.current.delete(row.key);
      supersedeLoads();
      setRows(rs => patchRows(rs, row.key, serverPatch(out)));
      say(`Approved: ${plateText(row)}${unit ? ` · ${unitLabel(unit)}` : ''}`, 'success');
    } catch (err) {
      inFlight.current.delete(row.key);
      setRows(rs => patchRows(rs, row.key, before));
      const failure = actionError(err, 'approve');
      say(failure.text, 'error');
      if (failure.refresh) refresh();
    } finally {
      markSaving(row.key, false);
    }
  }, [markSaving, refresh, say, supersedeLoads]);

  const closeSheet = useCallback(() => setSheet(null), []);
  const closeDocView = useCallback(() => setDocView(null), []);
  const closeFeedback = useCallback(() => setFeedbackOpen(false), []);
  const openDeny = useCallback((row, { viaOverLimit = false } = {}) => {
    setSheet({ type: 'deny', key: row.key, initialReason: initialDenyReason(row, { viaOverLimit, requireRegistration }) });
  }, [requireRegistration]);

  const onStale = useCallback((text) => {
    pendingFocus.current = { to: 'segment', onlyIfLost: true };
    setSheet(null);
    say(text, 'error');
    refresh();
  }, [refresh, say]);

  const finish = useCallback((row, patch, message) => {
    pendingFocus.current = { to: row.key === selectedKey ? 'heading' : 'segment', onlyIfLost: true };
    supersedeLoads();
    setRows(rs => patchRows(rs, row.key, patch));
    setSheet(null);
    say(message, 'success');
  }, [say, selectedKey, supersedeLoads]);

  const onDenied = useCallback((out, { reason, notified }) => {
    if (!sheetRow) return;
    finish(sheetRow, { status: 'rejected', reject_reason: reason, ...serverPatch(out) },
      `Denied: ${plateText(sheetRow)}${notified ? ' — reason sent' : ''}`);
  }, [finish, sheetRow]);
  const onVoided = useCallback((out) => {
    if (!sheetRow) return;
    finish(sheetRow, { status: 'void', ...serverPatch(out) }, `Voided: ${plateText(sheetRow)}`);
  }, [finish, sheetRow]);
  const onExtended = useCallback((out, { hours }) => {
    if (!sheetRow) return;
    finish(sheetRow, serverPatch(out), `Extended ${hours}h`);
  }, [finish, sheetRow]);

  // A sheet whose row left the list (a refresh) closes itself.
  useEffect(() => { if (sheet && !sheetRow) setSheet(null); }, [sheet, sheetRow]);

  const moreItemsFor = useCallback((row) => {
    if (segmentOf(row) !== 'approved') return [];
    const items = [];
    if (!isLongTerm(row)) items.push({ id: 'extend', label: 'Extend…', onSelect: () => setSheet({ type: 'extend', key: row.key }) });
    items.push({ id: 'void', label: 'Void pass…', danger: true, onSelect: () => setSheet({ type: 'void', key: row.key }) });
    return items;
  }, []);

  const copyLink = useCallback(async () => {
    const link = registrationLink(window.location.origin, property?.qr_code_id);
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      say('Registration link copied', 'success');
    } catch {
      say("Couldn't copy the link. Try again.", 'error');
    }
  }, [property?.qr_code_id, say]);

  // ── Pieces ──
  const rowProps = (row, { showThumb, showUnit }) => ({
    row,
    now,
    selected: (isWide || phoneOpen) && row.key === selectedKey,
    overLimit: overKeys.has(row.key),
    cap,
    ageChip: ageChip(row, now),
    showThumb,
    showUnit,
    moreItems: moreItemsFor(row),
    onOpen: openRow,
  });

  let listBody;
  if (!loaded && loadErr) {
    listBody = (
      <div className="pq-empty pq-empty--error">
        <p>Couldn't load the approval queue — this is not "nothing pending".</p>
        <button type="button" className="pq-btn pq-btn--quiet pq-btn--small" onClick={refresh}>Retry</button>
      </div>
    );
  } else if (!loaded) {
    listBody = <SkeletonCards count={3} />;
  } else if (visible.length === 0) {
    const link = registrationLink(window.location.origin, property?.qr_code_id);
    listBody = q ? (
      <div className="pq-empty">
        <p className="pq-empty-title">No results for “{q}”</p>
        <button type="button" className="pq-btn pq-btn--quiet pq-btn--small" onClick={() => setQ('')}>Clear search</button>
      </div>
    ) : segment === 'pending' ? (
      <div className="pq-empty">
        <p className="pq-empty-title">{allCaughtUpLine(approvedVehicleCount(rows), propertyName)}</p>
        {property?.guest_auto_approve && (
          <p className="pq-empty-body">Short-term passes approve automatically at this property — only long-term registrations appear here.</p>
        )}
        {link && <button type="button" className="pq-btn pq-btn--quiet" onClick={copyLink}>Copy registration link</button>}
      </div>
    ) : (
      <div className="pq-empty">
        <p className="pq-empty-title">{segment === 'approved' ? 'No approved parking passes yet.' : 'No denied requests.'}</p>
      </div>
    );
  } else if (segment === 'pending') {
    listBody = groups.map(group => (
      <section key={group.key || 'none'} className="pq-group">
        <div className="pq-group-head">
          <h3 className="pq-group-title">{group.label}</h3>
          {group.variants.length > 0 && (
            <span className="pq-group-also">also entered as {group.variants.map(v => `“${v}”`).join(', ')}</span>
          )}
          {group.chip && <Tag tone={group.chip.over ? 'red' : 'neutral'}>{group.chip.text}</Tag>}
        </div>
        <ul className="pq-rows">
          {group.rows.map(row => <QueueRow key={row.key} {...rowProps(row, { showThumb: true, showUnit: false })} />)}
        </ul>
      </section>
    ));
  } else {
    listBody = (
      <ul className="pq-rows">
        {decided.map(row => <QueueRow key={row.key} {...rowProps(row, { showThumb: false, showUnit: true })} />)}
      </ul>
    );
  }

  const detail = selectedRow && (isWide || phoneDetail) ? (() => {
    const unitKey = normalizeUnit(unitText(selectedRow));
    const unitChip = isLongTerm(selectedRow) && unitKey ? capChip(unitTally(rows, unitKey), cap) : null;
    return (
      <RequestDetail
        row={selectedRow}
        isPhone={!isWide}
        headingRef={headingRef}
        propertyName={propertyName}
        cap={cap}
        overLimit={overKeys.has(selectedRow.key)}
        ageChip={ageChip(selectedRow, now)}
        unitChip={unitChip}
        saving={savingKeys.has(selectedRow.key)}
        moreItems={moreItemsFor(selectedRow)}
        nextKey={segmentOf(selectedRow) === 'pending' ? null : nextPendingKey(rows, { cap, q, after: selectedRow.key })}
        onBack={closeDetail}
        onApprove={approve}
        onDeny={openDeny}
        onNext={goNext}
        onZoom={setDocView}
      />
    );
  })() : null;

  const showPane = isWide && loaded && (visible.length > 0 || !!selectedRow);

  return (
    <DocCacheContext.Provider value={docCache}>
      <div className="pq" ref={rootRef}>
        {feedbackOpen && overlay(<FeedbackModal propertyId={propertyId} onClose={closeFeedback} />)}
        {docView && overlay(<DocViewerModal blob={docView.blob} label={docView.label} filename={docView.filename} onClose={closeDocView} />)}
        {sheet && sheetRow && sheet.type === 'deny' && overlay(
          <DenySheet
            row={sheetRow}
            propertyName={propertyName}
            cap={cap}
            towNote={property?.reject_tow_disclaimer === true}
            initialReason={sheet.initialReason}
            onClose={closeSheet}
            onDone={onDenied}
            onStale={onStale}
          />,
        )}
        {sheet && sheetRow && sheet.type === 'void' && overlay(
          <VoidSheet row={sheetRow} propertyName={propertyName} onClose={closeSheet} onDone={onVoided} onStale={onStale} />,
        )}
        {sheet && sheetRow && sheet.type === 'extend' && overlay(
          <ExtendPassSheet row={sheetRow} onClose={closeSheet} onDone={onExtended} onStale={onStale} />,
        )}
        <div className="pq-sr" role="status" aria-live="polite">{announcement}</div>

        <div className="pq-head" hidden={phoneDetail}>
          <h2 className="pq-title">Parking pass requests</h2>
          <div className="pq-controls">
            <div className="pq-segments" role="group" aria-label="Show requests">
              {SEGMENTS.map(s => (
                <button
                  key={s.id}
                  ref={el => { segmentRefs.current[s.id] = el; }}
                  type="button"
                  className="pq-segment"
                  aria-pressed={segment === s.id}
                  onClick={() => setSegment(s.id)}
                >
                  {s.label} <span className="pq-segment-count">({counts[s.id]})</span>
                </button>
              ))}
            </div>
            <div className="pq-tools">
              <label className="pq-search">
                <span className="pq-sr">Search by plate or unit</span>
                <input
                  type="search"
                  value={q}
                  maxLength={40}
                  onChange={e => setQ(e.target.value)}
                  placeholder="Plate or unit"
                  autoComplete="off"
                  spellCheck={false}
                  enterKeyHint="search"
                />
              </label>
              <button type="button" className="pq-btn pq-btn--quiet pq-btn--small" onClick={() => setFeedbackOpen(true)}>Feedback</button>
              <button type="button" className="pq-btn pq-btn--quiet pq-btn--small" onClick={refresh}>
                {loading && loaded ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>
          </div>
          {loaded && loadErr && (
            <div className="pq-banner" role="status">
              Couldn't refresh the list — what's shown may be out of date.
              <button type="button" className="pq-btn pq-btn--quiet pq-btn--small" onClick={refresh}>Retry</button>
            </div>
          )}
        </div>

        <div className={`pq-layout${showPane ? ' has-pane' : ''}`}>
          <div className="pq-list" hidden={phoneDetail}>{listBody}</div>
          {showPane && (
            <div className="pq-pane">
              {detail || <p className="pq-pane-empty">Choose a request to see its documents.</p>}
            </div>
          )}
        </div>
        {phoneDetail && detail}
      </div>
    </DocCacheContext.Provider>
  );
}
