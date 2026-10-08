// Pure helpers for the property Settings panel save.
//
// PATCH /apartment/properties/{id} accepts only the editable keys below.
// `property_type` is a trust column and is answered 422 `read_only_field`; an
// empty body is 422 `no_changes`. So the panel sends only what changed, and
// never the type.

/** Keys the backend lets a member edit (routers/apartment_properties.py). */
export const EDITABLE_PROPERTY_KEYS = Object.freeze([
  'name', 'address', 'address_line1', 'city', 'state', 'postal_code',
  'notes', 'policy_text', 'policy_phone',
]);

// Not spec copy: wording chosen by the G2b brief.
export const PROPERTY_TYPE_READONLY_NOTE = 'Property type is set by LotLogic.';
export const NO_CHANGES_TOAST = 'No changes.';

// Not spec copy: readable sentences for the backend codes.
const SETTINGS_ERROR_COPY = Object.freeze({
  read_only_field: 'That setting can only be changed by LotLogic.',
  unknown_field: "That setting can't be edited here.",
  no_changes: NO_CHANGES_TOAST,
});

const norm = (v) => (v === null || v === undefined ? '' : String(v));

/**
 * Editable fields whose value differs between `baseline` and `draft`.
 * Keys outside EDITABLE_PROPERTY_KEYS (notably property_type) are ignored.
 * A key missing from the draft is not a change.
 */
export function changedSettings(baseline, draft) {
  const out = {};
  if (!draft) return out;
  for (const key of EDITABLE_PROPERTY_KEYS) {
    if (!(key in draft)) continue;
    if (norm(draft[key]) !== norm(baseline?.[key])) out[key] = draft[key];
  }
  return out;
}

/** Sentence for a failed settings save; never a raw code. */
export function settingsSaveErrorMessage(err, fallback = 'Failed to save settings. Try again.') {
  const code = typeof err?.code === 'string' ? err.code : '';
  if (code === 'invalid_field') {
    const field = err?.body?.field;
    if (field === 'policy_phone') return 'Enter a valid US phone number for the towing contact.';
    if (field === 'policy_text') return 'The parking policy text is too long (2000 characters max).';
    return 'One of those values is not valid.';
  }
  return SETTINGS_ERROR_COPY[code] || fallback;
}
