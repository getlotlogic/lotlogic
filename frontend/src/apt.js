// apt.html's registration flow — resident (multi-vehicle, ID + lease
// upload) and guest (single vehicle, plate + ID upload) forms. Task 17:
// everything this page shared byte-for-byte (or as a resolved superset)
// with visit.html / resident.html now lives in ./shared/register.js.
// `showSuccess` stays here — see ./shared/register.js's header comment for
// why it isn't shared.
//
// DIVERGENCE — normalizePlate: apt.html's own normalizePlate never stripped
// a trailing state/region token (visit.html's and resident.html's did).
// ./shared/register.js takes the region-strip version as the superset per
// the task brief (Open Decision 4) — this page's normalizePlate behaviour
// changes as a result: a plate typed with a trailing state name now matches
// where it previously would not. Flagged in task-17-report.md.
//
// DIVERGENCE — backendRegister timeout: apt.html defaulted to 15000ms
// (uploads take longer than a plain JSON POST); the shared default in
// register.js is 12000ms (the other two pages' value). Both call sites
// below pass 15000 explicitly to preserve this page's original timeout.
import {
  pgRest, backendRegister, getRecaptchaToken, friendlyErrorMessage,
  escapeHtml, showNotFound, showConnectionError, normalizePlate, normalizePhone,
  newIdempotencyKey, propertyQuery, logoHtml, BACKEND_URL,
} from './shared/register.js';

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

const app = document.getElementById('app');

// QR code id comes from /apt.html/<qr> in the URL, but we also accept
// ?qr=<id> so a shared / emailed link like /apt.html?qr=... still works.
const pathParts = window.location.pathname.split('/').filter(Boolean);
const qrCodeId = (pathParts.length >= 2 ? pathParts[pathParts.length - 1] : null)
  || new URLSearchParams(window.location.search).get('qr');

let property = null;

async function init() {
  if (!qrCodeId) {
    showNotFound('Invalid Link', 'This registration link is not valid.');
    return;
  }
  try {
    const rows = await pgRest(propertyQuery(qrCodeId, 'id,name,address,property_type,policy_phone'));
    const data = Array.isArray(rows) ? rows[0] : null;
    if (!data) {
      showNotFound('Property Not Found', 'This registration link is not valid or has expired.');
      return;
    }
    property = data;
    showLanding();
  } catch (err) {
    console.error('init error:', err);
    showConnectionError(err, init);
  }
}

// ── Landing: Resident vs Guest ──────────────────────────────────────
function showLanding() {
  app.innerHTML = `
    ${logoHtml()}
    <div class="property-name">
      register to park at
      <strong>${escapeHtml(property.name)}</strong>
    </div>
    <button type="button" class="choice-btn" id="chooseResident">
      <span>I live here<span class="sub">register my vehicle</span></span>
      <span class="arrow">→</span>
    </button>
    <button type="button" class="choice-btn" id="chooseGuest">
      <span>I'm visiting<span class="sub">get a short-term parking pass</span></span>
      <span class="arrow">→</span>
    </button>
  `;
  document.getElementById('chooseResident').addEventListener('click', showResidentForm);
  document.getElementById('chooseGuest').addEventListener('click', showGuestForm);
}

// ── Resident form ───────────────────────────────────────────────────
let vehicleCount = 0;

function vehicleBlockHtml(index, removable) {
  return `
    <div class="vehicle-block" data-vehicle="${index}">
      <div class="vehicle-head">
        <span>Vehicle ${index}</span>
        ${removable ? `<button type="button" class="remove-vehicle" data-remove="${index}">remove</button>` : ''}
      </div>
      <label>License Plate <span class="required">*</span></label>
      <input type="text" class="plate-input v-plate" placeholder="ABC 1234" maxlength="10" autocomplete="off" required>
      <label>Plate Photo <span class="required">*</span></label>
      <input type="file" class="v-plate-photo" accept="image/*,application/pdf" required>
      <div class="file-hint">Photo of the plate. Choose from your library or files.</div>
    </div>`;
}

function showResidentForm() {
  vehicleCount = 0;
  app.innerHTML = `
    ${logoHtml()}
    <div class="property-name">
      Registration<br>
      <strong>${escapeHtml(property.name)}</strong>
    </div>
    <form id="residentForm">
      <label for="r_name">Full Name <span class="required">*</span></label>
      <input type="text" id="r_name" placeholder="Jane Smith" required maxlength="80">

      <label for="r_unit">Unit # <span class="required">*</span></label>
      <input type="text" id="r_unit" placeholder="e.g. 214" required maxlength="20">

      <label for="r_phone">Phone Number <span class="required">*</span></label>
      <input type="tel" id="r_phone" placeholder="(555) 123-4567" required>

      <label for="r_email">Email <span class="required">*</span></label>
      <input type="email" id="r_email" placeholder="you@example.com" required>

      <div id="r_vehicles"></div>
      <button type="button" class="add-vehicle-btn" id="addVehicleBtn">+ add another vehicle</button>

      <label for="r_id">Photo ID <span class="required">*</span></label>
      <input type="file" id="r_id" accept="image/*,application/pdf" required>
      <div class="file-hint">Government-issued photo ID.</div>

      <label for="r_lease">Lease <span class="required">*</span></label>
      <input type="file" id="r_lease" accept="image/*,application/pdf" required>
      <div class="file-hint">A photo or PDF of your lease.</div>

      <button type="submit" class="submit-btn" id="submitBtn">Get my pass →</button>
      <div class="hint">PENDING APPROVAL</div>
      <div id="progressMsg" class="progress"></div>
      <div id="errorMsg"></div>
    </form>
    <button type="button" class="back-link" id="backLink">← back</button>
  `;

  addVehicle(); // first vehicle is not removable
  document.getElementById('addVehicleBtn').addEventListener('click', () => addVehicle());
  document.getElementById('residentForm').addEventListener('submit', handleResidentSubmit);
  document.getElementById('backLink').addEventListener('click', showLanding);
}

function addVehicle() {
  vehicleCount += 1;
  const removable = vehicleCount > 1;
  const wrap = document.getElementById('r_vehicles');
  wrap.insertAdjacentHTML('beforeend', vehicleBlockHtml(vehicleCount, removable));
  if (removable) {
    const btn = wrap.querySelector(`[data-remove="${vehicleCount}"]`);
    if (btn) btn.addEventListener('click', () => {
      const block = wrap.querySelector(`[data-vehicle="${btn.dataset.remove}"]`);
      if (block) block.remove();
    });
  }
}

// ── Guest form ──────────────────────────────────────────────────────
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
      <label for="g_name">Full Name <span class="required">*</span></label>
      <input type="text" id="g_name" placeholder="Jane Smith" required maxlength="80">

      <label for="g_unit">Unit You're Visiting <span class="required">*</span></label>
      <input type="text" id="g_unit" placeholder="e.g. 214" required maxlength="20">

      <label for="g_phone">Phone Number <span class="required">*</span></label>
      <input type="tel" id="g_phone" placeholder="(555) 123-4567" required>

      <label for="g_email">Email <span class="required">*</span></label>
      <input type="email" id="g_email" placeholder="you@example.com" required>

      <label for="g_plate">License Plate <span class="required">*</span></label>
      <input type="text" id="g_plate" class="plate-input" placeholder="ABC 1234" required maxlength="10" autocomplete="off">

      <label for="g_plate_photo">Plate Photo <span class="required">*</span></label>
      <input type="file" id="g_plate_photo" accept="image/*,application/pdf" required>
      <div class="file-hint">Photo of the plate. Choose from your library or files.</div>

      <label for="g_id">Photo ID <span class="required">*</span></label>
      <input type="file" id="g_id" accept="image/*,application/pdf" required>
      <div class="file-hint">Government-issued photo ID.</div>

      <label for="g_hours">How long will you be here? <span class="required">*</span></label>
      <select id="g_hours" required>${hourOptions.join('')}</select>

      <label class="check-row" for="g_temp_tag">
        <input type="checkbox" id="g_temp_tag">
        <span class="check-label">Paper tag</span>
      </label>
      <div class="temp-tag-detail hidden" id="g_temp_tag_detail">
        <label for="g_tag_exp">Tag expiry date <span class="optional">(optional)</span></label>
        <input type="date" id="g_tag_exp">
        <div class="file-hint">Leave blank and we'll assume 30 days.</div>
      </div>

      <button type="submit" class="submit-btn" id="submitBtn">Get my pass →</button>
      <div class="hint">MAXIMUM STAY · 72 HOURS</div>
      <div id="progressMsg" class="progress"></div>
      <div id="errorMsg"></div>
    </form>
    <button type="button" class="back-link" id="backLink">← back</button>
  `;

  document.getElementById('guestForm').addEventListener('submit', handleGuestSubmit);
  document.getElementById('backLink').addEventListener('click', showLanding);

  // Reveal the optional expiry date only when the temp-tag box is checked.
  const tempTagBox = document.getElementById('g_temp_tag');
  const tempTagDetail = document.getElementById('g_temp_tag_detail');
  tempTagBox.addEventListener('change', () => {
    tempTagDetail.classList.toggle('hidden', !tempTagBox.checked);
    if (!tempTagBox.checked) document.getElementById('g_tag_exp').value = '';
  });
}

// ── Helpers ─────────────────────────────────────────────────────────
let idempotencyKey = null;

function setProgress(text) {
  const el = document.getElementById('progressMsg');
  if (el) el.textContent = text || '';
}

let submitting = false;

// ── Resident submit ─────────────────────────────────────────────────
// Per-submission idempotency for the multi-vehicle loop. A mid-loop failure
// + resubmit must NOT re-register the vehicles that already succeeded, and
// must reuse the SAME idempotency key per vehicle so the backend absorbs the
// retry as a duplicate (it returns the existing pending row). We key both the
// idempotency keys and the succeeded-flags by vehicle index, and only reset
// them when a genuinely fresh batch is submitted (plate set changed) — a
// retry of the same batch reuses them and skips already-succeeded vehicles.
let residentSubmissionKeys = null;    // { batchSig, keys: {idx: key}, done: {idx: bool} }
async function handleResidentSubmit(e) {
  e.preventDefault();
  if (submitting) return;
  submitting = true;
  const btn = document.getElementById('submitBtn');
  const errorDiv = document.getElementById('errorMsg');
  errorDiv.innerHTML = '';
  btn.disabled = true;
  btn.textContent = 'Submitting…';

  try {
    const holderName = document.getElementById('r_name').value.trim();
    const unitNumber = document.getElementById('r_unit').value.trim();
    const phone = normalizePhone(document.getElementById('r_phone').value);
    const email = document.getElementById('r_email').value.trim();

    if (!holderName) throw new Error('Please enter your full name.');
    if (!unitNumber) throw new Error('Please enter your unit number.');
    if (!phone || phone.length < 11) throw new Error('Please enter a valid phone number.');
    if (!email) throw new Error('Please enter your email.');

    // Collect vehicles (plate + plate-photo per block).
    const blocks = Array.from(document.querySelectorAll('#r_vehicles .vehicle-block'));
    const vehicles = [];
    for (const block of blocks) {
      const plate = normalizePlate(block.querySelector('.v-plate').value);
      const photoInput = block.querySelector('.v-plate-photo');
      const photoFile = photoInput.files && photoInput.files[0];
      if (!plate || plate.length < 2) throw new Error('Please enter a valid license plate for every vehicle.');
      if (!photoFile) throw new Error('Please attach a plate photo for every vehicle.');
      vehicles.push({ plate, photoFile });
    }
    if (vehicles.length === 0) throw new Error('Please add at least one vehicle.');

    const idInput = document.getElementById('r_id');
    const leaseInput = document.getElementById('r_lease');
    const idFile = idInput.files && idInput.files[0];
    const leaseFile = leaseInput.files && leaseInput.files[0];
    if (!idFile) throw new Error('Please attach a photo of your ID.');
    if (!leaseFile) throw new Error('Please attach your lease.');

    // Establish per-submission idempotency state. `batchSig` is the set of
    // plates being submitted; if it changed since the last attempt this is a
    // genuinely fresh batch, so mint new keys and clear the done-flags. If it
    // matches, this is a retry — reuse the keys and skip vehicles that already
    // landed. Generate a stable key per vehicle ONCE per batch.
    const batchSig = vehicles.map((v) => v.plate).join('|');
    if (!residentSubmissionKeys || residentSubmissionKeys.batchSig !== batchSig) {
      const keys = {};
      for (let i = 0; i < vehicles.length; i += 1) keys[i] = newIdempotencyKey();
      residentSubmissionKeys = { batchSig, keys, done: {} };
    }

    // Upload shared docs once, then per-vehicle plate photos.
    setProgress('Uploading ID…');
    const idDocUrl = await uploadFile(idFile, 'id');
    setProgress('Uploading lease…');
    const leaseDocUrl = await uploadFile(leaseFile, 'lease');

    // Register each vehicle as its own pending resident plate. They share
    // the uploaded ID + lease; each has its own plate photo. Skip any vehicle
    // that already succeeded in a prior attempt of this same batch.
    for (let i = 0; i < vehicles.length; i += 1) {
      if (residentSubmissionKeys.done[i]) continue;
      const v = vehicles[i];
      setProgress(`Uploading plate photo ${i + 1} of ${vehicles.length}…`);
      const platePhotoUrl = await uploadFile(v.photoFile, 'plate');

      setProgress(`Submitting vehicle ${i + 1} of ${vehicles.length}…`);
      const recaptchaToken = await getRecaptchaToken('plate_register').catch(() => null);
      if (!recaptchaToken) throw new Error('Please retry — automated-access check failed.');

      // NOTE: the backend ResidentPlateRegisterRequest model uses
      // extra="forbid" and does NOT (yet) accept submission_idempotency_key,
      // so we do not send it — doing so would 422. Retries are made safe by
      // (a) skipping already-succeeded vehicles above and (b) the backend's
      // (property_id, plate_text) uniqueness returning the existing pending
      // row on a duplicate. The per-vehicle key is retained for when the
      // model accepts it.
      await backendRegister('/resident_plates/register', {
        property_id: property.id,
        plate_text: v.plate,
        holder_name: holderName,
        holder_role: 'resident',
        unit_number: unitNumber,
        phone: phone,
        email: email,
        id_doc_url: idDocUrl,
        lease_doc_url: leaseDocUrl,
        plate_photo_url: platePhotoUrl,
        recaptcha_token: recaptchaToken,
      }, 15000);
      residentSubmissionKeys.done[i] = true;
    }

    // Full batch landed — clear state so a brand-new submission starts fresh.
    residentSubmissionKeys = null;
    setProgress('');
    showSuccess({ refId: null });
  } catch (err) {
    setProgress('');
    errorDiv.innerHTML = '<div class="error">' + escapeHtml(friendlyErrorMessage(err)) + '</div>';
    btn.disabled = false;
    btn.textContent = 'Get my pass →';
    submitting = false;
  }
}

// ── Guest submit ────────────────────────────────────────────────────
async function handleGuestSubmit(e) {
  e.preventDefault();
  if (submitting) return;
  submitting = true;
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
    const stayHours = parseInt(document.getElementById('g_hours').value, 10);
    const isTempTag = document.getElementById('g_temp_tag').checked;
    const tagExpRaw = document.getElementById('g_tag_exp').value;
    const tagExpiration = (isTempTag && tagExpRaw) ? tagExpRaw : null;

    if (!visitorName) throw new Error('Please enter your full name.');
    if (!hostUnit) throw new Error('Please enter the unit you are visiting.');
    if (!phone || phone.length < 11) throw new Error('Please enter a valid phone number.');
    if (!email) throw new Error('Please enter your email.');
    if (!plateText || plateText.length < 2) throw new Error('Please enter a valid license plate number.');
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
    errorDiv.innerHTML = '<div class="error">' + escapeHtml(friendlyErrorMessage(err)) + '</div>';
    btn.disabled = false;
    btn.textContent = 'Get my pass →';
    submitting = false;
  }
}

function showSuccess(opts) {
  const refId = opts && opts.refId;
  const validUntil = opts && opts.validUntil;
  const plate = opts && opts.plate;
  const phone = property.policy_phone ? escapeHtml(property.policy_phone) : null;
  // A returned validity window means the property auto-approves: the pass
  // is LIVE — say so. No window = the classic review flow.
  const live = !!validUntil;
  const untilText = live ? new Date(validUntil).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;
  app.innerHTML = `
    <div class="success-card">
      <div class="success-icon">
        <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
      </div>
      ${live ? `
        <h2>You're <em>parked.</em></h2>
        <p>Your parking pass for <em>${escapeHtml(property.name)}</em> is active${plate ? ` for plate <strong>${escapeHtml(plate)}</strong>` : ''}. No further steps — your plate is your pass.</p>
        <div class="success-ref">VALID UNTIL ${escapeHtml(untilText.toUpperCase())}</div>
        ${refId ? `<div class="success-detail">REF ${escapeHtml(refId)} — SAVE THIS IF YOU NEED TO CALL</div>` : ''}
      ` : `
        <h2>Request <em>submitted.</em></h2>
        <p>Your registration for <em>${escapeHtml(property.name)}</em> is in. The leasing office or towing company will review it — you'll be notified.</p>
        ${refId ? `<div class="success-ref">${escapeHtml(refId)}</div>` : ''}
        <div class="pending-badge">Pending approval</div>
      `}
      ${phone ? `<div class="success-detail">QUESTIONS? CALL ${phone}</div>` : ''}
    </div>
  `;
}

init();
