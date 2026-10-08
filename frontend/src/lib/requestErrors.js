// ── Error codes → sentences a property manager can act on ────
//
// Every portal route answers `{"detail": "<code>", ...extra}` (the plan's
// Global Constraints), and `api.js:errorFromResponse` sets `err.message` from
// that same `detail`. So **`err.message` is a machine identifier**, not copy:
// handing it to `addToast` or into a `.req-error` shows a manager
// `hold_window` or `not_active` and leaves them with nothing to do about it.
//
// This module is the only place a code becomes a sentence. The rule for every
// call site in the Requests section is: pass the error and the sentence that
// fits that particular button, and never read `err.message`.
//
// Where the spec writes the sentence, it is here verbatim:
//   * `pending_hold_limit`  — §3.8
//   * `note_required`       — §5.2
//   * `extension_limit`     — §4.3
//   * `unsupported_type`    — §8.3
// The rest are codes the spec names (§8.3) without giving copy; those
// sentences are declared in the task report as deviations.

/** When neither the code nor the call site has anything better to say. */
export const GENERIC_ERROR = 'Something went wrong. Try again.';

export const REQUEST_ERROR_COPY = Object.freeze({
  // POST /apartment/requests
  hold_window: 'Pick a time between an hour from now and 7 days from now.',
  email_unverified: 'Confirm your email first — enter the 6-digit code we sent.',
  pending_hold_limit:
    'Unconfirmed properties can keep 3 holds at a time. N Style usually confirms the same day.',
  attestation_required: 'Tap "Request tow" again so we can record the statement above.',
  note_required: 'Tell N Style why — they act on this.',
  active_hold_exists: 'That plate already has a hold at this property.',

  // POST …/{id}/extend · /remove · /reinstate
  extension_limit:
    'All 4 extensions used. Place a new hold after this one ends, or ask about parking passes.',
  not_active: 'That request already ended. Pull the list down to see where it stands.',
  reinstate_window: 'That hold ended more than 7 days ago. Place a new hold instead.',

  // POST …/{id}/fulfill and the upload route
  photo_required: 'Add the photo before sending this.',
  unsupported_type: 'Use a JPEG or PNG',
});

/**
 * The sentence for a failure.
 *
 * @param {unknown} err       the error `requestsApi` rethrew from `apiFetch`
 * @param {string} [fallback] what this particular button should say when the
 *                            code is unknown, absent, or a Pydantic 422
 * @returns {string} never a code, never `err.message`
 */
export function requestErrorMessage(err, fallback = GENERIC_ERROR) {
  const code = typeof err?.code === 'string' ? err.code : '';
  return REQUEST_ERROR_COPY[code] || fallback || GENERIC_ERROR;
}
