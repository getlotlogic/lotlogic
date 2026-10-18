// ── The tow company's Team: pure helpers ─────────────────────
//
// Spec 2026-10-18-tow-company-team §1.3 (the `/partner/team` API), §1.4 (the
// Account → Team section) and §4 (copy, verbatim). Kept out of
// PartnerTeamSection.jsx so `node --test` (no JSX transform) can import it —
// the same split as `pages/account/slackSection.js`.
//
// Roles keep their DB values (`admin` | `dispatcher` | `driver`). The only
// place one becomes text a person reads is `teamRoleLabel`, and it never
// returns the third value's own name: that role reads "Truck".

import { normalizeEmail, nationalDigits, formatUSPhone, toE164US } from './signupValidation.js';

export const TEAM_ROLES = Object.freeze(['admin', 'dispatcher', 'driver']);

const ROLE_LABELS = Object.freeze({ admin: 'Admin', dispatcher: 'Dispatch', driver: 'Truck' });

/** "Admin" / "Dispatch" / "Truck"; '' for anything else, never the raw value. */
export function teamRoleLabel(role) {
  return Object.prototype.hasOwnProperty.call(ROLE_LABELS, role) ? ROLE_LABELS[role] : '';
}

/**
 * Only an Admin changes the team (§1.3). A partner session with no
 * `member_role` was signed in before team logins and is the company's own
 * login, which the migration made its first Admin — the backend treats such
 * a token as `admin` until it expires (§1.2), and so does this.
 */
export function canManageTeam(user) {
  if (!user || user._role !== 'partner') return false;
  return user.member_role == null || user.member_role === 'admin';
}

/** `GET /partner/team` → `{members: [...]}`; anything else is an empty roster. */
export function teamMembers(res) {
  if (Array.isArray(res)) return res;
  return Array.isArray(res?.members) ? res.members : [];
}

// ── Add a teammate ───────────────────────────────────────────

export const INVITE_ERRORS = Object.freeze({
  name: 'Enter their name.',
  email: 'Enter an email address like name@company.com.',
  phone: 'Enter a phone number like (704) 555-0123, or leave it blank.',
  role: 'Pick a role: Admin, Dispatch or Truck.',
});

// The same deliberately loose check as signupValidation.emailError: the
// server's EmailStr is the authority, this catches typos.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/**
 * The `POST /partner/team/invite` body `{name, email, phone?, role}` from the
 * form, or every problem with it.
 *
 * @param {{name?: string, email?: string, phone?: string, role?: string}} form
 * @returns {{ok: true, body: object, errors: {}} | {ok: false, body: null, errors: Record<string, string>}}
 */
export function buildInvite(form) {
  const f = form || {};
  const name = String(f.name ?? '').trim();
  const email = normalizeEmail(f.email);
  const phoneTyped = String(f.phone ?? '').trim();
  const role = f.role;
  const errors = {};
  if (!name) errors.name = INVITE_ERRORS.name;
  if (!EMAIL_RE.test(email)) errors.email = INVITE_ERRORS.email;
  const phone = phoneTyped ? toE164US(phoneTyped) : null;
  if (phoneTyped && !phone) errors.phone = INVITE_ERRORS.phone;
  if (!TEAM_ROLES.includes(role)) errors.role = INVITE_ERRORS.role;
  if (Object.keys(errors).length) return { ok: false, body: null, errors };
  const body = { name, email, role };
  if (phone) body.phone = phone;
  return { ok: true, body, errors: {} };
}

// ── The roster line ──────────────────────────────────────────

const ET = 'America/New_York';
const SIX_DAYS_MS = 6 * 86400000;

// ICU puts a narrow no-break space before AM/PM; a person reads a space.
const plainSpaces = (s) => s.replace(/\s/g, ' ');

/**
 * "last signed in Fri 9:05 AM" inside the last six days (the office Team
 * section's shape), "last signed in Oct 2" before that — a weekday alone
 * would read as this week. ET, the company's clock.
 */
export function lastSignedInLabel(iso, { now = Date.now(), timeZone = ET } = {}) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  if (now - d.getTime() < SIX_DAYS_MS) {
    const weekday = d.toLocaleDateString('en-US', { weekday: 'short', timeZone });
    const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone });
    return plainSpaces(`last signed in ${weekday} ${time}`);
  }
  const year = (x) => new Date(x).toLocaleDateString('en-US', { year: 'numeric', timeZone });
  const sameYear = year(d) === year(now);
  const date = d.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }), timeZone,
  });
  return plainSpaces(`last signed in ${date}`);
}

/** "Set-up link not used yet" with no password; else the last sign-in, if any. */
export function memberStatusLine(member, opts) {
  if (!member) return null;
  if (member.has_password === false) return 'Set-up link not used yet';
  return lastSignedInLabel(member.last_login_at, opts);
}

/** `+17045550142` → "(704) 555-0142"; a number that is not a US one, as stored. */
export function memberPhone(phone) {
  const raw = String(phone ?? '').trim();
  if (!raw) return '';
  const digits = raw.replace(/\D+/g, '');
  const us = digits.length === 10 || (digits.length === 11 && digits.startsWith('1'));
  return us ? formatUSPhone(nationalDigits(raw)) : raw;
}

// ── The last Admin (mirrors the backend's `last_admin` guard) ─

export const LAST_ADMIN_REASON = 'Add another Admin before changing this one.';

/** True when `target` is the company's only Admin: no role change, no removal. */
export function lastAdminBlocked(members, target) {
  if (!target || target.role !== 'admin') return false;
  const others = (Array.isArray(members) ? members : [])
    .filter(m => m && m.role === 'admin' && m.id !== target.id);
  return others.length === 0;
}

// ── Error codes → sentences ──────────────────────────────────

export const TEAM_ERROR_COPY = Object.freeze({
  email_in_use: 'That email already has a LotLogic login.',
  last_admin: LAST_ADMIN_REASON,
});

const GENERIC = 'Something went wrong. Try again.';

/** The sentence for a failed team call; never the code, never `err.message`. */
export function teamErrorMessage(err, fallback = GENERIC) {
  const code = typeof err?.code === 'string' ? err.code : '';
  return TEAM_ERROR_COPY[code] || fallback || GENERIC;
}

/** The Remove access confirm, spec §1.3 verbatim. */
export function removeConfirmText(member, companyName) {
  const name = (member && member.name) || 'This person';
  const company = companyName || 'your company';
  return `${name} will lose access to ${company} on LotLogic. Their past requests stay on the record.`;
}

// ── Who the session is (§1.2, §1.4) ──────────────────────────

/**
 * The name fields a session takes from the `/auth/login` (or sign-up)
 * `subject`. For a team member `display_name` is the PERSON (§1.2), so it
 * must not land in `business_name` / `company_name`, which the Account page
 * and Lookup read as the company; `/auth/me.company_name` fills those in
 * (`partnerFieldsFromMe`). Every other login keeps today's fields.
 */
export function sessionNames(subject) {
  const s = subject || {};
  const partner = s.type === 'partner';
  if (partner && s.member_id) {
    return { member_id: s.member_id, member_role: s.member_role ?? null, member_name: s.display_name ?? null };
  }
  return { business_name: s.display_name, company_name: partner ? s.display_name : undefined };
}

/**
 * What `/auth/me` adds to a partner session: the company's name, and the
 * member block (§1.2) when the backend sends one. `{}` for an owner.
 */
export function partnerFieldsFromMe(me) {
  if (!me || me.type !== 'partner') return {};
  const out = {};
  if (me.company_name) {
    out.company_name = me.company_name;
    out.business_name = me.company_name;
  }
  if (me.member && typeof me.member === 'object') {
    out.member_id = me.member.id ?? null;
    out.member_role = me.member.role ?? null;
    out.member_name = me.member.name ?? null;
  }
  return out;
}

/** The header's name: the member's own for a team login, as before otherwise. */
export function headerName(user) {
  if (!user) return '';
  return user.member_name || user.business_name || user.contact_name || '';
}
