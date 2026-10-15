// Task F3 — the document card (src/shared/docCard.js): one card per document,
// upload on select. jsdom is not installed, so this tests the card's pure
// state machine and helpers, and the upload "slot" that drives it, with the
// two DOM-bound steps (decode/resize, XHR) injected as fakes. The DOM view
// (mountDocCard), the canvas/createImageBitmap resize (prepareFile) and the
// XHR transport (xhrUpload) are exercised by tests/e2e/apt-flow.spec.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_UPLOAD_BYTES, initialCardState, cardReducer, isSatisfied, isBusy,
  precheck, isHeic, isPdf, decodeFailureCode, targetSize, formatBytes,
  classifyUploadFailure, uploadTimeoutMs, uploadFilename, cardStatusText,
  createDocSlot, thumbnailHtml,
} from '../src/shared/docCard.js';
import { STRINGS } from '../src/shared/aptFlow.js';

const T = STRINGS.en.card;
const MB = 1024 * 1024;
const jpg = (size = 3 * MB, name = 'IMG_2041.jpg') => ({ name, size, type: 'image/jpeg' });
const pdf = (size = 2 * MB, name = 'lease.pdf') => ({ name, size, type: 'application/pdf' });
const heic = (name = 'IMG_2042.HEIC', type = 'image/heic') => ({ name, size: 2 * MB, type });
const KEY = `apt/11111111-2222-4333-8444-555555555555/plate/${'b'.repeat(32)}.jpg`;

// ── the state machine ───────────────────────────────────────────────────────

test('a card starts empty, or "restored" from a saved key', () => {
  const empty = initialCardState();
  assert.equal(empty.status, 'empty');
  assert.equal(empty.key, null);
  const restored = initialCardState({ key: KEY, name: 'plate.jpg', size: 900_000, type: 'image/jpeg' });
  assert.equal(restored.status, 'restored');
  assert.equal(restored.key, KEY);
  assert.equal(restored.preview, false, 'no local bytes, so no thumbnail');
  assert.deepEqual(restored.file, { name: 'plate.jpg', size: 900_000, type: 'image/jpeg' });
});

test('select → preparing → uploading → done', () => {
  let s = initialCardState();
  s = cardReducer(s, { type: 'select', file: jpg(), source: 'camera' });
  assert.equal(s.status, 'preparing');
  assert.equal(s.source, 'camera');
  s = cardReducer(s, { type: 'prepared', file: { name: 'IMG_2041.jpg', size: 800_000, type: 'image/jpeg' }, preview: true });
  assert.equal(s.status, 'uploading');
  assert.equal(s.total, 800_000);
  assert.equal(s.loaded, 0);
  assert.equal(s.preview, true);
  s = cardReducer(s, { type: 'progress', attempt: s.attempt, loaded: 400_000, total: 800_000 });
  assert.equal(s.loaded, 400_000);
  s = cardReducer(s, { type: 'uploaded', attempt: s.attempt, key: KEY });
  assert.equal(s.status, 'done');
  assert.equal(s.key, KEY);
  assert.equal(isSatisfied(s), true);
});

test('events from an older attempt are ignored', () => {
  let s = cardReducer(initialCardState(), { type: 'select', file: jpg() });
  s = cardReducer(s, { type: 'prepared', file: jpg(800_000), preview: true });
  const old = s.attempt;
  s = cardReducer(s, { type: 'select', file: jpg(1 * MB, 'second.jpg') }); // a new photo while the first uploads
  assert.equal(cardReducer(s, { type: 'uploaded', attempt: old, key: KEY }), s, 'the first upload finishing must not win');
  assert.equal(cardReducer(s, { type: 'progress', attempt: old, loaded: 1, total: 2 }), s);
  assert.equal(cardReducer(s, { type: 'failed', attempt: old, error: 'upload_failed' }), s);
});

test('a failed upload is retryable; resume starts a new attempt from zero', () => {
  let s = cardReducer(initialCardState(), { type: 'select', file: jpg() });
  s = cardReducer(s, { type: 'prepared', file: jpg(800_000), preview: true });
  s = cardReducer(s, { type: 'progress', attempt: s.attempt, loaded: 700_000, total: 800_000 });
  s = cardReducer(s, { type: 'failed', attempt: s.attempt, error: 'upload_failed' });
  assert.equal(s.status, 'error');
  assert.equal(s.retryable, true);
  const before = s.attempt;
  s = cardReducer(s, { type: 'resume' });
  assert.equal(s.status, 'uploading');
  assert.equal(s.attempt, before + 1);
  assert.equal(s.loaded, 0, 'an XHR multipart upload restarts from zero');
});

test('offline pauses the card; resume restarts it', () => {
  let s = cardReducer(initialCardState(), { type: 'select', file: jpg() });
  s = cardReducer(s, { type: 'prepared', file: jpg(800_000), preview: true });
  s = cardReducer(s, { type: 'failed', attempt: s.attempt, error: 'offline' });
  assert.equal(s.status, 'offline');
  assert.equal(isBusy(s), true, 'a paused upload is still on its way');
  assert.equal(isSatisfied(s), false);
  s = cardReducer(s, { type: 'resume' });
  assert.equal(s.status, 'uploading');
});

test('resume does nothing to a card that is not paused or retryable', () => {
  for (const status of ['empty', 'done', 'restored']) {
    const s = { ...initialCardState(), status };
    assert.equal(cardReducer(s, { type: 'resume' }), s, status);
  }
  const blocked = { ...initialCardState(), status: 'error', error: 'heic', retryable: false };
  assert.equal(cardReducer(blocked, { type: 'resume' }), blocked);
});

test('a refused file is an error the user fixes by choosing again, not by retrying', () => {
  for (const error of ['wrong_type', 'too_large', 'heic', 'unreadable']) {
    const s = cardReducer(cardReducer(initialCardState(), { type: 'select', file: jpg() }), { type: 'reject', error });
    assert.equal(s.status, 'error', error);
    assert.equal(s.retryable, false, error);
    assert.equal(s.key, null);
  }
});

test('"invalid kind" from an older backend skips the card instead of blocking the request', () => {
  let s = cardReducer(initialCardState(), { type: 'select', file: pdf() });
  s = cardReducer(s, { type: 'prepared', file: pdf(), preview: false });
  s = cardReducer(s, { type: 'failed', attempt: s.attempt, error: 'unsupported_kind' });
  assert.equal(s.status, 'skipped');
  assert.equal(isSatisfied(s), true);
  assert.equal(s.key, null);
});

test('remove empties the card and invalidates anything in flight', () => {
  let s = cardReducer(initialCardState(), { type: 'select', file: jpg() });
  s = cardReducer(s, { type: 'prepared', file: jpg(800_000), preview: true });
  const inflight = s.attempt;
  s = cardReducer(s, { type: 'remove' });
  assert.equal(s.status, 'empty');
  assert.equal(s.key, null);
  assert.equal(cardReducer(s, { type: 'uploaded', attempt: inflight, key: KEY }), s);
});

test('a done card can be replaced by a new photo (Retake)', () => {
  let s = { ...initialCardState(), status: 'done', key: KEY, file: jpg() };
  s = cardReducer(s, { type: 'select', file: jpg(2 * MB, 'retake.jpg'), source: 'camera' });
  assert.equal(s.status, 'preparing');
  assert.equal(s.key, null, 'the old key is not sent with a new photo');
});

test('isSatisfied and isBusy for every status', () => {
  const sat = { empty: false, preparing: false, uploading: false, offline: false, error: false, done: true, restored: true, skipped: true };
  const busy = { empty: false, preparing: true, uploading: true, offline: true, error: false, done: false, restored: false, skipped: false };
  for (const status of Object.keys(sat)) {
    const s = { ...initialCardState(), status };
    assert.equal(isSatisfied(s), sat[status], `isSatisfied(${status})`);
    assert.equal(isBusy(s), busy[status], `isBusy(${status})`);
  }
});

// ── file checks ─────────────────────────────────────────────────────────────

test('precheck: photos for the plate card, photos or PDFs elsewhere', () => {
  assert.equal(precheck(jpg(), { imagesOnly: true }), null);
  assert.equal(precheck(pdf(), { imagesOnly: true }), 'wrong_type');
  assert.equal(precheck(pdf(), { imagesOnly: false }), null);
  assert.equal(precheck({ name: 'notes.txt', size: 10, type: 'text/plain' }, {}), 'wrong_type');
  assert.equal(precheck({ name: 'x.docx', size: 10, type: '' }, {}), 'wrong_type');
});

test('precheck: a PDF over 10 MB is refused before upload; a big photo is shrunk first', () => {
  assert.equal(MAX_UPLOAD_BYTES, 10 * MB);
  assert.equal(precheck(pdf(10 * MB + 1), {}), 'too_large');
  assert.equal(precheck(pdf(10 * MB), {}), null);
  assert.equal(precheck(jpg(14 * MB), { imagesOnly: true }), null, 'a 14 MB photo is resized to ~1 MB before it is sent');
  assert.equal(precheck({ name: 'empty.jpg', size: 0, type: 'image/jpeg' }, {}), 'unreadable');
});

test('HEIC is recognised by type or by name (some pickers send no type)', () => {
  assert.equal(isHeic(heic()), true);
  assert.equal(isHeic(heic('IMG.heif', 'image/heif')), true);
  assert.equal(isHeic(heic('IMG_1.HEIC', '')), true);
  assert.equal(isHeic(jpg()), false);
  assert.equal(precheck(heic(), { imagesOnly: true }), null, 'Safari can decode it; the decode step decides');
  assert.equal(precheck(heic('IMG_1.HEIC', ''), { imagesOnly: true }), null);
});

test('a photo that cannot be decoded: HEIC says "choose a JPG or PNG"; others are unreadable', () => {
  assert.equal(decodeFailureCode(heic()), 'heic');
  assert.equal(decodeFailureCode(jpg()), 'unreadable');
  assert.equal(isPdf(pdf()), true);
  assert.equal(isPdf({ name: 'LEASE.PDF', size: 1, type: '' }), true);
  assert.equal(isPdf(jpg()), false);
});

test('targetSize fits the long edge to 2000 px and never enlarges', () => {
  assert.deepEqual(targetSize(4032, 3024), { width: 2000, height: 1500 });
  assert.deepEqual(targetSize(3024, 4032), { width: 1500, height: 2000 });
  assert.deepEqual(targetSize(800, 600), { width: 800, height: 600 });
  assert.deepEqual(targetSize(2000, 2000), { width: 2000, height: 2000 });
  assert.deepEqual(targetSize(1, 1), { width: 1, height: 1 });
  assert.deepEqual(targetSize(4000, 3), { width: 2000, height: 2 }, 'never rounds a side to zero');
});

test('formatBytes shows KB under a megabyte and one decimal above', () => {
  assert.equal(formatBytes(340 * 1024), '340 KB');
  assert.equal(formatBytes(500), '1 KB');
  assert.equal(formatBytes(2.1 * MB), '2.1 MB');
  assert.equal(formatBytes(10 * MB), '10 MB');
});

test('the upload names the file by kind, so the backend keeps a real extension', () => {
  assert.equal(uploadFilename('plate', 'image/jpeg'), 'plate.jpg');
  assert.equal(uploadFilename('lease', 'application/pdf'), 'lease.pdf');
  assert.equal(uploadFilename('registration', 'image/jpeg'), 'registration.jpg');
  assert.equal(uploadFilename('vehicle', 'image/jpeg'), 'vehicle.jpg');
});

test('the upload timeout grows with the file, within limits', () => {
  assert.equal(uploadTimeoutMs(0), 30_000);
  assert.equal(uploadTimeoutMs(1 * MB), 60_000);
  assert.equal(uploadTimeoutMs(10 * MB), 300_000);
});

// ── upload failures ─────────────────────────────────────────────────────────

test('classifyUploadFailure maps the backend\'s answers', () => {
  assert.equal(classifyUploadFailure({ status: 400, body: { detail: 'recaptcha:low_score' } }), 'recaptcha');
  assert.equal(classifyUploadFailure({ code: 'recaptcha' }), 'recaptcha');
  assert.equal(classifyUploadFailure({ code: 'recaptcha_blocked' }), 'recaptcha');
  assert.equal(classifyUploadFailure({ status: 413, body: { detail: 'file too large' } }), 'too_large');
  assert.equal(classifyUploadFailure({ status: 400, body: { detail: 'unsupported file type' } }), 'wrong_type');
  assert.equal(classifyUploadFailure({ status: 400, body: { detail: 'invalid kind' } }), 'unsupported_kind');
  assert.equal(classifyUploadFailure({ status: 400, body: { detail: 'empty file' } }), 'unreadable');
  assert.equal(classifyUploadFailure({ status: 502, body: { detail: 'upload failed' } }), 'upload_failed');
  assert.equal(classifyUploadFailure({ status: 200, body: {} }), 'upload_failed', 'no key is a failure');
  assert.equal(classifyUploadFailure({ network: true, online: false }), 'offline');
  assert.equal(classifyUploadFailure({ network: true, online: true }), 'upload_failed');
  assert.equal(classifyUploadFailure({ timeout: true, online: true }), 'upload_failed');
  assert.equal(classifyUploadFailure(undefined), 'upload_failed');
});

// ── what the card says ──────────────────────────────────────────────────────

test('the status line for each state', () => {
  const base = initialCardState();
  assert.equal(cardStatusText(base, T), '');
  assert.equal(cardStatusText({ ...base, status: 'preparing', file: jpg() }, T), 'Preparing photo…');
  assert.equal(cardStatusText({ ...base, status: 'preparing', file: pdf() }, T), 'Preparing file…');
  assert.equal(cardStatusText({ ...base, status: 'uploading', file: jpg(), loaded: 0.64 * 2.1 * MB, total: 2.1 * MB }, T), 'Uploading 2.1 MB – 64%');
  assert.equal(cardStatusText({ ...base, status: 'done' }, T), 'Uploaded');
  assert.equal(cardStatusText({ ...base, status: 'restored' }, T), 'Uploaded earlier');
  assert.equal(cardStatusText({ ...base, status: 'offline' }, T), "Upload paused. It will start again when you're back online.");
  assert.equal(cardStatusText({ ...base, status: 'skipped' }, T), "This card can't be sent yet. Your request will go without it — the office may ask for it.");
});

test('the error line uses the GOV.UK file-upload wording', () => {
  const err = (error) => ({ ...initialCardState(), status: 'error', error });
  assert.equal(cardStatusText(err('too_large'), T), 'The selected file must be smaller than 10 MB');
  assert.equal(cardStatusText(err('wrong_type'), T), 'The selected file must be a JPG, PNG, WEBP or PDF');
  assert.equal(cardStatusText(err('wrong_type'), T, { imagesOnly: true }), 'The selected file must be a JPG, PNG or WEBP');
  assert.equal(cardStatusText(err('upload_failed'), T), 'The selected file could not be uploaded – try again');
  assert.equal(cardStatusText(err('recaptcha'), T), 'The automated-access check failed – try again');
  assert.equal(cardStatusText(err('heic'), T), "We can't open this photo format (HEIC). Choose a JPG or PNG.");
  assert.equal(cardStatusText(err('unreadable'), T), "We can't open this file. Choose a JPG or PNG.");
});

// ── the slot: the card's pipeline, with decode and XHR as fakes ─────────────

/** A deferred promise the test resolves by hand. */
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const flush = () => new Promise((r) => setImmediate(r));

function fakeSlot(overrides = {}) {
  const calls = { prepare: [], upload: [] };
  const pending = [];
  let online = true;
  const slot = createDocSlot({
    kind: 'plate',
    imagesOnly: true,
    prepare: async (file) => {
      calls.prepare.push(file);
      return { blob: { size: 800_000 }, name: file.name, size: 800_000, type: 'image/jpeg', preview: true };
    },
    upload: (blob, opts) => {
      calls.upload.push(opts);
      const d = deferred();
      pending.push({ ...d, opts });
      return d.promise;
    },
    isOnline: () => online,
    ...overrides,
  });
  return { slot, calls, pending, setOnline: (v) => { online = v; } };
}

test('slot: choosing a photo prepares it, uploads it with progress, and keeps the key', async () => {
  const { slot, calls, pending } = fakeSlot();
  const seen = [];
  slot.subscribe((s) => seen.push(s.status));
  slot.select(jpg(), 'camera');
  await flush();
  assert.equal(calls.prepare.length, 1);
  assert.equal(calls.upload.length, 1);
  assert.equal(calls.upload[0].filename, 'plate.jpg');
  assert.equal(calls.upload[0].kind, 'plate');
  assert.equal(slot.state.status, 'uploading');
  calls.upload[0].onProgress(400_000, 800_000);
  assert.equal(slot.state.loaded, 400_000);
  pending[0].resolve({ status: 200, body: { key: KEY } });
  await flush();
  assert.equal(slot.state.status, 'done');
  assert.equal(slot.state.key, KEY);
  assert.ok(slot.blob, 'the prepared bytes stay in memory for the thumbnail');
  assert.deepEqual(seen, ['preparing', 'uploading', 'uploading', 'done']);
});

test('slot: a refused file never reaches prepare or upload', async () => {
  const { slot, calls } = fakeSlot();
  slot.select(pdf(), 'files');
  await flush();
  assert.equal(slot.state.status, 'error');
  assert.equal(slot.state.error, 'wrong_type');
  assert.equal(calls.prepare.length, 0);
  assert.equal(calls.upload.length, 0);
});

test('slot: an undecodable HEIC blocks the card and is never uploaded', async () => {
  const { slot, calls } = fakeSlot({
    prepare: async () => { throw new Error('decode failed'); },
  });
  slot.select(heic(), 'files');
  await flush();
  assert.equal(slot.state.status, 'error');
  assert.equal(slot.state.error, 'heic');
  assert.equal(slot.state.retryable, false);
  assert.equal(calls.upload.length, 0);
});

test('slot: a photo still over 10 MB after shrinking is refused', async () => {
  const { slot, calls } = fakeSlot({
    prepare: async (file) => ({ blob: {}, name: file.name, size: 11 * MB, type: 'image/jpeg', preview: true }),
  });
  slot.select(jpg(30 * MB), 'camera');
  await flush();
  assert.equal(slot.state.error, 'too_large');
  assert.equal(calls.upload.length, 0);
});

test('slot: offline before sending pauses; coming back online sends it', async () => {
  const { slot, calls, pending, setOnline } = fakeSlot();
  setOnline(false);
  slot.select(jpg(), 'camera');
  await flush();
  assert.equal(slot.state.status, 'offline');
  assert.equal(calls.upload.length, 0);
  setOnline(true);
  slot.online();
  await flush();
  assert.equal(calls.upload.length, 1);
  pending[0].resolve({ status: 200, body: { key: KEY } });
  await flush();
  assert.equal(slot.state.status, 'done');
});

test('slot: a dropped connection mid-upload pauses, then restarts with a fresh request', async () => {
  const { slot, calls, pending, setOnline } = fakeSlot();
  slot.select(jpg(), 'camera');
  await flush();
  setOnline(false);
  pending[0].reject(Object.assign(new Error('network'), { network: true }));
  await flush();
  assert.equal(slot.state.status, 'offline');
  setOnline(true);
  slot.online();
  await flush();
  assert.equal(calls.upload.length, 2, 'a new request (and so a new reCAPTCHA token) after the pause');
  pending[1].resolve({ status: 200, body: { key: KEY } });
  await flush();
  assert.equal(slot.state.status, 'done');
});

test('slot: a failed upload is retried with Try again', async () => {
  const { slot, calls, pending } = fakeSlot();
  slot.select(jpg(), 'camera');
  await flush();
  pending[0].resolve({ status: 502, body: { detail: 'upload failed' } });
  await flush();
  assert.equal(slot.state.error, 'upload_failed');
  slot.retry();
  await flush();
  assert.equal(calls.upload.length, 2);
  pending[1].resolve({ status: 200, body: { key: KEY } });
  await flush();
  assert.equal(slot.state.status, 'done');
});

test('slot: the automated-access check failing is a retryable card error', async () => {
  const { slot, pending } = fakeSlot();
  slot.select(jpg(), 'camera');
  await flush();
  pending[0].reject(Object.assign(new Error('recaptcha'), { code: 'recaptcha' }));
  await flush();
  assert.equal(slot.state.status, 'error');
  assert.equal(slot.state.error, 'recaptcha');
  assert.equal(slot.state.retryable, true);
});

test('slot: a newer photo wins over one still uploading', async () => {
  const { slot, pending } = fakeSlot();
  slot.select(jpg(3 * MB, 'first.jpg'), 'camera');
  await flush();
  slot.select(jpg(3 * MB, 'second.jpg'), 'camera');
  await flush();
  pending[0].resolve({ status: 200, body: { key: KEY.replace('b'.repeat(32), 'c'.repeat(32)) } });
  pending[1].resolve({ status: 200, body: { key: KEY } });
  await flush();
  assert.equal(slot.state.key, KEY);
  assert.equal(slot.state.file.name, 'second.jpg');
});

test('slot: settled() waits for the upload to finish (Continue says "Finishing upload…")', async () => {
  const { slot, pending } = fakeSlot();
  slot.select(jpg(), 'camera');
  await flush();
  let settledWith = null;
  slot.settled().then((s) => { settledWith = s.status; });
  await flush();
  assert.equal(settledWith, null);
  pending[0].resolve({ status: 200, body: { key: KEY } });
  await flush();
  assert.equal(settledWith, 'done');
  // already settled → resolves at once
  assert.equal((await slot.settled()).status, 'done');
});

test('slot: remove empties the card and drops the bytes', async () => {
  const { slot, pending } = fakeSlot();
  slot.select(jpg(), 'camera');
  await flush();
  pending[0].resolve({ status: 200, body: { key: KEY } });
  await flush();
  slot.remove();
  assert.equal(slot.state.status, 'empty');
  assert.equal(slot.blob, null);
});

test('slot: starts restored from a saved key, with no bytes', () => {
  const slot = createDocSlot({ kind: 'id', initial: { key: KEY, name: 'id.jpg', size: 1, type: 'image/jpeg' }, prepare: async () => ({}), upload: async () => ({}) });
  assert.equal(slot.state.status, 'restored');
  assert.equal(slot.blob, null);
});

// ── the vehicle photo (optional, images only, kind "vehicle") ───────────────

test('slot: the vehicle photo uploads as kind "vehicle", named vehicle.jpg, and refuses a PDF', async () => {
  const { slot, calls, pending } = fakeSlot({ kind: 'vehicle', imagesOnly: true });
  slot.select(pdf(), 'files');
  await flush();
  assert.equal(slot.state.error, 'wrong_type');
  assert.equal(calls.upload.length, 0);
  slot.select(jpg(4 * MB, 'IMG_5001.jpg'), 'camera');
  await flush();
  assert.equal(calls.upload[0].kind, 'vehicle');
  assert.equal(calls.upload[0].filename, 'vehicle.jpg');
  pending[0].resolve({ status: 200, body: { key: KEY.replace('/plate/', '/vehicle/') } });
  await flush();
  assert.equal(slot.state.status, 'done');
});

test('slot: a card in an error state can be removed, back to empty (an optional card is never a dead end)', async () => {
  const { slot, pending } = fakeSlot({ kind: 'vehicle', imagesOnly: true });
  slot.select(jpg(), 'camera');
  await flush();
  pending[0].resolve({ status: 502, body: { detail: 'upload failed' } });
  await flush();
  assert.equal(slot.state.status, 'error');
  slot.remove();
  assert.equal(slot.state.status, 'empty');
  assert.equal(slot.state.error, null);
  assert.equal(slot.blob, null);
});

test('slot: an older backend without the "vehicle" kind skips the card instead of failing it', async () => {
  const { slot, pending } = fakeSlot({ kind: 'vehicle', imagesOnly: true });
  slot.select(jpg(), 'camera');
  await flush();
  pending[0].resolve({ status: 400, body: { detail: 'invalid kind' } });
  await flush();
  assert.equal(slot.state.status, 'skipped');
  assert.equal(slot.state.key, null, 'nothing to send');
});

// ── summary thumbnails (S3b, S5) ───────────────────────────────────────────

const slotLike = (state, blob = null) => ({ state: { ...initialCardState(), ...state }, blob });

test('a summary thumbnail is drawn only for a document that will go with the request', () => {
  const bytes = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' });
  const done = thumbnailHtml(slotLike({ status: 'done', key: KEY, preview: true, file: jpg() }, bytes));
  assert.match(done, /^<img class="row-thumb" src="blob:[^"]+" alt="" width="56" height="42" data-object-url="1">$/);
  URL.revokeObjectURL(/src="([^"]+)"/.exec(done)[1]);
  assert.equal(thumbnailHtml(slotLike({ status: 'skipped', preview: true, file: jpg() }, bytes)), '',
    'skipped by an older backend: not part of the request, so no thumbnail');
  assert.equal(thumbnailHtml(slotLike({ status: 'restored', key: KEY, file: jpg() })), '', 'uploaded earlier: no bytes on this phone');
  assert.match(thumbnailHtml(slotLike({ status: 'restored', key: KEY, file: pdf() })), /row-glyph[^>]*>PDF</);
  for (const status of ['empty', 'preparing', 'uploading', 'offline', 'error']) {
    assert.equal(thumbnailHtml(slotLike({ status, preview: true, file: jpg() }, bytes)), '', status);
  }
  assert.equal(thumbnailHtml(undefined), '', 'a card never mounted (the vehicle photo was not added)');
});
