// Task F3 — the long-term parking-pass request on /apt/<qr>?role=resident.
// Tests for the flow's pure model (src/shared/aptFlow.js): the step router,
// the S1 gate, field validation, phone formatting, the per-unit cap, the
// persistence reducer (localStorage, 24 h TTL), the backend error → plain
// language map, the restored-upload card state, and the copy rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  STRINGS, TTL_MS, storageKey, emptyFlow, addVehicle, removeVehicle,
  parseStep, resolveStep, nextStep, prevStep, stepCaption,
  vehicleCap, canAddVehicle, requiresRegistration,
  formatPhone, phoneToE164, validateField, validateStep,
  slotId, fieldId, cardId, docRefs, docState, docKeyValid,
  serializeFlow, restoreFlow, receiptFlow,
  registerErrorMessage, isRegistrationFieldRejected, invalidDocSlots,
  formatSubmitted, copyText, displayPlate,
} from '../src/shared/aptFlow.js';
import { cardStatusText, isSatisfied } from '../src/shared/docCard.js';

const S = STRINGS.en;
const PID = '11111111-2222-4333-8444-555555555555';
const OTHER_PID = '99999999-2222-4333-8444-555555555555';
const HEX = 'a'.repeat(32);
const key = (kind, ext = 'jpg', pid = PID) => `apt/${pid}/${kind}/${HEX}.${ext}`;
const ref = (kind, ext = 'jpg') => ({ key: key(kind, ext), name: `${kind}.${ext}`, size: 2048, type: ext === 'pdf' ? 'application/pdf' : 'image/jpeg' });
const NOW = Date.UTC(2026, 9, 15, 1, 42); // Wed Oct 14 2026, 9:42 PM ET

const CTX = { cap: 2, requireRegistration: true };

/** A flow with everything a complete request needs, one vehicle. */
function completeFlow() {
  const f = emptyFlow();
  f.leaseholder = 'yes';
  f.name = 'Jane Smith';
  f.unit = '214';
  f.phone = '(704) 555-0123';
  f.email = 'jane@example.com';
  f.vehicles[0].plate = 'ABC 1234';
  f.vehicles[0].docs = { plate: ref('plate'), registration: ref('registration', 'pdf') };
  f.another = 'no';
  f.docs = { id: ref('id'), lease: ref('lease', 'pdf') };
  return f;
}

// ── the step router ─────────────────────────────────────────────────────────

test('a new flow starts on S1 with one empty vehicle', () => {
  const f = emptyFlow();
  assert.equal(f.step, 'start');
  assert.equal(f.leaseholder, null);
  assert.equal(f.vehicles.length, 1);
  assert.equal(f.vehicles[0].vid, 'v1');
  assert.equal(f.vehicles[0].plate, '');
  assert.equal(f.receipt, null);
});

test('Continue walks S1 → S2 → S3 → S3b → S4 → S5 in that order', () => {
  const f = completeFlow();
  assert.equal(nextStep('start', f, CTX), 'about');
  assert.equal(nextStep('about', f, CTX), 'vehicle:v1');
  assert.equal(nextStep('vehicle:v1', f, CTX), 'vehicles');
  assert.equal(nextStep('vehicles', f, CTX), 'documents');
  assert.equal(nextStep('documents', f, CTX), 'review');
  assert.equal(nextStep('review', f, CTX), 'received');
});

test('Back walks the same steps in reverse, and S1 goes back to the landing', () => {
  let f = completeFlow();
  ({ flow: f } = addVehicle(f));
  assert.equal(prevStep('review', f), 'documents');
  assert.equal(prevStep('documents', f), 'vehicles');
  assert.equal(prevStep('vehicles', f), 'vehicle:v2', 'the list goes back to the last vehicle');
  assert.equal(prevStep('vehicle:v2', f), 'vehicles', 'a second vehicle goes back to the list');
  assert.equal(prevStep('vehicle:v1', f), 'about', 'the first vehicle goes back to About you');
  assert.equal(prevStep('about', f), 'start');
  assert.equal(prevStep('start', f), 'landing');
});

test('S1 gate: Yes goes to About you, No goes to the short-term parking pass', () => {
  const f = emptyFlow();
  f.leaseholder = 'yes';
  assert.equal(nextStep('start', f, CTX), 'about');
  f.leaseholder = 'no';
  assert.equal(nextStep('start', f, CTX), 'short-term');
});

test('S1 gate: Start with no answer is an error, not a move', () => {
  const f = emptyFlow();
  assert.deepEqual(validateStep('start', f, CTX), [{ field: 'leaseholder-yes', message: S.start.errorGate }]);
  assert.equal(S.start.errorGate, 'Select whether your name is on the lease');
});

test('S3b: Yes adds a vehicle, No (or a full unit) moves on to the documents', () => {
  const f = completeFlow();
  f.another = 'yes';
  assert.equal(nextStep('vehicles', f, CTX), 'vehicle:new');
  f.another = 'no';
  assert.equal(nextStep('vehicles', f, CTX), 'documents');
  // at the cap the question is not asked, so the answer does not matter
  const full = addVehicle(completeFlow()).flow;
  full.another = 'yes';
  assert.equal(nextStep('vehicles', full, CTX), 'documents');
  // no vehicles left: the list's button adds one
  const none = removeVehicle(completeFlow(), 'v1');
  assert.equal(nextStep('vehicles', none, CTX), 'vehicle:new');
});

test('a step reached from "Change" on S5 returns to S5', () => {
  const f = completeFlow();
  f.returnTo = 'review';
  assert.equal(nextStep('about', f, CTX), 'review');
  assert.equal(nextStep('vehicle:v1', f, CTX), 'review');
  assert.equal(nextStep('documents', f, CTX), 'review');
  // the list still asks its question first when the unit has room and no answer
  f.another = null;
  assert.equal(nextStep('vehicles', f, CTX), 'vehicles');
});

test('addVehicle numbers vehicles and never reuses a removed number', () => {
  let f = emptyFlow();
  let vid;
  ({ flow: f, vid } = addVehicle(f));
  assert.equal(vid, 'v2');
  f = removeVehicle(f, 'v2');
  ({ flow: f, vid } = addVehicle(f));
  assert.equal(vid, 'v3', 'v2 was removed; a history entry for it must not land on the new one');
  assert.deepEqual(f.vehicles.map((v) => v.vid), ['v1', 'v3']);
});

test('addVehicle and removeVehicle do not mutate the flow they are given', () => {
  const f = emptyFlow();
  const before = JSON.stringify(f);
  addVehicle(f);
  removeVehicle(f, 'v1');
  assert.equal(JSON.stringify(f), before);
});

test('parseStep reads the step keys and rejects anything else', () => {
  assert.deepEqual(parseStep('vehicle:v2'), { name: 'vehicle', vid: 'v2' });
  assert.deepEqual(parseStep('review'), { name: 'review', vid: null });
  for (const bad of ['', 'vehicle', 'vehicle:', 'vehicle:x1', 'landing2', null, undefined, 42, 'toString']) {
    assert.equal(parseStep(bad), null, String(bad));
  }
});

test('resolveStep keeps a valid step and repairs one that no longer exists', () => {
  const f = completeFlow();
  assert.equal(resolveStep('documents', f), 'documents');
  assert.equal(resolveStep('vehicle:v1', f), 'vehicle:v1');
  assert.equal(resolveStep('vehicle:v9', f), 'vehicles', 'a removed vehicle falls back to the list');
  assert.equal(resolveStep('nonsense', f), 'start');
  assert.equal(resolveStep('received', f), 'review', 'nothing was sent yet');
});

test('resolveStep holds every step behind the S1 gate', () => {
  const f = completeFlow();
  f.leaseholder = null;
  assert.equal(resolveStep('review', f), 'start');
  f.leaseholder = 'no';
  assert.equal(resolveStep('about', f), 'start');
});

test('once the request is sent, every step resolves to the receipt', () => {
  const f = receiptFlow(completeFlow(), { now: NOW, refs: { v1: '8F3E2A1D' }, registrationSent: { v1: true } });
  for (const step of ['start', 'about', 'vehicle:v1', 'vehicles', 'documents', 'review', 'received']) {
    assert.equal(resolveStep(step, f), 'received', step);
  }
});

test('step captions: Step n of 5, and Vehicle i of the cap on S3', () => {
  let f = completeFlow();
  ({ flow: f } = addVehicle(f));
  assert.equal(stepCaption('start', f, CTX), 'Step 1 of 5');
  assert.equal(stepCaption('about', f, CTX), 'Step 2 of 5');
  assert.equal(stepCaption('vehicle:v2', f, CTX), 'Step 3 of 5 · Vehicle 2 of 2');
  assert.equal(stepCaption('vehicle:v1', f, { ...CTX, cap: null }), 'Step 3 of 5 · Vehicle 1');
  assert.equal(stepCaption('vehicle:v1', f, { ...CTX, cap: 1 }), 'Step 3 of 5');
  assert.equal(stepCaption('vehicles', f, CTX), 'Step 3 of 5');
  assert.equal(stepCaption('documents', f, CTX), 'Step 4 of 5');
  assert.equal(stepCaption('review', f, CTX), 'Step 5 of 5');
  assert.equal(stepCaption('received', f, CTX), null);
});

// ── the per-unit cap ────────────────────────────────────────────────────────

test('vehicleCap reads max_vehicles_per_unit; missing, null or nonsense is no cap', () => {
  assert.equal(vehicleCap({ max_vehicles_per_unit: 2 }), 2);
  assert.equal(vehicleCap({ max_vehicles_per_unit: 1 }), 1);
  assert.equal(vehicleCap({ max_vehicles_per_unit: '3' }), 3);
  for (const v of [null, undefined, 0, -1, 'two', 2.5, NaN]) {
    assert.equal(vehicleCap({ max_vehicles_per_unit: v }), null, String(v));
  }
  assert.equal(vehicleCap({}), null, 'the column is missing before the backend is migrated');
  assert.equal(vehicleCap(null), null);
});

test('canAddVehicle: no cap always has room; a cap of 1 or 2 stops at the cap', () => {
  assert.equal(canAddVehicle(5, null), true);
  assert.equal(canAddVehicle(0, 1), true);
  assert.equal(canAddVehicle(1, 1), false);
  assert.equal(canAddVehicle(1, 2), true);
  assert.equal(canAddVehicle(2, 2), false);
});

test('the cap lines read naturally for 1, 2 and no cap', () => {
  assert.equal(S.start.ruleCap(2), 'Each unit can register up to 2 vehicles.');
  assert.equal(S.start.ruleCap(1), 'Each unit can register 1 vehicle.');
  assert.equal(S.vehicles.capReached(2), "This unit's limit is 2 vehicles. To change a vehicle later, contact the office.");
  assert.equal(S.vehicles.capReached(1), "This unit's limit is 1 vehicle. To change a vehicle later, contact the office.");
});

test('the S3b question is required only while the unit has room', () => {
  const f = completeFlow();
  f.another = null;
  assert.deepEqual(validateStep('vehicles', f, CTX), [{ field: 'another-yes', message: S.vehicles.errorAnother }]);
  assert.deepEqual(validateStep('vehicles', f, { ...CTX, cap: 1 }), [], 'a full unit is not asked');
  assert.deepEqual(validateStep('vehicles', removeVehicle(f, 'v1'), CTX), [{ field: 'add-vehicle', message: S.vehicles.none }]);
});

test('requiresRegistration is true only for an explicit true (missing column → false)', () => {
  assert.equal(requiresRegistration({ require_vehicle_registration: true }), true);
  for (const v of [false, null, undefined, 'true', 1]) {
    assert.equal(requiresRegistration({ require_vehicle_registration: v }), false, String(v));
  }
  assert.equal(requiresRegistration({}), false);
});

// ── field validation ────────────────────────────────────────────────────────

test('About you: one specific message per empty field, in label language', () => {
  const f = completeFlow();
  f.name = ' ';
  f.unit = '';
  f.phone = '';
  f.email = '';
  assert.deepEqual(validateStep('about', f, CTX), [
    { field: 'name', message: 'Enter your full name' },
    { field: 'unit', message: 'Enter your unit number' },
    { field: 'phone', message: 'Enter a phone number, like (704) 555-0123' },
    { field: 'email', message: 'Enter your email address' },
  ]);
});

test('About you: a complete step has no errors', () => {
  assert.deepEqual(validateStep('about', completeFlow(), CTX), []);
});

test('validateField: phone and email formats', () => {
  assert.equal(validateField('phone', '555-0123'), 'Enter a phone number, like (704) 555-0123');
  assert.equal(validateField('phone', '(704) 555-0123'), null);
  assert.equal(validateField('email', 'jane@'), 'Enter an email address in the correct format, like name@example.com');
  assert.equal(validateField('email', 'jane smith@example.com'), 'Enter an email address in the correct format, like name@example.com');
  assert.equal(validateField('email', ' jane@example.com '), null);
});

test('validateField: the plate must have letters or numbers, and nothing else', () => {
  assert.equal(validateField('plate', ''), 'Enter the license plate');
  assert.equal(validateField('plate', ' - '), 'Enter the license plate');
  assert.equal(validateField('plate', 'A'), 'Enter the license plate');
  assert.equal(validateField('plate', 'ABC#123'), 'Enter letters and numbers only');
  assert.equal(validateField('plate', 'abc 1234'), null);
  assert.equal(validateField('plate', 'ABC-1234'), null);
});

test('S3: the plate, its photo and (when required) the registration card', () => {
  const f = completeFlow();
  f.vehicles[0].plate = '';
  f.vehicles[0].docs = { plate: null, registration: null };
  assert.deepEqual(validateStep('vehicle:v1', f, CTX), [
    { field: 'plate-v1', message: 'Enter the license plate' },
    { field: 'card-plate-v1', message: 'Add a photo of the plate' },
    { field: 'card-registration-v1', message: 'Add your vehicle registration card' },
  ]);
  // not required → the card is absent and never an error
  assert.deepEqual(
    validateStep('vehicle:v1', f, { ...CTX, requireRegistration: false }).map((e) => e.field),
    ['plate-v1', 'card-plate-v1'],
  );
});

test('S3: a card in an error state reports its own message', () => {
  const f = completeFlow();
  f.vehicles[0].docs.plate = null;
  const docStates = { 'plate:v1': { status: 'error', error: 'too_large', retryable: false, file: null, key: null } };
  const errors = validateStep('vehicle:v1', f, { ...CTX, docStates });
  assert.deepEqual(errors, [{ field: 'card-plate-v1', message: 'The selected file must be smaller than 10 MB' }]);
});

test('S3: the same plate twice in one request is caught', () => {
  let f = completeFlow();
  ({ flow: f } = addVehicle(f));
  f.vehicles[1].plate = 'abc-1234';
  f.vehicles[1].docs = { plate: ref('plate'), registration: ref('registration') };
  assert.deepEqual(validateStep('vehicle:v2', f, CTX), [
    { field: 'plate-v2', message: "You've already added ABC1234 to this request" },
  ]);
});

test('S4: the ID and the lease', () => {
  const f = completeFlow();
  f.docs = { id: null, lease: null };
  assert.deepEqual(validateStep('documents', f, CTX), [
    { field: 'card-id', message: 'Add a photo of your ID' },
    { field: 'card-lease', message: 'Add your lease' },
  ]);
});

test('S5 re-checks every step, so a cleared upload blocks the send', () => {
  const f = completeFlow();
  assert.deepEqual(validateStep('review', f, CTX), []);
  f.docs.lease = null;
  f.email = 'nope';
  assert.deepEqual(validateStep('review', f, CTX).map((e) => e.message), [
    'Enter an email address in the correct format, like name@example.com',
    'Add your lease',
  ]);
});

test('a vehicle already sent is not re-validated (it is locked)', () => {
  const f = completeFlow();
  f.vehicles[0].ref = '8F3E2A1D';
  f.vehicles[0].docs = { plate: null, registration: null };
  assert.deepEqual(validateStep('vehicle:v1', f, CTX), []);
});

// ── phone ───────────────────────────────────────────────────────────────────

test('formatPhone shows a US number as (704) 555-0123 and leaves anything else as typed', () => {
  for (const raw of ['7045550123', '704-555-0123', '704.555.0123', '1 704 555 0123', '+1 (704) 555-0123']) {
    assert.equal(formatPhone(raw), '(704) 555-0123', raw);
  }
  assert.equal(formatPhone(' +44 20 7946 0958 '), '+44 20 7946 0958');
  assert.equal(formatPhone('555-0123'), '555-0123');
});

test('phoneToE164 stores +1XXXXXXXXXX, or null when it is not a phone number', () => {
  assert.equal(phoneToE164('(704) 555-0123'), '+17045550123');
  assert.equal(phoneToE164('1-704-555-0123'), '+17045550123');
  assert.equal(phoneToE164('+44 20 7946 0958'), '+442079460958');
  assert.equal(phoneToE164('555-0123'), null);
  assert.equal(phoneToE164(''), null);
  assert.equal(phoneToE164('+1 234'), null);
});

// ── persistence ─────────────────────────────────────────────────────────────

test('the storage key is per qr_code_id', () => {
  assert.equal(storageKey('fort-mill-townhomes-i'), 'lotlogic:apt:fort-mill-townhomes-i');
  assert.notEqual(storageKey('a'), storageKey('b'));
});

test('serialize → restore round-trips answers and upload keys', () => {
  const f = completeFlow();
  f.step = 'documents';
  f.returnTo = 'review';
  const back = restoreFlow(serializeFlow(f, { now: NOW, propertyId: PID }), { now: NOW + 1000, propertyId: PID });
  assert.deepEqual(back, f);
});

test('nothing but the whitelisted answers is written (never file bytes)', () => {
  const f = completeFlow();
  f.vehicles[0].docs.plate.blob = { bytes: [1, 2, 3] };
  f.vehicles[0].docs.plate.thumbUrl = 'blob:https://example.test/123';
  f.secret = 'not an answer';
  const raw = serializeFlow(f, { now: NOW, propertyId: PID });
  assert.doesNotMatch(raw, /bytes|blob:|thumbUrl|not an answer/);
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['flow', 'propertyId', 'savedAt', 'v']);
});

test('restore: 24 hours is the limit', () => {
  const raw = serializeFlow(completeFlow(), { now: NOW, propertyId: PID });
  assert.equal(TTL_MS, 24 * 60 * 60 * 1000);
  assert.notEqual(restoreFlow(raw, { now: NOW + TTL_MS - 1, propertyId: PID }), null);
  assert.equal(restoreFlow(raw, { now: NOW + TTL_MS + 1, propertyId: PID }), null);
});

test('restore: malformed, another version, another property or a future stamp is nothing', () => {
  const good = JSON.parse(serializeFlow(completeFlow(), { now: NOW, propertyId: PID }));
  const opts = { now: NOW, propertyId: PID };
  assert.equal(restoreFlow(null, opts), null);
  assert.equal(restoreFlow('', opts), null);
  assert.equal(restoreFlow('{not json', opts), null);
  assert.equal(restoreFlow('"a string"', opts), null);
  assert.equal(restoreFlow(JSON.stringify({ ...good, v: 2 }), opts), null);
  assert.equal(restoreFlow(JSON.stringify({ ...good, propertyId: OTHER_PID }), opts), null);
  assert.equal(restoreFlow(JSON.stringify({ ...good, savedAt: NOW + 10 * 60 * 1000 }), opts), null);
  assert.equal(restoreFlow(JSON.stringify({ ...good, flow: null }), opts), null);
});

test('restore drops an upload key that is not one of this property\'s, and keeps the rest', () => {
  const f = completeFlow();
  f.docs.id = { ...ref('id'), key: key('id', 'jpg', OTHER_PID) };
  f.docs.lease = { ...ref('lease'), key: key('plate') };     // a plate key in the lease slot
  f.vehicles[0].docs.plate = { ...ref('plate'), key: 'https://evil.example/x.jpg' };
  const back = restoreFlow(serializeFlow(f, { now: NOW, propertyId: PID }), { now: NOW, propertyId: PID });
  assert.equal(back.docs.id, null);
  assert.equal(back.docs.lease, null);
  assert.equal(back.vehicles[0].docs.plate, null);
  assert.deepEqual(back.vehicles[0].docs.registration, ref('registration', 'pdf'));
});

test('restore cleans what it reads: lengths, enums and vehicle ids', () => {
  const raw = JSON.stringify({
    v: 1, savedAt: NOW, propertyId: PID,
    flow: {
      step: 'about', leaseholder: 'maybe', another: 'sure', returnTo: 'elsewhere',
      name: 'x'.repeat(500), unit: 7, phone: null, email: ['a'],
      vehicles: [{ vid: 'v1', plate: 'Z'.repeat(50), docs: {}, ref: 'not-a-ref' }, { vid: '<script>', plate: 'B' }],
      docs: 'nope', receipt: 'nope',
    },
  });
  const f = restoreFlow(raw, { now: NOW, propertyId: PID });
  assert.equal(f.leaseholder, null);
  assert.equal(f.another, null);
  assert.equal(f.returnTo, null);
  assert.equal(f.name.length, 80);
  assert.equal(f.unit, '');
  assert.equal(f.phone, '');
  assert.equal(f.email, '');
  assert.equal(f.vehicles.length, 1, 'a vehicle with a bad id is dropped');
  assert.equal(f.vehicles[0].plate.length, 10);
  assert.equal(f.vehicles[0].ref, null);
  assert.deepEqual(f.vehicles[0].docs, { plate: null, registration: null });
  assert.deepEqual(f.docs, { id: null, lease: null });
  assert.equal(f.receipt, null);
});

test('restore keeps at least one vehicle so S3 always has something to show', () => {
  const raw = JSON.stringify({ v: 1, savedAt: NOW, propertyId: PID, flow: { step: 'start', vehicles: [] } });
  const f = restoreFlow(raw, { now: NOW, propertyId: PID });
  assert.equal(f.vehicles.length, 1);
});

test('the receipt keeps plates, references and the time, and forgets the answers and keys', () => {
  const f = receiptFlow(completeFlow(), { now: NOW, refs: { v1: '8f3e2a1d' }, registrationSent: { v1: false } });
  assert.equal(f.step, 'received');
  assert.deepEqual(f.receipt, {
    submittedAt: NOW,
    unit: '214',
    vehicles: [{ plate: 'ABC1234', ref: '8F3E2A1D', registrationSent: false }],
  });
  assert.equal(f.name, '');
  assert.equal(f.phone, '');
  assert.equal(f.email, '');
  assert.deepEqual(f.docs, { id: null, lease: null });
  const back = restoreFlow(serializeFlow(f, { now: NOW, propertyId: PID }), { now: NOW + 60_000, propertyId: PID });
  assert.deepEqual(back.receipt, f.receipt, 'a reload shows the same receipt');
  assert.equal(resolveStep(back.step, back), 'received');
});

// ── restored uploads ────────────────────────────────────────────────────────

test('a restored key with no local file is "Uploaded earlier", satisfied, with no thumbnail', () => {
  const f = restoreFlow(serializeFlow(completeFlow(), { now: NOW, propertyId: PID }), { now: NOW, propertyId: PID });
  const state = docState(f.docs.id);
  assert.equal(state.status, 'restored');
  assert.equal(state.key, key('id'));
  assert.equal(state.preview, false, 'no thumbnail without local bytes');
  assert.equal(isSatisfied(state), true);
  assert.equal(cardStatusText(state, S.card), 'Uploaded earlier');
  assert.equal(docState(null).status, 'empty');
  assert.equal(isSatisfied(docState(null)), false);
});

test('docRefs lists the slots a request needs, with the registration card only when required', () => {
  const f = completeFlow();
  assert.deepEqual(Object.keys(docRefs(f, CTX)).sort(), ['id', 'lease', 'plate:v1', 'registration:v1']);
  assert.deepEqual(Object.keys(docRefs(f, { ...CTX, requireRegistration: false })).sort(), ['id', 'lease', 'plate:v1']);
});

test('slot, field and card ids', () => {
  assert.equal(slotId('id'), 'id');
  assert.equal(slotId('plate', 'v2'), 'plate:v2');
  assert.equal(fieldId('plate', 'v2'), 'plate-v2');
  assert.equal(cardId('registration:v2'), 'card-registration-v2');
  assert.equal(cardId('lease'), 'card-lease');
});

test('docKeyValid accepts only this property\'s key for the right kind', () => {
  assert.equal(docKeyValid(key('id'), PID, 'id'), true);
  assert.equal(docKeyValid(key('registration', 'pdf'), PID, 'registration'), true);
  assert.equal(docKeyValid(key('id'), PID, 'lease'), false);
  assert.equal(docKeyValid(key('id', 'jpg', OTHER_PID), PID, 'id'), false);
  assert.equal(docKeyValid(`apt/${PID}/id/${HEX}.exe`, PID, 'id'), false);
  assert.equal(docKeyValid(`apt/${PID}/id/short.jpg`, PID, 'id'), false);
  assert.equal(docKeyValid('', PID, 'id'), false);
});

// ── backend errors → plain language (brief item 10) ─────────────────────────

const ERR_CTX = { unit: '214', plate: 'ABC1234', limit: 2, vid: 'v1', phone: '(704) 555-0100' };

test('unit_vehicle_limit names the unit and the limit', () => {
  const m = registerErrorMessage({ status: 409, detail: 'unit_vehicle_limit' }, ERR_CTX);
  assert.equal(m.code, 'unit_vehicle_limit');
  assert.equal(m.message, 'Unit 214 already has 2 vehicles registered or waiting for approval. Ask the office if one should be removed.');
  assert.equal(
    registerErrorMessage({ status: 409, detail: 'unit_vehicle_limit' }, { ...ERR_CTX, limit: 1 }).message,
    'Unit 214 already has 1 vehicle registered or waiting for approval. Ask the office if one should be removed.',
  );
  assert.match(registerErrorMessage({ status: 409, detail: 'unit_vehicle_limit' }, { ...ERR_CTX, limit: null }).message,
    /^Unit 214 already has the most vehicles allowed/);
});

test('registration_required asks for the card and points at it', () => {
  const m = registerErrorMessage({ status: 400, detail: 'registration_required' }, ERR_CTX);
  assert.equal(m.message, 'Add your vehicle registration card.');
  assert.equal(m.field, 'review-vehicle-v1');
});

test('a duplicate plate (409, today\'s sentence or a code) names the plate', () => {
  for (const detail of ['This license plate is already registered at this lot.', 'duplicate_registration']) {
    const m = registerErrorMessage({ status: 409, detail }, ERR_CTX);
    assert.equal(m.code, 'duplicate_registration', detail);
    assert.equal(m.message, 'ABC1234 already has an approved parking pass at this property.');
  }
});

test('an invalid document reference says an upload expired and asks for it again', () => {
  const m = registerErrorMessage({ status: 400, detail: 'invalid document reference' }, ERR_CTX);
  assert.equal(m.code, 'invalid_document');
  assert.equal(m.message, 'One of your uploads expired — add it again.');
});

test('recaptcha:* is the automated-access check, with a retry', () => {
  const m = registerErrorMessage({ status: 400, detail: 'recaptcha:low_score:0.05<0.10' }, ERR_CTX);
  assert.equal(m.code, 'recaptcha');
  assert.equal(m.message, 'The automated-access check failed – try again.');
  assert.equal(registerErrorMessage({ code: 'recaptcha' }, ERR_CTX).code, 'recaptcha');
});

test('a blocked reCAPTCHA script is the page-level blocker message', () => {
  const m = registerErrorMessage({ code: 'recaptcha_blocked' }, ERR_CTX);
  assert.equal(m.code, 'recaptcha_blocked');
  assert.equal(m.message, 'Something is blocking this page from sending. Turn off content blockers for this site, or call (704) 555-0100.');
  assert.equal(
    registerErrorMessage({ code: 'recaptcha_blocked' }, { ...ERR_CTX, phone: null }).message,
    'Something is blocking this page from sending. Turn off content blockers for this site, then try again.',
  );
});

test('network failures and timeouts say the answers are saved', () => {
  const network = "We couldn't reach the office's system. Your answers are saved on this phone — try again.";
  const abort = new Error('aborted');
  abort.name = 'AbortError';
  for (const err of [abort, new TypeError('Failed to fetch'), new SyntaxError('Unexpected token <'), {}]) {
    const m = registerErrorMessage(err, ERR_CTX);
    assert.equal(m.code, 'network', String(err));
    assert.equal(m.message, network);
  }
});

test('unit_required and a 422 on the email point back at About you', () => {
  assert.deepEqual(
    (({ code, message, field }) => ({ code, message, field }))(registerErrorMessage({ status: 400, detail: 'unit_required' }, ERR_CTX)),
    { code: 'unit_required', message: 'Enter your unit number', field: 'review-unit' },
  );
  const email = registerErrorMessage({ status: 422, detail: [{ type: 'value_error', loc: ['body', 'email'], msg: 'bad' }] }, ERR_CTX);
  assert.equal(email.code, 'email');
  assert.equal(email.message, 'Enter an email address in the correct format, like name@example.com');
});

test('anything else is a calm generic message, never the raw backend text', () => {
  const m = registerErrorMessage({ status: 400, detail: 'This property issues short-term parking passes only. Please register a temporary pass instead.' }, ERR_CTX);
  assert.equal(m.code, 'unknown');
  assert.equal(m.message, 'Something went wrong sending your request. Your answers are saved on this phone — try again.');
  assert.equal(registerErrorMessage({ status: 500, detail: 'registration_failed' }, ERR_CTX).code, 'unknown');
});

test('the 422 that means "registration_doc_url not deployed yet" is recognised, and only that one', () => {
  assert.equal(isRegistrationFieldRejected({
    status: 422, detail: [{ type: 'extra_forbidden', loc: ['body', 'registration_doc_url'], msg: 'Extra inputs are not permitted' }],
  }), true);
  assert.equal(isRegistrationFieldRejected({ status: 422, detail: [{ loc: ['body', 'email'] }] }), false);
  assert.equal(isRegistrationFieldRejected({ status: 400, detail: 'registration_doc_url' }), false);
  assert.equal(isRegistrationFieldRejected(null), false);
});

test('invalidDocSlots finds the key the backend refused, or all of them when it cannot tell', () => {
  const refs = { id: ref('id'), lease: { ...ref('lease'), key: 'bogus' }, 'plate:v1': ref('plate'), 'registration:v1': ref('registration') };
  assert.deepEqual(invalidDocSlots(refs, PID), ['lease']);
  const allGood = { id: ref('id'), lease: ref('lease') };
  assert.deepEqual(invalidDocSlots(allGood, PID).sort(), ['id', 'lease']);
  assert.deepEqual(invalidDocSlots({ id: null, lease: ref('lease') }, PID), ['lease'], 'an empty slot is not a culprit');
});

// ── the receipt ─────────────────────────────────────────────────────────────

test('the submitted time is rendered in Eastern time with "ET"', () => {
  assert.equal(formatSubmitted(NOW), 'Wed Oct 14, 9:42 PM ET');
  assert.equal(formatSubmitted(Date.UTC(2026, 11, 1, 17, 5)), 'Tue Dec 1, 12:05 PM ET', 'EST in winter');
});

test('Copy reference copies one line per vehicle', () => {
  const receipt = { submittedAt: NOW, unit: '214', vehicles: [{ plate: 'ABC1234', ref: '8F3E2A1D' }, { plate: 'XYZ789', ref: '1A2B3C4D' }] };
  assert.equal(copyText(receipt), 'ABC1234 ref 8F3E2A1D\nXYZ789 ref 1A2B3C4D');
});

test('displayPlate shows the plate the way it is registered', () => {
  assert.equal(displayPlate('abc 1234'), 'ABC1234');
  assert.equal(displayPlate('ABC-1234 SC'), 'ABC1234', 'the shared normalizer strips a state');
  assert.equal(displayPlate(''), '');
});

// ── copy ────────────────────────────────────────────────────────────────────

const BANNED = /\b(resident|visitor|permanent|temporary|guest|driver)s?\b/i;

/** Every string STRINGS.en can produce, functions called with sample arguments. */
function allStrings(node, path = 'STRINGS.en') {
  if (typeof node === 'string') return [[path, node]];
  if (typeof node === 'function') {
    const out = node('ABC1234', 2, '(704) 555-0100');
    return allStrings(out, `${path}()`);
  }
  if (Array.isArray(node)) return node.flatMap((v, i) => allStrings(v, `${path}[${i}]`));
  if (node && typeof node === 'object') return Object.entries(node).flatMap(([k, v]) => allStrings(v, `${path}.${k}`));
  return [];
}

test('every string a resident can see says "parking pass", never a banned pass word', () => {
  const strings = allStrings(S);
  assert.ok(strings.length > 100, `only ${strings.length} strings found — the walk is broken`);
  const bad = strings.filter(([, s]) => BANNED.test(s));
  assert.deepEqual(bad, []);
});

test('no status text is shouted in capitals', () => {
  const shouty = allStrings(S).filter(([, s]) => /\b[A-Z]{4,}\b/.test(s.replace(/\b(PDF|HEIC|JPG|PNG|WEBP|DMV|ID|MB|KB|ET|PM|AM)\b/g, '')));
  assert.deepEqual(shouty, []);
});

test('the two status phrases are the constraints\' wording', () => {
  assert.equal(S.received.status, 'Pending approval');
  assert.equal(S.received.protected, 'Protected from towing while the office reviews your request (up to 72 hours).');
  assert.match(S.start.ruleReview, /protected from towing while the office reviews your request \(up to 72 hours\)/);
});

test('the attestation is a statement, with the unit in it', () => {
  assert.equal(S.review.attest('214'),
    "By sending this request you confirm you're named on the lease for Unit 214 and these vehicles are registered to you.");
});
