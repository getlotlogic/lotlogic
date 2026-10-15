// Task F3 — the long-term parking-pass request on /apt/<qr>?role=resident.
// Tests for the flow's pure model (src/shared/aptFlow.js): the step router,
// the S1 gate, field validation, phone formatting, the per-unit cap, the
// persistence reducer (localStorage, 24 h TTL), the backend error → plain
// language map, the restored-upload card state, and the copy rule.
// Task F5a adds the vehicle's make, model and color to all of it (the last
// section before "copy").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  STRINGS, TTL_MS, storageKey, emptyFlow, addVehicle, removeVehicle,
  parseStep, resolveStep, nextStep, prevStep, stepCaption,
  vehicleCap, canAddVehicle, requiresRegistration,
  formatPhone, phoneToE164, validateField, validateStep,
  slotId, fieldId, cardId, docRefs, docState, docKeyValid,
  serializeFlow, restoreFlow, receiptFlow,
  registerErrorMessage, rejectedUnknownFields, docFields, sentFlags, invalidDocSlots,
  formatSubmitted, copyText, displayPlate, vehicleRowStatus,
  VEHICLE_COLORS, VEHICLE_MAKES, normalizeVehicleText, vehicleDescription, vehicleLineParts,
  vehicleFields, vehicleFieldErrors, vehicleBackendError,
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
  f.vehicles[0].make = 'Honda';
  f.vehicles[0].model = 'Civic';
  f.vehicles[0].color = 'white';
  f.vehicles[0].docs = { plate: ref('plate'), registration: ref('registration', 'pdf'), vehicle: null };
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

test('a vehicle has three document slots: the plate photo, the registration card and the optional vehicle photo', () => {
  const f = emptyFlow();
  assert.deepEqual(f.vehicles[0].docs, { plate: null, registration: null, vehicle: null });
  assert.equal(f.vehicles[0].vehiclePhotoSent, null);
  const { flow } = addVehicle(f);
  assert.deepEqual(flow.vehicles[1].docs, { plate: null, registration: null, vehicle: null });
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

test('S3: the photo of the vehicle is optional — not added is not an error', () => {
  const f = completeFlow();
  assert.equal(f.vehicles[0].docs.vehicle, null);
  assert.deepEqual(validateStep('vehicle:v1', f, CTX), []);
  assert.deepEqual(validateStep('vehicle:v1', f, { ...CTX, requireRegistration: false }), []);
  const empty = completeFlow();
  empty.vehicles[0].docs = { plate: null, registration: null, vehicle: null };
  assert.equal(validateStep('vehicle:v1', empty, CTX).some((e) => e.field === 'card-vehicle-v1'), false,
    'an empty vehicle photo card never joins the error summary');
});

test('S3: an added vehicle photo that failed is reported, in its own words, until it is fixed or removed', () => {
  const f = completeFlow();
  const failed = { 'vehicle:v1': { status: 'error', error: 'upload_failed', retryable: true, file: null, key: null } };
  assert.deepEqual(validateStep('vehicle:v1', f, { ...CTX, docStates: failed }), [
    { field: 'card-vehicle-v1', message: 'The selected file could not be uploaded – try again' },
  ]);
  const wrongType = { 'vehicle:v1': { status: 'error', error: 'wrong_type', retryable: false, file: null, key: null } };
  assert.deepEqual(validateStep('vehicle:v1', f, { ...CTX, docStates: wrongType }), [
    { field: 'card-vehicle-v1', message: 'The selected file must be a JPG, PNG or WEBP' },
  ], 'the vehicle photo is images only, like the plate photo');
  for (const status of ['empty', 'preparing', 'uploading', 'offline', 'done', 'skipped']) {
    const docStates = { 'vehicle:v1': { status, error: null, retryable: false, file: null, key: status === 'done' ? key('vehicle') : null } };
    assert.deepEqual(validateStep('vehicle:v1', f, { ...CTX, docStates }), [], status);
  }
});

test('S3b and S5 rows say in words what is attached (their thumbnails are decorative)', () => {
  const v = completeFlow().vehicles[0];
  const noReg = { ...CTX, requireRegistration: false };
  assert.equal(vehicleRowStatus(v, CTX, { done: true }), 'Photo and registration card added');
  assert.equal(vehicleRowStatus(v, noReg, { done: true }), 'Photo added');
  v.docs.vehicle = ref('vehicle');
  assert.equal(vehicleRowStatus(v, CTX, { done: true }), 'Plate photo, registration card and vehicle photo added');
  assert.equal(vehicleRowStatus(v, noReg, { done: true }), 'Plate and vehicle photos added');
  assert.equal(vehicleRowStatus(v, CTX, { done: false }), 'Not finished');
  v.ref = '8F3E2A1D';
  assert.equal(vehicleRowStatus(v, CTX, { done: true }), 'Sent · ref 8F3E2A1D');
});

test('S3b and S5: a vehicle whose added photo failed is not finished', () => {
  const f = completeFlow();
  const docStates = { 'vehicle:v1': { status: 'error', error: 'recaptcha', retryable: true, file: null, key: null } };
  assert.deepEqual(validateStep('vehicles', f, { ...CTX, docStates }), [{ field: 'row-v1', message: 'Finish ABC1234, or remove it' }]);
  assert.deepEqual(validateStep('review', f, { ...CTX, docStates }), [
    { field: 'review-vehicle-v1', message: 'The automated-access check failed – try again' },
  ]);
  assert.deepEqual(validateStep('review', f, CTX), [], 'after a reload (no live card) the saved answers decide');
});

test('S3: the same plate twice in one request is caught', () => {
  let f = completeFlow();
  ({ flow: f } = addVehicle(f));
  f.vehicles[1].plate = 'abc-1234';
  Object.assign(f.vehicles[1], { make: 'Ford', model: 'F-150', color: 'blue' });
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

test('the vehicle photo key round-trips, and is checked for this property and its own kind', () => {
  const f = completeFlow();
  f.vehicles[0].docs.vehicle = ref('vehicle');
  const back = restoreFlow(serializeFlow(f, { now: NOW, propertyId: PID }), { now: NOW, propertyId: PID });
  assert.deepEqual(back.vehicles[0].docs.vehicle, ref('vehicle'));
  assert.deepEqual(back, f);
  for (const bad of [key('plate'), key('vehicle', 'jpg', OTHER_PID), `apt/${PID}/vehicle/short.jpg`]) {
    f.vehicles[0].docs.vehicle = { ...ref('vehicle'), key: bad };
    const again = restoreFlow(serializeFlow(f, { now: NOW, propertyId: PID }), { now: NOW, propertyId: PID });
    assert.equal(again.vehicles[0].docs.vehicle, null, bad);
    assert.deepEqual(again.vehicles[0].docs.plate, ref('plate'), 'the other slots are kept');
  }
});

test('a vehicle already sent keeps whether its photo went with it', () => {
  const f = completeFlow();
  f.vehicles[0].ref = '8F3E2A1D';
  f.vehicles[0].vehiclePhotoSent = false;
  const back = restoreFlow(serializeFlow(f, { now: NOW, propertyId: PID }), { now: NOW, propertyId: PID });
  assert.equal(back.vehicles[0].vehiclePhotoSent, false);
  const raw = JSON.parse(serializeFlow(f, { now: NOW, propertyId: PID }));
  raw.flow.vehicles[0].vehiclePhotoSent = 'yes';
  assert.equal(restoreFlow(JSON.stringify(raw), { now: NOW, propertyId: PID }).vehicles[0].vehiclePhotoSent, null);
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
  assert.deepEqual(f.vehicles[0].docs, { plate: null, registration: null, vehicle: null });
  assert.equal(f.vehicles[0].vehiclePhotoSent, null);
  assert.deepEqual(f.docs, { id: null, lease: null });
  assert.equal(f.receipt, null);
});

test('restore keeps at least one vehicle so S3 always has something to show', () => {
  const raw = JSON.stringify({ v: 1, savedAt: NOW, propertyId: PID, flow: { step: 'start', vehicles: [] } });
  const f = restoreFlow(raw, { now: NOW, propertyId: PID });
  assert.equal(f.vehicles.length, 1);
});

test('the receipt keeps plates, references, the time and the email, and forgets the answers and keys', () => {
  const f = receiptFlow(completeFlow(), { now: NOW, refs: { v1: '8f3e2a1d' }, registrationSent: { v1: false } });
  assert.equal(f.step, 'received');
  assert.deepEqual(f.receipt, {
    submittedAt: NOW,
    unit: '214',
    email: 'jane@example.com',
    vehicles: [{
      plate: 'ABC1234', make: 'Honda', model: 'Civic', color: 'white',
      ref: '8F3E2A1D', registrationSent: false, vehiclePhotoSent: null, detailsSent: true,
    }],
  });
  assert.equal(f.name, '');
  assert.equal(f.phone, '');
  assert.equal(f.email, '');
  assert.deepEqual(f.docs, { id: null, lease: null });
  const back = restoreFlow(serializeFlow(f, { now: NOW, propertyId: PID }), { now: NOW + 60_000, propertyId: PID });
  assert.deepEqual(back.receipt, f.receipt, 'a reload shows the same receipt');
  assert.equal(resolveStep(back.step, back), 'received');
});

test('a reloaded receipt still says where the email went and which vehicle photo did not go', () => {
  const f = completeFlow();
  f.vehicles.push({ ...f.vehicles[0], vid: 'v2', plate: 'XYZ 789' });
  const sent = receiptFlow(f, {
    now: NOW, refs: { v1: '8F3E2A1D', v2: '1a2b3c4d' }, registrationSent: { v1: true, v2: true }, vehiclePhotoSent: { v1: true, v2: false },
  });
  assert.equal(sent.receipt.email, 'jane@example.com');
  assert.deepEqual(sent.receipt.vehicles.map((v) => v.vehiclePhotoSent), [true, false]);
  const back = restoreFlow(serializeFlow(sent, { now: NOW, propertyId: PID }), { now: NOW + 60_000, propertyId: PID });
  assert.deepEqual(back.receipt, sent.receipt);
});

test('the saved receipt is cleaned: a malformed email is dropped, unknown fields are not kept', () => {
  const sent = receiptFlow(completeFlow(), { now: NOW, refs: { v1: '8F3E2A1D' }, registrationSent: { v1: true } });
  const raw = JSON.parse(serializeFlow(sent, { now: NOW, propertyId: PID }));
  raw.flow.receipt.email = 'not an email<script>';
  raw.flow.receipt.name = 'Jane Smith';
  raw.flow.receipt.vehicles[0].vehiclePhotoSent = 'nope';
  raw.flow.receipt.vehicles[0].idKey = key('id');
  const back = restoreFlow(JSON.stringify(raw), { now: NOW, propertyId: PID });
  assert.equal(back.receipt.email, '');
  assert.deepEqual(Object.keys(back.receipt).sort(), ['email', 'submittedAt', 'unit', 'vehicles']);
  assert.deepEqual(back.receipt.vehicles[0], {
    plate: 'ABC1234', make: 'Honda', model: 'Civic', color: 'white',
    ref: '8F3E2A1D', registrationSent: true, vehiclePhotoSent: null, detailsSent: true,
  });
  raw.flow.receipt.email = 'x'.repeat(250) + '@example.com';
  assert.equal(restoreFlow(JSON.stringify(raw), { now: NOW, propertyId: PID }).receipt.email, '', 'longer than an address can be');
  delete raw.flow.receipt.email;
  assert.equal(restoreFlow(JSON.stringify(raw), { now: NOW, propertyId: PID }).receipt.email, '', 'a receipt saved before the email line');
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

test('docRefs lists the slots a request has: the registration card only when required, the vehicle photo always', () => {
  const f = completeFlow();
  assert.deepEqual(Object.keys(docRefs(f, CTX)).sort(), ['id', 'lease', 'plate:v1', 'registration:v1', 'vehicle:v1']);
  assert.deepEqual(Object.keys(docRefs(f, { ...CTX, requireRegistration: false })).sort(), ['id', 'lease', 'plate:v1', 'vehicle:v1']);
  assert.equal(docRefs(f, CTX)['vehicle:v1'], null, 'not added: an empty slot');
  f.vehicles[0].docs.vehicle = ref('vehicle');
  assert.deepEqual(docRefs(f, CTX)['vehicle:v1'], ref('vehicle'));
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

test('docKeyValid knows the vehicle photo kind', () => {
  assert.equal(docKeyValid(key('vehicle'), PID, 'vehicle'), true);
  assert.equal(docKeyValid(key('vehicle'), PID, 'plate'), false);
  assert.equal(docKeyValid(key('plate'), PID, 'vehicle'), false);
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

const extraForbidden = (...fields) => ({
  status: 422,
  detail: fields.map((f) => ({ type: 'extra_forbidden', loc: ['body', f], msg: 'Extra inputs are not permitted', input: key('vehicle') })),
});

test('an older backend refusing registration_doc_url or vehicle_photo_url (422, unknown field) is recognised', () => {
  assert.deepEqual(rejectedUnknownFields(extraForbidden('registration_doc_url')), ['registration_doc_url']);
  assert.deepEqual(rejectedUnknownFields(extraForbidden('vehicle_photo_url')), ['vehicle_photo_url']);
  assert.deepEqual(rejectedUnknownFields(extraForbidden('vehicle_photo_url', 'registration_doc_url')),
    ['registration_doc_url', 'vehicle_photo_url'], 'pydantic names every unknown field in one answer');
  assert.deepEqual(
    rejectedUnknownFields({ status: 422, detail: [{ type: 'value_error.extra', loc: ['body', 'vehicle_photo_url'], msg: 'extra fields not permitted' }] }),
    ['vehicle_photo_url'], 'the older pydantic wording too',
  );
});

test('only those two fields, only as unknown fields, and only the ones this call sent', () => {
  assert.deepEqual(rejectedUnknownFields(extraForbidden('registration_doc_url'), ['vehicle_photo_url']), [],
    'a field this call did not send is not a reason to drop another');
  assert.deepEqual(rejectedUnknownFields(extraForbidden('back_plate')), []);
  assert.deepEqual(rejectedUnknownFields({ status: 422, detail: [{ type: 'value_error', loc: ['body', 'email'], msg: 'bad' }] }), []);
  assert.deepEqual(rejectedUnknownFields({ status: 422, detail: [{ type: 'string_too_long', loc: ['body', 'vehicle_photo_url'], msg: 'too long' }] }), [],
    'a field the backend knows but did not like is not dropped');
  assert.deepEqual(rejectedUnknownFields({ status: 400, detail: 'registration_doc_url' }), []);
  assert.deepEqual(rejectedUnknownFields({ status: 422, detail: 'vehicle_photo_url' }), []);
  assert.deepEqual(rejectedUnknownFields({ status: 422 }), []);
  assert.deepEqual(rejectedUnknownFields(null), []);
});

test('docFields: the registration card when required, the vehicle photo whenever it was added', () => {
  const v = completeFlow().vehicles[0];
  assert.deepEqual(docFields(v, CTX), { registration_doc_url: key('registration', 'pdf') });
  v.docs.vehicle = ref('vehicle');
  assert.deepEqual(docFields(v, CTX), { registration_doc_url: key('registration', 'pdf'), vehicle_photo_url: key('vehicle') });
  assert.deepEqual(docFields(v, { ...CTX, requireRegistration: false }), { vehicle_photo_url: key('vehicle') },
    'a card the property does not ask for is never sent');
  v.docs.registration = null;
  assert.deepEqual(docFields(v, CTX), { vehicle_photo_url: key('vehicle') });
});

test('sentFlags: what went with the request, for the receipt', () => {
  const v = completeFlow().vehicles[0];
  assert.deepEqual(sentFlags(v, CTX), { registrationSent: true, vehiclePhotoSent: null, detailsSent: true }, 'no vehicle photo: nothing to say');
  v.docs.vehicle = ref('vehicle');
  assert.deepEqual(sentFlags(v, CTX), { registrationSent: true, vehiclePhotoSent: true, detailsSent: true });
  assert.deepEqual(sentFlags(v, CTX, ['vehicle_photo_url']), { registrationSent: true, vehiclePhotoSent: false, detailsSent: true });
  assert.deepEqual(sentFlags(v, CTX, ['registration_doc_url']), { registrationSent: false, vehiclePhotoSent: true, detailsSent: true });
  assert.deepEqual(sentFlags(v, { ...CTX, requireRegistration: false }, ['registration_doc_url']).registrationSent, true,
    'not asked for: nothing missing');
  v.docs.registration = null;
  assert.equal(sentFlags(v, CTX).registrationSent, false, 'required but not uploaded (an older backend skipped the card)');
});

test('invalidDocSlots finds the key the backend refused, or all of them when it cannot tell', () => {
  const refs = { id: ref('id'), lease: { ...ref('lease'), key: 'bogus' }, 'plate:v1': ref('plate'), 'registration:v1': ref('registration') };
  assert.deepEqual(invalidDocSlots(refs, PID), ['lease']);
  const allGood = { id: ref('id'), lease: ref('lease') };
  assert.deepEqual(invalidDocSlots(allGood, PID).sort(), ['id', 'lease']);
  assert.deepEqual(invalidDocSlots({ id: null, lease: ref('lease') }, PID), ['lease'], 'an empty slot is not a culprit');
});

test('invalidDocSlots can name the vehicle photo, and skips it when it was never added', () => {
  const refs = { id: ref('id'), lease: ref('lease'), 'plate:v1': ref('plate'), 'vehicle:v1': { ...ref('vehicle'), key: key('plate') } };
  assert.deepEqual(invalidDocSlots(refs, PID), ['vehicle:v1']);
  assert.deepEqual(invalidDocSlots({ ...refs, 'vehicle:v1': null }, PID).sort(), ['id', 'lease', 'plate:v1']);
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

// ── make, model and color (Task F5a) ────────────────────────────────────────
// Rule R8: every parking pass carries the vehicle's make, model and color, so
// the tow team can find a car by description. Required on each vehicle of the
// long-term request (and on the short-term form, which shares these helpers).

const WHITE_CIVIC = { make: 'Honda', model: 'Civic', color: 'white' };
const BRIEF_MAKES = ['Acura', 'Audi', 'BMW', 'Buick', 'Cadillac', 'Chevrolet', 'Chrysler', 'Dodge', 'Ford', 'GMC', 'Honda', 'Hyundai',
  'Infiniti', 'Jaguar', 'Jeep', 'Kia', 'Land Rover', 'Lexus', 'Lincoln', 'Mazda', 'Mercedes-Benz', 'Mini', 'Mitsubishi', 'Nissan',
  'Porsche', 'Ram', 'Subaru', 'Tesla', 'Toyota', 'Volkswagen', 'Volvo'];

test('a new vehicle has an empty make, model and color, and nothing about them sent yet', () => {
  const f = emptyFlow();
  assert.deepEqual([f.vehicles[0].make, f.vehicles[0].model, f.vehicles[0].color], ['', '', '']);
  assert.equal(f.vehicles[0].detailsSent, null);
  const { flow } = addVehicle(f);
  assert.deepEqual([flow.vehicles[1].make, flow.vehicles[1].model, flow.vehicles[1].color], ['', '', '']);
  assert.equal(flow.vehicles[1].detailsSent, null);
});

test('the color list is the spec\'s fourteen, lowercase, each with a Title Case label', () => {
  assert.deepEqual(VEHICLE_COLORS, ['white', 'black', 'gray', 'silver', 'blue', 'red', 'green', 'brown', 'beige', 'gold', 'orange', 'yellow', 'purple', 'other']);
  assert.deepEqual(Object.keys(S.vehicle.colors), VEHICLE_COLORS, 'one label per value, in the same order');
  for (const value of VEHICLE_COLORS) {
    assert.equal(S.vehicle.colors[value], value[0].toUpperCase() + value.slice(1), value);
  }
});

test('the make suggestions: the brief\'s thirty-one and some more, about forty, alphabetical, no repeats', () => {
  for (const make of BRIEF_MAKES) assert.ok(VEHICLE_MAKES.includes(make), `${make} is missing`);
  assert.ok(VEHICLE_MAKES.length >= 38 && VEHICLE_MAKES.length <= 45, `about forty, got ${VEHICLE_MAKES.length}`);
  const lower = VEHICLE_MAKES.map((m) => m.toLowerCase());
  assert.equal(new Set(lower).size, lower.length, 'no repeats');
  assert.deepEqual(lower, [...lower].sort(), 'alphabetical');
  assert.ok(VEHICLE_MAKES.every((m) => m === m.trim() && m.length >= 2 && m.length <= 40));
});

test('validateField: the make, the model and the color are each required, in the brief\'s words', () => {
  assert.equal(validateField('make', ''), 'Add the make.');
  assert.equal(validateField('make', '   '), 'Add the make.');
  assert.equal(validateField('make', undefined), 'Add the make.');
  assert.equal(validateField('make', 'Honda'), null);
  assert.equal(validateField('model', ''), 'Add the model.');
  assert.equal(validateField('model', ' \t '), 'Add the model.');
  assert.equal(validateField('model', 'Civic'), null);
  assert.equal(validateField('color', ''), 'Pick the color.');
  assert.equal(validateField('color', null), 'Pick the color.');
});

test('validateField: a color is one of the list, lowercase — anything else is not a color', () => {
  for (const good of VEHICLE_COLORS) assert.equal(validateField('color', good), null, good);
  for (const bad of ['White', 'WHITE', 'navy', 'tan', 'grey', ' white', 'white ', '  ', 'toString']) {
    assert.equal(validateField('color', bad), 'Pick the color.', JSON.stringify(bad));
  }
});

test('S3: make, model and color come right after the plate and before the documents', () => {
  const f = completeFlow();
  Object.assign(f.vehicles[0], { plate: '', make: '', model: '', color: '' });
  f.vehicles[0].docs = { plate: null, registration: null, vehicle: null };
  assert.deepEqual(validateStep('vehicle:v1', f, CTX), [
    { field: 'plate-v1', message: 'Enter the license plate' },
    { field: 'make-v1', message: 'Add the make.' },
    { field: 'model-v1', message: 'Add the model.' },
    { field: 'color-v1', message: 'Pick the color.' },
    { field: 'card-plate-v1', message: 'Add a photo of the plate' },
    { field: 'card-registration-v1', message: 'Add your vehicle registration card' },
  ]);
});

test('S3: each of the three is its own error, whether or not the property asks for the registration card', () => {
  const cases = [['make', 'make-v1', 'Add the make.'], ['model', 'model-v1', 'Add the model.'], ['color', 'color-v1', 'Pick the color.']];
  for (const [name, id, message] of cases) {
    for (const ctx of [CTX, { ...CTX, requireRegistration: false }]) {
      const f = completeFlow();
      f.vehicles[0][name] = '  ';
      assert.deepEqual(validateStep('vehicle:v1', f, ctx), [{ field: id, message }], `${name} / ${ctx.requireRegistration}`);
    }
  }
  assert.deepEqual(validateStep('vehicle:v1', completeFlow(), CTX), [], 'all three given: nothing to fix');
});

test('S3: every vehicle needs its own make, model and color', () => {
  let f = completeFlow();
  ({ flow: f } = addVehicle(f));
  f.vehicles[1].plate = 'XYZ 789';
  f.vehicles[1].docs = { plate: ref('plate'), registration: ref('registration'), vehicle: null };
  assert.deepEqual(validateStep('vehicle:v2', f, CTX).map((e) => e.field), ['make-v2', 'model-v2', 'color-v2']);
  assert.deepEqual(validateStep('vehicle:v1', f, CTX), [], 'the first one is complete');
  assert.deepEqual(validateStep('vehicles', f, CTX), [{ field: 'row-v2', message: 'Finish XYZ789, or remove it' }]);
});

test('S3b and S5 hold back a vehicle that has none of them: not finished, and named in the error summary', () => {
  const f = completeFlow();
  f.vehicles[0].make = '';
  f.vehicles[0].color = '';
  assert.deepEqual(validateStep('vehicles', f, CTX), [{ field: 'row-v1', message: 'Finish ABC1234, or remove it' }]);
  assert.deepEqual(validateStep('review', f, CTX), [
    { field: 'review-vehicle-v1', message: 'Add the make.' },
    { field: 'review-vehicle-v1', message: 'Pick the color.' },
  ]);
  assert.deepEqual(validateStep('review', completeFlow(), CTX), []);
});

test('a vehicle already sent is locked: it is not asked again for what it went without', () => {
  const f = completeFlow();
  Object.assign(f.vehicles[0], { ref: '8F3E2A1D', make: '', model: '', color: '' });
  assert.deepEqual(validateStep('vehicle:v1', f, CTX), []);
  assert.deepEqual(validateStep('review', f, CTX), []);
});

test('vehicleFieldErrors: the three checks on their own (the short-term form uses them), in page order', () => {
  assert.deepEqual(vehicleFieldErrors({ make: '', model: '', color: '' }), [
    { field: 'make', message: 'Add the make.' },
    { field: 'model', message: 'Add the model.' },
    { field: 'color', message: 'Pick the color.' },
  ]);
  assert.deepEqual(vehicleFieldErrors({ make: 'Ford', model: ' ', color: 'blue' }), [{ field: 'model', message: 'Add the model.' }]);
  assert.deepEqual(vehicleFieldErrors(WHITE_CIVIC), []);
  assert.deepEqual(vehicleFieldErrors({}).map((e) => e.field), ['make', 'model', 'color']);
});

test('make and model are trimmed and single-spaced; nothing else about them is changed', () => {
  assert.equal(normalizeVehicleText('  Land   Rover \t'), 'Land Rover');
  assert.equal(normalizeVehicleText('f-150'), 'f-150', 'the case is as typed');
  assert.equal(normalizeVehicleText('Mercedes-Benz'), 'Mercedes-Benz');
  assert.equal(normalizeVehicleText(undefined), '');
  assert.equal(normalizeVehicleText(null), '');
  assert.equal(normalizeVehicleText(42), '');
});

test('the vehicle is described as <color> <Make> <Model>: the color lowercase, the rest as typed', () => {
  assert.equal(vehicleDescription(WHITE_CIVIC), 'white Honda Civic');
  assert.equal(vehicleDescription({ make: 'honda', model: 'civic', color: 'WHITE' }), 'white honda civic', 'only the color is changed');
  assert.equal(vehicleDescription({ make: ' Land  Rover ', model: 'Range Rover Sport', color: 'silver' }), 'silver Land Rover Range Rover Sport');
  assert.equal(vehicleDescription({ make: 'Ford', model: 'F-150', color: 'other' }), 'other Ford F-150');
  assert.equal(vehicleDescription({ make: '', model: '', color: '' }), '');
  assert.equal(vehicleDescription({ make: 'Honda', model: '', color: '' }), 'Honda', 'whatever is there, nothing invented');
  assert.equal(vehicleDescription({}), '');
});

/**
 * The text of the line the page draws for a vehicle: the description, the dot and the plate are
 * three spans in a row, so it reads as their texts one after another.
 */
const lineText = (v, plate) => {
  const parts = vehicleLineParts(v, plate);
  return `${parts.description}${parts.separator}${parts.plate}`;
};

test('the line on S3b, S5 and S6 is "<description> · <plate>": three parts, the dot only between two', () => {
  assert.deepEqual(vehicleLineParts({ ...WHITE_CIVIC, plate: 'abc 1234' }),
    { description: 'white Honda Civic', separator: ' · ', plate: 'ABC1234' });
  assert.equal(lineText({ ...WHITE_CIVIC, plate: 'ABC1234', ref: '8F3E2A1D' }), 'white Honda Civic · ABC1234', 'a saved receipt line reads the same');
  assert.deepEqual(vehicleLineParts({ plate: 'ABC1234' }), { description: '', separator: '', plate: 'ABC1234' },
    'a vehicle with no description is its plate');
  assert.deepEqual(vehicleLineParts({ ...WHITE_CIVIC, plate: '' }), { description: 'white Honda Civic', separator: '', plate: '' });
  assert.deepEqual(vehicleLineParts({}), { description: '', separator: '', plate: '' });
});

test('the page names a vehicle with no plate yet "Vehicle 2": the line takes the name it is given', () => {
  assert.deepEqual(vehicleLineParts(WHITE_CIVIC, 'Vehicle 2'), { description: 'white Honda Civic', separator: ' · ', plate: 'Vehicle 2' });
  assert.deepEqual(vehicleLineParts({}, 'Vehicle 2'), { description: '', separator: '', plate: 'Vehicle 2' });
});

test('vehicleFields: the three request fields — make and model trimmed, the color as chosen', () => {
  assert.deepEqual(vehicleFields({ make: ' Honda ', model: 'Civic  EX', color: 'white' }),
    { vehicle_make: 'Honda', vehicle_model: 'Civic EX', vehicle_color: 'white' });
  assert.deepEqual(vehicleFields(completeFlow().vehicles[0]), { vehicle_make: 'Honda', vehicle_model: 'Civic', vehicle_color: 'white' });
});

test('make, model and color are saved with the vehicle and come back with it', () => {
  const f = completeFlow();
  f.step = 'vehicles';
  const raw = serializeFlow(f, { now: NOW, propertyId: PID });
  const saved = JSON.parse(raw).flow.vehicles[0];
  assert.deepEqual([saved.make, saved.model, saved.color], ['Honda', 'Civic', 'white']);
  const back = restoreFlow(raw, { now: NOW + 1000, propertyId: PID });
  assert.deepEqual([back.vehicles[0].make, back.vehicles[0].model, back.vehicles[0].color], ['Honda', 'Civic', 'white']);
  assert.deepEqual(back, f);
});

test('restore cleans them: 40 characters at most, a color from the list, anything else empty', () => {
  const raw = JSON.parse(serializeFlow(completeFlow(), { now: NOW, propertyId: PID }));
  const restore = () => restoreFlow(JSON.stringify(raw), { now: NOW, propertyId: PID }).vehicles[0];
  Object.assign(raw.flow.vehicles[0], { make: 'M'.repeat(100), model: ['Civic'], color: 'plaid' });
  const v = restore();
  assert.equal(v.make.length, 40);
  assert.equal(v.model, '');
  assert.equal(v.color, '');
  raw.flow.vehicles[0].color = 'WHITE';
  assert.equal(restore().color, '', 'the values are lowercase');
  raw.flow.vehicles[0].color = 'silver';
  assert.equal(restore().color, 'silver');
});

test('a request saved before these fields existed restores with them empty — and asks for them', () => {
  const raw = JSON.parse(serializeFlow(completeFlow(), { now: NOW, propertyId: PID }));
  for (const name of ['make', 'model', 'color', 'detailsSent']) delete raw.flow.vehicles[0][name];
  const back = restoreFlow(JSON.stringify(raw), { now: NOW, propertyId: PID });
  assert.deepEqual([back.vehicles[0].make, back.vehicles[0].model, back.vehicles[0].color], ['', '', '']);
  assert.equal(back.vehicles[0].detailsSent, null);
  assert.deepEqual(validateStep('review', back, CTX).map((e) => e.message), ['Add the make.', 'Add the model.', 'Pick the color.']);
});

test('a vehicle already sent keeps whether its make, model and color went with it', () => {
  const f = completeFlow();
  Object.assign(f.vehicles[0], { ref: '8F3E2A1D', detailsSent: false });
  const back = restoreFlow(serializeFlow(f, { now: NOW, propertyId: PID }), { now: NOW, propertyId: PID });
  assert.equal(back.vehicles[0].detailsSent, false);
  const raw = JSON.parse(serializeFlow(f, { now: NOW, propertyId: PID }));
  raw.flow.vehicles[0].detailsSent = 'yes';
  assert.equal(restoreFlow(JSON.stringify(raw), { now: NOW, propertyId: PID }).vehicles[0].detailsSent, null);
});

test('the receipt keeps each vehicle\'s make, model and color, so a reload still shows its line', () => {
  const f = completeFlow();
  f.vehicles[0].make = ' Honda ';
  f.vehicles.push({ ...f.vehicles[0], vid: 'v2', plate: 'XYZ 789', make: 'Ford', model: 'F-150', color: 'blue' });
  const sent = receiptFlow(f, { now: NOW, refs: { v1: '8F3E2A1D', v2: '1A2B3C4D' }, registrationSent: { v1: true, v2: true } });
  assert.deepEqual(sent.receipt.vehicles.map((v) => [v.plate, v.make, v.model, v.color]), [
    ['ABC1234', 'Honda', 'Civic', 'white'],
    ['XYZ789', 'Ford', 'F-150', 'blue'],
  ]);
  const back = restoreFlow(serializeFlow(sent, { now: NOW, propertyId: PID }), { now: NOW + 60_000, propertyId: PID });
  assert.deepEqual(back.receipt, sent.receipt);
  assert.deepEqual(back.receipt.vehicles.map((v) => lineText(v)), ['white Honda Civic · ABC1234', 'blue Ford F-150 · XYZ789']);
});

test('a vehicle sent without them (an older backend) says so on the receipt, and keeps saying so after a reload', () => {
  const sent = receiptFlow(completeFlow(), { now: NOW, refs: { v1: '8F3E2A1D' }, registrationSent: { v1: true }, detailsSent: { v1: false } });
  assert.equal(sent.receipt.vehicles[0].detailsSent, false);
  const back = restoreFlow(serializeFlow(sent, { now: NOW, propertyId: PID }), { now: NOW, propertyId: PID });
  assert.equal(back.receipt.vehicles[0].detailsSent, false);
  assert.equal(receiptFlow(completeFlow(), { now: NOW, refs: { v1: '8F3E2A1D' }, registrationSent: { v1: true } }).receipt.vehicles[0].detailsSent, true,
    'nothing said means they went');
});

test('the saved receipt cleans them: text capped, a color outside the list dropped; one saved before has none', () => {
  const sent = receiptFlow(completeFlow(), { now: NOW, refs: { v1: '8F3E2A1D' }, registrationSent: { v1: true } });
  const raw = JSON.parse(serializeFlow(sent, { now: NOW, propertyId: PID }));
  const restoreReceipt = () => restoreFlow(JSON.stringify(raw), { now: NOW, propertyId: PID }).receipt.vehicles[0];
  Object.assign(raw.flow.receipt.vehicles[0], { make: 'M'.repeat(90), model: { x: 1 }, color: 'plaid', detailsSent: 'maybe' });
  const v = restoreReceipt();
  assert.equal(v.make.length, 40);
  assert.equal(v.model, '');
  assert.equal(v.color, '');
  assert.equal(v.detailsSent, true, 'only an explicit false is a warning');
  for (const name of ['make', 'model', 'color', 'detailsSent']) delete raw.flow.receipt.vehicles[0][name];
  const old = restoreReceipt();
  assert.deepEqual([old.make, old.model, old.color, old.detailsSent], ['', '', '', true]);
  assert.equal(lineText(old), 'ABC1234', 'a receipt saved before shows the plate alone');
});

test('vehicle_required asks for all three in the brief\'s words and points at the first one missing', () => {
  const err = (...missing) => ({ status: 400, detail: 'vehicle_required', body: { detail: 'vehicle_required', missing } });
  const m = registerErrorMessage(err('vehicle_make', 'vehicle_model', 'vehicle_color'), ERR_CTX);
  assert.deepEqual({ code: m.code, message: m.message, field: m.field },
    { code: 'vehicle_required', message: 'Add the make, model and color of the vehicle.', field: 'make-v1' });
  assert.equal(registerErrorMessage(err('vehicle_color', 'vehicle_model'), ERR_CTX).field, 'model-v1', 'the page\'s order, not the backend\'s');
  assert.equal(registerErrorMessage(err('vehicle_color'), ERR_CTX).field, 'color-v1');
  assert.equal(registerErrorMessage(err('vehicle_make'), { ...ERR_CTX, vid: 'v3' }).field, 'make-v3', 'the vehicle it was about');
  assert.equal(registerErrorMessage(err('vehicle_make'), { ...ERR_CTX, vid: null }).field, null);
  assert.equal(registerErrorMessage({ status: 400, detail: 'vehicle_required' }, ERR_CTX).field, 'make-v1', 'no list: the first field');
  assert.equal(registerErrorMessage(err('something_else'), ERR_CTX).field, 'make-v1', 'a list with nothing we know: the first field');
});

test('vehicle_color_invalid sends the person back to the list', () => {
  const m = registerErrorMessage({ status: 400, detail: 'vehicle_color_invalid', body: { detail: 'vehicle_color_invalid' } }, ERR_CTX);
  assert.deepEqual({ code: m.code, message: m.message, field: m.field },
    { code: 'vehicle_color_invalid', message: 'Pick the color from the list.', field: 'color-v1' });
  assert.equal(registerErrorMessage({ status: 400, detail: 'vehicle_color_invalid' }, { ...ERR_CTX, vid: 'v2' }).field, 'color-v2');
});

test('vehicleBackendError: the same two answers for the short-term form, which names its own fields; nothing else', () => {
  const required = vehicleBackendError({ status: 400, detail: 'vehicle_required', body: { missing: ['vehicle_color', 'vehicle_model'] } });
  assert.deepEqual(required, { code: 'vehicle_required', message: 'Add the make, model and color of the vehicle.', field: 'model' });
  assert.deepEqual(vehicleBackendError({ status: 400, detail: 'vehicle_color_invalid' }),
    { code: 'vehicle_color_invalid', message: 'Pick the color from the list.', field: 'color' });
  assert.equal(vehicleBackendError({ status: 400, detail: 'vehicle_required' }).field, 'make');
  for (const other of [{ status: 400, detail: 'unit_required' }, { status: 500, detail: 'registration_failed' }, { status: 422, detail: [] }, {}, null, undefined]) {
    assert.equal(vehicleBackendError(other), null, JSON.stringify(other));
  }
});

test('an older backend refusing the make, model and color (422, unknown fields) is recognised like the two document fields', () => {
  const all = ['registration_doc_url', 'vehicle_photo_url', 'vehicle_make', 'vehicle_model', 'vehicle_color'];
  assert.deepEqual(rejectedUnknownFields(extraForbidden('vehicle_make', 'vehicle_model', 'vehicle_color')), ['vehicle_make', 'vehicle_model', 'vehicle_color']);
  assert.deepEqual(rejectedUnknownFields(extraForbidden('vehicle_color', 'vehicle_photo_url', 'vehicle_model', 'registration_doc_url', 'vehicle_make')), all,
    'every unknown field in one answer, in one fixed order');
  assert.deepEqual(rejectedUnknownFields(extraForbidden('vehicle_color')), ['vehicle_color'], 'one at a time is fine too');
  assert.deepEqual(rejectedUnknownFields(extraForbidden('vehicle_make', 'vehicle_model'), ['vehicle_make']), ['vehicle_make'],
    'only the fields this call sent');
  assert.deepEqual(rejectedUnknownFields(extraForbidden('vehicle_make'), ['vehicle_photo_url']), []);
  assert.deepEqual(
    rejectedUnknownFields({ status: 422, detail: [{ type: 'string_too_long', loc: ['body', 'vehicle_make'], msg: 'too long' }] }), [],
    'a make the backend knows but did not like is not dropped (the form holds it to 40 characters)',
  );
  assert.deepEqual(
    rejectedUnknownFields({ status: 422, detail: [{ type: 'value_error.extra', loc: ['body', 'vehicle_color'], msg: 'extra fields not permitted' }] }),
    ['vehicle_color'], 'the older pydantic wording too',
  );
});

test('sentFlags: the make, model and color went unless the retry left one out', () => {
  const v = completeFlow().vehicles[0];
  assert.equal(sentFlags(v, CTX).detailsSent, true);
  assert.equal(sentFlags(v, CTX, ['vehicle_photo_url', 'registration_doc_url']).detailsSent, true, 'the document fields are another matter');
  for (const field of ['vehicle_make', 'vehicle_model', 'vehicle_color']) {
    assert.equal(sentFlags(v, CTX, [field]).detailsSent, false, field);
  }
  assert.deepEqual(sentFlags(v, CTX, ['vehicle_make', 'vehicle_model', 'vehicle_color', 'vehicle_photo_url']),
    { registrationSent: true, vehiclePhotoSent: null, detailsSent: false });
});

test('the make, model and color copy is the brief\'s, verbatim', () => {
  assert.deepEqual([S.vehicle.makeLabel, S.vehicle.modelLabel, S.vehicle.colorLabel], ['Make', 'Model', 'Color']);
  assert.equal(S.vehicle.colorPlaceholder, 'Choose a color');
  assert.equal(S.vehicle.errorMake, 'Add the make.');
  assert.equal(S.vehicle.errorModel, 'Add the model.');
  assert.equal(S.vehicle.errorColor, 'Pick the color.');
  assert.equal(S.errors.vehicleRequired, 'Add the make, model and color of the vehicle.');
  assert.equal(S.errors.vehicleColorInvalid, 'Pick the color from the list.');
  assert.equal(S.received.vehicle, 'Vehicle');
  assert.equal(S.received.vehicleDetailsNotSent, 'Sent without the make, model and color — the office may ask for them.');
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

test('S6 says where the emailed copy went, verbatim, and still asks to save the page', () => {
  assert.equal(S.received.emailed('jane@example.com'),
    "We emailed a copy of this receipt to jane@example.com from dispatch@lotlogicparking.com. Check your spam folder if you don't see it.");
  assert.match(S.received.keep, /^Save or screenshot this page\./);
  assert.equal(S.about.emailHint, "We'll email your receipt here.");
});

test('the vehicle photo card says what to take and why, and that it is optional', () => {
  assert.equal(S.vehicle.vehiclePhotoTitle, 'Photo of the vehicle');
  assert.equal(S.card.optional, '(optional)');
  assert.equal(S.vehicle.vehiclePhotoNote, 'The whole car with the plate visible. It helps the office and the tow team recognize your car.');
  assert.equal(S.vehicle.vehiclePhotoSize, 'Photo, up to 10 MB.');
  assert.equal(S.received.vehiclePhotoNotSent, "Sent without the photo of the vehicle. It's optional, so nothing else is needed.");
});

test('the attestation is a statement, with the unit in it', () => {
  assert.equal(S.review.attest('214'),
    "By sending this request you confirm you're named on the lease for Unit 214 and these vehicles are registered to you.");
});

// ── the office phone (Gabe, 2026-10-15 ~03:30 ET: "They don't need a phone number on it") ──
//
// The receipt, the landing, the "No, I'm not on the lease" branch and the short-term
// confirmation do not print the office's number, or a button that dials it. The one place it
// stays is the sentence for a page a content blocker is holding back ("… or call (704) 555-0100"),
// which the person has no other way past. tests/e2e/apt-flow.spec.ts shows it in a browser
// against a property that has a phone; these run on every push, whether or not the portal suite does.

test('no string under received, landing or start offers the office phone', () => {
  assert.equal('call' in S.received, false, "the receipt's \"Call <phone>\" button");
  assert.equal('contactHeading' in S.received, false, "the receipt's \"Questions? Call the office.\"");
  assert.equal('questions' in S.landing, false, "the landing's \"Questions? Call\"");
  assert.equal('gateNoPhone' in S.start, false, "the \"No\" branch's \"Ask the office…: <phone>\"");
});

test('the only string in the flow that tells anyone to call is the content-blocker sentence', () => {
  const calling = allStrings(S).filter(([, s]) => /\bcall\b/i.test(s)).map(([path]) => path);
  assert.deepEqual(calling, ['STRINGS.en.errors.blocked()']);
});

test('the "No, I\'m not on the lease" branch points at the office in words, not a number', () => {
  assert.equal(S.start.gateNoAsk, 'Ask the office about adding you to the lease.');
});

test('apt.js offers the office phone in one place only: the content-blocker panel', () => {
  const source = readFileSync(new URL('../src/apt.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  // What may mention the number: the query that loads it, the helpers that format it, the panel
  // that offers it, and the context that lets S5's summary say the same sentence for the same condition.
  const allowed = [
    /^function showBlocked\(\) \{[\s\S]*?^\}/m,
    /^const officePhone = .*$/m,
    /^const officeTel = \(\) => \{[\s\S]*?^\};/m,
    /^const telLink = .*$/m,
    /^const BASE_COLUMNS = .*$/m,
    /phone: officePhone\(\) \}/,
  ];
  let rest = source;
  for (const re of allowed) {
    assert.match(rest, re, `apt.js no longer holds ${re}; update this guard with it`);
    rest = rest.replace(re, '');
  }
  const offered = rest.split('\n')
    .filter((line) => /officePhone|officeTel|telLink|policy_phone|tel:|ICONS\.phone|\.call\(|Questions\? Call/.test(line))
    .map((line) => line.trim());
  assert.deepEqual(offered, [], 'the office phone is offered somewhere other than the content-blocker panel');
});
