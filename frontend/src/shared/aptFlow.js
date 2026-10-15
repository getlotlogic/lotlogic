// ── The long-term parking-pass request: the flow's pure model ──────────────
// Task F3. /apt/<qr>?role=resident is a short stepped form:
//   S1 start      Before you start — the rules once, what to have ready, and
//                 "Is your name on the lease?" (No → the short-term pass)
//   S2 about      About you — name, unit, mobile, email
//   S3 vehicle:vN Vehicle n — plate, make, model and color, plate photo,
//                 registration card, and an optional photo of the vehicle
//   S3b vehicles  Your vehicles — the list, "another?" until the unit's cap
//   S4 documents  Your ID and lease
//   S5 review     Check your answers — then "Send for review"
//   S6 received   Request received — the receipt, one reference per vehicle
//
// This module is the model only: every user-facing string (STRINGS.en, so a
// translation is a data change), the step router, validation, the
// localStorage persistence reducer (24 h TTL, answers and upload keys, never
// file bytes) and the backend error → plain-language map. No DOM, no network:
// apt.js draws the screens and Node tests import this file directly.
import { normalizePlate, REGION_TOKENS } from './plate.js';
import { initialCardState, isSatisfied, isBusy, cardStatusText } from './docCard.js';

export const TTL_MS = 24 * 60 * 60 * 1000;
export const STEP_COUNT = 5;
const FLOW_VERSION = 1;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX = { name: 80, unit: 20, phone: 40, email: 254, plate: 10, docName: 120, docType: 60, vehicleText: 40 };

const plural = (n, one, many) => (Number(n) === 1 ? one : many);

// ── the vehicle's make, model and color (Task F5a, rule R8) ─────────────────
// Every parking pass carries them, so the tow team can find a car by
// description. The color is one of a fixed list, stored lowercase (the
// backend's `services/vehicles.COLORS`); the make and model are free text,
// 1–40 characters each. The names below are the page's; the request fields
// are `vehicle_make`, `vehicle_model` and `vehicle_color`.
export const VEHICLE_FIELDS = ['make', 'model', 'color'];
const VEHICLE_REQUEST_FIELD = { make: 'vehicle_make', model: 'vehicle_model', color: 'vehicle_color' };

export const VEHICLE_COLORS = [
  'white', 'black', 'gray', 'silver', 'blue', 'red', 'green', 'brown', 'beige', 'gold', 'orange', 'yellow', 'purple', 'other',
];

// The <datalist> behind the Make field: suggestions, not a limit (the field is free text).
export const VEHICLE_MAKES = [
  'Acura', 'Alfa Romeo', 'Audi', 'BMW', 'Buick', 'Cadillac', 'Chevrolet', 'Chrysler', 'Dodge', 'Fiat', 'Ford', 'Genesis', 'GMC',
  'Honda', 'Hyundai', 'Infiniti', 'Jaguar', 'Jeep', 'Kia', 'Land Rover', 'Lexus', 'Lincoln', 'Maserati', 'Mazda', 'Mercedes-Benz',
  'Mercury', 'Mini', 'Mitsubishi', 'Nissan', 'Pontiac', 'Porsche', 'Ram', 'Rivian', 'Saturn', 'Scion', 'Subaru', 'Suzuki', 'Tesla',
  'Toyota', 'Volkswagen', 'Volvo',
];

// ── every string a resident can see ─────────────────────────────────────────
// Sentence case, second person, "parking pass" (long-term / short-term) as the
// only pass noun. scripts/aptFlow.test.mjs walks this object for the banned
// pass words and for shouted capitals.
export const STRINGS = {
  en: {
    back: 'Back',
    continue: 'Continue',
    stepOf: (n, total) => `Step ${n} of ${total}`,
    vehicleOf: (i, cap) => (cap ? `Vehicle ${i} of ${cap}` : `Vehicle ${i}`),
    errorSummaryTitle: 'There is a problem',
    errorPrefix: 'Error:',
    titleErrorPrefix: 'Error: ',
    titleSuffix: 'Parking registration',
    finishing: 'Finishing upload…',

    landing: {
      eyebrow: 'Parking registration',
      liveTitle: 'I live here',
      liveSub: 'Register a car for a long-term parking pass',
      visitTitle: "I'm visiting",
      visitSub: 'Get a short-term parking pass, up to 72 hours',
    },

    start: {
      title: 'Before you start',
      rulesHeading: 'The rules',
      ruleLeaseholders: 'Only leaseholders can hold a long-term parking pass.',
      ruleCap: (cap) => (Number(cap) === 1
        ? 'Each unit can register 1 vehicle.'
        : `Each unit can register up to ${cap} vehicles.`),
      ruleReview: 'The office reviews every request. Your car is protected from towing while the office reviews your request (up to 72 hours).',
      needHeading: 'You will need',
      needPlate: 'Your license plate (and a photo of it)',
      needRegistration: 'Vehicle registration card for each car, in your name',
      needId: 'Photo ID',
      needLease: 'A copy or photo of your lease',
      needFiles: 'Photos or PDFs, up to 10 MB each.',
      time: 'About 5 minutes. If you stop, your answers stay on this phone for 24 hours.',
      gateLegend: 'Is your name on the lease for this unit?',
      gateYes: "Yes, I'm on the lease",
      gateNo: "No, I'm not on the lease",
      gateNoExplain: "Only the person on the lease can hold a long-term parking pass. If you're staying with someone, get a short-term parking pass instead (up to 72 hours).",
      gateNoAsk: 'Ask the office about adding you to the lease.',
      startButton: 'Start',
      shortTermButton: 'Get a short-term parking pass',
      errorGate: 'Select whether your name is on the lease',
    },

    about: {
      title: 'About you',
      nameLabel: 'Full name',
      nameHint: 'Exactly as it appears on your lease.',
      unitLabel: 'Unit number',
      unitHint: 'For example 214 or 12B.',
      phoneLabel: 'Mobile phone',
      phoneHint: 'Only used if the office has a question about this request.',
      emailLabel: 'Email',
      emailHint: "We'll email your receipt here.",
      errorName: 'Enter your full name',
      errorUnit: 'Enter your unit number',
      errorPhone: 'Enter a phone number, like (704) 555-0123',
      errorEmailEmpty: 'Enter your email address',
      errorEmail: 'Enter an email address in the correct format, like name@example.com',
    },

    vehicle: {
      title: (n) => `Vehicle ${n}`,
      plateLabel: 'License plate',
      plateHint: 'Type it exactly as it appears on the plate, not on the registration. Letters and numbers only.',
      makeLabel: 'Make',
      modelLabel: 'Model',
      colorLabel: 'Color',
      colorPlaceholder: 'Choose a color',
      colors: {
        white: 'White', black: 'Black', gray: 'Gray', silver: 'Silver', blue: 'Blue', red: 'Red', green: 'Green',
        brown: 'Brown', beige: 'Beige', gold: 'Gold', orange: 'Orange', yellow: 'Yellow', purple: 'Purple', other: 'Other',
      },
      removeVehicle: 'Remove this vehicle',
      removeConfirm: (plate) => (plate
        ? `Remove ${plate}? Its photos will be removed from this request.`
        : 'Remove this vehicle? Its photos will be removed from this request.'),
      removeYes: 'Remove vehicle',
      removeNo: 'Keep vehicle',
      platePhotoTitle: 'Photo of the plate',
      platePhotoTip: 'Take it from a few feet back so the whole plate is readable.',
      platePhotoSize: 'Photo, up to 10 MB.',
      plateQuestion: (plate) => `Does this photo show ${plate}?`,
      registrationTitle: 'Vehicle registration card',
      registrationNote: 'The DMV registration card, not the insurance card.',
      registrationChecks: ['Your name is on it', 'The plate number is on it', 'All four corners are visible, no glare'],
      registrationSize: 'Photo or PDF, up to 10 MB.',
      vehiclePhotoTitle: 'Photo of the vehicle',
      vehiclePhotoNote: 'The whole car with the plate visible. It helps the office and the tow team recognize your car.',
      vehiclePhotoSize: 'Photo, up to 10 MB.',
      errorPlate: 'Enter the license plate',
      errorPlateChars: 'Enter letters and numbers only',
      errorMake: 'Add the make.',
      errorModel: 'Add the model.',
      errorColor: 'Pick the color.',
      errorPlatePhoto: 'Add a photo of the plate',
      errorRegistration: 'Add your vehicle registration card',
      errorDuplicate: (plate) => `You've already added ${plate} to this request`,
    },

    vehicles: {
      title: 'Your vehicles',
      unnamed: (n) => `Vehicle ${n}`,
      rowDone: 'Photo and registration card added',
      rowDonePhotoOnly: 'Photo added',
      rowDoneVehiclePhoto: 'Plate photo, registration card and vehicle photo added',
      rowDonePhotosOnly: 'Plate and vehicle photos added',
      rowIncomplete: 'Not finished',
      rowSent: (ref) => `Sent · ref ${ref}`,
      change: 'Change',
      remove: 'Remove',
      hiddenVehicle: (plate) => ` vehicle ${plate}`,
      anotherLegend: 'Do you have another vehicle to register?',
      yes: 'Yes',
      no: 'No',
      capReached: (cap) => `This unit's limit is ${cap} ${plural(cap, 'vehicle', 'vehicles')}. To change a vehicle later, contact the office.`,
      none: 'Add at least one vehicle',
      addVehicle: 'Add a vehicle',
      errorAnother: 'Select whether you have another vehicle to register',
      errorIncomplete: (name) => `Finish ${name}, or remove it`,
    },

    documents: {
      title: 'Your ID and lease',
      intro: "The property office and its parking enforcement company use these documents to confirm you're on the lease for this unit and that the cars are yours.",
      idTitle: 'Photo ID',
      idChecks: ['Government-issued, not expired', 'Name matches your lease', 'All four corners visible, no glare'],
      leaseTitle: 'Lease',
      leaseChecks: ['Shows your name and the unit number', 'The signature page or the first page is enough', 'You can cover rent amounts'],
      size: 'Photo or PDF, up to 10 MB.',
      privacy: 'How we store documents:',
      privacyLink: 'Privacy policy',
      errorId: 'Add a photo of your ID',
      errorLease: 'Add your lease',
    },

    card: {
      takePhoto: 'Take photo',
      choose: 'Choose from photos or files',
      chooseFine: 'Choose a file',
      chooseOther: 'Choose a different file',
      retake: 'Retake',
      remove: 'Remove',
      retry: 'Try again',
      optional: '(optional)',
      preparing: 'Preparing photo…',
      preparingFile: 'Preparing file…',
      uploading: (size, pct) => `Uploading ${size} – ${pct}%`,
      uploadingAnnounce: (size) => `Uploading ${size}`,
      uploaded: 'Uploaded',
      uploadedEarlier: 'Uploaded earlier',
      paused: "Upload paused. It will start again when you're back online.",
      skipped: "This card can't be sent yet. Your request will go without it — the office may ask for it.",
      pdf: 'PDF',
      errorPrefix: 'Error:',
      errors: {
        wrongType: 'The selected file must be a JPG, PNG, WEBP or PDF',
        wrongTypeImages: 'The selected file must be a JPG, PNG or WEBP',
        tooLarge: 'The selected file must be smaller than 10 MB',
        heic: "We can't open this photo format (HEIC). Choose a JPG or PNG.",
        unreadable: "We can't open this file. Choose a JPG or PNG.",
        uploadFailed: 'The selected file could not be uploaded – try again',
        recaptcha: 'The automated-access check failed – try again',
      },
    },

    review: {
      title: 'Check your answers',
      aboutHeading: 'About you',
      vehiclesHeading: 'Vehicles',
      documentsHeading: 'Documents',
      name: 'Name',
      unit: 'Unit',
      phone: 'Mobile phone',
      email: 'Email',
      id: 'Photo ID',
      lease: 'Lease',
      change: 'Change',
      hidden: {
        name: ' name',
        unit: ' unit number',
        phone: ' mobile phone',
        email: ' email',
        id: ' photo ID',
        lease: ' lease',
        vehicle: (plate) => ` vehicle ${plate}`,
      },
      notAdded: 'Not added',
      uploaded: 'Uploaded',
      uploadedEarlier: 'Uploaded earlier',
      statement: "Your request isn't sent until you press Send for review.",
      attest: (unit) => `By sending this request you confirm you're named on the lease for Unit ${unit} and these vehicles are registered to you.`,
      send: 'Send for review',
      sending: 'Sending…',
      tryAgain: 'Try again',
    },

    errors: {
      unitLimit: (unit, limit) => `Unit ${unit} already has ${limit} ${plural(limit, 'vehicle', 'vehicles')} registered or waiting for approval. Ask the office if one should be removed.`,
      unitLimitUnknown: (unit) => `Unit ${unit} already has the most vehicles allowed registered or waiting for approval. Ask the office if one should be removed.`,
      registrationRequired: 'Add your vehicle registration card.',
      vehicleRequired: 'Add the make, model and color of the vehicle.',
      vehicleColorInvalid: 'Pick the color from the list.',
      duplicate: (plate) => `${plate} already has an approved parking pass at this property.`,
      expiredUpload: 'One of your uploads expired — add it again.',
      recaptcha: 'The automated-access check failed – try again.',
      blocked: (phone) => (phone
        ? `Something is blocking this page from sending. Turn off content blockers for this site, or call ${phone}.`
        : 'Something is blocking this page from sending. Turn off content blockers for this site, then try again.'),
      network: "We couldn't reach the office's system. Your answers are saved on this phone — try again.",
      unitRequired: 'Enter your unit number',
      email: 'Enter an email address in the correct format, like name@example.com',
      generic: 'Something went wrong sending your request. Your answers are saved on this phone — try again.',
      notSent: (plate) => `${plate} wasn't sent.`,
    },

    received: {
      title: 'Request received',
      vehicle: 'Vehicle',
      reference: 'Reference',
      status: 'Pending approval',
      protected: 'Protected from towing while the office reviews your request (up to 72 hours).',
      registrationNotSent: 'Sent without registration — the office may ask for it.',
      vehiclePhotoNotSent: "Sent without the photo of the vehicle. It's optional, so nothing else is needed.",
      vehicleDetailsNotSent: 'Sent without the make, model and color — the office may ask for them.',
      submitted: (when) => `Sent ${when}`,
      nextHeading: 'What happens next',
      next: [
        'The office reviews your documents, usually within 72 hours.',
        "Once approved, your plate is your pass. There's nothing to display in your car.",
      ],
      emailed: (email) => `We emailed a copy of this receipt to ${email} from dispatch@lotlogicparking.com. Check your spam folder if you don't see it.`,
      keep: 'Save or screenshot this page. The reference is what the office and the tow company will ask for.',
      copy: (count) => (Number(count) > 1 ? 'Copy references' : 'Copy reference'),
      copied: (count) => (Number(count) > 1 ? 'References copied' : 'Reference copied'),
      shortTerm: 'Get a short-term parking pass for someone visiting',
      startOver: 'Start a new request',
    },
  },
};

const S = STRINGS.en;

// ── flow state ──────────────────────────────────────────────────────────────

const newVehicle = (vid) => ({
  vid,
  plate: '',
  make: '',
  model: '',
  color: '',          // one of VEHICLE_COLORS, or ''
  docs: { plate: null, registration: null, vehicle: null }, // vehicle: the optional photo of the car
  ref: null,
  registrationSent: null,
  vehiclePhotoSent: null,
  detailsSent: null,  // whether the make, model and color went with the request (null: not sent yet)
});

export function emptyFlow() {
  return {
    step: 'start',
    leaseholder: null,  // 'yes' | 'no'
    name: '',
    unit: '',
    phone: '',
    email: '',
    vehicles: [newVehicle('v1')],
    nextVid: 2,         // vehicle ids are never reused, so a stale history entry cannot land on a new vehicle
    another: null,      // S3b: 'yes' | 'no'
    docs: { id: null, lease: null },
    returnTo: null,     // 'review' while a "Change" from S5 is being made
    receipt: null,
  };
}

const clone = (flow) => JSON.parse(JSON.stringify(flow));

/** A copy of `flow` with one more (empty) vehicle; returns its id. */
export function addVehicle(flow) {
  const next = clone(flow);
  const vid = `v${next.nextVid}`;
  next.vehicles.push(newVehicle(vid));
  next.nextVid += 1;
  next.another = null;
  return { flow: next, vid };
}

export function removeVehicle(flow, vid) {
  const next = clone(flow);
  next.vehicles = next.vehicles.filter((v) => v.vid !== vid);
  next.another = null;
  return next;
}

export const findVehicle = (flow, vid) => flow.vehicles.find((v) => v.vid === vid) || null;
const vehicleIndex = (flow, vid) => flow.vehicles.findIndex((v) => v.vid === vid);

// ── the property's rules ────────────────────────────────────────────────────

/** `properties.max_vehicles_per_unit` as a cap, or null (missing column, NULL, nonsense). */
export function vehicleCap(property) {
  const raw = property ? property.max_vehicles_per_unit : null;
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

export function canAddVehicle(count, cap) {
  return cap == null || count < cap;
}

/** `properties.require_vehicle_registration`; a missing column reads false. */
export function requiresRegistration(property) {
  return !!property && property.require_vehicle_registration === true;
}

// ── steps ───────────────────────────────────────────────────────────────────

const STEP_NAMES = ['start', 'about', 'vehicles', 'documents', 'review', 'received'];
const STEP_NUMBER = { start: 1, about: 2, vehicle: 3, vehicles: 3, documents: 4, review: 5 };

/** `'vehicle:v2'` → `{name: 'vehicle', vid: 'v2'}`; `'review'` → `{name: 'review', vid: null}`; else null. */
export function parseStep(key) {
  if (typeof key !== 'string') return null;
  const m = /^vehicle:(v\d{1,3})$/.exec(key);
  if (m) return { name: 'vehicle', vid: m[1] };
  return STEP_NAMES.includes(key) ? { name: key, vid: null } : null;
}

/** The step to show for `key`: sent requests show the receipt, everything waits behind the S1 gate. */
export function resolveStep(key, flow) {
  if (flow.receipt) return 'received';
  const p = parseStep(key);
  if (!p) return 'start';
  if (p.name !== 'start' && flow.leaseholder !== 'yes') return 'start';
  if (p.name === 'received') return 'review';
  if (p.name === 'vehicle' && !findVehicle(flow, p.vid)) return 'vehicles';
  return key;
}

/**
 * Where Continue goes. Besides step keys this can answer `'short-term'` (the
 * S1 "No" branch: the short-term form) and `'vehicle:new'` (apt.js adds a
 * vehicle, then shows it).
 */
export function nextStep(key, flow, ctx = {}) {
  const p = parseStep(key) || { name: key };
  const toReview = flow.returnTo === 'review';
  switch (p.name) {
    case 'start':
      if (flow.leaseholder === 'yes') return 'about';
      return flow.leaseholder === 'no' ? 'short-term' : 'start';
    case 'about':
      if (toReview) return 'review';
      return flow.vehicles.length ? `vehicle:${flow.vehicles[0].vid}` : 'vehicle:new';
    case 'vehicle':
      return toReview ? 'review' : 'vehicles';
    case 'vehicles': {
      if (!flow.vehicles.length) return 'vehicle:new';
      const room = canAddVehicle(flow.vehicles.length, ctx.cap);
      if (room && flow.another === 'yes') return 'vehicle:new';
      if (room && flow.another !== 'no') return 'vehicles';
      return toReview ? 'review' : 'documents';
    }
    case 'documents':
      return 'review';
    case 'review':
      return 'received';
    default:
      return 'start';
  }
}

/** Where Back goes when there is no history entry to return to. */
export function prevStep(key, flow) {
  const p = parseStep(key) || { name: key };
  switch (p.name) {
    case 'about': return 'start';
    case 'vehicle': return vehicleIndex(flow, p.vid) > 0 ? 'vehicles' : 'about';
    case 'vehicles': {
      const last = flow.vehicles[flow.vehicles.length - 1];
      return last ? `vehicle:${last.vid}` : 'about';
    }
    case 'documents': return 'vehicles';
    case 'review': return 'documents';
    case 'received': return 'received';
    default: return 'landing';
  }
}

/** "Step 3 of 5 · Vehicle 1 of 2", or null on the receipt. */
export function stepCaption(key, flow, ctx = {}) {
  const p = parseStep(key);
  if (!p || !STEP_NUMBER[p.name]) return null;
  const step = S.stepOf(STEP_NUMBER[p.name], STEP_COUNT);
  if (p.name !== 'vehicle') return step;
  const i = vehicleIndex(flow, p.vid) + 1;
  if (ctx.cap === 1) return step;
  return `${step} · ${S.vehicleOf(i, ctx.cap || null)}`;
}

// ── ids ─────────────────────────────────────────────────────────────────────

/** A document slot: `'id'`, `'lease'`, `'plate:v1'`, `'registration:v1'`, `'vehicle:v1'`. */
export const slotId = (kind, vid) => (vid ? `${kind}:${vid}` : kind);
export const fieldId = (name, vid) => `${name}-${vid}`;
export const cardId = (slot) => `card-${slot.replace(':', '-')}`;
const slotKind = (slot) => slot.split(':')[0];

/**
 * Every document slot this request has → its saved reference (or null): the
 * registration card only where the property asks for it, the optional vehicle
 * photo always (null when it was not added).
 */
export function docRefs(flow, ctx = {}) {
  const out = { id: flow.docs.id, lease: flow.docs.lease };
  for (const v of flow.vehicles) {
    out[slotId('plate', v.vid)] = v.docs.plate;
    if (ctx.requireRegistration) out[slotId('registration', v.vid)] = v.docs.registration;
    out[slotId('vehicle', v.vid)] = v.docs.vehicle || null;
  }
  return out;
}

/** The card state for a saved reference: "Uploaded earlier" when there is a key. */
export const docState = (ref) => initialCardState(ref);

const reEscape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The key shape /apartment/uploads hands out for this property and kind (the backend's _valid_doc_key). */
export function docKeyValid(key, propertyId, kind) {
  if (typeof key !== 'string' || !key || !propertyId || !kind) return false;
  const re = new RegExp(`^apt/${reEscape(propertyId)}/${reEscape(kind)}/[0-9a-f]{32}\\.(?:jpg|jpeg|png|webp|heic|pdf|bin)$`);
  return re.test(key);
}

/** Which uploads to ask for again after "invalid document reference": the bad ones, or all when none looks bad. */
export function invalidDocSlots(refs, propertyId) {
  const present = Object.entries(refs).filter(([, ref]) => ref && ref.key);
  const bad = present.filter(([slot, ref]) => !docKeyValid(ref.key, propertyId, slotKind(slot))).map(([slot]) => slot);
  return bad.length ? bad : present.map(([slot]) => slot);
}

// ── validation ──────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PLATE_CHARS_RE = /^[A-Za-z0-9\s.\-]*$/;

/** "(704) 555-0123" for a US number; anything else as typed. */
export function formatPhone(raw) {
  const s = String(raw || '').trim();
  const digits = s.replace(/\D/g, '');
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (national.length === 10 && (digits.length === 10 || digits.length === 11)) {
    return `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`;
  }
  return s;
}

/** The number in E.164 (+17045550123), or null when it is not a phone number. */
export function phoneToE164(raw) {
  const s = String(raw || '').trim();
  const digits = s.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (s.startsWith('+') && digits.length >= 8 && digits.length <= 15 && !digits.startsWith('1')) return `+${digits}`;
  return null;
}

/** The registered form of a plate: the shared normalizer (uppercase, letters and numbers, no state). */
export const displayPlate = (raw) => normalizePlate(raw);

/** A make or model as the office gets it: trimmed, runs of spaces made one. The case is as typed. */
export function normalizeVehicleText(raw) {
  return typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
}

/** "white Honda Civic": the color lowercase, the make and model as typed. Whatever is missing is left out. */
export function vehicleDescription(v) {
  const o = v || {};
  const color = typeof o.color === 'string' ? o.color.trim().toLowerCase() : '';
  return [color, normalizeVehicleText(o.make), normalizeVehicleText(o.model)].filter(Boolean).join(' ');
}

/** The dot between the description and the plate: "white Honda Civic · ABC1234". */
export const VEHICLE_LINE_SEPARATOR = ' · ';

/**
 * The three parts of "white Honda Civic · ABC1234", the line S3b, S5 and S6 draw
 * for a vehicle in the flow or on a saved receipt: the description, the dot
 * (only between a description and a plate) and the plate. The plate is the
 * vehicle's own unless the page names it otherwise ("Vehicle 2" until it has
 * one). A request saved before the make, model and color existed has no
 * description: its line is the plate alone.
 */
export function vehicleLineParts(v, plate = displayPlate(v && v.plate)) {
  const description = vehicleDescription(v);
  return { description, separator: description && plate ? VEHICLE_LINE_SEPARATOR : '', plate };
}

/** The make, model and color as the three request fields. */
export function vehicleFields(v) {
  return {
    [VEHICLE_REQUEST_FIELD.make]: normalizeVehicleText(v.make),
    [VEHICLE_REQUEST_FIELD.model]: normalizeVehicleText(v.model),
    [VEHICLE_REQUEST_FIELD.color]: v.color,
  };
}

/** One field's error message, or null. */
export function validateField(field, value) {
  const v = String(value == null ? '' : value);
  switch (field) {
    case 'name': return v.trim() ? null : S.about.errorName;
    case 'unit': return v.trim() ? null : S.about.errorUnit;
    case 'phone': return phoneToE164(v) ? null : S.about.errorPhone;
    case 'email':
      if (!v.trim()) return S.about.errorEmailEmpty;
      return EMAIL_RE.test(v.trim()) ? null : S.about.errorEmail;
    case 'plate': {
      if (!PLATE_CHARS_RE.test(v)) return S.vehicle.errorPlateChars;
      const plate = normalizePlate(v);
      if (plate.length < 2 || REGION_TOKENS.has(plate)) return S.vehicle.errorPlate;
      return null;
    }
    case 'make': return normalizeVehicleText(v) ? null : S.vehicle.errorMake;
    case 'model': return normalizeVehicleText(v) ? null : S.vehicle.errorModel;
    case 'color': return VEHICLE_COLORS.includes(v) ? null : S.vehicle.errorColor;
    default:
      return null;
  }
}

/**
 * The make, model and color checks on their own, in page order, each named by
 * its field (`make`, `model`, `color`). The short-term form uses them as they
 * are; the long-term flow gives each the id of its own element.
 * @param {{make?: string, model?: string, color?: string}} v
 * @returns {{field: 'make'|'model'|'color', message: string}[]}
 */
export function vehicleFieldErrors(v) {
  const o = v || {};
  return VEHICLE_FIELDS
    .map((field) => ({ field, message: validateField(field, o[field]) }))
    .filter((e) => e.message);
}

function docError(slot, ref, ctx, emptyMessage, field, imagesOnly = false) {
  const state = (ctx.docStates && ctx.docStates[slot]) || docState(ref);
  if (state.status === 'error') return { field, message: cardStatusText(state, S.card, { imagesOnly }) };
  if (isSatisfied(state) || isBusy(state) || emptyMessage == null) return null;
  return { field, message: emptyMessage };
}

function vehicleErrors(flow, v, ctx, fieldFor) {
  if (v.ref) return []; // already sent: locked
  const errors = [];
  const plateError = validateField('plate', v.plate);
  if (plateError) {
    errors.push({ field: fieldFor('plate'), message: plateError });
  } else {
    const plate = normalizePlate(v.plate);
    const before = flow.vehicles.slice(0, vehicleIndex(flow, v.vid));
    if (before.some((o) => normalizePlate(o.plate) === plate)) {
      errors.push({ field: fieldFor('plate'), message: S.vehicle.errorDuplicate(plate) });
    }
  }
  for (const e of vehicleFieldErrors(v)) errors.push({ field: fieldFor(e.field), message: e.message });
  const photo = docError(slotId('plate', v.vid), v.docs.plate, ctx, S.vehicle.errorPlatePhoto, fieldFor('card-plate'), true);
  if (photo) errors.push(photo);
  if (ctx.requireRegistration) {
    const reg = docError(slotId('registration', v.vid), v.docs.registration, ctx, S.vehicle.errorRegistration, fieldFor('card-registration'));
    if (reg) errors.push(reg);
  }
  // Optional: not added is fine; added and failed is an error until it is fixed or removed.
  const car = docError(slotId('vehicle', v.vid), v.docs.vehicle, ctx, null, fieldFor('card-vehicle'), true);
  if (car) errors.push(car);
  return errors;
}

const ABOUT_FIELDS = ['name', 'unit', 'phone', 'email'];

/**
 * The errors that keep Continue from moving on, in page order, each with the
 * id of the element its error-summary link should focus.
 * @param {string} key the step
 * @param {object} flow
 * @param {{cap?: number|null, requireRegistration?: boolean, docStates?: object}} ctx
 * @returns {{field: string, message: string}[]}
 */
export function validateStep(key, flow, ctx = {}) {
  const p = parseStep(key);
  if (!p) return [];
  switch (p.name) {
    case 'start':
      return flow.leaseholder ? [] : [{ field: 'leaseholder-yes', message: S.start.errorGate }];
    case 'about':
      return ABOUT_FIELDS
        .map((f) => ({ field: f, message: validateField(f, flow[f]) }))
        .filter((e) => e.message);
    case 'vehicle': {
      const v = findVehicle(flow, p.vid);
      if (!v) return [];
      return vehicleErrors(flow, v, ctx, (name) => (name.startsWith('card-') ? cardId(slotId(name.slice(5), v.vid)) : fieldId(name, v.vid)));
    }
    case 'vehicles': {
      if (!flow.vehicles.length) return [{ field: 'add-vehicle', message: S.vehicles.none }];
      const errors = [];
      flow.vehicles.forEach((v, i) => {
        if (vehicleErrors(flow, v, ctx, (n) => n).length) {
          const plate = normalizePlate(v.plate);
          errors.push({ field: `row-${v.vid}`, message: S.vehicles.errorIncomplete(plate || S.vehicles.unnamed(i + 1)) });
        }
      });
      if (canAddVehicle(flow.vehicles.length, ctx.cap) && !flow.another) {
        errors.push({ field: 'another-yes', message: S.vehicles.errorAnother });
      }
      return errors;
    }
    case 'documents': {
      const errors = [];
      const id = docError('id', flow.docs.id, ctx, S.documents.errorId, cardId('id'));
      const lease = docError('lease', flow.docs.lease, ctx, S.documents.errorLease, cardId('lease'));
      if (id) errors.push(id);
      if (lease) errors.push(lease);
      return errors;
    }
    case 'review': {
      const errors = validateStep('about', flow, ctx).map((e) => ({ ...e, field: `review-${e.field}` }));
      if (!flow.vehicles.length) errors.push({ field: 'review-vehicles', message: S.vehicles.none });
      for (const v of flow.vehicles) {
        for (const e of vehicleErrors(flow, v, ctx, () => `review-vehicle-${v.vid}`)) errors.push(e);
      }
      for (const e of validateStep('documents', flow, ctx)) errors.push({ ...e, field: `review-${e.field.replace('card-', '')}` });
      return errors;
    }
    default:
      return [];
  }
}

/**
 * A vehicle's status line on S3b and S5. Its thumbnails are decorative (and a
 * reload leaves none), so the words say what is attached.
 */
export function vehicleRowStatus(v, ctx = {}, { done = true } = {}) {
  const V = S.vehicles;
  if (v.ref) return V.rowSent(v.ref);
  if (!done) return V.rowIncomplete;
  const car = !!v.docs.vehicle;
  if (ctx.requireRegistration) return car ? V.rowDoneVehiclePhoto : V.rowDone;
  return car ? V.rowDonePhotosOnly : V.rowDonePhotoOnly;
}

// ── persistence (localStorage, keyed by qr_code_id, 24 h) ───────────────────

export const storageKey = (qrCodeId) => `lotlogic:apt:${qrCodeId}`;

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const oneOf = (v, allowed) => (allowed.includes(v) ? v : null);
const REF_RE = /^[0-9A-F]{8}$/;
const cleanRefId = (v) => (typeof v === 'string' && REF_RE.test(v.toUpperCase()) ? v.toUpperCase() : null);
const flag = (v) => (typeof v === 'boolean' ? v : null);
const cleanColor = (v) => (VEHICLE_COLORS.includes(v) ? v : '');
const cleanEmail = (v) => (typeof v === 'string' && v.length <= MAX.email && EMAIL_RE.test(v) ? v : '');

function pickDoc(ref) {
  if (!ref || typeof ref !== 'object' || typeof ref.key !== 'string' || !ref.key) return null;
  return {
    key: ref.key,
    name: str(ref.name, MAX.docName),
    size: Number.isFinite(ref.size) && ref.size >= 0 ? ref.size : 0,
    type: str(ref.type, MAX.docType),
  };
}

function cleanDoc(ref, propertyId, kind) {
  const picked = pickDoc(ref);
  return picked && docKeyValid(picked.key, propertyId, kind) ? picked : null;
}

function cleanReceipt(r) {
  if (!r || typeof r !== 'object' || !Number.isFinite(r.submittedAt) || !Array.isArray(r.vehicles)) return null;
  const vehicles = r.vehicles
    .filter((v) => v && typeof v === 'object' && cleanRefId(v.ref))
    .slice(0, 10)
    .map((v) => ({
      plate: str(v.plate, 20),
      make: str(v.make, MAX.vehicleText),
      model: str(v.model, MAX.vehicleText),
      color: cleanColor(v.color),
      ref: cleanRefId(v.ref),
      registrationSent: v.registrationSent !== false,
      vehiclePhotoSent: flag(v.vehiclePhotoSent),
      detailsSent: v.detailsSent !== false,
    }));
  if (!vehicles.length) return null;
  return { submittedAt: r.submittedAt, unit: str(r.unit, MAX.unit), email: cleanEmail(r.email), vehicles };
}

/** Only the answers and the upload keys — never file bytes, previews or anything unknown. */
function pickFlow(flow) {
  return {
    step: typeof flow.step === 'string' ? flow.step : 'start',
    leaseholder: flow.leaseholder,
    name: flow.name,
    unit: flow.unit,
    phone: flow.phone,
    email: flow.email,
    vehicles: (flow.vehicles || []).map((v) => ({
      vid: v.vid,
      plate: v.plate,
      make: v.make,
      model: v.model,
      color: v.color,
      docs: {
        plate: pickDoc(v.docs && v.docs.plate),
        registration: pickDoc(v.docs && v.docs.registration),
        vehicle: pickDoc(v.docs && v.docs.vehicle),
      },
      ref: v.ref,
      registrationSent: v.registrationSent,
      vehiclePhotoSent: v.vehiclePhotoSent,
      detailsSent: v.detailsSent,
    })),
    nextVid: flow.nextVid,
    another: flow.another,
    docs: { id: pickDoc(flow.docs && flow.docs.id), lease: pickDoc(flow.docs && flow.docs.lease) },
    returnTo: flow.returnTo,
    receipt: flow.receipt,
  };
}

export function serializeFlow(flow, { now, propertyId }) {
  return JSON.stringify({ v: FLOW_VERSION, savedAt: now, propertyId, flow: pickFlow(flow) });
}

/**
 * The saved flow, cleaned — or null when there is none, it is malformed, it is
 * older than the TTL, or it belongs to another property. Upload keys that are
 * not this property's (for their slot's kind) are dropped.
 */
export function restoreFlow(raw, { now, propertyId, ttlMs = TTL_MS }) {
  if (!raw || typeof raw !== 'string') return null;
  let saved;
  try { saved = JSON.parse(raw); } catch { return null; }
  if (!saved || typeof saved !== 'object' || saved.v !== FLOW_VERSION) return null;
  if (!Number.isFinite(saved.savedAt) || now - saved.savedAt > ttlMs || saved.savedAt - now > CLOCK_SKEW_MS) return null;
  if (!propertyId || saved.propertyId !== propertyId) return null;
  const f = saved.flow;
  if (!f || typeof f !== 'object') return null;

  const vehicles = (Array.isArray(f.vehicles) ? f.vehicles : [])
    .filter((v) => v && typeof v === 'object' && typeof v.vid === 'string' && /^v\d{1,3}$/.test(v.vid))
    .slice(0, 10)
    .map((v) => {
      const docs = v.docs && typeof v.docs === 'object' ? v.docs : {};
      return {
        vid: v.vid,
        plate: str(v.plate, MAX.plate),
        make: str(v.make, MAX.vehicleText),
        model: str(v.model, MAX.vehicleText),
        color: cleanColor(v.color),
        docs: {
          plate: cleanDoc(docs.plate, propertyId, 'plate'),
          registration: cleanDoc(docs.registration, propertyId, 'registration'),
          vehicle: cleanDoc(docs.vehicle, propertyId, 'vehicle'),
        },
        ref: cleanRefId(v.ref),
        registrationSent: flag(v.registrationSent),
        vehiclePhotoSent: flag(v.vehiclePhotoSent),
        detailsSent: flag(v.detailsSent),
      };
    });
  const highest = vehicles.reduce((m, v) => Math.max(m, Number(v.vid.slice(1))), 0);
  let nextVid = Math.max(Number.isInteger(f.nextVid) ? f.nextVid : 1, highest + 1);
  if (!vehicles.length) {
    vehicles.push(newVehicle(`v${nextVid}`));
    nextVid += 1;
  }
  const docs = f.docs && typeof f.docs === 'object' ? f.docs : {};
  return {
    step: typeof f.step === 'string' && parseStep(f.step) ? f.step : 'start',
    leaseholder: oneOf(f.leaseholder, ['yes', 'no']),
    name: str(f.name, MAX.name),
    unit: str(f.unit, MAX.unit),
    phone: str(f.phone, MAX.phone),
    email: str(f.email, MAX.email),
    vehicles,
    nextVid,
    another: oneOf(f.another, ['yes', 'no']),
    docs: { id: cleanDoc(docs.id, propertyId, 'id'), lease: cleanDoc(docs.lease, propertyId, 'lease') },
    returnTo: oneOf(f.returnTo, ['review']),
    receipt: cleanReceipt(f.receipt),
  };
}

/**
 * The flow once every vehicle is sent: the receipt (plates, references, time,
 * unit, and the email the backend sent its copy to) and nothing else — the
 * other answers and the document keys are forgotten. Each vehicle keeps its
 * plate, make, model and color, so the receipt can say "white Honda Civic ·
 * ABC1234".
 * @param {{now: number, refs: Record<string,string>, registrationSent: Record<string,boolean>,
 *          vehiclePhotoSent?: Record<string,boolean|null>, detailsSent?: Record<string,boolean>}} sent
 */
export function receiptFlow(flow, { now, refs, registrationSent, vehiclePhotoSent = {}, detailsSent = {} }) {
  const vehicles = flow.vehicles.map((v) => ({
    plate: normalizePlate(v.plate),
    make: normalizeVehicleText(v.make),
    model: normalizeVehicleText(v.model),
    color: cleanColor(v.color),
    ref: cleanRefId(refs[v.vid] || v.ref),
    registrationSent: registrationSent[v.vid] !== false,
    vehiclePhotoSent: flag(vehiclePhotoSent[v.vid]),
    detailsSent: detailsSent[v.vid] !== false,
  }));
  return {
    ...emptyFlow(),
    step: 'received',
    receipt: { submittedAt: now, unit: flow.unit.trim(), email: cleanEmail(flow.email.trim()), vehicles },
  };
}

// ── the backend's answers → plain language (brief item 10) ──────────────────

function detailText(err) {
  if (typeof err.detail === 'string') return err.detail;
  if (err.status && typeof err.message === 'string') return err.message;
  return '';
}

/**
 * The backend's two answers about the make, model and color, in plain
 * language — `400 {"detail": "vehicle_required", "missing": ["vehicle_make", …]}`
 * and `400 {"detail": "vehicle_color_invalid"}` — or null for anything else.
 * `field` is the one to put the person at: the first missing one in the page's
 * order (the color for an invalid color). `err.body` is the response body
 * backendRegister keeps, where `missing` sits beside `detail`. The short-term
 * form names its own elements; registerErrorMessage names the long-term ones.
 * @returns {{code: string, message: string, field: 'make'|'model'|'color'}|null}
 */
export function vehicleBackendError(err) {
  const e = err || {};
  const detail = detailText(e);
  if (detail === 'vehicle_color_invalid') {
    return { code: 'vehicle_color_invalid', message: S.errors.vehicleColorInvalid, field: 'color' };
  }
  if (detail === 'vehicle_required') {
    const missing = e.body && Array.isArray(e.body.missing) ? e.body.missing : [];
    const field = VEHICLE_FIELDS.find((f) => missing.includes(VEHICLE_REQUEST_FIELD[f])) || VEHICLE_FIELDS[0];
    return { code: 'vehicle_required', message: S.errors.vehicleRequired, field };
  }
  return null;
}

/**
 * What to tell the resident when `POST /resident_plates/register` fails.
 * @param {any} err the thrown error (`status`, `detail`, `code`, `name`)
 * @param {{unit: string, plate: string, limit: number|null, vid: string, phone: string|null}} ctx
 * @returns {{code: string, message: string, field: string|null}}
 */
export function registerErrorMessage(err, ctx) {
  const e = err || {};
  const E = S.errors;
  const vehicleField = ctx.vid ? `review-vehicle-${ctx.vid}` : null;
  if (e.code === 'recaptcha_blocked') return { code: 'recaptcha_blocked', message: E.blocked(ctx.phone), field: null };
  const detail = detailText(e);
  if (e.code === 'recaptcha' || detail.startsWith('recaptcha:')) return { code: 'recaptcha', message: E.recaptcha, field: null };
  if (!e.status) return { code: 'network', message: E.network, field: null };
  if (detail === 'unit_vehicle_limit') {
    const message = ctx.limit ? E.unitLimit(ctx.unit, ctx.limit) : E.unitLimitUnknown(ctx.unit);
    return { code: 'unit_vehicle_limit', message, field: vehicleField };
  }
  if (detail === 'registration_required') return { code: 'registration_required', message: E.registrationRequired, field: vehicleField };
  const vehicle = vehicleBackendError(e);
  if (vehicle) {
    // The fields are on the vehicle's own step: name the one to start at.
    return { code: vehicle.code, message: vehicle.message, field: ctx.vid ? fieldId(vehicle.field, ctx.vid) : null };
  }
  if (e.status === 409 && (detail === 'duplicate_registration' || /already registered/i.test(detail))) {
    return { code: 'duplicate_registration', message: E.duplicate(ctx.plate), field: vehicleField };
  }
  if (detail === 'invalid document reference') return { code: 'invalid_document', message: E.expiredUpload, field: null };
  if (detail === 'unit_required') return { code: 'unit_required', message: E.unitRequired, field: 'review-unit' };
  if (e.status === 422 && JSON.stringify(e.detail || '').includes('"email"')) {
    return { code: 'email', message: E.email, field: 'review-email' };
  }
  return { code: 'unknown', message: E.generic, field: null };
}

// TEMPORARY (remove once backend tasks B1, B3 and B4 are live): the fields an
// older backend does not have yet — the two documents, then the make, model and
// color. Its register model forbids extra fields, so it answers 422 and the page
// sends the request once more without them (apt.js registerVehicle), saying so
// on the receipt.
export const NEWER_FIELDS = ['registration_doc_url', 'vehicle_photo_url', ...Object.values(VEHICLE_REQUEST_FIELD)];

/**
 * The fields among `fields` that a 422 names as unknown — pydantic's
 * `extra_forbidden` (`value_error.extra` in v1) at `loc: ['body', <field>]`.
 * [] for any other answer, including a 422 about a field the backend knows.
 * @param {any} err the error backendRegister threw (`status`, `detail`)
 * @param {string[]} [fields] the fields this call sent
 * @returns {string[]}
 */
export function rejectedUnknownFields(err, fields = NEWER_FIELDS) {
  if (!err || err.status !== 422 || !Array.isArray(err.detail)) return [];
  const unknown = new Set();
  for (const e of err.detail) {
    if (!e || !Array.isArray(e.loc) || !e.loc.length || !/extra/.test(String(e.type || ''))) continue;
    unknown.add(e.loc[e.loc.length - 1]);
  }
  return NEWER_FIELDS.filter((f) => fields.includes(f) && unknown.has(f));
}

/** One vehicle's document fields beyond the shared three: only the keys there are. */
export function docFields(v, ctx = {}) {
  const out = {};
  if (ctx.requireRegistration && v.docs.registration) out.registration_doc_url = v.docs.registration.key;
  if (v.docs.vehicle) out.vehicle_photo_url = v.docs.vehicle.key;
  return out;
}

/**
 * What went with one vehicle's request, for the receipt. `dropped`: the fields
 * the retry left out. vehiclePhotoSent is null when no photo was added;
 * detailsSent (the make, model and color) is false if the retry left any out.
 */
export function sentFlags(v, ctx = {}, dropped = []) {
  return {
    registrationSent: !ctx.requireRegistration || (!!v.docs.registration && !dropped.includes('registration_doc_url')),
    vehiclePhotoSent: v.docs.vehicle ? !dropped.includes('vehicle_photo_url') : null,
    detailsSent: !VEHICLE_FIELDS.some((f) => dropped.includes(VEHICLE_REQUEST_FIELD[f])),
  };
}

// ── the receipt ─────────────────────────────────────────────────────────────

/** "Wed Oct 14, 9:42 PM ET" — always Eastern time. */
export function formatSubmitted(ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(new Date(ms));
  const get = (type) => (parts.find((p) => p.type === type) || {}).value || '';
  return `${get('weekday')} ${get('month')} ${get('day')}, ${get('hour')}:${get('minute')} ${get('dayPeriod').toUpperCase()} ET`;
}

/** What "Copy reference" puts on the clipboard: one line per vehicle. */
export function copyText(receipt) {
  return receipt.vehicles.map((v) => `${v.plate} ref ${v.ref}`).join('\n');
}
