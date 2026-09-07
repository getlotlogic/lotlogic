// visit.html's registration flow — apartment ("get my pass") and
// truck-plaza (free + pay-to-park) forms. Task 17: everything this page
// shared byte-for-byte (or as a resolved superset) with resident.html /
// apt.html now lives in ./shared/register.js; the pay-to-park branch below
// is moved here VERBATIM, untouched, per the task brief — do not refactor
// it to use shared helpers beyond the ones it already called by name
// (escapeHtml, backendRegister, normalizePlate, normalizePhone,
// getRecaptchaToken, friendlyErrorMessage), which resolve identically to
// what this page's own copies did (visit.html's normalizePlate/backendRegister-
// timeout were already the values register.js took as the shared default —
// see task-17-report.md).
import {
  pgRest, backendRegister, getRecaptchaToken, friendlyErrorMessage,
  escapeHtml, showNotFound, showConnectionError, normalizePlate, normalizePhone,
  newIdempotencyKey, REGION_TOKENS, PROPERTY_COLUMNS, propertyQuery, BACKEND_URL,
} from './shared/register.js';
import { DEFAULT_TRUCK_PLAZA_POLICY } from './shared/policy.js';

// The pay-to-park branch further down refers to the backend base URL by the
// bare name `BACKEND_URL`, same as it did when this was a plain <script>.
// That constant now lives in ./shared/register.js — `backendUrl()` is the
// one adaptation needed so none of the pay-to-park logic itself changes.
function backendUrl() { return BACKEND_URL; }

const app = document.getElementById('app');

// QR code id comes from /visit.html/<qr> in the URL, but we also accept
// ?qr=<id> so a shared / emailed link like /visit.html?qr=... still works.
const pathParts = window.location.pathname.split('/').filter(Boolean);
const qrCodeId = (pathParts.length >= 2 ? pathParts[pathParts.length - 1] : null)
  || new URLSearchParams(window.location.search).get('qr');

// Square sends the payer back to ?qr=<id>&plaza_payment_id=<uuid>. Its
// presence means "we just came back from checkout" — never that anything
// was paid. The status poll below is the only source of that truth.
const plazaPaymentId = new URLSearchParams(window.location.search).get('plaza_payment_id');

let property = null;

async function init() {
  if (!qrCodeId) {
    showNotFound('Invalid Link', 'This parking pass link is not valid.');
    return;
  }
  try {
    const rows = await loadPropertyRow();
    const data = Array.isArray(rows) ? rows[0] : null;
    if (!data) {
      showNotFound('Lot Not Found', 'This parking pass link is not valid or has expired.');
      return;
    }
    property = data;
    if (plazaPaymentId && property.property_type === 'truck_plaza') {
      handlePlazaReturn(plazaPaymentId);
      return;
    }
    showForm();
  } catch (err) {
    console.error('init error:', err);
    showConnectionError(err, init);
  }
}

async function loadPropertyRow() {
  try {
    return await pgRest(propertyQuery(qrCodeId, PROPERTY_COLUMNS + ',pay_to_park_enabled'));
  } catch (err) {
    if (!err || !err.status) throw err;   // timeout / network — not a column problem
    console.warn('pay_to_park_enabled unreadable — falling back to free registration:', err.message);
    return await pgRest(propertyQuery(qrCodeId, PROPERTY_COLUMNS));
  }
}

// The single gate for every paid-only behaviour on this page.
function payToParkOn() {
  return !!property
    && property.property_type === 'truck_plaza'
    && property.pay_to_park_enabled === true;
}

// Form-mount idempotency key — same key reused on every retry of the same form.
let idempotencyKey = null;

function showForm() {
  idempotencyKey = newIdempotencyKey();
  if (property.property_type === 'truck_plaza') {
    showTruckPlazaForm();
  } else {
    showApartmentForm();
  }
}

function showApartmentForm() {
  app.innerHTML = `
    <div class="logo">
      <div class="shield"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#1F1B14" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M9 10h2a2 2 0 0 1 0 4H9zm0 0v4"/></svg></div>
      <h1>LotL<span>o</span>gic</h1>
    </div>
    <div class="property-name">
      parking pass at
      <strong>${escapeHtml(property.name)}</strong>
    </div>
    <form id="passForm">
      <label for="visitorName">Full Name <span class="required">*</span></label>
      <input type="text" id="visitorName" placeholder="Jane Smith" required>

      <label for="phone">Phone Number <span class="required">*</span></label>
      <input type="tel" id="phone" placeholder="(555) 123-4567" required>

      <label for="plate">License Plate <span class="required">*</span></label>
      <input type="text" id="plate" class="plate-input" placeholder="ABC 1234" required maxlength="10" autocomplete="off">
      <div style="font-size:12px;opacity:.65;margin-top:4px;">Plate characters only — no state or province</div>

      <label for="backPlate">Back License Plate <span style="opacity:.7;font-weight:normal;">(if different)</span></label>
      <input type="text" id="backPlate" class="plate-input" placeholder="leave blank if same" maxlength="10" autocomplete="off">
      <div style="font-size:12px;opacity:.65;margin-top:4px;">Plate characters only — no state or province</div>

      <label for="stayHours">How long will you be here? <span class="required">*</span></label>
      <select id="stayHours" required>
        <option value="2">2 hours</option>
        <option value="4">4 hours</option>
        <option value="8">8 hours</option>
        <option value="12">12 hours</option>
        <option value="24" selected>24 hours</option>
        <option value="48">48 hours (maximum)</option>
      </select>

      <button type="submit" class="submit-btn" id="submitBtn">Get my pass →</button>
      <div class="validity">MAXIMUM STAY · 48 HOURS</div>
      <div id="errorMsg"></div>
    </form>
  `;

  document.getElementById('passForm').addEventListener('submit', handleApartmentSubmit);
}

function showTruckPlazaForm() {
  const paid = payToParkOn();
  // Free path: today's 12/24/36/48 dropdown, untouched. Paid path: the
  // three stays we actually sell, priced on the control the payer taps.
  const stayField = paid ? `<label>Stay Duration <span class="required">*</span></label>
      <div class="duration-options" id="durationOptions">
        <label class="duration-option"><input type="radio" name="duration" value="h10" data-amount-cents="1500" checked><span>10 hours — $15</span></label>
        <label class="duration-option"><input type="radio" name="duration" value="h24" data-amount-cents="2500"><span>1 day — $25</span></label>
        <label class="duration-option"><input type="radio" name="duration" value="h48" data-amount-cents="4000"><span>2 days — $40</span></label>
      </div>` : `<label for="stayHours">Stay Duration <span class="required">*</span></label>
      <select id="stayHours" required>
        <option value="" disabled selected>Select duration</option>
        <option value="12">12 hours</option>
        <option value="24">24 hours</option>
        <option value="36">36 hours</option>
        <option value="48">48 hours</option>
      </select>`;
  // §13.13 — the payer agrees to this BEFORE the charge, because there is
  // no refund afterwards.
  const ackField = paid ? `<label class="ack-row" for="payAck">
        <input type="checkbox" id="payAck">
        <span>I understand payment is non-refundable, does not exempt my vehicle from the parking policies, and that violating any rule may result in towing at my expense.</span>
      </label>
      ` : '';
  app.innerHTML = `
    <div class="logo">
      <div class="shield"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#1F1B14" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M9 10h2a2 2 0 0 1 0 4H9zm0 0v4"/></svg></div>
      <h1>LotL<span>o</span>gic</h1>
    </div>
    <div class="property-name">
      parking pass registration<br>
      <strong>${escapeHtml(property.name)}</strong>
    </div>
    <form id="passForm">
      <label for="plate">Truck License Plate <span class="required">*</span> <span style="opacity:.7;font-weight:normal;">(front-of-tractor)</span></label>
      <input type="text" id="plate" class="plate-input" placeholder="ABC 1234" required maxlength="10" autocomplete="off">
      <div style="font-size:12px;opacity:.65;margin-top:4px;">Plate characters only — no state or province</div>
      <div id="preflightMsg" style="font-size:13px;color:#9A5530;margin-top:-8px;margin-bottom:8px;font-family:'DM Mono',monospace;letter-spacing:.04em;"></div>

      <label for="backPlate">Trailer / Rear License Plate <span class="required">*</span></label>
      <input type="text" id="backPlate" class="plate-input" placeholder="XYZ 5678" required maxlength="10" autocomplete="off">
      <div style="font-size:12px;opacity:.65;margin-top:4px;">Plate on the back of your rig — trailer plate if you have one. Only one plate? Enter it again.</div>

      <label for="phone">Phone Number <span class="required">*</span></label>
      <input type="tel" id="phone" placeholder="(555) 123-4567" required>

      <label for="companyName">Company Name <span class="required">*</span></label>
      <input type="text" id="companyName" placeholder="ACME Trucking Co" required maxlength="80">

      <label for="driverName">Operator Name <span class="required">*</span></label>
      <input type="text" id="driverName" placeholder="John Smith" required maxlength="80">

      ${stayField}

      <div style="margin-top:18px;background:#1F1B14;color:#F4ECD8;border:1.5px solid #1F1B14;padding:16px 18px;font-size:13px;line-height:1.55;letter-spacing:.02em;">
        <div style="font-family:'Fraunces',serif;font-style:italic;font-size:16px;margin-bottom:10px;color:#F4ECD8;">Towing enforced — please read the rules.</div>
        <!-- The property's official posted policy, rendered as a document image.
             Keyed by qr_code_id so each property can drop in /policy/<qr>.jpg. Falls back to
             the text policy only if no image exists for this property. The page viewport
             blocks pinch-zoom, so the wrapping link opens the full-size image in a new tab. -->
        <a href="/policy/${escapeHtml(qrCodeId)}.jpg" target="_blank" rel="noopener" id="policyImgLink" style="display:block;">
          <img src="/policy/${escapeHtml(qrCodeId)}.jpg"
               alt="Official truck parking policies — tap to open full size"
               style="width:100%;height:auto;display:block;border-radius:6px;background:#FFFFFF;"
               id="policyImg" />
        </a>
        <div id="policyImgHint" style="margin-top:6px;font-size:11.5px;color:#D9C9A6;text-align:center;">Tap the document to open it full size.</div>
        <div id="policyTextFallback" style="display:none;white-space:pre-wrap;max-height:260px;overflow:auto;color:#F4ECD8;font-size:12.5px;line-height:1.5;background:#171309;border:1px solid #2A241A;border-radius:6px;padding:12px 14px;">${escapeHtml(property.policy_text || DEFAULT_TRUCK_PLAZA_POLICY)}</div>
        <div style="margin-top:12px;font-size:12px;color:#D9C9A6;">NMLD Towing &middot; ${escapeHtml(property.policy_phone || '(269) 217-6208')} &middot; Truck parking rules are in effect 24/7.</div>
        <div style="margin-top:10px;font-size:12px;color:#D9C9A6;">By submitting you confirm you have read and agree to all parking policies shown above and understand the liability notice.</div>
      </div>

      ${ackField}<button type="submit" class="submit-btn" id="submitBtn" style="margin-top:18px;"${paid ? ' disabled' : ''}>${paid ? 'Pay &amp; register →' : 'Get parking pass →'}</button>
      <div id="errorMsg"></div>
    </form>
  `;

  document.getElementById('passForm').addEventListener('submit', paid ? handlePlazaPaySubmit : handleTruckPlazaSubmit);
  document.getElementById('plate').addEventListener('blur', preflightCheckPlate);
  // The policy image is served from /policy/<qr>.jpg; not every property has
  // one uploaded yet. Was an inline onerror="" attribute — moved to a real
  // listener here so it keeps working now that this page's script is an ES
  // module (module scope isn't global scope; an inline handler can only
  // call something reachable from window).
  const policyImg = document.getElementById('policyImg');
  if (policyImg) policyImg.addEventListener('error', () => {
    const l = document.getElementById('policyImgLink'); if (l) l.style.display = 'none';
    const h = document.getElementById('policyImgHint'); if (h) h.style.display = 'none';
    const f = document.getElementById('policyTextFallback'); if (f) f.style.display = 'block';
  });
  if (paid) {
    // The acknowledgment gates the button — nothing is charged until it's ticked.
    const ack = document.getElementById('payAck');
    const payBtn = document.getElementById('submitBtn');
    ack.addEventListener('change', () => { payBtn.disabled = !ack.checked; });
    // Picking a different stay while a price confirmation is on screen
    // retires it — that confirmation was for the old stay, and its button
    // would otherwise still name the old stay's price.
    document.getElementById('durationOptions').addEventListener('change', () => {
      if (!plazaPendingConfirm) return;
      plazaPendingConfirm = null;
      document.getElementById('errorMsg').innerHTML = '';
      payBtn.innerHTML = 'Pay &amp; register →';
    });
  }
}

async function preflightCheckPlate() {
  const msg = document.getElementById('preflightMsg');
  msg.textContent = '';
  const plate = normalizePlate(document.getElementById('plate').value);
  if (!plate || plate.length < 2) return;
  try {
    // Pre-flight the duplicate-pass warning via the backend's public
    // /visitor_passes/check-active endpoint. Reading visitor_passes
    // directly from PostgREST returns [] under the anon role (no SELECT
    // policy), so the old direct-query path was silently useless — a
    // driver re-scanning the QR after a few hours would never see the
    // "already registered" notice. The backend endpoint is public, in
    // PUBLIC_PATHS, and returns only {active, valid_until, reference_id}.
    const url = `${backendUrl()}/visitor_passes/check-active`
      + `?property_id=${encodeURIComponent(property.id)}`
      + `&plate=${encodeURIComponent(plate)}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    let data = null;
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
      if (res.ok) {
        const text = await res.text();
        data = text ? JSON.parse(text) : null;
      }
    } finally { clearTimeout(t); }
    if (data && data.held && data.hold_until) {
      const until = new Date(data.hold_until).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
      // Cooldown is advisory-only as of 2026-05-31 — the DB trigger no
      // longer blocks re-registration. Wording softened so drivers
      // don't think they're blocked and bail (in case they are
      // re-registering for a legitimate reason).
      msg.textContent = `Heads up — this plate was registered recently. You can still register; the property will see this flag and may follow up.`;
      msg.style.color = '#b45309';
    } else if (data && data.active && data.valid_until) {
      const expires = new Date(data.valid_until).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
      const ref = (data.reference_id || '').toString().toUpperCase();
      msg.textContent = ref
        ? `Already registered: pass active until ${expires} (Ref ${ref})`
        : `Already registered: pass active until ${expires}`;
      msg.style.color = '';
    } else {
      msg.style.color = '';
    }
  } catch (_) { /* non-fatal — let submit handle it */ }
}

let submitting = false;

async function handleApartmentSubmit(e) {
  e.preventDefault();
  if (submitting) return;
  submitting = true;
  const btn = document.getElementById('submitBtn');
  const errorDiv = document.getElementById('errorMsg');
  errorDiv.innerHTML = '';
  btn.disabled = true;
  btn.textContent = 'Registering...';

  try {
    const plateText = normalizePlate(document.getElementById('plate').value);
    const backPlateRaw = document.getElementById('backPlate')?.value || '';
    const backPlateText = backPlateRaw.trim() ? normalizePlate(backPlateRaw) : null;
    const visitorName = document.getElementById('visitorName').value.trim();
    const stayHours = parseInt(document.getElementById('stayHours').value, 10);
    const phone = normalizePhone(document.getElementById('phone').value);

    if (!plateText || plateText.length < 2) throw new Error('Please enter a valid license plate number.');
    if (REGION_TOKENS.has(plateText)) throw new Error('That looks like a state, not a plate — enter the plate characters only.');
    if (backPlateText && REGION_TOKENS.has(backPlateText)) throw new Error('The back plate looks like a state name, not a plate — enter the plate characters only, or leave it blank.');
    if (backPlateText && backPlateText.length < 4) throw new Error('Back plate must be at least 4 characters, or leave it blank.');
    if (backPlateText && backPlateText === plateText) throw new Error('Back plate must differ from the front plate, or leave it blank.');
    if (!stayHours || stayHours > 48) throw new Error('Choose how long you will be parked (max 48 hours).');

    const recaptchaToken = await getRecaptchaToken('pass_register').catch(() => null);
    if (!recaptchaToken) {
      throw new Error('Please retry — automated-access check failed.');
    }

    const result = await backendRegister('/visitor_passes/register', {
      property_id: property.id,
      plate_text: plateText,
      back_plate: backPlateText,
      visitor_name: visitorName,
      host_unit: '',
      host_name: '',
      phone: phone,
      stay_hours: stayHours,
      submission_idempotency_key: idempotencyKey,
      recaptcha_token: recaptchaToken,
    });

    const validUntil = result.valid_until ? new Date(result.valid_until)
      : new Date(Date.now() + stayHours * 60 * 60 * 1000);
    const refId = (result.reference_id || '').toString().toUpperCase();
    showSuccess({plate: result.plate_text || plateText, validUntil, stayHours, refId: refId || null, parkingSpot: null});
  } catch (err) {
    errorDiv.innerHTML = '<div class="error">' + escapeHtml(friendlyErrorMessage(err)) + '</div>';
    btn.disabled = false;
    btn.textContent = 'Get my pass →';
    submitting = false;
  }
}

async function handleTruckPlazaSubmit(e) {
  e.preventDefault();
  if (submitting) return;
  submitting = true;
  const btn = document.getElementById('submitBtn');
  const errorDiv = document.getElementById('errorMsg');
  errorDiv.innerHTML = '';
  btn.disabled = true;
  btn.textContent = 'Registering...';

  try {
    const companyName = document.getElementById('companyName').value.trim();
    const driverName  = document.getElementById('driverName').value.trim();
    const plateText   = normalizePlate(document.getElementById('plate').value);
    const backPlateRaw = document.getElementById('backPlate')?.value || '';
    const backPlateText = backPlateRaw.trim() ? normalizePlate(backPlateRaw) : null;
    const phone       = normalizePhone(document.getElementById('phone').value);
    const stayHours = parseInt(document.getElementById('stayHours').value, 10) || 0;

    if (!companyName) throw new Error('Company name is required.');
    if (!driverName) throw new Error('Operator name is required.');
    if (!plateText || plateText.length < 2) throw new Error('Please enter a valid license plate number.');
    if (REGION_TOKENS.has(plateText)) throw new Error('That looks like a state, not a plate — enter the plate characters only.');
    // Rear/trailer plate is REQUIRED for truck-plaza passes (2026-08-17):
    // camera reads of either end of the rig must be tie-able to the pass.
    // A single-plate truck enters the same plate again — that's accepted.
    if (!backPlateText) throw new Error('Please enter the trailer / rear plate. If your truck has only one plate, enter it again.');
    if (REGION_TOKENS.has(backPlateText)) throw new Error('The trailer plate looks like a state name, not a plate — enter the plate characters only.');
    if (backPlateText.length < 2) throw new Error('Please enter a valid trailer / rear plate.');
    if (!phone || phone.length < 11) throw new Error('Please enter a valid phone number.');
    if (![12, 24, 36, 48].includes(stayHours)) throw new Error('Choose 12, 24, 36, or 48 hours.');

    const recaptchaToken = await getRecaptchaToken('pass_register').catch(() => null);
    if (!recaptchaToken) {
      throw new Error('Please retry — automated-access check failed.');
    }

    const now = new Date();
    const result = await backendRegister('/visitor_passes/register', {
      property_id: property.id,
      plate_text: plateText,
      back_plate: backPlateText,
      visitor_name: driverName,
      company_name: companyName,
      host_unit: '',
      host_name: '',
      phone: phone,
      stay_hours: stayHours,
      policy_acknowledged_at: now.toISOString(),
      submission_idempotency_key: idempotencyKey,
      recaptcha_token: recaptchaToken,
    });

    const validUntil = result.valid_until ? new Date(result.valid_until)
      : new Date(now.getTime() + stayHours * 60 * 60 * 1000);
    const refId = (result.reference_id || '').toString().toUpperCase();
    showSuccess({plate: result.plate_text || plateText, validUntil, stayHours, refId: refId || null, parkingSpot: null, companyName});
  } catch (err) {
    // Cooldown is allow + flag as of 2026-05-31 — the DB trigger no longer
    // blocks re-registration and the backend register endpoint no longer
    // returns a 409, so there is nothing to special-case here. The
    // pre-flight check above already surfaces an active cooldown advisory.
    errorDiv.innerHTML = '<div class="error">' + escapeHtml(friendlyErrorMessage(err)) + '</div>';
    btn.disabled = false;
    btn.textContent = 'Get parking pass';
    submitting = false;
  }
}

function showSuccess(opts) {
  const {plate, validUntil, stayHours, refId, parkingSpot, companyName} = opts;
  const expiresStr = validUntil.toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
  const isPlaza = property.property_type === 'truck_plaza';
  const extras = isPlaza ? `
    <div class="success-detail" style="margin-top:8px;">
      ${companyName ? `Company: <strong>${escapeHtml(companyName)}</strong><br>` : ''}
      ${parkingSpot ? `Parking space: <strong>${escapeHtml(parkingSpot)}</strong><br>` : ''}
      ${refId ? `Reference: <strong>${escapeHtml(refId)}</strong>` : ''}
    </div>
    <div class="success-detail" style="margin-top:14px;color:#6b7280;font-size:12px;">
      Save this page (screenshot or bookmark) as your registration receipt.
    </div>` : '';

  app.innerHTML = `
    <div class="success-card">
      <div class="success-icon">
        <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
      </div>
      <h2>${isPlaza ? 'You\'re <em>registered.</em>' : 'You\'re <em>in.</em>'}</h2>
      <p>Pass for <em>${escapeHtml(property.name)}</em> is active. Have a good visit.</p>
      <div class="success-plate">${escapeHtml(plate)}</div>
      <div class="success-detail">VALID ${stayHours}H · UNTIL ${escapeHtml(expiresStr).toUpperCase()}</div>
      ${extras}
    </div>
  `;
}

// ── Pay-to-park (truck plaza) ──────────────────────────────────────
// Everything below runs only when properties.pay_to_park_enabled is true.
// The free registration path never reaches any of it.
//
// Moved here VERBATIM from visit.html's inline script — per the task
// brief, this branch is not refactored, not shared, not deleted. Pay-to-park
// is ENDED in production (flag OFF since 2026-09-03) but the code stays.
// (See `backendUrl()` near the top of this file for the one necessary
// adaptation — `BACKEND_URL` moved to ./shared/register.js.)

// A stable fingerprint of what the payer typed. The idempotency key is
// keyed off this, so a retry of the SAME form reuses the SAME key (one
// Square order, one charge), while an edited form gets a fresh one.
function plazaFormSig(parts) {
  const str = parts.join('|');
  let h1 = 5381, h2 = 52711;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = (((h1 << 5) + h1) + c) >>> 0;
    h2 = (((h2 << 5) + h2) ^ c) >>> 0;
  }
  return h1.toString(36) + h2.toString(36);
}

// §13.6 — survives the full-page redirect to Square and any reload.
// sessionStorage, not a module variable: the page is destroyed and rebuilt
// by the round-trip, and a second key would mean a second order.
function plazaIdempotencyKey(formSig) {
  const k = 'plaza_idem_' + formSig;
  let v = null;
  try { v = sessionStorage.getItem(k); } catch (e) {}
  if (!v) {
    v = (crypto.randomUUID && crypto.randomUUID()) ||
        (Date.now() + '-' + Math.random().toString(36).slice(2));
    try { sessionStorage.setItem(k, v); } catch (e) {}
  }
  return v;
}

// ── The price guard ────────────────────────────────────────────────
// The server owns the price (§13.2) and this page only ever shows a label.
// Between a backend deploy that raises a price and the frontend deploy
// that relabels the radios — and for any phone still holding a cached copy
// of this page — the two disagree, and a payer who tapped "$15" would land
// on Square being asked for $25. So the quote's amount is checked against
// the amount the tapped radio declared, and a mismatch stops the redirect:
// the real price is said out loud and the payer taps again to agree to it.
//
// Holds {sig, checkoutUrl, amountCents} while that confirmation is on
// screen. `sig` is the form fingerprint the quote was taken for, so an
// edited form falls through to a fresh quote instead of paying for the
// stay that was quoted before the edit.
let plazaPendingConfirm = null;

/** Cents → the way the price is written on the form: $15, $25.50. */
function plazaMoney(cents) {
  const dollars = cents / 100;
  return '$' + (Number.isInteger(dollars) ? String(dollars) : dollars.toFixed(2));
}

// Drop a key the server has told us is spent. The next submit mints a new
// one — reusing a settled key just gets refused again.
function plazaForgetIdempotencyKey(formSig) {
  try { sessionStorage.removeItem('plaza_idem_' + formSig); } catch (e) {}
}

// Every key this browser session minted for this page. Cleared once a pass
// is confirmed active, so the next stay starts clean.
function plazaClearIdempotencyKeys() {
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k && k.indexOf('plaza_idem_') === 0) sessionStorage.removeItem(k);
    }
  } catch (e) {}
}

// A 409 on the idempotency key comes in two flavours and they are NOT
// interchangeable. `paid` / `refunded` mean money already changed hands
// for this exact stay: reminting the key there would hand the payer a
// second Square checkout for a stay they already bought, and this product
// issues no refunds. Every other spent-key code means no charge was made,
// so a fresh key is the right recovery.
function plazaSpentKeyKind(detail) {
  const d = typeof detail === 'string' ? detail : '';
  if (d === 'quote_already_settled:paid' || d === 'quote_already_settled:refunded') return 'paid';
  if (d === 'idempotency_key_reuse_mismatch' || d === 'duplicate_quote' ||
      d.indexOf('quote_already_settled:') === 0) return 'retry';
  return null;
}

// Plain language for every refusal the payment entrance can answer with.
// Raw JSON and internal codes never reach the payer.
function plazaPayErrorMessage(status, detail) {
  const d = typeof detail === 'string' ? detail : '';
  if (status === 429) {
    return 'Too many attempts in the last hour — please wait a bit and try again.';
  }
  if (status === 502 || status === 503) {
    return 'Payments are unavailable right now. Please try again in a few minutes.';
  }
  if (status === 409) {
    const kind = plazaSpentKeyKind(d);
    if (kind === 'paid') {
      return 'This stay has already been paid for. Do not pay again — reload this page to see your pass status.';
    }
    if (kind === 'retry') {
      return 'That payment attempt has already been used. Please try again.';
    }
    return d || 'We could not start the payment. Please try again.';
  }
  if (status === 400) {
    if (d.indexOf('recaptcha:') === 0) return 'Please retry — automated-access check failed.';
    if (d === 'policy_not_acknowledged') return 'Please tick the box above to continue.';
    if (d === 'plate_invalid') return 'Please enter a valid license plate number.';
    return d || 'We could not start the payment. Please try again.';
  }
  if (status === 404) return 'This parking pass link is not valid.';
  return 'Something went wrong. Please try again.';
}

async function handlePlazaPaySubmit(e) {
  e.preventDefault();
  if (submitting) return;
  submitting = true;
  const btn = document.getElementById('submitBtn');
  const errorDiv = document.getElementById('errorMsg');
  errorDiv.innerHTML = '';
  btn.disabled = true;
  btn.textContent = 'Starting payment…';

  let formSig = null;
  try {
    const companyName = document.getElementById('companyName').value.trim();
    const operatorName = document.getElementById('driverName').value.trim();
    const plateText = normalizePlate(document.getElementById('plate').value);
    const backPlateRaw = document.getElementById('backPlate')?.value || '';
    const backPlateText = backPlateRaw.trim() ? normalizePlate(backPlateRaw) : null;
    const phone = normalizePhone(document.getElementById('phone').value);
    const durationEl = document.querySelector('input[name="duration"]:checked');
    const duration = durationEl ? durationEl.value : '';
    const acknowledged = !!document.getElementById('payAck')?.checked;

    if (!companyName) throw new Error('Company name is required.');
    if (!operatorName) throw new Error('Operator name is required.');
    if (!plateText || plateText.length < 2) throw new Error('Please enter a valid license plate number.');
    if (REGION_TOKENS.has(plateText)) throw new Error('That looks like a state, not a plate — enter the plate characters only.');
    if (!backPlateText) throw new Error('Please enter the trailer / rear plate. If your truck has only one plate, enter it again.');
    if (REGION_TOKENS.has(backPlateText)) throw new Error('The trailer plate looks like a state name, not a plate — enter the plate characters only.');
    if (backPlateText.length < 2) throw new Error('Please enter a valid trailer / rear plate.');
    if (!phone || phone.length < 11) throw new Error('Please enter a valid phone number.');
    if (duration !== 'h10' && duration !== 'h24' && duration !== 'h48') throw new Error('Choose how long you will be parked.');
    if (!acknowledged) throw new Error('Please tick the box above to continue.');

    formSig = plazaFormSig([plateText, backPlateText, phone, companyName, operatorName, duration]);

    // Second tap of a price confirmation: the real price has been shown
    // and agreed to. Go to the link the server already handed us —
    // re-quoting here would mint a second Square order for one stay.
    if (plazaPendingConfirm && plazaPendingConfirm.sig === formSig) {
      window.location.href = plazaPendingConfirm.checkoutUrl;
      return;   // leaving the page — keep the button disabled
    }
    plazaPendingConfirm = null;

    const recaptchaToken = await getRecaptchaToken('plaza_pay').catch(() => null);
    if (!recaptchaToken) throw new Error('Please retry — automated-access check failed.');

    const idemKey = plazaIdempotencyKey(formSig);

    // The body carries a duration ENUM and never an amount: the price is
    // the server's to decide (§13.2).
    const data = await backendRegister('/plaza/quote-and-start', {
      property_id: property.id,
      duration: duration,
      plate_text: plateText,
      back_plate: backPlateText,
      phone: phone,
      company_name: companyName,
      visitor_name: operatorName,
      policy_acknowledged: true,
      idempotency_key: idemKey,
      recaptcha_token: recaptchaToken,
    });

    if (!data || !data.checkout_url) throw new Error('Could not start payment. Please try again.');

    // The label vs the quote. Only a real disagreement stops the redirect;
    // a radio with no declared price, or a quote with no amount, is not
    // something to hold a paying customer up over.
    const tappedCents = durationEl ? Number(durationEl.dataset.amountCents) : NaN;
    const quotedCents = Number(data.amount_cents);
    if (Number.isFinite(tappedCents) && Number.isFinite(quotedCents)
        && quotedCents !== tappedCents) {
      plazaPendingConfirm = {
        sig: formSig,
        checkoutUrl: data.checkout_url,
        amountCents: quotedCents,
      };
      const real = plazaMoney(quotedCents);
      errorDiv.innerHTML = '<div class="notice">' + escapeHtml(
        'Price for this stay is ' + real + ', not ' + plazaMoney(tappedCents)
        + '. Tap Pay ' + real + ' to continue.') + '</div>';
      btn.innerHTML = 'Pay ' + escapeHtml(real) + ' →';
      btn.disabled = false;
      submitting = false;
      return;
    }

    window.location.href = data.checkout_url;
    return;   // leaving the page — keep the button disabled
  } catch (err) {
    const status = err && err.status;
    const detail = err && (err.detail || err.message);
    const spent = status === 409 ? plazaSpentKeyKind(detail) : null;
    if (spent === 'retry' && formSig) {
      // No charge was made under this key. Mint a fresh one next time —
      // the server refuses a spent key forever.
      plazaForgetIdempotencyKey(formSig);
    }
    const message = status
      ? plazaPayErrorMessage(status, detail)
      : friendlyErrorMessage(err);
    errorDiv.innerHTML = '<div class="error">' + escapeHtml(message) + '</div>';
    plazaPendingConfirm = null;
    btn.innerHTML = 'Pay &amp; register →';
    if (spent === 'paid') {
      // Terminal. The stay is bought; the only thing another tap could buy
      // is a second one. Keep the key, keep the form shut — `submitting`
      // stays true so even an Enter keypress cannot re-submit.
      btn.disabled = true;
      const ackBox = document.getElementById('payAck');
      if (ackBox) ackBox.disabled = true;
      return;
    }
    btn.disabled = !document.getElementById('payAck')?.checked;
    submitting = false;
  }
}

// ── Return from Square (§13.11) ────────────────────────────────────
// "Paid" is never painted from the query string. Square redirects the
// moment the card clears; the pass is created by the webhook, so the page
// polls the server until it sees a live pass.
// One poll. Answers with {status: 200|404|null, body} so the caller can
// tell "the server said pending" apart from "we never reached the server"
// — those two must not end on the same reassuring copy. Bounded like every
// other fetch on this page: a hung request would otherwise eat the whole
// polling window in one go.
async function plazaFetchStatus(ppId, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(
      backendUrl() + '/plaza/payments/' + encodeURIComponent(ppId) + '/status',
      { signal: ctrl.signal, headers: { Accept: 'application/json' } },
    );
    if (res.status === 404) return { status: 404, body: null };
    if (!res.ok) return { status: res.status, body: null };
    const text = await res.text();
    return { status: 200, body: text ? JSON.parse(text) : null };
  } catch (e) {
    return { status: null, body: null };   // timeout / offline
  } finally { clearTimeout(t); }
}

async function handlePlazaReturn(ppId) {
  showPlazaMessage('Confirming your payment…');
  let heardFromServer = false;
  for (let i = 0; i < 10; i++) {            // ~20s
    const r = await plazaFetchStatus(ppId);
    if (r.status === 404) {
      // The id is not ours. Never tell someone their payment is fine when
      // we cannot find a record of it.
      showPlazaUnknown();
      return;
    }
    if (r.status === 200) {
      heardFromServer = true;
      const s = r.body;
      if (s && s.pass_active) {
        plazaClearIdempotencyKeys();
        showPlazaPaidSuccess();
        return;
      }
      if (s && s.payment_status === 'failed') {
        showPlazaFailed();
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  // The server said "not yet" — a webhook still in flight. Reassurance earned.
  if (heardFromServer) {
    showPlazaMessage(
      "Payment received — your parking pass is being activated. Keep this " +
      "page as your receipt; Square will also email or text you a receipt " +
      "if you entered your contact info at checkout."
    );
    return;
  }
  // We never got an answer, so we know nothing about the money. Say so.
  showPlazaMessage(
    "We couldn't reach the server to confirm your payment. If you were " +
    "charged, your parking pass is being activated; reload this page in a " +
    "minute to confirm."
  );
}

function plazaLogoHtml() {
  return `
    <div class="logo">
      <div class="shield"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#1F1B14" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M9 10h2a2 2 0 0 1 0 4H9zm0 0v4"/></svg></div>
      <h1>LotL<span>o</span>gic</h1>
    </div>`;
}

function showPlazaMessage(message) {
  app.innerHTML = plazaLogoHtml() + `
    <div class="loading-state" id="plazaStatus">${escapeHtml(message)}</div>
  `;
}

function showPlazaPaidSuccess() {
  app.innerHTML = `
    <div class="success-card">
      <div class="success-icon">
        <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
      </div>
      <h2>You're <em>registered.</em></h2>
      <p id="plazaPaidCopy">Payment received. Your parking pass is active.</p>
      <div class="success-detail" style="margin-top:14px;">Pass for ${escapeHtml(property && property.name || '')}.</div>
      <div class="success-detail" style="margin-top:14px;color:#6b7280;font-size:12px;">
        Save this page (screenshot or bookmark) as your registration receipt.
      </div>
    </div>
  `;
}

function showPlazaUnknown() {
  app.innerHTML = plazaLogoHtml() + `
    <div class="not-found">
      <h2 id="plazaUnknown">We can't find that payment.</h2>
      <p>If you were charged, reload this page in a minute — or contact the plaza.</p>
    </div>
  `;
}

function showPlazaFailed() {
  app.innerHTML = plazaLogoHtml() + `
    <div class="not-found">
      <h2 id="plazaFailed">Payment did not go through.</h2>
      <p>The payment did not complete, so no parking pass was created.</p>
      <p>Scan the code again to retry.</p>
    </div>
  `;
}

init();
