// apt.html — /apt/<qr>, an apartment's one registration page.
//
//   no ?role=        the landing: "I live here" / "I'm visiting"
//   ?role=guest      the short-term form (one page, plate + ID; Task F3
//                    restyled it only; Task F5a added the vehicle's make,
//                    model and color)
//   ?role=resident   the long-term parking-pass request, in steps (Task F3):
//                    S1 Before you start → S2 About you → S3 Vehicle n (×N,
//                    plate, make, model and color, plate photo, registration
//                    card, optional vehicle photo) →
//                    S3b Your vehicles → S4 Your ID and lease → S5 Check your
//                    answers → S6 Request received. The model — strings, step
//                    router, validation, persistence, error map — is
//                    ./shared/aptFlow.js; each document is a card from
//                    ./shared/docCard.js that uploads the moment it is chosen,
//                    so "Send for review" posts only JSON with the keys.
//
// Steps are history entries (pushState), so the browser's Back returns to the
// previous step with every answer intact. Answers and upload keys (never file
// bytes) are kept in localStorage per qr_code_id for 24 hours: a walk to the
// car, a reload or a dropped connection costs nothing. The receipt (plates and
// references) is kept the same way, so a reload shows it again.
//
// DIVERGENCE (Task 17) — normalizePlate strips a trailing state token here, as
// on the other two pages; backendRegister's timeout is passed as 15000 at each
// call site (this page's original), not the shared 12000 default.
import {
  pgRest, backendRegister, getRecaptchaToken, friendlyErrorMessage,
  escapeHtml, showNotFound, showConnectionError, normalizePlate, normalizePhone,
  newIdempotencyKey, propertyQuery, logoHtml, BACKEND_URL, initialScreenForRole, aptEntryUrl,
} from './shared/register.js';
import {
  STRINGS, storageKey, emptyFlow, addVehicle, removeVehicle, findVehicle,
  parseStep, resolveStep, nextStep, prevStep, stepCaption,
  vehicleCap, canAddVehicle, requiresRegistration,
  formatPhone, phoneToE164, validateField, validateStep,
  slotId, cardId, docRefs, docState, serializeFlow, restoreFlow, receiptFlow,
  registerErrorMessage, rejectedUnknownFields, docFields, sentFlags, invalidDocSlots,
  formatSubmitted, copyText, displayPlate, vehicleRowStatus,
  VEHICLE_COLORS, VEHICLE_MAKES, normalizeVehicleText, vehicleDescription, vehicleFields,
  vehicleFieldErrors, vehicleBackendError, fieldId,
} from './shared/aptFlow.js';
import {
  createDocSlot, mountDocCard, prepareFile, xhrUpload, thumbnailHtml, isSatisfied, isBusy,
  formatBytes,
} from './shared/docCard.js';

const S = STRINGS.en;
const app = document.getElementById('app');

// QR code id comes from /apt/<qr> in the URL, but we also accept ?qr=<id> so a
// shared / emailed link like /apt.html?qr=... still works.
const pathParts = window.location.pathname.split('/').filter(Boolean);
const qrCodeId = (pathParts.length >= 2 ? pathParts[pathParts.length - 1] : null)
  || new URLSearchParams(window.location.search).get('qr');

// The two rule columns are read with the rest; before the backend migration
// grants them (or adds them) the wide read fails and the narrow one is used:
// no cap line, no registration card, and the page still works.
const BASE_COLUMNS = 'id,name,address,property_type,policy_phone';
const RULE_COLUMNS = 'max_vehicles_per_unit,require_vehicle_registration';

let property = null;
let rules = { cap: null, requireRegistration: false };
let flow = null;            // the long-term request, see ./shared/aptFlow.js
const slots = new Map();    // document slot id → its upload pipeline (holds the bytes in memory)
let cards = [];             // the document cards drawn on the current screen
let screen = null;          // 'landing' | 'guest' | a flow step key
let depth = 0;              // history entries this page has pushed below the current one
let sending = false;
let continueToken = 0;      // a newer Continue (or leaving the step) cancels "Finishing upload…"
let saveTimer = null;
let recaptchaBlocked = false;
const dirty = new Set();    // text fields typed in on this screen (blur validates only those)
let shownErrors = [];       // what the error summary lists right now

/** HTML-escape for text AND attribute values (the shared escapeHtml leaves quotes). */
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const ICON = (paths, size = 18) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
const ICONS = {
  person: ICON('<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>'),
  car: ICON('<path d="M5 16V11l2-5h10l2 5v5"/><path d="M3 16h18v3H3z"/><circle cx="7.5" cy="16" r="1"/><circle cx="16.5" cy="16" r="1"/>'),
  shield: ICON('<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>'),
  clock: ICON('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  info: ICON('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/>'),
  check: ICON('<circle cx="12" cy="12" r="10"/><path d="M7.5 12.5l3 3 6-6.5"/>', 32),
};

// ── shared helpers (unchanged for the short-term form) ─────────────────────
async function uploadFile(file, kind, timeoutMs = 30000) {
  const recaptchaToken = await getRecaptchaToken('apartment_upload').catch(() => null);
  if (!recaptchaToken) {
    throw new Error('Please retry — automated-access check failed.');
  }
  const fd = new FormData();
  fd.append('file', file);
  fd.append('property_id', property.id);
  fd.append('kind', kind);
  fd.append('recaptcha_token', recaptchaToken);

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(BACKEND_URL + '/apartment/uploads', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { Accept: 'application/json' }, // let the browser set the multipart boundary
      body: fd,
    });
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const detail = body && (body.detail || body.message);
      const err = new Error(typeof detail === 'string' ? detail : ('Upload failed (HTTP ' + res.status + ')'));
      err.status = res.status;
      throw err;
    }
    if (!body || !body.key) {
      throw new Error('Upload did not return a file reference. Please try again.');
    }
    return body.key;
  } finally { clearTimeout(t); }
}

// ── load ────────────────────────────────────────────────────────────────────
async function init() {
  if (!qrCodeId) {
    showNotFound('Invalid link', 'This registration link is not valid.');
    return;
  }
  try {
    const rows = await loadPropertyRow();
    const data = Array.isArray(rows) ? rows[0] : null;
    if (!data) {
      showNotFound('Property not found', 'This registration link is not valid or has expired.');
      return;
    }
    property = data;
    rules = { cap: vehicleCap(property), requireRegistration: requiresRegistration(property) };
    if (recaptchaBlocked) showBlocked(); // the panel learned the office's phone
    showFirstScreen();
  } catch (err) {
    console.error('init error:', err);
    showConnectionError(err, init);
  }
}

async function loadPropertyRow() {
  try {
    return await pgRest(propertyQuery(qrCodeId, `${BASE_COLUMNS},${RULE_COLUMNS}`));
  } catch (err) {
    if (!err || !err.status) throw err; // timeout / network — not a column problem
    console.warn('property rule columns unreadable — no cap line and no registration card:', err.message);
    return await pgRest(propertyQuery(qrCodeId, BASE_COLUMNS));
  }
}

const officePhone = () => (property && property.policy_phone ? formatPhone(property.policy_phone) : null);
const officeTel = () => {
  if (!property || !property.policy_phone) return '';
  return phoneToE164(property.policy_phone) || String(property.policy_phone).replace(/[^\d+]/g, '');
};
const telLink = () => `<a class="tel-link" href="tel:${esc(officeTel())}">${esc(officePhone())}</a>`;

// ── navigation: one history entry per screen ────────────────────────────────
function historyApi() {
  const h = window.history;
  return h && typeof h.pushState === 'function' && typeof h.replaceState === 'function' ? h : null;
}

function savedHistoryEntry() {
  const h = historyApi();
  try {
    return h && h.state && typeof h.state.apt === 'string' ? h.state : null;
  } catch {
    return null;
  }
}

function record(key, mode) {
  const h = historyApi();
  if (!h || mode === 'none') return;
  try {
    if (mode === 'push') {
      h.pushState({ apt: key, depth: depth + 1 }, '');
      depth += 1;
    } else {
      h.replaceState({ apt: key, depth }, '');
    }
  } catch { /* no history (a sandboxed frame): the page still works, Back links still do */ }
}

// The first screen. A reload lands back where it was (history.state survives
// a reload); otherwise ?role= picks the form, as Task F2 set up.
function showFirstScreen() {
  const entry = savedHistoryEntry();
  if (entry) {
    depth = Number(entry.depth) || 0;
    show(entry.apt, { mode: 'none', initial: true });
    return;
  }
  const role = initialScreenForRole(window.location.search);
  if (role === 'resident') show(flowEntryStep(), { mode: 'replace', initial: true });
  else if (role === 'guest') show('guest', { mode: 'replace', initial: true });
  else show('landing', { mode: 'replace', initial: true });
}

function ensureFlow() {
  if (flow) return;
  let raw = null;
  try {
    raw = window.localStorage ? window.localStorage.getItem(storageKey(qrCodeId)) : null;
  } catch { raw = null; } // private mode / blocked storage
  flow = restoreFlow(raw, { now: Date.now(), propertyId: property.id }) || emptyFlow();
}

function flowEntryStep() {
  ensureFlow();
  return flow.step;
}

/**
 * Show a screen. `mode`: 'push' (a new history entry), 'replace' (this one),
 * 'none' (the browser already moved: Back/Forward or a reload).
 */
function show(target, { mode = 'push', initial = false, focusId = null } = {}) {
  let key = target;
  if (key !== 'landing' && key !== 'guest') {
    ensureFlow();
    key = resolveStep(key, flow);
    if (flow.step !== key) {
      flow.step = key;
      saveNow();
    }
  }
  record(key, mode === 'none' && key !== target ? 'replace' : mode);
  render(key, { initial, focusId });
}

function goBack() {
  if (sending) return;
  const h = historyApi();
  if (depth > 0 && h && typeof h.back === 'function') {
    h.back();
    return;
  }
  const prev = screen === 'guest' || screen === 'landing' ? 'landing' : prevStep(screen, flow);
  show(prev, { mode: 'replace' });
}

function onPopState(e) {
  const entry = e && e.state;
  if (!entry || typeof entry.apt !== 'string' || !property) return; // a #fragment, or not ours
  if (sending) return; // the request is on its way; the receipt (or the error) comes next
  depth = Number(entry.depth) || 0;
  continueToken += 1;
  show(entry.apt, { mode: 'none' });
}

// ── rendering ───────────────────────────────────────────────────────────────
function teardown() {
  for (const card of cards) card.destroy();
  cards = [];
  dirty.clear();
  shownErrors = [];
  continueToken += 1;
  for (const img of document.querySelectorAll('img[data-object-url]')) {
    try { URL.revokeObjectURL(img.src); } catch { /* already gone */ }
  }
}

function render(key, { initial = false, focusId = null } = {}) {
  teardown();
  screen = key;
  const step = parseStep(key);
  if (key === 'landing') renderLanding();
  else if (key === 'guest') showGuestForm();
  else if (step.name === 'start') renderStart();
  else if (step.name === 'about') renderAbout();
  else if (step.name === 'vehicle') renderVehicle(step.vid);
  else if (step.name === 'vehicles') renderVehicles();
  else if (step.name === 'documents') renderDocuments();
  else if (step.name === 'review') renderReview();
  else renderReceived();
  if (!initial) moveFocus(focusId);
}

function moveFocus(focusId) {
  const target = (focusId && document.getElementById(focusId)) || document.getElementById('stepTitle');
  if (target && typeof target.focus === 'function') {
    try { target.focus({ preventScroll: true }); } catch { target.focus(); }
  }
  if (typeof window.scrollTo === 'function') window.scrollTo(0, 0);
}

function setTitle(text, hasError = false) {
  document.title = `${hasError ? S.titleErrorPrefix : ''}${text} – ${property.name}`;
}

const topBar = () => `
  <div class="flow-top">
    <p class="wordmark">LotL<span>o</span>gic</p>
    <p class="property-name">${esc(property.name)}</p>
  </div>`;

const errorSummaryHtml = () => `
  <div class="error-summary" id="errorSummary" tabindex="-1" aria-labelledby="errorSummaryTitle" hidden>
    <div role="alert">
      <h2 class="error-summary-title" id="errorSummaryTitle">${esc(S.errorSummaryTitle)}</h2>
      <ul class="error-list" id="errorList"></ul>
    </div>
  </div>`;

function stepHeader(key, title) {
  const caption = stepCaption(key, flow, rules);
  return `
    ${errorSummaryHtml()}
    ${caption ? `<p class="step-caption">${esc(caption)}</p>` : ''}
    <h1 class="flow-h1" id="stepTitle" tabindex="-1">${esc(title)}</h1>`;
}

const actionsHtml = (label, back = true) => `
  <div class="actions">
    <button type="submit" class="submit-btn" id="continueBtn">${esc(label)}</button>
    ${back ? `<button type="button" class="back-link" id="backLink">${esc(S.back)}</button>` : ''}
  </div>`;

// `wrapClass`: the short-term form's fields are not `.field`s (its labels carry their own spacing).
// `after`: markup that belongs to the input, kept inside the wrapper (the Make field's <datalist>).
function textField({ id, label, hint, value, attrs, inputClass = '', wrapClass = 'field', after = '' }) {
  return `
    <div class="${esc(wrapClass)}" id="wrap-${esc(id)}">
      <label for="${esc(id)}">${esc(label)}</label>
      ${hint ? `<p class="hint" id="${esc(id)}-hint">${esc(hint)}</p>` : ''}
      <p class="field-error" id="${esc(id)}-error" hidden></p>
      <input id="${esc(id)}" name="${esc(id)}"${inputClass ? ` class="${esc(inputClass)}"` : ''} value="${esc(value)}"${hint ? ` aria-describedby="${esc(id)}-hint"` : ''} ${attrs}>
      ${after}
    </div>`;
}

// The vehicle's make, model and color, on S3 and on the short-term form. The
// make is free text with a list of suggestions; the color is a select whose
// values are the backend's lowercase list.
const VEHICLE_TEXT_ATTRS = 'type="text" autocomplete="off" autocapitalize="words" autocorrect="off" spellcheck="false" maxlength="40"';
const makeSuggestions = () => `<datalist id="vehicle-makes">${VEHICLE_MAKES.map((m) => `<option value="${esc(m)}"></option>`).join('')}</datalist>`;

function colorField({ id, label, value, wrapClass = 'field', attrs = '' }) {
  const options = [
    `<option value="">${esc(S.vehicle.colorPlaceholder)}</option>`,
    ...VEHICLE_COLORS.map((c) => `<option value="${esc(c)}"${c === value ? ' selected' : ''}>${esc(S.vehicle.colors[c])}</option>`),
  ].join('');
  return `
    <div class="${esc(wrapClass)}" id="wrap-${esc(id)}">
      <label for="${esc(id)}">${esc(label)}</label>
      <p class="field-error" id="${esc(id)}-error" hidden></p>
      <div class="select-wrap"><select id="${esc(id)}" name="${esc(id)}" autocomplete="off"${attrs ? ` ${attrs}` : ''}>${options}</select></div>
    </div>`;
}

const radio = (name, value, label, checked) => `
  <label class="choice-card" for="${name}-${value}">
    <input type="radio" name="${name}" id="${name}-${value}" value="${value}"${checked ? ' checked' : ''}>
    <span>${esc(label)}</span>
  </label>`;

const cardField = (slot) => `
  <div class="field card-field" id="wrap-${cardId(slot)}">
    <p class="field-error" id="${cardId(slot)}-error" hidden></p>
    <div class="card-mount" id="mount-${cardId(slot)}"></div>
  </div>`;

function bindForm(onSubmit) {
  document.getElementById('residentForm').addEventListener('submit', onSubmit);
  const back = document.getElementById('backLink');
  if (back) back.addEventListener('click', goBack);
}

// ── inline errors and the error summary ─────────────────────────────────────
const groupOf = (field) => field.replace(/-yes$/, '');

function describe(input, id, on) {
  const ids = new Set((input.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
  if (on) ids.add(id); else ids.delete(id);
  if (ids.size) input.setAttribute('aria-describedby', [...ids].join(' '));
  else input.removeAttribute('aria-describedby');
}

function setInlineError(field, message) {
  if (!message) resolveError(field);
  const group = groupOf(field);
  const el = document.getElementById(`${group}-error`);
  if (!el || typeof el.setAttribute !== 'function') return;
  const wrap = document.getElementById(`wrap-${group}`);
  const input = document.getElementById(field);
  const isTextInput = input && (input.tagName === 'INPUT' || input.tagName === 'SELECT') && input.type !== 'radio';
  if (message) {
    el.innerHTML = `<span class="visually-hidden">${esc(S.errorPrefix)} </span>${esc(message)}`;
    el.hidden = false;
    if (wrap) wrap.classList.add('has-error');
    if (isTextInput) {
      input.setAttribute('aria-invalid', 'true');
      describe(input, el.id, true);
    }
  } else {
    el.textContent = '';
    el.hidden = true;
    if (wrap) wrap.classList.remove('has-error');
    if (isTextInput) {
      input.removeAttribute('aria-invalid');
      describe(input, el.id, false);
    }
  }
}

const showsError = (field) => {
  const el = document.getElementById(`${groupOf(field)}-error`);
  return !!el && el.hidden === false;
};

/** A document card in an error state shows its own message; don't repeat it above the card. */
function cardShowsOwnError(field) {
  if (!field.startsWith('card-')) return false;
  const slot = slots.get(field.slice(5).replace('-', ':'));
  return !!slot && slot.state.status === 'error';
}

function clearInlineErrors() {
  for (const el of document.querySelectorAll('.field-error')) {
    if (el.id) setInlineError(el.id.replace(/-error$/, ''), null);
  }
}

function hideErrorSummary() {
  shownErrors = [];
  const box = document.getElementById('errorSummary');
  if (box) box.hidden = true;
}

/** A fixed field leaves the error summary; the last one fixed takes the summary (and "Error:") away. */
function resolveError(field) {
  if (!shownErrors.some((e) => e.field === field)) return;
  shownErrors = shownErrors.filter((e) => e.field !== field);
  const list = document.getElementById('errorList');
  if (list && typeof list.querySelectorAll === 'function') {
    for (const a of list.querySelectorAll('a[data-target]')) {
      if (a.dataset.target === field) a.closest('li').remove();
    }
  }
  if (!shownErrors.length) {
    const box = document.getElementById('errorSummary');
    if (box) box.hidden = true;
    if (screen && screen !== 'landing' && screen !== 'guest') setTitle(titleFor(screen));
  }
}

// `focusSummary: false`: the caller has already put the cursor in the field the error is about.
function showErrors(errors, title, { focusSummary = true } = {}) {
  clearInlineErrors();
  shownErrors = errors.slice();
  for (const e of errors) {
    if (!cardShowsOwnError(e.field)) setInlineError(e.field, e.message);
  }
  const box = document.getElementById('errorSummary');
  const list = document.getElementById('errorList');
  if (!box || !list || typeof list.querySelectorAll !== 'function') return;
  list.innerHTML = errors
    .map((e) => `<li><a href="#${esc(e.field)}" data-target="${esc(e.field)}">${esc(e.message)}</a></li>`)
    .join('');
  for (const a of list.querySelectorAll('a[data-target]')) a.addEventListener('click', onSummaryLink);
  box.hidden = errors.length === 0;
  setTitle(title, errors.length > 0);
  if (errors.length && focusSummary) box.focus();
}

function onSummaryLink(e) {
  e.preventDefault(); // no #fragment: it would add a history entry
  const el = document.getElementById(e.currentTarget.dataset.target);
  if (!el) return;
  // The field itself, or the first control inside it a person can see (a card's
  // "Take photo" is hidden on a laptop, where "Choose a file" stands alone).
  const visible = (c) => c.offsetParent !== null || c.getClientRects().length > 0;
  const focusable = el.matches('input, button, select, textarea, a[href]')
    ? el
    : ([...el.querySelectorAll('input:not([type=file]), button, a[href]')].find(visible) || el);
  focusable.focus();
  (el.closest('.field') || el).scrollIntoView({ block: 'center' });
}

// ── persistence ─────────────────────────────────────────────────────────────
function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!flow || !property) return;
  try {
    if (window.localStorage) {
      window.localStorage.setItem(storageKey(qrCodeId), serializeFlow(flow, { now: Date.now(), propertyId: property.id }));
    }
  } catch { /* storage blocked or full: nothing is lost on this screen */ }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 250);
}

/**
 * Text input or select: keep the answer, validate on blur once changed, clear
 * the error as soon as it is fixed. `persist: false` for the short-term form,
 * which keeps nothing.
 */
function bindField(id, field, set, { persist = true } = {}) {
  const input = document.getElementById(id);
  input.addEventListener(input.tagName === 'SELECT' ? 'change' : 'input', () => {
    dirty.add(id);
    set(input.value);
    if (persist) scheduleSave();
    if (showsError(id) && !validateField(field, input.value)) setInlineError(id, null);
  });
  input.addEventListener('blur', () => {
    if (field === 'phone') {
      const formatted = formatPhone(input.value);
      if (formatted !== input.value && !validateField('phone', formatted)) {
        input.value = formatted;
        set(formatted);
        if (persist) scheduleSave();
      }
    }
    if (dirty.has(id) || showsError(id)) setInlineError(id, validateField(field, input.value));
  });
}

// ── documents ───────────────────────────────────────────────────────────────
const isOnline = () => !(typeof navigator !== 'undefined' && navigator && navigator.onLine === false);

function refFor(id) {
  const [kind, vid] = id.split(':');
  if (!vid) return flow.docs[kind] || null;
  const v = findVehicle(flow, vid);
  return v ? v.docs[kind] || null : null;
}

function setDocRef(id, ref) {
  if (!flow) return;
  const [kind, vid] = id.split(':');
  if (!vid) {
    flow.docs[kind] = ref;
    return;
  }
  const v = findVehicle(flow, vid);
  if (v) v.docs[kind] = ref;
}

function onSlotChange(id, state) {
  const settledWithKey = (state.status === 'done' || state.status === 'restored') && state.key;
  setDocRef(id, settledWithKey ? {
    key: state.key,
    name: (state.file && state.file.name) || '',
    size: (state.file && state.file.size) || 0,
    type: (state.file && state.file.type) || '',
  } : null);
  saveNow();
  // Fixed: uploaded, or — for the optional vehicle photo — removed.
  if (isSatisfied(state) || (state.status === 'empty' && id.startsWith('vehicle:'))) setInlineError(cardId(id), null);
}

function getSlot(id) {
  let slot = slots.get(id);
  if (slot) return slot;
  const kind = id.split(':')[0];
  slot = createDocSlot({
    kind,
    imagesOnly: kind === 'plate' || kind === 'vehicle',
    initial: refFor(id),
    prepare: prepareFile,
    upload: uploadDoc,
    isOnline,
    onChange: (state) => onSlotChange(id, state),
  });
  slots.set(id, slot);
  return slot;
}

const docStatesNow = () => Object.fromEntries([...slots].map(([id, slot]) => [id, slot.state]));
const stateOf = (id) => (slots.has(id) ? slots.get(id).state : docState(refFor(id)));

function mountCard(id, view) {
  const el = document.getElementById(`mount-${cardId(id)}`);
  if (!el || typeof el.querySelector !== 'function') return null;
  const card = mountDocCard(el, getSlot(id), { ...view, id: cardId(id), strings: S.card });
  cards.push(card);
  return card;
}

async function uploadDoc(blob, { kind, filename, timeoutMs, onProgress }) {
  const token = await mintToken('apartment_upload');
  const form = new FormData();
  form.append('file', blob, filename);
  form.append('property_id', property.id);
  form.append('kind', kind);
  form.append('recaptcha_token', token);
  return xhrUpload(`${BACKEND_URL}/apartment/uploads`, form, { onProgress, timeoutMs });
}

// ── reCAPTCHA: one token per upload and per register call ───────────────────
const recaptchaPresent = () => !!(window.grecaptcha && typeof window.grecaptcha.ready === 'function');

function waitForRecaptcha(ms) {
  if (recaptchaPresent()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (recaptchaPresent()) { clearInterval(timer); resolve(true); }
      else if (Date.now() - started > ms) { clearInterval(timer); resolve(false); }
    }, 200);
  });
}

async function mintToken(action) {
  if (!(await waitForRecaptcha(8000))) {
    showBlocked();
    throw Object.assign(new Error('the reCAPTCHA script never loaded'), { code: 'recaptcha_blocked' });
  }
  const token = await getRecaptchaToken(action).catch(() => null);
  if (!token) throw Object.assign(new Error('no reCAPTCHA token'), { code: 'recaptcha' });
  hideBlocked();
  return token;
}

/** The one page-level panel: something (a content blocker) stops the page from sending. */
function showBlocked() {
  recaptchaBlocked = true;
  const el = document.getElementById('pageAlert');
  if (!el) return;
  const phone = officePhone();
  let html = esc(S.errors.blocked(phone));
  if (phone) html = html.replace(esc(phone), telLink());
  el.innerHTML = `<p>${html}</p>`;
}

function hideBlocked() {
  if (!recaptchaBlocked) return;
  recaptchaBlocked = false;
  const el = document.getElementById('pageAlert');
  if (el) el.innerHTML = '';
}

// ── S0 the landing (kept) ───────────────────────────────────────────────────
function renderLanding() {
  app.innerHTML = `
    ${logoHtml()}
    <div class="property-name">
      ${esc(S.landing.eyebrow)}
      <strong>${esc(property.name)}</strong>
    </div>
    <button type="button" class="choice-btn" id="chooseResident">
      <span><span class="choice-title">${esc(S.landing.liveTitle)}</span><span class="sub">${esc(S.landing.liveSub)}</span></span>
      <span class="arrow" aria-hidden="true">→</span>
    </button>
    <button type="button" class="choice-btn" id="chooseGuest">
      <span><span class="choice-title">${esc(S.landing.visitTitle)}</span><span class="sub">${esc(S.landing.visitSub)}</span></span>
      <span class="arrow" aria-hidden="true">→</span>
    </button>
  `;
  document.getElementById('chooseResident').addEventListener('click', () => show(flowEntryStep(), { mode: 'push' }));
  document.getElementById('chooseGuest').addEventListener('click', () => show('guest', { mode: 'push' }));
  setTitle(S.titleSuffix);
}

// ── S1 before you start ─────────────────────────────────────────────────────
function renderStart() {
  const cap = rules.cap;
  const need = [
    S.start.needPlate,
    rules.requireRegistration ? S.start.needRegistration : null,
    S.start.needId,
    S.start.needLease,
  ].filter(Boolean);
  app.innerHTML = `
    ${topBar()}
    <form id="residentForm" class="flow" data-step="start" novalidate>
      ${stepHeader('start', S.start.title)}
      <section class="rules" aria-labelledby="rulesHeading">
        <h2 class="visually-hidden" id="rulesHeading">${esc(S.start.rulesHeading)}</h2>
        <ul class="rule-list">
          <li>${ICONS.person}<span>${esc(S.start.ruleLeaseholders)}</span></li>
          ${cap ? `<li>${ICONS.car}<span>${esc(S.start.ruleCap(cap))}</span></li>` : ''}
          <li>${ICONS.shield}<span>${esc(S.start.ruleReview)}</span></li>
        </ul>
      </section>
      <section class="need" aria-labelledby="needHeading">
        <h2 class="section-h2" id="needHeading">${esc(S.start.needHeading)}</h2>
        <ul class="need-list">${need.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
        <p class="meta">${esc(S.start.needFiles)}</p>
      </section>
      <p class="time-line">${ICONS.clock}<span>${esc(S.start.time)}</span></p>
      <fieldset class="field gate" id="wrap-leaseholder" aria-describedby="leaseholder-error">
        <legend class="legend">${esc(S.start.gateLegend)}</legend>
        <p class="field-error" id="leaseholder-error" hidden></p>
        <div class="choice-cards">
          ${radio('leaseholder', 'yes', S.start.gateYes, flow.leaseholder === 'yes')}
          ${radio('leaseholder', 'no', S.start.gateNo, flow.leaseholder === 'no')}
        </div>
      </fieldset>
      <div class="gate-no" id="gateNo" aria-live="polite"></div>
      ${actionsHtml(S.start.startButton)}
    </form>`;
  bindForm(onContinue);
  for (const value of ['yes', 'no']) {
    document.getElementById(`leaseholder-${value}`).addEventListener('change', () => {
      flow.leaseholder = value;
      saveNow();
      setInlineError('leaseholder-yes', null);
      updateGate();
    });
  }
  updateGate();
  setTitle(S.start.title);
}

function updateGate() {
  const no = flow.leaseholder === 'no';
  document.getElementById('continueBtn').textContent = no ? S.start.shortTermButton : S.start.startButton;
  document.getElementById('gateNo').innerHTML = no
    ? `<p>${esc(S.start.gateNoExplain)}</p><p>${esc(S.start.gateNoAsk)}</p>`
    : '';
}

// ── S2 about you ────────────────────────────────────────────────────────────
function renderAbout() {
  app.innerHTML = `
    ${topBar()}
    <form id="residentForm" class="flow" data-step="about" novalidate>
      ${stepHeader('about', S.about.title)}
      ${textField({ id: 'name', label: S.about.nameLabel, hint: S.about.nameHint, value: flow.name, attrs: 'type="text" autocomplete="name" autocapitalize="words" spellcheck="false" maxlength="80"' })}
      ${textField({ id: 'unit', label: S.about.unitLabel, hint: S.about.unitHint, value: flow.unit, inputClass: 'input-unit', attrs: 'type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="20"' })}
      ${textField({ id: 'phone', label: S.about.phoneLabel, hint: S.about.phoneHint, value: flow.phone, attrs: 'type="tel" autocomplete="tel" inputmode="tel" maxlength="40"' })}
      ${textField({ id: 'email', label: S.about.emailLabel, hint: S.about.emailHint, value: flow.email, attrs: 'type="email" autocomplete="email" inputmode="email" autocapitalize="off" spellcheck="false" maxlength="254"' })}
      ${actionsHtml(S.continue)}
    </form>`;
  bindForm(onContinue);
  for (const f of ['name', 'unit', 'phone', 'email']) bindField(f, f, (value) => { flow[f] = value; });
  setTitle(S.about.title);
}

// ── S3 vehicle n ────────────────────────────────────────────────────────────
function renderVehicle(vid) {
  const v = findVehicle(flow, vid);
  const index = flow.vehicles.indexOf(v);
  const plateId = `plate-${vid}`;
  const makeId = fieldId('make', vid);
  const modelId = fieldId('model', vid);
  const colorId = fieldId('color', vid);
  const plateSlot = slotId('plate', vid);
  const regSlot = slotId('registration', vid);
  const carSlot = slotId('vehicle', vid);
  const plateNow = () => displayPlate(v.plate);
  app.innerHTML = `
    ${topBar()}
    <form id="residentForm" class="flow" data-step="vehicle" novalidate>
      ${stepHeader(screen, S.vehicle.title(index + 1))}
      ${index > 0 && !v.ref ? `
        <div class="remove-vehicle">
          <button type="button" class="text-btn danger" id="removeVehicleBtn" aria-expanded="false" aria-controls="removeConfirm">${esc(S.vehicle.removeVehicle)}</button>
          <div class="confirm" id="removeConfirm" hidden>
            <p id="removeConfirmText"></p>
            <div class="confirm-actions">
              <button type="button" class="btn-secondary danger" id="removeYes">${esc(S.vehicle.removeYes)}</button>
              <button type="button" class="text-btn" id="removeNo">${esc(S.vehicle.removeNo)}</button>
            </div>
          </div>
        </div>` : ''}
      ${textField({ id: plateId, label: S.vehicle.plateLabel, hint: S.vehicle.plateHint, value: v.plate, inputClass: 'plate-input', attrs: 'type="text" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" maxlength="10"' })}
      ${textField({ id: makeId, label: S.vehicle.makeLabel, value: v.make, attrs: `${VEHICLE_TEXT_ATTRS} list="vehicle-makes"`, after: makeSuggestions() })}
      ${textField({ id: modelId, label: S.vehicle.modelLabel, value: v.model, attrs: VEHICLE_TEXT_ATTRS })}
      ${colorField({ id: colorId, label: S.vehicle.colorLabel, value: v.color })}
      ${cardField(plateSlot)}
      ${rules.requireRegistration ? cardField(regSlot) : ''}
      ${cardField(carSlot)}
      ${actionsHtml(S.continue)}
    </form>`;
  bindForm(onContinue);
  const plateCard = mountCard(plateSlot, {
    title: S.vehicle.platePhotoTitle,
    makeSure: [S.vehicle.platePhotoTip],
    sizeLine: S.vehicle.platePhotoSize,
    schematic: 'plate',
    question: () => (plateNow().length >= 2 ? S.vehicle.plateQuestion(plateNow()) : null),
  });
  if (rules.requireRegistration) {
    mountCard(regSlot, {
      title: S.vehicle.registrationTitle,
      note: S.vehicle.registrationNote,
      makeSure: S.vehicle.registrationChecks,
      sizeLine: S.vehicle.registrationSize,
      schematic: 'card',
    });
  }
  mountCard(carSlot, {
    title: S.vehicle.vehiclePhotoTitle,
    optional: true,
    note: S.vehicle.vehiclePhotoNote,
    sizeLine: S.vehicle.vehiclePhotoSize,
    schematic: 'vehicle',
  });
  bindField(plateId, 'plate', (value) => {
    v.plate = value;
    if (plateCard) plateCard.refresh();
  });
  bindField(makeId, 'make', (value) => { v.make = value; });
  bindField(modelId, 'model', (value) => { v.model = value; });
  bindField(colorId, 'color', (value) => { v.color = value; });
  const removeBtn = document.getElementById('removeVehicleBtn');
  if (index > 0 && !v.ref && removeBtn) {
    const confirm = document.getElementById('removeConfirm');
    removeBtn.addEventListener('click', () => {
      document.getElementById('removeConfirmText').textContent = S.vehicle.removeConfirm(plateNow());
      confirm.hidden = false;
      removeBtn.setAttribute('aria-expanded', 'true');
      document.getElementById('removeYes').focus();
    });
    document.getElementById('removeNo').addEventListener('click', () => {
      confirm.hidden = true;
      removeBtn.setAttribute('aria-expanded', 'false');
      removeBtn.focus();
    });
    document.getElementById('removeYes').addEventListener('click', () => dropVehicle(vid));
  }
  setTitle(S.vehicle.title(index + 1));
}

const VEHICLE_KINDS = ['plate', 'registration', 'vehicle'];

function forgetVehicleSlots(vid) {
  for (const kind of VEHICLE_KINDS) slots.delete(slotId(kind, vid));
}

function dropVehicle(vid) {
  flow = removeVehicle(flow, vid);
  forgetVehicleSlots(vid);
  saveNow();
  show('vehicles', { mode: 'replace' });
}

// ── S3b your vehicles ───────────────────────────────────────────────────────
function vehicleDone(v) {
  return !validateStep(`vehicle:${v.vid}`, flow, { ...rules, docStates: docStatesNow() }).length;
}

/**
 * "white Honda Civic · ABC1234": the description, then the plate. On S3b and S5
 * the plate is the ink chip; on the receipt (`chip: false`) it is plain, in the
 * plate's mono face. A vehicle with no description (a receipt saved before the
 * make, model and color existed) is its plate alone. The dot is decoration; it
 * belongs to the plate, and apt.css drops it when the plate wraps to a line of
 * its own. No whitespace between the tags: the pieces are inline-blocks.
 */
function vehicleLineHtml(v, plate, { chip = true } = {}) {
  const description = vehicleDescription(v);
  const tail = `<span class="vehicle-tail">${description ? '<span class="vehicle-sep" aria-hidden="true"> · </span>' : ''}<span class="${chip ? 'plate-chip' : 'vehicle-plate'}">${esc(plate)}</span></span>`;
  return `<span class="vehicle-line"><span class="vehicle-flow">${description ? `<span class="vehicle-desc">${esc(description)}</span>` : ''}${tail}</span></span>`;
}

function vehicleThumbs(v) {
  const thumbs = [thumbnailHtml(slots.get(slotId('plate', v.vid)))];
  if (rules.requireRegistration) thumbs.push(thumbnailHtml(slots.get(slotId('registration', v.vid))));
  thumbs.push(thumbnailHtml(slots.get(slotId('vehicle', v.vid))));
  const html = thumbs.join('');
  return html ? `<div class="row-thumbs">${html}</div>` : '';
}

function vehicleStatus(v) {
  return vehicleRowStatus(v, rules, { done: !!v.ref || vehicleDone(v) });
}

function renderVehicles() {
  const none = flow.vehicles.length === 0;
  const room = canAddVehicle(flow.vehicles.length, rules.cap);
  const rows = flow.vehicles.map((v, i) => {
    const name = displayPlate(v.plate) || S.vehicles.unnamed(i + 1);
    const hidden = `<span class="visually-hidden">${esc(S.vehicles.hiddenVehicle(name))}</span>`;
    const incomplete = !v.ref && !vehicleDone(v);
    return `
      <li class="vehicle-row" id="row-${v.vid}" tabindex="-1">
        <div class="row-main">
          ${vehicleLineHtml(v, name)}
          ${vehicleThumbs(v)}
          <span class="row-status${incomplete ? ' is-incomplete' : ''}">${esc(vehicleStatus(v))}</span>
        </div>
        ${v.ref ? '' : `
          <div class="row-actions">
            <button type="button" class="text-btn" data-change="${v.vid}">${esc(S.vehicles.change)}${hidden}</button>
            <button type="button" class="text-btn danger" data-remove="${v.vid}" aria-expanded="false" aria-controls="confirm-${v.vid}">${esc(S.vehicles.remove)}${hidden}</button>
          </div>
          <div class="confirm" id="confirm-${v.vid}" hidden>
            <p>${esc(S.vehicle.removeConfirm(displayPlate(v.plate)))}</p>
            <div class="confirm-actions">
              <button type="button" class="btn-secondary danger" data-remove-yes="${v.vid}">${esc(S.vehicle.removeYes)}</button>
              <button type="button" class="text-btn" data-remove-no="${v.vid}">${esc(S.vehicle.removeNo)}</button>
            </div>
          </div>`}
      </li>`;
  }).join('');
  let below = '';
  if (!none && room) {
    below = `
      <fieldset class="field vehicles-another" id="wrap-another" aria-describedby="another-error">
        <legend class="legend">${esc(S.vehicles.anotherLegend)}</legend>
        <p class="field-error" id="another-error" hidden></p>
        <div class="choice-cards is-inline">
          ${radio('another', 'yes', S.vehicles.yes, flow.another === 'yes')}
          ${radio('another', 'no', S.vehicles.no, flow.another === 'no')}
        </div>
      </fieldset>`;
  } else if (!none) {
    below = `<p class="cap-line">${ICONS.info}<span>${esc(S.vehicles.capReached(rules.cap))}</span></p>`;
  }
  app.innerHTML = `
    ${topBar()}
    <form id="residentForm" class="flow" data-step="vehicles" novalidate>
      ${stepHeader('vehicles', S.vehicles.title)}
      ${none ? `<p class="field-note" id="add-vehicle">${esc(S.vehicles.none)}</p>` : `<ul class="vehicle-list">${rows}</ul>`}
      ${below}
      ${actionsHtml(none ? S.vehicles.addVehicle : S.continue)}
    </form>`;
  bindForm(onContinue);
  for (const value of ['yes', 'no']) {
    const el = document.getElementById(`another-${value}`);
    if (!none && room && el) {
      el.addEventListener('change', () => {
        flow.another = value;
        saveNow();
        setInlineError('another-yes', null);
      });
    }
  }
  const form = document.getElementById('residentForm');
  form.addEventListener('click', (e) => {
    const t = e.target && e.target.closest ? e.target.closest('button') : null;
    if (!t) return;
    if (t.dataset.change) {
      show(`vehicle:${t.dataset.change}`, { mode: 'push' });
    } else if (t.dataset.remove) {
      const box = document.getElementById(`confirm-${t.dataset.remove}`);
      box.hidden = false;
      t.setAttribute('aria-expanded', 'true');
      box.querySelector('[data-remove-yes]').focus();
    } else if (t.dataset.removeNo) {
      document.getElementById(`confirm-${t.dataset.removeNo}`).hidden = true;
      const opener = form.querySelector(`[data-remove="${t.dataset.removeNo}"]`);
      opener.setAttribute('aria-expanded', 'false');
      opener.focus();
    } else if (t.dataset.removeYes) {
      flow = removeVehicle(flow, t.dataset.removeYes);
      forgetVehicleSlots(t.dataset.removeYes);
      saveNow();
      render('vehicles');
    }
  });
  setTitle(S.vehicles.title);
}

// ── S4 your ID and lease ────────────────────────────────────────────────────
function renderDocuments() {
  app.innerHTML = `
    ${topBar()}
    <form id="residentForm" class="flow" data-step="documents" novalidate>
      ${stepHeader('documents', S.documents.title)}
      <p class="intro">${esc(S.documents.intro)}</p>
      ${cardField('id')}
      ${cardField('lease')}
      <p class="privacy-line">${esc(S.documents.privacy)} <a class="text-link" href="/privacy.html">${esc(S.documents.privacyLink)}</a></p>
      ${actionsHtml(S.continue)}
    </form>`;
  bindForm(onContinue);
  mountCard('id', { title: S.documents.idTitle, makeSure: S.documents.idChecks, sizeLine: S.documents.size, schematic: 'id' });
  mountCard('lease', { title: S.documents.leaseTitle, makeSure: S.documents.leaseChecks, sizeLine: S.documents.size, schematic: 'lease' });
  setTitle(S.documents.title);
}

// ── S5 check your answers ───────────────────────────────────────────────────
function summaryRow({ id, key, value, goto, focusId, hidden, missing = false, className = '' }) {
  return `
    <div class="summary-row${className ? ` ${className}` : ''}" id="${esc(id)}" tabindex="-1">
      <dt>${esc(key)}</dt>
      <dd${missing ? ' class="is-missing"' : ''}>${value}</dd>
      <dd class="summary-action"><button type="button" class="text-btn" data-goto="${esc(goto)}"${focusId ? ` data-focus="${esc(focusId)}"` : ''}>${esc(S.review.change)}<span class="visually-hidden">${esc(hidden)}</span></button></dd>
    </div>`;
}

function reviewDocValue(id) {
  const state = stateOf(id);
  if (!isSatisfied(state)) return { html: esc(S.review.notAdded), missing: true };
  const label = state.status === 'restored' ? S.review.uploadedEarlier : S.review.uploaded;
  const size = state.file && state.file.size ? ` <span class="row-status">${esc(formatBytes(state.file.size))}</span>` : '';
  return { html: `${thumbnailHtml(slots.get(id))}<span>${esc(label)}</span>${size}`, missing: false };
}

function renderReview() {
  if (flow.returnTo) {
    flow.returnTo = null;
    saveNow();
  }
  const anySent = flow.vehicles.some((v) => v.ref);
  const anyUnsent = flow.vehicles.some((v) => !v.ref);
  const value = (text) => (text ? esc(text) : esc(S.review.notAdded));
  const about = [
    summaryRow({ id: 'review-name', key: S.review.name, value: value(flow.name.trim()), goto: 'about', focusId: 'name', hidden: S.review.hidden.name, missing: !flow.name.trim() }),
    summaryRow({ id: 'review-unit', key: S.review.unit, value: value(flow.unit.trim()), goto: 'about', focusId: 'unit', hidden: S.review.hidden.unit, missing: !flow.unit.trim() }),
    summaryRow({ id: 'review-phone', key: S.review.phone, value: value(formatPhone(flow.phone)), goto: 'about', focusId: 'phone', hidden: S.review.hidden.phone, missing: !flow.phone.trim() }),
    summaryRow({ id: 'review-email', key: S.review.email, value: value(flow.email.trim()), goto: 'about', focusId: 'email', hidden: S.review.hidden.email, missing: !flow.email.trim() }),
  ].join('');
  const vehicles = flow.vehicles.map((v, i) => {
    const name = displayPlate(v.plate) || S.vehicles.unnamed(i + 1);
    const incomplete = !v.ref && !vehicleDone(v);
    return `
      <div class="summary-row summary-vehicle" id="review-vehicle-${v.vid}" tabindex="-1">
        <dt>${vehicleLineHtml(v, name)}</dt>
        <dd>${vehicleThumbs(v)}<span class="row-status${incomplete ? ' is-incomplete' : ''}">${esc(vehicleStatus(v))}</span></dd>
        <dd class="summary-action">${v.ref ? '' : `<button type="button" class="text-btn" data-goto="vehicle:${v.vid}" data-focus="plate-${v.vid}">${esc(S.review.change)}<span class="visually-hidden">${esc(S.review.hidden.vehicle(name))}</span></button>`}</dd>
      </div>`;
  }).join('');
  const docRow = (id, key, hidden) => {
    const d = reviewDocValue(id);
    return summaryRow({ id: `review-${id}`, key, value: d.html, goto: 'documents', hidden, missing: d.missing, className: 'summary-doc' });
  };
  app.innerHTML = `
    ${topBar()}
    <form id="residentForm" class="flow" data-step="review" novalidate>
      ${stepHeader('review', S.review.title)}
      <section class="summary" aria-labelledby="sumAbout">
        <h2 class="summary-h2" id="sumAbout">${esc(S.review.aboutHeading)}</h2>
        <dl class="summary-list">${about}</dl>
      </section>
      <section class="summary" aria-labelledby="sumVehicles">
        <h2 class="summary-h2" id="sumVehicles">${esc(S.review.vehiclesHeading)}</h2>
        <dl class="summary-list" id="review-vehicles" tabindex="-1">${vehicles}</dl>
      </section>
      <section class="summary" aria-labelledby="sumDocs">
        <h2 class="summary-h2" id="sumDocs">${esc(S.review.documentsHeading)}</h2>
        <dl class="summary-list">${docRow('id', S.review.id, S.review.hidden.id)}${docRow('lease', S.review.lease, S.review.hidden.lease)}</dl>
      </section>
      <p class="statement">${esc(S.review.statement)}</p>
      <p class="attest">${esc(S.review.attest(flow.unit.trim()))}</p>
      ${actionsHtml(anySent && anyUnsent ? S.review.tryAgain : S.review.send)}
    </form>`;
  bindForm(onSend);
  document.getElementById('residentForm').addEventListener('click', (e) => {
    const t = e.target && e.target.closest ? e.target.closest('[data-goto]') : null;
    if (!t || sending) return;
    flow.returnTo = 'review';
    saveNow();
    show(t.dataset.goto, { mode: 'push', focusId: t.dataset.focus || null });
  });
  setTitle(S.review.title);
}

// ── S6 request received ─────────────────────────────────────────────────────
function renderReceived() {
  const r = flow.receipt;
  const rows = r.vehicles.map((v) => `
    <li class="receipt-vehicle">
      <dl>
        <dt>${esc(S.received.vehicle)}</dt><dd class="receipt-car">${vehicleLineHtml(v, v.plate, { chip: false })}</dd>
        <dt>${esc(S.received.reference)}</dt><dd data-ref>${esc(v.ref)}</dd>
      </dl>
      ${v.registrationSent ? '' : `<p class="receipt-note">${esc(S.received.registrationNotSent)}</p>`}
      ${v.vehiclePhotoSent === false ? `<p class="receipt-note">${esc(S.received.vehiclePhotoNotSent)}</p>` : ''}
      ${v.detailsSent === false ? `<p class="receipt-note">${esc(S.received.vehicleDetailsNotSent)}</p>` : ''}
    </li>`).join('');
  // The address in bold, so a typo is easy to spot (GOV.UK's confirmation page does the same).
  const [emailedBefore, emailedAfter] = S.received.emailed('\u0000').split('\u0000');
  app.innerHTML = `
    ${topBar()}
    <div class="flow" data-step="received">
      <section class="receipt" aria-labelledby="stepTitle">
        <span class="receipt-icon">${ICONS.check}</span>
        <h1 class="flow-h1" id="stepTitle" tabindex="-1">${esc(S.received.title)}</h1>
        <ul class="receipt-refs">${rows}</ul>
        <p class="receipt-status"><span class="status-tag">${esc(S.received.status)}</span></p>
        <p class="receipt-protected">${esc(S.received.protected)}</p>
        <p class="receipt-time">${esc(S.received.submitted(formatSubmitted(r.submittedAt)))}</p>
      </section>
      <section class="next" aria-labelledby="nextHeading">
        <h2 class="next-h2" id="nextHeading">${esc(S.received.nextHeading)}</h2>
        <ol class="next-list">${S.received.next.map((n) => `<li>${esc(n)}</li>`).join('')}</ol>
      </section>
      <section class="keep">
        ${r.email ? `<p class="receipt-email">${esc(emailedBefore)}<strong>${esc(r.email)}</strong>${esc(emailedAfter)}</p>` : ''}
        <p>${esc(S.received.keep)}</p>
        <button type="button" class="btn-secondary" id="copyRefBtn">${esc(S.received.copy(r.vehicles.length))}</button>
      </section>
      <p class="received-links"><a class="text-link" href="${esc(aptEntryUrl(qrCodeId, 'guest'))}">${esc(S.received.shortTerm)}</a></p>
      <p class="received-links"><button type="button" class="text-btn" id="startOverBtn">${esc(S.received.startOver)}</button></p>
    </div>`;
  document.getElementById('copyRefBtn').addEventListener('click', copyReference);
  document.getElementById('startOverBtn').addEventListener('click', () => {
    flow = emptyFlow();
    slots.clear();
    saveNow();
    show('start', { mode: 'push' });
  });
  setTitle(S.received.title);
}

async function copyReference() {
  const r = flow && flow.receipt;
  if (!r) return;
  const text = copyText(r);
  let ok = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch { ok = false; }
  if (!ok) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  const status = document.getElementById('pageStatus');
  const btn = document.getElementById('copyRefBtn');
  if (ok && btn) {
    btn.textContent = S.received.copied(r.vehicles.length);
    if (status) status.textContent = S.received.copied(r.vehicles.length);
    setTimeout(() => {
      if (document.getElementById('copyRefBtn') === btn) btn.textContent = S.received.copy(r.vehicles.length);
    }, 2500);
  } else {
    // Clipboard refused: select the references so the resident can copy them by hand.
    const refs = document.querySelector('.receipt-refs');
    const selection = window.getSelection && window.getSelection();
    if (refs && selection) {
      const range = document.createRange();
      range.selectNodeContents(refs);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }
}

// ── Continue ────────────────────────────────────────────────────────────────
function slotIdsFor(key) {
  const p = parseStep(key);
  if (!p) return [];
  if (p.name === 'vehicle') {
    return VEHICLE_KINDS.filter((kind) => kind !== 'registration' || rules.requireRegistration).map((kind) => slotId(kind, p.vid));
  }
  if (p.name === 'documents') return ['id', 'lease'];
  if (p.name === 'review') return Object.keys(docRefs(flow, rules));
  return [];
}

/** Continue while a card is still uploading: "Finishing upload…", then carry on by itself. */
async function waitForUploads(key) {
  const busy = slotIdsFor(key).map((id) => slots.get(id)).filter((s) => s && isBusy(s.state));
  if (!busy.length) return true;
  const token = ++continueToken;
  const btn = document.getElementById('continueBtn');
  const label = btn.textContent;
  btn.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>${esc(S.finishing)}</span>`;
  await Promise.all(busy.map((s) => s.settled()));
  if (token !== continueToken || screen !== key) return false;
  btn.textContent = label;
  return true;
}

function titleFor(key) {
  const p = parseStep(key);
  switch (p && p.name) {
    case 'start': return S.start.title;
    case 'about': return S.about.title;
    case 'vehicle': return S.vehicle.title(flow.vehicles.findIndex((v) => v.vid === p.vid) + 1);
    case 'vehicles': return S.vehicles.title;
    case 'documents': return S.documents.title;
    case 'review': return S.review.title;
    default: return S.received.title;
  }
}

async function onContinue(e) {
  if (e && typeof e.preventDefault === 'function') e.preventDefault();
  const key = screen;
  if (!(await waitForUploads(key))) return;
  const zeroVehicles = key === 'vehicles' && flow.vehicles.length === 0;
  const errors = zeroVehicles ? [] : validateStep(key, flow, { ...rules, docStates: docStatesNow() });
  if (errors.length) {
    showErrors(errors, titleFor(key));
    return;
  }
  hideErrorSummary();
  saveNow();
  let next = nextStep(key, flow, rules);
  if (next === 'short-term') {
    show('guest', { mode: 'push' });
    return;
  }
  if (next === 'vehicle:new') {
    const added = addVehicle(flow);
    flow = added.flow;
    next = `vehicle:${added.vid}`;
  }
  show(next, { mode: 'push' });
}

// ── Send for review ─────────────────────────────────────────────────────────
function setSending(on) {
  const btn = document.getElementById('continueBtn');
  if (!btn) return;
  if (on) {
    btn.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>${esc(S.review.sending)}</span>`;
    btn.setAttribute('aria-disabled', 'true');
  } else {
    btn.removeAttribute('aria-disabled');
  }
}

function payloadFor(v) {
  return {
    property_id: property.id,
    plate_text: normalizePlate(v.plate),
    holder_name: flow.name.trim(),
    holder_role: 'resident',
    unit_number: flow.unit.trim(),
    phone: phoneToE164(flow.phone) || normalizePhone(flow.phone),
    email: flow.email.trim(),
    id_doc_url: flow.docs.id ? flow.docs.id.key : null,
    lease_doc_url: flow.docs.lease ? flow.docs.lease.key : null,
    plate_photo_url: v.docs.plate ? v.docs.plate.key : null,
  };
}

/** One vehicle → one pending request. Each call mints its own reCAPTCHA token. */
async function registerVehicle(v) {
  const extra = { ...docFields(v, rules), ...vehicleFields(v) };
  const send = async (fields) => backendRegister('/resident_plates/register',
    { ...payloadFor(v), ...fields, recaptcha_token: await mintToken('plate_register') }, 15000);
  try {
    return { result: await send(extra), ...sentFlags(v, rules) };
  } catch (err) {
    const dropped = rejectedUnknownFields(err, Object.keys(extra));
    if (!dropped.length) throw err;
    // TEMPORARY (remove once backend tasks B1, B3 and B4 are live): an older
    // backend's model forbids a field it does not have yet (the registration
    // card, the vehicle photo, the make, model and color), so send the request
    // once more without it; the receipt says what did not go.
    console.warn(`register: this backend does not accept ${dropped.join(', ')} yet; sent without ${dropped.length > 1 ? 'them' : 'it'} until it does`);
    const fields = Object.fromEntries(Object.entries(extra).filter(([name]) => !dropped.includes(name)));
    return { result: await send(fields), ...sentFlags(v, rules, dropped) };
  }
}

const reviewFieldFor = (id) => (id.includes(':') ? `review-vehicle-${id.split(':')[1]}` : `review-${id}`);

async function onSend(e) {
  if (e && typeof e.preventDefault === 'function') e.preventDefault();
  if (sending) return;
  if (!(await waitForUploads('review'))) return;
  const errors = validateStep('review', flow, { ...rules, docStates: docStatesNow() });
  if (errors.length) {
    showErrors(errors, S.review.title);
    return;
  }
  sending = true;
  hideErrorSummary();
  setSending(true);
  const refs = {};
  const registrationSent = {};
  const vehiclePhotoSent = {};
  const detailsSent = {};
  let current = null;
  try {
    for (const v of flow.vehicles) {
      current = v;
      if (!v.ref) {
        const sent = await registerVehicle(v);
        const result = sent.result;
        v.ref = String((result && (result.reference_id || String(result.id || '').slice(-8))) || '').toUpperCase();
        v.registrationSent = sent.registrationSent;
        v.vehiclePhotoSent = sent.vehiclePhotoSent;
        v.detailsSent = sent.detailsSent;
        saveNow(); // a vehicle that landed is never sent twice
      }
      refs[v.vid] = v.ref;
      registrationSent[v.vid] = v.registrationSent !== false;
      vehiclePhotoSent[v.vid] = v.vehiclePhotoSent;
      detailsSent[v.vid] = v.detailsSent !== false;
    }
  } catch (err) {
    sending = false;
    reportSendError(err, current);
    return;
  }
  sending = false;
  flow = receiptFlow(flow, { now: Date.now(), refs, registrationSent, vehiclePhotoSent, detailsSent });
  slots.clear();
  saveNow();
  show('received', { mode: 'push' });
}

function reportSendError(err, v) {
  const plate = v ? displayPlate(v.plate) : '';
  const m = registerErrorMessage(err, { unit: flow.unit.trim(), plate, limit: rules.cap, vid: v ? v.vid : null, phone: officePhone() });
  let field = m.field;
  if (m.code === 'invalid_document') {
    // Ask again for the key the backend refused (or, when none looks wrong, this vehicle's and the shared two).
    const scoped = Object.fromEntries(Object.entries(docRefs(flow, rules))
      .filter(([id]) => !id.includes(':') || (v && id.endsWith(`:${v.vid}`))));
    const bad = invalidDocSlots(scoped, property.id);
    for (const id of bad) {
      const slot = slots.get(id);
      if (slot) slot.remove();
      setDocRef(id, null);
    }
    saveNow();
    field = bad.length ? reviewFieldFor(bad[0]) : null;
  }
  let message = m.message;
  const partial = flow.vehicles.some((x) => x.ref);
  if (partial && plate && !['unit_vehicle_limit', 'duplicate_registration'].includes(m.code)) {
    message = `${S.errors.notSent(plate)} ${message}`;
  }
  if (v && field && ['vehicle_required', 'vehicle_color_invalid'].includes(m.code)) {
    // The make, model and color are asked for on the vehicle's own step, not on
    // S5: go there, say what the office needs, and put the cursor in the first
    // field it named. Continue then returns to S5.
    flow.returnTo = 'review';
    saveNow();
    show(`vehicle:${v.vid}`, { mode: 'push', focusId: field });
    showErrors([{ field, message }], titleFor(screen), { focusSummary: false });
    return;
  }
  render('review');
  showErrors([{ field: field || 'continueBtn', message }], S.review.title);
}

// ── the short-term form (restyled only: same fields, same submit) ──────────
function showGuestForm() {
  idempotencyKey = newIdempotencyKey();
  const hourOptions = [2, 4, 8, 12, 24, 48, 72].map(h => {
    const sel = h === 24 ? ' selected' : '';
    const label = h < 24 ? `${h} hours` : `${h / 24} day${h > 24 ? 's' : ''}`;
    return `<option value="${h}"${sel}>${label}${h === 72 ? ' (maximum)' : ''}</option>`;
  });
  app.innerHTML = `
    ${logoHtml()}
    <div class="property-name">
      Registration<br>
      <strong>${escapeHtml(property.name)}</strong>
    </div>
    <form id="guestForm">
      <label for="g_name">Full name</label>
      <input type="text" id="g_name" placeholder="Jane Smith" required maxlength="80" autocomplete="name" autocapitalize="words">

      <label for="g_unit">Unit you're visiting</label>
      <input type="text" id="g_unit" placeholder="e.g. 214" required maxlength="20" autocomplete="off">

      <label for="g_phone">Phone number</label>
      <input type="tel" id="g_phone" placeholder="(555) 123-4567" required autocomplete="tel" inputmode="tel">

      <label for="g_email">Email</label>
      <input type="email" id="g_email" placeholder="you@example.com" required autocomplete="email" inputmode="email" autocapitalize="off" spellcheck="false">

      <label for="g_plate">License plate</label>
      <input type="text" id="g_plate" class="plate-input" placeholder="ABC 1234" required maxlength="10" autocomplete="off" autocapitalize="characters" spellcheck="false">

      ${textField({ id: 'g_make', label: S.vehicle.makeLabel, value: '', wrapClass: 'vehicle-field', attrs: `${VEHICLE_TEXT_ATTRS} list="vehicle-makes" aria-required="true"`, after: makeSuggestions() })}
      ${textField({ id: 'g_model', label: S.vehicle.modelLabel, value: '', wrapClass: 'vehicle-field', attrs: `${VEHICLE_TEXT_ATTRS} aria-required="true"` })}
      ${colorField({ id: 'g_color', label: S.vehicle.colorLabel, value: '', wrapClass: 'vehicle-field', attrs: 'aria-required="true"' })}

      <label for="g_plate_photo">Photo of the plate</label>
      <input type="file" id="g_plate_photo" accept="image/*,application/pdf" aria-describedby="g_plate_photo_hint">
      <div class="file-hint" id="g_plate_photo_hint">Photo of the plate. Choose from your library or files.</div>

      <label for="g_id">Photo ID</label>
      <input type="file" id="g_id" accept="image/*,application/pdf" aria-describedby="g_id_hint">
      <div class="file-hint" id="g_id_hint">Government-issued photo ID.</div>

      <label for="g_hours">How long will you be here?</label>
      <select id="g_hours" required>${hourOptions.join('')}</select>

      <label class="check-row" for="g_temp_tag">
        <input type="checkbox" id="g_temp_tag">
        <span class="check-label">Paper tag</span>
      </label>
      <div class="temp-tag-detail hidden" id="g_temp_tag_detail">
        <label for="g_tag_exp">Tag expiry date <span class="optional">(optional)</span></label>
        <input type="date" id="g_tag_exp" aria-describedby="g_tag_exp_hint">
        <div class="file-hint" id="g_tag_exp_hint">Leave blank and we'll assume 30 days.</div>
      </div>

      <button type="submit" class="submit-btn" id="submitBtn">Get my pass →</button>
      <div class="form-note">Maximum stay: 72 hours</div>
      <div id="progressMsg" class="progress" role="status" aria-atomic="true"></div>
      <div id="errorMsg" role="alert"></div>
    </form>
    <button type="button" class="back-link" id="backLink">Back</button>
  `;

  document.getElementById('guestForm').addEventListener('submit', handleGuestSubmit);
  document.getElementById('backLink').addEventListener('click', goBack);
  // The make, model and color are checked here with the long-term form's words;
  // an error clears as soon as the field is fixed. This form keeps no answers.
  for (const field of ['make', 'model', 'color']) bindField(`g_${field}`, field, () => {}, { persist: false });

  // Reveal the optional expiry date only when the temp-tag box is checked.
  const tempTagBox = document.getElementById('g_temp_tag');
  const tempTagDetail = document.getElementById('g_temp_tag_detail');
  tempTagBox.addEventListener('change', () => {
    tempTagDetail.classList.toggle('hidden', !tempTagBox.checked);
    if (!tempTagBox.checked) document.getElementById('g_tag_exp').value = '';
  });
  setTitle(S.titleSuffix);
}

let idempotencyKey = null;

function setProgress(text) {
  const el = document.getElementById('progressMsg');
  if (el) el.textContent = text || '';
}

/** The make, model and color problems an error carries: ours (found before anything was sent) or the backend's two answers. */
function guestVehicleProblems(err) {
  if (err && err.vehicleProblems) return err.vehicleProblems;
  const answer = vehicleBackendError(err);
  return answer ? [{ field: answer.field, message: answer.message }] : null;
}

/** Say what is missing next to each field, and put the cursor in the first one. */
function showGuestVehicleProblems(problems) {
  for (const p of problems) setInlineError(`g_${p.field}`, p.message);
  const first = document.getElementById(`g_${problems[0].field}`);
  if (first) first.focus();
}

let guestSubmitting = false;

async function handleGuestSubmit(e) {
  e.preventDefault();
  if (guestSubmitting) return;
  guestSubmitting = true;
  const btn = document.getElementById('submitBtn');
  const errorDiv = document.getElementById('errorMsg');
  errorDiv.innerHTML = '';
  btn.disabled = true;
  btn.textContent = 'Submitting…';

  try {
    const visitorName = document.getElementById('g_name').value.trim();
    const hostUnit = document.getElementById('g_unit').value.trim();
    const phone = normalizePhone(document.getElementById('g_phone').value);
    const email = document.getElementById('g_email').value.trim();
    const plateText = normalizePlate(document.getElementById('g_plate').value);
    const vehicle = {
      make: normalizeVehicleText(document.getElementById('g_make').value),
      model: normalizeVehicleText(document.getElementById('g_model').value),
      color: document.getElementById('g_color').value,
    };
    const stayHours = parseInt(document.getElementById('g_hours').value, 10);
    const isTempTag = document.getElementById('g_temp_tag').checked;
    const tagExpRaw = document.getElementById('g_tag_exp').value;
    const tagExpiration = (isTempTag && tagExpRaw) ? tagExpRaw : null;

    if (!visitorName) throw new Error('Please enter your full name.');
    if (!hostUnit) throw new Error('Please enter the unit you are visiting.');
    if (!phone || phone.length < 11) throw new Error('Please enter a valid phone number.');
    if (!email) throw new Error('Please enter your email.');
    if (!plateText || plateText.length < 2) throw new Error('Please enter a valid license plate number.');
    const vehicleProblems = vehicleFieldErrors(vehicle);
    if (vehicleProblems.length) throw Object.assign(new Error(vehicleProblems[0].message), { vehicleProblems });
    if (!stayHours || stayHours < 1 || stayHours > 72) throw new Error('Choose how long you will be parked (1–72 hours).');

    const plateInput = document.getElementById('g_plate_photo');
    const idInput = document.getElementById('g_id');
    const platePhotoFile = plateInput.files && plateInput.files[0];
    const idFile = idInput.files && idInput.files[0];
    if (!platePhotoFile) throw new Error('Please attach a plate photo.');
    if (!idFile) throw new Error('Please attach a photo of your ID.');

    setProgress('Uploading plate photo…');
    const platePhotoUrl = await uploadFile(platePhotoFile, 'plate');
    setProgress('Uploading ID…');
    const idPhotoUrl = await uploadFile(idFile, 'id');

    setProgress('Submitting…');
    const recaptchaToken = await getRecaptchaToken('pass_register').catch(() => null);
    if (!recaptchaToken) throw new Error('Please retry — automated-access check failed.');

    const result = await backendRegister('/visitor_passes/register', {
      property_id: property.id,
      plate_text: plateText,
      ...vehicleFields(vehicle),
      visitor_name: visitorName,
      host_unit: hostUnit,
      phone: phone,
      email: email,
      id_photo_url: idPhotoUrl,
      plate_photo_url: platePhotoUrl,
      stay_hours: stayHours,
      is_temp_tag: isTempTag,
      tag_expiration: tagExpiration,
      submission_idempotency_key: idempotencyKey,
      recaptcha_token: recaptchaToken,
    }, 15000);

    setProgress('');
    const refId = (result && result.reference_id ? result.reference_id.toString().toUpperCase() : null);
    showSuccess({ refId, validUntil: result && result.valid_until ? result.valid_until : null, plate: result && result.plate_text ? result.plate_text : null });
  } catch (err) {
    setProgress('');
    const problems = guestVehicleProblems(err);
    if (problems) showGuestVehicleProblems(problems);
    else errorDiv.innerHTML = '<div class="error">' + escapeHtml(friendlyErrorMessage(err)) + '</div>';
    btn.disabled = false;
    btn.textContent = 'Get my pass →';
    guestSubmitting = false;
  }
}

// The short-term form's confirmation (the long-term request has its own receipt, S6).
function showSuccess(opts) {
  const refId = opts && opts.refId;
  const validUntil = opts && opts.validUntil;
  const plate = opts && opts.plate;
  // A returned validity window means the property auto-approves: the pass
  // is LIVE — say so. No window = the classic review flow.
  const live = !!validUntil;
  const untilText = live ? new Date(validUntil).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;
  app.innerHTML = `
    <div class="success-card">
      <div class="success-icon">
        <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
      </div>
      ${live ? `
        <h2>You're <em>parked.</em></h2>
        <p>Your parking pass for <em>${escapeHtml(property.name)}</em> is active${plate ? ` for plate <strong>${escapeHtml(plate)}</strong>` : ''}. No further steps — your plate is your pass.</p>
        <div class="success-ref">Valid until ${escapeHtml(untilText)}</div>
        ${refId ? `<div class="success-detail">Ref ${escapeHtml(refId)}. Save this in case you need to call.</div>` : ''}
      ` : `
        <h2>Request <em>submitted.</em></h2>
        <p>Your registration for <em>${escapeHtml(property.name)}</em> is in. The leasing office or towing company will review it — you'll be notified.</p>
        ${refId ? `<div class="success-ref">${escapeHtml(refId)}</div>` : ''}
        <div class="pending-badge">Pending approval</div>
      `}
    </div>
  `;
}

// ── page-wide listeners ─────────────────────────────────────────────────────
if (typeof window.addEventListener === 'function') {
  window.addEventListener('popstate', onPopState);
  window.addEventListener('online', () => { for (const slot of slots.values()) slot.online(); });
  window.addEventListener('pagehide', saveNow);
  // `load` waits for the async reCAPTCHA script to load or fail: if it is
  // missing then, a content blocker stopped it and nothing can be sent.
  window.addEventListener('load', () => { if (!recaptchaPresent()) showBlocked(); });
}
try {
  if (window.history && 'scrollRestoration' in window.history) window.history.scrollRestoration = 'manual';
} catch { /* not supported */ }

init();
