import React from 'react';
import { fmtPassRemaining } from '../../lib/time.js';
import {
  decisionLine,
  evidenceCards,
  holderName,
  isLongTerm,
  plateText,
  segmentOf,
} from '../../lib/permitsQueue.js';
import { PlateThumb } from './Evidence.jsx';
import { MoreMenu, PlateChip, Tag, TypeTag, whoLine } from './parts.jsx';

// ── One request in the list ──────────────────────────────────
// The whole row opens the request; its "More actions" menu (Approved only)
// sits beside the row button, never inside it.

function DocPill({ card }) {
  if (card.present) {
    return (
      <span className="pq-doc">
        <span aria-hidden="true">✓</span>{card.short}<span className="pq-sr"> provided</span>
      </span>
    );
  }
  const missing = card.which === 'plate' ? 'No plate photo'
    : card.which === 'vehicle' ? 'No car photo'
      : card.which === 'id' ? 'No ID'
        : `No ${card.short.toLowerCase()}`;
  return <span className="pq-doc is-missing">{missing}</span>;
}

/** Time left on a live short-term pass, amber in its last hour (the old roster's chip). */
function RemainingTag({ row, now }) {
  if (!row.valid_until) return null;
  const left = new Date(row.valid_until).getTime() - now;
  if (!Number.isFinite(left)) return null;
  return <Tag tone={left > 0 && left < 3600000 ? 'amber' : left > 0 ? 'green' : 'neutral'}>{fmtPassRemaining(left)}</Tag>;
}

export function QueueRow({ row, now, selected, overLimit, cap, ageChip, showThumb, showUnit, moreItems, onOpen }) {
  const segment = segmentOf(row);
  const cards = evidenceCards(row);
  const who = showUnit ? whoLine(row) : holderName(row);
  const live = segment === 'approved' && !isLongTerm(row);
  return (
    <li className={`pq-row${selected ? ' is-selected' : ''}`}>
      <button
        type="button"
        className="pq-row-main"
        aria-current={selected ? 'true' : undefined}
        onClick={e => onOpen(row, e.currentTarget)}
      >
        {showThumb && <PlateThumb row={row} />}
        <span className="pq-row-body">
          <span className="pq-row-line">
            <PlateChip row={row} />
            <TypeTag row={row} />
            {overLimit && <Tag tone="red">Over {cap}-vehicle limit</Tag>}
            {segment === 'denied' && <Tag tone="red">Denied</Tag>}
            {row.is_temp_tag && <Tag>Temp tag</Tag>}
            {row.tag_expired && <Tag tone="red">Tag expired</Tag>}
          </span>
          {who && <span className="pq-row-who">{who}</span>}
          <span className="pq-docs">{cards.map(card => <DocPill key={card.which} card={card} />)}</span>
          {ageChip ? (
            <span className="pq-row-meta"><Tag tone={ageChip.tone}>{ageChip.text}</Tag></span>
          ) : (
            <span className="pq-row-meta">
              {live && <RemainingTag row={row} now={now} />}
              <span className="pq-row-when">{decisionLine(row)}</span>
            </span>
          )}
        </span>
        <span className="pq-chevron" aria-hidden="true">›</span>
      </button>
      {moreItems.length > 0 && <MoreMenu label={`More actions for ${plateText(row) || 'this parking pass'}`} items={moreItems} />}
    </li>
  );
}
