import React, { useEffect, useRef, useState } from 'react';
import {
  actionsFor,
  isActive,
  isEndingSoon,
  placedByLine,
  refWithLineage,
  seenLine,
  timeLeftLabel,
  truncateNote,
  vehicleText,
} from '../../lib/partnerRequests.js';

// ── One request, as N Style's crew reads it (spec §5.4) ────────
//
//   ABC1234  ✋ HOLD   2d 4h left  H-1842
//   until Fri Oct 10, 6:00 PM ET
//   Dana Ortiz (Property manager) · 4:12 PM
//   2019 Honda Civic gray · "mom…" [📷]
//   Seen ✓ · checked 3×
//   [ Got it ]                           ⋯
//
// The deadline line is the server's `expires_local` verbatim — no client
// timezone math decides what the truck sees. Everything else comes out of
// `lib/partnerRequests.js`, which is where the tests hold this copy.

// The kind is never color alone (spec §5): the glyph and the word carry it,
// and the colour is the tint and the edge. The ink is --text-primary because
// a 10 px status colour on its own 15 % tint is 2.2–2.4:1 in .theme-light.
//
// `edge` and `tint` are a 1 px border and a 15 % wash — never an ink, so
// nothing here is read by a contrast check, and §5's "tokens only" rule has
// no token to offer for the photo blue. They are deliberately literals;
// every ink below is a `var(--…)`, which is what the light theme needs.
const KIND_CHIP = {
  hold: { glyph: '✋', label: 'HOLD', edge: '#22c55e', tint: 'rgba(34,197,94,.15)' },
  tow: { glyph: '🚨', label: 'TOW', edge: '#f87171', tint: 'rgba(248,113,113,.15)' },
  photo: { glyph: '📷', label: 'PHOTO', edge: '#60a5fa', tint: 'rgba(96,165,250,.15)' },
};

const BTN = {
  border: '1px solid var(--border)', borderRadius: 8, padding: '9px 14px',
  fontSize: 13, fontWeight: 700, cursor: 'pointer', minHeight: 44,
  background: 'var(--bg-inset)', color: 'var(--text-primary)', fontFamily: 'inherit',
};
const PRIMARY = { ...BTN, background: 'var(--accent)', color: 'var(--accent-ink)', border: '1px solid var(--accent)' };

const MENU_LABEL = {
  towed_anyway: 'Towed anyway',
  decline: 'Decline…',
  history: 'History',
};

const BUTTON_LABEL = {
  ack: 'Got it',
  towed: 'Towed ✓',
  photographed: 'Photo sent ✓',
  decline: 'Decline…',
};

export function PartnerRequestRow({ item, now, busy, onAction }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  const chip = KIND_CHIP[item.kind] || KIND_CHIP.hold;
  const { buttons, menu } = actionsFor(item);
  const left = timeLeftLabel(item, now);
  const urgent = isEndingSoon(item, now);
  // A terminal row reads as an outcome in words, not a countdown — and the
  // pill keeps full-contrast ink so it clears 4.5:1 in both themes (§5.2).
  const ended = !isActive(item);
  const vehicle = vehicleText(item);
  const note = truncateNote(item.note);
  const seen = seenLine(item);
  const placed = placedByLine(item);

  // Close the overflow on Escape and on a click anywhere else, so a tap on
  // another row's ⋯ does not leave two menus open.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') setMenuOpen(false); };
    const onDown = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown); };
  }, [menuOpen]);

  const act = (action) => { setMenuOpen(false); onAction(action, item); };

  return (
    <li
      style={{
        listStyle: 'none', borderTop: '1px solid var(--border)', padding: '12px 0',
        opacity: busy ? 0.6 : 1,
      }}
      aria-busy={busy ? 'true' : undefined}
    >
      {/* line 1 — plate, kind, countdown, reference number */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 15, fontWeight: 800, letterSpacing: '.04em', color: 'var(--text-primary)' }}>
          {item.plate}
        </span>
        <span style={{
          ...{ fontSize: 10, fontWeight: 800, padding: '2px 6px', borderRadius: 3, letterSpacing: '.04em' },
          background: chip.tint, color: 'var(--text-primary)', border: `1px solid ${chip.edge}`,
        }}>
          <span aria-hidden="true">{chip.glyph} </span>{chip.label}
        </span>
        {left && (
          <span style={ended ? {
            fontSize: 11, fontWeight: 800, padding: '2px 7px', borderRadius: 999,
            background: 'var(--bg-inset)', color: 'var(--text-primary)',
            border: '1px solid var(--border)',
          } : { fontSize: 12, fontWeight: 700, color: urgent ? 'var(--yellow)' : 'var(--text-muted)' }}>
            {urgent && <span aria-hidden="true">⚠ </span>}{left}
          </span>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 700, color: 'var(--text-muted)' }}>
          {refWithLineage(item)}
        </span>
      </div>

      {/* line 2 — the deadline, exactly as the server rendered it */}
      {item.kind === 'hold'
        ? item.expires_local && (
          <div style={{ fontSize: 12, color: urgent ? 'var(--yellow)' : 'var(--text-muted)', marginTop: 3 }}>
            until {item.expires_local}
          </div>
        )
        : item.note && (
          <div style={{ fontSize: 13, color: 'var(--text-primary)', marginTop: 3 }}>“{item.note}”</div>
        )}

      {/* line 3 — who asked, and when */}
      {placed && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>{placed}</div>}

      {/* line 4 — the car, the note, the photo */}
      {(vehicle || (item.kind === 'hold' && note) || item.has_photo) && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>
          {[vehicle, item.kind === 'hold' && note ? `“${note}”` : ''].filter(Boolean).join(' · ')}
          {item.has_photo && (
            <button
              type="button"
              onClick={() => act('photo')}
              style={{ ...BTN, minHeight: 0, padding: '1px 6px', marginLeft: 6, fontSize: 12 }}
            >
              <span aria-hidden="true">📷</span> Photo
            </button>
          )}
        </div>
      )}

      {/* line 5 — picked up, and how many times the plate has been checked */}
      {seen && <div style={{ fontSize: 12, color: 'var(--green-text)', marginTop: 3 }}>{seen}</div>}

      {/* controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        {buttons.map(action => (
          <button
            key={action}
            type="button"
            style={action === 'ack' ? PRIMARY : BTN}
            onClick={() => act(action)}
            aria-label={`${BUTTON_LABEL[action]} — ${item.plate}, ${item.ref}`}
          >
            {BUTTON_LABEL[action]}
          </button>
        ))}
        <div ref={menuRef} style={{ position: 'relative', marginLeft: 'auto' }}>
          <button
            type="button"
            style={{ ...BTN, padding: '9px 12px' }}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`More actions for ${item.ref}`}
            onClick={() => setMenuOpen(o => !o)}
          >
            ⋯
          </button>
          {menuOpen && (
            <div
              role="menu"
              style={{
                position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 20,
                background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10,
                minWidth: 180, padding: 6, boxShadow: '0 10px 30px rgba(0,0,0,.35)',
              }}
            >
              {menu.map(action => (
                <button
                  key={action}
                  role="menuitem"
                  type="button"
                  onClick={() => act(action)}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left', background: 'transparent',
                    color: 'var(--text-primary)', border: 'none', borderRadius: 6,
                    padding: '10px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                  }}
                >
                  {MENU_LABEL[action]}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

export default PartnerRequestRow;
