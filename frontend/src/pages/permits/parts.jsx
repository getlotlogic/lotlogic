import React, { useEffect, useRef, useState } from 'react';
import { useUid } from '../../ui/focusTrap.js';
import { holderName, passTypeLabel, isLongTerm, plateText, unitLabel, unitText } from '../../lib/permitsQueue.js';

// ── Small shared pieces of the approval queue ─────────────────

export function PlateChip({ row, large = false }) {
  return <span className={`pq-plate${large ? ' pq-plate--lg' : ''}`}>{plateText(row) || '—'}</span>;
}

/** A status / type / age tag. The text always carries the meaning; tone is a second cue. */
export function Tag({ tone = 'neutral', children }) {
  return <span className={`pq-tag pq-tag--${tone}`}>{children}</span>;
}

export function TypeTag({ row }) {
  return <Tag tone={isLongTerm(row) ? 'info' : 'neutral'}>{passTypeLabel(row)}</Tag>;
}

/** "Unit 214 · Pat Example" — who and where, for rows and sheet summaries. */
export function whoLine(row) {
  const unit = unitText(row);
  return [unit ? unitLabel(unit) : null, holderName(row) || null].filter(Boolean).join(' · ');
}

/** The card at the top of every sheet: plate, pass type, unit and name. */
export function PassSummary({ row }) {
  const who = whoLine(row);
  return (
    <div className="pq-summary">
      <div className="pq-summary-line">
        <PlateChip row={row} />
        <TypeTag row={row} />
      </div>
      {who && <div className="pq-summary-who">{who}</div>}
    </div>
  );
}

/**
 * A 44 px "More actions" disclosure. Choosing an item hands focus back to the
 * toggle first, so a sheet the item opens restores focus somewhere that still
 * exists when it closes.
 */
export function MoreMenu({ label, items }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const buttonRef = useRef(null);
  const panelId = useUid('pq-more');

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('touchstart', onPointer, { passive: true });
    document.addEventListener('keydown', onKey);
    wrapRef.current?.querySelector('[data-pq-item]')?.focus();
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('touchstart', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!items.length) return null;
  return (
    <div className="pq-more" ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        className="pq-more-btn"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={label}
        onClick={() => setOpen(o => !o)}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {open && (
        <div id={panelId} className="pq-more-panel">
          {items.map(item => (
            <button
              key={item.id}
              type="button"
              data-pq-item=""
              className={`pq-more-item${item.danger ? ' is-danger' : ''}`}
              onClick={() => {
                setOpen(false);
                buttonRef.current?.focus();
                item.onSelect();
              }}
            >{item.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}
