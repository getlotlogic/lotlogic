// resident.html's registration flow — permanent-plate request for
// apartments (truck-plaza properties dead-end here; every truck-plaza visit
// is a temporary pass via visit.html). Task 17: everything this page shared
// byte-for-byte (or as a resolved superset) with visit.html / apt.html now
// lives in ./shared/register.js. `showSuccess` stays here — see
// ./shared/register.js's header comment for why it isn't shared.
import {
  pgRest, backendRegister, getRecaptchaToken, friendlyErrorMessage,
  escapeHtml, showNotFound, showConnectionError, normalizePlate,
  REGION_TOKENS, propertyQuery,
} from './shared/register.js';

const app = document.getElementById('app');

// QR code id comes from /resident.html/<qr> in the URL, but we also accept
// ?qr=<id> so a shared / emailed link like /resident.html?qr=... still works.
const pathParts = window.location.pathname.split('/').filter(Boolean);
const qrCodeId = (pathParts.length >= 2 ? pathParts[pathParts.length - 1] : null)
  || new URLSearchParams(window.location.search).get('qr');

let property = null;

async function init() {
  if (!qrCodeId) {
    showNotFound('Invalid Link', 'This parking pass link is not valid.');
    return;
  }
  try {
    const rows = await pgRest(propertyQuery(qrCodeId, 'id,name,address,property_type'));
    const data = Array.isArray(rows) ? rows[0] : null;
    if (!data) {
      showNotFound('Property Not Found', 'This registration link is not valid or has expired.');
      return;
    }
    property = data;
    showForm();
  } catch (err) {
    console.error('init error:', err);
    showConnectionError(err, init);
  }
}

function showForm() {
  const isPlaza = property.property_type === 'truck_plaza';

  // Truck-plaza properties don't use permanent passes — every visit is
  // a temporary pass via visit.html. Surface a clean dead-end so a
  // misrouted scan isn't a confusing form.
  if (isPlaza) {
    app.innerHTML = `
      <div class="logo">
        <div class="shield"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#1F1B14" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M9 10h2a2 2 0 0 1 0 4H9zm0 0v4"/></svg></div>
        <h1>LotL<span>o</span>gic</h1>
      </div>
      <div class="not-found">
        <h2>Use the parking-pass QR</h2>
        <p>This lot only issues parking passes from the other QR. Scan the parking pass QR on the signage to register.</p>
      </div>
    `;
    return;
  }

  app.innerHTML = `
    <div class="logo">
      <div class="shield"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#1F1B14" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M9 10h2a2 2 0 0 1 0 4H9zm0 0v4"/></svg></div>
      <h1>LotL<span>o</span>gic</h1>
    </div>
    <div class="property-name">
      parking pass request at
      <strong>${escapeHtml(property.name)}</strong>
    </div>
    <form id="regForm">
      <label for="holderName">Full Name <span class="required">*</span></label>
      <input type="text" id="holderName" placeholder="John Doe" required>

      <label for="phone">Phone Number <span class="required">*</span></label>
      <input type="tel" id="phone" placeholder="(555) 123-4567" required>

      <label for="plate">License Plate <span class="required">*</span></label>
      <input type="text" id="plate" class="plate-input" placeholder="ABC 1234" required maxlength="10" autocomplete="off">

      <label for="backPlate">Back Plate <span style="color:#6b7280;font-size:12px;">(if different)</span></label>
      <input type="text" id="backPlate" class="plate-input" placeholder="leave blank if same" maxlength="10" autocomplete="off">

      <button type="submit" class="submit-btn" id="submitBtn">Request Parking Pass</button>
      <div class="hint">PENDING OWNER APPROVAL</div>
      <div id="errorMsg"></div>
    </form>
  `;

  document.getElementById('regForm').addEventListener('submit', handleSubmit);
}

let submitting = false;
async function handleSubmit(e) {
  e.preventDefault();
  if (submitting) return;
  submitting = true;
  const btn = document.getElementById('submitBtn');
  const errorDiv = document.getElementById('errorMsg');
  errorDiv.innerHTML = '';
  btn.disabled = true;
  btn.textContent = 'Registering…';

  try {
    const holderName = document.getElementById('holderName').value.trim();
    const plateRaw = document.getElementById('plate').value.trim();
    const plateText = normalizePlate(plateRaw);
    const backPlateRaw = (document.getElementById('backPlate')?.value || '').trim();
    const backPlateText = backPlateRaw ? normalizePlate(backPlateRaw) : '';
    if (REGION_TOKENS.has(plateText)) throw new Error('That looks like a state, not a plate — enter the plate characters only.');
    if (backPlateText && REGION_TOKENS.has(backPlateText)) throw new Error('The back plate looks like a state name, not a plate — enter the plate characters only, or leave it blank.');
    if (backPlateText && backPlateText.length < 4) throw new Error('Back plate must be at least 4 characters, or leave it blank.');
    if (backPlateText && backPlateText === plateText) throw new Error('Back plate must differ from the front plate, or leave it blank.');
    const phone = document.getElementById('phone').value.trim();

    if (!plateText || plateText.length < 2) {
      throw new Error('Please enter a valid license plate number.');
    }

    const recaptchaToken = await getRecaptchaToken('plate_register').catch(() => null);
    if (!recaptchaToken) {
      throw new Error('Please retry — automated-access check failed.');
    }

    try {
      await backendRegister('/resident_plates/register', {
        property_id: property.id,
        plate_text: plateText,
        back_plate: backPlateText || null,
        holder_name: holderName,
        holder_role: 'resident',
        phone: phone,
        recaptcha_token: recaptchaToken,
      });
    } catch (error) {
      if (error.status === 409) {
        // Backend returns the friendly "already registered" message for
        // the (property, plate) uniqueness violation.
        throw new Error(error.detail || 'This license plate is already registered at this lot.');
      }
      throw error;
    }

    showSuccess(plateText);
  } catch (err) {
    errorDiv.innerHTML = '<div class="error">' + escapeHtml(friendlyErrorMessage(err)) + '</div>';
    btn.disabled = false;
    btn.textContent = 'Request Parking Pass';
    submitting = false;
  }
}

function showSuccess(plate) {
  app.innerHTML = `
    <div class="success-card">
      <div class="success-icon">
        <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
      </div>
      <h2>Request <em>submitted.</em></h2>
      <p>Your parking pass for <em>${escapeHtml(property.name)}</em> is queued. The owner gets a ping next.</p>
      <div class="success-plate">${escapeHtml(plate)}</div>
      <div class="pending-badge">Pending owner approval</div>
      <div class="success-detail">YOU'LL HEAR BACK ONCE IT'S APPROVED.</div>
    </div>
  `;
}

init();
