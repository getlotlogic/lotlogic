import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getLotStatus } from '../../lib/requestsApi.js';
import { fmtPassRemaining } from '../../lib/time.js';
import { SkeletonCards } from '../../ui/Skeletons.jsx';
import { Tag } from '../permits/parts.jsx';
import {
  EMPTY_COPY,
  LIST_SEGMENTS,
  asOfLine,
  csvFilename,
  csvRows,
  csvText,
  filterByPlate,
  formatEnds,
  formatExpired,
  formatUntil,
  lastCheckLine,
  listTotals,
  passKindLabel,
  reasonTag,
  tiles,
} from '../../lib/lotStatus.js';

// ── State of the lot (task F7, spec 2026-10-15-lot-status §4) ──
//
// What a tow operator wants on arrival: six counts, then three lists - who is
// towable, who must not be touched, and what ends in the next four hours -
// each a row of plate, car and a time phrase. Rows carry plates, cars and times
// only; the office reaches names, units and documents through the pass detail
// (a row tap hands the row to `onOpenRow`). Read-only: nothing here writes.
//
// Every phrase is measured from the server's `as_of`, so the tab reads the way
// the Slack briefing does at the same instant. Refreshes by itself every 60 s
// while the page is visible.

const REFRESH_MS = 60000;

function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function LotRow({ list, row, asOf, onOpen }) {
  let side;
  let tags = null;
  if (list === 'towable') {
    side = (
      <>
        <span className="ls-when ls-when--stop">{formatExpired(row.hours_expired)}</span>
        <span className="ls-sub">{lastCheckLine(row.last_check, asOf)}</span>
      </>
    );
    tags = <Tag tone={row.kind === 'long_term' ? 'info' : 'neutral'}>{passKindLabel(row.kind)}</Tag>;
  } else if (list === 'do_not_tow') {
    const reason = reasonTag(row.reason);
    side = <span className="ls-when">{formatUntil(row.until, asOf)}</span>;
    tags = (
      <>
        <Tag tone={reason.tone}>{reason.label}</Tag>
        {row.ref && <Tag>{row.ref}</Tag>}
      </>
    );
  } else {
    side = (
      <>
        <span className="ls-when ls-when--warn">{formatEnds(row.until, asOf)}</span>
        {Number.isFinite(row.minutes_left) && <span className="ls-sub">{fmtPassRemaining(row.minutes_left * 60000)}</span>}
      </>
    );
    tags = <Tag tone={row.kind === 'long_term' ? 'info' : 'neutral'}>{passKindLabel(row.kind)}</Tag>;
  }
  return (
    <li className="ls-item">
      <button type="button" className="ls-row" onClick={e => onOpen(row, list, e.currentTarget)}>
        <span className="ls-row-main">
          <span className="ls-plate-line">
            <span className="ls-plate">{row.plate || '-'}</span>
            {tags}
          </span>
          {row.vehicle ? <span className="ls-car">{row.vehicle}</span> : null}
        </span>
        <span className="ls-row-side">{side}</span>
        <span className="pq-chevron" aria-hidden="true">›</span>
      </button>
    </li>
  );
}

export function LotStatusTab({ propertyId, propertyName = '', onOpenRow = () => {} }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState(null);
  const [segment, setSegment] = useState('towable');
  const [q, setQ] = useState('');
  const token = useRef(0);
  const lastLoad = useRef(0);

  const refresh = useCallback(async () => {
    if (!propertyId) return;
    const mine = ++token.current;
    setLoading(true);
    try {
      const res = await getLotStatus(propertyId);
      if (mine !== token.current) return;
      setData(res);
      setLoadErr(null);
      lastLoad.current = Date.now();
    } catch (e) {
      if (mine !== token.current) return;
      if (e?.status === 401) return;
      setLoadErr(e?.message || 'Could not load');
    } finally {
      if (mine === token.current) setLoading(false);
    }
  }, [propertyId]);

  useEffect(() => {
    setData(null);
    setLoadErr(null);
    refresh();
    return () => { token.current += 1; };
  }, [refresh]);

  // Auto-refresh while the page is visible; coming back to a stale tab refreshes at once.
  useEffect(() => {
    const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
    const id = setInterval(() => { if (visible()) refresh(); }, REFRESH_MS);
    const onVisible = () => { if (visible() && Date.now() - lastLoad.current >= REFRESH_MS) refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVisible); };
  }, [refresh]);

  const asOf = data?.as_of;
  const totals = useMemo(() => listTotals(data), [data]);
  const list = data && Array.isArray(data[segment]) ? data[segment] : [];
  const shown = useMemo(() => filterByPlate(list, q), [list, q]);
  const name = data?.property?.name || propertyName;

  const exportCsv = useCallback(() => {
    if (!data) return;
    downloadText(csvFilename(name, data.as_of), csvText(csvRows(data.towable)));
  }, [data, name]);

  let body;
  if (!data && loadErr) {
    body = (
      <div className="pq-empty pq-empty--error">
        <p>Couldn't load the lot status. This is not "nothing to tow".</p>
        <button type="button" className="pq-btn pq-btn--quiet pq-btn--small" onClick={refresh}>Retry</button>
      </div>
    );
  } else if (!data) {
    body = <SkeletonCards count={3} />;
  } else {
    const capped = totals[segment] > list.length;
    let rows;
    if (shown.length === 0) {
      rows = q.trim() ? (
        <div className="pq-empty">
          <p className="pq-empty-title">No plates match “{q.trim()}”.</p>
          <button type="button" className="pq-btn pq-btn--quiet pq-btn--small" onClick={() => setQ('')}>Clear search</button>
        </div>
      ) : (
        <div className="pq-empty"><p className="pq-empty-title">{EMPTY_COPY[segment]}</p></div>
      );
    } else {
      rows = (
        <ul className="ls-rows" aria-label={LIST_SEGMENTS.find(s => s.id === segment).label}>
          {shown.map((row, i) => (
            <LotRow key={`${segment}:${row.plate}:${row.ref || ''}:${i}`} list={segment} row={row} asOf={asOf} onOpen={onOpenRow} />
          ))}
        </ul>
      );
    }
    body = (
      <>
        {rows}
        {capped && !q.trim() && (
          <p className="ls-note">Showing the first {list.length} of {totals[segment]}.</p>
        )}
      </>
    );
  }

  return (
    <section className="ls" aria-label="Lot status" data-testid="lot-status">
      <div className="ls-head">
        <h2 className="pq-title">Lot status{name ? ` · ${name}` : ''}</h2>
        <div className="ls-asof">
          <span data-testid="ls-asof">{asOf ? asOfLine(asOf) : ''}</span>
          {asOf && <span aria-hidden="true"> · </span>}
          <button type="button" className="ls-refresh" onClick={refresh}>{loading && data ? 'Refreshing…' : 'Refresh'}</button>
        </div>
      </div>

      {data && loadErr && (
        <div className="pq-banner" role="status">
          Couldn't refresh the lot status. What's shown may be out of date.
          <button type="button" className="pq-btn pq-btn--quiet pq-btn--small" onClick={refresh}>Retry</button>
        </div>
      )}

      {data && (
        <dl className="ls-tiles" aria-label="Lot counts">
          {tiles(data.counts).map(t => (
            <div key={t.key} className={`ls-tile${t.key === 'towable' && t.value > 0 ? ' is-stop' : ''}`} data-testid={`ls-tile-${t.key}`}>
              <dt className="ls-tile-l">{t.label}</dt>
              <dd className="ls-tile-n">{t.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {data && (
        <div className="ls-controls">
          <div className="pq-segments" role="group" aria-label="Show plates">
            {LIST_SEGMENTS.map(s => (
              <button key={s.id} type="button" className="pq-segment" aria-pressed={segment === s.id} onClick={() => setSegment(s.id)}>
                {s.label} <span className="pq-segment-count">({totals[s.id]})</span>
              </button>
            ))}
          </div>
          <div className="pq-tools">
            <label className="pq-search">
              <span className="pq-sr">Search by plate</span>
              <input
                type="search"
                value={q}
                maxLength={12}
                onChange={e => setQ(e.target.value.toUpperCase())}
                placeholder="Plate"
                autoCapitalize="characters"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="search"
              />
            </label>
            {segment === 'towable' && list.length > 0 && (
              <button type="button" className="pq-btn pq-btn--quiet pq-btn--small" onClick={exportCsv}>Export CSV</button>
            )}
          </div>
        </div>
      )}

      <div className="ls-body">{body}</div>
    </section>
  );
}

export default LotStatusTab;
