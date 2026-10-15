import React, { useEffect, useRef, useState } from 'react';
import { useUid } from '../../ui/focusTrap.js';
import { docPath, downloadName, plateText, previewKind } from '../../lib/permitsQueue.js';
import { useDoc, useInView, useObjectUrl } from './docs.js';

// ── Evidence beside the claim ────────────────────────────────
// One card per document: what it should prove (built from the typed request),
// the document itself rendered inline once the card nears the viewport, and a
// Zoom into the full viewer. A file the browser cannot draw (HEIC on Chrome,
// an unknown type) offers Download instead; a document never sent says
// "Not provided".

export function EvidenceCard({ row, card, onZoom }) {
  const ref = useRef(null);
  const seen = useInView(ref);
  const titleId = useUid('pq-card');
  const path = card.present ? docPath(row, card.which) : null;
  const doc = useDoc(path, seen);
  const ready = doc.status === 'ready';
  const kind = ready ? previewKind(doc.blob?.type) : null;
  const url = useObjectUrl(ready ? doc.blob : null);
  const [broken, setBroken] = useState(false);
  useEffect(() => { setBroken(false); }, [doc.blob]);

  const plate = plateText(row);
  const undecodable = ready && (kind === 'none' || (kind === 'image' && broken));
  const canZoom = ready && !undecodable;
  const zoomLabel = `${card.title}${plate ? ` · ${plate}` : ''}`;
  const zoom = () => {
    if (canZoom) onZoom({ blob: doc.blob, label: zoomLabel, filename: downloadName(row, card.which, doc.blob?.type) });
  };

  let body;
  if (!card.present) {
    body = <p className="pq-well-note">Not provided</p>;
  } else if (doc.status === 'error') {
    body = (
      <div className="pq-well-note">
        <p>Couldn't load this document.</p>
        <button type="button" className="pq-btn pq-btn--quiet pq-btn--small" onClick={doc.retry}>Try again</button>
      </div>
    );
  } else if (!ready) {
    body = <div className="pq-well-loading" role="status"><span className="pq-sr">Loading {card.title}</span></div>;
  } else if (undecodable) {
    body = <p className="pq-well-note">Preview unavailable — Download to view</p>;
  } else if (kind === 'pdf') {
    body = (
      <div className="pq-pdf">
        <span className="pq-pdf-glyph" aria-hidden="true">PDF</span>
        <span>PDF document — Zoom to read it</span>
      </div>
    );
  } else {
    body = url ? (
      <img
        src={url}
        alt={`${card.title}${plate ? ` for ${plate}` : ''}`}
        className="pq-well-img"
        onError={() => setBroken(true)}
      />
    ) : null;
  }

  return (
    <article ref={ref} className={`pq-card${card.present ? '' : ' is-missing'}`} aria-labelledby={titleId}>
      <h4 id={titleId} className="pq-card-title">{card.title}</h4>
      <ul className="pq-should">
        {card.should.map(line => <li key={line}>{line}</li>)}
      </ul>
      {/* The well zooms on a tap too; keyboard users have the Zoom button. */}
      <div className={`pq-well${canZoom ? ' can-zoom' : ''}`} onClick={canZoom ? zoom : undefined}>
        {body}
      </div>
      {(canZoom || (undecodable && url)) && (
        <div className="pq-card-foot">
          {canZoom ? (
            <button type="button" className="pq-btn pq-btn--quiet pq-btn--small" onClick={zoom}>
              Zoom<span className="pq-sr"> {zoomLabel}</span>
            </button>
          ) : (
            <a href={url} download={downloadName(row, card.which, doc.blob?.type)} className="pq-btn pq-btn--quiet pq-btn--small">
              Download<span className="pq-sr"> {zoomLabel}</span>
            </a>
          )}
        </div>
      )}
    </article>
  );
}

/** The 56×42 plate-photo thumbnail on a Needs review row; decorative (the plate chip carries the text). */
export function PlateThumb({ row }) {
  const ref = useRef(null);
  const seen = useInView(ref);
  const doc = useDoc(row.has_plate ? docPath(row, 'plate') : null, seen);
  const isImage = doc.status === 'ready' && previewKind(doc.blob?.type) === 'image';
  const url = useObjectUrl(isImage ? doc.blob : null);
  const [broken, setBroken] = useState(false);
  return (
    <span ref={ref} className="pq-thumb" aria-hidden="true">
      {url && !broken ? <img src={url} alt="" onError={() => setBroken(true)} /> : null}
    </span>
  );
}
