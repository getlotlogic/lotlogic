import React, { useState, useEffect, useCallback, useRef } from 'react';

// ── Violation snapshot with AI bounding box ───────────────────
// Renders a snapshot image with a single bounding box around the
// violating vehicle only. Computes object-fit:cover offset so the
// box aligns perfectly with the actual image pixels.
export function ViolationSnapshot({ src, detections, matchedDetection, style, onClick, maxHeight, borderRadius }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const imgRef = useRef(null);
  const wrapRef = useRef(null);
  const [coverPos, setCoverPos] = useState(null);

  // Compute object-fit:cover offset so SVG bbox aligns with image
  const calcCover = useCallback(() => {
    const img = imgRef.current;
    const wrap = wrapRef.current;
    if (!img || !wrap || !img.naturalWidth || !img.naturalHeight) return;
    const cW = wrap.clientWidth, cH = wrap.clientHeight;
    const nW = img.naturalWidth, nH = img.naturalHeight;
    // object-fit:cover scales to fill, then centers the overflow
    const scale = Math.max(cW / nW, cH / nH);
    const rW = nW * scale, rH = nH * scale;
    const offX = (cW - rW) / 2, offY = (cH - rH) / 2;
    setCoverPos({ offX, offY, rW, rH });
  }, []);

  useEffect(() => {
    if (!src || loaded || failed) return;
    const t = setTimeout(() => setFailed(true), 10000);
    return () => clearTimeout(t);
  }, [src, loaded, failed]);

  if (!src || failed) return (
    <div style={{width:'100%', aspectRatio:'16/7', background:'var(--bg-inset)', display:'flex', alignItems:'center', justifyContent:'center', borderRadius: borderRadius || 8, ...(style || {})}}>
      <span style={{color:'var(--text-ghost)', fontSize:12, fontWeight:500}}>No photo</span>
    </div>
  );
  const singleDet = matchedDetection && matchedDetection.bbox?.length === 4 ? matchedDetection : null;
  const DET_COLORS = { car: '#3b82f6', truck: '#8b5cf6', bus: '#0d9488', motorcycle: '#ea580c', person: '#f59e0b' };
  return (
    <div style={{borderRadius: borderRadius || 8, overflow:'hidden', background:'var(--snapshot-bg)', ...(style || {})}}>
      <div ref={wrapRef} style={{position:'relative'}}>
        <img
          ref={imgRef}
          src={src} alt="Violation snapshot"
          onLoad={() => { setLoaded(true); setTimeout(calcCover, 0); }}
          onError={() => setFailed(true)}
          onClick={onClick}
          style={{width:'100%', display: loaded ? 'block' : 'none', maxHeight: maxHeight || 'none', objectFit:'cover', cursor: onClick ? 'zoom-in' : 'default'}}
        />
        {!loaded && (
          <div style={{width:'100%', aspectRatio:'16/9', display:'flex', alignItems:'center', justifyContent:'center'}}>
            <div className="spin" style={{marginRight:8}} />
            <span style={{color:'var(--text-ghost)', fontSize:12}}>Loading…</span>
          </div>
        )}
        {loaded && singleDet && coverPos && (() => {
          const [x1, y1, x2, y2] = singleDet.bbox;
          const cls = (singleDet.class || 'vehicle').toLowerCase();
          const color = DET_COLORS[cls] || '#3b82f6';
          // Convert normalized bbox (0-1) to pixel positions within the scaled image
          const px = coverPos.offX + x1 * coverPos.rW;
          const py = coverPos.offY + y1 * coverPos.rH;
          const pw = (x2 - x1) * coverPos.rW;
          const ph = (y2 - y1) * coverPos.rH;
          return (
            <div style={{
              position:'absolute', left:px, top:py, width:pw, height:ph,
              border:`2px solid ${color}`, borderRadius:3,
              pointerEvents:'none', boxSizing:'border-box',
            }} />
          );
        })()}
      </div>
    </div>
  );
}
