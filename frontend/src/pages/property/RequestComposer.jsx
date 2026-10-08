import React, { useMemo, useState } from 'react';
import { requestsApi } from '../../lib/requestsApi.js';
import { requestErrorMessage } from '../../lib/requestErrors.js';
import { useNowTick } from '../../hooks.js';
import {
  buttonLabel,
  defaultPresetId,
  pickerMax,
  pickerMin,
  plateFieldError,
  plateNote,
  presets,
  resolveHoldRules,
} from '../../lib/holdTime.js';

// ── The request composer (spec §5.2) ─────────────────────────
//
// Three taps to a hold: the plate field is the first tap target in the
// viewport, the 24-hour chip starts selected, and the button already says the
// date and time the hold will end. Everything optional is behind one
// expander; nothing in it is required.
//
// The composer owns no list state. It posts, hands the created request up
// through `onCreated`, and resets. The two cases it cannot resolve itself go
// up as well: an unverified email (`onNeedVerify`, which Task 23's
// VerifyEmailSheet answers) and a 409 `active_hold_exists` (`onConflict`,
// which scrolls the existing row into view).
//
// Props
//   property        the property row (name, id, verification_status)
//   rules           `enforcement_partners.hold_rules`, or undefined for defaults
//   holdCount       active holds on this property — the pending-property cap line
//   emailVerified   false only when /auth/me says so; undefined means "unknown",
//                   and the server's 422 `email_unverified` is then the gate
//   partnerName     the tow company's display name ("N Style Towing")
//   onCreated(req)  a 201 landed
//   onNeedVerify(resume)  open the 6-digit code sheet; `resume` re-submits
//   onConflict({requestId, plate, expiresLocal, kind})  the 409
//   expiryFor(requestId)  the `expires_local` of a row in the section's active
//                   list — the 409 body carries only `request_id` (§8.3), so
//                   the time in the conflict sentence is resolved client-side
//   addToast(msg, type)

const KINDS = [
  { id: 'hold', label: 'Hold' },
  { id: 'tow', label: 'Tow' },
  { id: 'photo', label: 'Photo' },
];

// Spec §4.3's helper sentence, under the button.
const HOLD_HELP = 'Holds last 24 hours unless you pick longer, up to 7 days, and can be extended 4 times.';

// Spec §5.2: the tap on "Request tow" IS the signature. Stored verbatim on the
// `created` event with `attested_at`, IP and UA — so this string must never be
// reworded without a migration-shaped decision behind it.
const ATTESTATION =
  'I am the owner or lessee of this parking area, or their authorized agent, ' +
  'and I am requesting in writing that this vehicle be removed.';

const TOW_NOTE_ERROR = 'Tell N Style why — they act on this.';
const PHOTO_TOO_BIG = 'That photo is over 10 MB. Try a smaller one.';
const PHOTO_FAILED = "Couldn't add the photo — the hold still works.";
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

export function RequestComposer({
  property,
  rules,
  holdCount = 0,
  emailVerified,
  onCreated,
  onNeedVerify,
  onConflict,
  expiryFor,
  addToast,
  plateInputRef,
}) {
  const [kind, setKind] = useState('hold');
  const [plate, setPlate] = useState('');
  const [presetId, setPresetId] = useState(() => defaultPresetId(rules));
  const [picked, setPicked] = useState('');     // the datetime-local value
  const [open, setOpen] = useState(false);      // the optional expander
  const [details, setDetails] = useState({ make: '', model: '', year: '', color: '' });
  const [note, setNote] = useState('');
  const [photo, setPhoto] = useState(null);     // { key, name, previewUrl }
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState('');
  const [plateError, setPlateError] = useState('');
  const [noteError, setNoteError] = useState('');
  const [conflictCopy, setConflictCopy] = useState(null);
  const [verifyCopy, setVerifyCopy] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // The preset chips are "now + N" and the button label is derived from them,
  // so both have to move as the clock does. 30 s is the section's own poll
  // interval; a label that is half a minute stale on a 24-hour hold is
  // invisible, and a tick per second would re-render the whole composer.
  const nowTick = useNowTick(30000);
  const now = useMemo(() => new Date(nowTick), [nowTick]);

  const resolved = resolveHoldRules(rules);
  const chips = useMemo(() => presets(now, resolved), [now, resolved.overnight_hour, resolved.max_days]);
  const isPending = property?.verification_status === 'pending';

  // What the button promises. The picker wins when it has a value, otherwise
  // the selected chip; the server's `expires_local` replaces this the moment
  // the 201 lands.
  const chosen = chips.find(c => c.id === presetId) || chips[0];
  const pickedAt = picked ? new Date(picked) : null;
  const expiresAt = (pickedAt && !Number.isNaN(pickedAt.getTime())) ? pickedAt : chosen?.expiresAt;

  const normalizedNote = plateNote(plate);
  const trimmedNote = note.trim();

  function reset() {
    setPlate('');
    setPresetId(defaultPresetId(rules));
    setPicked('');
    setOpen(false);
    setDetails({ make: '', model: '', year: '', color: '' });
    setNote('');
    if (photo?.previewUrl) URL.revokeObjectURL(photo.previewUrl);
    setPhoto(null);
    setPhotoError('');
    setPlateError('');
    setNoteError('');
    setConflictCopy(null);
    setVerifyCopy('');
  }

  function switchKind(next) {
    setKind(next);
    setNoteError('');
    setConflictCopy(null);
    setVerifyCopy('');
  }

  async function choosePhoto(e) {
    const file = e.target.files?.[0];
    e.target.value = '';                       // let the same file be re-picked
    if (!file) return;
    setPhotoError('');
    if (file.size > MAX_PHOTO_BYTES) { setPhotoError(PHOTO_TOO_BIG); return; }
    const previewUrl = URL.createObjectURL(file);
    setPhoto({ key: null, name: file.name, previewUrl });
    setPhotoBusy(true);
    try {
      const out = await requestsApi.uploadPhoto(file, property.id);
      setPhoto({ key: out?.photo_key || null, name: file.name, previewUrl });
    } catch (err) {
      // Spec §5.2: the photo failing must never cost the request. Keep the
      // thumbnail (it is what the manager picked) and say the hold still works;
      // submit carries no `photo_key`.
      setPhoto({ key: null, name: file.name, previewUrl });
      setPhotoError(err?.status === 413 || err?.code === 'request_entity_too_large'
        ? PHOTO_TOO_BIG
        : requestErrorMessage(err, PHOTO_FAILED));
    } finally {
      setPhotoBusy(false);
    }
  }

  function dropPhoto() {
    if (photo?.previewUrl) URL.revokeObjectURL(photo.previewUrl);
    setPhoto(null);
    setPhotoError('');
  }

  function body() {
    const out = {
      property_id: property.id,
      kind,
      plate_text: plate.trim(),
    };
    for (const k of ['make', 'model', 'color']) {
      if (details[k].trim()) out[k] = details[k].trim();
    }
    if (details.year.trim()) out.year = Number(details.year.trim());
    if (trimmedNote) out.note = trimmedNote;
    if (photo?.key) out.photo_key = photo.key;
    if (kind === 'hold') {
      // An absolute time for the picker and for Overnight; a plain duration
      // otherwise, so the server resolves it against its own clock.
      if (pickedAt && !Number.isNaN(pickedAt.getTime())) out.expires_at = pickedAt.toISOString();
      else if (chosen?.durationHours != null) out.duration_hours = chosen.durationHours;
      else if (chosen?.expiresAt) out.expires_at = chosen.expiresAt.toISOString();
    }
    if (kind === 'tow') out.attestation_text = ATTESTATION;
    return out;
  }

  async function submit(e) {
    e?.preventDefault();
    setConflictCopy(null);
    setVerifyCopy('');

    const plateMsg = plateFieldError(plate);
    setPlateError(plateMsg || '');
    const needsNote = kind === 'tow' && trimmedNote.length < 2;
    setNoteError(needsNote ? TOW_NOTE_ERROR : '');
    if (plateMsg || needsNote) return;

    // Tow, photo, and a hold on a property N Style has not confirmed yet all
    // need a verified email (§3.5). When /auth/me has already told us the
    // email is unverified, say so without a round trip; otherwise the server's
    // 422 below is the gate.
    const gated = kind !== 'hold' || isPending;
    if (gated && emailVerified === false) {
      askToVerify();
      return;
    }

    setSubmitting(true);
    try {
      const out = await requestsApi.createRequest(body());
      const request = out?.request || out;
      onCreated?.(request);
      announce(request);
      reset();
    } catch (err) {
      handleFailure(err);
    } finally {
      setSubmitting(false);
    }
  }

  // §5.2 writes this sentence for a tow; §5.9 lists "tow/photo inline
  // message" as one opener; and §3.8's "first hold on a pending property" path
  // lands here too, where neither "request a tow" nor "request a photo" is
  // true — a manager who tapped "Put on hold until …" is placing a hold.
  function askToVerify() {
    setVerifyCopy(kind === 'tow'
      ? 'Confirm your email to request a tow — enter the 6-digit code we sent.'
      : kind === 'photo'
        ? 'Confirm your email to request a photo — enter the 6-digit code we sent.'
        : 'Confirm your email to place this hold — enter the 6-digit code we sent.');
    // Until Task 23 lands, `onNeedVerify` defaults to a no-op upstream and the
    // inline copy above is the whole answer.
    onNeedVerify?.(() => submit());
  }

  function announce(request) {
    const ref = request?.ref || '';
    if (kind === 'hold') {
      const until = request?.expires_local || '';
      addToast?.(`Hold ${ref} placed until ${until} — sending to N Style.`, 'success');
    } else if (kind === 'tow') {
      addToast?.(`Tow ${ref} requested — sending to N Style.`, 'success');
    } else {
      addToast?.(`Photo ${ref} requested — sending to N Style.`, 'success');
    }
  }

  function handleFailure(err) {
    const code = err?.code;
    if (code === 'active_hold_exists') {
      // §8.3's 409 body is `{request_id}` and nothing else. The expiry comes
      // from the row the section is already holding; with no match (the row
      // is outside this page's list) the sentence drops the "until …" clause
      // rather than printing a hole where a time should be.
      const requestId = err.body?.request_id || null;
      const expiresLocal = (requestId && expiryFor?.(requestId)) || '';
      const shown = plate.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      setConflictCopy({ requestId, plate: shown, expiresLocal });
      onConflict?.({ requestId, plate: shown, expiresLocal, kind });
      return;
    }
    if (code === 'email_unverified') { askToVerify(); return; }
    if (code === 'note_required') { setNoteError(TOW_NOTE_ERROR); return; }
    // Every other code becomes a sentence through the map — the error's own
    // text is the route's `detail` code (`hold_window`,
    // `attestation_required`, …), which is an identifier, not copy.
    addToast?.(requestErrorMessage(err, 'Could not send that request. Try again.'), 'error');
  }

  const primaryLabel = kind === 'tow' ? 'Request tow'
    : kind === 'photo' ? 'Request photo'
      : buttonLabel(expiresAt);

  return (
    <form className="req-card" onSubmit={submit} noValidate>
      {/* Kind switch. `aria-pressed` rather than a radiogroup so each chip is
          a plain button with a 44 px target. */}
      <div className="req-chip-row" role="group" aria-label="What are you asking for?">
        {KINDS.map(k => (
          <button
            key={k.id}
            type="button"
            className="req-chip"
            aria-pressed={kind === k.id}
            onClick={() => switchKind(k.id)}
          >{k.label}</button>
        ))}
      </div>

      <div style={{ marginTop: 12 }}>
        <label className="req-label" htmlFor="req-plate">Plate</label>
        <input
          id="req-plate"
          ref={plateInputRef}
          className="req-plate-input"
          value={plate}
          onChange={e => { setPlate(e.target.value); if (plateError) setPlateError(''); }}
          placeholder="ABC 1234"
          inputMode="text"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck="false"
          enterKeyHint="done"
          maxLength={16}
          aria-invalid={plateError ? 'true' : undefined}
          aria-describedby={plateError ? 'req-plate-error' : (normalizedNote ? 'req-plate-note' : undefined)}
        />
        {plateError && <div id="req-plate-error" className="req-error">{plateError}</div>}
        {!plateError && normalizedNote && (
          <div id="req-plate-note" className="req-help">{normalizedNote}</div>
        )}
      </div>

      {kind === 'hold' && (
        <div style={{ marginTop: 12 }}>
          <span className="req-label" id="req-until-label">Don't tow until</span>
          <div className="req-chip-row" role="group" aria-labelledby="req-until-label">
            {chips.map(c => (
              <button
                key={c.id}
                type="button"
                className="req-chip"
                aria-pressed={!picked && presetId === c.id}
                onClick={() => { setPresetId(c.id); setPicked(''); }}
              >{c.label}</button>
            ))}
            <button
              type="button"
              className="req-chip"
              aria-pressed={!!picked}
              onClick={() => setPicked(prev => prev || pickerMin(now))}
            >Pick a time…</button>
          </div>
          {picked && (
            <input
              type="datetime-local"
              className="req-input"
              style={{ marginTop: 8 }}
              value={picked}
              min={pickerMin(now)}
              max={pickerMax(now, resolved)}
              aria-label="Pick a time"
              onChange={e => setPicked(e.target.value)}
            />
          )}
        </div>
      )}

      {kind === 'tow' && (
        <div style={{ marginTop: 12 }}>
          <label className="req-label" htmlFor="req-note-tow">Why? N Style sees this</label>
          <textarea
            id="req-note-tow"
            className="req-textarea"
            value={note}
            onChange={e => { setNote(e.target.value); if (noteError) setNoteError(''); }}
            maxLength={2000}
            aria-invalid={noteError ? 'true' : undefined}
            aria-describedby={noteError ? 'req-note-error' : undefined}
          />
          {noteError && <div id="req-note-error" className="req-error">{noteError}</div>}
        </div>
      )}

      {kind === 'photo' && (
        <div style={{ marginTop: 12 }}>
          <label className="req-label" htmlFor="req-note-photo">
            What should the photo show? <span className="req-optional">(optional)</span>
          </label>
          <textarea
            id="req-note-photo"
            className="req-textarea"
            value={note}
            onChange={e => setNote(e.target.value)}
            maxLength={2000}
          />
        </div>
      )}

      {/* Progressive disclosure: everything optional, one tap away. */}
      <div style={{ marginTop: 12 }}>
        <button
          type="button"
          className="req-link"
          aria-expanded={open}
          aria-controls="req-extras"
          onClick={() => setOpen(v => !v)}
        >{open ? '− Add car details, photo or note' : '+ Add car details, photo or note'}</button>
        {open && (
          <div id="req-extras" style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="req-grid">
              <div>
                <label className="req-label" htmlFor="req-make">Make</label>
                <input id="req-make" className="req-input" value={details.make}
                  onChange={e => setDetails(d => ({ ...d, make: e.target.value }))} maxLength={40} />
              </div>
              <div>
                <label className="req-label" htmlFor="req-model">Model</label>
                <input id="req-model" className="req-input" value={details.model}
                  onChange={e => setDetails(d => ({ ...d, model: e.target.value }))} maxLength={40} />
              </div>
              <div>
                <label className="req-label" htmlFor="req-year">Year</label>
                <input id="req-year" className="req-input" value={details.year} inputMode="numeric"
                  onChange={e => setDetails(d => ({ ...d, year: e.target.value.replace(/[^0-9]/g, '').slice(0, 4) }))} />
              </div>
              <div>
                <label className="req-label" htmlFor="req-color">Color</label>
                <input id="req-color" className="req-input" value={details.color}
                  onChange={e => setDetails(d => ({ ...d, color: e.target.value }))} maxLength={30} />
              </div>
            </div>
            {kind === 'hold' && (
              <div>
                <label className="req-label" htmlFor="req-note-hold">
                  Note <span className="req-optional">(optional)</span>
                </label>
                <textarea id="req-note-hold" className="req-textarea" value={note} maxLength={2000}
                  onChange={e => setNote(e.target.value)} />
              </div>
            )}
            <div>
              <span className="req-label">Photo <span className="req-optional">(optional)</span></span>
              {photo ? (
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  <div>
                    <img className="req-thumb" src={photo.previewUrl} alt={`Photo for ${plate || 'this request'}`} />
                    {photoBusy && <div className="req-progress" role="progressbar" aria-label="Uploading the photo" />}
                  </div>
                  <button type="button" className="req-btn" onClick={dropPhoto}>Remove photo</button>
                </div>
              ) : (
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/*"
                  className="req-input"
                  aria-label="Add a photo"
                  onChange={choosePhoto}
                />
              )}
              {photoError && <div className="req-error">{photoError}</div>}
            </div>
          </div>
        )}
      </div>

      {kind === 'tow' && <p className="req-attest">{ATTESTATION}</p>}

      {/* The inline 409: the plate already has a hold here. §4.3 for a hold,
          §5.2 for a tow — different sentences, same cause. */}
      {conflictCopy && (
        <div className="req-error" role="status">
          {kind === 'tow'
            ? (conflictCopy.expiresLocal
              ? `${conflictCopy.plate} is on hold until ${conflictCopy.expiresLocal}. Remove the hold first. `
              : `${conflictCopy.plate} is on hold. Remove the hold first. `)
            : (conflictCopy.expiresLocal
              ? `${conflictCopy.plate} is already on hold until ${conflictCopy.expiresLocal}. `
              : `${conflictCopy.plate} is already on hold. `)}
          <button type="button" className="req-link" onClick={() => onConflict?.({ ...conflictCopy, kind })}>
            {kind === 'tow' ? 'Go to hold' : 'Extend it instead'}
          </button>
        </div>
      )}

      {verifyCopy && (
        <div className="req-error" role="status">
          {verifyCopy}{' '}
          <button type="button" className="req-link" onClick={() => onNeedVerify?.(() => submit())}>
            Enter code
          </button>
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <button type="submit" className="req-btn-primary" disabled={submitting}>{primaryLabel}</button>
      </div>

      {kind === 'hold' && <p className="req-help">{HOLD_HELP}</p>}
      {kind === 'hold' && isPending && (
        <p className="req-help">{holdCount} of {resolved.pending_hold_cap} holds while N Style confirms</p>
      )}
    </form>
  );
}
