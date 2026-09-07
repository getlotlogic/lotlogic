import React, { useState, useEffect, useCallback, useRef, useMemo, memo } from 'react';
import { supabase } from '../../lib/supabase.js';

function normalizeTruckPlate(s) {
  return (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// ── Tow-truck plates editor (enforcement partner self-settings) ────
// Writes directly to enforcement_partners.tow_truck_plates via Supabase REST.
// Normalization matches the tow-confirm edge function so stored plates
// compare cleanly against camera sightings.
export function TowTruckPlatesEditor({ user }) {
  const [plates, setPlates] = React.useState(() => (user?.tow_truck_plates || []).slice());
  const [draft, setDraft] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState('');
  const [saved, setSaved] = React.useState(false);

  // Stringified signature of the incoming plates array. Using just `user?.id`
  // missed updates where the parent refetched and only the plates array
  // mutated (same user id, different list). Re-sync whenever the list
  // content changes.
  const userPlatesKey = JSON.stringify(user?.tow_truck_plates ?? []);
  React.useEffect(() => {
    // Re-sync on user id change or plates array content change.
    setPlates((user?.tow_truck_plates || []).slice());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, userPlatesKey]);

  // Track last persist intent so we can show an "added" vs. generic save message.
  // Stateful instead of a function arg so the flag survives the async setTimeout.
  const [lastAction, setLastAction] = React.useState(null); // 'added' | 'removed' | null

  async function persist(next, action) {
    setSaving(true); setErr(''); setSaved(false);
    try {
      if (!supabase || !user?.id) throw new Error('Not authenticated');
      const { error } = await supabase
        .from('enforcement_partners')
        .update({ tow_truck_plates: next })
        .eq('id', user.id);
      if (error) throw new Error(error.message);
      setPlates(next);
      setLastAction(action || null);
      setSaved(true);
      // Longer linger on the "Plate added" banner — it carries instructional
      // copy the partner needs time to read.
      setTimeout(() => setSaved(false), action === 'added' ? 4000 : 1500);
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setSaving(false);
    }
  }

  function addPlate() {
    const norm = normalizeTruckPlate(draft);
    if (!norm) { setDraft(''); return; }
    if (plates.includes(norm)) { setDraft(''); return; }
    const next = [...plates, norm];
    setDraft('');
    persist(next, 'added');
  }

  function removePlate(p) {
    const next = plates.filter(x => x !== p);
    persist(next, 'removed');
  }

  return React.createElement('div', { className: 'settings-section', id: 'tow-truck-plates' },
    React.createElement('div', {
      className: 'settings-section-title',
      style: { display: 'flex', alignItems: 'center', gap: 6 },
    },
      'Tow-truck plates',
      // Info glyph with native tooltip — clarifies when auto-confirmation runs.
      React.createElement('span', {
        'aria-label': 'Auto-confirmation runs when one of these plates is seen by the property\'s cameras after you report a tow.',
        title: 'Auto-confirmation runs when one of these plates is seen by the property\'s cameras after you report a tow.',
        role: 'img',
        tabIndex: 0,
        style: {
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 16, height: 16, borderRadius: '50%', fontSize: 11, fontWeight: 700,
          background: 'var(--bg-inset)', color: 'var(--text-muted)',
          border: '1px solid var(--border)', cursor: 'help',
        }
      }, 'i'),
    ),
    React.createElement('div', {
      style: { fontSize: 12, color: 'var(--text-muted)', padding: '0 0 10px' }
    }, 'Plates of tow trucks operated by this partner. Camera sightings of these plates confirm that a tow actually happened.'),

    React.createElement('div', {
      style: { display: 'flex', flexWrap: 'wrap', gap: 6, padding: '4px 0 10px' }
    },
      plates.length === 0
        ? React.createElement('div', { style: { fontSize: 12, color: 'var(--text-faint)', lineHeight: 1.45 } },
            React.createElement('div', { style: { color: 'var(--text-muted)', marginBottom: 4 } },
              'No plates registered yet. ',
              React.createElement('strong', { style: { color: 'var(--text-primary)', fontWeight: 700 } },
                'Add your tow-truck plates so camera sightings automatically confirm your tows.'),
            ),
            React.createElement('div', null,
              'Without plates, every tow has to be confirmed manually by the property owner before we can release billing.',
            ),
          )
        : plates.map(p => React.createElement('span', {
            key: p,
            style: {
              display: 'inline-flex', alignItems: 'center', gap: 6,
              fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, fontWeight: 700,
              padding: '4px 4px 4px 10px', borderRadius: 8,
              background: 'var(--bg-inset)', border: '1px solid var(--border)', color: 'var(--text-primary)',
            }
          },
            p,
            React.createElement('button', {
              onClick: () => removePlate(p), disabled: saving,
              title: 'Remove plate',
              'aria-label': 'Remove tow-truck plate ' + p,
              style: {
                background: 'transparent', border: 'none', color: 'var(--text-faint)',
                cursor: saving ? 'wait' : 'pointer', padding: '0 6px', fontSize: 14, lineHeight: 1,
              },
            }, '\u2715'),
          )),
    ),

    React.createElement('div', {
      style: { display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0' }
    },
      React.createElement('input', {
        type: 'text',
        value: draft,
        onChange: e => setDraft(e.target.value),
        onKeyDown: e => { if (e.key === 'Enter') { e.preventDefault(); addPlate(); } },
        placeholder: 'Add plate (e.g. T-123-AB)',
        disabled: saving,
        style: {
          flex: 1, fontSize: 13, padding: '6px 10px', borderRadius: 6,
          border: '1px solid var(--border)', background: 'var(--bg-inset)',
          color: 'var(--text-primary)', fontFamily: 'ui-monospace, Menlo, monospace', textTransform: 'uppercase',
        },
      }),
      React.createElement('button', {
        onClick: addPlate,
        disabled: saving || !normalizeTruckPlate(draft),
        style: {
          fontSize: 13, padding: '6px 14px', borderRadius: 6, cursor: 'pointer', fontWeight: 700,
          border: '1px solid var(--accent)', background: 'var(--accent)', color: '#fff',
          opacity: (saving || !normalizeTruckPlate(draft)) ? 0.6 : 1,
        }
      }, saving ? 'Saving…' : 'Add plate'),
    ),

    err && React.createElement('div', {
      style: { fontSize: 12, color: '#ef4444', padding: '6px 0 0' }
    }, err),
    saved && !err && React.createElement('div', {
      style: { fontSize: 12, color: 'var(--green)', padding: '6px 0 0', lineHeight: 1.45 }
    }, lastAction === 'added'
         ? 'Plate added! Camera sightings will now auto-confirm your tows within a few minutes.'
         : 'Saved'),
  );
}
