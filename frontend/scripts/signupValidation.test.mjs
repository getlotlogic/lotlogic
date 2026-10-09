// ── SignupPage's pure validators (Task 25, spec §3.2 / §5.1) ─
//
// Everything here is a pure function over strings and plain objects —
// `node --test` runs it with no DOM, no JSX transform and no network, the
// same shape as deepLink.test.mjs / verifyState.test.mjs.
//
// The error copy asserted below is verbatim spec §3.2 table copy. If a
// string here and the spec ever disagree, the spec wins and this file is
// what fails.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PASSWORD_MIN,
  ROLES,
  ERR,
  propertyNameError,
  fullNameError,
  emailError,
  normalizeEmail,
  nationalDigits,
  formatUSPhone,
  isPossibleUSNumber,
  toE164US,
  phoneError,
  passwordError,
  roleError,
  positionFor,
  manualAddressError,
  addressError,
  DRAFT_KEY,
  DRAFT_TTL_MS,
  serializeDraft,
  readDraft,
  fieldErrorsFrom422,
} from '../src/lib/signupValidation.js';

// ── 1. Property name / full name (2–80 chars, trimmed) ───────

test('a 1-character property name gets the spec error copy', () => {
  assert.equal(propertyNameError('S'), "Enter the property's name, as it appears on the sign.");
  assert.equal(propertyNameError('S'), ERR.propertyName);
});

test('a property name of 2 chars passes, 80 passes, 81 fails', () => {
  assert.equal(propertyNameError('Su'), null);
  assert.equal(propertyNameError('x'.repeat(80)), null);
  assert.equal(propertyNameError('x'.repeat(81)), ERR.propertyName);
});

test('a property name is trimmed before it is measured', () => {
  assert.equal(propertyNameError('   S   '), ERR.propertyName);
  assert.equal(propertyNameError('  Sunset Ridge Apartments  '), null);
});

test('a 1-character full name gets its own copy, not the property one', () => {
  assert.equal(fullNameError('D'), 'Enter your full name.');
  assert.equal(fullNameError('Dana Ortiz'), null);
  // §3.2 cites the GOV.UK names pattern: any characters are allowed.
  assert.equal(fullNameError("Ní Bhroin-O'Shea 大"), null);
});

// ── 2. Work email ───────────────────────────────────────────

test('email validation uses the spec copy and lowercases on normalize', () => {
  assert.equal(emailError('dana'), 'Enter an email address like name@property.com.');
  assert.equal(emailError('dana@'), ERR.email);
  assert.equal(emailError('dana@sunsetridge'), ERR.email);
  assert.equal(emailError('dana @sunsetridge.com'), ERR.email);
  assert.equal(emailError(''), ERR.email);
  assert.equal(emailError('dana@sunsetridge.com'), null);
  assert.equal(normalizeEmail('  DANA@SunsetRidge.com '), 'dana@sunsetridge.com');
});

// ── 3. Mobile number — the dependency-free US AsYouType ─────

test('7045550123 formats as (704) 555-0123 and submits as +17045550123', () => {
  assert.equal(formatUSPhone('7045550123'), '(704) 555-0123');
  assert.equal(toE164US('7045550123'), '+17045550123');
  assert.equal(isPossibleUSNumber('7045550123'), true);
  assert.equal(phoneError('7045550123'), null);
});

test('AsYouType formats progressively as the digits arrive', () => {
  assert.equal(formatUSPhone(''), '');
  assert.equal(formatUSPhone('7'), '7');
  assert.equal(formatUSPhone('704'), '704');
  assert.equal(formatUSPhone('7045'), '(704) 5');
  assert.equal(formatUSPhone('704555'), '(704) 555');
  assert.equal(formatUSPhone('7045550'), '(704) 555-0');
  // Everything past the 10th digit is dropped, not appended.
  assert.equal(formatUSPhone('704555012345'), '(704) 555-0123');
});

test('a pasted (704) 555-0123, 704-555-0123 and +1 704 555 0123 all land the same', () => {
  for (const typed of ['(704) 555-0123', '704-555-0123', '+1 704 555 0123', '1 (704) 555.0123']) {
    assert.equal(nationalDigits(typed), '7045550123', typed);
    assert.equal(toE164US(typed), '+17045550123', typed);
    assert.equal(formatUSPhone(typed), '(704) 555-0123', typed);
  }
});

test('555-0123 is not a possible US number and gets the spec copy', () => {
  assert.equal(isPossibleUSNumber('555-0123'), false);
  assert.equal(toE164US('555-0123'), null);
  assert.equal(
    phoneError('555-0123'),
    'Enter a phone number we can call about a tow, like (704) 555-0123.',
  );
  assert.equal(phoneError('555-0123'), ERR.phone);
});

test('an empty phone is an error (N Style calls this number) and so are bad NANP prefixes', () => {
  assert.equal(phoneError(''), ERR.phone);
  assert.equal(phoneError('   '), ERR.phone);
  // Area code may not start with 0 or 1; nor may the exchange code.
  assert.equal(isPossibleUSNumber('1045550123'), false);
  assert.equal(isPossibleUSNumber('0045550123'), false);
  assert.equal(isPossibleUSNumber('7041550123'), false);
  assert.equal(isPossibleUSNumber('7040550123'), false);
});

// ── 4. Password — floor 12, no composition rules ────────────

test('an 11-character password is short, 12 is fine', () => {
  assert.equal(PASSWORD_MIN, 12);
  assert.equal(passwordError('x'.repeat(11)), 'Use at least 12 characters.');
  assert.equal(passwordError('x'.repeat(11)), ERR.password);
  assert.equal(passwordError('x'.repeat(12)), null);
  // No composition rules: a short sentence works, spaces and all.
  assert.equal(passwordError('a short sentence works'), null);
});

test('a password is never trimmed before it is measured', () => {
  // Trimming would silently reject a legitimate leading-space password or,
  // worse, accept one the server then measures differently.
  assert.equal(passwordError('            '), null);
});

// ── 5. Role chips ───────────────────────────────────────────

test('the six role chips are the spec row, in order', () => {
  assert.deepEqual(ROLES.map(r => r.label), [
    'Property manager', 'Assistant manager', 'Leasing', 'Maintenance', 'Owner / regional', 'Other',
  ]);
});

test('a role is required and gets the spec copy', () => {
  assert.equal(roleError(null, ''), 'Pick the role that fits best.');
  assert.equal(roleError(null, ''), ERR.role);
  assert.equal(roleError('leasing', ''), null);
});

test('Other needs 2–60 characters of its own', () => {
  assert.equal(roleError('other', ''), ERR.role);
  assert.equal(roleError('other', 'x'), ERR.role);
  assert.equal(roleError('other', 'x'.repeat(61)), ERR.role);
  assert.equal(roleError('other', 'Regional VP'), null);
});

test('positionFor sends the chip label, or the typed text for Other', () => {
  assert.equal(positionFor('property_manager', ''), 'Property manager');
  assert.equal(positionFor('owner_regional', ''), 'Owner / regional');
  assert.equal(positionFor('other', '  Regional VP '), 'Regional VP');
  assert.equal(positionFor(null, ''), '');
});

// ── 6. Manual address rules ─────────────────────────────────

test('an incomplete manual address asks for the address, a bad ZIP asks for the ZIP', () => {
  assert.equal(manualAddressError({ line1: '', city: '', state: '', zip: '' }), ERR.address);
  assert.equal(
    manualAddressError({ line1: '123 Main St', city: 'Charlotte', state: 'NC', zip: '282' }),
    'Enter a 5-digit ZIP code.',
  );
  assert.equal(manualAddressError({ line1: '123 Main St', city: 'Charlotte', state: 'NC', zip: '282' }), ERR.zip);
  // A complete line1/city/state with no ZIP at all is still the ZIP message —
  // it is the one field the spec gives its own copy.
  assert.equal(manualAddressError({ line1: '123 Main St', city: 'Charlotte', state: 'NC', zip: '' }), ERR.zip);
  // State must be two letters.
  assert.equal(manualAddressError({ line1: '123 Main St', city: 'Charlotte', state: 'N', zip: '28205' }), ERR.address);
  assert.equal(manualAddressError({ line1: '123 Main St', city: 'Charlotte', state: 'NC', zip: '28205' }), null);
  assert.equal(manualAddressError({ line1: '123 Main St', city: 'Charlotte', state: 'nc', zip: '28205-1234' }), null);
});

test('addressError covers both layouts: a pick in autocomplete mode, four fields in manual', () => {
  assert.equal(addressError({ manual: false, placeFields: null }), ERR.address);
  assert.equal(addressError({ manual: false, placeFields: { address: '123 Main St', place_id: 'abc' } }), null);
  assert.equal(
    addressError({ manual: true, manualFields: { line1: '123 Main St', city: 'Charlotte', state: 'NC', zip: '2' } }),
    ERR.zip,
  );
  assert.equal(
    addressError({ manual: true, manualFields: { line1: '123 Main St', city: 'Charlotte', state: 'NC', zip: '28205' } }),
    null,
  );
});

// ── 7. The sessionStorage draft — never the password ────────

test('the draft serializer never includes the password, under any key', () => {
  const draft = serializeDraft({
    slug: 'nstyle',
    name: 'Sunset Ridge Apartments',
    manual: true,
    manualFields: { line1: '123 Main St', city: 'Charlotte', state: 'NC', zip: '28205' },
    placeFields: null,
    contactName: 'Dana Ortiz',
    role: 'property_manager',
    roleOther: '',
    email: 'dana@sunsetridge.com',
    phone: '(704) 555-0123',
    password: 'correct horse battery staple',
    joinPropertyId: null,
  }, 1760000000000);

  assert.equal('password' in draft, false);
  assert.equal(Object.keys(draft).some(k => /pass/i.test(k)), false);
  const json = JSON.stringify(draft);
  assert.equal(json.includes('correct horse battery staple'), false);
  assert.equal(/pass/i.test(json), false);
  // The fields it DOES keep are the property + account ones.
  assert.equal(draft.name, 'Sunset Ridge Apartments');
  assert.equal(draft.email, 'dana@sunsetridge.com');
  assert.equal(draft.savedAt, 1760000000000);
});

test('the draft key is the one the spec names', () => {
  assert.equal(DRAFT_KEY, 'lotlogic_signup_draft');
  assert.equal(DRAFT_TTL_MS, 24 * 60 * 60 * 1000);
});

test('a draft older than 24 h is dropped, a fresh one is read back', () => {
  const now = 1760000000000;
  const fresh = JSON.stringify(serializeDraft({ name: 'Sunset Ridge Apartments' }, now - 60_000));
  assert.equal(readDraft(fresh, now).name, 'Sunset Ridge Apartments');

  const stale = JSON.stringify(serializeDraft({ name: 'Sunset Ridge Apartments' }, now - DRAFT_TTL_MS - 1));
  assert.equal(readDraft(stale, now), null);

  assert.equal(readDraft(null, now), null);
  assert.equal(readDraft('not json', now), null);
  assert.equal(readDraft('{"name":"no savedAt"}', now), null);
});

// ── 8. 422 → field messages + summary ──────────────────────

test('a Pydantic 422 maps detail[].msg onto the form fields and a summary list', () => {
  const { fields, messages } = fieldErrorsFrom422([
    { loc: ['body', 'property', 'name'], msg: 'String should have at least 2 characters' },
    { loc: ['body', 'account', 'phone'], msg: 'not a possible phone number' },
    { loc: ['body', 'account', 'password'], msg: 'String should have at least 12 characters' },
  ]);
  assert.equal(fields.propertyName, 'String should have at least 2 characters');
  assert.equal(fields.phone, 'not a possible phone number');
  assert.equal(fields.password, 'String should have at least 12 characters');
  assert.deepEqual(messages, [
    'String should have at least 2 characters',
    'not a possible phone number',
    'String should have at least 12 characters',
  ]);
});

test('422 mapping covers contact_name / position / postal_code and survives junk', () => {
  const { fields } = fieldErrorsFrom422([
    { loc: ['body', 'account', 'contact_name'], msg: 'too short' },
    { loc: ['body', 'account', 'position'], msg: 'required' },
    { loc: ['body', 'property', 'postal_code'], msg: 'bad zip' },
  ]);
  assert.equal(fields.fullName, 'too short');
  assert.equal(fields.role, 'required');
  assert.equal(fields.address, 'bad zip');

  assert.deepEqual(fieldErrorsFrom422(null), { fields: {}, messages: [] });
  assert.deepEqual(fieldErrorsFrom422('nope'), { fields: {}, messages: [] });
  // An unmapped loc still contributes to the summary, so nothing is silent.
  const odd = fieldErrorsFrom422([{ loc: ['body', 'client_tz'], msg: 'unknown timezone' }]);
  assert.deepEqual(odd.fields, {});
  assert.deepEqual(odd.messages, ['unknown timezone']);
  // A plain string detail (not a Pydantic array) is a summary line too.
  assert.deepEqual(fieldErrorsFrom422(['just a string']), { fields: {}, messages: ['just a string'] });
});
