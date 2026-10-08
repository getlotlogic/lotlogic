import React, { useMemo, useState } from 'react';
import { Sheet } from '../../ui/Sheet.jsx';
import { requestsApi } from '../../lib/requestsApi.js';
import { REQUEST_ERROR_COPY, requestErrorMessage } from '../../lib/requestErrors.js';
import { useNowTick } from '../../hooks.js';
import {
  defaultPresetId,
  extendChips,
  extendLabel,
  pickerMax,
  pickerMin,
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
// The per-transition window — new `expires_at` > old **and** ≤ `now()+7d`
// (§4.3, §8.3) — is service code under a row lock, so the client's whole job
// is to never print a label outside it. `extendChips` does the clamping and
// the dropping; the picker gets the same two bounds; and the payload is the
// absolute instant the button printed, so a 422 `hold_window` is unreachable
// from this sheet rather than translated after the fact.

const ALL_USED =
  'All 4 extensions used. Place a new hold after this one ends, or ask about parking passes.';

/** When the hold already ends at the ceiling there is no extension to offer. */
function noWindowLine(maxDays) {
  return `Holds can only reach ${maxDays} days ahead. Come back closer to when this one ends to extend it.`;
}

export function ExtendSheet({ request, rules, onClose, onExtended, onAskUpsell, addToast }) {
  const nowTick = useNowTick(30000);
  const now = useMemo(() => new Date(nowTick), [nowTick]);
  const resolved = resolveHoldRules(rules);

  // An extension runs from where the hold ENDS, not from now — §5.2's own
  // example is a hold ending Wed Oct 8, 9:14 PM whose Extend button reads
  // "Extend to Thu Oct 9, 9:14 PM ET" — but clamped back to `now + max_days`,
  // which is where the server's window actually sits.
  const chips = useMemo(
    () => extendChips(request, now, resolved),
    [request?.expires_at, now, resolved.overnight_hour, resolved.max_days],
  );

  const [presetId, setPresetId] = useState('');
  const [picked, setPicked] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  if (!request) return null;

  const used = Number(request.extension_count || 0);
  const left = request.extensions_left != null ? Number(request.extensions_left) : Math.max(0, 4 - used);
  const exhausted = left <= 0;

  // 24 hours stays the preselected chip (§5.2's example extends a hold by a
  // day). When clamping has dropped it, the longest surviving chip is the
  // fallback — chips are sorted, so that is the last one.
  const fallback = chips.find(c => c.id === defaultPresetId(rules)) || chips[chips.length - 1];
  const chosen = chips.find(c => c.id === presetId) || fallback;
  const pickedAt = picked ? new Date(picked) : null;
  const expiresAt = (pickedAt && !Number.isNaN(pickedAt.getTime())) ? pickedAt : chosen?.expiresAt;
  const noWindow = chips.length === 0;

  // The picker's floor is past the current expiry (the "new > old" half of the
  // window) and its ceiling is `now + max_days` (the other half) — the same
  // two bounds the chips are built from.
  const floorAt = new Date(Math.max(nowTick, Date.parse(request.expires_at || '') || nowTick));

  async function submit(e) {
    e?.preventDefault();
    setError('');
    if (!expiresAt) { setError(noWindowLine(resolved.max_days)); return; }
    // `max` on a datetime-local is advisory — a typed value can land outside
    // it. Same window as the chips, so the server's 422 `hold_window` is
    // unreachable from here either way.
    const ceiling = nowTick + resolved.max_days * 24 * 3600000;
    if (expiresAt.getTime() > ceiling || expiresAt.getTime() <= floorAt.getTime()) {
      setError(REQUEST_ERROR_COPY.hold_window);
      return;
    }
    setSaving(true);
    try {
      // Always the absolute instant the label printed. `duration_hours` would
      // leave the anchor to the server's `resolve_expiry`, and the button's
      // promise and the payload could then disagree.
      const out = await requestsApi.extendRequest(request.id, { expires_at: expiresAt.toISOString() });
      const next = out?.request || out;
      addToast?.(`Hold extended (${Number(next?.extension_count || used + 1)} of 4).`, 'success');
      onExtended?.(next);
      onClose?.();
    } catch (err) {
      setError(err?.code === 'extension_limit'
        ? ALL_USED
        : requestErrorMessage(err, 'Could not extend that hold. Try again.'));
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
      ) : noWindow ? (
        <p className="req-help">{noWindowLine(resolved.max_days)}</p>
      ) : (
        <form onSubmit={submit} noValidate>
          <div style={{ marginTop: 12 }}>
            <span className="req-label" id="ext-until-label">Don't tow until</span>
            <div className="req-chip-row" role="group" aria-labelledby="ext-until-label">
              {chips.map(c => (
                <button key={c.id} type="button" className="req-chip"
                  aria-pressed={!picked && chosen?.id === c.id}
                  onClick={() => { setPresetId(c.id); setPicked(''); }}
                >{c.label}</button>
              ))}
              <button type="button" className="req-chip" aria-pressed={!!picked}
                onClick={() => setPicked(prev => prev || pickerMin(floorAt))}
              >Pick a time…</button>
            </div>
            {picked && (
              <input
                type="datetime-local"
                className="req-input"
                style={{ marginTop: 8 }}
                value={picked}
                min={pickerMin(floorAt)}
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
