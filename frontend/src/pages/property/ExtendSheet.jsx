import React, { useMemo, useState } from 'react';
import { Sheet } from '../../ui/Sheet.jsx';
import { requestsApi } from '../../lib/requestsApi.js';
import { useNowTick } from '../../hooks.js';
import {
  defaultPresetId,
  extendLabel,
  pickerMax,
  pickerMin,
  presets,
  resolveHoldRules,
} from '../../lib/holdTime.js';

// ── Extend a hold (spec §5.2, rules §4.3) ────────────────────
//
// The same chips and picker as the composer, so there is one thing to learn,
// plus the count of extensions already used.
//
// After the fourth, the button becomes a sentence — never a dead `disabled`
// control (§4.3). The sentence points at parking passes, because a manager who
// has extended four times is telling us something about the property, not about
// this car.
//
// The 7-day window per extension is service code under a row lock, not a
// CHECK, so the client's only job is to keep the picker inside it; a 422
// `hold_window` from the server is surfaced verbatim rather than guessed at.

const ALL_USED =
  'All 4 extensions used. Place a new hold after this one ends, or ask about parking passes.';

export function ExtendSheet({ request, rules, onClose, onExtended, onAskUpsell, addToast }) {
  const nowTick = useNowTick(30000);
  const now = useMemo(() => new Date(nowTick), [nowTick]);
  const resolved = resolveHoldRules(rules);

  // An extension runs from where the hold ENDS, not from now. Spec §5.2's own
  // example is a hold ending Wed Oct 8, 9:14 PM whose Extend button reads
  // "Extend to Thu Oct 9, 9:14 PM ET" — 24 hours past the expiry, not past the
  // tap. Measuring from `now` would also fight the §4.2 guard, which requires
  // the new `expires_at` to be strictly greater than the old one.
  const endsAt = Date.parse(request?.expires_at || '');
  const baseline = useMemo(
    () => new Date(Math.max(nowTick, Number.isNaN(endsAt) ? nowTick : endsAt)),
    [nowTick, endsAt],
  );
  const chips = useMemo(
    () => presets(baseline, resolved),
    [baseline, resolved.overnight_hour, resolved.max_days],
  );

  const [presetId, setPresetId] = useState(() => defaultPresetId(rules));
  const [picked, setPicked] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  if (!request) return null;

  const used = Number(request.extension_count || 0);
  const left = request.extensions_left != null ? Number(request.extensions_left) : Math.max(0, 4 - used);
  const exhausted = left <= 0;

  const chosen = chips.find(c => c.id === presetId) || chips[0];
  const pickedAt = picked ? new Date(picked) : null;
  const expiresAt = (pickedAt && !Number.isNaN(pickedAt.getTime())) ? pickedAt : chosen?.expiresAt;

  async function submit(e) {
    e?.preventDefault();
    setError('');
    setSaving(true);
    try {
      const body = (pickedAt && !Number.isNaN(pickedAt.getTime()))
        ? { expires_at: pickedAt.toISOString() }
        : (chosen?.durationHours != null
          ? { duration_hours: chosen.durationHours }
          : { expires_at: chosen.expiresAt.toISOString() });
      const out = await requestsApi.extendRequest(request.id, body);
      const next = out?.request || out;
      addToast?.(`Hold extended (${Number(next?.extension_count || used + 1)} of 4).`, 'success');
      onExtended?.(next);
      onClose?.();
    } catch (err) {
      if (err?.code === 'extension_limit') setError(ALL_USED);
      else setError(err?.message || 'Could not extend that hold. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet title={`Extend ${request.ref || 'this hold'} · ${request.plate}`} onClose={onClose}>
      <p className="req-quiet">{used} of 4 extensions used</p>

      {exhausted ? (
        <>
          <p className="req-help">{ALL_USED}</p>
          <div className="req-btn-row">
            <button type="button" className="req-btn" onClick={() => onAskUpsell?.()}>Ask LotLogic</button>
          </div>
        </>
      ) : (
        <form onSubmit={submit} noValidate>
          <div style={{ marginTop: 12 }}>
            <span className="req-label" id="ext-until-label">Don't tow until</span>
            <div className="req-chip-row" role="group" aria-labelledby="ext-until-label">
              {chips.map(c => (
                <button key={c.id} type="button" className="req-chip"
                  aria-pressed={!picked && presetId === c.id}
                  onClick={() => { setPresetId(c.id); setPicked(''); }}
                >{c.label}</button>
              ))}
              <button type="button" className="req-chip" aria-pressed={!!picked}
                onClick={() => setPicked(prev => prev || pickerMin(baseline))}
              >Pick a time…</button>
            </div>
            {picked && (
              <input
                type="datetime-local"
                className="req-input"
                style={{ marginTop: 8 }}
                value={picked}
                /* Floor: past the current expiry, so the §4.2 "new > old"
                   guard cannot be tripped from the picker. Ceiling: the
                   window is `now() + 7d`, measured from now, not from the
                   expiry. */
                min={pickerMin(baseline)}
                max={pickerMax(now, resolved)}
                aria-label="Pick a time"
                onChange={e => setPicked(e.target.value)}
              />
            )}
          </div>

          {error && <div className="req-error" role="status">{error}</div>}

          <div style={{ marginTop: 12 }}>
            <button type="submit" className="req-btn-primary" disabled={saving}>
              {extendLabel(expiresAt)}
            </button>
          </div>
        </form>
      )}
    </Sheet>
  );
}
