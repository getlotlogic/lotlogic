// ── The document card: one card per document, upload on select ─────────────
// Task F3 (the long-term parking-pass request on /apt/<qr>). Each document the
// office needs (photo of the plate, vehicle registration card, photo ID, lease,
// and the optional photo of the vehicle) gets its own card: a "make sure" line,
// Take photo / Choose buttons, then a thumbnail with progress, and Retake /
// Remove. The file is shrunk and uploaded the moment it is chosen, so "Send for
// review" only posts JSON with the keys.
//
// Three layers, in this order:
//   1. Pure: the card's state machine (`cardReducer`) and the helpers around it
//      (file checks, sizes, the backend's answers → an error code, the status
//      line). No DOM; imported by Node tests.
//   2. The slot (`createDocSlot`): runs the pipeline select → prepare → upload
//      → key for one card, keeping the prepared bytes in memory. The two
//      DOM-bound steps — decoding/resizing a photo and the XHR — are injected,
//      so the pipeline is testable in Node with fakes.
//   3. DOM: `prepareFile` (createImageBitmap / canvas resize to 2000 px, JPEG
//      0.85), `xhrUpload` (XMLHttpRequest for upload.onprogress — fetch has no
//      upload progress) and `mountDocCard` (the card's markup and events).
// Nothing runs at import time, so the module loads anywhere.

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // the backend's MAX_BYTES
export const MAX_EDGE = 2000;
export const JPEG_QUALITY = 0.85;

// The "Choose" input asks for these by name: iOS then hands over a JPEG even
// when the library holds HEIC, and Android's picker hides what Chrome cannot
// decode. The camera input is a single `image/*` (a list there sends Android
// Chrome to a generic chooser).
export const ACCEPT_IMAGES = 'image/jpeg,image/png,image/webp';
export const ACCEPT_IMAGES_AND_PDF = 'image/jpeg,image/png,image/webp,application/pdf';

const MB = 1024 * 1024;
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|heic|heif|avif|tiff?)$/i;
const HEIC_TYPES = new Set(['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']);
const RETRYABLE = new Set(['upload_failed', 'recaptcha']);
const REJECT_CODES = new Set(['wrong_type', 'too_large', 'heic', 'unreadable']);

// ── 1. pure ─────────────────────────────────────────────────────────────────

const BASE = Object.freeze({
  status: 'empty', // empty | preparing | uploading | done | restored | error | offline | skipped
  file: null,      // { name, size, type } of what was chosen (or saved)
  key: null,       // the object key /apartment/uploads returned
  loaded: 0,
  total: 0,
  error: null,     // an error code, see cardErrorMessage
  retryable: false,
  attempt: 0,      // bumps on every new phase; late events from an older one are dropped
  preview: false,  // true when local bytes can be drawn as a thumbnail
  source: null,    // 'camera' | 'files' — what Retake reopens
});

function meta(file) {
  if (!file) return null;
  return { name: String(file.name || ''), size: Number(file.size) || 0, type: String(file.type || '') };
}

const lowerType = (file) => String((file && file.type) || '').toLowerCase();
const fileName = (file) => String((file && file.name) || '');

/** HEIC/HEIF, by type or — since some pickers send no type — by name. */
export function isHeic(file) {
  return HEIC_TYPES.has(lowerType(file)) || /\.hei[cf]$/i.test(fileName(file));
}

export function isPdf(file) {
  return lowerType(file) === 'application/pdf' || /\.pdf$/i.test(fileName(file));
}

function isImage(file) {
  return lowerType(file).startsWith('image/') || IMAGE_EXT.test(fileName(file));
}

/**
 * The checks made before anything is read. A photo of any size goes on to be
 * shrunk (a 14 MB photo becomes ~1 MB); a PDF is sent as it is, so it is held
 * to the 10 MB limit here.
 * @returns {null|'wrong_type'|'too_large'|'unreadable'}
 */
export function precheck(file, { imagesOnly = false } = {}) {
  if (!file || !(Number(file.size) > 0)) return 'unreadable';
  if (isPdf(file)) {
    if (imagesOnly) return 'wrong_type';
    return file.size > MAX_UPLOAD_BYTES ? 'too_large' : null;
  }
  return isImage(file) ? null : 'wrong_type';
}

/** Why a photo that would not decode is refused: an HEIC needs a JPG or PNG. */
export function decodeFailureCode(file) {
  return isHeic(file) ? 'heic' : 'unreadable';
}

/** Fit the long edge to `maxEdge` px; never enlarge, never round a side to 0. */
export function targetSize(width, height, maxEdge = MAX_EDGE) {
  const long = Math.max(width, height);
  if (long <= maxEdge) return { width, height };
  const scale = maxEdge / long;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < MB) return `${Math.max(1, Math.round(n / 1024))} KB`;
  const mb = Math.round((n / MB) * 10) / 10;
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}

/** The upload is named by kind so the backend keeps a real extension (never .bin). */
export function uploadFilename(kind, type) {
  return `${kind}.${type === 'application/pdf' ? 'pdf' : 'jpg'}`;
}

/** 30 s, plus 30 s a megabyte (slow mobile data), at most 5 minutes. */
export function uploadTimeoutMs(bytes) {
  return Math.min(300_000, 30_000 + Math.round(((Number(bytes) || 0) / MB) * 30_000));
}

/**
 * What went wrong with one upload, as a card error code.
 * @param {{status?: number, body?: any, code?: string, network?: boolean, timeout?: boolean, online?: boolean}} [r]
 */
export function classifyUploadFailure(r) {
  const res = r || {};
  if (res.code === 'recaptcha' || res.code === 'recaptcha_blocked') return 'recaptcha';
  if (res.network || res.timeout) return res.online === false ? 'offline' : 'upload_failed';
  const detail = res.body && typeof res.body.detail === 'string' ? res.body.detail : '';
  if (detail.startsWith('recaptcha:')) return 'recaptcha';
  if (res.status === 413 || detail === 'file too large') return 'too_large';
  if (detail === 'unsupported file type') return 'wrong_type';
  // TEMPORARY (remove with the register retry in apt.js once backend tasks B1
  // and B3 are live): an older backend has no "registration" or "vehicle" kind.
  if (detail === 'invalid kind') return 'unsupported_kind';
  if (detail === 'empty file') return 'unreadable';
  return 'upload_failed';
}

/** A fresh card, or one restored from a saved key ("Uploaded earlier", no thumbnail). */
export function initialCardState(ref = null) {
  if (ref && typeof ref.key === 'string' && ref.key) {
    return {
      ...BASE,
      status: 'restored',
      key: ref.key,
      file: { name: String(ref.name || ''), size: Number(ref.size) || 0, type: String(ref.type || '') },
    };
  }
  return { ...BASE };
}

export function cardReducer(state, ev) {
  switch (ev && ev.type) {
    case 'select':
      return { ...BASE, status: 'preparing', file: meta(ev.file), source: ev.source || null, attempt: state.attempt + 1 };
    case 'reject':
      return { ...state, status: 'error', error: ev.error, retryable: false, key: null, preview: false, loaded: 0, total: 0 };
    case 'prepared': {
      const file = meta(ev.file) || state.file;
      return {
        ...state, status: 'uploading', file, preview: !!ev.preview, loaded: 0, total: file ? file.size : 0,
        key: null, error: null, retryable: false, attempt: state.attempt + 1,
      };
    }
    case 'progress':
      if (state.status !== 'uploading' || ev.attempt !== state.attempt) return state;
      return { ...state, loaded: Number(ev.loaded) || 0, total: Number(ev.total) || state.total };
    case 'uploaded':
      if (state.status !== 'uploading' || ev.attempt !== state.attempt) return state;
      return { ...state, status: 'done', key: ev.key, loaded: state.total, error: null };
    case 'failed':
      if (state.status !== 'uploading' || ev.attempt !== state.attempt) return state;
      if (ev.error === 'offline') return { ...state, status: 'offline', loaded: 0 };
      if (ev.error === 'unsupported_kind') return { ...state, status: 'skipped', key: null };
      return { ...state, status: 'error', error: ev.error, retryable: RETRYABLE.has(ev.error), loaded: 0 };
    case 'resume':
      if (state.status === 'offline' || (state.status === 'error' && state.retryable)) {
        return { ...state, status: 'uploading', loaded: 0, error: null, retryable: false, attempt: state.attempt + 1 };
      }
      return state;
    case 'remove':
      return { ...BASE, attempt: state.attempt + 1 };
    case 'restore':
      return { ...initialCardState(ev.ref), attempt: state.attempt + 1 };
    default:
      return state;
  }
}

/** The document is in hand: uploaded now, uploaded earlier, or skipped (older backend). */
export function isSatisfied(state) {
  return !!state && (state.status === 'done' || state.status === 'restored' || state.status === 'skipped');
}

/** Still on its way: Continue waits ("Finishing upload…") rather than failing. */
export function isBusy(state) {
  return !!state && (state.status === 'preparing' || state.status === 'uploading' || state.status === 'offline');
}

export function cardErrorMessage(code, strings, { imagesOnly = false } = {}) {
  const e = strings.errors;
  switch (code) {
    case 'wrong_type': return imagesOnly ? e.wrongTypeImages : e.wrongType;
    case 'too_large': return e.tooLarge;
    case 'heic': return e.heic;
    case 'unreadable': return e.unreadable;
    case 'recaptcha': return e.recaptcha;
    default: return e.uploadFailed;
  }
}

/** The card's status line. */
export function cardStatusText(state, strings, { imagesOnly = false } = {}) {
  switch (state && state.status) {
    case 'preparing':
      return isPdf(state.file) ? strings.preparingFile : strings.preparing;
    case 'uploading': {
      const total = state.total || (state.file && state.file.size) || 0;
      const pct = total ? Math.min(100, Math.round((state.loaded / total) * 100)) : 0;
      return strings.uploading(formatBytes(total), pct);
    }
    case 'done': return strings.uploaded;
    case 'restored': return strings.uploadedEarlier;
    case 'offline': return strings.paused;
    case 'skipped': return strings.skipped;
    case 'error': return cardErrorMessage(state.error, strings, { imagesOnly });
    default: return '';
  }
}

/** What a screen reader hears when the card changes phase (no running percent). */
export function cardAnnouncement(state, strings, opts = {}) {
  if (state && state.status === 'uploading') {
    return strings.uploadingAnnounce(formatBytes(state.total || (state.file && state.file.size) || 0));
  }
  return cardStatusText(state, strings, opts);
}

// ── 2. the slot ─────────────────────────────────────────────────────────────

/**
 * One card's pipeline. `prepare(file)` resolves `{blob, name, size, type,
 * preview}` (or throws when the photo will not decode); `upload(blob, {kind,
 * filename, timeoutMs, onProgress})` resolves `{status, body}` or throws an
 * error carrying `network`, `timeout` or `code: 'recaptcha'|'recaptcha_blocked'`.
 */
export function createDocSlot({
  kind, imagesOnly = false, initial = null, prepare, upload, isOnline = () => true, onChange = null,
} = {}) {
  let state = initialCardState(initial);
  let blob = null;
  let blobType = null;
  const listeners = new Set();
  let waiters = [];

  function set(next) {
    if (next === state) return;
    state = next;
    for (const fn of [...listeners]) fn(state);
    if (onChange) onChange(state);
    if (!isBusy(state) && waiters.length) {
      const ready = waiters;
      waiters = [];
      for (const resolve of ready) resolve(state);
    }
  }
  const dispatch = (ev) => set(cardReducer(state, ev));

  async function send() {
    if (state.status !== 'uploading') return;
    const attempt = state.attempt;
    if (!isOnline()) {
      dispatch({ type: 'failed', attempt, error: 'offline' });
      return;
    }
    let res;
    try {
      res = await upload(blob, {
        kind,
        filename: uploadFilename(kind, blobType),
        timeoutMs: uploadTimeoutMs((blob && blob.size) || state.total),
        onProgress: (loaded, total) => dispatch({ type: 'progress', attempt, loaded, total }),
      });
    } catch (err) {
      dispatch({
        type: 'failed', attempt,
        error: classifyUploadFailure({
          code: err && typeof err.code === 'string' ? err.code : undefined,
          network: !!(err && err.network),
          timeout: !!(err && err.timeout),
          online: isOnline(),
        }),
      });
      return;
    }
    const ok = res && res.status >= 200 && res.status < 300 && res.body && typeof res.body.key === 'string' && res.body.key;
    if (ok) dispatch({ type: 'uploaded', attempt, key: res.body.key });
    else dispatch({ type: 'failed', attempt, error: classifyUploadFailure(res) });
  }

  async function select(file, source) {
    blob = null;
    blobType = null;
    dispatch({ type: 'select', file, source });
    const attempt = state.attempt;
    const refused = precheck(file, { imagesOnly });
    if (refused) {
      dispatch({ type: 'reject', error: refused });
      return;
    }
    let prepared;
    try {
      prepared = await prepare(file);
    } catch (err) {
      if (state.attempt !== attempt) return;
      const code = err && typeof err.code === 'string' && REJECT_CODES.has(err.code) ? err.code : decodeFailureCode(file);
      dispatch({ type: 'reject', error: code });
      return;
    }
    if (state.attempt !== attempt) return; // a newer photo, or Remove, while this one was being prepared
    if (!prepared || !(prepared.size > 0)) {
      dispatch({ type: 'reject', error: 'unreadable' });
      return;
    }
    if (prepared.size > MAX_UPLOAD_BYTES) {
      dispatch({ type: 'reject', error: 'too_large' });
      return;
    }
    blob = prepared.blob;
    blobType = prepared.type;
    dispatch({
      type: 'prepared',
      file: { name: prepared.name || fileName(file), size: prepared.size, type: prepared.type },
      preview: !!prepared.preview,
    });
    await send();
  }

  return {
    kind,
    imagesOnly,
    get state() { return state; },
    get blob() { return blob; },
    select,
    retry() {
      if (state.status === 'error' && state.retryable && blob) {
        dispatch({ type: 'resume' });
        return send();
      }
      return Promise.resolve();
    },
    online() {
      if (state.status === 'offline' && blob) {
        dispatch({ type: 'resume' });
        return send();
      }
      return Promise.resolve();
    },
    remove() {
      blob = null;
      blobType = null;
      dispatch({ type: 'remove' });
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Resolves with the state once nothing is preparing, uploading or paused. */
    settled() {
      if (!isBusy(state)) return Promise.resolve(state);
      return new Promise((resolve) => { waiters.push(resolve); });
    },
  };
}

// ── 3. DOM ──────────────────────────────────────────────────────────────────

/**
 * Turn a chosen file into what is uploaded. A PDF goes as it is. A photo is
 * decoded (EXIF orientation applied), shrunk to 2000 px on its long edge and
 * re-encoded as JPEG 0.85 — which also drops its EXIF, location included. A
 * photo the browser cannot decode (HEIC on Chrome/Android) throws, and the
 * card refuses it rather than sending a document the office cannot open.
 */
export async function prepareFile(file) {
  if (isPdf(file)) {
    return { blob: file, name: fileName(file), size: file.size, type: 'application/pdf', preview: false };
  }
  const blob = await shrinkPhoto(file);
  return { blob, name: fileName(file), size: blob.size, type: 'image/jpeg', preview: true };
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => (img.naturalWidth > 0 ? resolve(img) : reject(new Error('empty image')));
    img.onerror = () => reject(new Error('the image could not be decoded'));
    img.src = url;
  });
}

async function shrinkPhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    // <img> reports the EXIF-oriented size and decodes lazily, so this is cheap.
    const img = await loadImage(url);
    const { width, height } = targetSize(img.naturalWidth, img.naturalHeight);
    let source = img;
    if (typeof createImageBitmap === 'function') {
      // Decoding at the target size spares a low-memory phone the full
      // 12-megapixel bitmap. A browser without `imageOrientation: 'from-image'`
      // throws on the option; one that resized before rotating returns the
      // wrong shape. Either way the <img>, which is EXIF-correct, is drawn.
      try {
        const bitmap = await createImageBitmap(file, {
          imageOrientation: 'from-image', resizeWidth: width, resizeHeight: height, resizeQuality: 'high',
        });
        if (Math.abs(bitmap.width / bitmap.height - width / height) < 0.02) source = bitmap;
        else if (bitmap.close) bitmap.close();
      } catch { /* draw the <img> */ }
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; // a transparent PNG becomes white, not black
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(source, 0, 0, width, height);
    if (source !== img && source.close) source.close();
    return await new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('the photo could not be encoded'))), 'image/jpeg', JPEG_QUALITY);
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * POST a FormData with XMLHttpRequest, reporting upload progress. Resolves
 * `{status, body}` for any HTTP answer; rejects with `network` or `timeout`.
 */
export function xhrUpload(url, form, { onProgress, timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.timeout = timeoutMs;
    if (onProgress && xhr.upload) {
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded, e.total); };
    }
    xhr.onload = () => {
      let body = null;
      try { body = xhr.responseText ? JSON.parse(xhr.responseText) : null; } catch { body = null; }
      resolve({ status: xhr.status, body });
    };
    xhr.onerror = () => reject(Object.assign(new Error('network error'), { network: true }));
    xhr.onabort = () => reject(Object.assign(new Error('upload aborted'), { network: true }));
    xhr.ontimeout = () => reject(Object.assign(new Error('upload timed out'), { timeout: true }));
    xhr.send(form);
  });
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Line-art schematics of each document (decorative; the title says what it is).
const SCHEMATICS = {
  plate: '<rect x="4" y="8" width="64" height="32" rx="4"/><circle cx="13" cy="14" r="1.4"/><circle cx="59" cy="14" r="1.4"/><rect x="15" y="19" width="42" height="11" rx="2"/><path d="M28 35h16"/>',
  // the back of a car: the whole car, plate in view
  vehicle: '<path d="M20 8h32l6 12H14z"/><rect x="8" y="20" width="56" height="18" rx="3"/><rect x="12" y="24" width="8" height="4" rx="1"/><rect x="52" y="24" width="8" height="4" rx="1"/><rect x="28" y="28" width="16" height="7" rx="1"/><path d="M12 38v5h8v-5M52 38v5h8v-5"/>',
  card: '<rect x="4" y="6" width="64" height="36" rx="3"/><path d="M12 15h28M12 22h40M12 29h34M12 36h18"/>',
  id: '<rect x="4" y="6" width="64" height="36" rx="3"/><circle cx="20" cy="21" r="6"/><path d="M11 36c2-5 6-7 9-7s7 2 9 7M36 16h24M36 23h20M36 30h16"/>',
  lease: '<path d="M18 2h28l10 10v34H18z"/><path d="M46 2v10h10M24 18h24M24 25h24M24 32h18M24 39h12"/>',
};

function schematicSvg(name) {
  return `<svg class="doc-schematic" viewBox="0 0 72 48" width="72" height="48" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${SCHEMATICS[name] || SCHEMATICS.card}</svg>`;
}

const ICON_CAMERA = '<svg class="btn-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/></svg>';
const ICON_CHECK = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M20 6 9 17l-5-5"/></svg>';
const ICON_CHECK_SQUARE = '<svg class="doc-check" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="1.5" y="1.5" width="13" height="13" rx="1"/><path d="M4.5 8.2l2.3 2.3 4.7-5"/></svg>';
const ICON_DOC = '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M6 2h9l5 5v15H6z"/><path d="M15 2v5h5"/></svg>';

/**
 * Draw one card into `container` and keep it in step with `slot`.
 * @param {HTMLElement} container
 * @param {ReturnType<typeof createDocSlot>} slot
 * @param {{id: string, title: string, optional?: boolean, note?: string, makeSure?: string[], sizeLine: string,
 *          schematic: string, strings: any, question?: () => (string|null)}} view
 *   `optional`: "(optional)" after the title, and Remove in an error state (an
 *   optional card that failed must not hold the request up).
 * @returns {{refresh: () => void, destroy: () => void, focus: () => void}}
 */
export function mountDocCard(container, slot, view) {
  const S = view.strings;
  const id = view.id;
  const imagesOnly = !!slot.imagesOnly;
  const optional = !!view.optional;
  container.innerHTML = `
    <section class="doc-card" id="${esc(id)}" tabindex="-1" aria-labelledby="${esc(id)}-title">
      <h2 class="doc-title" id="${esc(id)}-title">${esc(view.title)}${optional ? ` <span class="doc-optional">${esc(S.optional)}</span>` : ''}</h2>
      ${view.note ? `<p class="doc-note">${esc(view.note)}</p>` : ''}
      ${view.makeSure && view.makeSure.length ? `<ul class="doc-checks">${view.makeSure.map((m) => `<li>${ICON_CHECK_SQUARE}<span>${esc(m)}</span></li>`).join('')}</ul>` : ''}
      <div class="doc-body"></div>
      <p class="visually-hidden doc-live" role="status" aria-atomic="true"></p>
      <input type="file" class="doc-input" data-input="camera" accept="image/*" capture="environment" tabindex="-1" aria-hidden="true">
      <input type="file" class="doc-input" data-input="files" accept="${imagesOnly ? ACCEPT_IMAGES : ACCEPT_IMAGES_AND_PDF}" tabindex="-1" aria-hidden="true">
    </section>`;
  const card = container.querySelector('.doc-card');
  const body = card.querySelector('.doc-body');
  const live = card.querySelector('.doc-live');
  const inputs = { camera: card.querySelector('[data-input=camera]'), files: card.querySelector('[data-input=files]') };
  let thumbUrl = null;
  let shownStatus = null;
  let shownBlob = null;

  const fine = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(pointer: fine)').matches;

  function pickButtons(chooseLabel) {
    return `
      <div class="doc-pick">
        ${schematicSvg(view.schematic)}
        <div class="doc-buttons">
          <button type="button" class="btn-secondary doc-take" data-act="take">${ICON_CAMERA}<span>${esc(S.takePhoto)}</span></button>
          <button type="button" class="btn-outline doc-choose" data-act="choose"><span class="label-coarse">${esc(chooseLabel)}</span><span class="label-fine">${esc(S.chooseFine)}</span></button>
        </div>
      </div>
      <p class="doc-size">${esc(view.sizeLine)}</p>`;
  }

  function fileRow(state) {
    const name = state.file && state.file.name ? state.file.name : '';
    let tile = '';
    if (state.preview && slot.blob) {
      if (shownBlob !== slot.blob) {
        if (thumbUrl) URL.revokeObjectURL(thumbUrl);
        thumbUrl = URL.createObjectURL(slot.blob);
        shownBlob = slot.blob;
      }
      tile = `<img class="doc-thumb" src="${esc(thumbUrl)}" alt="" width="96" height="72">`;
    } else if (state.file && isPdf(state.file)) {
      tile = `<span class="doc-thumb doc-glyph" aria-hidden="true">${ICON_DOC}<span>${esc(S.pdf)}</span></span>`;
    }
    return `
      <div class="doc-file${tile ? '' : ' no-tile'}">
        ${tile}
        <div class="doc-meta">
          ${name ? `<p class="doc-name">${esc(name)}</p>` : ''}
          <div class="doc-progress" aria-hidden="true"><span class="doc-bar"></span></div>
          <p class="doc-line" aria-hidden="true"></p>
        </div>
      </div>`;
  }

  function renderBody(state) {
    const status = state.status;
    if (status === 'empty') {
      body.innerHTML = pickButtons(S.choose);
    } else if (status === 'error' || status === 'skipped') {
      const msg = cardStatusText(state, S, { imagesOnly });
      body.innerHTML = `
        <p class="${status === 'error' ? 'doc-error' : 'doc-skipped'}">${status === 'error' ? `<span class="visually-hidden">${esc(S.errorPrefix)} </span>` : ''}${esc(msg)}</p>
        ${status === 'error' && state.retryable ? `<button type="button" class="btn-secondary doc-retry" data-act="retry">${esc(S.retry)}</button>` : ''}
        ${pickButtons(S.chooseOther)}
        ${status === 'error' && optional ? `<div class="doc-actions"><button type="button" class="text-btn danger" data-act="remove">${esc(S.remove)}</button></div>` : ''}`;
    } else if (status === 'done' || status === 'restored') {
      body.innerHTML = `
        ${fileRow(state)}
        <p class="doc-question" hidden></p>
        <div class="doc-actions">
          <button type="button" class="text-btn" data-act="retake">${esc(S.retake)}</button>
          <button type="button" class="text-btn danger" data-act="remove">${esc(S.remove)}</button>
        </div>`;
    } else {
      // preparing, uploading, offline
      body.innerHTML = `${fileRow(state)}${status === 'offline' ? `<p class="doc-paused">${esc(S.paused)}</p>` : ''}`;
    }
  }

  function update() {
    const state = slot.state;
    const changed = state.status !== shownStatus || (state.preview && slot.blob !== shownBlob);
    const hadFocus = card.contains(document.activeElement) && document.activeElement !== card;
    if (changed) {
      renderBody(state);
      card.dataset.status = state.status;
      live.textContent = cardAnnouncement(state, S, { imagesOnly });
      shownStatus = state.status;
      if (hadFocus && !card.contains(document.activeElement)) {
        const next = body.querySelector('button:not([hidden])');
        (next && next.offsetParent !== null ? next : card).focus();
      }
    }
    const bar = body.querySelector('.doc-bar');
    const line = body.querySelector('.doc-line');
    const progress = body.querySelector('.doc-progress');
    if (bar && progress) {
      const busy = state.status === 'uploading' || state.status === 'preparing';
      progress.hidden = !(busy || state.status === 'offline');
      progress.classList.toggle('is-indeterminate', state.status === 'preparing');
      const pct = state.total ? Math.min(100, Math.round((state.loaded / state.total) * 100)) : 0;
      bar.style.width = state.status === 'uploading' ? `${pct}%` : (state.status === 'preparing' ? '' : '0%');
    }
    if (line) {
      const done = state.status === 'done' || state.status === 'restored';
      line.innerHTML = done
        ? `<span class="doc-ok">${ICON_CHECK}${esc(cardStatusText(state, S))}</span>${state.file && state.file.size ? ` <span class="doc-bytes">${esc(formatBytes(state.file.size))}</span>` : ''}`
        : esc(state.status === 'offline' ? '' : cardStatusText(state, S, { imagesOnly }));
    }
    const q = body.querySelector('.doc-question');
    if (q) {
      const text = state.status === 'done' && state.preview && view.question ? view.question() : null;
      q.hidden = !text;
      q.textContent = text || '';
    }
  }

  function open(which) {
    const input = inputs[which] || inputs.files;
    input.click();
  }

  function onClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn || !card.contains(btn)) return;
    const act = btn.dataset.act;
    if (act === 'take') open('camera');
    else if (act === 'choose') open('files');
    else if (act === 'retry') slot.retry();
    else if (act === 'remove') slot.remove();
    else if (act === 'retake') open(fine() || slot.state.source === 'files' ? 'files' : 'camera');
  }

  function onPick(e) {
    const input = e.target;
    const file = input.files && input.files[0];
    const source = input.dataset.input;
    input.value = ''; // choosing the same file again still fires `change`
    if (file) slot.select(file, source);
  }

  card.addEventListener('click', onClick);
  inputs.camera.addEventListener('change', onPick);
  inputs.files.addEventListener('change', onPick);
  const unsubscribe = slot.subscribe(update);
  update();

  return {
    refresh: update,
    focus() {
      const first = body.querySelector('button');
      (first && first.offsetParent !== null ? first : card).focus();
    },
    destroy() {
      unsubscribe();
      card.removeEventListener('click', onClick);
      if (thumbUrl) URL.revokeObjectURL(thumbUrl);
      thumbUrl = null;
    },
  };
}

/**
 * A small tile for summary rows (S3b, S5): the photo from the slot's bytes, a
 * "PDF" tile for a PDF, or '' — for a card not uploaded (a skipped one is not
 * part of the request) or restored from a saved key (no bytes on this phone).
 */
export function thumbnailHtml(slot, { width = 56, height = 42, className = 'row-thumb' } = {}) {
  if (!slot || !(slot.state.status === 'done' || slot.state.status === 'restored')) return '';
  if (slot.state.file && isPdf(slot.state.file)) {
    return `<span class="${esc(className)} row-glyph" aria-hidden="true">PDF</span>`;
  }
  if (!slot.blob || !slot.state.preview) return '';
  const url = URL.createObjectURL(slot.blob);
  return `<img class="${esc(className)}" src="${esc(url)}" alt="" width="${width}" height="${height}" data-object-url="1">`;
}
