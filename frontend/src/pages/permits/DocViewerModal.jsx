import React, { useEffect, useRef, useState } from 'react';
import { useFocusTrap, useUid } from '../../ui/focusTrap.js';
import { previewKind } from '../../lib/permitsQueue.js';

// ── In-page PII document viewer (the queue's Zoom) ───────────
// Renders an already-fetched (authed) blob INLINE rather than opening a new
// tab: `window.open(blob:, '_blank', 'noopener')` is unreliable on mobile
// Safari and lands on a blank tab. Images render in an <img>, PDFs in a
// sandboxed <iframe>; a file the browser cannot decode (HEIC on Chrome) says
// so and keeps Download. The object URL is revoked when the modal closes.
// `onClose` must be stable — the focus trap re-runs when it changes.
export function DocViewerModal({ blob, label, filename, onClose }) {
  const dialogRef = useRef(null);
  const titleId = useUid('doc-title');
  useFocusTrap(dialogRef, true, onClose);

  const [objectUrl, setObjectUrl] = useState(null);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    if (!blob) return undefined;
    const url = URL.createObjectURL(blob);
    setObjectUrl(url);
    setBroken(false);
    return () => URL.revokeObjectURL(url);
  }, [blob]);

  const kind = previewKind(blob?.type);
  const showImage = kind === 'image' && !broken;

  return (
    <div className="pq-viewer-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="pq-viewer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
      >
        <div className="pq-viewer-head">
          <div id={titleId} className="pq-viewer-title">{label || 'Document'}</div>
          <div className="pq-viewer-tools">
            {objectUrl && (
              <a href={objectUrl} download={filename || true} className="pq-btn pq-btn--quiet pq-btn--small">Download</a>
            )}
            <button type="button" onClick={onClose} className="pq-btn pq-btn--quiet pq-btn--small">Close</button>
          </div>
        </div>
        <div className="pq-viewer-body">
          {!objectUrl ? (
            <div className="pq-viewer-note">Loading…</div>
          ) : kind === 'pdf' ? (
            <iframe src={objectUrl} title={label || 'Document'} sandbox="" className="pq-viewer-frame" />
          ) : showImage ? (
            <img src={objectUrl} alt={label || 'Document'} className="pq-viewer-img" onError={() => setBroken(true)} />
          ) : (
            <div className="pq-viewer-note">Preview unavailable — Download to view</div>
          )}
        </div>
      </div>
    </div>
  );
}
