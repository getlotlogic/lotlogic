import React, { useState, useEffect, useCallback, useRef, useMemo, memo } from 'react';
// ── Frank's app-preview tab (partner: NMLD only) ─────────────────────────
// Live embed of the NMLD Parking app (nmld-parking-preview.vercel.app)
// framed as a phone, with partner-pitch copy. The surrounding page uses
// dashboard vars so the tab reads native; the app's cream brand appears
// only inside the bezel.

const NMLD_APP_URL = 'https://nmld-parking-preview.vercel.app';
const NMLD_APP_QR = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAALoAAAC6CAIAAACWbMCmAAAD3ElEQVR4nO3dMW4bMRCGUTvIMbbI/U+VYg/gNkWAHGAb/tQMSTnvlYElRfEHIgPucj///vn6gDE/Bn8O5EJGLgTkQkAuBH4+/+i6fn3sc9+/m975+b2enzXy3e+pv+HIp4+8aqXn39DqQkAuBORCQC4E5MJrk9HeaaVvxhn5FiPvcxW985y9vwurCwG5EJALAbkQkAvVk1HVRLNyOqja2Rl556ttp+m034XVhYBcCMiFgFwIyIX+yWivqvmlasK6p3aa5j5rL6sLAbkQkAsBuRCQC999Mlp5xd3cPPWOU88IqwsBuRCQCwG5EJAL/ZPRyv/nV51dMLJr03fiwVU0Ye39XVhdCMiFgFwIyIWAXKiejPaekHbaDtHVdrbD+afVWV0IyIWAXAjIhYBcCHy+4/OMVp450HfW99W2i9TH6kJALgTkQkAuBORC9fOM5vYyVk4QVad/z73qbvv3OW2esroQkAsBuRCQCwG5cMaeUd8EUaXvjO6nvivl+q7T86RXXiIXAnIhIBcCcqF6z6hqXjhtz6jPvfCMu75/+SerCwG5EJALAbkQkAs79oxOuxJs5Tx1v+FJfU8mI4rJhYBcCMiFgFyonoxW3kO08lV9+1P3wmvnRt656ltYXQjIhYBcCMiFgFzon4z27q3s3TeZs/fTq1hdCMiFgFwIyIWAXNhxNt3I+1R9Vt91eqfNXNfW+6fsGfESuRCQCwG5EJALr01GK2eBlSe/Vb2qysqr8qpmSasLAbkQkAsBuRCQCzvOpjvtlOy5d66ale6FM5fnGXEouRCQCwG5EJALO+4zWvlUnb5r3vbOU5fnGfGdyIWAXAjIhYBcOOM+o9OeOtQ3PVWpelZR3ze1uhCQCwG5EJALAbmw4z6jlTs7fSdpz7kWfvreedPqQkAuBORCQC4E5MIZe0Yj9j4/6PmquVMjRlTNL3PvU/U7tboQkAsBuRCQCwG50L9ntPJnTju1+2rbo1k5c3nSK+3kQkAuBORCQC70n03XZ2Qf5/wz5e6i6wZX3vPl1G6KyYWAXAjIhYBceG0yOu0Onaqfecfz6+6tp6PbM+IlciEgFwJyISAXqiejp9Oex1p1IsTcZ11b7yF6cjYdR5ALAbkQkAsBudA/Ga209+q+d3zK7dU2t1pdCMiFgFwIyIWAXPhek9FpZ31fU1fKjbzP+U+wtboQkAsBuRCQCwG50D8Z9d15NGflXTx7T7RbeYb5k9WFgFwIyIWAXAjIherJaO/1bH0ncq+c+O6pPZqVu1ojrC4E5EJALgTkQkAuBD7//vlKfp7/mtWFgFwIyIWAXAjIhY9x/wDS7j9x732MRgAAAABJRU5ErkJggg==';

export function PartnerAppPage() {
  const [loaded, setLoaded] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [frameKey, setFrameKey] = React.useState(0);
  const [narrow, setNarrow] = React.useState(() => window.matchMedia('(max-width: 1100px)').matches);
  React.useEffect(() => {
    const mq = window.matchMedia('(max-width: 1100px)');
    const fn = (e) => setNarrow(e.matches);
    mq.addEventListener ? mq.addEventListener('change', fn) : mq.addListener(fn);
    return () => { mq.removeEventListener ? mq.removeEventListener('change', fn) : mq.removeListener(fn); };
  }, []);
  React.useEffect(() => {
    if (loaded) return;
    const t = setTimeout(() => { if (!loaded) setFailed(true); }, 30000);
    return () => clearTimeout(t);
  }, [loaded, frameKey]);

  const scale = narrow ? 0.66 : 0.75;
  const boxW = Math.round(414 * scale), boxH = Math.round(868 * scale);
  const bullets = [
    ['$', 'Book ahead, pay online', 'Drivers reserve and pay before they arrive. No cash, no envelope drop.'],
    ['#', 'Numbered spots', 'Every reservation is a specific spot. No circling, no doubling up.'],
    ['▤', 'The plate is the pass', "Cameras verify who's parked. No permits, no tags, no gate hardware."],
    ['⚑', 'Enforcement built in', 'Unreserved trucks get flagged automatically — and NMLD runs the tows.'],
    ['⏱', 'Live rates', null],
  ];
  const phone = (
    <div style={{width: boxW, height: boxH}}>
      <div style={{transform: `scale(${scale})`, transformOrigin: 'top left'}}>
        <div style={{position:'relative', width:414, height:868, padding:12, background:'#101113', border:'1px solid var(--border)', borderRadius:54, boxShadow:'0 24px 60px rgba(0,0,0,.5), inset 0 0 0 2px #2A2C31'}}>
          <div style={{position:'absolute', width:96, height:26, borderRadius:13, background:'#101113', top:22, left:'50%', transform:'translateX(-50%)', zIndex:2}} />
          <div style={{position:'absolute', width:110, height:5, borderRadius:3, background:'#3A3D44', bottom:11, left:'50%', transform:'translateX(-50%)', zIndex:2}} />
          <iframe key={frameKey} src={NMLD_APP_URL + "?embed=1"} title="NMLD Parking live preview" loading="lazy"
            onLoad={() => { setLoaded(true); setFailed(false); }}
            style={{width:390, height:818, border:0, borderRadius:'40px 40px 14px 14px', background:'#F2EAD8', opacity: loaded ? 1 : 0, transition:'opacity .3s'}} />
          {!loaded && !failed && (
            <div style={{position:'absolute', inset:12, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:10, borderRadius:40, background:'#F2EAD8'}}>
              <span className="spin" />
              <span style={{fontSize:12, color:'#6E6350'}}>Loading preview…</span>
            </div>
          )}
          {failed && (
            <div style={{position:'absolute', inset:12, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:8, borderRadius:40, background:'var(--bg-inset)', padding:24, textAlign:'center'}}>
              <span style={{fontSize:13, fontWeight:700, color:'var(--text-secondary)'}}>The preview is taking a while.</span>
              <span style={{fontSize:12, color:'var(--text-muted)'}}>Slow connection or a cold start — it may still appear on its own.</span>
              <button onClick={() => { setFailed(false); setLoaded(false); setFrameKey(k => k + 1); }}
                style={{marginTop:6, background:'var(--bg-inset)', border:'1px solid var(--border)', borderRadius:8, padding:'6px 14px', fontSize:12, fontWeight:700, color:'var(--text-primary)', cursor:'pointer'}}>
                Retry
              </button>
              <a href={NMLD_APP_URL} target="_blank" rel="noopener" style={{fontSize:12, color:'var(--accent)'}}>Open in browser instead</a>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div style={{width:'min(1020px, calc(100vw - 32px))', position:'relative', left:'50%', transform:'translateX(-50%)'}}>
      <div style={{fontSize:12, fontWeight:700, letterSpacing:'.08em', color:'var(--accent)', textTransform:'uppercase'}}>NMLD Parking</div>
      <h2 className="section-title" style={{fontSize:26, margin:'6px 0 8px'}}>Your parking app. Your name on it.</h2>
      <p style={{fontSize:14, color:'var(--text-muted)', maxWidth:560, lineHeight:1.55, margin:0}}>
        This is NMLD Parking — reservations, payments, and enforcement for your truck lot, running live below.
        When it ships, it's published under your own App Store and Google Play listing, powered by LotLogic.
      </p>
      <div style={{display:'flex', gap:32, alignItems: narrow ? 'center' : 'flex-start', marginTop:24, flexDirection: narrow ? 'column' : 'row'}}>
        <div style={{display:'flex', flexDirection:'column', alignItems:'center', gap:10}}>
          {phone}
          <div style={{fontSize:12, color:'var(--text-faint)', textAlign:'center', maxWidth: boxW}}>
            Live preview — the shipping version installs from the App Store and Google Play as NMLD Parking.
          </div>
        </div>
        <div style={{flex:1, minWidth:300, maxWidth: narrow ? 480 : undefined, width: narrow ? '100%' : undefined}}>
          {bullets.map(([glyph, title, body]) => (
            <div key={title} style={{display:'flex', gap:12, marginBottom:16}}>
              <div style={{width:28, height:28, borderRadius:8, background:'var(--bg-inset)', border:'1px solid var(--border)', display:'flex', alignItems:'center', justifyContent:'center', color:'var(--accent)', fontSize:14, fontWeight:800, flexShrink:0}}>{glyph}</div>
              <div>
                <div style={{fontSize:14, fontWeight:700, color:'var(--text-primary)'}}>{title}</div>
                <div style={{fontSize:13, color:'var(--text-muted)', lineHeight:1.5}}>
                  {body || (
                    <React.Fragment>
                      <span style={{color:'var(--accent)', fontVariantNumeric:'tabular-nums', fontWeight:700}}>$35</span> a night,{' '}
                      <span style={{color:'var(--accent)', fontVariantNumeric:'tabular-nums', fontWeight:700}}>$50</span> for 48 hours — shown in-app before anyone commits.
                    </React.Fragment>
                  )}
                </div>
              </div>
            </div>
          ))}
          <div style={{background:'var(--bg-card)', border:'1px solid var(--border)', borderRadius:14, padding:16, display:'flex', gap:14, alignItems:'center', marginTop:20}}>
            <div style={{flex:1}}>
              <div style={{fontSize:13, fontWeight:700, color:'var(--text-primary)', marginBottom:4}}>Open on your phone</div>
              <a href={NMLD_APP_URL} target="_blank" rel="noopener" style={{fontSize:13, color:'var(--accent)', fontFamily:'ui-monospace, monospace'}}>nmld-parking-preview.vercel.app</a>
            </div>
            <img src={NMLD_APP_QR} alt="QR code to open the NMLD Parking preview" width={96} height={96} style={{borderRadius:8, background:'#fff', padding:4}} />
          </div>
        </div>
      </div>
    </div>
  );
}
