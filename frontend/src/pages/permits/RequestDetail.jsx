import React from 'react';
import { useUid } from '../../ui/focusTrap.js';
import { fmtET } from '../../lib/holdTime.js';
import {
  decisionLine,
  evidenceCards,
  holderName,
  isLongTerm,
  segmentOf,
  statusTag,
  tagDateLabel,
  telHref,
  unitLabel,
  unitText,
  vehicleLine,
} from '../../lib/permitsQueue.js';
import { EvidenceCard } from './Evidence.jsx';
import { MoreMenu, PlateChip, Tag, TypeTag } from './parts.jsx';

// ── One request, documents beside the values they prove ──────
// The right pane on a laptop; on a phone it replaces the list (pushed with
// history.pushState by the page, so Back closes it) and its action bar sticks
// to the bottom of the screen, after the content in reading order.

export function RequestDetail({
  row,
  isPhone,
  headingRef,
  propertyName,
  cap,
  overLimit,
  ageChip,
  unitChip,
  saving,
  moreItems,
  nextKey,
  onBack,
  onApprove,
  onDeny,
  onNext,
  onZoom,
}) {
  const headingId = useUid('pq-detail');
  const segment = segmentOf(row);
  const status = statusTag(row);
  const longTerm = isLongTerm(row);
  const name = holderName(row);
  const unit = unitText(row);
  const car = vehicleLine(row);
  const phone = String(row.phone || '').trim();
  const email = String(row.email || '').trim();
  const tel = telHref(phone);
  const submitted = fmtET(row.created_at);
  const pending = segment === 'pending';

  return (
    <section className={`pq-detail${isPhone ? ' is-phone' : ''}`} aria-labelledby={headingId}>
      {isPhone && (
        <button type="button" className="pq-back" onClick={onBack}>
          <span aria-hidden="true">‹ </span>Back to queue
        </button>
      )}

      <div className="pq-detail-head">
        <h2 id={headingId} ref={headingRef} tabIndex={-1} className="pq-detail-title">
          <span className="pq-sr">Parking pass request for </span>
          <PlateChip row={row} large />
        </h2>
        {car && <p className="pq-vehicle">{car}</p>}
        <div className="pq-tags">
          <Tag tone={status.tone}>{status.text}</Tag>
          <TypeTag row={row} />
          {overLimit && <Tag tone="red">Over {cap}-vehicle limit</Tag>}
          {ageChip && <Tag tone={ageChip.tone}>{ageChip.text}</Tag>}
        </div>
        {submitted && <p className="pq-meta">Submitted {submitted}</p>}
      </div>

      <dl className="pq-identity">
        <div>
          <dt>Name</dt>
          <dd>{name || '—'}</dd>
        </div>
        <div>
          <dt>{longTerm ? 'Unit' : 'Visiting'}</dt>
          <dd>
            {unit ? unitLabel(unit) : '—'}
            {unitChip && <> <Tag tone={unitChip.over ? 'red' : 'neutral'}>{unitChip.text}</Tag></>}
          </dd>
        </div>
        <div>
          <dt>Phone</dt>
          <dd>{tel ? <a href={tel}>{phone}</a> : (phone || '—')}</dd>
        </div>
        <div>
          <dt>Email</dt>
          <dd>{email ? <a href={`mailto:${email}`}>{email}</a> : '—'}</dd>
        </div>
        {!longTerm && row.valid_until && segment === 'approved' && (
          <div>
            <dt>Pass ends</dt>
            <dd>{fmtET(row.valid_until)}</dd>
          </div>
        )}
        {row.is_temp_tag && (
          <div>
            <dt>Temp tag</dt>
            <dd>
              {row.tag_expiration ? `Expires ${tagDateLabel(row.tag_expiration)}` : 'Yes'}
              {row.tag_expired && <> <Tag tone="red">Tag expired</Tag></>}
            </dd>
          </div>
        )}
      </dl>

      {pending && overLimit && (
        <p className="pq-callout">
          Approving this would put {unit ? unitLabel(unit) : 'this unit'} over its {cap}-vehicle limit
          {propertyName ? ` at ${propertyName}` : ''}.
        </p>
      )}

      <h3 className="pq-section-label">Documents</h3>
      <div className="pq-evidence">
        {evidenceCards(row).map(card => (
          <EvidenceCard key={`${row.key}:${card.which}`} row={row} card={card} onZoom={onZoom} />
        ))}
      </div>

      {segment === 'denied' && row.reject_reason && (
        <div className="pq-preview">
          <div className="pq-preview-label">Reason sent</div>
          <p className="pq-preview-text">{row.reject_reason}</p>
        </div>
      )}

      <div className="pq-actions">
        {pending ? (
          overLimit ? (
            <>
              <button type="button" className="pq-btn pq-btn--deny pq-btn--grow" onClick={() => onDeny(row, { viaOverLimit: true })}>
                Deny (over limit)
              </button>
              <button type="button" className="pq-btn pq-btn--deny-quiet" onClick={() => onDeny(row, {})}>Deny</button>
            </>
          ) : (
            <>
              <button type="button" className="pq-btn pq-btn--approve pq-btn--grow" onClick={() => onApprove(row)}>Approve</button>
              <button type="button" className="pq-btn pq-btn--deny" onClick={() => onDeny(row, {})}>Deny</button>
            </>
          )
        ) : (
          <>
            <p className="pq-actions-note">{saving ? 'Saving…' : decisionLine(row)}</p>
            <MoreMenu label="More actions for this parking pass" items={moreItems} />
            {nextKey && (
              <button type="button" className="pq-btn pq-btn--quiet" onClick={() => onNext(nextKey)}>Next request</button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
