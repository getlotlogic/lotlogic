// ── SignupPage's pure validators (spec §3.2 / §5.1) ──────────
//
// Kept out of the .jsx components so `node --test` can run them with no JSX
// transform and no DOM (same shape as deepLink.js / verifyState.js /
// addPropertyFields.js). Every message below is verbatim spec §3.2 table
// copy — the form never invents an error string.
//
// Validation TIMING is the components' job, not this module's: on blur,
// live only after a field's first error, never on an untouched field
// (https://baymard.com/blog/inline-form-validation). These functions just
// answer "is this value wrong, and what do we say about it".

/** Spec §3.2 field 7: 12–128 chars, no composition rules. */
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

/**
 * Spec §3.2 field 4, in order. `id` is this form's own value; `label` is both
 * the chip text and what is sent as `lot_owners.position` (see `positionFor`).
 */
export const ROLES = [
  { id: 'property_manager', label: 'Property manager' },
  { id: 'assistant_manager', label: 'Assistant manager' },
  { id: 'leasing', label: 'Leasing' },
  { id: 'maintenance', label: 'Maintenance' },
  { id: 'owner_regional', label: 'Owner / regional' },
  { id: 'other', label: 'Other' },
];

const ROLE_IDS = new Set(ROLES.map(r => r.id));

/** Every error string the form can render, verbatim from the spec's table. */
export const ERR = {
  propertyName: "Enter the property's name, as it appears on the sign.",
  address: 'Pick the address from the list, or enter it manually.',
  zip: 'Enter a 5-digit ZIP code.',
  fullName: 'Enter your full name.',
  role: 'Pick the role that fits best.',
  email: 'Enter an email address like name@property.com.',
  phone: 'Enter a phone number we can call about a tow, like (704) 555-0123.',
  password: 'Use at least 12 characters.',
  breached: 'That password showed up in a data breach. Choose a different one.',
};

const str = (v) => (typeof v === 'string' ? v : '');
const trimmed = (v) => str(v).trim();

// ── 1 / 3. Names (2–80 chars, trimmed, any characters) ───────
//
// Any characters: https://design-system.service.gov.uk/patterns/names/ — no
// letters-only rule, no "two words" rule.

function nameInRange(v) {
  const t = trimmed(v);
  return t.length >= 2 && t.length <= 80;
}

/** @returns {string|null} */
export function propertyNameError(v) {
  return nameInRange(v) ? null : ERR.propertyName;
}

/** @returns {string|null} */
export function fullNameError(v) {
  return nameInRange(v) ? null : ERR.fullName;
}

// ── 5. Work email ────────────────────────────────────────────
//
// Deliberately loose: the server's `EmailStr` is the authority and a 422
// renders through `fieldErrorsFrom422`. This only catches the typos worth
// catching on blur — no @, nothing before it, no dot in the domain, spaces.

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/** @returns {string|null} */
export function emailError(v) {
  return EMAIL_RE.test(trimmed(v)) ? null : ERR.email;
}

/** Lowercased + trimmed, which is what `lot_owners.email` stores. */
export function normalizeEmail(v) {
  return trimmed(v).toLowerCase();
}

// ── 6. Mobile number ─────────────────────────────────────────
//
// DEVIATION from the spec, recorded in this task's report: §3.2 names
// `libphonenumber-js` `AsYouType('US')` / `isPossible()`. The dashboard
// bundle has a no-new-runtime-deps rule (`frontend/package.json` ships
// react, react-dom, @supabase/supabase-js and qrcode and nothing else), and
// libphonenumber-js's metadata is ~145 kB min — on a page whose whole budget
// is first paint on LTE (§5.1) that is the wrong trade. These three
// functions are the US-only subset the form actually needs: NANP display
// formatting, a possibility check, and E.164 output. Output shape is
// unchanged: `+1XXXXXXXXXX`.

/** Digits only. */
export function onlyDigits(v) {
  return str(v).replace(/\D+/g, '');
}

/**
 * The 10-digit national number behind anything a thumb can type: a bare
 * `7045550123`, a pasted `(704) 555-0123`, a `+1 704 555 0123`, a
 * `1-704-555-0123`. Extra digits past ten are dropped (the field is a US
 * mobile number, not a number with an extension).
 * @returns {string} 0–10 digits
 */
export function nationalDigits(v) {
  let d = onlyDigits(v);
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d.slice(0, 10);
}

/**
 * `AsYouType('US')`, the 15 lines of it this form needs:
 *   ''      → ''
 *   '7'     → '7'
 *   '704'   → '704'
 *   '7045'  → '(704) 5'
 *   '704555'→ '(704) 555'
 *   '7045550123' → '(704) 555-0123'
 */
export function formatUSPhone(v) {
  const d = nationalDigits(v);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

/**
 * NANP possibility: ten digits, area code and exchange code both starting
 * 2–9 (https://nationalnanpa.com — N is 2–9 in the NXX-NXX-XXXX format).
 * This is `isPossible()`, not `isValid()`: it does not know which area codes
 * have been assigned, which is exactly right for a form that must not reject
 * a brand-new NPA.
 */
export function isPossibleUSNumber(v) {
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(nationalDigits(v));
}

/** `+1XXXXXXXXXX`, or null when the number is not possible. */
export function toE164US(v) {
  return isPossibleUSNumber(v) ? `+1${nationalDigits(v)}` : null;
}

/** @returns {string|null} */
export function phoneError(v) {
  return isPossibleUSNumber(v) ? null : ERR.phone;
}

// ── 7. Create a password ─────────────────────────────────────

/**
 * Floor 12, no composition rules, never trimmed — a leading or trailing
 * space is a legitimate character the server will hash as typed, so
 * measuring a trimmed copy here would disagree with the server.
 * @returns {string|null}
 */
export function passwordError(v) {
  return str(v).length >= PASSWORD_MIN ? null : ERR.password;
}

// ── 4. Your role ─────────────────────────────────────────────

/** @returns {string|null} */
export function roleError(roleId, otherText) {
  if (!roleId || !ROLE_IDS.has(roleId)) return ERR.role;
  if (roleId !== 'other') return null;
  const t = trimmed(otherText);
  return t.length >= 2 && t.length <= 60 ? null : ERR.role;
}

/** What goes into `lot_owners.position`. */
export function positionFor(roleId, otherText) {
  if (roleId === 'other') return trimmed(otherText);
  const hit = ROLES.find(r => r.id === roleId);
  return hit ? hit.label : '';
}

// ── 2. Property address ──────────────────────────────────────

const ZIP_RE = /^\d{5}(-\d{4})?$/;

/**
 * The manual layout's four fields. The ZIP is the one field the spec gives
 * its own message, so a complete-but-for-the-ZIP address says so; anything
 * else falls back to the address message.
 * @returns {string|null}
 */
export function manualAddressError(fields) {
  const f = fields || {};
  const line1 = trimmed(f.line1);
  const city = trimmed(f.city);
  const state = trimmed(f.state);
  const zip = trimmed(f.zip);
  if (!line1 || !city || !/^[A-Za-z]{2}$/.test(state)) return ERR.address;
  if (!ZIP_RE.test(zip)) return ERR.zip;
  return null;
}

/**
 * Both layouts: a suggestion picked in autocomplete mode, or all four
 * fields in manual mode.
 * @param {{manual?: boolean, placeFields?: object|null, manualFields?: object}} state
 * @returns {string|null}
 */
export function addressError(state) {
  const s = state || {};
  if (s.manual) return manualAddressError(s.manualFields);
  return s.placeFields ? null : ERR.address;
}

// ── The draft (spec §3.4a (c)) ───────────────────────────────

/** sessionStorage key the typed answers are parked under. */
export const DRAFT_KEY = 'lotlogic_signup_draft';
/** "cleared on success or after 24 h". */
export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The draft object, built field by field from an allowlist — **never** the
 * password (spec §3.2: "Draft kept in sessionStorage"; §3.4a (c): "property
 * fields only — never the password"). Built by naming what goes in rather
 * than deleting what must not, so a field added to the form later cannot
 * leak by default.
 * @param {object} state the form's current values
 * @param {number} [now] injectable clock
 */
export function serializeDraft(state, now) {
  const s = state || {};
  const m = s.manualFields || {};
  const p = s.placeFields || null;
  return {
    v: 1,
    savedAt: typeof now === 'number' ? now : Date.now(),
    slug: s.slug || null,
    name: str(s.name),
    manual: !!s.manual,
    manualFields: {
      line1: str(m.line1), city: str(m.city), state: str(m.state), zip: str(m.zip),
    },
    placeFields: p ? {
      address: str(p.address),
      place_id: p.place_id || null,
      lat: typeof p.lat === 'number' ? p.lat : null,
      lng: typeof p.lng === 'number' ? p.lng : null,
    } : null,
    contactName: str(s.contactName),
    role: s.role || null,
    roleOther: str(s.roleOther),
    email: str(s.email),
    phone: str(s.phone),
    joinPropertyId: s.joinPropertyId || null,
  };
}

/**
 * Parse what `sessionStorage.getItem(DRAFT_KEY)` returned. Null for absent,
 * unparseable, shapeless or expired (> 24 h) drafts — a stale draft
 * prefilling someone else's property is worse than an empty form.
 * @param {string|null|undefined} raw
 * @param {number} [now]
 * @returns {object|null}
 */
export function readDraft(raw, now) {
  if (typeof raw !== 'string' || raw === '') return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.savedAt !== 'number') return null;
  const t = typeof now === 'number' ? now : Date.now();
  if (t - parsed.savedAt > DRAFT_TTL_MS) return null;
  return parsed;
}

// ── 422 → field messages + a focusable summary ───────────────

// Backend field name (the last string in a Pydantic `loc`) → this form's
// field key. Address parts all collapse onto the one address control.
const FIELD_BY_LOC = {
  name: 'propertyName',
  address: 'address',
  address_line1: 'address',
  city: 'address',
  state: 'address',
  postal_code: 'address',
  place_id: 'address',
  contact_name: 'fullName',
  position: 'role',
  email: 'email',
  phone: 'phone',
  password: 'password',
};

/**
 * `detail` from a 422 (`[{loc, msg, type}, …]`) → `{fields, messages}`:
 * `fields` keyed the way the form keys its inputs, `messages` the summary
 * list rendered at the top with focus moved to it
 * (https://design-system.service.gov.uk/patterns/validation/). An entry
 * whose `loc` maps to nothing still contributes its message to the summary,
 * so no server complaint is ever swallowed.
 * @param {any} detail
 * @returns {{fields: Record<string,string>, messages: string[]}}
 */
export function fieldErrorsFrom422(detail) {
  const out = { fields: {}, messages: [] };
  if (!Array.isArray(detail)) return out;
  for (const entry of detail) {
    if (typeof entry === 'string') { out.messages.push(entry); continue; }
    if (!entry || typeof entry !== 'object') continue;
    const msg = typeof entry.msg === 'string' ? entry.msg : null;
    if (!msg) continue;
    out.messages.push(msg);
    const loc = Array.isArray(entry.loc) ? entry.loc.filter(x => typeof x === 'string') : [];
    const key = FIELD_BY_LOC[loc[loc.length - 1]];
    if (key && !out.fields[key]) out.fields[key] = msg;
  }
  return out;
}
